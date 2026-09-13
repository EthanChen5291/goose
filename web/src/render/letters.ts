/**
 * LettersRenderer — the osu!-style mode: one letter per circle, no words.
 * A port of game/letters_renderer.py.
 *
 * The field is the whole screen inside a 60 px margin, split by a spine into
 * hands and by two lines into the top, home and bottom bands; faint column lines
 * and thirty anchor dots say where the keys are, and nothing is written on the
 * field.  Circles sit within the tier's free radius of their key's anchor, an
 * approach ring shrinks onto each, a follow line with a travelling pulse joins
 * consecutive circles, HP replaces hearts.  Same judgment core, same colours,
 * same effects language as the Highway.
 *
 * The approach ring is the part the pygame build had to work hardest for: a
 * distance-field circle rebuilt per radius and faded through a 32-step alpha
 * cache.  Here it is one sprite whose `scale` and `alpha` change per frame.
 */
import { Container, Graphics, Rectangle, Sprite, Texture, BitmapText } from 'pixi.js'
import type { Renderer } from 'pixi.js'

import type { Layout } from '../core/layout'
import { DESIGN_W } from '../core/layout'
import * as KB from '../core/keyboard'
import type { Song } from '../core/models'
import type { LiveEvent, RhythmManager } from '../core/rhythm'
import { TextureCache } from './textures'
import { label } from './text'
import { weightOfTime } from './highway'

const WHITE = 0xffffff
const STAMP_COLORS: Record<string, number> = {
  perfect: KB.GOLD, good: 0x83e3b0, ok: 0xaed0e6, miss: KB.MISS_RED, slip: 0xaaaabe,
}
const STAMP_TEXT: Record<string, string> = {
  perfect: 'PERFECT', good: 'GREAT', ok: 'OK', miss: 'MISS',
}
const BG_CENTER = 0x22203a
const BG_EDGE = 0x07060d

const PREEMPT: Record<string, number> = { journey: 1.5, classic: 1.1, master: 0.8, demon: 0.6 }
const FREE_RADIUS: Record<string, number> = { journey: 0, classic: 90, master: 150, demon: 220 }
const CIRCLE_R: Record<string, number> = { journey: 76, classic: 64, master: 54, demon: 46 }
const HP_LOSS: Record<string, [number, number]> = {
  journey: [8, 2], classic: [12, 4], master: [15, 5], demon: [20, 6],
}

const MARGIN = 60
const SPINE_X = 960
const BANDS: [number, number][] = [[60, 380], [380, 700], [700, 1020]]
const LEFT_COLS = [147, 321, 495, 669, 843]
const RIGHT_COLS = [1077, 1251, 1425, 1599, 1773]
/** squeezed to clear Noki's pocket */
const BOTTOM_LEFT_COLS = [300, 440, 580, 720, 860]
const ROW_STAGGER = [-40, 0, 40]
const NOKI_POCKET: [number, number, number, number] = [0, 820, 250, 260]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function keyAnchor(ch: string): [number, number] {
  const row = KB.rowOf(ch)
  const col = KB.COLUMN_OF[ch] ?? 3
  const y = Math.floor((BANDS[row][0] + BANDS[row][1]) / 2)
  let x: number
  if (col <= 4) x = row === 2 ? BOTTOM_LEFT_COLS[col] : LEFT_COLS[col] + ROW_STAGGER[row]
  else x = RIGHT_COLS[col - 5] + ROW_STAGGER[row]
  return [x, y]
}

interface Burst { x: number; y: number; kind: string; age: number; col: number }
interface Spark { x: number; y: number; vx: number; vy: number; age: number; life: number; r: number; col: number }
interface Shard { x: number; y: number; vx: number; vy: number; ang: number; age: number; life: number; col: number }
interface Stamp { kind: string; x: number; y: number; t0: number; tag: string; extra: string }

interface CircleNode extends Container {
  approach: Sprite
  halo: Sprite
  disk: Sprite
  ring: Sprite
  outer: Sprite
  glyph: BitmapText
}

export class LettersRenderer {
  private L: Layout
  readonly stage = new Container()
  private tex: TextureCache

  readonly preempt: number
  private readonly r: number
  private readonly free: number
  private readonly beatDur: number
  private readonly leadIn: number
  private beatTimesChart: number[]

