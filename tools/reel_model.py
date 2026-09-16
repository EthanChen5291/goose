"""
Is Keyboard Warrior's chart just "the loudest onsets"?

    python3 tools/reel_model.py

`tools/reel_bands.py` says their notes sit on audible onsets but not on any one
instrument.  That leaves the simplest model of all: detect the onsets, take the
strongest N of them, done — no grid, no melody, no layers.  This tests that model
by building it and scoring it against their chart the same way ours is scored.

Four candidates, each asked for exactly as many notes as they played, so density
can never be what wins:

    full     the strongest N onsets of the whole mix
    lead     the strongest N onsets of the harmonic band above 280 Hz
    onbeat   the N onsets nearest a beat of our grid
    ours     what the charting engine actually produces

and two baselines that say what a score means:

    chance   N onsets picked at random from the same detected set
    ceiling  how much of their chart *any* model built on onsets could reach —
             the share of their notes with a detected onset within the window.
             A model cannot beat this, so a score should be read against it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

DATA = os.path.join(HERE, "reel_data", "keyboard_warrior_expert.json")
WORDS = ["cat", "moon", "over", "kitten", "someone", "store", "submit", "jungle"]
HOP = 256
TOL = 0.09


def near(a: np.ndarray, b: np.ndarray, tol: float = TOL) -> float:
    if len(a) == 0 or len(b) == 0:
        return 0.0
    j = np.clip(np.searchsorted(b, a), 1, len(b) - 1)
    return float((np.minimum(np.abs(a - b[j - 1]), np.abs(a - b[j])) <= tol).mean())


def f1(theirs: np.ndarray, ours: np.ndarray) -> float:
    """Both directions at once: their notes we found, and our notes they played."""
    r, p = near(theirs, ours), near(ours, theirs)
    return 2 * r * p / (r + p) if (r + p) else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="classic")
    ap.add_argument("--out", default=os.path.join(HERE, "reel_check_out"))
    args = ap.parse_args()

    import pygame
    pygame.init()
    import librosa
    from charting.skeleton import _band_onsets
    from charting.engine import chart_song, get_skeleton
    from game.models import Level
    from reel_bands import best_offset

    ref = json.load(open(DATA, encoding="utf-8"))["songs"]
    rng = np.random.default_rng(3)
    names = ["full", "lead", "onbeat", "ours", "chance", "ceiling"]
    agg = {k: [] for k in names}

    print(f"{'song':17s} {'N':>4s} {'lag':>6s} | " + " ".join(f"{k:>7s}" for k in names))
    for name, info in ref.items():
        wav = os.path.join(args.out, name + ".wav")
        if not os.path.exists(wav):
            continue
        y, sr = librosa.load(wav, sr=22050, mono=True)
        envs = _band_onsets(y, sr, HOP)
        dur = float(info["duration"])

        theirs = np.array(sorted(h[0] for h in info["hits"]))
        theirs = theirs[(theirs >= 0.5) & (theirs <= dur - 0.3)]
        theirs = theirs + best_offset(envs["full"], theirs, sr)
        lag = best_offset(envs["full"], np.array(sorted(h[0] for h in info["hits"])), sr)
        N = len(theirs)

        def top_n(env, n):
            fr = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=HOP, backtrack=False)
            t = librosa.frames_to_time(fr, sr=sr, hop_length=HOP)
            v = env[fr]
            m = (t >= 0.5) & (t <= dur - 0.3)
            t, v = t[m], v[m]
            return np.sort(t[np.argsort(-v)[:n]]), t

        full_t, full_all = top_n(envs["full"], N)
        lead_t, _ = top_n(envs["vocal"], N)

        sk = get_skeleton(wav)
        beats = np.array(sk.beat_times, dtype=float)
        d = np.abs(full_all[:, None] - beats[None, :]).min(axis=1) if len(beats) else np.zeros(len(full_all))
        onbeat_t = np.sort(full_all[np.argsort(d)[:N]])

        r = chart_song(Level(WORDS, wav, difficulty=args.tier), wav)
        ours = np.array(sorted(e.timestamp for e in r["events"] if not e.is_rest and e.char))
        ours = ours[(ours >= 0.5) & (ours <= dur - 0.3)]

        chance = np.sort(rng.choice(full_all, min(N, len(full_all)), replace=False))
        row = {"full": f1(theirs, full_t), "lead": f1(theirs, lead_t),
               "onbeat": f1(theirs, onbeat_t), "ours": f1(theirs, ours),
               "chance": f1(theirs, chance), "ceiling": near(theirs, full_all)}
        for k, v in row.items():
            agg[k].append(v)
        print(f"{name:17s} {N:4d} {lag * 1000:5.0f}m | " + " ".join(f"{row[k]:7.2f}" for k in names))

    print("\n" + "-" * 72)
    print(f"{'mean':17s} {'':4s} {'':6s} | "
          + " ".join(f"{float(np.mean(agg[k])):7.2f}" for k in names))
    print("\nF1 against their chart, both directions, 90 ms window.  Read every column")
    print("against `chance` (the same count drawn from the same onsets) and `ceiling`")
    print("(the most any onset-based model could reach).")


if __name__ == "__main__":
    main()
