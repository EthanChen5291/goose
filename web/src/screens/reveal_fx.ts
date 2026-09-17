/**
 * The archipelago's show: what makes the reveal, as the drone comes through
 * the cloud, a moment — and keeps the islands alive after it, at a lower
 * simmer.  Everything here is boxes, so it sits in the pixel buffer with the
 * rest:
 *
 *   · skeins of geese in a V, crossing the frame at the drone's height
 *   · glints — four-point stars popping off whatever is shiny on each island
 *   · hand-drawn gusts: curling strokes of wind drawn head to tail and blown
 *     across the sky, with petals and leaves riding them
 *   · hot-air balloons drifting the far sky
 *   · shooting stars over the night ruins
 *
 * `tick` takes `show`, 0..1: 1 through the reveal, a fraction on the map.
 */
import * as THREE from 'three'
import { Kit, CellField, clamp01 } from './island_kit'
import type { Island } from './island_kit'

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

export interface RevealShow {
  tick: (t: number, dt: number, from: THREE.Vector3, show: number) => void
}

interface Bird { g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh; ph: number; row: number; side: number }
interface Skein { birds: Bird[]; t0: number; from: THREE.Vector3; to: THREE.Vector3; dur: number; next: number }
interface Curl { i0: number; base: THREE.Vector3; dir: THREE.Vector3; side: THREE.Vector3; amp: number; len: number; t0: number; life: number }
interface Petal { x: number; y: number; z: number; vx: number; vz: number; ph: number; born: number; alive: boolean }

