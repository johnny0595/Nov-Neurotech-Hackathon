import { beep, connect, createCursor, deadzone, headXY, saveSettings, settings } from "./input.js";
import { createMeter } from "./meter.js";
import { currentRegion, panoRequest } from "./regions.js";
import { speak } from "./speech.js";
import { applyStrings, t } from "./strings.js";
import { timing } from "./timing.js";

const ROUNDS = 5;
// Guessing can't be undone, so a head guess takes two raises: the first drops (or arms) the pin, the
// second, within CONFIRM_PX of it, locks it in. With a lock-in cancel time set (timing.js), wandering
// further away for that long cancels; the delay ignores the upward nudge a raise itself gives the head.
// With timing off, nothing cancels on a timer: the lock-in stays until the pin is dropped elsewhere or
// the player presses Look. Auto-advance and the hint delay also come from timing.js.
const CONFIRM_PX = 60;
const STILL_ZERO_MS = 3000; // auto re-zero after this long still and centred on a screen with nothing to do
const STILL_DPS = 5;
const STICK_MAX_DEG = 15; // the look-screen stick's outer ring
const SINGLE_BAND_TOP = 0.75; // single-input Street View: the bottom 25% holds Walk / Map / Pause
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const region = currentRegion();
const params = new URLSearchParams(location.search);
// Look-screen pill: what a raise does in Street View (walking needs double raises, the default)
const lookHintHtml = () => t(singleInput() ? "look.pill.single" : "look.pill.double");

const game = {
  mode: "start", round: 0, total: 0, answer: null, guess: null, pov: { heading: 0, pitch: 0 },
  used: new Set(), doubleEnabled: true, lookSeconds: 0,
};
// Helper summary counters (front-end only). shownAt: when the current screen appeared, cleared by the
// first click on it, so "time to click" is measured once per screen.
const stats = { raises: 0, gated: 0, clicks: 0, clickTimes: [], rounds: 0, autoZeros: 0, shownAt: null };
let resultSeconds = 0;
let stillSince = null;
let zeroedWhileStill = false;
let pano = null;
let svService = null;
let guessMarker = null;
let resultLayer = null;
let armed = null; // null | { kind: "pin" | "button", farSince: ms | null, ring? }
let head = {};

// ---------- eyebrow meters (big on the start screen, small in a corner during the game) ----------
const meters = [createMeter($("start-meter")), createMeter($("corner-meter"), { compact: true })];

// ---------- input ----------
const api = connect({
  onState(state) {
    head = state;
    cursor.setHead(state);
    if ("double_enabled" in state && state.double_enabled !== game.doubleEnabled) setDoubleEnabled(state.double_enabled);
    $("status").textContent = state.status === "live" ? "" : state.status ?? "";
    for (const m of meters) m.update(state);
  },
  switchKeys: true, // keyboard-switch input: Space / Enter = click
  onEvent(e) {
    if (e.type === "raise" || e.type === "gated_raise") {
      if (e.type === "raise") {
        stats.raises += 1;
        for (const m of meters) m.flash();
      } else stats.gated += 1;
      cursor.handleEvent(e); // beep + "Raise seen ✓" / "Hold still, then raise"
      return;
    }
    if (e.type === "click") {
      stats.clicks += 1;
      if (!cursor.paused && stats.shownAt !== null && game.mode !== "start") {
        stats.clickTimes.push(performance.now() - stats.shownAt);
        stats.shownAt = null;
      }
    }
    // RESULT: a click on empty space means "Next" (no aiming needed); a click on a button (Next, Pause)
    // presses that button.
    if (game.mode === "result" && !cursor.paused && e.type === "click") {
      const { x, y } = cursor.lockedPosition(e);
      if (!document.elementFromPoint(x, y)?.closest("button")) return $("next").click();
    }
    // LOOK: the head steers the camera. With double raises (the default): a single raise walks forward
    // along the road in view, a double raise opens the map. With one kind of click only (single input),
    // the bottom band's tiles (Walk / Map / Pause) take the clicks instead; see applyLookLayout().
    if (game.mode === "look" && !cursor.paused && !singleInput()) {
      if (e.type === "click") return walkForward();
      if (e.type === "drag_toggle") { beep(880); return showGuess(); }
    }
    cursor.handleEvent(e);
  },
});
const cursor = createCursor({
  api,
  onClick(x, y, target) {
    if (game.mode === "start") return startGame(); // a click anywhere but a button starts
    if (game.mode === "look" && target === null) return flashHint(t("single.tiltDown")); // clicked above the band
    if (game.mode !== "guess" || !target?.closest("#map")) return;
    // (x, y) is the click-lock position: where the cursor was just before the raise began
    if (armed?.kind === "pin" && pinDistance(x, y) <= CONFIRM_PX) return submitGuess();
    const rect = $("map").getBoundingClientRect();
    placePin(map.containerPointToLatLng(L.point(x - rect.left, y - rect.top)));
    arm("pin");
  },
  onDrag(dx, dy) {
    if (game.mode === "guess") map.panBy([-dx, -dy], { animate: false });
  },
  labelAt(x, y, target) {
    if (game.mode !== "guess" || !target.closest("#map")) return "";
    if (armed?.kind === "pin") return t(pinDistance(x, y) <= CONFIRM_PX ? "guess.confirm.label" : "guess.movePin");
    return t("guess.dropPin");
  },
  onHoverLabel(text) {
    speak(text);
  },
  onPauseChange(paused) {
    if (!paused && stats.shownAt !== null) stats.shownAt = performance.now(); // time spent paused doesn't count
  },
});

