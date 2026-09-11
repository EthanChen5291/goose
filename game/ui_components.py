"""
Reusable UI widgets for the menu system.
Petal, Button, TextInput, DifficultySelector, ImageButton, PNGSequenceSprite.
"""
import pygame
import math
import os
import random
import time

from .menu_utils import _FONT

_EXIT_IMG = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "assets", "images", "exitbutton.png",
)


# ─── Floating petal background particle ─────────────────────────────────────

class Petal:
    COLORS = [
        (160, 160, 160),
        (210, 210, 210),
        (80,  80,  80),
        (255, 20,  147),
        (140, 210, 255),
    ]

    def __init__(self, sw, sh, randomize_y=True):
        self.sw, self.sh = sw, sh
        self._init(randomize_y)

    def _init(self, randomize_y=True):
        self.x         = random.uniform(0, self.sw)
        self.y         = random.uniform(0, self.sh) if randomize_y else random.uniform(-60, -10)
        self.vx        = random.uniform(-0.35, 0.35)
        self.vy        = random.uniform(0.12, 0.5)
        self.rotation  = random.uniform(0, 360)
        self.rot_speed = random.uniform(-0.7, 0.7)
        self.color     = random.choice(self.COLORS)
        self.alpha     = random.randint(10, 65)
        self.w         = random.randint(5, 16)
        self.h         = random.randint(10, 26)

    def update(self):
        self.x += self.vx
        self.y += self.vy
        self.rotation += self.rot_speed
        if self.y > self.sh + 50:
            self._init(False)
        if self.x < -50:
            self.x = self.sw + 50
        elif self.x > self.sw + 50:
            self.x = -50

    def draw(self, screen):
        surf = pygame.Surface((self.w * 2 + 2, self.h * 2 + 2), pygame.SRCALPHA)
        pygame.draw.ellipse(surf, (*self.color, self.alpha), (1, 1, self.w * 2, self.h * 2))
        rotated = pygame.transform.rotate(surf, self.rotation)
        screen.blit(rotated, rotated.get_rect(center=(int(self.x), int(self.y))))


# ─── Generic text button ─────────────────────────────────────────────────────

class Button:
    def __init__(self, rect, text, font,
                 base_color=(255, 255, 255), hover_color=(200, 220, 255)):
        self.rect          = pygame.Rect(rect)
        self.text          = text
        self.font          = font
        self.base_color    = base_color
        self.hover_color   = hover_color
        self.is_hovered    = False
        self._scale        = 1.0
        self._target_scale = 1.0

    def check_hover(self, mouse_pos):
        self.is_hovered    = self.rect.collidepoint(mouse_pos)
        self._target_scale = 1.08 if self.is_hovered else 1.0

    def check_click(self, mouse_pos, mouse_clicked):
        return mouse_clicked and self.rect.collidepoint(mouse_pos)

    def draw(self, screen, _current_time):
        self._scale += (self._target_scale - self._scale) * 0.18
        color = self.hover_color if self.is_hovered else self.base_color
        if self.is_hovered:
            pygame.draw.rect(screen, (80, 80, 100), self.rect.inflate(8, 8), 2, border_radius=8)
        surf = self.font.render(self.text, True, color)
        sw   = int(surf.get_width()  * self._scale)
        sh   = int(surf.get_height() * self._scale)
        if sw > 0 and sh > 0:
            surf = pygame.transform.smoothscale(surf, (sw, sh))
        screen.blit(surf, surf.get_rect(center=self.rect.center))


# ─── Single-line text input ───────────────────────────────────────────────────

