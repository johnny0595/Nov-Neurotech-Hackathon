#!/usr/bin/env node
// Accessibility check: runs axe-core (WCAG 2.1 A + AA rules) in a real browser on the game (mock mode,
// start screen and map screen) and on the setup page, in light and dark colour schemes, and lists every
// violation. For the setup page it also tabs through every control (each must show a visible focus ring,
// and focus must not get stuck) and checks it reflows at 200% zoom (no sideways scrolling).
//
// Nothing is added to the repo: npx fetches Playwright and axe-core into its own cache.
//   1. start the server:   uv run python -m server.app
//   2. run the check:      npx -y -p playwright@1.49.1 -p axe-core@4.10.2 node tools/a11y_check.cjs
// Options: --base http://localhost:8000   --bundled (use Playwright's Chromium: `npx playwright install chromium`)
// It uses your installed Chrome by default. Exit code 1 if anything is found.
const path = require("path");
const { createRequire } = require("module");

// npx puts its packages' .bin folder on PATH: load playwright and axe-core from there
const binDir = (process.env.PATH || "").split(path.delimiter)
  .find((p) => p.includes("_npx") && p.endsWith(path.join("node_modules", ".bin")));
const load = binDir ? createRequire(path.join(binDir, "..", "noop.js")) : require;
let chromium;
let axePath;
try {
  ({ chromium } = load("playwright"));
  axePath = load.resolve("axe-core/axe.min.js");
} catch {
  console.error("Run me through npx:\n  npx -y -p playwright@1.49.1 -p axe-core@4.10.2 node tools/a11y_check.cjs");
  process.exit(2);
}

const args = process.argv.slice(2);
const base = (args[args.indexOf("--base") + 1] && args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:8000").replace(/\/$/, "");
const bundled = args.includes("--bundled");

// Third-party widgets we don't control (Google Street View, Leaflet's tiles and attribution)
const EXCLUDE = [["#pano"], [".leaflet-pane"], [".leaflet-control-container"]];

const PAGES = [
  { name: "game: start screen", url: "/?mock=1" },
  {
    name: "game: map screen",
    url: "/?mock=1",
    // start a round and open the map with mock keys (C = click, D = double raise)
    async prepare(page) {
      await page.mouse.move(400, 200);
      await page.keyboard.press("c");
      await page.waitForSelector("#look:not([hidden])", { timeout: 15000 });
      await page.keyboard.press("d");
      await page.waitForSelector("#guess:not([hidden])", { timeout: 5000 });
    },
  },
  { name: "setup page", url: "/calibrate.html?mock=1" },
];

async function check(browser, { name, url, prepare }, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme });
  await page.goto(base + url, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  if (prepare) await prepare(page);
  await page.waitForTimeout(500);
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async (exclude) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run({ exclude }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  }, EXCLUDE);
  await page.close();
  return { name: `${name} [${colorScheme}]`, url, violations: result };
}

// Keyboard only: Tab through the setup page. Every stop must show a focus ring, and Tab must get back
// to the start (no trap).
async function keyboardPass(browser) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(`${base}/calibrate.html?mock=1`, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  const problems = [];
  const seen = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2; // a real focus outline, not a decorative shadow
      const name = el.id || el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30) || el.tagName;
      return { name: `${el.tagName.toLowerCase()}#${name}`, ring };
    });
    if (!stop) { if (seen.length) break; continue; }
    if (seen.includes(stop.name)) break; // wrapped around
    seen.push(stop.name);
    if (!stop.ring) problems.push(`no visible focus ring: ${stop.name}`);
  }
  if (seen.length < 15) problems.push(`only ${seen.length} keyboard stops found`);
  await page.close();
  return { stops: seen.length, problems };
}

// 200% zoom on a 1366 px screen = a 683 px wide viewport: content must reflow, not scroll sideways.
async function reflowAt200(browser) {
  const page = await browser.newPage({ viewport: { width: 683, height: 384 } });
  await page.goto(`${base}/calibrate.html?mock=1`, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.close();
  return overflow > 1 ? [`scrolls sideways by ${overflow} px at 200% zoom`] : [];
}

(async () => {
  const browser = await chromium.launch(bundled ? {} : { channel: "chrome" });
  let total = 0;
  try {
    for (const scheme of ["light", "dark"]) {
      for (const p of PAGES) {
        const { name, url, violations } = await check(browser, p, scheme);
        total += violations.length;
        console.log(`\n${name}  (${url})  ${violations.length ? `${violations.length} violation(s)` : "no violations"}`);
        for (const v of violations) {
          console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
          for (const node of v.nodes.slice(0, 5)) console.log(`      ${node}`);
          if (v.nodes.length > 5) console.log(`      … and ${v.nodes.length - 5} more`);
        }
      }
    }
    const keys = await keyboardPass(browser);
    const reflow = await reflowAt200(browser);
    const extra = [...keys.problems, ...reflow];
    total += extra.length;
    console.log(`\nsetup page, keyboard only: ${keys.stops} focus stops${extra.length ? "" : ", each with a visible focus ring; reflows at 200% zoom"}`);
    for (const problem of extra) console.log(`  ${problem}`);
  } finally {
    await browser.close();
  }
  console.log(`\n${total ? `${total} violation type(s) found` : "All checked pages pass."}`);
  process.exit(total ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
