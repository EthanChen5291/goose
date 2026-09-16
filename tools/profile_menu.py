"""
Where a frame of the menus goes.

    python3 tools/profile_menu.py --state title --seconds 10
    python3 tools/profile_menu.py --state level_select --seconds 10

The menu loop is one function, so instead of picking it apart this wraps the two
calls every frame passes through.  `pygame.display.flip` is patched directly;
`Clock` is a C type that cannot be patched or subclassed, so the loop is handed a
delegating wrapper instead (it only ever calls `.tick`).

    slept   what clock.tick(60) gave back — headroom
    work    everything else the loop did before the flip
    flip    the flip itself
    period  flip to flip: the real frame time, and the only number that is fps

A QUIT event is posted after `--seconds`, so the loop exits the way closing the
window would.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))] * 1000.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="title", choices=["title", "level_select", "canon"])
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--warmup", type=float, default=1.5,
                    help="discard this many seconds; window creation stalls the first flip")
    args = ap.parse_args()

    if args.headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"

    import pygame
    pygame.init()

    info = pygame.display.Info()
    screen = pygame.display.set_mode((info.current_w, info.current_h), pygame.RESIZABLE)
    pygame.display.set_caption("Noki · menu profile")
    for _ in range(3):
        pygame.event.pump()
        pygame.time.wait(30)
    screen = pygame.display.get_surface() or screen
    win_w, win_h = screen.get_size()

    from game.menu import MenuManager
    from game.music import MusicManager
    import main as app

    work: list[float] = []
    flip: list[float] = []
    slept: list[float] = []
    period: list[float] = []

    last_flip_end = [time.perf_counter()]
    tick_end = [time.perf_counter()]

    class TimedClock:
        """Delegates to a real Clock, recording what tick() slept."""

        def __init__(self) -> None:
            self._c = pygame.time.Clock()

        def tick(self, framerate: int = 0) -> int:
            t0 = time.perf_counter()
            r = self._c.tick(framerate)
            tick_end[0] = time.perf_counter()
            slept.append(tick_end[0] - t0)
            return r

        def __getattr__(self, name):
            return getattr(self._c, name)

    real_flip = pygame.display.flip

    def timed_flip(*a, **k):
        t0 = time.perf_counter()
        # everything since tick returned is the frame's real work
        work.append(max(0.0, t0 - tick_end[0]))
        real_flip(*a, **k)
        t1 = time.perf_counter()
        flip.append(t1 - t0)
        if len(flip) > 1:
            period.append(t1 - last_flip_end[0])
        last_flip_end[0] = t1

    pygame.display.flip = timed_flip

    def stopper():
        time.sleep(args.seconds)
        pygame.event.post(pygame.event.Event(pygame.QUIT))

    clock = TimedClock()
    music = MusicManager()
    menu = MenuManager(screen, clock, app.SONG_NAMES, start_state=args.state, music=music)
    # Skip the launch sequence so the profile is of the screen in its steady
    # state.  Both of these matter: the "..." splash holds for two seconds, and
    # `title_ready` stays False until the intro video finishes — leave it False
    # and the inline cv2 intro decodes on every frame, which is a launch cost,
    # not what the screen normally does.
    menu._show_waiting = False
    menu._waiting_elapsed = 9.0
    menu._video_done = True
    if menu._video_cap is not None:
        menu._video_cap.release()
        menu._video_cap = None
    music._video_done = True

    threading.Thread(target=stopper, daemon=True).start()
    try:
        menu.run()
    except SystemExit:
        pass

    pygame.display.flip = real_flip
    pygame.quit()

    # the first flip after the window appears can stall for a second; that is a
    # launch cost, not the frame time, so the warmup is dropped from the sample
    drop = 0
    if flip:
        drop = min(len(flip) - 1, max(0, int(args.warmup * 60)))
    work, flip, slept = work[drop:], flip[drop:], slept[drop:]
    period = period[max(0, drop - 1):]

    total = [w + f for w, f in zip(work, flip)]
    mode = "headless" if args.headless else "windowed"
    print(f"\nmenu · {args.state} · {win_w}x{win_h} · {mode} · {len(flip)} frames")
    print(f"{'':16s} {'mean':>8s} {'p50':>8s} {'p95':>8s} {'p99':>8s} {'max':>8s}")
    for name, xs in (("work", work), ("flip", flip), ("work+flip", total),
                     ("tick slept", slept), ("frame period", period)):
        if not xs:
            continue
        print(f"{name:16s} {statistics.mean(xs) * 1000:8.2f} {pct(xs, 0.50):8.2f} "
              f"{pct(xs, 0.95):8.2f} {pct(xs, 0.99):8.2f} {max(xs) * 1000:8.2f}")
    if flip:
        fps = 1.0 / (statistics.mean(period)) if period else 0.0
        over = sum(1 for x in total if x > 1 / 60)
        print(f"\nframes over 16.7 ms of work: {over}/{len(total)} "
              f"({100 * over / max(1, len(total)):.1f} %)")
        print(f"effective fps: {fps:.1f}")


if __name__ == "__main__":
    main()
