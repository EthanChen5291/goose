/**
 * RhythmManager — the judgment core.  A 1:1 port of game/rhythm.py.
 *
 * One ordered stream of CharEvents, one clock, fixed-millisecond windows scaled
 * per tier, signed offsets, and four honest results for a press:
 *
 *   hit          the expected key inside a window (perfect / good / ok)
 *   too_early    the expected key before the window: nothing happens, note stays live
 *   slip         a different key: never consumes the note, never breaks combo
 *   ignored      a press while a hold is active or the chart is finished
 *
 * An **anchor** is a hold that runs *beside* the stream: one hand holds its key
 * while the other hand's notes are judged as usual.  Starting it is a normal
 * press on its note; releasing early breaks it (a miss); reaching its end
 * completes it.  It never blocks other input.
 *
 * Misses are only ever registered by `update()` when a note's window closes, or
 * by `onKeyRelease` when a hold is dropped.  Every judgment appends a HitRecord.
 *
 * Score is normalized: 1,000,000 × (0.70 accuracy + 0.20 combo + 0.10 clean words).
 *
 * The one deliberate difference from the Python: identity.  Python keys the
 * per-note window clamp on `id(event)`; here every event carries an integer
 * `_uid` assigned at copy time, which is the same thing without the aliasing
 * risk of object identity.
 */
import type { CharEvent, HitRecord } from './models'
import { BEATS_PER_MEASURE, LEAD_IN_MIN_SECONDS } from './constants'

export const JUDGMENT_VALUE: Record<string, number> = {
  perfect: 1.0, good: 0.7, ok: 0.3, miss: 0.0,
}
/** typing needs a finger, not just a tap */
export const BASE_WINDOWS_S = { perfect: 0.075, good: 0.15, ok: 0.225 }
export const SCORE_MAX = 1_000_000

export type Judgment =
  | 'perfect' | 'good' | 'ok' | 'miss' | 'slip' | 'too_early' | 'ignored'
  | 'hold_started' | 'anchor_started' | 'hold_broken' | 'anchor_broken'
  | `hold_${string}`

export interface InputResult {
  hit: boolean
  judgment: string
  offset: number
  time_diff: number
  combo: number
  /** always one of the manager's own copies, never a caller's source event */
  event: LiveEvent | null
  is_word_complete: boolean
  pressed?: string
  anchor?: boolean
}

/** Lead-in snapped to the first measure boundary at or after `minSeconds`. */
export function calculateLeadIn(beatTimes: number[], minSeconds = LEAD_IN_MIN_SECONDS): number {
  if (beatTimes.length < BEATS_PER_MEASURE * 2) return minSeconds
  for (let i = 0; i < beatTimes.length; i += BEATS_PER_MEASURE) {
    if (beatTimes[i] >= minSeconds) return beatTimes[i]
  }
  const last = Math.floor(beatTimes.length / BEATS_PER_MEASURE) * BEATS_PER_MEASURE
  if (last < beatTimes.length) return beatTimes[last]
  return minSeconds
}

/** A chart event as the manager holds it: its own copy, with a stable id. */
export type LiveEvent = CharEvent & { _uid: number }

export interface RhythmOptions {
  bpm: number
  leadIn?: number
  timingScale?: number
  clock?: () => number
  rushBonusPerPerfect?: number
}

export class RhythmManager {
  readonly bpm: number
  readonly beatDuration: number
  readonly leadIn: number
  readonly timingScale: number

  beatMap: LiveEvent[] = []
  timingWindows!: { perfect: number; good: number; ok: number }

  charEventIdx = 0
  currentWordIdx = 0
  lastWord: string | null = null

  combo = 0
  maxCombo = 0
  perfectHits = 0
  goodHits = 0
  okHits = 0
  holdPerfectHits = 0
  holdGoodHits = 0
  holdOkHits = 0
  missCount = 0
  slipCount = 0
  tooEarlyCount = 0
  rushBonus = 0
  rushActive = false

  playableEvents: LiveEvent[]
  totalNotes: number
  totalWords: number

  hits: HitRecord[] = []
  offsetsMs: number[] = []

  /** word ids with a miss inside */
  dirtyWords = new Set<number>()
  doneWords = new Set<number>()

