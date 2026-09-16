"""
Package the game's data for the web client.

The charting pipeline stays in Python; this is the seam between it and the
browser.  It copies the shipped charts, transcodes the songs to a web-sized
bitrate, copies the fonts, and writes one index the client reads on boot.

    python3 web/tools/export_web.py                 # everything, skipping what is current
    python3 web/tools/export_web.py --songs 6       # only the first 6 songs
    python3 web/tools/export_web.py --charts-only   # skip the audio transcode

Audio is the whole payload: assets/audios is 575 MB of 320 kbps mp3, which is a
fine thing to keep in the repo and a terrible thing to ship.  Songs are
re-encoded to 128 kbps mono-preserving mp3 (about a tenth the size) into
web/public/audio/, which .gitignore keeps out of the repo — the deploy builds it.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import NamedTuple

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ROOT = os.path.dirname(WEB)
sys.path.insert(0, ROOT)

CHARTS_SRC = os.path.join(ROOT, "assets", "charts")
PUB = os.path.join(WEB, "public")
CHARTS_OUT = os.path.join(PUB, "charts")
AUDIO_OUT = os.path.join(PUB, "audio")
FONTS_OUT = os.path.join(PUB, "fonts")

FONTS = [
    ("noki/Fredoka-SemiBold.ttf", "Fredoka-SemiBold.ttf"),
    ("noki/Fredoka-Medium.ttf", "Fredoka-Medium.ttf"),
    ("noki/AtkinsonHyperlegible-Regular.ttf", "AtkinsonHyperlegible-Regular.ttf"),
    ("noki/AtkinsonHyperlegible-Bold.ttf", "AtkinsonHyperlegible-Bold.ttf"),
    ("noki/ArchivoBlack-Regular.ttf", "ArchivoBlack-Regular.ttf"),
    ("tacobae-font/Tacobae-pge2K.otf", "Tacobae.otf"),
]
class Cut(NamedTuple):
    """One file out of assets/audios, and how it is cut for the web.

    `start`/`dur` trim it, `peak_db` lifts its loudest sample to that level —
    what a phone recording needs to sit beside sounds mastered near full scale.
    """
    src: str
    out: str
    start: float = 0.0
    dur: float | None = None
    peak_db: float | None = None


# The menu theme.  The track is 165 bpm and its drop is its first beat, so the
# cut starts there — the moment before it is room, not music — and runs a whole
# 72 bars, which is every bar the track has.  Looping the file end to end is
# then the whole of it, in time, with no silence to sit through.
THEME_BPM = 165
THEME = Cut(os.path.join("built-in", "goose.wav"), "theme.mp3",
            start=0.3468, dur=72 * 4 * 60 / THEME_BPM)

# The recorded effects.  The waddles open on a moment of room tone that lands as
# a late footstep, so each starts at its first real step; -4.4 dBFS is the level
# they shared with the synthesised kit, less the 15% they were asked to come down.
EFFECTS: list[Cut] = [
    Cut("effects/hitsound.mp3", "hitsound.mp3"),
    Cut("effects/gooserun1.mp3", "gooserun1.mp3", start=0.115, peak_db=-4.4),
    Cut("effects/gooserun2.mp3", "gooserun2.mp3", start=0.010, dur=2.305, peak_db=-4.4),
    Cut("effects/gooserun3.mp3", "gooserun3.mp3", start=0.105, peak_db=-4.4),
]
TIERS = ("journey", "classic", "master", "demon")
MODES = ("words", "letters")
AUDIO_BITRATE = "128k"


def slug(name: str) -> str:
    """A filename safe in a URL: 'what is love?.mp3' -> 'what-is-love'."""
    stem = os.path.splitext(name)[0].lower()
    out = "".join(c if c.isalnum() else "-" for c in stem)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def song_path(name: str) -> str | None:
    for sub in ("canon", "custom", "built-in"):
        p = os.path.join(ROOT, "assets", "audios", sub, name)
        if os.path.exists(p):
            return p
    return None


def peak_gain_db(src: str, target_db: float) -> float:
    """The gain that puts `src`'s loudest sample on `target_db`."""
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", src, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    for line in out.splitlines():
        if "max_volume:" in line:
            return target_db - float(line.split("max_volume:")[1].split("dB")[0])
    return 0.0


