/**
 * The islands, one by one.
 *
 * Each biome is a builder: given the kit, a seed and a group, it lays its
 * ground (`buildGround`), stands its props in it, and registers what moves
 * every frame — waves, rain, snow, hammers, fireflies, a windmill.  It hands
 * back where its six level stones go, where the drone should hover, its
 * light, and — for the vault — what happens when the drone arrives.
 *
 * Everything is boxes in the meadow's flat toon shading, and everything
 * that glows is an unlit box: in a three-step light, unlit reads as lit.
 */
import * as THREE from 'three'
import { Bits } from './goose_fx'
import {
  CELL, OCEAN_Y, Kit, CellField, blob, buildGround, arcSpots, walkway, rockUnder, clamp, clamp01, lerp,
} from './island_kit'
import type { BiomeCtx, CamPose, Ground, Palette, Outline, Landing } from './island_kit'

export interface Built {
  outline: Outline
  ground: Ground
  spots: THREE.Vector3[]
  cam: CamPose
  camIn?: CamPose
  arrive?: (t: number) => number
  leave?: () => void
  /** where the thrown goose comes in from (a direction, island-relative) and how high; the default is from the mainland, high.
   *  `lane` keeps the rest point within that distance of the line through the target, so the throw fits through a door */
  arriveFrom?: { dir: THREE.Vector3; drop: number; reach: number; lane?: number }
  land?: Landing
  /** island-relative walls: pushes `pos` out and reflects `vel`, true if it did */
  collide?: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => boolean
}
export interface Biome {
  id: string
  name: string
  r: number
  sky: Palette
  /** the ground's colour, for the islets between islands */
  tint: number
  /** a thing of this biome's, for an islet */
  islet?: (kit: Kit, g: THREE.Group, r: () => number) => void
  build: (ctx: BiomeCtx) => Built
}

const TAU = Math.PI * 2
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const pick = <T,>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)]
const ease = (u: number) => u * u * (3 - 2 * u)

// ── shared props ────────────────────────────────────────────────────────────
/** a tree: a trunk and tiers of leaves, the meadow's */
function tree(kit: Kit, leaves: number[], trunk = 0x8a5a36, th = 8, w = 9): THREE.Group {
  const g = new THREE.Group()
  const t = kit.box(2, th, 2, trunk, 0, th / 2, 0)
  g.add(t)
  const tiers: [number, number][] = [[w, 4.5], [w * 0.78, 4], [w * 0.5, 3.5]]
  let y = th - 1
  tiers.forEach(([tw, h], k) => { g.add(kit.box(tw, h, tw, leaves[k % leaves.length], 0, y + h / 2, 0)); y += h - 0.5 })
  return g
}
function rock(kit: Kit, r: () => number, colors: number[]): THREE.Mesh {
  const s = 1.5 + r() * 3
  return kit.box(s * (0.8 + r() * 0.6), s * 0.7, s, pick(r, colors), 0, s * 0.3, 0)
}
function flower(kit: Kit, color: number): THREE.Group {
  const g = new THREE.Group()
  g.add(kit.box(0.4, 1.4, 0.4, 0x3f8f3a, 0, 0.7, 0), kit.box(1, 0.8, 1, color, 0, 1.6, 0))
  return g
}
/** a scatter of `n` positions on the ground, `margin` in from the coast, not on the walkway */
/** tall things stay behind the walkway (the drone looks in from +z), so they never stand between the lens and a stone */
const BEHIND = 5
function scatter(ctx: BiomeCtx, inside: (x: number, z: number) => number, n: number, margin: number, avoid: THREE.Vector3[], keep = 6, zMax = 1e9, zMin = -1e9): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < n * 12 && out.length < n; k++) {
    const x = (ctx.r() - 0.5) * ctx.size * 2.4, z = (ctx.r() - 0.5) * ctx.size * 2.4
    if (z > zMax || z < zMin) continue
    if (inside(x, z) < margin) continue
    if (avoid.some((p) => Math.hypot(p.x - x, p.z - z) < keep)) continue
    out.push([x, z])
  }
  return out
}
function stand(g: THREE.Object3D, ground: Ground, x: number, z: number): void { g.position.set(x, ground.top(x, z), z) }
/** water spilling off the coast at (x, z) and falling to the sea, with a splash where it lands */
function spill(ctx: BiomeCtx, x: number, z: number, out: THREE.Vector3): void {
  const { kit } = ctx
  const fall = new CellField(48, 1.8, 3, 1.4, kit.glowMat(0xffffff))
  ctx.g.add(fall.mesh)
  const splash = new Bits(ctx.scene, new THREE.BoxGeometry(0.8, 0.8, 0.8), 0xe8fbff, 24, 12, 0.1, 0.6, 0, -1e9)
  const seaY = OCEAN_Y - ctx.at.y
  ctx.anim((t, dt) => {
    for (let k = 0; k < 48; k++) {
      const u = ((t * 0.55 + k / 48) % 1)
      const y = -1 - u * u * (2 - seaY) * 0.5 - u * (-seaY) * 0.5
      const c = (k + Math.floor(t * 10)) % 3 === 0 ? 0xffffff : 0x8fe3ff
      fall.set(k, x + out.x * (1.5 + u * 3) + Math.sin(k * 3.1) * 0.8, Math.max(seaY, y), z + out.z * (1.5 + u * 3), 1, c)
    }
    fall.commit()
    if (Math.random() < dt * 8) splash.spawn(v3(ctx.at.x + x + out.x * 4, OCEAN_Y + 1, ctx.at.z + z + out.z * 4), 2, t, v3(0, 5, 0), 5)
    splash.update(t, dt)
  })
}
/** the light coming down through the air: long thin panes, slowly swaying */
function sunShafts(ctx: BiomeCtx, n: number, spread: number, h = 60): void {
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.16, depthWrite: false })
  const shafts: [THREE.Mesh, number][] = []
  for (let k = 0; k < n; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2 + ctx.r() * 3, h, 0.3), mat)
    m.position.set((ctx.r() - 0.5) * spread, h * 0.45, (ctx.r() - 0.5) * spread)
    m.rotation.set(0.35, ctx.r() * 3, 0.3)
    ctx.g.add(m)
    shafts.push([m, ctx.r() * 7])
  }
  ctx.anim((t) => { for (const [m, ph] of shafts) { m.rotation.z = 0.3 + Math.sin(t * 0.3 + ph) * 0.06; m.visible = Math.sin(t * 0.5 + ph) > -0.6 } })
}
/** a wire slung from `a` to `b`, sagging `sag` in the middle; the points along it are handed back */
function wire(kit: Kit, g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, sag: number, color: number, n = 7): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const p = a.clone().lerp(b, u)
    p.y -= Math.sin(u * Math.PI) * sag
    pts.push(p)
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[i + 1]
    const w = kit.box(p.distanceTo(q), 0.12, 0.12, color, 0, 0, 0)
    w.position.copy(p).lerp(q, 0.5)
    w.lookAt(q); w.rotateY(Math.PI / 2)
    w.castShadow = false
    g.add(w)
  }
  return pts
}
/** a string of warm bulbs slung between two posts' tops */
function stringLights(kit: Kit, g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, bulbs: THREE.Mesh[]): void {
  const pts = wire(kit, g, a, b, 1.6, 0x3a2a1a)
  for (let i = 1; i < pts.length - 1; i++) { const p = pts[i]; const bl = kit.glow(0.7, 0.9, 0.7, 0xffd35a, p.x, p.y - 0.5, p.z); g.add(bl); bulbs.push(bl) }
}

// ── goose meadow: the home turf, cut loose ──────────────────────────────────
const GRASS = [0x6cbf4a, 0x62b344, 0x78c953, 0x5aa83e]
const PETALS = [0xffb3d9, 0xffe27a, 0xffffff, 0xffa26b]
const meadow: Biome = {
  id: 'meadow', name: 'GOOSE MEADOW', r: 44, tint: 0x6cbf4a,
  sky: [0x9ad4ff, 0xd9eeff, 0xbfe3ff, 0xfff1d6],
  islet: (kit, g, r) => { g.add(r() < 0.5 ? tree(kit, [0x3f8f3a, 0x4ea546, 0x5fb84f], 0x8a5a36, 5 + r() * 3, 6) : flower(kit, pick(r, PETALS))) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(11, ctx.size, 2)
    const spots = arcSpots(o.lobes[0].r, 3)
    const path = walkway(spots)
    // the pond sits against the coast on the far side, and spills over it
    const pond = (x: number, z: number) => ((x - 16) / 11) ** 2 + ((z + 20) / 7) ** 2 < 1
    const ground = buildGround(kit, {
      outline: o,
      top: (x, z, e) => e < 4 ? 0 : clamp(Math.round(1.1 * Math.sin(x * 0.11) + 1.0 * Math.cos(z * 0.13) + e / 30), 0, 4),
      color: (x, z) => {
        const d = path.reduce((m, _p, i) => i + 1 < path.length ? Math.min(m, segDist(path[i], path[i + 1], x, z)) : m, 1e9)
        if (d < 2.4) return 0xb08a5a
        return r() < 0.05 ? pick(r, PETALS) : pick(r, GRASS)
      },
      under: rockUnder(r, 1.5, 6),
      flat: { points: path, w: 3 },
      special: (x, z) => pond(x, z) ? { color: 0x5fb4e6, h: -1 } : null,
    }, g)
    const avoid = [...spots, v3(16, 0, -20)]
    for (const [x, z] of scatter(ctx, o.edge, 5, 9, avoid, 12, BEHIND)) {
      const t = tree(kit, [0x3f8f3a, 0x4ea546, 0x5fb84f], 0x8a5a36, 7 + r() * 3)
      stand(t, ground, x, z); g.add(t)
      const ph = r() * 7
      ctx.anim((tt) => { t.rotation.z = Math.sin(tt * 0.9 + ph) * 0.03 })
    }
    for (const [x, z] of scatter(ctx, o.edge, 7, 4, avoid)) { const k = rock(kit, r, [0x9a9ea8, 0xb4b8c0]); stand(k, ground, x, z); g.add(k) }
    for (const [x, z] of scatter(ctx, o.edge, 46, 3, avoid, 3)) { const f = flower(kit, pick(r, PETALS)); stand(f, ground, x, z); g.add(f) }
    // a fence along the walkway's far side
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1]
      const n = v3(-(b.z - a.z), 0, b.x - a.x).normalize()
      const len = a.distanceTo(b)
      for (let s = 0; s < len; s += 6) {
        const p = a.clone().lerp(b, s / len).addScaledVector(n, -5.5)
        if (o.edge(p.x, p.z) < 2) continue
        g.add(kit.box(0.8, 4, 0.8, 0xc9a06b, p.x, 2, p.z))
        const rail = kit.box(6, 0.6, 0.5, 0xc9a06b, p.x + (b.x - a.x) / len * 3, 2.6, p.z + (b.z - a.z) / len * 3)
        rail.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x)
        g.add(rail)
      }
    }
    // the signpost by the first stone
    const sp = spots[0].clone().add(v3(-4, 0, 4))
    g.add(kit.box(0.6, 5, 0.6, 0x8a5a36, sp.x, 2.5, sp.z), kit.box(4, 1.6, 0.5, 0xd9b77a, sp.x + 1.4, 4.4, sp.z))
    // butterflies and petals
    for (let k = 0; k < 4; k++) {
      const b = new THREE.Group()
      const c = PETALS[(k + 1) % PETALS.length]
      const l = kit.box(1, 0.15, 1.2, c, -0.5, 0, 0), rw = kit.box(1, 0.15, 1.2, c, 0.5, 0, 0)
      l.castShadow = rw.castShadow = false
      b.add(l, rw); g.add(b)
      const ph = r() * 7, cx = (r() - 0.5) * 40, cz = (r() - 0.5) * 40, rad = 6 + r() * 8
      ctx.anim((t) => {
        const a = t * 0.5 + ph
        b.position.set(cx + Math.cos(a) * rad, 5 + Math.sin(t * 2 + ph) * 1.5, cz + Math.sin(a) * rad)
        b.rotation.y = -a
        const flap = Math.sin(t * 14 + ph) * 0.9
        l.rotation.z = flap; rw.rotation.z = -flap
      })
    }
    // the waterfall: the pond spills off the coast and falls to the sea
    let fx = 16, fz = -20
    for (let k = 0; k < 40; k++) { const z = -20 - k * 0.5; if (o.edge(16, z) <= 1) { fz = z; break } }
    const fall = new CellField(48, 1.8, 3, 1.4, kit.glowMat(0xffffff))
    g.add(fall.mesh)
    const splash = new Bits(ctx.scene, new THREE.BoxGeometry(0.8, 0.8, 0.8), 0xe8fbff, 24, 12, 0.1, 0.6, 0, -1e9)
    const seaY = OCEAN_Y - ctx.at.y
    ctx.anim((t, dt) => {
      for (let k = 0; k < 48; k++) {
        const u = ((t * 0.55 + k / 48) % 1)
        const y = -1 - u * u * (2 - seaY) * 0.5 - u * (-seaY) * 0.5
        const c = (k + Math.floor(t * 10)) % 3 === 0 ? 0xffffff : 0x8fe3ff
        fall.set(k, fx + Math.sin(k * 3.1) * 0.8, Math.max(seaY, y), fz - 1.5 - u * 3, 1, c)
      }
      fall.commit()
      if (Math.random() < dt * 8) splash.spawn(v3(ctx.at.x + fx, OCEAN_Y + 1, ctx.at.z + fz - 4), 2, t, v3(0, 5, 0), 5)
      splash.update(t, dt)
    })
    sunShafts(ctx, 5, 60)
    return { ground, spots, outline: o, cam: { pos: v3(0, 42, 54), look: v3(0, 0, 4), fov: 38 }, land: { skid: 0x55702c, width: 1.1, wobble: 0.2, drag: 32, bounce: 0.36, bits: 0xc9c2a8, spray: 1 } }
  },
}
function segDist(a: THREE.Vector3, b: THREE.Vector3, x: number, z: number): number {
  const dx = b.x - a.x, dz = b.z - a.z
  const l2 = dx * dx + dz * dz
  const u = l2 > 0 ? clamp01(((x - a.x) * dx + (z - a.z) * dz) / l2) : 0
  return Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u))
}

