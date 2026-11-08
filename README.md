# Brow Explorer

Hands-free Street View for people with ALS or others who can't use their hands. It opens on the street outside the building you're in, and you look around, walk or drive using only head movement, eyebrow raises and your voice. Input comes from the NeuroPawn Knight IMU board: the IMU on the headset for head movement, plus one forehead EMG electrode for the eyebrows.

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
