"""
edge_glitch.py — strip-based edge curvature / dissolve renderer.

The effect is applied at the LEFT and RIGHT edges of the TIMELINE, not
the screen.  The timeline spans ~x=[300, 1500]; the glitch zone covers
the outermost 1/EDGE_FRAC of that span on each side.

Strategy
--------
After the main frame is rendered, each edge zone is:

  1. Captured into a pre-allocated buffer (1 blit).
  2. Erased from screen (1 fill).
  3. Re-drawn as horizontal strips offset by dy = curve(t) + scatter(t),
     and occasionally skipped for the dissolve effect.  t = 0 at the zone
     boundary (no distortion), t = 1 at the timeline edge (max distortion).
  4. Overlaid with a pre-baked alpha gradient that fades to black (1 blit).

Complexity
----------
  O(H / STRIP_H × N_COLS) pygame.blit calls per edge per frame.
  All pixel operations are C-level.  The Python loop only supplies coords.

  At 1920×1080, STRIP_H=5, N_COLS=3:
    (1080/5) × 3 × 2 edges = 1296 blit calls/frame ≈ negligible.
"""
from __future__ import annotations
import math
import pygame


# ── Tuning ────────────────────────────────────────────────────────────────────

STRIP_H     = 8       # scanline strip height in pixels (larger = squarer pixels)
MAX_CURVE   = 16      # max downward Y offset at the timeline edge (pixels)
MAX_SCATTER = 7       # max ± stochastic Y offset at the timeline edge (pixels)
DISSOLVE_K  = 0.55    # t at which dissolve begins (0–1); lower = fades out sooner
EDGE_FRAC   = 1 / 25  # fraction of timeline width per edge zone (~40% smaller area)
# N_COLS is now computed dynamically as max(1, ew // STRIP_H) so each pixel
# is approximately STRIP_H × STRIP_H (square).


