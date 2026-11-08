"""Synthetic Knight IMU stream for a head doing known movements with the sensor mounted at an angle."""

from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation as R

from server.rows import ACCEL_ROWS, GYRO_ROWS, NUM_ROWS, TIMESTAMP_ROW

FS = 125


def simulate(yaw_deg, pitch_deg, mount: R, gyro_bias=(0.0, 0.0, 0.0), gyro_noise=0.0, seed=0) -> np.ndarray:
    """yaw_deg/pitch_deg: head turn (left +) and nod (down +) per sample, in degrees.

    Head orientation = turn about world vertical, then nod about the head's ear-to-ear axis.
    The sensor sits on the head rotated by `mount`. Returns BrainFlow-shaped rows (22 x n).
    """
    rng = np.random.default_rng(seed)
    yaw, pitch = np.asarray(yaw_deg, float), np.asarray(pitch_deg, float)
    n = yaw.size
    head = R.from_euler("ZX", np.column_stack([yaw, pitch]), degrees=True)
    sensor = head * mount
    data = np.zeros((NUM_ROWS, n))
    # accelerometer at rest measures "up" (specific force) in the sensor frame
    data[list(ACCEL_ROWS)] = sensor.inv().apply([0, 0, 1]).T
    # body-frame angular velocity from consecutive orientations
    rel = sensor[:-1].inv() * sensor[1:]
    omega = np.vstack([rel.as_rotvec() * FS, np.zeros(3)])
    omega += np.asarray(gyro_bias) + rng.normal(0, gyro_noise, omega.shape)
    data[list(GYRO_ROWS)] = omega.T
    data[TIMESTAMP_ROW] = np.arange(n) / FS
    return data


def hold(seconds, value=0.0):
    return np.full(int(seconds * FS), float(value))


def ramp(seconds, start, end):
    return np.linspace(start, end, int(seconds * FS))


def nods(seconds, amplitude=25.0, hz=0.5):
    t = np.arange(int(seconds * FS)) / FS
    return amplitude * np.sin(2 * np.pi * hz * t)
