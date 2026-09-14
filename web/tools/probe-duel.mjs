/**
 * The duel, played by a robot: opens a song in the Duel mode, presses every
 * note on time (or misses some), shoots the screen every so often and reports
 * what was thrown, what landed and what it cost.
 *     node tools/probe-duel.mjs         # needs `vite preview` on :4173
 *     SECS=30 MISS=0.2 SHOTS=.scratch/shots-duel node tools/probe-duel.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

async function pickSong(page, title) {
  for (let i = 0; i < 10; i++) {
    const n = page.locator(`.map-node[data-title^="${title}"]`)
    if (await n.count()) { await n.first().click(); await page.waitForTimeout(350); await n.first().click(); await page.waitForTimeout(300); return }
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250)
  }
  throw new Error(`no level ${title}`)
}
const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/shots-duel'
const SONG = process.env.SONG ?? 'Scorpion'
const SECS = Number(process.env.SECS ?? 30)
const MISS = Number(process.env.MISS ?? 0)
const EVERY = Number(process.env.EVERY ?? 1.5)
const SEEK = process.env.SEEK ? Number(process.env.SEEK) : null
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
await page.locator('#modes .chip').nth(1).click()
await page.locator('#play').click()
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 60000 })
await page.waitForTimeout(400)
if (SEEK !== null) await page.evaluate((s) => window.__session.seek(s), SEEK)

// press every note on time — the chart's letters were rewritten to d f j k ^ — skipping a share of them
await page.evaluate(({ SECS, MISS }) => {
  const s = window.__session
  let seed = 12345
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  ;(async () => {
    const deadline = performance.now() + SECS * 1000
    while (performance.now() < deadline) {
      const ev = s.rhythm.currentEvent()
      if (ev === null) break
      if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
      const wait = (ev.timestamp - s.clock.now()) * 1000
      if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 30))); continue }
      if (rnd() < MISS) { await new Promise((r) => setTimeout(r, 400)); continue }
      const key = ev.char === '^' ? ' ' : ev.char
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
      // the press is judged on the next frame: wait for the cursor to move on before pressing again
      for (let i = 0; i < 25 && s.rhythm.currentEvent() === ev; i++) await new Promise((r) => setTimeout(r, 4))
    }
    window.__done = true
  })()
}, { SECS, MISS })

const start = Date.now()
let n = 0
while (Date.now() - start < (SECS + 1) * 1000) {
  await page.screenshot({ path: `${SHOTS}/duel-${String(n++).padStart(2, '0')}.png` })
  const done = await page.evaluate(() => window.__done === true)
  if (done) break
  await page.waitForTimeout(EVERY * 1000)
}
const out = await page.evaluate(() => {
  const s = window.__session
  const r = s.renderer
  const hist = {}
  for (const h of s.rhythm.hits) hist[h.judgment] = (hist[h.judgment] ?? 0) + 1
  const slips = s.rhythm.hits.filter((h) => h.judgment === 'slip').slice(0, 5).map((h) => `${h.pressed}->${h.expected}@${h.t_song.toFixed(2)}`)
  return { counts: r.counts, hp: r.hp, acc: s.rhythm.getAccuracy().toFixed(1), combo: s.rhythm.combo, judged: s.rhythm.judgedNotes(), hist, slips, t: s.clock.now().toFixed(1) }
})
console.log(JSON.stringify(out))
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
