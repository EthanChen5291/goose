"""
TimelineRenderer — draws the timeline bar, beat grid, mode indicators,
speed arrows, bounce obstacles, and progress bar.
Instantiated and owned by Game; accesses game state via self.game.
"""
import pygame


class TimelineRenderer:

    def __init__(self, game) -> None:
        self.game = game
        self._timeline_glow_surf: pygame.Surface | None = None
        self._timeline_glow_w: int = 0

    # ------------------------------------------------------------------
    # Marker helpers
    # ------------------------------------------------------------------

    def draw_dual_side_marker(self, x: int, timeline_y: int) -> None:
        """Draw a dual-side mode activation marker (two arrows pointing inward)."""
        g = self.game
        arrow_height = 60
        arrow_width = 12

        left_color = (100, 200, 255)
        right_color = (255, 200, 100)

        top_y = timeline_y - arrow_height // 2
        bottom_y = timeline_y + arrow_height // 2
        center_y = timeline_y

        left_x = x - 15
        left_points = [
            (left_x + arrow_width, center_y),
            (left_x, top_y),
            (left_x, bottom_y),
        ]
        pygame.draw.polygon(g.screen, left_color, left_points)
        pygame.draw.polygon(g.screen, (255, 255, 255), left_points, 2)

        right_x = x + 15
        right_points = [
            (right_x - arrow_width, center_y),
            (right_x, top_y),
            (right_x, bottom_y),
        ]
        pygame.draw.polygon(g.screen, right_color, right_points)
        pygame.draw.polygon(g.screen, (255, 255, 255), right_points, 2)

    def draw_speed_arrow(self, x: int, timeline_y: int, timeline_height: int, speed_up: bool) -> None:
        """Draw a speed change arrow spanning the full measure line."""
        g = self.game
        if speed_up:
            arrow_color = (0, 200, 255)
        else:
            arrow_color = (200, 150, 100)

        arrow_height = timeline_height
        arrow_width = 24

        top_y = timeline_y - arrow_height // 2
        bottom_y = timeline_y + arrow_height // 2
        center_y = timeline_y

        if speed_up:
            for offset in [-8, 8]:
                points = [
                    (x - arrow_width // 2 + offset, top_y),
                    (x + arrow_width // 2 + offset, center_y),
                    (x - arrow_width // 2 + offset, bottom_y),
                ]
                pygame.draw.polygon(g.screen, arrow_color, points)
                pygame.draw.polygon(g.screen, (255, 255, 255), points, 2)
        else:
            for offset in [-8, 8]:
                points = [
                    (x + arrow_width // 2 + offset, top_y),
                    (x - arrow_width // 2 + offset, center_y),
                    (x + arrow_width // 2 + offset, bottom_y),
                ]
                pygame.draw.polygon(g.screen, arrow_color, points)
                pygame.draw.polygon(g.screen, (200, 220, 255), points, 2)

    def draw_bounce_obstacle(self, x: int, timeline_y: int) -> None:
        """Draw a diamond-shaped bounce obstacle."""
        g = self.game
        size = 12
        points = [
            (x, timeline_y - size),
            (x + size, timeline_y),
            (x, timeline_y + size),
            (x - size, timeline_y),
        ]
        pygame.draw.polygon(g.screen, (255, 80, 200), points)
        pygame.draw.polygon(g.screen, (255, 255, 255), points, 2)

    # ------------------------------------------------------------------
    # Main render call
    # ------------------------------------------------------------------

    def render(
        self,
        current_time: float,
        timeline_y: int,
        timeline_start_x: int,
        timeline_end_x: int,
        hit_marker_x: float,
    ) -> None:
        g = self.game

        # --- timeline bar
        if g._timeline_flash > 0.01:
            r = int(255)
            gr = int(255 * (1.0 - g._timeline_flash))
            b = int(255 * (1.0 - g._timeline_flash))
            timeline_color = (r, gr, b)
            g._timeline_flash *= 0.85
        else:
            timeline_color = (255, 255, 255)
            g._timeline_flash = 0.0

        # --- timeline glow
        line_w = timeline_end_x - timeline_start_x
        if self._timeline_glow_surf is None or self._timeline_glow_w != line_w:
            glow_pad = 100
            glow_h = 6 + glow_pad * 2
            base = pygame.Surface((line_w, glow_h), pygame.SRCALPHA)
            pygame.draw.line(base, (255, 255, 255), (0, glow_h // 2), (line_w, glow_h // 2), 6)
            blurred = base
            for _ in range(3):
                small = pygame.transform.smoothscale(blurred, (max(1, line_w // 5), max(1, glow_h // 5)))
                blurred = pygame.transform.smoothscale(small, (line_w, glow_h))
            self._timeline_glow_surf = blurred
            self._timeline_glow_w = line_w

        _glow = self._timeline_glow_surf.copy()
        _glow.fill((*timeline_color, 255), special_flags=pygame.BLEND_RGBA_MULT)
        _blit_y = timeline_y - self._timeline_glow_surf.get_height() // 2
        g.screen.blit(_glow, (timeline_start_x, _blit_y))
        g.screen.blit(_glow, (timeline_start_x, _blit_y))

        pygame.draw.line(
            g.screen, timeline_color,
            (timeline_start_x, timeline_y),
            (timeline_end_x, timeline_y), 6,
        )

        # --- hitmarker shake (miss) + scale (correct hit)
        import math as _math
        _shake_x_off = 0
        if g._hm_shake_t > 0:
            _shake_x_off = int(_math.sin(g._hm_shake_t * 42) * 3 * g._hm_shake_t)

        _hm_cx = int(hit_marker_x) + _shake_x_off
        _hm_cy = timeline_y

        def _scaled_blit(surf):
            s = g._hm_scale
            if abs(s - 1.0) > 0.002:
                w, h = surf.get_size()
                surf = pygame.transform.smoothscale(surf, (int(w * s), int(h * s)))
            g.screen.blit(surf, surf.get_rect(center=(_hm_cx, _hm_cy)))

        _hm_rect = g.hitmarker_img.get_rect(center=(_hm_cx, _hm_cy))

        # --- speed/slow hitmarker (one-shot); hides static hitmarker + glow while playing
        _hm_state = g._hitmarker_anim_state
        _hm_fi = int(g._hitmarker_anim_frame)
        _hm_anim_playing = False
        if _hm_state == 'speed_up':
            _hm_frames = g._speed_hitmarker_frames
            if _hm_frames and _hm_fi < len(_hm_frames):
                _scaled_blit(_hm_frames[_hm_fi])
                _hm_anim_playing = True
        elif _hm_state == 'speed_up_mild':
            _hm_frames = g._speed2_hitmarker_frames
            if _hm_frames and _hm_fi < len(_hm_frames):
                _scaled_blit(_hm_frames[_hm_fi])
                _hm_anim_playing = True
        elif _hm_state == 'slow_down':
            _hm_frames = g._slow_hitmarker_frames
            if _hm_frames and _hm_fi < len(_hm_frames):
                _scaled_blit(_hm_frames[_hm_fi])
                _hm_anim_playing = True

        if not _hm_anim_playing:
            _scaled_blit(g.hitmarker_img)

        # --- hitmarker glow overlays (press = white flash, hold = persistent golden)
        if not _hm_anim_playing:
            _press_a = g._glow_alpha(g._glow_press_t)
            if _press_a > 0:
                _glow = g.glowed_hitmarker_img.copy()
                _glow.fill((255, 255, 255, _press_a), special_flags=pygame.BLEND_RGBA_MULT)
                _scaled_blit(_glow)
            if g.rhythm._active_hold is not None:
                _glow = g.glowed_hitmarker_golden_img.copy()
                _glow.fill((255, 255, 255, 178), special_flags=pygame.BLEND_RGBA_MULT)
                _scaled_blit(_glow)

        # --- beat grid lines
        beat_times = g.song.beat_times
        lead_in = g.rhythm.lead_in

        for i, beat_time in enumerate(beat_times):
            t = beat_time + lead_in
            time_until = t - current_time
            if g.bounce_active and not g.dual_side_active and g.bounce_reversed:
                x = hit_marker_x - time_until * g.scroll_speed
            else:
                x = hit_marker_x + time_until * g.scroll_speed

            if timeline_start_x <= x <= timeline_end_x:
                if i % 4 == 0:
                    _ml_fi = int(g._measureline_anim_frame)
                    _ml_state = g._measureline_anim_state
                    _ml_surf = g._measureline_img
                    if _ml_state == 'speed_up':
                        _ml_frames = g._speed_measureline_frames
                        if _ml_frames and _ml_fi < len(_ml_frames):
                            _ml_surf = _ml_frames[_ml_fi]
                    elif _ml_state == 'slow_down':
                        _ml_frames = g._slow_measureline_frames
                        if _ml_frames and _ml_fi < len(_ml_frames):
                            _ml_surf = _ml_frames[_ml_fi]
                    g.screen.blit(_ml_surf, _ml_surf.get_rect(center=(int(x), timeline_y)))
                else:
                    g.screen.blit(g._beatline_img,
                                  g._beatline_img.get_rect(center=(int(x), timeline_y)))

        # --- dual-side mode indicators
        if g.dual_side_visuals_active:
            arrow_size = 15
            arrow_y = timeline_y

            left_arrow_x = timeline_start_x + 30
            pygame.draw.polygon(
                g.screen,
                (100, 200, 255),
                [
                    (left_arrow_x, arrow_y),
                    (left_arrow_x - arrow_size, arrow_y - arrow_size // 2),
                    (left_arrow_x - arrow_size, arrow_y + arrow_size // 2),
                ],
            )

            right_arrow_x = timeline_end_x - 30
            pygame.draw.polygon(
                g.screen,
                (255, 200, 100),
                [
                    (right_arrow_x, arrow_y),
                    (right_arrow_x + arrow_size, arrow_y - arrow_size // 2),
                    (right_arrow_x + arrow_size, arrow_y + arrow_size // 2),
                ],
            )

        # --- dual-side section start markers
        for dual_sec in g.dual_side_sections:
            section_time = dual_sec.start_time + g.rhythm.lead_in
            time_until = section_time - current_time

            if -0.5 < time_until < 5.0:
                marker_x = hit_marker_x + time_until * g.scroll_speed
                if timeline_start_x <= marker_x <= timeline_end_x:
                    self.draw_dual_side_marker(int(marker_x), timeline_y)

        # --- speed change arrows
        timeline_height = 100

        for i, shift in enumerate(g.energy_shifts):
            shift_time = shift.start_time + lead_in
            time_until = shift_time - current_time

            if -0.5 < time_until < 5.0:
                if g.dual_side_active:
                    arrow_from_left = (i % 2 == 1)
                    if arrow_from_left:
                        arrow_x = hit_marker_x - (time_until * g.scroll_speed)
                    else:
                        arrow_x = hit_marker_x + (time_until * g.scroll_speed)
                elif g.bounce_active and g.bounce_reversed:
                    arrow_x = hit_marker_x - time_until * g.scroll_speed
                else:
                    arrow_x = hit_marker_x + time_until * g.scroll_speed

                if timeline_start_x <= arrow_x <= timeline_end_x:
                    speed_up = shift.energy_delta > 0
                    self.draw_speed_arrow(int(arrow_x), timeline_y, timeline_height, speed_up)

        # --- bounce obstacles
        for evt in g.bounce_events:
            evt_time = evt.time + lead_in
            time_until = evt_time - current_time
            if -0.5 < time_until < 5.0:
                if g.bounce_active and g.bounce_reversed:
                    obs_x = hit_marker_x - time_until * g.scroll_speed
                else:
                    obs_x = hit_marker_x + time_until * g.scroll_speed
                if timeline_start_x <= obs_x <= timeline_end_x:
                    self.draw_bounce_obstacle(int(obs_x), timeline_y)

        # --- progress bar (horizontal, top of screen)
        sw = g.screen.get_width()
        bar_y = 42
        bar_height = 20
        bar_width = int((sw - 80) * 0.32)
        word_center_x = sw // 2 + 30   # matches WordRenderer center_x (center_offset = base_char_spacing/2)
        bar_x = word_center_x - bar_width // 2
        border_r = 8

        total_notes = len(g.rhythm.beat_map)
        level_progress = min(1.0, g.rhythm.char_event_idx / total_notes) if total_notes > 0 else 0.0

        # Background track
        pygame.draw.rect(g.screen, (25, 28, 40), (bar_x, bar_y, bar_width, bar_height), border_radius=border_r)

        # Filled portion with diagonal stripe pattern
        filled_width = int(bar_width * level_progress)
        if filled_width > 0:
            # Build stripe pattern on an SRCALPHA surface
            fill_surf = pygame.Surface((filled_width, bar_height), pygame.SRCALPHA)
            fill_surf.fill((100, 200, 255, 255))  # light blue base

            # Diagonal slightly darker blue stripes (45-degree parallelograms)
            stripe_spacing = 18
            stripe_width = 9
            dark_blue = (60, 145, 215, 255)
            for sx in range(-bar_height, filled_width + bar_height, stripe_spacing):
                pts = [
                    (sx, 0),
                    (sx + stripe_width, 0),
                    (sx + stripe_width + bar_height, bar_height),
                    (sx + bar_height, bar_height),
                ]
                pygame.draw.polygon(fill_surf, dark_blue, pts)

            # Clip to rounded-rect shape using a white mask + BLEND_RGBA_MIN
            mask_surf = pygame.Surface((filled_width, bar_height), pygame.SRCALPHA)
            mask_surf.fill((0, 0, 0, 0))
            pygame.draw.rect(mask_surf, (255, 255, 255, 255), (0, 0, filled_width, bar_height), border_radius=border_r)
            fill_surf.blit(mask_surf, (0, 0), special_flags=pygame.BLEND_RGBA_MIN)

            g.screen.blit(fill_surf, (bar_x, bar_y))

            # Soft blur glow behind filled portion (same technique as text glow)
            _gp = 28
            _gw = filled_width + _gp * 2
            _gh = bar_height + _gp * 2
            glow_base = pygame.Surface((_gw, _gh), pygame.SRCALPHA)
            pygame.draw.rect(glow_base, (255, 255, 255, 255), (_gp, _gp, filled_width, bar_height), border_radius=border_r)
            _blurred = glow_base
            for _ in range(3):
                _small = pygame.transform.smoothscale(_blurred, (max(1, _gw // 5), max(1, _gh // 5)))
                _blurred = pygame.transform.smoothscale(_small, (_gw, _gh))
            _blurred.fill((100, 200, 255, 9), special_flags=pygame.BLEND_RGBA_MULT)
            g.screen.blit(_blurred, (bar_x - _gp, bar_y - _gp), special_flags=pygame.BLEND_RGBA_ADD)

        # White border
        pygame.draw.rect(g.screen, (255, 255, 255), (bar_x, bar_y, bar_width, bar_height), width=3, border_radius=border_r)
