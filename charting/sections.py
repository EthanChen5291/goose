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
# Normal is the reference chart (Keyboard Warrior's shape: words on the song's layers), so its
# special phrases are few; Hard and Demon add more of them on top of the same notes
PATTERN_SHARE = {"journey": 0.0, "classic": 0.10, "master": 0.20, "demon": 0.30}
ANCHOR_SHARE = {"journey": 0.0, "classic": 0.10, "master": 0.16, "demon": 0.16}
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
ANCHOR_KEYS = {0: "fdsa", 1: "jkl"}                          # per hand, index finger first: a chain walks outward
HOLD_CHANCE = {"journey": 0.55, "classic": 0.38, "master": 0.30, "demon": 0.22}
ANCHOR_BARS = 2                                              # a hold with no sustain under it spans half a phrase

# Duo — what each tier may do while one hand holds.  The audio decides *where*; these decide *what*.
DUO = {
    #          free-hand voices allowed            chain  swap   chord  max holds/phrase  min hold (beats)
    "journey": {"voices": ("words",),             "chain": False, "swap": False, "chord": False, "max": 1, "min_beats": 4},
    "classic": {"voices": ("words", "stream"),    "chain": True,  "swap": False, "chord": False, "max": 2, "min_beats": 3},
    "master":  {"voices": ("words", "stream", "drums"), "chain": True, "swap": True, "chord": False, "max": 3, "min_beats": 2},
    "demon":   {"voices": ("words", "stream", "drums"), "chain": True, "swap": True, "chord": True,  "max": 4, "min_beats": 2},
}
BAND_HAND = {"low": 0, "high": 1}                            # a bass drone is the left hand, a lead the right


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
    drones: list = field(default_factory=list)   # (onset, duration, band) sustains that start in the phrase


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
        drones = [(o, d, band) for (o, d, band) in getattr(sk, "band_sustains", []) if t0 <= o < t1 - 1e-6]
        out.append(Phrase(i, b0, b1, t0, t1, vibes[b0] if b0 < len(vibes) else "groove",
                          energy, density, vocal, any(b in sus_bars for b in bars) or bool(drones),
                          drones=drones))
    for a, b in zip(out, out[1:]):
        # a build: the next phrase is louder, or the song steps up a vibe into it
        a.rising = ((b.energy - a.energy) >= 0.06 or (b.vibe == "burst" and a.vibe != "burst")) \
            and b.vibe in ("burst", "drive") and a.vibe != "burst"
    return out


def plan_phrases(sk: SK.Skeleton, tier_key: str, vibes: list[str], rng: random.Random,
                 reserved: list[tuple[float, float]] | None = None) -> list[Phrase]:
    """Assign a kind to every phrase.  ``reserved`` spans (duets) stay words."""
    phrases = _phrases(sk, vibes)
    reserved = reserved or []
    n = len(phrases)
    if n < 6:
        return phrases

    def free(ph: Phrase) -> bool:
        return not any(ph.t1 > r0 and ph.t0 < r1 for r0, r1 in reserved)

    max_pat = max(1, int(round(n * PATTERN_SHARE[tier_key]))) if tier_key in PATTERN_SHAPES else 0
    max_anc = max(1, int(round(n * ANCHOR_SHARE[tier_key])))
    beat = 60.0 / sk.bpm

    # patterns: builds first (the phrase before a louder one), strongest rise first; on Hard and
    # Demon a dense burst phrase may be a pattern too, so a fast chorus streams instead of
    # chopping words
    cands = [ph for ph in phrases[2:-1] if free(ph) and ph.rising and ph.density >= 2.5]
    cands.sort(key=lambda ph: -(phrases[ph.idx + 1].energy - ph.energy))
    # a dense burst phrase may stream too, so a fast chorus is a pattern rather than chopped words
    dense_min = {"classic": 6.0, "master": 5.0, "demon": 4.5}.get(tier_key, 99.0)
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

    # Duo phrases: where the song holds a note.  A phrase with real drones (a bass pad, a held
    # lead) ranks first — the longer the drone, the better — then quiet vocal phrases; never
    # next to a pattern, never the first or last phrase.  Journey shares are small.
    share = ANCHOR_SHARE[tier_key] if tier_key in PATTERN_SHAPES else 0.08
    max_anc = max(1, int(round(n * share)))
    cands = [ph for ph in phrases[2:-1] if free(ph) and ph.kind == "words"
             and (ph.drones or (ph.vibe in ("sustain", "groove") and ph.vocal >= 0.25))]
    cands.sort(key=lambda ph: (-sum(d for _o, d, _b in ph.drones), ph.energy))
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
        ph.extra["hand"] = hand           # the fallback hand when the phrase has no drone to read
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


