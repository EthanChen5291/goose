/** the ways back and on from an island: Escape to the title, and PLAY → the abduction on the island */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots-islands-back'
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
const at = async (t0, list) => { for (const [name, ms] of list) { const wait = t0 + ms - Date.now(); if (wait > 0) await page.waitForTimeout(wait); await shot(name) } }
const centre = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1200)
let [px, py] = await centre('.title-play')
await page.mouse.move(px, py, { steps: 4 }); await page.waitForTimeout(900)
await page.mouse.click(px, py)
await page.waitForSelector('.map-root.in', { timeout: 30000 })
await page.waitForTimeout(800)
await page.keyboard.press('ArrowUp')
await page.waitForSelector('.map-root.in', { timeout: 30000 })
await page.waitForTimeout(500)
await shot('b0-dusk')
let t0 = Date.now()
await page.keyboard.press('Escape')
await at(t0, [['b1-back-a', 150], ['b1-back-b', 400], ['b1-back-c', 650], ['b1-back-d', 850], ['b1-back-e', 1050], ['b1-back-f', 1300], ['b1-back-g', 1550], ['b1-back-h', 1800], ['b1-back-i', 2050], ['b1-back-j', 2400], ['b1-back-k', 2900]])
await page.waitForSelector('.title-play', { timeout: 20000 })
;[px, py] = await centre('.title-play')
await page.mouse.move(px, py, { steps: 4 }); await page.waitForTimeout(900)
await page.mouse.click(px, py)
await page.waitForSelector('.map-root.in', { timeout: 30000 })
await page.waitForTimeout(1500)
await shot('b2-map-again')
await page.keyboard.press('Enter'); await page.waitForTimeout(400); await shot('b3-card')
t0 = Date.now()
await page.keyboard.press('Enter')
await at(t0, [['b4-ufo', 250], ['b5-beam', 500], ['b6-slap', 760], ['b7-up', 1200], ['b8-zip', 1450], ['b9-after', 2200]])
const info = await page.evaluate(() => (window.__movieInfo ? window.__movieInfo() : null))
console.log('info:', info)
console.log('errors:', errors.length ? errors.slice(0, 12) : 'none')
await browser.close()
