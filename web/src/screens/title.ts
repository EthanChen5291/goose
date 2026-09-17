/**
 * The title screen: the meadow from above, the menu standing over it.
 *
 * Behind is `goose3d.ts` in its menu scene — the camera nearly overhead, the
 * buttons as flat plates over the grass in the blueprint's stagger, a small
 * 3D goose walking on them.  The plates are drawn by the movie; what the DOM
 * adds is a label over each one (lower left, the way the reference letters
 * its tiles), positioned every frame from where the movie says the plate is,
 * so the labels are the buttons.  The pointer is handed to the movie in game
 * pixels every time it moves: the goose walks to wherever it is on a plate,
 * hops between plates after it, or stands at the nearest edge and watches it.
 * Press a plate and the movie plays the exit (the phone straight in the
 * bird's face, then the plate rockets away — or tips it into a hole) before
 * the shell moves on.  Top-left, where a blueprint's title sits: the wordmark.
 */
import { pixelStage } from './pxchrome'
import type { GooseMovie, ExitKind } from './goose3d'

export interface TitleOptions {
  onPlay: () => void
  onImport: () => void
  onSettings: () => void
  /** the cursor moved: the shell plays the tick */
  onMove?: () => void
  /** the shared movie: the shell owns it, screens borrow its canvas */
  movie: Promise<GooseMovie>
  /** the plate the goose starts on: the one it last left */
  at?: number
  /** the theme's clock: the title waits on it, and the hint blinks on its beat */
  music?: { since: () => number | null; beat: number }
  /** the session's first title: it waits for the theme's first beat */
  intro?: boolean
}

export interface TitleItem { label: string; cls: string; kind: ExitKind; go: () => void }

