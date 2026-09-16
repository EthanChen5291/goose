/**
 * Fold hit records into the numbers the coach speaks from.
 * A port of game/coach/stats.py.
 *
 * Per key: presses, correct, slips (as expected / as pressed), median offset,
 * relative lateness (key median minus the run median).  Per finger and hand.
 * Confusion pairs classed as neighbour / row / mirror / jumped / double.
 * Streaks, pace, steadiness.  Everything is plain objects so it can be stored as
 * JSON and merged across runs.
 */
import * as KB from '../core/keyboard'
import type { HitRecord } from '../core/models'

export const HIT_JUDGMENTS = new Set(['perfect', 'good', 'ok', 'hold_perfect', 'hold_good', 'hold_ok'])
export const MISS_JUDGMENTS = new Set(['miss', 'hold_broken'])

export interface KeyStats {
  presses: number
  correct: number
  accuracy: number
  slips_expected: number
  slips_pressed: number
  misses: number
  median_offset: number
  relative_late: number
  n_timed: number
}

export interface GroupStats {
  presses: number
  accuracy: number
  relative_late: number
  n_timed: number
  keys?: string[]
}

export interface PairRow { expected: string; pressed: string; count: number; kind: string }

export interface RunStats {
  keys: Record<string, KeyStats>
  fingers: Record<number, GroupStats>
  hands: Record<number, GroupStats>
  /**
   * The order Python's dicts hold these in — first appearance while folding the
   * keys.  JavaScript iterates integer-like object keys in ascending numeric
   * order instead, which would reorder equal-priority finger tips and change
   * which three sentences the coach picks.  The order is carried explicitly so
   * both languages walk them the same way.
   */
  finger_order: number[]
  hand_order: number[]
  pairs: PairRow[]
  jumped: number
  doubled: number
  slips: number
  fast_slips: number
  presses: number
  best_streak: number
  run_median_offset: number
  sigma: number
  lpm: number
  wpm: number
  first_letter_late: number
  long_word_end_slips: number
  long_word_ends: number
  n_timed: number
}

/**
 * Python's statistics.median: the mean of the two middle values on an even count,
 * not the lower of them.  Getting this wrong shifts every relative_late slightly.
 */
export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Python's statistics.pstdev: the population standard deviation. */
export function pstdev(xs: number[]): number {
  if (xs.length <= 1) return 0
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length
  return Math.sqrt(v)
}

const isAlpha = (s: string) => s.length > 0 && /^[a-z]+$/i.test(s)

export function classifyPair(expected: string, pressed: string): string {
  const e = expected.toLowerCase()
  const p = pressed.toLowerCase()
  if (!isAlpha(p) || !isAlpha(e)) return 'other'
  if (KB.MIRROR[e] === p) return 'mirror'
  if (KB.FINGER_OF[e] === KB.FINGER_OF[p] && KB.ROW_OF[e] !== KB.ROW_OF[p]) return 'row'
  if (KB.ROW_OF[e] === KB.ROW_OF[p]
      && Math.abs((KB.COLUMN_OF[e] ?? 0) - (KB.COLUMN_OF[p] ?? 9)) === 1) return 'neighbor'
  return 'other'
}

interface Acc {
  presses: number
  correct: number
  slips_expected: number
  slips_pressed: number
  offsets: number[]
  misses: number
}

const blank = (): Acc => ({
  presses: 0, correct: 0, slips_expected: 0, slips_pressed: 0, offsets: [], misses: 0,
})

/** The separator inside a confusion-pair key; both halves are single letters. */
const SEP = '>'