def is_stale(src: str, dst: str, recipe: float = 0.0) -> bool:
    """Does `dst` need rebuilding from `src`?

    `recipe` is the mtime of whatever states the cut — the exporter itself.  A
    trim edited there has to re-encode a file whose source has not moved, or the
    edit silently never lands.
    """
    if not os.path.exists(dst):
        return True
    return os.path.getmtime(dst) < max(os.path.getmtime(src), recipe)


def encode_args(src: str, dst: str, peak_db: float | None = None,
                start: float = 0.0, dur: float | None = None, gain_db: float = 0.0) -> list[str]:
    """The ffmpeg call that writes `dst`: the whole recipe, and nothing done yet.

    Separate from running it so the cut can be read — and tested — without an
    encoder, a source file or a wait.
    """
    cut: list[str] = []
    if start:
        cut += ["-ss", f"{start:.4f}"]
    if dur is not None:
        cut += ["-t", f"{dur:.4f}"]
    lift: list[str] = []
    if peak_db is not None:
        # 40 Hz down is rumble the lift would only make louder; mono, like the rest of the kit
        lift = ["-af", f"highpass=f=40,volume={gain_db:.1f}dB", "-ac", "1"]
    return ["ffmpeg", "-v", "error", "-y", "-i", src, *cut, *lift,
            "-codec:a", "libmp3lame", "-b:a", AUDIO_BITRATE, "-map_metadata", "-1", dst]


def transcode(src: str, dst: str, peak_db: float | None = None,
              start: float = 0.0, dur: float | None = None, recipe: float = 0.0) -> bool:
    """Re-encode `src` to a web-sized mp3, trimmed to [`start`, `start` + `dur`].

    With `peak_db` it is also folded to mono and lifted so its loudest sample
    lands there — what a recorded effect needs to sit beside the synthesised
    ones, which are mastered near full scale.  Returns whether it wrote anything.
    """
    if not is_stale(src, dst, recipe):
        return False
    gain = peak_gain_db(src, peak_db) if peak_db is not None else 0.0
    subprocess.run(encode_args(src, dst, peak_db, start, dur, gain), check=True)
    return True


# Animation strips from assets/animations the client still uses.  The cat is
# gone: the goose, the enemies, the scenes and the effects are pixel art built
# by tools/pixel_pack.py into public/px/, not strips from here.
SHEETS: list[tuple[str, int]] = []

# Flat images the menus draw.  None now — the menus are the pixel kit.
IMAGES: list[str] = []


