// Unit tests for web/pointer.js. Run: node tests/js/pointer.test.mjs (pytest runs it too, if node is installed).
import assert from "node:assert/strict";
import * as P from "../../web/pointer.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("click lock looks back over the raise, the double-mode wait and a margin", () => {
  assert.equal(Math.round(P.lockLookbackMs({ duration_s: 0.3, delay_s: 0 })), 450);
  assert.equal(Math.round(P.lockLookbackMs({ duration_s: 0.4, delay_s: 0.8 })), 1350);
  assert.equal(Math.round(P.lockLookbackMs({})), 450); // old servers: assume a 0.3 s raise
});

test("positionAt returns where the cursor was before the raise began", () => {
  const h = [{ t: 0, x: 100, y: 500 }, { t: 400, x: 100, y: 500 }, { t: 600, x: 110, y: 420 }, { t: 900, x: 112, y: 400 }];
  assert.deepEqual(P.positionAt(h, 900 - 450), h[1]); // the upward nudge from the raise is ignored
  assert.deepEqual(P.positionAt(h, 5000), h[3]);
  assert.deepEqual(P.positionAt(h, -10), h[0]);
  assert.equal(P.positionAt([], 10), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
