/** The play-side half of game/constants.py.  The charting constants stay in Python. */

// ── rhythm manager ─────────────────────────────────────────────────────────
export const BEATS_PER_MEASURE = 4
export const BEATS_PER_SECTION = 16
export const GRACE = 1
/** minimum lead-in (rounded up to the nearest measure) */
export const LEAD_IN_MIN_SECONDS = 2.0

// ── difficulty profiles ────────────────────────────────────────────────────
export interface DifficultyProfile {
  target_cps: number
  min_cps: number
  max_cps: number
  cps_tolerance: number
  min_char_spacing: number
  timing_scale: number
  scroll_scale: number
  min_word_gap: number
  quiet_skip_chance: number
  max_slots_per_measure: number
  max_words_per_measure: number
  max_word_length: number
}

const profile = (p: Partial<DifficultyProfile> & Pick<DifficultyProfile,
  'target_cps' | 'min_cps' | 'max_cps' | 'cps_tolerance' | 'min_char_spacing' | 'timing_scale' | 'scroll_scale'>
): DifficultyProfile => ({
  min_word_gap: 0.6, quiet_skip_chance: 0.65, max_slots_per_measure: 8,
  max_words_per_measure: 1, max_word_length: 99, ...p,
})

export const DIFFICULTY_PROFILES: Record<string, DifficultyProfile> = {
  journey: profile({ target_cps: 2.0, min_cps: 1.5, max_cps: 3.0, cps_tolerance: 0.7,
    min_char_spacing: 0.35, timing_scale: 1.4, scroll_scale: 0.8 }),
  classic: profile({ target_cps: 3.0, min_cps: 2.5, max_cps: 4.0, cps_tolerance: 0.5,
    min_char_spacing: 0.25, timing_scale: 1.0, scroll_scale: 1.0 }),
  master: profile({ target_cps: 4.5, min_cps: 3.5, max_cps: 6.0, cps_tolerance: 0.4,
    min_char_spacing: 0.16, timing_scale: 0.85, scroll_scale: 1.25 }),
  demon: profile({ target_cps: 5.5, min_cps: 4.0, max_cps: 7.5, cps_tolerance: 0.35,
    min_char_spacing: 0.16, timing_scale: 0.7, scroll_scale: 1.25,
    min_word_gap: 0.4, quiet_skip_chance: 0.2, max_slots_per_measure: 16,
    max_words_per_measure: 8, max_word_length: 4 }),
}

// ── highway ────────────────────────────────────────────────────────────────
/** seconds an orb is on screen before its slot, per difficulty key */
export const APPROACH_S: Record<string, number> = {
  journey: 2.0, classic: 1.6, master: 1.2, demon: 0.92,
}
export const TIER_LABEL: Record<string, string> = {
  journey: 'EASY', classic: 'FAIR', master: 'HARD', demon: 'DEMON',
}
export const LIVES = 3
export const LIFE_COOLDOWN_S = 2.0
/** notes without a miss that grow a petal back */
export const LIFE_REGROW_STREAK = 25
export const NAP_BARS = 4
export const RUSH_BARS = 8
export const RUSH_CHARGE_PER_CLEAN_WORD = 0.05
export const RUSH_THRESHOLD = 0.5
