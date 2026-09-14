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
import { G_WHITE, G_SHADE, G_ORANGE, G_BROWN, G_INK, buildHead, partMaker } from './goose_rig'
import type { HeadRig } from './goose_rig'

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
  // 104 cells of 2: the meadow runs ±104, past the edge of the menu's frame from 80 up
  const N = 104
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
    // flat across the band the map plays in (and under the menu's plates), gentle steps further out
    const band = Math.abs(x) < 52 && z > -26 && z < 30
    const hr = r() * 1.6 + (d - 9) / 40
    let h = d < 9 || band ? 0 : Math.floor(Math.max(0, hr))
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
  const trees = [[-30, -26], [-44, 4], [38, -32], [50, 10], [-18, -46], [30, 40], [-52, -30], [58, -12], [8, -54], [-40, 36],
                 [-72, -60], [-80, 20], [-66, 58], [70, -58], [82, 30], [64, 66], [-20, -82], [24, -78], [-4, 84], [-90, -14], [92, -8], [44, 86], [-58, -88], [86, 70], [-84, 74]]
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
  for (let k = 0; k < 26; k++) {
    const x = (r() - 0.5) * 190, z = (r() - 0.5) * 190
    if (Math.hypot(x, z) < 12) continue
    const s = 1.5 + r() * 3
    const rock = box(s * (0.8 + r() * 0.6), s * 0.7, s, STONE[k % 2], base)
    rock.position.set(x, s * 0.3, z)
    scene.add(rock)
  }
  // flowers: a stem and a head
  for (let k = 0; k < 220; k++) {
    const x = (r() - 0.5) * 190, z = (r() - 0.5) * 190
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
    const d = 190 + r() * 60
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
export const PLATE_THICK = 1.2
export function buildPlate(w: number, d: number, base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const top = box(w, PLATE_THICK, d, 0xdfe4f0, base); top.position.y = PLATE_THICK / 2
  const under = box(w - 0.6, 1.0, d - 0.6, 0x3e404c, base); under.position.y = -0.5
  const lip = box(w + 0.5, 0.45, d + 0.5, 0xb9c0d4, base); lip.position.y = 0.2
  g.add(under, lip, top)
  return g
}

/** a hole in the ground: a black disc on a ring of turned earth, scaled open and shut */
export function buildHole(base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.5, 12), base.clone())
  ;(rim.material as THREE.MeshToonMaterial).color.setHex(0x7a5a38)
  rim.position.y = 0.2
  rim.receiveShadow = true
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 0.3, 12), new THREE.MeshBasicMaterial({ color: 0x07070c }))
  pit.position.y = 0.42
  g.add(rim, pit)
  g.visible = false
  return g
}

/** the skid a rolling goose leaves: a flattened dark strip, stretched from where it first hit to where it stopped */
export function buildSkid(base: THREE.MeshToonMaterial): THREE.Mesh {
  const m = box(1, 0.16, 3.0, 0x55702c, base)
  m.castShadow = false
  m.visible = false
  return m
}

/** a round level stone: a dark base, a light top, a flag if it is done */
export function buildNode(done: boolean, base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(4.0, 4.3, 1.0, 16), base.clone())
  ;(foot.material as THREE.MeshToonMaterial).color.setHex(0x3e404c)
  foot.position.y = 0.5
  foot.castShadow = true; foot.receiveShadow = true
  const top = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.6, 16), base.clone())
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

export interface Ufo { g: THREE.Group; beam: THREE.Mesh; lights: THREE.Mesh[]; ring: THREE.Group; emitter: THREE.Mesh }

/**
 * The saucer: a wide hull in two tones with a raised rim, a band of portholes,
 * a rotating ring of fins under it with running lights, a glass dome with a
 * darker cabin inside and an antenna on top, and an emitter on the belly that
 * the beam hangs from when it is on.
 */
