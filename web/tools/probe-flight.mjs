/**
 * The drone's flights, measured: PLAY → the chase and the approach, then a page through the islands, reading back
 * the per-frame trace (speed, roll, pitch, yaw, acceleration) and reporting, per flight, how rough it was:
 * the biggest one-frame steps in roll and in yaw rate, and the biggest acceleration.  Shots along the way.
 *     node tools/probe-flight.mjs        # BASE defaults to the dev server on :5173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots-flight'
const WORLDS = Number(process.env.WORLDS ?? 7)
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
const traceLen = () => page.evaluate(() => window.__trace.length)
const deg = (r) => (r * 180 / Math.PI)
/**
 * the roughness of a run of trace rows, as rates so a slow frame (a screenshot) does not count as a jolt: the fastest the
 * roll and the yaw rate changed, the biggest acceleration, and the fastest the speed changed — over frames under 40 ms
 * that are not inside an asked-for shake (a landing's thud is a jolt on purpose)
 */
const rough = (rows) => {
  let rollRate = 0, yawAcc = 0, accMax = 0, dSpeed = 0, prevYawRate = null, prevT = null
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    const dt = b[0] - a[0]
    if (dt <= 0 || dt > 0.04 || b[10]) { prevYawRate = null; continue }
    rollRate = Math.max(rollRate, Math.abs(b[2] - a[2]) / dt)
    const yawRate = Math.atan2(Math.sin(b[4] - a[4]), Math.cos(b[4] - a[4])) / dt
    if (prevYawRate !== null) yawAcc = Math.max(yawAcc, Math.abs(yawRate - prevYawRate) / dt)
    prevYawRate = yawRate
    accMax = Math.max(accMax, b[5])
    dSpeed = Math.max(dSpeed, Math.abs(b[1] - a[1]) / dt)
  }
  const top = Math.max(...rows.map((r) => r[1]))
  const dur = rows.length ? rows[rows.length - 1][0] - rows[0][0] : 0
  return `${rows.length} frames ${dur.toFixed(1)}s  top ${top.toFixed(0)}u/s  roll ${deg(rollRate).toFixed(0)}°/s  yaw ${deg(yawAcc).toFixed(0)}°/s²  acc ${accMax.toFixed(0)}  Δv ${dSpeed.toFixed(0)}u/s²`
}
/** a line per 0.4 s: speed, roll, progress, height */
const timeline = (rows) => {
  const out = []
  let next = rows[0]?.[0] ?? 0
  for (const r of rows) if (r[0] >= next) { out.push(`${r[0].toFixed(1)}: v${r[1].toFixed(0)} roll${deg(r[2]).toFixed(1)} pitch${deg(r[3]).toFixed(0)} u${r[6].toFixed(2)} y${r[8].toFixed(0)}`); next += 0.4 }
  return out.join(' | ')
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1200)
const b = await page.locator('.title-play').boundingBox()
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }); await page.waitForTimeout(800)
let from = await traceLen()
let t0 = Date.now()
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
const shotsDuring = async (prefix, until) => { let i = 0; while (Date.now() < until) { await shot(`${prefix}-${String(i++).padStart(2, '0')}`); await page.waitForTimeout(400) } }
const ready = page.waitForSelector('.map-root.in', { timeout: 30000 }).then(() => Date.now() - t0)
await shotsDuring('chase', t0 + 8000)
console.log('chase → chrome', (await ready / 1000).toFixed(1), 's')
await page.waitForTimeout(1500)
let rows = await page.evaluate((f) => window.__trace.slice(f), from)
console.log('chase:', rough(rows))
if (process.env.TL) console.log('  ', timeline(rows))
for (let k = 1; k < WORLDS; k++) {
  from = await traceLen()
  t0 = Date.now()
  await page.keyboard.press('ArrowUp')
  const ok = page.waitForSelector('.map-root.in', { timeout: 30000 }).then(() => Date.now() - t0)
  await shotsDuring(`w${k}`, t0 + 4000)
  const ms = await ok
  await page.waitForTimeout(2500)
  rows = await page.evaluate((f) => window.__trace.slice(f), from)
  const info = await page.evaluate(() => window.__movieInfo())
  console.log(`flight ${k} → ${info.island}: chrome ${(ms / 1000).toFixed(1)}s  ${rough(rows)}`)
  if (process.env.TL) console.log('  ', timeline(rows))
}
console.log('errors:', errors.length ? errors.slice(0, 12) : 'none')
await browser.close()
