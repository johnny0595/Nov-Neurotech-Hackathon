import numpy as np

from server.app import Hub, main  # noqa: F401  (import check for the CLI module)
from server.rows import EXG_ROWS, GYRO_ROWS, NUM_ROWS


class NullSource:
    def connect(self):
        pass

    def read(self):
        return np.zeros((NUM_ROWS, 0))

    def close(self):
        pass


def test_snapshot_reports_double_mode():
    assert Hub(NullSource(), 2).snapshot()["double_enabled"] is False  # Raleigh default: single raises only
    assert Hub(NullSource(), 2, double_enabled=True).snapshot()["double_enabled"] is True


def test_process_gates_raises_while_the_head_turns():
    rng = np.random.default_rng(2)
    hub = Hub(NullSource(), 2, gyro_gate=60)

    def batch(seconds, loud=False, turning=False):
        b = np.zeros((NUM_ROWS, int(seconds * 125)))
        b[EXG_ROWS[1]] = rng.normal(0, 60 if loud else 5, b.shape[1])
        b[list(GYRO_ROWS)] = rng.normal(0, 0.8, (3, b.shape[1])) + (150 if turning else 0)
        return hub.process(b)

    batch(2)
    hub.detector.start_calibration(); batch(5); hub.detector.finish_calibration()
    events = batch(0.5) + batch(0.4, loud=True, turning=True) + batch(1.5)
    events += batch(0.4, loud=True) + batch(1.5)
    assert [e["type"] for e in events if e["type"] != "raise"] == ["gated_raise", "click"]
    click = next(e for e in events if e["type"] == "click")
    assert click["duration_s"] > 0 and click["delay_s"] == 0.0  # sent over /ws for the page's click lock
    assert hub.snapshot()["gyro_gate"] == 60


def test_static_files_are_revalidated():
    from fastapi.testclient import TestClient
    from server.app import create_app

    with TestClient(create_app(Hub(NullSource(), 2))) as client:
        assert client.get("/game.js").headers["cache-control"] == "no-cache"
