/**
 * Browser smoke test: load the app, play a chart, type notes, read the score.
 *
 * The unit and parity tests prove the judgment core; this proves the other half —
 * that the page boots, WebGL initialises, the chart and audio load, the renderer
 * draws, and a keypress reaches the judgment core and moves the score. It plays
 * with real synthesised keystrokes against a real chart, then screenshots.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '/tmp/shots'
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle' })
// the app opens on the title screen now, as the desktop build does
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.song', { timeout: 20000 })
console.log('menu:', await page.locator('.song').count(), 'songs')

// pick a song and a tier, then play
const SONG = process.env.SONG ?? ''
if (SONG) await page.locator('.song', { hasText: SONG }).first().click()
else await page.locator('.song').first().click()
await page.locator('#tiers .chip').nth(1).click()   // FAIR
const MODE = process.env.MODE ?? 'words'
await page.locator('#modes .chip').nth(MODE === 'letters' ? 1 : 0).click()
const playLabel = await page.locator('#play').textContent()
console.log('play button:', playLabel)
await page.screenshot({ path: `${SHOTS}/${MODE}-1-menu.png` })

await page.locator('#play').click()
await page.waitForSelector('canvas', { timeout: 30000 })
console.log('canvas up')

// the session only goes on the window once the chart, the audio and the pixel
// kit are all in, which is well past the click; wait for it rather than guess,
// then let the count-in run and screenshot the falling notes
await page.waitForFunction(() => Boolean(window.__session), null, { timeout: 30000 })
await page.waitForTimeout(1800)
await page.screenshot({ path: `${SHOTS}/${MODE}-2-countin.png` })

// read chart state out of the page and type the notes that are due
const typed = await page.evaluate(async () => {
  const s = window.__session
  if (!s) return { error: 'no session on window' }
  const hits = []
  const deadline = performance.now() + 9000
  while (performance.now() < deadline) {
    const ev = s.rhythm.currentEvent()
    if (ev === null) break
    if (ev.is_rest || !ev.char) { await new Promise((r) => setTimeout(r, 4)); continue }
    const wait = (ev.timestamp - s.clock.now()) * 1000
    if (wait > 6) { await new Promise((r) => setTimeout(r, Math.min(wait - 3, 50))); continue }
    const key = ev.char
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    hits.push(key)
    await new Promise((r) => setTimeout(r, 2))
  }
  return {
    typed: hits.length,
    score: s.rhythm.getScore(),
    accuracy: s.rhythm.getAccuracy(),
    combo: s.rhythm.maxCombo,
    perfect: s.rhythm.perfectHits,
    good: s.rhythm.goodHits,
    ok: s.rhythm.okHits,
    miss: s.rhythm.missCount,
  }
})
console.log('play:', JSON.stringify(typed))
await page.screenshot({ path: `${SHOTS}/${MODE}-3-playing.png` })

// frame timing over a second of real play
const fps = await page.evaluate(() => new Promise((resolve) => {
  const frames = []
  let last = performance.now()
  let n = 0
  const tick = (now) => {
    frames.push(now - last)
    last = now
    if (++n < 300) requestAnimationFrame(tick)
    else {
      const late = frames.filter((f) => f > 20).length
      frames.sort((a, b) => a - b)
      resolve({
        median: +frames[Math.floor(frames.length / 2)].toFixed(2),
        p95: +frames[Math.floor(frames.length * 0.95)].toFixed(2),
        p99: +frames[Math.floor(frames.length * 0.99)].toFixed(2),
        max: +frames[frames.length - 1].toFixed(2),
        over20ms: `${late}/${frames.length}`,
      })
    }
  }
  requestAnimationFrame(tick)
}))
console.log('frame ms:', JSON.stringify(fps))

// a duet section, if this chart has one: seek to just before it and shoot
const duet = await page.evaluate(async () => {
  const s = window.__session
  const spans = window.__chart?.meta?.duets ?? []
  if (!spans.length) return null
  const t0 = spans[0][0] + s.leadIn
  s.seek(t0 - 1.0)
  await new Promise((r) => setTimeout(r, 1400))
  return { start: +t0.toFixed(1), shape: spans[0][2], now: +s.clock.now().toFixed(1) }
})
if (duet) {
  console.log('duet:', JSON.stringify(duet))
  await page.screenshot({ path: `${SHOTS}/${MODE}-8-duet.png` })
} else {
  console.log('duet: this chart has none')
}

// the combo milestone: it only fires at 25+, which the tape never reaches, so it
// is triggered directly and shot mid-pop.  Letters mode has no milestone, in this
// build or the pygame one, so there is nothing to trigger there.
const milestone = await page.evaluate(async () => {
  const s = window.__session
  const r = s.renderer
  if (!Array.isArray(r.shockwaves)) return 'n/a'
  r.milestone = [50, s.clock.now()]
  r.shockwaves.push({ t0: s.clock.now(), x: 1280, y: 540, col: 0xffde7b,
                      dur: 0.5, r0: 80, r1: 340, w0: 5, a0: 0.5 })
  await new Promise((rr) => setTimeout(rr, 120))
  return Array.isArray(r.milestone) ? r.milestone[0] : null
})
console.log('milestone drawn:', milestone)
if (milestone !== 'n/a') await page.screenshot({ path: `${SHOTS}/${MODE}-9-milestone.png` })

// Letters mode can end the run on its own: slips cost HP, and the synthesised
// typing slips a lot.  A finished session ignores Escape, which is right, so ask
// before pausing rather than waiting for an overlay that will never come.
const live = await page.evaluate(() => {
  const s = window.__session
  return { finished: s.finished, failed: Boolean(s.renderer.failed),
           hp: typeof s.renderer.hp === 'number' ? Math.round(s.renderer.hp) : null }
})
console.log('run state:', JSON.stringify(live))

if (!live.finished) {
  // pause, resume, and leave through the overlay.  The pause menu is the Emi
  // kit's own button bars, found by their labels — they carry no ids.
  const pauseBtn = (label) => page.locator('.pause .pbtn', { hasText: label })
  await page.keyboard.press('Escape')
  await pauseBtn('RESUME').waitFor({ timeout: 5000 })
  console.log('pause overlay: shown')
  await page.screenshot({ path: `${SHOTS}/${MODE}-4-pause.png` })
  await pauseBtn('RESUME').click()
  await page.waitForTimeout(300)
  console.log('resumed:', (await page.locator('.pause').count()) === 0)
  await page.keyboard.press('Escape')
  await pauseBtn('QUIT').waitFor({ timeout: 5000 })
  await pauseBtn('QUIT').click()
} else {
  console.log('run already over' + (live.failed ? ' (failed: HP hit zero)' : ''))
}
await page.waitForSelector('#back', { timeout: 15000 })
await page.waitForSelector('.px-score', { timeout: 15000 })
const finalScore = await page.locator('.px-score').textContent()
console.log('results:', finalScore, '|', await page.locator('.px-best').textContent())
await page.screenshot({ path: `${SHOTS}/${MODE}-5-results.png` })

// the typing coach, opened with Tab
await page.keyboard.press('Tab')
await page.waitForSelector('.coach', { timeout: 5000 })
await page.waitForTimeout(1200)   // the keyboard pops in key by key
const keyTiles = await page.locator('.coach .key').count()
const sentences = await page.locator('.coach .bubble p').allTextContents()
console.log('coach:', keyTiles, 'key tiles,', sentences.length, 'sentences')
for (const s of sentences) console.log('   "' + s + '"')
const tryIt = await page.locator('.coach .tryit p').count()
  ? await page.locator('.coach .tryit p').textContent() : '(none)'
console.log('   try:', tryIt)
await page.screenshot({ path: `${SHOTS}/${MODE}-6-coach.png` })
await page.locator('#coach-back').click()
await page.locator('#back').click()
await page.waitForSelector('.song', { timeout: 5000 })
console.log('back at the menu')

// the best score is remembered on the card
const card = await page.locator('.song').first().textContent()
console.log('song card:', card.replace(/\s+/g, ' ').trim())

// settings: change one and check it sticks across a reload.  It lives on the
// title screen, where the desktop build keeps it, so the arrow comes first.
await page.locator('.map-back').click()
await page.waitForSelector('#settings', { timeout: 5000 })
await page.locator('#settings').click()
await page.waitForSelector('#set-speed_mult', { timeout: 5000 })
await page.locator('#set-speed_mult').fill('2')
await page.locator('#set-stage_view').click()
console.log('settings: speed', await page.locator('#set-speed_mult').inputValue(),
            '| stage view', await page.locator('#set-stage_view').textContent())
await page.screenshot({ path: `${SHOTS}/${MODE}-7-settings.png` })
await page.locator('.settings-card .play').click()
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('#settings', { timeout: 10000 })
await page.locator('#settings').click()
await page.waitForSelector('#set-speed_mult', { timeout: 5000 })
const persisted = await page.locator('#set-speed_mult').inputValue()
console.log('after reload: speed', persisted, persisted === '2' ? '(persisted)' : '(LOST)')

if (errors.length) {
  console.log('\nCONSOLE ERRORS:')
  for (const e of errors.slice(0, 10)) console.log(' -', e)
}
await browser.close()
process.exit(errors.length || typed.error ? 1 : 0)
