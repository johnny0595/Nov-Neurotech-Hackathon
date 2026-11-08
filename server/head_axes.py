"""Head position from the headset IMU, however the sensor is mounted.

Left/right (x) is the head's turning about TRUE VERTICAL: the bias-corrected gyro
projected onto the gravity direction, integrated over time. A nod is a rotation
about a horizontal axis, so it contributes nothing to x. (The first version
projected the whole 3-D rotation onto a learned axis, and every nod leaked a
little into left/right, which added up into sideways drift.)

Up/down (y) comes straight from gravity: the angle, about the learned nod axis,
between "up" now and "up" at the last Zero. Gravity is absolute, so y can't drift.

Calibration: nod and shake for a few seconds (the nod axis comes from the gyro by
SVD; the shake is only checked), then "look up and hold" and "look right and hold"
fix the signs.
"""

from __future__ import annotations

import json
from math import atan2, degrees
from pathlib import Path

import numpy as np

AXES_PATH = Path(__file__).resolve().parent.parent / "data" / "head_axes.json"

MIN_MOTION_RAD_S = 0.15  # RMS angular speed; below this the user barely moved
MIN_ONE_AXIS_RATIO = 1.8  # largest / second singular value; below this the motion wasn't one clean axis
MIN_HOLD_DEG = 4.0  # "look up/right and hold" must actually turn at least this far
# Left/right has no absolute reference (the magnetometer on our board is swamped by a fixed
# offset), so leftover gyro drift is cleaned up by easing x back to centre while the head is
# still and already close to centre. Bigger, deliberate holds are left alone.
RECENTER_WINDOW_DEG = 6.0
RECENTER_TAU_S = 8.0


def gravity_up(q: np.ndarray) -> np.ndarray:
    """World 'up' expressed in the sensor frame, from the orientation filter's quaternion (w, x, y, z).

    Convention checked against the accelerometer on a real recording (mean dot product 1.0).
    """
    w, x, y, z = (float(v) for v in q)
    v = np.array([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)])
    return v / (np.linalg.norm(v) or 1.0)