// ---------- guess map (Leaflet + OpenStreetMap, free) ----------
const map = L.map("map", {
  zoomControl: false, ...region.mapOptions,
  zoomAnimation: !reduceMotion, fadeAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion,
}).setView(region.view.center, region.view.zoom);
// The result view needs room for padding around the guess line, which maxBounds/minZoom would fight,
// so the bounds are lifted while the result card is up and restored for the next round.
function lockMap(locked) {
  map.setMinZoom(locked ? region.mapOptions.minZoom ?? 0 : 0);
  map.setMaxBounds(locked ? region.mapOptions.maxBounds ?? null : null);
}
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
map.on("click", (e) => game.mode === "guess" && placePin(e.latlng)); // plain mouse works too, for helpers

function placePin(latlng) {
  disarm();
  game.guess = latlng;
  guessMarker ??= L.marker(latlng).addTo(map);
  guessMarker.setLatLng(latlng);
  $("submit-guess").disabled = false;
}

function pinDistance(x, y) {
  if (!game.guess) return Infinity;
  const rect = $("map").getBoundingClientRect();
  const p = map.latLngToContainerPoint(game.guess);
  return Math.hypot(x - (rect.left + p.x), y - (rect.top + p.y));
}

function arm(kind) {
  disarm();
  armed = { kind, farSince: null };
  if (kind === "pin") {
    armed.ring = L.circleMarker(game.guess, { radius: CONFIRM_PX, className: "confirm-ring", interactive: false }).addTo(map);
    guessMarker.bindTooltip(t("guess.confirmTip"), { permanent: true, direction: "top", offset: [-15, -42], className: "confirm-tip" }).openTooltip();
  } else {
    $("submit-guess").classList.add("confirming");
    $("submit-guess").textContent = t("guess.confirm");
    $("submit-guess").dataset.raiseLabel = t("guess.confirm.label");
  }
}

function resetSubmitButton() {
  $("submit-guess").classList.remove("confirming");
  $("submit-guess").textContent = t("guess.submit");
  $("submit-guess").dataset.raiseLabel = t("guess.submit.label");
}

function disarm() {
  if (!armed) return;
  armed.ring?.remove();
  guessMarker?.unbindTooltip();
  resetSubmitButton();
  armed = null;
}

// Cancel a pending lock-in once the cursor has stayed away from the pin (or the button) for a moment.
function checkArmed(now) {
  if (!armed) return;
  if (game.mode !== "guess") return disarm();
  const { x, y } = cursor.position;
  let away;
  if (armed.kind === "pin") away = pinDistance(x, y) > CONFIRM_PX;
  else {
    const r = $("submit-guess").getBoundingClientRect();
    away = x < r.left - 20 || x > r.right + 20 || y < r.top - 20 || y > r.bottom + 20;
  }
  armed.farSince = away ? (armed.farSince ?? now) : null;
  const cancelMs = timing().lockCancelS * 1000; // 0 = never on a timer
  if (cancelMs > 0 && armed.farSince !== null && now - armed.farSince > cancelMs) disarm();
}

