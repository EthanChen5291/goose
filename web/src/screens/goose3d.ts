/**
 * The goose's world, directed.
 *
 * One small 3D meadow, rendered at game-pixel size (≈384×216, no antialiasing,
 * flat toon steps, hard shadows) and shown at a whole-number scale, so every
 * pixel on screen is a game pixel.  The goose in it is the jointed figure from
 * `goose_rig.ts`: the sprite's own proportions and colours, fully three
 * dimensional, animated by clips.
 *
 * The world plays four scenes:
 *
 *   · `menu`    the title.  The camera looks almost straight down on the
 *               meadow; the menu's buttons are flat plates floating over the
 *               grass in the blueprint's stagger (two wide ones stepping down
 *               the frame, a small one at the right), and a small goose walks
 *               on them.  It follows the pointer: on a plate it waddles to
 *               where the pointer is, across the text if that is where the
 *               pointer went; between plates it walks to the edge and hops;
 *               off every plate it stands at the nearest edge and turns its
 *               head — the head alone, eight times a second — to watch the
 *               cursor.  Pressing snaps the camera to a phone held straight in
 *               front of the bird, the beak dead centre in an ultra-wide, then
 *               the plate rockets off with the goose on it — smeared, through
 *               a trail of feathers and cloud — or, for settings, tips and
 *               spills the goose into a hole that opens in the ground.
 *   · `map`     the level select.  Round stones along the path.  The goose
 *               arrives the way it left: thrown in at speed, tumbling as a
 *               rigid thing, smeared along its flight, bouncing, skidding a
 *               streak into the grass, then getting up dizzy (ドドド) and
 *               waddling — fast, rough — to its stone.  On the stone it idles:
 *               honks at you, looks around, startles, glowers.
 *   · `abduct`  play was pressed.  The camera holds; a saucer races in over
 *               the goose, its beam lifts the bird a little, and a pair of
 *               slapstick gloves snap in and clap it flat while it is still
 *               low — when they open, it is the sprite made solid, a bit
 *               thick — and the flat goose is drawn up into the saucer.
 *   · `win`     the level was won.  The goose grows the hero's body in three
 *               snaps and strikes a JoJo stance, shot the way the manga
 *               frames them: from the ground looking up, from high behind
 *               looking down the pose, then the face — the goose's own head,
 *               scowling — with ド ド ド hanging in the air.
 */
import * as THREE from 'three'
import type { Manifest } from '../px/assets'
import { buildGoose, clips, mix, pose, REST, BODY_CENTRE, GOOSE_H } from './goose_rig'
import type { GPose, GooseRig } from './goose_rig'
import { Emotes, feathers as mkFeathers, dust as mkDust, puffs as mkPuffs } from './goose_fx'
import type { EmoteKind } from './goose_fx'
import {
  buildMeadow, driftMeadow, toonRamp, buildPlate, buildNode, buildUfo, buildHand, buildHero, applyHeroPose, POSES, buildHole, buildSkid,
  spriteVoxels, voxelMesh, menacingSprites, WORLDS, DUSK, SKY, HORIZON, pathZ, PLATE_THICK, FEET,
} from './goose_world'
import type { PoseName } from './goose_world'

export type ExitKind = 'right' | 'left' | 'trap'

export interface GooseMovie {
  el: HTMLCanvasElement
  resize: (w: number, h: number) => void
  stop: () => void
  /** a named cue — a sound or a screen flash — for the shell to act on */
  onCue: ((name: string) => void) | null
  /** the title: `count` plates over the meadow, the goose on plate `at` */
  menu: (count: number, at: number) => void
  /** the keyboard: the goose goes to plate `i` and stands by its label */
  menuHover: (i: number) => void
  /**
   * The pointer, in game pixels.  The goose follows it: onto the plate under
   * it, or to the nearest plate's edge.  Returns the plate it is headed for.
   */
  menuPointer: (x: number, y: number) => number
  /** where plate `i`'s top is on screen: x, y, w, h in game pixels */
  menuBox: (i: number) => [number, number, number, number]
  /** the press: the phone shot, then the exit; resolves once the goose is gone */
  menuPress: (i: number, kind: ExitKind) => Promise<void>
  /**
   * The world map: the camera flies up over the path and `count` stones stand
   * along it; `done[i]` plants a flag; the goose is on `selected`.  With
   * `arrive` the goose is thrown in from off-screen and walks to its stone.
   */
  map: (count: number, selected: number, done: boolean[], arrive?: boolean) => void
  /** the goose goes to stone `i` */
  gooseTo: (i: number) => void
  /** where stone `i` is on the screen, in game pixels */
  project: (i: number) => [number, number]
  /** the world's light: 0 noon · 1 dusk · 2 night · 3 storm · 4 dawn */
  setWorld: (k: number) => void
  /** the saucer, the beam, the slap; resolves as the flat goose is drawn up */
  abduct: () => Promise<void>
  /** the victory: the stance, in three cuts; `onCut(i)` fires on each; `seed` picks the stance */
  winShow: (onCut: (i: number) => void, seed: number) => Promise<void>
}

const BPM = 120
const TAU = Math.PI * 2
/** the goose on the menu: about 5 units tall on a 42-wide plate */
const MENU_SCALE = 0.21
/** the goose on the map: 2.5× smaller than it was, a little under a stone's width */
const MAP_SCALE = 0.136
/** the goose in the win show, growing into the hero */
const WIN_SCALE = 0.34
/** the hero rig is 39 goose units tall */
const HERO_SCALE = 0.3
const PLATE_Y = 14
const PLATE_TOP = PLATE_Y + PLATE_THICK
/** the blueprint's stagger: two wide plates stepping down-right, a small one at the right */
const PLATE_SPECS: { x: number; z: number; w: number; d: number }[] = [
  { x: 0, z: 0, w: 42, d: 14 },
  { x: 11, z: 16.5, w: 42, d: 14 },
  { x: 34, z: -0.8, w: 22, d: 14 },
]
const PLATE_CX = -4
const PLATE_CZ = -3
/** plates further apart than this are flown to, not hopped */
const FAR = 40
const NODE_TOP = 1.6
/** the menu camera: nearly overhead, the plates low and right of the wordmark */
const MENU_LOOK = new THREE.Vector3(PLATE_CX - 2, PLATE_Y, PLATE_CZ + 2)
const MENU_CAM = new THREE.Vector3(PLATE_CX - 2, PLATE_Y + 78, PLATE_CZ + 22)
const MENU_FOV = 42
const MAP_CAM = new THREE.Vector3(0, 38, 50)
const MAP_LOOK = new THREE.Vector3(0, 0, 5)
const UP = new THREE.Vector3(0, 1, 0)
const ONE = new THREE.Vector3(1, 1, 1)

const smooth = (u: number) => u * u * (3 - 2 * u)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp01 = (u: number) => Math.max(0, Math.min(1, u))
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const easeOut = (u: number) => 1 - (1 - u) ** 3
const easeIn = (u: number) => u * u * u
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
/** the yaw that faces direction `d` (the goose faces +x at yaw 0) */
const yawOf = (d: THREE.Vector3) => Math.atan2(-d.z, d.x)

