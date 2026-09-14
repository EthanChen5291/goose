/**
 * The victory cinematic: the stickman battle, recreated shot for shot.
 *
 * The reference is a fifteen-second stick-figure fight — a red fighter whose
 * eyes light up, a yellow one already hurt; a fast exchange; a crash zoom on a
 * grab; a montage of claw slashes over a red vortex with the fighters in
 * silhouette; a cross slash; a throw across the field; the red one charging
 * with kanji circling him; a fist filling the frame and the picture inverting;
 * a white-out; five kanji title cards; and a last exchange.  Here the red
 * fighter is the goose — a goose-coloured stickman with the goose's head — and
 * the yellow one is the enemy it just beat, drawn with its own frames.
 *
 * Everything is authored as a shot list over one clock: each shot sets the
 * camera (a whole-number zoom on the world container, snapped), the poses and
 * the effects for its span, so any moment can be drawn from its time alone and
 * skipping costs nothing.  It draws into the same pixel buffer the fight used.
 */
import { ColorMatrixFilter, Container, Graphics, Sprite } from 'pixi.js'
import type { Texture } from 'pixi.js'
import type { PxAssets, Strip } from './assets'
import type { PixelCanvas } from './canvas'
import { PixelScene } from './scene'
import { FxLayer } from './fx'
import type { LevelSpec } from './levels'

const INK = 0x17181a
const WHITE = 0xebf0ef
const ORANGE = 0xecb187
const GLOW = 0xffb347
const SLASH = 0xffd23a
const SLASH_CORE = 0xfff4c0
const VORTEX = 0x3a0808
const VORTEX_LINE = 0x6a1212

export const CINEMATIC_SECS = 14.8

// ── the stick goose ──────────────────────────────────────────────────────────
/** a limb: two angles from straight down, positive toward the way it faces */
type Limb = [number, number]
interface Stick {
  x: number; y: number; face: 1 | -1
  /** lean from vertical, positive forward */
  torso: number
  head: [number, number]
  arms: [Limb, Limb]
  legs: [Limb, Limb]
  eyes: 'shut' | 'open' | 'glow'
  /** drawn as a black silhouette */
  ink: boolean
}
const TORSO = 13, UPPER = 7, FORE = 7, THIGH = 8, SHIN = 8
const D = Math.PI / 180

const STAND: Omit<Stick, 'x' | 'y' | 'face'> = {
  torso: 0, head: [0, 0], arms: [[10 * D, 0], [-10 * D, 0]], legs: [[8 * D, 0], [-8 * D, 0]], eyes: 'open', ink: false,
}
/** named poses: what a shot asks for */
const POSE: Record<string, Partial<Omit<Stick, 'x' | 'y' | 'face'>>> = {
  stand: {},
  // wide stance, guard up, leaning in — the fighter waiting
  stance: { torso: 12 * D, arms: [[110 * D, 160 * D], [70 * D, 150 * D]], legs: [[35 * D, -10 * D], [-30 * D, 10 * D]] },
  hunch: { torso: 45 * D, head: [0, 3], arms: [[40 * D, 60 * D], [30 * D, 50 * D]], legs: [[20 * D, -30 * D], [-15 * D, -20 * D]], eyes: 'shut' },
  handface: { torso: -5 * D, arms: [[150 * D, 80 * D], [-10 * D, 0]], legs: [[8 * D, 0], [-8 * D, 0]] },
  lunge: { torso: 30 * D, arms: [[100 * D, 90 * D], [-40 * D, -20 * D]], legs: [[60 * D, -20 * D], [-40 * D, 30 * D]] },
  punch: { torso: 15 * D, arms: [[90 * D, 90 * D], [-60 * D, -100 * D]], legs: [[40 * D, -10 * D], [-30 * D, 20 * D]] },
  punch2: { torso: 18 * D, arms: [[-60 * D, -100 * D], [95 * D, 85 * D]], legs: [[45 * D, -10 * D], [-28 * D, 20 * D]] },
  block: { torso: -8 * D, arms: [[120 * D, 200 * D], [100 * D, 190 * D]], legs: [[15 * D, 0], [-20 * D, 10 * D]] },
  kick: { torso: -15 * D, arms: [[-40 * D, -60 * D], [60 * D, 40 * D]], legs: [[95 * D, 100 * D], [-15 * D, 10 * D]] },
  overhead: { torso: 10 * D, arms: [[180 * D, 170 * D], [30 * D, 60 * D]], legs: [[30 * D, -10 * D], [-25 * D, 15 * D]] },
  swing: { torso: 20 * D, arms: [[100 * D, 120 * D], [-30 * D, -60 * D]], legs: [[40 * D, -10 * D], [-30 * D, 20 * D]] },
  grab: { torso: 22 * D, arms: [[85 * D, 95 * D], [80 * D, 100 * D]], legs: [[35 * D, -10 * D], [-25 * D, 15 * D]] },
  crouch: { torso: 25 * D, head: [0, 2], arms: [[-50 * D, -90 * D], [-45 * D, -80 * D]], legs: [[60 * D, -60 * D], [-60 * D, 60 * D]] },
  charge: { torso: 8 * D, arms: [[-60 * D, -120 * D], [-60 * D, -120 * D]], legs: [[30 * D, -5 * D], [-30 * D, 5 * D]] },
  bigpunch: { torso: 35 * D, arms: [[95 * D, 95 * D], [-70 * D, -110 * D]], legs: [[70 * D, -20 * D], [-35 * D, 30 * D]] },
  lift: { torso: -10 * D, arms: [[175 * D, 180 * D], [170 * D, 180 * D]], legs: [[20 * D, 0], [-20 * D, 0]] },
  walk1: { torso: 4 * D, arms: [[30 * D, 20 * D], [-30 * D, -10 * D]], legs: [[30 * D, -10 * D], [-25 * D, 20 * D]] },
  walk2: { torso: 4 * D, arms: [[-30 * D, -10 * D], [30 * D, 20 * D]], legs: [[-25 * D, 20 * D], [30 * D, -10 * D]] },
}
function stick(x: number, y: number, face: 1 | -1, name: string, extra: Partial<Stick> = {}): Stick {
  return { x, y, face, ...STAND, ...(POSE[name] ?? {}), ...extra } as Stick
}

