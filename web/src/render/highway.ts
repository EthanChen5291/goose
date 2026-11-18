/**
 * HighwayRenderer — the full-screen four-lane play screen, on the GPU.
 *
 * A port of game/highway.py.  One 320 px grid covers the whole screen; the middle
 * four columns are the lanes.  Beat rows and the slot line run edge to edge, Noki
 * stands on the line, equal orbs fall straight down the lanes onto fixed slot
 * rings, the word block sits under the line in the Keyboard Warrior stack, and
 * the only other things on screen are numbers.
 *
 * Everything is positioned in design units (1920×1080) through a Layout.  It
 * never judges: the session calls `onHit` / `onMiss` / `onSlip` after the
 * RhythmManager has spoken.
 *
 * What is deliberately *not* ported: the alpha-fade cache, the eight pre-baked
 * ribbon pulse levels, the quantized burst-ring alphas, the 5° shard rotation
 * cache and the numpy drop-ring field.  Every one of those exists to avoid
 * per-frame surface work on the CPU; here alpha, tint, rotation and scale are
 * sprite properties the GPU applies for free, so the shapes bake once
 * (render/textures.ts) and the rest is per-frame arithmetic.
 */
import { Container, Graphics, Rectangle, Sprite, Texture, BitmapText } from 'pixi.js'
import type { Renderer } from 'pixi.js'

import type { Layout } from '../core/layout'
import { HIGHWAY_CX, HIGHWAY_X0, LANE_W } from '../core/layout'
import { Stage } from './stage'
import { Playfield, SWAP_SECONDS, slotOf } from './playfield'
import * as KB from '../core/keyboard'
import * as C from '../core/constants'
import type { ChartMeta, Song } from '../core/models'
import type { LiveEvent, RhythmManager } from '../core/rhythm'
import { TextureCache } from './textures'
import { label } from './text'

const WHITE = 0xffffff
const STAMP_COLORS: Record<string, number> = {
  perfect: KB.GOLD,
  good: 0x83e3b0,
  ok: 0xaed0e6,
  miss: KB.MISS_RED,
  slip: 0xaaaabe,
}
const STAMP_TEXT: Record<string, string> = {
  perfect: 'PERFECT', good: 'GREAT', ok: 'OK', miss: 'MISS',
}
const ENERGY: Record<string, number> = { sustain: 0.12, groove: 0.4, drive: 0.7, burst: 1.0 }
const MILESTONES = [25, 50, 100, 150, 200, 300, 400, 500]
/** a hold whose window shut unplayed: dark, but still there */
const DEAD_HOLD = 0x3a3550
const SECTION_TAG: Record<string, string> = { pattern: 'BUILD', anchor: 'HOLD' }
const LAYER_TAG: Record<string, string> = {
  bass: 'BASS', kick: 'DRUMS', snare: 'DRUMS', hat: 'HATS', lead: 'MELODY',
}
/** seconds the press burst lives */
const STAR_LIFE = 0.38
/** design px: the white line Noki stands on */
const SLOT_LINE_W = 7
/** how hard the orbs pulse on each beat of the bar (1 · 2 · 3 · 4) */
const BOUNCE_AMP = [1.0, 0.7, 0.85, 0.7]

const DROP_LARGE_RISE = 0.2
const DROP_LARGE_MIN_E = 0.55
const DROP_SMALL_RISE = 0.09
const DROP_SMALL_MIN_E = 0.4
const DROP_PHRASE_RISE = 0.04
const DROP_LARGE_GAP_BARS = 8
const DROP_ANY_GAP_BARS = 2

const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function mixColor(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  return ((Math.round(lerp(ar, br, k)) << 16)
    | (Math.round(lerp(ag, bg, k)) << 8)
    | Math.round(lerp(ab, bb, k)))
}

/** Metric weight 4 beat1 · 3 beat3 · 2 backbeat · 1 eighth · 0 sixteenth. */
export function weightOfTime(songT: number, beatTimes: number[], bpm: number): number {
  if (!beatTimes || beatTimes.length < 2) return 2
  let i = lowerBound(beatTimes, songT) - 1
  if (i < 0) i = 0
  if (i >= beatTimes.length - 1) i = beatTimes.length - 2
  const t0 = beatTimes[i]
  const t1 = beatTimes[i + 1]
  const frac = (songT - t0) / Math.max(1e-6, t1 - t0)
  const beatInBar = i % 4
  const near = (v: number) => Math.abs(frac - v) < 0.12
  if (near(0)) {
    if (beatInBar === 0) return 4
    if (beatInBar === 2) return 3
    return 2
  }
  if (near(0.5)) return 1
  void bpm
  return 0
}

/** index of the first element > x (Python's bisect_right) */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface HitAnim { lane: number; x: number; y: number; t0: number; judgment: string; color: number }
interface Spark { x: number; y: number; vx: number; vy: number; age: number; life: number; col: number }
interface Shard { x: number; y: number; vx: number; vy: number; spin: number; rot: number; age: number; life: number; col: number }
interface Stamp { kind: string; x: number; y: number; t0: number; extra: string }
interface Shockwave { t0: number; x: number; y: number; col: number; dur: number; r0: number; r1: number; w0: number; a0: number }
interface Flying { kind: 'glyph' | 'petal'; ch: string; lane: number; wordId: number; charIdx: number; x0: number; y0: number; x1: number; y1: number; t0: number; dur: number }

interface OrbNode extends Container {
  halo: Sprite
  ring: Sprite
  body: Sprite
  glyph: BitmapText
  petal: Sprite
  tail: Sprite
}

export class HighwayRenderer {
  private L: Layout
  private readonly song: Song
  private readonly rhythm: RhythmManager
  readonly stage = new Container()

  readonly approach: number
  /** design px per second */
  speed: number
  private readonly beatDur: number
  private readonly barDur: number
  private readonly leadIn: number
  private beatTimesChart: number[]

  private tex: TextureCache

  // layers, back to front
  /** everything behind the notes: palette, drift, parallax, portals, blackouts */
  private bgStage!: Stage
  /** where the hit circles are, and the swap when the chart moves them */
  readonly field = new Playfield()
  /** the swap whose pinch has already fired its shockwave */
  private pinched = -99
  /** the white lift on a drop — the stage owns every other background pixel */
  private bg = new Graphics()
  private ribbons = new Container()
  private dustLayer = new Container()
  private rowLayer = new Graphics()
  private comboGhost: BitmapText
  private connectors = new Graphics()
  private slotLine = new Graphics()
  /** held anchors: the lit lane, the sinking bar and the key on the ring */
  private anchorLayer = new Container()
  private anchorGfx = new Graphics()
  private anchorKeys: BitmapText[] = []
  private anchorLabels: BitmapText[] = []
  private ringLayer = new Container()
  private noteLayer = new Container()
  private fxLayer = new Container()
  private waveLayer = new Graphics()
  private nokiLayer = new Container()
  private wordLayer = new Container()
  private hudLayer = new Container()
  /** the veil drawn while Noki naps; sits under the notes */
  private napVeil = new Graphics()

  // per-event geometry, by event uid
  private geom = new Map<number, { lane: number; x: number; w: number }>()

  // transient effects
  private hitAnims: HitAnim[] = []
  private sparks: Spark[] = []
  private shards: Shard[] = []
  private stamps: Stamp[] = []
  private flying: Flying[] = []
  private shockwaves: Shockwave[] = []
  private dust: { x: number; y: number; vy: number; r: number; a: number }[] = []

  private ringHitT = [-9, -9, -9, -9]
  private ringMissT = [-9, -9, -9, -9]
  private slipFlash: [number, string][] = [[-9, ''], [-9, ''], [-9, ''], [-9, '']]
  private lineFlashT = -9

  // meta state
  lives = C.LIVES
  private streak = 0
  private napUntil = -9
  private rushCharge = 0
  private rushUntil = -9
  private comboTier = 1
  private scoreShown = 0
  private lastBeatIdx = -1
  private energyS = 0.4
  private wordFlashT = -9
  private wordFlash: [string, boolean] | null = null
  private milestone: [number, number] | null = null
  private dropT = -9
  private dropSize = 1
  private drops: [number, string][] = []
  private dropI = 0

  // chart section map, in chart time
  private barVibes: string[] = []
  private barT: number[] = []
  private phrases: [number, number, string][] = []
  private layerPlan: [number, number, string, string, string][] = []
  private duets: [number, number, string][] = []

  // anchors on screen
  /** per-hand heat through a duet: three clean notes each locks it in */
  private heat = [0, 0]
  private lockT = -9
  private duetLayer = new Graphics()
  private anchorsOn = new Map<number, LiveEvent>()
  private anchorFades = new Map<number, [number, string]>()

  private orbPool: OrbNode[] = []
  private orbsInUse: OrbNode[] = []
  private fxPool: Sprite[] = []
  private fxInUse: Sprite[] = []
  private stampPool: BitmapText[] = []
  private stampsInUse: BitmapText[] = []

  // word block nodes
  private wordGlyphs: BitmapText[] = []
  private wordCaret = new Graphics()
  private queueRows: BitmapText[] = []
  private flyGlyphs: BitmapText[] = []

  // HUD nodes
  private scoreText: BitmapText
  private multText: BitmapText
  private accText: BitmapText
  private titleText: BitmapText
  private tagText: BitmapText
  private duetText: BitmapText
  private lockedText: BitmapText
  private duetMarkGfx = new Graphics()
  private milestoneText: BitmapText
  private milestoneLabel: BitmapText
  private hudGfx = new Graphics()
  private rng = mulberry32(7)
  private showNoki = true
  private noki: Sprite | null = null
  private nokiSheet: { frames: number; w: number; h: number } | null = null
  private nokiFrames: Texture[] = []
  private hurtT = -9
  private wordFlashGlyphs: BitmapText[] = []

