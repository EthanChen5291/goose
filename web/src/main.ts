/**
 * The app shell: song select, then play, then results.
 *
 * game/menu.py and game/screens/* draw every button with pygame, because inside a
 * pygame window there is nothing else to draw with.  Here the menus are DOM — one
 * stylesheet instead of 2,700 lines of hand-drawn widgets, and keyboard- and
 * screen-reader-navigable for free — and only the play screen is a canvas.
 */
import { Application, Assets, Texture } from 'pixi.js'

import { AudioEngine } from './audio/engine'
import { PlaySession } from './core/session'
import type { Layout } from './core/layout'
import { HighwayRenderer } from './render/highway'
import { LettersRenderer } from './render/letters'
import type { PlayRenderer } from './render/renderer'
import { loadFonts } from './render/text'
import { TIER_LABEL } from './core/constants'
import { loadSettings, bestFor, recordScore } from './core/settings'
import { buildSettingsPanel } from './screens/settings'
import { buildCoachPanel } from './coach/panel'
import { buildImportScreen, getCustomSong, listCustomSongs } from './screens/library'
import { buildTitle } from './screens/title'
import { buildSelect } from './screens/select'
import type { CustomSong } from './screens/library'
import type { ChartFile, Mode, Song, Tier } from './core/models'
import type { RhythmManager } from './core/rhythm'

interface ChartEntry { id: string; notes: number; bars: number }
interface SongEntry {
  id: string
  title: string
  /** a URL for a shipped song; an object URL minted on demand for an imported one */
  audio: string
  bpm: number
  duration: number
  charts: Record<string, ChartEntry>
  /** set on imported songs: their charts travel with them, not in /charts */
  custom?: CustomSong
}
interface Index {
  songs: SongEntry[]
  sheets: Record<string, { url: string; frames: number; w: number; h: number }>
  images?: string[]
}

const HITSOUND = 'audio/sfx/hitsound.mp3'
const TIERS: Tier[] = ['journey', 'classic', 'master', 'demon']
const MODES: Mode[] = ['words', 'letters']

const app = document.getElementById('app')!
const audio = new AudioEngine()

let index: Index
let pixi: Application | null = null
let session: PlaySession | null = null
let raf = 0
let lastT = 0

/** the menu currently on screen; replacing one without stopping it leaves its
 *  petal field and sprite strips animating for the life of the tab */
let liveMenu: { el: HTMLElement; stop: () => void } | null = null
let customSongs: CustomSong[] = []
let objectUrls: string[] = []
let selected: SongEntry | null = null
let tier: Tier = 'classic'
let mode: Mode = 'words'

let settings = loadSettings()

boot()

async function boot(): Promise<void> {
  app.innerHTML = '<div class="screen"><p class="loading">Loading…</p></div>'
  index = await (await fetch('index.json')).json()
  await loadFonts()
  await refreshCustom()
  selected = allSongs()[0] ?? null
  renderTitle()
}

async function refreshCustom(): Promise<void> {
  customSongs = await listCustomSongs()
}

/** An imported song, shaped like a shipped one so the menu need not care. */
function asEntry(c: CustomSong): SongEntry {
  const charts: Record<string, ChartEntry> = {}
  for (const [k, v] of Object.entries(c.charts)) {
    const meta = (v as { meta?: { notes?: number; bars?: number } }).meta ?? {}
    charts[k] = { id: `${c.id}:${k}`, notes: meta.notes ?? 0, bars: meta.bars ?? 0 }
  }
  return { id: c.id, title: c.title, audio: '', bpm: c.bpm, duration: c.duration, charts, custom: c }
}

function allSongs(): SongEntry[] {
  return [...customSongs.map(asEntry), ...index.songs]
}


function showMenu(built: { el: HTMLElement; stop: () => void }): void {
  liveMenu?.stop()
  liveMenu = built
  app.replaceChildren(built.el)
}

function renderTitle(): void {
  showMenu(buildTitle({
    sheets: index.sheets,
    onPlay: () => renderMenu(),
    onSettings: () => openSettings(renderTitle),
  }))
}

