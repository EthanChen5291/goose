/**
 * The title movie: a little 3D world, rendered at game-pixel size.
 *
 * The reference clips are cozy low-poly scenes with a camera that drifts around
 * a posed character.  This is that, done so it stays pixel art: the scene is
 * rendered into a buffer the size of the pixel stage (≈384×216) with no
 * antialiasing, flat-stepped toon shading and hard shadows, and the stage shows
 * it at a whole-number scale.  Every pixel on screen is a game pixel.
 *
 * The goose is its own sprite made solid: each opaque pixel of a frame becomes a
 * voxel, thicker toward the middle of the body, so from the side it *is* the
 * sprite and from any other angle it is a chunky figurine of the same bird.
 * Frames swap on the beat the way they do in the game.
 *
 * The camera works in shots — hard cuts, each a slow orbit, dolly, crane or
 * track — and never stops moving inside one.
 *
 * The same world has three more jobs:
 *   · `zoomIn`   the menu is left behind: the camera slams in on the goose
 *   · `pose`     the goose grows a body — quickly, unremarked — and strikes a
 *                JoJo pose, held for two seconds under floating ド ド ド
 *   · `winShow`  the fight is won: the muscled goose shown off in cut-ins,
 *                boots, bicep, face, the way a fighting game does
 * The body is a jointed rig of boxes in the goose's four colours with the
 * sprite's own head on top: still the duck, with pecs.
 */
import * as THREE from 'three'
import type { Manifest } from '../px/assets'

export type PoseName = 'rohan' | 'dio' | 'giorno'

export interface GooseMovie {
  el: HTMLCanvasElement
  resize: (w: number, h: number) => void
  stop: () => void
  /** the camera leaves the shots and slams in on the goose; resolves when it is there */
  zoomIn: (secs?: number) => Promise<void>
  /** grow the body and strike `name`; resolves after the hold */
  pose: (name: PoseName, holdSecs?: number) => Promise<void>
  /** the victory cut-ins; `onCut(i)` fires on each cut (0 boots, 1 bicep, 2 face) */
  winShow: (onCut: (i: number) => void) => Promise<void>
  /** back to the wandering shots */
  wander: () => void
  /**
   * The world map: the camera flies up over the path and `count` level nodes
   * stand along it; `done[i]` plants a flag; the goose stands on `selected`.
   */
  map: (count: number, selected: number, done: boolean[]) => void
  /** move the goose to node `i` (a hop along the path) */
  gooseTo: (i: number) => void
  /** where node `i` is on the screen, in game pixels */
  project: (i: number) => [number, number]
  /** the world's light: 0 noon · 1 dusk · 2 night · 3 storm · 4 dawn */
  setWorld: (k: number) => void
}

const FEET = 32
const BPM = 120

// ── palette ─────────────────────────────────────────────────────────────────
const SKY = 0x9ad4ff
const HORIZON = 0xd9eeff
const GRASS = [0x6cbf4a, 0x62b344, 0x78c953, 0x5aa83e]
const DIRT = 0xb08a5a
const WATER = 0x5fb4e6
const TRUNK = 0x8a5a36
const LEAF = [0x3f8f3a, 0x4ea546, 0x5fb84f]
const STONE = [0x9a9ea8, 0xb4b8c0]
const PETALS = [0xffb3d9, 0xffe27a, 0xffffff, 0xffa26b]
// the goose's own four
const G_WHITE = 0xebf0ef
const G_SHADE = 0xcfd6d5
const G_ORANGE = 0xecb187
const G_BROWN = 0xaa6738
const G_INK = 0x171818

// ── a small deterministic rng: the meadow is the same every time ────────────
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** flat-stepped lighting: three steps, like a pixel artist's shading */
function toonRamp(): THREE.DataTexture {
  const data = new Uint8Array([90, 150, 215, 255])
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

interface Voxel { x: number; y: number; half: number; color: number }

/** Read a strip's frames as RGBA pixel grids. */
async function readStrip(url: string, fw: number, fh: number, n: number): Promise<Uint8ClampedArray[]> {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const out: Uint8ClampedArray[] = []
  for (let i = 0; i < n; i++) out.push(ctx.getImageData(i * fw, 0, fw, fh).data)
  return out
}

/**
 * The sprite made solid.  Depth comes from how far a pixel is from the edge of
 * the silhouette: the outline is one voxel thin, the belly five thick.
 * `region` limits it to part of the frame (the head).
 */
function voxelize(px: Uint8ClampedArray, fw: number, fh: number,
                  region?: [number, number, number, number]): Voxel[] {
  const [rx0, ry0, rx1, ry1] = region ?? [0, 0, fw, fh]
  const solid = (x: number, y: number) => x >= rx0 && y >= ry0 && x < rx1 && y < ry1 && px[(y * fw + x) * 4 + 3] > 0
  const dist = new Int16Array(fw * fh).fill(-1)
  const q: number[] = []
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    if (!solid(x, y)) continue
    const edge = !solid(x + 1, y) || !solid(x - 1, y) || !solid(x, y + 1) || !solid(x, y - 1)
    if (edge) { dist[y * fw + x] = 1; q.push(x, y) }
  }
  for (let i = 0; i < q.length; i += 2) {
    const x = q[i], y = q[i + 1], d = dist[y * fw + x]
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (solid(nx, ny) && dist[ny * fw + nx] < 0) { dist[ny * fw + nx] = d + 1; q.push(nx, ny) }
    }
  }
  const out: Voxel[] = []
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    const d = dist[y * fw + x]
    if (d < 0) continue
    const o = (y * fw + x) * 4
    const color = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2]
    out.push({ x, y, half: Math.min(2.5, 0.5 + 0.5 * (d - 1)), color })
  }
  return out
}