def _snap(x: float, step: float) -> float:
    return round(x / step) * step


def plan_holds(sk: SK.Skeleton, ph: Phrase, tier_key: str, rng: random.Random) -> list[dict]:
    """Turn a phrase's drones into holds: [{t0, t1, hand, key, chord}] in time order.

    * each drone is a hold on the band's hand, as long as the drone (snapped to beats), clipped
      to the phrase and to the tier's minimum
    * consecutive drones on one hand *chain*: the hand walks outward along the home row
      (f → d → s), a hand-off at every new onset
    * a band change *swaps* hands where the tier allows; otherwise the phrase keeps one hand
    * a low and a high drone overlapping is a *chord* on Demon: both hands hold and release
      together on the overlap; below Demon the later drone is trimmed to start after the first
    * with no drone at all the phrase gets one two-bar hold on the fallback hand
    """
    rules = DUO[tier_key]
    beat = 60.0 / sk.bpm
    min_len = rules["min_beats"] * beat
    floor_len = 4 * beat                                # a hold is worth at least a bar of the other hand
    end_guard = 0.5 * beat                              # the release never collides with a note
    raw: list[dict] = []
    drones = sorted(ph.drones)
    for i, (onset, dur, band) in enumerate(drones):
        t0 = _snap(onset - ph.t0, beat) + ph.t0
        t1 = _snap(onset + dur - ph.t0, beat) + ph.t0
        # the floor: at least a bar, unless the next drone on this hand arrives sooner
        nxt = next((o for (o, _d, b) in drones[i + 1:] if BAND_HAND[b] == BAND_HAND[band]), None)
        t1 = max(t1, t0 + floor_len)
        if nxt is not None:
            t1 = min(t1, _snap(nxt - ph.t0, beat) + ph.t0 - beat)
        t1 = min(t1, ph.t1 - end_guard)
        if t1 - t0 < min_len - 1e-6:
            continue
        raw.append({"t0": t0, "t1": t1, "hand": BAND_HAND[band], "band": band})
    if not raw:
        h = int(ph.extra.get("hand", 0))
        t1 = min(ph.t1 - end_guard, ph.t0 + ANCHOR_BARS * 4 * beat)
        raw.append({"t0": ph.t0, "t1": t1, "hand": h, "band": "none"})
    raw.sort(key=lambda h: h["t0"])
    # one hand only, unless the tier swaps
    if not rules["swap"]:
        first = raw[0]["hand"]
        for h in raw:
            h["hand"] = first
    # resolve overlaps: a chord on Demon, otherwise the later one starts after the earlier ends
    holds: list[dict] = []
    for h in raw:
        if len(holds) >= rules["max"]:
            break
        if holds and h["t0"] < holds[-1]["t1"]:
            prev = holds[-1]
            if rules["chord"] and h["hand"] != prev["hand"] and h["t1"] - h["t0"] >= min_len:
                # trim both to the overlap so they release together
                t0, t1 = max(prev["t0"], h["t0"]), min(prev["t1"], h["t1"])
                if t1 - t0 >= min_len:
                    prev["t0"], prev["t1"] = t0, t1
                    h["t0"], h["t1"] = t0, t1
                    prev["chord"] = h["chord"] = True
                    holds.append(h)
                continue
            h["t0"] = prev["t1"] + beat                 # a beat of air at the hand-off
            if h["t1"] - h["t0"] < min_len:
                continue
        if holds and not rules["chain"] and h["hand"] == holds[-1]["hand"]:
            continue                                     # no chains on Easy: one hold per hand
        h.setdefault("chord", False)
        holds.append(h)
    # keys: the index finger first, then the chain walks outward; a chord takes both index keys
    step = {0: 0, 1: 0}
    for h in holds:
        keys = ANCHOR_KEYS[h["hand"]]
        h["key"] = keys[min(len(keys) - 1, step[h["hand"]])]
        if not h["chord"]:
            step[h["hand"]] += 1
    return holds


