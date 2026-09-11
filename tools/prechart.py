"""
Pre-chart the built-in songs so a fresh install never waits for analysis.

    SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy python3 tools/prechart.py [--force]

Writes one JSON per song × difficulty × mode into assets/charts/ (the same format as
the user cache) plus assets/charts/index.json for humans.  build_chart() looks there
first.  Charts are keyed by song fingerprint, word list, difficulty, mode and generator
version, so bumping GENERATOR_VERSION means running this again.
"""
from __future__ import annotations
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
import pygame
pygame.init()

from charting import chart_id, REPO_CHARTS, GENERATOR_VERSION, _events_to_json
from charting.engine import chart_song
from game.models import Level
from game.menu_utils import _load_word_banks
import main as app


def main() -> None:
    force = "--force" in sys.argv
    os.makedirs(REPO_CHARTS, exist_ok=True)
    banks = _load_word_banks()
    try:
        from game.menu import DEFAULT_WORD_BANK
    except Exception:
        DEFAULT_WORD_BANK = app.WORD_BANK_1
    index_path = os.path.join(REPO_CHARTS, "index.json")
    index = {}
    if os.path.exists(index_path):
        try:
            loaded = json.load(open(index_path, "r", encoding="utf-8"))
            # the file is {"generator": ..., "charts": {...}}; an older flat file is the map itself
            index = dict(loaded.get("charts", loaded)) if isinstance(loaded, dict) else {}
            if loaded.get("generator") != GENERATOR_VERSION:
                index = {}                      # every chart is rebuilt below
        except Exception:
            index = {}
    songs = list(app.SONG_NAMES) + ["noki_tutorial_file.wav"]
    for name in songs:
        path = app.CANON_PATH + name
        if not os.path.exists(path):
            path = app.CUSTOM_PATH + name
        if not os.path.exists(path):
            print("skip (missing)", name)
            continue
        words = banks.get(name, list(DEFAULT_WORD_BANK))
        for diff in ("journey", "classic", "master", "demon"):
            for mode in ("words", "letters"):
                level = Level(words, path, difficulty=diff, mode=mode)
                cid = chart_id(path, words, diff, mode, None)
                out = os.path.join(REPO_CHARTS, cid + ".json")
                key = f"{name}|{diff}|{mode}"
                if os.path.exists(out) and not force:
                    index[key] = cid
                    continue
                t0 = time.perf_counter()
                r = chart_song(level, path)
                song = r["song"]
                data = {
                    "song": {"bpm": song.bpm, "duration": song.duration, "beat_times": list(song.beat_times)},
                    "events": _events_to_json(r["events"]),
                    "lead_in": r["lead_in"],
                    "meta": dict(r.get("meta", {}), generator=GENERATOR_VERSION, build_seconds=round(time.perf_counter() - t0, 2)),
                }
                with open(out, "w", encoding="utf-8") as f:
                    json.dump(out_json := data, f)
                index[key] = cid
                print(f"{key}: {r['meta'].get('notes')} notes in {time.perf_counter() - t0:.1f}s")
    # drop index entries whose file is gone or whose version is old
    index = {k: v for k, v in index.items() if isinstance(v, str) and os.path.exists(os.path.join(REPO_CHARTS, v + ".json"))}
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({"generator": GENERATOR_VERSION, "charts": dict(sorted(index.items()))}, f, indent=1)
    # charts from an older generator are never read again: drop them so the folder stays honest
    keep = set(index.values())
    stale = [f for f in os.listdir(REPO_CHARTS) if f.endswith(".json") and f != "index.json" and f[:-5] not in keep]
    for f in stale:
        os.remove(os.path.join(REPO_CHARTS, f))
    print("done:", len(index), "charts in", REPO_CHARTS, "| removed", len(stale), "stale")


if __name__ == "__main__":
    main()
