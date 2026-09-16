/**
 * The menu flow: title → level select arrival → zoom → pose → loading → play.
 *     node tools/probe-flow.mjs        # needs `vite preview` on :4173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots'
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(2500)
await page.locator('.title-play').click()
const t0 = Date.now()
for (const [name, at] of [['sel-0-grid', 200], ['sel-1-frames', 550], ['sel-2-flash', 850], ['sel-3-arrived', 1500], ['sel-4-settled', 3200]]) {
  const wait = t0 + at - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(500)
await page.screenshot({ path: `${SHOTS}/sel-5-next.png` })
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
await page.screenshot({ path: `${SHOTS}/sel-6-card.png` })
await page.keyboard.press('Enter')
const t1 = Date.now()
for (const [name, at] of [['go-0-fly', 250], ['go-1-zoomed', 600], ['go-2-morph', 800], ['go-3-pose', 1150], ['go-4-hold', 2000], ['go-5-hold2', 2900], ['go-6-loading', 3400], ['go-7-loading2', 4200]]) {
  const wait = t1 + at - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}
await page.waitForSelector('canvas.pixi, canvas:not(.px-movie)', { timeout: 30000 }).catch(() => null)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/go-8-play.png` })
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
