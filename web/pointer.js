// Pure pointer maths for the head cursor (no DOM), so it can be unit-tested with node:
// click lock, One Euro smoothing, range calibration gains, absolute pointing, and magnetic targets.

// ---------- click lock ----------
export const LOCK_MARGIN_S = 0.15;

/** How far back to look for a click: the raise itself, any wait after it (double mode), plus a margin. */
export function lockLookbackMs(event) {
  return ((event.duration_s ?? 0.3) + (event.delay_s ?? 0) + LOCK_MARGIN_S) * 1000;
}

/** Latest recorded position at or before time t (ms). history: [{ t, x, y }] in time order. */
export function positionAt(history, t) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].t <= t) return history[i];
  return history[0] ?? null;
}
