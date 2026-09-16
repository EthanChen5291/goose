/**
 * The small things that fly off the goose: emoticons, feathers, dust.
 *
 * Emoticons are the game's own idiom — a "!" over a startled head, a "?" for a
 * look-around, a note for a honk, the vein-pop for a >:( — drawn here as
 * little voxel glyphs from bitmaps at about a game pixel a cell, shaded down
 * one side and ringed in one pixel of dark-purple ink, so they are the same
 * kind of thing as the rest of the pixel world.  They pop in with a lean,
 * face the camera and drift up for most of a second.
 *
 * Feathers and dust are pooled boxes with a velocity: feathers flutter and
 * fall slowly, dust puffs out and drops.  Nothing fades — pixel art has no
 * alpha — things simply stop being there.
 */
import * as THREE from 'three'

export type EmoteKind = 'bang' | 'quest' | 'note' | 'grr' | 'star'

/**
 * The glyphs: `1` the colour, `2` its shade (down the right and along the
 * bottom, so the thing has a side), `3` a highlight up the left.  Drawn at
 * about one game pixel a cell, so the ink around them is one pixel — a line,
 * not a slab.  The "!" leans, the "?" hooks, the note beams, the vein-pop is
 * four fat lobes round a hollow, the star is the five-point one.
 */
const GLYPHS: Record<EmoteKind, string[]> = {
  bang: [
    '...1111.',
    '..311112',
    '..311122',
    '..311122',
    '..31122.',
    '..31122.',
    '...1122.',
    '...112..',
    '...112..',
    '...12...',
    '........',
    '...11...',
    '..3112..',
    '..1122..',
  ],
  quest: [
    '..11111..',
    '.3111112.',
    '.311.1122',
    '.112..112',
    '......112',
    '.....1122',
    '....1122.',
    '...1122..',
    '...112...',
    '...12....',
    '.........',
    '...11....',
    '..3112...',
    '..1122...',
  ],
  note: [
    '....11...',
    '....311..',
    '....3111.',
    '....31.12',
    '....31.12',
    '....31..2',
    '....31...',
    '....31...',
    '.11131...',
    '31111112.',
    '31111122.',
    '.111122..',
    '..1122...',
  ],
  grr: [
    '..311.311..',
    '.3111.1112.',
    '.3111.1112.',
    '..11...12..',
    '...........',
    '...........',
    '..11...11..',
    '.3111.1112.',
    '.1111.1112.',
    '..112.122..',
  ],
  star: [
    '.....1.....',
    '....313....',
    '....311....',
    '11131111112',
    '.311111112.',
    '..1111122..',
    '..1111122..',
    '.111.2.112.',
    '.11.....12.',
    '.1.......2.',
  ],
}
const COLORS: Record<EmoteKind, number> = { bang: 0xffde7b, quest: 0xfff8f0, note: 0x8fe3ff, grr: 0xff5c7a, star: 0xffde7b }
/** the ink round an emote: a dark purple, softer than the goose's black */
const EMOTE_INK = 0x2a1b3d
/** the shade: the colour pulled toward the kit's purple */
const SHADE_TO = 0x6a4796

function mixHex(a: number, b: number, k: number): number {
  const ca = [(a >> 16) & 255, (a >> 8) & 255, a & 255], cb = [(b >> 16) & 255, (b >> 8) & 255, b & 255]
  const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * k))
  return (m[0] << 16) | (m[1] << 8) | m[2]
}

/** one glyph as an instanced mesh of cubes: colour, shade and highlight cells, a one-cell ring of ink */
function glyphMesh(rows: string[], color: number, cell: number): THREE.InstancedMesh {
  const h = rows.length, w = rows[0].length
  const at = (x: number, y: number): string => (x >= 0 && y >= 0 && x < w && y < h ? rows[y][x] : '.')
  const on = (x: number, y: number): boolean => at(x, y) !== '.'
  const tone: Record<string, number> = { '1': color, '2': mixHex(color, SHADE_TO, 0.5), '3': mixHex(color, 0xffffff, 0.55) }
  const cells: [number, number, number][] = []
  for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
    if (on(x, y)) cells.push([x, y, tone[at(x, y)]])
    else if (on(x + 1, y) || on(x - 1, y) || on(x, y + 1) || on(x, y - 1)) cells.push([x, y, EMOTE_INK])
  }
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(cell, cell, cell * 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff }), cells.length)
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  cells.forEach(([x, y, col], i) => {
    m.makeTranslation((x - (w - 1) / 2) * cell, ((h - 1) / 2 - y) * cell, 0)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.setHex(col))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.frustumCulled = false
  return mesh
}

interface Live { mesh: THREE.InstancedMesh; kind: EmoteKind; born: number; at: THREE.Vector3; orbit: number; phase: number }

