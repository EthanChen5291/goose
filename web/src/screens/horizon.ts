/**
 * The horizon: what is out past the archipelago, in every direction.
 *
 * Nothing here moves and nothing is flown to; it is the backdrop the islands
 * hang in front of, so the sea is not empty to the fog.  Round the compass:
 * a range of blue mountains with snow on them behind a green coast with a
 * red-roofed town and a lighthouse to the north; a volcano with its thread of
 * smoke in the north-east; coral sea stacks, a rock arch, wooded islets and
 * one giant tree on a rock to the east; a storm cell standing on its rain
 * columns and a dark spire pouring waterfalls to the south; a pastel town of
 * windmills with a pier, kites and balloons in the western corners, beyond
 * the way in.  And on the water between, sailing boats and whales' backs.
 * Everything is one of three instanced meshes — lit boxes, lit cones, unlit
 * boxes — so the whole horizon is three draw calls.
 */
import * as THREE from 'three'
import { OCEAN_Y, Kit } from './island_kit'

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
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.items.length)
    const m = new THREE.Matrix4(), col = new THREE.Color()
    this.items.forEach((it, i) => { mesh.setMatrixAt(i, m.compose(it.p, it.q, it.s)); mesh.setColorAt(i, col.setHex(it.c)) })
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    root.add(mesh)
  }
}

