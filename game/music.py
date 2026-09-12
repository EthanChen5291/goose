"""
UI Music Manager
----------------
Created once per app launch in main.py and passed through to MenuManager.
Uses pygame.mixer.Sound on dedicated channels (8, 9) — completely separate
from pygame.mixer.music which the game engine uses for song playback.

State machine:
  INTRO         title2.wav plays once
  TITLE         titleloop2.wav loops
  CROSSFADE     titleloop2 fades out / levelsloop2 fades in  (0.5 s)
  LEVELS_LOOP   levelsloop2.wav loops forever
  GAME          both channels paused while game song plays
"""

import os
import time
import pygame

_AUDIO = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "audios", "built-in")


class MusicManager:
    """
    Instantiate once before the main loop.  Pass to MenuManager every time
    it is created — the state machine remembers where it left off so the
    "only reset on relaunch" behaviour is automatic.
    """

    # States
    _WAITING     = "waiting"   # before user triggers the intro
    _INTRO       = "intro"
    _TITLE       = "title"
    _CROSSFADE   = "crossfade"
    _LEVELS_LOOP = "levels_loop"
    _GAME        = "game"

    _CROSSFADE_DUR = 0.5   # seconds — levelsloop2 fades in over 0.5 s
    _MASTER        = 0.75  # master volume for UI music

    def __init__(self):
        # Reserve high-numbered channels so the game engine's Sound effects
        # (if any) don't collide with ours.
        pygame.mixer.set_num_channels(max(pygame.mixer.get_num_channels(), 16))
        self._ch0 = pygame.mixer.Channel(8)   # title side
        self._ch1 = pygame.mixer.Channel(9)   # levels side

        self._snd_title_intro = pygame.mixer.Sound(os.path.join(_AUDIO, "title2.wav"))
        self._snd_title_loop  = pygame.mixer.Sound(os.path.join(_AUDIO, "titleloop2.wav"))
        self._snd_levels      = pygame.mixer.Sound(os.path.join(_AUDIO, "levelsloop2.wav"))

        self._state          = self._WAITING  # held here until start_intro() is called
        self._pre_game       = None
        self._fade_t         = 0.0
        self._intro_start_t  = None           # set when start_intro() is called
        self._video_done     = False   # set when video finishes; unlocks title screen

        # Channels ready but silent — music starts only when start_intro() is called
        self._ch0.set_volume(self._MASTER)
        self._ch1.set_volume(0.0)

    # ── Called every frame from MenuManager.run() ────────────────────────────

    def update(self, dt: float) -> None:
        if self._state == self._WAITING:
            return   # nothing to do until start_intro() is called

        if self._state == self._INTRO:
            if not self._ch0.get_busy():
                self._transition_to_title()

        elif self._state == self._CROSSFADE:
            self._fade_t = min(self._fade_t + dt, self._CROSSFADE_DUR)
            t    = self._fade_t / self._CROSSFADE_DUR
            ease = t * t * (3.0 - 2.0 * t)          # smoothstep
            self._ch0.set_volume(self._MASTER * (1.0 - ease))
            self._ch1.set_volume(self._MASTER * ease)
            if self._fade_t >= self._CROSSFADE_DUR:
                self._ch0.stop()
                self._ch0.set_volume(0.0)
                self._state = self._LEVELS_LOOP

    def _transition_to_title(self) -> None:
        self._state = self._TITLE
        self._ch0.set_volume(self._MASTER)
        self._ch0.play(self._snd_title_loop, loops=-1)

    # ── Event hooks ──────────────────────────────────────────────────────────

    @property
    def needs_start(self) -> bool:
        """True if start_intro() has not been called yet."""
        return self._state == self._WAITING

    def start_intro(self) -> None:
        """Begin playing title2.wav and kick off the intro animation.
        Called once the player interacts with the waiting ('...') screen."""
        if self._state == self._WAITING:
            self._state         = self._INTRO
            self._intro_start_t = time.time()
            self._ch0.play(self._snd_title_intro)

    @property
    def intro_elapsed(self) -> float:
        """Seconds since title2.wav started; inf once intro is over."""
        if self._state != self._INTRO or self._intro_start_t is None:
            return float('inf')
        return time.time() - self._intro_start_t

    @property
    def title_ready(self) -> bool:
        """True once the video has finished (title screen can show).
        title2.wav may still be playing — it will naturally transition to titleloop2."""
        return self._video_done or self._state not in (self._WAITING, self._INTRO)

    def on_intro_video_done(self) -> None:
        """Call when the intro video finishes.
        Reveals the title screen but does NOT interrupt title2.wav — it plays
        until done, then titleloop2 starts as normal."""
        self._video_done = True

    def skip_intro_to(self, seconds: float) -> None:
        """Jump title2.wav forward to `seconds` (the point where the video
        would have ended) so the music stays aligned when the intro is skipped.
        pygame Sounds can't seek, so play a sliced copy of the raw buffer."""
        self._video_done = True
        if self._state != self._INTRO:
            return
        elapsed = time.time() - (self._intro_start_t or time.time())
        if seconds <= elapsed:
            return   # already past that point — nothing to align
        init = pygame.mixer.get_init()
        if not init:
            return
        freq, fmt, channels = init
        frame_bytes = (abs(fmt) // 8) * channels
        raw    = self._snd_title_intro.get_raw()
        offset = int(seconds * freq) * frame_bytes
        if offset >= len(raw):
            self._ch0.stop()
            self._transition_to_title()
            return
        self._ch0.stop()
        self._ch0.set_volume(self._MASTER)
        self._ch0.play(pygame.mixer.Sound(buffer=raw[offset:]))
        self._intro_start_t = time.time() - seconds

    def on_play_pressed(self) -> None:
        """Call when the title-screen play button is clicked."""
        if self._state in (self._INTRO, self._TITLE):
            # Stop title2 / titleloop2 and crossfade to levelsloop2
            self._ch0.stop()
            self._state  = self._CROSSFADE
            self._fade_t = 0.0
            self._ch1.set_volume(0.0)
            self._ch1.play(self._snd_levels, loops=-1)
        # All other states: already past title → do nothing

    def pause_for_game(self) -> None:
        """Silence UI music while the game's own song is playing."""
        self._pre_game = self._state
        self._state    = self._GAME
        self._ch0.pause()
        self._ch1.pause()

    def resume_from_game(self) -> None:
        """Restore UI music after returning from game."""
        self._state = self._pre_game or self._LEVELS_LOOP
        self._ch0.unpause()
        self._ch1.unpause()

    # ── Volume control ───────────────────────────────────────────────────────

    @property
    def volume(self) -> float:
        return self._MASTER

    @volume.setter
    def volume(self, v: float) -> None:
        self._MASTER = max(0.0, min(1.0, v))
        if self._state in (self._INTRO, self._TITLE):
            self._ch0.set_volume(self._MASTER)
        elif self._state == self._LEVELS_LOOP:
            self._ch1.set_volume(self._MASTER)
        # During crossfade the lerp in update() applies _MASTER each frame