/** draw a stick goose: ink under, colour over, orange hands, feet and beak */
function drawStick(g: Graphics, s: Stick): void {
  const f = s.face
  const hip: [number, number] = [s.x, s.y - THIGH - SHIN + 2]
  const neck: [number, number] = [hip[0] + Math.sin(s.torso) * TORSO * f, hip[1] - Math.cos(s.torso) * TORSO]
  const shoulder: [number, number] = [hip[0] + (neck[0] - hip[0]) * 0.9, hip[1] + (neck[1] - hip[1]) * 0.9]
  const seg = (from: [number, number], L: number, a: number): [number, number] => [from[0] + Math.sin(a) * L * f, from[1] + Math.cos(a) * L]
  const limbs: [number, number][][] = []
  for (const [a1, a2] of s.arms) { const e = seg(shoulder, UPPER, a1); limbs.push([shoulder, e, seg(e, FORE, a2)]) }
  for (const [a1, a2] of s.legs) { const k = seg(hip, THIGH, a1); limbs.push([hip, k, seg(k, SHIN, a2)]) }
  const body = s.ink ? INK : WHITE
  const acc = s.ink ? INK : ORANGE
  const R = (p: [number, number]) => [Math.round(p[0]), Math.round(p[1])] as [number, number]
  const poly = (pts: [number, number][], w: number, c: number) => {
    const p0 = R(pts[0])
    g.moveTo(p0[0], p0[1])
    for (const p of pts.slice(1)) { const q = R(p); g.lineTo(q[0], q[1]) }
    g.stroke({ width: w, color: c, cap: 'round', join: 'round' })
  }
  // ink pass
  if (!s.ink) { poly([hip, neck], 5, INK); for (const l of limbs) poly(l, 5, INK) }
  poly([hip, neck], 3, body)
  for (const l of limbs) poly(l, 3, body)
  // hands and feet
  for (let i = 0; i < 4; i++) {
    const e = R(limbs[i][2])
    if (i < 2) g.rect(e[0] - 1, e[1] - 1, 3, 3).fill(acc)
    else g.rect(e[0] - 1 + (f > 0 ? 0 : -2), e[1] - 1, 4, 2).fill(acc)
  }
  // the goose head: a disc with a beak, the eye
  const hx = Math.round(neck[0] + f * 2 + s.head[0]), hy = Math.round(neck[1] - 5 + s.head[1])
  if (!s.ink) g.circle(hx, hy, 6).fill(INK)
  g.circle(hx, hy, 5).fill(body)
  g.poly([hx + f * 4, hy - 2, hx + f * 10, hy, hx + f * 4, hy + 2]).fill(s.ink ? INK : ORANGE)
  if (!s.ink) {
    if (s.eyes === 'glow') g.rect(hx + f * 1 - 1, hy - 2, 3, 2).fill(GLOW)
    else if (s.eyes === 'open') g.rect(hx + f * 1, hy - 2, 1, 1).fill(INK)
    else g.rect(hx + f * 0, hy - 1, 2, 1).fill(INK)
  }
}

