/**
 * PixelLetters — the osu!-style mode, in game pixels.
 *
 * One letter per circle, no words.  The field is the screen above the ground,
 * split by a spine into hands and by two lines into the top, home and bottom
 * rows of the keyboard; a circle appears near its key's place, an approach ring
 * closes on it in hard steps, a 1 px follow line joins the next two, HP replaces
 * lives.  The fight in the bottom-left corner is the same as the highway's —
 * every hit is a move on the enemy, every miss is the enemy's turn — so the
 * two modes are one game.
 */
import { Container, Graphics, Sprite } from 'pixi.js'
import type { BitmapText, Texture } from 'pixi.js'

import type { Layout } from '../core/layout'
import type { ChartMeta, Song } from '../core/models'
import type { LiveEvent, RhythmManager } from '../core/rhythm'
import type { PlayRenderer } from '../render/renderer'
import * as KB from '../core/keyboard'

import type { PxAssets } from './assets'
import type { PixelCanvas } from './canvas'
import { PixelScene } from './scene'
import { FxLayer } from './fx'
import { Goose, Enemy, Fight, planHeavy } from './actors'
import { gooseEffects, SELF_VOICED } from './combat'
import { pxText } from './text'
import type { LevelSpec } from './levels'
import { weightOfTime, mulberry32, lowerBound } from './chartmath'

const WHITE = 0xffffff
const INK = 0x17181a
const STAMP_COLORS: Record<string, number> = {
  perfect: KB.GOLD, good: 0x83e3b0, ok: 0xaed0e6, miss: KB.MISS_RED, slip: 0xaaaabe,
}
const STAMP_TEXT: Record<string, string> = { perfect: 'PERFECT', good: 'GREAT', ok: 'OK', miss: 'MISS' }
const PREEMPT: Record<string, number> = { journey: 1.5, classic: 1.1, master: 0.8, demon: 0.6 }
/** how far from its key's place a circle may land, in game pixels */
const FREE: Record<string, number> = { journey: 0, classic: 14, master: 24, demon: 34 }
const HP_LOSS: Record<string, [number, number]> = {
  journey: [8, 2], classic: [12, 4], master: [15, 5], demon: [20, 6],
}
/** the approach ring's radii, outermost first: the baked ring textures */
const APPROACH = [16, 14, 12, 11, 10, 9]
const R = 8
const CHORD_S = 0.06

