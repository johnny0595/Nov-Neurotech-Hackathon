"""Tune the eyebrow detector on recorded sessions and save the best settings.

uv run python -m server.train data/sessions/*                # search, report, save
uv run python -m server.train data/sessions/* --trials 2000  # wider search
uv run python -m server.train data/sessions/* --dry-run      # report only, don't save

Every candidate setting is replayed through the real streaming detector on every
session. Held-out scoring (leave one session out) shows how well the tuning
generalises to a session it never saw. The final settings are chosen on all
sessions and written to data/detector_params.json, which the server loads at start.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import fields
from pathlib import Path

import numpy as np

from .eyebrow import PARAMS_PATH, DetectorParams
from .evaluate import load_session, run_detector, score
from .rows import EXG_ROWS

# Search space. Upper band edges stay below 60 Hz mains and the 62.5 Hz Nyquist.
SPACE: dict[str, list] = {
    "k": [4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 20.0, 25.0],
    "band_hz": [(15.0, 45.0), (20.0, 50.0), (25.0, 55.0), (30.0, 55.0)],
    "envelope_s": [0.03, 0.05, 0.08],
    "release": [0.5, 0.6, 0.7],
    "release_of_peak": [0.15, 0.2, 0.3],
    "min_s": [0.05, 0.08, 0.12, 0.16],
    "max_s": [1.0, 1.5, 2.0],
    "double_window_s": [0.6, 0.8, 1.0],
    "debounce_s": [0.05, 0.1, 0.15],
}

# Objective weights. Missed singles hurt most (that's the click); false raises are the
# next worst thing for a kid using it; a single read as a double opens drag mode by mistake.
W_DOUBLE = 0.5
W_FP_PER_MIN = 0.25
W_SINGLE_AS_DOUBLE = 0.5


class Session:
    def __init__(self, path: Path) -> None:
        data, labels, meta = load_session(path)
        self.name = path.name
        self.fs = float(meta.get("fs", 125.0))
        self.signal = data[EXG_ROWS[int(meta.get("channel", 2)) - 1]].astype(float)
        self.labels = labels
        self.n = data.shape[1]
        neutral = next((lab for lab in labels if lab.get("type") == "interval" and lab["label"] == "neutral"), None)
        self.neutral = (neutral["start_sample"], neutral["end_sample"]) if neutral else None
        self.n_singles = sum(1 for lab in labels if lab.get("type") == "interval" and lab["label"] == "eyebrow_raise")
        self.n_doubles = sum(1 for lab in labels if lab.get("type") == "interval" and lab["label"] == "double_raise")


def _ratio(text: str) -> float:
    hit, total = (int(x) for x in text.split("/"))
    return hit / total if total else 1.0


def evaluate_params(session: Session, params: DetectorParams) -> dict:
    events = run_detector(session.signal, session.neutral, params)
    result = score(session.labels, events, session.fs, session.n)
    single = _ratio(result["single_hit"])
    double = _ratio(result["double_hit"])
    as_double = result["single_read_as_double"] / max(session.n_singles, 1)
    objective = single + W_DOUBLE * double - W_FP_PER_MIN * result["fp_per_min"] - W_SINGLE_AS_DOUBLE * as_double
    return {**result, "single": single, "double": double, "objective": objective}


def candidates(trials: int, seed: int, base: DetectorParams) -> list[dict]:
    """The current defaults, a k sweep around them, then random combinations."""
    rng = random.Random(seed)
    base_d = {f.name: getattr(base, f.name) for f in fields(base) if f.name in SPACE}
    out = [dict(base_d)] + [{**base_d, "k": k} for k in SPACE["k"]]
    seen = {json.dumps(c, sort_keys=True) for c in out}
    while len(out) < trials:
        c = {name: rng.choice(values) for name, values in SPACE.items()}
        key = json.dumps(c, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def make_params(candidate: dict, fs: float) -> DetectorParams:
    return DetectorParams(fs=fs, **{k: tuple(v) if k == "band_hz" else v for k, v in candidate.items()})


def train(paths: list[Path], trials: int = 500, seed: int = 0, verbose: bool = True) -> dict:
    sessions = [Session(p) for p in paths if (p / "raw.npz").exists()]
    skipped = [s.name for s in sessions if s.neutral is None]
    sessions = [s for s in sessions if s.neutral is not None]
    if not sessions:
        raise SystemExit("No usable sessions (each needs raw.npz and a 'neutral' interval).")
    log = print if verbose else (lambda *a, **k: None)
    if skipped:
        log(f"skipping (no neutral interval): {', '.join(skipped)}")

    cands = candidates(trials, seed, DetectorParams())
    log(f"{len(sessions)} sessions x {len(cands)} settings ...")
    # matrix[c][s] = result of candidate c on session s
    matrix = [[evaluate_params(s, make_params(c, s.fs)) for s in sessions] for c in cands]
    obj = np.array([[r["objective"] for r in row] for row in matrix])

    # Held-out check: tune on all-but-one session, score the one left out.
    held_out = []
    if len(sessions) > 1:
        for j, s in enumerate(sessions):
            others = np.delete(obj, j, axis=1).mean(axis=1)
            best = int(np.argmax(others))
            held_out.append({"session": s.name, **_summary(matrix[best][j])})

    best = int(np.argmax(obj.mean(axis=1)))
    default_row = matrix[0]
    result = {
        "params": {**cands[best], "band_hz": list(cands[best]["band_hz"])},
        "train": [{"session": s.name, **_summary(matrix[best][j])} for j, s in enumerate(sessions)],
        "defaults": [{"session": s.name, **_summary(default_row[j])} for j, s in enumerate(sessions)],
        "held_out": held_out,
        "sessions": [s.name for s in sessions],
        "trials": len(cands),
    }

    log("\nBest settings:", json.dumps(result["params"]))
    _table(log, "Current defaults (before tuning)", result["defaults"])
    _table(log, "Tuned settings, on the sessions they were tuned on", result["train"])
    if held_out:
        _table(log, "Held-out check (each session scored by settings tuned WITHOUT it) - the honest number", held_out)
    else:
        log("\nOnly 1 session: no held-out check. Record more sessions before trusting these numbers.")
    return result


def _summary(r: dict) -> dict:
    keep = ["single_hit", "double_hit", "single_read_as_double", "fp_per_min"]
    out = {k: r[k] for k in keep}
    out.update({k: v for k, v in r.items() if k.startswith("fp_") and k != "fp_per_min"})
    out["objective"] = round(r["objective"], 3)
    return out


def _table(log, title: str, rows: list[dict]) -> None:
    log(f"\n{title}:")
    for row in rows:
        log("  " + "  ".join(f"{k}={v}" for k, v in row.items()))


def save(result: dict, path: Path = PARAMS_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "params": result["params"],
        "trained_on": result["sessions"],
        "held_out": result["held_out"],
        "note": "written by server.train; the server loads this at start-up",
    }
    path.write_text(json.dumps(payload, indent=2))
    # The calibration profile stores k too (the setup-page slider); keep it in step.
    profile = path.parent / "profile.json"
    if profile.exists():
        data = json.loads(profile.read_text())
        data["k"] = result["params"]["k"]
        profile.write_text(json.dumps(data, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sessions", nargs="+", type=Path)
    parser.add_argument("--trials", type=int, default=500, help="settings to try (default 500)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true", help="report only; don't write data/detector_params.json")
    args = parser.parse_args(argv)
    result = train(args.sessions, trials=args.trials, seed=args.seed)
    if not args.dry_run:
        save(result)
        print(f"\nSaved {PARAMS_PATH.relative_to(PARAMS_PATH.parent.parent)}. Restart the server to use it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
