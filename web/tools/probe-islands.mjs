/**
 * The chase and the islands: PLAY → the drone after the goose, through the cloud,
 * over the archipelago, down to an island; then a page through every island.
 *     node tools/probe-islands.mjs        # BASE defaults to the dev server on :5173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots-islands'
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
const at = async (t0, list) => { for (const [name, ms] of list) { const wait = t0 + ms - Date.now(); if (wait > 0) await page.waitForTimeout(wait); await shot(name) } }
const centre = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2, b] }

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1500)
await shot('00-menu')
const [px, py] = await centre('.title-play')
await page.mouse.move(px, py, { steps: 4 })
await page.waitForTimeout(1200)
let t0 = Date.now()
await page.mouse.click(px, py)
const frames = []
for (let ms = 700; ms <= 9000; ms += 250) frames.push([`c${String(ms).padStart(5, '0')}`, ms])
await at(t0, frames)
const ready = await page.waitForSelector('.map-root.in', { timeout: 30000 }).then(() => true).catch(() => false)
console.log('map ready:', ready, 'after', ((Date.now() - t0) / 1000).toFixed(1), 's')
await page.waitForTimeout(1500)
await shot('i0-settled')
// through the islands
const worlds = Number(process.env.WORLDS ?? 7)
for (let k = 1; k < worlds; k++) {
  t0 = Date.now()
  await page.keyboard.press('ArrowUp')
  const fly = k === 5
    ? Array.from({ length: 22 }, (_, i) => [`w${k}-v${String(i).padStart(2, '0')}`, 500 + i * 400])
    : [[`w${k}-fly-a`, 500], [`w${k}-fly-b`, 1000], [`w${k}-fly-c`, 1500], [`w${k}-fly-d`, 2100]]
  await at(t0, fly)
  const ok = await page.waitForSelector('.map-root.in', { timeout: 30000 }).then(() => true).catch(() => false)
  console.log(`world ${k} ready:`, ok, 'after', ((Date.now() - t0) / 1000).toFixed(1), 's')
  await page.waitForTimeout(2200)
  await shot(`w${k}-settled`)
  await page.waitForTimeout(1500)
  await shot(`w${k}-later`)
}
const info = await page.evaluate(() => (window.__movieInfo ? window.__movieInfo() : null))
console.log('render info:', info)
console.log('errors:', errors.length ? errors.slice(0, 12) : 'none')
await browser.close()
