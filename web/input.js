// Head + eyebrow input shared by the game and the calibration page.
import { OneEuro, gainsFromRange, lockLookbackMs, magnetize, pointTarget, positionAt } from "./pointer.js";
import { saveSettings, settings } from "./settings.js";
import { t } from "./strings.js";
import { timing } from "./timing.js";

export { saveSettings, settings };

// Live: head angles and eyebrow events stream from the Python server over /ws.
// Mock (?mock=1): mouse position stands in for head tilt, C = eyebrow click (a 0.3 s raise), D = double raise.
// Like the server, mock has double raises on (D = walk-mode "open the map" / grab the map); add &single=1 to turn
// them off, like the server's --single.
// G = a raise the server ignored because the head was moving (gated_raise).

const MAGNET_RADIUS = 80;
const MOCK_RANGE = { left: 20, right: 20, down: 20, up: 20 }; // mock maps the window edges to ±20°

export const mock = new URLSearchParams(location.search).has("mock");

/** Cursor gains in px/degree for "point" mode, or null to use the joystick. */
export function pointGains() {
  if (settings.cursorMode !== "point") return null;
  return gainsFromRange(settings.range ?? (mock ? MOCK_RANGE : null), innerWidth, innerHeight);
}

/** Head tilt in degrees as [x, y]; right and down are positive. */
export function headXY(state) {
  if (mock) return [state.roll || 0, state.pitch || 0];
  // Learned axes from the setup page's "Learn my head movements" (server/head_axes.py) beat the manual axis settings.
  if (state.hx !== undefined) return [state.hx, state.hy];
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
    const double_enabled = !new URLSearchParams(location.search).has("single");
    const fake = { roll: 0, pitch: 0, yaw: 0, status: `mock (mouse + C${double_enabled ? "/D" : ""} keys)`, envelope: 3, threshold: 10, rate_hz: 0, double_enabled, gyro_dps: 0 };
    let prevTilt = [0, 0];
    addEventListener("mousemove", (e) => {
      fake.roll = ((e.clientX - innerWidth / 2) / (innerWidth / 2)) * 20;
      fake.pitch = ((e.clientY - innerHeight / 2) / (innerHeight / 2)) * 20;
      fake.yaw = fake.roll;
    });
    addEventListener("keydown", (e) => {
      if (e.target.closest?.("input, select, textarea")) return;
      if (e.key === "c") { fake.envelope = 24; onEvent({ type: "raise", duration_s: 0.3 }); onEvent({ type: "click", duration_s: 0.3, delay_s: 0 }); }
      if (e.key === "g") { fake.envelope = 24; onEvent({ type: "gated_raise", duration_s: 0.3 }); }
      if (e.key === "d" && double_enabled) { fake.envelope = 24; onEvent({ type: "raise" }); onEvent({ type: "raise" }); onEvent({ type: "drag_toggle" }); }
    });
    setInterval(() => {
      fake.envelope = 3 + (fake.envelope - 3) * 0.9 + Math.random() * 0.6; // fake EMG: decays back to rest
      // fake gyro: how fast the mouse "head" is turning, in deg/s (mouse still = head still)
      fake.gyro_dps = Math.round(Math.hypot(fake.roll - prevTilt[0], fake.pitch - prevTilt[1]) * 60 * 10) / 10;
      prevTilt = [fake.roll, fake.pitch];
      onState({ ...fake, envelope: Math.round(fake.envelope * 100) / 100 });
    }, 1000 / 60);
    api.connected = true;
    api.send = (msg) => console.debug(`[mock] send ${JSON.stringify(msg)}`); // e.g. { cmd: "zero" } from auto re-zero
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
export function beep(freq = 660, ms = 90, volume = 0.15) {
  if (!audio || audio.state !== "running") return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + ms / 1000);
}

export const NO_CLICK_TOP = 0.12; // top 12% of the screen: looking up makes people raise their brows

/**
 * On-page cursor driven by head tilt. It never touches the OS pointer, so it cannot escape the page.
 * Pause: Space/Esc (helper), a click on the bottom-left "Pause" tile, or (if timing allows) holding the
 * cursor on it for the dwell time. Any eyebrow raise resumes.
 * Head clicks in the top 12% of the screen are ignored (looking up causes involuntary raises).
 * Resuming recenters the cursor and re-zeros the head's neutral pose.
 */