class EdgeGlitchRenderer:
    """
    Post-process renderer for the left/right edge glitch effect.

    Usage
    -----
    At game init::

        self._edge_glitch = EdgeGlitchRenderer(sw, sh)

    Once per frame, after all other rendering::

        self._edge_glitch.apply(
            self.screen,
            int(self.timeline_current_start),
            int(self.timeline_current_end),
            int(time.perf_counter() * 30),
        )
    """

    def __init__(self, screen_w: int, screen_h: int) -> None:
        self.sw = screen_w
        self.sh = screen_h

        # Maximum possible zone width — used to size the capture buffers once.
        self._max_ew = max(8, int(screen_w * EDGE_FRAC))

        # Pre-bake noise once.  Table is large enough that (row, col, seed)
        # combinations don't visibly repeat within a typical play session.
        # Use a generous size since N_COLS is now dynamic (up to ~zone_w/STRIP_H).
        n_strips = math.ceil(screen_h / STRIP_H)
        self._noise = _bake_noise(n_strips * 32 * 4 + 2048)

        # Reusable capture buffers — sized to the max possible zone width.
        # .convert() ensures the pixel format matches the display surface.
        self._lbuf = pygame.Surface((self._max_ew, screen_h)).convert()
        self._rbuf = pygame.Surface((self._max_ew, screen_h)).convert()

        # Fade surfaces are keyed by zone_w so they rebuild only when the
        # timeline width changes (typically never during gameplay).
        self._fade_cache: dict[int, tuple[pygame.Surface, pygame.Surface]] = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    def apply(
        self,
        screen: pygame.Surface,
        timeline_x0: int,
        timeline_x1: int,
        frame_seed: int,
        y0: int = 0,
        y1: int = -1,
        right_edge: bool = True,
    ) -> None:
        """
        Apply the edge glitch to the timeline's left (and optionally right) margins.

        Parameters
        ----------
        screen       : surface being rendered to
        timeline_x0  : left edge of the timeline (e.g. timeline_current_start)
        timeline_x1  : right edge of the timeline (e.g. timeline_current_end)
        frame_seed   : integer advancing each frame (e.g. int(time*30))
        y0, y1       : vertical band to affect (default: full screen height)
        right_edge   : whether to also glitch the right edge (False = left only)
        """
        sh = self.sh
        if y1 < 0:
            y1 = sh
        y0 = max(0, y0)
        y1 = min(sh, y1)
        band_h = y1 - y0
        if band_h <= 0:
            return

        zone_w = max(8, int((timeline_x1 - timeline_x0) * EDGE_FRAC))
        zone_w = min(zone_w, self._max_ew)   # clamp to buffer capacity

        lfade, rfade = self._get_fades(zone_w)

        lx = timeline_x0                 # left zone:  [lx,      lx + zone_w]
        rx = timeline_x1 - zone_w        # right zone: [rx,      rx + zone_w]

        # 1. Snapshot edge zones (full height so strip source pixels are correct).
        self._lbuf.blit(screen, (0, 0), area=(lx, 0, zone_w, sh))
        if right_edge:
            self._rbuf.blit(screen, (0, 0), area=(rx, 0, zone_w, sh))

        # 2. Erase only the y-band from the screen.
        screen.fill((0, 0, 0), (lx, y0, zone_w, band_h))
        if right_edge:
            screen.fill((0, 0, 0), (rx, y0, zone_w, band_h))

        # 3. Re-draw strips with curvature + scatter + dissolve (within y-band).
        self._redraw_edge(screen, self._lbuf, dest_x=lx, left=True,
                          ew=zone_w, seed=frame_seed, y0=y0, y1=y1)
        if right_edge:
            self._redraw_edge(screen, self._rbuf, dest_x=rx, left=False,
                              ew=zone_w, seed=frame_seed, y0=y0, y1=y1)

        # 4. Fade to black overlay — blit only the y-band portion.
        screen.blit(lfade, (lx, y0), area=(0, y0, zone_w, band_h),
                    special_flags=pygame.BLEND_MULT)
        if right_edge:
            screen.blit(rfade, (rx, y0), area=(0, y0, zone_w, band_h),
                        special_flags=pygame.BLEND_MULT)

    # ── Private ────────────────────────────────────────────────────────────────

    def _get_fades(
        self, zone_w: int
    ) -> tuple[pygame.Surface, pygame.Surface]:
        """Return (left_fade, right_fade) for this zone width, building once."""
        if zone_w not in self._fade_cache:
            self._fade_cache[zone_w] = (
                _make_fade_surface(zone_w, self.sh, left=True),
                _make_fade_surface(zone_w, self.sh, left=False),
            )
        return self._fade_cache[zone_w]

    def _redraw_edge(
        self,
        screen: pygame.Surface,
        buf: pygame.Surface,
        dest_x: int,
        left: bool,
        ew: int,
        seed: int,
        y0: int = 0,
        y1: int = -1,
    ) -> None:
        """
        Iterate over strips of *buf* and blit each to *screen* with
        computed dy offset and optional dissolve skip.

        No surface copies — blit() reads source pixels directly from buf.
        N_COLS is computed dynamically so each pixel is approximately square
        (col_w ≈ STRIP_H).
        """
        sh     = self.sh
        if y1 < 0:
            y1 = sh
        noise  = self._noise
        n_len  = len(noise)
        # Dynamic column count: make pixels approximately square
        n_cols = max(1, ew // STRIP_H)
        col_w  = max(1, ew // n_cols)
        inv_dk = 1.0 / max(1e-6, 1.0 - DISSOLVE_K)

        # Align y0 to a strip boundary so strips tile cleanly
        row = y0 // STRIP_H
        y   = row * STRIP_H
        while y < y1:
            strip_h = min(STRIP_H, y1 - y)
            base_ni = (row * n_cols * 3 + seed * 17) % n_len

            for col in range(n_cols):
                cx = col * col_w
                cw = col_w if col < n_cols - 1 else (ew - cx)

                # t: 0 at zone boundary, 1 at timeline edge
                mid_x = cx + cw // 2
                t = (1.0 - mid_x / ew) if left else (mid_x / ew)

                # ── Dissolve ──────────────────────────────────────────────────
                ni_d = (base_ni + col * 131) % n_len
                if t > DISSOLVE_K:
                    threshold = 1.0 - 2.0 * (t - DISSOLVE_K) * inv_dk
                    if noise[ni_d] > threshold:
                        continue

                # ── Y displacement ────────────────────────────────────────────
                t2         = t * t
                curve_dy   = int(MAX_CURVE * t2)
                ni_s       = (base_ni + col * 59 + 7) % n_len
                scatter_dy = int(noise[ni_s] * MAX_SCATTER * t)
                dy         = curve_dy + scatter_dy

                # ── Blit — direct area read, no intermediate surface copy ─────
                screen.blit(buf, (dest_x + cx, y + dy), (cx, y, cw, strip_h))

            y   += STRIP_H
            row += 1


# ── Module helpers ────────────────────────────────────────────────────────────

def _bake_noise(n: int) -> list[float]:
    """
    Deterministic pseudo-noise table of *n* values in [-1, 1].
    Uses an LCG with index salt — no stdlib random, no math.sin.
    """
    result: list[float] = []
    h = 0
    for i in range(n):
        h = (h * 1664525 + 1013904223 + i * 22695477) & 0xFFFFFFFF
        result.append(h / 0x80000000 - 1.0)
    return result


def _make_fade_surface(w: int, h: int, left: bool) -> pygame.Surface:
    """
    Pre-baked BLEND_MULT gradient: white (255,255,255) at zone boundary
    (no darkening) → black (0,0,0) at timeline edge (full darkening).
    t² curve.  No SRCALPHA — plain RGB so BLEND_MULT works on the display surface.
    """
    surf = pygame.Surface((w, h))
    surf.fill((255, 255, 255))
    for x in range(w):
        t = (1.0 - x / w) if left else (x / w)
        v = int(255 * (1.0 - t * t))   # 255 at boundary, 0 at edge
        if v < 255:
            pygame.draw.line(surf, (v, v, v), (x, 0), (x, h - 1))
    return surf
