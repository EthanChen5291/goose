/**
 * The pixel UI kit: rounded, shaded boxes drawn on the fly.
 *
 * The menus are DOM inside an integer-scaled stage, so a box's corners and
 * bevels have to be real pixels, not CSS radii (which anti-alias) — they are
 * drawn here into small canvases and handed to CSS as `border-image` and
 * `background-image` data URLs on `:root`.  One look everywhere: a cream face,
 * a one-pixel ink outline in dark purple, a lavender highlight up the top and
 * left, a purple shade down the right and along the bottom, and a hard
 * two-pixel drop shadow.  Corners are cut on a pixel circle (`r` 5 for panels
 * and buttons, 4 for the small pills), which is the shape the rest of the
 * pixel world uses.
 */

export const KIT = {
  ink: '#2a1b3d',
  cream: '#f4e8cf',
  creamHi: '#fff8e6',
  creamLo: '#d9c3b0',
  lav: '#c9a6ea',
  lavHi: '#e6d0f7',
  lavLo: '#8d63bd',
  purple: '#9b6fd0',
  purpleHi: '#c39cf0',
  purpleLo: '#6a4796',
  gold: '#ffde7b',
  shadow: 'rgba(22, 10, 40, .45)',
  text: '#3b2a55',
  dim: '#8a72a8',
}

type Grid = boolean[][]

/** the cells of a `w`×`h` box with corners cut on a circle of radius `r` */
function roundMask(w: number, h: number, r: number): Grid {
  const g: Grid = []
  for (let y = 0; y < h; y++) {
    const row: boolean[] = []
    for (let x = 0; x < w; x++) {
      const cx = x < r ? x : x >= w - r ? x - (w - 2 * r) : -1
      const cy = y < r ? y : y >= h - r ? y - (h - 2 * r) : -1
      if (cx < 0 || cy < 0) { row.push(true); continue }
      const dx = cx + 0.5 - r, dy = cy + 0.5 - r
      row.push(dx * dx + dy * dy <= r * r)
    }
    g.push(row)
  }
  return g
}

export interface BoxStyle { face: string; hi: string; lo: string; ink?: string; shadow?: number; r?: number }

/**
 * Paint a shaded box of `w`×`h` at (`ox`,`oy`) on `ctx`: shadow, outline, face,
 * one pixel of highlight on the top/left, one of shade on the right and two
 * along the bottom.
 */
export function paintBox(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number, s: BoxStyle): void {
  const r = s.r ?? 5
  const m = roundMask(w, h, r)
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && m[y][x]
  const put = (x: number, y: number, c: string): void => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1) }
  const sh = s.shadow ?? 2
  if (sh > 0) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y][x] && !on(x, y - sh)) put(x, y + sh, KIT.shadow)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y][x]) continue
    const edge = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)
    if (edge) { put(x, y, s.ink ?? KIT.ink); continue }
    // the bevel: what the outline is next to
    const upEdge = !on(x, y - 2) || !on(x - 1, y - 1) || !on(x + 1, y - 1)
    const leftEdge = !on(x - 2, y) || !on(x - 1, y - 1) || !on(x - 1, y + 1)
    const downEdge = !on(x, y + 2) || !on(x, y + 3) || !on(x - 1, y + 2) || !on(x + 1, y + 2)
    const rightEdge = !on(x + 2, y) || !on(x + 1, y + 1) || !on(x + 1, y - 1)
    if (downEdge || rightEdge) put(x, y, s.lo)
    else if (upEdge || leftEdge) put(x, y, s.hi)
    else put(x, y, s.face)
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  return [c, ctx]
}

/** a box as a border-image source: `pad` transparent pixels around it hold the shadow */
function boxImage(size: number, s: BoxStyle): string {
  const pad = 2
  const [c, ctx] = canvas(size + pad * 2, size + pad * 2)
  paintBox(ctx, pad, pad, size, size, s)
  return `url(${c.toDataURL()})`
}

