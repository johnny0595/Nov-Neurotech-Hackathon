// Head + eyebrow input shared by the game and the calibration page.
import { lockLookbackMs, positionAt } from "./pointer.js";

// Live: head angles and eyebrow events stream from the Python server over /ws.
// Mock (?mock=1): mouse position stands in for head tilt, C = eyebrow click (a 0.3 s raise), D = double raise.
// Like the server (without --double), mock is single-raise-only; add &double=1 to make D drag the map.

const DEFAULTS = { xAxis: "roll", yAxis: "pitch", invertX: false, invertY: false, deadzone: 3, speed: 60, maxSpeed: 1100, lookSpeed: 7 };

function readStored() {
  try { return JSON.parse(localStorage.getItem("brow-settings")) || {}; } catch { return {}; }
}
export const settings = { ...DEFAULTS, ...readStored() };
export function saveSettings() {
  try { localStorage.setItem("brow-settings", JSON.stringify(settings)); } catch { /* private mode: settings last this visit only */ }
}

export const mock = new URLSearchParams(location.search).has("mock");

/** Head tilt in degrees as [x, y]; right and down are positive. */
export function headXY(state) {
  if (mock) return [state.roll || 0, state.pitch || 0];
  const pick = (axis, invert) => (state[axis] || 0) * (invert ? -1 : 1);
  return [pick(settings.xAxis, settings.invertX), pick(settings.yAxis, settings.invertY)];
}

export function deadzone(value, dz) {
  const m = Math.abs(value) - dz;
  return m <= 0 ? 0 : Math.sign(value) * m;
}

export function connect({ onState = () => {}, onEvent = () => {}, onMessage = () => {} } = {}) {
  const api = { connected: false, send() {} };
  if (mock) {
    const double_enabled = new URLSearchParams(location.search).has("double");
    const fake = { roll: 0, pitch: 0, yaw: 0, status: `mock (mouse + C${double_enabled ? "/D" : ""} keys)`, envelope: 3, threshold: 10, rate_hz: 0, double_enabled };
    addEventListener("mousemove", (e) => {
      fake.roll = ((e.clientX - innerWidth / 2) / (innerWidth / 2)) * 20;
      fake.pitch = ((e.clientY - innerHeight / 2) / (innerHeight / 2)) * 20;
      fake.yaw = fake.roll;
    });
    addEventListener("keydown", (e) => {
      if (e.target.closest?.("input, select, textarea")) return;
      if (e.key === "c") { fake.envelope = 24; onEvent({ type: "raise", duration_s: 0.3 }); onEvent({ type: "click", duration_s: 0.3, delay_s: 0 }); }
      if (e.key === "d" && double_enabled) { fake.envelope = 24; onEvent({ type: "raise" }); onEvent({ type: "raise" }); onEvent({ type: "drag_toggle" }); }
    });
    setInterval(() => {
      fake.envelope = 3 + (fake.envelope - 3) * 0.9 + Math.random() * 0.6; // fake EMG: decays back to rest
      onState({ ...fake, envelope: Math.round(fake.envelope * 100) / 100 });
    }, 1000 / 60);
    api.connected = true;
    return api;
  }
  let ws;
  api.send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => { api.connected = true; };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.t === "state") {
        onState(msg);
        for (const e of msg.events) onEvent(e);
      } else onMessage(msg);
    };
    ws.onclose = () => {
      api.connected = false;
      onState({ status: "disconnected — is the server running?" });
      setTimeout(open, 1000);
    };
  };
  open();
  return api;
}

let audio;
addEventListener("keydown", () => { audio ??= new AudioContext(); audio.resume(); });
addEventListener("pointerdown", () => { audio ??= new AudioContext(); audio.resume(); });
export function beep(freq = 660, ms = 90) {
  if (!audio || audio.state !== "running") return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + ms / 1000);
}

const DWELL_MS = 2000;

/**
 * On-page cursor driven by head tilt. It never touches the OS pointer, so it cannot escape the page.
 * Pause: Space/Esc (helper), or dwell on the top-right corner for 2 s. Any eyebrow raise resumes.
 * Resuming recenters the cursor and re-zeros the head's neutral pose.
 */
