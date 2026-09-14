/**
 * The app shell: song select, then play, then results.
 *
 * game/menu.py and game/screens/* draw every button with pygame, because inside a
 * pygame window there is nothing else to draw with.  Here the menus are DOM — one
 * stylesheet instead of 2,700 lines of hand-drawn widgets, and keyboard- and
 * screen-reader-navigable for free — and only the play screen is a canvas.
 */
import { Application } from 'pixi.js'

import { AudioEngine } from './audio/engine'
import { PlaySession } from './core/session'
import type { Layout } from './core/layout'
import type { PlayRenderer } from './render/renderer'
import { TIER_LABEL } from './core/constants'
import { loadSettings, bestFor, recordScore } from './core/settings'
import { buildSettingsPanel } from './screens/settings'
import { buildCoachPanel } from './coach/panel'
import { buildImportScreen, getCustomSong, listCustomSongs } from './screens/library'
import { buildTitle } from './screens/title'
import { buildSelect } from './screens/select'
import type { SelectScreen } from './screens/select'
import { gooseMovie } from './screens/goose3d'
import type { GooseMovie, PoseName } from './screens/goose3d'
import { buildLoading } from './screens/loading'
import { PixelCinematic } from './px/cinematic'
import { buildWinShow } from './screens/winshow'
import { loadManifest } from './screens/pxchrome'
import type { CustomSong } from './screens/library'
import type { ChartFile, Mode, Song, Tier } from './core/models'
import type { RhythmManager } from './core/rhythm'
import { PxAssets } from './px/assets'
import { PixelCanvas } from './px/canvas'
import { PixelHighway } from './px/highway'
import { PixelLetters } from './px/letters'
import { levelFor } from './px/levels'
import { buildPause } from './screens/pause'
import { buildResults } from './screens/results'

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
/** the synthesised effects (tools/sfx_gen.py) */
const SFX = ['slap', 'slap2', 'whip', 'peck', 'honk', 'hurt', 'enemy_hit', 'miss', 'perfect', 'word',
             'combo', 'jump', 'slide', 'ui_move', 'ui_click', 'pause', 'win', 'lose',
             'whoosh', 'rock_break', 'uppercut', 'thud', 'splat', 'windup', 'megahonk', 'shift_tick',
             'shift_go', 'boom', 'whiff', 'run_steps', 'menace', 'glass', 'slash', 'kanji', 'flash_hit',
             'crash_zoom', 'text_tick', 'fight_card', 'throw_far', 'eye_glow', 'down_card']
const sfxUrl = (n: string) => `audio/sfx/${n}.wav`
const TIERS: Tier[] = ['journey', 'classic', 'master', 'demon']
const MODES: Mode[] = ['words', 'letters']

const app = document.getElementById('app')!
const audio = new AudioEngine()

let index: Index
let pixi: Application | null = null
let session: PlaySession | null = null
/** the pixel buffer every words-mode run draws into */
let canvas: PixelCanvas | null = null
let pxAssets: PxAssets | null = null
/** true while the live renderer is a pixel one (drawn through `canvas`) */
let pixelRun = false
let lastPlay: { song: SongEntry; chart: ChartEntry } | null = null
let raf = 0
let lastT = 0

/** the menu currently on screen; replacing one without stopping it leaves its
 *  petal field and sprite strips animating for the life of the tab */
let liveMenu: { el: HTMLElement; stop: () => void } | null = null
let liveSelect: SelectScreen | null = null
/** the one 3D movie: the shell owns it, the title, the select and the win show borrow its canvas */
let moviePromise: Promise<GooseMovie> | null = null
function getMovie(): Promise<GooseMovie> {
  moviePromise ??= loadManifest().then((m) => gooseMovie(m))
  return moviePromise
}
/** a menu or cutscene sound: loaded on first use */
function ui(name: string, vol = 0.6, delay = 0): void {
  void audio.load(sfxUrl(name)).then(() => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + delay, vol)).catch(() => null)
}
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
    onPlay: () => { click(); renderMenu() },
    onSettings: () => { click(); openSettings(renderTitle) },
    onMove: () => ui('ui_move', 0.5),
    movie: getMovie(),
  }))
}

function click(): void { void audio.load(sfxUrl('ui_click')).then(() => audio.playSfx(sfxUrl('ui_click'), undefined, 0.6)).catch(() => null) }

function openSettings(back: () => void): void {
  const panel = buildSettingsPanel(
    (s2) => { settings = s2; audio.musicVolume = Number(s2.music_volume ?? 0.8) },
    () => { panel.remove(); back() },
  )
  document.body.appendChild(panel)
}

