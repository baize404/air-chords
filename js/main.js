// AirChords: wiring the hands, touch, keyboard and buttons to the sound engine.

import { Engine, SOUNDS, GROOVES, mtof } from "./audio.js";
import * as T from "./theory.js";
import { analyzeHand, slotOf, SlotFilter, StrumDetector, assignHands, createTracker } from "./hands.js";
import { Looper } from "./looper.js";
import { Recorder, NoteLog } from "./recorder.js";
import { Visuals } from "./visuals.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SLOT_ICON = ["✊", "☝️", "✌️", "3指", "4指", "🖐", "🤙", "L👆"];
const SLOT_HELP = ["握拳＝停", "伸 1 根手指", "伸 2 根手指", "伸 3 根手指", "伸 4 根手指", "整隻手張開", "拇指＋小指（打電話）", "拇指＋食指（L 形）"];

const S = {
  key: 0, mode: "major", prog: "diatonic", rhand: "express", scale: "penta",
  chordOnLeft: true, showCam: true, camera: false,
  gestureSlot: -1, padSlot: -1, keySlot: -1, keysHeld: [],
  seventh: false, flip: false, keySeventh: false, keyFlip: false,
  register: 1, muted: false,
  playing: null, chord: null,
  hands: [], lastChordHand: -9, lastAnyHand: -9,
  melody: { idx: -1, sounding: false, pinched: false, freqY: null, key: null },
};
let engine, looper, recorder, notelog, tracker, lastVideoTime = -1, lastT = null, started = false;
const vis = new Visuals($("#stage"));
const cam = $("#cam");
const slotFilter = new SlotFilter(3);
const strumHand = new StrumDetector(), strumTouch = new StrumDetector();