export function createCursor({ api, onClick = () => {}, onDrag = () => {}, onPauseChange = () => {}, labelAt = () => "", onHoverLabel = () => {} }) {
  const el = document.createElement("div");
  el.className = "head-cursor";
  const corner = document.createElement("button"); // a real button: one click pauses, even with dwell off
  corner.className = "pause-tile";
  corner.type = "button";
  corner.addEventListener("click", () => setPaused(true));
  const overlay = document.createElement("div");
  overlay.className = "pause-overlay";
  function renderText() {
    const dwell = timing().pauseDwellS > 0;
    corner.innerHTML = `<span>⏸</span><b>${t("pauseTile.title")}</b>${dwell ? `<small>${t("pauseTile.hold")}</small>` : ""}`;
    corner.dataset.raiseLabel = t("pauseTile.title");
    overlay.innerHTML = `<div><h1>${t("pause.title")}</h1><p>${t("pause.body")}</p><small>${t("pause.helper")}</small></div>`;
  }
  renderText();
  addEventListener("settings-changed", renderText); // tone or input changed
  // "What will a raise do here?" pill under the cursor: data-raise-label on buttons, or labelAt() from the page
  const label = document.createElement("div");
  label.className = "raise-label hidden";
  // Feedback for every raise: "Raise seen ✓" (accepted) or "Hold still, then raise" (head was moving)
  const badge = document.createElement("div");
  badge.className = "raise-badge hidden";
  badge.setAttribute("role", "status");
  document.body.append(corner, overlay, el, label, badge);
  let badgeTimer = null;
  overlay.addEventListener("click", () => setPaused(false)); // mouse fallback: click to resume

  // x/y: where the head points; sx/sy: shown position after the magnet (used for hit-testing and click lock)
  // bandTop: when set (a fraction of the screen height), the cursor only shows and clicks below that line;
  // above it the page uses the head for something else (single-input Street View turns the camera)
  const c = { x: innerWidth / 2, y: innerHeight / 2, sx: innerWidth / 2, sy: innerHeight / 2, vx: 0, vy: 0, paused: true, dragging: false, visible: true, head: {}, bandTop: null };
  const inBand = (y) => c.bandTop === null || y >= innerHeight * c.bandTop;
  let hovered = null;
  let dragEnabled = true; // false when the server runs single-raise-only (no --double)
  let dwellStart = null;
  let last = performance.now();
  let labelText = ""; // for read-aloud: the label, since when it's been shown, and whether it's been reported
  let labelSince = 0;
  let labelReported = false;
  const smoothX = new OneEuro();
  const smoothY = new OneEuro();
  // Click lock: raising the eyebrows nudges the head (and so the cursor) up, so a click is hit-tested
  // where the cursor was just before the raise began, not where it is when the click arrives.
  const history = []; // { t, x, y } for the last ~2 s (double mode clicks arrive ~0.8 s after the raise)
  function lockedPosition(e) {
    return positionAt(history, performance.now() - lockLookbackMs(e)) ?? { x: c.sx, y: c.sy };
  }

  function setPaused(paused) {
    c.paused = paused;
    c.dragging = false;
    dwellStart = null;
    history.length = 0; // positions from before a pause don't count
    smoothX.reset(); smoothY.reset();
    if (!paused) {
      c.x = c.sx = innerWidth / 2; c.y = c.sy = innerHeight / 2; c.vx = c.vy = 0;
      api.send({ cmd: "zero" });
    }
    document.body.classList.toggle("is-paused", paused);
    onPauseChange(paused);
  }

  function clickableButtons() {
    return [...document.querySelectorAll("button")].filter((b) => !b.disabled && b.offsetParent !== null && !b.closest("#pano"));
  }

  function flash(kind) {
    el.classList.remove("flash", "flash-drag");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(kind === "drag_toggle" ? "flash-drag" : "flash");
  }

  function feedback(kind) {
    const seen = kind === "seen";
    if (seen) beep(660, 90);
    else beep(330, 160, 0.05); // softer, lower: not an error, just "try again"
    badge.textContent = t(seen ? "badge.seen" : "badge.hold");
    badge.className = `raise-badge ${seen ? "seen" : "hold"}`;
    badge.classList.toggle("at-cursor", !c.paused && c.visible);
    // position with `translate` (not `transform`): the pop animation's `scale` would scale a transform offset too
    badge.style.translate = !c.paused && c.visible ? `calc(${c.sx}px - 50%) calc(${c.sy - 64}px - 100%)` : "";
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.add("hidden"), seen ? 600 : 1500);
  }

  function handleEvent(e) {
    if (e.type === "raise") return feedback("seen");
    if (e.type === "gated_raise") return feedback("gated");
    if (e.type !== "click" && e.type !== "drag_toggle") return;
    if (e.type === "drag_toggle" && !dragEnabled) return;
    if (e.type === "drag_toggle") beep(880); // the raise itself already beeped
    if (c.paused) return setPaused(false);
    flash(e.type);
    if (e.type === "drag_toggle") { c.dragging = !c.dragging; return; }
    if (c.dragging) { c.dragging = false; return; } // a single raise releases a drag
    if (!c.visible) return;
    const { x, y } = lockedPosition(e);
    if (!inBand(y)) return onClick(x, y, null); // above the band: the page decides (e.g. "tilt down first")
    if (y < innerHeight * NO_CLICK_TOP) return; // nothing up there is clickable
    const target = document.elementFromPoint(x, y);
    const button = target?.closest("button");
    if (button && !button.disabled) {
      c.headClicking = true; // lets the page tell a head raise from a helper's mouse click
      try { button.click(); } finally { c.headClicking = false; }
    } else onClick(x, y, target);
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const active = !c.paused && c.visible;
    if (active) {
      const [hx, hy] = headXY(c.head);
      const gains = pointGains();
      let nx, ny;
      if (gains) {
        // point: absolute head-mouse position, smoothed (steady when still, quick when moving)
        const target = pointTarget([hx, hy], gains, innerWidth, innerHeight);
        for (const f of [smoothX, smoothY]) { f.minCutoff = settings.oneEuroMinCutoff; f.beta = settings.oneEuroBeta; }
        nx = smoothX.filter(target.x, now / 1000);
        ny = smoothY.filter(target.y, now / 1000);
      } else {
        // joystick: tilt sets the cursor's speed
        const clamp = (v) => Math.max(-settings.maxSpeed, Math.min(settings.maxSpeed, v));
        const tx = clamp(deadzone(hx, settings.deadzone) * settings.speed);
        const ty = clamp(deadzone(hy, settings.deadzone) * settings.speed);
        c.vx = 0.6 * c.vx + 0.4 * tx;
        c.vy = 0.6 * c.vy + 0.4 * ty;
        nx = Math.max(0, Math.min(innerWidth - 1, c.x + c.vx * dt));
        ny = Math.max(0, Math.min(innerHeight - 1, c.y + c.vy * dt));
        smoothX.reset(); smoothY.reset();
      }
      if (c.dragging) onDrag(nx - c.x, ny - c.y);
      c.x = nx; c.y = ny;
      // magnetic targets: ease toward a nearby enabled button (not while dragging the map)
      const targets = c.dragging || !settings.magnet ? [] : clickableButtons();
      const shown = magnetize({ x: c.x, y: c.y }, targets.map((b) => b.getBoundingClientRect()), MAGNET_RADIUS, settings.magnet);
      c.sx = shown.x; c.sy = shown.y;
      history.push({ t: now, x: c.sx, y: c.sy });
      while (history.length && now - history[0].t > 2000) history.shift();

      const under = c.sy < innerHeight * NO_CLICK_TOP || !inBand(c.sy) ? null : document.elementFromPoint(c.sx, c.sy);
      const button = under?.closest("button");
      if (button !== hovered) { hovered?.classList.remove("head-hover"); button?.classList.add("head-hover"); hovered = button; }
      const text = button ? (button.disabled ? "" : button.dataset.raiseLabel ?? "") : under ? labelAt(c.sx, c.sy, under) : "";
      if (label.textContent !== text) label.textContent = text;
      label.classList.toggle("hidden", !text);
      if (text !== labelText) { labelText = text; labelSince = now; labelReported = false; }
      else if (text && !labelReported && now - labelSince >= timing().speechHoverS * 1000) { labelReported = true; onHoverLabel(text); }
      label.style.transform = `translate(${c.sx}px, ${c.sy + 50}px)`;

      const r = corner.getBoundingClientRect();
      const dwellMs = timing().pauseDwellS * 1000; // 0 = no dwell: the tile is clicked like a button
      const inCorner = dwellMs > 0 && inBand(c.sy) && c.sx >= r.left && c.sx <= r.right && c.sy >= r.top && c.sy <= r.bottom;
      dwellStart = inCorner ? (dwellStart ?? now) : null;
      const progress = dwellStart ? Math.min(1, (now - dwellStart) / dwellMs) : 0;
      corner.style.setProperty("--p", progress);
      if (progress >= 1) setPaused(true);
    } else if (hovered) { hovered.classList.remove("head-hover"); hovered = null; }
    if (!active) { label.classList.add("hidden"); labelText = ""; }
    el.style.translate = `${c.sx}px ${c.sy}px`; // not transform: the click "pop" animates scale, which would scale the offset
    el.classList.toggle("hidden", !active || !inBand(c.sy));
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
    /** Show and click only below this fraction of the screen height (null = everywhere). */
    setBand(top) { c.bandTop = top; },
    get inBand() { return !c.paused && c.visible && inBand(c.sy); },
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    get paused() { return c.paused; },
    get dragging() { return c.dragging; },
    get position() { return { x: c.sx, y: c.sy }; },
    get headClicking() { return Boolean(c.headClicking); },
    lockedPosition,
    stopDrag() { c.dragging = false; },
    setDragEnabled(v) { dragEnabled = v; if (!v) c.dragging = false; },
  };
}
