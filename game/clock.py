"""
ChartClock — the one honest clock for a play session.

Anchored the instant the song starts (call ``start()`` right after
``pygame.mixer.music.play()``), it returns *chart time*: seconds since the
song began, excluding pauses, plus the device offset from settings.

Everything that judges or draws a note asks this clock; nothing else reads
``time.perf_counter()`` directly.  Pause lives inside the clock so a paused
run never drifts.  An optional slew keeps chart time within a few ms of the
mixer's own position when the OS audio stack stalls.
"""
from __future__ import annotations

import time


class ChartClock:
    def __init__(self, device_offset_ms: float = 0.0, slew: bool = True) -> None:
        self._anchor: float | None = None
        self._paused_total: float = 0.0
        self._pause_start: float | None = None
        self._offset = device_offset_ms / 1000.0
        self._slew_enabled = slew
        self._slew: float = 0.0          # correction applied on top of raw time
        self._last_slew_check: float = 0.0

    # ── lifecycle ──────────────────────────────────────────────────────────
    def start(self) -> None:
        self._anchor = time.perf_counter()
        self._paused_total = 0.0
        self._pause_start = None
        self._slew = 0.0

    @property
    def started(self) -> bool:
        return self._anchor is not None

    @property
    def paused(self) -> bool:
        return self._pause_start is not None

    def pause(self) -> None:
        if self._anchor is None or self._pause_start is not None:
            return
        self._pause_start = time.perf_counter()

    def resume(self) -> None:
        if self._pause_start is None:
            return
        self._paused_total += time.perf_counter() - self._pause_start
        self._pause_start = None

    # ── reading ───────────────────────────────────────────────────────────
    def raw(self) -> float:
        """Chart time without the device offset or slew."""
        if self._anchor is None:
            return 0.0
        now = self._pause_start if self._pause_start is not None else time.perf_counter()
        return now - self._anchor - self._paused_total

    def now(self) -> float:
        """Chart time in seconds (what judgments and rendering use)."""
        return self.raw() + self._offset + self._slew

    def set_device_offset(self, ms: float) -> None:
        self._offset = ms / 1000.0

    def rebase(self, chart_t: float) -> None:
        """Re-anchor so that ``raw()`` equals ``chart_t`` right now.

        Called the instant the music actually starts (after the count-in), so
        the lead-in bars can never leave the chart a frame out from the song.
        """
        if self._anchor is None:
            return
        self._anchor = time.perf_counter() - self._paused_total - chart_t
        self._slew = 0.0

    # ── drift correction ──────────────────────────────────────────────────
    def check_drift(self, mixer_pos_s: float | None, max_step: float = 0.002) -> None:
        """Nudge chart time toward the mixer position, at most ``max_step`` per call.

        ``mixer_pos_s`` is ``pygame.mixer.music.get_pos() / 1000`` (seconds the music
        has actually played).  Only corrects when the drift exceeds 15 ms, so the
        normal jitter of get_pos() never moves the clock.
        """
        if not self._slew_enabled or mixer_pos_s is None or mixer_pos_s < 0:
            return
        if self._anchor is None or self._pause_start is not None:
            return
        drift = mixer_pos_s - self.raw() - self._slew
        if abs(drift) > 0.015:
            step = max(-max_step, min(max_step, drift))
            self._slew += step
