/**
 * The move gallery — `/gallery` (or `#gallery`) — every animation the goose
 * and its enemies have, to look at.
 *
 * Two views.  **All** is the contact sheet: every animation at once, each in
 * its own cell, looping on its authored key timings with a beat of rest
 * between takes, bare — no effects, no enemy, nothing but the move.  That is
 * the view for judging a pose or a hold against its neighbours.  **One** is
 * the examination: the chosen move played the way the fight plays it — the
 * real `Goose`, `Enemy`, `Combat` and effect layer, on the gallery's own clock
 * so it can run at an eighth speed, pause, step a frame at a time, loop, or
 * drop the effects to see the move underneath.  A heavy move is performed the
 * way the chart would have it: wound up, then landed on its contact time.
 *
 * Everything is drawn into the same pixel buffer the game uses, so what is on
 * screen here is what is on screen there, only bigger.
 */
import { ColorMatrixFilter, Container, Graphics } from 'pixi.js'
import type { Application, BitmapText } from 'pixi.js'

import type { PxAssets } from '../px/assets'
import type { PixelCanvas } from '../px/canvas'
import { PixelScene } from '../px/scene'
import { FxLayer } from '../px/fx'
import { Goose, Enemy, Fight, Puppet, HEAVY, windupSeconds, moveKeys } from '../px/actors'
import { Combat } from '../px/combat'
import type { Sfx } from '../px/combat'
import { KanjiLayer } from '../px/kanji'
import { pxText } from '../px/text'
import { ENEMIES } from '../px/levels'
import { mulberry32 } from '../px/chartmath'

export interface GalleryDeps {
  app: Application
  canvas: PixelCanvas
  assets: PxAssets
  sfx: Sfx
  onBack: () => void
}

export interface Gallery {
  el: HTMLElement
  /** what goes into the pixel buffer */
  stage: Container
  stop: () => void
}

type Mode = 'all' | 'one'

/** the list, in the order it is shown; `enemy:` names are the enemy's own */
const GROUPS: [string, string[]][] = [
  ['Heavy', ['launch', 'roll', 'boulder', 'volley', 'bodyslam', 'uppercut', 'megahonk', 'bellyflop']],
  ['Quick', ['slap', 'flurry', 'hop_slap', 'dropkick', 'whip', 'spin', 'peck', 'dive']],
  ['Taken', ['hurt', 'dodge_flat', 'dodge_side', 'cheer']],
  ['Moving', ['idle', 'walk', 'run', 'flap']],
  ['Enemy', ['enemy:idle', 'enemy:attack', 'enemy:attack2', 'enemy:hurt', 'enemy:launch', 'enemy:toss', 'enemy:die', 'enemy:flyoff']],
]
/** animations drawn key by key this round, marked so a redraw can be judged against what it replaced */
const NEW = new Set(['launch', 'roll', 'boulder', 'volley', 'uppercut', 'megahonk', 'slap', 'flurry', 'hop_slap', 'dropkick',
                     'whip', 'spin', 'peck', 'dive', 'hurt', 'dodge_flat', 'dodge_side', 'enemy:toss'])
const SPEEDS: [string, number][] = [['1×', 1], ['½', 0.5], ['¼', 0.25], ['⅛', 0.125]]
const ENEMY_NAMES = Object.keys(ENEMIES)
const PANEL_CSS_W = 250
/** the top bar's height in CSS pixels: the grid keeps clear of it */
const BAR_CSS_H = 44
/** the grid asks for a buffer twice the game's, so 30-odd cells fit and still read */
const GRID_ZOOM = 0.5
/** the headroom the tallest move needs over the goose's feet */
const HEADROOM = 84
/** the rest between takes of a looping cell */
const LOOP_GAP = 0.4
/** how fast a strip without authored keys loops in the grid */
const LOOP_FPS: Record<string, number> = { idle: 3, walk: 8, run: 10, flap: 10, attack: 12, attack2: 12, die: 10 }
/** a cell wants this much room; it is given no more than it can use */
const CELL_MIN_W = 80
const CELL_MIN_H = 88
const CELL_MAX_W = 128
const CELL_MAX_H = 116
/** the sheet's flat ground, and the shade that checkers it */
const SHEET_BG = 0x14121f
const SHEET_ALT = 0x1b1929

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** one cell of the contact sheet: a puppet looping one animation, and its name */
interface Cell {
  name: string
  puppet: Puppet
  label: BitmapText
  tag: BitmapText | null
  box: Container
  col: number
  row: number
  x: number
  y: number
  w: number
  h: number
}

