"""Replay recorded sessions through the eyebrow detector and score it.

uv run python -m server.evaluate data/sessions/*                     # gate off vs default gate
uv run python -m server.evaluate data/sessions/* --k 4 5 6 8         # sweep sensitivity
uv run python -m server.evaluate data/sessions/* --gyro-gate 0 40 60 80 120   # tune the head-motion gate
uv run python -m server.evaluate data/sessions/* --double            # score with double raises on

Each (session, k, gate) prints one JSON line; a summary per (k, gate) follows, with false clicks per
minute (clicks/drag toggles outside raise prompts) and how many single raises were still caught.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .eyebrow import DetectorParams, EyebrowDetector
from .gyrogate import DEFAULT_GATE_DPS, GyroGate
from .rows import EXG_ROWS, GYRO_ROWS

POSITIVE = {"eyebrow_raise", "double_raise"}
RESPONSE_SLOP_S = 1.0  # people react late; count detections up to 1 s after the prompt ends


def load_session(path: Path) -> tuple[np.ndarray, list[dict], dict]:
    data = np.load(path / "raw.npz")["data"]
    labels = [json.loads(line) for line in (path / "labels.jsonl").read_text().splitlines() if line.strip()]
    meta = json.loads((path / "metadata.json").read_text())
    return data, labels, meta


def run_detector(signal_values: np.ndarray, neutral: tuple[int, int], params: DetectorParams,
                 blocked: np.ndarray | None = None) -> list[dict]:
    det = EyebrowDetector(params)
    if blocked is None:
        blocked = np.zeros(len(signal_values), dtype=bool)
    start, end = neutral
    det.feed(signal_values[:start], blocked[:start])
    det.start_calibration()
    det.feed(signal_values[start:end], blocked[start:end])
    det.finish_calibration()
    events = det.feed(signal_values[end:], blocked[end:])
    # detector sample n is "samples seen", i.e. index + 1
    return [{**e, "sample": e["sample"] - 1} for e in events]


def score(labels: list[dict], events: list[dict], fs: float, n_samples: int, params: DetectorParams | None = None) -> dict:
    params = params or DetectorParams(fs=fs)
    intervals = [lab for lab in labels if lab.get("type") == "interval"]
    slop = int(RESPONSE_SLOP_S * fs)
    raises = [e["sample"] for e in events if e["type"] == "raise"]
    toggles = [e["sample"] for e in events if e["type"] == "drag_toggle"]
    clicks = [e["sample"] for e in events if e["type"] == "click"]

    def within(samples: list[int], lab: dict, extra: int = 0) -> int:
        return sum(lab["start_sample"] <= s <= lab["end_sample"] + slop + extra for s in samples)

    out: dict = {}
    singles = [lab for lab in intervals if lab["label"] == "eyebrow_raise"]
    doubles = [lab for lab in intervals if lab["label"] == "double_raise"]
    # with doubles on, a click fires double_window_s after the raise, so judge singles by raises and doubles by toggles
    out["single_hit"] = f"{sum(within(raises, lab) > 0 for lab in singles)}/{len(singles)}"
    if params.double_enabled:
        out["single_read_as_double"] = sum(within(toggles, lab) > 0 for lab in singles)
        out["double_hit"] = f"{sum(within(toggles, lab) > 0 for lab in doubles)}/{len(doubles)}"
    out["clicks"] = len(clicks)
    out["gated_raises"] = sum(e["type"] == "gated_raise" for e in events)

    positive_windows = [lab for lab in intervals if lab["label"] in POSITIVE]
    positive_samples = sum(lab["end_sample"] + slop - lab["start_sample"] for lab in positive_windows)
    negative_minutes = max(n_samples - positive_samples, 1) / fs / 60

    def outside(samples: list[int], extra: int = 0) -> list[int]:
        return [s for s in samples if not any(lab["start_sample"] <= s <= lab["end_sample"] + slop + extra for lab in positive_windows)]

    false_raises = outside(raises)
    out["false_raises"] = len(false_raises)
    out["fp_per_min"] = round(len(false_raises) / negative_minutes, 2)
    # what the player actually feels: clicks and drag toggles they didn't ask for
    late = int(params.double_window_s * fs) if params.double_enabled else 0
    false_clicks = outside(clicks + toggles, late)
    out["false_clicks"] = len(false_clicks)
    out["false_clicks_per_min"] = round(len(false_clicks) / negative_minutes, 2)
    for lab in intervals:
        if lab["label"].startswith("hard_negative_"):
            key = "fp_" + lab["label"].removeprefix("hard_negative_")
            out[key] = out.get(key, 0) + within(raises, lab)
    return out


def evaluate(path: Path, k: float, gyro_gate: float | None = None, double: bool = False, gyro_units: str = "auto") -> dict:
    data, labels, meta = load_session(path)
    channel = int(meta.get("channel", 2))
    fs = float(meta.get("fs", 125.0))
    neutral = next((lab for lab in labels if lab.get("type") == "interval" and lab["label"] == "neutral"), None)
    if neutral is None:
        return {"session": path.name, "error": "no neutral interval to calibrate on"}
    gate = GyroGate(gyro_gate, fs=fs, units=gyro_units)
    blocked = gate.mask(data[list(GYRO_ROWS)])
    params = DetectorParams(fs=fs, k=k, double_enabled=double)
    events = run_detector(data[EXG_ROWS[channel - 1]], (neutral["start_sample"], neutral["end_sample"]), params, blocked)
    return {
        "session": path.name, "k": k, "gyro_gate": float(gyro_gate or 0), "gyro_units": gate.units_label,
        "blocked_pct": round(100 * float(blocked.mean()), 1) if blocked.size else 0.0,
        **score(labels, events, fs, data.shape[1], params),
    }


def summarize(rows: list[dict]) -> list[dict]:
    """Pool sessions per (k, gate): false clicks per minute and single-raise hit rate."""
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        if "error" not in row:
            groups.setdefault((row["k"], row["gyro_gate"]), []).append(row)
    out = []
    for (k, gate), rs in sorted(groups.items()):
        hits = [tuple(map(int, r["single_hit"].split("/"))) for r in rs]
        out.append({
            "summary": True, "k": k, "gyro_gate": gate, "sessions": len(rs),
            "false_clicks": sum(r["false_clicks"] for r in rs),
            # mean of per-session rates, so sessions without false clicks still count
            "false_clicks_per_min": round(float(np.mean([r["false_clicks_per_min"] for r in rs])), 2),
            "single_hit": f"{sum(h for h, _ in hits)}/{sum(t for _, t in hits)}",
            "gated_raises": sum(r["gated_raises"] for r in rs),
            "fp_head_move": sum(r.get("fp_head_move", 0) for r in rs),
        })
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sessions", nargs="+", type=Path)
    parser.add_argument("--k", type=float, nargs="+", default=[DetectorParams().k])
    parser.add_argument("--gyro-gate", type=float, nargs="+", default=[0.0, DEFAULT_GATE_DPS], metavar="DEG_S",
                        help=f"gate thresholds to compare, 0 = off (default: 0 {DEFAULT_GATE_DPS:g})")
    parser.add_argument("--gyro-units", choices=["auto", "deg_s", "rad_s"], default="auto")
    parser.add_argument("--double", action="store_true", help="score with double raises on (the server's --double)")
    args = parser.parse_args(argv)
    rows = []
    for k in args.k:
        for gate in args.gyro_gate:
            for path in args.sessions:
                if (path / "raw.npz").exists():
                    row = evaluate(path, k, gyro_gate=gate, double=args.double, gyro_units=args.gyro_units)
                    rows.append(row)
                    print(json.dumps(row))
    for line in summarize(rows):
        print(json.dumps(line))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