export function buildUfo(base: THREE.MeshToonMaterial): Ufo {
  const g = new THREE.Group()
  const tone = (m: THREE.Mesh, c: number): THREE.Mesh => { (m.material as THREE.MeshToonMaterial).color.setHex(c); m.castShadow = true; return m }
  const hull = tone(new THREE.Mesh(new THREE.CylinderGeometry(8.5, 12.5, 2.0, 16), base.clone()), 0xb4b8c0)
  const rim = tone(new THREE.Mesh(new THREE.CylinderGeometry(12.6, 12.2, 0.7, 16), base.clone()), 0x7c828e)
  rim.position.y = -0.4
  const deck = tone(new THREE.Mesh(new THREE.CylinderGeometry(6.2, 8.6, 0.8, 16), base.clone()), 0xd6dae2)
  deck.position.y = 1.3
  const under = tone(new THREE.Mesh(new THREE.CylinderGeometry(6.5, 10.5, 1.6, 16), base.clone()), 0x3e404c)
  under.position.y = -1.6
  const belly = tone(new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.8, 1.0, 12), base.clone()), 0x2a2c36)
  belly.position.y = -2.8
  g.add(hull, rim, deck, under, belly)
  // panel seams on the deck and the hull: thin dark boxes
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const seam = box(6.2, 0.25, 0.3, 0x6b7080, base)
    seam.castShadow = false
    seam.position.set(Math.cos(a) * 6.6, 1.05, Math.sin(a) * 6.6)
    seam.rotation.y = -a
    g.add(seam)
  }
  // portholes around the hull
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + 0.13
    const w = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 0.5), new THREE.MeshBasicMaterial({ color: 0x18305a }))
    w.position.set(Math.cos(a) * 10.6, 0.15, Math.sin(a) * 10.6)
    w.rotation.y = -a
    g.add(w)
  }
  // the dome: glass over a dark cabin, an antenna with a red tip
  const dome = tone(new THREE.Mesh(new THREE.SphereGeometry(4.6, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2), base.clone()), 0x8fe3ff)
  dome.position.y = 1.7
  const cabin = tone(new THREE.Mesh(new THREE.SphereGeometry(3.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), base.clone()), 0x1c2340)
  cabin.position.y = 1.75
  const mast = box(0.4, 3.2, 0.4, 0x7c828e, base); mast.position.y = 7.4
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshBasicMaterial({ color: 0xff5c7a })); tip.position.y = 9.2
  g.add(dome, cabin, mast, tip)
  // the fin ring: spins on its own under the hull, a light on every other fin
  const ring = new THREE.Group()
  ring.position.y = -2.0
  const lights: THREE.Mesh[] = []
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2
    const fin = box(2.6, 1.0, 0.9, 0x9a9ea8, base)
    fin.position.set(Math.cos(a) * 9.4, 0, Math.sin(a) * 9.4)
    fin.rotation.y = -a
    ring.add(fin)
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffde7b : 0x8fe3ff }))
    l.position.set(Math.cos(a) * 10.9, -0.1, Math.sin(a) * 10.9)
    ring.add(l)
    lights.push(l)
  }
  g.add(ring)
  // the emitter: a bright lens on the belly the beam comes from
  const emitter = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.4, 0.5, 12), new THREE.MeshBasicMaterial({ color: 0x8fe3ff }))
  emitter.position.y = -3.4
  g.add(emitter)
  const beam = new THREE.Mesh(new THREE.ConeGeometry(6.5, 26, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }))
  beam.position.y = -15.6
  beam.visible = false
  g.add(beam)
  g.visible = false
  return { g, beam, lights, ring, emitter }
}

/**
 * A slapstick glove: a white palm with four fingers and a thumb on a dark cuff,
 * its flat face toward -z (so a pair at ±z clap toward each other).
 */
