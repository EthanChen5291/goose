"""
Compare our chart with a Keyboard Warrior reel.

    python3 tools/reel_compare.py <screen-recording.mp4> [out_dir] [--cut SECONDS]

Reads the reel's audio and video: the four slot circles on the hit line flash on every
hit, so per-slot brightness peaks are *their* note times (a good player is inside ±70 ms).
The audio is split at the biggest scene change (or --cut) into one file per song, each is
charted by our engine at every tier, and the two are compared:

  * notes per second, and per bar
  * what each set lands on (vocal / kick / snare from our skeleton, on-beat / off-beat)
  * the share of their notes with one of ours within 90 ms, and vice versa
  * a picture (out_dir/compare.png): their hits, ours, the onset envelope, the bars

The slot coordinates below are for a 1290x2796 iPhone recording of the reel with the
game in the top half; pass --slots x1,x2,x3,x4 --line y --r RADIUS for another layout.  An
Instagram export of a reel (720x1280, "igexport-*.mp4") is
    --slots 89,270,450,631 --line 682 --r 26
Needs ffmpeg on PATH (audio extraction) and opencv (video).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

SLOTS_X = [104, 464, 824, 1184]
LINE_Y = 1276
R = 46
WORDS = ["cat", "moon", "over", "kitten", "someone", "store", "submit", "jungle"]


def arg(name: str, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def their_hits(video: str, slots_x, line_y, cache: str):
    import cv2
    if os.path.exists(cache):
        d = np.load(cache)
        return d["bright"], d["cut"], d["times"]
    c = cv2.VideoCapture(video)
    fps = c.get(cv2.CAP_PROP_FPS)
    bright, cut, times = [], [], []
    prev = None
    i = 0
    while True:
        ok, fr = c.read()
        if not ok:
            break
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        bright.append([float(g[line_y - R:line_y + R, x - R:x + R].mean()) for x in slots_x])
        small = cv2.resize(g[300:1700], (64, 70)).astype(np.float32)
        cut.append(0.0 if prev is None else float(np.abs(small - prev).mean()))
        prev = small
        times.append(i / fps)
        i += 1
    np.savez(cache, bright=np.array(bright), cut=np.array(cut), times=np.array(times))
    return np.array(bright), np.array(cut), np.array(times)


def peaks(bright, times):
    hits = []
    for k in range(bright.shape[1]):
        x = bright[:, k]
        base = np.array([np.median(x[max(0, j - 15):j + 16]) for j in range(len(x))])
        hp = x - base
        thr = max(6.0, 0.35 * float(np.percentile(hp, 99.5)))
        last = -1.0
        for j in range(1, len(hp) - 1):
            if hp[j] >= thr and hp[j] >= hp[j - 1] and hp[j] >= hp[j + 1] and times[j] - last > 0.12:
                hits.append((float(times[j]), k))
                last = float(times[j])
    return sorted(hits)


def near(a, b, tol=0.09):
    if len(a) == 0 or len(b) == 0:
        return 0.0
    j = np.clip(np.searchsorted(b, a), 1, len(b) - 1)
    return float((np.minimum(np.abs(a - b[j - 1]), np.abs(a - b[j])) <= tol).mean())


def main() -> None:
    video = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "reel_compare_out"
    os.makedirs(out, exist_ok=True)
    global R
    slots_x = [int(v) for v in arg("--slots", ",".join(map(str, SLOTS_X))).split(",")]
    line_y = int(arg("--line", LINE_Y))
    R = int(arg("--r", R))
    wav = os.path.join(out, "reel.wav")
    if not os.path.exists(wav):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "22050", wav], check=True)
    bright, cut, times = their_hits(video, slots_x, line_y, os.path.join(out, "signals.npz"))
    hits = peaks(bright, times)
    t_cut = float(arg("--cut", 0) or 0)
    if not t_cut:
        win = (times > 20) & (times < times[-1] - 10)
        j = int(np.argmax(np.where(win, cut, 0)))
        t_cut = float(times[j]) if cut[j] > 40 else 0.0
    print(f"their hits: {len(hits)}; scene cut at {t_cut:.2f}s" if t_cut else f"their hits: {len(hits)}; one song")

    import soundfile as sf
    import pygame
    pygame.init()
    from game.models import Level
    from charting.engine import chart_song
    y, sr = sf.read(wav)
    y = y.astype(np.float32)
    segs = {"song1": (0.0, t_cut), "song2": (t_cut, len(y) / sr)} if t_cut else {"song": (0.0, len(y) / sr)}
    report = {}
    for name, (a, b) in segs.items():
        path = os.path.join(out, f"{name}.wav")
        sf.write(path, y[int(a * sr):int(b * sr)], sr)
        theirs = np.array([h[0] - a for h in hits if a + 0.5 <= h[0] < b - 0.3])
        for diff in ("journey", "classic", "master", "demon"):
            r = chart_song(Level(WORDS, path, difficulty=diff), path)
            ours = np.array(sorted(e.timestamp for e in r["events"] if not e.is_rest))
            sk = r["skeleton"]
            pt_t = np.array([p.t for p in sk.points])

            def lands(ts):
                c = {"vocal": 0, "kick": 0, "snare": 0, "other": 0, "onbeat": 0}
                for t in ts:
                    j = int(np.clip(np.searchsorted(pt_t, t), 1, len(pt_t) - 1))
                    p = sk.points[j - 1 if abs(pt_t[j - 1] - t) < abs(pt_t[j] - t) else j]
                    c[p.attack if p.attack in ("vocal", "kick", "snare") else "other"] += 1
                    c["onbeat"] += p.sub == 0
                n = max(1, len(ts))
                return {k: round(v / n, 2) for k, v in c.items()}

            rep = {"theirs_per_s": round(len(theirs) / (b - a), 2), "ours_per_s": round(len(ours) / (b - a), 2),
                   "theirs_matched": round(near(theirs, ours), 2), "ours_matched": round(near(ours, theirs), 2),
                   "bpm": round(sk.bpm, 1), "theirs_on": lands(theirs), "ours_on": lands(ours)}
            report[f"{name}/{diff}"] = rep
            print(f"{name}/{diff}: {json.dumps(rep)}")
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)

    # the picture: first song, 16 s from 8 s in
    try:
        import librosa
        from PIL import Image, ImageDraw
        name, (a, b) = next(iter(segs.items()))
        path = os.path.join(out, f"{name}.wav")
        seg, _ = sf.read(path)
        seg = seg.astype(np.float32)
        r = chart_song(Level(WORDS, path, difficulty="master"), path)
        ours = [e.timestamp for e in r["events"] if not e.is_rest]
        theirs = [h[0] - a for h in hits if a <= h[0] < b]
        W, H = 1600, 420
        im = Image.new("RGB", (W, H), (12, 12, 18))
        d = ImageDraw.Draw(im)
        t0, t1 = 8.0, min(24.0, b - a)
        X = lambda t: int((t - t0) / (t1 - t0) * W)
        env = librosa.onset.onset_strength(y=seg, sr=sr)
        et = librosa.frames_to_time(np.arange(len(env)), sr=sr)
        env = env / max(1e-6, env.max())
        for i in range(1, len(et)):
            if t0 <= et[i] <= t1:
                d.line([(X(et[i - 1]), 400 - int(160 * env[i - 1])), (X(et[i]), 400 - int(160 * env[i]))], fill=(110, 110, 130))
        for bt in r["skeleton"].bar_start:
            if t0 <= bt <= t1:
                d.line([(X(bt), 40), (X(bt), 400)], fill=(40, 40, 60))
        for t in theirs:
            if t0 <= t <= t1:
                d.line([(X(t), 60), (X(t), 140)], fill=(240, 170, 60), width=3)
        for t in ours:
            if t0 <= t <= t1:
                d.line([(X(t), 160), (X(t), 240)], fill=(100, 190, 255), width=3)
        d.text((10, 42), "Keyboard Warrior hits (from the reel)", fill=(240, 170, 60))
        d.text((10, 142), "ours, Hard", fill=(100, 190, 255))
        im.save(os.path.join(out, "compare.png"))
        print("wrote", os.path.join(out, "compare.png"))
    except Exception as exc:  # noqa: BLE001
        print("no picture:", exc)


if __name__ == "__main__":
    main()
