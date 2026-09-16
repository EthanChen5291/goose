/**
 * The settings panel.  A port of game/screens/settings_panel.py.
 *
 * The rows, their keys and their ranges are the desktop build's, so a
 * settings object written here is one the desktop build could read.  The
 * panel is a pixel box on an integer-scaled stage (`pixelStage`), like the
 * rest of the menus: each row is one line — its label on the left, its
 * control on the right — and the hint for whichever row the pointer or the
 * keyboard is on sits in the panel's foot.  The controls are native inputs
 * dressed by the kit, so keyboard navigation, drag handling and screen-reader
 * labels come for free.
 */
import { DEFAULTS, loadSettings, saveSettings } from '../core/settings'
import { pixelStage } from './pxchrome'
import { installKit } from './ui_kit'

interface ChoiceRow {
  kind: 'choice'
  key: string
  label: string
  options: string[]
  names: Record<string, string>
  hint?: string
}
interface RangeRow {
  kind: 'range'
  key: string
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
  hint?: string
}
interface ToggleRow {
  kind: 'toggle'
  key: string
  label: string
  hint?: string
}
type Row = ChoiceRow | RangeRow | ToggleRow

const ROWS: Row[] = [
  {
    kind: 'choice', key: 'key_guide', label: 'Key guide',
    options: ['off', 'hints', 'keyboard'],
    names: { off: 'Off', hints: 'Hints', keyboard: 'Keys' },
    hint: 'The keyboard guide moves the slot line up to make room.',
  },
  {
    kind: 'range', key: 'offset_ms', label: 'Timing', min: -150, max: 150, step: 5,
    format: (v) => `${v > 0 ? '+' : ''}${Math.trunc(v)}ms`,
    hint: 'Positive means the game waits longer for your press.',
  },
  {
    kind: 'range', key: 'speed_mult', label: 'Speed', min: 0.5, max: 3, step: 0.1,
    format: (v) => `${v.toFixed(1)}x`,
    hint: 'How long a note is on screen. Higher is faster.',
  },
  {
    kind: 'range', key: 'music_volume', label: 'Music', min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    kind: 'range', key: 'hitsound_volume', label: 'Hitsound', min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  { kind: 'toggle', key: 'stage_view', label: 'Stage view', hint: 'Bigger orbs and rings.' },
  { kind: 'toggle', key: 'no_fail', label: 'No fail', hint: 'Letters mode runs on even at zero HP.' },
  { kind: 'toggle', key: 'reduce_motion', label: 'Reduce motion' },
]

/**
 * Build the settings panel as a detached element.  `onChange` fires on every
 * edit with the whole settings object, so live things (the music volume) can
 * follow the slider rather than waiting for the panel to close.
 */
export function buildSettingsPanel(
  onChange: (settings: Record<string, unknown>) => void,
  onClose: () => void,
): HTMLElement {
  installKit()
  let settings = loadSettings()

  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('set-root')
  px.root.setAttribute('role', 'dialog')
  px.root.setAttribute('aria-label', 'Settings')

  const panel = document.createElement('div')
  panel.className = 'set-panel'
  const title = document.createElement('div')
  title.className = 'set-title'
  title.textContent = 'SETTINGS'
  panel.appendChild(title)
  const foot = document.createElement('div')
  foot.className = 'set-hint'

  const commit = (key: string, value: unknown): void => {
    settings = saveSettings({ [key]: value })
    onChange(settings)
  }
  const showHint = (row: Row): void => { foot.textContent = row.hint ?? '' }

  for (const row of ROWS) {
    const wrap = document.createElement('div')
    wrap.className = 'set-row'
    const id = `set-${row.key}`
    const label = document.createElement('label')
    label.className = 'set-label'
    label.htmlFor = id
    label.textContent = row.label
    wrap.appendChild(label)
    wrap.addEventListener('pointerenter', () => showHint(row))
    wrap.addEventListener('focusin', () => showHint(row))

    if (row.kind === 'choice') {
      const group = document.createElement('div')
      group.className = 'set-pills'
      group.id = id
      const paint = (): void => {
        for (const b of group.children) {
          const b2 = b as HTMLButtonElement
          b2.setAttribute('aria-pressed', String(b2.dataset.v === String(settings[row.key])))
        }
      }
      for (const opt of row.options) {
        const b = document.createElement('button')
        b.className = 'set-pill'
        b.dataset.v = opt
        b.textContent = row.names[opt] ?? opt
        b.onclick = () => { commit(row.key, opt); paint() }
        group.appendChild(b)
      }
      wrap.appendChild(group)
      paint()
    } else if (row.kind === 'range') {
      const val = document.createElement('span')
      val.className = 'set-val'
      const input = document.createElement('input')
      input.type = 'range'
      input.className = 'set-range'
      input.id = id
      input.min = String(row.min)
      input.max = String(row.max)
      input.step = String(row.step)
      input.value = String(settings[row.key] ?? DEFAULTS[row.key])
      const paint = (): void => {
        const v = Number(input.value)
        val.textContent = row.format(v)
        // the filled part of the track, in whole pixels of the track's width
        input.style.setProperty('--p', `${Math.round(((v - row.min) / (row.max - row.min)) * 100)}%`)
      }
      input.oninput = () => { paint(); commit(row.key, Number(input.value)) }
      paint()
      wrap.append(val, input)
    } else {
      const b = document.createElement('button')
      b.className = 'set-pill set-toggle'
      b.id = id
      const paint = (): void => {
        const on = Boolean(settings[row.key])
        b.setAttribute('aria-pressed', String(on))
        b.textContent = on ? 'ON' : 'OFF'
      }
      b.onclick = () => { commit(row.key, !settings[row.key]); paint() }
      paint()
      wrap.appendChild(b)
    }
    panel.appendChild(wrap)
  }

  panel.appendChild(foot)
  const close = document.createElement('button')
  close.className = 'set-done'
  close.textContent = 'DONE'
  close.onclick = () => { stop(); onClose() }
  panel.appendChild(close)
  stage.appendChild(panel)

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); onClose() }
  }
  // capture, so the screen underneath does not also act on the key
  window.addEventListener('keydown', onKey, true)
  const stop = (): void => { window.removeEventListener('keydown', onKey, true); px.stop() }

  px.onResize((w, h) => {
    const pw = Math.min(236, w - 16)
    panel.style.width = `${pw}px`
    panel.style.left = `${Math.round((w - pw) / 2)}px`
    panel.style.top = `${Math.max(4, Math.round((h - panel.offsetHeight) / 2))}px`
  })
  // the panel's height is only known once it is in the document
  requestAnimationFrame(() => {
    if (!px.root.isConnected) return
    panel.style.top = `${Math.max(4, Math.round((px.h - panel.offsetHeight) / 2))}px`
  })
  // `remove()` from the shell must also let go of the listeners
  const root = px.root as HTMLElement & { remove: () => void }
  const remove = root.remove.bind(root)
  root.remove = () => { stop(); remove() }
  return root
}
