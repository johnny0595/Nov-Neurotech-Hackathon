import asyncio

import numpy as np

from server import app as app_module
from server.head_axes import HeadAxes, HeadTracker
from server.orientation import OrientationEstimator
from server.rows import ACCEL_ROWS, GYRO_ROWS, NUM_ROWS, TIMESTAMP_ROW

FS = 125


def still_head(seconds, bias_rad_s, noise=0.05, seed=0):
    """A motionless sensor: gravity on z, a constant gyro bias on the vertical axis plus noise."""
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    data = np.zeros((NUM_ROWS, n))
    data[ACCEL_ROWS[2]] = 1.0
    data[list(GYRO_ROWS)] = rng.normal(0, noise, (3, n)) + np.array(bias_rad_s)[:, None]
    data[TIMESTAMP_ROW] = np.arange(n) / FS
    return data


def heading_drift_deg(est, data, zero_at_s=5.0):
    tr = HeadTracker()
    for i in range(data.shape[1]):
        o = est.update(data[:, i])
        tr.update(est.q, np.array(o.gyro), o.dt)  # no auto-recenter: measure the raw drift
        if i == int(zero_at_s * FS):
            est.zero_level()
            tr.zero()
    return abs(tr.raw_x())


def test_bias_tracking_stops_heading_drift():
    bias = [0.0, 0.0, 0.035]  # ~2 deg/s, like the real board
    old = OrientationEstimator()
    old.track_bias = False
    assert heading_drift_deg(old, still_head(65, bias)) > 60  # free-runs about 2 deg/s

    new = OrientationEstimator()
    # zero after 10 s, like the calibration's "hold still" step; the tracker has settled by then
    assert heading_drift_deg(new, still_head(70, bias), zero_at_s=10) < 3
    assert np.allclose(new.gyro_bias, bias, atol=0.01)


def test_saved_bias_survives_reload(tmp_path):
    axes = HeadAxes(np.array([1.0, 0, 0]), np.array([0, 0, 1.0]), 1.0, -1.0, gyro_bias=[0.01, -0.02, 0.03])
    axes.save(tmp_path / "axes.json")
    assert np.allclose(HeadAxes.load(tmp_path / "axes.json").gyro_bias, [0.01, -0.02, 0.03])


class StallingSource:
    """Delivers data, then goes silent like the board stuck at 'Scanning for IMU...'."""

    def __init__(self):
        self.connects = 0
        self.reads = 0

    def connect(self):
        self.connects += 1

    def read(self):
        self.reads += 1
        if self.reads <= 3:
            return still_head(0.1, [0, 0, 0])
        return np.zeros((NUM_ROWS, 0))

    def close(self):
        pass


def test_stall_is_reported_and_reconnect_attempted(monkeypatch):
    monkeypatch.setattr(app_module, "STALL_SECONDS", 0.1)
    monkeypatch.setattr(app_module, "RECONNECT_EVERY_S", 0.1)
    source = StallingSource()
    hub = app_module.Hub(source, channel=8)
    statuses = []

    async def broadcast(message):
        statuses.append(message["status"])

    hub.broadcast = broadcast

    async def run_briefly():
        try:
            await asyncio.wait_for(hub.run(), timeout=0.6)
        except asyncio.TimeoutError:
            pass

    asyncio.run(run_briefly())
    assert "live" in statuses
    assert any("stopped sending data" in s for s in statuses)
    assert source.connects >= 2  # the first connect, then at least one automatic reconnect
