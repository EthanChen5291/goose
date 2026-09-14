// Seek near the end of a song, play the last notes, and shoot the finish and the results.
import { chromium } from 'playwright'

/** pick a level on the world map: turn worlds until its stone is there, click it, open its card */
async function pickSong(page, title) {
  for (let i = 0; i < 10; i++) {
    const n = page.locator(`.map-node[data-title^="${title}"]`)
    if (await n.count()) { await n.first().click(); await page.waitForTimeout(350); await n.first().click(); await page.waitForTimeout(300); return }
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250)
  }
  throw new Error(`no level ${title}`)
}
const BASE = 'http://localhost:4173', SHOTS = '.scratch/shots'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('.title-play').click(); await page.waitForSelector('.map-node')
await pickSong(page, process.env.SONG ?? 'Decisive')
await page.locator('#play').click(); await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 60000 }); await page.waitForTimeout(600)
await page.evaluate(async () => {
  const s = window.__session
  const bm = s.rhythm.beatMap.filter((e) => !e.is_rest && e.char)
  s.seek(bm[bm.length - 6].timestamp - 1.5)
  const deadline = performance.now() + 30000
  while (performance.now() < deadline) {
    const ev = s.rhythm.currentEvent()
    if (ev === null) break
    if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
    const wait = (ev.timestamp - s.clock.now()) * 1000
    if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 30))); continue }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
    await new Promise((r) => setTimeout(r, 2))
  }
})
await page.waitForTimeout(700)
await page.screenshot({ path: `${SHOTS}/08-finish.png` })
await page.waitForTimeout(3500)
await page.screenshot({ path: `${SHOTS}/09-results.png` })
console.log('errors:', errors.length ? errors : 'none')
await browser.close()
