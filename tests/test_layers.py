"""Layers and tiers: the phrase planner's rules, Easy/Hard as readings of Normal, grace notes."""
from __future__ import annotations

import math
import random

import numpy as np

from charting import skeleton as SK
from charting.layers import plan_layers, score_layer
from game import models as M
from game.rhythm import RhythmManager


def _song(n_bars=24, bpm=120.0, lead_bars=(), bass_bars=()):
    """Sixteenth points: the lead sings eighths in ``lead_bars``, a bass riff plays a repeating
    syncopated figure in ``bass_bars``, kicks on every beat throughout."""
    beat = 60.0 / bpm
    pts, bar_start = [], []
    riff = {0, 3, 6, 10, 12}                     # a figure with off-beat notes, the same every bar
    for b in range(n_bars):
        bar_start.append(b * 4 * beat)
        for bt in range(4):
            for sub in range(4):
                col = bt * 4 + sub
                t = (b * 4 + bt) * beat + sub * beat / 4
                kick = 0.9 if sub == 0 else 0.05
                lead = 0.8 if (b in lead_bars and sub in (0, 2)) else 0.05
                bass = 0.85 if (b in bass_bars and col in riff) else 0.05
                mask = 0
                for i, v in enumerate((lead, bass, kick, 0.05, 0.05)):
                    if v > 0.1:
                        mask |= 1 << i
                p = SK.Point(t, b, bt, sub, kick, 0.05, 0.05, lead, max(kick, lead, bass), 1.0, 0.5,
                             SK.MUST if sub == 0 else SK.MAY, "kick", True, -1.0, -1.0, False, bass, mask)
                pts.append(p)
    beat_times = [i * beat for i in range(n_bars * 4 + 1)]
    energy = [0.5] * n_bars
    vocal = [0.8 if b in lead_bars else 0.05 for b in range(n_bars)]
    return SK.Skeleton(bpm, beat_times[-1], beat_times, pts, energy, vocal, bar_start)


def test_score_layer_prefers_a_repeating_syncopated_figure():
    flat = np.zeros((4, 16)); flat[:, [0, 4, 8, 12]] = 0.9          # four on the floor
    riff = np.zeros((4, 16)); riff[:, [0, 3, 6, 10, 12]] = 0.9       # a figure with off-beats
    noise = np.zeros((4, 16))
    for b in range(4):
        noise[b, [b, b + 5, b + 9]] = 0.9                            # different every bar
    assert score_layer(riff)["catch"] > score_layer(flat)["catch"] > 0
    assert score_layer(riff)["catch"] > score_layer(noise)["catch"]


def test_melody_leads_and_a_riff_takes_a_phrase_between_melody_phrases():
    lead = set(range(0, 24))
    bass = set(range(8, 12)) | set(range(16, 20))
    sk = _song(lead_bars=lead, bass_bars=bass)
    plans = plan_layers(sk, "classic")
    assert [p.primary for p in plans[:2]] == ["lead", "lead"]
    alt = [p for p in plans if p.mode == "alt"]
    assert alt and all(p.primary == "bass" and p.secondary == "lead" for p in alt)
    # never two riff phrases back to back on Normal
    modes = [p.mode for p in plans]
    assert all(not (a == "alt" and b == "alt") for a, b in zip(modes, modes[1:]))


def test_no_melody_means_the_busiest_part_carries_the_phrase():
    sk = _song(lead_bars=(), bass_bars=set(range(0, 24)))
    plans = plan_layers(sk, "classic")
    assert all(p.primary in ("bass", "kick") for p in plans)


