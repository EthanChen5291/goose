"""Skeleton & Cells on a synthetic skeleton: whole words, no truncation, spacing, determinism."""
import random

from charting import skeleton as SK
from charting.engine import TIERS, build_cells, fit_words, emit_events, section_vibes
from charting.words import build_vocab, POOL


def _synthetic_skeleton(bars=16, bpm=120.0):
    beat = 60.0 / bpm
    beat_times = [i * beat for i in range(bars * 4 + 1)]
    pts = []
    rng = random.Random(0)
    for i in range(bars * 4):
        for sub in range(4):
            t = i * beat + sub * beat / 4
            bar, b = i // 4, i % 4
            w = SK._BEAT_W[b] * SK._SUB_W[sub]
            conf = 1.0 if sub == 0 else (0.7 if sub == 2 else rng.uniform(0.0, 0.5))
            a = w * conf ** 0.7
            cls = SK.MUST if a >= 0.55 else SK.SHOULD if a >= 0.32 else SK.MAY if a >= 0.14 else SK.NO
            pts.append(SK.Point(t, bar, b, sub, conf, conf * 0.5, 0.2, 0.3, conf, w, a, cls, "kick"))
    energy = [0.2 + 0.6 * ((b // 4) % 2) for b in range(bars)]
    return SK.Skeleton(bpm, bars * 4 * beat, beat_times, pts, energy, [0.3] * bars, [b * 4 * beat for b in range(bars)])


def test_pool_is_clean_and_large():
    assert len(POOL) > 800
    assert all(w.isalpha() and 2 <= len(w) <= 9 for w in POOL)


def test_words_are_whole_and_spaced():
    sk = _synthetic_skeleton()
    for key, tier in TIERS.items():
        vibes = section_vibes(sk)
        cells = build_cells(sk, tier, vibes)
        fits = fit_words(cells, build_vocab(["dream", "shadow", "echo"]), tier, random.Random(1))
        events = emit_events(fits, sk, tier)
        notes = [e for e in events if not e.is_rest]
        assert notes, key
        by_word = {}
        for e in notes:
            by_word.setdefault(e.word_id, []).append(e)
        for evs in by_word.values():
            assert len(evs) == len(evs[0].word_text), (key, evs[0].word_text)
            assert [e.char_idx for e in evs] == list(range(len(evs)))
            assert max(len(evs[0].word_text) for _ in [0]) <= tier.max_word_len
        gaps = [b.timestamp - a.timestamp for a, b in zip(notes, notes[1:])]
        assert min(gaps) >= tier.min_gap * 0.8 - 1e-6, key
        ts = [e.timestamp for e in notes]
        assert ts == sorted(ts)


def test_vibe_changes_word_length():
    sk = _synthetic_skeleton()
    tier = TIERS["classic"]
    vibes = section_vibes(sk)
    assert set(vibes) >= {"burst", "sustain"} or len(set(vibes)) >= 2
    cells = build_cells(sk, tier, vibes)
    burst = [len(c.slots) for c in cells if c.vibe == "burst"]
    sustain = [len(c.slots) for c in cells if c.vibe == "sustain"]
    if burst and sustain:
        assert sum(burst) / len(burst) < sum(sustain) / len(sustain)


def test_deterministic_for_same_seed():
    sk = _synthetic_skeleton()
    tier = TIERS["classic"]
    out = []
    for _ in range(2):
        fits = fit_words(build_cells(sk, tier, section_vibes(sk)), build_vocab(["dream"]), tier, random.Random(42))
        out.append([w.text for _, w, _ in fits if w])
    assert out[0] == out[1]
