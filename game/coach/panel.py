"""
TypingPanel — the results-screen "Typing" view (Tab).

One picture, three sentences, one thing to try: the keyboard heatmap tinted
by accuracy, Noki with a speech bubble, and the instruction line.  Reads the
folded stats and the tip library; writes the run into the local history so
next time the praise and the cooldowns are honest.
"""
from __future__ import annotations

import json
import os

import pygame

from .. import keyboard as KB
from ..settings import config_dir, load_settings
from ..sprites import get_font, render_text, load_noki_frames, multiply_alpha
from .stats import fold, merge
from .tips import build_tips, pick

_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
_ROW_INDENT = [0.0, 0.5, 1.0]


def history_path() -> str:
    return os.path.join(config_dir(), "typing_history.json")


def load_history() -> dict:
    try:
        with open(history_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_history(h: dict) -> None:
    try:
        tmp = history_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(h, f)
        os.replace(tmp, history_path())
    except Exception:
        pass


def record_run(hits: list, stats_run: dict | None = None) -> tuple[dict, dict, list[str], dict | None]:
    """Fold a run, merge into history, decide the sentences. Returns (run_stats, history, sentences, instruction)."""
    run = stats_run or fold(hits)
    hist = load_history()
    settings = load_settings()
    tips = build_tips(run, settings, hist)
    cooldown = {k: v for k, v in hist.get("cooldown", {}).items() if v > 0}
    sentences, instruction = pick(tips, cooldown)
    # advance cooldowns and set new ones for the sentences shown
    new_cd = {k: v - 1 for k, v in cooldown.items() if v - 1 > 0}
    for t in tips:
        if t["text"] in sentences and t["priority"] <= 4:
            new_cd[t["id"]] = 3
    hist = merge(hist, run)
    hist["cooldown"] = new_cd
    save_history(hist)
    return run, hist, sentences, instruction


class TypingPanel:
    def __init__(self, screen: pygame.Surface, hits: list, stats: dict, level_name: str, difficulty: str) -> None:
        self.screen = screen
        self.level_name = level_name
        self.difficulty = difficulty
        self.run, self.history, self.sentences, self.instruction = record_run(hits)
        self.t = 0.0
        sw, sh = screen.get_size()
        self.sw, self.sh = sw, sh
        self.s = min(sw / 1920, sh / 1080)
        self.tile = int(64 * self.s)
        self.pitch = int(76 * self.s)
        self.kb_x = int(160 * self.s)
        self.kb_y = int(400 * self.s)
        self.noki = load_noki_frames("noki_bop", int(300 * self.s))
        self._dim = pygame.Surface((sw, sh), pygame.SRCALPHA)
        self._dim.fill((4, 4, 10, 235))

    def _tile_color(self, k: str) -> tuple:
        d = self.run["keys"].get(k)
        if d is None or d["presses"] < 6:
            return (58, 58, 72)
        acc = d["accuracy"]
        lane = KB.lane_color(KB.lane_of(k))
        if acc >= 0.95:
            return (240, 240, 250)
        if acc >= 0.85:
            return tuple(int(c * 0.45 + 40) for c in lane)
        if acc >= 0.75:
            return tuple(int(c * 0.85) for c in lane)
        return KB.MISS_RED

    def draw(self, dt: float) -> None:
        self.t += dt
        scr = self.screen
        s = self.s
        scr.blit(self._dim, (0, 0))
        title = render_text("display", int(30 * s), f"TYPING · {self.level_name}", (230, 230, 240))
        scr.blit(title, (self.kb_x, int(300 * s)))
        # keyboard: tiles pop in row by row
        pop_i = 0
        for r, row in enumerate(_ROWS):
            for c, k in enumerate(row):
                delay = pop_i * 0.032
                pop_i += 1
                if self.t < delay:
                    continue
                k_t = min(1.0, (self.t - delay) / 0.12)
                sc = 0.6 + 0.4 * (1 - (1 - k_t) ** 3)
                x = self.kb_x + int((c + _ROW_INDENT[r]) * self.pitch)
                y = self.kb_y + r * self.pitch
                size = int(self.tile * sc)
                rect = pygame.Rect(0, 0, size, size)
                rect.center = (x + self.tile // 2, y + self.tile // 2)
                col = self._tile_color(k)
                pygame.draw.rect(scr, col, rect, border_radius=int(10 * s))
                d = self.run["keys"].get(k)
                ink = (20, 20, 30) if sum(col) > 400 else (240, 240, 250)
                letter = render_text("display", int(26 * s), k.upper(), ink)
                scr.blit(letter, letter.get_rect(center=(rect.centerx, rect.centery - int(8 * s))))
                if d is not None and d["presses"] >= 6:
                    pct = render_text("body", int(14 * s), f"{int(d['accuracy'] * 100)}", ink)
                    scr.blit(pct, pct.get_rect(center=(rect.centerx, rect.centery + int(14 * s))))
                    if abs(d["relative_late"]) >= 20 and d["n_timed"] >= 3:
                        arrow = "▲" if d["relative_late"] < 0 else "▼"
                        a = render_text("body", int(12 * s), arrow, ink)
                        scr.blit(a, (rect.right - a.get_width() - int(4 * s), rect.top + int(3 * s)))
                    slips = min(5, d["slips_expected"])
                    for i in range(slips):
                        pygame.draw.circle(scr, KB.MISS_RED, (rect.left + int(8 * s) + i * int(9 * s), rect.bottom - int(7 * s)), int(3 * s))
        # Noki + bubble
        bx = int(1180 * s)
        if self.noki:
            n = len(self.noki)
            frame = self.noki[int((self.t * 2.2) % 1.0 * n) % n]
            scr.blit(frame, (int(1520 * s), int(360 * s)))
        by = int(420 * s)
        bubble_w = int(330 * s)
        lines: list[pygame.Surface] = []
        font = get_font("display_regular", int(24 * s))
        for i, sent in enumerate(self.sentences):
            if self.t < 0.9 + i * 0.5:
                break
            for chunk in self._wrap(sent, font, bubble_w - int(32 * s)):
                lines.append(font.render(chunk, True, (20, 20, 30)))
        if lines:
            h = sum(l.get_height() for l in lines) + int(28 * s)
            rect = pygame.Rect(bx, by, bubble_w, h)
            pygame.draw.rect(scr, (245, 245, 250), rect, border_radius=int(18 * s))
            pygame.draw.polygon(scr, (245, 245, 250), [(rect.right - int(20 * s), rect.centery - int(10 * s)),
                                                        (rect.right + int(18 * s), rect.centery),
                                                        (rect.right - int(20 * s), rect.centery + int(10 * s))])
            yy = rect.top + int(14 * s)
            for l in lines:
                scr.blit(l, (rect.left + int(16 * s), yy))
                yy += l.get_height()
        if self.instruction and self.t > 0.9 + len(self.sentences) * 0.5:
            lab = render_text("stamp", int(18 * s), "TRY THIS", KB.GOLD)
            scr.blit(lab, (bx, int(720 * s)))
            txt = render_text("body", int(24 * s), self.instruction["try"], (230, 230, 240))
            scr.blit(txt, (bx, int(750 * s)))
        # strip
        run = self.run
        weak_f = None
        worst = 1.0
        for f, d in run["fingers"].items():
            if d["presses"] >= 8 and d["accuracy"] < worst:
                worst, weak_f = d["accuracy"], f
        parts = []
        if weak_f is not None:
            parts.append(f"Weakest finger: {KB.FINGER_NAMES[weak_f]}")
        if run["wpm"] > 0:
            parts.append(f"Pace: {int(round(run['wpm']))} words a minute (set by the song)")
        parts.append(f"Slips {run['slips']}")
        strip = render_text("body", int(18 * s), "   ·   ".join(parts), (150, 155, 175))
        scr.blit(strip, (self.kb_x, self.kb_y + 3 * self.pitch + int(30 * s)))
        hint = render_text("body", int(16 * s), "TAB or ESC · back", (110, 115, 140))
        scr.blit(hint, hint.get_rect(bottomright=(self.sw - int(40 * s), self.sh - int(30 * s))))

    @staticmethod
    def _wrap(text: str, font: pygame.font.Font, width: int) -> list[str]:
        words = text.split()
        lines: list[str] = []
        cur = ""
        for w in words:
            trial = (cur + " " + w).strip()
            if font.size(trial)[0] <= width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        return lines