  activeHold: LiveEvent | null = null
  holdJudgment = 'ok'
  /** when the active hold went down — `_hold_press_time` on the Python side */
  private holdPressTime = 0
  /** anchors: holds the other hand plays through — up to one per hand (a chord is two) */
  anchors: LiveEvent[] = []
  anchorJudgment = 'ok'
  /** anchors that ended by time since last read */
  anchorResults: InputResult[] = []

  private readonly rushBonusPerPerfect: number
  private readonly clock: () => number
  private readonly t0: number
  private readonly holdReleaseGrace = 0.12
  /**
   * A key that comes back up within this of going down is a fumble, not a
   * release: a bounce or a finger resettling should not break a hold the player
   * has only just started.  Short enough that it can never stand in for holding a
   * note, since the shortest hold is about 0.35 s.
   */
  private readonly holdSettle = 0.12
  /** when each held anchor went down, by uid */
  private anchorPress = new Map<number, number>()
  private anchorJudgments = new Map<number, string>()
  private noteOkWindow = new Map<number, number>()
  private lastPressT: number | null = null
  private nextUid = 1

  constructor(beatMap: CharEvent[], opts: RhythmOptions) {
    this.bpm = opts.bpm
    this.beatDuration = opts.bpm > 0 ? 60 / opts.bpm : 0.5
    this.leadIn = opts.leadIn ?? 0
    this.timingScale = opts.timingScale ?? 1.0
    this.rushBonusPerPerfect = opts.rushBonusPerPerfect ?? 1500

    // Copy every field; timestamps become chart time (leadIn included).
    for (const e of beatMap) {
      this.beatMap.push({ ...e, timestamp: e.timestamp + this.leadIn, hit: false, _uid: this.nextUid++ })
    }

    this.t0 = performance.now() / 1000
    this.clock = opts.clock ?? (() => performance.now() / 1000 - this.t0)

    this.playableEvents = this.beatMap.filter((e) => !e.is_rest && e.char)
    this.totalNotes = this.playableEvents.length
    const wordIds = new Set(this.playableEvents.map((e) => e.word_id))
    this.totalWords = wordIds.size

    this.setupTimingWindows()
  }

  // ── setup ────────────────────────────────────────────────────────────────
  /** Fixed milliseconds × tier scale.  Never a function of tempo. */
  private setupTimingWindows(): void {
    const s = this.timingScale
    this.timingWindows = {
      perfect: BASE_WINDOWS_S.perfect * s,
      good: BASE_WINDOWS_S.good * s,
      ok: BASE_WINDOWS_S.ok * s,
    }
    this.noteOkWindow.clear()
    // per-note clamp: a window never reaches past the midpoint to a neighbour
    let prev: LiveEvent | null = null
    for (const e of this.beatMap) {
      if (e.is_rest || !e.char) continue
      let w = this.timingWindows.ok
      if (prev !== null) {
        const gap = e.timestamp - prev.timestamp
        const chord = e.section_kind === 'anchor' && prev.section_kind === 'anchor' && gap < 0.06
        if (prev.section_kind === 'grace') {
          // a grace note is the small note before its main note: it gets a tight window of its
          // own and the main note keeps its full one (only the note after clamps it)
          const cur = this.noteOkWindow.get(prev._uid) ?? w
          this.noteOkWindow.set(prev._uid, Math.min(cur, Math.max(0.045, gap * 0.6)))
        } else if (!chord) {
          w = Math.min(w, Math.max(0.06, gap * 0.5))
          const cur = this.noteOkWindow.get(prev._uid) ?? w
          this.noteOkWindow.set(prev._uid, Math.min(cur, Math.max(0.06, gap * 0.5)))
        }
      }
      this.noteOkWindow.set(e._uid, w)
      prev = e
    }
  }

  okWindowFor(e: LiveEvent): number {
    return this.noteOkWindow.get(e._uid) ?? this.timingWindows.ok
  }

  /** The anchor started last (null when no hand is holding). */
  get anchor(): LiveEvent | null {
    return this.anchors.length ? this.anchors[this.anchors.length - 1] : null
  }

