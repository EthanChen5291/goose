/**
 * PixelDuel — the second mode: the fight itself, up close and in 3D.
 *
 * The camera sits behind the goose looking down a slab of dark glass at the
 * enemy, who throws the song at you: every note of the chart is an attack that
 * leaves the enemy `preempt` seconds early and arrives exactly on the beat.
 * The keys are D F J K and Space, arrow keys in all but name —
 *
 *   D  step left      a laser wall covers the middle and the right
 *   K  step right     a laser wall covers the middle and the left
 *   F  flatten        a blade at neck height
 *   Space  jump       a wave along the floor
 *   J  peck           an orb, sent back into the enemy — or, on a downbeat,
 *                     the enemy itself rushing in, pecked back down the lane
 *
 * A dodge in time is also a hit: the goose answers every one with a bolt from
 * the beak, the enemy flashes white and loses a slice of health, and the big
 * ones stamp a kanji.  A miss connects: the goose is knocked back, the screen
 * flashes red, HP drops.  The judgment, the score, the combo and the HP are
 * the same as the other mode's; the arrow keys and Space are aliased onto the
 * letters so the judgment core need not know.
 *
 * The 3D is drawn by `duel3d.ts` into a canvas the size of the pixel buffer,
 * shown here as a sprite under the pixel HUD, effect strips and kanji.
 */