// ------------------------------------------------------------------ helpers
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function chordForSlot(slot, opts = {}) {
  const deg = T.slotDegrees(S.prog)[slot - 1];
  return T.diatonicChord(S.key, S.mode, deg, opts);
}
function ladderNotes() { return T.melodyNotes(S.key, S.mode, S.scale, 60, S.scale === "penta" ? 11 : 15); }
function ladderBounds() {
  const top = ($("#top").offsetHeight + 70) / innerHeight;
  const bottom = 1 - ($("#bottom").offsetHeight + $("#pads").offsetHeight + 58) / innerHeight;
  return { top, bottom };
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ UI setup
T.NOTE_NAMES.forEach((n, i) => $("#key").add(new Option(n, i)));
T.PROGRESSIONS.forEach(p => $("#prog").add(new Option(p.name, p.id)));
SOUNDS.forEach(s => $("#sound").add(new Option(s.name, s.id)));
GROOVES.forEach(g => $("#style").add(new Option(g.name, g.id)));

for (let slot = 1; slot <= 7; slot++) {
  const b = document.createElement("button");
  b.className = "pad";
  b.dataset.slot = slot;
  b.innerHTML = `<span class="g">${SLOT_ICON[slot]}</span><span class="n"></span><span class="r"></span>`;
  b.addEventListener("pointerdown", e => { e.preventDefault(); b.setPointerCapture(e.pointerId); S.padSlot = slot; });
  const up = () => { if (S.padSlot === slot) S.padSlot = -1; };
  b.addEventListener("pointerup", up);
  b.addEventListener("pointercancel", up);
  $("#pads").append(b);
}

function refreshLabels() {
  $$(".pad").forEach(b => {
    const c = chordForSlot(+b.dataset.slot);
    b.querySelector(".n").textContent = c.name;
    b.querySelector(".r").textContent = c.roman;
    b.style.setProperty("--h", T.hueOf(c.root));
  });
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(s => {
    const c = s ? chordForSlot(s) : null;
    return `<tr><td>${SLOT_ICON[s]}</td><td>${SLOT_HELP[s]}</td><td>${c ? `<b>${c.name}</b> <span class="small">${c.roman}</span>` : "停止"}</td></tr>`;
  });
  $("#helpTable").innerHTML = rows.join("");
}
refreshLabels();

const bind = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
bind("#key", "change", e => { S.key = +e.target.value; refreshLabels(); });
bind("#mode", "change", e => { S.mode = e.target.value; refreshLabels(); });
bind("#prog", "change", e => { S.prog = e.target.value; refreshLabels(); });
bind("#sound", "change", e => engine?.setSound(e.target.value));
bind("#rhand", "change", e => { S.rhand = e.target.value; engine?.leadOff(engine.ctx.currentTime); });
bind("#bpm", "input", e => { $("#bpmVal").textContent = e.target.value; engine?.setTempo(+e.target.value); });
bind("#quant", "change", e => engine && (engine.quantize = e.target.value));
bind("#scale", "change", e => (S.scale = e.target.value));
bind("#rev", "input", e => engine?.setReverb(e.target.value / 100));
bind("#dly", "input", e => engine?.setDelay(e.target.value / 100 * 0.6));
bind("#swap", "change", e => { S.chordOnLeft = !e.target.checked; slotFilter.reset(); });
bind("#showCam", "change", e => (S.showCam = e.target.checked));
bind("#setBtn", "click", () => ($("#settings").hidden = !$("#settings").hidden));
bind("#helpBtn", "click", () => ($("#help").hidden = false));
bind("#helpClose", "click", () => ($("#help").hidden = true));
bind("#style", "change", e => engine && (engine.groove.style = e.target.value));
$$(".tog").forEach(b => b.addEventListener("click", () => {
  if (!engine) return;
  const k = b.dataset.g;
  engine.groove[k] = !engine.groove[k];
  b.classList.toggle("on", engine.groove[k]);
}));

// ------------------------------------------------------------------ start
async function boot(useCamera) {
  if (started) return;
  started = true;
  engine = new Engine();
  await engine.resume();
  looper = new Looper(engine);
  notelog = new NoteLog(engine);
  recorder = new Recorder(engine);
  engine.setSound($("#sound").value);
  engine.setTempo(+$("#bpm").value);
  $("#intro").hidden = true;
  vis.resize();
  requestAnimationFrame(frame);
  if (useCamera) {
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      setCamera(false);
      toast(err && err.name === "NotAllowedError" ? "沒有拿到鏡頭權限，先用觸控／鍵盤彈" : "開不了鏡頭，先用觸控／鍵盤彈", 5000);
    }
  } else {
    setCamera(false);
    toast("按住下面的和弦按鈕，或用鍵盤 1–7 彈", 4000);
  }
}
function setCamera(on) {
  S.camera = on;
  document.body.classList.toggle("camera", on);
}
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  cam.srcObject = stream;
  await cam.play();
  setCamera(true);
  toast("載入手部追蹤中…", 0);
  try {
    tracker = await createTracker();
  } catch (err) {
    console.error(err);
    toast("這台裝置跑不動手部追蹤，改用觸控／鍵盤彈", 6000);
    return;
  }
  toast("好了！把左手舉到畫面左邊，比 1 到 5 根手指", 4500);
}
bind("#startCam", "click", () => boot(true));
bind("#startTouch", "click", () => boot(false));

// ------------------------------------------------------------------ hands
function onHands(landmarks, aspect, t) {
  const hands = landmarks.map(lm => analyzeHand(lm, aspect));
  const { chord, other } = assignHands(hands, S.chordOnLeft);
  if (hands.length) S.lastAnyHand = t;
  if (chord) {
    S.lastChordHand = t;
    S.gestureSlot = slotFilter.update(slotOf(chord));
    const inward = S.chordOnLeft ? chord.roll : -chord.roll;   // leaning towards the middle of the screen
    S.seventh = S.seventh ? inward > 16 : inward > 28;
    S.flip = S.flip ? inward < -16 : inward < -28;
    chord.role = "chord";
    const s = S.gestureSlot;
    chord.label = s > 0 ? `${SLOT_ICON[s]} ${chordForSlot(s, { seventh: S.seventh, flip: S.flip }).name}` : s === 0 ? "✊ 停" : "";
  } else if (t - S.lastChordHand > 0.35) {
    S.gestureSlot = -1;
    slotFilter.reset();
    S.seventh = S.flip = false;
  }
  if (other) other.role = "other";
  otherHand(other, t);
  S.hands = hands;
}

