/**
 * The goose's world, directed.
 *
 * One small 3D meadow, rendered at game-pixel size (≈384×216, no antialiasing,
 * flat toon steps, hard shadows) and shown at a whole-number scale, so every
 * pixel on screen is a game pixel.  The goose in it is the jointed figure from
 * `goose_rig.ts`: the sprite's own proportions and colours, fully three
 * dimensional, animated by clips.
 *
 * The world plays five scenes:
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
 *   · `chase`   PLAY was pressed.  The plate climbs away toward a bank of
 *               cloud with the goose on it.  The camera — a drone now, flown
 *               by somebody (`drone.ts`) — watches it go, loses it, turns
 *               after it roughly, and gives chase: up, into the cloud, a
 *               whiteout, and out the other side over the islands
 *               (`islands.ts`): the archipelago the levels live on, each
 *               island its own biome at its own height, the sea far below.
 *               It swings across them and drops toward the one the goose is
 *               bound for.
 *   · `map`     the level select, on an island.  Round stones along its
 *               walkway.  The goose arrives the way it left: thrown in at
 *               speed, tumbling as a rigid thing, smeared along its flight,
 *               bouncing, skidding a streak into the ground, then getting up
 *               dizzy (ドドド) and waddling — fast, rough — to its stone.  On
 *               the stone it idles: honks at you, looks around, startles,
 *               glowers.  Turning the page flies the drone to the next
 *               island; the vault's door has to be unlocked before it goes in.
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
  buildMeadow, driftMeadow, toonRamp, buildPlate, buildNode, buildUfo, buildHand, buildHero, applyHeroPose, POSES, buildHole,
  spriteVoxels, voxelMesh, menacingSprites, WORLDS, DUSK, SKY, HORIZON, PLATE_THICK, FEET,
} from './goose_world'
import type { PoseName } from './goose_world'
import { Drone } from './drone'
import { Kit, CellField, mixHex } from './island_kit'
import type { Island, Landing } from './island_kit'
import { buildArchipelago, WALL } from './islands'

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
  /**
   * The press: the phone shot, then the exit; resolves once the goose is
   * gone.  For PLAY the movie carries on by itself into the chase, and the
   * shell's next screen finds it mid-flight.
   */
  menuPress: (i: number, kind: ExitKind) => Promise<void>
  /**
   * The world map on island `world`: `count` stones stand along its walkway;
   * `done[i]` plants a flag; the goose is on `selected`.  With `arrive` the
   * goose is thrown in and walks to its stone.  A different island from the
   * one the drone is over means a flight; resolves once the drone is on its
   * mark there (and, for the vault, inside).
   */
  map: (count: number, selected: number, done: boolean[], arrive?: boolean, world?: number) => Promise<void>
  /** how many islands there are, and what island `k` is called */
  worlds: number
  worldName: (k: number) => string
  /** the goose goes to stone `i` */
  gooseTo: (i: number) => void
  /** where stone `i` is on the screen, in game pixels */
  project: (i: number) => [number, number]
  /** the world the map is on (the sky follows the drone, so this only records it) */
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
/** the plates float well above the meadow: the line the goose flies from them clears every island */
const PLATE_Y = 48
const PLATE_TOP = PLATE_Y + PLATE_THICK
/** the blueprint's stagger: two wide plates stepping down-right, a small one at the right */
const PLATE_SPECS: { x: number; z: number; w: number; d: number }[] = [
  { x: 0, z: 0, w: 42, d: 14 },
  { x: 11, z: 16.5, w: 42, d: 14 },
  { x: 34, z: -0.8, w: 22, d: 14 },
]
const PLATE_CX = -4
const PLATE_CZ = -3
/** where the bird went through the cloud: its feet, on the PLAY plate's line */
const HOLE = { y: PLATE_TOP, z: PLATE_CZ + 0.5 }
/** plates further apart than this are flown to, not hopped */
const FAR = 40
/** a crossing shorter than this is one leap straight onto the goal, with no landing shuffle */
const NEAR_HOP = 14
const NODE_TOP = 1.6
/** the menu camera: nearly overhead, the plates low and right of the wordmark */
const MENU_LOOK = new THREE.Vector3(PLATE_CX - 2, PLATE_Y, PLATE_CZ + 2)
const MENU_CAM = new THREE.Vector3(PLATE_CX - 2, PLATE_Y + 78, PLATE_CZ + 22)
const MENU_FOV = 42
const UP = new THREE.Vector3(0, 1, 0)
const ONE = new THREE.Vector3(1, 1, 1)
/** the meadow's fog, and the fog out over the islands, where the far ones should still show */
const FOG_NEAR = 150, FOG_FAR = 300, FAR_NEAR = 260, FAR_FAR = 1500
const SUN_OFF = new THREE.Vector3(40, 60, 30)

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
  // alpha so the drawing buffer is RGBA: the smear copies it back into a texture each frame
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', alpha: true })
  renderer.setPixelRatio(1)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.BasicShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY)
  scene.fog = new THREE.Fog(HORIZON, 150, 300)

  const ramp = toonRamp()
  const base = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp })

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6)
  sun.position.set(40, 60, 30)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -110; sun.shadow.camera.right = 110
  sun.shadow.camera.top = 110; sun.shadow.camera.bottom = -110
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 240
  sun.shadow.bias = -0.002
  scene.add(sun, sun.target)
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x8a7a6a, 1.1)
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
  const emotes = new Emotes(scene)
  const feathers = mkFeathers(scene)
  const dust = mkDust(scene)
  const puffs = mkPuffs(scene)
  /** what a landing throws up: recoloured to the ground it lands on */
  const landBits = mkDust(scene)
  const menuRoot = new THREE.Group()
  scene.add(menuRoot)
  const nodeRoot = new THREE.Group()
  scene.add(nodeRoot)

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.25, 2500)
  const look = new THREE.Vector3()
  let camRoll = 0
  let w = 384, h = 216

  // ── the 0.5 lens: the frame drawn to a buffer, then bulged onto the screen ──
  // A phone's ultra-wide is a fisheye: straight lines bow out, the middle
  // swells, the corners pull in and go dark.  The buffer is sampled on whole
  // pixels so the warp is made of pixels too, not a smear.
  let warpK = 0
  const warpRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true })
  const warpMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: warpRT.texture }, k: { value: 0 }, res: { value: new THREE.Vector2(w, h) } },
    depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tex; uniform float k; uniform vec2 res; varying vec2 vUv;
      void main() {
        float asp = res.x / res.y;
        vec2 c = (vUv - 0.5) * vec2(asp, 1.0);
        float r2 = dot(c, c);
        vec2 d = c * (1.0 + k * (0.55 * r2 + 0.35 * r2 * r2));
        vec2 uv = d / vec2(asp, 1.0) + 0.5;
        uv = (floor(uv * res) + 0.5) / res;
        vec4 col = texture2D(tex, uv);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec4(0.03, 0.02, 0.05, 1.0);
        // the lens's own dark rim, in three hard steps
        float rim = clamp((sqrt(r2) * 1.55 - 0.72) * k * 2.2, 0.0, 1.0);
        col.rgb *= 1.0 - floor(rim * 3.0) / 3.0 * 0.6;
        gl_FragColor = col;
        #include <colorspace_fragment>
      }`,
  })
  const warpScene = new THREE.Scene()
  warpScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), warpMat))
  const warpCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  // ── the smear: the last frame drawn back over this one, a touch bigger, when the drone is going flat out ──
  // a pixel buffer cannot blur, but it can remember: each frame keeps a fading
  // trace of the one before, swelling from the middle, so speed reads as a
  // smear of everything rushing past rather than lines drawn on top
  let ghostTex: THREE.FramebufferTexture | null = null
  // the copy holds the canvas's own bytes (already sRGB), so the quad passes them straight back out: no colour-space
  // conversion either way — and the texture stays linear-tagged, because a copy into an sRGB-tagged one is refused
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, opacity: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform float opacity; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, opacity); }',
    transparent: true, depthTest: false, depthWrite: false,
  })
  const ghost = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ghostMat)
  const ghostScene = new THREE.Scene()
  ghostScene.add(ghost)
  const ghostCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const resize = (nw: number, nh: number): void => {
    w = nw; h = nh
    renderer.setSize(w, h, false)
    warpRT.setSize(w, h)
    ;(warpMat.uniforms.res.value as THREE.Vector2).set(w, h)
    ghostTex?.dispose()
    ghostTex = new THREE.FramebufferTexture(w, h)
    ghostMat.uniforms.map.value = ghostTex
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

  // ── out past the meadow: the islands, and the drone that films them ───────
  const kit = new Kit(base)
  const arch = buildArchipelago(kit, scene, (n) => cue(n), HOLE)
  const drone = new Drone()
  const aimF = new THREE.Vector3()
  /** how far ahead the light's focus sits, eased so a new look target never yanks the shadows */
  let lookDist = 60
  // the streak the thrown bird leaves: segments laid along its roll, in the ground's own colour, wandering as the ground allows
  const TRAIL_N = 64
  const trail = new CellField(TRAIL_N, 1, 0.16, 1, kit.base.clone())
  trail.mesh.castShadow = false
  scene.add(trail.mesh)
  let trailN = 0, trailDist = 0
  const trailLast = new THREE.Vector3()
  const trailQ = new THREE.Quaternion(), trailP = new THREE.Vector3()
  const trailReset = (): void => { for (let i = 0; i < TRAIL_N; i++) trail.place(i, 0, -9999, 0); trail.commit(false); trailN = 0; trailDist = 0 }
  const trailMark = (x: number, z: number, len: number, wid: number, yaw: number, color: number): void => {
    const i = trailN % TRAIL_N
    trailN += 1
    trail.set(i, x, gY + 0.08, z, 1, color, len, wid)
    trailQ.setFromAxisAngle(UP, yaw)
    trail.placeQ(i, trailP.set(x, gY + 0.08, z), trailQ, len, 1, wid)
    trail.commit()
  }
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
  type Mode = 'hold' | 'menu' | 'press' | 'chase' | 'map' | 'abduct' | 'win'
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
  interface Plate { g: THREE.Group; pos: THREE.Vector3; w: number; d: number; lift: number; liftVel: number }
  let plates: Plate[] = []
  /** the plate the goose stands on (−1 in the air), and the one it is headed for */
  let standPlate = 0
  let goalPlate = 0
  /** how hard the bird is holding on to a plate that is moving under it, 0..1 */
  let brace = 0
  const goal = new THREE.Vector3()
  /** where the pointer is on the plates' plane, when it is known */
  let pointer: THREE.Vector3 | null = null
  interface Air { kind: 'hop' | 'fly'; from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number; plate: number }
  let air: Air | null = null
  let watchYaw = 0, watchT = -9
  /** the point the head is actually watching: it trails the pointer by a beat, the way an eye catches up */
  const watched = new THREE.Vector3()
  let watching = false
  /** how long the head takes to close most of the gap to the cursor, in seconds */
  const WATCH_LAG = 0.24
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
      plates.push({ g, pos, w: s.w, d: s.d, lift: 0, liftVel: 0 })
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
  /** plate `i`'s top, inset `m` from every edge, as [x0, x1, z0, z1] */
  const inset = (i: number, m: number): [number, number, number, number] => {
    const pl = plates[i]
    return [pl.pos.x - pl.w / 2 + m, pl.pos.x + pl.w / 2 - m, pl.pos.z - pl.d / 2 + m, pl.pos.z + pl.d / 2 - m]
  }
  /**
   * How much of the line `from`→`to` lies over plate `i` (inset `m`), as the
   * fractions at which it enters and leaves.  `enter > leave` means it misses
   * the plate altogether.
   */
  const span = (i: number, from: THREE.Vector3, to: THREE.Vector3, m: number): [number, number] => {
    const [x0, x1, z0, z1] = inset(i, m)
    let enter = -Infinity, leave = Infinity
    for (const [f, a, b, d] of [[from.x, x0, x1, to.x - from.x], [from.z, z0, z1, to.z - from.z]] as const) {
      if (Math.abs(d) < 1e-4) { if (f < a || f > b) return [1, 0]; continue }
      const s0 = (a - f) / d, s1 = (b - f) / d
      enter = Math.max(enter, Math.min(s0, s1))
      leave = Math.min(leave, Math.max(s0, s1))
    }
    return [enter, leave]
  }
  /** the point `s` of the way along the line `from`→`to`, on the plates' top */
  const along = (from: THREE.Vector3, to: THREE.Vector3, s: number): THREE.Vector3 => {
    const k = clamp01(s)
    return new THREE.Vector3(from.x + (to.x - from.x) * k, PLATE_TOP, from.z + (to.z - from.z) * k)
  }
  /**
   * The plate to leap to from `from`, on the way to the goal.
   *
   * Normally the goal's own plate, but a plate lying across the way is used as
   * a stepping stone when it is both a shorter leap and real progress, so a
   * long diagonal is crossed in steps rather than one improbable bound.
   */
  const leapPlate = (from: THREE.Vector3): number => {
    let best = goalPlate, bd = onPlate(goalPlate, from, 1.2).distanceTo(from)
    const far = from.distanceTo(goal)
    plates.forEach((_pl, i) => {
      if (i === standPlate || i === goalPlate) return
      const p = onPlate(i, from, 1.2)
      if (p.distanceTo(from) < bd && p.distanceTo(goal) < far - 0.5) { bd = p.distanceTo(from); best = i }
    })
    return best
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
        standPlate = air.plate
        air = null
        cue('land')
        dust.spawn(gpos, 2, t, new THREE.Vector3(0, 1, 0), 2)
        snapPose = true
        cur = clips.crouch()
      }
    } else if (goalPlate !== standPlate) {
      // off this plate where the line to the goal crosses the edge — straight at
      // the cursor, so walking to the take-off never means walking away from it
      const off = along(gpos, goal, span(standPlate, gpos, goal, 1.2)[1])
      if (gpos.distanceTo(off) < 0.6 || walk(off, dt, t, MENU_SPEED)) {
        // and onto the nearest bit of the next plate — the shortest leap that
        // will do, which for a plate holding the goal is always progress toward it
        const plate = leapPlate(gpos)
        const to = plate === goalPlate && gpos.distanceTo(goal) < NEAR_HOP ? goal.clone().setY(PLATE_TOP) : onPlate(plate, gpos, 1.2)
        const d = to.clone().sub(gpos).setY(0)
        if (Math.abs(wrapAngle(yawOf(d) - gyaw)) > 0.55) {
          // face the leap before taking it, so it reads as one move and not a sidestep
          faceToward(d, dt, 13)
          stride += dt * 7
          want = clips.waddle(stride)
        } else {
          const gap = gpos.distanceTo(to)
          air = { kind: gap > FAR ? 'fly' : 'hop', from: gpos.clone(), to, t0: t, dur: gap > FAR ? 0.4 + gap / 70 : 0.26 + gap / 40, plate }
          standPlate = -1
          cue(air.kind === 'fly' ? 'whoosh' : 'jump')
          if (Math.random() < 0.15) emote('quest', t)
        }
      }
    } else if (walk(goal, dt, t, MENU_SPEED)) {
      standing = true
      want = clips.idle(t, beat)
    }
    // the head follows the pointer while the bird stands: sampled eight times a second, snapped
    if (!pointer) watching = false
    else if (!watching) { watched.copy(pointer); watching = true }
    else watched.lerp(pointer, 1 - Math.exp(-dt / WATCH_LAG))
    if (standing && pointer) {
      if (t - watchT >= 1 / 8) {
        watchT = t
        const d = watched.clone().sub(gpos)
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
  /**
   * The plate racing off with the goose on it, `e` seconds into the exit.
   * PLAY's runs dead level — it is bound for the cloud, straight through it —
   * and SONGS' is gone before it matters.  The plate is the thing doing the racing, not a thing
   * being thrown: it stays dead flat and simply leaves, shuddering on its
   * axis as it goes.
   */
  const launchStep = (p: Press, e: number, t: number, dt: number): void => {
    const plate = plates[p.plate]
    const dir = p.kind === 'right' ? 1 : -1
    const up = 0
    const dist = p.kind === 'right' ? 30 * e + 500 * e * e : 30 * e + 1300 * e * e
    const dd = p.kind === 'right' ? 30 * dt + 1000 * e * dt : 30 * dt + 2600 * e * dt
    plate.g.position.set(plate.pos.x + dir * dist, plate.pos.y + Math.sin(e * 18) * 0.4 + up, plate.pos.z)
    plate.g.rotation.set(0, 0, 0)
    gpos.x += dir * dd
    gpos.y = PLATE_TOP + 0.3 + Math.abs(Math.sin(e * 24)) * 0.5 + up
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
  }
  const SELFIE_IN = 0.3
  const SELFIE_HOLD = 0.6
  const tickPress = (t: number, dt: number, beat: number): void => {
    const p = press!
    const age = t - p.t0
    const f = facing()
    if (age < SELFIE_IN + SELFIE_HOLD) {
      // the phone: straight in front of the face, a little above, tilted down — the beak in the middle, very wide
      want = clips.idle(t, beat)
      const gs = gooseScale / MENU_SCALE
      // The 0.5 lens: close in and level with the face, so the head is what
      // the frame is about.  Anchored off the beak tip rather than the skull:
      // the beak reaches most of a goose further forward, and a lens measured
      // from the skull sits behind it.
      const bk = beakPos()
      const hd = headPos()
      const gh = GOOSE_H * gooseScale
      p.selfieCam.copy(bk).addScaledVector(f, 1.0 * gs)
      // the lens at the eye line, a hair above, looking straight at the face:
      // the whole head sits big in the middle of the frame, the body falls
      // away under it and the meadow bends round the edges
      p.selfieCam.y = hd.y + gh * 0.08
      p.selfieLook.set(bk.x, hd.y - gh * 0.02, bk.z)
      const k = easeOut(clamp01(age / SELFIE_IN))
      camera.position.lerpVectors(p.cam0, p.selfieCam, k)
      look.lerpVectors(p.look0, p.selfieLook, k)
      camera.fov = lerp(p.fov0, 112, k)
      // the 0.5: a lens this wide bulges — the warp comes in with the camera
      warpK = k
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
    warpK = Math.max(0, 1 - e / 0.3)
    const plate = plates[p.plate]
    const base0 = gpos.clone()
    if (!p.started) { p.started = true; p.slide.copy(gpos).sub(plate.pos); cue(p.kind === 'trap' ? 'trap' : 'crash_zoom') }
    if (p.kind === 'right' || p.kind === 'left') {
      launchStep(p, e, t, dt)
      // the camera stays where the phone was, pulls up a little, and pans after the goose
      const k = easeOut(clamp01(e / 0.45))
      camera.position.copy(p.selfieCam).addScaledVector(f, -2.5 * k).add(new THREE.Vector3(0, 6 * k, 3 * k))
      look.copy(gpos).add(new THREE.Vector3(0, 1.5, 0))
      camera.fov = lerp(100, 66, k)
      if (p.kind === 'right' && e >= 0.3) { startChase(t); return }
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

  // ── the islands: where the map plays ──────────────────────────────────────
  let isle: Island = arch.islands[0]
  /** the ground under the goose: the island's walkway level, world y */
  let gY = 0
  const setIsle = (k: number): void => {
    const dest = arch.islands[((k % arch.islands.length) + arch.islands.length) % arch.islands.length]
    isle = dest
    gY = isle.at.y + isle.bob
    feathers.floor = dust.floor = puffs.floor = landBits.floor = gY + 0.15
  }
  let nodes: THREE.Group[] = []
  let nodeSel = 0
  const spotOf = (i: number): THREE.Vector3 => isle.spots[clamp(i, 0, isle.spots.length - 1)] ?? isle.at
  const nodePos = (i: number): THREE.Vector3 => spotOf(i).clone().add(new THREE.Vector3(0, isle.bob, 0))
  const nodeTop = (i: number): THREE.Vector3 => nodePos(i).add(new THREE.Vector3(0, NODE_TOP, 0))
  const buildNodes = (count: number, done: boolean[]): void => {
    for (const n of nodes) nodeRoot.remove(n)
    nodes = []
    for (let i = 0; i < count; i++) {
      const g = buildNode(!!done[i], base)
      nodes.push(g)
      nodeRoot.add(g)
      g.position.copy(spotOf(i))
    }
  }
  type ArrPhase = 'idle' | 'ball' | 'getup' | 'rush' | 'hop'
  interface Arrival {
    phase: ArrPhase
    // the ball
    pos: THREE.Vector3; vel: THREE.Vector3; quat: THREE.Quaternion; ang: THREE.Vector3; lastDir: THREE.Vector3; bounces: number
    // getting up
    t0: number; fromQuat: THREE.Quaternion; yawTarget: number
    // the walk and the hop
    from: THREE.Vector3; to: THREE.Vector3; dur: number; stepT: number
  }
  const arr: Arrival = {
    phase: 'idle', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), ang: new THREE.Vector3(),
    lastDir: new THREE.Vector3(1, 0, 0), bounces: 0, t0: 0, fromQuat: new THREE.Quaternion(), yawTarget: 0,
    from: new THREE.Vector3(), to: new THREE.Vector3(), dur: 1, stepT: 0,
  }
  const ballR = (): number => BODY_CENTRE.y * gooseScale
  const GRAV = 70
  const MAP_SPEED = 60
  /** the ball's bounce: what it keeps of its run and of its spin (what it keeps of its lift, and how hard the roll is slowed, are the ground's to say) */
  const BOUNCE_RUN = 0.42, BOUNCE_SPIN = 0.75
  /** the roll is over below this: the solver and the live roll must agree on it */
  const ROLL_STOP = 1.2
  /** the beat it lies there, dizzy, before it picks itself up */
  const GETUP_REST = 0.6
  /** how far the ball travels after it first hits, arriving at `run` along the ground and `fall` downward */
  const rollDistance = (run: number, fall: number, land: Landing): number => {
    let x = 0, y = ballR(), vx = run, vy = fall
    let first = true
    for (let i = 0; i < 2400; i++) {
      const dt = 1 / 240
      vy -= GRAV * dt
      x += vx * dt; y += vy * dt
      if (y <= ballR()) {
        y = ballR()
        if (vy < -6 || first) { vy = Math.abs(vy) * land.bounce; vx *= BOUNCE_RUN; first = false }
        else { vy = 0; vx = Math.max(0, vx - land.drag * dt); if (vx < ROLL_STOP) break }
      }
    }
    return x
  }
  interface ArriveFrom { dir: THREE.Vector3; drop: number; reach: number; speed?: number; lane?: number }
  /**
   * The throw onto the island: in from the mainland's side (or the way the
   * island says — the vault's is low and through its door), at speed, to
   * come to rest a few steps from the stone it is bound for, inside the coast.
   */
  const startArrival = (target: number, t: number): void => {
    const tp = nodePos(target)
    const from = isle.g.userData.arriveFrom as ArriveFrom | undefined
    const land = isle.land
    const th = Math.atan2(tp.z, tp.x) + (Math.random() - 0.5) * 0.9
    const dir = from ? from.dir.clone().normalize() : new THREE.Vector3(Math.cos(th), 0, Math.sin(th))
    const side = new THREE.Vector3(-dir.z, 0, dir.x)
    let rest = tp.clone()
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * TAU, d = 5 + Math.random() * 5
      const c = tp.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d))
      // through a doorway: the rest point stays in the lane the throw comes down
      if (from?.lane !== undefined && Math.abs(c.clone().sub(tp).dot(side)) > from.lane) continue
      if (isle.inside(c.x, c.z)) { rest = c; break }
    }
    // how it comes in is where it comes from: dropped in from above to bounce a few times,
    // lobbed up over the rim from below, or flat and fast from level
    const rise = gY - (travel?.fromY ?? gY)
    let speed: number, drop: number, reach: number
    if (from) { speed = from.speed ?? 150; drop = from.drop; reach = from.reach }
    else if (rise < -12) { speed = 105; drop = 22 + Math.min(40, -rise * 0.45); reach = 120 }
    else if (rise > 12) { speed = 75; drop = -10; reach = 90 }
    else { speed = 150; drop = 16 + Math.random() * 12; reach = 150 }
    const tf = reach / speed
    const vy0 = (ballR() - drop + 0.5 * GRAV * tf * tf) / tf
    const fall = vy0 - GRAV * tf
    // where it must first hit for the bounces and the roll to end at `rest`
    const landing = rest.clone().addScaledVector(dir, -rollDistance(speed, fall, land))
    const entry = landing.clone().addScaledVector(dir, -reach)
    entry.y = gY + drop
    arr.pos.copy(entry)
    arr.vel.copy(dir).multiplyScalar(speed)
    arr.vel.y = vy0
    arr.ang.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(22 + Math.random() * 12)
    arr.quat.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6))
    arr.lastDir.copy(dir)
    arr.bounces = 0
    trailReset()
    landBits.setColor(land.bits)
    arr.phase = 'ball'
    arr.t0 = t
    rig.root.visible = true
    act = null
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
    const land = isle.land
    arr.vel.y -= GRAV * dt
    arr.pos.addScaledVector(arr.vel, dt)
    if (isle.collide && isle.collide(arr.pos, arr.vel, ballR())) {
      // off a wall: a knock, and whatever the wall gives off
      cue('thud')
      drone.shake(0.2, 0.2)
      landBits.spawn(arr.pos.clone(), 6, t, new THREE.Vector3(0, 2, 0), 7 * land.spray)
      feathers.spawn(arr.pos, 3, t, new THREE.Vector3(0, 3, 0), 5)
      arr.ang.multiplyScalar(0.7)
    }
    const rate = arr.ang.length()
    if (rate > 1e-4) {
      dq.setFromAxisAngle(arr.ang.clone().normalize(), rate * dt)
      arr.quat.premultiply(dq)
    }
    const sp = arr.vel.length()
    if (Math.random() < dt * (sp > 40 ? 24 : 8)) feathers.spawn(arr.pos, 1, t, new THREE.Vector3(0, 2, 0).addScaledVector(arr.vel, -0.12), 5)
    if (arr.pos.y <= gY + ballR()) {
      arr.pos.y = gY + ballR()
      if (arr.vel.y < -6 || arr.bounces === 0) {
        arr.vel.y = Math.abs(arr.vel.y) * land.bounce
        arr.vel.x *= BOUNCE_RUN; arr.vel.z *= BOUNCE_RUN
        arr.ang.multiplyScalar(BOUNCE_SPIN)
        arr.bounces += 1
        cue('thud')
        drone.shake(0.25, 0.25)
        landBits.spawn(new THREE.Vector3(arr.pos.x, gY + 0.4, arr.pos.z), 7, t, new THREE.Vector3(0, 3 * land.spray, 0), 6 * land.spray)
        feathers.spawn(arr.pos, 4, t, new THREE.Vector3(0, 5, 0), 6)
        // the dent where it hit
        trailMark(arr.pos.x, arr.pos.z, land.width * 1.8, land.width * 1.5, Math.random() * TAU, land.skid)
        trailLast.copy(arr.pos)
      } else {
        // on the ground: rolling, and slowing as hard as this ground slows it — and the ground under it marked
        arr.vel.y = 0
        const hs = Math.hypot(arr.vel.x, arr.vel.z)
        const ns = Math.max(0, hs - land.drag * dt)
        if (hs > 1e-3) { arr.vel.x *= ns / hs; arr.vel.z *= ns / hs }
        if (ns > 0.5) arr.lastDir.set(arr.vel.x, 0, arr.vel.z).normalize()
        arr.ang.copy(UP).cross(arr.vel).divideScalar(ballR())
        // the streak: a segment every unit or so, wandering side to side as much as this ground lets it
        const dx = arr.pos.x - trailLast.x, dz = arr.pos.z - trailLast.z
        const seg = Math.hypot(dx, dz)
        if (seg > 1.0) {
          trailDist += seg
          const off = Math.sin(trailDist * 1.7) * land.wobble * 1.2 + (Math.random() - 0.5) * land.wobble * 0.5
          const px = -dz / seg, pz = dx / seg
          trailMark((arr.pos.x + trailLast.x) / 2 + px * off, (arr.pos.z + trailLast.z) / 2 + pz * off, seg + 0.4, land.width, -Math.atan2(dz, dx), land.skid)
          trailLast.copy(arr.pos)
        }
        if (ns < ROLL_STOP) {
          arr.phase = 'getup'
          arr.t0 = t
          arr.fromQuat.copy(arr.quat)
          arr.yawTarget = yawOf(arr.lastDir)
        }
      }
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
    arr.pos.y = gY + ballR()
    placeBall(arr.pos, arr.quat, null, 1)
    want = clips.dizzy(t)
    if (u >= 1) {
      gyaw = arr.yawTarget
      gpos.copy(arr.pos).setY(gY)
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
      dust.spawn(gpos.clone(), 3, t, new THREE.Vector3(0, 1.5, 0), 3)
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

  // ── the flight to an island, and what happens on arrival ──────────────────
  type Stage = 'fly' | 'arrive' | 'enter' | 'settled'
  /** the stones to build once the island being left is out of frame */
  interface Pending { count: number; done: boolean[]; sel: number }
  interface Travel {
    stage: Stage; until: number; thrown: boolean; resolvers: (() => void)[]
    pending: Pending | null; from: Island | null; start: THREE.Vector3
    /** when the eye starts for the island (the flight may be under way already), what it was on until then, and the lens it goes to */
    t0: number; look0: THREE.Vector3; fov: number
    /** the height the bird is thrown from: the island it left, or the plates */
    fromY: number
  }
  /** the island being left is behind the lens now: its stones go, the new island's come, its door shuts */
  const unpark = (tv: Travel): void => {
    const p = tv.pending!
    tv.pending = null
    buildNodes(p.count, p.done)
    nodeSel = p.sel
    rig.root.visible = false
    trailReset()
    tv.from?.leave?.()
  }
  /**
   * one curve from here to `i`'s mark, flown whole.  It arrives down the mark's own line of sight, from the front and from
   * above.  It leaves along `vel` if the drone is moving (the curve's tangent is the velocity it has, so there is no corner),
   * else out along `out` (a doorway) or straight at the island, climbing at once to above both ends so the crossing looks down
   * on the archipelago and never comes at an island from under its rock
   */
  const pathTo = (i: Island, from: THREE.Vector3, vel: THREE.Vector3 | null, out: THREE.Vector3 | null = null): THREE.Curve<THREE.Vector3> => {
    const end = i.cam.pos.clone()
    const back = i.cam.pos.clone().sub(i.cam.look).normalize()
    const d = from.distanceTo(end)
    const c2 = end.clone().addScaledVector(back, clamp(d * 0.28, 30, 90))
    const c1 = from.clone()
    if (vel && vel.lengthSq() > 400) c1.addScaledVector(vel.clone().normalize(), d * 0.3)
    else {
      const dir0 = (out ?? c2.clone().sub(from)).setY(0)
      if (dir0.lengthSq() < 1e-4) dir0.set(1, 0, 0)
      c1.addScaledVector(dir0.normalize(), d * 0.3)
      c1.y = Math.max(from.y, end.y) + clamp(d * 0.12, 8, 30)
    }
    return new THREE.CubicBezierCurve3(from.clone(), c1, c2, end)
  }
  const FLIGHT = { cruise: 175, accel: 165, sloppy: 3 }
  const TOP = new THREE.Vector3(0, 14, 0)
  const eyeTmp = new THREE.Vector3(), eyeTop = new THREE.Vector3()
  let travel: Travel | null = null
  const finishTravel = (t: number): void => {
    const tv = travel!
    tv.stage = 'settled'
    if (tv.pending) unpark(tv)
    if (!tv.thrown) { tv.thrown = true; startArrival(nodeSel, t) }
    const rs = tv.resolvers
    tv.resolvers = []
    for (const r of rs) r()
  }
  const tickTravel = (t: number): void => {
    const tv = travel
    if (!tv) return
    if (tv.stage === 'fly') {
      const u = drone.progress()
      if (tv.pending && (drone.pos.distanceTo(tv.start) > 80 || u > 0.5)) unpark(tv)
      // the eye: swung from wherever it was onto the island's top over the first beat, then let down onto the shot along the
      // last stretch — one continuous target, so the gimbal never has a step to swing past
      eyeTop.copy(isle.at).add(TOP)
      eyeTmp.copy(tv.look0).lerp(eyeTop, smooth(clamp01((t - tv.t0) / 1.1))).lerp(isle.cam.look, smooth(clamp01((u - 0.6) / 0.4)))
      drone.lookAt(eyeTmp)
      if (t > tv.t0) drone.setFov(tv.fov)
      // thrown a beat before the drone gets there, so the landing is what it arrives on; a door waits to be opened first
      if (!tv.thrown && !isle.arrive && drone.remaining() < 150) { if (tv.pending) unpark(tv); tv.thrown = true; startArrival(nodeSel, t) }
      // near enough: the chrome comes in while the drone is still easing onto its mark
      if (drone.settled(9, 18)) {
        if (isle.arrive) { tv.until = t + isle.arrive(t); tv.stage = 'arrive'; drone.shake(0.5, 0.35) }
        else finishTravel(t)
      }
    } else if (tv.stage === 'arrive') {
      if (t > tv.until) {
        if (!tv.thrown) { if (tv.pending) unpark(tv); tv.thrown = true; startArrival(nodeSel, t) }
        if (isle.camIn) {
          drone.fly(isle.camIn.pos, { cruise: 42, accel: 40, fov: isle.camIn.fov, sloppy: 1.5, hesitate: 0.4 })
          drone.lookAt(isle.camIn.look)
          tv.stage = 'enter'
          cue('drone')
        } else finishTravel(t)
      }
    } else if (tv.stage === 'enter') {
      if (drone.settled(3, 5)) finishTravel(t)
    }
  }
  /** the drone leaves for `isle`'s mark; the goose follows, thrown.  `from` is the island it is leaving, whose stones stay until it is out of frame */
  const flyTo = (resolve: () => void, from: Island, pending: Pending): void => {
    if (arr.phase === 'ball' || arr.phase === 'getup') rig.root.visible = false
    arr.phase = 'idle'
    act = null
    // out of a doorway first if it is in one; on the way it already is if it is moving; otherwise straight at the island
    const out = from.camIn && drone.pos.distanceTo(from.camIn.pos) < 12 ? from.cam.pos.clone().sub(from.camIn.pos) : null
    travel = { stage: 'fly', until: 0, thrown: false, resolvers: [resolve], pending, from, start: drone.pos.clone(), t0: now(), look0: drone.lookGoal.clone(), fov: isle.cam.fov, fromY: from.at.y }
    drone.follow(pathTo(isle, drone.pos, drone.vel, out), { ...FLIGHT, fov: isle.cam.fov, hesitate: 0.3 })
    cue('drone')
  }

  // ── the chase: after the goose, through the cloud, over the islands ───────
  type ChasePhase = 'watch' | 'turn' | 'go'
  interface Chase { t0: number; phase: ChasePhase; phaseT0: number; seen: THREE.Vector3; f: THREE.Vector3; resolvers: (() => void)[]; cued: boolean }
  let chase: Chase | null = null
  /** the haze that hides the islands from the mainland, 0..1 */
  let hazeK = 1
  /** the middle of the hole in the cloud */
  const THROUGH = new THREE.Vector3(WALL.x, HOLE.y + 7, HOLE.z)
  const startChase = (t: number): void => {
    chase = { t0: t, phase: 'watch', phaseT0: t, seen: gpos.clone(), f: facing(), resolvers: [], cued: false }
    mode = 'chase'
    setScale(MENU_SCALE)
    hazeK = 1
    // the drone takes the frame as the bird passes: its gimbal is slower than the bird, so it is left behind and swings after it
    drone.cut(camera.position, look, camera.fov)
    plates.forEach((pl, i) => { pl.g.visible = i === press!.plate })
  }
  const tickChase = (t: number, dt: number): void => {
    const c = chase!, p = press!
    const a = t - c.t0
    // the launch goes on until the bird is through the cloud; the shell is told once the bird is well away
    if (rig.root.visible) {
      launchStep(p, a + 0.3, t, dt)
      c.seen.copy(gpos)
      if (gpos.x > WALL.x + 8) { rig.root.visible = false; plates[p.plate].g.visible = false; setScale(MAP_SCALE) }
    }
    if (!p.done && a >= 0.25) { p.done = true; p.resolve() }
    if (c.phase === 'watch') {
      // the pilot's eye follows the bird past and away
      drone.lookAt(c.seen.clone().add(new THREE.Vector3(0, 1.5, 0)))
      drone.setFov(66)
      if (a > 0.3) {
        c.phase = 'turn'; c.phaseT0 = t
        // it settles to the bird's height and swings round to where it went: the hole in the cloud
        drone.fly(new THREE.Vector3(drone.pos.x - 3, HOLE.y + 7, HOLE.z + 3), { cruise: 40, accel: 45, sloppy: 1.5, hesitate: 0.05 })
        cue('drone')
      }
    } else if (c.phase === 'turn') {
      drone.lookAt(THROUGH)
      if (t - c.phaseT0 > 0.25) {
        c.phase = 'go'; c.phaseT0 = t
        // flat out, dead level, at the hole
        drone.fly(new THREE.Vector3(WALL.x + 150, HOLE.y + 16, HOLE.z), { cruise: 270, accel: 170, sloppy: 2.5, hesitate: 0, fov: 60 })
        drone.lookAt(new THREE.Vector3(WALL.x + 220, HOLE.y + 12, HOLE.z))
      }
    } else if (c.phase === 'go') {
      if (!c.cued && drone.pos.x > WALL.x - 120) { c.cued = true; cue('cloud') }
      if (drone.pos.x > WALL.x + 15) {
        // through: one curve from here, on the way it is going, down onto the island the goose is bound for — the lens wide
        // and the eye across the whole archipelago for a beat before it finds the one
        drone.lookAt(arch.vista.look)
        cue('reveal')
        travel = { stage: 'fly', until: 0, thrown: false, resolvers: c.resolvers, pending: null, from: null, start: drone.pos.clone(), t0: t + 0.7, look0: arch.vista.look.clone(), fov: isle.cam.fov, fromY: HOLE.y }
        drone.follow(pathTo(isle, drone.pos, drone.vel), { cruise: 150, accel: 190, sloppy: 3, fov: arch.vista.fov, hesitate: 0 })
        chase = null
        mode = 'map'
      }
    }
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
  const focus = new THREE.Vector3()
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
      // the plate under the pointer rises, eased; the bird on it braces as it does — a flap, the legs set wider
      plates.forEach((p, i) => {
        const was = p.lift
        p.lift += ((i === goalPlate ? 0.9 : 0) - p.lift) * (1 - Math.exp(-dt * 9))
        p.liftVel = (p.lift - was) / Math.max(1e-3, dt)
        p.g.position.y = p.pos.y + p.lift
      })
      if (!air && standPlate >= 0 && standPlate < plates.length) {
        const pl = plates[standPlate]
        gpos.y += (PLATE_TOP + pl.lift - gpos.y) * (1 - Math.exp(-dt * 16))
        brace += (clamp01(Math.abs(pl.liftVel) * 0.5) - brace) * (1 - Math.exp(-dt * (Math.abs(pl.liftVel) > 0.5 ? 20 : 4)))
        standRig()
      } else brace = Math.max(0, brace - dt * 3)
      if (brace > 0.01) want = mix(want, { ...want, wing: 0.42 + Math.sin(t * 28) * 0.2, legs: [0.32, -0.32], y: want.y - 0.35, neck: want.neck - 0.15, squash: 0.94 }, brace)
    } else if (mode === 'press') {
      tickPress(t, dt, beat)
    } else if (mode === 'chase') {
      tickChase(t, dt)
    } else if (mode === 'map') {
      gY = isle.at.y + isle.bob
      nodeRoot.position.y = isle.bob
      tickTravel(t)
      if (arr.phase === 'ball') tickBall(t, dt)
      else if (arr.phase === 'getup') tickGetup(t)
      else if (arr.phase === 'rush') tickRush(t, dt)
      else if (arr.phase === 'hop') tickHop(t)
      else if (rig.root.visible) { if (travel?.pending) { want = clips.idle(t, beat); standRig() } else tickIdleOnStone(t, beat) }
      nodes.forEach((n, i) => {
        const top = n.userData.top as THREE.Mesh
        top.position.y = i === nodeSel && beat < 0.5 ? 1.6 : 1.3
      })
    } else if (mode === 'abduct') {
      gY = isle.at.y + isle.bob
      nodeRoot.position.y = isle.bob
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

    nodeRoot.visible = mode === 'map' || mode === 'abduct' || mode === 'chase'
    trail.mesh.visible = nodeRoot.visible
    menuRoot.visible = mode === 'menu' || mode === 'press' || mode === 'chase'
    hole.visible = hole.visible && mode === 'press'
    meadow.fence.visible = mode !== 'win'
    for (const c of meadow.clouds) c.visible = mode !== 'menu'
    driftMeadow(meadow, t)
    emotes.update(t, camera, pxAt)
    feathers.update(t, dt)
    dust.update(t, dt)
    puffs.update(t, dt)
    landBits.update(t, dt)

    // the camera: the drone's out over the islands, the rails' everywhere else
    const far = mode === 'chase' || mode === 'map' || mode === 'abduct'
    const flown = far
    if (flown) {
      drone.update(t, dt)
      drone.apply(camera)
      if (trace.length < 20000) { const d = drone.debug(); trace.push([t, d.speed, d.roll, d.pitch, d.yaw, d.acc, d.u, drone.pos.x, drone.pos.y, drone.pos.z, d.shaking ? 1 : 0]) }
      // the light follows what the gimbal is actually pointed at, not where it was told to point, so shadows never jump
      drone.forward(aimF)
      lookDist += (Math.max(12, drone.pos.distanceTo(drone.lookGoal)) - lookDist) * (1 - Math.exp(-dt * 3))
      look.copy(drone.pos).addScaledVector(aimF, lookDist)
    } else aim()
    // the light follows the frame, so the shadows are where the camera is
    focus.copy(look)
    sun.target.position.copy(focus)
    sun.position.copy(focus).add(SUN_OFF)
    if (far) {
      arch.tick(t, dt, camera.position)
      // the sky is whatever is near, lit by any lightning
      const pal = arch.palette(camera.position, WORLDS[0])
      const fl = arch.flash(camera.position)
      ;(scene.background as THREE.Color).setHex(mixHex(pal[0], 0xffffff, fl * 0.6))
      ;(scene.fog as THREE.Fog).color.setHex(mixHex(pal[1], 0xffffff, fl * 0.6))
      hemi.color.setHex(pal[2])
      sun.color.setHex(pal[3])
      hemi.intensity = 1.1 + fl * 2.5
      // the mainland's short fog is let out over the first second, and the islands show through the hole in the cloud
      hazeK = Math.max(0, hazeK - dt / 0.9)
      ;(scene.fog as THREE.Fog).near = lerp(FAR_NEAR, 120, hazeK)
      ;(scene.fog as THREE.Fog).far = lerp(FAR_FAR, 430, hazeK)
    }
    if (mode !== 'press') warpK = 0
    if (warpK > 0.01) {
      renderer.setRenderTarget(warpRT)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      warpMat.uniforms.k.value = warpK
      renderer.render(warpScene, warpCam)
    } else renderer.render(scene, camera)
    // the smear: only at speed, and the more the faster
    const smear = far ? clamp01((drone.speed() - 110) / 150) * 0.8 : 0
    if (smear > 0.01) {
      renderer.autoClear = false
      // twice over: a near trace and a far one, so the streak has length and not just a doubled edge
      ghostMat.uniforms.opacity.value = smear
      ghost.scale.setScalar(1 + smear * 0.06)
      renderer.render(ghostScene, ghostCam)
      ghostMat.uniforms.opacity.value = smear * 0.55
      ghost.scale.setScalar(1 + smear * 0.16)
      renderer.render(ghostScene, ghostCam)
      renderer.autoClear = true
    }
    if (ghostTex) renderer.copyFramebufferToTexture(ghostTex)
  }
  raf = requestAnimationFrame(tick)
  // the probes read the frame's cost and where the movie is
  /** every flown frame's numbers, for a probe to read back: t, speed, roll, pitch, yaw, acc, progress, x, y, z, shaking */
  const trace: number[][] = []
  ;(window as unknown as { __trace: number[][] }).__trace = trace
  ;(window as unknown as { __movieInfo: () => unknown }).__movieInfo = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, mode, island: isle.id, cam: camera.position.toArray().map((v) => Math.round(v)), goose: gpos.toArray().map((v) => Math.round(v)), phase: arr.phase, shown: rig.root.visible, sel: nodeSel })

  /** the meadow's own light and fog, for the title and the win show */
  const homeSky = (dusk: boolean): void => {
    setSky(dusk)
    ;(scene.fog as THREE.Fog).near = FOG_NEAR
    ;(scene.fog as THREE.Fog).far = FOG_FAR
    hemi.intensity = 1.1
    feathers.floor = dust.floor = puffs.floor = landBits.floor = 0.15
    isle.leave?.()
  }
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
    landBits.clear()
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
    chase = null
    travel = null
  }

  return {
    el: canvas,
    resize,
    get onCue() { return onCue },
    set onCue(fn) { onCue = fn },
    worlds: arch.islands.length,
    worldName: (k) => arch.islands[((k % arch.islands.length) + arch.islands.length) % arch.islands.length].name,
    menu: (count, at) => {
      clearSet()
      setScale(MENU_SCALE)
      trailReset()
      if (plates.length !== count) layoutPlates(count)
      for (const p of plates) { p.g.position.copy(p.pos); p.g.rotation.set(0, 0, 0); p.g.visible = true }
      standPlate = goalPlate = Math.max(0, Math.min(count - 1, at))
      goal.copy(standSpot(goalPlate))
      gpos.copy(goal)
      gyaw = -0.35
      arr.phase = 'idle'
      worldK = 0
      homeSky(false)
      // from nowhere, or from out over the islands: drop in from above rather than smear across the sky
      const first = mode === 'hold' || camera.position.distanceTo(MENU_CAM) > 250
      if (first) { camera.position.copy(MENU_CAM).add(new THREE.Vector3(0, 30, 24)); look.copy(MENU_LOOK); camera.fov = MENU_FOV }
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
        const v = new THREE.Vector3(p.x + sx * pl.w / 2, p.y + PLATE_THICK, p.z + sz * pl.d / 2).project(camera)
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
    map: (count, selected, done, arrive = false, world = 0) => new Promise<void>((resolve) => {
      const k = ((world % arch.islands.length) + arch.islands.length) % arch.islands.length
      const dest = arch.islands[k]
      worldK = k
      if (mode === 'chase') {
        // mid-flight: the chase lands on this island (the bird is scaled down once it is out of sight)
        setIsle(k)
        buildNodes(count, done)
        nodeSel = clamp(selected, 0, count - 1)
        chase!.resolvers.push(resolve)
        return
      }
      if (mode === 'map') {
        if (dest !== isle) {
          const from = isle
          setIsle(k)
          flyTo(resolve, from, { count, done, sel: clamp(selected, 0, count - 1) })
          return
        }
        buildNodes(count, done)
        nodeSel = clamp(selected, 0, count - 1)
        if (travel && travel.stage !== 'settled') { travel.resolvers.push(resolve); return }
        if (arrive) startArrival(nodeSel, now())
        else if (arr.phase === 'idle') { rig.root.visible = true; gpos.copy(nodeTop(nodeSel)); standRig() }
        resolve()
        return
      }
      // from anywhere else: a cut to the island
      clearSet()
      setScale(MAP_SCALE)
      if (dest !== isle) isle.leave?.()
      setIsle(k)
      buildNodes(count, done)
      nodeSel = clamp(selected, 0, count - 1)
      drone.cut(dest.cam.pos, dest.cam.look, dest.cam.fov)
      mode = 'map'
      const t = now()
      rig.root.visible = false
      arr.phase = 'idle'
      act = null
      trailReset()
      travel = { stage: 'fly', until: 0, thrown: !arrive, resolvers: [resolve], pending: null, from: null, start: drone.pos.clone(), t0: t, look0: dest.cam.look.clone(), fov: dest.cam.fov, fromY: gY + 40 }
      if (!arrive) { rig.root.visible = true; gpos.copy(nodeTop(nodeSel)); gyaw = -0.35; nextAct = t + 2 + Math.random() * 3; standRig() }
    }),
    gooseTo: (i) => {
      if (i < 0 || i >= nodes.length) return
      nodeSel = i
      if (!rig.root.visible || arr.phase === 'ball' || arr.phase === 'getup') return
      act = null
      gpos.setY(gY)
      startRush(i, now())
    },
    project: (i) => {
      const p = nodePos(i).add(new THREE.Vector3(0, 1.7, 0)).project(camera)
      return [Math.round(((p.x + 1) / 2) * w), Math.round(((1 - p.y) / 2) * h)]
    },
    setWorld: (k) => { worldK = k },
    abduct: () => new Promise<void>((resolve) => {
      if (mode !== 'map') { resolve(); return }
      act = null
      rig.root.visible = true
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
      trailReset()
      setScale(WIN_SCALE)
      winCut = onCut
      winCutsDone = -1
      const names: PoseName[] = ['rohan', 'dio', 'giorno']
      winPose = names[Math.abs(seed) % names.length]
      homeSky(true)
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
