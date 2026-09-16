/**
 * What an island is made of.
 *
 * An island is a blob of ground — columns of cells, two units square, the
 * meadow's grain — hanging in the sky on a cone of rock, or sitting in the
 * sea.  Its outline is not a circle: a few lobes, each a radius that wanders
 * with the angle (three sines of different orders), unioned, so the coast
 * bulges and pinches the way ground does.  Its top has relief the biome
 * chooses, flattened along the path the level stones stand on so the goose
 * has somewhere to walk.  Its underside deepens with the distance from the
 * edge, so it is a ragged cone, roots and all.
 *
 * The kit shares one toon material per colour (a box per prop would otherwise
 * be a material per prop), gives out unlit "glow" boxes for anything neon,
 * and an instanced field of cells for things that move in bulk: waves, rain,
 * snow, falling water.
 */
import * as THREE from 'three'
import { rng } from './goose_world'

/**
 * The stipple.  The reels this world is after shade their shadow sides with
 * painted dots; here the toon ramp's steps are crossed with an ordered
 * dither in the game's own pixels (the renderer is the pixel buffer, so
 * gl_FragCoord is a game pixel), so every terminator is a band of checkered
 * cells rather than a hard line.  Patched into the chunk every
 * MeshToonMaterial compiles from, once, before any of them do.
 */
THREE.ShaderChunk.gradientmap_pars_fragment = /* glsl */`
#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
float gooseBayer( vec2 p ) {
	// a 4×4 ordered dither, 0..1
	vec2 q = floor( mod( p, 4.0 ) );
	float x = q.x, y = q.y;
	float row = mod( y, 2.0 ), col = mod( x, 2.0 );
	// the classic 4×4 Bayer order: 0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5
	float a0 = ( row == 0.0 ) ? ( col == 0.0 ? 0.0 : 8.0 ) : ( col == 0.0 ? 12.0 : 4.0 );
	float xx = mod( floor( x * 0.5 ), 2.0 ), yy = mod( floor( y * 0.5 ), 2.0 );
	float a1 = ( yy == 0.0 ) ? ( xx == 0.0 ? 0.0 : 2.0 ) : ( xx == 0.0 ? 3.0 : 1.0 );
	return ( a0 + a1 + 0.5 ) / 16.0;
}
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	float k = dotNL * 0.5 + 0.5;
	#ifdef USE_GRADIENTMAP
		float band = 0.09;
		float lo = texture2D( gradientMap, vec2( k - band, 0.0 ) ).r;
		float hi = texture2D( gradientMap, vec2( k + band, 0.0 ) ).r;
		if ( lo != hi ) {
			float edge = floor( k * 4.0 + 0.5 ) / 4.0;
			float u = clamp( ( k - edge ) / ( 2.0 * band ) + 0.5, 0.0, 1.0 );
			return vec3( u > gooseBayer( gl_FragCoord.xy ) ? hi : lo );
		}
		return vec3( texture2D( gradientMap, vec2( k, 0.0 ) ).r );
	#else
		vec2 coord = vec2( k, 0.0 );
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}
`

/** the sea's surface */
export const OCEAN_Y = -40
export const CELL = 2

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const clamp01 = (u: number) => clamp(u, 0, 1)
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k
/** mix two packed colours */
export function mixHex(a: number, b: number, k: number): number {
  const r = lerp((a >> 16) & 255, (b >> 16) & 255, k), g = lerp((a >> 8) & 255, (b >> 8) & 255, k), bl = lerp(a & 255, b & 255, k)
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl)
}

