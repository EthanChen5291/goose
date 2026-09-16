"""
Duet sections: where the song's beat and tune trade phrases, the left hand
plays the beat and the right hand plays the tune, on single letters, no words.

Detection reads the skeleton's kick/snare and vocal/harmonic confirmations
per 4-bar phrase.  The planner turns a span into voice lines shaped by the
tier: Easy echoes (right hand copies the left on mirror keys), Fair trades
half-bars, Hard and Demon weave the hands on off-beats.  Two keys are never
due at once, so the judgment core is unchanged: every line is a pseudo-word.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from game import keyboard as KB
from game import models as M
from . import skeleton as SK

VOICE_BEAT, VOICE_TUNE = 0, 1

LETTER_SETS = {
    "journey": ("sdf", "jkl"),
    "classic": ("asdfg", "hjkl"),
    "master": ("asdfgwert", "hjkliuoy"),
    "demon": ("qwertasdfgzxcvb", "yuiophjklnm"),
}
SHAPES = {"journey": "echo", "classic": "trade", "master": "weave", "demon": "weave16"}
HANDOFF_GAP = {"journey": 2.0, "classic": 0.5, "master": 0.5, "demon": 0.25}     # beats
MIN_CROSS_GAP_S = {"journey": 0.5, "classic": 0.2, "master": 0.12, "demon": 0.08}


@dataclass
class DuetSpan:
    bar0: int
    bar1: int          # exclusive
    t0: float
    t1: float
    score: float
    shape: str


def find_spans(sk: SK.Skeleton, tier_key: str, mode: str = "auto") -> list[DuetSpan]:
    """Candidate duet spans from the skeleton. mode: auto | off | whole."""
    if mode == "off":
        return []
    n = sk.n_bars
    shape = SHAPES.get(tier_key, "trade")
    if mode == "whole":
        if n < 4:
            return []
        return [DuetSpan(0, n, sk.bar_start[0], sk.beat_times[-1], 1.0, shape)]
    if n < 40:
        return []
    beat_pts: dict[int, set] = {}
    tune_pts: dict[int, set] = {}
    for i, p in enumerate(sk.points):
        if max(p.kick, p.snare) >= 0.5:
            beat_pts.setdefault(p.bar, set()).add(i)
        if p.vocal >= 0.45:
            tune_pts.setdefault(p.bar, set()).add(i)
    phrases: list[tuple[int, float]] = []
    for b in range(16, n - 8 - 4, 4):
        pres_a = sum(1 for k in range(b, b + 4) if len(beat_pts.get(k, ())) >= 2) / 4
        pres_b = sum(1 for k in range(b, b + 4) if len(tune_pts.get(k, ())) >= 2) / 4
        a = set().union(*[beat_pts.get(k, set()) for k in range(b, b + 4)])
        t = set().union(*[tune_pts.get(k, set()) for k in range(b, b + 4)])
        union = len(a | t)
        overlap = len(a & t) / union if union else 1.0
        score = pres_a * pres_b * (1.0 - overlap)
        phrases.append((b, score))
    cands = [(b, s) for b, s in phrases if s >= 0.35]
    if not cands:
        return []
    # merge adjacent phrases into spans of 8–16 bars
    cands.sort()
    spans: list[list] = []
    for b, s in cands:
        if spans and b == spans[-1][1] and spans[-1][1] - spans[-1][0] < 16:
            spans[-1][1] = b + 4
            spans[-1][2] = max(spans[-1][2], s)
        else:
            spans.append([b, b + 4, s])
    spans = [s for s in spans if s[1] - s[0] >= 8]
    # caps by song length
    dur = sk.duration
    cap = 1 if dur < 150 else (2 if dur < 240 else 3)
    spans.sort(key=lambda s: -s[2])
    chosen: list[list] = []
    total = 0
    for s in spans:
        if len(chosen) >= cap:
            break
        if any(abs(s[0] - c[1]) < 8 and abs(c[0] - s[1]) < 8 for c in chosen):
            continue
        if total + (s[1] - s[0]) > n * 0.25:
            continue
        chosen.append(s)
        total += s[1] - s[0]
    chosen.sort()
    out = []
    for b0, b1, s in chosen:
        t0 = sk.bar_start[b0]
        t1 = sk.bar_start[b1] if b1 < n else sk.beat_times[-1]
        out.append(DuetSpan(b0, b1, t0, t1, s, shape))
    return out


# ── planning ──────────────────────────────────────────────────────────────
def _pick_letter(rng: random.Random, letters: str, prev: str | None, prev_t: float, t: float, first_of_line: bool) -> str:
    """A letter from the set: index finger on a line's first note, no same finger under 250 ms, no repeat on the spot."""
    pool = list(letters)
    if first_of_line:
        idx = [c for c in pool if KB.finger_of(c) in (3, 6)]
        if idx:
            pool = idx
    if prev is not None:
        if t - prev_t < 0.25:
            pool2 = [c for c in pool if KB.finger_of(c) != KB.finger_of(prev)]
            pool = pool2 or pool
        if t - prev_t < 0.4:
            pool2 = [c for c in pool if c != prev]
            pool = pool2 or pool
    return rng.choice(pool)