function voxelMesh(vox: Voxel[], mat: THREE.Material, ox = 32, oy = FEET): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, vox.length))
  const m = new THREE.Matrix4()
  const col = new THREE.Color()
  vox.forEach((v, i) => {
    m.makeScale(1, 1, v.half * 2)
    m.setPosition(v.x - ox + 0.5, oy - v.y - 0.5, 0)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, col.setHex(v.color))
  })
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

// ── the meadow ──────────────────────────────────────────────────────────────
function box(w: number, h: number, d: number, color: number, mat: THREE.MeshToonMaterial): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat.clone())
  ;(m.material as THREE.MeshToonMaterial).color.setHex(color)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function buildMeadow(scene: THREE.Scene, base: THREE.MeshToonMaterial): { clouds: THREE.Group[]; petals: THREE.Mesh[]; flies: THREE.Group[]; fence: THREE.Group } {
  const r = rng(7)
  const N = 64
  const cells = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), base.clone(), N * N)
  cells.receiveShadow = true
  cells.castShadow = false
  const m = new THREE.Matrix4()
  const col = new THREE.Color()
  let i = 0
  const pond = (x: number, z: number) => ((x - 22) / 12) ** 2 + ((z + 10) / 8) ** 2 < 1
  const path = (x: number, z: number) => Math.abs(z - (6 + 5 * Math.sin(x / 14))) < 2.2 && x > -70
  for (let gx = 0; gx < N; gx++) for (let gz = 0; gz < N; gz++) {
    const x = (gx - N / 2) * 2 + 1, z = (gz - N / 2) * 2 + 1
    const d = Math.hypot(x, z)
    // flat under the goose, gentle steps further out
    let h = d < 9 ? 0 : Math.floor(Math.max(0, (r() * 1.6 + (d - 9) / 40)))
    let c: number
    if (pond(x, z)) { c = WATER; h = -1 }
    else if (path(x, z)) { c = DIRT; h = Math.min(h, 0) }
    else c = GRASS[Math.floor(r() * GRASS.length)]
    m.makeScale(1, 1 + h, 1)
    m.setPosition(x, -1 + h, z)
    cells.setMatrixAt(i, m)
    cells.setColorAt(i, col.setHex(c))
    i += 1
  }
  cells.instanceMatrix.needsUpdate = true
  if (cells.instanceColor) cells.instanceColor.needsUpdate = true
  scene.add(cells)

  // trees: a trunk and three tiers of leaves, blocky
  const trees = [[-30, -26], [-44, 4], [38, -32], [50, 10], [-18, -46], [30, 40], [-52, -30], [58, -12], [8, -54], [-40, 36]]
  for (const [x, z] of trees) {
    const g = new THREE.Group()
    const th = 7 + r() * 4
    const trunk = box(2, th, 2, TRUNK, base); trunk.position.y = th / 2
    g.add(trunk)
    const tiers = [[9, 4.5], [7, 4], [4.5, 3.5]]
    let y = th - 1
    tiers.forEach(([w, h], k) => {
      const leaf = box(w, h, w, LEAF[k], base)
      leaf.position.y = y + h / 2
      y += h - 0.5
      g.add(leaf)
    })
    g.position.set(x, 0, z)
    scene.add(g)
  }
  // rocks
  for (let k = 0; k < 14; k++) {
    const x = (r() - 0.5) * 110, z = (r() - 0.5) * 110
    if (Math.hypot(x, z) < 12) continue
    const s = 1.5 + r() * 3
    const rock = box(s * (0.8 + r() * 0.6), s * 0.7, s, STONE[k % 2], base)
    rock.position.set(x, s * 0.3, z)
    scene.add(rock)
  }
  // flowers: a stem and a head
  for (let k = 0; k < 90; k++) {
    const x = (r() - 0.5) * 100, z = (r() - 0.5) * 100
    if (Math.hypot(x, z) < 6 || pond(x, z) || path(x, z)) continue
    const g = new THREE.Group()
    const stem = box(0.4, 1.4, 0.4, 0x3f8f3a, base); stem.position.y = 0.7
    const head = box(1, 0.8, 1, PETALS[k % PETALS.length], base); head.position.y = 1.6
    g.add(stem, head)
    g.position.set(x, 0, z)
    scene.add(g)
  }
  // a fence along the path's far side (hidden for the close shots, where it would cut the frame)
  const fence = new THREE.Group()
  for (let x = -40; x <= 40; x += 6) {
    const z = 6 + 5 * Math.sin(x / 14) + 5
    const post = box(0.8, 4, 0.8, 0xc9a06b, base); post.position.set(x, 2, z)
    const rail = box(6, 0.6, 0.5, 0xc9a06b, base); rail.position.set(x + 3, 2.6, z + 0.3)
    rail.rotation.y = -Math.atan2(5 * (Math.cos((x + 6) / 14) / 14) * 6, 6)
    fence.add(post, rail)
  }
  scene.add(fence)
  // far hills, in the fog
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2
    const d = 150 + r() * 60
    const hill = new THREE.Mesh(new THREE.SphereGeometry(40 + r() * 40, 8, 6), base.clone())
    ;(hill.material as THREE.MeshToonMaterial).color.setHex(k % 2 ? 0x5f9f6e : 0x76b37a)
    hill.scale.y = 0.35 + r() * 0.2
    hill.position.set(Math.cos(a) * d, -6, Math.sin(a) * d)
    hill.receiveShadow = false
    scene.add(hill)
  }
  // clouds: white boxes in threes, drifting
  const clouds: THREE.Group[] = []
  for (let k = 0; k < 7; k++) {
    const g = new THREE.Group()
    const w = 8 + r() * 10
    const a = box(w, 3, 5, 0xffffff, base)
    const b = box(w * 0.6, 3, 4, 0xffffff, base); b.position.set(w * 0.3, 2, 0.5)
    const c = box(w * 0.5, 2.5, 4, 0xffffff, base); c.position.set(-w * 0.35, 1.5, -0.5)
    for (const p of [a, b, c]) { p.castShadow = false; p.receiveShadow = false }
    g.add(a, b, c)
    g.position.set((r() - 0.5) * 220, 34 + r() * 14, (r() - 0.5) * 220)
    scene.add(g)
    clouds.push(g)
  }
  // petals on the wind
  const petals: THREE.Mesh[] = []
  for (let k = 0; k < 24; k++) {
    const p = box(0.6, 0.2, 0.6, PETALS[k % PETALS.length], base)
    p.castShadow = false
    p.position.set((r() - 0.5) * 60, r() * 20, (r() - 0.5) * 60)
    p.userData.phase = r() * 7
    scene.add(p)
    petals.push(p)
  }
  // butterflies: two wings that flap
  const flies: THREE.Group[] = []
  for (let k = 0; k < 4; k++) {
    const g = new THREE.Group()
    const l = box(1, 0.15, 1.2, PETALS[(k + 1) % PETALS.length], base); l.position.x = -0.5
    const rw = box(1, 0.15, 1.2, PETALS[(k + 1) % PETALS.length], base); rw.position.x = 0.5
    l.castShadow = rw.castShadow = false
    g.add(l, rw)
    g.userData = { phase: r() * 7, cx: (r() - 0.5) * 40, cz: (r() - 0.5) * 40, r: 6 + r() * 8 }
    scene.add(g)
    flies.push(g)
  }
  return { clouds, petals, flies, fence }
}