  get lastAnchorResult(): InputResult | null {
    return this.anchorResults.length ? this.anchorResults[this.anchorResults.length - 1] : null
  }

  // ── time ─────────────────────────────────────────────────────────────────
  now(): number {
    return this.clock()
  }

  // ── advance ──────────────────────────────────────────────────────────────
  /** Advance past rests and expired notes.  Returns the notes that just became misses. */
  update(): LiveEvent[] {
    const missed: LiveEvent[] = []
    if (this.isFinished()) return missed
    const elapsed = this.now()

    if (this.activeHold !== null) {
      const holdEnd = this.activeHold.timestamp + this.activeHold.hold_duration
      if (elapsed >= holdEnd) this.completeHold(this.holdJudgment)
      return missed
    }
    for (const a of [...this.anchors]) {
      if (elapsed >= a.timestamp + a.hold_duration) this.anchorResults.push(this.completeAnchor(a))
    }

    while (this.charEventIdx < this.beatMap.length) {
      const ev = this.beatMap[this.charEventIdx]
      if (ev.is_rest || !ev.char) {
        if (elapsed >= ev.timestamp) { this.charEventIdx += 1; continue }
        break
      }
      if (elapsed > ev.timestamp + this.okWindowFor(ev)) {
        this.registerMiss(ev)
        missed.push(ev)
        this.charEventIdx += 1
      } else break
    }
    return missed
  }

  // ── input ────────────────────────────────────────────────────────────────
  checkInput(typedChar: string, pressTime?: number): InputResult {
    const base: InputResult = {
      hit: false, judgment: 'ignored', offset: 0, time_diff: 0,
      combo: this.combo, event: null, is_word_complete: false, pressed: typedChar,
    }
    if (this.isFinished()) return base
    if (this.activeHold !== null) return base
    const lower = typedChar.toLowerCase()
    // key repeat on a held anchor: nothing
    if (this.anchors.some((a) => lower === a.char.toLowerCase())) return base
    let ev = this.currentEvent()
    if (ev === null || ev.is_rest || !ev.char) return base

    // a chord (two anchors due together) may be pressed in either order
    if (ev.section_kind === 'anchor' && lower !== ev.char.toLowerCase()) {
      const j = this.charEventIdx + 1
      if (j < this.beatMap.length) {
        const nxt = this.beatMap[j]
        if (nxt.section_kind === 'anchor' && Math.abs(nxt.timestamp - ev.timestamp) < 0.06
            && lower === nxt.char.toLowerCase()) {
          this.beatMap[this.charEventIdx] = nxt
          this.beatMap[j] = ev
          ev = nxt
        }
      }
    }

    const elapsed = pressTime ?? this.now()
    const gapMs = this.lastPressT === null ? -1.0 : (elapsed - this.lastPressT) * 1000
    this.lastPressT = elapsed
    const offset = elapsed - ev.timestamp
    base.event = ev
    base.offset = offset
    base.time_diff = Math.abs(offset)

    if (lower !== ev.char.toLowerCase()) {
      this.slipCount += 1
      this.hits.push(this.record(elapsed, ev, typedChar, 'slip', offset * 1000, gapMs))
      base.judgment = 'slip'
      return base
    }

    const okW = this.okWindowFor(ev)
    if (offset < -okW) {
      this.tooEarlyCount += 1
      this.hits.push(this.record(elapsed, ev, typedChar, 'too_early', offset * 1000, gapMs))
      base.judgment = 'too_early'
      return base
    }

    const judgment = this.getJudgment(Math.abs(offset), okW)
    this.offsetsMs.push(offset * 1000)

    if (ev.section_kind === 'anchor' && ev.hold_duration > 0) {
      this.anchors = [...this.anchors.filter((a) => a.lane !== ev!.lane), ev]
      this.anchorJudgments.set(ev._uid, judgment)
      this.anchorPress.set(ev._uid, elapsed)
      this.anchorJudgment = judgment
      ev.hit = true
      this.charEventIdx += 1
      this.hits.push(this.record(ev.timestamp, ev, typedChar, 'anchor_started', offset * 1000, gapMs))
      return { ...base, hit: true, judgment: 'anchor_started', combo: this.combo }
    }

    if (ev.hold_duration > 0) {
      this.activeHold = ev
      this.holdPressTime = elapsed
      this.holdJudgment = judgment
      ev.hit = true
      this.charEventIdx += 1
      this.hits.push(this.record(ev.timestamp, ev, typedChar, 'hold_started', offset * 1000, gapMs))
      return { ...base, hit: true, judgment: 'hold_started', combo: this.combo }
    }

    this.registerHit(judgment)
    ev.hit = true
    this.charEventIdx += 1
    this.hits.push(this.record(ev.timestamp, ev, typedChar, judgment, offset * 1000, gapMs))
    const complete = this.isWordComplete()
    if (complete) this.doneWords.add(ev.word_id)
    return { ...base, hit: true, judgment, combo: this.combo, is_word_complete: complete }
  }

