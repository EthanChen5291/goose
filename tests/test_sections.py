"""Sections: the anchor track in the judgment core, and the planner's invariants."""
from __future__ import annotations

import random

import pytest

from game import keyboard as KB
from game import models as M
from game.rhythm import RhythmManager


def _ev(char, t, word=None, idx=0, **kw):
    return M.CharEvent(char=char, timestamp=t, word_text=word or char, char_idx=idx,
                       beat_position=0.0, section=0, word_id=kw.pop("word_id", 1), **kw)


def _anchor_chart():
    """An anchor on F at 1.0 s for 3 s, with right-hand letters typed under it."""
    return [
        _ev("f", 1.0, hold_duration=3.0, section_kind="anchor", word_id=1),
        _ev("j", 1.6, "jk", 0, word_id=2), _ev("k", 2.1, "jk", 1, word_id=2),
        M.CharEvent(char="", timestamp=2.2, word_text="", char_idx=-1, beat_position=0.0, section=0, is_rest=True),
        _ev("l", 2.8, word_id=3),
        _ev("a", 5.0, word_id=4),
    ]


def _rm(chart):
    now = [0.0]
    rm = RhythmManager(chart, 120.0, lead_in=0.0, timing_scale=1.0, clock=lambda: now[0])
    return rm, now


def test_anchor_starts_and_other_hand_is_judged_while_held():
    rm, now = _rm(_anchor_chart())
    now[0] = 1.0
    rm.update()
    r = rm.check_input("f")
    assert r["hit"] and r["judgment"] == "anchor_started"
    assert rm._anchor is not None and rm._active_hold is None
    # the right hand keeps playing while F is down
    now[0] = 1.62
    rm.update()
    r = rm.check_input("j")
    assert r["hit"] and r["judgment"] == "perfect"
    now[0] = 2.1
    rm.update()
    assert rm.check_input("k")["hit"]
    # key repeat on the held key is ignored, not a slip
    r = rm.check_input("f")
    assert r["judgment"] == "ignored"
    assert rm.slip_count == 0


def test_anchor_completes_by_time_and_counts_as_a_hold_hit():
    rm, now = _rm(_anchor_chart())
    now[0] = 1.0
    rm.update()
    rm.check_input("f")
    now[0] = 4.05
    rm.update()
    assert rm._anchor is None
    assert rm.last_anchor_result is not None and rm.last_anchor_result["hit"]
    assert rm.hold_perfect_hits == 1
    assert rm.miss_count == 3          # j, k and l were never pressed and timed out under the hold
    # releasing F afterwards is a plain no-op
    assert rm.on_key_release("f") == {}


def test_anchor_released_early_breaks_and_resets_combo():
    rm, now = _rm(_anchor_chart())
    now[0] = 1.0
    rm.update()
    rm.check_input("f")
    now[0] = 1.62
    rm.update()
    rm.check_input("j")
    assert rm.combo == 1
    now[0] = 2.0
    r = rm.on_key_release("f")
    assert r["judgment"] == "anchor_broken" and r.get("anchor")
    assert rm._anchor is None
    assert rm.combo == 0 and rm.miss_count == 1


def test_anchor_release_inside_grace_completes():
    rm, now = _rm(_anchor_chart())
    now[0] = 1.0
    rm.update()
    rm.check_input("f")
    now[0] = 3.75                      # 0.25 s early: inside the 12 % grace of a 3 s hold
    r = rm.on_key_release("f")
    assert r["hit"] and r["judgment"] == "hold_perfect" and r.get("anchor")


def test_missed_anchor_never_blocks_the_stream():
    rm, now = _rm(_anchor_chart())
    now[0] = 1.62
    missed = rm.update()               # F's window closed without a press
    assert [e.char for e in missed] == ["f"]
    assert rm.check_input("j")["hit"]


