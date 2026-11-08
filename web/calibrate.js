import { beep, connect, headXY, mock, saveSettings, settings } from "./input.js";

const $ = (id) => document.getElementById(id);
let maxEnvSeen = 1;

const api = connect({
  onState(s) {
    const live = s.status === "live" || mock;
    $("conn").textContent = s.status ?? "";
    $("conn").className = `pill ${live ? "good" : "bad"}`;
    if (s.rate_hz !== undefined && !mock) {
      // the Knight board should deliver ~125 Hz; last hackathon saw 72-79 Hz
      $("rate").textContent = `${s.rate_hz} Hz`;
      $("rate").className = `pill ${s.rate_hz > 110 ? "good" : "bad"}`;
    }
    const [x, y] = headXY(s);
    lastXY = [x, y];
    const clamp = (v) => Math.max(-48, Math.min(48, v));
    $("dot").style.translate = `${clamp(x * 2.5)}% ${clamp(y * 2.5) * 3}%`;
    $("angles").textContent = `roll ${fmt(s.roll)}  pitch ${fmt(s.pitch)}  yaw ${fmt(s.yaw)}  →  x ${fmt(x)}  y ${fmt(y)}`;

    if (s.envelope !== undefined) {
      maxEnvSeen = Math.max(maxEnvSeen * 0.999, s.envelope);
      const full = s.threshold ? s.threshold * 2 : maxEnvSeen * 1.2;
      $("env").style.width = `${Math.min(100, (s.envelope / full) * 100)}%`;
      $("thr").hidden = !s.threshold;
      if (document.activeElement !== $("k") && s.k) { $("k").value = s.k; $("kval").textContent = s.k; }
    }
  },
  onEvent(e) {
    if (e.type === "click" || e.type === "drag_toggle") beep(e.type === "click" ? 660 : 880);
    const li = document.createElement("li");
    li.className = e.type;
    const note = e.type === "gated_raise" ? " — ignored, head was moving" : "";
    li.textContent = `${new Date().toLocaleTimeString()} — ${e.type}${e.duration_s ? ` (${e.duration_s}s)` : ""}${note}`;
    $("log").prepend(li);
  },
  onMessage(m) {
    if (m.t === "saved") $("saved").innerHTML = m.path ? `Saved <code>${m.path}</code>. Tell Claude: “analyze ${m.path}”.` : "Nothing was saved.";
  },
});
const fmt = (v) => (v ?? 0).toFixed(1).padStart(6);
let lastXY = [0, 0]; // latest head tilt (x right, y down), for the range step

// ---------- head settings ----------
for (const id of ["xAxis", "yAxis", "invertX", "invertY", "speed", "deadzone", "lookSpeed", "cursorMode", "oneEuroMinCutoff", "oneEuroBeta"]) {
  const el = $(id);
  const key = el.type === "checkbox" ? "checked" : "value";
  const out = $(`${id}-val`);
  el[key] = settings[id];
  if (out) out.textContent = settings[id];
  el.oninput = () => {
    settings[id] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
    if (out) out.textContent = settings[id];
    saveSettings();
  };
}
$("zero").onclick = () => api.send({ cmd: "zero" });

// ---------- comfortable range (per-direction cursor gains) ----------
// Each extreme is the median tilt over a 2 s hold. The hold only counts while the head is clearly
// tilted that way, and restarts if it drops back, so a quick wobble doesn't set the range.
const RANGE_STEPS = [
  ["left", "←", "Tilt LEFT as far as is comfortable", ([x]) => -x],
  ["right", "→", "Tilt RIGHT as far as is comfortable", ([x]) => x],
  ["down", "↓", "Tilt DOWN as far as is comfortable", ([, y]) => y],
  ["up", "↑", "Now tilt UP, just a little", ([, y]) => -y],
];
const HOLD_MS = 2000;
const MIN_RANGE = { left: 3, right: 3, down: 3, up: 2 };
let rangeRunning = false;

function showRange() {
  for (const [dir] of RANGE_STEPS) $(`range-${dir}`).textContent = settings.range ? `${settings.range[dir].toFixed(1)}°` : "–";
  if (!rangeRunning) {
    $("range-prompt").textContent = settings.range
      ? "Calibrated. Comfortable tilt reaches the screen edge."
      : "Not calibrated: the cursor uses the speed slider.";
    $("range-arrow").textContent = "↔";
    $("range-ring").style.setProperty("--p", settings.range ? 1 : 0);
  }
}

