# Browsr

## What it is

Hands-free Street View. You put on a headset and explore the world without using your hands. It opens on the street outside the building you're in. From there you can:

- look around by turning your head;
- walk or drive by raising your eyebrows;
- jump anywhere by voice ("take me to Paris").

The headset is a NeuroPawn Knight IMU board. Its motion sensor (IMU) tracks the head, and one forehead EMG electrode picks up the eyebrow muscle. A Python server reads the board, turns the signals into head position and click events, and streams them to a web page over a WebSocket. The page drives Google Street View.

## Why

People with ALS, high spinal cord injury, or other conditions that take away hand function often can't leave the house easily. They can't use a mouse or touchscreen to explore on their own either. Brow Explorer gives them back some independent "going outside":

- see their own street, or travel anywhere;
- every input is one a person with no hand movement can still make: small head movements, an eyebrow raise, or speech;
- a caregiver can set it up once (start location, calibration) and pause it at any time.

This started as a GeoGuessr-style guessing game ("Brow Guessr") and became a free-exploration experience instead.

## How it works: no neural net

All predictions come from classic signal processing with a few settings tuned on recorded data. There is **no trained classifier**. The previous hackathon's extra-trees model caught only 57% of raises. A per-person threshold detector is simpler, runs in real time, and can be recalibrated in 8 s.

| Job | Method | Code |
|---|---|---|
| Eyebrow raise → click | Band-pass the forehead EMG to 25–55 Hz, then take an RMS envelope. Set a per-person threshold from a relaxed baseline: median + *k* × MAD over the quieter half of an 8 s rest, capped at `max_threshold`. A burst of 0.16–2 s above the threshold is a raise; two raises within 1 s make a double raise. | `server/eyebrow.py` |
| Tuning the detector | Grid search over 500 settings. Each one is replayed through the real detector on every recorded session and scored leave-one-session-out. The winner is saved to `data/detector_params.json`, which the server loads at start-up. | `server/train.py` |
| Head orientation | A Madgwick filter fuses the accelerometer and gyro (`ahrs` library). | `server/orientation.py` |
| Head → left/right, up/down | Learned from a 25 s nod/shake calibration (the nod axis is found by SVD), so it works however the sensor is mounted. Up/down comes from gravity, so it can't drift. Left/right is the gyro integrated about vertical, eased back to centre while the head is still. | `server/head_axes.py` |
| Look around | Rate control: the further you turn, the faster the view turns, with a deadzone so a still head keeps the view still. | `web/game.js` |
| Voice | The browser's Web Speech API (Chrome/Edge). | `web/game.js` |
| Place names → coordinates | Google Geocoding, or OpenStreetMap Nominatim as a fallback. The result snaps to the nearest Google Street View photo. | `web/game.js` |

**Current eyebrow results.** These come from 6 recorded sessions from 2 people. Each session is scored with settings tuned *without* it (`data/detector_params.json`):

| | Result |
|---|---|
| Single raises caught | 103/120 (86%). Five sessions caught 18–20 out of 20; one of Zach's caught 9/20. |
| Double raises caught | 35/60 (58%) |
| False raises | 0.5–3.4 per minute (mean 1.7), mostly blinks, swallows and talking |

Next steps:
- get false raises under 0.5 per minute;
- make double raises more reliable;
- record more sessions with more people.

## Controls

| Input | Effect |
|---|---|
| Turn or tilt your head | Look around (like a joystick: the further you turn, the faster the view turns) |
| Raise eyebrows once | **Walking:** take one step along the road in view. **Car:** start or stop driving. |
| Raise eyebrows twice quickly | Switch between walking 🚶 and the car 🚗 |
| Say "go to …" a place | Travel there, e.g. "go to the Grand Canyon" or "take me to Paris" |
| Say "go home" / "surprise me" | Back to the starting street / a random famous place |
| Say "stop", "walk", "drive", "pause" | Park the car / switch mode / pause |
| Helper presses Space or Esc | Pause or resume |
| Helper presses `/` | Type a place instead of saying it |
| Any raise while paused | Resume. The head's neutral position is reset at the same time. |

A green arrow shows where a raise will take you. If no road is in front of you, a tag at the edge of the screen points to the nearest one. While driving, turning your head steers at junctions. If the road ends, the car parks itself.

**Where it starts:** `START_LOCATION` in `.env` (`lat,lng` or an address, set once by a caregiver). If it's empty, the browser's location is used (the browser asks once), and if that isn't available, a default place. It snaps to the nearest Google Street View photo.