/** One run's hit records → a stats object (see the module comment). */
export function fold(hits: HitRecord[]): RunStats {
  const perKey = new Map<string, Acc>()
  const key = (k: string): Acc => {
    let d = perKey.get(k)
    if (!d) { d = blank(); perKey.set(k, d) }
    return d
  }
  const pairs = new Map<string, number>()
  let jumped = 0
  let doubled = 0
  const offsetsAll: number[] = []
  let streak = 0
  let bestStreak = 0
  let fastSlips = 0
  let slipsTotal = 0
  const firstOffsets: number[] = []
  const midOffsets: number[] = []
  let longWordEndSlips = 0
  let longWordEnds = 0
  let presses = 0
  let activeSpan = 0
  let lastT: number | null = null

  for (const h of hits) {
    const j = h.judgment
    const k = (h.expected || '').toLowerCase()
    if (HIT_JUDGMENTS.has(j)) {
      presses += 1
      const d = key(k)
      d.presses += 1
      d.correct += 1
      if (j === 'perfect' || j === 'good' || j === 'ok') {
        d.offsets.push(h.offset_ms)
        offsetsAll.push(h.offset_ms)
        if (h.char_idx === 0) firstOffsets.push(h.offset_ms)
        else if (h.char_idx > 0) midOffsets.push(h.offset_ms)
      }
      streak += 1
      bestStreak = Math.max(bestStreak, streak)
      if (lastT !== null && h.t_song - lastT > 0 && h.t_song - lastT < 2) {
        activeSpan += h.t_song - lastT
      }
      lastT = h.t_song
    } else if (j === 'slip') {
      slipsTotal += 1
      streak = 0
      const d = key(k)
      d.presses += 1
      d.slips_expected += 1
      const p = (h.pressed || '').toLowerCase()
      if (isAlpha(p)) {
        key(p).slips_pressed += 1
        const pk = k + SEP + p
        pairs.set(pk, (pairs.get(pk) ?? 0) + 1)
        const w = h.word || ''
        if (h.char_idx + 1 >= 0 && h.char_idx + 1 < w.length && w[h.char_idx + 1] === p) jumped += 1
        if (h.char_idx > 0 && h.char_idx - 1 < w.length && w[h.char_idx - 1] === p) doubled += 1
      }
      if (h.gap_ms >= 0 && h.gap_ms < 150) fastSlips += 1
      if ((h.word || '').length >= 7 && h.char_idx >= (h.word || '').length - 2) longWordEndSlips += 1
    } else if (MISS_JUDGMENTS.has(j)) {
      streak = 0
      const d = key(k)
      d.presses += 1
      d.misses += 1
    }
    if ((h.word || '').length >= 7 && h.char_idx >= (h.word || '').length - 2 && j !== 'too_early') {
      longWordEnds += 1
    }
  }

  const runMedian = median(offsetsAll)
  const keys: Record<string, KeyStats> = {}
  for (const [k, d] of perKey) {
    if (!isAlpha(k)) continue
    const med = median(d.offsets)
    keys[k] = {
      presses: d.presses,
      correct: d.correct,
      accuracy: d.presses ? d.correct / d.presses : 0,
      slips_expected: d.slips_expected,
      slips_pressed: d.slips_pressed,
      misses: d.misses,
      median_offset: med,
      relative_late: d.offsets.length ? med - runMedian : 0,
      n_timed: d.offsets.length,
    }
  }

  // fingers / hands
  type Grp = { presses: number; correct: number; offsets: number[] }
  const fingerAcc = new Map<number, Grp>()
  const handAcc = new Map<number, Grp>()
  const grab = (m: Map<number, Grp>, i: number): Grp => {
    let v = m.get(i)
    if (!v) { v = { presses: 0, correct: 0, offsets: [] }; m.set(i, v) }
    return v
  }
  for (const [k, d] of Object.entries(keys)) {
    const f = KB.fingerOf(k)
    const hnd = KB.handOf(k)
    const raw = perKey.get(k)!.offsets
    for (const tgt of [grab(fingerAcc, f), grab(handAcc, hnd)]) {
      tgt.presses += d.presses
      tgt.correct += d.correct
      tgt.offsets.push(...raw)
    }
  }
  const fingers: Record<number, GroupStats> = {}
  for (const [f, v] of fingerAcc) {
    fingers[f] = {
      presses: v.presses,
      accuracy: v.presses ? v.correct / v.presses : 0,
      relative_late: v.offsets.length ? median(v.offsets) - runMedian : 0,
      n_timed: v.offsets.length,
      keys: Object.keys(keys).filter((k) => KB.fingerOf(k) === f).sort(),
    }
  }
  const hands: Record<number, GroupStats> = {}
  for (const [h, v] of handAcc) {
    hands[h] = {
      presses: v.presses,
      accuracy: v.presses ? v.correct / v.presses : 0,
      relative_late: v.offsets.length ? median(v.offsets) - runMedian : 0,
      n_timed: v.offsets.length,
    }
  }

  const pairRows = mostCommon(pairs, 12).map(([pk, c]) => {
    const i = pk.indexOf(SEP)
    const e = pk.slice(0, i)
    const p = pk.slice(i + 1)
    return { expected: e, pressed: p, count: c, kind: classifyPair(e, p) }
  })

  const sigma = pstdev(offsetsAll)
  const lpm = activeSpan > 0 ? (presses / activeSpan) * 60 : 0
  return {
    keys, fingers, hands,
    finger_order: [...fingerAcc.keys()],
    hand_order: [...handAcc.keys()],
    pairs: pairRows,
    jumped, doubled, slips: slipsTotal, fast_slips: fastSlips,
    presses, best_streak: bestStreak, run_median_offset: runMedian, sigma,
    lpm, wpm: lpm / 5,
    first_letter_late: firstOffsets.length && midOffsets.length
      ? median(firstOffsets) - median(midOffsets) : 0,
    long_word_end_slips: longWordEndSlips, long_word_ends: longWordEnds,
    n_timed: offsetsAll.length,
  }
}