// ── salt cove: the sea, the sand, the palms ─────────────────────────────────
const SAND = [0xf2e2b0, 0xecd9a3, 0xf6e7bb]
const cove: Biome = {
  id: 'cove', name: 'SALT COVE', r: 50, tint: 0xf2e2b0,
  sky: [0x8fd3ff, 0xdff3ff, 0xbfe9ff, 0xfff5dc],
  islet: (kit, g, r) => { g.add(r() < 0.6 ? palm(kit, r, 5 + r() * 3) : rock(kit, r, [0x9a9ea8, 0xb4b8c0])) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(23, ctx.size, 3, 1.2)
    const spots = arcSpots(o.lobes[0].r * 0.9, 5)
    const path = walkway(spots)
    const pool = (x: number, z: number) => ((x + 22) / 5) ** 2 + ((z - 14) / 3.5) ** 2 < 1
    const ground = buildGround(kit, {
      outline: o,
      top: (_x, _z, e) => e > 22 ? 1 : 0,
      color: (x, z, h, e) => {
        const d = path.reduce((m, _p, i) => i + 1 < path.length ? Math.min(m, segDist(path[i], path[i + 1], x, z)) : m, 1e9)
        if (d < 2.4) return pick(r, [0xf5c1b0, 0xf8dcc8, 0xd9c2e8, 0xfff0d8])
        return e < 3 ? 0xd6c08a : h > 0 ? pick(r, GRASS) : pick(r, SAND)
      },
      under: { depth: () => 4, color: () => 0xcbb381 },
      flat: { points: path, w: 3 },
      special: (x, z) => pool(x, z) ? { color: 0x39d6f0, h: -1 } : null,
    }, g)
    const avoid = [...spots]
    // palms on the knoll and along the beach, swaying; a coconut drops now and then
    const palms = scatter(ctx, o.edge, 7, 8, avoid, 9, BEHIND)
    for (const [x, z] of palms) {
      const p = palm(kit, r, 8 + r() * 4)
      stand(p, ground, x, z); g.add(p)
      const ph = r() * 7
      ctx.anim((t) => { p.rotation.z = Math.sin(t * 1.1 + ph) * 0.05; p.rotation.x = Math.cos(t * 0.8 + ph) * 0.03 })
    }
    const nuts = new Bits(ctx.scene, new THREE.BoxGeometry(1, 1, 1), 0x6b4a2b, 6, 40, 0.3, 1.4, 0, -1e9)
    ctx.anim((t, dt, near) => {
      if (near > 0.4 && Math.random() < dt * 0.25 && palms.length) {
        const [x, z] = pick(Math.random, palms)
        nuts.spawn(v3(ctx.at.x + x, ctx.at.y + ground.top(x, z) + 10, ctx.at.z + z), 1, t, v3(0, 0, 0), 1)
        ctx.cue('coconut')
      }
      nuts.update(t, dt)
    })
    // crabs: sideways, in bursts
    for (let k = 0; k < 6; k++) {
      const c = new THREE.Group()
      c.add(kit.box(2, 1, 1.5, 0xe84d3d, 0, 0.7, 0), kit.box(0.7, 0.6, 0.7, 0xff7a5a, 1.2, 0.9, -0.8), kit.box(0.7, 0.6, 0.7, 0xff7a5a, -1.2, 0.9, -0.8))
      for (const s of [-1, 1]) for (let l = 0; l < 3; l++) c.add(kit.box(0.3, 0.6, 0.3, 0xb8352a, -0.7 + l * 0.7, 0.3, s * 0.9))
      const e = kit.glow(0.3, 0.3, 0.3, 0x111111, 0.4, 1.3, -0.8); c.add(e, e.clone().translateX(-0.8))
      const spot = scatter(ctx, o.edge, 1, 2, avoid)[0] ?? [0, 0]
      const home = v3(spot[0], 0, spot[1])
      c.position.copy(home)
      g.add(c)
      let goal = home.clone(), pause = r() * 3, ph = r() * 7
      ctx.anim((t, dt) => {
        if (pause > 0) { pause -= dt; return }
        const d = goal.clone().sub(c.position).setY(0)
        if (d.length() < 0.5) {
          pause = 0.5 + r() * 2.5
          goal = home.clone().add(v3((r() - 0.5) * 14, 0, (r() - 0.5) * 14))
          if (o.edge(goal.x, goal.z) < 2) goal.copy(home)
          return
        }
        c.position.addScaledVector(d.normalize(), 9 * dt)
        c.position.y = ground.top(c.position.x, c.position.z) + Math.abs(Math.sin(t * 22 + ph)) * 0.2
        c.rotation.y = Math.atan2(d.x, d.z)   // sideways: the body is broad in x, it runs along z
      })
    }
    // gulls, high and wide; stones; shells; the pier
    for (let k = 0; k < 5; k++) {
      const b = new THREE.Group()
      const body = kit.box(1.6, 0.6, 0.7, 0xffffff, 0, 0, 0)
      const l = kit.box(0.5, 0.12, 2.2, 0xf0f0f0, 0, 0, -1.1), rw = kit.box(0.5, 0.12, 2.2, 0xf0f0f0, 0, 0, 1.1)
      const beak = kit.glow(0.5, 0.3, 0.3, 0xffb347, 1.0, 0, 0)
      b.add(body, l, rw, beak); g.add(b)
      const ph = r() * 7, rad = 26 + r() * 30, h = 16 + r() * 14, dir = r() < 0.5 ? 1 : -1
      ctx.anim((t) => {
        const a = (t * 0.28 + ph) * dir
        b.position.set(Math.cos(a) * rad, h + Math.sin(t * 0.7 + ph) * 2, Math.sin(a) * rad)
        b.rotation.y = -a - dir * Math.PI / 2
        const flap = Math.sin(t * 9 + ph)
        l.rotation.x = flap * 0.7; rw.rotation.x = -flap * 0.7
      })
    }
    for (const [x, z] of scatter(ctx, o.edge, 9, 3, avoid)) { const k = rock(kit, r, [0x9a9ea8, 0xb4b8c0, 0x7f8794]); stand(k, ground, x, z); g.add(k) }
    for (const [x, z] of scatter(ctx, o.edge, 22, 1, avoid, 2)) { const s = kit.box(0.7, 0.4, 0.7, pick(r, [0xffffff, 0xffc7d6, 0xffe1a8]), 0, 0.2, 0); stand(s, ground, x, z); g.add(s) }
    // the pier, out from the beach into the surf
    const pa = Math.PI * 0.2
    const px = Math.cos(pa), pz = Math.sin(pa)
    let start = 0
    for (let d = 0; d < 80; d += 1) if (o.edge(px * d, pz * d) < 3) { start = d; break }
    for (let d = start - 6; d < start + 22; d += 2.2) {
      const plank = kit.box(2.2, 0.5, 5, 0xb08a5a, px * d, 1.8, pz * d)
      plank.rotation.y = -pa
      g.add(plank)
      if (Math.round(d / 2.2) % 3 === 0) for (const s of [-1, 1]) g.add(kit.box(0.8, 6, 0.8, 0x8a5a36, px * d - pz * s * 2, -1, pz * d + px * s * 2))
    }
    // a post box by the pier's foot, a rowboat tied at its end
    const post = new THREE.Group()
    post.add(kit.box(1.6, 3.2, 1.6, 0xe0392b, 0, 1.6, 0), kit.box(1.9, 0.5, 1.9, 0xb42a1f, 0, 3.4, 0), kit.box(1.2, 0.3, 0.3, 0x222222, 0, 2.4, -0.85))
    stand(post, ground, px * (start - 4) - pz * 4, pz * (start - 4) + px * 4); g.add(post)
    const boat = new THREE.Group()
    boat.add(kit.box(7, 1.6, 3, 0xa8743e, 0, 0.8, 0), kit.box(5.4, 0.5, 2, 0xd9b77a, 0, 1.7, 0), kit.box(0.5, 1.2, 3, 0xd9b77a, -1, 1.5, 0), kit.box(0.5, 1.2, 3, 0xd9b77a, 1.5, 1.5, 0))
    boat.add(kit.box(0.25, 5, 0.25, 0x6b4a2b, 2.6, 3.4, 1.2).rotateZ(-0.6))
    const bx = px * (start + 18) - pz * 5, bz = pz * (start + 18) + px * 5
    boat.position.set(bx, OCEAN_Y - ctx.at.y + 0.6, bz); boat.rotation.y = -pa + 0.3
    g.add(boat)
    ctx.anim((t) => { boat.position.y = OCEAN_Y - ctx.at.y + 0.6 + Math.sin(t * 1.3) * 0.4; boat.rotation.z = Math.sin(t * 1.1) * 0.05; boat.rotation.x = Math.cos(t * 0.9) * 0.04 })
    // fish leaping out of the surf now and then
    const fishes = [0, 1].map(() => { const f = new THREE.Group(); f.add(kit.box(2.2, 0.9, 0.6, 0xff9a3d, 0, 0, 0), kit.box(0.8, 1.2, 0.2, 0xffb870, -1.4, 0, 0), kit.glow(0.25, 0.25, 0.25, 0x111111, 0.7, 0.2, 0.32)); f.visible = false; g.add(f); return { g: f, t0: -9, from: v3(0, 0, 0), dir: v3(1, 0, 0) } })
    const plops = new Bits(ctx.scene, new THREE.BoxGeometry(0.6, 0.6, 0.6), 0xeafdff, 30, 16, 0.2, 0.5, 0, -1e9)
    let nextFish = 2
    ctx.anim((t, dt, near) => {
      if (t > nextFish && near > 0.2) {
        nextFish = t + 2.5 + r() * 4
        const f = fishes.find((x) => !x.g.visible)
        if (f) {
          const a = r() * TAU, d = o.lobes[0].r + 10 + r() * 10
          f.from.set(Math.cos(a) * d, OCEAN_Y - ctx.at.y, Math.sin(a) * d)
          f.dir.set(-Math.sin(a), 0, Math.cos(a))
          f.t0 = t; f.g.visible = true
          plops.spawn(v3(ctx.at.x + f.from.x, OCEAN_Y + 1, ctx.at.z + f.from.z), 4, t, v3(0, 5, 0), 4)
        }
      }
      for (const f of fishes) {
        if (!f.g.visible) continue
        const u = (t - f.t0) / 1.1
        if (u >= 1) { f.g.visible = false; plops.spawn(v3(ctx.at.x + f.g.position.x, OCEAN_Y + 1, ctx.at.z + f.g.position.z), 5, t, v3(0, 5, 0), 4); continue }
        f.g.position.copy(f.from).addScaledVector(f.dir, u * 9)
        f.g.position.y = f.from.y + Math.sin(u * Math.PI) * 7
        f.g.rotation.y = Math.atan2(-f.dir.z, f.dir.x)
        f.g.rotation.z = (0.5 - u) * 1.6
      }
      plops.update(t, dt)
    })
    sunShafts(ctx, 6, 90, 70)
    // the surf: a band of water cells around the coast, waves rolling in, foam at the crest, spray where it meets the sand
    interface W { x: number; z: number; e: number }
    const cells: W[] = []
    const [bx0, bz0, bx1, bz1] = o.bounds
    for (let x = bx0 - 28; x <= bx1 + 28; x += CELL) for (let z = bz0 - 28; z <= bz1 + 28; z += CELL) {
      const e = o.edge(x + 1, z + 1)
      if (e > 0 || e < -26) continue
      cells.push({ x: x + 1, z: z + 1, e })
    }
    const surf = new CellField(cells.length, CELL, 1, CELL, kit.base.clone())
    surf.mesh.receiveShadow = true
    g.add(surf.mesh)
    const spray = new Bits(ctx.scene, new THREE.BoxGeometry(0.6, 0.6, 0.6), 0xffffff, 40, 16, 0.2, 0.5, 0, -1e9)
    const seaY = OCEAN_Y - ctx.at.y
    ctx.anim((t, dt, near) => {
      let sprays = 0
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]
        const ph = t * 1.5 + c.e * 0.42 + Math.sin(c.x * 0.09 + c.z * 0.07) * 0.6
        const s = Math.sin(ph)
        const crest = s > 0.55
        const y = seaY + Math.round((s * 0.9 + Math.sin(ph * 2.3) * 0.25) * 2) / 2
        const col = crest ? (c.e > -4 ? 0xffffff : 0xeafdff) : c.e > -6 ? 0x6ff0ff : c.e > -13 ? 0x2ab6e8 : c.e > -20 ? 0x1e8fd9 : 0x1e6fd9
        surf.set(i, c.x, y, c.z, 1, col)
        if (crest && c.e > -3 && near > 0.2 && sprays < 2 && Math.random() < dt * 0.6) {
          sprays += 1
          spray.spawn(v3(ctx.at.x + c.x, ctx.at.y + 1, ctx.at.z + c.z), 3, t, v3(0, 7, 0), 5)
        }
      }
      surf.commit()
      spray.update(t, dt)
    })
    return { ground, spots, outline: o, cam: { pos: v3(-8, 36, 62), look: v3(0, 0, 6), fov: 40 }, arriveFrom: { dir: v3(1, 0, 0.3).normalize(), drop: 26, reach: 120 }, land: { skid: 0xd9c48c, width: 1.6, wobble: 0.5, drag: 46, bounce: 0.2, bits: 0xf2e2b0, spray: 0.8 } }
  },
}
/** a coconut palm: a leaning stack of trunk blocks, fronds radiating from the crown, coconuts under them */
function palm(kit: Kit, r: () => number, h: number): THREE.Group {
  const g = new THREE.Group()
  const lean = (r() - 0.5) * 0.5
  const n = Math.round(h / 1.6)
  for (let i = 0; i < n; i++) g.add(kit.box(1.4, 1.7, 1.4, i % 2 ? 0x9a6a3e : 0x8a5a36, Math.sin(lean) * i * 1.2, i * 1.6 + 0.8, 0))
  const cx = Math.sin(lean) * (n - 1) * 1.2, cy = n * 1.6
  const crown = new THREE.Group()
  crown.position.set(cx, cy, 0)
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * TAU + r()
    const f = kit.box(7, 0.5, 2.2, k % 2 ? 0x3f9f3a : 0x4fbf46, 3.2, 0, 0)
    const arm = new THREE.Group()
    arm.rotation.y = a
    arm.rotation.z = -0.35 - r() * 0.3
    arm.add(f)
    crown.add(arm)
  }
  for (let k = 0; k < 3; k++) crown.add(kit.box(1.1, 1.1, 1.1, 0x6b4a2b, Math.cos(k * 2.1) * 1.2, -0.9, Math.sin(k * 2.1) * 1.2))
  g.add(crown)
  return g
}

