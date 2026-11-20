// Recording: video (screen + sound) or sound only, any length, saved on the
// device; and a MIDI file of everything played, for a DAW.

function pickMime(kinds) {
  if (typeof MediaRecorder === "undefined") return null;
  return kinds.find(k => MediaRecorder.isTypeSupported(k)) || "";
}

export class Recorder {
  constructor(engine) {
    this.e = engine;
    this.rec = null;
    this.canvas = null;
  }
  get active() { return !!this.rec; }

  /** Starts recording. kind: "vertical" (9:16, for Reels/Shorts), "landscape" or "audio". */
  start(kind) {
    const audio = this.e.stream.stream;
    let stream, mime;
    if (kind === "audio") {
      mime = pickMime(["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]);
      stream = audio;
    } else {
      const [w, h] = kind === "vertical" ? [720, 1280] : [1280, 720];
      this.canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
      this.ctx2d = this.canvas.getContext("2d");
      stream = this.canvas.captureStream(30);
      for (const t of audio.getAudioTracks()) stream.addTrack(t);
      mime = pickMime(["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]);
    }
    if (mime === null) throw new Error("這個瀏覽器不支援錄製");
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 192e3 } : undefined);
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    this.done = new Promise(resolve => {
      rec.onstop = () => {
        const type = rec.mimeType || mime || (kind === "audio" ? "audio/webm" : "video/webm");
        resolve({ blob: new Blob(chunks, { type }), type, seconds: (performance.now() - this.t0) / 1000, kind });
      };
    });
    rec.start(1000);
    this.rec = rec;
    this.kind = kind;
    this.t0 = performance.now();
  }

  /** Copies the stage into the recording frame (cover-fit), called once per drawn frame. */
  frame(stage) {
    if (!this.rec || !this.canvas) return;
    const { width: W, height: H } = this.canvas, s = Math.max(W / stage.width, H / stage.height);
    const w = stage.width * s, h = stage.height * s;
    this.ctx2d.fillStyle = "#05060c";
    this.ctx2d.fillRect(0, 0, W, H);
    this.ctx2d.drawImage(stage, (W - w) / 2, (H - h) / 2, w, h);
  }

  async stop() {
    if (!this.rec) return null;
    const rec = this.rec;
    this.rec = null;
    rec.stop();
    const out = await this.done;
    this.canvas = null;
    return out;
  }
}

/** Keeps every note that was played, so it can be saved as a MIDI file. */
export class NoteLog {
  constructor(engine) {
    this.e = engine;
    this.clear();
    engine.listeners.push(ev => this.events.length < 200000 && this.events.push(ev));
  }
  clear() { this.events = []; }
  get size() { return this.events.filter(e => e.type !== "drum" || e.vel > 0).length; }

  toMidi() {
    const tempo = this.e.tempo, PPQ = 480, evs = this.events;
    if (!evs.length) return null;
    let t0 = Infinity, tEnd = -Infinity;
    for (const e of evs) { t0 = Math.min(t0, e.time); tEnd = Math.max(tEnd, e.time + (e.dur || 0)); }
    const tick = t => Math.max(0, Math.round((t - t0) * tempo / 60 * PPQ));
    const out = [];   // [tick, order, bytes]
    const on = (t, ch, n, v) => out.push([tick(t), 1, [0x90 | ch, n & 127, Math.max(1, Math.min(127, Math.round(v * 127)))]]);
    const off = (t, ch, n) => out.push([tick(t), 0, [0x80 | ch, n & 127, 0]]);
    const held = { live: null, loop: null };
    const lead = { live: null, loop: null };
    let sound = this.e.sound;
    for (const e of evs) {
      const cc = e.ch === "loop" ? 4 : 0;
      if (e.type === "chordOn" || e.type === "strum") {
        if (e.sound) sound = e.sound;
        if (held[e.ch]) for (const n of held[e.ch].midis) off(e.time, cc, n);
        for (const n of e.midis) on(e.time, cc, n, 0.8);
        held[e.ch] = e;
      } else if (e.type === "chordOff") {
        if (held[e.ch]) for (const n of held[e.ch].midis) off(e.time, cc, n);
        held[e.ch] = null;
      } else if (e.type === "noteOn") {
        on(e.time, e.ch === "loop" ? 5 : 1, e.midi, 0.85);
        lead[e.ch] = e.midi;
      } else if (e.type === "noteOff") {
        off(e.time, e.ch === "loop" ? 5 : 1, e.midi);
        lead[e.ch] = null;
      } else if (e.type === "bass") { on(e.time, 2, e.midi, 0.8); off(e.time + e.dur, 2, e.midi); }
      else if (e.type === "arp") { on(e.time, 3, e.midi, 0.6); off(e.time + e.dur, 3, e.midi); }
      else if (e.type === "drum") { on(e.time, 9, e.note, e.vel); off(e.time + 0.1, 9, e.note); }
    }
    const end = tEnd + 0.5;
    for (const ch of ["live", "loop"]) if (held[ch]) for (const n of held[ch].midis) off(end, ch === "loop" ? 4 : 0, n);
    for (const ch of ["live", "loop"]) if (lead[ch] != null) off(end, ch === "loop" ? 5 : 1, lead[ch]);
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const prog = this.e.programFor(sound);
    const head = [
      [0, 0, [0xFF, 0x51, 0x03, ...[16, 8, 0].map(s => (Math.round(6e7 / tempo) >> s) & 255)]],
      [0, 0, [0xFF, 0x03, 9, ..."AirChords".split("").map(c => c.charCodeAt(0))]],
      [0, 0, [0xC0, prog]], [0, 0, [0xC4, prog]], [0, 0, [0xC1, 81]], [0, 0, [0xC5, 81]],
      [0, 0, [0xC2, 33]], [0, 0, [0xC3, 46]],
    ];
    const bytes = [];
    let last = 0;
    const vlq = n => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
    for (const [t, , data] of head.concat(out)) {
      for (const x of vlq(t - last)) bytes.push(x);
      for (const x of data) bytes.push(x);
      last = t;
    }
    bytes.push(0, 0xFF, 0x2F, 0);
    const len = bytes.length;
    const header = [
      0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255,
      0x4D, 0x54, 0x72, 0x6B, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255,
    ];
    const file = new Uint8Array(header.length + len);
    file.set(header, 0);
    file.set(bytes, header.length);
    return file;
  }
}
