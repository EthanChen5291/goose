/**
 * What a play renderer owes the session.
 *
 * `play.py` calls the renderer through `hasattr` checks — `if hasattr(self.renderer,
 * "on_anchor_complete")` — because the Highway and the Letters field grew different
 * method sets.  Naming the contract instead means the compiler catches a renderer
 * that forgets one, and the session stops asking questions at runtime.
 */
import type { Container, Texture } from 'pixi.js'
import type { Layout } from '../core/layout'
import type { ChartMeta } from '../core/models'
import type { LiveEvent } from '../core/rhythm'

export interface PlayRenderer {
  readonly stage: Container
  /** Letters mode fails the run when HP hits zero; the Highway never does. */
  readonly failed: boolean

  setSections(meta: ChartMeta): void
  setDuets(spans: ChartMeta['duets']): void
  setLayout(layout: Layout): void
  setNokiSheet(base: Texture, info: { frames: number; w: number; h: number }): void

  onHit(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void
  onMiss(ev: LiveEvent, t: number): void
  onSlip(ev: LiveEvent, pressed: string, t: number): void
  onTooEarly(ev: LiveEvent, t: number): void
  onWordComplete(word: string, clean: boolean, t: number): void
  onHoldStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void
  onHoldComplete(ev: LiveEvent, judgment: string, t: number): void
  onAnchorStart(ev: LiveEvent, judgment: string, offsetMs: number, t: number): void
  onAnchorComplete(ev: LiveEvent, judgment: string, t: number): void
  onAnchorBreak(ev: LiveEvent, t: number): void

  tryRush(t: number): boolean
  rushActive(t: number): boolean
  draw(t: number, dt: number): void
  destroy(): void
}
