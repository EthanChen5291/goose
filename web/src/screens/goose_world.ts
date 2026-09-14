/**
 * The set: the meadow, the props, and the muscled hero rig for the win show.
 *
 * Everything here is boxes in flat toon shading, built once.  The meadow is
 * the same one the game has always had (a deterministic rng, so it is the same
 * every time).  The props are new for the menu and the level select: the
 * floating plates the menu buttons stand on, the round stones of the world
 * map, a flying saucer with a beam, and a pair of slapstick gloves.
 */
import * as THREE from 'three'
import type { Manifest } from '../px/assets'
import { G_WHITE, G_SHADE, G_ORANGE, G_BROWN, G_INK } from './goose_rig'

export const FEET = 32

// ── palette ─────────────────────────────────────────────────────────────────
export const SKY = 0x9ad4ff
export const HORIZON = 0xd9eeff
const GRASS = [0x6cbf4a, 0x62b344, 0x78c953, 0x5aa83e]
const DIRT = 0xb08a5a
const WATER = 0x5fb4e6
const TRUNK = 0x8a5a36
const LEAF = [0x3f8f3a, 0x4ea546, 0x5fb84f]
const STONE = [0x9a9ea8, 0xb4b8c0]
const PETALS = [0xffb3d9, 0xffe27a, 0xffffff, 0xffa26b]

/** the light of each world on the map: sky, fog, sky light, sun */
export const WORLDS: [number, number, number, number][] = [
  [SKY, HORIZON, 0xbfe3ff, 0xfff1d6],
  [0xf5b07a, 0xffd9b0, 0xffc9a0, 0xffb070],
  [0x1c2340, 0x2c3660, 0x6d7cc0, 0x9aa8ff],
  [0x5d6a78, 0x8c98a6, 0xaab6c4, 0xd8dee6],
  [0xf8c8d8, 0xffe6ee, 0xffd6e2, 0xffe0c0],
]
/** the calm light behind the cut-ins: a deep blue dusk, not purple */
export const DUSK: [number, number, number, number] = [0x22304a, 0x4a5f86, 0x8fa8e0, 0xffb888]

export const pathZ = (x: number): number => 6 + 5 * Math.sin(x / 14)

