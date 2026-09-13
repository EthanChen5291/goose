/**
 * The stage — everything behind the notes.
 *
 * The chart already changes how you play from phrase to phrase: words, a pattern
 * of two letters trading on the accents, a Duo phrase where one hand holds while
 * the other plays, a duet. Until now all four looked identical apart from a small
 * word at the top of the screen. Geometry Dash's idea is that the *screen* tells
 * you which mode you are in before you have to read anything, so each phrase kind
 * here gets a stage: its own palette, its own motion, its own idea of the beat.
 *
 * Four things run at once:
 *
 * **Drift** — the palette is never still. Each mode's two colours are pushed
 * around by three slow sine waves at periods that do not divide into each other,
 * so a long words section keeps moving without ever arriving anywhere. This is
 * the part the pygame build cannot have: its background is eight pre-baked
 * surfaces picked by energy, so it steps. Here it is a tint, and tint is free.
 *
 * **Parallax** — bands lie across the highway and slide toward the slot line at
 * speeds set by their depth, so the stage reads as something you are moving
 * through rather than a picture behind the notes.
 *
 * **Beat** — the bloom breathes on the beat by an amount the mode decides: a
 * pattern phrase strobes hard, a Duo phrase barely moves.
 *
 * **Portals** — a mode change is an event. A band sweeps the screen, the palette
 * crossfades behind it, and the new mode names itself. A big drop blacks the
 * stage out entirely for a beat and lets it bloom back.
 *
 * Nothing here judges anything or moves a note; `HighwayRenderer` owns those.
 * The stage is told the time, the energy and the beat, and paints.
 */
import { Container, Graphics, Sprite } from 'pixi.js'
import type { BitmapText } from 'pixi.js'
import { HIGHWAY_CX } from '../core/layout'
import type { Layout } from '../core/layout'
import type { TextureCache } from './textures'
import { label } from './text'

/** A phrase kind from the chart, or the fallback when a chart has no sections. */
export type StageMode = 'cruise' | 'strobe' | 'eclipse' | 'split' | 'void'

/** Chart phrase kinds → the stage that plays them. */
export const MODE_OF_KIND: Record<string, StageMode> = {
  words: 'cruise',
  pattern: 'strobe',
  anchor: 'eclipse',
  duet: 'split',
  // the playfield has collapsed to one circle; the stage closes in with it
  onecircle: 'strobe',
}

interface ModeSpec {
  /** what the portal card calls it */
  name: string
  /** bloom colour at rest, and at full energy */
  cool: number
  hot: number
  /** the screen outside the bloom */
  edge: number
  /** how wide the bloom sits, as a fraction of the screen's long side */
  spread: number
  /** how far the palette wanders on its own, 0..1 */
  drift: number
  /** how hard the bloom pulses on the beat, 0..1 */
  beat: number
  /** parallax band opacity, 0..1 */
  bands: number
  /** a second colour the bands and drift reach toward */
  accent: number
  /** paint the notes white and drop every lane colour */
  mono?: boolean
  /** how hard the screen shakes at full energy, in design pixels */
  shake?: number
}

const MODES: Record<StageMode, ModeSpec> = {
  // words: the house look — a broad indigo bloom that keeps moving
  cruise: { name: 'CRUISE', cool: 0x22203a, hot: 0x3a2e68, edge: 0x07060d,
            spread: 2.3, drift: 0.55, beat: 0.35, bands: 0.5, accent: 0x4a3fb0, shake: 3 },
  // pattern: two letters trading on the accents — hot, hard on the beat
  strobe: { name: 'STROBE', cool: 0x3a1c46, hot: 0x8a3a2e, edge: 0x0d0509,
            spread: 2.0, drift: 0.75, beat: 1.0, bands: 0.95, accent: 0xffb03a, shake: 7 },
  // a Duo phrase: one hand is pinned, so the stage gets out of the way
  eclipse: { name: 'ECLIPSE', cool: 0x141b34, hot: 0x2a3768, edge: 0x05070f,
             spread: 1.8, drift: 0.25, beat: 0.12, bands: 0.35, accent: 0x4a86e8 },
  // duet: two voices, so two colours
  split: { name: 'SPLIT', cool: 0x122a3a, hot: 0x2a5a6a, edge: 0x05090d,
           spread: 2.1, drift: 0.5, beat: 0.5, bands: 0.7, accent: 0xff7ad0, shake: 4 },
  // nothing at all behind the notes, and the notes go white.  It is only a look,
  // but taking every colour away for eight bars makes the next phrase land.
  void: { name: 'VOID', cool: 0x000000, hot: 0x000000, edge: 0x000000,
          spread: 1.2, drift: 0.0, beat: 0.2, bands: 0.0, accent: 0xffffff, mono: true },
}