  hp = 100
  private readonly hpLossMiss: number
  private readonly hpLossSlip: number
  failed = false
  private readonly noFail: boolean

  private pos = new Map<number, [number, number]>()

  private field = new Graphics()
  private bloom: Sprite | null = null
  private comboGhost: BitmapText
  private followLayer = new Graphics()
  private circleLayer = new Container()
  private fxLayer = new Container()
  private nokiLayer = new Container()
  private hudGfx = new Graphics()
  private hudLayer = new Container()

  private bursts: Burst[] = []
  private sparks: Spark[] = []
  private shards: Shard[] = []
  private stamps: Stamp[] = []

  private circlePool: CircleNode[] = []
  private circlesInUse: CircleNode[] = []
  private fxPool: Sprite[] = []
  private fxInUse: Sprite[] = []
  private stampPool: BitmapText[] = []
  private stampsInUse: BitmapText[] = []

  private scoreText: BitmapText
  private comboText: BitmapText
  private titleText: BitmapText
  private failText: BitmapText
  private scoreShown = 0
  private hurtT = -1
  private rng = mulberry32(11)

  private noki: Sprite | null = null
  private nokiSheet: { frames: number; w: number; h: number } | null = null
  private nokiFrames: Texture[] = []

  constructor(
    layout: Layout,
    private readonly song: Song,
    private readonly rhythm: RhythmManager,
    readonly difficulty: string,
    renderer: Renderer,
    settings: Record<string, unknown> = {},
    private readonly title = '',
  ) {
    this.L = layout
    this.tex = new TextureCache(renderer)
    const speedMult = Math.max(0.25, Number(settings.speed_mult ?? 1))
    this.preempt = Math.max(PREEMPT[difficulty] ?? 1.1,
                            (1.5 * 60) / Math.max(40, song.bpm)) / speedMult
    this.r = CIRCLE_R[difficulty] ?? 64
    this.free = settings.key_guide !== 'keyboard' ? (FREE_RADIUS[difficulty] ?? 90) : 0
    this.beatDur = song.bpm ? 60 / song.bpm : 0.5
    this.leadIn = rhythm.leadIn
    this.beatTimesChart = song.beat_times.map((b) => b + this.leadIn)
    const [lm, ls] = HP_LOSS[difficulty] ?? [12, 4]
    this.hpLossMiss = lm
    this.hpLossSlip = ls
    this.noFail = Boolean(settings.no_fail)
    this.showNoki = (settings.noki_placement ?? 'line') !== 'hidden'

    this.comboGhost = label('display', 200)
    this.comboGhost.alpha = 0.06
    this.scoreText = label('display', 32)
    this.scoreText.anchor.set(1, 0.5)
    this.comboText = label('display', 56)
    this.comboText.anchor.set(1, 1)
    this.comboText.alpha = 0.9
    this.titleText = label('display', 40, title)
    this.failText = label('stamp', 64, 'FAILED')
    this.failText.tint = KB.MISS_RED
    this.failText.visible = false

    for (const l of [this.field, this.comboGhost, this.followLayer, this.circleLayer,
                     this.fxLayer, this.nokiLayer, this.hudLayer]) {
      this.stage.addChild(l)
    }
    this.hudLayer.addChild(this.hudGfx, this.scoreText, this.comboText, this.titleText, this.failText)

    this.placeEvents()
    this.bakeField()
    this.warmTextures()
  }

  /** Bake the circle, ring, halo and effect textures now, not on the first hit. */
  private warmTextures(): void {
    const L = this.L
    const r = L.S(this.r)
    this.tex.body(r)
    this.tex.body(8)
    this.tex.annulus(r, Math.max(2, L.S(4)))
    this.tex.annulus(r, Math.max(2, L.S(5)))
    this.tex.halo()
    this.tex.radial(512, 0, 1.4)
    this.tex.pixel
  }

  private showNoki = true

  // ── interface parity with the Highway ────────────────────────────────────
  setSections(): void { /* the letters field has no section map */ }
  setDuets(): void { /* no duets in letters mode */ }
  tryRush(): boolean { return false }
  rushActive(): boolean { return false }

  setLayout(layout: Layout): void {
    this.L = layout
    this.tex.clear()
    this.bloom?.destroy()
    this.bloom = null
    for (const c of [...this.circlePool, ...this.circlesInUse]) c.destroy({ children: true })
    this.circlePool = []
    this.circlesInUse = []
    this.circleLayer.removeChildren()
    this.bakeField()
    this.warmTextures()
  }