  constructor(
    layout: Layout,
    song: Song,
    rhythm: RhythmManager,
    readonly difficulty: string,
    renderer: Renderer,
    settings: Record<string, unknown> = {},
    private readonly title = '',
  ) {
    this.L = layout
    this.song = song
    this.rhythm = rhythm
    this.tex = new TextureCache(renderer)

    this.showNoki = (settings.noki_placement ?? 'line') !== 'hidden'
    const speedMult = Math.max(0.25, Number(settings.speed_mult ?? 1))
    this.approach = (C.APPROACH_S[difficulty] ?? 1.6) / speedMult
    this.speed = layout.fallPx / this.approach
    this.beatDur = song.bpm ? 60 / song.bpm : 0.5
    this.barDur = this.beatDur * 4
    this.leadIn = rhythm.leadIn
    this.beatTimesChart = song.beat_times.map((b) => b + this.leadIn)

    this.comboGhost = label('display', 240)
    this.comboGhost.alpha = 0.07
    this.scoreText = label('display', 48)
    this.scoreText.anchor.set(0, 0.5)
    this.multText = label('display', 30)
    this.multText.anchor.set(0, 0.5)
    this.multText.tint = KB.GOLD
    this.accText = label('display', 40)
    this.accText.anchor.set(1, 0.5)
    this.titleText = label('display', 40, title)
    this.tagText = label('stamp', 18)
    this.tagText.tint = KB.GOLD
    this.duetText = label('stamp', 24, 'DUET')
    this.duetText.tint = KB.GOLD
    this.lockedText = label('stamp', 40, 'LOCKED IN')
    this.lockedText.tint = KB.GOLD
    this.milestoneText = label('display', 120)
    this.milestoneText.tint = KB.GOLD
    this.milestoneLabel = label('stamp', 26, 'COMBO')
    this.milestoneLabel.tint = KB.GOLD

    this.bgStage = new Stage(layout, this.tex)
    this.stage.addChild(this.bgStage.container)
    this.anchorLayer.addChild(this.anchorGfx)
    for (let i = 0; i < 4; i++) {
      const k = label('display', 54)
      const b = label('stamp', 16, 'HOLD')
      k.visible = false
      b.visible = false
      this.anchorKeys.push(k)
      this.anchorLabels.push(b)
      this.anchorLayer.addChild(k, b)
    }
    for (const layer of [this.bg, this.ribbons, this.dustLayer, this.rowLayer, this.comboGhost,
                         this.duetLayer, this.connectors, this.slotLine, this.napVeil,
                         this.anchorLayer, this.ringLayer, this.noteLayer,
                         this.fxLayer, this.waveLayer, this.nokiLayer, this.wordLayer,
                         this.hudLayer]) {
      this.stage.addChild(layer)
    }
    this.hudLayer.addChild(this.hudGfx, this.scoreText, this.multText, this.accText,
                           this.titleText, this.tagText, this.duetMarkGfx, this.duetText,
                           this.lockedText)
    this.waveLayer.addChild(this.milestoneText, this.milestoneLabel)
    this.wordLayer.addChild(this.wordCaret)

    this.prepEvents()
    this.buildRibbons()
    this.buildRings()
    this.buildDust()
    this.warmTextures()
  }

  /**
   * Bake every texture the draw path will ask for, now rather than mid-song.
   *
   * `generateTexture` is not cheap, and the shapes here are only built on first
   * use: the star on the first hit, the shard pixel on the first miss, the petal
   * on the first word.  That put a 50–80 ms frame somewhere in the first few
   * seconds of a run, about one frame in three hundred.  The pygame build warms
   * its caches at load for the same reason (`_warm_caches`).
   */
  private warmTextures(): void {
    const L = this.L
    const orbR = L.S(L.orbR)
    this.tex.body(orbR)
    this.tex.body(8)
    this.tex.ring(orbR + Math.max(2, L.S(5)), Math.max(2, L.S(3)))
    this.tex.halo()
    this.tex.glow()
    this.tex.radial(512, 0, 1.4)
    this.tex.petal(L.S(16))
    this.tex.capsule(16)
    this.tex.annulus(L.S(L.slotRingR), Math.max(2, L.S(5)))
    this.tex.star(64)
    this.tex.pixel
  }

  // ── setup ────────────────────────────────────────────────────────────────
  /** Lane, x and weight per playable event (design units). */
  private prepEvents(): void {
    this.geom.clear()
    for (const ev of this.rhythm.beatMap) {
      if (ev.is_rest || !ev.char) continue
      const lane = ev.lane >= 0 ? ev.lane : KB.laneOf(ev.char)
      ev.lane = lane
      // the resting x; `drawNotes` asks the playfield for the live one, which
      // differs only while the circles are rearranging
      const x = this.L.laneCenter(lane)
      if (ev.weight < 0) {
        ev.weight = weightOfTime(ev.timestamp - this.leadIn, this.song.beat_times, this.song.bpm)
      }
      this.geom.set(ev._uid, { lane, x, w: ev.weight })
    }
  }

  /** The chart's section map: per-bar vibes and phrase kinds, shifted to chart time. */
  setSections(meta: ChartMeta): void {
    const li = this.leadIn
    this.barVibes = [...(meta.bar_vibes ?? [])]
    this.barT = (meta.bar_start ?? []).map((t) => t + li)
    this.phrases = (meta.phrases ?? []).map((p) => [p[0] + li, p[1] + li, String(p[2])])
    this.layerPlan = (meta.layers ?? []).map((p) => [p[0] + li, p[1] + li, String(p[2]), String(p[3]), String(p[4])])
    this.drops = findDrops(meta.bar_energy ?? [], this.barVibes, this.barT)
    this.field.setStages((meta.stages ?? []) as [number, number, string][], this.leadIn)
    this.dropI = 0
  }

  setDuets(spans: ChartMeta['duets'] = []): void {
    this.duets = (spans ?? []).map((s) => [s[0] + this.leadIn, s[1] + this.leadIn, String(s[2])])
  }

  /** The voice the next unhit duet note belongs to, or -1 outside a duet. */
  private activeVoice(t: number): number {
    for (const ev of this.visibleEvents(t)) {
      if (!ev.hit && ev.voice >= 0 && ev.timestamp >= t - 0.05) return ev.voice
    }
    return -1
  }

  private duetAt(t: number): [number, number, string] | null {
    for (const d of this.duets) if (d[0] - 2 * this.barDur <= t && t < d[1]) return d
    return null
  }

  /** 0..1 from the vibe of the bar under `t`, crossfading over the bar's last beat. */
  private energyAt(t: number): number {
    if (!this.barT.length || !this.barVibes.length) return 0.45
    let i = lowerBound(this.barT, t) - 1
    if (i < 0) return ENERGY[this.barVibes[0]] ?? 0.4
    i = Math.min(i, this.barVibes.length - 1)
    let cur = ENERGY[this.barVibes[i]] ?? 0.4
    if (i + 1 < this.barVibes.length && i + 1 < this.barT.length) {
      const nxt = ENERGY[this.barVibes[i + 1]] ?? cur
      const k = (t - (this.barT[i + 1] - this.beatDur)) / Math.max(1e-3, this.beatDur)
      if (k > 0) cur = cur + (nxt - cur) * Math.min(1, k)
    }
    return cur
  }

  private layerAt(t: number) {
    for (const p of this.layerPlan) if (p[0] <= t && t < p[1]) return p
    return null
  }

  /** the vibe of the bar under `t` — sustain, groove, drive or burst */
  private vibeAt(t: number): string {
    if (!this.barT.length || !this.barVibes.length) return ''
    let i = 0
    while (i + 1 < this.barT.length && this.barT[i + 1] <= t) i += 1
    return this.barVibes[Math.min(i, this.barVibes.length - 1)] ?? ''
  }

  private phraseAt(t: number) {
    for (let i = 0; i < this.phrases.length; i++) {
      const [t0, t1, kind] = this.phrases[i]
      if (t0 <= t && t < t1) return { i, t0, t1, kind }
    }
    return null
  }

  setLayout(layout: Layout): void {
    this.L = layout
    this.speed = layout.fallPx / this.approach
    this.tex.clear()
    this.bgStage.setLayout(layout)
    this.bgStage.rebuild()
    this.visibleCacheT = NaN
    this.prepEvents()
    this.ribbons.removeChildren().forEach((c) => c.destroy())
    this.ringLayer.removeChildren().forEach((c) => c.destroy())
    this.dustLayer.removeChildren().forEach((c) => c.destroy())
    for (const o of [...this.orbPool, ...this.orbsInUse]) o.destroy({ children: true })
    this.orbPool = []
    this.orbsInUse = []
    this.noteLayer.removeChildren()
    this.buildRibbons()
    this.buildRings()
    this.buildDust()
    this.warmTextures()
  }

  private ribbonSprites: Sprite[] = []
  private buildRibbons(): void {
    this.ribbonSprites = []
    const L = this.L
    // two soft vertical bands either side of the highway, breathing with the bar
    for (let k = 0; k < 2; k++) {
      const s = new Sprite(this.tex.glow())
      s.anchor.set(0.5)
      s.width = L.S(560)
      s.height = L.winH * 1.3
      s.x = L.X(k === 0 ? HIGHWAY_X0 - 40 : HIGHWAY_X0 + 4 * LANE_W + 40)
      s.y = L.winH * 0.5
      s.blendMode = 'add'
      s.alpha = 0.1
      this.ribbons.addChild(s)
      this.ribbonSprites.push(s)
    }
  }

