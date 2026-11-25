import { FilesetResolver, FaceLandmarker } from "./vendor/vision_bundle.mjs";

// ---------- tuning ----------
const MIN_FACE_WIDTH = 0.30;   // face must fill this much of the frame width (phone held close)
const BLINK_CLOSED = 0.45;     // MediaPipe eyeBlink score above this = eye closed
const MISSED_WINDOW_MS = 2 * 3600 * 1000;

const $ = (id) => document.getElementById(id);
const screens = { setup: $("setup"), armed: $("armed"), ringing: $("ringing") };
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

// ---------- storage (best effort) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

// ---------- settings ----------
function readSettings() {
  return {
    time: $("time").value || "07:00",
    label: $("label").value.trim() || "Wake up",
    ramp: Number($("ramp").value),
    hold: Number($("hold").value),
    daily: $("daily").checked,
  };
}
function applySettings(s) {
  if (!s) return;
  $("time").value = s.time; $("label").value = s.label;
  $("ramp").value = String(s.ramp); $("hold").value = String(s.hold); $("daily").checked = !!s.daily;
}
applySettings(store.get("wf.settings", null));
for (const id of ["time", "label", "ramp", "hold", "daily"]) {
  $(id).addEventListener("change", () => store.set("wf.settings", readSettings()));
}

function nextFireDate(time, from = new Date()) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
}
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function fmtIn(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `in ${h} h ${m} min` : `in ${m} min`;
}

function setStatus(text) { $("setupStatus").textContent = text; }

// ---------- audio ----------
// iOS mutes Web Audio with the silent switch unless the page declares itself a playback app.
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}

let ctx = null, preGain = null, beepTimer = null, keepAlive = null;

function ensureAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 6; comp.ratio.value = 12;
    comp.attack.value = 0.003; comp.release.value = 0.15;
    preGain = ctx.createGain();
    preGain.gain.value = 0;
    preGain.connect(comp).connect(ctx.destination);
  }
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  if (!keepAlive) {
    // An inaudible tone keeps the audio pipeline awake all night so the alarm can start without a tap.
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.frequency.value = 30;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    keepAlive = osc;
  }
}

function scheduleBeeps() {
  // Four bright beeps, then a pause; repeated every 2 seconds.
  const t0 = ctx.currentTime + 0.05;
  for (let i = 0; i < 4; i++) {
    const start = t0 + i * 0.2;
    for (const [freq, level, type] of [[1046, 0.55, "square"], [2093, 0.3, "sine"], [3136, 0.15, "sine"]]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type; osc.frequency.value = freq;
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(level, start + 0.01);
      env.gain.setValueAtTime(level, start + 0.11);
      env.gain.linearRampToValueAtTime(0, start + 0.12);
      osc.connect(env).connect(preGain);
      osc.start(start); osc.stop(start + 0.13);
    }
  }
}

let ringStartedAt = 0, rampSeconds = 60, volTimer = null;
function startAlarmSound(ramp) {
  ensureAudio();
  rampSeconds = ramp;
  ringStartedAt = performance.now();
  const now = ctx.currentTime;
  preGain.gain.cancelScheduledValues(now);
  preGain.gain.setValueAtTime(0.05, now);
  // Past 1.0 the compressor squeezes it, so it keeps getting perceptibly louder and harsher.
  preGain.gain.linearRampToValueAtTime(4.0, now + ramp);
  scheduleBeeps();
  beepTimer = setInterval(scheduleBeeps, 2000);
  volTimer = setInterval(updateVolumeMeter, 250);
}
function stopAlarmSound() {
  clearInterval(beepTimer); clearInterval(volTimer); beepTimer = volTimer = null;
  if (preGain) { preGain.gain.cancelScheduledValues(ctx.currentTime); preGain.gain.setValueAtTime(0, ctx.currentTime); }
}
function updateVolumeMeter() {
  const p = Math.min(1, (performance.now() - ringStartedAt) / 1000 / rampSeconds);
  $("volBar").style.width = `${Math.round(p * 100)}%`;
  $("volText").textContent = p < 1 ? "Getting louder…" : "Maximum volume";
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
}

