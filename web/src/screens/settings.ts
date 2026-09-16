/**
 * The settings panel.  A port of game/screens/settings_panel.py.
 *
 * The desktop panel draws its own rows, sliders and chips; here they are native
 * inputs, which get keyboard navigation, real drag handling and screen-reader
 * labels for free.  The rows, their keys and their ranges are the desktop
 * build's, so a settings object written here is one the desktop build could read.
 */
import { DEFAULTS, loadSettings, saveSettings } from '../core/settings'

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
    names: { off: 'Off', hints: 'Hints', keyboard: 'Keyboard' },
    hint: 'The keyboard guide moves the slot line up to make room.',
  },
  {
    kind: 'range', key: 'offset_ms', label: 'Timing', min: -150, max: 150, step: 5,
    format: (v) => `${v > 0 ? '+' : ''}${Math.trunc(v)} ms`,
    hint: 'Positive means the game waits longer for your press.',
  },
  {
    kind: 'range', key: 'speed_mult', label: 'Speed', min: 0.5, max: 3, step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
    hint: 'Scales how long a note is on screen. Higher is faster.',
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
  let settings = loadSettings()

  const el = document.createElement('div')
  el.className = 'overlay'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', 'Settings')

  const card = document.createElement('div')
  card.className = 'card settings-card'
  card.innerHTML = '<div class="label">Settings</div>'

  const commit = (key: string, value: unknown): void => {
    settings = saveSettings({ [key]: value })
    onChange(settings)
  }

  for (const row of ROWS) {
    const wrap = document.createElement('div')
    wrap.className = 'srow'
    const id = `set-${row.key}`
    const head = document.createElement('div')
    head.className = 'shead'
    head.innerHTML = `<label for="${id}">${row.label}</label><span class="sval"></span>`
    const val = head.querySelector('.sval') as HTMLElement
    wrap.appendChild(head)

    if (row.kind === 'choice') {
      const group = document.createElement('div')
      group.className = 'row'
      group.id = id
      const paint = (): void => {
        for (const b of group.children) {
          const b2 = b as HTMLButtonElement
          b2.setAttribute('aria-pressed', String(b2.dataset.v === String(settings[row.key])))
        }
        val.textContent = ''
      }
      for (const opt of row.options) {
        const b = document.createElement('button')
        b.className = 'chip'
        b.dataset.v = opt
        b.textContent = row.names[opt] ?? opt
        b.onclick = () => { commit(row.key, opt); paint() }
        group.appendChild(b)
      }
      wrap.appendChild(group)
      paint()
    } else if (row.kind === 'range') {
      const input = document.createElement('input')
      input.type = 'range'
      input.id = id
      input.min = String(row.min)
      input.max = String(row.max)
      input.step = String(row.step)
      input.value = String(settings[row.key] ?? DEFAULTS[row.key])
      const paint = (): void => { val.textContent = row.format(Number(input.value)) }
      input.oninput = () => { paint(); commit(row.key, Number(input.value)) }
      paint()
      wrap.appendChild(input)
    } else {
      const b = document.createElement('button')
      b.className = 'chip'
      b.id = id
      const paint = (): void => {
        const on = Boolean(settings[row.key])
        b.setAttribute('aria-pressed', String(on))
        b.textContent = on ? 'On' : 'Off'
      }
      b.onclick = () => { commit(row.key, !settings[row.key]); paint() }
      paint()
      wrap.appendChild(b)
    }

    if (row.hint) {
      const h = document.createElement('p')
      h.className = 'shint'
      h.textContent = row.hint
      wrap.appendChild(h)
    }
    card.appendChild(wrap)
  }

  const close = document.createElement('button')
  close.className = 'play'
  close.textContent = 'Done'
  close.onclick = onClose
  card.appendChild(close)
  el.appendChild(card)
  return el
}
