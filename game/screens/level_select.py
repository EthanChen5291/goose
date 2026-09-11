"""
Level select screen: scrollable song list, Canon / Custom tabs, upload button,
noki character with eye-tracking and lick animations, inline rename flow.

update() is split into focused internal methods:
  _handle_rename_events  — keyboard handling while rename input is open
  _handle_input          — mouse: back button, tab clicks, upload, scrollbar, song rows
  _update_animations     — PNG sequences, lick overlay, eye-tracking
  _update_tab_animation  — tab highlight lerp
  _update_rename_push    — rename slot push / pull animation
  _update_upload_anim    — upload button hover scale
  _update_button_scales  — per-row hover scale lerp

draw() is split into focused private draw methods so it stays readable.
"""
from __future__ import annotations
import math
import os
import random
import pygame

from ..menu_utils import _FONT
from .. import audio_manager as _audio
from ..ui_components import (
    _EXIT_IMG,
    Button,
    TextInput,
    DifficultySelector,
    ImageButton,
    PNGSequenceSprite,
    sequence_union_bbox,
)
from ._constants import (
    LS_LEFT_FRAC, LS_BUTTON_HEIGHT, LS_BUTTON_SPACING,
    LS_SCROLLBAR_W, LS_SCROLLBAR_MARGIN,
    RANKS, TAB_LERP_SPEED,
    MARQUEE_PX_PER_SEC, MARQUEE_PAUSE_SEC,
    RENAME_PUSH_DUR,
    LICK_TIMER_MIN, LICK_TIMER_MAX,
    EYE_TRACK_RATE,
    BTN_LERP_HOVER,
)

_ASSETS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "assets", "images",
)
_ANIMATIONS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "assets", "animations",
)


