// Run with: node tests/test.js
// Checks the music theory and the gesture reading with synthetic hands.
import assert from "node:assert/strict";
import { diatonicChord, voicing, slotDegrees, melodyNotes, NOTE_NAMES } from "../js/theory.js";
import { analyzeHand, slotOf, SlotFilter, StrumDetector, assignHands } from "../js/hands.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

// ------------------------------------------------------------------ theory
test("C major chords", () => {
  const names = [0, 1, 2, 3, 4, 5, 6].map(d => diatonicChord(0, "major", d).name);
  assert.deepEqual(names, ["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
  assert.deepEqual([0, 1, 6].map(d => diatonicChord(0, "major", d).roman), ["I", "ii", "vii°"]);
});
test("A minor and sevenths", () => {
  assert.equal(diatonicChord(9, "minor", 0).name, "Am");
  assert.equal(diatonicChord(9, "minor", 2).name, "C");
  assert.equal(diatonicChord(0, "major", 4, { seventh: true }).name, "G7");
  assert.equal(diatonicChord(0, "major", 0, { seventh: true }).name, "Cmaj7");
  assert.equal(diatonicChord(0, "major", 1, { seventh: true }).name, "Dm7");
  assert.equal(diatonicChord(0, "major", 6, { seventh: true }).name, "Bm7b5");
});
test("borrowed chords (major/minor swap)", () => {
  assert.equal(diatonicChord(0, "major", 3, { flip: true }).name, "Fm");
  assert.equal(diatonicChord(0, "major", 5, { flip: true }).name, "A");
  assert.deepEqual(diatonicChord(0, "major", 3, { flip: true }).tones, [0, 3, 7]);
});
test("every key spells 7 chords", () => {
  for (let k = 0; k < 12; k++) for (const m of ["major", "minor"])
    for (let d = 0; d < 7; d++) {
      const c = diatonicChord(k, m, d);
      assert.ok(NOTE_NAMES.includes(c.name.replace(/(m|dim|\+)$/, "")), c.name);
    }
});
test("voicings stay in range and move little", () => {
  for (let d = 0; d < 7; d++) for (let r = 0; r < 3; r++) {
    const v = voicing(diatonicChord(7, "major", d, { seventh: true }), r);
    assert.equal(v.length, 4);
    assert.ok(v[v.length - 1] - v[0] <= 12, v.join());
    assert.ok(v[0] >= 45 && v[v.length - 1] <= 80, v.join());
  }
});
test("song presets fill all seven slots", () => {
  assert.deepEqual(slotDegrees("pop"), [0, 4, 5, 3, 1, 2, 6]);
  assert.deepEqual(slotDegrees("royal").slice(0, 4), [3, 4, 2, 5]);
  for (const id of ["diatonic", "pop", "royal", "canon", "fifties", "jazz"])
    assert.deepEqual([...slotDegrees(id)].sort(), [0, 1, 2, 3, 4, 5, 6]);
});
test("melody ladder is in key", () => {
  const n = melodyNotes(2, "major", "penta", 60, 11);
  assert.equal(n.length, 11);
  const pcs = new Set([2, 4, 6, 9, 11]);
  assert.ok(n.every(m => pcs.has(m % 12)));
  assert.ok(n.every((m, i) => i === 0 || m > n[i - 1]));
});

// ------------------------------------------------------------------ synthetic hands
// A right-ish hand drawn in "palm units" (wrist to middle knuckle = 1), y pointing down.
const MCP = { 1: [-0.34, -0.95], 2: [0, -1], 3: [0.3, -0.95], 4: [0.56, -0.84] };
const LEN = { 1: 0.85, 2: 0.95, 3: 0.88, 4: 0.7 };
function makeHand({ ext = [1, 1, 1, 1, 1], cx = 0.3, cy = 0.6, size = 0.16, roll = 0, aspect = 16 / 9 } = {}) {
  const P = new Array(21);
  P[0] = [0, 0];
  // thumb: out to the side when open, folded across the palm when closed
  const thumb = ext[0]
    ? [[-0.25, -0.2], [-0.55, -0.4], [-0.8, -0.6], [-1.0, -0.78]]
    : [[-0.25, -0.2], [-0.4, -0.45], [-0.25, -0.62], [-0.05, -0.68]];
  thumb.forEach((p, i) => (P[1 + i] = p));
  for (let f = 1; f <= 4; f++) {
    const [mx, my] = MCP[f], L = LEN[f], i0 = 1 + 4 * f;
    P[i0] = [mx, my];
    if (ext[f]) {
      P[i0 + 1] = [mx * 1.05, my - L * 0.45];
      P[i0 + 2] = [mx * 1.08, my - L * 0.75];
      P[i0 + 3] = [mx * 1.1, my - L];
    } else {   // curled into the palm
      P[i0 + 1] = [mx, my - 0.35];
      P[i0 + 2] = [mx * 0.95, my - 0.1];
      P[i0 + 3] = [mx * 0.9, my + 0.2];
    }
  }
  const a = roll * Math.PI / 180;
  return P.map(([x, y]) => {
    const rx = x * Math.cos(a) - y * Math.sin(a), ry = x * Math.sin(a) + y * Math.cos(a);
    const sx = cx + rx * size / aspect, sy = cy + ry * size;
    return { x: 1 - sx, y: sy, z: 0 };   // MediaPipe's coordinates are not mirrored
  });
}

const SHAPES = [
  [[0, 0, 0, 0, 0], 0], [[0, 1, 0, 0, 0], 1], [[0, 1, 1, 0, 0], 2], [[0, 1, 1, 1, 0], 3],
  [[1, 1, 1, 0, 0], 3], [[0, 1, 1, 1, 1], 4], [[1, 1, 1, 1, 1], 5], [[1, 0, 0, 0, 1], 6], [[1, 1, 0, 0, 0], 7],
];
test("reads every hand shape, upright and tilted, near and far", () => {
  for (const [ext, slot] of SHAPES)
    for (const roll of [-20, 0, 20])
      for (const size of [0.1, 0.18, 0.3]) {
        const a = analyzeHand(makeHand({ ext, roll, size }));
        assert.equal(slotOf(a), slot, `ext=${ext} roll=${roll} size=${size} -> ${a.ext}`);
      }
});
test("tilt angle and position in screen space", () => {
  const a = analyzeHand(makeHand({ roll: 30, cx: 0.25, cy: 0.5 }));
  assert.ok(Math.abs(a.roll - 30) < 3, a.roll);
  assert.ok(a.x < 0.4 && a.y < 0.5, `${a.x} ${a.y}`);
});
test("pinch distance", () => {
  const open = analyzeHand(makeHand({ ext: [1, 1, 1, 1, 1] }));
  assert.ok(open.pinch > 0.7, open.pinch);
});
test("slot filter ignores one-frame flickers", () => {
  const f = new SlotFilter(3);
  const seq = [2, 2, 2, 3, 2, 2, 3, 3, 3].map(s => f.update(s));
  assert.deepEqual(seq, [-1, -1, 2, 2, 2, 2, 2, 2, 3]);
});
test("a quick flick down is a strum, slow drift is not", () => {
  const s = new StrumDetector();
  let got = 0;
  for (let i = 0; i < 20; i++) got ||= s.update(0.3 + i * 0.002, i / 30);
  assert.equal(got, 0);
  const s2 = new StrumDetector();
  let dir = 0;
  for (let i = 0; i < 6; i++) dir ||= s2.update(0.3 + i * 0.05, 1 + i / 30);
  assert.equal(dir, 1);
});
test("hands are split by screen side", () => {
  const L = analyzeHand(makeHand({ cx: 0.25 })), R = analyzeHand(makeHand({ cx: 0.75 }));
  assert.equal(assignHands([R, L]).chord, L);
  assert.equal(assignHands([R, L]).other, R);
  assert.equal(assignHands([R, L], false).chord, R);
  assert.equal(assignHands([R]).chord, null);
  assert.equal(assignHands([L]).chord, L);
});

console.log(`\n${passed} tests passed`);
