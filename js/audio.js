// The sound engine: four chord instruments, a melody voice, drums, bass and an
// arpeggiator on a shared clock, plus reverb and delay. Pure Web Audio, no libraries.

export const SOUNDS = [
  { id: "epiano", name: "電鋼琴" },
  { id: "pad", name: "溫暖合成" },
  { id: "guitar", name: "撥弦吉他" },
  { id: "organ", name: "管風琴" },
];
export const GROOVES = [
  { id: "pop", name: "流行" },
  { id: "lofi", name: "Lo-fi" },
  { id: "bossa", name: "Bossa" },
];
const DRUMS = {   // 16 steps per bar
  pop: { kick: [0, 7, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [[0, 0], [6, 0], [8, 0], [14, 7]] },
  lofi: { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [[0, 0], [7, 7], [10, 0]], swing: 0.12 },
  bossa: { kick: [0, 6, 8, 14], rim: [0, 3, 6, 10, 13], hat: [...Array(16).keys()], bass: [[0, 0], [6, 7], [8, 0], [14, 7]] },
};
const PROGRAM = { epiano: 4, pad: 89, guitar: 25, organ: 16 };

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function impulse(ctx, seconds = 2.6) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      lp += 0.35 * ((Math.random() * 2 - 1) - lp);            // soften the highs
      d[i] = lp * Math.exp(-t * 6.9 / seconds) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

export class Engine {
  constructor() {
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new C({ latencyHint: "interactive" });
    this.listeners = [];
    this.tickHooks = [];
    this.sound = "epiano";
    this.brightness = 0.6;
    this.tempo = 96;
    this.quantize = "off";
    this.groove = { drums: false, bass: false, arp: false, style: "pop" };
    this.ch = { live: { voices: [], notes: null, root: null }, loop: { voices: [], notes: null, root: null } };
    this.leads = { live: null, loop: null };

    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    this.master.connect(comp);
    comp.connect(out);
    out.connect(ctx.destination);
    this.stream = ctx.createMediaStreamDestination();
    out.connect(this.stream);

    this.revIn = ctx.createGain();
    this.revIn.gain.value = 0.35;
    const rev = ctx.createConvolver();
    rev.buffer = impulse(ctx);
    this.revIn.connect(rev);
    rev.connect(this.master);

    this.dlyIn = ctx.createGain();
    this.dlyIn.gain.value = 0.12;
    this.dly = ctx.createDelay(2);
    const fb = ctx.createGain(); fb.gain.value = 0.33;
    const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 2800;
    this.dlyIn.connect(this.dly); this.dly.connect(dlp); dlp.connect(fb); fb.connect(this.dly); dlp.connect(this.master);

    const bus = (dry = 1, rev = 1, dly = 1) => {
      const g = ctx.createGain();
      const a = ctx.createGain(); a.gain.value = dry; g.connect(a); a.connect(this.master);
      const b = ctx.createGain(); b.gain.value = rev; g.connect(b); b.connect(this.revIn);
      const c = ctx.createGain(); c.gain.value = dly; g.connect(c); c.connect(this.dlyIn);
      return g;
    };
    this.chordBus = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass"; this.tone.Q.value = 0.6;
    this.chordBus.connect(this.tone);
    this.tone.connect(bus(1, 1, 1));
    this.leadBus = bus(0.9, 0.8, 1.3);
    this.drumBus = bus(1, 0.25, 0);
    this.bassBus = bus(1, 0.1, 0);
    this.setBrightness(this.brightness);
    this.setVolume(0.9);
    this.setTempo(this.tempo);

    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---------------------------------------------------------- transport
  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
    if (!this.timer) {
      this.step = 0;
      this.nextStep = this.ctx.currentTime + 0.1;
      this.timer = setInterval(() => this._tick(), 25);
    }
  }
  stepDur() { return 60 / this.tempo / 4; }
  barDur() { return this.stepDur() * 16; }
  /** Time of the next step that is a multiple of m steps (4 = beat, 16 = bar). */
  nextBoundary(m) { return this.nextStep + ((m - (this.step % m)) % m) * this.stepDur(); }
  nextBarTime() { return this.nextBoundary(16); }
  /** Where the transport is: beat 0–3 and fraction of the bar, for the visuals. */
  position() {
    const now = this.ctx.currentTime, sd = this.stepDur();
    const s = this.step - (this.nextStep - now) / sd;
    const bar = ((s % 16) + 16) % 16;
    return { beat: Math.floor(bar / 4), barFrac: bar / 16 };
  }
  when(quantized = true) {
    const now = this.ctx.currentTime + 0.01;
    if (!quantized || this.quantize === "off" || !this.timer) return now;
    return Math.max(now, this.nextBoundary(this.quantize === "bar" ? 16 : 4));
  }
  _tick() {
    const ahead = this.ctx.currentTime + 0.12;
    for (const h of this.tickHooks) h(this.ctx.currentTime, ahead);
    while (this.nextStep < ahead) {
      this._step(this.step % 16, this.nextStep);
      this.nextStep += this.stepDur();
      this.step++;
    }
  }
  emit(ev) { for (const l of this.listeners) l(ev); }

  // ---------------------------------------------------------- settings
  setSound(id) { this.sound = id; }
  setBrightness(v) {
    this.brightness = Math.min(1, Math.max(0, v));
    this.tone.frequency.setTargetAtTime(350 * Math.pow(2, this.brightness * 4.6), this.ctx.currentTime, 0.04);
  }
  setVolume(v) { this.chordBus.gain.setTargetAtTime(Math.min(1.2, Math.max(0, v)), this.ctx.currentTime, 0.05); }
  setTempo(bpm) {
    this.tempo = Math.min(180, Math.max(50, bpm));
    this.dly.delayTime.setTargetAtTime(60 / this.tempo * 0.75, this.ctx.currentTime, 0.05);
  }
  setReverb(v) { this.revIn.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setDelay(v) { this.dlyIn.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  // ---------------------------------------------------------- chords
  chordOn(midis, time, { ch = "live", strum = null, dir = 1, vel = 0.85, root = null } = {}) {
    const c = this.ch[ch];
    this._release(c, time);
    const spread = strum ?? (this.sound === "guitar" ? 0.022 : 0.0);
    const order = dir > 0 ? midis : [...midis].reverse();
    c.voices = order.map((m, i) => this._voice(m, time + i * spread, vel * (0.85 + 0.15 * Math.random())));
    c.notes = midis;
    c.root = root ?? midis[0];
    this.emit({ type: "chordOn", ch, midis, time, root: c.root, sound: this.sound });
  }
  chordOff(time, ch = "live") {
    const c = this.ch[ch];
    if (!c.notes) return;
    this._release(c, time);
    this.emit({ type: "chordOff", ch, midis: c.notes, time });
    c.notes = null;
    c.root = null;
  }
  strum(time, dir = 1, ch = "live") {
    const c = this.ch[ch];
    if (!c.notes) return false;
    const notes = c.notes, root = c.root;
    this._release(c, time, 0.05);
    const order = dir > 0 ? notes : [...notes].reverse();
    c.voices = order.map((m, i) => this._voice(m, time + i * 0.028, 0.95));
    this.emit({ type: "strum", ch, midis: notes, dir, time, root });
    return true;
  }
  currentRoot() { return this.ch.live.root ?? this.ch.loop.root; }
  currentNotes() { return this.ch.live.notes ?? this.ch.loop.notes; }
  _release(c, time, tau) { for (const v of c.voices) v.stop(time, tau); c.voices = []; }

  _voice(m, t, vel) {
    const ctx = this.ctx, f = mtof(m);
    const env = ctx.createGain(), rel = ctx.createGain();
    env.gain.value = 0;
    env.connect(rel);
    rel.connect(this.chordBus);
    const oscs = [];
    const osc = (type, freq, gain = 1, dest = env) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(dest);
      o.start(t); oscs.push(o); return { o, g };
    };
    let relTau = 0.25;
    const amp = vel * 0.2;
    if (this.sound === "epiano") {       // FM electric piano
      const car = osc("sine", f, 1);
      const mod = ctx.createOscillator(); mod.frequency.value = f;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 2.2 * vel, t);
      mg.gain.setTargetAtTime(f * 0.35, t, 0.35);
      mod.connect(mg); mg.connect(car.o.frequency); mod.start(t); oscs.push(mod);
      const tine = osc("sine", f * 4, 0.12);
      tine.g.gain.setValueAtTime(0.12 * vel, t); tine.g.gain.setTargetAtTime(0, t, 0.05);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp * 1.25, t + 0.004);
      env.gain.setTargetAtTime(amp * 0.45, t + 0.01, 0.9);
      relTau = 0.18;
    } else if (this.sound === "pad") {   // detuned saws through a soft filter
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200; lp.Q.value = 0.5; lp.connect(env);
      osc("sawtooth", f * 1.0047, 0.5, lp); osc("sawtooth", f / 1.0047, 0.5, lp); osc("sine", f / 2, 0.35, lp);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp * 0.75, t + 0.35);
      relTau = 0.55;
    } else if (this.sound === "guitar") {   // plucked: bright attack that darkens
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 1.2; lp.connect(env);
      lp.frequency.setValueAtTime(4200, t); lp.frequency.setTargetAtTime(900, t, 0.12);
      osc("sawtooth", f, 0.6, lp); osc("triangle", f * 1.003, 0.6, lp);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp * 1.3, t + 0.003);
      env.gain.setTargetAtTime(amp * 0.08, t + 0.01, 0.7);
      relTau = 0.12;
    } else {                               // organ: drawbars with a gentle vibrato
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.8;
      const lg = ctx.createGain(); lg.gain.value = 5; lfo.connect(lg); lfo.start(t); oscs.push(lfo);
      [[0.5, 0.35], [1, 1], [2, 0.6], [3, 0.3], [4, 0.22]].forEach(([k, g]) => lg.connect(osc("sine", f * k, g * 0.5).o.detune));
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp * 0.8, t + 0.015);
      relTau = 0.05;
    }
    return {
      stop: (time, tau = relTau) => {
        const s = Math.max(time, t);
        rel.gain.setValueAtTime(1, s);
        rel.gain.setTargetAtTime(0, s, tau);
        for (const o of oscs) o.stop(s + tau * 8 + 0.1);
      },
    };
  }

  // ---------------------------------------------------------- melody voice
  leadOn(midi, time, ch = "live") {
    let L = this.leads[ch];
    if (L && L.midi === midi) return;
    if (L) {
      this.emit({ type: "noteOff", ch, midi: L.midi, time });
      L.setPitch(mtof(midi), time, 0.035);
      L.midi = midi;
    } else {
      L = this.leads[ch] = this._lead(mtof(midi), time);
      L.midi = midi;
    }
    this.emit({ type: "noteOn", ch, midi, time });
  }
  leadFreq(freq, time, ch = "live") {   // continuous pitch (theremin)
    let L = this.leads[ch];
    if (!L) {
      L = this.leads[ch] = this._lead(freq, time);
      L.midi = Math.round(69 + 12 * Math.log2(freq / 440));
      this.emit({ type: "noteOn", ch, midi: L.midi, time });
    } else L.setPitch(freq, time, 0.02);
    if (!L.lastEmit || time - L.lastEmit > 0.03) {
      L.lastEmit = time;
      this.emit({ type: "pitch", ch, freq, time });
    }
  }
  leadOff(time, ch = "live") {
    const L = this.leads[ch];
    if (!L) return;
    L.stop(time);
    this.emit({ type: "noteOff", ch, midi: L.midi, time });
    this.leads[ch] = null;
  }
  _lead(freq, t) {
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(); o1.type = "triangle";
    const o2 = ctx.createOscillator(); o2.type = "sawtooth";
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600; lp.Q.value = 0.8;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    const env = ctx.createGain(); env.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.4;
    const lg = ctx.createGain(); lg.gain.value = 0; lg.gain.setTargetAtTime(9, t + 0.3, 0.3);
    lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
    o1.frequency.value = freq; o2.frequency.value = freq;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(env); env.connect(this.leadBus);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.2, t + 0.02);
    for (const o of [o1, o2, lfo]) o.start(t);
    return {
      setPitch(f, time, glide) { for (const o of [o1, o2]) o.frequency.setTargetAtTime(f, time, glide); },
      stop(time) {
        env.gain.setValueAtTime(0.2, time); env.gain.setTargetAtTime(0, time, 0.08);
        for (const o of [o1, o2, lfo]) o.stop(time + 0.8);
      },
    };
  }

  // ---------------------------------------------------------- groove
  _step(s, t) {
    const g = this.groove, P = DRUMS[g.style];
    const sw = P.swing && s % 2 === 1 ? P.swing * this.stepDur() * 2 : 0;
    const time = t + sw;
    if (g.drums) {
      if (P.kick.includes(s)) this._kick(time, s === 0 ? 1 : 0.8);
      if (P.snare && P.snare.includes(s)) this._snare(time, 0.8);
      if (P.rim && P.rim.includes(s)) this._rim(time);
      if (P.hat.includes(s)) this._hat(time, s % 4 === 0 ? 0.9 : 0.55);
    }
    const root = this.currentRoot();
    if (g.bass && root != null) {
      for (const [st, iv] of P.bass) if (st === s) {
        const m = 36 + ((root + iv - 36) % 12 + 12) % 12;
        this._bass(m, time, this.stepDur() * 1.8);
      }
    }
    const notes = this.currentNotes();
    if (g.arp && notes && s % 2 === 0) {
      const seq = [...notes, ...notes.map(n => n + 12)];
      const k = (s / 2) % seq.length;
      this._arp(seq[k], time, this.stepDur() * 1.6);
    }
  }
  _kick(t, v) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.75 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(this.drumBus); o.start(t); o.stop(t + 0.45);
    this.emit({ type: "drum", note: 36, time: t, vel: v });
  }
  _noise(t, dur, type, freq, gain, decay) {
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f); f.connect(g); g.connect(this.drumBus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur);
  }
  _snare(t, v) {
    this._noise(t, 0.25, "highpass", 1300, 0.35 * v, 0.18);
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "triangle"; o.frequency.value = 190;
    g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g); g.connect(this.drumBus); o.start(t); o.stop(t + 0.1);
    this.emit({ type: "drum", note: 38, time: t, vel: v });
  }
  _hat(t, v) {
    this._noise(t, 0.06, "highpass", 7500, 0.12 * v, 0.045);
    this.emit({ type: "drum", note: 42, time: t, vel: v });
  }
  _rim(t) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "square"; o.frequency.value = 820; f.type = "bandpass"; f.frequency.value = 1600;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    o.connect(f); f.connect(g); g.connect(this.drumBus); o.start(t); o.stop(t + 0.05);
    this.emit({ type: "drum", note: 37, time: t, vel: 0.7 });
  }
  _bass(m, t, dur) {
    const ctx = this.ctx, o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = "sine"; o2.type = "sawtooth"; o.frequency.value = mtof(m); o2.frequency.value = mtof(m);
    lp.type = "lowpass"; lp.frequency.value = 520;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(this.bassBus);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.42, t + 0.01);
    g.gain.setTargetAtTime(0.25, t + 0.02, 0.2); g.gain.setTargetAtTime(0, t + dur, 0.05);
    o.start(t); o2.start(t); o.stop(t + dur + 0.4); o2.stop(t + dur + 0.4);
    this.emit({ type: "bass", midi: m, time: t, dur });
  }
  _arp(m, t, dur) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = "triangle"; o.frequency.value = mtof(m + 12);
    lp.type = "lowpass"; lp.frequency.value = 3200;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.004); g.gain.setTargetAtTime(0, t + 0.01, dur * 0.35);
    o.connect(lp); lp.connect(g); g.connect(this.chordBus); o.start(t); o.stop(t + dur * 3);
    this.emit({ type: "arp", midi: m + 12, time: t, dur });
  }
  programFor(sound) { return PROGRAM[sound] ?? 0; }
}