// ---------- screens: start → (look ⇄ guess → result) × ROUNDS → final ----------
function setDoubleEnabled(enabled) {
  game.doubleEnabled = enabled;
  cursor.setDragEnabled(enabled);
  refreshText();
  applyLookLayout();
}

/** One reliable click and nothing else (no double raise, or a keyboard switch): Street View uses the tile band. */
function singleInput() {
  return !game.doubleEnabled || settings.input === "keyboard-switch";
}

// Street View layout: double raises use the walk/map gestures; single input uses the bottom tile band,
// with the cursor alive only in that band (above it, the head turns the camera).
function applyLookLayout() {
  const single = singleInput();
  document.body.classList.toggle("single-mode", single);
  $("single-band").hidden = !single;
  const look = game.mode === "look";
  cursor.setVisible(game.mode !== "look" || single);
  cursor.setBand(look && single ? SINGLE_BAND_TOP : null);
}

let lastInstruction = "";
let instructionHeldUntil = 0; // a notice (e.g. "tilt down first") stays up this long before the normal line returns
function updateSingleInstruction() {
  if (game.mode !== "look" || !singleInput() || performance.now() < instructionHeldUntil) return;
  const text = t(cursor.inBand ? "single.choose" : "single.look");
  if (text !== lastInstruction) { lastInstruction = text; $("single-instruction").textContent = text; }
}

// All dynamic text, re-rendered when the tone or the input changes.
function refreshText() {
  applyStrings();
  $("start-meter").hidden = settings.input === "keyboard-switch";
  $("guess-hint").innerHTML = t(singleInput() ? "guess.hint.single" : "guess.hint.double");
  if (!$("look-hint").classList.contains("notice")) $("look-hint").innerHTML = lookHintHtml();
  if (!armed) resetSubmitButton();
  $("round").textContent = t("top.round", { n: Math.max(1, game.round), total: ROUNDS });
  $("speech").textContent = t("start.speech", { state: t(settings.speechOn ? "on" : "off") });
  $("speech").setAttribute("aria-pressed", String(Boolean(settings.speechOn)));
  $("score").textContent = t("top.points", { points: game.total.toLocaleString() });
}
addEventListener("settings-changed", () => { refreshText(); applyLookLayout(); });

function show(mode) {
  if (mode !== "guess") disarm();
  if (mode !== game.mode) {
    cursor.stopDrag(); // never carry a map grab into another screen
    stats.shownAt = performance.now();
  }
  game.mode = mode;
  const onMap = mode === "guess" || mode === "result";
  $("start").hidden = mode !== "start";
  $("look").hidden = mode !== "look";
  $("guess").hidden = !onMap;
  $("result").hidden = mode !== "result";
  $("final").hidden = mode !== "final";
  document.querySelectorAll("#guess .action-row, #guess .hint, #guess .top-band").forEach((el) => (el.hidden = mode !== "guess"));
  document.body.classList.toggle("at-start", mode === "start");
  $("corner-meter").hidden = mode === "start" || settings.input === "keyboard-switch"; // no EMG to show
  applyLookLayout();
  if (onMap) map.invalidateSize();
}

function showGuess() {
  show("guess");
}

async function startGame() {
  if (loadingRound) return; // a second raise while the first round loads
  if (cursor.paused) cursor.resume(); // re-zeroes the head's neutral pose
  else api.send({ cmd: "zero" });
  game.round = 0;
  game.total = 0;
  Object.assign(stats, { raises: 0, gated: 0, clicks: 0, clickTimes: [], rounds: 0, autoZeros: 0, shownAt: null });
  $("score").textContent = t("top.points", { points: 0 });
  $("helper-panel").hidden = true;
  await newRound();
}

$("play").onclick = startGame;
$("speech").onclick = () => {
  settings.speechOn = !settings.speechOn;
  saveSettings();
  speak(t("start.speech", { state: t(settings.speechOn ? "on" : "off") }), { force: true }); // confirm either way
};
$("tone").onclick = () => {
  settings.tone = settings.tone === "playful" ? "plain" : "playful";
  saveSettings(); // fires settings-changed, which re-renders every string
};

