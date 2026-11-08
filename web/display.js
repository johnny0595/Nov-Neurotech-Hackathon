// Visual options for both pages: theme (auto / light / dark / high-contrast), text size 100-200% (one
// root font scale: every font size in the CSS is in rem), cursor size S / M / L, and ?cvd=1, a
// deuteranopia (red-green colour blindness) preview filter for checking that nothing relies on colour.
import { settings } from "./settings.js";

const CURSOR_PX = { S: 48, M: 72, L: 104 };

// Machado et al. (2009) deuteranopia simulation, severity 1.0
const DEUTERANOPIA = "0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0";

export function applyDisplay() {
  const root = document.documentElement;
  const theme = settings.theme ?? "auto";
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const scale = Math.min(2, Math.max(1, Number(settings.textScale) || 1));
  root.style.setProperty("--text-scale", String(scale));
  root.style.setProperty("--cursor-size", `${CURSOR_PX[settings.cursorSize] ?? CURSOR_PX.M}px`);
  root.dataset.tone = settings.tone === "playful" ? "playful" : "plain"; // decorative emoji only in the playful tone
}

function addCvdPreview() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0";
  svg.innerHTML = `<filter id="cvd-deuteranopia" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${DEUTERANOPIA}"/></filter>`;
  document.body.append(svg);
  // on the root element the filter doesn't break position: fixed (the cursor, overlays)
  document.documentElement.style.filter = "url(#cvd-deuteranopia)";
}

applyDisplay();
addEventListener("settings-changed", applyDisplay);
if (new URLSearchParams(location.search).has("cvd")) addCvdPreview();
