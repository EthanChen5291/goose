"""
HighwayRenderer — the full-screen four-lane play screen.

One 320 px grid covers the whole screen; the middle four columns are the
lanes.  Beat rows and the slot line run edge to edge, Noki stands on the line,
equal orbs fall straight down the lanes onto fixed slot rings, the word block sits
under the line in the Keyboard Warrior stack, and the only other things on
screen are numbers.

Everything is drawn in design units (1920×1080) through a Layout; every
expensive surface is baked once.  The renderer owns the transient effects
(bursts, shards, stamps, particles, flying glyphs) and the little state
machines (slot rings, lives, Petal Rush, the nap).  It never judges: the play
session calls ``on_hit`` / ``on_miss`` / ``on_slip`` after the RhythmManager
has spoken.
"""
from __future__ import annotations

import bisect
import math
import random

import pygame

from . import constants as C
from . import keyboard as KB
from . import models as M
from .layout import Layout, LANE_W, HIGHWAY_X0, HIGHWAY_CX, DESIGN_W, DESIGN_H
from .sprites import (OrbCache, NoteSprites, load_noki_frames, render_text, blur, multiply_alpha,
                      glow_disk, petal_surface)

WHITE = (255, 255, 255)
STAMP_COLORS = {
    'perfect': KB.GOLD,
    'good': (131, 227, 176),
    'ok': (174, 208, 230),
    'miss': KB.MISS_RED,
    'slip': (170, 170, 190),
}
STAMP_TEXT = {'perfect': 'PERFECT', 'good': 'GREAT', 'ok': 'OK', 'miss': 'MISS'}
BG_CENTER = (34, 32, 58)     # the airbrush bloom over the highway
BG_HOT = (58, 46, 104)       # the bloom at full energy (a burst)
BG_LEVELS = 8                # baked steps between BG_CENTER and BG_HOT
ENERGY = {"sustain": 0.12, "groove": 0.40, "drive": 0.70, "burst": 1.0}
MILESTONES = (25, 50, 100, 150, 200, 300, 400, 500)
SECTION_TAG = {"pattern": "BUILD", "anchor": "HOLD"}
BG_EDGE = (7, 6, 13)         # the corners
# Falling notes are drawn as the blueprint orb (white disk, thin lane-colored ring, soft halo on
# strong beats); the author's note PNG has a wide flat halo that reads bulky next to the figure.
# Set to "sprite" to fall back to noki_note_<color>.png.  The press animation is always the author's.
NOTE_ART = "orb"
STAR_LIFE = 0.38         # seconds the press burst lives


def weight_of_time(song_t: float, beat_times: list[float], bpm: float) -> int:
    """Metric weight 4 beat1 · 3 beat3 · 2 backbeat · 1 eighth · 0 sixteenth from the aligned beat grid."""
    if not beat_times or len(beat_times) < 2:
        return 2
    i = bisect.bisect_right(beat_times, song_t) - 1
    if i < 0:
        i = 0
    if i >= len(beat_times) - 1:
        i = len(beat_times) - 2
    b0, b1 = beat_times[i], beat_times[i + 1]
    span = max(1e-6, b1 - b0)
    frac = (song_t - b0) / span
    if frac < 0.125 or frac >= 0.875:
        j = i if frac < 0.125 else i + 1
        pos = j % 4
        return 4 if pos == 0 else (3 if pos == 2 else 2)
    if abs(frac - 0.5) < 0.125:
        return 1
    return 0


class _Burst:
    __slots__ = ("x", "y", "lane", "kind", "age", "color")

    def __init__(self, x, y, lane, kind, color):
        self.x, self.y, self.lane, self.kind, self.age, self.color = x, y, lane, kind, 0.0, color


