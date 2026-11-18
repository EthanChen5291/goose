"""
EffectsMixin — particle effects, shockwaves, and hit bursts for the Game class.
Mixed into Game via multiple inheritance; all methods use `self` freely.
"""
import pygame
from typing import Optional, Any
from .. import models as M


class EffectsMixin:
    screen: pygame.Surface
    rhythm: Any  # Or import and use the actual RhythmManager type
    song: M.Song
    drop_note_indices: dict[int, int]
    drops_triggered: set[int]

    # ── Animation / Asset expected attributes ──
    _hurt_frames: list[pygame.Surface]
    _hurt_playing: bool
    _hurt_frame_idx: float
    _hurt_fps: float
    _bop_frames: list[pygame.Surface]
    _bop_surf: Optional[pygame.Surface]

    # ── Particle/Effect lists ──
    shockwaves: list[M.Shockwave]
    _hold_particles: list[dict[str, Any]]
    _hit_bursts: list[dict[str, Any]]
    _note_hit_anims: list[dict[str, Any]]
    _note_hit_frames: list[pygame.Surface]
    note_hit_frames: dict[str, list[pygame.Surface]]
    _note_hit_fps: float
    _judgment_glow_cache: dict[str, pygame.Surface]
    _judgment_label: Optional[dict[str, Any]]
    _perfect_rings: list[dict[str, Any]]

    # ── Screen shake ──
    _shake_x: float
    _shake_sequence: list   # list of (target_x: float, step_dur: float)
    _shake_seq_idx: int
    _shake_step_elapsed: float

    def _trigger_screen_shake(self, intensity: float) -> None:
        """Generate a rotational shake sequence keyed to intensity (0–1).

        Each call resets the sequence so the shake stays beat-synced.
        _shake_x holds the current rotation angle in degrees; per-frame
        roughness noise is added by the renderer.

        Sequence: 2–4 alternating tilt steps, then a return-to-zero step.
        """
        import random as _rnd

        mag     = 0.36 + intensity * 1.32  # 0.36–1.68 degrees peak rotation (−40 %)
        n_steps = _rnd.randint(2, 4)
        direction = _rnd.choice((-1, 1))

        seq: list[tuple[float, float]] = []
        for k in range(n_steps):
            step_mag = mag * _rnd.uniform(0.55, 1.00) * (0.78 ** k)
            step_dur = _rnd.uniform(0.055, 0.095)
            seq.append((direction * step_mag, step_dur))
            direction = -direction

        seq.append((0.0, 0.060))          # return to upright

        self._shake_sequence = seq
        self._shake_seq_idx = 0
        self._shake_step_elapsed = 0.0

    def update_screen_shake(self, dt: float) -> None:
        """Advance the shake sequence and update _shake_x (degrees) each frame."""
        if self._shake_seq_idx >= len(self._shake_sequence):
            # Dampen residual angle back to zero
            if abs(self._shake_x) > 0.01:
                self._shake_x *= max(0.0, 1.0 - dt * 22.0)
            else:
                self._shake_x = 0.0
            return

        target_angle, step_dur = self._shake_sequence[self._shake_seq_idx]
        self._shake_x += (target_angle - self._shake_x) * min(1.0, dt * 28.0)
        self._shake_step_elapsed += dt
        if self._shake_step_elapsed >= step_dur:
            self._shake_step_elapsed -= step_dur
            self._shake_seq_idx += 1

    def trigger_hurt(self):
        """Queue one playthrough of noki_hurt on top of noki_bop."""
        if not self._hurt_frames:
            return
        if self._hurt_playing:
            self._hurt_frame_idx = 0.0
        else:
            self._hurt_playing = True
            self._hurt_frame_idx = 0.0

    def update_hurt_animation(self, dt: float):
        """Advance hurt frame at 115% speed. Returns the current hurt surface, or None when done."""
        if not self._hurt_playing or not self._hurt_frames:
            return None
        self._hurt_frame_idx += self._hurt_fps * dt * 1.15
        n = len(self._hurt_frames)
        if self._hurt_frame_idx >= n:
            self._hurt_playing = False
            self._hurt_frame_idx = 0.0
            return None
        return self._hurt_frames[int(self._hurt_frame_idx)]

    def update_cat_animation(self):
        """Select noki_bop frame, synced to song beat_times."""
        import time
        if not self._bop_frames:
            return

        n = len(self._bop_frames)
        elapsed   = time.perf_counter() - self.rhythm.start_time
        song_time = elapsed - self.rhythm.lead_in
        beat_times = self.song.beat_times

        BOP_MAX_BPM = 250.0  # clamp animation speed to this BPM; halve if faster

        if beat_times and len(beat_times) >= 2 and song_time >= beat_times[0]:
            current_beat_idx = 0
            for i, bt in enumerate(beat_times):
                if bt <= song_time:
                    current_beat_idx = i
                else:
                    break
            if current_beat_idx < len(beat_times) - 1:
                beat_start = beat_times[current_beat_idx]
                beat_end   = beat_times[current_beat_idx + 1]
                phase = (song_time - beat_start) / (beat_end - beat_start)
                beat_dur_local = beat_end - beat_start
            else:
                phase = 0.0
                beat_dur_local = 60.0 / self.song.bpm
            if beat_dur_local < 60.0 / BOP_MAX_BPM:
                normalized = ((current_beat_idx % 4) + phase) / 4.0
            else:
                normalized = ((current_beat_idx % 2) + phase) / 2.0
        else:
            beat_dur   = 60.0 / self.song.bpm
            if self.song.bpm > BOP_MAX_BPM:
                normalized = (elapsed / beat_dur % 4.0) / 4.0
            else:
                normalized = (elapsed / beat_dur % 2.0) / 2.0

        frame_idx = int(normalized * n) % n
        self._bop_surf = self._bop_frames[frame_idx]

    def _try_screen_shake(self, intensity: float, song_time: float) -> None:
        """Trigger a screen shake only once per measure."""
        measure_dur = getattr(self, 'beat_duration', 0.5) * 4
        current_measure = int(song_time / measure_dur) if measure_dur > 0 else 0
        if current_measure == getattr(self, '_last_shake_measure', -1):
            return
        self._last_shake_measure = current_measure
        self._trigger_screen_shake(intensity)

    def trigger_shockwave(self):
        """Spawn multiple expanding shockwave rings and shake the screen."""
        center_x = self.screen.get_width() // 2
        center_y = self.screen.get_height() // 2

        num_rings = 5
        for i in range(num_rings):
            initial_radius = i * 30
            shockwave = M.Shockwave(
                center_x=center_x,
                center_y=center_y,
                radius=initial_radius,
                max_radius=800,
                alpha=150,
                thickness=4,
                speed=400 + i * 50
            )
            self.shockwaves.append(shockwave)

        import time as _time
        _song_time = _time.perf_counter() - self.rhythm.start_time - self.rhythm.lead_in
        self._try_screen_shake(0.75, _song_time)

    _NOTE_THEME_COLORS = {
        'blue':   (142, 204, 255),
        'pink':   (255, 170, 241),
        'green':  (142, 255, 194),
        'orange': (255, 193, 142),
    }

    def _spawn_hit_particles(self, x: int, y: int, color: str = 'blue'):
        """Spawn themed + white particles at (x, y) for any correct hit."""
        import random as _rnd
        theme_rgb = self._NOTE_THEME_COLORS.get(color, (255, 210, 60))
        for _ in range(2):
            self._hold_particles.append({
                'x': float(x) + _rnd.uniform(-12, 12),
                'y': float(y) + _rnd.uniform(-14, 14),
                'vx': _rnd.uniform(-175, 175),
                'vy': _rnd.uniform(-210, 55),
                'alpha': 220.0,
                'radius': _rnd.uniform(3.75, 7.5),
                'color': theme_rgb,
            })
        for _ in range(3):
            self._hold_particles.append({
                'x': float(x) + _rnd.uniform(-10, 10),
                'y': float(y) + _rnd.uniform(-12, 12),
                'vx': _rnd.uniform(-290, 290),
                'vy': _rnd.uniform(-340, 80),
                'alpha': 190.0,
                'radius': _rnd.uniform(1.5, 3.3),
                'color': (240, 240, 255),
            })

    def trigger_hit_ripple(self, x: int, y: int):
        """Spawn the bubble-style 3-layer hit burst at (x, y)."""
        import random as _rnd
        NOTE_R = 14 * 0.6 * 0.6 * 1.1
        _palette = _rnd.choice([
            {'l3': (157, 187, 223), 'l2o': (124, 154, 208), 'l2i': (155, 179, 227), 'l1': (197, 215, 239)},
            {'l3': (214, 166, 196), 'l2o': (200, 140, 176), 'l2i': (225, 165, 201), 'l1': (238, 202, 220)},
            {'l3': (220, 195, 100), 'l2o': (205, 170,  75), 'l2i': (235, 205, 120), 'l1': (248, 232, 165)},
        ])
        self._hit_bursts.append({
            'x': x, 'y': y,
            'age': 0.0,
            'l1_dur': 0.10,
            'l1_r': NOTE_R,
            'l2_dur': 0.20,
            'l2_r0': NOTE_R * 0.8,
            'l2_r1': NOTE_R * 2.5,
            'l3_delay': 0.03,
            'l3_dur': 0.25,
            'l3_r0': NOTE_R * 1.0,
            'l3_r1': NOTE_R * 3.2,
            'pal': _palette,
        })

    def trigger_miss_shockwave(self, x: int, y: int):
        """Spawn a small shockwave at a missed note position."""
        shockwave = M.Shockwave(
            center_x=x,
            center_y=y,
            radius=5,
            max_radius=40,
            alpha=200,
            thickness=2,
            speed=150
        )
        self.shockwaves.append(shockwave)

    def check_drop_note_hit(self, hit_note_idx: int):
        """Check if the hit note is any drop note and trigger shockwave."""
        for drop_idx, note_idx in self.drop_note_indices.items():
            if drop_idx not in self.drops_triggered and hit_note_idx == note_idx:
                self.trigger_shockwave()
                self.drops_triggered.add(drop_idx)

    def update_shockwaves(self, dt: float):
        """Update and render active shockwaves."""
        surviving = []
        for wave in self.shockwaves:
            if wave.update(dt):
                surviving.append(wave)
                self.render_shockwave(wave)
        self.shockwaves = surviving

    def update_hold_particles(self, dt: float):
        """Tick and render hold-note impact particles."""
        surviving = []
        for p in self._hold_particles:
            p['x']     += p['vx'] * dt
            p['y']     += p['vy'] * dt
            p['vy']    += 120 * dt
            p['alpha'] -= 420 * dt
            if p['alpha'] > 0:
                surviving.append(p)
                r = int(p['radius'])
                sz = r * 2 + 1
                surf = pygame.Surface((sz, sz), pygame.SRCALPHA)
                col = p.get('color', (255, 210, 60))
                pygame.draw.circle(surf, (*col, int(p['alpha'])), (r, r), r)
                self.screen.blit(surf, (int(p['x'] - r), int(p['y'] - r)))
        self._hold_particles = surviving

    def update_hit_bursts(self, dt: float):
        """Tick and render osu!-style 3-layer hit bursts."""
        surviving = []
        for b in self._hit_bursts:
            b['age'] += dt
            age = b['age']
            x, y = b['x'], b['y']
            surf_sz = int(b['l3_r1'] * 2 + 12)
            if surf_sz < 4:
                surviving.append(b)
                continue
            surf = pygame.Surface((surf_sz, surf_sz), pygame.SRCALPHA)
            cx = cy = surf_sz // 2

            _A = 0.4
            pal = b.get('pal', {'l3': (140,148,180), 'l2o': (120,110,155), 'l2i': (155,138,185), 'l1': (210,210,225)})

            # ── Layer 3: trailing ring ──
            l3_age = age - b['l3_delay']
            if 0 < l3_age < b['l3_dur']:
                t3 = l3_age / b['l3_dur']
                r3 = b['l3_r0'] + (b['l3_r1'] - b['l3_r0']) * t3
                a3 = int(160 * (1.0 - t3) * _A)
                thick3 = max(9, min(11, int(11 * (1.0 - t3 * 0.3))))
                for k in range(3):
                    fade = int(a3 * (1.0 - k * 0.28))
                    if fade <= 0:
                        break
                    pygame.draw.circle(surf, (*pal['l3'], fade),
                                       (cx, cy), max(1, int(r3) + k), max(1, thick3 - k))

            # ── Layer 2: primary ring ──
            if age < b['l2_dur']:
                t2 = age / b['l2_dur']
                r2 = b['l2_r0'] + (b['l2_r1'] - b['l2_r0']) * t2
                a2 = int(255 * (1.0 - t2) * _A)
                thick2 = max(9, min(11, int(11 * (1.0 - t2 * 0.3))))
                pygame.draw.circle(surf, (*pal['l2o'], a2),
                                   (cx, cy), max(1, int(r2)), thick2)
                pygame.draw.circle(surf, (*pal['l2i'], min(255, int(a2 * 1.15))),
                                   (cx, cy), max(1, int(r2) - thick2 // 2), max(2, thick2 // 2 + 1))

            # ── Layer 1: soft center flash ──
            if age < b['l1_dur']:
                t1 = age / b['l1_dur']
                a1 = int(220 * (1.0 - t1) ** 1.5 * _A)
                r1 = int(b['l1_r'] * (1.0 - t1 * 0.35))
                if r1 > 0:
                    pygame.draw.circle(surf, (*pal['l1'], a1), (cx, cy), r1)

            self.screen.blit(surf, (x - cx, y - cy),
                             special_flags=pygame.BLEND_RGBA_ADD)

            if age < b['l3_delay'] + b['l3_dur']:
                surviving.append(b)

        self._hit_bursts = surviving

    # ── Hitmarker glow constants ──────────────────────────────────────────────
    _GLOW_RISE_DUR  = 0.10   # seconds to ease in to peak alpha
    _GLOW_FALL_DUR  = 0.22   # seconds to fade out from peak alpha
    _GLOW_PEAK      = 178    # peak alpha (≈ 70% of 255)
    _GLOW_SCALE     = 1.0    # glow image drawn at same size as hitmarker

    def update_hitmarker_glow(self, dt: float):
        """Advance glow flash timer for press hitmarker overlay."""
        total = self._GLOW_RISE_DUR + self._GLOW_FALL_DUR
        if self._glow_press_t >= 0:
            self._glow_press_t += dt
            if self._glow_press_t >= total:
                self._glow_press_t = -1.0

    def _glow_alpha(self, t: float) -> int:
        """Map elapsed glow time → alpha (0–255)."""
        if t < 0:
            return 0
        if t < self._GLOW_RISE_DUR:
            return int(self._GLOW_PEAK * (t / self._GLOW_RISE_DUR) ** 0.5)
        ft = t - self._GLOW_RISE_DUR
        if ft < self._GLOW_FALL_DUR:
            return int(self._GLOW_PEAK * (1.0 - ft / self._GLOW_FALL_DUR))
        return 0

    def render_shockwave(self, wave: M.Shockwave):
        """Render a single shockwave ring."""
        if wave.alpha <= 0 or wave.radius <= 0:
            return

        diameter = int(wave.radius * 2) + wave.thickness * 2
        if diameter <= 0:
            return

        surface = pygame.Surface((diameter, diameter), pygame.SRCALPHA)
        r, g, b = wave.color
        color = (r, g, b, wave.alpha)
        center = diameter // 2
        if wave.thickness > 0 and wave.radius > 0:
            pygame.draw.circle(surface, color, (center, center), int(wave.radius), wave.thickness)

        blit_x = int(wave.center_x - center)
        blit_y = int(wave.center_y - center)
        self.screen.blit(surface, (blit_x, blit_y))

    def _spawn_repeat_word_particles(self, wx: int, wy: int) -> None:
        """Spawn small white particles that fall downward from the repeat word on iteration complete."""
        import random as _rnd
        for _ in range(14):
            self._hold_particles.append({
                'x': float(wx) + _rnd.uniform(-50, 50),
                'y': float(wy) + _rnd.uniform(-8, 8),
                'vx': _rnd.uniform(-40, 40),
                'vy': _rnd.uniform(20, 110),   # downward fall
                'alpha': 220.0,
                'radius': _rnd.uniform(1.8, 3.8),
                'color': (255, 255, 255),
            })

    def trigger_repeat_word_shockwave(self, color_rgb: tuple, wx: int, wy: int) -> None:
        """Spawn colored expanding rings at the word position on repeat iteration complete."""
        for i in range(3):
            self.shockwaves.append(M.Shockwave(
                center_x=wx,
                center_y=wy,
                radius=float(i * 18),
                max_radius=500,
                alpha=210,
                thickness=3,
                speed=310 + i * 45,
                color=color_rgb,
            ))

    def trigger_note_hit_anim(self, x: int, y: int, color: str = 'red') -> None:
        """Spawn a note_hit png-sequence animation centered at (x, y)."""
        self._note_hit_anims.append({'x': x, 'y': y, 'frame': 0.0, 'color': color})

    def update_note_hit_anims(self, dt: float) -> None:
        """Advance and render all active note_hit animations."""
        surviving = []
        for anim in self._note_hit_anims:
            frames = self.note_hit_frames.get(anim['color'], self._note_hit_frames)
            if not frames:
                continue
            fi = int(anim['frame'])
            if fi < len(frames):
                surf = frames[fi]
                rect = surf.get_rect(center=(anim['x'], anim['y']))
                self.screen.blit(surf, rect)
                anim['frame'] += self._note_hit_fps * dt
                surviving.append(anim)
        self._note_hit_anims = surviving

    # ------------------------------------------------------------------
    # Judgment label (PERFECT / GOOD / OK)
    # ------------------------------------------------------------------

    def trigger_judgment(self, judgment: str, x: int, y: int) -> None:
        """Spawn a rotating judgment label above (x, y). Replaces any active one."""
        key = judgment.lower()
        if key not in self._judgment_glow_cache:
            return
        self._judgment_label = {
            'key': key,
            'x': x,
            'y': y,
            't': 0.0,
            'rings_spawned': False,
        }
        self._perfect_rings = []

    def _draw_judgment_label(self, dt: float) -> None:
        """Advance and draw the active judgment label and perfect rings."""
        import math
        import random as _rnd

        # --- advance rings
        surviving = []
        for ring in self._perfect_rings:
            ring['radius'] += ring['speed'] * dt
            ring['alpha'] -= ring['fade_rate'] * dt
            if ring['alpha'] > 0:
                surviving.append(ring)
        self._perfect_rings = surviving

        # --- draw rings (thicker stroke, lower opacity)
        for ring in self._perfect_rings:
            a = max(0, int(ring['alpha']))
            r = int(ring['radius'])
            if r < 1:
                continue
            pad = 8
            ring_surf = pygame.Surface((r * 2 + pad * 2, r * 2 + pad * 2), pygame.SRCALPHA)
            pygame.draw.circle(ring_surf, (*ring['color'], a), (r + pad, r + pad), r, 5)
            self.screen.blit(ring_surf, (int(ring['x']) - r - pad, int(ring['y']) - r - pad))

        # --- draw label
        if self._judgment_label is None:
            return

        lbl = self._judgment_label
        lbl['t'] += dt

        _SPIN_DUR  = 0.16  # fast spin-in + size pop
        _HOLD_DUR  = 0.5   # seconds to hold
        _FADE_DUR  = 0.35  # seconds to fade out
        _TOTAL     = _SPIN_DUR + _HOLD_DUR + _FADE_DUR
        _MAX_ALPHA = 229   # 90% opacity
        _START     = math.pi / 3    # start angle
        _TARGET    = math.pi / 2.2  # target angle
        t = lbl['t']

        if t >= _TOTAL:
            self._judgment_label = None
            return

        # scale: starts very small, eases out aggressively to 1.0 during spin-in
        if t < _SPIN_DUR:
            p = t / _SPIN_DUR
            ease = 1.0 - (1.0 - p) ** 4  # steep ease-out: fast rise, then settles
            scale = 0.05 + 0.95 * ease
        else:
            scale = 1.0

        # alpha: 90% opacity immediately during spin-in, fade out at end
        if t < _SPIN_DUR + _HOLD_DUR:
            alpha = _MAX_ALPHA
        else:
            fade_progress = (t - _SPIN_DUR - _HOLD_DUR) / _FADE_DUR
            alpha = int((1.0 - fade_progress) * _MAX_ALPHA)

        # rotation: lerps _START → _TARGET during spin-in, then holds
        if t < _SPIN_DUR:
            angle_rad = _START + (t / _SPIN_DUR) * (_TARGET - _START)
        else:
            angle_rad = _TARGET
        # pi/2 would be horizontal; convert to pygame degrees (0 = horizontal)
        pygame_deg = math.degrees(math.pi / 2 - angle_rad)

        # spawn perfect rings exactly when spin-in ends
        if lbl['key'] == 'perfect' and not lbl['rings_spawned'] and t >= _SPIN_DUR:
            lbl['rings_spawned'] = True
            _PERFECT_COLOR = (0xFF, 0xDE, 0x7B)
            count = _rnd.randint(2, 4)
            for _ in range(count):
                self._perfect_rings.append({
                    'x': float(lbl['x']),
                    'y': float(lbl['y']),
                    'radius': float(_rnd.randint(4, 10)),
                    'speed': float(_rnd.uniform(350, 550)),    # much quicker travel
                    'alpha': float(_rnd.uniform(68, 88)),      # 60% less opacity
                    'fade_rate': float(_rnd.uniform(380, 520)), # quicker fade-out
                    'color': _PERFECT_COLOR,
                })

        glow_surf = self._judgment_glow_cache[lbl['key']]
        rotated = pygame.transform.rotozoom(glow_surf, pygame_deg, scale)
        rotated.set_alpha(alpha)
        self.screen.blit(rotated, rotated.get_rect(center=(lbl['x'], lbl['y'])))
