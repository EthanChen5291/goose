"""
How our charts compare with Keyboard Warrior's, on the reels we have hit times for.

    python3 tools/reel_check.py                       # every song, every tier
    python3 tools/reel_check.py --tier classic        # one tier
    python3 tools/reel_check.py --song moonbound --plot

`tools/reel_compare.py` reads a reel's video to find *their* note times (the slot
circles flash on every hit) and caches them in `tools/reel_data/`.  This reads
that cache instead, so it needs only the reel's audio, and answers three
questions per song and tier:

  density   notes per second, theirs and ours
  agreement the share of their notes with one of ours inside 90 ms, and the reverse
  content   what each set lands on, read off our own skeleton — the attack the
            point carries (vocal / kick / snare / hat / full) and whether it is on
            a beat or between beats

`content` is the one that answers "is it on the strong melody notes".  A chart can
match the density and the grid exactly and still pick the wrong sixteenth: if
their notes are mostly `vocal` and ours are mostly `kick`, ours is playing the
drums while theirs plays the tune.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

DATA = os.path.join(HERE, "reel_data", "keyboard_warrior_expert.json")
WORDS = ["cat", "moon", "over", "kitten", "someone", "store", "submit", "jungle"]
TIERS = ("journey", "classic", "master", "demon")
TOL = 0.09


def find_reel(reel_id: str) -> str | None:
    """The reel's video file, wherever it landed."""
    names = [f"igexport-{reel_id}.mp4", f"igexport-{reel_id}.MP4", f"{reel_id}.mp4", f"{reel_id}.MP4"]
    for d in (ROOT, os.path.expanduser("~/Downloads")):
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return p
    return None


def audio_of(video: str, out_dir: str, name: str) -> str:
    wav = os.path.join(out_dir, name + ".wav")
    if not os.path.exists(wav):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                        "-vn", "-ac", "1", "-ar", "22050", wav], check=True)
    return wav


def near(a: np.ndarray, b: np.ndarray, tol: float = TOL) -> float:
    """Share of `a` with an element of `b` within `tol`."""
    if len(a) == 0 or len(b) == 0:
        return 0.0
    j = np.clip(np.searchsorted(b, a), 1, len(b) - 1)
    return float((np.minimum(np.abs(a - b[j - 1]), np.abs(a - b[j])) <= tol).mean())


def content(ts: np.ndarray, sk) -> dict:
    """What a set of times lands on, read off our skeleton."""
    if len(ts) == 0:
        return {}
    pt = np.array([p.t for p in sk.points])
    counts = {"vocal": 0, "kick": 0, "snare": 0, "hat": 0, "full": 0}
    onbeat = 0
    melodic = 0
    peak = 0
    for t in ts:
        j = int(np.clip(np.searchsorted(pt, t), 1, len(pt) - 1))
        p = sk.points[j - 1 if abs(pt[j - 1] - t) < abs(pt[j] - t) else j]
        if p.attack in counts:
            counts[p.attack] += 1
        onbeat += p.sub == 0
        melodic += bool(p.melodic)
        peak += bool(p.peak)
    n = len(ts)
    out = {k: round(v / n, 2) for k, v in counts.items() if v}
    out["onbeat"] = round(onbeat / n, 2)
    out["melodic"] = round(melodic / n, 2)
    out["peak"] = round(peak / n, 2)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default=None, choices=TIERS)
    ap.add_argument("--song", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "reel_check_out"))
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    ref = json.load(open(DATA, encoding="utf-8"))["songs"]
    tiers = [args.tier] if args.tier else list(TIERS)

    import pygame
    pygame.init()
    from game.models import Level
    from charting.engine import chart_song

    rows: list[dict] = []
    for name, info in ref.items():
        if args.song and name != args.song:
            continue
        video = find_reel(info["reel"])
        if video is None:
            print(f"{name}: reel not found, skipping")
            continue
        wav = audio_of(video, args.out, name)
        theirs = np.array(sorted(h[0] for h in info["hits"]))
        dur = float(info["duration"])
        # the reel opens on a title card and ends mid-phrase; trim both
        theirs = theirs[(theirs >= 0.5) & (theirs <= dur - 0.3)]

        for tier in tiers:
            r = chart_song(Level(WORDS, wav, difficulty=tier), wav)
            sk = r["skeleton"]
            ours = np.array(sorted(e.timestamp for e in r["events"] if not e.is_rest and e.char))
            ours = ours[(ours >= 0.5) & (ours <= dur - 0.3)]
            row = {
                "song": name, "tier": tier, "bpm": round(sk.bpm, 1),
                "theirs_n": len(theirs), "ours_n": len(ours),
                "theirs_nps": round(len(theirs) / dur, 2), "ours_nps": round(len(ours) / dur, 2),
                "theirs_covered": round(near(theirs, ours), 2),
                "ours_on_theirs": round(near(ours, theirs), 2),
                "theirs_content": content(theirs, sk),
                "ours_content": content(ours, sk),
            }
            rows.append(row)
            print(f"{name:16s} {tier:8s} bpm {row['bpm']:6.1f} | "
                  f"nps {row['theirs_nps']:5.2f} vs {row['ours_nps']:5.2f} | "
                  f"theirs covered {row['theirs_covered']:.2f}  ours on theirs {row['ours_on_theirs']:.2f}")
            print(f"{'':25s} theirs {json.dumps(row['theirs_content'])}")
            print(f"{'':25s} ours   {json.dumps(row['ours_content'])}")

    json.dump(rows, open(os.path.join(args.out, "report.json"), "w"), indent=1)

    # ── the summary that answers the question ────────────────────────────────
    if rows:
        print("\n" + "=" * 78)
        for tier in tiers:
            sel = [r for r in rows if r["tier"] == tier]
            if not sel:
                continue
            def avg(k, sub=None):
                vals = [(r[k][sub] if sub else r[k]) for r in sel if (not sub or sub in r[k])]
                return sum(vals) / len(vals) if vals else 0.0
            print(f"{tier:8s} n={len(sel):2d} | "
                  f"nps theirs {avg('theirs_nps'):.2f} ours {avg('ours_nps'):.2f} | "
                  f"theirs covered {avg('theirs_covered'):.2f} | ours on theirs {avg('ours_on_theirs'):.2f}")
            print(f"{'':9s} melodic  theirs {avg('theirs_content', 'melodic'):.2f}  "
                  f"ours {avg('ours_content', 'melodic'):.2f}")
            print(f"{'':9s} vocal    theirs {avg('theirs_content', 'vocal'):.2f}  "
                  f"ours {avg('ours_content', 'vocal'):.2f}")
            print(f"{'':9s} onbeat   theirs {avg('theirs_content', 'onbeat'):.2f}  "
                  f"ours {avg('ours_content', 'onbeat'):.2f}")
            print(f"{'':9s} peak     theirs {avg('theirs_content', 'peak'):.2f}  "
                  f"ours {avg('ours_content', 'peak'):.2f}")
        print(f"\nwrote {os.path.join(args.out, 'report.json')}")


if __name__ == "__main__":
    main()
