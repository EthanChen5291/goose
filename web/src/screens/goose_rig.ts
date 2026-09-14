/**
 * The goose, built in three dimensions.
 *
 * The sprite is 64×64 with the feet on row 32: the bird stands 28 pixels tall
 * and 20 long.  This is that bird as a jointed figure of boxes in its own four
 * colours — body, tail, neck, head with a beak that opens, two wings on
 * shoulder hinges, two legs with feet — every size read off the sprite, so from
 * the side it has the sprite's silhouette and from any other angle it is the
 * same goose.  Each box wears an ink hull (an inverted shell a fraction wider)
 * so the figure keeps the sprite's dark outline.
 *
 * Motion is a `GPose`: a handful of joint angles.  The clips are functions of
 * time that return poses — the beat-locked idle, the waddle, the run, flight,
 * the panic jump, dangling in a beam — and `mix` blends two so a change of
 * clip never pops.  `setFlat` swaps the figure for the sprite itself on a
 * plane: the goose after the slap.
 *
 * Units inside `model` are goose units (sprite pixels); `model` is scaled to
 * the world.  `root` is the handle: its position is the feet, its rotation.y
 * the facing.  The sprite faces +x, so the goose does too.
 */
import * as THREE from 'three'

export const G_WHITE = 0xebf0ef
export const G_SHADE = 0xcfd6d5
export const G_ORANGE = 0xecb187
export const G_BROWN = 0xaa6738
export const G_INK = 0x171818

/** feet to crown, goose units */
export const GOOSE_H = 28
/** the body's centre above the feet, goose units: the pivot of a rigid tumble */
export const BODY_CENTRE = new THREE.Vector3(0, 11, 0)
/** the head's centre above the feet, goose units, at rest */
export const HEAD_CENTRE = new THREE.Vector3(5, 24, 0)

export interface GPose {
  /** lift of the whole figure (a bob) */
  y: number
  /** body at the hips: pitch (+ nose up), roll (side to side), yaw (a wiggle) */
  pitch: number
  roll: number
  yaw: number
  /** body scale in y; the squash of a landing */
  squash: number
  /** neck lean (+ back), head nod (+ beak up), head turn */
  neck: number
  head: number
  headYaw: number
  /** 0 folded against the flank · 1 raised out and up */
  wing: number
  /** hip swing (+ forward) and ankle per leg */
  legs: [number, number]
  feet: [number, number]
  tail: number
  /** 0 shut · 1 wide open */
  beak: number
  /** eye height: 1 normal · 1.6 wide · 0.1 a blink */
  eye: number
  /** the angry brows, 0 or 1 */
  brows: number
}

export const REST: GPose = {
  y: 0, pitch: 0, roll: 0, yaw: 0, squash: 1, neck: 0, head: 0, headYaw: 0, wing: 0,
  legs: [0, 0], feet: [0, 0], tail: 0, beak: 0, eye: 1, brows: 0,
}

export function pose(p: Partial<GPose>): GPose { return { ...REST, ...p } }

export function mix(a: GPose, b: GPose, k: number): GPose {
  if (k <= 0) return a
  if (k >= 1) return b
  const l = (x: number, y: number): number => x + (y - x) * k
  return {
    y: l(a.y, b.y), pitch: l(a.pitch, b.pitch), roll: l(a.roll, b.roll), yaw: l(a.yaw, b.yaw), squash: l(a.squash, b.squash),
    neck: l(a.neck, b.neck), head: l(a.head, b.head), headYaw: l(a.headYaw, b.headYaw), wing: l(a.wing, b.wing),
    legs: [l(a.legs[0], b.legs[0]), l(a.legs[1], b.legs[1])], feet: [l(a.feet[0], b.feet[0]), l(a.feet[1], b.feet[1])],
    tail: l(a.tail, b.tail), beak: l(a.beak, b.beak), eye: l(a.eye, b.eye), brows: l(a.brows, b.brows),
  }
}

