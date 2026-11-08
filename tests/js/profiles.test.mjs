// settings.js profiles (in node there's no localStorage, so the store lives in memory). Run: node tests/js/profiles.test.mjs
import assert from "node:assert/strict";
import { DEFAULTS, checkName, profiles, saveSettings, settings } from "../../web/settings.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("starts with one profile holding the defaults", () => {
  assert.deepEqual(profiles.list(), ["Player 1"]);
  assert.equal(settings.timing, DEFAULTS.timing);
});

test("each profile keeps its own settings", () => {
  settings.tone = "playful"; settings.speechOn = true; saveSettings();
  assert.deepEqual(profiles.create("Ana"), { name: "Ana" });
  assert.equal(profiles.current(), "Ana");
  assert.equal(settings.tone, "plain"); // a new profile starts from the defaults
  settings.input = "jaw"; saveSettings();
  profiles.switchTo("Player 1");
  assert.equal(settings.tone, "playful"); assert.equal(settings.speechOn, true); assert.equal(settings.input, "brow");
  profiles.switchTo("Ana");
  assert.equal(settings.input, "jaw");
});

test("names are checked; rename keeps the settings; never delete the last profile", () => {
  assert.ok(checkName("  ").error); assert.ok(checkName("ana").error); assert.ok(checkName("x".repeat(31)).error);
  assert.deepEqual(profiles.rename("Ana", "  Ana  Lee "), { name: "Ana Lee" });
  assert.equal(profiles.current(), "Ana Lee"); assert.equal(settings.input, "jaw");
  assert.equal(profiles.next(), "Player 1");
  assert.deepEqual(profiles.remove("Ana Lee"), { name: "Ana Lee" });
  assert.equal(profiles.current(), "Player 1");
  assert.ok(profiles.remove("Player 1").error);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
