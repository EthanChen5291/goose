/**
 * Where the hit circles are — and what happens when that changes mid-song.
 *
 * The highway has always been four circles, one per hand zone of the keyboard.
 * A chart can now ask for two other shapes, and the change is the point: the
 * screen rearranging under you is what tells you the rules just moved, the way a
 * Geometry Dash portal does.
 *
 *     lanes       four circles, one per hand zone          (the default)
 *     columns     three circles, one per keyboard row      — same words, regrouped
 *     onecircle   one circle, and the chart has collapsed
 *                 its alphabet to d f j k to match
 *
 * `columns` changes nothing about the notes, so any chart can be shown that way.
 * `onecircle` only makes sense where the chart was written for it, which is why
 * `charting/sections.py` places both and ships them in `meta.stages`.
 *
 * The transition is two halves of half a second: the circles you had slide to the
 * middle and shrink away, then the ones you are getting grow back out. Notes in
 * flight move with them, so nothing jumps.
 */
import { HIGHWAY_CX, LANE_CENTERS } from '../core/layout'
import * as KB from '../core/keyboard'

export type FieldMode = 'lanes' | 'columns' | 'onecircle'

/** how long the circles take to rearrange */
export const SWAP_SECONDS = 0.5

/** rows of the keyboard, top to bottom, as `KB.rowOf` numbers them */
const ROW_SPREAD = 520

/** ease-in-out: the circles leave and arrive slowly and cross the middle fast */
function ease(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2
}

/** The design-space x of every circle in a mode, left to right. */
export function slotXs(mode: FieldMode): number[] {
  if (mode === 'onecircle') return [HIGHWAY_CX]
  if (mode === 'columns') return [0, 1, 2].map((i) => HIGHWAY_CX + (i - 1) * ROW_SPREAD)
  return [...LANE_CENTERS]
}

/** Which circle a character belongs to in a mode. */
export function slotOf(ch: string, mode: FieldMode): number {
  if (mode === 'onecircle') return 0
  if (mode === 'columns') return Math.max(0, Math.min(2, KB.rowOf(ch)))
  return KB.laneOf(ch)
}

/**
 * The playfield as it stands this frame: which mode, and how far through a swap.
 *
 * Kept as its own object so the renderer asks it for positions rather than
 * computing lane geometry in four places.
 */
export class Playfield {
  mode: FieldMode = 'lanes'
  private prev: FieldMode = 'lanes'
  private swapT = -99

  /** stages from the chart, in chart time */
  private stages: [number, number, string][] = []

  setStages(stages: [number, number, string][], leadIn: number): void {
    this.stages = stages.map(([a, b, k]) => [a + leadIn, b + leadIn, k])
  }

  /** The mode the chart asks for at `t`. */
  modeAt(t: number): FieldMode {
    for (const [t0, t1, kind] of this.stages) {
      if (t0 <= t && t < t1) {
        if (kind === 'onecircle') return 'onecircle'
        if (kind === 'columns') return 'columns'
      }
    }
    return 'lanes'
  }

  /** Call once a frame; starts a swap when the chart's mode changes. */
  update(t: number): void {
    const want = this.modeAt(t)
    if (want !== this.mode) {
      this.prev = this.mode
      this.mode = want
      this.swapT = t
    }
  }

  /** 0 outside a swap, else how far through it, 0..1. */
  swapProgress(t: number): number {
    const age = t - this.swapT
    if (age < 0 || age >= SWAP_SECONDS) return 0
    return age / SWAP_SECONDS
  }

  /** True for the single frame range where the circles are at their smallest. */
  atPinch(t: number): boolean {
    const p = this.swapProgress(t)
    return p > 0 && p < 1 && Math.abs(p - 0.5) < 0.08
  }

  /**
   * Where a character's circle sits this frame, in design x.
   *
   * During a swap the old position and the new one are mixed, so a note already
   * falling slides across rather than teleporting into its new column.
   */
  xOf(ch: string, t: number): number {
    const p = this.swapProgress(t)
    const to = slotXs(this.mode)[slotOf(ch, this.mode)] ?? HIGHWAY_CX
    if (p === 0) return to
    const from = slotXs(this.prev)[slotOf(ch, this.prev)] ?? HIGHWAY_CX
    return from + (to - from) * ease(p)
  }

  /**
   * The circles to draw this frame: x, scale and alpha each.
   *
   * Through the first half the outgoing set closes on the middle and shrinks; in
   * the second half the incoming set opens back out. They never overlap, so the
   * swap reads as one gesture rather than two sets fading through each other.
   */
  circles(t: number): { x: number; scale: number; alpha: number; slot: number; mode: FieldMode }[] {
    const p = this.swapProgress(t)
    if (p === 0) {
      return slotXs(this.mode).map((x, slot) => ({ x, scale: 1, alpha: 1, slot, mode: this.mode }))
    }
    const leaving = p < 0.5
    const mode = leaving ? this.prev : this.mode
    // 0 at the outside of the gesture, 1 at the pinch in the middle
    const k = leaving ? ease(p * 2) : ease((1 - p) * 2)
    return slotXs(mode).map((x, slot) => ({
      x: x + (HIGHWAY_CX - x) * k,
      scale: 1 - 0.75 * k,
      alpha: 1 - k,
      slot,
      mode,
    }))
  }
}
