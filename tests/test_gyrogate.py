import json

import numpy as np
import pytest

from server import evaluate, recording
from server.eyebrow import EyebrowDetector
from server.gyrogate import GyroGate
from server.recording import Recorder
from server.rows import GYRO_ROWS, NUM_ROWS
from test_eyebrow import FS, calibrated, emg


def gyro(seconds, fast=(), rest=0.8, fast_dps=150.0):
    """3 x n gyro rows in deg/s: rest noise, plus head turns at (start_s, length_s)."""
    rng = np.random.default_rng(3)
    g = rng.normal(0, rest, (3, int(seconds * FS)))
    for start, length in fast:
        g[0, int(start * FS):int((start + length) * FS)] += fast_dps
    return g


def test_gate_blocks_during_motion_and_150ms_after():
    gate = GyroGate(60, fs=FS)
    blocked = gate.mask(gyro(4, [(2.0, 0.5)]))
    assert gate.units_label == "deg_s"
    assert not blocked[: int(2.0 * FS)].any()
    assert blocked[int(2.0 * FS):int(2.5 * FS)].all()
    end = int(2.5 * FS)
    assert blocked[end:end + 18].all() and not blocked[end + 20:].any()  # 0.15 s hold = 19 samples


def test_gate_detects_rad_s_from_rest_and_latches_deg_s_on_big_values():
    rad = GyroGate(60, fs=FS)
    blocked = rad.mask(np.deg2rad(gyro(4, [(2.0, 0.5)])))
    assert rad.units_label == "rad_s" and blocked[int(2.2 * FS)] and not blocked[int(1.5 * FS)]
    slow_deg = GyroGate(60, fs=FS)
    assert not slow_deg.mask(gyro(4, [(2.0, 0.5)], fast_dps=25)).any()  # a slow 25 deg/s tilt is not a "fast" turn


def test_gated_raise_never_clicks():
    det = calibrated(double_enabled=False)
    x = emg(6, [(1.0, 0.4), (4.0, 0.4)])
    blocked = GyroGate(60, fs=FS).mask(np.hstack([gyro(1, rest=0.8), gyro(6, [(0.9, 0.3)])]))[FS:]
    events = det.feed(x, blocked)
    assert [e["type"] for e in events if e["type"] != "raise"] == ["gated_raise", "click"]


def test_gate_off_changes_nothing():
    pre, neutral, x = emg(2), emg(5), emg(4, [(1.0, 0.4)])

    def fresh():
        det = EyebrowDetector()
        det.feed(pre); det.start_calibration(); det.feed(neutral); det.finish_calibration()
        return det

    plain = fresh().feed(x)
    gated = fresh().feed(x, GyroGate(0, fs=FS).mask(gyro(4, [(0.9, 0.6)])))
    assert plain == gated and any(e["type"] == "click" for e in plain)


def test_evaluate_compares_gate_on_and_off(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(recording, "SESSIONS_DIR", tmp_path)
    rng = np.random.default_rng(1)
    rec = Recorder()
    rec.start({"name": "headmove", "channel": 2, "fs": FS}, detector_n=0)

    def chunk(seconds, loud=False, turning=False):
        data = np.zeros((NUM_ROWS, int(seconds * FS)))
        data[2] = rng.normal(0, 60 if loud else 5, data.shape[1])
        data[list(GYRO_ROWS)] = rng.normal(0, 0.8, (3, data.shape[1]))
        if turning:
            data[GYRO_ROWS[0]] += 150
        rec.append(data)

    rec.mark("neutral", "start"); chunk(5); rec.mark("neutral", "end")
    for _ in range(3):
        rec.mark("eyebrow_raise", "start"); chunk(0.3); chunk(0.3, loud=True); rec.mark("eyebrow_raise", "end"); chunk(2)
    for _ in range(3):  # head turns that also make an EMG burst
        rec.mark("hard_negative_head_move", "start"); chunk(0.3); chunk(0.3, loud=True, turning=True)
        rec.mark("hard_negative_head_move", "end"); chunk(2)
    path = rec.stop({})

    off = evaluate.evaluate(path, k=6.0, gyro_gate=0)
    on = evaluate.evaluate(path, k=6.0, gyro_gate=60)
    assert off["single_hit"] == on["single_hit"] == "3/3"
    assert off["false_clicks"] == 3 and off["fp_head_move"] == 3
    assert on["false_clicks"] == 0 and on["gated_raises"] == 3

    evaluate.main([str(path), "--gyro-gate", "0", "60"])
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    summary = {l["gyro_gate"]: l for l in lines if l.get("summary")}
    assert summary[0]["false_clicks_per_min"] > 0 and summary[60]["false_clicks_per_min"] == 0


def test_mask_must_match_the_samples():
    with pytest.raises(ValueError):
        calibrated().feed(emg(1), np.zeros(10, dtype=bool))


def test_nan_gyro_samples_are_ignored():
    gate = GyroGate(60, fs=FS)
    g = gyro(4, [(2.0, 0.5)])
    g[:, :50] = np.nan  # garbled start must not decide the units
    blocked = gate.mask(g)
    assert gate.units_label == "deg_s"
    assert blocked[int(2.2 * FS)] and not blocked[int(1.5 * FS)]
