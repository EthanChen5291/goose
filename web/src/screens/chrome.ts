/**
 * The furniture every menu sits on: the petal field and the sprite strips.
 *
 * The desktop build draws its menus with pygame, so the port's first pass made
 * them ordinary DOM — a card grid on a flat background. That is a different app
 * to look at. These are the two pieces that make a web page look like Noki:
 *
 * **Petals** — `game/ui_components.py:Petal` drifts a few hundred translucent
 * ellipses down the screen behind every menu, rotating as they fall. Same motion
 * here, on one canvas behind everything, so it costs one element rather than one
 * per petal.
 *
 * **Strips** — `tools/export_web.py` packs each animation folder into a single
 * horizontal PNG, every frame cropped to the animation's union alpha box so the
 * figure never jitters. A strip is shown by stepping `background-position`, which
 * is a compositor job and never touches layout.
 *
 * Everything here is decoration and owns no state the game reads.
 */

/** the palette from `Petal.COLORS` */
const PETAL_COLORS = ['160,160,160', '210,210,210', '80,80,80', '255,20,147', '140,210,255']
const PETAL_COUNT = 90

interface Petal {
  x: number; y: number; vx: number; vy: number
  rot: number; spin: number
  w: number; h: number
  color: string; alpha: number
}

function newPetal(w: number, h: number, anywhere: boolean): Petal {
  const r = (a: number, b: number) => a + Math.random() * (b - a)
  return {
    x: r(0, w),
    y: anywhere ? r(0, h) : r(-60, -10),
    vx: r(-0.35, 0.35), vy: r(0.12, 0.5),
    rot: r(0, Math.PI * 2), spin: r(-0.012, 0.012),
    w: r(5, 16), h: r(10, 26),
    color: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)],
    alpha: r(10, 65) / 255,
  }
}

/**
 * A full-window canvas of drifting petals, already running.
 *
 * The returned element positions itself; drop it in as the first child of a
 * screen. `stop()` cancels the loop — a menu that is replaced must call it or the
 * old field keeps animating off-screen forever.
 */
export function petalField(): { el: HTMLCanvasElement; stop: () => void } {
  const el = document.createElement('canvas')
  el.className = 'petals'
  const ctx = el.getContext('2d')!
  let petals: Petal[] = []
  let raf = 0
  let w = 0
  let h = 0

  const resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    w = el.clientWidth || window.innerWidth
    h = el.clientHeight || window.innerHeight
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!petals.length) petals = Array.from({ length: PETAL_COUNT }, () => newPetal(w, h, true))
  }

  const frame = (): void => {
    ctx.clearRect(0, 0, w, h)
    for (const p of petals) {
      p.x += p.vx
      p.y += p.vy
      p.rot += p.spin
      if (p.y > h + 50) Object.assign(p, newPetal(w, h, false))
      if (p.x < -50) p.x = w + 50
      else if (p.x > w + 50) p.x = -50
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.beginPath()
      ctx.ellipse(0, 0, p.w, p.h, 0, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${p.color},${p.alpha})`
      ctx.fill()
      ctx.restore()
    }
    raf = requestAnimationFrame(frame)
  }

  const onResize = (): void => resize()
  window.addEventListener('resize', onResize)
  // the element has no size until it is in the document, so the first sizing is
  // deferred a frame rather than read as zero
  requestAnimationFrame(() => { resize(); frame() })

  return {
    el,
    stop: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    },
  }
}

export interface SheetInfo { url: string; frames: number; w: number; h: number }

/**
 * One packed animation strip as an element, playing on a loop.
 *
 * `height` is the height to draw at in CSS pixels; the width follows the strip's
 * own aspect so the figure is never stretched.
 */
export function spriteStrip(sheet: SheetInfo, height: number, fps = 30):
    { el: HTMLDivElement; stop: () => void; setFrame: (i: number) => void } {
  const el = document.createElement('div')
  const scale = height / sheet.h
  const fw = sheet.w * scale
  el.className = 'strip'
  el.style.width = `${fw}px`
  el.style.height = `${height}px`
  el.style.backgroundImage = `url(${sheet.url})`
  el.style.backgroundSize = `${fw * sheet.frames}px ${height}px`

  let i = 0
  const setFrame = (n: number): void => {
    i = ((n % sheet.frames) + sheet.frames) % sheet.frames
    el.style.backgroundPosition = `${-i * fw}px 0`
  }
  setFrame(0)
  const timer = window.setInterval(() => setFrame(i + 1), 1000 / fps)
  return { el, stop: () => window.clearInterval(timer), setFrame }
}

/**
 * Scale a fixed design-space box to the window, the way the play canvas does.
 *
 * The menus were laid out in CSS units, so on a large display they sat in the top
 * corner with the rest of the screen empty, and on a small one they scrolled.
 * Laying them out once at 1920×1080 and scaling to fit means the composition is
 * the same everywhere — which is also what the desktop build does, since pygame
 * has no other way to be resolution-independent.
 */
export function fitStage(stage: HTMLElement, designW = 1920, designH = 1080): () => void {
  const apply = (): void => {
    const s = Math.min(window.innerWidth / designW, window.innerHeight / designH)
    stage.style.width = `${designW}px`
    stage.style.height = `${designH}px`
    stage.style.transform = `translate(-50%, -50%) scale(${s})`
  }
  apply()
  window.addEventListener('resize', apply)
  return () => window.removeEventListener('resize', apply)
}
