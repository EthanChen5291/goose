"""
Slot-based rhythm generation helpers.
Handles slot building, filtering, grouping, word assignment, and intensity adjustment.
Public API (generate_beatmap, deduplicate_events) lives in beatmap_generator.py.
"""
import random
from typing import Optional, NamedTuple
from analysis.audio_analysis import analyze_song_intensity, get_sb_info, detect_hold_regions
from . import constants as C
from . import models as M


# ==================== REPEAT GROUP PLANNING ====================

class _RepeatEntry(NamedTuple):
    group_id: int
    iter_idx: int   # 0 = template, 1..N = repeats


def _plan_repeat_groups(
    measures: list[list[M.RhythmSlot]],
    intensity_profile: Optional[M.IntensityProfile],
    pace_score: float,
) -> dict[int, _RepeatEntry]:
    """
    Pre-pass that identifies which measures belong to intentional repeat groups.

    Returns a dict: measure_idx -> _RepeatEntry(group_id, iter_idx)
    iter_idx=0 is the template (picks word normally); iter_idx>0 are echo iterations
    that reuse the template's word with the same rhythmic slot count.

    Only activates when pace_score > 0.3.  Looks for runs of ≥2 consecutive
    above-average-intensity sections and turns them into repeat zones.
    """
    if pace_score <= 0.3 or not intensity_profile or not intensity_profile.section_intensities:
        return {}

    sec_intens = intensity_profile.section_intensities
    avg = sum(sec_intens) / len(sec_intens) if sec_intens else 1.0
    HOT = 0.55   # intensity_ratio threshold to qualify as "active"

    # Build section-level ratios
    num_sections = len(sec_intens)
    ratios = [sec_intens[si] / (avg + 1e-6) for si in range(num_sections)]

    plan: dict[int, _RepeatEntry] = {}
    group_id = 1
    n_measures = len(measures)

    si = 0
    while si < num_sections:
        if ratios[si] > HOT:
            # Find end of hot run
            run_start = si
            while si < num_sections and ratios[si] > HOT:
                si += 1
            run_end = si  # exclusive

            run_len = run_end - run_start
            if run_len < 2:
                continue

            # Consistency guard: slot counts should be similar across iterations.
            # Sections with wildly varying density don't feel like a repeating rhythm.
            first_mi = run_start * 4
            _sec_slot_counts = []
            for _si in range(run_start, min(run_end, run_start + 6)):
                _total = sum(
                    len(measures[_si * 4 + _off])
                    for _off in range(4)
                    if _si * 4 + _off < n_measures
                )
                _sec_slot_counts.append(_total)
            if len(_sec_slot_counts) >= 2 and max(_sec_slot_counts) > 0:
                _mean_sc = sum(_sec_slot_counts) / len(_sec_slot_counts)
                _max_dev = max(abs(c - _mean_sc) for c in _sec_slot_counts)
                if _max_dev / max(_mean_sc, 1) > 0.40:
                    continue  # note density too inconsistent across iterations

            # Number of iterations: based on slots in first measure + energy
            n_slots = len(measures[first_mi]) if first_mi < n_measures else 4
            avg_ratio = sum(ratios[run_start:run_end]) / run_len
            raw = round(avg_ratio * max(n_slots, 2) * 0.6)
            num_iters = max(2, min(8, raw, run_len))

            for iter_idx in range(num_iters):
                sec = run_start + iter_idx
                for offset in range(4):
                    mi = sec * 4 + offset
                    if mi < n_measures:
                        plan[mi] = _RepeatEntry(group_id=group_id, iter_idx=iter_idx)

            group_id += 1
        else:
            si += 1

    return plan


# ==================== SLOT-BASED RHYTHM GENERATION ====================