class TextInput:
    def __init__(self, rect, font, placeholder="", max_length=80, numeric_only=False):
        self.rect         = pygame.Rect(rect)
        self.font         = font
        self.placeholder  = placeholder
        self.max_length   = max_length
        self.numeric_only = numeric_only
        self.text         = ""
        self.active       = False

    def handle_events(self, events):
        for event in events:
            if event.type == pygame.MOUSEBUTTONDOWN:
                self.active = self.rect.collidepoint(event.pos)
            if self.active and event.type == pygame.KEYDOWN:
                if event.key == pygame.K_BACKSPACE:
                    self.text = self.text[:-1]
                elif event.key in (pygame.K_RETURN, pygame.K_ESCAPE, pygame.K_TAB):
                    self.active = False
                elif event.unicode.isprintable() and len(self.text) < self.max_length:
                    if self.numeric_only and not event.unicode.isdigit():
                        pass  # ignore non-digit input
                    else:
                        self.text += event.unicode

    def draw(self, screen, current_time):
        bg    = (40, 40, 55)  if self.active else (22, 22, 32)
        bord  = (140, 180, 255) if self.active else (70, 70, 95)
        pygame.draw.rect(screen, bg,   self.rect, border_radius=8)
        pygame.draw.rect(screen, bord, self.rect, 2, border_radius=8)

        display  = self.text if self.text else self.placeholder
        color    = (235, 235, 255) if self.text else (90, 90, 115)
        surf     = self.font.render(display, True, color)
        pad      = 10
        text_x   = self.rect.x + pad
        text_y   = self.rect.centery - surf.get_height() // 2

        # clip text to rect
        old_clip = screen.get_clip()
        screen.set_clip(self.rect.inflate(-4, -4))
        screen.blit(surf, (text_x, text_y))
        screen.set_clip(old_clip)

        # blinking cursor
        if self.active and int(current_time * 2) % 2 == 0:
            cx = text_x + min(self.font.size(self.text)[0], self.rect.w - pad * 2)
            pygame.draw.line(screen, (200, 200, 255),
                             (cx, text_y + 2), (cx, text_y + surf.get_height() - 2), 2)


# ─── Difficulty selector  ◀ Medium ▶ ────────────────────────────────────────

