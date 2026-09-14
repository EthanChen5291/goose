"""
Build the pixel-art asset bundle the web client draws from.

    python3 web/tools/pixel_pack.py            # everything into web/public/px/

Everything the game shows is a sprite from a pack or a sprite this script
makes; nothing is scaled off-grid.  Sources live in assets/pixel (the packs,
trimmed to what is used) and the authored goose frames in
assets/pixel/goose/ (see goose_frames.py).  Output:

    px/manifest.json     what exists, frame sizes, feet lines, fps
    px/chars/*.png       character strips, one animation each, as shipped
    px/fx/*.png          effect strips from the gigapack (15 fps, horizontal)
    px/font/*.fnt,.png   bitmap fonts baked at native pixel sizes
    px/ui/*.png          the Emi pause/menu kit, plus generated hit circles
    px/scenes/*.png      pre-composed grassland scenes, parallax layers apart

Scenes are composed here, once, and picked at level time — never generated per
run.  Each is the four grassland layers plus a tiled ground, recoloured for a
mood, wider than any window's pixel buffer so they can scroll.
"""
from __future__ import annotations

import json
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ROOT = os.path.dirname(WEB)
SRC = os.path.join(ROOT, "assets", "pixel")
OUT = os.path.join(WEB, "public", "px")
FX_SRC = os.path.expanduser("~/Downloads/Super Pixel Effects Gigapack (Free Version)/spritesheet")

# ── characters ──────────────────────────────────────────────────────────────
# folder → (frame width, frame height).  Feet lines are measured from the art.
CHARS = {
    "goose": (64, 64),
    "skeleton_white": (96, 64),
    "skeleton_yellow": (96, 64),
    "ninja": (128, 128),
}
# the pack files use several naming conventions; this is the one the game uses
ANIM_NAME = {
    "Idle": "idle", "Walk": "walk", "Run": "run", "Flap": "flap",
    "Attack1": "attack", "Attack2": "attack2", "Hurt": "hurt", "Die": "die",
    "idle": "idle", "walk": "walk", "attack": "attack", "hit": "hurt",
    "Whitehit": "flash", "Death": "die",
}
# native playback rates: the packs are drawn for roughly these
CHAR_FPS = {"goose": 8, "skeleton_white": 12, "skeleton_yellow": 12, "ninja": 12}

# ── effects ─────────────────────────────────────────────────────────────────
# game name → (category, effect, variant).  The free pack has one colour each.
FX = {
    # hits on the enemy
    "slash": ("Impacts", "directional_impact_002", "large_white"),
    "impact_blue": ("Impacts", "directional_impact_001", "large_blue"),
    "impact_violet": ("Impacts", "directional_impact_003", "large_violet"),
    "impact_yellow": ("Impacts", "directional_impact_004", "large_yellow"),
    "burst_yellow": ("Impacts", "symmetrical_impact_001", "large_yellow"),
    "burst_blue": ("Impacts", "symmetrical_impact_002", "large_blue"),
    "burst_ring": ("Impacts", "symmetrical_impact_003", "large_yellow"),
    "burst_star": ("Impacts", "symmetrical_impact_004", "large_yellow"),
    "burst_big": ("Impacts", "symmetrical_impact_006", "large_yellow"),
    "muzzle": ("Sci-fi", "scifi_muzzle_flash_001", "large_yellow"),
    # movement
    "dust": ("Smoke Bursts", "symmetrical_smoke_burst_001", "large_brown"),
    "puff": ("Smoke Bursts", "directional_smoke_burst_001", "large_white"),
    "skull_smoke": ("Smoke Bursts", "stylized_skull_smoke_burst_001", "large_white"),
    # damage
    "splat": ("Splatters", "burst_splatter_001", "large_red"),
    "splat_dir": ("Splatters", "directional_splatter_001", "large_red"),
    "fail_x": ("Symbols", "symbol_failure_001", "large_red"),
    "alert": ("Symbols", "symbol_alert_001", "large_red"),
    # sparkle / reward
    "sparkle_blue": ("Magic Bursts", "round_sparkle_burst_001", "large_blue"),
    "sparkle_green": ("Magic Bursts", "round_sparkle_burst_002", "large_green"),
    "sparkle_red": ("Magic Bursts", "round_sparkle_burst_003", "large_red"),
    "music_red": ("Magic Bursts", "directional_music_burst_001", "large_red"),
    "music_yellow": ("Magic Bursts", "directional_music_burst_002", "large_yellow"),
    "hearts": ("Magic Bursts", "round_heart_burst_001", "large_red"),
    "firework_green": ("Magic Bursts", "round_firework_burst_001", "large_green"),
    "firework_yellow": ("Magic Bursts", "round_firework_burst_002", "large_yellow"),
    "light_burst": ("Magic Bursts", "round_light_burst_001", "large_yellow"),
    "coins": ("Magic Bursts", "directional_coin_burst_001", "large_yellow"),
    # stage
    "lightning": ("Lightning", "lightning_strike_001", "large_violet"),
    "zap": ("Lightning", "lightning_burst_001", "large_violet"),
    "zap2": ("Lightning", "lightning_burst_003", "large_violet"),
    "explosion": ("Explosions", "symmetrical_explosion_001", "large_orange"),
    "explosion_big": ("Explosions", "stylized_explosion_001", "large_yellow"),
    "haste": ("Fantasy Spells", "spell_haste_001", "large_green"),
    "attack_up": ("Fantasy Spells", "spell_attack_up_001", "large_red"),
    "sparkling": ("Fantasy Spells", "status_sparkling_001", "large_yellow"),
    "charge": ("Sci-fi", "scifi_charge_up_001", "large_yellow"),
    # words
    "text_cool": ("Symbols", "symbol_cool_text_001", "large_blue"),
    "text_wow": ("Symbols", "symbol_wow_text_001", "large_yellow"),
    "text_level_up": ("Symbols", "symbol_level_up_text_001", "large_blue"),
    "text_complete": ("Symbols", "symbol_complete_text_001", "large_blue"),
    "text_you_won": ("Symbols", "symbol_you_won_text_001", "large_green"),
    "text_you_lost": ("Symbols", "symbol_you_lost_text_001", "large_violet"),
    "crown": ("Symbols", "symbol_crown_001", "large_yellow"),
    "rank_S": ("Symbols", "symbol_rank_S_001", "large_yellow"),
    "rank_A": ("Symbols", "symbol_rank_A_001", "large_green"),
    "rank_B": ("Symbols", "symbol_rank_B_001", "large_orange"),
    "rank_C": ("Symbols", "symbol_rank_C_001", "large_blue"),
    "rank_D": ("Symbols", "symbol_rank_D_001", "large_violet"),
    "rank_F": ("Symbols", "symbol_rank_F_001", "large_red"),
}
FX_FPS = 15