**Voice** uses the browser's speech recognition. That needs Chrome or Edge and microphone permission, and the audio is processed by the browser vendor's speech service. Place names are looked up with Google's geocoder if your key allows the Geocoding API, otherwise with OpenStreetMap Nominatim (free, no key).

## Run it

```bash
uv sync
uv run python -m server.app            # board on /dev/cu.usbserial-A5069RR4 (change with --port)
open http://localhost:8000/calibrate.html   # setup first
open http://localhost:8000/                 # the game
```

You can work without the headset:
- `http://localhost:8000/?mock=1`: the mouse position stands in for head movement. Press **C** for one eyebrow raise and **D** for a double raise.
- `uv run python -m server.app --replay data/sessions/<dir>`: replays a recorded session in real time.

## Hardware setup

- **Electrodes:** one forehead electrode on **channel 2** (gain 12), with the reference on the ear clip.
- **Sample-rate check:** `uv run python -m server.board --seconds 30`. The rate should come out close to 125 Hz. The last hackathon only got 72–79 Hz. The report goes to `data/ratecheck/`.
- **Setup page:** follow it in order. Click **Learn my head movements** (nod, shake, look up, look right; ~25 s) so nods move only up/down and turns only left/right however the sensor is mounted. Then zero the head, calibrate the eyebrows (stay relaxed for 8 s), then test some raises.

## Collect data, then hand it to Claude

1. On `calibrate.html`, under **Record a training session**: about 3.5 minutes of big on-screen prompts. That's 20 single raises, 10 double raises, and 20 actions that should *not* count as raises (blink, swallow, head move, talk).
2. Record **at least 5 sessions**: 3 normal, 1 with light raises, 1 with the head moving between prompts.
3. Sessions are saved to `data/sessions/<time>-<name>/` (`raw.npz`, `labels.jsonl`, `metadata.json`). **This folder is committed to git on purpose**, because last time the data was lost.
4. Tell Claude "analyze data/sessions". It runs:

```bash
uv run python -m server.evaluate data/sessions/* --k 4 5 6 8
```

The output shows, per session: how many single and double raises were caught, false raises per minute, and which hard negatives caused false clicks.

## Train the detector on your sessions

```bash
uv run python -m server.train data/sessions/*
```

This tries 500 detector settings: sensitivity `k`, EMG band, envelope speed, burst length limits, the double-raise window, and debounce. Each setting is replayed through the real detector on every session. The script prints three tables:

- **Current defaults:** how the untuned detector does.
- **Tuned:** the best settings, scored on the sessions they were tuned on. This is optimistic.
- **Held-out check:** each session scored by settings tuned *without* it. **Trust this one.** It needs at least 2 sessions.

The best settings are saved to `data/detector_params.json`, and the server loads them at start-up, so restart it afterwards. The `k` in `data/profile.json` is updated to match. Moving the setup-page slider still overrides `k` afterwards. Calibrate again ("relax 8 s") after training, since the threshold is set from your neutral baseline.

The scoring rewards caught single raises the most. Then it rewards caught double raises (×0.5), and penalises false raises per minute (×0.25) and singles read as doubles (×0.5). Change the `W_*` weights in `server/train.py` to shift the balance. Use `--dry-run` to see results without saving.

## Google Maps key (free tier)

Without a key the Street View screen stays blank. To add one:

1. In Google Cloud Console, create a project, add a billing account, and enable **Maps JavaScript API**. Optionally also enable **Geocoding API**; without it, voice place names use OpenStreetMap Nominatim.
2. Under Credentials, create an API key. Restrict it to those APIs and to the websites `http://localhost:8000/*` and `http://127.0.0.1:8000/*`.
3. Under Billing → Budgets, add a $1 budget alert. An alert only emails you; it doesn't stop charges. As far as we know, Dynamic Street View is billed per page load, not per step, so walking and driving don't add cost. Check usage in the console after a long drive to confirm.
4. Copy `.env.example` to `.env`, paste in the key, and optionally set `START_LOCATION`.

## Code layout

```
server/  app.py (web + /ws), board.py (BrainFlow), eyebrow.py (raise detector), train.py (detector tuning),
         head_axes.py (head calibration), orientation.py + rows.py + ports.py (ported from the old repo),
         recording.py, evaluate.py
web/     index.html + game.js (explorer: Street View, walk/drive, voice), calibrate.html + calibrate.js
         (setup/recording), input.js (head input, pause, mock), locations.js ("surprise me" places)
tools/   visual_tests.html (SSVEP/alpha flicker tests from early exploration)
data/    sessions/ (recordings, committed), detector_params.json (tuned detector)
tests/   uv run pytest
```
