# Noki

<img src="assets/images/noki_preview.png" alt="Noki Preview" width="980">


A rhythm-based typing system that trains touch-typing by syncing input to visual beats. Converts audio files into interactive typing levels — making practice individualized and habit-forming.

## 🌟 Features

- **Automatic beatmap generation** from any MP3/WAV — no manual charting required
- **Custom parsing pipeline** that converts audio features into precisely timed input events
- **4 difficulty modes**: Journey, Classic, Master, Demon — scaling from beginner to extreme
- **Dynamic scroll speed** that responds to song intensity in real time
- **Persistent high scores** per song and difficulty
- **Custom song support** via file upload with optional BPM override
- **Canon song library** with 14+ built-in tracks

## 🏗️ Architecture

```
┌────────────────────────┐
│   Audio File (MP3/WAV) │
└──────────┬─────────────┘
           │
           │  BPM · beat times · intensity · drops
           │
┌──────────▼─────────────────────────────────┐
│  Audio Analysis                             │  librosa · scipy · numpy
│  analysis/audio_analysis.py                 │  soundfile · audioread
└──────────┬─────────────────────────────────┘
           │
           │  rhythm slots · intensity profile · hold regions
           │
┌──────────▼─────────────────────────────────┐
│  Beatmap Generator                          │  beatmap_generator.py
│  (audio features → timed input events)      │  slot_builder.py
└──────────┬─────────────────────────────────┘
           │
           │  CharEvent list (char + timestamp + word metadata)
           │
┌──────────▼─────────────────────────────────┐
│  Game Engine                                │  engine.py · rhythm.py
│  (run loop · input · scoring · physics)     │  mechanics.py · input.py
└──────────┬─────────────────────────────────┘
           │
           │  draw calls · particle events · UI state
           │
┌──────────▼─────────────────────────────────┐
│  Renderer Layer                             │  pygame · cv2
│  (timeline · notes · words · effects)       │  word_renderer · note_renderer
└────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology |
|---|---|
| Language | Python 3.8+ |
| Game Engine | Pygame 2.6.1 |
| Audio Analysis | librosa 0.11.0, scipy 1.17.0, numpy 2.3.5 |
| Video Decoding | OpenCV (cv2) 4.13.0 |
| Audio I/O | soundfile 0.13.1, audioread 3.1.0 |
| System Dependency | FFmpeg (required by librosa) |

## 🚀 Quick Start

<img src="assets/images/noki_preview2.png" alt="Noki Preview 2" width="980">

### Prerequisites

- Python 3.8+
- FFmpeg installed and on your system PATH

### 1. Clone the Repository

```bash
git clone <repository-url>
cd key-dash
```

### 2. Create a Virtual Environment

```bash
python -m venv venv
source venv/bin/activate      # macOS / Linux
# or: venv\Scripts\activate   # Windows
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the Game

```bash
python main.py
```

**Menu flow:**
1. Title screen → select a song (canon library or upload your own)
2. Level menu → choose difficulty, word bank, and optionally override BPM
3. Play the level — type each word in sync with the beat
4. Scores are saved automatically per song and difficulty

## 📖 Project Structure

```
key-dash/
├── main.py                         # Entry point — menu loop, level loading
├── game/
│   ├── engine.py                   # Main Game class (run loop, update, rendering)
│   ├── rhythm.py                   # RhythmManager — timing windows, scoring, combo
│   ├── mechanics.py                # Scroll speed, bounce mode, dual-side mode
│   ├── input.py                    # Keyboard input handler
│   ├── models.py                   # Data classes (CharEvent, Word, Song, …)
│   ├── constants.py                # Difficulty profiles & all tunable parameters
│   ├── menu.py                     # Menu state machine, pause screen
│   ├── menu_utils.py               # File picker, lyrics fetching, JSON persistence
│   ├── music.py                    # Background music manager
│   ├── ui_components.py            # Buttons, petal animations, text input, widgets
│   ├── beatmap_generator.py        # Public API for beatmap generation
│   ├── slot_builder.py             # Rhythm slot building & word-to-slot assignment
│   ├── rendering/                  # Visual renderers & effects
│   │   ├── effects.py              # Particles, shockwaves, screen shake (mixin)
│   │   ├── note_renderer.py        # Note sprite & hold-bar rendering
│   │   ├── word_renderer.py        # Word carousel, repeat coloring, underline
│   │   ├── timeline_renderer.py    # Timeline bar, beat grid, progress bar
│   │   └── edge_glitch.py          # Edge curvature / dissolve post-process effect
│   └── screens/                    # Full-screen UI views
│       ├── title_screen.py         # Animated title screen
│       ├── level_select.py         # Song library browser
│       ├── level_menu.py           # Difficulty / BPM / word-bank picker
│       ├── file_upload_screen.py   # Custom song upload flow
│       └── settings_panel.py       # In-game settings overlay
├── analysis/
│   └── audio_analysis.py           # BPM detection, intensity, drops, dual-sections
├── assets/
│   ├── audios/                     # Canon song audio files (MP3/WAV)
│   ├── images/                     # Sprites, hit-effect frames, animated notes, font
│   ├── scores.json                 # Persistent high scores per song + difficulty
│   ├── custom_songs.json           # User-uploaded song list
│   ├── custom_bpms.json            # User BPM overrides
│   └── song_words.json             # Cached word banks per song
└── tests/                          # Test suite
```

