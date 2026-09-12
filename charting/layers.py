"""
Layers — which instrument a phrase follows.

Keyboard Warrior's charts (read off the reels) sit on the melody for most of a song, but
where another part carries a catchy figure — a kick pattern, a bass riff, the hats — the
chart follows that instead, either for a phrase at a time (melody, then the riff, then
the melody again) or, when neither part is busy, both at once.  Nothing here is tied to a
time in a song: each four-bar phrase is scored per layer for *catchiness* — how loud the
part is, how much its rhythm repeats from bar to bar, how much of it sits off the beat,
and whether it has a playable number of onsets — and the plan follows from the scores.

``plan_layers`` gives one ``LayerPlan`` per phrase: a primary layer, an optional secondary
one, and a mode — ``solo`` (one layer), ``alt`` (a phrase handed to a riff between melody
phrases) or ``combined`` (both layers' onsets, where the tier allows and the sum stays
playable).  Easy and Normal share a plan, so Easy stays a thinned Normal; Hard and Demon
combine more readily.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import skeleton as SK

PHRASE_BARS = 4
LEAD_BONUS = 1.3                      # the melody wins ties: it is the chart's default voice
LEAD_PRESENT = (1.5, 0.30)            # onsets per bar, mean strength: below this the phrase has no lead
ALT_RATIO = {"journey": 0.8, "classic": 0.8, "master": 0.75, "demon": 0.7}   # riff catch ≥ ratio × lead catch to take a phrase
MIN_LEAD_RUN = 2                      # melody phrases before a riff phrase may interrupt
# (max primary onsets/bar, max secondary onsets/bar, max total/bar) for a combined phrase; the
# secondary must not already be busy, or the two together would be a wall of notes
COMBINE = {"classic": (3.0, 2.5, 5.0), "master": (6.0, 5.0, 9.0), "demon": (8.0, 6.0, 12.0)}
COMBINE_MIN_CATCH = 0.45              # the secondary must be at least this catchy relative to the primary
ONSET_FLOOR = 0.28                    # a layer value under this is not an onset


@dataclass
class LayerPlan:
    idx: int
    bar0: int
    bar1: int
    t0: float
    t1: float
    primary: str
    secondary: str | None = None
    mode: str = "solo"                # solo | alt | combined
    scores: dict = field(default_factory=dict)   # layer -> {"catch", "act", "strength", "rep"}

    def layers(self) -> list[str]:
        return [self.primary] + ([self.secondary] if self.secondary else [])


def bar_vectors(sk: SK.Skeleton) -> dict[str, np.ndarray]:
    """Per layer, an (n_bars × 16) grid of onset strengths (0 where the layer has no onset)."""
    n = sk.n_bars
    out = {name: np.zeros((n, 16), dtype=np.float32) for name in SK.LAYERS}
    for p in sk.points:
        if p.bar >= n:
            continue
        col = p.beat * 4 + p.sub
        for name in SK.LAYERS:
            v = p.layer(name)
            if v >= ONSET_FLOOR and p.layer_peak(name):
                out[name][p.bar, col] = min(1.0, v)
    return out


def _shape(act: float) -> float:
    """How playable a part's density is: nothing under an onset a bar, full between 3 and 8 a bar,
    fading past that (a sixteenth-note hat part is a texture, not a figure)."""
    if act < 1.0:
        return 0.0
    if act < 3.0:
        return (act - 1.0) / 2.0
    if act <= 8.0:
        return 1.0
    return max(0.4, 1.0 - (act - 8.0) / 8.0 * 0.6)


def score_layer(grid: np.ndarray) -> dict:
    """Catchiness of one layer over a few bars of its onset grid."""
    if grid.size == 0:
        return {"catch": 0.0, "act": 0.0, "strength": 0.0, "rep": 0.0}
    hits = grid > 0
    act = float(hits.sum(axis=1).mean())
    tops = np.sort(grid, axis=1)[:, -4:]
    strength = float(tops[tops > 0].mean()) if (tops > 0).any() else 0.0
    rep = 0.0
    if grid.shape[0] >= 2:
        sims = []
        for lag in (1, 2):
            for b in range(grid.shape[0] - lag):
                a, c = hits[b].astype(np.float32), hits[b + lag].astype(np.float32)
                na, nc = float(np.linalg.norm(a)), float(np.linalg.norm(c))
                if na > 0 and nc > 0:
                    sims.append(float(a @ c) / (na * nc))
        rep = float(np.mean(sims)) if sims else 0.0
    offbeat = float(hits[:, [c for c in range(16) if c % 4 != 0]].sum() / max(1, hits.sum()))
    interest = 0.6 + 0.4 * offbeat
    catch = strength * (0.5 + 0.5 * rep) * _shape(act) * interest
    return {"catch": round(catch, 3), "act": round(act, 2), "strength": round(strength, 3), "rep": round(rep, 3)}


def plan_layers(sk: SK.Skeleton, tier_key: str) -> list[LayerPlan]:
    """One plan per four-bar phrase.  See the module docstring for the rules."""
    n = sk.n_bars
    if n == 0:
        return []
    vecs = bar_vectors(sk)
    ratio = ALT_RATIO.get(tier_key, 0.8)
    combine = COMBINE.get(tier_key)
    plans: list[LayerPlan] = []
    lead_run = 0
    for i, b0 in enumerate(range(0, n, PHRASE_BARS)):
        b1 = min(n, b0 + PHRASE_BARS)
        t0 = sk.bar_start[b0]
        t1 = sk.bar_start[b1] if b1 < n else sk.beat_times[-1]
        scores = {name: score_layer(vecs[name][b0:b1]) for name in SK.LAYERS}
        lead = scores["lead"]
        lead_present = lead["act"] >= LEAD_PRESENT[0] and lead["strength"] >= LEAD_PRESENT[1]
        lead_catch = lead["catch"] * LEAD_BONUS if lead_present else 0.0
        others = [(name, s) for name, s in scores.items() if name != "lead" and 1.0 <= s["act"] <= 12.0]
        best = max(others, key=lambda ns: ns[1]["catch"], default=None)
        plan = LayerPlan(i, b0, b1, t0, t1, "lead", None, "solo", scores)
        if lead_present:
            plan.primary = "lead"
            if best is not None and best[1]["catch"] >= ratio * lead_catch and lead_run >= MIN_LEAD_RUN:
                plan.primary, plan.secondary, plan.mode = best[0], "lead", "alt"
                lead_run = 0
            else:
                lead_run += 1
                if best is not None:
                    plan.secondary = best[0]
        else:
            # no tune: the busiest catchy part carries the phrase (a drum intro, a bass break)
            if best is None:
                best = max(((name, s) for name, s in scores.items() if name != "lead"), key=lambda ns: ns[1]["act"], default=None)
            plan.primary = best[0] if best is not None else "lead"
            if lead["act"] >= 1.0:
                plan.secondary = "lead"
            lead_run = 0
        # combined: both parts, when the tier allows and neither is already busy
        if plan.secondary is not None and combine is not None:
            p_act, s_act = scores[plan.primary]["act"], scores[plan.secondary]["act"]
            max_p, max_s, max_t = combine
            catchy = scores[plan.secondary]["catch"] >= COMBINE_MIN_CATCH * max(1e-6, scores[plan.primary]["catch"])
            if catchy and p_act <= max_p and s_act <= max_s and p_act + s_act <= max_t and s_act >= 1.0:
                plan.mode = "combined"
            elif plan.mode != "alt":
                plan.secondary = None
        elif plan.mode != "alt":
            plan.secondary = None
        if plan.mode == "alt" and plan.secondary is not None and combine is None:
            plan.secondary = None
        plans.append(plan)
    return plans


def plan_for_bar(plans: list[LayerPlan], bar: int) -> LayerPlan | None:
    for pl in plans:
        if pl.bar0 <= bar < pl.bar1:
            return pl
    return plans[-1] if plans else None