// ── the vault: a lock, a door, and what it keeps ────────────────────────────
const vault: Biome = {
  id: 'vault', name: 'THE VAULT', r: 40, tint: 0x2a2f3c,
  sky: [0x141a2e, 0x232a44, 0x4a5a8a, 0x8fa0ff],
  islet: (kit, g, r) => { const b = kit.box(2 + r() * 2, 3 + r() * 4, 2 + r() * 2, 0x3a3646, 0, 2, 0); b.rotation.y = r(); g.add(b); g.add(kit.glow(0.6, 0.6, 0.6, r() < 0.5 ? 0xff3df0 : 0x4fd2ff, 0, 4.5, 0)) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(37, ctx.size, 1, 1.8)
    // the building: 40 deep (x), 56 wide (z), 22 tall, its door on the -x face
    const D = 40, W = 56, H = 22
    const inBuilding = (x: number, z: number) => Math.abs(x) < D / 2 + 1 && Math.abs(z) < W / 2 + 1
    const spots = [v3(-10, 0, -9), v3(0, 0, -11), v3(10, 0, -9), v3(-10, 0, 9), v3(0, 0, 11), v3(10, 0, 9)]
    const ground = buildGround(kit, {
      outline: o,
      top: (x, z, e) => inBuilding(x, z) ? 0 : e < 5 ? 0 : Math.round(r() * 2),
      color: (x, z) => inBuilding(x, z)
        ? ((Math.floor((x + 40) / 8) + Math.floor((z + 60) / 8)) % 2 ? 0x2a2f3c : 0x252a36)
        : ((Math.floor((x + 40) / 6) + Math.floor((z + 60) / 6)) % 2 ? 0x363c4b : 0x2f3542),
      under: { depth: (_x, _z, e) => 8 + e * 1.9 + r() * 5, color: (_x, _z, d) => d > 30 ? 0x2e2b38 : pick(r, [0x3a3646, 0x46425a, 0x33303f]) },
    }, g)
    // walls: steel, two thick; the front wall is two pillars and a lintel around the doorway
    const STEEL = 0x1f2430, TRIM = 0x3a4150
    g.add(kit.box(D, H, 2, STEEL, 0, H / 2, -W / 2), kit.box(D, H, 2, STEEL, 0, H / 2, W / 2), kit.box(2, H, W, STEEL, D / 2, H / 2, 0))
    g.add(kit.box(D + 2, 2, W + 2, STEEL, 0, H + 1, 0))
    const DOOR_W = 26, DOOR_H = 18
    const side = (W - DOOR_W) / 2
    g.add(kit.box(2, H, side, STEEL, -D / 2, H / 2, -W / 2 + side / 2), kit.box(2, H, side, STEEL, -D / 2, H / 2, W / 2 - side / 2))
    g.add(kit.box(2, H - DOOR_H, DOOR_W, STEEL, -D / 2, DOOR_H + (H - DOOR_H) / 2, 0))
    g.add(kit.box(3, 1.5, DOOR_W + 4, TRIM, -D / 2, DOOR_H + 0.75, 0), kit.box(3, DOOR_H + 2, 1.5, TRIM, -D / 2, DOOR_H / 2, -DOOR_W / 2 - 0.75), kit.box(3, DOOR_H + 2, 1.5, TRIM, -D / 2, DOOR_H / 2, DOOR_W / 2 + 0.75))
    // the door: two leaves that part, a wheel on the seam with eight bolts around it
    const leaves = [-1, 1].map((s) => {
      const leaf = new THREE.Group()
      leaf.add(kit.box(1.6, DOOR_H, DOOR_W / 2, 0x4a5262, 0, DOOR_H / 2, s * DOOR_W / 4))
      for (let k = 0; k < 3; k++) leaf.add(kit.box(0.5, DOOR_H - 3, 0.6, 0x2d3340, -0.9, DOOR_H / 2, s * (2 + k * 4)))
      leaf.add(kit.box(0.6, 2.2, 5, 0x2d3340, -0.9, 2.5, s * 5), kit.box(0.6, 2.2, 5, 0x2d3340, -0.9, DOOR_H - 2.5, s * 5))
      leaf.position.set(-D / 2 - 1.2, 0, 0)
      g.add(leaf)
      return leaf
    })
    const wheel = new THREE.Group()
    wheel.position.set(-D / 2 - 2.4, DOOR_H / 2, 0)
    const hubRing = kit.cyl(5.2, 5.2, 1.2, 0x4a5262, 12); hubRing.rotation.z = Math.PI / 2; wheel.add(hubRing)
    const hub = kit.cyl(2.2, 2.2, 1.8, 0x3a4150, 10); hub.rotation.z = Math.PI / 2; wheel.add(hub)
    const hubLight = kit.glow(0.6, 1.4, 1.4, 0xff3d5a, -1.1, 0, 0); wheel.add(hubLight)
    for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; wheel.add(kit.box(0.8, 0.8, 4.4, 0x8b95a8, 0, Math.sin(a) * 3, Math.cos(a) * 3).rotateX(-a)) }
    g.add(wheel)
    const bolts: THREE.Mesh[] = []
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + Math.PI / 8
      const b = kit.box(1.2, 1.4, 1.4, 0x9aa4b8, 0, 0, 0)
      b.position.set(-D / 2 - 1.6, DOOR_H / 2 + Math.sin(a) * 7.5, Math.cos(a) * 7.5)
      b.userData.a = a
      g.add(b)
      bolts.push(b)
    }
    // inside: floor strips, the hammers, the sludge, the vessels, the beams, the lights
    const strips: THREE.Mesh[] = []
    for (let k = -2; k <= 2; k++) {
      const s1 = kit.glow(D - 4, 0.3, 0.5, 0x1e5f6e, 0, 0.2, k * 11); const s2 = kit.glow(0.5, 0.3, W - 4, 0x1e5f6e, k * 8, 0.2, 0)
      g.add(s1, s2); strips.push(s1, s2)
    }
    const sparks = new Bits(ctx.scene, new THREE.BoxGeometry(0.4, 0.4, 0.4), 0xffde7b, 40, 30, 0.2, 0.35, 0, -1e9)
    const hammers: { head: THREE.Mesh; anvil: THREE.Mesh; belt: THREE.Mesh[]; ph: number; x: number; z: number; hit: boolean }[] = []
    for (const z of [-21, 21]) for (let i = 0; i < 4; i++) {
      const x = -13 + i * 8.6
      g.add(kit.box(1.2, 14, 1.2, 0x555e6e, x - 2.4, 7, z), kit.box(1.2, 14, 1.2, 0x555e6e, x + 2.4, 7, z), kit.box(6.4, 1.6, 1.8, 0x555e6e, x, 14.5, z))
      const anvil = kit.box(4.6, 2, 4.4, 0x2e3340, x, 1, z)
      const head = kit.box(3.6, 3, 3.6, 0x4a5060, x, 5, z)
      head.add(kit.glow(3.7, 0.5, 3.7, 0xff9a3d, 0, -1.3, 0))
      const belt: THREE.Mesh[] = []
      for (let b = 0; b < 8; b++) { const m = kit.glow(2.2, 0.3, 1, 0x3a4150, x - 7.7 + b * 2.2, 0.35, z + (z < 0 ? 4 : -4)); belt.push(m); g.add(m) }
      g.add(anvil, head)
      hammers.push({ head, anvil, belt, ph: (i * 0.37 + (z < 0 ? 0 : 0.5)) % 1, x, z, hit: false })
    }
    const pools: { bits: THREE.Mesh[]; bubbles: THREE.Mesh[]; x: number; z: number }[] = []
    for (const [x, z] of [[12, -14], [-14, 14]] as [number, number][]) {
      const bits = [kit.glow(7, 0.6, 5, 0x2fe35a, x, 0.3, z), kit.glow(5, 0.6, 7, 0x2fe35a, x + 2, 0.3, z + 2), kit.glow(4, 0.6, 4, 0x2fe35a, x - 2.5, 0.3, z - 1.5)]
      const bubbles = Array.from({ length: 6 }, (_, k) => kit.glow(0.7, 0.7, 0.7, 0x8dff9a, x + (r() - 0.5) * 6, 0.5 + k * 0.7, z + (r() - 0.5) * 5))
      g.add(...bits, ...bubbles)
      pools.push({ bits, bubbles, x, z })
    }
    const glass = new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.3, depthWrite: false })
    const blobs: { m: THREE.Group; ph: number; lamp: THREE.Mesh }[] = []
    for (const [x, z] of [[16, -4], [16, 4], [-16, -4], [-16, 4]] as [number, number][]) {
      const base = kit.box(4, 1.2, 4, 0x3a4150, x, 0.6, z)
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 8, 10), glass); tube.position.set(x, 5.2, z)
      const cap = kit.box(4, 0.8, 4, 0x3a4150, x, 9.6, z)
      const lamp = kit.glow(0.6, 0.6, 0.6, 0xff3d5a, x + 1.6, 1.4, z + 1.6)
      const b = new THREE.Group()
      b.add(kit.glow(1.6, 1.4, 1.6, 0xd64fff, 0, 0, 0), kit.glow(1.1, 0.9, 1.1, 0xe98cff, 0.4, 1.0, 0.3), kit.glow(0.35, 0.35, 0.35, 0x111111, 0.7, 0.2, 0.6))
      b.position.set(x, 4.5, z)
      g.add(base, tube, cap, lamp, b)
      blobs.push({ m: b, ph: r() * 7, lamp })
    }
    // the beams cross the hall corner to corner, near the roof
    const beams: { m: THREE.Mesh; pulses: THREE.Mesh[]; a: THREE.Vector3; b: THREE.Vector3 }[] = []
    for (const [dx, y] of [[10, 17], [-10, 19]] as [number, number][]) {
      const a = v3(-dx, y, -25), b = v3(dx, y, 25)
      for (const e of [a, b]) { g.add(kit.box(2, y + 1, 2, 0x555e6e, e.x, (y + 1) / 2, e.z)); g.add(kit.glow(2.4, 1, 2.4, 0xff3df0, e.x, y + 1, e.z)) }
      const m = kit.glow(0.9, 0.9, a.distanceTo(b), 0xff3df0, 0, 0, 0)
      m.position.copy(a).lerp(b, 0.5); m.lookAt(b)
      const pulses = Array.from({ length: 4 }, () => { const p = kit.glow(1.4, 1.4, 2.6, 0xffc6fb, 0, 0, 0); p.lookAt(b); return p })
      g.add(m, ...pulses)
      beams.push({ m, pulses, a, b })
    }
    // orange accents against the cyan: on the door frame, and as lit seams in the rock
    for (const z of [-DOOR_W / 2 - 1, DOOR_W / 2 + 1]) g.add(kit.glow(0.4, DOOR_H - 4, 0.6, 0xff8a3d, -D / 2 - 1.6, DOOR_H / 2, z))
    for (const z of [-DOOR_W / 2 + 4, DOOR_W / 2 - 4]) g.add(kit.glow(0.4, 0.6, 5, 0xff8a3d, -D / 2 - 1.6, DOOR_H + 0.7, z))
    for (let k = 0; k < 9; k++) { const a = r() * TAU, d = 24 + r() * 12; const seam = kit.glow(0.5, 0.5, 3 + r() * 4, 0xff8a3d, Math.cos(a) * d, ground.top(Math.cos(a) * d, Math.sin(a) * d) + 0.3, Math.sin(a) * d); seam.rotation.y = r() * 3; if (!inBuilding(seam.position.x, seam.position.z)) g.add(seam) }
    const warn: THREE.Mesh[] = []
    for (const [x, z] of [[-18, -26], [0, -26], [18, -26], [-18, 26], [0, 26], [18, 26]] as [number, number][]) { const l = kit.glow(1, 0.7, 0.5, 0xff3d5a, x, 17, z); g.add(l); warn.push(l) }
    g.add(kit.box(D - 4, 0.6, 3, 0x555e6e, 0, 12, W / 2 - 3), kit.box(D - 4, 0.3, 0.3, 0x8b95a8, 0, 14, W / 2 - 4.4))
    // the pads glow: a ring under each stone
    for (const s of spots) g.add(kit.glow(9, 0.25, 9, 0x1e5f6e, s.x, 0.15, s.z))
    // lamps either side of the door, and light inside: the toon ramp steps it, so it reads as painted light
    for (const z of [-DOOR_W / 2 - 3, DOOR_W / 2 + 3]) g.add(kit.glow(1.2, 2.4, 1.2, 0x8fe3ff, -D / 2 - 1.8, DOOR_H + 3, z))
    g.add(kit.glow(DOOR_W + 4, 0.6, 1, 0x8fe3ff, -D / 2 - 2, DOOR_H + 2, 0))
    for (const [x, y, z, c] of [[-8, 16, -12, 0x8fe3ff], [8, 16, 12, 0x8fe3ff], [12, 8, -14, 0x49f07a], [-14, 8, 14, 0x49f07a]] as [number, number, number, number][]) {
      const l = new THREE.PointLight(c, 260, 40, 1.8)
      l.position.set(x, y, z)
      g.add(l)
    }

    // the sequence: the wheel ticks round, the bolts draw in, the light goes green, the leaves part, the lights come up
    let t0 = -1
    let lastTick = -1
    let opened = 0
    let hit = 0
    ctx.anim((t, dt, near) => {
      // hammers
      for (const h of hammers) {
        const u = (t * 1.1 + h.ph) % 1
        const y = u < 0.72 ? lerp(0, 8.5, ease(u / 0.72)) : lerp(8.5, 0, ((u - 0.72) / 0.28) ** 2)
        h.head.position.y = 5 + y
        if (u > 0.97 && !h.hit) {
          h.hit = true
          h.anvil.scale.y = 0.8
          sparks.spawn(v3(ctx.at.x + h.x, ctx.at.y + 2.4, ctx.at.z + h.z), 5, t, v3(0, 5, 0), 8)
          if (near > 0.35 && t - hit > 0.16) { hit = t; ctx.cue('hammer') }
        }
        if (u < 0.5) h.hit = false
        h.anvil.scale.y += (1 - h.anvil.scale.y) * (1 - Math.exp(-dt * 12))
        const shift = Math.floor(t * 6) % 2
        h.belt.forEach((b, k) => { b.material = kit.glowMat((k + shift) % 2 ? 0x3a4150 : 0x2b303c) })
      }
      sparks.update(t, dt)
      // sludge: three greens in steps; bubbles climb and pop
      const gs = Math.floor(t * 3) % 3
      for (const p of pools) {
        for (const b of p.bits) b.material = kit.glowMat([0x2fe35a, 0x49f07a, 0x3bd868][gs])
        p.bubbles.forEach((b, k) => {
          b.position.y += dt * (1.2 + k * 0.2)
          if (b.position.y > 4.5 + k * 0.4) { b.position.y = 0.5; b.position.x = p.x + (r() - 0.5) * 6; b.position.z = p.z + (r() - 0.5) * 5 }
          b.scale.setScalar(b.position.y > 3.5 ? 1.4 : 1)
        })
      }
      // the specimens bob, their lamps blink
      for (const b of blobs) { b.m.position.y = 4.5 + Math.sin(t * 1.4 + b.ph) * 1.2; b.m.rotation.y = t * 0.6 + b.ph; b.lamp.visible = Math.floor(t * 2 + b.ph) % 2 === 0 }
      // the beams: pulses travel, the beam breathes in steps, the colour flickers
      for (const b of beams) {
        const step = Math.floor(t * 8) % 4
        b.m.scale.set(1 + step * 0.25, 1 + step * 0.25, 1)
        b.m.material = kit.glowMat(step === 3 ? 0xff7af7 : 0xff3df0)
        b.pulses.forEach((p, k) => {
          const u = (t * 0.7 + k / 4) % 1
          p.position.copy(b.a).lerp(b.b, u)
          p.scale.setScalar(0.8 + Math.abs(Math.sin(u * Math.PI)) * 0.6)
        })
      }
      warn.forEach((w, k) => { w.visible = Math.floor(t * 2.2 + k * 0.5) % 2 === 0 })
      // the lock and the door
      if (t0 >= 0) {
        const a = t - t0
        const tick = Math.min(4, Math.floor(a / 0.28))
        if (a < 1.3) {
          wheel.rotation.x = tick * (Math.PI / 5)
          if (tick !== lastTick) { lastTick = tick; if (tick > 0) ctx.cue('lock_tick') }
        } else if (a < 2.0) {
          const u = ease(clamp01((a - 1.3) / 0.6))
          for (const b of bolts) { const an = b.userData.a as number; b.position.y = DOOR_H / 2 + Math.sin(an) * lerp(7.5, 4.8, u); b.position.z = Math.cos(an) * lerp(7.5, 4.8, u) }
          if (opened === 0) { opened = 1; ctx.cue('lock_bolt') }
        } else {
          if (opened === 1) { opened = 2; hubLight.material = kit.glowMat(0x49f07a); ctx.cue('lock_open') }
          const u = ease(clamp01((a - 2.1) / 1.1))
          leaves[0].position.z = -DOOR_W / 2 * u; leaves[1].position.z = DOOR_W / 2 * u
          wheel.position.z = -DOOR_W / 2 * u
          bolts.forEach((b) => { b.position.z = Math.cos(b.userData.a as number) * 4.8 - DOOR_W / 2 * u })
          if (opened === 2 && u >= 1) { opened = 3; ctx.cue('door_thud') }
          const lit = a < 2.5 ? 0 : a < 2.8 ? 1 : a < 3.1 ? 2 : 3
          strips.forEach((s, k) => { s.material = kit.glowMat(k % 3 <= lit - 1 ? 0x4fd2ff : lit >= 3 ? 0x33b9e6 : 0x1e5f6e) })
        }
      }
    })
    return {
      ground, spots, outline: o,
      cam: { pos: v3(-62, 16, 16), look: v3(-D / 2, 8, 0), fov: 42 },
      camIn: { pos: v3(-32, 15, 2), look: v3(6, 1, -1), fov: 58 },
      arrive: (t) => { t0 = t; lastTick = -1; opened = 0; return 3.4 },
      leave: () => {
        t0 = -1
        leaves[0].position.z = 0; leaves[1].position.z = 0; wheel.position.z = 0; wheel.rotation.x = 0
        bolts.forEach((b) => { const an = b.userData.a as number; b.position.y = DOOR_H / 2 + Math.sin(an) * 7.5; b.position.z = Math.cos(an) * 7.5 })
        hubLight.material = kit.glowMat(0xff3d5a)
        strips.forEach((s) => { s.material = kit.glowMat(0x1e5f6e) })
      },
      arriveFrom: { dir: v3(1, 0, 0), drop: 5, reach: 70, lane: 8 },
      land: { skid: 0x4a5262, width: 0.8, wobble: 0.04, drag: 16, bounce: 0.5, bits: 0xffd35a, spray: 1.8 },
      // the building's walls and roof, from inside or out; the doorway is the one way through the -x face
      collide: (p, v, rr) => {
        const x0 = -D / 2, x1 = D / 2, z1 = W / 2
        if (p.x < x0 - 2 - rr || p.x > x1 + 2 + rr || Math.abs(p.z) > z1 + 2 + rr) return false
        const inDoor = Math.abs(p.z) < DOOR_W / 2 - rr && p.y < DOOR_H - rr
        let hit = false
        // the side walls, from inside
        if (Math.abs(p.z) > z1 - 1 - rr && Math.abs(p.z) < z1 + 1 && p.x > x0 && p.x < x1) { const s = Math.sign(p.z); p.z = s * (z1 - 1 - rr); v.z = -Math.abs(v.z) * s * 0.5; hit = true }
        // the back wall
        if (p.x > x1 - 1 - rr && p.x < x1 + 1 && Math.abs(p.z) < z1) { p.x = x1 - 1 - rr; v.x = -Math.abs(v.x) * 0.5; hit = true }
        // the front wall and its lintel, from either side, unless through the door
        if (!inDoor && Math.abs(p.z) < z1 + 1 && p.y < H + 1) {
          if (p.x > x0 - 2 - rr && p.x < x0 && v.x > 0) { p.x = x0 - 2 - rr; v.x = -v.x * 0.5; hit = true }
          else if (p.x < x0 + 1 + rr && p.x >= x0 && v.x < 0) { p.x = x0 + 1 + rr; v.x = -v.x * 0.5; hit = true }
        }
        // the roof, from inside
        if (p.y > H - 1 - rr && p.x > x0 && p.x < x1 && Math.abs(p.z) < z1 && v.y > 0) { p.y = H - 1 - rr; v.y = -v.y * 0.4; hit = true }
        return hit
      },
    }
  },
}

