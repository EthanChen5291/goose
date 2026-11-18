"""
NoteRenderer — draws beat markers, hold tails, and spawns hold particles.
Instantiated and owned by Game; accesses game state via self.game.
"""
import pygame
import time
import random

_NOTE_COLORS = ['blue', 'pink', 'green', 'orange']


class NoteRenderer:

    def __init__(self, game) -> None:
        self.game = game
        self._note_color_map: dict[float, str] = {}
        self._build_color_map()

    def _build_color_map(self) -> None:
        """Pre-assign a color to every non-rest note, cycling per word with no repeats."""
        prev_color: str | None = None
        current_color: str | None = None
        for event in self.game.rhythm.beat_map:
            if event.is_rest or not event.char:
                continue
            if event.char_idx == 0:
                available = [c for c in _NOTE_COLORS if c != prev_color]
                current_color = random.choice(available)
                prev_color = current_color
            if current_color is not None:
                self._note_color_map[event.timestamp] = current_color

    def render(
        self,
        current_time: float,
        timeline_y: int,
        timeline_start_x: int,
        timeline_end_x: int,
        hit_marker_x: float,
    ) -> None:
        g = self.game
        lead_in = g.rhythm.lead_in

        song_time = current_time - lead_in
        dual_exit_grace = g.beat_duration * 2
        in_dual_exit_grace = (not g.dual_side_active
                              and song_time - g._last_dual_end_time < dual_exit_grace)

        for note_idx, event in enumerate(g.rhythm.beat_map):
            time_until_hit = event.timestamp - current_time

            # Active hold: render unconditionally outside visibility window
            is_active_hold = (g.rhythm._active_hold is event)
            if is_active_hold and event.hold_duration > 0:
                note_from_left = event.from_left
                if g.bounce_active and not g.dual_side_active:
                    note_reversed = False
                    for bevt in g.bounce_events:
                        if bevt.time <= event.timestamp - g.rhythm.lead_in:
                            note_reversed = not note_reversed
                        else:
                            break
                    note_from_left = note_reversed

                hold_end_time = event.timestamp + event.hold_duration
                remaining_dur = max(0.0, hold_end_time - current_time)
                remaining_px = int(remaining_dur * g.scroll_speed)
                radius = 14
                if remaining_px > 0:
                    tail_surf = pygame.Surface((remaining_px, radius * 2), pygame.SRCALPHA)
                    pygame.draw.rect(tail_surf, (255, 220, 60, 200),
                                     (0, 0, remaining_px, radius * 2),
                                     border_radius=radius)
                    if note_from_left:
                        g.screen.blit(tail_surf, (int(hit_marker_x) - remaining_px, timeline_y - radius))
                    else:
                        g.screen.blit(tail_surf, (int(hit_marker_x), timeline_y - radius))

                # Spawn hold particles at the hitmarker
                if int(time.perf_counter() * 30) % 2 == 0:
                    import random as _rnd
                    for _ in range(2):
                        g._hold_particles.append({
                            'x': float(hit_marker_x) + _rnd.uniform(-12, 12),
                            'y': float(timeline_y) + _rnd.uniform(-14, 14),
                            'vx': _rnd.uniform(-130, 130),
                            'vy': _rnd.uniform(-160, 40),
                            'alpha': 220.0,
                            'radius': _rnd.uniform(3.75, 7.5),
                            'color': (255, 210, 60),
                        })
                    for _ in range(3):
                        g._hold_particles.append({
                            'x': float(hit_marker_x) + _rnd.uniform(-10, 10),
                            'y': float(timeline_y) + _rnd.uniform(-12, 12),
                            'vx': _rnd.uniform(-220, 220),
                            'vy': _rnd.uniform(-260, 60),
                            'alpha': 190.0,
                            'radius': _rnd.uniform(1.5, 3.3),
                            'color': (240, 240, 255),
                        })
                continue

            if -0.75 < time_until_hit < 5.0:
                if in_dual_exit_grace and not event.hit and time_until_hit < 0:
                    continue

                note_from_left = event.from_left

                if g.bounce_active and not g.dual_side_active:
                    if time_until_hit < 0 and not event.hit:
                        continue
                    note_reversed = False
                    for bevt in g.bounce_events:
                        if bevt.time <= event.timestamp - g.rhythm.lead_in:
                            note_reversed = not note_reversed
                        else:
                            break
                    note_from_left = note_reversed
                elif (not g.dual_side_active
                      and g._post_bounce_reversed_until > 0
                      and event.timestamp - g.rhythm.lead_in <= g._post_bounce_reversed_until):
                    # Section just ended in reversed state — notes within 2 beats of
                    # section end approach from the right to avoid teleport glitch
                    note_from_left = True

                if note_from_left:
                    marker_x = hit_marker_x - (time_until_hit * g.scroll_speed)
                else:
                    marker_x = hit_marker_x + (time_until_hit * g.scroll_speed)

                if timeline_start_x <= marker_x <= timeline_end_x:
                    if event.char != "" and not event.hit:
                        is_missed = time_until_hit < 0
                        radius = 14

                        if g.dual_side_active and is_missed:
                            if note_idx not in g.missed_note_shockwaves:
                                g.trigger_miss_shockwave(int(marker_x), timeline_y)
                                g.missed_note_shockwaves.add(note_idx)
                            continue

                        if event.hold_duration > 0:
                            hold_px = int(event.hold_duration * g.scroll_speed)
                            hold_rect_h = radius * 2

                            if note_from_left:
                                hold_rect_x = int(marker_x) - hold_px
                                hold_rect_w = hold_px
                                if hold_rect_x < timeline_start_x:
                                    clip = timeline_start_x - hold_rect_x
                                    hold_rect_x = timeline_start_x
                                    hold_rect_w -= clip
                            else:
                                hold_rect_x = int(marker_x)
                                hold_rect_w = hold_px
                                if hold_rect_x + hold_rect_w > timeline_end_x:
                                    hold_rect_w = timeline_end_x - hold_rect_x

                            if hold_rect_w > 0:
                                hold_surf = pygame.Surface((hold_rect_w, hold_rect_h), pygame.SRCALPHA)
                                hold_color = (255, 80, 80, 160) if is_missed else (255, 200, 40, 140)
                                pygame.draw.rect(hold_surf, hold_color,
                                                 (0, 0, hold_rect_w, hold_rect_h),
                                                 border_radius=radius)
                                g.screen.blit(hold_surf, (hold_rect_x, timeline_y - radius))

                        if event.hold_duration > 0:
                            note_surf = g.default_note_img
                            if is_missed:
                                note_surf = note_surf.copy()
                                note_surf.fill((255, 80, 80, 0), special_flags=pygame.BLEND_RGBA_MULT)
                            g.screen.blit(note_surf, note_surf.get_rect(center=(int(marker_x), timeline_y)))
                        else:
                            note_color = self._note_color_map.get(event.timestamp, 'blue')
                            _fa = g._fast_note_alpha  # 0.0 = normal, 1.0 = fast

                            normal_surf = g.note_sprites[note_color]

                            # Build fast_surf whenever alpha > 0 (fading in or fully fast)
                            fast_surf = None
                            if _fa > 0.0:
                                seq = g.fast_note_sprites.get(note_color)
                                fast_base = (seq.current if seq and seq.ready else None) or normal_surf
                                if g.scroll_speed >= g.FAST_NOTE_THRESHOLD:
                                    _t = max(0.0, min(1.0, (g.scroll_speed - g.FAST_NOTE_THRESHOLD)
                                                           / (g.FAST_NOTE_MAX_SPEED - g.FAST_NOTE_THRESHOLD)))
                                else:
                                    _t = 0.0
                                _sx = 1.0 + _t * 0.5
                                w, h = fast_base.get_size()
                                fast_surf = pygame.transform.smoothscale(fast_base, (int(w * _sx), h))
                                if note_from_left:
                                    fast_surf = pygame.transform.flip(fast_surf, True, False)

                            def _tint_missed(s):
                                s = s.copy()
                                s.fill((255, 80, 80, 0), special_flags=pygame.BLEND_RGBA_MULT)
                                return s

                            if _fa <= 0.0 or fast_surf is None:
                                # Fully normal sprite
                                ns = _tint_missed(normal_surf) if is_missed else normal_surf
                                g.screen.blit(ns, ns.get_rect(center=(int(marker_x), timeline_y)))
                            elif _fa >= 1.0:
                                # Fully fast sprite
                                fs = _tint_missed(fast_surf) if is_missed else fast_surf
                                g.screen.blit(fs, fs.get_rect(center=(int(marker_x), timeline_y)))
                            else:
                                # Cross-fade: draw normal fading out, fast fading in
                                ns = normal_surf.copy()
                                ns.fill((255, 255, 255, int((1.0 - _fa) * 255)), special_flags=pygame.BLEND_RGBA_MULT)
                                if is_missed:
                                    ns.fill((255, 80, 80, 0), special_flags=pygame.BLEND_RGBA_MULT)
                                g.screen.blit(ns, ns.get_rect(center=(int(marker_x), timeline_y)))
                                fs = fast_surf.copy()
                                fs.fill((255, 255, 255, int(_fa * 255)), special_flags=pygame.BLEND_RGBA_MULT)
                                if is_missed:
                                    fs.fill((255, 80, 80, 0), special_flags=pygame.BLEND_RGBA_MULT)
                                g.screen.blit(fs, fs.get_rect(center=(int(marker_x), timeline_y)))
