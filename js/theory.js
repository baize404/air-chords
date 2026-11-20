// Music theory: keys, diatonic chords, voicings, scales and song presets.

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

// Which degree each gesture "slot" plays. Slots 1–5 are finger counts,
// slot 6 is the shaka (thumb + pinky) and slot 7 the "L" (thumb + index).
export const PROGRESSIONS = [
  { id: "diatonic", name: "音階和弦（自由彈）", degrees: [0, 1, 2, 3, 4, 5, 6] },
  { id: "pop", name: "流行四和弦 I–V–vi–IV", degrees: [0, 4, 5, 3] },
  { id: "royal", name: "王道進行 IV–V–iii–vi", degrees: [3, 4, 2, 5] },
  { id: "canon", name: "卡農 I–V–vi–iii–IV", degrees: [0, 4, 5, 2, 3] },
  { id: "fifties", name: "50 年代 I–vi–IV–V", degrees: [0, 5, 3, 4] },
  { id: "jazz", name: "爵士 ii–V–I", degrees: [1, 4, 0] },
];

/** The 7 degrees the 7 slots play: the preset's chords first, then the rest of the scale. */
export function slotDegrees(progressionId) {
  const p = PROGRESSIONS.find(q => q.id === progressionId) || PROGRESSIONS[0];
  const rest = [0, 1, 2, 3, 4, 5, 6].filter(d => !p.degrees.includes(d));
  return [...p.degrees, ...rest].slice(0, 7);
}

export function scaleOf(tonic, mode) {
  return (mode === "minor" ? MINOR : MAJOR).map(i => (tonic + i) % 12);
}

function qualityOf(third, fifth) {
  if (third === 4 && fifth === 7) return "maj";
  if (third === 3 && fifth === 7) return "min";
  if (third === 3 && fifth === 6) return "dim";
  if (third === 4 && fifth === 8) return "aug";
  return "maj";
}

/**
 * A chord on a scale degree (0–6).
 * opts.seventh adds the diatonic 7th; opts.flip swaps major and minor (borrowed chord).
 */
export function diatonicChord(tonic, mode, degree, opts = {}) {
  const s = scaleOf(tonic, mode);
  const pc = k => s[(degree + k) % 7];
  const root = pc(0);
  const iv = k => (pc(k) - root + 12) % 12;
  let third = iv(2), fifth = iv(4);
  let quality = qualityOf(third, fifth);
  if (opts.flip && (quality === "maj" || quality === "min")) {
    quality = quality === "maj" ? "min" : "maj";
    third = quality === "maj" ? 4 : 3;
  }
  const tones = [0, third, fifth];
  let suffix = { maj: "", min: "m", dim: "dim", aug: "+" }[quality];
  if (opts.seventh) {
    let seventh = iv(6);
    if (opts.flip) seventh = quality === "maj" ? 11 : 10;
    tones.push(seventh);
    if (quality === "maj") suffix = seventh === 11 ? "maj7" : "7";
    else if (quality === "min") suffix = seventh === 11 ? "m(maj7)" : "m7";
    else if (quality === "dim") suffix = seventh === 9 ? "dim7" : "m7b5";
    else suffix = "+7";
  }
  let roman = ROMAN[degree];
  if (quality === "min" || quality === "dim") roman = roman.toLowerCase();
  if (quality === "dim") roman += "°";
  if (quality === "aug") roman += "+";
  if (opts.seventh) roman += "7";
  return { root, quality, tones, degree, name: NOTE_NAMES[root] + suffix, roman };
}

/** Close-position voicing centred on a register, so changes move as little as possible. */
export function voicing(chord, register = 1) {
  const centre = 57 + register * 7;            // A3, E4, B4
  return chord.tones
    .map(t => {
      const pc = (chord.root + t) % 12;
      let m = centre - 6 + ((pc - (centre - 6)) % 12 + 12) % 12;
      return m;
    })
    .sort((a, b) => a - b);
}

export function bassNote(chord) {
  return 36 + ((chord.root - 36) % 12 + 12) % 12;   // C2–B2
}

/** Notes for the melody hand: pentatonic ("no wrong notes") or the full scale. */
export function melodyNotes(tonic, mode, kind = "penta", low = 60, count = 11) {
  const steps = kind === "penta" ? (mode === "minor" ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9])
    : (mode === "minor" ? MINOR : MAJOR);
  const out = [];
  let base = low + ((tonic - low) % 12 + 12) % 12;
  if (base > low + 5) base -= 12;
  for (let oct = 0; out.length < count; oct++)
    for (const s of steps) {
      const m = base + oct * 12 + s;
      if (m >= low - 2 && out.length < count) out.push(m);
    }
  return out;
}

export function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

/** Hue for a pitch class, walking the circle of fifths so related chords look related. */
export function hueOf(pc) {
  return ((pc * 7) % 12) * 30;
}
