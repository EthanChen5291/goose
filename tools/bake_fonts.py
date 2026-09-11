"""
Bake static Fredoka instances from the variable font.

pygame's font module renders a variable TTF at its *default* instance, and
Fredoka-VariableFont.ttf defaults to wght 300 (Light) — far too thin for the
display face.  This writes the two weights the play screen uses as ordinary
static TTFs next to the variable font:

    Fredoka-SemiBold.ttf   wght 600   display face (word block, HUD, orb glyphs)
    Fredoka-Medium.ttf     wght 500   the fainter queue rows

Needs fonttools (a build-time tool only — the baked .ttf files are what ship).
Run once after changing the variable font:

    pip install fonttools && python3 tools/bake_fonts.py
"""
from __future__ import annotations

import os
import sys

from fontTools import ttLib
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "fonts", "noki", "Fredoka-VariableFont.ttf")
WEIGHTS = {"SemiBold": 600, "Medium": 500}
WIDTH = 100


def bake(name: str, weight: int) -> str:
    font = ttLib.TTFont(SRC)
    instancer.instantiateVariableFont(font, {"wght": weight, "wdth": WIDTH}, inplace=True)
    out = os.path.join(os.path.dirname(SRC), f"Fredoka-{name}.ttf")
    font.save(out)
    return out


def main() -> None:
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC}")
    for name, weight in WEIGHTS.items():
        print("wrote", bake(name, weight))


if __name__ == "__main__":
    main()