// ── dusk hills: terraces, a windmill, lanterns, fireflies ───────────────────
const TERRACE = [0xd9a441, 0xe0b24f, 0xc9923a, 0xb98038, 0xa66d30]
const dusk: Biome = {
  id: 'dusk', name: 'DUSK HILLS', r: 46, tint: 0xd9a441,
  sky: [0xf5b07a, 0xffd9b0, 0xffc9a0, 0xffb070],
  islet: (kit, g, r) => { g.add(r() < 0.7 ? tree(kit, [0xe0682e, 0xf29a3c, 0xc94a2a], 0x6e4a2a, 5 + r() * 3, 6) : kit.box(0.5, 2.4, 0.5, 0xe8c25a, 0, 1.2, 0)) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(41, ctx.size, 2)
    const spots = arcSpots(o.lobes[0].r, 7)
    const path = walkway(spots)
    const ground = buildGround(kit, {
      outline: o,
      top: (_x, _z, e) => Math.min(8, Math.floor(Math.max(0, e - 4) / 7) * 2),
      color: (_x, _z, h) => r() < 0.08 ? 0xd0613a : TERRACE[Math.min(TERRACE.length - 1, Math.floor(h / 2))],
      under: rockUnder(r, 1.3, 5),
      flat: { points: path, w: 3 },
    }, g)
    const avoid = [...spots]
    for (const [x, z] of scatter(ctx, o.edge, 7, 8, avoid, 10, BEHIND)) {
      const t = tree(kit, [0xe0682e, 0xf29a3c, 0xc94a2a], 0x6e4a2a, 6 + r() * 4, 8)
      stand(t, ground, x, z); g.add(t)
      const ph = r() * 7
      ctx.anim((tt) => { t.rotation.z = Math.sin(tt * 0.8 + ph) * 0.04 })
    }
    const tufts: [THREE.Mesh, number][] = []
    for (const [x, z] of scatter(ctx, o.edge, 60, 2, avoid, 2)) {
      const b = kit.box(0.5, 2.6, 0.5, pick(r, [0xe8c25a, 0xd9a441, 0xf0d070]), 0, 1.3, 0)
      const w = new THREE.Group(); w.add(b); stand(w, ground, x, z); g.add(w)
      tufts.push([b, r() * 7])
    }
    ctx.anim((t) => { for (const [b, ph] of tufts) b.rotation.z = 0.25 + Math.sin(t * 2.2 + ph) * 0.2 })
    // the windmill on the high ground
    const [wx, wz] = scatter(ctx, o.edge, 1, 16, avoid, 14, BEHIND)[0] ?? [0, -20]
    const mill = new THREE.Group()
    mill.add(kit.cyl(2.6, 3.4, 14, 0xd9c7a8, 8).translateY(7), kit.cyl(0.2, 3.6, 3, 0x8a4a2a, 8).translateY(15.4))
    mill.add(kit.box(1.4, 2.2, 0.6, 0x5a3a24, 0, 2, 3.4))
    const hub = new THREE.Group(); hub.position.set(0, 12, 3.4)
    for (let k = 0; k < 4; k++) { const blade = kit.box(1.4, 9, 0.3, 0xefe6d0, 0, 5, 0); blade.add(kit.box(0.4, 9, 0.35, 0x8a5a36, 0.6, 0, 0)); const arm = new THREE.Group(); arm.rotation.z = k * Math.PI / 2; arm.add(blade); hub.add(arm) }
    mill.add(hub)
    stand(mill, ground, wx, wz); g.add(mill)
    ctx.anim((_t, dt) => { hub.rotation.z += dt * 0.9 })
    // lanterns along the walkway, fireflies over the terraces
    const lamps: THREE.Mesh[] = []
    const posts: THREE.Vector3[] = []
    for (let i = 1; i < path.length - 1; i += 2) {
      const p = path[i].clone().add(v3(0, 0, -5.5))
      if (o.edge(p.x, p.z) < 2) continue
      g.add(kit.box(0.5, 7, 0.5, 0x5a3a24, p.x, 3.5, p.z), kit.box(1.4, 0.4, 1.4, 0x5a3a24, p.x, 7.2, p.z))
      const l = kit.glow(1, 1.2, 1, 0xffd35a, p.x, 6.4, p.z); g.add(l); lamps.push(l)
      posts.push(v3(p.x, 7.2, p.z))
    }
    for (let i = 0; i + 1 < posts.length; i++) stringLights(kit, g, posts[i], posts[i + 1], lamps)
    // a pond on the high ground spilling off the coast
    let sx = 0, sz = 0
    for (let k = 0; k < 60; k++) { const a = r() * TAU; const p = v3(Math.cos(a) * 30, 0, Math.sin(a) * 30); if (o.edge(p.x, p.z) > 1 && o.edge(p.x, p.z) < 5 && p.z < 0) { sx = p.x; sz = p.z; break } }
    if (sx || sz) { const n = v3(sx, 0, sz).normalize(); spill(ctx, sx, sz, n) }
    const flies = Array.from({ length: 16 }, () => ({ m: kit.glow(0.35, 0.35, 0.35, 0xf6ff7a), cx: (r() - 0.5) * 60, cz: (r() - 0.5) * 60, ph: r() * 7, h: 3 + r() * 6 }))
    for (const f of flies) g.add(f.m)
    // a balloon, tethered, bobbing
    const [bx, bz] = scatter(ctx, o.edge, 1, 10, [v3(wx, 0, wz), ...avoid], 12, BEHIND)[0] ?? [14, -14]
    const balloon = new THREE.Group()
    for (let k = 0; k < 6; k++) { const w = [5, 7.5, 8.5, 8.5, 7, 4.5][k]; balloon.add(kit.box(w, 1.6, w, k % 2 ? 0xe9503c : 0xfff1d0, 0, 7 + k * 1.6, 0)) }
    balloon.add(kit.box(2.6, 2, 2.6, 0x8a5a36, 0, 2.5, 0), kit.box(0.2, 4, 0.2, 0x5a3a24, 1, 5, 1), kit.box(0.2, 4, 0.2, 0x5a3a24, -1, 5, -1))
    const tether = kit.box(0.2, 16, 0.2, 0x5a3a24, 0, -6, 0); balloon.add(tether)
    balloon.position.set(bx, ground.top(bx, bz) + 15, bz); g.add(balloon)
    const by = balloon.position.y
    ctx.anim((t) => {
      balloon.position.y = by + Math.sin(t * 0.7) * 1.5
      balloon.position.x = bx + Math.sin(t * 0.45) * 1.2
      balloon.rotation.z = Math.sin(t * 0.45) * 0.04
      const flick = Math.floor(t * 9) % 4
      for (const l of lamps) l.material = kit.glowMat(flick === 0 ? 0xffb347 : 0xffd35a)
      for (const f of flies) {
        const a = t * 0.35 + f.ph
        f.m.position.set(f.cx + Math.cos(a) * 6 + Math.sin(t * 1.7 + f.ph) * 2, f.h + Math.sin(t * 1.1 + f.ph) * 1.5, f.cz + Math.sin(a * 1.3) * 6)
        f.m.visible = Math.sin(t * 2.6 + f.ph * 3) > 0.1
      }
    })
    return { ground, spots, outline: o, cam: { pos: v3(0, 44, 56), look: v3(0, 2, 4), fov: 38 }, land: { skid: 0xa66d30, width: 1.2, wobble: 0.3, drag: 34, bounce: 0.32, bits: 0xd9a441, spray: 1 } }
  },
}