## 🎯 Core Concepts

### Difficulty Modes

| Mode | CPS Target | Scroll Scale | Timing | Character |
|---|---|---|---|---|
| Easy  | 2.0 | 0.8× | Lenient | Long words, wide timing windows |
| Fair  | 3.0 | 1.0× | Normal | Default balanced experience |
| Hard  | 4.5 | 1.25× | Tight | Short words, bounce sections enabled |
| Demon | 5.5 | 1.25× | Very tight | Burst spam, maximum note density |

*CPS = characters per second target for word selection and slot density.*

### Bounce Mode

High-energy song sections trigger Bounce Mode. The timeline direction reverses at each bounce event, and notes alternate coming from the left and right sides of the hitmarker. Players must track direction changes while maintaining typing rhythm.

### Dual-Side Mode

During climax sections the timeline expands to full screen width and notes stream simultaneously from both sides. The cat mascot (Noki) animates between positions to indicate the active side.

### Dynamic Scroll Speed

Scroll speed continuously lerps between intensity tiers derived from the song's audio analysis. Energy spikes temporarily increase speed; quiet sections slow it down. The dual-side and bounce states apply additional damping to keep notes readable.

### Hold Notes

Low-intensity regions in the audio are detected as hold note candidates. Players must press and hold the key for the note's full duration — releasing early breaks the hold and triggers a miss penalty.

### Scoring

Each character hit is judged as **Perfect**, **Good**, or **OK** based on timing offset from the target beat. Misses reset the combo counter. Final score = weighted hit total × combo multiplier (capped at 2×).

## ⚙️ Beatmap Generation Pipeline

The core system converts raw audio into timed input events through six stages:

1. **Audio Analysis** — extract BPM, beat times, per-beat intensity, section energy shifts, drop events, dual-side section boundaries, and hold regions
2. **Slot Building** — generate candidate placement slots from 16th-note sub-beat subdivisions, prioritized by intensity (strong > medium > weak)
3. **Intensity Adjustment** — prune slots in quiet measures, increase density in loud ones; Demon mode floods loud sections with all available slots
4. **Word Preparation** — pre-compute ideal beat duration and rhythm-snapped CPS for every word in the selected word bank
5. **Word Assignment** — match words to slots measure-by-measure, honoring difficulty CPS targets, quiet-skip probability, bounce grace zones, and hold region detection
6. **Post-processing** — deduplicate events, cap hold durations so tails never overlap the next note, and trim events past the song's end

## 📝 Configuration Files

| File | Purpose |
|---|---|
| `assets/scores.json` | Persistent high scores: `{ song: { difficulty: score } }` |
| `assets/custom_songs.json` | Names of user-uploaded custom songs |
| `assets/custom_bpms.json` | BPM overrides: `{ song: bpm }` |
| `assets/song_words.json` | Cached word banks (fetched from Genius lyrics or built-in default) |
| `game/constants.py` | All tunable parameters: CPS targets, timing windows, max slots per measure, scroll speed multipliers, bounce threshold |

## 🧪 Testing

```bash
cd key-dash
pytest
```

Tests are located in `tests/` and cover audio analysis utilities and beatmap generation correctness.

## 🐛 Troubleshooting

**Audio analysis fails or no beats are detected**
- Ensure FFmpeg is installed and available on your PATH — librosa requires it for MP3 decoding

**pygame display errors on launch**
- Confirm a display is available; on headless systems export `SDL_VIDEODRIVER=dummy`

**Custom song doesn't appear in the menu**
- Confirm the file is MP3 or WAV format; re-upload via the file upload screen in the level select menu

**BPM feels off or notes don't line up with the music**
- Use the BPM override field in the level menu to manually specify the correct BPM for that song

**Low frame rate or stuttering**
- Reduce the window size, or lower the animated fast-note sprite FPS in `game/constants.py`

---

**Noki** — where every keystroke lands on the beat 🎵⌨️
