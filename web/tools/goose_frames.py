"""
Author the goose's fighting frames from the pack's four animations.

    python3 web/tools/goose_frames.py        # writes assets/pixel/goose/*.png

The pack ships Idle, Walk, Run and Flap — a goose that can stand about.  The game
needs one that slaps, kicks, whips and gets knocked back, so those frames are
drawn here, in the pack's own four colours, at the pack's own 64×64 frame size,
from the pack's own body.  Every new shape is fill colour first and then given
the 1 px dark outline the pack uses (4-neighbour, never diagonal), so a wing
drawn by this script and a wing drawn by the artist are the same kind of thing.

Motion between poses is *not* done here: the frames are keys, the game snaps
between them.  Nothing is tweened, scaled or rotated except by a whole 90°.

Facing: right, like the pack.  The game mirrors the sprite to face the enemy.

Strips written (frame count · which frame is the contact frame):
    slap 3·0        wing swung forward, level
    slap_up 3·0     backhand upward
    peck 2·0        neck lunge (the Run pose, sprung forward)
    hop_slap 4·0    airborne wing hit, then landing
    slide 4·0       feet-first slide kick, low
    kick 3·0        one leg out
    whip 4·0        a lash cracked to the right
    whip_hold 2·0   the lash held taut (loops through a hold note)
    honk 3·0        beak open, head up — the word-complete shout
    spin 4·0        right · left · back · right
    slam 3·1        charge, then the hit at full lean
    cheer 2·0       wings up, off the ground
    hurt 3·0        knocked back, eye shut, feathers loose
    flash 1·0       white silhouette for the hit flash
    boulder 7·4     squat, hoist, leap with a boulder overhead, throw; it lands on 4
    uppercut 6·3    crouch and load, shake, the rising blow, hang, land
    bellyflop 6·3   squat, leap, belly-down in the air, the splat, up
    dropkick 4·0    both feet out, lands on its back, up
    megahonk 3·1    inhale, the blast, exhale
    flurry 2·0      two smear keys, alternated fast
    whiff 2·0       a swing at nothing: overbalanced, then a stumble
    rock 1 · rock_break 3   the boulder, and the boulder in pieces (props)
"""
from __future__ import annotations

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


