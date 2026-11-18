"""
WordRenderer — carousel word animation and typography drawing.
Instantiated and owned by Game; accesses game state via self.game.
"""
import pygame
import math
from .. import constants as C
from ..menu_utils import _FONT

# Colors cycling for repeat word dots (orange first, then impulse particle colors)
_REPEAT_COLORS = [
    (255, 193, 142),   # orange  — first repeat
    (142, 204, 255),   # blue
    (255, 170, 241),   # pink
    (142, 255, 194),   # green
]

# Note color name → RGB (matches NoteRenderer / effects.py)
_NOTE_COLOR_RGB: dict[str, tuple] = {
    'blue':   (142, 204, 255),
    'pink':   (255, 170, 241),
    'green':  (142, 255, 194),
    'orange': (255, 193, 142),
}

# Reverse lookup: RGB tuple → color name (for glow image selection)
_RGB_TO_COLOR_NAME: dict[tuple, str] = {v: k for k, v in _NOTE_COLOR_RGB.items()}

# Letters whose glow is compressed 40% and shifted down 20% of glow height (x-height only)
_SHORT_LETTERS: frozenset = frozenset('aceimnorstuvwxz')
# Letters whose glow is shifted down 40% of glow height (descenders)
_DESCENDER_LETTERS: frozenset = frozenset('gy')

# Per-color glow opacity for procedural glow cache
_GLOW_OPACITY: dict[str, float] = {
    'blue': 0.22, 'green': 0.175, 'orange': 0.175, 'pink': 0.175,
}


