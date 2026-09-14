/**
 * The title screen: the movie behind, the menu in front.
 *
 * Behind is `goose3d.ts` — a small 3D meadow with the goose in it, rendered at
 * game-pixel size and shown at a whole-number scale, the camera cutting between
 * slow shots.  In front, at the bottom-left where a modern menu sits: the
 * wordmark, a line under it, and a short list you move through with the arrow
 * keys or the mouse, a cursor beside the chosen row.  Nothing here fades or
 * slides; rows snap, the cursor blinks, the hint at the corner pulses on the
 * beat.
 */
import { pixelStage } from './pxchrome'
import type { GooseMovie } from './goose3d'

export interface TitleOptions {
  onPlay: () => void
  onSettings: () => void
  /** the cursor moved: the shell plays the tick */
  onMove?: () => void
  /** the shared movie: the shell owns it, screens borrow its canvas */
  movie: Promise<GooseMovie>
}

export function buildTitle(opts: TitleOptions): { el: HTMLElement; stop: () => void } {
  const px = pixelStage()
  const { stage } = px
  const stops: (() => void)[] = [px.stop]

  const fade = document.createElement('div')
  fade.className = 'px-fade'

  const brand = document.createElement('div')
  brand.className = 'px-brand'
  const wordmark = document.createElement('div')
  wordmark.className = 'px-wordmark'
  wordmark.textContent = 'goose'
  const sub = document.createElement('div')
  sub.className = 'px-sub'
  sub.textContent = 'a rhythm typing game'
  brand.append(wordmark, sub)

  const menu = document.createElement('div')
  menu.className = 'px-menu'
  menu.setAttribute('role', 'menu')
  const items: { label: string; cls: string; id?: string; go: () => void }[] = [
    { label: 'PLAY', cls: 'title-play', go: opts.onPlay },
    { label: 'SETTINGS', cls: '', id: 'settings', go: opts.onSettings },
  ]
  const rows: HTMLButtonElement[] = []
  let cur = 0
  const select = (i: number, tick = true): void => {
    const n = ((i % rows.length) + rows.length) % rows.length
    if (n !== cur && tick) opts.onMove?.()
    cur = n
    rows.forEach((r, k) => { r.classList.toggle('on', k === cur); r.setAttribute('aria-selected', String(k === cur)) })
  }
  items.forEach((it, i) => {
    const b = document.createElement('button')
    b.className = `mbtn ${it.cls}`.trim()
    if (it.id) b.id = it.id
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="mcur"></span><span class="mlbl">${it.label}</span>`
    b.onmouseenter = () => select(i)
    b.onclick = it.go
    rows.push(b)
    menu.appendChild(b)
  })
  select(0, false)

  const corner = document.createElement('div')
  corner.className = 'px-corner'
  corner.innerHTML = '<span class="px-hint">↑↓ choose · enter play</span><span class="px-ver">web build</span>'

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); select(cur + 1) }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'Tab') { e.preventDefault(); select(cur - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); items[cur].go() }
  }
  window.addEventListener('keydown', onKey)
  stops.push(() => window.removeEventListener('keydown', onKey))

  stage.append(fade, brand, menu, corner)

  // the movie, once it is built
  let movie: GooseMovie | null = null
  let alive = true
  void opts.movie.then((mv) => {
    if (!alive) return
    movie = mv
    mv.wander()
    stage.prepend(mv.el)
    mv.resize(px.w, px.h)
  })

  // the hint pulses on the beat, the way the goose idles
  const t0 = performance.now()
  let raf = 0
  const tick = (): void => {
    const b = ((performance.now() - t0) / 500) % 1
    corner.classList.toggle('lit', b < 0.5)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  stops.push(() => cancelAnimationFrame(raf))

  px.onResize((w, h) => {
    movie?.resize(w, h)
    fade.style.left = '0'; fade.style.top = '0'; fade.style.width = `${w}px`; fade.style.height = `${h}px`
    const left = Math.max(16, Math.round(w * 0.07))
    brand.style.left = `${left}px`
    brand.style.top = `${h - 118}px`
    menu.style.left = `${left}px`
    menu.style.top = `${h - 62}px`
    corner.style.left = '0'
    corner.style.width = `${w - 8}px`
    corner.style.top = `${h - 14}px`
  })

  return {
    el: px.root,
    stop: () => { alive = false; for (const s of stops) s() },
  }
}
