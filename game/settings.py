"""
Settings — one JSON file in the user's config directory, with defaults.

Keys the play screen reads:
  offset_ms          device timing offset (from calibration)
  speed_mult         0.5–3.0, scales the approach time
  key_guide          off | hints | keyboard
  noki_placement     line | corner | hidden
  stage_view         bool
  music_volume, hitsound_volume
  duets              auto | off | whole
  typing_tips        bool
"""
from __future__ import annotations

import json
import os

DEFAULTS: dict = {
    "offset_ms": 0.0,
    "speed_mult": 1.0,
    "key_guide": "off",
    "noki_placement": "line",
    "stage_view": False,
    "music_volume": 0.8,
    "hitsound_volume": 0.9,
    "duets": "auto",
    "typing_tips": True,
    "calibrated": False,
    "reduce_motion": False,
}


def config_dir() -> str:
    try:
        import platformdirs
        base = platformdirs.user_config_dir("Noki", "Noki")
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".noki")
    os.makedirs(base, exist_ok=True)
    return base


def settings_path() -> str:
    return os.path.join(config_dir(), "settings.json")


_cache: dict | None = None


def load_settings() -> dict:
    global _cache
    if _cache is not None:
        return dict(_cache)
    data = dict(DEFAULTS)
    try:
        with open(settings_path(), "r", encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            data.update({k: v for k, v in saved.items() if k in DEFAULTS})
    except Exception:
        pass
    _cache = data
    return dict(data)


def save_settings(update: dict) -> dict:
    global _cache
    data = load_settings()
    data.update({k: v for k, v in update.items() if k in DEFAULTS})
    tmp = settings_path() + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, settings_path())
    except Exception:
        pass
    _cache = data
    return dict(data)
