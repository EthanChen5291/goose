"""The build before this one: kept to read, run by nothing.

`game/engine.py` was the desktop game — one class that owned the loop, the
mechanics and five renderers — and `game/beatmap_generator.py` was how charts
were made before the Skeleton & Cells engine in `charting/`.  Both were replaced
rather than edited, and both were worth keeping: the renderers here are where
several effects were worked out, and the old generator is the only written record
of how charts used to be shaped.

Nothing outside this package imports it, and `main.py` has not run it in a long
time.  It lives here so `game/` can be read as what the game actually does.

    legacy/engine.py                the old play loop
    legacy/mechanics.py             its mechanics mixin
    legacy/rendering/               its five renderers: words, notes, timeline, effects, edge glitch
    legacy/beatmap_generator.py     the pre-Skeleton chart generator
    legacy/slot_builder.py          the slot maths under it
    legacy/charting_fallback.py     the path charting/ took to reach that generator

It still imports from `game` (models, constants, the input handler) — those are
live modules it shares with the current build, not copies.
"""
