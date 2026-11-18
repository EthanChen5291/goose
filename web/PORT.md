# Noki on the web — port plan

The charting pipeline stays in Python. It already emits JSON charts; the web client
loads audio + chart JSON and renders. Nothing about `charting/` or `analysis/` moves.

## What moves

| Python | TypeScript | Lines (py) | Notes |
|---|---|---|---|
| `game/rhythm.py` | `src/core/rhythm.ts` | 562 | pure logic, 1:1 port, same tests |
| `game/clock.py` | `src/core/clock.ts` | 95 | rewritten on `AudioContext.currentTime` |
| `game/models.py` | `src/core/models.ts` | 167 | only the play-side types |
| `game/constants.py` | `src/core/constants.ts` | 125 | tiers, windows, lives |
| `game/keyboard.py` | `src/core/keyboard.ts` | 95 | lane/finger/hand tables |
| `game/layout.py` | `src/core/layout.ts` | 165 | 1920×1080 design units, fill not letterbox |
| `game/play.py` | `src/core/session.ts` | 444 | frame loop, input, pause |
| `game/highway.py` + `sprites.py` | `src/render/highway/*` | 2411 | Pixi scene graph |
| `game/letters_renderer.py` | `src/render/letters/*` | 504 | Pixi scene graph |
| `game/menu*.py`, `game/screens/*` | `src/screens/*` | 2700 | DOM/CSS, not canvas |
| `game/ui_components.py:Petal` | `src/screens/chrome.ts` | 55 | one canvas, not one node each |
| `game/coach/*` | `src/screens/coach.ts` | 368 | DOM |

Everything else (`charting/`, `analysis/`, `game/beatmap_generator.py`,
`game/slot_builder.py`, `tools/`) stays Python and is untouched.

## Phases

0. **Export pipeline** — `tools/export_web.py` writes `public/charts/*.json`,
   `public/index.json`, transcoded audio, fonts and images. Charts are already
   the right shape; only the song list and audio need packaging.
1. **Core** — clock, models, constants, keyboard, layout, rhythm + tests.
   Judgment parity is proven by a golden-replay harness, not by eyeballing.
2. **Highway renderer** — the play screen at 60 fps on the GPU.
3. **Letters renderer**.
4. **Screens** — title, level select, pause, results, settings, coach. DOM, not canvas.
5. **Deploy** — static build; audio streamed, not bundled.

## The two decisions that matter

**Clock.** pygame reads `mixer.music.get_pos()` and slews. The browser gives
`AudioContext.currentTime`, which is a sample clock, so chart time is
`ctx.currentTime - startedAt + leadIn + offset` with no drift correction at all.
The slew path in `clock.py` does not get ported; it is worked around hardware
that the browser does not expose.

**Input latency.** `keydown` fires off the main thread's event loop, so a long
frame delays the timestamp. `KeyboardEvent.timeStamp` is the real press time —
judgment reads that, not "now". This is strictly more accurate than the pygame
build, where a 25 ms frame cost 25 ms of judgment error.

## Audio budget

`assets/audios/` is 575 MB. The web build ships a curated set, streamed from
`/audio/`, decoded once per session. A 4-minute 128k mp3 is ~4 MB; twelve songs
is ~50 MB of cold-cache traffic, none of it in the JS bundle.

---

## Status

Ported and verified:

- **Core** — `clock.ts`, `models.ts`, `constants.ts`, `keyboard.ts`, `layout.ts`,
  `rhythm.ts`, `settings.ts`.
- **Typing coach** — `coach/stats.ts`, `coach/tips.ts`, `coach/panel.ts`. The fold
  and the tip library are pure, so they are parity-checked like the judgment core.
- **Renderers** — the Highway (including the duet strip, the lock meter and the
  combo milestone) and the Letters field.
- **Shell** — title, song select, settings, pause, results, the Typing view on
  Tab, and imported songs. DOM, not canvas.

  The first pass made the menus ordinary web pages — a card grid on a flat
  background — which worked but was a different app to look at. They now follow
  the desktop screens: the title is Noki bopping under the spotlight with the
  wordmark and the play and settings buttons beside it, song select is Noki over
  the pink upload button with Canon / Custom tabs and a centred list of names with
  their grades, and drifting petals run behind both. The animations are the packed
  strips from `export_web.py`, stepped through `background-position`, so a
  menu costs one element per figure rather than a video decode per frame.

  Every menu is laid out once in a 1920×1080 box and scaled to the window
  (`chrome.ts:fitStage`), which is what pygame does by sizing everything against
  sw/sh. Before that the menus were in CSS units, so they sat in the corner of a
  large display and scrolled on a small one.