def build_rhythm_slots(
    sb_info: list[M.SubBeatInfo],
    song: M.Song,
    include_weak: bool = False,
) -> list[M.RhythmSlot]:
    """
    Build rhythm slots from audio analysis.
    A slot is a potential character placement based on musical features.
    include_weak=True adds priority-1 slots for weak sub-beats (used by demon difficulty).
    """
    slots: list[M.RhythmSlot] = []
    beat_duration = 60 / song.bpm

    for i, sb in enumerate(sb_info):
        is_note_slot = False
        priority = 0

        if sb.level == M.SubBeatIntensity.STRONG:
            is_note_slot = True
            priority = 3  # high priority
        elif sb.level == M.SubBeatIntensity.MEDIUM:
            # only include medium beats when there's a meaningful gap since the last slot
            if not slots or (sb.time - slots[-1].time) > 0.6:
                is_note_slot = True
                priority = 2  # medium priority
        elif include_weak and sb.level == M.SubBeatIntensity.WEAK:
            is_note_slot = True
            priority = 1  # low priority — demon only

        if is_note_slot:
            slots.append(M.RhythmSlot(
                time=sb.time,
                intensity=sb.raw_intensity,
                priority=priority,
                is_filled=False,
                beat_position=sb.time / beat_duration
            ))

    return slots


def filter_slots_for_playability(slots: list[M.RhythmSlot], min_spacing: float = 0.12) -> list[M.RhythmSlot]:
    """
    Remove slots that are too close together for comfortable typing.
    Modern rhythm games maintain ~120-150ms minimum spacing.
    """
    if not slots:
        return []

    filtered = [slots[0]]

    for slot in slots[1:]:
        if slot.time - filtered[-1].time >= min_spacing:
            filtered.append(slot)

    return filtered


def group_slots_by_measure(slots: list[M.RhythmSlot], beat_duration: float) -> list[list[M.RhythmSlot]]:
    """Group rhythm slots into measures (4 beats each)"""
    if not slots:
        return []

    measure_duration = beat_duration * C.BEATS_PER_MEASURE

    first_measure = int(slots[0].time / measure_duration)
    last_measure = int(slots[-1].time / measure_duration)

    num_measures = last_measure - first_measure + 1
    measures: list[list[M.RhythmSlot]] = [[] for _ in range(num_measures)]

    for slot in slots:
        measure_idx = int(slot.time / measure_duration) - first_measure
        if 0 <= measure_idx < num_measures:
            measures[measure_idx].append(slot)

    # measures = [m for m in measures if m]  #uncomment to remove empty measures

    return measures


# ==================== WORD MANAGEMENT ====================

def get_words_with_rhythm_info(words: list[str], beat_duration: float, target_cps: float = C.TARGET_CPS) -> list[M.Word]:
    """Enhanced word creation with better rhythm properties"""
    return [
        M.Word(
            text=word,
            rest_type=None,
            ideal_beats=(ideal := len(word) / target_cps / beat_duration),
            snapped_beats=(snapped := snap_to_grid(ideal, C.SNAP_GRID)),
            snapped_cps=len(word) / (snapped * beat_duration)
        )
        for word in words
    ]


