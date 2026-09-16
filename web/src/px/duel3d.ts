/**
 * The duel's stage, in three.js: a slab of dark glass floating in the level's
 * sky, the goose on it seen from behind, the enemy down the far end, and the
 * enemy's attacks flying up the lane at the camera.
 *
 * It renders into an offscreen canvas the size of the pixel buffer; the play
 * renderer (`duel.ts`) puts that canvas in the buffer as a texture and draws
 * the HUD, the effect strips and the kanji over it in game pixels, so the 3D
 * has the same chunky pixels as everything else.
 *
 * The goose is the movie's jointed box rig (`goose_rig.ts`), scaled small and
 * turned to face down the lane.  The enemy is its own sprite made solid, frame
 * by frame (`voxelize`), so its idle, attack, hurt and death strips play in 3D.
 * Every attack is a body that leaves the enemy `preempt` seconds before its
 * note and reaches the goose exactly on it — that is the approach circle of
 * this mode.  What the goose must do is in the shape of the attack: a wall of
 * laser covering two of the three columns (step to the open one), a blade at
 * neck height (flatten), a wave along the floor (jump), an orb (peck it back),
 * the enemy itself rushing in (peck it back, harder).
 */
import * as THREE from 'three'
import type { Manifest, SceneInfo } from './assets'
import { buildGoose, clips, mix, pose, REST } from '../screens/goose_rig'
import type { GPose, GooseRig } from '../screens/goose_rig'
import { voxelize, voxelMesh, readStrip, toonRamp } from '../screens/goose_world'
import type { Voxel } from '../screens/goose_world'

export type AttackKind = 'wall' | 'slash' | 'wave' | 'orb' | 'lunge'
export type DodgeKind = 'left' | 'right' | 'duck' | 'jump' | 'strike'
type GooseAct = DodgeKind | 'idle' | 'hurt' | 'cheer'

/** goose units → world: the goose stands 5.5 tall */
const S = 0.2
/** the three columns the goose can stand in */
export const COL = 4
/** where the enemy stands, and where attacks leave from */
const ENEMY_Z = -27
const SPAWN_Z = -24
/** the enemy's stop when it rushes the goose */
const LUNGE_Z = -5
const CAM_Z = 15.5
const INK = 0x17181a
const TAU = Math.PI * 2

const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp01 = (u: number) => Math.max(0, Math.min(1, u))
const smooth = (u: number) => u * u * (3 - 2 * u)
const easeOut = (u: number) => 1 - (1 - u) ** 3
const easeIn = (u: number) => u * u * u

// ── the enemy, made solid ────────────────────────────────────────────────────
export interface EnemyVoxels {
  frames: Record<string, Voxel[][]>
  fps: Record<string, number>
  fw: number
  fh: number
  feet: number
}
const voxelCache = new Map<string, Promise<EnemyVoxels>>()
/** every strip of the enemy voxelised once; the shell calls this while the song loads */
export function loadEnemyVoxels(manifest: Manifest, char: string): Promise<EnemyVoxels> {
  let p = voxelCache.get(char)
  if (!p) {
    p = (async () => {
      const c = manifest.chars[char]
      const frames: Record<string, Voxel[][]> = {}
      const fps: Record<string, number> = {}
      for (const [name, a] of Object.entries(c.anims)) {
        if (!['idle', 'attack', 'attack2', 'hurt', 'die'].includes(name)) continue
        const px = await readStrip(a.url, a.fw, a.fh, a.n)
        frames[name] = px.map((f) => voxelize(f, a.fw, a.fh))
        fps[name] = a.fps
      }
      return { frames, fps, fw: c.fw, fh: c.fh, feet: c.feet }
    })()
    voxelCache.set(char, p)
  }
  return p
}