// ── shots ───────────────────────────────────────────────────────────────────
interface Cam { x: number; y: number; zoom: number }
interface Ctx {
  t: number; u: number; age: number
  W: number; H: number; gy: number
  cam: Cam
  goose: Stick | null
  enemy: { x: number; y: number; face: 1 | -1; frame: [string, number]; rot: number; ink: boolean; visible: boolean }
  vortex: boolean; white: boolean; invert: boolean; redNeg: boolean
  bg: number | null
  slashes: [number, number, number, boolean][]   // x, y, angle, big
  flare: [number, number, number] | null           // x, y, radius
  lines: 'launch' | 'zigzag' | null
  card: [string, number, number] | null            // kanji, colour, bg
  /** the fist coming at the camera: x, y, half-size */
  fist: [number, number, number] | null
  orbit: boolean
  dust: [number, number][]
  shake: number
}
type Shot = { t0: number; t1: number; run: (c: Ctx) => void; sfx?: [number, string][] }
const step = (u: number, n: number) => Math.floor(u * n)
const snap = (u: number, fps: number, dur: number) => Math.floor(u * dur * fps)

export class PixelCinematic {
  readonly stage = new Container()
  private world = new Container()
  private scene: PixelScene
  private ground = new Graphics()
  private vortexGfx = new Graphics()
  private figures = new Graphics()
  private enemySprite = new Sprite()
  private fxGfx = new Graphics()
  private fx: FxLayer
  private kanjiLayer = new Container()
  private overlay = new Graphics()
  private invert = new ColorMatrixFilter()
  private fired = new Set<string>()
  private strips: Record<string, Strip>
  private enemyFeet: number
  private shots: Shot[]
  private done = false
  sfx: (name: string, delay?: number) => void = () => {}

  constructor(private canvas: PixelCanvas, private assets: PxAssets, level: LevelSpec) {
    this.scene = new PixelScene(assets)
    this.scene.set(level.scene)
    this.strips = assets.char(level.enemy.char)
    const e = assets.manifest.chars[level.enemy.char]
    this.enemyFeet = e.feet
    this.enemySprite.anchor.set(0.5, e.feet / e.fh)
    this.enemySprite.roundPixels = true
    this.fx = new FxLayer(assets)
    this.invert.negative(false)
    this.world.addChild(this.scene.container, this.ground, this.vortexGfx, this.enemySprite, this.figures, this.fxGfx, this.fx.container, this.kanjiLayer)
    this.stage.addChild(this.world, this.overlay)
    this.shots = this.buildShots()
    this.layout()
  }

  layout(): void {
    this.scene.layout(this.canvas.w, this.canvas.h)
  }

  get finished(): boolean { return this.done }

  private get W(): number { return this.canvas.w }
  private get H(): number { return this.canvas.h }
  private get gy(): number { return this.scene.groundY }

  /** the two places the fighters stand: enemy left, goose right, as in the fight */
  private get ex(): number { return Math.round(this.W * 0.3) }
  private get gx(): number { return Math.round(this.W * 0.6) }

