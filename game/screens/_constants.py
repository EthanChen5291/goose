"""
Named constants for all screen modules.
Grouped by concern; no magic numbers in screen code.

Per-second lerp speeds are derived from the original per-frame values at 60 fps:
    speed_per_sec = original_lerp_factor * 60
"""

# ── Button animation ──────────────────────────────────────────────────────────
BTN_HOVER_SCALE  = 1.18
BTN_CLICK_SHRINK = 0.72
BTN_CLICK_BOUNCE = 1.22
BTN_LERP_NORMAL  = 6.0   # 0.10 × 60  — idle hover follow
BTN_LERP_FAST    = 13.2  # 0.22 × 60  — click shrink / bounce
BTN_LERP_HOVER   = 10.8  # 0.18 × 60  — upload button, level-menu play button
CLICK_THRESHOLD  = 0.025 # scale delta that ends a click phase

# ── Beat pulse (title screen) ─────────────────────────────────────────────────
BEAT_BPM_INTRO   = 72.0   # first visit (synced to title2.wav)
BEAT_BPM_RETURN  = 125.0  # subsequent visits
BEAT_TITLE_PEAK  = 1.14   # title image scale on the beat
BEAT_BTN_PEAK    = 1.20   # play-button scale boost on the beat
BEAT_LERP_SPEED  = 10.8   # 0.18 × 60 — beat scale decay per second

# ── Video (title screen) ──────────────────────────────────────────────────────
BOP_PLAYBACK_SPEED = 1.44  # noki_bop plays 1.44× faster than wall-clock time

# ── Level select layout ───────────────────────────────────────────────────────
LS_LEFT_FRAC       = 0.35
LS_BUTTON_HEIGHT   = 56
LS_BUTTON_SPACING  = 22
LS_SCROLLBAR_W     = 6
LS_SCROLLBAR_MARGIN = 12

# ── Rank badge thresholds (best score across all difficulties) ────────────────
RANKS = [
    (930_000, "S", (255, 222, 123)),   # gold  (normalized 1,000,000 scale)
    (850_000, "A", (131, 227, 176)),   # green
    (750_000, "B", (142, 204, 255)),   # blue
    (600_000, "C", (255, 193, 142)),   # orange
    (      1, "D", (255,  96, 122)),   # red
]

# ── Tab animation ─────────────────────────────────────────────────────────────
TAB_LERP_SPEED = 8.0   # lerp units per second (same numeric value as old /60 divisor)

# ── Marquee scrolling ─────────────────────────────────────────────────────────
MARQUEE_PX_PER_SEC = 48
MARQUEE_PAUSE_SEC  = 2.0

# ── Rename push animation ─────────────────────────────────────────────────────
RENAME_PUSH_DUR = 0.22   # seconds for open / close

# ── Lick overlay timing ───────────────────────────────────────────────────────
LICK_TIMER_MIN = 10.0    # seconds between lick animations
LICK_TIMER_MAX = 25.0

# ── Eye-tracking update rate ──────────────────────────────────────────────────
EYE_TRACK_RATE = 10.0    # updates per second

# ── Level menu popup animation ────────────────────────────────────────────────
LEVEL_MENU_ANIM_DUR = 0.13   # seconds for open / close

# ── Upload spinner ────────────────────────────────────────────────────────────
SPINNER_FRAMES   = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
SPINNER_INTERVAL = 0.08   # seconds between spinner frames