def _make_glow_surface(font, text, text_color, glow_color,
                       glow_radius=5, passes=3, glow_opacity=0.175, glow_x_shift=-2):
    text_surf = font.render(text, True, text_color)
    glow_surf = font.render(text, True, glow_color)
    padding = glow_radius * 8
    w = text_surf.get_width() + padding
    h = text_surf.get_height() + padding
    canvas = pygame.Surface((w, h), pygame.SRCALPHA)
    canvas.blit(glow_surf, (padding // 2 + glow_x_shift, padding // 2))
    blurred = canvas
    for _ in range(passes):
        small = pygame.transform.smoothscale(blurred, (max(1, w // glow_radius), max(1, h // glow_radius)))
        blurred = pygame.transform.smoothscale(small, (w, h))
    blurred.set_alpha(int(255 * glow_opacity))
    final = pygame.Surface((w, h), pygame.SRCALPHA)
    for _ in range(2):
        final.blit(blurred, (0, 0))
    final.blit(text_surf, (padding // 2, padding // 2))
    return final


def build_letter_glow_cache(font) -> dict[tuple, pygame.Surface]:
    """Pre-render glowing letter surfaces at base size for each (char, color_name)."""
    cache = {}
    chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for color_name, rgb in _NOTE_COLOR_RGB.items():
        opacity = _GLOW_OPACITY.get(color_name, 0.175)
        for char in chars:
            cache[(char, color_name)] = _make_glow_surface(font, char, rgb, rgb, glow_opacity=opacity)
    return cache


class WordRenderer:

    def __init__(self, game) -> None:
        self.game = game
        # Lazily built: word_text -> total occurrence count in beat_map
        self._word_total_counts: dict[str, int] | None = None
        # word_text -> how many times we've started displaying it so far
        self._word_seen_count: dict[str, int] = {}
        # last word we incremented the seen counter for
        self._last_counted_word: str | None = None

        # --- Repeat-group animation state ---
        # Lazily built: group_id -> max repeat_iter seen in beat_map
        self._repeat_group_max_iter: dict[int, int] | None = None
        # (group_id, iter_num) of the iteration currently being displayed
        self._last_repeat_iter_key: tuple = (-1, -1)
        # perf-counter time when the current iteration started
        self._repeat_iter_start_t: float = -1.0
        # Cached (group_id, iter_num) for _draw_repeat_dots
        self._current_repeat_group_id: int = 0
        self._current_repeat_iter_num: int = 0
        # Word shake: start time (-1 = inactive)
        self._repeat_word_shake_start: float = -1.0

    # ------------------------------------------------------------------
    # Repeat-word tracking helpers
    # ------------------------------------------------------------------

    def _build_word_counts(self) -> None:
        """Count how many distinct word slots each word_text occupies."""
        g = self.game
        counts: dict[str, int] = {}
        seen_start: set[tuple] = set()
        for ev in g.rhythm.beat_map:
            if ev.is_rest or not ev.word_text or ev.char_idx != 0:
                continue
            key = (ev.word_text, ev.timestamp)
            if key in seen_start:
                continue
            seen_start.add(key)
            counts[ev.word_text] = counts.get(ev.word_text, 0) + 1
        self._word_total_counts = counts

    def _build_repeat_group_counts(self) -> None:
        """Build dict of repeat_group_id -> max repeat_iter seen in beat_map."""
        counts: dict[int, int] = {}
        for ev in self.game.rhythm.beat_map:
            if ev.repeat_group_id > 0:
                gid = ev.repeat_group_id
                counts[gid] = max(counts.get(gid, 0), ev.repeat_iter)
        self._repeat_group_max_iter = counts

    def _repeat_info(self, word: str) -> tuple[int, int]:
        """Return (appearance_index, total_count) for *word*.

        appearance_index is 0-based (0 = first time seen).
        """
        if self._word_total_counts is None:
            self._build_word_counts()
        total = self._word_total_counts.get(word, 1)
        seen  = self._word_seen_count.get(word, 0)
        return seen, total

    def _maybe_advance_seen(self, word: str) -> None:
        """Increment the seen counter when we first display a new word slot."""
        if word != self._last_counted_word:
            self._last_counted_word = word
            self._word_seen_count[word] = self._word_seen_count.get(word, 0) + 1

    # ------------------------------------------------------------------
    # Note-color helpers
    # ------------------------------------------------------------------

    def _note_rgb_for_event_ts(self, timestamp: float) -> tuple:
        color_name = self.game.note_renderer._note_color_map.get(timestamp, 'blue')
        return _NOTE_COLOR_RGB.get(color_name, (142, 204, 255))

    def _word_note_color(self, word_text_full: str, search_from: int = 0) -> tuple:
        """Return the RGB note color for the first matching word-start event at or after search_from.
        word_text_full must be the full (non-truncated) word text stored in beat_map events."""
        for ev in self.game.rhythm.beat_map[search_from:]:
            if ev.is_rest or ev.char_idx != 0 or ev.word_text != word_text_full:
                continue
            return self._note_rgb_for_event_ts(ev.timestamp)
        return (142, 204, 255)

    def _current_word_note_color(self) -> tuple:
        """Note color for the currently active word slot."""
        g = self.game
        # Use the full word text (not display-truncated) for matching against beat_map events
        current_word_full = g.rhythm.current_expected_word()
        if not current_word_full:
            return (142, 204, 255)
        idx = min(g.rhythm.char_event_idx, len(g.rhythm.beat_map) - 1)
        beat_map = g.rhythm.beat_map

        # Scan backward: handles mid-word case where char_idx==0 was already consumed
        for i in range(idx, -1, -1):
            ev = beat_map[i]
            if ev.is_rest or ev.word_text != current_word_full:
                continue
            if ev.char_idx == 0:
                return self._note_rgb_for_event_ts(ev.timestamp)

        # Scan forward: handles the case where char_event_idx is at a rest before the word
        for i in range(idx, len(beat_map)):
            ev = beat_map[i]
            if ev.is_rest:
                continue
            if ev.word_text == current_word_full and ev.char_idx == 0:
                return self._note_rgb_for_event_ts(ev.timestamp)
            if ev.char_idx == 0 and ev.word_text != current_word_full:
                break  # moved past this word's block
        return (142, 204, 255)

    def _get_next_full_word_text(self) -> str | None:
        """Return the full word_text of the next upcoming word (for color lookup)."""
        g = self.game
        current_full = g.rhythm.current_expected_word()
        for i in range(g.rhythm.char_event_idx, len(g.rhythm.beat_map)):
            ev = g.rhythm.beat_map[i]
            if ev.is_rest or ev.char_idx != 0 or not ev.word_text:
                continue
            if ev.word_text != current_full:
                return ev.word_text
        return None

    def _prev_word_note_color(self, prev_word_full: str) -> tuple:
        """Note color for the most recent past slot of prev_word_full (full word text)."""
        g = self.game
        idx = min(g.rhythm.char_event_idx, len(g.rhythm.beat_map) - 1)
        for i in range(idx, -1, -1):
            ev = g.rhythm.beat_map[i]
            if ev.is_rest or ev.char_idx != 0 or ev.word_text != prev_word_full:
                continue
            return self._note_rgb_for_event_ts(ev.timestamp)
        return (142, 204, 255)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def get_next_word(self) -> str | None:
        """Get the next word that will be typed after current word completes."""
        g = self.game
        if not g.rhythm.beat_map:
            return None

        next_word_text = None
        for i in range(g.rhythm.char_event_idx, len(g.rhythm.beat_map)):
            event = g.rhythm.beat_map[i]
            if event.word_text and event.char_idx == 0 and not event.is_rest:
                if event.word_text != g.rhythm.current_expected_word():
                    next_word_text = event.word_text
                    break

        if next_word_text is None:
            return None

        max_char_idx = -1
        for i in range(g.rhythm.char_event_idx, len(g.rhythm.beat_map)):
            ev = g.rhythm.beat_map[i]
            if ev.is_rest or ev.word_text != next_word_text:
                continue
            if ev.char_idx > max_char_idx:
                max_char_idx = ev.char_idx

        if max_char_idx < 0:
            return next_word_text
        return next_word_text[:max_char_idx + 1]

    # ------------------------------------------------------------------
    # Draw methods
    # ------------------------------------------------------------------

    def draw_word_animated(
        self,
        word: str,
        position: str,
        transition_progress: float,
        is_current: bool,
        fading_out: bool = False,
        adjacent_word_width: int = 0,
        y_offset: float = 0,
        repeat_color: tuple | None = None,
        repeat_scale_bonus: float = 0.0,
        word_color: tuple | None = None,
        x_shake: float = 0.0,
    ) -> None:
        """Draw a word with 3D carousel rotation animation."""
        g = self.game
        if not word:
            return

        base_char_spacing = 60

        if position == 'right':
            char_spacing = base_char_spacing * 0.7
        elif position == 'left':
            char_spacing = base_char_spacing * 0.7
        else:
            char_spacing = base_char_spacing

        total_width = len(word) * char_spacing

        radius = 350
        center_offset = base_char_spacing / 2
        center_x = g.screen.get_width() // 2 + center_offset + (x_shake if position == 'center' else 0.0)
        center_y = 180 + y_offset

        base_spacing = 100

        # Derive side color: ~60% brightness of note color, or neutral gray
        _side_color = (tuple(int(c * 0.6) for c in word_color)
                       if word_color else (150, 150, 150))

        if position == 'center':
            target_angle = 0
            target_scale = 1.0 + repeat_scale_bonus
            target_alpha = 255
            target_color = word_color if word_color is not None else (255, 255, 255)
            target_char_spacing = base_char_spacing
        elif position == 'right':
            width_factor = (total_width + adjacent_word_width) / 2
            dynamic_spacing = base_spacing + width_factor * 0.3
            target_angle = dynamic_spacing / radius
            target_scale = 0.75
            target_alpha = 180
            target_color = _side_color
            target_char_spacing = base_char_spacing * 0.7
        else:
            width_factor = (total_width + adjacent_word_width) / 2
            dynamic_spacing = base_spacing + width_factor * 0.3
            target_angle = -dynamic_spacing / radius
            target_scale = 0.75
            target_alpha = int(180 * (1 - transition_progress)) if fading_out else 180
            target_color = _side_color
            target_char_spacing = base_char_spacing * 0.7

        if position == 'center' and transition_progress < 1.0:
            width_factor = (total_width + adjacent_word_width) / 2
            dynamic_spacing = base_spacing + width_factor * 0.3
            start_angle = dynamic_spacing / radius
            current_angle = start_angle + (target_angle - start_angle) * transition_progress

            current_scale = 0.75 + (target_scale - 0.75) * transition_progress
            current_alpha = int(180 + (target_alpha - 180) * transition_progress)

            # Blend from dim note color (side brightness) toward full note color
            start_c = _side_color
            end_c   = target_color
            current_color = tuple(int(start_c[i] + (end_c[i] - start_c[i]) * transition_progress)
                                  for i in range(3))

            start_char_spacing = base_char_spacing * 0.7
            current_char_spacing = start_char_spacing + (target_char_spacing - start_char_spacing) * transition_progress
        else:
            current_angle = target_angle
            current_scale = target_scale
            current_alpha = target_alpha
            current_color = target_color
            current_char_spacing = char_spacing

        x_offset = radius * math.sin(current_angle)
        z = radius * (1 - math.cos(current_angle))

        perspective_scale = 1.0 / (1.0 + z / 1000)
        final_scale = current_scale * perspective_scale
        final_alpha = int(current_alpha * perspective_scale)

        animated_total_width = len(word) * current_char_spacing * final_scale

        current_x = center_x + x_offset - animated_total_width / 2

        for i, char in enumerate(word):
            font_size = int(48 * final_scale)
            char_font = pygame.font.Font(_FONT, font_size)

            char_x = current_x + i * (current_char_spacing * final_scale)
            char_y = center_y

            # Draw letter glow behind character (center word only)
            if position == 'center' and current_color:
                color_name = _RGB_TO_COLOR_NAME.get(current_color, 'white')
                cached = g.letter_glow_cache.get((char, color_name))
                if cached:
                    target_w = int(cached.get_width() * final_scale)
                    target_h = int(cached.get_height() * final_scale)
                    scaled_glow = pygame.transform.smoothscale(cached, (target_w, target_h))
                    scaled_glow.set_alpha(int(final_alpha))
                    gx = int(char_x + char_font.size(char)[0] / 2 - target_w / 2)
                    gy = int(char_y + font_size / 2 - target_h / 2)
                    g.screen.blit(scaled_glow, (gx, gy))

            char_surface = char_font.render(char, True, current_color)
            char_surface.set_alpha(final_alpha)

            g.screen.blit(char_surface, (int(char_x), int(char_y)))

            if position == 'center' and is_current and g.rhythm.char_event_idx < len(g.rhythm.beat_map):
                current_event = g.rhythm.beat_map[g.rhythm.char_event_idx]
                if (not current_event.is_rest
                        and current_event.word_text.startswith(word)
                        and current_event.char_idx == i):
                    underline_width = int(C.UNDERLINE_LEN * final_scale)
                    line_x = char_x - 10 * final_scale
                    line_y = char_y + 50

                    pygame.draw.line(
                        g.screen,
                        (255, 255, 255),
                        (int(line_x), int(line_y)),
                        (int(line_x + underline_width), int(line_y)),
                        3,
                    )

        # Draw remaining-repeat dots to the right of a center repeat word
        if position == 'center' and repeat_color is not None:
            self._draw_repeat_dots(
                word, current_x, center_y,
                current_char_spacing, final_scale,
                repeat_color, final_alpha,
            )

    def _draw_repeat_dots(
        self,
        word: str,
        word_start_x: float,
        word_y: float,
        char_spacing: float,
        scale: float,
        color: tuple,
        alpha: int,
    ) -> None:
        """Draw a vertical column of dots to the right of the word showing remaining repeats."""
        group_id = self._current_repeat_group_id
        iter_num = self._current_repeat_iter_num
        if group_id <= 0:
            return
        if self._repeat_group_max_iter is None:
            self._build_repeat_group_counts()
        total = self._repeat_group_max_iter.get(group_id, 1)
        remaining = total - iter_num  # iterations still to come after this one
        if remaining <= 0:
            return

        g = self.game
        word_right_x = word_start_x + len(word) * char_spacing * scale
        dot_x = int(word_right_x + 10 * scale)
        dot_r = max(3, int(5 * scale))
        dot_gap = int(dot_r * 2 + 4)
        # Vertically center the column on the word midpoint
        font_h = int(48 * scale)
        col_total_h = remaining * dot_gap - 4
        dot_start_y = int(word_y + font_h / 2 - col_total_h / 2)

        dot_surf = pygame.Surface((dot_r * 2, dot_r * 2), pygame.SRCALPHA)
        pygame.draw.circle(dot_surf, (*color, alpha), (dot_r, dot_r), dot_r)

        for k in range(remaining):
            dy = dot_start_y + k * dot_gap
            g.screen.blit(dot_surf, (dot_x - dot_r, dy - dot_r))

    def draw_background_word(self, word: str) -> None:
        """Draw the current word as a large, faded background element during dual-side mode."""
        g = self.game
        if not word:
            return

        font_size = 180
        bg_font = pygame.font.Font(_FONT, font_size)
        bg_color = (60, 60, 60)

        char_spacing = 120
        total_width = len(word) * char_spacing
        start_x = (g.screen.get_width() - total_width) // 2
        center_y = g.screen.get_height() // 2 - 50

        for i, char in enumerate(word):
            char_surface = bg_font.render(char, True, bg_color)
            char_x = start_x + i * char_spacing
            char_rect = char_surface.get_rect(center=(char_x + char_spacing // 2, center_y))
            g.screen.blit(char_surface, char_rect)

    def draw_text(self, txt: str, left: bool) -> None:
        g = self.game
        text_surface = g.font.render(txt, True, (255, 255, 255))
        if left:
            g.screen.blit(text_surface, (100, 100))
        else:
            text_rect = text_surface.get_rect(center=(1100, 250))
            g.screen.blit(text_surface, text_rect)

    def draw_curr_word(self, txt: str) -> None:
        self.draw_text(txt, True)

    # ------------------------------------------------------------------
    # Main render call
    # ------------------------------------------------------------------

    def render(self, current_time: float) -> None:
        """Render the word carousel (current / next / previous words)."""
        g = self.game

        current_word = g.rhythm.current_display_word()
        next_word = self.get_next_word()

        char_spacing = 60
        current_word_width = len(current_word) * char_spacing if current_word else 0
        next_word_width = len(next_word) * char_spacing if next_word else 0

        if current_word != g._last_displayed_word:
            g._word_transition_start = current_time
            g._last_displayed_word = current_word
            if current_word:
                self._maybe_advance_seen(current_word)

        transition_duration = 0.3
        transition_progress = min(1.0, (current_time - g._word_transition_start) / transition_duration)
        ease_progress = 1 - (1 - transition_progress) ** 3

        word_y_offset = g.word_current_y - g.word_normal_y

        # --- Repeat word styling (only for beatmap-flagged repeat groups) ---
        repeat_color = None
        repeat_scale_bonus = 0.0
        self._current_repeat_group_id = 0
        self._current_repeat_iter_num = 0

        cur_evt_idx = g.rhythm.char_event_idx
        cur_evt = g.rhythm.beat_map[cur_evt_idx] if cur_evt_idx < len(g.rhythm.beat_map) else None
        if current_word and cur_evt and cur_evt.repeat_group_id > 0:
            group_id = cur_evt.repeat_group_id
            iter_num = cur_evt.repeat_iter
            self._current_repeat_group_id = group_id
            self._current_repeat_iter_num = iter_num
            iter_key = (group_id, iter_num)
            # Detect start of a new iteration
            if iter_key != self._last_repeat_iter_key:
                self._last_repeat_iter_key = iter_key
                self._repeat_iter_start_t = current_time
            # Scale: starts +0.30 (large) at iteration start, decays to 0 over 0.5 s
            age = max(0.0, current_time - self._repeat_iter_start_t)
            repeat_scale_bonus = 0.30 * max(0.0, 1.0 - age / 0.5)
            # Color cycles per iteration: orange → blue → pink → green → …
            idx = (iter_num - 1) % len(_REPEAT_COLORS)
            repeat_color = _REPEAT_COLORS[idx]

        # --- Word shake (triggered externally via _repeat_word_shake_start) ---
        shake_x = 0.0
        if self._repeat_word_shake_start >= 0:
            shake_age = current_time - self._repeat_word_shake_start
            if shake_age < 0.35:
                shake_t = shake_age / 0.35
                amplitude = 5.0 * (1.0 - shake_t) ** 2
                shake_x = amplitude * math.sin(shake_age * 55.0)
            else:
                self._repeat_word_shake_start = -1.0

        # Note-based text colors for all three carousel positions.
        # Use full (non-truncated) word texts so ev.word_text comparisons match correctly.
        next_word_full = self._get_next_full_word_text()
        cur_note_color  = self._current_word_note_color() if current_word else None
        next_note_color = (self._word_note_color(next_word_full, g.rhythm.char_event_idx)
                           if next_word_full else None)
        prev_note_color = (self._prev_word_note_color(g._previous_word_full)
                           if g._previous_word_full else None)

        if current_word:
            # Repeat words override the note color with the cycling repeat color
            _cur_color = repeat_color if repeat_color is not None else cur_note_color
            self.draw_word_animated(
                current_word,
                position='center',
                transition_progress=ease_progress,
                is_current=True,
                adjacent_word_width=next_word_width,
                y_offset=word_y_offset,
                repeat_color=repeat_color,
                repeat_scale_bonus=repeat_scale_bonus,
                word_color=_cur_color,
                x_shake=shake_x,
            )

        if next_word:
            self.draw_word_animated(
                next_word,
                position='right',
                transition_progress=ease_progress,
                is_current=False,
                adjacent_word_width=current_word_width,
                y_offset=word_y_offset,
                word_color=next_note_color,
            )

        if g._previous_word is not None and transition_progress < 1.0:
            self.draw_word_animated(
                g._previous_word,
                position='left',
                transition_progress=ease_progress,
                is_current=False,
                fading_out=True,
                adjacent_word_width=current_word_width,
                y_offset=word_y_offset,
                word_color=prev_note_color,
            )

        if transition_progress >= 1.0:
            g._previous_word = current_word
            g._previous_word_full = g.rhythm.current_expected_word()