// ── storm flats: basalt, rain, a beacon, lightning ──────────────────────────
const BASALT = [0x5b6470, 0x525a66, 0x676f7c, 0x4b525d]
const storm: Biome = {
  id: 'storm', name: 'STORM FLATS', r: 42, tint: 0x5b6470,
  sky: [0x5d6a78, 0x8c98a6, 0xaab6c4, 0xd8dee6],
  islet: (kit, g, r) => { g.add(r() < 0.5 ? deadTree(kit, r) : rock(kit, r, BASALT)) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(53, ctx.size, 2, 1.4)
    const spots = arcSpots(o.lobes[0].r, 9)
    const path = walkway(spots)
    const puddle = (x: number, z: number) => Math.sin(x * 0.5) * Math.cos(z * 0.45) > 0.78
    const ground = buildGround(kit, {
      outline: o,
      top: (_x, _z, e) => e > 6 && r() < 0.25 ? 1 : 0,
      color: () => pick(r, BASALT),
      under: { depth: (_x, _z, e) => 5 + e * 1.4 + r() * 3, color: () => pick(r, [0x4e5766, 0x454c58, 0x58616e]) },
      flat: { points: path, w: 3 },
      special: (x, z, e) => e > 4 && puddle(x, z) ? { color: 0x8aa0b8, h: -1 } : null,
    }, g)
    const avoid = [...spots]
    for (const [x, z] of scatter(ctx, o.edge, 6, 6, avoid, 10, BEHIND)) { const t = deadTree(kit, r); stand(t, ground, x, z); g.add(t) }
    for (const [x, z] of scatter(ctx, o.edge, 8, 3, avoid)) { const k = rock(kit, r, BASALT); stand(k, ground, x, z); g.add(k) }
    const grass: [THREE.Mesh, number][] = []
    for (const [x, z] of scatter(ctx, o.edge, 40, 2, avoid, 2)) {
      const b = kit.box(0.4, 2, 0.4, pick(r, [0x6f8a6a, 0x5f7a5c]), 0, 1, 0)
      const w = new THREE.Group(); w.add(b); stand(w, ground, x, z); g.add(w); grass.push([b, r() * 7])
    }
    // the beacon: a tower in red and white bands, a lamp that sweeps, a lightning rod on top
    const [tx, tz] = scatter(ctx, o.edge, 1, 14, avoid, 12, BEHIND)[0] ?? [-10, -16]
    const tower = new THREE.Group()
    for (let k = 0; k < 5; k++) tower.add(kit.box(5 - k * 0.5, 4, 5 - k * 0.5, k % 2 ? 0xc94a45 : 0xf0eee8, 0, 2 + k * 4, 0))
    tower.add(kit.box(3.6, 3, 3.6, 0x2e3340, 0, 21.5, 0), kit.box(4.4, 0.8, 4.4, 0x2e3340, 0, 23.4, 0), kit.box(0.3, 4, 0.3, 0x2e3340, 0, 25.6, 0))
    const rodTip = kit.glow(0.7, 0.7, 0.7, 0x8fa0b4, 0, 27.7, 0); tower.add(rodTip)
    const lampG = new THREE.Group(); lampG.position.y = 21.5
    lampG.add(kit.glow(1.6, 1.6, 1.6, 0xffe27a, 0, 0, 0), kit.glow(26, 0.8, 1.4, 0xfff1b0, 13, 0, 0))
    tower.add(lampG)
    stand(tower, ground, tx, tz); g.add(tower)
    avoid.push(v3(tx, 0, tz))
    // the keeper's shack: tin walls, a lit window, a chimney that smokes
    const [sx, sz] = scatter(ctx, o.edge, 1, 9, avoid, 11, BEHIND)[0] ?? [12, -14]
    const shack = new THREE.Group()
    shack.add(kit.box(9, 6, 7, 0x6f7784, 0, 3, 0), kit.box(2.2, 3.6, 0.4, 0x3a3f4a, -2.4, 1.8, 3.6))
    const roofL = kit.box(5.6, 0.6, 8.2, 0x4a505c, -2.3, 6.7, 0); roofL.rotation.z = 0.42
    const roofR = kit.box(5.6, 0.6, 8.2, 0x4a505c, 2.3, 6.7, 0); roofR.rotation.z = -0.42
    shack.add(roofL, roofR, kit.box(1.4, 3.8, 1.4, 0x3a3f4a, 2.6, 7.6, -1.6))
    shack.add(kit.glow(2.4, 2, 0.3, 0xffd35a, 1.6, 3.4, 3.65), kit.box(0.25, 2.1, 0.25, 0x2e3340, 1.6, 3.4, 3.85), kit.box(2.5, 0.25, 0.25, 0x2e3340, 1.6, 3.4, 3.85))
    shack.rotation.y = 0.25
    stand(shack, ground, sx, sz); g.add(shack)
    avoid.push(v3(sx, 0, sz))
    const chim = v3(2.6, 9.6, -1.6).applyAxisAngle(v3(0, 1, 0), shack.rotation.y).add(shack.position)
    const SMOKE = 12
    const smoke = new CellField(SMOKE, 1, 1, 1, kit.glowMat(0xa9aeb8))
    g.add(smoke.mesh)
    // barrels by the door, one over on its side
    const barrel = (): THREE.Group => {
      const b = new THREE.Group()
      const body = kit.cyl(0.9, 0.9, 1.9, 0x7a5a3a, 8); body.position.y = 0.95
      const b1 = kit.cyl(0.98, 0.98, 0.22, 0x3a3f4a, 8); b1.position.y = 0.5
      const b2 = kit.cyl(0.98, 0.98, 0.22, 0x3a3f4a, 8); b2.position.y = 1.4
      b.add(body, b1, b2)
      return b
    }
    ;[[-6, 0, 1.5, 0], [-6.2, 0, 3.7, 0], [-3.8, 0.9, 4.6, Math.PI / 2]].forEach(([ox, oy, oz, rz]) => {
      const b = barrel()
      const at = v3(ox, 0, oz).applyAxisAngle(v3(0, 1, 0), shack.rotation.y).add(shack.position)
      b.position.set(at.x, ground.top(at.x, at.z) + oy, at.z)
      b.rotation.z = rz; b.rotation.y = r() * 3
      g.add(b)
    })
    // a windsock and a spinning anemometer on masts
    const masts = scatter(ctx, o.edge, 2, 6, avoid, 7, BEHIND)
    const sock = new THREE.Group()
    if (masts[0]) {
      const m = new THREE.Group()
      m.add(kit.box(0.4, 10, 0.4, 0x8b95a8, 0, 5, 0))
      for (let k = 0; k < 4; k++) { const w = 1.5 - k * 0.25; sock.add(kit.box(2.2, w, w, k % 2 ? 0xf2f2f2 : 0xff6b3d, 1.3 + k * 2.2, -k * 0.3, 0)) }
      sock.position.y = 9.5
      m.add(sock)
      stand(m, ground, masts[0][0], masts[0][1]); g.add(m)
    }
    const hub = new THREE.Group()
    if (masts[1]) {
      const m = new THREE.Group()
      m.add(kit.box(0.3, 8, 0.3, 0x8b95a8, 0, 4, 0))
      for (let k = 0; k < 3; k++) {
        const arm = new THREE.Group()
        arm.add(kit.box(2.6, 0.18, 0.18, 0x2e3340, 1.3, 0, 0), kit.box(0.8, 0.8, 0.8, 0xe8ecf2, 2.6, 0, 0))
        arm.rotation.y = k * (TAU / 3)
        hub.add(arm)
      }
      hub.position.y = 8.2
      m.add(hub)
      stand(m, ground, masts[1][0], masts[1][1]); g.add(m)
    }
    // telegraph poles, leaning, the wires sagging between them
    const poleAt = scatter(ctx, o.edge, 3, 5, avoid, 9, BEHIND).sort((a, b) => a[0] - b[0])
    const tops: THREE.Vector3[] = []
    for (const [x, z] of poleAt) {
      const pole = new THREE.Group()
      pole.add(kit.box(0.7, 12, 0.7, 0x4a3b30, 0, 6, 0), kit.box(3.4, 0.4, 0.4, 0x4a3b30, 0, 10.8, 0), kit.glow(0.4, 0.5, 0.4, 0xd8f0ff, -1.3, 11.2, 0), kit.glow(0.4, 0.5, 0.4, 0xd8f0ff, 1.3, 11.2, 0))
      pole.rotation.z = (r() - 0.5) * 0.16
      stand(pole, ground, x, z); g.add(pole)
      tops.push(v3(x, pole.position.y + 11.3, z))
    }
    for (let k = 0; k + 1 < tops.length; k++) for (const side of [-1.3, 1.3]) wire(kit, g, tops[k].clone().add(v3(side, 0, 0)), tops[k + 1].clone().add(v3(side, 0, 0)), 2.2, 0x2e3340)
    // cairns, and a rowboat wrecked on the rocks
    for (const [x, z] of [...scatter(ctx, o.edge, 3, 3, avoid, 4, 1e9, 8), ...scatter(ctx, o.edge, 2, 3, avoid, 4)]) {
      const c = new THREE.Group()
      let y = 0
      for (const sz of [2.4, 1.8, 1.3, 0.9]) { c.add(kit.box(sz, 0.9, sz * (0.8 + r() * 0.4), pick(r, BASALT), (r() - 0.5) * 0.3, y + 0.45, 0)); y += 0.85 }
      stand(c, ground, x, z); g.add(c)
    }
    const [bx, bz] = scatter(ctx, o.edge, 1, 2.5, avoid, 8, 1e9, 10)[0] ?? [-20, 14]
    const boat = new THREE.Group()
    boat.add(kit.box(6.5, 1.5, 2.6, 0x5a4636, 0, 0.75, 0), kit.box(5.3, 1.2, 1.7, 0x2e2620, 0, 1.0, 0), kit.box(0.5, 0.3, 2.2, 0x7a5a3a, -0.6, 1.4, 0), kit.box(0.5, 0.3, 2.2, 0x7a5a3a, 1.6, 1.4, 0))
    const bow = kit.box(1.8, 1.4, 1.6, 0x5a4636, 3.7, 0.8, 0); bow.rotation.y = 0.5; boat.add(bow)
    boat.rotation.set(0, r() * 3, 0.32)
    stand(boat, ground, bx, bz); boat.position.y += 0.5; g.add(boat)
    // rings where the rain hits the wet ground
    const RINGS = 20
    const rings = new CellField(RINGS, 1, 0.2, 1, kit.glowMat(0xdde8f4))
    g.add(rings.mesh)
    const ringAt = scatter(ctx, o.edge, RINGS, 4, avoid, 2.5, 1e9, -6).map(([x, z]) => ({ x, z, y: ground.top(x, z) + 0.1, ph: r() * 7 }))
    // the cloud over it, the rain under that, and the bolt
    const cloud = new THREE.Group()
    for (let k = 0; k < 14; k++) { const w = 10 + r() * 14; cloud.add(kit.box(w, 4 + r() * 3, 7 + r() * 6, pick(r, [0x3d4452, 0x4a5262, 0x333945]), (r() - 0.5) * 70, r() * 6, (r() - 0.5) * 60)) }
    cloud.position.y = 26
    cloud.traverse((m) => { (m as THREE.Mesh).castShadow = false })
    g.add(cloud)
    const RAIN = 240
    const rain = new CellField(RAIN, 0.3, 3.2, 0.3, kit.glowMat(0x9fb4d0))
    g.add(rain.mesh)
    const drops = Array.from({ length: RAIN }, () => ({ x: (r() - 0.5) * 80, z: (r() - 0.5) * 70, y: r() * 34 }))
    const bolt = Array.from({ length: 7 }, () => kit.glow(0.9, 6, 0.9, 0xeafdff))
    for (const b of bolt) { b.visible = false; g.add(b) }
    let nextBolt = 2 + r() * 3, boltUntil = -1
    g.userData.flash = 0
    ctx.anim((t, dt, near) => {
      lampG.rotation.y = t * 1.6
      for (const [b, ph] of grass) b.rotation.z = 0.35 + Math.sin(t * 3.1 + ph) * 0.25
      cloud.position.x = Math.sin(t * 0.2) * 3
      sock.rotation.y = 0.3 + Math.sin(t * 2.3) * 0.35; sock.rotation.z = -0.12 + Math.sin(t * 3.7) * 0.1
      hub.rotation.y = t * 9
      for (let i = 0; i < SMOKE; i++) {
        const u = (t * 0.3 + i / SMOKE) % 1
        const s = 0.8 + u * 2.4
        smoke.place(i, chim.x + u * 7 + Math.sin(u * 6 + i) * 1.2, chim.y + u * 11, chim.z + Math.cos(u * 5 + i) * 0.9, s * (1 - u * 0.4), s, s)
      }
      smoke.commit(false)
      ringAt.forEach((rg, i) => {
        const u = (t * 1.1 + rg.ph) % 1
        const s = 1 + u * 4.5
        rings.place(i, rg.x, u < 0.5 ? rg.y : -9999, rg.z, 1, s, s)
      })
      rings.commit(false)
      rodTip.material = kit.glowMat(t < boltUntil || Math.floor(t * 5) % 7 === 0 ? 0xeafdff : 0x8fa0b4)
      for (let i = 0; i < RAIN; i++) {
        const d = drops[i]
        d.y -= dt * 46
        if (d.y < 0) { d.y = 26; d.x = (r() - 0.5) * 80; d.z = (r() - 0.5) * 70 }
        rain.place(i, d.x - d.y * 0.08, d.y, d.z)
      }
      rain.commit(false)
      if (t > nextBolt) {
        nextBolt = t + 2.5 + r() * 4
        boltUntil = t + 0.13
        let x = (r() - 0.5) * 50, z = (r() - 0.5) * 40
        for (let k = 0; k < 7; k++) {
          bolt[k].visible = true
          bolt[k].position.set(x, 26 - k * 4 - 2, z)
          bolt[k].rotation.z = (r() - 0.5) * 0.8
          x += (r() - 0.5) * 6; z += (r() - 0.5) * 6
        }
        if (near > 0.15) ctx.cue('thunder')
      }
      if (t > boltUntil) for (const b of bolt) b.visible = false
      g.userData.flash = t < boltUntil ? 1 : Math.max(0, (g.userData.flash as number) - dt * 5)
    })
    return { ground, spots, outline: o, cam: { pos: v3(0, 40, 54), look: v3(0, 0, 4), fov: 38 }, land: { skid: 0x3a414e, width: 1.0, wobble: 0.1, drag: 20, bounce: 0.4, bits: 0x9fb4d0, spray: 1.3 } }
  },
}
function deadTree(kit: Kit, r: () => number): THREE.Group {
  const g = new THREE.Group()
  const h = 6 + r() * 4
  g.add(kit.box(1.4, h, 1.4, 0x3d3a3a, 0, h / 2, 0))
  for (let k = 0; k < 3; k++) { const b = kit.box(0.7, 4, 0.7, 0x3d3a3a, 0, h - 1 - k * 1.5, 0); b.rotation.z = (k % 2 ? 1 : -1) * (0.6 + r() * 0.5); b.rotation.y = r() * 3; b.translateY(1.8); g.add(b) }
  return g
}

