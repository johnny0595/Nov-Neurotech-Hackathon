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
# Tested 2026-11-07: every channel is off after power-up. A second command sent 0.5 s
# after the first was dropped, and some commands in a fast burst switched on the wrong
# channel. So send only what's needed, one at a time, and check the channel is live.
COMMAND_GAP_SECONDS = 1.5
ENABLE_ATTEMPTS = 4


def channel_is_live(data: np.ndarray, channel: int) -> bool:
    return data.shape[1] > 0 and float(np.std(data[channel])) > 0.0


class Board:
    def __init__(self, port: str | None, channel: int = 2, log=print, extra_channels: tuple[int, ...] = ()) -> None:
        self.port_pref = port
        self.channel = channel
        # more EXG channels to switch on (e.g. a jaw electrode next to the forehead one), one at a time
        self.channels = [channel, *[c for c in extra_channels if c != channel]]
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
            for ch in self.channels:
                self._enable_channel(ch)
        except Exception:
            self.close()
            raise
        self.info = {
            "port": port.port,
            "brainflow_version": BoardShim.get_version(),
            "nominal_rate_hz": BoardShim.get_sampling_rate(board_id),
            "channel": self.channel,
            "channels": self.channels,
            "gain": GAIN,
        }
        self.log(f"Streaming on {port.port}, channel(s) {self.channels} at gain {GAIN}")

    def _send_and_check(self, command: str, channel: int) -> bool:
        self.board.config_board(command)
        time.sleep(COMMAND_GAP_SECONDS)
        return channel_is_live(self.board.get_board_data(), channel)

    def _enable_channel(self, channel: int) -> None:
        on = f"chon_{channel}_{GAIN}"
        for attempt in range(1, ENABLE_ATTEMPTS + 1):
            if self._send_and_check(on, channel):
                self.log(f"channel {channel} live after {attempt} attempt(s)")
                break
            self.log(f"channel {channel} still flat after '{on}', retrying")
        else:
            raise RuntimeError(f"channel {channel} stayed flat after {ENABLE_ATTEMPTS} tries; unplug the board for 5 s and restart")
        # Route the channel into the bias drive (less mains noise). If that knocks the channel
        # out, switch it back on; the bias is a nice-to-have, the channel is not.
        if not self._send_and_check(f"rldadd_{channel}", channel):
            self.log(f"channel {channel} went flat after rldadd; switching it back on without bias routing")
            if not self._send_and_check(on, channel):
                raise RuntimeError(f"channel {channel} went flat after rldadd and didn't come back")

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