  // ── the shot list ─────────────────────────────────────────────────────────
  private buildShots(): Shot[] {
    const S: Shot[] = []
    const add = (t0: number, t1: number, run: (c: Ctx) => void, sfx?: [number, string][]) => S.push({ t0, t1, run, sfx })
    const gx = () => this.gx, ex = () => this.ex, gy = () => this.gy
    const glowGoose = (name: string, extra: Partial<Stick> = {}) => stick(gx(), gy(), -1, name, { eyes: 'glow', ...extra })

    // 1 · 0.00–0.55  close on the goose, dark, eyes shut — the fighter before it starts
    add(0, 0.55, (c) => {
      c.goose = stick(gx(), gy(), -1, 'stand', { eyes: 'shut' })
      c.cam = { x: gx() - 2, y: gy() - 22, zoom: 4 }
      c.bg = 0x000000
      c.enemy.visible = false
    })
    // 2 · 0.55–1.0  the eyes light: a white burst and orange streaks
    add(0.55, 1.0, (c) => {
      c.goose = glowGoose('stand')
      c.cam = { x: gx() - 2, y: gy() - 22, zoom: 4 }
      c.bg = 0x000000
      c.enemy.visible = false
      const r = [4, 9, 13, 10, 6][Math.min(4, step(c.u, 5))]
      c.flare = [gx() - 4, gy() - 34, r]
    }, [[0, 'eye_glow'], [0.05, 'flash_hit']])
    // 3 · 1.0–1.25  the flare settles; a hand to the face
    add(1.0, 1.25, (c) => {
      c.goose = glowGoose('handface')
      c.cam = { x: gx() - 2, y: gy() - 22, zoom: 4 }
      c.bg = 0x000000
      c.enemy.visible = false
      c.flare = [gx() - 4, gy() - 34, 3]
    })
    // 4 · 1.25–2.6  WIDE: the enemy hunched, the goose in its stance, the camera settling
    add(1.25, 2.6, (c) => {
      c.goose = glowGoose('stance')
      c.enemy = { ...c.enemy, x: ex(), y: gy(), frame: ['hurt', 2], visible: true }
      c.cam = { x: this.W / 2, y: this.H / 2 - Math.round(6 * (1 - c.u)), zoom: 1 }
      if (snap(c.u, 2, 1.35) % 2 === 1) c.enemy.y = gy() + 1   // a laboured breath
    }, [[0, 'thud']])
    // 5 · 2.6–2.9  the enemy lunges
    add(2.6, 2.9, (c) => {
      c.goose = glowGoose('stance')
      c.enemy = { ...c.enemy, x: ex() + Math.round(c.u * 40), y: gy(), frame: ['attack', Math.min(2, step(c.u, 3))], visible: true }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
      c.dust.push([ex() + 6, gy()])
    }, [[0, 'whoosh']])
    // 6 · 2.9–4.4  MID: the exchange, a beat every 0.19 s
    add(2.9, 4.4, (c) => {
      const beats: [string, [string, number], number, number][] = [
        ['block', ['attack', 3], 0, 0], ['punch', ['hurt', 1], -6, 2], ['punch2', ['hurt', 2], -8, 4],
        ['kick', ['attack', 1], -4, 0], ['block', ['attack', 4], 0, -2], ['swing', ['hurt', 0], -10, 4],
        ['overhead', ['hurt', 1], -12, 6], ['grab', ['hurt', 2], -14, 8],
      ]
      const i = Math.min(beats.length - 1, step(c.u, beats.length))
      const [gp, ef, gdx, edx] = beats[i]
      c.goose = glowGoose(gp, { x: gx() + gdx })
      c.enemy = { ...c.enemy, x: ex() + 40 + edx, y: gy(), frame: ef, visible: true }
      c.cam = { x: Math.round((gx() + ex() + 40) / 2), y: gy() - 22, zoom: 2 }
      if (gp === 'swing' || gp === 'overhead') c.slashes.push([ex() + 40 + edx, gy() - 24, gp === 'swing' ? -0.3 : 1.2, false])
      c.shake = i % 2 === 1 ? 1 : 0
    }, [[0, 'slap'], [0.19, 'slap2'], [0.38, 'enemy_hit'], [0.57, 'slap'], [0.76, 'slap2'], [0.95, 'slash'], [1.14, 'slash'], [1.33, 'enemy_hit']])
    // 7 · 4.4–4.6  a wide beat
    add(4.4, 4.6, (c) => {
      c.goose = glowGoose('grab', { x: gx() - 14 })
      c.enemy = { ...c.enemy, x: ex() + 48, y: gy(), frame: ['hurt', 2], visible: true }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
    })
    // 8 · 4.6–5.3  CRASH ZOOM on the grab: the hand closes on the arm
    add(4.6, 5.3, (c) => {
      c.goose = glowGoose('grab', { x: gx() - 14 })
      c.enemy = { ...c.enemy, x: ex() + 48, y: gy(), frame: ['hurt', 2], visible: true }
      c.cam = { x: ex() + 52, y: gy() - 26, zoom: 4 }
      c.shake = c.u < 0.15 ? 2 : 0
    }, [[0, 'crash_zoom'], [0.08, 'kanji']])
    // 9 · 5.3–7.0  the vortex montage: wide beat, slash in silhouette, wide beat …
    add(5.3, 7.0, (c) => {
      const n = 10
      const i = step(c.u, n)
      const vortex = i % 2 === 1
      c.vortex = vortex
      const angles = [-0.35, 0.9, -1.1, 0.5, -0.2]
      c.goose = glowGoose(vortex ? ['swing', 'overhead', 'punch', 'kick', 'swing'][(i >> 1) % 5] : 'stance', { x: gx() - 16, ink: vortex })
      c.enemy = { ...c.enemy, x: ex() + 44, y: gy(), frame: ['hurt', (i >> 1) % 3], visible: true, ink: vortex }
      c.cam = vortex ? { x: ex() + 50, y: gy() - 22, zoom: 2 } : { x: this.W / 2, y: this.H / 2, zoom: 1 }
      if (vortex) c.slashes.push([ex() + 44, gy() - 24, angles[(i >> 1) % 5], false])
      c.shake = vortex ? 1 : 0
    }, [[0.17, 'slash'], [0.51, 'slash'], [0.85, 'slash'], [1.19, 'slash'], [1.53, 'slash']])
    // 10 · 7.0–7.3  the cross slash, white frame
    add(7.0, 7.3, (c) => {
      c.vortex = true
      c.goose = glowGoose('swing', { x: gx() - 16, ink: true })
      c.enemy = { ...c.enemy, x: ex() + 44, y: gy(), frame: ['hurt', 2], visible: true, ink: true }
      c.cam = { x: ex() + 50, y: gy() - 22, zoom: 2 }
      c.slashes.push([ex() + 44, gy() - 24, 0.7, true], [ex() + 44, gy() - 24, -0.7, true])
      c.white = c.u < 0.2
      c.shake = 2
    }, [[0, 'slash'], [0.04, 'slash'], [0.02, 'flash_hit']])
    // 11 · 7.3–7.8  the spin: a smear ring, the enemy shoved
    add(7.3, 7.8, (c) => {
      const i = step(c.u, 4)
      c.goose = glowGoose(['swing', 'overhead', 'punch2', 'stance'][i], { x: gx() - 18, face: i % 2 === 0 ? -1 : 1 })
      c.enemy = { ...c.enemy, x: ex() + 40 - Math.round(c.u * 16), y: gy(), frame: ['hurt', 1], visible: true }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
      c.dust.push([ex() + 30, gy()])
    }, [[0, 'whoosh'], [0.25, 'enemy_hit']])
    // 12 · 7.8–8.3  CLOSE: the goose closes in and takes the enemy by the head
    add(7.8, 8.3, (c) => {
      const i = step(c.u, 3)
      c.goose = glowGoose(['walk1', 'walk2', 'grab'][i], { x: gx() - 22 - i * 8 })
      c.enemy = { ...c.enemy, x: ex() + 24, y: gy(), frame: ['hurt', 2], visible: true }
      c.cam = { x: gx() - 30, y: gy() - 24, zoom: 3 }
      if (i === 2) c.shake = 2
    }, [[0.34, 'kanji']])
    // 13 · 8.3–8.9  WIDE: thrown across the field, tumbling, skidding
    add(8.3, 8.9, (c) => {
      c.goose = glowGoose('swing', { x: gx() - 30 })
      const k = Math.min(1, c.u * 1.4)
      const x = Math.round(ex() + 24 - k * (ex() + 10))
      const y = Math.round(gy() - Math.sin(Math.min(1, k) * Math.PI) * 26)
      c.enemy = { ...c.enemy, x: Math.max(14, x), y, frame: ['hurt', 1], visible: true, rot: step(c.u, 6) % 4 }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
      if (c.u > 0.7) { c.enemy.rot = 1; c.dust.push([c.enemy.x + 4, gy()]) }
    }, [[0, 'throw_far'], [0.45, 'thud']])
    // 14 · 8.9–9.5  the charge: an aura, kanji circling
    add(8.9, 9.5, (c) => {
      c.goose = glowGoose('charge', { x: gx() - 30 })
      c.enemy = { ...c.enemy, x: 16, y: gy(), frame: ['idle', step(c.u, 4)], visible: true, rot: 0 }
      c.cam = { x: gx() - 30, y: gy() - 20, zoom: 2 }
      c.orbit = true
    }, [[0, 'windup'], [0.3, 'menace']])
    // 15 · 9.5–9.7  close on the goose's head
    add(9.5, 9.7, (c) => {
      c.goose = glowGoose('charge', { x: gx() - 30 })
      c.enemy.visible = false
      c.cam = { x: gx() - 34, y: gy() - 30, zoom: 4 }
      c.bg = 0x000000
    })
    // 16 · 9.7–10.0  the fist fills the frame; the picture inverts
    add(9.7, 10.0, (c) => {
      const i = step(c.u, 6)
      c.goose = glowGoose('bigpunch', { x: gx() - 30 - i * 6 })
      c.enemy = { ...c.enemy, x: ex() - 10, y: gy(), frame: ['hurt', 2], visible: true }
      c.cam = { x: ex() + 4, y: gy() - 24, zoom: 4 }
      // the fist, three sizes, filling the frame by the third
      if (i < 3) c.fist = [ex() + 4 + (2 - i) * 10, gy() - 24, [6, 14, 26][i]]
      if (i === 2) c.flare = [ex() + 4, gy() - 24, 20]
      c.invert = i === 3 || i === 4
      c.redNeg = i === 5
      c.white = i === 2
      c.shake = 3
    }, [[0.08, 'uppercut'], [0.14, 'flash_hit']])
    // 17 · 10.0–10.3  flung, speed lines
    add(10.0, 10.3, (c) => {
      c.goose = glowGoose('bigpunch', { x: gx() - 48 })
      c.enemy = { ...c.enemy, x: Math.round(ex() - 10 - c.u * 60), y: gy() - 6, frame: ['hurt', 1], visible: true, rot: 1 }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
      c.lines = 'launch'
      c.white = c.u < 0.1
    }, [[0, 'whoosh']])
    // 18 · 10.3–11.9  WIDE hold: the enemy dazed far left, the goose in its stance; tiny motion
    add(10.3, 11.9, (c) => {
      const sway = snap(c.u, 2, 1.6) % 2
      c.goose = glowGoose('stance', { x: gx() - 30 })
      c.enemy = { ...c.enemy, x: 30 + sway, y: gy(), frame: ['hurt', 2], visible: true, rot: 0 }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
    })
    // 19 · 11.9–12.2  the white-out: silhouettes, lightning, a cross
    add(11.9, 12.2, (c) => {
      c.white = true
      c.goose = glowGoose('stance', { x: gx() - 30, ink: true })
      c.enemy = { ...c.enemy, x: 30, y: gy(), frame: ['hurt', 2], visible: true, ink: true }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
      c.lines = 'zigzag'
      if (c.u > 0.5) c.slashes.push([gx() - 30, gy() - 22, 0.7, true], [gx() - 30, gy() - 22, -0.7, true])
    }, [[0, 'flash_hit'], [0.15, 'slash']])
    // 20 · 12.2–12.9  the kanji cards
    add(12.2, 12.9, (c) => {
      const cards: [string, number, number][] = [
        ['wolf', 0xff3a2a, 0x4a2418], ['fang', 0x4cff6a, 0x143a24], ['fist', 0xc04cff, 0x2a1440],
        ['fist', 0xff4cd6, 0x3a1436], ['strike', 0xff9a2a, 0x3a2410],
      ]
      c.card = cards[Math.min(4, step(c.u, 5))]
      c.goose = glowGoose('stance', { x: gx() - 30, ink: true })
      c.enemy.visible = false
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
    }, [[0, 'kanji'], [0.14, 'kanji'], [0.28, 'kanji'], [0.42, 'kanji'], [0.56, 'kanji']])
    // 21 · 12.9–13.5  the field: the enemy gets up and runs in
    add(12.9, 13.5, (c) => {
      c.goose = glowGoose('stand', { x: gx() - 30 })
      const run = c.u > 0.35
      const x = run ? Math.round(30 + ((c.u - 0.35) / 0.65) * (gx() - 90)) : 30
      c.enemy = { ...c.enemy, x, y: gy(), frame: run ? ['walk', snap(c.u, 10, 0.6) % 4] : ['idle', 0], visible: true, rot: 0 }
      c.cam = { x: this.W / 2, y: this.H / 2, zoom: 1 }
    }, [[0.3, 'run_steps']])
    // 22 · 13.5–14.8  CLOSE: the last exchange — leap, catch, flip, kick, and the goose holds it up
    add(13.5, CINEMATIC_SECS, (c) => {
      const beats: [string, [string, number], number, number, number][] = [
        ['block', ['attack', 2], 0, -10, 0], ['grab', ['hurt', 0], -4, 0, 1], ['swing', ['hurt', 1], -6, -12, 2],
        ['kick', ['hurt', 2], -8, -4, 0], ['grab', ['hurt', 1], -6, -18, 3], ['lift', ['hurt', 2], -6, -34, 1],
        ['lift', ['hurt', 2], -6, -34, 1],
      ]
      const i = Math.min(beats.length - 1, step(c.u, beats.length))
      const [gp, ef, gdx, edy, rot] = beats[i]
      c.goose = glowGoose(gp, { x: gx() - 30 + gdx })
      c.enemy = { ...c.enemy, x: gx() - 58 + (i >= 5 ? 22 : 0), y: gy() + edy, frame: ef, visible: true, rot }
      c.cam = { x: gx() - 44, y: gy() - 26, zoom: 2 }
      c.shake = i === 3 ? 2 : 0
      if (i === 3) c.slashes.push([gx() - 58, gy() - 22, -0.5, false])
    }, [[0, 'slap'], [0.19, 'enemy_hit'], [0.38, 'slash'], [0.57, 'uppercut'], [0.76, 'whoosh'], [0.95, 'kanji']])
    return S
  }

