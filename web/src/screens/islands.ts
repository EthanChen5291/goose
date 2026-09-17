/**
 * The archipelago: where the goose gets launched to.
 *
 * Past the meadow, past a bank of cloud, the islands hang over the sea at
 * their own heights and distances — the meadow's own turf cut loose and
 * nearest, the vault highest and darkest, the cove down on the water — and
 * between them the ground does not simply stop: trails of islets carry one
 * biome's colour into the next's, so the meadow greens into the dusk's
 * ochre, the ruins' violet into the vault's steel, the snow's white down to
 * the storm's grey.  Under everything, the sea, in cells, moving.
 *
 * The sky is not one colour out here: each island carries its own light,
 * and the drone's frame takes on the light of whatever it is near
 * (`palette`), so the vault darkens the sky as you reach it and the cove
 * brightens it.
 */
import * as THREE from 'three'
import { OCEAN_Y, LANDING_GRASS, Kit, CellField, blob, buildGround, rockUnder, mixHex, clamp01 } from './island_kit'
import type { Island, Palette, BiomeCtx, CamPose } from './island_kit'
import { BIOMES } from './biomes'
import type { Biome } from './biomes'
import { rng } from './goose_world'
import { buildRevealShow } from './reveal_fx'
import { buildHorizon } from './horizon'

/** where each biome hangs, in the order of `BIOMES` */
// all of them under the line the goose flies (the plates' height): the drone comes in over the archipelago, never under it
const PLACES: [number, number, number][] = [
  [520, 22, -30],           // goose meadow
  [640, 6, 150],            // dusk hills
  [760, OCEAN_Y + 2, 60],   // salt cove, on the water
  [880, 28, 170],           // storm flats
  [600, 34, -140],          // night ruins
  [770, 40, -110],          // the vault
  [900, 46, 0],             // dawn steps
]
/** which islands trail islets to which */
const LINKS: [number, number][] = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [3, 6], [0, 2]]
/** the wall of cloud past the meadow's edge, the one the goose went through */
export const WALL = { x: 230, y0: -80, y1: 110, z0: -300, z1: 300 }
/** where the wall's hole is: the feet of the bird, world space */
export interface Hole { y: number; z: number }

export interface Archipelago {
  root: THREE.Group
  islands: Island[]
  /** the middle of the islands, to look at from the far side of the cloud */
  centre: THREE.Vector3
  /** the establishing shot as the cloud opens */
  vista: CamPose
  /** the sky the frame should have from here: the mainland's, tinted by whatever is near */
  palette: (from: THREE.Vector3, base: Palette) => Palette
  /** 0..1: a lightning flash somewhere near */
  flash: (from: THREE.Vector3) => number
  /** one frame; `show` is 1 through the reveal and a fraction on the map, and is what the sky's life is scaled by */
  tick: (t: number, dt: number, from: THREE.Vector3, show: number) => void
}