function otherHand(h, t) {
  const now = engine.ctx.currentTime;
  if (S.rhand === "express") {
    S.muted = !!h && h.shape === "fist";
    if (!h) return;
    engine.setBrightness(1 - clamp((h.y - 0.15) / 0.6));
    const u = S.chordOnLeft ? (h.x - 0.5) / 0.5 : (0.5 - h.x) / 0.5;
    S.register = u < 0.33 ? 0 : u < 0.66 ? 1 : 2;
    const dir = strumHand.update(h.y, t);
    if (dir && !S.muted) doStrum(dir, vis.toUnit(h.points[9]));
    h.label = S.muted ? "✊ 止音" : `${["低", "中", "高"][S.register]}音域 · 往下揮＝掃弦`;
    return;
  }
  if (!h) { stopMelody(now); return; }
  const pinched = S.melody.pinched ? h.pinch < 0.55 : h.pinch < 0.35;
  S.melody.pinched = pinched;
  h.pinched = pinched;
  const y = vis.toUnit({ x: h.tipX, y: h.tipY }).y;
  playMelodyAt(y, pinched, now, vis.toUnit({ x: h.tipX, y: h.tipY }));
  h.label = pinched ? "♪" : "捏起來發聲";
}

function playMelodyAt(y, on, now, burstAt) {
  const notes = ladderNotes(), { top, bottom } = ladderBounds();
  const f = clamp((bottom - y) / (bottom - top));
  if (!on) { stopMelody(now); S.melody.freqY = S.rhand === "theremin" ? y : null; return; }
  if (S.rhand === "theremin") {
    const m = notes[0] + f * (notes[notes.length - 1] - notes[0]);
    engine.leadFreq(mtof(m), now);
    S.melody.freqY = y;
    S.melody.sounding = true;
    S.melody.idx = -1;
  } else {
    const idx = Math.round(f * (notes.length - 1));
    if (idx !== S.melody.idx || !S.melody.sounding) {
      engine.leadOn(notes[idx], now);
      if (burstAt) vis.burst(burstAt.x, burstAt.y, 190, 8, 0.5);
    }
    S.melody.idx = idx;
    S.melody.sounding = true;
    S.melody.freqY = null;
  }
}
function stopMelody(now) {
  if (S.melody.sounding) engine.leadOff(now);
  S.melody.sounding = false;
  S.melody.idx = -1;
}

function doStrum(dir, at) {
  if (!S.playing) return;
  if (engine.strum(engine.ctx.currentTime + 0.005, dir)) {
    vis.flash = 1;
    if (at) vis.burst(at.x, at.y, vis.hue, 26, 0.9);
  }
}

