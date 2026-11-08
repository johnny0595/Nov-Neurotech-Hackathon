// Brow Explorer: hands-free Street View for people who can't use their hands.
// Head turns look around. One eyebrow raise walks a step (or starts/stops the car);
// two raises switch between walking and driving. Saying "go to <place>" travels there.
import { beep, connect, createCursor, deadzone, headXY, settings } from "./input.js";
import { LOCATIONS } from "./locations.js";

const $ = (id) => document.getElementById(id);

const DRIVE_STEP_MS = 2200; // driving: one Street View photo every this often (~10 m each, a gentle cruise)
const MAX_WALK_ANGLE = 40; // the road must be on screen, roughly where you're looking
const SEARCH_RADII_M = [50, 200, 1000, 5000, 25000]; // how far to look for a Street View photo near a place
const FALLBACK_START = LOCATIONS[0]; // if neither START_LOCATION nor the browser's location is available

const state = { mode: "walk", driving: false, pov: { heading: 0, pitch: 0 }, home: null };
let pano = null;
let svService = null;
let geocoder = null;
let head = {};

// ---------- input ----------
const api = connect({
  onState(s) {
    head = s;
    cursor.setHead(s);
    $("status").textContent = s.status === "live" ? "" : s.status ?? "";
  },
  onEvent(e) {
    if (cursor.paused) return cursor.handleEvent(e); // any raise resumes (and re-centres the head)
    if (e.type === "click") { beep(660); return state.mode === "walk" ? walkForward() : toggleDriving(); }
    if (e.type === "drag_toggle") { beep(880); return setMode(state.mode === "walk" ? "drive" : "walk"); }
  },
});
// No pointer in this app; the cursor module still provides pause/resume and head re-centring.
const cursor = createCursor({ api, onPauseChange: (paused) => { if (paused) stopDriving(); updateHint(); } });
cursor.setVisible(false);

// ---------- hints ----------
function baseHint() {
  if (state.mode === "drive") {
    return state.driving
      ? "🚗 Driving · turn your head to steer · <b>Raise once</b> to stop · <b>Raise twice</b> to walk"
      : "🚗 Car parked · <b>Raise once</b> to drive · <b>Raise twice</b> to walk";
  }
  return "🚶 Turn your head to look around · <b>Raise once</b> to step · <b>Raise twice</b> for the car";
}
let hintTimer = null;
function updateHint() {
  drawModeIndicator();
  if (!hintTimer) $("look-hint").innerHTML = baseHint();
}
// Big WALK | DRIVE switch in the top-left; the active side is lit, and the car shows moving/parked.
function drawModeIndicator() {
  const drive = state.mode === "drive";
  $("mode-walk").classList.toggle("on", !drive);
  $("mode-drive").classList.toggle("on", drive);
  $("mode-drive-state").textContent = drive ? (state.driving ? "moving" : "parked") : "";
  $("mode-badge").classList.toggle("moving", drive && state.driving);
}
function flashHint(html, ms = 3000) {
  const hint = $("look-hint");
  hint.innerHTML = html;
  hint.classList.add("notice");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintTimer = null; hint.classList.remove("notice"); updateHint(); }, ms);
}

// ---------- walking and driving ----------
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** The road link closest to where you're looking, and its signed angle from the view centre (+ = right). */
function nearestLink() {
  const links = (pano?.getLinks() || []).filter((l) => l?.pano);
  if (!links.length) return null;
  const best = links.reduce((a, b) => (angleBetween(b.heading, state.pov.heading) < angleBetween(a.heading, state.pov.heading) ? b : a));
  const signed = ((best.heading - state.pov.heading + 540) % 360) - 180;
  return { link: best, signed, walkable: Math.abs(signed) <= MAX_WALK_ANGLE };
}

/** One step along the road in view. Returns false (and explains) if there's no road ahead. */
function step(quiet = false) {
  if (!pano) return false;
  const near = nearestLink();
  if (!near) { if (!quiet) flashHint("No road here. Try saying <b>“go to …”</b> a place 🎤"); return false; }
  if (!near.walkable) { if (!quiet) flashHint("Turn toward the road first ↔"); return false; }
  pano.setPano(near.link.pano);
  return true;
}
const walkForward = () => step();

let driveTimer = null;
let blockedSteps = 0;
function toggleDriving() {
  if (state.driving) return stopDriving();
  if (!nearestLink()?.walkable) return flashHint("Turn toward the road, then raise to drive 🚗");
  state.driving = true;
  blockedSteps = 0;
  driveTimer = setInterval(() => {
    if (step(true)) { blockedSteps = 0; return; }
    if (++blockedSteps >= 2) { // ~4 s with no road ahead: park, rather than sit there "driving"
      stopDriving();
      flashHint("🛑 The road ends here. Turn toward a road and raise to drive again.");
    }
  }, DRIVE_STEP_MS);
  updateHint();
}
function stopDriving() {
  clearInterval(driveTimer);
  driveTimer = null;
  if (state.driving) { state.driving = false; updateHint(); }
}
function setMode(mode) {
  stopDriving();
  state.mode = mode;
  $("walk-label").textContent = mode === "drive" ? "raise to drive" : "raise to walk";
  updateHint();
  flashHint(mode === "drive" ? "🚗 Car mode. <b>Raise once</b> to start driving." : "🚶 Walking mode. <b>Raise once</b> to take a step.");
}