def pack_sheet(name: str, height: int) -> dict | None:
    """Pack an animation folder into one horizontal strip PNG plus its frame size.

    game/sprites.py crops every frame to the animation's *union* alpha bbox so the
    figure never jitters between frames, then scales to a height and caches the
    result on disk.  The same crop happens here, once, and the browser gets a
    single image instead of 37 requests.
    """
    import pygame
    folder = os.path.join(ROOT, "assets", "animations", name)
    if not os.path.isdir(folder):
        return None
    paths = sorted(os.path.join(folder, f) for f in os.listdir(folder)
                   if f.lower().endswith(".png"))
    if not paths:
        return None
    raws = [pygame.image.load(p).convert_alpha() for p in paths]
    union = None
    for r in raws:
        bb = r.get_bounding_rect(min_alpha=8)
        union = bb if union is None else union.union(bb)
    if union is None or union.w < 2 or union.h < 2:
        union = raws[0].get_rect()
    scale = height / union.h
    fw, fh = max(1, int(union.w * scale)), height
    sheet = pygame.Surface((fw * len(raws), fh), pygame.SRCALPHA)
    for i, r in enumerate(raws):
        crop = r.subsurface(union).copy()
        sheet.blit(pygame.transform.smoothscale(crop, (fw, fh)), (i * fw, 0))
    out = os.path.join(PUB, "img", name + ".png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    pygame.image.save(sheet, out)
    return {"url": f"img/{name}.png", "frames": len(raws), "w": fw, "h": fh}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--songs", type=int, default=0, help="cap the number of songs exported")
    ap.add_argument("--charts-only", action="store_true")
    args = ap.parse_args()

    for d in (CHARTS_OUT, AUDIO_OUT, FONTS_OUT):
        os.makedirs(d, exist_ok=True)

    index_src = json.load(open(os.path.join(CHARTS_SRC, "index.json"), encoding="utf-8"))
    charts = index_src["charts"]

    import main as app
    names = list(app.SONG_NAMES)
    if args.songs:
        names = names[: args.songs]

    songs = []
    copied = shipped = 0
    for name in names:
        src = song_path(name)
        if src is None:
            print("skip (no audio)", name)
            continue
        sl = slug(name)
        entry = {
            "id": sl,
            "title": os.path.splitext(name)[0],
            "audio": f"audio/{sl}.mp3",
            "charts": {},
        }
        have_any = False
        for tier in TIERS:
            for mode in MODES:
                cid = charts.get(f"{name}|{tier}|{mode}")
                if cid is None:
                    continue
                src_chart = os.path.join(CHARTS_SRC, cid + ".json")
                if not os.path.exists(src_chart):
                    continue
                shutil.copyfile(src_chart, os.path.join(CHARTS_OUT, cid + ".json"))
                shipped += 1
                have_any = True
                data = json.load(open(src_chart, encoding="utf-8"))
                entry["charts"][f"{tier}|{mode}"] = {
                    "id": cid,
                    "notes": data["meta"].get("notes", 0),
                    "bars": data["meta"].get("bars", 0),
                }
                entry.setdefault("bpm", round(data["song"]["bpm"], 2))
                entry.setdefault("duration", round(data["song"]["duration"], 1))
        if not have_any:
            print("skip (no charts)", name)
            continue
        if not args.charts_only:
            if transcode(src, os.path.join(AUDIO_OUT, sl + ".mp3")):
                copied += 1
        songs.append(entry)
        print(f"{name}: {len(entry['charts'])} charts")

    # the menu theme beside the songs, and the recorded effects beside the
    # synthesised ones tools/sfx_gen.py writes into audio/sfx
    sfx_dir = os.path.join(AUDIO_OUT, "sfx")
    os.makedirs(sfx_dir, exist_ok=True)
    if not args.charts_only:
        for cut, out_dir in [(THEME, AUDIO_OUT)] + [(e, sfx_dir) for e in EFFECTS]:
            src = os.path.join(ROOT, "assets", "audios", cut.src)
            if not os.path.exists(src):
                print("skip (missing)", cut.src)
                continue
            transcode(src, os.path.join(out_dir, cut.out), cut.peak_db, cut.start, cut.dur,
                      recipe=os.path.getmtime(__file__))

    for src_rel, dst_name in FONTS:
        src = os.path.join(ROOT, "assets", "fonts", src_rel)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(FONTS_OUT, dst_name))

    # What the last run wrote.  `--charts-only` skips the art, and writing the
    # index from an empty dict would drop every sheet and image out of it — the
    # files stay on disk, the client stops being told they exist, and the menus
    # quietly lose their animations while the hardcoded images keep working.
    prev = {}
    index_out = os.path.join(PUB, "index.json")
    if os.path.exists(index_out):
        try:
            prev = json.load(open(index_out, encoding="utf-8"))
        except Exception:
            prev = {}

    # flat menu art, copied as-is
    img_out = os.path.join(PUB, "img")
    os.makedirs(img_out, exist_ok=True)
    images = list(prev.get("images", []))
    if not args.charts_only:
        images = []
        for fn in IMAGES:
            src_img = os.path.join(ROOT, "assets", "images", fn)
            if os.path.exists(src_img):
                shutil.copyfile(src_img, os.path.join(img_out, fn))
                images.append(fn)

    sheets = dict(prev.get("sheets", {}))
    if not args.charts_only:
        sheets = {}
        import pygame
        pygame.init()
        pygame.display.set_mode((1, 1))
        for name, h in SHEETS:
            info = pack_sheet(name, h)
            if info:
                sheets[name] = info
                print(f"sheet {name}: {info['frames']} frames @ {info['w']}x{info['h']}")

    with open(os.path.join(PUB, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"generator": index_src.get("generator"), "songs": songs,
                   "sheets": sheets, "images": images}, f, indent=1)
    # a sheet on disk that the index does not mention is a menu with no animation
    missing = [f2[:-4] for f2 in sorted(os.listdir(img_out))
               if f2.endswith(".png") and f2[:-4] in dict(SHEETS) and f2[:-4] not in sheets]
    if missing:
        print(f"WARNING: {', '.join(missing)} are on disk but not in the index — "
              f"the menus will show no animation.  Re-run without --charts-only.")

    audio_mb = sum(os.path.getsize(os.path.join(AUDIO_OUT, f))
                   for f in os.listdir(AUDIO_OUT) if f.endswith(".mp3")) / 1e6
    print(f"\n{len(songs)} songs, {shipped} charts, {copied} transcoded "
          f"| audio payload {audio_mb:.0f} MB")


if __name__ == "__main__":
    main()