async function holdExtreme(arrow, text, along) {
  $("range-arrow").textContent = arrow;
  $("range-prompt").textContent = `${text}… and hold`;
  const enough = Math.max(settings.deadzone + 1.5, 2.5); // clearly tilted, not just jitter
  let start = null;
  let samples = [];
  while (rangeRunning) {
    const v = along(lastXY);
    const now = performance.now();
    if (v >= enough) {
      start ??= now;
      samples.push(v);
    } else { start = null; samples = []; }
    const p = start === null ? 0 : Math.min(1, (now - start) / HOLD_MS);
    $("range-ring").style.setProperty("--p", p);
    if (p >= 1) {
      beep(880, 120);
      const sorted = samples.sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    await sleep(1000 / 30);
  }
  return null;
}

$("range-start").onclick = async () => {
  if (rangeRunning) { rangeRunning = false; return; } // second press cancels
  rangeRunning = true;
  $("range-start").textContent = "Cancel";
  const range = {};
  for (const [dir, arrow, text, along] of RANGE_STEPS) {
    const value = await holdExtreme(arrow, text, along);
    if (value === null) break;
    range[dir] = Math.max(MIN_RANGE[dir], value);
    $(`range-${dir}`).textContent = `${range[dir].toFixed(1)}°`;
    $("range-prompt").textContent = "Back to the middle…";
    await sleep(900);
  }
  if (rangeRunning && Object.keys(range).length === 4) {
    settings.range = range;
    saveSettings();
  }
  rangeRunning = false;
  $("range-start").textContent = "Calibrate range";
  showRange();
};
$("range-reset").onclick = () => {
  rangeRunning = false;
  settings.range = null;
  saveSettings();
  showRange();
};
showRange();

// ---------- eyebrow calibration ----------
$("k").oninput = () => { $("kval").textContent = $("k").value; api.send({ cmd: "set_k", k: Number($("k").value) }); };
$("calibrate").onclick = async () => {
  const btn = $("calibrate");
  btn.disabled = true;
  api.send({ cmd: "calibrate_start" });
  for (let s = 8; s > 0; s--) { btn.textContent = `Relax… ${s}`; await sleep(1000); }
  api.send({ cmd: "calibrate_stop" });
  btn.textContent = "Calibrate (relax 8 s)";
  btn.disabled = false;
};

// ---------- guided recording ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRIALS = [
  ...Array(20).fill(["eyebrow_raise", "Raise your eyebrows ONCE", 1.5, "action"]),
  ...Array(10).fill(["double_raise", "Raise TWICE, quickly", 2.0, "action"]),
  ...Array(5).fill(["hard_negative_blink", "Blink a few times 😌<br><small>eyebrows still</small>", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_swallow", "Swallow 😮‍💨", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_head_move", "Move your head a little<br><small>eyebrows still</small>", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_talk", "Say “hello, how are you?”", 2.0, "negative"]),
];
let aborted = false;

async function step(text, seconds, kind = "") {
  $("prompt-text").innerHTML = text;
  $("prompt-text").className = kind;
  const bar = $("prompt-bar");
  bar.style.transition = "none"; bar.style.width = "0";
  void bar.offsetWidth;
  bar.style.transition = `width ${seconds}s linear`; bar.style.width = "100%";
  await sleep(seconds * 1000);
}

$("record").onclick = async () => {
  aborted = false;
  const trials = [...TRIALS].sort(() => Math.random() - 0.5);
  $("prompt").hidden = false;
  api.send({ cmd: "record_start", name: $("name").value, note: $("note").value, protocol: "brow_v1" });
  await step("Get ready…", 3);
  api.send({ cmd: "calibrate_start" }); // also labels this window "neutral"
  await step("Relax and look ahead", 8);
  api.send({ cmd: "calibrate_stop" });
  for (const [i, [label, text, seconds, kind]] of trials.entries()) {
    if (aborted) return;
    $("prompt-count").textContent = `${i + 1} / ${trials.length}`;
    await step("Relax", 1.5 + Math.random());
    if (aborted) return;
    api.send({ cmd: "mark", label, edge: "start" });
    await step(text, seconds, kind);
    api.send({ cmd: "mark", label, edge: "end" });
  }
  api.send({ cmd: "mark", label: "neutral_end", edge: "start" });
  await step("Relax — almost done", 6);
  api.send({ cmd: "mark", label: "neutral_end", edge: "end" });
  api.send({ cmd: "record_stop" });
  $("prompt").hidden = true;
};
$("abort").onclick = () => {
  aborted = true;
  api.send({ cmd: "record_stop", aborted: true });
  $("prompt").hidden = true;
};
