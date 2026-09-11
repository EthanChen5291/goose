"""
Skeleton & Cells — the chart generator.

Where can a note go?  The skeleton answers (a property of the audio).
Which whole word fits this rhythm cell?  The fitter answers, per cell, with
the word pool and the vibe of the section:

  * a cell is a stretch of beats whose length follows the section's energy
    (burst → half a bar, drive/groove → a bar, sustain → two); a word may only
    occupy the first part of it, so every word is followed by a rest
  * the letters' slots are the strongest accents of that part, strong beats
    first (beat 1, beat 3, the backbeats, then an off-beat only when it is a
    real onset that stands out), capped per tier and never closer than the
    tier's minimum gap
  * the word is chosen to match the accent count exactly when it can,
    with bonuses for plosives on kicks, hand alternation on fast pairs, the
    teacher's list, and the section's vibe, and penalties for repeats

Everything is seeded, so the same song + words + difficulty gives the same
chart on every machine.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
from dataclasses import dataclass

from game import constants as C
from game import models as M
from game.rhythm import calculate_lead_in
from . import skeleton as SK
from .words import build_vocab, WordInfo


# ── tier profiles ─────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Tier:
    key: str
    min_gap: float            # seconds between letters
    finest: int               # 4 = beats only, 2 = eighths, 1 = sixteenths
    cells: dict               # vibe -> (cell beats, playable beats, max slots): the rest is the difference
    max_word_len: int
    allow_holds: bool
    burst_lengths: tuple = (2, 3)   # preferred word lengths in bursts
    short_cell_min_s: float = 0.0   # a half-bar cell shorter than this falls back to the drive cell


# Every word is followed by a rest the ear can feel: a cell is (length, playable part, cap).
# At 120 BPM these give roughly 1.1 / 1.8 / 2.7 / 3.6 letters per second on Easy / Fair / Hard / Demon,
# and the slots inside a cell are the strongest accents, strong beats first.
TIERS = {
    "journey": Tier("journey", 0.40, 4, {"burst": (4, 3, 3), "drive": (4, 3, 3), "groove": (8, 6, 4), "sustain": (8, 6, 3)}, 5, True),
    "classic": Tier("classic", 0.24, 2, {"burst": (2, 1.5, 3), "drive": (4, 3, 4), "groove": (4, 3, 3), "sustain": (8, 6, 5)}, 6, True, (2, 3), 1.0),
    "master":  Tier("master", 0.16, 1, {"burst": (2, 1.5, 4), "drive": (4, 3.5, 6), "groove": (4, 3, 5), "sustain": (8, 6, 6)}, 8, True, (2, 3, 4)),
    "demon":   Tier("demon", 0.11, 1, {"burst": (2, 1.75, 5), "drive": (2, 1.5, 4), "groove": (4, 3.5, 7), "sustain": (4, 3, 5)}, 9, True, (2, 3, 4)),
}


# ── skeleton cache ────────────────────────────────────────────────────────
def _skeleton_cache_path(song_path: str, expected_bpm: int | None) -> str:
    from . import _cache_dir, song_fingerprint
    d = os.path.join(_cache_dir(), "skeletons")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{song_fingerprint(song_path)}_{expected_bpm or 'auto'}_v7.json")


def get_skeleton(song_path: str, expected_bpm: int | None = None, progress=None) -> SK.Skeleton:
    p = _skeleton_cache_path(song_path, expected_bpm)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return SK.from_dict(json.load(f))
        except Exception:
            pass
    sk = SK.build_skeleton(song_path, expected_bpm, progress=progress)
    try:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(SK.to_dict(sk), f)
    except Exception:
        pass
    return sk


# ── vibe ──────────────────────────────────────────────────────────────────
def section_vibes(sk: SK.Skeleton, window_bars: int = 4) -> list[str]:
    """One vibe per bar from the energy of its 4-bar window relative to the song."""
    n = sk.n_bars
    if n == 0:
        return []
    win = []
    for b in range(n):
        lo = max(0, b - b % window_bars)
        hi = min(n, lo + window_bars)
        win.append(sum(sk.bar_energy[lo:hi]) / max(1, hi - lo))
    srt = sorted(win)
    q1 = srt[int(len(srt) * 0.25)]
    q2 = srt[int(len(srt) * 0.55)]
    q3 = srt[int(len(srt) * 0.80)]
    out = []
    for e in win:
        if e >= q3:
            out.append("burst")
        elif e >= q2:
            out.append("drive")
        elif e >= q1:
            out.append("groove")
        else:
            out.append("sustain")
    return out


# ── cells ─────────────────────────────────────────────────────────────────
@dataclass
class Cell:
    t0: float
    t1: float
    bar: int
    vibe: str
    slots: list[SK.Point]
    cand: list[SK.Point]      # every eligible point in the playable part (for extending by one)


def build_cells(sk: SK.Skeleton, tier: Tier, vibes: list[str]) -> list[Cell]:
    """Cut the song into cells by vibe; in each, the slots are the strongest accents of the playable part."""
    cells: list[Cell] = []
    beat = 60.0 / sk.bpm
    b = 0
    n = sk.n_bars
    t_cursor = sk.bar_start[0] if sk.bar_start else 0.0
    while b < n:
        vibe = vibes[b]
        cell_beats, play_beats, k = tier.cells[vibe]
        if cell_beats < 4 and cell_beats * beat < tier.short_cell_min_s:
            cell_beats, play_beats, k = tier.cells["drive"]      # fast song: a half-bar burst would be a two-letter stutter
        t0 = t_cursor
        bar_end = sk.bar_start[b + 1] if b + 1 < n else sk.beat_times[-1]
        if cell_beats >= 4:
            end_bar = min(n, b + int(cell_beats) // 4)
            t1 = sk.bar_start[end_bar] if end_bar < n else sk.beat_times[-1]
            next_b, next_t = end_bar, t1
        else:
            t1 = min(bar_end, t0 + cell_beats * beat)
            next_b = b + 1 if t1 >= bar_end - 1e-6 else b
            next_t = t1
        play_end = min(t1, t0 + play_beats * beat)
        pts = sk.points_in(t0, play_end - 1e-6)
        slots, cand = SK.select_slots(pts, k, tier.min_gap, tier.finest)
        cells.append(Cell(t0, t1, b, vibe, slots, cand))
        b, t_cursor = next_b, next_t
        if next_t <= t0 + 1e-6:      # safety
            b += 1
            t_cursor = sk.bar_start[b] if b < n else sk.beat_times[-1]
    return cells


# ── fitting ───────────────────────────────────────────────────────────────
def _score_word(w: WordInfo, slots: list[SK.Point], cell: Cell, recent: list[str], tier: Tier, rng: random.Random) -> float:
    n = len(slots)
    s = 0.0
    if w.n == n:
        s += 2.5
    elif abs(w.n - n) == 1:
        s += 1.0
    else:
        s -= 1.5 * abs(w.n - n)
    m = min(w.n, n)
    for i in range(m):
        p = slots[i]
        if w.plosive_mask[i] and p.attack in ("kick", "snare") and p.cls >= SK.SHOULD:
            s += 0.4
        if i > 0:
            gap = p.t - slots[i - 1].t
            if gap < 0.2:
                if w.hands[i] != w.hands[i - 1]:
                    s += 0.3
                if w.fingers[i] == w.fingers[i - 1]:
                    s -= 0.6
    if w.from_bank:
        s += 1.2
    if cell.vibe == "burst" and w.n in tier.burst_lengths:
        s += 0.5
    if cell.vibe == "sustain" and w.n >= 6:
        s += 0.5
    # variety: a word just used loses more than the bank bonus, twice in a row loses double
    n_recent = recent[-8:].count(w.text)
    if n_recent:
        s -= 1.4 * min(2, n_recent)
    elif w.text in recent[-20:]:
        s -= 0.5
    s += rng.random() * 0.2
    return s


def _extend_slots(cell: Cell, slots: list[SK.Point], tier: Tier) -> list[SK.Point] | None:
    """One more slot from the cell's eligible points, respecting the gap; None if impossible."""
    used = {id(p) for p in slots}
    if not cell.cand:
        return None
    max_conf = max(p.conf for p in cell.cand) or 1e-6
    best = None
    for p in sorted(cell.cand, key=lambda q: -SK.slot_score(q, q.conf / max_conf)):
        if id(p) in used:
            continue
        if all(abs(p.t - q.t) >= tier.min_gap for q in slots):
            best = p
            break
    if best is None:
        return None
    return sorted(slots + [best], key=lambda p: p.t)


