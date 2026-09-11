# Noki

A rhythm-typing game: words fall down a four-lane highway in time with the music, one lane per hand zone of the keyboard, and you type them on the beat. Noki, the cat, stands on the line.

## Run

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Pick a song, a difficulty (Easy · Fair · Hard · Demon) and a mode:

- **Words** — the Highway. Whole words fall as Noki notes (the game's own note art); the strong beats are the colored notes with the glow, off-beats are plain circles. Where the song trades phrases a duet *section* opens: left hand plays the beat, right hand plays the tune, no words.
- **Letters** — osu!-style: one letter per circle on a field split into hands and rows, approach rings, follow lines, HP instead of hearts.

A song starts with a count-in: the clock runs first, the beat rows and the first word are already falling, and the music begins when chart time reaches the lead-in, so every note lands on the audible beat. In play: `Esc` pauses, `Space` starts Petal Rush when the bar is half full. On the results screen `Tab` opens the typing coach (a keyboard heatmap, three plain sentences, one thing to try).

## How it works

```
charting/               the chart generator ("Skeleton & Cells"), deterministic, cached
  skeleton.py           one decode → beat grid, per-sixteenth band accents (kick/snare/hat/vocal), onset times, slot selection
  engine.py             cells by section energy, slots loudest-hit first (strong beats break ties) with a rest after every word → whole words matched to the slot count
  words.py              the word pool (common, fun, school-safe, 2–9 letters)
  duet.py               duet section detection and the per-tier trade/echo/weave planner
  letters.py            Letters-mode planner (ergonomic letter assignment, no words)
  __init__.py           build_chart(): chart cache keyed by song + words + difficulty + generator version
game/
  clock.py              ChartClock: the one clock, anchored when the music starts, pause inside
  rhythm.py             judgment core: fixed-ms windows (±75 / 150 / 225 ms × tier), signed offsets, slip / too-early, holds, hit log, normalized score
  layout.py             every play-screen number in 1920×1080 design units, scaled to fill the window (never letterboxed)
  keyboard.py           lanes, fingers, hands, mirror keys
  highway.py            the Highway renderer (full-screen grid, orbs, connectors, word stack, HUD, Noki, duet glow)
  letters_renderer.py   the Letters-mode renderer
  play.py               PlaySession: load → play → pause → results
  sprites.py            fonts (Tacobae for display), the author's note art and press animation, Noki frames (cropped, scaled, cached on disk)
  settings.py           settings.json in the user config dir
  coach/                typing coach: stats fold, tip library, results panel
tools/render_preview.py headless preview: chart a song and render frames to PNG
tools/prechart.py       pre-chart the built-in songs into assets/charts
tests/                  pytest suite (judgment, layout, charting, end-to-end session)
```

Charts for the built-in songs ship in `assets/charts/` (regenerate with `tools/prechart.py` after changing the generator); everything else is cached under the user cache directory (`~/Library/Caches/Noki` on macOS), so a song is analysed once.

```bash
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy python3 -m pytest -q tests
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy python3 tools/render_preview.py "assets/audios/canon/noki_tutorial_file.wav" classic out/ 8,20,45 [words|letters]
```

## Scoring

Score is normalized to 1,000,000: 70 % accuracy (PERFECT 1.0 · GREAT 0.7 · OK 0.3), 20 % best combo, 10 % clean words. Grades are by accuracy (SS 99.5 % with no miss · S 95 · A 90 · B 80 · C 70). A wrong key is a slip: it never consumes the note and never breaks the combo.

## Design

The full design plan (the Noki Blueprint) covers the play experience, the charting engine, the classroom platform, progression, identity and the roadmap. The legacy engine (`game/engine.py` and `game/rendering/`) is kept for reference and is no longer used by `main.py`.