// Green arrow on the road a raise will take you along; edge tag pointing to the nearest road otherwise.
function drawWalkMarker() {
  const show = pano && !cursor.paused;
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
    $("walk-marker").style.rotate = `${near.signed * 0.5}deg`;
  } else {
    const right = near.signed > 0;
    $("road-edge").className = `road-edge ${right ? "right" : "left"}`;
    $("road-edge").textContent = right ? "road ➡" : "⬅ road";
  }
}

// Head steers the camera like a joystick; the dead zone keeps a still head still.
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (pano && !cursor.paused) {
    const [x, y] = headXY(head);
    state.pov.heading = (state.pov.heading + deadzone(x, settings.deadzone) * settings.lookSpeed * dt + 360) % 360;
    state.pov.pitch = Math.max(-35, Math.min(35, state.pov.pitch - (settings.invertLookY ? -1 : 1) * deadzone(y, settings.deadzone) * settings.lookSpeed * 0.5 * dt));
    pano.setPov(state.pov);
  }
  drawWalkMarker();
  requestAnimationFrame(frame);
}

// ---------- places ----------
/** Nearest outdoor Google Street View photo to a lat/lng, searching wider and wider. */
async function findPanorama(latLng) {
  for (const radius of SEARCH_RADII_M) {
    try {
      const { data } = await svService.getPanorama({
        location: latLng, radius,
        sources: [google.maps.StreetViewSource.GOOGLE], // Google's own imagery; user photospheres are often indoors or a wall
        preference: radius <= 200 ? google.maps.StreetViewPreference.NEAREST : google.maps.StreetViewPreference.BEST,
      });
      return data.location;
    } catch { /* nothing within this radius: widen */ }
  }
  return null;
}

/** Jump to a place. Faces the place itself when the photo is a little way from it. */
async function travelTo(latLng, label) {
  stopDriving();
  const loc = await findPanorama(latLng);
  if (!loc) { flashHint(`Sorry, no street photos near <b>${escapeHtml(label)}</b>.`, 4000); return false; }
  const from = loc.latLng;
  const dist = google.maps.geometry?.spherical?.computeDistanceBetween(from, latLng) ?? 0;
  if (dist > 30 && google.maps.geometry) state.pov.heading = google.maps.geometry.spherical.computeHeading(from, latLng);
  state.pov.pitch = 0;
  pano.setPano(loc.pano);
  pano.setPov(state.pov);
  $("place").hidden = false;
  $("place").textContent = `📍 ${label}`; // replaced by the street address once Street View knows it
  flashHint(`📍 ${escapeHtml(label)}`, 4000);
  return true;
}

/** Place name -> lat/lng. Google's geocoder if the key allows it, else OpenStreetMap's Nominatim (free, no key). */
async function geocode(query) {
  if (geocoder) {
    try {
      const { results } = await geocoder.geocode({ address: query });
      if (results?.length) return { latLng: results[0].geometry.location, label: results[0].formatted_address };
    } catch { /* Geocoding API not enabled for this key: fall back */ }
  }
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "en" } });
  const [hit] = r.ok ? await r.json() : [];
  if (!hit) return null;
  return { latLng: new google.maps.LatLng(+hit.lat, +hit.lon), label: hit.display_name.split(",").slice(0, 2).join(",") };
}

async function goToPlace(query) {
  if (!pano) return;
  flashHint(`Going to <b>${escapeHtml(query)}</b>… ✈️`, 8000);
  const place = await geocode(query).catch(() => null);
  if (!place) return flashHint(`I couldn't find <b>${escapeHtml(query)}</b>. Try another name.`, 4000);
  await travelTo(place.latLng, place.label || query);
}

async function goHome() {
  if (state.home) await travelTo(state.home, "Home");
}

async function surprise() {
  const p = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
  await travelTo(new google.maps.LatLng(p.lat, p.lng), p.name);
}

/** Where to start: START_LOCATION from .env (set by a caregiver), else the browser's location, else a default. */
async function startLocation(configured) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(configured || "");
  if (m) return new google.maps.LatLng(+m[1], +m[2]);
  if (configured) {
    const place = await geocode(configured).catch(() => null);
    if (place) return place.latLng;
  }
  const here = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(new google.maps.LatLng(p.coords.latitude, p.coords.longitude)),
      () => resolve(null),
      { timeout: 10000, maximumAge: 600000 },
    );
  });
  return here ?? new google.maps.LatLng(FALLBACK_START.lat, FALLBACK_START.lng);
}