  setNokiSheet(base: Texture, info: { frames: number; w: number; h: number }): void {
    this.nokiSheet = info
    this.nokiFrames = []
    for (let i = 0; i < info.frames; i++) {
      this.nokiFrames.push(new Texture({
        source: base.source, frame: new Rectangle(i * info.w, 0, info.w, info.h),
      }))
    }
    if (this.noki === null) {
      this.noki = new Sprite(this.nokiFrames[0])
      this.noki.anchor.set(0, 1)
      this.nokiLayer.addChild(this.noki)
    }
  }

  // ── placement ────────────────────────────────────────────────────────────
  private placeEvents(): void {
    const rng = mulberry32(4242)
    this.pos.clear()
    const r = this.r
    for (const ev of this.rhythm.beatMap) {
      if (ev.is_rest || !ev.char) continue
      const [ax, ay] = keyAnchor(ev.char)
      let x: number
      let y: number
      if (this.free > 0) {
        const ang = rng() * Math.PI * 2
        const rad = this.free * Math.sqrt(rng())
        x = ax + Math.cos(ang) * rad
        y = ay + Math.sin(ang) * rad
      } else {
        x = ax
        y = ay
      }
      const row = KB.rowOf(ev.char)
      const [lo, hi] = BANDS[row]
      y = clamp(y, lo + r, hi - r)
      if (KB.handOf(ev.char) === 0) x = clamp(x, MARGIN + r, SPINE_X - 30 - r)
      else x = clamp(x, SPINE_X + 30 + r, DESIGN_W - MARGIN - r)
      const [px, py, pw] = NOKI_POCKET
      if (x - r < px + pw && y + r > py) x = px + pw + r + 4
      this.pos.set(ev._uid, [x, y])
      if (ev.weight < 0) {
        ev.weight = weightOfTime(ev.timestamp - this.leadIn, this.song.beat_times, this.song.bpm)
      }
      ev.lane = KB.laneOf(ev.char)
    }
  }

  /** The static field: bands, spine, column lines and the thirty key anchors. */
  private bakeField(): void {
    const L = this.L
    const g = this.field
    g.clear()
    g.rect(0, 0, L.winW, L.winH).fill({ color: BG_EDGE })
    if (this.bloom === null) {
      this.bloom = new Sprite(this.tex.radial(512, 0, 1.4))
      this.bloom.anchor.set(0.5)
      this.bloom.tint = BG_CENTER
      this.stage.addChildAt(this.bloom, 1)
    }
    this.bloom.x = L.X(DESIGN_W * 0.5)
    this.bloom.y = L.Y(1080 * 0.52)
    this.bloom.width = L.winW * 2.1
    this.bloom.height = L.winH * 2.3

    // home band fill, band lines edge to edge, spine, column lines, anchor dots
    const gw = Math.max(1, L.S(2))
    g.rect(0, L.Y(380), L.winW, L.Y(700) - L.Y(380)).fill({ color: WHITE, alpha: 0.03 })
    for (const y of [380, 700]) {
      g.rect(0, L.Y(y) - gw / 2, L.winW, gw).fill({ color: 0xdedcff, alpha: 0.16 })
    }
    for (const x of [...LEFT_COLS, ...RIGHT_COLS]) {
      g.rect(L.X(x) - gw / 2, 0, gw, L.winH).fill({ color: 0xdedcff, alpha: 0.09 })
    }
    g.rect(L.X(930), 0, L.S(60), L.winH).fill({ color: WHITE, alpha: 0.025 })
    g.rect(L.X(960) - Math.max(1, L.S(2)) / 2, 0, Math.max(1, L.S(2)), L.winH)
      .fill({ color: WHITE, alpha: 0.3 })
    for (const ch of 'qwertyuiopasdfghjklzxcvbnm') {
      const [ax, ay] = keyAnchor(ch)
      g.circle(L.X(ax), L.Y(ay), Math.max(2, L.S(3))).fill({ color: WHITE, alpha: 0.18 })
    }
  }

