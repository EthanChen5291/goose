/**
 * The play-side types, mirroring game/models.py field for field.
 *
 * Only what a chart carries and what a run produces lives here; the analysis
 * dataclasses (SubBeatInfo, PaceProfile, ...) stay in Python, where the charting
 * pipeline that needs them stays.
 */

/** One note. The field names are the chart JSON's field names. */
export interface CharEvent {
  char: string
  timestamp: number
  word_text: string
  char_idx: number
  beat_position: number
  section: number
  is_rest: boolean
  hit: boolean
  from_left: boolean
  hold_duration: number
  repeat_group_id: number
  repeat_iter: number
  weight: number       // 4 beat1 · 3 beat3 · 2 backbeat · 1 eighth · 0 sixteenth; -1 unknown
  lane: number         // keyboard hand zone 0..3; -1 = derive from char
  voice: number        // duet voice: -1 none, 0 beat (left hand), 1 tune (right hand)
  line_id: number
  word_id: number
  section_kind: string // "" normal, "duet", "kiai", "rest", "anchor", "grace", "letters"
}

/** The dataclass defaults, which the chart JSON omits (see charting/_events_to_json). */
export const EVENT_DEFAULTS = {
  is_rest: false,
  hit: false,
  from_left: false,
  hold_duration: 0,
  repeat_group_id: 0,
  repeat_iter: 0,
  weight: -1,
  lane: -1,
  voice: -1,
  line_id: 0,
  word_id: 0,
  section_kind: '',
} as const

export function makeEvent(row: Partial<CharEvent>): CharEvent {
  return {
    char: '',
    timestamp: 0,
    word_text: '',
    char_idx: 0,
    beat_position: 0,
    section: 0,
    ...EVENT_DEFAULTS,
    ...row,
  }
}

export function copyEvent(e: CharEvent): CharEvent {
  return { ...e }
}

/** One row per press or timeout: the raw material of the typing coach. */
export interface HitRecord {
  t_song: number        // chart time of the note (hits/misses) or of the press (slips)
  expected: string
  pressed: string       // "" for a timeout
  judgment: string
  offset_ms: number     // press - note, signed; 0 for misses
  word: string
  char_idx: number
  gap_ms: number        // since the previous press of any key
  weight: number
  lane: number
  voice: number
}

export interface Song {
  bpm: number
  duration: number
  beat_times: number[]
  file_path: string
}

export type Mode = 'words' | 'letters' | 'duet'
export type Tier = 'journey' | 'classic' | 'master' | 'demon'

export interface Level {
  song_path: string
  difficulty: Tier
  mode: Mode
  title: string
}

/** What a chart JSON file holds. */
export interface ChartFile {
  song: { bpm: number; duration: number; beat_times: number[] }
  events: Partial<CharEvent>[]
  lead_in: number
  meta: ChartMeta
}

export interface ChartMeta {
  tier?: string
  bars?: number
  mode?: string
  letters?: string
  notes?: number
  graces?: number
  /** [t0, t1, kind, bar0, bar1] — song time */
  duets?: [number, number, string, number, number][]
  /** one vibe per bar: sustain | groove | drive | burst */
  bar_vibes?: string[]
  /** 0..1 loudness per bar */
  bar_energy?: number[]
  /** song time of each bar's downbeat */
  bar_start?: number[]
  /** [t0, t1, kind, bar0, bar1, extra] */
  phrases?: [number, number, string, number, number, Record<string, unknown>][]
  /** [t0, t1, name] — where the playfield itself changes shape: columns | onecircle */
  stages?: [number, number, string][]
  /** [t0, t1, primary, secondary, mode] */
  layers?: [number, number, string, string, string][]
  generator?: string
  build_seconds?: number
  cells?: number
  words?: number
  holds?: number
  vibes?: Record<string, number>
}