function renderMenu(): void {
  const built = buildSelect({
    sfx: (n) => ui(n, 0.55),
    movie: getMovie(),
    songs: allSongs(),
    selectedId: selected?.id ?? null,
    tier,
    mode,
    tiers: TIERS.map((t) => ({ key: t, label: TIER_LABEL[t] })),
    modes: MODES.map((m) => ({ key: m, label: m === 'words' ? 'Words' : 'Letters' })),
    bestOf: (s2, t, m) => {
      const b = bestFor(s2.id, t, m)
      return b ? { grade: b.grade, accuracy: b.accuracy, score: b.score } : null
    },
    onSelect: (s2) => { selected = s2 as SongEntry },
    onTier: (t) => { tier = t as Tier },
    onMode: (m) => { mode = m as Mode },
    onPlay: (s2) => {
      const e = (s2 as SongEntry).charts[`${tier}|${mode}`]
      if (e) void enterLevel(s2 as SongEntry, e)
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
  })
  liveSelect = built
  showMenu(built)
}

/** which JoJo pose a level gets */
function poseFor(id: string): PoseName {
  let h = 0
  for (const c of id) h = (h * 33 + c.charCodeAt(0)) >>> 0
  return (['rohan', 'dio', 'giorno'] as PoseName[])[h % 3]
}

/**
 * Leaving the menu for a level: the panels fly past as the camera slams in on
 * the goose, the goose grows a body and strikes its pose under ド ド ド for two
 * seconds, then black — the goose running while the song loads — then the fight.
 */
async function enterLevel(songEntry: SongEntry, chartEntry: ChartEntry): Promise<void> {
  const sel = liveSelect
  const movie = await getMovie()
  await audio.unlock()
  if (sel) await Promise.all([sel.flyOut(), movie.zoomIn(0.55)])
  ui('kanji', 0.7, 0.42)
  ui('menace', 0.7, 0.46)
  await movie.pose(poseFor(songEntry.id), 2)
  await play(songEntry, chartEntry)
}

async function play(songEntry: SongEntry, chartEntry: ChartEntry): Promise<void> {
  // black, and the goose running, for at least a beat and a half
  const loading = buildLoading(() => {
    ui('run_steps', 0.5)
    const id = window.setInterval(() => ui('run_steps', 0.5), 1500)
    return () => window.clearInterval(id)
  })
  showMenu(loading)
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
    ...SFX.map((n) => audio.load(sfxUrl(n)).catch(() => null)),
  ])

  await loading.done
  if (pixi === null) {
    pixi = new Application()
    await pixi.init({
      resizeTo: window,
      // pixel art: no smoothing anywhere, and sprites land on whole pixels
      antialias: false,
      roundPixels: true,
      backgroundColor: 0x07060d,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl',
    })
    pixi.ticker.stop()
  }
  liveMenu?.stop()
  liveMenu = null
  app.replaceChildren(pixi.canvas)

  pixelRun = true
  pxAssets = await PxAssets.load()
  canvas ??= new PixelCanvas(pixi.renderer)
  canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
  const level = levelFor(songEntry.id)
  lastPlay = { song: songEntry, chart: chartEntry }

  session = new PlaySession({
    audio,
    audioUrl,
    chart,
    level: { song_path: audioUrl, difficulty: tier, mode, title: songEntry.title },
    settings,
    makeRenderer: (layout: Layout, song: Song, rhythm: RhythmManager): PlayRenderer => {
      void layout
      pixi!.stage.removeChildren()
      const r = mode === 'letters'
        ? new PixelLetters(canvas!, pxAssets!, song, rhythm, tier, settings, songEntry.title, level)
        : new PixelHighway(canvas!, pxAssets!, song, rhythm, tier, settings, songEntry.title, level)
      const sfxVol = Number(settings.hitsound_volume ?? 0.9)
      r.sfx = (name, delay = 0) => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + Math.max(0, delay), sfxVol)
      canvas!.world.removeChildren()
      canvas!.world.addChild(r.stage)
      pixi!.stage.addChild(canvas!.view)
      return r
    },
    onFinish: (stats, r) => { hidePause(); void finish(stats, songEntry, (r as PixelHighway | PixelLetters).won) },
    onPause: (paused) => { audio.playSfx(sfxUrl('pause'), undefined, 0.5); if (paused) showPause(); else hidePause() },
  })

  // the smoke test drives the live session through this handle
  ;(window as unknown as { __session: PlaySession; __chart: ChartFile }).__session = session
  ;(window as unknown as { __chart: ChartFile }).__chart = chart
  ;(window as unknown as { __pxCanvas: PixelCanvas | null }).__pxCanvas = pixelRun ? canvas : null
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
  if (pixi) {
    if (pixelRun && canvas && session) {
      // the buffer follows the window; a size change re-lays the screen out
      if (canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)) {
        (session.renderer as PixelHighway | PixelLetters).relayout()
      }
      canvas.render()
    }
    pixi.renderer.render(pixi.stage)
  }
}

