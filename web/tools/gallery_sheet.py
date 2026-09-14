"""
One contact sheet of everything tools/shots-gallery.mjs shot: a row per move,
its moments left to right, labelled with the time and the key showing.

    python3 web/tools/gallery_sheet.py [.scratch/gallery] [out.png] [move,move,…]
"""
import json
import os
import sys

from PIL import Image, ImageDraw

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", ".scratch", "gallery")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(d, "sheet.png")
index = json.load(open(os.path.join(d, "index.json")))
only = sys.argv[3].split(",") if len(sys.argv) > 3 else None
if only:
    index = [e for e in index if e["move"] in only]
K = 0.5   # shots are shown at half size
rows = []
for entry in index:
    ims = []
    for s in entry["shots"]:
        im = Image.open(os.path.join(d, s["file"])).convert("RGB")
        im = im.resize((int(im.width * K), int(im.height * K)), Image.LANCZOS)
        dr = ImageDraw.Draw(im)
        dr.rectangle([0, 0, 120, 14], fill=(0, 0, 0))
        dr.text((3, 2), f"t+{s['rel']:.2f}  key {s['key']}", fill=(255, 255, 255))
        ims.append(im)
    rows.append((entry["move"], ims))
cw = max(im.width for _, ims in rows for im in ims) + 4
ch = max(im.height for _, ims in rows for im in ims) + 4
cols = max(len(ims) for _, ims in rows)
W = 130 + cols * cw
H = len(rows) * ch
sheet = Image.new("RGB", (W, H), (20, 18, 31))
dr = ImageDraw.Draw(sheet)
for j, (name, ims) in enumerate(rows):
    dr.text((6, j * ch + 6), name, fill=(255, 222, 123))
    for i, im in enumerate(ims):
        sheet.paste(im, (130 + i * cw, j * ch))
sheet.save(out)
print(out, sheet.size)
