"""
Fold hit records into the numbers the coach speaks from.

Per key: presses, correct, slips (as expected / as pressed), median offset,
relative lateness (key median minus the run median).  Per finger and hand.
Confusion pairs classed as neighbor / row / mirror / jumped / double.
Streaks, pace, steadiness.  Everything is plain dicts so it can be stored as
JSON and merged across runs.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict

from .. import keyboard as KB

HIT_JUDGMENTS = {"perfect", "good", "ok", "hold_perfect", "hold_good", "hold_ok"}
MISS_JUDGMENTS = {"miss", "hold_broken"}


def _median(xs: list[float]) -> float:
    return statistics.median(xs) if xs else 0.0


def classify_pair(expected: str, pressed: str) -> str:
    e, p = expected.lower(), pressed.lower()
    if not p.isalpha() or not e.isalpha():
        return "other"
    if KB.MIRROR.get(e) == p:
        return "mirror"
    if KB.FINGER_OF.get(e) == KB.FINGER_OF.get(p) and KB.ROW_OF.get(e) != KB.ROW_OF.get(p):
        return "row"
    if KB.ROW_OF.get(e) == KB.ROW_OF.get(p) and abs(KB.COLUMN_OF.get(e, 0) - KB.COLUMN_OF.get(p, 9)) == 1:
        return "neighbor"
    return "other"


def fold(hits: list) -> dict:
    """One run's hit records → a stats dict (see module docstring)."""
    per_key: dict[str, dict] = defaultdict(lambda: {"presses": 0, "correct": 0, "slips_expected": 0,
                                                     "slips_pressed": 0, "offsets": [], "misses": 0})
    pairs: Counter = Counter()
    jumped = 0
    doubled = 0
    offsets_all: list[float] = []
    streak = best_streak = 0
    fast_slips = 0
    slips_total = 0
    first_offsets: list[float] = []
    mid_offsets: list[float] = []
    long_word_end_slips = 0
    long_word_ends = 0
    presses = 0
    active_span = 0.0
    last_t = None

    for h in hits:
        j = h.judgment
        k = (h.expected or "").lower()
        if j in HIT_JUDGMENTS:
            presses += 1
            d = per_key[k]
            d["presses"] += 1
            d["correct"] += 1
            if j in ("perfect", "good", "ok"):
                d["offsets"].append(h.offset_ms)
                offsets_all.append(h.offset_ms)
                if h.char_idx == 0:
                    first_offsets.append(h.offset_ms)
                elif h.char_idx > 0:
                    mid_offsets.append(h.offset_ms)
            streak += 1
            best_streak = max(best_streak, streak)
            if last_t is not None and 0 < h.t_song - last_t < 2.0:
                active_span += h.t_song - last_t
            last_t = h.t_song
        elif j == "slip":
            slips_total += 1
            streak = 0
            d = per_key[k]
            d["presses"] += 1
            d["slips_expected"] += 1
            p = (h.pressed or "").lower()
            if p.isalpha():
                per_key[p]["slips_pressed"] += 1
                pairs[(k, p)] += 1
                w = h.word or ""
                if 0 <= h.char_idx + 1 < len(w) and w[h.char_idx + 1] == p:
                    jumped += 1
                if h.char_idx > 0 and h.char_idx - 1 < len(w) and w[h.char_idx - 1] == p:
                    doubled += 1
            if 0 <= h.gap_ms < 150:
                fast_slips += 1
            if len(h.word or "") >= 7 and h.char_idx >= len(h.word) - 2:
                long_word_end_slips += 1
        elif j in MISS_JUDGMENTS:
            streak = 0
            per_key[k]["presses"] += 1
            per_key[k]["misses"] += 1
        if len(h.word or "") >= 7 and h.char_idx >= len(h.word) - 2 and j != "too_early":
            long_word_ends += 1

    run_median = _median(offsets_all)
    keys: dict[str, dict] = {}
    for k, d in per_key.items():
        if not k.isalpha():
            continue
        acc = d["correct"] / d["presses"] if d["presses"] else 0.0
        med = _median(d["offsets"])
        keys[k] = {
            "presses": d["presses"], "correct": d["correct"], "accuracy": acc,
            "slips_expected": d["slips_expected"], "slips_pressed": d["slips_pressed"], "misses": d["misses"],
            "median_offset": med, "relative_late": (med - run_median) if d["offsets"] else 0.0,
            "n_timed": len(d["offsets"]),
        }
    # fingers / hands
    fingers: dict[int, dict] = defaultdict(lambda: {"presses": 0, "correct": 0, "offsets": []})
    hands: dict[int, dict] = defaultdict(lambda: {"presses": 0, "correct": 0, "offsets": []})
    for k, d in keys.items():
        f = KB.finger_of(k)
        hnd = KB.hand_of(k)
        for tgt in (fingers[f], hands[hnd]):
            tgt["presses"] += d["presses"]
            tgt["correct"] += d["correct"]
            tgt["offsets"].extend(per_key[k]["offsets"])
    fingers_out = {f: {"presses": v["presses"], "accuracy": (v["correct"] / v["presses"] if v["presses"] else 0.0),
                       "relative_late": _median(v["offsets"]) - run_median if v["offsets"] else 0.0,
                       "n_timed": len(v["offsets"]),
                       "keys": sorted(k for k in keys if KB.finger_of(k) == f)} for f, v in fingers.items()}
    hands_out = {h: {"presses": v["presses"], "accuracy": (v["correct"] / v["presses"] if v["presses"] else 0.0),
                     "relative_late": _median(v["offsets"]) - run_median if v["offsets"] else 0.0,
                     "n_timed": len(v["offsets"])} for h, v in hands.items()}
    pair_rows = [{"expected": e, "pressed": p, "count": c, "kind": classify_pair(e, p)} for (e, p), c in pairs.most_common(12)]
    sigma = statistics.pstdev(offsets_all) if len(offsets_all) > 1 else 0.0
    lpm = (presses / active_span * 60.0) if active_span > 0 else 0.0
    return {
        "keys": keys, "fingers": fingers_out, "hands": hands_out, "pairs": pair_rows,
        "jumped": jumped, "doubled": doubled, "slips": slips_total, "fast_slips": fast_slips,
        "presses": presses, "best_streak": best_streak, "run_median_offset": run_median, "sigma": sigma,
        "lpm": lpm, "wpm": lpm / 5.0,
        "first_letter_late": (_median(first_offsets) - _median(mid_offsets)) if first_offsets and mid_offsets else 0.0,
        "long_word_end_slips": long_word_end_slips, "long_word_ends": long_word_ends,
        "n_timed": len(offsets_all),
    }