def strip(name: str) -> list[np.ndarray]:
    im = Image.open(os.path.join(SRC, f"{name}.png")).convert("RGBA")
    a = np.array(im)
    return [a[:, i * FW:(i + 1) * FW].copy() for i in range(im.width // FW)]


def blank() -> np.ndarray:
    return np.zeros((FH, FW, 4), dtype=np.uint8)


def is_fill(px) -> bool:
    return px[3] > 0 and tuple(px) != OUTLINE


def place(dst: np.ndarray, src: np.ndarray, dx: int = 0, dy: int = 0) -> None:
    """Alpha-composite `src` onto `dst` shifted by (dx, dy); opaque over."""
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
    """Lean: shift each row by k·(pivot − y), so the feet stay and the head moves.
    Rows move whole pixels; the outline is repaired after."""
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
    dst[y0:y1 + 1, x0:x1 + 1] = 0


def stamp(dst: np.ndarray, art: str, x: int, y: int, colors: dict[str, tuple] | None = None,
          outline: bool = True) -> None:
    """Draw an ASCII shape at (x, y): '#' white, '=' orange, 'o' brown, '.' outline,
    ' ' nothing.  Then give the shape its own outline over whatever is under it —
    that is how the pack keeps a wing readable against the body."""
    colors = colors or {"#": WHITE, "=": ORANGE, "o": BROWN, ".": OUTLINE}
    rows = art.strip("\n").split("\n")
    cells = set()
    for j, row in enumerate(rows):
        for i, ch in enumerate(row):
            if ch == " ":
                continue
            tx, ty = x + i, y + j
            if 0 <= tx < FW and 0 <= ty < FH:
                dst[ty, tx] = colors[ch]
                if ch != ".":
                    cells.add((tx, ty))
    if outline:
        for (cx, cy) in cells:
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if (nx, ny) in cells or not (0 <= nx < FW and 0 <= ny < FH):
                    continue
                dst[ny, nx] = OUTLINE


def repair_outline(a: np.ndarray) -> np.ndarray:
    """Every transparent pixel 4-adjacent to fill becomes outline."""
    out = a.copy()
    for y in range(FH):
        for x in range(FW):
            if a[y, x, 3] > 0:
                continue
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < FW and 0 <= ny < FH and is_fill(a[ny, nx]):
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


def line(dst: np.ndarray, pts: list[tuple[int, int]], color=BROWN) -> None:
    """A 1 px polyline in `color` with the pack outline around it: a whip, a stick."""
    cells = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(n + 1):
            cells.append((round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)))
    cs = set(cells)
    for (x, y) in cells:
        if 0 <= x < FW and 0 <= y < FH:
            dst[y, x] = color
    for (x, y) in cells:
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in cs and 0 <= nx < FW and 0 <= ny < FH and dst[ny, nx, 3] == 0:
                dst[ny, nx] = OUTLINE


# ── the body, as the pack drew it ──────────────────────────────────────────
IDLE = strip("Idle")
WALK = strip("Walk")
RUN = strip("Run")
FLAP = strip("Flap")
BODY = IDLE[0]

# where things are on the idle body (measured in the frame)
EYE = (40, 7)
BEAK = (42, 8, 46, 11)          # x0 y0 x1 y1 of the beak
SHOULDER = (33, 16)            # where a wing roots on the body


# ── wing shapes ────────────────────────────────────────────────────────────
WING_FWD = """
     ####
  #########
##############
 #############
    ######
"""
WING_FWD_DOWN = """
##
 #####
  #######
    #######
      ######
        ####
"""
WING_UP = """
          ##
        ####
      ######
    #######
  #######
 #####
###
"""
WING_MID = """
####
 ######
  #####
"""
WING_BACK = """
#####
 ####
  ##
"""
LEG_OUT = """
=====
oo===
"""
FEATHER = """
##
"""


def wing(dst: np.ndarray, art: str, dx: int = 0, dy: int = 0) -> None:
    stamp(dst, art, SHOULDER[0] + dx, SHOULDER[1] + dy)


def eye_shut(dst: np.ndarray) -> None:
    x, y = EYE
    dst[y, x] = WHITE
    dst[y + 1, x - 1] = OUTLINE
    dst[y + 1, x] = OUTLINE
    dst[y + 1, x + 1] = OUTLINE


def beak_open(dst: np.ndarray, wide: bool) -> None:
    x0, y0, x1, y1 = BEAK
    # clear the closed beak, keep the head outline behind it
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
        stamp(dst, FEATHER, x, y)


# ═══════════════════════════════════════════════════════════════════════════
def make_slap() -> list[np.ndarray]:
    # contact: leaning in, wing level and long
    f0 = shear(BODY, 0.2)
    wing(f0, WING_FWD, 4, 0)
    # follow-through: wing down and past, body straight again
    f1 = shear(BODY, 0.08)
    wing(f1, WING_FWD_DOWN, 4, 2)
    # recover: wing tucked back
    f2 = BODY.copy()
    wing(f2, WING_MID, 0, 0)
    return [f0, f1, f2]


def make_slap_up() -> list[np.ndarray]:
    f0 = shear(BODY, 0.12)
    wing(f0, WING_UP, -2, -4)
    f1 = BODY.copy()
    wing(f1, WING_UP, -4, -8)
    f2 = BODY.copy()
    wing(f2, WING_MID, 0, 0)
    return [f0, f1, f2]


def make_peck() -> list[np.ndarray]:
    # the Run pose is already the lunge: low, neck out.  Spring it forward.
    f0 = shift(RUN[1], 4, 0)
    f1 = shift(RUN[3], 1, 0)
    return [f0, f1]


def make_hop_slap() -> list[np.ndarray]:
    f0 = shift(shear(BODY, 0.16), 3, -8)       # in the air, leaning in
    wing(f0, WING_FWD, 4 + 3, 0 - 8)
    f1 = shift(BODY, 2, -4)                    # coming down, wing through
    wing(f1, WING_FWD_DOWN, 4 + 2, 2 - 4)
    f2 = WALK[2].copy()                        # landing: the low walk frame
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_slide() -> list[np.ndarray]:
    # a quarter turn onto the back: the head ends up at the left on the ground,
    # the feet stick out in front — a slide tackle, and nothing between poses
    flat = rot90(BODY, 1)
    a = flat[:, :, 3]
    ys, xs = np.where(a > 0)
    flat = shift(flat, 34 - int(xs.mean()), FEET - int(ys.max()) - 1)
    f0 = shift(flat, 2, 0)
    f1 = shift(flat, 6, 0)
    f2 = shift(WALK[2], 3, 0)                  # up onto the feet
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_kick() -> list[np.ndarray]:
    f0 = shear(BODY, -0.08)
    erase(f0, 33, 27, 44, 32)                 # the front leg
    stamp(f0, "=========\n     oooo", 35, 25)  # kicked out straight, foot at the end
    f0 = repair_outline(f0)
    f1 = BODY.copy()
    erase(f1, 33, 27, 44, 32)
    stamp(f1, "  ===\n===\noo", 34, 26)        # knee bent, coming back
    f1 = repair_outline(f1)
    f2 = BODY.copy()
    return [f0, f1, f2]


def make_whip() -> list[np.ndarray]:
    sx, sy = SHOULDER[0] + 8, SHOULDER[1] - 2
    # the crack: a straight lash to the right, a flick at the end
    f0 = shear(BODY, 0.1)
    wing(f0, WING_FWD, 2, -1)
    line(f0, [(sx, sy), (sx + 8, sy - 1), (sx + 15, sy), (sx + 20, sy - 3)])
    # the lash curls over
    f1 = BODY.copy()
    wing(f1, WING_UP, 2, -4)
    line(f1, [(sx, sy - 3), (sx + 5, sy - 7), (sx + 11, sy - 6), (sx + 14, sy - 2)])
    # drawn back
    f2 = BODY.copy()
    wing(f2, WING_MID, 0, 0)
    line(f2, [(sx - 2, sy + 1), (sx + 3, sy + 4), (sx + 6, sy + 8)])
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_whip_hold() -> list[np.ndarray]:
    sx, sy = SHOULDER[0] + 8, SHOULDER[1] - 2
    f0 = shear(BODY, 0.1)
    wing(f0, WING_FWD, 2, -1)
    line(f0, [(sx, sy), (sx + 22, sy)])
    f1 = shear(BODY, 0.1)
    wing(f1, WING_FWD, 2, -1)
    line(f1, [(sx, sy), (sx + 11, sy + 1), (sx + 22, sy)])
    return [f0, f1]


def make_honk() -> list[np.ndarray]:
    f0 = shear(BODY, -0.05)
    beak_open(f0, False)
    f1 = shear(BODY, -0.08)
    beak_open(f1, True)
    wing(f1, WING_BACK, -6, 2)                 # wings flare back a little
    f2 = BODY.copy()
    beak_open(f2, False)
    return [f0, f1, f2]


def make_spin() -> list[np.ndarray]:
    f0 = BODY.copy()
    f1 = mirror(BODY)
    f1 = shift(f1, 0, 0)
    # from behind: the body with no face and no beak, the head a plain oval
    f2 = BODY.copy()
    erase(f2, 41, 4, 47, 12)
    stamp(f2, " ####\n######\n######\n######\n ####", 38, 5, outline=True)
    f2[EYE[1], EYE[0]] = WHITE
    f2 = repair_outline(f2)
    f3 = BODY.copy()
    return [f0, f1, f2, f3]


def make_slam() -> list[np.ndarray]:
    f0 = shift(RUN[0], 3, 0)                   # the charge
    f1 = shift(RUN[2], 9, 0)                   # the hit, full lean
    wing(f1, WING_FWD, 9 + 4, 3)
    f2 = WALK[0].copy()
    return [f0, f1, f2]


def make_cheer() -> list[np.ndarray]:
    f0 = shift(FLAP[2], 0, -5)                 # wings wide, off the ground
    f1 = FLAP[0].copy()
    return [f0, f1]


def make_hurt() -> list[np.ndarray]:
    f0 = shift(shear(BODY, -0.2), -3, 0)
    eye_shut(f0)
    feathers(f0, [(30, 10), (24, 16)])
    f1 = shift(shear(BODY, -0.28), -5, 1)
    eye_shut(f1)
    feathers(f1, [(27, 6), (20, 13), (32, 3)])
    f2 = shift(BODY, -2, 0)
    eye_shut(f2)
    return [f0, f1, f2]


def make_flash() -> list[np.ndarray]:
    return [whiten(BODY)]



# ═══════════════════════════════════════════════════════════════════════════
# the heavy moves — wind-up · impact · recovery
#
# These follow the structure the animation references agree on (SLYNYRD's
# melee/punch pixelblogs, the fighting-game timing notes): a long anticipation
# the character can *hold* (a crouch, a hoist), one or two frames at full
# extension held longer than anything else, then a quick recovery.  Uneven
# timing is what sells the weight, so these strips are authored as keys and the
# game gives every frame its own duration (`px/actors.ts` MOVES).
#
# The 64×64 frame has 32 empty rows under the feet, so an airborne key can draw
# the body lower in the frame and use the freed rows above the head for a rock
# held overhead; the game lifts the whole sprite by the same amount (`dy`).
# ═══════════════════════════════════════════════════════════════════════════
ROCK_LIGHT = (196, 200, 205, 255)
ROCK_MID = (140, 144, 155, 255)
ROCK_DARK = (92, 96, 110, 255)
LOW = WALK[2]           # the low walk frame: the squat every jump starts and ends in


def rock(w: int = 18, h: int = 13) -> np.ndarray:
    """A boulder: an ellipse lit from the top-left in three greys, outlined."""
    out = blank()
    cx, cy = w / 2 - 0.5, h / 2 - 0.5
    rx, ry = w / 2, h / 2
    for y in range(h):
        for x in range(w):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1:
                continue
            v = (x + 1.4 * y) / (w + 1.4 * h)
            out[y + 1, x + 1] = ROCK_LIGHT if v < 0.3 else (ROCK_MID if v < 0.66 else ROCK_DARK)
    # a crack
    for (x, y) in ((7, 3), (8, 4), (8, 5), (9, 6), (10, 7)):
        out[y + 1, x + 1] = ROCK_DARK
    return repair_outline(out)


ROCK = rock()


def rock_at(dst: np.ndarray, x: int, y: int) -> None:
    """Place the boulder with its top-left (outline included) at (x, y)."""
    place(dst, ROCK, x, y)


def rock_break(step: int) -> np.ndarray:
    """The boulder in four chunks flying apart; `step` 0..2 further and smaller."""
    a = ROCK.copy()
    ys, xs = np.where(a[:, :, 3] > 0)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    out = blank()
    d = (3, 7, 11)[step]
    shrink = (0, 2, 4)[step]
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        q = blank()
        qx0, qx1 = (x0, cx) if sx < 0 else (cx + 1, x1)
        qy0, qy1 = (y0, cy) if sy < 0 else (cy + 1, y1)
        q[qy0:qy1 + 1, qx0:qx1 + 1] = a[qy0:qy1 + 1, qx0:qx1 + 1]
        for _ in range(shrink):        # erode: drop every pixel on the chunk's edge
            keep = q.copy()
            for y in range(FH):
                for x in range(FW):
                    if q[y, x, 3] and any(not (0 <= x + i < FW and 0 <= y + j < FH) or not q[y + j, x + i, 3]
                                          for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                        keep[y, x] = 0
            q = keep
        place(out, q, sx * d, sy * d - step * 2)     # up a little: the chunks lift off
    return repair_outline(out)


def make_rock() -> list[np.ndarray]:
    # one frame, the boulder centred at (32, 32): the projectile
    f = blank()
    rock_at(f, 32 - 10, 32 - 7)
    return [f]


def make_rock_break() -> list[np.ndarray]:
    return [shift(rock_break(i), 32 - 10, 32 - 7) for i in range(3)]


def make_boulder() -> list[np.ndarray]:
    """Squat · hoist · leap with it overhead · throw · watch it land · land · stand.
    The game lifts frames 1–4 (dy), frame 4 is the contact — the rock lands."""
    D = 10                                              # body drawn this much lower in the hoist
    f0 = LOW.copy()                                     # squat, wings down to grab it
    wing(f0, WING_FWD_DOWN, 4, 2)
    rock_at(f0, 43, 19)                                 # the boulder on the ground ahead
    f1 = shift(BODY, 0, D)                              # hoist: body low in the frame, rock overhead
    f1 = shear(f1, -0.06, FEET + D)
    wing(f1, WING_UP, -2, -4 + D)
    rock_at(f1, 30, 0)
    f2 = shift(BODY, 0, D)                              # the leap: leaning in at the apex
    f2 = shear(f2, 0.1, FEET + D)
    wing(f2, WING_UP, -2, -4 + D)
    rock_at(f2, 31, 0)
    f3 = shift(BODY, 0, D)                              # the throw: wings flung forward, rock gone
    f3 = shear(f3, 0.14, FEET + D)
    wing(f3, WING_FWD, 4, -2 + D)
    f4 = shear(BODY, 0.06)                              # falling, wings trailing
    wing(f4, WING_FWD_DOWN, 4, 2)
    f5 = LOW.copy()                                     # landing squat
    f6 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5, f6]


def make_uppercut() -> list[np.ndarray]:
    """Crouch and load (held) · shake · the rising blow · full extension, feet off
    the ground (held) · land."""
    f0 = shear(LOW, -0.12)
    wing(f0, WING_BACK, -6, 6)                          # wing drawn back and low
    f1 = shift(f0, 1, 0)                                # the shake
    f2 = shift(f0, -1, 0)
    f3 = shear(BODY, 0.15)                              # rising: wing sweeping up in front
    wing(f3, WING_UP, 6, -2)
    f4 = BODY.copy()                                    # full extension, straight up
    wing(f4, WING_UP, -2, -10)
    f5 = LOW.copy()
    return [f0, f1, f2, f3, f4, f5]


def flat(src: np.ndarray, times: int, cx: int = 34) -> np.ndarray:
    """The body turned a quarter onto the ground, centred at `cx`, lying on the feet line."""
    r = rot90(src, times)
    ys, xs = np.where(r[:, :, 3] > 0)
    return shift(r, cx - int(xs.mean()), FEET - int(ys.max()) - 1)


def make_bellyflop() -> list[np.ndarray]:
    """Squat · leap, wings wide · belly-down in the air · the splat (held) · up."""
    f0 = LOW.copy()
    wing(f0, WING_FWD_DOWN, 4, 2)
    f1 = FLAP[2].copy()
    belly = flat(BODY, -1)                              # head forward, belly to the ground
    f2 = belly
    f3 = shift(belly, 0, 0)
    f4 = LOW.copy()
    f5 = BODY.copy()
    return [f0, f1, f2, f3, f4, f5]


def make_dropkick() -> list[np.ndarray]:
    """Both feet out, leaning back (the contact) · lands on its back · up."""
    f0 = shear(BODY, -0.25)
    erase(f0, 33, 27, 44, 32)
    stamp(f0, "=============\n         oooo", 34, 23)
    f0 = repair_outline(f0)
    back = flat(BODY, 1)                                # on its back, head behind
    f1 = back
    f2 = shift(back, 1, 0)
    f3 = LOW.copy()
    return [f0, f1, f2, f3]


def make_megahonk() -> list[np.ndarray]:
    """Inhale, leaning back · the blast, beak wide, wings flared, rays off the beak
    (held) · exhale."""
    f0 = shear(BODY, -0.15)
    wing(f0, WING_BACK, -6, 2)
    f1 = shear(BODY, 0.12)
    beak_open(f1, True)
    wing(f1, WING_BACK, -8, 0)
    x1 = BEAK[2] + 5
    for (x, y) in ((x1, BEAK[1] - 2), (x1 + 1, BEAK[1] - 3), (x1 + 1, BEAK[1] + 1), (x1 + 2, BEAK[1] + 1),
                   (x1, BEAK[1] + 4), (x1 + 1, BEAK[1] + 5)):
        f1[y, x] = OUTLINE
    f2 = BODY.copy()
    beak_open(f2, False)
    return [f0, f1, f2]


def make_flurry() -> list[np.ndarray]:
    """Two smear keys: both wing positions drawn in one frame, so alternating
    them reads as a flurry too fast to see."""
    f0 = shear(BODY, 0.1)
    wing(f0, WING_UP, -2, -4)
    wing(f0, WING_FWD, 4, 0)
    f1 = shear(BODY, 0.1)
    wing(f1, WING_FWD, 4, 0)
    wing(f1, WING_FWD_DOWN, 4, 2)
    return [f0, f1]


def make_whiff() -> list[np.ndarray]:
    """Overbalanced after a swing at nothing: leaning far forward, eye shut, then
    a dizzy stumble back."""
    f0 = shift(shear(BODY, 0.3), 3, 0)
    eye_shut(f0)
    wing(f0, WING_FWD_DOWN, 6, 4)
    f1 = shift(shear(BODY, -0.1), -1, 0)
    eye_shut(f1)
    return [f0, f1]


MOVES = {
    "slap": make_slap, "slap_up": make_slap_up, "peck": make_peck, "hop_slap": make_hop_slap,
    "slide": make_slide, "kick": make_kick, "whip": make_whip, "whip_hold": make_whip_hold,
    "honk": make_honk, "spin": make_spin, "slam": make_slam, "cheer": make_cheer,
    "hurt": make_hurt, "flash": make_flash,
    "boulder": make_boulder, "uppercut": make_uppercut, "bellyflop": make_bellyflop,
    "dropkick": make_dropkick, "megahonk": make_megahonk, "flurry": make_flurry, "whiff": make_whiff,
    "rock": make_rock, "rock_break": make_rock_break,
}


def main() -> None:
    sheet_rows = []
    for name, fn in MOVES.items():
        frames = fn()
        out = np.zeros((FH, FW * len(frames), 4), dtype=np.uint8)
        for i, f in enumerate(frames):
            out[:, i * FW:(i + 1) * FW] = f
        Image.fromarray(out).save(os.path.join(SRC, f"{name}.png"))
        sheet_rows.append((name, out))
        print(f"{name}: {len(frames)} frames")
    # a contact sheet to look at, 4× on a dark ground, one move per row
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