class DifficultySelector:
    LABELS = ["Easy",    "Fair",    "Hard",   "Demon" ]
    KEYS   = ["journey", "classic", "master", "demon" ]
    COLORS = [
        (90,  210,  90),
        (220, 200,  70),
        (220,  85,  85),
        (180,  60, 220),
    ]
    _LERP_SPD = 0.22   # per-frame lerp toward target (0 = instant, 1 = never)

    def __init__(self, center_x, center_y, font):
        self.cx, self.cy = center_x, center_y
        self.font        = font
        self.selected    = 1

        # slide_offset: pixels the current label is displaced from center.
        # Positive = incoming from right, negative = incoming from left.
        self._slide_offset  = 0.0
        self._prev_label: str | None  = None  # label sliding out
        self._prev_color: tuple | None = None
        self._prev_offset   = 0.0            # where the outgoing label is sliding to
        self._left_rect:  pygame.Rect | None = None
        self._right_rect: pygame.Rect | None = None

        self._max_label_w = max(font.size(l)[0] for l in self.LABELS)

    @property
    def difficulty(self) -> str:
        return self.KEYS[self.selected]

    def check_hover(self, _pos):
        pass

    def _go(self, direction: int):
        """Advance selection by +1 (right) or -1 (left), wrapping at ends."""
        n = len(self.LABELS)
        self._prev_label  = self.LABELS[self.selected]
        self._prev_color  = self.COLORS[self.selected]
        self._prev_offset = 0.0
        self.selected = (self.selected + direction) % n
        # incoming label starts off-screen in the opposite direction
        self._slide_offset = -direction * self._max_label_w * 1.1

    def check_click(self, mouse_pos, mouse_clicked) -> bool:
        if not mouse_clicked:
            return False
        if self._left_rect and self._left_rect.collidepoint(mouse_pos):
            self._go(-1)
            return True
        if self._right_rect and self._right_rect.collidepoint(mouse_pos):
            self._go(1)
            return True
        return False

    @staticmethod
    def _draw_arrow(screen, color, cx, cy, direction, w=11, h=16):
        hw, hh = w // 2, h // 2
        if direction == 'left':
            pts = [(cx - hw, cy), (cx + hw, cy - hh), (cx + hw, cy + hh)]
        else:
            pts = [(cx + hw, cy), (cx - hw, cy - hh), (cx - hw, cy + hh)]
        pygame.draw.polygon(screen, color, pts)

    def draw(self, screen, _current_time, y_offset=0):
        spd = self._LERP_SPD
        self._slide_offset += (0.0 - self._slide_offset) * spd
        if abs(self._slide_offset) < 0.5:
            self._slide_offset = 0.0

        # Outgoing label slides further away
        if self._prev_label is not None:
            # direction it's moving: opposite of incoming
            sign = 1 if self._prev_offset <= 0 else -1
            target_prev = sign * self._max_label_w * 1.1
            self._prev_offset += (target_prev - self._prev_offset) * spd
            if abs(self._prev_offset - target_prev) < 1.0:
                self._prev_label = None  # done sliding out

        eff_cy = self.cy - y_offset
        th = self.font.get_height()

        clip_rect = pygame.Rect(
            int(self.cx - self._max_label_w // 2), int(eff_cy - th // 2 - 2),
            self._max_label_w, th + 4,
        )
        old_clip = screen.get_clip()
        screen.set_clip(clip_rect)

        # Draw outgoing label
        if self._prev_label is not None:
            prev_surf = self.font.render(self._prev_label, True, self._prev_color)
            ptw = prev_surf.get_width()
            screen.blit(prev_surf, (int(self.cx + self._prev_offset - ptw // 2), int(eff_cy - th // 2)))

        # Draw incoming (current) label
        label = self.LABELS[self.selected]
        color = self.COLORS[self.selected]
        text_surf = self.font.render(label, True, color)
        tw = text_surf.get_width()
        screen.blit(text_surf, (int(self.cx + self._slide_offset - tw // 2), int(eff_cy - th // 2)))

        screen.set_clip(old_clip)

        arrow_color = (160, 160, 160)
        arrow_gap   = 12
        aw, ah      = 11, 16
        label_left  = self.cx - self._max_label_w // 2
        label_right = self.cx + self._max_label_w // 2

        # Always show both arrows (wrap)
        tip_cx = label_left - arrow_gap - aw // 2
        self._draw_arrow(screen, arrow_color, tip_cx, eff_cy, 'left', aw, ah)
        self._left_rect = pygame.Rect(tip_cx - aw - 4, eff_cy - ah // 2 - 4, aw * 2 + 8, ah + 8)

        tip_cx = label_right + arrow_gap + aw // 2
        self._draw_arrow(screen, arrow_color, tip_cx, eff_cy, 'right', aw, ah)
        self._right_rect = pygame.Rect(tip_cx - aw - 4, eff_cy - ah // 2 - 4, aw * 2 + 8, ah + 8)


# ─── Image button (hover scale + click shrink→bounce) ────────────────────────

class ImageButton:
    """Clickable image that scales on hover and bounces on click."""
    _HOVER_SCALE  = 1.12
    _CLICK_SHRINK = 0.75
    _CLICK_BOUNCE = 1.18
    _LERP_NORMAL  = 0.12
    _LERP_FAST    = 0.25

    def __init__(self, cx: int, cy: int, size: int, image_path: str):
        raw         = pygame.image.load(image_path).convert_alpha()
        self._base  = raw
        self._size  = size
        self.cx     = cx
        self.cy     = cy
        self._scale       = 1.0
        self._click_phase = None   # None | "shrink" | "bounce"
        self.rect = pygame.Rect(cx - size // 2, cy - size // 2, size, size)

    def _hovered(self, mouse_pos) -> bool:
        half = max(1, int(self._size * self._scale)) // 2
        return pygame.Rect(self.cx - half, self.cy - half, half * 2, half * 2).collidepoint(mouse_pos)

    def update(self, mouse_pos, mouse_clicked) -> bool:
        """Returns True on the frame the click fires."""
        hovered = self._hovered(mouse_pos)
        if mouse_clicked and hovered and self._click_phase is None:
            self._click_phase = "shrink"

        if self._click_phase == "shrink":
            self._scale += (self._CLICK_SHRINK - self._scale) * self._LERP_FAST
            if abs(self._scale - self._CLICK_SHRINK) < 0.025:
                self._click_phase = "bounce"
        elif self._click_phase == "bounce":
            self._scale += (self._CLICK_BOUNCE - self._scale) * self._LERP_FAST
            if abs(self._scale - self._CLICK_BOUNCE) < 0.025:
                self._click_phase = None
                self._scale = self._HOVER_SCALE if hovered else 1.0
                return True
        else:
            target = self._HOVER_SCALE if hovered else 1.0
            self._scale += (target - self._scale) * self._LERP_NORMAL
        return False

    def draw(self, screen, _current_time=None):
        disp = max(1, int(self._size * self._scale))
        surf = pygame.transform.smoothscale(self._base, (disp, disp))
        screen.blit(surf, surf.get_rect(center=(self.cx, self.cy)))


# ─── PNG sequence sprite ─────────────────────────────────────────────────────

def _seq_paths(folder: str) -> list[str]:
    if not os.path.isdir(folder):
        return []
    return sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".png"))


def _seq_key(folder: str) -> str:
    try:
        st = os.stat(folder)
        return f"{folder}|{int(st.st_mtime)}|{len(_seq_paths(folder))}"
    except OSError:
        return folder


def sequence_union_bbox(folders: list[str], step: int = 8, pad: float = 0.02) -> pygame.Rect | None:
    """The union alpha bounding box over the frames of every folder (cached on disk).

    Sequences that overlay each other (body, eyes, licks) must share one crop so they
    stay aligned; this is that crop.  Every ``step``-th frame is sampled (plus the first
    and last of each folder) and the result is padded by ``pad`` of the frame size, so
    the first run reads a few dozen source frames, not hundreds.
    """
    import hashlib
    import json
    from .sprites import cache_dir
    key = hashlib.sha1(("|".join(_seq_key(f) for f in folders) + f"|bbox_v2|{step}|{pad}").encode()).hexdigest()[:12]
    p = os.path.join(cache_dir("sprites"), f"bbox_{key}.json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                x, y, w, h = json.load(f)
            return pygame.Rect(x, y, w, h)
        except Exception:
            pass
    union: pygame.Rect | None = None
    frame: pygame.Rect | None = None
    for folder in folders:
        paths = _seq_paths(folder)
        picks = sorted(set(range(0, len(paths), max(1, step))) | ({0, len(paths) - 1} if paths else set()))
        for i in picks:
            surf = pygame.image.load(paths[i])
            frame = surf.get_rect() if frame is None else frame.union(surf.get_rect())
            bb = surf.get_bounding_rect(min_alpha=8)
            union = bb if union is None else union.union(bb)
    if union is not None and frame is not None:
        px, py = int(frame.w * pad), int(frame.h * pad)
        union = union.inflate(2 * px, 2 * py).clip(frame)
        try:
            with open(p, "w", encoding="utf-8") as f:
                json.dump([union.x, union.y, union.w, union.h], f)
        except Exception:
            pass
    return union


class PetalSpinner:
    """The two-petal loading spinner, drawn on demand while something slow builds.

    ``tick(fraction, label)`` draws one frame (rate-limited to ~30 fps), flips, and
    pumps events so the window stays responsive.  Used as a progress callback.
    """

    def __init__(self, screen: pygame.Surface, label: str = "getting Noki ready") -> None:
        self.screen = screen
        self.label = label
        img_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "images")
        self._petals = []
        for name in ("petal1.png", "petal2.png"):
            p = os.path.join(img_dir, name)
            try:
                self._petals.append(pygame.transform.smoothscale(pygame.image.load(p).convert_alpha(), (40, 40)))
            except Exception:
                self._petals.append(None)
        self._t0 = time.perf_counter()
        self._last = 0.0
        try:
            self._font = pygame.font.Font(_FONT, 20)
        except Exception:
            self._font = pygame.font.Font(None, 22)

    @staticmethod
    def _angle(tn: float) -> float:
        if tn < 0.5:
            p = tn / 0.5
            return math.pi / 2 - math.pi * (p * p)
        p = (tn - 0.5) / 0.5
        return -math.pi / 2 - math.pi * (1.0 - (1.0 - p) ** 4)

    def tick(self, fraction: float = 0.0, label: str | None = None) -> None:
        now = time.perf_counter()
        if now - self._last < 1 / 30:
            return
        self._last = now
        el = now - self._t0
        sw, sh = self.screen.get_size()
        cx, cy, radius = sw // 2, sh // 2, 50
        p1 = (60.0 / 45.0) / 0.7
        periods = (p1, p1 * 0.65)
        offsets = (0.0, p1 * 0.65 * 0.375)
        self.screen.fill((6, 5, 11))
        for img, period, off in zip(self._petals, periods, offsets):
            if img is None:
                continue
            for step in (3, 2, 1):
                tp = ((el - 0.045 * step + off) % period) / period
                ga = self._angle(tp)
                g = pygame.transform.rotate(img, math.degrees(ga))
                g.set_alpha([120, 60, 25][step - 1])
                self.screen.blit(g, g.get_rect(center=(int(cx + radius * math.cos(ga)), int(cy - radius * math.sin(ga)))))
            a = self._angle(((el + off) % period) / period)
            r = pygame.transform.rotate(img, math.degrees(a))
            self.screen.blit(r, r.get_rect(center=(int(cx + radius * math.cos(a)), int(cy - radius * math.sin(a)))))
        txt = self._font.render(label or self.label, True, (120, 120, 140))
        self.screen.blit(txt, txt.get_rect(center=(cx, cy + 90)))
        if fraction > 0:
            bar = pygame.Rect(cx - 90, cy + 118, 180, 4)
            pygame.draw.rect(self.screen, (40, 40, 52), bar, border_radius=2)
            pygame.draw.rect(self.screen, (100, 200, 255), (bar.x, bar.y, int(bar.w * min(1.0, fraction)), bar.h), border_radius=2)
        pygame.display.flip()
        pygame.event.pump()


class PNGSequenceSprite:
    """Plays a sorted sequence of transparent PNGs at a fixed FPS.

    Frames are scaled once and kept on disk as a single sprite sheet per sequence
    (plus a JSON sidecar), so the next launch is one image load instead of hundreds
    of full-size decodes and rescales.  With ``crop`` (a rect in source pixels) the
    frames are cut to that rect before scaling; ``offset`` is then where the cropped
    frame's top-left sits inside the full scaled frame, so a caller that positions
    by the full frame blits at ``full_topleft + offset`` and nothing moves on screen.
    Call ``advance(dt)`` each game tick and read ``current`` to get the surface.
    """

    SHEET_VERSION = "v1"

    def __init__(self, folder: str, fps: float = 30.0,
                 scale: tuple[int, int] | None = None,
                 crop: pygame.Rect | None = None,
                 progress=None) -> None:
        self.fps = fps
        self._acc: float = 0.0
        self._idx: int = 0
        self._frames: list[pygame.Surface] = []
        self.offset: tuple[int, int] = (0, 0)
        self.full_size: tuple[int, int] | None = scale

        paths = _seq_paths(folder)
        if not paths:
            return
        if scale is None and crop is None:
            self._frames = [pygame.image.load(p).convert_alpha() for p in paths]
            return
        if not self._load_sheet(folder, paths, scale, crop):
            self._build(folder, paths, scale, crop, progress)

    # ── sheet cache ───────────────────────────────────────────────────────
    def _sheet_paths(self, folder: str, scale, crop) -> tuple[str, str]:
        import hashlib
        from .sprites import cache_dir
        crop_key = f"{crop.x},{crop.y},{crop.w},{crop.h}" if crop is not None else "full"
        key = hashlib.sha1(f"{_seq_key(folder)}|{scale}|{crop_key}|{self.SHEET_VERSION}".encode()).hexdigest()[:12]
        d = cache_dir("sprites", "sheets")
        return os.path.join(d, f"{key}.png"), os.path.join(d, f"{key}.json")

    def _load_sheet(self, folder, paths, scale, crop) -> bool:
        import json
        png, meta_p = self._sheet_paths(folder, scale, crop)
        if not (os.path.exists(png) and os.path.exists(meta_p)):
            return False
        try:
            with open(meta_p, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("n") != len(paths):
                return False
            sheet = pygame.image.load(png).convert_alpha()
            cw, ch, cols = meta["cw"], meta["ch"], meta["cols"]
            self._frames = [sheet.subsurface(pygame.Rect((i % cols) * cw, (i // cols) * ch, cw, ch))
                            for i in range(meta["n"])]
            self.offset = tuple(meta.get("offset", (0, 0)))
            self.full_size = tuple(meta["full"]) if meta.get("full") else scale
            return True
        except Exception:
            self._frames = []
            return False

    def _build(self, folder, paths, scale, crop, progress=None) -> None:
        """One pass over the source frames: crop, scale, convert; the sheet is saved in the background."""
        import json
        import math
        import threading
        from concurrent.futures import ThreadPoolExecutor
        n = len(paths)
        state = {"offset": (0, 0)}

        def prep(path):
            """Decode, crop and scale one frame (pygame releases the GIL in the C calls)."""
            surf = pygame.image.load(path)               # convert only the small result, on the main thread
            sw, sh = surf.get_size()
            r = surf.get_rect()
            if crop is not None:
                r = crop.clip(surf.get_rect())
                surf = surf.subsurface(r)
            if scale is not None:
                sx, sy = scale[0] / max(1, sw), scale[1] / max(1, sh)
                if crop is not None:
                    tw, th = max(1, int(round(r.w * sx))), max(1, int(round(r.h * sy)))
                    state["offset"] = (int(round(r.x * sx)), int(round(r.y * sy)))
                else:
                    tw, th = scale
                surf = pygame.transform.smoothscale(surf, (tw, th))
            return surf

        frames: list[pygame.Surface] = []
        with ThreadPoolExecutor(max_workers=max(2, min(6, (os.cpu_count() or 4) - 1))) as pool:
            for i, surf in enumerate(pool.map(prep, paths)):
                frames.append(surf.convert_alpha())
                if progress is not None and i % 3 == 0:
                    progress((i + 1) / n)
        self._frames = frames
        self.offset = state["offset"]
        if not frames:
            return
        # pack into one sheet and write it on a thread: it is only for the next launch
        cw, ch = frames[0].get_size()
        cols = max(1, int(math.ceil(math.sqrt(n))))
        rows = int(math.ceil(n / cols))
        try:
            sheet = pygame.Surface((cols * cw, rows * ch), pygame.SRCALPHA)
            for i, fr in enumerate(frames):
                sheet.blit(fr, ((i % cols) * cw, (i // cols) * ch))
        except Exception:
            return
        png, meta_p = self._sheet_paths(folder, scale, crop)
        meta = {"n": n, "cw": cw, "ch": ch, "cols": cols, "offset": list(self.offset), "full": list(scale) if scale else None}

        def _save():
            try:
                pygame.image.save(sheet, png)
                with open(meta_p, "w", encoding="utf-8") as f:     # sidecar last: no sidecar, no cache hit
                    json.dump(meta, f)
            except Exception:
                pass

        threading.Thread(target=_save, daemon=True).start()

    @property
    def ready(self) -> bool:
        return len(self._frames) > 0

    @property
    def current(self) -> pygame.Surface | None:
        if not self._frames:
            return None
        return self._frames[self._idx]

    def advance(self, dt: float = 1.0 / 60.0) -> None:
        """Advance the animation by *dt* seconds.  Call once per game tick."""
        if not self._frames:
            return
        self._acc += dt
        frame_dur = 1.0 / self.fps
        while self._acc >= frame_dur:
            self._acc -= frame_dur
            self._idx = (self._idx + 1) % len(self._frames)
