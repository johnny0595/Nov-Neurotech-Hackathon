# Nov Neurotech Hackathon — Progress & Ideas Log

> One file to track where we are, what we've decided, and what we might try.
> Add new log entries at the **top** of the Progress Log. Keep entries short.

---

## Quick status

| | |
|---|---|
| **Project idea** | Leading candidate: SSVEP-controlled Sphero BOLT (idea #3) |
| **EEG headset** | NeuroPawn Biopotential Kit (Knight board): 8 channels, 125 Hz, USB serial, BrainFlow `NEUROPAWN_KNIGHT_BOARD` |
| **Current focus** | Getting the Meta Quest and the EEG to work together |
| **Blockers** | — |
| **Demo / deadline** | _TBD_ |

## Team

| Name | Role / focus | Contact |
|---|---|---|
| | | |

---

## Progress log

### 2026-11-07 (evening): Brow Explorer (branch `explore-mode`)
- Direction change: no more guessing game. It's now a viewing experience for ALS patients with no
  hand function: start outside their own building, look around, walk or drive, and say "go to …" a place.
- Raise once = step (walking) or start/stop (car); raise twice = switch walking/car. Voice:
  "go to X", "go home", "surprise me", "stop", "walk", "drive", "pause". Helper can press `/` to type.
- Start location: `START_LOCATION` in `.env`, else browser location, else a default.
- Tested in mouse mode: "go to the grand canyon" lands on the Colorado River in the canyon; car mode
  drives down Broadway from Times Square. Not yet tried with the headset or a real microphone.
- Open questions: ALS often affects speech too, so voice may not work for every patient. Consider
  a favourites list chosen with raises. Also: a way for the patient to pause by themselves.

### 2026-11-07
- Eyebrow capture working on **channel 8** (`uv run python -m server.app --channel 8`); raises
  show up after calibration. Board issues found:
  - All channels start off, and commands sent 0.5 s apart get dropped. `server/board.py` now
    sends `chon_<ch>_12`, waits 1.5 s, and checks the channel is live (retries ×4).
  - The firmware stalls at "Scanning for IMU..." and streams *nothing* if the IMU isn't found,
    which happens after cable tugs or repeated reconnects. Fix: unplug USB for 5 s, replug, and
    connect once (keep the NeuroPawn Visualizer closed).
- Pulled repo: project is **Brow Guessr** (head-tilt IMU + forehead EMG eyebrow clicks).
- Added `server/train.py`: searches detector settings over recorded sessions, reports a
  held-out score, and saves the best to `data/detector_params.json`, which the server loads.
  On synthetic data it cut false raises from 6.85/min to 0 and kept 4/4 raises. Still needs real sessions.
- Next: record ≥5 sessions on calibrate.html → `uv run python -m server.train data/sessions/*`.
- NeuroPawn EXG Visualizer working: all 8 channels show signal (board type: Knight Board IMU,
  gain 12, Route RLD off). The spectrum showed a peak at ~5 Hz with harmonics at 10/15/20 Hz.
- Added `tools/visual_tests.html`: full-screen SSVEP flicker, left/right targets, flicker on/off
  blocks, and eyes-closed/eyes-open alpha test with beeps. Frequencies divide the screen refresh.
- Next: run the test sequence (alpha → SSVEP single → on/off → left/right) and screenshot results here.
- EEG hardware confirmed: **NeuroPawn Biopotential Kit**. BrainFlow config: 8 EEG channels at
  125 Hz, `serial_port` must be `/dev/cu.*` on macOS, optional `{"gain": 1–12}` (default 12).
  Electrodes can go anywhere, so occipital (O1/Oz/O2) for SSVEP is possible.
- Checked out the **Meta Quest**. Fitting it together with the EEG is awkward (rear strap sits over
  occipital sites) but looks workable.
- Explored steering the Sphero BOLT with vision. Plan: SSVEP on a laptop screen first, then move
  the flickering targets into the Quest (passthrough so the real ball stays visible). Fallback: eye
  movements (EOG) from frontal electrodes.
- Repo created; started this log.
- Went through the NCSU Libraries device catalog (298 devices, via
  `https://www.lib.ncsu.edu/api/devices/everything.json`) for gear that pairs with EEG.
  Shortlist is under [Hardware we can borrow](#hardware-we-can-borrow).

<!-- Template for new entries:
### YYYY-MM-DD
- What we did
- What we learned / results
- Next steps
-->

---

## Ideas backlog

Status: 💡 idea · 🔍 exploring · ✅ chosen · ❌ dropped

| # | Idea | Hardware needed | Feasibility / notes | Status |
|---|---|---|---|---|
| 1 | **Multimodal stress / calm monitor**: EEG + HRV fused into one relaxation score, with live feedback | EEG, HeartMath Inner Balance | Two signals tell a better story; HRV app is phone-only, so we may need to export data | 💡 |
| 2 | **Guided neurofeedback meditation**: Dodow-style breathing pacer, adapted to live alpha power | EEG, Dodow light (or an on-screen pacer) | Easy MVP; alpha goes up when eyes close (easy demo) | 💡 |
| 3 | **Brain-controlled robot**: steer a Sphero BOLT by looking at flickering targets (SSVEP), with eye movements (EOG) as fallback | NeuroPawn EEG, Sphero BOLT, laptop, Meta Quest (optional) | BrainFlow → CCA classifier → `spherov2` over BLE. Screen first, then Quest passthrough | 🔍 |
| 4 | **VR + EEG experiment**: event-related potentials (ERP) or attention measured during VR tasks | EEG, Quest Pro / Quest 3S, Legion T7 | VR straps sit over electrode sites, so contact is a risk | 💡 |
| 5 | **Physical BCI output**: EEG → Raspberry Pi/Pico drives LEDs, buzzer, or motor | EEG, Raspberry Pi 4 or Pico kit | Cheap, portable; good learning project | 💡 |
| 6 | **Focus tracker for studying**: detect focus/distraction, nudge the user (pairs with Brick phone blocker) | EEG, laptop | Needs a calibration step for each user | 💡 |
| 8 | **"Brain eye-tracking" for Quest 2**: every object you can interact with flickers at its own frequency/code, so looking at it selects it (pick up, teleport, open menus) with no controllers. Quest 2 has no eye tracking | NeuroPawn, Quest 2, laptop | Strong pitch; SSVEP for ≤6 objects, c-VEP for more | 💡 |
| 9 | **VR c-VEP speller / hands-free keyboard**: 30+ key virtual keyboard, each key on a shifted pseudorandom code; accessibility angle (ALS, limited mobility) | NeuroPawn, Quest 2 | c-VEP needs a ~1–2 min calibration and accurate stimulus timing (LSL markers). 125 Hz is tight, so hold each code bit for 2 frames | 💡 |
| 10 | **Covert attention detector (frequency tagging)**: two scenes/speakers flicker at different rates; EEG shows which one you're *paying attention to* even while looking at the middle | NeuroPawn, Quest 2 | Research-flavoured "wow"; the effect is weaker than direct gaze, so it needs longer windows | 💡 |
| 11 | **Hybrid confirm**: SSVEP/c-VEP chooses, eyes-closed alpha burst or jaw clench confirms (cuts false triggers) | NeuroPawn | Add-on for any of 3/8/9 | 💡 |
| 12 | **Comfortable SSVEP**: get rid of the eye strain. Compare standard flicker vs. high-frequency (30–45 Hz), low-contrast sinusoidal, and motion-based (SSMVEP) stimuli; measure accuracy *and* comfort | NeuroPawn, Quest 2 (90/120 Hz) or laptop | Mentor hint: "look at why that hurts". Turns a known weakness of SSVEP into our contribution. 125 Hz sampling means staying below ~50 Hz | 💡 |
| 13 | **Fatigue-aware BCI**: track visual fatigue live (SSVEP strength dropping, alpha rising) and adapt by lowering contrast, switching stimulus type, or prompting a break | NeuroPawn | Pairs with #12; the strain becomes a signal we measure | 💡 |
| 7 | **Movement + EEG**: Vive Trackers / Leap Motion for motor imagery vs. real movement, or artifact rejection | EEG, Motion Tracking Dev Kit | More ambitious; strong technically | 💡 |

---

## Hardware we can borrow

From NCSU Libraries ([catalog](https://www.lib.ncsu.edu/devices)). Loan length and location as listed on 2026-11-07.

| Device | Use with EEG | Loan | Where | Status |
|---|---|---|---|---|
| [HeartMath Inner Balance](https://www.lib.ncsu.edu/devices/inner-balance) | HRV sensor (125 Hz, Bluetooth) | 7d | Vet Med | not requested |
| [Meta Quest Pro](https://www.lib.ncsu.edu/devices/quest-pro) | VR stimuli, eye tracking | 7d | Hill/Hunt (orientation) | not requested |
| [Meta Quest 3S](https://www.lib.ncsu.edu/devices/quest-3s) | Cheaper VR stimuli | 7d | Hunt/Hill | not requested |
| [Motion Tracking Dev Kit](https://www.lib.ncsu.edu/devices/motion-tracking-development-kit) | Vive Trackers + Leap Motion | 7d | Hill | not requested |
| [Lenovo Legion T7 (VR dev)](https://www.lib.ncsu.edu/devices/legion-t7-gaming-desktop-0) | Unity/Unreal, real-time processing | 7d | Hunt/Hill (orientation) | not requested |
| [Raspberry Pi 4 kit](https://www.lib.ncsu.edu/devices/raspberry-pi) | Portable acquisition / LSL bridge | 7d | Hunt/Hill | not requested |
| [Raspberry Pi Pico kit](https://www.lib.ncsu.edu/devices/raspberry-pi-pico-kit) | Physical output, event markers | 7d | Hunt/Hill | not requested |
| [Analog Discovery 3](https://www.lib.ncsu.edu/devices/analog-discovery-3) | Scope/signal gen for amplifier checks | 7d | Hunt | not requested |
| [Sphero BOLT](https://www.lib.ncsu.edu/devices/sphero-bolt-robotic-ball) | BCI-controlled robot | 7d | Hunt/Hill | not requested |
| [Dodow light](https://www.lib.ncsu.edu/devices/guided-meditation-light) | Breathing-pacer stimulus | 1d | Vet Med / Design | not requested |
| [Zihnic ANC headphones](https://www.lib.ncsu.edu/devices/active-noise-cancelling-headphones) | Quiet recording conditions | 1d | Design | not requested |
| [Logitech C920](https://www.lib.ncsu.edu/devices/c920-webcam) | Video synced with EEG | 7d | Vet Med | not requested |

> ⚠️ VR headset straps press on frontal, parietal and occipital electrodes. Plan electrode placement around them.

---

## Decisions

| Date | Decision | Why |
|---|---|---|
| | | |

---

## TODO

- [ ] Confirm which EEG headset we have (channels, sample rate, SDK/LSL support)
- [ ] Pick 1–2 ideas from the backlog
- [ ] Request/reserve hardware (note the orientations required for VR Studio / Legion)
- [ ] Set up the data pipeline (acquire → filter → features → output)
- [ ] Build MVP
- [ ] Prepare demo + slides

---

## Open questions

-

## Resources & links

- NCSU device catalog: https://www.lib.ncsu.edu/devices
- Device API (JSON): https://www.lib.ncsu.edu/api/devices/everything.json (supports `?keyword=`)
- Lab Streaming Layer (LSL): https://labstreaminglayer.org
- MNE-Python: https://mne.tools
- BrainFlow: https://brainflow.org

### 2026-11-08 morning: retrained with Zach's sessions
- Two new sessions (102250, 102647, Zach). With the old settings, 102250 got 17/20 raises and **102647 got 0/20**.
- Why 102647 failed: during its 8 s "relax" period there were muscle bursts up to about 2500. The baseline spread (MAD) came out about twice as large, and k×MAD set the threshold (about 3450) above the raises.
- Raise peaks are about 3500–5500 at gain 12 in every session, for both people. Only the resting noise varies.
- Fixes:
  - The baseline now uses the quieter half of the rest period, in 1 s chunks (`quiet_part`).
  - New `max_threshold` setting caps the threshold. Training picked 2000.
- New settings: k=20, cap 2000, release 0.5, debounce 0.1 s.
  - 102647: 19/20 after tuning.
  - The other sessions: 16–20/20, with 0.5–2.4 false raises per minute.
  - When 102647 is held out of training, it still only gets 9/20. No other session is noisy, so training without it has no reason to choose a cap.
