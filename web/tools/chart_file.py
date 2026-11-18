"""
Chart one audio file into a bundle the web client can import.

The desktop build charts an uploaded song in-process: librosa decodes it, the
Skeleton & Cells engine reads the beat grid and the band accents, and play
starts.  A browser cannot do that.  librosa, scipy and numba are not going to
run in a tab, and the honest alternatives are a charting server or nothing.

So the web client plays charts rather than making them, and this is the seam:
run it on any audio file and it writes `<name>.nokichart.json` next to it — the
chart, the beat grid and the song's own metadata in one file.  Drop that file
and the audio into the web app's "Add a song" screen and it plays like any
shipped song.

    python3 web/tools/chart_file.py song.mp3
    python3 web/tools/chart_file.py song.mp3 --tiers classic master --modes words

Every tier and mode goes in one bundle by default, so the import screen offers
the same choices a shipped song does.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

TIERS = ("journey", "classic", "master", "demon")
MODES = ("words", "letters")
BUNDLE_VERSION = 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("audio", help="the audio file to chart")
    ap.add_argument("--tiers", nargs="+", default=list(TIERS), choices=TIERS)
    ap.add_argument("--modes", nargs="+", default=list(MODES), choices=MODES)
    ap.add_argument("--title", default=None, help="defaults to the filename")
    ap.add_argument("-o", "--out", default=None, help="output path for the bundle")
    args = ap.parse_args()

    audio = os.path.abspath(args.audio)
    if not os.path.exists(audio):
        sys.exit(f"no such file: {audio}")

    import pygame
    pygame.init()

    from charting import GENERATOR_VERSION, _events_to_json, chart_id
    from charting.engine import chart_song
    from game.models import Level
    from game.menu_utils import _load_word_banks

    banks = _load_word_banks()
    try:
        from game.menu import DEFAULT_WORD_BANK
    except Exception:
        import main as app
        DEFAULT_WORD_BANK = app.WORD_BANK_1
    words = banks.get(os.path.basename(audio), list(DEFAULT_WORD_BANK))

    title = args.title or os.path.splitext(os.path.basename(audio))[0]
    bundle: dict = {
        "bundle_version": BUNDLE_VERSION,
        "generator": GENERATOR_VERSION,
        "title": title,
        "audio_name": os.path.basename(audio),
        "charts": {},
    }

    for tier in args.tiers:
        for mode in args.modes:
            level = Level(words, audio, difficulty=tier, mode=mode)
            t0 = time.perf_counter()
            r = chart_song(level, audio)
            song = r["song"]
            took = time.perf_counter() - t0
            bundle["charts"][f"{tier}|{mode}"] = {
                "id": chart_id(audio, words, tier, mode, None),
                "song": {"bpm": song.bpm, "duration": song.duration,
                         "beat_times": list(song.beat_times)},
                "events": _events_to_json(r["events"]),
                "lead_in": r["lead_in"],
                "meta": dict(r.get("meta", {}), generator=GENERATOR_VERSION),
            }
            bundle.setdefault("bpm", round(song.bpm, 2))
            bundle.setdefault("duration", round(song.duration, 1))
            print(f"{tier}|{mode}: {r['meta'].get('notes')} notes in {took:.1f}s")

    out = args.out or os.path.join(os.path.dirname(audio),
                                   os.path.splitext(os.path.basename(audio))[0] + ".nokichart.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(bundle, f)
    mb = os.path.getsize(out) / 1e6
    print(f"\nwrote {out} ({mb:.1f} MB, {len(bundle['charts'])} charts)")
    print("Import it with the audio file in the web app's “Add a song” screen.")


if __name__ == "__main__":
    main()
