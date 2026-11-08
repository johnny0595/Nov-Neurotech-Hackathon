"""Orientation estimation for Knight IMU diagnostics."""

from __future__ import annotations

from dataclasses import dataclass
from math import atan2, asin, cos, degrees, radians, sin

import numpy as np

from .rows import accel, gyro, mag


@dataclass
class ImuConfig:
    use_magnetometer: bool = False
    gyro_units: str = "auto"
    beta: float = 0.2
    swap_pitch_roll: bool = False
    invert_roll: bool = False


@dataclass(frozen=True)
class OrientationSample:
    quaternion: tuple[float, float, float, float]
    roll: float
    pitch: float
    yaw: float
    raw_roll: float
    raw_pitch: float
    raw_yaw: float
    dt: float
    accel: tuple[float, float, float]
    gyro: tuple[float, float, float]
    mag: tuple[float, float, float]
    calibration_offset: tuple[float, float, float, float]


def _normalize_quat(q: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(q))
    if norm <= 0:
        return np.array([1.0, 0.0, 0.0, 0.0], dtype=float)
    return q / norm


def quat_conjugate(q: np.ndarray) -> np.ndarray:
    return np.array([q[0], -q[1], -q[2], -q[3]], dtype=float)


def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        dtype=float,
    )


def quat_to_euler_degrees(q: np.ndarray) -> tuple[float, float, float]:
    w, x, y, z = _normalize_quat(q)
    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = atan2(sinr_cosp, cosr_cosp)

    sinp = 2.0 * (w * y - z * x)
    pitch = asin(float(np.clip(sinp, -1.0, 1.0)))

    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = atan2(siny_cosp, cosy_cosp)
    return degrees(roll), degrees(pitch), degrees(yaw)


def euler_to_quat(roll: float, pitch: float, yaw: float) -> np.ndarray:
    cr = cos(roll * 0.5)
    sr = sin(roll * 0.5)
    cp = cos(pitch * 0.5)
    sp = sin(pitch * 0.5)
    cy = cos(yaw * 0.5)
    sy = sin(yaw * 0.5)
    return _normalize_quat(
        np.array(
            [
                cr * cp * cy + sr * sp * sy,
                sr * cp * cy - cr * sp * sy,
                cr * sp * cy + sr * cp * sy,
                cr * cp * sy - sr * sp * cy,
            ],
            dtype=float,
        )
    )


# Gyro bias handling. Without a magnetometer nothing corrects left/right heading, so a
# tiny constant gyro offset makes "straight ahead" slide by several degrees a minute.
# Measured 2026-11-07: ~5 deg/min of drift with the head still.
# Single gyro samples jitter by 0.04-0.1 rad/s even when still, so stillness is judged on a
# ~0.4 s average. The raw bias itself was 0.03-0.04 rad/s (~2 deg/s) on our board.
# Stillness = the 0.4 s and 2 s gyro averages agree (nothing is changing). It deliberately does
# NOT compare against the bias estimate: when it did, one bad early estimate made the head look
# "moving" forever, so the bias was never corrected (one recording ran away by 500 deg).
STILL_SMOOTH_S = 0.4
STILL_SLOW_S = 2.0
STILL_STEADY_RAD_S = 0.035  # |fast avg - slow avg| below this = steady
STILL_SANITY_RAD_S = 0.2  # ...and not wildly far from the current bias (a slow, steady turn)
STILL_SECONDS = 0.5  # how long it must stay still before the bias is updated
# The bias is the average raw gyro over all still time, with about a minute of memory so it
# follows slow temperature changes. A plain running average converges much faster than the
# 4 s exponential average tried first, which left ~0.003 rad/s (~11 deg/min of drift) after
# an 8 s hold. In simulation the error falls roughly as noise / sqrt(still samples).
BIAS_MEMORY_SAMPLES = 125 * 60
SAVED_BIAS_WEIGHT = 125 * 5  # a bias loaded from disk counts like 5 s of still data
FAST_SETTLE_SAMPLES = 250  # ~2 s of high filter gain at start-up so tilt settles quickly
FAST_SETTLE_GAIN = 2.0


