"""
RhythmManager — the judgment core.

One ordered stream of CharEvents, one clock, fixed-millisecond windows scaled
per tier, signed offsets, and four honest results for a press:

  hit          the expected key inside a window (perfect / good / ok)
  too_early    the expected key before the window: nothing happens, note stays live
  slip         a different key: never consumes the note, never breaks combo
  ignored      a press while a hold is active or the chart is finished

An **anchor** is a hold that runs *beside* the stream: one hand holds its
key while the other hand's notes are judged as usual.  Starting it is a
normal press on its note; releasing early breaks it (a miss); reaching its
end completes it.  It never blocks other input.

Misses are only ever registered by ``update()`` when a note's window closes,
or by ``on_key_release`` when a hold is dropped.  Every judgment appends a
``HitRecord`` so the typing coach and the replay have the whole story.

Score is normalized: 1,000,000 × (0.70 accuracy + 0.20 combo + 0.10 clean words).
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from . import constants as C
from . import models as M

JUDGMENT_VALUE = {'perfect': 1.0, 'good': 0.7, 'ok': 0.3, 'miss': 0.0}
BASE_WINDOWS_S = {'perfect': 0.075, 'good': 0.150, 'ok': 0.225}   # typing needs a finger, not just a tap
SCORE_MAX = 1_000_000


def calculate_lead_in(
    beat_times: list[float],
    min_seconds: float = C.LEAD_IN_MIN_SECONDS
) -> float:
    """Lead-in snapped to the first measure boundary at or after ``min_seconds``."""
    if len(beat_times) < C.BEATS_PER_MEASURE * 2:
        return min_seconds
    for i in range(0, len(beat_times), C.BEATS_PER_MEASURE):
        measure_time = beat_times[i]
        if measure_time >= min_seconds:
            return measure_time
    last_measure_idx = (len(beat_times) // C.BEATS_PER_MEASURE) * C.BEATS_PER_MEASURE
    if last_measure_idx < len(beat_times):
        return beat_times[last_measure_idx]
    return min_seconds


class RhythmManager:
    def __init__(
        self,
        beat_map: list[M.CharEvent],
        bpm: float,
        lead_in: float = 0.0,
        timing_scale: float = 1.0,
        clock: Optional[Callable[[], float]] = None,
        rush_bonus_per_perfect: int = 1500,
    ):
        self.bpm = bpm
        self.beat_duration = 60 / bpm if bpm > 0 else 0.5
        self.lead_in = lead_in
        self.timing_scale = timing_scale

        # Copy every field; timestamps become chart time (lead_in included).
        self.beat_map: list[M.CharEvent] = []
        for e in beat_map:
            c = e.copy()
            c.timestamp = e.timestamp + lead_in
            c.hit = False
            self.beat_map.append(c)

        # clock: chart seconds. Fallback keeps the old behaviour for tests.
        self._t0 = time.perf_counter()
        self._clock = clock if clock is not None else (lambda: time.perf_counter() - self._t0)
        self.start_time = self._t0   # legacy attribute, unused by new code

        self.char_event_idx = 0
        self.current_word_idx = 0
        self.last_word: Optional[str] = None

        self.combo = 0
        self.max_combo = 0
        self.perfect_hits = 0
        self.good_hits = 0
        self.ok_hits = 0
        self.hold_perfect_hits = 0
        self.hold_good_hits = 0
        self.hold_ok_hits = 0
        self.miss_count = 0
        self.slip_count = 0
        self.too_early_count = 0
        self.rush_bonus = 0
        self.rush_active = False

        self.playable_events = [e for e in self.beat_map if not e.is_rest and e.char]
        self.total_notes = len(self.playable_events)
        self._word_ids = {e.word_id for e in self.playable_events}
        self.total_words = len(self._word_ids) if self._word_ids else 0
        self._dirty_words: set[int] = set()     # word ids with a miss inside
        self._done_words: set[int] = set()

        self.hits: list[M.HitRecord] = []
        self._last_press_t: Optional[float] = None
        self.offsets_ms: list[float] = []

        # hold note tracking
        self._active_hold: Optional[M.CharEvent] = None
        self._hold_press_time: float = 0.0
        self._hold_judgment: str = 'ok'
        self._hold_release_grace = 0.12
        # A key that comes back up within this of going down is a fumble, not a
        # release: a bounce or a finger resettling should not break a hold the
        # player has only just started.  It is short enough that it can never
        # stand in for holding a note, since the shortest hold is about 0.35 s.
        self._hold_settle = 0.12
        # anchors: holds the other hand plays through — up to one per hand (a chord is two)
        self._anchors: list[M.CharEvent] = []
        self._anchor_press: dict[int, float] = {}      # id(event) → when it went down
        self._anchor_judgments: dict[int, str] = {}
        self._anchor_judgment: str = 'ok'                 # of the anchor started last
        self.anchor_results: list[dict] = []              # anchors that ended by time since last read

        self._setup_timing_windows()

    # ── setup ──────────────────────────────────────────────────────────────
    def _setup_timing_windows(self) -> None:
        """Fixed milliseconds × tier scale. Never a function of tempo."""
        s = self.timing_scale
        self.timing_windows = {k: v * s for k, v in BASE_WINDOWS_S.items()}
        self._note_ok_window: dict[int, float] = {}
        # per-note clamp: a window never reaches past the midpoint to a neighbour
        prev: Optional[M.CharEvent] = None
        for i, e in enumerate(self.beat_map):
            if e.is_rest or not e.char:
                continue
            w = self.timing_windows['ok']
            if prev is not None:
                gap = e.timestamp - prev.timestamp
                chord = e.section_kind == "anchor" and prev.section_kind == "anchor" and gap < 0.06
                if prev.section_kind == "grace":
                    # a grace note is the small note before its main note: it gets a tight window of
                    # its own and the main note keeps its full one (only the note after clamps it)
                    self._note_ok_window[id(prev)] = min(self._note_ok_window.get(id(prev), w), max(0.045, gap * 0.6))
                elif not chord:
                    w = min(w, max(0.060, gap * 0.5))
                    self._note_ok_window[id(prev)] = min(self._note_ok_window.get(id(prev), w), max(0.060, gap * 0.5))
            self._note_ok_window[id(e)] = w
            prev = e

    def ok_window_for(self, e: M.CharEvent) -> float:
        return self._note_ok_window.get(id(e), self.timing_windows['ok'])

    @property
    def _anchor(self) -> Optional[M.CharEvent]:
        """The anchor started last (None when no hand is holding)."""
        return self._anchors[-1] if self._anchors else None

    @property
    def last_anchor_result(self) -> Optional[dict]:
        return self.anchor_results[-1] if self.anchor_results else None

    @last_anchor_result.setter
    def last_anchor_result(self, v) -> None:
        if v is None:
            self.anchor_results = []

    # ── time ───────────────────────────────────────────────────────────────
    def now(self) -> float:
        return self._clock()

    # ── advance ────────────────────────────────────────────────────────────
    def update(self) -> list[M.CharEvent]:
        """Advance past rests and expired notes. Returns the notes that just became misses."""
        missed: list[M.CharEvent] = []
        if self.is_finished():
            return missed
        elapsed = self.now()

        if self._active_hold is not None:
            hold_end_time = self._active_hold.timestamp + self._active_hold.hold_duration
            if elapsed >= hold_end_time:
                self._complete_hold(self._hold_judgment)
            return missed
        for a in list(self._anchors):
            if elapsed >= a.timestamp + a.hold_duration:
                self.anchor_results.append(self._complete_anchor(a))

        while self.char_event_idx < len(self.beat_map):
            ev = self.beat_map[self.char_event_idx]
            if ev.is_rest or not ev.char:
                if elapsed >= ev.timestamp:
                    self.char_event_idx += 1
                    continue
                break
            if elapsed > ev.timestamp + self.ok_window_for(ev):
                self._register_miss(ev)
                missed.append(ev)
                self.char_event_idx += 1
            else:
                break
        return missed

    # ── input ──────────────────────────────────────────────────────────────
    def check_input(self, typed_char: str) -> dict:
        base = {'hit': False, 'judgment': 'ignored', 'offset': 0.0, 'time_diff': 0.0,
                'combo': self.combo, 'event': None, 'is_word_complete': False, 'pressed': typed_char}
        if self.is_finished():
            return base
        if self._active_hold is not None:
            return base
        if any(typed_char.lower() == a.char.lower() for a in self._anchors):
            return base                       # key repeat on a held anchor: nothing
        ev = self.current_event()
        if ev is None or ev.is_rest or not ev.char:
            return base
        # a chord (two anchors due together) may be pressed in either order
        if ev.section_kind == "anchor" and typed_char.lower() != ev.char.lower():
            j = self.char_event_idx + 1
            if j < len(self.beat_map):
                nxt = self.beat_map[j]
                if nxt.section_kind == "anchor" and abs(nxt.timestamp - ev.timestamp) < 0.06 \
                        and typed_char.lower() == nxt.char.lower():
                    self.beat_map[self.char_event_idx], self.beat_map[j] = nxt, ev
                    ev = nxt

        elapsed = self.now()
        gap_ms = -1.0 if self._last_press_t is None else (elapsed - self._last_press_t) * 1000.0
        self._last_press_t = elapsed
        offset = elapsed - ev.timestamp
        base['event'] = ev
        base['offset'] = offset
        base['time_diff'] = abs(offset)

        if typed_char.lower() != ev.char.lower():
            self.slip_count += 1
            self.hits.append(M.HitRecord(elapsed, ev.char, typed_char, 'slip', offset * 1000.0,
                                         ev.word_text, ev.char_idx, gap_ms, ev.weight, ev.lane, ev.voice))
            base['judgment'] = 'slip'
            return base

        ok_w = self.ok_window_for(ev)
        if offset < -ok_w:
            self.too_early_count += 1
            self.hits.append(M.HitRecord(elapsed, ev.char, typed_char, 'too_early', offset * 1000.0,
                                         ev.word_text, ev.char_idx, gap_ms, ev.weight, ev.lane, ev.voice))
            base['judgment'] = 'too_early'
            return base

        judgment = self._get_judgment(abs(offset), ok_w)
        self.offsets_ms.append(offset * 1000.0)

        if ev.section_kind == "anchor" and ev.hold_duration > 0:
            self._anchors = [a for a in self._anchors if a.lane != ev.lane] + [ev]
            self._anchor_judgments[id(ev)] = judgment
            self._anchor_press[id(ev)] = elapsed
            self._anchor_judgment = judgment
            ev.hit = True
            self.char_event_idx += 1
            self.hits.append(M.HitRecord(ev.timestamp, ev.char, typed_char, 'anchor_started', offset * 1000.0,
                                         ev.word_text, ev.char_idx, gap_ms, ev.weight, ev.lane, ev.voice))
            base.update(hit=True, judgment='anchor_started', combo=self.combo)
            return base

        if ev.hold_duration > 0:
            self._active_hold = ev
            self._hold_press_time = elapsed
            self._hold_judgment = judgment
            ev.hit = True
            self.char_event_idx += 1
            self.hits.append(M.HitRecord(ev.timestamp, ev.char, typed_char, 'hold_started', offset * 1000.0,
                                         ev.word_text, ev.char_idx, gap_ms, ev.weight, ev.lane, ev.voice))
            base.update(hit=True, judgment='hold_started', combo=self.combo)
            return base

        self._register_hit(judgment, ev)
        ev.hit = True
        self.char_event_idx += 1
        self.hits.append(M.HitRecord(ev.timestamp, ev.char, typed_char, judgment, offset * 1000.0,
                                     ev.word_text, ev.char_idx, gap_ms, ev.weight, ev.lane, ev.voice))
        complete = self._is_word_complete()
        if complete:
            self._done_words.add(ev.word_id)
        base.update(hit=True, judgment=judgment, combo=self.combo, is_word_complete=complete)
        return base

    def on_key_release(self, released_char: str) -> dict:
        held = next((a for a in self._anchors if released_char.lower() == a.char.lower()), None)
        if held is not None:
            elapsed = self.now()
            if elapsed - self._anchor_press.get(id(held), -1e9) < self._hold_settle:
                return {}                       # a fumble on the way down, not a release
            end = held.timestamp + held.hold_duration
            if elapsed >= end - held.hold_duration * self._hold_release_grace:
                return self._complete_anchor(held)
            self._anchors.remove(held)
            self._register_miss(held, judgment='anchor_broken')
            return {'hit': False, 'judgment': 'anchor_broken', 'offset': 0.0, 'time_diff': 0.0,
                    'combo': self.combo, 'event': held, 'is_word_complete': False, 'anchor': True}
        if self._active_hold is None:
            return {}
        if released_char.lower() != self._active_hold.char.lower():
            return {}
        elapsed = self.now()
        if elapsed - self._hold_press_time < self._hold_settle:
            return {}                           # a fumble on the way down, not a release
        hold_end_time = self._active_hold.timestamp + self._active_hold.hold_duration
        required_time = hold_end_time - self._active_hold.hold_duration * self._hold_release_grace
        if elapsed >= required_time:
            return self._complete_hold(self._hold_judgment)
        ev = self._active_hold
        self._active_hold = None
        self._register_miss(ev, judgment='hold_broken')
        return {'hit': False, 'judgment': 'hold_broken', 'offset': 0.0, 'time_diff': 0.0,
                'combo': self.combo, 'event': ev, 'is_word_complete': False}

    def _complete_hold(self, judgment: str) -> dict:
        ev = self._active_hold
        self._register_hold_hit(judgment, ev)
        self._active_hold = None
        complete = self._is_word_complete()
        if complete and ev is not None:
            self._done_words.add(ev.word_id)
        return {'hit': True, 'judgment': f'hold_{judgment}', 'offset': 0.0, 'time_diff': 0.0,
                'combo': self.combo, 'event': ev, 'is_word_complete': complete}

    def _complete_anchor(self, ev: M.CharEvent) -> dict:
        if ev in self._anchors:
            self._anchors.remove(ev)
        j = self._anchor_judgments.pop(id(ev), self._anchor_judgment)
        self._register_hold_hit(j, ev)
        self._done_words.add(ev.word_id)
        return {'hit': True, 'judgment': f'hold_{j}', 'offset': 0.0, 'time_diff': 0.0,
                'combo': self.combo, 'event': ev, 'is_word_complete': True, 'anchor': True}

    # ── judgment bookkeeping ───────────────────────────────────────────────
    def _get_judgment(self, adiff: float, ok_w: float) -> str:
        if adiff <= self.timing_windows['perfect']:
            return 'perfect'
        if adiff <= self.timing_windows['good']:
            return 'good'
        if adiff <= ok_w:
            return 'ok'
        return 'miss'

    def _register_hit(self, judgment: str, ev: Optional[M.CharEvent] = None) -> None:
        self.combo += 1
        self.max_combo = max(self.max_combo, self.combo)
        if judgment == 'perfect':
            self.perfect_hits += 1
            if self.rush_active:
                self.rush_bonus += 1500
        elif judgment == 'good':
            self.good_hits += 1
        else:
            self.ok_hits += 1

    def _register_hold_hit(self, judgment: str, ev: Optional[M.CharEvent] = None) -> None:
        self.combo += 1
        self.max_combo = max(self.max_combo, self.combo)
        if judgment == 'perfect':
            self.hold_perfect_hits += 1
        elif judgment == 'good':
            self.hold_good_hits += 1
        else:
            self.hold_ok_hits += 1
        if ev is not None:
            self.hits.append(M.HitRecord(ev.timestamp, ev.char, ev.char, f'hold_{judgment}', 0.0,
                                         ev.word_text, ev.char_idx, -1.0, ev.weight, ev.lane, ev.voice))

    def _register_miss(self, ev: Optional[M.CharEvent] = None, judgment: str = 'miss') -> None:
        self.combo = 0
        self.miss_count += 1
        if ev is not None:
            self._dirty_words.add(ev.word_id)
            self.hits.append(M.HitRecord(ev.timestamp, ev.char, '', judgment, 0.0,
                                         ev.word_text, ev.char_idx, -1.0, ev.weight, ev.lane, ev.voice))

    def _is_word_complete(self) -> bool:
        prev_idx = self.char_event_idx - 1
        if prev_idx < 0:
            return False
        prev_event = self.beat_map[prev_idx]
        if prev_event.is_rest or not prev_event.word_text or prev_event.section_kind == "grace":
            return False
        return prev_event.char_idx == len(prev_event.word_text) - 1

    # ── getters ────────────────────────────────────────────────────────────
    def current_event(self) -> Optional[M.CharEvent]:
        if self.char_event_idx >= len(self.beat_map):
            return None
        return self.beat_map[self.char_event_idx]

    def current_expected_char(self) -> Optional[str]:
        ev = self.current_event()
        if not ev or ev.is_rest or not ev.char:
            return None
        return ev.char

    def current_expected_word(self) -> Optional[str]:
        ev = self.current_event()
        if not ev:
            return self.last_word
        if ev.is_rest or not ev.char:
            for i in range(self.char_event_idx + 1, len(self.beat_map)):
                nxt = self.beat_map[i]
                if not nxt.is_rest and nxt.word_text:
                    return nxt.word_text
            return self.last_word
        if ev.word_text:
            self.last_word = ev.word_text
        return self.last_word

    def current_word_events(self) -> list[M.CharEvent]:
        """The events of the word instance at (or after) the cursor."""
        ev = self.current_event()
        idx = self.char_event_idx
        if ev is None:
            return []
        if ev.is_rest or not ev.char:
            for i in range(idx + 1, len(self.beat_map)):
                if not self.beat_map[i].is_rest and self.beat_map[i].char:
                    idx = i
                    ev = self.beat_map[i]
                    break
            else:
                return []
        wid = ev.word_id
        out = []
        for i in range(max(0, idx - 24), len(self.beat_map)):
            e = self.beat_map[i]
            if e.is_rest or not e.char:
                continue
            if e.word_id == wid:
                out.append(e)
            elif out:
                break
        return out

    def upcoming_words(self, n: int = 3) -> list[str]:
        """The next n distinct word instances after the current one."""
        cur = self.current_word_events()
        cur_id = cur[0].word_id if cur else None
        seen: list[int] = []
        words: list[str] = []
        for i in range(self.char_event_idx, len(self.beat_map)):
            e = self.beat_map[i]
            if e.is_rest or not e.char or e.word_id == cur_id or e.section_kind == "anchor":
                continue                         # a held key is shown on its lane, not as a word
            if e.word_id not in seen:
                seen.append(e.word_id)
                words.append(e.word_text)
                if len(words) >= n:
                    break
        return words

    def current_display_word(self) -> Optional[str]:
        """Only the letters of the current word that actually have notes (legacy generators truncate)."""
        evs = self.current_word_events()
        if not evs:
            return self.current_expected_word()
        return evs[0].word_text[:max(e.char_idx for e in evs) + 1]

    def get_upcoming_events(self, lookahead_time: float = 3.0) -> list[M.CharEvent]:
        if self.is_finished():
            return []
        t = self.now()
        out = []
        for event in self.beat_map[self.char_event_idx:]:
            if event.timestamp - t > lookahead_time:
                break
            out.append(event)
        return out

    def get_progress(self) -> float:
        if not self.beat_map:
            return 1.0
        return self.char_event_idx / len(self.beat_map)

    def is_finished(self) -> bool:
        return self.char_event_idx >= len(self.beat_map)

    def on_beat(self) -> bool:
        ev = self.current_event()
        if not ev or ev.is_rest:
            return False
        return abs(self.now() - ev.timestamp) <= self.ok_window_for(ev)

    # ── scoring ────────────────────────────────────────────────────────────
    def judged_notes(self) -> int:
        return (self.perfect_hits + self.good_hits + self.ok_hits + self.miss_count
                + self.hold_perfect_hits + self.hold_good_hits + self.hold_ok_hits)

    def weighted_hits(self) -> float:
        return ((self.perfect_hits + self.hold_perfect_hits) * 1.0
                + (self.good_hits + self.hold_good_hits) * 0.7
                + (self.ok_hits + self.hold_ok_hits) * 0.3)

    def get_accuracy(self) -> float:
        """Accuracy over the notes judged so far (0–100)."""
        judged = self.judged_notes()
        if judged == 0:
            return 100.0
        return min(100.0, self.weighted_hits() / judged * 100.0)

    def clean_words(self) -> int:
        return len([w for w in self._done_words if w not in self._dirty_words])

    def get_score(self) -> int:
        """Normalized score, monotone during play: the share of the 1,000,000 earned so far."""
        if self.total_notes == 0:
            return 0
        acc_term = self.weighted_hits() / self.total_notes
        combo_term = self.max_combo / self.total_notes
        clean_term = (self.clean_words() / self.total_words) if self.total_words else 0.0
        return int(round(SCORE_MAX * (0.70 * acc_term + 0.20 * combo_term + 0.10 * clean_term))) + self.rush_bonus

    def get_grade(self) -> str:
        acc = self.get_accuracy()
        if acc >= 99.5 and self.miss_count == 0:
            return 'SS'
        if acc >= 95:
            return 'S'
        if acc >= 90:
            return 'A'
        if acc >= 80:
            return 'B'
        if acc >= 70:
            return 'C'
        return 'D'

    def get_rank(self) -> str:
        return self.get_grade()

    def stars(self) -> int:
        acc = self.get_accuracy()
        if acc >= 95 and self.miss_count <= 2:
            return 3
        if acc >= 90:
            return 2
        if acc >= 80:
            return 1
        return 0

    def mean_offset_ms(self) -> float:
        if not self.offsets_ms:
            return 0.0
        return sum(self.offsets_ms) / len(self.offsets_ms)

    def get_stats(self) -> dict:
        return {
            'score': self.get_score(),
            'accuracy': self.get_accuracy(),
            'rank': self.get_grade(),
            'grade': self.get_grade(),
            'stars': self.stars(),
            'combo': self.combo,
            'max_combo': self.max_combo,
            'perfect': self.perfect_hits + self.hold_perfect_hits,
            'good': self.good_hits + self.hold_good_hits,
            'ok': self.ok_hits + self.hold_ok_hits,
            'misses': self.miss_count,
            'slips': self.slip_count,
            'too_early': self.too_early_count,
            'clean_words': self.clean_words(),
            'total_words': self.total_words,
            'total_notes': self.total_notes,
            'mean_offset_ms': self.mean_offset_ms(),
            'progress': self.get_progress(),
        }