/** the enemy figure: one instanced mesh per frame, shown one at a time, with a white twin for the hit flash */
class Figure {
  readonly g = new THREE.Group()
  /** spins about the body's middle when tossed */
  readonly pivot = new THREE.Group()
  readonly height: number
  private toon = new Map<string, THREE.InstancedMesh[]>()
  private white = new Map<string, THREE.InstancedMesh[]>()
  private fps: Record<string, number>
  private anim = 'idle'
  private t0 = 0
  private loop = true
  private hold: { frame: number; until: number } | null = null
  private shown: THREE.InstancedMesh | null = null
  flashUntil = -1

  constructor(vox: EnemyVoxels, base: THREE.MeshToonMaterial) {
    this.fps = vox.fps
    this.height = vox.feet * 0.72
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    this.pivot.position.y = this.height / 2
    this.g.add(this.pivot)
    for (const [name, frames] of Object.entries(vox.frames)) {
      const mk = (mat: THREE.Material, blank: boolean): THREE.InstancedMesh[] => frames.map((v) => {
        const m = voxelMesh(blank ? v.map((x) => ({ ...x, color: 0xffffff })) : v, mat, vox.fw / 2, vox.feet)
        m.castShadow = false
        m.visible = false
        m.position.y = -this.height / 2
        this.pivot.add(m)
        return m
      })
      this.toon.set(name, mk(base, false))
      this.white.set(name, mk(whiteMat, true))
    }
  }

  has(name: string): boolean { return this.toon.has(name) }

  /** start a strip at `t0` (may be in the past: the frame is computed from the clock) */
  play(name: string, t0: number, loop: boolean): void {
    if (!this.toon.has(name)) return
    this.anim = name; this.t0 = t0; this.loop = loop; this.hold = null
  }
  get current(): string { return this.anim }
  /** keep showing `frame` until `until`, then carry on from it */
  holdFrame(frame: number, until: number): void { this.hold = { frame, until } }

  update(t: number): void {
    const frames = this.toon.get(this.anim) ?? this.toon.get('idle')!
    const fps = this.fps[this.anim] ?? 12
    let i: number
    if (this.hold && t < this.hold.until) i = this.hold.frame
    else {
      if (this.hold) { this.t0 = this.hold.until - this.hold.frame / fps; this.hold = null }
      i = Math.floor(Math.max(0, t - this.t0) * fps)
      if (this.loop) i %= frames.length
      else if (i >= frames.length) {
        if (this.anim === 'die') i = frames.length - 1
        else { this.anim = 'idle'; this.t0 = t; i = 0 }
      }
    }
    const set = (t < this.flashUntil ? this.white : this.toon).get(this.anim) ?? frames
    const mesh = set[Math.min(i, set.length - 1)]
    if (mesh !== this.shown) { if (this.shown) this.shown.visible = false; mesh.visible = true; this.shown = mesh }
  }
}

// ── attacks ─────────────────────────────────────────────────────────────────
export interface Attack {
  id: number
  kind: AttackKind
  /** for a wall: the side it covers (+1 right, −1 left) */
  side: number
  t0: number
  tHit: number
  color: number
  label: string
  g: THREE.Group
  resolved: 'none' | 'hit' | 'miss'
  /** an orb pecked back: when it left the beak */
  returnT: number
  alive: boolean
  /** the mesh's centre above the ground, for the label */
  top: number
}

/** a glowing body: a bright core, a coloured shell and the ink hull outside it */
function glow(w: number, h: number, d: number, color: number, core = true): THREE.Group {
  const g = new THREE.Group()
  const shell = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82 }))
  g.add(shell)
  if (core) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, h * 0.45, d * 1.02), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }))
    g.add(c)
  }
  const hull = new THREE.Mesh(shell.geometry, new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, transparent: true }))
  hull.scale.set((w + 0.3) / w, (h + 0.3) / h, (d + 0.3) / d)
  g.add(hull)
  return g
}

function sphere(r: number, color: number, opacity = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity }))
}

/** remember every material's own opacity so a passing body can be faded and restored */
function bakeOpacity(g: THREE.Object3D): void {
  g.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m) o.userData.op = m.opacity })
}
function fadeTo(g: THREE.Object3D, k: number): void {
  g.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m) m.opacity = (o.userData.op ?? 1) * k })
}