  // ── events from the session ──────────────────────────────────────────────
  private xy(ev: LiveEvent): [number, number] {
    return this.pos.get(ev._uid) ?? [960, 540]
  }

  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    const [x, y] = this.xy(ev)
    const col = KB.laneColor(ev.lane)
    this.bursts.push({ x, y, kind: judgment, age: 0, col })
    if (judgment === 'perfect') this.spawnShards(x, y, 6, col)
    this.spawnSparks(x, y, judgment !== 'ok' ? 5 : 2, col)
    this.stamp(judgment, x, y - this.r - 30, offsetMs, t)
    this.hp = Math.min(100, this.hp + 1)
  }

  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    this.onHit(ev, judgment, offsetMs, t)
  }

  onHoldComplete(ev: LiveEvent): void {
    const [x, y] = this.xy(ev)
    this.spawnSparks(x, y, 8, KB.GOLD)
  }

  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void {
    this.onHit(ev, judgment, offsetMs, t)
  }

  onAnchorComplete(ev: LiveEvent): void { this.onHoldComplete(ev) }
  onAnchorBreak(ev: LiveEvent, t: number): void { this.onMiss(ev, t) }

  onMiss(ev: LiveEvent, t: number): void {
    const [x, y] = this.xy(ev)
    this.stamp('miss', x, y - this.r - 30, 0, t)
    this.hurtT = t
    this.hp -= this.hpLossMiss
    if (this.hp <= 0 && !this.noFail) {
      this.hp = 0
      this.failed = true
    }
  }

  onSlip(ev: LiveEvent, pressed: string, t: number): void {
    const [x, y] = this.xy(ev)
    this.stamp('slip', x, y - this.r - 30, 0, t, pressed.toUpperCase())
    this.hp = Math.max(0, this.hp - this.hpLossSlip)
    this.bursts.push({ x, y, kind: 'slip', age: 0, col: KB.MISS_RED })
  }

  onTooEarly(): void { /* nothing on the letters field */ }
  onWordComplete(): void { /* no words in letters mode */ }

  private spawnShards(x: number, y: number, n: number, col: number): void {
    for (let i = 0; i < n; i++) {
      const ang = this.rng() * Math.PI * 2
      const spd = 400 + this.rng() * 300
      this.shards.push({
        x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        ang, age: 0, life: 0.36, col,
      })
    }
  }

  private spawnSparks(x: number, y: number, n: number, col: number): void {
    for (let i = 0; i < n; i++) {
      const ang = this.rng() * Math.PI * 2
      const spd = 150 + this.rng() * 230
      this.sparks.push({
        x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 100,
        age: 0, life: 0.3 + this.rng() * 0.2, r: 2 + this.rng() * 2,
        col: this.rng() < 0.5 ? col : WHITE,
      })
    }
  }

  private stamp(kind: string, x: number, y: number, offsetMs: number, t: number, extra = ''): void {
    let tag = ''
    if ((kind === 'good' || kind === 'ok') && Math.abs(offsetMs) >= 25) {
      tag = offsetMs < 0 ? 'EARLY' : 'LATE'
    }
    this.stamps.push({ kind, x, y, t0: t, tag, extra })
    if (this.stamps.length > 14) this.stamps.shift()
  }

  // ── beat helpers ─────────────────────────────────────────────────────────
  private beatPhase(t: number): [number, number] {
    const bt = this.beatTimesChart
    if (bt.length < 2) return [0, 0]
    let lo = 0, hi = bt.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (bt[m] <= t) lo = m + 1; else hi = m }
    const i = lo - 1
    if (i < 0) return [-1, 0]
    if (i >= bt.length - 1) return [i, 0]
    return [i, (t - bt[i]) / Math.max(1e-6, bt[i + 1] - bt[i])]
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

  // ── drawing ──────────────────────────────────────────────────────────────
  draw(t: number, dt: number): void {
    const vis = this.visible(t)
    this.drawCombo()
    this.drawFollowLines(t, vis)
    this.drawCircles(t, vis)
    this.drawEffects(t, dt)
    this.drawNoki(t)
    this.drawHud(t, dt)
  }

  private drawCombo(): void {
    const combo = this.rhythm.combo
    this.comboGhost.visible = combo >= 5
    if (combo < 5) return
    const L = this.L
    this.comboGhost.text = String(combo)
    this.comboGhost.scale.set(L.S(200) / 96)
    this.comboGhost.x = L.X(960)
    this.comboGhost.y = L.Y(600)
  }

  /**
   * One straight stroke from the circle to hit now to the one after it (and a
   * fainter one on to the third), stopping at the circles' edges, so the order is
   * never in doubt: the line always leaves the current circle.  A pulse travels
   * it from the last hit.
   */
  private drawFollowLines(t: number, vis: LiveEvent[]): void {
    const L = this.L
    const g = this.followLayer
    g.clear()
    const pending = vis.filter((e) => !e.hit)
    if (!pending.length) return
    let lastHit: LiveEvent | null = null
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].hit) { lastHit = vis[i]; break }
    const chain = (lastHit !== null ? [lastHit] : []).concat(pending.slice(0, 3))
    const r = L.S(this.r)
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i]
      const b = chain[i + 1]
      if (b.timestamp - a.timestamp > 2.5) break
      const [x0, y0] = this.xy(a)
      const [x1, y1] = this.xy(b)
      const ax = L.X(x0), ay = L.Y(y0), bx = L.X(x1), by = L.Y(y1)
      const dx = bx - ax, dy = by - ay
      const ln = Math.hypot(dx, dy)
      if (ln < 2 * r + 8) continue
      const ux = dx / ln, uy = dy / ln
      const p0x = ax + ux * (r + 4), p0y = ay + uy * (r + 4)
      const p1x = bx - ux * (r + 4), p1y = by - uy * (r + 4)
      const k = clamp((t - (b.timestamp - this.preempt)) / (this.preempt * 0.4), 0, 1)
      const idx = lastHit === null ? i : Math.max(0, i - 1)
      const strength = [1.0, 0.45, 0.2][Math.min(2, idx)]
      const col = KB.laneColor(b.lane)
      g.moveTo(p0x, p0y).lineTo(p1x, p1y)
        .stroke({ width: Math.max(2, L.S(10)), color: col, alpha: 0.22 * k * strength, cap: 'round' })
      g.moveTo(p0x, p0y).lineTo(p1x, p1y)
        .stroke({ width: Math.max(1, L.S(2)), color: WHITE, alpha: 0.75 * k * strength, cap: 'round' })
      if (a.hit && a.timestamp <= t && t <= b.timestamp) {
        const p = (t - a.timestamp) / Math.max(1e-6, b.timestamp - a.timestamp)
        g.circle(p0x + (p1x - p0x) * p, p0y + (p1y - p0y) * p, Math.max(3, L.S(7)))
          .fill({ color: WHITE, alpha: 0.94 })
      }
    }
  }

  private acquireCircle(): CircleNode {
    const c = this.circlePool.pop()
    if (c) { c.visible = true; this.circlesInUse.push(c); return c }
    const n = new Container() as CircleNode
    n.approach = new Sprite(); n.approach.anchor.set(0.5)
    n.halo = new Sprite(); n.halo.anchor.set(0.5); n.halo.blendMode = 'add'
    n.disk = new Sprite(); n.disk.anchor.set(0.5)
    n.ring = new Sprite(); n.ring.anchor.set(0.5)
    n.outer = new Sprite(); n.outer.anchor.set(0.5)
    n.glyph = label('display', 40)
    n.addChild(n.approach, n.halo, n.disk, n.ring, n.outer, n.glyph)
    this.circleLayer.addChild(n)
    this.circlesInUse.push(n)
    return n
  }

  private drawCircles(t: number, vis: LiveEvent[]): void {
    const L = this.L
    for (const c of this.circlesInUse) { c.visible = false; this.circlePool.push(c) }
    this.circlesInUse = []

    const r = L.S(this.r)
    const [bi, bp] = this.beatPhase(t)
    const amp = bi >= 0 ? [1.0, 0.7, 0.85, 0.7][bi % 4] : 0.7
    const bounce = (1 - bp) ** 2
    const sx = 1 + 0.06 * bounce * amp
    const sy = 1 - 0.05 * bounce * amp

    const diskTex = this.tex.body(r)
    const ringTex = this.tex.annulus(r, Math.max(2, L.S(4)))
    const haloTex = this.tex.halo()

    // later circles under earlier ones
    for (let i = vis.length - 1; i >= 0; i--) {
      const ev = vis[i]
      if (ev.hit) continue
      const [x, y] = this.xy(ev)
      const cx = L.X(x), cy = L.Y(y)
      const until = ev.timestamp - t
      const lane = ev.lane
      const okW = this.rhythm.okWindowFor(ev)
      const node = this.acquireCircle()
      node.x = cx
      node.y = cy
      node.halo.visible = false
      node.outer.visible = false
      node.approach.visible = false

      if (until < -okW) {
        // the missed circle: a red ring shrinking away
        const age = -until - okW
        if (age > 0.35) { node.visible = false; continue }
        const k = age / 0.35
        node.disk.visible = false
        node.glyph.visible = false
        node.ring.visible = true
        node.ring.texture = ringTex
        node.ring.tint = KB.MISS_RED
        node.ring.alpha = 1 - k
        node.ring.scale.set(1 - 0.3 * k)
        continue
      }

      // 0 at spawn, 1 at hit
      const k = 1 - Math.max(0, until) / this.preempt
      const fade = Math.min(1, k / 0.4)

      // the approach ring, 3r → 1r.  One texture, one scale, one alpha.
      node.approach.visible = true
      node.approach.texture = ringTex
      node.approach.tint = KB.laneColor(lane)
      node.approach.scale.set(3.0 - 2.0 * k)
      node.approach.alpha = (0.4 + 0.6 * k) * fade

      if (k > 0.75) {
        node.halo.visible = true
        node.halo.texture = haloTex
        node.halo.tint = KB.laneColor(lane)
        node.halo.alpha = ((k - 0.75) / 0.25) * 0.5
        node.halo.width = node.halo.height = r * 3.2
      }

      node.disk.visible = true
      node.disk.texture = diskTex
      node.disk.tint = WHITE
      node.disk.alpha = fade
      node.disk.scale.set(sx, sy)

      node.ring.visible = true
      node.ring.texture = ringTex
      node.ring.tint = KB.laneColor(lane)
      node.ring.alpha = fade
      node.ring.scale.set(sx, sy)

      node.glyph.visible = true
      node.glyph.text = ev.char.toUpperCase()
      node.glyph.tint = KB.INK
      node.glyph.alpha = fade
      node.glyph.scale.set((r * 1.05) / 96)
      node.glyph.x = 0
      node.glyph.y = L.S(2)

      if (ev.weight >= 3) {
        node.outer.visible = true
        node.outer.texture = ringTex
        node.outer.tint = KB.laneColor(lane)
        node.outer.alpha = 0.47 * fade
        node.outer.scale.set(1.18)
      }
    }
  }

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
    const n = label('stamp', 30)
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

    const r = L.S(this.r)
    const ringTex = this.tex.annulus(r, Math.max(2, L.S(5)))

    this.bursts = this.bursts.filter((b) => {
      b.age += dt
      if (b.age > 0.32) return false
      const k = b.age / 0.32
      const s = this.acquireFx()
      s.texture = ringTex
      s.tint = b.col
      s.alpha = 0.5 * (1 - k)
      s.scale.set(1 + 0.7 * k)
      s.x = L.X(b.x)
      s.y = L.Y(b.y)
      if (b.kind === 'perfect') {
        const s2 = this.acquireFx()
        s2.texture = ringTex
        s2.tint = b.col
        s2.alpha = 0.2 * (1 - k)
        s2.scale.set(1 + 1.3 * k)
        s2.x = s.x
        s2.y = s.y
      }
      return true
    })

    this.shards = this.shards.filter((p) => {
      p.age += dt
      if (p.age > p.life) return false
      p.x += p.vx * dt
      p.y += p.vy * dt
      const k = p.age / p.life
      const s = this.acquireFx()
      s.texture = this.tex.pixel
      s.tint = p.col
      s.alpha = 1 - k * k
      s.width = L.S(18 * (1 - k) + 4)
      s.height = L.S(6 * (1 - k) + 2)
      s.rotation = p.ang
      s.x = L.X(p.x)
      s.y = L.Y(p.y)
      return true
    })

    this.sparks = this.sparks.filter((p) => {
      p.age += dt
      if (p.age > p.life) return false
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 300 * dt
      const k = 1 - p.age / p.life
      const s = this.acquireFx()
      s.texture = this.tex.body(8)
      s.blendMode = 'add'
      s.tint = p.col
      s.alpha = k
      s.width = s.height = Math.max(1, L.Sf(p.r * k * 2))
      s.x = L.X(p.x)
      s.y = L.Y(p.y)
      return true
    })

    this.stamps = this.stamps.filter((st) => {
      const age = t - st.t0
      if (age > 0.7) return false
      const sc = 0.6 + 0.4 * (1 - (1 - Math.min(1, age / 0.1)) ** 3)
      const alpha = age < 0.45 ? 1 : Math.max(0, 1 - (age - 0.45) / 0.25)
      const isSlip = st.kind === 'slip'
      const txt = isSlip ? `SLIP · ${st.extra}` : (STAMP_TEXT[st.kind] ?? st.kind.toUpperCase())
      const n = this.acquireStamp()
      n.text = st.tag ? `${txt} ${st.tag}` : txt
      n.tint = STAMP_COLORS[st.kind] ?? WHITE
      n.alpha = alpha
      n.scale.set((L.S(isSlip ? 22 : 30) / 96) * sc)
      n.x = L.X(st.x)
      n.y = L.Y(st.y - 16 * age)
      return true
    })
  }

  private drawNoki(t: number): void {
    const n = this.noki
    if (n === null || this.nokiSheet === null || !this.showNoki
        || this.L.nokiPlacement === 'hidden') {
      if (n) n.visible = false
      return
    }
    const L = this.L
    n.visible = true
    const frames = this.nokiFrames.length
    let [bi, p] = this.beatPhase(t)
    if (bi < 0) { p = (t / this.beatDur) % 1; bi = Math.floor(t / this.beatDur) }
    // a fast song bops on every other beat so Noki never looks frantic
    const norm = this.beatDur >= 60 / 250 ? ((bi % 2) + p) / 2 : ((bi % 4) + p) / 4
    const hurting = this.hurtT >= 0 && t - this.hurtT < 0.5
    const idx = hurting
      ? Math.min(frames - 1, Math.floor((t - this.hurtT) * 30 * 1.15))
      : Math.floor(norm * frames) % frames
    if (this.hurtT >= 0 && t - this.hurtT >= 0.5) this.hurtT = -1
    n.texture = this.nokiFrames[idx]
    n.height = L.S(246)
    n.width = L.S(246) * (this.nokiSheet.w / this.nokiSheet.h)
    n.x = L.X(L.left + 36)
    n.y = L.Y(L.bottom + 6)
  }

  private drawHud(t: number, dt: number): void {
    const L = this.L
    const g = this.hudGfx
    g.clear()

    // HP bar top-left, no label
    const bx = L.X(L.left + 60)
    const by = L.Y(L.top + 26)
    const bw = L.S(360)
    const bh = L.S(10)
    g.roundRect(bx, by, bw, bh, L.S(5)).fill({ color: 0x1a1a26 })
    const w = (bw * Math.max(0, this.hp)) / 100
    if (w > 0) {
      g.roundRect(bx, by, Math.max(bh, w), bh, L.S(5))
        .fill({ color: this.hp > 30 ? KB.laneColor(2) : KB.MISS_RED })
    }
    g.roundRect(bx, by, bw, bh, L.S(5)).stroke({ width: 1, color: 0x787890 })

    const target = this.rhythm.getScore()
    this.scoreShown += (target - this.scoreShown) * Math.min(1, 8 * dt)
    this.scoreText.text =
      `${Math.trunc(this.scoreShown).toLocaleString('en-US')} · ${this.rhythm.getAccuracy().toFixed(1)} %`
    this.scoreText.scale.set(L.S(32) / 96)
    this.scoreText.x = L.X(L.right - 60)
    this.scoreText.y = L.Y(L.top + 44)

    this.comboText.text = `${this.rhythm.combo}x`
    this.comboText.scale.set(L.S(56) / 96)
    this.comboText.x = L.X(L.right - 60)
    this.comboText.y = L.Y(L.bottom - 18)

    const showTitle = Boolean(this.title) && t <= this.leadIn
    this.titleText.visible = showTitle
    if (showTitle) {
      this.titleText.alpha = Math.min(1, t / 0.6) * Math.min(1, Math.max(0, (this.leadIn - t) / 0.5))
      this.titleText.scale.set(L.S(40) / 96)
      this.titleText.x = L.X(960)
      this.titleText.y = L.Y(L.top + 120)
    }

    this.failText.visible = this.failed
    if (this.failed) {
      this.failText.scale.set(L.S(64) / 96)
      this.failText.x = L.X(960)
      this.failText.y = L.Y(540)
    }
  }

  destroy(): void {
    this.tex.clear()
    this.stage.destroy({ children: true })
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
