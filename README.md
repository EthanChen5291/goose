<div align="center">

# goose

[![Builds](https://img.shields.io/badge/builds-web%20%C2%B7%20desktop%20%C2%B7%20unity-black.svg)](#quick-start)
[![Engine](https://img.shields.io/badge/charts-librosa%20audio%20analysis-green.svg)](#how-it-works)
[![Tests](https://img.shields.io/badge/tests-make%20test-lightgrey.svg)](#quick-start)

</div>

![Title screen](docs/img/title.png)

## Overview

Pick a song and a difficulty. Songs are analysed once and charted to the beat, so every note lands on the audible beat.

## Gameplay

The camera sits behind the goose on a runway in the level's sky, the enemy at the far end throwing the song at you. Each note is an attack whose shape tells you the key: `D`/`K` sidestep a laser wall, `F` flatten under a blade, `Space` jump a floor wave, `J` peck an orb back. Every dodge answers with a bolt; a miss knocks the goose back and costs HP.

Between fights is the world: six stones along the path per world, flags on the ones you have cleared, the goose standing on your pick.

Scoring is normalised to 1,000,000: 70% accuracy, 20% best combo, 10% clean words. A wrong key is a slip, never a broken combo. `Tab` on the results screen opens the typing coach.

| The world | The duel |
|---|---|
| ![](docs/img/map.png) | ![](docs/img/duel.png) |

## Quick start

```sh
python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
make web        # generate assets, then the Vite dev server
make play       # the desktop build (pygame), no generation step
make test       # Python and web suites
```

Song analysis is cached under your user cache directory; `make clean-cache` drops it. The Unity port lives under `Goose/` with its own `make unity-*` targets.

## Repository

| Path | Contents |
|---|---|
| `analysis/`, `charting/` | Audio analysis and the chart generators: words, letters, duets, sections |
| `game/` | The desktop game (pygame) |
| `web/` | The web client (TypeScript, Pixi.js, three.js, Vite) |
| `Goose/` | The Unity 6 port |
| `assets/`, `tools/` | Source art, songs, charts, and the generators behind `make assets` |
| `tests/` | pytest suite |

## Acknowledgements

[librosa](https://librosa.org), [pygame](https://www.pygame.org), [Pixi.js](https://pixijs.com), [three.js](https://threejs.org), [Vite](https://vitejs.dev).