function openSettings(back: () => void): void {
  const panel = buildSettingsPanel(
    (s2) => { settings = s2; audio.musicVolume = Number(s2.music_volume ?? 0.8) },
    () => { panel.remove(); back() },
  )
  document.body.appendChild(panel)
}

function renderMenu(): void {
  showMenu(buildSelect({
    sheets: index.sheets,
    songs: allSongs(),
    selectedId: selected?.id ?? null,
    tier,
    mode,
    tiers: TIERS.map((t) => ({ key: t, label: TIER_LABEL[t] })),
    modes: MODES.map((m) => ({ key: m, label: m === 'words' ? 'Words' : 'Letters' })),
    gradeOf: (s2) => bestFor(s2.id, tier, mode)?.grade ?? null,
    onSelect: (s2) => { selected = s2 as SongEntry; renderMenu() },
    onTier: (t) => { tier = t as Tier; renderMenu() },
    onMode: (m) => { mode = m as Mode; renderMenu() },
    onPlay: (s2) => {
      const e = (s2 as SongEntry).charts[`${tier}|${mode}`]
      if (e) void play(s2 as SongEntry, e)
    },
    onUpload: () => {
      const panel = buildImportScreen(
        async () => { await refreshCustom() },
        async () => {
          panel.remove()
          await refreshCustom()
          if (selected && !allSongs().some((s2) => s2.id === selected!.id)) {
            selected = allSongs()[0] ?? null
          }
          renderMenu()
        },
      )
      document.body.appendChild(panel)
    },
    onBack: () => renderTitle(),
  }))
}

async function play(songEntry: SongEntry, chartEntry: ChartEntry): Promise<void> {
  app.innerHTML = '<div class="screen"><p class="loading">Loading the song…</p></div>'
  await audio.unlock()

  let chart: ChartFile
  let audioUrl: string
  if (songEntry.custom) {
    // the bundle carries its charts; the audio is a Blob, so it needs an object URL
    const fresh = await getCustomSong(songEntry.custom.id)
    if (fresh === null) { renderMenu(); return }
    chart = fresh.charts[`${tier}|${mode}`] as unknown as ChartFile
    audioUrl = URL.createObjectURL(fresh.audio)
    objectUrls.push(audioUrl)
  } else {
    chart = await fetch(`charts/${chartEntry.id}.json`).then((r) => r.json() as Promise<ChartFile>)
    audioUrl = songEntry.audio
  }
  await Promise.all([
    audio.load(audioUrl),
    // the hitsound is tiny and shared by every run; a failure here is not fatal
    audio.load(HITSOUND).catch(() => null),
  ])

  if (pixi === null) {
    pixi = new Application()
    await pixi.init({
      resizeTo: window,
      antialias: true,
      backgroundColor: 0x07060d,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      preference: 'webgl',
    })
    pixi.ticker.stop()
  }
  app.replaceChildren(pixi.canvas)

  let sheetTex: Texture | null = null
  const sheet = index.sheets?.noki_bop
  if (sheet) {
    try { sheetTex = await Assets.load(sheet.url) } catch { sheetTex = null }
  }

  session = new PlaySession({
    audio,
    audioUrl,
    chart,
    level: { song_path: audioUrl, difficulty: tier, mode, title: songEntry.title },
    settings,
    makeRenderer: (layout: Layout, song: Song, rhythm: RhythmManager): PlayRenderer => {
      const r: PlayRenderer = mode === 'letters'
        ? new LettersRenderer(layout, song, rhythm, tier, pixi!.renderer, settings, songEntry.title)
        : new HighwayRenderer(layout, song, rhythm, tier, pixi!.renderer, settings, songEntry.title)
      pixi!.stage.removeChildren()
      pixi!.stage.addChild(r.stage)
      if (sheetTex && sheet) r.setNokiSheet(sheetTex, sheet)
      return r
    },
    onFinish: (stats) => { hidePause(); showResults(stats, songEntry) },
    onPause: (paused) => { if (paused) showPause(); else hidePause() },
  })

  // the smoke test drives the live session through this handle
  ;(window as unknown as { __session: PlaySession; __chart: ChartFile }).__session = session
  ;(window as unknown as { __chart: ChartFile }).__chart = chart
  session.setHitsound(HITSOUND)
  session.start()
  lastT = performance.now()
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(frame)
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(0.05, (now - lastT) / 1000)
  lastT = now
  if (session && !session.finished) session.update(dt)
  if (pixi) pixi.renderer.render(pixi.stage)
}

