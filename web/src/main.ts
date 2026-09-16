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
import type { GooseMovie } from './screens/goose3d'
import { buildLoading } from './screens/loading'
import { buildWinShow } from './screens/winshow'
import { loadManifest } from './screens/pxchrome'
import type { CustomSong } from './screens/library'
import type { ChartFile, Mode, Song, Tier } from './core/models'
import type { RhythmManager } from './core/rhythm'
import { PxAssets } from './px/assets'
import { PixelCanvas } from './px/canvas'
import { PixelHighway } from './px/highway'
import { PixelDuel } from './px/duel'
import { loadEnemyVoxels } from './px/duel3d'
import { levelFor } from './px/levels'
import { buildPause } from './screens/pause'
import { buildResults } from './screens/results'
import { buildGallery } from './screens/gallery'

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
             'shift_go', 'boom', 'whiff', 'menace', 'glass', 'slash', 'kanji', 'flash_hit',
             'crash_zoom', 'text_tick', 'fight_card', 'throw_far', 'eye_glow', 'down_card',
             'bodyslam', 'dash', 'bat', 'smash', 'flip', 'lash', 'roll', 'whip_boom']
const sfxUrl = (n: string, ext = 'wav') => `audio/sfx/${n}.${ext}`
/** the goose's footsteps: three recordings (assets/audios/effects), not synthesised */
const RUN_STEPS = ['gooserun1', 'gooserun2', 'gooserun3'].map((n) => sfxUrl(n, 'mp3'))
/**
 * The menu theme: 165 bpm, and cut by tools/export_web.py to a whole 72 bars
 * that open on its first beat — the drop — with the room tone before it and the
 * silence after it gone.  So the file is the loop: it repeats end to end, in
 * time, and there is nothing to sit through before the title lands.
 */
const THEME = 'audio/theme.mp3'
const THEME_BEAT = 60 / 165
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
/** the movie's cues, as sounds: name → effect and volume */
const CUES: Record<string, [string, number]> = {
  jump: ['jump', 0.5], land: ['thud', 0.3], whoosh: ['whoosh', 0.5], flash: ['flash_hit', 0.6],
  crash_zoom: ['crash_zoom', 0.7], trap: ['whoosh', 0.6], thud: ['thud', 0.6], honk: ['honk', 0.45],
  slap: ['slap', 0.7], splat: ['splat', 0.6], throw_far: ['throw_far', 0.6],
  beam: ['windup', 0.5], ufo: ['whoosh', 0.6], menace: ['menace', 0.6],
}
function getMovie(): Promise<GooseMovie> {
  moviePromise ??= loadManifest().then((m) => gooseMovie(m)).then((mv) => {
    mv.onCue = (name) => {
      if (name === 'run_steps') { runSteps(0.5); return }
      const c = CUES[name]
      if (c) ui(c[0], c[1])
    }
    return mv
  })
  return moviePromise
}
/** the plate the goose stands on when the title comes back: the one it left by */
let titleAt = 0
/** a menu or cutscene sound: loaded on first use */
function ui(name: string, vol = 0.6, delay = 0): void {
  void audio.load(sfxUrl(name)).then(() => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + delay, vol)).catch(() => null)
}
/** where the footsteps have got to: the next recording, and when the one playing ends */
let runStep = 0
let runStepsUntil = 0
/**
 * A run of footsteps, taking the three recordings in turn.
 *
 * The cue fires per step — every 0.11s in the map rush, and on a timer under the
 * loader — but each recording is already a couple of seconds of running, so a
 * call lands only once the last one has played out.  They chain, they never pile up.
 */
function runSteps(vol = 0.5): void {
  if (audio.ctx.currentTime < runStepsUntil) return
  const url = RUN_STEPS[runStep++ % RUN_STEPS.length]
  runStepsUntil = audio.ctx.currentTime + 0.25   // holds the gate while it decodes
  void audio.load(url).then((buf) => {
    audio.playSfx(url, undefined, vol)
    runStepsUntil = audio.ctx.currentTime + buf.duration - 0.06
  }).catch(() => { runStepsUntil = 0 })
}
/** the AudioContext time the theme's own zero sits at, or null while it is silent */
let themeAt: number | null = null
/** true while a listener is waiting for the gesture that lets the page have sound */
let gestureArmed = false
/** Seconds into the theme, or null while it is not playing. */
function themeSince(): number | null {
  return themeAt === null ? null : audio.ctx.currentTime - themeAt
}
/**
 * Start the theme, looping.
 *
 * A page that has not been touched yet is not allowed to make a sound, and
 * `unlock` cannot change that on its own: all it can do is ask, and the context
 * stays suspended until the first gesture.  So when it is refused, the next
 * pointer or key press tries again, and the intro waits on this clock rather
 * than on one of its own — the title lands on the drop whenever the drop is.
 */
