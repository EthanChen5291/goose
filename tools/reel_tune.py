"""
Sweep the melody knobs against the Keyboard Warrior reels.

    python3 tools/reel_tune.py                    # the presets below
    python3 tools/reel_tune.py --tier master

`tools/reel_check.py` says how far our charts are from theirs; this says which
constants close the gap.  Each config is applied by patching the module globals
that govern where a note may go inside a phrase that follows the tune, then the
eight reel songs are charted and scored.

The three numbers that matter, with the reference in brackets:

    vocal   share of our notes on a lead attack            [0.47]
    onbeat  share on a beat rather than between beats      [0.21]
    match   share of their notes with one of ours in 90 ms

Skeletons are cached, so only the engine re-runs per config.
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

from reel_check import DATA, WORDS, TOL, content, near  # noqa: E402

# Each config sets: the grid bias for a lead note, the relative loudness an
# off-beat / off-grid lead note must reach, and the lead sixteenth weight.
CONFIGS: dict[str, dict] = {
    "current": {},
    "grid_soft": {"MELODIC_METRIC_SCALE": 0.18},
    "offbeat_open": {"EIGHTH_REL": 0.32, "SIXTEENTH_REL": 0.40, "OFFGRID_REL": 0.42, "OFFGRID_V": 0.30},
    "both": {"MELODIC_METRIC_SCALE": 0.18, "EIGHTH_REL": 0.32, "SIXTEENTH_REL": 0.40,
             "OFFGRID_REL": 0.42, "OFFGRID_V": 0.30},
    "both_more": {"MELODIC_METRIC_SCALE": 0.10, "EIGHTH_REL": 0.28, "SIXTEENTH_REL": 0.34,
                  "OFFGRID_REL": 0.38, "OFFGRID_V": 0.28},
    "melody_first": {"MELODIC_METRIC_SCALE": 0.05, "EIGHTH_REL": 0.26, "SIXTEENTH_REL": 0.30,
                     "OFFGRID_REL": 0.34, "OFFGRID_V": 0.26, "ONBEAT_REL": 0.42},
    # rank a lead slot by how much the tune *rises* into it rather than by how loud
    # it is.  A melody note between two beats is a new note; the beat under it is
    # often louder but is not a note of the tune at all.
    "onset_rank": {"ONSET_RANK": 1.0, "MELODIC_METRIC_SCALE": 0.18,
                   "EIGHTH_REL": 0.32, "SIXTEENTH_REL": 0.40, "OFFGRID_REL": 0.42, "OFFGRID_V": 0.30},
    "onset_rank_hard": {"ONSET_RANK": 1.0, "MELODIC_METRIC_SCALE": 0.05,
                        "EIGHTH_REL": 0.26, "SIXTEENTH_REL": 0.30, "OFFGRID_REL": 0.34,
                        "OFFGRID_V": 0.26},
}


def apply(cfg: dict) -> None:
    """Patch the knobs.  `layer_eligible` is rewritten so its thresholds are data."""
    from charting import skeleton as SK

    SK.MELODIC_METRIC_SCALE = cfg.get("MELODIC_METRIC_SCALE", SK._ORIG_MMS)
    eighth = cfg.get("EIGHTH_REL", 0.40)
    sixteenth = cfg.get("SIXTEENTH_REL", 0.50)
    offgrid_rel = cfg.get("OFFGRID_REL", 0.50)
    offgrid_v = cfg.get("OFFGRID_V", 0.35)
    onbeat_rel = cfg.get("ONBEAT_REL", 0.0)

    def layer_eligible(p, layer: str, finest: int, rel: float) -> bool:
        if not p.layer_peak(layer):
            return False
        v = p.layer(layer)
        if v < 0.28 or rel < 0.35:
            return False
        if p.sub % finest != 0:
            return layer == "lead" and rel >= offgrid_rel and v >= offgrid_v
        if p.sub == 0:
            return rel >= onbeat_rel if layer == "lead" else True
        return rel >= (eighth if p.sub == 2 else sixteenth)

    SK.layer_eligible = layer_eligible

    onset_rank = cfg.get("ONSET_RANK", 0.0)

    def select_layer_slots(pts, layer, k, min_gap, finest, taken=None):
        """A copy of SK.select_layer_slots with the lead ranking swapped out."""
        if not pts or k <= 0:
            return [], []
        vals = [p.layer(layer) for p in pts]
        top = max(vals)
        if top < 0.28:
            return [], []
        top = min(top, 1.0)
        cand = [p for p, v in zip(pts, vals) if SK.layer_eligible(p, layer, finest, v / top)]
        if not cand:
            return [], []
        if onset_rank and layer == "lead":
            # rise into each point, from the sixteenth before it
            idx = {id(p): i for i, p in enumerate(pts)}
            def score(p):
                i = idx[id(p)]
                prev = vals[i - 1] if i > 0 else 0.0
                rise = max(0.0, vals[i] - prev) / top
                return (1.1 * rise + 0.5 * (vals[i] / top)
                        + SK.MELODIC_METRIC_SCALE * SK.METRIC_PRIO[p.metric])
        else:
            def score(p):
                return SK.layer_score(p, layer, p.layer(layer) / top)
        order = sorted(cand, key=lambda p: (-score(p), p.t))
        kept = []
        busy = list(taken or [])
        if layer != "lead":
            first = next((p for p in order if p.sub == 0), None)
            if first is not None and all(abs(first.t - q.t) >= min_gap for q in busy):
                kept.append(first)
        for p in order:
            if len(kept) >= k:
                break
            if p in kept:
                continue
            if all(abs(p.t - q.t) >= min_gap for q in kept) and all(abs(p.t - q.t) >= min_gap for q in busy):
                kept.append(p)
        return sorted(kept, key=lambda p: p.t), cand

    SK.select_layer_slots = select_layer_slots
    # the engine imported it by module reference, so patching SK is enough
    import charting.engine as E
    E.SK.layer_eligible = layer_eligible
    E.SK.select_layer_slots = select_layer_slots
    E.SK.MELODIC_METRIC_SCALE = SK.MELODIC_METRIC_SCALE


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="classic")
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "reel_check_out"))
    args = ap.parse_args()

    import pygame
    pygame.init()
    from charting import skeleton as SK
    from charting.engine import get_skeleton, chart_song
    from game.models import Level

    SK._ORIG_MMS = SK.MELODIC_METRIC_SCALE

    ref = json.load(open(DATA, encoding="utf-8"))["songs"]
    songs = []
    for name, info in ref.items():
        wav = os.path.join(args.out, name + ".wav")
        if not os.path.exists(wav):
            print(f"{name}: no audio in {args.out} — run reel_check.py first")
            continue
        theirs = np.array(sorted(h[0] for h in info["hits"]))
        dur = float(info["duration"])
        theirs = theirs[(theirs >= 0.5) & (theirs <= dur - 0.3)]
        songs.append((name, wav, theirs, dur, get_skeleton(wav)))

    names = args.only or list(CONFIGS)
    print(f"\n{'config':14s} {'nps':>5s} {'vocal':>6s} {'onbeat':>7s} {'peak':>6s} "
          f"{'theirs_cov':>11s} {'ours_on':>8s}")
    print(f"{'reference':14s} {2.48:5.2f} {0.47:6.2f} {0.21:7.2f} {0.48:6.2f} "
          f"{'—':>11s} {'—':>8s}")
    results = {}
    for cname in names:
        apply(CONFIGS[cname])
        agg = {"nps": [], "vocal": [], "onbeat": [], "peak": [], "cov": [], "on": []}
        for name, wav, theirs, dur, sk in songs:
            r = chart_song(Level(WORDS, wav, difficulty=args.tier), wav)
            ours = np.array(sorted(e.timestamp for e in r["events"] if not e.is_rest and e.char))
            ours = ours[(ours >= 0.5) & (ours <= dur - 0.3)]
            c = content(ours, r["skeleton"])
            agg["nps"].append(len(ours) / dur)
            agg["vocal"].append(c.get("vocal", 0.0))
            agg["onbeat"].append(c.get("onbeat", 0.0))
            agg["peak"].append(c.get("peak", 0.0))
            agg["cov"].append(near(theirs, ours, TOL))
            agg["on"].append(near(ours, theirs, TOL))
        m = {k: sum(v) / len(v) for k, v in agg.items()}
        results[cname] = m
        print(f"{cname:14s} {m['nps']:5.2f} {m['vocal']:6.2f} {m['onbeat']:7.2f} {m['peak']:6.2f} "
              f"{m['cov']:11.2f} {m['on']:8.2f}")

    json.dump(results, open(os.path.join(args.out, "tune.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
