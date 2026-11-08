import json

import numpy as np

from server import app as app_module
from server.app import Hub
from server.rows import NUM_ROWS


class NullSource:
    def connect(self):
        pass

    def read(self):
        return np.zeros((NUM_ROWS, 0))

    def close(self):
        pass


def make_hub(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "PROFILE_PATH", tmp_path / "profile.json")
    monkeypatch.setattr(app_module, "PROFILES_DIR", tmp_path / "profiles")
    return Hub(NullSource(), 2, channels={"brow": 2, "jaw": 3})


def test_each_profile_keeps_its_own_detector_settings(monkeypatch, tmp_path):
    hub = make_hub(monkeypatch, tmp_path)
    hub.switch_profile("Ana")
    hub.detectors["brow"].baseline = (2.0, 0.3)
    hub.detectors["brow"].p.k = 8.0
    hub.input_mode = "either"
    hub._save_profile()

    hub.switch_profile("Ben")  # new: starts from what's loaded, has no file yet
    assert not (tmp_path / "profiles" / "ben.json").exists()
    hub.detectors["brow"].baseline = (5.0, 1.0)
    hub.input_mode = "jaw"
    hub._save_profile()

    hub.switch_profile("Ana")
    assert hub.detectors["brow"].baseline == (2.0, 0.3) and hub.detectors["brow"].p.k == 8.0
    assert hub.input_mode == "either" and hub.snapshot()["profile"] == "Ana"
    saved = json.loads((tmp_path / "profiles" / "ana.json").read_text())
    assert saved["name"] == "Ana" and saved["detectors"]["brow"]["baseline"] == [2.0, 0.3]


def test_rename_and_delete(monkeypatch, tmp_path):
    hub = make_hub(monkeypatch, tmp_path)
    hub.switch_profile("Player 1")
    hub._save_profile()
    hub.rename_profile("Player 1", "Sam Lee")
    assert not (tmp_path / "profiles" / "player-1.json").exists()
    assert json.loads((tmp_path / "profiles" / "sam-lee.json").read_text())["name"] == "Sam Lee"
    assert hub.profile_name == "Sam Lee"
    hub.delete_profile("Sam Lee")
    assert not (tmp_path / "profiles" / "sam-lee.json").exists()


def test_old_shared_file_is_still_read_at_start(monkeypatch, tmp_path):
    (tmp_path / "profile.json").write_text(json.dumps({"baseline": [1.5, 0.2], "k": 7.0}))
    hub = make_hub(monkeypatch, tmp_path)
    assert hub.detectors["brow"].baseline == (1.5, 0.2)
    hub.switch_profile("Player 1")  # no file yet: keeps the migrated calibration
    assert hub.detectors["brow"].baseline == (1.5, 0.2)


def test_profile_names_make_safe_file_names():
    assert Hub.profile_path("../../etc/passwd").name == "etc-passwd.json"
    assert Hub.profile_path("   ").name == "player.json"
