/**
 * The tip library: rules over the folded stats → three short sentences and one
 * thing to try.  A port of game/coach/tips.py.
 *
 * No model anywhere.  Every sentence is twelve words or fewer, second person,
 * names the key and the finger, counts instead of milliseconds.
 *
 * Priority classes: 1 calibration · 2 mix-ups · 3 timing by finger/hand ·
 * 4 habits · 5 praise.  Cooldowns keep a tip from repeating for three songs.
 */
import * as KB from '../core/keyboard'
import type { RunStats, History } from './stats'

export const BANNED = new Set([
  'latency', 'metric', 'metrics', 'optimize', 'optimise', 'leverage', 'cadence',
  'consistency', 'variance', 'offset', 'accuracy rate', 'performance', 'data',
  'error', 'utilize',
])

export interface Tip {
  id: string
  priority: number
  text: string
  try: string
  action: string
  keys: string[]
  n: number
}

const fingerName = (f: number): string =>
  f >= 0 && f < KB.FINGER_NAMES.length ? KB.FINGER_NAMES[f] : 'finger'

function keysPhrase(keys: string[]): string {
  const ks = keys.map((k) => k.toUpperCase())
  if (ks.length === 1) return ks[0]
  if (ks.length === 2) return `${ks[0]} and ${ks[1]}`
  return `${ks.slice(0, -1).join(', ')} and ${ks[ks.length - 1]}`
}

const COUNT_WORDS: Record<number, string> = {
  1: 'once', 2: 'twice', 3: 'three times', 4: 'four times', 5: 'five times',
}
const countWord = (n: number): string => COUNT_WORDS[n] ?? `${n} times`

/**
 * All tips that fire for this run, sorted by priority then impact.
 * `action` is one of 'offset:+20' | 'drill:keys' | 'drill:words' | 'practice_loop' | ''.
 */
