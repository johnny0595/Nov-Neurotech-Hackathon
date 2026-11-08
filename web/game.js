import { connect, createCursor, deadzone, headXY, settings } from "./input.js";
import { createMeter } from "./meter.js";
import { currentRegion, panoRequest } from "./regions.js";

const ROUNDS = 5;
const HINT_AFTER_S = 30;
const $ = (id) => document.getElementById(id);
const region = currentRegion();
const params = new URLSearchParams(location.search);

const game = {
  mode: "start", round: 0, total: 0, answer: null, guess: null, pov: { heading: 0, pitch: 0 },
  used: new Set(), doubleEnabled: true, lookSeconds: 0,
};
// Helper summary counters (front-end only). shownAt: when the current screen appeared, cleared by the
// first click on it, so "time to click" is measured once per screen.
const stats = { raises: 0, clicks: 0, clickTimes: [], rounds: 0, shownAt: null };
let pano = null;
let svService = null;
let guessMarker = null;
let resultLayer = null;
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
  onEvent(e) {
    if (e.type === "raise") {
      stats.raises += 1;
      for (const m of meters) m.flash();
      return;
    }
    if (e.type === "click") {
      stats.clicks += 1;
      if (!cursor.paused && stats.shownAt !== null && game.mode !== "start") {
        stats.clickTimes.push(performance.now() - stats.shownAt);
        stats.shownAt = null;
      }
    }
    // START: any raise begins the game (and zeroes the head, like resuming from pause).
    if (game.mode === "start") {
      if (e.type === "click") startGame();
      return;
    }
    // LOOK: the head steers the camera, so a single raise just means "go to the map".
    // There is nothing to drag there, so a double raise is ignored (it used to leave dragging = true).
    if (game.mode === "look" && !cursor.paused) {
      if (e.type === "click") return showGuess();
      if (e.type === "drag_toggle") return;
    }
    cursor.handleEvent(e);
  },
});
const cursor = createCursor({
  api,
  onClick(x, y, target) {
    if (game.mode !== "guess" || !target?.closest("#map")) return;
    const rect = $("map").getBoundingClientRect();
    placePin(map.containerPointToLatLng(L.point(x - rect.left, y - rect.top)));
  },
  onDrag(dx, dy) {
    if (game.mode === "guess") map.panBy([-dx, -dy], { animate: false });
  },
  labelAt(x, y, target) {
    return game.mode === "guess" && target.closest("#map") ? "Drop pin" : "";
  },
  onPauseChange(paused) {
    if (!paused && stats.shownAt !== null) stats.shownAt = performance.now(); // time spent paused doesn't count
  },
});

// ---------- guess map (Leaflet + OpenStreetMap, free) ----------
const map = L.map("map", { zoomControl: false, ...region.mapOptions }).setView(region.view.center, region.view.zoom);
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
  game.guess = latlng;
  guessMarker ??= L.marker(latlng).addTo(map);
  guessMarker.setLatLng(latlng);
  $("submit-guess").disabled = false;
}

// ---------- screens: start → (look ⇄ guess → result) × ROUNDS → final ----------
function setDoubleEnabled(enabled) {
  game.doubleEnabled = enabled;
  cursor.setDragEnabled(enabled);
  $("guess-hint").innerHTML = enabled
    ? "Raise once = drop pin / press · Raise twice = grab &amp; move the map"
    : "Raise eyebrows = drop pin / press a button";
}

function show(mode) {
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
  $("corner-meter").hidden = mode === "start";
  cursor.setVisible(mode !== "look" && mode !== "start");
  if (onMap) map.invalidateSize();
}

function showGuess() {
  show("guess");
}

async function startGame() {
  if (loadingRound) return; // a second raise while the first round loads
  if (cursor.paused) cursor.resume(); // re-zeroes the head's neutral pose
  game.round = 0;
  game.total = 0;
  Object.assign(stats, { raises: 0, clicks: 0, clickTimes: [], rounds: 0, shownAt: null });
  $("score").textContent = "0 points";
  $("helper-panel").hidden = true;
  await newRound();
}