  onKeyRelease(releasedChar: string, releaseTime?: number): InputResult | null {
    const lower = releasedChar.toLowerCase()
    const held = this.anchors.find((a) => lower === a.char.toLowerCase())
    if (held !== undefined) {
      const elapsed = releaseTime ?? this.now()
      // a fumble on the way down, not a release
      if (elapsed - (this.anchorPress.get(held._uid) ?? -1e9) < this.holdSettle) return null
      const end = held.timestamp + held.hold_duration
      if (elapsed >= end - held.hold_duration * this.holdReleaseGrace) return this.completeAnchor(held)
      this.anchors = this.anchors.filter((a) => a !== held)
      this.registerMiss(held, 'anchor_broken')
      return {
        hit: false, judgment: 'anchor_broken', offset: 0, time_diff: 0,
        combo: this.combo, event: held, is_word_complete: false, anchor: true,
      }
    }
    if (this.activeHold === null) return null
    if (lower !== this.activeHold.char.toLowerCase()) return null
    const elapsed = releaseTime ?? this.now()
    // a fumble on the way down, not a release
    if (elapsed - this.holdPressTime < this.holdSettle) return null
    const holdEnd = this.activeHold.timestamp + this.activeHold.hold_duration
    const required = holdEnd - this.activeHold.hold_duration * this.holdReleaseGrace
    if (elapsed >= required) return this.completeHold(this.holdJudgment)
    const ev = this.activeHold
    this.activeHold = null
    this.registerMiss(ev, 'hold_broken')
    return {
      hit: false, judgment: 'hold_broken', offset: 0, time_diff: 0,
      combo: this.combo, event: ev, is_word_complete: false,
    }
  }

  private completeHold(judgment: string): InputResult {
    const ev = this.activeHold
    this.registerHoldHit(judgment, ev)
    this.activeHold = null
    const complete = this.isWordComplete()
    if (complete && ev !== null) this.doneWords.add(ev.word_id)
    return {
      hit: true, judgment: `hold_${judgment}`, offset: 0, time_diff: 0,
      combo: this.combo, event: ev, is_word_complete: complete,
    }
  }

  private completeAnchor(ev: LiveEvent): InputResult {
    this.anchors = this.anchors.filter((a) => a !== ev)
    const j = this.anchorJudgments.get(ev._uid) ?? this.anchorJudgment
    this.anchorJudgments.delete(ev._uid)
    this.registerHoldHit(j, ev)
    this.doneWords.add(ev.word_id)
    return {
      hit: true, judgment: `hold_${j}`, offset: 0, time_diff: 0,
      combo: this.combo, event: ev, is_word_complete: true, anchor: true,
    }
  }

  // ── judgment bookkeeping ─────────────────────────────────────────────────
  private getJudgment(adiff: number, okW: number): string {
    if (adiff <= this.timingWindows.perfect) return 'perfect'
    if (adiff <= this.timingWindows.good) return 'good'
    if (adiff <= okW) return 'ok'
    return 'miss'
  }

  private record(t: number, ev: LiveEvent, pressed: string, judgment: string,
                 offsetMs: number, gapMs: number): HitRecord {
    return {
      t_song: t, expected: ev.char, pressed, judgment, offset_ms: offsetMs,
      word: ev.word_text, char_idx: ev.char_idx, gap_ms: gapMs,
      weight: ev.weight, lane: ev.lane, voice: ev.voice,
    }
  }

