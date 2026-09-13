/**
 * Settings and saved scores.  A port of game/settings.py and the score half of
 * game/menu_utils.py, with localStorage where the desktop build uses the user's
 * config directory.
 *
 * The key names and defaults are the desktop build's, so a chart, a layout or a
 * renderer reads the same settings object either side.
 */

export const DEFAULTS: Record<string, unknown> = {
  offset_ms: 0.0,
  speed_mult: 1.0,
  key_guide: 'off',
  noki_placement: 'line',
  stage_view: false,
  music_volume: 0.8,
  hitsound_volume: 0.9,
  duets: 'auto',
  typing_tips: true,
  calibrated: false,
  reduce_motion: false,
  no_fail: false,
}

const SETTINGS_KEY = 'noki.settings'
const SCORES_KEY = 'noki.scores'

let cache: Record<string, unknown> | null = null

export function loadSettings(): Record<string, unknown> {
  if (cache !== null) return { ...cache }
  const data: Record<string, unknown> = { ...DEFAULTS }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    if (saved && typeof saved === 'object') {
      // only keys the build knows about, so an old file can never inject junk
      for (const [k, v] of Object.entries(saved)) if (k in DEFAULTS) data[k] = v
    }
  } catch {
    /* private window, or storage disabled: the defaults stand */
  }
  cache = data
  return { ...data }
}

export function saveSettings(update: Record<string, unknown>): Record<string, unknown> {
  const data = loadSettings()
  for (const [k, v] of Object.entries(update)) if (k in DEFAULTS) data[k] = v
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
  } catch {
    /* not persisted, but this session still has it */
  }
  cache = data
  return { ...data }
}

// ── scores ─────────────────────────────────────────────────────────────────

export interface ScoreRow {
  score: number
  accuracy: number
  grade: string
  max_combo: number
  misses: number
  at: number
}

/** songId → "tier" (words) or "tier@mode" → best row, matching the desktop keys. */
export type Scores = Record<string, Record<string, ScoreRow>>

export function scoreKey(tier: string, mode: string): string {
  return mode === 'words' ? tier : `${tier}@${mode}`
}

export function loadScores(): Scores {
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY) ?? '{}') as Scores
  } catch {
    return {}
  }
}

/** Record a run if it beat the stored best.  Returns the previous best, if any. */
export function recordScore(
  songId: string,
  tier: string,
  mode: string,
  stats: Record<string, number | string>,
): ScoreRow | null {
  const scores = loadScores()
  const key = scoreKey(tier, mode)
  const prev = scores[songId]?.[key] ?? null
  const row: ScoreRow = {
    score: Number(stats.score ?? 0),
    accuracy: Number(stats.accuracy ?? 0),
    grade: String(stats.grade ?? ''),
    max_combo: Number(stats.max_combo ?? 0),
    misses: Number(stats.misses ?? 0),
    at: Date.now(),
  }
  if (prev === null || row.score > prev.score) {
    scores[songId] = { ...(scores[songId] ?? {}), [key]: row }
    try {
      localStorage.setItem(SCORES_KEY, JSON.stringify(scores))
    } catch {
      /* not persisted */
    }
  }
  return prev
}

export function bestFor(songId: string, tier: string, mode: string): ScoreRow | null {
  return loadScores()[songId]?.[scoreKey(tier, mode)] ?? null
}
