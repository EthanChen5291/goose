/**
 * Screenshots of the title movie and the song list.
 *     node tools/shots-title.mjs          # needs `vite preview` on :4173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots'
const W = Number(process.env.W ?? 1512), H = Number(process.env.H ?? 887), DPR = Number(process.env.DPR ?? 2)
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
for (const [i, ms] of [[0, 1500], [1, 4000], [2, 4000], [3, 4000]]) {
  await page.waitForTimeout(ms)
  await page.screenshot({ path: `${SHOTS}/title-${i}.png` })
}
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(200)
await page.screenshot({ path: `${SHOTS}/title-settings-row.png` })
await page.keyboard.press('ArrowUp')
await page.keyboard.press('Enter')
await page.waitForSelector('.song', { timeout: 20000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${SHOTS}/select.png` })
console.log(errors.length ? errors.join('\n') : 'no console errors')
await browser.close()
