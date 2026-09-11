"""
Sprites, fonts and baked surfaces for the play screen.

Everything expensive is built once per Layout and cached: Noki's frames are
cropped to their alpha bounding box and scaled (and written to a disk cache so
the second launch is instant), orb bodies are baked per (lane, weight), glyphs
per character, and text per (font, size, string, color).
"""
from __future__ import annotations

import hashlib
import math
import os

import pygame

from . import keyboard as KB

_ROOT = os.path.dirname(os.path.dirname(__file__))
_FONT_DIR = os.path.join(_ROOT, "assets", "fonts", "noki")
_ANIM_DIR = os.path.join(_ROOT, "assets", "animations")
_IMG_DIR = os.path.join(_ROOT, "assets", "images")


def cache_dir(*parts: str) -> str:
    try:
        import platformdirs
        base = platformdirs.user_cache_dir("Noki", "Noki")
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".noki", "cache")
    p = os.path.join(base, *parts)
    os.makedirs(p, exist_ok=True)
    return p


# ── fonts ─────────────────────────────────────────────────────────────────
# Fredoka is the display face, as in the blueprint: SemiBold for the word block, the HUD
# numbers and the orb glyphs, Medium for the fainter queue rows.  Both are static instances
# baked by tools/bake_fonts.py — pygame renders the variable font at its Light default, which
# is what made Fredoka look weak next to the mockup.  Atkinson stays for small text and
# Archivo Black for the judgment stamps.
#
# To go back to Tacobae, point "display"/"display_regular" at TACOBAE (note: Tacobae has no
# × glyph, which is why the multiplier reads "x3").
TACOBAE = os.path.join(_ROOT, "assets", "fonts", "tacobae-font", "Tacobae-pge2K.otf")
_FONT_FILES = {
    "display": ("Fredoka-SemiBold.ttf", False),
    "display_regular": ("Fredoka-Medium.ttf", False),
    "body": ("AtkinsonHyperlegible-Regular.ttf", False),
    "body_bold": ("AtkinsonHyperlegible-Bold.ttf", False),
    "stamp": ("ArchivoBlack-Regular.ttf", False),
}
_LEGACY_FONT = os.path.join(_FONT_DIR, "Fredoka-SemiBold.ttf")
_font_cache: dict[tuple, pygame.font.Font] = {}
_text_cache: dict[tuple, pygame.Surface] = {}


def get_font(kind: str, px: int) -> pygame.font.Font:
    key = (kind, px)
    f = _font_cache.get(key)
    if f is not None:
        return f
    name, bold = _FONT_FILES.get(kind, _FONT_FILES["body"])
    path = name if os.path.isabs(name) else os.path.join(_FONT_DIR, name)
    try:
        f = pygame.font.Font(path, px)
    except Exception:
        try:
            f = pygame.font.Font(_LEGACY_FONT, px)
        except Exception:
            f = pygame.font.Font(None, px)
    if bold:
        f.set_bold(True)
    _font_cache[key] = f
    return f


def render_text(kind: str, px: int, text: str, color: tuple, cache: bool = True) -> pygame.Surface:
    key = (kind, px, text, color)
    if cache:
        s = _text_cache.get(key)
        if s is not None:
            return s
    s = get_font(kind, px).render(text, True, color)
    if cache and len(_text_cache) < 4000:
        _text_cache[key] = s
    return s


