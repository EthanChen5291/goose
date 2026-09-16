"""
Does our beat grid actually lock onto the song?

    python3 tools/grid_check.py                     # every reel song
    python3 tools/grid_check.py --song local_forecast

`tools/reel_check.py` compares our notes with Keyboard Warrior's, but their hit
times come from a 30 fps video, so a disagreement there could be their error as
easily as ours.  This asks a question the reels cannot confound: **do the song's
own onsets fall on the grid we derived from it?**

For every onset (weighted by its strength) we measure the distance to the nearest
sixteenth of our grid.  Raw coverage is not comparable between songs — a faster
grid is a denser grid and catches more by luck — so everything is reported as
*lift* over the coverage a grid of the same spacing would get on random times:

    lift 1.0   the grid explains nothing the spacing alone doesn't
    lift 2.0   onsets are twice as concentrated on our lines as chance
    lift 3.0+  a locked grid

Three grids are scored, so a failure says which part is wrong:

    tracked    our beat_times as they are, sixteenths interpolated between beats
    constant   our bpm from our first beat, held rigid — tracked beating this one
               means librosa is bending the grid to follow a drifting take
    best       a search over tempo and phase.  If this beats `tracked` by much,
               our grid is on the wrong tempo or the wrong phase, and `bpm_ratio`
               says which: 2.0 or 0.5 is an octave slip, ~1.0 with a bad `tracked`
               is a phase error.

`drift_ms` is the grid's phase measured in 5 s windows.  A number that walks one
way across the song is a tempo that is slightly wrong; noise around zero is a
grid that is locked and a song that is played by humans.
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
# A hit counts as "on" a line inside this fraction of the grid spacing.  It has to
# be relative: with a tolerance fixed in milliseconds a slower grid is a wider net,
# so a search would always prefer half tempo no matter what the song does.
ALPHA = 0.12
CHANCE = 2 * ALPHA   # what a grid of any spacing catches on random times
PHASE_BINS = 2000    # resolution of the phase search, over one sixteenth
# 5.8 ms frames.  librosa's default hop is 512 — 23.2 ms — which is the same size
# as the errors being measured, so at the default every number below is the hop.
HOP = 128
# beat subdivisions to try: eighths, triplets, sixteenths, sextuplets
DIVS = (2, 3, 4, 6)
from charting.skeleton import _PULSE_CANDS as PULSE_CANDS, _PULSE_MARGIN as PULSE_MARGIN  # noqa: E402


def onsets_of(wav: str) -> tuple[np.ndarray, np.ndarray]:
    """Onset times and their strengths, at a resolution finer than what we measure."""
    import librosa
    y, sr = librosa.load(wav, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=HOP, backtrack=False)
    t = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
    w = env[frames]
    w = w / (w.max() or 1.0)
    return t, w


def lift_of(dist: np.ndarray, w: np.ndarray, spacing: float) -> float:
    """How much better than chance a grid of this spacing explains these onsets."""
    cov = float((w * (dist <= ALPHA * spacing)).sum() / (w.sum() or 1.0))
    return cov / CHANCE


def dist_to_grid(t: np.ndarray, lines: np.ndarray) -> np.ndarray:
    """Distance from each time to the nearest line of a sorted grid."""
    j = np.clip(np.searchsorted(lines, t), 1, len(lines) - 1)
    return np.minimum(np.abs(t - lines[j - 1]), np.abs(t - lines[j]))


def best_shift(t: np.ndarray, w: np.ndarray, lines: np.ndarray, spacing: float,
               n: int = 400) -> tuple[float, float]:
    """Best lift of a fixed grid once a constant offset is allowed, and that offset.

    An onset detector reports the peak of a spectral-flux envelope, which lags the
    transient by a fraction of its analysis window.  That lag is the same for every
    onset, so it moves a fixed grid's score without saying anything about the grid.
    The searched grids get their phase for free; this gives ours the same.
    """
    offs = np.linspace(-spacing / 2, spacing / 2, n)
    best = (0.0, 0.0)
    for o in offs:
        L = lift_of(dist_to_grid(t + o, lines), w, spacing)
        if L > best[0]:
            best = (L, float(o))
    return best


def subdivide(beats: np.ndarray, n: int = 4) -> np.ndarray:
    """Every sixteenth: the beats themselves plus n-1 points between each pair."""
    out = [beats]
    for k in range(1, n):
        out.append(beats[:-1] + (beats[1:] - beats[:-1]) * (k / n))
    return np.sort(np.concatenate(out))


def signed_dist(t: np.ndarray, lines: np.ndarray) -> np.ndarray:
    """Signed offset from each time to the nearest line of a sorted grid."""
    j = np.clip(np.searchsorted(lines, t), 1, len(lines) - 1)
    lo, hi = lines[j - 1], lines[j]
    return np.where(np.abs(t - lo) < np.abs(t - hi), t - lo, t - hi)


def signed_phase(t: np.ndarray, spacing: float, origin: float) -> np.ndarray:
    """Signed offset of each time from its nearest line, in (-spacing/2, spacing/2]."""
    r = np.mod(t - origin, spacing)
    return np.where(r > spacing / 2, r - spacing, r)


def best_grid(t: np.ndarray, w: np.ndarray, lo: float, hi: float,
              step: float = 0.05) -> tuple[float, float, float]:
    """Search constant-tempo grids for the best lift.  Returns (bpm, phase, lift).

    For one tempo the best phase is found in one pass: fold every onset into one
    sixteenth, histogram it, and convolve with a box the width of the tolerance —
    the peak of that is the phase, and its height the coverage.
    """
    half = max(1, int(round(ALPHA * PHASE_BINS)))
    box = np.ones(2 * half + 1)
    tot = w.sum() or 1.0
    best = (0.0, 0.0, 0.0)
    for bpm in np.arange(lo, hi, step):
        s = 60.0 / bpm / 4.0
        hist, edges = np.histogram(np.mod(t, s), bins=PHASE_BINS, range=(0.0, s), weights=w)
        # circular: a line at phase 0 also catches onsets just under the spacing
        cov = np.convolve(np.tile(hist, 3), box, mode="same")[PHASE_BINS:2 * PHASE_BINS] / tot
        i = int(np.argmax(cov))
        L = float(cov[i]) / CHANCE
        if L > best[2]:
            best = (float(bpm), float(edges[i]), L)
    return best


def null_lift(n: int, t0: float, t1: float, bpm: float, lines: np.ndarray, rng,
              reps: int = 5) -> tuple[float, float, float]:
    """What the two searches score on `n` random times over the same span.

    The searches try thousands of tempos against a few hundred onsets on a clip of
    half a minute.  Some of what they find is the search finding itself, and this
    says how much: a real lock has to clear this, not 1.0.  Our own grid gets the
    same treatment — one free offset is much less freedom than a tempo sweep, so
    its floor is lower, but it is not 1.0 either.
    """
    sh_, re_, oc_ = [], [], []
    for _ in range(reps):
        t = np.sort(rng.uniform(t0, t1, n))
        w = np.ones(n)
        sh_.append(best_shift(t, w, lines, float(np.median(np.diff(lines))))[0])
        re_.append(best_grid(t, w, bpm * 0.80, bpm * 1.25)[2])
        oc_.append(best_grid(t, w, max(50.0, bpm * 0.45), min(230.0, bpm * 2.2))[2])
    return float(np.mean(sh_)), float(np.mean(re_)), float(np.mean(oc_))


# ── is our *pulse* the song's pulse? ─────────────────────────────────────────
# Our /3 lines and the /4 lines of a tempo 4/3 slower fall at the same times, so no
# amount of looking at onset positions can tell those two apart.  The onset
# envelope's autocorrelation can: it peaks at the period the song repeats on.  The
# scoring lives in `charting.skeleton`, because the pipeline now uses it to repair
# its own grid — this tool has to be measuring the same thing the engine decides on.
ACF_HOP = 256


def pulse_check(path: str, bpm: float) -> tuple[str, dict[str, float]]:
    """Which candidate beat period the song actually repeats on."""
    import librosa
    from charting.skeleton import best_pulse
    y, sr = librosa.load(path, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=ACF_HOP)
    return best_pulse(env, 60.0 / bpm * sr / ACF_HOP)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default=None)
    ap.add_argument("--out", default=os.path.join(HERE, "reel_check_out"))
    ap.add_argument("--window", type=float, default=5.0, help="drift window, seconds")
    ap.add_argument("--null", action="store_true", help="also score random onsets, as a control")
    ap.add_argument("--canon", default=None, metavar="DIR",
                    help="scan a song folder for bad grids instead of the reels")
    args = ap.parse_args()

    import pygame
    pygame.init()
    from charting.engine import get_skeleton

    if args.canon:
        return scan(args.canon)

    ref = json.load(open(DATA, encoding="utf-8"))["songs"]
    rows = []
    print(f"\n{'song':17s} {'bpm':>6s} {'dev':>5s} | {'tracked':>7s} {'rigid':>6s} "
          f"{'shift':>6s} {'retune':>6s} {'octave':>6s} {'ratio':>5s} | {'drift/10s':>9s} {'jitter':>7s}")
    for name in ref:
        if args.song and name != args.song:
            continue
        wav = os.path.join(args.out, name + ".wav")
        if not os.path.exists(wav):
            print(f"{name}: no audio in {args.out} — run reel_check.py first")
            continue

        sk = get_skeleton(wav)
        beats = np.array(sk.beat_times, dtype=float)
        if len(beats) < 8:
            print(f"{name}: only {len(beats)} beats, skipping")
            continue
        t, w = onsets_of(wav)
        keep = (t >= beats[0]) & (t <= beats[-1])
        t, w = t[keep], w[keep]
        if len(t) < 20:
            print(f"{name}: only {len(t)} onsets, skipping")
            continue

        s16 = 60.0 / sk.bpm / 4.0

        # 1. our grid as tracked — sixteenths interpolated between the real beats
        tracked = subdivide(beats, 4)
        sp_tr = float(np.median(np.diff(tracked)))
        lift_tr = lift_of(dist_to_grid(t, tracked), w, sp_tr)
        lift_sh, off_sh = best_shift(t, w, tracked, sp_tr)
        div = {}
        for d in DIVS:
            g = subdivide(beats, d)
            div[str(d)] = round(best_shift(t, w, g, float(np.median(np.diff(g))))[0], 2)
        best_div = max(DIVS, key=lambda d: div[str(d)])

        # 2. our tempo held rigid from our first beat.  Worse than `tracked` means
        #    the tracker is bending the grid beat by beat to stay with the song.
        ph = signed_phase(t, s16, beats[0])
        lift_rg = lift_of(np.abs(ph), w, s16)

        # 3. the best rigid grid near our tempo (a retune, not a different reading
        #    of the song) and the best anywhere from half to double it (an octave).
        r_bpm, _, lift_re = best_grid(t, w, sk.bpm * 0.80, sk.bpm * 1.25)
        o_bpm, _, lift_oc = best_grid(t, w, max(50.0, sk.bpm * 0.45), min(230.0, sk.bpm * 2.2))

        dev = float(np.median(np.abs(ph))) * 1000.0

        # 4. phase of the grid the skeleton actually uses — the tracked beats, not our
        #    quoted bpm — per window, then a line through it.  The slope is a tempo
        #    that is wrong, the scatter about it a grid that is loose.
        xs, ys = [], []
        for w0 in np.arange(beats[0], beats[-1] - args.window, args.window):
            m = (t >= w0) & (t < w0 + args.window)
            if m.sum() < 4:
                continue
            a = signed_dist(t[m], tracked) / sp_tr * 2 * np.pi
            # circular mean, so ±half a sixteenth doesn't average to zero
            xs.append(w0 + args.window / 2)
            ys.append(float(np.angle(np.mean(np.exp(1j * a))) / (2 * np.pi) * sp_tr * 1000.0))
        if len(xs) >= 3:
            # unwrap first: a phase walking past half a sixteenth reappears on the
            # other side, and an un-unwrapped fit would read that as no drift at all
            yu = np.unwrap(np.array(ys) / (sp_tr * 1000.0) * 2 * np.pi) / (2 * np.pi) * sp_tr * 1000.0
            slope, icept = np.polyfit(np.array(xs), yu, 1)
            drift = float(slope) * 10.0
            jitter = float(np.std(yu - (slope * np.array(xs) + icept)))
        else:
            drift, jitter = 0.0, 0.0

        rows.append({"song": name, "bpm": round(sk.bpm, 1), "dev_ms": round(dev, 1),
                     "lift_tracked": round(lift_tr, 2), "lift_rigid": round(lift_rg, 2),
                     "lift_shifted": round(lift_sh, 2), "shift_ms": round(off_sh * 1000, 1),
                     "lift_retune": round(lift_re, 2), "lift_octave": round(lift_oc, 2),
                     "retune_bpm": round(r_bpm, 1), "octave_bpm": round(o_bpm, 1),
                     "octave_ratio": round(o_bpm / sk.bpm, 3), "n_onsets": int(len(t)),
                     "drift_ms_per_10s": round(drift, 1), "jitter_ms": round(jitter, 1),
                     "div": div, "best_div": best_div})
        print(f"{name:17s} {sk.bpm:6.1f} {dev:4.0f}m | {lift_tr:7.2f} {lift_rg:6.2f} "
              f"{lift_sh:6.2f} {lift_re:6.2f} {lift_oc:6.2f} {o_bpm / sk.bpm:5.2f} | "
              f"{drift:8.1f}m {jitter:6.1f}m")
        if args.null:
            nsh, nre, noc = null_lift(len(t), float(beats[0]), float(beats[-1]), sk.bpm,
                                      tracked, np.random.default_rng(7))
            rows[-1].update(null_shift=round(nsh, 2), null_retune=round(nre, 2),
                            null_octave=round(noc, 2))
            print(f"{'  · random onsets':17s} {'':6s} {'':5s} | {'':7s} {'':6s} "
                  f"{nsh:6.2f} {nre:6.2f} {noc:6.2f}")

    if rows:
        def avg(k):
            return sum(r[k] for r in rows) / len(rows)
        print(f"\n{'mean':17s} {avg('bpm'):6.1f} {avg('dev_ms'):4.0f}m | {avg('lift_tracked'):7.2f} "
              f"{avg('lift_rigid'):6.2f} {avg('lift_shifted'):6.2f} {avg('lift_retune'):6.2f} "
              f"{avg('lift_octave'):6.2f}{'':7s}| {avg('drift_ms_per_10s'):8.1f}m {avg('jitter_ms'):6.1f}m")
        if args.null:
            print(f"{'mean · random':17s} {'':6s} {'':5s} | {'':7s} {'':6s} "
                  f"{avg('null_shift'):6.2f} {avg('null_retune'):6.2f} {avg('null_octave'):6.2f}")
        print("\nlift 1.0 = the grid explains nothing its spacing doesn't; 2+ = locked")
        # every column has to be read against its own null: the tempo sweeps have
        # thousands of parameters to find a pattern with and our grid has one, so
        # raw lifts are not comparable between columns — lift over null is.
        def over(r, k, n):
            return r[k] / (r.get(n, 1.0) or 1.0)
        loose = [r["song"] for r in rows if over(r, "lift_shifted", "null_shift") < 1.15]
        retune = [r["song"] for r in rows
                  if over(r, "lift_retune", "null_retune") > over(r, "lift_shifted", "null_shift") * 1.2]
        octave = [r["song"] for r in rows if abs(r["octave_ratio"] - 1.0) > 0.1
                  and over(r, "lift_octave", "null_octave") > over(r, "lift_shifted", "null_shift") * 1.2]
        print("`shift` is our own grid with one constant offset allowed — the fair comparison,")
        print("because an onset detector lags the transient and the searched grids get")
        print("their phase for free.  Compare every column with its random-onset row.")
        print(f"loose grids (no better than random onsets): {', '.join(loose) or 'none'}")
        print(f"a retune would fit better:      {', '.join(retune) or 'none'}")
        print(f"a different octave fits better: {', '.join(octave) or 'none'}")
        # ── is the grid the right *shape*? ───────────────────────────────────
        # The skeleton divides every beat into four, so a note can only fall on a
        # sixteenth.  A song that swings, or counts in three, has its notes on
        # triplets, and no sixteenth is within reach of them.  Same beats, same
        # fairness, different subdivision.
        print(f"\n{'song':17s} " + " ".join(f"{'/' + str(d):>6s}" for d in DIVS) + "   best")
        for r in rows:
            cells = " ".join(f"{r['div'][str(d)]:6.2f}" for d in DIVS)
            mark = "  <-- not /4" if r["best_div"] != 4 else ""
            print(f"{r['song']:17s} {cells}   /{r['best_div']}{mark}")
        print("a beat split into 3 or 6 beating /4 means the song swings or counts in three")

        json.dump(rows, open(os.path.join(args.out, "grid.json"), "w"), indent=1)


def scan(folder: str) -> None:
    """Every song in a folder: does its grid fit, and if not, why not?

    Two different faults land a song here, and they need different repairs:

      tempo    the tracker locked onto a pulse 4/3 or 2/3 of the real one.
               `_beat_grid` only ever folds a tempo by 2, so a non-octave slip is
               never repaired, and every bar line is in the wrong place.
      feel     the tempo is right and the song divides its beat in three.  The
               skeleton builds `for sub in range(4)`, so two notes of every three
               have no line to land on and no point within the +-35 ms that
               `_sample_env` looks at either.
    """
    from charting.engine import get_skeleton
    exts = (".mp3", ".wav", ".ogg", ".m4a")
    print(f"\n{'song':28s} {'bpm':>6s} " + " ".join(f"{'/' + str(d):>6s}" for d in DIVS)
          + "  " + " ".join(f"{k:>6s}" for k in PULSE_CANDS) + "  verdict")
    bad = {"tempo": [], "feel": []}
    n = 0
    for fn in sorted(os.listdir(folder)):
        if not fn.lower().endswith(exts):
            continue
        path = os.path.join(folder, fn)
        try:
            sk = get_skeleton(path)
            beats = np.array(sk.beat_times, dtype=float)
            t, w = onsets_of(path)
            m = (t >= beats[0]) & (t <= beats[-1])
            t, w = t[m], w[m]
            div = {}
            for d in DIVS:
                g = subdivide(beats, d)
                div[d] = best_shift(t, w, g, float(np.median(np.diff(g))))[0]
        except Exception as e:
            print(f"{fn[:28]:28s}  failed: {type(e).__name__}: {e}")
            continue
        n += 1
        # a beat split in three fitting where four does not is the symptom; the
        # autocorrelation says which of the two faults caused it
        three = max(div[3], div[6]) > div[4] * 1.15
        verdict, sc = ("ours", {}) if not three else pulse_check(path, sk.bpm)
        if sc and sc[verdict] < sc["ours"] * PULSE_MARGIN:
            verdict = "ours"   # same margin the engine repairs on
        kind = "" if not three else ("tempo" if verdict != "ours" else "feel")
        if kind:
            bad[kind].append(fn)
        note = {"": "", "tempo": f"tempo — real pulse is {verdict}, {sk.bpm / PULSE_CANDS[verdict]:.0f} bpm",
                "feel": "feel — beat divides in three"}[kind]
        print(f"{fn[:28]:28s} {sk.bpm:6.1f} " + " ".join(f"{div[d]:6.2f}" for d in DIVS)
              + "  " + " ".join(f"{sc.get(k, 0.0):6.2f}" for k in PULSE_CANDS) + f"  {note}")
    tot = len(bad["tempo"]) + len(bad["feel"])
    print(f"\n{tot} of {n} songs have a grid that does not fit the music")
    print(f"  wrong tempo ({len(bad['tempo'])}): {', '.join(bad['tempo']) or '—'}")
    print(f"  triplet feel ({len(bad['feel'])}): {', '.join(bad['feel']) or '—'}")


if __name__ == "__main__":
    main()
