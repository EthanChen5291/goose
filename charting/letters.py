"""
Letters mode planner: one letter per surviving accent, no words.

Consumes the same cells as Words — the phrase's layer, Normal's selection thinned for Easy
and extended for Hard and Demon — so the two modes of a song share their notes.  A focus set
(home row by default, or the letters of the song's word list) and a seeded planner assign
letters with the ergonomic rules from the blueprint: downbeats to index or middle fingers
alternating hands from the previous strong beat, streams alternate hands, no same finger
under 250 ms, every letter of the set at least once per 16 bars.  Each letter is its own
one-letter word to the judgment core.  Positions on the field are placed by the renderer
from the key anchor plus a seeded offset inside the tier's free radius.
"""
from __future__ import annotations

import random

from game import keyboard as KB
from game import models as M
from . import skeleton as SK

HOME = "asdfghjkl"
# Letters is the osu!-style field: every circle is a new place to look, so it takes only a share
# of the Words cells' notes (the strongest ones) and never two circles closer than this
LETTERS_SHARE = {"journey": 0.5, "classic": 0.6, "master": 0.75, "demon": 0.9}
LETTERS_GAP = {"journey": 0.50, "classic": 0.36, "master": 0.28, "demon": 0.22}


def focus_letters(word_bank: list[str]) -> str:
    letters = sorted({c for w in word_bank for c in w.lower() if c.isalpha()})
    if len(letters) < 6:
        letters = sorted(set(HOME) | set(letters))
    return "".join(letters)


def plan_letters(sk: SK.Skeleton, tier, letters: str, rng: random.Random,
                 vibes: list[str] | None = None, plans=None) -> list[M.CharEvent]:
    """``tier`` is an engine Tier (already fitted to the tempo) or a tier key."""
    from .engine import TIERS, tier_for_bpm, build_cells, section_vibes
    if isinstance(tier, str):
        tier = tier_for_bpm(TIERS.get(tier, TIERS["classic"]), sk.bpm)
    if vibes is None:
        vibes = section_vibes(sk)
    letters = "".join(sorted(set(c for c in letters.lower() if c.isalpha()))) or HOME
    left = [c for c in letters if KB.hand_of(c) == 0] or list("asdf")
    right = [c for c in letters if KB.hand_of(c) == 1] or list("jkl")
    counts = {c: 0 for c in letters}

    from .engine import _thin
    share = LETTERS_SHARE.get(tier.key, 0.6)
    gap = max(tier.min_gap, LETTERS_GAP.get(tier.key, 0.36))
    slots: list[tuple[SK.Point, str]] = []
    last_t = -1e9
    for cell in build_cells(sk, tier, vibes, plans):
        kept = _thin(cell.slots, cell.layer_of, share, gap)
        for p in kept:
            if p.t - last_t < gap:
                continue
            slots.append((p, cell.layer_of(p)))
            last_t = p.t
    slots.sort(key=lambda pl: pl[0].t)

    events: list[M.CharEvent] = []
    prev_char: str | None = None
    prev_t = -1e9
    prev_strong_hand = 1
    wid = 0
    bar_seen = 0

    def choose(pool: list[str], t: float, prefer_fingers: tuple | None) -> str:
        cands = list(pool)
        if prev_char is not None and t - prev_t < 0.25:
            c2 = [c for c in cands if KB.finger_of(c) != KB.finger_of(prev_char)]
            cands = c2 or cands
        if prev_char is not None and t - prev_t < 0.5:
            c2 = [c for c in cands if c != prev_char]
            cands = c2 or cands
        if prefer_fingers:
            c2 = [c for c in cands if KB.finger_of(c) in prefer_fingers]
            cands = c2 or cands
        # least-used first, with a little randomness
        cands.sort(key=lambda c: (counts[c], rng.random()))
        return cands[0]

    for p, layer in slots:
        if p.bar // 16 != bar_seen:
            bar_seen = p.bar // 16
            for c in counts:
                counts[c] = 0
        strong = p.sub == 0 and p.beat in (0, 2)
        stream = prev_char is not None and (p.t - prev_t) < 0.2
        if strong:
            hand = 1 - prev_strong_hand
            prev_strong_hand = hand
            ch = choose(left if hand == 0 else right, p.t, (2, 3, 6, 7))
        elif stream:
            hand = 1 - KB.hand_of(prev_char)
            ch = choose(left if hand == 0 else right, p.t, None)
        else:
            ch = choose(list(letters), p.t, None)
        counts[ch] += 1
        wid += 1
        events.append(M.CharEvent(char=ch, timestamp=float(SK.hit_time(p, layer)), word_text=ch, char_idx=0,
                                  beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                                  weight=p.metric, lane=KB.lane_of(ch), word_id=wid, section_kind="letters"))
        prev_char, prev_t = ch, p.t
    return events