export function buildGallery(deps: GalleryDeps): Gallery {
  const { app, canvas, assets, sfx } = deps
  const stage = new Container()
  const scene = new PixelScene(assets)
  const fx = new FxLayer(assets)
  const kanji = new KanjiLayer(assets)
  const gridLayer = new Container()
  const gridGfx = new Graphics()
  const invert = new ColorMatrixFilter()
  invert.negative(false)
  const rng = mulberry32(7)

  // ── state ────────────────────────────────────────────────────────────────
  let mode: Mode = 'all'
  let t = 0
  let speed = 1
  let paused = false
  let loop = false
  let fxOn = true
  let zoom = 1.5
  let move = 'bodyslam'
  let enemyName = ENEMY_NAMES[0]
  let sceneId = 'day_blue'
  let startedAt = 0
  let contactAt = -1
  let doneAt = -1
  let kickPx = 0
  let kickT = -1
  let invertUntil = -9
  let fight!: Fight
  let combat!: Combat
  let cells: Cell[] = []
  let cols = 6

  const all: string[] = GROUPS.flatMap(([, names]) => names)
  scene.set(sceneId)

  // ── the examination: one move, the way the fight plays it ────────────────
  /** the fighters, fresh: a move always starts from the idle */
  function build(): void {
    if (fight) stage.removeChild(fight.container)
    const g = assets.manifest.chars.goose
    const goose = new Goose(assets.char('goose'), g.feet, g.fw, g.fh, rng)
    const e = assets.manifest.chars[enemyName]
    const enemy = new Enemy(assets.char(enemyName), e.feet, e.fw, e.fh)
    fight = new Fight(goose, enemy)
    combat = new Combat(fight, fx, (n, d) => { if (fxOn) sfx(n, d) }, {
      kick: (px) => { if (fxOn) { kickPx = px; kickT = -1 } },
      kanji: (name, color, x, y, t0, big) => { if (fxOn) kanji.push(name, color, x, y, t0, big) },
      invert: (t0, secs) => { if (fxOn) invertUntil = t0 + secs },
    })
    goose.onEvent = combat.onEvent
    stage.addChildAt(fight.container, stage.getChildIndex(kanji.container) + 1)
    placeFight()
  }

  /**
   * The fight stands in the middle of what the panel leaves free, on the
   * scene's ground — or lower, when the zoom is so close that the ground would
   * leave less headroom than the tallest move needs (the body slam hangs some
   * 80 px over the goose's feet, and a move cut off by the top of the buffer is
   * the one thing this screen exists not to do).
   */
  function placeFight(): void {
    const panelPx = Math.round(PANEL_CSS_W * (window.devicePixelRatio || 1) / canvas.scale)
    const cx = panelPx + Math.round((canvas.w - panelPx) / 2)
    const floorY = canvas.h - 14
    const ground = Math.min(floorY, Math.max(scene.groundY, Math.min(HEADROOM, floorY)))
    const { goose, enemy } = fight
    enemy.x = cx - 24; enemy.y = ground; enemy.facing = 1
    goose.x = cx + 24; goose.y = ground; goose.facing = -1
    fight.aim()
  }

  function play(name = move): void {
    move = name
    fx.clear()
    kanji.clear()
    build()
    const { goose, enemy } = fight
    startedAt = t
    contactAt = -1
    doneAt = -1
    if (name.startsWith('enemy:')) {
      const anim = name.slice(6)
      if (anim === 'launch') enemy.launch(t)
      else if (anim === 'toss') { enemy.toss(t); enemy.slamDown(t + 0.9) }
      else if (anim === 'die') enemy.die(t)
      else if (anim === 'flyoff') enemy.flyOff(t)
      else if (anim === 'idle') { /* the beat does it */ }
      else enemy.play(anim, t, { fps: LOOP_FPS[anim] ?? 14 })
      return
    }
    if (name === 'hurt') { goose.hurt(t); if (fxOn) { sfx('hurt'); fx.spawn('puff_s', goose.x, goose.y - 12, t) } return }
    if (name.startsWith('dodge')) { goose.dodge(t); if (goose.current !== name) goose.dodge(t); return }
    if (['idle', 'walk', 'run', 'flap'].includes(name)) { if (name !== 'idle') goose.play(name, t, { loop: true }); return }
    if (name === 'dive') { enemy.toss(t - 0.9); enemy.slamDown(t - 0.2) }
    const played = goose.perform(name, t)
    if (!played) return
    // both kinds land by themselves — a heavy one when its wind-up ends, a quick one at its contact key —
    // and `tick` dresses the blow when the goose reports it
    contactAt = t + windupSeconds(name) + (HEAVY.includes(name) ? 0.02 : 0)
  }

  // ── the contact sheet: every animation at once, bare and looping ─────────
  /** a cell's puppet, looping its animation for ever with a beat of rest between takes */
  function loopCell(cell: Cell, t0: number): void {
    const { name, puppet } = cell
    const anim = name.startsWith('enemy:') ? name.slice(6) : name
    const strip = anim === 'launch' || anim === 'flyoff' || anim === 'toss' ? 'hurt' : anim
    if (!puppet.has(strip)) return
    const keys = moveKeys(anim)
    if (keys) puppet.play(strip, t0, { keys: [...keys, { dur: LOOP_GAP, dx: 0, dy: 0 }], loop: true })
    else puppet.play(strip, t0, { loop: true, fps: LOOP_FPS[anim] ?? 8 })
  }

  function buildCells(): void {
    for (const c of cells) { c.puppet.sprite.destroy(); c.label.destroy(); c.tag?.destroy(); c.box.destroy() }
    gridLayer.removeChildren()
    gridLayer.addChild(gridGfx)
    cells = all.map((name, i) => {
      const isEnemy = name.startsWith('enemy:')
      const who = isEnemy ? enemyName : 'goose'
      const m = assets.manifest.chars[who]
      const puppet = new Puppet(assets.char(who), m.feet, m.fw, m.fh)
      puppet.facing = isEnemy ? 1 : -1
      const label = pxText('px8', name.replace('enemy:', '').replace('_drawn', ' drawn'), 0xaed0e6)
      label.anchor.set(0.5, 0)
      const tag = NEW.has(name) ? pxText('px8', 'NEW', 0xffde7b) : null
      if (tag) tag.anchor.set(0, 0)
      const box = new Container()
      gridLayer.addChild(puppet.sprite, label)
      if (tag) gridLayer.addChild(tag)
      const cell: Cell = { name, puppet, label, tag, box, col: 0, row: 0, x: 0, y: 0, w: 0, h: 0 }
      // a different phase each, so the sheet never strobes in unison
      loopCell(cell, -i * 0.17)
      return cell
    })
    layoutGrid()
  }

  /**
   * Lay the cells out under the top bar: the column count that gives the
   * roomiest cell (a goose reaches about 80 × 88 game pixels at the top of a
   * body slam), each no larger than it needs to be, and the block centred —
   * a tight sheet rather than a few figures adrift in a big window.
   */
  function layoutGrid(): void {
    const top = Math.round(BAR_CSS_H * (window.devicePixelRatio || 1) / canvas.scale) + 4
    const w = canvas.w
    // the labels sit under the feet: keep the bottom row off the window's edge
    const h = canvas.h - top - 10
    const n = cells.length
    let best = -1
    for (let c = 3; c <= 10; c++) {
      const r = Math.ceil(n / c)
      const score = Math.min(w / c / CELL_MIN_W, h / r / CELL_MIN_H)
      if (score >= best) { best = score; cols = c }
    }
    const rows = Math.ceil(n / cols)
    const cw = Math.min(CELL_MAX_W, Math.floor(w / cols))
    const ch = Math.min(CELL_MAX_H, Math.floor(h / rows))
    const x0 = Math.floor((w - cols * cw) / 2)
    const y0 = top + Math.floor((h - rows * ch) / 2)
    cells.forEach((cell, i) => {
      cell.col = i % cols
      cell.row = Math.floor(i / cols)
      cell.w = cw
      cell.h = ch
      cell.x = x0 + cell.col * cw + Math.floor(cw / 2)
      cell.y = y0 + cell.row * ch + ch - 11
      cell.puppet.x = cell.x
      cell.puppet.y = cell.y
      cell.label.x = cell.x
      cell.label.y = cell.y + 2
      if (cell.tag) { cell.tag.x = cell.x - Math.floor(cw / 2) + 3; cell.tag.y = cell.y - ch + 14 }
    })
  }

  function layout(): void {
    scene.layout(canvas.w, canvas.h)
    if (mode === 'one') placeFight()
    else layoutGrid()
  }

  stage.addChild(scene.container, kanji.container, gridLayer, fx.container)
  build()
  buildCells()

  // ── the clock ────────────────────────────────────────────────────────────
  function tick(dt: number): void {
    t += dt
    // a 120 bpm beat for the idles to bob on
    const beat = t * 2
    if (mode === 'all') {
      for (const c of cells) { c.puppet.beat(Math.floor(beat), beat % 1); c.puppet.update(t) }
      return
    }
    const { goose, enemy } = fight
    goose.beat(Math.floor(beat), beat % 1)
    enemy.beat(Math.floor(beat), beat % 1)
    goose.update(t)
    enemy.update(t)
    const landed = goose.takeLanded()
    if (landed) combat.blow(landed, 'perfect', 4, t)
    fx.update(t)
    const busy = goose.busy(t) || goose.isWindingUp || enemy.busy(t)
    if (!busy && doneAt < 0 && t - startedAt > 0.1) doneAt = t
    if (loop && doneAt >= 0 && t - doneAt > 0.5) play()
  }

  function draw(dt: number): void {
    scene.update(t, dt, 0.3)
    const showing = mode === 'one'
    // the parallax scene belongs to the fight; the sheet has its own flat ground
    scene.container.visible = showing
    fight.container.visible = showing
    gridLayer.visible = !showing
    kanji.container.visible = showing && fxOn
    fx.container.visible = showing && fxOn
    stage.filters = showing && fxOn && t < invertUntil ? [invert] : []
    if (showing) kanji.draw(t)
    else drawGridMarks()
    // the camera kick, whole pixels, settling over 0.2 s
    let amp = 0
    if (showing && kickPx > 0) {
      if (kickT < 0) kickT = t
      const age = t - kickT
      if (age < 0.2) amp = Math.round((1 - age / 0.2) * kickPx)
      else { kickPx = 0; kickT = -1 }
    }
    stage.x = amp ? Math.round(Math.sin(t * 97.3) * amp) : 0
    stage.y = amp ? Math.round(Math.cos(t * 61.7) * amp * 0.7) : 0
    readout(showing)
  }

  /** the clock, the key and the state, in the bar — not in the buffer, where the zoom would blow it up */
  let lastRead = ''
  function readout(showing: boolean): void {
    let text = ''
    if (showing) {
      const key = fight.goose.keyIndex
      text = `t+${(t - startedAt).toFixed(2)}s`
        + (key >= 0 ? ` · key ${key}` : '')
        + (fight.goose.isWindingUp ? ' · winding up' : '')
        + ` · ${paused ? 'paused' : `${speed}×`}`
    }
    if (text !== lastRead) { lastRead = text; clock.textContent = text }
  }

  /**
   * The sheet under the cells: a flat ground (the parallax scene is a backdrop
   * for a fight, not for reading 32 figures against), every other cell a shade
   * lighter so the grid reads as a grid, a line under each figure's feet, and
   * a box round the one the cursor is on.
   */
  function drawGridMarks(): void {
    const g = gridGfx
    g.clear()
    g.rect(0, 0, canvas.w, canvas.h).fill({ color: SHEET_BG })
    for (const c of cells) {
      const x0 = c.x - Math.floor(c.w / 2)
      const y0 = c.y - c.h + 12
      if ((c.col + c.row) % 2 === 0) g.rect(x0, y0, c.w, c.h).fill({ color: SHEET_ALT })
      g.rect(x0 + 3, c.y, c.w - 6, 1).fill({ color: 0xffffff, alpha: 0.18 })
      c.label.tint = c.name === move ? 0xffde7b : 0x8d87a8
    }
    const sel = cells.find((c) => c.name === move)
    if (!sel) return
    g.rect(sel.x - Math.floor(sel.w / 2), sel.y - sel.h + 12, sel.w, sel.h)
      .stroke({ width: 1, color: 0xffde7b, alpha: 0.9 })
  }

  // ── the frame loop ───────────────────────────────────────────────────────
  let raf = 0
  let last = performance.now()
  function frame(now: number): void {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const z = mode === 'all' ? GRID_ZOOM : zoom
    if (canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, z)) layout()
    if (!paused) tick(dt * speed)
    draw(dt)
    canvas.render()
    app.renderer.render(app.stage)
  }

  // ── the panel ────────────────────────────────────────────────────────────
  const el = document.createElement('div')
  el.className = 'gallery'
  const bar = document.createElement('div')
  bar.className = 'gallery-bar'
  el.appendChild(bar)
  const panel = document.createElement('aside')
  panel.className = 'gallery-panel'
  el.appendChild(panel)

  const chips = new Map<string, HTMLButtonElement>()
  const chip = (text: string, on: () => void, cls = 'chip'): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = cls
    b.type = 'button'
    b.textContent = text
    b.addEventListener('click', () => { on(); refresh() })
    return b
  }
  const label = (text: string): HTMLElement => { const d = document.createElement('div'); d.className = 'label'; d.textContent = text; return d }
  const row = (): HTMLElement => { const d = document.createElement('div'); d.className = 'row gallery-row'; return d }

  // the bar: the two views, the name of what is showing, and the keys
  const title = document.createElement('strong')
  title.className = 'gallery-title'
  const allChip = chip('All', () => setMode('all'))
  const oneChip = chip('One', () => setMode('one'))
  const barHint = document.createElement('span')
  barHint.className = 'gallery-hint'
  const clock = document.createElement('span')
  clock.className = 'gallery-clock'
  const barBack = chip('← Back', () => deps.onBack())
  bar.append(allChip, oneChip, title, barHint, clock, barBack)

  for (const [group, names] of GROUPS) {
    panel.appendChild(label(group))
    const r = row()
    for (const n of names) {
      const b = chip(n.replace('enemy:', '').replace('_drawn', ' drawn'), () => { move = n; setMode('one') })
      if (NEW.has(n)) { const tag = document.createElement('span'); tag.className = 'gallery-new'; tag.textContent = 'new'; b.appendChild(tag) }
      chips.set(n, b)
      r.appendChild(b)
    }
    panel.appendChild(r)
  }

  panel.appendChild(label('Speed'))
  const speedRow = row()
  const speedChips: [number, HTMLButtonElement][] = []
  for (const [text, v] of SPEEDS) { const b = chip(text, () => { speed = v }); speedChips.push([v, b]); speedRow.appendChild(b) }
  panel.appendChild(speedRow)

  panel.appendChild(label('Show'))
  const showRow = row()
  const loopChip = chip('Loop', () => { loop = !loop })
  const fxChip = chip('Effects', () => { fxOn = !fxOn })
  const pauseChip = chip('Pause', () => { paused = !paused })
  const stepChip = chip('Step ›', () => { paused = true; tick(1 / 60) })
  const replayChip = chip('Replay', () => play())
  showRow.append(replayChip, loopChip, fxChip, pauseChip, stepChip)
  panel.appendChild(showRow)

  panel.appendChild(label('Zoom'))
  const zoomRow = row()
  const zoomChips: [number, HTMLButtonElement][] = []
  for (const z of [1, 1.5, 2]) { const b = chip(`${z}×`, () => { zoom = z }); zoomChips.push([z, b]); zoomRow.appendChild(b) }
  panel.appendChild(zoomRow)

  panel.appendChild(label('Enemy'))
  const enemyRow = row()
  const enemyChips: [string, HTMLButtonElement][] = []
  for (const n of ENEMY_NAMES) {
    const b = chip(n.replace('_', ' '), () => { enemyName = n; buildCells(); if (mode === 'one') play() })
    enemyChips.push([n, b]); enemyRow.appendChild(b)
  }
  panel.appendChild(enemyRow)

  panel.appendChild(label('Scene'))
  const sceneRow = row()
  const sceneChips: [string, HTMLButtonElement][] = []
  for (const s of assets.manifest.scenes) {
    const b = chip(s.id.replace('_', ' '), () => { sceneId = s.id; scene.set(sceneId); layout() })
    sceneChips.push([s.id, b]); sceneRow.appendChild(b)
  }
  panel.appendChild(sceneRow)

  const hint = document.createElement('p')
  hint.className = 'shint'
  hint.textContent = '← → ↑ ↓ move · Space replay · . step · P pause · L loop · F effects · 1–4 speed · Esc back to all'
  panel.appendChild(hint)

  function setMode(m: Mode): void {
    if (m === mode) { if (m === 'one') play(); return }
    mode = m
    paused = false
    fx.clear()
    kanji.clear()
    canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, m === 'all' ? GRID_ZOOM : zoom)
    layout()
    if (m === 'one') play()
    else { buildCells(); speed = 1 }
    refresh()
  }

  function refresh(): void {
    for (const [n, b] of chips) b.setAttribute('aria-pressed', String(n === move && mode === 'one'))
    for (const [v, b] of speedChips) b.setAttribute('aria-pressed', String(v === speed))
    for (const [z, b] of zoomChips) b.setAttribute('aria-pressed', String(z === zoom))
    for (const [n, b] of enemyChips) b.setAttribute('aria-pressed', String(n === enemyName))
    for (const [s, b] of sceneChips) b.setAttribute('aria-pressed', String(s === sceneId))
    loopChip.setAttribute('aria-pressed', String(loop))
    fxChip.setAttribute('aria-pressed', String(fxOn))
    pauseChip.setAttribute('aria-pressed', String(paused))
    allChip.setAttribute('aria-pressed', String(mode === 'all'))
    oneChip.setAttribute('aria-pressed', String(mode === 'one'))
    el.classList.toggle('gallery-solo', mode === 'one')
    title.textContent = mode === 'all' ? `${cells.length} animations, looping` : move.replace('enemy:', 'enemy ').replace('_drawn', ' drawn') + (NEW.has(move) ? ' · NEW' : '')
    barHint.textContent = mode === 'all'
      ? 'click one to examine it · arrows and Enter also work'
      : 'Esc back to all'
    if (mode === 'one') chips.get(move)?.scrollIntoView({ block: 'nearest' })
  }

  // ── input ────────────────────────────────────────────────────────────────
  /** the cell under a click on the canvas, by where it landed in the buffer */
  function cellAt(clientX: number, clientY: number): Cell | null {
    const r = app.canvas.getBoundingClientRect()
    const k = (window.devicePixelRatio || 1) / canvas.scale
    const gx = (clientX - r.left) * k
    const gy = (clientY - r.top) * k
    return cells.find((c) => Math.abs(gx - c.x) <= c.w / 2 && gy >= c.y - c.h + 12 && gy <= c.y + 12) ?? null
  }

  function onClick(e: MouseEvent): void {
    if (mode !== 'all') return
    const c = cellAt(e.clientX, e.clientY)
    if (!c) return
    move = c.name
    setMode('one')
  }
  function onMove(e: MouseEvent): void {
    if (mode !== 'all') return
    const c = cellAt(e.clientX, e.clientY)
    if (c && c.name !== move) { move = c.name; refresh() }
  }
  app.canvas.addEventListener('click', onClick)
  app.canvas.addEventListener('mousemove', onMove)

  function step(d: number): void {
    const i = all.indexOf(move)
    move = all[clamp(i + d, 0, all.length - 1)]
    if (mode === 'one') play()
    refresh()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') { step(mode === 'all' ? cols : 1); e.preventDefault() }
    else if (e.key === 'ArrowUp') { step(mode === 'all' ? -cols : -1); e.preventDefault() }
    else if (e.key === 'ArrowRight') { step(1); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault() }
    else if (e.key === 'Enter') { setMode('one'); e.preventDefault() }
    else if (e.key === ' ') { if (mode === 'one') play(); else setMode('one'); e.preventDefault() }
    else if (e.key === '.') { paused = true; tick(1 / 60) }
    else if (e.key === 'p' || e.key === 'P') paused = !paused
    else if (e.key === 'l' || e.key === 'L') loop = !loop
    else if (e.key === 'f' || e.key === 'F') fxOn = !fxOn
    else if (e.key >= '1' && e.key <= '4') speed = SPEEDS[Number(e.key) - 1][1]
    else if (e.key === 'Escape') { if (mode === 'one') setMode('all'); else deps.onBack(); return }
    else return
    refresh()
  }
  window.addEventListener('keydown', onKey)

  // ── the shots tool drives it through this ───────────────────────────────
  const handle = {
    moves: all,
    play: (n: string) => { move = n; setMode('one'); play(n); refresh() },
    /** run the clock forward to `rel` seconds after the move started, a frame at a time, and draw */
    seek: (rel: number) => {
      paused = true
      while (t - startedAt < rel - 1e-6) tick(Math.min(1 / 60, rel - (t - startedAt)))
      draw(0)
      canvas.render()
      app.renderer.render(app.stage)
    },
    /** let the grid run on for `secs` and draw it */
    run: (secs: number) => {
      const end = t + secs
      while (t < end) tick(Math.min(1 / 60, end - t))
      draw(0)
      canvas.render()
      app.renderer.render(app.stage)
    },
    set: (o: { mode?: Mode; speed?: number; loop?: boolean; fx?: boolean; zoom?: number; enemy?: string; scene?: string; paused?: boolean }) => {
      if (o.enemy !== undefined) { enemyName = o.enemy; buildCells() }
      if (o.scene !== undefined) { sceneId = o.scene; scene.set(sceneId); layout() }
      if (o.zoom !== undefined) zoom = o.zoom
      if (o.fx !== undefined) fxOn = o.fx
      if (o.loop !== undefined) loop = o.loop
      if (o.mode !== undefined) setMode(o.mode)
      if (o.speed !== undefined) speed = o.speed
      if (o.paused !== undefined) paused = o.paused
      refresh()
    },
    state: () => ({
      mode, move, t: t - startedAt, contactAt: contactAt < 0 ? -1 : contactAt - startedAt,
      key: fight.goose.keyIndex, busy: fight.goose.busy(t) || fight.goose.isWindingUp,
      windup: HEAVY.includes(move) ? windupSeconds(move) : 0, cols, cells: cells.length,
      panelPx: Math.round(PANEL_CSS_W * (window.devicePixelRatio || 1) / canvas.scale),
      scale: canvas.scale, w: canvas.w, h: canvas.h,
    }),
  }
  ;(window as unknown as { __gallery: typeof handle }).__gallery = handle

  // go
  canvas.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, GRID_ZOOM)
  layout()
  refresh()
  raf = requestAnimationFrame(frame)

  return {
    el,
    stage,
    stop: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      app.canvas.removeEventListener('click', onClick)
      app.canvas.removeEventListener('mousemove', onMove)
      fx.clear()
      stage.destroy({ children: true })
      delete (window as unknown as { __gallery?: unknown }).__gallery
    },
  }
}
