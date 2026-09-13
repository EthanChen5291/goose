/**
 * The texture cache: every round thing the Highway draws, baked once.
 *
 * The pygame build bakes surfaces because compositing them per frame costs CPU,
 * and last week's pass added a 32-step alpha cache and eight pre-baked pulse
 * levels on top, because `set_alpha` + blit was the single most expensive
 * steady-state item.  None of that is needed here: a GPU sprite's `alpha`,
 * `tint` and `scale` are free.  So this bakes *shape* only — one texture per
 * (radius, kind) — and the renderer varies colour and opacity per frame.
 *
 * Textures are drawn at device resolution and at a generous supersample so an
 * orb's edge stays smooth when the window is larger than the design size.
 */
import { Container, Graphics, Renderer, Texture } from 'pixi.js'

export interface OrbSizes {
  /** design-unit orb radius, already scaled to device px */
  r: number
  ringR: number
}

export class TextureCache {
  private cache = new Map<string, Texture>()

  constructor(private renderer: Renderer) {}

  clear(): void {
    for (const t of this.cache.values()) t.destroy(true)
    this.cache.clear()
  }

  /** A four-petal sparkle used to mark a word's first letter. */

  private bake(key: string, build: () => Container | Graphics): Texture {
    const hit = this.cache.get(key)
    if (hit) return hit
    const node = build()
    const tex = this.renderer.generateTexture({
      target: node,
      resolution: 2,
      antialias: true,
    })
    node.destroy(true)
    this.cache.set(key, tex)
    return tex
  }

  /** The white disk of an orb.  Colour comes from the sprite's tint. */
  body(r: number): Texture {
    return this.bake(`body:${r}`, () =>
      new Graphics().circle(r, r, r).fill({ color: 0xffffff }))
  }

  /** The thin lane-coloured ring just outside the body. */
  ring(r: number, width: number): Texture {
    const pad = width + 2
    return this.bake(`ring:${r}:${width}`, () =>
      new Graphics()
        .circle(r + pad, r + pad, r)
        .stroke({ width, color: 0xffffff, alignment: 0.5 }))
  }

  /** The soft halo behind a strong-beat orb: a tight falloff around the body. */
  halo(): Texture {
    return this.radial(256, 0.25, 2.6)
  }

  /** A filled ring used for the slot rings and the expanding burst rings. */
  annulus(r: number, width: number): Texture {
    const pad = width + 2
    return this.bake(`annulus:${r}:${width}`, () =>
      new Graphics()
        .circle(r + pad, r + pad, r)
        .stroke({ width, color: 0xffffff, alignment: 0.5 }))
  }

  /**
   * The press burst: a star of thin spokes.
   *
   * The pygame build rebuilt this per fade step, 4 ms each, which is what made a
   * dense bar stutter; here one texture per radius fades by changing `alpha`.
   */
  star(r: number, spokes = 12): Texture {
    return this.bake(`star:${r}:${spokes}`, () => {
      const g = new Graphics()
      const c = r
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2
        const inner = r * 0.18
        const w = Math.max(1, r * 0.055)
        const x0 = c + Math.cos(a) * inner
        const y0 = c + Math.sin(a) * inner
        const x1 = c + Math.cos(a) * r
        const y1 = c + Math.sin(a) * r
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: w, color: 0xffffff, cap: 'round' })
      }
      g.circle(c, c, r * 0.22).fill({ color: 0xffffff, alpha: 0.9 })
      return g
    })
  }

  /** A soft round glow, for the ribbons, the current letter and the drop flash. */
  glow(): Texture {
    return this.radial(512, 0, 1.8)
  }

  /** A vertical capsule: the hold tail. */
  capsule(w: number): Texture {
    return this.bake(`capsule:${w}`, () =>
      new Graphics().roundRect(0, 0, w, w * 4, w / 2).fill({ color: 0xffffff }))
  }

  /** A small four-point sparkle: the petal marking a word's first letter. */
  petal(r: number): Texture {
    return this.bake(`petal:${r}`, () => {
      const g = new Graphics()
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2
        g.ellipse(r + Math.cos(a) * r * 0.42, r + Math.sin(a) * r * 0.42, r * 0.5, r * 0.3)
          .fill({ color: 0xffffff, alpha: 0.85 })
      }
      return g
    })
  }

  /**
   * A smooth radial falloff, baked once on a 2D canvas.
   *
   * Stacked translucent circles band visibly at this size — the airbrush bloom
   * behind the highway showed ten hard rings.  A canvas gradient interpolates in
   * the rasteriser instead, so the bloom is smooth at any scale, and the sprite
   * is tinted and scaled per frame for free.
   */
  radial(size = 512, inner = 0.0, gamma = 2.2): Texture {
    const key = `radial:${size}:${inner}:${gamma}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, (size / 2) * inner,
                                       size / 2, size / 2, size / 2)
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const k = i / steps
      g.addColorStop(k, `rgba(255,255,255,${(1 - k) ** gamma})`)
    }
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const tex = Texture.from(cv)
    this.cache.set(key, tex)
    return tex
  }

  /** A one-pixel white square: scaled into every line, bar and rectangle. */
  get pixel(): Texture {
    return this.bake('pixel', () => new Graphics().rect(0, 0, 8, 8).fill({ color: 0xffffff }))
  }
}
