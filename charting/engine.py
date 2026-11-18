"""
Skeleton & Cells — the chart generator.

Where can a note go?  The skeleton answers (a property of the audio).  Which
layer does a phrase follow?  ``charting.layers`` answers: the melody for most
of a song, a catchy drum or bass figure for a phrase now and then, both at
once where they are sparse.  Which whole word fits this rhythm cell?  The
fitter answers, per cell, with the word pool and the vibe of the section.

Normal is the reference chart, shaped like Keyboard Warrior's (read off its
reels): a bar-long cell holds one word whose letters sit on the layer's
onsets, one per eighth where the part is busy, and the next word follows at
once — the rests are where the music rests.  The other tiers are read off
Normal rather than being their own charts:

  * Easy keeps the strongest two thirds of Normal's notes (the same times,
    fewer of them) and a wider gap
  * Hard keeps every Normal note and adds: the secondary layer where the two
    parts are both sparse, sixteenths under a slow enough beat, and grace
    notes — a small note tied to a main one, played as a quick double
  * Demon is Hard with more of each

Everything is seeded, so the same song + words + difficulty gives the same
chart on every machine.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
from dataclasses import dataclass, replace

from game import constants as C
from game import models as M
from game.rhythm import calculate_lead_in
from . import skeleton as SK
from .layers import LayerPlan, plan_layers, plan_for_bar, COMBINE
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


# A tier's ceiling in letters per second, whatever the tempo.  Keyboard Warrior's Expert charts
# run 1.4–3.9 notes a second (median gap: an eighth); Normal is allowed that range, Easy less,
# Hard a little more.  The ceiling caps every cell, the gap is raised to 0.7 / ceiling, and
# sixteenths are only taken when the beat is slow enough for them to be typed.
MAX_LPS = {"journey": 2.2, "classic": 3.8, "master": 4.2, "demon": 4.6}
SIXTEENTHS_BELOW_BPM = {"master": 130.0, "demon": 150.0}      # finest = 1 only under these tempos
THIN_SHARE = {"journey": 0.75}                                # Easy keeps this share of Normal's notes
EXTRA_PER_BAR = {"master": 2, "demon": 4}                     # more primary-layer notes a bar than Normal
# grace notes: (max per bar, min beats between two), a small note a sixteenth before a main one
GRACE = {"master": (1, 2.0), "demon": (2, 1.0)}
GRACE_OFFSET = (0.07, 0.15)                                   # seconds before the main note


def tier_for_bpm(tier: "Tier", bpm: float) -> "Tier":
    """The tier with its gap and subdivision fitted to the song's tempo."""
    ceiling = MAX_LPS[tier.key]
    gap = max(tier.min_gap, 0.6 / ceiling)
    finest = tier.finest
    if finest == 1 and bpm > SIXTEENTHS_BELOW_BPM.get(tier.key, 1e9):
        finest = 2
    return replace(tier, min_gap=gap, finest=finest)


# One word a bar, its letters on the layer's onsets, the next word right after: a cell is
# (length, playable part, cap).  The playable part leaves the last eighth of the cell as the
# word boundary; a quiet stretch (sustain) gets a two-bar cell.  Every tier reads these same
# cells — Easy thins the result, Hard and Demon add to it.
NORMAL_CELLS = {"burst": (4, 3.6, 8), "drive": (4, 3.6, 8), "groove": (4, 3.6, 7), "sustain": (8, 7.5, 8)}
TIERS = {
    "journey": Tier("journey", 0.26, 2, NORMAL_CELLS, 6, True, (2, 3), 1.0),
    "classic": Tier("classic", 0.17, 2, NORMAL_CELLS, 8, True, (2, 3, 4), 1.0),
    "master":  Tier("master", 0.15, 1, NORMAL_CELLS, 9, True, (2, 3, 4), 1.0),
    "demon":   Tier("demon", 0.12, 1, NORMAL_CELLS, 9, True, (2, 3, 4), 1.0),
}


# ── skeleton cache ────────────────────────────────────────────────────────
SKELETON_VERSION = "v10"     # bump when build_skeleton's output changes; older files are pruned


def _skeleton_cache_path(song_path: str, expected_bpm: int | None) -> str:
    from . import _cache_dir, song_fingerprint
    d = os.path.join(_cache_dir(), "skeletons")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{song_fingerprint(song_path)}_{expected_bpm or 'auto'}_{SKELETON_VERSION}.json")


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
MELODIC_REST_BELOW = 0.30    # a lead cell whose loudest tune onset is under this share of the song's p90 rests