def _voice_for(sk: SK.Skeleton, t0: float, t1: float, tier_key: str) -> str:
    """What the free hand plays under a hold, from what the mix does there."""
    pts = sk.points_in(t0, t1)
    if not pts:
        return "words"
    beats = [p for p in pts if p.sub == 0]
    ands = [p for p in pts if p.sub == 2]
    drums = sum(1 for p in beats if max(p.kick, p.snare) >= 0.5)
    tune = sum(1 for p in pts if p.vocal >= 0.45 and p.peak)
    hats = sum(1 for p in ands if p.hat >= 0.5 and p.peak)
    allowed = DUO[tier_key]["voices"]
    # proportional to the span: a hold is often only a bar long
    if "stream" in allowed and ands and hats >= 0.6 * len(ands) and hats >= 3:
        return "stream"
    if "drums" in allowed and beats and drums >= 0.75 * len(beats) and drums >= 1.2 * max(1, tune) and drums >= 3:
        return "drums"
    return "words"


def _free_keys(hand: int, focus: str, rng: random.Random) -> tuple[str, str]:
    """Two home-row keys on the free hand for a stream or a drum voice: index first, then middle."""
    home = [c for c in ("jkl" if hand == 1 else "fdsa") if c in focus] or list("jkl" if hand == 1 else "fdsa")
    a = home[0]
    b = home[1] if len(home) > 1 else ("k" if hand == 1 else "d")
    return a, b


