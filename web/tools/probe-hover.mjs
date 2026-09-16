import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const SHOTS = '.scratch/shots-hover'
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 200)}`) })
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/h0-idle.png` })
const c = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
const [px, py] = await c('.title-play')
await page.mouse.move(px, py, { steps: 3 })
for (const ms of [60, 140, 260, 600]) { await page.waitForTimeout(ms === 60 ? 60 : ms - [0, 60, 140, 260][[60, 140, 260, 600].indexOf(ms) - 1]); await page.screenshot({ path: `${SHOTS}/h1-play-${ms}.png` }) }
const [sx, sy] = await c('.title-songs')
await page.mouse.move(sx, sy, { steps: 3 })
for (const ms of [80, 200, 900]) { await page.waitForTimeout(ms === 80 ? 80 : ms - [0, 80, 200][[80, 200, 900].indexOf(ms) - 1]); await page.screenshot({ path: `${SHOTS}/h2-songs-${ms}.png` }) }
console.log('errors:', errors.length ? errors.slice(0, 6) : 'none')
await browser.close()