export function buildTips(
  stats: RunStats,
  settings: Record<string, unknown> = {},
  history: History | null = null,
): Tip[] {
  const tips: Tip[] = []
  const keys = stats.keys ?? {}
  const fingers = stats.fingers ?? {}
  const hands = stats.hands ?? {}
  const nTimed = stats.n_timed ?? 0

  // 1 · calibration (only on a calibrated device, and only when the whole run leans one way)
  const med = stats.run_median_offset ?? 0
  if (settings.calibrated && nTimed >= 24 && Math.abs(med) >= 20 && (stats.sigma ?? 99) <= 45) {
    const late = med > 0
    tips.push({
      id: late ? 'cal_late' : 'cal_early', priority: 1, n: nTimed,
      text: `Everything landed a little ${late ? 'late.' : 'early.'}`,
      try: `Apply ${late ? '+' : '-'}${Math.trunc(Math.abs(med))} ms to your timing.`,
      action: `offset:${Math.trunc(med)}`, keys: [],
    })
  }

  // 2 · mix-ups
  for (const row of stats.pairs ?? []) {
    const { expected: e, pressed: p, count: c, kind } = row
    if (kind === 'neighbor' && c >= 3) {
      tips.push({
        id: `neighbor_${e}${p}`, priority: 2, n: c, keys: [e],
        text: `You pressed ${p.toUpperCase()} instead of ${e.toUpperCase()} ${countWord(c)}. They sit next to each other.`,
        try: `Slow down one step on ${e.toUpperCase()}.`, action: 'drill:keys',
      })
    } else if (kind === 'row' && c >= 3) {
      const f = KB.fingerOf(e)
      const home = KB.HOME_KEY_OF_FINGER[f] ?? 'the home row'
      tips.push({
        id: `row_${e}${p}`, priority: 2, n: c, keys: [e, p],
        text: `${e.toUpperCase()} and ${p.toUpperCase()} share a finger. Your ${fingerName(f).split(' ')[1]} is drifting a row.`,
        try: `Bring it home to ${home.toUpperCase()} after each press.`, action: 'drill:keys',
      })
    } else if (kind === 'mirror' && c >= 2) {
      const side = KB.handOf(e) === 0 ? 'left' : 'right'
      tips.push({
        id: `mirror_${e}${p}`, priority: 2, n: c, keys: [e],
        text: `You typed ${p.toUpperCase()} for ${e.toUpperCase()}. That's the other hand.`,
        try: `${e.toUpperCase()} lives on the ${side}. Feel for the bump.`, action: 'drill:keys',
      })
    }
  }
  if ((stats.jumped ?? 0) >= 3) {
    tips.push({
      id: 'jumped', priority: 2, n: stats.jumped, keys: [],
      text: `You typed the next letter too soon ${countWord(stats.jumped)}.`,
      try: 'One letter per beat.', action: 'practice_loop',
    })
  }
  if ((stats.doubled ?? 0) >= 3) {
    tips.push({
      id: 'doubled', priority: 2, n: stats.doubled, keys: [],
      text: `You pressed the same letter twice ${countWord(stats.doubled)}.`,
      try: 'Lift after each press.', action: 'practice_loop',
    })
  }

  // 3 · timing by finger / hand
  for (const f of stats.finger_order ?? Object.keys(fingers).map(Number)) {
    const d = fingers[f]
    if (!d) continue
    const dKeys = d.keys ?? []
    if (d.n_timed >= 8 && d.relative_late >= 25) {
      const filtered = dKeys.filter((k) => (keys[k]?.n_timed ?? 0) >= 3).slice(0, 3)
      const ks = filtered.length ? filtered : dKeys.slice(0, 2)
      const home = KB.HOME_KEY_OF_FINGER[f] ?? ''
      tips.push({
        id: `late_finger_${f}`, priority: 3, n: d.n_timed, keys: ks,
        text: `Your ${fingerName(f)} is late on ${keysPhrase(ks)}.`,
        try: home && /^[a-z]$/i.test(home)
          ? `Rest your ${fingerName(f).split(' ')[1]} on ${home.toUpperCase()} between words.`
          : `Keep your ${fingerName(f)} closer to the keys.`,
        action: 'drill:keys',
      })
    } else if (d.n_timed >= 8 && d.relative_late <= -25) {
      const ks = dKeys.slice(0, 2)
      tips.push({
        id: `early_finger_${f}`, priority: 3, n: d.n_timed, keys: ks,
        text: `Your ${fingerName(f)} jumps in early on ${keysPhrase(ks)}.`,
        try: 'Wait for the ring to close.', action: 'practice_loop',
      })
    }
  }
  if (hands[0] && hands[1] && hands[0].n_timed >= 12 && hands[1].n_timed >= 12) {
    const diff = hands[0].relative_late - hands[1].relative_late
    if (Math.abs(diff) >= 20) {
      const slow = diff > 0 ? 'left' : 'right'
      const fast = diff > 0 ? 'right' : 'left'
      tips.push({
        id: `hand_${slow}`, priority: 3, n: 24, keys: [],
        text: `Your ${slow} hand runs behind your ${fast}.`,
        try: `Practice this: ${slow}-hand keys.`, action: 'drill:keys',
      })
    }
  }

  // 4 · habits
  const slips = stats.slips ?? 0
  if (slips >= 5 && (stats.fast_slips ?? 0) / Math.max(1, slips) >= 0.6) {
    tips.push({
      id: 'rushed', priority: 4, n: slips, keys: [],
      text: 'You rushed the fast parts.', try: 'Wait for the ring to close.', action: 'practice_loop',
    })
  }
  if (nTimed >= 30 && (stats.first_letter_late ?? 0) >= 30) {
    tips.push({
      id: 'first_late', priority: 4, n: nTimed, keys: [],
      text: 'You start each word a bit late.',
      try: 'Look one word ahead. The stack shows it.', action: '',
    })
  }
  if ((stats.long_word_ends ?? 0) >= 6
      && (stats.long_word_end_slips ?? 0) / Math.max(1, stats.long_word_ends) >= 0.3) {
    tips.push({
      id: 'long_words', priority: 4, n: stats.long_word_ends, keys: [],
      text: 'Long words fall apart near the end.',
      try: 'Practice this: six-letter words, Easy.', action: 'drill:words',
    })
  }
  const weak = Object.keys(keys)
    .filter((k) => keys[k].presses >= 6 && keys[k].accuracy < 0.85)
    .sort((a, b) => keys[a].accuracy - keys[b].accuracy)
  const pinkySlips = Object.keys(keys)
    .filter((k) => KB.fingerOf(k) === 0 || KB.fingerOf(k) === 9)
    .reduce((a, k) => a + keys[k].slips_expected, 0)
  if (slips >= 5 && pinkySlips / Math.max(1, slips) >= 0.4) {
    tips.push({
      id: 'pinkies', priority: 4, n: pinkySlips, keys: ['q', 'a', 'z', 'p'],
      text: 'Most slips were on your pinkies.', try: 'Practice this: Q A Z and P.', action: 'drill:keys',
    })
  }
  if (weak.length && !tips.some((t) => t.priority <= 3)) {
    const k = weak[0]
    tips.push({
      id: `weak_${k}`, priority: 4, n: keys[k].presses, keys: weak.slice(0, 3),
      text: `${k.toUpperCase()} is your slowest key.`,
      try: `Practice this: ${keysPhrase(weak.slice(0, 3))}.`, action: 'drill:keys',
    })
  }

  // 5 · praise (specific and true)
  const best = stats.best_streak ?? 0
  const histBest = Math.trunc((history ?? {}).best_streak ?? 0)
  if (best >= 8 && best >= histBest) {
    tips.push({
      id: 'streak', priority: 5, n: best, keys: [],
      text: `${best} letters in a row with no slips. That's your best.`, try: '', action: '',
    })
  }
  for (const h of stats.hand_order ?? Object.keys(hands).map(Number)) {
    const d = hands[h]
    if (!d) continue
    if (d.n_timed >= 15 && Math.abs(d.relative_late) < 10) {
      tips.push({
        id: `steady_${h}`, priority: 5, n: d.n_timed, keys: [],
        text: `Your ${h === 0 ? 'left' : 'right'} hand was steady the whole song.`,
        try: '', action: '',
      })
      break
    }
  }
  if (!tips.length) {
    tips.push({
      id: 'nothing', priority: 5, n: 0, keys: [],
      text: 'Nothing to fix today. Play something harder.', try: 'Next song up one tier.', action: '',
    })
  }
  // stable sort, as Python's list.sort is: equal (priority, -n) keeps build order
  return tips
    .map((t, i) => [t, i] as [Tip, number])
    .sort((a, b) => (a[0].priority - b[0].priority) || (b[0].n - a[0].n) || (a[1] - b[1]))
    .map(([t]) => t)
}