@dataclass
class Cell:
    t0: float
    t1: float
    bar: int
    vibe: str
    slots: list[SK.Point]
    cand: list[SK.Point]      # every eligible point of the primary layer (for extending by one)
    layer: str = "lead"       # the primary layer the cell follows
    slot_layer: dict = None   # id(point) -> layer each slot was taken from
    mode: str = "solo"

    def layer_of(self, p: SK.Point) -> str:
        return (self.slot_layer or {}).get(id(p), self.layer)


def _thin(slots: list[SK.Point], layer_of, share: float, min_gap: float) -> list[SK.Point]:
    """Easy: the strongest ``share`` of the slots, never closer than ``min_gap``, in time order."""
    if not slots:
        return slots
    keep_n = max(1, int(math.ceil(len(slots) * share)))
    top = max(p.layer(layer_of(p)) for p in slots) or 1e-6
    order = sorted(slots, key=lambda p: (-SK.layer_score(p, layer_of(p), p.layer(layer_of(p)) / top), p.t))
    kept: list[SK.Point] = []
    for p in order:
        if len(kept) >= keep_n:
            break
        if all(abs(p.t - q.t) >= min_gap for q in kept):
            kept.append(p)
    return sorted(kept, key=lambda p: p.t)


def _cap(slots: list[SK.Point], layer_of, n: int) -> list[SK.Point]:
    """The strongest ``n`` of the slots, in time order."""
    if len(slots) <= n:
        return slots
    top = max(p.layer(layer_of(p)) for p in slots) or 1e-6
    order = sorted(slots, key=lambda p: (-SK.layer_score(p, layer_of(p), p.layer(layer_of(p)) / top), p.t))
    return sorted(order[:n], key=lambda p: p.t)


def build_cells(sk: SK.Skeleton, tier: Tier, vibes: list[str], plans: list[LayerPlan] | None = None) -> list[Cell]:
    """Cut the song into cells by vibe; in each, the slots are the onsets of the phrase's layer.

    The selection is Normal's, whatever the tier: Easy thins it, Hard and Demon extend it (the
    secondary layer in a combined phrase, finer subdivisions, more of the primary layer)."""
    if plans is None:
        plans = plan_layers(sk, tier.key)
    normal = tier_for_bpm(TIERS["classic"], sk.bpm)
    cells: list[Cell] = []
    beat = 60.0 / sk.bpm
    b = 0
    n = sk.n_bars
    t_cursor = sk.bar_start[0] if sk.bar_start else 0.0
    vv = sorted(p.vocal for p in sk.points if p.layer_peak("lead") and p.vocal >= 0.28) or [1.0]
    lead_p90 = vv[int(len(vv) * 0.9)] or 1.0
    combine = COMBINE.get(tier.key)
    while b < n:
        vibe = vibes[b]
        cell_beats, play_beats, k = tier.cells[vibe]
        if cell_beats < 4 and cell_beats * beat < tier.short_cell_min_s:
            cell_beats, play_beats, k = tier.cells["drive"]
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
        plan = plan_for_bar(plans, b)
        primary = plan.primary if plan else "lead"
        secondary = plan.secondary if plan else None
        mode = plan.mode if plan else "solo"
        bars = max(1.0, (t1 - t0) / (4 * beat))
        # a tune that goes quiet is a rest, not a cue to fall back on the drums — unless the
        # phrase combines a second part, which then carries the cell alone
        if primary == "lead" and pts and max(p.vocal for p in pts) < MELODIC_REST_BELOW * lead_p90:
            if mode == "combined" and secondary:
                primary, secondary, mode = secondary, None, "solo"
            else:
                cells.append(Cell(t0, t1, b, vibe, [], [], "lead", {}, "rest"))
                b, t_cursor = next_b, next_t
                if next_t <= t0 + 1e-6:
                    b += 1
                    t_cursor = sk.bar_start[b] if b < n else sk.beat_times[-1]
                continue
        # Normal's notes: the primary layer at Normal's gap and grid
        k_norm = min(k, max(1, int(math.ceil(MAX_LPS["classic"] * (play_end - t0)))))
        slots, cand = SK.select_layer_slots(pts, primary, k_norm, normal.min_gap, normal.finest)
        slot_layer = {id(p): primary for p in slots}
        cap_tier = max(1, int(math.ceil(MAX_LPS[tier.key] * (play_end - t0))))
        if mode == "combined" and secondary and combine is not None and slots:
            room = min(int(math.ceil(combine[1] * bars)), int(math.ceil(combine[2] * bars)) - len(slots), cap_tier - len(slots))
            extra, _ = SK.select_layer_slots(pts, secondary, room, tier.min_gap, tier.finest, taken=slots)
            for p in extra:
                slot_layer[id(p)] = secondary
            slots = sorted(slots + extra, key=lambda p: p.t)
        layer_of = lambda p, sl=slot_layer, pr=primary: sl.get(id(p), pr)
        if tier.key in THIN_SHARE:
            slots = _thin(slots, layer_of, THIN_SHARE[tier.key], tier.min_gap)
        elif tier.key in EXTRA_PER_BAR and slots:
            want = len(slots) + int(EXTRA_PER_BAR[tier.key] * bars)
            more, _ = SK.select_layer_slots(pts, primary, want - len(slots), tier.min_gap, tier.finest, taken=slots)
            for p in more:
                slot_layer[id(p)] = primary
            slots = sorted(slots + more, key=lambda p: p.t)
        slots = _cap(slots, layer_of, cap_tier)
        cells.append(Cell(t0, t1, b, vibe, slots, cand, primary, slot_layer, mode))
        b, t_cursor = next_b, next_t
        if next_t <= t0 + 1e-6:      # safety
            b += 1
            t_cursor = sk.bar_start[b] if b < n else sk.beat_times[-1]
    return cells


