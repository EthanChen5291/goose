/**
 * PixelHighway — the play screen, drawn in game pixels.
 *
 * The same game as `render/highway.ts` — four lanes, notes falling onto hit
 * circles, the word block, holds, anchors, duets, drops — redrawn as pixel art
 * into the small buffer `px/canvas.ts` owns, with the fight on the left:
 *
 *     ┌──────────────────────────────────────────────────────┐
 *     │ score                 combo                    acc % │
 *     │                                                      │
 *     │            ·  ·  ·  ·   ← notes falling              │
 *     │   enemy   goose                                      │
 *     │  ═══════════════════════●═══●═══●═══●════════════════│ ground
 *     │              W O R D                                 │ dirt
 *     └──────────────────────────────────────────────────────┘
 *
 * Every correct note is a move on the enemy; every miss is the enemy's turn.
 * The renderer never judges — the session calls `onHit` / `onMiss` after the
 * RhythmManager has — it only decides what that looks like.
 *
 * Pixel rules kept throughout: positions are whole pixels, nothing scales or
 * rotates except effects by quarter turns, alpha fades are quantised to a few
 * hard steps, and the only thing that moves smoothly is a falling note.
 */
import { ColorMatrixFilter, Container, Graphics, Sprite } from 'pixi.js'
import type { BitmapText, Texture } from 'pixi.js'

import type { Layout } from '../core/layout'
import type { ChartMeta, Song } from '../core/models'
import type { LiveEvent, RhythmManager } from '../core/rhythm'
import type { PlayRenderer } from '../render/renderer'
import { weightOfTime, findDrops, mulberry32, lowerBound } from './chartmath'
import * as KB from '../core/keyboard'
import * as C from '../core/constants'
import { slotOf } from '../render/playfield'
import { Playfield } from '../render/playfield'
import type { FieldMode } from '../render/playfield'

import type { PxAssets } from './assets'
import type { PixelCanvas } from './canvas'
import { PxLayout } from './layout'
import { PixelScene } from './scene'
import type { SceneShift } from './scene'
import { FxLayer } from './fx'
import { Goose, Enemy, Fight, planHeavy } from './actors'
import { Combat } from './combat'
import { KanjiLayer } from './kanji'
import { pxText } from './text'
import type { LevelSpec } from './levels'

const WHITE = 0xffffff
const INK = 0x17181a
const DIM = 0x6e6a80
const DEAD_HOLD = 0x4a4560
const STAMP_COLORS: Record<string, number> = {
  perfect: KB.GOLD, good: 0x83e3b0, ok: 0xaed0e6, miss: KB.MISS_RED, slip: 0xaaaabe,
}
const STAMP_TEXT: Record<string, string> = { perfect: 'PERFECT', good: 'GREAT', ok: 'OK', miss: 'MISS' }
const ENERGY: Record<string, number> = { sustain: 0.12, groove: 0.4, drive: 0.7, burst: 1.0 }
const MILESTONES = [25, 50, 100, 150, 200, 300, 400, 500]
const SECTION_TAG: Record<string, string> = { pattern: 'BUILD', anchor: 'HOLD', onecircle: 'ARROWS' }
/** the onecircle stage's alphabet, and the arrow key each letter is played on */
const ARROW_OF: Record<string, string> = { d: 'arrow_l', f: 'arrow_d', j: 'arrow_u', k: 'arrow_r' }
const ARROW_KEY: Record<string, string> = { ArrowLeft: 'd', ArrowDown: 'f', ArrowUp: 'j', ArrowRight: 'k' }
const ARROW_ASCII: Record<string, string> = { d: '<', f: 'v', j: '^', k: '>' }
const MODE_NAME: Record<string, string> = { lanes: '4 LANES', columns: '3 ROWS', onecircle: 'ARROWS' }
/** chord: two hits this close are one gesture */
const CHORD_S = 0.06
/** the enemy's health bar: every hit takes a slice, so a clean run empties it */
const HP_W = 30

interface Stamp { text: string; color: number; x: number; y: number; t0: number }
/** a big word across the highway: FIGHT!, DROP!, DOWN! */
interface BigWord { text: string; color: number; t0: number; dur: number }
/** what the big drops do to the world, in turn */
const SHIFT_CYCLE: SceneShift[] = ['rays', 'white', 'purple', 'rays', 'red', 'gold']
interface Ring { x: number; y: number; t0: number; color: number; r0: number; r1: number; dur: number }

interface NoteNode extends Container {
  outer: Sprite
  outline: Sprite
  body: Sprite
  glyph: BitmapText
  arrow: Sprite
  tail: Graphics
  petal: Sprite
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** alpha in hard steps: a pixel fade is a handful of levels, not a ramp */
const stepA = (a: number, steps = 4) => Math.round(clamp(a, 0, 1) * steps) / steps


export class PixelHighway implements PlayRenderer {
  readonly stage = new Container()
  get failed(): boolean { return false }
  /** the shell wires this to the audio engine; `delay` is seconds from now */
  sfx: (name: string, delay?: number) => void = () => {}

  private L: PxLayout
  private readonly beatDur: number
  private readonly barDur: number
  private readonly leadIn: number
  private beatTimesChart: number[]
  readonly approach: number
  private speed: number

  // layers, back to front
  private scene: PixelScene
  private rowGfx = new Graphics()
  private duetGfx = new Graphics()
  private anchorGfx = new Graphics()
  private anchorKeys: BitmapText[] = []
  private anchorLabels: BitmapText[] = []
  private connGfx = new Graphics()
  private groundGfx = new Graphics()
  private ringLayer = new Container()
  private noteLayer = new Container()
  private fight: Fight
  private fx: FxLayer
  private ringGfx = new Container()
  private stampLayer = new Container()
  private kanji: KanjiLayer
  private combat: Combat
  private bigLayer = new Container()
  private winGfx = new Graphics()
  private wordLayer = new Container()
  private hudLayer = new Container()

  readonly field = new Playfield()
  private pinched = -99

  private geom = new Map<number, { lane: number; w: number }>()
  private nextT = new Map<number, number>()

  // transient
  private stamps: Stamp[] = []
  private stampPool: BitmapText[] = []
  private stampsInUse: BitmapText[] = []
  private rings: Ring[] = []
  private ringHitT = [-9, -9, -9, -9]
  private ringMissT = [-9, -9, -9, -9]
  private ringSprites: Sprite[] = []
  private lineFlashT = -9
  private lastBeatIdx = -1
  private lastHitT = -9
  private pendingHurt = -1
  private ended = false
  /** set at the end: the enemy went down */
  won = false
  private endT = -9
  private bigWords: BigWord[] = []
  private bigText: BitmapText
  private bigShadow: BitmapText
  private invertUntil = -9
  private invertFilter = new ColorMatrixFilter()
  private shiftI = 0
  private fightCalled = false

  // meta
  lives = C.LIVES
  private streak = 0
  private napUntil = -9
  private rushCharge = 0
  private rushUntil = -9
  private comboTier = 1
  private scoreShown = 0
  private energyS = 0.4
  private wordFlashT = -9
  private wordFlash: [string, boolean] | null = null
  private milestone: [number, number] | null = null
  private dropT = -9
  private drops: [number, string][] = []
  private dropI = 0
  private hitsLanded = 0
  private totalNotes = 1
  private lightningT = -9

  private barVibes: string[] = []
  private barT: number[] = []
  /** [t0, t1] chart spans where the stage goes pitch black: a quiet run after a loud one */
  private voidSpans: [number, number][] = []
  private phrases: [number, number, string][] = []
  private duets: [number, number, string][] = []
  private heat = [0, 0]
  private lockT = -9
  private anchorsOn = new Map<number, LiveEvent>()
  private anchorFades = new Map<number, [number, string]>()

  private notePool: NoteNode[] = []
  private notesInUse: NoteNode[] = []
  private wordGlyphs: BitmapText[] = []
  private wordArrows: Sprite[] = []
  /** the coming rearrangement of the circles, if one is within a bar */
  private shiftTickBeat = -1
  private wordFlashGlyphs: BitmapText[] = []
  private queueText: BitmapText
  private wordCaret = new Graphics()

  private scoreText: BitmapText
  private multText: BitmapText
  private accText: BitmapText
  private comboText: BitmapText
  private comboShadow: BitmapText
  private titleText: BitmapText
  private tagText: BitmapText
  private duetText: BitmapText
  private milestoneText: BitmapText
  private hudGfx = new Graphics()

  private rng = mulberry32(11)
  private tex: Record<string, Texture>