def select_word_for_measure(
    available_slots: int,
    remaining_words: list[M.Word],
    word_bank: list[M.Word],
    intensity_ratio: float = 1.0,
    target_cps: float = C.TARGET_CPS,
    cps_tolerance: float = C.CPS_TOLERANCE,
    allow_spam: bool = False,
    beat_duration: float = 0.5,
    max_word_length: int = 99,
) -> Optional[M.Word]:
    """
    Select the best word for a measure based on:
    - Number of available rhythm slots
    - Intensity ratio (loud = more chars, quiet = fewer)
    - Word variety
    Quiet sections build up with short words; high-intensity sections may
    use long words OR burst into rapid single-letter spam (non-linear).
    """
    if not remaining_words:
        return None

    # apply per-difficulty word length cap
    remaining_words = [w for w in remaining_words if len(w.text) <= max_word_length]
    if not remaining_words:
        remaining_words = word_bank  # fallback: ignore cap rather than return nothing

    # --- spam burst: very high intensity → rapid single-letter presses ---
    if allow_spam and intensity_ratio >= 1.4 and random.random() < 0.38:
        all_chars = [c for w in word_bank for c in w.text if c.isalpha()]
        if all_chars:
            char = random.choice(all_chars)
            snapped = snap_to_grid(1.0 / target_cps / beat_duration, C.SNAP_GRID)
            snapped = max(snapped, C.SNAP_GRID)
            return M.Word(
                text=char,
                rest_type=None,
                ideal_beats=1.0 / target_cps / beat_duration,
                snapped_beats=snapped,
                snapped_cps=1.0 / (snapped * beat_duration),
            )

    # --- intensity-driven word length (build-up from quiet → dense) ---
    if intensity_ratio < 0.6:
        # very quiet: prefer 1-2 char words
        target_chars = max(1, int(available_slots * 0.3))
    elif intensity_ratio < 0.8:
        # calm: short words
        target_chars = max(2, int(available_slots * 0.45))
    elif intensity_ratio < 1.0:
        # building: medium-short
        target_chars = max(2, int(available_slots * 0.6))
    elif intensity_ratio < 1.2:
        # moderate: medium
        target_chars = max(2, int(available_slots * 0.75))
    elif intensity_ratio < 1.5:
        # energetic: lean long
        target_chars = min(available_slots, int(available_slots * 0.88))
    else:
        # peak: as long as slots allow
        target_chars = min(available_slots, available_slots)

    tolerance = 2 if abs(intensity_ratio - 1.0) > 0.3 else 1
    candidates = [
        w for w in remaining_words
        if abs(len(w.text) - target_chars) <= tolerance and len(w.text) <= available_slots
    ]

    if not candidates:
        candidates = [w for w in remaining_words if len(w.text) <= available_slots]

    if not candidates:
        candidates = [min(remaining_words, key=lambda w: len(w.text))]

    effective_cps = target_cps * intensity_ratio
    viable = [w for w in candidates if abs(w.snapped_cps - effective_cps) <= cps_tolerance * 1.5]

    return random.choice(viable if viable else candidates)


# ==================== SLOT ASSIGNMENT ====================

def find_next_measure_time(measures, start_idx, fallback_time):
    for j in range(start_idx + 1, len(measures)):
        if measures[j]:  # non-empty measure
            return measures[j][0].time
    return fallback_time


def in_grace_period_check(
    slot_time: float,
    dual_side_sections: Optional[list[M.DualSideSection]],
    grace_duration: float,
) -> bool:
    """Return True if slot_time falls within a dual-section grace window."""
    if not dual_side_sections:
        return False
    for dual_sec in dual_side_sections:
        if dual_sec.start_time - grace_duration <= slot_time < dual_sec.start_time:
            return True
        if dual_sec.start_time <= slot_time < dual_sec.start_time + grace_duration:
            return True
        if dual_sec.end_time <= slot_time < dual_sec.end_time + grace_duration:
            return True
    return False


