"""
Sections — the chart stops being one long row of words.

The song is read in four-bar phrases.  Each phrase gets a *kind* from its
energy, its neighbours and the tier, so a run has shape: words most of the
time, then a **pattern** phrase where two letters trade on the accents while
the song builds ("oaoaoaoa" into the drop), an **anchor** phrase where one
hand holds a key for two bars while the other hand types words that live on
its side of the keyboard, and in the quiet stretches more **holds** on the
last letter of a word.  Nothing is hard-coded to a time: a pattern only lands
on a phrase whose energy is rising into a louder one, an anchor only where
the song sustains, and Easy keeps to words and holds.

``plan_phrases`` decides, ``plan_pattern`` / ``plan_anchor`` emit events, and
``add_holds`` sprinkles the extra holds.  Everything is seeded.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from game import keyboard as KB
from game import models as M
from . import skeleton as SK
from .words import WordInfo

PHRASE_BARS = 4

# share of phrases that may be a pattern / an anchor, per tier, and the pattern shapes each may use
PATTERN_SHARE = {"journey": 0.0, "classic": 0.16, "master": 0.26, "demon": 0.36}
ANCHOR_SHARE = {"journey": 0.0, "classic": 0.12, "master": 0.16, "demon": 0.16}
PATTERN_SHAPES = {
    "classic": ["AB"],
    "master": ["AB", "AAB", "ABB"],
    "demon": ["AB", "AAB", "ABB", "ABC", "ABAC"],
}
# letters per bar a pattern may take, by vibe (stronger accents first, like the word cells)
PATTERN_CAP = {
    "classic": {"burst": 4, "drive": 4, "groove": 3, "sustain": 2},
    "master": {"burst": 6, "drive": 5, "groove": 4, "sustain": 3},
    "demon": {"burst": 8, "drive": 7, "groove": 5, "sustain": 4},
}
PATTERN_GROUP = {"classic": 4, "master": 4, "demon": 6}      # letters per pseudo-word in the word block
ANCHOR_KEYS = {0: "fdsa", 1: "jkl"}                          # per hand, index finger first
HOLD_CHANCE = {"journey": 0.55, "classic": 0.38, "master": 0.30, "demon": 0.22}
ANCHOR_BARS = 2                                              # one anchor spans half a phrase


@dataclass
class Phrase:
    idx: int
    bar0: int
    bar1: int                 # exclusive
    t0: float
    t1: float
    vibe: str                 # the vibe of the phrase's first bar
    energy: float             # mean bar energy, 0..1
    density: float            # MUST + SHOULD points per bar
    vocal: float              # mean bar vocal presence
    sustain: bool             # a detected sustained note starts inside the phrase
    rising: bool = False      # the next phrase is clearly louder: this is a build
    kind: str = "words"       # words | pattern | anchor
    extra: dict = field(default_factory=dict)


# ── phrase analysis ───────────────────────────────────────────────────────
def _phrases(sk: SK.Skeleton, vibes: list[str]) -> list[Phrase]:
    n = sk.n_bars
    out: list[Phrase] = []
    counts_by_bar: dict[int, int] = {}
    for p in sk.points:
        if p.cls >= SK.SHOULD:
            counts_by_bar[p.bar] = counts_by_bar.get(p.bar, 0) + 1
    sus_bars = set()
    for onset, _d in sk.sustains:
        b = max(0, min(n - 1, next((i for i, t in enumerate(sk.bar_start) if t > onset), n) - 1))
        sus_bars.add(b)
    for i, b0 in enumerate(range(0, n, PHRASE_BARS)):
        b1 = min(n, b0 + PHRASE_BARS)
        t0 = sk.bar_start[b0]
        t1 = sk.bar_start[b1] if b1 < n else sk.beat_times[-1]
        bars = range(b0, b1)
        energy = sum(sk.bar_energy[b] for b in bars) / max(1, len(bars))
        density = sum(counts_by_bar.get(b, 0) for b in bars) / max(1, len(bars))
        vocal = sum(sk.bar_vocal[b] for b in bars) / max(1, len(bars))
        out.append(Phrase(i, b0, b1, t0, t1, vibes[b0] if b0 < len(vibes) else "groove",
                          energy, density, vocal, any(b in sus_bars for b in bars)))
    for a, b in zip(out, out[1:]):
        # a build: the next phrase is louder, or the song steps up a vibe into it
        a.rising = ((b.energy - a.energy) >= 0.06 or (b.vibe == "burst" and a.vibe != "burst")) \
            and b.vibe in ("burst", "drive") and a.vibe != "burst"
    return out


def plan_phrases(sk: SK.Skeleton, tier_key: str, vibes: list[str], rng: random.Random,
                 reserved: list[tuple[float, float]] | None = None) -> list[Phrase]:
    """Assign a kind to every phrase.  ``reserved`` spans (duets) stay words."""
    phrases = _phrases(sk, vibes)
    if tier_key not in PATTERN_SHAPES:
        return phrases
    reserved = reserved or []
    n = len(phrases)
    if n < 6:
        return phrases

    def free(ph: Phrase) -> bool:
        return not any(ph.t1 > r0 and ph.t0 < r1 for r0, r1 in reserved)

    max_pat = max(1, int(round(n * PATTERN_SHARE[tier_key])))
    max_anc = max(1, int(round(n * ANCHOR_SHARE[tier_key])))
    beat = 60.0 / sk.bpm

    # patterns: builds first (the phrase before a louder one), strongest rise first; on Hard and
    # Demon a dense burst phrase may be a pattern too, so a fast chorus streams instead of
    # chopping words
    cands = [ph for ph in phrases[2:-1] if free(ph) and ph.rising and ph.density >= 2.5]
    cands.sort(key=lambda ph: -(phrases[ph.idx + 1].energy - ph.energy))
    # a dense burst phrase may stream too, so a fast chorus is a pattern rather than chopped words
    dense_min = {"classic": 6.0, "master": 5.0, "demon": 4.5}[tier_key]
    dense = [ph for ph in phrases[2:-1] if free(ph) and ph.vibe == "burst" and ph.density >= dense_min]
    dense.sort(key=lambda ph: -ph.density)
    cands += [ph for ph in dense if ph not in cands]
    taken = 0
    for ph in cands:
        if taken >= max_pat:
            break
        # never two patterns in a row, and a bar of at least 4 beats so there is room to stream
        if any(phrases[j].kind == "pattern" for j in (ph.idx - 1, ph.idx + 1) if 0 <= j < n):
            continue
        if (ph.t1 - ph.t0) < 8 * beat:
            continue
        ph.kind = "pattern"
        ph.extra["shape"] = rng.choice(PATTERN_SHAPES[tier_key])
        taken += 1

    # anchors: where the song sustains and there is a tune to hold under — a detected held
    # note, or a quiet, vocal phrase; never next to a pattern, never the first or last phrase
    cands = [ph for ph in phrases[2:-1] if free(ph) and ph.kind == "words"
             and (ph.sustain or (ph.vibe in ("sustain", "groove") and ph.vocal >= 0.25))]
    cands.sort(key=lambda ph: (-(1.0 if ph.sustain else 0.0), ph.energy))
    taken = 0
    hand = rng.randint(0, 1)
    for ph in cands:
        if taken >= max_anc:
            break
        if any(phrases[j].kind != "words" for j in (ph.idx - 1, ph.idx + 1) if 0 <= j < n):
            continue
        if (ph.t1 - ph.t0) < 12 * beat:
            continue
        ph.kind = "anchor"
        ph.extra["hand"] = hand
        # Hard and Demon swap hands halfway; Fair rests the second half
        ph.extra["swap"] = tier_key in ("master", "demon")
        hand = 1 - hand
        taken += 1
    return phrases


# ── pattern phrases ───────────────────────────────────────────────────────
HOME_ROW_BIAS = {"classic": 1.0, "master": 0.8, "demon": 0.6}   # chance a pattern letter is on the home row


def _pattern_letters(shape: str, focus: str, rng: random.Random, tier_key: str = "classic") -> list[str]:
    """A..C mapped to real keys: A and B on opposite hands, home row preferred, from the level's letters."""
    left = [c for c in focus if KB.hand_of(c) == 0] or list("asdf")
    right = [c for c in focus if KB.hand_of(c) == 1] or list("jkl")
    home_l = [c for c in left if KB.row_of(c) == 1] or list("asdf")
    home_r = [c for c in right if KB.row_of(c) == 1] or list("jkl")
    bias = HOME_ROW_BIAS.get(tier_key, 0.8)
    a = rng.choice(home_l if rng.random() < bias else left)
    b = rng.choice(home_r if rng.random() < bias else right)
    if rng.random() < 0.5:
        a, b = b, a
    c_pool = [c for c in (left + right) if c not in (a, b) and KB.finger_of(c) not in (KB.finger_of(a), KB.finger_of(b))]
    c = rng.choice(c_pool) if c_pool else b
    return [{"A": a, "B": b, "C": c}[ch] for ch in shape]


