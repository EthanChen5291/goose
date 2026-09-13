/**
 * The title screen — the desktop build's, on the web.
 *
 * `game/screens/title_screen.py` puts Noki under a spotlight on the left, bopping
 * on the beat, and the wordmark with the play and settings buttons on the right,
 * over a field of drifting petals. The first pass at the port skipped all of it
 * and opened straight into a list of songs, which is why the two builds did not
 * look like the same app.
 *
 * Every position here is the one the desktop screen computes, converted to the
 * 1920×1080 design box the whole menu is laid out in:
 *
 *     wordmark   0.325 of the width, centred at 0.5w + 0.15w
 *     buttons    0.10h × 1.2 square, settings then play, under the wordmark
 *     Noki       0.40h tall, centred at 0.25w + 0.06w, sitting on the button line
 *     spotlight  0.78 of Noki's width, reaching from the top to below the buttons
 *
 * The bop is a packed strip rather than a video: `game/screens/_video.py` learned
 * the hard way that decoding a clip per frame costs more than the whole rest of
 * the screen.
 */
import { petalField, spriteStrip, fitStage } from './chrome'
import type { SheetInfo } from './chrome'

const W = 1920
const H = 1080
/** the intro's pulse, from `BEAT_BPM_INTRO` on the desktop screen */
const INTRO_BPM = 120

export interface TitleOptions {
  sheets: Record<string, SheetInfo>
  onPlay: () => void
  onSettings: () => void
}

/**
 * Build the title screen.  Returns the element and a `stop` that must be called
 * when it is replaced — the petals and the bop are running timers.
 */
export function buildTitle(opts: TitleOptions): { el: HTMLElement; stop: () => void } {
  const root = document.createElement('div')
  root.className = 'menu-root'

  const petals = petalField()
  root.appendChild(petals.el)

  const stage = document.createElement('div')
  stage.className = 'stage title-stage'
  root.appendChild(stage)
  const unfit = fitStage(stage, W, H)

  // ── geometry, straight from the desktop screen ─────────────────────────
  const titleW = W * 0.325
  const titleCx = W / 2 + W * 0.15
  const btn = H * 0.10 * 1.2
  const gap = btn * 0.32
  // the wordmark's height is not known until it loads, so the button row is
  // placed from a measured ratio and corrected once the image reports its size
  let titleH = titleW * 0.42
  const bopH = H * 0.40
  const bopCx = W / 4 + W * 0.06

  const spot = document.createElement('img')
  spot.className = 'title-spot'
  spot.src = 'img/spotlight.png'
  stage.appendChild(spot)

  const bopSheet = opts.sheets['noki_bop']
  let bop: { el: HTMLElement; stop: () => void; setFrame: (i: number) => void } | null = null
  if (bopSheet) {
    bop = spriteStrip(bopSheet, bopH, 30)
    bop.el.classList.add('title-bop')
    stage.appendChild(bop.el)
  }

  const wordmark = document.createElement('img')
  wordmark.className = 'title-wordmark'
  wordmark.src = 'img/noki_maintitle.png'
  wordmark.alt = 'Noki'
  wordmark.style.width = `${titleW}px`
  stage.appendChild(wordmark)

  const row = document.createElement('div')
  row.className = 'title-buttons'
  stage.appendChild(row)

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'title-btn'
  settingsBtn.id = 'settings'
  settingsBtn.setAttribute('aria-label', 'Settings')
  settingsBtn.innerHTML = `<img src="img/noki_settingsmain.png" alt="" />`
  settingsBtn.onclick = opts.onSettings

  const playBtn = document.createElement('button')
  playBtn.className = 'title-btn title-play'
  playBtn.setAttribute('aria-label', 'Play')
  playBtn.innerHTML = `<img src="img/playbutton.png" alt="" />`
  playBtn.onclick = opts.onPlay

  row.append(settingsBtn, playBtn)

  const place = (): void => {
    const bh = wordmark.naturalHeight && wordmark.naturalWidth
      ? titleW * (wordmark.naturalHeight / wordmark.naturalWidth)
      : titleH
    titleH = bh
    const titleCy = H / 2 - bh / 2 + 20
    wordmark.style.left = `${titleCx - titleW / 2}px`
    wordmark.style.top = `${titleCy - bh / 2}px`

    const btnCy = H / 2 + bh / 2 + 60
    row.style.left = `${titleCx - (btn * 2 + gap) / 2}px`
    row.style.top = `${btnCy - btn / 2}px`
    row.style.gap = `${gap}px`
    for (const b of [settingsBtn, playBtn]) {
      b.style.width = `${btn}px`
      b.style.height = `${btn}px`
    }

    const btnBottom = btnCy + btn / 2
    if (bop) {
      bop.el.style.left = `${bopCx - bop.el.offsetWidth / 2}px`
      bop.el.style.top = `${btnBottom - bopH}px`
    }
    // the cone reaches from above the screen to below the buttons, as wide as
    // most of Noki — the desktop screen sizes it off the clip's own width
    const spotW = (bop ? bop.el.offsetWidth : bopH) * 0.78 * 1.9
    const spotH = (btnBottom + H * 0.10) * 1.15
    spot.style.width = `${spotW}px`
    spot.style.height = `${spotH}px`
    spot.style.left = `${bopCx - spotW / 2}px`
    spot.style.top = `${-spotH * 0.06}px`
  }
  wordmark.onload = place
  place()

  // the wordmark pulses on the intro's beat, as it does on the desktop
  let raf = 0
  const t0 = performance.now()
  const pulse = (): void => {
    const beat = ((performance.now() - t0) / 1000) * (INTRO_BPM / 60)
    const k = Math.max(0, 1 - (beat % 1)) ** 3
    wordmark.style.transform = `scale(${1 + 0.035 * k})`
    raf = requestAnimationFrame(pulse)
  }
  raf = requestAnimationFrame(pulse)

  return {
    el: root,
    stop: () => {
      cancelAnimationFrame(raf)
      petals.stop()
      bop?.stop()
      unfit()
    },
  }
}
