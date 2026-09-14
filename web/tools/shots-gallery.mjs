/**
 * Every move in the gallery, frame by frame.
 *
 *     node tools/shots-gallery.mjs                 # needs `vite preview` on :4173
 *     MOVES=bodyslam,volley node tools/shots-gallery.mjs
 *
 * Opens `/gallery`, shoots the looping contact sheet at a few moments, then
 * plays each move on the gallery's own clock, seeks to a handful of moments
 * (through the wind-up, the contact, the recovery) and screenshots the fight
 * each time; `index.json` lists what was shot.  Pair it with
 * tools/gallery_sheet.py for one contact sheet per move.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const SHOTS = process.env.SHOTS ?? '.scratch/gallery'
const ONLY = process.env.MOVES ? process.env.MOVES.split(',') : null
const FX = process.env.FX !== '0'
const W = 1200, H = 700, PANEL = 250
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const l = m.location(); errors.push(`[${m.type()}] ${m.text().slice(0, 200)} @ ${l.url?.split('/').pop()}:${l.lineNumber}`) } })
await page.goto(`${BASE}/gallery`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => Boolean(window.__gallery), null, { timeout: 30000 })

// the contact sheet first: every animation looping at once, caught three times over
const grid = await page.evaluate(() => { window.__gallery.set({ mode: 'all' }); return window.__gallery.state() })
console.log(`grid: ${grid.cells} cells, ${grid.cols} columns, buffer ${grid.w}x${grid.h} at ${grid.scale}x`)
for (const secs of [0.4, 0.9, 1.6]) {
  await page.evaluate((s) => window.__gallery.run(s), secs)
  await page.screenshot({ path: `${SHOTS}/all-${secs}s.png` })
}

await page.evaluate((fx) => window.__gallery.set({ mode: 'one', zoom: 2, paused: true, fx, loop: false }), FX)
await page.waitForTimeout(300)

const moves = ONLY ?? await page.evaluate(() => window.__gallery.moves)
const index = []
// the fight stands in the middle of what the panel leaves free
const cx = PANEL + (W - PANEL) / 2
const clip = { x: Math.round(cx - 330), y: 90, width: 660, height: 470 }
for (const m of moves) {
  const st = await page.evaluate((m) => { window.__gallery.play(m); return window.__gallery.state() }, m)
  const c = st.windup > 0 ? st.windup + 0.02 : 0
  const times = st.windup > 0
    ? [c * 0.3, c * 0.6, c * 0.85, c - 0.02, c + 0.01, c + 0.06, c + 0.14, c + 0.26, c + 0.45, c + 0.7]
    : [0.005, 0.05, 0.1, 0.16, 0.24, 0.36]
  const shots = []
  for (const rel of times) {
    await page.evaluate((rel) => window.__gallery.seek(rel), rel)
    const s = await page.evaluate(() => window.__gallery.state())
    const file = `${m.replace(':', '_')}-${rel.toFixed(2)}.png`
    await page.screenshot({ path: `${SHOTS}/${file}`, clip })
    shots.push({ file, rel: Number(rel.toFixed(3)), key: s.key })
  }
  index.push({ move: m, contact: c, shots })
  console.log(m, shots.map((s) => `${s.rel}:${s.key}`).join(' '))
}
writeFileSync(`${SHOTS}/index.json`, JSON.stringify(index, null, 1))
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