const TAU = Math.PI * 2

/** The clips.  `t` is seconds; `ph` a stride phase in radians; `u` a 0..1 progress. */
export const clips = {
  /** standing: a bob locked to the beat (`beat` is the beat's 0..1 phase), a blink every few seconds */
  idle: (t: number, beat: number): GPose => pose({
    y: -0.3 + 0.3 * Math.cos(beat * TAU),
    tail: Math.sin(t * 2.6) * 0.12,
    head: Math.sin(t * 1.3) * 0.05,
    eye: ((t + 1.3) % 3.7) < 0.12 ? 0.1 : 1,
  }),
  /** the waddle: legs alternate, the body rocks side to side and bobs */
  waddle: (ph: number): GPose => {
    const s = Math.sin(ph), c = Math.cos(ph)
    return pose({
      legs: [s * 0.75, -s * 0.75], feet: [-s * 0.35, s * 0.35],
      roll: s * 0.16, yaw: s * 0.07, y: Math.abs(s) * 0.7,
      head: -Math.abs(c) * 0.1, neck: -0.08, tail: s * 0.35, wing: 0.04,
    })
  },
  /** the run: leaning in, neck stretched out flat like the Run frames, wings a little out */
  run: (ph: number): GPose => {
    const s = Math.sin(ph)
    return pose({
      legs: [s * 1.15, -s * 1.15], feet: [-s * 0.5, s * 0.5],
      pitch: -0.32, neck: -0.75, head: 0.55, wing: 0.3 + Math.abs(s) * 0.15,
      y: Math.abs(Math.cos(ph)) * 1.1, tail: 0.15 + s * 0.1,
    })
  },
  /** flight: a steady flap, legs tucked back */
  fly: (t: number): GPose => {
    const f = Math.sin(t * TAU * 6.5)
    return pose({ wing: 0.6 + f * 0.55, legs: [1.1, 1.1], feet: [0.4, 0.4], pitch: 0.12, neck: -0.35, head: 0.3, y: f * 0.4, tail: -0.1 })
  },
  /** the panic jump: frantic flapping, legs kicking, head whipping about, beak open */
  panic: (t: number): GPose => {
    const f = Math.sin(t * TAU * 9)
    const k = Math.sin(t * 28) * 0.5
    return pose({
      wing: 0.65 + f * 0.5, legs: [0.5 + k, -0.5 - k], feet: [0.3, 0.3],
      headYaw: Math.sin(t * 23) * 0.4, neck: 0.3, head: 0.35, eye: 1.6, beak: 0.7, tail: 0.3,
    })
  },
  /** rigid: nothing moves — the goose as a thrown object */
  stiff: (): GPose => pose({ eye: 0.6, wing: 0.02 }),
  /** the crouch before a leap */
  crouch: (): GPose => pose({ y: -1.6, squash: 0.85, legs: [0.5, -0.5], neck: -0.3, head: 0.5, wing: 0.25, eye: 1.4 }),
  /** looking straight up into a camera held over the head */
  lookUp: (t: number): GPose => pose({
    neck: 0.55, head: 0.95, eye: 1.6, wing: 0.12, tail: 0.1,
    beak: 0.2 + Math.max(0, Math.sin(t * 3)) * 0.15,
  }),
  /** hanging in a beam: legs paddling, wings out, looking around */
  dangle: (t: number): GPose => pose({
    legs: [Math.sin(t * 9) * 0.6, -Math.sin(t * 9) * 0.6], feet: [0.2, 0.2],
    wing: 0.75 + Math.sin(t * 22) * 0.3, eye: 1.6, beak: 0.6,
    headYaw: Math.sin(t * 5.5) * 0.35, neck: 0.35, head: 0.5,
  }),
  /** three honks at the viewer */
  quack: (u: number): GPose => {
    const s = Math.abs(Math.sin(u * Math.PI * 3))
    return pose({ beak: s, neck: -0.3 * s, head: 0.35 * s, wing: 0.15 * s, y: s * 0.3 })
  },
  /** >:( — brows down, head low, a tremble */
  grr: (t: number): GPose => pose({ brows: 1, head: -0.3, neck: -0.15, eye: 0.75, yaw: Math.sin(t * 45) * 0.02, wing: 0.1, beak: 0.15 }),
  /** a look left and right */
  wonder: (u: number): GPose => pose({ headYaw: Math.sin(u * TAU) * 0.8, head: 0.15, eye: 1.1 }),
  /** seeing stars after a tumble */
  dizzy: (t: number): GPose => pose({ headYaw: Math.sin(t * 7) * 0.5, head: Math.cos(t * 7) * 0.25, eye: 0.5, wing: 0.2, roll: Math.sin(t * 7) * 0.08 }),
  /** the cartoon hang: legs running on nothing, looking down */
  hang: (t: number): GPose => pose({ legs: [Math.sin(t * 30), -Math.sin(t * 30)], eye: 1.6, neck: 0.2, head: -0.25, beak: 0.5, wing: 0.3 }),
}

