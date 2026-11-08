// Every user-facing string, in two tones:
//   plain   (default) — friendly but adult, for everyone
//   playful           — the original kid-style copy
// A string is either one value for both tones, or { plain, playful }.
// Placeholders: {Act} / {act} (verb: "Raise" or "Click", see words()), {ActPhrase} ("Raise your eyebrows" / "Click"),
// plus per-call ones like {n}, {total}, {points}.
import { settings } from "./settings.js";

const S = {
  // ---------- start ----------
  "start.title": "Brow Guessr",
  "start.tagline": { plain: "{ActPhrase} to start", playful: "{ActPhrase} to play!" },
  "start.play": "▶ Play",
  "start.play.label": "Play",
  "start.tone": { plain: "Tone: plain", playful: "Tone: playful" },
  "start.tone.label": "Switch tone",
  "start.profile": { plain: "Player: {name}", playful: "👤 {name}" },
  "start.profile.label": "Switch player",
  "say.profile": "Player: {name}",
  "start.speech": { plain: "Read aloud: {state}", playful: "🔊 Read aloud: {state}" },
  "start.speech.label": "Turn reading aloud on or off",
  "on": "on",
  "off": "off",

  // ---------- eyebrow meter ----------
  "meter.ready": { plain: "{Act} past the line", playful: "Lift your eyebrows past the line" },
  "meter.ready.short": { plain: "signal", playful: "eyebrows" },
  "meter.uncalibrated": "Not calibrated yet. Helper: open Setup (calibrate.html)",
  "meter.uncalibrated.short": "not calibrated",

  // ---------- top bar ----------
  "top.round": "Round {n} / {total}",
  "top.points": "{points} points",

  // ---------- look (Street View) ----------
  "look.pill.double": {
    plain: "<b>{Act} once</b> to walk · <b>{act} twice</b> to guess on the map",
    playful: "🚶 <b>Raise once</b> to walk · 🤨 <b>raise twice</b> = I know where this is!",
  },
  "look.pill.single": { plain: "<b>{Act}</b> to guess on the map", playful: "🤨 <b>Raise</b> = I know where this is!" },
  "look.noRoad": { plain: "No road ahead. {Act} twice to guess on the map.", playful: "No road to walk along here. Raise <b>twice</b> to guess 🗺️" },
  "look.turnToRoad": { plain: "Turn toward the road, then {act} to walk", playful: "Turn toward the road, then raise to walk 🚶" },
  "look.walkHere": "{act} to walk",
  "look.roadLeft": "⬅ road",
  "look.roadRight": "road ➡",
  "look.hint": { plain: "Hint:", playful: "💡 Hint:" },
  "look.noPano.title": { plain: "No Street View for this place", playful: "No street pictures for this one 🙈" },
  "look.noPano.body": { plain: "Use the hint, then guess on the map.", playful: "Use the hint and guess on the map!" },
  "look.noKey.title": "Street View needs a Google Maps key",
  "look.noKey.body": "Put <code>GOOGLE_MAPS_API_KEY=…</code> in <code>.env</code> and restart the server.<br>The rest of the game still works.",
  "look.map": { plain: "Map", playful: "🗺️ Map" },
  "look.map.label": "Go to the map",
  // single-input Street View: a bottom band of tiles, one instruction at a time
  "single.walk": { plain: "Walk", playful: "🚶 Walk" },
  "single.walk.label": "Walk forward",
  "single.map": { plain: "Map", playful: "🗺️ Map" },
  "single.map.label": "Guess on the map",
  "single.pause": { plain: "Pause", playful: "⏸ Pause" },
  "single.pause.label": "Pause",
  "single.look": "Look around, then tilt down to choose",
  "single.choose": "{Act} on Walk, Map or Pause",
  "single.tiltDown": "Tilt down to the buttons first",

  // ---------- guess (map) ----------
  "guess.look": { plain: "Look again", playful: "👀 Look" },
  "guess.look.label": "Look again",
  "guess.zoomIn.label": "Zoom in",
  "guess.zoomOut.label": "Zoom out",
  "guess.submit": { plain: "Guess", playful: "📍 Guess!" },
  "guess.submit.label": { plain: "Guess", playful: "Guess!" },
  "guess.confirm": { plain: "Confirm?", playful: "🔒 Lock it in?" },
  "guess.confirm.label": { plain: "Confirm guess", playful: "Lock it in!" },
  "guess.dropPin": "Drop pin",
  "guess.zoomHere": "Zoom in here",
  "guess.hint.choices": "{Act} on the place you think it is",
  "guess.choice.label": "{place}",
  "guess.movePin": "Move pin here",
  "guess.confirmTip": { plain: "{Act} again to confirm", playful: "Lock it in? Raise again" },
  "guess.hint.double": {
    plain: "{Act}: drop pin · {act} again on the pin: confirm · {act} twice: move the map",
    playful: "Raise = drop pin · raise again on it = lock it in · raise twice quickly = grab the map",
  },
  "guess.hint.single": {
    plain: "{Act}: drop pin · {act} again on the pin: confirm",
    playful: "Raise = drop pin · raise again on the pin = lock it in",
  },

  // ---------- result ----------
  "result.cheer": {
    plain: ["Keep going", "Not bad", "Good guess", "Great guess", "Excellent guess"],
    playful: ["Good try!", "Nice!", "Great job!", "Awesome!", "WOW, amazing!"],
  },
  "result.itWas": "It was",
  "result.away": "away",
  "result.points": "points",
  "result.next": "Next ▶",
  "result.next.label": "Next",
  "result.seeScore": { plain: "See score ▶", playful: "See my score ▶" },
  "say.result": "It was {place}. {distance} away. {points} points. {fact}",
  "say.final": "Final score: {points} points.",
  "say.hint": "Hint: {hint}",
  "setup.speech.test": "This is how the game will read aloud.",

  // ---------- final ----------
  "final.score": { plain: "{points} points", playful: "{points} points!" },
  "final.finale.raleigh": { plain: "That's all five Raleigh places. Play again?", playful: "You explored Raleigh! Play again?" },
  "final.finale.world": { plain: "That's all five places. Play again?", playful: "You explored the whole world. Play again?" },
  "final.helper": { plain: "Summary", playful: "📋 Helper" },
  "final.helper.label": { plain: "Session summary", playful: "Helper summary" },
  "final.playAgain": "Play again ▶",
  "final.playAgain.label": "Play again",
  "stats.raises": "{Act}s detected",
  "stats.perRound": "{Act}s per round",
  "stats.gated": "{Act}s ignored (head moving)",
  "stats.clicks": "Clicks used",
  "stats.time": "Average time from screen appearing to click",
  "stats.rounds": "Rounds",
  "stats.autoZeros": "Automatic re-centres",

  // ---------- pause + feedback ----------
  "pause.title": "Paused",
  "pause.body": { plain: "Look straight ahead, then {act} to continue.", playful: "Look straight ahead,<br>then <b>raise your eyebrows</b> to play." },
  "pause.helper": "Helper: press Space or click here",
  "pause.helper.switch": "Helper: press Esc or click here",
  "pauseTile.title": "Pause",
  "pauseTile.hold": "or hold here",
  "badge.seen": { plain: "{Act} detected ✓", playful: "Raise seen ✓" },
  "badge.hold": "Hold still, then {act}",

  // ---------- setup page (calibrate.html): prompts and statuses the player sees ----------
  "setup.axes.done": "Head calibrated ✓ (saved). Recalibrate if the headset moved.",
  "setup.axes.none": "Not calibrated yet: press Calibrate head.",
  "setup.axes.running": "Calibrating…",
  "setup.axes.ok": "Calibrated ✓ at {time}. Nod and turn: the dot should follow cleanly. If it ever creeps, press Re-center.",
  "setup.axes.failed": "That didn't work: {problems}. Please try again.",
  "setup.axes.step": "Head calibration · step {n} of {total}",
  "setup.axes.still": "Sit comfortably, look at the screen<br>and hold <b>completely still</b>",
  "setup.axes.nod": "Nod yes, slowly ↕<br><small>up and down, keep going</small>",
  "setup.axes.shake": "Shake no, slowly ↔<br><small>left and right, keep going</small>",
  "setup.axes.straight": "Look straight at the screen",
  "setup.axes.up": "Look up ⬆",
  "setup.axes.upHold": "Look up ⬆ and hold",
  "setup.axes.right": "Turn to look right ➡",
  "setup.axes.rightHold": "Turn to look right ➡ and hold",
  "setup.axes.finish": "Look straight at the screen<br>and hold still",
  "setup.range.left": "Tilt left as far as is comfortable",
  "setup.range.right": "Tilt right as far as is comfortable",
  "setup.range.down": "Tilt down as far as is comfortable",
  "setup.range.up": "Now tilt up, just a little",
  "setup.range.hold": "{text}… and hold",
  "setup.range.back": "Back to the middle…",
  "setup.range.done": "Calibrated. A comfortable tilt reaches the screen edge.",
  "setup.range.none": "Not calibrated: the cursor uses the speed slider.",
  "setup.range.start": "Calibrate range",
  "setup.range.cancel": "Cancel",
  "setup.brow.relax": "Relax… {s}",
  "setup.brow.button": "Calibrate (relax 8 s)",
  "setup.jaw.button": "Calibrate jaw (relax 8 s)",
  "setup.rec.ready": "Get ready…",
  "setup.rec.relaxLook": "Relax and look ahead",
  "setup.rec.relax": "Relax",
  "setup.rec.almost": "Relax, almost done",
  "setup.rec.single": "{ActPhrase} once",
  "setup.rec.double": "{Act} twice, quickly",
  "setup.rec.blink": "Blink a few times<br><small>eyebrows still</small>",
  "setup.rec.swallow": "Swallow",
  "setup.rec.headMove": "Move your head a little<br><small>eyebrows still</small>",
  "setup.rec.talk": "Say “hello, how are you?”",
  "setup.rec.saved": "Saved <code>{path}</code>. Analyse it with <code>uv run python -m server.evaluate {path}</code>.",
  "setup.rec.nothing": "Nothing was saved.",
  "setup.log.ignored": " — ignored, head was moving",
};