async function startTheme(): Promise<boolean> {
  if (audio.ctx.state !== 'running') {
    // `resume()` on a page nobody has touched yet never settles in Chrome, so it
    // is asked, never awaited: the gesture listener is what actually gets sound
    void audio.unlock().catch(() => null)
    armGesture()
    return false
  }
  try {
    await audio.load(THEME)
  } catch { return false }
  // the menus never opened a run, so nothing else has told the mixer the setting
  audio.musicVolume = Number(settings.music_volume ?? 0.8)
  themeAt = audio.playMusic(THEME, undefined, 0, true)
  return true
}
function armGesture(): void {
  if (gestureArmed) return
  gestureArmed = true
  const events = ['pointerdown', 'keydown', 'touchstart']
  const go = (): void => {
    for (const ev of events) window.removeEventListener(ev, go)
    gestureArmed = false
    // called from inside the gesture, so this resume is the one that takes
    void audio.ctx.resume().then(() => startTheme()).catch(() => null)
  }
  for (const ev of events) window.addEventListener(ev, go)
}
/** The menus all play the theme; a run takes the music over and gives it back. */
function ensureTheme(): void {
  if (themeAt === null) void startTheme()
}
/** What the screens need of the theme: its clock, and the grid it runs on. */
const themeClock = { since: themeSince, beat: THEME_BEAT }
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
  // decoding is allowed while the context is shut, so the theme is ready to go
  // the moment the page is touched
  void audio.load(THEME).catch(() => null)
  await refreshCustom()
  selected = allSongs()[0] ?? null
  for (const ev of ['hashchange', 'popstate']) window.addEventListener(ev, () => { if (atGallery()) void openGallery() })
  if (atGallery()) { void openGallery(); return }
  renderTitle(true)
}

/** the gallery's route: /gallery, or #gallery for a build served without a history fallback */
function atGallery(): boolean {
  return location.hash === '#gallery' || /\/gallery\/?$/.test(location.pathname)
}

/** the one Pixi application, made on first need and kept */
async function ensurePixi(): Promise<Application> {
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
  return pixi
}

/**
 * The move gallery at `/gallery` (`#gallery` also works): every animation the
 * goose and the enemies have, all of them looping side by side, or one of them
 * examined on its own clock.  Back returns to the title.
 */
let liveGallery: { el: HTMLElement; stop: () => void } | null = null
async function openGallery(): Promise<void> {
  if (liveGallery) return
  cancelAnimationFrame(raf)
  liveMenu?.stop()
  liveMenu = null
  const px = await ensurePixi()
  pxAssets = await PxAssets.load()
  canvas ??= new PixelCanvas(px.renderer)
  await Promise.all([...SFX.map((n) => audio.load(sfxUrl(n))), ...RUN_STEPS.map((u) => audio.load(u))]
    .map((p) => p.catch(() => null)))
  px.stage.removeChildren()
  px.stage.addChild(canvas.view)
  canvas.world.removeChildren()
  const g = buildGallery({
    app: px, canvas, assets: pxAssets,
    sfx: (name, delay = 0) => { void audio.unlock().then(() => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + Math.max(0, delay), 0.8)).catch(() => null) },
    onBack: () => {
      g.stop()
      liveGallery = null
      px.stage.removeChildren()
      if (atGallery()) history.replaceState(null, '', location.pathname.replace(/\/gallery\/?$/, '/'))
      renderTitle()
    },
  })
  liveGallery = g
  canvas.world.addChild(g.stage)
  app.replaceChildren(px.canvas, g.el)
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

/** `intro` opens the session: black, the pickup, the wordmark typed onto the drop */
function renderTitle(intro = false): void {
  showMenu(buildTitle({
    onPlay: () => { titleAt = 0; renderMenu() },
    onImport: () => { titleAt = 1; openImport(renderTitle) },
    onSettings: () => { titleAt = 2; openSettings(renderTitle) },
    onMove: () => ui('ui_move', 0.5),
    movie: getMovie(),
    at: titleAt,
    music: themeClock,
    intro,
  }))
  ensureTheme()
}

