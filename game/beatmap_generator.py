"""
Public API for beatmap generation.
Slot-building, word assignment, and intensity helpers live in slot_builder.py.
"""
from typing import Optional
from analysis.audio_analysis import analyze_song_intensity, get_sb_info, detect_hold_regions, get_beat_onset_strengths
from . import constants as C
from . import models as M
from .slot_builder import (
    build_rhythm_slots,
    filter_slots_for_playability,
    group_slots_by_measure,
    get_words_with_rhythm_info,
    assign_words_to_slots,
    adjust_slots_by_intensity,
)


def generate_beatmap(
    word_list: list[str],
    song: M.Song,
    dual_side_sections: Optional[list[M.DualSideSection]] = None,
    difficulty: str = "classic",
    energy_shifts: Optional[list[M.SectionEnergyShift]] = None,
    pace_score: float = 0.0,
) -> list[M.CharEvent]:
    """Generate an engaging, playable beatmap using slot-based rhythm generation."""
    profile = C.DIFFICULTY_PROFILES[difficulty]
    beat_duration = 60 / song.bpm
    is_demon = (difficulty == "demon")

    sb_info = get_sb_info(song, subdivisions=4)
    slots = build_rhythm_slots(sb_info, song, include_weak=is_demon)
    slots = filter_slots_for_playability(slots, min_spacing=profile.min_char_spacing)

    measures = group_slots_by_measure(slots, beat_duration)

    intensity_profile = None
    if song.file_path:
        path = C._to_abs_path(song.file_path)
        if path:
            intensity_profile = analyze_song_intensity(path, song.bpm)

    # adjust slots based on intensity
    measures = adjust_slots_by_intensity(
        measures, intensity_profile, beat_duration,
        target_cps=profile.target_cps, demon_mode=is_demon,
    )

    # For demon: reorder slots within each measure so those landing on
    # percussion-heavy beat positions are kept first, then cap at the
    # demon-specific (higher) per-measure limit.
    if is_demon and song.beat_times:
        path = C._to_abs_path(song.file_path) if song.file_path else None
        perc_strengths = get_beat_onset_strengths(path, song.beat_times) if path else []
        measures = _apply_demon_percussion_pattern(
            measures, perc_strengths, profile.max_slots_per_measure
        )
    else:
        max_cap = profile.max_slots_per_measure
        for i, measure in enumerate(measures):
            if len(measure) > max_cap:
                measure_sorted = sorted(measure, key=lambda s: (-s.priority, s.time))
                measures[i] = sorted(measure_sorted[:max_cap], key=lambda s: s.time)

    # Detect hold regions from audio
    hold_regions: list[tuple[float, float]] = []
    if song.file_path:
        path = C._to_abs_path(song.file_path)
        if path:
            hold_regions = detect_hold_regions(path, song.beat_times, song.bpm)

    # For hard/demon: cap the maximum silence gap so that non-quiet sections
    # never go longer than one bounce iteration (8 beats) without a word.
    # This prevents empty runs through loud bounce-section iterations.
    _max_silence = float('inf')
    if difficulty in ("master", "demon"):
        _max_silence = beat_duration * 8   # one bounce period

    # Pre-compute bounce grace zones so the word assigner avoids placing
    # words in slots that will later be silenced by _apply_bounce_grace_periods.
    bounce_grace_zones = _compute_bounce_grace_zones(energy_shifts, dual_side_sections, song)

    word_bank = get_words_with_rhythm_info(word_list, beat_duration, target_cps=profile.target_cps)
    events = assign_words_to_slots(
        measures, word_bank, beat_duration, intensity_profile, dual_side_sections,
        hold_regions=hold_regions,
        bounce_grace_zones=bounce_grace_zones,
        target_cps=profile.target_cps, cps_tolerance=profile.cps_tolerance,
        min_word_gap=profile.min_word_gap, quiet_skip_chance=profile.quiet_skip_chance,
        max_words_per_measure=profile.max_words_per_measure,
        max_word_length=profile.max_word_length,
        max_silence_gap=_max_silence,
        pace_score=pace_score,
    )
    #events = add_rhythm_variations(events, song)

    events = deduplicate_events(events, beat_duration, min_spacing=profile.min_char_spacing,
                                max_slots_per_measure=profile.max_slots_per_measure)

    # Post-process: cap every hold duration so its tail never reaches the next note.
    # Uses a 200ms visual gap so bars never visually touch.
    _HOLD_VISUAL_GAP = 0.20
    _HOLD_MIN_DUR = 0.1
    char_events = [e for e in events if not e.is_rest and e.char]
    for i, ev in enumerate(char_events):
        if ev.hold_duration <= 0:
            continue
        if i + 1 < len(char_events):
            next_t = char_events[i + 1].timestamp
            max_allowed = max(0.0, next_t - ev.timestamp - _HOLD_VISUAL_GAP)
            if ev.hold_duration > max_allowed:
                ev.hold_duration = max_allowed
        if ev.hold_duration < _HOLD_MIN_DUR:
            ev.hold_duration = 0.0

    # ensure beatmap doesn't extend past song duration
    # and pad with a blank measure of rest at the end so the last word
    # has time to scroll off before the level ends
    song_end = song.duration
    measure_duration = beat_duration * C.BEATS_PER_MEASURE

    if events:
        cutoff = song_end - measure_duration
        events = [e for e in events if e.timestamp <= cutoff]

    if events:
        last_event_time = max(e.timestamp for e in events)
        pad_time = last_event_time + measure_duration
        if pad_time <= song_end + measure_duration:
            events.append(M.CharEvent(
                char="",
                timestamp=pad_time,
                word_text="",
                char_idx=-1,
                beat_position=0.0,
                section=0,
                is_rest=True
            ))

    return events


