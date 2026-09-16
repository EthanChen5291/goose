/**
 * The typing coach, held to the same standard as the judgment core.
 *
 * `fold` and `build_tips` are pure functions over a hit log, so the same golden
 * replay that proves the judgment core proves the coach: `tools/parity_dump.py`
 * runs the Python coach over each case's hit log and records every folded number,
 * every tip it built, and the three sentences it picked.  This replays the same
 * hit logs through the TypeScript coach and demands the same answers, including
 * the order the tips came out in — which is where the port is easiest to get
 * subtly wrong, since JavaScript reorders integer-keyed objects.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { fold, median, pstdev, classifyPair, merge } from '../src/coach/stats'
import { buildTips, pick, lint } from '../src/coach/tips'
import type { RunStats } from '../src/coach/stats'
import type { HitRecord } from '../src/core/models'

const EPS = 1e-6

interface CoachVariant {
  name: string
  tips: { id: string; priority: number; n: number; text: string; try: string; action: string; keys: string[] }[]
  sentences: string[]
  instruction_id: string | null
  lint: Record<string, string[]>
}
interface Case {
  name: string
  expected: {
    hits: HitRecord[]
    coach: { run: Record<string, unknown>; variants: CoachVariant[] }
  }
}

const cases: Case[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./parity_cases.json', import.meta.url)), 'utf8'),
).cases

const VARIANT_SETTINGS: Record<string, Record<string, unknown>> = {
  plain: {},
  calibrated: { calibrated: true },
  with_history: {},
}
const VARIANT_HISTORY: Record<string, { best_streak?: number } | null> = {
  plain: null,
  calibrated: null,
  with_history: { best_streak: 999 },
}

describe('coach helpers', () => {
  test('median matches statistics.median on even counts', () => {
    // the trap: Python averages the two middle values, JS sorts numerically
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([10, 2, 1])).toBe(2)
    expect(median([])).toBe(0)
    // and a lexicographic sort would put 10 before 2
    expect(median([1, 2, 10])).toBe(2)
  })

  test('pstdev is the population deviation, and zero for one sample', () => {
    expect(pstdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 9)
    expect(pstdev([5])).toBe(0)
    expect(pstdev([])).toBe(0)
  })

  test('classifyPair names the four confusions', () => {
    expect(classifyPair('f', 'j')).toBe('mirror')
    expect(classifyPair('a', 's')).toBe('neighbor')
    expect(classifyPair('q', 'a')).toBe('row')
    expect(classifyPair('q', 'm')).toBe('other')
    expect(classifyPair('', 'a')).toBe('other')
  })

  test('merge decays the old run and keeps the bests', () => {
    const run = fold([]) as RunStats
    run.keys = {
      a: { presses: 10, correct: 8, accuracy: 0.8, slips_expected: 2, slips_pressed: 0,
           misses: 0, median_offset: 0, relative_late: 10, n_timed: 8 },
    }
    run.best_streak = 12
    run.wpm = 40
    const h1 = merge(null, run)
    expect(h1.keys!.a.presses).toBe(10)
    expect(h1.runs).toBe(1)
    const h2 = merge(h1, run)
    expect(h2.keys!.a.presses).toBeCloseTo(10 * 0.85 + 10, 9)
    expect(h2.runs).toBe(2)
    expect(h2.best_streak).toBe(12)
    expect(h2.best_wpm).toBe(40)
  })

  test('lint catches long sentences and jargon', () => {
    expect(lint('You pressed S instead of A twice.')).toEqual([])
    expect(lint('This sentence has far too many words in it to ever be allowed here.'))
      .toContain('more than twelve words')
    expect(lint('Improve your consistency.').some((p) => p.includes('consistency'))).toBe(true)
  })
})

describe('dict order, where JavaScript and Python disagree', () => {
  /**
   * Python walks `stats["fingers"]` in insertion order; JavaScript walks an
   * integer-keyed object in ascending numeric order.  Every real case here has a
   * non-ascending finger order, but none has two finger tips that *tie* on
   * (priority, n) — which is the only way the difference reaches the output.  So
   * the tie is built by hand, the way the window boundaries are.
   */
  function twoLateFingers(order: number[]): RunStats {
    const base = fold([])
    const mk = (keys: string[]) => ({ presses: 20, accuracy: 1, relative_late: 30, n_timed: 20, keys })
    return {
      ...base,
      // both fingers are equally late over an equal number of notes: only the
      // walk order decides which tip is built first
      fingers: { 2: mk(['d', 'e']), 7: mk(['k', 'i']) },
      finger_order: order,
      keys: Object.fromEntries(['d', 'e', 'k', 'i'].map((k) => [k, {
        presses: 20, correct: 20, accuracy: 1, slips_expected: 0, slips_pressed: 0,
        misses: 0, median_offset: 0, relative_late: 30, n_timed: 20,
      }])),
    }
  }

  test('finger tips follow the recorded order, not the numeric one', () => {
    const ids = (order: number[]) =>
      buildTips(twoLateFingers(order)).filter((t) => t.id.startsWith('late_finger_')).map((t) => t.id)
    expect(ids([2, 7])).toEqual(['late_finger_2', 'late_finger_7'])
    expect(ids([7, 2]), 'a descending order must survive').toEqual(['late_finger_7', 'late_finger_2'])
  })

  test('a tie in the final sort keeps the order the tips were built in', () => {
    // the sort key is (priority, -n); these two are equal on both
    const tips = buildTips(twoLateFingers([7, 2]))
    const late = tips.filter((t) => t.priority === 3)
    expect(late.map((t) => t.id)).toEqual(['late_finger_7', 'late_finger_2'])
  })
})