export async function gooseMovie(manifest: Manifest): Promise<GooseMovie> {
  const vox = await spriteVoxels(manifest)
  const menacing = await menacingSprites(manifest)

  const canvas = document.createElement('canvas')
  canvas.className = 'px-movie'
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.BasicShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY)
  scene.fog = new THREE.Fog(HORIZON, 150, 300)

  const ramp = toonRamp()
  const base = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp })

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4)
  sun.position.set(40, 60, 30)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -110; sun.shadow.camera.right = 110
  sun.shadow.camera.top = 110; sun.shadow.camera.bottom = -110
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 240
  sun.shadow.bias = -0.002
  scene.add(sun, sun.target)
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x5f8f3a, 1.1)
  scene.add(hemi)

  const meadow = buildMeadow(scene, base)

  // ── the cast ──────────────────────────────────────────────────────────────
  // the flat goose: the idle frame's voxels, a third as deep — pressed, not paper
  const flatMesh = voxelMesh(vox.all, base.clone(), 32, FEET)
  flatMesh.position.set(8.5, 0, 0)
  flatMesh.scale.z = 0.36
  const rig: GooseRig = buildGoose(base, MENU_SCALE, flatMesh)
  rig.root.matrixAutoUpdate = false
  scene.add(rig.root)
  let gooseScale = MENU_SCALE
  const setScale = (s: number): void => { gooseScale = s; rig.model.scale.setScalar(s) }
  const hero = buildHero(base)
  hero.root.scale.setScalar(HERO_SCALE)
  hero.root.rotation.y = -0.35
  hero.root.visible = false
  scene.add(hero.root)
  for (const m of menacing) scene.add(m)
  const ufo = buildUfo(base)
  scene.add(ufo.g)
  const hands = [buildHand(base), buildHand(base)]
  for (const h of hands) { h.scale.setScalar(0.62); scene.add(h) }
  const hole = buildHole(base)
  scene.add(hole)
  const skid = buildSkid(base)
  scene.add(skid)
  const emotes = new Emotes(scene)
  const feathers = mkFeathers(scene)
  const dust = mkDust(scene)
  const puffs = mkPuffs(scene)
  const menuRoot = new THREE.Group()
  scene.add(menuRoot)
  const nodeRoot = new THREE.Group()
  scene.add(nodeRoot)

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.25, 500)
  const look = new THREE.Vector3()
  let camRoll = 0
  let w = 384, h = 216
  const resize = (nw: number, nh: number): void => {
    w = nw; h = nh
    renderer.setSize(w, h, false)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize(w, h)

  const t0 = performance.now()
  const now = () => (performance.now() - t0) / 1000
  let onCue: ((name: string) => void) | null = null
  const cue = (name: string): void => { onCue?.(name) }

  // ── the sky ───────────────────────────────────────────────────────────────
  const paint = (p: [number, number, number, number]): void => {
    ;(scene.background as THREE.Color).setHex(p[0])
    ;(scene.fog as THREE.Fog).color.setHex(p[1])
    hemi.color.setHex(p[2])
    sun.color.setHex(p[3])
  }
  let worldK = 0
  const setSky = (dusk: boolean): void => paint(dusk ? DUSK : WORLDS[worldK % WORLDS.length])

  // ── the camera glide: from where it is to a mark, eased ───────────────────
  const camFrom = new THREE.Vector3(), lookFrom = new THREE.Vector3(), camTo = new THREE.Vector3(), lookTo = new THREE.Vector3()
  let camT0 = -9, camDur = 0, fovFrom = 38, fovTo = 38
  const glide = (to: THREE.Vector3, at: THREE.Vector3, secs: number, fov = 38): void => {
    camFrom.copy(camera.position); lookFrom.copy(look)
    camTo.copy(to); lookTo.copy(at)
    camT0 = now(); camDur = secs
    fovFrom = camera.fov; fovTo = fov
  }
  const camStep = (t: number): number => {
    const u = camDur > 0 ? clamp01((t - camT0) / camDur) : 1
    const k = smooth(u)
    camera.position.lerpVectors(camFrom, camTo, k)
    look.lerpVectors(lookFrom, lookTo, k)
    camera.fov = lerp(fovFrom, fovTo, k)
    return u
  }
  const aim = (): void => {
    camera.updateProjectionMatrix()
    camera.up.set(Math.sin(camRoll), Math.cos(camRoll), 0)
    camera.lookAt(look)
  }

  // ── the goose's state ─────────────────────────────────────────────────────
  type Mode = 'hold' | 'menu' | 'press' | 'tomap' | 'map' | 'abduct' | 'win'
  let mode: Mode = 'hold'
  const gpos = new THREE.Vector3(0, 0, 0)
  let gyaw = -0.35
  let cur: GPose = REST
  let want: GPose = REST
  let snapPose = false
  let stride = 0
  const facing = (): THREE.Vector3 => new THREE.Vector3(Math.cos(gyaw), 0, -Math.sin(gyaw))
  const perp = (): THREE.Vector3 => new THREE.Vector3(Math.sin(gyaw), 0, Math.cos(gyaw))
  const faceToward = (d: THREE.Vector3, dt: number, rate = 12): void => {
    if (d.x * d.x + d.z * d.z < 1e-4) return
    gyaw += wrapAngle(yawOf(d) - gyaw) * Math.min(1, dt * rate)
  }
  const headPos = (): THREE.Vector3 => rig.headAt(new THREE.Vector3())
  const beakPos = (): THREE.Vector3 => rig.beakAt(new THREE.Vector3())
  /** the world size of one game pixel at `p`, for things that should keep a screen size */
  const pxAt = (p: THREE.Vector3): number => 2 * camera.position.distanceTo(p) * Math.tan(camera.fov * Math.PI / 360) / h
  /** an emoticon over the head; `lift` in goose heights */
  const emote = (kind: EmoteKind, t: number, lift = 0.34): void => {
    emotes.show(kind, headPos().add(new THREE.Vector3(0, lift * GOOSE_H * gooseScale, 0)), t, 0, Math.random() * 7)
  }
  const qy = new THREE.Quaternion()
  /** stand the figure at `gpos` facing `gyaw` */
  const standRig = (): void => {
    rig.root.matrix.compose(gpos, qy.setFromAxisAngle(UP, gyaw), ONE)
    rig.root.matrixWorldNeedsUpdate = true
  }
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mC = new THREE.Matrix4()
  const qA = new THREE.Quaternion()
  const vA = new THREE.Vector3()
  /**
   * The figure as a thrown thing: its body centre at `centre`, turned by
   * `quat`, and — on a smear frame — stretched `k`× along `dir` in world space,
   * thinned the other ways so it keeps its volume.
   */
  const placeBall = (centre: THREE.Vector3, quat: THREE.Quaternion, dir: THREE.Vector3 | null, k: number): void => {
    // root = T(centre) · Smear · R(quat) · T(−bodyCentre·scale)
    mA.makeTranslation(vA.copy(BODY_CENTRE).multiplyScalar(-gooseScale))
    mB.makeRotationFromQuaternion(quat)
    mB.multiply(mA)
    if (dir && k !== 1) {
      qA.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
      mC.makeRotationFromQuaternion(qA)
      mA.makeScale(k, 1 / Math.sqrt(k), 1 / Math.sqrt(k))
      mC.multiply(mA)
      mA.makeRotationFromQuaternion(qA.invert())
      mC.multiply(mA)
      mC.multiply(mB)
      mB.copy(mC)
    }
    mA.makeTranslation(centre)
    rig.root.matrix.multiplyMatrices(mA, mB)
    rig.root.matrixWorldNeedsUpdate = true
  }
  /** the goose smeared along its facing: `sx` long, `sy` tall (1, 1 is the plain figure) */
  const smear = (sx: number, sy: number): void => { rig.model.scale.set(gooseScale * sx, gooseScale * sy, gooseScale) }
  /**
   * A step toward `goal` at up to `speed`: the pace pulses with the stride
   * (a push at each footfall, a lull at the pass), wanders a little, and the
   * bird moves along its facing while turning, so a change of goal is an arc.
   * Returns true once it is there.
   */
  const wobble = (t: number) => 1 + 0.14 * Math.sin(t * 7.3) + 0.09 * Math.sin(t * 11.7)
  const walk = (goal: THREE.Vector3, dt: number, t: number, speed: number, turn = 11): boolean => {
    const d = goal.clone().sub(gpos).setY(0)
    const dist = d.length()
    if (dist < 0.3) return true
    // The step is taken along the heading, and the heading turns at a fixed rate,
    // so the walk has a turning circle of about speed/turn — far wider than the
    // 0.3 it must land inside.  A goal to the side therefore sat inside that
    // circle and the bird orbited it forever.  So: walk only as much as it is
    // already facing the goal (`aim`), which makes it turn on the spot first,
    // and tighten the turn as it closes, which shrinks the circle to nothing.
    const err = wrapAngle(yawOf(d) - gyaw)
    faceToward(d, dt, dist < speed * 0.2 ? turn * 2.4 : turn)
    gyaw += Math.sin(t * 9.1) * 0.012
    const aim = Math.max(0, Math.cos(err))
    const pulse = 0.5 + 0.5 * Math.pow(Math.abs(Math.sin(stride)), 0.7)
    const v = Math.min(dist / Math.max(dt, 1e-3), speed * pulse * wobble(t) * aim)
    gpos.addScaledVector(facing(), v * dt)
    stride += dt * Math.min(40, speed * 0.72) * (0.92 + 0.16 * Math.sin(t * 5.3))
    want = clips.waddle(stride)
    return false
  }

  // ── the menu: plates over the meadow ──────────────────────────────────────
  interface Plate { g: THREE.Group; pos: THREE.Vector3; w: number; d: number }
  let plates: Plate[] = []
  /** the plate the goose stands on (−1 in the air), and the one it is headed for */
  let standPlate = 0
  let goalPlate = 0
  const goal = new THREE.Vector3()
  /** where the pointer is on the plates' plane, when it is known */
  let pointer: THREE.Vector3 | null = null
  interface Air { kind: 'hop' | 'fly'; from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number }
  let air: Air | null = null
  let watchYaw = 0, watchT = -9
  const plane = new THREE.Plane(UP, -PLATE_TOP)
  const ray = new THREE.Raycaster()
  /** where the goose stands by default: right of the label, which sits at the plate's lower left */
  const standSpot = (i: number): THREE.Vector3 => plates[i].pos.clone().setY(PLATE_TOP).add(new THREE.Vector3(plates[i].w * 0.3, 0, 0.5))
  const layoutPlates = (count: number): void => {
    for (const p of plates) menuRoot.remove(p.g)
    plates = []
    for (let i = 0; i < count; i++) {
      const s = PLATE_SPECS[Math.min(i, PLATE_SPECS.length - 1)]
      const extra = i >= PLATE_SPECS.length ? (i - PLATE_SPECS.length + 1) * 17 : 0
      const g = buildPlate(s.w, s.d, base)
      const pos = new THREE.Vector3(PLATE_CX + s.x, PLATE_Y, PLATE_CZ + s.z + extra)
      g.position.copy(pos)
      menuRoot.add(g)
      plates.push({ g, pos, w: s.w, d: s.d })
    }
  }
  /** `p` clamped onto plate `i`'s top, `m` in from the edge */
  const onPlate = (i: number, p: THREE.Vector3, m: number): THREE.Vector3 => {
    const pl = plates[i]
    return new THREE.Vector3(clamp(p.x, pl.pos.x - pl.w / 2 + m, pl.pos.x + pl.w / 2 - m), PLATE_TOP, clamp(p.z, pl.pos.z - pl.d / 2 + m, pl.pos.z + pl.d / 2 - m))
  }
  const plateUnder = (p: THREE.Vector3): number => plates.findIndex((pl) => Math.abs(p.x - pl.pos.x) <= pl.w / 2 && Math.abs(p.z - pl.pos.z) <= pl.d / 2)
  const nearestPlate = (p: THREE.Vector3): number => {
    let best = 0, bd = 1e9
    plates.forEach((_pl, i) => { const d = onPlate(i, p, 0).distanceTo(p); if (d < bd) { bd = d; best = i } })
    return best
  }
  /** the point on plate `i`'s rim in the direction of `toward`, a step in from the edge */
  const rimPoint = (i: number, toward: THREE.Vector3): THREE.Vector3 => {
    const pl = plates[i]
    const c = pl.pos.clone().setY(PLATE_TOP)
    const dx = toward.x - c.x, dz = toward.z - c.z
    const m = 1.2
    const s = Math.min(Math.abs(dx) > 1e-3 ? (pl.w / 2 - m) / Math.abs(dx) : 1e9, Math.abs(dz) > 1e-3 ? (pl.d / 2 - m) / Math.abs(dz) : 1e9)
    return new THREE.Vector3(c.x + dx * s, PLATE_TOP, c.z + dz * s)
  }
  const MENU_SPEED = 21
  const tickMenu = (t: number, dt: number, beat: number): void => {
    let standing = false
    if (air) {
      const u = clamp01((t - air.t0) / air.dur)
      gpos.lerpVectors(air.from, air.to, u)
      const gap = air.from.distanceTo(air.to)
      if (air.kind === 'hop') {
        gpos.y += Math.sin(u * Math.PI) * (1.6 + gap * 0.12)
        want = clips.hop(u, t)
        if (Math.random() < dt * 2) feathers.spawn(gpos.clone().add(new THREE.Vector3(0, 1, 0)), 1, t, new THREE.Vector3(0, 0.5, 0), 1.5)
      } else {
        gpos.y += Math.sin(u * Math.PI) * 6
        want = clips.fly(t)
        if (Math.random() < dt * 6) feathers.spawn(gpos.clone().add(new THREE.Vector3(0, 1, 0)), 1, t, new THREE.Vector3(0, 0, 0), 2)
      }
      faceToward(air.to.clone().sub(air.from), dt, 14)
      if (u >= 1) {
        gpos.copy(air.to)
        standPlate = goalPlate
        air = null
        cue('land')
        dust.spawn(gpos, 2, t, new THREE.Vector3(0, 1, 0), 2)
        snapPose = true
        cur = clips.crouch()
      }
    } else if (goalPlate !== standPlate) {
      // to the edge nearest the goal, then over
      const rim = rimPoint(standPlate, goal)
      if (gpos.distanceTo(rim) < 0.6 || walk(rim, dt, t, MENU_SPEED)) {
        const to = rimPoint(goalPlate, gpos)
        const gap = gpos.distanceTo(to)
        air = { kind: gap > FAR ? 'fly' : 'hop', from: gpos.clone(), to, t0: t, dur: gap > FAR ? 0.4 + gap / 70 : 0.26 + gap / 40 }
        standPlate = -1
        cue(air.kind === 'fly' ? 'whoosh' : 'jump')
        if (Math.random() < 0.15) emote('quest', t)
      }
    } else if (walk(goal, dt, t, MENU_SPEED)) {
      standing = true
      want = clips.idle(t, beat)
    }
    // the head follows the pointer while the bird stands: sampled eight times a second, snapped
    if (standing && pointer) {
      if (t - watchT >= 1 / 8) {
        watchT = t
        const d = pointer.clone().sub(gpos)
        watchYaw = clamp(wrapAngle(yawOf(d) - gyaw), -1.35, 1.35)
        // a bird's eyes are on the sides: it offers the cursor one eye, and cranes a little toward it
        watchYaw += Math.sign(watchYaw || 1) * 0.15
      }
      want = { ...want, headYaw: watchYaw, neck: want.neck + Math.abs(watchYaw) * 0.12 }
    }
    standRig()
  }

  // ── the press: the phone shot, then the exit ──────────────────────────────
  interface Press {
    kind: ExitKind; plate: number; t0: number; resolve: () => void; done: boolean
    cam0: THREE.Vector3; look0: THREE.Vector3; fov0: number
    selfieCam: THREE.Vector3; selfieLook: THREE.Vector3
    flashed: boolean; started: boolean; lastBang: number
    // the trapdoor
    slide: THREE.Vector3; vel: THREE.Vector3; off: boolean; inHole: number; holeAt: THREE.Vector3
  }
  let press: Press | null = null
  const SELFIE_IN = 0.3
  const SELFIE_HOLD = 0.95
  const tickPress = (t: number, dt: number, beat: number): void => {
    const p = press!
    const age = t - p.t0
    const f = facing()
    if (age < SELFIE_IN + SELFIE_HOLD) {
      // the phone: straight in front of the face, a little above, tilted down — the beak in the middle, very wide
      want = clips.idle(t, beat)
      const gs = gooseScale / MENU_SCALE
      // The 0.5 lens: down at the bird's own height and close in, so the body
      // swells into the bottom of the frame and the head rides small and centred
      // above it — a phone lying on the grass, stared straight down the barrel of.
      // Anchored off the beak tip rather than the skull: the beak reaches most of
      // a goose further forward, and a lens measured from the skull sits behind it.
      const bk = beakPos()
      const bc = BODY_CENTRE.y * gooseScale
      p.selfieCam.copy(bk).addScaledVector(f, 0.55 * gs)
      p.selfieCam.y = gpos.y + bc * 1.05
      // framed on the body, not the face: the mass fills the bottom of the frame
      // and the head rides small in the top third, the beak down the lens
      p.selfieLook.set(bk.x, gpos.y + bc * 1.5, bk.z)
      const k = easeOut(clamp01(age / SELFIE_IN))
      camera.position.lerpVectors(p.cam0, p.selfieCam, k)
      look.lerpVectors(p.look0, p.selfieLook, k)
      camera.fov = lerp(p.fov0, 112, k)
      if (age >= SELFIE_IN) {
        // a hand-held shake
        camera.position.x += Math.sin(t * 7) * 0.02
        camera.position.y += Math.cos(t * 5.3) * 0.015
        if (!p.flashed) { p.flashed = true; cue('flash') }
      }
      standRig()
      return
    }
    const e = age - SELFIE_IN - SELFIE_HOLD
    const plate = plates[p.plate]
    const base0 = gpos.clone()
    if (!p.started) { p.started = true; p.slide.copy(gpos).sub(plate.pos); cue(p.kind === 'trap' ? 'trap' : 'crash_zoom') }
    if (p.kind === 'right' || p.kind === 'left') {
      const dir = p.kind === 'right' ? 1 : -1
      const dist = 30 * e + 1300 * e * e
      const dd = 30 * dt + 2600 * e * dt
      // the plate is the thing doing the racing, not a thing being thrown: it stays
      // dead flat and simply leaves, shuddering on its axis as it goes
      plate.g.position.set(plate.pos.x + dir * dist, plate.pos.y + Math.sin(e * 18) * 0.4, plate.pos.z)
      plate.g.rotation.set(0, 0, 0)
      gpos.x += dir * dd
      gpos.y = PLATE_TOP + 0.3 + Math.abs(Math.sin(e * 24)) * 0.5
      faceToward(new THREE.Vector3(dir, 0, 0), dt, 30)
      // drawn, not tweened: the pose steps on twos and the cycle is four drawings —
      // a squash as it takes the hit, a long smear, a half smear, then a held frame
      const drawT = Math.floor(t * 12) / 12
      want = clips.panic(drawT)
      cur = want
      snapPose = true
      const fr = Math.floor(e * 12) % 4
      smear([0.74, 3.2, 1.7, 1][fr], [1.22, 0.5, 0.77, 1][fr])
      if (t - p.lastBang > 0.2) { p.lastBang = t; emote(Math.random() < 0.7 ? 'bang' : 'quest', t, 0.5) }
      // a continuous trail: feathers every frame, cloud behind
      feathers.spawn(gpos.clone().add(new THREE.Vector3(-dir * 1.5, 1.2, 0)), 2, t, new THREE.Vector3(-dir * 14, 3, 0), 6)
      if (e < 0.5) puffs.spawn(gpos.clone().add(new THREE.Vector3(-dir * 3, 0.6, 0)), 2, t, new THREE.Vector3(-dir * 2, 1.2, 0), 3)
      // the camera stays where the phone was, pulls up a little, and pans after the goose
      const k = easeOut(clamp01(e / 0.45))
      camera.position.copy(p.selfieCam).addScaledVector(f, -2.5 * k).add(new THREE.Vector3(0, 6 * k, 3 * k))
      look.copy(gpos).add(new THREE.Vector3(0, 1.5, 0))
      camera.fov = lerp(100, 66, k)
      if (!p.done && e >= 0.55) { p.done = true; p.resolve() }
    } else {
      // the trapdoor: the plate tips — its near edge going down — the goose scrabbles up the slope,
      // loses it, slides off the edge and drops into a hole that opens in the grass beneath
      const tilt = Math.min(1.15, (e / 0.42) ** 2 * 1.15)
      plate.g.rotation.x = tilt
      const sinT = Math.sin(tilt), cosT = Math.cos(tilt)
      if (!p.off) {
        if (tilt > 0.22) {
          p.vel.z += (55 * sinT - 8) * dt
          p.slide.z += p.vel.z * dt
        }
        gpos.set(plate.pos.x + p.slide.x, plate.pos.y + PLATE_THICK * cosT - p.slide.z * sinT, plate.pos.z + PLATE_THICK * sinT + p.slide.z * cosT)
        faceToward(new THREE.Vector3(0, 0, -1), dt, 8)
        want = tilt > 0.22 ? { ...clips.scramble(t), pitch: clips.scramble(t).pitch + tilt * 0.8 } : clips.idle(t, beat)
        if (tilt > 0.22 && Math.random() < dt * 8) feathers.spawn(gpos.clone().add(new THREE.Vector3(0, 1, 0)), 1, t, new THREE.Vector3(0, 1.5, 0), 2)
        if (p.slide.z > plate.d / 2 + 0.8) {
          p.off = true
          // over the edge: carry the slide's speed, and open the hole where the bird will land
          p.vel.set(0, -p.vel.z * sinT, p.vel.z * cosT)
          const y0 = gpos.y - 0.6
          const g = 95
          const tf = (p.vel.y + Math.sqrt(p.vel.y * p.vel.y + 2 * g * y0)) / g
          p.holeAt.set(gpos.x, 0, gpos.z + p.vel.z * tf)
          hole.position.copy(p.holeAt)
          hole.visible = true
          hole.scale.setScalar(0.01)
          emote('bang', t)
          cue('jump')
        }
      } else if (p.inHole < 0) {
        p.vel.y -= 95 * dt
        gpos.addScaledVector(p.vel, dt)
        want = clips.panic(t)
        hole.scale.setScalar(Math.min(1, hole.scale.x + dt / 0.12))
        if (Math.random() < dt * 10) feathers.spawn(gpos.clone().add(new THREE.Vector3(0, 1, 0)), 1, t, new THREE.Vector3(0, 2, 0), 3)
        if (gpos.y <= 0.6) {
          p.inHole = t
          gpos.x = p.holeAt.x; gpos.z = p.holeAt.z
          cue('whoosh')
          dust.spawn(p.holeAt.clone().setY(0.5), 8, t, new THREE.Vector3(0, 3, 0), 6)
          feathers.spawn(p.holeAt.clone().setY(1), 6, t, new THREE.Vector3(0, 6, 0), 5)
        }
      } else {
        // down the hole: legs running on nothing
        gpos.y -= 26 * dt
        want = clips.hang(t)
        if (gpos.y < -7) {
          hole.scale.setScalar(Math.max(0.01, hole.scale.x - dt / 0.15))
          if (hole.scale.x <= 0.02) { hole.visible = false; if (!p.done) { p.done = true; p.resolve() } }
        }
      }
      const k = easeOut(clamp01(e / 0.5))
      camera.position.copy(p.selfieCam).add(new THREE.Vector3(0, 11 * k, 9 * k)).addScaledVector(f, -3 * k)
      const at = p.inHole >= 0 ? p.holeAt.clone().setY(1) : gpos.clone().add(new THREE.Vector3(0, 1.5, 0))
      look.lerp(at, Math.min(1, dt * 10))
      camera.fov = lerp(100, 70, k)
    }
    void base0
    standRig()
  }

  // ── the map: stones along the path, the goose thrown in ───────────────────
  let nodes: THREE.Group[] = []
  let nodeSel = 0
  const nodePos = (i: number, n = nodes.length): THREE.Vector3 => {
    n = Math.max(1, n)
    const x = n <= 1 ? 0 : -27 + (54 * i) / (n - 1)
    return new THREE.Vector3(x, 0, pathZ(x))
  }
  const nodeTop = (i: number): THREE.Vector3 => nodePos(i).setY(NODE_TOP)
  const buildNodes = (count: number, done: boolean[]): void => {
    for (const n of nodes) nodeRoot.remove(n)
    nodes = []
    for (let i = 0; i < count; i++) {
      const g = buildNode(!!done[i], base)
      nodes.push(g)
      nodeRoot.add(g)
      g.position.copy(nodePos(i, count))
    }
  }
  type ArrPhase = 'idle' | 'ball' | 'getup' | 'rush' | 'hop'
  interface Arrival {
    phase: ArrPhase
    // the ball
    pos: THREE.Vector3; vel: THREE.Vector3; quat: THREE.Quaternion; ang: THREE.Vector3; lastDir: THREE.Vector3; bounces: number
    skidFrom: THREE.Vector3 | null
    // getting up
    t0: number; fromQuat: THREE.Quaternion; yawTarget: number
    // the walk and the hop
    from: THREE.Vector3; to: THREE.Vector3; dur: number; stepT: number
  }
  const arr: Arrival = {
    phase: 'idle', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), ang: new THREE.Vector3(),
    lastDir: new THREE.Vector3(1, 0, 0), bounces: 0, skidFrom: null, t0: 0, fromQuat: new THREE.Quaternion(), yawTarget: 0,
    from: new THREE.Vector3(), to: new THREE.Vector3(), dur: 1, stepT: 0,
  }
  const ballR = (): number => BODY_CENTRE.y * gooseScale
  const GRAV = 70
  const MAP_SPEED = 60
  /** the ball's bounce: what it keeps of its lift, of its run, of its spin; and how hard the grass slows the roll */
  const BOUNCE_UP = 0.36, BOUNCE_RUN = 0.42, BOUNCE_SPIN = 0.75, ROLL_DRAG = 32
  /** the roll is over below this: the solver and the live roll must agree on it */
  const ROLL_STOP = 1.2
  /** the beat it lies there, dizzy, before it picks itself up */
  const GETUP_REST = 0.6
  /** how far the ball travels after it first hits, arriving at `run` along the ground and `fall` downward */
  const rollDistance = (run: number, fall: number): number => {
    let x = 0, y = ballR(), vx = run, vy = fall
    let first = true
    for (let i = 0; i < 2400; i++) {
      const dt = 1 / 240
      vy -= GRAV * dt
      x += vx * dt; y += vy * dt
      if (y <= ballR()) {
        y = ballR()
        if (vy < -6 || first) { vy = Math.abs(vy) * BOUNCE_UP; vx *= BOUNCE_RUN; first = false }
        else { vy = 0; vx = Math.max(0, vx - ROLL_DRAG * dt); if (vx < ROLL_STOP) break }
      }
    }
    return x
  }
  const startArrival = (target: number, t: number): void => {
    const tp = nodePos(target)
    const th = Math.random() * TAU
    const dir = new THREE.Vector3(Math.cos(th), 0, Math.sin(th))
    // it comes to rest above the line of stones — further from the camera — so it has a walk ahead of it
    // pulled back toward the middle of the path (the stones run x -27..27) so the
    // roll finishes on screen instead of out past the first or the last stone
    const rest = new THREE.Vector3(tp.x * 0.55 + (Math.random() - 0.5) * 10, 0, tp.z - (4.5 + Math.random() * 4))
    const speed = 150
    const drop = 16 + Math.random() * 12
    const reach = 150
    const tf = reach / speed
    const vy0 = (ballR() - drop + 0.5 * GRAV * tf * tf) / tf
    const fall = vy0 - GRAV * tf
    // where it must first hit for the bounces and the skid to end at `rest`
    const landing = rest.clone().addScaledVector(dir, -rollDistance(speed, fall))
    const entry = landing.clone().addScaledVector(dir, -reach).setY(drop)
    arr.pos.copy(entry)
    arr.vel.copy(dir).multiplyScalar(speed)
    arr.vel.y = vy0
    arr.ang.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(22 + Math.random() * 12)
    arr.quat.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6))
    arr.lastDir.copy(dir)
    arr.bounces = 0
    arr.skidFrom = null
    skid.visible = false
    arr.phase = 'ball'
    arr.t0 = t
    cue('throw_far')
  }
  const startRush = (target: number, t: number): void => {
    arr.from.copy(gpos)
    arr.to.copy(nodePos(target))
    arr.t0 = t
    arr.stepT = t
    arr.phase = 'rush'
  }
  const dq = new THREE.Quaternion()
  const tickBall = (t: number, dt: number): void => {
    arr.vel.y -= GRAV * dt
    arr.pos.addScaledVector(arr.vel, dt)
    const rate = arr.ang.length()
    if (rate > 1e-4) {
      dq.setFromAxisAngle(arr.ang.clone().normalize(), rate * dt)
      arr.quat.premultiply(dq)
    }
    const sp = arr.vel.length()
    if (Math.random() < dt * (sp > 40 ? 24 : 8)) feathers.spawn(arr.pos, 1, t, new THREE.Vector3(0, 2, 0).addScaledVector(arr.vel, -0.12), 5)
    if (arr.pos.y <= ballR()) {
      arr.pos.y = ballR()
      if (arr.vel.y < -6 || arr.bounces === 0) {
        arr.vel.y = Math.abs(arr.vel.y) * BOUNCE_UP
        arr.vel.x *= BOUNCE_RUN; arr.vel.z *= BOUNCE_RUN
        arr.ang.multiplyScalar(BOUNCE_SPIN)
        arr.bounces += 1
        cue('thud')
        dust.spawn(new THREE.Vector3(arr.pos.x, 0.4, arr.pos.z), 7, t, new THREE.Vector3(0, 3, 0), 6)
        feathers.spawn(arr.pos, 4, t, new THREE.Vector3(0, 5, 0), 6)
        if (!arr.skidFrom) { arr.skidFrom = arr.pos.clone().setY(0); skid.visible = true }
      } else {
        // on the ground: rolling, and slowing — and the grass under it flattened into a streak
        arr.vel.y = 0
        const hs = Math.hypot(arr.vel.x, arr.vel.z)
        const ns = Math.max(0, hs - ROLL_DRAG * dt)
        if (hs > 1e-3) { arr.vel.x *= ns / hs; arr.vel.z *= ns / hs }
        if (ns > 0.5) arr.lastDir.set(arr.vel.x, 0, arr.vel.z).normalize()
        arr.ang.copy(UP).cross(arr.vel).divideScalar(ballR())
        if (!arr.skidFrom) { arr.skidFrom = arr.pos.clone().setY(0); skid.visible = true }
        if (ns < ROLL_STOP) {
          arr.phase = 'getup'
          arr.t0 = t
          arr.fromQuat.copy(arr.quat)
          arr.yawTarget = yawOf(arr.lastDir)
          const hp = arr.pos.clone().add(new THREE.Vector3(0, GOOSE_H * gooseScale * 0.8, 0))
          for (let k = 0; k < 3; k++) emotes.show('star', hp, t, 1.6, k * 2.1)
          cue('menace')
        }
      }
    }
    if (arr.skidFrom) {
      const a = arr.skidFrom, b = arr.pos
      const dx = b.x - a.x, dz = b.z - a.z
      const len = Math.max(0.5, Math.hypot(dx, dz))
      skid.position.set((a.x + b.x) / 2, 0.08, (a.z + b.z) / 2)
      skid.scale.set(len, 1, 1)
      skid.rotation.y = -Math.atan2(dz, dx)
    }
    // smear frames while it flies fast: two frames in three drawn long along the flight
    const fr = Math.floor(t * 15) % 3
    const k = sp > 40 ? (fr === 1 ? 2.3 : fr === 2 ? 1.5 : 1) : 1
    placeBall(arr.pos, arr.quat, k !== 1 ? arr.vel.clone().normalize() : null, k)
    want = clips.stiff()
  }
  const tickGetup = (t: number): void => {
    const u = clamp01((t - arr.t0 - GETUP_REST) / 0.45)
    const target = new THREE.Quaternion().setFromAxisAngle(UP, arr.yawTarget)
    arr.quat.copy(arr.fromQuat).slerp(target, smooth(u))
    arr.pos.y = ballR()
    placeBall(arr.pos, arr.quat, null, 1)
    want = clips.dizzy(t)
    if (u >= 1) {
      gyaw = arr.yawTarget
      gpos.copy(arr.pos).setY(0)
      startRush(nodeSel, t)
    }
  }
  const tickRush = (t: number, dt: number): void => {
    if (t - arr.stepT > 0.11) { arr.stepT = t; cue('run_steps') }
    if (walk(arr.to, dt, t, MAP_SPEED, 14)) {
      arr.from.copy(gpos)
      arr.to.copy(nodeTop(nodeSel))
      arr.t0 = t
      arr.dur = 0.22
      arr.phase = 'hop'
      cue('jump')
    }
    standRig()
  }
  const tickHop = (t: number): void => {
    const u = clamp01((t - arr.t0) / arr.dur)
    gpos.lerpVectors(arr.from, arr.to, u)
    gpos.y += Math.sin(u * Math.PI) * 1.4
    want = pose({ wing: 0.55, legs: [0.5, -0.5], eye: 1.2, neck: -0.2, head: 0.3 })
    if (u >= 1) {
      arr.phase = 'idle'
      cue('land')
      dust.spawn(gpos.clone().setY(NODE_TOP), 3, t, new THREE.Vector3(0, 1.5, 0), 3)
      nextAct = t + 1.6 + Math.random() * 2.5
      snapPose = true
      cur = clips.crouch()
    }
    standRig()
  }
  // idling on the stone: an act every few seconds
  type ActKind = 'quack' | 'wonder' | 'alert' | 'grr'
  interface Act { kind: ActKind; t0: number; dur: number; fired: number }
  let act: Act | null = null
  let nextAct = 0
  const startAct = (t: number): void => {
    const r = Math.random()
    const kind: ActKind = r < 0.3 ? 'quack' : r < 0.55 ? 'wonder' : r < 0.75 ? 'alert' : 'grr'
    act = { kind, t0: t, dur: kind === 'quack' ? 1.2 : kind === 'wonder' ? 1.4 : kind === 'alert' ? 0.8 : 1.6, fired: 0 }
    if (kind === 'quack') cue('honk')
    if (kind === 'alert') { cue('jump'); emote('bang', t) }
    if (kind === 'wonder') faceToward(new THREE.Vector3(0, 0, 1), 1, 1)
  }
  const tickIdleOnStone = (t: number, beat: number): void => {
    if (!act && t > nextAct) startAct(t)
    gpos.copy(nodeTop(nodeSel))
    if (act) {
      const u = (t - act.t0) / act.dur
      if (act.kind === 'quack') {
        want = clips.quack(u)
        const marks = [0.1, 0.43, 0.76]
        if (act.fired < marks.length && u >= marks[act.fired]) { act.fired += 1; emote('note', t, 0.25) }
      } else if (act.kind === 'wonder') {
        want = clips.wonder(u)
        if (act.fired === 0 && u >= 0.25) { act.fired = 1; emote('quest', t) }
      } else if (act.kind === 'alert') {
        gpos.y += Math.sin(clamp01(u / 0.5) * Math.PI) * 1.2
        want = pose({ wing: 0.75, eye: 1.6, neck: 0.3, head: 0.4, legs: [0.5, -0.5], beak: 0.4 })
      } else {
        want = clips.grr(t)
        if (act.fired === 0 && u >= 0.1) { act.fired = 1; emote('grr', t, 0.28) }
        else if (act.fired === 1 && u >= 0.6) { act.fired = 2; emote('grr', t, 0.28) }
      }
      if (u >= 1) { act = null; nextAct = t + 2.5 + Math.random() * 3.5 }
    } else {
      want = clips.idle(t, beat)
    }
    standRig()
  }

  // ── the abduction ─────────────────────────────────────────────────────────
  interface Abduct {
    t0: number; resolve: () => void; done: boolean
    base: THREE.Vector3; f: THREE.Vector3; p: THREE.Vector3; ufoFrom: THREE.Vector3
    contact: boolean; fired: number
  }
  let abd: Abduct | null = null
  const tickAbduct = (t: number, dt: number): void => {
    const a = abd!
    const age = t - a.t0
    const gh = GOOSE_H * gooseScale
    const target = a.base.clone().add(new THREE.Vector3(0, 12.5, 0))
    // the saucer
    ufo.g.visible = true
    if (age < 0.3) ufo.g.position.lerpVectors(a.ufoFrom, target, easeOut(age / 0.3))
    else if (age < 1.35) ufo.g.position.copy(target).add(new THREE.Vector3(0, Math.sin(t * 3) * 0.4, 0))
    ufo.g.rotation.y += dt * 0.9
    ufo.ring.rotation.y -= dt * 4.5
    ufo.lights.forEach((l, k) => { l.visible = (Math.floor(t * 10) + k) % 3 !== 0 })
    ufo.beam.visible = age >= 0.3 && age < 1.35
    ;(ufo.beam.material as THREE.MeshBasicMaterial).opacity = 0.28 + (Math.floor(t * 14) % 2) * 0.16
    ;(ufo.emitter.material as THREE.MeshBasicMaterial).color.setHex(Math.floor(t * 14) % 2 ? 0x8fe3ff : 0xffffff)
    ufo.beam.rotation.y = -ufo.g.rotation.y
    const mid = (): THREE.Vector3 => gpos.clone().add(new THREE.Vector3(0, gh * 0.45, 0))
    const placeHands = (dz: number, show: boolean, stretch = 1): void => {
      hands.forEach((hd, i) => {
        const s = i === 0 ? -1 : 1
        hd.visible = show
        hd.position.copy(mid()).addScaledVector(a.p, s * dz)
        hd.rotation.set(0, gyaw + (s > 0 ? 0 : Math.PI), 0)
        hd.scale.set(0.62, 0.62, 0.62 * stretch)
      })
    }
    const SLAP = 0.7
    if (age < 0.3) {
      gpos.copy(a.base)
      want = pose({ eye: 1.6, neck: 0.3, head: 0.6, wing: 0.2 })
      if (a.fired === 0 && age > 0.12) { a.fired = 1; emote('bang', t) }
      placeHands(24, false)
    } else if (age < 0.62) {
      if (a.fired === 1) { a.fired = 2; cue('beam') }
      const u = (age - 0.3) / 0.45
      gpos.copy(a.base).add(new THREE.Vector3(0, smooth(clamp01(u)) * gh * 0.7, 0))
      gyaw += dt * 2.2
      want = clips.dangle(t)
      if (a.fired === 2 && age > 0.45) { a.fired = 3; emote('quest', t) }
      placeHands(24, false)
    } else if (age < SLAP) {
      // the gloves snap in from either side, smeared along the way
      if (a.fired === 3) { a.fired = 4; cue('whoosh') }
      const k = easeIn((age - 0.62) / (SLAP - 0.62))
      placeHands(26 - k * (26 - 1.5), true, 3.2 - k * 2.2)
      want = clips.dangle(t)
    } else if (age < SLAP + 0.1) {
      if (!a.contact) {
        a.contact = true
        cue('slap')
        cue('splat')
        feathers.spawn(mid(), 18, t, new THREE.Vector3(0, 4, 0), 12)
        rig.setFlat(true)
      }
      placeHands(1.2, true)
      rig.flat.scale.set(1.25, 0.8, 1)
    } else if (age < SLAP + 0.3) {
      const k = easeOut((age - SLAP - 0.1) / 0.2)
      placeHands(1.2 + k * 26, true, 1 + k * 1.8)
      rig.flat.scale.set(lerp(1.25, 1, k), lerp(0.8, 1, k), 1)
      rig.model.rotation.z = Math.sin(t * 12) * 0.12
      if (a.fired === 4) { a.fired = 5; const hp = mid().add(new THREE.Vector3(0, gh * 0.6, 0)); for (let k2 = 0; k2 < 3; k2++) emotes.show('star', hp, t, 1.5, k2 * 2.1) }
    } else if (age < 1.35) {
      placeHands(24, false)
      const u = (age - SLAP - 0.3) / (1.35 - SLAP - 0.3)
      gpos.copy(a.base).add(new THREE.Vector3(0, gh * 0.7 + easeIn(clamp01(u)) * 17, 0))
      gyaw += dt * 16
      rig.model.rotation.z = 0
      if (a.fired === 5) { a.fired = 6; cue('whoosh') }
    } else {
      rig.root.visible = false
      const e = age - 1.35
      if (a.fired === 6) { a.fired = 7; cue('crash_zoom') }
      ufo.g.position.copy(target).add(new THREE.Vector3(30 * e + 900 * e * e, 14 * e, 0))
      if (!a.done && e >= 0.18) { a.done = true; a.resolve() }
    }
    standRig()
  }

  // ── the win show: the stance, in the manga's cuts ─────────────────────────
  let winCut = (_i: number) => {}
  let winCutsDone = -1
  let modeT0 = 0
  let winPose: PoseName = 'rohan'
  const heroHead = new THREE.Vector3()
  const heroElbow = new THREE.Vector3()
  const heroShoulder = new THREE.Vector3()
  const heroAbs = new THREE.Vector3()
  const heroChest = new THREE.Vector3()
  const heroArm = new THREE.Vector3()
  const heroOut = new THREE.Vector3()
  const tickWin = (t: number, beat: number): void => {
    const age = t - modeT0
    // the body: the bird drops away in three steps and the hero grows in three — a third of a second, unremarked
    if (age < 0.3) {
      const s = age < 0.1 ? 1 : age < 0.2 ? 0.5 : 0.15
      rig.model.scale.set(WIN_SCALE, WIN_SCALE * s, WIN_SCALE)
      rig.root.visible = age < 0.24
      hero.root.visible = age >= 0.1
      hero.root.scale.setScalar(HERO_SCALE * (age < 0.2 ? 0.45 : 0.8))
      applyHeroPose(hero, {})
      hero.head.apply({ head: 0, headYaw: 0, beak: 0, eye: 1, brows: 0 })
      want = clips.idle(t, beat)
    } else {
      rig.root.visible = false
      hero.root.visible = true
      hero.root.scale.setScalar(HERO_SCALE)
      // into the stance in three snaps over a sixth of a second, then held; the face sets with it
      const k = age < 0.36 ? 0.35 : age < 0.42 ? 0.7 : 1
      applyHeroPose(hero, POSES[winPose], k)
      const blink = ((age + 0.9) % 2.7) < 0.09
      hero.head.apply({ head: 0.05, headYaw: k === 1 ? -0.25 : 0, beak: k === 1 ? 0.12 : 0, eye: blink ? 0.1 : k === 1 ? 0.6 : 1.2, brows: k === 1 ? 1 : 0 })
      // a breath: the chest lifts a hair on the beat while held
      hero.root.position.y = (POSES[winPose].lift ?? 0) + (beat < 0.5 ? 0.12 : 0)
      if (k === 1 && winCutsDone < 0) { cue('menace') }
    }
    // ド ド ド around the hero once the stance lands: drifting up a step at a time
    for (const m of menacing) {
      m.visible = age > 0.42
      const b = m.userData.base as [number, number, number]
      const ph = m.userData.phase as number
      const step = Math.floor((age + ph) * 6)
      m.position.set(b[0] * 0.9 + ((step % 3) - 1) * 0.3, b[1] * 0.75 + Math.floor(age * 2) * 0.5 - 1 + (step % 2) * 0.25, b[2] * 0.9)
      m.lookAt(camera.position)
    }
    // the cuts: from the ground looking up · from high behind, down the pose · the face
    hero.head.g.getWorldPosition(heroHead)
    const cuts = [0, 1.5, 3.0]
    let i = 0
    while (i + 1 < cuts.length && age >= cuts[i + 1]) i += 1
    const u = Math.min(1, (age - cuts[i]) / ((cuts[i + 1] ?? 5.1) - cuts[i]))
    if (i !== winCutsDone) { winCutsDone = i; winCut(i) }
    const hf = new THREE.Vector3(Math.cos(hero.root.rotation.y), 0, -Math.sin(hero.root.rotation.y))
    const hs = new THREE.Vector3(Math.sin(hero.root.rotation.y), 0, Math.cos(hero.root.rotation.y))
    if (i === 0) {
      // the body, close enough to touch: a slow climb up the front, the abs and
      // then the pec line passing the lens — the muscle is the establishing shot
      hero.spine.localToWorld(heroAbs.set(7.2, 2.6, 0))
      hero.spine.localToWorld(heroChest.set(7.2, 11.8, 0))
      look.lerpVectors(heroAbs, heroChest, smooth(u))
      camera.position.copy(look)
        .addScaledVector(hf, lerp(7.8, 6.8, u))
        .addScaledVector(hs, lerp(4.9, 4.0, u))
        .add(new THREE.Vector3(0, lerp(-0.7, 0.5, u), 0))
      camRoll = 0.12
      camera.fov = 34
    } else if (i === 1) {
      // the flexed arm, from the side, panning up the bicep to the shoulder
      // framed from outside the arm, whichever way the stance threw it, so the
      // lens never ends up inside the shoulder
      hero.elbow[1].getWorldPosition(heroElbow)
      hero.shoulder[1].getWorldPosition(heroShoulder)
      hero.spine.getWorldPosition(heroChest)
      heroArm.copy(heroShoulder).lerp(heroElbow, 0.5)
      heroOut.copy(heroArm).sub(heroChest)
      heroOut.y = 0
      if (heroOut.lengthSq() < 1e-4) heroOut.copy(hs)
      heroOut.normalize()
      camera.position.copy(heroArm)
        .addScaledVector(heroOut, lerp(6.6, 5.8, u))
        .addScaledVector(hf, 3.4)
        .add(new THREE.Vector3(0, lerp(-1.2, 0.9, u), 0))
      look.lerpVectors(heroElbow, heroShoulder, smooth(u)).add(new THREE.Vector3(0, 0.2, 0))
      camRoll = -0.1
      camera.fov = 34
    } else {
      // the face: three-quarter front, pushing in — a small head now, so close in
      camera.position.copy(heroHead).add(new THREE.Vector3(0, 0.35, 0)).addScaledVector(hf, lerp(3.8, 3.1, u)).addScaledVector(hs, lerp(3.0, 2.4, u))
      look.copy(heroHead).addScaledVector(hf, 0.5).add(new THREE.Vector3(0, -0.05, 0))
      camRoll = 0.07
      camera.fov = 36
    }
  }

  // ── the frame ─────────────────────────────────────────────────────────────
  let raf = 0
  let lastT = now()
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const t = now()
    const dt = Math.min(0.05, Math.max(0.001, t - lastT))
    lastT = t
    const beat = (t * (BPM / 60)) % 1

    if (mode === 'menu') {
      camStep(t)
      camera.position.x += Math.sin(t * 0.3) * 0.5
      camera.position.z += Math.cos(t * 0.23) * 0.3
      tickMenu(t, dt, beat)
      plates.forEach((p, i) => { p.g.position.y = p.pos.y + (i === goalPlate ? 0.4 : 0) })
    } else if (mode === 'press') {
      tickPress(t, dt, beat)
    } else if (mode === 'tomap' || mode === 'map') {
      const u = camStep(t)
      if (mode === 'map') camera.position.x += Math.sin(t * 0.25) * 1.5
      if (u >= 1 && mode === 'tomap') mode = 'map'
      if (arr.phase === 'ball') tickBall(t, dt)
      else if (arr.phase === 'getup') tickGetup(t)
      else if (arr.phase === 'rush') tickRush(t, dt)
      else if (arr.phase === 'hop') tickHop(t)
      else tickIdleOnStone(t, beat)
      nodes.forEach((n, i) => {
        const top = n.userData.top as THREE.Mesh
        top.position.y = i === nodeSel && beat < 0.5 ? 1.6 : 1.3
      })
    } else if (mode === 'abduct') {
      tickAbduct(t, dt)
    } else if (mode === 'win') {
      tickWin(t, beat)
    }

    // the pose: eased toward what the mode wants, unless a snap was asked for
    if (snapPose) { snapPose = false }
    else cur = mix(cur, want, 1 - Math.exp(-dt * 16))
    rig.apply(cur)
    const px = pxAt(gpos)
    rig.setOutline(Math.max(0.08, Math.min(1.6, px * 1.15 / gooseScale)))
    if (hero.root.visible) hero.setOutline(Math.max(0.08, Math.min(1.6, pxAt(hero.root.position) * 1.1 / HERO_SCALE)))

    nodeRoot.visible = mode === 'map' || mode === 'tomap' || mode === 'abduct'
    skid.visible = skid.visible && nodeRoot.visible
    menuRoot.visible = mode === 'menu' || mode === 'press'
    hole.visible = hole.visible && mode === 'press'
    meadow.fence.visible = mode !== 'win'
    for (const c of meadow.clouds) c.visible = mode !== 'menu'
    driftMeadow(meadow, t)
    emotes.update(t, camera, pxAt)
    feathers.update(t, dt)
    dust.update(t, dt)
    puffs.update(t, dt)
    aim()
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(tick)

  /** everything off the set but the goose */
  const clearSet = (): void => {
    hero.root.visible = false
    ufo.g.visible = false
    ufo.beam.visible = false
    for (const hd of hands) hd.visible = false
    for (const m of menacing) m.visible = false
    hole.visible = false
    emotes.clear()
    puffs.clear()
    rig.root.visible = true
    rig.setFlat(false)
    rig.flat.scale.set(1, 1, 1)
    rig.model.rotation.set(0, 0, 0)
    rig.model.scale.setScalar(gooseScale)
    camRoll = 0
    press = null
    abd = null
    air = null
    pointer = null
  }

  return {
    el: canvas,
    resize,
    get onCue() { return onCue },
    set onCue(fn) { onCue = fn },
    menu: (count, at) => {
      clearSet()
      setScale(MENU_SCALE)
      skid.visible = false
      if (plates.length !== count) layoutPlates(count)
      for (const p of plates) { p.g.position.copy(p.pos); p.g.rotation.set(0, 0, 0) }
      standPlate = goalPlate = Math.max(0, Math.min(count - 1, at))
      goal.copy(standSpot(goalPlate))
      gpos.copy(goal)
      gyaw = -0.35
      arr.phase = 'idle'
      worldK = 0
      setSky(false)
      const first = mode === 'hold'
      if (first) { camera.position.copy(MENU_CAM).add(new THREE.Vector3(0, 30, 24)); look.copy(MENU_LOOK) }
      glide(MENU_CAM, MENU_LOOK, first ? 0.9 : 0.7, MENU_FOV)
      mode = 'menu'
      cur = clips.idle(0, 0)
      snapPose = true
      standRig()
    },
    menuHover: (i) => {
      if (mode !== 'menu' || i < 0 || i >= plates.length) return
      pointer = null
      goalPlate = i
      goal.copy(standSpot(i))
    },
    menuPointer: (x, y) => {
      if (mode !== 'menu' || plates.length === 0) return goalPlate
      ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1)), camera)
      const p = new THREE.Vector3()
      if (!ray.ray.intersectPlane(plane, p)) return goalPlate
      pointer = p
      const over = plateUnder(p)
      goalPlate = over >= 0 ? over : nearestPlate(p)
      goal.copy(onPlate(goalPlate, p, 1.6))
      return goalPlate
    },
    menuBox: (i) => {
      if (i < 0 || i >= plates.length) return [0, 0, 0, 0]
      const pl = plates[i]
      const p = pl.g.position
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const v = new THREE.Vector3(p.x + sx * pl.w / 2, PLATE_TOP, p.z + sz * pl.d / 2).project(camera)
        const px = ((v.x + 1) / 2) * w, py = ((1 - v.y) / 2) * h
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py)
      }
      return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]
    },
    menuPress: (i, kind) => new Promise<void>((resolve) => {
      if (i < 0 || i >= plates.length) { resolve(); return }
      // the goose is usually already on the plate; if it is not, it is put there
      if (air || standPlate !== i) { gpos.copy(standSpot(i)) }
      air = null
      pointer = null
      standPlate = goalPlate = i
      standRig()
      press = {
        kind, plate: i, t0: now(), resolve, done: false,
        cam0: camera.position.clone(), look0: look.clone(), fov0: camera.fov,
        selfieCam: new THREE.Vector3(), selfieLook: new THREE.Vector3(),
        flashed: false, started: false, lastBang: -9,
        slide: new THREE.Vector3(), vel: new THREE.Vector3(), off: false, inHole: -1, holeAt: new THREE.Vector3(),
      }
      mode = 'press'
    }),
    map: (count, selected, done, arrive = false) => {
      clearSet()
      setScale(MAP_SCALE)
      buildNodes(count, done)
      nodeSel = Math.max(0, Math.min(count - 1, selected))
      setSky(false)
      const t = now()
      if (mode !== 'map' && mode !== 'tomap') {
        glide(MAP_CAM, MAP_LOOK, 0.8, 38)
        mode = 'tomap'
      }
      if (arrive) startArrival(nodeSel, t)
      else {
        arr.phase = 'idle'
        act = null
        nextAct = t + 2 + Math.random() * 3
        gpos.copy(nodeTop(nodeSel))
        standRig()
      }
    },
    gooseTo: (i) => {
      if (i < 0 || i >= nodes.length) return
      nodeSel = i
      if (arr.phase === 'ball' || arr.phase === 'getup') return
      act = null
      gpos.setY(0)
      startRush(i, now())
    },
    project: (i) => {
      const p = nodePos(i).add(new THREE.Vector3(0, 1.7, 0)).project(camera)
      return [Math.round(((p.x + 1) / 2) * w), Math.round(((1 - p.y) / 2) * h)]
    },
    setWorld: (k) => { worldK = k; if (mode !== 'win') setSky(false) },
    abduct: () => new Promise<void>((resolve) => {
      if (mode !== 'map' && mode !== 'tomap') { resolve(); return }
      act = null
      if (arr.phase !== 'idle') { arr.phase = 'idle'; gpos.copy(nodeTop(nodeSel)) }
      const f = facing(), p = perp()
      abd = {
        t0: now(), resolve, done: false,
        base: gpos.clone(), f, p, ufoFrom: gpos.clone().addScaledVector(f, 90).addScaledVector(p, -50).add(new THREE.Vector3(0, 55, 0)),
        contact: false, fired: 0,
      }
      cue('ufo')
      mode = 'abduct'
    }),
    winShow: (onCut, seed) => new Promise<void>((resolve) => {
      clearSet()
      skid.visible = false
      setScale(WIN_SCALE)
      winCut = onCut
      winCutsDone = -1
      const names: PoseName[] = ['rohan', 'dio', 'giorno']
      winPose = names[Math.abs(seed) % names.length]
      setSky(true)
      gpos.set(0, 0, 0)
      gyaw = -0.35
      hero.root.position.set(0, 0, 0)
      standRig()
      rig.root.visible = true
      mode = 'win'
      modeT0 = now()
      window.setTimeout(() => { hero.root.visible = false; for (const m of menacing) m.visible = false; camRoll = 0; mode = 'hold'; resolve() }, 5100)
    }),
    stop: () => {
      cancelAnimationFrame(raf)
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    },
  }
}