class OrientationEstimator:
    def __init__(self, config: ImuConfig | None = None) -> None:
        self.config = config or ImuConfig()
        self.q = np.array([1.0, 0.0, 0.0, 0.0], dtype=float)
        self.offset = np.array([1.0, 0.0, 0.0, 0.0], dtype=float)
        self.last_timestamp: float | None = None
        self.gyro_bias = np.zeros(3)
        self.track_bias = True
        self.last_gyro_raw = np.zeros(3)  # rad/s, before bias removal
        self._still_samples = 0
        self._bias_weight = 0
        self.still = False  # head currently still (bias being learned)
        self._gyro_avg = np.zeros(3)
        self._gyro_slow = np.zeros(3)
        self._samples = 0
        self._madgwick = None
        self._load_madgwick()

    def restart_settling(self) -> None:
        """After a reconnect: settle tilt quickly again (the board restarted)."""
        self._samples = 0

    def set_gyro_bias(self, bias, weight: int = SAVED_BIAS_WEIGHT) -> None:
        self.gyro_bias = np.asarray(bias, dtype=float).copy()
        self._bias_weight = weight
        self._still_samples = 0

    def _remove_bias(self, gyr: np.ndarray, dt: float) -> np.ndarray:
        self.last_gyro_raw = gyr
        corrected = gyr - self.gyro_bias
        self._gyro_avg += min(1.0, dt / STILL_SMOOTH_S) * (gyr - self._gyro_avg)
        self._gyro_slow += min(1.0, dt / STILL_SLOW_S) * (gyr - self._gyro_slow)
        steady = float(np.linalg.norm(self._gyro_avg - self._gyro_slow)) < STILL_STEADY_RAD_S
        sane = self._bias_weight == 0 or float(np.linalg.norm(self._gyro_avg - self.gyro_bias)) < STILL_SANITY_RAD_S
        if self.track_bias and self._samples > STILL_SLOW_S * 125 and steady and sane:
            self._still_samples += 1
            self.still = self._still_samples * dt >= STILL_SECONDS
            if self.still:
                if self._bias_weight == 0:
                    # start from the smoothed average, not one noisy sample: a bad first value
                    # would fail the stillness check from then on and never get corrected
                    self.gyro_bias = self._gyro_slow.copy()
                    self._bias_weight = int(STILL_SLOW_S * 125)
                self._bias_weight = min(self._bias_weight + 1, BIAS_MEMORY_SAMPLES)
                self.gyro_bias += (gyr - self.gyro_bias) / self._bias_weight
                corrected = gyr - self.gyro_bias
        else:
            self._still_samples = 0
            self.still = False
        return corrected

    @property
    def backend(self) -> str:
        return "ahrs.Madgwick" if self._madgwick is not None else "accelerometer fallback"

    def _load_madgwick(self) -> None:
        try:
            from ahrs.filters import Madgwick

            self._madgwick = Madgwick(gain=self.config.beta)
        except Exception:
            self._madgwick = None

    def update_config(self, config: ImuConfig) -> None:
        self.config = config
        if self._madgwick is not None:
            self._madgwick.gain = config.beta

    def zero_level(self) -> None:
        self.offset = quat_conjugate(self.q)

    def update(self, raw: np.ndarray) -> OrientationSample:
        ts = float(raw[20])
        dt = 1.0 / 125.0
        if self.last_timestamp is not None:
            measured = ts - self.last_timestamp
            if 0.001 <= measured <= 0.200:
                dt = measured
        self.last_timestamp = ts

        acc = accel(raw)
        gyr = self._remove_bias(self._gyro_rad_s(gyro(raw)), dt)
        magnetic = mag(raw)
        self._samples += 1
        if self._madgwick is not None and self._samples in (1, FAST_SETTLE_SAMPLES):
            self._madgwick.gain = FAST_SETTLE_GAIN if self._samples == 1 else self.config.beta
        self.q = self._update_quaternion(acc, gyr, magnetic, dt)

        raw_roll, raw_pitch, raw_yaw = quat_to_euler_degrees(self.q)
        corrected_q = _normalize_quat(quat_multiply(self.offset, self.q))
        roll, pitch, yaw = quat_to_euler_degrees(corrected_q)
        if self.config.swap_pitch_roll:
            roll, pitch = pitch, roll
        if self.config.invert_roll:
            roll = -roll

        return OrientationSample(
            quaternion=tuple(float(x) for x in corrected_q),
            roll=float(roll),
            pitch=float(pitch),
            yaw=float(yaw),
            raw_roll=float(raw_roll),
            raw_pitch=float(raw_pitch),
            raw_yaw=float(raw_yaw),
            dt=float(dt),
            accel=tuple(float(x) for x in acc),
            gyro=tuple(float(x) for x in gyr),
            mag=tuple(float(x) for x in magnetic),
            calibration_offset=tuple(float(x) for x in self.offset),
        )

    def _gyro_rad_s(self, gyr: np.ndarray) -> np.ndarray:
        units = self.config.gyro_units
        if units == "deg_s":
            return np.deg2rad(gyr)
        if units == "rad_s":
            return gyr.astype(float)
        # Heuristic for unknown firmware units: human head angular velocity in rad/s
        # is usually single digits, while deg/s commonly reaches tens or hundreds.
        if float(np.linalg.norm(gyr)) > 20.0:
            return np.deg2rad(gyr)
        return gyr.astype(float)

    def _update_quaternion(
        self, acc: np.ndarray, gyr: np.ndarray, magnetic: np.ndarray, dt: float
    ) -> np.ndarray:
        if np.linalg.norm(acc) <= 0:
            return self.q
        if self._madgwick is not None:
            try:
                if self.config.use_magnetometer and np.linalg.norm(magnetic) > 0:
                    q = self._madgwick.updateMARG(self.q, gyr=gyr, acc=acc, mag=magnetic, dt=dt)
                else:
                    q = self._madgwick.updateIMU(self.q, gyr=gyr, acc=acc, dt=dt)
                return _normalize_quat(np.asarray(q, dtype=float))
            except Exception:
                pass

        ax, ay, az = acc
        roll = atan2(ay, az)
        pitch = atan2(-ax, (ay * ay + az * az) ** 0.5)
        _, _, yaw_degrees = quat_to_euler_degrees(self.q)
        return euler_to_quat(roll, pitch, radians(yaw_degrees))

