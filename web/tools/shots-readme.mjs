/**
 * The pictures in the README, shot from the real game.
 *
 *     node web/tools/shots-readme.mjs            # needs a server on :5173 (npm run dev)
 *     BASE=http://localhost:4173 node ...        # or a built one (npm run build && vite preview)
 *
 * One pass through the whole flow — title, map, a words run, a duel run, the
 * results and the coach — screenshotting at each stop into docs/img/.  Shot at
 * 1280×720 with no device scaling, which lands the pixel buffer on a whole-number
 * scale: the art in the README is then the art, not a resampling of it.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE ?? 'http://localhost:5173'
const OUT = process.env.OUT ?? join(HERE, '..', '..', 'docs', 'img')
const SONG = process.env.SONG ?? ''
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    // the title waits for the theme, and the theme waits for a gesture it will not get here
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const problems = []
page.on('pageerror', (e) => problems.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log('  shot', `docs/img/${name}.png`)
}

/** Title → map → a run in `mode`, left at the given moment. */
async function run(mode, tier = 1, secs = 6) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.title-play', { timeout: 30000 })
  await page.waitForSelector('.pxroot:not(.intro)', { timeout: 30000 })
  await page.waitForTimeout(1200)
  if (mode === 'words') await shot('title')

  await page.locator('.title-play').click()
  await page.waitForSelector('.song', { timeout: 30000 })
  await page.waitForTimeout(1600)
  if (mode === 'words') await shot('map')

  if (SONG) await page.locator('.song', { hasText: SONG }).first().click()
  else await page.locator('.song').first().click()
  await page.locator('#tiers .chip').nth(tier).click()
  await page.locator('#modes .chip').nth(mode === 'duel' ? 1 : 0).click()
  await page.waitForTimeout(400)
  await page.locator('#play').click()
  await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 40000 })
  // past the count-in, into the part of the song with notes on screen
  await page.waitForTimeout(secs * 1000)
  await shot(mode)
  return page
}

console.log('shooting the README pictures from', BASE)
await run('words')

// play a little, so the results have something on them, then stop the run
await page.evaluate(async () => {
  const s = window.__session
  const deadline = performance.now() + 6000
  while (performance.now() < deadline) {
    const ev = s.rhythm.currentEvent()
    if (ev === null) break
    if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
    const wait = (ev.timestamp - s.clock.now()) * 1000
    if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 50))); continue }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
    await new Promise((r) => setTimeout(r, 2))
  }
})
await page.evaluate(() => window.__session.quit())
await page.waitForSelector('.px-results-panel', { timeout: 30000 })
await page.waitForTimeout(900)
await shot('results')

await page.keyboard.press('Tab')
await page.waitForSelector('.coach', { timeout: 20000 })
await page.waitForTimeout(600)
await shot('coach')

await run('duel', 1, 7)

await page.goto(`${BASE}/#gallery`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)
await shot('gallery')

console.log(problems.length ? `page problems:\n  ${problems.slice(0, 5).join('\n  ')}` : 'no page errors')
await browser.close()
