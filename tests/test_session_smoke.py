"""End-to-end: a PlaySession on the tutorial song with a fake clock and injected keys, then results."""
import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
import pygame
import pytest

SONG = os.path.join("assets", "audios", "canon", "noki_tutorial_file.wav")


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self._paused = False
    def now(self):
        return self.t
    def pause(self):
        self._paused = True
    def resume(self):
        self._paused = False
    def check_drift(self, *_a, **_k):
        pass
    def start(self):
        pass
    def raw(self):
        return self.t
    def rebase(self, *_a):
        pass


@pytest.mark.skipif(not os.path.exists(SONG), reason="tutorial song missing")
@pytest.mark.parametrize("mode", ["words", "letters"])
def test_session_plays_and_finishes(mode):
    pygame.init()
    screen = pygame.display.set_mode((960, 540))
    from game.models import Level
    from game.play import PlaySession
    level = Level(["dream", "shadow", "echo", "spark", "glow"], SONG, difficulty="classic", mode=mode)
    s = PlaySession(level, screen, pygame.time.Clock(), music=None)
    fake = FakeClock()
    s.chart_clock = fake
    s.rhythm._clock = fake.now
    dt = 1 / 60
    t = 0.0
    hits = 0
    end = min(30.0, s.rhythm.beat_map[-1].timestamp + 0.5)
    s.running = True
    while t < end and s.running and not s._finish_needed:
        fake.t = t
        ev = s.rhythm.current_event()
        if ev is not None and not ev.is_rest and ev.char and not ev.hit and abs(t - ev.timestamp) < 0.02 and s.rhythm._active_hold is None:
            pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=ord(ev.char), unicode=ev.char, mod=0, scancode=0))
            hits += 1
        s.running = True
        s.update(dt)
        t += dt
    stats = s.rhythm.get_stats()
    assert hits > 20
    assert stats["perfect"] + stats["good"] + stats["ok"] >= hits * 0.9
    assert stats["misses"] <= 2
    # fast-forward to the end of the chart to trigger the outro + finish flag
    fake.t = s.rhythm.beat_map[-1].timestamp + 3.0
    for _ in range(200):
        s.running = True
        s.update(dt)
        fake.t += dt
        if s._finish_needed:
            break
    assert s._finish_needed
    # results + typing panel construct and draw
    from game.screens.finish_screen import FinishScreen
    from game.coach.panel import TypingPanel
    fs = FinishScreen(screen, pygame.time.Clock(), screen.copy(), "tutorial", s.rhythm.get_score(),
                      s.rhythm.total_notes, s.rhythm.miss_count, stats=s.rhythm.get_stats(), hits=s.rhythm.hits)
    fs.t = 1.0
    fs.draw()
    panel = TypingPanel(screen, s.rhythm.hits, s.rhythm.get_stats(), "tutorial", "classic")
    panel.t = 5.0
    panel.draw(1 / 60)
    assert panel.sentences
