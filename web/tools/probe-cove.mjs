// the landing on the cove, traced: where the bird is every 300 ms after the drone is in
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1512, height: 887 }, deviceScaleFactor: 2 })
page.on('console', (m) => { if (m.text().startsWith('[dbg')) console.log(m.text()) })
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('.title-play', { timeout: 20000 })
await page.waitForTimeout(1200)
const b = await page.locator('.title-play').boundingBox()
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }); await page.waitForTimeout(800)
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
await page.waitForSelector('.map-root.in', { timeout: 30000 })
for (const k of [1, 2]) {
  await page.waitForTimeout(600)
  await page.keyboard.press('ArrowUp')
  const t0 = Date.now()
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(300)
    const info = await page.evaluate(() => window.__movieInfo())
    console.log(k, ((Date.now() - t0) / 1000).toFixed(1), info.island, info.phase, info.shown, 'goose', info.goose.join(','), 'sel', info.sel)
  }
}
await browser.close()
