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

// ---------- head settings ----------
for (const id of ["xAxis", "yAxis", "invertX", "invertY", "speed", "deadzone", "lookSpeed"]) {
  const el = $(id);
  const key = el.type === "checkbox" ? "checked" : "value";
  el[key] = settings[id];
  el.oninput = () => {
    settings[id] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
    saveSettings();
  };
}
$("zero").onclick = () => api.send({ cmd: "zero" });

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