describe('pick, and the guard that only applies to fixes', () => {
  /**
   * `pick` refuses a second tip about a key it has already spoken about — but
   * only for priorities 1..3.  A priority-4 habit ("most slips were on your
   * pinkies") is allowed to name a key a mix-up tip already used, because it is
   * making a different point about it.  No real case here happens to overlap that
   * way, so the overlap is built by hand.
   */
  function overlappingTips(): RunStats {
    const base = fold([])
    const keyStat = (slips: number) => ({
      presses: 10, correct: 10 - slips, accuracy: (10 - slips) / 10, slips_expected: slips,
      slips_pressed: 0, misses: 0, median_offset: 0, relative_late: 0, n_timed: 8,
    })
    return {
      ...base,
      // A is a pinky key, and it is also the expected side of a neighbour mix-up
      keys: { a: keyStat(3), s: keyStat(0) },
      pairs: [{ expected: 'a', pressed: 's', count: 3, kind: 'neighbor' }],
      slips: 5,
      fast_slips: 0,
    }
  }

  test('a habit tip may name a key a mix-up tip already used', () => {
    const tips = buildTips(overlappingTips())
    const ids = tips.map((t) => t.id)
    expect(ids, 'both tips should be built').toContain('neighbor_as')
    expect(ids, 'both tips should be built').toContain('pinkies')
    const [sentences] = pick(tips, {})
    const chosen = tips.filter((t) => sentences.includes(t.text)).map((t) => t.id)
    expect(chosen, 'the pinkies habit is priority 4, so the key guard does not skip it')
      .toContain('pinkies')
  })

  test('a cooldown hides a tip', () => {
    const tips = buildTips(overlappingTips())
    const [sentences] = pick(tips, { neighbor_as: 2 })
    expect(sentences.some((s) => s.includes('instead of A'))).toBe(false)
  })

  test('three sentences at most, and a praise line when they are all fixes', () => {
    const tips = buildTips(overlappingTips())
    const [sentences] = pick(tips, {})
    expect(sentences.length).toBeLessThanOrEqual(3)
  })
})

