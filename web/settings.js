// Player settings shared by the game and the setup page (stored in this browser).
// Every option lives here so a player profile can save and restore the whole set.

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

function readStored() {
  try { return JSON.parse(localStorage.getItem("brow-settings")) || {}; } catch { return {}; }
}

export const settings = { ...DEFAULTS, ...readStored() };

export function saveSettings() {
  try { localStorage.setItem("brow-settings", JSON.stringify(settings)); } catch { /* private mode: settings last this visit only */ }
  dispatchEvent(new CustomEvent("settings-changed"));
}
