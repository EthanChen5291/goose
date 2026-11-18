"""
MechanicsMixin — scroll speed, bounce mode, cat position, and timeline animation.
Also defines the BounceEvent dataclass used by engine.py.
Mixed into Game via multiple inheritance; all methods use `self` freely.
"""
import time
from dataclasses import dataclass
from . import constants as C


@dataclass
class BounceEvent:
    time: float
    section_start: float
    section_end: float


class MechanicsMixin:

    def update_dynamic_scroll_speed(self, current_time: float):
        """Smoothly interpolate scroll speed based on intensity tiers + energy shifts."""
        song_time = current_time - self.rhythm.lead_in

        tier_mult = 1.0
        for t_start, t_end, mult in self.scroll_tiers:
            if t_start <= song_time < t_end:
                tier_mult = mult
                break

        target_speed = self.base_scroll_speed * self.pace_bias * tier_mult

        active_shift = None
        for shift in self.energy_shifts:
            if shift.start_time <= song_time < shift.end_time:
                active_shift = shift
                break

        if active_shift:
            if self.dual_side_active:
                damp_factor = 0.3 if self.pace_profile.pace_score < 0.5 else 0.7
                dampened_modifier = 1.0 + (active_shift.scroll_modifier - 1.0) * damp_factor
                target_speed *= dampened_modifier
            else:
                target_speed *= active_shift.scroll_modifier

        if self.dual_side_active:
            dual_slow = 0.7 if self.pace_profile.pace_score < 0.5 else 0.82
            target_speed *= dual_slow

        if target_speed > self.scroll_speed:
            lerp_factor = 0.06
        else:
            lerp_factor = 0.04

        self.scroll_speed += (target_speed - self.scroll_speed) * lerp_factor

    def _build_bounce_events(self):
        """Build bounce events from energy shifts with positive energy_delta."""
        # One "block" = 4 measures = 16 beats
        four_measure_dur = 16.0 * self.beat_duration

        # Max bounce section: musically snapped multiple of 4 measures closest to 20 s
        n_max = max(1, round(20.0 / four_measure_dur))
        max_bounce_dur = n_max * four_measure_dur

        # Cooldown after a bounce section: musically snapped multiple of 4 measures closest to 16 s
        n_cool = max(1, round(16.0 / four_measure_dur))
        min_gap = n_cool * four_measure_dur

        dual_ranges = [(ds.start_time, ds.end_time) for ds in self.dual_side_sections]
        last_section_end: float = -999.0

        for shift in self.energy_shifts:
            if shift.energy_delta <= C.BOUNCE_THRESHOLD:
                continue

            overlaps = False
            for ds_start, ds_end in dual_ranges:
                if shift.start_time < ds_end and shift.end_time > ds_start:
                    overlaps = True
                    break
            if overlaps:
                continue

            # Enforce cooldown: skip if too close to the previous bounce section end
            if shift.start_time - last_section_end < min_gap:
                continue

            # Cap the section length to the musical max
            capped_end = min(shift.end_time, shift.start_time + max_bounce_dur)

            measure_beats = []
            for i, bt in enumerate(self.song.beat_times):
                if bt < shift.start_time:
                    continue
                if bt >= capped_end:
                    break
                if i % 8 == 0:
                    measure_beats.append(bt)

            if measure_beats:
                for bt in measure_beats:
                    self.bounce_events.append(BounceEvent(
                        time=bt,
                        section_start=shift.start_time,
                        section_end=capped_end,
                    ))
                last_section_end = capped_end

        self.bounce_events.sort(key=lambda e: e.time)

    def _apply_bounce_grace_periods(self):
        """Mark beatmap notes within 2 beats of each bounce event as rests."""
        if not self.bounce_events:
            return
        grace_beats = 2
        grace_duration = self.beat_duration * grace_beats
        lead_in = self.rhythm.lead_in
        dual_ranges = [(ds.start_time, ds.end_time) for ds in self.dual_side_sections]

        tainted_words: set[tuple[str, int]] = set()
        for event in self.bounce_events:
            bounce_time = event.time + lead_in
            for note in self.rhythm.beat_map:
                if note.is_rest or not note.char:
                    continue
                note_song_time = note.timestamp - lead_in
                in_dual = any(ds <= note_song_time < de for ds, de in dual_ranges)
                if in_dual:
                    continue
                dt = note.timestamp - bounce_time
                if -self.beat_duration <= dt <= grace_duration:
                    tainted_words.add((note.word_text, note.section))

        for note in self.rhythm.beat_map:
            if note.is_rest or not note.char:
                continue
            if (note.word_text, note.section) in tainted_words:
                note.is_rest = True
                note.char = ""

    def update_bounce_state(self, current_time: float):
        """Update bounce mode: toggle direction when crossing bounce obstacles."""
        song_time = current_time - self.rhythm.lead_in

        was_active = self.bounce_active
        self.bounce_active = False

        if not self.dual_side_active:
            for evt in self.bounce_events:
                if evt.section_start <= song_time < evt.section_end:
                    self.bounce_active = True
                    break

        while (self._next_bounce_idx < len(self.bounce_events)
               and self.bounce_events[self._next_bounce_idx].time <= song_time):
            if not self.dual_side_active:
                self.bounce_reversed = not self.bounce_reversed
            self._next_bounce_idx += 1

        if was_active and not self.bounce_active:
            if self.bounce_reversed:
                # Section ended in reversed state — give post-section notes 2 beats
                # of right-side approach so they don't teleport from the left corner
                self._post_bounce_reversed_until = song_time + self.beat_duration * 2
            self.bounce_reversed = False
        if not was_active and self.bounce_active:
            self._post_bounce_reversed_until = -1.0  # entering a new section; clear

    def update_cat_position(self, current_time: float, dt: float):
        """Update cat position with momentum-style animation for dual-side mode."""
        song_time = current_time - self.rhythm.lead_in

        visual_exit_delay = self.beat_duration * 1

        was_dual_active = self.dual_side_active
        self.dual_side_active = False
        self.dual_side_visuals_active = False

        for dual_sec in self.dual_side_sections:
            if dual_sec.start_time <= song_time < dual_sec.end_time:
                self.dual_side_active = True
                self.dual_side_visuals_active = True
                break
            elif dual_sec.end_time <= song_time < dual_sec.end_time + visual_exit_delay:
                self.dual_side_visuals_active = True
                break

        if not self.dual_side_active and self.rhythm.char_event_idx < len(self.rhythm.beat_map):
            current_evt = self.rhythm.beat_map[self.rhythm.char_event_idx]
            if current_evt.from_left:
                self.dual_side_active = True
                self.dual_side_visuals_active = True

        if was_dual_active and not self.dual_side_active:
            self._last_dual_end_time = song_time

        if self.dual_side_visuals_active:
            target_x = self.cat_center_x
        else:
            target_x = self.cat_base_x

        distance = target_x - self.cat_current_x

        if self.dual_side_visuals_active:
            if abs(distance) > 5:
                spring_strength = 8.0
                damping = 4.0
            else:
                spring_strength = 5.0
                damping = 6.0
        else:
            if abs(distance) > 5:
                spring_strength = 5.0
                damping = 5.0
            else:
                spring_strength = 4.0
                damping = 7.0

        acceleration = spring_strength * distance - damping * self.cat_velocity
        self.cat_velocity += acceleration * dt
        self.cat_current_x += self.cat_velocity * dt

        if self.dual_side_visuals_active:
            self.cat_current_x = max(self.cat_base_x, min(self.cat_current_x, self.cat_center_x + 50))
        else:
            self.cat_current_x = max(self.cat_base_x - 50, min(self.cat_current_x, self.cat_center_x))

    def update_timeline_animation(self, dt: float):
        """Animate timeline expansion/contraction for dual-side mode using spring physics."""
        if self.dual_side_visuals_active:
            target_start = self.timeline_dual_start
            target_end = self.timeline_dual_end
            target_hit = self.hit_marker_dual_x
            target_word_y = self.word_dual_y
        else:
            target_start = self.timeline_normal_start
            target_end = self.timeline_normal_end
            if self.bounce_active:
                target_hit = self.hit_marker_normal_x
            else:
                grace = (C.GRACE * self.scroll_speed)
                target_hit = self.hit_marker_normal_x - grace/6
            target_word_y = self.word_normal_y

        if not hasattr(self, '_timeline_initialized'):
            self.timeline_current_start = target_start
            self.timeline_current_end = target_end
            self.hit_marker_current_x = target_hit
            self.word_current_y = target_word_y
            self._timeline_initialized = True
            return

        if self.dual_side_visuals_active:
            spring_strength = 12.0
            damping = 5.0
        else:
            spring_strength = 6.0
            damping = 7.0

        dist_start = target_start - self.timeline_current_start
        accel_start = spring_strength * dist_start - damping * self.timeline_start_velocity
        self.timeline_start_velocity += accel_start * dt
        self.timeline_current_start += self.timeline_start_velocity * dt

        dist_end = target_end - self.timeline_current_end
        accel_end = spring_strength * dist_end - damping * self.timeline_end_velocity
        self.timeline_end_velocity += accel_end * dt
        self.timeline_current_end += self.timeline_end_velocity * dt

        dist_hit = target_hit - self.hit_marker_current_x
        accel_hit = spring_strength * dist_hit - damping * self.hit_marker_velocity
        self.hit_marker_velocity += accel_hit * dt
        self.hit_marker_current_x += self.hit_marker_velocity * dt

        dist_word_y = target_word_y - self.word_current_y
        accel_word_y = spring_strength * dist_word_y - damping * self.word_y_velocity
        self.word_y_velocity += accel_word_y * dt
        self.word_current_y += self.word_y_velocity * dt
