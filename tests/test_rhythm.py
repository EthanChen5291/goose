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


# --- window boundaries -------------------------------------------------------
# A note at timestamp 0 with no lead-in is the one place a press can land *exactly*
# on a window edge: `press - 0.0` is the press, with no rounding in between.  Every
# window comparison in the judgment core is inclusive of its edge, and the web port
# mirrors these three tests exactly (web/tests/rhythm.test.ts), because a tape of
# real presses can never reach a boundary to prove it.
import math


def _one_note(ch="a"):
    return [M.CharEvent(char=ch, timestamp=0.0, word_text=ch, char_idx=0,
                        beat_position=0, section=0, word_id=1)]


def test_window_edges_are_inclusive():
    c = Clock()
    rm = RhythmManager(_one_note(), bpm=120, clock=c)
    c.t = rm.timing_windows["perfect"]
    assert rm.check_input("a")["judgment"] == "perfect"


def test_just_past_an_edge_falls_to_the_next_window():
    for edge, expect in (("perfect", "good"), ("good", "ok")):
        c = Clock()
        rm = RhythmManager(_one_note(), bpm=120, clock=c)
        c.t = math.nextafter(rm.timing_windows[edge], 1.0)
        assert rm.check_input("a")["judgment"] == expect


def test_the_edges_are_symmetric_about_the_note():
    c = Clock()
    rm = RhythmManager(_one_note(), bpm=120, clock=c)
    c.t = -rm.timing_windows["good"]
    r = rm.check_input("a")
    assert r["judgment"] == "good" and r["offset"] < 0


def test_a_press_exactly_on_the_ok_edge_is_ok_not_too_early():
    c = Clock()
    rm = RhythmManager(_one_note(), bpm=120, clock=c)
    c.t = -rm.ok_window_for(rm.beat_map[0])
    assert rm.check_input("a")["judgment"] == "ok"


# ── chords: two anchors due together, one per hand ─────────────────────────
# The charting engine's spacing pass used to drop the second of the pair, so no
# chart ever contained a chord and none of this ran.  Both cores have always had
# the code; these pin the behaviour now that charts really produce them.
def _chord(t=1.0, dur=1.0, a="f", b="j"):
    from game import keyboard as KB
    evs = [M.CharEvent(char=c, timestamp=t, word_text=c, char_idx=0, beat_position=0, section=0,
                       word_id=i + 1, hold_duration=dur, section_kind="anchor", lane=KB.lane_of(c))
           for i, c in enumerate((a, b))]
    evs.append(M.CharEvent(char="", timestamp=t + dur + 0.5, word_text="", char_idx=-1,
                           beat_position=0, section=0, is_rest=True))
    return evs


def test_chord_may_be_pressed_in_either_order():
    c = Clock()
    rm = RhythmManager(_chord(), bpm=120, clock=c)
    c.t = 1.0
    assert rm.check_input("j")["judgment"] == "anchor_started"   # the later of the pair, first
    assert rm.check_input("f")["judgment"] == "anchor_started"
    assert len(rm._anchors) == 2                                  # both hands are down


def test_chord_does_not_clamp_its_partners_window():
    """Two notes at the same time would otherwise each shrink the other's window to nothing."""
    rm = RhythmManager(_chord(), bpm=120, clock=Clock())
    for e in rm.beat_map[:2]:
        assert rm.ok_window_for(e) == rm.timing_windows["ok"]


# ── holds: a bounce on the way down is not a release ───────────────────────
def _hold_chart(dur=1.0, t=1.0, ch="a"):
    return [
        M.CharEvent(char=ch, timestamp=t, word_text=ch, char_idx=0, beat_position=0,
                    section=0, word_id=1, hold_duration=dur),
        M.CharEvent(char="", timestamp=t + dur + 0.5, word_text="", char_idx=-1,
                    beat_position=0, section=0, is_rest=True),
    ]


def test_a_bounce_right_after_the_press_does_not_break_a_hold():
    c = Clock()
    rm = RhythmManager(_hold_chart(), bpm=120, clock=c)
    c.t = 1.0
    assert rm.check_input("a")["judgment"] == "hold_started"
    c.t = 1.05                                  # the key comes back up at once
    assert rm.on_key_release("a") == {}
    assert rm._active_hold is not None          # still holding
    c.t = 1.40                                  # a real release, and far too early
    assert rm.on_key_release("a")["judgment"] == "hold_broken"


def test_the_same_grace_covers_an_anchor():
    from game import keyboard as KB
    evs = _hold_chart(dur=1.5, ch="f")
    evs[0].section_kind = "anchor"
    evs[0].lane = KB.lane_of("f")
    c = Clock()
    rm = RhythmManager(evs, bpm=120, clock=c)
    c.t = 1.0
    assert rm.check_input("f")["judgment"] == "anchor_started"
    c.t = 1.06
    assert rm.on_key_release("f") == {}
    assert len(rm._anchors) == 1
