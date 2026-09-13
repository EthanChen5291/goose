/**
 * Screenshot each stage mode, so a change to the look can be seen rather than assumed.
 *
 *     node tools/shots-stage.mjs          # needs `vite preview` on :4173
 *
 * Seeks to a phrase of each kind in a real chart, plus a drop, and writes one PNG
 * per mode into $SHOTS.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '/tmp/shots/stage'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(BASE, { waitUntil: 'networkidle' })
// the app opens on the title screen now, as the desktop build does
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.song', { timeout: 20000 })
await page.locator('.song', { hasText: process.env.SONG ?? 'Scorpion' }).first().click()
await page.locator('#tiers .chip').nth(3).click()      // DEMON: the most sections
await page.locator('#modes .chip').nth(0).click()
await page.locator('#play').click()
await page.waitForSelector('canvas', { timeout: 30000 })
await page.waitForTimeout(1500)

// where each phrase kind starts, from the chart itself
// the chart's phrase times are song time; the session plays chart time, which is
// song time plus the count-in, so the lead-in has to be added or every seek lands
// a couple of seconds early and in the wrong phrase.
const marks = await page.evaluate(() => {
  const ph = window.__chart.meta.phrases ?? []
  const lead = window.__session.rhythm.leadIn ?? 0
  const seen = {}
  for (const [t0, t1, kind] of ph) {
    if (!seen[kind] && t1 - t0 > 4) seen[kind] = t0 + lead + 2
  }
  return seen
})
console.log('phrase kinds found:', JSON.stringify(marks))

for (const [kind, t] of Object.entries(marks)) {
  await page.evaluate((tt) => window.__session.seek(tt), t)
  await page.waitForTimeout(1400)          // past the portal sweep, into the mode
  await page.screenshot({ path: `${SHOTS}/${kind}.png` })
  console.log(`${kind} @ ${t.toFixed(1)}s`)
}

// the portal itself.  Waiting for a phrase boundary to come round is a race; the
// sweep is what is being looked at, so it is asked for directly.
await page.evaluate(async () => {
  const r = window.__session.renderer
  // a real change: the stage ignores being told the mode it is already in, so it
  // has to be somewhere else first
  r.bgStage.setKind('eclipse', window.__session.clock.now() - 3)
  await new Promise((res) => setTimeout(res, 60))
  r.bgStage.setKind('pattern', window.__session.clock.now())
})
await page.waitForTimeout(260)
await page.screenshot({ path: `${SHOTS}/portal.png` })
console.log('portal sweep')

// a blackout: fire one directly and catch the bloom coming back
await page.evaluate(() => {
  const r = window.__session.renderer
  const t = window.__session.clock.now()
  r.bgStage.blackout(t + 0.25, 1)
})
await page.waitForTimeout(380)
await page.screenshot({ path: `${SHOTS}/blackout.png` })
console.log('blackout')

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
