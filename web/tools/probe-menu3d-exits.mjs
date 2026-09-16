/**
 * The other two exits: SETTINGS (the tip into the hole) and SONGS (left), and the title coming back.
 *     node tools/probe-menu3d-exits.mjs        # BASE defaults to the dev server on :5173
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
const centre = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1500)
// SETTINGS: walk there, then the tip
let [x, y] = await centre('.title-settings')
await page.mouse.move(x, y, { steps: 4 })
await page.waitForTimeout(2200)
let t0 = Date.now()
await page.mouse.click(x, y)
await at(t0, [['s0-selfie', 700], ['s1-tip-a', 1500], ['s1-tip-b', 1650], ['s2-slide', 1800], ['s3-fall', 1950], ['s4-hole', 2100], ['s5-down', 2300], ['s6-panel', 3200]])
// close the panel: the title comes back with the goose on SETTINGS
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const closeBtn = page.locator('.settings-card button, .card button').filter({ hasText: /back|close|done/i }).first()
if (await closeBtn.count()) await closeBtn.click()
await page.waitForTimeout(1200)
await shot('s7-back')
// SONGS: walk over, then the exit left
;[x, y] = await centre('.title-songs')
await page.mouse.move(x, y, { steps: 4 })
await page.waitForTimeout(2200)
t0 = Date.now()
await page.mouse.click(x, y)
await at(t0, [['g0-selfie', 700], ['g1-exit-a', 1400], ['g1-exit-b', 1550], ['g1-exit-c', 1700], ['g2-panel', 2600]])
console.log('errors:', errors.length ? errors.slice(0, 10) : 'none')
await browser.close()