// ── outlines ────────────────────────────────────────────────────────────────
export interface Lobe { cx: number; cz: number; r: number; wob: [number, number, number]; amp?: number }
export interface Outline {
  lobes: Lobe[]
  /** how far inside the coast (x, z) is, in units; negative outside */
  edge: (x: number, z: number) => number
  inside: (x: number, z: number) => boolean
  /** the rectangle that holds it */
  bounds: [number, number, number, number]
}
/** the radius of a lobe at angle `th` */
function lobeR(l: Lobe, th: number): number {
  const a = l.amp ?? 1
  return l.r * (1 + a * (0.16 * Math.sin(3 * th + l.wob[0]) + 0.1 * Math.sin(5 * th + l.wob[1]) + 0.06 * Math.sin(9 * th + l.wob[2])))
}
export function outline(lobes: Lobe[]): Outline {
  const edge = (x: number, z: number): number => {
    let best = -1e9
    for (const l of lobes) {
      const dx = x - l.cx, dz = z - l.cz
      const d = lobeR(l, Math.atan2(dz, dx)) - Math.hypot(dx, dz)
      if (d > best) best = d
    }
    return best
  }
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9
  for (const l of lobes) {
    const rr = l.r * 1.35
    x0 = Math.min(x0, l.cx - rr); x1 = Math.max(x1, l.cx + rr); z0 = Math.min(z0, l.cz - rr); z1 = Math.max(z1, l.cz + rr)
  }
  return { lobes, edge, inside: (x, z) => edge(x, z) > 0, bounds: [x0, z0, x1, z1] }
}
/** a natural blob of about radius `r`: a main lobe and one or two side lobes, from a seed */
export function blob(seed: number, r: number, extra = 2, amp = 1): Outline {
  const q = rng(seed)
  const lobes: Lobe[] = [{ cx: 0, cz: 0, r, wob: [q() * 7, q() * 7, q() * 7], amp }]
  for (let i = 0; i < extra; i++) {
    const a = q() * Math.PI * 2, d = r * (0.45 + q() * 0.35)
    lobes.push({ cx: Math.cos(a) * d, cz: Math.sin(a) * d, r: r * (0.4 + q() * 0.3), wob: [q() * 7, q() * 7, q() * 7], amp })
  }
  return outline(lobes)
}

// ── materials and boxes ─────────────────────────────────────────────────────
export class Kit {
  private mats = new Map<number, THREE.MeshToonMaterial>()
  private glows = new Map<number, THREE.MeshBasicMaterial>()
  constructor(readonly base: THREE.MeshToonMaterial) {}
  mat(color: number): THREE.MeshToonMaterial {
    let m = this.mats.get(color)
    if (!m) { m = this.base.clone(); m.color.setHex(color); this.mats.set(color, m) }
    return m
  }
  glowMat(color: number): THREE.MeshBasicMaterial {
    let m = this.glows.get(color)
    if (!m) { m = new THREE.MeshBasicMaterial({ color }); this.glows.set(color, m) }
    return m
  }
  /** a lit box */
  box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color))
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
  /** an unlit box: neon, lamps, water light */
  glow(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.glowMat(color))
    m.position.set(x, y, z)
    return m
  }
  /** a lit cylinder (the toon look wants few segments) */
  cyl(rt: number, rb: number, h: number, color: number, seg = 10): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), this.mat(color))
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
}