// ── night ruins: pillars, mushrooms, crystals, wisps ────────────────────────
const RUIN = [0x3f3a5a, 0x46405f, 0x3a4a4c, 0x2f2c44]
const ruins: Biome = {
  id: 'ruins', name: 'NIGHT RUINS', r: 40, tint: 0x3f3a5a,
  sky: [0x1c2340, 0x2c3660, 0x6d7cc0, 0x9aa8ff],
  islet: (kit, g, r) => { g.add(r() < 0.5 ? crystal(kit, r) : kit.box(2, 4 + r() * 3, 2, 0x8b86a8, 0, 3, 0)) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(67, ctx.size, 2)
    const spots = arcSpots(o.lobes[0].r, 11)
    const path = walkway(spots)
    const ground = buildGround(kit, {
      outline: o,
      top: (x, z, e) => e < 4 ? 0 : clamp(Math.round(Math.sin(x * 0.15) * Math.cos(z * 0.12) * 1.5 + 0.5), 0, 2),
      color: (x, z) => Math.sin(x * 0.21 + 1) * Math.cos(z * 0.19) > 0.45 ? 0x3e6b5c : pick(r, RUIN),
      under: { depth: (_x, _z, e) => 6 + e * 1.4 + r() * 3, color: () => pick(r, [0x2f2c44, 0x3a3652, 0x26243a]) },
      flat: { points: path, w: 3 },
    }, g)
    const avoid = [...spots]
    // pillars, some standing, some down; a wall; an arch
    for (const [x, z] of scatter(ctx, o.edge, 9, 5, avoid, 7, BEHIND)) {
      const p = new THREE.Group()
      const h = 6 + r() * 6
      for (let k = 0; k < Math.floor(h / 2); k++) p.add(kit.box(2.4, 2, 2.4, k % 2 ? 0x8b86a8 : 0x7c7898, 0, 1 + k * 2, 0))
      p.add(kit.box(3.2, 0.8, 3.2, 0x9d98b8, 0, 0.4, 0))
      if (r() < 0.35) { p.rotation.z = 1.35; p.rotation.y = r() * 6; p.position.y = 1.2 }
      stand(p, ground, x, z); if (p.rotation.z) p.position.y += 1.2
      g.add(p)
    }
    const [ax, az] = scatter(ctx, o.edge, 1, 12, avoid, 12, BEHIND)[0] ?? [10, -12]
    const arch = new THREE.Group()
    arch.add(kit.box(2.6, 12, 2.6, 0x8b86a8, -5, 6, 0), kit.box(2.6, 12, 2.6, 0x8b86a8, 5, 6, 0), kit.box(13, 2.4, 3, 0x7c7898, 0, 13, 0), kit.box(5, 1.2, 2.6, 0x9d98b8, 0, 14.8, 0))
    stand(arch, ground, ax, az); arch.rotation.y = r() * 3; g.add(arch)
    for (let k = 0; k < 3; k++) { const [x, z] = scatter(ctx, o.edge, 1, 5, avoid, 6, BEHIND)[0] ?? [0, 0]; const w = kit.box(8, 3 + r() * 3, 2, 0x7c7898, 0, 2, 0); w.rotation.y = r() * 3; stand(w, ground, x, z); g.add(w) }
    // mushrooms in threes, crystals, wisps
    const caps: THREE.Mesh[] = []
    for (const [x, z] of scatter(ctx, o.edge, 12, 3, avoid, 3)) {
      for (let k = 0; k < 3; k++) {
        const s = 0.6 + r() * 0.8
        const m = new THREE.Group()
        m.add(kit.box(0.6 * s, 2.2 * s, 0.6 * s, 0xd8d4e8, 0, 1.1 * s, 0))
        const cap = kit.glow(2 * s, 1 * s, 2 * s, 0x4fd2ff, 0, 2.4 * s, 0); m.add(cap); caps.push(cap)
        stand(m, ground, x + (k - 1) * 1.6, z + (k % 2) * 1.4); g.add(m)
      }
    }
    const crystals: THREE.Mesh[] = []
    const glints: THREE.Object3D[] = []
    for (const [x, z] of scatter(ctx, o.edge, 8, 4, avoid, 5)) {
      const c = crystal(kit, r); stand(c, ground, x, z); g.add(c)
      c.traverse((m) => { if (m.userData.core) crystals.push(m as THREE.Mesh); if (m.userData.glint) glints.push(m) })
    }
    const wisps = Array.from({ length: 5 }, () => ({ head: kit.glow(0.9, 0.9, 0.9, 0xeaffff), tail: [kit.glow(0.6, 0.6, 0.6, 0x9fefff), kit.glow(0.4, 0.4, 0.4, 0x4fd2ff)], cx: (r() - 0.5) * 50, cz: (r() - 0.5) * 50, ph: r() * 7 }))
    for (const w of wisps) g.add(w.head, ...w.tail)
    ctx.anim((t) => {
      const step = Math.floor(t * 4) % 4
      for (const c of caps) c.material = kit.glowMat(step < 2 ? 0x4fd2ff : 0x7fe6ff)
      for (const c of crystals) c.material = kit.glowMat(step === 3 ? 0xd9a6ff : 0xb266ff)
      CRYSTAL_HALO.opacity = 0.22 + (step % 2) * 0.1
      for (const gl of glints) { const u = (t * 0.6 + (gl.userData.ph as number)) % 1; gl.visible = u < 0.16; gl.rotation.z = t * 4 }
      for (const w of wisps) {
        const a = t * 0.6 + w.ph
        const p = (tt: number) => v3(w.cx + Math.sin(tt) * 12, 4 + Math.sin(tt * 2) * 2, w.cz + Math.sin(tt * 2) * 6)
        w.head.position.copy(p(a))
        w.tail[0].position.copy(p(a - 0.25)); w.tail[1].position.copy(p(a - 0.5))
      }
    })
    return { ground, spots, outline: o, cam: { pos: v3(0, 40, 52), look: v3(0, 0, 4), fov: 38 }, land: { skid: 0x2f5a4a, width: 1.1, wobble: 0.3, drag: 30, bounce: 0.36, bits: 0x9f8ccc, spray: 1 } }
  },
}
const HULL_WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })
const CRYSTAL_HALO = new THREE.MeshBasicMaterial({ color: 0xb266ff, transparent: true, opacity: 0.3, depthWrite: false })
/**
 * A cluster of crystals: six-sided spires with a white rim drawn round each
 * (a back-face hull, the goose's own ink trick), a line of shine down one
 * face, a glint at the tip that comes and goes, and a pool of their light
 * on the ground.
 */
