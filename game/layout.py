"""
Layout — every play-screen number in one place, in 1920×1080 design units,
scaled to the real window so the play field fills it.

Nothing in the renderers hard-codes a pixel.  The design is 1920×1080 and a
window of another shape is *filled*, never letterboxed: a taller window (a
16:10 MacBook, a 4:3 iPad) fits the design width and gains room at the top,
so the orbs fall a little further while the slot line, the word block and
Noki stay where they are at the bottom; a wider window fits the height and
gains columns at the sides, so the grid simply continues past the outer
lanes.  ``top``, ``left``, ``right`` and ``bottom`` are the window's edges
in design units and the renderers paint out to them.  Letters mode centres
its field vertically instead.

Build one Layout per play session (and again on resize); read its rects and
use ``X()``/``Y()``/``S()`` to convert design units at blit time.
"""
from __future__ import annotations

from dataclasses import dataclass, field

DESIGN_W, DESIGN_H = 1920, 1080

LANE_W = 320            # one grid column
HIGHWAY_X0 = 480        # lanes sit right of centre: a 480 px column for Noki on the left, 160 px on the right
HIGHWAY_CX = HIGHWAY_X0 + 2 * LANE_W
LANE_CENTERS = [HIGHWAY_X0 + LANE_W // 2 + i * LANE_W for i in range(4)]   # 640 · 960 · 1280 · 1600
SLOT_Y = 840
SLOT_Y_WITH_KEYBOARD = 760
SPAWN_MARGIN = 60       # orbs appear this far above the window's top edge
SPAWN_Y = -SPAWN_MARGIN  # at exactly 16:9
ORB_R = 46              # big enough that the letter reads from across the room
SLOT_RING_R = 52
NOKI_H = 285            # a quarter of the screen height (a third read as 25 % too big)
NOKI_W = 220
NOKI_DROP = 14          # Noki's feet sit this far below the slot line: standing on it, not floating over it


@dataclass
class Layout:
    win_w: int
    win_h: int
    key_guide: str = "off"          # off | hints | keyboard
    noki_placement: str = "line"    # line | corner | hidden
    stage_view: bool = False
    mode: str = "highway"           # highway | letters

    s: float = field(init=False)
    ox: float = field(init=False)
    oy: float = field(init=False)
    top: float = field(init=False)      # design y of the window's top edge (≤ 0)
    left: float = field(init=False)     # design x of the window's left edge (≤ 0)
    right: float = field(init=False)    # design x of the window's right edge (≥ 1920)
    bottom: float = field(init=False)   # design y of the window's bottom edge (≥ 1080)

    def __post_init__(self) -> None:
        sx, sy = self.win_w / DESIGN_W, self.win_h / DESIGN_H
        self.s = min(sx, sy)
        extra_w = self.win_w - DESIGN_W * self.s      # > 0 when wider than 16:9
        extra_h = self.win_h - DESIGN_H * self.s      # > 0 when taller than 16:9
        self.ox = extra_w / 2
        # the Highway is bottom-aligned (the slot line and the word block keep their place,
        # the fall gets longer); the Letters field is centred
        self.oy = extra_h / 2 if self.mode == "letters" else extra_h
        self.left = -self.ox / self.s
        self.right = DESIGN_W - self.left
        self.top = -self.oy / self.s
        self.bottom = (self.win_h - self.oy) / self.s

    # ── conversions ───────────────────────────────────────────────────────
    def X(self, x: float) -> int:
        return int(round(self.ox + x * self.s))

    def Y(self, y: float) -> int:
        return int(round(self.oy + y * self.s))

    def S(self, v: float) -> int:
        return max(1, int(round(v * self.s)))

    def Sf(self, v: float) -> float:
        return v * self.s

    # ── highway geometry (design units) ───────────────────────────────────
    @property
    def slot_y(self) -> int:
        return SLOT_Y_WITH_KEYBOARD if self.key_guide == "keyboard" else SLOT_Y

    @property
    def spawn_y(self) -> float:
        return self.top - SPAWN_MARGIN

    @property
    def fall_px(self) -> float:
        return self.slot_y - self.spawn_y

    def lane_center(self, lane: int) -> int:
        return LANE_CENTERS[max(0, min(3, lane))]

    def lane_x0(self, lane: int) -> int:
        return HIGHWAY_X0 + lane * LANE_W

    @property
    def orb_r(self) -> int:
        return int(ORB_R * (1.35 if self.stage_view else 1.0))

    @property
    def slot_ring_r(self) -> int:
        return int(SLOT_RING_R * (1.35 if self.stage_view else 1.0))

    # word block
    @property
    def word_y(self) -> int:
        return 932 if self.key_guide != "keyboard" else 1000

    @property
    def word_size(self) -> int:
        return 72 if self.key_guide != "keyboard" else 52

    @property
    def word_advance(self) -> int:
        return 80 if self.key_guide != "keyboard" else 58

    @property
    def queue_rows(self) -> list[tuple[int, int, float]]:
        """(centre y, font px, alpha) for the three stacked next words: larger, fainter."""
        if self.key_guide == "keyboard":
            return [(1058, 26, 0.26)]
        return [(996, 40, 0.30), (1034, 34, 0.20), (1066, 28, 0.13)]

    # HUD anchors, pinned to the window's corners
    @property
    def SCORE_POS(self) -> tuple[float, float]:
        return (self.left + 40, self.top + 92)

    @property
    def MULT_POS(self) -> tuple[float, float]:
        return (self.left + 40, self.top + 134)

    @property
    def RUSH_BAR(self) -> tuple[float, float, int, int]:
        return (self.left + 40, self.top + 154, 240, 12)

    @property
    def LIVES_POS(self) -> tuple[float, float]:
        return (self.left + 48, self.top + 192)

    @property
    def ACC_POS(self) -> tuple[float, float]:
        return (self.right - 40, self.top + 92)

    PROGRESS_H = 5

    @property
    def COMBO_POS(self) -> tuple[float, float]:
        return (HIGHWAY_CX, 540 + self.top * 0.5)

    # Noki
    @property
    def noki_rect(self) -> tuple[int, int, int, int]:
        """x, y, w, h in design units: centred in the left column, feet on the slot line."""
        h, w = NOKI_H, NOKI_W
        x = int((self.left + HIGHWAY_X0) / 2 - w / 2)
        if self.noki_placement == "corner":
            return (x, DESIGN_H - h - 8, w, h)
        return (x, self.slot_y - h + NOKI_DROP, w, h)
