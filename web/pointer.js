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

// ---------- absolute pointing ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Head-mouse position: screen centre + per-direction gain x tilt (x right, y down), kept on screen. */
export function pointTarget([tx, ty], gains, width, height) {
  return {
    x: clamp(width / 2 + tx * (tx < 0 ? gains.left : gains.right), 0, width - 1),
    y: clamp(height / 2 + ty * (ty < 0 ? gains.up : gains.down), 0, height - 1),
  };
}

// ---------- One Euro filter (Casiez et al. 2012): smooth when still, responsive when moving ----------
const smoothing = (cutoffHz, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));

export class OneEuro {
  constructor({ minCutoff = 1, beta = 0.02, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }

  reset() {
    this.value = null;
    this.speed = 0;
    this.lastT = null;
  }

  /** value in px, t in seconds. */
  filter(value, t) {
    if (this.value === null) {
      this.value = value;
      this.lastT = t;
      return value;
    }
    const dt = Math.max(1e-3, t - this.lastT);
    this.lastT = t;
    const rawSpeed = (value - this.value) / dt;
    this.speed += smoothing(this.dCutoff, dt) * (rawSpeed - this.speed);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed);
    this.value += smoothing(cutoff, dt) * (value - this.value);
    return this.value;
  }
}
