"""Judgment core: windows, slips, too-early, holds, hit log, score."""
from game import models as M
from game.rhythm import RhythmManager


def _chart(letters="planet", start=1.0, gap=0.5):
    evs = []
    for i, ch in enumerate(letters):
        evs.append(M.CharEvent(char=ch, timestamp=start + i * gap, word_text=letters, char_idx=i,
                               beat_position=i, section=0, word_id=1))
    evs.append(M.CharEvent(char="", timestamp=start + len(letters) * gap, word_text="", char_idx=-1,
                           beat_position=0, section=0, is_rest=True))
    return evs


class Clock:
    def __init__(self, t=0.0):
        self.t = t
    def __call__(self):
        return self.t


def test_windows_are_fixed_ms_times_scale():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, timing_scale=1.4, clock=c)
    assert abs(rm.timing_windows["perfect"] - 0.105) < 1e-9
    assert abs(rm.timing_windows["ok"] - 0.315) < 1e-9


def test_perfect_good_ok_and_signed_offset():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    c.t = 1.02
    r = rm.check_input("p")
    assert r["hit"] and r["judgment"] == "perfect" and abs(r["offset"] - 0.02) < 1e-9
    c.t = 1.5 - 0.08
    r = rm.check_input("l")
    assert r["judgment"] == "good" and r["offset"] < 0
    c.t = 2.0 + 0.20
    r = rm.check_input("a")
    assert r["judgment"] == "ok"
    assert rm.combo == 3 and rm.max_combo == 3


def test_slip_never_consumes_or_breaks_combo():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    c.t = 1.0
    assert rm.check_input("p")["hit"]
    c.t = 1.5
    r = rm.check_input("x")
    assert r["judgment"] == "slip" and not r["hit"]
    assert rm.combo == 1 and rm.slip_count == 1
    assert rm.current_expected_char() == "l"
    assert rm.check_input("l")["hit"]


def test_too_early_does_not_register_a_miss():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    c.t = 0.5
    r = rm.check_input("p")
    assert r["judgment"] == "too_early" and rm.miss_count == 0
    c.t = 1.0
    assert rm.check_input("p")["hit"]


def test_update_registers_miss_once_window_closes_and_moves_on():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    c.t = 1.0 + 0.226
    missed = rm.update()
    assert [e.char for e in missed] == ["p"]
    assert rm.miss_count == 1 and rm.current_expected_char() == "l"


def test_hold_ignores_other_keys_and_completes_on_release():
    c = Clock()
    evs = _chart("go", start=1.0, gap=1.0)
    evs[0].hold_duration = 0.6
    rm = RhythmManager(evs, bpm=120, clock=c)
    c.t = 1.0
    r = rm.check_input("g")
    assert r["judgment"] == "hold_started"
    c.t = 1.2
    assert rm.check_input("o")["judgment"] == "ignored"
    assert rm.miss_count == 0
    c.t = 1.58
    r = rm.on_key_release("g")
    assert r["hit"] and r["judgment"] == "hold_perfect"
    c.t = 2.0
    assert rm.check_input("o")["hit"]


def test_hold_broken_registers_miss():
    c = Clock()
    evs = _chart("go", start=1.0, gap=1.0)
    evs[0].hold_duration = 0.6
    rm = RhythmManager(evs, bpm=120, clock=c)
    c.t = 1.0
    rm.check_input("g")
    c.t = 1.2
    r = rm.on_key_release("g")
    assert r["judgment"] == "hold_broken" and rm.miss_count == 1


def test_score_is_normalized_and_perfect_run_hits_the_cap():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    for i, ch in enumerate("planet"):
        c.t = 1.0 + i * 0.5
        assert rm.check_input(ch)["judgment"] == "perfect"
    assert rm.get_score() == 1_000_000
    assert rm.get_grade() == "SS" and rm.clean_words() == 1


def test_hit_log_has_every_judgment():
    c = Clock()
    rm = RhythmManager(_chart(), bpm=120, clock=c)
    c.t = 1.0
    rm.check_input("p")
    c.t = 1.5
    rm.check_input("q")
    c.t = 2.1   # l's window closed at 1.65; a's is still open
    rm.update()
    kinds = [h.judgment for h in rm.hits]
    assert kinds == ["perfect", "slip", "miss"]
    assert rm.hits[1].pressed == "q"


def test_copy_keeps_every_field():
    e = M.CharEvent("a", 1.0, "a", 0, 0.0, 0, repeat_group_id=3, repeat_iter=2, weight=4, lane=0, word_id=9)
    rm = RhythmManager([e], bpm=120, lead_in=0.5)
    c = rm.beat_map[0]
    assert (c.repeat_group_id, c.repeat_iter, c.weight, c.lane, c.word_id) == (3, 2, 4, 0, 9)
    assert abs(c.timestamp - 1.5) < 1e-9
