/**
 * PlaySession — one run of one song on the Highway.  A port of game/play.py.
 *
 * Loads the chart and the audio, starts the clock, then per frame: advance the
 * judgment core, process every key pressed since the last frame, tell the
 * renderer what happened, draw.  Pause lives in the clock.  When the chart ends
 * (or the song goes silent) the run fades into the results.
 *
 * Two things differ from the pygame build, both because the browser is better at
 * them:
 *
 *   The music is *scheduled*, not started.  `play.py` polls each frame for chart
 *   time to reach the lead-in and then calls `mixer.music.play()`, which starts
 *   the song some unknowable few milliseconds later and leaves the clock slewing
 *   after it.  Here the song is scheduled to begin at an exact AudioContext time
 *   known before the count-in starts, and the clock is rebased onto that same
 *   instant, so the first audible beat and chart time `lead_in` are the same
 *   moment by construction.
 *
 *   Keys are judged at the instant they were pressed.  `KeyboardEvent.timeStamp`
 *   is the real press time; a frame that takes 16 ms no longer costs 16 ms of
 *   judgment error.
 */
import { ChartClock } from './clock'
import { RhythmManager } from './rhythm'
import { makeEvent } from './models'
import type { ChartFile, Level, Song } from './models'
import { DIFFICULTY_PROFILES } from './constants'
import { Layout } from './layout'
import type { AudioEngine } from '../audio/engine'
import type { PlayRenderer } from '../render/renderer'

export interface SessionDeps {
  /** told whenever the run pauses or resumes, so the shell can show its overlay */
  onPause?: (paused: boolean) => void
  audio: AudioEngine
  audioUrl: string
  chart: ChartFile
  level: Level
  settings: Record<string, unknown>
  makeRenderer: (layout: Layout, song: Song, rhythm: RhythmManager) => PlayRenderer
  onFinish: (stats: Record<string, number | string>, renderer: PlayRenderer) => void
}

interface KeyEvent { key: string; t: number; down: boolean }

export class PlaySession {
  readonly clock: ChartClock
  readonly rhythm: RhythmManager
  readonly song: Song
  readonly leadIn: number
  layout: Layout
  renderer: PlayRenderer

  private audio: AudioEngine
  private audioUrl: string
  private settings: Record<string, unknown>
  private onFinish: SessionDeps['onFinish']
  private onPause: SessionDeps['onPause']

  private queue: KeyEvent[] = []
  private held = new Set<string>()
  private musicScheduledAt = 0
  private silenceStart: number
  private outroT0: number | null = null
  private readonly outroDur = 2.2
  private outroStarted = false
  finished = false
  paused = false

  private readonly mode: Level['mode']
  private hitsoundUrl: string | null = null
  private hitsoundVolume: number

  constructor(deps: SessionDeps) {
    this.audio = deps.audio
    this.audioUrl = deps.audioUrl
    this.settings = deps.settings
    this.onFinish = deps.onFinish
    this.onPause = deps.onPause
    this.mode = deps.level.mode

    const chart = deps.chart
    this.song = {
      bpm: chart.song.bpm,
      duration: chart.song.duration,
      beat_times: chart.song.beat_times,
      file_path: deps.audioUrl,
    }
    this.leadIn = chart.lead_in
    const profile = DIFFICULTY_PROFILES[deps.level.difficulty] ?? DIFFICULTY_PROFILES.classic

    this.clock = new ChartClock(this.audio.ctx, Number(this.settings.offset_ms ?? 0))
    this.rhythm = new RhythmManager(chart.events.map(makeEvent), {
      bpm: this.song.bpm,
      leadIn: this.leadIn,
      timingScale: profile.timing_scale,
      clock: () => this.clock.now(),
    })

    this.layout = this.makeLayout(window.innerWidth, window.innerHeight)
    this.renderer = deps.makeRenderer(this.layout, this.song, this.rhythm)
    this.renderer.setSections(chart.meta)
    this.renderer.setDuets(chart.meta.duets)

    // end-of-song: silence after the last beat
    this.silenceStart = this.song.duration
    const bt = this.song.beat_times
    if (bt.length > 8) {
      const avgGap = (bt[bt.length - 1] - bt[0]) / Math.max(1, bt.length - 1)
      for (let i = bt.length - 1; i > 0; i--) {
        if (bt[i] - bt[i - 1] > avgGap * 2.5) { this.silenceStart = bt[i - 1]; break }
      }
    }
    if (this.song.duration - this.silenceStart < 2) this.silenceStart = this.song.duration

    this.hitsoundVolume = Number(this.settings.hitsound_volume ?? 0.9)
  }