# ── the hit-animation packs (Viktor Hahn, CC BY 4.0; assets/pixel/fx_hit) ────
# Thin line-art arcs, sparks, rings and streaks: the trail a blow leaves and the
# spark where it lands.  name → (file, frame w, frame h).  The sheets are grids;
# they are re-laid as horizontal strips with the empty frames dropped, and each
# also gets a half-size `_s` (box-filtered with the alpha thresholded so a 1 px
# line survives) — the size that suits a hit on a 28 px goose.
HIT_SRC = os.path.join(SRC, "fx_hit")
HIT_FX = {
    # the trail of a swing
    "swoosh": ("hit10.png", 64, 64),          # a wing's swipe
    "arc_down": ("swing01.png", 64, 64),      # a crescent chopping down and forward
    "arc_down_thin": ("swing02.png", 64, 64),
    "arc_c": ("swing03.png", 64, 64),         # a forward horizontal swipe, held then crumbling
    "arc_rise": ("hit04.png", 64, 64),        # a quarter arc (native: backward and down)
    "arc_rise_streak": ("hit05.png", 64, 64),
    "thrust": ("hit01.png", 64, 64),          # a diagonal stab line
    # where the blow lands
    "cross": ("hit02.png", 64, 64),
    "star": ("hit03.png", 64, 64),
    "spray": ("splash01.png", 64, 64),        # debris fanning forward
    "spray_b": ("splash02.png", 64, 64),
    "spike_burst": ("splash04.png", 64, 64),  # a big spiky impact
    "shards": ("shards01.png", 64, 64),
    "shards_b": ("shards02.png", 64, 64),
    "shatter": ("break01.png", 64, 64),       # four chunks flying apart
    "shatter_b": ("break02.png", 64, 64),
    "hit_red": ("hit11.png", 64, 64),
    # the ground and the air
    "ground_ring": ("impact01.png", 64, 64),  # a shockwave ellipse on the ground
    "ground_ring_b": ("impact02.png", 64, 64),
    "ring": ("circle02.png", 64, 64),         # an expanding circle
    "ring_tiny": ("circle01.png", 16, 16),
    "streak": ("blast01.png", 128, 32),       # a smoke streak (a dash, or a pillar when stood up)
    "streak_orange": ("blast01_orange.png", 128, 32),
    "streak_green": ("blast01_green.png", 128, 32),
    "comet": ("blast02.png", 128, 32),        # a projectile with a tail
    "comet_orange": ("blast02_orange.png", 128, 32),
    "balls": ("balls.png", 64, 64),
}

# ── fonts ───────────────────────────────────────────────────────────────────
# name → (file, px).  Press Start 2P is an 8 px grid font: crisp at 8 and 16.
# Pixelify Sans is the friendlier face, on-grid at multiples of 16.
FONTS = {
    "px8": ("PressStart2P.ttf", 8),
    "px16": ("PressStart2P.ttf", 16),
    "soft16": ("PixelifySans.ttf", 16),
    "soft32": ("PixelifySans.ttf", 32),
}
CHARS_SET = ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
             " .,:;!?%+-×x/'\"()[]_·")

# ── scenes ──────────────────────────────────────────────────────────────────
SCENE_W = 640          # wider than any pixel buffer (≈ 380–430) so it can scroll
SCENE_H = 320
GROUND_ROWS = 2        # 16 px tiles of dirt under the grass line
TILE = 16


def load(p: str) -> Image.Image:
    return Image.open(p).convert("RGBA")


