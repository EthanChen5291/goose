"""
The tip library: rules over the folded stats → three short sentences and one
thing to try.  No model anywhere.  Every sentence is twelve words or fewer,
second person, names the key and the finger, counts instead of milliseconds.

Priority classes: 1 calibration · 2 mix-ups · 3 timing by finger/hand ·
4 habits · 5 praise.  Cooldowns keep a tip from repeating for three songs.
"""
from __future__ import annotations

from .. import keyboard as KB

BANNED = {"latency", "metric", "metrics", "optimize", "optimise", "leverage", "cadence", "consistency",
          "variance", "offset", "accuracy rate", "performance", "data", "error", "utilize"}


def _finger_name(f: int) -> str:
    return KB.FINGER_NAMES[f] if 0 <= f < len(KB.FINGER_NAMES) else "finger"


def _keys_phrase(keys: list[str]) -> str:
    ks = [k.upper() for k in keys]
    if len(ks) == 1:
        return ks[0]
    if len(ks) == 2:
        return f"{ks[0]} and {ks[1]}"
    return ", ".join(ks[:-1]) + f" and {ks[-1]}"


def _count_word(n: int) -> str:
    return {1: "once", 2: "twice", 3: "three times", 4: "four times", 5: "five times"}.get(n, f"{n} times")


def build_tips(stats: dict, settings: dict | None = None, history: dict | None = None) -> list[dict]:
    """All tips that fire for this run, sorted by priority then impact.

    Each tip: {'id', 'priority', 'text', 'try', 'action', 'keys', 'n'}.
      action: 'offset:+20' | 'drill:keys' | 'drill:words' | 'practice_loop' | ''
    """
    settings = settings or {}
    tips: list[dict] = []
    keys = stats.get("keys", {})
    fingers = stats.get("fingers", {})
    hands = stats.get("hands", {})
    n_timed = stats.get("n_timed", 0)

    # 1 · calibration (only on a calibrated device, and only when the whole run leans one way)
    med = stats.get("run_median_offset", 0.0)
    if settings.get("calibrated") and n_timed >= 24 and abs(med) >= 20 and stats.get("sigma", 99) <= 45:
        late = med > 0
        tips.append({"id": "cal_late" if late else "cal_early", "priority": 1, "n": n_timed,
                     "text": "Everything landed a little " + ("late." if late else "early."),
                     "try": f"Apply {'+' if late else '-'}{int(abs(med))} ms to your timing.",
                     "action": f"offset:{int(med)}", "keys": []})

    # 2 · mix-ups
    for row in stats.get("pairs", []):
        e, p, c, kind = row["expected"], row["pressed"], row["count"], row["kind"]
        if kind == "neighbor" and c >= 3:
            tips.append({"id": f"neighbor_{e}{p}", "priority": 2, "n": c, "keys": [e],
                         "text": f"You pressed {p.upper()} instead of {e.upper()} {_count_word(c)}. They sit next to each other.",
                         "try": f"Slow down one step on {e.upper()}.", "action": "drill:keys"})
        elif kind == "row" and c >= 3:
            f = KB.finger_of(e)
            home = KB.HOME_KEY_OF_FINGER.get(f, "the home row")
            tips.append({"id": f"row_{e}{p}", "priority": 2, "n": c, "keys": [e, p],
                         "text": f"{e.upper()} and {p.upper()} share a finger. Your {_finger_name(f).split()[1]} is drifting a row.",
                         "try": f"Bring it home to {home.upper()} after each press.", "action": "drill:keys"})
        elif kind == "mirror" and c >= 2:
            side = "left" if KB.hand_of(e) == 0 else "right"
            tips.append({"id": f"mirror_{e}{p}", "priority": 2, "n": c, "keys": [e],
                         "text": f"You typed {p.upper()} for {e.upper()}. That's the other hand.",
                         "try": f"{e.upper()} lives on the {side}. Feel for the bump.", "action": "drill:keys"})
    if stats.get("jumped", 0) >= 3:
        tips.append({"id": "jumped", "priority": 2, "n": stats["jumped"], "keys": [],
                     "text": f"You typed the next letter too soon {_count_word(stats['jumped'])}.",
                     "try": "One letter per beat.", "action": "practice_loop"})
    if stats.get("doubled", 0) >= 3:
        tips.append({"id": "doubled", "priority": 2, "n": stats["doubled"], "keys": [],
                     "text": f"You pressed the same letter twice {_count_word(stats['doubled'])}.",
                     "try": "Lift after each press.", "action": "practice_loop"})

    # 3 · timing by finger / hand
    for f, d in fingers.items():
        if d["n_timed"] >= 8 and d["relative_late"] >= 25:
            ks = [k for k in d["keys"] if keys.get(k, {}).get("n_timed", 0) >= 3][:3] or d["keys"][:2]
            home = KB.HOME_KEY_OF_FINGER.get(f, "")
            tips.append({"id": f"late_finger_{f}", "priority": 3, "n": d["n_timed"], "keys": ks,
                         "text": f"Your {_finger_name(f)} is late on {_keys_phrase(ks)}.",
                         "try": (f"Rest your {_finger_name(f).split()[1]} on {home.upper()} between words." if home and home.isalpha()
                                 else f"Keep your {_finger_name(f)} closer to the keys."), "action": "drill:keys"})
        elif d["n_timed"] >= 8 and d["relative_late"] <= -25:
            ks = d["keys"][:2]
            tips.append({"id": f"early_finger_{f}", "priority": 3, "n": d["n_timed"], "keys": ks,
                         "text": f"Your {_finger_name(f)} jumps in early on {_keys_phrase(ks)}.",
                         "try": "Wait for the ring to close.", "action": "practice_loop"})
    if 0 in hands and 1 in hands and hands[0]["n_timed"] >= 12 and hands[1]["n_timed"] >= 12:
        diff = hands[0]["relative_late"] - hands[1]["relative_late"]
        if abs(diff) >= 20:
            slow = "left" if diff > 0 else "right"
            fast = "right" if diff > 0 else "left"
            tips.append({"id": f"hand_{slow}", "priority": 3, "n": 24, "keys": [],
                         "text": f"Your {slow} hand runs behind your {fast}.",
                         "try": f"Practice this: {slow}-hand keys.", "action": "drill:keys"})

    # 4 · habits
    slips = stats.get("slips", 0)
    if slips >= 5 and stats.get("fast_slips", 0) / max(1, slips) >= 0.6:
        tips.append({"id": "rushed", "priority": 4, "n": slips, "keys": [],
                     "text": "You rushed the fast parts.", "try": "Wait for the ring to close.", "action": "practice_loop"})
    if n_timed >= 30 and stats.get("first_letter_late", 0.0) >= 30:
        tips.append({"id": "first_late", "priority": 4, "n": n_timed, "keys": [],
                     "text": "You start each word a bit late.", "try": "Look one word ahead. The stack shows it.", "action": ""})
    if stats.get("long_word_ends", 0) >= 6 and stats.get("long_word_end_slips", 0) / max(1, stats["long_word_ends"]) >= 0.3:
        tips.append({"id": "long_words", "priority": 4, "n": stats["long_word_ends"], "keys": [],
                     "text": "Long words fall apart near the end.", "try": "Practice this: six-letter words, Easy.", "action": "drill:words"})
    weak = sorted((k for k, d in keys.items() if d["presses"] >= 6 and d["accuracy"] < 0.85), key=lambda k: keys[k]["accuracy"])
    pinky_slips = sum(keys[k]["slips_expected"] for k in keys if KB.finger_of(k) in (0, 9))
    if slips >= 5 and pinky_slips / max(1, slips) >= 0.4:
        tips.append({"id": "pinkies", "priority": 4, "n": pinky_slips, "keys": ["q", "a", "z", "p"],
                     "text": "Most slips were on your pinkies.", "try": "Practice this: Q A Z and P.", "action": "drill:keys"})
    if weak and not any(t["priority"] <= 3 for t in tips):
        k = weak[0]
        tips.append({"id": f"weak_{k}", "priority": 4, "n": keys[k]["presses"], "keys": weak[:3],
                     "text": f"{k.upper()} is your slowest key.", "try": f"Practice this: {_keys_phrase(weak[:3])}.", "action": "drill:keys"})

    # 5 · praise (specific and true)
    best = stats.get("best_streak", 0)
    hist_best = int((history or {}).get("best_streak", 0))
    if best >= 8 and best >= hist_best:
        tips.append({"id": "streak", "priority": 5, "n": best, "keys": [],
                     "text": f"{best} letters in a row with no slips. That's your best.", "try": "", "action": ""})
    for h, d in hands.items():
        if d["n_timed"] >= 15 and abs(d["relative_late"]) < 10:
            tips.append({"id": f"steady_{h}", "priority": 5, "n": d["n_timed"], "keys": [],
                         "text": f"Your {'left' if h == 0 else 'right'} hand was steady the whole song.", "try": "", "action": ""})
            break
    if not tips:
        tips.append({"id": "nothing", "priority": 5, "n": 0, "keys": [],
                     "text": "Nothing to fix today. Play something harder.", "try": "Next song up one tier.", "action": ""})
    tips.sort(key=lambda t: (t["priority"], -t["n"]))
    return tips


