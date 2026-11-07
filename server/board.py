"""BrainFlow session for the Knight IMU board, plus a sample-rate check.

Run `uv run python -m server.board --seconds 30` to diagnose the 72-79 Hz
timestamp rate seen at the last hackathon.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from .ports import resolve_serial_port
from .rows import NUM_ROWS, PACKAGE_ROW, TIMESTAMP_ROW, validate_batch

GAIN = 12
SETTLE_SECONDS = 2.0
COMMAND_DELAY_SECONDS = 0.5  # the board silently drops commands sent faster than this


def channel_commands(active_channel: int) -> list[str]:
    commands: list[str] = []
    for ch in range(1, 9):
        if ch == active_channel:
            commands += [f"chon_{ch}_{GAIN}", f"rldadd_{ch}"]
        else:
            commands += [f"rldremove_{ch}", f"choff_{ch}"]
    return commands


class Board:
    def __init__(self, port: str | None, channel: int = 2, log=print) -> None:
        self.port_pref = port
        self.channel = channel
        self.log = log
        self.board = None
        self.info: dict = {}

    def connect(self) -> None:
        from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams

        port = resolve_serial_port(self.port_pref)
        self.log(port.message)
        params = BrainFlowInputParams()
        params.serial_port = port.port
        params.other_info = json.dumps({"gain": GAIN})
        BoardShim.disable_board_logger()
        board_id = BoardIds.NEUROPAWN_KNIGHT_BOARD_IMU.value
        if BoardShim.get_num_rows(board_id) != NUM_ROWS:
            raise RuntimeError(f"BrainFlow Knight IMU has {BoardShim.get_num_rows(board_id)} rows, expected {NUM_ROWS}")
        self.board = BoardShim(board_id, params)
        try:
            self.board.prepare_session()
            self.board.start_stream(450000)
            time.sleep(SETTLE_SECONDS)
            for command in channel_commands(self.channel):
                self.board.config_board(command)
                time.sleep(COMMAND_DELAY_SECONDS)
        except Exception:
            self.close()
            raise
        self.info = {
            "port": port.port,
            "brainflow_version": BoardShim.get_version(),
            "nominal_rate_hz": BoardShim.get_sampling_rate(board_id),
            "channel": self.channel,
            "gain": GAIN,
        }
        self.log(f"Streaming on {port.port}, channel {self.channel} at gain {GAIN}")

    def read(self) -> np.ndarray:
        """Drain everything new since the last read, shape (22, n)."""
        if self.board is None:
            return np.zeros((NUM_ROWS, 0))
        return validate_batch(self.board.get_board_data())

    def close(self) -> None:
        if self.board is None:
            return
        for step in (self.board.stop_stream, self.board.release_session):
            try:
                step()
            except Exception as exc:
                self.log(f"{step.__name__} failed: {exc}")
        self.board = None


def rate_report(data: np.ndarray) -> dict:
    """Compare sample count, host timestamps and the package counter."""
    n = data.shape[1]
    if n < 2:
        return {"samples": n}
    ts = data[TIMESTAMP_ROW]
    span = float(ts[-1] - ts[0])
    diffs = np.diff(data[PACKAGE_ROW]).astype(int)
    values, counts = np.unique(diffs, return_counts=True)
    top = sorted(zip(counts.tolist(), values.tolist()), reverse=True)[:6]
    return {
        "samples": n,
        "timestamp_span_s": round(span, 3),
        "rate_from_timestamps_hz": round((n - 1) / span, 2) if span > 0 else None,
        "package_counter_min_max": [float(data[PACKAGE_ROW].min()), float(data[PACKAGE_ROW].max())],
        # a clean stream is almost entirely diff == 1 (plus one wraparound per cycle)
        "package_diff_histogram": {str(v): c for c, v in top},
        "max_timestamp_gap_ms": round(float(np.max(np.diff(ts))) * 1000, 1),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Knight IMU sample-rate check")
    parser.add_argument("--port", default="/dev/cu.usbserial-A5069RR4")
    parser.add_argument("--channel", type=int, default=2)
    parser.add_argument("--seconds", type=float, default=30.0)
    args = parser.parse_args(argv)

    board = Board(args.port, args.channel)
    board.connect()
    chunks = []
    start = time.monotonic()
    try:
        while time.monotonic() - start < args.seconds:
            time.sleep(0.05)
            chunks.append(board.read())
    finally:
        board.close()
    wall = time.monotonic() - start
    data = np.concatenate(chunks, axis=1)
    report = {"wall_seconds": round(wall, 2), "rate_from_wall_clock_hz": round(data.shape[1] / wall, 2), **rate_report(data), **board.info}
    out = Path("data/ratecheck") / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out / "raw.npz", data=data)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"Saved to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