def bbox_alpha(a: np.ndarray):
    ys, xs = np.where(a > 0)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


# ═══════════════════════════════════════════════════════════════════════════
# characters
# ═══════════════════════════════════════════════════════════════════════════
def pack_chars() -> dict:
    out = {}
    os.makedirs(os.path.join(OUT, "chars"), exist_ok=True)
    for folder, (fw, fh) in CHARS.items():
        d = os.path.join(SRC, folder)
        if not os.path.isdir(d):
            print("missing", d)
            continue
        anims = {}
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith(".png"):
                continue
            stem = os.path.splitext(fn)[0]
            # authored strips are named for what they are; the packs need mapping
            if stem == stem.lower() and " - " not in stem:
                name = stem
            else:
                key = stem.split("_")[-1] if "_" in stem else stem.split(" - ")[-1]
                name = ANIM_NAME.get(key, key.lower())
            im = load(os.path.join(d, fn))
            if im.width % fw or im.height != fh:
                print(f"  skip {folder}/{fn}: {im.size} not a {fw}x{fh} strip")
                continue
            n = im.width // fw
            a = np.array(im)[:, :, 3]
            # the union alpha box: where the figure is, across the whole strip
            union = None
            feet = 0
            for i in range(n):
                bb = bbox_alpha(a[:, i * fw:(i + 1) * fw])
                if bb is None:
                    continue
                feet = max(feet, bb[3] + 1)
                union = bb if union is None else (min(union[0], bb[0]), min(union[1], bb[1]),
                                                  max(union[2], bb[2]), max(union[3], bb[3]))
            dst = f"{folder}_{name}.png"
            im.save(os.path.join(OUT, "chars", dst))
            anims[name] = {
                "url": f"px/chars/{dst}", "fw": fw, "fh": fh, "n": n,
                "feet": feet, "box": list(union) if union else [0, 0, fw - 1, fh - 1],
                "fps": CHAR_FPS.get(folder, 10),
            }
        # one feet line per character: the idle's.  An authored frame whose outline
        # repair added a row under the feet must not stand a pixel lower.
        feet = anims["idle"]["feet"] if "idle" in anims else max(a["feet"] for a in anims.values())
        out[folder] = {"feet": feet, "fw": fw, "fh": fh, "anims": anims}
        print(f"chars {folder}: {', '.join(f'{k}({v[chr(110)]})' for k, v in anims.items())}")
    return out


