/**
 * What a hold note looks like while it is being held.
 *
 *     node tools/probe-hold.mjs        # needs `vite preview` on :4173
 *
 * Plays up to the first plain hold and the first anchor hold, presses each on
 * time, keeps the key down, and shoots the screen a moment later. Reports what
 * the renderer thinks is on screen at that instant, so "it disappeared" can be
 * checked rather than guessed at.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '/tmp/shots/hold'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.song', { timeout: 20000 })
await page.locator('.song', { hasText: process.env.SONG ?? 'Scorpion' }).first().click()
await page.locator('#tiers .chip').nth(3).click()
await page.locator('#modes .chip').nth(0).click()
await page.locator('#play').click()
await page.waitForSelector('canvas', { timeout: 30000 })
await page.waitForTimeout(1200)

/** Play up to the chosen hold, press it, and hold the key down. */
async function ride(kind) {
  return page.evaluate(async (want) => {
    const s = window.__session
    const evs = s.rhythm.beatMap.filter((e) => !e.is_rest && e.char)
    const target = evs.find((e) => e.hold_duration > 0.3
      && (want === 'anchor' ? e.section_kind === 'anchor' : e.section_kind !== 'anchor'))
    if (!target) return { found: false }
    s.seek(target.timestamp - 2.0)
    await new Promise((r) => setTimeout(r, 300))

    const deadline = performance.now() + 12000
    while (performance.now() < deadline) {
      const ev = s.rhythm.currentEvent()
      if (ev === null) break
      if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
      const wait = (ev.timestamp - s.clock.now()) * 1000
      if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 40))); continue }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ev.char, bubbles: true }))
      const isTarget = ev._uid === target._uid
      if (!isTarget) window.dispatchEvent(new KeyboardEvent('keyup', { key: ev.char, bubbles: true }))
      else break                       // the target's key stays down
      await new Promise((r) => setTimeout(r, 2))
    }
    // a moment into the hold: what does the renderer still have?
    await new Promise((r) => setTimeout(r, 200))
    const r = s.renderer
    return {
      found: true,
      char: target.char,
      seconds: +target.hold_duration.toFixed(2),
      kind: target.section_kind || 'plain',
      hit: target.hit,
      isActiveHold: r.rhythm.activeHold?._uid === target._uid,
      anchorsHeld: r.rhythm.anchors.length,
      // the orb layer only holds nodes the renderer chose to draw this frame
      orbsOnScreen: r.noteLayerCount ?? null,
      timeLeft: +(target.timestamp + target.hold_duration - s.clock.now()).toFixed(2),
    }
  }, kind)
}

for (const kind of ['plain', 'anchor']) {
  const out = await ride(kind)
  console.log(kind + ':', JSON.stringify(out))
  await page.screenshot({ path: `${SHOTS}/${kind}.png` })
  // let go before the next probe
  await page.evaluate(() => {
    for (const k of 'abcdefghijklmnopqrstuvwxyz') {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }))
    }
  })
  await page.waitForTimeout(200)
}

console.log('errors:', errors.length ? errors.slice(0, 4) : 'none')
await browser.close()