def signed_angle_about(axis: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    """Angle in degrees from a to b, measured around axis (both projected onto the plane normal to it)."""
    pa = a - (a @ axis) * axis
    pb = b - (b @ axis) * axis
    return degrees(atan2(float(axis @ np.cross(pa, pb)), float(pa @ pb)))


def principal_axis(gyro: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Unit axis of the dominant rotation, the one-axis ratio, and RMS speed."""
    g = np.asarray(gyro, dtype=float).reshape(-1, 3)
    _, s, vt = np.linalg.svd(g, full_matrices=False)
    ratio = float(s[0] / max(s[1], 1e-9))
    rms = float(np.sqrt(np.mean(np.sum(g * g, axis=1))))
    return vt[0], ratio, rms


class HeadTracker:
    """Running head position. update() every IMU sample; zero() when looking straight ahead."""

    def __init__(self) -> None:
        self.heading = 0.0  # degrees turned about vertical since start (raw sign)
        self.heading0 = 0.0
        self.g: np.ndarray | None = None
        self.g0: np.ndarray | None = None
        self.nod: np.ndarray | None = None  # learned nod axis; set after calibration

    def update(self, q: np.ndarray, gyro_rad_s: np.ndarray, dt: float, still: bool = False) -> None:
        self.g = gravity_up(q)
        vertical = self.g
        if self.nod is not None:
            # Drop any part of "vertical" along the nod axis, so rotation about the nod axis
            # (a nod) adds exactly nothing to left/right, even while the gravity estimate lags.
            v = self.g - (self.g @ self.nod) * self.nod
            vertical = v / (np.linalg.norm(v) or 1.0)
        self.heading += degrees(float(np.asarray(gyro_rad_s) @ vertical)) * dt
        if self.g0 is None:
            self.g0 = self.g.copy()
        if still and abs(self.raw_x()) < RECENTER_WINDOW_DEG:
            self.heading0 += self.raw_x() * min(1.0, dt / RECENTER_TAU_S)

    def zero(self) -> None:
        self.heading0 = self.heading
        self.g0 = None if self.g is None else self.g.copy()

    def raw_x(self) -> float:
        return self.heading - self.heading0

    def xy(self, axes: "HeadAxes") -> tuple[float, float] | None:
        """Head position in degrees: x = right positive, y = down positive."""
        if not axes.ready or self.g is None or self.g0 is None:
            return None
        return axes.sign_x * self.raw_x(), axes.sign_y * signed_angle_about(axes.nod, self.g0, self.g)


class HeadAxes:
    def __init__(self, nod=None, turn=None, sign_x: float = 1.0, sign_y: float = 1.0, gyro_bias=None) -> None:
        self.nod = None if nod is None else np.asarray(nod, dtype=float)
        self.turn = None if turn is None else np.asarray(turn, dtype=float)
        self.sign_x = float(sign_x)
        self.sign_y = float(sign_y)
        self.gyro_bias = None if gyro_bias is None else np.asarray(gyro_bias, dtype=float)  # rad/s, saved so restarts start drift-free

    @property
    def ready(self) -> bool:
        return self.nod is not None

    @classmethod
    def fit(cls, phases: dict) -> tuple["HeadAxes | None", dict]:
        """phases: 'nod'/'turn' -> gyro samples (rad/s); 'up' -> gravity vectors while looking up,
        'up_ref' -> gravity at the Zero just before; 'right' -> raw heading (deg) while looking right."""
        report: dict = {}
        problems: list[str] = []
        for name in ("nod", "turn", "up", "right"):
            if len(phases.get(name, [])) < 20:
                problems.append(f"not enough data for '{name}'")
        if phases.get("up_ref") is None:
            problems.append("no reference for 'up'")
        if problems:
            return None, {"ok": False, "problems": problems}

        nod, nod_ratio, nod_rms = principal_axis(np.array(phases["nod"]))
        turn, turn_ratio, turn_rms = principal_axis(np.array(phases["turn"]))
        between = degrees(np.arccos(min(1.0, abs(float(nod @ turn)))))
        report.update(
            nod_clean=round(nod_ratio, 1), turn_clean=round(turn_ratio, 1),
            nod_speed=round(nod_rms, 2), turn_speed=round(turn_rms, 2),
            angle_between_deg=round(between, 1),
        )
        if nod_rms < MIN_MOTION_RAD_S:
            problems.append("the nod was too small; nod a bit more")
        if turn_rms < MIN_MOTION_RAD_S:
            problems.append("the head shake was too small; turn a bit more")
        if nod_ratio < MIN_ONE_AXIS_RATIO:
            problems.append("the nod wasn't a clean up/down movement")
        if turn_ratio < MIN_ONE_AXIS_RATIO:
            problems.append("the head shake wasn't a clean left/right movement")
        if between < 45:
            problems.append("the nod and the head shake looked like the same movement")

        # Signs: looking up should give negative y, looking right positive x.
        up_g = np.array(phases["up"])
        up_g = up_g[-max(10, len(up_g) // 2):].mean(axis=0)
        up_raw = signed_angle_about(nod, np.asarray(phases["up_ref"], dtype=float), up_g / np.linalg.norm(up_g))
        right = np.array(phases["right"], dtype=float)
        right_raw = float(right[-max(10, len(right) // 2):].mean())
        report.update(look_up_deg=round(abs(up_raw), 1), look_right_deg=round(abs(right_raw), 1))
        if abs(up_raw) < MIN_HOLD_DEG:
            problems.append("didn't see you look up; look further up and hold")
        if abs(right_raw) < MIN_HOLD_DEG:
            problems.append("didn't see you look right; turn further right and hold")

        report["ok"] = not problems
        if problems:
            report["problems"] = problems
            return None, report
        return cls(nod, turn, sign_x=1.0 if right_raw > 0 else -1.0, sign_y=-1.0 if up_raw > 0 else 1.0), report

    def save(self, path: Path = AXES_PATH, report: dict | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"version": 2, "nod": self.nod.tolist(), "turn": self.turn.tolist(),
                "sign_x": self.sign_x, "sign_y": self.sign_y, "report": report or {}}
        if self.gyro_bias is not None:
            data["gyro_bias"] = self.gyro_bias.tolist()
        path.write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls, path: Path = AXES_PATH) -> "HeadAxes":
        if not path.exists():
            return cls()
        data = json.loads(path.read_text())
        if data.get("version") != 2:  # the first version's axes don't mean the same thing: recalibrate
            return cls(gyro_bias=data.get("gyro_bias"))
        return cls(data["nod"], data["turn"], data["sign_x"], data["sign_y"], data.get("gyro_bias"))
