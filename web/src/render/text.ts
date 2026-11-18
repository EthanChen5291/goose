/**
 * Fonts and text.
 *
 * game/sprites.py keeps five faces — Fredoka SemiBold for the word block, HUD
 * numbers and orb glyphs, Fredoka Medium for the fainter queue rows, Atkinson
 * for small text, Archivo Black for the judgment stamps — and caches every
 * rendered string, because rasterising text per frame in pygame is ruinous.
 *
 * Here the glyphs that appear every frame (orb letters, the word block, the HUD)
 * go through a bitmap font, so they are one atlas and one draw call each, and
 * the rarely-changing strings use plain Text objects.
 */
import { Assets, BitmapFont, BitmapText, Text, TextStyle } from 'pixi.js'

export type FontKind = 'display' | 'display_regular' | 'body' | 'body_bold' | 'stamp'

const FILES: Record<FontKind, { url: string; family: string }> = {
  display: { url: 'fonts/Fredoka-SemiBold.ttf', family: 'Fredoka SemiBold' },
  display_regular: { url: 'fonts/Fredoka-Medium.ttf', family: 'Fredoka Medium' },
  body: { url: 'fonts/AtkinsonHyperlegible-Regular.ttf', family: 'Atkinson' },
  body_bold: { url: 'fonts/AtkinsonHyperlegible-Bold.ttf', family: 'Atkinson Bold' },
  stamp: { url: 'fonts/ArchivoBlack-Regular.ttf', family: 'Archivo Black' },
}

/** the characters any bitmap font needs to cover */
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?%+-×x/\'"()[]'

/** Bitmap fonts are baked at one size and scaled; this is big enough to stay crisp. */
const BAKE_PX = 96

const installed = new Set<string>()

export async function loadFonts(): Promise<void> {
  await Promise.all(
    Object.entries(FILES).map(([kind, f]) =>
      Assets.load({ src: f.url, data: { family: f.family } }).then(() => kind)),
  )
  for (const [kind, f] of Object.entries(FILES)) {
    const name = bitmapName(kind as FontKind)
    if (installed.has(name)) continue
    BitmapFont.install({
      name,
      style: { fontFamily: f.family, fontSize: BAKE_PX, fill: 0xffffff },
      chars: CHARS,
      resolution: 2,
    })
    installed.add(name)
  }
}

const bitmapName = (kind: FontKind) => `noki-${kind}`

/** A bitmap label: cheap to move, tint and fade every frame. */
export function label(kind: FontKind, px: number, text = ''): BitmapText {
  const t = new BitmapText({ text, style: { fontFamily: bitmapName(kind), fontSize: BAKE_PX } })
  t.scale.set(px / BAKE_PX)
  t.anchor.set(0.5)
  return t
}

/** Resize a bitmap label without rebuilding it. */
export function setLabelSize(t: BitmapText, px: number): void {
  t.scale.set(px / BAKE_PX)
}

/** A plain text node, for strings that change rarely (titles, tier tags). */
export function text(kind: FontKind, px: number, str: string, color = 0xffffff): Text {
  const t = new Text({
    text: str,
    style: new TextStyle({ fontFamily: FILES[kind].family, fontSize: px, fill: color }),
  })
  t.anchor.set(0.5)
  t.resolution = 2
  return t
}