/**
 * The song is over.  A win goes to the show-off first — the muscled goose in
 * cut-ins with a line — skippable with Enter; then the results.
 */
async function finish(stats: Record<string, number | string>, songEntry: SongEntry, won: boolean): Promise<void> {
  cancelAnimationFrame(raf)
  if (won) {
    await runCinematic(levelFor(songEntry.id))
    const movie = await getMovie()
    const show = buildWinShow(movie, songEntry.id, (n) => ui(n, 0.6))
    app.replaceChildren(show.el)
    await Promise.race([show.done, new Promise<void>((r) => {
      const skip = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === 'Escape') { window.removeEventListener('keydown', skip); r() } }
      window.addEventListener('keydown', skip)
    })])
    show.stop()
    movie.wander()
  }
  showResults(stats, songEntry)
}

/**
 * The stickman battle, drawn into the pixel buffer the fight just used, on its
 * own clock.  Enter or Escape skips it.
 */
function runCinematic(level: ReturnType<typeof levelFor>): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!pixi || !canvas || !pxAssets) { resolve(); return }
    const cine = new PixelCinematic(canvas, pxAssets, level)
    const sfxVol = Number(settings.hitsound_volume ?? 0.9)
    cine.sfx = (name, delay = 0) => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + Math.max(0, delay), sfxVol)
    canvas.world.removeChildren()
    canvas.world.addChild(cine.stage)
    pixi.stage.removeChildren()
    pixi.stage.addChild(canvas.view)
    app.replaceChildren(pixi.canvas)
    const t0 = performance.now()
    let id = 0
    const cineHandle = { t: 0 }
    ;(window as unknown as { __cine: { t: number } }).__cine = cineHandle
    const end = (): void => {
      cancelAnimationFrame(id)
      window.removeEventListener('keydown', onKey)
      cine.destroy()
      resolve()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === 'Escape') end() }
    window.addEventListener('keydown', onKey)
    const tick = (): void => {
      id = requestAnimationFrame(tick)
      const t = (performance.now() - t0) / 1000
      cineHandle.t = t
      if (canvas!.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)) cine.layout()
      cine.draw(t)
      canvas!.render()
      pixi!.renderer.render(pixi!.stage)
      if (cine.finished) end()
    }
    id = requestAnimationFrame(tick)
  })
}

let pauseEl: HTMLElement | null = null

function showPause(): void {
  hidePause()
  const el = buildPause({
    onResume: () => session?.togglePause(),
    onRestart: () => {
      const lp = lastPlay
      if (!lp || !session) return
      hidePause()
      session.stop()
      session.renderer.destroy()
      session = null
      void play(lp.song, lp.chart)
    },
    onSettings: () => {
      const panel = buildSettingsPanel(
        (s2) => { settings = s2; audio.musicVolume = Number(s2.music_volume ?? 0.8) },
        () => { panel.remove() },
      )
      document.body.appendChild(panel)
    },
    onQuit: () => session?.quit(),
  })
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
  const grade = String(stats.grade ?? 'C')[0]
  audio.playSfx(sfxUrl('SABC'.includes(grade) ? 'win' : 'lose'), undefined, 0.6)

  const openCoach = (): void => {
    const panel = buildCoachPanel(hits, songEntry.title, settings, () => panel.remove())
    document.body.appendChild(panel)
  }
  const onTab = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    if (document.querySelector('.coach')) document.querySelector('.coach')!.remove()
    else openCoach()
  }
  window.addEventListener('keydown', onTab)
  const leave = (): void => {
    window.removeEventListener('keydown', onTab)
    document.querySelector('.coach')?.remove()
    session?.stop()
    session?.renderer.destroy()
    session = null
    pixi?.stage.removeChildren()
    for (const u of objectUrls) URL.revokeObjectURL(u)
    objectUrls = []
  }
  const built = buildResults({
    title: songEntry.title,
    tierLabel: TIER_LABEL[tier],
    stats,
    prev,
    onBack: () => { click(); leave(); results?.stop(); results = null; renderMenu() },
    onTyping: () => { click(); openCoach() },
    onRetry: () => {
      click()
      const lp = lastPlay
      leave()
      results?.stop()
      results = null
      if (lp) void play(lp.song, lp.chart)
    },
  })
  results = built
  app.appendChild(built.el)
}

let results: { el: HTMLElement; stop: () => void } | null = null
