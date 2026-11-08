"""Gyro gate: block eyebrow events while the head is moving fast, and for hold_s afterwards.

Head movement shakes the forehead electrode and tenses the frontalis, so quick head turns can look
like raises. The gate turns the gyro rows (14-16) into an angular speed in deg/s per sample and
returns a boolean "blocked" mask that EyebrowDetector.feed() uses to drop raises that overlap it.

Units: like orientation.py, the firmware's gyro units are unknown. orientation.py decides per
sample (norm > 20 => deg/s), which would turn a slow 5 deg/s turn into 286 deg/s here. So in
"auto" mode the gate latches instead: deg/s as soon as any norm exceeds 20 (20 rad/s = 1146 deg/s
is not a head), otherwise decided from the first second's median (at rest a deg/s gyro reads
~0.3-3, a rad/s gyro ~0.005-0.05). Nothing is blocked during that first second.
"""

from __future__ import annotations

from math import degrees, isfinite

import numpy as np

DEFAULT_GATE_DPS = 60.0  # slow cursor-steering tilts stay under this; quick turns/nods go over
AUTO_DEG_NORM = 20.0
AUTO_REST_MEDIAN = 0.3


class GyroGate:
    def __init__(self, threshold_dps: float | None = DEFAULT_GATE_DPS, fs: float = 125.0, hold_s: float = 0.15,
                 units: str = "auto") -> None:
        if units not in ("auto", "deg_s", "rad_s"):
            raise ValueError(f"units must be auto, deg_s or rad_s, not {units!r}")
        self.threshold = threshold_dps if threshold_dps else None  # 0 / None = gate off
        self.fs = fs
        self.hold = int(round(hold_s * fs))
        self.units = units
        self.is_deg: bool | None = {"deg_s": True, "rad_s": False}.get(units)
        self._first: list[float] = []
        self._since_fast = 10**9
        self.dps = 0.0  # latest angular speed, for the UI

    def _to_dps(self, norm: float) -> float | None:
        if self.units == "auto":
            if norm > AUTO_DEG_NORM:
                self.is_deg = True  # latch for good
            elif self.is_deg is None:
                self._first.append(norm)
                if len(self._first) < self.fs:
                    return None  # undecided: don't block anything yet
                self.is_deg = float(np.median(self._first)) > AUTO_REST_MEDIAN
        return norm if self.is_deg else degrees(norm)

    def mask(self, gyro_xyz: np.ndarray) -> np.ndarray:
        """gyro_xyz: raw gyro rows, shape (3, n). Returns blocked[n]."""
        norms = np.linalg.norm(np.asarray(gyro_xyz, dtype=float), axis=0)
        blocked = np.zeros(norms.size, dtype=bool)
        for i, norm in enumerate(norms):
            if not isfinite(norm):  # dropped/garbled IMU sample: not "fast", and it can't decide the units
                self._since_fast += 1
                blocked[i] = self._since_fast <= self.hold
                continue
            dps = self._to_dps(float(norm))
            if dps is None:
                continue
            self.dps = dps
            self._since_fast = 0 if self.threshold is not None and dps > self.threshold else self._since_fast + 1
            blocked[i] = self._since_fast <= self.hold
        return blocked

    @property
    def units_label(self) -> str:
        return {True: "deg_s", False: "rad_s", None: "undecided"}[self.is_deg]