  constructor(
    private canvas: PixelCanvas,
    private assets: PxAssets,
    private readonly song: Song,
    private readonly rhythm: RhythmManager,
    readonly difficulty: string,
    settings: Record<string, unknown>,
    private readonly title: string,
    level: LevelSpec,
  ) {
    const speedMult = Math.max(0.25, Number(settings.speed_mult ?? 1))
    this.approach = (C.APPROACH_S[difficulty] ?? 1.6) / speedMult
    this.beatDur = song.bpm ? 60 / song.bpm : 0.5
    this.barDur = this.beatDur * 4
    this.leadIn = rhythm.leadIn
    this.beatTimesChart = song.beat_times.map((b) => b + this.leadIn)

    this.scene = new PixelScene(assets)
    this.scene.set(level.scene)
    this.scene.layout(canvas.w, canvas.h)
    this.L = new PxLayout(canvas.w, canvas.h, this.scene.groundY)
    this.speed = this.L.fallPx / this.approach

    this.tex = {
      disc: assets.ui('disc8'), outline: assets.ui('ring9'), outer: assets.ui('ring12'),
      slot: assets.ui('ring10b'), slotOut: assets.ui('ring11'), petal: assets.ui('disc2'),
      life: assets.ui('disc5'), ghost: assets.ui('ring10'),
      arrow_l: assets.ui('arrow_l'), arrow_r: assets.ui('arrow_r'), arrow_u: assets.ui('arrow_u'), arrow_d: assets.ui('arrow_d'),
    }

    // the fight
    const g = assets.manifest.chars.goose
    const goose = new Goose(assets.char('goose'), g.feet, g.fw, g.fh, this.rng)
    const e = assets.manifest.chars[level.enemy.char]
    const enemy = new Enemy(assets.char(level.enemy.char), e.feet, e.fw, e.fh)
    this.enemySpec = level.enemy
    this.fight = new Fight(goose, enemy)
    this.fx = new FxLayer(assets)
    this.kanji = new KanjiLayer(assets)
    this.combat = new Combat(this.fight, this.fx, (n, d) => this.sfx(n, d), {
      kick: (px) => { this.kickPx = px; this.kickT = -1 },
      mark: (text, x, y, t) => this.stamps.push({ text, color: KB.GOLD, x, y, t0: t }),
      kanji: (name, color, x, y, t, big) => this.kanji.push(name, color, x, y, t, big),
      invert: (t, secs) => { this.invertUntil = t + secs },
    })
    goose.onEvent = this.combat.onEvent
    this.invertFilter.negative(false)
    this.bigText = pxText('px16')
    this.bigShadow = pxText('px16', '', INK)
    this.bigText.visible = this.bigShadow.visible = false

    this.queueText = pxText('px8', '', WHITE)
    this.scoreText = pxText('px8'); this.scoreText.anchor.set(0, 0)
    this.multText = pxText('px8', '', KB.GOLD); this.multText.anchor.set(0, 0)
    this.accText = pxText('px8'); this.accText.anchor.set(1, 0)
    this.comboText = pxText('px16')
    this.comboShadow = pxText('px16', '', INK)
    this.titleText = pxText('px8', title)
    this.tagText = pxText('px8', '', KB.GOLD)
    this.duetText = pxText('px8', 'DUET', KB.GOLD)
    this.milestoneText = pxText('px16', '', KB.GOLD)
    for (let i = 0; i < 4; i++) {
      const k = pxText('px16'); k.visible = false
      const b = pxText('px8', 'HOLD'); b.visible = false
      this.anchorKeys.push(k); this.anchorLabels.push(b)
    }

    this.stage.addChild(this.scene.container, this.rowGfx, this.duetGfx, this.anchorGfx,
                        ...this.anchorKeys, ...this.anchorLabels,
                        this.connGfx, this.groundGfx, this.ringLayer, this.noteLayer,
                        this.kanji.container, this.fight.container, this.fx.container, this.ringGfx, this.stampLayer,
                        this.winGfx, this.wordLayer, this.bigLayer, this.hudLayer)
    this.bigLayer.addChild(this.bigShadow, this.bigText)
    this.wordLayer.addChild(this.wordCaret, this.queueText)
    this.hudLayer.addChild(this.hudGfx, this.scoreText, this.multText, this.accText, this.comboShadow, this.comboText,
                           this.titleText, this.tagText, this.duetText, this.milestoneText)

    this.prepEvents()
    this.buildRings()
    this.place()
  }

  private enemySpec: LevelSpec['enemy']
  /** a camera kick asked for by a blow: pixels, applied on the next frame */
  private kickPx = 0
  private kickT = -1

  // ── setup ────────────────────────────────────────────────────────────────
  private prepEvents(): void {
    this.geom.clear()
    this.nextT.clear()
    let prev: LiveEvent | null = null
    let n = 0
    for (const ev of this.rhythm.beatMap) {
      if (ev.is_rest || !ev.char) continue
      n += 1
      const lane = ev.lane >= 0 ? ev.lane : KB.laneOf(ev.char)
      ev.lane = lane
      if (ev.weight < 0) ev.weight = weightOfTime(ev.timestamp - this.leadIn, this.song.beat_times, this.song.bpm)
      this.geom.set(ev._uid, { lane, w: ev.weight })
      if (prev) this.nextT.set(prev._uid, ev.timestamp)
      prev = ev
    }
    this.totalNotes = Math.max(1, n)
  }

  setSections(meta: ChartMeta): void {
    const li = this.leadIn
    this.barVibes = [...(meta.bar_vibes ?? [])]
    this.barT = (meta.bar_start ?? []).map((t) => t + li)
    this.phrases = (meta.phrases ?? []).map((p) => [p[0] + li, p[1] + li, String(p[2])])
    this.drops = findDrops(meta.bar_energy ?? [], this.barVibes, this.barT)
    this.field.setStages((meta.stages ?? []) as [number, number, string][], li)
    this.dropI = 0
    this.voidSpans = findVoids(this.barVibes, this.barT, this.barDur)
  }

  setDuets(spans: ChartMeta['duets'] = []): void {
    this.duets = (spans ?? []).map((s) => [s[0] + this.leadIn, s[1] + this.leadIn, String(s[2])])
  }

  /** the session's design-unit layout is not used; the pixel buffer is the layout */
  setLayout(_layout: Layout): void { this.relayout() }

  /** the buffer changed size: put everything back where it goes */
  relayout(): void {
    this.scene.layout(this.canvas.w, this.canvas.h)
    this.L = new PxLayout(this.canvas.w, this.canvas.h, this.scene.groundY)
    this.speed = this.L.fallPx / this.approach
    this.place()
  }

  private place(): void {
    const L = this.L
    const { goose, enemy } = this.fight
    goose.x = L.gooseX; goose.y = L.groundY
    enemy.x = L.enemyX; enemy.y = L.groundY
    enemy.facing = 1
    goose.facing = -1
    this.fight.aim()
    for (let i = 0; i < this.ringSprites.length; i++) {
      this.ringSprites[i].x = L.laneCenter(i)
      this.ringSprites[i].y = L.slotY
    }
  }

  private ringOutlines: Sprite[] = []
  private buildRings(): void {
    for (let lane = 0; lane < 4; lane++) {
      const o = new Sprite(this.tex.slotOut)
      o.anchor.set(0.5)
      o.roundPixels = true
      o.tint = INK
      this.ringLayer.addChild(o)
      this.ringOutlines.push(o)
    }
    for (let lane = 0; lane < 4; lane++) {
      const s = new Sprite(this.tex.slot)
      s.anchor.set(0.5)
      s.roundPixels = true
      s.tint = KB.laneColor(lane)
      this.ringLayer.addChild(s)
      this.ringSprites.push(s)
    }
  }

  // ── time ─────────────────────────────────────────────────────────────────
  private beatPhase(t: number): [number, number] {
    const bt = this.beatTimesChart
    if (!bt.length) return [-1, 0]
    const i = clamp(lowerBound(bt, t) - 1, 0, bt.length - 2)
    if (i < 0) return [-1, 0]
    const dur = Math.max(1e-3, bt[i + 1] - bt[i])
    return [i, clamp((t - bt[i]) / dur, 0, 1)]
  }

  private energyAt(t: number): number {
    if (!this.barT.length || !this.barVibes.length) return 0.45
    let i = lowerBound(this.barT, t) - 1
    if (i < 0) return ENERGY[this.barVibes[0]] ?? 0.4
    i = Math.min(i, this.barVibes.length - 1)
    return ENERGY[this.barVibes[i]] ?? 0.4
  }