  // ── the frame ─────────────────────────────────────────────────────────────
  draw(t: number): void {
    const W = this.W, H = this.H
    if (t >= CINEMATIC_SECS) { this.done = true; t = CINEMATIC_SECS - 0.001 }
    let shot = this.shots[this.shots.length - 1]
    for (const s of this.shots) if (t >= s.t0 && t < s.t1) { shot = s; break }
    const age = t - shot.t0
    const c: Ctx = {
      t, age, u: Math.min(1, age / (shot.t1 - shot.t0)), W, H, gy: this.gy,
      cam: { x: W / 2, y: H / 2, zoom: 1 }, goose: null,
      enemy: { x: this.ex, y: this.gy, face: 1, frame: ['idle', 0], rot: 0, ink: false, visible: true },
      vortex: false, white: false, invert: false, redNeg: false, bg: null, slashes: [], flare: null, lines: null,
      card: null, fist: null, orbit: false, dust: [], shake: 0,
    }
    shot.run(c)
    // sounds on their cue, once
    for (const [at, name] of shot.sfx ?? []) {
      const key = `${shot.t0}:${at}:${name}`
      if (age >= at && !this.fired.has(key)) { this.fired.add(key); this.sfx(name) }
    }

    // the camera: whole-number zoom, snapped, with a kick
    const z = c.cam.zoom
    const kx = c.shake ? ((Math.floor(t * 40) % 2) * 2 - 1) * c.shake : 0
    this.world.scale.set(z)
    this.world.x = Math.round(W / 2 - c.cam.x * z) + kx
    this.world.y = Math.round(H / 2 - c.cam.y * z)

    // the world
    this.scene.setMode(c.vortex || c.white || c.card || c.bg !== null ? 'void' : 'day')
    this.scene.update(t, 1 / 60, 0.3)
    this.scene.container.visible = !c.vortex && !c.white && !c.card && c.bg === null
    this.ground.clear()
    this.vortexGfx.clear()
    if (c.bg !== null) this.vortexGfx.rect(-W, -H, W * 3, H * 3).fill({ color: c.bg })
    if (c.vortex) this.drawVortex(t)
    if (c.white) this.vortexGfx.rect(-W, -H, W * 3, H * 3).fill({ color: 0xffffff })
    if (c.card) this.vortexGfx.rect(-W, -H, W * 3, H * 3).fill({ color: c.card[2] })
    if (!c.vortex && !c.white && !c.card && c.bg === null) {
      this.ground.rect(-W, this.gy, W * 3, 2).fill({ color: 0x2c3a20 })
    }

    // the enemy
    const es = this.enemySprite
    es.visible = c.enemy.visible
    if (c.enemy.visible) {
      const strip = this.strips[c.enemy.frame[0]] ?? this.strips.idle
      const tex: Texture = strip.frames[Math.min(strip.frames.length - 1, c.enemy.frame[1])]
      es.texture = tex
      es.scale.x = c.enemy.face
      es.scale.y = 1
      es.rotation = c.enemy.rot * Math.PI / 2
      es.x = Math.round(c.enemy.x)
      es.y = Math.round(c.enemy.y)
      es.tint = c.enemy.ink ? INK : 0xffffff
      // lying on its side: the anchor is the feet, so lift it by half a body
      if (c.enemy.rot % 2 === 1) es.y = Math.round(c.enemy.y - this.enemyFeet * 0.35)
    }

    // the goose, the effects
    const g = this.figures
    g.clear()
    if (c.goose) drawStick(g, c.goose)
    const f = this.fxGfx
    f.clear()
    for (const [x, y, a, big] of c.slashes) this.drawSlash(f, x, y, a, big, t)
    if (c.flare) this.drawFlare(f, c.flare[0], c.flare[1], c.flare[2])
    if (c.fist) {
      // a goose fist: an orange block with an ink edge and three knuckle lines
      const [fx0, fy0, r] = c.fist
      f.roundRect(Math.round(fx0 - r) - 1, Math.round(fy0 - r) - 1, r * 2 + 2, r * 2 + 2, Math.max(1, r >> 2)).fill(INK)
      f.roundRect(Math.round(fx0 - r), Math.round(fy0 - r), r * 2, r * 2, Math.max(1, r >> 2)).fill(ORANGE)
      for (let k = 0; k < 3; k++) f.rect(Math.round(fx0 - r * 0.6 + k * r * 0.6), Math.round(fy0 - r * 0.7), 1, Math.max(2, r >> 2)).fill(INK)
    }
    if (c.lines === 'launch' && c.enemy.visible) this.drawLaunchLines(f, c.enemy.x + 20, c.enemy.y - 20, t)
    if (c.lines === 'zigzag') this.drawZigzags(f, t)
    if (c.orbit && c.goose) this.drawOrbit(c.goose.x, c.goose.y - 20, age)
    else this.kanjiLayer.visible = false
    for (const [x, y] of c.dust) if (Math.floor(t * 12) % 3 === 0) this.fx.spawn('dust_s', x, y - 4, t)
    this.fx.update(t)

    // the kanji card, over everything in the world
    this.overlay.clear()
    this.drawCard(c.card)
    if (c.redNeg) this.overlay.rect(0, 0, W, H).fill({ color: 0xff2020, alpha: 0.55 })
    this.stage.filters = c.invert || c.redNeg ? [this.invert] : []
  }