interface Stamp { text: string; color: number; x: number; y: number; t0: number }
interface CircleNode extends Container {
  approach: Sprite
  outline: Sprite
  disk: Sprite
  ring: Sprite
  glyph: BitmapText
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export class PixelLetters implements PlayRenderer {
  readonly stage = new Container()
  sfx: (name: string, delay?: number) => void = () => {}

  hp = 100
  failed = false
  private readonly noFail: boolean
  private readonly hpLossMiss: number
  private readonly hpLossSlip: number
  readonly preempt: number
  private readonly free: number
  private readonly leadIn: number
  private readonly beatDur: number
  private beatTimesChart: number[]

  private scene: PixelScene
  private fieldGfx = new Graphics()
  private followGfx = new Graphics()
  private circleLayer = new Container()
  private fight: Fight
  /** set at the end: the enemy went down */
  won = false
  private fx: FxLayer
  private stampLayer = new Container()
  private hudGfx = new Graphics()
  private hudLayer = new Container()

  private pos = new Map<number, [number, number]>()
  /** where each key's circle centres, in game pixels, for the current buffer */
  private anchors = new Map<string, [number, number]>()
  private w = 0
  private h = 0
  private groundY = 0
  private fightW = 0

  private circlePool: CircleNode[] = []
  private circlesInUse: CircleNode[] = []
  private stamps: Stamp[] = []
  private stampPool: BitmapText[] = []
  private stampsInUse: BitmapText[] = []
  private scoreText: BitmapText
  private accText: BitmapText
  private comboText: BitmapText
  private comboShadow: BitmapText
  private titleText: BitmapText
  private failText: BitmapText
  private scoreShown = 0
  private lastHitT = -9
  private pendingHurt = -1
  private ended = false
  private hitsLanded = 0
  private rng = mulberry32(4242)
  private tex: Record<string, Texture>
  private enemySpec: LevelSpec['enemy']

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
    this.preempt = Math.max(PREEMPT[difficulty] ?? 1.1, (1.5 * 60) / Math.max(40, song.bpm)) / speedMult
    this.free = settings.key_guide !== 'keyboard' ? (FREE[difficulty] ?? 14) : 0
    this.leadIn = rhythm.leadIn
    this.beatDur = song.bpm ? 60 / song.bpm : 0.5
    this.beatTimesChart = song.beat_times.map((b) => b + this.leadIn)
    const [lm, ls] = HP_LOSS[difficulty] ?? [12, 4]
    this.hpLossMiss = lm
    this.hpLossSlip = ls
    this.noFail = Boolean(settings.no_fail)

    this.scene = new PixelScene(assets)
    this.scene.set(level.scene)
    this.tex = {
      disc: assets.ui('disc8'), outline: assets.ui('ring9'), ring: assets.ui('ring9'),
    }
    const g = assets.manifest.chars.goose
    const goose = new Goose(assets.char('goose'), g.feet, g.fw, g.fh, this.rng)
    const e = assets.manifest.chars[level.enemy.char]
    const enemy = new Enemy(assets.char(level.enemy.char), e.feet, e.fw, e.fh)
    this.enemySpec = level.enemy
    this.fight = new Fight(goose, enemy)
    this.fx = new FxLayer(assets)
    goose.onEvent = gooseEffects(this.fight, this.fx, (n, d) => this.sfx(n, d), (px) => { this.stage.x += px },
                                 (x, y, t, _r0, r1, dur) => this.fx.spawn(r1 > 12 ? 'burst_ring_s' : 'sparkle_blue_s', x, y, t + (dur - 0.18)),
                                 (text, x, y, t) => this.stamps.push({ text, color: KB.GOLD, x, y, t0: t }))

    this.scoreText = pxText('px8'); this.scoreText.anchor.set(0, 0)
    this.accText = pxText('px8'); this.accText.anchor.set(1, 0)
    this.comboText = pxText('px16')
    this.comboShadow = pxText('px16', '', INK)
    this.titleText = pxText('px8', title)
    this.failText = pxText('px16', 'FAILED', KB.MISS_RED)
    this.failText.visible = false

    this.stage.addChild(this.scene.container, this.fieldGfx, this.followGfx, this.circleLayer,
                        this.fight.container, this.fx.container, this.stampLayer, this.hudLayer)
    this.hudLayer.addChild(this.hudGfx, this.scoreText, this.accText, this.comboShadow, this.comboText,
                           this.titleText, this.failText)
    this.relayout()
  }

  // ── layout ───────────────────────────────────────────────────────────────
  setSections(_meta: ChartMeta): void { /* no section map on the letters field */ }
  setDuets(): void { /* no duets in letters mode */ }
  tryRush(): boolean { return false }
  rushActive(): boolean { return false }
  setLayout(_layout: Layout): void { this.relayout() }

  relayout(): void {
    this.w = this.canvas.w
    this.h = this.canvas.h
    this.scene.layout(this.w, this.h)
    this.groundY = this.scene.groundY
    this.fightW = Math.max(128, Math.min(172, Math.round(this.w * 0.36)))
    const { goose, enemy } = this.fight
    goose.x = 88; goose.y = this.groundY; goose.facing = -1
    enemy.x = 40; enemy.y = this.groundY; enemy.facing = 1
    this.fight.aim()
    this.placeAnchors()
    this.placeEvents()
    this.bakeField()
  }