import { CanvasSource, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { BitmapText } from 'pixi.js'

import type { Layout } from '../core/layout'
import type { ChartMeta, Song } from '../core/models'
import type { LiveEvent, RhythmManager } from '../core/rhythm'
import type { PlayRenderer } from '../render/renderer'
import * as KB from '../core/keyboard'

import type { PxAssets } from './assets'
import type { PixelCanvas } from './canvas'
import { FxLayer } from './fx'
import { KanjiLayer } from './kanji'
import { pxText } from './text'
import type { LevelSpec } from './levels'
import { weightOfTime, mulberry32, lowerBound } from './chartmath'
import { DuelWorld, loadEnemyVoxels } from './duel3d'
import type { AttackKind, DodgeKind } from './duel3d'

const WHITE = 0xffffff
const INK = 0x17181a
const STAMP_COLORS: Record<string, number> = {
  perfect: KB.GOLD, good: 0x83e3b0, ok: 0xaed0e6, miss: KB.MISS_RED, slip: 0xaaaabe,
}
const STAMP_TEXT: Record<string, string> = { perfect: 'PERFECT', good: 'GREAT', ok: 'OK', miss: 'MISS' }
const PREEMPT: Record<string, number> = { journey: 1.6, classic: 1.2, master: 0.9, demon: 0.7 }
const HP_LOSS: Record<string, [number, number]> = {
  journey: [8, 2], classic: [12, 4], master: [15, 5], demon: [20, 6],
}

/** the keys, and what each answers */
const DODGE: Record<string, DodgeKind> = { d: 'left', f: 'duck', j: 'strike', k: 'right', '^': 'jump' }
const LABEL: Record<string, string> = { d: 'D', f: 'F', j: 'J', k: 'K', '^': 'SPACE' }
const COLOR: Record<string, number> = { d: 0xff86e4, f: 0xff9d45, j: 0x6cbcff, k: 0x6cf5a8, '^': KB.GOLD }
const LANE: Record<string, number> = { d: 0, f: 1, j: 2, k: 3, '^': 2 }
const ARROW_KEY: Record<string, string> = { ArrowLeft: 'd', ArrowDown: 'f', ArrowUp: 'j', ArrowRight: 'k' }
const KEYS = ['d', 'f', 'j', 'k', '^']
const DODGE_SFX: Record<DodgeKind, string> = { left: 'whoosh', right: 'whoosh', duck: 'dash', jump: 'jump', strike: 'bat' }

interface Spec { key: string; dodge: DodgeKind; attack: AttackKind; side: number; id: number }
interface Stamp { text: string; color: number; x: number; y: number; t0: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export class PixelDuel implements PlayRenderer {
  readonly stage = new Container()
  sfx: (name: string, delay?: number) => void = () => {}

  hp = 100
  failed = false
  won = false
  private readonly noFail: boolean
  private readonly hpLossMiss: number
  private readonly hpLossSlip: number
  readonly preempt: number
  private readonly leadIn: number
  private beatTimesChart: number[]
  private barT: number[] = []
  private barEnergy: number[] = []

  private world: DuelWorld
  private view = new Sprite()
  private fx: FxLayer
  private kanji: KanjiLayer
  private labelLayer = new Container()
  private stampLayer = new Container()
  private hudGfx = new Graphics()
  private hudLayer = new Container()
  private flashGfx = new Graphics()

  private specs = new Map<number, Spec>()
  private playable: LiveEvent[] = []
  private spawnIdx = 0
  private w = 0
  private h = 0

  private stamps: Stamp[] = []
  private stampPool: BitmapText[] = []
  private stampsInUse: BitmapText[] = []
  private labelPool: BitmapText[] = []
  private labelsInUse: BitmapText[] = []
  private keyText: BitmapText[] = []
  private scoreText: BitmapText
  private accText: BitmapText
  private comboText: BitmapText
  private comboShadow: BitmapText
  private titleText: BitmapText
  private failText: BitmapText
  private scoreShown = 0
  private pendingHurt = -1
  private redFlashT = -9
  private keyFlash: Record<string, number> = { d: -9, f: -9, j: -9, k: -9, '^': -9 }
  private ended = false
  private hitsLanded = 0
  private enemySpec: LevelSpec['enemy']
  /** how many of each attack were thrown, for the probes */
  readonly counts: Record<string, number> = { wall: 0, slash: 0, wave: 0, orb: 0, lunge: 0, hurt: 0, counters: 0 }

  constructor(
    private canvas: PixelCanvas,
    assets: PxAssets,
    private readonly song: Song,
    private readonly rhythm: RhythmManager,
    readonly difficulty: string,
    settings: Record<string, unknown>,
    private readonly title: string,
    level: LevelSpec,
  ) {
    const speedMult = Math.max(0.25, Number(settings.speed_mult ?? 1))
    this.preempt = Math.max(PREEMPT[difficulty] ?? 1.2, (1.5 * 60) / Math.max(40, song.bpm)) / speedMult
    this.leadIn = rhythm.leadIn
    this.beatTimesChart = song.beat_times.map((b) => b + this.leadIn)
    const [lm, ls] = HP_LOSS[difficulty] ?? [12, 4]
    this.hpLossMiss = lm
    this.hpLossSlip = ls
    this.noFail = Boolean(settings.no_fail)
    this.enemySpec = level.enemy

    this.world = new DuelWorld({
      onCounterLand: (t, big, kind) => this.counterLanded(t, big, kind),
      onLand: (t) => { const [x, y] = this.world.gooseFeet(); this.fx.spawn('dust_s', x, y, t); this.sfx('thud') },
    }, Math.max(1, canvas.w), Math.max(1, canvas.h))
    const sky = assets.manifest.scenes.find((s) => s.id === level.scene) ?? assets.manifest.scenes[0]
    if (sky) this.world.setSky(sky)
    void loadEnemyVoxels(assets.manifest, level.enemy.char).then((v) => this.world.setEnemy(v, level.enemy.char))

    this.fx = new FxLayer(assets)
    this.kanji = new KanjiLayer(assets)
    this.view.roundPixels = true

    this.scoreText = pxText('px8'); this.scoreText.anchor.set(0, 0)
    this.accText = pxText('px8'); this.accText.anchor.set(1, 0)
    this.comboText = pxText('px16')
    this.comboShadow = pxText('px16', '', INK)
    this.titleText = pxText('px8', title)
    this.failText = pxText('px16', 'FAILED', KB.MISS_RED)
    this.failText.visible = false
    for (const k of KEYS) { const tx = pxText('px8', LABEL[k], WHITE); this.keyText.push(tx); this.hudLayer.addChild(tx) }

    this.stage.addChild(this.view, this.fx.container, this.kanji.container, this.labelLayer, this.stampLayer, this.hudLayer, this.flashGfx)
    this.hudLayer.addChild(this.hudGfx, this.scoreText, this.accText, this.comboShadow, this.comboText, this.titleText, this.failText)
    this.plan()
    this.relayout()
  }

  // ── the plan: every note becomes one attack ───────────────────────────────
  /**
   * The chart's letters are only a rhythm here.  Runs of fast notes become a
   * zigzag of walls, a volley of orbs, or blade-wave-blade; single notes go by
   * weight — downbeats jump or peck the rushing enemy, backbeats sidestep on
   * the letter's own hand.  Two jumps can't come within half a second, and a
   * wall never repeats its side back to back.
   */
  private plan(): void {
    const evs = this.rhythm.beatMap.filter((e) => !e.is_rest && e.char)
    const rng = mulberry32(777)
    let prevKey = ''
    let prevT = -9
    let lastJump = -9
    let run: 'zig' | 'orbs' | 'dj' | null = null
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]
      if (ev.weight < 0) ev.weight = weightOfTime(ev.timestamp - this.leadIn, this.song.beat_times, this.song.bpm)
      const gap = ev.timestamp - prevT
      const nextGap = i + 1 < evs.length ? evs[i + 1].timestamp - ev.timestamp : 9
      const side = KB.handOf(ev.char) === 0 ? 'd' : 'k'
      const other = side === 'd' ? 'k' : 'd'
      const rapid = gap < 0.21 || nextGap < 0.21
      let key: string
      if (rapid) {
        if (gap >= 0.21 || run === null) { const r = rng(); run = r < 0.5 ? 'zig' : r < 0.8 ? 'orbs' : 'dj' }
        if (run === 'zig') key = prevKey === side ? other : side
        else if (run === 'orbs') key = 'j'
        else key = prevKey === 'f' && ev.timestamp - lastJump > 0.5 ? '^' : 'f'
      } else {
        run = null
        const r = rng()
        const w = ev.weight
        if (w >= 4) key = r < 0.45 ? '^' : r < 0.75 ? 'j' : 'f'
        else if (w === 3) key = r < 0.4 ? 'f' : r < 0.7 ? '^' : 'j'
        else if (w === 2) key = r < 0.7 ? side : 'j'
        else key = r < 0.6 ? side : r < 0.8 ? 'f' : 'j'
        if (key === prevKey && gap < 0.4 && (key === 'd' || key === 'k')) key = other
      }
      if (key === '^' && ev.timestamp - lastJump < 0.5) key = 'f'
      if (key === '^') lastJump = ev.timestamp
      const dodge = DODGE[key]
      let attack: AttackKind = dodge === 'strike' ? 'orb' : dodge === 'duck' ? 'slash' : dodge === 'jump' ? 'wave' : 'wall'
      if (dodge === 'strike' && ev.weight >= 3 && gap >= 0.7 && nextGap >= 0.55 && !rapid) attack = 'lunge'
      ev.char = key
      ev.lane = LANE[key]
      this.specs.set(ev._uid, { key, dodge, attack, side: dodge === 'left' ? 1 : dodge === 'right' ? -1 : 0, id: -1 })
      prevKey = key
      prevT = ev.timestamp
    }
    this.playable = evs
  }

  // ── layout ───────────────────────────────────────────────────────────────
  setSections(meta: ChartMeta): void {
    this.barT = (meta.bar_start ?? []).map((t) => t + this.leadIn)
    this.barEnergy = meta.bar_energy ?? []
  }
  setDuets(): void { /* no duets in the duel */ }
  tryRush(): boolean { return false }
  rushActive(): boolean { return false }
  setLayout(_layout: Layout): void { this.relayout() }

  /** Space and the arrow keys stand for the five letters the notes were rewritten to */
  keyAlias(key: string): string | null {
    if (key === ' ') return '^'
    return ARROW_KEY[key] ?? null
  }

  relayout(): void {
    this.w = this.canvas.w
    this.h = this.canvas.h
    this.world.resize(this.w, this.h)
    const old = this.view.texture
    this.view.texture = new Texture({ source: new CanvasSource({ resource: this.world.canvas, scaleMode: 'nearest' }) })
    if (old !== Texture.EMPTY) old.destroy(true)
    this.view.x = 0; this.view.y = 0
  }

  // ── events from the session ──────────────────────────────────────────────
  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    this.hp = Math.min(100, this.hp + 1)
    this.hitsLanded += 1
    this.stamp(judgment, offsetMs, t)
    const sp = this.specs.get(ev._uid)
    if (sp) {
      this.world.gooseDo(sp.dodge, t)
      this.world.resolve(sp.id, true, t)
      this.keyFlash[sp.key] = t
      this.sfx(DODGE_SFX[sp.dodge])
      if (sp.dodge === 'left' || sp.dodge === 'right') {
        const [x, y] = this.world.gooseFeet()
        this.fx.spawn('dust_s', x, y, t)
      }
      // the answer: a bolt from the beak, unless the peck itself is the answer
      if (sp.attack !== 'orb' && sp.attack !== 'lunge') {
        const big = ev.weight >= 3 || (judgment === 'perfect' && this.rhythm.combo > 0 && this.rhythm.combo % 8 === 0)
        this.world.counter(t + 0.1, big)
        this.sfx('peck', 0.1)
      }
    }
    const combo = this.rhythm.combo
    if ([25, 50, 100, 150, 200, 300].includes(combo)) {
      this.sfx('combo')
      this.fx.spawn('firework_yellow', Math.round(this.w / 2), Math.round(this.h * 0.3), t)
    }
  }

  private counterLanded(t: number, big: boolean, kind: 'bolt' | 'orb' | 'lunge'): void {
    this.counts.counters += 1
    const [x, y] = this.world.enemyAt()
    if (kind === 'orb') {
      this.fx.spawn('explosion_s', x, y, t)
      this.kanji.push('strike', 0x8eccff, x, y - 14, t, false)
      this.sfx('boom')
      this.world.kick(1.1, t)
      this.stage.x -= 2
    } else if (kind === 'lunge') {
      this.fx.spawn('burst_star_s', x, y, t)
      this.fx.spawn('shards_s', x, y, t)
      this.kanji.push('crush', KB.GOLD, x, y - 16, t, true)
      this.sfx('smash')
      this.world.kick(1.6, t)
      this.stage.x -= 3
    } else if (big) {
      this.fx.spawn('impact_yellow_s', x, y, t)
      this.kanji.push('fist', KB.GOLD, x, y - 14, t, false)
      this.sfx('enemy_hit')
      this.world.kick(0.6, t)
    } else {
      this.fx.spawn('star_s', x, y, t)
      this.sfx('enemy_hit')
      this.world.kick(0.25, t)
    }
  }

  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void { this.onHit(ev, judgment, offsetMs, t) }
  onHoldComplete(ev: LiveEvent, _j: string, t: number): void {
    void ev
    const [x, y] = this.world.gooseAt()
    this.fx.spawn('sparkle_blue_s', x, y, t)
  }
  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void { this.onHit(ev, judgment, offsetMs, t) }
  onAnchorComplete(ev: LiveEvent, j: string, t: number): void { this.onHoldComplete(ev, j, t) }
  onAnchorBreak(ev: LiveEvent, t: number): void { this.onMiss(ev, t) }

  onMiss(ev: LiveEvent, t: number): void {
    this.stamp('miss', 0, t)
    this.sfx('miss')
    const sp = this.specs.get(ev._uid)
    if (sp) this.world.resolve(sp.id, false, t)
    this.pendingHurt = Math.max(t, ev.timestamp)
    this.hp = Math.max(0, this.hp - this.hpLossMiss)
    if (this.hp <= 0 && !this.noFail) this.failed = true
  }

  onSlip(_ev: LiveEvent, pressed: string, t: number): void {
    const label = pressed === '^' ? 'SPACE' : pressed.toUpperCase()
    this.stamps.push({ text: label, color: STAMP_COLORS.slip, x: Math.round(this.w / 2), y: Math.round(this.h * 0.52), t0: t })
    this.hp = Math.max(0, this.hp - this.hpLossSlip)
    if (this.hp <= 0 && !this.noFail) this.failed = true
  }

  onTooEarly(): void { /* nothing on the field */ }
  onWordComplete(): void { /* no words */ }

  private stamp(kind: string, offsetMs: number, t: number): void {
    let text = STAMP_TEXT[kind] ?? kind.toUpperCase()
    if (kind !== 'miss' && Math.abs(offsetMs) > 1) text = `${text} ${offsetMs > 0 ? '+' : ''}${offsetMs.toFixed(0)}`
    // over the goose's head, under the combo
    this.stamps.push({ text, color: STAMP_COLORS[kind] ?? WHITE, x: Math.round(this.w / 2), y: Math.round(this.h * 0.52), t0: t })
    if (this.stamps.length > 4) this.stamps.shift()
  }

  // ── time ─────────────────────────────────────────────────────────────────
  private beatPhase(t: number): [number, number] {
    const bt = this.beatTimesChart
    if (bt.length < 2) return [-1, 0]
    const i = clamp(lowerBound(bt, t) - 1, 0, bt.length - 2)
    return [i, clamp((t - bt[i]) / Math.max(1e-6, bt[i + 1] - bt[i]), 0, 1)]
  }

  private energyAt(t: number): number {
    if (!this.barT.length || !this.barEnergy.length) return 0.5
    const i = clamp(lowerBound(this.barT, t) - 1, 0, this.barEnergy.length - 1)
    return this.barEnergy[i] ?? 0.5
  }

  // ── the frame ────────────────────────────────────────────────────────────
  draw(t: number, dt: number): void {
    const [, beatP] = this.beatPhase(t)
    // attacks leave the enemy a pre-empt ahead of their notes
    while (this.spawnIdx < this.playable.length && this.playable[this.spawnIdx].timestamp - this.preempt <= t) {
      const ev = this.playable[this.spawnIdx++]
      const sp = this.specs.get(ev._uid)
      if (!sp || ev.timestamp < t - 0.1) continue
      const t0 = ev.timestamp - this.preempt
      sp.id = this.world.spawn(sp.attack, sp.side, t0, ev.timestamp, COLOR[sp.key], LABEL[sp.key])
      this.world.enemyWindup(t0, this.enemySpec.contact, t)
      this.counts[sp.attack] += 1
      if (sp.attack === 'lunge') this.sfx('windup')
      else if (ev.weight >= 3) this.sfx('whoosh')
    }
    if (this.pendingHurt >= 0 && t >= this.pendingHurt) {
      this.pendingHurt = -1
      this.counts.hurt += 1
      this.world.gooseDo('hurt', t)
      this.world.kick(1.5, t)
      this.redFlashT = t
      this.sfx('hurt')
      const [x, y] = this.world.gooseAt()
      this.fx.spawn('hit_red_s', x, y, t)
    }
    this.stage.x *= 0.6
    if (Math.abs(this.stage.x) < 0.5) this.stage.x = 0

    this.world.update(t, dt, beatP, this.energyAt(t))
    this.world.render()
    this.view.texture.source.update()

    this.fx.update(t)
    this.kanji.draw(t)
    this.drawLabels(t)
    this.drawStamps(t)
    this.drawHud(t, dt)
    this.drawFlash(t)
    if (!this.ended && (this.rhythm.isFinished() || this.failed)) {
      this.ended = true
      if (!this.failed && this.rhythm.getAccuracy() >= 70) {
        this.won = true
        this.world.enemyDie(t)
        const [x, y] = this.world.enemyAt()
        this.fx.spawn('explosion_s', x, y, t)
        this.world.gooseDo('cheer', t)
      } else {
        this.world.enemyTaunt(t, this.enemySpec.taunt)
      }
    }
  }

  private acquire(pool: BitmapText[], inUse: BitmapText[], layer: Container): BitmapText {
    const s = pool.pop()
    if (s) { s.visible = true; inUse.push(s); return s }
    const n = pxText('px8')
    layer.addChild(n)
    inUse.push(n)
    return n
  }

  /** the key each incoming attack wants, riding above it */
  private drawLabels(t: number): void {
    for (const s of this.labelsInUse) { s.visible = false; this.labelPool.push(s) }
    this.labelsInUse = []
    for (const l of this.world.labels(t)) {
      const n = this.acquire(this.labelPool, this.labelsInUse, this.labelLayer)
      n.text = l.label
      n.tint = l.color
      n.alpha = l.near < 0.15 ? 0.5 : 1
      n.x = l.x
      n.y = l.y - 9
    }
  }

  private drawStamps(t: number): void {
    for (const s of this.stampsInUse) { s.visible = false; this.stampPool.push(s) }
    this.stampsInUse = []
    this.stamps = this.stamps.filter((st) => {
      const age = t - st.t0
      if (age > 0.5) return false
      const n = this.acquire(this.stampPool, this.stampsInUse, this.stampLayer)
      n.text = st.text
      n.tint = st.color
      n.alpha = age < 0.34 ? 1 : (Math.floor(age * 20) % 2 === 0 ? 1 : 0.3)
      n.x = st.x
      n.y = st.y - 2 * Math.floor(age / 0.06)
      return true
    })
  }

  private drawFlash(t: number): void {
    const g = this.flashGfx
    g.clear()
    const age = t - this.redFlashT
    if (age < 0.3) g.rect(0, 0, this.w, this.h).fill({ color: 0xff3050, alpha: 0.32 * (1 - age / 0.3) })
  }

  private drawHud(t: number, dt: number): void {
    const g = this.hudGfx
    g.clear()
    g.rect(0, 0, this.w, 12).fill({ color: 0x0a0c14, alpha: 0.55 })
    const target = this.rhythm.getScore()
    this.scoreShown += (target - this.scoreShown) * Math.min(1, 8 * dt)
    if (Math.abs(target - this.scoreShown) < 2) this.scoreShown = target
    this.scoreText.text = String(Math.trunc(this.scoreShown)).padStart(7, '0')
    this.scoreText.x = 4; this.scoreText.y = 4
    this.accText.text = `${this.rhythm.getAccuracy().toFixed(1)}%`
    this.accText.x = this.w - 4; this.accText.y = 4
    // HP under the score
    g.rect(3, 13, 50, 5).fill({ color: INK, alpha: 0.8 })
    const hpW = Math.round(48 * this.hp / 100)
    g.rect(4, 14, hpW, 3).fill({ color: this.hp > 30 ? 0x83e3b0 : KB.MISS_RED })
    const combo = this.rhythm.combo
    this.comboText.visible = this.comboShadow.visible = combo >= 5
    if (combo >= 5) {
      this.comboText.text = this.comboShadow.text = String(combo)
      this.comboText.x = Math.round(this.w / 2); this.comboText.y = Math.round(this.h * 0.2)
      this.comboShadow.x = this.comboText.x + 1; this.comboShadow.y = this.comboText.y + 1
    }
    // the enemy's health, over its head
    const total = Math.max(1, this.playable.length)
    const ehp = Math.max(0, 1 - this.hitsLanded / total)
    const [ex, ey] = this.world.enemyTop()
    g.rect(ex - 16, ey - 8, 32, 5).fill({ color: INK })
    g.rect(ex - 15, ey - 7, Math.round(30 * ehp), 3).fill({ color: ehp > 0.5 ? 0xe04848 : 0xff9a3a })
    // the keys along the bottom: lit when their attack is close, white when just pressed
    const upcoming: Record<string, number> = {}
    for (let i = this.rhythm.charEventIdx; i < this.rhythm.beatMap.length; i++) {
      const ev = this.rhythm.beatMap[i]
      if (ev.timestamp - t > 0.4) break
      if (ev.is_rest || !ev.char || ev.hit) continue
      upcoming[ev.char] = Math.min(upcoming[ev.char] ?? 9, ev.timestamp - t)
    }
    const widths = [14, 14, 14, 14, 34]
    const gapPx = 3
    const totalW = widths.reduce((a, b) => a + b, 0) + gapPx * (widths.length - 1)
    let x = Math.round((this.w - totalW) / 2)
    const y = this.h - 15
    KEYS.forEach((k, i) => {
      const wdt = widths[i]
      const pressed = t - this.keyFlash[k] < 0.12
      const soon = upcoming[k] !== undefined
      const fill = pressed ? WHITE : soon ? COLOR[k] : 0x0a0c14
      g.rect(x, y + 1, wdt, 10).fill({ color: INK, alpha: 0.9 })
      g.rect(x, y, wdt, 10).fill({ color: fill, alpha: pressed || soon ? 1 : 0.7 })
      g.rect(x, y, wdt, 1).fill({ color: pressed || soon ? WHITE : COLOR[k], alpha: 0.9 })
      const tx = this.keyText[i]
      tx.tint = pressed || soon ? INK : COLOR[k]
      tx.x = x + Math.round(wdt / 2); tx.y = y + 5
      x += wdt + gapPx
    })
    // progress
    const dur = Math.max(1, this.song.duration)
    const prog = clamp((t - this.leadIn) / dur, 0, 1)
    g.rect(0, 0, this.w, 2).fill({ color: 0x1c1a26 })
    g.rect(0, 0, Math.round(this.w * prog), 2).fill({ color: 0x64c8ff })
    this.titleText.visible = Boolean(this.title) && t <= this.leadIn
    if (this.titleText.visible) { this.titleText.x = Math.round(this.w / 2); this.titleText.y = 24 }
    this.failText.visible = this.failed
    if (this.failed) { this.failText.x = Math.round(this.w / 2); this.failText.y = Math.round(this.h / 2) }
  }

  destroy(): void {
    this.fx.clear()
    this.world.destroy()
    this.stage.destroy({ children: true })
  }
}