  /** the red vortex: dark red with curved streaks sweeping toward the centre */
  private drawVortex(t: number): void {
    const g = this.vortexGfx
    const W = this.W, H = this.H
    g.rect(-W, -H, W * 3, H * 3).fill({ color: VORTEX })
    const cx = this.ex + 50, cy = this.gy - 22
    const turn = Math.floor(t * 20) * 0.35
    for (let i = 0; i < 14; i++) {
      const a = turn + i * (Math.PI * 2 / 14)
      const r0 = 20 + (i % 3) * 8, r1 = 160
      const a1 = a + 0.9
      g.moveTo(Math.round(cx + Math.cos(a) * r0), Math.round(cy + Math.sin(a) * r0))
        .lineTo(Math.round(cx + Math.cos((a + a1) / 2) * (r0 + r1) / 2), Math.round(cy + Math.sin((a + a1) / 2) * (r0 + r1) / 2))
        .lineTo(Math.round(cx + Math.cos(a1) * r1), Math.round(cy + Math.sin(a1) * r1))
        .stroke({ width: 2 + (i % 2), color: VORTEX_LINE, alpha: 0.9 })
    }
  }

  /** three parallel claw streaks with a bright core, the way the reference draws a slash */
  private drawSlash(g: Graphics, x: number, y: number, a: number, big: boolean, t: number): void {
    const L = big ? 90 : 26
    const dx = Math.cos(a), dy = Math.sin(a)
    const nx = -dy, ny = dx
    const jit = Math.floor(t * 30) % 2
    for (let k = -1; k <= 1; k++) {
      const off = k * (big ? 7 : 4) + jit
      const x0 = x - dx * L + nx * off, y0 = y - dy * L + ny * off
      const x1 = x + dx * L + nx * off, y1 = y + dy * L + ny * off
      g.moveTo(Math.round(x0), Math.round(y0)).lineTo(Math.round(x1), Math.round(y1)).stroke({ width: big ? 5 : 3, color: SLASH })
      g.moveTo(Math.round(x0), Math.round(y0)).lineTo(Math.round(x1), Math.round(y1)).stroke({ width: big ? 2 : 1, color: SLASH_CORE })
    }
  }