class HighwayRenderer:
    def __init__(self, layout: Layout, song: M.Song, rhythm, difficulty: str,
                 settings: dict | None = None, title: str = "", artist: str = "") -> None:
        self.L = layout
        self.song = song
        self.rhythm = rhythm
        self.difficulty = difficulty
        self.settings = settings or {}
        self.title = title
        self.artist = artist
        self.approach = C.APPROACH_S.get(difficulty, 1.6) / max(0.25, float(self.settings.get("speed_mult", 1.0)))
        self.speed = self.L.fall_px / self.approach          # design px per second
        self.beat_dur = 60.0 / song.bpm if song.bpm else 0.5
        self.bar_dur = self.beat_dur * 4
        self.lead_in = rhythm.lead_in
        self.beat_times_chart = [bt + self.lead_in for bt in song.beat_times]

        self.orbs = OrbCache(layout)
        self.notes = NoteSprites(layout)
        self.hit_anims: list[dict] = []
        self._prep_events()
        self._bake()

        h = self.L.S(self.L.noki_rect[3])
        self.noki_bop = load_noki_frames("noki_bop", h)
        self.noki_hurt = load_noki_frames("noki_hurt", h)
        self._hurt_t = -1.0

        # transient effects
        self.bursts: list[_Burst] = []
        self.shards: list[dict] = []
        self.sparks: list[dict] = []
        self.stamps: list[dict] = []
        self.flying: list[dict] = []
        self.ring_x = [float(self.L.lane_center(i)) for i in range(4)]
        self.ring_hit_t = [-9.0] * 4
        self.ring_miss_t = [-9.0] * 4
        self.line_flash_t = -9.0
        self.slip_flash = [(-9.0, "")] * 4

        # meta state
        self.lives = C.LIVES
        self._streak = 0
        self.life_cooldown_until = -9.0
        self.nap_until = -9.0
        self.rush_charge = 0.0
        self.rush_until = -9.0
        self.combo_tier = 1
        self._score_shown = 0.0
        self._last_beat_idx = -1
        self._rng = random.Random(7)
        self._dim = pygame.Surface((layout.win_w, layout.win_h), pygame.SRCALPHA)
        self.word_flash_t = -9.0
        self.word_flash: tuple[str, bool] | None = None

        # duet sections: (t0, t1, shape) in chart time, per-hand heat
        self.duets: list[tuple[float, float, str]] = []
        self.heat = [0, 0]
        self._lock_t = -9.0
        self._bake_duet()

        # sections: per-bar vibe and the phrase map, in chart time (set_sections)
        self.bar_vibes: list[str] = []
        self.bar_t: list[float] = []
        self.phrases: list[tuple[float, float, str]] = []
        self._energy_s = 0.4            # smoothed energy the visuals follow
        self._phrase_i = -1
        self.drop_t = -9.0              # the last drop (a jump into a burst)
        self.shockwaves: list[dict] = []
        self.dust: list[dict] = []
        self.milestone: tuple[int, float] | None = None
        # the anchor hold on screen
        self.anchor_ev: M.CharEvent | None = None
        self.anchor_t0 = -9.0
        self.anchor_end_t = -9.0        # when the last anchor finished (gold fade)
        self.anchor_break_t = -9.0

    def set_layout(self, layout: Layout) -> None:
        """The window changed size: rebake everything that depends on pixels, keep every bit of state."""
        self.L = layout
        self.speed = layout.fall_px / self.approach
        self.orbs = OrbCache(layout)
        self.notes = NoteSprites(layout)
        self._prep_events()
        self._bake()
        self._bake_duet()
        h = layout.S(layout.noki_rect[3])
        self.noki_bop = load_noki_frames("noki_bop", h)
        self.noki_hurt = load_noki_frames("noki_hurt", h)
        self.ring_x = [float(layout.lane_center(i)) for i in range(4)]
        self._dim = pygame.Surface((layout.win_w, layout.win_h), pygame.SRCALPHA)
        self.glyph_glow_cache = {}

    def set_sections(self, meta: dict) -> None:
        """The chart's section map: per-bar vibes and the phrase kinds, shifted to chart time."""
        li = self.lead_in
        self.bar_vibes = list(meta.get("bar_vibes", []))
        self.bar_t = [float(t) + li for t in meta.get("bar_start", [])]
        self.phrases = [(float(p[0]) + li, float(p[1]) + li, str(p[2])) for p in meta.get("phrases", [])]

    def energy_at(self, t: float) -> float:
        """0..1 from the vibe of the bar under ``t``, crossfading over the bar's last beat."""
        if not self.bar_t or not self.bar_vibes:
            return 0.45
        i = bisect.bisect_right(self.bar_t, t) - 1
        if i < 0:
            return ENERGY.get(self.bar_vibes[0], 0.4)
        i = min(i, len(self.bar_vibes) - 1)
        cur = ENERGY.get(self.bar_vibes[i], 0.4)
        if i + 1 < len(self.bar_vibes) and i + 1 < len(self.bar_t):
            nxt = ENERGY.get(self.bar_vibes[i + 1], cur)
            k = (t - (self.bar_t[i + 1] - self.beat_dur)) / max(1e-3, self.beat_dur)
            if k > 0:
                cur = cur + (nxt - cur) * min(1.0, k)
        return cur

    def phrase_at(self, t: float):
        for i, (t0, t1, kind) in enumerate(self.phrases):
            if t0 <= t < t1:
                return i, t0, t1, kind
        return None

    def set_duets(self, spans: list) -> None:
        self.duets = [(float(s[0]) + self.lead_in, float(s[1]) + self.lead_in, str(s[2])) for s in spans]

    def duet_at(self, t: float):
        for d in self.duets:
            if d[0] - 2 * self.bar_dur <= t < d[1]:
                return d
        return None

    def _bake_duet(self) -> None:
        """Four per-lane vertical gradients (bright at the slot line) and a blurred band above it."""
        L = self.L
        lane_h = L.Y(L.slot_y) - L.Y(L.top)
        self.duet_fills: list[pygame.Surface] = []
        for lane in range(4):
            col = KB.lane_color(lane)
            g = pygame.Surface((1, max(2, lane_h)), pygame.SRCALPHA)
            for y in range(max(2, lane_h)):
                k = y / max(1, lane_h - 1)
                g.set_at((0, y), (*col, int(255 * (0.0 + 0.17 * k * k))))
            self.duet_fills.append(pygame.transform.scale(g, (L.S(LANE_W), max(2, lane_h))).convert_alpha())
        band = pygame.Surface((L.S(LANE_W), L.S(110)), pygame.SRCALPHA)
        pygame.draw.rect(band, (255, 255, 255, 120), (0, L.S(60), L.S(LANE_W), L.S(50)))
        self.duet_band = blur(band, 3, 6).convert_alpha()
        self.duet_gold = pygame.Surface((L.S(LANE_W * 4), max(2, lane_h)), pygame.SRCALPHA)
        self.duet_gold.fill((*KB.GOLD, int(255 * 0.10)))

    def _active_voice(self, t: float) -> int:
        for ev in self._visible_events(t):
            if not ev.hit and ev.voice >= 0 and ev.timestamp >= t - 0.05:
                return ev.voice
        return -1

    # ── preparation ────────────────────────────────────────────────────────
    def _prep_events(self) -> None:
        """Lane, x and weight per playable event (design units)."""
        self.geom: dict[int, tuple[int, int, int]] = {}
        for ev in self.rhythm.beat_map:
            if ev.is_rest or not ev.char:
                continue
            lane = ev.lane if ev.lane >= 0 else KB.lane_of(ev.char)
            ev.lane = lane
            x = self.L.lane_center(lane)          # straight down the lane: the slot rings never move
            if ev.weight < 0:
                ev.weight = weight_of_time(ev.timestamp - self.lead_in, self.song.beat_times, self.song.bpm)
            self.geom[id(ev)] = (lane, x, ev.weight)
        # connector jitter per event (lightning joints), deterministic
        self.jitter: dict[int, tuple[float, float]] = {}
        rng = random.Random(1234)
        for ev in self.rhythm.beat_map:
            if ev.is_rest or not ev.char:
                continue
            self.jitter[id(ev)] = (rng.uniform(-14, 14), rng.uniform(-14, 14))

    def _bake(self) -> None:
        L = self.L
        W, H = L.win_w, L.win_h
        # background: the airbrush — a broad indigo bloom over the highway that falls off
        # smoothly to near-black in the corners, plus a wider, softer lift along the slot line
        bg = pygame.Surface((W, H))
        try:
            import numpy as np
            ys, xs = np.mgrid[0:H, 0:W]
            cx, cy = L.X(DESIGN_W * 0.5), L.Y(DESIGN_H * 0.52)
            # an ellipse wider than it is tall, so the bloom follows the highway
            d = np.sqrt(((xs - cx) / (W * 0.78)) ** 2 + ((ys - cy) / (H * 0.90)) ** 2)
            k = np.clip(1.0 - d, 0.0, 1.0)
            k = k * k * (3.0 - 2.0 * k)              # smoothstep: a plateau in the middle, no visible ring
            # a soft horizontal band of light around the slot line, as in the figure
            band = np.exp(-(((ys - L.Y(L.slot_y)) / (H * 0.42)) ** 2)) * 0.35
            k = np.clip(k + band, 0.0, 1.0)[..., None]
            c0 = np.array(BG_CENTER, dtype=float)
            c1 = np.array(BG_EDGE, dtype=float)
            arr = (c1 + (c0 - c1) * k).astype("uint8")
            # a 24-bit RGB surface: on macOS the window format carries an alpha channel and
            # blit_array leaves it at 0, so the whole background blended away to black
            bg = pygame.surfarray.make_surface(np.ascontiguousarray(arr.swapaxes(0, 1)))
        except Exception:
            bg = pygame.Surface((W, H))
            bg.fill(BG_CENTER)
        # lane fills (vertical gradient, brightest at the slot line) and the grid
        lane_h = L.Y(L.slot_y) - L.Y(L.top)
        grad = pygame.Surface((1, max(2, lane_h)), pygame.SRCALPHA)
        for y in range(max(2, lane_h)):
            a = int(255 * 0.075 * (y / max(1, lane_h - 1)) ** 1.5)
            grad.set_at((0, y), (216, 214, 255, a))
        lane_fill = pygame.transform.scale(grad, (L.S(LANE_W * 4), max(2, lane_h)))
        bg.blit(lane_fill, (L.X(HIGHWAY_X0), L.Y(L.top)))
        # grid lines: scaled width, not 1 px — a hairline disappears on a Retina window
        overlay = pygame.Surface((W, H), pygame.SRCALPHA)
        gw = max(1, L.S(2))
        for col in range(-1, 5):
            x = L.X(HIGHWAY_X0 + col * LANE_W)
            if 0 <= x <= W:
                edge = col in (-1, 0, 4)
                pygame.draw.line(overlay, (222, 220, 255, int(255 * (0.30 if edge else 0.22))),
                                 (x, L.Y(L.top)), (x, L.Y(L.slot_y)), gw)
        bg.blit(overlay, (0, 0))
        self.bg = bg.convert()
        # the airbrush at eight energy levels, cool to hot, baked so a section change is one
        # opaque blit rather than a full-screen alpha blend every frame
        self.bg_levels: list[pygame.Surface] = [self.bg]
        try:
            import numpy as np
            c0h = np.array(BG_HOT, dtype=float)
            for i in range(1, BG_LEVELS):
                m = i / (BG_LEVELS - 1)
                cc = c0 + (c0h - c0) * m
                arr_i = (c1 + (cc - c1) * k).astype("uint8")
                lvl = pygame.surfarray.make_surface(np.ascontiguousarray(arr_i.swapaxes(0, 1)))
                lvl.blit(lane_fill, (L.X(HIGHWAY_X0), L.Y(L.top)))
                lvl.blit(overlay, (0, 0))
                self.bg_levels.append(lvl.convert())
        except Exception:
            pass

        # side ribbons (Beat Weaver): baked blurred curves
        self.ribbons: list[tuple[pygame.Surface, int]] = []
        for (pts, col) in (
            ([(L.left + 30, L.top - 20), (L.left + 150, L.top + 260), (L.left + 40, 560), (L.left + 210, L.slot_y)], KB.lane_color(0)),
            ([(L.right - 20, L.top - 20), (L.right - 120, L.top + 260), (L.right - 30, 560), (L.right - 130, L.slot_y)], KB.lane_color(2)),
        ):
            curve = self._bezier([(L.X(px), L.Y(py)) for px, py in pts], 40)
            surf = pygame.Surface((W, H), pygame.SRCALPHA)
            pygame.draw.lines(surf, (*col, 28), False, curve, max(2, L.S(4)))
            surf = blur(surf, 2, 6)
            pygame.draw.aalines(surf, (*col, 55), False, curve)
            self.ribbons.append((surf.convert_alpha(), 0))

        # slot glow strip, full width: a tight symmetric falloff around the line rather than a
        # blurred rectangle, which left a grey smear hanging under the highway
        sh = max(4, L.S(120))
        strip = pygame.Surface((W, sh), pygame.SRCALPHA)
        try:
            import numpy as np
            k = np.exp(-((np.arange(sh, dtype=np.float32) - (sh - 1) / 2.0) / (sh * 0.16)) ** 2)
            rgb = np.empty((W, sh, 3), dtype="uint8")
            rgb[:] = (226, 224, 255)
            pygame.surfarray.blit_array(strip, rgb)
            pygame.surfarray.pixels_alpha(strip)[:] = (k * 255 * 0.20).astype("uint8")[None, :]
        except Exception:
            pygame.draw.rect(strip, (226, 224, 255, int(255 * 0.14)), (0, sh // 2 - L.S(12), W, L.S(24)))
            strip = blur(strip, 3, 8)
        self.slot_strip = strip.convert_alpha()
        self.slot_strip_gold = self.slot_strip.copy()
        self.slot_strip_gold.fill((*KB.GOLD, 255), special_flags=pygame.BLEND_RGBA_MULT)

        self.lines_overlay = pygame.Surface((W, H), pygame.SRCALPHA)
        self.petal_img = petal_surface(L.S(16), KB.lane_color(0))
        self.glyph_glow_cache: dict[tuple, pygame.Surface] = {}

    @staticmethod
    def _bezier(p: list[tuple[int, int]], n: int) -> list[tuple[int, int]]:
        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p
        out = []
        for i in range(n + 1):
            t = i / n
            u = 1 - t
            x = u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3
            y = u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3
            out.append((int(x), int(y)))
        return out

    # ── events from the session ───────────────────────────────────────────
    def _ev_xy(self, ev: M.CharEvent) -> tuple[int, int, int]:
        lane, x, _w = self.geom.get(id(ev), (KB.lane_of(ev.char), self.L.lane_center(KB.lane_of(ev.char)), 2))
        return lane, x, self.L.slot_y

    def on_hit(self, ev: M.CharEvent, judgment: str, offset_ms: float, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        rush_now = self.rush_active(t)
        col = KB.GOLD if rush_now else KB.lane_color(lane)
        self._hit_anim(lane, x, y, t, judgment, col)
        self._streak += 1
        if self._streak % C.LIFE_REGROW_STREAK == 0 and self.lives < C.LIVES and t >= self.nap_until:
            self.lives += 1              # a petal grows back every 25 notes without a miss
        if judgment == 'perfect':
            self._spawn_sparks(x, y, 5, col)
            self.rush_charge = min(1.0, self.rush_charge + 0.01)
        elif judgment == 'good':
            self._spawn_sparks(x, y, 3, col)
        self.ring_hit_t[lane] = t
        self._stamp(judgment, x, y, offset_ms, t)
        if ev.voice >= 0:
            self.heat[ev.voice] = min(3, self.heat[ev.voice] + 1)
            if self.heat[0] >= 3 and self.heat[1] >= 3 and self._lock_t < 0:
                self._lock_t = t
                self._spawn_sparks(HIGHWAY_CX, self.L.slot_y - 200, 24, KB.GOLD, spread=700)
                self.rush_charge = min(1.0, self.rush_charge + 0.25)
        else:
            self._fly_glyph(ev, x, y, t)
        self.combo_tier = 1 + (self.rhythm.combo >= 10) + (self.rhythm.combo >= 25) + (self.rhythm.combo >= 50)
        if self.rhythm.combo in MILESTONES:
            self.milestone = (self.rhythm.combo, t)
            self._spawn_sparks(HIGHWAY_CX, self.L.COMBO_POS[1], 16, KB.GOLD if rush_now else col, spread=600)

    def _hit_anim(self, lane: int, x: float, y: float, t: float, judgment: str = 'good',
                  color: tuple | None = None) -> None:
        """The press feedback at the slot: the blueprint's starburst, plus the author's
        nine-frame noki_hit_<color> ring over it (a plain ring burst if those are missing)."""
        self.hit_anims.append({'lane': lane, 'x': x, 'y': y, 't0': t, 'judgment': judgment,
                               'color': color})
        if not self.notes.hit.get(lane):
            self.bursts.append(_Burst(x, y, lane, judgment, color or KB.lane_color(lane)))

    def on_hold_start(self, ev: M.CharEvent, judgment: str, offset_ms: float, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        self.ring_hit_t[lane] = t
        self._stamp(judgment, x, y, offset_ms, t)

    def on_hold_complete(self, ev: M.CharEvent, judgment: str, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        col = KB.lane_color(lane)
        self._hit_anim(lane, x, y, t, 'perfect', KB.GOLD)
        self._spawn_sparks(x, y, 6, KB.GOLD)
        self._fly_glyph(ev, x, y, t)

    def on_anchor_start(self, ev: M.CharEvent, judgment: str, offset_ms: float, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        self.anchor_ev = ev
        self.anchor_t0 = t
        self.ring_hit_t[lane] = t
        self._hit_anim(lane, x, y, t, judgment, KB.lane_color(lane))
        self._stamp(judgment, x, y, offset_ms, t)

    def on_anchor_complete(self, ev: M.CharEvent, judgment: str, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        self.anchor_ev = None
        self.anchor_end_t = t
        self._hit_anim(lane, x, y, t, 'perfect', KB.GOLD)
        self._spawn_sparks(x, y, 14, KB.GOLD, spread=520)
        self._fly_glyph(ev, x, y, t)
        self.rush_charge = min(1.0, self.rush_charge + 0.06)
        self._streak += 1

    def on_anchor_break(self, ev: M.CharEvent, t: float) -> None:
        self.anchor_ev = None
        self.anchor_break_t = t
        self.on_miss(ev, t)

    def on_miss(self, ev: M.CharEvent, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        self.ring_miss_t[lane] = t
        if ev.voice >= 0:
            self.heat[ev.voice] = 0
            self._lock_t = -9.0
        self._stamp('miss', x, y, 0.0, t)
        self._hurt_t = t
        self._streak = 0
        if t >= self.life_cooldown_until and t >= self.nap_until:
            self.lives = max(0, self.lives - 1)
            self.life_cooldown_until = t + C.LIFE_COOLDOWN_S
            self._spawn_life_petal(t)
            if self.lives == 0:
                self.nap_until = t + C.NAP_BARS * self.bar_dur

    def on_slip(self, ev: M.CharEvent, pressed: str, t: float) -> None:
        lane, x, y = self._ev_xy(ev)
        self.slip_flash[lane] = (t, pressed)
        self._stamp('slip', x, y, 0.0, t, extra=pressed.upper())

    def on_too_early(self, ev: M.CharEvent, t: float) -> None:
        lane, _x, _y = self._ev_xy(ev)
        self.ring_hit_t[lane] = t - 0.1   # a soft acknowledgement, no stamp

    def on_word_complete(self, word: str, clean: bool, t: float) -> None:
        self.word_flash_t = t
        self.word_flash = (word, clean)
        if clean:
            self.rush_charge = min(1.0, self.rush_charge + C.RUSH_CHARGE_PER_CLEAN_WORD)

    def try_rush(self, t: float) -> bool:
        if self.rush_active(t) or self.rush_charge < C.RUSH_THRESHOLD:
            return False
        self.rush_until = t + C.RUSH_BARS * self.bar_dur
        self.rush_charge = 0.0
        self.rhythm.rush_active = True
        self._spawn_sparks(HIGHWAY_CX, self.L.slot_y, 30, KB.GOLD, spread=900)
        return True

    def rush_active(self, t: float) -> bool:
        return t < self.rush_until

    # ── effect spawners ───────────────────────────────────────────────────
    def _spawn_shards(self, x, y, lane, n, col):
        imgs = self.orbs.shards(lane, None if col == KB.lane_color(lane) else col)
        for k in range(n):
            ang = self._rng.uniform(0, math.tau)
            spd = self._rng.uniform(420, 760)
            self.shards.append({'x': float(x), 'y': float(y), 'vx': math.cos(ang) * spd, 'vy': math.sin(ang) * spd,
                                'img': imgs[k % len(imgs)], 'age': 0.0, 'life': 0.36, 'ang': ang})

    def _spawn_sparks(self, x, y, n, col, spread=380):
        for _ in range(n):
            ang = self._rng.uniform(0, math.tau)
            spd = self._rng.uniform(spread * 0.4, spread)
            self.sparks.append({'x': float(x), 'y': float(y), 'vx': math.cos(ang) * spd, 'vy': math.sin(ang) * spd - 120,
                                'age': 0.0, 'life': self._rng.uniform(0.3, 0.55), 'r': self._rng.uniform(2, 4),
                                'col': col if self._rng.random() < 0.5 else WHITE})

    def _drop(self, t: float) -> None:
        """A phrase just jumped into a burst: one white flash, a ring across the highway, sparks."""
        self.drop_t = t
        self.shockwaves.append({'t0': t, 'x': HIGHWAY_CX, 'y': self.L.slot_y, 'col': WHITE, 'dur': 0.7, 'r1': 1500})
        self._spawn_sparks(HIGHWAY_CX, self.L.slot_y, 26, WHITE, spread=900)

    def _spawn_life_petal(self, t):
        lx, ly = self.L.LIVES_POS
        nx, ny, nw, nh = self.L.noki_rect
        self.flying.append({'kind': 'petal', 'x0': lx + 20 * self.lives, 'y0': ly, 'x1': nx + nw * 0.5, 'y1': ny + nh * 0.3,
                            't0': t, 'dur': 0.45})

    def _stamp(self, kind, x, y, offset_ms, t, extra=""):
        # one stamp per lane at a time
        lane_x0 = (x - HIGHWAY_X0) // LANE_W
        self.stamps = [s for s in self.stamps if (s['x'] - HIGHWAY_X0) // LANE_W != lane_x0]
        tag = ""
        if kind in ('good', 'ok') and abs(offset_ms) >= 25:
            tag = "EARLY" if offset_ms < 0 else "LATE"
        self.stamps.append({'kind': kind, 'x': x, 'y': y - 96, 't0': t, 'tag': tag, 'extra': extra})   # above the press animation's ring

    def _fly_glyph(self, ev, x, y, t):
        self.flying.append({'kind': 'glyph', 'ch': ev.char, 'lane': ev.lane, 'x0': x, 'y0': y,
                            'word_id': ev.word_id, 'char_idx': ev.char_idx, 't0': t, 'dur': 0.18})

    # ── beat helpers ──────────────────────────────────────────────────────
    def beat_phase(self, t: float) -> tuple[int, float]:
        """(beat index, phase 0..1) of chart time t on the aligned grid."""
        bt = self.beat_times_chart
        if len(bt) < 2:
            return 0, 0.0
        i = bisect.bisect_right(bt, t) - 1
        if i < 0:
            return -1, 0.0
        if i >= len(bt) - 1:
            return i, 0.0
        return i, (t - bt[i]) / max(1e-6, bt[i + 1] - bt[i])

    def bar_phase(self, t: float) -> float:
        i, p = self.beat_phase(t)
        if i < 0:
            return 0.0
        return ((i % 4) + p) / 4.0

    # ── drawing ───────────────────────────────────────────────────────────
    def draw(self, screen: pygame.Surface, t: float, dt: float) -> None:
        L = self.L
        rush = self.rush_active(t)
        if not rush and self.rhythm.rush_active:
            self.rhythm.rush_active = False
        beat_i, beat_p = self.beat_phase(t)
        if beat_i != self._last_beat_idx:
            self._last_beat_idx = beat_i
            self.line_flash_t = t
        bar_p = self.bar_phase(t)

        # section energy, smoothed, and the drop when a phrase jumps into a burst
        e_target = self.energy_at(t)
        self._energy_s += (e_target - self._energy_s) * min(1.0, 3.0 * dt)
        ph = self.phrase_at(t)
        if ph is not None and ph[0] != self._phrase_i:
            prev = self._phrase_i
            self._phrase_i = ph[0]
            if prev >= 0 and e_target >= 0.95 and self._energy_s < 0.6:
                self._drop(t)
        lvl = int(round(min(1.0, 0.85 * self._energy_s) * (len(self.bg_levels) - 1)))
        screen.blit(self.bg_levels[lvl], (0, 0))
        self._draw_ribbons(screen, t, bar_p, beat_i)
        self._draw_dust(screen, t, dt)
        duet = self.duet_at(t)
        if duet is not None:
            self._draw_duet_strip(screen, t, duet)
        ov = self.lines_overlay
        ov.fill((0, 0, 0, 0))
        self._draw_beat_rows(ov, t)
        self._draw_combo(screen)
        self._draw_connectors(ov, t, rush)
        screen.blit(ov, (0, 0))
        self._draw_slot_line(screen, t, bar_p, rush)
        if t < self.nap_until:
            # the nap: a light veil under the notes, so the highway reads as resting while the notes stay crisp
            self._dim.fill((0, 0, 0, 48))
            screen.blit(self._dim, (0, 0))
        self._draw_anchor_lane(screen, t)
        self._update_rings(t, dt)
        self._draw_rings(screen, t, rush)
        self._draw_notes(screen, t, beat_p, rush)
        self._draw_effects(screen, t, dt)
        self._draw_shockwaves(screen, t, dt)
        self._draw_milestone(screen, t)
        self._draw_section_tag(screen, t)
        if duet is not None and t >= duet[0]:
            self._draw_duet_word_band(screen, t)
        else:
            self._draw_word_block(screen, t, rush)
        self._draw_hud(screen, t, dt, rush)
        if duet is not None:
            self._draw_duet_mark(screen, t, duet)
        self._draw_noki(screen, t, dt)
        if self.lives == 0 and t >= self.nap_until:
            self.lives = 1
        self._draw_count_in(screen, t)

    # background pieces
    def _draw_ribbons(self, screen, t, bar_p, beat_i):
        L = self.L
        for k, (surf, _) in enumerate(self.ribbons):
            off = int(L.S(24 + 36 * self._energy_s) * math.sin(math.tau * bar_p + k * math.pi))
            pulse = 0.55 + 0.45 * max(0.0, 1.0 - ((t - self.line_flash_t) / 0.35)) if beat_i % 4 == 0 else 0.55
            s = surf.copy() if abs(pulse - 1.0) > 0.02 else surf
            if s is not surf:
                s.set_alpha(int(255 * pulse))
            screen.blit(s, (0, off))

    def _draw_beat_rows(self, ov, t):
        L = self.L
        slot_y = L.slot_y
        # beats on screen: chart times within (t - 0.3, t + approach)
        bt = self.beat_times_chart
        if not bt:
            return
        lo = bisect.bisect_left(bt, t - 0.4)
        hi = bisect.bisect_right(bt, t + self.approach + 0.2)
        for i in range(lo, hi):
            y = slot_y - (bt[i] - t) * self.speed
            if y < L.top or y > slot_y:
                continue
            yy = L.Y(y)
            g = 0.6 + 0.6 * self._energy_s
            if i % 4 == 0:
                pygame.draw.line(ov, (255, 255, 255, int(255 * min(0.7, 0.42 * g))), (0, yy), (L.win_w, yy), max(1, L.S(2)))
            else:
                pygame.draw.line(ov, (255, 255, 255, int(255 * min(0.45, 0.22 * g))), (0, yy), (L.win_w, yy), 1)

    def _draw_combo(self, screen):
        combo = self.rhythm.combo
        if combo < 5:
            return
        L = self.L
        s = render_text("display", L.S(240), str(combo), (255, 255, 255))
        s = multiply_alpha(s, 0.07)
        screen.blit(s, s.get_rect(center=(L.X(L.COMBO_POS[0]), L.Y(L.COMBO_POS[1]))))

    def _note_y(self, ev, t) -> float:
        return self.L.slot_y - (ev.timestamp - t) * self.speed

    def _visible_events(self, t) -> list[M.CharEvent]:
        bm = self.rhythm.beat_map
        start = max(0, self.rhythm.char_event_idx - 12)
        out = []
        t_max = t + self.approach + 0.15
        for i in range(start, len(bm)):
            ev = bm[i]
            if ev.is_rest or not ev.char:
                continue
            if ev.timestamp > t_max:
                break
            out.append(ev)
        return out

    def _draw_connectors(self, ov, t, rush):
        L = self.L
        col = KB.GOLD if rush else WHITE
        evs = self._visible_events(t)
        prev = None

        def missed(e):
            return (not e.hit) and t > e.timestamp + self.rhythm.ok_window_for(e)

        for ev in evs:
            if ev.voice >= 0 and not rush:
                col = KB.lane_color(1) if ev.voice == 0 else KB.lane_color(2)
            elif not rush:
                col = WHITE
            if prev is not None and prev.word_id == ev.word_id and (not prev.hit or not ev.hit) and not missed(prev) and not missed(ev):
                y0 = self._note_y(prev, t)
                y1 = self._note_y(ev, t)
                if prev.hit:
                    y0 = L.slot_y
                _l0, x0, _ = self.geom[id(prev)]
                _l1, x1, _ = self.geom[id(ev)]
                spts = [(L.X(x0), L.Y(y0)), (L.X(x1), L.Y(y1))]
                pygame.draw.line(ov, (*col, int(255 * 0.20)), spts[0], spts[1], max(3, L.S(9)))
                pygame.draw.line(ov, (*col, int(255 * 0.55)), spts[0], spts[1], max(2, L.S(3)))
            prev = ev

    def _draw_slot_line(self, screen, t, bar_p, rush):
        L = self.L
        strip = self.slot_strip_gold if rush else self.slot_strip
        screen.blit(strip, (0, L.Y(L.slot_y) - strip.get_height() // 2))
        flash = max(0.0, 1.0 - (t - self.line_flash_t) / 0.25)
        base = 215 + int(40 * flash)
        col = KB.GOLD if rush else (base, base, base)
        y = L.Y(L.slot_y)
        pygame.draw.line(screen, col, (0, y), (L.win_w, y), max(2, L.S(4)))
        # measure sweep across the highway
        sx = L.X(HIGHWAY_X0 + bar_p * LANE_W * 4)
        pygame.draw.line(screen, WHITE, (sx, y), (min(L.win_w, sx + L.S(80)), y), max(2, L.S(6)))

    def _update_rings(self, t, dt):
        # the slot rings never move: one ring per lane, on the lane centre
        for i in range(4):
            self.ring_x[i] = float(self.L.lane_center(i))

    def _draw_rings(self, screen, t, rush):
        L = self.L
        y = L.Y(L.slot_y)
        for lane in range(4):
            hit_age = t - self.ring_hit_t[lane]
            miss_age = t - self.ring_miss_t[lane]
            armed = False
            for ev in self._visible_events(t):
                if not ev.hit and self.geom[id(ev)][0] == lane and 0 <= ev.timestamp - t < 0.3:
                    armed = True
                    break
            alpha = 1.0 if armed else 0.65
            scale = 1.0
            color = None
            if 0 <= hit_age < 0.16:
                scale = 1.0 + 0.25 * math.sin(math.pi * hit_age / 0.16)
                alpha = 1.0
            if 0 <= miss_age < 0.3:
                color = KB.MISS_RED
            if rush:
                color = KB.GOLD
            ring = self.orbs.slot_ring(lane, alpha, color, scale)
            screen.blit(ring, ring.get_rect(center=(L.X(self.ring_x[lane]), y)))
            st, key = self.slip_flash[lane]
            if 0 <= t - st < 0.25 and key:
                s = render_text("display", L.S(24), key.upper(), KB.MISS_RED)
                screen.blit(s, s.get_rect(center=(L.X(self.ring_x[lane]), y + L.S(46))))

    def _draw_notes(self, screen, t, beat_p, rush):
        L = self.L
        slot_y = L.slot_y
        active_hold = self.rhythm._active_hold
        N = self.notes
        use_art = NOTE_ART == "sprite" and N.ok
        for ev in self._visible_events(t):
            lane, x, w = self.geom[id(ev)]
            y = self._note_y(ev, t)
            is_active_hold = active_hold is ev
            if ev.hit and not is_active_hold:
                continue                      # a held anchor is drawn by _draw_anchor_lane
            # dissolving miss: the red note shrinks and fades
            ok_w = self.rhythm.ok_window_for(ev)
            missed_age = (t - ev.timestamp) - ok_w
            if missed_age > 0 and not ev.hit:
                if missed_age > 0.4:
                    continue
                k = missed_age / 0.4
                body = N.miss if (use_art and N.miss is not None) else self.orbs.body(lane, w, KB.MISS_RED)
                body = N.scaled(body, 1.0 - 0.4 * k)
                body = multiply_alpha(body, 1.0 - k)
                screen.blit(body, body.get_rect(center=(L.X(x), L.Y(y))))
                continue
            if y < L.top - 80:
                continue
            col = KB.GOLD if rush else None
            cx, cy = L.X(x), L.Y(min(y, slot_y) if is_active_hold else y)
            # hold tail: a soft rounded bar up to where the hold ends
            if ev.hold_duration > 0:
                end_y = slot_y - (ev.timestamp + ev.hold_duration - t) * self.speed
                top = L.Y(max(L.top - 80, end_y))
                bottom = L.Y(slot_y) if is_active_hold else cy
                if bottom - top > 2:
                    anchor = ev.section_kind == "anchor"
                    tw = L.S(22 if anchor else 16)
                    tcol = KB.lane_color(lane) if anchor else KB.GOLD
                    tail = pygame.Surface((tw, bottom - top), pygame.SRCALPHA)
                    pygame.draw.rect(tail, (*tcol, int(255 * (0.45 if is_active_hold else 0.28))),
                                     tail.get_rect(), border_radius=tw // 2)
                    screen.blit(tail, (cx - tw // 2, top))
                    if anchor and not ev.hit:
                        lbl = render_text("stamp", L.S(14), "HOLD", tcol)
                        screen.blit(lbl, lbl.get_rect(center=(cx, cy - L.S(L.orb_r + 16))))
            # fade-in over the first 15 % of the fall
            fade = 1.0
            k_in = (y - L.spawn_y) / (L.fall_px * 0.15)
            if k_in < 1.0:
                fade = max(0.0, k_in)
            # the downbeat keeps a faint ring that breathes with the beat; lesser beats get the
            # bloom alone, so nothing reads as a hard second ring around the orb
            if w >= 4:
                sc = 1.0 + 0.08 * (1.0 - beat_p)
                ring = self.orbs.outer_ring(lane, sc, col)
                r = ring if fade >= 0.99 else multiply_alpha(ring, fade)
                screen.blit(r, r.get_rect(center=(cx, cy)))
            if use_art:
                if ev.hold_duration > 0 and N.hold is not None:
                    body = N.hold
                elif w >= 2:
                    body = N.note[lane]              # the author's colored note: disk, ring, glow
                else:
                    body = N.plain                   # off-beats: the plain circle, no ring
            else:
                halo = self.orbs.halo(lane, w, col)
                if halo is not None:
                    h = halo if fade >= 0.99 else multiply_alpha(halo, fade)
                    screen.blit(h, h.get_rect(center=(cx, cy)))
                body = self.orbs.body(lane, w, KB.GOLD if ev.hold_duration > 0 else col)
            b = body if fade >= 0.99 else multiply_alpha(body, fade)
            screen.blit(b, b.get_rect(center=(cx, cy)))
            g = self.orbs.glyph(ev.char, KB.INK, 1.0 if w >= 2 else 0.9)
            if fade < 0.99:
                g = multiply_alpha(g, fade)
            screen.blit(g, g.get_rect(center=(cx, cy + L.S(1))))
            if ev.char_idx == 0 and ev.voice < 0:
                screen.blit(self.petal_img, self.petal_img.get_rect(center=(cx - L.S(10), cy - L.S(44))))

    def _draw_effects(self, screen, t, dt):
        L = self.L
        # the press feedback: the starburst expanding and fading out from under the slot ring,
        # with the author's nine-frame ring animation riding on top of it
        keep = []
        for a in self.hit_anims:
            age = t - a['t0']
            if age < 0:
                keep.append(a)
                continue
            alive = False
            frames = self.notes.hit.get(a['lane']) or []
            idx = int(age / 0.30 * len(frames)) if frames else 99
            if 0 <= idx < len(frames):
                f = frames[idx]
                screen.blit(f, f.get_rect(center=(L.X(a['x']), L.Y(a['y']))))
                alive = True
            # the starburst last, so its spokes read over the author's ring
            if age < STAR_LIFE:
                k = age / STAR_LIFE
                reach = 1.0 - (1.0 - k) ** 3                      # fast out, easing to a stop
                big = a['judgment'] == 'perfect'
                r = L.S((52 if big else 42) + (84 if big else 56) * reach)
                # holds solid for the first third, then eases out — a flash, not a smear
                fade = 1.0 if k < 0.34 else (1.0 - (k - 0.34) / 0.66) ** 1.5
                star = self.orbs.hit_star(a['lane'], r, fade, a.get('color'))
                screen.blit(star, star.get_rect(center=(L.X(a['x']), L.Y(a['y']))))
                alive = True
            if alive:
                keep.append(a)
        self.hit_anims = keep
        # bursts (rings) — fallback when the animation frames are missing
        keep = []
        for b in self.bursts:
            b.age += dt
            if b.age > 0.32:
                continue
            k = b.age / 0.32
            r1 = int(L.S(40 + 26 * k))
            ring = self.orbs.burst_ring(b.lane, r1, L.S(4), 0.55 * (1 - k), b.color)
            screen.blit(ring, ring.get_rect(center=(L.X(b.x), L.Y(b.y))))
            if b.kind == 'perfect':
                r2 = int(L.S(40 + 52 * k))
                ring2 = self.orbs.burst_ring(b.lane, r2, L.S(2), 0.22 * (1 - k), b.color)
                screen.blit(ring2, ring2.get_rect(center=(L.X(b.x), L.Y(b.y))))
            keep.append(b)
        self.bursts = keep
        # shards
        keep = []
        for s in self.shards:
            s['age'] += dt
            if s['age'] > s['life']:
                continue
            s['x'] += s['vx'] * dt
            s['y'] += s['vy'] * dt
            k = s['age'] / s['life']
            img = pygame.transform.rotate(s['img'], -math.degrees(s['ang']))
            img = multiply_alpha(img, 1 - k * k)
            screen.blit(img, img.get_rect(center=(L.X(s['x']), L.Y(s['y']))))
            keep.append(s)
        self.shards = keep
        # sparks
        keep = []
        for p in self.sparks:
            p['age'] += dt
            if p['age'] > p['life']:
                continue
            p['x'] += p['vx'] * dt
            p['y'] += p['vy'] * dt
            p['vy'] += 300 * dt
            k = 1 - p['age'] / p['life']
            r = max(1, int(L.S(p['r'] * k)))
            pygame.draw.circle(screen, p['col'], (L.X(p['x']), L.Y(p['y'])), r)
            keep.append(p)
        self.sparks = keep
        # stamps
        keep = []
        for st in self.stamps:
            age = t - st['t0']
            if age > 0.75:
                continue
            if age < 0.1:
                sc = 0.6 + 0.4 * (1 - (1 - age / 0.1) ** 3)
            else:
                sc = 1.0
            alpha = 1.0 if age < 0.5 else max(0.0, 1 - (age - 0.5) / 0.25)
            rise = 20 * min(1.0, age / 0.75)
            kind = st['kind']
            if kind == 'slip':
                text = f"SLIP · {st['extra']}"
                px = L.S(26)
            else:
                text = STAMP_TEXT.get(kind, kind.upper())
                px = L.S(36)
            s = render_text("stamp", px, text, STAMP_COLORS.get(kind, WHITE))
            if abs(sc - 1.0) > 0.01:
                s = pygame.transform.smoothscale(s, (max(1, int(s.get_width() * sc)), max(1, int(s.get_height() * sc))))
            if alpha < 1.0:
                s = multiply_alpha(s, alpha)
            screen.blit(s, s.get_rect(center=(L.X(st['x']), L.Y(st['y'] - rise))))
            if st['tag']:
                tg = render_text("body_bold", L.S(16), st['tag'], (200, 200, 220))
                if alpha < 1.0:
                    tg = multiply_alpha(tg, alpha)
                screen.blit(tg, tg.get_rect(center=(L.X(st['x']), L.Y(st['y'] - rise + 30))))
            keep.append(st)
        self.stamps = keep

    # sections
    def _draw_shockwaves(self, screen, t, dt):
        L = self.L
        keep = []
        for w in self.shockwaves:
            k = (t - w['t0']) / w['dur']
            if k >= 1.0:
                continue
            e = 1 - (1 - k) ** 2
            r = max(2, L.S(60 + (w['r1'] - 60) * e))
            width = max(2, L.S(14 * (1 - k)))
            ring = self.orbs.burst_ring(0, r, width, 0.55 * (1 - k) ** 1.2, w['col'])
            screen.blit(ring, ring.get_rect(center=(L.X(w['x']), L.Y(w['y']))))
            keep.append(w)
        self.shockwaves = keep
        flash = 1.0 - (t - self.drop_t) / 0.35
        if 0 < flash <= 1.0:
            self._dim.fill((255, 255, 255, int(90 * flash * flash)))
            screen.blit(self._dim, (0, 0))

    def _draw_dust(self, screen, t, dt):
        """Slow motes drifting up the highway in the quiet stretches; gone when the song drives."""
        L = self.L
        calm = max(0.0, 1.0 - self._energy_s * 1.6)
        if calm > 0.05 and len(self.dust) < 36 and self._rng.random() < 0.35 * calm:
            self.dust.append({'x': self._rng.uniform(HIGHWAY_X0 - 60, HIGHWAY_X0 + 4 * LANE_W + 60),
                              'y': L.slot_y - self._rng.uniform(0, 40), 'vx': self._rng.uniform(-8, 8),
                              'vy': -self._rng.uniform(22, 48), 'r': self._rng.uniform(1.5, 3.5),
                              'life': self._rng.uniform(4.0, 7.0), 'age': 0.0, 'ph': self._rng.uniform(0, math.tau)})
        keep = []
        for d in self.dust:
            d['age'] += dt
            if d['age'] > d['life']:
                continue
            d['x'] += (d['vx'] + 10 * math.sin(t * 0.8 + d['ph'])) * dt
            d['y'] += d['vy'] * dt
            k = d['age'] / d['life']
            a = math.sin(math.pi * k) * (0.55 * calm + 0.05)
            if a > 0.02:
                pygame.draw.circle(screen, tuple(int(c * a + 12 * (1 - a)) for c in (222, 220, 255)),
                                   (L.X(d['x']), L.Y(d['y'])), max(1, L.S(d['r'])))
            keep.append(d)
        self.dust = keep

    def _draw_milestone(self, screen, t):
        if self.milestone is None:
            return
        n, t0 = self.milestone
        age = t - t0
        if age > 1.1:
            self.milestone = None
            return
        L = self.L
        pop = 1.0 + 0.35 * max(0.0, 1.0 - age / 0.18) ** 2
        a = 1.0 if age < 0.7 else max(0.0, 1.0 - (age - 0.7) / 0.4)
        s = render_text("display", int(L.S(120) * pop), str(n), KB.GOLD)
        s = multiply_alpha(s, 0.9 * a)
        cx, cy = L.X(L.COMBO_POS[0]), L.Y(L.COMBO_POS[1]) - L.S(30 * min(1.0, age / 1.1))
        screen.blit(s, s.get_rect(center=(cx, cy)))
        lbl = render_text("stamp", L.S(26), "COMBO", KB.GOLD)
        lbl = multiply_alpha(lbl, 0.8 * a)
        screen.blit(lbl, lbl.get_rect(center=(cx, cy + s.get_height() // 2 + L.S(10))))
        if age < 0.5:
            ring = self.orbs.burst_ring(0, max(2, L.S(80 + 260 * age)), max(2, L.S(4)), 0.5 * (1 - age / 0.5), KB.GOLD)
            screen.blit(ring, ring.get_rect(center=(cx, cy)))

    def _draw_section_tag(self, screen, t):
        """A small label at the top while a phrase is a build or a hold, fading at its edges."""
        ph = self.phrase_at(t)
        if ph is None or ph[3] not in SECTION_TAG:
            return
        _i, t0, t1, kind = ph
        L = self.L
        if kind == "anchor":
            # only while there is something to hold: an anchor on screen, held, or just finished
            pending = any(e.section_kind == "anchor" and not e.hit for e in self._visible_events(t))
            if self.anchor_ev is None and not pending and t > self.anchor_end_t + 0.6:
                return
        k = min(1.0, (t - t0) / 0.4) * min(1.0, (t1 - t) / 0.4)
        if k <= 0:
            return
        text = SECTION_TAG[kind]
        col = KB.GOLD if kind == "pattern" else KB.lane_color(2)
        s = render_text("stamp", L.S(24), text, col)
        s = multiply_alpha(s, 0.85 * k)
        cx, cy = L.X(HIGHWAY_CX), L.Y(L.top + 40)
        screen.blit(s, s.get_rect(center=(cx, cy)))
        w = L.S(160)
        y = cy + L.S(18)
        pygame.draw.line(screen, tuple(int(c * 0.55 * k) for c in col), (cx - w // 2, y), (cx + w // 2, y), max(1, L.S(2)))
        if kind == "pattern":
            # the build's progress fills the line
            prog = (t - t0) / max(1e-3, t1 - t0)
            pygame.draw.line(screen, tuple(int(c * k) for c in col), (cx - w // 2, y), (cx - w // 2 + int(w * prog), y), max(2, L.S(3)))

    def _draw_anchor_lane(self, screen, t):
        """While an anchor is held: its lane glows, a bar sinks from the top as the hold runs down,
        and the held key sits big on the slot ring.  Red for a moment when it breaks."""
        L = self.L
        ev = self.anchor_ev
        broke = t - self.anchor_break_t
        if ev is None and not (0 <= broke < 0.4):
            gold = t - self.anchor_end_t
            if not (0 <= gold < 0.5):
                return
        if ev is not None:
            lane = ev.lane if ev.lane >= 0 else KB.lane_of(ev.char)
            col = KB.lane_color(lane)
            end = ev.timestamp + ev.hold_duration
            prog = max(0.0, min(1.0, (t - ev.timestamp) / max(1e-3, ev.hold_duration)))
            a = 1.0
        else:
            lane = -1
            col = KB.MISS_RED if 0 <= broke < 0.4 else KB.GOLD
            a = (1.0 - broke / 0.4) if 0 <= broke < 0.4 else (1.0 - (t - self.anchor_end_t) / 0.5)
            prog = 1.0
        if lane < 0:
            # remember the last lane through the fade
            lane = getattr(self, "_anchor_last_lane", 0)
        self._anchor_last_lane = lane
        x0, x1 = L.X(L.lane_x0(lane)), L.X(L.lane_x0(lane) + LANE_W)
        top, bottom = L.Y(L.top), L.Y(L.slot_y)
        fill = self.duet_fills[lane] if 0 <= lane < 4 else None
        if fill is not None:
            f = multiply_alpha(fill, 0.9 * a)
            if col is not KB.lane_color(lane):
                f.fill((*col, 255), special_flags=pygame.BLEND_RGBA_MULT)
            screen.blit(f, (x0, top))
        # the remaining hold as a bar in the lane, shrinking towards the slot
        if ev is not None:
            h = int((bottom - top) * (1.0 - prog))
            bw = L.S(22)
            cx = L.X(L.lane_center(lane))
            bar = pygame.Surface((bw, max(2, h)), pygame.SRCALPHA)
            pygame.draw.rect(bar, (*col, int(255 * 0.55)), bar.get_rect(), border_radius=bw // 2)
            screen.blit(bar, (cx - bw // 2, bottom - h))
            pulse = 0.5 + 0.5 * (1.0 - self.beat_phase(t)[1])
            ring = self.orbs.burst_ring(lane, L.S(self.L.slot_ring_r + 10 + 6 * pulse), max(2, L.S(3)), 0.5 + 0.4 * pulse, col)
            screen.blit(ring, ring.get_rect(center=(cx, bottom)))
            key = render_text("display", L.S(54), ev.char.upper(), WHITE)
            screen.blit(key, key.get_rect(center=(cx, bottom)))
            lbl = render_text("stamp", L.S(16), "HOLD", col)
            screen.blit(lbl, lbl.get_rect(center=(cx, bottom + L.S(self.L.slot_ring_r + 26))))

    # word block
    def _word_slot_x(self, n_letters: int, idx: int) -> float:
        adv = self.L.word_advance
        return HIGHWAY_CX - (n_letters - 1) * adv / 2 + idx * adv

    def _glyph_glow(self, ch: str, lane: int, px: int) -> pygame.Surface:
        """A soft round glow behind the current letter (a blurred glyph read as a box)."""
        key = ("glow", lane, px)
        s = self.glyph_glow_cache.get(key)
        if s is None:
            s = glow_disk(max(4, int(px * 0.6)), KB.lane_color(lane), 0.38)
            self.glyph_glow_cache[key] = s
        return s

    def _draw_word_block(self, screen, t, rush):
        L = self.L
        evs = self.rhythm.current_word_events()
        px = L.S(L.word_size)
        y = L.Y(L.word_y)
        if evs:
            word = evs[0].word_text
            n = len(word)
            flying_slots = {(f['word_id'], f['char_idx']) for f in self.flying if f['kind'] == 'glyph'}
            by_idx = {e.char_idx: e for e in evs}
            cur_ev = self.rhythm.current_event()
            cur_idx = cur_ev.char_idx if (cur_ev is not None and not cur_ev.is_rest and cur_ev.word_id == evs[0].word_id) else -1
            hold = self.rhythm._active_hold
            if hold is not None and hold.word_id == evs[0].word_id:
                cur_idx = hold.char_idx
            for i, ch in enumerate(word):
                x = L.X(self._word_slot_x(n, i))
                e = by_idx.get(i)
                typed = e is not None and e.hit and (evs[0].word_id, i) not in flying_slots
                if e is None:
                    surf = render_text("display", px, ch, (255, 255, 255))
                    surf = multiply_alpha(surf, 0.22)
                elif typed:
                    surf = render_text("display", px, ch, KB.GOLD if rush else KB.lane_color(e.lane))
                elif i == cur_idx:
                    glow = self._glyph_glow(ch, e.lane, px)
                    screen.blit(glow, glow.get_rect(center=(x, y)))
                    surf = render_text("display", px, ch, (255, 255, 255))
                    # underline caret
                    pulse = 0.6 + 0.4 * (1.0 - self.beat_phase(t)[1])
                    uw = L.S(40)
                    uy = y + px // 2 + L.S(6)
                    pygame.draw.rect(screen, tuple(int(c * pulse) for c in KB.lane_color(e.lane)),
                                     (x - uw // 2, uy, uw, max(2, L.S(4))))
                elif (evs[0].word_id, i) in flying_slots:
                    surf = render_text("display", px, ch, (255, 255, 255))
                    surf = multiply_alpha(surf, 0.4)
                else:
                    surf = render_text("display", px, ch, (255, 255, 255))
                    surf = multiply_alpha(surf, 0.40)
                screen.blit(surf, surf.get_rect(center=(x, y)))
        # the word just finished lifts off and fades — gold when it was clean
        age = t - self.word_flash_t
        if self.word_flash is not None and 0 <= age < 0.45:
            word, clean = self.word_flash
            k = age / 0.45
            e = 1 - (1 - k) ** 2
            n = len(word)
            for i, ch in enumerate(word):
                col = KB.GOLD if (clean or rush) else KB.lane_color(KB.lane_of(ch))
                surf = render_text("display", int(px * (1.0 + 0.18 * e)), ch, col)
                surf = multiply_alpha(surf, (1 - k) ** 1.2 * 0.9)
                screen.blit(surf, surf.get_rect(center=(L.X(self._word_slot_x(n, i)), y - L.S(46 * e))))
        # queue, stacked
        for (row_y, row_px, row_a), w in zip(L.queue_rows, self.rhythm.upcoming_words(len(L.queue_rows))):
            self._blit_spaced(screen, "display_regular", L.S(row_px), w, L.X(HIGHWAY_CX), L.Y(row_y), (255, 255, 255), L.S(row_px * 0.35), row_a)
        # flying glyphs and petals
        keep = []
        for f in self.flying:
            k = (t - f['t0']) / f['dur']
            if k >= 1.0:
                continue
            e = 1 - (1 - k) ** 3
            if f['kind'] == 'glyph':
                evs2 = evs
                if evs2 and evs2[0].word_id == f['word_id']:
                    x1, y1 = self._word_slot_x(len(evs2[0].word_text), f['char_idx']), L.word_y
                else:
                    x1, y1 = f['x0'], f['y0'] + 60
                x = f['x0'] + (x1 - f['x0']) * e
                yy = f['y0'] + (y1 - f['y0']) * e
                s = render_text("display", px, f['ch'], KB.lane_color(f['lane']))
                s = multiply_alpha(s, 0.5 + 0.5 * e)
                screen.blit(s, s.get_rect(center=(L.X(x), L.Y(yy))))
            else:
                x = f['x0'] + (f['x1'] - f['x0']) * e
                yy = f['y0'] + (f['y1'] - f['y0']) * e - 80 * math.sin(math.pi * e)
                pygame.draw.circle(screen, KB.lane_color(0), (L.X(x), L.Y(yy)), L.S(7))
            keep.append(f)
        self.flying = keep

    def _blit_spaced(self, screen, kind, px, text, cx, cy, color, spacing, alpha=1.0):
        surfs = [render_text(kind, px, ch, color) for ch in text]
        total = sum(s.get_width() for s in surfs) + spacing * (len(surfs) - 1)
        x = cx - total // 2
        for s in surfs:
            if alpha < 1.0:
                s = multiply_alpha(s, alpha)
            screen.blit(s, (x, cy - s.get_height() // 2))
            x += s.get_width() + spacing

    # HUD
    def _draw_hud(self, screen, t, dt, rush):
        L = self.L
        stats = self.rhythm
        target = stats.get_score()
        self._score_shown += (target - self._score_shown) * min(1.0, 8.0 * dt)
        if abs(target - self._score_shown) < 2:
            self._score_shown = target
        s = render_text("display", L.S(48), f"{int(self._score_shown):,}", WHITE, cache=False)
        screen.blit(s, (L.X(L.SCORE_POS[0]), L.Y(L.SCORE_POS[1]) - s.get_height() // 2))
        m = render_text("display", L.S(30), f"x{self.combo_tier}", KB.GOLD)   # Tacobae has no ×
        screen.blit(m, (L.X(L.MULT_POS[0]), L.Y(L.MULT_POS[1]) - m.get_height() // 2))
        # rush bar
        bx, by, bw, bh = L.RUSH_BAR
        rect = pygame.Rect(L.X(bx), L.Y(by), L.S(bw), L.S(bh))
        pygame.draw.rect(screen, (26, 26, 38), rect, border_radius=L.S(6))
        fill = self.rush_charge
        if rush:
            fill = max(0.0, (self.rush_until - t) / (C.RUSH_BARS * self.bar_dur))
        if fill > 0:
            fr = pygame.Rect(rect.x, rect.y, max(L.S(6), int(rect.w * fill)), rect.h)
            bar = pygame.Surface(fr.size, pygame.SRCALPHA)
            bar.fill((184, 162, 74, 255))
            step = max(4, L.S(18))
            for sx in range(-fr.h, fr.w + fr.h, step):      # diagonal gold stripes, as in the figure
                pygame.draw.polygon(bar, (*KB.GOLD, 255), [(sx, fr.h), (sx + fr.h, 0), (sx + fr.h + step // 2, 0), (sx + step // 2, fr.h)])
            mask = pygame.Surface(fr.size, pygame.SRCALPHA)
            pygame.draw.rect(mask, (255, 255, 255, 255), mask.get_rect(), border_radius=L.S(6))
            bar.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MIN)
            screen.blit(bar, fr.topleft)
        pygame.draw.rect(screen, (90, 90, 110), rect, 1, border_radius=L.S(6))
        # lives
        lx, ly = L.LIVES_POS
        for i in range(C.LIVES):
            col = KB.lane_color(0) if i < self.lives else (48, 42, 58)
            r = L.S(6)
            if i == self.lives - 1 and self.lives == 1:
                r = L.S(6 + 2 * abs(math.sin(t * 4)))
            pygame.draw.circle(screen, col, (L.X(lx + i * 20), L.Y(ly)), r)
        # accuracy
        a = render_text("display", L.S(40), f"{stats.get_accuracy():.1f} %", WHITE, cache=False)
        screen.blit(a, (L.X(L.ACC_POS[0]) - a.get_width(), L.Y(L.ACC_POS[1]) - a.get_height() // 2))
        # progress along the top edge
        dur = max(1.0, float(self.song.duration))
        prog = max(0.0, min(1.0, (t - self.lead_in) / dur))
        ph = max(2, L.S(L.PROGRESS_H))
        pygame.draw.rect(screen, (40, 40, 52), (0, 0, L.win_w, ph))
        pygame.draw.rect(screen, KB.GOLD if rush else (100, 200, 255), (0, 0, int(L.win_w * prog), ph))

    # duet
    def _draw_duet_strip(self, screen, t, duet):
        L = self.L
        t0, t1, shape = duet
        fade_in = min(1.0, max(0.0, (t - (t0 - 2 * self.bar_dur)) / self.beat_dur))
        fade_out = min(1.0, max(0.0, (t1 - t) / (2 * self.beat_dur)))
        k = fade_in * fade_out
        if k <= 0:
            return
        voice = self._active_voice(t)
        locked = self._lock_t >= 0 and self.heat[0] >= 3 and self.heat[1] >= 3
        for lane in range(4):
            hand = 0 if lane < 2 else 1
            if voice < 0:
                a = 0.5
            elif hand == voice:
                a = 0.45 + 0.55 * min(1.0, self.heat[hand] / 3.0)
            else:
                a = 0.18
            surf = self.duet_fills[lane]
            s = multiply_alpha(surf, a * k)
            screen.blit(s, (L.X(L.lane_x0(lane)), L.Y(L.top)))
            b = multiply_alpha(self.duet_band, a * k * 0.55)
            b.fill((*KB.lane_color(lane), 255), special_flags=pygame.BLEND_RGBA_MULT)
            screen.blit(b, (L.X(L.lane_x0(lane)), L.Y(L.slot_y) - self.duet_band.get_height() + L.S(10)))
        if locked:
            g = multiply_alpha(self.duet_gold, k * (0.7 + 0.3 * abs(math.sin(t * 3))))
            screen.blit(g, (L.X(HIGHWAY_X0), L.Y(L.top)))
        # lane dividers in lane colors
        for lane in range(4):
            x = L.X(L.lane_x0(lane))
            pygame.draw.line(screen, tuple(int(c * 0.45 * k + 12) for c in KB.lane_color(lane)), (x, L.Y(L.top)), (x, L.Y(L.slot_y)), 1)

    def _draw_duet_mark(self, screen, t, duet):
        L = self.L
        t0, t1, shape = duet
        k = min(1.0, max(0.0, (t - (t0 - 2 * self.bar_dur)) / self.beat_dur)) * min(1.0, max(0.0, (t1 - t) / self.beat_dur))
        if k <= 0:
            return
        mark = render_text("stamp", L.S(24), "DUET", KB.GOLD)
        mark = multiply_alpha(mark, 0.8 * k)
        screen.blit(mark, mark.get_rect(center=(L.X(HIGHWAY_CX), L.Y(L.top + 40))))
        # lock meter: two halves, one per hand
        w, hgt = L.S(160), L.S(6)
        x0, y0 = L.X(HIGHWAY_CX - 80), L.Y(L.top + 60)
        pygame.draw.rect(screen, (26, 26, 38), (x0, y0, w, hgt), border_radius=hgt // 2)
        half = w // 2
        lw = int(half * min(1.0, self.heat[0] / 3.0))
        rw = int(half * min(1.0, self.heat[1] / 3.0))
        if lw:
            pygame.draw.rect(screen, KB.lane_color(1), (x0 + half - lw, y0, lw, hgt))
        if rw:
            pygame.draw.rect(screen, KB.lane_color(2), (x0 + half, y0, rw, hgt))
        if self._lock_t >= 0 and self.heat[0] >= 3 and self.heat[1] >= 3:
            age = t - self._lock_t
            if age < 1.2:
                s = render_text("stamp", L.S(40), "LOCKED IN", KB.GOLD)
                s = multiply_alpha(s, max(0.0, 1.0 - age / 1.2))
                screen.blit(s, s.get_rect(center=(L.X(HIGHWAY_CX), L.Y(L.top + 150) - L.S(30 * age))))

    def _draw_duet_word_band(self, screen, t):
        L = self.L
        voice = self._active_voice(t)
        if voice < 0:
            return
        col = KB.lane_color(1) if voice == 0 else KB.lane_color(2)
        cx, cy, w, hh = L.X(HIGHWAY_CX), L.Y(L.word_y + 20), L.S(22), L.S(16)
        if voice == 0:
            pts = [(cx - w, cy), (cx + w // 2, cy - hh), (cx + w // 2, cy + hh)]
        else:
            pts = [(cx + w, cy), (cx - w // 2, cy - hh), (cx - w // 2, cy + hh)]
        pygame.draw.polygon(screen, tuple(int(c * 0.8) for c in col), pts)

    # Noki
    def _draw_noki(self, screen, t, dt):
        L = self.L
        if L.noki_placement == "hidden" or not self.noki_bop:
            return
        n = len(self.noki_bop)
        beat_i, p = self.beat_phase(t)
        if beat_i < 0:
            p = (t / self.beat_dur) % 1.0
            beat_i = int(t / self.beat_dur)
        if self.beat_dur < 60.0 / 250.0:
            norm = ((beat_i % 4) + p) / 4.0
        else:
            norm = ((beat_i % 2) + p) / 2.0
        frame = self.noki_bop[int(norm * n) % n]
        nx, ny, nw, nh = L.noki_rect
        x, y = L.X(nx), L.Y(ny + nh) - frame.get_height()
        d = self.duet_at(t)
        if d is not None and t >= d[0]:
            v = self._active_voice(t)
            if v >= 0:
                col = KB.lane_color(1) if v == 0 else KB.lane_color(2)
                key = ("nokiglow", col)
                g = self.glyph_glow_cache.get(key)
                if g is None:
                    g = glow_disk(L.S(150), col, 0.16)
                    self.glyph_glow_cache[key] = g
                screen.blit(g, g.get_rect(center=(x + frame.get_width() // 2, y + frame.get_height() * 0.6)))
        if t < self.nap_until:
            frame = multiply_alpha(frame, 0.55)
        # while the hurt take plays it *replaces* the bop: drawing both left the bopping head
        # visible behind the shaking one
        hurt_frame = None
        if self._hurt_t >= 0 and self.noki_hurt:
            idx = int((t - self._hurt_t) * 30 * 1.15)
            if 0 <= idx < len(self.noki_hurt):
                hurt_frame = self.noki_hurt[idx]
            elif idx >= len(self.noki_hurt):
                self._hurt_t = -1.0
        if hurt_frame is not None:
            screen.blit(hurt_frame, (x + (frame.get_width() - hurt_frame.get_width()) // 2,
                                     L.Y(ny + nh) - hurt_frame.get_height()))
        else:
            screen.blit(frame, (x, y))

    def _draw_count_in(self, screen, t):
        L = self.L
        if not self.title or t > self.lead_in:
            return
        a = min(1.0, t / 0.6) * min(1.0, max(0.0, (self.lead_in - t) / 0.5))
        if a <= 0:
            return
        s = render_text("display", L.S(40), self.title, WHITE)
        s = multiply_alpha(s, a)
        screen.blit(s, s.get_rect(center=(L.X(HIGHWAY_CX), L.Y(L.top + 120))))
        if self.artist:
            s2 = render_text("body", L.S(22), self.artist, (200, 200, 220))
            s2 = multiply_alpha(s2, a * 0.8)
            screen.blit(s2, s2.get_rect(center=(L.X(HIGHWAY_CX), L.Y(L.top + 160))))
