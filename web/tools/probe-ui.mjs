/**
 * The UI pass: SETTINGS straight up from the title, the 0.5 selfie on PLAY,
 * the map's kit buttons, and the emotes over the goose on the island.
 *     node tools/probe-ui.mjs        # BASE defaults to the preview server on :4173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots-ui'
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
// the title lifts on its own when the theme plays (autoplay is allowed here)
await page.waitForTimeout(1500)
await shot('t0-menu')
// SETTINGS: the panel, no journey
let [px, py] = await centre('.title-settings')
await page.mouse.move(px, py, { steps: 4 })
await page.waitForTimeout(900)
let t0 = Date.now()
await page.mouse.click(px, py)
await at(t0, [['s0-settings-a', 150], ['s0-settings-b', 800]])
// hover a pill, drag a slider a little
const pill = await page.locator('.set-pill').nth(2).boundingBox()
await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2)
await page.waitForTimeout(200)
await shot('s1-settings-hover')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await shot('s2-settings-closed')
// PLAY: the selfie, warped, then the launch
;[px, py] = await centre('.title-play')
await page.mouse.move(px, py, { steps: 4 })
await page.waitForTimeout(1500)
t0 = Date.now()
await page.mouse.click(px, py)
await at(t0, [['p0-selfie-a', 200], ['p0-selfie-b', 500], ['p0-selfie-c', 900], ['p0-selfie-d', 1200], ['p1-exit-a', 1350], ['p1-exit-b', 1500], ['p1-exit-c', 1700]])
await page.waitForSelector('.map-root.in', { timeout: 40000 })
await page.waitForTimeout(400)
await shot('m0-map')
const rb = await page.locator('.map-arrow-r').boundingBox()
await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
await page.waitForTimeout(200)
await shot('m1-hover-arrow')
await page.mouse.down()
await page.waitForTimeout(100)
await shot('m1-press-arrow')
await page.mouse.up()
await page.mouse.move(10, 10)
// the emotes: idle acts every few seconds
t0 = Date.now()
for (let i = 0; i < 16; i++) { await page.waitForTimeout(450); await shot(`e${String(i).padStart(2, '0')}-idle`) }
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
await shot('m2-card')
console.log('errors:', errors)
await browser.close()
