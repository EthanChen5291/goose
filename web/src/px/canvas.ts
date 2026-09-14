/**
 * The pixel buffer: the whole game draws into a small texture, and that texture
 * is put on screen at a whole-number scale.
 *
 * This is the one rule that keeps pixel art honest.  A sprite drawn at 1:1 into
 * a 384×216 buffer and shown at 5× has every pixel exactly 5 screen pixels wide;
 * the same sprite scaled 5.3× directly would have some pixels 5 wide and some 6,
 * which is the "mismatch" that makes upscaled pixel art look wrong.
 *
 * The scale is picked from the window, and the *buffer* takes whatever size is
 * left over — so the game always fills the window edge to edge (no letterbox)
 * and only the field of view changes slightly between screens.  Around 216 rows
 * is the target: the goose is 28 of them, the skeleton 46, a note 17.
 */
import { Container, RenderTexture, Sprite } from 'pixi.js'
import type { Renderer } from 'pixi.js'

/** the buffer height the scale is chosen to approach */
const TARGET_H = 216
const TARGET_W = 384
/** never let the buffer get smaller than this; drop a scale step instead */
const MIN_W = 320
const MIN_H = 180

export class PixelCanvas {
  /** everything in the game lives here, in game pixels */
  readonly world = new Container()
  /** the buffer, shown on the real stage */
  readonly view = new Sprite()
  /** game pixels */
  w = 0
  h = 0
  /** device pixels per game pixel */
  scale = 1
  private rt: RenderTexture | null = null
  private dpr = 1

  constructor(private renderer: Renderer) {
    this.view.roundPixels = true
  }

  /**
   * Fit the buffer to a window.  `cssW/cssH` are CSS pixels, `dpr` the device
   * ratio — the scale is chosen in *device* pixels so a Retina display gets
   * twice the integer steps.  Returns true when the buffer size changed.
   */
  resize(cssW: number, cssH: number, dpr: number): boolean {
    this.dpr = dpr
    const devW = Math.round(cssW * dpr)
    const devH = Math.round(cssH * dpr)
    let scale = Math.max(1, Math.round(Math.min(devW / TARGET_W, devH / TARGET_H)))
    while (scale > 1 && (devW / scale < MIN_W || devH / scale < MIN_H)) scale -= 1
    const w = Math.ceil(devW / scale)
    const h = Math.ceil(devH / scale)
    const changed = w !== this.w || h !== this.h || scale !== this.scale
    this.scale = scale
    this.w = w
    this.h = h
    if (changed) {
      this.rt?.destroy(true)
      this.rt = RenderTexture.create({ width: w, height: h, scaleMode: 'nearest', resolution: 1, antialias: false })
      this.view.texture = this.rt
    }
    // the view is in CSS pixels on the real stage
    this.view.scale.set(scale / dpr)
    this.view.x = 0
    this.view.y = 0
    return changed
  }

  /** Draw the world into the buffer.  The caller then renders the real stage. */
  render(): void {
    if (!this.rt) return
    this.renderer.render({ container: this.world, target: this.rt, clear: true })
  }

  get devicePixelRatio(): number { return this.dpr }

  destroy(): void {
    this.rt?.destroy(true)
    this.rt = null
    this.world.destroy({ children: true })
  }
}
