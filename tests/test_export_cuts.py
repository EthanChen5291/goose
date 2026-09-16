"""How web/tools/export_web.py cuts the audio it ships.

The cuts are numbers measured off the masters — where the theme's first beat is,
where a recording's first footstep is — and nothing at runtime will notice if
one of them drifts: the game will just feel slightly wrong.  So they are checked
here, along with the two decisions the exporter makes on its own (what to
re-encode, and the ffmpeg call it makes to do it).
"""
import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def export():
    spec = importlib.util.spec_from_file_location(
        "export_web", os.path.join(ROOT, "web", "tools", "export_web.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the cuts themselves ──────────────────────────────────────────────────────

def test_the_theme_is_a_whole_number_of_bars(export):
    """It loops end to end, so a cut that is not whole bars drops a beat every pass."""
    bar = 4 * 60 / export.THEME_BPM
    bars = export.THEME.dur / bar
    assert bars == pytest.approx(round(bars), abs=1e-6), f"{bars:.4f} bars"
    assert round(bars) == 72


def test_the_theme_starts_on_its_first_beat(export):
    """The track opens on its drop; the room tone before it is what start trims."""
    assert 0.3 < export.THEME.start < 0.4


def test_the_theme_pickup_is_about_a_beat_long(export):
    """What start trims is the master's lift into bar 1, and it is used as such.

    A pickup that came out longer than a beat would be trimming music, and one
    much shorter would not reach the ring it is mixed over.
    """
    beat = 60 / export.THEME_BPM
    assert 0.8 * beat < export.THEME.start <= beat


def test_every_waddle_is_trimmed_and_levelled(export):
    """Dead air at the front of these lands as a late footstep under the goose."""
    waddles = [c for c in export.EFFECTS if c.out.startswith("gooserun")]
    assert len(waddles) == 3
    for cut in waddles:
        assert cut.start > 0, f"{cut.out} still opens on room tone"
        assert cut.start < 0.2, f"{cut.out} trims into the first step"
        assert cut.peak_db == -4.4, f"{cut.out} is off the level the kit shares"


def test_the_hitsound_is_left_as_it_was(export):
    """Every run leans on it; it was already mastered where it wants to be."""
    hit = next(c for c in export.EFFECTS if c.out == "hitsound.mp3")
    assert (hit.start, hit.dur, hit.peak_db) == (0.0, None, None)


# ── what gets rebuilt ────────────────────────────────────────────────────────

def test_a_missing_output_is_stale(export, tmp_path):
    src = tmp_path / "a.wav"; src.write_bytes(b"x")
    assert export.is_stale(str(src), str(tmp_path / "gone.mp3"))


def test_an_output_older_than_its_source_is_stale(export, tmp_path):
    src = tmp_path / "a.wav"; src.write_bytes(b"x")
    dst = tmp_path / "a.mp3"; dst.write_bytes(b"x")
    os.utime(dst, (0, 0))
    assert export.is_stale(str(src), str(dst))


def test_an_output_older_than_the_recipe_is_stale(export, tmp_path):
    """Editing a trim here has to re-encode a file whose source never moved."""
    src = tmp_path / "a.wav"; src.write_bytes(b"x")
    dst = tmp_path / "a.mp3"; dst.write_bytes(b"x")
    os.utime(src, (0, 0))
    os.utime(dst, (100, 100))
    assert not export.is_stale(str(src), str(dst), recipe=50)
    assert export.is_stale(str(src), str(dst), recipe=200)


# ── the call it makes ────────────────────────────────────────────────────────

def test_an_untouched_file_is_only_re_encoded(export):
    args = export.encode_args("in.wav", "out.mp3")
    assert "-ss" not in args and "-t" not in args and "-af" not in args
    assert args[-1] == "out.mp3"
    assert "libmp3lame" in args


def test_a_cut_becomes_a_trim(export):
    args = export.encode_args("in.wav", "out.mp3", start=0.115, dur=2.305)
    assert args[args.index("-ss") + 1] == "0.1150"
    assert args[args.index("-t") + 1] == "2.3050"
    # ffmpeg reads the trim off the decoded input, so it has to follow -i
    assert args.index("-i") < args.index("-ss")


def test_a_levelled_file_is_lifted_and_folded_to_mono(export):
    args = export.encode_args("in.wav", "out.mp3", peak_db=-4.4, gain_db=21.7)
    assert args[args.index("-af") + 1] == "highpass=f=40,volume=21.7dB"
    assert args[args.index("-ac") + 1] == "1"


def test_the_theme_is_cut_and_spliced_in_one_pass(export):
    """Both halves come out of the same master, so both trims are on [0:a]."""
    args = export.theme_args("in.wav", "out.mp3")
    graph = args[args.index("-filter_complex") + 1]
    assert graph.count("[0:a]atrim") == 2
    assert args[args.index("-map") + 1] == "[out]"
    assert "libmp3lame" in args and args[-1] == "out.mp3"


def test_the_theme_takes_its_lift_from_the_head_of_the_master(export):
    """The pickup is what start trims, so the second trim opens at zero."""
    args = export.theme_args("in.wav", "out.mp3")
    graph = args[args.index("-filter_complex") + 1]
    assert f"atrim=start=0:duration={export.THEME.start:.6f}" in graph


def test_the_theme_lift_ends_exactly_where_the_cut_does(export):
    """A pickup delayed to the wrong beat is the dropped beat, moved.

    It has to land so its last sample is the cut's last sample; anywhere else
    and the loop either doubles a beat or keeps the hole it was cut to close.
    """
    args = export.theme_args("in.wav", "out.mp3")
    graph = args[args.index("-filter_complex") + 1]
    delay = float(graph.split("adelay=")[1].split(":")[0]) / 1000
    assert delay + export.THEME.start == pytest.approx(export.THEME.dur, abs=1e-3)


def test_the_theme_lift_is_mixed_under_the_ring_it_joins(export):
    """Replacing the ending would cut the decay off; amix keeps it."""
    args = export.theme_args("in.wav", "out.mp3")
    graph = args[args.index("-filter_complex") + 1]
    assert "amix=inputs=2:duration=first:normalize=0" in graph
    assert f"afade=t=in:st=0:d={export.THEME_PICKUP_FADE}" in graph


def test_the_theme_ends_on_a_ramp_into_the_downbeat(export):
    """The fill is live audio where near-silence used to hide the splice out."""
    args = export.theme_args("in.wav", "out.mp3")
    graph = args[args.index("-filter_complex") + 1]
    start = float(graph.split("afade=t=out:st=")[1].split(":")[0])
    assert start == pytest.approx(export.THEME.dur - export.THEME_END_FADE, abs=1e-6)
    assert export.THEME_END_FADE < 0.01, "a longer ramp is a dip you can hear"
