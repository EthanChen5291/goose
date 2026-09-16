/**
 * The imported-song round trip: chart a file with tools/chart_file.py, drop the
 * bundle and its audio into the Add a song screen, and play the result.
 *
 * This is the path a browser cannot shortcut — charting needs Python — so it is
 * worth proving end to end rather than assuming the two halves meet.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '/tmp/shots'
const DIR = process.env.IMPORT_DIR
if (!DIR) throw new Error('set IMPORT_DIR to the folder holding the mp3 + .goosechart.json')
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
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
const before = await page.locator('.song').count()

await page.locator('#add').click()
await page.waitForSelector('#imp-audio', { timeout: 5000 })
await page.screenshot({ path: `${SHOTS}/import-1-screen.png` })

// the wrong file first: the screen should say so rather than fail silently
await page.locator('#imp-audio').setInputFiles(`${DIR}/test song.mp3`)
await page.locator('#imp-chart').setInputFiles(`${DIR}/test song.mp3`)
await page.locator('#imp-go').click()
await page.waitForTimeout(400)
console.log('bad chart file ->', JSON.stringify(await page.locator('#imp-err').textContent()))

// now the real pair
await page.locator('#imp-chart').setInputFiles(`${DIR}/test song.goosechart.json`)
await page.locator('#imp-go').click()
await page.waitForSelector('.srow.imported', { timeout: 8000 })
console.log('imported:', (await page.locator('.srow.imported span').textContent()).trim())
await page.screenshot({ path: `${SHOTS}/import-2-added.png` })
await page.locator('#imp-close').click()

// the menu re-renders after reading IndexedDB, so wait for the row itself
await page.waitForSelector('.song .tag', { timeout: 5000 })
const after = await page.locator('.song').count()
console.log(`menu: ${before} songs -> ${after}`)
const first = await page.locator('.song').first().textContent()
console.log('first card:', first.replace(/\s+/g, ' ').trim())

// play it: the audio comes out of IndexedDB as a Blob
await page.locator('.song').first().click()
await page.locator('#tiers .chip').nth(1).click()
await page.locator('#modes .chip').first().click()
console.log('play button:', await page.locator('#play').textContent())
await page.locator('#play').click()
await page.waitForSelector('canvas', { timeout: 30000 })
await page.waitForTimeout(2500)
const state = await page.evaluate(() => {
  const s = window.__session
  return { notes: s.rhythm.totalNotes, t: +s.clock.now().toFixed(2), bpm: Math.round(s.song.bpm) }
})
console.log('playing an imported song:', JSON.stringify(state))
await page.screenshot({ path: `${SHOTS}/import-3-playing.png` })

// and it survives a reload, because IndexedDB is not session storage
await page.reload({ waitUntil: 'networkidle' })
// the app opens on the title screen now, as the desktop build does
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.locator('.title-play').click()
await page.waitForSelector('.song', { timeout: 20000 })
console.log('after reload:', await page.locator('.song').count(), 'songs')

// clean up so a rerun starts empty
await page.locator('#add').click()
await page.waitForSelector('.srow.imported button', { timeout: 5000 })
await page.locator('.srow.imported button').click()
await page.waitForTimeout(400)
console.log('removed:', (await page.locator('.srow.imported').count()) === 0)

if (errors.length) {
  console.log('\nCONSOLE ERRORS:')
  for (const e of errors.slice(0, 8)) console.log(' -', e)
}
await browser.close()
process.exit(errors.length ? 1 : 0)
