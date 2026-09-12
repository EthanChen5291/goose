"""
Core Game class — init, run loop, pause, and main update tick.
Visual effects  → effects.py      (EffectsMixin)
Game mechanics  → mechanics.py    (MechanicsMixin)
Word rendering  → word_renderer.py     (WordRenderer)
Timeline render → timeline_renderer.py (TimelineRenderer)
Note rendering  → note_renderer.py     (NoteRenderer)
"""
import pygame
import sys
import time
import os
import math

from . import constants as C
from .rhythm import RhythmManager, calculate_lead_in
from .input import Input
from .beatmap_generator import generate_beatmap
from analysis.audio_analysis import (
    get_song_info,
    detect_drops,
    classify_pace,
    calculate_energy_shifts,
    calculate_scroll_tiers,
    detect_dual_side_sections,
    detect_climax_shake_beats,
)
from . import models as M
from .menu import PauseScreen
from .screens import SettingsPanel
from .menu_utils import _FONT
from .rendering.effects import EffectsMixin
from .mechanics import MechanicsMixin, BounceEvent
from .rendering.word_renderer import WordRenderer, build_letter_glow_cache, _make_glow_surface, _NOTE_COLOR_RGB
from .rendering.timeline_renderer import TimelineRenderer
from .rendering.note_renderer import NoteRenderer
from .rendering.edge_glitch import EdgeGlitchRenderer

pygame.init()


