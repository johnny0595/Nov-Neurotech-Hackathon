import numpy as np
import pytest

from server import app as app_module
from server.app import Hub, parse_channels
from server.merge import EventMerger, sources_for
from server.rows import EXG_ROWS, GYRO_ROWS, NUM_ROWS

FS = 125


def click(sample, **extra):
    return {"type": "click", "sample": sample, **extra}


def test_same_action_on_both_channels_within_200ms_counts_once():
    merged = EventMerger(FS).merge({"brow": [click(1000)], "jaw": [click(1000 + 20)]})  # 160 ms apart
    assert [(e["type"], e["source"]) for e in merged] == [("click", "brow")]


def test_actions_more_than_200ms_apart_both_count():
    merged = EventMerger(FS).merge({"brow": [click(1000)], "jaw": [click(1000 + 38)]})  # 304 ms apart
    assert [e["source"] for e in merged] == ["brow", "jaw"]


def test_dedupe_spans_batches_and_never_merges_one_channel_with_itself():
    m = EventMerger(FS)
    assert len(m.merge({"brow": [click(500)], "jaw": []})) == 1
    assert m.merge({"brow": [], "jaw": [click(510)]}) == []  # next batch, 80 ms later, other channel
    assert len(m.merge({"brow": [click(520)], "jaw": []})) == 1  # same channel: a real second click
    raise_and_click = m.merge({"jaw": [{"type": "raise", "sample": 900}, click(900)]})
    assert [e["type"] for e in raise_and_click] == ["raise", "click"]  # different types are never merged


def test_input_modes_pick_their_detectors():
    both = ["brow", "jaw"]
    assert sources_for("brow", both) == ["brow"]
    assert sources_for("jaw", both) == ["jaw"]
    assert sources_for("either", both) == both
    assert sources_for("keyboard-switch", both) == []
    assert sources_for("jaw", ["brow"]) == []


def test_parse_channels():
    assert parse_channels("2,3") == {"brow": 2, "jaw": 3}
    assert parse_channels("8") == {"brow": 8}
    for bad in ("2,2", "0", "2,3,4", "x"):
        with pytest.raises(Exception):
            parse_channels(bad)


class NullSource:
    def connect(self):
        pass

    def read(self):
        return np.zeros((NUM_ROWS, 0))

    def close(self):
        pass


def two_channel_hub(monkeypatch, tmp_path, mode):
    monkeypatch.setattr(app_module, "PROFILE_PATH", tmp_path / "profile.json")
    hub = Hub(NullSource(), 2, double_enabled=False, gyro_gate=0, channels={"brow": 2, "jaw": 3})
    hub.input_mode = mode
    rng = np.random.default_rng(4)

    def batch(seconds, brow=False, jaw=False):
        b = np.zeros((NUM_ROWS, int(seconds * FS)))
        b[EXG_ROWS[1]] = rng.normal(0, 60 if brow else 5, b.shape[1])
        b[EXG_ROWS[2]] = rng.normal(0, 60 if jaw else 5, b.shape[1])
        b[list(GYRO_ROWS)] = rng.normal(0, 0.5, (3, b.shape[1]))
        return hub.process(b)

    batch(2)
    for name in ("brow", "jaw"):  # each detector is calibrated on its own
        hub.detectors[name].start_calibration()
    batch(5)
    for name in ("brow", "jaw"):
        hub.detectors[name].finish_calibration()
    return batch


@pytest.mark.parametrize("mode, expected", [
    ("brow", ["brow"]),                 # only the forehead counts
    ("jaw", ["jaw"]),                   # only the jaw counts
    ("either", ["brow", "jaw"]),        # both count, one click each
    ("keyboard-switch", []),            # the EMG makes no clicks at all
])
def test_hub_input_modes(monkeypatch, tmp_path, mode, expected):
    batch = two_channel_hub(monkeypatch, tmp_path, mode)
    events = batch(0.5) + batch(0.4, brow=True) + batch(1.0) + batch(0.4, jaw=True) + batch(1.0)
    assert [e["source"] for e in events if e["type"] == "click"] == expected


def test_hub_either_mode_merges_a_simultaneous_raise_and_clench(monkeypatch, tmp_path):
    batch = two_channel_hub(monkeypatch, tmp_path, "either")
    events = batch(0.5) + batch(0.4, brow=True, jaw=True) + batch(1.0)
    assert len([e for e in events if e["type"] == "click"]) == 1


def test_profile_keeps_each_detector_and_the_input(monkeypatch, tmp_path):
    two_channel_hub(monkeypatch, tmp_path, "either")
    hub = Hub(NullSource(), 2, channels={"brow": 2, "jaw": 3})
    hub.detectors["jaw"].p.k = 9.5
    hub.detectors["jaw"].baseline = (1.0, 0.2)
    hub.input_mode = "jaw"
    hub._save_profile()
    again = Hub(NullSource(), 2, channels={"brow": 2, "jaw": 3})
    assert again.detectors["jaw"].baseline == (1.0, 0.2) and again.detectors["jaw"].p.k == 9.5
    assert again.input_mode == "jaw" and again.snapshot()["input"] == "jaw"
    assert set(again.snapshot()["detectors"]) == {"brow", "jaw"}