/**
 * Counter.most_common: by count descending, ties broken by first-insertion order.
 * Python's Counter is insertion-ordered and its sort is stable, so a comparator
 * that fell back to the key string would reorder ties and change which mix-ups
 * the coach talks about.
 */
function mostCommon(m: Map<string, number>, n: number): [string, number][] {
  return [...m.entries()]
    .map((e, i) => [e[0], e[1], i] as [string, number, number])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2])
    .slice(0, n)
    .map(([k, c]) => [k, c] as [string, number])
}

export interface HistoryKey {
  presses: number
  correct: number
  slips_expected: number
  late_sum: number
  n_timed: number
  accuracy?: number
  relative_late?: number
}

export interface History {
  keys?: Record<string, HistoryKey>
  runs?: number
  letters?: number
  best_streak?: number
  best_wpm?: number
  cooldown?: Record<string, number>
}

/** Merge a run into a history object with recency weighting (older runs decay by 0.85). */
export function merge(history: History | null, run: RunStats, weight = 1.0): History {
  const hist: History = { ...(history ?? {}) }
  const keys: Record<string, HistoryKey> = { ...(hist.keys ?? {}) }
  for (const [k, d] of Object.entries(run.keys)) {
    const old = keys[k] ?? { presses: 0, correct: 0, slips_expected: 0, late_sum: 0, n_timed: 0 }
    keys[k] = {
      presses: old.presses * 0.85 + d.presses * weight,
      correct: old.correct * 0.85 + d.correct * weight,
      slips_expected: old.slips_expected * 0.85 + d.slips_expected * weight,
      late_sum: old.late_sum * 0.85 + d.relative_late * d.n_timed * weight,
      n_timed: old.n_timed * 0.85 + d.n_timed * weight,
    }
  }
  for (const v of Object.values(keys)) {
    v.accuracy = v.presses ? v.correct / v.presses : 0
    v.relative_late = v.n_timed ? v.late_sum / v.n_timed : 0
  }
  hist.keys = keys
  hist.runs = Math.trunc(hist.runs ?? 0) + 1
  hist.letters = Math.trunc(hist.letters ?? 0) + Math.trunc(run.presses)
  hist.best_streak = Math.max(Math.trunc(hist.best_streak ?? 0), Math.trunc(run.best_streak))
  hist.best_wpm = Math.max(Number(hist.best_wpm ?? 0), Number(run.wpm))
  return hist
}