  /** the eye lighting up: a white burst and long orange streaks either side */
  private drawFlare(g: Graphics, x: number, y: number, r: number): void {
    g.circle(Math.round(x), Math.round(y), r).fill({ color: 0xffffff, alpha: 0.9 })
    g.circle(Math.round(x), Math.round(y), Math.max(1, Math.round(r * 0.5))).fill({ color: 0xfff4c0 })
    g.rect(Math.round(x - r * 2.6), y - 1, Math.round(r * 5.2), 2).fill({ color: GLOW, alpha: 0.9 })
    g.rect(Math.round(x - r * 1.6), y - 2, Math.round(r * 3.2), 4).fill({ color: GLOW, alpha: 0.6 })
  }

  private drawLaunchLines(g: Graphics, x: number, y: number, t: number): void {
    const jit = Math.floor(t * 30) % 2
    for (let i = 0; i < 9; i++) {
      const yy = y - 30 + i * 8 + jit
      g.moveTo(x, yy).lineTo(x + 120 + (i % 3) * 20, yy).stroke({ width: 1, color: 0xffffff, alpha: 0.9 })
    }
  }

  /** lightning over the white-out: zigzags from the top, redrawn every few frames */
  private drawZigzags(g: Graphics, t: number): void {
    const seed = Math.floor(t * 15)
    for (let k = 0; k < 4; k++) {
      let x = 40 + k * 90 + (seed * 37 + k * 13) % 30, y = -10
      g.moveTo(x, y)
      for (let s = 0; s < 7; s++) { x += ((seed + s + k) % 3 - 1) * 14; y += 22; g.lineTo(x, y) }
      g.stroke({ width: 2, color: INK })
    }
  }

