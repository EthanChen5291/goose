/**
 * The backdrop: a pre-composed grassland scene, its layers apart so they can
 * parallax, and everything the song does to it.
 *
 * Passively the scene is never still: the light drifts through a slow cycle of
 * warm and cool casts (stepped, like palette swaps), birds cross the sky by day,
 * fireflies blink over the grass at night.  Actively the chart shifts it — a
 * night tint for a Duo phrase, lightning for a pattern phrase, black for the
 * quiet ones, and on the big moments a *shift*: purple- or red-tinted shading
 * for a phrase, a sky full of rays, or the white-out where the world goes
 * white and everything in it goes black.  A white flash on a drop.
 *
 * Scenes are built offline by `tools/pixel_pack.py` (never per run) and picked
 * per level.  Each layer is 640 px wide and tiles; the scene is anchored to the
 * bottom of the pixel buffer so the ground is always where the ground is, and
 * a taller buffer simply shows more sky.
 */
import { Container, Graphics, TilingSprite } from 'pixi.js'
import type { PxAssets, SceneInfo } from './assets'

export type SceneMode = 'day' | 'night' | 'void'
/** the active shifts a chart moment can ask for */
export type SceneShift = 'purple' | 'red' | 'rays' | 'white' | 'gold'

const SHIFT_TINT: Record<string, [number, number]> = {
  purple: [0x5a2d9c, 0.38],
  red: [0xa01c2c, 0.36],
  gold: [0xc98a1c, 0.28],
}
/** the passive cast cycle: a dozen steps, warm through neutral to cool and back */
const DRIFT = [0xff9a5a, 0xffb36a, 0xffd28a, 0xfff0b0, 0xffffff, 0xd8ecff, 0xb8d8ff, 0xa8c8ff,
               0xb8d8ff, 0xd8ecff, 0xffffff, 0xffd28a]

interface Bird { x: number; y: number; speed: number; phase: number }

export class PixelScene {
  readonly container = new Container()
  private layers: { sprite: TilingSprite; depth: number }[] = []
  private drift = new Graphics()
  private tint = new Graphics()
  private raysGfx = new Graphics()
  private decor = new Graphics()
  private flashGfx = new Graphics()
  private info: SceneInfo | null = null
  private w = 0
  private h = 0
  private scroll = 0
  mode: SceneMode = 'day'
  /** 0..1 how dark the night tint is right now */
  private darkK = 0
  private darkTarget = 0
  private flashUntil = -9
  private flashA = 0
  /** the active shift, if one is on */
  private shiftKind: SceneShift | null = null
  private shiftT0 = -9
  private shiftUntil = -9
  private birds: Bird[] = []
  private fireflies: [number, number, number][] = []
  private rng = Math.random

  constructor(private assets: PxAssets) {
    this.container.addChild(this.drift, this.decor, this.tint, this.raysGfx, this.flashGfx)
  }

  set(id: string): void {
    this.info = this.assets.scene(id)
    for (const l of this.layers) l.sprite.destroy()
    this.layers = []
    // layers go under the drift, the decor, the tint and the flash
    for (const layer of this.info.layers) {
      const tex = this.assets.layerTexture(layer)
      const s = new TilingSprite({ texture: tex, width: this.w || tex.width, height: tex.height })
      s.roundPixels = true
      this.container.addChildAt(s, this.layers.length)
      this.layers.push({ sprite: s, depth: layer.depth })
    }
    this.layout(this.w, this.h)
  }

  get sceneInfo(): SceneInfo | null { return this.info }

  /** game-pixel y of the ground the characters stand on */
  get groundY(): number {
    if (!this.info) return this.h - 48
    return this.h - this.info.h + this.info.groundY
  }

  layout(w: number, h: number): void {
    this.w = w
    this.h = h
    if (!this.info) return
    for (const l of this.layers) {
      l.sprite.width = w
      l.sprite.height = this.info.h
      l.sprite.x = 0
      l.sprite.y = h - this.info.h
    }
    if (!this.birds.length) {
      for (let i = 0; i < 3; i++) this.birds.push({ x: this.rng() * w, y: 12 + this.rng() * 30, speed: 6 + this.rng() * 6, phase: this.rng() * 7 })
    }
    if (!this.fireflies.length) {
      for (let i = 0; i < 14; i++) this.fireflies.push([this.rng() * w, 0, this.rng() * 7])
    }
  }

  /** the phrase kind decides the look: Duo phrases go to night, quiet ones to black */
  setMode(m: SceneMode): void {
    this.mode = m
    this.darkTarget = m === 'night' ? 0.55 : 0
  }

  flash(t: number, seconds: number, alpha: number): void {
    this.flashUntil = t + seconds
    this.flashA = alpha
  }

  /** an active shift for `seconds`: purple or red shading, rays, or the white-out */
  shift(kind: SceneShift, t: number, seconds: number): void {
    this.shiftKind = kind
    this.shiftT0 = t
    this.shiftUntil = t + seconds
  }

  /** the shift on right now, or null */
  activeShift(t: number): SceneShift | null {
    return t < this.shiftUntil ? this.shiftKind : null
  }