export function buildRevealShow(kit: Kit, root: THREE.Group, islands: Island[], centre: THREE.Vector3, at: { x: number; y: number; z: number }, q: () => number): RevealShow {
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3()
  const quat = new THREE.Quaternion()

  // ── geese: three skeins, each a V of nine ─────────────────────────────────
  const skeins: Skein[] = []
  for (let s = 0; s < 3; s++) {
    const birds: Bird[] = []
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group()
      const body = kit.box(2.6, 1.0, 1.2, 0x9a9282)
      const neck = kit.box(0.6, 1.5, 0.6, 0x2b2b2b, 1.3, 0.9, 0)
      const head = kit.box(1.0, 0.6, 0.6, 0x2b2b2b, 1.6, 1.7, 0)
      const cheek = kit.glow(0.3, 0.45, 0.66, 0xffffff, 1.55, 1.55, 0)
      const bill = kit.box(0.5, 0.25, 0.3, 0x1a1a1a, 2.25, 1.65, 0)
      const l = kit.box(0.9, 0.14, 3.0, 0xb5ada0, 0, 0.3, -1.9)
      const r = kit.box(0.9, 0.14, 3.0, 0xb5ada0, 0, 0.3, 1.9)
      g.add(body, neck, head, cheek, bill, l, r)
      g.scale.setScalar(1.6)
      g.visible = false
      root.add(g)
      birds.push({ g, l, r, ph: q() * 7, row: Math.ceil(i / 2), side: i === 0 ? 0 : i % 2 ? -1 : 1 })
    }
    skeins.push({ birds, t0: -99, from: new THREE.Vector3(), to: new THREE.Vector3(), dur: 1, next: s * 0.9 })
  }
  const launchSkein = (s: Skein, t: number, from: THREE.Vector3, reveal: boolean): void => {
    if (reveal) {
      // close ahead of the drone as it comes through, crossing the frame side to side at its own height, over the near islands
      const side = q() < 0.5 ? 1 : -1
      s.from.set(from.x + 30 + q() * 50, from.y - 12 + q() * 22, from.z + side * (60 + q() * 50))
      s.to.set(from.x + 300 + q() * 80, from.y - 34 + q() * 30, from.z - side * (90 + q() * 60))
    } else {
      const a = q() * TAU
      s.from.set(centre.x + Math.cos(a) * 320, 60 + q() * 40, centre.z + Math.sin(a) * 320)
      s.to.set(centre.x - Math.cos(a) * 320, 60 + q() * 40, centre.z - Math.sin(a) * 320)
    }
    s.t0 = t
    s.dur = s.from.distanceTo(s.to) / (reveal ? 74 : 34)
    for (const b of s.birds) b.g.visible = true
  }
  const tickSkeins = (t: number, dt: number, from: THREE.Vector3, show: number): void => {
    for (const s of skeins) {
      const u = (t - s.t0) / s.dur
      if (u > 1) {
        for (const b of s.birds) b.g.visible = false
        // through the reveal they go up at once, one after another, the whole way in: never across a settled shot
        const reveal = show > 0.7
        s.next -= dt * (reveal ? 8 : 1)
        if (s.next <= 0) { launchSkein(s, t, from, reveal); s.next = reveal ? 6 + q() * 6 : 14 + q() * 16 }
        continue
      }
      tmp.copy(s.to).sub(s.from)
      const yaw = Math.atan2(-tmp.z, tmp.x)
      tmp.normalize()
      tmp2.set(-tmp.z, 0, tmp.x)
      for (const b of s.birds) {
        b.g.position.copy(s.from).lerp(s.to, u).addScaledVector(tmp, -b.row * 3.4).addScaledVector(tmp2, b.side * b.row * 2.8)
        b.g.position.y += Math.sin(t * 1.3 + b.ph) * 0.8
        b.g.rotation.y = yaw
        const flap = Math.sin(t * 9 + b.ph)
        b.l.rotation.x = flap * 0.75; b.r.rotation.x = -flap * 0.75
      }
    }
  }

  // ── glints: a four-point star at a shiny spot, three sizes over a quarter second ──
  const anchors: { x: number; y: number; z: number; color: number; t0: number }[] = []
  for (const i of islands) {
    const bright = i.id === 'snow' || i.id === 'cove' ? 12 : 7
    const color = i.id === 'ruins' ? 0xd6a8ff : i.id === 'vault' ? 0x8fe8ff : i.id === 'storm' ? 0xdfe8ff : 0xffffff
    for (let k = 0; k < bright; k++) {
      for (let tries = 0; tries < 20; tries++) {
        const a = q() * TAU, d = q() * i.r * 0.85
        const x = i.at.x + Math.cos(a) * d, z = i.at.z + Math.sin(a) * d
        if (!i.inside(x, z)) continue
        anchors.push({ x, y: i.top(x, z) - i.at.y, z, color, t0: -9 })
        break
      }
    }
  }
  const glints = new CellField(anchors.length * 2, 1, 1, 1, kit.glowMat(0xffffff))
  anchors.forEach((a, k) => { glints.set(k * 2, 0, -9999, 0, 1, a.color); glints.set(k * 2 + 1, 0, -9999, 0, 1, a.color) })
  glints.commit()
  root.add(glints.mesh)
  const tickGlints = (t: number, dt: number, show: number): void => {
    anchors.forEach((a, k) => {
      const island = islands.find((i) => i.inside(a.x, a.z))
      const y = a.y + (island ? island.at.y + island.bob : 0) + 1.2
      const age = t - a.t0
      if (age > 0.3 && Math.random() < dt * (0.12 + show * 3.2)) a.t0 = t
      const life = t - a.t0
      const s = life < 0.1 ? 1.2 : life < 0.2 ? 2.6 : life < 0.3 ? 1.2 : 0
      if (s === 0) { glints.place(k * 2, 0, -9999, 0); glints.place(k * 2 + 1, 0, -9999, 0) }
      else { glints.place(k * 2, a.x, y, a.z, 0.35, s, 0.35); glints.place(k * 2 + 1, a.x, y, a.z, s, 0.35, 0.35) }
    })
    glints.commit(false)
  }

  // ── gusts: strokes of wind, drawn head to tail, blown across ─────────────
  const CURLS = 11, DOTS = 14
  const curlField = new CellField(CURLS * DOTS, 0.8, 0.8, 0.8, kit.glowMat(0xf6fbff))
  root.add(curlField.mesh)
  const curls: (Curl | null)[] = Array.from({ length: CURLS }, () => null)
  const wind = new THREE.Vector3(1, 0, 0.25).normalize()
  const spawnCurl = (slot: number, t: number, from: THREE.Vector3, show: number): void => {
    const base = show > 0.7
      ? new THREE.Vector3(from.x + 40 + q() * 160, at.y - 20 + q() * 50, at.z + (q() - 0.5) * 200)
      : new THREE.Vector3(centre.x - 200 + q() * 400, 40 + q() * 60, centre.z + (q() - 0.5) * 400)
    const dir = wind.clone().applyAxisAngle(UP, (q() - 0.5) * 0.8)
    const side = q() < 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(-dir.z, 0, dir.x)
    curls[slot] = { i0: slot * DOTS, base, dir, side, amp: 3 + q() * 4, len: 26 + q() * 22, t0: t, life: 2.4 + q() * 1.2 }
  }
  const tickCurls = (t: number, dt: number, from: THREE.Vector3, show: number): void => {
    for (let s = 0; s < CURLS; s++) {
      const c = curls[s]
      if (!c) {
        if (Math.random() < dt * (0.25 + show * 3.5)) spawnCurl(s, t, from, show)
        else for (let j = 0; j < DOTS; j++) curlField.place(s * DOTS + j, 0, -9999, 0)
        continue
      }
      const u = (t - c.t0) / c.life
      if (u > 1) { curls[s] = null; continue }
      // the stroke: its head runs out ahead, its tail follows, so a moving length of it is drawn at a time
      const head = u * 1.7, tail = (u - 0.4) * 1.7
      for (let j = 0; j < DOTS; j++) {
        const k = j / (DOTS - 1)
        if (k > head || k < tail) { curlField.place(c.i0 + j, 0, -9999, 0); continue }
        tmp.copy(c.base).addScaledVector(c.dir, k * c.len + u * 22).addScaledVector(c.side, Math.sin(k * TAU * 0.9) * c.amp)
        if (k > 0.66) {
          // the hook at the end of the stroke: a curl back on itself
          const a = (k - 0.66) / 0.34 * TAU * 0.85
          const r = (1 - (k - 0.66) / 0.34) * c.amp * 0.9
          tmp.addScaledVector(c.side, Math.sin(a) * r).addScaledVector(c.dir, (Math.cos(a) - 1) * r)
        }
        const sz = (k > 0.66 ? 0.7 : 1) * (1 + show * 0.5)
        curlField.place(c.i0 + j, tmp.x, tmp.y, tmp.z, sz, sz, sz)
      }
    }
    curlField.commit(false)
  }

  // ── petals and leaves on the wind ────────────────────────────────────────
  const PETALS = 70
  const PETAL_COLORS = [0xf7a8c4, 0xffe08a, 0xe9803a, 0xffffff, 0xff8fa3, 0xc9e46a]
  const petalField = new CellField(PETALS, 0.6, 0.3, 0.6, kit.glowMat(0xffffff))
  root.add(petalField.mesh)
  const petals: Petal[] = Array.from({ length: PETALS }, (_, i) => { petalField.set(i, 0, -9999, 0, 1, PETAL_COLORS[i % PETAL_COLORS.length]); return { x: 0, y: -9999, z: 0, vx: 0, vz: 0, ph: q() * 7, born: -9, alive: false } })
  petalField.commit()
  const tickPetals = (t: number, dt: number, from: THREE.Vector3, show: number): void => {
    let spawn = Math.random() < dt * (1 + show * 24) ? 1 : 0
    petals.forEach((p, i) => {
      if (!p.alive && spawn > 0) {
        spawn = 0
        p.alive = true; p.born = t
        if (show > 0.7) { p.x = from.x + 30 + q() * 120; p.y = at.y - 14 + q() * 40; p.z = at.z + (q() - 0.5) * 160 }
        else { p.x = centre.x - 220 + q() * 440; p.y = 30 + q() * 60; p.z = centre.z + (q() - 0.5) * 440 }
        p.vx = wind.x * (18 + q() * 16); p.vz = wind.z * (18 + q() * 16) + (q() - 0.5) * 8
      }
      if (!p.alive) return
      if (t - p.born > 7) { p.alive = false; petalField.place(i, 0, -9999, 0); return }
      p.x += p.vx * dt; p.z += p.vz * dt
      p.y += (Math.sin(t * 2.1 + p.ph) * 3 - 1.2) * dt
      petalField.placeQ(i, tmp.set(p.x, p.y, p.z), quat.setFromAxisAngle(UP, t * 3 + p.ph))
    })
    petalField.commit(false)
  }

  // ── balloons in the far sky ──────────────────────────────────────────────
  const balloons: { g: THREE.Group; a0: number; ph: number }[] = []
  ;[[0xe04848, 0xfff2d6], [0x3fb8a8, 0xfff2d6], [0xf2a541, 0xfff2d6], [0x8c6ad8, 0xfff2d6]].forEach(([a, b], k) => {
    const g = new THREE.Group()
    const widths = [3, 5.2, 6, 5.6, 4.4, 2.6]
    widths.forEach((w, i) => g.add(kit.box(w, 1.5, w, i % 2 ? b : a, 0, 6 + i * 1.5, 0)))
    g.add(kit.box(1.6, 1.2, 1.6, 0x7a5a3a, 0, 2.2, 0))
    g.add(kit.box(0.15, 3.4, 0.15, 0x3a2a1a, -0.6, 4.4, -0.6), kit.box(0.15, 3.4, 0.15, 0x3a2a1a, 0.6, 4.4, 0.6))
    g.scale.setScalar(1.7)
    root.add(g)
    balloons.push({ g, a0: k * Math.PI * 0.5 + 0.6, ph: k * 2.1 })
  })
  const tickBalloons = (t: number): void => {
    for (const b of balloons) {
      const a = b.a0 + t * 0.025
      b.g.position.set(centre.x + Math.cos(a) * 250, 90 + Math.sin(t * 0.4 + b.ph) * 4, centre.z + Math.sin(a) * 250)
      b.g.rotation.y = t * 0.1
    }
  }

  // ── shooting stars over the ruins ────────────────────────────────────────
  const ruins = islands.find((i) => i.id === 'ruins') ?? islands[0]
  const stars = new CellField(6, 0.7, 0.7, 0.7, kit.glowMat(0xfff4c2))
  root.add(stars.mesh)
  const shots = [0, 1].map(() => ({ t0: -9, x: 0, y: 0, z: 0, dx: 0, dy: 0 }))
  const tickStars = (t: number, dt: number, show: number): void => {
    shots.forEach((s, k) => {
      const age = t - s.t0
      if (age > 0.6 && Math.random() < dt * (0.06 + show * 0.5)) {
        s.t0 = t; s.x = ruins.at.x + (q() - 0.5) * 120; s.y = ruins.at.y + 60 + q() * 30; s.z = ruins.at.z + (q() - 0.5) * 120
        s.dx = -40 + q() * 80; s.dy = -30 - q() * 20
      }
      const u = (t - s.t0) / 0.5
      for (let j = 0; j < 3; j++) {
        const i = k * 3 + j
        if (u > 1) { stars.place(i, 0, -9999, 0); continue }
        const lag = u - j * 0.08
        stars.place(i, s.x + s.dx * lag, s.y + s.dy * lag, s.z, 1 - j * 0.25, 1 - j * 0.25, 1 - j * 0.25)
      }
    })
    stars.commit(false)
  }

  return {
    tick: (t, dt, from, show) => {
      const k = clamp01(show)
      tickSkeins(t, dt, from, k)
      tickGlints(t, dt, k)
      tickCurls(t, dt, from, k)
      tickPetals(t, dt, from, k)
      tickBalloons(t)
      tickStars(t, dt, k)
    },
  }
}