// ── the hero: a body for the goose ──────────────────────────────────────────
/**
 * A jointed rig of boxes.  Facing +x like the sprite.  Joints are Groups whose
 * rotation is the pose; limbs hang from them.  Sizes are goose units (the
 * sprite is 64 wide), scaled with the goose.  The proportions are a fighting
 * game's: a wide chest, a narrow waist, a bicep on every arm.
 */
interface Rig {
  root: THREE.Group
  spine: THREE.Group
  neck: THREE.Group
  shoulder: [THREE.Group, THREE.Group]
  elbow: [THREE.Group, THREE.Group]
  wrist: [THREE.Group, THREE.Group]
  hip: [THREE.Group, THREE.Group]
  knee: [THREE.Group, THREE.Group]
  face: THREE.Group
}

function buildHero(base: THREE.MeshToonMaterial, headVox: Voxel[], headMat: THREE.Material): Rig {
  const root = new THREE.Group()
  const part = (w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0): THREE.Mesh => {
    const m = box(w, h, d, c, base)
    m.position.set(x, y, z)
    return m
  }
  // legs: hip at y 15, knee at y 8, boots on the ground
  const hips: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const knees: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  hips.forEach((hip, i) => {
    const side = i === 0 ? -1 : 1
    hip.position.set(0, 15, side * 2.6)
    hip.add(part(3.2, 7, 3.2, G_WHITE, 0, -3.5, 0))           // thigh
    const knee = knees[i]
    knee.position.set(0, -7, 0)
    knee.add(part(2.6, 6.5, 2.6, G_WHITE, 0, -3.2, 0))        // shin
    knee.add(part(4.6, 2.2, 3.4, G_ORANGE, 0.8, -7.6, 0))     // the boot: a goose foot, big
    knee.add(part(2.2, 1, 1.2, G_BROWN, 2.6, -8.2, 0.9))      // toes
    knee.add(part(2.2, 1, 1.2, G_BROWN, 2.6, -8.2, -0.9))
    hip.add(knee)
    root.add(hip)
  })
  // torso hangs from the spine joint at the pelvis
  const spine = new THREE.Group()
  spine.position.set(0, 15.5, 0)
  spine.add(part(6, 4, 7, G_WHITE, 0, 1.5, 0))                 // pelvis / waist
  spine.add(part(7, 9, 9, G_WHITE, 0, 8, 0))                   // chest
  spine.add(part(2.6, 3.2, 3.6, G_WHITE, 3.2, 9.8, 2.2))       // pecs
  spine.add(part(2.6, 3.2, 3.6, G_WHITE, 3.2, 9.8, -2.2))
  for (let r = 0; r < 3; r++) {                                 // abs
    spine.add(part(0.8, 1.6, 1.6, G_SHADE, 3.6, 6.6 - r * 1.9, 1.1))
    spine.add(part(0.8, 1.6, 1.6, G_SHADE, 3.6, 6.6 - r * 1.9, -1.1))
  }
  spine.add(part(8, 3, 12, G_WHITE, 0, 12, 0))                 // shoulders, wide
  // arms
  const shoulders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const elbows: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const wrists: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  shoulders.forEach((sh, i) => {
    const side = i === 0 ? -1 : 1
    sh.position.set(0, 12, side * 6.6)
    sh.add(part(3.2, 3.2, 3.2, G_WHITE, 0, 0, 0))               // deltoid
    sh.add(part(3.6, 6, 3.6, G_WHITE, 0, -3.2, 0))              // upper arm
    sh.add(part(4.4, 3.4, 4.2, G_WHITE, 0.6, -3.2, 0))          // the bicep
    const el = elbows[i]
    el.position.set(0, -6.4, 0)
    el.add(part(2.8, 6, 2.8, G_WHITE, 0, -3, 0))                // forearm
    const wr = wrists[i]
    wr.position.set(0, -6, 0)
    wr.add(part(2.4, 2.6, 2.2, G_ORANGE, 0.3, -1.2, 0))         // hand: goose orange
    el.add(wr)
    sh.add(el)
    spine.add(sh)
  })
  // neck and the sprite's own head on top
  const neck = new THREE.Group()
  neck.position.set(1.5, 13.4, 0)
  neck.add(part(2.6, 3.2, 2.6, G_WHITE, 0, 1.4, 0))
  const head = new THREE.Group()
  const headMesh = voxelMesh(headVox, headMat, 40, 14)          // head pixels, centred on the head, feet at row 14
  headMesh.scale.setScalar(0.5)
  head.position.set(0.6, 3.2, 0)
  head.add(headMesh)
  // the JoJo face: brows down hard over the eye, a shadow under it — shown only in pose
  // (the eye is sprite pixel (40, 7): head-local x ≈ 0.25, y ≈ 3.25; the head is ~1.2 thick)
  const face = new THREE.Group()
  face.add(part(1.8, 0.45, 0.4, G_INK, 0.9, 4.1, 1.2))          // the brow, down hard toward the beak
  face.add(part(1.4, 0.45, 0.4, G_INK, 0.5, 3.9, -1.2))
  face.add(part(1.2, 0.35, 0.4, G_INK, 0.8, 2.5, 1.25))         // the cheek line
  face.visible = false
  head.add(face)
  neck.add(head)
  spine.add(neck)
  root.add(spine)
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = false } })
  return { root, spine, neck, shoulder: shoulders, elbow: elbows, wrist: wrists, hip: hips, knee: knees, face }
}

