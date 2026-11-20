// Drawing the stage: mirrored camera, hand skeletons, chord name, a ring of the
// 12 notes (circle of fifths) lighting up the chord, the melody ladder, beat
// dots and particles. Colours follow the chord, so related chords look related.

import { hueOf, NOTE_NAMES, noteName } from "./theory.js";

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const TIPS = [4, 8, 12, 16, 20];
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

export class Visuals {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.parts = [];
    this.hue = 210;
    this.flash = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.c.width = Math.round(innerWidth * dpr);
    this.c.height = Math.round(innerHeight * dpr);
    this.c.style.width = innerWidth + "px";
    this.c.style.height = innerHeight + "px";
  }

  burst(x, y, hue, n = 22, speed = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.15 + Math.random() * 0.5) * speed;
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1, life: 1, hue: hue + (Math.random() * 30 - 15) });
    }
    if (this.parts.length > 600) this.parts.splice(0, this.parts.length - 600);
  }

  draw(s, dt) {
    const g = this.g, W = this.c.width, H = this.c.height, d = this.dpr;
    const target = s.chord ? hueOf(s.chord.root) : this.hue;
    this.hue += ((((target - this.hue) % 360) + 540) % 360 - 180) * Math.min(1, dt * 4);
    const hue = this.hue;
    this.flash = Math.max(0, this.flash - dt * 2.5);

    // background and the mirrored camera
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, `hsl(${hue} 45% 7%)`);
    bg.addColorStop(1, `hsl(${hue + 40} 50% 3%)`);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const v = s.video;
    if (v && s.showCam && v.videoWidth) {
      const k = Math.max(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * k, h = v.videoHeight * k;
      g.save();
      g.globalAlpha = 0.42;
      g.translate(W, 0); g.scale(-1, 1);
      g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
      g.restore();
      g.fillStyle = `hsla(${hue} 60% 8% / 0.35)`;
      g.fillRect(0, 0, W, H);
      this.view = { k, w, h, ox: (W - w) / 2, oy: (H - h) / 2 };
    } else this.view = { k: 1, w: W, h: H, ox: 0, oy: 0 };
    if (this.flash > 0) {
      g.fillStyle = `hsla(${hue} 90% 60% / ${this.flash * 0.12})`;
      g.fillRect(0, 0, W, H);
    }

    // the side that plays chords
    if (s.camera) {
      const half = s.chordOnLeft ? 0 : W / 2;
      g.fillStyle = `hsla(${hue} 80% 60% / 0.05)`;
      g.fillRect(half, 0, W / 2, H);
      g.strokeStyle = "hsla(0 0% 100% / 0.08)";
      g.setLineDash([6 * d, 10 * d]);
      g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
      g.setLineDash([]);
    }

    // melody ladder
    if (s.ladder) this._ladder(s, hue);

    // hands
    for (const h of s.hands) this._hand(h, hue);

    // the harmony ring and the chord name
    const big = !s.camera;
    const R = big ? Math.min(W, H) * 0.2 : Math.min(W, H) * 0.075;
    const cx = big ? W / 2 : (s.chordOnLeft ? R + 30 * d : W - R - 30 * d), cy = big ? H * 0.46 : (s.topH + 22) * d + R;
    this._ring(cx, cy, R, s.chord, hue);
    g.textAlign = "center";
    if (s.chord) {
      const fs = big ? R * 0.62 : Math.min(W, H) * 0.075;
      const nx = big ? cx : W / 2, ny = big ? cy + fs * 0.32 : (s.topH + 16) * d + fs;
      g.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      g.fillStyle = `hsl(${hue} 90% 72%)`;
      g.shadowColor = `hsl(${hue} 90% 55%)`; g.shadowBlur = 24 * d;
      g.fillText(s.chord.name, nx, ny);
      g.shadowBlur = 0;
      g.font = `600 ${fs * 0.32}px system-ui, sans-serif`;
      g.fillStyle = "hsla(0 0% 100% / 0.7)";
      g.fillText(s.chord.roman + (s.slotLabel ? "  ·  " + s.slotLabel : ""), nx, ny + fs * 0.45);
    } else if (s.hint) {
      g.font = `500 ${16 * d}px system-ui, sans-serif`;
      g.fillStyle = "hsla(0 0% 100% / 0.55)";
      g.fillText(s.hint, W / 2, (s.topH + 60) * d);
    }

    // beat dots and the loop ring
    const bx = W / 2 - 3 * 14 * d / 2 - 7 * d, by = H - (s.bottomH + 22) * d;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(bx + i * 14 * d + 7 * d, by, (i === s.beat ? 5 : 3.5) * d, 0, Math.PI * 2);
      g.fillStyle = s.grooveOn ? (i === s.beat ? `hsl(${hue} 90% 65%)` : "hsla(0 0% 100% / 0.25)") : "hsla(0 0% 100% / 0.1)";
      g.fill();
    }
    if (s.loop != null) {
      g.beginPath();
      g.arc(bx - 26 * d, by, 9 * d, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.loop);
      g.strokeStyle = s.loopState === "overdub" ? "#ff5d73" : s.loopState === "playing" ? "#55e6a5" : "#ffd166";
      g.lineWidth = 3 * d; g.stroke();
    }

    // particles
    g.globalCompositeOperation = "lighter";
    for (const p of this.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.25 * dt; p.life -= dt * 0.9;
      if (p.life <= 0) continue;
      g.fillStyle = `hsla(${p.hue} 90% 65% / ${p.life})`;
      g.beginPath(); g.arc(p.x * W, p.y * H, (1.5 + 3 * p.life) * d, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over";
    this.parts = this.parts.filter(p => p.life > 0);

    if (s.recording) {
      g.fillStyle = "#ff3b5c";
      g.beginPath(); g.arc(24 * d, (s.topH + 22) * d, 7 * d, 0, Math.PI * 2); g.fill();
      g.font = `600 ${13 * d}px system-ui, sans-serif`; g.textAlign = "left";
      g.fillText("REC " + s.recTime, 38 * d, (s.topH + 27) * d);
    }
  }

  /** Screen position of a hand point given in 0..1 mirrored video space. */
  toScreen(p) {
    const v = this.view;
    return { x: v.ox + p.x * v.w, y: v.oy + p.y * v.h };
  }
  /** The same, as 0..1 of the canvas. */
  toUnit(p) {
    const q = this.toScreen(p);
    return { x: q.x / this.c.width, y: q.y / this.c.height };
  }

  _hand(h, hue) {
    const g = this.g, d = this.dpr;
    const pts = h.points.map(p => this.toScreen(p));
    const col = h.role === "chord" ? `hsl(${hue} 90% 70%)` : "hsl(190 90% 70%)";
    g.lineWidth = 3 * d; g.strokeStyle = "hsla(0 0% 100% / 0.35)";
    g.beginPath();
    for (const [a, b] of BONES) { g.moveTo(pts[a].x, pts[a].y); g.lineTo(pts[b].x, pts[b].y); }
    g.stroke();
    TIPS.forEach((t, i) => {
      const on = h.ext[i];
      g.beginPath(); g.arc(pts[t].x, pts[t].y, (on ? 9 : 5) * d, 0, Math.PI * 2);
      g.fillStyle = on ? col : "hsla(0 0% 100% / 0.4)";
      if (on) { g.shadowColor = col; g.shadowBlur = 18 * d; }
      g.fill(); g.shadowBlur = 0;
    });
    if (h.label) {
      const w = pts[0];
      g.font = `700 ${15 * d}px system-ui, sans-serif`; g.textAlign = "center";
      g.fillStyle = col;
      g.fillText(h.label, w.x, w.y + 30 * d);
    }
    if (h.pinched) {
      const m = { x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
      g.beginPath(); g.arc(m.x, m.y, 14 * d, 0, Math.PI * 2);
      g.strokeStyle = "hsl(190 90% 70%)"; g.lineWidth = 3 * d; g.stroke();
    }
  }

  _ring(cx, cy, R, chord, hue) {
    const g = this.g, d = this.dpr;
    const tones = chord ? chord.tones.map(t => (chord.root + t) % 12) : [];
    g.lineWidth = 1.5 * d;
    g.strokeStyle = "hsla(0 0% 100% / 0.12)";
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    if (tones.length) {   // the chord's shape, joined in circle-of-fifths order
      g.beginPath();
      const ordered = FIFTHS.filter(pc => tones.includes(pc));
      ordered.forEach((pc, i) => {
        const a = FIFTHS.indexOf(pc) / 12 * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.closePath();
      g.fillStyle = `hsla(${hue} 90% 60% / 0.18)`; g.fill();
      g.strokeStyle = `hsla(${hue} 90% 65% / 0.7)`; g.stroke();
    }
    FIFTHS.forEach((pc, i) => {
      const a = i / 12 * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      const on = tones.includes(pc), root = chord && pc === chord.root;
      g.beginPath(); g.arc(x, y, (root ? 0.14 : on ? 0.1 : 0.05) * R + 2 * d, 0, Math.PI * 2);
      g.fillStyle = on ? `hsl(${hueOf(pc)} 85% ${root ? 70 : 60}%)` : "hsla(0 0% 100% / 0.2)";
      g.fill();
      if (R > 60 * d) {
        g.font = `600 ${R * 0.09}px system-ui, sans-serif`; g.textAlign = "center";
        g.fillStyle = on ? "#fff" : "hsla(0 0% 100% / 0.4)";
        g.fillText(NOTE_NAMES[pc], cx + Math.cos(a) * R * 1.2, cy + Math.sin(a) * R * 1.2 + R * 0.03);
      }
    });
  }

  _ladder(s, hue) {
    const g = this.g, d = this.dpr, W = this.c.width, H = this.c.height, L = s.ladder;
    const x0 = s.chordOnLeft ? W * 0.55 : 0, x1 = s.chordOnLeft ? W : W * 0.45;
    const top = (s.topH + 70) * d, bottom = H - (s.bottomH + 50) * d;
    L.notes.forEach((m, i) => {
      const y = bottom - (bottom - top) * (i / (L.notes.length - 1));
      const on = i === L.index && L.sounding;
      g.strokeStyle = on ? "hsl(190 90% 70%)" : (m % 12 === s.keyPc ? "hsla(0 0% 100% / 0.35)" : "hsla(0 0% 100% / 0.12)");
      g.lineWidth = (on ? 3 : 1) * d;
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      g.font = `600 ${12 * d}px system-ui, sans-serif`; g.textAlign = s.chordOnLeft ? "right" : "left";
      g.fillStyle = on ? "#fff" : "hsla(0 0% 100% / 0.45)";
      g.fillText(noteName(m), s.chordOnLeft ? x1 - 10 * d : x0 + 10 * d, y - 4 * d);
    });
    if (L.freqY != null) {
      g.strokeStyle = "hsla(190 90% 70% / 0.8)"; g.lineWidth = 2 * d;
      g.beginPath(); g.moveTo(x0, L.freqY * H); g.lineTo(x1, L.freqY * H); g.stroke();
    }
  }
}

export { noteName };
