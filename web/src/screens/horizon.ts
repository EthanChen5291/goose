/**
 * The horizon: what is out past the archipelago, in every direction.
 *
 * Nothing here moves and nothing is flown to; it is the backdrop the islands
 * hang in front of, so the sea is not empty to the fog.  Round the compass:
 * a craggy range with snow on it behind a green coast with a red-roofed town
 * and a lighthouse to the north; a volcano with its thread of smoke in the
 * north-east; coral sea stacks and wooded islets and one giant tree on a
 * rock to the east; a storm cell standing on its rain to the south, and a
 * dark spire pouring waterfalls; a pastel town of windmills with a pier,
 * kites and balloons in the western corners, beyond the way in.  On the water
 * between, sailing boats and whales' backs.
 *
 * The rock is the islands' own kind — lumpy outlines cut in cells — and the
 * mountains are cones roughed up vertex by vertex into ridges, all of them
 * far enough out that the fog takes their edges; the small furniture is
 * three instanced piles (lit boxes, lit cones, unlit boxes).
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { OCEAN_Y, Kit, buildGround, blob, mixHex } from './island_kit'
import { rng } from './goose_world'

const Y = new THREE.Vector3(0, 1, 0)

/** a pile of instances, built up and committed once */
class Pile {
  private readonly items: { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3; c: number }[] = []
  constructor(private readonly geo: THREE.BufferGeometry, private readonly mat: THREE.Material) {}
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number, ry = 0, rz = 0): void {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, ry)
    if (rz) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rz))
    this.items.push({ p: new THREE.Vector3(x, y, z), q, s: new THREE.Vector3(sx, sy, sz), c })
  }
  commit(root: THREE.Group): void {
    if (!this.items.length) return
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.items.length)
    const m = new THREE.Matrix4(), col = new THREE.Color()
    this.items.forEach((it, i) => { mesh.setMatrixAt(i, m.compose(it.p, it.q, it.s)); mesh.setColorAt(i, col.setHex(it.c)) })
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    root.add(mesh)
  }
}

/** a cloud, placed still: the archipelago's own builder, in whatever shape it deals */
export type CloudFn = (x: number, y: number, z: number, big: number) => void