  private ringSprites: Sprite[] = []
  private buildRings(): void {
    this.ringSprites = []
    const L = this.L
    for (let lane = 0; lane < 4; lane++) {
      const s = new Sprite(this.tex.annulus(L.S(L.slotRingR), Math.max(2, L.S(5))))
      s.anchor.set(0.5)
      s.x = L.X(L.laneCenter(lane))
      s.y = L.Y(L.slotY)
      s.tint = KB.laneColor(lane)
      this.ringLayer.addChild(s)
      this.ringSprites.push(s)
    }
  }

  private buildDust(): void {
    this.dust = []
    for (let i = 0; i < 26; i++) {
      this.dust.push({
        x: this.rng() * 1920, y: this.rng() * 1080,
        vy: -8 - this.rng() * 22, r: 1.5 + this.rng() * 2.5, a: 0.05 + this.rng() * 0.12,
      })
    }
  }

  // ── phase ────────────────────────────────────────────────────────────────
  /** (beat index, 0..1 through the beat) */
  private beatPhase(t: number): [number, number] {
    const bt = this.beatTimesChart
    if (!bt.length) return [-1, 0]
    const i = clamp(lowerBound(bt, t) - 1, 0, bt.length - 2)
    if (i < 0) return [-1, 0]
    const dur = Math.max(1e-3, bt[i + 1] - bt[i])
    return [i, clamp((t - bt[i]) / dur, 0, 1)]
  }

  /** 0..1 through the current bar */
  private barPhase(t: number): number {
    const [i, p] = this.beatPhase(t)
    if (i < 0) return 0
    return ((i % 4) + p) / 4
  }

  private noteY(ev: LiveEvent, t: number): number {
    return this.L.slotY - (ev.timestamp - t) * this.speed
  }

  private visibleCache: LiveEvent[] = []
  private visibleCacheT = NaN

  /**
   * The notes on screen.  Four callers want this each frame (the connectors, the
   * slot rings, the notes themselves and the duet voice), so it is computed once
   * and reused: a fresh array per caller is four allocations a frame at 60 Hz,
   * which is the kind of garbage that shows up as an occasional long frame.
   */
  private visibleEvents(t: number): LiveEvent[] {
    if (t === this.visibleCacheT) return this.visibleCache
    const bm = this.rhythm.beatMap
    const start = Math.max(0, this.rhythm.charEventIdx - 12)
    const out: LiveEvent[] = []
    const tMax = t + this.approach + 0.15
    for (let i = start; i < bm.length; i++) {
      const ev = bm[i]
      if (ev.is_rest || !ev.char) continue
      if (ev.timestamp > tMax) break
      out.push(ev)
    }
    this.visibleCache = out
    this.visibleCacheT = t
    return out
  }

  private evXY(ev: LiveEvent): [number, number, number] {
    const g = this.geom.get(ev._uid)
    if (!g) return [0, this.L.laneCenter(0), this.L.slotY]
    return [g.lane, g.x, this.L.slotY]
  }