// ── the ground ──────────────────────────────────────────────────────────────
export interface GroundSpec {
  outline: Outline
  /** relief above the island's base, in whole units */
  top: (x: number, z: number, edge: number) => number
  color: (x: number, z: number, h: number, edge: number) => number
  /** the underside: how deep the rock goes at (x, z), and its colour; none for an island that sits on something */
  under?: { depth: (x: number, z: number, edge: number) => number; color: (x: number, z: number, d: number) => number }
  /** the walkway: cells within `w` of the polyline are flattened to 0 */
  flat?: { points: THREE.Vector3[]; w: number }
  /** cells that are something else (water, a hole) — return a colour and a height, or null for ground */
  special?: (x: number, z: number, edge: number) => { color: number; h: number } | null
}
export interface Ground {
  tops: THREE.InstancedMesh
  under: THREE.InstancedMesh | null
  /** the ground's height at (x, z), island-relative */
  top: (x: number, z: number) => number
  cells: number
}
/** distance from (x, z) to the polyline */
function polyDist(p: THREE.Vector3[], x: number, z: number): number {
  let best = 1e9
  for (let i = 0; i + 1 < p.length; i++) {
    const ax = p[i].x, az = p[i].z, bx = p[i + 1].x, bz = p[i + 1].z
    const dx = bx - ax, dz = bz - az
    const l2 = dx * dx + dz * dz
    const u = l2 > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / l2) : 0
    best = Math.min(best, Math.hypot(x - (ax + dx * u), z - (az + dz * u)))
  }
  return best
}
export function buildGround(kit: Kit, spec: GroundSpec, g: THREE.Group): Ground {
  const [x0, z0, x1, z1] = spec.outline.bounds
  const gx0 = Math.floor(x0 / CELL), gx1 = Math.ceil(x1 / CELL), gz0 = Math.floor(z0 / CELL), gz1 = Math.ceil(z1 / CELL)
  const heights = new Map<number, number>()
  const key = (gx: number, gz: number) => gx * 4096 + gz + 2048
  interface C { x: number; z: number; h: number; c: number; e: number; special: boolean }
  const list: C[] = []
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const x = gx * CELL + 1, z = gz * CELL + 1
    const e = spec.outline.edge(x, z)
    if (e <= 0) continue
    const sp = spec.special?.(x, z, e) ?? null
    let h: number, c: number
    if (sp) { h = sp.h; c = sp.color }
    else {
      h = Math.max(0, Math.round(spec.top(x, z, e)))
      if (spec.flat && polyDist(spec.flat.points, x, z) < spec.flat.w) h = 0
      else if (spec.flat && polyDist(spec.flat.points, x, z) < spec.flat.w + 3) h = Math.min(h, 1)
      c = spec.color(x, z, h, e)
    }
    heights.set(key(gx, gz), h)
    list.push({ x, z, h, c, e, special: !!sp })
  }
  const mat = kit.base.clone()
  const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, 1, CELL), mat, Math.max(1, list.length))
  tops.receiveShadow = true
  tops.castShadow = false
  const m = new THREE.Matrix4()
  const col = new THREE.Color()
  list.forEach((c, i) => {
    // the slab: from two below the base up to the relief, so a step shows its side
    const bottom = -2, topY = c.h
    m.makeScale(1, topY - bottom, 1)
    m.setPosition(c.x, (topY + bottom) / 2, c.z)
    tops.setMatrixAt(i, m)
    tops.setColorAt(i, col.setHex(c.c))
  })
  tops.instanceMatrix.needsUpdate = true
  if (tops.instanceColor) tops.instanceColor.needsUpdate = true
  g.add(tops)
  let under: THREE.InstancedMesh | null = null
  if (spec.under) {
    const u = spec.under
    under = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, 1, CELL), kit.base.clone(), Math.max(1, list.length))
    under.castShadow = false
    under.receiveShadow = false
    list.forEach((c, i) => {
      const d = Math.max(1, Math.round(u.depth(c.x, c.z, c.e)))
      m.makeScale(1, d, 1)
      m.setPosition(c.x, -2 - d / 2, c.z)
      under!.setMatrixAt(i, m)
      under!.setColorAt(i, col.setHex(u.color(c.x, c.z, d)))
    })
    under.instanceMatrix.needsUpdate = true
    if (under.instanceColor) under.instanceColor.needsUpdate = true
    g.add(under)
  }
  const top = (x: number, z: number): number => heights.get(key(Math.floor((x - 1) / CELL + 0.5), Math.floor((z - 1) / CELL + 0.5))) ?? 0
  return { tops, under, top, cells: list.length }
}

