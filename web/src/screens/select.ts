/**
 * Level select — a world map, the way Geometry Dash World does it.
 *
 * You look down on the meadow from above.  A winding dirt path runs across
 * it and the levels stand along it as numbered stones; the ones you have
 * cleared fly a flag.  The goose stands on the level you have picked and hops
 * to the next when you move.  A world is a page of six; the arrows at the
 * sides and the dots at the bottom turn the page, and each world has its own
 * light.  No names out here — pick a stone and its card comes up: the song,
 * the difficulty, the mode, your best, and Play.
 *
 * Everything moves smoothly and quietly: the camera flies up into place,
 * the chrome fades in, the card scales in.  Leaving for a level the chrome
 * fades as the camera slams down onto the goose (`flyOut`).
 */
import { pixelStage, loadManifest } from './pxchrome'
import type { PxStage } from './pxchrome'
import type { Manifest } from '../px/assets'
import { levelFor } from '../px/levels'
import type { GooseMovie } from './goose3d'

export interface SelectSong {
  id: string
  title: string
  bpm: number
  duration: number
  custom?: unknown
  charts: Record<string, { notes: number }>
}

export interface Best { grade: string; accuracy: number; score: number }

export interface SelectOptions {
  songs: SelectSong[]
  selectedId: string | null
  tier: string
  mode: string
  tiers: { key: string; label: string }[]
  modes: { key: string; label: string }[]
  bestOf: (song: SelectSong, tier: string, mode: string) => Best | null
  onSelect: (song: SelectSong) => void
  onTier: (t: string) => void
  onMode: (m: string) => void
  onPlay: (song: SelectSong) => void
  onUpload: () => void
  onBack: () => void
  sfx: (name: string) => void
  movie: Promise<GooseMovie>
}

export interface SelectScreen {
  el: HTMLElement
  stop: () => void
  flyOut: () => Promise<void>
  stage: PxStage
}