def merge(history: dict | None, run: dict, weight: float = 1.0) -> dict:
    """Merge a run into a history dict with recency weighting (older runs decay by 0.85)."""
    hist = dict(history or {})
    keys = dict(hist.get("keys", {}))
    for k, d in run["keys"].items():
        old = keys.get(k, {"presses": 0.0, "correct": 0.0, "slips_expected": 0.0, "late_sum": 0.0, "n_timed": 0.0})
        keys[k] = {
            "presses": old["presses"] * 0.85 + d["presses"] * weight,
            "correct": old["correct"] * 0.85 + d["correct"] * weight,
            "slips_expected": old["slips_expected"] * 0.85 + d["slips_expected"] * weight,
            "late_sum": old["late_sum"] * 0.85 + d["relative_late"] * d["n_timed"] * weight,
            "n_timed": old["n_timed"] * 0.85 + d["n_timed"] * weight,
        }
    for k, v in keys.items():
        v["accuracy"] = v["correct"] / v["presses"] if v["presses"] else 0.0
        v["relative_late"] = v["late_sum"] / v["n_timed"] if v["n_timed"] else 0.0
    hist["keys"] = keys
    hist["runs"] = int(hist.get("runs", 0)) + 1
    hist["letters"] = int(hist.get("letters", 0)) + int(run.get("presses", 0))
    hist["best_streak"] = max(int(hist.get("best_streak", 0)), int(run.get("best_streak", 0)))
    hist["best_wpm"] = max(float(hist.get("best_wpm", 0.0)), float(run.get("wpm", 0.0)))
    return hist