  /**
   * Where each key lives.  The field runs from under the HUD band to just above
   * the ground; three rows, a spine down the middle, five columns a side.  The
   * bottom-left row starts past the fight so nothing lands on the goose.
   */
  private placeAnchors(): void {
    const top = 16
    const bottom = this.groundY - 6
    const rowH = (bottom - top) / 3
    const spine = Math.round(this.w / 2)
    const margin = 6 + R
    this.anchors.clear()
    const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
    for (let r = 0; r < 3; r++) {
      const y = Math.round(top + rowH * (r + 0.5))
      const leftX0 = r === 2 ? this.fightW + R + 2 : margin
      const leftX1 = spine - 6 - R
      const rightX0 = spine + 6 + R
      const rightX1 = this.w - margin
      for (const ch of rows[r]) {
        const col = KB.COLUMN_OF[ch] ?? 3
        const stagger = [-4, 0, 4][r]
        let x: number
        if (col <= 4) x = Math.round(leftX0 + ((leftX1 - leftX0) * (col + 0.5)) / 5) + stagger
        else x = Math.round(rightX0 + ((rightX1 - rightX0) * (col - 5 + 0.5)) / 5) + stagger
        this.anchors.set(ch, [x, y])
      }
    }
  }

  private anchorOf(ch: string): [number, number] {
    return this.anchors.get(ch.toLowerCase()) ?? [Math.round(this.w / 2), Math.round(this.h / 2)]
  }

  private placeEvents(): void {
    const rng = mulberry32(4242)
    this.pos.clear()
    const top = 16
    const bottom = this.groundY - 6
    const rowH = (bottom - top) / 3
    const spine = Math.round(this.w / 2)
    for (const ev of this.rhythm.beatMap) {
      if (ev.is_rest || !ev.char) continue
      const [ax, ay] = this.anchorOf(ev.char)
      let x = ax, y = ay
      if (this.free > 0) {
        const ang = rng() * Math.PI * 2
        const rad = this.free * Math.sqrt(rng())
        x = ax + Math.cos(ang) * rad
        y = ay + Math.sin(ang) * rad
      }
      const row = KB.rowOf(ev.char)
      y = clamp(y, top + rowH * row + R, top + rowH * (row + 1) - R)
      if (KB.handOf(ev.char) === 0) x = clamp(x, 6 + R, spine - 6 - R)
      else x = clamp(x, spine + 6 + R, this.w - 6 - R)
      // nothing on the fight
      if (x - R < this.fightW && y + R > this.groundY - 52) x = this.fightW + R + 2
      this.pos.set(ev._uid, [Math.round(x), Math.round(y)])
      if (ev.weight < 0) ev.weight = weightOfTime(ev.timestamp - this.leadIn, this.song.beat_times, this.song.bpm)
      ev.lane = KB.laneOf(ev.char)
    }
  }

  /** the static field: row lines, spine, a dot on every key's place */
  private bakeField(): void {
    const g = this.fieldGfx
    g.clear()
    const top = 16
    const bottom = this.groundY - 6
    const rowH = (bottom - top) / 3
    g.rect(0, top, this.w, bottom - top).fill({ color: 0x0a0c14, alpha: 0.28 })
    for (let r = 1; r < 3; r++) {
      g.rect(0, Math.round(top + rowH * r), this.w, 1).fill({ color: WHITE, alpha: 0.18 })
    }
    g.rect(Math.round(this.w / 2), top, 1, bottom - top).fill({ color: WHITE, alpha: 0.3 })
    for (const [, [x, y]] of this.anchors) {
      g.rect(x - 1, y - 1, 3, 3).fill({ color: WHITE, alpha: 0.3 })
    }
  }

  private xy(ev: LiveEvent): [number, number] {
    return this.pos.get(ev._uid) ?? [Math.round(this.w / 2), Math.round(this.h / 2)]
  }

