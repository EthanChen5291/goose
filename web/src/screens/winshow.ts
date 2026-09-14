/**
 * The victory: the stance, and a line.
 *
 * After the DOWN! the 3D goose stands in the meadow at dusk, grows the hero's
 * body in three snaps and strikes a JoJo pose, and the camera cuts the way
 * the manga frames it — from the ground looking up, from high behind looking
 * down the pose, then the face, scowling, with ド ド ド in the air — each
 * shot pushing in a little, speed lines on the first two.  Over the last one
 * a dialogue box types a line, one letter a tick.
 */
import { pixelStage } from './pxchrome'
import type { GooseMovie } from './goose3d'

const LINES = [
  '* honk.',
  '* Quiet birds peck the hardest.',
  '* That was a warm-up.',
  '* Bread. Now.',
  '* You can\'t out-rhythm a goose.',
]

export interface WinShow { el: HTMLElement; done: Promise<void>; stop: () => void }

export function buildWinShow(movie: GooseMovie, songId: string, sfx: (n: string) => void): WinShow {
  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('win-root')
  const lines = document.createElement('div')
  lines.className = 'win-lines'
  const box = document.createElement('div')
  box.className = 'win-dialog'
  box.hidden = true
  stage.append(movie.el, lines, box)
  let h = 0
  for (const c of songId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const line = LINES[h % LINES.length]
  const timers: number[] = []
  let alive = true

  px.onResize((w, hh) => {
    movie.resize(w, hh)
    lines.style.width = `${w}px`; lines.style.height = `${hh}px`
    box.style.left = '8px'; box.style.top = '8px'; box.style.width = `${Math.min(150, w - 16)}px`
  })

  const done = movie.winShow((i) => {
    if (!alive) return
    lines.classList.toggle('on', i < 2)
    sfx(i === 0 ? 'thud' : i === 1 ? 'kanji' : 'crash_zoom')
    if (i === 2) {
      box.hidden = false
      box.textContent = ''
      line.split('').forEach((ch, k) => {
        timers.push(window.setTimeout(() => {
          if (!alive) return
          box.textContent += ch
          if (ch !== ' ') sfx('text_tick')
        }, 60 + k * 45))
      })
    }
  }, h)
  return {
    el: px.root,
    done,
    stop: () => { alive = false; px.stop(); for (const t of timers) window.clearTimeout(t) },
  }
}
