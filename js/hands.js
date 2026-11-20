// Hand tracking (MediaPipe, all on-device) and turning landmarks into gestures.

const TIP = [4, 8, 12, 16, 20], PIP = [3, 6, 10, 14, 18], MCP = [2, 5, 9, 13, 17];

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/**
 * Read one hand. Landmarks are MediaPipe's normalised image coordinates;
 * `aspect` (width / height) makes distances square. x is mirrored so the
 * result is in screen space (what the player sees, like a mirror).
 */
export function analyzeHand(lm, aspect = 16 / 9) {
  const P = lm.map(p => ({ x: (1 - p.x) * aspect, y: p.y }));
  const palm = Math.max(1e-6, dist(P[0], P[9]));
  const ext = [false, false, false, false, false];
  for (let f = 1; f < 5; f++) {
    // a straight finger's tip is clearly further from the wrist than its middle joint
    ext[f] = dist(P[0], P[TIP[f]]) > dist(P[0], P[PIP[f]]) * 1.12 && dist(P[TIP[f]], P[MCP[f]]) > 0.45 * palm;
  }
  // thumb: tip away from the palm, measured from the little finger's base and the index base
  ext[0] = dist(P[4], P[17]) > dist(P[3], P[17]) * 1.05 && dist(P[4], P[5]) > 0.55 * palm
    && dist(P[4], P[9]) > 0.75 * palm;
  const count = ext.filter(Boolean).length;
  let shape = "count";
  if (count === 2 && ext[0] && ext[4]) shape = "shaka";
  else if (count === 2 && ext[0] && ext[1]) shape = "L";
  else if (count === 0) shape = "fist";
  const c = [0, 5, 9, 13, 17].reduce((s, i) => ({ x: s.x + P[i].x / 5, y: s.y + P[i].y / 5 }), { x: 0, y: 0 });
  const up = { x: P[9].x - P[0].x, y: P[9].y - P[0].y };
  const roll = Math.atan2(up.x, -up.y) * 180 / Math.PI;        // 0 = upright, + = leaning right on screen
  return {
    ext, count, shape, palm,
    x: c.x / aspect, y: c.y,                                      // palm centre, 0..1 screen space
    tipX: P[8].x / aspect, tipY: P[8].y,                          // index fingertip
    roll,
    pinch: dist(P[4], P[8]) / palm,                               // ~0.2 touching, >1 open
    points: P.map(p => ({ x: p.x / aspect, y: p.y })),
  };
}

/** Which slot (1–7) a hand shape asks for, or 0 for a fist (stop). */
export function slotOf(a) {
  if (a.shape === "fist") return 0;
  if (a.shape === "shaka") return 6;
  if (a.shape === "L") return 7;
  return a.count;   // 1–5
}

/**
 * Smooths the chord hand: a new slot only counts once it has been held for a
 * few frames, so a finger passing through a half-bent position does not flicker.
 */
export class SlotFilter {
  constructor(frames = 3) { this.need = frames; this.cand = -1; this.n = 0; this.value = -1; }
  update(slot) {
    if (slot === this.value) { this.cand = slot; this.n = 0; return this.value; }
    if (slot === this.cand) this.n++;
    else { this.cand = slot; this.n = 1; }
    if (this.n >= this.need) { this.value = slot; this.n = 0; }
    return this.value;
  }
  reset() { this.cand = -1; this.n = 0; this.value = -1; }
}

/** Detects a quick downward (or upward) flick of a hand: a strum. */
export class StrumDetector {
  constructor() { this.hist = []; this.last = -1; }
  update(y, t) {
    this.hist.push({ y, t });
    while (this.hist.length && t - this.hist[0].t > 0.16) this.hist.shift();
    if (this.hist.length < 3 || t - this.last < 0.28) return 0;
    const dy = y - this.hist[0].y, dt = t - this.hist[0].t;
    if (dt <= 0) return 0;
    if (Math.abs(dy) > 0.10 && Math.abs(dy / dt) > 1.1) {
      this.last = t;
      this.hist = [];
      return dy > 0 ? 1 : -1;   // 1 = down, -1 = up
    }
    return 0;
  }
}

/** Splits the detected hands into the chord hand and the other hand by screen side. */
export function assignHands(hands, chordOnLeft = true) {
  if (!hands.length) return { chord: null, other: null };
  const sorted = [...hands].sort((a, b) => a.x - b.x);
  if (sorted.length >= 2) {
    return chordOnLeft ? { chord: sorted[0], other: sorted[sorted.length - 1] }
      : { chord: sorted[sorted.length - 1], other: sorted[0] };
  }
  const h = sorted[0];
  const onLeft = h.x < 0.5;
  return onLeft === chordOnLeft ? { chord: h, other: null } : { chord: null, other: h };
}

/** Loads MediaPipe's hand landmarker from the copy shipped with the site. */
export async function createTracker(base = "vendor/mediapipe/") {
  const { FilesetResolver, HandLandmarker } = await import(`../${base}vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(new URL(`../${base}wasm`, import.meta.url).href);
  const make = delegate => HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL(`../${base}hand_landmarker.task`, import.meta.url).href, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await make("GPU");
  } catch (e) {
    console.warn("GPU hand tracking unavailable, using CPU", e);
    return await make("CPU");
  }
}