// ── a small deterministic rng: the meadow is the same every time ────────────
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** flat-stepped lighting: three steps, like a pixel artist's shading */
export function toonRamp(): THREE.DataTexture {
  const data = new Uint8Array([90, 150, 215, 255])
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export interface Voxel { x: number; y: number; half: number; color: number }

/** Read a strip's frames as RGBA pixel grids. */
export async function readStrip(url: string, fw: number, fh: number, n: number): Promise<Uint8ClampedArray[]> {
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

/** one frame as a nearest-sampled texture: the flat goose */
export function frameTexture(px: Uint8ClampedArray, fw: number, fh: number): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = fw; c.height = fh
  const ctx = c.getContext('2d')!
  const img = new ImageData(new Uint8ClampedArray(px), fw, fh)
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * The sprite made solid.  Depth comes from how far a pixel is from the edge of
 * the silhouette: the outline is one voxel thin, the belly five thick.
 * `region` limits it to part of the frame (the head).
 */
export function voxelize(px: Uint8ClampedArray, fw: number, fh: number,
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

export function voxelMesh(vox: Voxel[], mat: THREE.Material, ox = 32, oy = FEET): THREE.InstancedMesh {
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
export function box(w: number, h: number, d: number, color: number, mat: THREE.MeshToonMaterial): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat.clone())
  ;(m.material as THREE.MeshToonMaterial).color.setHex(color)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

export interface Meadow { clouds: THREE.Group[]; petals: THREE.Mesh[]; flies: THREE.Group[]; fence: THREE.Group }

export function buildMeadow(scene: THREE.Scene, base: THREE.MeshToonMaterial): Meadow {
  const r = rng(7)
  const N = 64
  const cells = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), base.clone(), N * N)
  cells.receiveShadow = true
  cells.castShadow = false
  const m = new THREE.Matrix4()
  const col = new THREE.Color()
  let i = 0
  const pond = (x: number, z: number) => ((x - 22) / 12) ** 2 + ((z + 10) / 8) ** 2 < 1
  const path = (x: number, z: number) => Math.abs(z - pathZ(x)) < 2.2 && x > -70
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
    const z = pathZ(x) + 5
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

/** the living parts of the meadow, one frame on */
export function driftMeadow(md: Meadow, t: number): void {
  for (const c of md.clouds) { c.position.x += 0.02; if (c.position.x > 130) c.position.x = -130 }
  for (const p of md.petals) {
    const ph = p.userData.phase as number
    p.position.y -= 0.03
    p.position.x += Math.sin(t * 1.3 + ph) * 0.04 + 0.02
    p.rotation.y = t + ph
    if (p.position.y < 0) { p.position.y = 18 + Math.random() * 6; p.position.x = (Math.random() - 0.5) * 60; p.position.z = (Math.random() - 0.5) * 60 }
  }
  for (const f of md.flies) {
    const d = f.userData as { phase: number; cx: number; cz: number; r: number }
    const a = t * 0.5 + d.phase
    f.position.set(d.cx + Math.cos(a) * d.r, 5 + Math.sin(t * 2 + d.phase) * 1.5, d.cz + Math.sin(a) * d.r)
    f.rotation.y = -a
    const flap = Math.sin(t * 14 + d.phase) * 0.9
    f.children[0].rotation.z = flap
    f.children[1].rotation.z = -flap
  }
}

// ── props ───────────────────────────────────────────────────────────────────
const HULL = new THREE.MeshBasicMaterial({ color: G_INK, side: THREE.BackSide })
/** a box with an ink shell around it */
function inked(w: number, h: number, d: number, color: number, base: THREE.MeshToonMaterial, grow = 0.5): THREE.Mesh {
  const m = box(w, h, d, color, base)
  const sh = new THREE.Mesh(m.geometry, HULL)
  sh.scale.set((w + grow) / w, (h + grow) / h, (d + grow) / d)
  m.add(sh)
  return m
}

/** a menu plate: a light slab on a dark underside, floating */
export function buildPlate(w: number, d: number, base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const top = box(w, 1.4, d, 0xdfe4f0, base); top.position.y = 0.7
  const under = box(w - 0.6, 1.2, d - 0.6, 0x3e404c, base); under.position.y = -0.6
  const lip = box(w + 0.4, 0.5, d + 0.4, 0xb9c0d4, base); lip.position.y = 0.2
  g.add(under, lip, top)
  return g
}

/** a round level stone: a dark base, a light top, a flag if it is done */
export function buildNode(done: boolean, base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 1.0, 14), base.clone())
  ;(foot.material as THREE.MeshToonMaterial).color.setHex(0x3e404c)
  foot.position.y = 0.5
  foot.castShadow = true; foot.receiveShadow = true
  const top = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.0, 0.6, 14), base.clone())
  ;(top.material as THREE.MeshToonMaterial).color.setHex(done ? 0xffde7b : 0xc9cee0)
  top.position.y = 1.3
  top.castShadow = true; top.receiveShadow = true
  g.add(foot, top)
  if (done) {
    const pole = box(0.4, 5.5, 0.4, 0xd8dce8, base); pole.position.set(2.4, 3.5, -2.2)
    const flag = box(2.4, 1.4, 0.3, 0xff8a5a, base); flag.position.set(3.7, 5.6, -2.2)
    g.add(pole, flag)
  }
  g.userData.top = top
  return g
}

export interface Ufo { g: THREE.Group; beam: THREE.Mesh; lights: THREE.Mesh[] }

/** the saucer: a wide disc, a dome, a ring of lights, and a beam that hangs below when on */
export function buildUfo(base: THREE.MeshToonMaterial): Ufo {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 2.2, 14), base.clone())
  ;(disc.material as THREE.MeshToonMaterial).color.setHex(0xb4b8c0)
  disc.castShadow = true
  const under = new THREE.Mesh(new THREE.CylinderGeometry(7, 9.5, 1.4, 14), base.clone())
  ;(under.material as THREE.MeshToonMaterial).color.setHex(0x3e404c)
  under.position.y = -1.6
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), base.clone())
  ;(dome.material as THREE.MeshToonMaterial).color.setHex(0x8fe3ff)
  dome.position.y = 1.0
  g.add(disc, under, dome)
  const lights: THREE.Mesh[] = []
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const l = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 1.4), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffde7b : 0xff5c7a }))
    l.position.set(Math.cos(a) * 10.4, -0.4, Math.sin(a) * 10.4)
    g.add(l)
    lights.push(l)
  }
  const beam = new THREE.Mesh(new THREE.ConeGeometry(7.5, 24, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }))
  beam.position.y = -13
  beam.visible = false
  g.add(beam)
  g.visible = false
  return { g, beam, lights }
}