- **Export pipeline** — `tools/export_web.py`: 14 songs, 112 charts, fonts,
  hitsound, and Noki's animations packed into spritesheets. Audio 575 MB → 38 MB.
- **Imported songs** — `tools/chart_file.py` charts any local file into a bundle;
  the "Add a song" screen stores it with its audio in IndexedDB.

### Tests

62 across three files: the 11 from `test_rhythm.py`, 4 window-boundary tests
(mirrored back into the Python suite), 2 rounding tests, 17 golden-replay cases,
and 28 for the coach.

Both parity harnesses are mutation-tested — a harness that has never failed has
not been shown to work:

| | planted bugs | caught |
|---|---|---|
| judgment core | 8 | 8 |
| typing coach | 6 | 6 |

The first run of each caught fewer. The judgment tape politely avoided window
boundaries and the hold-release grace, so `<=` passed as `<` and a 150 ms window
passed as a 152 ms one; the coach cases never produced two finger tips that tied,
so walking the fingers in the wrong order changed nothing. Both gaps are now
covered — by aiming the tape at the boundaries, and by hand-built cases where a
tape cannot reach (a press can never land exactly on a window edge at t ≈ 100 s).

### Not ported

Nothing outstanding from the desktop play path. Still missing from the menus:

- **The launch intro.** `noki_intro.mov` plays once before the title on the
  desktop; the web build opens on the title itself.
- **Eye tracking.** Song select shows `noki_base_loop`; the desktop composites
  `left` / `right` over it so Noki watches the pointer. Both strips are exported
  and unused, so this is wiring, not assets.

Two things differ by necessity:

- **In-browser charting is not possible.** The pipeline is librosa, scipy and
  numba; none of it runs in a tab, and the alternatives are a charting server or
  a rewrite of `analysis/`. So `tools/chart_file.py` charts a file on your machine
  into a bundle and the web app imports it. If a backend ever appears, the same
  bundle format is what it would return.
- **The practice actions the coach suggests** (`drill:keys`, `drill:words`,
  `practice_loop`) are shown as text, as they are on the desktop; nothing acts on
  them there either. `PlaySession.seek()` exists and is what a practice loop would
  be built on.

## Measured

Over 300 consecutive frames of real play, in headless Chromium on this Mac:

| | pygame (this Mac) | web |
|---|---|---|
| renderer | 3.5 ms avg, 99th < 7 ms | — |
| display flip | 2.6 ms typical, 10 ms spikes | — |
| **frame, end to end** | ~6 ms typical, 25 ms spikes | **16.7 ms median, 16.8 ms p99, 16.8 ms max** |

16.7 ms is the vsync interval: every frame lands, and the worst frame in 300 is
0.1 ms off the best. The lag is gone, not reduced — and that is before the
input-latency win, which the pygame build cannot have at all.

That last figure took one fix. The first measurements showed a single 50–83 ms
frame per 300, about one dropped frame every five seconds. The cause was textures
baking lazily: the starburst on the first hit, the shard on the first miss, the
petal on the first word. The pygame build warms its caches at load (`_warm_caches`)
for exactly this reason and the port had skipped it. Both renderers now warm every
texture in their constructor, and the visible-note list is computed once a frame
rather than once per caller.

## Running it

```bash
python3 web/tools/export_web.py       # once, and after re-charting
cd web && npm install && npm run dev

npm test                              # core + coach + parity
npm run build && npx vite preview     # then, in another shell:
node tools/smoke.mjs                  # menu -> play -> pause -> results -> coach -> settings
IMPORT_DIR=... node tools/smoke-import.mjs   # the imported-song round trip
```

`SONG="Catch Catch" MODE=letters node tools/smoke.mjs` picks a different song and
mode; the duet check needs a song whose chart has one. In Letters mode the
synthesised typing slips enough to drain HP, so that run usually ends in a real
failure — which is itself worth having covered.

### After changing the Python

`game/rhythm.py` and `game/coach/*` are held to exact parity by a recorded tape.
Change either and the tape is stale:

```bash
python3 web/tools/parity_dump.py && cd web && npm test
```
