// timing.js presets. Run: node tests/js/timing.test.mjs
import assert from "node:assert/strict";
import { PRESETS, TIMING_FIELDS, timing } from "../../web/timing.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("default is off: nothing happens on a timer", () => {
  const t = timing({});
  assert.equal(t.autoAdvanceS, 0);
  assert.equal(t.lockCancelS, 0);
  assert.equal(t.pauseDwellS, 0);
  assert.equal(t.hintDelayS, 0);
});

test("normal keeps the previous behaviour; slower is slower, faster is faster", () => {
  assert.deepEqual(timing({ timing: "normal" }), { autoAdvanceS: 6, lockCancelS: 0.7, pauseDwellS: 2, hintDelayS: 30, speechHoverS: 0.5 });
  for (const f of ["autoAdvanceS", "lockCancelS", "pauseDwellS", "hintDelayS"]) {
    assert.ok(PRESETS.slower[f] > PRESETS.normal[f] && PRESETS.normal[f] > PRESETS.faster[f], f);
  }
});

test("custom uses the sliders, falls back to normal, never negative", () => {
  const t = timing({ timing: "custom", timingCustom: { autoAdvanceS: 12, lockCancelS: -1 } });
  assert.equal(t.autoAdvanceS, 12);
  assert.equal(t.lockCancelS, 0);
  assert.equal(t.hintDelayS, 30);
  assert.deepEqual(Object.keys(t).sort(), [...TIMING_FIELDS].sort());
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