/** Verb forms for the current input: "raise" only when the eyebrows are the sole input, otherwise "click". */
export function words() {
  if ((settings.input ?? "brow") === "brow") return { Act: "Raise", act: "raise", ActPhrase: "Raise your eyebrows" };
  return { Act: "Click", act: "click", ActPhrase: "Click" };
}

export function tone() {
  return settings.tone === "playful" ? "playful" : "plain";
}

/** The string for `key` in the current tone, with {placeholders} filled in. Arrays come back as arrays. */
export function t(key, vars = {}) {
  const entry = S[key];
  if (entry === undefined) {
    console.warn(`[strings] missing ${key}`);
    return key;
  }
  const value = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry[tone()] : entry;
  const all = { ...words(), ...vars };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, name) => (name in all ? String(all[name]) : m));
  return Array.isArray(value) ? value.map(fill) : fill(value);
}

/**
 * Fill static markup: data-s (text), data-s-html (markup), data-s-label (the cursor's "what a raise does"
 * label), data-s-aria (aria-label). Call again after the tone or input changes.
 */
export function applyStrings(root = document) {
  for (const el of root.querySelectorAll("[data-s]")) el.textContent = t(el.dataset.s);
  for (const el of root.querySelectorAll("[data-s-html]")) el.innerHTML = t(el.dataset.sHtml);
  for (const el of root.querySelectorAll("[data-s-label]")) el.dataset.raiseLabel = t(el.dataset.sLabel);
  for (const el of root.querySelectorAll("[data-s-aria]")) el.setAttribute("aria-label", t(el.dataset.sAria));
}

export const STRING_KEYS = Object.keys(S);