// ---------- voice: "go to the grand canyon", "go home", "surprise me", "stop", "walk", "drive" ----------
function handleSpeech(text) {
  const said = text.toLowerCase().trim().replace(/[.!?]+$/, "");
  $("mic").textContent = `🎤 “${text.trim()}”`;
  const go = /\b(?:go|take me|bring me|fly me|teleport me|travel|show me)\s+(?:to\s+|over to\s+)?(.+)/.exec(said);
  if (/\b(go|take me|bring me)\s+(back\s+)?home\b/.test(said)) return goHome();
  if (/\bsurprise me\b/.test(said)) return surprise();
  if (/\b(stop|park|brake)\b/.test(said)) return stopDriving();
  if (/\b(drive|car mode|driving)\b/.test(said) && !go) return setMode("drive");
  if (/\b(walk|walking|walk mode)\b/.test(said) && !go) return setMode("walk");
  if (/\bpause\b/.test(said)) return cursor.pause();
  if (go) return goToPlace(go[1].replace(/^the\s+/, "the "));
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("mic");
  mic.hidden = false;
  if (!SR) { mic.textContent = "🎤 Voice needs Chrome or Edge"; return; }
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = false;
  let blocked = false;
  rec.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    if (last.isFinal) handleSpeech(last[0].transcript);
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      blocked = true;
      mic.textContent = "🎤 Microphone blocked: allow it in the browser to use voice";
    }
  };
  rec.onend = () => { if (!blocked) setTimeout(() => { try { rec.start(); } catch { /* already started */ } }, 300); };
  mic.textContent = "🎤 Say “go to …” a place";
  try { rec.start(); } catch { /* starts on the next onend */ }
}

// Helper / testing: "/" opens a box to type a place (or a voice command).
addEventListener("keydown", (e) => {
  if (e.key === "/" && $("goto-form").hidden) {
    e.preventDefault();
    $("goto-form").hidden = false;
    $("goto-input").focus();
  } else if (e.key === "Escape" && !$("goto-form").hidden) {
    $("goto-form").hidden = true;
  }
});
$("goto-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("goto-input").value.trim();
  $("goto-form").hidden = true;
  $("goto-input").value = "";
  if (q) handleSpeech(/^(go|take|bring|fly|surprise|stop|walk|drive|pause)\b/i.test(q) ? q : `go to ${q}`);
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Google Maps + window resizing ----------
async function loadGoogleMaps(mapsKey) {
  if (!mapsKey) return false;
  await new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&v=weekly&libraries=geometry&loading=async&callback=__mapsReady`;
    s.onerror = reject;
    document.head.append(s);
  });
  svService = new google.maps.StreetViewService();
  geocoder = new google.maps.Geocoder();
  pano = makePano();
  return true;
}

let panoSize = { w: 0, h: 0 };
function makePano() {
  panoSize = { w: $("pano").clientWidth, h: $("pano").clientHeight };
  const p = new google.maps.StreetViewPanorama($("pano"), {
    disableDefaultUI: true, addressControl: false, showRoadLabels: false, linksControl: false,
    clickToGo: false, motionTracking: false, motionTrackingControl: false, scrollwheel: false,
  });
  p.addListener("pano_changed", () => {
    const where = p.getLocation()?.description;
    if (where) { $("place").hidden = false; $("place").textContent = `📍 ${where}`; }
  });
  return p;
}

// After a resize Street View keeps its old canvas size (looks zoomed in): rebuild it at the new size.
let resizeTimer = null;
function refit() {
  const { clientWidth: w, clientHeight: h } = $("pano");
  if (pano && w && h && (w !== panoSize.w || h !== panoSize.h)) {
    const id = pano.getPano();
    $("pano").replaceChildren();
    pano = makePano();
    if (id) pano.setPano(id);
    pano.setPov(state.pov);
  }
}
const scheduleRefit = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refit, 300); };
addEventListener("resize", scheduleRefit);
new ResizeObserver(scheduleRefit).observe($("pano"));
setInterval(() => {
  const { clientWidth: w, clientHeight: h } = $("pano");
  if (pano && w && h && (w !== panoSize.w || h !== panoSize.h)) scheduleRefit();
}, 1000);

// ---------- start ----------
updateHint();
const config = await fetch("/config").then((r) => r.json()).catch(() => ({}));
const hasMaps = await loadGoogleMaps(config.mapsKey).catch(() => false);
$("pano-missing").hidden = hasMaps;
requestAnimationFrame(frame);
if (hasMaps) {
  flashHint("Finding the street outside… 🏠", 10000);
  state.home = await startLocation(config.startLocation);
  await travelTo(state.home, "Outside");
  startVoice();
}
