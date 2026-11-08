"""Streaming eyebrow-raise detector for one forehead EMG channel.

bandpass -> RMS envelope -> per-user threshold (neutral median + k * MAD)
-> a raise is a burst above threshold lasting min_s..max_s
-> one raise = "click", two raises within double_window_s = "drag_toggle".
Time is counted in samples, so replaying a recording is deterministic.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, fields
from math import sqrt
from pathlib import Path

import numpy as np
from scipy import signal

PARAMS_PATH = Path(__file__).resolve().parent.parent / "data" / "detector_params.json"


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
    max_threshold: float = 0.0  # ceiling on the threshold (0 = none): a noisy rest can't push it above real raises

    @classmethod
    def load(cls, path: Path = PARAMS_PATH, **overrides) -> "DetectorParams":
        """Defaults, replaced by tuned values from server.train if that file exists."""
        values: dict = {}
        if path.exists():
            saved = json.loads(path.read_text()).get("params", {})
            names = {f.name for f in fields(cls)}
            values = {k: tuple(v) if k == "band_hz" else v for k, v in saved.items() if k in names}
        return cls(**{**values, **overrides})


def quiet_part(values: np.ndarray, window: int) -> np.ndarray:
    """The calmer half of a "relax" recording, judged in `window`-sample chunks.

    People fidget, swallow or speak during the rest period. Those bursts blow up the MAD,
    and k * MAD then sits above every real raise (session 20261108-102647: 0/20 detected).
    Keeping the quieter half of the chunks drops the bursts and barely changes a clean rest.
    """
    chunks = [values[i:i + window] for i in range(0, len(values) - window + 1, window)]
    if len(chunks) < 2:
        return values
    levels = np.array([np.median(c) for c in chunks])
    keep = levels <= np.median(levels)
    return np.concatenate([c for c, k in zip(chunks, keep) if k])


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
        self._last_end = -(10**9)
        self._pending: list[int] = []

    @property
    def threshold(self) -> float | None:
        if self.baseline is None:
            return None
        median, mad = self.baseline
        thr = max(median + self.p.k * mad, 2.0 * median)
        return min(thr, self.p.max_threshold) if self.p.max_threshold > 0 else thr

    def start_calibration(self) -> None:
        self._calib = []

    def finish_calibration(self) -> float | None:
        values = np.asarray(self._calib or [])
        self._calib = None
        if values.size < self.p.fs:  # need at least 1 s of neutral
            return self.threshold
        values = quiet_part(values, int(self.p.fs))
        median = float(np.median(values))
        self.baseline = (median, float(np.median(np.abs(values - median))) * 1.4826)
        return self.threshold

    def feed(self, values: np.ndarray) -> list[dict]:
        """Feed new samples; returns events: raise / click / drag_toggle with their sample index."""
        if len(values) == 0:
            return []
        filtered, self.zi = signal.sosfilt(self.sos, np.asarray(values, dtype=float), zi=self.zi)
        events: list[dict] = []
        thr = self.threshold
        fs = self.p.fs
        for v in filtered:
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
                elif env < max(self.p.release * thr, self.p.release_of_peak * self._burst_peak):
                    duration = (self.n - self._burst_start) / fs
                    self._burst_start = None
                    self._last_end = self.n
                    if self.p.min_s <= duration <= self.p.max_s:
                        events.append({"type": "raise", "sample": self.n, "duration_s": round(duration, 3)})
                        self._pending.append(self.n)
                else:
                    self._burst_peak = max(self._burst_peak, env)
            if len(self._pending) >= 2:
                events.append({"type": "drag_toggle", "sample": self.n})
                self._pending.clear()
            elif self._pending and (self.n - self._pending[0]) > self.p.double_window_s * fs:
                events.append({"type": "click", "sample": self.n})
                self._pending.clear()
        self.envelope = sqrt(self.env2)
        return events

    def state(self) -> dict:
        return {
            "params": asdict(self.p),
            "baseline": self.baseline,
            "threshold": self.threshold,
        }
