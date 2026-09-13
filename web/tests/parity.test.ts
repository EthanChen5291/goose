/**
 * Golden-replay parity against the Python core.
 *
 * `tools/parity_dump.py` drives `game/rhythm.py` through a deterministic tape of
 * frame ticks, presses and releases on eight real shipped charts — every tier,
 * both modes, a different song each — and records every judgment it returned and
 * every statistic it ended on.  This replays the same tape through the
 * TypeScript core and demands the same answers.
 *
 * Re-running the ported unit tests only proves the tests were ported.  This is
 * what proves the port.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RhythmManager } from '../src/core/rhythm'
import { makeEvent } from '../src/core/models'
import type { CharEvent } from '../src/core/models'

const FRAME = 1 / 60
const EPS = 1e-6

interface Action { kind: 'frame' | 'press' | 'release'; t: number; key?: string }
interface Case {
  name: string
  bpm: number
  lead_in: number
  timing_scale: number
  events: Partial<CharEvent>[]
  inputs: Action[]
  frames: number
  expected: {
    results: Record<string, unknown>[]
    hits: Record<string, unknown>[]
    stats: Record<string, number | string>
  }
}

const cases: Case[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./parity_cases.json', import.meta.url)), 'utf8'),
).cases

/** Inputs and frame ticks in the order PlaySession.update sees them: at an equal
 *  timestamp the frame tick (which runs rhythm.update) sorts before the keys. */
function weave(inputs: Action[], frames: number): Action[] {
  const actions: Action[] = [...inputs]
  for (let i = 0; i < frames; i++) actions.push({ kind: 'frame', t: round6(i * FRAME) })
  return actions.sort((a, b) => (a.t - b.t) || (rank(a) - rank(b)))
}
const rank = (a: Action) => (a.kind === 'frame' ? 0 : 1)
const round6 = (x: number) => Number(x.toFixed(6))

describe('parity with game/rhythm.py', () => {
  test('the tape covers holds and anchors, not just plain notes', () => {
    const kinds = new Set<string>()
    for (const c of cases) {
      for (const h of c.expected.hits) kinds.add(String(h.judgment))
    }
    for (const want of ['perfect', 'good', 'ok', 'miss', 'slip', 'too_early',
                        'hold_started', 'hold_perfect', 'hold_broken']) {
      expect(kinds, `tape never produced "${want}"`).toContain(want)
    }
  })

  for (const c of cases) {
    test(c.name, () => {
      let t = 0
      const rm = new RhythmManager(c.events.map(makeEvent), {
        bpm: c.bpm, leadIn: c.lead_in, timingScale: c.timing_scale, clock: () => t,
      })

      const results: Record<string, unknown>[] = []
      for (const a of weave(c.inputs, c.frames)) {
        t = a.t
        if (a.kind === 'frame') {
          const missed = rm.update()
          if (missed.length) {
            results.push({ at: a.t, kind: 'missed', chars: missed.map((e) => e.char) })
          }
          if (rm.anchorResults.length) {
            results.push({ at: a.t, kind: 'anchors',
                           judgments: rm.anchorResults.map((r) => r.judgment) })
            rm.anchorResults = []
          }
        } else if (a.kind === 'press') {
          const r = rm.checkInput(a.key!)
          results.push({ at: a.t, kind: 'press', judgment: r.judgment, hit: r.hit,
                         combo: r.combo, word_complete: r.is_word_complete,
                         offset_ms: r.offset * 1000 })
        } else {
          const r = rm.onKeyRelease(a.key!)
          results.push({ at: a.t, kind: 'release', judgment: r?.judgment ?? '',
                         hit: Boolean(r?.hit) })
        }
      }

      // every judgment, in order
      expect(results.length, 'result count').toBe(c.expected.results.length)
      for (let i = 0; i < results.length; i++) {
        const got = results[i]
        const want = c.expected.results[i]
        const where = `${c.name} result[${i}] @${want.at}`
        expect(got.kind, where).toBe(want.kind)
        if (want.kind === 'missed') {
          expect(got.chars, where).toEqual(want.chars)
        } else if (want.kind === 'anchors') {
          expect(got.judgments, where).toEqual(want.judgments)
        } else {
          expect(got.judgment, `${where} judgment`).toBe(want.judgment)
          expect(got.hit, `${where} hit`).toBe(want.hit)
          if (want.kind === 'press') {
            expect(got.combo, `${where} combo`).toBe(want.combo)
            expect(got.word_complete, `${where} word_complete`).toBe(want.word_complete)
            expect(Math.abs(Number(got.offset_ms) - Number(want.offset_ms)),
                   `${where} offset_ms`).toBeLessThan(EPS)
          }
        }
      }

      // the hit log, row for row
      expect(rm.hits.length, 'hit count').toBe(c.expected.hits.length)
      for (let i = 0; i < rm.hits.length; i++) {
        const got = rm.hits[i]
        const want = c.expected.hits[i]
        const where = `${c.name} hit[${i}]`
        expect(got.judgment, `${where} judgment`).toBe(want.judgment)
        expect(got.expected, `${where} expected`).toBe(want.expected)
        expect(got.pressed, `${where} pressed`).toBe(want.pressed)
        expect(got.word, `${where} word`).toBe(want.word)
        expect(got.char_idx, `${where} char_idx`).toBe(want.char_idx)
        expect(got.lane, `${where} lane`).toBe(want.lane)
        expect(got.weight, `${where} weight`).toBe(want.weight)
        expect(got.voice, `${where} voice`).toBe(want.voice)
        expect(Math.abs(got.t_song - Number(want.t_song)), `${where} t_song`).toBeLessThan(EPS)
        expect(Math.abs(got.offset_ms - Number(want.offset_ms)), `${where} offset_ms`).toBeLessThan(EPS)
        expect(Math.abs(got.gap_ms - Number(want.gap_ms)), `${where} gap_ms`).toBeLessThan(EPS)
      }

      // and the scoreboard
      const stats = rm.getStats()
      for (const [k, want] of Object.entries(c.expected.stats)) {
        const got = stats[k]
        if (typeof want === 'number' && !Number.isInteger(want)) {
          expect(Math.abs(Number(got) - want), `${c.name} stats.${k}`).toBeLessThan(1e-6)
        } else {
          expect(got, `${c.name} stats.${k}`).toBe(want)
        }
      }
    })
  }
})