// Walk to the next Street View photo along the road you're facing.
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const MAX_WALK_ANGLE = 40; // the road must be on screen, roughly where you're looking
let hintTimer = null;
function flashHint(html) {
  speak(html);
  if (singleInput()) { // one instruction at a time: the band's own line shows it
    lastInstruction = "";
    instructionHeldUntil = performance.now() + 2500;
    $("single-instruction").innerHTML = html;
    return;
  }
  const hint = $("look-hint");
  hint.innerHTML = html;
  hint.classList.add("notice");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.innerHTML = lookHintHtml(); hint.classList.remove("notice"); }, 2500);
}
/** The road link closest to where you're looking, and its signed angle from the view centre (+ = right). */
function nearestLink() {
  const links = (pano?.getLinks() || []).filter((l) => l?.pano);
  if (!links.length) return null;
  const best = links.reduce((a, b) => (angleBetween(b.heading, game.pov.heading) < angleBetween(a.heading, game.pov.heading) ? b : a));
  const signed = ((best.heading - game.pov.heading + 540) % 360) - 180;
  return { link: best, signed, walkable: Math.abs(signed) <= MAX_WALK_ANGLE };
}
function walkForward() {
  if (!pano) return;
  const near = nearestLink();
  if (!near) return flashHint(t("look.noRoad"));
  if (!near.walkable) return flashHint(t("look.turnToRoad"));
  pano.setPano(near.link.pano);
}

// Shows where a raise will walk to: a green arrow on the road ahead, or an edge hint
// pointing to the nearest road when none is in front of you.
function drawWalkMarker() {
  // only with double raises (walking), and only when this round has a panorama
  const show = pano && game.mode === "look" && !cursor.paused && $("pano").style.visibility !== "hidden";
  $("aim").hidden = !show;
  const near = show ? nearestLink() : null;
  $("walk-marker").hidden = !near?.walkable;
  $("road-edge").hidden = !near || near.walkable;
  if (!near) return;
  if (near.walkable) {
    const w = $("look").clientWidth;
    const fov = 180 / 2 ** (pano.getZoom() ?? 1); // Street View's horizontal field of view
    const f = w / 2 / Math.tan((fov / 2) * Math.PI / 180);
    const x = w / 2 + f * Math.tan(near.signed * Math.PI / 180);
    $("walk-marker").style.left = `${Math.max(60, Math.min(w - 60, x))}px`;
    $("walk-marker").style.rotate = `${near.signed * 0.5}deg`; // lean toward the road's direction
  } else {
    const right = near.signed > 0;
    $("road-edge").className = `road-edge ${right ? "right" : "left"}`;
    $("road-edge").textContent = t(right ? "look.roadRight" : "look.roadLeft");
  }
}

$("look-again").onclick = () => show("look");
$("to-map").onclick = showGuess; // mouse fallback for "raise to go to the map"
$("tile-walk").onclick = () => walkForward();
$("tile-map").onclick = showGuess;
$("tile-pause").onclick = () => cursor.pause();
$("zoom-in").onclick = () => map.zoomIn();
$("zoom-out").onclick = () => map.zoomOut();
// A helper's mouse click guesses straight away; a head raise needs a second raise to lock it in.
$("submit-guess").onclick = () => {
  if (!game.guess) return;
  if (cursor.headClicking && armed?.kind !== "button") return arm("button");
  submitGuess();
};

function submitGuess() {
  if (!game.guess || game.mode !== "guess") return;
  disarm();
  const meters = map.distance(game.guess, game.answer);
  const { points, stars } = region.score(meters);
  game.total += points;
  stats.rounds += 1;
  const cheer = t("result.cheer")[stars - 1];

  resultLayer = L.layerGroup([
    L.circleMarker(game.answer, { radius: 12, color: "#1b1f3b", fillColor: "#2ec4b6", fillOpacity: 1 }),
    L.polyline([game.guess, game.answer], { color: "#ff6b6b", weight: 5, dashArray: "10 8" }),
  ]).addTo(map);
  $("stars").textContent = "⭐".repeat(stars) + "☆".repeat(5 - stars);
  $("result-title").textContent = cheer;
  $("result-place").textContent = game.answer.name;
  $("result-distance").textContent = region.formatDistance(meters);
  $("result-points").textContent = `+${points.toLocaleString()}`;
  $("result-fact").textContent = game.answer.fact ?? "";
  $("result-fact").hidden = !game.answer.fact;
  $("next-text").textContent = t(game.round >= ROUNDS ? "result.seeScore" : "result.next");
  resultSeconds = 0;
  $("score").textContent = t("top.points", { points: game.total.toLocaleString() });
  show("result");
  speak(t("say.result", { place: game.answer.name, distance: region.formatDistance(meters), points: points.toLocaleString(), fact: game.answer.fact ?? "" }));

  // Fit guess + answer into the map area above the result card (measured, so small screens work too).
  const cardTop = $("result").querySelector(".card").getBoundingClientRect().top;
  const bottom = Math.max(40, Math.min(innerHeight - cardTop + 24, innerHeight - 100 - 120));
  lockMap(false);
  map.fitBounds(L.latLngBounds([game.guess, game.answer]), {
    paddingTopLeft: [80, 100], paddingBottomRight: [80, bottom], maxZoom: region.resultMaxZoom,
  });
}
$("next").onclick = () => (game.round >= ROUNDS ? showFinal() : newRound());
$("play-again").onclick = startGame;
$("helper-toggle").onclick = () => {
  $("helper-panel").hidden = !$("helper-panel").hidden;
  $("helper-toggle").setAttribute("aria-expanded", String(!$("helper-panel").hidden));
};

