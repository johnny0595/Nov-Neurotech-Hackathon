"""Replay recorded sessions through the eyebrow detector and score it.

uv run python -m server.evaluate data/sessions/*            # default sensitivity
uv run python -m server.evaluate data/sessions/* --k 4 5 6 8   # sweep sensitivity
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .eyebrow import DetectorParams, EyebrowDetector
from .rows import EXG_ROWS

POSITIVE = {"eyebrow_raise", "double_raise"}
RESPONSE_SLOP_S = 1.0  # people react late; count detections up to 1 s after the prompt ends


def load_session(path: Path) -> tuple[np.ndarray, list[dict], dict]:
    data = np.load(path / "raw.npz")["data"]
    labels = [json.loads(line) for line in (path / "labels.jsonl").read_text().splitlines() if line.strip()]
    meta = json.loads((path / "metadata.json").read_text())
    return data, labels, meta


def run_detector(signal_values: np.ndarray, neutral: tuple[int, int], params: DetectorParams) -> list[dict]:
    det = EyebrowDetector(params)
    start, end = neutral
    det.feed(signal_values[:start])
    det.start_calibration()
    det.feed(signal_values[start:end])
    det.finish_calibration()
    events = det.feed(signal_values[end:])
    # detector sample n is "samples seen", i.e. index + 1
    return [{**e, "sample": e["sample"] - 1} for e in events]


def score(labels: list[dict], events: list[dict], fs: float, n_samples: int) -> dict:
    intervals = [lab for lab in labels if lab.get("type") == "interval"]
    slop = int(RESPONSE_SLOP_S * fs)
    raises = [e["sample"] for e in events if e["type"] == "raise"]
    toggles = [e["sample"] for e in events if e["type"] == "drag_toggle"]
    clicks = [e["sample"] for e in events if e["type"] == "click"]

    def within(samples: list[int], lab: dict) -> int:
        return sum(lab["start_sample"] <= s <= lab["end_sample"] + slop for s in samples)

    out: dict = {}
    singles = [lab for lab in intervals if lab["label"] == "eyebrow_raise"]
    doubles = [lab for lab in intervals if lab["label"] == "double_raise"]
    # a click event fires double_window_s after the raise, so judge singles by raises and doubles by toggles
    out["single_hit"] = f"{sum(within(raises, lab) > 0 for lab in singles)}/{len(singles)}"
    out["single_read_as_double"] = sum(within(toggles, lab) > 0 for lab in singles)
    out["double_hit"] = f"{sum(within(toggles, lab) > 0 for lab in doubles)}/{len(doubles)}"
    out["clicks"] = len(clicks)

    positive_windows = [lab for lab in intervals if lab["label"] in POSITIVE]
    false_raises = [s for s in raises if not any(lab["start_sample"] <= s <= lab["end_sample"] + slop for lab in positive_windows)]
    positive_samples = sum(lab["end_sample"] + slop - lab["start_sample"] for lab in positive_windows)
    negative_minutes = max(n_samples - positive_samples, 1) / fs / 60
    out["false_raises"] = len(false_raises)
    out["fp_per_min"] = round(len(false_raises) / negative_minutes, 2)
    for lab in intervals:
        if lab["label"].startswith("hard_negative_"):
            key = "fp_" + lab["label"].removeprefix("hard_negative_")
            out[key] = out.get(key, 0) + within(raises, lab)
    return out


def evaluate(path: Path, k: float) -> dict:
    data, labels, meta = load_session(path)
    channel = int(meta.get("channel", 2))
    fs = float(meta.get("fs", 125.0))
    neutral = next((lab for lab in labels if lab.get("type") == "interval" and lab["label"] == "neutral"), None)
    if neutral is None:
        return {"session": path.name, "error": "no neutral interval to calibrate on"}
    events = run_detector(data[EXG_ROWS[channel - 1]], (neutral["start_sample"], neutral["end_sample"]), DetectorParams(fs=fs, k=k))
    return {"session": path.name, "k": k, **score(labels, events, fs, data.shape[1])}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sessions", nargs="+", type=Path)
    parser.add_argument("--k", type=float, nargs="+", default=[DetectorParams().k])
    args = parser.parse_args(argv)
    for k in args.k:
        for path in args.sessions:
            if (path / "raw.npz").exists():
                print(json.dumps(evaluate(path, k)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
