"""
What is Keyboard Warrior actually charting?  Read straight off the waveform.

    python3 tools/reel_bands.py
    python3 tools/reel_bands.py --song moonbound

`tools/reel_check.py` answered this by looking up each of their hits in *our*
skeleton and reporting what that point carried.  That was the wrong instrument:
it can only see what our grid can represent, and on a song whose grid does not
fit, every one of their hits gets attributed to whichever of our points happened
to be nearest.  This asks the audio directly.

Their hit times come from the reel's video, so they carry the flash's lag — a
constant per song.  It is measured here rather than assumed: the offset that puts
their hits on the most full-mix onset energy is found first, and printed, and
everything after is measured at the corrected times.

For each hit, every band's onset envelope is sampled in a window around it and
the loudest band wins.  Because a band can win by being loud everywhere rather
than loud *there*, the same statistics are taken at random times in the same song
and shown underneath: a band that takes 45 % of their hits and 40 % of random
ones is telling you nothing.  Our own notes get the identical treatment, so the
two columns are comparable.

    lead   the harmonic band above 280 Hz — a voice, a guitar, a synth line
    bass   the harmonic band below it
    kick / snare / hat   the drum kit
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
WIN = 0.035          # how far either side of a hit a band is allowed to sound
BANDS = ("lead", "bass", "kick", "snare", "hat")
# `_band_onsets` calls the lead band "vocal" for historical reasons
KEY = {"lead": "vocal", "bass": "bass", "kick": "kick", "snare": "snare", "hat": "hat"}


def sample(env: np.ndarray, t: np.ndarray, sr: int) -> np.ndarray:
    """Peak of an envelope within WIN of each time."""
    w = max(1, int(round(WIN * sr / HOP)))
    idx = np.clip((t * sr / HOP).round().astype(int), 0, len(env) - 1)
    return np.array([env[max(0, i - w):i + w + 1].max() for i in idx])


def profile(envs: dict, t: np.ndarray, sr: int) -> dict:
    """Which band each time lands on, and how much lands on nothing at all."""
    if len(t) == 0:
        return {}
    cols = np.vstack([sample(envs[KEY[b]], t, sr) for b in BANDS])
    full = sample(envs["full"], t, sr)
    quiet = cols.max(axis=0) < 0.30          # no band really sounds here
    win = np.argmax(cols, axis=0)
    out = {b: float(((win == i) & ~quiet).mean()) for i, b in enumerate(BANDS)}
    out["nothing"] = float(quiet.mean())
    out["audible"] = float((full >= 0.30).mean())
    return out


def best_offset(env: np.ndarray, t: np.ndarray, sr: int, span: float = 0.25) -> float:
    """The constant lag between the video's flash and the sound it belongs to."""
    offs = np.linspace(-span, span, 201)
    score = [sample(env, np.clip(t + o, 0, None), sr).sum() for o in offs]
    return float(offs[int(np.argmax(score))])


def row(label: str, p: dict) -> str:
    return (f"{label:22s} " + " ".join(f"{p.get(b, 0.0):6.2f}" for b in BANDS)
            + f" | {p.get('nothing', 0.0):7.2f} {p.get('audible', 0.0):8.2f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default=None)
    ap.add_argument("--tier", default="classic")
    ap.add_argument("--out", default=os.path.join(HERE, "reel_check_out"))
    args = ap.parse_args()

    import pygame
    pygame.init()
    import librosa
    from charting.skeleton import _band_onsets
    from charting.engine import chart_song
    from game.models import Level

    ref = json.load(open(DATA, encoding="utf-8"))["songs"]
    rng = np.random.default_rng(11)
    agg: dict[str, list[dict]] = {"theirs": [], "ours": [], "random": []}

    hdr = f"{'':22s} " + " ".join(f"{b:>6s}" for b in BANDS) + f" | {'nothing':>7s} {'audible':>8s}"
    for name, info in ref.items():
        if args.song and name != args.song:
            continue
        wav = os.path.join(args.out, name + ".wav")
        if not os.path.exists(wav):
            print(f"{name}: no audio in {args.out} — run reel_check.py first")
            continue

        y, sr = librosa.load(wav, sr=22050, mono=True)
        envs = _band_onsets(y, sr, HOP)
        dur = float(info["duration"])

        theirs = np.array(sorted(h[0] for h in info["hits"]))
        theirs = theirs[(theirs >= 0.5) & (theirs <= dur - 0.3)]
        off = best_offset(envs["full"], theirs, sr)
        theirs = theirs + off

        r = chart_song(Level(WORDS, wav, difficulty=args.tier), wav)
        ours = np.array(sorted(e.timestamp for e in r["events"] if not e.is_rest and e.char))
        ours = ours[(ours >= 0.5) & (ours <= dur - 0.3)]
        rand = np.sort(rng.uniform(0.5, dur - 0.3, len(theirs)))

        print(f"\n{name}  ({len(theirs)} of theirs, {len(ours)} of ours, "
              f"video lag {off * 1000:+.0f} ms)")
        print(hdr)
        for key, t in (("theirs", theirs), ("ours", ours), ("random times", rand)):
            p = profile(envs, t, sr)
            agg[{"theirs": "theirs", "ours": "ours", "random times": "random"}[key]].append(p)
            print(row(key, p))

    if agg["theirs"]:
        print("\n" + "=" * 72)
        print(hdr)
        for key in ("theirs", "ours", "random"):
            m = {k: float(np.mean([p.get(k, 0.0) for p in agg[key]]))
                 for k in list(BANDS) + ["nothing", "audible"]}
            print(row("mean · " + key, m))
        t, o = agg["theirs"], agg["ours"]
        lead_t = float(np.mean([p["lead"] for p in t]))
        lead_o = float(np.mean([p["lead"] for p in o]))
        print(f"\ntheirs follow the lead band on {lead_t:.0%} of notes, ours on {lead_o:.0%}, "
              f"random times {float(np.mean([p['lead'] for p in agg['random']])):.0%}")


if __name__ == "__main__":
    main()
