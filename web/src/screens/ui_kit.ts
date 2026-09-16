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

export interface BoxStyle {
  face: string; hi: string; lo: string
  /** the frame band inside the outline: its width and colours (none = a plain box) */
  frame?: { w: number; face: string; hi: string; lo: string }
  ink?: string; shadow?: number; r?: number
}

/**
 * Paint a shaded box of `w`×`h` at (`ox`,`oy`) on `ctx`, from the outside in:
 * the drop shadow, the ink outline, a frame band (lit on the top and left,
 * dark on the right and bottom, so the panel reads as a slab with an edge),
 * then the face with one pixel of highlight up the top and left and a shade
 * down the right that doubles along the bottom.
 */
export function paintBox(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number, s: BoxStyle): void {
  const r = s.r ?? 5
  const m = roundMask(w, h, r)
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && m[y][x]
  const put = (x: number, y: number, c: string): void => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1) }
  const sh = s.shadow ?? 2
  if (sh > 0) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y][x] && !on(x, y - sh)) put(x, y + sh, KIT.shadow)
  // how deep each cell is: peeled a ring at a time
  const level: number[][] = m.map((row) => row.map((v) => (v ? -1 : -2)))
  let ring = m.map((row) => row.slice())
  for (let L = 0; ; L++) {
    let any = false
    const next = ring.map((row) => row.slice())
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!ring[y][x]) continue
      const edge = !(x > 0 && ring[y][x - 1]) || !(x < w - 1 && ring[y][x + 1]) || !(y > 0 && ring[y - 1][x]) || !(y < h - 1 && ring[y + 1][x])
      if (edge) { level[y][x] = L; next[y][x] = false; any = true }
    }
    ring = next
    if (!any) break
  }
  // which way is out: the shade goes on the side nearer the bottom and right
  const steps = (x: number, y: number, dx: number, dy: number): number => { let n = 0; while (on(x + dx * (n + 1), y + dy * (n + 1))) n++; return n }
  const fw = s.frame?.w ?? 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y][x]) continue
    const L = level[y][x]
    if (L === 0) { put(x, y, s.ink ?? KIT.ink); continue }
    const down = steps(x, y, 0, 1), right = steps(x, y, 1, 0), up = steps(x, y, 0, -1), left = steps(x, y, -1, 0)
    const lo = Math.min(down, right) < Math.min(up, left)
    if (s.frame && L <= fw) {
      // a glint along the top-left of the band, the dark side along the bottom-right
      put(x, y, lo ? (L === fw ? s.frame.lo : s.frame.lo) : L === 1 ? s.frame.hi : s.frame.face)
      continue
    }
    const inner = L - fw
    if (inner === 1) put(x, y, lo ? s.lo : s.hi)
    else if (inner === 2 && down < Math.min(up, left, right + 1)) put(x, y, s.lo)
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
  const pad = Math.max(2, s.shadow ?? 2)
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
  const lavBand = { w: 1, face: KIT.lav, hi: KIT.lavHi, lo: KIT.lavLo }
  const cream: BoxStyle = { face: KIT.cream, hi: KIT.creamHi, lo: KIT.creamLo, frame: lavBand }
  const lav: BoxStyle = { face: KIT.lav, hi: KIT.lavHi, lo: KIT.lavLo, frame: { w: 1, face: KIT.lavLo, hi: KIT.lavHi, lo: KIT.purpleLo } }
  const purple: BoxStyle = { face: KIT.purple, hi: KIT.purpleHi, lo: KIT.purpleLo, frame: { w: 1, face: KIT.purpleLo, hi: KIT.purpleHi, lo: '#4d3270' } }
  // the panel: a three-pixel lavender frame round the cream, standing on a three-pixel shadow
  root.setProperty('--kit-panel', boxImage(28, { ...cream, r: 7, shadow: 3, frame: { w: 3, face: KIT.lav, hi: KIT.lavHi, lo: KIT.lavLo } }))
  root.setProperty('--kit-panel-lav', boxImage(28, { ...lav, r: 7, shadow: 3, frame: { w: 3, face: KIT.lavLo, hi: KIT.lavHi, lo: KIT.purpleLo } }))
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
