/**
 * The results-screen "Typing" view (Tab).  A port of game/coach/panel.py.
 *
 * One picture, three sentences, one thing to try: the keyboard heatmap tinted by
 * accuracy, Noki with a speech bubble, and the instruction line.  Reads the
 * folded stats and the tip library; writes the run into local history so next
 * time the praise and the cooldowns are honest.
 *
 * The pygame panel draws its own keyboard tile by tile with a pop-in animation.
 * Here the keyboard is a CSS grid and the pop-in is one keyframe, so the whole
 * view is markup — which also means the numbers on it are selectable and the
 * sentences are read by a screen reader.
 */
import * as KB from '../core/keyboard'
import type { HitRecord } from '../core/models'
import { fold, merge } from './stats'
import type { History, RunStats } from './stats'
import { buildTips, pick } from './tips'
import type { Tip } from './tips'

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const ROW_INDENT = [0, 0.5, 1]
const HISTORY_KEY = 'noki.typing_history'

export function loadHistory(): History {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as History
  } catch {
    return {}
  }
}

export function saveHistory(h: History): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
  } catch {
    /* private window, or storage disabled: the coach just forgets */
  }
}

export interface RecordedRun {
  run: RunStats
  history: History
  sentences: string[]
  instruction: Tip | null
}

/** Fold a run, merge it into history, decide the sentences. */
export function recordRun(
  hits: HitRecord[],
  settings: Record<string, unknown> = {},
  runStats?: RunStats,
): RecordedRun {
  const run = runStats ?? fold(hits)
  let hist = loadHistory()
  const tips = buildTips(run, settings, hist)
  const cooldown: Record<string, number> = {}
  for (const [k, v] of Object.entries(hist.cooldown ?? {})) if (v > 0) cooldown[k] = v
  const [sentences, instruction] = pick(tips, cooldown)
  // advance cooldowns and set new ones for the sentences shown
  const newCd: Record<string, number> = {}
  for (const [k, v] of Object.entries(cooldown)) if (v - 1 > 0) newCd[k] = v - 1
  for (const t of tips) if (sentences.includes(t.text) && t.priority <= 4) newCd[t.id] = 3
  hist = merge(hist, run)
  hist.cooldown = newCd
  saveHistory(hist)
  return { run, history: hist, sentences, instruction }
}

/** Tile colour by accuracy, matching TypingPanel._tile_color. */
function tileColor(run: RunStats, k: string): string {
  const d = run.keys[k]
  if (d === undefined || d.presses < 6) return 'rgb(58,58,72)'
  const acc = d.accuracy
  const lane = KB.laneColor(KB.laneOf(k))
  const r = (lane >> 16) & 255
  const g = (lane >> 8) & 255
  const b = lane & 255
  if (acc >= 0.95) return 'rgb(240,240,250)'
  if (acc >= 0.85) {
    return `rgb(${Math.trunc(r * 0.45 + 40)},${Math.trunc(g * 0.45 + 40)},${Math.trunc(b * 0.45 + 40)})`
  }
  if (acc >= 0.75) return `rgb(${Math.trunc(r * 0.85)},${Math.trunc(g * 0.85)},${Math.trunc(b * 0.85)})`
  const m = KB.MISS_RED
  return `rgb(${(m >> 16) & 255},${(m >> 8) & 255},${m & 255})`
}

function isLight(css: string): boolean {
  const m = css.match(/\d+/g)
  if (!m) return false
  return Number(m[0]) + Number(m[1]) + Number(m[2]) > 400
}

/** Build the Typing panel as a detached element. */
export function buildCoachPanel(
  hits: HitRecord[],
  levelName: string,
  settings: Record<string, unknown>,
  onClose: () => void,
): HTMLElement {
  const { run, sentences, instruction } = recordRun(hits, settings)

  const el = document.createElement('div')
  el.className = 'overlay coach'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', `Typing report for ${levelName}`)

  // one running index across all three rows, so the pop-in sweeps the keyboard
  // rather than restarting each row (game/coach/panel.py's pop_i)
  let popI = 0
  const kb = ROWS.map((row, r) => {
    const keys = [...row].map((k) => {
      const i = popI++
      const d = run.keys[k]
      const col = tileColor(run, k)
      const ink = isLight(col) ? '#14141e' : '#f0f0fa'
      const shown = d !== undefined && d.presses >= 6
      const pct = shown ? `<span class="pct">${Math.trunc(d.accuracy * 100)}</span>` : ''
      // an arrow only where the key is clearly off the run's own median
      const arrow = shown && Math.abs(d.relative_late) >= 20 && d.n_timed >= 3
        ? `<span class="arrow">${d.relative_late < 0 ? '▲' : '▼'}</span>` : ''
      const slips = shown
        ? Array.from({ length: Math.min(5, d.slips_expected) }, () => '<i></i>').join('')
        : ''
      const title = shown
        ? `${k.toUpperCase()}: ${Math.trunc(d.accuracy * 100)}% of ${d.presses}, ${d.slips_expected} slips`
        : `${k.toUpperCase()}: too few presses to judge`
      return `<div class="key" style="--bg:${col};--ink:${ink};--i:${i}" title="${title}">
          <span class="ltr">${k.toUpperCase()}</span>${pct}${arrow}
          <span class="slips">${slips}</span>
        </div>`
    }).join('')
    return `<div class="krow" style="--indent:${ROW_INDENT[r]}">${keys}</div>`
  }).join('')

  // the strip: weakest finger, pace, slips
  let weakF: number | null = null
  let worst = 1
  for (const [fs, d] of Object.entries(run.fingers)) {
    if (d.presses >= 8 && d.accuracy < worst) { worst = d.accuracy; weakF = Number(fs) }
  }
  const parts: string[] = []
  if (weakF !== null) parts.push(`Weakest finger: ${KB.FINGER_NAMES[weakF]}`)
  if (run.wpm > 0) parts.push(`Pace: ${Math.round(run.wpm)} words a minute (set by the song)`)
  parts.push(`Slips ${run.slips}`)

  el.innerHTML = `
    <div class="coach-card">
      <div class="label">Typing · ${escapeHtml(levelName)}</div>
      <div class="coach-body">
        <div class="keyboard" aria-label="Accuracy by key">${kb}</div>
        <div class="bubble-col">
          <div class="bubble-row">
            <div class="bubble">${sentences.map((s) => `<p>${escapeHtml(s)}</p>`).join('')}</div>
            <div class="coach-noki" role="presentation"></div>
          </div>
          ${instruction && instruction.try
            ? `<div class="tryit"><span class="label">Try this</span><p>${escapeHtml(instruction.try)}</p></div>`
            : ''}
        </div>
      </div>
      <div class="strip">${escapeHtml(parts.join('   ·   '))}</div>
      <button class="play" id="coach-back">Back</button>
    </div>
  `
  ;(el.querySelector('#coach-back') as HTMLButtonElement).onclick = onClose
  return el
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
