/**
 * Effect strips from the gigapack, played once and thrown away.
 *
 * Every effect is a horizontal strip at 15 fps.  One is spawned at a game-pixel
 * position, steps through its frames on the clock and vanishes on the last —
 * nothing fades, nothing scales; a pixel effect is either on a frame or gone.
 * Sprites are pooled because a dense bar can spawn a dozen a second.
 */
import { Container, Sprite } from 'pixi.js'
import type { PxAssets, Strip } from './assets'

interface Live {
  sprite: Sprite
  strip: Strip
  t0: number
  fps: number
  /** follow a moving anchor, if given */
  follow?: () => [number, number]
  dx: number
  dy: number
}

export interface FxOptions {
  /** mirror horizontally (a directional effect fired leftward) */
  flipX?: boolean
  /** whole quarter turns only */
  quarterTurns?: number
  /** play faster or slower than the pack's 15 fps */
  fps?: number
  /** anchor within the frame, 0..1 each; default centred */
  ax?: number
  ay?: number
  /** keep the effect pinned to something that moves */
  follow?: () => [number, number]
  /** start part-way in */
  startFrame?: number
}

export class FxLayer {
  readonly container = new Container()
  private live: Live[] = []
  private pool: Sprite[] = []

  constructor(private assets: PxAssets) {}

  spawn(name: string, x: number, y: number, t: number, opts: FxOptions = {}): void {
    const strip = this.assets.fx(name)
    if (!strip) { console.warn(`fx ${name} missing`); return }
    const s = this.pool.pop() ?? new Sprite()
    s.visible = true
    s.texture = strip.frames[0]
    s.anchor.set(opts.ax ?? 0.5, opts.ay ?? 0.5)
    s.scale.set(opts.flipX ? -1 : 1, 1)
    s.rotation = ((opts.quarterTurns ?? 0) % 4) * Math.PI / 2
    s.roundPixels = true
    s.x = Math.round(x)
    s.y = Math.round(y)
    this.container.addChild(s)
    const fps = opts.fps ?? strip.fps
    this.live.push({
      sprite: s, strip, fps, t0: t - (opts.startFrame ?? 0) / fps,
      follow: opts.follow, dx: 0, dy: 0,
    })
  }

  update(t: number): void {
    this.live = this.live.filter((l) => {
      const i = Math.floor((t - l.t0) * l.fps)
      if (i < 0) return true
      if (i >= l.strip.frames.length) {
        l.sprite.visible = false
        this.container.removeChild(l.sprite)
        this.pool.push(l.sprite)
        return false
      }
      l.sprite.texture = l.strip.frames[i]
      if (l.follow) {
        const [fx, fy] = l.follow()
        l.sprite.x = Math.round(fx)
        l.sprite.y = Math.round(fy)
      }
      return true
    })
  }

  clear(): void {
    for (const l of this.live) { l.sprite.visible = false; this.pool.push(l.sprite) }
    this.live = []
    this.container.removeChildren()
  }
}