function crystal(kit: Kit, r: () => number): THREE.Group {
  const g = new THREE.Group()
  const n = 3 + Math.floor(r() * 2)
  const halo = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.16, 5.5), CRYSTAL_HALO)
  halo.position.y = 0.1
  g.add(halo)
  for (let k = 0; k < n; k++) {
    const h = 2.5 + r() * 4.5, rb = 0.7 + r() * 0.5
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.18, rb, h, 6), kit.glowMat(k === 1 ? 0xd9a6ff : 0xb266ff))
    core.userData.core = true
    core.position.set((k - (n - 1) / 2) * 1.3, h / 2 - 0.3, (k % 2) * 0.9 - 0.4)
    core.rotation.set((r() - 0.5) * 0.5, r() * 3, (r() - 0.5) * 0.5)
    core.add(new THREE.Mesh(new THREE.CylinderGeometry(0.18 + 0.3, rb + 0.3, h + 0.5, 6), HULL_WHITE))
    core.add(kit.glow(0.16, h * 0.6, 0.12, 0xf3e6ff, rb * 0.4, h * 0.02, rb * 0.62))
    const glint = new THREE.Group()
    glint.add(kit.glow(1.8, 0.18, 0.18, 0xffffff, 0, 0, 0), kit.glow(0.18, 1.8, 0.18, 0xffffff, 0, 0, 0))
    glint.position.y = h / 2 + 0.3
    glint.visible = false
    glint.userData.glint = true; glint.userData.ph = r() * 7
    core.add(glint)
    g.add(core)
  }
  return g
}

