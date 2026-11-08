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

// ---------- comfortable range -> per-direction gains ----------
/** Pixels per degree for each direction, so a comfortable max tilt reaches the screen edge. null if uncalibrated. */
export function gainsFromRange(range, width, height) {
  if (!range) return null;
  const per = (half, deg) => half / Math.max(deg, 0.5);
  return {
    left: per(width / 2, range.left), right: per(width / 2, range.right),
    up: per(height / 2, range.up), down: per(height / 2, range.down),
  };
}