/** the quiet phrases go dark; everything else keeps its own stage */
const VOID_VIBE = 'sustain'

const BAND_COUNT = 7
const PORTAL_SECONDS = 0.85
/** how long the stage stays black after a big drop before it blooms back */
const BLACKOUT_SECONDS = 0.16
const BLOOM_BACK_SECONDS = 0.55

function mix(a: number, b: number, k: number): number {
  const c = Math.max(0, Math.min(1, k))
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  return ((Math.round(ar + (br - ar) * c) << 16)
    | (Math.round(ag + (bg - ag) * c) << 8)
    | Math.round(ab + (bb - ab) * c))
}

export class Stage {
  readonly container = new Container()

  private L: Layout
  private tex: TextureCache

  private edge = new Graphics()
  private bloom: Sprite | null = null
  private bands: Sprite[] = []
  private portalGfx = new Graphics()
  private flash = new Graphics()
  private nameText: BitmapText

  private mode: StageMode = 'cruise'
  private prevMode: StageMode = 'cruise'
  /** when the current mode began; the crossfade runs from here */
  private portalT = -99
  private blackoutT = -99
  private blackoutSize = 1
  /** band scroll position, advanced by dt so a pause does not teleport them */
  private scroll = 0

  constructor(layout: Layout, tex: TextureCache) {
    this.L = layout
    this.tex = tex
    // `label` already anchors at the centre and scales the baked 96 px face down;
    // the per-layout size is set each frame the way the HUD does it.
    this.nameText = label('stamp', 22, 'CRUISE')
    this.nameText.alpha = 0
    this.container.addChild(this.edge)
    this.build()
    this.container.addChild(this.portalGfx, this.flash, this.nameText)
  }

  private build(): void {
    // the bloom: one baked radial falloff, tinted per frame.  A stack of
    // translucent circles bands visibly at this size, so it has to be a texture.
    this.bloom = new Sprite(this.tex.radial(512, 0, 1.4))
    this.bloom.anchor.set(0.5)
    this.container.addChild(this.bloom)

    // parallax bands: wide soft ellipses lying across the highway, each at its own
    // depth.  Near ones are brighter, wider and move faster.
    for (let i = 0; i < BAND_COUNT; i++) {
      const s = new Sprite(this.tex.radial(256, 0, 2.6))
      s.anchor.set(0.5)
      this.bands.push(s)
      this.container.addChild(s)
    }
  }

  setLayout(layout: Layout): void {
    this.L = layout
  }

  /**
   * Re-make the sprites after the texture cache is cleared, which the renderer
   * does on every resize — the old textures are gone and the sprites holding them
   * would draw nothing.
   */
  rebuild(): void {
    this.bloom?.destroy()
    this.bloom = null
    for (const b of this.bands) b.destroy()
    this.bands = []
    this.build()
    // `build` appends, so the overlays have to go back on top
    this.container.addChild(this.portalGfx, this.flash, this.nameText)
  }

