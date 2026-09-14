/**
 * The pause menu, on the Emi kit.
 *
 * `Background_Pause.png` is a 256×144 screen: a dark ground with a field of
 * diamonds coming in from the right.  It is shown at a whole-number scale that
 * fits the window (pixel-perfect, like the play buffer), the field slides in
 * from the right edge in a few hard steps, and the options sit on the white
 * `Pause_Panel` parallelogram as the kit's own button bars.  The cyan bar the
 * kit puts in the top-left corner was removed by `tools/pixel_pack.py`.
 */

export interface PauseOptions {
  onResume: () => void
  onRestart: () => void
  onSettings: () => void
  onQuit: () => void
}

const W = 256
const H = 144

export function buildPause(opts: PauseOptions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'pause'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Paused')

  const screen = document.createElement('div')
  screen.className = 'pause-screen'
  root.appendChild(screen)

  const field = document.createElement('div')
  field.className = 'pause-field'
  screen.appendChild(field)

  const panel = document.createElement('div')
  panel.className = 'pause-panel'
  screen.appendChild(panel)

  const title = document.createElement('div')
  title.className = 'pause-title'
  title.textContent = 'PAUSED'
  screen.appendChild(title)

  const buttons: [string, string, () => void][] = [
    ['RESUME', 'cyan', opts.onResume],
    ['RESTART', 'red', opts.onRestart],
    ['SETTINGS', 'purple', opts.onSettings],
    ['QUIT', 'yellow', opts.onQuit],
  ]
  buttons.forEach(([label, kind, fn], i) => {
    const b = document.createElement('button')
    b.className = `pbtn pbtn-${kind}`
    b.textContent = label
    b.style.setProperty('--i', String(i))
    b.onclick = fn
    screen.appendChild(b)
  })

  // integer scale to the window, like the play buffer
  const fit = (): void => {
    const k = Math.max(1, Math.floor(Math.min(window.innerWidth / W, window.innerHeight / H)))
    screen.style.setProperty('--k', String(k))
  }
  fit()
  window.addEventListener('resize', fit)
  ;(root as HTMLElement & { cleanup?: () => void }).cleanup = () => window.removeEventListener('resize', fit)
  return root
}
