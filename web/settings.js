// Player settings shared by the game and the setup page, stored in this browser per player profile.
// Every option lives here, so a profile saves and restores the whole set: calibration (range), cursor
// settings and gains, input, timing, speech, theme, text size, assist level and difficulty.

export const DEFAULTS = {
  // head + cursor
  xAxis: "roll", yAxis: "pitch", invertX: false, invertY: false, deadzone: 3, speed: 60, maxSpeed: 1100, lookSpeed: 7,
  range: null, // comfortable tilt per direction in degrees, from calibrate.html: { left, right, down, up }
  // "point": cursor = centre + gain x tilt, like a head mouse (needs the range step; until then it
  // falls back to "joystick": tilt = cursor speed, scaled by the speed slider)
  cursorMode: "point",
  oneEuroMinCutoff: 1.0, // Hz: lower = steadier when still
  oneEuroBeta: 0.02, // higher = less lag when moving fast
  magnet: 0.6, // pull toward a button within 80 px: 0 = off, 1 = snap to its centre
  // what makes a click: "brow" (eyebrow EMG) | "jaw" (jaw EMG) | "either" | "keyboard-switch" (Space/Enter,
  // e.g. from a physical switch). The server's --channels decides which EMG channels exist.
  input: "brow",
  // how much the game helps aim: "free" | "assisted" (stronger magnet, bigger confirm zone, zoom in
  // before the pin drops) | "choices" (pick from three named places instead of a map)
  assist: "free",
  // copy
  tone: "plain", // "plain" (default, for everyone) | "playful" (the original kid-style copy)
  // read-aloud (speech.js)
  speechOn: false,
  speechRate: 1,
  speechVolume: 1,
  speechVoice: "", // "" = the system default voice
  // timing (timing.js): "off" (default: nothing is timed) | "slower" | "normal" | "faster" | "custom"
  timing: "off",
  timingCustom: { autoAdvanceS: 6, lockCancelS: 0.7, pauseDwellS: 2, hintDelayS: 30, speechHoverS: 0.5 },
};

// ---------- player profiles: { current, profiles: { name: settings } } in this browser ----------
// Each profile keeps its whole settings set; its EMG detector calibration lives on the server
// (data/profiles/<name>.json).
const STORE_KEY = "brow-profiles";
const FIRST = "Player 1";

function readStore() {
  try {
    const store = JSON.parse(localStorage.getItem(STORE_KEY));
    if (store?.profiles && store.current in store.profiles) return store;
  } catch { /* no storage, or nothing saved yet */ }
  // first run (or settings saved before profiles existed): they become "Player 1"
  let legacy = {};
  try { legacy = JSON.parse(localStorage.getItem("brow-settings")) || {}; } catch { /* none */ }
  return { current: FIRST, profiles: { [FIRST]: legacy } };
}

const store = readStore();

export const settings = { ...DEFAULTS, ...store.profiles[store.current] };

function writeStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode: this visit only */ }
}

const fire = (name) => globalThis.dispatchEvent?.(new CustomEvent(name));

export function saveSettings() {
  store.profiles[store.current] = { ...settings };
  writeStore();
  fire("settings-changed");
}

/** A usable, unused profile name, or an error message. */
export function checkName(name, except = null) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return { error: "Please type a name." };
  if (clean.length > 30) return { error: "Please use 30 characters or fewer." };
  const taken = Object.keys(store.profiles).some((n) => n.toLowerCase() === clean.toLowerCase() && n !== except);
  return taken ? { error: `There is already a profile called “${clean}”.` } : { name: clean };
}

export const profiles = {
  list: () => Object.keys(store.profiles),
  current: () => store.current,
  switchTo(name) {
    if (!(name in store.profiles) || name === store.current) return;
    store.current = name;
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, DEFAULTS, store.profiles[name]);
    writeStore();
    fire("profile-changed");
    fire("settings-changed");
  },
  /** New profile with default settings; switches to it. Returns { name } or { error }. */
  create(name) {
    const checked = checkName(name);
    if (checked.error) return checked;
    store.profiles[checked.name] = {};
    this.switchTo(checked.name);
    return checked;
  },
  rename(oldName, newName) {
    if (!(oldName in store.profiles)) return { error: "No such profile." };
    const checked = checkName(newName, oldName);
    if (checked.error) return checked;
    store.profiles = Object.fromEntries(Object.entries(store.profiles).map(([k, v]) => [k === oldName ? checked.name : k, v]));
    if (store.current === oldName) store.current = checked.name;
    writeStore();
    fire("profile-changed");
    return checked;
  },
  /** Delete a profile (never the last one); switches away first if it's the current one. */
  remove(name) {
    const names = Object.keys(store.profiles);
    if (!(name in store.profiles) || names.length < 2) return { error: "Keep at least one profile." };
    if (store.current === name) this.switchTo(names.find((n) => n !== name));
    delete store.profiles[name];
    writeStore();
    fire("profile-changed");
    return { name };
  },
  /** The next profile in the list (the start screen's button cycles through them). */
  next() {
    const names = Object.keys(store.profiles);
    return names[(names.indexOf(store.current) + 1) % names.length];
  },
};
