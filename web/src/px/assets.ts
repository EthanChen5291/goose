/**
 * The pixel bundle: what `tools/pixel_pack.py` wrote, loaded once.
 *
 * Every texture here is sampled nearest-neighbour and drawn at 1:1 into the
 * pixel buffer (`canvas.ts`), which is the only thing that is ever scaled — by a
 * whole number.  So a 64×64 goose frame is 64×64 game pixels, always.
 */
import { Assets, Rectangle, Texture, TextureSource } from 'pixi.js'

export interface AnimInfo {
  url: string
  fw: number
  fh: number
  n: number
  feet: number
  box: [number, number, number, number]
  fps: number
}
export interface CharInfo { feet: number; fw: number; fh: number; anims: Record<string, AnimInfo> }
export interface FxInfo { url: string; fw: number; fh: number; n: number; fps: number }
export interface FontInfo { url: string; px: number; lineHeight: number }
export interface UiInfo { url: string; w: number; h: number; x?: number; y?: number }
export interface SceneLayer { name: string; url: string; depth: number }
export interface SceneInfo {
  id: string
  mood: string
  layout: string
  w: number
  h: number
  groundY: number
  layers: SceneLayer[]
  preview: string
}
export interface Manifest {
  chars: Record<string, CharInfo>
  fx: Record<string, FxInfo>
  fonts: Record<string, FontInfo>
  ui: Record<string, UiInfo>
  scenes: SceneInfo[]
}

/** A strip of frames ready to show: the textures plus how to stand it up. */
export interface Strip {
  frames: Texture[]
  fps: number
  fw: number
  fh: number
  /** rows from the frame's top to the ground under the feet */
  feet: number
}

let singleton: PxAssets | null = null

export class PxAssets {
  private frameCache = new Map<string, Texture[]>()

  private constructor(readonly manifest: Manifest) {}

  static async load(): Promise<PxAssets> {
    if (singleton) return singleton
    // before anything is loaded: pixel art is never filtered
    TextureSource.defaultOptions.scaleMode = 'nearest'
    const manifest = (await (await fetch('px/manifest.json')).json()) as Manifest
    const urls = new Set<string>()
    for (const c of Object.values(manifest.chars)) for (const a of Object.values(c.anims)) urls.add(a.url)
    for (const f of Object.values(manifest.fx)) urls.add(f.url)
    for (const u of Object.values(manifest.ui)) urls.add(u.url)
    for (const s of manifest.scenes) for (const l of s.layers) urls.add(l.url)
    await Promise.all([
      Assets.load([...urls]),
      // the .fnt files register their face names; BitmapText finds them by name
      Assets.load(Object.values(manifest.fonts).map((f) => f.url)),
    ])
    singleton = new PxAssets(manifest)
    return singleton
  }

  private slice(key: string, url: string, fw: number, fh: number, n: number): Texture[] {
    const hit = this.frameCache.get(key)
    if (hit) return hit
    const base = Assets.get<Texture>(url)
    const out: Texture[] = []
    for (let i = 0; i < n; i++) {
      out.push(new Texture({ source: base.source, frame: new Rectangle(i * fw, 0, fw, fh) }))
    }
    this.frameCache.set(key, out)
    return out
  }

  /** Every animation a character has, as strips keyed by name. */
  char(name: string): Record<string, Strip> {
    const c = this.manifest.chars[name]
    if (!c) throw new Error(`no character ${name} in px/manifest.json`)
    const out: Record<string, Strip> = {}
    for (const [anim, a] of Object.entries(c.anims)) {
      out[anim] = {
        frames: this.slice(`${name}/${anim}`, a.url, a.fw, a.fh, a.n),
        fps: a.fps, fw: a.fw, fh: a.fh, feet: c.feet,
      }
    }
    return out
  }

  fx(name: string): Strip | null {
    const f = this.manifest.fx[name]
    if (!f) return null
    return { frames: this.slice(`fx/${name}`, f.url, f.fw, f.fh, f.n), fps: f.fps, fw: f.fw, fh: f.fh, feet: f.fh }
  }

  ui(name: string): Texture {
    const u = this.manifest.ui[name]
    if (!u) throw new Error(`no ui piece ${name}`)
    return Assets.get<Texture>(u.url)
  }

  scene(id: string): SceneInfo {
    return this.manifest.scenes.find((s) => s.id === id) ?? this.manifest.scenes[0]
  }

  layerTexture(l: SceneLayer): Texture {
    return Assets.get<Texture>(l.url)
  }
}