const PER_WORLD = 6
const WORLD_NAMES = ['GOOSE MEADOW', 'DUSK HILLS', 'NIGHT RUINS', 'STORM FLATS', 'DAWN STEPS', 'FAR MEADOW', 'HIGH PASS', 'LAST LIGHT']
const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export function buildSelect(opts: SelectOptions): SelectScreen {
  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('map-root')
  const stops: (() => void)[] = [px.stop]
  const songs = opts.songs
  let tier = opts.tier
  let mode = opts.mode
  let selIdx = Math.max(0, songs.findIndex((s) => s.id === opts.selectedId))
  let page = Math.floor(selIdx / PER_WORLD)
  const pages = Math.max(1, Math.ceil(songs.length / PER_WORLD))
  const pageSongs = (): SelectSong[] => songs.slice(page * PER_WORLD, page * PER_WORLD + PER_WORLD)
  const cleared = (s: SelectSong): boolean => {
    for (const t of opts.tiers) for (const m of opts.modes) { const b = opts.bestOf(s, t.key, m.key); if (b && b.accuracy >= 70) return true }
    return false
  }

  // ── chrome ─────────────────────────────────────────────────────────────
  const dim = document.createElement('div'); dim.className = 'map-dim'
  const back = document.createElement('button'); back.className = 'map-back'; back.textContent = '‹'; back.setAttribute('aria-label', 'Back')
  back.onclick = () => { opts.sfx('ui_click'); opts.onBack() }
  const world = document.createElement('div'); world.className = 'map-world'
  const left = document.createElement('button'); left.className = 'map-arrow map-arrow-l'; left.textContent = '◂'; left.setAttribute('aria-label', 'Previous world')
  const right = document.createElement('button'); right.className = 'map-arrow map-arrow-r'; right.textContent = '▸'; right.setAttribute('aria-label', 'Next world')
  const dots = document.createElement('div'); dots.className = 'map-dots'
  const nodesEl = document.createElement('div'); nodesEl.className = 'map-nodes'
  const hint = document.createElement('div'); hint.className = 'map-hint'; hint.textContent = '← → level · ↑ ↓ world · enter'
  const add = document.createElement('button'); add.className = 'map-add'; add.textContent = '+'; add.title = 'add a song'
  add.onclick = () => { opts.sfx('ui_click'); opts.onUpload() }

  // ── the card ────────────────────────────────────────────────────────────
  const card = document.createElement('div'); card.className = 'map-card'; card.hidden = true
  const cTitle = document.createElement('div'); cTitle.className = 'map-card-title'
  const cMeta = document.createElement('div'); cMeta.className = 'map-card-meta'
  const cRows = document.createElement('div'); cRows.className = 'map-card-rows'
  const cBest = document.createElement('div'); cBest.className = 'map-card-best'
  const cBar = document.createElement('div'); cBar.className = 'map-bar'; const cFill = document.createElement('i'); cBar.appendChild(cFill)
  const play = document.createElement('button'); play.className = 'mbtn mbtn-go map-play'; play.id = 'play'
  play.onclick = () => { const s = songs[selIdx]; if (s && s.charts[`${tier}|${mode}`]) opts.onPlay(s) }
  card.append(cTitle, cMeta, cRows, cBar, cBest, play)

  const chipRow = (id: string, items: { key: string; label: string }[], current: () => string, pick: (k: string) => void): HTMLElement => {
    const r = document.createElement('div'); r.className = 'px-chips'; r.id = id
    for (const it of items) {
      const b = document.createElement('button'); b.className = 'chip px-chip'; b.textContent = it.label
      b.onclick = () => { opts.sfx('ui_click'); pick(it.key); paintCard() }
      r.appendChild(b)
    }
    r.dataset.current = current()
    return r
  }
  const tiersRow = chipRow('tiers', opts.tiers, () => tier, (k) => { tier = k; opts.onTier(k) })
  const modesRow = chipRow('modes', opts.modes, () => mode, (k) => { mode = k; opts.onMode(k) })
  cRows.append(tiersRow, modesRow)

  let manifest: Manifest | null = null
  const paintCard = (): void => {
    const s = songs[selIdx]
    if (!s) return
    for (const [row, cur] of [[tiersRow, tier], [modesRow, mode]] as [HTMLElement, string][]) {
      const items = row.id === 'tiers' ? opts.tiers : opts.modes
      Array.from(row.children).forEach((b, i) => { b.classList.toggle('on', items[i].key === cur); b.setAttribute('aria-pressed', String(items[i].key === cur)) })
    }
    const entry = s.charts[`${tier}|${mode}`]
    const level = levelFor(s.id)
    const scene = manifest?.scenes.find((sc) => sc.id === level.scene)
    cTitle.textContent = s.title
    cMeta.textContent = `${Math.round(s.bpm)} bpm · ${fmtTime(s.duration)} · vs ${level.enemy.char.split('_')[0]}${scene ? ` · ${scene.mood}` : ''}${entry ? ` · ${entry.notes} notes` : ''}`
    const b = opts.bestOf(s, tier, mode)
    cFill.style.width = `${b ? Math.round(Math.max(0, Math.min(100, b.accuracy))) : 0}%`
    cBest.textContent = b ? `best ${b.grade} · ${b.accuracy.toFixed(1)}% · ${b.score}` : 'not played yet'
    play.disabled = !entry
    play.innerHTML = `<span class="mcur"></span><span class="mlbl">${entry ? 'PLAY' : 'NO CHART'}</span>`
  }

  let cardOpen = false
  const openCard = (): void => { if (cardOpen) return; cardOpen = true; paintCard(); card.hidden = false; card.classList.remove('out'); opts.sfx('ui_click') }
  const closeCard = (): void => { if (!cardOpen) return; cardOpen = false; card.classList.add('out'); window.setTimeout(() => { if (!cardOpen) card.hidden = true }, 160) }

  // ── the nodes on the map ───────────────────────────────────────────────
  let movie: GooseMovie | null = null
  const nodeEls: HTMLButtonElement[] = []
  const paintNodes = (): void => {
    nodesEl.replaceChildren()
    nodeEls.length = 0
    const ps = pageSongs()
    ps.forEach((s, i) => {
      const gi = page * PER_WORLD + i
      const b = document.createElement('button')
      b.className = 'map-node song' + (gi === selIdx ? ' on' : '') + (cleared(s) ? ' done' : '') + (s.custom ? ' mine' : '')
      b.dataset.title = s.title
      b.setAttribute('aria-label', `level ${gi + 1}: ${s.title}`)
      const best = opts.bestOf(s, tier, mode)
      b.innerHTML = `<b>${gi + 1}</b>${best ? `<i>${best.grade[0]}</i>` : ''}`
      b.onclick = () => { if (gi === selIdx) openCard(); else select(gi) }
      nodeEls.push(b)
      nodesEl.appendChild(b)
    })
    world.textContent = WORLD_NAMES[page % WORLD_NAMES.length]
    dots.replaceChildren()
    for (let i = 0; i < pages; i++) { const d = document.createElement('span'); d.className = i === page ? 'on' : ''; dots.appendChild(d) }
    movie?.map(ps.length, selIdx - page * PER_WORLD, ps.map(cleared))
    movie?.setWorld(page)
  }
  const select = (gi: number): void => {
    if (gi < 0 || gi >= songs.length) return
    const np = Math.floor(gi / PER_WORLD)
    selIdx = gi
    opts.onSelect(songs[gi])
    opts.sfx('ui_move')
    if (np !== page) { page = np; closeCard(); paintNodes(); return }
    nodeEls.forEach((b, i) => b.classList.toggle('on', page * PER_WORLD + i === selIdx))
    movie?.gooseTo(selIdx - page * PER_WORLD)
    if (cardOpen) paintCard()
  }
  const turn = (d: number): void => {
    const np = ((page + d) % pages + pages) % pages
    if (np === page) return
    page = np
    selIdx = page * PER_WORLD
    opts.onSelect(songs[selIdx])
    opts.sfx('ui_move')
    closeCard()
    paintNodes()
  }
  left.onclick = () => turn(-1)
  right.onclick = () => turn(1)

  stage.append(dim, nodesEl, world, left, right, dots, hint, add, back, card)

  // ── the movie, then the nodes ──────────────────────────────────────────
  let alive = true
  void Promise.all([opts.movie, loadManifest()]).then(([mv, m]) => {
    if (!alive) return
    movie = mv
    manifest = m
    stage.prepend(mv.el)
    mv.resize(px.w, px.h)
    paintNodes()
  })

  // nodes follow the camera: laid out every frame from the projected positions
  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    if (!movie) return
    nodeEls.forEach((b, i) => {
      const [x, y] = movie!.project(i)
      b.style.left = `${x - 9}px`
      b.style.top = `${y - 4}px`
    })
  }
  raf = requestAnimationFrame(tick)
  stops.push(() => cancelAnimationFrame(raf))

  const layout = (w: number, h: number): void => {
    movie?.resize(w, h)
    dim.style.left = '0'; dim.style.top = '0'; dim.style.width = `${w}px`; dim.style.height = `${h}px`
    nodesEl.style.left = '0'; nodesEl.style.top = '0'; nodesEl.style.width = `${w}px`; nodesEl.style.height = `${h}px`
    world.style.left = '0'; world.style.width = `${w}px`; world.style.top = '10px'
    left.style.left = '6px'; left.style.top = `${Math.round(h / 2) - 8}px`
    right.style.right = '6px'; right.style.top = `${Math.round(h / 2) - 8}px`
    dots.style.left = '0'; dots.style.width = `${w}px`; dots.style.top = `${h - 14}px`
    hint.style.left = '0'; hint.style.width = `${w}px`; hint.style.top = `${h - 24}px`
    add.style.right = '6px'; add.style.top = '6px'
    const cw = Math.min(200, w - 24)
    card.style.width = `${cw}px`; card.style.left = `${Math.round((w - cw) / 2)}px`; card.style.top = `${Math.round(h * 0.2)}px`
  }
  px.onResize(layout)

  // ── keys ──────────────────────────────────────────────────────────────
  let flying = false
  const onKey = (e: KeyboardEvent): void => {
    if (flying) return
    if (e.key === 'ArrowRight') { e.preventDefault(); if (selIdx + 1 < songs.length) select(selIdx + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (selIdx > 0) select(selIdx - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); turn(1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); turn(-1) }
    else if (e.key === 'Tab') { e.preventDefault(); if (cardOpen) { const mi = opts.modes.findIndex((m) => m.key === mode); mode = opts.modes[(mi + 1) % opts.modes.length].key; opts.onMode(mode); opts.sfx('ui_click'); paintCard() } }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (!cardOpen) openCard()
      else { const s = songs[selIdx]; if (s && s.charts[`${tier}|${mode}`]) opts.onPlay(s) }
    } else if (e.key === 'Escape') { if (cardOpen) { closeCard(); opts.sfx('ui_click') } else { opts.sfx('ui_click'); opts.onBack() } }
  }
  window.addEventListener('keydown', onKey)
  stops.push(() => window.removeEventListener('keydown', onKey))
  card.addEventListener('click', (e) => e.stopPropagation())
  dim.onclick = () => closeCard()

  // the arrival: everything fades and slides in while the camera flies up
  requestAnimationFrame(() => px.root.classList.add('in'))
  opts.sfx('ui_move')

  return {
    el: px.root,
    stage: px,
    stop: () => { alive = false; for (const s of stops) s() },
    flyOut: () => new Promise<void>((resolve) => {
      flying = true
      px.root.classList.add('flying')
      opts.sfx('crash_zoom')
      window.setTimeout(resolve, 500)
    }),
  }
}
