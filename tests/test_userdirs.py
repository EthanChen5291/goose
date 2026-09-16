"""The directories outside the repo: settings, and the caches.

What is worth testing here is the rename.  The game used to write under "Noki";
it writes under "goose" now, and the one thing that must not happen is a player
losing their settings — or their chart cache, which costs a full analysis of
every song they own to rebuild.
"""
import os

import pytest

import userdirs


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    """Point both app names at a scratch tree and hand back the four paths."""
    roots = {
        ("cache", userdirs.APP): tmp_path / "Caches" / "goose",
        ("cache", userdirs.LEGACY_APP): tmp_path / "Caches" / "Noki",
        ("config", userdirs.APP): tmp_path / "Support" / "goose",
        ("config", userdirs.LEGACY_APP): tmp_path / "Support" / "Noki",
    }
    monkeypatch.setattr(userdirs, "_base", lambda kind, app: str(roots[(kind, app)]))
    return roots


def test_fresh_install_writes_under_the_new_name(dirs):
    assert userdirs.config_dir() == str(dirs[("config", userdirs.APP)])
    assert os.path.isdir(userdirs.config_dir())


def test_settings_written_under_the_old_name_come_along(dirs):
    old = dirs[("config", userdirs.LEGACY_APP)]
    old.mkdir(parents=True)
    (old / "settings.json").write_text('{"music_volume": 0.3}', encoding="utf-8")

    new = userdirs.config_dir()

    assert new == str(dirs[("config", userdirs.APP)])
    assert (dirs[("config", userdirs.APP)] / "settings.json").read_text(encoding="utf-8") == '{"music_volume": 0.3}'
    assert not old.exists(), "the old directory should be moved, not copied and left behind"


def test_a_cached_chart_survives_the_rename(dirs):
    old = dirs[("cache", userdirs.LEGACY_APP)] / "charts"
    old.mkdir(parents=True)
    (old / "abc123.json").write_text("{}", encoding="utf-8")

    assert os.path.exists(os.path.join(userdirs.cache_dir("charts"), "abc123.json"))


def test_the_new_name_wins_when_both_exist(dirs):
    """Once moved, a stale directory under the old name is ignored, not merged."""
    for kind in ("cache", "config"):
        for app in (userdirs.APP, userdirs.LEGACY_APP):
            dirs[(kind, app)].mkdir(parents=True)
    (dirs[("config", userdirs.LEGACY_APP)] / "settings.json").write_text("stale", encoding="utf-8")

    assert userdirs.config_dir() == str(dirs[("config", userdirs.APP)])
    assert not (dirs[("config", userdirs.APP)] / "settings.json").exists()


def test_an_unmovable_old_directory_is_used_where_it_stands(dirs, monkeypatch):
    """A move that fails is not worth an error to a player: carry on out of the old one."""
    old = dirs[("config", userdirs.LEGACY_APP)]
    old.mkdir(parents=True)
    monkeypatch.setattr(userdirs.shutil, "move", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))

    assert userdirs.config_dir() == str(old)


def test_cache_parts_nest(dirs):
    assert userdirs.cache_dir("sprites", "1440") == str(
        dirs[("cache", userdirs.APP)] / "sprites" / "1440")
