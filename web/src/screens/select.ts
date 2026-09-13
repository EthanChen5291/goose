/**
 * Song select — the desktop build's level screen, on the web.
 *
 * `game/screens/level_select.py` is Noki sitting on the left above a pink upload
 * button, a Canon / Custom tab pair, and the songs as a centred column of names
 * with the grade you last earned beside each one. The port's first pass was a
 * grid of cards, which worked but was a different app to look at.
 *
 * Difficulty and mode live at the foot of the list. On the desktop they are a
 * second screen (`level_menu.py`) reached after picking a song; here the whole
 * choice fits on one screen, so a second navigation step would be ceremony.
 */
import { petalField, spriteStrip, fitStage } from './chrome'
import type { SheetInfo } from './chrome'

const W = 1920
const H = 1080

export interface SelectSong {
  id: string
  title: string
  bpm: number
  duration: number
  custom?: unknown
  charts: Record<string, { notes: number }>
}

export interface SelectOptions {
  sheets: Record<string, SheetInfo>
  songs: SelectSong[]
  selectedId: string | null
  tier: string
  mode: string
  tiers: { key: string; label: string }[]
  modes: { key: string; label: string }[]
  /** the grade last earned on a song at the current tier and mode, if any */
  gradeOf: (song: SelectSong) => string | null
  onSelect: (song: SelectSong) => void
  onTier: (t: string) => void
  onMode: (m: string) => void
  onPlay: (song: SelectSong) => void
  onUpload: () => void
  onBack: () => void
}

const fmtTime = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export function buildSelect(opts: SelectOptions): { el: HTMLElement; stop: () => void } {
  const root = document.createElement('div')
  root.className = 'menu-root'

  const petals = petalField()
  root.appendChild(petals.el)

  const stage = document.createElement('div')
  stage.className = 'stage select-stage'
  root.appendChild(stage)
  const unfit = fitStage(stage, W, H)

  // ── back ────────────────────────────────────────────────────────────────
  const back = document.createElement('button')
  back.className = 'back-arrow'
  back.setAttribute('aria-label', 'Back')
  back.innerHTML = '<svg viewBox="0 0 40 44" aria-hidden="true"><path d="M34 4 L34 40 L6 22 Z" /></svg>'
  back.onclick = opts.onBack
  stage.appendChild(back)

  // ── left: Noki, then the upload button ──────────────────────────────────
  const left = document.createElement('div')
  left.className = 'select-left'
  stage.appendChild(left)

  const loop = opts.sheets['noki_base_loop']
  let strip: { el: HTMLElement; stop: () => void } | null = null
  if (loop) {
    strip = spriteStrip(loop, H * 0.36, 30)
    strip.el.classList.add('select-noki')
    left.appendChild(strip.el)
  }

  const upload = document.createElement('button')
  upload.className = 'upload-btn'
  upload.innerHTML = '<span>Upload</span><span>A File!</span>'
  upload.onclick = opts.onUpload
  left.appendChild(upload)

  // ── right: tabs, the list, then difficulty and mode ─────────────────────
  const right = document.createElement('div')
  right.className = 'select-right'
  stage.appendChild(right)

  const tabs = document.createElement('div')
  tabs.className = 'tabs'
  const canon = opts.songs.filter((s) => !s.custom)
  const custom = opts.songs.filter((s) => s.custom)
  let showCustom = Boolean(opts.selectedId && custom.some((s) => s.id === opts.selectedId))
  const tabCanon = document.createElement('button')
  const tabCustom = document.createElement('button')
  tabCanon.textContent = 'Canon'
  tabCustom.textContent = 'Custom'
  tabs.append(tabCanon, tabCustom)
  right.appendChild(tabs)

  const list = document.createElement('div')
  list.className = 'song-list'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Songs')
  right.appendChild(list)

  const fillList = (): void => {
    list.replaceChildren()
    tabCanon.className = showCustom ? '' : 'on'
    tabCustom.className = showCustom ? 'on' : ''
    const rows = showCustom ? custom : canon
    if (!rows.length) {
      const p = document.createElement('p')
      p.className = 'empty'
      p.textContent = 'Nothing here yet — use Upload A File!'
      list.appendChild(p)
      return
    }
    for (const s of rows) {
      const row = document.createElement('button')
      // `song` is kept alongside so the smoke tools keep their selector
      row.className = 'song song-row' + (s.id === opts.selectedId ? ' on' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(s.id === opts.selectedId))
      const name = document.createElement('span')
      name.className = 'song-name'
      name.textContent = s.title
      const grade = document.createElement('span')
      const g = opts.gradeOf(s)
      grade.className = 'song-grade' + (g ? ` g-${g[0].toLowerCase()}` : '')
      grade.textContent = g ?? ''
      const meta = document.createElement('span')
      meta.className = 'song-meta'
      meta.textContent = `${Math.round(s.bpm)} BPM · ${fmtTime(s.duration)}`
      row.append(name, meta, grade)
      row.onclick = () => opts.onSelect(s)
      row.ondblclick = () => opts.onPlay(s)
      list.appendChild(row)
    }
  }
  tabCanon.onclick = () => { showCustom = false; fillList() }
  tabCustom.onclick = () => { showCustom = true; fillList() }
  fillList()

  const foot = document.createElement('div')
  foot.className = 'select-foot'
  right.appendChild(foot)

  const chipRow = (id: string, items: { key: string; label: string }[], current: string,
                   pick: (k: string) => void): HTMLElement => {
    const r = document.createElement('div')
    r.className = 'chips'
    r.id = id
    for (const it of items) {
      const b = document.createElement('button')
      b.className = 'chip' + (it.key === current ? ' on' : '')
      b.textContent = it.label
      b.setAttribute('aria-pressed', String(it.key === current))
      b.onclick = () => pick(it.key)
      r.appendChild(b)
    }
    return r
  }
  foot.appendChild(chipRow('tiers', opts.tiers, opts.tier, opts.onTier))
  foot.appendChild(chipRow('modes', opts.modes, opts.mode, opts.onMode))

  const play = document.createElement('button')
  play.className = 'play-btn'
  play.id = 'play'
  const sel = opts.songs.find((s) => s.id === opts.selectedId) ?? null
  const entry = sel?.charts[`${opts.tier}|${opts.mode}`]
  play.disabled = !entry
  play.textContent = entry ? `Play · ${entry.notes} notes` : 'No chart for that pick'
  play.onclick = () => { if (sel && entry) opts.onPlay(sel) }
  foot.appendChild(play)

  return {
    el: root,
    stop: () => { petals.stop(); strip?.stop(); unfit() },
  }
}