  private registerHit(judgment: string): void {
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    if (judgment === 'perfect') {
      this.perfectHits += 1
      if (this.rushActive) this.rushBonus += this.rushBonusPerPerfect
    } else if (judgment === 'good') this.goodHits += 1
    else this.okHits += 1
  }

  private registerHoldHit(judgment: string, ev: LiveEvent | null): void {
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    if (judgment === 'perfect') this.holdPerfectHits += 1
    else if (judgment === 'good') this.holdGoodHits += 1
    else this.holdOkHits += 1
    if (ev !== null) {
      this.hits.push(this.record(ev.timestamp, ev, ev.char, `hold_${judgment}`, 0, -1))
    }
  }

  private registerMiss(ev: LiveEvent | null = null, judgment = 'miss'): void {
    this.combo = 0
    this.missCount += 1
    if (ev !== null) {
      this.dirtyWords.add(ev.word_id)
      this.hits.push({
        t_song: ev.timestamp, expected: ev.char, pressed: '', judgment, offset_ms: 0,
        word: ev.word_text, char_idx: ev.char_idx, gap_ms: -1,
        weight: ev.weight, lane: ev.lane, voice: ev.voice,
      })
    }
  }

  private isWordComplete(): boolean {
    const prevIdx = this.charEventIdx - 1
    if (prevIdx < 0) return false
    const prev = this.beatMap[prevIdx]
    if (prev.is_rest || !prev.word_text || prev.section_kind === 'grace') return false
    return prev.char_idx === prev.word_text.length - 1
  }

  // ── getters ──────────────────────────────────────────────────────────────
  currentEvent(): LiveEvent | null {
    if (this.charEventIdx >= this.beatMap.length) return null
    return this.beatMap[this.charEventIdx]
  }

  currentExpectedChar(): string | null {
    const ev = this.currentEvent()
    if (!ev || ev.is_rest || !ev.char) return null
    return ev.char
  }

  currentExpectedWord(): string | null {
    const ev = this.currentEvent()
    if (!ev) return this.lastWord
    if (ev.is_rest || !ev.char) {
      for (let i = this.charEventIdx + 1; i < this.beatMap.length; i++) {
        const nxt = this.beatMap[i]
        if (!nxt.is_rest && nxt.word_text) return nxt.word_text
      }
      return this.lastWord
    }
    if (ev.word_text) this.lastWord = ev.word_text
    return this.lastWord
  }

  /** The events of the word instance at (or after) the cursor. */
  currentWordEvents(): LiveEvent[] {
    let ev = this.currentEvent()
    let idx = this.charEventIdx
    if (ev === null) return []
    if (ev.is_rest || !ev.char) {
      let found = false
      for (let i = idx + 1; i < this.beatMap.length; i++) {
        if (!this.beatMap[i].is_rest && this.beatMap[i].char) {
          idx = i; ev = this.beatMap[i]; found = true; break
        }
      }
      if (!found) return []
    }
    const wid = ev.word_id
    const out: LiveEvent[] = []
    for (let i = Math.max(0, idx - 24); i < this.beatMap.length; i++) {
      const e = this.beatMap[i]
      if (e.is_rest || !e.char) continue
      if (e.word_id === wid) out.push(e)
      else if (out.length) break
    }
    return out
  }

  /** The next n distinct word instances after the current one. */
  upcomingWords(n = 3): string[] {
    const cur = this.currentWordEvents()
    const curId = cur.length ? cur[0].word_id : null
    const seen: number[] = []
    const words: string[] = []
    for (let i = this.charEventIdx; i < this.beatMap.length; i++) {
      const e = this.beatMap[i]
      // a held key is shown on its lane, not as a word
      if (e.is_rest || !e.char || e.word_id === curId || e.section_kind === 'anchor') continue
      if (!seen.includes(e.word_id)) {
        seen.push(e.word_id)
        words.push(e.word_text)
        if (words.length >= n) break
      }
    }
    return words
  }