def assign_words_to_slots(
    measures: list[list[M.RhythmSlot]],
    word_bank: list[M.Word],
    beat_duration: float,
    intensity_profile: Optional[M.IntensityProfile] = None,
    dual_side_sections: Optional[list[M.DualSideSection]] = None,
    hold_regions: Optional[list[tuple[float, float]]] = None,
    bounce_grace_zones: Optional[list[tuple[float, float]]] = None,
    target_cps: float = C.TARGET_CPS,
    cps_tolerance: float = C.CPS_TOLERANCE,
    min_word_gap: float = C.MIN_WORD_GAP,
    quiet_skip_chance: float = 0.65,
    max_words_per_measure: int = 1,
    max_word_length: int = 99,
    max_silence_gap: float = float('inf'),
    pace_score: float = 0.0,
) -> list[M.CharEvent]:
    """
    Assign characters to rhythm slots measure-by-measure.
    max_words_per_measure > 1 (demon difficulty) will fill unused slots within
    the same measure with additional words, giving dense rapid-fire note density.

    max_silence_gap: if this many seconds have passed without any word being placed
    and the current section is not truly quiet, force a word regardless of gap/skip
    checks.  Used for hard/demon to prevent empty bounce-section iterations.
    """
    events: list[M.CharEvent] = []
    remaining_words = word_bank.copy()
    section_idx = 0
    last_word_end_time = -float('inf')
    last_word_text = ""
    dual_note_count = 0   # counts notes placed inside dual sections for alternation
    _burst_active = False  # True after placing a spam word → tighter gap next measure
    _burst_gap = max(min_word_gap * 0.35, 0.0)  # gap used between consecutive spam words

    # Pre-compute average intensity once
    _avg_intensity: float = 0.0
    if intensity_profile and intensity_profile.section_intensities:
        _avg_intensity = (sum(intensity_profile.section_intensities)
                          / len(intensity_profile.section_intensities))

    # Deterministic repeat groups: measures tagged with (group_id, iter_idx).
    # iter_idx=0 = template (pick word normally, then store it);
    # iter_idx>0 = echo (reuse the template's word with same slot count).
    _repeat_plan = _plan_repeat_groups(measures, intensity_profile, pace_score)
    # group_id -> (Word object, num_chars_to_place) stored when template is placed
    _repeat_templates: dict[int, tuple[M.Word, int]] = {}

    # one measure grace period when starting dual sections
    grace_beats = 4
    grace_duration = grace_beats * beat_duration

    for measure_idx, measure_slots in enumerate(measures):
        if not measure_slots or not remaining_words:
            continue

        section_idx = measure_idx // 4

        first_slot_time = measure_slots[0].time
        silence_duration = first_slot_time - last_word_end_time

        # Determine whether this section is "truly quiet" (below 55% of avg).
        # Used by the force-word safeguard — we only override skips for non-quiet sections.
        _is_truly_quiet = False
        if intensity_profile and section_idx < len(intensity_profile.section_intensities):
            _sec_intensity = intensity_profile.section_intensities[section_idx]
            _is_truly_quiet = (_avg_intensity > 0 and _sec_intensity < _avg_intensity * 0.55)

        # Force-word flag: silence has lasted too long for a non-quiet section
        force_word = (
            max_silence_gap < float('inf')
            and silence_duration > max_silence_gap
            and not _is_truly_quiet
            and not in_grace_period_check(first_slot_time, dual_side_sections, grace_duration)
        )

        effective_gap = _burst_gap if _burst_active else min_word_gap
        if not force_word and first_slot_time < last_word_end_time + effective_gap:
            continue

        in_grace_period = in_grace_period_check(first_slot_time, dual_side_sections, grace_duration)

        if in_grace_period:
            continue

        intensity_ratio = 1.0
        if intensity_profile and section_idx < len(intensity_profile.section_intensities):
            intensity_ratio = (intensity_profile.section_intensities[section_idx]
                               / (_avg_intensity + 1e-6))

        if not force_word and intensity_profile and section_idx < len(intensity_profile.section_intensities):
            intensity = intensity_profile.section_intensities[section_idx]
            if intensity < _avg_intensity * 0.7 and random.random() < quiet_skip_chance:
                continue

        # ── inner loop: place up to max_words_per_measure words in this measure ──
        available_slots = sorted(measure_slots, key=lambda s: s.time)
        last_rest_slot: M.RhythmSlot | None = None

        for _word_attempt in range(max_words_per_measure):
            if not remaining_words:
                break

            # find slots that are past the required gap from the last placed note
            effective_gap = _burst_gap if _burst_active else min_word_gap
            eligible = [s for s in available_slots
                        if not s.is_filled and s.time >= last_word_end_time + effective_gap]
            # Remove slots that fall inside a bounce grace zone — they will be
            # silenced later by _apply_bounce_grace_periods, so skip them now.
            if bounce_grace_zones:
                eligible = [s for s in eligible
                            if not any(gz0 <= s.time < gz1
                                       for gz0, gz1 in bounce_grace_zones)]
            if not eligible:
                break

            candidates = [w for w in remaining_words if w.text != last_word_text]
            if not candidates:
                candidates = remaining_words

            # Repeat-group logic: use stored template word for echo iterations,
            # or pick normally (and store) for template iteration.
            repeat_entry = _repeat_plan.get(measure_idx)
            is_repeat_iter = False
            repeat_group_id = 0
            repeat_iter_num = 0

            word = None
            if repeat_entry is not None:
                repeat_group_id = repeat_entry.group_id
                if repeat_entry.iter_idx == 0:
                    # Template: pick normally below, then store
                    repeat_iter_num = 1
                else:
                    # Echo: reuse the stored template word if available
                    template = _repeat_templates.get(repeat_entry.group_id)
                    if template is not None:
                        tmpl_word, tmpl_chars = template
                        if len(tmpl_word.text) <= len(eligible):
                            word = tmpl_word
                            is_repeat_iter = True
                            repeat_iter_num = repeat_entry.iter_idx + 1
                    # If no template stored yet (e.g. first section was skipped), fall through

            if word is None:
                word = select_word_for_measure(
                    len(eligible),
                    candidates,
                    word_bank,
                    intensity_ratio,
                    target_cps=target_cps,
                    cps_tolerance=cps_tolerance,
                    allow_spam=_burst_active or intensity_ratio >= 1.4,
                    beat_duration=beat_duration,
                    max_word_length=max_word_length,
                )

            if not word or not word.text:
                break

            # Don't consume from remaining_words for echo iterations (word was already used)
            if not is_repeat_iter and word in remaining_words:
                remaining_words.remove(word)

            chars_to_place = min(len(word.text), len(eligible), C.MAX_SLOTS_PER_MEASURE)

            sorted_eligible = sorted(eligible, key=lambda s: s.priority, reverse=True)
            selected_slots = sorted(sorted_eligible[:chars_to_place], key=lambda s: s.time)

            if not selected_slots:
                break

            for char_idx in range(chars_to_place):
                char = word.text[char_idx]
                slot = selected_slots[char_idx]

                from_left = False
                if dual_side_sections:
                    for dual_sec in dual_side_sections:
                        if dual_sec.start_time <= slot.time < dual_sec.end_time:
                            from_left = (dual_note_count % 2 == 1)
                            dual_note_count += 1
                            break

                # Check if this slot falls within a detected hold region
                hold_dur = 0.0
                if hold_regions:
                    next_slot_time = (
                        selected_slots[char_idx + 1].time
                        if char_idx + 1 < chars_to_place
                        else float('inf')
                    )
                    for hr_start, hr_dur in hold_regions:
                        if abs(slot.time - hr_start) <= beat_duration * 0.5:
                            max_dur = max(0.0, next_slot_time - slot.time - 0.15)
                            hold_dur = min(hr_dur, max_dur)
                            if hold_dur < 0.1:
                                hold_dur = 0.0
                            break

                events.append(M.CharEvent(
                    char=char,
                    timestamp=slot.time,
                    word_text=word.text,
                    char_idx=char_idx,
                    beat_position=slot.beat_position,
                    section=section_idx,
                    is_rest=False,
                    from_left=from_left,
                    hold_duration=hold_dur,
                    repeat_group_id=repeat_group_id,
                    repeat_iter=repeat_iter_num,
                ))
                slot.is_filled = True

            last_word_end_time = selected_slots[chars_to_place - 1].time
            last_word_text = word.text
            last_rest_slot = selected_slots[-1]
            # Don't activate burst mode for repeat-group measures (keep rhythmic feel)
            _burst_active = (repeat_group_id == 0
                             and len(word.text) == 1
                             and intensity_ratio >= 1.4)

            # Store template for subsequent echo iterations
            if repeat_entry is not None and repeat_entry.iter_idx == 0:
                _repeat_templates[repeat_group_id] = (word, chars_to_place)

            # remove used slots so subsequent words in this measure don't reuse them
            used_times = {s.time for s in selected_slots}
            available_slots = [s for s in available_slots if s.time not in used_times]

            # recycle words if running low
            if len(remaining_words) < len(word_bank) * 0.3:
                for w in word_bank:
                    if w not in remaining_words:
                        remaining_words.append(w)

        # one rest event per measure, after the last word placed
        if last_rest_slot is not None and measure_idx < len(measures) - 1:
            events.append(M.CharEvent(
                char="",
                timestamp=last_rest_slot.time + 0.1,
                word_text="",
                char_idx=-1,
                beat_position=last_rest_slot.beat_position,
                section=section_idx,
                is_rest=True,
            ))

    return events


