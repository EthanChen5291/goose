"""Settings panel — the Simple view: volume, timing, play and Noki rows.

Rounded-rect popup (black bg, white border).  Rows:
  Volume        slider (UI music manager)
  Song volume   slider (music in play)
  Timing        offset ms  ‹ ›
  Speed         approach multiplier ‹ ›
  Key guide     Off · Hints · Keyboard
  Noki          On the line · Corner · Hidden
  Duets         Auto · Off
  Typing tips   On · Off
Every change is saved at once; play reads the file when a song starts.
"""
from __future__ import annotations
import pygame

from ..menu_utils import _FONT
from ..settings import load_settings, save_settings
from ._constants import LEVEL_MENU_ANIM_DUR

_BORD = 2

_ROWS = [
    ("key_guide", "Key guide", ["off", "hints", "keyboard"], {"off": "Off", "hints": "Hints", "keyboard": "Keyboard"}),
    ("noki_placement", "Noki", ["line", "corner", "hidden"], {"line": "On the line", "corner": "Corner", "hidden": "Hidden"}),
    ("duets", "Duets", ["auto", "off"], {"auto": "Auto", "off": "Off"}),
    ("typing_tips", "Typing tips", [True, False], {True: "On", False: "Off"}),
]
_STEPPERS = [
    ("offset_ms", "Timing", -150.0, 150.0, 5.0, lambda v: f"{int(v):+d} ms"),
    ("speed_mult", "Speed", 0.5, 3.0, 0.1, lambda v: f"{v:.1f}×"),
]