/**
 * A slapstick glove: a white palm with four fingers and a thumb on a dark cuff,
 * its flat face toward -z (so a pair at ±z clap toward each other).
 */
export function buildHand(side: number, base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const palm = inked(7, 7.5, 2.2, G_WHITE, base, 0.6)
  g.add(palm)
  for (let k = 0; k < 4; k++) {
    const f = inked(1.5, 4.6 - Math.abs(k - 1.5) * 0.5, 2.0, G_WHITE, base, 0.5)
    f.position.set(-2.4 + k * 1.6, 3.75 + f.geometry.boundingBox?.max.y ?? 5.8, 0)
    f.position.y = 3.75 + (4.6 - Math.abs(k - 1.5) * 0.5) / 2 - 0.3
    g.add(f)
  }
  const thumb = inked(1.6, 3.6, 2.0, G_WHITE, base, 0.5)
  thumb.position.set(4.2, 0.6, 0)
  thumb.rotation.z = -0.5
  g.add(thumb)
  const cuff = inked(6, 3, 3.2, G_BROWN, base, 0.5)
  cuff.position.set(0, -5.2, 0)
  g.add(cuff)
  const sleeve = inked(5, 12, 2.8, G_ORANGE, base, 0.5)
  sleeve.position.set(0, -12.5, 0)
  g.add(sleeve)
  g.visible = false
  // the palm faces the goose: the far hand is turned around
  g.rotation.y = side > 0 ? Math.PI : 0
  return g
}

// ── the hero: a body for the goose ──────────────────────────────────────────
/**
 * A jointed rig of boxes.  Facing +x like the sprite.  Joints are Groups whose
 * rotation is the pose; limbs hang from them.  Sizes are goose units (the
 * sprite is 64 wide), scaled with the goose.  The proportions are a fighting
 * game's: a wide chest, a narrow waist, a bicep on every arm.
 */
export interface HeroRig {
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

export function buildHero(base: THREE.MeshToonMaterial, headVox: Voxel[], headMat: THREE.Material): HeroRig {
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
  const face = new THREE.Group()
  face.add(part(1.8, 0.45, 0.4, G_INK, 0.9, 4.1, 1.2))
  face.add(part(1.4, 0.45, 0.4, G_INK, 0.5, 3.9, -1.2))
  face.add(part(1.2, 0.35, 0.4, G_INK, 0.8, 2.5, 1.25))
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
export interface HeroPose {
  spine?: J; neck?: J
  shoulder?: [J, J]; elbow?: [J, J]; wrist?: [J, J]
  hip?: [J, J]; knee?: [J, J]
  lean?: number; lift?: number
}
/** the victory flex: both arms up and bent, chin down toward the bicep */
export const FLEX: HeroPose = {
  spine: [0, 0.2, 0], neck: [0, 0.6, 0.2],
  shoulder: [[0, 0, -2.6], [0, 0, 2.6]], elbow: [[0, 0, 2.2], [0, 0, -2.2]], wrist: [[0, 0, 0.4], [0, 0, -0.4]],
  hip: [[0, 0, 0.25], [0, 0, -0.25]],
}

export function applyHeroPose(rig: HeroRig, p: HeroPose, k = 1): void {
  const set = (g: THREE.Group, j?: J) => { const r = j ?? [0, 0, 0]; g.rotation.set(r[0] * k, r[1] * k, r[2] * k) }
  set(rig.spine, p.spine); set(rig.neck, p.neck)
  for (let i = 0; i < 2; i++) {
    set(rig.shoulder[i], p.shoulder?.[i]); set(rig.elbow[i], p.elbow?.[i]); set(rig.wrist[i], p.wrist?.[i])
    set(rig.hip[i], p.hip?.[i]); set(rig.knee[i], p.knee?.[i])
  }
  rig.root.rotation.z = (p.lean ?? 0) * k
  rig.root.position.y = (p.lift ?? 0) * k
}

/** the head of the goose from the sprite's idle frame, for the hero */
export async function headVoxels(manifest: Manifest): Promise<{ head: Voxel[]; idle: Uint8ClampedArray; fw: number; fh: number }> {
  const g = manifest.chars.goose
  const a = g.anims.idle
  const frames = await readStrip(a.url, a.fw, a.fh, a.n)
  return { head: voxelize(frames[0], g.fw, g.fh, [30, 0, 50, 14]), idle: frames[0], fw: g.fw, fh: g.fh }
}