// ------------------------------------------------------------------ touch on the stage
const stage = $("#stage");
let touchId = null;
function inOtherSide(x) { return S.chordOnLeft ? x > innerWidth * 0.5 : x < innerWidth * 0.5; }
stage.addEventListener("pointerdown", e => {
  if (!engine || !inOtherSide(e.clientX)) return;
  touchId = e.pointerId;
  stage.setPointerCapture(e.pointerId);
  touchMove(e, true);
});
stage.addEventListener("pointermove", e => { if (e.pointerId === touchId) touchMove(e, false); });
const touchEnd = e => {
  if (e.pointerId !== touchId) return;
  touchId = null;
  if (S.rhand !== "express") stopMelody(engine.ctx.currentTime);
};
stage.addEventListener("pointerup", touchEnd);
stage.addEventListener("pointercancel", touchEnd);
function touchMove(e, down) {
  const x = e.clientX / innerWidth, y = e.clientY / innerHeight, t = performance.now() / 1000;
  if (S.rhand === "express") {
    engine.setBrightness(1 - clamp((y - 0.15) / 0.6));
    const u = S.chordOnLeft ? (x - 0.5) / 0.5 : (0.5 - x) / 0.5;
    S.register = u < 0.33 ? 0 : u < 0.66 ? 1 : 2;
    const dir = strumTouch.update(y, t);
    if (down || dir) doStrum(dir || 1, { x, y });
  } else playMelodyAt(y, true, engine.ctx.currentTime, { x, y });
}

// ------------------------------------------------------------------ keyboard
const MELODY_KEYS = "qwertyuiop";
addEventListener("keydown", e => {
  if (!engine || e.repeat || e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k >= "1" && k <= "7") { S.keysHeld = S.keysHeld.filter(v => v !== +k).concat(+k); S.keySlot = +k; }
  else if (k === "0" || k === "`") { S.keysHeld = []; S.keySlot = 0; }
  else if (k === "shift") S.keySeventh = true;
  else if (k === "m") S.keyFlip = true;
  else if (k === " ") { e.preventDefault(); doStrum(1, { x: 0.5, y: 0.5 }); }
  else if (k === "arrowup") { e.preventDefault(); engine.setBrightness(engine.brightness + 0.1); }
  else if (k === "arrowdown") { e.preventDefault(); engine.setBrightness(engine.brightness - 0.1); }
  else if (k === "z") S.register = Math.max(0, S.register - 1);
  else if (k === "x") S.register = Math.min(2, S.register + 1);
  else if (k === "l") $("#loopBtn").click();
  else if (MELODY_KEYS.includes(k)) {
    const notes = ladderNotes(), i = Math.min(notes.length - 1, MELODY_KEYS.indexOf(k));
    S.melody.key = k;
    engine.leadOn(notes[i], engine.ctx.currentTime);
    S.melody.idx = i; S.melody.sounding = true;
  }
});
addEventListener("keyup", e => {
  if (!engine) return;
  const k = e.key.toLowerCase();
  if (k >= "1" && k <= "7") {
    S.keysHeld = S.keysHeld.filter(v => v !== +k);
    S.keySlot = S.keysHeld.length ? S.keysHeld[S.keysHeld.length - 1] : -1;
  } else if (k === "0" || k === "`") S.keySlot = -1;
  else if (k === "shift") S.keySeventh = false;
  else if (k === "m") S.keyFlip = false;
  else if (MELODY_KEYS.includes(k) && S.melody.key === k) { stopMelody(engine.ctx.currentTime); S.melody.key = null; }
});

