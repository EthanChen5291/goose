"""
Menu state machine and pause overlay.
UI widgets → ui_components.py
Screen views → screens.py
Utility functions → menu_utils.py
"""
import pygame
import time
import os
import shutil
import threading

from .menu_utils import (
    _FONT,
    DEFAULT_WORD_BANK,
    _load_scores,
    _load_custom_songs,
    _save_custom_songs,
    _load_word_banks,
    _save_word_banks,
    _load_custom_bpms,
    _save_custom_bpms,
    start_pick_audio_file,
)
from .ui_components import Button, Petal
from .screens import TitleScreen, LevelSelect, LevelMenu, FileUploadScreen
from . import audio_manager as _audio


# ─── Menu manager ─────────────────────────────────────────────────────────────

class MenuManager:
    _PETAL_COUNT = 55

    def __init__(self, screen, clock, song_names, start_state="title", music=None):
        self.screen     = screen
        self.clock      = clock
        self.song_names = song_names
        self.state      = start_state
        self._music     = music   # MusicManager | None

        # load scores first — needed by LevelSelect
        self._scores              = _load_scores()
        self._custom_bpms: dict[str, int] = _load_custom_bpms()
        self._level_menu: LevelMenu | None = None
        self._pending_difficulty: str | None = None
        self._pending_bpm: int | None = None

        # Canon = built-in songs only; custom songs loaded from disk are excluded
        _persisted_custom       = set(_load_custom_songs())
        self._canon_names       = [n for n in song_names if n not in _persisted_custom]
        # Add any persisted custom songs into song_names if not already present
        for _cs in _load_custom_songs():
            if _cs not in self.song_names:
                self.song_names.insert(0, _cs)
        self.title_screen       = TitleScreen(screen, music)
        # the first launch at a window size builds Noki's sprite sheets; show the petals meanwhile
        from .ui_components import PetalSpinner
        self.level_select       = LevelSelect(screen, song_names, self._scores,
                                              canon_names=self._canon_names,
                                              progress=PetalSpinner(screen).tick)
        self.file_upload_screen = FileUploadScreen(screen)
        if start_state != "title":
            self.title_screen.reset()

        self.transition_start        = 0.0
        self.transition_duration     = 0.5
        self.transition_origin       = (screen.get_width() // 2, screen.get_height() // 2)
        self.transition_target_state = ""
        self.transition_selected     = -1
        self._pre_transition_state   = ""

        sw, sh = screen.get_size()
        self._petals = [Petal(sw, sh, randomize_y=True) for _ in range(self._PETAL_COUNT)]

        # ── Intro video ──────────────────────────────────────────────────────
        _VIDEO_PATH = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "assets", "animations", "noki_intro.mov",
        )
        self._video_cap        = None
        self._video_done       = (music is not None and music.title_ready)
        self._video_last_surf  = None
        self._video_frame_dur  = 1.0 / 30.0
        self._video_start_wall: float | None = None   # set on first rendered frame
        self._video_duration   = 0.0                  # seconds, from frame count

        # ── Tiny skip button (bottom-right of the intro video) ────────────────
        self._skip_img: pygame.Surface | None = None
        self._skip_rect: pygame.Rect | None = None
        try:
            _raw_skip = pygame.image.load(os.path.join(
                os.path.dirname(os.path.dirname(__file__)),
                "assets", "images", "playbutton.png",
            )).convert_alpha()
            _skip_h = max(16, int(screen.get_height() * 0.035))
            _skip_w = max(1, int(_raw_skip.get_width() * _skip_h / _raw_skip.get_height()))
            self._skip_img = pygame.transform.smoothscale(_raw_skip, (_skip_w, _skip_h))
            _m = max(10, int(screen.get_height() * 0.02))
            self._skip_rect = self._skip_img.get_rect(
                bottomright=(screen.get_width() - _m, screen.get_height() - _m))
        except Exception:
            self._skip_img = None

        # ── Waiting ("...") screen ────────────────────────────────────────────
        self._show_waiting  = (music is not None and music.needs_start)
        self._dots_timer    = 0.0
        self._dots_count    = 1
        self._waiting_elapsed = 0.0
        _dots_font_size     = max(48, screen.get_height() // 12)
        self._dots_font     = pygame.font.Font(_FONT, _dots_font_size)

        if not self._video_done:
            _has_video = False
            try:
                import cv2  # type: ignore
                if os.path.exists(_VIDEO_PATH):
                    cap = cv2.VideoCapture(_VIDEO_PATH)
                    if cap.isOpened():
                        fps = cap.get(cv2.CAP_PROP_FPS)
                        if fps > 0:
                            self._video_frame_dur = 1.0 / fps
                        _frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                        if _frames > 0:
                            self._video_duration = _frames * self._video_frame_dur
                        self._video_cap = cap
                        if self._music:
                            self._music.start_intro()
                        self._show_waiting = False
                        _has_video = True
            except ImportError:
                pass
            if not _has_video:
                self._video_done = True
                if self._music:
                    self._music.on_intro_video_done()

        # per-song word banks (filename → word list)
        self.song_word_banks: dict[str, list[str]] = _load_word_banks()

        self._pending_difficulty: str | None = None

        # async file-copy state
        self._uploading: bool = False
        self._upload_thread: threading.Thread | None = None
        self._upload_result: list = []  # filled with (ok, msg) by worker

        # non-blocking file-picker subprocess (launched directly from level select)
        self._pick_proc = None

    def reset_for_return(self, start_state: str) -> None:
        """Lightweight reset after returning from a level — avoids recreating fonts/videos."""
        self.state = start_state
        self._scores = _load_scores()
        self._custom_bpms = _load_custom_bpms()
        self.level_select.reset(self.song_names, self._scores, self._canon_names)
        self.title_screen.reset()
        self._level_menu = None
        self._uploading = False
        self._upload_thread = None
        self._upload_result = []

    def _word_bank_for(self, idx: int) -> list[str]:
        name = self.song_names[idx]
        return self.song_word_banks.get(name, DEFAULT_WORD_BANK[:])

    def run(self):
        """Returns (song_index, difficulty_str, word_bank) or None if quit."""
        while True:
            current_time  = time.time()
            mouse_pos     = pygame.mouse.get_pos()
            mouse_clicked = False
            events        = []

            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return None
                if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    mouse_clicked = True
                if self.state == "level_select":
                    self.level_select.handle_scroll(event)
                events.append(event)

            dt = self.clock.tick(60) / 1000.0

            # ── Waiting ("...") screen — auto-dismisses after 2 seconds ─────
            if self._show_waiting:
                self._waiting_elapsed += dt
                if self._waiting_elapsed >= 2.0:
                    self._show_waiting = False
                    if self._music:
                        self._music.start_intro()
                else:
                    self.screen.fill((0, 0, 0))
                    self._dots_timer += dt
                    if self._dots_timer >= 0.22:
                        self._dots_timer = 0.0
                        self._dots_count = (self._dots_count % 3) + 1
                    dots_str = "." * self._dots_count
                    sw2, sh2 = self.screen.get_size()
                    dot_surf = self._dots_font.render(dots_str, True, (220, 220, 220))
                    self.screen.blit(dot_surf, dot_surf.get_rect(center=(sw2 // 2, sh2 // 2)))
                    pygame.display.flip()
                    continue

            if self._music:
                self._music.update(dt)

            self.screen.fill((0, 0, 0))

            _title_ready = (self._music is None) or self._music.title_ready

            if _title_ready:
                for petal in self._petals:
                    petal.update()
                    petal.draw(self.screen)
            else:
                # ── Intro video on black background ──────────────────────────
                if not self._video_done and self._video_cap is not None:
                    import cv2  # type: ignore

                    # Use wall-clock time so a large first-frame dt (caused by
                    # slow init) never skips past the end of the video.
                    now = time.time()
                    if self._video_start_wall is None:
                        self._video_start_wall = now

                    elapsed      = now - self._video_start_wall
                    target_frame = int(elapsed / self._video_frame_dur)
                    current_frame = int(self._video_cap.get(cv2.CAP_PROP_POS_FRAMES))

                    if target_frame > current_frame:
                        # Grab (no decode) all frames up to the one we want, then
                        # do a single full read for the target frame.
                        for _ in range(target_frame - current_frame - 1):
                            if not self._video_cap.grab():
                                break
                        ret, frame = self._video_cap.read()
                        if not ret:
                            self._video_cap.release()
                            self._video_cap  = None
                            self._video_done = True
                            if self._music:
                                self._music.on_intro_video_done()
                        else:
                            sw2, sh2 = self.screen.get_size()
                            fh, fw   = frame.shape[:2]
                            scaled_w = max(1, int(fw * sh2 / fh))
                            frame_small = cv2.resize(
                                frame, (scaled_w, sh2), interpolation=cv2.INTER_LINEAR
                            )
                            frame_rgb = cv2.cvtColor(frame_small, cv2.COLOR_BGR2RGB)
                            self._video_last_surf = pygame.surfarray.make_surface(
                                frame_rgb.transpose(1, 0, 2)
                            )

                    if self._video_last_surf is not None and not self._video_done:
                        sw2, sh2 = self.screen.get_size()
                        x = (sw2 - self._video_last_surf.get_width()) // 2
                        self.screen.blit(self._video_last_surf, (x, 0))

                    # ── Skip button ──────────────────────────────────────────
                    if not self._video_done and self._skip_img is not None and self._skip_rect is not None:
                        hovered = self._skip_rect.collidepoint(mouse_pos)
                        self._skip_img.set_alpha(255 if hovered else 150)
                        self.screen.blit(self._skip_img, self._skip_rect)
                        if mouse_clicked and hovered:
                            _audio.play_click()
                            self._video_cap.release()
                            self._video_cap  = None
                            self._video_done = True
                            if self._music:
                                self._music.skip_intro_to(self._video_duration)
                            _title_ready = (self._music is None) or self._music.title_ready

            if self.state == "title":
                if _title_ready:
                    action = self.title_screen.update(dt, mouse_pos, mouse_clicked, current_time)
                    self.title_screen.draw(current_time)
                    if action == "play":
                        _audio.play_click()
                        if self._music:
                            self._music.on_play_pressed()
                        self._start_transition("level_select",
                                               self.title_screen.play_button_rect.center)

            elif self.state == "level_select":
                ls_click  = mouse_clicked and self._level_menu is None
                ls_mouse  = mouse_pos if self._level_menu is None else (-9999, -9999)
                ls_events = events if self._level_menu is None else []
                action, idx = self.level_select.update(dt, ls_mouse, ls_click, current_time, ls_events)
                self.level_select.draw(current_time)

                # ── level detail popup ────────────────────────────────────────
                if self._level_menu is not None:
                    lm_action = self._level_menu.update(dt, mouse_pos, mouse_clicked, current_time, events)
                    self._level_menu.draw(current_time)
                    if lm_action == "play":
                        _audio.play_level_click()
                        self._pending_difficulty = self._level_menu._diff.difficulty
                        li = self._level_menu.song_idx
                        # persist BPM for custom songs
                        if self._level_menu.is_custom:
                            sname = self.song_names[li]
                            if self._level_menu.bpm is not None:
                                self._custom_bpms[sname] = self._level_menu.bpm
                            else:
                                self._custom_bpms.pop(sname, None)
                            _save_custom_bpms(self._custom_bpms)
                        self._pending_bpm = self._level_menu.bpm if self._level_menu.is_custom else None
                        self._pending_mode = getattr(self._level_menu, "mode", "words")
                        btn = self.level_select.level_buttons[li]
                        origin = (btn.rect.centerx,
                                  btn.rect.centery - self.level_select.scroll_offset)
                        self._level_menu = None
                        self._start_transition("launch", origin, li)
                    elif lm_action == "close":
                        self._level_menu = None

                # Poll file-picker subprocess started by upload button
                if self._pick_proc is not None and self._pick_proc.poll() is not None:
                    _picked_path = (self._pick_proc.stdout.read().strip()
                                    if self._pick_proc.stdout else "")
                    self._pick_proc = None
                    if _picked_path:
                        self._handle_upload(_picked_path, None)

                # Poll async copy thread (started by _handle_upload above)
                if self._uploading:
                    if self._upload_thread and not self._upload_thread.is_alive():
                        self._uploading = False
                        if self._upload_result:
                            _ok, _msg = self._upload_result[0]
                            if _ok:
                                self.level_select.reset(self.song_names, self._scores, self._canon_names)

                if action == "back":
                    self._start_transition("title", self.level_select.back_button.rect.center)
                elif action == "upload":
                    if self._pick_proc is None:  # prevent double-launch
                        self._pick_proc = start_pick_audio_file()
                elif action == "cancel_upload":
                    cancel_idx = idx
                    if 0 <= cancel_idx < len(self.song_names):
                        removed = self.song_names.pop(cancel_idx)
                        self.song_word_banks.pop(removed, None)
                        ls = self.level_select
                        if cancel_idx < len(ls.level_buttons):
                            ls.level_buttons.pop(cancel_idx)
                            ls.difficulty_selectors.pop(cancel_idx)
                            ls._full_names.pop(cancel_idx)
                        ls._tab_indices = [[], []]
                        for j, name in enumerate(self.song_names):
                            t = 0 if name in ls._canon_set else 1
                            ls._tab_indices[t].append(j)
                        ls._recompute_max_scrolls()
                elif action == "rename":
                    rename_idx, new_name = self.level_select._rename_result
                    self.level_select._full_names[rename_idx] = new_name
                    self.level_select.level_buttons[rename_idx].text = new_name
                elif action == "select":
                    _audio.play_click()
                    diff_idx  = self.level_select.difficulty_selectors[idx].selected
                    _btn      = self.level_select.level_buttons[idx]
                    _vis_y    = _btn.rect.y - self.level_select.scroll_offset
                    _origin   = pygame.Rect(_btn.rect.x, _vis_y, _btn.rect.w, _btn.rect.h)
                    _sname    = self.song_names[idx]
                    _is_cust  = _sname not in set(self._canon_names)
                    _cur_bpm  = self._custom_bpms.get(_sname) if _is_cust else None
                    self._level_menu = LevelMenu(
                        self.screen, idx, _sname,
                        diff_idx, self._scores, _origin,
                        is_custom=_is_cust, current_bpm=_cur_bpm,
                    )

            elif self.state == "upload":
                # Poll background copy thread
                if self._uploading:
                    if self._upload_thread and not self._upload_thread.is_alive():
                        self._uploading = False
                        if self._upload_result:
                            _ok, _msg = self._upload_result[0]
                            if _ok:
                                self.level_select.reset(self.song_names, self._scores, self._canon_names)
                                self.state = "level_select"
                            else:
                                self.file_upload_screen.show_error(_msg)
                    else:
                        # Draw "Copying…" overlay while thread runs
                        self.file_upload_screen.draw(current_time)
                        sw2, sh2 = self.screen.get_size()
                        _copy_font = pygame.font.Font(_FONT, 40)
                        _copy_surf = _copy_font.render("Copying file…", True, (180, 180, 220))
                        self.screen.blit(_copy_surf, _copy_surf.get_rect(center=(sw2 // 2, sh2 // 2 + 80)))
                else:
                    action, fpath, words = self.file_upload_screen.update(
                        dt, mouse_pos, mouse_clicked, current_time, events
                    )
                    self.file_upload_screen.draw(current_time)
                    if action == "back":
                        self.state = "level_select"
                    elif action == "upload":
                        ok, msg = self._handle_upload(fpath, words)
                        if ok is True:
                            self.level_select.reset(self.song_names, self._scores, self._canon_names)
                            self.state = "level_select"
                        elif ok is False:
                            self.file_upload_screen.show_error(msg or "Upload failed.")

            elif self.state == "transition":
                self._draw_transition(current_time)
                progress = (current_time - self.transition_start) / self.transition_duration
                if progress >= 1.0:
                    if self.transition_target_state == "launch":
                        idx        = self.transition_selected
                        difficulty = (self._pending_difficulty
                                      or self.level_select.difficulty_selectors[idx].difficulty)
                        self._pending_difficulty = None
                        word_bank  = self._word_bank_for(idx)
                        bpm        = self._pending_bpm
                        self._pending_bpm = None
                        mode       = getattr(self, "_pending_mode", "words") or "words"
                        self._pending_mode = None
                        return (idx, difficulty, word_bank, bpm, mode)
                    self.state = self.transition_target_state
                    if self.state == "title":
                        self.title_screen.reset()

            pygame.display.flip()

    def _handle_upload(self, file_path, word_bank: list[str] | None):
        """Start an upload. Returns (True, filename) if instant, (None, None) if async, (False, msg) on error."""
        try:
            dest_dir  = os.path.join("assets", "audios", "custom")
            filename  = os.path.basename(file_path)
            dest_path = os.path.join(dest_dir, filename)

            # Update in-memory state immediately so the song appears right away
            if filename in self.song_names:
                self.song_names.remove(filename)
            self.song_names.insert(0, filename)
            self.song_word_banks[filename] = word_bank if word_bank is not None else DEFAULT_WORD_BANK[:]

            if os.path.exists(dest_path):
                # File already present — just persist JSON synchronously (fast)
                _save_word_banks(self.song_word_banks)
                _custom = _load_custom_songs()
                if filename not in _custom:
                    _custom.append(filename)
                    _save_custom_songs(_custom)
                return True, filename

            # File needs copying — do it in a background thread
            result_box: list = []
            word_banks_snapshot = dict(self.song_word_banks)

            def _copy_worker():
                try:
                    shutil.copy2(file_path, dest_path)
                    _save_word_banks(word_banks_snapshot)
                    _custom = _load_custom_songs()
                    if filename not in _custom:
                        _custom.append(filename)
                        _save_custom_songs(_custom)
                    result_box.append((True, filename))
                except Exception as exc:
                    result_box.append((False, f"Upload failed: {exc}"))

            self._uploading = True
            self._upload_result = result_box
            self._upload_thread = threading.Thread(target=_copy_worker, daemon=True)
            self._upload_thread.start()
            return None, None  # async — caller must poll

        except Exception as e:
            return False, f"Upload failed: {e}"

    def _draw_transition(self, current_time):
        progress = min(1.0, (current_time - self.transition_start) / self.transition_duration)
        ease     = 1 - (1 - progress) ** 3
        sw, sh   = self.screen.get_size()

        if self._pre_transition_state == "title":
            self.title_screen.draw(current_time)
        else:
            self.level_select.draw(current_time)

        scale = 1.0 + ease * 0.5
        if scale != 1.0:
            copy   = self.screen.copy()
            scaled = pygame.transform.smoothscale(copy, (int(sw * scale), int(sh * scale)))
            ox, oy = self.transition_origin
            self.screen.fill((0, 0, 0))
            self.screen.blit(scaled, (int(ox - ox * scale), int(oy - oy * scale)))

        overlay = pygame.Surface((sw, sh), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, int(255 * ease)))
        self.screen.blit(overlay, (0, 0))

    def _start_transition(self, target_state, origin, selected=-1):
        self._pre_transition_state   = self.state
        self.state                   = "transition"
        self.transition_start        = time.time()
        self.transition_origin       = origin
        self.transition_target_state = target_state
        self.transition_selected     = selected


# ─── Pause overlay ────────────────────────────────────────────────────────────

class PauseScreen:
    BORDER_THICKNESS = 6
    FADE_DURATION    = 0.25

    def __init__(self, screen):
        self.screen = screen
        sw, sh = screen.get_size()
        btn_font = pygame.font.Font(_FONT, 56)
        self.resume_button = Button(
            (sw // 2 - 120, sh // 2 - 70, 240, 60), "RESUME", btn_font,
        )
        self.menu_button = Button(
            (sw // 2 - 120, sh // 2 + 50, 240, 60), "MAIN MENU", btn_font,
        )
        self.open_time = time.time()

    def update(self, mouse_pos, mouse_clicked):
        self.resume_button.check_hover(mouse_pos)
        self.menu_button.check_hover(mouse_pos)
        if self.resume_button.check_click(mouse_pos, mouse_clicked):
            return "resume"
        if self.menu_button.check_click(mouse_pos, mouse_clicked):
            return "menu"
        return None

    def draw(self, current_time):
        sw, sh = self.screen.get_size()
        t    = min(1.0, (current_time - self.open_time) / self.FADE_DURATION)
        ease = 1 - (1 - t) ** 3

        overlay = pygame.Surface((sw, sh), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, int(80 * ease)))
        self.screen.blit(overlay, (0, 0))

        thickness = int(self.BORDER_THICKNESS * ease)
        if thickness > 0:
            bright = int(255 * ease)
            c = (bright, bright, bright)
            pygame.draw.rect(self.screen, c, (0, 0, sw, thickness))
            pygame.draw.rect(self.screen, c, (0, sh - thickness, sw, thickness))
            pygame.draw.rect(self.screen, c, (0, 0, thickness, sh))
            pygame.draw.rect(self.screen, c, (sw - thickness, 0, thickness, sh))

        self.resume_button.draw(self.screen, current_time)
        self.menu_button.draw(self.screen, current_time)