  private vibeAt(t: number): string {
    if (!this.barT.length || !this.barVibes.length) return ''
    let i = 0
    while (i + 1 < this.barT.length && this.barT[i + 1] <= t) i += 1
    return this.barVibes[Math.min(i, this.barVibes.length - 1)] ?? ''
  }

  private phraseAt(t: number): { kind: string; t0: number; t1: number } | null {
    for (const [t0, t1, kind] of this.phrases) if (t0 <= t && t < t1) return { kind, t0, t1 }
    return null
  }

  private duetAt(t: number): [number, number, string] | null {
    for (const d of this.duets) if (d[0] - 2 * this.barDur <= t && t < d[1]) return d
    return null
  }

  private activeVoice(t: number): number {
    for (const ev of this.visibleEvents(t)) {
      if (!ev.hit && ev.voice >= 0 && ev.timestamp >= t - 0.05) return ev.voice
    }
    return -1
  }

  private noteY(ev: LiveEvent, t: number): number {
    return this.L.slotY - (ev.timestamp - t) * this.speed
  }

  private visibleCache: LiveEvent[] = []
  private visibleCacheT = NaN
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

  private laneOf(ev: LiveEvent): number { return this.geom.get(ev._uid)?.lane ?? 0 }
  private slotXY(ev: LiveEvent, _t: number): [number, number] {
    return [this.xOfEv(ev), this.L.slotY]
  }
  /** the circles' shape when this note is due: a note never changes column in flight */
  private modeOf(ev: LiveEvent): FieldMode { return this.field.modeAt(ev.timestamp) }
  /** a note's circle x, in game pixels — where it will be caught, from the moment it appears */
  private xOfEv(ev: LiveEvent): number {
    return Math.round(this.slotX(ev.char, this.modeOf(ev)))
  }
  private prevMode: FieldMode = 'lanes'

  /** the arrow keys stand for d f j k while the circles are one, or about to be */
  keyAlias(key: string, t: number): string | null {
    const ch = ARROW_KEY[key]
    if (!ch) return null
    if (this.field.modeAt(t) === 'onecircle' || this.field.modeAt(t + 0.3) === 'onecircle') return ch
    return null
  }
  private slotX(ch: string, mode: FieldMode): number {
    const L = this.L
    if (mode === 'onecircle') return L.hwCx
    if (mode === 'columns') return L.hwX0 + Math.floor(L.laneW * 0.67) + slotOf(ch, mode) * Math.floor(L.laneW * 1.33)
    return L.laneCenter(slotOf(ch, mode))
  }
  private slotXs(mode: FieldMode): number[] {
    const L = this.L
    if (mode === 'onecircle') return [L.hwCx]
    if (mode === 'columns') return [0, 1, 2].map((i) => L.hwX0 + Math.floor(L.laneW * 0.67) + i * Math.floor(L.laneW * 1.33))
    return [...L.laneCenters]
  }

  private laneCol(lane: number): number {
    return this.scene.mode === 'void' ? WHITE : KB.laneColor(lane)
  }

  // ── events from the session ──────────────────────────────────────────────
  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const lane = this.laneOf(ev)
    const [x, y] = this.slotXY(ev, t)
    const rush = this.rushActive(t)
    const col = rush ? KB.GOLD : this.laneCol(lane)
    this.streak += 1
    this.hitsLanded += 1
    if (this.streak % C.LIFE_REGROW_STREAK === 0 && this.lives < C.LIVES && t >= this.napUntil) this.lives += 1
    if (judgment === 'perfect') this.rushCharge = Math.min(1, this.rushCharge + 0.01)
    this.ringHitT[lane] = t
    this.stamp(judgment, x, y, offsetMs, t)

    // the fight
    const { goose } = this.fight
    const w = this.geom.get(ev._uid)?.w ?? 2
    const gap = (this.nextT.get(ev._uid) ?? ev.timestamp + 1) - ev.timestamp
    // the enemy's blow was on its way: landing this note reads it — the goose dodges instead of getting hurt
    if (this.pendingHurt >= 0 && t < this.pendingHurt) { this.pendingHurt = -1; goose.dodge(t) }
    let mv = ''
    if (t - this.lastHitT < CHORD_S) { goose.chord(t); mv = 'spin' }
    else mv = goose.hit(t, w, judgment, gap)
    this.lastHitT = t
    // the blow: its sound, the enemy's reaction, the trail off the wing and the spark where it lands
    this.combat.blow(mv, judgment, w, t)
    if (judgment === 'perfect' && w >= 3) this.sfx('perfect', 0.04)
    // the circle answers with a small flash
    this.fx.spawn('muzzle', x, y, t, { fps: 24 })
    this.rings.push({ x, y, t0: t, color: col, r0: 10, r1: 14, dur: 0.14 })

