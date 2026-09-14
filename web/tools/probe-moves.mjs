/**
 * Do the heavy moves fire, and does the screen survive them?  Plays Scorpion
 * cleanly for a while, logs every move the goose makes, and shoots the screen
 * mid-boulder, mid-uppercut and mid-flop when it can catch them.
 *     node tools/probe-moves.mjs        # needs `vite preview` on :4173
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
const SECS = Number(process.env.SECS ?? 40)
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 200)}`) })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.map-node', { timeout: 20000 })
await pickSong(page, SONG)
await page.locator('#tiers .chip').nth(Number(process.env.TIER ?? 1)).click()
await page.locator('#modes .chip').nth(Number(process.env.MODE ?? 0)).click()
await page.locator('#play').click()
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 60000 })
await page.waitForTimeout(600)

// press every note on time in the page, and watch the goose
await page.evaluate(({ SECS }) => {
  const s = window.__session
  window.__moves = {}
  window.__shots = []
  const goose = s.renderer.fight.goose
  let last = null
  const watch = () => {
    const cur = goose.current
    if (cur !== last) { last = cur; if (cur) window.__moves[cur] = (window.__moves[cur] ?? 0) + 1 }
    requestAnimationFrame(watch)
  }
  watch()
  ;(async () => {
    const deadline = performance.now() + SECS * 1000
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
    window.__done = true
  })()
}, { SECS })

// shoot the heavy moves as they happen
const wanted = new Set(['boulder', 'uppercut', 'bellyflop', 'dropkick', 'megahonk'])
const got = new Set()
const start = Date.now()
while (Date.now() - start < (SECS + 2) * 1000 && got.size < wanted.size) {
  const st = await page.evaluate(() => {
    const g = window.__session.renderer.fight.goose
    return { cur: g.current, winding: g.isWindingUp, key: g.keyIdx, done: window.__done }
  })
  if (st.done) break
  if (st.cur && wanted.has(st.cur) && !got.has(st.cur)) {
    // for the boulder wait until the rock is in the air (key 2–3 of the wind-up), else shoot now
    if (st.cur === 'boulder' && st.winding && st.key < 2) { await page.waitForTimeout(30); continue }
    got.add(st.cur)
    await page.screenshot({ path: `${SHOTS}/move-${st.cur}${st.winding ? '-windup' : ''}.png` })
    if (st.winding) {
      await page.waitForTimeout(260)
      await page.screenshot({ path: `${SHOTS}/move-${st.cur}-contact.png` })
    }
  }
  await page.waitForTimeout(25)
}
const out = await page.evaluate(() => ({ moves: window.__moves, acc: window.__session.rhythm.getAccuracy().toFixed(1), combo: window.__session.rhythm.combo }))
console.log(JSON.stringify(out))
console.log('errors:', errors.length ? errors.slice(0, 6) : 'none')
await browser.close()
