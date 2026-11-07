import numpy as np

from server.eyebrow import EyebrowDetector

FS = 125


def emg(seconds, bursts=(), rng=np.random.default_rng(0)):
    """Quiet white noise with loud bursts at (start_s, length_s), plus slow drift and blink-like bumps."""
    n = int(seconds * FS)
    x = rng.normal(0, 5, n) + 200 * np.sin(np.arange(n) / FS * 2 * np.pi * 0.3)
    for start, length in bursts:
        a, b = int(start * FS), int((start + length) * FS)
        x[a:b] += rng.normal(0, 60, b - a)
    return x


def calibrated():
    det = EyebrowDetector()
    det.feed(emg(2))
    det.start_calibration()
    det.feed(emg(5))
    assert det.finish_calibration() is not None
    return det


def types(events):
    return [e["type"] for e in events if e["type"] != "raise"]


def test_single_raise_is_one_click():
    assert types(calibrated().feed(emg(4, [(1.0, 0.4)]))) == ["click"]


def test_two_quick_raises_are_one_drag_toggle():
    assert types(calibrated().feed(emg(4, [(1.0, 0.3), (1.5, 0.3)]))) == ["drag_toggle"]


def test_two_spaced_raises_are_two_clicks():
    assert types(calibrated().feed(emg(6, [(1.0, 0.3), (3.5, 0.3)]))) == ["click", "click"]


def test_quiet_and_slow_blink_bumps_give_nothing():
    x = emg(10)
    t = np.arange(x.size) / FS
    x += 150 * np.exp(-(((t % 2.0) - 1.0) ** 2) / 0.01)  # ~0.2 s blink/EOG bumps, low frequency
    assert calibrated().feed(x) == []


def test_uncalibrated_detector_never_fires():
    assert EyebrowDetector().feed(emg(4, [(1.0, 0.4)])) == []