  private makeLayout(w: number, h: number): Layout {
    return new Layout(w, h, {
      keyGuide: (this.settings.key_guide as never) ?? 'off',
      nokiPlacement: (this.settings.noki_placement as never) ?? 'line',
      stageView: Boolean(this.settings.stage_view),
      mode: this.mode === 'letters' ? 'letters' : 'highway',
    })
  }

  setHitsound(url: string): void { this.hitsoundUrl = url }

  /**
   * Go.  The clock starts now and the song is scheduled for exactly one lead-in
   * later, so the count-in bars are already falling when the music begins.
   */
  start(): void {
    this.audio.musicVolume = Number(this.settings.music_volume ?? 0.8)
    this.audio.sfxVolume = 1
    this.clock.start()
    const at = this.audio.ctx.currentTime + this.leadIn
    this.musicScheduledAt = this.audio.playMusic(this.audioUrl, at)
    // chart time is exactly lead_in at the instant the song starts
    this.clock.rebase(this.leadIn, this.musicScheduledAt)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('resize', this.onResize)
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('resize', this.onResize)
    this.audio.stopMusic()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    if (e.key === 'Escape') { this.togglePause(); return }
    const t = this.clock.atEvent(e.timeStamp)
    // a renderer may give Space a letter of its own (the duel's jump); otherwise it is the rush
    const alias = this.renderer.keyAlias?.(e.key, t) ?? null
    if (alias === null && e.key === ' ') { e.preventDefault(); this.renderer.tryRush(this.clock.now()); return }
    const key = alias ?? e.key
    if (key !== e.key) e.preventDefault()
    if (key.length !== 1) return
    this.held.add(key.toLowerCase())
    this.queue.push({ key, t, down: true })
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const t = this.clock.atEvent(e.timeStamp)
    const key = this.renderer.keyAlias?.(e.key, t) ?? e.key
    if (key.length !== 1) return
    if (!this.held.delete(key.toLowerCase())) return
    this.queue.push({ key, t, down: false })
  }

  private onResize = (): void => {
    this.layout = this.makeLayout(window.innerWidth, window.innerHeight)
    this.renderer.setLayout(this.layout)
  }

  togglePause(): void {
    if (this.finished) return
    this.paused = !this.paused
    if (this.paused) { this.clock.pause(); this.audio.pauseMusic() }
    else { this.clock.resume(); this.audio.resumeMusic(this.audioUrl) }
    this.onPause?.(this.paused)
  }

  /** Leave the run early: the results screen still gets what was played. */
  quit(): void {
    if (this.finished) return
    this.finished = true
    this.stop()
    this.onFinish(this.rhythm.getStats(), this.renderer)
  }

  /**
   * Jump to a chart time.  The song restarts from the matching point and the
   * clock is rebased onto the instant it will actually begin, so seeking cannot
   * leave the chart and the audio a frame apart.
   *
   * The judgment core has no rewind — its cursor only moves forward — so this
   * walks it to the first note at or after `chartT` and counts nothing on the way.
   */
  seek(chartT: number): void {
    const target = Math.max(0, chartT)
    const songT = Math.max(0, target - this.leadIn)
    const at = this.audio.ctx.currentTime + 0.05
    this.musicScheduledAt = this.audio.playMusic(this.audioUrl, at, songT)
    this.clock.rebase(target, this.musicScheduledAt)
    // advance the cursor past everything before the target without judging it
    while (this.rhythm.charEventIdx < this.rhythm.beatMap.length
           && this.rhythm.beatMap[this.rhythm.charEventIdx].timestamp < target) {
      this.rhythm.charEventIdx += 1
    }
    this.queue = []
    this.outroT0 = null
  }