class LevelSelect:
    def __init__(self, screen, song_names, scores=None, canon_names=None, progress=None):
        self.screen     = screen
        self.song_names = song_names
        self._scores    = scores or {}
        self._canon_set: set[str] = set(canon_names) if canon_names else set(song_names)
        sw, sh = screen.get_size()

        # Fonts
        self.header_font  = pygame.font.Font(_FONT, 60)
        self.button_font  = pygame.font.Font(_FONT, 42)
        self.diff_font    = pygame.font.Font(_FONT, 36)
        self.upload_font1 = pygame.font.Font(_FONT, 96)
        self.upload_font2 = pygame.font.Font(_FONT, 78)
        self._tab_font    = pygame.font.Font(_FONT, 48)
        self._rank_font   = pygame.font.Font(_FONT, 44)
        self._rename_font = pygame.font.Font(_FONT, 42)

        self.button_height  = LS_BUTTON_HEIGHT
        self.button_spacing = LS_BUTTON_SPACING

        # ── Tab state ─────────────────────────────────────────────────────────
        self.list_top    = 148
        self._active_tab = 0
        self._tab_lerp   = 0.0

        # Tab crop on scroll: 0 = full height, 1 = 10% shorter at bottom
        self._tab_crop_t     = 0.0
        _TAB_CROP_SPEED      = 6.0   # lerp speed (units/sec)
        self._TAB_CROP_SPEED = _TAB_CROP_SPEED

        # ── Scrollbar ─────────────────────────────────────────────────────────
        self._sb_w      = LS_SCROLLBAR_W
        self._sb_margin = LS_SCROLLBAR_MARGIN
        self._sb_x      = sw - self._sb_margin - self._sb_w
        self._sb_y      = self.list_top
        self._sb_h      = sh - self.list_top - 20
        self._sb_drag              = False
        self._sb_drag_start_y      = 0
        self._sb_drag_start_offset = 0

        # ── Upload button (left panel) ────────────────────────────────────────
        div_x = int(sw * LS_LEFT_FRAC)
        self.upload_cx = div_x // 2
        self.upload_cy = sh // 2 + int(sh * 0.24)

        tw1 = self.upload_font1.size("Upload")[0]
        tw2 = self.upload_font2.size("A File!")[0]
        th1 = self.upload_font1.get_height()
        th2 = self.upload_font2.get_height()
        gap, pad_x, pad_y = 8, 28, 20
        btn_w = max(tw1, tw2) + pad_x * 2
        btn_h = th1 + gap + th2 + pad_y * 2
        self.upload_rect = pygame.Rect(
            self.upload_cx - btn_w // 2,
            self.upload_cy - btn_h // 2,
            btn_w, btn_h,
        )
        self._upload_hovered = False
        self._upload_scale   = 1.0
        self._upload_line1_y_off = -(th1 + gap + th2) // 2 + th1 // 2
        self._upload_line2_y_off = self._upload_line1_y_off + th1 // 2 + gap + th2 // 2

        # ── Noki character PNG sequences ──────────────────────────────────────
        loop_bottom = self.upload_rect.top + 6
        self._noki_loop_cx = self.upload_cx
        self._mouse_pos    = (sw // 2, sh // 2)
        self._eye_ox       = 0
        self._eye_oy       = 0
        self._eye_track_acc = 0.0
        self._noki_loop_w  = 0
        self._noki_loop_h  = 0

        base_dir   = os.path.join(_ANIMATIONS, "noki_base_loop")
        avail_h    = loop_bottom - 20
        body_scale: tuple[int, int] | None = None
        if os.path.isdir(base_dir):
            first = next(
                (os.path.join(base_dir, f)
                 for f in sorted(os.listdir(base_dir))
                 if f.lower().endswith(".png")),
                None,
            )
            if first:
                tmp = pygame.image.load(first)
                pw, ph = tmp.get_size()
                bh = min(avail_h, ph)
                bw = int(pw * bh / ph) if ph > 0 else pw
                body_scale = (bw, bh)
                self._noki_loop_w = bw
                self._noki_loop_h = bh

        # one crop shared by body, eyes and licks so the overlays stay aligned; frames are
        # cut to it, scaled once and kept as sprite sheets in the user cache
        seq_dirs = [base_dir] + [os.path.join(_ANIMATIONS, n) for n in ("left", "right", "noki_lick1", "noki_lick2")]
        crop = sequence_union_bbox(seq_dirs) if body_scale else None
        self._noki_loop_seq = PNGSequenceSprite(base_dir, fps=30.0, scale=body_scale, crop=crop, progress=progress)
        # Shift noki down so it overlaps the upload button naturally
        self._noki_loop_bottom = loop_bottom + int(sh * 0.13)

        eye_scale = body_scale
        self._leye_seq  = PNGSequenceSprite(seq_dirs[1], fps=30.0, scale=eye_scale, crop=crop, progress=progress)
        self._reye_seq  = PNGSequenceSprite(seq_dirs[2], fps=30.0, scale=eye_scale, crop=crop, progress=progress)
        self._lick1_seq = PNGSequenceSprite(seq_dirs[3], fps=30.0, scale=body_scale, crop=crop, progress=progress)
        self._lick2_seq = PNGSequenceSprite(seq_dirs[4], fps=30.0, scale=body_scale, crop=crop, progress=progress)

        self._lick_playing: bool                   = False
        self._active_lick:  PNGSequenceSprite | None = None
        self._lick_elapsed: float                  = 0.0
        self._lick_duration: float                 = 0.0
        self._lick_timer: float = random.uniform(LICK_TIMER_MIN, LICK_TIMER_MAX)

        # ── Song list (right panel) ────────────────────────────────────────────
        rank_char_w = self._rank_font.size("S")[0]
        rank_col_w  = rank_char_w + 24
        self._rank_cx = self._sb_x - self._sb_margin - rank_col_w // 2 - 4

        self.btn_x = div_x + 20
        self.btn_w = self._rank_cx - rank_col_w // 2 - 24 - self.btn_x
        self.diff_cx = self._rank_cx   # preserved for backward compatibility

        push_amount             = (self.button_height + self.button_spacing) * 0.75
        self._rename_push_px    = push_amount

        # ── Back button ───────────────────────────────────────────────────────
        btn_sz = 52
        self.back_button     = ImageButton(30 + btn_sz // 2, 30 + btn_sz // 2, btn_sz, _EXIT_IMG)

        # song list, rename and scroll state: everything that depends on the songs or scores
        self.reset(song_names, self._scores, canon_names)

        # ── Tab rects ─────────────────────────────────────────────────────────
        tab_panel_x = div_x + 1
        tab_panel_w = sw - tab_panel_x
        self._tab_labels = ["Canon", "Custom"]
        self._tab_rects: list[pygame.Rect] = []
        self._tab_div_x       = div_x
        self._tab_underline_y = int(self.list_top * 0.75) + int(sh * 0.03)
        tab_top = 8 + int(sh * 0.03)
        tab_h   = self._tab_underline_y - tab_top
        self._tab_full_h  = tab_h          # natural height, never mutated
        self._tab_top     = tab_top        # top edge, never mutated
        tab_w   = min(int(tab_panel_w * 0.38), 325)
        tab_gap = 10
        tabs_left = tab_panel_x + (tab_panel_w - (2 * tab_w + tab_gap)) // 2
        for t in range(2):
            self._tab_rects.append(pygame.Rect(
                tabs_left + t * (tab_w + tab_gap), tab_top, tab_w, tab_h,
            ))

    def reset(self, song_names=None, scores=None, canon_names=None) -> None:
        """Refresh the song list, scores and transient state without reloading the sprites.

        Returning from a level and finishing an upload call this instead of rebuilding
        the screen: the Noki sequences are the expensive part and never change.
        """
        if song_names is not None:
            self.song_names = song_names
        if scores is not None:
            self._scores = scores
        if canon_names is not None:
            self._canon_set = set(canon_names)
        self._full_names = []
        self.level_buttons = []
        self.difficulty_selectors = []
        self._tab_indices = [[], []]
        for i, name in enumerate(self.song_names):
            display = os.path.splitext(name)[0]
            self._full_names.append(display)
            btn_y = self.list_top + i * (self.button_height + self.button_spacing)
            self.level_buttons.append(Button(
                (self.btn_x, btn_y, self.btn_w, self.button_height),
                display, self.button_font,
            ))
            self.difficulty_selectors.append(
                DifficultySelector(self._rank_cx, btn_y + self.button_height // 2, self.diff_font)
            )
            self._tab_indices[0 if name in self._canon_set else 1].append(i)
        self._recompute_max_scrolls()
        # rename, tabs, scroll and hover state start fresh
        self._rename_idx = None
        self._rename_input = None
        self._rename_result = (0, "")
        self._rename_push_t = 0.0
        self._rename_push_dir = 0      # +1 opening, -1 closing, 0 idle
        self._rename_push_elapsed = 0.0
        self._scroll_offsets = [0, 0]
        self._active_tab = 0
        self._tab_lerp = 0.0
        self._tab_crop_t = 0.0
        self._sb_drag = False
        self._upload_hovered = False
        self._upload_scale = 1.0

    # ── Tab crop helpers ──────────────────────────────────────────────────────

    @property
    def _tab_current_h(self) -> int:
        """Live tab height after scroll-crop is applied (full → 90 % at max crop)."""
        return max(1, int(self._tab_full_h * (1.0 - 0.10 * self._tab_crop_t)))

    @property
    def _list_top_vis(self) -> int:
        """Y coordinate where the song list clip and hit-test begin (moves with tab crop)."""
        return self._tab_top + self._tab_current_h + 2   # +2 for underline

    # ── Scroll helpers (used by MenuManager) ──────────────────────────────────

    def _recompute_max_scrolls(self, sh=None):
        if sh is None:
            sh = self.screen.get_height()
        viewport = sh - self.list_top - 40
        self._max_scrolls = [
            max(0, len(self._tab_indices[t]) * (self.button_height + self.button_spacing) - viewport)
            for t in range(2)
        ]

    @property
    def max_scroll(self) -> int:
        return self._max_scrolls[self._active_tab]

    @property
    def scroll_offset(self) -> int:
        return self._scroll_offsets[self._active_tab]

    @scroll_offset.setter
    def scroll_offset(self, v: int):
        self._scroll_offsets[self._active_tab] = max(0, min(v, self._max_scrolls[self._active_tab]))

    def switch_tab(self, tab: int):
        if tab != self._active_tab:
            self._active_tab = tab

    def handle_scroll(self, event):
        if event.type == pygame.MOUSEWHEEL:
            self.scroll_offset -= event.y * 30
        elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
            self._sb_drag = False
        elif event.type == pygame.MOUSEMOTION and self._sb_drag:
            dy = event.pos[1] - self._sb_drag_start_y
            ms = self.max_scroll
            if self._sb_h > 0 and ms > 0:
                self.scroll_offset = self._sb_drag_start_offset + int(
                    dy * 0.9 * ms / self._sb_h
                )

    def begin_rename(self, idx: int):
        """Start an inline rename for slot *idx* and animate songs below it downward."""
        self._rename_idx = idx
        btn  = self.level_buttons[idx]
        rect = pygame.Rect(btn.rect.x + 8, btn.rect.y + 8,
                           btn.rect.w - 16, btn.rect.h - 16)
        self._rename_input = TextInput(rect, self._rename_font, placeholder="Enter song name…")
        self._rename_input.active = True
        self.scroll_offset = 0
        self._rename_push_dir     = 1
        self._rename_push_elapsed = 0.0

    def cancel_rename_anim(self):
        """Start the close animation (songs lerp back up)."""
        self._rename_push_dir     = -1
        self._rename_push_elapsed = 0.0

    # ── Public update / draw ──────────────────────────────────────────────────

    def update(self, dt: float, mouse_pos, mouse_clicked, _current_time, events=None):
        """
        Returns (action, index).
        action is one of: "back", "upload", "select", "rename", "cancel_upload", or None.
        """
        self._mouse_pos = mouse_pos

        # While rename input is open, forward keyboard events and block mouse
        if self._rename_input is not None and events is not None:
            result = self._handle_rename_events(events)
            if result is not None:
                return result
            return None, -1

        result = self._handle_input(mouse_pos, mouse_clicked)
        if result is not None:
            return result

        self._update_animations(dt)
        self._update_tab_animation(dt)
        self._update_rename_push(dt)
        self._update_upload_anim(dt, mouse_pos)
        self._update_button_scales(dt)
        return None, -1

    def draw(self, current_time: float):
        sw, sh = self.screen.get_size()
        div_x  = int(sw * LS_LEFT_FRAC)

        self.back_button.draw(self.screen, current_time)
        self._draw_divider(sh, div_x)
        self._draw_upload_button()
        self._draw_noki()
        self._draw_tabs(sw)
        self._draw_song_list(sw, sh, div_x, current_time)
        self._draw_scrollbar()

    # ── Private update sub-methods ────────────────────────────────────────────

    def _handle_rename_events(self, events) -> tuple | None:
        """
        Process keyboard events while the rename TextInput is open.
        Returns an action tuple on completion, or None to stay in rename mode.
        """
        for ev in events:
            if ev.type != pygame.KEYDOWN:
                continue
            if ev.key == pygame.K_RETURN:
                result = self._finish_rename()
                if result is not None:
                    self._rename_result = result
                    return "rename", result[0]
                return None   # blank name — rename cleared, next frame proceeds normally
            elif ev.key == pygame.K_ESCAPE:
                cancel_idx         = self._rename_idx if self._rename_idx is not None else -1
                self._rename_idx   = None
                self._rename_input = None
                self.cancel_rename_anim()
                return "cancel_upload", cancel_idx
            elif ev.key == pygame.K_BACKSPACE:
                self._rename_input.text = self._rename_input.text[:-1]
            elif ev.unicode.isprintable():
                if len(self._rename_input.text) < 80:
                    self._rename_input.text += ev.unicode
        return None

    def _handle_input(self, mouse_pos, mouse_clicked) -> tuple | None:
        """Handle back button, tab clicks, upload click, scrollbar, and song row clicks."""
        if self.back_button.update(mouse_pos, mouse_clicked):
            return "back", -1

        if mouse_clicked:
            for t, tr in enumerate(self._tab_rects):
                if tr.collidepoint(mouse_pos):
                    if t != self._active_tab:
                        _audio.play_click()
                    self.switch_tab(t)

        self._upload_hovered = self.upload_rect.collidepoint(mouse_pos)
        if mouse_clicked and self._upload_hovered:
            return "upload", -1

        # Scrollbar click / drag start
        ms = self.max_scroll
        if mouse_clicked and ms > 0:
            thumb = self._sb_thumb_rect()
            if thumb and thumb.collidepoint(mouse_pos):
                self._sb_drag              = True
                self._sb_drag_start_y      = mouse_pos[1]
                self._sb_drag_start_offset = self.scroll_offset
            else:
                track = pygame.Rect(self._sb_x, self._sb_y, self._sb_w, self._sb_h)
                if track.collidepoint(mouse_pos):
                    t = (mouse_pos[1] - self._sb_y) / self._sb_h
                    self.scroll_offset = int(t * ms)

        # Song row hit-testing — rows obscured by the tab area are not interactive
        row_h        = self.button_height + self.button_spacing
        list_top_vis = self._list_top_vis
        for row, song_i in enumerate(self._tab_indices[self._active_tab]):
            btn      = self.level_buttons[song_i]
            row_y    = self.list_top + row * row_h - self.scroll_offset
            btn_rect = pygame.Rect(btn.rect.x, row_y, btn.rect.w, btn.rect.h)
            # Block interaction for rows still behind the tab / underline area
            if btn_rect.bottom <= list_top_vis:
                btn.is_hovered    = False
                btn._target_scale = 1.0
                continue
            hovered  = btn_rect.collidepoint(mouse_pos)
            btn.is_hovered    = hovered
            btn._target_scale = 1.08 if hovered else 1.0
            if hovered and mouse_clicked:
                return "select", song_i

        return None

    def _update_animations(self, dt: float):
        """Advance noki PNG sequences, lick overlay, and eye-tracking."""
        self._noki_loop_seq.advance(dt)
        self._leye_seq.advance(dt)
        self._reye_seq.advance(dt)

        # Lick overlay: count down, then play one random lick animation once
        if self._lick_playing and self._active_lick is not None:
            self._active_lick.advance(dt)
            self._lick_elapsed += dt
            if self._lick_elapsed >= self._lick_duration:
                self._lick_playing = False
                self._active_lick  = None
                self._lick_timer   = random.uniform(LICK_TIMER_MIN, LICK_TIMER_MAX)
        else:
            self._lick_timer -= dt
            if self._lick_timer <= 0.0:
                candidates = [s for s in (self._lick1_seq, self._lick2_seq) if s.ready]
                if candidates:
                    seq = random.choice(candidates)
                    seq._idx          = 0
                    seq._acc          = 0.0
                    self._active_lick  = seq
                    self._lick_duration = len(seq._frames) / seq.fps
                    self._lick_elapsed  = 0.0
                    self._lick_playing  = True

        # Eye tracking — update at EYE_TRACK_RATE fps
        self._eye_track_acc += dt
        if self._eye_track_acc >= 1.0 / EYE_TRACK_RATE:
            self._eye_track_acc = 0.0
            self._update_eye_offset()

    def _update_eye_offset(self):
        """Compute eye pupil offset toward the current mouse position."""
        if self._noki_loop_h <= 0:
            return
        sh       = self.screen.get_height()
        radius   = sh * 0.01
        img_top  = self._noki_loop_bottom - self._noki_loop_h
        eye_cx   = float(self._noki_loop_cx)
        eye_cy   = img_top + self._noki_loop_h * (1.0 - 0.66)
        dx       = self._mouse_pos[0] - eye_cx
        dy       = self._mouse_pos[1] - eye_cy
        dist     = (dx * dx + dy * dy) ** 0.5
        if dist > 0:
            sf = min(1.0, radius / dist)
            self._eye_ox = int(dx * sf)
            self._eye_oy = int(dy * sf)
        else:
            self._eye_ox, self._eye_oy = 0, 0

    def _update_tab_animation(self, dt: float):
        target = float(self._active_tab)
        self._tab_lerp += (target - self._tab_lerp) * min(1.0, TAB_LERP_SPEED * dt)

        # Crop the tab bottom when the list is scrolled down; restore when back at top
        crop_target = 1.0 if self.scroll_offset > 4 else 0.0
        self._tab_crop_t += (crop_target - self._tab_crop_t) * min(1.0, self._TAB_CROP_SPEED * dt)

    def _update_rename_push(self, dt: float):
        """Smoothstep songs below the rename slot down (+1) or back up (-1)."""
        if self._rename_push_dir == 0:
            return
        self._rename_push_elapsed += dt
        raw  = self._rename_push_elapsed / RENAME_PUSH_DUR
        t    = min(1.0, max(0.0, raw))
        ease = t * t * (3.0 - 2.0 * t)   # smoothstep
        if self._rename_push_dir == 1:
            self._rename_push_t = ease
        else:
            self._rename_push_t = 1.0 - ease
            if t >= 1.0:
                self._rename_push_dir = 0

    def _update_upload_anim(self, dt: float, mouse_pos):
        target = 1.05 if self.upload_rect.collidepoint(mouse_pos) else 1.0
        self._upload_scale += (target - self._upload_scale) * min(1.0, BTN_LERP_HOVER * dt)

    def _update_button_scales(self, dt: float):
        """Lerp each song-row button toward its hover / rest scale target."""
        k = min(1.0, BTN_LERP_HOVER * dt)
        for btn in self.level_buttons:
            btn._scale += (btn._target_scale - btn._scale) * k

    # ── Private draw sub-methods ──────────────────────────────────────────────

    def _draw_divider(self, sh, div_x):
        surf = pygame.Surface((2, sh), pygame.SRCALPHA)
        surf.fill((255, 255, 255, 18))
        self.screen.blit(surf, (div_x, 0))

    def _draw_upload_button(self):
        sc   = self._upload_scale
        bw   = int(self.upload_rect.w * sc)
        bh   = int(self.upload_rect.h * sc)
        rect = pygame.Rect(self.upload_cx - bw // 2, self.upload_cy - bh // 2, bw, bh)
        pink = (255, 75, 160)

        if self._upload_hovered:
            pygame.draw.rect(self.screen, (180, 0, 90), rect.inflate(10, 10), 4, border_radius=24)
        pygame.draw.rect(self.screen, pink, rect, 3, border_radius=20)

        for font, text, y_off in (
            (self.upload_font1, "Upload",  self._upload_line1_y_off),
            (self.upload_font2, "A File!", self._upload_line2_y_off),
        ):
            s = font.render(text, True, pink)
            if sc != 1.0:
                s = pygame.transform.smoothscale(
                    s, (max(1, int(s.get_width() * sc)), max(1, int(s.get_height() * sc)))
                )
            cy = self.upload_cy + int(y_off * sc)
            self.screen.blit(s, s.get_rect(center=(self.upload_cx, cy)))

    def _draw_noki(self):
        """Draw the noki body, lick overlay, and eye overlays."""
        sc       = self._upload_scale
        bh       = int(self.upload_rect.h * sc)
        btn_lift = (bh - self.upload_rect.h) // 2
        noki_y   = self._noki_loop_bottom - btn_lift

        # Body (hidden while lick plays)
        if not self._lick_playing:
            self._blit_seq(self._noki_loop_seq, self._noki_loop_cx, noki_y)

        # Lick overlay (replaces body + eyes)
        if self._lick_playing and self._active_lick is not None:
            self._blit_seq(self._active_lick, self._noki_loop_cx, noki_y)

        # Eye overlays (hidden while lick plays)
        if not self._lick_playing:
            for seq in (self._leye_seq, self._reye_seq):
                self._blit_seq(seq, self._noki_loop_cx + self._eye_ox, noki_y + self._eye_oy)

    def _blit_seq(self, seq, cx: float, bottom: float) -> None:
        """Blit a sequence's frame as if the full (uncropped) frame sat with its midbottom at (cx, bottom)."""
        surf = seq.current
        if surf is None:
            return
        fw, fh = seq.full_size or surf.get_size()
        ox, oy = seq.offset
        self.screen.blit(surf, (int(cx - fw // 2 + ox), int(bottom - fh + oy)))

    def _draw_tabs(self, sw):
        # Live bottom edge of the tab (crops upward as scroll_offset increases)
        cur_h  = self._tab_current_h
        ul_y   = self._tab_top + cur_h   # underline follows the cropped bottom
        radius = 12

        def _chrome_tab(surf, rect, bg_col, bord_col):
            """Rounded top corners, flat / open bottom."""
            x, y, w, h = rect.x, rect.y, rect.width, rect.height
            r = min(radius, h // 2)
            pygame.draw.rect(surf, bg_col, rect, border_radius=r)
            pygame.draw.rect(surf, bg_col, pygame.Rect(x, y + h - r, w, r))
            pts: list[tuple[float, float]] = [
                (x, y + h),
                (x, y + r),
            ]
            for i in range(11):
                a = math.pi + i * (math.pi / 2) / 10
                pts.append((x + r + r * math.cos(a), y + r + r * math.sin(a)))
            for i in range(11):
                a = -math.pi / 2 + i * (math.pi / 2) / 10
                pts.append((x + w - r + r * math.cos(a), y + r + r * math.sin(a)))
            pts += [(x + w, y + r), (x + w, y + h)]
            if len(pts) >= 2:
                pygame.draw.lines(surf, bord_col, False, pts, 2)

        for t, (tr, label) in enumerate(zip(self._tab_rects, self._tab_labels)):
            hi       = (1.0 - self._tab_lerp) if t == 0 else self._tab_lerp
            bg_r     = int(18 + 40 * hi)
            bg_col   = (bg_r, bg_r, bg_r + 10)
            bord_col = (int(55 + 130 * hi),) * 3
            # Use a cropped rect so the tab shrinks from the bottom
            draw_rect = pygame.Rect(tr.x, tr.y, tr.w, cur_h)
            _chrome_tab(self.screen, draw_rect, bg_col, bord_col)
            txt_col = (int(170 + 85 * hi),) * 3
            ts = self._tab_font.render(label, True, txt_col)
            self.screen.blit(ts, ts.get_rect(center=draw_rect.center))

        # Full-width underline (tracks cropped bottom)
        pygame.draw.line(self.screen, (70, 70, 80), (self._tab_div_x, ul_y), (sw, ul_y), 2)

        # Erase the underline segment under the active tab to look "open"
        ai      = int(round(self._tab_lerp))
        atr     = self._tab_rects[ai]
        hi_a    = (1.0 - self._tab_lerp) if ai == 0 else self._tab_lerp
        er      = int(18 + 40 * hi_a)
        e_col   = (er, er, er + 10)
        pygame.draw.line(self.screen, e_col, (atr.left + 3, ul_y), (atr.right - 3, ul_y), 3)

    def _draw_song_list(self, sw, sh, div_x, current_time):
        list_top_vis   = self._list_top_vis
        scroll_clip    = pygame.Rect(div_x + 1, list_top_vis, sw, sh - list_top_vis)
        self.screen.set_clip(scroll_clip)

        push_offset    = int(self._rename_push_px * self._rename_push_t)
        rename_row     = self._rename_idx if self._rename_idx is not None else -1
        row_h          = self.button_height + self.button_spacing
        active_indices = self._tab_indices[self._active_tab]

        # Empty custom-tab message
        if self._active_tab == 1 and not active_indices:
            empty_font = pygame.font.Font(_FONT, 52)
            empty_surf = empty_font.render("No levels uploaded", True, (120, 120, 130))
            self.screen.blit(empty_surf, empty_surf.get_rect(
                center=(div_x + (sw - div_x) // 2,
                        self.list_top + (sh - self.list_top) // 2)
            ))

        for row, i in enumerate(active_indices):
            btn   = self.level_buttons[i]
            extra = push_offset if i > rename_row else 0
            vis_y = self.list_top + row * row_h - self.scroll_offset + extra

            if btn.is_hovered:
                glow = pygame.Rect(btn.rect.x, vis_y, btn.rect.w, btn.rect.h).inflate(8, 8)
                pygame.draw.rect(self.screen, (80, 80, 100), glow, 2, border_radius=8)

            is_renaming = (self._rename_input is not None and self._rename_idx == i)
            if is_renaming:
                self._draw_rename_input(btn, i, vis_y, current_time)
            else:
                self._draw_song_name(btn, i, vis_y, current_time)
                rank = self._best_rank(self.song_names[i])
                if rank is not None:
                    letter, color = rank
                    r_surf = self._rank_font.render(letter, True, color)
                    self.screen.blit(r_surf, r_surf.get_rect(
                        center=(self._rank_cx, vis_y + self.button_height // 2)
                    ))

        self.screen.set_clip(None)

    def _draw_song_name(self, btn, i, vis_y, current_time):
        """Render the song title with marquee scrolling if it overflows."""
        color     = btn.hover_color if btn.is_hovered else btn.base_color
        text_surf = btn.font.render(self._full_names[i], True, color)
        tw        = text_surf.get_width()
        pad       = 10
        clip_w    = btn.rect.w - pad
        text_y    = vis_y + (btn.rect.h - text_surf.get_height()) // 2

        if tw > clip_w:
            max_off  = tw - clip_w
            scroll_t = max_off / MARQUEE_PX_PER_SEC
            cycle    = MARQUEE_PAUSE_SEC + scroll_t + MARQUEE_PAUSE_SEC + scroll_t
            t        = (current_time + i * 0.4) % cycle
            if t < MARQUEE_PAUSE_SEC:
                x_off = 0
            elif t < MARQUEE_PAUSE_SEC + scroll_t:
                x_off = int((t - MARQUEE_PAUSE_SEC) * MARQUEE_PX_PER_SEC)
            elif t < MARQUEE_PAUSE_SEC + scroll_t + MARQUEE_PAUSE_SEC:
                x_off = max_off
            else:
                x_off = int(max_off - (t - MARQUEE_PAUSE_SEC - scroll_t - MARQUEE_PAUSE_SEC) * MARQUEE_PX_PER_SEC)
            draw_x = btn.rect.x + pad - x_off
        else:
            draw_x = btn.rect.x + (btn.rect.w - tw) // 2

        text_clip = pygame.Rect(btn.rect.x + pad, vis_y, clip_w, btn.rect.h)
        old_clip  = self.screen.get_clip()
        self.screen.set_clip(text_clip.clip(old_clip))
        self.screen.blit(text_surf, (draw_x, text_y))
        self.screen.set_clip(old_clip)

    def _draw_rename_input(self, btn, i, vis_y, current_time):
        """Render the inline rename text box with a blinking cursor."""
        inp = self._rename_input
        cx  = btn.rect.x + btn.rect.w // 2
        cy  = vis_y + btn.rect.h // 2
        th  = self._rename_font.get_height()

        tsurf = self._rename_font.render(inp.text, True, (255, 255, 255)) if inp.text else None
        if tsurf is not None:
            old_clip  = self.screen.get_clip()
            slot_clip = pygame.Rect(btn.rect.x, vis_y, btn.rect.w, btn.rect.h)
            self.screen.set_clip(slot_clip.clip(old_clip))
            self.screen.blit(tsurf, tsurf.get_rect(center=(cx, cy)))
            self.screen.set_clip(old_clip)

        # Blinking cursor
        if int(current_time * 2) % 2 == 0:
            tw_half = (tsurf.get_width() // 2) if tsurf else 0
            cur_x   = min(cx + tw_half + 4, btn.rect.x + btn.rect.w - 6)
            cur_h   = int(th * 0.85)
            pygame.draw.line(self.screen, (200, 200, 255),
                             (cur_x, cy - cur_h // 2), (cur_x, cy + cur_h // 2), 3)

    def _draw_scrollbar(self):
        if self.max_scroll <= 0:
            return
        pygame.draw.rect(self.screen, (45, 45, 55),
                         (self._sb_x, self._sb_y, self._sb_w, self._sb_h),
                         border_radius=3)
        thumb = self._sb_thumb_rect()
        if thumb:
            color = (160, 160, 185) if self._sb_drag else (110, 110, 135)
            pygame.draw.rect(self.screen, color, thumb, border_radius=3)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _sb_thumb_rect(self) -> pygame.Rect | None:
        ms = self.max_scroll
        if ms <= 0:
            return None
        n = len(self._tab_indices[self._active_tab])
        if n == 0:
            return None
        viewport_h = self._sb_h
        total_h    = n * (self.button_height + self.button_spacing)
        thumb_h    = max(24, int(viewport_h * viewport_h / total_h))
        thumb_y    = self._sb_y + int((viewport_h - thumb_h) * self.scroll_offset / ms)
        return pygame.Rect(self._sb_x, thumb_y, self._sb_w, thumb_h)

    _GRADE_ORDER = ["SS", "S", "A", "B", "C", "D"]

    def _best_rank(self, song_name: str) -> tuple[str, tuple] | None:
        """Return (letter, color) for the best run across all difficulties.

        New runs store "<difficulty>_stats" with a grade by accuracy; that grade wins.
        Scores from before normalized scoring are on another scale, so they only earn
        a dash ("played"), never a letter they did not reach.
        """
        song_scores = self._scores.get(song_name, {})
        grades = [v.get("grade") for v in song_scores.values()
                  if isinstance(v, dict) and v.get("grade") in self._GRADE_ORDER]
        colors = {letter: color for _t, letter, color in RANKS}
        if grades:
            best = min(grades, key=self._GRADE_ORDER.index)
            return best, colors.get(best, colors.get("S", (255, 255, 255)))
        # a score without stats is from before normalized scoring: played, but on another scale
        numeric = [v for v in song_scores.values() if isinstance(v, (int, float))]
        if not numeric or max(numeric) <= 0:
            return None
        return "-", (110, 110, 125)

    def _finish_rename(self) -> tuple[int, str] | None:
        """Commit the rename; returns (idx, new_name) or None for a blank entry."""
        idx, inp          = self._rename_idx, self._rename_input
        self._rename_idx   = None
        self._rename_input = None
        # Snap push animation back immediately
        self._rename_push_t   = 0.0
        self._rename_push_dir = 0
        if idx is None or inp is None:
            return None
        name = inp.text.strip()
        return (idx, name) if name else None