/** Three sentences and the instruction to try, honouring cooldowns ({tipId: songsLeft}). */
export function pick(
  tips: Tip[],
  cooldown: Record<string, number> = {},
  maxSentences = 3,
): [string[], Tip | null] {
  let chosen: Tip[] = []
  const usedKeys = new Set<string>()
  for (const t of tips) {
    if ((cooldown[t.id] ?? 0) > 0) continue
    if (t.keys.some((k) => usedKeys.has(k)) && t.priority <= 3) continue
    chosen.push(t)
    for (const k of t.keys) usedKeys.add(k)
    if (chosen.length >= maxSentences) break
  }
  // guarantee one praise line if the first three are all fixes
  if (chosen.length && chosen.every((t) => t.priority <= 4)) {
    const praise = tips.find((t) => t.priority === 5 && !chosen.includes(t))
    if (praise) chosen = chosen.slice(0, maxSentences - 1).concat([praise])
  }
  const sentences = chosen.map((t) => t.text)
  const instruction = chosen.find((t) => t.try) ?? null
  return [sentences, instruction]
}

/** Style-guide check: 12 words or fewer, no banned jargon.  Returns the violations. */
export function lint(sentence: string): string[] {
  const problems: string[] = []
  for (const part of sentence.replace(/!/g, '.').split('.')) {
    if (!part.trim()) continue
    if (part.trim().split(/\s+/).length > 12) {
      problems.push('more than twelve words')
      break
    }
  }
  const low = sentence.toLowerCase()
  for (const b of BANNED) if (low.includes(b)) problems.push(`banned word: ${b}`)
  return problems
}
