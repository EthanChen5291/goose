/**
 * The 3D menu flow: title plates → the goose following the pointer → press → map arrival → abduction.
 *     node tools/probe-menu3d.mjs        # BASE defaults to the dev server on :5173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots3d'
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
await page.waitForTimeout(1800)
await shot('t0-menu')
// the pointer onto PLAY's text (lower left of the plate): the goose walks over the letters
let [px, py, pb] = await centre('.title-play')
let t0 = Date.now()
await page.mouse.move(pb.x + pb.width * 0.22, pb.y + pb.height * 0.7, { steps: 4 })
await at(t0, [['t1-text-a', 250], ['t1-text-b', 600], ['t1-text-c', 1100]])
// the pointer to SONGS: walk to the rim, hop, walk in
;[px, py, pb] = await centre('.title-songs')
t0 = Date.now()
await page.mouse.move(px + pb.width * 0.1, py, { steps: 4 })
await at(t0, [['t2-songs-a', 200], ['t2-songs-b', 450], ['t2-songs-c', 700], ['t2-songs-d', 1000], ['t2-songs-e', 1500]])
// the pointer off every plate: the goose stands at the nearest edge and watches it
t0 = Date.now()
await page.mouse.move(pb.x + pb.width * 0.5, pb.y + pb.height + 120, { steps: 4 })
await at(t0, [['t3-watch-a', 600], ['t3-watch-b', 1300]])
await page.mouse.move(pb.x + pb.width * 1.1, pb.y + pb.height + 100, { steps: 4 })
await page.waitForTimeout(700)
await shot('t3-watch-c')
// SETTINGS
;[px, py, pb] = await centre('.title-settings')
t0 = Date.now()
await page.mouse.move(px, py, { steps: 4 })
await at(t0, [['t4-settings-a', 400], ['t4-settings-b', 800], ['t4-settings-c', 1500]])
// back to PLAY and press it: the phone shot, the launch, the map arrival
;[px, py, pb] = await centre('.title-play')
await page.mouse.move(px, py, { steps: 4 })
await page.waitForTimeout(1800)
await shot('t5-on-play')
t0 = Date.now()
await page.mouse.click(px, py)
await at(t0, [['p0-selfie-a', 200], ['p0-selfie-b', 700], ['p0-selfie-c', 1150], ['p1-exit-a', 1400], ['p1-exit-b', 1550], ['p1-exit-c', 1700],
              ['m0-arrive-a', 2150], ['m0-arrive-b', 2400], ['m0-arrive-c', 2650], ['m0-arrive-d', 2950], ['m0-arrive-e', 3300], ['m0-arrive-f', 3800], ['m1-settled', 5200]])
await page.waitForSelector('.map-node', { timeout: 20000 })
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(120)
await shot('m2-walk')
await page.waitForTimeout(600)
await shot('m3-idle')
await page.waitForTimeout(3500)
await shot('m4-act')
// play: the abduction
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
await shot('m5-card')
t0 = Date.now()
await page.keyboard.press('Enter')
await at(t0, [['a0-ufo', 250], ['a1-beam', 500], ['a2-hands', 680], ['a3-slap', 760], ['a4-open', 900], ['a5-up', 1200], ['a6-zip', 1450], ['a7-after', 1900]])
console.log('errors:', errors.length ? errors.slice(0, 10) : 'none')
await browser.close()
