"""
Level detail popup — shown when a song row is clicked.

Animates open from the clicked row's position, shows difficulty selector,
best score, and a PLAY button.  Animates closed on outside click or × button.

update() is split into:
  _handle_input     — hover detection and click routing
  _update_animation — advance open/close elapsed times and play-button scale
"""
from __future__ import annotations
import os
import pygame

from ..menu_utils import _FONT
from ..ui_components import DifficultySelector, TextInput
from ._constants import LEVEL_MENU_ANIM_DUR, BTN_LERP_HOVER, BTN_LERP_FAST

_ASSETS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "assets", "images",
)

# Border width of the popup frame
_BORD = 2


class LevelMenu:
    """Popup shown when a level row is clicked."""

    def __init__(self, screen, song_idx, song_name, initial_diff_idx, scores,
                 origin_rect=None, is_custom=False, current_bpm: int | None = None):
        self.screen    = screen
        self.song_idx  = song_idx
        self.song_name = song_name
        self._scores   = scores

        sw, sh = screen.get_size()

        pw = int(sw * 0.78)
        ph = int(sh * 0.56)
        px = (sw - pw) // 2
        py = (sh - ph) // 2
        self.rect = pygame.Rect(px, py, pw, ph)

        self._px, self._py, self._pw, self._ph = px, py, pw, ph
        pad               = max(24, pw // 30)
        self._pad         = pad
        self._mid_x       = px + pw // 2
        self._top_h       = int(ph * 0.20)
        self._bot_h       = int(ph * 0.28)
        self._body_top    = py + self._top_h
        self._body_bottom = py + ph - self._bot_h
        self._body_cy     = (self._body_top + self._body_bottom) // 2

        # Fonts — sized relative to the popup so it looks right at any resolution
        title_sz = max(28, ph // 10)
        big_sz   = max(64, ph // 4)
        sub_sz   = max(20, ph // 18)
        btn_sz   = max(30, ph // 8)
        self._title_font = pygame.font.Font(_FONT, title_sz)
        self._big_font   = pygame.font.Font(_FONT, big_sz)
        self._sub_font   = pygame.font.Font(_FONT, sub_sz)
        self._btn_font   = pygame.font.Font(_FONT, btn_sz)

        dummy_font    = pygame.font.Font(_FONT, sub_sz)
        self._diff    = DifficultySelector(0, 0, dummy_font)
        self._diff.selected = max(0, min(len(DifficultySelector.KEYS) - 1, initial_diff_idx))

        # Difficulty slide animation state (uses big_font for the label)
        self._diff_slide: float = 0.0           # incoming label x offset (lerps → 0)
        self._diff_prev_label: str | None = None
        self._diff_prev_color: tuple | None = None
        self._diff_prev_slide: float = 0.0      # outgoing label x offset (lerps away)
        self._diff_prev_exit_dir: int = 1       # stored direction so lerp never oscillates
        self._diff_slide_max: float = max(
            self._big_font.size(l.upper())[0] for l in DifficultySelector.LABELS
        ) * 1.4

        self._left_arrow_rect:  pygame.Rect | None = None
        self._right_arrow_rect: pygame.Rect | None = None

        # play mode: a segmented switch under the difficulty — WORDS (the Highway, with duet,
        # build and hold sections) · LETTERS (single letters on the field, osu!-style)
        self.MODES = ["words", "letters"]
        self.MODE_LABELS = {"words": "WORDS", "letters": "LETTERS"}
        self.MODE_BLURB = {"words": "type words on the beat", "letters": "single letters, anywhere"}
        self.mode = "words"
        self._mode_rects: list[pygame.Rect] = []
        self._mode_hover = -1
        self._mode_slide = 0.0          # 0 = WORDS, 1 = LETTERS, lerps for the sliding highlight
        from ..sprites import get_font as _gf
        self._mode_font = _gf("display", max(18, int(sub_sz * 0.95)))
        self._blurb_font = _gf("body", max(14, int(sub_sz * 0.72)))

        btn_w = int(pw * 0.52)
        btn_h = int(self._bot_h * 0.62)
        self._play_rect = pygame.Rect(
            px + (pw - btn_w) // 2,
            py + ph - self._bot_h + (self._bot_h - btn_h) // 2,
            btn_w, btn_h,
        )
        self._play_hovered = False
        self._play_scale   = 1.0

        close_sz = 30
        self._close_rect = pygame.Rect(
            px + pw - pad - close_sz, py + pad // 2, close_sz, close_sz,
        )
        self._close_hovered = False

        # BPM input (custom songs only)
        self.is_custom = is_custom
        self.bpm: int | None = current_bpm
        if is_custom:
            _bpm_w  = int(pw * 0.32)
            _bpm_h  = max(36, int(sub_sz * 1.6))
            _bpm_x  = px + pw * 3 // 4 - _bpm_w // 2
            _bpm_y  = (self._body_top + self._body_bottom) // 2 + int(ph * 0.04)
            self._bpm_input = TextInput(
                (_bpm_x, _bpm_y, _bpm_w, _bpm_h),
                pygame.font.Font(_FONT, sub_sz),
                placeholder="auto",
                max_length=4,
                numeric_only=True,
            )
            if current_bpm is not None:
                self._bpm_input.text = str(current_bpm)
        else:
            self._bpm_input = None

        self._overlay = pygame.Surface((sw, sh), pygame.SRCALPHA)

        self._origin = origin_rect.copy() if origin_rect else pygame.Rect(
            px + pw // 2, py + ph // 2, 0, 0
        )

        # Time-based open/close animation (dt-accumulated)
        self._open_elapsed:  float = 0.0
        self._close_elapsed: float = 0.0
        self._closing = False

    # ── Public API ────────────────────────────────────────────────────────────

    def update(self, dt: float, mouse_pos, mouse_clicked, _current_time,
               events: list | None = None) -> str | None:
        """Returns 'play', 'close', or None."""
        self._update_animation(dt)

        if self._bpm_input is not None and events:
            self._bpm_input.handle_events(events)

        if self._closing:
            if self._close_elapsed >= LEVEL_MENU_ANIM_DUR:
                return "close"
            return None

        return self._handle_input(mouse_pos, mouse_clicked)

    def draw(self, _current_time: float) -> None:
        at  = self._anim_t()
        cur = self._lerp_rect(self._origin, self.rect, at)
        pad = self._pad

        self._overlay.fill((0, 0, 0, int(155 * at)))
        self.screen.blit(self._overlay, (0, 0))

        pygame.draw.rect(self.screen, (8, 8, 14),      cur, border_radius=14)
        pygame.draw.rect(self.screen, (255, 255, 255),  cur, _BORD, border_radius=14)

        # Content fades in during the second half of the open animation
        if at < 0.55:
            return
        content_alpha = min(255, int(255 * (at - 0.55) / 0.45))

        def _blit_a(surf, rect):
            s = surf.copy()
            s.set_alpha(content_alpha)
            self.screen.blit(s, rect)

        fpx, fpy, fpw = self._px, self._py, self._pw
        diff_col = DifficultySelector.COLORS[self._diff.selected]

        # Title
        display_name = os.path.splitext(self.song_name)[0]
        name_surf    = self._title_font.render(display_name, True, (220, 220, 220))
        max_title_w  = fpw - pad * 2 - 44
        if name_surf.get_width() > max_title_w:
            clipped = pygame.Surface((max_title_w, name_surf.get_height()), pygame.SRCALPHA)
            clipped.blit(name_surf, (0, 0))
            name_surf = clipped
        _blit_a(name_surf, name_surf.get_rect(center=(fpx + fpw // 2, fpy + self._top_h // 2)))

        rule_y = fpy + self._top_h - 1
        pygame.draw.line(
            self.screen,
            (int(50 * at), int(50 * at), int(60 * at)),
            (fpx + pad, rule_y), (fpx + fpw - pad, rule_y), 1,
        )

        # Close ×
        xc = (255, 80, 80) if self._close_hovered else (120, 120, 130)
        xc = tuple(int(c * at) for c in xc)
        ccx, ccy = self._close_rect.center
        sz = 10
        pygame.draw.line(self.screen, xc, (ccx - sz, ccy - sz), (ccx + sz, ccy + sz), 2)
        pygame.draw.line(self.screen, xc, (ccx + sz, ccy - sz), (ccx - sz, ccy + sz), 2)

        # Vertical body divider
        pygame.draw.line(
            self.screen,
            (int(45 * at), int(45 * at), int(55 * at)),
            (self._mid_x, self._body_top + pad // 2),
            (self._mid_x, self._body_bottom - pad // 2), 1,
        )

        # Left half: difficulty label + arrows
        left_cx   = fpx + fpw // 4
        label     = DifficultySelector.LABELS[self._diff.selected].upper()
        diff_surf = self._big_font.render(label, True, diff_col)
        diff_y    = self._body_cy - int(self._ph * 0.06)

        # Clip to left half so sliding labels don't bleed into the score panel
        old_clip = self.screen.get_clip()
        clip_x   = fpx + 2
        clip_w   = self._mid_x - fpx - 2
        self.screen.set_clip(pygame.Rect(clip_x, fpy + self._top_h, clip_w, self._ph))

        # Outgoing label
        if self._diff_prev_label is not None:
            prev_col  = tuple(int(c * at) for c in self._diff_prev_color)
            prev_surf = self._big_font.render(self._diff_prev_label, True, prev_col)
            ps = prev_surf.copy(); ps.set_alpha(content_alpha)
            self.screen.blit(ps, ps.get_rect(center=(int(left_cx + self._diff_prev_slide), diff_y)))

        # Incoming (current) label
        s = diff_surf.copy(); s.set_alpha(content_alpha)
        self.screen.blit(s, s.get_rect(center=(int(left_cx + self._diff_slide), diff_y)))

        self.screen.set_clip(old_clip)

        arrow_y   = diff_y + diff_surf.get_height() // 2 + 28
        arrow_gap = 44
        a_col     = tuple(int(180 * at) for _ in range(3))

        # Always show both arrows (wrap-around)
        self._draw_tri(self.screen, a_col, left_cx - arrow_gap, arrow_y, "left")
        self._left_arrow_rect = pygame.Rect(left_cx - arrow_gap - 22, arrow_y - 18, 44, 36)
        self._draw_tri(self.screen, a_col, left_cx + arrow_gap, arrow_y, "right")
        self._right_arrow_rect = pygame.Rect(left_cx + arrow_gap - 22, arrow_y - 18, 44, 36)

        # Mode switch under the difficulty: two segments in one pill, the highlight slides
        seg_w = max(120, int(clip_w * 0.30))
        seg_h = max(34, int(self._sub_font.get_height() * 1.45))
        mode_y = arrow_y + 30 + seg_h // 2 + 8
        track = pygame.Rect(left_cx - seg_w, mode_y - seg_h // 2, seg_w * 2, seg_h)
        self._mode_rects = [pygame.Rect(track.x, track.y, seg_w, seg_h), pygame.Rect(track.x + seg_w, track.y, seg_w, seg_h)]
        # anti-aliased pill: pygame's rounded rects step along the curve, so the track, its
        # hairline and the sliding highlight are distance-field shapes (cached per size)
        from ..sprites import aa_rounded_rect
        self.screen.blit(aa_rounded_rect(track.w, track.h, seg_h / 2.0, (255, 255, 255), int(22 * at)), track.topleft)
        self.screen.blit(aa_rounded_rect(track.w, track.h, seg_h / 2.0, (255, 255, 255), int(70 * at), 1), track.topleft)
        hx = int(round(self._mode_slide * seg_w))
        hl = aa_rounded_rect(seg_w - 6, seg_h - 6, (seg_h - 6) / 2.0, (235, 235, 245), int(255 * at))
        self.screen.blit(hl, (track.x + hx + 3, track.y + 3))
        for i, m in enumerate(self.MODES):
            on = 1.0 - min(1.0, abs(self._mode_slide - i))       # how much the highlight sits under this one
            col = tuple(int(c) for c in (
                (20, 20, 30) if on > 0.5 else ((230, 230, 240) if self._mode_hover == i else (170, 172, 195))))
            lbl = self._mode_font.render(self.MODE_LABELS[m], True, col)
            _blit_a(lbl, lbl.get_rect(center=self._mode_rects[i].center))
        blurb = self._blurb_font.render(self.MODE_BLURB[self.mode], True, (140, 142, 165))
        _blit_a(blurb, blurb.get_rect(center=(left_cx, track.bottom + 16)))

        # Right half: best score (canon) or BPM input (custom)
        right_cx = fpx + fpw * 3 // 4
        if self.is_custom and self._bpm_input is not None:
            lbl_surf = self._sub_font.render("BPM", True, (110, 200, 170))
            _blit_a(lbl_surf, lbl_surf.get_rect(
                center=(right_cx, self._body_cy - int(self._ph * 0.10))
            ))
            self._bpm_input.draw(self.screen, _current_time)
        else:
            sub_surf = self._sub_font.render("Best", True, (110, 170, 230))
            _blit_a(sub_surf, sub_surf.get_rect(
                center=(right_cx, self._body_cy - int(self._ph * 0.10))
            ))
            top    = self._top_score()
            s_surf = self._big_font.render(
                f"{top:,}" if top is not None else "- -", True, (255, 255, 255)
            )
            _blit_a(s_surf, s_surf.get_rect(center=(right_cx, self._body_cy + int(self._ph * 0.06))))

        # Rule above play button
        pygame.draw.line(
            self.screen,
            (int(50 * at), int(50 * at), int(60 * at)),
            (fpx + pad, self._body_bottom),
            (fpx + fpw - pad, self._body_bottom), 1,
        )

        # Play button
        bw = max(1, int(self._play_rect.w * self._play_scale))
        bh = max(1, int(self._play_rect.h * self._play_scale))
        br = pygame.Rect(
            self._play_rect.centerx - bw // 2,
            self._play_rect.centery - bh // 2,
            bw, bh,
        )
        btn_col   = (255, 255, 255) if self._play_hovered else (190, 190, 210)
        btn_col_a = tuple(int(c * at) for c in btn_col)
        pygame.draw.rect(self.screen, (0, 0, 0), br, border_radius=8)
        pygame.draw.rect(self.screen, btn_col_a, br, 2, border_radius=8)
        p_surf = self._btn_font.render("PLAY", True, btn_col)
        _blit_a(p_surf, p_surf.get_rect(center=br.center))

    # ── Private helpers ───────────────────────────────────────────────────────

    def _handle_input(self, mouse_pos, mouse_clicked) -> str | None:
        self._play_hovered  = self._play_rect.collidepoint(mouse_pos)
        self._close_hovered = self._close_rect.collidepoint(mouse_pos)
        self._mode_hover = next((i for i, r in enumerate(self._mode_rects) if r.collidepoint(mouse_pos)), -1)

        if mouse_clicked:
            if self._play_hovered:
                # capture BPM value before launching
                if self._bpm_input is not None:
                    raw = self._bpm_input.text.strip()
                    self.bpm = int(raw) if raw.isdigit() and int(raw) > 0 else None
                return "play"
            if self._close_hovered or not self.rect.collidepoint(mouse_pos):
                self._closing = True
                return None
            if self._left_arrow_rect and self._left_arrow_rect.collidepoint(mouse_pos):
                self._diff_go(-1)
            elif self._right_arrow_rect and self._right_arrow_rect.collidepoint(mouse_pos):
                self._diff_go(1)
            else:
                for i, r in enumerate(self._mode_rects):
                    if r.collidepoint(mouse_pos):
                        self.mode = self.MODES[i]
                        break

        return None

    def _diff_go(self, direction: int) -> None:
        """Advance difficulty by ±1 with wrap-around and slide animation."""
        self._diff_prev_label    = DifficultySelector.LABELS[self._diff.selected].upper()
        self._diff_prev_color    = DifficultySelector.COLORS[self._diff.selected]
        self._diff_prev_slide    = 0.0
        self._diff_prev_exit_dir = -direction   # outgoing exits opposite to the click
        self._diff.selected = (self._diff.selected + direction) % len(DifficultySelector.KEYS)
        self._diff_slide = direction * self._diff_slide_max  # incoming enters from click side

    def _update_animation(self, dt: float):
        """Advance open/close elapsed time and lerp the play-button scale."""
        if self._closing:
            self._close_elapsed += dt
        else:
            self._open_elapsed += dt

        target = 1.05 if self._play_hovered else 1.0
        self._play_scale += (target - self._play_scale) * min(1.0, BTN_LERP_HOVER * dt)
        self._mode_slide += (float(self.MODES.index(self.mode)) - self._mode_slide) * min(1.0, BTN_LERP_FAST * dt)

        # Advance difficulty slide animation
        spd = min(1.0, BTN_LERP_FAST * dt)
        self._diff_slide += (0.0 - self._diff_slide) * spd
        if abs(self._diff_slide) < 0.5:
            self._diff_slide = 0.0

        if self._diff_prev_label is not None:
            target_prev = self._diff_prev_exit_dir * self._diff_slide_max
            self._diff_prev_slide += (target_prev - self._diff_prev_slide) * spd
            if abs(self._diff_prev_slide - target_prev) < 1.5:
                self._diff_prev_label = None

    def _anim_t(self) -> float:
        """Animation progress: 0 → 1 while opening, 1 → 0 while closing."""
        if self._closing:
            raw = self._close_elapsed / LEVEL_MENU_ANIM_DUR
            t   = min(1.0, raw)
            return 1.0 - t * t
        else:
            raw = self._open_elapsed / LEVEL_MENU_ANIM_DUR
            t   = min(1.0, raw)
            return 1.0 - (1.0 - t) ** 3

    def _top_score(self) -> int | None:
        return self._scores.get(self.song_name, {}).get(self._diff.difficulty)

    @staticmethod
    def _lerp_rect(r1: pygame.Rect, r2: pygame.Rect, t: float) -> pygame.Rect:
        return pygame.Rect(
            int(r1.x + (r2.x - r1.x) * t),
            int(r1.y + (r2.y - r1.y) * t),
            max(1, int(r1.w + (r2.w - r1.w) * t)),
            max(1, int(r1.h + (r2.h - r1.h) * t)),
        )

    @staticmethod
    def _draw_tri(screen, color, cx, cy, direction, w=14, h=22):
        from ..sprites import aa_triangle
        tri = aa_triangle(w, h, color, "left" if direction == "left" else "right")
        screen.blit(tri, tri.get_rect(center=(cx, cy)))