  // ── events from the session ──────────────────────────────────────────────
  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const [lane, x, y] = this.evXY(ev)
    const rushNow = this.rushActive(t)
    const col = rushNow ? KB.GOLD : KB.laneColor(lane)
    this.hitAnims.push({ lane, x, y, t0: t, judgment, color: col })
    this.streak += 1
    // a petal grows back every 25 notes without a miss
    if (this.streak % C.LIFE_REGROW_STREAK === 0 && this.lives < C.LIVES && t >= this.napUntil) {
      this.lives += 1
    }
    if (judgment === 'perfect') {
      this.spawnSparks(x, y, 5, col)
      this.rushCharge = Math.min(1, this.rushCharge + 0.01)
    } else if (judgment === 'good') {
      this.spawnSparks(x, y, 3, col)
    }
    this.ringHitT[lane] = t
    this.stamp(judgment, x, y, offsetMs, t)
    if (ev.voice >= 0) {
      // both hands three notes deep locks the duet in
      this.heat[ev.voice] = Math.min(3, this.heat[ev.voice] + 1)
      if (this.heat[0] >= 3 && this.heat[1] >= 3 && this.lockT < 0) {
        this.lockT = t
        this.spawnSparks(HIGHWAY_CX, this.L.slotY - 200, 24, KB.GOLD, 700)
        this.rushCharge = Math.min(1, this.rushCharge + 0.25)
      }
    } else if (ev.section_kind !== 'grace') {
      // the main note carries the letter up; a duet note has no word to carry it to
      this.flyGlyph(ev, x, y, t)
    }
    const combo = this.rhythm.combo
    this.comboTier = 1 + (combo >= 10 ? 1 : 0) + (combo >= 25 ? 1 : 0) + (combo >= 50 ? 1 : 0)
    if (MILESTONES.includes(combo)) {
      this.milestone = [combo, t]
      const [cx, cy] = this.L.COMBO_POS
      this.spawnSparks(HIGHWAY_CX, cy, 16, rushNow ? KB.GOLD : col, 600)
      this.shockwaves.push({ t0: t, x: cx, y: cy, col: KB.GOLD, dur: 0.5, r0: 80, r1: 340, w0: 5, a0: 0.5 })
    }
  }

  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const [lane, x, y] = this.evXY(ev)
    this.ringHitT[lane] = t
    this.hitAnims.push({ lane, x, y, t0: t, judgment, color: KB.GOLD })
    this.stamp(judgment, x, y, offsetMs, t)
  }

  onHoldComplete(ev: LiveEvent, judgment: string, t: number): void {
    const [lane, x, y] = this.evXY(ev)
    this.ringHitT[lane] = t
    this.spawnSparks(x, y, 8, KB.GOLD)
    this.stamp(judgment, x, y, 0, t)
  }

  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const [lane] = this.evXY(ev)
    this.anchorsOn.set(lane, ev)
    this.onHoldStart(ev, judgment, offsetMs, t)
  }

  onAnchorComplete(ev: LiveEvent, judgment: string, t: number): void {
    const [lane] = this.evXY(ev)
    this.anchorsOn.delete(lane)
    this.anchorFades.set(lane, [t, 'done'])
    this.onHoldComplete(ev, judgment, t)
  }

  onAnchorBreak(ev: LiveEvent, t: number): void {
    const [lane] = this.evXY(ev)
    this.anchorsOn.delete(lane)
    this.anchorFades.set(lane, [t, 'broke'])
    this.onMiss(ev, t)
  }

  onMiss(ev: LiveEvent, t: number): void {
    const [lane, x, y] = this.evXY(ev)
    this.ringMissT[lane] = t
    this.streak = 0
    this.spawnShards(x, y, lane, 6, KB.MISS_RED)
    this.stamp('miss', x, y, 0, t)
    this.comboTier = 1
    this.hurtT = t
    if (t >= this.napUntil && this.lives > 0) {
      this.lives -= 1
      if (this.lives === 0) this.napUntil = t + C.NAP_BARS * this.barDur
    }
  }

  onSlip(ev: LiveEvent, pressed: string, t: number): void {
    const lane = KB.laneOf(pressed)
    this.slipFlash[lane] = [t, pressed]
    const [, x, y] = this.evXY(ev)
    this.stamp('slip', x, y, 0, t, pressed.toUpperCase())
  }

  onTooEarly(ev: LiveEvent, t: number): void {
    const [lane] = this.evXY(ev)
    this.ringMissT[lane] = t - 0.2
  }

  onWordComplete(word: string, clean: boolean, t: number): void {
    this.wordFlash = [word, clean]
    this.wordFlashT = t
    if (clean) this.rushCharge = Math.min(1, this.rushCharge + C.RUSH_CHARGE_PER_CLEAN_WORD)
  }

  tryRush(t: number): boolean {
    if (this.rushCharge < C.RUSH_THRESHOLD || this.rushActive(t)) return false
    this.rushUntil = t + C.RUSH_BARS * this.barDur
    this.rushCharge = 0
    this.rhythm.rushActive = true
    this.shockwaves.push({ t0: t, x: HIGHWAY_CX, y: this.L.slotY, col: KB.GOLD, dur: 0.7, r0: 40, r1: 900, w0: 8, a0: 0.6 })
    return true
  }

  rushActive(t: number): boolean { return t < this.rushUntil }

  get failed(): boolean { return false }

  // ── effect spawners ──────────────────────────────────────────────────────
  private spawnSparks(x: number, y: number, n: number, col: number, spread = 380): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2
      const v = spread * (0.4 + this.rng() * 0.6)
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, age: 0, life: 0.3 + this.rng() * 0.25, col })
    }
  }

  private spawnShards(x: number, y: number, lane: number, n: number, col: number): void {
    void lane
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2
      const v = 240 * (0.3 + this.rng() * 0.7)
      this.shards.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120,
        spin: (this.rng() - 0.5) * 12, rot: this.rng() * Math.PI * 2,
        age: 0, life: 0.45 + this.rng() * 0.25, col,
      })
    }
  }

  private stamp(kind: string, x: number, y: number, offsetMs: number, t: number, extra = ''): void {
    let label = STAMP_TEXT[kind] ?? kind.toUpperCase()
    if (extra) label = extra
    else if (kind !== 'miss' && Math.abs(offsetMs) > 1) {
      label = `${label} ${offsetMs > 0 ? '+' : ''}${offsetMs.toFixed(0)}`
    }
    this.stamps.push({ kind, x, y, t0: t, extra: label })
    if (this.stamps.length > 12) this.stamps.shift()
  }

  private flyGlyph(ev: LiveEvent, x: number, y: number, t: number): void {
    this.flying.push({
      kind: 'glyph', ch: ev.char, lane: ev.lane, wordId: ev.word_id, charIdx: ev.char_idx,
      x0: x, y0: y, x1: x, y1: this.L.wordY, t0: t, dur: 0.28,
    })
  }

  private drop(t: number, size: string): void {
    this.dropT = t
    this.dropSize = size === 'large' ? 1 : 0.55
    const big = size === 'large'
    // straight to black on the big ones, then bloom back into the chorus
    this.bgStage.blackout(t, big ? 1 : 0.45)
    this.shockwaves.push({
      t0: t, x: HIGHWAY_CX, y: this.L.slotY - 260, col: WHITE,
      dur: big ? 0.85 : 0.55, r0: 60, r1: big ? 1400 : 700,
      w0: big ? 10 : 6, a0: big ? 0.5 : 0.3,
    })
  }

  // ── the frame ────────────────────────────────────────────────────────────
  draw(t: number, dt: number): void {
    const L = this.L
    const rush = this.rushActive(t)
    if (!rush && this.rhythm.rushActive) this.rhythm.rushActive = false

    const [beatI, beatP] = this.beatPhase(t)
    if (beatI !== this.lastBeatIdx) {
      this.lastBeatIdx = beatI
      this.lineFlashT = t
    }
    const barP = this.barPhase(t)

    // section energy, smoothed, and the drop when a phrase jumps into a burst
    const eTarget = this.energyAt(t)
    this.energyS += (eTarget - this.energyS) * Math.min(1, 3 * dt)
    while (this.dropI < this.drops.length && t >= this.drops[this.dropI][0]) {
      const [tDrop, size] = this.drops[this.dropI]
      this.dropI += 1
      // never fire one we jumped past
      if (t - tDrop < 0.25) this.drop(t - tDrop < 0.05 ? tDrop : t, size)
    }

    this.field.update(t)
    // the circles meeting in the middle is the moment the rules change: mark it
    // the way every other impact on this screen is marked
    if (this.field.atPinch(t) && t - this.pinched > SWAP_SECONDS) {
      this.pinched = t
      this.shockwaves.push({
        t0: t, x: HIGHWAY_CX, y: this.L.slotY, col: WHITE,
        dur: 0.6, r0: 30, r1: 900, w0: 8, a0: 0.45,
      })
    }

    const duet = this.duetAt(t)
    // the phrase kind is the mode; a duet outranks it, being a whole-screen thing
    const ph = this.phraseAt(t)
    this.bgStage.setKind(duet !== null ? 'duet' : (ph?.kind ?? 'words'), t, this.vibeAt(t))
    const beatPulse = Math.max(0, 1 - (t - this.lineFlashT) / 0.35)
    this.drawBackground(t, dt, beatPulse, barP)
    this.drawRibbons(t, barP, beatI)
    this.drawDust(dt)
    this.drawDuetStrip(t, duet)
    this.drawBeatRows(t)
    this.drawCombo()
    this.drawConnectors(t, rush)
    this.drawSlotLine(t, barP, rush)
    this.drawAnchorLane(t)
    this.drawRings(t, rush)
    this.drawNotes(t, beatP, rush)
    this.drawEffects(t, dt)
    this.drawShockwaves(t)
    if (duet !== null && t >= duet[0]) this.drawDuetBand(t, duet)
    else this.drawWordBlock(t, rush)
    this.drawNoki(t)
    this.drawHud(t, dt, rush)
    this.drawDuetMark(t, duet)
    // the nap: a light veil while Noki is down, so the highway reads as resting
    // while the notes stay crisp
    this.napVeil.clear()
    if (t < this.napUntil) {
      this.napVeil.rect(0, 0, L.winW, L.winH).fill({ color: 0x000000, alpha: 0.19 })
    }
    // the camera: a loud phrase shakes on the beat and a drop kicks it.  Applied
    // to the root, so the HUD moves with the highway — a shake that leaves the
    // score pinned reads as a bug rather than a hit.
    const [shx, shy] = this.bgStage.shake(t, this.energyS, beatPulse)
    this.stage.x = L.S(shx)
    this.stage.y = L.S(shy)

    if (this.lives === 0 && t >= this.napUntil) this.lives = 1
  }

  private drawBackground(t: number, dt: number, beatPulse: number, barP: number): void {
    const L = this.L
    this.bgStage.update(t, dt, this.energyS, beatPulse, barP)

    // the drop flash: a full-screen lift, over the stage and under everything else
    const g = this.bg
    g.clear()
    const dropAge = t - this.dropT
    if (dropAge >= 0 && dropAge < 0.45) {
      const a = (1 - dropAge / 0.45) ** 2 * 0.35 * this.dropSize
      g.rect(0, 0, L.winW, L.winH).fill({ color: 0xffffff, alpha: a })
    }
  }

  private drawRibbons(t: number, barP: number, beatI: number): void {
    const L = this.L
    for (let k = 0; k < this.ribbonSprites.length; k++) {
      const s = this.ribbonSprites[k]
      const off = L.S(24 + 36 * this.energyS) * Math.sin(Math.PI * 2 * barP + k * Math.PI)
      s.y = L.winH * 0.5 + off
      // the pulse was eight baked alpha levels in the pygame build; here it is the alpha
      const pulse = beatI % 4 === 0 ? Math.max(0, 1 - (t - this.lineFlashT) / 0.35) : 0
      s.alpha = 0.07 + 0.10 * pulse + 0.05 * this.energyS
      s.tint = mixColor(0x6a5cff, KB.GOLD, this.energyS)
    }
  }

  private drawDust(dt: number): void {
    const L = this.L
    const g = this.rowLayer
    void g
    if (!this.dustLayer.children.length) {
      for (let i = 0; i < this.dust.length; i++) {
        const s = new Sprite(this.tex.body(8))
        s.anchor.set(0.5)
        s.blendMode = 'add'
        this.dustLayer.addChild(s)
      }
    }
    for (let i = 0; i < this.dust.length; i++) {
      const d = this.dust[i]
      d.y += d.vy * dt
      if (d.y < -20) { d.y = 1100; d.x = this.rng() * 1920 }
      const s = this.dustLayer.children[i] as Sprite
      s.x = L.X(d.x)
      s.y = L.Y(d.y)
      s.width = s.height = L.S(d.r * 2)
      s.alpha = d.a * (0.6 + 0.6 * this.energyS)
    }
  }

  private drawBeatRows(t: number): void {
    const L = this.L
    const g = this.rowLayer
    g.clear()
    const bt = this.beatTimesChart
    if (!bt.length) return
    const slotY = L.slotY
    const lo = Math.max(0, lowerBound(bt, t - 0.4) - 1)
    const hi = lowerBound(bt, t + this.approach + 0.2)
    const e = 0.6 + 0.6 * this.energyS
    for (let i = lo; i < hi; i++) {
      const y = slotY - (bt[i] - t) * this.speed
      if (y < L.top || y > slotY) continue
      const yy = L.Y(y)
      if (i % 4 === 0) {
        g.rect(0, yy, L.winW, Math.max(1, L.S(2))).fill({ color: WHITE, alpha: Math.min(0.7, 0.42 * e) })
      } else {
        g.rect(0, yy, L.winW, 1).fill({ color: WHITE, alpha: Math.min(0.45, 0.22 * e) })
      }
    }
  }

  private drawCombo(): void {
    const combo = this.rhythm.combo
    this.comboGhost.visible = combo >= 5
    if (combo < 5) return
    const L = this.L
    if (this.comboGhost.text !== String(combo)) this.comboGhost.text = String(combo)
    this.comboGhost.scale.set(L.S(240) / 96)
    this.comboGhost.x = L.X(L.COMBO_POS[0])
    this.comboGhost.y = L.Y(L.COMBO_POS[1])
  }

  private drawConnectors(t: number, rush: boolean): void {
    const L = this.L
    const g = this.connectors
    g.clear()
    const evs = this.visibleEvents(t)
    let prev: LiveEvent | null = null
    const missed = (e: LiveEvent) => !e.hit && t > e.timestamp + this.rhythm.okWindowFor(e)
    for (const ev of evs) {
      let col = WHITE
      if (rush) col = KB.GOLD
      else if (ev.voice >= 0) col = KB.laneColor(ev.voice === 0 ? 1 : 2)
      if (prev !== null && prev.word_id === ev.word_id && (!prev.hit || !ev.hit)
          && !missed(prev) && !missed(ev)) {
        let y0 = this.noteY(prev, t)
        const y1 = this.noteY(ev, t)
        if (prev.hit) y0 = L.slotY
        const x0 = this.field.xOf(prev.char, t)
        const x1 = this.field.xOf(ev.char, t)
        const p0x = L.X(x0), p0y = L.Y(y0), p1x = L.X(x1), p1y = L.Y(y1)
        g.moveTo(p0x, p0y).lineTo(p1x, p1y)
          .stroke({ width: Math.max(3, L.S(9)), color: col, alpha: 0.2, cap: 'round' })
        g.moveTo(p0x, p0y).lineTo(p1x, p1y)
          .stroke({ width: Math.max(2, L.S(3)), color: col, alpha: 0.55, cap: 'round' })
      }
      prev = ev
    }
  }

  private drawSlotLine(t: number, barP: number, rush: boolean): void {
    const L = this.L
    const g = this.slotLine
    g.clear()
    const y = L.Y(L.slotY)
    const lw = Math.max(3, L.S(SLOT_LINE_W))
    // the soft strip under the line
    g.rect(0, y - L.S(40), L.winW, L.S(80)).fill({ color: rush ? KB.GOLD : 0x8aa0ff, alpha: 0.07 })
    const flash = Math.max(0, 1 - (t - this.lineFlashT) / 0.25)
    const base = 215 + Math.round(40 * flash)
    const col = rush ? KB.GOLD : ((base << 16) | (base << 8) | base)
    g.rect(0, y - Math.floor(lw / 2), L.winW, lw).fill({ color: col })
    // measure sweep across the highway, a rounded bright bar riding the line
    const sx = L.X(HIGHWAY_X0 + barP * LANE_W * 4)
    const sw = L.S(80)
    const sh = lw + Math.max(2, L.S(3))
    g.roundRect(sx, y - sh / 2, sw, sh, sh / 2).fill({ color: WHITE, alpha: 0.9 })
  }

  /**
   * Every held lane glows, a bar sinks from the top as the hold runs down, and the
   * held key sits big on the slot ring; the lane flashes gold when a hold completes
   * and red when it breaks.  A chord is simply two lanes at once.
   *
   * `game/highway.py:_draw_anchor_lane` does this on the desktop.  The port kept
   * the bookkeeping — `anchorsOn`, `anchorFades` — and never drew any of it, so a
   * held anchor vanished the instant it was pressed and stayed gone for the whole
   * hold.  Duo phrases put far more of these on screen than they used to.
   */
  private drawAnchorLane(t: number): void {
    const L = this.L
    const g = this.anchorGfx
    g.clear()
    for (const k of this.anchorKeys) k.visible = false
    for (const b of this.anchorLabels) b.visible = false

    const top = L.Y(L.top)
    const bottom = L.Y(L.slotY)
    const laneW = L.S(LANE_W)

    // fades first, under the live holds
    for (const [lane, [t0, kind]] of [...this.anchorFades]) {
      const age = t - t0
      const dur = kind === 'broke' ? 0.4 : 0.5
      if (age >= dur) { this.anchorFades.delete(lane); continue }
      const col = kind === 'broke' ? KB.MISS_RED : KB.GOLD
      g.rect(L.X(L.laneX0(lane)), top, laneW, bottom - top)
        .fill({ color: col, alpha: 0.22 * (1 - age / dur) })
    }

    let slot = 0
    for (const [lane, ev] of this.anchorsOn) {
      const col = this.laneCol(lane)
      const prog = Math.max(0, Math.min(1, (t - ev.timestamp) / Math.max(1e-3, ev.hold_duration)))
      const cx = L.X(L.laneCenter(lane))
      g.rect(L.X(L.laneX0(lane)), top, laneW, bottom - top).fill({ color: col, alpha: 0.13 })
      // the bar shrinks toward the slot line as the hold runs out
      const h = (bottom - top) * (1 - prog)
      const bw = L.S(22)
      g.roundRect(cx - bw / 2, bottom - h, bw, h, bw / 2).fill({ color: col, alpha: 0.55 })
      const pulse = 0.5 + 0.5 * (1 - this.beatPhase(t)[1])
      g.circle(cx, bottom, L.S(L.slotRingR + 10 + 6 * pulse))
        .stroke({ width: Math.max(2, L.S(3)), color: col, alpha: 0.5 + 0.4 * pulse })

      if (slot < this.anchorKeys.length) {
        const key = this.anchorKeys[slot]
        key.text = ev.char.toUpperCase()
        key.scale.set(L.S(54) / 96)
        key.x = cx
        key.y = bottom
        key.visible = true
        const lbl = this.anchorLabels[slot]
        lbl.tint = col
        lbl.scale.set(L.S(16) / 96)
        lbl.x = cx
        lbl.y = bottom + L.S(L.slotRingR + 26)
        lbl.visible = true
        slot += 1
      }
    }
  }

  /** the lane's colour, or white while the stage has taken the colours away */
  private laneCol(lane: number): number {
    return this.bgStage.mono ? 0xffffff : KB.laneColor(lane)
  }

  private drawRings(t: number, rush: boolean): void {
    const L = this.L
    const visible = this.visibleEvents(t)
    const circles = this.field.circles(t)
    for (let i = 0; i < this.ringSprites.length; i++) {
      const s = this.ringSprites[i]
      const c = circles[i]
      if (c === undefined) { s.visible = false; continue }
      s.visible = true
      // a circle is "armed" when a note that belongs to it is nearly here
      let armed = false
      for (const ev of visible) {
        if (ev.hit) continue
        if (slotOf(ev.char, c.mode) !== c.slot) continue
        if (ev.timestamp - t >= 0 && ev.timestamp - t < 0.3) { armed = true; break }
      }
      // the hit and miss flashes are still tracked per hand-zone lane, which is
      // what the judgment knows about; in another shape they light the circle the
      // character now lives in
      const lane = c.mode === 'lanes' ? c.slot : -1
      const hitAge = lane >= 0 ? t - this.ringHitT[lane] : 99
      const missAge = lane >= 0 ? t - this.ringMissT[lane] : 99
      let alpha = armed ? 1 : 0.65
      let scale = 1
      let color = this.laneCol(c.slot)
      if (hitAge >= 0 && hitAge < 0.16) {
        scale = 1 + 0.25 * Math.sin((Math.PI * hitAge) / 0.16)
        alpha = 1
      }
      if (missAge >= 0 && missAge < 0.3) color = KB.MISS_RED
      if (rush) color = KB.GOLD
      s.x = L.X(c.x)
      s.y = L.Y(L.slotY)
      s.alpha = alpha * c.alpha
      s.tint = color
      s.scale.set(scale * c.scale)
    }
  }

  // ── notes ────────────────────────────────────────────────────────────────
  private acquireOrb(): OrbNode {
    const o = this.orbPool.pop()
    if (o) { o.visible = true; this.orbsInUse.push(o); return o }
    const node = new Container() as OrbNode
    node.halo = new Sprite(); node.halo.anchor.set(0.5); node.halo.blendMode = 'add'
    node.tail = new Sprite(); node.tail.anchor.set(0.5, 1)
    node.ring = new Sprite(); node.ring.anchor.set(0.5)
    node.body = new Sprite(); node.body.anchor.set(0.5)
    node.glyph = label('display', 40)
    node.petal = new Sprite(); node.petal.anchor.set(0.5); node.petal.blendMode = 'add'
    node.addChild(node.tail, node.halo, node.ring, node.body, node.glyph, node.petal)
    this.noteLayer.addChild(node)
    this.orbsInUse.push(node)
    return node
  }

  private releaseOrbs(): void {
    for (const o of this.orbsInUse) { o.visible = false; this.orbPool.push(o) }
    this.orbsInUse = []
  }

  private drawNotes(t: number, beatP: number, rush: boolean): void {
    const L = this.L
    this.releaseOrbs()
    const slotY = L.slotY
    const activeHold = this.rhythm.activeHold
    // the beat bounce: every orb swells into the beat and settles after it, a little
    // wider than tall at the top and a little thinner at the bottom of the dip
    const [beatI] = this.beatPhase(t)
    const amp = beatI >= 0 ? BOUNCE_AMP[beatI % 4] : 0.7
    const b = beatBounce(beatP)
    const sx = 1 + 0.06 * b * amp
    const sy = 1 - 0.05 * b * amp

    const orbR = L.S(L.orbR)
    const bodyTex = this.tex.body(orbR)
    const ringTex = this.tex.ring(orbR + Math.max(2, L.S(5)), Math.max(2, L.S(3)))
    const haloTex = this.tex.halo()
    const petalTex = this.tex.petal(L.S(16))
    const capTex = this.tex.capsule(16)

    for (const ev of this.visibleEvents(t)) {
      const g = this.geom.get(ev._uid)
      if (!g) continue
      const { lane, w } = g
      const y = this.noteY(ev, t)
      const isActiveHold = activeHold === ev
      // a held anchor is drawn on its lane, not here
      if (ev.hit && !isActiveHold) continue

      const okW = this.rhythm.okWindowFor(ev)
      const missedAge = (t - ev.timestamp) - okW
      const node = this.acquireOrb()
      node.x = L.X(this.field.xOf(ev.char, t))
      const cy = L.Y(isActiveHold ? Math.min(y, slotY) : y)
      node.y = cy
      node.tail.visible = false
      node.petal.visible = false
      node.ring.visible = false
      node.halo.visible = false

      // A missed *hold* is not dissolved.  Shrinking it away the instant its
      // window shut read as the note being snatched off the screen, and the tail
      // went with it; it keeps its shape and its tail and simply goes dark, so
      // what you failed to catch is still legible as it scrolls past.
      const deadHold = missedAge > 0 && !ev.hit && ev.hold_duration > 0
      // dissolving miss: the red note shrinks and fades
      if (missedAge > 0 && !ev.hit && !deadHold) {
        if (missedAge > 0.4) { node.visible = false; continue }
        const k = missedAge / 0.4
        node.body.texture = bodyTex
        node.body.tint = KB.MISS_RED
        node.body.scale.set(1 - 0.4 * k)
        node.body.alpha = 1 - k
        node.glyph.text = ev.char.toUpperCase()
        node.glyph.tint = KB.INK
        node.glyph.alpha = 1 - k
        node.glyph.scale.set((L.S(L.orbR) * 0.95) / 96)
        node.glyph.x = 0
        node.glyph.y = 0
        continue
      }
      if (y < L.top - 80) { node.visible = false; continue }
      // a dead hold leaves once its tail has cleared the slot line
      if (deadHold && t > ev.timestamp + ev.hold_duration + 0.25) { node.visible = false; continue }

      const isGrace = ev.section_kind === 'grace'
      // the note takes the colour of the circle it is falling into, which in
      // columns is its keyboard row rather than its hand zone
      const col = this.bgStage.mono
        ? 0xffffff
        : (rush ? KB.GOLD : KB.laneColor(slotOf(ev.char, this.field.mode)))

      // fade-in over the first 15 % of the fall
      let fade = 1
      const kIn = (y - L.spawnY) / (L.fallPx * 0.15)
      if (kIn < 1) fade = Math.max(0, kIn)

      // hold tail: a soft rounded bar up to where the hold ends
      if (ev.hold_duration > 0) {
        const endY = slotY - (ev.timestamp + ev.hold_duration - t) * this.speed
        const top = L.Y(Math.max(L.top - 80, endY))
        const bottom = isActiveHold ? L.Y(slotY) : cy
        if (bottom - top > 2) {
          const anchor = ev.section_kind === 'anchor'
          node.tail.visible = true
          node.tail.texture = capTex
          node.tail.tint = deadHold ? DEAD_HOLD : (anchor ? this.laneCol(lane) : KB.GOLD)
          node.tail.alpha = deadHold ? 0.20 : (isActiveHold ? 0.45 : 0.28)
          node.tail.width = L.S(anchor ? 22 : 16)
          node.tail.height = bottom - top
          node.tail.x = 0
          node.tail.y = 0
          node.tail.anchor.set(0.5, 0)
          node.tail.y = top - cy
        }
      }

      const scale = isGrace ? 0.5 : 1
      // the downbeat keeps a faint ring that breathes with the beat; lesser beats get
      // the bloom alone, so nothing reads as a hard second ring around the orb
      if (w >= 4 && !isGrace) {
        node.ring.visible = true
        node.ring.texture = ringTex
        node.ring.tint = col
        node.ring.alpha = 0.75 * fade
        node.ring.scale.set(1 + 0.08 * (1 - beatP))
      }
      if (w >= 2 && !isGrace) {
        node.halo.visible = true
        node.halo.texture = haloTex
        node.halo.tint = col
        node.halo.alpha = 0.5 * fade
        node.halo.width = node.halo.height = orbR * 3.2
      }
      node.body.texture = bodyTex
      node.body.tint = deadHold
        ? DEAD_HOLD
        : (ev.hold_duration > 0 ? KB.GOLD : (w >= 2 ? col : 0xf2f2f8))
      node.body.alpha = deadHold ? fade * 0.75 : fade
      node.body.scale.set(sx * scale, sy * scale)
      const fx = this.field.xOf(ev.char, t)
      node.x = L.X(isGrace ? fx - L.orbR * 1.15 : fx)

      node.glyph.text = ev.char.toUpperCase()
      node.glyph.tint = deadHold ? 0x5a5468 : KB.INK
      node.glyph.alpha = fade
      node.glyph.scale.set((orbR * 0.95 * scale) / 96)
      node.glyph.x = 0
      node.glyph.y = L.S(1)

      if (ev.char_idx === 0 && ev.voice < 0 && !isGrace) {
        node.petal.visible = true
        node.petal.texture = petalTex
        node.petal.tint = KB.laneColor(0)
        node.petal.alpha = 0.7 * fade
        node.petal.x = -L.S(14)
        node.petal.y = -L.S(L.orbR + 14)
      }
    }
  }

  // ── effects ──────────────────────────────────────────────────────────────
  private acquireFx(): Sprite {
    const s = this.fxPool.pop()
    if (s) { s.visible = true; this.fxInUse.push(s); return s }
    const n = new Sprite()
    n.anchor.set(0.5)
    this.fxLayer.addChild(n)
    this.fxInUse.push(n)
    return n
  }

  private acquireStamp(): BitmapText {
    const s = this.stampPool.pop()
    if (s) { s.visible = true; this.stampsInUse.push(s); return s }
    const n = label('stamp', 26)
    this.fxLayer.addChild(n)
    this.stampsInUse.push(n)
    return n
  }

  private drawEffects(t: number, dt: number): void {
    const L = this.L
    for (const s of this.fxInUse) { s.visible = false; this.fxPool.push(s) }
    this.fxInUse = []
    for (const s of this.stampsInUse) { s.visible = false; this.stampPool.push(s) }
    this.stampsInUse = []

    // the press feedback: the starburst expanding and fading from under the slot ring
    this.hitAnims = this.hitAnims.filter((a) => {
      const age = t - a.t0
      if (age < 0) return true
      if (age >= STAR_LIFE) return false
      const k = age / STAR_LIFE
      // fast out, easing to a stop
      const reach = 1 - (1 - k) ** 3
      const big = a.judgment === 'perfect'
      const r = L.S((big ? 52 : 42) + (big ? 84 : 56) * reach)
      // holds solid for the first third, then eases out — a flash, not a smear
      const fade = k < 0.34 ? 1 : (1 - (k - 0.34) / 0.66) ** 1.5
      const s = this.acquireFx()
      s.texture = this.tex.star(64)
      s.blendMode = 'add'
      s.tint = a.color
      s.alpha = fade * 0.9
      s.width = s.height = r * 2
      s.x = L.X(a.x)
      s.y = L.Y(a.y)
      return true
    })

    // sparks
    this.sparks = this.sparks.filter((p) => {
      p.age += dt
      if (p.age > p.life) return false
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 900 * dt
      const k = 1 - p.age / p.life
      const s = this.acquireFx()
      s.texture = this.tex.body(8)
      s.blendMode = 'add'
      s.tint = p.col
      s.alpha = k
      s.width = s.height = L.S(5 * k + 2)
      s.x = L.X(p.x)
      s.y = L.Y(p.y)
      return true
    })

    // shards: the miss breaking up.  Rotation was cached in 5° steps on the CPU;
    // here it is the sprite's own rotation.
    this.shards = this.shards.filter((p) => {
      p.age += dt
      if (p.age > p.life) return false
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 1100 * dt
      p.rot += p.spin * dt
      const k = 1 - p.age / p.life
      const s = this.acquireFx()
      s.texture = this.tex.pixel
      s.tint = p.col
      s.alpha = k * 0.9
      s.width = L.S(14 * k + 3)
      s.height = L.S(5 * k + 2)
      s.rotation = p.rot
      s.x = L.X(p.x)
      s.y = L.Y(p.y)
      return true
    })

    // judgment stamps
    this.stamps = this.stamps.filter((st) => {
      const age = t - st.t0
      if (age > 0.55) return false
      const k = age / 0.55
      const n = this.acquireStamp()
      n.text = st.extra
      n.tint = STAMP_COLORS[st.kind] ?? WHITE
      n.alpha = (1 - k) ** 1.4
      n.scale.set(L.S(24) / 96 * (1 + 0.15 * k))
      n.x = L.X(st.x)
      n.y = L.Y(st.y - 70 - 40 * k)
      return true
    })

    // flying glyphs: the letter carried from the slot up into the word block
    const wordEvs = this.rhythm.currentWordEvents()
    for (let i = this.flyGlyphs.length; i < this.flying.length; i++) {
      const g = label('display', 48)
      this.fxLayer.addChild(g)
      this.flyGlyphs.push(g)
    }
    for (const g of this.flyGlyphs) g.visible = false
    this.flying = this.flying.filter((f, idx) => {
      const k = (t - f.t0) / f.dur
      if (k >= 1) return false
      const e = 1 - (1 - k) ** 3
      let x1 = f.x0
      let y1 = f.y0 + 60
      if (wordEvs.length && wordEvs[0].word_id === f.wordId) {
        x1 = this.wordSlotX(wordEvs[0].word_text.length, f.charIdx)
        y1 = L.wordY
      }
      const g = this.flyGlyphs[idx]
      if (!g) return true
      g.visible = true
      g.text = f.ch.toUpperCase()
      g.tint = KB.laneColor(f.lane)
      g.alpha = 0.5 + 0.5 * e
      g.scale.set(L.S(L.wordSize) / 96)
      g.x = L.X(f.x0 + (x1 - f.x0) * e)
      g.y = L.Y(f.y0 + (y1 - f.y0) * e)
      return true
    })
  }

  private drawShockwaves(t: number): void {
    const L = this.L
    const g = this.waveLayer
    g.clear()
    this.shockwaves = this.shockwaves.filter((w) => {
      const age = t - w.t0
      if (age > w.dur) return false
      const k = age / w.dur
      const r = lerp(w.r0, w.r1, 1 - (1 - k) ** 2)
      const a = w.a0 * (1 - k) ** 1.5
      g.circle(L.X(w.x), L.Y(w.y), L.S(r))
        .stroke({ width: Math.max(1, L.S(w.w0 * (1 - k))), color: w.col, alpha: a })
      return true
    })
    this.drawMilestone(t)
  }

  /** The combo milestone: the number popping and lifting, with COMBO under it. */
  private drawMilestone(t: number): void {
    if (this.milestone === null) {
      this.milestoneText.visible = false
      this.milestoneLabel.visible = false
      return
    }
    const [n, t0] = this.milestone
    const age = t - t0
    if (age > 1.1) {
      this.milestone = null
      this.milestoneText.visible = false
      this.milestoneLabel.visible = false
      return
    }
    const L = this.L
    const pop = 1 + 0.35 * Math.max(0, 1 - age / 0.18) ** 2
    const a = age < 0.7 ? 1 : Math.max(0, 1 - (age - 0.7) / 0.4)
    const cx = L.X(L.COMBO_POS[0])
    const cy = L.Y(L.COMBO_POS[1]) - L.S(30 * Math.min(1, age / 1.1))
    this.milestoneText.visible = true
    this.milestoneText.text = String(n)
    this.milestoneText.alpha = 0.9 * a
    this.milestoneText.scale.set((L.S(120) / 96) * pop)
    this.milestoneText.x = cx
    this.milestoneText.y = cy
    this.milestoneLabel.visible = true
    this.milestoneLabel.alpha = 0.8 * a
    this.milestoneLabel.scale.set(L.S(26) / 96)
    this.milestoneLabel.x = cx
    this.milestoneLabel.y = cy + L.S(120 * pop) / 2 + L.S(10)
  }

  // ── word block ───────────────────────────────────────────────────────────
  private wordSlotX(nLetters: number, idx: number): number {
    const adv = this.L.wordAdvance
    return HIGHWAY_CX - ((nLetters - 1) * adv) / 2 + idx * adv
  }

  private drawWordBlock(t: number, rush: boolean): void {
    const L = this.L
    const evs = this.rhythm.currentWordEvents()
    const px = L.S(L.wordSize)
    const y = L.Y(L.wordY)
    this.wordCaret.clear()

    const word = evs.length ? evs[0].word_text : ''
    for (let i = this.wordGlyphs.length; i < word.length; i++) {
      const g = label('display', 72)
      this.wordLayer.addChild(g)
      this.wordGlyphs.push(g)
    }
    for (const g of this.wordGlyphs) g.visible = false

    if (evs.length) {
      const n = word.length
      const flyingSlots = new Set(this.flying.filter((f) => f.kind === 'glyph')
        .map((f) => `${f.wordId}:${f.charIdx}`))
      const byIdx = new Map(evs.map((e) => [e.char_idx, e]))
      const curEv = this.rhythm.currentEvent()
      let curIdx = (curEv !== null && !curEv.is_rest && curEv.word_id === evs[0].word_id)
        ? curEv.char_idx : -1
      const hold = this.rhythm.activeHold
      if (hold !== null && hold.word_id === evs[0].word_id) curIdx = hold.char_idx

      for (let i = 0; i < n; i++) {
        const g = this.wordGlyphs[i]
        g.visible = true
        g.text = word[i].toUpperCase()
        g.scale.set(px / 96)
        g.x = L.X(this.wordSlotX(n, i))
        g.y = y
        const e = byIdx.get(i)
        const typed = e !== undefined && e.hit && !flyingSlots.has(`${evs[0].word_id}:${i}`)
        if (e === undefined) {
          g.tint = WHITE
          g.alpha = 0.22
        } else if (typed) {
          g.tint = rush ? KB.GOLD : KB.laneColor(e.lane)
          g.alpha = 1
        } else if (i === curIdx) {
          g.tint = WHITE
          g.alpha = 1
          // underline caret, pulsing with the beat
          const pulse = 0.6 + 0.4 * (1 - this.beatPhase(t)[1])
          const uw = L.S(40)
          const uy = y + px / 2 + L.S(6)
          this.wordCaret.rect(g.x - uw / 2, uy, uw, Math.max(2, L.S(4)))
            .fill({ color: KB.laneColor(e.lane), alpha: pulse })
        } else {
          g.tint = WHITE
          g.alpha = 0.4
        }
      }
    }

    // the word just finished lifts off and fades — gold when it was clean
    const age = t - this.wordFlashT
    for (const g of this.wordFlashGlyphs) g.visible = false
    if (this.wordFlash !== null && age >= 0 && age < 0.45) {
      const [fw, clean] = this.wordFlash
      const k = age / 0.45
      const e = 1 - (1 - k) ** 2
      for (let i = this.wordFlashGlyphs.length; i < fw.length; i++) {
        const g = label('display', 72)
        this.wordLayer.addChild(g)
        this.wordFlashGlyphs.push(g)
      }
      for (let i = 0; i < fw.length; i++) {
        const g = this.wordFlashGlyphs[i]
        g.visible = true
        g.text = fw[i].toUpperCase()
        g.tint = (clean || rush) ? KB.GOLD : KB.laneColor(KB.laneOf(fw[i]))
        g.alpha = (1 - k) ** 1.2 * 0.9
        g.scale.set((px / 96) * (1 + 0.18 * e))
        g.x = L.X(this.wordSlotX(fw.length, i))
        g.y = y - L.S(46 * e)
      }
    }

    // the queue, stacked: larger, fainter
    const rows = L.queueRows
    const upcoming = this.rhythm.upcomingWords(rows.length)
    for (let i = this.queueRows.length; i < rows.length; i++) {
      const g = label('display_regular', 40)
      this.wordLayer.addChild(g)
      this.queueRows.push(g)
    }
    for (let i = 0; i < this.queueRows.length; i++) {
      const g = this.queueRows[i]
      if (i >= upcoming.length) { g.visible = false; continue }
      const [rowY, rowPx, rowA] = rows[i]
      g.visible = true
      g.text = upcoming[i].toUpperCase()
      g.scale.set(L.S(rowPx) / 96)
      g.alpha = rowA
      g.x = L.X(HIGHWAY_CX)
      g.y = L.Y(rowY)
    }
  }

  /**
   * The duet strip: each lane gets a vertical wash brightest at the slot line, the
   * playing hand's two lanes lit by how deep its heat is and the other hand's
   * dimmed, plus a gold sheet once both hands are three notes in.
   */
  private drawDuetStrip(t: number, duet: [number, number, string] | null): void {
    const L = this.L
    const g = this.duetLayer
    g.clear()
    if (duet === null) {
      // heat only survives inside a duet
      this.heat = [0, 0]
      this.lockT = -9
      return
    }
    const [t0, t1] = duet
    const fadeIn = clamp((t - (t0 - 2 * this.barDur)) / this.beatDur, 0, 1)
    const fadeOut = clamp((t1 - t) / (2 * this.beatDur), 0, 1)
    const k = fadeIn * fadeOut
    if (k <= 0) return
    const voice = this.activeVoice(t)
    const locked = this.lockT >= 0 && this.heat[0] >= 3 && this.heat[1] >= 3
    const top = L.Y(L.top)
    const bottom = L.Y(L.slotY)
    const h = bottom - top
    for (let lane = 0; lane < 4; lane++) {
      const hand = lane < 2 ? 0 : 1
      let a: number
      if (voice < 0) a = 0.5
      else if (hand === voice) a = 0.45 + 0.55 * Math.min(1, this.heat[hand] / 3)
      else a = 0.18
      const x = L.X(L.laneX0(lane))
      const w = L.S(LANE_W)
      const col = this.laneCol(lane)
      // the wash, as bands that square up toward the line (the pygame build bakes
      // a per-pixel gradient; eight bands are indistinguishable and cost nothing)
      const bands = 8
      for (let i = 0; i < bands; i++) {
        const kk = (i + 1) / bands
        g.rect(x, top + h * (i / bands), w, h / bands)
          .fill({ color: col, alpha: 0.17 * kk * kk * a * k })
      }
      // the soft band just above the line
      g.rect(x, bottom - L.S(50), w, L.S(50)).fill({ color: col, alpha: 0.26 * a * k })
      // lane divider in the lane's colour
      g.rect(x, top, 1, h).fill({ color: col, alpha: 0.45 * k })
    }
    if (locked) {
      g.rect(L.X(HIGHWAY_X0), top, L.S(LANE_W * 4), h)
        .fill({ color: KB.GOLD, alpha: 0.1 * k * (0.7 + 0.3 * Math.abs(Math.sin(t * 3))) })
    }
  }

  /** During a duet there are no words: the hand on duty gets an arrow instead. */
  private drawDuetBand(t: number, duet: [number, number, string]): void {
    const L = this.L
    for (const g of this.wordGlyphs) g.visible = false
    for (const g of this.queueRows) g.visible = false
    for (const g of this.wordFlashGlyphs) g.visible = false
    this.wordCaret.clear()
    void duet
    const voice = this.activeVoice(t)
    if (voice < 0) return
    const col = KB.laneColor(voice === 0 ? 1 : 2)
    const cx = L.X(HIGHWAY_CX)
    const cy = L.Y(L.wordY + 20)
    const w = L.S(22)
    const hh = L.S(16)
    // left hand points left, right hand points right
    const pts = voice === 0
      ? [cx - w, cy, cx + w / 2, cy - hh, cx + w / 2, cy + hh]
      : [cx + w, cy, cx - w / 2, cy - hh, cx - w / 2, cy + hh]
    this.wordCaret.poly(pts).fill({ color: col, alpha: 0.8 })
  }

  /** The DUET label and the two-hand lock meter, pinned to the top of the field. */
  private drawDuetMark(t: number, duet: [number, number, string] | null): void {
    const L = this.L
    const g = this.duetMarkGfx
    g.clear()
    if (duet === null) {
      this.duetText.visible = false
      this.lockedText.visible = false
      return
    }
    const [t0, t1] = duet
    const k = clamp((t - (t0 - 2 * this.barDur)) / this.beatDur, 0, 1)
      * clamp((t1 - t) / this.beatDur, 0, 1)
    if (k <= 0) {
      this.duetText.visible = false
      this.lockedText.visible = false
      return
    }
    this.duetText.visible = true
    this.duetText.alpha = 0.8 * k
    this.duetText.scale.set(L.S(24) / 96)
    this.duetText.x = L.X(HIGHWAY_CX)
    this.duetText.y = L.Y(L.top + 40)

    // the lock meter: two halves, one per hand, growing outward from the middle
    const w = L.S(160)
    const hgt = L.S(6)
    const x0 = L.X(HIGHWAY_CX - 80)
    const y0 = L.Y(L.top + 60)
    g.roundRect(x0, y0, w, hgt, hgt / 2).fill({ color: 0x1a1a26, alpha: k })
    const half = w / 2
    const lw = half * Math.min(1, this.heat[0] / 3)
    const rw = half * Math.min(1, this.heat[1] / 3)
    if (lw > 0) g.rect(x0 + half - lw, y0, lw, hgt).fill({ color: KB.laneColor(1), alpha: k })
    if (rw > 0) g.rect(x0 + half, y0, rw, hgt).fill({ color: KB.laneColor(2), alpha: k })

    const locked = this.lockT >= 0 && this.heat[0] >= 3 && this.heat[1] >= 3
    const age = t - this.lockT
    this.lockedText.visible = locked && age < 1.2
    if (this.lockedText.visible) {
      this.lockedText.alpha = Math.max(0, 1 - age / 1.2)
      this.lockedText.scale.set(L.S(40) / 96)
      this.lockedText.x = L.X(HIGHWAY_CX)
      this.lockedText.y = L.Y(L.top + 150) - L.S(30 * age)
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  private drawHud(t: number, dt: number, rush: boolean): void {
    const L = this.L
    const g = this.hudGfx
    g.clear()

    const target = this.rhythm.getScore()
    this.scoreShown += (target - this.scoreShown) * Math.min(1, 8 * dt)
    if (Math.abs(target - this.scoreShown) < 2) this.scoreShown = target
    this.scoreText.text = Math.trunc(this.scoreShown).toLocaleString('en-US')
    this.scoreText.scale.set(L.S(48) / 96)
    this.scoreText.x = L.X(L.SCORE_POS[0])
    this.scoreText.y = L.Y(L.SCORE_POS[1])

    this.multText.text = `x${this.comboTier}`
    this.multText.scale.set(L.S(30) / 96)
    this.multText.x = L.X(L.MULT_POS[0])
    this.multText.y = L.Y(L.MULT_POS[1])

    // rush bar
    const [bx, by, bw, bh] = L.RUSH_BAR
    const rx = L.X(bx), ry = L.Y(by), rw = L.S(bw), rh = L.S(bh)
    g.roundRect(rx, ry, rw, rh, rh / 2).fill({ color: 0x1a1726, alpha: 0.85 })
    let fill = this.rushCharge
    if (rush) fill = Math.max(0, (this.rushUntil - t) / (C.RUSH_BARS * this.barDur))
    if (fill > 0) {
      g.roundRect(rx, ry, Math.max(L.S(6), rw * fill), rh, rh / 2).fill({ color: KB.GOLD })
    }
    g.roundRect(rx, ry, rw, rh, rh / 2).stroke({ width: Math.max(1, L.S(2)), color: WHITE, alpha: 0.25 })

    // lives
    const [lx, ly] = L.LIVES_POS
    for (let i = 0; i < C.LIVES; i++) {
      let r = L.Sf(6)
      if (i === this.lives - 1 && this.lives === 1) r = L.Sf(6 + 2 * Math.abs(Math.sin(t * 4)))
      g.circle(L.X(lx + i * 20), L.Y(ly), r)
        .fill({ color: i < this.lives ? KB.laneColor(0) : 0x302a3a })
    }

    this.accText.text = `${this.rhythm.getAccuracy().toFixed(1)} %`
    this.accText.scale.set(L.S(40) / 96)
    this.accText.x = L.X(L.ACC_POS[0])
    this.accText.y = L.Y(L.ACC_POS[1])

    // progress along the top edge
    const dur = Math.max(1, this.song.duration)
    const prog = clamp((t - this.leadIn) / dur, 0, 1)
    const ph = Math.max(2, L.S(5))
    g.rect(0, 0, L.winW, ph).fill({ color: 0x282834 })
    g.rect(0, 0, L.winW * prog, ph).fill({ color: rush ? KB.GOLD : 0x64c8ff })

    // the count-in: title over the falling lead-in bars
    const showTitle = Boolean(this.title) && t <= this.leadIn
    this.titleText.visible = showTitle
    if (showTitle) {
      const a = Math.min(1, t / 0.6) * Math.min(1, Math.max(0, (this.leadIn - t) / 0.5))
      this.titleText.alpha = a
      this.titleText.scale.set(L.S(40) / 96)
      this.titleText.x = L.X(HIGHWAY_CX)
      this.titleText.y = L.Y(L.top + 120)
    }

    // the section tag: what the chart handed this phrase to
    const ph2 = this.phraseAt(t)
    const lay = this.layerAt(t)
    // the section tag: BUILD / HOLD, or the instrument this phrase was handed to
    let tag = ''
    if (ph2 !== null) tag = SECTION_TAG[ph2.kind] ?? ''
    if (!tag && lay !== null && lay[4] === 'alt') tag = LAYER_TAG[lay[2]] ?? ''
    this.tagText.visible = Boolean(tag)
    if (tag) {
      this.tagText.text = tag
      this.tagText.scale.set(L.S(18) / 96)
      this.tagText.x = L.X(HIGHWAY_CX)
      this.tagText.y = L.Y(L.top + 60)
      this.tagText.alpha = 0.5
    }
  }

  /**
   * Noki's frames arrive as one packed strip (tools/export_web.py crops every
   * frame to the animation's union bbox so the figure never jitters).  She bops
   * on the beat and plays the hurt strip for a moment after a miss.
   */
  setNokiSheet(base: Texture, info: { frames: number; w: number; h: number }): void {
    this.nokiSheet = info
    this.nokiFrames = []
    for (let i = 0; i < info.frames; i++) {
      this.nokiFrames.push(new Texture({
        source: base.source,
        frame: new Rectangle(i * info.w, 0, info.w, info.h),
      }))
    }
    if (this.noki === null) {
      this.noki = new Sprite(this.nokiFrames[0])
      this.noki.anchor.set(0.5, 1)
      this.nokiLayer.addChild(this.noki)
    }
  }

  private drawNoki(t: number): void {
    const n = this.noki
    if (n === null || this.nokiSheet === null || !this.showNoki) {
      if (n) n.visible = false
      return
    }
    const L = this.L
    const [rx, ry, rw, rh] = L.nokiRect
    n.visible = true
    // the bop cycles once per bar; a miss cuts to the hurt frames for a beat
    const barP = this.barPhase(t)
    const hurting = t - this.hurtT < this.beatDur
    const frames = this.nokiFrames.length
    const idx = hurting
      ? Math.min(frames - 1, Math.floor(((t - this.hurtT) / this.beatDur) * frames))
      : Math.floor(barP * frames) % frames
    n.texture = this.nokiFrames[idx]
    n.height = L.S(rh)
    n.width = L.S(rh) * (this.nokiSheet.w / this.nokiSheet.h)
    n.x = L.X(rx + rw / 2)
    n.y = L.Y(ry + rh)
    void L
  }

  destroy(): void {
    this.tex.clear()
    this.stage.destroy({ children: true })
  }
}

/** The orb's swell into a beat: 1 at the beat, easing to 0 across it. */
function beatBounce(p: number): number {
  return (1 - p) ** 2
}

/** A small deterministic PRNG, so the dust and the shards are the same every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Where the song drops, in chart time, each tagged large or small.
 * A direct port of HighwayRenderer._find_drops.
 */
export function findDrops(energy: number[], vibes: string[], barT: number[]): [number, string][] {
  const n = Math.min(energy.length, barT.length)
  const out: [number, string][] = []
  if (n < 2) return out
  const order: Record<string, number> = { sustain: 0, groove: 1, drive: 2, burst: 3 }
  let lastLarge = -99
  let lastAny = -99
  for (let b = 0; b < n; b++) {
    const v = b < vibes.length ? vibes[b] : 'groove'
    const pv = b > 0 && b < vibes.length ? vibes[b - 1] : (b === 0 ? 'sustain' : v)
    let rise = 0
    if (b > 0) {
      const prev = energy.slice(Math.max(0, b - 2), b)
      rise = energy[b] - prev.reduce((x, y) => x + y, 0) / prev.length
    }
    const intoBurst = v === 'burst' && pv !== 'burst'
    const stepUp = (order[v] ?? 1) > (order[pv] ?? 1)
    const nextV = b + 1 < vibes.length ? vibes[b + 1] : v
    // the fill before the drop: let the drop have it
    if (!intoBurst && v !== 'burst' && nextV === 'burst') continue
    const large = intoBurst || (rise >= DROP_LARGE_RISE && energy[b] >= DROP_LARGE_MIN_E)
    const small = (rise >= DROP_SMALL_RISE && energy[b] >= DROP_SMALL_MIN_E && (v === 'drive' || v === 'burst'))
      || (stepUp && rise >= DROP_PHRASE_RISE && energy[b] >= DROP_SMALL_MIN_E)
      || (b % 4 === 0 && v === 'burst' && rise >= DROP_PHRASE_RISE)
      || (b % 8 === 0 && v === 'burst' && b > 0 && energy[b] >= energy[b - 1] - 0.01)
    if (large && b - lastLarge >= DROP_LARGE_GAP_BARS && b - lastAny >= DROP_ANY_GAP_BARS) {
      out.push([barT[b], 'large'])
      lastLarge = lastAny = b
    } else if ((large || small) && b - lastAny >= DROP_ANY_GAP_BARS) {
      out.push([barT[b], 'small'])
      lastAny = b
    }
  }
  if (!out.some(([, s]) => s === 'large')) {
    // a song that never steps into a burst: its loudest rise is the drop
    let best = -1
    let bestRise = -Infinity
    for (let b = 1; b < n; b++) {
      const r = energy[b] - energy[b - 1]
      if (r > bestRise) { bestRise = r; best = b }
    }
    if (best > 0 && bestRise >= DROP_SMALL_RISE) {
      const keep = out.filter(([t]) => Math.abs(t - barT[best]) > 1e-6)
      keep.push([barT[best], 'large'])
      out.length = 0
      out.push(...keep)
    }
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}