  /**
   * Tell the stage which phrase kind is playing.  A change opens a portal; the
   * same kind twice running is not a change and does nothing.
   */
  setKind(kind: string, t: number, vibe = ''): void {
    // a plain words phrase over a sustain goes to VOID rather than CRUISE: the
    // song has already dropped away, so the stage does too
    const next: StageMode = kind === 'words' && vibe === VOID_VIBE
      ? 'void'
      : (MODE_OF_KIND[kind] ?? 'cruise')
    if (next === this.mode) return
    this.prevMode = this.mode
    this.mode = next
    this.portalT = t
    this.nameText.text = MODES[next].name
  }

  /** A drop big enough to take the lights out: black, then bloom back. */
  blackout(t: number, size = 1): void {
    this.blackoutT = t
    this.blackoutSize = size
  }

  /** The mode playing now — the renderer tints a few of its own pieces to match. */
  get spec(): ModeSpec {
    return MODES[this.mode]
  }

  get accent(): number {
    return MODES[this.mode].accent
  }

  /** true while the stage wants the notes drawn white and the lanes uncoloured */
  get mono(): boolean {
    return MODES[this.mode].mono === true
  }

  /**
   * How far the screen should be knocked off centre this frame, in design pixels.
   *
   * A loud phrase shakes on the beat and a drop kicks it harder.  The offset is
   * the renderer's to apply — the stage does not own the camera.
   */
  shake(t: number, energy: number, beatPulse: number): [number, number] {
    const amt = (MODES[this.mode].shake ?? 0) * Math.max(0, energy - 0.55) / 0.45
    const dropAge = t - this.blackoutT
    const kick = dropAge >= 0 && dropAge < 0.35 ? (1 - dropAge / 0.35) ** 2 * 14 * this.blackoutSize : 0
    const a = amt * beatPulse + kick
    if (a < 0.01) return [0, 0]
    // two incommensurate wobbles rather than random, so it reads as a shake and
    // not as static
    return [Math.sin(t * 97.3) * a, Math.cos(t * 61.7) * a * 0.7]
  }