  /** Only the letters of the current word that actually have notes. */
  currentDisplayWord(): string | null {
    const evs = this.currentWordEvents()
    if (!evs.length) return this.currentExpectedWord()
    const maxIdx = Math.max(...evs.map((e) => e.char_idx))
    return evs[0].word_text.slice(0, maxIdx + 1)
  }

  getUpcomingEvents(lookaheadTime = 3.0): LiveEvent[] {
    if (this.isFinished()) return []
    const t = this.now()
    const out: LiveEvent[] = []
    for (let i = this.charEventIdx; i < this.beatMap.length; i++) {
      const e = this.beatMap[i]
      if (e.timestamp - t > lookaheadTime) break
      out.push(e)
    }
    return out
  }

  getProgress(): number {
    if (!this.beatMap.length) return 1.0
    return this.charEventIdx / this.beatMap.length
  }

  isFinished(): boolean {
    return this.charEventIdx >= this.beatMap.length
  }

  onBeat(): boolean {
    const ev = this.currentEvent()
    if (!ev || ev.is_rest) return false
    return Math.abs(this.now() - ev.timestamp) <= this.okWindowFor(ev)
  }

  // ── scoring ──────────────────────────────────────────────────────────────
  judgedNotes(): number {
    return this.perfectHits + this.goodHits + this.okHits + this.missCount
      + this.holdPerfectHits + this.holdGoodHits + this.holdOkHits
  }

  weightedHits(): number {
    return (this.perfectHits + this.holdPerfectHits) * 1.0
      + (this.goodHits + this.holdGoodHits) * 0.7
      + (this.okHits + this.holdOkHits) * 0.3
  }

  /** Accuracy over the notes judged so far (0–100). */
  getAccuracy(): number {
    const judged = this.judgedNotes()
    if (judged === 0) return 100.0
    return Math.min(100.0, (this.weightedHits() / judged) * 100)
  }

  cleanWords(): number {
    let n = 0
    for (const w of this.doneWords) if (!this.dirtyWords.has(w)) n += 1
    return n
  }

  /** Normalized score, monotone during play: the share of the 1,000,000 earned so far. */
  getScore(): number {
    if (this.totalNotes === 0) return 0
    const accTerm = this.weightedHits() / this.totalNotes
    const comboTerm = this.maxCombo / this.totalNotes
    const cleanTerm = this.totalWords ? this.cleanWords() / this.totalWords : 0
    return roundHalfEven(SCORE_MAX * (0.7 * accTerm + 0.2 * comboTerm + 0.1 * cleanTerm)) + this.rushBonus
  }

  getGrade(): string {
    const acc = this.getAccuracy()
    if (acc >= 99.5 && this.missCount === 0) return 'SS'
    if (acc >= 95) return 'S'
    if (acc >= 90) return 'A'
    if (acc >= 80) return 'B'
    if (acc >= 70) return 'C'
    return 'D'
  }

  stars(): number {
    const acc = this.getAccuracy()
    if (acc >= 95 && this.missCount <= 2) return 3
    if (acc >= 90) return 2
    if (acc >= 80) return 1
    return 0
  }

  meanOffsetMs(): number {
    if (!this.offsetsMs.length) return 0
    return this.offsetsMs.reduce((a, b) => a + b, 0) / this.offsetsMs.length
  }

  getStats(): Record<string, number | string> {
    return {
      score: this.getScore(),
      accuracy: this.getAccuracy(),
      rank: this.getGrade(),
      grade: this.getGrade(),
      stars: this.stars(),
      combo: this.combo,
      max_combo: this.maxCombo,
      perfect: this.perfectHits + this.holdPerfectHits,
      good: this.goodHits + this.holdGoodHits,
      ok: this.okHits + this.holdOkHits,
      misses: this.missCount,
      slips: this.slipCount,
      too_early: this.tooEarlyCount,
      clean_words: this.cleanWords(),
      total_words: this.totalWords,
      total_notes: this.totalNotes,
      mean_offset_ms: this.meanOffsetMs(),
      progress: this.getProgress(),
    }
  }
}

/**
 * Python's round() is banker's rounding; JS Math.round() is half-up.  The score
 * is the one place the difference is observable, so it is spelled out here to
 * keep the two builds bit-identical on a .5.
 */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff > 0.5) return f + 1
  if (diff < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}