  // ── events from the session ──────────────────────────────────────────────
  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const [x, y] = this.xy(ev)
    this.hp = Math.min(100, this.hp + 1)
    this.hitsLanded += 1
    this.stamp(judgment, offsetMs, t)
    this.fx.spawn('muzzle', x, y, t, { fps: 24 })
    const { goose, enemy } = this.fight
    const w = ev.weight
    let mv = ''
    if (t - this.lastHitT < CHORD_S) { goose.chord(t); mv = 'spin' }
    else mv = goose.hit(t, w, judgment, this.preempt * 0.4)
    this.lastHitT = t
    const heavy = SELF_VOICED.has(mv)
    if (heavy) { /* its events made the sound */ }
    else if (mv === 'peck') this.sfx('peck')
    else if (mv === 'slide') this.sfx('slide')
    else if (mv === 'hop_slap') { this.sfx('jump'); this.sfx('slap', 0.05) }
    else if (mv === 'flurry') this.sfx('slap2')
    else this.sfx(this.rng() < 0.5 ? 'slap' : 'slap2')
    const strong = heavy || w >= 3 || (judgment === 'perfect' && this.rng() < 0.25)
    if (strong && !heavy) this.sfx('enemy_hit', 0.03)
    if (mv !== 'uppercut' && mv !== 'boulder') enemy.hit(t, strong, mv === 'bellyflop' || mv === 'dropkick' ? 5 : 2)
    const ex = enemy.x, ey = enemy.y - 22
    if (heavy) { /* the event drew it */ }
    else if (strong) this.fx.spawn('slash_s', ex + 4, ey, t, { flipX: true })
    else if (judgment === 'perfect') this.fx.spawn('impact_yellow_s', ex + 3, ey, t, { flipX: true })
    else this.fx.spawn('impact_blue_s', ex + 3, ey, t, { flipX: true })
    const combo = this.rhythm.combo
    if ([25, 50, 100, 150, 200, 300].includes(combo)) {
      this.sfx('combo')
      this.fx.spawn('firework_yellow', Math.round(this.w / 2), Math.round(this.h * 0.3), t)
      goose.cheer(t)
    }
  }

  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void { this.onHit(ev, judgment, offsetMs, t) }
  onHoldComplete(ev: LiveEvent, _j: string, t: number): void {
    const [x, y] = this.xy(ev)
    this.fx.spawn('sparkle_blue_s', x, y, t)
  }
  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void { this.onHit(ev, judgment, offsetMs, t) }
  onAnchorComplete(ev: LiveEvent, j: string, t: number): void { this.onHoldComplete(ev, j, t) }
  onAnchorBreak(ev: LiveEvent, t: number): void { this.onMiss(ev, t) }

  onMiss(ev: LiveEvent, t: number): void {
    this.stamp('miss', 0, t)
    this.sfx('miss')
    const g = this.fight.goose
    if (g.isWindingUp && Math.abs(g.pendingContact - ev.timestamp) < 0.2) g.whiff(t)
    this.hp = Math.max(0, this.hp - this.hpLossMiss)
    if (this.hp <= 0 && !this.noFail) this.failed = true
    const landsAt = this.fight.enemy.attack(t, this.enemySpec.contact)
    if (landsAt >= 0) this.pendingHurt = landsAt
  }

  onSlip(_ev: LiveEvent, pressed: string, t: number): void {
    const g = this.fight.goose
    this.stamps.push({ text: pressed.toUpperCase(), color: STAMP_COLORS.slip, x: g.x, y: g.y - 20, t0: t })
    this.hp = Math.max(0, this.hp - this.hpLossSlip)
    if (this.hp <= 0 && !this.noFail) this.failed = true
  }

  onTooEarly(): void { /* nothing on the field */ }
  onWordComplete(): void { /* no words */ }

  private stamp(kind: string, offsetMs: number, t: number): void {
    let text = STAMP_TEXT[kind] ?? kind.toUpperCase()
    if (kind !== 'miss' && Math.abs(offsetMs) > 1) text = `${text} ${offsetMs > 0 ? '+' : ''}${offsetMs.toFixed(0)}`
    const g = this.fight.goose
    this.stamps.push({ text, color: STAMP_COLORS[kind] ?? WHITE, x: g.x, y: g.y - 20, t0: t })
    if (this.stamps.length > 6) this.stamps.shift()
  }

  // ── time ─────────────────────────────────────────────────────────────────
  private beatPhase(t: number): [number, number] {
    const bt = this.beatTimesChart
    if (bt.length < 2) return [-1, 0]
    const i = clamp(lowerBound(bt, t) - 1, 0, bt.length - 2)
    return [i, clamp((t - bt[i]) / Math.max(1e-6, bt[i + 1] - bt[i]), 0, 1)]
  }

  private visible(t: number): LiveEvent[] {
    const bm = this.rhythm.beatMap
    const start = Math.max(0, this.rhythm.charEventIdx - 6)
    const out: LiveEvent[] = []
    for (let i = start; i < bm.length; i++) {
      const ev = bm[i]
      if (ev.is_rest || !ev.char) continue
      if (ev.timestamp - t > this.preempt) break
      if (ev.hit && t - ev.timestamp > 0.05) continue
      out.push(ev)
    }
    return out
  }

  // ── the frame ────────────────────────────────────────────────────────────
  draw(t: number, dt: number): void {
    const [beatI, beatP] = this.beatPhase(t)
    this.scene.update(t, dt, 0.5)
    const vis = this.visible(t)
    this.drawFollowLines(t, vis)
    this.drawCircles(t, vis)
    // the fight
    const { goose, enemy } = this.fight
    planHeavy(goose, vis, t, this.rng)
    if (beatI >= 0) { goose.beat(beatI, beatP); enemy.beat(beatI, beatP) }
    if (this.pendingHurt >= 0 && t >= this.pendingHurt) {
      this.pendingHurt = -1
      goose.hurt(t)
      this.sfx('hurt')
      this.fx.spawn('puff_s', goose.x, goose.y - 12, t)
    }
    goose.update(t)
    enemy.update(t)
    this.fx.update(t)
    this.drawStamps(t)
    this.drawHud(t, dt)
    if (!this.ended && (this.rhythm.isFinished() || this.failed)) {
      this.ended = true
      if (!this.failed && this.rhythm.getAccuracy() >= 70) {
        this.won = true
        enemy.die(t)
        this.fx.spawn('explosion_s', enemy.x, enemy.y - 20, t)
        goose.cheer(t)
      } else {
        enemy.play(this.enemySpec.taunt, t, { fps: 10 })
      }
    }
  }

  /** 1 px lines from the circle to hit now to the next two, leaving the circles' edges */
  private drawFollowLines(t: number, vis: LiveEvent[]): void {
    const g = this.followGfx
    g.clear()
    const pending = vis.filter((e) => !e.hit)
    if (!pending.length) return
    let lastHit: LiveEvent | null = null
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].hit) { lastHit = vis[i]; break }
    const chain = (lastHit !== null ? [lastHit] : []).concat(pending.slice(0, 3))
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i], b = chain[i + 1]
      if (b.timestamp - a.timestamp > 2.5) break
      const [ax, ay] = this.xy(a)
      const [bx, by] = this.xy(b)
      const dx = bx - ax, dy = by - ay
      const ln = Math.hypot(dx, dy)
      if (ln < 2 * R + 6) continue
      const ux = dx / ln, uy = dy / ln
      const p0x = Math.round(ax + ux * (R + 3)), p0y = Math.round(ay + uy * (R + 3))
      const p1x = Math.round(bx - ux * (R + 3)), p1y = Math.round(by - uy * (R + 3))
      const k = clamp((t - (b.timestamp - this.preempt)) / (this.preempt * 0.4), 0, 1)
      const idx = lastHit === null ? i : Math.max(0, i - 1)
      const strength = [1.0, 0.5, 0.25][Math.min(2, idx)]
      g.moveTo(p0x, p0y).lineTo(p1x, p1y).stroke({ width: 1, color: WHITE, alpha: Math.round(k * strength * 4) / 4 })
      if (a.hit && a.timestamp <= t && t <= b.timestamp) {
        const p = (t - a.timestamp) / Math.max(1e-6, b.timestamp - a.timestamp)
        g.rect(Math.round(p0x + (p1x - p0x) * p) - 1, Math.round(p0y + (p1y - p0y) * p) - 1, 3, 3).fill({ color: WHITE })
      }
    }
  }

  private acquireCircle(): CircleNode {
    const c = this.circlePool.pop()
    if (c) { c.visible = true; this.circlesInUse.push(c); return c }
    const n = new Container() as CircleNode
    n.approach = new Sprite(); n.approach.anchor.set(0.5); n.approach.roundPixels = true
    n.outline = new Sprite(this.tex.outline); n.outline.anchor.set(0.5); n.outline.tint = INK
    n.disk = new Sprite(this.tex.disc); n.disk.anchor.set(0.5)
    n.ring = new Sprite(this.tex.ring); n.ring.anchor.set(0.5)
    n.glyph = pxText('px8', '', INK)
    n.addChild(n.approach, n.outline, n.disk, n.ring, n.glyph)
    this.circleLayer.addChild(n)
    this.circlesInUse.push(n)
    return n
  }

  private drawCircles(t: number, vis: LiveEvent[]): void {
    for (const c of this.circlesInUse) { c.visible = false; this.circlePool.push(c) }
    this.circlesInUse = []
    for (let i = vis.length - 1; i >= 0; i--) {
      const ev = vis[i]
      if (ev.hit) continue
      const [x, y] = this.xy(ev)
      const until = ev.timestamp - t
      const okW = this.rhythm.okWindowFor(ev)
      const node = this.acquireCircle()
      node.x = x
      node.y = y
      const col = KB.laneColor(ev.lane)
      if (until < -okW) {
        // missed: a red ring for a few frames, then gone
        if (-until - okW > 0.15) { node.visible = false; continue }
        node.approach.visible = false
        node.disk.visible = false
        node.glyph.visible = false
        node.outline.visible = false
        node.ring.visible = true
        node.ring.tint = KB.MISS_RED
        continue
      }
      const k = 1 - Math.max(0, until) / this.preempt
      // the approach ring closes in steps: one baked radius after another
      const step = Math.min(APPROACH.length - 1, Math.floor(k * APPROACH.length))
      node.approach.visible = step < APPROACH.length - 1
      node.approach.texture = this.assets.ui(`ring${APPROACH[step]}`)
      node.approach.tint = col
      node.approach.alpha = k < 0.15 ? 0.5 : 1
      node.outline.visible = true
      node.disk.visible = true
      node.disk.tint = ev.weight >= 3 ? col : WHITE
      node.ring.visible = true
      node.ring.tint = ev.weight >= 3 ? INK : col
      node.glyph.visible = true
      node.glyph.text = ev.char.toUpperCase()
      node.glyph.tint = INK
      node.alpha = k < 0.15 ? 0.5 : 1
    }
  }

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
      n.alpha = age < 0.34 ? 1 : (Math.floor(age * 20) % 2 === 0 ? 1 : 0.3)
      n.x = st.x
      n.y = st.y - 2 * Math.floor(age / 0.06)
      return true
    })
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
      this.comboText.x = Math.round(this.w / 2); this.comboText.y = Math.round(this.h * 0.32)
      this.comboShadow.x = this.comboText.x + 1; this.comboShadow.y = this.comboText.y + 1
    }
    // the enemy's health
    const { enemy } = this.fight
    const total = Math.max(1, this.rhythm.beatMap.filter((e) => !e.is_rest && e.char).length)
    const hp = Math.max(0, 1 - this.hitsLanded / total)
    g.rect(enemy.x - 16, enemy.y - 51, 32, 5).fill({ color: INK })
    g.rect(enemy.x - 15, enemy.y - 50, Math.round(30 * hp), 3).fill({ color: hp > 0.5 ? 0xe04848 : 0xff9a3a })
    // progress
    const dur = Math.max(1, this.song.duration)
    const prog = clamp((t - this.leadIn) / dur, 0, 1)
    g.rect(0, 0, this.w, 2).fill({ color: 0x1c1a26 })
    g.rect(0, 0, Math.round(this.w * prog), 2).fill({ color: 0x64c8ff })
    this.titleText.visible = Boolean(this.title) && t <= this.leadIn
    if (this.titleText.visible) { this.titleText.x = Math.round(this.w / 2); this.titleText.y = 24 }
    this.failText.visible = this.failed
    if (this.failed) { this.failText.x = Math.round(this.w / 2); this.failText.y = Math.round(this.h / 2) }
    void this.beatDur
  }

  destroy(): void {
    this.fx.clear()
    this.stage.destroy({ children: true })
  }
}
