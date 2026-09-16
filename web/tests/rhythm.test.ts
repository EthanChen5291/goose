/** Judgment core: windows, slips, too-early, holds, hit log, score.
 *  A port of tests/test_rhythm.py, assertion for assertion. */
import { describe, expect, test } from 'vitest'
import { RhythmManager, roundHalfEven } from '../src/core/rhythm'
import { makeEvent } from '../src/core/models'
import { laneOf } from '../src/core/keyboard'
import type { CharEvent } from '../src/core/models'

function chart(letters = 'planet', start = 1.0, gap = 0.5): CharEvent[] {
  const evs: CharEvent[] = []
  for (let i = 0; i < letters.length; i++) {
    evs.push(makeEvent({
      char: letters[i], timestamp: start + i * gap, word_text: letters, char_idx: i,
      beat_position: i, section: 0, word_id: 1,
    }))
  }
  evs.push(makeEvent({
    char: '', timestamp: start + letters.length * gap, word_text: '', char_idx: -1,
    beat_position: 0, section: 0, is_rest: true,
  }))
  return evs
}

class Clock {
  t: number
  constructor(t = 0) { this.t = t }
  get fn() { return () => this.t }
}

describe('RhythmManager', () => {
  test('windows are fixed ms times scale', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, timingScale: 1.4, clock: c.fn })
    expect(Math.abs(rm.timingWindows.perfect - 0.105)).toBeLessThan(1e-9)
    expect(Math.abs(rm.timingWindows.ok - 0.315)).toBeLessThan(1e-9)
  })

  test('perfect / good / ok and the signed offset', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    c.t = 1.02
    let r = rm.checkInput('p')
    expect(r.hit).toBe(true)
    expect(r.judgment).toBe('perfect')
    expect(Math.abs(r.offset - 0.02)).toBeLessThan(1e-9)
    c.t = 1.5 - 0.08
    r = rm.checkInput('l')
    expect(r.judgment).toBe('good')
    expect(r.offset).toBeLessThan(0)
    c.t = 2.0 + 0.2
    r = rm.checkInput('a')
    expect(r.judgment).toBe('ok')
    expect(rm.combo).toBe(3)
    expect(rm.maxCombo).toBe(3)
  })

  test('a slip never consumes the note or breaks the combo', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    c.t = 1.0
    expect(rm.checkInput('p').hit).toBe(true)
    c.t = 1.5
    const r = rm.checkInput('x')
    expect(r.judgment).toBe('slip')
    expect(r.hit).toBe(false)
    expect(rm.combo).toBe(1)
    expect(rm.slipCount).toBe(1)
    expect(rm.currentExpectedChar()).toBe('l')
    expect(rm.checkInput('l').hit).toBe(true)
  })

  test('too early does not register a miss', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    c.t = 0.5
    expect(rm.checkInput('p').judgment).toBe('too_early')
    expect(rm.missCount).toBe(0)
    c.t = 1.0
    expect(rm.checkInput('p').hit).toBe(true)
  })

  test('update registers a miss once the window closes, then moves on', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    c.t = 1.0 + 0.226
    const missed = rm.update()
    expect(missed.map((e) => e.char)).toEqual(['p'])
    expect(rm.missCount).toBe(1)
    expect(rm.currentExpectedChar()).toBe('l')
  })

  test('a hold ignores other keys and completes on release', () => {
    const c = new Clock()
    const evs = chart('go', 1.0, 1.0)
    evs[0].hold_duration = 0.6
    const rm = new RhythmManager(evs, { bpm: 120, clock: c.fn })
    c.t = 1.0
    expect(rm.checkInput('g').judgment).toBe('hold_started')
    c.t = 1.2
    expect(rm.checkInput('o').judgment).toBe('ignored')
    expect(rm.missCount).toBe(0)
    c.t = 1.58
    const r = rm.onKeyRelease('g')!
    expect(r.hit).toBe(true)
    expect(r.judgment).toBe('hold_perfect')
    c.t = 2.0
    expect(rm.checkInput('o').hit).toBe(true)
  })

  test('a broken hold registers a miss', () => {
    const c = new Clock()
    const evs = chart('go', 1.0, 1.0)
    evs[0].hold_duration = 0.6
    const rm = new RhythmManager(evs, { bpm: 120, clock: c.fn })
    c.t = 1.0
    rm.checkInput('g')
    c.t = 1.2
    expect(rm.onKeyRelease('g')!.judgment).toBe('hold_broken')
    expect(rm.missCount).toBe(1)
  })

  test('score is normalized and a perfect run hits the cap', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    const letters = 'planet'
    for (let i = 0; i < letters.length; i++) {
      c.t = 1.0 + i * 0.5
      expect(rm.checkInput(letters[i]).judgment).toBe('perfect')
    }
    expect(rm.getScore()).toBe(1_000_000)
    expect(rm.getGrade()).toBe('SS')
    expect(rm.cleanWords()).toBe(1)
  })

  test('the hit log has every judgment', () => {
    const c = new Clock()
    const rm = new RhythmManager(chart(), { bpm: 120, clock: c.fn })
    c.t = 1.0
    rm.checkInput('p')
    c.t = 1.5
    rm.checkInput('q')
    c.t = 2.1     // l's window closed at 1.65; a's is still open
    rm.update()
    expect(rm.hits.map((h) => h.judgment)).toEqual(['perfect', 'slip', 'miss'])
    expect(rm.hits[1].pressed).toBe('q')
  })

  test('copy keeps every field', () => {
    const e = makeEvent({
      char: 'a', timestamp: 1.0, word_text: 'a', char_idx: 0, beat_position: 0, section: 0,
      repeat_group_id: 3, repeat_iter: 2, weight: 4, lane: 0, word_id: 9,
    })
    const rm = new RhythmManager([e], { bpm: 120, leadIn: 0.5 })
    const c = rm.beatMap[0]
    expect([c.repeat_group_id, c.repeat_iter, c.weight, c.lane, c.word_id]).toEqual([3, 2, 4, 0, 9])
    expect(Math.abs(c.timestamp - 1.5)).toBeLessThan(1e-9)
  })

  test('the source events are never mutated', () => {
    const evs = chart()
    const rm = new RhythmManager(evs, { bpm: 120, leadIn: 2.0, clock: () => 3.0 })
    rm.checkInput('p')
    expect(evs[0].timestamp).toBe(1.0)
    expect(evs[0].hit).toBe(false)
  })
})