export function buildHorizon(kit: Kit, root: THREE.Group, q: () => number, cloudMat: THREE.Material): void {
  const box = new Pile(new THREE.BoxGeometry(1, 1, 1), kit.base.clone())
  const coneGeo = new THREE.ConeGeometry(1, 1, 5).toNonIndexed()
  coneGeo.computeVertexNormals()
  coneGeo.translate(0, 0.5, 0)
  const cone = new Pile(coneGeo, kit.base.clone())
  const glow = new Pile(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  const cloud = new Pile(new THREE.BoxGeometry(1, 1, 1), cloudMat)
  const SEA = OCEAN_Y

  // ── the sea, out to the fog: one flat sheet under the moving cells ───────
  const floor = new THREE.Mesh(new THREE.BoxGeometry(5000, 2, 5000), kit.mat(0x2a7fd6))
  floor.position.set(700, SEA - 3.7, 0)
  root.add(floor)

  // ── pieces ───────────────────────────────────────────────────────────────
  /** a peak: a cone, and snow on it if it is tall */
  const peak = (x: number, z: number, r: number, h: number, c: number, snow: number | null): void => {
    cone.add(x, SEA, z, r, h, r * (0.8 + q() * 0.4), c, q() * 6.28)
    if (snow !== null && h > 90) cone.add(x, SEA + h * 0.66, z, r * 0.36, h * 0.35, r * 0.36 * (0.8 + q() * 0.4), snow, q() * 6.28)
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
  /** a coral rock: stacked, a pale rim on top, sometimes a tree */
  const coral = (x: number, z: number, r: number, h: number, treed = false, y = SEA): void => {
    box.add(x, y + h / 2, z, r * 2, h, r * 1.6, 0xd9785e, q() * 1.5)
    box.add(x + r * 0.2, y + h * 0.8, z - r * 0.1, r * 1.4, h * 0.5, r * 1.3, 0xe2907a, q() * 1.5)
    box.add(x, y + h * 1.05, z, r * 1.5, 0.8, r * 1.2, 0xf0b39c, q() * 1.5)
    if (treed) tree(x, y + h * 1.05, z, r * 0.16)
  }
  /** a green headland on a sand strip */
  const land = (x: number, z: number, w: number, d: number, h: number, ry = 0): void => {
    box.add(x, SEA + h * 0.35, z, w * 1.12, h * 0.7, d * 1.12, 0xe9d8a6, ry)
    box.add(x, SEA + h * 0.8, z, w, h * 0.5, d, 0x7fb35a, ry)
  }

  // ── north: the range, snow on it, the coast and its town in front ────────
  for (let x = 250; x <= 1250; x += 70) {
    const h = 90 + q() * 70
    peak(x + (q() - 0.5) * 30, -600 + (q() - 0.5) * 40, 55 + q() * 35, h, 0x7a95bd, 0xf4f7fb)
  }
  for (let x = 330; x <= 1180; x += 85) {
    peak(x + (q() - 0.5) * 30, -520 + (q() - 0.5) * 30, 40 + q() * 30, 50 + q() * 40, 0x5f7fa6, null)
  }
  land(720, -430, 340, 90, 8)
  for (let k = 0; k < 16; k++) house(600 + q() * 240, SEA + 8, -455 + q() * 40, 5 + q() * 3, q() < 0.7 ? 0xc9503c : 0xd8743c, q() * 1.5)
  for (let k = 0; k < 14; k++) tree(570 + q() * 300, SEA + 8, -470 + q() * 45, 1.6 + q() * 1)
  lighthouse(580, SEA + 8, -395)
  land(1010, -445, 120, 60, 7)
  for (let k = 0; k < 6; k++) house(980 + q() * 60, SEA + 7, -455 + q() * 20, 4.5 + q() * 2, 0xc9503c, q() * 1.5)
  // ── north-east: the volcano, its smoke ───────────────────────────────────
  cone.add(1210, SEA, -440, 125, 175, 125, 0x9a7a86, 0.4)
  cone.add(1210, SEA + 118, -440, 42, 60, 42, 0xe7dfe3, 0.4)
  glow.add(1210, SEA + 176, -440, 9, 6, 9, 0xff7a4a)
  for (let k = 0; k < 7; k++) box.add(1210 + k * 2.5, SEA + 182 + k * 9, -440 - k * 1.5, 4 + k * 0.7, 9, 4 + k * 0.7, 0xd9d3dc, q() * 1.5)
  cloud.add(1226, SEA + 250, -450, 34, 9, 22, 0xffffff)
  cloud.add(1240, SEA + 258, -452, 22, 8, 16, 0xffffff)
  for (let k = 0; k < 6; k++) coral(1090 + k * 32 + (q() - 0.5) * 12, -330 - k * 8 + (q() - 0.5) * 20, 6 + q() * 5, 6 + q() * 5, q() < 0.4)

  // ── east: the stacks and the arch, the wooded islets, the giant tree ─────
  coral(1215, 70, 16, 22); coral(1240, 108, 12, 30); coral(1190, 128, 10, 18, true)
  // the arch: two pillars and what they hold up, the sea showing under it
  box.add(1225, SEA + 14, 160, 12, 28, 12, 0xd9785e, 0.3)
  box.add(1225, SEA + 14, 196, 12, 28, 12, 0xd9785e, 0.3)
  box.add(1225, SEA + 31, 178, 14, 8, 48, 0xe2907a, 0.3)
  box.add(1225, SEA + 36, 178, 11, 2, 44, 0xf0b39c, 0.3)
  coral(1160, -50, 20, 6, false); for (let k = 0; k < 5; k++) tree(1150 + q() * 22, SEA + 6.3, -60 + q() * 20, 2 + q() * 1.2)
  coral(1275, 230, 18, 6, false); for (let k = 0; k < 4; k++) tree(1266 + q() * 20, SEA + 6.3, 222 + q() * 16, 2 + q() * 1.2)
  coral(1250, -190, 26, 14)
  box.add(1250, SEA + 30, -190, 5, 34, 5, 0x7a4b2a)
  box.add(1252, SEA + 50, -186, 44, 16, 40, 0x8bc34a, 0.5)
  box.add(1240, SEA + 60, -198, 28, 12, 26, 0x9ccc4e, 0.9)
  box.add(1264, SEA + 44, -176, 22, 10, 20, 0x5e9f3a, 0.2)

  // ── south: the storm on its legs, the dark spire and its waterfalls ──────
  const SX = 820, SZ = 500
  for (const [dx, dz, w, d, y, h] of [[0, 0, 190, 110, 108, 12], [-30, 10, 130, 80, 118, 12], [40, -6, 110, 70, 120, 12], [10, 4, 80, 50, 131, 12], [-70, -20, 70, 40, 104, 10], [80, 30, 60, 40, 102, 10]] as number[][]) {
    cloud.add(SX + dx, SEA + y, SZ + dz, w, h, d, 0xe3e8ef)
  }
  for (let k = 0; k < 9; k++) glow.add(SX - 80 + k * 20 + (q() - 0.5) * 8, SEA + 52, SZ + (q() - 0.5) * 70, 1.4, 100, 1.4, 0xd5e1ec)
  for (let k = 0; k < 5; k++) glow.add(SX - 6 + (k % 2) * 6, SEA + 96 - k * 12, SZ, 1.6, 13, 1.6, 0xfff1a8, 0, (k % 2 ? -1 : 1) * 0.45)
  for (let k = 0; k < 5; k++) { const s = 1 - k * 0.14; box.add(560 + k * 3, SEA + 12 + k * 18, 470 - k * 2, 26 * s, 20, 22 * s, [0x4c5563, 0x5a6472, 0x454e5c][k % 3], k * 0.3) }
  box.add(575, SEA + 100, 462, 16, 4, 14, 0x6da84a, 0.3)
  tree(572, SEA + 102, 460, 1.4, 0x8bc34a)
  glow.add(548, SEA + 60, 468, 2.4, 96, 3.5, 0xe4f6ff)
  glow.add(570, SEA + 50, 482, 2, 78, 3, 0xe4f6ff)
  for (let k = 0; k < 5; k++) coral(1020 + k * 45 + (q() - 0.5) * 12, 490 + (q() - 0.5) * 30, 6 + q() * 5, 6 + q() * 6, q() < 0.5)

  // ── the western corners: pastel towns of windmills, a pier, balloons and kites ──
  for (const [tx, tz, side] of [[330, -470, -1], [340, 470, 1]] as number[][]) {
    land(tx, tz, 150, 100, 8)
    for (let k = 0; k < 11; k++) house(tx - 55 + q() * 110, SEA + 8, tz - 35 + q() * 70, 4.5 + q() * 2.5, [0xc9503c, 0xd8743c, 0xdbb0c9][Math.floor(q() * 3)], q() * 1.5)
    for (let k = 0; k < 8; k++) tree(tx - 65 + q() * 130, SEA + 8, tz - 45 + q() * 90, 1.4 + q() * 1)
    windmill(tx - 50, SEA + 8, tz - side * 30)
    windmill(tx + 20, SEA + 8, tz - side * 42)
    // terraced fields
    for (let k = 0; k < 4; k++) box.add(tx + 40 + k * 7, SEA + 8.4, tz + side * 20, 6, 0.6, 30, k % 2 ? 0xa8c35a : 0xc9b264)
    box.add(tx + 100, SEA + 1.2, tz - side * 20, 70, 1.2, 5, 0xb08a5e)
    for (let k = 0; k < 6; k++) box.add(tx + 70 + k * 12, SEA - 0.5, tz - side * 20, 1, 4, 1, 0x8a6a42)
    lighthouse(tx + 136, SEA + 1.8, tz - side * 20, 16)
    balloon(tx + 20 + q() * 40, SEA + 105 + q() * 20, tz - side * (60 + q() * 40), 0xe05a4e)
    balloon(tx - 40 + q() * 40, SEA + 118 + q() * 20, tz - side * (30 + q() * 40), 0xf2a541)
    for (let k = 0; k < 3; k++) glow.add(tx - 20 + k * 30 + q() * 10, SEA + 70 + q() * 25, tz - side * (50 + q() * 30), 3.5, 3.5, 0.4, [0xe05a4e, 0xf7d94c, 0x4fb3e8][k], 0, 0.78)
  }

  // ── on the water: boats, whales, the odd coral rock — out beyond the islands, and off the way in ──
  const cx = 710, cz = 20
  const open = (x: number, z: number): boolean => Math.hypot(x - cx, z - cz) > 400 && (x > 330 || Math.abs(z) > 380) && x < 1290 && Math.abs(z) < 520
  for (let k = 0, tries = 0; k < 9 && tries < 200; tries++) {
    const a = q() * 6.28, r = 420 + q() * 260, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    boat(x, z, q() * 6.28); k += 1
  }
  for (let k = 0, tries = 0; k < 4 && tries < 200; tries++) {
    const a = q() * 6.28, r = 420 + q() * 200, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    whale(x, z, q() * 6.28); k += 1
  }
  for (let k = 0, tries = 0; k < 14 && tries < 300; tries++) {
    const a = q() * 6.28, r = 430 + q() * 300, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (!open(x, z)) continue
    coral(x, z, 5 + q() * 7, 5 + q() * 9, q() < 0.5); k += 1
  }
  // ── far cloud, flat-bottomed, low on the horizon all round ───────────────
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * 6.28 + q() * 0.3, r = 780 + q() * 160, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (x < 200 && Math.abs(z) < 300) continue
    const w = 60 + q() * 70
    cloud.add(x, SEA + 120 + q() * 60, z, w, 8 + q() * 6, 24 + q() * 24, 0xffffff, q() * 1.5)
    cloud.add(x + w * 0.2, SEA + 128 + q() * 60, z + 4, w * 0.5, 8, 18, 0xffffff, q() * 1.5)
  }

  box.commit(root); cone.commit(root); glow.commit(root); cloud.commit(root)
}
