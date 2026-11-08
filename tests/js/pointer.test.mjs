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

test("range gains: comfortable tilt reaches the edge, a small up range still reaches the top", () => {
  const g = P.gainsFromRange({ left: 10, right: 20, down: 12, up: 4 }, 1600, 900);
  assert.equal(g.left, 80); assert.equal(g.right, 40);
  assert.equal(g.down, 37.5); assert.equal(g.up, 112.5);
  assert.equal(P.gainsFromRange(null, 1600, 900), null);
});

test("point target: centre at rest, edges at comfortable tilt, clamped beyond", () => {
  const g = P.gainsFromRange({ left: 10, right: 20, down: 12, up: 4 }, 1600, 900);
  assert.deepEqual(P.pointTarget([0, 0], g, 1600, 900), { x: 800, y: 450 });
  assert.deepEqual(P.pointTarget([-10, -4], g, 1600, 900), { x: 0, y: 0 });
  assert.deepEqual(P.pointTarget([20, 12], g, 1600, 900), { x: 1599, y: 899 });
  assert.deepEqual(P.pointTarget([40, 30], g, 1600, 900), { x: 1599, y: 899 });
});

test("One Euro: jitter is damped when still, a quick move is followed closely", () => {
  const f = new P.OneEuro({ minCutoff: 1, beta: 0.02 });
  let out;
  for (let i = 0; i < 120; i++) out = f.filter(500 + (i % 2 ? 6 : -6), i / 60); // ±6 px tremor at 60 fps
  assert.ok(Math.abs(out - 500) < 2, `still jitter ${out}`);
  for (let i = 120; i < 150; i++) out = f.filter(500 + (i - 119) * 20, i / 60); // fast sweep, 1200 px/s
  assert.ok(500 + 31 * 20 - out < 80, `lag ${500 + 31 * 20 - out}`);
  f.reset();
  assert.equal(f.filter(42, 10), 42);
});

test("magnet: no pull far away, gentle at 80 px, strong inside the button", () => {
  const btn = { left: 400, top: 600, right: 600, bottom: 740 }; // centre (500, 670)
  assert.deepEqual(P.magnetize({ x: 100, y: 100 }, [btn]), { x: 100, y: 100, index: -1 });
  const edge = P.magnetize({ x: 300, y: 670 }, [btn], 80, 0.6); // 100 px away: outside the zone
  assert.equal(edge.index, -1);
  const near = P.magnetize({ x: 340, y: 670 }, [btn], 80, 0.6); // 60 px from the edge
  assert.ok(near.x > 340 && near.x < 380, `near ${near.x}`);
  const inside = P.magnetize({ x: 420, y: 610 }, [btn], 80, 0.6);
  assert.equal(Math.round(inside.x), 468); assert.equal(Math.round(inside.y), 646);
  assert.deepEqual(P.magnetize({ x: 420, y: 610 }, [btn], 80, 0), { x: 420, y: 610, index: 0 }); // off
});

test("magnet picks the nearest of several buttons", () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100 }, b = { left: 200, top: 0, right: 300, bottom: 100 };
  assert.equal(P.magnetize({ x: 170, y: 50 }, [a, b]).index, 1);
  assert.equal(P.magnetize({ x: 130, y: 50 }, [a, b]).index, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
