# Brow Guessr

A GeoGuessr-style game set in **Raleigh, NC**, for kids who can't use a mouse. **Head tilt** steers Street View and an on-screen cursor. **Raising your eyebrows** clicks. Input comes from the NeuroPawn Knight IMU board: the IMU on the headset for head tilt, plus one forehead EMG electrode for the eyebrows.

| Gesture | Effect |
|---|---|
| Tilt head | Look around in Street View. On the map, move the cursor. |
| Raise eyebrows | Click: start the game, go to the map, drop a pin, or press a button (＋/－ zoom toward the map's centre) |
| Raise eyebrows twice quickly | Only with `--double`: grab the map and move it. Raise once to let go. |
| Look at the top-right corner for 2 s | Pause |
| Helper presses Space or Esc, or clicks the pause screen | Pause or resume |
| Any raise while paused | Resume. The head's neutral position is reset at the same time. |

**Mouse fallback** (no headset, or a helper wants to show something): click **▶ Play**. On the look screen, drag to look around, scroll to zoom, click the arrows on the road to walk, and click **🗺️ Map**. On the map, click to drop a pin and click **Guess!**. The head only turns the camera while it's tilted, and not for 4 s after any mouse drag, so the mouse and the head never fight over the camera.

The cursor is drawn inside the web page. It never moves the computer's real mouse, so it can't get lost or get stuck away from the off switch.

## Run it

```bash
uv sync
uv run python -m server.app            # board on /dev/cu.usbserial-A5069RR4 (change with --port)
open http://localhost:8000/calibrate.html   # setup first
open http://localhost:8000/                 # the game
```

You can work without the headset:
- `http://localhost:8000/?mock=1`: the mouse position stands in for head tilt. Press **C** for one eyebrow raise. Add `&double=1` to make **D** a double raise (map drag), matching a server started with `--double`.
- `uv run python -m server.app --replay data/sessions/<dir>`: replays a recorded session in real time.

### Server flags

| Flag | Default | What it does |
|---|---|---|
| `--double` | off | Allow double raises (grab and move the map). Off means every raise is a click, sent the moment the raise ends. There's no 0.8 s wait for a possible second raise, and the "raise twice" hint and dragging are hidden. |
| `--gyro-gate DEG_S` | `60` | Ignore eyebrow raises while the head turns faster than this many degrees per second, and for 150 ms afterwards. Any raise whose burst overlaps that window is dropped (it shows up as `gated_raise` on the setup page). `0` turns the gate off. 60 deg/s lets slow cursor-steering tilts through while blocking quick turns and nods. Tune it from recordings with `evaluate --gyro-gate` (below). |
| `--gyro-units` | `auto` | Units of the board's gyro rows (`deg_s` / `rad_s`), used by the gate and head tracking. `auto` decides once: deg/s as soon as any reading tops 20, otherwise from the first second at rest. If the gate seems to fire all the time, set this explicitly. |
| `--port`, `--channel`, `--replay`, `--http-port` | | As before. |

### Page options

| URL | What it does |
|---|---|
| `/` | Raleigh mode (default): 20 kid-friendly Raleigh spots, a map locked to Wake County, scoring in miles/feet, Street View snapped within 150 m |
| `/?region=world` | The original worldwide list, km scoring, 1 km snap |
| `/?checklocs=1` | Dev check. Asks Street View (Maps JavaScript API) for the nearest Google-captured outdoor panorama within 150 m (user-uploaded photo spheres are skipped) of every location in the current region, then prints a console table: name, found, distance to the snapped pano. Fix or drop any row that isn't `ok`. Needs the Maps key. |
| `/?mock=1` | Mouse + keys instead of the headset (combine with any of the above) |

### Raleigh mode

- **Flow:** start screen (raise to play) → 5 rounds of look → map → result → final score.
- **Hints and facts:** on the look screen, the location's hint appears after 30 s. The result card shows stars, distance, points and a fun fact.
- **Eyebrow meter:** the start screen shows a live meter (EMG envelope, with a line at the threshold) that flashes on every detected raise. A small copy sits in the bottom-left corner during the game.
- **Scoring:** points = 5000 × e^(−miles / 0.75). Stars: under 0.1 mi = 5, 0.3 = 4, 0.75 = 3, 1.5 = 2, else 1. Distances under 0.2 mi are shown in feet.
- **Helper summary:** the final screen has a "Helper summary" button. It shows raises detected, clicks used, the average time from a screen appearing to the first click on it, and the number of rounds.
- **Config:** locations live in `web/locations-raleigh.js` (`name, lat, lng, hint, fact`). Per-region settings (map view, bounds, scoring, snap radius) live in `web/regions.js`.

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
uv run python -m server.evaluate data/sessions/* --gyro-gate 0 40 60 80 120   # tune the head-motion gate
```

The output has one JSON line per session, `k` and gate value. Each line shows how many single raises were caught, false raises per minute, **false clicks per minute** (what the player actually feels), how many raises the gate dropped, and which hard negatives caused false clicks. Summary lines at the end pool all sessions for each `k` and gate value. Pick the gate that cuts `false_clicks_per_min` (and `fp_head_move`) without lowering `single_hit`. By default it scores the way the server runs by default: single raises only, gate off vs `--gyro-gate 60`. Add `--double` to score double raises too.

## Google Street View key (free tier, capped at $0)

The game works without a key, but the look screen stays blank. To add one:

1. In Google Cloud Console, create a project, add a billing account, and enable **Maps JavaScript API**.
2. Under Credentials, create an API key. Restrict it to **Maps JavaScript API** only, and to the website `http://localhost:8000/*`.
3. Under APIs & Services → Maps JavaScript API → Quotas, cap **Dynamic Street View** at about 150 per day. The free tier is 5,000 per month.
4. Under Billing → Budgets, add a budget alert at $1.
5. Copy `.env.example` to `.env` and paste in the key.

## Code layout

```
server/  app.py (web + /ws), board.py (BrainFlow), eyebrow.py (detector), gyrogate.py (head-motion gate),
         orientation.py + rows.py + ports.py (ported from the old repo),
         recording.py, evaluate.py
web/     index.html + game.js (game), calibrate.html + calibrate.js (setup/recording),
         input.js (shared head cursor, pause, mock), meter.js (eyebrow meter),
         regions.js (per-region config), locations-raleigh.js, locations.js (world),
         checklocs.js (?checklocs=1)
tests/   uv run pytest
```
