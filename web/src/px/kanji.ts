/**
 * The kanji a heavy blow stamps behind the enemy — 拳 岩 潰 … — the way an
 * anime cut does: the face pops in a pixel high for two frames, holds, and
 * blinks out.  The 48 px face for the heavy moves, the 24 px one for the
 * shouts.  Shared by the play screens and the move gallery.
 */
import { Container, Sprite } from 'pixi.js'
import type { PxAssets } from './assets'

const INK = 0x17181a

interface Kanji { name: string; color: number; x: number; y: number; t0: number; big: boolean }

export class KanjiLayer {
  readonly container = new Container()
  private kanjis: Kanji[] = []
  private sprites: [Sprite, Sprite][] = []

  constructor(private assets: PxAssets) {}

  push(name: string, color: number, x: number, y: number, t0: number, big: boolean): void {
    this.kanjis.push({ name, color, x, y, t0, big })
  }

  /** `white`: the world is whited out and every figure is drawn black */
  draw(t: number, white = false): void {
    for (const [a, b] of this.sprites) { a.visible = false; b.visible = false }
    let i = 0
    this.kanjis = this.kanjis.filter((k) => {
      const age = t - k.t0
      const dur = k.big ? 0.55 : 0.4
      if (age > dur || age < 0) return age < 0
      let pair = this.sprites[i]
      if (!pair) {
        const sh = new Sprite(); sh.anchor.set(0.5); sh.roundPixels = true; sh.tint = INK
        const sp = new Sprite(); sp.anchor.set(0.5); sp.roundPixels = true
        this.container.addChild(sh, sp)
        pair = [sh, sp]
        this.sprites.push(pair)
      }
      i += 1
      const [sh, sp] = pair
      const tex = this.assets.ui(`${k.big ? 'k48' : 'k24'}_${k.name}`)
      sh.texture = sp.texture = tex
      const blink = age > dur * 0.7 && Math.floor(age * 24) % 2 === 1
      sh.visible = sp.visible = !blink
      sp.tint = white ? INK : k.color
      const pop = age < 0.05 ? -1 : 0
      sp.x = k.x; sp.y = k.y + pop
      sh.x = k.x + 2; sh.y = k.y + 2 + pop
      sh.visible = sh.visible && !white
      return true
    })
  }

  clear(): void {
    this.kanjis = []
    for (const [a, b] of this.sprites) { a.visible = false; b.visible = false }
  }
}