class Game(EffectsMixin, MechanicsMixin):
    def __init__(self, level, screen=None, clock=None, music=None) -> None:
        if screen is not None:
            self.screen = screen
        else:
            info = pygame.display.Info()
            screen_width, screen_height = info.current_w, info.current_h
            self.screen = pygame.display.set_mode((screen_width, screen_height), pygame.RESIZABLE)
            pygame.display.set_caption("Rhythm Typing Game")
        self.clock = clock if clock is not None else pygame.time.Clock()
        screen_width, screen_height = self.screen.get_size()
        self.running = False
        self.last_char_idx = -1
        self.used_current_char = False

        self.score = 0
        self.misses = 0
        self.font = pygame.font.Font(_FONT, 48)
        self.letter_glow_cache: dict[tuple, pygame.Surface] = build_letter_glow_cache(self.font)
        self._last_score = 0
        self._score_popups: list[dict] = []
        self._score_font = pygame.font.Font(_FONT, 56)
        self._popup_font = pygame.font.Font(_FONT, 38)
        _score_color = (255, 255, 255)
        self._score_glow_surf: pygame.Surface = _make_glow_surface(self._score_font, "0", _score_color, _score_color, glow_opacity=0.22)
        self._score_glow_val: int = 0

        self._hold_particles: list[dict] = []
        self._hit_bursts: list[dict] = []

        # --- judgment label (PERFECT / GOOD / OK) above hitmarker
        _hv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'assets', 'fonts', 'Heavitas.ttf')
        _PERFECT_COLOR = (0xFF, 0xDE, 0x7B)
        _GOOD_COLOR    = (0x83, 0xE3, 0xB0)
        _OK_COLOR      = (0xAE, 0xD0, 0xE6)
        _jf_ok      = pygame.font.Font(_hv_path, 17)
        _jf_good    = pygame.font.Font(_hv_path, 20)
        _jf_perfect = pygame.font.Font(_hv_path, 24)
        self._judgment_glow_cache: dict[str, pygame.Surface] = {
            'perfect': _make_glow_surface(_jf_perfect, 'PERFECT', _PERFECT_COLOR, _PERFECT_COLOR, glow_opacity=0.30),
            'good':    _make_glow_surface(_jf_good,    'GOOD',    _GOOD_COLOR,    _GOOD_COLOR,    glow_opacity=0.24),
            'ok':      _make_glow_surface(_jf_ok,      'OK',      _OK_COLOR,      _OK_COLOR,      glow_opacity=0.22),
        }
        self._judgment_label: dict | None = None
        self._perfect_rings: list[dict] = []

        self.message = None
        self.message_duration = 0.0

        self._last_displayed_word = None
        self._previous_word = None
        self._previous_word_full = None
        self._word_transition_start = 0.0

        # --- load quick assets first
        self.level = level
        abs_song_path = C._to_abs_path(level.song_path)
        if abs_song_path is None:
            raise ValueError(f"Invalid song path: {level.song_path}")
        self.song_path = abs_song_path

        assets_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'images')
        animations_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'animations')

        # Match title screen: cat height = 38% of screen (title screen uses 40%).
        _bop_target_h = max(300, int(screen_height * 0.38))
        self._bop_frames: list[pygame.Surface] = []
        self._bop_fps    = 30.0
        self._bop_native_bpm = 100.0
        self._bop_surf   = None
        self._hurt_frames: list[pygame.Surface] = []
        self._hurt_fps: float = 30.0

        self._hurt_playing: bool = False
        self._hurt_frame_idx: float = 0.0
        self._hurt_queued: int = 0

        self.cat_frame = None

        timeline_file = os.path.join(assets_path, 'noki_timeline.png')
        self.timeline_img = pygame.image.load(timeline_file).convert_alpha()
        self.timeline_img = pygame.transform.scale(self.timeline_img, (1920, 200))

        def _scale_to_height(surf, h):
            w0, h0 = surf.get_size()
            return pygame.transform.smoothscale(surf, (max(1, int(w0 * h / h0)), h))

        self._measureline_img = _scale_to_height(
            pygame.image.load(os.path.join(assets_path, 'measureline.png')).convert_alpha(), 100)
        self._beatline_img = _scale_to_height(
            pygame.image.load(os.path.join(assets_path, 'beatline.png')).convert_alpha(), 60)

        # Note sprite: canvas is 300px, note is ~1/8 of canvas (37.5px).
        # Procedural radius = 14 → diameter 28px. Scale full sprite so note portion matches.
        # 0.30 × 1.20 = 0.36 (+20% from previous size) → ~80px
        _NOTE_SPRITE_SIZE = int(300 * 28 / 37.5 * 0.54)  # 0.36 × 1.5

        def _load_note_sprite(name):
            return pygame.transform.smoothscale(
                pygame.image.load(os.path.join(assets_path, name)).convert_alpha(),
                (_NOTE_SPRITE_SIZE, _NOTE_SPRITE_SIZE),
            )

        def _load_hit_frames(folder):
            d = os.path.join(animations_path, folder)
            if not os.path.isdir(d):
                return []
            paths = sorted(
                os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith('.png')
            )
            return [
                pygame.transform.smoothscale(
                    pygame.image.load(p).convert_alpha(),
                    (_NOTE_SPRITE_SIZE, _NOTE_SPRITE_SIZE),
                )
                for p in paths
            ]

        # Keyed by color name: 'blue', 'pink', 'green', 'orange'
        self.note_sprites: dict[str, pygame.Surface] = {
            'blue':   _load_note_sprite('noki_note_blue.png'),
            'pink':   _load_note_sprite('noki_note_pink.png'),
            'green':  _load_note_sprite('noki_note_green.png'),
            'orange': _load_note_sprite('noki_note_orange.png'),
        }

        # Fast animated note sprites (PNG sequences) — shown when scroll_speed is high
        from .ui_components import PNGSequenceSprite as _PSS
        def _load_fast_seq(color_name):
            folder = os.path.join(animations_path, f'{color_name}_fast')
            return _PSS(folder, fps=18.0, scale=(_NOTE_SPRITE_SIZE, _NOTE_SPRITE_SIZE))
        self.fast_note_sprites: dict[str, _PSS] = {
            'blue':   _load_fast_seq('blue'),
            'pink':   _load_fast_seq('pink'),
            'green':  _load_fast_seq('green'),
            'orange': _load_fast_seq('orange'),
        }
        # Scroll speed threshold above which fast sprites replace static ones,
        # and the max speed used for the stretch ramp (1.0x at threshold → 1.5x at max).
        self.FAST_NOTE_THRESHOLD: float = 560.0
        self.FAST_NOTE_MAX_SPEED: float = 900.0
        # Cross-fade alpha: 0.0 = normal sprites, 1.0 = fast sprites (~4 frame transition)
        self._fast_note_alpha: float = 0.0
        _red_frames    = _load_hit_frames('noki_hit_red')
        _blue_frames   = _load_hit_frames('noki_hit_blue')
        _green_frames  = _load_hit_frames('noki_hit_green')
        _orange_frames = _load_hit_frames('noki_hit_orange')
        _pink_frames   = _load_hit_frames('noki_hit_pink')
        self.note_hit_frames: dict[str, list[pygame.Surface]] = {
            'blue':   _blue_frames,
            'pink':   _pink_frames or _red_frames,
            'green':  _green_frames,
            'orange': _orange_frames,
        }
        self._note_hit_fps: float = 24.0
        self._note_hit_anims: list[dict] = []  # {'x', 'y', 'frame': float, 'color': str}

        # hold_note.png used for hold notes
        self.default_note_img = _load_note_sprite('hold_note.png')
        self._note_hit_frames = _red_frames

        _hm_w = 2 * abs(C.HIT_MARKER_X_OFFSET)
        _hm_h = 2 * abs(C.HIT_MARKER_Y_OFFSET)
        self.hitmarker_img = pygame.transform.smoothscale(
            pygame.image.load(os.path.join(assets_path, 'hitmarker.png')).convert_alpha(),
            (_hm_w, _hm_h)
        )
        self.glowed_hitmarker_img = pygame.transform.smoothscale(
            pygame.image.load(os.path.join(assets_path, 'glowed_hitmarker.png')).convert_alpha(),
            (_hm_w, _hm_h)
        )
        self.glowed_hitmarker_golden_img = pygame.transform.smoothscale(
            pygame.image.load(os.path.join(assets_path, 'glowed_hitmarker_golden.png')).convert_alpha(),
            (_hm_w, _hm_h)
        )
        # One-shot frame lists for speed-up / slow-down hitmarker overlays
        # base_size: natural (unscaled) pixel size of the reference image; used to
        # compute the proportional target size when an animation sheet has a wider
        # canvas than the base sprite so the visible sprite ends up the same size.
        def _load_seq_frames(folder, target_size, base_size=None):
            d = os.path.join(animations_path, folder)
            if not os.path.isdir(d):
                return []
            paths = sorted(p for p in (os.path.join(d, f) for f in os.listdir(d)) if p.lower().endswith('.png'))
            frames = []
            for p in paths:
                img = pygame.image.load(p).convert_alpha()
                if base_size is not None:
                    iw, ih = img.get_size()
                    bw, bh = base_size
                    tw, th = target_size
                    scale = (round(tw * iw / bw), round(th * ih / bh))
                else:
                    scale = target_size
                frames.append(pygame.transform.smoothscale(img, scale))
            return frames

        _hm_raw = pygame.image.load(os.path.join(assets_path, 'hitmarker.png'))
        _hm_base_size = _hm_raw.get_size()
        _speed_hm_w = round(_hm_w * 1.28)
        _speed_hm_h = round(_hm_h * 1.01)
        _slow_hm_w  = round(_hm_w * 1.22)
        self._speed_hitmarker_frames:  list[pygame.Surface] = _load_seq_frames('speed_hitmarker',  (_speed_hm_w, _speed_hm_h), _hm_base_size)
        self._speed2_hitmarker_frames: list[pygame.Surface] = _load_seq_frames('speed2_hitmarker', (_speed_hm_w, _speed_hm_h), _hm_base_size)
        self._slow_hitmarker_frames:   list[pygame.Surface] = _load_seq_frames('slow_hitmarker',   (_slow_hm_w, _hm_h), _hm_base_size)

        _ml_w, _ml_h = self._measureline_img.get_size()
        _ml_raw = pygame.image.load(os.path.join(assets_path, 'measureline.png'))
        _ml_base_size = _ml_raw.get_size()
        self._speed_measureline_frames: list[pygame.Surface] = _load_seq_frames('measureline_speed', (_ml_w, _ml_h), _ml_base_size)
        self._slow_measureline_frames:  list[pygame.Surface] = _load_seq_frames('measureline_slow',  (_ml_w, _ml_h), _ml_base_size)

        # Independent one-shot animation states for hitmarker and measurelines
        self._hitmarker_anim_state:   str   = 'normal'
        self._measureline_anim_state: str   = 'normal'
        self._hitmarker_anim_frame:   float = 0.0
        self._measureline_anim_frame: float = 0.0
        # Previous-frame values for transition detection
        self._prev_dual_active:      bool = False
        self._prev_bounce_reversed:  bool = False
        # One-shot lock: True while a bounce-triggered animation is still playing.
        # Prevents the per-frame energy-state _set_hm/_set_ml from overriding it.
        self._hm_oneshot:  bool = False
        self._ml_oneshot:  bool = False

        # Glow flash state: elapsed seconds since trigger, -1 = inactive
        self._glow_press_t: float = -1.0

        # Hitmarker shake (miss) — countdown from 1.0 to 0.0 over 1 second
        self._hm_shake_t: float = 0.0
        # Hitmarker scale (correct hit) — bumps to 1.12, lerps back to 1.0
        self._hm_scale: float = 1.0


        # Petal spinner images
        _psz = 40
        _p1  = pygame.transform.smoothscale(
            pygame.image.load(os.path.join(assets_path, 'petal1.png')).convert_alpha(), (_psz, _psz))
        _p2  = pygame.transform.smoothscale(
            pygame.image.load(os.path.join(assets_path, 'petal2.png')).convert_alpha(), (_psz, _psz))
        _cx, _cy = screen_width // 2, screen_height // 2
        _radius  = 50

        # --- run heavy analysis in background thread ---
        import threading as _threading
        _result: dict = {}
        _errors: list = []

        def _worker():
            try:
                song       = get_song_info(self.song_path, expected_bpm=level.bpm, normalize=True)
                # Demon on canon songs: double the BPM for denser beat tracking if within range
                if level.difficulty == "demon" and level.bpm is None and song.bpm * 2 <= 300:
                    song = get_song_info(self.song_path, expected_bpm=int(song.bpm * 2), normalize=False)
                bdur       = 60 / song.bpm
                pace       = classify_pace(self.song_path, song.bpm)
                dual_secs  = detect_dual_side_sections(
                    self.song_path, song.bpm, pace.pace_score, song.beat_times)
                diff_prof  = C.DIFFICULTY_PROFILES.get(
                    level.difficulty, C.DIFFICULTY_PROFILES["classic"])
                drops      = detect_drops(song.beat_times, self.song_path, song.bpm)
                tiers      = calculate_scroll_tiers(
                    self.song_path, song.bpm, pace.pace_score, song.beat_times)
                shifts     = calculate_energy_shifts(
                    self.song_path, song.bpm, pace.pace_score, song.beat_times)
                beatmap    = generate_beatmap(
                    word_list=level.word_bank, song=song,
                    dual_side_sections=dual_secs, difficulty=level.difficulty,
                    energy_shifts=shifts, pace_score=pace.pace_score)
                lead_in    = calculate_lead_in(song.beat_times)
                rhythm     = RhythmManager(
                    beatmap, song.bpm, lead_in=lead_in,
                    timing_scale=diff_prof.timing_scale)
                shake_beats = detect_climax_shake_beats(
                    pace.pace_score, song.bpm, self.song_path, song.beat_times, tiers)
                print(f"[shake] pace_score={pace.pace_score:.3f}  bpm={song.bpm:.1f}  shake_beats={len(shake_beats)}")
                _result.update(song=song, beat_duration=bdur, pace_profile=pace,
                               dual_side_sections=dual_secs, difficulty_profile=diff_prof,
                               rhythm=rhythm, drop_events=drops, scroll_tiers=tiers,
                               energy_shifts=shifts, climax_shake_beats=shake_beats)
            except Exception as exc:
                _errors.append(exc)

        _thread = _threading.Thread(target=_worker, daemon=True)
        _thread.start()

        # ── Load noki_bop / noki_hurt from PNG sequences ──
        def _load_png_seq(folder_name: str) -> tuple[list[pygame.Surface], float]:
            folder = os.path.join(animations_path, folder_name)
            if not os.path.isdir(folder):
                return [], 30.0
            paths = sorted(
                os.path.join(folder, f) for f in os.listdir(folder)
                if f.lower().endswith('.png')
            )
            frames: list[pygame.Surface] = []
            for p in paths:
                img = pygame.image.load(p).convert_alpha()
                iw, ih = img.get_size()
                tw = max(1, int(iw * _bop_target_h / ih))
                frames.append(pygame.transform.smoothscale(img, (tw, _bop_target_h)))
            return frames, 30.0

        self._bop_frames,  self._bop_fps  = _load_png_seq('noki_bop')
        self._hurt_frames, self._hurt_fps = _load_png_seq('noki_hurt')

        # --- petal spinner loop ---
        _P1 = (60.0 / 45.0) / 0.7
        _P2 = _P1 * 0.65
        _P2_OFFSET = _P2 * 0.375

        _spin_start = time.time()
        _spin_clock = pygame.time.Clock()

        _SHADOW_STEPS  = 3
        _SHADOW_ALPHAS = [120, 60, 25]

        def _petal_angle(t_norm: float) -> float:
            if t_norm < 0.5:
                p    = t_norm / 0.5
                ease = p * p
                return math.pi / 2 - math.pi * ease
            else:
                p    = (t_norm - 0.5) / 0.5
                ease = 1.0 - (1.0 - p) ** 4
                return -math.pi / 2 - math.pi * ease

        _LAG_TIME = 0.045

        def _draw_petal_with_shadow(pimg, elapsed, period, offset):
            t_now  = ((elapsed + offset) % period) / period
            a_now  = _petal_angle(t_now)
            for step in range(_SHADOW_STEPS, 0, -1):
                past_elapsed = elapsed - _LAG_TIME * step
                t_past = ((past_elapsed + offset) % period) / period
                ghost_a = _petal_angle(t_past)
                gx  = _cx + _radius * math.cos(ghost_a)
                gy  = _cy - _radius * math.sin(ghost_a)
                grot  = pygame.transform.rotate(pimg, math.degrees(ghost_a))
                gsurf = grot.copy()
                gsurf.set_alpha(_SHADOW_ALPHAS[step - 1])
                self.screen.blit(gsurf, gsurf.get_rect(center=(int(gx), int(gy))))
            px  = _cx + _radius * math.cos(a_now)
            py  = _cy - _radius * math.sin(a_now)
            rot = pygame.transform.rotate(pimg, math.degrees(a_now))
            self.screen.blit(rot, rot.get_rect(center=(int(px), int(py))))

        while _thread.is_alive():
            _spin_clock.tick(60)
            _elapsed = time.time() - _spin_start

            self.screen.fill((0, 0, 0))
            _draw_petal_with_shadow(_p1, _elapsed, _P1, 0.0)
            _draw_petal_with_shadow(_p2, _elapsed, _P2, _P2_OFFSET)
            pygame.display.flip()

            for _ev in pygame.event.get():
                if _ev.type == pygame.QUIT:
                    pygame.quit()
                    sys.exit()

        if _errors:
            raise _errors[0]

        # --- unpack thread results ---
        self.song               = _result['song']
        self.beat_duration      = _result['beat_duration']
        self.pace_profile       = _result['pace_profile']
        self.dual_side_sections = _result['dual_side_sections']
        self.difficulty_profile = _result['difficulty_profile']
        self.rhythm             = _result['rhythm']
        self.drop_events        = _result['drop_events']
        self.scroll_tiers          = _result['scroll_tiers']
        self.energy_shifts         = _result['energy_shifts']
        self._climax_shake_beats   = _result['climax_shake_beats']  # [(song_time, intensity), ...]
        if self._climax_shake_beats and self.song.beat_times:
            # Only allow shaking after the first 20% of the song has passed
            _cutoff = self.song.beat_times[-1] * 0.20
            self._climax_shake_beats = [(t, i) for t, i in self._climax_shake_beats if t >= _cutoff]
            # Guard: at most one shake per 2-beat window (keep highest intensity per window)
            _window = self.beat_duration * 2
            _by_window: dict[int, tuple] = {}
            for _t, _i in self._climax_shake_beats:
                _w = int(_t / _window)
                if _w not in _by_window or _i > _by_window[_w][1]:
                    _by_window[_w] = (_t, _i)
            self._climax_shake_beats = sorted(_by_window.values())
        self._climax_shake_idx     = 0

        # --- screen shake state ---
        self._shake_x: float            = 0.0
        self._shake_sequence: list      = []
        self._shake_seq_idx: int        = 0
        self._shake_step_elapsed: float = 0.0
        self._last_shake_measure: int   = -1  # measure index of last screen shake

        self.input = Input()

        self.shockwaves: list[M.Shockwave] = []
        self.drops_triggered: set[int] = set()
        self.drop_note_indices = self._find_drop_note_indices()

        # --- scroll speed ---
        self.base_scroll_speed = C.SCROLL_SPEED * self.difficulty_profile.scroll_scale
        self.pace_bias         = 0.85 + self.pace_profile.pace_score * 1.3
        self.scroll_speed      = self.base_scroll_speed * self.pace_bias

        # --- outro deceleration ---
        self._outro_active          = False
        self._outro_start_time      = 0.0
        self._outro_dur             = 4.0
        self._outro_start_spd       = 0.0
        self._outro_finish_started  = False   # levelfinish audio fired at 1 s mark
        self._finish_needed         = False   # set when outro completes normally
        self._finish_snapshot: 'pygame.Surface | None' = None

        _silence_start = self.song.duration
        _bt = self.song.beat_times
        if len(_bt) > 8:
            _avg_gap = (_bt[-1] - _bt[0]) / max(1, len(_bt) - 1)
            for _bi in range(len(_bt) - 1, 0, -1):
                if (_bt[_bi] - _bt[_bi - 1]) > _avg_gap * 2.5:
                    _silence_start = _bt[_bi - 1]
                    break
        if self.song.duration - _silence_start < 2.0:
            _silence_start = self.song.duration
        self._silence_start = _silence_start

        # --- bounce mode ---
        self.bounce_events: list[BounceEvent] = []
        self.bounce_active: bool = False
        self.bounce_reversed: bool = False
        self._next_bounce_idx: int = 0
        self._post_bounce_reversed_until: float = -1.0  # song_time until which post-section notes come from right
        self._build_bounce_events()
        self._apply_bounce_grace_periods()

        # --- cat position ---
        self.cat_base_x    = 150 - int(screen_width * 0.02)
        self.cat_center_x  = screen_width // 2 - 115 - int(screen_width * 0.065)
        self.cat_current_x = float(self.cat_base_x)
        self.cat_velocity  = 0.0
        self.dual_side_active        = False
        self.dual_side_visuals_active = False

        # --- timeline animation ---
        self.timeline_normal_start = 0
        self.timeline_normal_end   = 1500
        self.timeline_dual_start   = 0
        self.timeline_dual_end     = screen_width
        self.timeline_current_start = float(self.timeline_normal_start)
        self.timeline_current_end   = float(self.timeline_normal_end)
        self.timeline_start_velocity = 0.0
        self.timeline_end_velocity   = 0.0
        self.hit_marker_normal_x     = C.HIT_X - C.HIT_MARKER_X_OFFSET
        self.hit_marker_dual_x       = screen_width // 2
        self.hit_marker_current_x    = float(self.hit_marker_normal_x)
        self.hit_marker_velocity     = 0.0

        self.word_normal_y  = 180
        self.word_dual_y    = 480
        self.word_current_y = float(self.word_normal_y)
        self.word_y_velocity = 0.0

        self.missed_note_shockwaves: set[int] = set()
        self._last_dual_end_time: float = -10.0

        self._timeline_flash: float = 0.0
        self._timeline_shake_offset: float = 0.0

        # --- pause state ---
        self._music = music
        self.paused = False
        self.pause_screen: PauseScreen | None = None
        self.pause_time_accumulated = 0.0
        self._pause_start = 0.0
        self._in_level_settings: SettingsPanel | None = None

        # --- in-level image buttons (leave + settings) ---
        _btn_w, _btn_h = 83, 83
        _btn_margin = 20
        _leave_raw = pygame.image.load(
            os.path.join(assets_path, 'leavebutton.png')
        ).convert_alpha()
        self._leave_img = pygame.transform.smoothscale(_leave_raw, (_btn_w, _btn_h))
        self._leave_rect = pygame.Rect(
            screen_width - _btn_margin - _btn_w, _btn_margin, _btn_w, _btn_h
        )
        _lvl_settings_raw = pygame.image.load(
            os.path.join(assets_path, 'noki_settingsbutton.png')
        ).convert_alpha()
        self._level_settings_img = pygame.transform.smoothscale(
            _lvl_settings_raw, (_btn_w, _btn_h)
        )
        self._level_settings_rect = pygame.Rect(
            _btn_margin, _btn_margin, _btn_w, _btn_h
        )
        # lerp scales for hover animation (1.0 = normal, 1.12 = hovered)
        self._leave_scale: float = 1.0
        self._level_settings_scale: float = 1.0

        # --- renderer managers ---
        self.word_renderer = WordRenderer(self)
        self.timeline_renderer = TimelineRenderer(self)
        self.note_renderer = NoteRenderer(self)
        sw, sh = self.screen.get_size()
        self._edge_glitch = EdgeGlitchRenderer(sw, sh)

        # --- play music ---
        pygame.mixer.init()
        pygame.mixer.music.load(self.song_path)
        pygame.mixer.music.play()

        # --- hitsound ---
        _hitsound_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'assets', 'audios', 'effects', 'hitsound.mp3')
        self._hitsound: pygame.mixer.Sound | None = None
        try:
            self._hitsound = pygame.mixer.Sound(_hitsound_path)
            self._hitsound.set_volume(1.0)
        except Exception:
            pass
        # scheduled hitsounds: list of perf_counter times at which to fire
        self._pending_hitsounds: list[float] = []

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def show_message(self, txt: str, secs: float) -> None:
        self.message = txt
        self.message_duration = secs

    def render_timeline(self) -> None:
        current_time = time.perf_counter() - self.rhythm.start_time

        self.word_renderer.render(current_time)

        timeline_y = 380
        if self._timeline_shake_offset > 0.3:
            timeline_y += int(self._timeline_shake_offset)
            self._timeline_shake_offset *= -0.5
        else:
            self._timeline_shake_offset = 0.0

        timeline_start_x = int(self.timeline_current_start)
        timeline_end_x = int(self.timeline_current_end)
        hit_marker_x = self.hit_marker_current_x

        self.timeline_renderer.render(
            current_time, timeline_y, timeline_start_x, timeline_end_x, hit_marker_x)
        self.note_renderer.render(
            current_time, timeline_y, timeline_start_x, timeline_end_x, hit_marker_x)

    def run(self):
        """Run the game loop. Returns 'replay', 'menu', or None."""
        self.running = True
        self._exit_to_menu   = False
        self._exit_to_replay = False
        while self.running:
            dt = self.clock.tick(60) / 1000
            if self.paused:
                self._update_paused(dt)
            else:
                self.update(dt)
            pygame.display.flip()

        pygame.mixer.music.stop()

        if self._finish_needed and not self._exit_to_menu:
            result = self._run_finish_screen()
            if result == "replay":
                return "replay"

        return "menu" if self._exit_to_menu else None

    def _run_finish_screen(self) -> str:
        """Create and run the post-level finish screen. Returns 'replay' or 'exit'."""
        from .screens.finish_screen import FinishScreen
        level_name = os.path.splitext(os.path.basename(self.level.song_path))[0]
        backdrop = self._finish_snapshot or self.screen.copy()
        fs = FinishScreen(
            screen=self.screen,
            clock=self.clock,
            backdrop=backdrop,
            level_name=level_name,
            score=self.score,
            total_notes=len(self.rhythm.beat_map),
            misses=self.rhythm.miss_count,
        )
        return fs.run()

    def _enter_pause(self):
        self.paused = True
        self._pause_start = time.perf_counter()
        self._pause_snapshot = self.screen.copy()
        self.pause_screen = PauseScreen(self.screen)
        pygame.mixer.music.pause()

    def _exit_pause(self):
        pause_elapsed = time.perf_counter() - self._pause_start
        self.pause_time_accumulated += pause_elapsed
        self.rhythm.start_time += pause_elapsed
        self.paused = False
        self.pause_screen = None
        pygame.mixer.music.unpause()

    def _update_paused(self, dt: float):
        self.screen.blit(self._pause_snapshot, (0, 0))

        mouse_pos = pygame.mouse.get_pos()
        mouse_clicked = False
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                return
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                self._in_level_settings = None
                self._exit_pause()
                return
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                mouse_clicked = True

        if self._in_level_settings is not None:
            result = self._in_level_settings.update(dt, mouse_pos, mouse_clicked)
            self._in_level_settings.draw()
            if result == "close":
                self._in_level_settings = None
                self._exit_pause()
            return

        if self.pause_screen is not None:
            action = self.pause_screen.update(mouse_pos, mouse_clicked)
            self.pause_screen.draw(time.time())
        else:
            action = None

        if action == "resume":
            self._exit_pause()
        elif action == "menu":
            self._exit_to_menu = True
            self.running = False

    def _find_drop_note_indices(self) -> dict[int, int]:
        """Find beatmap note indices closest to each drop timestamp."""
        if not self.drop_events or not self.rhythm.beat_map:
            return {}

        drop_to_note: dict[int, int] = {}

        for drop_idx, drop in enumerate(self.drop_events):
            drop_time = drop.timestamp + self.rhythm.lead_in
            best_note_idx = -1
            best_diff = float('inf')

            for i, event in enumerate(self.rhythm.beat_map):
                if event.is_rest or not event.char:
                    continue

                diff = abs(event.timestamp - drop_time)
                if diff < best_diff:
                    best_diff = diff
                    best_note_idx = i

            if best_note_idx >= 0:
                drop_to_note[drop_idx] = best_note_idx

        return drop_to_note

    def update(self, dt: float) -> None:
        self.screen.fill((0, 0, 0))

        # fire any hitsounds that were scheduled for an early-hit delay
        _now = time.perf_counter()
        _fired = [t for t in self._pending_hitsounds if _now >= t]
        if _fired and self._hitsound:
            for _ in _fired:
                self._hitsound.play()
        self._pending_hitsounds = [t for t in self._pending_hitsounds if _now < t]

        current_time = time.perf_counter() - self.rhythm.start_time

        # Snapshot states before updates for transition detection
        _was_dual_visuals_active = self.dual_side_visuals_active
        _was_bounce_reversed     = self.bounce_reversed

        self.update_dynamic_scroll_speed(current_time)
        self.update_bounce_state(current_time)
        self.update_cat_position(current_time, dt)
        self.update_timeline_animation(dt)

        self.update_shockwaves(dt)
        self.update_hold_particles(dt)
        self.update_hit_bursts(dt)
        self.update_note_hit_anims(dt)

        # Advance fast note sprite animations
        for _seq in self.fast_note_sprites.values():
            _seq.advance(dt)

        # Lerp fast-note cross-fade alpha (4 frames at 60fps → step of 15/s)
        # Disabled entirely on journey/classic (easy/fair) difficulties.
        _fast_step = 15.0 * dt
        _fast_allowed = self.level.difficulty not in ('journey', 'classic')
        if _fast_allowed and self.scroll_speed >= self.FAST_NOTE_THRESHOLD:
            self._fast_note_alpha = min(1.0, self._fast_note_alpha + _fast_step)
        else:
            self._fast_note_alpha = max(0.0, self._fast_note_alpha - _fast_step)

        # --- energy-shift base state (drives both hitmarker + measureline)
        _song_t = current_time - self.rhythm.lead_in
        _active_shift = None
        for _shift in self.energy_shifts:
            if _shift.start_time <= _song_t < _shift.end_time:
                _active_shift = _shift
                break
        if _active_shift is None or 0.9 < _active_shift.scroll_modifier < 1.1:
            _energy_state = 'normal'
        elif _active_shift.scroll_modifier >= 1.2:
            _energy_state = 'speed_up'
        elif _active_shift.scroll_modifier >= 1.1:
            _energy_state = 'speed_up_mild'
        else:
            _energy_state = 'slow_down'

        def _set_hm(state):
            if state != self._hitmarker_anim_state:
                self._hitmarker_anim_state = state
                self._hitmarker_anim_frame = 0.0

        def _set_ml(state):
            if state != self._measureline_anim_state:
                self._measureline_anim_state = state
                self._measureline_anim_frame = 0.0

        # --- clear one-shot locks when the protected animation has run to completion
        _hm_fi = int(self._hitmarker_anim_frame)
        _ml_fi = int(self._measureline_anim_frame)
        if self._hm_oneshot:
            _frames = (self._slow_hitmarker_frames if self._hitmarker_anim_state == 'slow_down'
                       else self._speed_hitmarker_frames)
            if not _frames or _hm_fi >= len(_frames):
                self._hm_oneshot = False
        if self._ml_oneshot:
            _frames = (self._slow_measureline_frames if self._measureline_anim_state == 'slow_down'
                       else self._speed_measureline_frames)
            if not _frames or _ml_fi >= len(_frames):
                self._ml_oneshot = False

        # --- energy-state baseline (skipped while a bounce one-shot is playing)
        # During a bounce section, keep hitmarker at 'normal' between one-shots so
        # the high-energy speed_up state doesn't fire spuriously between bounces.
        if not self._hm_oneshot:
            _set_hm('normal' if self.bounce_active else _energy_state)
        if not self._ml_oneshot:
            _set_ml(_energy_state)

        # --- dual-mode entry: speed_up on hitmarker only
        # Use dual_side_visuals_active — it's what actually drives hitmarker movement
        if self.dual_side_visuals_active and not _was_dual_visuals_active:
            _set_hm('speed_up')

        # --- bounce direction change: affect both hitmarker + measureline
        # L→R switches to R→L (reversed becomes True)  → slow_hitmarker (deceleration)
        # R→L switches back to L→R (reversed becomes False) → speed_hitmarker (acceleration)
        # Force-reset state+frame and lock from energy-state override until animation ends.
        if self.bounce_active and self.bounce_reversed and not _was_bounce_reversed:
            self._hitmarker_anim_state = 'slow_down'
            self._hitmarker_anim_frame = 0.0
            self._measureline_anim_state = 'slow_down'
            self._measureline_anim_frame = 0.0
            self._hm_oneshot = True
            self._ml_oneshot = True
        elif _was_bounce_reversed and not self.bounce_reversed:
            self._hitmarker_anim_state = 'speed_up'
            self._hitmarker_anim_frame = 0.0
            self._measureline_anim_state = 'speed_up'
            self._measureline_anim_frame = 0.0
            self._hm_oneshot = True
            self._ml_oneshot = True

        # --- advance frame counters (stop at end — no looping)
        self._hitmarker_anim_frame   += (14.0 if self._hitmarker_anim_state   in ('speed_up', 'speed_up_mild') else 12.0 if self._hitmarker_anim_state   == 'slow_down' else 0.0) * dt
        self._measureline_anim_frame += (14.0 if self._measureline_anim_state in ('speed_up', 'speed_up_mild') else 12.0 if self._measureline_anim_state == 'slow_down' else 0.0) * dt

        self.update_hitmarker_glow(dt)
        self._hm_shake_t = max(0.0, self._hm_shake_t - dt)
        self._hm_scale += (1.0 - self._hm_scale) * min(1.0, 12.0 * dt)

        self.update_cat_animation()
        hurt_surf = self.update_hurt_animation(dt)
        if self._bop_surf is not None:
            self.screen.blit(self._bop_surf, (int(self.cat_current_x), 520))
        if hurt_surf is not None:
            self.screen.blit(hurt_surf, (int(self.cat_current_x), 520))

        events = pygame.event.get()
        mouse_pos = pygame.mouse.get_pos()
        mouse_clicked = False
        pause_requested = False
        for event in events:
            if event.type == pygame.QUIT:
                self.running = False
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                pause_requested = True
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                mouse_clicked = True

        if mouse_clicked and self._leave_rect.collidepoint(mouse_pos):
            pause_requested = True
        if mouse_clicked and self._level_settings_rect.collidepoint(mouse_pos):
            self._enter_pause()
            self._in_level_settings = SettingsPanel(self.screen, self._music, self._level_settings_rect)
            return

        self.input.update(events=events)
        _hold_before_update = self.rhythm._active_hold
        self.rhythm.update()
        # Hold auto-completed by timer (not via key-release) — fire hitsound
        if _hold_before_update is not None and self.rhythm._active_hold is None:
            if self._hitsound:
                self._hitsound.play()
            self.trigger_hit_ripple(int(self.hit_marker_current_x), 380)

        # ── end-of-song outro deceleration ───────────────────────────────
        song_time_now = current_time - self.rhythm.lead_in
        _trigger_outro = (self.rhythm.is_finished()
                          or song_time_now >= self._silence_start)
        if _trigger_outro:
            if not self._outro_active:
                self._outro_active     = True
                self._outro_start_time = current_time
                self._outro_start_spd  = self.scroll_speed
            outro_elapsed = current_time - self._outro_start_time
            t    = min(1.0, outro_elapsed / self._outro_dur)
            ease = 1.0 - (1.0 - t) ** 3
            _min_spd = self._outro_start_spd * 0.15
            self.scroll_speed = max(_min_spd, self._outro_start_spd * (1.0 - ease * 0.85))
            # At 1 second into outro: stop song, start finish audio (menu appears 1 s later)
            if outro_elapsed >= 1.0 and not self._outro_finish_started:
                self._outro_finish_started = True
                pygame.mixer.music.stop()
                from . import audio_manager as _am
                _am.play_level_finish()
            if outro_elapsed >= self._outro_dur:
                self._finish_snapshot = self.screen.copy()
                self._finish_needed   = True
                self.running = False
                return
            self.render_timeline()
            return

        # ── climax screen-shake beat triggers ────────────────────────────────
        while (self._climax_shake_idx < len(self._climax_shake_beats)
               and song_time_now >= self._climax_shake_beats[self._climax_shake_idx][0]):
            _, _intensity = self._climax_shake_beats[self._climax_shake_idx]
            self._try_screen_shake(_intensity, song_time_now)
            self._climax_shake_idx += 1

        current_char_idx = self.rhythm.char_event_idx

        if current_char_idx != self.last_char_idx:
            if not self.used_current_char and self.last_char_idx != -1:
                _prev = self.rhythm.beat_map[self.last_char_idx] if self.last_char_idx < len(self.rhythm.beat_map) else None
                if _prev and not _prev.is_rest and _prev.char:
                    self.misses += 1
                    self.show_message("Missed!", 1)
                    self.trigger_hurt()
                    self._hm_shake_t = 1.0

            self.used_current_char = False
            self.last_char_idx = current_char_idx

        if self.input.typed_chars:
            for key in self.input.typed_chars:
                if self.used_current_char:
                    continue

                expected = self.rhythm.current_expected_char()
                if expected is None:
                    break

                result = self.rhythm.check_input(key)

                if result['hit']:
                    judgment = result['judgment']
                    combo = result['combo']

                    self.check_drop_note_hit(current_char_idx)

                    _hy = 380
                    _hit_evt = self.rhythm.beat_map[current_char_idx] if current_char_idx < len(self.rhythm.beat_map) else None
                    _hit_color = self.note_renderer._note_color_map.get(_hit_evt.timestamp, 'blue') if _hit_evt else 'blue'
                    _time_until_hit = 0.0
                    if _hit_evt is not None:
                        _time_until_hit = _hit_evt.timestamp - current_time
                        if _hit_evt.from_left:
                            _note_x = self.hit_marker_current_x - (_time_until_hit * self.scroll_speed)
                        else:
                            _note_x = self.hit_marker_current_x + (_time_until_hit * self.scroll_speed)
                        _grace_px = self.rhythm.timing_windows['ok'] * self.scroll_speed / 7
                        _hx = int(max(self.hit_marker_current_x - _grace_px,
                                      min(self.hit_marker_current_x + _grace_px, _note_x)))
                    else:
                        _hx = int(self.hit_marker_current_x)
                    if self._hitsound:
                        if _time_until_hit > 0:
                            # hit early — fire just before the note's timestamp (40 ms lead)
                            _lead = 0.04
                            _delay = max(0.0, _time_until_hit - _lead)
                            if _delay == 0.0:
                                self._hitsound.play()
                            else:
                                self._pending_hitsounds.append(time.perf_counter() + _delay)
                        else:
                            self._hitsound.play()
                    if judgment != 'hold_started':
                        self.trigger_hit_ripple(_hx, _hy)
                        self.trigger_note_hit_anim(_hx, _hy, _hit_color)
                    self._spawn_hit_particles(_hx, _hy, _hit_color)

                    if judgment == 'hold_started':
                        self.show_message("HOLD...", 0.5)
                    elif judgment == 'perfect':
                        self._glow_press_t = 0.0
                        self._hm_scale = 1.14
                        self.show_message(f"PERFECT! ×{combo}", 0.8)
                        self.trigger_judgment('perfect', int(self.hit_marker_current_x) - 40, 315)
                    elif judgment == 'good':
                        self._glow_press_t = 0.0
                        self._hm_scale = 1.14
                        self.show_message(f"Good ×{combo}", 0.8)
                        self.trigger_judgment('good', int(self.hit_marker_current_x) - 40, 315)
                    elif judgment == 'ok':
                        self._glow_press_t = 0.0
                        self._hm_scale = 1.14
                        self.show_message(f"OK ×{combo}", 0.8)
                        self.trigger_judgment('ok', int(self.hit_marker_current_x) - 40, 315)

                    self.score = self.rhythm.get_score()
                    self.used_current_char = True

                    # Repeat-word iteration complete: fire colored shockwave, shake, and particles
                    if result.get('is_word_complete'):
                        _done_evt = (self.rhythm.beat_map[current_char_idx]
                                     if current_char_idx < len(self.rhythm.beat_map) else None)
                        if _done_evt and _done_evt.repeat_group_id:
                            _rw_color_name = self.note_renderer._note_color_map.get(
                                _done_evt.timestamp, 'blue')
                            _rw_color_rgb = _NOTE_COLOR_RGB.get(_rw_color_name, (142, 204, 255))
                            _rw_x = self.screen.get_width() // 2
                            _rw_y = 180 + int(self.word_current_y - self.word_normal_y)
                            self.trigger_repeat_word_shockwave(_rw_color_rgb, _rw_x, _rw_y)
                            # Tiny word shake (current_time is song-relative, matches word_renderer)
                            self.word_renderer._repeat_word_shake_start = current_time
                            # White particles falling from the word
                            self._spawn_repeat_word_particles(_rw_x, _rw_y)
                else:
                    judgment = result['judgment']
                    if judgment == 'wrong':
                        # Wrong key — show feedback but keep the note live so the
                        # player can re-press before the beat window closes.
                        self.show_message("Wrong Key!", 0.8)
                        self.trigger_hurt()
                        self._timeline_flash = 1.0
                        self._timeline_shake_offset = 6.0
                        # used_current_char intentionally NOT set — allows retry
                    else:
                        self.show_message("Miss!", 0.8)
                        self.trigger_hurt()
                        self._timeline_flash = 1.0
                        self._timeline_shake_offset = 6.0
                        self.misses = self.rhythm.miss_count
                        self.used_current_char = True

        if self.input.released_chars:
            for rel_char in self.input.released_chars:
                hold_result = self.rhythm.on_key_release(rel_char)
                if hold_result:
                    if hold_result['hit']:
                        j = hold_result['judgment']
                        combo = hold_result['combo']
                        self._hm_scale = 1.14
                        if 'perfect' in j:
                            self.show_message(f"HOLD PERFECT! ×{combo}", 1.0)
                            self.trigger_judgment('perfect', int(self.hit_marker_current_x) - 40, 315)
                        elif 'good' in j:
                            self.show_message(f"HOLD Good ×{combo}", 1.0)
                            self.trigger_judgment('good', int(self.hit_marker_current_x) - 40, 315)
                        else:
                            self.show_message(f"HOLD OK ×{combo}", 1.0)
                            self.trigger_judgment('ok', int(self.hit_marker_current_x) - 40, 315)
                        self.trigger_hit_ripple(int(self.hit_marker_current_x), 380)
                        self.score = self.rhythm.get_score()
                    else:
                        self.show_message("Hold broken!", 0.8)
                        self.trigger_hurt()
                        self._timeline_flash = 1.0
                        self._timeline_shake_offset = 6.0
                        self.misses = self.rhythm.miss_count

        self.render_timeline()
        self._draw_judgment_label(dt)

        # ----- SCORE / MISSES
        stats = self.rhythm.get_stats()
        current_score = stats['score']

        sw, sh = self.screen.get_size()
        margin_x, margin_y = 20, 20

        if current_score > self._last_score:
            delta = current_score - self._last_score
            ref_h = self._score_font.get_height()
            _popup_color = (255, 220, 80)
            self._score_popups.append({
                "delta": delta,
                "y": float(sh - margin_y - ref_h - 8),
                "alpha": 255.0,
                "glow_surf": _make_glow_surface(self._popup_font, f"+{delta}", _popup_color, _popup_color, glow_opacity=0.22),
            })
        self._last_score = current_score

        for p in self._score_popups:
            gs = p["glow_surf"].copy()
            gs.set_alpha(int(p["alpha"]))
            self.screen.blit(gs, gs.get_rect(bottomright=(sw - margin_x, int(p["y"]))))
            p["y"]     -= 0.9
            p["alpha"] -= 4.5
        self._score_popups = [p for p in self._score_popups if p["alpha"] > 0]

        if self._score_glow_val != current_score:
            _score_color = (255, 255, 255)
            self._score_glow_surf = _make_glow_surface(self._score_font, f"{current_score}", _score_color, _score_color, glow_opacity=0.22)
            self._score_glow_val = current_score
        self.screen.blit(self._score_glow_surf, self._score_glow_surf.get_rect(bottomright=(sw - margin_x, sh - margin_y)))

        _HOVER_SCALE = 1.12
        _LERP_SPEED = 12.0  # higher = snappier
        for _img, _rect, _attr in (
            (self._leave_img, self._leave_rect, '_leave_scale'),
            (self._level_settings_img, self._level_settings_rect, '_level_settings_scale'),
        ):
            _target = _HOVER_SCALE if _rect.collidepoint(mouse_pos) else 1.0
            _cur = getattr(self, _attr)
            _cur += (_target - _cur) * min(1.0, _LERP_SPEED * dt)
            setattr(self, _attr, _cur)
            _hw = int(_rect.width  * _cur)
            _hh = int(_rect.height * _cur)
            _hsurf = pygame.transform.smoothscale(_img, (_hw, _hh))
            self.screen.blit(_hsurf, _hsurf.get_rect(center=_rect.center))

        if pause_requested:
            self._enter_pause()
            return

        # ── apply screen shake (rotation with per-frame roughness noise) ────────
        self.update_screen_shake(dt)
        if abs(self._shake_x) > 0.05:
            import random as _rnd
            angle   = self._shake_x + _rnd.uniform(-0.18, 0.18)
            _snap   = self.screen.copy()
            rotated = pygame.transform.rotate(_snap, angle)
            self.screen.fill((0, 0, 0))
            self.screen.blit(rotated, rotated.get_rect(center=self.screen.get_rect().center))

        # Glitch effect restricted to the timeline band (y=380 ± 60).
        # In default mode only apply the left edge; dual mode uses both sides.
        _timeline_band_y0 = 320
        _timeline_band_y1 = 440
        self._edge_glitch.apply(
            self.screen,
            int(self.timeline_current_start),
            int(self.timeline_current_end),
            int(time.perf_counter() * 30),
            y0=_timeline_band_y0,
            y1=_timeline_band_y1,
            right_edge=True,
        )
