"""
FinishScreen — the results, in the play screen's own language.

No box.  The last frame of the run dims under the airbrush, the grade stands
huge on the left with its bloom and three petals for the stars, and the right
column tells the story in order: the score counting up (with NEW BEST when
it is one), accuracy and max combo, the judgment bar filling in the lane
colours, then the counts and a timing note.  Noki sits on the line at the
bottom, bopping for a good run and slumping for a bad one.  Two pill buttons
— REPLAY and SONGS — and the keys that drive them.  Everything reveals in a
stagger over the first second and a half.

Run with ``.run()`` — returns "replay" or "exit".  TAB opens the typing coach.
"""
from __future__ import annotations

import math
import os

import pygame

from .. import audio_manager
from .. import keyboard as KB
from ..menu_utils import draw_cursor
from ..sprites import get_font, render_text, multiply_alpha, glow_disk, load_noki_frames, aa_circle

GRADE_COLORS = {
    "SS": (255, 222, 123), "S": (255, 222, 123), "A": (131, 227, 176),
    "B": (142, 204, 255), "C": (255, 193, 142), "D": (255, 96, 122),
}
GRADE_WORD = {"SS": "flawless", "S": "brilliant", "A": "great run", "B": "solid", "C": "getting there", "D": "keep going"}
TIER_LABEL = {"journey": "EASY", "classic": "FAIR", "master": "HARD", "demon": "DEMON"}
TIER_COLOR = {"journey": (131, 227, 176), "classic": (142, 204, 255), "master": (255, 193, 142), "demon": (255, 96, 122)}
INK = (14, 13, 22)
WHITE = (255, 255, 255)
MUTED = (150, 150, 178)
BG_TOP = (9, 8, 16)
BG_MID = (30, 28, 54)


def _ease_out_back(t: float) -> float:
    c1 = 1.70158
    c3 = c1 + 1.0
    t = max(0.0, min(1.0, t))
    return 1.0 + c3 * (t - 1.0) ** 3 + c1 * (t - 1.0) ** 2


def _ease_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 3


def _window(t: float, t0: float, dur: float) -> float:
    """0 before t0, 1 after t0 + dur, eased in between."""
    return _ease_out_cubic((t - t0) / dur) if dur > 0 else (1.0 if t >= t0 else 0.0)