def pick(tips: list[dict], cooldown: dict | None = None, max_sentences: int = 3) -> tuple[list[str], dict | None]:
    """Three sentences and the instruction to try, honoring cooldowns ({tip_id: songs_left})."""
    cooldown = cooldown or {}
    chosen: list[dict] = []
    used_keys: set[str] = set()
    for t in tips:
        if cooldown.get(t["id"], 0) > 0:
            continue
        if any(k in used_keys for k in t["keys"]) and t["priority"] <= 3:
            continue
        chosen.append(t)
        used_keys.update(t["keys"])
        if len(chosen) >= max_sentences:
            break
    # guarantee one praise line if the first three are all fixes
    if chosen and all(t["priority"] <= 4 for t in chosen):
        praise = next((t for t in tips if t["priority"] == 5 and t not in chosen), None)
        if praise is not None:
            chosen = chosen[:max_sentences - 1] + [praise]
    sentences = [t["text"] for t in chosen]
    instruction = next((t for t in chosen if t["try"]), None)
    return sentences, instruction


def lint(sentence: str) -> list[str]:
    """Style-guide check: <= 12 words, no banned jargon. Returns the violations."""
    problems = []
    for part in [s for s in sentence.replace("!", ".").split(".") if s.strip()]:
        if len(part.split()) > 12:
            problems.append("more than twelve words")
            break
    low = sentence.lower()
    for b in BANNED:
        if b in low:
            problems.append(f"banned word: {b}")
    return problems