// ── window boundaries ──────────────────────────────────────────────────────
// A note at timestamp 0 with no lead-in is the one place a press can land *exactly*
// on a window edge: `press - 0.0` is the press, with no rounding in between.  Every
// window comparison is inclusive of its edge, and these mirror the same four tests
// in tests/test_rhythm.py, because a tape of real presses at t ≈ 100 s can never
// reach a boundary to prove it — the mutation run showed `<=` passing as `<`.

function oneNote(ch = 'a'): CharEvent[] {
  return [makeEvent({ char: ch, timestamp: 0, word_text: ch, char_idx: 0,
                      beat_position: 0, section: 0, word_id: 1 })]
}

/** the next double above x, i.e. Python's math.nextafter(x, 1.0) for x in (0, 1) */
function nextUp(x: number): number {
  const buf = new DataView(new ArrayBuffer(8))
  buf.setFloat64(0, x)
  buf.setBigUint64(0, buf.getBigUint64(0) + 1n)
  return buf.getFloat64(0)
}

describe('window boundaries', () => {
  test('window edges are inclusive', () => {
    const c = new Clock()
    const rm = new RhythmManager(oneNote(), { bpm: 120, clock: c.fn })
    c.t = rm.timingWindows.perfect
    expect(rm.checkInput('a').judgment).toBe('perfect')
  })

  test('just past an edge falls to the next window', () => {
    for (const [edge, want] of [['perfect', 'good'], ['good', 'ok']] as const) {
      const c = new Clock()
      const rm = new RhythmManager(oneNote(), { bpm: 120, clock: c.fn })
      c.t = nextUp(rm.timingWindows[edge])
      expect(rm.checkInput('a').judgment).toBe(want)
    }
  })

  test('the edges are symmetric about the note', () => {
    const c = new Clock()
    const rm = new RhythmManager(oneNote(), { bpm: 120, clock: c.fn })
    c.t = -rm.timingWindows.good
    const r = rm.checkInput('a')
    expect(r.judgment).toBe('good')
    expect(r.offset).toBeLessThan(0)
  })

  test('a press exactly on the ok edge is ok, not too early', () => {
    const c = new Clock()
    const rm = new RhythmManager(oneNote(), { bpm: 120, clock: c.fn })
    c.t = -rm.okWindowFor(rm.beatMap[0])
    expect(rm.checkInput('a').judgment).toBe('ok')
  })
})

