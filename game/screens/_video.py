"""
Thin, non-blocking OpenCV video wrapper.

Decodes one frame at a time driven by delta time so it never stalls the
main loop.  OpenCV is optional — if unavailable, is_available returns False
and all other methods are safe no-ops.

Usage:
    video = VideoPlayer(path, target_height=480)

    # each frame:
    video.update(dt)
    surf = video.get_surface()   # pygame.Surface or None
    if surf:
        screen.blit(surf, ...)
"""
from __future__ import annotations
import pygame


class VideoPlayer:
    def __init__(self, path: str, target_height: int) -> None:
        self._target_h = target_height
        self._fps      = 30.0
        self._acc      = 0.0   # time accumulator in seconds
        self._surf: pygame.Surface | None = None
        self._cap      = None
        self._frame_w  = 0
        self._frame_h  = 0

        try:
            import cv2 as _cv2
            cap = _cv2.VideoCapture(path)
            if cap.isOpened():
                fps = cap.get(_cv2.CAP_PROP_FPS)
                if fps > 0:
                    self._fps = fps
                self._frame_w = int(cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
                self._frame_h = int(cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
                self._cap = cap
        except ImportError:
            pass

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def is_available(self) -> bool:
        """True when the video file was successfully opened."""
        return self._cap is not None

    @property
    def display_width(self) -> int:
        """Output width that preserves the source aspect ratio at target_height."""
        if self._frame_h > 0:
            return int(self._frame_w * self._target_h / self._frame_h)
        return self._target_h

    @property
    def display_height(self) -> int:
        return self._target_h

    # ── Public interface ──────────────────────────────────────────────────────

    def update(self, dt: float) -> None:
        """Advance playback by *dt* seconds.  Call once per game frame."""
        if self._cap is None:
            return
        import cv2 as _cv2
        self._acc += dt
        frame_dur = 1.0 / self._fps
        while self._acc >= frame_dur:
            self._acc -= frame_dur
            ret, frame = self._cap.read()
            if not ret:
                # Loop back to frame 0
                self._cap.set(_cv2.CAP_PROP_POS_FRAMES, 0)
                ret, frame = self._cap.read()
            if ret:
                frame_rgb = _cv2.cvtColor(frame, _cv2.COLOR_BGR2RGB)
                fh, fw    = frame_rgb.shape[:2]
                disp_w    = int(fw * self._target_h / fh) if fh > 0 else self._target_h
                surf      = pygame.surfarray.make_surface(frame_rgb.transpose(1, 0, 2))
                self._surf = pygame.transform.smoothscale(surf, (disp_w, self._target_h))

    def get_surface(self) -> pygame.Surface | None:
        """Return the most recently decoded frame, or None before the first frame."""
        return self._surf

    def reset(self) -> None:
        """Seek back to frame 0 (call when the screen becomes active again)."""
        self._acc = 0.0
        if self._cap is not None:
            try:
                import cv2 as _cv2
                self._cap.set(_cv2.CAP_PROP_POS_FRAMES, 0)
            except Exception:
                pass
