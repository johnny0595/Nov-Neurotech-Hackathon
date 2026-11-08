"""Combine click events from several EMG detectors (e.g. brow + jaw) into one stream.

Input modes (per player profile):
  brow            - only the forehead (eyebrow) detector
  jaw             - only the jaw (masseter) detector
  either          - both; the same action seen on both channels within DEDUPE_S counts once
  keyboard-switch - no EMG clicks at all (the page uses Space/Enter from a physical switch)
"""

from __future__ import annotations

INPUT_MODES = ("brow", "jaw", "either", "keyboard-switch")
DEDUPE_S = 0.2


def sources_for(mode: str, available: list[str]) -> list[str]:
    """Which detectors' events count in this input mode."""
    if mode == "keyboard-switch":
        return []
    if mode == "either":
        return list(available)
    return [mode] if mode in available else []


class EventMerger:
    """Merges per-detector event lists (sample-indexed, same clock) into one, tagging each with its source.

    An event is dropped when the same event type came from a *different* detector within the dedupe
    window: one clench-and-raise is one click. Events from the same detector are never merged.
    """

    def __init__(self, fs: float, dedupe_s: float = DEDUPE_S) -> None:
        self.window = int(round(dedupe_s * fs))
        self._last: dict[str, tuple[int, str]] = {}  # event type -> (sample, source) of the last one kept

    def merge(self, streams: dict[str, list[dict]]) -> list[dict]:
        tagged = sorted(
            ({**e, "source": name} for name, events in streams.items() for e in events),
            key=lambda e: e["sample"],
        )
        out: list[dict] = []
        for e in tagged:
            last = self._last.get(e["type"])
            if last is not None and last[1] != e["source"] and e["sample"] - last[0] <= self.window:
                continue  # the same action, seen on the other channel
            self._last[e["type"]] = (e["sample"], e["source"])
            out.append(e)
        return out