// ------------------------------------------------------------------ loop & record buttons
bind("#loopBtn", "click", () => looper && looper.press(+$("#loopBars").value));
bind("#loopClear", "click", () => looper && looper.clear());
function recButton(id, kind) {
  bind(id, "click", async () => {
    if (!recorder) return;
    if (recorder.active) {
      const out = await recorder.stop();
      showResult(out);
      return;
    }
    try {
      recorder.start(kind);
    } catch (err) {
      toast(err.message || "這個瀏覽器不能錄製", 4000);
    }
  });
}
recButton("#recV", "vertical");
recButton("#recH", "landscape");
recButton("#recA", "audio");
bind("#midiBtn", "click", () => {
  const bytes = notelog?.toMidi();
  if (!bytes) { toast("還沒有彈任何東西"); return; }
  download(new Blob([bytes], { type: "audio/midi" }), `airchords-${stamp()}.mid`);
  toast("MIDI 下載好了，可以拖進 GarageBand、Logic、FL Studio 等軟體");
});
function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function showResult(out) {
  if (!out) return;
  const ext = out.type.includes("mp4") ? (out.kind === "audio" ? "m4a" : "mp4") : "webm";
  const url = URL.createObjectURL(out.blob);
  const media = document.createElement(out.kind === "audio" ? "audio" : "video");
  media.src = url; media.controls = true; media.playsInline = true;
  $("#resMedia").replaceChildren(media);
  $("#resTitle").textContent = out.kind === "audio" ? "錄音好了" : "影片錄好了";
  const mins = Math.floor(out.seconds / 60), secs = Math.round(out.seconds % 60);
  $("#resInfo").textContent = `${mins ? mins + " 分 " : ""}${secs} 秒 · ${(out.blob.size / 1e6).toFixed(1)} MB · ${ext.toUpperCase()}`
    + (ext === "webm" && out.kind !== "audio" ? "（要傳 IG 的話，部分手機需要先轉成 MP4）" : "");
  const dl = $("#resDl");
  dl.href = url;
  dl.download = `airchords-${stamp()}.${ext}`;
  $("#result").hidden = false;
}
bind("#resClose", "click", () => { $("#result").hidden = true; $("#resMedia").replaceChildren(); });

// ------------------------------------------------------------------ every frame
function frame(nowMs) {
  const t = nowMs / 1000, dt = lastT == null ? 0.016 : Math.min(0.1, t - lastT);
  lastT = t;
  if (tracker && S.camera && !window.airchords.paused && cam.readyState >= 2 && cam.currentTime !== lastVideoTime) {
    lastVideoTime = cam.currentTime;
    try {
      const res = tracker.detectForVideo(cam, nowMs);
      onHands(res.landmarks || [], cam.videoWidth / cam.videoHeight, t);
    } catch (err) { console.warn(err); }
  }
  updateChord();
  draw(dt, t);
  requestAnimationFrame(frame);
}

function updateChord() {
  const slot = S.padSlot >= 0 ? S.padSlot : S.keySlot >= 0 ? S.keySlot : S.gestureSlot;
  const seventh = S.seventh || S.keySeventh, flip = S.flip || S.keyFlip;
  const want = slot > 0 && !S.muted
    ? { slot, seventh, flip, register: S.register, key: S.key, mode: S.mode, prog: S.prog, sound: engine.sound } : null;
  const same = (a, b) => (!a && !b) || (a && b && Object.keys(a).every(k => k === "chord" || a[k] === b[k]));
  if (same(want, S.playing)) return;
  const time = engine.when();
  if (!want) {
    engine.chordOff(time);
    S.playing = null;
    S.chord = null;
    return;
  }
  const chord = chordForSlot(slot, { seventh, flip });
  engine.chordOn(T.voicing(chord, want.register), time, { root: chord.root });
  const changed = !S.playing || S.playing.slot !== slot;
  S.playing = { ...want, chord };
  S.chord = chord;
  if (changed) burstFromChord();
}

function burstFromChord() {
  const hue = T.hueOf(S.chord.root);
  const ch = S.hands.find(h => h.role === "chord");
  if (ch && S.gestureSlot === S.playing.slot) {
    ch.ext.forEach((on, i) => on && (() => { const p = vis.toUnit(ch.points[[4, 8, 12, 16, 20][i]]); vis.burst(p.x, p.y, hue, 10, 0.6); })());
  } else {
    const pad = $(`.pad[data-slot="${S.playing.slot}"]`);
    const r = pad.getBoundingClientRect();
    vis.burst((r.left + r.width / 2) / innerWidth, r.top / innerHeight, hue, 20, 0.7);
  }
}