# ── fitting ───────────────────────────────────────────────────────────────
def _score_word(w: WordInfo, slots: list[SK.Point], cell: Cell, recent: list[str], tier: Tier, rng: random.Random) -> float:
    n = len(slots)
    s = 0.0
    # the word's letters *are* the notes: an exact fit outranks any other bonus; one letter
    # more takes a real extra onset, one fewer drops a note the ear expects
    if w.n == n:
        s += 4.0
    elif w.n == n + 1:
        s += 1.0
    elif w.n == n - 1:
        s += 0.4
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
    layer = cell.layer
    top = max(p.layer(layer) for p in cell.cand) or 1e-6
    best = None
    for p in sorted(cell.cand, key=lambda q: -SK.layer_score(q, layer, q.layer(layer) / top)):
        if id(p) in used:
            continue
        if all(abs(p.t - q.t) >= tier.min_gap for q in slots):
            best = p
            break
    if best is None:
        return None
    if cell.slot_layer is not None:
        cell.slot_layer[id(best)] = layer
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
    last_time = -1e9
    for cell, w, slots in fits:
        if w is None or not slots:
            continue
        word_id += 1
        n = min(w.n, len(slots))
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
                char=w.text[i], timestamp=float(SK.hit_time(p, cell.layer_of(p))), word_text=w.text, char_idx=i,
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
    is left with a missing letter.  A grace note and its main note are one gesture and are
    left alone.
    """
    floor = min_gap * 0.75
    drop: set[int] = set()
    prev = None
    for e in events:
        if e.is_rest or not e.char or e.word_id in drop:
            continue
        if e.section_kind == "grace" or (prev is not None and prev.section_kind == "grace"):
            prev = e
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


# ── grace notes ───────────────────────────────────────────────────────────
def add_graces(events: list[M.CharEvent], sk: SK.Skeleton, tier: Tier, plans: list[LayerPlan]) -> int:
    """Hard and Demon: a small note a sixteenth before a main note, typed as a quick double.

    A grace is only added where the audio has a pickup — an onset of one of the phrase's layers
    (or a clear full-mix onset) on the sixteenth before the note — and where there is room: no
    other note inside the tier's gap before it, at most ``GRACE`` per bar, a hold or a section
    note never.  Returns how many were added.
    """
    rule = GRACE.get(tier.key)
    if rule is None or not events:
        return 0
    max_per_bar, min_beats = rule
    beat = 60.0 / sk.bpm
    sixteenth = beat / 4
    offset = min(GRACE_OFFSET[1], sixteenth)
    if offset < GRACE_OFFSET[0]:
        return 0
    pts = sk.points
    chars = sorted((e for e in events if not e.is_rest and e.char), key=lambda e: e.timestamp)
    per_bar: dict[int, int] = {}
    last_grace_t = -1e9
    added: list[M.CharEvent] = []
    for i, e in enumerate(chars):
        if e.section_kind not in ("", "letters") or e.hold_duration > 0:
            continue
        bar = int(e.beat_position // 4)
        if per_bar.get(bar, 0) >= max_per_bar or e.timestamp - last_grace_t < min_beats * beat:
            continue
        idx = int(round(e.beat_position * 4))
        if idx - 1 < 0 or idx >= len(pts) or pts[idx].bar != bar:
            continue
        q = pts[idx - 1]
        plan = plan_for_bar(plans, bar)
        layers = plan.layers() if plan else ["lead"]
        pickup = any(q.layer_peak(l) and q.layer(l) >= 0.40 for l in layers) or (q.peak and q.full >= 0.6)
        if not pickup:
            continue
        g_t = e.timestamp - offset
        prev = chars[i - 1] if i > 0 else None
        # the note before may sit closer than the tier's gap (a flam after an eighth is the point),
        # but never so close that three presses blur into one
        if prev is not None and g_t - prev.timestamp < max(0.08, 0.55 * tier.min_gap):
            continue
        g = e.copy()
        g.timestamp = float(g_t)
        g.section_kind = "grace"
        g.hold_duration = 0.0
        g.weight = 0
        g.hit = False
        added.append(g)
        per_bar[bar] = per_bar.get(bar, 0) + 1
        last_grace_t = e.timestamp
    events.extend(added)
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    return len(added)


def _seed(song_path: str, words: list[str], difficulty: str) -> int:
    from . import song_fingerprint, GENERATOR_VERSION
    h = hashlib.sha1((song_fingerprint(song_path) + "|".join(sorted(words)) + difficulty + GENERATOR_VERSION).encode()).hexdigest()
    return int(h[:12], 16)


def _layers_meta(plans: list[LayerPlan]) -> list:
    return [[round(pl.t0, 3), round(pl.t1, 3), pl.primary, pl.secondary or "", pl.mode] for pl in plans]


def chart_song(level: M.Level, song_path: str, progress=None) -> dict:
    expected = level.bpm
    sk = get_skeleton(song_path, expected, progress=progress)
    tier = tier_for_bpm(TIERS.get(level.difficulty, TIERS["classic"]), sk.bpm)
    song = M.Song(sk.bpm, int(sk.duration), song_path, list(sk.beat_times))
    rng = random.Random(_seed(song_path, level.word_bank, level.difficulty + level.mode))
    vibes = section_vibes(sk)
    plans = plan_layers(sk, tier.key)
    if level.mode == "letters":
        from .letters import plan_letters, focus_letters
        letters = focus_letters(level.word_bank)
        events = plan_letters(sk, tier, letters, rng, vibes, plans)
        measure = 60.0 / sk.bpm * 4
        events = [e for e in events if e.timestamp <= sk.duration - measure]
        n_graces = add_graces(events, sk, tier, plans)
        if events:
            events.append(M.CharEvent(char="", timestamp=events[-1].timestamp + measure, word_text="", char_idx=-1,
                                      beat_position=0.0, section=0, is_rest=True))
        meta = {"tier": tier.key, "bars": sk.n_bars, "mode": "letters", "letters": letters,
                "notes": sum(1 for e in events if not e.is_rest), "graces": n_graces, "duets": [],
                "bar_vibes": list(vibes), "bar_start": [float(t) for t in sk.bar_start],
                "bar_energy": [round(float(x), 3) for x in sk.bar_energy], "phrases": [],
                "layers": _layers_meta(plans)}
        return {"song": song, "events": events, "lead_in": calculate_lead_in(sk.beat_times), "meta": meta, "skeleton": sk}
    cells = build_cells(sk, tier, vibes, plans)
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
                                   fit_words, emit_events, lambda sk_, tier_, vibes_: build_cells(sk_, tier_, vibes_, plans))
        if not p_events:
            ph.kind = "words"          # nothing fit: the phrase simply rests
            continue
        next_word_id = max([e.word_id for e in p_events if not e.is_rest] + [next_word_id]) + 1
        events.extend(p_events)
    add_holds(events, tier.key, sk, vibes, rng)
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    events = _space_sections(events, tier.min_gap)
    n_graces = add_graces(events, sk, tier, plans)
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
            "graces": n_graces,
            "vibes": {v: vibes.count(v) for v in set(vibes)},
            "bar_vibes": list(vibes), "bar_start": [float(t) for t in sk.bar_start],
            "bar_energy": [round(float(x), 3) for x in sk.bar_energy],
            "phrases": [[ph.t0, ph.t1, ph.kind, ph.bar0, ph.bar1,
                         {"holds": ph.extra.get("holds", []), "voices": ph.extra.get("voices", [])} if ph.kind == "anchor" else {}]
                        for ph in phrases],
            "layers": _layers_meta(plans),
            "duets": [[s.t0, s.t1, s.shape, s.bar0, s.bar1] for s in spans]}
    return {"song": song, "events": events, "lead_in": lead_in, "meta": meta, "skeleton": sk}
