"""
LettersRenderer — the osu!-style mode: one letter per circle, no words.

The field is the whole screen inside a 60 px margin, split by a spine into
hands and by two lines into the top, home and bottom bands; faint column
lines and thirty anchor dots say where the keys are, and nothing is written
on the field.  Circles sit within the tier's free radius of their key's
anchor, an approach ring shrinks onto each, a follow line with a traveling
pulse joins consecutive circles, HP replaces hearts.  Same judgment core,
same colors, same effects language as the Highway.
"""
from __future__ import annotations

import math
import random

import pygame

from . import constants as C
from . import keyboard as KB
from . import models as M
from .highway import BG_CENTER, BG_EDGE, STAMP_COLORS, STAMP_TEXT, WHITE, weight_of_time
from .layout import Layout, DESIGN_W, DESIGN_H
from .sprites import (OrbCache, load_noki_frames, render_text, blur, multiply_alpha, glow_disk, aa_circle)

PREEMPT = {"journey": 1.5, "classic": 1.1, "master": 0.8, "demon": 0.6}
FREE_RADIUS = {"journey": 0, "classic": 90, "master": 150, "demon": 220}
CIRCLE_R = {"journey": 76, "classic": 64, "master": 54, "demon": 46}
HP_LOSS = {"journey": (8, 2), "classic": (12, 4), "master": (15, 5), "demon": (20, 6)}

MARGIN = 60
SPINE_X = 960
BANDS = [(60, 380), (380, 700), (700, 1020)]
LEFT_COLS = [147, 321, 495, 669, 843]
RIGHT_COLS = [1077, 1251, 1425, 1599, 1773]
BOTTOM_LEFT_COLS = [300, 440, 580, 720, 860]      # squeezed to clear Noki's pocket
ROW_STAGGER = [-40, 0, 40]
NOKI_POCKET = (0, 820, 250, 260)


def key_anchor(ch: str) -> tuple[int, int]:
    row = KB.row_of(ch)
    col = KB.COLUMN_OF.get(ch, 3)
    y = (BANDS[row][0] + BANDS[row][1]) // 2
    if col <= 4:
        x = BOTTOM_LEFT_COLS[col] if row == 2 else LEFT_COLS[col] + ROW_STAGGER[row]
    else:
        x = RIGHT_COLS[col - 5] + ROW_STAGGER[row]
    return x, y


