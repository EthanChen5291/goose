"""
Where a frame of the real game goes.

    python3 tools/profile_play.py                       # a real window, the default song
    python3 tools/profile_play.py --song "ICARIUS.mp3" --tier demon --mode letters
    python3 tools/profile_play.py --headless            # renderer only, no compositor
    python3 tools/profile_play.py --seconds 20 --seek 60

Opens the game the way main.py does, runs a session with the music muted, and
times each part of the frame separately:

    draw        the renderer
    flip        pygame.display.flip()
    events      pygame.event.get() + the input loop
    judge       RhythmManager.update() and the key handling
    tick        what clock.tick(60) slept

`tick` is the headroom: a frame that used 9 ms of a 16.7 ms budget sleeps 7.7 ms.
When `tick` goes to zero the frame missed, and the other columns say which part
took it.  `--headless` uses the dummy video driver, so the difference between the
two runs is what the compositor costs.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))] * 1000.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default="Scorpion.mp3")
    ap.add_argument("--tier", default="classic")
    ap.add_argument("--mode", default="words")
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--seek", type=float, default=0.0, help="skip this far into the chart first")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--size", default="", help="WxH instead of the full screen")
    args = ap.parse_args()

    if args.headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    import pygame
    pygame.init()

    info = pygame.display.Info()
    if args.size:
        w, h = (int(v) for v in args.size.lower().split("x"))
    else:
        w, h = info.current_w, info.current_h
    screen = pygame.display.set_mode((w, h), pygame.RESIZABLE)
    pygame.display.set_caption("Noki · profile")
    for _ in range(3):
        pygame.event.pump()
        pygame.time.wait(30)
    screen = pygame.display.get_surface() or screen
    w, h = screen.get_size()

    from game.models import Level
    from game.play import PlaySession
    from game.menu_utils import _load_word_banks
    import main as app

    path = app.CANON_PATH + args.song
    if not os.path.exists(path):
        path = app.CUSTOM_PATH + args.song
    if not os.path.exists(path):
        sys.exit(f"no such song: {args.song}")
    banks = _load_word_banks()
    try:
        from game.menu import DEFAULT_WORD_BANK
    except Exception:
        DEFAULT_WORD_BANK = app.WORD_BANK_1
    words = banks.get(args.song, list(DEFAULT_WORD_BANK))

    clock = pygame.time.Clock()
    level = Level(words, path, difficulty=args.tier, mode=args.mode)
    sess = PlaySession(level, screen, clock)
    pygame.mixer.music.set_volume(0.0)
    if sess._hitsound is not None:
        sess._hitsound.set_volume(0.0)

    if args.seek > 0:
        # walk the judgment cursor forward so the profile covers a busy stretch
        sess.chart_clock.rebase(args.seek)
        while (sess.rhythm.char_event_idx < len(sess.rhythm.beat_map)
               and sess.rhythm.beat_map[sess.rhythm.char_event_idx].timestamp < args.seek):
            sess.rhythm.char_event_idx += 1

    draw_t: list[float] = []
    flip_t: list[float] = []
    ev_t: list[float] = []
    judge_t: list[float] = []
    frame_t: list[float] = []
    tick_t: list[float] = []

    renderer = sess.renderer
    t_end = time.perf_counter() + args.seconds
    frames = 0
    while time.perf_counter() < t_end:
        t_tick0 = time.perf_counter()
        dt = min(0.05, clock.tick(60) / 1000.0)
        t0 = time.perf_counter()
        tick_t.append(t0 - t_tick0)

        t = sess.chart_clock.now()
        if not sess._music_started and sess.chart_clock.raw() >= sess.lead_in:
            pygame.mixer.music.play()
            sess.chart_clock.rebase(sess.lead_in)
            sess._music_started = True
            t = sess.chart_clock.now()

        a = time.perf_counter()
        events = pygame.event.get()
        sess.input.update(events=events)
        b = time.perf_counter()
        ev_t.append(b - a)

        for e in sess.rhythm.update():
            renderer.on_miss(e, t)
        c = time.perf_counter()
        judge_t.append(c - b)

        renderer.draw(screen, t, dt)
        d = time.perf_counter()
        draw_t.append(d - c)

        pygame.display.flip()
        e2 = time.perf_counter()
        flip_t.append(e2 - d)
        frame_t.append(e2 - t0)
        frames += 1

        for ev in events:
            if ev.type == pygame.QUIT:
                t_end = 0

    pygame.mixer.music.stop()
    pygame.quit()

    rows = [
        ("draw", draw_t), ("flip", flip_t), ("events", ev_t),
        ("judge", judge_t), ("frame (no tick)", frame_t), ("tick slept", tick_t),
    ]
    mode = "headless" if args.headless else "windowed"
    print(f"\n{args.song} · {args.tier} · {args.mode} · {w}x{h} · {mode} · {frames} frames")
    print(f"{'':16s} {'mean':>8s} {'p50':>8s} {'p95':>8s} {'p99':>8s} {'max':>8s}")
    for name, xs in rows:
        if not xs:
            continue
        print(f"{name:16s} {statistics.mean(xs) * 1000:8.2f} {pct(xs, 0.50):8.2f} "
              f"{pct(xs, 0.95):8.2f} {pct(xs, 0.99):8.2f} {max(xs) * 1000:8.2f}")
    over = sum(1 for f in frame_t if f > 1 / 60)
    print(f"\nframes over 16.7 ms of work: {over}/{len(frame_t)} "
          f"({100 * over / max(1, len(frame_t)):.1f} %)")
    fps = frames / args.seconds
    print(f"effective fps: {fps:.1f}")


if __name__ == "__main__":
    main()