# ==================== RHYTHM VARIATIONS ====================

def add_rhythm_variations(events: list[M.CharEvent], song: M.Song) -> list[M.CharEvent]:
    """
    Add modern rhythm game elements:
    - Occasional bursts (fast typing sections)
    - Syncopation (off-beat emphasis)
    - Call-and-response patterns
    """
    if not events:
        return events

    sections = group_events_by_section(events)
    enhanced: list[M.CharEvent] = []

    for section in sections:
        if random.random() < 0.2:
            for e in section:
                if not e.is_rest:
                    e_copy = M.CharEvent(
                        char=e.char,
                        timestamp=e.timestamp * 0.95,
                        word_text=e.word_text,
                        char_idx=e.char_idx,
                        beat_position=e.beat_position,
                        section=e.section,
                        is_rest=e.is_rest
                    )
                    enhanced.append(e_copy)
                else:
                    enhanced.append(e)
        else:
            enhanced.extend(section)

    return enhanced


# ==================== UTILITY FUNCTIONS ====================

def snap_to_grid(beats: float, grid: float = 0.5) -> float:
    """Snap beats to nearest musical grid interval"""
    return round(beats / grid) * grid


def group_events_by_section(events: list[M.CharEvent]) -> list[list[M.CharEvent]]:
    """Groups CharEvents by section"""
    if not events:
        return []

    sections: list[list[M.CharEvent]] = []
    current = [events[0]]

    for e in events[1:]:
        if e.section != current[-1].section:
            sections.append(current)
            current = []
        current.append(e)

    if current:
        sections.append(current)

    return sections


