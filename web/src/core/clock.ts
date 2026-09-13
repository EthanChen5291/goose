/**
 * ChartClock — the one honest clock for a play session.
 *
 * The pygame build anchors on `time.perf_counter()` and slews toward
 * `mixer.music.get_pos()`, because the OS audio stack can stall and the mixer's
 * idea of "now" is the only truth available.  The browser hands us that truth
 * directly: `AudioContext.currentTime` advances with the audio hardware's sample
 * clock, so chart time is read off the audio graph and there is nothing to
 * correct.  `check_drift` from clock.py has no counterpart here by design.
 *
 * Before the music starts (the count-in), the clock runs off `performance.now()`
 * anchored to the same instant, so the lead-in bars fall on a clock that is
 * continuous with the one the song will use.
 *
 * Everything that judges or draws a note asks this clock.  Pause lives inside it,
 * so a paused run never drifts.
 */

export class ChartClock {
  private ctx: AudioContext
  /** ctx.currentTime at chart time 0 */
  private anchor: number | null = null
  private pausedTotal = 0
  private pauseStart: number | null = null
  private offset: number

  constructor(ctx: AudioContext, deviceOffsetMs = 0) {
    this.ctx = ctx
    this.offset = deviceOffsetMs / 1000
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  start(): void {
    this.anchor = this.ctx.currentTime
    this.pausedTotal = 0
    this.pauseStart = null
  }

  get started(): boolean { return this.anchor !== null }
  get paused(): boolean { return this.pauseStart !== null }

  pause(): void {
    if (this.anchor === null || this.pauseStart !== null) return
    this.pauseStart = this.ctx.currentTime
  }

  resume(): void {
    if (this.pauseStart === null) return
    this.pausedTotal += this.ctx.currentTime - this.pauseStart
    this.pauseStart = null
  }

  // ── reading ──────────────────────────────────────────────────────────────
  /** Chart time without the device offset. */
  raw(): number {
    if (this.anchor === null) return 0
    const now = this.pauseStart !== null ? this.pauseStart : this.ctx.currentTime
    return now - this.anchor - this.pausedTotal
  }

  /** Chart time in seconds: what judgments and rendering use. */
  now(): number {
    return this.raw() + this.offset
  }

  /**
   * Chart time for a press that happened at `eventTimeMs` (a DOM
   * `KeyboardEvent.timeStamp`, i.e. milliseconds on the `performance.now()`
   * timeline).
   *
   * This is the whole reason the web build judges better than the pygame one:
   * a key pressed mid-frame is judged at the instant it was pressed, not at the
   * instant the frame got around to reading it.  A 16 ms frame used to cost up
   * to 16 ms of judgment error; here it costs none.
   */
  atEvent(eventTimeMs: number): number {
    const lagS = (performance.now() - eventTimeMs) / 1000
    return this.now() - Math.max(0, lagS)
  }

  setDeviceOffset(ms: number): void { this.offset = ms / 1000 }

  /**
   * Re-anchor so that `raw()` equals `chartT` right now.
   *
   * Called the instant the music actually starts (after the count-in), so the
   * lead-in bars can never leave the chart a frame out from the song.  `at` is
   * the AudioContext time the source was scheduled to begin, which is known
   * exactly because we scheduled it.
   */
  rebase(chartT: number, at?: number): void {
    if (this.anchor === null) return
    const when = at ?? this.ctx.currentTime
    this.anchor = when - this.pausedTotal - chartT
  }
}
