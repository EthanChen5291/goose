/**
 * The finish: DOWN!, the stance's three cuts, the dialogue, then results.
 *     node tools/probe-win.mjs        # BASE defaults to the dev server on :5173
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

/** pick a level on the world map: turn worlds until its stone is there, click it, open its card */
async function pickSong(page, title) {
  for (let i = 0; i < 10; i++) {
    const n = page.locator(`.map-node[data-title^="${title}"]`)
    if (await n.count()) { await n.first().click(); await page.waitForTimeout(350); await n.first().click(); await page.waitForTimeout(300); return }
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250)
  }
  throw new Error(`no level ${title}`)
}
const BASE = process.env.BASE ?? 'http://localhost:5173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots'
const SONG = process.env.SONG ?? 'Scorpion'
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.map-node', { timeout: 20000 })
await page.waitForTimeout(1300)
await pickSong(page, SONG.slice(0, 9))
await page.waitForTimeout(300)
await page.locator('#tiers .chip').nth(1).click()
await page.waitForTimeout(300)
await page.locator('#play').click()
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 40000 })
await page.waitForTimeout(800)
// seek to the last bars and play them clean
await page.evaluate(() => {
  const s = window.__session
  const bm = s.rhythm.beatMap.filter((e) => !e.is_rest && e.char)
  s.seek(bm[bm.length - 8].timestamp - 1.2)
})
await page.evaluate(async () => {
  const s = window.__session
  const deadline = performance.now() + 9000
  while (performance.now() < deadline) {
    const ev = s.rhythm.currentEvent()
    if (ev === null) break
    if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
    const wait = (ev.timestamp - s.clock.now()) * 1000
    if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 30))); continue }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
    if (ev.hold_duration > 0) {
      const until = ev.timestamp + ev.hold_duration
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true })), Math.max(0, (until - s.clock.now()) * 1000))
    } else window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
    await new Promise((r) => setTimeout(r, 2))
  }
})
// wait for the DOWN!
await page.waitForFunction(() => window.__session?.renderer?.won === true, null, { timeout: 20000 })
await page.waitForTimeout(150)
await page.screenshot({ path: `${SHOTS}/win-0-down.png` })
await page.waitForTimeout(500)
await page.screenshot({ path: `${SHOTS}/win-1-flyoff.png` })
await page.waitForSelector('.win-root', { timeout: 20000 })
const t0 = Date.now()
for (const [name, at] of [['win-2-grow', 150], ['win-3-low', 600], ['win-3b-low', 1300], ['win-4-high', 1900], ['win-4b-high', 2700], ['win-5-face', 3300], ['win-5b-line', 4400]]) {
  const wait = t0 + at - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}
await page.waitForSelector('.px-results', { timeout: 20000 })
await page.waitForTimeout(600)
await page.screenshot({ path: `${SHOTS}/win-6-results.png` })
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