export interface DuelCallbacks {
  /** a counter-bolt or a returned orb landed on the enemy */
  onCounterLand: (t: number, big: boolean, kind: 'bolt' | 'orb' | 'lunge') => void
  /** the goose came down from a jump */
  onLand: (t: number) => void
}

export class DuelWorld {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private base: THREE.MeshToonMaterial
  private goose: GooseRig
  private enemy: Figure | null = null
  private enemyRoot = new THREE.Group()
  private enemyK = S
  private enemyShadow: THREE.Mesh
  private gooseShadow: THREE.Mesh
  private skyLayers: { mesh: THREE.Mesh; depth: number }[] = []
  private edges: THREE.Mesh[] = []
  private pads: THREE.Mesh[] = []
  private attacks: Attack[] = []
  private bolts: { t0: number; from: THREE.Vector3; big: boolean; g: THREE.Group }[] = []
  private sparks: { g: THREE.Mesh; vel: THREE.Vector3; born: number }[] = []
  private nextId = 1
  private w = 1
  private h = 1

  // the goose's state
  private cur: GPose = { ...REST }
  private act: GooseAct = 'idle'
  private actT0 = 0
  private actSide = 0
  private gx = 0
  private gy = 0
  private gz = 0
  private landed = true
  private beat = 0
  // the enemy's state
  private enemyZ = ENEMY_Z
  private shove = 0
  private lunge: { t0: number; tHit: number; state: 'in' | 'hold' | 'back' | 'toss'; sinceT: number } | null = null
  private dead = false
  // the camera
  private camX = 0
  private shake = 0
  private shakeT0 = 0
  private roll = 0
  private scroll = 0
  private v = new THREE.Vector3()

