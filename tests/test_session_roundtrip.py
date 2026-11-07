import json

import numpy as np

from server import evaluate, recording
from server.recording import Recorder
from server.rows import NUM_ROWS

FS = 125


def test_record_then_evaluate(tmp_path, monkeypatch):
    monkeypatch.setattr(recording, "SESSIONS_DIR", tmp_path)
    rng = np.random.default_rng(1)
    rec = Recorder()
    rec.start({"name": "synthetic", "channel": 2, "fs": FS}, detector_n=0)

    def chunk(seconds, loud=False):
        data = np.zeros((NUM_ROWS, int(seconds * FS)))
        data[2] = rng.normal(0, 60 if loud else 5, data.shape[1])
        rec.append(data)

    rec.mark("neutral", "start"); chunk(5); rec.mark("neutral", "end")
    for _ in range(3):
        rec.mark("eyebrow_raise", "start"); chunk(0.3); chunk(0.3, loud=True); rec.mark("eyebrow_raise", "end"); chunk(2)
    rec.mark("hard_negative_blink", "start"); chunk(1.5); rec.mark("hard_negative_blink", "end"); chunk(2)
    path = rec.stop({})

    labels = [json.loads(l) for l in (path / "labels.jsonl").read_text().splitlines()]
    assert [l["label"] for l in labels].count("eyebrow_raise") == 3
    result = evaluate.evaluate(path, k=6.0)
    assert result["single_hit"] == "3/3"
    assert result["false_raises"] == 0
    assert result["fp_blink"] == 0