function draw(dt, t) {
  const pos = engine.position(), g = engine.groove;
  $$(".pad").forEach(b => b.classList.toggle("on", S.playing?.slot === +b.dataset.slot));
  const lb = $("#loopBtn"), ls = looper.state;
  lb.className = "pill " + ({ waiting: "loop-wait", recording: "loop-wait", playing: "loop-play", overdub: "loop-dub" }[ls] || "");
  lb.textContent = (innerWidth <= 720
    ? { idle: "⏺ 循環", waiting: "等一下…", recording: "● 錄循環", playing: "▶ 疊錄?", overdub: "● 疊錄中" }
    : { idle: "⏺ 循環", waiting: "等下一小節…", recording: "● 錄循環中", playing: "▶ 循環中（按一下疊錄）", overdub: "● 疊錄中" })[ls];
  $("#loopClear").hidden = ls === "idle";
  const recIds = { vertical: "#recV", landscape: "#recH", audio: "#recA" };
  for (const [kind, id] of Object.entries(recIds)) {
    const b = $(id), mine = recorder.active && recorder.kind === kind;
    b.classList.toggle("rec", mine);
    b.disabled = recorder.active && !mine;
    const narrow = innerWidth <= 720;
    b.textContent = mine ? "■ 停止" : (narrow ? { vertical: "🎬 9:16", landscape: "🖥 16:9", audio: "🎙" }
      : { vertical: "🎬 錄影 9:16", landscape: "🖥 錄影 16:9", audio: "🎙 錄音" })[kind];
  }
  const recSecs = recorder.active ? Math.floor((performance.now() - recorder.t0) / 1000) : 0;
  let hint = "";
  if (S.camera) {
    if (!tracker) hint = "載入手部追蹤中…";
    else if (t - S.lastAnyHand > 2.5) hint = "沒看到手：手掌對著鏡頭、離近一點、把燈打亮";
    else if (S.gestureSlot < 0) hint = S.chordOnLeft ? "和弦手放在畫面左半邊" : "和弦手放在畫面右半邊";
  } else hint = innerWidth <= 720 ? "按住下面的和弦；右半邊點一下＝掃弦" : "按住下面的和弦，或用鍵盤 1–7；右半邊點一下＝掃弦";
  const notes = ladderNotes();
  vis.draw({
    video: cam, showCam: S.showCam, camera: S.camera, chordOnLeft: S.chordOnLeft,
    chord: S.chord, slotLabel: S.playing ? SLOT_ICON[S.playing.slot] : "", hint,
    hands: S.hands,
    ladder: S.rhand === "express" ? null : { notes, index: S.melody.idx, sounding: S.melody.sounding, freqY: S.melody.freqY },
    keyPc: S.key,
    beat: pos.beat, grooveOn: g.drums || g.bass || g.arp,
    loop: looper.progress(), loopState: ls,
    recording: recorder.active, recTime: `${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}`,
    topH: $("#top").offsetHeight, bottomH: $("#bottom").offsetHeight + $("#pads").offsetHeight + 8,
  }, dt);
  recorder.frame(vis.c);
}

// keep the chord pads, the groove buttons and messages clear of the bars, whatever wraps
function layout() {
  const top = $("#top").offsetHeight, bottom = $("#bottom").offsetHeight;
  $("#pads").style.bottom = bottom + 8 + "px";
  $("#toast").style.top = top + 10 + "px";
  $("#settings").style.top = top + 8 + "px";
  if (innerWidth <= 720) $("#groove").style.bottom = bottom + $("#pads").offsetHeight + 18 + "px";
  else $("#groove").style.bottom = "";
}
addEventListener("resize", () => { layout(); if (started) vis.resize(); });
if (window.ResizeObserver) new ResizeObserver(layout).observe($("#bottom"));
layout();

// for testing without a real camera: feed hand landmarks directly
window.airchords = {
  S, boot, paused: false,
  get engine() { return engine; },
  get looper() { return looper; },
  get notelog() { return notelog; },
  feed(landmarks, aspect = 16 / 9) { onHands(landmarks, aspect, performance.now() / 1000); },
  tracker: () => tracker,
};
