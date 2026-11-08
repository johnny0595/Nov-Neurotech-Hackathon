import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R

from imu_sim import FS, hold, nods, ramp, simulate
from server.head_axes import HeadAxes, HeadTracker
from server.orientation import OrientationEstimator

ROOT = Path(__file__).resolve().parent.parent
TILTED = R.from_euler("xyz", [25, -18, 40], degrees=True)  # roughly how the real sensor sits (~30 deg off)


def run(est, tr, data, on_sample=None, still=True):
    for i in range(data.shape[1]):
        o = est.update(data[:, i])
        tr.update(est.q, np.array(o.gyro), o.dt, still=still and est.still)
        if on_sample:
            on_sample(i)


def calibrate(mount, bias=(0, 0, 0), noise=0.0):
    """Runs the setup page's head calibration on a simulated head. Yaw + = turn left, pitch + = nod down."""
    est, tr = OrientationEstimator(), HeadTracker()
    phases: dict = {}

    def segment(yaw, pitch, collect=None):
        data = simulate(yaw, pitch, mount, bias, noise)
        rows = []
        for i in range(data.shape[1]):
            o = est.update(data[:, i])
            tr.update(est.q, np.array(o.gyro), o.dt)
            if collect == "gyro":
                rows.append(o.gyro)
            elif collect == "g":
                rows.append(tr.g.copy())
            elif collect == "x":
                rows.append(tr.raw_x())
        return rows

    z = lambda s: hold(s)
    segment(z(6), z(6)); est.zero_level(); tr.zero()
    phases["nod"] = segment(z(5), nods(5, 20), "gyro")
    segment(z(2), z(2))
    phases["turn"] = segment(nods(5, 25), z(5), "gyro")
    segment(z(2), z(2)); est.zero_level(); tr.zero()
    phases["up_ref"] = tr.g0.copy()
    phases["up"] = segment(z(1.5), np.concatenate([ramp(0.5, 0, -20), hold(1, -20)]), "g")
    segment(z(1.5), ramp(1.5, -20, 0)); est.zero_level(); tr.zero()
    phases["right"] = segment(np.concatenate([ramp(0.5, 0, -30), hold(1, -30)]), z(1.5), "x")
    segment(ramp(1.5, -30, 0), z(1.5)); est.zero_level(); tr.zero()
    axes, report = HeadAxes.fit(phases)
    if axes is not None:
        tr.nod = axes.nod  # as the server does after a successful calibration
    return axes, report, est, tr


def test_calibration_gives_clean_axes_for_a_tilted_sensor():
    axes, report, est, tr = calibrate(TILTED)
    assert report["ok"], report
    xs, ys = [], []
    look_up = simulate(hold(3), np.concatenate([ramp(1, 0, -20), hold(2, -20)]), TILTED)
    run(est, tr, look_up, lambda i: ys.append(tr.xy(axes)), still=False)
    x, y = ys[-1]
    assert -22 < y < -18 and abs(x) < 1.5  # looking up: y goes negative, x stays put

    est2, tr2 = OrientationEstimator(), HeadTracker()
    data = simulate(np.concatenate([hold(3), ramp(1, 0, -30), hold(2, -30)]), hold(6), TILTED)
    run(est2, tr2, data, lambda i: (est2.zero_level(), tr2.zero()) if i == 2 * FS else None, still=False)
    x, y = tr2.xy(axes)
    assert 28 < x < 32 and abs(y) < 1.5  # looking right: x positive, y stays put


def test_nodding_does_not_move_left_right():
    axes, report, est, tr = calibrate(TILTED)
    # isolate the nod itself: a perfect gyro with bias learning off (a tiny bias picked up during
    # calibration would otherwise add its own slow, nod-independent drift)
    est.track_bias = False
    est.set_gyro_bias([0, 0, 0])
    xs = []
    data = simulate(hold(22), np.concatenate([nods(20, 25), hold(2)]), TILTED)
    run(est, tr, data, lambda i: xs.append(tr.xy(axes)[0]), still=False)
    assert max(abs(v) for v in xs) < 3.0  # small wobble while moving (gravity estimate lags a little)
    assert abs(xs[-1]) < 1.0  # ...but nothing builds up: 20 s of nodding leaves left/right where it was


def test_tiny_movements_are_rejected():
    axes, report, *_ = calibrate(TILTED)
    assert report["ok"]
    phases = {"nod": (np.ones((200, 3)) * 0.001).tolist(), "turn": (np.ones((200, 3)) * 0.001).tolist(),
              "up": [[0, 0, 1.0]] * 50, "up_ref": [0, 0, 1.0], "right": [0.1] * 50}
    axes, report = HeadAxes.fit(phases)
    assert axes is None and not report["ok"]


def test_missing_phase_is_rejected():
    axes, report = HeadAxes.fit({"nod": [[1, 0, 0]] * 50})
    assert axes is None and not report["ok"]


def test_save_and_load(tmp_path):
    axes, report, *_ = calibrate(TILTED)
    axes.gyro_bias = np.array([0.01, 0.02, 0.03])
    axes.save(tmp_path / "axes.json", report)
    loaded = HeadAxes.load(tmp_path / "axes.json")
    assert loaded.ready and np.allclose(loaded.nod, axes.nod) and loaded.sign_x == axes.sign_x
    assert np.allclose(loaded.gyro_bias, [0.01, 0.02, 0.03])
    assert not HeadAxes.load(tmp_path / "missing.json").ready


def test_old_calibration_files_ask_for_recalibration(tmp_path):
    (tmp_path / "axes.json").write_text(json.dumps({"nod": [1, 0, 0], "turn": [0, 0, 1], "gyro_bias": [0.0, 0.0, 0.01]}))
    loaded = HeadAxes.load(tmp_path / "axes.json")
    assert not loaded.ready and np.allclose(loaded.gyro_bias, [0, 0, 0.01])


def test_recorded_session_does_not_drift():
    """Real data: this session ran away by 500 deg when stillness was judged against the bias estimate."""
    d = ROOT / "data/sessions/20261107-195305-jonathan"
    if not d.exists():
        return
    x = np.load(d / "raw.npz")["data"]
    labels = [json.loads(line) for line in (d / "labels.jsonl").read_text().splitlines() if line.strip()]
    neutral = next(lab for lab in labels if lab.get("label") == "neutral")
    end = next(lab for lab in labels if lab.get("label") == "neutral_end")
    est, tr, xs = OrientationEstimator(), HeadTracker(), []

    def each(i):
        if i == neutral["end_sample"] - 1:
            est.zero_level(); tr.zero()
        xs.append(tr.raw_x())

    run(est, tr, x, each)
    xs = np.array(xs)
    drift = xs[end["start_sample"]:end["end_sample"]].mean() - xs[neutral["end_sample"]:neutral["end_sample"] + 60].mean()
    assert abs(drift) < 3