def _accents(sk: SK.Skeleton, t0: float, t1: float, voice: int, finest: int, min_gap: float, cap: int) -> list[SK.Point]:
    pts = sk.points_in(t0, t1)
    if voice == VOICE_BEAT:
        cand = [p for p in pts if p.cls >= SK.SHOULD and p.attack in ("kick", "snare", "full") and p.sub % finest == 0]
        if len(cand) < 2:
            cand = [p for p in pts if p.cls >= SK.MAY and p.sub % finest == 0]
    else:
        cand = [p for p in pts if p.cls >= SK.SHOULD and p.sub % finest == 0]
        if len(cand) < 2:
            cand = [p for p in pts if p.cls >= SK.MAY and p.sub % finest == 0]
    cand.sort(key=lambda p: (-p.cls, -p.accent, p.t))
    kept: list[SK.Point] = []
    for p in cand:
        if len(kept) >= cap:
            break
        if all(abs(p.t - q.t) >= min_gap for q in kept):
            kept.append(p)
    kept.sort(key=lambda p: p.t)
    return kept


def plan_span(sk: SK.Skeleton, span: DuetSpan, tier_key: str, rng: random.Random, word_id_start: int) -> list[M.CharEvent]:
    beat = 60.0 / sk.bpm
    left_set, right_set = LETTER_SETS.get(tier_key, LETTER_SETS["classic"])
    shape = span.shape
    cross_gap = MIN_CROSS_GAP_S.get(tier_key, 0.2)
    events: list[M.CharEvent] = []
    word_id = word_id_start
    line_id = 0
    prev_char: str | None = None
    prev_t = -1e9
    n_bars = span.bar1 - span.bar0

    def emit_line(voice: int, slots: list[SK.Point], letters: list[str]):
        nonlocal word_id, line_id, prev_char, prev_t
        if not slots:
            return
        word_id += 1
        line_id += 1
        text = "".join(letters)
        for i, (p, ch) in enumerate(zip(slots, letters)):
            events.append(M.CharEvent(char=ch, timestamp=float(SK.hit_time(p)), word_text=text, char_idx=i,
                                      beat_position=float(p.bar * 4 + p.beat + p.sub / 4), section=int(p.bar // 4),
                                      weight=p.metric, lane=KB.lane_of(ch), voice=voice, line_id=line_id,
                                      word_id=word_id, section_kind="duet"))
            prev_char, prev_t = ch, p.t
        events.append(M.CharEvent(char="", timestamp=float(slots[-1].t) + 0.05, word_text="", char_idx=-1,
                                  beat_position=0.0, section=int(slots[-1].bar // 4), is_rest=True, section_kind="duet"))

    if shape == "echo":
        # bar pairs: left plays bar k (beats only, ≤3, beat 4 silent), right echoes in bar k+1 on mirror keys
        for k in range(span.bar0, span.bar1 - 1, 2):
            t0 = sk.bar_start[k]
            t1 = sk.bar_start[k + 1] if k + 1 < sk.n_bars else sk.beat_times[-1]
            t2 = sk.bar_start[k + 2] if k + 2 < sk.n_bars else sk.beat_times[-1]
            call = [p for p in _accents(sk, t0, t1 - beat * 1.0, VOICE_BEAT, 4, 0.5, 2)]
            if not call:
                continue
            letters = []
            pc, pt = None, -1e9
            for i, p in enumerate(call):
                ch = _pick_letter(rng, left_set, pc, pt, p.t, i == 0)
                letters.append(ch)
                pc, pt = ch, p.t
            emit_line(VOICE_BEAT, call, letters)
            # echo: same rhythm one bar later, mirror keys
            echo = []
            for p in call:
                tt = p.t + (t1 - t0)
                q = min(sk.points_in(t1, t2), key=lambda z: abs(z.t - tt), default=None)
                if q is not None:
                    echo.append(q)
            emit_line(VOICE_TUNE, echo, [KB.MIRROR.get(c, "j") for c in letters])
    elif shape == "trade":
        for k in range(span.bar0, span.bar1):
            t0 = sk.bar_start[k]
            t1 = sk.bar_start[k + 1] if k + 1 < sk.n_bars else sk.beat_times[-1]
            mid = t0 + (t1 - t0) / 2
            gap = HANDOFF_GAP["classic"] * beat
            call = _accents(sk, t0, mid - gap * 0.5, VOICE_BEAT, 2, 0.24, 2)
            ans = _accents(sk, mid, t1 - gap * 0.5, VOICE_TUNE, 2, 0.24, 2)
            letters = []
            pc, pt = None, -1e9
            for i, p in enumerate(call):
                ch = _pick_letter(rng, left_set, pc, pt, p.t, i == 0)
                letters.append(ch)
                pc, pt = ch, p.t
            emit_line(VOICE_BEAT, call, letters)
            aletters = []
            for i, p in enumerate(ans):
                if i == 0 and letters and KB.MIRROR.get(letters[0], "").isalpha() and KB.MIRROR[letters[0]] in right_set:
                    ch = KB.MIRROR[letters[0]]
                else:
                    ch = _pick_letter(rng, right_set, pc, pt, p.t, i == 0)
                aletters.append(ch)
                pc, pt = ch, p.t
            emit_line(VOICE_TUNE, ans, aletters)
    else:
        finest = 2 if shape == "weave" else 1
        for k in range(span.bar0, span.bar1):
            t0 = sk.bar_start[k]
            t1 = sk.bar_start[k + 1] if k + 1 < sk.n_bars else sk.beat_times[-1]
            left_cap, right_cap = (4, 5) if shape == "weave16" else (3, 3)
            left = [p for p in _accents(sk, t0, t1, VOICE_BEAT, 4, 0.2, left_cap)]
            right_all = [p for p in _accents(sk, t0, t1, VOICE_TUNE, finest, 0.12, 8) if p.sub != 0]
            right = [p for p in right_all if all(abs(p.t - q.t) >= cross_gap for q in left)][:right_cap]
            letters = []
            pc, pt = None, -1e9
            for i, p in enumerate(left):
                ch = _pick_letter(rng, left_set, pc, pt, p.t, i == 0)
                letters.append(ch)
                pc, pt = ch, p.t
            emit_line(VOICE_BEAT, left, letters)
            rletters = []
            for i, p in enumerate(right):
                ch = _pick_letter(rng, right_set, pc, pt, p.t, i == 0)
                rletters.append(ch)
                pc, pt = ch, p.t
            emit_line(VOICE_TUNE, right, rletters)
    # sort and enforce the cross-hand gap globally (drop the later of any pair that is too close)
    notes = sorted([e for e in events if not e.is_rest], key=lambda e: e.timestamp)
    kept: list[M.CharEvent] = []
    for e in notes:
        if kept and e.timestamp - kept[-1].timestamp < cross_gap:
            continue
        kept.append(e)
    keep_ids = {id(e) for e in kept}
    events = [e for e in events if e.is_rest or id(e) in keep_ids]
    # a line that lost notes: fix its word_text / char_idx so it stays a whole pseudo-word
    by_line: dict[int, list[M.CharEvent]] = {}
    for e in events:
        if not e.is_rest:
            by_line.setdefault(e.word_id, []).append(e)
    for evs in by_line.values():
        evs.sort(key=lambda e: e.timestamp)
        text = "".join(e.char for e in evs)
        for i, e in enumerate(evs):
            e.word_text = text
            e.char_idx = i
    events.sort(key=lambda e: (e.timestamp, e.is_rest))
    return events
