"""
PlaySession — one run of one song on the Highway.

Loads (analysis + chart, cached), starts the music and the ChartClock in the
same breath, then per frame: advance the judgment core, process every key
pressed this frame, tell the renderer what happened, draw.  Pause lives in
the clock.  When the chart ends (or the song goes silent) the run fades into
the results screen.

Returns "replay", "menu" or None from ``run()``, like the old Game class.
"""
from __future__ import annotations

import math
import os
import sys
import time
import threading

import pygame

from . import constants as C
from . import models as M
from .clock import ChartClock
from .highway import HighwayRenderer
from .input import Input
from .layout import Layout
from .menu import PauseScreen
from .rhythm import RhythmManager
from .screens import SettingsPanel
from .settings import load_settings
from .sprites import render_text, load_image


class PlaySession:
    def __init__(self, level: M.Level, screen: pygame.Surface, clock: pygame.time.Clock | None = None,
                 music=None) -> None:
        self.level = level
        self.screen = screen
        self.clock = clock or pygame.time.Clock()
        self._music = music
        self.settings = load_settings()
        abs_song_path = C._to_abs_path(level.song_path)
        if abs_song_path is None or not os.path.exists(abs_song_path):
            raise ValueError(f"Invalid song path: {level.song_path}")
        self.song_path = abs_song_path
        self.title = os.path.splitext(os.path.basename(self.song_path))[0]

        self.running = False
        self._exit_to_menu = False
        self._finish_needed = False
        self._finish_snapshot: pygame.Surface | None = None
        self.score = 0
        self.stats: dict = {}

        # ── load (analysis + chart) with the petal spinner ──────────────────
        result: dict = {}
        errors: list = []

        def _worker():
            try:
                from charting import build_chart
                result.update(build_chart(level, self.song_path))
            except Exception as exc:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                errors.append(exc)

        th = threading.Thread(target=_worker, daemon=True)
        th.start()
        self._spinner_loop(th)
        if errors:
            raise errors[0]

        self.song: M.Song = result["song"]
        self.events: list[M.CharEvent] = result["events"]
        self.lead_in: float = result["lead_in"]
        self.chart_meta = result.get("meta", {})
        self.difficulty_profile = C.DIFFICULTY_PROFILES.get(level.difficulty, C.DIFFICULTY_PROFILES["classic"])

        # ── clock, judgment, layout, renderer ──────────────────────────────
        self.chart_clock = ChartClock(device_offset_ms=float(self.settings.get("offset_ms", 0.0)))
        self.rhythm = RhythmManager(self.events, self.song.bpm, lead_in=self.lead_in,
                                    timing_scale=self.difficulty_profile.timing_scale,
                                    clock=self.chart_clock.now)
        sw, sh = screen.get_size()
        self.layout = self._make_layout(sw, sh)
        if level.mode == "letters":
            from .letters_renderer import LettersRenderer
            self.renderer = LettersRenderer(self.layout, self.song, self.rhythm, level.difficulty,
                                            self.settings, title=self.title)
        else:
            self.renderer = HighwayRenderer(self.layout, self.song, self.rhythm, level.difficulty,
                                            self.settings, title=self.title)
        if hasattr(self.renderer, "set_sections"):
            self.renderer.set_sections(self.chart_meta)
        self.renderer.set_duets(self.chart_meta.get("duets", []))
        self.input = Input()

        # end-of-song: silence after the last beat
        self._silence_start = self.song.duration
        bt = self.song.beat_times
        if len(bt) > 8:
            avg_gap = (bt[-1] - bt[0]) / max(1, len(bt) - 1)
            for i in range(len(bt) - 1, 0, -1):
                if (bt[i] - bt[i - 1]) > avg_gap * 2.5:
                    self._silence_start = bt[i - 1]
                    break
        if self.song.duration - self._silence_start < 2.0:
            self._silence_start = self.song.duration
        self._outro_t0: float | None = None
        self._outro_dur = 2.2
        self._outro_finish_started = False

        # ── pause ──────────────────────────────────────────────────────────
        self.paused = False
        self.pause_screen: PauseScreen | None = None
        self._pause_snapshot: pygame.Surface | None = None
        self._in_level_settings: SettingsPanel | None = None

        # ── hitsound ───────────────────────────────────────────────────────
        pygame.mixer.init()
        hp = C.asset("audios", "effects", "hitsound.mp3")
        self._hitsound: pygame.mixer.Sound | None = None
        try:
            self._hitsound = pygame.mixer.Sound(hp)
            self._hitsound.set_volume(float(self.settings.get("hitsound_volume", 0.9)))
        except Exception:
            pass
        self._pending_hitsounds: list[float] = []   # chart times

        # ── in-level buttons (pause / settings) ────────────────────────────
        self._place_buttons()

        # ── go: the clock starts now, the music when chart time reaches the lead-in ──
        # Chart timestamps are song time + lead_in, so the lead-in bars are a count-in:
        # the beat rows and the first orbs are already falling when the song begins.
        pygame.mixer.music.load(self.song_path)
        pygame.mixer.music.set_volume(float(self.settings.get("music_volume", 0.8)))
        self._music_started = False
        self.chart_clock.start()
        self._last_t = 0.0

    def _make_layout(self, sw: int, sh: int) -> Layout:
        return Layout(sw, sh, key_guide=self.settings.get("key_guide", "off"),
                      noki_placement=self.settings.get("noki_placement", "line"),
                      stage_view=bool(self.settings.get("stage_view", False)),
                      mode="letters" if self.level.mode == "letters" else "highway")

    def _place_buttons(self) -> None:
        """Pause and settings: small and faint, top-right under the accuracy number (Esc pauses too)."""
        L = self.layout
        bsz = L.S(44)
        self._leave_img = load_image("leavebutton.png", (bsz, bsz))
        self._settings_img = load_image("noki_settingsbutton.png", (bsz, bsz))
        by = L.Y(L.top + 128)
        self._leave_rect = pygame.Rect(L.X(L.right - 40) - bsz, by, bsz, bsz)
        self._settings_rect = pygame.Rect(L.X(L.right - 40) - 2 * bsz - L.S(12), by, bsz, bsz)

    def _on_resize(self) -> None:
        """The window changed size (macOS often does this right after launch): rebuild the layout.

        Everything the renderers bake is sized to the window, so a stale layout leaves a strip
        of the screen that is never cleared.
        """
        surf = pygame.display.get_surface()
        if surf is not None:
            self.screen = surf
        sw, sh = self.screen.get_size()
        if (sw, sh) == (self.layout.win_w, self.layout.win_h):
            return
        self.layout = self._make_layout(sw, sh)
        self.renderer.set_layout(self.layout)
        self._place_buttons()

    # ── loading screen ─────────────────────────────────────────────────────
    def _spinner_loop(self, th: threading.Thread) -> None:
        sw, sh = self.screen.get_size()
        p1 = load_image("petal1.png", (40, 40))
        p2 = load_image("petal2.png", (40, 40))
        cx, cy, radius = sw // 2, sh // 2, 50
        P1 = (60.0 / 45.0) / 0.7
        P2 = P1 * 0.65
        t0 = time.time()
        spin = pygame.time.Clock()

        def angle(tn: float) -> float:
            if tn < 0.5:
                p = tn / 0.5
                return math.pi / 2 - math.pi * (p * p)
            p = (tn - 0.5) / 0.5
            return -math.pi / 2 - math.pi * (1.0 - (1.0 - p) ** 4)

        def draw_petal(img, elapsed, period, offset):
            if img is None:
                return
            tn = ((elapsed + offset) % period) / period
            a = angle(tn)
            for step in (3, 2, 1):
                tp = ((elapsed - 0.045 * step + offset) % period) / period
                ga = angle(tp)
                g = pygame.transform.rotate(img, math.degrees(ga))
                g.set_alpha([120, 60, 25][step - 1])
                self.screen.blit(g, g.get_rect(center=(int(cx + radius * math.cos(ga)), int(cy - radius * math.sin(ga)))))
            r = pygame.transform.rotate(img, math.degrees(a))
            self.screen.blit(r, r.get_rect(center=(int(cx + radius * math.cos(a)), int(cy - radius * math.sin(a)))))

        label = render_text("body", 20, "charting the song", (120, 120, 140))
        while th.is_alive():
            spin.tick(60)
            el = time.time() - t0
            self.screen.fill((6, 5, 11))
            draw_petal(p1, el, P1, 0.0)
            draw_petal(p2, el, P2, P2 * 0.375)
            if el > 1.5:
                self.screen.blit(label, label.get_rect(center=(cx, cy + 90)))
            pygame.display.flip()
            for ev in pygame.event.get():
                if ev.type == pygame.QUIT:
                    pygame.quit()
                    sys.exit()

    # ── main loop ──────────────────────────────────────────────────────────
    def run(self) -> str | None:
        self.running = True
        while self.running:
            dt = min(0.05, self.clock.tick(60) / 1000.0)
            if self.paused:
                self._update_paused(dt)
            else:
                self.update(dt)
            pygame.display.flip()
        pygame.mixer.music.stop()
        self.score = self.rhythm.get_score()
        self.stats = self.rhythm.get_stats()
        if self._finish_needed and not self._exit_to_menu:
            return self._run_finish_screen()
        return "menu" if self._exit_to_menu else None

    def _run_finish_screen(self) -> str:
        from .screens.finish_screen import FinishScreen
        backdrop = self._finish_snapshot or self.screen.copy()
        prev_best = None
        try:
            from .menu_utils import _load_scores
            key = self.level.difficulty if self.level.mode == "words" else f"{self.level.difficulty}@{self.level.mode}"
            prev_best = _load_scores().get(os.path.basename(self.song_path), {}).get(key)
        except Exception:
            prev_best = None
        fs = FinishScreen(screen=self.screen, clock=self.clock, backdrop=backdrop,
                          level_name=self.title, score=self.score,
                          total_notes=self.rhythm.total_notes, misses=self.rhythm.miss_count,
                          stats=self.stats, hits=self.rhythm.hits, difficulty=self.level.difficulty,
                          mode=self.level.mode, prev_best=prev_best)
        return fs.run()

    # ── pause ──────────────────────────────────────────────────────────────
    def _enter_pause(self) -> None:
        self.paused = True
        self.chart_clock.pause()
        self._pause_snapshot = self.screen.copy()
        self.pause_screen = PauseScreen(self.screen)
        if self._music_started:
            pygame.mixer.music.pause()

    def _exit_pause(self) -> None:
        self.paused = False
        self.pause_screen = None
        self.chart_clock.resume()
        if self._music_started:
            pygame.mixer.music.unpause()

    def _update_paused(self, dt: float) -> None:
        if self._pause_snapshot is not None:
            self.screen.blit(self._pause_snapshot, (0, 0))
        mouse_pos = pygame.mouse.get_pos()
        clicked = False
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                return
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                self._in_level_settings = None
                self._exit_pause()
                return
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                clicked = True
        if self._in_level_settings is not None:
            res = self._in_level_settings.update(dt, mouse_pos, clicked)
            self._in_level_settings.draw()
            if res == "close":
                self._in_level_settings = None
                self._exit_pause()
            return
        action = self.pause_screen.update(mouse_pos, clicked) if self.pause_screen else None
        if self.pause_screen:
            self.pause_screen.draw(time.time())
        if action == "resume":
            self._exit_pause()
        elif action == "menu":
            self._exit_to_menu = True
            self.running = False

    # ── frame ──────────────────────────────────────────────────────────────
    def update(self, dt: float) -> None:
        if self.screen.get_size() != (self.layout.win_w, self.layout.win_h):
            self._on_resize()           # a resize that arrived without an event
        t = self.chart_clock.now()
        if not self._music_started and self.chart_clock.raw() >= self.lead_in:
            pygame.mixer.music.play()
            self.chart_clock.rebase(self.lead_in)      # chart time == lead_in the instant the song starts
            self._music_started = True
            t = self.chart_clock.now()
        if self._music_started:
            try:
                pos = pygame.mixer.music.get_pos()
                self.chart_clock.check_drift(pos / 1000.0 + self.lead_in if pos >= 0 else None)
            except Exception:
                pass

        # scheduled hitsounds for early hits
        if self._pending_hitsounds and self._hitsound:
            due = [x for x in self._pending_hitsounds if t >= x]
            for _ in due:
                self._hitsound.play()
            self._pending_hitsounds = [x for x in self._pending_hitsounds if t < x]

        events = pygame.event.get()
        mouse_pos = pygame.mouse.get_pos()
        clicked = False
        pause_requested = False
        for event in events:
            if event.type == pygame.QUIT:
                self.running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    pause_requested = True
                elif event.key == pygame.K_SPACE:
                    self.renderer.try_rush(t)
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                clicked = True
            elif event.type == pygame.VIDEORESIZE:
                self._on_resize()
        if clicked and self._leave_rect.collidepoint(mouse_pos):
            pause_requested = True
        if clicked and self._settings_rect.collidepoint(mouse_pos):
            self._enter_pause()
            self._in_level_settings = SettingsPanel(self.screen, self._music, self._settings_rect)
            return

        # judgment: misses first (window closed), then every key of this frame
        hold_before = self.rhythm._active_hold
        for ev in self.rhythm.update():
            self.renderer.on_miss(ev, t)
        if hold_before is not None and self.rhythm._active_hold is None and hold_before.hit:
            self.renderer.on_hold_complete(hold_before, self.rhythm._hold_judgment, t)
            if self._hitsound:
                self._hitsound.play()
        for ar in self.rhythm.anchor_results:
            if ar.get("event") is not None and hasattr(self.renderer, "on_anchor_complete"):
                self.renderer.on_anchor_complete(ar["event"], ar["judgment"].replace("hold_", ""), t)
        self.rhythm.anchor_results = []

        self.input.update(events=events)
        for key in self.input.typed_chars:
            if key == " ":
                continue
            res = self.rhythm.check_input(key)
            j = res["judgment"]
            ev = res.get("event")
            if res["hit"]:
                offset_ms = res["offset"] * 1000.0
                if j == "hold_started":
                    self.renderer.on_hold_start(ev, self.rhythm._hold_judgment, offset_ms, t)
                elif j == "anchor_started":
                    if hasattr(self.renderer, "on_anchor_start"):
                        self.renderer.on_anchor_start(ev, self.rhythm._anchor_judgment, offset_ms, t)
                else:
                    self.renderer.on_hit(ev, j, offset_ms, t)
                    if res.get("is_word_complete"):
                        clean = ev.word_id not in self.rhythm._dirty_words
                        self.renderer.on_word_complete(ev.word_text, clean, t)
                if self._hitsound:
                    if res["offset"] < -0.04:
                        self._pending_hitsounds.append(ev.timestamp - 0.02)
                    else:
                        self._hitsound.play()
            elif j == "slip" and ev is not None:
                self.renderer.on_slip(ev, key, t)
            elif j == "too_early" and ev is not None:
                self.renderer.on_too_early(ev, t)
        for rel in self.input.released_chars:
            hr = self.rhythm.on_key_release(rel)
            if hr:
                ev = hr.get("event")
                if hr.get("anchor"):
                    if hr["hit"] and ev is not None and hasattr(self.renderer, "on_anchor_complete"):
                        self.renderer.on_anchor_complete(ev, hr["judgment"].replace("hold_", ""), t)
                    elif ev is not None and hasattr(self.renderer, "on_anchor_break"):
                        self.renderer.on_anchor_break(ev, t)
                elif hr["hit"] and ev is not None:
                    self.renderer.on_hold_complete(ev, hr["judgment"].replace("hold_", ""), t)
                elif ev is not None:
                    self.renderer.on_miss(ev, t)

        # outro (chart finished, song went silent, or HP hit zero in Letters mode)
        song_t = t - self.lead_in
        failed = bool(getattr(self.renderer, "failed", False))
        if (self.rhythm.is_finished() or song_t >= self._silence_start or failed) and self._outro_t0 is None:
            self._outro_t0 = t
        self.renderer.draw(self.screen, t, dt)
        self._draw_buttons(mouse_pos)

        if self._outro_t0 is not None:
            age = t - self._outro_t0
            if age >= 1.0 and not self._outro_finish_started:
                self._outro_finish_started = True
                pygame.mixer.music.fadeout(900)
                try:
                    from . import audio_manager as _am
                    _am.play_level_finish()
                except Exception:
                    pass
            if age >= self._outro_dur:
                self._finish_snapshot = self.screen.copy()
                self._finish_needed = True
                self.running = False
                return

        if pause_requested:
            self._enter_pause()

    def _draw_buttons(self, mouse_pos) -> None:
        for img, rect in ((self._leave_img, self._leave_rect), (self._settings_img, self._settings_rect)):
            if img is None:
                continue
            hov = rect.collidepoint(mouse_pos)
            s = img
            if hov:
                s = pygame.transform.smoothscale(img, (int(rect.w * 1.1), int(rect.h * 1.1)))
            else:
                s = s.copy()
                s.set_alpha(70)
            self.screen.blit(s, s.get_rect(center=rect.center))