/** a pose: rotations (radians) per joint, x/y/z each; unspecified stays at rest */
type J = [number, number, number]
interface Pose {
  spine?: J; neck?: J
  shoulder?: [J, J]; elbow?: [J, J]; wrist?: [J, J]
  hip?: [J, J]; knee?: [J, J]
  /** whole-body lean and lift */
  lean?: number; lift?: number
}
const REST: Pose = {}
const POSES: Record<PoseName | 'flex' | 'neutral', Pose> = {
  neutral: REST,
  // Rohan: one arm arched over the head with the hand hanging by the temple, the
  // other straight down with the wrist flared out; hips pushed, body leaning back
  rohan: {
    spine: [0, 0.15, -0.22], neck: [0, 0, 0.35],
    shoulder: [[0, 0, 0.25], [-0.3, 0, 2.9]], elbow: [[0, 0, 0.1], [0, 0, 1.9]], wrist: [[0, 0, -0.9], [0, 0, 0.8]],
    hip: [[0.15, 0, 0.1], [-0.25, 0, -0.05]], knee: [[0, 0, 0], [0.3, 0, 0]],
    lean: -0.12,
  },
  // Dio: two fingers to the temple, the other arm bent across the waist, torso
  // twisted and leaning far back, one leg forward
  dio: {
    spine: [0.35, 0.45, -0.42], neck: [0, -0.3, 0.2],
    shoulder: [[0, 0, -0.9], [-0.9, 0.3, 2.3]], elbow: [[0, 0, -1.9], [0, 0, 2.2]], wrist: [[0, 0, 0.3], [0, 0, 0.4]],
    hip: [[0.55, 0, 0], [-0.35, 0, 0]], knee: [[-0.2, 0, 0], [0.5, 0, 0]],
    lean: -0.2,
  },
  // Giorno: feet apart, chest out, hands turned out at the hips, chin up
  giorno: {
    spine: [0, 0.1, -0.1], neck: [0, 0, -0.25],
    shoulder: [[0, 0, 0.5], [0, 0, -0.5]], elbow: [[0, 0, -1.1], [0, 0, 1.1]], wrist: [[0, 0, -1.2], [0, 0, 1.2]],
    hip: [[0, 0, 0.35], [0, 0, -0.35]], knee: [[0, 0, 0], [0, 0, 0]],
  },
  // the victory flex: both arms up and bent, chin down toward the bicep
  flex: {
    spine: [0, 0.2, 0], neck: [0, 0.6, 0.2],
    shoulder: [[0, 0, -2.6], [0, 0, 2.6]], elbow: [[0, 0, 2.2], [0, 0, -2.2]], wrist: [[0, 0, 0.4], [0, 0, -0.4]],
    hip: [[0, 0, 0.25], [0, 0, -0.25]],
  },
}