def adjust_slots_by_intensity(
    measures: list[list[M.RhythmSlot]],
    intensity_profile: Optional[M.IntensityProfile],
    beat_duration: float,
    target_cps: float = C.TARGET_CPS,
    demon_mode: bool = False,
) -> list[list[M.RhythmSlot]]:
    """
    Adjust slot density based on song intensity.
    Loud sections = more slots (higher CPS)
    Quiet sections = fewer slots (lower CPS)
    demon_mode keeps all priorities in loud sections to enable dense note placement.
    """
    if not intensity_profile or not measures:
        return measures

    adjusted_measures = []

    for measure_idx, measure_slots in enumerate(measures):
        if not measure_slots:
            adjusted_measures.append([])
            continue

        section_idx = measure_idx // 4

        if section_idx >= len(intensity_profile.section_intensities):
            adjusted_measures.append(measure_slots)
            continue

        section_intensity = intensity_profile.section_intensities[section_idx]
        avg_intensity = sum(intensity_profile.section_intensities) / len(intensity_profile.section_intensities)
        intensity_ratio = section_intensity / (avg_intensity + 1e-6)

        if demon_mode:
            # Demon: flood loud sections with all available slots; respect silence
            if intensity_ratio > 1.0:    # loud — every slot including weak
                keep_slots = list(measure_slots)
            elif intensity_ratio > 0.85:  # normal — medium + strong
                keep_slots = [s for s in measure_slots if s.priority >= 2]
            elif intensity_ratio < 0.6:   # very quiet — one strong max (same as others)
                strong = [s for s in measure_slots if s.priority >= 3]
                keep_slots = strong[:1] if strong else []
            else:                         # quiet — strong only
                keep_slots = [s for s in measure_slots if s.priority >= 3]
        else:
            # ADJUST SLOT DENSITY BASED ON INTENSITY
            if intensity_ratio > 1.3:  # very loud — allow medium + strong
                keep_slots = [s for s in measure_slots if s.priority >= 2]
            elif intensity_ratio > 1.0:  # moderately loud — strong only
                keep_slots = [s for s in measure_slots if s.priority >= 3]
            elif intensity_ratio < 0.6:  # very quiet — top strong slot only
                strong = [s for s in measure_slots if s.priority >= 3]
                keep_slots = strong[:1] if strong else []
            elif intensity_ratio < 0.85:  # quiet — strong only, cap at 1
                strong = [s for s in measure_slots if s.priority >= 3]
                keep_slots = strong[:1] if strong else []
            else:  # normal — strong only
                keep_slots = [s for s in measure_slots if s.priority >= 3]

        min_gap = 0.12 if not demon_mode else 0.10
        if len(keep_slots) > 1:
            keep_slots.sort(key=lambda s: s.time)
            filtered = [keep_slots[0]]

            for slot in keep_slots[1:]:
                if slot.time - filtered[-1].time >= min_gap:
                    filtered.append(slot)

            adjusted_measures.append(filtered)
        else:
            adjusted_measures.append(keep_slots)

    return adjusted_measures