export function buildTitle(opts: TitleOptions): { el: HTMLElement; stop: () => void; resume: () => void } {
  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('title-root')
  const stops: (() => void)[] = [px.stop]

  const brand = document.createElement('div')
  brand.className = 'px-brand'
  const wordmark = document.createElement('div')
  wordmark.className = 'px-wordmark'
  wordmark.textContent = 'goose'
  const sub = document.createElement('div')
  sub.className = 'px-sub'
  sub.textContent = 'a rhythm typing game'
  brand.append(wordmark, sub)

  const items: TitleItem[] = [
    { label: 'PLAY', cls: 'title-play', kind: 'right', go: opts.onPlay },
    { label: 'SONGS', cls: 'title-songs', kind: 'left', go: opts.onImport },
    { label: 'SETTINGS', cls: 'title-settings', kind: 'trap', go: opts.onSettings },
  ]
  const layer = document.createElement('div')
  layer.className = 'plate-layer'
  layer.setAttribute('role', 'menu')
  const flash = document.createElement('div')
  flash.className = 'px-flash'
  const buttons: HTMLButtonElement[] = []
  let cur = Math.max(0, Math.min(items.length - 1, opts.at ?? 0))
  let pressing = false
  let movie: GooseMovie | null = null

  const paint = (): void => buttons.forEach((b, k) => { b.classList.toggle('on', k === cur); b.setAttribute('aria-selected', String(k === cur)) })
  /** the keyboard: the goose walks to plate `i` and stands by its label */
  const hover = (i: number): void => {
    if (pressing) return
    const n = ((i % items.length) + items.length) % items.length
    if (n === cur) return
    cur = n
    opts.onMove?.()
    movie?.menuHover(cur)
    paint()
  }
  /** the pointer, in game pixels: the movie decides which plate the goose heads for */
  const point = (gx: number, gy: number): void => {
    if (pressing || !movie) return
    const n = movie.menuPointer(gx, gy)
    if (n === cur) return
    cur = n
    opts.onMove?.()
    paint()
  }
  const press = async (i: number): Promise<void> => {
    if (pressing) return
    pressing = true
    cur = i
    paint()
    // SETTINGS is not a journey: no phone, no trapdoor — the panel just comes up
    // over the meadow, and `resume` hands the menu back when it closes
    if (items[i].kind === 'trap') { items[i].go(); return }
    layer.classList.add('pressing')
    const mv = await opts.movie
    if (!alive) return
    await mv.menuPress(i, items[i].kind)
    if (!alive) return
    items[i].go()
  }
  items.forEach((it, i) => {
    const b = document.createElement('button')
    b.className = `plate-btn ${it.cls}`.trim()
    if (it.kind === 'trap') b.id = 'settings'
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="plbl">${it.label}</span>`
    b.onclick = () => { void press(i) }
    buttons.push(b)
    layer.appendChild(b)
  })
  paint()

  const corner = document.createElement('div')
  corner.className = 'px-corner'
  corner.innerHTML = '<span class="px-hint">← → choose · enter</span><span class="px-ver">web build</span>'

  /**
   * The cold open: black until the theme is playing, and then the meadow, the
   * plates and the brand all arriving at once behind the flash.
   *
   * The theme opens on its drop, so there is nothing to wait through — but a
   * page nobody has touched yet is not allowed to make a sound, so what the
   * black is really waiting for is the first key or click.  Either way the
   * title lands on the theme's first beat, because that is when it is told.
   */
  let curtain: HTMLElement | null = null
  let lifted = !opts.intro
  if (opts.intro) {
    px.root.classList.add('intro')
    curtain = document.createElement('div')
    curtain.className = 'px-curtain'
    const press = document.createElement('div')
    press.className = 'px-press'
    press.textContent = 'press any key'
    curtain.append(press)
  }
  const lift = (): void => {
    if (lifted) return
    lifted = true
    px.root.classList.remove('intro')
    const c = curtain
    curtain = null
    c?.classList.add('gone')
    flash.classList.add('on')
    window.setTimeout(() => flash.classList.remove('on'), 90)
    window.setTimeout(() => c?.remove(), 400)
  }
  const onKey = (e: KeyboardEvent): void => {
    // the press that buys the page its sound is not also a menu press
    if (!lifted) { e.preventDefault(); return }
    if (pressing) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); hover(cur + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'Tab') { e.preventDefault(); hover(cur - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void press(cur) }
  }
  window.addEventListener('keydown', onKey)
  stops.push(() => window.removeEventListener('keydown', onKey))
  // the pointer anywhere over the stage, in game pixels (the stage is scaled by an integer)
  const onMove = (e: MouseEvent): void => {
    const r = stage.getBoundingClientRect()
    if (r.width <= 0) return
    point(((e.clientX - r.left) / r.width) * px.w, ((e.clientY - r.top) / r.height) * px.h)
  }
  window.addEventListener('mousemove', onMove)
  stops.push(() => window.removeEventListener('mousemove', onMove))

  stage.append(layer, brand, corner, flash)
  if (curtain) stage.appendChild(curtain)

  // the movie, once it is built: into its menu scene, the goose on the last plate
  let alive = true
  let prevCue: ((n: string) => void) | null = null
  void opts.movie.then((mv) => {
    if (!alive) return
    movie = mv
    // from out over the islands the meadow is a journey away: the furniture waits for it, and so do the keys
    pressing = true
    px.root.classList.add('arriving')
    void mv.menu(items.length, cur).then(() => {
      if (!alive) return
      pressing = false
      px.root.classList.remove('arriving')
    })
    stage.prepend(mv.el)
    mv.resize(px.w, px.h)
    // the phone's flash: a white frame, on the movie's cue
    prevCue = mv.onCue
    mv.onCue = (n) => {
      prevCue?.(n)
      if (n === 'flash') { flash.classList.add('on'); window.setTimeout(() => flash.classList.remove('on'), 70) }
    }
    stops.push(() => { if (mv.onCue !== prevCue) mv.onCue = prevCue })
  })

  // the labels ride their plates; the hint pulses on the beat
  const t0 = performance.now()
  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const beat = opts.music?.beat ?? 0.5
    const since = opts.music?.since() ?? null
    // the hint blinks on the theme's beat, and on its own before there is one
    const b = since === null ? ((performance.now() - t0) / 1000 / beat) % 1 : (since / beat) % 1
    corner.classList.toggle('lit', b < 0.5)
    if (!lifted) {
      if (since === null) {
        // nothing is playing yet: after a moment, the curtain asks to be touched.
        // If sound never comes at all — a page left alone, a theme that will not
        // load — the title is still not worth holding hostage to it.
        const waited = performance.now() - t0
        curtain?.classList.toggle('waiting', waited > 700)
        if (waited > 10000) lift()
      } else {
        lift()
      }
    }
    if (!movie) return
    buttons.forEach((btn, i) => {
      const [x, y, bw, bh] = movie!.menuBox(i)
      btn.style.left = `${x}px`
      btn.style.top = `${y}px`
      btn.style.width = `${bw}px`
      btn.style.height = `${bh}px`
    })
  }
  raf = requestAnimationFrame(tick)
  stops.push(() => cancelAnimationFrame(raf))

  px.onResize((w, h) => {
    movie?.resize(w, h)
    layer.style.left = '0'; layer.style.top = '0'; layer.style.width = `${w}px`; layer.style.height = `${h}px`
    flash.style.left = '0'; flash.style.top = '0'; flash.style.width = `${w}px`; flash.style.height = `${h}px`
    brand.style.left = `${Math.max(10, Math.round(w * 0.04))}px`
    brand.style.top = `${Math.max(8, Math.round(h * 0.05))}px`
    corner.style.left = '0'
    corner.style.width = `${w - 8}px`
    corner.style.top = `${h - 14}px`
  })

  return {
    el: px.root,
    stop: () => { alive = false; for (const s of stops) s() },
    resume: () => { pressing = false; layer.classList.remove('pressing') },
  }
}
