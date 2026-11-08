// Every string key used in the pages exists, both tones render without leftover {placeholders},
// and the plain tone stays adult. Run: node tests/js/strings.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { settings } from "../../web/settings.js";
import { STRING_KEYS, t } from "../../web/strings.js";

const web = (f) => readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const used = new Set();
for (const f of ["game.js", "input.js", "meter.js", "calibrate.js"]) {
  for (const m of web(f).matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]);
}
for (const f of ["index.html", "calibrate.html"]) {
  for (const m of web(f).matchAll(/data-s(?:-html|-label|-aria)?="([\w.]+)"/g)) used.add(m[1]);
}

test("every key used in code and markup exists", () => {
  const missing = [...used].filter((k) => !STRING_KEYS.includes(k));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 40, `only found ${used.size} keys`);
});

test("both tones fill every placeholder", () => {
  for (const tone of ["plain", "playful"]) {
    settings.tone = tone;
    for (const key of STRING_KEYS) {
      const vars = { n: 1, total: 5, points: 10, time: "12:00", problems: "x", text: "x", s: 3, path: "p", state: "on", place: "x", distance: "1 mile", fact: "x", hint: "x", name: "Ana" };
      const out = [].concat(t(key, vars));
      for (const s of out) assert.ok(!/\{\w+\}/.test(s), `${tone} ${key}: ${s}`);
    }
  }
});

test("plain tone is friendly but adult", () => {
  settings.tone = "plain";
  const childish = /\b(wow|awesome|amazing|great job|yay)\b|!!|🤨|🙈/i;
  const offenders = STRING_KEYS.flatMap((k) => [].concat(t(k)).filter((s) => childish.test(s)).map((s) => `${k}: ${s}`));
  assert.deepEqual(offenders, []);
  assert.equal(t("result.cheer")[4], "Excellent guess");
  settings.tone = "playful";
  assert.equal(t("result.cheer")[4], "WOW, amazing!");
});

test("placeholders use the input's verb", () => {
  settings.tone = "plain";
  assert.equal(t("start.tagline"), "Raise your eyebrows to start");
  assert.equal(t("top.round", { n: 2, total: 5 }), "Round 2 / 5");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