  constructor(private readonly cb: DuelCallbacks, w: number, h: number) {
    this.canvas = document.createElement('canvas')
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'low-power', alpha: false })
    this.renderer.setPixelRatio(1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x9ad4ff)
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500)
    this.base = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp() })

    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2)
    sun.position.set(30, 60, 40)
    this.scene.add(sun)
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a4f66, 1.25))

    // the slab: dark glass, a light edge down each long side, three pads where the goose stands
    const slab = new THREE.Mesh(new THREE.BoxGeometry(15, 1.4, 54), new THREE.MeshBasicMaterial({ color: 0x0b0d18, transparent: true, opacity: 0.9 }))
    slab.position.set(0, -0.7, -18)
    this.scene.add(slab)
    for (const x of [-7.5, 7.5]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 54), new THREE.MeshBasicMaterial({ color: 0xf4f6ff }))
      e.position.set(x, 0.02, -18)
      this.scene.add(e)
      this.edges.push(e)
    }
    // faint cross-lines up the lane: the floor reads as receding
    for (let z = 4; z > -44; z -= 6) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(14.6, 0.06, 0.18), new THREE.MeshBasicMaterial({ color: 0x2a2f45 }))
      l.position.set(0, 0.03, z)
      this.scene.add(l)
    }
    for (const [i, x] of [-COL, 0, COL].entries()) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 2.2), new THREE.MeshBasicMaterial({ color: [0xffaaf1, 0xffde7b, 0x8effc2][i], transparent: true, opacity: 0.35 }))
      pad.position.set(x, 0.05, 0)
      this.scene.add(pad)
      this.pads.push(pad)
    }

    // the goose, small, facing down the lane (it faces +x at yaw 0)
    this.goose = buildGoose(this.base, S, null)
    this.goose.root.rotation.y = Math.PI / 2
    this.scene.add(this.goose.root)
    this.gooseShadow = new THREE.Mesh(new THREE.CircleGeometry(1.9, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }))
    this.gooseShadow.rotation.x = -Math.PI / 2
    this.gooseShadow.position.y = 0.06
    this.scene.add(this.gooseShadow)

    this.enemyRoot.position.set(0, 0, ENEMY_Z)
    this.scene.add(this.enemyRoot)
    this.enemyShadow = new THREE.Mesh(new THREE.CircleGeometry(3.2, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }))
    this.enemyShadow.rotation.x = -Math.PI / 2
    this.enemyShadow.position.set(0, 0.06, ENEMY_Z)
    this.scene.add(this.enemyShadow)

    this.resize(w, h)
  }

  /** the level's sky as planes far down the lane, drifting by depth */
  setSky(info: SceneInfo): void {
    for (const l of this.skyLayers) { this.scene.remove(l.mesh); (l.mesh.material as THREE.Material).dispose() }
    this.skyLayers = []
    const loader = new THREE.TextureLoader()
    info.layers.forEach((layer, i) => {
      const tex = loader.load(layer.url)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.generateMipmaps = false
      tex.wrapS = THREE.RepeatWrapping
      const dist = 170 - i * 12
      const hgt = 2 * (dist + CAM_Z) * Math.tan((50 / 2) * Math.PI / 180) * 1.35
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(hgt * info.w / info.h, hgt), new THREE.MeshBasicMaterial({ map: tex, transparent: i > 0, depthWrite: i === 0, fog: false }))
      // the horizon (the layer's ground row) sits a little under the slab's far end
      mesh.position.set(0, hgt * (0.5 - info.groundY / info.h) - 6, -dist)
      this.scene.add(mesh)
      this.skyLayers.push({ mesh, depth: layer.depth })
    })
  }

  setEnemy(vox: EnemyVoxels, char: string): void {
    if (this.enemy) this.enemyRoot.remove(this.enemy.g)
    this.enemy = new Figure(vox, this.base)
    const k = S * (char === 'ninja' ? 0.7 : 1)
    this.enemyK = k
    this.enemy.g.scale.set(k, k, k * 1.9)
    // the sprite faces +x; turn it to face up the lane at the camera, three-quarter
    this.enemy.g.rotation.y = -Math.PI / 2 + 0.55
    this.enemyRoot.add(this.enemy.g)
    this.enemy.play('idle', 0, true)
  }

  resize(w: number, h: number): void {
    this.w = w; this.h = h
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ── the goose ─────────────────────────────────────────────────────────────
  gooseDo(act: GooseAct, t: number): void {
    this.act = act; this.actT0 = t
    this.actSide = act === 'left' ? -1 : act === 'right' ? 1 : 0
    if (act === 'jump') this.landed = false
  }

  // ── attacks ───────────────────────────────────────────────────────────────
  /** `side` for a wall is the side it covers */
  spawn(kind: AttackKind, side: number, t0: number, tHit: number, color: number, label: string): number {
    const id = this.nextId++
    let g: THREE.Group
    let top = 4
    if (kind === 'wall') {
      g = glow(7.4, 6.4, 3.6, color, false)
      for (let i = 0; i < 3; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.45, 6.0, 3.8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }))
        bar.position.x = -2.3 + i * 2.3
        g.add(bar)
      }
      g.position.set(side * 3.3, 3.3, SPAWN_Z)
      top = 7
    } else if (kind === 'slash') {
      g = glow(14, 0.42, 1.3, color)
      g.position.set(0, 3.7, SPAWN_Z)
      top = 4.8
    } else if (kind === 'wave') {
      g = glow(14, 1.2, 2.0, color)
      g.position.set(0, 0.65, SPAWN_Z)
      top = 2.1
    } else if (kind === 'orb') {
      g = new THREE.Group()
      g.add(sphere(1.15, color))
      g.add(sphere(0.6, 0xffffff))
      const hull = sphere(1.3, INK); (hull.material as THREE.MeshBasicMaterial).side = THREE.BackSide
      g.add(hull)
      for (let i = 1; i <= 3; i++) { const ghost = sphere(1.0 - i * 0.22, color, 0.35 - i * 0.08); ghost.position.z = -i * 1.4; g.add(ghost) }
      g.position.set(0, 3.0, SPAWN_Z)
      top = 4.6
    } else {
      // the lunge: the enemy is the body; only a mark rides above it
      g = new THREE.Group()
      g.position.set(0, 0, ENEMY_Z)
      top = 11
      this.lunge = { t0, tHit, state: 'in', sinceT: t0 }
    }
    bakeOpacity(g)
    this.scene.add(g)
    this.attacks.push({ id, kind, side, t0, tHit, color, label, g, resolved: 'none', returnT: -1, alive: true, top })
    return id
  }

  /** the note was judged: hit → the goose is out of the way (an orb goes back); miss → it connects */
  resolve(id: number, hit: boolean, t: number): void {
    const a = this.attacks.find((x) => x.id === id)
    if (!a) return
    a.resolved = hit ? 'hit' : 'miss'
    if (a.kind === 'orb' && hit) a.returnT = t + 0.06
    if (a.kind === 'lunge' && this.lunge) {
      if (hit) { this.lunge.state = 'toss'; this.lunge.sinceT = t; this.enemyFlash(t, 0.14); this.cb.onCounterLand(t, true, 'lunge') }
      else { this.lunge.state = 'hold'; this.lunge.sinceT = t }
    }
  }

  /** a bolt from the beak to the enemy, landing 0.22 s later */
  counter(t: number, big: boolean): void {
    const from = this.goose.beakAt(new THREE.Vector3())
    const g = glow(0.55, 0.55, big ? 5 : 3.4, big ? 0xffde7b : 0xffffff, false)
    g.position.copy(from)
    this.scene.add(g)
    this.bolts.push({ t0: t, from, big, g })
  }

  enemyFlash(t: number, secs: number): void {
    if (this.enemy) this.enemy.flashUntil = t + secs
    this.shove = 1.6
    this.burst(new THREE.Vector3(0, 5, this.enemyZ), 8, 0xffde7b, t)
  }
  enemyHurt(t: number): void { this.enemy?.play('hurt', t, false) }
  /** the wind-up: the attack strip so its contact frame lands on `tSpawn`; held there while spawns keep coming */
  enemyWindup(tSpawn: number, contactFrame: number, now: number): void {
    if (!this.enemy || this.dead) return
    const fps = 12
    if (this.enemy.current === 'attack' && !(now > tSpawn)) { this.enemy.holdFrame(contactFrame, tSpawn + 0.12); return }
    this.enemy.play('attack', tSpawn - contactFrame / fps, false)
  }
  enemyDie(t: number): void { this.dead = true; this.enemy?.play('die', t, false) }
  enemyTaunt(t: number, name: string): void { this.enemy?.play(this.enemy.has(name) ? name : 'attack', t, true) }

  kick(strength: number, t: number): void { this.shake = Math.max(this.shake, strength); this.shakeT0 = t }

  /** small cubes flung from a point; they fall and fade */
  private burst(at: THREE.Vector3, n: number, color: number, t: number): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), new THREE.MeshBasicMaterial({ color }))
      m.position.copy(at)
      const a = (i / n) * TAU + Math.random() * 0.5
      this.scene.add(m)
      this.sparks.push({ g: m, vel: new THREE.Vector3(Math.cos(a) * 9, 6 + Math.random() * 7, Math.sin(a) * 6 + 4), born: t })
    }
  }

  // ── the frame ─────────────────────────────────────────────────────────────
  private goosePose(t: number, dt: number): void {
    const age = t - this.actT0
    let want: GPose
    let tx = 0, ty = 0, tz = 0
    const idle = clips.idle(t, this.beat)
    switch (this.act) {
      case 'left': case 'right': {
        const env = Math.sin(Math.PI * clamp01(age / 0.55))
        const out = age < 0.34 ? easeOut(clamp01(age / 0.09)) : 1 - smooth(clamp01((age - 0.34) / 0.21))
        tx = this.actSide * COL * out
        want = pose({ roll: -this.actSide * 0.5 * env, wing: 0.7 * env, legs: [0.5 * env, -0.5 * env], neck: -0.15 * env, eye: 1.3, y: idle.y, tail: 0.3 * env })
        if (age > 0.55) this.act = 'idle'
        break
      }
      case 'duck': {
        const env = Math.sin(Math.PI * clamp01(age / 0.5))
        want = pose({ squash: 1 - 0.62 * env, neck: -0.75 * env, head: 0.55 * env, wing: 0.35 * env, eye: 1 - 0.7 * env, y: -0.5 * env, legs: [0.6 * env, -0.6 * env] })
        if (age > 0.5) this.act = 'idle'
        break
      }
      case 'jump': {
        const u = clamp01(age / 0.52)
        ty = 3.8 * 4 * u * (1 - u)
        const flap = Math.max(0, 1 - age * 2.2)
        want = pose({ wing: 0.35 + 0.65 * flap, legs: [0.9 * (1 - u * 0.5), 0.9 * (1 - u * 0.5)], feet: [0.5, 0.5], pitch: 0.25 - 0.5 * u, eye: 1.3, squash: u > 0.94 ? 0.82 : 1, tail: -0.2 })
        if (u >= 1) { this.act = 'idle'; if (!this.landed) { this.landed = true; this.cb.onLand(t) } }
        break
      }
      case 'strike': {
        const env = Math.sin(Math.PI * clamp01(age / 0.36))
        tz = -2.4 * env
        want = pose({ neck: -0.55 * env, head: -0.15 * env, beak: 0.75 * env, wing: 0.6 * env, eye: 1.4, pitch: -0.22 * env, legs: [0.7 * env, -0.4 * env], y: 0.3 * env })
        if (age > 0.36) this.act = 'idle'
        break
      }
      case 'hurt': {
        const env = Math.sin(Math.PI * clamp01(age / 0.6))
        tz = 1.9 * env
        ty = 0.9 * Math.sin(Math.PI * clamp01(age / 0.3))
        want = pose({ pitch: 0.65 * env, roll: Math.sin(t * 40) * 0.12 * env, eye: 1.6, beak: 0.8 * env, wing: env, neck: 0.4 * env, head: -0.3 * env, legs: [-0.6 * env, 0.6 * env] })
        if (age > 0.6) this.act = 'idle'
        break
      }
      case 'cheer': {
        const u = clamp01(age / 0.6)
        ty = 1.6 * 4 * u * (1 - u)
        want = pose({ wing: 1, beak: 0.6, head: 0.35, eye: 1.3, legs: [0.5, 0.5] })
        if (u >= 1) this.act = 'idle'
        break
      }
      default:
        want = idle
    }
    this.cur = mix(this.cur, want, 1 - Math.exp(-dt * 22))
    this.goose.apply(this.cur)
    const k = 1 - Math.exp(-dt * 26)
    this.gx += (tx - this.gx) * k
    this.gy = ty
    this.gz += (tz - this.gz) * k
    this.goose.root.position.set(this.gx, this.gy, this.gz)
    this.gooseShadow.position.set(this.gx, 0.06, this.gz)
    const sh = Math.max(0.35, 1 - this.gy / 5)
    this.gooseShadow.scale.set(sh, sh, sh)
  }

  private enemyStep(t: number, dt: number): void {
    // the lunge: in, hold at the goose, and back — or tossed back, tumbling, if pecked
    let y = 0, spin = 0
    if (this.lunge) {
      const L = this.lunge
      if (L.state === 'in') {
        const u = clamp01((t - L.t0) / Math.max(0.05, L.tHit - L.t0))
        this.enemyZ = lerp(ENEMY_Z, LUNGE_Z, easeIn(u))
        y = Math.abs(Math.sin(u * 14)) * 0.9 * (1 - u)
        if (t > L.tHit + 0.35) { L.state = 'back'; L.sinceT = t }
      } else if (L.state === 'hold') {
        this.enemyZ = LUNGE_Z
        if (t - L.sinceT > 0.25) { L.state = 'back'; L.sinceT = t }
      } else if (L.state === 'back') {
        const u = clamp01((t - L.sinceT) / 0.45)
        this.enemyZ = lerp(LUNGE_Z, ENEMY_Z, smooth(u))
        y = Math.sin(u * Math.PI) * 2
        if (u >= 1) this.lunge = null
      } else {
        const u = clamp01((t - L.sinceT) / 0.6)
        this.enemyZ = lerp(LUNGE_Z, ENEMY_Z, easeOut(u))
        y = Math.sin(u * Math.PI) * 7
        spin = -u * TAU * 1.5
        if (u >= 1) { this.lunge = null; this.enemyHurt(t) }
      }
    } else this.enemyZ += (ENEMY_Z - this.enemyZ) * Math.min(1, dt * 8)
    this.shove = Math.max(0, this.shove - dt * 9)
    this.enemyRoot.position.set(0, y, this.enemyZ - this.shove)
    this.enemyShadow.position.z = this.enemyZ
    if (this.enemy) {
      this.enemy.pivot.rotation.x = spin
      // squares up to the camera when it winds up, three-quarter at rest
      const aim = this.enemy.current === 'attack' || this.lunge ? 0.22 : 0.55
      this.enemy.g.rotation.y += (-Math.PI / 2 + aim - this.enemy.g.rotation.y) * Math.min(1, dt * 10)
      this.enemy.update(t)
    }
  }

  private attacksStep(t: number): void {
    for (const a of this.attacks) {
      if (!a.alive) continue
      if (a.kind === 'lunge') {
        a.g.position.set(0, 0, this.enemyZ)
        if (t > a.tHit + 0.5) a.alive = false
        continue
      }
      if (a.returnT >= 0) {
        // pecked back: to the enemy in a quarter second, then it lands
        const u = (t - a.returnT) / 0.25
        if (u >= 1) {
          a.alive = false
          this.enemyFlash(t, 0.16)
          this.burst(new THREE.Vector3(0, 5, this.enemyZ), 14, a.color, t)
          this.cb.onCounterLand(t, true, 'orb')
          continue
        }
        const zz = lerp(this.gz - 1.5, this.enemyZ + 1, easeIn(clamp01(u)))
        a.g.position.set(this.gx * (1 - u), 3 + Math.sin(u * Math.PI) * 2.5, zz)
        a.g.rotation.y += 0.4
        continue
      }
      const speed = (0 - SPAWN_Z) / Math.max(0.05, a.tHit - a.t0)
      a.g.position.z = SPAWN_Z + speed * (t - a.t0)
      if (a.kind === 'orb') { a.g.rotation.x += 0.15; a.g.rotation.y += 0.11 }
      if (a.kind === 'slash') a.g.rotation.z = Math.sin(t * 7 + a.id) * 0.16
      if (a.kind === 'wall') a.g.children.forEach((c, i) => { if (i >= 3) c.visible = Math.floor(t * 30 + i) % 2 === 0 })
      // past the goose it thins out, so nothing blots the camera on its way by
      if (a.g.position.z > 1) fadeTo(a.g, 1 - clamp01((a.g.position.z - 1) / 7))
      if (a.g.position.z > CAM_Z + 2) a.alive = false
    }
    this.attacks = this.attacks.filter((a) => { if (!a.alive) this.scene.remove(a.g); return a.alive })
  }

  private boltsStep(t: number): void {
    this.bolts = this.bolts.filter((b) => {
      const u = (t - b.t0) / 0.22
      if (u >= 1) {
        this.scene.remove(b.g)
        this.enemyFlash(t, b.big ? 0.14 : 0.09)
        if (b.big) this.burst(new THREE.Vector3(0, 5, this.enemyZ), 10, 0xffde7b, t)
        this.cb.onCounterLand(t, b.big, 'bolt')
        return false
      }
      const target = new THREE.Vector3(0, 5, this.enemyZ + 1.5)
      b.g.position.lerpVectors(b.from, target, easeIn(clamp01(u)) * 0.2 + clamp01(u) * 0.8)
      b.g.lookAt(target)
      return true
    })
  }

  private sparksStep(t: number, dt: number): void {
    this.sparks = this.sparks.filter((s) => {
      const age = t - s.born
      if (age > 0.7) { this.scene.remove(s.g); return false }
      s.vel.y -= 30 * dt
      s.g.position.addScaledVector(s.vel, dt)
      if (s.g.position.y < 0.2) { s.g.position.y = 0.2; s.vel.y = Math.abs(s.vel.y) * 0.4; s.vel.x *= 0.7; s.vel.z *= 0.7 }
      s.g.rotation.x += dt * 9; s.g.rotation.z += dt * 7
      const k = 1 - age / 0.7
      s.g.scale.setScalar(Math.max(0.05, k))
      return true
    })
  }

  update(t: number, dt: number, beat: number, energy: number): void {
    this.beat = beat
    this.goosePose(t, dt)
    this.enemyStep(t, dt)
    this.attacksStep(t)
    this.boltsStep(t)
    this.sparksStep(t, dt)

    // the sky drifts by depth, faster in loud bars
    this.scroll += dt * (0.004 + 0.008 * energy)
    for (const l of this.skyLayers) {
      const m = (l.mesh.material as THREE.MeshBasicMaterial).map
      if (m) m.offset.x = this.scroll * l.depth
    }
    // the edges pulse on the beat; the pads glow where the goose is
    const pulse = 0.55 + 0.45 * Math.max(0, 1 - beat * 3)
    for (const e of this.edges) (e.material as THREE.MeshBasicMaterial).color.setScalar(0.5 + 0.5 * pulse)
    this.pads.forEach((p, i) => {
      const x = (i - 1) * COL
      ;(p.material as THREE.MeshBasicMaterial).opacity = Math.abs(this.gx - x) < 1.5 ? 0.8 : 0.28
    })

    // the camera: behind and above the goose, following its column at half strength, kicked by hits
    this.camX += (this.gx * 0.5 - this.camX) * Math.min(1, dt * 7)
    const age = t - this.shakeT0
    const amp = this.shake * Math.max(0, 1 - age / 0.35)
    const sx = Math.sin(age * 71) * amp * 0.5
    const sy = Math.cos(age * 57) * amp * 0.35
    this.camera.position.set(this.camX + sx + Math.sin(t * 0.7) * 0.15, 8.4 + this.gy * 0.25 + sy, CAM_Z)
    this.camera.lookAt(this.camX * 0.5, 3.4 + this.gy * 0.1, -12)
    this.roll += ((this.gx * 0.012) - this.roll) * Math.min(1, dt * 6)
    this.camera.rotation.z += this.roll
    if (age > 0.35) this.shake = 0
    this.goose.setOutline(0.9)
  }

  render(): void { this.renderer.render(this.scene, this.camera) }

  /** a world point in game pixels */
  project(x: number, y: number, z: number): [number, number] {
    this.v.set(x, y, z).project(this.camera)
    return [Math.round((this.v.x + 1) / 2 * this.w), Math.round((1 - this.v.y) / 2 * this.h)]
  }
  gooseAt(): [number, number] { return this.project(this.gx, this.gy + 3, this.gz) }
  gooseFeet(): [number, number] { return this.project(this.gx, 0, this.gz) }
  enemyAt(): [number, number] { return this.project(0, 5, this.enemyZ) }
  enemyTop(): [number, number] { return this.project(0, this.enemy ? this.enemy.height * this.enemyK * 1.05 : 11, this.enemyZ) }
  /** the live attacks still coming: their labels' screen spots */
  labels(t: number): { x: number; y: number; label: string; color: number; near: number }[] {
    const out: { x: number; y: number; label: string; color: number; near: number }[] = []
    for (const a of this.attacks) {
      if (!a.alive || a.resolved !== 'none' || a.g.position.z > 0) continue
      const [x, y] = this.project(a.g.position.x, a.top, a.g.position.z)
      out.push({ x, y, label: a.label, color: a.color, near: clamp01((t - a.t0) / Math.max(0.05, a.tHit - a.t0)) })
    }
    return out
  }

  destroy(): void {
    this.renderer.dispose()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose()
    })
  }
}
