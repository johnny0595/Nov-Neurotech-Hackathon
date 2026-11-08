"""Streaming eyebrow-raise detector for one forehead EMG channel.

bandpass -> RMS envelope -> per-user threshold (neutral median + k * MAD)
-> a raise is a burst above threshold lasting min_s..max_s
-> one raise = "click", two raises within double_window_s = "drag_toggle".
With double_enabled=False every valid raise is a "click" the moment it ends (no double_window_s wait)
and "drag_toggle" is never emitted.
An optional per-sample "blocked" mask (see gyrogate.py) drops any raise whose burst overlaps it;
those come out as "gated_raise" instead, so they never become clicks.
Every click carries the raise's duration_s, and delay_s = how long after the raise ended it was emitted
(0 in single mode), so the page can hit-test where the cursor was just before the raise began.
Time is counted in samples, so replaying a recording is deterministic.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import sqrt

import numpy as np
from scipy import signal


@dataclass
class DetectorParams:
    fs: float = 125.0
    band_hz: tuple[float, float] = (20.0, 50.0)  # frontalis EMG; stays below 60 Hz mains and the 62.5 Hz Nyquist
    envelope_s: float = 0.05  # short so two quick raises don't merge into one burst
    k: float = 6.0  # sensitivity: lower = more sensitive
    release: float = 0.6  # hysteresis: burst ends when envelope < release * threshold ...
    release_of_peak: float = 0.2  # ... or < this fraction of the burst's own peak (separates quick double raises)
    min_s: float = 0.08
    max_s: float = 1.5
    double_window_s: float = 0.8  # second raise must end within this long after the first
    debounce_s: float = 0.1
    double_enabled: bool = True  # False: single raises only, clicks fire immediately


class EyebrowDetector:
    def __init__(self, params: DetectorParams | None = None) -> None:
        self.p = params or DetectorParams()
        self.sos = signal.butter(4, self.p.band_hz, btype="bandpass", fs=self.p.fs, output="sos")
        self.zi = np.zeros((self.sos.shape[0], 2))
        self.alpha = 1.0 / (self.p.envelope_s * self.p.fs)
        self.env2 = 0.0
        self.envelope = 0.0
        self.n = 0
        self.baseline: tuple[float, float] | None = None  # (median, MAD) of neutral envelope
        self._calib: list[float] | None = None
        self._burst_start: int | None = None
        self._burst_peak = 0.0
        self._burst_blocked = False
        self._last_end = -(10**9)
        self._pending: list[tuple[int, float]] = []  # (end sample, duration_s) of raises awaiting a 2nd

    @property
    def threshold(self) -> float | None:
        if self.baseline is None:
            return None
        median, mad = self.baseline
        return max(median + self.p.k * mad, 2.0 * median)

    def start_calibration(self) -> None:
        self._calib = []

    def finish_calibration(self) -> float | None:
        values = np.asarray(self._calib or [])
        self._calib = None
        if values.size < self.p.fs:  # need at least 1 s of neutral
            return self.threshold
        median = float(np.median(values))
        self.baseline = (median, float(np.median(np.abs(values - median))) * 1.4826)
        return self.threshold

    def feed(self, values: np.ndarray, blocked: np.ndarray | None = None) -> list[dict]:
        """Feed new samples; returns events: raise / click / drag_toggle / gated_raise with their sample index.

        blocked: optional bool per sample; a raise whose burst touches a blocked sample is dropped.
        """
        if len(values) == 0:
            return []
        if blocked is None:
            blocked = np.zeros(len(values), dtype=bool)
        elif len(blocked) != len(values):
            raise ValueError(f"blocked mask has {len(blocked)} samples, values has {len(values)}")
        filtered, self.zi = signal.sosfilt(self.sos, np.asarray(values, dtype=float), zi=self.zi)
        events: list[dict] = []
        thr = self.threshold
        fs = self.p.fs
        for v, gated in zip(filtered, blocked):
            self.n += 1
            self.env2 += self.alpha * (v * v - self.env2)
            env = sqrt(self.env2)
            if self._calib is not None:
                self._calib.append(env)
                continue
            if thr is not None:
                if self._burst_start is None:
                    if env > thr and self.n - self._last_end > self.p.debounce_s * fs:
                        self._burst_start = self.n
                        self._burst_peak = env
                        self._burst_blocked = bool(gated)
                elif env < max(self.p.release * thr, self.p.release_of_peak * self._burst_peak):
                    duration = (self.n - self._burst_start) / fs
                    self._burst_start = None
                    self._last_end = self.n
                    if self._burst_blocked or gated:
                        if self.p.min_s <= duration <= self.p.max_s:
                            events.append({"type": "gated_raise", "sample": self.n, "duration_s": round(duration, 3)})
                    elif self.p.min_s <= duration <= self.p.max_s:
                        events.append({"type": "raise", "sample": self.n, "duration_s": round(duration, 3)})
                        if self.p.double_enabled:
                            self._pending.append((self.n, round(duration, 3)))
                        else:
                            events.append({"type": "click", "sample": self.n, "duration_s": round(duration, 3), "delay_s": 0.0})
                else:
                    self._burst_peak = max(self._burst_peak, env)
                    self._burst_blocked |= bool(gated)
            if len(self._pending) >= 2:
                events.append({"type": "drag_toggle", "sample": self.n})
                self._pending.clear()
            elif self._pending and (self.n - self._pending[0][0]) > self.p.double_window_s * fs:
                end, dur = self._pending[0]
                events.append({"type": "click", "sample": self.n, "duration_s": dur, "delay_s": round((self.n - end) / fs, 3)})
                self._pending.clear()
        self.envelope = sqrt(self.env2)
        return events

    def state(self) -> dict:
        return {
            "params": asdict(self.p),
            "baseline": self.baseline,
            "threshold": self.threshold,
        }
