import os
from typing import Optional
from dataclasses import dataclass

# --- project root

BASE_DIR = os.path.dirname(os.path.dirname(__file__))

def asset(*parts):
    return os.path.join(BASE_DIR, "assets", *parts)

def _to_abs_path(p: Optional[str]) -> Optional[str]:
    """Convert a project-relative path like 'assets/audios/x.wav' to an absolute path."""
    if not p:
        return p
    return p if os.path.isabs(p) else os.path.join(BASE_DIR, p)

# --- audio analysis

STRONG_INTENSITY_THRESHOLD = 70 # melodies / strong beats, louder than 70%
MEDIUM_INTENSITY_THRESHOLD = 40 # louder than 40% 

# --- beatmap generator

TARGET_CPS = 3.5
MIN_CPS = 3
MAX_CPS = 4.5 # need to test cps values
CPS_TOLERANCE = 0.5

BEATS_PER_MEASURE = 4
BEATS_PER_SECTION = 16
#USABLE_SECTION_BEATS = BEATS_PER_SECTION - BEATS_PER_MEASURE 
MIN_PAUSE = 0.5 #pause between each word
IDEAL_PAUSE = 1.5
MAX_PAUSE = 2.0

MIN_WORD_GAP = 0.6  # 600ms minimum gap between words
# Intervals of 0.5 here to stick to eight notes (because 0.5 of a beat is a half beat) for playability 
# since triplets (0.33) are weird and sixteenth notes (0.25) are prob too fast

PAUSE_ROUND_THRESHOLD = 0.2
MIN_BEAT_GAP = 0.25  # gap between each beat. want to incorporate later as a guard/check
MAX_BEATMAP_DIFF = 3 # beats
SNAP_GRID = 0.5

MAX_SLOTS_PER_MEASURE = 8

MELODY_SEARCH_WINDOW = 0.2 # how far song melody notes will be looked for when aligning notes with melody
MIN_CHAR_SPACING = 0.15 # minimum 150ms between characters

BUILD_UP_WORDS = ["rush", "hope", "more", "next"]

# --- rhythm manager

GRACE = 1  # secs
LEAD_IN_MIN_SECONDS = 2.0  # minimum lead-in time (will round up to nearest measure)

# --- engine

SCROLL_SPEED = 350
HIT_X = 730
MISSED_COLOR = (255, 0, 0)
COLOR = (255, 255, 255)
UNDERLINE_LEN = 40

HIT_MARKER_Y_OFFSET = -70
HIT_MARKER_X_OFFSET = -40
HIT_MARKER_LENGTH = 200
HIT_MARKER_WIDTH = 20

BOUNCE_THRESHOLD = 0.5

# --- difficulty profiles

@dataclass(frozen=True)
class DifficultyProfile:
    target_cps: float
    min_cps: float
    max_cps: float
    cps_tolerance: float
    min_char_spacing: float
    timing_scale: float
    scroll_scale: float
    min_word_gap: float = 0.6    # min gap between word end and next word start
    quiet_skip_chance: float = 0.65  # probability of skipping a word in low-intensity sections
    max_slots_per_measure: int = 8   # hard cap on notes placed per measure
    max_words_per_measure: int = 1   # how many words to attempt per measure
    max_word_length: int = 99        # cap on word length (chars)

DIFFICULTY_PROFILES = {
    "journey": DifficultyProfile(
        target_cps=2.0, min_cps=1.5, max_cps=3.0,
        cps_tolerance=0.7, min_char_spacing=0.35,
        timing_scale=1.4, scroll_scale=0.8,
    ),
    "classic": DifficultyProfile(
        target_cps=3.0, min_cps=2.5, max_cps=4.0,
        cps_tolerance=0.5, min_char_spacing=0.25,
        timing_scale=1.0, scroll_scale=1.0,
    ),
    "master": DifficultyProfile(
        target_cps=4.5, min_cps=3.5, max_cps=6.0,
        cps_tolerance=0.4, min_char_spacing=0.16,
        timing_scale=0.85, scroll_scale=1.25,
    ),
    "demon": DifficultyProfile(
        target_cps=5.5, min_cps=4.0, max_cps=7.5,
        cps_tolerance=0.35, min_char_spacing=0.16,
        timing_scale=0.70, scroll_scale=1.25,
        min_word_gap=0.40, quiet_skip_chance=0.20,
        max_slots_per_measure=16, max_words_per_measure=8, max_word_length=4,
    ),
}
# --- highway (new play screen)

# seconds an orb is on screen before its slot, per difficulty key
APPROACH_S = {"journey": 2.0, "classic": 1.6, "master": 1.2, "demon": 0.92}
TIER_LABEL = {"journey": "EASY", "classic": "FAIR", "master": "HARD", "demon": "DEMON"}
LIVES = 3
LIFE_COOLDOWN_S = 2.0
LIFE_REGROW_STREAK = 25     # notes without a miss that grow a petal back
NAP_BARS = 4
RUSH_BARS = 8
RUSH_CHARGE_PER_CLEAN_WORD = 0.05
RUSH_THRESHOLD = 0.5