export class Emotes {
  private pool: Record<EmoteKind, THREE.InstancedMesh[]>
  private live: Live[] = []
  constructor(scene: THREE.Scene, private cell = 0.55) {
    this.pool = { bang: [], quest: [], note: [], grr: [], star: [] }
    for (const k of Object.keys(GLYPHS) as EmoteKind[]) {
      const proto = glyphMesh(GLYPHS[k], COLORS[k], cell)
      for (let i = 0; i < 5; i++) {
        const m = i === 0 ? proto : proto.clone()
        m.visible = false
        scene.add(m)
        this.pool[k].push(m)
      }
    }
  }
  /** show `kind` at `at` (world), rising; `orbit` > 0 circles the point instead (the stars) */
  show(kind: EmoteKind, at: THREE.Vector3, now: number, orbit = 0, phase = 0): void {
    const m = this.pool[kind].find((x) => !x.visible)
    if (!m) return
    m.visible = true
    m.position.copy(at)
    this.live.push({ mesh: m, kind, born: now, at: at.clone(), orbit, phase })
  }
  /** `pxAt(p)` is the world size of one game pixel at `p`; a glyph cell is drawn ~1.1 px */
  update(now: number, camera: THREE.Camera, pxAt: (p: THREE.Vector3) => number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]
      const age = now - e.born
      const life = e.orbit > 0 ? 1.1 : 0.85
      if (age > life) { e.mesh.visible = false; this.live.splice(i, 1); continue }
      if (e.orbit > 0) {
        const a = age * 7 + e.phase
        e.mesh.position.set(e.at.x + Math.cos(a) * e.orbit, e.at.y + Math.sin(age * 9) * 0.3, e.at.z + Math.sin(a) * e.orbit)
      } else {
        // up in steps, a little sway; the last quarter it hops higher and goes
        const step = Math.floor(age * 12) / 12
        e.mesh.position.set(e.at.x + Math.sin(age * 9 + e.phase) * 0.25, e.at.y + step * 3.2 + (age > life * 0.75 ? 1 : 0), e.at.z)
      }
      e.mesh.quaternion.copy(camera.quaternion)
      // a lean, its way decided by the phase, and a pop on the way in: small, big, settled
      e.mesh.rotateZ((e.phase % 2 < 1 ? 1 : -1) * (0.14 + (e.orbit > 0 ? Math.sin(age * 11) * 0.2 : 0)))
      const pop = age < 0.05 ? 0.55 : age < 0.1 ? 1.25 : age < 0.15 ? 0.92 : 1
      e.mesh.scale.setScalar(Math.max(0.05, pxAt(e.mesh.position) * 1.12 * pop / this.cell))
    }
  }
  clear(): void {
    for (const e of this.live) e.mesh.visible = false
    this.live = []
  }
}

interface Grain { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; born: number; alive: boolean; phase: number }

/**
 * A pool of falling bits.  `gravity` in world units/s²; `drag` a per-second
 * velocity keep; `flutter` adds the side-to-side of a feather.
 */
export class Bits {
  private grains: Grain[] = []
  private readonly mat: THREE.MeshBasicMaterial
  /** every bit, alive or not, takes this colour from now on */
  setColor(c: number): void { this.mat.color.setHex(c) }
  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, color: number, n: number,
              private gravity: number, private drag: number, private life: number, private flutter: number,
              /** the ground the bits come to rest on (the meadow's, unless told otherwise) */
              public floor = 0.15) {
    this.mat = new THREE.MeshBasicMaterial({ color })
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, this.mat)
      m.visible = false
      m.castShadow = false
      scene.add(m)
      this.grains.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), born: 0, alive: false, phase: Math.random() * 7 })
    }
  }
  /** `count` bits at `at`, each with `base` velocity plus a random spread */
  spawn(at: THREE.Vector3, count: number, now: number, base: THREE.Vector3, spread: number): void {
    for (let k = 0; k < count; k++) {
      const g = this.grains.find((x) => !x.alive)
      if (!g) return
      g.alive = true
      g.born = now
      g.mesh.visible = true
      g.mesh.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, (Math.random() - 0.2) * 1.5, (Math.random() - 0.5) * 1.5))
      g.vel.copy(base).add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread))
      g.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12)
      g.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6)
      g.mesh.scale.setScalar(1)
    }
  }
  update(now: number, dt: number): void {
    const keep = Math.pow(this.drag, dt)
    for (const g of this.grains) {
      if (!g.alive) continue
      const age = now - g.born
      if (age > this.life) { g.alive = false; g.mesh.visible = false; continue }
      g.vel.y -= this.gravity * dt
      g.vel.multiplyScalar(keep)
      g.mesh.position.addScaledVector(g.vel, dt)
      if (this.flutter > 0) g.mesh.position.x += Math.sin(now * 9 + g.phase) * this.flutter * dt
      g.mesh.rotation.x += g.spin.x * dt
      g.mesh.rotation.y += g.spin.y * dt
      g.mesh.rotation.z += g.spin.z * dt
      if (g.mesh.position.y < this.floor) { g.mesh.position.y = this.floor; g.vel.set(0, 0, 0); g.spin.set(0, 0, 0) }
      // dust shrinks in two steps; feathers do not
      if (this.flutter === 0) g.mesh.scale.setScalar(age > this.life * 0.66 ? 0.45 : age > this.life * 0.33 ? 0.75 : 1)
    }
  }
  clear(): void { for (const g of this.grains) { g.alive = false; g.mesh.visible = false } }
}

export function feathers(scene: THREE.Scene): Bits {
  return new Bits(scene, new THREE.BoxGeometry(0.9, 0.14, 0.5), 0xebf0ef, 96, 9, 0.12, 1.7, 3)
}
export function dust(scene: THREE.Scene): Bits {
  return new Bits(scene, new THREE.BoxGeometry(0.9, 0.9, 0.9), 0xc9c2a8, 32, 14, 0.05, 0.55, 0)
}
/** cloud puffs: big white blocks that hang almost still and thin out in steps — the trail of a launch */
export function puffs(scene: THREE.Scene): Bits {
  return new Bits(scene, new THREE.BoxGeometry(2.6, 1.6, 2.2), 0xffffff, 48, -0.6, 0.02, 1.1, 0)
}