  /** One frame.  `dt` in seconds. */
  update(dt: number): void {
    if (this.finished) return
    if (this.paused) { this.renderer.draw(this.clock.now(), 0); return }
    const t = this.clock.now()

    // judgment: misses first (windows that closed), then every key since last frame
    const holdBefore = this.rhythm.activeHold
    for (const ev of this.rhythm.update()) this.renderer.onMiss(ev, t)
    if (holdBefore !== null && this.rhythm.activeHold === null && holdBefore.hit) {
      this.renderer.onHoldComplete(holdBefore, this.rhythm.holdJudgment, t)
      this.playHitsound()
    }
    for (const ar of this.rhythm.anchorResults) {
      if (ar.event !== null) {
        this.renderer.onAnchorComplete(ar.event, ar.judgment.replace('hold_', ''), t)
      }
    }
    this.rhythm.anchorResults = []

    const queue = this.queue
    this.queue = []
    for (const k of queue) {
      if (k.key === ' ') continue
      if (k.down) this.handlePress(k, t)
      else this.handleRelease(k, t)
    }

    // outro: the chart finished, the song went silent, or HP hit zero in Letters mode
    const songT = t - this.leadIn
    if ((this.rhythm.isFinished() || songT >= this.silenceStart || this.renderer.failed)
        && this.outroT0 === null) {
      this.outroT0 = t
    }

    this.renderer.draw(t, dt)

    if (this.outroT0 !== null) {
      const age = t - this.outroT0
      if (age >= 1 && !this.outroStarted) {
        this.outroStarted = true
        this.audio.fadeOutMusic(900)
      }
      if (age >= this.outroDur) {
        this.finished = true
        this.stop()
        this.onFinish(this.rhythm.getStats(), this.renderer)
      }
    }
  }

  private handlePress(k: KeyEvent, t: number): void {
    const res = this.rhythm.checkInput(k.key, k.t)
    const j = res.judgment
    const ev = res.event
    if (res.hit && ev !== null) {
      const offsetMs = res.offset * 1000
      if (j === 'hold_started') {
        this.renderer.onHoldStart(ev, this.rhythm.holdJudgment, offsetMs, t)
      } else if (j === 'anchor_started') {
        this.renderer.onAnchorStart(ev, this.rhythm.anchorJudgment, offsetMs, t)
      } else {
        this.renderer.onHit(ev, j, offsetMs, t)
        if (res.is_word_complete) {
          const clean = !this.rhythm.dirtyWords.has(ev.word_id)
          this.renderer.onWordComplete(ev.word_text, clean, t)
        }
      }
      // a hit that landed early sounds on the note's own time, not on the finger
      this.playHitsound(res.offset < -0.04 ? ev.timestamp - 0.02 - t : 0)
    } else if (j === 'slip' && ev !== null) {
      this.renderer.onSlip(ev, k.key, t)
    } else if (j === 'too_early' && ev !== null) {
      this.renderer.onTooEarly(ev, t)
    }
  }

  private handleRelease(k: KeyEvent, t: number): void {
    const hr = this.rhythm.onKeyRelease(k.key, k.t)
    if (hr === null) return
    const ev = hr.event
    if (ev === null) return
    if (hr.anchor) {
      if (hr.hit) this.renderer.onAnchorComplete(ev, hr.judgment.replace('hold_', ''), t)
      else this.renderer.onAnchorBreak(ev, t)
    } else if (hr.hit) {
      this.renderer.onHoldComplete(ev, hr.judgment.replace('hold_', ''), t)
    } else {
      this.renderer.onMiss(ev, t)
    }
  }

  /** `delay` is seconds of chart time from now; 0 plays immediately. */
  private playHitsound(delay = 0): void {
    if (!this.hitsoundUrl) return
    const when = this.audio.ctx.currentTime + Math.max(0, delay)
    this.audio.playSfx(this.hitsoundUrl, when, this.hitsoundVolume)
  }
}