// ---------- screen wake lock ----------
let wakeLock = null;
async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseScreen() { try { wakeLock?.release(); } catch {} wakeLock = null; }

// ---------- face model ----------
let landmarker = null, landmarkerLoading = null;
function loadLandmarker() {
  if (landmarker) return Promise.resolve(landmarker);
  if (!landmarkerLoading) {
    landmarkerLoading = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(new URL("./vendor/wasm", location.href).href);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: new URL("./vendor/face_landmarker.task", location.href).href, delegate },
        runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
      });
      try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU")); }
      catch { landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU")); }
      return landmarker;
    })().catch((e) => { landmarkerLoading = null; throw e; });
  }
  return landmarkerLoading;
}

// ---------- camera + face check ----------
let stream = null, loopTimer = null, held = 0, lastT = 0, holdSeconds = 3, verifying = false;
const CIRC = 2 * Math.PI * 46;
$("bar").style.strokeDasharray = String(CIRC);
function setProgress(p) { $("bar").style.strokeDashoffset = String(CIRC * (1 - p)); }

async function openCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
  });
  const v = $("video");
  v.srcObject = stream;
  await v.play();
}
function closeCamera() {
  clearInterval(loopTimer); loopTimer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
}

async function startFaceCheck() {
  $("tapToStart").hidden = true;
  $("faceStatus").textContent = "Starting camera…";
  try {
    await Promise.all([openCamera(), loadLandmarker()]);
  } catch (e) {
    console.warn("face check unavailable", e);
    if (e && (e.name === "NotAllowedError" || e.name === "NotFoundError" || e.name === "NotReadableError" || !navigator.mediaDevices)) {
      showFallback();
    } else {
      // Most often the camera needs a tap on iPhone.
      $("faceStatus").textContent = "Show your face to stop the alarm";
      $("tapToStart").hidden = false;
    }
    return;
  }
  held = 0; lastT = performance.now(); setProgress(0);
  loopTimer = setInterval(checkFrame, 100);
}

function checkFrame() {
  const v = $("video");
  if (!landmarker || v.readyState < 2) return;
  const now = performance.now();
  const dt = Math.min(0.3, (now - lastT) / 1000);
  lastT = now;
  let res;
  try { res = landmarker.detectForVideo(v, now); } catch { return; }

  let state = "noFace";
  const face = res.faceLandmarks?.[0];
  if (face) {
    let minX = 1, maxX = 0;
    for (const p of face) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
    if (maxX - minX < MIN_FACE_WIDTH) state = "tooFar";
    else {
      const cats = res.faceBlendshapes?.[0]?.categories || [];
      const score = (n) => cats.find((c) => c.categoryName === n)?.score ?? 0;
      const closed = score("eyeBlinkLeft") > BLINK_CLOSED || score("eyeBlinkRight") > BLINK_CLOSED;
      state = closed ? "eyesClosed" : "holding";
    }
  }
  held = state === "holding" ? held + dt : Math.max(0, held - dt * 2);
  const p = Math.min(1, held / holdSeconds);
  setProgress(p);
  $("faceStatus").textContent = {
    noFace: "Show your face to stop the alarm",
    tooFar: "Bring the phone closer to your face",
    eyesClosed: "Open your eyes!",
    holding: "Good, keep looking…",
  }[state];
  if (p >= 1) finishAlarm();
}

function showFallback() {
  $("camWrap").hidden = true;
  $("faceStatus").textContent = "";
  $("tapToStart").hidden = true;
  const code = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  $("code").textContent = code;
  $("fallback").hidden = false;
  const input = $("codeInput");
  input.value = "";
  input.oninput = () => { if (input.value.trim() === code) finishAlarm(); };
}

// ---------- alarm lifecycle ----------
let armed = store.get("wf.armed", null); // { fireAt, label, ramp, hold, daily }
let clockTimer = null, ringing = false, currentRing = null, needsWakeTap = false;

function arm(settings) {
  const fireAt = nextFireDate(settings.time).getTime();
  armed = { ...settings, fireAt };
  store.set("wf.armed", armed);
  show("armed");
  renderNightstand();
}

