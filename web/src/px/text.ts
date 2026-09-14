/**
 * Bitmap text in the baked pixel fonts.
 *
 * `tools/pixel_pack.py` writes each font as an AngelCode .fnt at its native
 * size (8 px, 16 px …) with 1-bit glyphs, and `PxAssets.load` registers them.
 * A label is drawn at exactly that size — never scaled — and positioned on
 * whole pixels.
 */
import { BitmapText } from 'pixi.js'

export type PxFont = 'px8' | 'px16' | 'soft16' | 'soft32'

const SIZE: Record<PxFont, number> = { px8: 8, px16: 16, soft16: 16, soft32: 32 }

export function pxText(font: PxFont, text = '', tint = 0xffffff): BitmapText {
  const t = new BitmapText({ text, style: { fontFamily: font, fontSize: SIZE[font] } })
  t.anchor.set(0.5)
  t.tint = tint
  t.roundPixels = true
  return t
}

/** the width one character advances, for laying letters out by hand */
export function advance(font: PxFont): number {
  return SIZE[font]
}