# ── the planner ────────────────────────────────────────────────────────────
def _fake_skeleton(n_bars=40, bpm=120.0, vocal=0.4):
    """A synthetic skeleton: four beats a bar, a hit on every eighth, energy rising then falling."""
    from charting import skeleton as SK
    beat = 60.0 / bpm
    pts, bar_start, energy, vocal_l = [], [], [], []
    for b in range(n_bars):
        bar_start.append(b * 4 * beat)
        e = 0.3 + 0.6 * (0.5 - 0.5 * __import__("math").cos(2 * 3.14159 * b / 16))
        energy.append(e)
        vocal_l.append(vocal)
        for bt in range(4):
            for sub in range(4):
                t = (b * 4 + bt) * beat + sub * beat / 4
                conf = 0.9 if sub == 0 else (0.6 if sub == 2 else 0.2)
                p = SK.Point(t, b, bt, sub, conf, conf * 0.8, 0.3, vocal, conf, 1.0, conf, SK.MUST if sub == 0 else (SK.SHOULD if sub == 2 else SK.NO),
                             "kick", True, -1.0)
                pts.append(p)
    beat_times = [i * beat for i in range(n_bars * 4 + 1)]
    return SK.Skeleton(bpm, beat_times[-1], beat_times, pts, energy, vocal_l, bar_start, sustains=[(bar_start[9], 2 * beat)])


def test_journey_has_no_patterns_or_anchors_and_others_do():
    from charting.engine import section_vibes
    from charting.sections import plan_phrases
    sk = _fake_skeleton()
    vibes = section_vibes(sk)
    rng = random.Random(1)
    kinds_j = {ph.kind for ph in plan_phrases(sk, "journey", vibes, rng)}
    assert kinds_j == {"words"}
    kinds_c = [ph.kind for ph in plan_phrases(sk, "classic", vibes, random.Random(1))]
    assert "pattern" in kinds_c or "anchor" in kinds_c
    # never two special phrases back to back on Fair
    for a, b in zip(kinds_c, kinds_c[1:]):
        assert not (a == "pattern" and b == "pattern")


def test_anchor_phrase_keeps_the_held_hand_free():
    from charting.engine import TIERS, section_vibes, build_cells, fit_words, emit_events
    from charting.sections import plan_phrases, plan_anchor
    from charting.words import build_vocab
    sk = _fake_skeleton()
    vibes = section_vibes(sk)
    rng = random.Random(3)
    phrases = plan_phrases(sk, "master", vibes, rng)
    anchors = [ph for ph in phrases if ph.kind == "anchor"]
    if not anchors:
        pytest.skip("the synthetic song produced no anchor phrase")
    vocab = build_vocab(["cat", "pink", "moon", "bed"], use_pool=True)
    ev = plan_anchor(sk, anchors[0], TIERS["master"], "asdfghjkl", rng, 100, vocab, vibes, fit_words, emit_events, build_cells)
    held = [e for e in ev if e.section_kind == "anchor"]
    assert held and all(e.hold_duration > 0 for e in held)
    for a in held:
        end = a.timestamp + a.hold_duration
        under = [e for e in ev if not e.is_rest and e is not a and a.timestamp <= e.timestamp < end]
        assert all(KB.hand_of(e.char) != KB.hand_of(a.char) for e in under)
        assert all(e.hold_duration == 0 for e in under)


def test_pattern_alternates_hands_on_fair():
    from charting.engine import section_vibes
    from charting.sections import plan_phrases, plan_pattern
    sk = _fake_skeleton()
    vibes = section_vibes(sk)
    rng = random.Random(5)
    phrases = plan_phrases(sk, "classic", vibes, rng)
    pats = [ph for ph in phrases if ph.kind == "pattern"]
    if not pats:
        pytest.skip("the synthetic song produced no pattern phrase")
    ev = [e for e in plan_pattern(sk, pats[0], "classic", "asdfghjkl", rng, 50, vibes, 0.24, 2) if not e.is_rest]
    assert len(ev) >= 4
    hands = [KB.hand_of(e.char) for e in ev]
    assert all(a != b for a, b in zip(hands, hands[1:]))
    gaps = [b.timestamp - a.timestamp for a, b in zip(ev, ev[1:])]
    assert min(gaps) >= 0.24 - 1e-6