class SettingsPanel:
    def __init__(self, screen, music, origin_rect=None):
        self.screen = screen
        self._music = music
        self._settings = load_settings()

        sw, sh = screen.get_size()
        pw = int(sw * 0.46)
        ph = int(sh * 0.74)
        px = (sw - pw) // 2
        py = (sh - ph) // 2
        self.rect = pygame.Rect(px, py, pw, ph)
        self._px, self._py, self._pw, self._ph = px, py, pw, ph

        pad = max(20, pw // 24)
        self._pad = pad
        title_sz = max(24, ph // 14)
        label_sz = max(15, ph // 30)
        self._title_font = pygame.font.Font(_FONT, title_sz)
        self._label_font = pygame.font.Font(_FONT, label_sz)

        # rows geometry
        self._row_h = max(34, int(ph * 0.072))
        self._rows_top = py + int(ph * 0.24)
        self._label_x = px + pad
        self._value_cx = px + pw - pad - int(pw * 0.19)
        self._arrow_gap = int(pw * 0.15)

        # sliders (row 0: UI volume, row 1: song volume)
        self._slider_half_w = int(pw * 0.16)
        self._slider_track_h = 6
        self._slider_knob_r = 9
        self._volume = music.volume if music is not None else 0.75
        self._song_volume = float(self._settings.get("music_volume", 0.8))
        self._dragging: str | None = None

        close_sz = 24
        self._close_rect = pygame.Rect(px + pw - pad - close_sz, py + pad // 2, close_sz, close_sz)
        self._close_hovered = False
        self._overlay = pygame.Surface((sw, sh), pygame.SRCALPHA)
        self._origin = origin_rect.copy() if origin_rect else pygame.Rect(px + pw // 2, py + ph // 2, 0, 0)
        self._open_elapsed = 0.0
        self._close_elapsed = 0.0
        self._closing = False
        self._hit_rects: list[tuple[pygame.Rect, str, int]] = []   # (rect, key, direction)

    # ── Public API ────────────────────────────────────────────────────────────
    def update(self, dt: float, mouse_pos, mouse_clicked) -> str | None:
        self._update_animation(dt)
        if self._closing:
            return "close" if self._close_elapsed >= LEVEL_MENU_ANIM_DUR else None
        return self._handle_input(mouse_pos, mouse_clicked)

    def draw(self) -> None:
        at = self._anim_t()
        cur = self._lerp_rect(self._origin, self.rect, at)
        pad = self._pad
        self._overlay.fill((0, 0, 0, int(155 * at)))
        self.screen.blit(self._overlay, (0, 0))
        pygame.draw.rect(self.screen, (8, 8, 14), cur, border_radius=14)
        pygame.draw.rect(self.screen, (255, 255, 255), cur, _BORD, border_radius=14)
        if at < 0.55:
            return
        content_alpha = min(255, int(255 * (at - 0.55) / 0.45))

        def _blit_a(surf, rect):
            s = surf.copy(); s.set_alpha(content_alpha)
            self.screen.blit(s, rect)

        t_surf = self._title_font.render("SETTINGS", True, (220, 220, 220))
        _blit_a(t_surf, t_surf.get_rect(center=(self._px + self._pw // 2, self._py + int(self._ph * 0.10))))
        rule_y = self._py + int(self._ph * 0.18)
        pygame.draw.line(self.screen, (int(50 * at), int(50 * at), int(60 * at)),
                         (self._px + pad, rule_y), (self._px + self._pw - pad, rule_y), 1)
        xc = (255, 80, 80) if self._close_hovered else (120, 120, 130)
        xc = tuple(int(c * at) for c in xc)
        ccx, ccy = self._close_rect.center
        pygame.draw.line(self.screen, xc, (ccx - 8, ccy - 8), (ccx + 8, ccy + 8), 2)
        pygame.draw.line(self.screen, xc, (ccx + 8, ccy - 8), (ccx - 8, ccy + 8), 2)

        self._hit_rects = []
        y = self._rows_top
        for name, key, val in (("Menu volume", "ui_volume", self._volume), ("Song volume", "music_volume", self._song_volume)):
            self._draw_slider(name, key, val, y, _blit_a)
            y += self._row_h
        for key, label, lo, hi, step, fmt in _STEPPERS:
            self._draw_stepper(label, key, fmt(float(self._settings.get(key, 0))), y, _blit_a)
            y += self._row_h
        for key, label, options, names in _ROWS:
            v = self._settings.get(key, options[0])
            self._draw_stepper(label, key, names.get(v, str(v)), y, _blit_a)
            y += self._row_h
        hint = self._label_font.render("changes apply to the next song", True, (90, 90, 110))
        _blit_a(hint, hint.get_rect(center=(self._px + self._pw // 2, self._py + self._ph - pad)))

    # ── row drawing ──────────────────────────────────────────────────────────
    def _draw_slider(self, name, key, val, y, _blit_a):
        lbl = self._label_font.render(name, True, (160, 160, 180))
        _blit_a(lbl, lbl.get_rect(midleft=(self._label_x, y + self._row_h // 2)))
        cx = self._value_cx
        left, right = cx - self._slider_half_w, cx + self._slider_half_w
        track = pygame.Rect(left, y + self._row_h // 2 - self._slider_track_h // 2, self._slider_half_w * 2, self._slider_track_h)
        pygame.draw.rect(self.screen, (50, 50, 62), track, border_radius=3)
        fw = max(0, int(track.w * val))
        if fw:
            pygame.draw.rect(self.screen, (100, 180, 255), pygame.Rect(track.x, track.y, fw, track.h), border_radius=3)
        kx = int(left + (right - left) * val)
        pygame.draw.circle(self.screen, (200, 200, 235), (kx, track.centery), self._slider_knob_r)
        pygame.draw.circle(self.screen, (255, 255, 255), (kx, track.centery), self._slider_knob_r, 2)
        pct = self._label_font.render(f"{int(val * 100)}%", True, (180, 180, 200))
        _blit_a(pct, pct.get_rect(midleft=(right + 12, track.centery)))
        self._hit_rects.append((pygame.Rect(left - 10, y, right - left + 20, self._row_h), key, 0))

    def _draw_stepper(self, label, key, value_text, y, _blit_a):
        lbl = self._label_font.render(label, True, (160, 160, 180))
        _blit_a(lbl, lbl.get_rect(midleft=(self._label_x, y + self._row_h // 2)))
        cx, cy = self._value_cx, y + self._row_h // 2
        val = self._label_font.render(value_text, True, (235, 235, 245))
        _blit_a(val, val.get_rect(center=(cx, cy)))
        gap = self._arrow_gap
        for d, x in ((-1, cx - gap), (1, cx + gap)):
            pts = [(x + 6 * d, cy), (x - 6 * d, cy - 9), (x - 6 * d, cy + 9)]
            pygame.draw.polygon(self.screen, (170, 170, 190), pts)
            self._hit_rects.append((pygame.Rect(x - 18, cy - 16, 36, 32), key, d))

    # ── input ────────────────────────────────────────────────────────────────
    def _handle_input(self, mouse_pos, mouse_clicked) -> str | None:
        self._close_hovered = self._close_rect.collidepoint(mouse_pos)
        held = pygame.mouse.get_pressed()[0]
        if not held:
            self._dragging = None
        if self._dragging:
            self._drag(self._dragging, mouse_pos)
            return None
        if not mouse_clicked:
            return None
        for rect, key, d in self._hit_rects:
            if rect.collidepoint(mouse_pos):
                if d == 0:
                    self._dragging = key
                    self._drag(key, mouse_pos)
                else:
                    self._step(key, d)
                return None
        if self._close_hovered or not self.rect.collidepoint(mouse_pos):
            self._closing = True
        return None

    def _drag(self, key, mouse_pos):
        left = self._value_cx - self._slider_half_w
        right = self._value_cx + self._slider_half_w
        v = max(0.0, min(1.0, (mouse_pos[0] - left) / max(1, right - left)))
        if key == "ui_volume":
            self._volume = v
            if self._music is not None:
                self._music.volume = v
        else:
            self._song_volume = v
            self._settings = save_settings({"music_volume": v})

    def _step(self, key, d):
        for k, label, lo, hi, step, fmt in _STEPPERS:
            if k == key:
                v = float(self._settings.get(k, 0)) + d * step
                v = max(lo, min(hi, round(v / step) * step))
                self._settings = save_settings({k: v})
                return
        for k, label, options, names in _ROWS:
            if k == key:
                cur = self._settings.get(k, options[0])
                i = options.index(cur) if cur in options else 0
                self._settings = save_settings({k: options[(i + d) % len(options)]})
                return

    def _update_animation(self, dt: float) -> None:
        if self._closing:
            self._close_elapsed += dt
        else:
            self._open_elapsed += dt

    def _anim_t(self) -> float:
        if self._closing:
            t = min(1.0, self._close_elapsed / LEVEL_MENU_ANIM_DUR)
            return 1.0 - t * t
        t = min(1.0, self._open_elapsed / LEVEL_MENU_ANIM_DUR)
        return 1.0 - (1.0 - t) ** 3

    @staticmethod
    def _lerp_rect(r1: pygame.Rect, r2: pygame.Rect, t: float) -> pygame.Rect:
        return pygame.Rect(int(r1.x + (r2.x - r1.x) * t), int(r1.y + (r2.y - r1.y) * t),
                           max(1, int(r1.w + (r2.w - r1.w) * t)), max(1, int(r1.h + (r2.h - r1.h) * t)))