export interface GooseRig {
  root: THREE.Group
  model: THREE.Group
  apply: (p: GPose) => void
  /** the sprite plane instead of the figure (the figure's yaw carries over) */
  setFlat: (on: boolean) => void
  readonly flat: THREE.Mesh
  /** the direction the goose faces, world space */
  facing: (out: THREE.Vector3) => THREE.Vector3
  /** the head's centre, world space, as posed */
  headAt: (out: THREE.Vector3) => THREE.Vector3
}

const HULL = new THREE.MeshBasicMaterial({ color: G_INK, side: THREE.BackSide })

/**
 * Build the figure.  `base` is the world's toon material (cloned per colour);
 * `sprite` the idle frame as a texture, for the flat version.
 */
export function buildGoose(base: THREE.MeshToonMaterial, scale: number, sprite: THREE.Texture | null): GooseRig {
  const mats = new Map<number, THREE.MeshToonMaterial>()
  const mat = (c: number): THREE.MeshToonMaterial => {
    let m = mats.get(c)
    if (!m) { m = base.clone(); m.color.setHex(c); mats.set(c, m) }
    return m
  }
  const part = (w: number, h: number, d: number, c: number, x: number, y: number, z: number, hull = 0.9): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c))
    m.position.set(x, y, z)
    m.castShadow = true
    if (hull > 0) {
      const sh = new THREE.Mesh(m.geometry, HULL)
      sh.scale.set((w + hull) / w, (h + hull) / h, (d + hull) / d)
      m.add(sh)
    }
    return m
  }

  const root = new THREE.Group()
  const model = new THREE.Group()
  model.scale.setScalar(scale)
  root.add(model)
  const solid = new THREE.Group()
  model.add(solid)

  // legs: hips at y 6, feet on the ground — rows 27–31 of the sprite
  const legs: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  const feet: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  legs.forEach((leg, i) => {
    const side = i === 0 ? -1 : 1
    leg.position.set(0, 6, side * 2.2)
    leg.add(part(1.6, 6.4, 1.6, G_ORANGE, 0, -3, 0, 0.7))
    const foot = feet[i]
    foot.position.set(0, -6, 0)
    foot.add(part(6, 1, 2.8, G_ORANGE, 0.5, 0.5, 0, 0.7))
    leg.add(foot)
    solid.add(leg)
  })

  // body: rows 16–26, x 14–33 — a rounded loaf of five boxes and a tail
  const body = new THREE.Group()
  body.position.set(0, 6, 0)
  body.add(part(16, 8, 9, G_WHITE, 0, 5, 0))
  body.add(part(12, 2, 7, G_WHITE, 0, 9.6, 0))
  body.add(part(11, 1.6, 6.5, G_WHITE, 1, 0.4, 0))
  body.add(part(2, 5.5, 7, G_WHITE, 8.8, 5.2, 0))
  body.add(part(2, 5.5, 7, G_WHITE, -8.8, 5.6, 0))
  const tail = new THREE.Group()
  tail.position.set(-8, 10, 0)
  tail.add(part(4, 2.5, 4, G_WHITE, -1.6, 0.4, 0))
  body.add(tail)

  // wings: hinged at the shoulders, hanging flat on the flanks at rest
  const wings: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()]
  wings.forEach((w, i) => {
    const side = i === 0 ? -1 : 1
    w.position.set(2.5, 9.2, side * 4.5)
    w.add(part(11, 0.9, 6, G_WHITE, -3.5, 0, side * 3))
    body.add(w)
  })

  // neck (rows 11–15) and head (rows 4–12) with the beak, the eyes, the brows
  const neck = new THREE.Group()
  neck.position.set(4, 10, 0)
  neck.add(part(5, 6.5, 5, G_WHITE, 0, 3, 0))
  const head = new THREE.Group()
  head.position.set(0, 6, 0)
  head.add(part(7, 9, 7, G_WHITE, 1, 1.5, 0))
  head.add(part(3.6, 1.6, 3.4, G_ORANGE, 5.9, 0.6, 0, 0.7))
  head.add(part(1.4, 1.6, 3.6, G_BROWN, 8.4, 0.6, 0, 0.7))
  const beakLow = new THREE.Group()
  beakLow.position.set(4.2, -0.2, 0)
  beakLow.add(part(4.6, 1.2, 3.2, G_ORANGE, 2.3, -0.5, 0, 0.6))
  head.add(beakLow)
  const eyes = [0, 1].map((i) => {
    const side = i === 0 ? -1 : 1
    const e = part(1.2, 1.5, 0.7, G_INK, 2.5, 2.0, side * 3.55, 0)
    e.castShadow = false
    head.add(e)
    return e
  })
  const brows = new THREE.Group()
  for (const side of [-1, 1]) {
    const b = part(2.8, 0.7, 0.7, G_INK, 2.5, 3.5, side * 3.55, 0)
    b.rotation.z = -0.5
    b.castShadow = false
    brows.add(b)
  }
  brows.visible = false
  head.add(brows)
  neck.add(head)
  body.add(neck)
  solid.add(body)

  // the flat goose: the sprite on a plane, feet at the root, body centred like the figure
  const flatMat = new THREE.MeshBasicMaterial({ map: sprite ?? undefined, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xffffff })
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), flatMat)
  flat.position.set(8.5, 0, 0)
  flat.visible = false
  flat.castShadow = true
  model.add(flat)

  const apply = (p: GPose): void => {
    model.position.y = p.y
    body.rotation.set(p.roll, p.yaw, p.pitch)
    const sq = p.squash
    body.scale.set(1 + (1 - sq) * 0.5, sq, 1 + (1 - sq) * 0.5)
    neck.rotation.z = p.neck
    head.rotation.set(0, p.headYaw, p.head)
    beakLow.rotation.z = -p.beak * 0.6
    wings.forEach((w, i) => { const side = i === 0 ? -1 : 1; w.rotation.x = side * (1.35 - 2.2 * p.wing) })
    legs.forEach((l, i) => { l.rotation.z = p.legs[i]; feet[i].rotation.z = p.feet[i] })
    tail.rotation.z = 0.45 + p.tail
    for (const e of eyes) e.scale.y = Math.max(0.1, p.eye)
    brows.visible = p.brows > 0.5
  }
  apply(REST)

  const v = new THREE.Vector3()
  return {
    root, model, apply, flat,
    setFlat: (on) => { solid.visible = !on; flat.visible = on },
    facing: (out) => out.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion())),
    headAt: (out) => { head.getWorldPosition(v); return out.copy(v).add(new THREE.Vector3(1, 1.5, 0).multiplyScalar(scale).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()))) },
  }
}