export function buildHand(base: THREE.MeshToonMaterial): THREE.Group {
  const g = new THREE.Group()
  const palm = inked(6.4, 6, 1.8, G_WHITE, base, 0.18)
  g.add(palm)
  for (let k = 0; k < 4; k++) {
    const fh = 4.4 - Math.abs(k - 1.4) * 0.6
    const f = inked(1.35, fh, 1.7, G_WHITE, base, 0.18)
    f.position.set(-2.3 + k * 1.55, 3 + fh / 2 - 0.2, 0)
    g.add(f)
  }
  const thumb = inked(1.4, 3.4, 1.7, G_WHITE, base, 0.18)
  thumb.position.set(3.9, 0.8, 0)
  thumb.rotation.z = -0.55
  g.add(thumb)
  const cuff = inked(5.2, 2, 2.6, G_BROWN, base, 0.18)
  cuff.position.set(0, -4, 0)
  g.add(cuff)
  const sleeve = inked(4.2, 5, 2.3, G_ORANGE, base, 0.18)
  sleeve.position.set(0, -7.4, 0)
  g.add(sleeve)
  g.scale.setScalar(0.9)
  g.visible = false
  return g
}

// ── the hero: a body for the goose ──────────────────────────────────────────
/**
 * A jointed rig of boxes.  Facing +x like the sprite.  Joints are Groups whose
 * rotation is the pose; limbs hang from them.  Sizes are goose units (the
 * sprite is 64 wide), scaled with the goose.  The proportions are a fighting
 * game's: a wide chest, a narrow waist, a bicep on every arm — and on top,
 * the goose's own head, the three-dimensional one, so it can scowl.
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
  head: HeadRig
  setOutline: (g: number) => void
}

export function buildHero(base: THREE.MeshToonMaterial): HeroRig {
  const root = new THREE.Group()
  const { part: inkPart, setOutline } = partMaker(base)
  const part = (w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0): THREE.Mesh => inkPart(w, h, d, c, x, y, z, 0.8)
  // legs: hip at y 15, knee at y 8, boots on the ground
  const hips: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const knees: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  hips.forEach((hip, i) => {
    const side = i === 0 ? -1 : 1
    hip.position.set(0, 15, side * 3.4)
    hip.add(part(4.8, 7.2, 4.8, G_WHITE, 0, -3.5, 0))         // thigh, thick
    hip.add(part(3.2, 3.0, 5.4, G_SHADE, 0.9, -2.2, 0))       // the quad's shadow line
    const knee = knees[i]
    knee.position.set(0, -7, 0)
    knee.add(part(3.6, 6.6, 3.6, G_WHITE, 0, -3.2, 0))        // shin
    knee.add(part(2.2, 3.4, 3.8, G_SHADE, -1.0, -2.6, 0))     // the calf
    knee.add(part(5.4, 2.4, 4.0, G_ORANGE, 0.9, -7.6, 0))     // the boot: a goose foot, big
    knee.add(part(2.4, 1, 1.3, G_BROWN, 3.0, -8.2, 1.0))      // toes
    knee.add(part(2.4, 1, 1.3, G_BROWN, 3.0, -8.2, -1.0))
    hip.add(knee)
    root.add(hip)
  })
  // torso hangs from the spine joint at the pelvis
  const spine = new THREE.Group()
  spine.position.set(0, 15.5, 0)
  spine.add(part(7.5, 4, 9, G_WHITE, 0, 1.5, 0))               // pelvis / waist, narrow against the chest
  spine.add(part(10.5, 10, 13, G_WHITE, 0, 8.4, 0))            // chest, a barrel
  spine.add(part(3.6, 4.4, 5.2, G_WHITE, 4.9, 10.4, 3.2))      // pecs, out front
  spine.add(part(3.6, 4.4, 5.2, G_WHITE, 4.9, 10.4, -3.2))
  spine.add(part(1.2, 1.2, 12.6, G_SHADE, 5.6, 8.0, 0))        // the line under the pecs
  for (let r = 0; r < 4; r++) {                                 // abs, a six-pack and change
    spine.add(part(1.0, 1.9, 2.2, G_SHADE, 5.3, 6.8 - r * 1.75, 1.4))
    spine.add(part(1.0, 1.9, 2.2, G_SHADE, 5.3, 6.8 - r * 1.75, -1.4))
  }
  spine.add(part(3.0, 5.0, 3.2, G_SHADE, -4.6, 9.4, 3.6))      // the lats, flaring behind the arms
  spine.add(part(3.0, 5.0, 3.2, G_SHADE, -4.6, 9.4, -3.6))
  spine.add(part(11.5, 3.6, 18, G_WHITE, 0, 12.6, 0))          // shoulders, very wide
  // arms
  const shoulders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const elbows: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const wrists: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  shoulders.forEach((sh, i) => {
    const side = i === 0 ? -1 : 1
    sh.position.set(0, 12.6, side * 9.2)
    sh.add(part(5.0, 4.8, 5.0, G_WHITE, 0, 0.2, 0))             // deltoid, a cannonball
    sh.add(part(4.6, 6.6, 4.6, G_WHITE, 0, -3.4, 0))            // upper arm
    sh.add(part(6.2, 4.6, 5.6, G_WHITE, 1.0, -3.4, 0))          // the bicep, bulging forward
    sh.add(part(2.0, 3.0, 5.8, G_SHADE, -2.8, -3.6, 0))         // the tricep's shade
    const el = elbows[i]
    el.position.set(0, -6.8, 0)
    el.add(part(3.8, 6.4, 3.8, G_WHITE, 0, -3.2, 0))            // forearm
    el.add(part(4.4, 2.6, 4.2, G_WHITE, 0.3, -1.6, 0))          // the forearm's swell below the elbow
    const wr = wrists[i]
    wr.position.set(0, -6.4, 0)
    wr.add(part(3.0, 3.0, 2.8, G_ORANGE, 0.3, -1.4, 0))         // hand: goose orange
    el.add(wr)
    sh.add(el)
    spine.add(sh)
  })
  // the neck and the goose's head on top, a size up to sit on those shoulders
  const neck = new THREE.Group()
  neck.position.set(2.0, 14.2, 0)
  neck.add(part(3.8, 2.8, 3.8, G_WHITE, 0, 1.2, 0))
  const head = buildHead(inkPart)
  head.g.position.set(0.2, 2.6, 0)
  // the head is the goose's own size on a body three times its width: the joke of the pose
  head.g.scale.setScalar(0.85)
  neck.add(head.g)
  spine.add(neck)
  root.add(spine)
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = false } })
  return { root, spine, neck, shoulder: shoulders, elbow: elbows, wrist: wrists, hip: hips, knee: knees, head, setOutline }
}

/** a pose: rotations (radians) per joint, x/y/z each; unspecified stays at rest */
type J = [number, number, number]
export interface HeroPose {
  spine?: J; neck?: J
  shoulder?: [J, J]; elbow?: [J, J]; wrist?: [J, J]
  hip?: [J, J]; knee?: [J, J]
  lean?: number; lift?: number
}
export type PoseName = 'rohan' | 'dio' | 'giorno'
/** the JoJo stances */
export const POSES: Record<PoseName, HeroPose> = {
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

/** the sprite's idle frame, made solid: the whole bird, and its head alone */
export async function spriteVoxels(manifest: Manifest): Promise<{ all: Voxel[]; head: Voxel[]; idle: Uint8ClampedArray; fw: number; fh: number }> {
  const g = manifest.chars.goose
  const a = g.anims.idle
  const frames = await readStrip(a.url, a.fw, a.fh, a.n)
  return { all: voxelize(frames[0], g.fw, g.fh), head: voxelize(frames[0], g.fw, g.fh, [30, 0, 50, 14]), idle: frames[0], fw: g.fw, fh: g.fh }
}

/** the ド / ゴ that hang in the air around a pose: flat quads with the baked glyph, nearest-sampled */
export async function menacingSprites(manifest: Manifest): Promise<THREE.Mesh[]> {
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
