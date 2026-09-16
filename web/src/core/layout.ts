/**
 * Layout — every play-screen number in one place, in 1920×1080 design units,
 * scaled to the real window so the play field fills it.  A port of game/layout.py.
 *
 * Nothing in the renderers hard-codes a pixel.  The design is 1920×1080 and a
 * window of another shape is *filled*, never letterboxed: a taller window fits
 * the design width and gains room at the top, so the orbs fall a little further
 * while the slot line, the word block and Noki stay where they are at the bottom;
 * a wider window fits the height and gains columns at the sides, so the grid
 * simply continues past the outer lanes.  `top`, `left`, `right` and `bottom` are
 * the window's edges in design units and the renderers paint out to them.
 * Letters mode centres its field vertically instead.
 */

export const DESIGN_W = 1920
export const DESIGN_H = 1080

/** one grid column */
export const LANE_W = 320
/** lanes sit right of centre: a 480 px column for Noki on the left, 160 px on the right */
export const HIGHWAY_X0 = 480
export const HIGHWAY_CX = HIGHWAY_X0 + 2 * LANE_W
export const LANE_CENTERS = [0, 1, 2, 3].map((i) => HIGHWAY_X0 + Math.floor(LANE_W / 2) + i * LANE_W)
export const SLOT_Y = 840
export const SLOT_Y_WITH_KEYBOARD = 760
/** orbs appear this far above the window's top edge */
export const SPAWN_MARGIN = 60
/** big enough that the letter reads from across the room */
export const ORB_R = 46
export const SLOT_RING_R = 52
/** a quarter of the screen height (a third read as 25 % too big) */
export const NOKI_H = 285
export const NOKI_W = 220
/** Noki's feet sit this far below the slot line: standing on it, not floating over it */
export const NOKI_DROP = 14

export type KeyGuide = 'off' | 'hints' | 'keyboard'
export type NokiPlacement = 'line' | 'corner' | 'hidden'
export type LayoutMode = 'highway' | 'letters'

export interface LayoutOptions {
  keyGuide?: KeyGuide
  nokiPlacement?: NokiPlacement
  stageView?: boolean
  mode?: LayoutMode
}

export class Layout {
  readonly winW: number
  readonly winH: number
  readonly keyGuide: KeyGuide
  readonly nokiPlacement: NokiPlacement
  readonly stageView: boolean
  readonly mode: LayoutMode

  /** design → device scale */
  readonly s: number
  readonly ox: number
  readonly oy: number
  /** design y of the window's top edge (≤ 0) */
  readonly top: number
  /** design x of the window's left edge (≤ 0) */
  readonly left: number
  /** design x of the window's right edge (≥ 1920) */
  readonly right: number
  /** design y of the window's bottom edge (≥ 1080) */
  readonly bottom: number

  constructor(winW: number, winH: number, opts: LayoutOptions = {}) {
    this.winW = winW
    this.winH = winH
    this.keyGuide = opts.keyGuide ?? 'off'
    this.nokiPlacement = opts.nokiPlacement ?? 'line'
    this.stageView = opts.stageView ?? false
    this.mode = opts.mode ?? 'highway'

    const sx = winW / DESIGN_W
    const sy = winH / DESIGN_H
    this.s = Math.min(sx, sy)
    const extraW = winW - DESIGN_W * this.s   // > 0 when wider than 16:9
    const extraH = winH - DESIGN_H * this.s   // > 0 when taller than 16:9
    this.ox = extraW / 2
    // the Highway is bottom-aligned (the slot line and the word block keep their
    // place, the fall gets longer); the Letters field is centred
    this.oy = this.mode === 'letters' ? extraH / 2 : extraH
    this.left = -this.ox / this.s
    this.right = DESIGN_W - this.left
    this.top = -this.oy / this.s
    this.bottom = (winH - this.oy) / this.s
  }

  // ── conversions ──────────────────────────────────────────────────────────
  X(x: number): number { return Math.round(this.ox + x * this.s) }
  Y(y: number): number { return Math.round(this.oy + y * this.s) }
  S(v: number): number { return Math.max(1, Math.round(v * this.s)) }
  Sf(v: number): number { return v * this.s }

  // ── highway geometry (design units) ──────────────────────────────────────
  get slotY(): number { return this.keyGuide === 'keyboard' ? SLOT_Y_WITH_KEYBOARD : SLOT_Y }
  get spawnY(): number { return this.top - SPAWN_MARGIN }
  get fallPx(): number { return this.slotY - this.spawnY }

  laneCenter(lane: number): number { return LANE_CENTERS[Math.max(0, Math.min(3, lane))] }
  laneX0(lane: number): number { return HIGHWAY_X0 + lane * LANE_W }

  get orbR(): number { return Math.trunc(ORB_R * (this.stageView ? 1.35 : 1.0)) }
  get slotRingR(): number { return Math.trunc(SLOT_RING_R * (this.stageView ? 1.35 : 1.0)) }

  // ── word block ───────────────────────────────────────────────────────────
  get wordY(): number { return this.keyGuide !== 'keyboard' ? 932 : 1000 }
  get wordSize(): number { return this.keyGuide !== 'keyboard' ? 72 : 52 }
  get wordAdvance(): number { return this.keyGuide !== 'keyboard' ? 80 : 58 }

  /** (centre y, font px, alpha) for the three stacked next words: larger, fainter. */
  get queueRows(): [number, number, number][] {
    if (this.keyGuide === 'keyboard') return [[1058, 26, 0.26]]
    return [[996, 40, 0.30], [1034, 34, 0.20], [1066, 28, 0.13]]
  }

  // ── HUD anchors, pinned to the window's corners ──────────────────────────
  get SCORE_POS(): [number, number] { return [this.left + 40, this.top + 92] }
  get MULT_POS(): [number, number] { return [this.left + 40, this.top + 134] }
  get RUSH_BAR(): [number, number, number, number] { return [this.left + 40, this.top + 154, 240, 12] }
  get LIVES_POS(): [number, number] { return [this.left + 48, this.top + 192] }
  get ACC_POS(): [number, number] { return [this.right - 40, this.top + 92] }
  get COMBO_POS(): [number, number] { return [HIGHWAY_CX, 540 + this.top * 0.5] }

  static readonly PROGRESS_H = 5

  /** x, y, w, h in design units: centred in the left column, feet on the slot line. */
  get nokiRect(): [number, number, number, number] {
    const h = NOKI_H
    const w = NOKI_W
    const x = Math.trunc((this.left + HIGHWAY_X0) / 2 - w / 2)
    if (this.nokiPlacement === 'corner') return [x, DESIGN_H - h - 8, w, h]
    return [x, this.slotY - h + NOKI_DROP, w, h]
  }
}