# ═══════════════════════════════════════════════════════════════════════════
# effects
# ═══════════════════════════════════════════════════════════════════════════
def _fx_one(out: dict, name: str, cat: str, eff: str, var: str, fx_local: str) -> None:
    local = os.path.join(fx_local, f"{name}.png")
    if not os.path.exists(local):
        src = os.path.join(FX_SRC, cat, eff, f"{eff}_{var}", "spritesheet.png")
        if not os.path.exists(src):
            return
        shutil.copyfile(src, local)
    im = load(local)
    txt = os.path.join(FX_SRC, cat, eff, f"{eff}_{var}", "spritesheet.txt")
    fw = fh = None
    if os.path.exists(txt):
        first = open(txt, encoding="utf-8").readline().split("=")[-1].split()
        if len(first) == 4:
            fw, fh = int(first[2]), int(first[3])
    if fw is None:
        fh = im.height
        fw = fh if im.width % fh == 0 else im.width
    json.dump({"fw": fw, "fh": fh}, open(local[:-4] + ".json", "w"))
    shutil.copyfile(local, os.path.join(OUT, "fx", f"{name}.png"))
    out[name] = {"url": f"px/fx/{name}.png", "fw": fw, "fh": fh, "n": im.width // fw, "fps": FX_FPS}


def pack_fx() -> dict:
    """Every effect in FX, large and — where the pack has one — small (`name_s`).
    The small ones are the right size for a hit on a 30 px character; the large
    ones are for drops, milestones and the results screen."""
    out = {}
    os.makedirs(os.path.join(OUT, "fx"), exist_ok=True)
    fx_local = os.path.join(SRC, "fx")
    for name, (cat, eff, var) in FX.items():
        _fx_one(out, name, cat, eff, var, fx_local)
        if "large" in var:
            _fx_one(out, name + "_s", cat, eff, var.replace("large", "small"), fx_local)
    print(f"fx: {len(out)} strips")
    return out


def pack_fx_offline() -> dict:
    """The same, from the repo copies only (the pack folder is not on every machine)."""
    out = {}
    os.makedirs(os.path.join(OUT, "fx"), exist_ok=True)
    fx_local = os.path.join(SRC, "fx")
    for name in FX:
        local = os.path.join(fx_local, f"{name}.png")
        meta_p = local[:-4] + ".json"
        if not (os.path.exists(local) and os.path.exists(meta_p)):
            continue
        m = json.load(open(meta_p))
        im = load(local)
        shutil.copyfile(local, os.path.join(OUT, "fx", f"{name}.png"))
        out[name] = {"url": f"px/fx/{name}.png", "fw": m["fw"], "fh": m["fh"],
                     "n": im.width // m["fw"], "fps": FX_FPS}
    print(f"fx (offline): {len(out)} strips")
    return out


def shrink_half(strip: Image.Image) -> Image.Image:
    """Half size, for line art: box-filter, then keep any pixel whose box was at
    least a quarter covered (so a 1 px line stays a 1 px line), fully opaque,
    with the colour of the covered part."""
    a = np.array(strip).astype(np.float64)
    h, w = a.shape[0] // 2, a.shape[1] // 2
    b = a[:h * 2, :w * 2].reshape(h, 2, w, 2, 4)
    alpha = b[..., 3]
    cov = alpha.sum(axis=(1, 3)) / 4.0                      # 0..255 mean alpha of the box
    rgb = (b[..., :3] * alpha[..., None]).sum(axis=(1, 3)) / np.maximum(alpha.sum(axis=(1, 3)), 1)[..., None]
    out = np.zeros((h, w, 4), dtype=np.uint8)
    keep = cov >= 56
    out[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[..., 3] = np.where(keep, 255, 0).astype(np.uint8)
    out[~keep, :3] = 0
    return Image.fromarray(out)


def pack_fx_hit() -> dict:
    """The hit packs: each sheet re-laid as one horizontal strip, plus its `_s` half."""
    out = {}
    os.makedirs(os.path.join(OUT, "fx"), exist_ok=True)
    if not os.path.isdir(HIT_SRC):
        print("missing", HIT_SRC)
        return out
    for name, (fn, fw, fh) in HIT_FX.items():
        im = load(os.path.join(HIT_SRC, fn))
        frames = []
        for r in range(im.height // fh):
            for c in range(im.width // fw):
                f = im.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh))
                if np.array(f)[:, :, 3].max() > 0:
                    frames.append(f)
        strip = Image.new("RGBA", (fw * len(frames), fh))
        for i, f in enumerate(frames):
            strip.paste(f, (i * fw, 0))
        strip.save(os.path.join(OUT, "fx", f"{name}.png"))
        out[name] = {"url": f"px/fx/{name}.png", "fw": fw, "fh": fh, "n": len(frames), "fps": FX_FPS}
        small = shrink_half(strip)
        small.save(os.path.join(OUT, "fx", f"{name}_s.png"))
        out[name + "_s"] = {"url": f"px/fx/{name}_s.png", "fw": fw // 2, "fh": fh // 2, "n": len(frames), "fps": FX_FPS}
    print(f"fx (hit packs): {len(out)} strips")
    return out


# ═══════════════════════════════════════════════════════════════════════════
# fonts — AngelCode .fnt text format, which PixiJS loads as a BitmapFont
# ═══════════════════════════════════════════════════════════════════════════
def bake_font(name: str, file: str, px: int) -> dict:
    font = ImageFont.truetype(os.path.join(SRC, "fonts", file), px)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    glyphs = []
    for ch in CHARS_SET:
        # 1-bit rendering: a pixel font is on or off, never grey
        mask = font.getmask(ch, mode="1")
        bb = font.getbbox(ch)
        w = mask.size[0]
        h = mask.size[1]
        adv = font.getlength(ch)
        glyphs.append((ch, mask, bb, w, h, adv))
    # pack into rows
    pad = 1
    atlas_w = 256
    x = y = pad
    row_h = 0
    placed = []
    for ch, mask, bb, w, h, adv in glyphs:
        if x + w + pad > atlas_w:
            x = pad
            y += row_h + pad
            row_h = 0
        placed.append((ch, mask, bb, w, h, adv, x, y))
        x += w + pad
        row_h = max(row_h, h)
    atlas_h = y + row_h + pad
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    lines = [
        f'info face="{name}" size={px} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=0',
        f"common lineHeight={line_h} base={ascent} scaleW={atlas_w} scaleH={atlas_h} pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4",
        f'page id=0 file="{name}.png"',
        f"chars count={len(placed)}",
    ]
    for ch, mask, bb, w, h, adv, gx, gy in placed:
        if w and h:
            glyph = Image.new("RGBA", (w, h), (255, 255, 255, 255))
            glyph.putalpha(Image.frombytes("L", mask.size, bytes(mask)).point(lambda v: 255 if v else 0))
            atlas.paste(glyph, (gx, gy))
        # the mask is the ink box; bbox gives its offset from the pen position
        xoff = bb[0] if bb else 0
        yoff = bb[1] if bb else 0
        lines.append(f"char id={ord(ch)} x={gx} y={gy} width={w} height={h} "
                     f"xoffset={xoff} yoffset={yoff} xadvance={int(round(adv))} page=0 chnl=15")
    os.makedirs(os.path.join(OUT, "font"), exist_ok=True)
    atlas.save(os.path.join(OUT, "font", f"{name}.png"))
    with open(os.path.join(OUT, "font", f"{name}.fnt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return {"url": f"px/font/{name}.fnt", "px": px, "lineHeight": line_h}


def pack_fonts() -> dict:
    out = {}
    for name, (file, px) in FONTS.items():
        out[name] = bake_font(name, file, px)
        print(f"font {name}: {file} @ {px}px")
    # the TTFs too, for the DOM menus (drawn at whole multiples of 8 px)
    for fn in ("PressStart2P.ttf", "PixelifySans.ttf", "Silkscreen-Regular.ttf", "Silkscreen-Bold.ttf"):
        shutil.copyfile(os.path.join(SRC, "fonts", fn), os.path.join(OUT, "font", fn))
    return out


# ═══════════════════════════════════════════════════════════════════════════
# ui — the Emi kit, and the circles the highway needs
# ═══════════════════════════════════════════════════════════════════════════
def pixel_circle(r: int, stroke: int, fill: bool) -> Image.Image:
    """A midpoint-algorithm circle: the shape a pixel artist draws, not a polygon."""
    size = 2 * r + 1
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = im.load()
    pts = set()
    x, y, d = r, 0, 1 - r
    while x >= y:
        for sx, sy in ((x, y), (y, x), (-x, y), (-y, x), (x, -y), (y, -x), (-x, -y), (-y, -x)):
            pts.add((r + sx, r + sy))
        y += 1
        if d < 0:
            d += 2 * y + 1
        else:
            x -= 1
            d += 2 * (y - x) + 1
    if fill:
        for yy in range(size):
            xs = [xx for (xx, y2) in pts if y2 == yy]
            if xs:
                for xx in range(min(xs), max(xs) + 1):
                    px[xx, yy] = (255, 255, 255, 255)
        return im
    for (xx, yy) in pts:
        px[xx, yy] = (255, 255, 255, 255)
    # thicken inward
    for k in range(1, stroke):
        inner = pixel_circle(r - k, 1, False)
        im.alpha_composite(inner, (k, k))
    return im


def pack_ui() -> dict:
    out = {}
    ui = os.path.join(OUT, "ui")
    os.makedirs(ui, exist_ok=True)

    # the pause background, with the cyan bar in the top-left removed: the
    # dark ground and the diamond field from the right are what is wanted
    im = load(os.path.join(SRC, "emi", "game", "Background_Pause.png"))
    a = np.array(im)
    cyan = (a[:, :, 2] > 150) & (a[:, :, 0] < 120) & (a[:, :, 3] > 0)
    a[cyan] = (26, 25, 50, 255)
    Image.fromarray(a).save(os.path.join(ui, "pause_bg.png"))
    out["pause_bg"] = {"url": "px/ui/pause_bg.png", "w": im.width, "h": im.height}
    # and the diamond field alone, so it can slide in from the right
    field = np.array(im)
    keep = (field[:, :, 0] == 42) & (field[:, :, 1] == 47) & (field[:, :, 2] == 78)
    field[~keep] = (0, 0, 0, 0)
    ys, xs = np.where(keep)
    fx0, fy0, fx1, fy1 = xs.min(), ys.min(), xs.max(), ys.max()
    Image.fromarray(field[fy0:fy1 + 1, fx0:fx1 + 1]).save(os.path.join(ui, "pause_field.png"))
    out["pause_field"] = {"url": "px/ui/pause_field.png", "w": int(fx1 - fx0 + 1), "h": int(fy1 - fy0 + 1),
                          "x": int(fx0), "y": int(fy0)}

    for src, name in [("game/Pause_Panel.png", "pause_panel"), ("game/Buttons_Pause.png", "pause_buttons"),
                      ("game/Arrows.png", "arrows"), ("menu/Menu_Border.png", "menu_border"),
                      ("menu/Button_1.png", "button"), ("menu/ButtonLevel.png", "button_level"),
                      ("menu/SettingsPanel.png", "settings_panel"), ("menu/Slider_1.png", "slider")]:
        im = load(os.path.join(SRC, "emi", src))
        im.save(os.path.join(ui, f"{name}.png"))
        out[name] = {"url": f"px/ui/{name}.png", "w": im.width, "h": im.height}

    # the pause buttons as separate sprites (measured off the sheet)
    sheet = load(os.path.join(SRC, "emi", "game", "Buttons_Pause.png"))
    a = np.array(sheet)[:, :, 3]
    rows = []
    y = 0
    while y < a.shape[0]:
        if a[y].any():
            y0 = y
            while y < a.shape[0] and a[y].any():
                y += 1
            rows.append((y0, y))
        else:
            y += 1
    buttons = []
    for (y0, y1) in rows:
        cols = a[y0:y1].any(axis=0)
        x = 0
        while x < len(cols):
            if cols[x]:
                x0 = x
                while x < len(cols) and cols[x]:
                    x += 1
                buttons.append((x0, y0, x, y1))
            else:
                x += 1
    for i, (x0, y0, x1, y1) in enumerate(buttons):
        sheet.crop((x0, y0, x1, y1)).save(os.path.join(ui, f"pbtn_{i}.png"))
        out[f"pbtn_{i}"] = {"url": f"px/ui/pbtn_{i}.png", "w": x1 - x0, "h": y1 - y0}

    # hit circles and note bodies, in the radii the highway uses
    for r in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16):
        pixel_circle(r, 1, False).save(os.path.join(ui, f"ring{r}.png"))
        pixel_circle(r, 2, False).save(os.path.join(ui, f"ring{r}b.png"))
        pixel_circle(r, 1, True).save(os.path.join(ui, f"disc{r}.png"))
        out[f"ring{r}"] = {"url": f"px/ui/ring{r}.png", "w": 2 * r + 1, "h": 2 * r + 1}
        out[f"ring{r}b"] = {"url": f"px/ui/ring{r}b.png", "w": 2 * r + 1, "h": 2 * r + 1}
        out[f"disc{r}"] = {"url": f"px/ui/disc{r}.png", "w": 2 * r + 1, "h": 2 * r + 1}

    # arrow glyphs for the onecircle stage, which is played on the arrow keys:
    # 7×7, the shape a pixel artist draws, white so the game can tint them
    ARROWS = {
        "arrow_l": ["   #   ", "  ##   ", " ##### ", "###### ", " ##### ", "  ##   ", "   #   "],
        "arrow_r": ["   #   ", "   ##  ", " ##### ", " ######", " ##### ", "   ##  ", "   #   "],
        "arrow_u": ["   #   ", "  ###  ", " ##### ", "#######", "  ###  ", "  ###  ", "  ###  "],
        "arrow_d": ["  ###  ", "  ###  ", "  ###  ", "#######", " ##### ", "  ###  ", "   #   "],
    }
    for name, rows in ARROWS.items():
        im = Image.new("RGBA", (7, 7), (0, 0, 0, 0))
        px = im.load()
        for y, row in enumerate(rows):
            for x, ch in enumerate(row):
                if ch == "#":
                    px[x, y] = (255, 255, 255, 255)
        im.save(os.path.join(ui, f"{name}.png"))
        out[name] = {"url": f"px/ui/{name}.png", "w": 7, "h": 7}

    # kanji and katakana for the fight — the way an anime cut stamps 拳 on a
    # punch — rendered 1-bit from a system Japanese face, no anti-aliasing, at
    # two pixel sizes.  White, so the game tints them.
    KANJI = {
        "fist": "拳", "rock": "岩", "kick": "蹴", "roar": "轟", "strike": "撃", "swift": "疾",
        "soar": "翔", "crush": "潰", "slash": "斬", "power": "力", "wolf": "狼", "fang": "牙",
        "do": "ド", "go": "ゴ", "win": "勝", "fight": "闘", "roll": "転", "lash": "打",
    }
    import glob as _glob
    faces = _glob.glob("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc") + _glob.glob("/System/Library/Fonts/Hiragino Sans GB.ttc")
    if faces:
        for px_size in (16, 24, 48):
            font = ImageFont.truetype(faces[0], px_size)
            for name, ch in KANJI.items():
                im = Image.new("L", (px_size * 2, px_size * 2), 0)
                ImageDraw.Draw(im).text((px_size // 2, px_size // 4), ch, font=font, fill=255)
                bw = im.point(lambda v: 255 if v > 110 else 0)
                bb = bw.getbbox()
                if not bb:
                    continue
                bw = bw.crop(bb)
                rgba = Image.new("RGBA", bw.size, (0, 0, 0, 0))
                rgba.paste((255, 255, 255, 255), mask=bw)
                key = f"k{px_size}_{name}"
                rgba.save(os.path.join(ui, f"{key}.png"))
                out[key] = {"url": f"px/ui/{key}.png", "w": rgba.width, "h": rgba.height}
    else:
        print("no Japanese face found; kanji skipped")
    print(f"ui: {len(out)} pieces ({len(buttons)} pause buttons)")
    return out


# ═══════════════════════════════════════════════════════════════════════════
# scenes
# ═══════════════════════════════════════════════════════════════════════════
def remap(im: Image.Image, fn) -> Image.Image:
    """Apply a colour transform per *palette entry*, so the result is still a
    flat-shaded pixel image (no new gradients, every source colour → one colour)."""
    a = np.array(im).astype(np.int32)
    flat = a.reshape(-1, 4)
    uniq, inv = np.unique(flat, axis=0, return_inverse=True)
    mapped = np.array([fn(tuple(c)) for c in uniq], dtype=np.int32)
    return Image.fromarray(mapped[inv].reshape(a.shape).clip(0, 255).astype(np.uint8))


def _mix(c, target, k):
    return tuple(int(round(c[i] + (target[i] - c[i]) * k)) for i in range(3)) + (c[3],)


def _mul(c, m):
    return tuple(int(round(c[i] * m[i])) for i in range(3)) + (c[3],)


MOODS = {
    # name: (sky tint fn, far fn, mid fn, near/ground fn)
    "noon": (lambda c: c, lambda c: c, lambda c: c, lambda c: c),
    "dusk": (
        lambda c: _mix(_mul(c, (1.15, 0.85, 0.75)), (255, 140, 90), 0.25),
        lambda c: _mix(_mul(c, (1.1, 0.8, 0.9)), (200, 90, 120), 0.3),
        lambda c: _mix(_mul(c, (1.0, 0.8, 0.9)), (120, 60, 110), 0.3),
        lambda c: _mul(c, (1.05, 0.85, 0.8)),
    ),
    "night": (
        lambda c: _mix(_mul(c, (0.35, 0.4, 0.7)), (10, 12, 40), 0.55),
        lambda c: _mix(_mul(c, (0.4, 0.45, 0.8)), (20, 24, 70), 0.5),
        lambda c: _mix(_mul(c, (0.45, 0.5, 0.85)), (30, 34, 90), 0.45),
        lambda c: _mix(_mul(c, (0.55, 0.6, 0.9)), (30, 40, 80), 0.35),
    ),
    "storm": (
        lambda c: _mix(_mul(c, (0.7, 0.72, 0.78)), (70, 72, 85), 0.55),
        lambda c: _mix(_mul(c, (0.75, 0.75, 0.8)), (80, 82, 95), 0.45),
        lambda c: _mix(_mul(c, (0.8, 0.8, 0.85)), (70, 75, 85), 0.4),
        lambda c: _mix(_mul(c, (0.8, 0.82, 0.85)), (60, 65, 70), 0.3),
    ),
    "dawn": (
        lambda c: _mix(_mul(c, (1.1, 0.95, 1.05)), (255, 200, 170), 0.3),
        lambda c: _mix(c, (230, 170, 190), 0.35),
        lambda c: _mix(c, (180, 140, 190), 0.3),
        lambda c: _mix(_mul(c, (1.05, 1.0, 0.95)), (255, 220, 180), 0.12),
    ),
}


def tile(name: str) -> Image.Image:
    return load(os.path.join(SRC, "grasslands", "tiles", name))


def compose_ground(layout: str, ground_top: int) -> Image.Image:
    """The strip the characters stand on: grass tops over dirt, laid out per tile
    across the scene width, plus the raised shapes each layout adds behind."""
    im = Image.new("RGBA", (SCENE_W, SCENE_H), (0, 0, 0, 0))
    cols = SCENE_W // TILE
    top = tile("terrain_top_center_A.png")
    fill_a = tile("terrain_fill_1x1_A.png")
    for c in range(cols):
        im.alpha_composite(top, (c * TILE, ground_top))
        for r in range(1, GROUND_ROWS + 1):
            im.alpha_composite(fill_a, (c * TILE, ground_top + r * TILE))
    # a slope down at the far left edge on some layouts, so the ground is not a ruler
    return im


def compose_decor(layout: str, ground_top: int, rng: np.random.Generator) -> Image.Image:
    """Midground shapes: pillars and platforms in the darker midground tiles,
    standing on the ground behind the characters."""
    im = Image.new("RGBA", (SCENE_W, SCENE_H), (0, 0, 0, 0))
    tl, tc, tr = tile("midground_A_top_left.png"), tile("midground_A_top_center.png"), tile("midground_A_top_right.png")
    cl, cc, cr = tile("midground_A_center_left.png"), tile("midground_A_fill_1x1_A.png"), tile("midground_A_center_right.png")

    def block(x0: int, w: int, h: int) -> None:
        # w, h in tiles; the block sits on the ground
        y0 = ground_top - h * TILE
        for r in range(h):
            for c in range(w):
                if r == 0:
                    t = tl if c == 0 else (tr if c == w - 1 else tc)
                else:
                    t = cl if c == 0 else (cr if c == w - 1 else cc)
                im.alpha_composite(t, (x0 + c * TILE, y0 + r * TILE))

    if layout == "flat":
        block(28 * TILE, 3, 2)
    elif layout == "pillars":
        for x, h in ((3, 5), (9, 3), (26, 6), (33, 4)):
            block(x * TILE, 2, h)
    elif layout == "steps":
        for i, x in enumerate((2, 5, 8)):
            block(x * TILE, 3, 1 + i)
        block(30 * TILE, 4, 2)
    elif layout == "ruins":
        for x, w, h in ((1, 1, 7), (4, 1, 4), (7, 2, 2), (27, 1, 6), (31, 3, 1), (36, 1, 3)):
            block(x * TILE, w, h)
    return im


def compose_scene(name: str, mood: str, layout: str) -> dict:
    """One scene: sky, far mountains, mid mountains, near grass, decor, ground —
    saved as separate layers so the client can parallax them."""
    sky_f, far_f, mid_f, near_f = MOODS[mood]
    bgd = os.path.join(SRC, "grasslands", "bg")
    sky = load(os.path.join(bgd, "bg4.png"))
    far = load(os.path.join(bgd, "bg3.png"))
    mid = load(os.path.join(bgd, "bg2.png"))
    near = load(os.path.join(bgd, "bg1.png"))

    ground_top = SCENE_H - (GROUND_ROWS + 1) * TILE
    ground = compose_ground(layout, ground_top)
    decor = compose_decor(layout, ground_top, np.random.default_rng(hash(name) & 0xFFFF))

    def widen(layer: Image.Image, skyline_y: int) -> Image.Image:
        """Tile a 512-wide layer across the scene so its first opaque row (the
        skyline) sits at `skyline_y`, and carry its bottom row down to the
        ground: the pack's layers only fill ~90 px under their horizon."""
        a = np.array(layer)
        rows = np.where(a[:, :, 3].any(axis=1))[0]
        first = int(rows.min()) if len(rows) else 0
        dy = skyline_y - first
        out = Image.new("RGBA", (SCENE_W, SCENE_H), (0, 0, 0, 0))
        x = 0
        while x < SCENE_W:
            out.alpha_composite(layer, (x, dy))
            x += layer.width
        bottom = dy + layer.height
        if bottom < SCENE_H:
            o = np.array(out)
            o[bottom:, :] = o[bottom - 1, :]
            out = Image.fromarray(o)
        return out

    # the sky fills the whole height; its gradient bands sit at the horizon
    sky_l = Image.new("RGBA", (SCENE_W, SCENE_H), tuple(int(v) for v in np.array(sky)[0, 0]))
    sky_l.alpha_composite(widen(sky, ground_top - 256 + 40))
    far_l = widen(far, ground_top - 104)
    mid_l = widen(mid, ground_top - 72)
    near_l = widen(near, ground_top - 34)

    layers = [
        ("sky", remap(sky_l, sky_f), 0.0),
        ("far", remap(far_l, far_f), 0.15),
        ("mid", remap(mid_l, mid_f), 0.35),
        ("near", remap(near_l, near_f), 0.6),
        ("decor", remap(decor, near_f), 0.85),
        ("ground", remap(ground, near_f), 1.0),
    ]
    os.makedirs(os.path.join(OUT, "scenes"), exist_ok=True)
    meta = {"id": name, "mood": mood, "layout": layout, "w": SCENE_W, "h": SCENE_H,
            "groundY": ground_top, "layers": []}
    for lname, im, depth in layers:
        fn = f"{name}_{lname}.png"
        im.save(os.path.join(OUT, "scenes", fn))
        meta["layers"].append({"name": lname, "url": f"px/scenes/{fn}", "depth": depth})
    # a flat preview for the level list
    prev = Image.new("RGBA", (SCENE_W, SCENE_H), (0, 0, 0, 255))
    for _, im, _ in layers:
        prev.alpha_composite(im)
    prev.crop((0, SCENE_H - 216, 384, SCENE_H)).save(os.path.join(OUT, "scenes", f"{name}_preview.png"))
    meta["preview"] = f"px/scenes/{name}_preview.png"
    return meta


# ── the skies ───────────────────────────────────────────────────────────────
# The fight happens above the clouds now: each scene is one Craftpix sky set
# (assets/pixel/sky/<id>/1.png … n.png, 576×324, farthest first), shipped as
# it is, its layers apart so the client can drift them at different speeds.
# The ground is not in the art: the client draws a floating platform at
# `groundY` for the fighters to stand on.  `mood` is the word the level card
# shows.
SKY_H = 324
SKY_GROUND = 262
SKIES = [
    ("day_blue", "clear"), ("sunset_pink", "sunset"), ("night_moon", "night"), ("violet", "violet"),
    ("ember", "ember"), ("storm_lightning", "storm"), ("mint", "mint"), ("gold_dusk", "gold"),
    ("dusk_purple", "dusk"), ("day_clear", "noon"), ("storm_grey", "overcast"), ("overcast", "grey"),
    ("sea_sky", "sea"), ("night_full", "midnight"),
]


def compose_sky(name: str, mood: str) -> dict | None:
    src = os.path.join(SRC, "sky", name)
    files = sorted(f for f in os.listdir(src) if f[0].isdigit() and f.endswith(".png"))
    if not files:
        return None
    os.makedirs(os.path.join(OUT, "scenes"), exist_ok=True)
    meta = {"id": name, "mood": mood, "layout": "sky", "w": 576, "h": SKY_H, "groundY": SKY_GROUND, "layers": []}
    n = len(files)
    prev = Image.new("RGBA", (576, SKY_H), (0, 0, 0, 255))
    for i, fn in enumerate(files):
        im = load(os.path.join(src, fn))
        if im.size != (576, SKY_H):
            im = im.resize((576, SKY_H), Image.NEAREST)
        out = f"{name}_{i}.png"
        im.save(os.path.join(OUT, "scenes", out))
        # the sky itself stands still; the nearest clouds move most
        depth = 0.0 if i == 0 else round(0.12 + 0.78 * (i - 1) / max(1, n - 2), 3) if n > 2 else 0.6
        meta["layers"].append({"name": f"layer{i}", "url": f"px/scenes/{out}", "depth": depth})
        prev.alpha_composite(im)
    prev.crop((0, SKY_H - 216, 384, SKY_H)).save(os.path.join(OUT, "scenes", f"{name}_preview.png"))
    meta["preview"] = f"px/scenes/{name}_preview.png"
    return meta


def pack_scenes() -> list:
    out = []
    for name, mood in SKIES:
        meta = compose_sky(name, mood)
        if meta:
            out.append(meta)
            print(f"sky {name}: {len(meta['layers'])} layers")
        else:
            print(f"sky {name}: missing")
    return out


# ═══════════════════════════════════════════════════════════════════════════
def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    manifest = {
        "chars": pack_chars(),
        "fx": {**(pack_fx() if os.path.isdir(FX_SRC) else pack_fx_offline()), **pack_fx_hit()},
        "fonts": pack_fonts(),
        "ui": pack_ui(),
        "scenes": pack_scenes(),
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    total = sum(os.path.getsize(os.path.join(dp, fn))
                for dp, _, fns in os.walk(OUT) for fn in fns) / 1e6
    print(f"\npx bundle: {total:.1f} MB → {OUT}")


if __name__ == "__main__":
    sys.exit(main())