  /** the charge: small gold kanji circling the goose, stepping round every eighth */
  private kanjiSprites: Sprite[] = []
  private drawOrbit(x: number, y: number, age: number): void {
    const names = ['fist', 'power', 'swift', 'strike', 'roar', 'soar']
    this.kanjiLayer.visible = true
    const turn = Math.floor(age * 8) * (Math.PI / 6)
    names.forEach((n, i) => {
      let s = this.kanjiSprites[i]
      if (!s) { s = new Sprite(); s.anchor.set(0.5); s.roundPixels = true; s.tint = 0xffd23a; this.kanjiLayer.addChild(s); this.kanjiSprites.push(s) }
      s.texture = this.assets.ui(`k16_${n}`)
      const a = turn + (i / names.length) * Math.PI * 2
      s.x = Math.round(x + Math.cos(a) * 26)
      s.y = Math.round(y + Math.sin(a) * 12 - 4)
      s.visible = true
      s.alpha = 0.9
    })
  }

  /** a kanji title card: the big face with a dark shadow over a tinted ground */
  private cardSprite: [Sprite, Sprite] | null = null
  private drawCard(card: [string, number, number] | null): void {
    if (!this.cardSprite) {
      const sh = new Sprite(); sh.anchor.set(0.5); sh.roundPixels = true; sh.tint = INK
      const sp = new Sprite(); sp.anchor.set(0.5); sp.roundPixels = true
      this.stage.addChild(sh, sp)
      this.cardSprite = [sh, sp]
    }
    const [sh, sp] = this.cardSprite
    sh.visible = sp.visible = card !== null
    if (!card) return
    const tex = this.assets.ui(`k48_${card[0]}`)
    sh.texture = sp.texture = tex
    sp.tint = card[1]
    // twice the size, in whole pixels, a little left of centre like the reference
    sh.scale.set(2); sp.scale.set(2)
    sp.x = Math.round(this.W * 0.38); sp.y = Math.round(this.H * 0.45)
    sh.x = sp.x + 4; sh.y = sp.y + 4
  }

  destroy(): void {
    this.fx.clear()
    this.stage.destroy({ children: true })
  }
}
