from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional

# --- audio analysis

class SubBeatIntensity(Enum):
    """Normalized beat-level intensity relative to each beat's respective measure intensity"""
    WEAK = auto()
    MEDIUM = auto()
    STRONG = auto()

@dataclass(frozen=True)
class SubBeatInfo():
    """Beat-level timestamps, raw intensities, and normalized intensity levels"""
    time: float
    raw_intensity: float
    level: SubBeatIntensity

@dataclass(frozen=True)
class IntensityProfile:
    """Beat-level and section-level intensity curves (higher = more activity)"""
    beat_intensities: list[float]
    section_intensities: list[float]


@dataclass(frozen=True)
class DropEvent:
    """Represents a detected drop/climax moment in the song"""
    timestamp: float  # when the drop occurs (beat 1 of climax section)
    intensity: float  # raw intensity of the drop section
    intensity_ratio: float  # how much louder than average
    section_idx: int  # which section this drop is in


@dataclass(frozen=True)
class PaceProfile:
    """Classification of song pace/energy for scroll speed adjustment"""
    bpm: float
    onset_density: float  # onsets per second
    avg_intensity: float
    intensity_variance: float
    pace_score: float  # 0.0 to 1.0 (slow to fast)
    scroll_multiplier: float  # Multiplier for base scroll speed


@dataclass(frozen=True)
class SectionEnergyShift:
    """Represents a section with modified scroll speed due to energy change"""
    section_idx: int
    start_time: float  # when this section starts
    end_time: float  # when this section ends
    energy_delta: float  # change from previous section (positive = more intense)
    scroll_modifier: float  # multiplier to apply on top of base scroll speed


@dataclass(frozen=True)
class DualSideSection:
    """Represents a section where notes come from both sides (plane mode)"""
    start_time: float
    end_time: float
    intensity_ratio: float  # how intense this section is relative to average


@dataclass
class Shockwave:
    """A single expanding shockwave circle"""
    center_x: float
    center_y: float
    radius: float
    max_radius: float
    alpha: int  # 0 - 255 transparency
    thickness: int
    speed: float  # pixels per second expansion rate
    color: tuple = (180, 180, 180)  # RGB color for the ring

    def update(self, dt: float) -> bool:
        """Update shockwave, returns False if should be removed"""
        self.radius += self.speed * dt
        # fade out as it expands
        progress = self.radius / self.max_radius
        self.alpha = int(255 * (1 - progress) * 0.6)  # max 60% opacity
        self.thickness = max(1, int(4 * (1 - progress)))
        return self.radius < self.max_radius

# --- beatmap generator

@dataclass
class RhythmSlot:
    """A potential character placement slot based on audio analysis"""
    time: float
    intensity: float
    priority: int  # 1 = weak, 2 = medium, 3 = strong
    is_filled: bool
    beat_position: float

class RestType(Enum):
     PAUSE = auto()
     FILL = auto()

@dataclass
class Word:
    """Represents a word with rhythm timing info"""
    text: str
    rest_type: Optional[RestType]
    ideal_beats: Optional[float]
    snapped_beats: float
    snapped_cps: float

@dataclass
class CharEvent:
    char: str
    timestamp: float
    word_text: str
    char_idx: int
    beat_position: float
    section: int
    is_rest: bool = False
    hit: bool = False
    from_left: bool = False  # legacy dual-side flag (unused by the Highway)
    hold_duration: float = 0.0  # > 0 = hold note; player must hold for this many seconds
    repeat_group_id: int = 0    # 0 = not part of a repeat group; shared ID across all iterations
    repeat_iter: int = 0        # 1-based iteration index within the group (0 = not a repeat)
    # --- Highway / charting fields
    weight: int = -1            # metric weight 4 beat1, 3 beat3, 2 backbeat, 1 eighth, 0 sixteenth; -1 unknown
    lane: int = -1              # keyboard hand zone 0..3; -1 = derive from char
    voice: int = -1             # duet voice: -1 none, 0 beat (left hand), 1 tune (right hand)
    line_id: int = 0            # duet line / word instance id
    word_id: int = 0            # unique id per word instance in the chart
    section_kind: str = ""      # "" normal, "duet", "kiai", "rest"

    def copy(self) -> "CharEvent":
        return CharEvent(**self.__dict__)


@dataclass
class HitRecord:
    """One row per press or timeout, the raw material of the typing coach."""
    t_song: float           # chart time of the note (hits/misses) or press (slips)
    expected: str
    pressed: str            # "" for a timeout
    judgment: str           # perfect | good | ok | miss | slip | too_early | hold_broken | hold_perfect...
    offset_ms: float        # press - note, signed; 0 for misses
    word: str = ""
    char_idx: int = -1
    gap_ms: float = -1.0    # since the previous press of any key
    weight: int = -1
    lane: int = -1
    voice: int = -1

# --- engine

class Song:
    def __init__(self, bpm: float, duration: float, file_path: str, beat_times: Optional[list[float]] = None):
        self.bpm = bpm
        self.duration = duration
        self.file_path = file_path
        self.beat_times = beat_times or []

class Level:
    def __init__(self, word_bank: list[str], song_path: str, bpm: Optional[int] = None, difficulty: str = "classic",
                 mode: str = "words"):
        self.word_bank = word_bank
        self.song_path = song_path
        self.bpm = bpm
        self.difficulty = difficulty
        self.mode = mode   # words | letters | duet
