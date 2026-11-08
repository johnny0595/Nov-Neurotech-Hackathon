// regions.js: difficulty tiers, scoring and location data. Run: node tests/js/regions.test.mjs
import assert from "node:assert/strict";
import { REGIONS, REGION_ORDER, currentRegion, ncScore, usaScore } from "../../web/regions.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MILE = 1609.344;

test("difficulty picks the region; ?region= overrides; Raleigh is the default", () => {
  assert.equal(currentRegion("", undefined).id, "raleigh");
  assert.equal(currentRegion("", "nc").id, "nc");
  assert.equal(currentRegion("?region=world", "nc").id, "world");
  assert.equal(currentRegion("?region=nope", "usa").id, "usa");
  assert.deepEqual(REGION_ORDER, ["raleigh", "nc", "usa", "world"]);
});

test("NC and USA scoring: exact = 5000 / 5 stars, falling with distance", () => {
  assert.deepEqual(ncScore(0), { points: 5000, stars: 5 });
  assert.equal(ncScore(3 * MILE).stars, 4);
  assert.equal(ncScore(100 * MILE).stars, 1);
  assert.ok(ncScore(10 * MILE).points > ncScore(30 * MILE).points);
  assert.deepEqual(usaScore(0), { points: 5000, stars: 5 });
  assert.equal(usaScore(200 * MILE).stars, 3);
});

test("every NC place has a hint and a fact and sits inside the map bounds", () => {
  for (const id of REGION_ORDER) {
    const r = REGIONS[id];
    assert.ok(r.locations.length >= (id === "world" ? 40 : 18), `${id}: ${r.locations.length} places`);
    const b = r.mapOptions.maxBounds;
    if (!b) continue;
    for (const l of r.locations) {
      assert.ok(l.lat > b[0][0] && l.lat < b[1][0] && l.lng > b[0][1] && l.lng < b[1][1], `${id}: ${l.name} outside bounds`);
    }
  }
  assert.equal(REGIONS.nc.locations.length, 20);
  for (const l of REGIONS.nc.locations) assert.ok(l.hint && l.fact, l.name);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
