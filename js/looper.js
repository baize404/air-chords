// A loop pedal: records what you play for N bars, then plays it back on its
// own channel while you keep playing on top. Press again to layer (overdub).

const KINDS = new Set(["chordOn", "chordOff", "strum", "noteOn", "noteOff", "pitch"]);

export class Looper {
  constructor(engine) {
    this.e = engine;
    this.state = "idle";          // idle | waiting | recording | playing | overdub
    this.events = [];
    engine.listeners.push(ev => this._capture(ev));
    engine.tickHooks.push((from, to) => this._schedule(from, to));
  }

  /** One button: start a loop, then toggle layering, as on a loop pedal. */
  press(bars = 4) {
    const e = this.e;
    if (this.state === "idle") {
      this.start = e.nextBarTime();
      this.len = bars * e.barDur();
      this.events = [];
      this.cursor = this.start;
      this.state = "waiting";
      this._carry = true;
    } else if (this.state === "playing") this.state = "overdub";
    else if (this.state === "overdub") this.state = "playing";
    else if (this.state === "waiting" || this.state === "recording") this.clear();
    return this.state;
  }

  clear() {
    const now = this.e.ctx.currentTime;
    this.state = "idle";
    this.events = [];
    this.e.chordOff(now, "loop");
    this.e.leadOff(now, "loop");
  }

  /** 0..1 position in the loop, or null. */
  progress() {
    if (this.state === "idle") return null;
    const now = this.e.ctx.currentTime;
    if (now < this.start) return 0;
    return ((now - this.start) % this.len) / this.len;
  }

  _capture(ev) {
    if (ev.ch !== "live" || !KINDS.has(ev.type)) return;
    if (this.state !== "recording" && this.state !== "overdub" && this.state !== "waiting") return;
    if (ev.time < this.start - 0.02) return;
    const rel = Math.max(0, ev.time - this.start) % this.len;
    this.events.push({ ...ev, rel });
    this.events.sort((a, b) => a.rel - b.rel);
  }

  _schedule(from, to) {
    if (this.state === "idle") return;
    const e = this.e;
    if (this.state === "waiting" && from >= this.start) {
      this.state = "recording";
      if (this._carry) {   // a chord already held when recording began belongs to the loop
        this._carry = false;
        const c = e.ch.live;
        if (c.notes && !this.events.some(v => v.rel < 0.05 && v.type === "chordOn"))
          this.events.unshift({ type: "chordOn", ch: "live", midis: c.notes, root: c.root, rel: 0 });
      }
    }
    if (this.state === "recording" && from >= this.start + this.len) this.state = "playing";
    if (this.state !== "playing" && this.state !== "overdub") return;
    const begin = Math.max(this.cursor, this.start + this.len, from);
    if (to <= begin) return;
    let k = Math.floor((begin - this.start) / this.len);
    for (; this.start + k * this.len < to; k++) {
      const base = this.start + k * this.len;
      for (const ev of this.events) {
        const t = base + ev.rel;
        if (t < begin || t >= to) continue;
        this._play(ev, t);
      }
    }
    this.cursor = to;
  }

  _play(ev, t) {
    const e = this.e;
    if (ev.type === "chordOn") e.chordOn(ev.midis, t, { ch: "loop", root: ev.root });
    else if (ev.type === "chordOff") e.chordOff(t, "loop");
    else if (ev.type === "strum") {
      if (!e.strum(t, ev.dir, "loop")) e.chordOn(ev.midis, t, { ch: "loop", root: ev.root, dir: ev.dir, strum: 0.028 });
    } else if (ev.type === "noteOn") e.leadOn(ev.midi, t, "loop");
    else if (ev.type === "noteOff") e.leadOff(t, "loop");
    else if (ev.type === "pitch") e.leadFreq(ev.freq, t, "loop");
  }
}
