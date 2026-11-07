import numpy as np

from server.app import Hub, main  # noqa: F401  (import check for the CLI module)
from server.rows import NUM_ROWS


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
