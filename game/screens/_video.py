"""
Looping animation playback for the menus.

Two backends, picked automatically:

**Frames** — if ``assets/animations/<stem>/`` holds PNGs for this clip, they are
loaded once through ``sprites.load_noki_frames`` (cropped to the animation's union
alpha box, scaled to the target height, cached on disk) and playback is an index
into a list.  Per frame this costs one blit.

**OpenCV** — otherwise the file is decoded a frame at a time.  This is what the
title screen used to do for ``noki_bop.mov``, and it cost about 17 ms of every
frame: ``cap.read`` alone was 8.7 ms, plus ``make_surface`` and ``smoothscale`` on
top.  Half the title screen's frames missed 60 fps because of it, while the play
screen — which already used the extracted frames — sat at 3 ms.

Decoding is driven by delta time either way, so a clip never stalls the loop.
OpenCV is optional: without it, and without a frames folder, ``is_available`` is
False and every other method is a safe no-op.

Usage:
    video = VideoPlayer(path, target_height=480)

    # each frame:
    video.update(dt)
    surf = video.get_surface()   # pygame.Surface or None
    if surf:
        screen.blit(surf, ...)
"""
from __future__ import annotations

import os

import pygame

_ANIM_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "assets", "animations",
)


class VideoPlayer:
    def __init__(self, path: str, target_height: int, fps: float = 30.0) -> None:
        self._target_h = target_height
        self._fps      = fps
        self._acc      = 0.0   # time accumulator in seconds
        self._surf: pygame.Surface | None = None
        self._cap      = None
        self._frame_w  = 0
        self._frame_h  = 0

        # ── frames backend ────────────────────────────────────────────────────
        self._frames: list[pygame.Surface] = []
        self._idx = 0
        stem = os.path.splitext(os.path.basename(path))[0]
        if os.path.isdir(os.path.join(_ANIM_DIR, stem)):
            try:
                from ..sprites import load_noki_frames
                self._frames = load_noki_frames(stem, target_height)
            except Exception:
                self._frames = []
        if self._frames:
            self._surf = self._frames[0]
            self._frame_w = self._surf.get_width()
            self._frame_h = self._surf.get_height()
            return

        # ── OpenCV backend ────────────────────────────────────────────────────
        try:
            import cv2 as _cv2
            cap = _cv2.VideoCapture(path)
            if cap.isOpened():
                fps_read = cap.get(_cv2.CAP_PROP_FPS)
                if fps_read > 0:
                    self._fps = fps_read
                self._frame_w = int(cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
                self._frame_h = int(cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
                self._cap = cap
        except ImportError:
            pass

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def is_available(self) -> bool:
        """True when the clip can be played by either backend."""
        return bool(self._frames) or self._cap is not None

    @property
    def uses_frames(self) -> bool:
        """True when playback is an index into pre-extracted frames."""
        return bool(self._frames)

    @property
    def display_width(self) -> int:
        """Output width that preserves the source aspect ratio at target_height."""
        if self._frames:
            return self._frame_w
        if self._frame_h > 0:
            return int(self._frame_w * self._target_h / self._frame_h)
        return self._target_h

    @property
    def display_height(self) -> int:
        if self._frames:
            return self._frame_h
        return self._target_h

    # ── Public interface ──────────────────────────────────────────────────────

    def update(self, dt: float) -> None:
        """Advance playback by *dt* seconds.  Call once per game frame."""
        frame_dur = 1.0 / self._fps if self._fps > 0 else 1.0 / 30.0
        # A long frame must never make the next one longer still: without this,
        # one slow frame asks for several decodes, which makes the next frame
        # slower again.  Cap the catch-up at a quarter second of animation.
        self._acc = min(self._acc + dt, frame_dur * max(1.0, self._fps * 0.25))

        if self._frames:
            while self._acc >= frame_dur:
                self._acc -= frame_dur
                self._idx = (self._idx + 1) % len(self._frames)
            self._surf = self._frames[self._idx]
            return

        if self._cap is None:
            return
        import cv2 as _cv2
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
        if self._frames:
            self._idx = 0
            self._surf = self._frames[0]
            return
        if self._cap is not None:
            try:
                import cv2 as _cv2
                self._cap.set(_cv2.CAP_PROP_POS_FRAMES, 0)
            except Exception:
                pass
