import json

import numpy as np

from server import recording, train
from server.eyebrow import DetectorParams
from server.recording import Recorder
from server.rows import NUM_ROWS

FS = 125


def make_session(tmp_path, seed):
    """Neutral, single raises, double raises, and 'talk' that makes a weaker EMG burst."""
    rng = np.random.default_rng(seed)
    rec = Recorder()
    rec.start({"name": f"syn{seed}", "channel": 2, "fs": FS}, detector_n=0)

    def chunk(seconds, sd=5.0):
        data = np.zeros((NUM_ROWS, int(seconds * FS)))
        data[2] = rng.normal(0, sd, data.shape[1])
        rec.append(data)

    rec.mark("neutral", "start"); chunk(8); rec.mark("neutral", "end")
    for _ in range(4):
        chunk(2)
        rec.mark("eyebrow_raise", "start"); chunk(0.3); chunk(0.4, sd=80); rec.mark("eyebrow_raise", "end")
    for _ in range(2):
        chunk(2)
        rec.mark("double_raise", "start"); chunk(0.2); chunk(0.3, sd=80); chunk(0.15); chunk(0.3, sd=80); rec.mark("double_raise", "end")
    for _ in range(3):
        chunk(2)
        rec.mark("hard_negative_talk", "start"); chunk(0.3); chunk(0.8, sd=12); rec.mark("hard_negative_talk", "end")
    chunk(3)
    return rec.stop({})


def test_train_finds_settings_that_catch_raises_and_ignore_talk(tmp_path, monkeypatch):
    monkeypatch.setattr(recording, "SESSIONS_DIR", tmp_path / "sessions")
    paths = [make_session(tmp_path, seed) for seed in (1, 2, 3)]

    result = train.train(paths, trials=40, verbose=False)

    assert len(result["held_out"]) == 3
    for row in result["train"]:
        assert row["single_hit"] == "4/4"
        assert row["fp_talk"] == 0
    assert result["train"][0]["objective"] >= result["defaults"][0]["objective"]

    out = tmp_path / "detector_params.json"
    (tmp_path / "profile.json").write_text(json.dumps({"baseline": [1.0, 0.5], "k": 99}))
    train.save(result, out)
    loaded = DetectorParams.load(out)
    assert loaded.k == result["params"]["k"]
    assert isinstance(loaded.band_hz, tuple)
    assert json.loads((tmp_path / "profile.json").read_text())["k"] == result["params"]["k"]


def test_load_without_file_gives_defaults(tmp_path):
    assert DetectorParams.load(tmp_path / "missing.json") == DetectorParams()
