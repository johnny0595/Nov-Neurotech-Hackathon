import { connect, createCursor, deadzone, headXY, settings } from "./input.js";
import { currentRegion } from "./regions.js";

const ROUNDS = 5;
const $ = (id) => document.getElementById(id);
const region = currentRegion();
const params = new URLSearchParams(location.search);

const game = { mode: "look", round: 0, total: 0, answer: null, guess: null, pov: { heading: 0, pitch: 0 }, used: new Set(), doubleEnabled: true };
let pano = null;
let svService = null;
let guessMarker = null;
let resultLayer = null;
let head = {};

// ---------- input ----------
const api = connect({
  onState(state) {
    head = state;
    cursor.setHead(state);
    if ("double_enabled" in state && state.double_enabled !== game.doubleEnabled) setDoubleEnabled(state.double_enabled);
    $("status").textContent = state.status === "live" ? "" : state.status ?? "";
  },
  onEvent(e) {
    // In LOOK mode the head steers the camera, so a single raise just means "go to the map".
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

// ---------- screens ----------
function setDoubleEnabled(enabled) {
  game.doubleEnabled = enabled;
  cursor.setDragEnabled(enabled);
  $("guess-hint").innerHTML = enabled
    ? "Raise once = drop pin / press · Raise twice = grab &amp; move the map"
    : "Raise eyebrows = drop pin / press a button";
}

function show(mode) {
  if (mode !== game.mode) cursor.stopDrag(); // never carry a map grab into another screen
  game.mode = mode;
  $("look").hidden = mode !== "look";
  $("guess").hidden = mode === "look";
  $("result").hidden = mode !== "result";
  document.querySelectorAll("#guess .action-row, #guess .map-buttons, #guess .hint").forEach((el) => (el.hidden = mode !== "guess"));
  cursor.setVisible(mode !== "look");
  if (mode !== "look") map.invalidateSize();
}

function showGuess() {
  show("guess");
}

$("look-again").onclick = () => show("look");
$("zoom-in").onclick = () => map.zoomIn();
$("zoom-out").onclick = () => map.zoomOut();
$("submit-guess").onclick = () => {
  if (!game.guess) return;
  const meters = map.distance(game.guess, game.answer);
  const { points, stars } = region.score(meters);
  game.total += points;
  const cheer = ["Good try!", "Nice!", "Great job!", "Awesome!", "WOW, amazing!"][stars - 1];

  resultLayer = L.layerGroup([
    L.circleMarker(game.answer, { radius: 12, color: "#1b1f3b", fillColor: "#2ec4b6", fillOpacity: 1 }),
    L.polyline([game.guess, game.answer], { color: "#ff6b6b", weight: 5, dashArray: "10 8" }),
  ]).addTo(map);
  lockMap(false);
  map.fitBounds(L.latLngBounds([game.guess, game.answer]), {
    paddingTopLeft: [80, 100], paddingBottomRight: [80, 460], maxZoom: region.resultMaxZoom, // keep the line clear of the result card
  });

  $("stars").textContent = "⭐".repeat(stars) + "☆".repeat(5 - stars);
  $("result-title").textContent = cheer;
  $("result-detail").innerHTML = `It was <b>${game.answer.name}</b>.<br>You were ${region.formatDistance(meters)} away · +${points.toLocaleString()} points`;
  $("next").textContent = game.round >= ROUNDS ? "See my score ▶" : "Next ▶";
  $("score").textContent = `${game.total.toLocaleString()} points`;
  show("result");
};
$("next").onclick = () => {
  if (game.round >= ROUNDS) {
    $("stars").textContent = "🏆";
    $("result-title").textContent = `${game.total.toLocaleString()} points!`;
    $("result-detail").textContent = region.finale;
    $("next").textContent = "Play again ▶";
    game.round = 0;
    game.total = 0;
    $("score").textContent = "0 points";
    return;
  }
  newRound();
};

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
      const { data } = await svService.getPanorama({
        location: { lat: loc.lat, lng: loc.lng }, radius: region.snapRadius, source: google.maps.StreetViewSource.OUTDOOR,
        preference: google.maps.StreetViewPreference.NEAREST,
      });
      const p = data.location.latLng;
      return { ...loc, lat: p.lat(), lng: p.lng(), panoId: data.location.pano };
    } catch {
      if (!pool.length) return { ...loc, panoId: null }; // no coverage anywhere; still playable
    }
  }
}

async function newRound() {
  game.round += 1;
  game.guess = null;
  $("round").textContent = `Round ${game.round} / ${ROUNDS}`;
  $("submit-guess").disabled = true;
  guessMarker?.remove(); guessMarker = null;
  resultLayer?.remove(); resultLayer = null;
  lockMap(true);
  map.setView(region.view.center, region.view.zoom);
  game.answer = await pickLocation();
  game.answer = Object.assign(L.latLng(game.answer.lat, game.answer.lng), game.answer);
  game.pov = { heading: Math.random() * 360, pitch: 0 };
  if (pano && game.answer.panoId) {
    pano.setPano(game.answer.panoId);
    pano.setPov(game.pov);
  }
  show("look");
}

// Head steers the camera: tilt = turning speed, like a joystick. Deadzone keeps a still head still.
let lastFrame = performance.now();
function steer(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (pano && game.mode === "look" && !cursor.paused) {
    const [x, y] = headXY(head);
    game.pov.heading = (game.pov.heading + deadzone(x, settings.deadzone) * settings.lookSpeed * dt + 360) % 360;
    game.pov.pitch = Math.max(-35, Math.min(35, game.pov.pitch - deadzone(y, settings.deadzone) * settings.lookSpeed * 0.5 * dt));
    pano.setPov(game.pov);
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
    disableDefaultUI: true, addressControl: false, showRoadLabels: false, linksControl: false,
    clickToGo: false, motionTracking: false, motionTrackingControl: false, scrollwheel: false,
  });
  return true;
}

const hasMaps = await loadGoogleMaps().catch(() => false);
$("pano-missing").hidden = hasMaps;
if (params.has("checklocs")) {
  if (hasMaps) import("./checklocs.js").then((m) => m.checkLocations(region.locations, 150));
  else console.warn("[checklocs] needs GOOGLE_MAPS_API_KEY in .env");
}
requestAnimationFrame(steer);
await newRound();
