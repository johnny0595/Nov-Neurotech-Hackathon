import { connect, createCursor, deadzone, headXY, settings } from "./input.js";
import { LOCATIONS } from "./locations.js";

const ROUNDS = 5;
const $ = (id) => document.getElementById(id);

const game = { mode: "look", round: 0, total: 0, answer: null, guess: null, pov: { heading: 0, pitch: 0 }, used: new Set() };
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
    $("status").textContent = state.status === "live" ? "" : state.status ?? "";
  },
  onEvent(e) {
    // In LOOK mode the head steers the camera, so a single raise just means "go to the map".
    if (game.mode === "look" && !cursor.paused && e.type === "click") return showGuess();
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
const map = L.map("map", { worldCopyJump: true, zoomControl: false }).setView([20, 0], 2);
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
function show(mode) {
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
  const km = map.distance(game.guess, game.answer) / 1000;
  const points = Math.round(5000 * Math.exp(-km / 2000));
  game.total += points;
  const stars = km < 500 ? 5 : km < 1500 ? 4 : km < 3000 ? 3 : km < 6000 ? 2 : 1;
  const cheer = ["Good try!", "Nice!", "Great job!", "Awesome!", "WOW, amazing!"][stars - 1];

  resultLayer = L.layerGroup([
    L.circleMarker(game.answer, { radius: 12, color: "#1b1f3b", fillColor: "#2ec4b6", fillOpacity: 1 }),
    L.polyline([game.guess, game.answer], { color: "#ff6b6b", weight: 5, dashArray: "10 8" }),
  ]).addTo(map);
  map.fitBounds(L.latLngBounds([game.guess, game.answer]), { paddingTopLeft: [80, 100], paddingBottomRight: [80, 460] }); // keep the line clear of the result card

  $("stars").textContent = "⭐".repeat(stars) + "☆".repeat(5 - stars);
  $("result-title").textContent = cheer;
  $("result-detail").innerHTML = `It was <b>${game.answer.name}</b>.<br>You were ${Math.round(km).toLocaleString()} km away · +${points.toLocaleString()} points`;
  $("next").textContent = game.round >= ROUNDS ? "See my score ▶" : "Next ▶";
  $("score").textContent = `${game.total.toLocaleString()} points`;
  show("result");
};
$("next").onclick = () => {
  if (game.round >= ROUNDS) {
    $("stars").textContent = "🏆";
    $("result-title").textContent = `${game.total.toLocaleString()} points!`;
    $("result-detail").textContent = "You explored the whole world. Play again?";
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
  const pool = LOCATIONS.filter((l) => !game.used.has(l.name));
  if (pool.length < 5) game.used.clear();
  while (true) {
    const loc = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] ?? LOCATIONS[0];
    game.used.add(loc.name);
    if (!svService) return { ...loc, panoId: null };
    try {
      const { data } = await svService.getPanorama({
        location: loc, radius: 1000, sources: [google.maps.StreetViewSource.GOOGLE], // Google car imagery only; user photospheres are often a wall or a van
        preference: google.maps.StreetViewPreference.NEAREST,
      });
      const p = data.location.latLng;
      return { name: loc.name, lat: p.lat(), lng: p.lng(), panoId: data.location.pano };
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
  map.setView([20, 0], 2);
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
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&v=weekly&loading=async&callback=__mapsReady`;
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
requestAnimationFrame(steer);
await newRound();