def test_easy_and_hard_are_readings_of_normal():
    from charting.engine import TIERS, tier_for_bpm, build_cells, fit_words, emit_events, section_vibes
    from charting.words import build_vocab
    sk = _song(lead_bars=set(range(0, 24)), bass_bars=set(range(8, 12)))
    vibes = section_vibes(sk)
    vocab = build_vocab(["cat", "moon", "garden", "planet"], use_pool=True)
    times = {}
    for key in ("journey", "classic", "master"):
        tier = tier_for_bpm(TIERS[key], sk.bpm)
        cells = build_cells(sk, tier, vibes)
        ev = emit_events(fit_words(cells, vocab, tier, random.Random(1)), sk, tier)
        times[key] = sorted(round(e.timestamp, 3) for e in ev if not e.is_rest)
    n_e, n_n, n_h = len(times["journey"]), len(times["classic"]), len(times["master"])
    assert n_e < n_n <= n_h
    normal = set(times["classic"])
    # Easy's notes are Normal's notes (fewer of them); Hard keeps nearly all of Normal's
    assert sum(t in normal for t in times["journey"]) >= 0.85 * n_e
    hard = set(times["master"])
    assert sum(t in hard for t in times["classic"]) >= 0.85 * n_n


def test_grace_notes_only_on_hard_and_demon_and_ahead_of_their_note():
    from charting.engine import TIERS, tier_for_bpm, build_cells, fit_words, emit_events, section_vibes, add_graces
    from charting.layers import plan_layers
    from charting.words import build_vocab
    sk = _song(lead_bars=set(range(0, 24)), bass_bars=set(range(0, 24)))
    vibes = section_vibes(sk)
    vocab = build_vocab(["cat", "moon", "garden", "planet"], use_pool=True)
    for key, expect in (("classic", 0), ("master", 1), ("demon", 1)):
        tier = tier_for_bpm(TIERS[key], sk.bpm)
        plans = plan_layers(sk, key)
        ev = emit_events(fit_words(build_cells(sk, tier, vibes, plans), vocab, tier, random.Random(1)), sk, tier)
        n = add_graces(ev, sk, tier, plans)
        assert (n > 0) == bool(expect), key
        graces = [e for e in ev if e.section_kind == "grace"]
        chars = [e for e in ev if not e.is_rest]
        for g in graces:
            main = next(e for e in chars if e is not g and e.word_id == g.word_id and e.char_idx == g.char_idx)
            assert g.char == main.char and 0.07 - 1e-6 <= main.timestamp - g.timestamp <= 0.15 + 1e-6


# ── the judgment core ─────────────────────────────────────────────────────
def _ev(char, t, word, idx, **kw):
    return M.CharEvent(char=char, timestamp=t, word_text=word, char_idx=idx, beat_position=0.0, section=0,
                       word_id=kw.pop("word_id", 1), **kw)


def _grace_chart():
    return [
        _ev("c", 0.90, "cat", 0, section_kind="grace"),
        _ev("c", 1.00, "cat", 0), _ev("a", 1.40, "cat", 1), _ev("t", 1.80, "cat", 2),
        M.CharEvent(char="", timestamp=1.9, word_text="", char_idx=-1, beat_position=0.0, section=0, is_rest=True),
    ]


def _rm(chart):
    now = [0.0]
    rm = RhythmManager(chart, 120.0, lead_in=0.0, timing_scale=1.0, clock=lambda: now[0])
    return rm, now


def test_grace_is_a_quick_double_and_the_word_completes_on_the_main_note():
    rm, now = _rm(_grace_chart())
    now[0] = 0.91
    rm.update()
    r = rm.check_input("c")
    assert r["hit"] and not r["is_word_complete"]
    now[0] = 1.0
    rm.update()
    assert rm.check_input("c")["hit"]
    now[0] = 1.4
    rm.update()
    rm.check_input("a")
    now[0] = 1.8
    rm.update()
    r = rm.check_input("t")
    assert r["hit"] and r["is_word_complete"]
    assert rm.miss_count == 0 and rm.combo == 4
    # the main note kept its full window: wider than the grace's
    assert rm.ok_window_for(rm.beat_map[1]) > rm.ok_window_for(rm.beat_map[0])


def test_skipping_the_grace_costs_one_miss_and_the_main_note_still_lands():
    rm, now = _rm(_grace_chart())
    now[0] = 1.0
    missed = rm.update()
    assert [e.section_kind for e in missed] == ["grace"]
    r = rm.check_input("c")
    assert r["hit"] and r["judgment"] == "perfect"
    assert rm.miss_count == 1