$("play").onclick = startGame;
$("look-again").onclick = () => show("look");
$("to-map").onclick = showGuess; // mouse fallback for "raise to go to the map"
$("zoom-in").onclick = () => map.zoomIn();
$("zoom-out").onclick = () => map.zoomOut();
$("submit-guess").onclick = () => {
  if (!game.guess) return;
  const meters = map.distance(game.guess, game.answer);
  const { points, stars } = region.score(meters);
  game.total += points;
  stats.rounds += 1;
  const cheer = ["Good try!", "Nice!", "Great job!", "Awesome!", "WOW, amazing!"][stars - 1];

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
  $("next").textContent = game.round >= ROUNDS ? "See my score ▶" : "Next ▶";
  $("score").textContent = `${game.total.toLocaleString()} points`;
  show("result");

  // Fit guess + answer into the map area above the result card (measured, so small screens work too).
  const cardTop = $("result").querySelector(".card").getBoundingClientRect().top;
  const bottom = Math.max(40, Math.min(innerHeight - cardTop + 24, innerHeight - 100 - 120));
  lockMap(false);
  map.fitBounds(L.latLngBounds([game.guess, game.answer]), {
    paddingTopLeft: [80, 100], paddingBottomRight: [80, bottom], maxZoom: region.resultMaxZoom,
  });
};
$("next").onclick = () => (game.round >= ROUNDS ? showFinal() : newRound());
$("play-again").onclick = startGame;
$("helper-toggle").onclick = () => {
  $("helper-panel").hidden = !$("helper-panel").hidden;
  $("helper-toggle").setAttribute("aria-expanded", String(!$("helper-panel").hidden));
};

function showFinal() {
  $("final-score").textContent = `${game.total.toLocaleString()} points!`;
  $("final-detail").textContent = region.finale;
  const avg = stats.clickTimes.length ? stats.clickTimes.reduce((a, b) => a + b, 0) / stats.clickTimes.length / 1000 : null;
  $("helper-stats").innerHTML = [
    ["Raises detected", stats.raises],
    ["Clicks used", stats.clicks],
    ["Average time from screen appearing to click", avg === null ? "–" : `${avg.toFixed(1)} s`],
    ["Rounds", stats.rounds],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("helper-panel").hidden = true;
  $("helper-toggle").setAttribute("aria-expanded", "false");
  show("final");
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
  game.guess = null;
  game.lookSeconds = 0;
  $("loc-hint").hidden = true;
  $("round").textContent = `Round ${game.round} / ${ROUNDS}`;
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
  if (!hasPano) game.lookSeconds = HINT_AFTER_S;
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
  if (game.mode === "look" && !cursor.paused) {
    game.lookSeconds += Math.min(1, elapsed); // real time, even when frames are slow
    if (game.answer?.hint && game.lookSeconds >= HINT_AFTER_S) $("loc-hint").hidden = false;
    const [x, y] = headXY(head);
    const dx = deadzone(x, settings.deadzone);
    const dy = deadzone(y, settings.deadzone);
    if (pano && (dx || dy) && now > manualUntil) {
      const current = pano.getPov();
      const pitch = current.pitch - dy * settings.lookSpeed * 0.5 * dt;
      game.pov = {
        heading: (current.heading + dx * settings.lookSpeed * dt + 360) % 360,
        // the head can't tilt past ±35°, but a mouse view beyond that isn't snapped back either
        pitch: Math.abs(pitch) <= 35 || Math.abs(pitch) < Math.abs(current.pitch) ? pitch : current.pitch,
      };
      pano.setPov(game.pov);
    }
  }
  requestAnimationFrame(steer);
}

async function loadGoogleMaps() {
  const { mapsKey } = await fetch("/config").then((r) => r.json()).catch(() => ({}));
  if (!mapsKey) return false;
  await new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&v=weekly&callback=__mapsReady`;
    s.onerror = reject;
    document.head.append(s);
  });
  svService = new google.maps.StreetViewService();
  pano = new google.maps.StreetViewPanorama($("pano"), {
    // No address or road names (they'd give the answer away). Walking arrows, click-to-go and scroll
    // zoom are on for the mouse fallback; the head cursor is hidden on this screen, so head play is unchanged.
    disableDefaultUI: true, addressControl: false, showRoadLabels: false, linksControl: true,
    clickToGo: true, motionTracking: false, motionTrackingControl: false, scrollwheel: true,
  });
  return true;
}

const mapsReady = loadGoogleMaps().catch(() => false);
show("start");
requestAnimationFrame(steer);
const hasMaps = await mapsReady;
$("pano-missing").hidden = hasMaps;
if (params.has("checklocs")) {
  if (hasMaps) import("./checklocs.js").then((m) => m.checkLocations(region.locations, 150));
  else console.warn("[checklocs] needs GOOGLE_MAPS_API_KEY in .env");
}