  /**
   * Paint one frame.
   *
   * `energy` is the smoothed section energy 0..1, `beatPulse` how far into the
   * current beat we are as a decaying 1→0, `barP` the phase through the bar.
   */
  update(t: number, dt: number, energy: number, beatPulse: number, barP: number): void {
    const L = this.L
    const now = MODES[this.mode]
    const k = Math.min(1, 0.85 * energy)

    // ── the crossfade behind a portal ────────────────────────────────────
    const pAge = t - this.portalT
    const blend = pAge >= 0 && pAge < PORTAL_SECONDS ? pAge / PORTAL_SECONDS : 1
    const was = MODES[this.prevMode]
    const cool = mix(was.cool, now.cool, blend)
    const hot = mix(was.hot, now.hot, blend)
    const edgeCol = mix(was.edge, now.edge, blend)
    const spread = was.spread + (now.spread - was.spread) * blend
    const bandA = was.bands + (now.bands - was.bands) * blend
    const beatAmt = was.beat + (now.beat - was.beat) * blend
    const driftAmt = was.drift + (now.drift - was.drift) * blend
    const accent = mix(was.accent, now.accent, blend)

    // ── drift: three periods that do not line up, so it never repeats ────
    // Without this a words section two minutes long is a still image.
    const d1 = Math.sin(t * 0.0731) * 0.5 + 0.5
    const d2 = Math.sin(t * 0.1270 + 1.7) * 0.5 + 0.5
    const d3 = Math.sin(t * 0.0411 + 4.1) * 0.5 + 0.5
    const wander = driftAmt * 0.35
    let base = mix(cool, hot, k * (1 - wander * 0.5) + wander * d1)
    base = mix(base, accent, wander * 0.45 * d2)

    // ── blackout: the lights go out, then come back ──────────────────────
    const bAge = t - this.blackoutT
    let dark = 0
    if (bAge >= 0 && bAge < BLACKOUT_SECONDS + BLOOM_BACK_SECONDS) {
      dark = bAge < BLACKOUT_SECONDS
        ? 1
        : 1 - (bAge - BLACKOUT_SECONDS) / BLOOM_BACK_SECONDS
      dark *= this.blackoutSize
    }
    // the overshoot as it comes back: brighter than it was, for a moment
    const rebound = bAge >= BLACKOUT_SECONDS && bAge < BLACKOUT_SECONDS + BLOOM_BACK_SECONDS
      ? Math.sin((1 - dark / Math.max(1e-6, this.blackoutSize)) * Math.PI) * 0.45 * this.blackoutSize
      : 0

    this.edge.clear()
    this.edge.rect(0, 0, L.winW, L.winH).fill({ color: mix(edgeCol, 0x000000, dark) })

    // ── the bloom ────────────────────────────────────────────────────────
    const bloom = this.bloom!
    const pulse = 1 + beatAmt * 0.09 * beatPulse + rebound * 0.25
    const span = Math.max(L.winW, L.winH) * spread * pulse * (1 - 0.35 * dark)
    bloom.width = bloom.height = span
    bloom.x = L.X(HIGHWAY_CX)
    bloom.y = L.Y(L.slotY - 260)
    bloom.tint = mix(mix(base, 0x000000, dark), 0xffffff, rebound * 0.5)
    bloom.alpha = 1

    // ── parallax bands ───────────────────────────────────────────────────
    // Depth is the loop position, so a band that passes the slot line reappears
    // far away.  They are advanced by dt, not derived from t, so seeking or
    // pausing does not fling them across the screen.
    this.scroll = (this.scroll + dt * (0.06 + 0.10 * energy)) % 1
    for (let i = 0; i < this.bands.length; i++) {
      const s = this.bands[i]
      const depth = (i / this.bands.length + this.scroll) % 1
      // near the slot line when depth → 1
      const y = L.Y(L.top - 200) + (L.Y(L.slotY) - L.Y(L.top - 200)) * (depth * depth)
      s.x = L.X(HIGHWAY_CX)
      s.y = y
      s.width = L.winW * (0.45 + 1.5 * depth)
      s.height = L.S(26 + 150 * depth)
      s.alpha = bandA * 0.30 * depth * (1 - depth * 0.30) * (1 - dark) * (0.55 + 0.75 * energy)
      s.tint = mix(base, accent, 0.35 + 0.4 * d3)
    }

    // ── the portal sweep, and the mode naming itself ─────────────────────
    this.portalGfx.clear()
    if (pAge >= 0 && pAge < PORTAL_SECONDS) {
      const p = pAge / PORTAL_SECONDS
      // a bright band crossing top to bottom, thinning as it goes.  Screen pixels
      // throughout: L.Y() maps design units and winH is already a screen height, so
      // mixing the two sent the band off the bottom of the screen in a frame.
      const h = L.S(220) * (1 - p) + L.S(20)
      const yC = -h + (L.winH + 2 * h) * (p * (2 - p))
      const a = (1 - p) ** 1.4 * 0.5
      this.portalGfx.rect(0, yC - h / 2, L.winW, h).fill({ color: accent, alpha: a })
      this.portalGfx.rect(0, yC - h / 2, L.winW, L.S(3)).fill({ color: 0xffffff, alpha: a * 1.4 })
      this.nameText.x = L.X(HIGHWAY_CX)
      this.nameText.y = L.Y(L.top + 120)
      this.nameText.scale.set((L.S(30) / 96) * (1 + 0.45 * (1 - p) ** 2))
      this.nameText.alpha = Math.min(1, p * 5) * (1 - p) ** 0.7
      this.nameText.tint = accent
    } else {
      this.nameText.alpha = 0
    }

    // ── the blackout veil, over everything the stage owns ────────────────
    this.flash.clear()
    if (dark > 0.001) {
      this.flash.rect(0, 0, L.winW, L.winH).fill({ color: 0x000000, alpha: dark * 0.92 })
    }
    void barP
  }
}