// ── cells that move ─────────────────────────────────────────────────────────
/** an instanced field of boxes the owner repositions every frame */
export class CellField {
  readonly mesh: THREE.InstancedMesh
  private readonly m = new THREE.Matrix4()
  private readonly col = new THREE.Color()
  constructor(n: number, w: number, h: number, d: number, mat: THREE.Material, shadows = false) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, d), mat, n)
    this.mesh.castShadow = shadows
    this.mesh.receiveShadow = shadows
    this.mesh.frustumCulled = false
    for (let i = 0; i < n; i++) this.set(i, 0, -9999, 0, 1, 0xffffff)
    this.commit()
  }
  set(i: number, x: number, y: number, z: number, sy: number, color: number, sx = 1, sz = 1): void {
    this.m.makeScale(sx, sy, sz)
    this.m.setPosition(x, y, z)
    this.mesh.setMatrixAt(i, this.m)
    this.mesh.setColorAt(i, this.col.setHex(color))
  }
  /** a placed and turned cell (the colour stays) */
  placeQ(i: number, pos: THREE.Vector3, q: THREE.Quaternion, sx = 1, sy = 1, sz = 1): void {
    this.m.compose(pos, q, this.tmpS.set(sx, sy, sz))
    this.mesh.setMatrixAt(i, this.m)
  }
  private readonly tmpS = new THREE.Vector3()
  /** move only (the colour stays) */
  place(i: number, x: number, y: number, z: number, sy = 1, sx = 1, sz = 1): void {
    this.m.makeScale(sx, sy, sz)
    this.m.setPosition(x, y, z)
    this.mesh.setMatrixAt(i, this.m)
  }
  commit(colors = true): void {
    this.mesh.instanceMatrix.needsUpdate = true
    if (colors && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

// ── the island ──────────────────────────────────────────────────────────────
export interface CamPose { pos: THREE.Vector3; look: THREE.Vector3; fov: number }
/** an island's light: sky, fog, sky light, sun */
export type Palette = [number, number, number, number]

export interface Island {
  id: string
  name: string
  g: THREE.Group
  /** the island's base point, world space: the level of its walkway */
  at: THREE.Vector3
  r: number
  /** where the six level stones stand, world space, on the walkway */
  spots: THREE.Vector3[]
  /** the drone's mark over the island, and — after `arrive` — where it goes in */
  cam: CamPose
  camIn?: CamPose
  sky: Palette
  /** true if world (x, z) is over this island's ground */
  inside: (x: number, z: number) => boolean
  /** the ground's height at world (x, z), world space */
  top: (x: number, z: number) => number
  /** one frame: `near` is 0 far away, 1 with the drone over it */
  tick: (t: number, dt: number, near: number) => void
  /** the drone has arrived: a sequence that takes this many seconds (the vault's lock) */
  arrive?: (t: number) => number
  /** the island is left: undo the arrival */
  leave?: () => void
}

export interface BiomeCtx {
  kit: Kit
  scene: THREE.Scene
  g: THREE.Group
  r: () => number
  at: THREE.Vector3
  size: number
  /** a named cue for the shell (a sound) */
  cue: (name: string) => void
  /** register a per-frame update */
  anim: (fn: (t: number, dt: number, near: number) => void) => void
}

/** six spots along a gentle S across the island, island-relative */
export function arcSpots(r: number, seed: number, y = 0): THREE.Vector3[] {
  const q = rng(seed)
  const out: THREE.Vector3[] = []
  const ph = q() * 6
  for (let i = 0; i < 6; i++) {
    const u = i / 5
    out.push(new THREE.Vector3(-r * 0.58 + r * 1.16 * u, y, Math.sin(u * 3.2 + ph) * r * 0.22))
  }
  return out
}

/** the stroke of the walkway through the spots, extended a step past each end */
export function walkway(spots: THREE.Vector3[]): THREE.Vector3[] {
  const a = spots[0].clone().sub(spots[1]).setLength(6).add(spots[0])
  const b = spots[spots.length - 1].clone().sub(spots[spots.length - 2]).setLength(6).add(spots[spots.length - 1])
  return [a, ...spots, b]
}

/** a rock cone under a floating island: deeper toward the middle, ragged */
export function rockUnder(r: () => number, depthK = 1.4, base = 5): GroundSpec['under'] {
  const ROCK = [0x7d6858, 0x8c7462, 0x6b5a4e, 0x9a806c]
  return {
    depth: (_x, _z, e) => base + e * depthK + r() * 3 + (e > 8 ? Math.sin(_x * 0.3) * Math.cos(_z * 0.27) * 3 : 0),
    color: (_x, _z, d) => d > 22 ? ROCK[2] : ROCK[Math.floor(r() * ROCK.length)],
  }
}

/** a slow drift: a sum of two sines, 0..1 */
export const drift = (t: number, a: number, b: number, ph = 0): number => 0.5 + 0.25 * Math.sin(t * a + ph) + 0.25 * Math.sin(t * b + ph * 1.7)