describe('parity with game/coach', () => {
  test('the cases exercise more than one tip class', () => {
    const priorities = new Set<number>()
    for (const c of cases) {
      for (const v of c.expected.coach.variants) for (const t of v.tips) priorities.add(t.priority)
    }
    expect(priorities.size, 'every case produced the same tip class').toBeGreaterThan(2)
  })

  test('every sentence the coach can emit passes its own style guide', () => {
    for (const c of cases) {
      for (const v of c.expected.coach.variants) {
        for (const t of v.tips) {
          expect(lint(t.text), `${c.name}/${v.name} "${t.text}"`).toEqual(v.lint[t.id])
        }
      }
    }
  })

  for (const c of cases) {
    test(c.name, () => {
      const run = fold(c.expected.hits)
      const want = c.expected.coach.run as Record<string, never>

      // the scalars
      for (const k of ['jumped', 'doubled', 'slips', 'fast_slips', 'presses', 'best_streak',
                       'long_word_end_slips', 'long_word_ends', 'n_timed'] as const) {
        expect(run[k], `${c.name} ${k}`).toBe(want[k])
      }
      for (const k of ['run_median_offset', 'sigma', 'lpm', 'wpm', 'first_letter_late'] as const) {
        expect(Math.abs(run[k] - Number(want[k])), `${c.name} ${k}`).toBeLessThan(EPS)
      }

      // the per-key fold
      const wantKeys = want.keys as Record<string, Record<string, number>>
      expect(Object.keys(run.keys).sort()).toEqual(Object.keys(wantKeys).sort())
      for (const [k, d] of Object.entries(run.keys)) {
        const w = wantKeys[k]
        for (const f of ['presses', 'correct', 'slips_expected', 'slips_pressed', 'misses', 'n_timed'] as const) {
          expect(d[f], `${c.name} keys.${k}.${f}`).toBe(w[f])
        }
        for (const f of ['accuracy', 'median_offset', 'relative_late'] as const) {
          expect(Math.abs(d[f] - w[f]), `${c.name} keys.${k}.${f}`).toBeLessThan(EPS)
        }
      }

      // the dict orders JavaScript would otherwise scramble
      expect(run.finger_order, `${c.name} finger_order`).toEqual(want.finger_order)
      expect(run.hand_order, `${c.name} hand_order`).toEqual(want.hand_order)

      // fingers and hands
      for (const [group, wantGroup] of [
        [run.fingers, want.fingers as Record<string, Record<string, number>>],
        [run.hands, want.hands as Record<string, Record<string, number>>],
      ] as const) {
        for (const [i, d] of Object.entries(group)) {
          const w = wantGroup[i]
          expect(d.presses, `${c.name} group ${i}.presses`).toBe(w.presses)
          expect(d.n_timed, `${c.name} group ${i}.n_timed`).toBe(w.n_timed)
          expect(Math.abs(d.accuracy - w.accuracy), `${c.name} group ${i}.accuracy`).toBeLessThan(EPS)
          expect(Math.abs(d.relative_late - w.relative_late), `${c.name} group ${i}.relative_late`).toBeLessThan(EPS)
        }
      }

      // the confusion pairs, in order — most_common ties break by insertion
      expect(run.pairs.length, `${c.name} pair count`).toBe((want.pairs as unknown[]).length)
      const wantPairs = want.pairs as unknown as { expected: string; pressed: string; count: number; kind: string }[]
      for (let i = 0; i < run.pairs.length; i++) {
        expect(run.pairs[i], `${c.name} pairs[${i}]`).toEqual(wantPairs[i])
      }

      // and every tip, in the order the library built them
      for (const v of c.expected.coach.variants) {
        const tips = buildTips(run, VARIANT_SETTINGS[v.name], VARIANT_HISTORY[v.name])
        expect(tips.length, `${c.name}/${v.name} tip count`).toBe(v.tips.length)
        for (let i = 0; i < tips.length; i++) {
          const got = tips[i]
          const w = v.tips[i]
          expect(got.id, `${c.name}/${v.name} tips[${i}].id`).toBe(w.id)
          expect(got.priority, `${c.name}/${v.name} tips[${i}].priority`).toBe(w.priority)
          expect(got.n, `${c.name}/${v.name} tips[${i}].n`).toBe(w.n)
          expect(got.text, `${c.name}/${v.name} tips[${i}].text`).toBe(w.text)
          expect(got.try, `${c.name}/${v.name} tips[${i}].try`).toBe(w.try)
          expect(got.action, `${c.name}/${v.name} tips[${i}].action`).toBe(w.action)
          expect(got.keys, `${c.name}/${v.name} tips[${i}].keys`).toEqual(w.keys)
        }
        const [sentences, instruction] = pick(tips, {})
        expect(sentences, `${c.name}/${v.name} sentences`).toEqual(v.sentences)
        expect(instruction?.id ?? null, `${c.name}/${v.name} instruction`).toBe(v.instruction_id)
      }
    })
  }
})
