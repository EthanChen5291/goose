/**
 * Screenshots of the pixel play screen, with the notes being played.
 *
 *     node tools/shots-px.mjs               # needs `vite preview` on :4173
 *     SONG=Scorpion TIER=1 node tools/shots-px.mjs
 *
 * Starts a song, presses every note on time for a while (so the goose fights),
 * misses a few on purpose (so the enemy answers), shoots the screen along the
 * way, then opens the pause menu and shoots that.  Console errors are reported.
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

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots'
const SONG = process.env.SONG ?? 'Scorpion'
const TIER = Number(process.env.TIER ?? 1)
const MODE = Number(process.env.MODE ?? 0)
const W = Number(process.env.W ?? 1512)
const H = Number(process.env.H ?? 887)
const DPR = Number(process.env.DPR ?? 2)
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    const loc = m.location()
    errors.push(`[${m.type()}] ${m.text().slice(0, 300)} @ ${loc.url?.split('/').pop()}:${loc.lineNumber}:${loc.columnNumber} args=${m.args().length}`)
  }
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.screenshot({ path: `${SHOTS}/00-title.png` })
await page.locator('.title-play').click()
await page.waitForSelector('.map-node', { timeout: 20000 })
await pickSong(page, SONG)
await page.locator('#tiers .chip').nth(TIER).click()
await page.locator('#modes .chip').nth(MODE).click()
await page.screenshot({ path: `${SHOTS}/01-select.png` })
await page.locator('#play').click()
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 60000 })
await page.waitForTimeout(800)

/** Play along for `seconds`, missing every `missEvery`-th note. */
async function playAlong(seconds, missEvery) {
  await page.evaluate(async ({ seconds, missEvery }) => {
    const s = window.__session
    const deadline = performance.now() + seconds * 1000
    let n = 0
    const held = new Set()
    while (performance.now() < deadline) {
      const ev = s.rhythm.currentEvent()
      if (ev === null) break
      if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
      const wait = (ev.timestamp - s.clock.now()) * 1000
      if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 30))); continue }
      n += 1
      if (missEvery && n % missEvery === 0) {
        // let it go by
        await new Promise((r) => setTimeout(r, (s.rhythm.okWindowFor(ev) + 0.05) * 1000))
        continue
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
      if (ev.hold_duration > 0) {
        held.add(ev.char)
        const until = ev.timestamp + ev.hold_duration
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
          held.delete(ev.char)
        }, Math.max(0, (until - s.clock.now()) * 1000))
      } else {
        window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 2))
    }
  }, { seconds, missEvery })
}

// the count-in
await page.screenshot({ path: `${SHOTS}/02-countin.png` })
await playAlong(5, 0)
// shoot on the very next press, while the goose is mid-move
await page.evaluate(async () => {
  const s = window.__session
  for (let i = 0; i < 400; i++) {
    const ev = s.rhythm.currentEvent()
    if (ev && !ev.is_rest && ev.char && ev.timestamp - s.clock.now() < 0.006) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
      return
    }
    await new Promise((r) => setTimeout(r, 5))
  }
})
await page.waitForTimeout(40)
await page.screenshot({ path: `${SHOTS}/03-play-a.png` })
await playAlong(3, 0)
await page.screenshot({ path: `${SHOTS}/04-play-b.png` })
await playAlong(4, 3)
await page.screenshot({ path: `${SHOTS}/05-play-miss.png` })
await playAlong(4, 0)
await page.screenshot({ path: `${SHOTS}/06-play-c.png` })

const stats = await page.evaluate(() => {
  const s = window.__session
  return { combo: s.rhythm.combo, acc: s.rhythm.getAccuracy().toFixed(1), t: s.clock.now().toFixed(1),
           buffer: window.__pxCanvas ? [window.__pxCanvas.w, window.__pxCanvas.h, window.__pxCanvas.scale] : null }
})
console.log('stats', JSON.stringify(stats))

// pause
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await page.screenshot({ path: `${SHOTS}/07-pause.png` })

console.log('errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