def _compute_bounce_grace_zones(
    energy_shifts: Optional[list[M.SectionEnergyShift]],
    dual_side_sections: Optional[list[M.DualSideSection]],
    song: M.Song,
) -> list[tuple[float, float]]:
    """Return (start, end) song-time windows to avoid placing words in.
    Mirrors the logic of Game._build_bounce_events / _apply_bounce_grace_periods
    so the beatmap generator can skip slots that would later be silenced."""
    if not energy_shifts or not song.beat_times:
        return []
    beat_dur = 60.0 / song.bpm
    grace_before = beat_dur * 1   # 1 beat before bounce
    grace_after  = beat_dur * 2   # 2 beats after bounce
    dual_ranges = [(ds.start_time, ds.end_time) for ds in (dual_side_sections or [])]
    zones: list[tuple[float, float]] = []
    for shift in energy_shifts:
        if shift.energy_delta <= C.BOUNCE_THRESHOLD:
            continue
        overlaps = any(shift.start_time < de and shift.end_time > ds
                       for ds, de in dual_ranges)
        if overlaps:
            continue
        for i, bt in enumerate(song.beat_times):
            if bt < shift.start_time:
                continue
            if bt >= shift.end_time:
                break
            if i % 8 == 0:
                zones.append((bt - grace_before, bt + grace_after))
    return zones


def _apply_demon_percussion_pattern(
    measures: list[list[M.RhythmSlot]],
    perc_strengths: list[float],
    max_slots: int,
) -> list[list[M.RhythmSlot]]:
    """
    For demon difficulty: within each measure, prioritize slots that land on
    beat positions with consistently strong percussion (kick/snare pattern),
    then cap at max_slots. This gives the dense spam a rhythmic backbone
    instead of random note placement.
    """
    # Build a per-in-measure-beat percussion template over 4 beat positions.
    # perc_strengths[i] is the normalised percussion strength at beat i.
    template = [0.0] * 4
    counts   = [0]   * 4
    for i, strength in enumerate(perc_strengths):
        pos = i % 4
        template[pos] += strength
        counts[pos]   += 1
    template = [template[i] / max(1, counts[i]) for i in range(4)]

    result = []
    for measure_slots in measures:
        if not measure_slots:
            result.append([])
            continue

        if len(measure_slots) <= max_slots:
            result.append(measure_slots)
            continue

        # Score each slot: priority is primary, percussion alignment secondary.
        def slot_score(s: M.RhythmSlot) -> tuple:
            beat_in_measure = int(s.beat_position) % 4
            perc_score = template[beat_in_measure]
            return (-s.priority, -perc_score, s.time)

        sorted_slots = sorted(measure_slots, key=slot_score)
        kept = sorted(sorted_slots[:max_slots], key=lambda s: s.time)
        result.append(kept)

    return result


def deduplicate_events(
    events: list[M.CharEvent],
    beat_duration: float,
    min_spacing: float = 0.1,
    max_slots_per_measure: int = C.MAX_SLOTS_PER_MEASURE,
) -> list[M.CharEvent]:
    """
    Remove events that are too close together and cap events per measure.
    This catches any duplicates created during processing.
    """
    if not events:
        return events

    events = sorted(events, key=lambda e: e.timestamp)

    filtered: list[M.CharEvent] = []
    for event in events:
        if event.is_rest:
            filtered.append(event)
            continue

        last_char_event = None
        for e in reversed(filtered):
            if not e.is_rest:
                last_char_event = e
                break

        if last_char_event is None or (event.timestamp - last_char_event.timestamp) >= min_spacing:
            filtered.append(event)

    measure_duration = beat_duration * C.BEATS_PER_MEASURE
    measure_events: dict[int, list[M.CharEvent]] = {}

    for event in filtered:
        if event.is_rest:
            continue
        measure_idx = int(event.timestamp / measure_duration)
        if measure_idx not in measure_events:
            measure_events[measure_idx] = []
        measure_events[measure_idx].append(event)

    events_to_remove: set[float] = set()
    for measure_idx, m_events in measure_events.items():
        if len(m_events) > max_slots_per_measure:
            excess = m_events[max_slots_per_measure:]
            for e in excess:
                events_to_remove.add(e.timestamp)

    return [e for e in filtered if e.is_rest or e.timestamp not in events_to_remove]