// ── dawn steps: snow, pines, a fire, a hot spring ───────────────────────────
const snow: Biome = {
  id: 'snow', name: 'DAWN STEPS', r: 44, tint: 0xf4f8ff,
  sky: [0xf8c8d8, 0xffe6ee, 0xffd6e2, 0xffe0c0],
  islet: (kit, g, r) => { g.add(r() < 0.7 ? pine(kit, r, 5 + r() * 3) : rock(kit, r, [0x8d97a8, 0xb9c2d0])) },
  build: (ctx) => {
    const { kit, r, g } = ctx
    const o = blob(79, ctx.size, 2)
    const spots = arcSpots(o.lobes[0].r, 13)
    const path = walkway(spots)
    const lake = (x: number, z: number) => ((x + 18) / 9) ** 2 + ((z - 14) / 6) ** 2 < 1
    const ground = buildGround(kit, {
      outline: o,
      top: (x, z, e) => Math.min(12, Math.round(Math.max(0, e - 6) / 3.2 + Math.sin(x * 0.2) * 0.4 + Math.cos(z * 0.17) * 0.4)),
      color: (_x, _z, h, e) => (h % 3 === 2 && e > 10 && r() < 0.35) ? 0x8d97a8 : pick(r, [0xf4f8ff, 0xe6eefc, 0xfafcff]),
      under: { depth: (_x, _z, e) => 6 + e * 1.5 + r() * 3, color: (_x, _z, d) => d > 20 ? 0x6b7688 : pick(r, [0x8d97a8, 0x7c8798, 0x9ea8b8]) },
      flat: { points: path, w: 3 },
      special: (x, z) => lake(x, z) ? { color: 0xbfe6ff, h: 0 } : null,
    }, g)
    const avoid = [...spots, v3(-18, 0, 14)]
    for (const [x, z] of scatter(ctx, o.edge, 9, 6, avoid, 8, BEHIND)) { const p = pine(kit, r, 7 + r() * 5); stand(p, ground, x, z); g.add(p) }
    for (const [x, z] of scatter(ctx, o.edge, 6, 3, avoid)) { const k = rock(kit, r, [0x8d97a8, 0xb9c2d0]); stand(k, ground, x, z); g.add(k) }
    // the campfire by the first stone, the spring by the last, a snowman between
    const fp = spots[0].clone().add(v3(-3, 0, -6))
    const fire = new THREE.Group()
    for (let k = 0; k < 3; k++) { const l = kit.box(3.6, 0.8, 0.8, 0x6b4a2b, 0, 0.4, 0); l.rotation.y = k * 1.05; fire.add(l) }
    const flames = [kit.glow(1.6, 2.2, 1.6, 0xff9a3d, 0, 1.6, 0), kit.glow(1, 1.6, 1, 0xffde7b, 0.3, 2.6, 0.2), kit.glow(0.6, 1, 0.6, 0xffffff, -0.2, 3.4, -0.1)]
    fire.add(...flames)
    stand(fire, ground, fp.x, fp.z); g.add(fire)
    const smoke = new Bits(ctx.scene, new THREE.BoxGeometry(1.2, 1.2, 1.2), 0xb9c2d0, 20, -1.5, 0.6, 2.2, 0, -1e9)
    const radio = new THREE.Group()
    radio.add(kit.box(4.2, 2.4, 1.6, 0xb9c2d0, 0, 1.2, 0), kit.box(1.3, 1.3, 0.3, 0x2e3340, -1.2, 1.1, 0.9), kit.box(1.3, 1.3, 0.3, 0x2e3340, 1.2, 1.1, 0.9), kit.box(0.2, 2.2, 0.2, 0x2e3340, 1.6, 3.2, -0.3).rotateZ(-0.4))
    const led = kit.glow(0.4, 0.3, 0.2, 0x49f07a, 0, 2.0, 0.9); radio.add(led)
    radio.position.set(fp.x + 5, ground.top(fp.x + 5, fp.z + 2), fp.z + 2); radio.rotation.y = -0.6
    g.add(radio)
    ctx.anim((t) => { led.material = kit.glowMat(Math.floor(t * 4) % 2 ? 0x49f07a : 0xff3d5a); radio.scale.y = 1 + (Math.floor(t * 4) % 2) * 0.05 })
    const sp = spots[5].clone().add(v3(4, 0, 6))
    const spring = new THREE.Group()
    spring.add(kit.glow(6, 0.4, 5, 0x6ff0ff, 0, 0.3, 0), kit.glow(4, 0.4, 6.5, 0x6ff0ff, 1, 0.3, 0.5))
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; spring.add(kit.box(1.6, 1.2, 1.6, 0x8d97a8, Math.cos(a) * 4, 0.6, Math.sin(a) * 3.6)) }
    stand(spring, ground, sp.x, sp.z); g.add(spring)
    const steam = new Bits(ctx.scene, new THREE.BoxGeometry(1, 1, 1), 0xffffff, 20, -1.2, 0.5, 2.0, 0, -1e9)
    const [mx, mz] = scatter(ctx, o.edge, 1, 6, avoid, 6)[0] ?? [6, 8]
    const man = new THREE.Group()
    man.add(kit.box(3, 3, 3, 0xffffff, 0, 1.5, 0), kit.box(2.2, 2.2, 2.2, 0xffffff, 0, 3.8, 0), kit.box(1.6, 1.6, 1.6, 0xffffff, 0, 5.4, 0))
    man.add(kit.glow(0.9, 0.3, 0.3, 0xff8a3d, 1.1, 5.4, 0), kit.box(1.8, 0.3, 1.8, 0x222222, 0, 6.3, 0), kit.box(1.2, 1, 1.2, 0x222222, 0, 6.9, 0))
    man.add(kit.box(2.5, 0.3, 0.3, 0x6b4a2b, 1.6, 3.9, 0).rotateZ(0.5), kit.box(2.5, 0.3, 0.3, 0x6b4a2b, -1.6, 3.9, 0).rotateZ(-0.5))
    stand(man, ground, mx, mz); g.add(man)
    // snow, always
    const N = 260
    const flakes = new CellField(N, 0.5, 0.5, 0.5, kit.glowMat(0xffffff))
    g.add(flakes.mesh)
    const fl = Array.from({ length: N }, () => ({ x: (r() - 0.5) * 100, z: (r() - 0.5) * 100, y: r() * 36, ph: r() * 7 }))
    ctx.anim((t, dt) => {
      const step = Math.floor(t * 10) % 3
      flames.forEach((f, k) => { f.scale.y = [1, 1.3, 0.8][(k + step) % 3]; f.material = kit.glowMat([0xff9a3d, 0xffde7b, 0xff6a3d][(k + step) % 3]) })
      if (Math.random() < dt * 4) smoke.spawn(v3(ctx.at.x + fire.position.x, fire.position.y + ctx.at.y + 3.5, ctx.at.z + fire.position.z), 1, t, v3(0, 2.5, 0), 0.6)
      if (Math.random() < dt * 5) steam.spawn(v3(ctx.at.x + spring.position.x + (r() - 0.5) * 4, spring.position.y + ctx.at.y + 1, ctx.at.z + spring.position.z + (r() - 0.5) * 4), 1, t, v3(0, 2, 0), 0.5)
      smoke.update(t, dt); steam.update(t, dt)
      for (let i = 0; i < N; i++) {
        const f = fl[i]
        f.y -= dt * 5
        if (f.y < 0) { f.y = 36; f.x = (r() - 0.5) * 100; f.z = (r() - 0.5) * 100 }
        flakes.place(i, f.x + Math.sin(t * 0.8 + f.ph) * 2, f.y, f.z + Math.cos(t * 0.6 + f.ph) * 1.5)
      }
      flakes.commit(false)
    })
    return { ground, spots, outline: o, cam: { pos: v3(0, 46, 56), look: v3(0, 4, 2), fov: 38 }, land: { skid: 0xb4c2da, width: 2.4, wobble: 0.9, drag: 14, bounce: 0.15, bits: 0xffffff, spray: 1.4 } }
  },
}
function pine(kit: Kit, r: () => number, h: number): THREE.Group {
  const g = new THREE.Group()
  g.add(kit.box(1.4, h * 0.5, 1.4, 0x5a3a24, 0, h * 0.25, 0))
  const tiers = 3
  for (let k = 0; k < tiers; k++) {
    const w = 7 - k * 1.8, y = h * 0.35 + k * (h * 0.22)
    g.add(kit.box(w, h * 0.2, w, k % 2 ? 0x2f6b4a : 0x3a7d55, 0, y, 0))
    g.add(kit.box(w * 0.8, 0.8, w * 0.8, 0xffffff, 0, y + h * 0.1 + 0.4, 0))
  }
  g.add(kit.box(1.2, 1.4, 1.2, 0xffffff, 0, h * 0.35 + tiers * h * 0.22, 0))
  void r
  return g
}

/** the islands, in the order the pages visit them */
export const BIOMES: Biome[] = [meadow, dusk, cove, storm, ruins, vault, snow]
