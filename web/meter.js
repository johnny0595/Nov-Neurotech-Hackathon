// Live eyebrow meter: a bar of the EMG envelope with a marker at the detection threshold.
// Same scale as the setup page: the threshold sits in the middle (full scale = 2 × threshold).
export function createMeter(root, { compact = false } = {}) {
  root.classList.add("brow-meter");
  root.classList.toggle("compact", compact);
  root.innerHTML = `
    <div class="brow-meter-track"><div class="brow-meter-fill"></div><div class="brow-meter-mark"></div></div>
    <div class="brow-meter-label"></div>`;
  const fill = root.querySelector(".brow-meter-fill");
  const mark = root.querySelector(".brow-meter-mark");
  const label = root.querySelector(".brow-meter-label");
  let maxSeen = 1;
  let calibrated = null;

  return {
    update(state) {
      if (state.envelope === undefined) return;
      maxSeen = Math.max(maxSeen * 0.999, state.envelope);
      const full = state.threshold ? state.threshold * 2 : maxSeen * 1.2;
      fill.style.width = `${Math.min(100, (state.envelope / full) * 100)}%`;
      root.classList.toggle("over", Boolean(state.threshold) && state.envelope > state.threshold);
      if (Boolean(state.threshold) !== calibrated) {
        calibrated = Boolean(state.threshold);
        mark.hidden = !calibrated;
        label.textContent = calibrated
          ? (compact ? "eyebrows" : "Lift your eyebrows past the line")
          : (compact ? "not calibrated" : "Not calibrated yet. Helper: open Setup (calibrate.html)");
      }
    },
    flash() {
      root.classList.remove("flash");
      void root.offsetWidth; // restart the CSS animation
      root.classList.add("flash");
    },
  };
}