class LettersRenderer:
    def __init__(self, layout: Layout, song: M.Song, rhythm, difficulty: str, settings: dict | None = None,
                 title: str = "", artist: str = "") -> None:
        self.L = layout
        self.song = song
        self.rhythm = rhythm
        self.difficulty = difficulty
        self.settings = settings or {}
        self.title = title
        self.preempt = max(PREEMPT.get(difficulty, 1.1), 1.5 * 60.0 / max(40.0, song.bpm)) / max(0.25, float(self.settings.get("speed_mult", 1.0)))
        self.r = CIRCLE_R.get(difficulty, 64)
        self.free = FREE_RADIUS.get(difficulty, 90) if self.settings.get("key_guide", "off") != "keyboard" else 0
        self.beat_dur = 60.0 / song.bpm if song.bpm else 0.5
        self.bar_dur = self.beat_dur * 4
        self.lead_in = rhythm.lead_in
        self.beat_times_chart = [bt + self.lead_in for bt in song.beat_times]
        self.hp = 100.0
        self.hp_loss_miss, self.hp_loss_slip = HP_LOSS.get(difficulty, (12, 4))
        self.failed = False
        self.no_fail = bool(self.settings.get("no_fail", False))

        self.orbs = OrbCache(layout)
        self._place_events()
        self._bake()
        h = self.L.S(246)
        self.noki_bop = load_noki_frames("noki_bop", h)
        self.noki_hurt = load_noki_frames("noki_hurt", h)
        self._hurt_t = -1.0

        self.bursts: list[dict] = []
        self.shards: list[dict] = []
        self.sparks: list[dict] = []
        self.stamps: list[dict] = []
        self._rng = random.Random(11)
        self._score_shown = 0.0
        self.rush_charge = 0.0
        self.duets: list = []

    # interface parity with the Highway
    def set_duets(self, spans) -> None:
        pass

    def set_layout(self, layout: Layout) -> None:
        """The window changed size: rebake the pixels, keep the state."""
        self.L = layout
        self.orbs = OrbCache(layout)
        self._bake()
        h = layout.S(246)
        self.noki_bop = load_noki_frames("noki_bop", h)
        self.noki_hurt = load_noki_frames("noki_hurt", h)

    def try_rush(self, t: float) -> bool:
        return False

    def rush_active(self, t: float) -> bool:
        return False

    # ── placement ──────────────────────────────────────────────────────────
    def _place_events(self) -> None:
        rng = random.Random(4242)
        self.pos: dict[int, tuple[float, float]] = {}
        r = self.r
        for ev in self.rhythm.beat_map:
            if ev.is_rest or not ev.char:
                continue
            ax, ay = key_anchor(ev.char)
            if self.free > 0:
                ang = rng.uniform(0, math.tau)
                rad = self.free * math.sqrt(rng.random())
                x, y = ax + math.cos(ang) * rad, ay + math.sin(ang) * rad
            else:
                x, y = float(ax), float(ay)
            row = KB.row_of(ev.char)
            lo, hi = BANDS[row]
            y = max(lo + r, min(hi - r, y))
            if KB.hand_of(ev.char) == 0:
                x = max(MARGIN + r, min(SPINE_X - 30 - r, x))
            else:
                x = max(SPINE_X + 30 + r, min(DESIGN_W - MARGIN - r, x))
            px, py, pw, ph = NOKI_POCKET
            if x - r < px + pw and y + r > py:
                x = px + pw + r + 4
            self.pos[id(ev)] = (x, y)
            if ev.weight < 0:
                ev.weight = weight_of_time(ev.timestamp - self.lead_in, self.song.beat_times, self.song.bpm)
            ev.lane = KB.lane_of(ev.char)

    def _bake(self) -> None:
        L = self.L
        W, H = L.win_w, L.win_h
        bg = pygame.Surface((W, H))
        try:
            import numpy as np
            ys, xs = np.mgrid[0:H, 0:W]
            cx, cy = L.X(DESIGN_W * 0.5), L.Y(DESIGN_H * 0.52)
            # the same airbrush as the Highway: an elliptical bloom on a smoothstep falloff
            d = np.sqrt(((xs - cx) / (W * 0.78)) ** 2 + ((ys - cy) / (H * 0.90)) ** 2)
            k = np.clip(1.0 - d, 0.0, 1.0)
            k = (k * k * (3.0 - 2.0 * k))[..., None]
            c0, c1 = np.array(BG_CENTER, dtype=float), np.array(BG_EDGE, dtype=float)
            arr = (c1 + (c0 - c1) * k).astype("uint8")
            bg = pygame.surfarray.make_surface(np.ascontiguousarray(arr.swapaxes(0, 1)))   # opaque on every display format
        except Exception:
            bg = pygame.Surface((W, H))
            bg.fill(BG_CENTER)
        ov = pygame.Surface((W, H), pygame.SRCALPHA)
        # home band fill, band lines edge to edge, spine, column lines, anchor dots
        pygame.draw.rect(ov, (255, 255, 255, int(255 * 0.03)), (0, L.Y(380), W, L.Y(700) - L.Y(380)))
        gw = max(1, L.S(2))
        for y in (380, 700):
            pygame.draw.line(ov, (222, 220, 255, int(255 * 0.16)), (0, L.Y(y)), (W, L.Y(y)), gw)
        for x in LEFT_COLS + RIGHT_COLS:
            pygame.draw.line(ov, (222, 220, 255, int(255 * 0.09)), (L.X(x), 0), (L.X(x), H), gw)
        pygame.draw.rect(ov, (255, 255, 255, int(255 * 0.025)), (L.X(930), 0, L.S(60), H))
        pygame.draw.line(ov, (255, 255, 255, int(255 * 0.30)), (L.X(960), 0), (L.X(960), H), max(1, L.S(2)))
        for ch in "qwertyuiopasdfghjklzxcvbnm":
            ax, ay = key_anchor(ch)
            pygame.draw.circle(ov, (255, 255, 255, int(255 * 0.18)), (L.X(ax), L.Y(ay)), max(2, L.S(3)))
        bg.blit(ov, (0, 0))
        self.bg = bg.convert()
        self._dim = pygame.Surface((W, H), pygame.SRCALPHA)
        self.disk = aa_circle(L.S(self.r), (255, 255, 255))
        self.rings = {lane: aa_circle(L.S(self.r), KB.lane_color(lane), max(2, L.S(4))) for lane in range(4)}
        self.halos = {lane: glow_disk(L.S(self.r * 1.5), KB.lane_color(lane), 0.18) for lane in range(4)}
        self.glyph_px = L.S(int(self.r * 1.05))

    # ── events from the session ───────────────────────────────────────────
    def _xy(self, ev):
        return self.pos.get(id(ev), (960, 540))

    def on_hit(self, ev, judgment, offset_ms, t):
        x, y = self._xy(ev)
        col = KB.lane_color(ev.lane)
        self.bursts.append({'x': x, 'y': y, 'lane': ev.lane, 'kind': judgment, 'age': 0.0, 'col': col})
        if judgment == 'perfect':
            self._spawn_shards(x, y, ev.lane, 6, col)
        self._spawn_sparks(x, y, 5 if judgment != 'ok' else 2, col)
        self._stamp(judgment, x, y - self.r - 30, offset_ms, t)
        self.hp = min(100.0, self.hp + 1.0)

    def on_hold_start(self, ev, judgment, offset_ms, t):
        self.on_hit(ev, judgment, offset_ms, t)

    def on_hold_complete(self, ev, judgment, t):
        x, y = self._xy(ev)
        self._spawn_sparks(x, y, 8, KB.GOLD)

    def on_miss(self, ev, t):
        x, y = self._xy(ev)
        self._stamp('miss', x, y - self.r - 30, 0.0, t)
        self._hurt_t = t
        self.hp -= self.hp_loss_miss
        if self.hp <= 0 and not self.no_fail:
            self.hp = 0.0
            self.failed = True

    def on_slip(self, ev, pressed, t):
        x, y = self._xy(ev)
        self._stamp('slip', x, y - self.r - 30, 0.0, t, extra=pressed.upper())
        self.hp = max(0.0, self.hp - self.hp_loss_slip)
        self.bursts.append({'x': x, 'y': y, 'lane': ev.lane, 'kind': 'slip', 'age': 0.0, 'col': KB.MISS_RED})

    def on_too_early(self, ev, t):
        pass

    def on_word_complete(self, word, clean, t):
        pass

    def _spawn_shards(self, x, y, lane, n, col):
        imgs = self.orbs.shards(lane)
        for k in range(n):
            ang = self._rng.uniform(0, math.tau)
            spd = self._rng.uniform(400, 700)
            self.shards.append({'x': x, 'y': y, 'vx': math.cos(ang) * spd, 'vy': math.sin(ang) * spd,
                                'img': imgs[k % len(imgs)], 'age': 0.0, 'life': 0.36, 'ang': ang})

    def _spawn_sparks(self, x, y, n, col):
        for _ in range(n):
            ang = self._rng.uniform(0, math.tau)
            spd = self._rng.uniform(150, 380)
            self.sparks.append({'x': x, 'y': y, 'vx': math.cos(ang) * spd, 'vy': math.sin(ang) * spd - 100,
                                'age': 0.0, 'life': self._rng.uniform(0.3, 0.5), 'r': self._rng.uniform(2, 4),
                                'col': col if self._rng.random() < 0.5 else WHITE})

    def _stamp(self, kind, x, y, offset_ms, t, extra=""):
        tag = ""
        if kind in ('good', 'ok') and abs(offset_ms) >= 25:
            tag = "EARLY" if offset_ms < 0 else "LATE"
        self.stamps.append({'kind': kind, 'x': x, 'y': y, 't0': t, 'tag': tag, 'extra': extra})

    # ── beat helpers ──────────────────────────────────────────────────────
    def beat_phase(self, t):
        import bisect
        bt = self.beat_times_chart
        if len(bt) < 2:
            return 0, 0.0
        i = bisect.bisect_right(bt, t) - 1
        if i < 0:
            return -1, 0.0
        if i >= len(bt) - 1:
            return i, 0.0
        return i, (t - bt[i]) / max(1e-6, bt[i + 1] - bt[i])

    # ── drawing ───────────────────────────────────────────────────────────
    def draw(self, screen, t, dt):
        L = self.L
        screen.blit(self.bg, (0, 0))
        self._draw_combo(screen)
        vis = self._visible(t)
        self._draw_follow_lines(screen, t, vis)
        self._draw_circles(screen, t, vis)
        self._draw_effects(screen, t, dt)
        self._draw_hud(screen, t, dt)
        self._draw_noki(screen, t, dt)
        self._draw_count_in(screen, t)

    def _visible(self, t):
        bm = self.rhythm.beat_map
        start = max(0, self.rhythm.char_event_idx - 6)
        out = []
        for i in range(start, len(bm)):
            ev = bm[i]
            if ev.is_rest or not ev.char:
                continue
            if ev.timestamp - t > self.preempt:
                break
            if ev.hit and t - ev.timestamp > 0.05:
                continue
            out.append(ev)
        return out

    def _draw_combo(self, screen):
        combo = self.rhythm.combo
        if combo < 5:
            return
        L = self.L
        s = multiply_alpha(render_text("display", L.S(200), str(combo), WHITE), 0.06)
        screen.blit(s, s.get_rect(center=(L.X(960), L.Y(600))))

    def _draw_follow_lines(self, screen, t, vis):
        L = self.L
        ov = pygame.Surface((L.win_w, L.win_h), pygame.SRCALPHA)
        prev = None
        drawn = False
        for ev in vis:
            if ev.hit:
                prev = ev
                continue
            if prev is not None and ev.timestamp - prev.timestamp < 2.5:
                x0, y0 = self._xy(prev)
                x1, y1 = self._xy(ev)
                col = KB.lane_color(ev.lane)
                a0 = 0.5 if not prev.hit else 0.7
                k = min(1.0, max(0.0, (t - (ev.timestamp - self.preempt)) / (self.preempt * 0.4)))
                pts = [(L.X(x0), L.Y(y0)), (L.X(x0 + (x1 - x0) * 0.35), L.Y(y0 + (y1 - y0) * 0.35 + 6)),
                       (L.X(x0 + (x1 - x0) * 0.7), L.Y(y0 + (y1 - y0) * 0.7 - 6)), (L.X(x1), L.Y(y1))]
                pygame.draw.lines(ov, (*col, int(255 * 0.30 * k)), False, pts, max(2, L.S(8)))
                pygame.draw.aalines(ov, (255, 255, 255, int(255 * a0 * k)), False, pts)
                # traveling pulse from prev hit time to this hit time
                if prev.hit and prev.timestamp <= t <= ev.timestamp:
                    p = (t - prev.timestamp) / max(1e-6, ev.timestamp - prev.timestamp)
                    px, py = x0 + (x1 - x0) * p, y0 + (y1 - y0) * p
                    pygame.draw.circle(ov, (255, 255, 255, 240), (L.X(px), L.Y(py)), max(3, L.S(7)))
                drawn = True
            prev = ev
        if drawn:
            screen.blit(ov, (0, 0))

    def _draw_circles(self, screen, t, vis):
        L = self.L
        r = L.S(self.r)
        for ev in reversed(vis):      # later circles under earlier ones
            x, y = self._xy(ev)
            cx, cy = L.X(x), L.Y(y)
            until = ev.timestamp - t
            lane = ev.lane
            if ev.hit:
                continue
            ok_w = self.rhythm.ok_window_for(ev)
            if until < -ok_w:
                age = -until - ok_w
                if age > 0.35:
                    continue
                k = age / 0.35
                ring = aa_circle(int(r * (1 - 0.3 * k)), KB.MISS_RED, max(2, L.S(4)), alpha=int(255 * (1 - k)))
                screen.blit(ring, ring.get_rect(center=(cx, cy)))
                continue
            k = 1.0 - max(0.0, until) / self.preempt        # 0 at spawn, 1 at hit
            fade = min(1.0, k / 0.4)
            # approach ring 3r → 1r
            ar = int(r * (3.0 - 2.0 * k))
            ring = aa_circle(ar, KB.lane_color(lane), max(2, L.S(4 if k > 0.6 else 3)), alpha=int(255 * (0.4 + 0.6 * k) * fade))
            screen.blit(ring, ring.get_rect(center=(cx, cy)))
            if k > 0.75:
                h = multiply_alpha(self.halos[lane], (k - 0.75) / 0.25)
                screen.blit(h, h.get_rect(center=(cx, cy)))
            disk = self.disk if fade >= 0.99 else multiply_alpha(self.disk, fade)
            screen.blit(disk, disk.get_rect(center=(cx, cy)))
            rg = self.rings[lane] if fade >= 0.99 else multiply_alpha(self.rings[lane], fade)
            screen.blit(rg, rg.get_rect(center=(cx, cy)))
            g = render_text("display", self.glyph_px, ev.char.upper(), KB.INK)
            if fade < 0.99:
                g = multiply_alpha(g, fade)
            screen.blit(g, g.get_rect(center=(cx, cy + L.S(2))))
            if ev.weight >= 3:
                o = aa_circle(int(r * 1.18), KB.lane_color(lane), max(1, L.S(2)), alpha=int(120 * fade))
                screen.blit(o, o.get_rect(center=(cx, cy)))

    def _draw_effects(self, screen, t, dt):
        L = self.L
        keep = []
        for b in self.bursts:
            b['age'] += dt
            if b['age'] > 0.32:
                continue
            k = b['age'] / 0.32
            rr = int(L.S(self.r) * (1.0 + 0.7 * k))
            ring = aa_circle(rr, b['col'], max(2, L.S(5)), alpha=int(255 * 0.5 * (1 - k)))
            screen.blit(ring, ring.get_rect(center=(L.X(b['x']), L.Y(b['y']))))
            if b['kind'] == 'perfect':
                rr2 = int(L.S(self.r) * (1.0 + 1.3 * k))
                ring2 = aa_circle(rr2, b['col'], max(1, L.S(3)), alpha=int(255 * 0.2 * (1 - k)))
                screen.blit(ring2, ring2.get_rect(center=(L.X(b['x']), L.Y(b['y']))))
            keep.append(b)
        self.bursts = keep
        keep = []
        for s in self.shards:
            s['age'] += dt
            if s['age'] > s['life']:
                continue
            s['x'] += s['vx'] * dt
            s['y'] += s['vy'] * dt
            k = s['age'] / s['life']
            img = multiply_alpha(pygame.transform.rotate(s['img'], -math.degrees(s['ang'])), 1 - k * k)
            screen.blit(img, img.get_rect(center=(L.X(s['x']), L.Y(s['y']))))
            keep.append(s)
        self.shards = keep
        keep = []
        for p in self.sparks:
            p['age'] += dt
            if p['age'] > p['life']:
                continue
            p['x'] += p['vx'] * dt
            p['y'] += p['vy'] * dt
            p['vy'] += 300 * dt
            k = 1 - p['age'] / p['life']
            pygame.draw.circle(screen, p['col'], (L.X(p['x']), L.Y(p['y'])), max(1, int(L.S(p['r'] * k))))
            keep.append(p)
        self.sparks = keep
        keep = []
        for st in self.stamps:
            age = t - st['t0']
            if age > 0.7:
                continue
            sc = 0.6 + 0.4 * (1 - (1 - min(1.0, age / 0.1)) ** 3)
            alpha = 1.0 if age < 0.45 else max(0.0, 1 - (age - 0.45) / 0.25)
            kind = st['kind']
            text = f"SLIP · {st['extra']}" if kind == 'slip' else STAMP_TEXT.get(kind, kind.upper())
            s = render_text("stamp", L.S(30 if kind != 'slip' else 22), text, STAMP_COLORS.get(kind, WHITE))
            if abs(sc - 1) > 0.01:
                s = pygame.transform.smoothscale(s, (max(1, int(s.get_width() * sc)), max(1, int(s.get_height() * sc))))
            if alpha < 1:
                s = multiply_alpha(s, alpha)
            screen.blit(s, s.get_rect(center=(L.X(st['x']), L.Y(st['y'] - 16 * age))))
            keep.append(st)
        self.stamps = keep

    def _draw_hud(self, screen, t, dt):
        L = self.L
        # HP bar top-left (no label)
        rect = pygame.Rect(L.X(L.left + 60), L.Y(L.top + 26), L.S(360), L.S(10))
        pygame.draw.rect(screen, (26, 26, 38), rect, border_radius=L.S(5))
        w = int(rect.w * max(0.0, self.hp) / 100.0)
        if w > 0:
            col = KB.lane_color(2) if self.hp > 30 else KB.MISS_RED
            pygame.draw.rect(screen, col, (rect.x, rect.y, w, rect.h), border_radius=L.S(5))
        pygame.draw.rect(screen, (120, 120, 140), rect, 1, border_radius=L.S(5))
        target = self.rhythm.get_score()
        self._score_shown += (target - self._score_shown) * min(1.0, 8.0 * dt)
        s = render_text("display", L.S(32), f"{int(self._score_shown):,} · {self.rhythm.get_accuracy():.1f} %", WHITE, cache=False)
        screen.blit(s, (L.X(L.right - 60) - s.get_width(), L.Y(L.top + 44) - s.get_height() // 2))
        c = render_text("display", L.S(56), f"{self.rhythm.combo}×", WHITE)
        c = multiply_alpha(c, 0.9)
        screen.blit(c, (L.X(L.right - 60) - c.get_width(), L.Y(L.bottom - 18) - c.get_height()))
        if self.failed:
            f = render_text("stamp", L.S(64), "FAILED", KB.MISS_RED)
            screen.blit(f, f.get_rect(center=(L.X(960), L.Y(540))))

    def _draw_noki(self, screen, t, dt):
        L = self.L
        if L.noki_placement == "hidden" or not self.noki_bop:
            return
        n = len(self.noki_bop)
        bi, p = self.beat_phase(t)
        if bi < 0:
            p = (t / self.beat_dur) % 1.0
            bi = int(t / self.beat_dur)
        norm = ((bi % 2) + p) / 2.0 if self.beat_dur >= 60.0 / 250.0 else ((bi % 4) + p) / 4.0
        frame = self.noki_bop[int(norm * n) % n]
        x, y = L.X(L.left + 36), L.Y(L.bottom - 8) - frame.get_height()
        screen.blit(frame, (x, y))
        if self._hurt_t >= 0 and self.noki_hurt:
            idx = int((t - self._hurt_t) * 30 * 1.15)
            if 0 <= idx < len(self.noki_hurt):
                hf = self.noki_hurt[idx]
                screen.blit(hf, (x + (frame.get_width() - hf.get_width()) // 2, L.Y(L.bottom - 8) - hf.get_height()))
            elif idx >= len(self.noki_hurt):
                self._hurt_t = -1.0

    def _draw_count_in(self, screen, t):
        L = self.L
        if not self.title or t > self.lead_in:
            return
        a = min(1.0, t / 0.6) * min(1.0, max(0.0, (self.lead_in - t) / 0.5))
        if a <= 0:
            return
        s = multiply_alpha(render_text("display", L.S(40), self.title, WHITE), a)
        screen.blit(s, s.get_rect(center=(L.X(960), L.Y(L.top + 120))))