export function buildArchipelago(kit: Kit, scene: THREE.Scene, cue: (name: string) => void, hole: Hole): Archipelago {
  const root = new THREE.Group()
  scene.add(root)
  const q = rng(101)

  // ── the islands ─────────────────────────────────────────────────────────
  const islands: Island[] = BIOMES.map((b: Biome, k) => {
    const g = new THREE.Group()
    const at = new THREE.Vector3(...PLACES[k])
    g.position.copy(at)
    root.add(g)
    const anims: ((t: number, dt: number, near: number) => void)[] = []
    const ctx: BiomeCtx = { kit, scene, g, r: rng(1000 + k * 17), at, size: b.r, cue, anim: (fn) => anims.push(fn) }
    const built = b.build(ctx)
    const toWorld = (p: THREE.Vector3): THREE.Vector3 => p.clone().add(at)
    const cam = (c: CamPose): CamPose => ({ pos: toWorld(c.pos), look: toWorld(c.look), fov: c.fov })
    const island: Island = {
      id: b.id, name: b.name, g, at, r: b.r, bob: 0,
      land: built.land ?? LANDING_GRASS,
      collide: built.collide ? (p, v, rr) => { p.sub(at); const hit = built.collide!(p, v, rr); p.add(at); return hit } : undefined,
      spots: built.spots.map(toWorld),
      cam: cam(built.cam),
      camIn: built.camIn ? cam(built.camIn) : undefined,
      sky: b.sky,
      inside: (x, z) => built.outline.inside(x - at.x, z - at.z),
      top: (x, z) => at.y + island.bob + built.ground.top(x - at.x, z - at.z),
      tick: (t, dt, near) => { for (const a of anims) a(t, dt, near) },
      arrive: built.arrive,
      leave: built.leave,
    }
    island.g.userData.arriveFrom = built.arriveFrom
    return island
  })
  const centre = islands.reduce((c, i) => c.add(i.at), new THREE.Vector3()).divideScalar(islands.length)

  // ── the islets between them ─────────────────────────────────────────────
  for (const [a, b] of LINKS) {
    const A = islands[a], B = islands[b]
    const dir = B.at.clone().sub(A.at)
    const len = dir.length()
    dir.normalize()
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize()
    const n = 3 + Math.floor(q() * 3)
    for (let i = 0; i < n; i++) {
      const u = (i + 1) / (n + 1) + (q() - 0.5) * 0.08
      // room for the islet between the two coasts
      const along = A.r * 1.1 + (len - A.r * 1.1 - B.r * 1.1) * u
      const p = A.at.clone().addScaledVector(dir, along).addScaledVector(side, (q() - 0.5) * 60)
      p.y = A.at.y + (B.at.y - A.at.y) * u + (q() - 0.5) * 30
      const onSea = p.y < OCEAN_Y + 4
      if (onSea) p.y = OCEAN_Y + 2
      const g = new THREE.Group()
      g.position.copy(p)
      root.add(g)
      const r = 4 + q() * 6
      const tintA = BIOMES[a].tint, tintB = BIOMES[b].tint
      const rr = rng(Math.floor(q() * 1e6))
      buildGround(kit, {
        outline: blob(Math.floor(q() * 1e6), r, q() < 0.4 ? 1 : 0, 1.5),
        top: (_x, _z, e) => e > 3 && rr() < 0.4 ? 1 : 0,
        color: () => mixHex(tintA, tintB, clamp01(u + (rr() - 0.5) * 0.25)),
        under: onSea ? { depth: () => 3, color: () => 0x6b7688 } : rockUnder(rr, 1.2, 4),
      }, g)
      const from = u < 0.5 ? BIOMES[a] : BIOMES[b]
      if (from.islet && q() < 0.75) {
        const pg = new THREE.Group()
        from.islet(kit, pg, rr)
        pg.position.set((rr() - 0.5) * r, 0, (rr() - 0.5) * r)
        g.add(pg)
      }
    }
  }

  // ── the sea ─────────────────────────────────────────────────────────────
  const SEA = 12
  const sx0 = -400, sx1 = 1200, sz0 = -520, sz1 = 520
  const nx = Math.ceil((sx1 - sx0) / SEA), nz = Math.ceil((sz1 - sz0) / SEA)
  const sea = new CellField(nx * nz, SEA, 2, SEA, kit.base.clone())
  sea.mesh.receiveShadow = true
  root.add(sea.mesh)
  let seaFrame = 0
  const tickSea = (t: number): void => {
    seaFrame += 1
    if (seaFrame % 2) return
    let i = 0
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
      const x = sx0 + ix * SEA + SEA / 2, z = sz0 + iz * SEA + SEA / 2
      const w = Math.sin(x * 0.045 + t * 0.9) + Math.sin(z * 0.06 - t * 0.7) * 0.8 + Math.sin((x + z) * 0.03 + t * 0.5) * 0.5
      const h = Math.round(w)
      const c = h >= 2 ? 0x9fe6ff : h === 1 ? 0x3aa0e6 : h === 0 ? 0x2a7fd6 : 0x1e5fbf
      sea.set(i++, x, OCEAN_Y - 1 + h * 0.5, z, 1, c)
    }
    sea.commit()
  }

  // ── the cloud ───────────────────────────────────────────────────────────
  // lit from above like everything else, but never dark underneath: a cloud's
  // shadow side is still bright, so it glows a little of its own
  const cloudMat = kit.base.clone()
  cloudMat.color.setHex(0xffffff)
  cloudMat.emissive.setHex(0x8fa0b4)
  const clouds: { g: THREE.Group; speed: number }[] = []
  const cloud = (x: number, y: number, z: number, big: number): void => {
    const g = new THREE.Group()
    const w = (8 + q() * 12) * big
    const dims: [number, number, number, number, number, number][] = [[w, 3 * big, 5 * big, 0, 0, 0], [w * 0.6, 3 * big, 4 * big, w * 0.3, 2 * big, 0.5], [w * 0.5, 2.5 * big, 4 * big, -w * 0.35, 1.5 * big, -0.5]]
    for (const [pw, ph, pd, px, py, pz] of dims) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), cloudMat)
      m.position.set(px, py, pz)
      g.add(m)
    }
    g.position.set(x, y, z)
    root.add(g)
    clouds.push({ g, speed: 0.4 + q() * 0.8 })
  }
  // loose puffs either side of the wall, clear of the line through the hole
  for (let k = 0; k < 36; k++) {
    const x = WALL.x - 70 + q() * 150, y = -20 + q() * 130, z = (q() - 0.5) * 520
    if (Math.abs(z - hole.z) < 50 && Math.abs(y - hole.y - 10) < 50) continue
    cloud(x, y, z, 1.6 + q() * 1.4)
  }
  // loose clouds over the archipelago, but never on a mark the drone flies to, nor on its way in to one, nor across the chase
  const marks: THREE.Vector3[] = []
  for (const i of islands) {
    marks.push(i.cam.pos, i.cam.pos.clone().add(i.cam.pos.clone().sub(i.cam.look).normalize().multiplyScalar(48)))
    if (i.camIn) marks.push(i.camIn.pos)
  }
  const clear = (x: number, y: number, z: number): boolean => {
    if (marks.some((m) => Math.hypot(x - m.x, y - m.y, z - m.z) < 70)) return false
    if (Math.abs(z - hole.z) < 60 && y > hole.y - 20 && y < hole.y + 60 && x < 560) return false
    return islands.every((i) => Math.hypot(x - i.at.x, z - i.at.z) > i.r + 24 || y < i.at.y - 12 || y > i.at.y + 80)
  }
  for (let k = 0, tries = 0; k < 40 && tries < 400; tries++) {
    const x = 440 + q() * 560, y = -12 + q() * 120, z = (q() - 0.5) * 520
    if (!clear(x, y, z)) continue
    cloud(x, y, z, 1 + q() * 1.2)
    k += 1
  }
  // and tucked under the floating ones, hugging the rock
  for (const i of islands) {
    if (i.at.y < OCEAN_Y + 10) continue
    for (let k = 0; k < 3; k++) {
      const a = q() * Math.PI * 2, d = i.r * (0.7 + q() * 0.5)
      cloud(i.at.x + Math.cos(a) * d, i.at.y - 8 - q() * 16, i.at.z + Math.sin(a) * d, 1.4 + q() * 1.2)
      clouds[clouds.length - 1].speed = 0
    }
  }

  // ── the horizon: what is out past the islands, every way ───────────────
  buildHorizon(kit, root, q, cloudMat)

  // ── the wall, and the hole the bird left in it ──────────────────────────
  // A curtain of cloud across the way, with a bird-shaped hole punched through
  // it at plate height (wings out, feet down, the plate a slot underneath) —
  // the islands show through the hole first; as the drone reaches it the
  // cloud round the hole slides aside and the whole sky opens.
  const S = 2.2
  /** the splayed bird, seen from the front: y up from its feet, z across, in goose heights */
  const bird = (y: number, z: number): boolean => {
    const ell = (cy: number, cz: number, ry: number, rz: number) => ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 < 1
    const az = Math.abs(z)
    if (ell(3.0, 0, 1.8, 2.6)) return true
    if (y > 4.0 && y < 7.4 && az < 0.8) return true
    if (ell(8.1, 0.3, 1.1, 1.3)) return true
    if (y > 7.9 && y < 8.7 && z > 1.2 && z < 2.7) return true
    if (az > 1.8 && az < 6.8) { const wy = 3.6 + (az - 1.8) * 0.22; if (Math.abs(y - wy) < (az > 5.6 ? 0.9 : 0.5)) return true }
    if (y > -0.2 && y < 1.6 && Math.abs(az - 1.0) < 0.5) return true
    return y > -0.2 && y < 0.35 && az < 2.4 && az > 0.4
  }
  const inHole = (y: number, z: number): boolean =>
    bird((y - hole.y) / S, (z - hole.z) / S) || (Math.abs(z - hole.z) < 8 && y > hole.y - 2.2 && y < hole.y - 0.2)
  const HY = hole.y + 8, HZ = hole.z
  const FINE_R = 46
  interface WallCell { f: CellField; i: number; x: number; y: number; z: number; sx: number; sy: number; sz: number; dy: number; dz: number; d: number }
  const wallCells: WallCell[] = []
  const wallCell = (f: CellField, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    const d = Math.hypot(y - HY, z - HZ)
    f.set(i, x, y, z, sy, 0xffffff, sx, sz)
    wallCells.push({ f, i, x, y, z, sx, sy, sz, dy: (y - HY) / Math.max(1, d), dz: (z - HZ) / Math.max(1, d), d })
  }
  // the coarse curtain, everywhere but round the hole
  // the curtain bulges toward the meadow in lumps, so it has tops and sides for the sun to pick out
  const lump = (y: number, z: number): number => 0.5 + 0.5 * Math.sin(y * 0.09 + z * 0.05) * Math.cos(z * 0.075 - y * 0.04)
  const coarse: [number, number, number, number][] = []
  for (let y = WALL.y0; y <= WALL.y1; y += 15) for (let z = WALL.z0; z <= WALL.z1; z += 15) {
    if (Math.hypot(y - HY, z - HZ) < FINE_R - 6) continue
    const l = lump(y, z)
    coarse.push([WALL.x - l * 34 + (q() - 0.5) * 10, y + (q() - 0.5) * 6, z + (q() - 0.5) * 6, l])
  }
  const coarseF = new CellField(coarse.length, 1, 1, 1, cloudMat)
  coarse.forEach(([x, y, z, l], i) => { const s = 15 + q() * 7 + l * 12; wallCell(coarseF, i, x, y, z, 18 + q() * 12 + l * 12, s, s * (0.8 + q() * 0.5)) })
  root.add(coarseF.mesh)
  // the fine cells round the hole, none where the bird went
  const fine: [number, number, number][] = []
  for (let y = HY - FINE_R; y <= HY + FINE_R; y += 2) for (let z = HZ - FINE_R; z <= HZ + FINE_R; z += 2) {
    if (Math.hypot(y - HY, z - HZ) > FINE_R + 2) continue
    if (inHole(y, z)) continue
    fine.push([WALL.x - 6 - lump(y, z) * 10 + (q() - 0.5) * 6, y, z])
  }
  const fineF = new CellField(fine.length, 1, 1, 1, cloudMat)
  fine.forEach(([x, y, z], i) => wallCell(fineF, i, x, y, z, 6 + q() * 5, 2.4 + q() * 0.8, 2.4 + q() * 0.8))
  root.add(fineF.mesh)
  // fluff on the near face, so the curtain is not a flat wall
  const fluff: [number, number, number][] = []
  for (let y = WALL.y0; y <= WALL.y1; y += 7) for (let z = WALL.z0; z <= WALL.z1; z += 7) {
    if (Math.hypot(y - HY, z - HZ) < FINE_R + 6 || q() > 0.45) continue
    fluff.push([WALL.x - 14 - lump(y, z) * 30 - q() * 8, y + (q() - 0.5) * 4, z + (q() - 0.5) * 4])
  }
  const fluffF = new CellField(fluff.length, 1, 1, 1, cloudMat)
  fluff.forEach(([x, y, z], i) => { const s = 4 + q() * 5; wallCell(fluffF, i, x, y, z, 5 + q() * 6, s, s * (1 + q())) })
  root.add(fluffF.mesh)
  let parted = -1
  const partWall = (k: number): void => {
    if (Math.abs(k - parted) < 1e-3) return
    parted = k
    for (const c of wallCells) {
      const shift = k * 34 * clamp01(1 - (c.d - 10) / 64)
      c.f.place(c.i, c.x, c.y + c.dy * shift, c.z + c.dz * shift, c.sy, c.sx, c.sz)
    }
    coarseF.commit(false); fineF.commit(false); fluffF.commit(false)
  }
  partWall(0)
  // and once the drone is through and past it, the curtain is gone: from out over the islands the way back is open sky
  // and sea, not the back of a wall of cloud
  let wallOn = true
  const showWall = (on: boolean): void => {
    if (on === wallOn) return
    wallOn = on
    coarseF.mesh.visible = fineF.mesh.visible = fluffF.mesh.visible = on
  }

  // ── the mainland's edge: rock under the meadow, down to the sea ─────────
  const ROCKS = [0x7d6858, 0x8c7462, 0x6b5a4e, 0x9a806c]
  const skirtAt: [number, number, number, number][] = []
  for (let z = -104; z < 104; z += 8) { skirtAt.push([107, z + 4, 6 + q() * 8, 8.5]); skirtAt.push([-107, z + 4, 6 + q() * 8, 8.5]) }
  for (let x = -104; x < 104; x += 8) { skirtAt.push([x + 4, 107, 8.5, 6 + q() * 8]); skirtAt.push([x + 4, -107, 8.5, 6 + q() * 8]) }
  const skirt = new CellField(skirtAt.length, 1, 1, 1, kit.base.clone(), true)
  skirtAt.forEach(([x, z, sx, sz], i) => { const h = 36 + q() * 14; skirt.set(i, x, -h / 2 - 0.5, z, h, ROCKS[Math.floor(q() * ROCKS.length)], sx, sz) })
  skirt.commit()
  root.add(skirt.mesh)

  // the sun on the water: cells that catch it for a few frames at a time
  const SPARK = 320
  const sparks = new CellField(SPARK, 1.6, 0.4, 1.6, kit.glowMat(0xffffff))
  root.add(sparks.mesh)
  const sparkAt = Array.from({ length: SPARK }, () => ({ x: 420 + q() * 620, z: (q() - 0.5) * 520, ph: q() * 7 }))

  // ── gulls crossing the whole sky ────────────────────────────────────────
  const flock: { g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh; ph: number }[] = []
  for (let k = 0; k < 6; k++) {
    const g = new THREE.Group()
    const body = kit.box(1.8, 0.7, 0.8, 0xffffff)
    const l = kit.box(0.6, 0.14, 2.6, 0xf0f0f0, 0, 0, -1.3), r = kit.box(0.6, 0.14, 2.6, 0xf0f0f0, 0, 0, 1.3)
    g.add(body, l, r)
    root.add(g)
    flock.push({ g, l, r, ph: k * 0.4 })
  }

  const tmp = new THREE.Vector3()
  const near = (from: THREE.Vector3, i: Island, reach = 200): number => clamp01(1 - (from.distanceTo(i.at) - i.r) / reach)
  const showFx = buildRevealShow(kit, root, islands, centre, { x: WALL.x, y: hole.y, z: hole.z }, q)

  return {
    root, islands, centre,
    vista: { pos: new THREE.Vector3(WALL.x + 70, hole.y + 26, hole.z + 30), look: new THREE.Vector3(700, 14, 30), fov: 54 },
    palette: (from, base) => {
      let wr = 0, wg = 0, wb = 0
      const acc: number[][] = [[], [], [], []]
      let total = 0
      const ws = islands.map((i) => Math.pow(near(from, i, 240), 1.6))
      for (const w of ws) total += w
      const scale = total > 1 ? 1 / total : 1
      const out: number[] = []
      for (let c = 0; c < 4; c++) {
        wr = wg = wb = 0
        let used = 0
        islands.forEach((i, k) => {
          const w = ws[k] * scale
          used += w
          wr += ((i.sky[c] >> 16) & 255) * w; wg += ((i.sky[c] >> 8) & 255) * w; wb += (i.sky[c] & 255) * w
        })
        const bw = 1 - used
        wr += ((base[c] >> 16) & 255) * bw; wg += ((base[c] >> 8) & 255) * bw; wb += (base[c] & 255) * bw
        out.push((Math.round(wr) << 16) | (Math.round(wg) << 8) | Math.round(wb))
        void acc
      }
      return out as unknown as Palette
    },
    flash: (from) => {
      let f = 0
      for (const i of islands) { const k = (i.g.userData.flash as number | undefined) ?? 0; if (k > 0) f = Math.max(f, k * near(from, i, 260)) }
      return f
    },
    tick: (t, dt, from, show) => {
      // the floating ones ride the air, a little, each to its own beat
      islands.forEach((i, k) => {
        if (i.at.y < OCEAN_Y + 10) return
        i.bob = Math.sin(t * (0.3 + k * 0.04) + k * 1.7) * 0.7
        i.g.position.y = i.at.y + i.bob
      })
      for (const i of islands) i.tick(t, dt, near(from, i, 180))
      tickSea(t)
      for (const c of clouds) { c.g.position.z += dt * c.speed; if (c.g.position.z > 300) c.g.position.z = -300 }
      // the cloud round the hole slides aside as the drone comes at it, and stays open while it is past
      const pk = clamp01((from.x - (WALL.x - 150)) / 100)
      partWall(pk * pk * (3 - 2 * pk))
      showWall(from.x < WALL.x + 40)
      for (let i = 0; i < SPARK; i++) {
        const sp = sparkAt[i]
        const on = ((t * 0.6 + sp.ph) % 1) < 0.07 + show * 0.1
        sparks.place(i, sp.x, on ? OCEAN_Y + 1.6 : -9999, sp.z)
      }
      sparks.commit(false)
      flock.forEach((b, k) => {
        const a = t * 0.12 + b.ph
        tmp.set(centre.x + Math.cos(a) * 250, 78 + Math.sin(t * 0.5 + b.ph) * 6 + k * 2, centre.z + Math.sin(a) * 250)
        b.g.position.copy(tmp)
        b.g.rotation.y = -a - Math.PI / 2
        const flap = Math.sin(t * 8 + b.ph)
        b.l.rotation.x = flap * 0.7; b.r.rotation.x = -flap * 0.7
      })
      showFx.tick(t, dt, from, show)
    },
  }
}
