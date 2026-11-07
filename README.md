# Brow Guessr

A GeoGuessr-style game for kids who can't use a mouse. **Head tilt** steers Street View and an on-screen cursor. **Raising your eyebrows** clicks. Input comes from the NeuroPawn Knight IMU board: the IMU on the headset for head tilt, plus one forehead EMG electrode for the eyebrows.

| Gesture | Effect |
|---|---|
| Tilt head | Look around in Street View. On the map, move the cursor. |
| Raise eyebrows once | Click: go to the map, drop a pin, or press a button |
| Raise eyebrows twice quickly | Grab the map and move it. Raise once to let go. |
| Look at the top-right corner for 2 s | Pause |
| Helper presses Space or Esc | Pause or resume |
| Any raise while paused | Resume. The head's neutral position is reset at the same time. |

The cursor is drawn inside the web page. It never moves the computer's real mouse, so it can't get lost or get stuck away from the off switch.

## Run it

```bash
uv sync
uv run python -m server.app            # board on /dev/cu.usbserial-A5069RR4 (change with --port)
open http://localhost:8000/calibrate.html   # setup first
open http://localhost:8000/                 # the game
```

You can work without the headset:
- `http://localhost:8000/?mock=1`: the mouse position stands in for head tilt. Press **C** for one eyebrow raise and **D** for a double raise.
- `uv run python -m server.app --replay data/sessions/<dir>`: replays a recorded session in real time.

## Hardware setup

- **Electrodes:** one forehead electrode on **channel 2** (gain 12), with the reference on the ear clip.
- **Sample-rate check:** `uv run python -m server.board --seconds 30`. The rate should come out close to 125 Hz. The last hackathon only got 72–79 Hz. The report goes to `data/ratecheck/`.
- **Setup page:** follow it in order. Zero the head, check the axes, calibrate the eyebrows (stay relaxed for 8 s), then test some raises.

## Collect data, then hand it to Claude

1. On `calibrate.html`, under **Record a training session**: about 3.5 minutes of big on-screen prompts. That's 20 single raises, 10 double raises, and 20 actions that should *not* count as raises (blink, swallow, head move, talk).
2. Record **at least 5 sessions**: 3 normal, 1 with light raises, 1 with the head moving between prompts.
3. Sessions are saved to `data/sessions/<time>-<name>/` (`raw.npz`, `labels.jsonl`, `metadata.json`). **This folder is committed to git on purpose**, because last time the data was lost.
4. Tell Claude "analyze data/sessions". It runs:

```bash
uv run python -m server.evaluate data/sessions/* --k 4 5 6 8
```

The output shows, per session: how many single and double raises were caught, false raises per minute, and which hard negatives caused false clicks.

## Google Street View key (free tier, capped at $0)

The game works without a key, but the look screen stays blank. To add one:

1. In Google Cloud Console, create a project, add a billing account, and enable **Maps JavaScript API**.
2. Under Credentials, create an API key. Restrict it to **Maps JavaScript API** only, and to the website `http://localhost:8000/*`.
3. Under APIs & Services → Maps JavaScript API → Quotas, cap **Dynamic Street View** at about 150 per day. The free tier is 5,000 per month.
4. Under Billing → Budgets, add a budget alert at $1.
5. Copy `.env.example` to `.env` and paste in the key.

## Code layout

```
server/  app.py (web + /ws), board.py (BrainFlow), eyebrow.py (detector),
         orientation.py + rows.py + ports.py (ported from the old repo),
         recording.py, evaluate.py
web/     index.html + game.js (game), calibrate.html + calibrate.js (setup/recording),
         input.js (shared head cursor, pause, mock), locations.js
tests/   uv run pytest
```