class FinishScreen:
    """Run with .run() — returns 'replay' or 'exit'."""

    # reveal schedule (seconds)
    T_TITLE, T_GRADE, T_SCORE, T_STATS, T_BAR, T_BUTTONS = 0.05, 0.22, 0.42, 0.78, 0.95, 1.20
    SCORE_COUNT_DUR = 1.05
    BAR_FILL_DUR = 0.75

    def __init__(self, screen: pygame.Surface, clock: pygame.time.Clock, backdrop: pygame.Surface,
                 level_name: str, score: int, total_notes: int, misses: int, stats: dict | None = None,
                 hits: list | None = None, difficulty: str = "classic", mode: str = "words",
                 prev_best: int | None = None) -> None:
        self.screen = screen
        self.clock = clock
        self._backdrop = backdrop
        self.level_name = level_name
        self.score = int(score)
        self.total_notes = total_notes
        self.misses = misses
        self.stats = stats or {}
        self.hits = hits or []
        self.difficulty = difficulty
        self.mode = mode
        self.prev_best = prev_best
        self.new_best = prev_best is None or self.score > int(prev_best)
        self.t = 0.0
        self._typing_open = False
        self._typing_panel = None

        self.grade = self.stats.get("grade") or "D"
        self.grade_color = GRADE_COLORS.get(self.grade, (210, 210, 220))
        self.stars = int(self.stats.get("stars", 0))

        sw, sh = screen.get_size()
        self.sw, self.sh = sw, sh
        self.u = sh / 1080.0                      # one design pixel
        self._bake(sw, sh)

        # Noki on the line
        self._noki = load_noki_frames("noki_bop", int(sh * 0.24))
        self._noki_hurt = load_noki_frames("noki_hurt", int(sh * 0.24))

        # buttons: two pills, centred low
        bw, bh = int(300 * self.u), int(78 * self.u)
        gap = int(60 * self.u)
        cx = int(sw * 0.62)
        by = int(sh * 0.86)
        self._buttons = [
            {"label": "REPLAY", "key": "replay", "rect": pygame.Rect(cx - gap // 2 - bw, by - bh // 2, bw, bh),
             "col": KB.lane_color(0), "hint": "R", "scale": 1.0},
            {"label": "SONGS", "key": "exit", "rect": pygame.Rect(cx + gap // 2, by - bh // 2, bw, bh),
             "col": KB.lane_color(2), "hint": "ESC", "scale": 1.0},
        ]

    # ── baked pieces ──────────────────────────────────────────────────────
    def _bake(self, sw: int, sh: int) -> None:
        u = self.u
        # the airbrush veil over the last frame: dark at the top, a lift behind the grade
        veil = pygame.Surface((sw, sh), pygame.SRCALPHA)
        try:
            import numpy as np
            ys, xs = np.mgrid[0:sh, 0:sw]
            gx, gy = sw * 0.24, sh * 0.50
            d = np.sqrt(((xs - gx) / (sw * 0.42)) ** 2 + ((ys - gy) / (sh * 0.55)) ** 2)
            k = np.clip(1.0 - d, 0.0, 1.0)
            k = k * k * (3.0 - 2.0 * k)
            vert = np.clip(ys / sh, 0.0, 1.0)[..., None]
            c0 = np.array(BG_TOP, dtype=float)
            c1 = np.array(BG_MID, dtype=float)
            rgb = (c0 + (c1 - c0) * (0.35 * vert + 0.65 * k[..., None])).astype("uint8")
            pygame.surfarray.blit_array(veil, np.ascontiguousarray(rgb.swapaxes(0, 1)))
            pygame.surfarray.pixels_alpha(veil)[:] = 236
        except Exception:
            veil.fill((*BG_TOP, 236))
        self._veil = veil.convert_alpha()
        self._bloom = glow_disk(int(210 * u), self.grade_color, 0.42, pad=int(220 * u))
        self._petal_on = self._petal(int(30 * u), KB.lane_color(0), 1.0)
        self._petal_off = self._petal(int(30 * u), (70, 64, 92), 1.0)
        # the slot line Noki sits on
        self._line_y = int(sh * 0.965)

    @staticmethod
    def _petal(size: int, color: tuple, alpha: float) -> pygame.Surface:
        s = pygame.Surface((size * 2, size * 2), pygame.SRCALPHA)
        pygame.draw.ellipse(s, (*color, int(255 * alpha)), (size * 0.55, size * 0.15, size * 0.9, size * 1.7))
        return pygame.transform.rotate(s, -28)

    # ── text helpers ──────────────────────────────────────────────────────
    def _text(self, kind: str, px: int, text: str, color: tuple, alpha: float = 1.0) -> pygame.Surface:
        s = render_text(kind, max(8, int(px)), text, color)
        return multiply_alpha(s, alpha) if alpha < 0.995 else s

    def _blit(self, surf: pygame.Surface, **anchor) -> pygame.Rect:
        r = surf.get_rect(**anchor)
        self.screen.blit(surf, r)
        return r

    def _pill(self, rect: pygame.Rect, fill: tuple, alpha: float, outline: tuple | None = None, width: int = 0) -> None:
        s = pygame.Surface(rect.size, pygame.SRCALPHA)
        pygame.draw.rect(s, (*fill, int(255 * alpha)), s.get_rect(), width=width, border_radius=rect.h // 2)
        if outline is not None:
            pygame.draw.rect(s, (*outline, int(255 * alpha)), s.get_rect(), width=max(1, int(2 * self.u)), border_radius=rect.h // 2)
        self.screen.blit(s, rect.topleft)

    # ── update ────────────────────────────────────────────────────────────
    def update(self, dt: float, mouse_pos: tuple, mouse_clicked: bool) -> str | None:
        self.t += dt
        for b in self._buttons:
            hov = b["rect"].collidepoint(mouse_pos)
            b["scale"] += ((1.06 if hov else 1.0) - b["scale"]) * min(1.0, 14.0 * dt)
            if hov and mouse_clicked and self.t >= self.T_BUTTONS:
                audio_manager.play_click()
                return b["key"]
        return None

    # ── draw ──────────────────────────────────────────────────────────────
    def draw(self) -> None:
        t, u = self.t, self.u
        sw, sh = self.sw, self.sh
        self.screen.blit(self._backdrop, (0, 0))
        veil = self._veil if t >= 0.25 else multiply_alpha(self._veil, min(1.0, t / 0.25))
        self.screen.blit(veil, (0, 0))
        self._draw_title(t)
        self._draw_grade(t)
        self._draw_score(t)
        self._draw_stats(t)
        self._draw_bar(t)
        self._draw_noki(t)
        self._draw_buttons(t)

    def _draw_title(self, t):
        a = _window(t, self.T_TITLE, 0.35)
        if a <= 0:
            return
        u = self.u
        x, y = int(self.sw * 0.06), int(self.sh * 0.085)
        name = self._text("display", 46 * u, self.level_name, WHITE, a)
        if name.get_width() > self.sw * 0.5:
            name = pygame.transform.smoothscale(name, (int(self.sw * 0.5), int(name.get_height() * self.sw * 0.5 / name.get_width())))
        self._blit(name, topleft=(x, y))
        ty = y + name.get_height() + int(12 * u)
        tier = TIER_LABEL.get(self.difficulty, self.difficulty.upper())
        tcol = TIER_COLOR.get(self.difficulty, MUTED)
        lbl = self._text("stamp", 18 * u, tier, INK, a)
        pill = pygame.Rect(x, ty, lbl.get_width() + int(28 * u), lbl.get_height() + int(12 * u))
        self._pill(pill, tcol, a)
        self._blit(lbl, center=pill.center)
        mode = self._text("body", 20 * u, "LETTERS" if self.mode == "letters" else "WORDS", MUTED, a)
        self._blit(mode, midleft=(pill.right + int(18 * u), pill.centery))

    def _draw_grade(self, t):
        k = (t - self.T_GRADE) / 0.5
        if k <= 0:
            return
        u = self.u
        cx, cy = int(self.sw * 0.24), int(self.sh * 0.50)
        a = min(1.0, k * 2.2)
        sc = 2.4 - 1.4 * _ease_out_back(min(1.0, k))
        bloom = multiply_alpha(self._bloom, a * (0.6 + 0.4 * (0.5 + 0.5 * math.sin(t * 1.6))))
        self._blit(bloom, center=(cx, cy))
        g = render_text("display", int(320 * u), self.grade, self.grade_color)
        if abs(sc - 1.0) > 0.01:
            g = pygame.transform.smoothscale(g, (max(1, int(g.get_width() * sc)), max(1, int(g.get_height() * sc))))
        g = multiply_alpha(g, a)
        self._blit(g, center=(cx, cy - int(20 * u)))
        # the word under the grade, then the petals
        a2 = _window(t, self.T_GRADE + 0.35, 0.3)
        if a2 > 0:
            w = self._text("body", 24 * u, GRADE_WORD.get(self.grade, ""), MUTED, a2)
            self._blit(w, center=(cx, cy + int(150 * u)))
            for i in range(3):
                lit = i < self.stars and _window(t, self.T_GRADE + 0.55 + 0.12 * i, 0.2) > 0.5
                img = self._petal_on if lit else self._petal_off
                px = cx + (i - 1) * int(58 * u)
                if lit:
                    pop = 1.0 + 0.3 * max(0.0, 1.0 - (t - (self.T_GRADE + 0.55 + 0.12 * i)) / 0.25)
                    if pop > 1.01:
                        img = pygame.transform.smoothscale(img, (int(img.get_width() * pop), int(img.get_height() * pop)))
                self._blit(multiply_alpha(img, a2), center=(px, cy + int(205 * u)))

    def _draw_score(self, t):
        a = _window(t, self.T_SCORE, 0.3)
        if a <= 0:
            return
        u = self.u
        x, y = int(self.sw * 0.47), int(self.sh * 0.27)
        lbl = self._text("stamp", 18 * u, "SCORE", MUTED, a)
        self._blit(lbl, topleft=(x, y))
        k = _ease_out_cubic((t - self.T_SCORE) / self.SCORE_COUNT_DUR)
        shown = int(round(self.score * k))
        num = render_text("display", int(112 * u), f"{shown:,}", WHITE, cache=False)
        num = multiply_alpha(num, a)
        r = self._blit(num, topleft=(x - int(4 * u), y + lbl.get_height() + int(2 * u)))
        if k >= 1.0:
            if self.new_best:
                a3 = _window(t, self.T_SCORE + self.SCORE_COUNT_DUR, 0.25)
                pop = 1.0 + 0.25 * max(0.0, 1.0 - (t - (self.T_SCORE + self.SCORE_COUNT_DUR)) / 0.25)
                tag = self._text("stamp", int(20 * u * pop), "NEW BEST", INK, a3)
                pill = pygame.Rect(0, 0, tag.get_width() + int(30 * u), tag.get_height() + int(14 * u))
                pill.midleft = (r.right + int(26 * u), r.centery + int(6 * u))
                self._pill(pill, KB.GOLD, a3)
                self._blit(tag, center=pill.center)
            elif self.prev_best is not None:
                a3 = _window(t, self.T_SCORE + self.SCORE_COUNT_DUR, 0.25)
                best = self._text("body", 22 * u, f"best {int(self.prev_best):,}", MUTED, a3)
                self._blit(best, midleft=(r.right + int(26 * u), r.centery + int(8 * u)))

    def _draw_stats(self, t):
        a = _window(t, self.T_STATS, 0.3)
        if a <= 0:
            return
        u = self.u
        s = self.stats
        x, y = int(self.sw * 0.47), int(self.sh * 0.49)
        acc = s.get("accuracy", 0.0)
        for i, (label, value) in enumerate((("ACCURACY", f"{acc:.1f} %"), ("MAX COMBO", f"×{s.get('max_combo', 0)}"),
                                            ("CLEAN WORDS", f"{s.get('clean_words', 0)}/{s.get('total_words', 0)}"))):
            cx = x + i * int(self.sw * 0.155)
            lbl = self._text("stamp", 16 * u, label, MUTED, a)
            self._blit(lbl, topleft=(cx, y))
            val = self._text("display", 54 * u, value, WHITE, a)
            self._blit(val, topleft=(cx - int(2 * u), y + lbl.get_height() + int(2 * u)))

    def _draw_bar(self, t):
        a = _window(t, self.T_BAR, 0.3)
        if a <= 0:
            return
        u = self.u
        s = self.stats
        x, y = int(self.sw * 0.47), int(self.sh * 0.665)
        w, h = int(self.sw * 0.44), int(22 * u)
        parts = [("PERFECT", s.get("perfect", 0), KB.GOLD), ("GREAT", s.get("good", 0), (131, 227, 176)),
                 ("OK", s.get("ok", 0), (174, 208, 230)), ("MISS", s.get("misses", 0), KB.MISS_RED)]
        total = max(1, sum(n for _l, n, _c in parts))
        fill = _ease_out_cubic((t - self.T_BAR) / self.BAR_FILL_DUR)
        track = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.draw.rect(track, (255, 255, 255, int(255 * 0.08 * a)), track.get_rect(), border_radius=h // 2)
        self.screen.blit(track, (x, y))
        seg = pygame.Surface((w, h), pygame.SRCALPHA)
        px = 0
        for _l, n, col in parts:
            sw_ = int(w * (n / total) * fill)
            if sw_ > 0:
                pygame.draw.rect(seg, (*col, int(255 * a)), (px, 0, sw_, h))
            px += sw_
        mask = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.draw.rect(mask, (255, 255, 255, 255), mask.get_rect(), border_radius=h // 2)
        seg.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MIN)
        self.screen.blit(seg, (x, y))
        # legend
        lx = x
        ly = y + h + int(16 * u)
        for label, n, col in parts:
            dot = aa_circle(int(6 * u), col, 0, int(255 * a))
            self._blit(dot, midleft=(lx, ly + int(12 * u)))
            txt = self._text("body", 21 * u, f"{label} {n}", (205, 205, 225), a)
            r = self._blit(txt, midleft=(lx + int(20 * u), ly + int(12 * u)))
            lx = r.right + int(28 * u)
        slips = s.get("slips", 0)
        if slips:
            txt = self._text("body", 21 * u, f"SLIPS {slips}", MUTED, a)
            self._blit(txt, midleft=(lx, ly + int(12 * u)))
        off = s.get("mean_offset_ms", 0.0)
        if abs(off) >= 8 and s.get("total_notes", 0) >= 20:
            tip = f"You were landing about {abs(off):.0f} ms {'late' if off > 0 else 'early'} — try the offset in settings."
            tl = self._text("body", 20 * u, tip, MUTED, a)
            self._blit(tl, topleft=(x, ly + int(40 * u)))

    def _draw_noki(self, t):
        frames = self._noki
        if not frames:
            return
        u = self.u
        pygame.draw.line(self.screen, (200, 200, 220), (0, self._line_y), (int(self.sw * 0.40), self._line_y), max(2, int(3 * u)))
        bad = self.grade in ("C", "D")
        if bad and self._noki_hurt:
            frames = self._noki_hurt
            idx = min(len(frames) - 1, int(t * 30))
        else:
            n = len(frames)
            idx = int((t * 1.9) * n) % n if n else 0
        f = frames[idx]
        self.screen.blit(f, f.get_rect(midbottom=(int(self.sw * 0.115), self._line_y + int(2 * u))))

    def _draw_buttons(self, t):
        a = _window(t, self.T_BUTTONS, 0.3)
        if a <= 0:
            return
        u = self.u
        for b in self._buttons:
            r0 = b["rect"]
            sc = b["scale"]
            r = pygame.Rect(0, 0, int(r0.w * sc), int(r0.h * sc))
            r.center = r0.center
            hov = sc > 1.02
            self._pill(r, b["col"], a * (1.0 if hov else 0.92))
            lbl = self._text("display", 34 * u, b["label"], INK, a)
            self._blit(lbl, center=r.center)
            hint = self._text("body", 18 * u, b["hint"], MUTED, a * 0.9)
            self._blit(hint, midtop=(r.centerx, r0.bottom + int(10 * u)))
        tab = self._text("body", 18 * u, "TAB · typing report", MUTED, a * 0.8)
        self._blit(tab, bottomright=(self.sw - int(28 * u), self.sh - int(22 * u)))

    # ── main loop ─────────────────────────────────────────────────────────
    def run(self) -> str:
        """Block until the player picks replay or exit."""
        while True:
            dt = min(0.05, self.clock.tick(60) / 1000.0)
            mouse_pos = pygame.mouse.get_pos()
            mouse_clicked = False
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return "exit"
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_TAB:
                        self._typing_open = not self._typing_open
                        if self._typing_open and self._typing_panel is None:
                            try:
                                from ..coach.panel import TypingPanel
                                self._typing_panel = TypingPanel(self.screen, self.hits, self.stats, self.level_name, self.difficulty)
                            except Exception as _exc:  # noqa: BLE001
                                print("typing panel unavailable:", _exc)
                                self._typing_open = False
                        continue
                    if event.key == pygame.K_ESCAPE:
                        if self._typing_open:
                            self._typing_open = False
                            continue
                        audio_manager.play_click()
                        return "exit"
                    if event.key == pygame.K_r:
                        audio_manager.play_click()
                        return "replay"
                if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    mouse_clicked = True
            result = self.update(dt, mouse_pos, mouse_clicked) if not self._typing_open else None
            self.draw()
            if self._typing_open and self._typing_panel is not None:
                self._typing_panel.draw(dt)
            draw_cursor(self.screen)
            pygame.display.flip()
            if result is not None:
                return result