function showFinal() {
  $("final-score").textContent = t("final.score", { points: game.total.toLocaleString() });
  $("final-detail").textContent = t(`final.finale.${region.id}`);
  const avg = stats.clickTimes.length ? stats.clickTimes.reduce((a, b) => a + b, 0) / stats.clickTimes.length / 1000 : null;
  $("helper-stats").innerHTML = [
    [t("stats.raises"), stats.raises],
    [t("stats.perRound"), stats.rounds ? (stats.raises / stats.rounds).toFixed(1) : "–"],
    [t("stats.gated"), stats.gated],
    [t("stats.clicks"), stats.clicks],
    [t("stats.time"), avg === null ? "–" : `${avg.toFixed(1)} s`],
    [t("stats.rounds"), stats.rounds],
    [t("stats.autoZeros"), stats.autoZeros],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("helper-panel").hidden = true;
  $("helper-toggle").setAttribute("aria-expanded", "false");
  show("final");
  speak(t("say.final", { points: game.total.toLocaleString() }));
}

// ---------- rounds + Street View ----------
async function pickLocation() {
  const LOCATIONS = region.locations;
  if (LOCATIONS.filter((l) => !game.used.has(l.name)).length < ROUNDS) game.used.clear();
  const pool = LOCATIONS.filter((l) => !game.used.has(l.name));
  while (true) {
    const loc = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] ?? LOCATIONS[0];
    game.used.add(loc.name);
    if (!svService) return { ...loc, panoId: null };
    try {
      const { data } = await svService.getPanorama(panoRequest(loc, region.snapRadius));
      const p = data.location.latLng;
      return { ...loc, lat: p.lat(), lng: p.lng(), panoId: data.location.pano };
    } catch (err) {
      // No coverage here: try another place. Anything else (quota, network) would fail for every place,
      // so stop now instead of spending a lookup per location.
      const noCoverage = err?.code === "ZERO_RESULTS" || /ZERO_RESULTS/.test(String(err?.message ?? err));
      if (!noCoverage) console.warn("[street view]", err);
      if (!noCoverage || !pool.length) return { ...loc, panoId: null }; // still playable from the hint
    }
  }
}

// Only one round loads at a time: picking a panorama takes a moment, and a second raise (or click) on
// "Next" meanwhile used to start a second round and skip one.
let loadingRound = false;
const loadButtons = ["play", "next", "play-again"];
async function newRound() {
  if (loadingRound) return;
  loadingRound = true;
  for (const id of loadButtons) $(id).disabled = true;
  try {
    await loadRound();
  } finally {
    loadingRound = false;
    for (const id of loadButtons) $(id).disabled = false;
  }
}

