/**
 * The loading screen: black, and the goose running.
 *
 * Nothing else — the Run strip at ten frames a second on a thin ground line,
 * a little dust behind the feet, "LOADING" blinking in the corner, and the
 * footstep patter looping underneath.  It stays up at least `minSecs` so it
 * reads as a beat of its own rather than a flicker.
 */
import { pixelStage, charStrip, loadManifest } from './pxchrome'
import type { CharStrip } from './pxchrome'

export interface LoadingScreen { el: HTMLElement; stop: () => void; done: Promise<void> }

export function buildLoading(sfxLoop: () => () => void, minSecs = 1.3): LoadingScreen {
  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('load-root')
  const ground = document.createElement('div')
  ground.className = 'load-ground'
  const label = document.createElement('div')
  label.className = 'load-label'
  label.textContent = 'LOADING'
  const dust = document.createElement('div')
  dust.className = 'load-dust'
  stage.append(ground, dust, label)

  let goose: CharStrip | null = null
  void loadManifest().then((m) => {
    const g = m.chars.goose
    goose = charStrip(g.anims.run, g.feet, 10)
    stage.appendChild(goose.el)
    px.onResize((w, h) => {
      const gy = Math.round(h * 0.62)
      ground.style.left = '0'; ground.style.width = `${w}px`; ground.style.top = `${gy}px`
      goose!.el.style.left = `${Math.round(w / 2) - g.fw / 2}px`
      goose!.el.style.top = `${gy - g.feet}px`
      dust.style.left = `${Math.round(w / 2) - 30}px`; dust.style.top = `${gy - 6}px`
      label.style.right = '8px'; label.style.top = `${h - 14}px`
    })
  })
  const stopLoop = sfxLoop()
  const t0 = performance.now()
  const done = new Promise<void>((r) => window.setTimeout(r, minSecs * 1000))
  return {
    el: px.root,
    done,
    stop: () => {
      void t0
      px.stop()
      goose?.stop()
      stopLoop()
    },
  }
}
