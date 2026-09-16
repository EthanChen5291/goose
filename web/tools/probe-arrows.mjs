/**
 * The stage-change telegraph and the arrow stage, on the hustle master chart.
 *     node tools/probe-arrows.mjs        # needs `vite preview` on :4173
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
const TIER = Number(process.env.TIER ?? 1)
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
await pickSong(page, 'hustle')
await page.locator('#tiers .chip').nth(TIER).click()
await page.locator('#modes .chip').nth(0).click()
await page.locator('#play').click()
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 60000 })
await page.waitForTimeout(600)

const ARROW = { d: 'ArrowLeft', f: 'ArrowDown', j: 'ArrowUp', k: 'ArrowRight' }
/** play along for `seconds`; in arrow mode press the arrow keys instead of the letters */
async function playAlong(seconds, arrows) {
  return page.evaluate(async ({ seconds, arrows, ARROW }) => {
    const s = window.__session
    const deadline = performance.now() + seconds * 1000
    let pressed = 0, arrowed = 0
    while (performance.now() < deadline) {
      const ev = s.rhythm.currentEvent()
      if (ev === null) break
      if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
      const wait = (ev.timestamp - s.clock.now()) * 1000
      if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 30))); continue }
      let key = ev.char
      if (arrows && s.renderer.field.modeAt(ev.timestamp) === 'onecircle' && ARROW[ev.char]) { key = ARROW[ev.char]; arrowed += 1 }
      pressed += 1
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      if (ev.hold_duration > 0) {
        const until = ev.timestamp + ev.hold_duration
        setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), Math.max(0, (until - s.clock.now()) * 1000))
      } else window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
      await new Promise((r) => setTimeout(r, 2))
    }
    return { pressed, arrowed, acc: s.rhythm.getAccuracy().toFixed(1), combo: s.rhythm.combo }
  }, { seconds, arrows, ARROW })
}

const stages = await page.evaluate(() => {
  const s = window.__session
  return { leadIn: s.rhythm.leadIn, stages: window.__chart.meta.stages }
})
console.log('stages', JSON.stringify(stages))
const li = stages.leadIn
// the countdown into columns
await page.evaluate((t) => window.__session.seek(t), stages.stages[0][0] + li - 1.4)
await page.waitForTimeout(700)
await page.screenshot({ path: `${SHOTS}/arrows-0-countdown-columns.png` })
console.log('columns', JSON.stringify(await playAlong(2.5, true)))
await page.screenshot({ path: `${SHOTS}/arrows-1-columns.png` })
// the countdown into the arrow stage, then the stage itself on the arrow keys
await page.evaluate((t) => window.__session.seek(t), stages.stages[1][0] + li - 1.6)
await page.waitForTimeout(900)
await page.screenshot({ path: `${SHOTS}/arrows-2-countdown-arrows.png` })
console.log('into arrows', JSON.stringify(await playAlong(3, true)))
await page.screenshot({ path: `${SHOTS}/arrows-3-arrows.png` })
console.log('arrows', JSON.stringify(await playAlong(3, true)))
await page.screenshot({ path: `${SHOTS}/arrows-4-arrows.png` })
console.log('errors:', errors.length ? errors.slice(0, 6) : 'none')
await browser.close()
