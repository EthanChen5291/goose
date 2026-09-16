"""
Author the goose's fighting frames from the pack's four animations.

    python3 web/tools/goose_frames.py        # writes assets/pixel/goose/*.png

The pack ships Idle, Walk, Run and Flap — a goose that can stand about.  The game
needs one that slaps, punches, whips and gets knocked back, so those frames are
drawn here, in the pack's own four colours, at the pack's own 64×64 frame size.

Every fighting key is *drawn*, not transformed: the body is a blob whose width
and height change with the pose (squashed in a crouch, stretched in a leap),
the neck is a thick line from body to head so it can compress or reach, the
legs are lines to wherever the feet are, the wings are tapered limbs drawn
over the body with their own outline (how the pack keeps a wing readable), and
the head is the one part copied from the pack — tilted, squinting, beak open —
because that is where the character lives.  The goose lives in three
dimensions: some keys show it from behind, from the front, upside down, or
edge-on, and a strip can turn it through those views.  Speed is drawn too: a
fast wing leaves translucent ghosts of itself along its path and a translucent
arc where its tip went; a dash leaves dashes; a jump leaves dust.  Ghost pixels
are never outlined (the outline is for solid things).

Motion between keys is *not* done here: the game snaps between them, each key
for its own duration (`px/actors.ts` MOVES).  Facing: right, like the pack; the
game mirrors the sprite to face the enemy — so a key drawn facing *left* is one
the goose plays from the enemy's far side, facing back at it.

Strips written (frame count · contact frame):
    slap 10·3         weight back, crouch, the swing as a smear, CONTACT held, follow-through, settle
    peck 5·2          the head coils back, then stabs forward, neck at full stretch, ghost heads behind
    uppercut 8·3      crouch and load low, the wing bent square, the rising blow (diagonal, smeared),
                      full extension off the ground, the hang, the fall, land
    hop_slap 9·5      two crouch keys, the spring (dust), a spin in the air (back view, smear ring),
                      the slap coming out of the spin, through, land, stand
    dropkick 8·3      a step, the spring, the legs sweeping in from low, CONTACT both feet forward,
                      the sweep carrying across, onto the back, the roll, up
    whip 9·5          reach to the hip, grab the coiled lash, raise it overhead leaning back, hold,
                      the crack: the lash loops over and snaps straight, the recoil, slack, coiled
    whip_hold 2·0     the lash taut, leaning back against it (loops through a hold note)
    spin 8·2          twist back, then the body as a wheel: smear rings and gusts turning round it
    flurry 8·0        punches from every side: front · dash over (back view) · from above ·
                      dash round (front view) · from behind (drawn facing left) · dash back ·
                      the BIG one, both wings (held) · recover.  The game moves the body per key.
    megahonk 9·5      inhale (three keys, chest swelling, head back) · the neck whips forward ·
                      the HONK: beak wide, sound waves, the body pushed back by it · exhale
    boulder 10·7      squat, grab, heave to the chest, hoist overhead (head up), spring, leap,
                      the throw (head follows through), it lands, land, stand
    volley 12·9       squat, toss, watch, load like a batter, the BAT (smeared), through, crouch,
                      dash (dashes behind), leap wing overhead, the SMASH held, skid, stand
    launch 11·2       the beak under the enemy, coiled (held) · the FLIP: the head flung up, the
                      enemy goes high · watch · dash up · turning over (back view) · upside down
                      over it · the TAIL LASH down (smeared) · falling · land · stand
    dive 5·2          the follow-up after a launch: spring, the drop punch on the fallen enemy (held), up
    roll 12·3         tuck · the ball (held) · rolling in (two turns) · HIT · bounce back · in again ·
                      hit · back · in · hit · unroll · stand — the enemy against the wall
    hurt 5·0          knocked: bent back in a C, wings flung, eyes shut, feathers, feet skidding; stumble
    dodge_flat 4·1    drops flat under the blow (held), up
    dodge_side 4·1    steps out of the plane: the body edge-on, ghosts where it was (held), back
    cheer 2·0         wings up, off the ground (not an attack: drops and the win)
    bellyflop 6·3     squat, leap, belly-down, the splat (held), up
    bodyslam 8·5      coil, spring, rise, the hang (held), the drop, the SLAM flat, bounce, stand
    flash 1·0         white silhouette (kept for the packer; the game whitens with a filter)
    rock 1 · rock_break 5   the boulder, bigger and rough, and the boulder in six chunks
"""
from __future__ import annotations

import math
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, "assets", "pixel", "goose")

FW = FH = 64
OUTLINE = (23, 24, 24, 255)
WHITE = (235, 240, 239, 255)
ORANGE = (236, 177, 135, 255)
BROWN = (170, 103, 56, 255)
CLEAR = (0, 0, 0, 0)
FEET = 32  # the row just under the feet in every pack frame
# translucent whites: a ghost of something that was there a frame ago, and a fainter one
GHOST = (235, 240, 239, 125)
GHOST2 = (235, 240, 239, 70)
DUST = (200, 196, 190, 120)


