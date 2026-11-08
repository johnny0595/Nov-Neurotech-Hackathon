// Timing presets. Principle: nothing is timed unless the player turns it on, so "off" is the default.
// All values in seconds; 0 means "never" for auto-advance, lock-in cancel and pause dwell, and
// "straight away" for the hint and the read-aloud hover.
import { settings } from "./settings.js";

export const TIMING_FIELDS = ["autoAdvanceS", "lockCancelS", "pauseDwellS", "hintDelayS", "speechHoverS"];

export const PRESETS = {
  off: { autoAdvanceS: 0, lockCancelS: 0, pauseDwellS: 0, hintDelayS: 0, speechHoverS: 0.5 },
  slower: { autoAdvanceS: 10, lockCancelS: 1.2, pauseDwellS: 3, hintDelayS: 45, speechHoverS: 0.8 },
  normal: { autoAdvanceS: 6, lockCancelS: 0.7, pauseDwellS: 2, hintDelayS: 30, speechHoverS: 0.5 },
  faster: { autoAdvanceS: 4, lockCancelS: 0.5, pauseDwellS: 1.5, hintDelayS: 15, speechHoverS: 0.3 },
};

/** Effective timings for the current (or given) settings. */
export function timing(s = settings) {
  if (s.timing === "custom") {
    const custom = s.timingCustom ?? {};
    return Object.fromEntries(TIMING_FIELDS.map((k) => [k, Math.max(0, Number(custom[k] ?? PRESETS.normal[k]))]));
  }
  return { ...(PRESETS[s.timing] ?? PRESETS.off) };
}