function applyPose(rig: Rig, p: Pose, k = 1): void {
  const set = (g: THREE.Group, j?: J) => { const r = j ?? [0, 0, 0]; g.rotation.set(r[0] * k, r[1] * k, r[2] * k) }
  set(rig.spine, p.spine); set(rig.neck, p.neck)
  for (let i = 0; i < 2; i++) {
    set(rig.shoulder[i], p.shoulder?.[i]); set(rig.elbow[i], p.elbow?.[i]); set(rig.wrist[i], p.wrist?.[i])
    set(rig.hip[i], p.hip?.[i]); set(rig.knee[i], p.knee?.[i])
  }
  rig.root.rotation.z = (p.lean ?? 0) * k
  rig.root.position.y = (p.lift ?? 0) * k
}

// ── the shots ───────────────────────────────────────────────────────────────
interface Shot { secs: number; at: (u: number, out: THREE.Vector3) => void; look: (u: number, out: THREE.Vector3) => void; pose: string }
const smooth = (u: number) => u * u * (3 - 2 * u)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
/** the goose stands about 11 units tall (a tree is 18); the shots frame that */
const GOOSE_SCALE = 0.4
/** the hero rig is 39 goose units tall; at this it stands a head over the bird */
const HERO_SCALE = 0.26
/** the light of each world on the map: sky, fog, sky light, sun */
const WORLDS: [number, number, number, number][] = [
  [SKY, HORIZON, 0xbfe3ff, 0xfff1d6],
  [0xf5b07a, 0xffd9b0, 0xffc9a0, 0xffb070],
  [0x1c2340, 0x2c3660, 0x6d7cc0, 0x9aa8ff],
  [0x5d6a78, 0x8c98a6, 0xaab6c4, 0xd8dee6],
  [0xf8c8d8, 0xffe6ee, 0xffd6e2, 0xffe0c0],
]
/** the calm light behind the pose and the cut-ins: a deep blue dusk, not purple */
const DUSK: [number, number, number, number] = [0x22304a, 0x4a5f86, 0x8fa8e0, 0xffb888]
const MAP_CAM = new THREE.Vector3(0, 38, 50)
const MAP_LOOK = new THREE.Vector3(0, 0, 5)
const pathZ = (x: number) => 6 + 5 * Math.sin(x / 14)
const SHOTS: Shot[] = [
  { // the slow orbit, side to three-quarter
    secs: 9, pose: 'idle',
    at: (u, o) => { const a = lerp(-0.55, 0.35, smooth(u)); const r = lerp(34, 29, u); o.set(Math.sin(a) * r, lerp(9, 7, u), Math.cos(a) * r) },
    look: (_u, o) => o.set(2, 5.5, 0),
  },
  { // the hero shot: low and close, pushing in
    secs: 7, pose: 'cheer',
    at: (u, o) => { const k = smooth(u); o.set(lerp(30, 20, k), lerp(2.5, 3.5, k), lerp(36, 26, k)) },
    look: (_u, o) => o.set(0, 6, 0),
  },
  { // the crane: from above, coming down
    secs: 8, pose: 'idle',
    at: (u, o) => { const k = smooth(u); o.set(lerp(-14, -7, k), lerp(26, 10, k), lerp(32, 22, k)) },
    look: (u, o) => o.set(0, lerp(2, 5, smooth(u)), 0),
  },
  { // the track: a pan across the meadow, the goose passing through
    secs: 8, pose: 'honk',
    at: (u, o) => o.set(lerp(-30, 26, u), 8, 34),
    look: (u, o) => o.set(lerp(-10, 9, u), 5, 0),
  },
  { // the establishing wide, drifting in
    secs: 9, pose: 'idle',
    at: (u, o) => { const k = smooth(u); o.set(lerp(46, 36, k), lerp(16, 12, k), lerp(50, 40, k)) },
    look: (_u, o) => o.set(0, 4, 0),
  },
]

/** the ド / ゴ that hang in the air around a pose: flat quads with the baked glyph, nearest-sampled */
async function menacingSprites(manifest: Manifest): Promise<THREE.Mesh[]> {
  const out: THREE.Mesh[] = []
  const loader = new THREE.TextureLoader()
  for (const [name, x, y, z, s] of [['k48_do', 6, 12, 7, 5], ['k48_go', -7, 16, 6, 4.5], ['k48_do', 8, 4, -6, 4],
                                     ['k48_do', -8, 6, -8, 5.5], ['k48_go', 3, 20, -5, 4], ['k48_do', -4, 2, 9, 3.5]] as [string, number, number, number, number][]) {
    const u = manifest.ui[name]
    if (!u) continue
    const tex = await loader.loadAsync(u.url)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: 0xffb347, alphaTest: 0.5, side: THREE.DoubleSide })
    const back = new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: 0x1a0a20, alphaTest: 0.5, side: THREE.DoubleSide })
    const g = new THREE.Mesh(new THREE.PlaneGeometry(s * (u.w / u.h), s), mat)
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(s * (u.w / u.h), s), back)
    shadow.position.set(0.25, -0.25, -0.05)
    g.add(shadow)
    g.position.set(x, y, z)
    g.userData.base = [x, y, z]
    g.userData.phase = Math.random() * 7
    g.visible = false
    out.push(g)
  }
  return out
}

