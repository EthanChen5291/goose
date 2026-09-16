// when does the frame copy start failing?  loads the title, optionally hovers, and reports the first GL warning with the movie's state
import { chromium } from 'playwright'
const HOVER = process.env.HOVER === '1'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
const t0 = Date.now()
let n = 0
page.on('console', async (m) => {
  if (m.type() !== 'warning' && m.type() !== 'error') return
  n += 1
  if (n === 1) {
    const info = await page.evaluate(() => (window.__movieInfo ? window.__movieInfo() : null)).catch(() => null)
    const cv = await page.evaluate(() => { const c = document.querySelector('canvas.px-movie'); return c ? [c.width, c.height, c.isConnected] : null }).catch(() => null)
    console.log('first warning at', ((Date.now() - t0) / 1000).toFixed(2), 's', m.text().slice(0, 90), JSON.stringify(info), JSON.stringify(cv))
  }
})
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
console.log('title at', ((Date.now() - t0) / 1000).toFixed(2))
if (HOVER) { const b = await page.locator('.title-play').boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }) }
await page.waitForTimeout(6000)
console.log('warnings:', n)
await browser.close()