export function createCursor({ api, onClick = () => {}, onDrag = () => {}, onPauseChange = () => {} }) {
  const el = document.createElement("div");
  el.className = "head-cursor";
  const corner = document.createElement("div");
  corner.className = "pause-corner";
  corner.innerHTML = "<span>⏸</span><small>look here to pause</small>";
  const overlay = document.createElement("div");
  overlay.className = "pause-overlay";
  overlay.innerHTML = `<div><h1>Paused</h1><p>Look straight ahead,<br>then <b>raise your eyebrows</b> to play.</p><small>Helper: press Space or click here</small></div>`;
  document.body.append(corner, overlay, el);
  overlay.addEventListener("click", () => setPaused(false)); // mouse fallback: click to resume

  const c = { x: innerWidth / 2, y: innerHeight / 2, vx: 0, vy: 0, paused: true, dragging: false, visible: true, head: {} };
  let hovered = null;
  let dragEnabled = true; // false when the server runs single-raise-only (no --double)
  let dwellStart = null;
  let last = performance.now();
  // Click lock: raising the eyebrows nudges the head (and so the cursor) up, so a click is hit-tested
  // where the cursor was just before the raise began, not where it is when the click arrives.
  const history = []; // { t, x, y } for the last ~2 s (double mode clicks arrive ~0.8 s after the raise)
  function lockedPosition(e) {
    return positionAt(history, performance.now() - lockLookbackMs(e)) ?? { x: c.x, y: c.y };
  }

  function setPaused(paused) {
    c.paused = paused;
    c.dragging = false;
    dwellStart = null;
    history.length = 0; // positions from before a pause don't count
    if (!paused) {
      c.x = innerWidth / 2; c.y = innerHeight / 2; c.vx = c.vy = 0;
      api.send({ cmd: "zero" });
    }
    document.body.classList.toggle("is-paused", paused);
    onPauseChange(paused);
  }

  function flash(kind) {
    el.classList.remove("flash", "flash-drag");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(kind === "drag_toggle" ? "flash-drag" : "flash");
  }

  function handleEvent(e) {
    if (e.type !== "click" && e.type !== "drag_toggle") return;
    if (e.type === "drag_toggle" && !dragEnabled) return;
    beep(e.type === "click" ? 660 : 880);
    if (c.paused) return setPaused(false);
    flash(e.type);
    if (e.type === "drag_toggle") { c.dragging = !c.dragging; return; }
    if (c.dragging) { c.dragging = false; return; } // a single raise releases a drag
    if (!c.visible) return;
    const { x, y } = lockedPosition(e);
    const target = document.elementFromPoint(x, y);
    const button = target?.closest("button");
    if (button && !button.disabled) button.click();
    else onClick(x, y, target);
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const active = !c.paused && c.visible;
    if (active) {
      const [hx, hy] = headXY(c.head);
      const clamp = (v) => Math.max(-settings.maxSpeed, Math.min(settings.maxSpeed, v));
      const tx = clamp(deadzone(hx, settings.deadzone) * settings.speed);
      const ty = clamp(deadzone(hy, settings.deadzone) * settings.speed);
      c.vx = 0.6 * c.vx + 0.4 * tx;
      c.vy = 0.6 * c.vy + 0.4 * ty;
      const nx = Math.max(0, Math.min(innerWidth - 1, c.x + c.vx * dt));
      const ny = Math.max(0, Math.min(innerHeight - 1, c.y + c.vy * dt));
      if (c.dragging) onDrag(nx - c.x, ny - c.y);
      c.x = nx; c.y = ny;
      history.push({ t: now, x: c.x, y: c.y });
      while (history.length && now - history[0].t > 2000) history.shift();

      const button = document.elementFromPoint(c.x, c.y)?.closest("button");
      if (button !== hovered) { hovered?.classList.remove("head-hover"); button?.classList.add("head-hover"); hovered = button; }

      const r = corner.getBoundingClientRect();
      const inCorner = c.x >= r.left && c.y <= r.bottom;
      dwellStart = inCorner ? (dwellStart ?? now) : null;
      const progress = dwellStart ? Math.min(1, (now - dwellStart) / DWELL_MS) : 0;
      corner.style.setProperty("--p", progress);
      if (progress >= 1) setPaused(true);
    } else if (hovered) { hovered.classList.remove("head-hover"); hovered = null; }
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    el.classList.toggle("hidden", !active);
    el.classList.toggle("dragging", c.dragging);
    corner.classList.toggle("hidden", !active);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, select, textarea")) return;
    if (e.code === "Space" || e.code === "Escape") { e.preventDefault(); setPaused(!c.paused); }
  });

  return {
    handleEvent,
    setHead(state) { c.head = state; },
    setVisible(v) { c.visible = v; },
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    get paused() { return c.paused; },
    get dragging() { return c.dragging; },
    get position() { return { x: c.x, y: c.y }; },
    lockedPosition,
    stopDrag() { c.dragging = false; },
    setDragEnabled(v) { dragEnabled = v; if (!v) c.dragging = false; },
  };
}