# ── blur / glow helpers ───────────────────────────────────────────────────
def _blur_straight(surf: pygame.Surface, passes: int, factor: int) -> pygame.Surface:
    w, h = surf.get_size()
    out = surf
    for _ in range(passes):
        small = pygame.transform.smoothscale(out, (max(1, w // factor), max(1, h // factor)))
        out = pygame.transform.smoothscale(small, (w, h))
    return out


def blur(surf: pygame.Surface, passes: int = 3, factor: int = 4) -> pygame.Surface:
    """Box-blur by repeated down/up scaling, in *premultiplied* alpha.

    Scaling straight (non-premultiplied) RGBA drags the colour of fully transparent pixels —
    black, in a fresh SRCALPHA surface — into every soft edge, so a glow picks up a dirty grey
    halo and a blurred curve grows dark fringes.  Premultiplying before the scale and dividing
    back out afterwards keeps the colour clean all the way into the transparent tail.
    """
    if not surf.get_flags() & pygame.SRCALPHA:
        return _blur_straight(surf, passes, factor)
    try:
        import numpy as np
        rgb = pygame.surfarray.array3d(surf).astype(np.float32)
        a = pygame.surfarray.array_alpha(surf).astype(np.float32)[..., None] / 255.0
        w, h = surf.get_size()
        pre = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.surfarray.blit_array(pre, (rgb * a).astype("uint8"))
        pygame.surfarray.pixels_alpha(pre)[:] = (a[..., 0] * 255).astype("uint8")
        out = _blur_straight(pre, passes, factor)
        orgb = pygame.surfarray.array3d(out).astype(np.float32)
        oa = pygame.surfarray.array_alpha(out).astype(np.float32)[..., None] / 255.0
        straight = np.clip(orgb / np.maximum(oa, 1e-3), 0, 255).astype("uint8")
        res = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.surfarray.blit_array(res, straight)
        pygame.surfarray.pixels_alpha(res)[:] = (oa[..., 0] * 255).astype("uint8")
        return res
    except Exception:
        return _blur_straight(surf, passes, factor)


def glow_disk(radius: int, color: tuple, alpha: float, pad: int | None = None) -> pygame.Surface:
    """A soft round bloom: a disk whose alpha falls off smoothly to nothing at radius + pad."""
    pad = pad if pad is not None else radius
    size = max(2, (radius + pad) * 2)
    try:
        import numpy as np
        ax = np.abs(np.arange(size, dtype=np.float32) - (size - 1) / 2.0)
        d = np.sqrt(ax[:, None] ** 2 + ax[None, :] ** 2) / max(1.0, float(radius + pad))
        k = np.clip(1.0 - d, 0.0, 1.0)
        k = k * k * (3.0 - 2.0 * k)                      # smoothstep: no hard shoulder
        s = pygame.Surface((size, size), pygame.SRCALPHA)
        rgb = np.empty((size, size, 3), dtype="uint8")
        rgb[..., 0], rgb[..., 1], rgb[..., 2] = color[0], color[1], color[2]
        pygame.surfarray.blit_array(s, rgb)
        pygame.surfarray.pixels_alpha(s)[:] = (k * 255 * max(0.0, min(1.0, alpha))).astype("uint8")
        return s
    except Exception:
        s = pygame.Surface((size, size), pygame.SRCALPHA)
        pygame.draw.circle(s, (*color, int(255 * alpha)), (size // 2, size // 2), radius)
        return blur(s, 3, 5)


def aa_circle(radius: int, color: tuple, width: int = 0, alpha: int = 255) -> pygame.Surface:
    """Anti-aliased circle (filled when width == 0) via 3× supersampling."""
    ss = 3
    r = radius * ss
    pad = ss
    size = (r + pad) * 2
    big = pygame.Surface((size, size), pygame.SRCALPHA)
    pygame.draw.circle(big, (*color, alpha), (size // 2, size // 2), r, width * ss if width else 0)
    return pygame.transform.smoothscale(big, (size // ss, size // ss))


def multiply_alpha(surf: pygame.Surface, alpha: float) -> pygame.Surface:
    s = surf.copy()
    s.fill((255, 255, 255, int(255 * max(0.0, min(1.0, alpha)))), special_flags=pygame.BLEND_RGBA_MULT)
    return s


# ── Noki frames ───────────────────────────────────────────────────────────
def _folder_key(folder: str, height: int) -> str:
    try:
        st = os.stat(folder)
        raw = f"{folder}|{int(st.st_mtime)}|{height}|v3"
    except OSError:
        raw = f"{folder}|{height}|v3"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _derive_alpha(surf: pygame.Surface) -> pygame.Surface:
    """Some frame exports (noki_hurt) are opaque on black: make the background transparent.

    Only the black that touches the border is background; the cat's black body is
    enclosed by its white outline and stays.
    """
    try:
        import numpy as np
        alpha = pygame.surfarray.array_alpha(surf)
        if int(alpha.min()) < 250:
            return surf
        rgb = pygame.surfarray.array3d(surf)
        dark = rgb.sum(axis=2) < 48
        try:
            from scipy import ndimage
            labels, _n = ndimage.label(dark)
            border = np.unique(np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]))
            border = border[border != 0]
            bg = np.isin(labels, border)
        except Exception:
            bg = dark
        out = surf.copy()
        pa = pygame.surfarray.pixels_alpha(out)
        pa[bg] = 0
        del pa
        return out
    except Exception:
        return surf


def load_noki_frames(name: str, height: int) -> list[pygame.Surface]:
    """Frames of ``assets/animations/<name>`` cropped to their union alpha bbox and scaled to ``height``.

    Scaled frames are cached on disk so the next launch loads a few small PNGs.
    """
    folder = os.path.join(_ANIM_DIR, name)
    if not os.path.isdir(folder):
        return []
    cdir = cache_dir("sprites", f"{name}_{_folder_key(folder, height)}")
    cached = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
    if cached:
        try:
            return [pygame.image.load(os.path.join(cdir, f)).convert_alpha() for f in cached]
        except Exception:
            pass
    paths = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".png"))
    if not paths:
        return []
    raws = [_derive_alpha(pygame.image.load(p).convert_alpha()) for p in paths]
    union = None
    for r in raws:
        bb = r.get_bounding_rect(min_alpha=8)
        union = bb if union is None else union.union(bb)
    if union is None or union.w < 2 or union.h < 2:
        union = raws[0].get_rect()
    scale = height / union.h
    tw = max(1, int(round(union.w * scale)))
    frames: list[pygame.Surface] = []
    for i, r in enumerate(raws):
        cropped = r.subsurface(union).copy()
        scaled = pygame.transform.smoothscale(cropped, (tw, height))
        frames.append(scaled)
        try:
            pygame.image.save(scaled, os.path.join(cdir, f"{i:04d}.png"))
        except Exception:
            pass
    return frames


def load_image(name: str, size: tuple[int, int] | None = None) -> pygame.Surface | None:
    p = os.path.join(_IMG_DIR, name)
    if not os.path.exists(p):
        return None
    s = pygame.image.load(p).convert_alpha()
    if size:
        s = pygame.transform.smoothscale(s, size)
    return s


# ── the author's note art ─────────────────────────────────────────────────
NOTE_SPRITE_PX = 400          # every note PNG is 400×400
NOTE_SPRITE_SOLID = 128       # diameter of the disk plus ring inside noki_note_<color>.png
LANE_SPRITE = {0: "pink", 1: "orange", 2: "blue", 3: "green"}


class NoteSprites:
    """noki_note_<color>.png for falling notes, default_note.png (the plain circle) for weak
    beats, hold_note.png for holds, noki_note_red.png for a miss, and the nine-frame
    noki_hit_<color> animation on every press — all scaled so the disk is the orb size."""

    def __init__(self, layout) -> None:
        d = 2 * layout.S(layout.orb_r)
        self.scale = d / NOTE_SPRITE_SOLID
        size = max(8, int(round(NOTE_SPRITE_PX * self.scale)))
        self.size = size
        cdir = cache_dir("sprites", f"notes_{size}_v1")
        self.note = {lane: self._img(cdir, f"noki_note_{c}.png", size) for lane, c in LANE_SPRITE.items()}
        self.plain = self._img(cdir, "default_note.png", size)
        self.hold = self._img(cdir, "hold_note.png", size)
        self.miss = self._img(cdir, "noki_note_red.png", size)
        self.hit: dict[int, list[pygame.Surface]] = {}
        for lane, c in LANE_SPRITE.items():
            folder = os.path.join(_ANIM_DIR, f"noki_hit_{c}")
            frames: list[pygame.Surface] = []
            if os.path.isdir(folder):
                for f in sorted(x for x in os.listdir(folder) if x.lower().endswith(".png")):
                    frames.append(self._img(cdir, os.path.join(folder, f), size, key=f"hit_{c}_{f}"))
            self.hit[lane] = [f for f in frames if f is not None]
        self.ok = all(s is not None for s in self.note.values()) and self.plain is not None

    @staticmethod
    def _img(cdir: str, name: str, size: int, key: str | None = None) -> pygame.Surface | None:
        src = name if os.path.isabs(name) else os.path.join(_IMG_DIR, name)
        if not os.path.exists(src):
            return None
        cp = os.path.join(cdir, (key or name).replace(os.sep, "_"))
        if os.path.exists(cp):
            try:
                return pygame.image.load(cp).convert_alpha()
            except Exception:
                pass
        s = pygame.transform.smoothscale(pygame.image.load(src).convert_alpha(), (size, size))
        try:
            pygame.image.save(s, cp)
        except Exception:
            pass
        return s

    @staticmethod
    def scaled(surf: pygame.Surface, k: float) -> pygame.Surface:
        w, h = surf.get_size()
        return pygame.transform.smoothscale(surf, (max(2, int(w * k)), max(2, int(h * k))))


# ── orbs, rings, shards ───────────────────────────────────────────────────
WEIGHT_RING = {4: 5.0, 3: 5.0, 2: 4.0, 1: 2.5, 0: 1.5}
WEIGHT_DISK_ALPHA = {4: 1.0, 3: 1.0, 2: 1.0, 1: 0.94, 0: 0.88}
# (radius, alpha) of the bloom behind an orb.  Wide and faint: a tight, strong glow reads as
# a second hard ring welded to the orb rather than as light coming off it.
STAR_R_STEP = 6          # px the press starburst's radius is rounded to, for the cache
WEIGHT_HALO = {4: (112, 0.26), 3: (102, 0.19), 2: (88, 0.12)}


class OrbCache:
    """Baked orb bodies, glyphs, slot rings and shards for one Layout."""

    def __init__(self, layout) -> None:
        self.L = layout
        self.s = layout.s
        self.r = layout.S(layout.orb_r)
        self._bodies: dict[tuple, pygame.Surface] = {}
        self._halos: dict[tuple, pygame.Surface] = {}
        self._glyphs: dict[tuple, pygame.Surface] = {}
        self._rings: dict[tuple, pygame.Surface] = {}
        self._stars: dict[tuple, pygame.Surface] = {}
        self._shards: dict[int, list[pygame.Surface]] = {}
        self.glyph_px = layout.S(int(layout.orb_r * 1.22))     # the letter fills the disk

    def body(self, lane: int, weight: int, color: tuple | None = None) -> pygame.Surface:
        key = (lane, weight, color)
        s = self._bodies.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        w = max(0, min(4, weight))
        ring_w = max(2, int(round(WEIGHT_RING[w] * self.s)))
        ss = 3
        r = self.r * ss
        pad = ring_w * ss + 2 * ss
        size = (r + pad) * 2
        big = pygame.Surface((size, size), pygame.SRCALPHA)
        c = size // 2
        pygame.draw.circle(big, (255, 255, 255, int(255 * WEIGHT_DISK_ALPHA[w])), (c, c), r)
        pygame.draw.circle(big, (*col, 255), (c, c), r, ring_w * ss)
        s = pygame.transform.smoothscale(big, (size // ss, size // ss))
        self._bodies[key] = s
        return s

    def halo(self, lane: int, weight: int, color: tuple | None = None) -> pygame.Surface | None:
        if weight not in WEIGHT_HALO:
            return None
        key = (lane, weight, color)
        s = self._halos.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        rad, alpha = WEIGHT_HALO[weight]
        s = glow_disk(self.L.S(rad), col, alpha)
        self._halos[key] = s
        return s

    def outer_ring(self, lane: int, scale: float = 1.0, color: tuple | None = None) -> pygame.Surface:
        key = ("outer", lane, round(scale, 2), color)
        s = self._rings.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        # sits well clear of the body, and faint — close in it welded onto the orb's own ring
        s = aa_circle(int(self.L.S(74) * scale), col, max(1, self.L.S(2)), alpha=int(255 * 0.30))
        self._rings[key] = s
        return s

    def glyph(self, ch: str, ink: tuple = KB.INK, alpha: float = 1.0) -> pygame.Surface:
        key = (ch, ink, round(alpha, 2))
        s = self._glyphs.get(key)
        if s is not None:
            return s
        s = render_text("display", self.glyph_px, ch.upper(), ink, cache=False)
        if alpha < 1.0:
            s = multiply_alpha(s, alpha)
        self._glyphs[key] = s
        return s

    def slot_ring(self, lane: int, alpha: float = 1.0, color: tuple | None = None, scale: float = 1.0) -> pygame.Surface:
        key = ("slot", lane, round(alpha, 2), color, round(scale, 2))
        s = self._rings.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        rr = int(self.L.S(self.L.slot_ring_r) * scale)
        ring = aa_circle(rr, col, max(2, self.L.S(3)), alpha=int(255 * alpha))
        # dark fill so the ring reads on top of the glow strip
        fill = aa_circle(rr - max(2, self.L.S(3)), (6, 5, 11), 0, alpha=int(255 * 0.9))
        out = pygame.Surface(ring.get_size(), pygame.SRCALPHA)
        out.blit(fill, fill.get_rect(center=out.get_rect().center))
        out.blit(ring, (0, 0))
        self._rings[key] = out
        return out

    def burst_ring(self, lane: int, radius: int, width: int, alpha: float, color: tuple | None = None) -> pygame.Surface:
        key = ("burst", lane, radius, width, round(alpha, 2), color)
        s = self._rings.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        s = aa_circle(radius, col, max(1, width), alpha=int(255 * alpha))
        if len(self._rings) < 600:
            self._rings[key] = s
        return s

    def hit_star(self, lane: int, radius: int, alpha: float, color: tuple | None = None) -> pygame.Surface:
        """The press burst: hand-drawn impact strokes radiating from the slot.

        Every stroke is a tapered brush mark with rounded ends and a soft edge, rendered as
        a distance field rather than a polygon so it is smooth at any size and reads like
        the figure's inked lines; the inner half of each mark is lifted towards white like a
        marker stroke.  Lengths and angles wobble a little, deterministically per lane, so it
        never looks stamped.  Baked per (lane, quantised radius, quantised alpha).
        """
        radius = max(6, int(radius) // STAR_R_STEP * STAR_R_STEP)
        key = (lane, radius, round(alpha, 1), color)
        s = self._stars.get(key)
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        a = max(0.0, min(1.0, alpha))
        size = radius * 2
        try:
            import numpy as np
            rng = np.random.RandomState(11 + lane)
            n = 8
            ax = np.arange(size, dtype=np.float32) - (size - 1) / 2.0
            X, Y = np.meshgrid(ax, ax, indexing="ij")
            cover = np.zeros((size, size), dtype=np.float32)      # stroke coverage 0..1
            core = np.zeros((size, size), dtype=np.float32)       # the lighter marker centre
            edge = max(1.0, radius * 0.045)                       # soft edge width, px
            for k in range(n):
                ang = math.tau * k / n + rng.uniform(-0.12, 0.12)
                long = k % 2 == 0
                r0 = radius * (0.36 if long else 0.40)
                r1 = radius * ((0.98 if long else 0.66) * rng.uniform(0.88, 1.0))
                w0 = radius * (0.11 if long else 0.08)            # base half-width
                dx, dy = math.cos(ang), math.sin(ang)
                # distance along / across the stroke's axis
                u = X * dx + Y * dy
                v = -X * dy + Y * dx
                t = np.clip((u - r0) / max(1e-3, r1 - r0), 0.0, 1.0)
                half = w0 * (1.0 - 0.85 * t) + 0.6                # tapers to a rounded point
                # rounded ends: distance to the segment, not the strip
                du = np.where(u < r0, r0 - u, np.where(u > r1, u - r1, 0.0))
                d = np.sqrt(du * du + v * v)
                m = np.clip((half - d) / edge + 0.5, 0.0, 1.0)
                cover = np.maximum(cover, m)
                core = np.maximum(core, np.clip((half * 0.42 - d) / edge + 0.5, 0.0, 1.0) * (1.0 - 0.6 * t))
            # straight (non-premultiplied) colour, blitted normally: the strokes are opaque marker
            # marks, not light, so they stay bold over the white ring frame beneath them
            rgb = np.empty((size, size, 3), dtype=np.float32)
            for i in range(3):
                rgb[..., i] = col[i] + (255 - col[i]) * 0.55 * core
            out = pygame.Surface((size, size), pygame.SRCALPHA)
            pygame.surfarray.blit_array(out, np.clip(rgb, 0, 255).astype("uint8"))
            pygame.surfarray.pixels_alpha(out)[:] = (cover * 255 * a).astype("uint8")
        except Exception:
            out = pygame.Surface((size, size), pygame.SRCALPHA)
            pygame.draw.circle(out, (*col, int(255 * a)), (radius, radius), max(2, radius // 3), max(1, radius // 12))
        if len(self._stars) < 1200:
            self._stars[key] = out
        return out

    def shards(self, lane: int, color: tuple | None = None) -> list[pygame.Surface]:
        key = lane if color is None else (lane, color)
        s = self._shards.get(key)  # type: ignore[arg-type]
        if s is not None:
            return s
        col = color or KB.lane_color(lane)
        out = []
        base = self.L.S(46)
        for k in range(6):
            ln = int(base * (0.7 + 0.1 * (k % 3)))
            wd = max(3, int(base * 0.28))
            surf = pygame.Surface((ln + 4, wd + 4), pygame.SRCALPHA)
            pygame.draw.polygon(surf, (*col, 230), [(2, wd // 2 + 2), (ln + 2, 2), (ln + 2, wd + 2)])
            out.append(surf)
        self._shards[key] = out  # type: ignore[index]
        return out


def petal_surface(size: int, color: tuple) -> pygame.Surface:
    s = pygame.Surface((size, size), pygame.SRCALPHA)
    pygame.draw.ellipse(s, (*color, 255), (size * 0.15, 0, size * 0.7, size))
    return pygame.transform.rotate(s, -25)
