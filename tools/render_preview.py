"""
Headless Highway preview: chart a song (cached), simulate a player, render frames to PNG.

    SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy python3 tools/render_preview.py <song> <difficulty> <out_dir> [t1,t2,...]

A synthetic player hits every note with a random offset (mostly PERFECT/GREAT,
a few slips and misses) so bursts, stamps, the word block and the HUD all show.
"""
from __future__ import annotations
import os, random, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
import pygame
pygame.init()

from game.models import Level
from game.layout import Layout
from game.rhythm import RhythmManager
from game.highway import HighwayRenderer
from charting import build_chart
import json


def main():
    song, diff, out = sys.argv[1], sys.argv[2], sys.argv[3]
    times = [float(x) for x in sys.argv[4].split(",")] if len(sys.argv) > 4 else [8.0, 20.0, 45.0]
    mode = sys.argv[5] if len(sys.argv) > 5 else "words"
    os.makedirs(out, exist_ok=True)
    words = json.load(open("assets/song_words.json")).get(os.path.basename(song),
             ["dream", "shadow", "echo", "spark", "surge", "drift", "pulse", "blaze", "veil", "flame", "tide", "glow"])
    level = Level(words, song, difficulty=diff, mode=mode)
    r = build_chart(level, song)
    print("chart", r["meta"], "cached" if r.get("from_cache") else "built")
    W, H = 1440, 900
    screen = pygame.display.set_mode((W, H))
    now = [0.0]
    rm = RhythmManager(r["events"], r["song"].bpm, lead_in=r["lead_in"], timing_scale=1.0, clock=lambda: now[0])
    layout = Layout(W, H)
    if mode == "letters":
        from game.letters_renderer import LettersRenderer
        hw = LettersRenderer(layout, r["song"], rm, diff, {}, title=os.path.basename(song))
    else:
        hw = HighwayRenderer(layout, r["song"], rm, diff, {}, title=os.path.basename(song))
    hw.set_duets(r["meta"].get("duets", []))
    if hasattr(hw, "set_sections"):
        hw.set_sections(r["meta"])
    rng = random.Random(3)
    frame_dt = 1 / 60
    t = 0.0
    next_shot = 0
    shots = sorted(times)
    t_end = shots[-1] + 0.1
    while t < t_end and not rm.is_finished():
        now[0] = t
        for ev in rm.update():
            hw.on_miss(ev, t)
        for ar in getattr(rm, "anchor_results", []):
            if ar.get("event") is not None and hasattr(hw, "on_anchor_complete"):
                hw.on_anchor_complete(ar["event"], ar["judgment"].replace("hold_", ""), t)
        rm.anchor_results = []
        ev = rm.current_event()
        if ev is not None and not ev.is_rest and ev.char and not ev.hit and rm._active_hold is None:
            off = rng.gauss(0.0, 0.03)
            if t >= ev.timestamp + off:
                roll = rng.random()
                if roll < 0.06:
                    res = rm.check_input("x" if ev.char != "x" else "q")
                    hw.on_slip(ev, res["pressed"], t)
                elif roll < 0.12:
                    pass   # let it miss
                else:
                    res = rm.check_input(ev.char)
                    if res["hit"]:
                        if res["judgment"] == "hold_started":
                            hw.on_hold_start(ev, rm._hold_judgment, res["offset"] * 1000, t)
                        elif res["judgment"] == "anchor_started":
                            hw.on_anchor_start(ev, rm._anchor_judgment, res["offset"] * 1000, t)
                        else:
                            hw.on_hit(ev, res["judgment"], res["offset"] * 1000, t)
                            if res["is_word_complete"]:
                                hw.on_word_complete(ev.word_text, ev.word_id not in rm._dirty_words, t)
        if rm._active_hold is not None and t >= rm._active_hold.timestamp + rm._active_hold.hold_duration - 0.05:
            hr = rm.on_key_release(rm._active_hold.char)
            if hr and hr.get("hit") and hr.get("event") is not None:
                hw.on_hold_complete(hr["event"], hr["judgment"].replace("hold_", ""), t)
        if next_shot < len(shots) and t >= shots[next_shot] - 0.4 and hw.rush_charge >= 0.5 and not hw.rush_active(t) and next_shot == len(shots) - 1:
            hw.try_rush(t)
        hw.draw(screen, t, frame_dt)
        if next_shot < len(shots) and t >= shots[next_shot]:
            path = os.path.join(out, f"frame_{shots[next_shot]:05.1f}.png")
            pygame.image.save(screen, path)
            print("saved", path, rm.get_stats())
            next_shot += 1
        t += frame_dt
    print("done", rm.get_stats())


if __name__ == "__main__":
    main()
