import { beep, connect, createCursor, deadzone, headXY, settings } from "./input.js";
import { LOCATIONS } from "./locations.js";

const ROUNDS = 5;
const $ = (id) => document.getElementById(id);
const LOOK_HINT = $("look-hint").innerHTML;

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
    // In LOOK mode the head steers the camera: a single raise walks forward, a double raise opens the map.
    if (game.mode === "look" && !cursor.paused) {
      if (e.type === "click") { beep(660); return walkForward(); }
      if (e.type === "drag_toggle") { beep(880); return showGuess(); }
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

// Walk to the next Street View photo along the road you're facing.
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const MAX_WALK_ANGLE = 40; // the road must be on screen, roughly where you're looking
let hintTimer = null;
function flashHint(html) {
  const hint = $("look-hint");
  hint.innerHTML = html;
  hint.classList.add("notice");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.innerHTML = LOOK_HINT; hint.classList.remove("notice"); }, 2500);
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
  if (!near) return flashHint("No road to walk along here. Raise <b>twice</b> to guess 🗺️");
  if (!near.walkable) return flashHint("Turn toward the road, then raise to walk 🚶");
  pano.setPano(near.link.pano);
}

// Shows where a raise will walk to: a green arrow on the road ahead, or an edge hint
// pointing to the nearest road when none is in front of you.
function drawWalkMarker() {
  const show = pano && game.mode === "look" && !cursor.paused;
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
    $("road-edge").textContent = right ? "road ➡" : "⬅ road";
  }
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
  drawWalkMarker();
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
  pano = makePano();
  return true;
}

function makePano() {
  panoSize = { w: $("pano").clientWidth, h: $("pano").clientHeight };
  return new google.maps.StreetViewPanorama($("pano"), {
    disableDefaultUI: true, addressControl: false, showRoadLabels: false, linksControl: false,
    clickToGo: false, motionTracking: false, motionTrackingControl: false, scrollwheel: false,
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
    $("pano").replaceChildren();
    pano = makePano();
    if (id) pano.setPano(id);
    pano.setPov(game.pov);
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

const hasMaps = await loadGoogleMaps().catch(() => false);
$("pano-missing").hidden = hasMaps;
requestAnimationFrame(steer);
await newRound();