// ── rounding ───────────────────────────────────────────────────────────────
// get_score() ends in Python's round(), which is banker's rounding; JS Math.round
// is half-up.  The two disagree only on an exact .5, which a real score will never
// land on — so the helper is pinned here rather than through a played run.  The
// expectations are what CPython's round() returns for the same inputs.
describe('roundHalfEven matches Python round()', () => {
  test('ties go to even', () => {
    const cases: [number, number][] = [
      [0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [-0.5, 0], [-1.5, -2], [-2.5, -2],
      [999999.5, 1000000], [1000000.5, 1000000], [123456.5, 123456], [123457.5, 123458],
    ]
    for (const [x, want] of cases) expect(roundHalfEven(x), `round(${x})`).toBe(want)
  })

  test('everything else rounds normally', () => {
    const cases: [number, number][] = [
      [0.4, 0], [0.6, 1], [2.49999, 2], [2.50001, 3], [-1.4, -1], [-1.6, -2],
      [394108.9999, 394109], [394109.0001, 394109],
    ]
    for (const [x, want] of cases) expect(roundHalfEven(x), `round(${x})`).toBe(want)
  })

  // ── chords: two anchors due together, one per hand ───────────────────────
  // The charting engine's spacing pass used to drop the second of the pair, so no
  // chart ever contained a chord and none of this ran.  Both cores have always had
  // the code; these pin the behaviour now that charts really produce them.
  function chord(t = 1.0, dur = 1.0, a = 'f', b = 'j'): CharEvent[] {
    const evs = [a, b].map((c, i) => makeEvent({
      char: c, timestamp: t, word_text: c, char_idx: 0, beat_position: 0, section: 0,
      word_id: i + 1, hold_duration: dur, section_kind: 'anchor', lane: laneOf(c),
    }))
    evs.push(makeEvent({
      char: '', timestamp: t + dur + 0.5, word_text: '', char_idx: -1,
      beat_position: 0, section: 0, is_rest: true,
    }))
    return evs
  }

  test('a chord may be pressed in either order', () => {
    const c = new Clock()
    const rm = new RhythmManager(chord(), { bpm: 120, clock: c.fn })
    c.t = 1.0
    expect(rm.checkInput('j').judgment).toBe('anchor_started')   // the later of the pair, first
    expect(rm.checkInput('f').judgment).toBe('anchor_started')
    expect(rm.anchors.length).toBe(2)                            // both hands are down
  })

  test('a chord does not clamp its partner\'s window', () => {
    const rm = new RhythmManager(chord(), { bpm: 120, clock: new Clock().fn })
    for (const e of rm.beatMap.slice(0, 2)) {
      expect(rm.okWindowFor(e)).toBe(rm.timingWindows.ok)
    }
  })

  // ── holds: a bounce on the way down is not a release ─────────────────────
  function holdChart(dur = 1.0, t = 1.0, ch = 'a'): CharEvent[] {
    return [
      makeEvent({ char: ch, timestamp: t, word_text: ch, char_idx: 0, beat_position: 0,
                  section: 0, word_id: 1, hold_duration: dur }),
      makeEvent({ char: '', timestamp: t + dur + 0.5, word_text: '', char_idx: -1,
                  beat_position: 0, section: 0, is_rest: true }),
    ]
  }

  test('a bounce right after the press does not break a hold', () => {
    const c = new Clock()
    const rm = new RhythmManager(holdChart(), { bpm: 120, clock: c.fn })
    c.t = 1.0
    expect(rm.checkInput('a').judgment).toBe('hold_started')
    c.t = 1.05                                  // the key comes back up at once
    expect(rm.onKeyRelease('a')).toBeNull()
    expect(rm.activeHold).not.toBeNull()        // still holding
    c.t = 1.40                                  // a real release, and far too early
    expect(rm.onKeyRelease('a')?.judgment).toBe('hold_broken')
  })

  test('the same grace covers an anchor', () => {
    const evs = holdChart(1.5, 1.0, 'f')
    evs[0].section_kind = 'anchor'
    evs[0].lane = laneOf('f')
    const c = new Clock()
    const rm = new RhythmManager(evs, { bpm: 120, clock: c.fn })
    c.t = 1.0
    expect(rm.checkInput('f').judgment).toBe('anchor_started')
    c.t = 1.06
    expect(rm.onKeyRelease('f')).toBeNull()
    expect(rm.anchors.length).toBe(1)
  })
})