function disarm() {
  armed = null;
  store.del("wf.armed");
  releaseScreen();
  show("setup");
}

function renderNightstand() {
  const now = new Date();
  $("nightClock").textContent = fmtTime(now);
  if (armed) $("nextText").textContent = `Alarm ${fmtTime(new Date(armed.fireAt))} · ${fmtIn(armed.fireAt - now)}`
    + (needsWakeTap ? " · tap the screen once to enable sound" : "");
}

function ring(cfg, { needsTap = false } = {}) {
  if (ringing) return;
  ringing = true;
  currentRing = cfg;
  holdSeconds = cfg.hold;
  show("ringing");
  $("ringLabel").textContent = cfg.label;
  $("camWrap").hidden = false;
  $("fallback").hidden = true;
  setProgress(0);
  keepScreenOn();
  if (needsTap) {
    // The page was reloaded or reopened: iPhone needs a tap before it allows sound.
    $("faceStatus").textContent = "Your alarm is going off";
    $("tapToStart").hidden = false;
    $("tapToStart").onclick = () => { startAlarmSound(cfg.ramp); startFaceCheck(); };
  } else {
    startAlarmSound(cfg.ramp);
    $("tapToStart").onclick = () => startFaceCheck();
    startFaceCheck();
  }
}

function finishAlarm() {
  if (!ringing) return;
  ringing = false;
  stopAlarmSound();
  closeCamera();
  $("faceStatus").textContent = "Good morning! ☀️";
  setProgress(1);
  const cfg = currentRing;
  currentRing = null;
  setTimeout(() => {
    if (cfg?.isTest) {
      armed ? (show("armed"), renderNightstand()) : show("setup");
    } else if (cfg?.daily) {
      arm(cfg);         // straight back to the nightstand for tomorrow
      releaseScreen();  // you're awake; let the phone sleep normally
    } else {
      disarm();
    }
  }, 1200);
}

function tick() {
  const now = new Date();
  const clock = fmtTime(now);
  $("ringClock").textContent = clock;
  if (!screens.armed.hidden) renderNightstand();
  if (armed && !ringing && now.getTime() >= armed.fireAt) ring(armed);
}

// ---------- buttons ----------
$("arm").addEventListener("click", async () => {
  const s = readSettings();
  store.set("wf.settings", s);
  $("arm").disabled = true;
  setStatus("Getting ready…");
  ensureAudio();               // must happen inside the tap
  await keepScreenOn();
  try {
    // Ask for the camera now, so the prompt doesn't appear half-asleep.
    await openCamera(); closeCamera();
  } catch (e) {
    setStatus("Camera access was refused. Allow it in Settings → Apps → Safari → Camera, or the alarm will fall back to typing a code.");
  }
  try { await loadLandmarker(); }
  catch (e) { setStatus("The face checker couldn't load. Check your connection and try again."); $("arm").disabled = false; return; }
  setStatus("");
  $("arm").disabled = false;
  arm(s);
});

$("test").addEventListener("click", () => {
  ensureAudio();
  const s = readSettings();
  ring({ ...s, ramp: 15, isTest: true });
});

$("disarm").addEventListener("click", disarm);

// ---------- lifecycle ----------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (armed || ringing) keepScreenOn();
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  tick();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Restore after a reload or reopen.
if (armed) {
  const late = Date.now() - armed.fireAt;
  if (late >= 0 && late < MISSED_WINDOW_MS) {
    ring(armed, { needsTap: true });
  } else if (late >= MISSED_WINDOW_MS) {
    if (armed.daily) { armed.fireAt = nextFireDate(armed.time).getTime(); store.set("wf.armed", armed); }
    else { armed = null; store.del("wf.armed"); }
  }
  if (armed && !ringing) {
    // After a reload iPhone needs one tap before the alarm may make sound.
    needsWakeTap = true;
    screens.armed.addEventListener("click", () => { ensureAudio(); keepScreenOn(); needsWakeTap = false; renderNightstand(); }, { once: true });
    show("armed");
    renderNightstand();
  }
}
clockTimer = setInterval(tick, 1000);
tick();
