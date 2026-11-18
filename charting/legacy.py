"""
Legacy chart path: the slot builder that shipped before Skeleton & Cells,
kept as a fallback and for A/B comparison.  Adds word ids so the Highway can
draw connectors and the word block.
"""
from __future__ import annotations

from analysis.audio_analysis import get_song_info, classify_pace, calculate_energy_shifts, detect_dual_side_sections
from game import models as M
from game.beatmap_generator import generate_beatmap
from game.rhythm import calculate_lead_in


def chart_song_legacy(level: M.Level, song_path: str) -> dict:
    song = get_song_info(song_path, expected_bpm=level.bpm, normalize=True)
    pace = classify_pace(song_path, song.bpm)
    shifts = calculate_energy_shifts(song_path, song.bpm, pace.pace_score, song.beat_times)
    dual = detect_dual_side_sections(song_path, song.bpm, pace.pace_score, song.beat_times)
    events = generate_beatmap(word_list=level.word_bank, song=song, dual_side_sections=dual,
                              difficulty=level.difficulty, energy_shifts=shifts, pace_score=pace.pace_score)
    wid = 0
    for e in events:
        if e.is_rest or not e.char:
            continue
        if e.char_idx == 0:
            wid += 1
        e.word_id = wid
        e.from_left = False
    return {"song": song, "events": events, "lead_in": calculate_lead_in(song.beat_times),
            "meta": {"generator": "legacy"}}
