import { beep, connect, headXY, mock, saveSettings, settings } from "./input.js";
import { t } from "./strings.js";

const $ = (id) => document.getElementById(id);
let maxEnvSeen = 1;

let axesLearned = null;
const api = connect({
  onState(s) {
    if (s.axes_learned !== undefined && s.axes_learned !== axesLearned) {
      axesLearned = s.axes_learned;
      $("manualAxes").hidden = axesLearned;
      $("clearAxes").hidden = !axesLearned;
      if (!$("axesStatus").dataset.sticky) $("axesStatus").textContent = t(axesLearned ? "setup.axes.done" : "setup.axes.none");
    }
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
    const note = e.type === "gated_raise" ? t("setup.log.ignored") : "";
    li.textContent = `${new Date().toLocaleTimeString()} — ${e.type}${e.duration_s ? ` (${e.duration_s}s)` : ""}${note}`;
    $("log").prepend(li);
  },
  onMessage(m) {
    if (m.t === "axes") {
      $("axesStatus").dataset.sticky = "1";
      $("axesStatus").innerHTML = m.ok
        ? t("setup.axes.ok", { time: new Date().toLocaleTimeString() })
        : t("setup.axes.failed", { problems: (m.problems || []).join("; ") });
    }
    if (m.t === "saved") $("saved").innerHTML = m.path ? t("setup.rec.saved", { path: m.path }) : t("setup.rec.nothing");
  },
});
const fmt = (v) => (v ?? 0).toFixed(1).padStart(6);
let lastXY = [0, 0]; // latest head tilt (x right, y down), for the range step

// ---------- head settings ----------
for (const id of ["xAxis", "yAxis", "invertX", "invertY", "speed", "deadzone", "lookSpeed", "cursorMode", "oneEuroMinCutoff", "oneEuroBeta", "magnet", "tone"]) {
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
  ["left", "←", "setup.range.left", ([x]) => -x],
  ["right", "→", "setup.range.right", ([x]) => x],
  ["down", "↓", "setup.range.down", ([, y]) => y],
  ["up", "↑", "setup.range.up", ([, y]) => -y],
];
const HOLD_MS = 2000;
const MIN_RANGE = { left: 3, right: 3, down: 3, up: 2 };
let rangeRunning = false;

function showRange() {
  for (const [dir] of RANGE_STEPS) $(`range-${dir}`).textContent = settings.range ? `${settings.range[dir].toFixed(1)}°` : "–";
  if (!rangeRunning) {
    $("range-prompt").textContent = t(settings.range ? "setup.range.done" : "setup.range.none");
    $("range-arrow").textContent = "↔";
    $("range-ring").style.setProperty("--p", settings.range ? 1 : 0);
  }
}

async function holdExtreme(arrow, key, along) {
  $("range-arrow").textContent = arrow;
  $("range-prompt").textContent = t("setup.range.hold", { text: t(key) });
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
  $("range-start").textContent = t("setup.range.cancel");
  const range = {};
  for (const [dir, arrow, text, along] of RANGE_STEPS) {
    const value = await holdExtreme(arrow, text, along);
    if (value === null) break;
    range[dir] = Math.max(MIN_RANGE[dir], value);
    $(`range-${dir}`).textContent = `${range[dir].toFixed(1)}°`;
    $("range-prompt").textContent = t("setup.range.back");
    await sleep(900);
  }
  if (rangeRunning && Object.keys(range).length === 4) {
    settings.range = range;
    saveSettings();
  }
  rangeRunning = false;
  $("range-start").textContent = t("setup.range.start");
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
  for (let s = 8; s > 0; s--) { btn.textContent = t("setup.brow.relax", { s }); await sleep(1000); }
  api.send({ cmd: "calibrate_stop" });
  btn.textContent = t("setup.brow.button");
  btn.disabled = false;
};

// ---------- guided recording ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- head calibration (server/head_axes.py + gyro bias tracking in orientation.py) ----------
$("learnAxes").onclick = async () => {
  const phase = (p) => api.send({ cmd: "axes_phase", phase: p });
  const zero = () => api.send({ cmd: "zero" });
  const steps = 6;
  const count = (n) => { $("prompt-count").textContent = t("setup.axes.step", { n, total: steps }); };
  $("learnAxes").disabled = true;
  $("abort").hidden = true;
  $("prompt").hidden = false;
  delete $("axesStatus").dataset.sticky;
  $("axesStatus").textContent = t("setup.axes.running");
  phase("begin");
  count(1);
  await step(t("setup.axes.still"), 6);
  zero();
  count(2);
  phase("nod");
  await step(t("setup.axes.nod"), 5, "action");
  phase("none");
  await step(t("setup.axes.straight"), 2);
  count(3);
  phase("turn");
  await step(t("setup.axes.shake"), 5, "action");
  phase("none");
  await step(t("setup.axes.straight"), 2);
  zero();
  count(4);
  await step(t("setup.axes.up"), 1, "action");
  phase("up");
  await step(t("setup.axes.upHold"), 1.5, "action");
  phase("none");
  await step(t("setup.axes.straight"), 2);
  zero();
  count(5);
  await step(t("setup.axes.right"), 1, "action");
  phase("right");
  await step(t("setup.axes.rightHold"), 1.5, "action");
  phase("none");
  count(6);
  await step(t("setup.axes.finish"), 3);
  zero();
  api.send({ cmd: "axes_finish" });
  $("prompt").hidden = true;
  $("abort").hidden = false;
  $("learnAxes").disabled = false;
};
$("clearAxes").onclick = () => {
  api.send({ cmd: "axes_clear" });
  delete $("axesStatus").dataset.sticky;
};
// [label, string key, seconds, kind]: the prompt text is looked up when shown
const TRIALS = [
  ...Array(20).fill(["eyebrow_raise", "setup.rec.single", 1.5, "action"]),
  ...Array(10).fill(["double_raise", "setup.rec.double", 2.0, "action"]),
  ...Array(5).fill(["hard_negative_blink", "setup.rec.blink", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_swallow", "setup.rec.swallow", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_head_move", "setup.rec.headMove", 2.0, "negative"]),
  ...Array(5).fill(["hard_negative_talk", "setup.rec.talk", 2.0, "negative"]),
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
  await step(t("setup.rec.ready"), 3);
  api.send({ cmd: "calibrate_start" }); // also labels this window "neutral"
  await step(t("setup.rec.relaxLook"), 8);
  api.send({ cmd: "calibrate_stop" });
  for (const [i, [label, key, seconds, kind]] of trials.entries()) {
    if (aborted) return;
    $("prompt-count").textContent = `${i + 1} / ${trials.length}`;
    await step(t("setup.rec.relax"), 1.5 + Math.random());
    if (aborted) return;
    api.send({ cmd: "mark", label, edge: "start" });
    await step(t(key), seconds, kind);
    api.send({ cmd: "mark", label, edge: "end" });
  }
  api.send({ cmd: "mark", label: "neutral_end", edge: "start" });
  await step(t("setup.rec.almost"), 6);
  api.send({ cmd: "mark", label: "neutral_end", edge: "end" });
  api.send({ cmd: "record_stop" });
  $("prompt").hidden = true;
};
$("abort").onclick = () => {
  aborted = true;
  api.send({ cmd: "record_stop", aborted: true });
  $("prompt").hidden = true;
};