def plan_pattern(sk: SK.Skeleton, ph: Phrase, tier_key: str, focus: str, rng: random.Random,
                 word_id_start: int, vibes: list[str], min_gap: float, finest: int) -> list[M.CharEvent]:
    cycle = _pattern_letters(ph.extra.get("shape", "AB"), focus, rng, tier_key)
    caps = PATTERN_CAP[tier_key]
    beat = 60.0 / sk.bpm
    slots: list[SK.Point] = []
    for b in range(ph.bar0, ph.bar1):
        t0 = sk.bar_start[b]
        t1 = sk.bar_start[b + 1] if b + 1 < sk.n_bars else sk.beat_times[-1]
        k = caps.get(vibes[b] if b < len(vibes) else "drive", 4)
        # the whole bar plays (a build has no rest), but never the last eighth before the next bar
        kept, _ = SK.select_slots(sk.points_in(t0, t1 - beat * 0.45), k, min_gap, finest)
        slots.extend(kept)
    slots.sort(key=lambda p: p.t)
    # enforce the gap across bar boundaries too
    pruned: list[SK.Point] = []
    for p in slots:
        if not pruned or p.t - pruned[-1].t >= min_gap:
            pruned.append(p)
    slots = pruned
    if len(slots) < 4:
        return []
    group = PATTERN_GROUP[tier_key]
    events: list[M.CharEvent] = []
    wid = word_id_start
    i = 0
    n = len(slots)
    while i < n:
        g = slots[i:i + group]
        if len(g) < 2:
            break
        letters = [cycle[(i + j) % len(cycle)] for j in range(len(g))]
        text = "".join(letters)
        for j, (p, ch) in enumerate(zip(g, letters)):
            events.append(M.CharEvent(
                char=ch, timestamp=float(SK.hit_time(p)), word_text=text, char_idx=j,
                beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                weight=p.metric, lane=KB.lane_of(ch), word_id=wid, section_kind="pattern",
            ))
        events.append(M.CharEvent(char="", timestamp=float(g[-1].t) + 0.05, word_text="", char_idx=-1,
                                  beat_position=0.0, section=int(g[-1].bar // 4), is_rest=True, section_kind="pattern"))
        wid += 1
        i += len(g)
    return events


# ── anchor phrases ────────────────────────────────────────────────────────
def hand_vocab(vocab: dict[int, list[WordInfo]], hand: int, max_len: int) -> dict[int, list[WordInfo]]:
    """Only the words that live entirely on one hand."""
    out: dict[int, list[WordInfo]] = {}
    for L, words in vocab.items():
        if L > max_len:
            continue
        ws = [w for w in words if KB.hand_of_word(w.text) == hand]
        if ws:
            out[L] = ws
    return out


def plan_anchor(sk: SK.Skeleton, ph: Phrase, tier, focus: str, rng: random.Random, word_id_start: int,
                vocab: dict[int, list[WordInfo]], vibes: list[str], fit_words, emit_events, build_cells) -> list[M.CharEvent]:
    """One hand holds a home key for two bars while the other hand types its own words.

    Returns the anchor event(s) plus the free-hand words.  ``fit_words`` / ``emit_events`` /
    ``build_cells`` are the engine's, passed in to avoid an import cycle.
    """
    beat = 60.0 / sk.bpm
    hand = int(ph.extra.get("hand", 0))
    swap = bool(ph.extra.get("swap", False))
    halves = [(ph.bar0, min(ph.bar1, ph.bar0 + ANCHOR_BARS), hand)]
    if swap and ph.bar1 - ph.bar0 >= 2 * ANCHOR_BARS:
        halves.append((ph.bar0 + ANCHOR_BARS, ph.bar1, 1 - hand))
    events: list[M.CharEvent] = []
    wid = word_id_start
    for (b0, b1, h) in halves:
        t0 = sk.bar_start[b0]
        t1 = sk.bar_start[b1] if b1 < sk.n_bars else sk.beat_times[-1]
        keys = [c for c in ANCHOR_KEYS[h] if c in focus] or list(ANCHOR_KEYS[h])
        key = keys[0] if rng.random() < 0.6 else rng.choice(keys)
        # the anchor lands on the downbeat, held to a beat before the half ends so the release
        # never collides with a note
        dur = max(2 * beat, (t1 - t0) - beat)
        down = next((p for p in sk.points_in(t0 - 0.01, t0 + beat * 0.5) if p.sub == 0), None)
        t_anchor = float(SK.hit_time(down)) if down is not None else float(t0)
        events.append(M.CharEvent(
            char=key, timestamp=t_anchor, word_text=key, char_idx=0,
            beat_position=float(b0 * 4), section=int(b0 // 4), weight=4,
            lane=KB.lane_of(key), word_id=wid, hold_duration=float(dur), section_kind="anchor",
        ))
        wid += 1
        # the free hand: words on the other side, starting a beat in, ending before the release
        free = 1 - h
        fvocab = hand_vocab(vocab, free, tier.max_word_len)
        if not fvocab:
            continue
        # a temporary skeleton view: cells over the span, one beat late, half a beat short
        span0, span1 = t0 + beat, t_anchor + dur - beat * 0.5
        sub_bars = [b for b in range(b0, b1)]
        cells = build_cells(sk, tier, vibes)
        cells = [c for c in cells if c.bar in sub_bars]
        clipped = []
        for c in cells:
            c.slots = [p for p in c.slots if span0 <= p.t < span1]
            c.cand = [p for p in c.cand if span0 <= p.t < span1]
            if len(c.slots) >= 2:
                clipped.append(c)
        fits = fit_words(clipped, fvocab, tier, rng)
        wevents = emit_events(fits, sk, tier)
        for e in wevents:
            if not e.is_rest:
                e.word_id += wid
                e.section_kind = "anchor_free"
                e.hold_duration = 0.0          # no nested holds under an anchor
            else:
                e.section_kind = "anchor_free"
        if wevents:
            wid += max(e.word_id for e in wevents if not e.is_rest) + 1
        events.extend(wevents)
    return events


# ── extra holds ───────────────────────────────────────────────────────────
def add_holds(events: list[M.CharEvent], tier_key: str, sk: SK.Skeleton, vibes: list[str], rng: random.Random) -> None:
    """More holds: the last letter of a word holds into the gap after it in calmer phrases.

    A hold needs room — at least a beat of silence after the word — and stops a quarter
    beat before the next note so the release is never a press.  Words already holding on a
    detected sustain are left alone.
    """
    beat = 60.0 / sk.bpm
    chance = HOLD_CHANCE.get(tier_key, 0.3)
    chars = [e for e in events if not e.is_rest and e.char]
    chars.sort(key=lambda e: e.timestamp)
    for i, e in enumerate(chars):
        if e.section_kind in ("anchor", "anchor_free", "pattern", "duet") or e.hold_duration > 0:
            continue
        if e.char_idx != len(e.word_text) - 1:
            continue
        nxt = chars[i + 1] if i + 1 < len(chars) else None
        gap = (nxt.timestamp - e.timestamp) if nxt is not None else 4 * beat
        if gap < 1.0 * beat + 0.25:
            continue
        bar = int(e.beat_position // 4)
        vibe = vibes[bar] if 0 <= bar < len(vibes) else "groove"
        p = chance * (1.0 if vibe in ("sustain", "groove") else 0.45)
        if rng.random() > p:
            continue
        d = min(gap - 0.25 * beat - 0.12, 2.5 * beat)
        d = round(d / (beat * 0.5)) * (beat * 0.5)        # snap to eighths so the release feels musical
        if d >= 0.35:
            e.hold_duration = float(d)
