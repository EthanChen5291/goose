/**
 * Chart arithmetic both pixel renderers share: metric weights and drop finding.
 * Ports of `game/highway.py`'s helpers, unchanged from the first web port.
 */

/** index of the first element > x (Python's bisect_right) */
export function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Metric weight 4 beat1 · 3 beat3 · 2 backbeat · 1 eighth · 0 sixteenth. */
export function weightOfTime(songT: number, beatTimes: number[], _bpm: number): number {
  if (!beatTimes || beatTimes.length < 2) return 2
  let i = lowerBound(beatTimes, songT) - 1
  if (i < 0) i = 0
  if (i >= beatTimes.length - 1) i = beatTimes.length - 2
  const t0 = beatTimes[i]
  const t1 = beatTimes[i + 1]
  const frac = (songT - t0) / Math.max(1e-6, t1 - t0)
  const beatInBar = i % 4
  const near = (v: number) => Math.abs(frac - v) < 0.12
  if (near(0)) {
    if (beatInBar === 0) return 4
    if (beatInBar === 2) return 3
    return 2
  }
  if (near(0.5)) return 1
  return 0
}

const DROP_LARGE_RISE = 0.2
const DROP_LARGE_MIN_E = 0.55
const DROP_SMALL_RISE = 0.09
const DROP_SMALL_MIN_E = 0.4
const DROP_PHRASE_RISE = 0.04
const DROP_LARGE_GAP_BARS = 8
const DROP_ANY_GAP_BARS = 2

/** Where the song drops, in chart time, each tagged large or small. */
export function findDrops(energy: number[], vibes: string[], barT: number[]): [number, string][] {
  const n = Math.min(energy.length, barT.length)
  const out: [number, string][] = []
  if (n < 2) return out
  const order: Record<string, number> = { sustain: 0, groove: 1, drive: 2, burst: 3 }
  let lastLarge = -99
  let lastAny = -99
  for (let b = 0; b < n; b++) {
    const v = b < vibes.length ? vibes[b] : 'groove'
    const pv = b > 0 && b < vibes.length ? vibes[b - 1] : (b === 0 ? 'sustain' : v)
    let rise = 0
    if (b > 0) {
      const prev = energy.slice(Math.max(0, b - 2), b)
      rise = energy[b] - prev.reduce((x, y) => x + y, 0) / prev.length
    }
    const intoBurst = v === 'burst' && pv !== 'burst'
    const stepUp = (order[v] ?? 1) > (order[pv] ?? 1)
    const nextV = b + 1 < vibes.length ? vibes[b + 1] : v
    if (!intoBurst && v !== 'burst' && nextV === 'burst') continue
    const large = intoBurst || (rise >= DROP_LARGE_RISE && energy[b] >= DROP_LARGE_MIN_E)
    const small = (rise >= DROP_SMALL_RISE && energy[b] >= DROP_SMALL_MIN_E && (v === 'drive' || v === 'burst'))
      || (stepUp && rise >= DROP_PHRASE_RISE && energy[b] >= DROP_SMALL_MIN_E)
      || (b % 4 === 0 && v === 'burst' && rise >= DROP_PHRASE_RISE)
      || (b % 8 === 0 && v === 'burst' && b > 0 && energy[b] >= energy[b - 1] - 0.01)
    if (large && b - lastLarge >= DROP_LARGE_GAP_BARS && b - lastAny >= DROP_ANY_GAP_BARS) {
      out.push([barT[b], 'large'])
      lastLarge = lastAny = b
    } else if ((large || small) && b - lastAny >= DROP_ANY_GAP_BARS) {
      out.push([barT[b], 'small'])
      lastAny = b
    }
  }
  if (!out.some(([, s]) => s === 'large')) {
    let best = -1
    let bestRise = -Infinity
    for (let b = 1; b < n; b++) {
      const r = energy[b] - energy[b - 1]
      if (r > bestRise) { bestRise = r; best = b }
    }
    if (best > 0 && bestRise >= DROP_SMALL_RISE) {
      const keep = out.filter(([t]) => Math.abs(t - barT[best]) > 1e-6)
      keep.push([barT[best], 'large'])
      out.length = 0
      out.push(...keep)
    }
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/** A small deterministic PRNG, so effects are the same every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
