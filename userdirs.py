"""Where goose keeps what is not in the repo: your settings, and its caches.

One module, because three of them used to spell this out — the charting cache,
the sprite cache and the settings file — and three copies of a path are three
chances to disagree about it.

The game was called Noki before it was called goose.  Anything already written
under the old name is taken along on first use, so the rename does not cost
anyone their settings, or make them sit through every song being analysed again.
"""
from __future__ import annotations

import os
import shutil

APP = "goose"
#: what the directories were called before the game was
LEGACY_APP = "Noki"


def _base(kind: str, app: str) -> str:
    """The platform's directory of `kind` ("cache" or "config") for `app`."""
    try:
        import platformdirs
        fn = platformdirs.user_cache_dir if kind == "cache" else platformdirs.user_config_dir
        return fn(app, app)
    except Exception:
        # no platformdirs: a dotfolder in the home directory, as the game always did
        home = os.path.join(os.path.expanduser("~"), "." + app.lower())
        return os.path.join(home, "cache") if kind == "cache" else home


def _adopt(kind: str) -> str:
    """The directory for `kind`, moving what the old name holds into it once.

    A failed move is not worth an error to anyone: the old directory is simply
    used where it stands, and the game carries on out of it.
    """
    new = _base(kind, APP)
    if os.path.isdir(new):
        return new
    old = _base(kind, LEGACY_APP)
    if os.path.isdir(old):
        try:
            os.makedirs(os.path.dirname(new) or ".", exist_ok=True)
            shutil.move(old, new)
        except Exception:
            return old
    return new


def config_dir() -> str:
    """Settings live here.  Created if it does not exist."""
    p = _adopt("config")
    os.makedirs(p, exist_ok=True)
    return p


def cache_dir(*parts: str) -> str:
    """A cache directory, `parts` deep.  Created if it does not exist.

    Everything under here can be deleted at any time and the game will rebuild
    it — the charts take a song's analysis to rebuild, so it is worth keeping.
    """
    p = os.path.join(_adopt("cache"), *parts)
    os.makedirs(p, exist_ok=True)
    return p