export function buildHorizon(kit: Kit, root: THREE.Group, q: () => number, cloud: CloudFn): void {
  const box = new Pile(new THREE.BoxGeometry(1, 1, 1), kit.base.clone())
  const coneGeo = new THREE.ConeGeometry(1, 1, 5).toNonIndexed()
  coneGeo.computeVertexNormals()
  coneGeo.translate(0, 0.5, 0)
  const cone = new Pile(coneGeo, kit.base.clone())
  const glow = new Pile(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  const SEA = OCEAN_Y
  /** the archipelago's middle: everything here keeps well out from it */
  const cx = 710, cz = 20

  // ── the sea, out to the fog: one flat sheet under the moving cells ───────
  const floor = new THREE.Mesh(new THREE.BoxGeometry(5000, 2, 5000), kit.mat(0x2a7fd6))
  floor.position.set(cx, SEA - 3.7, 0)
  root.add(floor)

  // ── mountains: cones roughed into ridges, snow above a wandering line ────
  const peaks: THREE.BufferGeometry[] = []
  const peak = (x: number, z: number, r: number, h: number, rock: number, snow: number | null, flatTop = 0): void => {
    const seed = q() * 100
    const g = (flatTop > 0 ? new THREE.CylinderGeometry(flatTop, 1, 1, 24, 6, false) : new THREE.ConeGeometry(1, 1, 24, 6, false)).toNonIndexed()
    g.translate(0, 0.5, 0)
    const pos = g.attributes.position as THREE.BufferAttribute
    const col = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const dark = mixHex(rock, 0x2c3550, 0.35), light = mixHex(rock, 0xffffff, 0.18)
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i)
      const a = Math.atan2(pz, px)
      // ridges and gullies round the cone, shoulders up its height
      const k = 1 + 0.2 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 7 + seed * 2) + 0.08 * Math.sin(a * 13 - seed) + 0.1 * Math.sin(py * 9 + a * 4 + seed)
      const lift = 0.05 * Math.sin(a * 5 + seed * 3) * (1 - py)
      pos.setXYZ(i, px * k, Math.min(1, Math.max(0, py + lift)), pz * k)
      const y2 = pos.getY(i)
      const line = 0.6 + 0.09 * Math.sin(a * 4 + seed) + 0.05 * Math.sin(a * 9)
      const hex = snow !== null && y2 > line ? snow : y2 > line - 0.08 ? light : y2 < 0.18 ? dark : rock
      c.setHex(hex)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.computeVertexNormals()
    g.scale(r, h, r * (0.75 + q() * 0.5))
    g.rotateY(seed)
    g.translate(x, SEA, z)
    peaks.push(g)
  }
  const tree = (x: number, y: number, z: number, s: number, leaf = 0x4e8f3c): void => {
    box.add(x, y + s * 1.2, z, s * 0.4, s * 2.4, s * 0.4, 0x6b4a32)
    box.add(x, y + s * 3.4, z, s * 3, s * 2.6, s * 3, leaf, q() * 1.5)
    box.add(x + s * 0.6, y + s * 4.6, z - s * 0.4, s * 1.8, s * 1.5, s * 1.8, leaf, q() * 1.5)
  }
  const house = (x: number, y: number, z: number, w: number, roof: number, ry = 0): void => {
    const d = w * (0.8 + q() * 0.4), h = w * 0.9
    box.add(x, y + h / 2, z, w, h, d, [0xf6ead2, 0xf2dfc0, 0xe9e6dc][Math.floor(q() * 3)], ry)
    box.add(x, y + h + w * 0.18, z, w * 1.15, w * 0.36, d * 1.15, roof, ry)
  }
  const lighthouse = (x: number, y: number, z: number, h = 24): void => {
    cone.add(x, y, z, 3.2, h, 3.2, 0xf7f7f2)
    box.add(x, y + h * 0.35, z, 4.6, 2.2, 4.6, 0xd23b3b)
    box.add(x, y + h * 0.65, z, 3.8, 2.2, 3.8, 0xd23b3b)
    glow.add(x, y + h + 1.5, z, 3.4, 3, 3.4, 0xfff3a0)
    box.add(x, y + h + 4, z, 4.4, 1.6, 4.4, 0x3b3f4a)
  }
  const windmill = (x: number, y: number, z: number): void => {
    cone.add(x, y, z, 3.6, 16, 3.6, 0xf1e6d2)
    box.add(x, y + 15.5, z, 5, 3, 5, 0xc9503c)
    const a = q() * 3.14
    box.add(x, y + 15, z - 3, 1.2, 22, 1.4, 0xe6dccb, 0, a)
    box.add(x, y + 15, z - 3, 1.2, 22, 1.4, 0xe6dccb, 0, a + Math.PI / 2)
  }
  const balloon = (x: number, y: number, z: number, c: number): void => {
    box.add(x, y, z, 7, 6, 7, c)
    box.add(x, y + 4, z, 5, 3, 5, c)
    box.add(x, y - 4.5, z, 5, 3, 5, 0xf7e6c2)
    box.add(x, y - 8, z, 2.4, 1.8, 2.4, 0x8a6a42)
  }
  const boat = (x: number, z: number, ry: number): void => {
    box.add(x, SEA + 0.6, z, 9, 2.2, 3.4, 0xf0e9d8, ry)
    box.add(x, SEA + 5.5, z, 0.5, 9, 0.5, 0x6b4a32, ry)
    box.add(x, SEA + 6, z, 0.3, 7, 4.5, 0xffffff, ry)
    box.add(x, SEA + 4.5, z, 0.3, 4, 2.6, 0xffffff, ry + 1.5)
  }
  const whale = (x: number, z: number, ry: number): void => {
    box.add(x, SEA + 0.4, z, 15, 3.2, 5.5, 0x3d4f6b, ry)
    box.add(x, SEA + 2.2, z, 9, 1.4, 3.5, 0x5a7190, ry)
    box.add(x + Math.cos(ry) * 9.5, SEA + 1.6, z - Math.sin(ry) * 9.5, 2, 1, 7, 0x3d4f6b, ry)
  }
  /** a rock out of the sea: a lumpy outline cut in cells, rising to a pale worn top; `h` in units; trees if asked */
  const CORALS = [0xd9785e, 0xc9694f, 0xe2907a, 0xb85a44]
  const rock = (x: number, z: number, r: number, h: number, trees = 0, tones = CORALS, rim = 0xf0b39c): number => {
    const g = new THREE.Group()
    g.position.set(x, SEA + 2, z)
    root.add(g)
    const rr = rng(Math.floor(q() * 1e6))
    const cap = Math.round(h / 2) * 2
    const ground = buildGround(kit, {
      outline: blob(Math.floor(q() * 1e6), r, q() < 0.5 ? 1 : 0, 1.6),
      top: (_x, _z, e) => Math.min(cap, Math.round(e * (1.2 + rr() * 0.8) + rr() * 2) ),
      color: (_x, _z, hh) => hh >= cap - 1 ? rim : tones[Math.floor(rr() * tones.length)],
      under: { depth: () => 3, color: () => 0x6b7688 },
    }, g)
    for (let k = 0; k < trees; k++) {
      const a = rr() * 6.28, d = rr() * r * 0.4
      const tx = Math.cos(a) * d, tz = Math.sin(a) * d
      tree(x + tx, SEA + 2 + ground.top(tx, tz), z + tz, r * 0.14 + rr() * 0.6)
    }
    return SEA + 2 + cap
  }
  /** a green headland on a sand strip */
  const land = (x: number, z: number, w: number, d: number, h: number, ry = 0): void => {
    box.add(x, SEA + h * 0.35, z, w * 1.12, h * 0.7, d * 1.12, 0xe9d8a6, ry)
    box.add(x, SEA + h * 0.8, z, w, h * 0.5, d, 0x7fb35a, ry)
  }
  /** everything sits a quarter further out than it was drawn at */
  const out = (x: number, z: number): [number, number] => [cx + (x - cx) * 1.25, cz + (z - cz) * 1.25]

  // ── north: the range, snow on it, the coast and its town in front ────────
  for (let x = 150; x <= 1300; x += 95) {
    const [px, pz] = out(x + (q() - 0.5) * 40, -600 + (q() - 0.5) * 50)
    peak(px, pz, 80 + q() * 50, 120 + q() * 90, 0x6f8ab3, 0xf4f7fb)
  }
  for (let x = 260; x <= 1200; x += 110) {
    const [px, pz] = out(x + (q() - 0.5) * 40, -510 + (q() - 0.5) * 40)
    peak(px, pz, 55 + q() * 35, 60 + q() * 45, 0x587aa3, null)
  }
  {
    const [lx, lz] = out(720, -430)
    land(lx, lz, 340, 90, 8)
    for (let k = 0; k < 16; k++) house(lx - 120 + q() * 240, SEA + 8, lz - 25 + q() * 40, 5 + q() * 3, q() < 0.7 ? 0xc9503c : 0xd8743c, q() * 1.5)
    for (let k = 0; k < 14; k++) tree(lx - 150 + q() * 300, SEA + 8, lz - 40 + q() * 45, 1.6 + q() * 1)
    lighthouse(lx - 140, SEA + 8, lz + 35)
    const [vx, vz] = out(1010, -445)
    land(vx, vz, 120, 60, 7)
    for (let k = 0; k < 6; k++) house(vx - 30 + q() * 60, SEA + 7, vz - 10 + q() * 20, 4.5 + q() * 2, 0xc9503c, q() * 1.5)
  }
  // ── north-east: the volcano, its smoke ───────────────────────────────────
  {
    const [vx, vz] = out(1210, -440)
    peak(vx, vz, 150, 200, 0x8d6f7c, 0xe7dfe3, 0.16)
    glow.add(vx, SEA + 202, vz, 22, 6, 22, 0xff7a4a)
    for (let k = 0; k < 8; k++) box.add(vx + k * 3, SEA + 212 + k * 11, vz - k * 2, 6 + k, 11, 6 + k, 0xd9d3dc, q() * 1.5)
    cloud(vx + 24, SEA + 300, vz - 12, 2.6)
    for (let k = 0; k < 5; k++) { const [rx, rz] = out(1090 + k * 36 + (q() - 0.5) * 14, -330 - k * 8 + (q() - 0.5) * 24); rock(rx, rz, 7 + q() * 5, 6 + q() * 6, q() < 0.5 ? 2 : 0) }
  }

  // ── east: the stacks, the wooded islets, the giant tree ──────────────────
  {
    for (const [x, z, r, h] of [[1215, 70, 12, 22], [1245, 108, 9, 30], [1195, 132, 8, 16], [1235, 178, 10, 26]] as number[][]) { const [rx, rz] = out(x, z); rock(rx, rz, r, h) }
    let [rx, rz] = out(1160, -50); rock(rx, rz, 22, 4, 5)
    ;[rx, rz] = out(1275, 230); rock(rx, rz, 18, 4, 4)
    ;[rx, rz] = out(1250, -190)
    const top = rock(rx, rz, 26, 14)
    box.add(rx, top + 16, rz, 5, 34, 5, 0x7a4b2a)
    box.add(rx + 2, top + 36, rz + 4, 44, 16, 40, 0x8bc34a, 0.5)
    box.add(rx - 10, top + 46, rz - 8, 28, 12, 26, 0x9ccc4e, 0.9)
    box.add(rx + 14, top + 30, rz + 14, 22, 10, 20, 0x5e9f3a, 0.2)
  }

  // ── south: the storm on its rain, the dark spire and its waterfalls ──────
  {
    const [sx, sz] = out(820, 500)
    cloud(sx, SEA + 118, sz, 5.5); cloud(sx - 60, SEA + 108, sz + 20, 4); cloud(sx + 70, SEA + 112, sz - 10, 4.2); cloud(sx + 10, SEA + 136, sz + 6, 3.4)
    // the rain: dashed columns, each a run of short strokes, so it reads as falling rather than as poles
    for (let k = 0; k < 11; k++) {
      const rx = sx - 100 + k * 20 + (q() - 0.5) * 10, rz = sz + (q() - 0.5) * 80
      for (let y = SEA + 100; y > SEA + 4; y -= 9 + q() * 6) glow.add(rx + (q() - 0.5) * 2, y, rz, 1.2, 5 + q() * 3, 1.2, 0xd5e1ec)
    }
    const [px, pz] = out(560, 470)
    peak(px, pz, 30, 110, 0x4c5563, null)
    box.add(px + 4, SEA + 108, pz - 3, 14, 3, 12, 0x6da84a, 0.3)
    tree(px + 2, SEA + 110, pz - 4, 1.4, 0x8bc34a)
    for (let y = SEA + 100; y > SEA; y -= 7) { glow.add(px - 16 + (q() - 0.5), y, pz + 4, 2, 5, 2.6, 0xe4f6ff); glow.add(px + 12, y - 3, pz + 12, 1.6, 4, 2.2, 0xe4f6ff) }
    for (let k = 0; k < 5; k++) { const [rx, rz] = out(1020 + k * 48 + (q() - 0.5) * 14, 490 + (q() - 0.5) * 36); rock(rx, rz, 7 + q() * 5, 6 + q() * 7, q() < 0.5 ? 2 : 0) }
  }

  // ── the western corners: pastel towns of windmills, a pier, balloons and kites ──
  for (const [x0, z0, side] of [[330, -470, -1], [340, 470, 1]] as number[][]) {
    const [tx, tz] = out(x0, z0)
    land(tx, tz, 150, 100, 8)
    for (let k = 0; k < 11; k++) house(tx - 55 + q() * 110, SEA + 8, tz - 35 + q() * 70, 4.5 + q() * 2.5, [0xc9503c, 0xd8743c, 0xdbb0c9][Math.floor(q() * 3)], q() * 1.5)
    for (let k = 0; k < 8; k++) tree(tx - 65 + q() * 130, SEA + 8, tz - 45 + q() * 90, 1.4 + q() * 1)
    windmill(tx - 50, SEA + 8, tz - side * 30)
    windmill(tx + 20, SEA + 8, tz - side * 42)
    for (let k = 0; k < 4; k++) box.add(tx + 40 + k * 7, SEA + 8.4, tz + side * 20, 6, 0.6, 30, k % 2 ? 0xa8c35a : 0xc9b264)
    box.add(tx + 100, SEA + 1.2, tz - side * 20, 70, 1.2, 5, 0xb08a5e)
    for (let k = 0; k < 6; k++) box.add(tx + 70 + k * 12, SEA - 0.5, tz - side * 20, 1, 4, 1, 0x8a6a42)
    lighthouse(tx + 136, SEA + 1.8, tz - side * 20, 16)
    balloon(tx + 20 + q() * 40, SEA + 105 + q() * 20, tz - side * (60 + q() * 40), 0xe05a4e)
    balloon(tx - 40 + q() * 40, SEA + 118 + q() * 20, tz - side * (30 + q() * 40), 0xf2a541)
    for (let k = 0; k < 3; k++) glow.add(tx - 20 + k * 30 + q() * 10, SEA + 70 + q() * 25, tz - side * (50 + q() * 30), 3.5, 3.5, 0.4, [0xe05a4e, 0xf7d94c, 0x4fb3e8][k], 0, 0.78)
  }

  // ── on the water: boats, whales, the odd rock — out beyond the islands, and off the way in ──
  const open = (x: number, z: number): boolean => Math.hypot(x - cx, z - cz) > 470 && (x > 330 || Math.abs(z) > 420) && x < 1500 && Math.abs(z) < 640
  for (let k = 0, tries = 0; k < 9 && tries < 200; tries++) {
    const a = q() * 6.28, r = 500 + q() * 300, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    boat(x, z, q() * 6.28); k += 1
  }
  for (let k = 0, tries = 0; k < 4 && tries < 200; tries++) {
    const a = q() * 6.28, r = 500 + q() * 220, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    whale(x, z, q() * 6.28); k += 1
  }
  for (let k = 0, tries = 0; k < 8 && tries < 300; tries++) {
    const a = q() * 6.28, r = 520 + q() * 340, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    rock(x, z, 6 + q() * 8, 4 + q() * 10, q() < 0.5 ? 2 : 0); k += 1
  }
  // ── far cloud, low on the horizon all round ──────────────────────────────
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * 6.28 + q() * 0.3, r = 950 + q() * 200, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (x < 200 && Math.abs(z) < 300) continue
    cloud(x, SEA + 120 + q() * 70, z, 3 + q() * 3)
  }

  const range = new THREE.Mesh(mergeGeometries(peaks), (() => { const m = kit.base.clone(); m.vertexColors = true; return m })())
  range.frustumCulled = false
  root.add(range)
  for (const g of peaks) g.dispose()
  box.commit(root); cone.commit(root); glow.commit(root)
}