async function loadRound() {
  game.round += 1;
  disarm();
  game.guess = null;
  game.lookSeconds = 0;
  $("loc-hint").hidden = true;
  $("round").textContent = t("top.round", { n: game.round, total: ROUNDS });
  $("submit-guess").disabled = true;
  guessMarker?.remove(); guessMarker = null;
  resultLayer?.remove(); resultLayer = null;
  lockMap(true);
  map.setView(region.view.center, region.view.zoom);
  await mapsReady; // Street View must be ready before picking a panorama
  game.answer = await pickLocation();
  game.answer = Object.assign(L.latLng(game.answer.lat, game.answer.lng), game.answer);
  game.pov = { heading: Math.random() * 360, pitch: 0 };
  const hasPano = Boolean(pano && game.answer.panoId);
  if (hasPano) {
    pano.setPano(game.answer.panoId);
    pano.setPov(game.pov);
    pano.setZoom(1); // undo any mouse zoom from the last round
  }
  // Never leave last round's panorama up for a different answer. Without a picture, the hint is the clue.
  $("pano").style.visibility = hasPano ? "" : "hidden";
  $("pano-none").hidden = !pano || hasPano;
  $("loc-hint-text").textContent = game.answer.hint ?? "";
  if (!hasPano) game.lookSeconds = Infinity; // nothing to look at: show the hint straight away
  show("look");
}

// Mouse fallback: anyone with a mouse can explore Street View directly (drag to look around, scroll to
// zoom, click the arrows to walk). While the mouse is in use, and for a few seconds after, the head
// doesn't steer, so the two never fight over the camera.
const MANUAL_HOLD_MS = 4000;
let manualUntil = 0;
const markManual = () => { manualUntil = performance.now() + MANUAL_HOLD_MS; };
$("pano").addEventListener("pointerdown", markManual, true);
$("pano").addEventListener("pointermove", (e) => { if (e.buttons) markManual(); }, true);
$("pano").addEventListener("wheel", markManual, { capture: true, passive: true });

// Head steers the camera: tilt = turning speed, like a joystick. Deadzone keeps a still head still.
// It starts from the panorama's current view, so it picks up wherever the mouse left it, and only
// touches the camera while the head is actually tilted.
// The same loop counts time spent looking (not paused) and shows the location's hint after 30 s.
let lastFrame = performance.now();
function steer(now) {
  const elapsed = (now - lastFrame) / 1000;
  const dt = Math.min(0.05, elapsed); // camera step, capped so a hiccup doesn't spin the view
  lastFrame = now;
  checkArmed(now);
  // Result screen: count down to the next round if auto-advance is on (paused time doesn't count).
  const autoS = timing().autoAdvanceS;
  $("next").classList.toggle("countdown", autoS > 0);
  if (autoS > 0 && game.mode === "result" && !cursor.paused && resultSeconds < autoS) {
    resultSeconds += Math.min(1, elapsed);
    $("next").style.setProperty("--p", Math.min(1, resultSeconds / autoS));
    if (resultSeconds >= autoS) $("next").click();
  }
  autoZero(now);
  if (game.mode === "look" && !cursor.paused) {
    game.lookSeconds += Math.min(1, elapsed); // real time, even when frames are slow
    if (game.answer?.hint && game.lookSeconds >= timing().hintDelayS && $("loc-hint").hidden) {
      $("loc-hint").hidden = false;
      speak(t("say.hint", { hint: game.answer.hint }));
    }
    const [x, y] = headXY(head);
    const dx = deadzone(x, settings.deadzone);
    const dy = deadzone(y, settings.deadzone);
    // single input: the bottom band is for choosing, so tilting down doesn't pitch the camera, and
    // the camera holds still while the cursor is in the band
    const single = singleInput();
    const camDy = single ? Math.min(0, dy) : dy;
    updateLookGuide(x, y, dx, dy);
    updateSingleInstruction();
    if (pano && (dx || camDy) && now > manualUntil && !(single && cursor.inBand)) {
      const current = pano.getPov();
      const pitch = current.pitch - camDy * settings.lookSpeed * 0.5 * dt;
      game.pov = {
        heading: (current.heading + dx * settings.lookSpeed * dt + 360) % 360,
        // the head can't tilt past ±35°, but a mouse view beyond that isn't snapped back either
        pitch: Math.abs(pitch) <= 35 || Math.abs(pitch) < Math.abs(current.pitch) ? pitch : current.pitch,
      };
      pano.setPov(game.pov);
    }
  }
  drawWalkMarker();
  requestAnimationFrame(steer);
}

// Look-screen guidance: the stick shows the head's tilt against the dead zone; each edge chevron glows
// in proportion to how fast the view is turning that way.
const stick = $("look-stick");
const chevrons = { left: document.querySelector(".chev-left"), right: document.querySelector(".chev-right"),
  up: document.querySelector(".chev-up"), down: document.querySelector(".chev-down") };