/** the import panel over whatever is on screen; `back` rebuilds that screen when it closes */
function openImport(back: () => void): void {
  const panel = buildImportScreen(
    async () => { await refreshCustom() },
    async () => {
      panel.remove()
      await refreshCustom()
      if (selected && !allSongs().some((s2) => s2.id === selected!.id)) {
        selected = allSongs()[0] ?? null
      }
      back()
    },
  )
  document.body.appendChild(panel)
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
    arrive: true,
    songs: allSongs(),
    selectedId: selected?.id ?? null,
    tier,
    mode,
    tiers: TIERS.map((t) => ({ key: t, label: TIER_LABEL[t] })),
    modes: MODES.map((m) => ({ key: m, label: m === 'words' ? 'Words' : 'Duel' })),
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
    onUpload: () => openImport(renderMenu),
    onBack: () => { titleAt = 0; renderTitle() },
  })
  liveSelect = built
  showMenu(built)
  ensureTheme()
}

/**
 * Leaving the map for a level: the chrome fades while a saucer races in over
 * the goose, lifts it in its beam, and a pair of gloves clap it flat — the
 * sprite, at last — then black, the goose running while the song loads, then
 * the fight.
 */
async function enterLevel(songEntry: SongEntry, chartEntry: ChartEntry): Promise<void> {
  const sel = liveSelect
  const movie = await getMovie()
  await audio.unlock()
  if (sel) await Promise.all([sel.flyOut(), movie.abduct()])
  await play(songEntry, chartEntry)
}

async function play(songEntry: SongEntry, chartEntry: ChartEntry): Promise<void> {
  // black, and the goose running, for at least a beat and a half
  const loading = buildLoading(() => {
    runSteps(0.5)
    const id = window.setInterval(() => runSteps(0.5), 250)
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
    ...RUN_STEPS.map((u) => audio.load(u).catch(() => null)),
  ])

  await loading.done
  pixi = await ensurePixi()
  liveMenu?.stop()
  liveMenu = null
  app.replaceChildren(pixi.canvas)

  pixelRun = true
  pxAssets = await PxAssets.load()
  canvas ??= new PixelCanvas(pixi.renderer)
  canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
  const level = levelFor(songEntry.id)
  // the duel builds its enemy from the sprite's strips; have them solid before the count-in
  if (mode === 'letters') await loadEnemyVoxels(pxAssets.manifest, level.enemy.char).catch(() => null)
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
        ? new PixelDuel(canvas!, pxAssets!, song, rhythm, tier, settings, songEntry.title, level)
        : new PixelHighway(canvas!, pxAssets!, song, rhythm, tier, settings, songEntry.title, level)
      const sfxVol = Number(settings.hitsound_volume ?? 0.9)
      r.sfx = (name, delay = 0) => audio.playSfx(sfxUrl(name), audio.ctx.currentTime + Math.max(0, delay), sfxVol)
      canvas!.world.removeChildren()
      canvas!.world.addChild(r.stage)
      pixi!.stage.addChild(canvas!.view)
      return r
    },
    onFinish: (stats, r) => { hidePause(); void finish(stats, songEntry, (r as PixelHighway | PixelDuel).won) },
    onPause: (paused) => { audio.playSfx(sfxUrl('pause'), undefined, 0.5); if (paused) showPause(); else hidePause() },
  })

  // the smoke test drives the live session through this handle
  ;(window as unknown as { __session: PlaySession; __chart: ChartFile }).__session = session
  ;(window as unknown as { __chart: ChartFile }).__chart = chart
  ;(window as unknown as { __pxCanvas: PixelCanvas | null }).__pxCanvas = pixelRun ? canvas : null
  session.setHitsound(HITSOUND)
  // the run's own music replaces the theme: `playMusic` stops whatever is playing
  themeAt = null
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
        (session.renderer as PixelHighway | PixelDuel).relayout()
      }
      canvas.render()
    }
    pixi.renderer.render(pixi.stage)
  }
}

/**
 * The song is over.  A win goes to the stance first — the goose grown into
 * the hero, the JoJo pose in three cuts with a line — skippable with Enter;
 * then the results.
 */
async function finish(stats: Record<string, number | string>, songEntry: SongEntry, won: boolean): Promise<void> {
  cancelAnimationFrame(raf)
  if (won) {
    const movie = await getMovie()
    const show = buildWinShow(movie, songEntry.id, (n) => ui(n, 0.6))
    app.replaceChildren(show.el)
    await Promise.race([show.done, new Promise<void>((r) => {
      const skip = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === 'Escape') { window.removeEventListener('keydown', skip); r() } }
      window.addEventListener('keydown', skip)
    })])
    show.stop()
  }
  showResults(stats, songEntry)
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