def _plan_stream(sk, t0, t1, hand, focus, tier_key, rng, wid, min_gap=0.24, finest=2) -> list[M.CharEvent]:
    """Two keys alternating on the eighths the hats confirm, grouped four to a pseudo-word."""
    a, b = _free_keys(hand, focus, rng)
    kept, _ = SK.select_slots(sk.points_in(t0, t1), 64, min_gap, max(2, finest))
    out: list[M.CharEvent] = []
    for gi in range(0, len(kept), 4):
        g = kept[gi:gi + 4]
        if len(g) < 2:
            break
        text = "".join(a if (gi + j) % 2 == 0 else b for j in range(len(g)))
        for j, p in enumerate(g):
            out.append(M.CharEvent(char=text[j], timestamp=float(SK.hit_time(p)), word_text=text, char_idx=j,
                                   beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                                   weight=p.metric, lane=KB.lane_of(text[j]), word_id=wid, section_kind="anchor_free"))
        out.append(M.CharEvent(char="", timestamp=float(g[-1].t) + 0.05, word_text="", char_idx=-1,
                               beat_position=0.0, section=int(g[-1].bar // 4), is_rest=True, section_kind="anchor_free"))
        wid += 1
    return out


def _plan_drums(sk, t0, t1, hand, focus, tier_key, rng, wid, min_gap=0.24) -> list[M.CharEvent]:
    """The beat voice: the index key on every kick, the middle key on every snare, a bar a word."""
    kick_key, snare_key = _free_keys(hand, focus, rng)
    pts = [p for p in sk.points_in(t0, t1) if p.peak and (p.sub % 2 == 0) and max(p.kick, p.snare) >= 0.45]
    hits: list[tuple[SK.Point, str]] = []
    for p in pts:
        if hits and p.t - hits[-1][0].t < min_gap:
            continue
        hits.append((p, kick_key if p.kick >= p.snare else snare_key))
    out: list[M.CharEvent] = []
    i = 0
    while i < len(hits):
        bar = hits[i][0].bar
        g = [h for h in hits[i:i + 8] if h[0].bar == bar]
        if len(g) < 2:
            i += max(1, len(g))
            continue
        text = "".join(ch for _p, ch in g)
        for j, (p, ch) in enumerate(g):
            out.append(M.CharEvent(char=ch, timestamp=float(SK.hit_time(p)), word_text=text, char_idx=j,
                                   beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                                   weight=p.metric, lane=KB.lane_of(ch), word_id=wid, section_kind="anchor_free"))
        out.append(M.CharEvent(char="", timestamp=float(g[-1][0].t) + 0.05, word_text="", char_idx=-1,
                               beat_position=0.0, section=int(bar // 4), is_rest=True, section_kind="anchor_free"))
        wid += 1
        i += len(g)
    return out


def plan_anchor(sk: SK.Skeleton, ph: Phrase, tier, focus: str, rng: random.Random, word_id_start: int,
                vocab: dict[int, list[WordInfo]], vibes: list[str], fit_words, emit_events, build_cells) -> list[M.CharEvent]:
    """A Duo phrase: the holds the drones dictate, and under each single hold the free hand's
    voice — words on the tune, a stream on the hats, the beat on the drums.

    ``fit_words`` / ``emit_events`` / ``build_cells`` are the engine's, passed in to avoid an
    import cycle.  Returns anchor events (section_kind "anchor") plus free-hand events.
    """
    beat = 60.0 / sk.bpm
    holds = plan_holds(sk, ph, tier.key, rng)
    events: list[M.CharEvent] = []
    wid = word_id_start
    ph.extra["holds"] = [(round(h["t0"], 3), round(h["t1"], 3), h["hand"], h["key"], h["chord"]) for h in holds]
    for h in holds:
        t0, t1, hand, key = h["t0"], h["t1"], h["hand"], h["key"]
        down = next((p for p in sk.points_in(t0 - 0.01, t0 + beat * 0.5) if p.sub == 0), None)
        t_anchor = float(SK.hit_time(down)) if (down is not None and not h["chord"]) else float(t0)
        dur = max(beat, t1 - t_anchor)
        events.append(M.CharEvent(
            char=key, timestamp=t_anchor, word_text=key, char_idx=0,
            beat_position=float(ph.bar0 * 4), section=int(ph.bar0 // 4), weight=4,
            lane=KB.lane_of(key), word_id=wid, hold_duration=float(dur), section_kind="anchor",
        ))
        wid += 1
        if h["chord"]:
            continue                                     # both hands are busy: nothing under a chord
        free = 1 - hand
        span0, span1 = t_anchor + beat, t_anchor + dur - beat * 0.5
        if span1 - span0 < beat:
            continue
        voice = _voice_for(sk, span0, span1, tier.key)
        ph.extra.setdefault("voices", []).append(voice)
        if voice == "stream":
            fe = _plan_stream(sk, span0, span1, free, focus, tier.key, rng, wid, tier.min_gap, tier.finest)
        elif voice == "drums":
            fe = _plan_drums(sk, span0, span1, free, focus, tier.key, rng, wid, tier.min_gap)
        else:
            fvocab = hand_vocab(vocab, free, tier.max_word_len)
            if not fvocab:
                continue
            cells = [c for c in build_cells(sk, tier, vibes) if c.t1 > span0 and c.t0 < span1]
            clipped = []
            for c in cells:
                c.slots = [p for p in c.slots if span0 <= p.t < span1]
                c.cand = [p for p in c.cand if span0 <= p.t < span1]
                if len(c.slots) >= 2:
                    clipped.append(c)
            fe = emit_events(fit_words(clipped, fvocab, tier, rng), sk, tier)
            for e in fe:
                e.section_kind = "anchor_free"
                if not e.is_rest:
                    e.word_id += wid
                    e.hold_duration = 0.0                # no nested holds under a hold
        # no free note may sit on the held hand (a stream/drum voice never does; words are filtered)
        fe = [e for e in fe if e.is_rest or KB.hand_of(e.char) == free]
        if fe:
            wid = max([e.word_id for e in fe if not e.is_rest] + [wid]) + 1
            events.extend(fe)
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