/** 1 = ink; the glyphs are 9×9, centred in the 16 px buttons */
const ICONS: Record<string, string[]> = {
  left: ['...1.....', '..11.....', '.111.....', '111111111', '.111.....', '..11.....', '...1.....'],
  right: ['.....1...', '.....11..', '.....111.', '111111111', '.....111.', '.....11..', '.....1...'],
  back: ['...1.....', '..11.....', '.11......', '11111111.', '.11.....1', '..11....1', '...1..111'],
  plus: ['...111...', '...111...', '...111...', '111111111', '111111111', '111111111', '...111...', '...111...', '...111...'],
  x: ['11.....11', '111...111', '.111.111.', '..11111..', '...111...', '..11111..', '.111.111.', '111...111', '11.....11'],
}

/** a 16×16 icon button, `pressed` sat down on its shadow */
function iconButton(icon: string, s: BoxStyle, pressed: boolean): string {
  const pad = 2
  const size = 16
  const [c, ctx] = canvas(size + pad * 2, size + pad * 2)
  const dy = pressed ? 2 : 0
  paintBox(ctx, pad, pad + dy, size, size, { ...s, shadow: pressed ? 0 : 2 })
  const rows = ICONS[icon] ?? []
  const gw = rows[0]?.length ?? 0, gh = rows.length
  const x0 = pad + Math.floor((size - gw) / 2), y0 = pad + dy + Math.floor((size - gh) / 2)
  ctx.fillStyle = KIT.ink
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') ctx.fillRect(x0 + x, y0 + y, 1, 1) })
  return `url(${c.toDataURL()})`
}

/** the slider knob: 7×9, cream, no bottom shade to keep it light */
function knob(pressed: boolean): string {
  const [c, ctx] = canvas(9, 11)
  paintBox(ctx, 1, 1, 7, 9, { face: pressed ? KIT.purple : KIT.cream, hi: pressed ? KIT.purpleHi : KIT.creamHi, lo: pressed ? KIT.purpleLo : KIT.creamLo, r: 3, shadow: 1 })
  return `url(${c.toDataURL()})`
}

let installed = false
/** put the kit's images on `:root` as custom properties; once per page */
export function installKit(): void {
  if (installed) return
  installed = true
  const root = document.documentElement.style
  const cream: BoxStyle = { face: KIT.cream, hi: KIT.creamHi, lo: KIT.creamLo }
  const lav: BoxStyle = { face: KIT.lav, hi: KIT.lavHi, lo: KIT.lavLo }
  const purple: BoxStyle = { face: KIT.purple, hi: KIT.purpleHi, lo: KIT.purpleLo }
  root.setProperty('--kit-panel', boxImage(20, { ...cream, r: 6 }))
  root.setProperty('--kit-panel-lav', boxImage(20, { ...lav, r: 6 }))
  root.setProperty('--kit-btn', boxImage(16, cream))
  root.setProperty('--kit-btn-lav', boxImage(16, lav))
  root.setProperty('--kit-btn-purple', boxImage(16, purple))
  root.setProperty('--kit-btn-down', boxImage(16, { ...purple, shadow: 0 }))
  root.setProperty('--kit-pill', boxImage(12, { ...cream, r: 4, shadow: 1 }))
  root.setProperty('--kit-pill-on', boxImage(12, { ...purple, r: 4, shadow: 1 }))
  root.setProperty('--kit-track', boxImage(12, { face: KIT.creamLo, hi: KIT.creamLo, lo: KIT.creamLo, r: 3, shadow: 0 }))
  root.setProperty('--kit-knob', knob(false))
  root.setProperty('--kit-knob-down', knob(true))
  for (const icon of Object.keys(ICONS)) {
    root.setProperty(`--kit-ic-${icon}`, iconButton(icon, cream, false))
    root.setProperty(`--kit-ic-${icon}-down`, iconButton(icon, purple, true))
  }
}