def _split_slots(slots: list[SK.Point], max_len: int) -> list[list[SK.Point]]:
    """Split a long run of slots into groups of at most max_len at the widest gaps."""
    if len(slots) <= max_len:
        return [slots]
    n_groups = -(-len(slots) // max_len)
    # candidate cut positions ranked by gap size, keep n_groups-1 cuts that leave every group >= 2
    gaps = sorted(range(1, len(slots)), key=lambda i: -(slots[i].t - slots[i - 1].t))
    cuts: list[int] = []
    for i in gaps:
        if len(cuts) >= n_groups - 1:
            break
        trial = sorted(cuts + [i])
        bounds = [0] + trial + [len(slots)]
        if all(2 <= b - a <= max_len for a, b in zip(bounds, bounds[1:])) or len(trial) < n_groups - 1:
            cuts = trial
    bounds = [0] + sorted(cuts) + [len(slots)]
    groups = [slots[a:b] for a, b in zip(bounds, bounds[1:]) if b > a]
    # any group still too long: hard-chop
    out: list[list[SK.Point]] = []
    for g in groups:
        while len(g) > max_len:
            out.append(g[:max_len])
            g = g[max_len:]
        if len(g) >= 2:
            out.append(g)
        elif g and out:
            out[-1] = (out[-1] + g)[-max_len:] if len(out[-1]) < max_len else out[-1]
    return out


def fit_words(cells: list[Cell], vocab: dict[int, list[WordInfo]], tier: Tier, rng: random.Random) -> list[tuple[Cell, WordInfo | None, list[SK.Point]]]:
    out = []
    recent: list[str] = []
    for cell in cells:
        if not cell.slots:
            out.append((cell, None, []))
            continue
        groups = _split_slots(cell.slots, tier.max_word_len)
        for gi, slots in enumerate(groups):
            n = len(slots)
            cands: list[tuple[float, WordInfo, list[SK.Point]]] = []
            extended = _extend_slots(cell, slots, tier) if len(groups) == 1 else None
            for L in (n, n - 1, n + 1):
                if L < 2 or L not in vocab or L > tier.max_word_len:
                    continue
                use = slots
                if L < n:
                    use = sorted(sorted(slots, key=lambda p: (-p.cls, -p.accent))[:L], key=lambda p: p.t)
                elif L > n:
                    if extended is None:
                        continue
                    use = extended
                pool = vocab[L]
                sample = pool if len(pool) <= 40 else rng.sample(pool, 40)
                for w in sample:
                    cands.append((_score_word(w, use, cell, recent, tier, rng), w, use))
            if not cands:
                out.append((cell, None, []))
                continue
            cands.sort(key=lambda c: -c[0])
            score, w, use = cands[0]
            recent.append(w.text)
            out.append((cell, w, use))
    return out


# ── events ────────────────────────────────────────────────────────────────
def emit_events(fits, sk: SK.Skeleton, tier: Tier) -> list[M.CharEvent]:
    events: list[M.CharEvent] = []
    beat = 60.0 / sk.bpm
    word_id = 0
    sustain_by_t = {round(o, 2): d for o, d in sk.sustains}
    last_time = -1e9
    for cell, w, slots in fits:
        if w is None or not slots:
            continue
        word_id += 1
        n = min(w.n, len(slots))
        # if the word is longer than the slots (n-1 case never happens here) — handled in fit
        for i in range(n):
            p = slots[i]
            if p.t - last_time < tier.min_gap * 0.8:
                continue
            hold = 0.0
            if tier.allow_holds and i == n - 1:
                for o, d in sk.sustains:
                    if abs(o - p.t) <= beat * 0.5:
                        hold = d
                        break
            events.append(M.CharEvent(
                char=w.text[i], timestamp=float(SK.hit_time(p)), word_text=w.text, char_idx=i,
                beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                weight=p.metric, word_id=word_id, hold_duration=hold,
            ))
            last_time = p.t
        # rest marker after the word
        events.append(M.CharEvent(char="", timestamp=float(slots[n - 1].t) + 0.05, word_text="", char_idx=-1,
                                  beat_position=0.0, section=int(cell.bar // 4), is_rest=True))
    # words whose letters got dropped by spacing would be truncated: drop those words entirely
    by_word: dict[int, list[M.CharEvent]] = {}
    for e in events:
        if not e.is_rest:
            by_word.setdefault(e.word_id, []).append(e)
    bad = {wid for wid, evs in by_word.items() if len(evs) != len(evs[0].word_text)}
    events = [e for e in events if e.is_rest or e.word_id not in bad]
    # cap holds so the tail never reaches the next note
    chars = [e for e in events if not e.is_rest]
    for i, e in enumerate(chars):
        if e.hold_duration > 0 and i + 1 < len(chars):
            e.hold_duration = min(e.hold_duration, max(0.0, chars[i + 1].timestamp - e.timestamp - 0.2))
            if e.hold_duration < 0.1:
                e.hold_duration = 0.0
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    return events


def _space_sections(events: list[M.CharEvent], min_gap: float) -> list[M.CharEvent]:
    """Nothing is ever asked faster than the tier's gap.

    Inside a word the onset snapping can pull two letters together: the later one is nudged
    forward.  Where sections meet, the later note's whole word is dropped instead, so no word
    is left with a missing letter.
    """
    floor = min_gap * 0.75
    drop: set[int] = set()
    prev = None
    for e in events:
        if e.is_rest or not e.char or e.word_id in drop:
            continue
        if prev is not None and e.timestamp - prev.timestamp < floor:
            if e.word_id == prev.word_id:
                e.timestamp = prev.timestamp + floor
            else:
                drop.add(e.word_id)
                continue
        prev = e
    if drop:
        events = [e for e in events if e.is_rest or e.word_id not in drop]
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    return events


def _seed(song_path: str, words: list[str], difficulty: str) -> int:
    from . import song_fingerprint, GENERATOR_VERSION
    h = hashlib.sha1((song_fingerprint(song_path) + "|".join(sorted(words)) + difficulty + GENERATOR_VERSION).encode()).hexdigest()
    return int(h[:12], 16)


def chart_song(level: M.Level, song_path: str, progress=None) -> dict:
    tier = TIERS.get(level.difficulty, TIERS["classic"])
    expected = level.bpm
    sk = get_skeleton(song_path, expected, progress=progress)
    song = M.Song(sk.bpm, int(sk.duration), song_path, list(sk.beat_times))
    rng = random.Random(_seed(song_path, level.word_bank, level.difficulty + level.mode))
    if level.mode == "letters":
        from .letters import plan_letters, focus_letters
        letters = focus_letters(level.word_bank)
        events = plan_letters(sk, tier.key, letters, rng, section_vibes(sk))
        measure = 60.0 / sk.bpm * 4
        events = [e for e in events if e.timestamp <= sk.duration - measure]
        if events:
            events.append(M.CharEvent(char="", timestamp=events[-1].timestamp + measure, word_text="", char_idx=-1,
                                      beat_position=0.0, section=0, is_rest=True))
        vibes = section_vibes(sk)
        meta = {"tier": tier.key, "bars": sk.n_bars, "mode": "letters", "letters": letters,
                "notes": sum(1 for e in events if not e.is_rest), "duets": [],
                "bar_vibes": list(vibes), "bar_start": [float(t) for t in sk.bar_start],
                "bar_energy": [round(float(x), 3) for x in sk.bar_energy], "phrases": []}
        return {"song": song, "events": events, "lead_in": calculate_lead_in(sk.beat_times), "meta": meta, "skeleton": sk}
    vibes = section_vibes(sk)
    cells = build_cells(sk, tier, vibes)
    # duet sections: reserved spans the word fitter skips (plus one bar of grace before)
    from .duet import find_spans, plan_span
    from .sections import plan_phrases, plan_pattern, plan_anchor, add_holds
    from .letters import focus_letters
    from game.settings import load_settings
    duet_mode = load_settings().get("duets", "auto")       # duets are sections of Words, never a mode
    spans = find_spans(sk, tier.key, "off" if duet_mode == "off" else "auto")
    beat = 60.0 / sk.bpm
    reserved = [(s.t0 - 4 * beat, s.t1) for s in spans]
    # sections: pattern builds and anchor holds take whole phrases away from the word fitter
    phrases = plan_phrases(sk, tier.key, vibes, rng, reserved)
    special = [ph for ph in phrases if ph.kind != "words"]
    reserved += [(ph.t0, ph.t1) for ph in special]
    cells = [c for c in cells if not any(c.t1 > r0 and c.t0 < r1 for r0, r1 in reserved)]
    vocab = build_vocab(level.word_bank, use_pool=True)
    fits = fit_words(cells, vocab, tier, rng)
    events = emit_events(fits, sk, tier)
    next_word_id = max([e.word_id for e in events if not e.is_rest] + [0]) + 1
    for s in spans:
        d_events = plan_span(sk, s, tier.key, rng, next_word_id)
        next_word_id = max([e.word_id for e in d_events if not e.is_rest] + [next_word_id]) + 1
        events.extend(d_events)
    focus = focus_letters(level.word_bank)
    for ph in special:
        if ph.kind == "pattern":
            p_events = plan_pattern(sk, ph, tier.key, focus, rng, next_word_id, vibes, tier.min_gap, tier.finest)
        else:
            p_events = plan_anchor(sk, ph, tier, focus, rng, next_word_id, vocab, vibes,
                                   fit_words, emit_events, build_cells)
        if not p_events:
            ph.kind = "words"          # nothing fit: the phrase simply rests
            continue
        next_word_id = max([e.word_id for e in p_events if not e.is_rest] + [next_word_id]) + 1
        events.extend(p_events)
    add_holds(events, tier.key, sk, vibes, rng)
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    events = _space_sections(events, tier.min_gap)
    # trim the last bar and pad a rest
    measure = 60.0 / sk.bpm * 4
    cutoff = sk.duration - measure
    events = [e for e in events if e.timestamp <= cutoff]
    if events:
        last = max(e.timestamp for e in events)
        events.append(M.CharEvent(char="", timestamp=last + measure, word_text="", char_idx=-1,
                                  beat_position=0.0, section=0, is_rest=True))
    lead_in = calculate_lead_in(sk.beat_times)
    n_words = len({e.word_id for e in events if not e.is_rest})
    meta = {"tier": tier.key, "bars": sk.n_bars, "cells": len(cells), "words": n_words,
            "notes": sum(1 for e in events if not e.is_rest),
            "holds": sum(1 for e in events if not e.is_rest and e.hold_duration > 0),
            "vibes": {v: vibes.count(v) for v in set(vibes)},
            "bar_vibes": list(vibes), "bar_start": [float(t) for t in sk.bar_start],
            "bar_energy": [round(float(x), 3) for x in sk.bar_energy],
            "phrases": [[ph.t0, ph.t1, ph.kind, ph.bar0, ph.bar1] for ph in phrases],
            "duets": [[s.t0, s.t1, s.shape, s.bar0, s.bar1] for s in spans]}
    return {"song": song, "events": events, "lead_in": lead_in, "meta": meta, "skeleton": sk}
