"""Web server: serves web/ and streams head angles + eyebrow events over /ws.

uv run python -m server.app                        # live board
uv run python -m server.app --replay data/sessions/<dir>   # replay a recording
uv run python -m server.app --double               # also allow double raises (map drag)
uv run python -m server.app --gyro-gate 80         # head-motion gate threshold in deg/s (0 = off)
Without the board, open http://localhost:8000/?mock=1 (mouse + keys stand in).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .board import Board
from .eyebrow import DetectorParams, EyebrowDetector
from .gyrogate import DEFAULT_GATE_DPS, GyroGate
from .orientation import ImuConfig, OrientationEstimator
from .recording import Recorder
from .rows import EXG_ROWS, GYRO_ROWS, SAMPLING_RATE_HZ

ROOT = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "data" / "profile.json"
SEND_HZ = 60


class ReplaySource:
    """Plays a recorded raw.npz back in real time, looping."""

    def __init__(self, session: Path) -> None:
        self.data = np.load(session / "raw.npz")["data"]
        self.start = time.monotonic()
        self.pos = 0
        self.info = {"replay": str(session)}

    def connect(self) -> None:
        pass

    def read(self) -> np.ndarray:
        target = int((time.monotonic() - self.start) * SAMPLING_RATE_HZ)
        if target >= self.data.shape[1]:
            self.start, self.pos, target = time.monotonic(), 0, 0
        batch = self.data[:, self.pos : target]
        self.pos = target
        return batch

    def close(self) -> None:
        pass


class Hub:
    def __init__(self, source, channel: int, double_enabled: bool = False,
                 gyro_gate: float | None = DEFAULT_GATE_DPS, gyro_units: str = "auto") -> None:
        self.source = source
        self.channel = channel
        self.orientation = OrientationEstimator(ImuConfig(gyro_units=gyro_units))
        self.detector = EyebrowDetector(DetectorParams(double_enabled=double_enabled))
        self.gate = GyroGate(gyro_gate, fs=SAMPLING_RATE_HZ, units=gyro_units)
        self.recorder = Recorder()
        self.clients: set[WebSocket] = set()
        self.status = "connecting"
        self.rate_hz = 0.0
        self._rate_window: list[tuple[float, int]] = []
        self.last_angles = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}
        self._load_profile()

    def _load_profile(self) -> None:
        if PROFILE_PATH.exists():
            profile = json.loads(PROFILE_PATH.read_text())
            self.detector.baseline = tuple(profile["baseline"]) if profile.get("baseline") else None
            self.detector.p.k = float(profile.get("k", self.detector.p.k))

    def _save_profile(self) -> None:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_PATH.write_text(json.dumps({"baseline": self.detector.baseline, "k": self.detector.p.k}, indent=2))

    async def run(self) -> None:
        try:
            await asyncio.to_thread(self.source.connect)
            self.status = "live"
        except Exception as exc:  # keep serving the web app so mock mode and the error message still work
            self.status = f"board error: {exc}"
            return
        while True:
            await asyncio.sleep(1 / SEND_HZ)
            batch = self.source.read()
            events = self.process(batch)
            await self.broadcast({"t": "state", **self.snapshot(), "events": events})

    def process(self, batch: np.ndarray) -> list[dict]:
        if batch.shape[1] == 0:
            return []
        for column in batch.T:
            o = self.orientation.update(column)
        self.last_angles = {"roll": o.roll, "pitch": o.pitch, "yaw": o.yaw}
        self.recorder.append(batch)
        blocked = self.gate.mask(batch[list(GYRO_ROWS)])
        events = self.detector.feed(batch[EXG_ROWS[self.channel - 1]], blocked)
        for event in events:
            self.recorder.detected(event)
        now = time.monotonic()
        self._rate_window = [(t, n) for t, n in self._rate_window if now - t < 2.0] + [(now, batch.shape[1])]
        span = now - self._rate_window[0][0]
        if span > 0.5:
            self.rate_hz = sum(n for _, n in self._rate_window[1:]) / span
        return events

    def snapshot(self) -> dict:
        return {
            **{k: round(v, 2) for k, v in self.last_angles.items()},
            "envelope": round(self.detector.envelope, 2),
            "threshold": self.detector.threshold,
            "k": self.detector.p.k,
            "double_enabled": self.detector.p.double_enabled,
            "gyro_dps": round(self.gate.dps, 1),
            "gyro_gate": self.gate.threshold,
            "rate_hz": round(self.rate_hz, 1),
            "recording": self.recorder.active,
            "status": self.status,
        }

    async def broadcast(self, message: dict) -> None:
        text = json.dumps(message)
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                self.clients.discard(ws)

    async def command(self, ws: WebSocket, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "zero":
            self.orientation.zero_level()
        elif cmd == "calibrate_start":
            self.detector.start_calibration()
            self.recorder.mark("neutral", "start")
        elif cmd == "calibrate_stop":
            self.recorder.mark("neutral", "end")
            self.detector.finish_calibration()
            self._save_profile()
        elif cmd == "set_k":
            self.detector.p.k = float(msg["k"])
            self._save_profile()
        elif cmd == "record_start":
            meta = {"name": msg.get("name", "session"), "note": msg.get("note", ""), "protocol": msg.get("protocol")}
            self.recorder.start({**meta, "channel": self.channel, "fs": SAMPLING_RATE_HZ}, self.detector.n)
        elif cmd == "mark":
            self.recorder.mark(str(msg["label"]), str(msg["edge"]))
        elif cmd == "record_stop":
            info = getattr(self.source, "info", {})
            gate = {"threshold_dps": self.gate.threshold, "hold_samples": self.gate.hold, "units": self.gate.units_label}
            path = self.recorder.stop({"source": info, "detector": self.detector.state(), "gyro_gate": gate, "aborted": bool(msg.get("aborted"))})
            await ws.send_text(json.dumps({"t": "saved", "path": str(path.relative_to(ROOT)) if path else None}))


def create_app(hub: Hub) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(hub.run())
        yield
        task.cancel()
        await asyncio.to_thread(hub.source.close)

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def revalidate(request, call_next):
        # Make browsers re-check web/ files on every load (cheap 304s), so an edited game.js is never
        # served stale from cache during setup or a demo.
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/config")
    def config() -> dict:
        return {"mapsKey": os.environ.get("GOOGLE_MAPS_API_KEY", ""), "status": hub.status}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        hub.clients.add(ws)
        await ws.send_text(json.dumps({"t": "state", **hub.snapshot(), "events": []}))
        try:
            while True:
                await hub.command(ws, json.loads(await ws.receive_text()))
        except WebSocketDisconnect:
            hub.clients.discard(ws)

    app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
    return app


def load_dotenv() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Brow Guessr server")
    parser.add_argument("--port", default="/dev/cu.usbserial-A5069RR4", help="board serial port")
    parser.add_argument("--channel", type=int, default=2, help="forehead EXG channel (1-8)")
    parser.add_argument("--replay", type=Path, help="replay a recorded session instead of the board")
    parser.add_argument("--http-port", type=int, default=8000)
    parser.add_argument("--double", action="store_true",
                        help="enable double raises (drag the map); default is single raises only, clicks fire immediately")
    parser.add_argument("--gyro-gate", type=float, default=DEFAULT_GATE_DPS, metavar="DEG_S",
                        help=f"ignore raises while the head turns faster than this, and 150 ms after (default {DEFAULT_GATE_DPS:g}; 0 = off)")
    parser.add_argument("--gyro-units", choices=["auto", "deg_s", "rad_s"], default="auto",
                        help="units of the board's gyro rows, for the gate and head tracking (default: auto-detect)")
    args = parser.parse_args(argv)
    load_dotenv()
    source = ReplaySource(args.replay) if args.replay else Board(args.port, args.channel)
    uvicorn.run(create_app(Hub(source, args.channel, double_enabled=args.double, gyro_gate=args.gyro_gate, gyro_units=args.gyro_units)), host="127.0.0.1", port=args.http_port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