let pauseEl: HTMLElement | null = null

function showPause(): void {
  hidePause()
  const el = document.createElement('div')
  el.className = 'overlay'
  el.innerHTML = `
    <div class="card">
      <div class="grade" style="font-size:40px">Paused</div>
      <p class="subtitle" style="margin:0 auto 22px">Esc resumes.</p>
      <div class="row" style="justify-content:center">
        <button class="play" id="resume">Resume</button>
        <button class="chip" id="quit">Back to songs</button>
      </div>
    </div>
  `
  ;(el.querySelector('#resume') as HTMLButtonElement).onclick = () => session?.togglePause()
  ;(el.querySelector('#quit') as HTMLButtonElement).onclick = () => session?.quit()
  document.body.appendChild(el)
  pauseEl = el
}

function hidePause(): void {
  pauseEl?.remove()
  pauseEl = null
}

function showResults(stats: Record<string, number | string>, songEntry: SongEntry): void {
  cancelAnimationFrame(raf)
  const hits = session?.rhythm.hits ?? []
  // record first, then read: `recordScore` hands back the best that stood before
  const prev = recordScore(songEntry.id, tier, mode, stats)
  const n = (k: string) => Number(stats[k] ?? 0)
  const beat = prev === null || n('score') > prev.score
  const el = document.createElement('div')
  el.className = 'overlay'
  el.innerHTML = `
    <div class="card">
      <div class="label" id="ttl"></div>
      <div class="grade">${stats.grade}</div>
      <div class="score">${n('score').toLocaleString('en-US')}</div>
      <p class="best">${
        prev === null
          ? 'Your first run on this one.'
          : beat
            ? `New best. Previous ${prev.score.toLocaleString('en-US')} ${prev.grade}.`
            : `Best ${prev.score.toLocaleString('en-US')} ${prev.grade}.`
      }</p>
      <div class="stats">
        <div class="stat"><div class="v">${n('accuracy').toFixed(1)}%</div><div class="k">Accuracy</div></div>
        <div class="stat"><div class="v">${n('max_combo')}</div><div class="k">Max combo</div></div>
        <div class="stat"><div class="v">${n('misses')}</div><div class="k">Misses</div></div>
        <div class="stat"><div class="v">${n('perfect')}</div><div class="k">Perfect</div></div>
        <div class="stat"><div class="v">${n('good')}</div><div class="k">Great</div></div>
        <div class="stat"><div class="v">${n('ok')}</div><div class="k">OK</div></div>
      </div>
      <div class="row" style="justify-content:center">
        <button class="play" id="back">Back to songs</button>
        <button class="chip" id="typing">Typing <kbd>Tab</kbd></button>
      </div>
    </div>
  `
  const openCoach = (): void => {
    const panel = buildCoachPanel(hits, songEntry.title, settings, () => panel.remove())
    document.body.appendChild(panel)
  }
  ;(el.querySelector('#typing') as HTMLButtonElement).onclick = openCoach
  const onTab = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    if (document.querySelector('.coach')) document.querySelector('.coach')!.remove()
    else openCoach()
  }
  window.addEventListener('keydown', onTab)

  el.querySelector('#ttl')!.textContent = `${songEntry.title} · ${TIER_LABEL[tier]}`
  ;(el.querySelector('#back') as HTMLButtonElement).onclick = () => {
    window.removeEventListener('keydown', onTab)
    document.querySelector('.coach')?.remove()
    session?.stop()
    session?.renderer.destroy()
    session = null
    pixi?.stage.removeChildren()
    for (const u of objectUrls) URL.revokeObjectURL(u)
    objectUrls = []
    renderMenu()
  }
  app.appendChild(el)
}