  /** true while the world is white and everything in it should be drawn black */
  whiteOut(t: number): boolean { return this.activeShift(t) === 'white' }

  update(t: number, dt: number, energy: number): void {
    const white = this.whiteOut(t)
    // a slow drift, faster in loud bars; whole pixels per layer
    this.scroll += dt * (3 + 6 * energy)
    for (const l of this.layers) {
      l.sprite.tilePosition.x = -Math.round(this.scroll * l.depth)
      l.sprite.visible = this.mode !== 'void' && !white
    }
    // the passive cast: one step every two seconds through the cycle
    this.drift.clear()
    if (this.mode === 'day' && !white) {
      const step = Math.floor(t / 2) % DRIFT.length
      this.drift.rect(0, 0, this.w, this.h).fill({ color: DRIFT[step], alpha: 0.09 })
    }
    this.drawDecor(t, white)
    // the tint steps in and out over a few frames rather than sliding
    const step = dt * 6
    if (this.darkK < this.darkTarget) this.darkK = Math.min(this.darkTarget, this.darkK + step)
    else if (this.darkK > this.darkTarget) this.darkK = Math.max(this.darkTarget, this.darkK - step)
    this.tint.clear()
    if (this.mode === 'void') {
      this.tint.rect(0, 0, this.w, this.h).fill({ color: 0x000000 })
    } else if (white) {
      this.tint.rect(0, 0, this.w, this.h).fill({ color: 0xffffff })
    } else {
      if (this.darkK > 0.01) {
        // quantised to eighths so the fade is a few hard steps, like a palette swap
        const k = Math.round(this.darkK * 8) / 8
        this.tint.rect(0, 0, this.w, this.h).fill({ color: 0x0a0c2a, alpha: k })
      }
      const sh = this.activeShift(t)
      if (sh && SHIFT_TINT[sh]) {
        const [c, a] = SHIFT_TINT[sh]
        // the last half second steps out in four
        const left = this.shiftUntil - t
        const k = left < 0.5 ? Math.round((left / 0.5) * 4) / 4 : 1
        this.tint.rect(0, 0, this.w, this.h).fill({ color: c, alpha: a * k })
      }
    }
    this.drawRays(t)
    this.flashGfx.clear()
    if (t < this.flashUntil) {
      this.flashGfx.rect(0, 0, this.w, this.h).fill({ color: 0xffffff, alpha: this.flashA })
    }
  }

  /** a sky full of rays: wedges from above the top edge, turning a step every quarter second */
  private drawRays(t: number): void {
    const g = this.raysGfx
    g.clear()
    if (this.activeShift(t) !== 'rays') return
    const cx = Math.round(this.w / 2), cy = -20
    const n = 12
    const turn = Math.floor((t - this.shiftT0) / 0.25) * (Math.PI / 48)
    const R = this.w + this.h
    const left = this.shiftUntil - t
    const a = left < 0.5 ? Math.round((left / 0.5) * 3) / 3 * 0.16 : 0.16
    for (let i = 0; i < n; i++) {
      const a0 = turn + (i / n) * Math.PI * 2
      const a1 = a0 + (Math.PI / n) * 0.9
      g.poly([cx, cy, Math.round(cx + Math.cos(a0) * R), Math.round(cy + Math.sin(a0) * R),
              Math.round(cx + Math.cos(a1) * R), Math.round(cy + Math.sin(a1) * R)])
        .fill({ color: 0xfff4c8, alpha: a })
    }
  }

  /** birds by day, fireflies by night: a few pixels each, never still */
  private drawDecor(t: number, white: boolean): void {
    const g = this.decor
    g.clear()
    if (this.mode === 'void' || white) return
    if (this.mode === 'day') {
      for (const b of this.birds) {
        const x = Math.round((b.x + t * b.speed) % (this.w + 40)) - 20
        const y = Math.round(b.y + Math.sin(t * 0.7 + b.phase) * 3)
        const up = Math.floor((t + b.phase) * 4) % 2 === 0
        // a 5-px bird: two wings, up or down
        g.rect(x, y, 1, 1).fill({ color: 0x2a2a3a })
        g.rect(x + 1, y + (up ? -1 : 1), 1, 1).fill({ color: 0x2a2a3a })
        g.rect(x - 1, y + (up ? -1 : 1), 1, 1).fill({ color: 0x2a2a3a })
        g.rect(x + 2, y + (up ? -2 : 1), 1, 1).fill({ color: 0x2a2a3a })
        g.rect(x - 2, y + (up ? -2 : 1), 1, 1).fill({ color: 0x2a2a3a })
      }
    } else {
      const gy = this.groundY
      for (const [fx, , ph] of this.fireflies) {
        const on = Math.sin(t * 1.6 + ph) > 0.55
        if (!on) continue
        const x = Math.round((fx + Math.sin(t * 0.4 + ph) * 6) % this.w)
        const y = Math.round(gy - 6 - ((Math.sin(t * 0.3 + ph * 2) + 1) * 14))
        g.rect(x, y, 1, 1).fill({ color: 0xfff08a })
      }
    }
  }
}
