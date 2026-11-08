// speech.js: what gets spoken is plain words (no markup, no emoji/arrow names). Run: node tests/js/speech.test.mjs
import assert from "node:assert/strict";
import { speak, speakable, supported } from "../../web/speech.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("markup and symbols are stripped, separators become pauses", () => {
  assert.equal(speakable("🚶 <b>Raise once</b> to walk · 🤨 <b>raise twice</b> = I know where this is!"),
    "Raise once to walk. raise twice = I know where this is!");
  assert.equal(speakable("Look straight ahead,<br>then <b>raise</b>"), "Look straight ahead,. then raise");
  assert.equal(speakable("⬅ road"), "road");
  assert.equal(speakable("Next ▶"), "Next");
  assert.equal(speakable("  "), "");
});

test("without speechSynthesis (node), speaking is a harmless no-op", () => {
  assert.equal(supported, false);
  speak("hello", { force: true });
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
