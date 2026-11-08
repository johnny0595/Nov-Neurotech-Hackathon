"""Web server: serves web/ and streams head angles + eyebrow events over /ws.

uv run python -m server.app                        # live board
uv run python -m server.app --replay data/sessions/<dir>   # replay a recording
uv run python -m server.app --single               # single raises only: clicks fire at once, no walking
uv run python -m server.app --gyro-gate 80         # head-motion gate threshold in deg/s (0 = off)
uv run python -m server.app --channels 2,3         # brow EMG on channel 2, jaw EMG on channel 3
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
from .eyebrow import PARAMS_PATH, DetectorParams, EyebrowDetector
from .gyrogate import DEFAULT_GATE_DPS, GyroGate
from .head_axes import AXES_PATH, HeadAxes, HeadTracker
from .merge import INPUT_MODES, EventMerger, sources_for
from .orientation import ImuConfig, OrientationEstimator
from .recording import Recorder
from .rows import EXG_ROWS, GYRO_ROWS, SAMPLING_RATE_HZ

ROOT = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "data" / "profile.json"
SEND_HZ = 60
STALL_SECONDS = 3.0  # no samples for this long = the board stopped (usually stuck at "Scanning for IMU...")
RECONNECT_EVERY_S = 5.0


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
    def __init__(self, source, channel: int, double_enabled: bool = True,
                 gyro_gate: float | None = DEFAULT_GATE_DPS, gyro_units: str = "auto",
                 channels: dict[str, int] | None = None) -> None:
        self.source = source
        # EMG channels by role: {"brow": 2} by default, {"brow": 2, "jaw": 3} with --channels 2,3
        self.channels = dict(channels or {"brow": channel})
        self.channel = self.channels.get("brow", next(iter(self.channels.values())))
        self.orientation = OrientationEstimator(ImuConfig(gyro_units=gyro_units))
        # one detector per EMG channel, each calibrated separately; tuned settings from server.train
        # (data/detector_params.json) if present, plus single/double mode
        self.detectors = {
            name: EyebrowDetector(DetectorParams.load(fs=SAMPLING_RATE_HZ, double_enabled=double_enabled))
            for name in self.channels
        }
        self.input_mode = "brow" if "brow" in self.detectors else next(iter(self.detectors))
        self.merger = EventMerger(SAMPLING_RATE_HZ)
        if PARAMS_PATH.exists():
            print(f"eyebrow detector: using tuned settings from {PARAMS_PATH.name}")
        self.gate = GyroGate(gyro_gate, fs=SAMPLING_RATE_HZ, units=gyro_units)
        self.recorder = Recorder()
        self.clients: set[WebSocket] = set()
        self.status = "connecting"
        self.rate_hz = 0.0
        self._rate_window: list[tuple[float, int]] = []
        self.last_angles = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}
        self.head_axes = HeadAxes.load()
        if self.head_axes.gyro_bias is not None:
            self.orientation.set_gyro_bias(self.head_axes.gyro_bias)
        self.tracker = HeadTracker()
        self.tracker.nod = self.head_axes.nod
        self.head_xy: tuple[float, float] | None = None
        self._axes_phase: str | None = None  # which guided head-calibration step is collecting
        self._axes_data: dict[str, list] = {}
        self._load_profile()

    @property
    def detector(self) -> EyebrowDetector:
        """The detector the meters show: the jaw one in jaw mode, otherwise the brow one."""
        if self.input_mode == "jaw" and "jaw" in self.detectors:
            return self.detectors["jaw"]
        return self.detectors.get("brow", next(iter(self.detectors.values())))

    def _profile_data(self) -> dict:
        # top-level baseline/k stay the brow detector's, so older files keep working
        brow = self.detectors.get("brow")
        return {
            "baseline": brow.baseline if brow else None,
            "k": brow.p.k if brow else None,
            "detectors": {name: {"baseline": d.baseline, "k": d.p.k} for name, d in self.detectors.items()},
            "input": self.input_mode,
        }

    def _apply_profile(self, profile: dict, saved_mtime: float | None = None) -> None:
        # A newer training run wins over an older slider setting.
        trained_is_newer = saved_mtime is not None and PARAMS_PATH.exists() and PARAMS_PATH.stat().st_mtime >= saved_mtime
        per = dict(profile.get("detectors") or {})
        if "brow" not in per and profile.get("baseline") is not None:
            per["brow"] = {"baseline": profile.get("baseline"), "k": profile.get("k")}
        for name, det in self.detectors.items():
            saved = per.get(name) or {}
            det.baseline = tuple(saved["baseline"]) if saved.get("baseline") else None
            if saved.get("k") is not None and not trained_is_newer:
                det.p.k = float(saved["k"])
        if profile.get("input") in INPUT_MODES:
            self.input_mode = profile["input"]

    def _load_profile(self) -> None:
        if PROFILE_PATH.exists():
            self._apply_profile(json.loads(PROFILE_PATH.read_text()), PROFILE_PATH.stat().st_mtime)

    def _save_profile(self) -> None:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_PATH.write_text(json.dumps(self._profile_data(), indent=2))

    async def run(self) -> None:
        try:
            await asyncio.to_thread(self.source.connect)
            self.status = "live"
        except Exception as exc:  # keep serving the web app so mock mode and the error message still work
            self.status = f"board error: {exc}"
            return
        last_data = last_attempt = time.monotonic()
        while True:
            await asyncio.sleep(1 / SEND_HZ)
            try:
                batch = self.source.read()
            except Exception:
                batch = np.zeros((1, 0))
            now = time.monotonic()
            if batch.shape[1]:
                last_data = now
                if self.status != "live":
                    self.status = "live"
            elif now - last_data > STALL_SECONDS:
                self.status = (f"board stopped sending data ({now - last_data:.0f} s). Unplug its USB for 5 s and plug it back in; "
                               "it reconnects by itself, then recenter (look straight + raise eyebrows).")
                if now - last_attempt > RECONNECT_EVERY_S:
                    last_attempt = now
                    await self.broadcast({"t": "state", **self.snapshot(), "events": []})  # show the message before the slow reconnect
                    if await asyncio.to_thread(self._reconnect):
                        last_data = time.monotonic()
                        self.status = "live"
            events = self.process(batch)
            await self.broadcast({"t": "state", **self.snapshot(), "events": events})

    def _reconnect(self) -> bool:
        try:
            self.source.close()
            self.source.connect()
            self.orientation.restart_settling()
            print("board reconnected")
            return True
        except Exception as exc:
            print(f"reconnect failed: {exc}")
            return False

    def process(self, batch: np.ndarray) -> list[dict]:
        if batch.shape[1] == 0:
            return []
        for column in batch.T:
            o = self.orientation.update(column)
            self.tracker.update(self.orientation.q, np.array(o.gyro), o.dt, still=self.orientation.still and self._axes_phase is None)
            if self._axes_phase in ("nod", "turn"):
                self._axes_data[self._axes_phase].append(o.gyro)
            elif self._axes_phase == "up":
                self._axes_data["up"].append(self.tracker.g.copy())
            elif self._axes_phase == "right":
                self._axes_data["right"].append(self.tracker.raw_x())
        self.last_angles = {"roll": o.roll, "pitch": o.pitch, "yaw": o.yaw}
        self.head_xy = self.tracker.xy(self.head_axes)
        self.recorder.append(batch)
        blocked = self.gate.mask(batch[list(GYRO_ROWS)])
        streams: dict[str, list[dict]] = {}
        for name, det in self.detectors.items():
            streams[name] = det.feed(batch[EXG_ROWS[self.channels[name] - 1]], blocked)
            for event in streams[name]:
                self.recorder.detected({**event, "source": name})
        # only the input mode's detectors make clicks; "either" merges them (one action = one click)
        active = sources_for(self.input_mode, list(self.detectors))
        events = self.merger.merge({name: streams[name] for name in active})
        now = time.monotonic()
        self._rate_window = [(t, n) for t, n in self._rate_window if now - t < 2.0] + [(now, batch.shape[1])]
        span = now - self._rate_window[0][0]
        if span > 0.5:
            self.rate_hz = sum(n for _, n in self._rate_window[1:]) / span
        return events

    def snapshot(self) -> dict:
        return {
            **{k: round(v, 2) for k, v in self.last_angles.items()},
            # learned head axes (see head_axes.py); the web pages prefer these over roll/pitch/yaw
            **({"hx": round(self.head_xy[0], 2), "hy": round(self.head_xy[1], 2)} if self.head_xy else {}),
            "axes_learned": self.head_axes.ready,
            "envelope": round(self.detector.envelope, 2),
            "threshold": self.detector.threshold,
            "k": self.detector.p.k,
            "input": self.input_mode,
            "detectors": {
                name: {"channel": self.channels[name], "envelope": round(d.envelope, 2), "threshold": d.threshold, "k": d.p.k}
                for name, d in self.detectors.items()
            },
            "double_enabled": self.detector.p.double_enabled,
            "gyro_dps": round(self.gate.dps, 1),
            "gyro_gate": self.gate.threshold,
            "rate_hz": round(self.rate_hz, 1),
            "recording": self.recorder.active,
            "status": self.status,
        }

    def _detector_for(self, msg: dict) -> EyebrowDetector:
        """The detector a setup command is about: msg["detector"] ("brow" / "jaw"), default brow."""
        return self.detectors.get(msg.get("detector") or "brow", self.detector)

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
            self.tracker.zero()
        elif cmd == "axes_phase":  # guided head calibration: nod, turn, up, right, then finish
            phase = msg.get("phase")
            if phase in ("nod", "turn", "up", "right"):
                self._axes_data[phase] = []
                if phase == "up":
                    self._axes_data["up_ref"] = None if self.tracker.g0 is None else self.tracker.g0.copy()
                self._axes_phase = phase
            else:
                self._axes_phase = None
            if phase == "begin":
                self._axes_data = {}
        elif cmd == "axes_finish":
            self._axes_phase = None
            axes, report = HeadAxes.fit(self._axes_data)
            if axes is not None:
                axes.gyro_bias = self.orientation.gyro_bias.copy()
                report["gyro_bias_deg_s"] = [round(float(v), 2) for v in np.degrees(axes.gyro_bias)]
                self.head_axes = axes
                self.tracker.nod = axes.nod
                axes.save(AXES_PATH, report)
            await ws.send_text(json.dumps({"t": "axes", **report}))
        elif cmd == "axes_clear":
            self.head_axes = HeadAxes(gyro_bias=self.orientation.gyro_bias.copy())
            self.tracker.nod = None
            AXES_PATH.unlink(missing_ok=True)
        elif cmd == "set_input":
            if msg.get("input") in INPUT_MODES:
                self.input_mode = msg["input"]
                self._save_profile()
        elif cmd == "calibrate_start":
            self._detector_for(msg).start_calibration()
            self.recorder.mark("neutral", "start")
        elif cmd == "calibrate_stop":
            self.recorder.mark("neutral", "end")
            self._detector_for(msg).finish_calibration()
            self._save_profile()
        elif cmd == "set_k":
            self._detector_for(msg).p.k = float(msg["k"])
            self._save_profile()
        elif cmd == "record_start":
            meta = {"name": msg.get("name", "session"), "note": msg.get("note", ""), "protocol": msg.get("protocol")}
            self.recorder.start({**meta, "channel": self.channel, "channels": self.channels, "fs": SAMPLING_RATE_HZ}, self.detector.n)
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


def parse_channels(text: str) -> dict[str, int]:
    """'2,3' -> {"brow": 2, "jaw": 3}; '2' -> {"brow": 2}."""
    values = [int(v) for v in text.split(",") if v.strip()]
    if not 1 <= len(values) <= 2 or not all(1 <= v <= 8 for v in values) or len(set(values)) != len(values):
        raise argparse.ArgumentTypeError("use one or two different channels from 1-8, e.g. 2,3 (brow, jaw)")
    return dict(zip(("brow", "jaw"), values))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Brow Guessr server")
    parser.add_argument("--port", default="/dev/cu.usbserial-A5069RR4", help="board serial port")
    parser.add_argument("--channel", type=int, default=2, help="forehead EXG channel (1-8)")
    parser.add_argument("--channels", type=parse_channels, metavar="BROW[,JAW]",
                        help="EMG channels for the click detectors, e.g. 2,3 = brow on 2, jaw on 3 (overrides --channel)")
    parser.add_argument("--replay", type=Path, help="replay a recorded session instead of the board")
    parser.add_argument("--http-port", type=int, default=8000)
    parser.add_argument("--single", action="store_true",
                        help="single raises only: every raise clicks at once (no 0.8 s wait). Default: double raises on, "
                             "so in Street View a raise walks forward and a double raise opens the map")
    parser.add_argument("--gyro-gate", type=float, default=DEFAULT_GATE_DPS, metavar="DEG_S",
                        help=f"ignore raises while the head turns faster than this, and 150 ms after (default {DEFAULT_GATE_DPS:g}; 0 = off)")
    parser.add_argument("--gyro-units", choices=["auto", "deg_s", "rad_s"], default="auto",
                        help="units of the board's gyro rows, for the gate and head tracking (default: auto-detect)")
    args = parser.parse_args(argv)
    load_dotenv()
    channels = args.channels or {"brow": args.channel}
    if args.replay:
        source = ReplaySource(args.replay)
    else:
        source = Board(args.port, channels.get("brow", args.channel), extra_channels=tuple(channels.values()))
    hub = Hub(source, args.channel, double_enabled=not args.single, gyro_gate=args.gyro_gate,
              gyro_units=args.gyro_units, channels=channels)
    uvicorn.run(create_app(hub), host="127.0.0.1", port=args.http_port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
