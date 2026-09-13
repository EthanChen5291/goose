"""
Golden-replay parity: prove the TypeScript judgment core is the Python one.

Ports are checked by re-running the unit tests, which only proves the tests were
ported too.  This instead builds a *tape* — a deterministic, interleaved script of
frame ticks, key presses and key releases against a real shipped chart — runs it
through `game.rhythm.RhythmManager`, and writes the tape plus every judgment and
every final statistic to JSON.  `tests/parity.test.ts` replays the same tape
through the TypeScript core and demands an exact match.

The tape includes the cases that are easy to get wrong: presses inside every
window, presses just outside them, wrong keys, skipped notes, holds released
early and late, and anchors pressed out of order.

    python3 web/tools/parity_dump.py            # writes web/tests/parity_cases.json
"""
from __future__ import annotations

import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

from game import models as M                                    # noqa: E402
from game.rhythm import RhythmManager, BASE_WINDOWS_S             # noqa: E402
from charting import _events_from_json, _events_to_json          # noqa: E402
from game.coach.stats import fold                                # noqa: E402
from game.coach.tips import build_tips, pick, lint                # noqa: E402

CHARTS = os.path.join(ROOT, "assets", "charts")
OUT = os.path.join(os.path.dirname(HERE), "tests", "parity_cases.json")
FRAME = 1.0 / 60.0


class TapeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def build_tape(events: list[M.CharEvent], lead_in: float, timing_scale: float,
               seed: int, windows: dict[str, float]) -> list[dict]:
    """A deterministic press script over the chart, with a frame tick every 1/60 s.

    Each playable note draws a behaviour: land it somewhere in a window, miss it
    late, slip a wrong key first, press it far too early, or skip it entirely.
    Holds get a release that is sometimes early enough to break them.

    Every fifth note is aimed *exactly* at a window boundary instead.  Bands that
    politely avoid the edges are the ones that let a ported ``<=`` pass as a
    ``<``, or a 150 ms window pass as a 152 ms one: the mutation run proved it.
    Likewise the hold releases straddle the release grace itself, not just the
    comfortable middle.  Floats make this safe rather than flaky — both languages
    are IEEE 754 doubles doing the same two subtractions, so a press placed on a
    boundary lands on the same side of the comparison in both.
    """
    rng = random.Random(seed)
    actions: list[dict] = []
    playable = [e for e in events if not e.is_rest and e.char]
    # the exact edges of every window, and one ulp either side of each
    edges: list[float] = []
    for w in (windows["perfect"], windows["good"], windows["ok"]):
        edges += [w, math.nextafter(w, 0.0), math.nextafter(w, 1.0)]
    for n, e in enumerate(playable):
        t = e.timestamp + lead_in
        roll = rng.random()
        if roll < 0.10:
            continue                                    # skipped: becomes a miss
        if roll < 0.18:
            actions.append({"kind": "press", "t": round(t - 0.45, 6), "key": e.char})
            continue                                    # far too early, then nothing
        if roll < 0.26:
            wrong = "qwertyuiop"[rng.randrange(10)]
            if wrong.lower() != e.char.lower():
                actions.append({"kind": "press", "t": round(t - 0.02, 6), "key": wrong})
        if n % 5 == 0:
            # exactly on a boundary, from either side of the note
            off = rng.choice(edges) * rng.choice([-1.0, 1.0])
        else:
            band = rng.random()
            if band < 0.45:
                off = rng.uniform(-0.070, 0.070) * timing_scale
            elif band < 0.75:
                off = rng.choice([-1, 1]) * rng.uniform(0.076, 0.149) * timing_scale
            elif band < 0.92:
                off = rng.choice([-1, 1]) * rng.uniform(0.151, 0.224) * timing_scale
            else:
                off = rng.choice([-1, 1]) * rng.uniform(0.226, 0.320) * timing_scale
        # a boundary press must not be rounded off the boundary it is testing
        actions.append({"kind": "press", "t": t + off, "key": e.char})
        if e.hold_duration > 0:
            # a hold completes when released at or after end - duration × grace(0.12),
            # so these straddle 0.88 tightly as well as sitting well clear of it
            frac = rng.choice([1.05, 0.95, 0.8801, 0.8799, 0.87, 0.50])
            actions.append({"kind": "release", "t": t + e.hold_duration * frac, "key": e.char})
    return actions


def frame_count(inputs: list[dict]) -> int:
    end = max([a["t"] for a in inputs], default=0.0) + 2.0
    return int(end / FRAME) + 1


def weave(inputs: list[dict], frames: int) -> list[dict]:
    """Inputs and frame ticks in the order PlaySession.update would see them.

    A frame runs `rhythm.update()` before it reads the keys pressed during it, so
    at an equal timestamp the frame tick sorts first.  The sort is stable on both
    sides, so TypeScript rebuilding this from (inputs, frames) lands on the same
    list the Python run used.
    """
    actions = list(inputs) + [{"kind": "frame", "t": round(i * FRAME, 6)} for i in range(frames)]
    actions.sort(key=lambda a: (a["t"], 0 if a["kind"] == "frame" else 1))
    return actions


