/**
 * The furniture the DOM menus sit on, in game pixels.
 *
 * The play screen draws into a small buffer and shows it at a whole-number
 * scale.  The menus are DOM, so they do the same thing with CSS: a stage sized
 * in game pixels, `transform: scale(k)` with an integer k chosen exactly the way
 * `px/canvas.ts` chooses it, and every image inside `image-rendering: pixelated`.
 * A menu therefore has the same pixel size as the game it leads into.
 *
 * Also here: the scene backdrop as CSS layers (the same PNGs the game uses,
 * drifting by depth) and a sprite strip player for the characters.
 */
import type { AnimInfo, Manifest, SceneInfo } from '../px/assets'

const TARGET_W = 384
const TARGET_H = 216
const MIN_W = 320
const MIN_H = 180

export interface PxStage {
  root: HTMLElement
  stage: HTMLElement
  /** game pixels */
  w: number
  h: number
  /** called after every resize with the new size */
  onResize: (fn: (w: number, h: number) => void) => void
  stop: () => void
}

/** A full-window root with an integer-scaled stage inside it. */
export function pixelStage(): PxStage {
  const root = document.createElement('div')
  root.className = 'pxroot'
  const stage = document.createElement('div')
  stage.className = 'pxstage'
  root.appendChild(stage)
  const listeners: ((w: number, h: number) => void)[] = []
  const out: PxStage = {
    root, stage, w: TARGET_W, h: TARGET_H,
    onResize: (fn) => { listeners.push(fn); fn(out.w, out.h) },
    stop: () => window.removeEventListener('resize', fit),
  }
  const fit = (): void => {
    const dpr = window.devicePixelRatio || 1
    const devW = Math.round(window.innerWidth * dpr)
    const devH = Math.round(window.innerHeight * dpr)
    let k = Math.max(1, Math.round(Math.min(devW / TARGET_W, devH / TARGET_H)))
    while (k > 1 && (devW / k < MIN_W || devH / k < MIN_H)) k -= 1
    const w = Math.ceil(devW / k)
    const h = Math.ceil(devH / k)
    out.w = w
    out.h = h
    stage.style.width = `${w}px`
    stage.style.height = `${h}px`
    stage.style.transform = `scale(${k / dpr})`
    stage.style.setProperty('--k', String(k / dpr))
    for (const fn of listeners) fn(w, h)
  }
  fit()
  window.addEventListener('resize', fit)
  return out
}

/**
 * The scene as CSS layers, bottom-anchored, each drifting at its depth.
 * Returns the element and the game-pixel y of the ground within a stage of
 * height `h`.
 */
export function sceneBackdrop(scene: SceneInfo): { el: HTMLElement; groundY: (h: number) => number } {
  const el = document.createElement('div')
  el.className = 'pxscene'
  for (const layer of scene.layers) {
    const d = document.createElement('div')
    d.className = 'pxlayer'
    d.style.backgroundImage = `url(${layer.url})`
    d.style.height = `${scene.h}px`
    // a full loop of the 640 px layer: near layers faster
    const secs = layer.depth > 0 ? Math.round(640 / (3 * layer.depth)) : 0
    if (secs) d.style.animation = `px-drift ${secs}s linear infinite`
    el.appendChild(d)
  }
  return { el, groundY: (h) => h - scene.h + scene.groundY }
}

export interface CharStrip { el: HTMLElement; stop: () => void; setFrame: (i: number) => void }

/**
 * One character animation as an element, stepping frames on a timer.  The
 * element is the frame's size in game pixels, its bottom-centre at the feet.
 */
export function charStrip(anim: AnimInfo, feet: number, fps: number, flip = false): CharStrip {
  const el = document.createElement('div')
  el.className = 'pxstrip'
  el.style.width = `${anim.fw}px`
  el.style.height = `${anim.fh}px`
  el.style.backgroundImage = `url(${anim.url})`
  el.style.setProperty('--feet', `${feet}px`)
  if (flip) el.style.transform = 'scaleX(-1)'
  let i = 0
  const setFrame = (n: number): void => {
    i = ((n % anim.n) + anim.n) % anim.n
    el.style.backgroundPosition = `${-i * anim.fw}px 0`
  }
  setFrame(0)
  const timer = window.setInterval(() => setFrame(i + 1), 1000 / fps)
  return { el, stop: () => window.clearInterval(timer), setFrame }
}

/** the manifest, fetched once for the menus (the game loads it through PxAssets) */
let manifestP: Promise<Manifest> | null = null
export function loadManifest(): Promise<Manifest> {
  manifestP ??= fetch('px/manifest.json').then((r) => r.json() as Promise<Manifest>)
  return manifestP
}

/** an effect strip, looping — the rank symbols on the results screen */
export function fxStrip(fx: { url: string; fw: number; fh: number; n: number; fps: number }): CharStrip {
  return charStrip({ ...fx, feet: fx.fh, box: [0, 0, fx.fw, fx.fh] }, fx.fh, fx.fps)
}