def strip(name: str) -> list[np.ndarray]:
    im = Image.open(os.path.join(SRC, f"{name}.png")).convert("RGBA")
    a = np.array(im)
    return [a[:, i * FW:(i + 1) * FW].copy() for i in range(im.width // FW)]


def blank() -> np.ndarray:
    return np.zeros((FH, FW, 4), dtype=np.uint8)


def is_fill(px) -> bool:
    """solid colour, not outline: what an outline goes round (ghosts do not count)"""
    return px[3] == 255 and tuple(px) != OUTLINE


def inb(x: int, y: int) -> bool:
    return 0 <= x < FW and 0 <= y < FH


def place(dst: np.ndarray, src: np.ndarray, dx: int = 0, dy: int = 0) -> None:
    """Composite `src` onto `dst` shifted by (dx, dy); anything drawn goes over."""
    h, w = src.shape[:2]
    for y in range(h):
        ty = y + dy
        if not 0 <= ty < FH:
            continue
        for x in range(w):
            tx = x + dx
            if not 0 <= tx < FW:
                continue
            if src[y, x, 3] > 0:
                dst[ty, tx] = src[y, x]


def shift(src: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = blank()
    place(out, src, dx, dy)
    return out


def shear(src: np.ndarray, k: float, pivot_y: int = FEET) -> np.ndarray:
    """Lean: shift each row by k·(pivot − y), so the feet stay and the head moves."""
    out = blank()
    for y in range(FH):
        dx = int(round(k * (pivot_y - y)))
        row = src[y]
        for x in range(FW):
            if row[x, 3] > 0 and 0 <= x + dx < FW:
                out[y, x + dx] = row[x]
    return repair_outline(out)


def mirror(src: np.ndarray) -> np.ndarray:
    return src[:, ::-1].copy()


def rot90(src: np.ndarray, times: int) -> np.ndarray:
    return np.rot90(src, times).copy()


def erase(dst: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> None:
    dst[max(0, y0):y1 + 1, max(0, x0):x1 + 1] = 0


COLORS = {"#": WHITE, "=": ORANGE, "o": BROWN, ".": OUTLINE, "~": GHOST, "-": GHOST2}


def outline_cells(dst: np.ndarray, cells: set[tuple[int, int]]) -> None:
    """the pack's 1 px outline round a set of solid cells, drawn over anything"""
    for (cx, cy) in cells:
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if (nx, ny) in cells or not inb(nx, ny):
                continue
            dst[ny, nx] = OUTLINE


def stamp(dst: np.ndarray, art: str, x: int, y: int, colors: dict[str, tuple] | None = None,
          outline: bool = True) -> None:
    """Draw an ASCII shape at (x, y): '#' white, '=' orange, 'o' brown, '.' outline,
    '~' ghost, '-' faint ghost, ' ' nothing.  Solid cells get their own outline over
    whatever is under them — that is how the pack keeps a wing readable against the body."""
    colors = colors or COLORS
    rows = art.strip("\n").split("\n")
    cells = set()
    for j, row in enumerate(rows):
        for i, ch in enumerate(row):
            if ch == " ":
                continue
            tx, ty = x + i, y + j
            if inb(tx, ty):
                if ch in "~-":
                    if dst[ty, tx, 3] == 0:
                        dst[ty, tx] = colors[ch]
                    continue
                dst[ty, tx] = colors[ch]
                if ch != ".":
                    cells.add((tx, ty))
    if outline:
        outline_cells(dst, cells)


def repair_outline(a: np.ndarray) -> np.ndarray:
    """Every transparent pixel 4-adjacent to solid fill becomes outline."""
    out = a.copy()
    for y in range(FH):
        for x in range(FW):
            if a[y, x, 3] > 0:
                continue
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if inb(nx, ny) and is_fill(a[ny, nx]):
                    out[y, x] = OUTLINE
                    break
    return out


def whiten(a: np.ndarray) -> np.ndarray:
    out = a.copy()
    for y in range(FH):
        for x in range(FW):
            if is_fill(a[y, x]):
                out[y, x] = WHITE
    return out


def line_cells(pts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    cells: list[tuple[int, int]] = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(n + 1):
            c = (round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n))
            if not cells or cells[-1] != c:
                cells.append(c)
    return cells


def line(dst: np.ndarray, pts: list[tuple[int, int]], color=BROWN, outline: bool = True) -> None:
    """A 1 px polyline in `color` with the pack outline around it: a whip, a leg."""
    cells = line_cells(pts)
    cs = set(cells)
    for (x, y) in cells:
        if inb(x, y):
            dst[y, x] = color
    if not outline:
        return
    for (x, y) in cells:
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in cs and inb(nx, ny) and dst[ny, nx, 3] == 0:
                dst[ny, nx] = OUTLINE


def solid_cells(a: np.ndarray) -> set[tuple[int, int]]:
    ys, xs = np.where(a[:, :, 3] > 0)
    return set(zip(xs.tolist(), ys.tolist()))


# ── the body, as the pack drew it ──────────────────────────────────────────
IDLE = strip("Idle")
WALK = strip("Walk")
RUN = strip("Run")
FLAP = strip("Flap")
BODY = IDLE[0]
LOW = WALK[2]           # the low walk frame

# where things are on the idle body (measured in the frame)
EYE = (39, 7)
BEAK = (42, 8, 46, 11)          # x0 y0 x1 y1 of the beak
SHOULDER = (33, 16)            # where a wing roots on the body
HEAD_BOX = (33, 4, 46, 13)     # x0 y0 x1 y1 of the head on the idle body, exclusive
HEAD_BASE = (36, 12)           # where the neck meets the head, on the idle body


def eye_shut(dst: np.ndarray, hx: int = 0, hy: int = 0) -> None:
    x, y = EYE[0] + hx, EYE[1] + hy
    dst[y, x] = WHITE
    for i in (-1, 0, 1):
        if inb(x + i, y + 1):
            dst[y + 1, x + i] = OUTLINE


def eye_squint(dst: np.ndarray, hx: int = 0, hy: int = 0) -> None:
    """The eye as a dash: effort."""
    x, y = EYE[0] + hx, EYE[1] + hy
    for i in (-1, 0, 1):
        if inb(x + i, y):
            dst[y, x + i] = OUTLINE


def beak_open(dst: np.ndarray, wide: bool) -> None:
    x0, y0, x1, y1 = BEAK
    erase(dst, x0, y0 - 1, x1 + 2, y1 + 2)
    stamp(dst, "###\n###\n###", x0 - 2, y0, outline=False)
    if wide:
        stamp(dst, "  ==\n ===\n==", x0, y0 - 2)         # upper beak angled up
        stamp(dst, "oo\n ooo\n   oo", x0, y0 + 2)        # lower beak angled down
        dst[y0 + 1, x0 + 1] = OUTLINE                    # the dark mouth between
        dst[y0 + 1, x0 + 2] = OUTLINE
    else:
        stamp(dst, " ===\n===", x0, y0 - 1)
        stamp(dst, "ooo\n oo", x0, y0 + 2)
        dst[y0 + 1, x0 + 1] = OUTLINE


def feathers(dst: np.ndarray, pts: list[tuple[int, int]]) -> None:
    for (x, y) in pts:
        stamp(dst, "##", x, y)


# ═══════════════════════════════════════════════════════════════════════════
# the rig: the parts a drawn key is built from
# ═══════════════════════════════════════════════════════════════════════════
def head_img(tilt: int = 0, eye: str = "open", beak: str = "shut", puff: int = 0) -> np.ndarray:
    """The pack's head alone, at its idle place.  `tilt` > 0 lifts the beak end
    (looking up), < 0 drops it; `eye` open | shut | squint; `beak` shut | open |
    wide; `puff` adds cheek (an inhale)."""
    out = blank()
    x0, y0, x1, y1 = HEAD_BOX
    out[y0:y1, x0:x1] = BODY[y0:y1, x0:x1]
    out[12, 33] = 0
    if beak != "shut":
        beak_open(out, beak == "wide")
    if eye == "shut":
        eye_shut(out)
    elif eye == "squint":
        eye_squint(out)
    if puff:
        for j in range(puff):
            out[5 + j, 35] = WHITE
            out[6 + j, 34] = WHITE
        out = repair_outline(out)
    if tilt:
        t = blank()
        for x in range(x0 - 1, x1 + 3):
            k = max(0, x - 38)
            dy = -int(round(tilt * k / 3.0))
            for y in range(FH):
                if inb(x, y) and out[y, x, 3] and inb(x, y + dy):
                    t[y + dy, x] = out[y, x]
        out = repair_outline(t)
    return out


def head(f: np.ndarray, bx: int, by: int, **kw) -> None:
    """Place the head so its neck-join sits at (bx, by)."""
    place(f, shift(head_img(**kw), bx - HEAD_BASE[0], by - HEAD_BASE[1]))


def head_ghost(f: np.ndarray, bx: int, by: int, color=GHOST, **kw) -> None:
    ghost(f, solid_cells(shift(head_img(**kw), bx - HEAD_BASE[0], by - HEAD_BASE[1])), color)


def head_left(f: np.ndarray, bx: int, by: int, **kw) -> None:
    """the head facing left (a key played from the enemy's far side)"""
    h = mirror(head_img(**kw))
    mbx = FW - 1 - HEAD_BASE[0]
    place(f, shift(h, bx - mbx, by - HEAD_BASE[1]))


def head_down(f: np.ndarray, bx: int, by: int, **kw) -> None:
    """the head upside down, beak forward: the goose inverted in the air"""
    h = head_img(**kw)[::-1, :].copy()
    place(f, shift(h, bx - HEAD_BASE[0], by - (FH - 1 - HEAD_BASE[1])))


def head_front(f: np.ndarray, cx: int, cy: int, eye: str = "open") -> None:
    """the head seen from the front: an oval, two eyes, the beak between them pointing at us"""
    fill_cells(f, ellipse_cells(cx + 0.5, cy + 0.5, 4.5, 4.5))
    for ex in (cx - 2, cx + 2):
        if eye == "squint":
            f[cy - 1, ex - 1] = OUTLINE; f[cy - 1, ex] = OUTLINE
        else:
            f[cy - 1, ex] = OUTLINE
    stamp(f, "==\n==", cx - 1, cy, outline=False)
    stamp(f, "oo", cx - 1, cy + 2, outline=False)


def ellipse_cells(cx: float, cy: float, rx: float, ry: float) -> set[tuple[int, int]]:
    cells = set()
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 and inb(x, y):
                cells.add((x, y))
    return cells


def fill_cells(f: np.ndarray, cells, color=WHITE) -> None:
    for (x, y) in cells:
        if inb(x, y):
            f[y, x] = color


def body(f: np.ndarray, cx: float, cy: float, rx: float, ry: float, tail: tuple[int, int] | None = None,
         lean: float = 0.0) -> None:
    """The body blob: an ellipse, leaned by shifting rows, with a tail nub at `tail`."""
    cells = ellipse_cells(cx, cy, rx, ry)
    if lean:
        cells = {(x + int(round(lean * (cy - y))), y) for (x, y) in cells}
    fill_cells(f, cells)
    if tail:
        tx, ty = tail
        stamp(f, "#\n##\n###", tx, ty, outline=False)


def limb_cells(pts, w0: float, w1: float) -> set[tuple[int, int]]:
    """a tapered thick polyline from width w0 at the root to w1 at the tip"""
    segs = list(zip(pts, pts[1:]))
    total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs) or 1
    cells = set()
    done = 0.0
    for (x0, y0), (x1, y1) in segs:
        seg = math.hypot(x1 - x0, y1 - y0)
        n = int(seg * 2) + 1
        for i in range(n + 1):
            q = i / n
            s = (done + q * seg) / total
            w = w0 + (w1 - w0) * s
            x, y = x0 + (x1 - x0) * q, y0 + (y1 - y0) * q
            cells |= ellipse_cells(x + 0.5, y + 0.5, max(0.6, w / 2), max(0.6, w / 2))
        done += seg
    return cells


def neck(f: np.ndarray, pts, w: float = 5) -> None:
    fill_cells(f, limb_cells(pts, w, w * 0.9))


def wing(f: np.ndarray, pts, w0: float = 5, w1: float = 2) -> None:
    """A wing over the body, with its own outline so it reads against the white."""
    cells = limb_cells(pts, w0, w1)
    fill_cells(f, cells)
    outline_cells(f, cells)


def ghost(f: np.ndarray, cells, color=GHOST) -> None:
    """translucent, only where nothing is drawn: a thing that was there a moment ago"""
    for (x, y) in cells:
        if inb(x, y) and f[y, x, 3] == 0:
            f[y, x] = color


def ghost_wing(f: np.ndarray, pts, w0=5, w1=2, color=GHOST) -> None:
    ghost(f, limb_cells(pts, w0, w1), color)


def arc_cells(cx: float, cy: float, r: float, a0: float, a1: float, w: float = 1.5) -> set[tuple[int, int]]:
    """cells along a circular arc from angle a0 to a1 (degrees; 0 is forward, 90 is down on screen)"""
    cells = set()
    n = int(abs(a1 - a0) * r / 40) + 4
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
        cells |= ellipse_cells(x + 0.5, y + 0.5, w / 2, w / 2)
    return cells


def smear_arc(f: np.ndarray, cx: float, cy: float, r: float, a0: float, a1: float, w: float = 2,
              color=GHOST) -> None:
    ghost(f, arc_cells(cx, cy, r, a0, a1, w), color)


def dashes(f: np.ndarray, pts: list[tuple[int, int, int]], color=GHOST) -> None:
    """horizontal dashes (x, y, length): the air something fast moved through"""
    for (x, y, n) in pts:
        ghost(f, {(x + i, y) for i in range(n)}, color)


def speed_lines(dst: np.ndarray, pts: list[tuple[int, int, int]], color=GHOST) -> None:
    """Vertical dashes: (x, y, length) each — the air a falling goose leaves."""
    for (x, y, n) in pts:
        ghost(dst, {(x, y + j) for j in range(n)}, color)


def dust(f: np.ndarray, pts: list[tuple[int, int]]) -> None:
    """small puffs at the feet"""
    for (x, y) in pts:
        ghost(f, {(x, y), (x + 1, y), (x - 1, y + 1), (x, y + 1), (x + 1, y + 1), (x + 2, y + 1)}, DUST)


def leg(f: np.ndarray, pts: list[tuple[int, int]], color, foot: int = 1, toe: bool = False) -> None:
    """A leg as a line to the foot, then the foot: `foot` +1 points right, -1 left;
    `toe` draws it up on its toe (one row)."""
    cells = line_cells(pts)
    for (x, y) in cells:
        if inb(x, y):
            f[y, x] = color
    fx, fy = pts[-1]
    if toe:
        for i in range(0, 3):
            if inb(fx + i * foot, fy):
                f[fy, fx + i * foot] = color
        return
    for i in range(-1, 2):
        if inb(fx + i, fy):
            f[fy, fx + i] = color
    for i in range(-2, 4):
        if inb(fx + i * foot, fy + 1):
            f[fy + 1, fx + i * foot] = color


def legs_idle(f: np.ndarray, hipx: int = 30, hipy: int = 26, dy: int = 0) -> None:
    leg(f, [(hipx - 2, hipy), (hipx - 2, hipy + 3 + dy)], ORANGE, 1)
    leg(f, [(hipx + 2, hipy), (hipx + 2, hipy + 3 + dy)], BROWN, 1)


def two_legs(a, b, ta: int = 1, tb: int = 1, toe_a: bool = False, toe_b: bool = False):
    """a legs-drawer for `standing`: the near (orange) leg's points, the far (brown) leg's"""
    return lambda f: (leg(f, a, ORANGE, ta, toe_a), leg(f, b, BROWN, tb, toe_b))


def finish(f: np.ndarray) -> np.ndarray:
    return repair_outline(f)


def standing(*, cx: float = 32, cy: float = 20.5, rx: float = 8.5, ry: float = 6, lean: float = 0,
             tail: tuple[int, int] | None = (23, 15), neck_pts=None, head_at: tuple[int, int] = (36, 12),
             head_kw: dict | None = None, legs=None) -> np.ndarray:
    """a standing figure: legs, body, neck, head — the base every side-on key is a variation of"""
    f = blank()
    if legs is None:
        legs_idle(f)
    else:
        legs(f)
    body(f, cx, cy, rx, ry, tail, lean)
    neck(f, neck_pts or [(34, 17), (36, 13)])
    head(f, *head_at, **(head_kw or {}))
    return f


SQUAT_LEGS = two_legs([(28, 27), (27, 30)], [(34, 27), (35, 30)])
WIDE_LEGS = two_legs([(29, 26), (26, 30)], [(36, 26), (39, 30)])


def squat(head_kw=None, lean: float = 0.0, cx: float = 32) -> np.ndarray:
    return standing(cx=cx, cy=23, rx=10, ry=5, lean=lean, tail=(int(cx) - 11, 18), head_at=(int(cx) + 3, 15),
                    neck_pts=[(cx + 2, 19), (cx + 3, 16)], head_kw=head_kw, legs=SQUAT_LEGS)


# ═══════════════════════════════════════════════════════════════════════════
# quick moves
# ═══════════════════════════════════════════════════════════════════════════
def make_slap() -> list[np.ndarray]:
    """0 weight back · 1 crouch, wing loaded high behind · 2 the swing as a smear:
    two ghosts of the wing along its path and a translucent arc, the body already
    lunging · 3 CONTACT: leaning in, neck forward, wing long and level, its own
    ghost trailing (held) · 4 overshoot, feathers off the tip · 5 through, wing
    sweeping down · 6 the wing swings back past the body · 7 settle · 8 bounce ·
    9 idle."""
    f0 = standing(cx=31, lean=-0.06, head_at=(35, 13), neck_pts=[(33, 17), (35, 14)])
    wing(f0, [(31, 17), (25, 14), (21, 15)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=23, rx=10, ry=5, tail=(21, 18), head_at=(35, 15), neck_pts=[(34, 19), (35, 16)],
                  legs=two_legs([(28, 27), (27, 30)], [(34, 27), (35, 30)]))
    wing(f1, [(30, 19), (25, 13), (23, 9)], 5, 2)
    f1 = finish(f1)
    f2 = standing(cx=33, cy=19.5, rx=9, ry=6.5, lean=0.12, tail=(23, 13), head_at=(40, 10),
                  neck_pts=[(35, 16), (39, 11)], legs=two_legs([(29, 26), (26, 30)], [(35, 26), (38, 30)]))
    f2 = finish(f2)
    ghost_wing(f2, [(33, 19), (27, 12), (25, 7)], 5, 2, GHOST2)
    ghost_wing(f2, [(33, 19), (36, 11), (40, 6)], 5, 2, GHOST)
    smear_arc(f2, 33, 19, 13, -150, -20, 2.5, GHOST)
    smear_arc(f2, 33, 19, 15, -120, -30, 1.5, GHOST2)
    dashes(f2, [(16, 16, 4), (14, 19, 5)])
    contact = dict(cx=34, cy=19.5, rx=9, ry=6, lean=0.14, tail=(24, 13), head_at=(41, 12),
                   neck_pts=[(36, 16), (40, 13)], head_kw=dict(eye="squint"), legs=WIDE_LEGS)
    f3 = standing(**contact)
    wing(f3, [(34, 18), (44, 17), (56, 17)], 6, 2.5)
    f3 = finish(f3)
    ghost_wing(f3, [(34, 18), (42, 12), (51, 8)], 5, 2, GHOST)
    ghost_wing(f3, [(34, 18), (38, 9), (42, 3)], 5, 2, GHOST2)
    smear_arc(f3, 34, 18, 20, -75, -8, 2.5, GHOST)
    smear_arc(f3, 34, 18, 23, -60, -12, 1.5, GHOST2)
    f4 = standing(**{**contact, "cx": 35, "head_at": (42, 13)})
    wing(f4, [(35, 18), (46, 18), (57, 20)], 6, 2.5)
    f4 = finish(f4)
    ghost_wing(f4, [(35, 18), (45, 15), (56, 14)], 5, 2, GHOST2)
    feathers(f4, [(58, 14), (60, 22)])
    f5 = standing(cx=34, cy=21, rx=9, ry=5.5, lean=0.1, tail=(24, 15), head_at=(41, 14),
                  neck_pts=[(36, 18), (40, 15)], head_kw=dict(tilt=-1),
                  legs=two_legs([(29, 26), (27, 30)], [(36, 26), (39, 30)], toe_b=True))
    wing(f5, [(34, 19), (42, 24), (50, 28)], 6, 2)
    f5 = finish(f5)
    ghost_wing(f5, [(34, 19), (45, 21), (55, 22)], 5, 2, GHOST2)
    feathers(f5, [(52, 12), (48, 8)])
    f6 = standing(cx=33, cy=20.5, lean=0.04, head_at=(38, 12), neck_pts=[(35, 17), (38, 13)])
    wing(f6, [(33, 18), (38, 24), (42, 29)], 5, 2)
    f6 = finish(f6)
    feathers(f6, [(45, 9)])
    f7 = standing(cx=32, lean=-0.05, head_at=(36, 11), neck_pts=[(34, 16), (36, 12)])
    wing(f7, [(33, 17), (37, 20), (39, 22)], 5, 2)
    f7 = finish(f7)
    f8 = standing(cy=21.5, head_at=(36, 13), neck_pts=[(34, 18), (36, 14)], legs=lambda f: legs_idle(f, 30, 27))
    wing(f8, [(33, 18), (37, 21), (39, 23)], 5, 2)
    f8 = finish(f8)
    f9 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9]


def make_peck() -> list[np.ndarray]:
    """0 the head coils back and down, the neck an S · 1 coiled deeper, eye on the
    mark (held) · 2 the STAB: neck at full stretch, head far forward, ghost heads
    behind it · 3 a pixel further · 4 the neck pulling back."""
    f0 = standing(cx=31, lean=-0.05, head_at=(33, 13), neck_pts=[(33, 17), (32, 14)], head_kw=dict(tilt=-1))
    wing(f0, [(32, 17), (27, 20), (24, 22)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=31, cy=21, rx=9, ry=5.5, lean=-0.08, head_at=(32, 14), neck_pts=[(33, 18), (31, 15)],
                  head_kw=dict(tilt=-1, eye="squint"))
    wing(f1, [(32, 18), (27, 21), (24, 23)], 5, 2)
    f1 = finish(f1)
    stab = dict(cx=34, cy=20, rx=9.5, ry=5.5, lean=0.16, tail=(24, 14), neck_pts=[(37, 16), (46, 13)],
                legs=two_legs([(30, 26), (27, 30)], [(37, 26), (40, 30)], toe_b=True))
    f2 = standing(**stab, head_at=(47, 12), head_kw=dict(eye="squint"))
    wing(f2, [(34, 18), (30, 22), (27, 25)], 5, 2)
    f2 = finish(f2)
    head_ghost(f2, 41, 12, GHOST)
    head_ghost(f2, 36, 13, GHOST2)
    dashes(f2, [(20, 12, 4), (18, 15, 5)])
    f3 = standing(**{**stab, "cx": 35, "neck_pts": [(38, 16), (47, 13)]}, head_at=(48, 12), head_kw=dict(eye="squint"))
    wing(f3, [(35, 18), (31, 22), (28, 25)], 5, 2)
    f3 = finish(f3)
    head_ghost(f3, 44, 12, GHOST2)
    f4 = standing(cx=33, lean=0.06, head_at=(40, 12), neck_pts=[(35, 17), (39, 13)])
    wing(f4, [(33, 17), (37, 21), (39, 23)], 5, 2)
    f4 = finish(f4)
    return [f0, f1, f2, f3, f4]


def make_uppercut() -> list[np.ndarray]:
    """0 crouch, wing drawn back and low · 1 loaded: lower still, the wing bent
    square behind the hip, head down (held) · 2 the rise begins: body stretching
    up and forward, the wing coming through bent square at the hip, ghosts · 3 the
    BLOW: airborne, rising on the diagonal, the wing driving up bent at the elbow,
    a smear from low to high · 4 full extension: wing straight up, stretched tall,
    feet tucked · 5 the hang · 6 falling, wing coming down · 7 land squat.
    Keys 2–6 are drawn low in the frame (D) and the game lifts them."""
    D = 8
    f0 = standing(cx=31, cy=22.5, rx=9.5, ry=5.5, lean=-0.06, tail=(21, 17), head_at=(34, 15), neck_pts=[(33, 19), (34, 16)],
                  head_kw=dict(tilt=-1), legs=SQUAT_LEGS)
    wing(f0, [(31, 20), (24, 22), (20, 25)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=24, rx=10.5, ry=4.5, lean=-0.04, tail=(21, 19), head_at=(34, 17), neck_pts=[(33, 21), (34, 18)],
                  head_kw=dict(tilt=-2, eye="squint"), legs=two_legs([(27, 27), (25, 30)], [(36, 27), (38, 30)]))
    wing(f1, [(31, 22), (22, 24), (20, 30)], 5, 2.5)
    f1 = finish(f1)
    f2 = standing(cx=33, cy=17 + D, rx=7.5, ry=8, lean=0.18, tail=(26, 9 + D), head_at=(40, 7 + D), neck_pts=[(35, 13 + D), (39, 8 + D)],
                  head_kw=dict(tilt=1, eye="squint"),
                  legs=two_legs([(31, 24 + D), (29, 27 + D), (26, 30 + D)], [(36, 24 + D), (37, 27 + D), (38, 30 + D)], toe_b=True))
    wing(f2, [(34, 16 + D), (41, 21 + D), (48, 17 + D)], 5.5, 3)
    f2 = finish(f2)
    ghost_wing(f2, [(34, 16 + D), (30, 23 + D), (26, 29 + D)], 5, 2.5, GHOST2)
    ghost_wing(f2, [(34, 16 + D), (37, 24 + D), (41, 28 + D)], 5, 2.5, GHOST)
    smear_arc(f2, 34, 16 + D, 11, 70, 150, 2, GHOST2)
    dust(f2, [(24, 30 + D), (39, 30 + D)])
    f3 = standing(cx=34, cy=17 + D, rx=7, ry=8.5, lean=0.14, tail=(27, 9 + D), head_at=(40, 6 + D), neck_pts=[(36, 12 + D), (39, 7 + D)],
                  head_kw=dict(tilt=1, eye="squint"),
                  legs=two_legs([(31, 24 + D), (29, 26 + D), (28, 28 + D)], [(37, 24 + D), (38, 26 + D), (38, 28 + D)], toe_a=True, toe_b=True))
    wing(f3, [(35, 16 + D), (44, 17 + D), (46, 6 + D)], 5.5, 3)
    f3 = finish(f3)
    ghost_wing(f3, [(35, 16 + D), (43, 22 + D), (50, 16 + D)], 5, 3, GHOST)
    ghost_wing(f3, [(35, 16 + D), (38, 25 + D), (44, 28 + D)], 5, 2.5, GHOST2)
    smear_arc(f3, 36, 15 + D, 12, -80, 90, 3, GHOST)
    smear_arc(f3, 36, 15 + D, 15, -70, 70, 1.5, GHOST2)
    speed_lines(f3, [(24, 20 + D, 6), (20, 14 + D, 5)])
    f4 = standing(cx=34, cy=17 + D, rx=6.5, ry=9, lean=0.04, tail=(28, 8 + D), head_at=(37, 5 + D), neck_pts=[(35, 11 + D), (37, 6 + D)],
                  head_kw=dict(tilt=2, eye="squint"),
                  legs=two_legs([(31, 24 + D), (29, 26 + D), (27, 26 + D)], [(36, 24 + D), (38, 26 + D), (40, 26 + D)], -1, 1, True, True))
    wing(f4, [(36, 15 + D), (42, 9 + D), (44, 0 + D)], 5.5, 3)
    f4 = finish(f4)
    ghost_wing(f4, [(36, 15 + D), (45, 13 + D), (49, 4 + D)], 5, 3, GHOST2)
    smear_arc(f4, 36, 15 + D, 12, -100, 20, 2, GHOST2)
    feathers(f4, [(50, 2 + D), (54, 8 + D)])
    f5 = standing(cx=34, cy=17 + D, rx=7, ry=8.5, lean=0.0, tail=(28, 9 + D), head_at=(37, 5 + D), neck_pts=[(35, 11 + D), (37, 6 + D)],
                  head_kw=dict(tilt=1),
                  legs=two_legs([(31, 24 + D), (29, 26 + D), (27, 26 + D)], [(36, 24 + D), (38, 26 + D), (40, 26 + D)], -1, 1, True, True))
    wing(f5, [(36, 15 + D), (41, 9 + D), (41, 1 + D)], 5.5, 3)
    f5 = finish(f5)
    f6 = standing(cx=33, cy=19 + D, rx=8, ry=7, lean=-0.04, tail=(25, 12 + D), head_at=(36, 8 + D), neck_pts=[(35, 13 + D), (36, 9 + D)],
                  legs=two_legs([(30, 25 + D), (28, 30 + D)], [(35, 25 + D), (37, 30 + D)]))
    wing(f6, [(34, 17 + D), (42, 14 + D), (48, 12 + D)], 5, 2)
    f6 = finish(f6)
    f7 = squat()
    wing(f7, [(33, 20), (38, 22), (42, 21)], 5, 2)
    f7 = finish(f7)
    dust(f7, [(23, 30), (39, 30)])
    return [f0, f1, f2, f3, f4, f5, f6, f7]


def back_view(f: np.ndarray, cx: float, cy: float, rx: float, ry: float, head_at: tuple[int, int]) -> None:
    """the goose from behind: the body, a plain oval for the head, no face"""
    body(f, cx, cy, rx, ry, None)
    neck(f, [(cx + 1, cy - 3), head_at])
    hx, hy = head_at
    fill_cells(f, ellipse_cells(hx + 0.5, hy - 3.5, 3.5, 4.5))


def make_hop_slap() -> list[np.ndarray]:
    """0 anticipation: weight back · 1 the crouch, deep, dust at the feet (held) ·
    2 the spring: stretched tall leaving the ground, dust below · 3 turning in the
    air: seen from behind, a smear ring round it · 4 turning through: side on,
    wing loaded high behind · 5 CONTACT out of the spin: the slap, wing forward
    and level, the arc of the turn still round it · 6 through: wing down, coming
    down · 7 land, dust · 8 stand.  Keys 2–6 drawn low (D); the game lifts them."""
    D = 8
    f0 = standing(cx=31, lean=-0.08, head_at=(34, 13), neck_pts=[(33, 17), (34, 14)])
    wing(f0, [(31, 17), (25, 15), (21, 16)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=24, rx=10.5, ry=4.5, tail=(21, 19), head_at=(35, 17), neck_pts=[(34, 21), (35, 18)],
                  head_kw=dict(eye="squint"), legs=two_legs([(27, 27), (25, 30)], [(36, 27), (38, 30)]))
    wing(f1, [(31, 22), (24, 18), (21, 14)], 5, 2)
    f1 = finish(f1)
    dust(f1, [(22, 30), (40, 30)])
    f2 = standing(cx=32, cy=17 + D, rx=7, ry=8.5, tail=(25, 9 + D), head_at=(36, 5 + D), neck_pts=[(34, 11 + D), (36, 6 + D)],
                  head_kw=dict(tilt=1),
                  legs=two_legs([(30, 24 + D), (29, 28 + D), (28, 30 + D)], [(35, 24 + D), (36, 28 + D), (37, 30 + D)], toe_a=True, toe_b=True))
    wing(f2, [(33, 15 + D), (39, 20 + D), (43, 26 + D)], 5, 2)
    f2 = finish(f2)
    dust(f2, [(22, 30 + D), (40, 30 + D), (31, 31 + D)])
    speed_lines(f2, [(20, 18 + D, 6), (46, 16 + D, 5)])
    f3 = blank()
    leg(f3, [(31, 24 + D), (30, 27 + D), (29, 28 + D)], ORANGE, -1, True)
    leg(f3, [(34, 24 + D), (35, 27 + D), (36, 28 + D)], BROWN, 1, True)
    back_view(f3, 32.5, 18 + D, 7.5, 7.5, (33, 10 + D))
    wing(f3, [(30, 15 + D), (24, 13 + D), (19, 12 + D)], 5, 2)
    wing(f3, [(36, 15 + D), (42, 13 + D), (47, 12 + D)], 5, 2)
    f3 = finish(f3)
    smear_arc(f3, 33, 17 + D, 15, -200, -20, 2, GHOST)
    smear_arc(f3, 33, 17 + D, 17, 20, 160, 1.5, GHOST2)
    f4 = standing(cx=32, cy=18 + D, rx=8, ry=7, lean=-0.08, tail=(24, 11 + D), head_at=(35, 7 + D), neck_pts=[(34, 13 + D), (35, 8 + D)],
                  head_kw=dict(eye="squint"),
                  legs=two_legs([(30, 25 + D), (29, 28 + D), (28, 29 + D)], [(35, 25 + D), (36, 28 + D), (37, 29 + D)], toe_a=True, toe_b=True))
    wing(f4, [(32, 16 + D), (26, 9 + D), (24, 3 + D)], 5, 2)
    f4 = finish(f4)
    ghost_wing(f4, [(32, 16 + D), (24, 15 + D), (18, 14 + D)], 5, 2, GHOST2)
    smear_arc(f4, 32, 16 + D, 13, -170, -60, 2, GHOST)
    f5 = standing(cx=34, cy=18 + D, rx=8.5, ry=6.5, lean=0.16, tail=(25, 11 + D), head_at=(41, 9 + D), neck_pts=[(36, 14 + D), (40, 10 + D)],
                  head_kw=dict(eye="squint"),
                  legs=two_legs([(31, 24 + D), (28, 27 + D), (26, 28 + D)], [(37, 24 + D), (38, 27 + D), (39, 28 + D)], toe_a=True, toe_b=True))
    wing(f5, [(34, 16 + D), (45, 15 + D), (57, 15 + D)], 6, 2.5)
    f5 = finish(f5)
    ghost_wing(f5, [(34, 16 + D), (41, 8 + D), (49, 3 + D)], 5, 2, GHOST)
    ghost_wing(f5, [(34, 16 + D), (33, 6 + D), (32, 0 + D)], 5, 2, GHOST2)
    smear_arc(f5, 34, 16 + D, 19, -110, -6, 2.5, GHOST)
    smear_arc(f5, 34, 16 + D, 22, -95, -12, 1.5, GHOST2)
    f6 = standing(cx=34, cy=19 + D, rx=8.5, ry=6.5, lean=0.1, tail=(25, 12 + D), head_at=(40, 11 + D), neck_pts=[(36, 15 + D), (39, 12 + D)],
                  head_kw=dict(tilt=-1),
                  legs=two_legs([(31, 25 + D), (29, 29 + D), (28, 30 + D)], [(37, 25 + D), (38, 29 + D), (39, 30 + D)]))
    wing(f6, [(34, 17 + D), (43, 23 + D), (50, 28 + D)], 6, 2)
    f6 = finish(f6)
    ghost_wing(f6, [(34, 17 + D), (46, 18 + D), (56, 19 + D)], 5, 2, GHOST2)
    feathers(f6, [(53, 10 + D), (58, 15 + D)])
    f7 = squat(lean=0.04, cx=33)
    wing(f7, [(34, 20), (40, 22), (44, 21)], 5, 2)
    f7 = finish(f7)
    dust(f7, [(22, 30), (42, 30)])
    f8 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8]


def make_dropkick() -> list[np.ndarray]:
    """0 a step in, leaning forward · 1 the spring: legs bent under, leaning back,
    leaving the ground · 2 the legs swing in from low and near, ghosts behind them
    · 3 CONTACT: body laid back, both legs straight forward and level, the smear
    of the sweep under them (held) · 4 the sweep carries across: legs up and past,
    body turning over · 5 on its back, head behind · 6 the roll, curled · 7 up.
    Keys 1–4 drawn low (D) and lifted by the game."""
    D = 6
    f0 = standing(cx=33, cy=20, rx=9, ry=6, lean=0.14, tail=(24, 13), head_at=(40, 12), neck_pts=[(36, 16), (39, 13)],
                  legs=two_legs([(30, 26), (26, 30)], [(36, 26), (40, 30)], toe_b=True))
    wing(f0, [(33, 18), (28, 22), (25, 25)], 5, 2)
    f0 = finish(f0)
    dashes(f0, [(16, 22, 4), (14, 26, 5)])
    f1 = standing(cx=32, cy=17 + D, rx=8, ry=7, lean=-0.2, tail=(28, 9 + D), head_at=(34, 6 + D), neck_pts=[(33, 12 + D), (34, 7 + D)],
                  head_kw=dict(tilt=1),
                  legs=two_legs([(33, 23 + D), (36, 26 + D), (39, 26 + D)], [(36, 23 + D), (40, 25 + D), (43, 25 + D)], toe_a=True, toe_b=True))
    wing(f1, [(31, 15 + D), (24, 12 + D), (19, 12 + D)], 5, 2)
    f1 = finish(f1)
    dust(f1, [(24, 30 + D), (34, 31 + D)])
    f2 = standing(cx=31, cy=17 + D, rx=8.5, ry=6.5, lean=-0.34, tail=(29, 9 + D), head_at=(31, 6 + D), neck_pts=[(31, 12 + D), (31, 7 + D)],
                  head_kw=dict(tilt=2, eye="squint"),
                  legs=two_legs([(34, 22 + D), (42, 24 + D), (50, 26 + D)], [(36, 21 + D), (44, 21 + D), (51, 22 + D)], toe_a=True, toe_b=True))
    wing(f2, [(29, 15 + D), (22, 13 + D), (17, 14 + D)], 5, 2)
    f2 = finish(f2)
    ghost(f2, set(line_cells([(34, 23 + D), (40, 28 + D), (45, 32 + D)])) | set(line_cells([(35, 24 + D), (41, 29 + D), (46, 33 + D)])), GHOST)
    ghost(f2, set(line_cells([(35, 23 + D), (38, 30 + D), (41, 34 + D)])), GHOST2)
    f3 = standing(cx=30, cy=17 + D, rx=9, ry=6.5, lean=-0.42, tail=(30, 9 + D), head_at=(29, 6 + D), neck_pts=[(30, 12 + D), (29, 7 + D)],
                  head_kw=dict(tilt=2, eye="squint"),
                  legs=two_legs([(35, 21 + D), (46, 19 + D), (56, 18 + D)], [(37, 19 + D), (47, 17 + D), (56, 15 + D)], toe_a=True, toe_b=True))
    wing(f3, [(28, 15 + D), (21, 12 + D), (16, 13 + D)], 5, 2)
    wing(f3, [(30, 15 + D), (26, 10 + D), (24, 5 + D)], 4.5, 2)
    f3 = finish(f3)
    smear_arc(f3, 36, 19 + D, 19, 12, 62, 3, GHOST)
    smear_arc(f3, 36, 19 + D, 22, 18, 55, 1.5, GHOST2)
    ghost(f3, set(line_cells([(35, 22 + D), (45, 26 + D), (54, 29 + D)])), GHOST)
    dashes(f3, [(10, 16 + D, 5), (8, 20 + D, 4)])
    f4 = standing(cx=30, cy=18 + D, rx=9, ry=6.5, lean=-0.5, tail=(31, 10 + D), head_at=(27, 7 + D), neck_pts=[(29, 13 + D), (27, 8 + D)],
                  head_kw=dict(tilt=2),
                  legs=two_legs([(35, 20 + D), (43, 13 + D), (49, 7 + D)], [(37, 18 + D), (46, 12 + D), (52, 7 + D)], toe_a=True, toe_b=True))
    wing(f4, [(28, 16 + D), (21, 14 + D), (16, 15 + D)], 5, 2)
    f4 = finish(f4)
    smear_arc(f4, 36, 19 + D, 19, -60, 5, 3, GHOST)
    ghost(f4, set(line_cells([(36, 21 + D), (46, 20 + D), (55, 18 + D)])), GHOST2)
    f5 = blank()
    body(f5, 30, 26.5, 10, 4.5, None)
    neck(f5, [(22, 26), (17, 24)])
    head(f5, 16, 24, tilt=2, eye="shut")
    leg(f5, [(37, 24), (42, 19), (45, 16)], ORANGE, 1, True)
    leg(f5, [(39, 25), (45, 22), (49, 20)], BROWN, 1, True)
    wing(f5, [(30, 25), (36, 30), (42, 31)], 5, 2)
    f5 = finish(f5)
    dust(f5, [(18, 30), (42, 30)])
    feathers(f5, [(24, 16), (34, 14)])
    f6 = blank()
    body(f6, 31, 25, 8, 6, None)
    neck(f6, [(34, 22), (37, 20)])
    head(f6, 38, 20, tilt=-1, eye="squint")
    leg(f6, [(28, 29), (26, 30)], ORANGE, 1)
    leg(f6, [(34, 29), (36, 30)], BROWN, 1)
    wing(f6, [(30, 23), (25, 20), (22, 17)], 5, 2)
    f6 = finish(f6)
    f7 = squat()
    wing(f7, [(33, 20), (38, 22), (42, 21)], 5, 2)
    f7 = finish(f7)
    return [f0, f1, f2, f3, f4, f5, f6, f7]


def lash(f: np.ndarray, pts: list[tuple[int, int]], handle: tuple[int, int] | None = None) -> None:
    """the whip: a brown line with the pack outline, and a short dark handle at its root"""
    line(f, pts, BROWN)
    if handle:
        hx, hy = handle
        for (x, y) in ((hx, hy), (hx, hy + 1)):
            if inb(x, y):
                f[y, x] = OUTLINE


def make_whip() -> list[np.ndarray]:
    """0 the wing reaches down to the hip, the head looks down · 1 the grab: the
    coiled lash in the wing at the hip · 2 raise: the wing up and back over the
    shoulder, the lash trailing behind in a long S, leaning back · 3 held: the
    wing straight up, the lash hanging down behind, leaning back hard · 4 the
    crack begins: the wing swinging over, the lash looping high overhead · 5
    CONTACT: wing forward, the lash straight out, long, a flick at the tip, the
    swing smeared (held) · 6 the recoil: the body jolts back, the wing snaps
    back, the lash whips into a wave · 7 slack · 8 coiled at the feet."""
    f0 = standing(cx=32, cy=21, rx=9, ry=6, lean=-0.02, head_at=(37, 13), neck_pts=[(35, 17), (37, 14)], head_kw=dict(tilt=-2))
    wing(f0, [(33, 18), (35, 24), (36, 28)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=21, rx=9, ry=6, lean=-0.04, head_at=(36, 13), neck_pts=[(34, 17), (36, 14)], head_kw=dict(tilt=-2))
    wing(f1, [(33, 18), (36, 24), (38, 28)], 5, 2)
    f1 = finish(f1)
    lash(f1, [(39, 27), (42, 26), (44, 28), (42, 30), (39, 30), (38, 28)], (39, 28))
    f2 = standing(cx=31, cy=20, rx=8.5, ry=6.5, lean=-0.18, tail=(26, 13), head_at=(34, 11), neck_pts=[(33, 16), (34, 12)],
                  head_kw=dict(tilt=1))
    wing(f2, [(32, 17), (28, 10), (26, 3)], 5, 2)
    f2 = finish(f2)
    lash(f2, [(25, 2), (18, 4), (10, 9), (4, 16), (2, 24), (5, 30)], (25, 2))
    f3 = standing(cx=31, cy=20, rx=8.5, ry=6.5, lean=-0.26, tail=(27, 13), head_at=(33, 10), neck_pts=[(32, 16), (33, 11)],
                  head_kw=dict(tilt=1, eye="squint"), legs=two_legs([(28, 26), (27, 30)], [(34, 26), (36, 30)]))
    wing(f3, [(31, 17), (30, 9), (30, 1)], 5, 2)
    f3 = finish(f3)
    lash(f3, [(29, 0), (22, 1), (14, 3), (8, 8), (4, 15), (6, 23), (10, 28)], (29, 1))
    f4 = standing(cx=32, cy=20, rx=8.5, ry=6.5, lean=0.02, tail=(24, 13), head_at=(37, 11), neck_pts=[(35, 16), (37, 12)],
                  head_kw=dict(eye="squint"))
    wing(f4, [(33, 17), (39, 10), (44, 5)], 5, 2)
    f4 = finish(f4)
    ghost_wing(f4, [(33, 17), (32, 9), (32, 1)], 5, 2, GHOST2)
    smear_arc(f4, 33, 17, 15, -110, -40, 2, GHOST)
    lash(f4, [(45, 4), (40, 0), (30, 0), (20, 2), (12, 6), (8, 12)], (45, 5))
    ghost(f4, set(line_cells([(30, 0), (20, 1), (10, 5), (5, 12), (5, 20)])), GHOST2)
    f5 = standing(cx=33, cy=20, rx=9, ry=6, lean=0.12, tail=(24, 13), head_at=(40, 12), neck_pts=[(36, 16), (39, 13)],
                  head_kw=dict(eye="squint"), legs=WIDE_LEGS)
    wing(f5, [(34, 18), (41, 15), (46, 13)], 5.5, 2.5)
    f5 = finish(f5)
    lash(f5, [(47, 12), (52, 12), (58, 13), (63, 11)], (47, 13))
    ghost_wing(f5, [(34, 18), (39, 9), (44, 4)], 5, 2, GHOST)
    smear_arc(f5, 34, 18, 14, -85, -20, 2.5, GHOST)
    smear_arc(f5, 34, 18, 17, -70, -25, 1.5, GHOST2)
    ghost(f5, set(line_cells([(47, 9), (54, 6), (61, 4)])), GHOST2)
    feathers(f5, [(60, 8)])
    f6 = standing(cx=31, cy=20, rx=8.5, ry=6.5, lean=-0.22, tail=(27, 13), head_at=(33, 11), neck_pts=[(33, 16), (33, 12)],
                  head_kw=dict(tilt=1, eye="shut"), legs=two_legs([(28, 26), (24, 30)], [(34, 26), (36, 30)], toe_b=True))
    wing(f6, [(32, 17), (36, 12), (38, 7)], 5, 2)
    f6 = finish(f6)
    lash(f6, [(39, 6), (44, 9), (49, 5), (54, 9), (59, 5), (62, 8)], (39, 7))
    ghost(f6, set(line_cells([(40, 10), (48, 12), (56, 12), (63, 11)])), GHOST2)
    dashes(f6, [(46, 16, 4), (44, 19, 5)])
    f7 = standing(cx=32, cy=20.5, lean=-0.06, head_at=(36, 12), neck_pts=[(34, 17), (36, 13)])
    wing(f7, [(33, 17), (38, 20), (42, 22)], 5, 2)
    f7 = finish(f7)
    lash(f7, [(43, 22), (47, 27), (52, 30), (58, 31), (63, 29)], (43, 23))
    f8 = BODY.copy()
    lash(f8, [(42, 30), (46, 28), (49, 30), (46, 31), (43, 31)], (41, 29))
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8]


def make_whip_hold() -> list[np.ndarray]:
    """the lash taut, leaning back against the pull; the second key a wave along it"""
    f0 = standing(cx=32, cy=20, rx=9, ry=6, lean=-0.1, tail=(26, 13), head_at=(37, 12), neck_pts=[(35, 16), (37, 13)],
                  head_kw=dict(eye="squint"), legs=two_legs([(28, 26), (25, 30)], [(35, 26), (37, 30)]))
    wing(f0, [(33, 18), (40, 15), (46, 13)], 5.5, 2.5)
    f0 = finish(f0)
    lash(f0, [(47, 12), (63, 11)], (47, 13))
    f1 = f0.copy()
    erase(f1, 47, 9, 63, 14)
    lash(f1, [(47, 12), (52, 10), (57, 13), (63, 11)], (47, 13))
    return [f0, f1]


def make_spin() -> list[np.ndarray]:
    """0 the twist back: head turned, wing wrapped across · 1 the first turn: the
    head in two places · 2–5 the wheel: the body a disc of smear rings with a
    wing tip at a different spoke each key, gusts curling round it · 6 slowing:
    side on, leaning · 7 settle."""
    f0 = standing(cx=31, cy=20.5, lean=-0.12, tail=(26, 13), head_at=(33, 12), neck_pts=[(32, 16), (33, 13)],
                  head_kw=dict(eye="squint"))
    wing(f0, [(32, 17), (39, 20), (42, 24)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=20.5, lean=0.04, tail=(24, 13), head_at=(37, 12), neck_pts=[(34, 17), (37, 13)],
                  head_kw=dict(eye="squint"))
    wing(f1, [(33, 17), (26, 12), (22, 8)], 5, 2)
    f1 = finish(f1)
    head_ghost(f1, 33, 12, GHOST)
    smear_arc(f1, 32, 19, 12, -140, -50, 2, GHOST2)

    def wheel(spoke: float, gust: float) -> np.ndarray:
        f = blank()
        leg(f, [(29, 27), (28, 30)], ORANGE, 1)
        leg(f, [(35, 27), (36, 30)], BROWN, 1)
        body(f, 32, 19, 8.5, 8, None)
        fill_cells(f, ellipse_cells(32.5 + math.cos(math.radians(spoke)) * 3, 11.5, 3.5, 3))
        a = math.radians(spoke)
        wing(f, [(32, 19), (32 + math.cos(a) * 9, 19 + math.sin(a) * 6), (32 + math.cos(a) * 15, 19 + math.sin(a) * 9)], 5, 2)
        f = finish(f)
        b = math.radians(spoke - 40)
        ghost_wing(f, [(32, 19), (32 + math.cos(b) * 9, 19 + math.sin(b) * 6), (32 + math.cos(b) * 15, 19 + math.sin(b) * 9)], 5, 2, GHOST2)
        smear_arc(f, 32, 19, 11, spoke - 200, spoke - 20, 2, GHOST)
        smear_arc(f, 32, 19, 14, spoke - 120, spoke + 30, 1.5, GHOST2)
        smear_arc(f, 32, 19, 17, spoke - 260, spoke - 160, 1.5, GHOST2)
        for k in range(3):
            g = math.radians(gust + k * 120)
            gx, gy = 32 + math.cos(g) * 20, 19 + math.sin(g) * 13
            ghost(f, arc_cells(gx, gy, 3, gust + k * 120 - 90, gust + k * 120 + 60, 1), GHOST2)
        return f

    f2 = wheel(-30, 0)
    f3 = wheel(60, 60)
    f4 = wheel(150, 120)
    f5 = wheel(240, 180)
    f2[10, 34] = OUTLINE
    f4[10, 31] = OUTLINE
    f6 = standing(cx=33, cy=20.5, lean=0.1, tail=(24, 13), head_at=(39, 12), neck_pts=[(35, 17), (38, 13)],
                  head_kw=dict(eye="squint"))
    wing(f6, [(34, 17), (43, 15), (50, 14)], 5, 2)
    f6 = finish(f6)
    ghost_wing(f6, [(34, 17), (38, 9), (42, 4)], 5, 2, GHOST2)
    smear_arc(f6, 33, 19, 12, -120, -10, 2, GHOST2)
    f7 = standing(lean=-0.03)
    wing(f7, [(33, 17), (37, 20), (39, 22)], 5, 2)
    f7 = finish(f7)
    return [f0, f1, f2, f3, f4, f5, f6, f7]


def make_flurry() -> list[np.ndarray]:
    """Punches from every side — the goose dashes round the enemy and the game
    moves it per key.  0 CONTACT front: leaning in, the punch high, the low one's
    ghost · 1 the dash up and over: seen from behind, a streak of ghosts ·
    2 from above: upside down, the wing driving straight down · 3 the dash round
    the far side: seen from the front, three-quarter, streaking · 4 from behind:
    drawn facing LEFT (the game mirrors it, so it punches back at the enemy) ·
    5 the dash back down to the front: a streak of ghosts · 6 the BIG one: both
    wings forward, dashes behind, feathers (held) · 7 recover."""
    base = dict(cx=34, cy=20, rx=9, ry=6, lean=0.14, tail=(24, 13), head_at=(41, 12), neck_pts=[(36, 16), (40, 13)],
                head_kw=dict(eye="squint"), legs=two_legs([(30, 26), (27, 30)], [(36, 26), (39, 30)]))
    HIGH = [(35, 17), (44, 13), (53, 11)]
    LOW_ = [(35, 19), (44, 22), (53, 24)]
    # 0 · front
    f0 = standing(**base)
    wing(f0, HIGH, 5.5, 2.5)
    f0 = finish(f0)
    ghost_wing(f0, LOW_, 5, 2, GHOST)
    dashes(f0, [(18, 15, 4), (16, 19, 5)], GHOST2)
    # 1 · the dash up and over, from behind
    f1 = blank()
    leg(f1, [(31, 24), (30, 27), (29, 28)], ORANGE, -1, True)
    leg(f1, [(34, 24), (35, 27), (36, 28)], BROWN, 1, True)
    back_view(f1, 32.5, 18, 7, 7, (33, 10))
    wing(f1, [(30, 15), (24, 20), (20, 24)], 5, 2)
    wing(f1, [(36, 15), (42, 20), (46, 24)], 5, 2)
    f1 = finish(f1)
    ghost(f1, ellipse_cells(24.5, 28, 6, 5.5), GHOST)
    ghost(f1, ellipse_cells(17.5, 36, 5, 5), GHOST2)
    speed_lines(f1, [(12, 30, 8), (50, 26, 6), (8, 38, 6)], GHOST2)
    # 2 · from above: upside down, the wing straight down
    f2 = blank()
    body(f2, 32, 14, 7, 8.5, None)
    neck(f2, [(34, 20), (36, 24)])
    head_down(f2, 36, 25, eye="squint")
    leg(f2, [(30, 7), (28, 3), (26, 1)], ORANGE, -1, True)
    leg(f2, [(35, 7), (37, 3), (39, 1)], BROWN, 1, True)
    wing(f2, [(31, 16), (28, 26), (26, 36)], 5.5, 2.5)
    wing(f2, [(35, 16), (43, 22), (48, 26)], 4.5, 2)
    f2 = finish(f2)
    ghost_wing(f2, [(31, 16), (22, 22), (16, 26)], 5, 2, GHOST)
    smear_arc(f2, 31, 16, 17, 100, 170, 2.5, GHOST)
    speed_lines(f2, [(18, 4, 7), (48, 6, 6)], GHOST2)
    # 3 · round the far side, seen from the front, streaking
    f3 = blank()
    leg(f3, [(29, 26), (28, 30)], ORANGE, -1)
    leg(f3, [(35, 26), (36, 30)], BROWN, 1)
    body(f3, 32, 20, 8, 6.5, None)
    neck(f3, [(32, 15), (32, 12)], 5)
    head_front(f3, 32, 8, eye="squint")
    wing(f3, [(26, 17), (20, 20), (16, 24)], 5, 2)
    wing(f3, [(38, 17), (44, 20), (48, 24)], 5, 2)
    f3 = finish(f3)
    ghost(f3, ellipse_cells(44.5, 22, 7, 6), GHOST)
    ghost(f3, ellipse_cells(55.5, 24, 6, 5.5), GHOST2)
    dashes(f3, [(48, 12, 8), (52, 30, 8), (46, 8, 6)], GHOST2)
    # 4 · from behind the enemy: drawn facing left
    f4 = blank()
    leg(f4, [(34, 26), (37, 30)], ORANGE, -1)
    leg(f4, [(28, 26), (25, 30)], BROWN, -1)
    body(f4, 30, 20, 9, 6, (37, 13), -0.14)
    neck(f4, [(28, 16), (24, 13)])
    head_left(f4, 23, 12, eye="squint")
    wing(f4, [(29, 17), (20, 13), (11, 11)], 5.5, 2.5)
    f4 = finish(f4)
    ghost_wing(f4, [(29, 19), (20, 22), (11, 24)], 5, 2, GHOST)
    dashes(f4, [(42, 15, 4), (44, 19, 5)], GHOST2)
    # 5 · the dash back to the front: a streak
    f5 = standing(cx=33, cy=19.5, rx=9.5, ry=5.5, lean=0.22, tail=(23, 13), head_at=(42, 12), neck_pts=[(36, 16), (41, 13)],
                  head_kw=dict(eye="squint"), legs=two_legs([(29, 26), (24, 30)], [(37, 26), (41, 30)], toe_b=True))
    wing(f5, [(34, 18), (29, 22), (25, 25)], 5, 2)
    f5 = finish(f5)
    ghost(f5, ellipse_cells(52.5, 13, 8, 5), GHOST)
    ghost(f5, ellipse_cells(60.5, 8, 6, 4.5), GHOST2)
    dashes(f5, [(44, 22, 8), (48, 26, 10), (40, 6, 6)], GHOST2)
    # 6 · the big one
    f6 = standing(**{**base, "cx": 36, "lean": 0.2, "head_at": (43, 12), "neck_pts": [(38, 16), (42, 13)],
                     "legs": two_legs([(31, 26), (27, 30)], [(38, 26), (41, 30)], toe_b=True)})
    wing(f6, [(37, 17), (48, 15), (59, 14)], 6, 3)
    wing(f6, [(37, 19), (47, 19), (58, 19)], 6, 3)
    f6 = finish(f6)
    ghost_wing(f6, [(37, 17), (44, 12), (50, 9)], 5, 2.5, GHOST)
    ghost_wing(f6, [(37, 19), (44, 24), (50, 27)], 5, 2.5, GHOST)
    dashes(f6, [(14, 14, 6), (12, 18, 7), (14, 22, 6)], GHOST)
    feathers(f6, [(56, 8), (60, 24)])
    f7 = standing(cx=33, lean=0.06, head_at=(39, 12), neck_pts=[(35, 17), (38, 13)])
    wing(f7, [(34, 17), (38, 20), (41, 22)], 5, 2)
    f7 = finish(f7)
    return [f0, f1, f2, f3, f4, f5, f6, f7]


def sound_waves(f: np.ndarray, x: int, y: int, radii: list[int], spread: float = 48) -> None:
    """arcs off the beak: the near one solid, the far ones fading"""
    cols = [WHITE, GHOST, GHOST2, GHOST2]
    for i, r in enumerate(radii):
        cells = arc_cells(x, y, r, -spread, spread, 1.2)
        col = cols[min(i, len(cols) - 1)]
        for (cx, cy) in cells:
            if inb(cx, cy) and f[cy, cx, 3] == 0:
                f[cy, cx] = col
        if col == WHITE:
            outline_cells(f, {c for c in cells if inb(*c)})


def make_megahonk() -> list[np.ndarray]:
    """0 inhale: head back and up, chest swelling, wings flaring back · 1 more:
    bigger, cheeks out, eyes shut, feet planted wide · 2 the peak, held · 3 the
    neck whips forward, beak opening, ghost heads · 4 the honk begins: beak wide,
    the first wave · 5 CONTACT: beak wide, three waves off it, the body shoved
    back by it, feathers flying (held) · 6 held on: the waves wider · 7 exhale:
    deflated, head drooping · 8 idle."""
    f0 = standing(cx=31, cy=20, rx=9, ry=6.5, lean=-0.12, tail=(25, 13), head_at=(33, 10), neck_pts=[(33, 16), (33, 11)],
                  head_kw=dict(tilt=2))
    wing(f0, [(31, 17), (25, 15), (21, 16)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=31, cy=19.5, rx=10, ry=7.5, lean=-0.14, tail=(24, 12), head_at=(33, 8), neck_pts=[(33, 15), (33, 9)],
                  head_kw=dict(tilt=2, eye="shut", puff=2), legs=two_legs([(28, 26), (25, 30)], [(35, 26), (38, 30)]))
    wing(f1, [(30, 16), (23, 12), (18, 12)], 5, 2)
    f1 = finish(f1)
    f2 = standing(cx=31, cy=19, rx=10.5, ry=8, lean=-0.16, tail=(24, 11), head_at=(33, 7), neck_pts=[(33, 15), (33, 8)],
                  head_kw=dict(tilt=2, eye="shut", puff=3), legs=two_legs([(28, 26), (24, 30)], [(35, 26), (39, 30)]))
    wing(f2, [(30, 16), (23, 11), (17, 10)], 5, 2)
    f2 = finish(f2)
    dashes(f2, [(22, 4, 3), (38, 3, 3)], GHOST2)
    f3 = standing(cx=33, cy=19.5, rx=10, ry=7.5, lean=0.08, tail=(24, 12), head_at=(41, 10), neck_pts=[(36, 15), (40, 11)],
                  head_kw=dict(beak="open", eye="squint"), legs=WIDE_LEGS)
    wing(f3, [(33, 17), (27, 13), (22, 12)], 5, 2)
    f3 = finish(f3)
    head_ghost(f3, 33, 8, GHOST2, tilt=2)
    head_ghost(f3, 37, 9, GHOST, tilt=1)
    f4 = standing(cx=33, cy=19.5, rx=10, ry=7, lean=0.1, tail=(24, 12), head_at=(42, 11), neck_pts=[(36, 15), (41, 12)],
                  head_kw=dict(beak="wide", eye="squint"), legs=WIDE_LEGS)
    wing(f4, [(33, 17), (27, 13), (22, 12)], 5, 2)
    f4 = finish(f4)
    sound_waves(f4, 50, 9, [5])
    f5 = standing(cx=31, cy=19.5, rx=10, ry=7, lean=-0.12, tail=(25, 12), head_at=(38, 10), neck_pts=[(35, 15), (37, 11)],
                  head_kw=dict(beak="wide", eye="shut"), legs=two_legs([(28, 26), (23, 30)], [(35, 26), (38, 30)], toe_b=True))
    wing(f5, [(31, 17), (25, 11), (20, 8)], 5, 2)
    wing(f5, [(33, 17), (28, 12), (24, 9)], 4.5, 2)
    f5 = finish(f5)
    sound_waves(f5, 46, 9, [5, 10, 15])
    feathers(f5, [(20, 3), (26, 1), (16, 12)])
    dashes(f5, [(12, 24, 4), (10, 28, 5)], GHOST2)
    f6 = f5.copy()
    erase(f6, 47, 0, 63, 30)
    sound_waves(f6, 46, 9, [7, 12, 17, 22])
    f7 = standing(cx=32, cy=21.5, rx=8.5, ry=5.5, lean=0.02, tail=(24, 15), head_at=(38, 15), neck_pts=[(35, 18), (37, 16)],
                  head_kw=dict(tilt=-2, beak="open"))
    wing(f7, [(33, 18), (37, 22), (40, 25)], 5, 2)
    f7 = finish(f7)
    ghost(f7, arc_cells(46, 12, 9, -30, 30, 1), GHOST2)
    f8 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8]


# ═══════════════════════════════════════════════════════════════════════════
# the rock, and the moves that throw it
# ═══════════════════════════════════════════════════════════════════════════
ROCK_LIGHT = (196, 200, 205, 255)
ROCK_MID = (140, 144, 155, 255)
ROCK_DARK = (92, 96, 110, 255)
ROCK_DEEP = (58, 60, 72, 255)
ROCK_W, ROCK_H = 26, 19


def rock_shape() -> set[tuple[int, int]]:
    """a rough boulder: an ellipse with lumps added and bites taken, so no two edges match"""
    cells = ellipse_cells(ROCK_W / 2, ROCK_H / 2, ROCK_W / 2 - 0.5, ROCK_H / 2 - 0.5)
    cells |= ellipse_cells(6, 6, 4.5, 4)
    cells |= ellipse_cells(20, 5, 4, 3.5)
    cells |= ellipse_cells(22, 14, 3.5, 3)
    cells -= ellipse_cells(13, 1.5, 3, 2)
    cells -= ellipse_cells(1.5, 12, 2.5, 2.5)
    cells -= ellipse_cells(25, 9, 1.5, 2)
    return {(x + 1, y + 1) for (x, y) in cells if 0 <= x < ROCK_W and 0 <= y < ROCK_H}


def rock() -> np.ndarray:
    """The boulder: rough, lit from the top-left in three greys, cracked and speckled."""
    out = blank()
    cells = rock_shape()
    for (x, y) in cells:
        v = (x + 1.3 * y) / (ROCK_W + 1.3 * ROCK_H)
        out[y, x] = ROCK_LIGHT if v < 0.34 else (ROCK_MID if v < 0.68 else ROCK_DARK)
    for (x, y) in line_cells([(9, 4), (11, 8), (10, 12), (13, 16)]) + line_cells([(17, 3), (16, 7), (19, 10)]):
        if (x, y) in cells:
            out[y, x] = ROCK_DEEP
    for (x, y) in ((5, 9), (6, 14), (21, 8), (23, 12), (15, 13), (3, 6), (19, 16)):
        if (x, y) in cells:
            out[y, x] = ROCK_DARK if out[y, x][0] > 150 else ROCK_DEEP
    for (x, y) in ((8, 3), (14, 5), (4, 8), (12, 10)):
        if (x, y) in cells and tuple(out[y, x]) == ROCK_LIGHT:
            out[y, x] = (222, 226, 230, 255)
    return repair_outline(out)


ROCK = rock()


def rock_at(dst: np.ndarray, x: int, y: int) -> None:
    """Place the boulder with its top-left (outline included) at (x, y)."""
    place(dst, ROCK, x, y)


CHUNKS = [(6, 6, 5, 4.5), (18, 5, 5.5, 4), (8, 14, 5, 4), (19, 14, 5.5, 4.5), (13, 10, 4, 3.5), (24, 9, 2.5, 3)]
FLINGS = [(-1.6, -1.4), (1.5, -1.6), (-1.7, 0.2), (1.8, -0.3), (0.1, -2.0), (2.2, -1.0)]


def rock_break(step: int, n: int = 5) -> np.ndarray:
    """The boulder in six sizable chunks flying apart: out along their flings,
    lifted then falling under gravity, pebbles between them."""
    a = ROCK
    out = blank()
    cx0, cy0 = ROCK_W / 2 + 1, ROCK_H / 2 + 1
    t = step / (n - 1)
    for (cx, cy, rx, ry), (vx, vy) in zip(CHUNKS, FLINGS):
        cells = {c for c in ellipse_cells(cx + 1, cy + 1, rx, ry) if a[c[1], c[0], 3] and tuple(a[c[1], c[0]]) != OUTLINE}
        dx = int(round(vx * 9 * t))
        dy = int(round(vy * 9 * t + 14 * t * t))
        if step >= 3:
            edge = {c for c in cells if any((c[0] + i, c[1] + j) not in cells for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)))}
            cells -= edge if step == 4 else set(list(edge)[::2])
        for (x, y) in cells:
            if inb(x + dx, y + dy):
                out[y + dy, x + dx] = a[y, x]
    if step >= 1:
        for i, (vx, vy) in enumerate(((-1.1, -2.2), (0.6, -2.6), (1.9, -1.9), (-2.1, -0.8), (1.2, 0.4))):
            px = int(round(cx0 + vx * 12 * t))
            py = int(round(cy0 + vy * 12 * t + 18 * t * t))
            if inb(px, py) and out[py, px, 3] == 0:
                out[py, px] = ROCK_MID if i % 2 else ROCK_DARK
    return repair_outline(out)


def make_rock() -> list[np.ndarray]:
    f = blank()
    rock_at(f, 32 - ROCK_W // 2 - 1, 32 - ROCK_H // 2 - 1)
    return [f]


def make_rock_break() -> list[np.ndarray]:
    return [shift(rock_break(i), 32 - ROCK_W // 2 - 1, 32 - ROCK_H // 2 - 1) for i in range(5)]


ROCK_GROUND = (44, FEET - ROCK_H - 2)


def make_boulder() -> list[np.ndarray]:
    """0 squat over the rock ahead · 1 the grab: bent over it, wings round it,
    head down · 2 the heave: the rock to the chest, leaning back, legs bent under
    the weight, squinting · 3 hoist: overhead, wings straight up, the head tilted
    right back to look at it, stretched tall · 4 the spring: compressed under it
    · 5 the leap, rock overhead, head up · 6 the THROW: wings flung forward and
    down, the head following through, the rock gone · 7 CONTACT (it lands):
    leaning far forward after it, wings low · 8 land squat · 9 stand.
    Keys 3–5 are drawn 16 low, 6–7 10 low (D); the game lifts them."""
    D = 10
    f0 = standing(cx=31, cy=23, rx=10, ry=5, lean=0.06, tail=(21, 18), head_at=(36, 15), neck_pts=[(34, 19), (36, 16)],
                  head_kw=dict(tilt=-2), legs=two_legs([(27, 27), (26, 30)], [(34, 27), (35, 30)]))
    wing(f0, [(32, 20), (37, 24), (40, 28)], 5, 2)
    f0 = finish(f0)
    rock_at(f0, *ROCK_GROUND)
    f1 = standing(cx=32, cy=22.5, rx=10, ry=5.5, lean=0.16, tail=(21, 17), head_at=(41, 15), neck_pts=[(36, 19), (40, 16)],
                  head_kw=dict(tilt=-2, eye="squint"), legs=two_legs([(27, 27), (25, 30)], [(34, 27), (35, 30)]))
    f1 = finish(f1)
    rock_at(f1, *ROCK_GROUND)
    wing(f1, [(34, 20), (40, 23), (44, 27)], 5, 2.5)
    wing(f1, [(32, 21), (36, 26), (38, 30)], 4.5, 2)
    f1 = repair_outline(f1)
    f2 = standing(cx=30, cy=21.5, rx=9.5, ry=6, lean=-0.14, tail=(24, 14), head_at=(33, 12), neck_pts=[(32, 17), (33, 13)],
                  head_kw=dict(tilt=1, eye="squint"), legs=two_legs([(27, 27), (25, 30)], [(34, 27), (37, 30)]))
    f2 = finish(f2)
    rock_at(f2, 36, 8)
    wing(f2, [(32, 18), (38, 21), (44, 26)], 5, 2.5)
    wing(f2, [(31, 19), (36, 25), (41, 28)], 4.5, 2)
    f2 = repair_outline(f2)
    dashes(f2, [(28, 5, 3), (22, 9, 3)], GHOST2)
    # the hoist keys sit lower still (E) so the rock rides clear above the head, which looks up at it
    E = 16
    f3 = standing(cx=32, cy=19.5 + E, rx=7.5, ry=7.5, lean=-0.06, tail=(26, 12 + E), head_at=(34, 9 + E), neck_pts=[(33, 15 + E), (34, 10 + E)],
                  head_kw=dict(tilt=3, eye="squint"), legs=two_legs([(29, 26 + E), (28, 30 + E)], [(35, 26 + E), (36, 30 + E)]))
    f3 = finish(f3)
    rock_at(f3, 20, 0)
    head(f3, 34, 9 + E, tilt=3, eye="squint")
    wing(f3, [(30, 16 + E), (25, 10 + E), (22, 6 + E)], 5, 2.5)
    wing(f3, [(35, 16 + E), (41, 10 + E), (45, 6 + E)], 5, 2.5)
    f3 = repair_outline(f3)
    f4 = standing(cx=32, cy=22 + E, rx=9.5, ry=5.5, lean=-0.04, tail=(23, 16 + E), head_at=(34, 13 + E), neck_pts=[(33, 18 + E), (34, 14 + E)],
                  head_kw=dict(tilt=3, eye="squint"), legs=two_legs([(28, 27 + E), (26, 30 + E)], [(35, 27 + E), (37, 30 + E)]))
    f4 = finish(f4)
    rock_at(f4, 20, 4)
    head(f4, 34, 13 + E, tilt=3, eye="squint")
    wing(f4, [(30, 19 + E), (25, 14 + E), (22, 10 + E)], 5, 2.5)
    wing(f4, [(35, 19 + E), (41, 14 + E), (45, 10 + E)], 5, 2.5)
    f4 = repair_outline(f4)
    f5 = standing(cx=33, cy=19 + E, rx=7, ry=8, lean=0.06, tail=(27, 11 + E), head_at=(36, 8 + E), neck_pts=[(34, 14 + E), (36, 9 + E)],
                  head_kw=dict(tilt=2),
                  legs=two_legs([(30, 26 + E), (28, 28 + E), (26, 28 + E)], [(36, 26 + E), (38, 28 + E), (40, 28 + E)], -1, 1, True, True))
    f5 = finish(f5)
    rock_at(f5, 22, 0)
    head(f5, 36, 8 + E, tilt=2)
    wing(f5, [(31, 16 + E), (27, 10 + E), (24, 5 + E)], 5, 2.5)
    wing(f5, [(36, 16 + E), (42, 10 + E), (47, 5 + E)], 5, 2.5)
    f5 = repair_outline(f5)
    speed_lines(f5, [(16, 18 + E, 5), (50, 16 + E, 5)])
    f6 = standing(cx=34, cy=19 + D, rx=8, ry=7, lean=0.24, tail=(26, 11 + D), head_at=(42, 9 + D), neck_pts=[(37, 15 + D), (41, 10 + D)],
                  head_kw=dict(tilt=-1, eye="squint"),
                  legs=two_legs([(31, 26 + D), (29, 29 + D), (27, 29 + D)], [(37, 26 + D), (39, 29 + D), (41, 29 + D)], -1, 1, True, True))
    wing(f6, [(35, 16 + D), (45, 12 + D), (54, 9 + D)], 5.5, 2.5)
    wing(f6, [(34, 18 + D), (43, 17 + D), (52, 15 + D)], 5, 2.5)
    f6 = finish(f6)
    ghost_wing(f6, [(35, 16 + D), (37, 7 + D), (40, 0 + D)], 5, 2.5, GHOST)
    smear_arc(f6, 35, 16 + D, 15, -95, -25, 2.5, GHOST)
    smear_arc(f6, 35, 16 + D, 18, -80, -30, 1.5, GHOST2)
    f7 = standing(cx=35, cy=20 + D, rx=8.5, ry=6.5, lean=0.3, tail=(26, 13 + D), head_at=(44, 12 + D), neck_pts=[(38, 16 + D), (43, 13 + D)],
                  head_kw=dict(tilt=-2), legs=two_legs([(31, 26 + D), (28, 30 + D)], [(38, 26 + D), (40, 30 + D)], toe_b=True))
    wing(f7, [(35, 18 + D), (43, 23 + D), (50, 27 + D)], 5.5, 2)
    wing(f7, [(34, 19 + D), (40, 25 + D), (45, 29 + D)], 5, 2)
    f7 = finish(f7)
    ghost_wing(f7, [(35, 18 + D), (45, 15 + D), (54, 12 + D)], 5, 2, GHOST2)
    f8 = squat(lean=0.08, cx=33)
    wing(f8, [(34, 20), (39, 23), (43, 22)], 5, 2)
    f8 = finish(f8)
    dust(f8, [(22, 30), (42, 30)])
    f9 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9]


def make_volley() -> list[np.ndarray]:
    """0 squat over the rock · 1 the TOSS: both wings flung straight up, head up,
    stretched, the rock gone (a prop) · 2 watching it: head right back · 3 the
    load: twisted back like a batter, wing far behind (held) · 4 the BAT: the
    wing swung up and forward through the rock's height, smeared, lunging ·
    5 through · 6 crouch · 7 the dash: low, stretched, dashes behind · 8 the
    leap: wing raised overhead · 9 the SMASH: leaning far in, the wing driven
    down and through, its arc smeared, feathers (held) · 10 the skid · 11 stand.
    Keys 8–9 drawn low (D) and lifted by the game."""
    D = 8
    f0 = standing(cx=31, cy=23, rx=10, ry=5, lean=0.06, tail=(21, 18), head_at=(36, 15), neck_pts=[(34, 19), (36, 16)],
                  head_kw=dict(tilt=-2), legs=two_legs([(27, 27), (26, 30)], [(34, 27), (35, 30)]))
    wing(f0, [(32, 20), (37, 24), (40, 28)], 5, 2)
    f0 = finish(f0)
    rock_at(f0, *ROCK_GROUND)
    f1 = standing(cx=32, cy=18.5, rx=7.5, ry=7.5, lean=-0.02, tail=(25, 11), head_at=(35, 8), neck_pts=[(34, 14), (35, 9)],
                  head_kw=dict(tilt=3), legs=two_legs([(29, 25), (28, 30)], [(35, 25), (36, 30)], toe_b=True))
    wing(f1, [(30, 16), (27, 9), (26, 2)], 5, 2.5)
    wing(f1, [(36, 16), (40, 9), (42, 2)], 5, 2.5)
    f1 = finish(f1)
    ghost_wing(f1, [(30, 16), (34, 24), (37, 29)], 5, 2, GHOST2)
    ghost_wing(f1, [(36, 16), (41, 22), (45, 27)], 5, 2, GHOST2)
    speed_lines(f1, [(20, 6, 6), (48, 5, 6)])
    f2 = standing(cx=31, cy=19.5, rx=8.5, ry=6.5, lean=-0.1, tail=(25, 12), head_at=(34, 9), neck_pts=[(33, 15), (34, 10)],
                  head_kw=dict(tilt=3))
    wing(f2, [(31, 17), (26, 14), (22, 14)], 5, 2)
    f2 = finish(f2)
    f3 = standing(cx=30, cy=20, rx=9, ry=6.5, lean=-0.16, tail=(25, 13), head_at=(33, 10), neck_pts=[(32, 16), (33, 11)],
                  head_kw=dict(tilt=2, eye="squint"), legs=two_legs([(27, 26), (24, 30)], [(34, 26), (36, 30)]))
    wing(f3, [(30, 17), (22, 12), (15, 9)], 5.5, 2.5)
    f3 = finish(f3)
    f4 = standing(cx=34, cy=19, rx=9, ry=6.5, lean=0.16, tail=(25, 12), head_at=(40, 9), neck_pts=[(36, 15), (39, 10)],
                  head_kw=dict(tilt=2, eye="squint"), legs=two_legs([(30, 25), (27, 30)], [(37, 25), (40, 30)], toe_b=True))
    wing(f4, [(35, 16), (44, 8), (52, 1)], 6, 3)
    f4 = finish(f4)
    ghost_wing(f4, [(35, 16), (25, 12), (18, 8)], 5, 2.5, GHOST2)
    ghost_wing(f4, [(35, 16), (36, 6), (38, -2)], 5, 2.5, GHOST)
    smear_arc(f4, 35, 16, 15, -170, -40, 3, GHOST)
    smear_arc(f4, 35, 16, 18, -150, -50, 1.5, GHOST2)
    f5 = standing(cx=34, cy=19.5, rx=9, ry=6, lean=0.14, tail=(25, 13), head_at=(41, 11), neck_pts=[(36, 16), (40, 12)],
                  head_kw=dict(tilt=1), legs=two_legs([(30, 26), (27, 30)], [(37, 26), (40, 30)]))
    wing(f5, [(35, 17), (45, 14), (54, 12)], 5.5, 2.5)
    f5 = finish(f5)
    ghost_wing(f5, [(35, 17), (44, 9), (52, 3)], 5, 2.5, GHOST2)
    f6 = squat(dict(eye="squint"), 0.08)
    wing(f6, [(33, 20), (28, 23), (25, 26)], 5, 2)
    f6 = finish(f6)
    f7 = standing(cx=33, cy=22.5, rx=11, ry=5, lean=0.2, tail=(21, 17), head_at=(45, 15), neck_pts=[(38, 19), (44, 16)],
                  head_kw=dict(eye="squint"), legs=two_legs([(29, 27), (23, 30)], [(37, 27), (43, 30)], toe_b=True))
    wing(f7, [(35, 20), (30, 24), (26, 27)], 5, 2)
    f7 = finish(f7)
    dashes(f7, [(6, 18, 8), (4, 22, 10), (8, 26, 7)], GHOST)
    dashes(f7, [(2, 20, 5), (12, 15, 5)], GHOST2)
    dust(f7, [(16, 30), (22, 31)])
    f8 = standing(cx=33, cy=18 + D, rx=7.5, ry=8, lean=0.12, tail=(26, 10 + D), head_at=(38, 7 + D), neck_pts=[(35, 13 + D), (37, 8 + D)],
                  head_kw=dict(tilt=1, eye="squint"),
                  legs=two_legs([(30, 25 + D), (28, 28 + D), (26, 29 + D)], [(36, 25 + D), (38, 28 + D), (40, 29 + D)], toe_a=True, toe_b=True))
    wing(f8, [(33, 15 + D), (31, 7 + D), (32, 0 + D)], 5.5, 2.5)
    f8 = finish(f8)
    ghost_wing(f8, [(33, 15 + D), (28, 10 + D), (24, 6 + D)], 5, 2, GHOST2)
    speed_lines(f8, [(20, 16 + D, 6), (48, 14 + D, 5)])
    f9 = standing(cx=35, cy=19 + D, rx=9, ry=6.5, lean=0.3, tail=(25, 12 + D), head_at=(44, 11 + D), neck_pts=[(38, 15 + D), (43, 12 + D)],
                  head_kw=dict(tilt=-2, eye="squint"),
                  legs=two_legs([(31, 25 + D), (28, 29 + D), (27, 30 + D)], [(38, 25 + D), (41, 28 + D), (43, 29 + D)], toe_b=True))
    wing(f9, [(36, 17 + D), (46, 22 + D), (54, 29 + D)], 6, 3)
    f9 = finish(f9)
    ghost_wing(f9, [(36, 17 + D), (47, 12 + D), (57, 10 + D)], 5, 2.5, GHOST)
    ghost_wing(f9, [(36, 17 + D), (40, 7 + D), (44, 0 + D)], 5, 2.5, GHOST2)
    smear_arc(f9, 36, 17 + D, 18, -90, 40, 3, GHOST)
    smear_arc(f9, 36, 17 + D, 21, -75, 30, 1.5, GHOST2)
    feathers(f9, [(28, 4 + D), (33, 1 + D), (58, 22 + D)])
    f10 = squat(dict(eye="shut"), 0.12, 33)
    wing(f10, [(34, 20), (40, 23), (45, 22)], 5, 2)
    f10 = finish(f10)
    feathers(f10, [(22, 12), (48, 9), (40, 3)])
    dust(f10, [(18, 30), (24, 31)])
    f11 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11]


# ═══════════════════════════════════════════════════════════════════════════
# the reference combos: the launch and lash, and the roll
# ═══════════════════════════════════════════════════════════════════════════
def inverted(cx: float, cy: float, rx: float, ry: float, head_at: tuple[int, int], tail_up: bool = True,
             eye: str = "squint") -> np.ndarray:
    """the goose upside down in the air: feet up, head hanging, the tail (the weapon) on top"""
    f = blank()
    leg(f, [(int(cx) - 2, int(cy - ry) + 1), (int(cx) - 4, int(cy - ry) - 3), (int(cx) - 6, int(cy - ry) - 4)], ORANGE, -1, True)
    leg(f, [(int(cx) + 3, int(cy - ry) + 1), (int(cx) + 5, int(cy - ry) - 3), (int(cx) + 7, int(cy - ry) - 4)], BROWN, 1, True)
    body(f, cx, cy, rx, ry, None)
    neck(f, [(cx + 2, cy + ry - 2), head_at])
    head_down(f, *head_at, eye=eye)
    return f


def make_launch() -> list[np.ndarray]:
    """The beak flip and the lash.  0 the head goes low, beak under the enemy ·
    1 coiled: lower, the neck an S, eye up at the target (held) · 2 the FLIP:
    the head flung straight up, neck at full stretch, the smear of the beak from
    the ground to the sky, the body rising on its toes — the enemy goes high ·
    3 watching it go, head back · 4 the dash up: stretched, wings back, speed
    lines · 5 turning over: from behind, the body tilting · 6 upside down over
    the enemy, wings out, the tail cocked · 7 the TAIL LASH: the body whipping
    over, the tail driven down through, its arc smeared (held) · 8 falling
    upright · 9 land squat · 10 stand.  Keys 4–8 drawn low (D), lifted by the game."""
    D = 6
    f0 = standing(cx=32, cy=22, rx=9.5, ry=5.5, lean=0.1, tail=(22, 16), head_at=(41, 22), neck_pts=[(37, 19), (40, 22)],
                  head_kw=dict(tilt=-3), legs=two_legs([(28, 26), (26, 30)], [(35, 26), (37, 30)]))
    wing(f0, [(33, 19), (28, 22), (24, 25)], 5, 2)
    f0 = finish(f0)
    f1 = standing(cx=32, cy=23, rx=10, ry=5, lean=0.06, tail=(21, 18), head_at=(43, 26), neck_pts=[(37, 21), (41, 25)],
                  head_kw=dict(tilt=-2, eye="squint"), legs=two_legs([(27, 27), (25, 30)], [(35, 27), (37, 30)]))
    wing(f1, [(33, 20), (28, 23), (24, 26)], 5, 2)
    f1 = finish(f1)
    f2 = standing(cx=33, cy=17, rx=7.5, ry=7.5, lean=0.02, tail=(26, 9), head_at=(38, 1), neck_pts=[(35, 11), (38, 2)],
                  head_kw=dict(tilt=3, eye="squint"), legs=two_legs([(30, 24), (29, 28), (28, 29)], [(36, 24), (37, 28), (38, 29)], toe_a=True, toe_b=True))
    wing(f2, [(32, 15), (26, 19), (22, 22)], 5, 2)
    wing(f2, [(35, 15), (41, 19), (45, 22)], 5, 2)
    f2 = finish(f2)
    head_ghost(f2, 43, 22, GHOST2, tilt=-2)
    head_ghost(f2, 44, 12, GHOST, tilt=1)
    smear_arc(f2, 37, 14, 12, 10, 80, 3, GHOST)
    smear_arc(f2, 37, 14, 15, 5, 70, 1.5, GHOST2)
    f3 = standing(cx=32, cy=19.5, rx=8.5, ry=6.5, lean=-0.1, tail=(26, 12), head_at=(35, 8), neck_pts=[(34, 15), (35, 9)],
                  head_kw=dict(tilt=3))
    wing(f3, [(32, 17), (27, 14), (23, 14)], 5, 2)
    f3 = finish(f3)
    f4 = standing(cx=32, cy=17 + D, rx=6.5, ry=9, lean=0.0, tail=(26, 8 + D), head_at=(36, 4 + D), neck_pts=[(34, 10 + D), (36, 5 + D)],
                  head_kw=dict(tilt=3, eye="squint"),
                  legs=two_legs([(30, 25 + D), (29, 29 + D), (28, 31 + D)], [(35, 25 + D), (36, 29 + D), (37, 31 + D)], toe_a=True, toe_b=True))
    wing(f4, [(31, 15 + D), (28, 22 + D), (26, 28 + D)], 5, 2)
    wing(f4, [(35, 15 + D), (39, 22 + D), (41, 28 + D)], 5, 2)
    f4 = finish(f4)
    speed_lines(f4, [(20, 14 + D, 9), (45, 12 + D, 8), (14, 22 + D, 6), (50, 20 + D, 6)])
    f5 = blank()
    leg(f5, [(31, 23 + D), (30, 27 + D), (29, 29 + D)], ORANGE, -1, True)
    leg(f5, [(34, 23 + D), (35, 27 + D), (36, 29 + D)], BROWN, 1, True)
    back_view(f5, 32.5, 17 + D, 7.5, 7.5, (31, 9 + D))
    wing(f5, [(30, 14 + D), (23, 11 + D), (18, 9 + D)], 5, 2)
    wing(f5, [(36, 14 + D), (43, 11 + D), (48, 9 + D)], 5, 2)
    f5 = finish(f5)
    smear_arc(f5, 33, 17 + D, 13, 120, 300, 2, GHOST2)
    f6 = inverted(33, 17 + D, 7.5, 7.5, (36, 26 + D))
    wing(f6, [(29, 16 + D), (22, 14 + D), (17, 13 + D)], 5, 2)
    wing(f6, [(37, 16 + D), (44, 14 + D), (49, 13 + D)], 5, 2)
    stamp(f6, "  ##\n ###\n####", 27, 3 + D)                # the tail cocked up and back
    f6 = finish(f6)
    smear_arc(f6, 33, 17 + D, 13, -160, -20, 1.5, GHOST2)
    f7 = inverted(33, 18 + D, 8, 7, (36, 27 + D))
    wing(f7, [(29, 17 + D), (23, 13 + D), (19, 10 + D)], 5, 2)
    wing(f7, [(37, 17 + D), (43, 13 + D), (47, 10 + D)], 5, 2)
    stamp(f7, "###\n ####\n  #####\n     ###", 40, 20 + D)    # the tail driven down and forward through the enemy
    f7 = finish(f7)
    smear_arc(f7, 34, 15 + D, 15, -60, 60, 3, GHOST)
    smear_arc(f7, 34, 15 + D, 18, -45, 50, 1.5, GHOST2)
    ghost(f7, {(x, y) for (x, y) in solid_cells(shift(f6, 0, -4)) if y < 12 + D}, GHOST2)
    feathers(f7, [(52, 28 + D), (56, 22 + D)])
    f8 = standing(cx=33, cy=19 + D, rx=8, ry=7, lean=-0.04, tail=(25, 12 + D), head_at=(36, 8 + D), neck_pts=[(35, 13 + D), (36, 9 + D)],
                  legs=two_legs([(30, 25 + D), (28, 30 + D)], [(35, 25 + D), (37, 30 + D)]))
    wing(f8, [(33, 17 + D), (40, 14 + D), (46, 12 + D)], 5, 2)
    wing(f8, [(31, 17 + D), (25, 14 + D), (20, 12 + D)], 5, 2)
    f8 = finish(f8)
    speed_lines(f8, [(22, 4 + D, 6), (46, 2 + D, 6)], GHOST2)
    f9 = squat()
    wing(f9, [(33, 20), (38, 22), (42, 21)], 5, 2)
    f9 = finish(f9)
    dust(f9, [(23, 30), (39, 30)])
    f10 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10]


def make_dive() -> list[np.ndarray]:
    """The follow-up: 0 the spring, leaning in · 1 the drop: airborne, wing raised
    · 2 CONTACT: the punch driven down into the fallen enemy, the body over it,
    smeared (held) · 3 the bounce off · 4 stand.  Keys 1–2 drawn low (D)."""
    D = 6
    f0 = standing(cx=33, cy=22, rx=9.5, ry=5.5, lean=0.16, tail=(22, 16), head_at=(40, 14), neck_pts=[(36, 18), (39, 15)],
                  head_kw=dict(eye="squint"), legs=two_legs([(29, 26), (26, 30)], [(36, 26), (39, 30)], toe_b=True))
    wing(f0, [(33, 19), (27, 14), (24, 9)], 5, 2)
    f0 = finish(f0)
    dust(f0, [(22, 30), (40, 30)])
    f1 = standing(cx=33, cy=17 + D, rx=7.5, ry=8, lean=0.12, tail=(26, 9 + D), head_at=(38, 6 + D), neck_pts=[(35, 12 + D), (37, 7 + D)],
                  head_kw=dict(tilt=-1, eye="squint"),
                  legs=two_legs([(30, 24 + D), (28, 27 + D), (26, 28 + D)], [(36, 24 + D), (38, 27 + D), (40, 28 + D)], toe_a=True, toe_b=True))
    wing(f1, [(33, 14 + D), (31, 6 + D), (32, -1 + D)], 5.5, 2.5)
    f1 = finish(f1)
    speed_lines(f1, [(20, 10 + D, 7), (48, 8 + D, 6)])
    f2 = standing(cx=35, cy=21 + D, rx=9, ry=6, lean=0.34, tail=(25, 14 + D), head_at=(44, 14 + D), neck_pts=[(38, 17 + D), (43, 15 + D)],
                  head_kw=dict(tilt=-3, eye="squint"),
                  legs=two_legs([(31, 27 + D), (28, 30 + D)], [(38, 27 + D), (41, 30 + D)], toe_b=True))
    wing(f2, [(36, 19 + D), (46, 24 + D), (54, 31 + D)], 6, 3)
    f2 = finish(f2)
    ghost_wing(f2, [(36, 19 + D), (46, 13 + D), (55, 10 + D)], 5, 2.5, GHOST)
    ghost_wing(f2, [(36, 19 + D), (39, 9 + D), (42, 2 + D)], 5, 2.5, GHOST2)
    smear_arc(f2, 36, 19 + D, 17, -85, 45, 3, GHOST)
    smear_arc(f2, 36, 19 + D, 20, -70, 35, 1.5, GHOST2)
    feathers(f2, [(58, 24 + D), (30, 6 + D)])
    f3 = squat(dict(eye="squint"), 0.08, 33)
    wing(f3, [(34, 20), (40, 17), (44, 13)], 5, 2)
    f3 = finish(f3)
    dust(f3, [(22, 30), (42, 30)])
    f4 = BODY.copy()
    return [f0, f1, f2, f3, f4]


def ball(angle: float, cx: float = 32, cy: float = 22, r: float = 9.5) -> np.ndarray:
    """the goose curled into a ball, turned by `angle` (degrees): the head tucked
    on the rim, the feet on the rim opposite, both going round"""
    f = blank()
    fill_cells(f, ellipse_cells(cx, cy, r, r))
    a = math.radians(angle)
    hx, hy = cx + math.cos(a) * (r - 3), cy + math.sin(a) * (r - 3)
    # the head as a lump on the rim with the beak pointing along the turn
    fill_cells(f, ellipse_cells(hx, hy, 3.5, 3.5))
    bx, by = int(hx + math.cos(a + 1.2) * 4), int(hy + math.sin(a + 1.2) * 4)
    stamp(f, "==\n=o", bx - 1, by - 1, outline=False)
    ex, ey = int(hx + math.cos(a + 0.4) * 1.5), int(hy + math.sin(a + 0.4) * 1.5)
    if inb(ex, ey):
        f[ey, ex] = OUTLINE
    # the feet on the far rim
    fa = a + math.pi
    fx, fy = cx + math.cos(fa) * (r - 1), cy + math.sin(fa) * (r - 1)
    stamp(f, "===", int(fx) - 1, int(fy), outline=False)
    stamp(f, "oo", int(fx + math.cos(fa + 0.6) * 3), int(fy + math.sin(fa + 0.6) * 3), outline=False)
    # a wing across the ball
    wa = a + 2.2
    wing(f, [(cx, cy), (cx + math.cos(wa) * 5, cy + math.sin(wa) * 5), (cx + math.cos(wa) * 8, cy + math.sin(wa) * 8)], 4.5, 2)
    return repair_outline(f)


def make_roll() -> list[np.ndarray]:
    """The Golem roll: 0 tuck — the head goes down to the chest · 1 the ball,
    curled tight (held) · 2 rolling in, a quarter turn, dust behind · 3 HIT:
    another quarter turn, the ball squashed against the enemy, smear rings ·
    4 the bounce back: stretched the other way, a ghost where it hit · 5 in
    again · 6 hit · 7 back · 8 in · 9 hit · 10 unrolling: the head coming out ·
    11 stand."""
    f0 = standing(cx=32, cy=22, rx=9.5, ry=6, lean=0.04, tail=(22, 15), head_at=(38, 20), neck_pts=[(36, 19), (38, 20)],
                  head_kw=dict(tilt=-3, eye="squint"), legs=two_legs([(28, 27), (27, 30)], [(35, 27), (36, 30)]))
    wing(f0, [(33, 19), (38, 22), (41, 26)], 5, 2)
    f0 = finish(f0)
    f1 = ball(30, 32, 22, 9.5)

    def rolling(angle: float, dx: int = 0, hit: bool = False, back: bool = False) -> np.ndarray:
        cx = 32 + dx
        if hit:
            f = blank()
            fill_cells(f, ellipse_cells(cx, 22.5, 8, 10))            # squashed against the enemy
            b = ball(angle, cx, 22, 9.5)
            for (x, y) in solid_cells(b):
                if (x, y) in ellipse_cells(cx, 22.5, 8, 10) and tuple(b[y, x]) != WHITE:
                    f[y, x] = b[y, x]
            f = repair_outline(f)
            smear_arc(f, cx, 22, 12, angle - 250, angle - 60, 2, GHOST)
            dashes(f, [(cx - 22, 14, 6), (cx - 24, 20, 8), (cx - 20, 27, 6)], GHOST)
            feathers(f, [(cx + 10, 8), (cx + 12, 30)])
            return f
        f = ball(angle, cx, 22, 9.5)
        smear_arc(f, cx, 22, 12, angle - 240, angle - 40, 2, GHOST)
        smear_arc(f, cx, 22, 14.5, angle - 200, angle - 90, 1.5, GHOST2)
        if back:
            ghost(f, ellipse_cells(cx + 12, 22, 8, 9.5), GHOST2)
            dashes(f, [(cx + 14, 12, 6), (cx + 16, 32, 5)], GHOST2)
        else:
            dust(f, [(cx - 14, 30), (cx - 18, 31)])
            dashes(f, [(cx - 20, 16, 6), (cx - 24, 22, 8)], GHOST2)
        return f

    f2 = rolling(120)
    f3 = rolling(210, 2, hit=True)
    f4 = rolling(300, -2, back=True)
    f5 = rolling(30)
    f6 = rolling(120, 2, hit=True)
    f7 = rolling(210, -2, back=True)
    f8 = rolling(300)
    f9 = rolling(30, 2, hit=True)
    f10 = standing(cx=32, cy=22, rx=9.5, ry=6, lean=-0.06, tail=(24, 15), head_at=(36, 14), neck_pts=[(34, 19), (36, 15)],
                   head_kw=dict(eye="squint"), legs=two_legs([(28, 27), (27, 30)], [(35, 27), (36, 30)]))
    wing(f10, [(33, 19), (38, 21), (42, 20)], 5, 2)
    f10 = finish(f10)
    smear_arc(f10, 32, 22, 12, -220, -120, 1.5, GHOST2)
    f11 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11]


# ═══════════════════════════════════════════════════════════════════════════
# taken, not given
# ═══════════════════════════════════════════════════════════════════════════
def make_hurt() -> list[np.ndarray]:
    """0 the IMPACT: bent back in a C, head snapped back, chest caved, wings flung
    forward and up, eyes shut, feathers off, the feet skidding · 1 knocked
    further: leaning back hard on one foot · 2 the stumble forward, head down ·
    3 a wobble back · 4 recovering, one feather still falling."""
    f0 = standing(cx=29, cy=20, rx=8, ry=7, lean=-0.36, tail=(29, 12), head_at=(28, 8), neck_pts=[(30, 15), (28, 9)],
                  head_kw=dict(tilt=3, eye="shut", beak="open"), legs=two_legs([(28, 26), (33, 30)], [(33, 26), (38, 30)]))
    wing(f0, [(30, 16), (38, 11), (45, 8)], 5, 2)
    wing(f0, [(31, 18), (39, 17), (46, 15)], 4.5, 2)
    f0 = finish(f0)
    feathers(f0, [(20, 8), (24, 4), (18, 16)])
    dashes(f0, [(40, 27, 5), (44, 30, 6)], GHOST)
    head_ghost(f0, 34, 10, GHOST2, tilt=1)
    f1 = standing(cx=28, cy=20, rx=8, ry=7, lean=-0.44, tail=(30, 12), head_at=(26, 8), neck_pts=[(29, 15), (26, 9)],
                  head_kw=dict(tilt=3, eye="shut", beak="open"),
                  legs=two_legs([(28, 26), (30, 29), (35, 29)], [(33, 26), (40, 30)], toe_a=True))
    wing(f1, [(29, 16), (37, 9), (43, 5)], 5, 2)
    wing(f1, [(31, 18), (39, 15), (46, 12)], 4.5, 2)
    f1 = finish(f1)
    feathers(f1, [(15, 10), (20, 3), (13, 18), (36, 1)])
    f2 = standing(cx=32, cy=21, rx=9, ry=6, lean=0.22, tail=(23, 14), head_at=(40, 15), neck_pts=[(36, 17), (39, 16)],
                  head_kw=dict(tilt=-3, eye="shut"), legs=two_legs([(29, 27), (26, 30)], [(36, 27), (38, 30)]))
    wing(f2, [(33, 18), (38, 23), (42, 27)], 5, 2)
    f2 = finish(f2)
    feathers(f2, [(20, 14), (44, 6)])
    f3 = standing(cx=31, cy=20.5, lean=-0.1, tail=(25, 13), head_at=(34, 11), neck_pts=[(33, 16), (34, 12)],
                  head_kw=dict(tilt=1, eye="shut"))
    wing(f3, [(32, 17), (27, 20), (24, 23)], 5, 2)
    f3 = finish(f3)
    feathers(f3, [(22, 22)])
    f4 = standing(cx=32, head_at=(36, 12), head_kw=dict(eye="squint"))
    wing(f4, [(33, 17), (37, 20), (39, 22)], 5, 2)
    f4 = finish(f4)
    feathers(f4, [(24, 27)])
    return [f0, f1, f2, f3, f4]


def make_dodge_flat() -> list[np.ndarray]:
    """0 dropping: squashing down, legs splaying · 1 FLAT against the ground, the
    head laid along it, eyes squeezed, the blow's dashes passing over (held) ·
    2 rising · 3 idle."""
    f0 = standing(cx=32, cy=24, rx=11, ry=4.5, tail=(20, 19), head_at=(36, 17), neck_pts=[(35, 21), (36, 18)],
                  head_kw=dict(tilt=-1, eye="squint"), legs=two_legs([(26, 27), (23, 30)], [(38, 27), (41, 30)]))
    wing(f0, [(33, 21), (27, 24), (23, 27)], 5, 2)
    f0 = finish(f0)
    f1 = blank()
    leg(f1, [(24, 29), (20, 30)], ORANGE, -1)
    leg(f1, [(40, 29), (44, 30)], BROWN, 1)
    body(f1, 32, 28, 12, 3.5, (19, 25))
    neck(f1, [(40, 27), (45, 27)], 4)
    head(f1, 46, 27, tilt=-3, eye="squint")
    wing(f1, [(32, 27), (26, 28), (21, 29)], 4, 2)
    f1 = finish(f1)
    dashes(f1, [(14, 12, 8), (30, 9, 10), (48, 13, 7)], GHOST)
    dashes(f1, [(22, 16, 6), (44, 17, 5)], GHOST2)
    dust(f1, [(16, 30), (48, 30)])
    f2 = squat(dict(eye="squint"))
    wing(f2, [(33, 20), (38, 22), (42, 21)], 5, 2)
    f2 = finish(f2)
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_dodge_side() -> list[np.ndarray]:
    """A step out of the plane, toward the viewer: 0 the lean, the body already
    narrowing · 1 DODGED: the body thin, seen nearly edge-on, two ghosts of where
    it stood fading behind (held) · 2 coming back · 3 idle."""
    f0 = standing(cx=32, cy=20.5, rx=7, ry=6.5, lean=0.04, tail=(25, 14), head_at=(36, 12), neck_pts=[(34, 17), (36, 13)],
                  head_kw=dict(eye="squint"), legs=two_legs([(30, 26), (29, 30)], [(33, 26), (34, 30)]))
    wing(f0, [(33, 17), (36, 21), (38, 24)], 4.5, 2)
    f0 = finish(f0)
    f1 = blank()
    leg(f1, [(31, 26), (31, 30)], ORANGE, 1)
    leg(f1, [(33, 26), (34, 30)], BROWN, 1)
    body(f1, 32, 20.5, 4.5, 6.5, None)
    neck(f1, [(33, 17), (34, 13)], 4)
    head(f1, 34, 13, eye="squint")
    wing(f1, [(32, 17), (33, 22), (34, 26)], 3.5, 2)
    f1 = finish(f1)
    ghost(f1, ellipse_cells(24, 20.5, 6, 6), GHOST)
    ghost(f1, ellipse_cells(16, 20.5, 5, 5.5), GHOST2)
    head_ghost(f1, 28, 12, GHOST2)
    dashes(f1, [(40, 14, 8), (42, 20, 7), (40, 26, 8)], GHOST)
    f2 = standing(cx=32, cy=20.5, rx=7.5, ry=6.2, tail=(25, 14), head_at=(36, 12), neck_pts=[(34, 17), (36, 13)],
                  legs=two_legs([(30, 26), (29, 30)], [(34, 26), (35, 30)]))
    wing(f2, [(33, 17), (36, 21), (38, 23)], 4.5, 2)
    f2 = finish(f2)
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_cheer() -> list[np.ndarray]:
    f0 = shift(FLAP[2], 0, -5)
    f1 = FLAP[0].copy()
    return [f0, f1]


def make_flash() -> list[np.ndarray]:
    return [whiten(BODY)]


# ═══════════════════════════════════════════════════════════════════════════
# the two flops — the pack body turned and squashed, with drawn smears
# ═══════════════════════════════════════════════════════════════════════════
def flat(src: np.ndarray, times: int, cx: int = 34) -> np.ndarray:
    """The body turned a quarter onto the ground, centred at `cx`, lying on the feet line."""
    r = rot90(src, times)
    ys, xs = np.where(r[:, :, 3] > 0)
    return shift(r, cx - int(xs.mean()), FEET - int(ys.max()) - 1)


def squash(src: np.ndarray, kx: float, ky: float) -> np.ndarray:
    """The figure resampled (nearest) to kx wide and ky tall about its feet and
    its centre: the squash of an impact, drawn as a key, not tweened."""
    ys, xs = np.where(src[:, :, 3] > 0)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    crop = Image.fromarray(src[y0:y1, x0:x1])
    w, h = max(1, round((x1 - x0) * kx)), max(1, round((y1 - y0) * ky))
    r = np.array(crop.resize((w, h), Image.NEAREST))
    out = blank()
    cx = (x0 + x1) // 2
    place(out, r, cx - w // 2, y1 - h)
    return repair_outline(out)


def make_bellyflop() -> list[np.ndarray]:
    """Squat · leap, wings wide · belly-down in the air · the splat (held) · up."""
    f0 = squat()
    wing(f0, [(33, 20), (38, 24), (41, 28)], 5, 2)
    f0 = finish(f0)
    f1 = FLAP[2].copy()
    belly = flat(BODY, -1)
    f2 = belly.copy()
    speed_lines(f2, [(24, 6, 6), (44, 8, 5)])
    f3 = squash(belly, 1.3, 0.6)
    feathers(f3, [(18, 20), (48, 19), (30, 16)])
    dust(f3, [(14, 30), (52, 30)])
    f4 = squat(dict(eye="squint"))
    f4 = finish(f4)
    f5 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5]


def make_bodyslam() -> list[np.ndarray]:
    """Coil · spring, wings up · rise, tucking · the hang: belly down, wings spread,
    feet up (held at the top) · the drop, streaking · the SLAM, flattened (held)
    · bounce · stand.  The game lifts keys 1–4 and carries 3–7 over the enemy."""
    f0 = squat(dict(eye="squint"))
    wing(f0, [(32, 20), (26, 22), (22, 25)], 5, 2)
    f0 = finish(f0)
    f1 = shear(FLAP[0], -0.06)
    dust(f1, [(22, 30), (40, 30)])
    f2 = shear(BODY, -0.14)
    wing(f2, [(32, 16), (36, 19), (39, 22)], 5, 2)
    f2 = repair_outline(f2)
    speed_lines(f2, [(20, 20, 6), (46, 18, 5)])
    f3 = shear(FLAP[2], -0.22)
    stamp(f3, "==\n ==", 34, 26)
    belly = flat(BODY, -1)
    ys, xs = np.where(belly[:, :, 3] > 0)
    top, cx = int(ys.min()), int(xs.mean())
    f4 = belly.copy()
    speed_lines(f4, [(cx - 9, top - 12, 6), (cx, top - 15, 8), (cx + 8, top - 11, 5)])
    ghost(f4, {(x, y - 6) for (x, y) in solid_cells(belly) if y - 6 >= 0}, GHOST2)
    f5 = squash(belly, 1.35, 0.55)
    feathers(f5, [(cx - 16, FEET - 12), (cx + 14, FEET - 13), (cx - 4, FEET - 16)])
    dust(f5, [(cx - 20, 30), (cx + 18, 30)])
    f6 = squat(lean=-0.08)
    wing(f6, [(31, 19), (27, 13), (25, 8)], 5, 2)
    f6 = finish(f6)
    f7 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6, f7]


MOVES = {
    "slap": make_slap, "peck": make_peck, "uppercut": make_uppercut, "hop_slap": make_hop_slap,
    "dropkick": make_dropkick, "whip": make_whip, "whip_hold": make_whip_hold, "spin": make_spin,
    "flurry": make_flurry, "megahonk": make_megahonk,
    "boulder": make_boulder, "volley": make_volley, "rock": make_rock, "rock_break": make_rock_break,
    "launch": make_launch, "dive": make_dive, "roll": make_roll,
    "hurt": make_hurt, "dodge_flat": make_dodge_flat, "dodge_side": make_dodge_side,
    "cheer": make_cheer, "flash": make_flash,
    "bellyflop": make_bellyflop, "bodyslam": make_bodyslam,
}
# strips no longer authored: removed so the packer does not ship them
RETIRED = ["slap_up", "slide", "kick", "honk", "slam", "whiff", "slap_drawn"]


def main() -> None:
    for name in RETIRED:
        p = os.path.join(SRC, f"{name}.png")
        if os.path.exists(p):
            os.remove(p)
            print(f"{name}: retired")
    sheet_rows = []
    for name, fn in MOVES.items():
        frames = fn()
        out = np.zeros((FH, FW * len(frames), 4), dtype=np.uint8)
        for i, f in enumerate(frames):
            out[:, i * FW:(i + 1) * FW] = f
        Image.fromarray(out).save(os.path.join(SRC, f"{name}.png"))
        sheet_rows.append((name, out))
        print(f"{name}: {len(frames)} frames")
    k = 4
    maxw = max(r.shape[1] for _, r in sheet_rows)
    sheet = Image.new("RGBA", (maxw * k, FH * k * len(sheet_rows)), (40, 40, 60, 255))
    for j, (name, out) in enumerate(sheet_rows):
        im = Image.fromarray(out).resize((out.shape[1] * k, FH * k), Image.NEAREST)
        sheet.alpha_composite(im, (0, j * FH * k))
    os.makedirs(os.path.join(os.path.dirname(HERE), ".scratch"), exist_ok=True)
    sheet.convert("RGB").save(os.path.join(os.path.dirname(HERE), ".scratch", "goose_moves.png"))


if __name__ == "__main__":
    main()