export async function gooseMovie(manifest: Manifest): Promise<GooseMovie> {
  const g = manifest.chars.goose
  const strips: Record<string, Uint8ClampedArray[]> = {}
  for (const name of ['idle', 'cheer', 'honk']) {
    const a = g.anims[name]
    if (a) strips[name] = await readStrip(a.url, a.fw, a.fh, a.n)
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'px-movie'
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.BasicShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY)
  scene.fog = new THREE.Fog(HORIZON, 110, 260)

  const ramp = toonRamp()
  const base = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp })
  const base0 = base

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4)
  sun.position.set(40, 60, 30)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 200
  sun.shadow.bias = -0.002
  scene.add(sun, sun.target)
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x5f8f3a, 1.1)
  scene.add(hemi)

  const { clouds, petals, flies, fence } = buildMeadow(scene, base)

  // the goose: one mesh per frame, one visible at a time
  const gooseMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp })
  const frames: Record<string, THREE.InstancedMesh[]> = {}
  const gooseRoot = new THREE.Group()
  for (const [name, px] of Object.entries(strips)) {
    frames[name] = px.map((p) => {
      const mesh = voxelMesh(voxelize(p, g.fw, g.fh), gooseMat)
      mesh.visible = false
      gooseRoot.add(mesh)
      return mesh
    })
  }
  gooseRoot.scale.setScalar(GOOSE_SCALE)
  // the sprite faces +x; turn it a little toward the default camera
  gooseRoot.rotation.y = -0.35
  scene.add(gooseRoot)

  // the hero body, hidden until a pose asks for it; the head is the idle frame's
  const headVox = strips.idle ? voxelize(strips.idle[0], g.fw, g.fh, [30, 0, 50, 14]) : []
  const rig = buildHero(base, headVox, gooseMat)
  rig.root.scale.setScalar(HERO_SCALE)
  rig.root.rotation.y = -0.35
  rig.root.visible = false
  scene.add(rig.root)
  const menacing = await menacingSprites(manifest)
  for (const m of menacing) scene.add(m)

  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 400)
  const at = new THREE.Vector3(), look = new THREE.Vector3()

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
  const total = SHOTS.reduce((a, s) => a + s.secs, 0)
  let raf = 0
  let shown: THREE.InstancedMesh | null = null
  const show = (mesh: THREE.InstancedMesh | undefined): void => {
    if (!mesh || mesh === shown) return
    if (shown) shown.visible = false
    mesh.visible = true
    shown = mesh
  }

  // ── the modes ─────────────────────────────────────────────────────────────
  type Mode = 'shots' | 'zoom' | 'pose' | 'win' | 'tomap' | 'map'
  let mapFrom = new THREE.Vector3(), mapLookFrom = new THREE.Vector3()
  let mode: Mode = 'shots'
  let modeT0 = 0
  let zoomFrom = new THREE.Vector3(), zoomLook = new THREE.Vector3(), zoomSecs = 0.55
  let poseName: PoseName = 'rohan'
  let poseHold = 2
  let winCut = (_i: number) => {}
  let winCutsDone = -1
  const now = () => (performance.now() - t0) / 1000

  const paint = (p: [number, number, number, number]): void => {
    ;(scene.background as THREE.Color).setHex(p[0])
    ;(scene.fog as THREE.Fog).color.setHex(p[1])
    hemi.color.setHex(p[2])
    sun.color.setHex(p[3])
  }
  let worldK = 0
  const setSky = (dusk: boolean): void => paint(dusk ? DUSK : WORLDS[worldK % WORLDS.length])

  // ── the map: nodes along the path, the goose on one of them ─────────────
  const nodeRoot = new THREE.Group()
  scene.add(nodeRoot)
  let nodes: THREE.Group[] = []
  let nodeSel = 0
  let gooseFrom = new THREE.Vector3(), gooseToV = new THREE.Vector3(), gooseMoveT0 = -9
  const nodePos = (i: number, n: number): THREE.Vector3 => {
    const x = n <= 1 ? 0 : -27 + (54 * i) / (n - 1)
    return new THREE.Vector3(x, 0, pathZ(x))
  }
  const buildNodes = (count: number, done: boolean[]): void => {
    for (const n of nodes) nodeRoot.remove(n)
    nodes = []
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group()
      const p = nodePos(i, count)
      const base = box(6.4, 1.0, 6.4, 0x3e404c, base0); base.position.y = 0.5
      const top = box(5.2, 0.6, 5.2, done[i] ? 0xffde7b : 0xc9cee0, base0); top.position.y = 1.3
      g.add(base, top)
      if (done[i]) {
        const pole = box(0.4, 5.5, 0.4, 0xd8dce8, base0); pole.position.set(2.4, 3.5, -2.2)
        const flag = box(2.4, 1.4, 0.3, 0xff8a5a, base0); flag.position.set(3.7, 5.6, -2.2)
        g.add(pole, flag)
      }
      g.position.copy(p)
      g.userData.top = top
      nodeRoot.add(g)
      nodes.push(g)
    }
  }
  const placeGoose = (i: number): void => {
    const p = nodePos(i, Math.max(1, nodes.length))
    gooseRoot.position.set(p.x, 1.6, p.z)
    gooseRoot.rotation.y = -0.35
  }

  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const t = now()
    const beat = Math.floor(t * (BPM / 60))
    const phase = (t * (BPM / 60)) % 1

    if (mode === 'shots') {
      // which shot, and how far through it
      let local = t % total
      let shot = SHOTS[0]
      for (const s of SHOTS) { if (local < s.secs) { shot = s; break } local -= s.secs }
      const u = local / shot.secs
      shot.at(u, at); shot.look(u, look)
      camera.position.copy(at)
      camera.lookAt(look)
      // the pose: the idle bobs on the beat; the shot's pose plays on bar one of each four
      const bar = Math.floor(beat / 4)
      const poseFrames = frames[shot.pose] ?? frames.idle
      if (shot.pose !== 'idle' && bar % 2 === 1 && poseFrames) {
        show(poseFrames[Math.min(poseFrames.length - 1, beat % 4 < 2 ? beat % 2 : poseFrames.length - 1)])
      } else show(frames.idle?.[beat % 2])
      gooseRoot.position.y = beat % 4 === 0 && phase < 0.25 ? 1 : 0
    } else if (mode === 'tomap' || mode === 'map') {
      // up and over the path: a smooth flight, then a very slow drift
      const u = mode === 'tomap' ? Math.min(1, (t - modeT0) / 0.8) : 1
      const k = smooth(u)
      const drift = mode === 'map' ? Math.sin(t * 0.25) * 1.5 : 0
      camera.position.lerpVectors(mapFrom, MAP_CAM, k)
      camera.position.x += drift * k
      look.lerpVectors(mapLookFrom, MAP_LOOK, k)
      camera.lookAt(look)
      if (u >= 1 && mode === 'tomap') mode = 'map'
      show(frames.idle?.[beat % 2])
      // the goose hops between nodes in three steps
      if (gooseMoveT0 >= 0) {
        const m = Math.min(1, (t - gooseMoveT0) / 0.3)
        const st = Math.floor(m * 3) / 3
        gooseRoot.position.lerpVectors(gooseFrom, gooseToV, st)
        gooseRoot.position.y = 1.6 + (st > 0 && st < 1 ? 1.5 : 0)
        if (m >= 1) gooseMoveT0 = -9
      }
      // the chosen node breathes
      nodes.forEach((n, i) => {
        const top = n.userData.top as THREE.Mesh
        top.position.y = i === nodeSel && phase < 0.5 ? 1.7 : 1.3
      })
    } else if (mode === 'zoom') {
      // the slam in: from where the shot left the camera to right in front of the goose
      const u = Math.min(1, (t - modeT0) / zoomSecs)
      const k = u * u * u   // late and hard, like a crash zoom
      const gp = gooseRoot.position
      const to = new THREE.Vector3(gp.x + 9, gp.y + 5.5, gp.z + 12)
      camera.position.lerpVectors(zoomFrom, to, k)
      look.lerpVectors(zoomLook, new THREE.Vector3(gp.x, gp.y + 6, gp.z), k)
      camera.lookAt(look)
      show(frames.idle?.[beat % 2])
      gooseRoot.position.y = 0
    } else if (mode === 'pose') {
      const age = t - modeT0
      // the body: the sprite drops away in three steps and the rig grows in three — 0.3 s, unremarked
      rig.root.position.x = gooseRoot.position.x
      rig.root.position.z = gooseRoot.position.z
      if (age < 0.3) {
        const s = age < 0.1 ? 1 : age < 0.2 ? 0.5 : 0.15
        gooseRoot.scale.set(GOOSE_SCALE, GOOSE_SCALE * s, GOOSE_SCALE)
        gooseRoot.visible = age < 0.24
        rig.root.visible = age >= 0.1
        const rs = age < 0.2 ? 0.45 : 0.8
        rig.root.scale.setScalar(HERO_SCALE * rs)
        applyPose(rig, POSES.neutral)
        rig.face.visible = false
      } else {
        gooseRoot.visible = false
        rig.root.visible = true
        rig.root.scale.setScalar(HERO_SCALE)
        // into the pose in three snaps over a quarter second, then held
        const k = age < 0.38 ? 0.35 : age < 0.46 ? 0.7 : 1
        applyPose(rig, POSES[poseName], k)
        rig.face.visible = k === 1
        // a breath: the chest lifts a hair on the beat while held
        rig.root.position.y = gooseRoot.position.y - 1.6 + (POSES[poseName].lift ?? 0) + (phase < 0.5 ? 0.15 : 0)
      }
      // the camera: a slow push, a hair of orbit — the menacing shot
      const u = Math.min(1, age / (0.5 + poseHold))
      const a = -0.25 + 0.12 * u
      const r = lerp(17, 13.5, u)
      const gp = gooseRoot.position
      camera.position.set(gp.x + Math.sin(a) * r + 3, gp.y - 1.6 + lerp(5, 5.8, u), gp.z + Math.cos(a) * r)
      camera.lookAt(gp.x + 0.5, gp.y - 1.6 + 5, gp.z)
      // ド ド ド around the goose, once the pose lands: drifting up a step at a time
      for (const m of menacing) {
        m.visible = age > 0.46
        const b = m.userData.base as [number, number, number]
        const ph = m.userData.phase as number
        const step = Math.floor((age + ph) * 6)
        m.position.set(gp.x + b[0] + ((step % 3) - 1) * 0.3, gp.y - 1.6 + b[1] + Math.floor(age * 2) * 0.5 - 1 + (step % 2) * 0.25, gp.z + b[2])
        m.lookAt(camera.position)
      }
    } else if (mode === 'win') {
      const age = t - modeT0
      gooseRoot.visible = false
      rig.root.visible = true
      rig.root.scale.setScalar(HERO_SCALE)
      applyPose(rig, POSES.flex)
      rig.face.visible = true
      rig.root.position.set(0, phase < 0.5 ? 0.1 : 0, 0)
      // three cut-ins, hard cuts, each pushing in a little: boots · bicep · face
      const cuts = [0, 1.1, 2.3]
      let i = 0
      while (i + 1 < cuts.length && age >= cuts[i + 1]) i += 1
      const u = Math.min(1, (age - cuts[i]) / 1.1)
      if (i !== winCutsDone) { winCutsDone = i; winCut(i) }
      if (i === 0) { camera.position.set(lerp(6.5, 5.6, u), 0.9, lerp(4.6, 4, u)); camera.lookAt(0.8, 1.2, 0) }
      else if (i === 1) { camera.position.set(lerp(6.6, 5.6, u), 8.2, lerp(6.4, 5.4, u)); camera.lookAt(0.3, 7.2, 1.4) }
      else { camera.position.set(lerp(6.4, 5.6, u), 9.7, lerp(2.4, 1.9, u)); camera.lookAt(0.7, 9.2, 0) }
      for (const m of menacing) m.visible = false
    }

    nodeRoot.visible = mode === 'map' || mode === 'tomap' || mode === 'zoom'
    fence.visible = mode !== 'pose' && mode !== 'win'
    for (const c of clouds) { c.position.x += 0.02; if (c.position.x > 130) c.position.x = -130 }
    for (const p of petals) {
      const ph = p.userData.phase as number
      p.position.y -= 0.03
      p.position.x += Math.sin(t * 1.3 + ph) * 0.04 + 0.02
      p.rotation.y = t + ph
      if (p.position.y < 0) { p.position.y = 18 + Math.random() * 6; p.position.x = (Math.random() - 0.5) * 60; p.position.z = (Math.random() - 0.5) * 60 }
    }
    for (const f of flies) {
      const d = f.userData as { phase: number; cx: number; cz: number; r: number }
      const a = t * 0.5 + d.phase
      f.position.set(d.cx + Math.cos(a) * d.r, 5 + Math.sin(t * 2 + d.phase) * 1.5, d.cz + Math.sin(a) * d.r)
      f.rotation.y = -a
      const flap = Math.sin(t * 14 + d.phase) * 0.9
      f.children[0].rotation.z = flap
      f.children[1].rotation.z = -flap
    }
    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(tick)

  const wait = (secs: number) => new Promise<void>((r) => window.setTimeout(r, secs * 1000))

  return {
    el: canvas,
    resize,
    zoomIn: async (secs = 0.55) => {
      zoomFrom = camera.position.clone()
      zoomLook = look.clone()
      zoomSecs = secs
      mode = 'zoom'
      modeT0 = now()
      await wait(secs)
    },
    pose: async (name, holdSecs = 2) => {
      poseName = name
      poseHold = holdSecs
      setSky(true)
      mode = 'pose'
      modeT0 = now()
      await wait(0.5 + holdSecs)
    },
    winShow: async (onCut) => {
      winCut = onCut
      winCutsDone = -1
      setSky(true)
      mode = 'win'
      modeT0 = now()
      await wait(4.6)
    },
    wander: () => {
      mode = 'shots'
      worldK = 0
      setSky(false)
      gooseRoot.visible = true
      gooseRoot.scale.setScalar(GOOSE_SCALE)
      gooseRoot.position.set(0, 0, 0)
      rig.root.visible = false
      for (const m of menacing) m.visible = false
    },
    map: (count, selected, done) => {
      buildNodes(count, done)
      nodeSel = selected
      gooseRoot.visible = true
      gooseRoot.scale.setScalar(GOOSE_SCALE)
      rig.root.visible = false
      for (const m of menacing) m.visible = false
      placeGoose(selected)
      gooseMoveT0 = -9
      if (mode !== 'map' && mode !== 'tomap') {
        mapFrom = camera.position.clone()
        mapLookFrom = look.clone()
        mode = 'tomap'
        modeT0 = now()
      }
    },
    gooseTo: (i) => {
      nodeSel = i
      gooseFrom = gooseRoot.position.clone()
      gooseToV = nodePos(i, Math.max(1, nodes.length)).setY(1.6)
      gooseMoveT0 = now()
    },
    project: (i) => {
      const p = nodePos(i, Math.max(1, nodes.length)).add(new THREE.Vector3(0, 1.7, 0)).project(camera)
      return [Math.round(((p.x + 1) / 2) * w), Math.round(((1 - p.y) / 2) * h)]
    },
    setWorld: (k) => { worldK = k; setSky(false) },
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
