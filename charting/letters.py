"""
Letters mode planner: one letter per surviving accent, no words.

Consumes the same skeleton as Words.  A focus set (home row by default, or
the letters of the song's word list) and a seeded planner assign letters with
the ergonomic rules from the blueprint: downbeats to index or middle fingers
alternating hands from the previous strong beat, streams alternate hands, no
same finger under 250 ms, every letter of the set at least once per 16 bars,
quiet bars get downbeats only.  Each letter is its own one-letter word to the
judgment core.  Positions on the field are placed by the renderer from the
key anchor plus a seeded offset inside the tier's free radius.
"""
from __future__ import annotations

import random

from game import keyboard as KB
from game import models as M
from . import skeleton as SK

# per bar and vibe: (bar beats, playable beats, max letters) — same idea as the Words cells
CELLS = {
    "journey": {"burst": (4, 3.5, 4), "drive": (4, 3.5, 3), "groove": (4, 3, 3), "sustain": (4, 3, 2)},
    "classic": {"burst": (4, 4, 6), "drive": (4, 4, 5), "groove": (4, 3.5, 4), "sustain": (4, 3, 3)},
    "master":  {"burst": (4, 4, 10), "drive": (4, 4, 8), "groove": (4, 4, 6), "sustain": (4, 3.5, 4)},
    "demon":   {"burst": (4, 4, 14), "drive": (4, 4, 12), "groove": (4, 4, 8), "sustain": (4, 4, 6)},
}
FINEST = {"journey": 4, "classic": 2, "master": 1, "demon": 1}
MIN_GAP = {"journey": 0.40, "classic": 0.24, "master": 0.16, "demon": 0.11}
HOME = "asdfghjkl"


def focus_letters(word_bank: list[str]) -> str:
    letters = sorted({c for w in word_bank for c in w.lower() if c.isalpha()})
    if len(letters) < 6:
        letters = sorted(set(HOME) | set(letters))
    return "".join(letters)


def plan_letters(sk: SK.Skeleton, tier_key: str, letters: str, rng: random.Random,
                 vibes: list[str] | None = None) -> list[M.CharEvent]:
    finest = FINEST.get(tier_key, 2)
    min_gap = MIN_GAP.get(tier_key, 0.24)
    cells = CELLS.get(tier_key, CELLS["classic"])
    if vibes is None:
        from .engine import section_vibes
        vibes = section_vibes(sk)
    beat = 60.0 / sk.bpm
    letters = "".join(sorted(set(c for c in letters.lower() if c.isalpha()))) or HOME
    left = [c for c in letters if KB.hand_of(c) == 0] or list("asdf")
    right = [c for c in letters if KB.hand_of(c) == 1] or list("jkl")
    counts = {c: 0 for c in letters}

    # slots per bar: the strongest accents of the playable part, strong beats first
    slots: list[SK.Point] = []
    for b in range(sk.n_bars):
        t0 = sk.bar_start[b]
        t1 = sk.bar_start[b + 1] if b + 1 < sk.n_bars else sk.beat_times[-1]
        _cell_beats, play_beats, k = cells[vibes[b] if b < len(vibes) else "groove"]
        play_end = min(t1, t0 + play_beats * beat)
        kept, _cand = SK.select_slots(sk.points_in(t0, play_end - 1e-6), k, min_gap, finest)
        slots.extend(kept)
    slots.sort(key=lambda p: p.t)

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

    for p in slots:
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
        events.append(M.CharEvent(char=ch, timestamp=float(SK.hit_time(p)), word_text=ch, char_idx=0,
                                  beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                                  weight=p.metric, lane=KB.lane_of(ch), word_id=wid, section_kind="letters"))
        prev_char, prev_t = ch, p.t
    return events
