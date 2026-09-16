/**
 * The results screen: the rank as the gigapack's animated symbol, the score,
 * and the run's numbers, on a pixel panel.
 */
import { pixelStage, fxStrip, loadManifest } from './pxchrome'

export interface ResultsOptions {
  title: string
  tierLabel: string
  stats: Record<string, number | string>
  /** the best that stood before this run, if any */
  prev: { score: number; grade: string } | null
  onBack: () => void
  onTyping: () => void
  onRetry: () => void
}

export function buildResults(o: ResultsOptions): { el: HTMLElement; stop: () => void } {
  const px = pixelStage()
  const { stage } = px
  px.root.classList.add('px-results')
  const stops: (() => void)[] = [px.stop]

  const n = (k: string) => Number(o.stats[k] ?? 0)
  const grade = String(o.stats.grade ?? 'C')
  const beat = o.prev === null || n('score') > o.prev.score

  const panel = document.createElement('div')
  panel.className = 'px-panel px-results-panel'
  const head = document.createElement('div')
  head.className = 'px-results-head'
  head.textContent = `${o.title} - ${o.tierLabel}`
  const rankBox = document.createElement('div')
  rankBox.className = 'px-rank'
  const score = document.createElement('div')
  score.className = 'px-score'
  score.textContent = String(n('score')).padStart(7, '0')
  const best = document.createElement('div')
  best.className = 'px-best'
  best.textContent = o.prev === null
    ? 'first run'
    : beat ? `new best! was ${o.prev.score} ${o.prev.grade}` : `best ${o.prev.score} ${o.prev.grade}`
  const stats = document.createElement('div')
  stats.className = 'px-stats'
  for (const [k, v] of [
    ['ACC', `${n('accuracy').toFixed(1)}%`], ['COMBO', String(n('max_combo'))], ['MISS', String(n('misses'))],
    ['PERFECT', String(n('perfect'))], ['GREAT', String(n('good'))], ['OK', String(n('ok'))],
  ]) {
    const d = document.createElement('div')
    d.innerHTML = `<b>${v}</b><i>${k}</i>`
    stats.appendChild(d)
  }
  const row = document.createElement('div')
  row.className = 'px-results-row'
  const retry = document.createElement('button')
  retry.className = 'pbtn pbtn-red'
  retry.textContent = 'RETRY'
  retry.onclick = o.onRetry
  const backB = document.createElement('button')
  backB.className = 'pbtn pbtn-cyan'
  backB.id = 'back'
  backB.textContent = 'SONGS'
  backB.onclick = o.onBack
  const typing = document.createElement('button')
  typing.className = 'pbtn pbtn-purple'
  typing.id = 'typing'
  typing.textContent = 'TYPING'
  typing.onclick = o.onTyping
  row.append(backB, retry, typing)
  panel.append(head, rankBox, score, best, stats, row)
  stage.appendChild(panel)

  void loadManifest().then((m) => {
    const fx = m.fx[`rank_${grade[0].toUpperCase()}`] ?? m.fx.rank_C
    if (!fx) return
    const strip = fxStrip(fx)
    stops.push(strip.stop)
    rankBox.appendChild(strip.el)
  })

  px.onResize((w, h) => {
    const pw = Math.min(w - 16, 260)
    panel.style.width = `${pw}px`
    panel.style.left = `${Math.round((w - pw) / 2)}px`
    panel.style.top = `${Math.max(4, Math.round((h - 196) / 2))}px`
  })

  return { el: px.root, stop: () => { for (const s of stops) s() } }
}