function updateLookGuide(x, y, dx, dy) {
  const radius = stick.clientWidth / 2 - 5;
  const len = Math.hypot(x, y) || 1;
  const k = Math.min(1, len / STICK_MAX_DEG) * radius / len;
  stick.querySelector(".stick-dot").style.translate = `${x * k}px ${y * k}px`;
  stick.style.setProperty("--dz", Math.min(1, settings.deadzone / STICK_MAX_DEG).toFixed(3));
  stick.classList.toggle("turning", Boolean(dx || dy));
  const glow = (v) => Math.min(1, Math.max(0, v) / 6).toFixed(2); // full glow at 6° past the dead zone
  chevrons.left.style.opacity = glow(-dx);
  chevrons.right.style.opacity = glow(dx);
  chevrons.up.style.opacity = glow(-dy);
  chevrons.down.style.opacity = glow(dy);
}

// Drift fix: on a screen with nothing to aim at (start, result), a head that has been centred and still
// for 3 s is quietly re-zeroed, once per still spell.
function autoZero(now) {
  const calm = game.mode === "start" || game.mode === "result";
  const [x, y] = headXY(head);
  const still = calm && Math.abs(x) <= settings.deadzone && Math.abs(y) <= settings.deadzone && (head.gyro_dps ?? Infinity) < STILL_DPS;
  if (!still) { stillSince = null; zeroedWhileStill = false; return; }
  stillSince ??= now;
  if (!zeroedWhileStill && now - stillSince >= STILL_ZERO_MS) {
    zeroedWhileStill = true;
    stats.autoZeros += 1;
    api.send({ cmd: "zero" });
  }
}

async function loadGoogleMaps() {
  const { mapsKey } = await fetch("/config").then((r) => r.json()).catch(() => ({}));
  if (!mapsKey) return false;
  await new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&v=weekly&loading=async&callback=__mapsReady`;
    s.onerror = reject;
    document.head.append(s);
  });
  svService = new google.maps.StreetViewService();
  pano = makePano();
  return true;
}

function makePano() {
  panoSize = { w: $("pano").clientWidth, h: $("pano").clientHeight };
  return new google.maps.StreetViewPanorama($("pano"), {
    // No address or road names (they'd give the answer away). Walking arrows, click-to-go and scroll
    // zoom are on for the mouse fallback; the head cursor is hidden on this screen, so head play is unchanged.
    disableDefaultUI: true, addressControl: false, showRoadLabels: false, linksControl: true,
    clickToGo: true, motionTracking: false, motionTrackingControl: false, scrollwheel: true,
  });
}

// Maximizing or resizing the window: Street View and Leaflet keep their old canvas size (the view
// looks zoomed in) until they're told to re-measure.
let resizeTimer = null;
let panoSize = { w: 0, h: 0 };
function refit() {
  const { clientWidth: w, clientHeight: h } = $("pano");
  if (pano && w && h && (w !== panoSize.w || h !== panoSize.h)) {
    // The Maps "resize" event left Street View's canvas at its old size (zoomed-in look), so
    // rebuild the panorama at the new size, on the same photo, facing the same way.
    const id = pano.getPano();
    const pov = pano.getPov();
    const zoom = pano.getZoom();
    $("pano").replaceChildren();
    pano = makePano();
    if (id) pano.setPano(id);
    pano.setPov(pov);
    if (zoom !== undefined) pano.setZoom(zoom);
  }
  map.invalidateSize();
}
const scheduleRefit = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refit, 300); };
addEventListener("resize", scheduleRefit);
new ResizeObserver(scheduleRefit).observe($("pano")); // also catches size changes with no window resize event
setInterval(() => { // backstop: some window managers maximize without either notification
  const { clientWidth: w, clientHeight: h } = $("pano");
  if (pano && w && h && (w !== panoSize.w || h !== panoSize.h)) scheduleRefit();
}, 1000);

const mapsReady = loadGoogleMaps().catch(() => false);
refreshText();
show("start");
cursor.resume(); // the start screen is live: point at a button, or click anywhere else to start
requestAnimationFrame(steer);
const hasMaps = await mapsReady;
$("pano-missing").hidden = hasMaps;
if (params.has("checklocs")) {
  if (hasMaps) import("./checklocs.js").then((m) => m.checkLocations(region.locations, 150));
  else console.warn("[checklocs] needs GOOGLE_MAPS_API_KEY in .env");
}
