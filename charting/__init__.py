"""
charting — turns a song and a word list into a chart (a list of CharEvents),
deterministically, with a disk cache keyed by song, words, difficulty and
generator version.

``build_chart`` is the only entry point the game uses.  Today it runs the
Skeleton & Cells engine (``charting.engine``) and falls back to the legacy
slot builder if the engine raises, so a bad chart never blocks play.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict

from game import constants as C
from game import models as M

GENERATOR_VERSION = "sc-2.0"   # sections (patterns, anchors, extra holds) + melody-weighted slots


def _cache_dir() -> str:
    try:
        import platformdirs
        base = platformdirs.user_cache_dir("Noki", "Noki")
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".noki", "cache")
    p = os.path.join(base, "charts")
    os.makedirs(p, exist_ok=True)
    return p


def prune_stale_caches() -> None:
    """A new generator never reads the old charts or skeletons: drop them once, on first use.

    The chart cache holds a marker with the generator that wrote it; when the marker differs
    from ``GENERATOR_VERSION`` every cached chart is removed, along with skeleton files from
    older analysis versions, and the marker is rewritten.
    """
    try:
        d = _cache_dir()
        marker = os.path.join(d, "generator.txt")
        current = open(marker, "r", encoding="utf-8").read().strip() if os.path.exists(marker) else ""
        if current == GENERATOR_VERSION:
            return
        for f in os.listdir(d):
            if f.endswith(".json"):
                os.remove(os.path.join(d, f))
        sk_dir = os.path.join(d, "skeletons")
        if os.path.isdir(sk_dir):
            from .engine import SKELETON_VERSION
            for f in os.listdir(sk_dir):
                if f.endswith(".json") and not f.endswith(f"_{SKELETON_VERSION}.json"):
                    os.remove(os.path.join(sk_dir, f))
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write(GENERATOR_VERSION)
    except Exception:
        pass


def song_fingerprint(path: str) -> str:
    """Cheap, stable identity for an audio file: size + mtime + the first 64 KB."""
    h = hashlib.sha1()
    try:
        st = os.stat(path)
        h.update(f"{st.st_size}|{int(st.st_mtime)}".encode())
        with open(path, "rb") as f:
            h.update(f.read(65536))
    except OSError:
        h.update(path.encode())
    return h.hexdigest()[:16]


def chart_id(song_path: str, words: list[str], difficulty: str, mode: str, bpm: int | None) -> str:
    h = hashlib.sha1()
    h.update(song_fingerprint(song_path).encode())
    h.update(("|".join(sorted(set(w.lower() for w in words)))).encode())
    h.update(f"|{difficulty}|{mode}|{bpm}|{GENERATOR_VERSION}".encode())
    return h.hexdigest()[:20]


def _event_defaults() -> dict:
    from dataclasses import fields, MISSING
    out = {}
    for f in fields(M.CharEvent):
        if f.default is not MISSING:
            out[f.name] = f.default
        elif f.default_factory is not MISSING:   # type: ignore[attr-defined]
            out[f.name] = f.default_factory()    # type: ignore[misc]
    return out


def _events_to_json(events: list[M.CharEvent]) -> list[dict]:
    """Compact rows: fields that equal the dataclass default are left out."""
    defaults = _event_defaults()
    rows = []
    for e in events:
        d = asdict(e)
        rows.append({k: v for k, v in d.items() if k not in defaults or defaults[k] != v})
    return rows


def _events_from_json(rows: list[dict]) -> list[M.CharEvent]:
    out = []
    for r in rows:
        r = {k: v for k, v in r.items() if k in M.CharEvent.__dataclass_fields__}
        out.append(M.CharEvent(**r))
    return out


REPO_CHARTS = os.path.join(C.BASE_DIR, "assets", "charts")   # charts shipped with the game (tools/prechart.py)


def load_cached(cid: str) -> dict | None:
    """A chart shipped in assets/charts first, then the user's cache."""
    for d in (REPO_CHARTS, _cache_dir()):
        p = os.path.join(d, cid + ".json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["events"] = _events_from_json(data["events"])
            return data
        except Exception:
            continue
    return None


def save_cached(cid: str, data: dict) -> None:
    p = os.path.join(_cache_dir(), cid + ".json")
    try:
        out = dict(data)
        out["events"] = _events_to_json(data["events"])
        with open(p, "w", encoding="utf-8") as f:
            json.dump(out, f)
    except Exception:
        pass


def build_chart(level: M.Level, song_path: str, progress=None) -> dict:
    """Return {'song': Song, 'events': [CharEvent], 'lead_in', 'meta': {...}} for a level.

    Uses the chart cache when the same song + words + difficulty was charted before.
    """
    prune_stale_caches()
    cid = chart_id(song_path, level.word_bank, level.difficulty, level.mode, level.bpm)
    cached = load_cached(cid)
    if cached is not None:
        s = cached["song"]
        song = M.Song(s["bpm"], s["duration"], song_path, s["beat_times"])
        return {"song": song, "events": cached["events"], "lead_in": cached["lead_in"],
                "meta": cached.get("meta", {}), "chart_id": cid, "from_cache": True}

    t0 = time.perf_counter()
    from .engine import chart_song
    result = chart_song(level, song_path, progress=progress)
    song: M.Song = result["song"]
    data = {
        "song": {"bpm": song.bpm, "duration": song.duration, "beat_times": list(song.beat_times)},
        "events": result["events"],
        "lead_in": result["lead_in"],
        "meta": dict(result.get("meta", {}), generator=GENERATOR_VERSION, build_seconds=round(time.perf_counter() - t0, 2)),
    }
    save_cached(cid, data)
    return {"song": song, "events": result["events"], "lead_in": result["lead_in"],
            "meta": data["meta"], "chart_id": cid, "from_cache": False}
