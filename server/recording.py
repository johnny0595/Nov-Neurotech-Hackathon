"""Guided-session recorder: writes data/sessions/<timestamp>-<name>/.

Files: raw.npz (22 x n BrainFlow rows), labels.jsonl (prompt intervals and
live detections, sample-indexed), metadata.json. labels.jsonl uses the same
{"type": "interval", "label", "start_sample", "end_sample"} shape as the old repo.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np

from .board import rate_report

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "data" / "sessions"


class Recorder:
    def __init__(self) -> None:
        self.active = False

    def start(self, meta: dict, detector_n: int) -> None:
        self.chunks: list[np.ndarray] = []
        self.n = 0
        self.labels: list[dict] = []
        self.open: dict[str, int] = {}
        self.meta = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **meta}
        self.detector_offset = detector_n
        self.active = True

    def append(self, batch: np.ndarray) -> None:
        if self.active and batch.shape[1]:
            self.chunks.append(batch)
            self.n += batch.shape[1]

    def mark(self, label: str, edge: str) -> None:
        if not self.active:
            return
        if edge == "start":
            self.open[label] = self.n
        elif label in self.open:
            self.labels.append({"type": "interval", "label": label, "start_sample": self.open.pop(label), "end_sample": self.n})

    def detected(self, event: dict) -> None:
        if self.active:
            self.labels.append({**event, "type": "detected", "label": event["type"], "sample": event["sample"] - self.detector_offset})

    def stop(self, extra_meta: dict) -> Path | None:
        if not self.active:
            return None
        self.active = False
        if not self.chunks:
            return None
        data = np.concatenate(self.chunks, axis=1)
        name = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(self.meta.get("name", "session"))).strip("-") or "session"
        out = SESSIONS_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
        out.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(out / "raw.npz", data=data)
        with (out / "labels.jsonl").open("w") as fh:
            for label in self.labels:
                fh.write(json.dumps(label) + "\n")
        meta = {**self.meta, **extra_meta, "rate": rate_report(data), "unclosed_labels": list(self.open)}
        (out / "metadata.json").write_text(json.dumps(meta, indent=2, default=str))
        return out