    if (ev.voice >= 0) {
      this.heat[ev.voice] = Math.min(3, this.heat[ev.voice] + 1)
      if (this.heat[0] >= 3 && this.heat[1] >= 3 && this.lockT < 0) {
        // both hands locked in: the goose lights up, not the middle of the screen
        this.lockT = t
        this.fx.spawn('sparkling_s', goose.x, goose.y - 16, t, { follow: () => [goose.sprite.x, goose.y - 16] })
        this.rushCharge = Math.min(1, this.rushCharge + 0.25)
      }
    }
    const combo = this.rhythm.combo
    this.comboTier = 1 + (combo >= 10 ? 1 : 0) + (combo >= 25 ? 1 : 0) + (combo >= 50 ? 1 : 0)
    if (MILESTONES.includes(combo)) {
      this.milestone = [combo, t]
      this.sfx('combo')
      const [cx, cy] = this.L.comboPos
      this.fx.spawn(combo >= 100 ? 'hearts' : 'firework_yellow', cx, cy, t)
      this.fx.spawn(combo >= 100 ? 'text_wow' : 'text_cool', cx, cy - 30, t)
      goose.cheer(t)
    }
  }

  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const lane = this.laneOf(ev)
    const [x, y] = this.slotXY(ev, t)
    this.ringHitT[lane] = t
    this.stamp(judgment, x, y, offsetMs, t)
    this.fight.goose.holdStart(t)
    this.sfx('whip')
    this.fx.spawn('charge_s', this.fight.enemy.x, this.fight.enemy.y - 22, t)
  }

  onHoldComplete(ev: LiveEvent, judgment: string, t: number): void {
    const lane = this.laneOf(ev)
    const [x, y] = this.slotXY(ev, t)
    this.ringHitT[lane] = t
    this.stamp(judgment, x, y, 0, t)
    this.fx.spawn('sparkle_blue_s', x, y - 6, t)
    this.fight.goose.holdEnd(t, judgment !== 'miss')
    if (judgment === 'miss') this.fight.enemy.hit(t, false)
    this.hitsLanded += 1
  }

  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const lane = this.laneOf(ev)
    this.anchorsOn.set(lane, ev)
    const [x, y] = this.slotXY(ev, t)
    this.ringHitT[lane] = t
    this.stamp(judgment, x, y, offsetMs, t)
    this.fight.goose.anchorStart(t)
  }

  onAnchorComplete(ev: LiveEvent, judgment: string, t: number): void {
    const lane = this.laneOf(ev)
    this.anchorsOn.delete(lane)
    this.anchorFades.set(lane, [t, 'done'])
    const [x, y] = this.slotXY(ev, t)
    this.stamp(judgment, x, y, 0, t)
    this.fx.spawn('sparkling_s', x, y - 8, t)
    if (this.anchorsOn.size === 0) this.fight.goose.anchorEnd(t, true)
    this.fight.enemy.hit(t, true)
    this.hitsLanded += 1
  }

  onAnchorBreak(ev: LiveEvent, t: number): void {
    const lane = this.laneOf(ev)
    this.anchorsOn.delete(lane)
    this.anchorFades.set(lane, [t, 'broke'])
    if (this.anchorsOn.size === 0) this.fight.goose.anchorEnd(t, false)
    this.onMiss(ev, t)
  }

  onMiss(ev: LiveEvent, t: number): void {
    const lane = this.laneOf(ev)
    const [x, y] = this.slotXY(ev, t)
    this.ringMissT[lane] = t
    this.streak = 0
    this.stamp('miss', x, y, 0, t)
    this.comboTier = 1
    if (t >= this.napUntil && this.lives > 0) {
      this.lives -= 1
      if (this.lives === 0) this.napUntil = t + C.NAP_BARS * this.barDur
    }
    this.sfx('miss')
    // a heavy move wound up for this note swings at nothing
    const g = this.fight.goose
    if (g.isWindingUp && Math.abs(g.pendingContact - ev.timestamp) < 0.2) g.whiff(t)
    // the enemy's turn: its attack lands on its contact frame
    const landsAt = this.fight.enemy.attack(t, this.enemySpec.contact)
    if (landsAt >= 0) this.pendingHurt = landsAt
  }

  onSlip(ev: LiveEvent, pressed: string, t: number): void {
    const [x, y] = this.slotXY(ev, t)
    this.stamps.push({ text: pressed.toUpperCase(), color: STAMP_COLORS.slip, x, y, t0: t })
  }

  onTooEarly(ev: LiveEvent, t: number): void {
    this.ringMissT[this.laneOf(ev)] = t - 0.2
  }

  onWordComplete(word: string, clean: boolean, t: number): void {
    this.wordFlash = [word, clean]
    this.wordFlashT = t
    if (clean) this.rushCharge = Math.min(1, this.rushCharge + C.RUSH_CHARGE_PER_CLEAN_WORD)
    const g = this.fight.goose
    g.honk(t, clean && this.rng() < 0.5)
    if (g.current !== 'megahonk') this.sfx('honk')
    if (clean) this.sfx('word', 0.1)
    // the honk: a ring leaving the beak
    const bx = g.x - 12, by = g.y - 24
    this.rings.push({ x: bx, y: by, t0: t, color: clean ? KB.GOLD : WHITE, r0: 5, r1: 16, dur: 0.3 })
    this.fx.spawn(clean ? 'music_yellow_s' : 'music_red_s', this.L.hwCx, this.L.wordY - 10, t,
                  { flipX: this.rng() < 0.5 })
  }

  tryRush(t: number): boolean {
    if (this.rushCharge < C.RUSH_THRESHOLD || this.rushActive(t)) return false
    this.rushUntil = t + C.RUSH_BARS * this.barDur
    this.rushCharge = 0
    this.rhythm.rushActive = true
    this.scene.flash(t, 0.08, 0.7)
    this.fx.spawn('text_level_up', this.L.hwCx, this.L.h * 0.3, t)
    this.fx.spawn('haste_s', this.fight.goose.x, this.fight.goose.y - 16, t, {
      follow: () => [this.fight.goose.sprite.x, this.fight.goose.y - 16],
    })
    this.rings.push({ x: this.L.hwCx, y: this.L.slotY, t0: t, color: KB.GOLD, r0: 5, r1: 16, dur: 0.5 })
    return true
  }

  rushActive(t: number): boolean { return t < this.rushUntil }

  private stamp(kind: string, _x: number, _y: number, offsetMs: number, t: number): void {
    let text = STAMP_TEXT[kind] ?? kind.toUpperCase()
    if (kind !== 'miss' && Math.abs(offsetMs) > 1) text = `${text} ${offsetMs > 0 ? '+' : ''}${offsetMs.toFixed(0)}`
    // in the sky over the fight — above the highest a move reaches (the body slam's hang), so the
    // word never sits on the fighters, and off the lanes so the notes behind stay clear
    const { goose, enemy } = this.fight
    this.stamps.push({ text, color: STAMP_COLORS[kind] ?? WHITE, x: Math.round((goose.x + enemy.x) / 2), y: goose.y - 84, t0: t })
    if (this.stamps.length > 4) this.stamps.shift()
  }

  // ── the frame ────────────────────────────────────────────────────────────
  draw(t: number, dt: number): void {
    const L = this.L
    const rush = this.rushActive(t)
    if (!rush && this.rhythm.rushActive) this.rhythm.rushActive = false

    const [beatI, beatP] = this.beatPhase(t)
    if (beatI !== this.lastBeatIdx) { this.lastBeatIdx = beatI; this.lineFlashT = t }
    const eTarget = this.energyAt(t)
    this.energyS += (eTarget - this.energyS) * Math.min(1, 3 * dt)

    // the count-in ends: FIGHT!
    if (!this.fightCalled && t >= this.leadIn - 0.02) {
      this.fightCalled = true
      this.big('FIGHT!', KB.GOLD, t, 0.8)
      this.sfx('fight_card')
      this.scene.flash(t, 0.06, 0.6)
    }
    // drops
    while (this.dropI < this.drops.length && t >= this.drops[this.dropI][0]) {
      const [tDrop, size] = this.drops[this.dropI]
      this.dropI += 1
      if (t - tDrop < 0.25) this.drop(t, size)
    }

    // playfield shape — and a bar's warning before it changes
    const modeBefore = this.field.mode
    this.field.update(t)
    if (this.field.mode !== modeBefore) {
      this.prevMode = modeBefore
      this.sfx('shift_go')
      for (const x of this.slotXs(this.field.mode)) this.fx.spawn('sparkle_blue_s', x, L.slotY, t)
    }
    const change = this.field.nextChange(t)
    if (change && change.at - t <= this.barDur && beatI !== this.shiftTickBeat) {
      // one tick a beat while the countdown shows
      this.shiftTickBeat = beatI
      this.sfx('shift_tick')
    }
    if (this.field.atPinch(t) && t - this.pinched > 0.5) {
      this.pinched = t
      this.rings.push({ x: L.hwCx, y: L.slotY, t0: t, color: WHITE, r0: 5, r1: 16, dur: 0.4 })
    }
    // the goose reads ahead for an accent worth a heavy move
    planHeavy(this.fight.goose, this.visibleEvents(t), t, this.rng)

    // the stage: the phrase kind decides the look
    const duet = this.duetAt(t)
    const ph = this.phraseAt(t)
    const vibe = this.vibeAt(t)
    const kind = duet !== null ? 'duet' : (ph?.kind ?? 'words')
    void vibe
    if (kind === 'words' && this.voidSpans.some(([a, b]) => a <= t && t < b)) this.scene.setMode('void')
    else if (kind === 'anchor') this.scene.setMode('night')
    else this.scene.setMode('day')
    // a pattern phrase strobes: lightning on the downbeat
    if (kind === 'pattern' && beatI !== -1 && beatI % 4 === 0 && t - this.lightningT > this.barDur * 0.9) {
      this.lightningT = t
      const x = L.hwX0 + Math.floor(this.rng() * (L.hwX1 - L.hwX0))
      this.fx.spawn('lightning', x, L.groundY - 64, t, { ay: 1 })
      this.scene.flash(t, 0.05, 0.35)
    }

    this.scene.update(t, dt, this.energyS)
    this.drawBeatRows(t)
    this.drawDuetStrip(t, duet)
    this.drawAnchorLane(t)
    this.drawConnectors(t, rush)
    this.drawGround(t, rush)
    this.drawRings(t, rush)
    this.drawShift(t, change, beatI)
    this.drawNotes(t, rush)
    this.drawFight(t, beatI, beatP)
    this.fx.update(t)
    this.drawRingsFx(t)
    this.kanji.draw(t, this.scene.whiteOut(t))
    this.drawStamps(t)
    this.drawBig(t)
    this.drawWin(t)
    // the inverted frame, and the white-out where every figure goes black
    this.stage.filters = t < this.invertUntil ? [this.invertFilter] : []
    const white = this.scene.whiteOut(t)
    const { goose: g2, enemy: e2 } = this.fight
    g2.sprite.tint = white ? INK : WHITE
    e2.sprite.tint = white ? INK : WHITE
    if (duet !== null && t >= duet[0]) this.drawDuetBand(t)
    else this.drawWordBlock(t, rush)
    this.drawHud(t, dt, rush, duet)
    if (this.lives === 0 && t >= this.napUntil) this.lives = 1

    // the camera: whole pixels, on the beat when loud, kicked by a drop or a heavy blow
    const beatPulse = Math.max(0, 1 - (t - this.lineFlashT) / 0.3)
    const loud = Math.max(0, this.energyS - 0.6) / 0.4
    const dropAge = t - this.dropT
    let kick = dropAge >= 0 && dropAge < 0.3 ? Math.round((1 - dropAge / 0.3) * 3) : 0
    if (this.kickPx > 0) {
      if (this.kickT < 0) this.kickT = t
      const age = t - this.kickT
      if (age < 0.2) kick = Math.max(kick, Math.round((1 - age / 0.2) * this.kickPx))
      else { this.kickPx = 0; this.kickT = -1 }
    }
    const amp = Math.round(loud * beatPulse * 2) + kick
    if (amp > 0) {
      this.stage.x = Math.round(Math.sin(t * 97.3) * amp)
      this.stage.y = Math.round(Math.cos(t * 61.7) * amp * 0.7)
    } else { this.stage.x = 0; this.stage.y = 0 }

    // the end: the enemy falls if the goose landed enough, else it gloats
    if (!this.ended && this.rhythm.isFinished()) {
      this.ended = true
      this.endT = t
      const { enemy } = this.fight
      if (this.rhythm.getAccuracy() >= 70) {
        // DOWN! — the enemy is sent off the top of the screen, fighting-game style
        this.won = true
        enemy.flyOff(t)
        this.fx.spawn('explosion_s', enemy.x, enemy.y - 20, t)
        this.fight.goose.cheer(t)
        this.big('DOWN!', KB.GOLD, t, 1.1)
        this.sfx('down_card')
        this.sfx('throw_far', 0.1)
        this.invertUntil = t + 0.07
        this.scene.flash(t, 0.1, 0.8)
        const st = this.rhythm.getStats()
        if (Number(st.misses ?? 1) === 0) window.setTimeout(() => { this.bigWords = [{ text: 'FULL COMBO', color: KB.GOLD, t0: t + 1.2, dur: 1.2 }] }, 1200)
      } else {
        enemy.play(this.enemySpec.taunt, t, { fps: 10 })
      }
    }
  }

  /**
   * The song drops.  The whole screen flashes and the camera kicks; the ground
   * answers with a burst on every hit circle and the goose flares — nothing
   * appears in the middle of the air, because nothing is there.
   */
  private drop(t: number, size: string): void {
    this.dropT = t
    const big = size === 'large'
    this.scene.flash(t, big ? 0.12 : 0.06, big ? 0.85 : 0.5)
    const y = this.L.slotY
    for (const x of this.slotXs(this.field.mode)) {
      this.fx.spawn(big ? 'burst_ring_s' : 'sparkle_blue_s', x, y, t)
      this.rings.push({ x, y, t0: t, color: WHITE, r0: 10, r1: 16, dur: big ? 0.4 : 0.25 })
    }
    if (big) {
      const g = this.fight.goose
      this.fx.spawn('haste_s', g.x, g.y - 16, t, { follow: () => [g.sprite.x, g.y - 16] })
      this.sfx('boom')
      g.cheer(t)
      this.big('DROP!', WHITE, t, 0.7)
      // the world shifts: rays, the white-out, purple, red … in turn
      const kind = SHIFT_CYCLE[this.shiftI % SHIFT_CYCLE.length]
      this.shiftI += 1
      if (kind === 'white') { this.scene.shift('white', t, this.beatDur * 2); this.invertUntil = t + 0.07 }
      else this.scene.shift(kind, t, this.sectionLeft(t))
    } else if (this.rng() < 0.35) {
      this.scene.shift('gold', t, Math.min(this.sectionLeft(t), this.barDur * 4))
    }
  }

  /**
   * How long the music stays in the section it is in at `t`: to the end of
   * the phrase the chart knows about, or to where the bar vibes change — never
   * less than four bars, never more than sixteen.  A drop's colour stays on
   * that long, so the world does not flicker between looks mid-chorus.
   */
  private sectionLeft(t: number): number {
    let end = -1
    const ph = this.phraseAt(t)
    if (ph) end = ph.t1
    const bi = this.barT.findIndex((b, i) => b <= t && (i + 1 >= this.barT.length || this.barT[i + 1] > t))
    if (bi >= 0) {
      const v = this.barVibes[bi]
      let e = bi + 1
      while (e < this.barVibes.length && this.barVibes[e] === v) e += 1
      const vibeEnd = e < this.barT.length ? this.barT[e] : this.barT[this.barT.length - 1] + this.barDur
      end = end < 0 ? vibeEnd : Math.max(end, vibeEnd)
    }
    const left = end > t ? end - t : this.barDur * 8
    return Math.max(this.barDur * 4, Math.min(this.barDur * 16, left))
  }

  /** a big word across the highway, in the combo's face */
  private big(text: string, color: number, t: number, dur: number): void {
    this.bigWords = [{ text, color, t0: t, dur }]
  }

  private drawBig(t: number): void {
    const w = this.bigWords[0]
    if (!w || t - w.t0 > w.dur) { this.bigWords = []; this.bigText.visible = this.bigShadow.visible = false; return }
    const age = t - w.t0
    // pops in two pixels high, drops, then blinks out over the last fifth
    const pop = age < 0.06 ? -2 : 0
    const blink = age > w.dur * 0.8 && Math.floor(age * 20) % 2 === 1
    this.bigText.visible = this.bigShadow.visible = !blink
    this.bigText.text = this.bigShadow.text = w.text
    this.bigText.tint = w.color
    const x = this.L.hwCx, y = Math.round(this.L.h * 0.28) + pop
    this.bigText.x = x; this.bigText.y = y
    this.bigShadow.x = x + 2; this.bigShadow.y = y + 2
  }

  /** the enemy is sent flying: white speed lines from where it stood */
  private drawWin(t: number): void {
    const g = this.winGfx
    g.clear()
    if (!this.won || this.endT < 0) return
    const age = t - this.endT
    if (age > 0.6) return
    const { enemy } = this.fight
    const ox = enemy.x, oy = enemy.y - 24
    const n = 9
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * 0.62 + (i / (n - 1)) * Math.PI * 0.34 + (Math.floor(age * 30) % 2) * 0.02
      const r0 = 10 + Math.round(age * 60), r1 = r0 + 34
      g.moveTo(Math.round(ox + Math.cos(a) * r0), Math.round(oy + Math.sin(a) * r0))
        .lineTo(Math.round(ox + Math.cos(a) * r1), Math.round(oy + Math.sin(a) * r1))
        .stroke({ width: 1, color: WHITE, alpha: 0.9 })
    }
  }

  /**
   * The circles are about to rearrange: for the last bar before it, the
   * incoming set shows as hollow ghosts blinking on the beat, and the tag counts
   * the beats down and names what is coming.
   */
  private shiftGhosts: Sprite[] = []
  private shiftText: BitmapText | null = null
  private drawShift(t: number, change: { at: number; mode: FieldMode } | null, beatI: number): void {
    const L = this.L
    if (!this.shiftText) {
      this.shiftText = pxText('px8', '', KB.GOLD)
      this.hudLayer.addChild(this.shiftText)
    }
    for (const g of this.shiftGhosts) g.visible = false
    const show = change !== null && change.at - t <= this.barDur && change.at > t
    this.shiftText.visible = show
    if (!show || !change) return
    const xs = this.slotXs(change.mode)
    const [, phase] = this.beatPhase(t)
    const on = phase < 0.5
    for (let i = 0; i < xs.length; i++) {
      let g = this.shiftGhosts[i]
      if (!g) { g = new Sprite(this.tex.ghost); g.anchor.set(0.5); g.roundPixels = true; this.ringLayer.addChild(g); this.shiftGhosts.push(g) }
      g.visible = on
      g.tint = change.mode === 'onecircle' ? KB.GOLD : KB.laneColor(i)
      g.alpha = 0.8
      g.x = xs[i]
      g.y = L.slotY - 2 * ((beatI + i) % 2)   // a wobble, so they read as not-yet-here
    }
    const beatsLeft = Math.max(1, Math.ceil((change.at - t) / this.beatDur))
    this.shiftText.text = `${MODE_NAME[change.mode] ?? change.mode} IN ${beatsLeft}`
    this.shiftText.x = L.hwCx
    this.shiftText.y = L.slotY - 40
    this.shiftText.tint = change.mode === 'onecircle' ? KB.GOLD : WHITE
  }

  private drawFight(t: number, beatI: number, beatP: number): void {
    const { goose, enemy } = this.fight
    if (beatI >= 0) { goose.beat(beatI, beatP); enemy.beat(beatI, beatP) }
    if (this.pendingHurt >= 0 && t >= this.pendingHurt) {
      this.pendingHurt = -1
      goose.hurt(t)
      this.sfx('hurt')
      this.fx.spawn('puff_s', goose.x, goose.y - 12, t)
      this.stage.x += 2
    }
    goose.update(t)
    enemy.update(t)
  }

  private drawBeatRows(t: number): void {
    const L = this.L
    const g = this.rowGfx
    g.clear()
    const bt = this.beatTimesChart
    if (!bt.length) return
    const lo = Math.max(0, lowerBound(bt, t - 0.4) - 1)
    const hi = lowerBound(bt, t + this.approach + 0.2)
    for (let i = lo; i < hi; i++) {
      const y = Math.round(L.slotY - (bt[i] - t) * this.speed)
      if (y < 0 || y > L.slotY) continue
      const bar = i % 4 === 0
      g.rect(L.hwX0, y, L.hwX1 - L.hwX0, 1).fill({ color: WHITE, alpha: bar ? 0.35 : 0.15 })
    }
  }

  private drawConnectors(t: number, rush: boolean): void {
    const g = this.connGfx
    g.clear()
    const evs = this.visibleEvents(t)
    let prev: LiveEvent | null = null
    const missed = (e: LiveEvent) => !e.hit && t > e.timestamp + this.rhythm.okWindowFor(e)
    for (const ev of evs) {
      let col = WHITE
      if (rush) col = KB.GOLD
      else if (ev.voice >= 0) col = KB.laneColor(ev.voice === 0 ? 1 : 2)
      if (prev !== null && prev.word_id === ev.word_id && (!prev.hit || !ev.hit) && !missed(prev) && !missed(ev)) {
        const y0 = prev.hit ? this.L.slotY : Math.round(this.noteY(prev, t))
        const y1 = Math.round(this.noteY(ev, t))
        const x0 = this.xOfEv(prev), x1 = this.xOfEv(ev)
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1, color: col, alpha: 0.45 })
      }
      prev = ev
    }
  }

  /** the ground line under the circles: the grass edge lit on the beat */
  private drawGround(t: number, rush: boolean): void {
    const L = this.L
    const g = this.groundGfx
    g.clear()
    const flash = t - this.lineFlashT < 0.1
    const col = rush ? KB.GOLD : (flash ? WHITE : 0xd8dce8)
    // a dark mat under the circles, so the lane colours read against grass
    g.rect(L.hwX0, L.slotY - 13, L.hwX1 - L.hwX0, 26).fill({ color: 0x0a0c14, alpha: 0.45 })
    g.rect(L.hwX0, L.groundY - 1, L.hwX1 - L.hwX0, 1).fill({ color: col, alpha: flash ? 0.9 : 0.5 })
  }

  private drawRings(t: number, rush: boolean): void {
    const L = this.L
    const visible = this.visibleEvents(t)
    const p = this.field.swapProgress(t)
    const mode = p > 0 && p < 0.5 ? this.prevMode : this.field.mode
    const xs = this.slotXs(mode)
    // during a swap the circles are simply hidden at the pinch — a pixel circle
    // cannot shrink, so it blinks out and the new set blinks in
    const hidden = p > 0.3 && p < 0.7
    for (let i = 0; i < this.ringSprites.length; i++) {
      const s = this.ringSprites[i]
      const x = xs[i]
      if (x === undefined || hidden) { s.visible = false; continue }
      s.visible = true
      let armed = false
      for (const ev of visible) {
        if (ev.hit || this.modeOf(ev) !== mode || slotOf(ev.char, mode) !== i) continue
        if (ev.timestamp - t >= 0 && ev.timestamp - t < 0.3) { armed = true; break }
      }
      const lane = mode === 'lanes' ? i : -1
      const hitAge = lane >= 0 ? t - this.ringHitT[lane] : 99
      const missAge = lane >= 0 ? t - this.ringMissT[lane] : 99
      let color = mode === 'onecircle' ? KB.GOLD : this.laneCol(i)
      if (hitAge >= 0 && hitAge < 0.08) color = WHITE
      if (missAge >= 0 && missAge < 0.3) color = KB.MISS_RED
      if (rush) color = KB.GOLD
      s.tint = color
      s.alpha = armed ? 1 : 0.8
      s.x = x
      s.y = L.slotY
      const o = this.ringOutlines[i]
      o.visible = true
      o.x = x
      o.y = L.slotY
    }
    for (let i = 0; i < this.ringOutlines.length; i++) {
      if (xs[i] === undefined || hidden) this.ringOutlines[i].visible = false
    }
  }

  // ── notes ────────────────────────────────────────────────────────────────
  private acquireNote(): NoteNode {
    const o = this.notePool.pop()
    if (o) { o.visible = true; this.notesInUse.push(o); return o }
    const node = new Container() as NoteNode
    node.tail = new Graphics()
    node.outer = new Sprite(this.tex.outer); node.outer.anchor.set(0.5)
    node.outline = new Sprite(this.tex.outline); node.outline.anchor.set(0.5); node.outline.tint = INK
    node.body = new Sprite(this.tex.disc); node.body.anchor.set(0.5)
    node.glyph = pxText('px8', '', INK)
    node.arrow = new Sprite(this.tex.arrow_l); node.arrow.anchor.set(0.5); node.arrow.tint = INK
    node.petal = new Sprite(this.tex.petal); node.petal.anchor.set(0.5)
    node.addChild(node.tail, node.outer, node.outline, node.body, node.glyph, node.arrow, node.petal)
    this.noteLayer.addChild(node)
    this.notesInUse.push(node)
    return node
  }

  private releaseNotes(): void {
    for (const o of this.notesInUse) { o.visible = false; this.notePool.push(o) }
    this.notesInUse = []
  }

  private drawNotes(t: number, rush: boolean): void {
    const L = this.L
    this.releaseNotes()
    const activeHold = this.rhythm.activeHold
    for (const ev of this.visibleEvents(t)) {
      const g = this.geom.get(ev._uid)
      if (!g) continue
      const { lane, w } = g
      const y = this.noteY(ev, t)
      const isActiveHold = activeHold === ev
      if (ev.hit && !isActiveHold) continue
      const okW = this.rhythm.okWindowFor(ev)
      const missedAge = (t - ev.timestamp) - okW
      const deadHold = missedAge > 0 && !ev.hit && ev.hold_duration > 0
      if (missedAge > 0 && !ev.hit && !deadHold) {
        // a missed note blinks red and is gone: two frames, then nothing
        if (missedAge > 0.12) continue
        const node = this.acquireNote()
        node.x = this.xOfEv(ev); node.y = Math.round(y)
        node.tail.clear(); node.outer.visible = false; node.petal.visible = false
        node.outline.visible = true
        node.body.visible = true; node.body.tint = KB.MISS_RED; node.body.alpha = 1
        this.noteGlyph(node, ev, INK)
        node.glyph.alpha = 1
        node.glyph.y = 0
        node.alpha = 1
        continue
      }
      if (y < -20) continue
      if (deadHold && t > ev.timestamp + ev.hold_duration + 0.25) continue

      const node = this.acquireNote()
      const cy = Math.round(isActiveHold ? Math.min(y, L.slotY) : y)
      const isGrace = ev.section_kind === 'grace'
      const fx = this.xOfEv(ev)
      node.x = isGrace ? fx - 10 : fx
      node.y = cy
      node.alpha = 1
      const evMode = this.modeOf(ev)
      const col = this.scene.mode === 'void' ? WHITE : (rush ? KB.GOLD : (evMode === 'onecircle' ? KB.GOLD : KB.laneColor(slotOf(ev.char, evMode))))
      // fade-in over the first 12% of the fall, in three hard steps
      const kIn = (y - L.spawnY) / (L.fallPx * 0.12)
      node.alpha = kIn < 1 ? stepA(Math.max(0, kIn), 3) : 1

      node.tail.clear()
      if (ev.hold_duration > 0) {
        const endY = Math.round(L.slotY - (ev.timestamp + ev.hold_duration - t) * this.speed)
        const top = Math.max(-20, endY)
        const bottom = isActiveHold ? L.slotY : cy
        if (bottom - top > 2) {
          const anchor = ev.section_kind === 'anchor'
          const tcol = deadHold ? DEAD_HOLD : (anchor ? this.laneCol(lane) : KB.GOLD)
          const tw = anchor ? 6 : 4
          node.tail.rect(-tw / 2 - 1, top - cy, tw + 2, bottom - top).fill({ color: INK, alpha: deadHold ? 0.4 : 0.8 })
          node.tail.rect(-tw / 2, top - cy + 1, tw, bottom - top - 1).fill({ color: tcol, alpha: deadHold ? 0.5 : 0.9 })
        }
      }
      node.outer.visible = w >= 4 && !isGrace
      node.outer.tint = col
      node.outline.visible = true
      node.body.visible = true
      node.body.tint = deadHold ? DEAD_HOLD : (ev.hold_duration > 0 ? KB.GOLD : (w >= 2 ? col : 0xf2f2f8))
      this.noteGlyph(node, ev, deadHold ? 0x8a8498 : INK)
      node.glyph.x = 0
      node.glyph.y = 0
      node.petal.visible = ev.char_idx === 0 && ev.voice < 0 && !isGrace
      node.petal.tint = WHITE
      node.petal.x = -8
      node.petal.y = -10
    }
  }

  /** the letter on a note — or, in the onecircle stage, the arrow it is played on */
  private noteGlyph(node: NoteNode, ev: LiveEvent, tint: number): void {
    const arrow = this.modeOf(ev) === 'onecircle' ? ARROW_OF[ev.char.toLowerCase()] : undefined
    node.glyph.visible = !arrow
    node.arrow.visible = Boolean(arrow)
    if (arrow) { node.arrow.texture = this.tex[arrow]; node.arrow.tint = tint }
    else { node.glyph.text = ev.char.toUpperCase(); node.glyph.tint = tint }
  }

  // ── holds and duets ──────────────────────────────────────────────────────
  private drawAnchorLane(t: number): void {
    const L = this.L
    const g = this.anchorGfx
    g.clear()
    for (const k of this.anchorKeys) k.visible = false
    for (const b of this.anchorLabels) b.visible = false
    for (const [lane, [t0, kind]] of [...this.anchorFades]) {
      const age = t - t0
      const dur = kind === 'broke' ? 0.3 : 0.4
      if (age >= dur) { this.anchorFades.delete(lane); continue }
      const col = kind === 'broke' ? KB.MISS_RED : KB.GOLD
      g.rect(L.laneX0(lane), 0, L.laneW, L.slotY).fill({ color: col, alpha: stepA(0.25 * (1 - age / dur)) })
    }
    let slot = 0
    for (const [lane, ev] of this.anchorsOn) {
      const col = this.laneCol(lane)
      const prog = clamp((t - ev.timestamp) / Math.max(1e-3, ev.hold_duration), 0, 1)
      const cx = L.laneCenter(lane)
      g.rect(L.laneX0(lane), 0, L.laneW, L.slotY).fill({ color: col, alpha: 0.15 })
      const h = Math.round(L.slotY * (1 - prog))
      g.rect(cx - 3, L.slotY - h, 6, h).fill({ color: INK, alpha: 0.7 })
      g.rect(cx - 2, L.slotY - h + 1, 4, Math.max(0, h - 1)).fill({ color: col })
      if (slot < this.anchorKeys.length) {
        const key = this.anchorKeys[slot]
        key.text = ev.char.toUpperCase(); key.x = cx; key.y = L.slotY - 1; key.visible = true
        const lbl = this.anchorLabels[slot]
        lbl.tint = col; lbl.x = cx; lbl.y = L.slotY + 16; lbl.visible = true
        slot += 1
      }
    }
  }

  private drawDuetStrip(t: number, duet: [number, number, string] | null): void {
    const L = this.L
    const g = this.duetGfx
    g.clear()
    if (duet === null) { this.heat = [0, 0]; this.lockT = -9; return }
    const [t0, t1] = duet
    const k = clamp((t - (t0 - 2 * this.barDur)) / this.beatDur, 0, 1) * clamp((t1 - t) / (2 * this.beatDur), 0, 1)
    if (k <= 0) return
    const voice = this.activeVoice(t)
    const locked = this.lockT >= 0 && this.heat[0] >= 3 && this.heat[1] >= 3
    for (let lane = 0; lane < 4; lane++) {
      const hand = lane < 2 ? 0 : 1
      let a: number
      if (voice < 0) a = 0.5
      else if (hand === voice) a = 0.45 + 0.55 * Math.min(1, this.heat[hand] / 3)
      else a = 0.18
      const col = this.laneCol(lane)
      g.rect(L.laneX0(lane), 0, L.laneW, L.slotY).fill({ color: col, alpha: stepA(0.2 * a * k) })
      g.rect(L.laneX0(lane), 0, 1, L.slotY).fill({ color: col, alpha: stepA(0.5 * k) })
    }
    if (locked) g.rect(L.hwX0, 0, L.hwX1 - L.hwX0, L.slotY).fill({ color: KB.GOLD, alpha: 0.12 })
  }

  private drawDuetBand(t: number): void {
    const L = this.L
    for (const g of this.wordGlyphs) g.visible = false
    for (const g of this.wordFlashGlyphs) g.visible = false
    this.queueText.visible = false
    this.wordCaret.clear()
    const voice = this.activeVoice(t)
    if (voice < 0) return
    const col = KB.laneColor(voice === 0 ? 1 : 2)
    const cx = L.hwCx, cy = L.wordY
    // a pixel arrow: three rows
    const d = voice === 0 ? -1 : 1
    this.wordCaret.rect(cx - 6, cy - 1, 12, 3).fill({ color: col })
    this.wordCaret.rect(cx + d * 6, cy - 3, 2, 7).fill({ color: col })
    this.wordCaret.rect(cx + d * 8, cy - 2, 2, 5).fill({ color: col })
    this.wordCaret.rect(cx + d * 10, cy - 1, 2, 3).fill({ color: col })
  }

  // ── effects ──────────────────────────────────────────────────────────────
  private acquireStamp(): BitmapText {
    const s = this.stampPool.pop()
    if (s) { s.visible = true; this.stampsInUse.push(s); return s }
    const n = pxText('px8')
    this.stampLayer.addChild(n)
    this.stampsInUse.push(n)
    return n
  }

  private drawStamps(t: number): void {
    for (const s of this.stampsInUse) { s.visible = false; this.stampPool.push(s) }
    this.stampsInUse = []
    this.stamps = this.stamps.filter((st) => {
      const age = t - st.t0
      if (age > 0.5) return false
      const n = this.acquireStamp()
      n.text = st.text
      n.tint = st.color
      // rises in 2 px steps every 60 ms, blinks off near the end
      n.alpha = age < 0.34 ? 1 : (Math.floor(age * 20) % 2 === 0 ? 1 : 0.3)
      n.x = st.x
      n.y = st.y - 2 * Math.floor(age / 0.06)
      return true
    })
  }

  /** expanding pixel rings: drawn from the baked ring textures by radius */
  private ringSpritesFx: Sprite[] = []
  private drawRingsFx(t: number): void {
    for (const s of this.ringSpritesFx) s.visible = false
    let i = 0
    this.rings = this.rings.filter((r) => {
      const age = t - r.t0
      if (age > r.dur) return false
      const k = age / r.dur
      const rad = Math.round(r.r0 + (r.r1 - r.r0) * k)
      const name = [5, 6, 7, 8, 9, 10, 11, 12, 14, 16].reduce((a, b) => Math.abs(b - rad) < Math.abs(a - rad) ? b : a)
      let s = this.ringSpritesFx[i]
      if (!s) { s = new Sprite(); s.anchor.set(0.5); s.roundPixels = true; this.ringGfx.addChild(s); this.ringSpritesFx.push(s) }
      i += 1
      s.visible = true
      s.texture = this.assets.ui(`ring${name}`)
      s.tint = r.color
      s.alpha = stepA(1 - k, 3)
      s.x = r.x
      s.y = r.y
      return true
    })
    this.drawMilestone(t)
  }

  private drawMilestone(t: number): void {
    if (this.milestone === null) { this.milestoneText.visible = false; return }
    const [n, t0] = this.milestone
    const age = t - t0
    if (age > 1.0) { this.milestone = null; this.milestoneText.visible = false; return }
    const [cx, cy] = this.L.comboPos
    this.milestoneText.visible = true
    this.milestoneText.text = `${n} COMBO`
    this.milestoneText.alpha = age < 0.7 ? 1 : (Math.floor(age * 16) % 2 === 0 ? 1 : 0)
    this.milestoneText.x = cx
    this.milestoneText.y = cy - 2 * Math.floor(age / 0.1)
  }

  // ── word block ───────────────────────────────────────────────────────────
  private wordSlotX(n: number, idx: number): number {
    const adv = this.L.wordAdvance
    return this.L.hwCx - Math.round(((n - 1) * adv) / 2) + idx * adv
  }

  private drawWordBlock(t: number, rush: boolean): void {
    const L = this.L
    const evs = this.rhythm.currentWordEvents()
    const y = L.wordY
    this.wordCaret.clear()
    const word = evs.length ? evs[0].word_text : ''
    for (let i = this.wordGlyphs.length; i < word.length; i++) {
      const g = pxText('px8')
      this.wordLayer.addChild(g)
      this.wordGlyphs.push(g)
    }
    for (const g of this.wordGlyphs) g.visible = false
    for (const a of this.wordArrows) a.visible = false
    const arrows = evs.length > 0 && this.modeOf(evs[0]) === 'onecircle'
    if (evs.length) {
      const n = word.length
      const byIdx = new Map(evs.map((e) => [e.char_idx, e]))
      const curEv = this.rhythm.currentEvent()
      let curIdx = (curEv !== null && !curEv.is_rest && curEv.word_id === evs[0].word_id) ? curEv.char_idx : -1
      const hold = this.rhythm.activeHold
      if (hold !== null && hold.word_id === evs[0].word_id) curIdx = hold.char_idx
      for (let i = 0; i < n; i++) {
        let g: BitmapText | Sprite = this.wordGlyphs[i]
        const arrowName = arrows ? ARROW_OF[word[i].toLowerCase()] : undefined
        if (arrowName) {
          // the stage is played on arrows: show the arrows, in the stage's gold
          let a = this.wordArrows[i]
          if (!a) { a = new Sprite(); a.anchor.set(0.5); a.roundPixels = true; this.wordLayer.addChild(a); this.wordArrows.push(a) }
          a.texture = this.tex[arrowName]
          g = a
        } else {
          (g as BitmapText).text = word[i].toUpperCase()
        }
        g.visible = true
        g.x = this.wordSlotX(n, i)
        g.y = y
        const e = byIdx.get(i)
        const laneCol = (ev: LiveEvent) => (arrows ? KB.GOLD : KB.laneColor(ev.lane))
        if (e === undefined) { g.tint = DIM; g.alpha = 1 }
        else if (e.hit) { g.tint = rush ? KB.GOLD : laneCol(e); g.alpha = 1 }
        else if (i === curIdx) {
          g.tint = WHITE; g.alpha = 1
          const on = this.beatPhase(t)[1] < 0.5
          this.wordCaret.rect(g.x - 4, y + 6, 8, 1).fill({ color: laneCol(e), alpha: on ? 1 : 0.4 })
        } else { g.tint = 0xb8b4c8; g.alpha = 1 }
      }
    }
    // the finished word lifts off in steps
    const age = t - this.wordFlashT
    for (const g of this.wordFlashGlyphs) g.visible = false
    if (this.wordFlash !== null && age >= 0 && age < 0.4) {
      const [fw, clean] = this.wordFlash
      for (let i = this.wordFlashGlyphs.length; i < fw.length; i++) {
        const g = pxText('px8')
        this.wordLayer.addChild(g)
        this.wordFlashGlyphs.push(g)
      }
      for (let i = 0; i < fw.length; i++) {
        const g = this.wordFlashGlyphs[i]
        g.visible = true
        g.text = fw[i].toUpperCase()
        g.tint = (clean || rush) ? KB.GOLD : KB.laneColor(KB.laneOf(fw[i]))
        g.alpha = age < 0.25 ? 1 : 0.5
        g.x = this.wordSlotX(fw.length, i)
        g.y = y - 2 * Math.floor(age / 0.05)
      }
    }
    // the next word, dim, under it
    const upcoming = this.rhythm.upcomingWords(1)
    this.queueText.visible = upcoming.length > 0
    if (upcoming.length) {
      const next = upcoming[0]
      // a coming arrow word is shown in ascii arrows, since the font has none
      const nc = this.field.nextChange(t)
      const arrowsSoon = this.field.mode === 'onecircle'
        || (nc !== null && nc.mode === 'onecircle' && nc.at - t < 2 * this.barDur)
      const arrowWord = arrowsSoon && next.length > 0 && next.split('').every((c) => c.toLowerCase() in ARROW_ASCII)
      this.queueText.text = arrowWord ? next.split('').map((c) => ARROW_ASCII[c.toLowerCase()]).join('') : next.toUpperCase()
      this.queueText.tint = DIM
      this.queueText.x = L.hwCx
      this.queueText.y = L.queueY
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  private drawHud(t: number, dt: number, rush: boolean, duet: [number, number, string] | null): void {
    const L = this.L
    const g = this.hudGfx
    g.clear()
    // the HUD band: numbers need a dark ground on a bright sky
    g.rect(0, 0, L.w, 12).fill({ color: 0x0a0c14, alpha: 0.55 })
    const target = this.rhythm.getScore()
    this.scoreShown += (target - this.scoreShown) * Math.min(1, 8 * dt)
    if (Math.abs(target - this.scoreShown) < 2) this.scoreShown = target
    this.scoreText.text = String(Math.trunc(this.scoreShown)).padStart(7, '0')
    ;[this.scoreText.x, this.scoreText.y] = L.scorePos
    this.multText.text = `x${this.comboTier}`
    this.multText.x = L.scorePos[0] + 64
    this.multText.y = L.scorePos[1]

    // rush bar
    const [bx, by, bw, bh] = L.rushBar
    g.rect(bx - 1, by - 1, bw + 2, bh + 2).fill({ color: INK, alpha: 0.8 })
    let fill = this.rushCharge
    if (rush) fill = Math.max(0, (this.rushUntil - t) / (C.RUSH_BARS * this.barDur))
    if (fill > 0) g.rect(bx, by, Math.max(1, Math.round(bw * fill)), bh).fill({ color: KB.GOLD })

    // lives: three dots
    const [lx, ly] = L.livesPos
    for (let i = 0; i < C.LIVES; i++) {
      const on = i < this.lives
      const blink = this.lives === 1 && i === 0 && Math.floor(t * 6) % 2 === 0
      g.rect(lx + i * 7, ly, 5, 5).fill({ color: on ? (blink ? WHITE : KB.laneColor(0)) : 0x2a2636 })
    }

    this.accText.text = `${this.rhythm.getAccuracy().toFixed(1)}%`
    ;[this.accText.x, this.accText.y] = L.accPos

    // combo, big, over the highway
    const combo = this.rhythm.combo
    this.comboText.visible = combo >= 5 && this.milestone === null && this.bigWords.length === 0
    this.comboShadow.visible = this.comboText.visible
    if (this.comboText.visible) {
      this.comboText.text = String(combo)
      this.comboShadow.text = this.comboText.text
      this.comboText.tint = rush ? KB.GOLD : WHITE
      ;[this.comboText.x, this.comboText.y] = L.comboPos
      this.comboShadow.x = this.comboText.x + 1
      this.comboShadow.y = this.comboText.y + 1
    }

    // progress along the top edge
    const dur = Math.max(1, this.song.duration)
    const prog = clamp((t - this.leadIn) / dur, 0, 1)
    g.rect(0, 0, L.w, 2).fill({ color: 0x1c1a26 })
    g.rect(0, 0, Math.round(L.w * prog), 2).fill({ color: rush ? KB.GOLD : 0x64c8ff })

    // the enemy's health: a slice per note landed
    const { enemy } = this.fight
    if (!enemy.flying) {
      const hp = Math.max(0, 1 - this.hitsLanded / this.totalNotes)
      const hx = enemy.x - HP_W / 2, hy = enemy.y - 50
      g.rect(hx - 1, hy - 1, HP_W + 2, 5).fill({ color: INK })
      g.rect(hx, hy, Math.round(HP_W * hp), 3).fill({ color: hp > 0.5 ? 0xe04848 : 0xff9a3a })
    }

    // the count-in title
    const showTitle = Boolean(this.title) && t <= this.leadIn
    this.titleText.visible = showTitle
    if (showTitle) { this.titleText.x = L.hwCx; this.titleText.y = 24 }

    const ph = this.phraseAt(t)
    const tag = ph ? (SECTION_TAG[ph.kind] ?? '') : ''
    this.tagText.visible = Boolean(tag) && duet === null
    if (tag) { this.tagText.text = tag; [this.tagText.x, this.tagText.y] = L.tagPos }
    this.duetText.visible = duet !== null && t >= duet[0] - 2 * this.barDur
    if (this.duetText.visible) { [this.duetText.x, this.duetText.y] = L.tagPos }
  }

  destroy(): void {
    this.fx.clear()
    this.stage.destroy({ children: true })
  }
}

/**
 * Where the lights go out: a run of at least two quiet bars that follows a
 * loud one — the breakdown after a chorus, not the intro.  At most three a song,
 * so black stays an event.  Chart time.
 */
export function findVoids(vibes: string[], barT: number[], barDur: number): [number, number][] {
  const out: [number, number][] = []
  const n = Math.min(vibes.length, barT.length)
  let b = 0
  while (b < n && out.length < 3) {
    if (vibes[b] === 'sustain' && b >= 2 && (vibes[b - 1] === 'burst' || vibes[b - 1] === 'drive')) {
      let e = b
      while (e < n && vibes[e] === 'sustain') e += 1
      if (e - b >= 2) out.push([barT[b], (e < n ? barT[e] : barT[n - 1] + barDur)])
      b = e
    } else b += 1
  }
  return out
}