def run_tape(events, bpm, lead_in, timing_scale, tape) -> dict:
    clock = TapeClock()
    rm = RhythmManager(events, bpm, lead_in=lead_in, timing_scale=timing_scale, clock=clock)
    results: list[dict] = []
    for a in tape:
        clock.t = a["t"]
        if a["kind"] == "frame":
            missed = rm.update()
            if missed:
                results.append({"at": a["t"], "kind": "missed",
                                "chars": [e.char for e in missed]})
            if rm.anchor_results:
                results.append({"at": a["t"], "kind": "anchors",
                                "judgments": [r["judgment"] for r in rm.anchor_results]})
                rm.anchor_results = []
        elif a["kind"] == "press":
            r = rm.check_input(a["key"])
            results.append({"at": a["t"], "kind": "press", "judgment": r["judgment"],
                            "hit": r["hit"], "combo": r["combo"],
                            "word_complete": r["is_word_complete"],
                            "offset_ms": round(r["offset"] * 1000.0, 6)})
        else:
            r = rm.on_key_release(a["key"])
            results.append({"at": a["t"], "kind": "release",
                            "judgment": (r or {}).get("judgment", ""),
                            "hit": bool((r or {}).get("hit", False))})
    stats = rm.get_stats()
    # the typing coach folds the same hit log; it is pure, so it parity-checks the
    # same way.  Two settings are dumped because the calibration tip only fires on
    # a calibrated device, and it is the one tip that can outrank every other.
    run = fold(rm.hits)
    run_out = _jsonable(run)
    # dict order is meaningful here and JSON objects do not preserve integer-key
    # order in JavaScript: hand it over as a list (see RunStats.finger_order)
    run_out["finger_order"] = list(run["fingers"].keys())
    run_out["hand_order"] = list(run["hands"].keys())
    coach = {"run": run_out, "variants": []}
    for name, settings, history in (
        ("plain", {}, None),
        ("calibrated", {"calibrated": True}, None),
        ("with_history", {}, {"best_streak": 999}),
    ):
        tips = build_tips(run, settings, history)
        sentences, instruction = pick(tips, {})
        coach["variants"].append({
            "name": name,
            "tips": [{"id": t["id"], "priority": t["priority"], "n": t["n"],
                      "text": t["text"], "try": t["try"], "action": t["action"],
                      "keys": list(t["keys"])} for t in tips],
            "sentences": sentences,
            "instruction_id": instruction["id"] if instruction else None,
            "lint": {t["id"]: lint(t["text"]) for t in tips},
        })
    return {
        "coach": coach,
        "results": results,
        "hits": [
            {"t_song": round(h.t_song, 6), "expected": h.expected, "pressed": h.pressed,
             "judgment": h.judgment, "offset_ms": round(h.offset_ms, 6), "word": h.word,
             "char_idx": h.char_idx, "gap_ms": round(h.gap_ms, 6), "weight": h.weight,
             "lane": h.lane, "voice": h.voice}
            for h in rm.hits
        ],
        "stats": {k: (round(v, 9) if isinstance(v, float) else v) for k, v in stats.items()},
    }


def _jsonable(v):
    """Round floats so the dump is stable, and make dict keys JSON-safe."""
    if isinstance(v, float):
        return round(v, 9)
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def pick_charts() -> tuple[list[str], list[str]]:
    """A spread of charts: every tier × both modes, each on a different song.

    One song across all eight would prove much less: tiers differ in timing scale
    and note density, and songs differ in where the holds and anchors land.
    """
    index = json.load(open(os.path.join(CHARTS, "index.json"), encoding="utf-8"))["charts"]
    keys = sorted(index)
    songs = sorted({k.split("|")[0] for k in keys})
    want: list[str] = []
    i = 0
    for tier in ("journey", "classic", "master", "demon"):
        for mode in ("words", "letters"):
            for _ in range(len(songs)):
                cand = f"{songs[i % len(songs)]}|{tier}|{mode}"
                i += 1
                if cand in index:
                    want.append(cand)
                    break
    return [index[k] for k in want], want


def main() -> None:
    ids, names = pick_charts()
    cases = []
    for cid, name in zip(ids, names):
        path = os.path.join(CHARTS, cid + ".json")
        data = json.load(open(path, encoding="utf-8"))
        events = _events_from_json(data["events"])
        lead_in = data["lead_in"]
        bpm = data["song"]["bpm"]
        tier = name.split("|")[1]
        from game import constants as C
        ts = C.DIFFICULTY_PROFILES[tier].timing_scale
        for seed in (1, 7):
            windows = {k: v * ts for k, v in BASE_WINDOWS_S.items()}
            inputs = build_tape(events, lead_in, ts, seed, windows)
            frames = frame_count(inputs)
            tape = weave(inputs, frames)
            out = run_tape(events, bpm, lead_in, ts, tape)
            cases.append({
                "name": f"{name}#{seed}",
                "chart_id": cid,
                "bpm": bpm,
                "lead_in": lead_in,
                "timing_scale": ts,
                "events": _events_to_json(events),
                # only the presses and releases are stored; the frame ticks are a
                # fixed 1/60 s grid that both sides rebuild the same way
                "inputs": inputs,
                "frames": frames,
                "expected": out,
            })
            print(f"{name}#{seed}: {len(tape)} actions, {len(out['hits'])} hits, "
                  f"score {out['stats']['score']}, acc {out['stats']['accuracy']:.2f}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    mb = os.path.getsize(OUT) / 1e6
    print(f"\nwrote {OUT} ({len(cases)} cases, {mb:.1f} MB)")


if __name__ == "__main__":
    main()
