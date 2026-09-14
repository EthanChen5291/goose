/**
 * The two on the left: the goose, and whoever it is fighting.
 *
 * A `Puppet` is one sprite showing one frame of one strip.  Frames change by
 * snapping — there is no in-between — and the idle is locked to the song: the
 * goose's two idle frames alternate on the beat, the enemy's eight-frame idle
 * steps twice a beat so it loops once a bar.  When the song is fast the
 * characters bob fast; that is the point.
 *
 * Every frame of a move has its own duration.  That is what the animation
 * references agree makes a hit feel heavy: a wind-up you can read, one or two
 * frames at full extension held for 150–300 ms, then a fast recovery — "four
 * frames that feel like twelve" — rather than an even fps.
 *
 * Quick moves are *reactions*: a correct note plays the move from its contact
 * frame, so the hit lands on the press.  Heavy moves are *anticipated*: the
 * goose can see the chart, so half a second before an accent it starts the
 * hoist or the crouch (`windup`), timed so the contact frame falls exactly on
 * the note.  Land the note and the blow lands; miss it and the goose whiffs —
 * the boulder sails past, the uppercut hits air.
 *
 * The goose also lunges — its position snaps toward the enemy for a move and
 * snaps back — because a slap from where it stands would not reach.
 *
 * The enemy takes every hit with a white flash and a shove, the full hurt
 * animation on the accented ones, gets launched by the uppercut, and answers a
 * miss with its attack, whose contact frame is when the goose gets hurt.
 */
import { Container, Sprite } from 'pixi.js'
import type { Strip } from './assets'

/** one key of a move: how long it shows and where the body is (pixels, before facing) */
interface Key { dur: number; dx?: number; dy?: number }
interface Move {
  keys: Key[]
  /** the key on which the blow lands; keys before it are the wind-up */
  contact: number
  /** how far the whole goose snaps toward the enemy for the move */
  lunge: number
  /** something other than a slap happens at contact */
  kind?: 'boulder' | 'uppercut' | 'flop' | 'megahonk' | 'dropkick'
}

/** n keys of `secs` each */
const even = (n: number, secs: number): Key[] => Array.from({ length: n }, () => ({ dur: secs }))

const MOVES: Record<string, Move> = {
  // ── reactions: contact on the first key, one impact hold, quick recovery ──
  slap: { keys: [{ dur: 0.1 }, { dur: 0.08 }, { dur: 0.08 }], contact: 0, lunge: 10 },
  slap_up: { keys: [{ dur: 0.1 }, { dur: 0.08 }, { dur: 0.08 }], contact: 0, lunge: 9 },
  peck: { keys: [{ dur: 0.08 }, { dur: 0.07 }], contact: 0, lunge: 7 },
  hop_slap: { keys: [{ dur: 0.12, dy: -8 }, { dur: 0.08, dy: -4 }, { dur: 0.08 }, { dur: 0.08 }], contact: 0, lunge: 12 },
  slide: { keys: [{ dur: 0.12 }, { dur: 0.1 }, { dur: 0.1 }, { dur: 0.08 }], contact: 0, lunge: 18 },
  kick: { keys: [{ dur: 0.12 }, { dur: 0.08 }, { dur: 0.08 }], contact: 0, lunge: 9 },
  whip: { keys: even(4, 1 / 12), contact: 0, lunge: 4 },
  slam: { keys: [{ dur: 0.08 }, { dur: 0.16 }, { dur: 0.1 }], contact: 1, lunge: 16 },
  spin: { keys: even(4, 0.07), contact: 0, lunge: 8 },
  flurry: { keys: even(2, 0.06), contact: 0, lunge: 10 },
  dropkick: {
    keys: [{ dur: 0.16, dy: -8 }, { dur: 0.14 }, { dur: 0.1 }, { dur: 0.1 }],
    contact: 0, lunge: 14, kind: 'dropkick',
  },
  megahonk: { keys: [{ dur: 0.08 }, { dur: 0.18 }, { dur: 0.1 }], contact: 1, lunge: 2, kind: 'megahonk' },
  honk: { keys: even(3, 0.1), contact: 1, lunge: 0 },
  cheer: { keys: [{ dur: 0.14, dy: -4 }, { dur: 0.12 }], contact: 0, lunge: 0 },
  whiff: { keys: [{ dur: 0.18 }, { dur: 0.14 }], contact: 0, lunge: 0 },

  // ── the heavy ones: a long wind-up the chart lets the goose start early ──
  // squat · hoist · leap · throw (the rock is in the air) · it lands · land · stand
  boulder: {
    keys: [{ dur: 0.16 }, { dur: 0.12, dy: -10 }, { dur: 0.16, dy: -32 }, { dur: 0.1, dy: -30 },
           { dur: 0.12, dy: -14 }, { dur: 0.12 }, { dur: 0.08 }],
    contact: 4, lunge: 6, kind: 'boulder',
  },
  // crouch and load (held) · shake · shake · the blow · full extension (held) · land
  uppercut: {
    keys: [{ dur: 0.26 }, { dur: 0.1 }, { dur: 0.1 }, { dur: 0.16, dy: -4 }, { dur: 0.16, dy: -10 }, { dur: 0.1 }],
    contact: 3, lunge: 16, kind: 'uppercut',
  },
  // squat · leap · belly-down over the enemy · the splat (held) · up · stand
  bellyflop: {
    keys: [{ dur: 0.12 }, { dur: 0.14, dy: -26 }, { dur: 0.14, dy: -26, dx: 30 }, { dur: 0.22, dx: 30 },
           { dur: 0.1, dx: 30 }, { dur: 0.08 }],
    contact: 3, lunge: 0, kind: 'flop',
  },
}

/** the heavy moves, and how long their wind-up takes */
export const HEAVY = ['boulder', 'uppercut', 'bellyflop']
export function windupSeconds(name: string): number {
  const mv = MOVES[name]
  if (!mv) return 0
  let s = 0
  for (let i = 0; i < mv.contact; i++) s += mv.keys[i].dur
  return s
}

/** moves by the note's metric weight: accents get the big ones, sixteenths the quick ones */
const BY_WEIGHT: Record<number, string[]> = {
  4: ['slam', 'hop_slap', 'slap', 'slide', 'dropkick', 'megahonk'],
  3: ['slap_up', 'kick', 'slap', 'hop_slap', 'dropkick'],
  2: ['slap', 'kick', 'slap_up', 'peck'],
  1: ['peck', 'slap', 'kick', 'flurry'],
  0: ['peck', 'slap', 'flurry'],
}

interface Playing {
  name: string
  t0: number
  keys: Key[]
  from: number
  loop: boolean
  /** keys the move is allowed to show; the rest of the strip is skipped */
  count: number
  /** stay on the last key when done, rather than falling back to the idle */
  hold: boolean
}

export class Puppet {
  readonly sprite = new Sprite()
  /** feet position in game pixels */
  x = 0
  y = 0
  /** 1 faces right (the pack's drawing), -1 faces left */
  facing: 1 | -1 = 1
  /** a snap offset — the lunge — cleared when the move ends */
  dx = 0
  dy = 0
  protected playing: Playing | null = null
  protected flashUntil = -9
  /** idle frame chosen from the beat; set by `beat()` */
  protected idleFrame = 0
  protected shove = 0
  protected shoveUntil = -9
  /** the key currently shown, for callers that key effects to frames */
  protected keyIdx = -1

  constructor(readonly strips: Record<string, Strip>, protected feet: number, protected fw: number, protected fh: number) {
    this.sprite.roundPixels = true
    // the anchor is the ground under the feet, centred
    this.sprite.anchor.set(0.5, feet / fh)
  }

  has(name: string): boolean { return name in this.strips }

  /**
   * Play a strip from `from`, `count` frames, each for its key's duration (or
   * 1/fps each); loops if asked; holds the last frame if asked.
   */
  play(name: string, t: number, opts: { fps?: number; keys?: Key[]; from?: number; loop?: boolean; count?: number; hold?: boolean } = {}): void {
    const s = this.strips[name]
    if (!s) return
    const from = opts.from ?? 0
    const count = opts.count ?? (s.frames.length - from)
    const keys = opts.keys ?? even(count, 1 / (opts.fps ?? s.fps))
    this.playing = { name, t0: t, keys, from, loop: opts.loop ?? false, count, hold: opts.hold ?? false }
  }

  stop(): void { this.playing = null; this.dx = 0; this.dy = 0 }

  get current(): string | null { return this.playing?.name ?? null }

  /** which key of the current one-shot is showing, or -1 */
  protected keyAt(t: number): number {
    const p = this.playing
    if (!p) return -1
    let age = t - p.t0
    const total = p.keys.slice(0, p.count).reduce((a, k) => a + k.dur, 0)
    if (p.loop) age = ((age % total) + total) % total
    let i = 0
    while (i < p.count && age >= p.keys[i].dur) { age -= p.keys[i].dur; i += 1 }
    return i
  }

  /** true while a one-shot is still on screen */
  busy(t: number): boolean {
    const p = this.playing
    if (!p) return false
    if (p.loop || p.hold) return true
    return this.keyAt(t) < p.count
  }

  flash(t: number, seconds = 0.08): void { this.flashUntil = t + seconds }

  /** knocked a few pixels for a moment */
  knock(t: number, px: number, seconds = 0.1): void { this.shove = px; this.shoveUntil = t + seconds }

  /** the beat, so the idle can follow it: index and 0..1 phase */
  beat(_idx: number, _phase: number): void { /* per character */ }

  update(t: number): void {
    let tex
    const p = this.playing
    this.keyIdx = -1
    if (p) {
      let i = this.keyAt(t)
      if (i >= p.count) {
        if (p.hold) i = p.count - 1
        else { this.playing = null; this.dx = 0; this.dy = 0 }
      }
      if (this.playing) {
        tex = this.strips[p.name].frames[Math.min(this.strips[p.name].frames.length - 1, p.from + i)]
        this.keyIdx = i
        const k = p.keys[i]
        if (k && (k.dx !== undefined || k.dy !== undefined)) { this.dx = k.dx ?? this.dx; this.dy = k.dy ?? 0 }
        else if (k) this.dy = 0
      }
    }
    if (!tex) tex = this.strips.idle.frames[this.idleFrame % this.strips.idle.frames.length]
    if (t < this.flashUntil && this.strips.flash) tex = this.strips.flash.frames[0]
    this.sprite.texture = tex
    const shove = t < this.shoveUntil ? this.shove : 0
    this.sprite.scale.x = this.facing
    this.sprite.x = Math.round(this.x + this.dx * this.facing + shove)
    this.sprite.y = Math.round(this.y + this.dy)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/** what a heavy move has going: the note it is aimed at, and whether it has been resolved */
interface Pending { name: string; contactAt: number; start: number }
/** the boulder in flight: from the goose's wings to the enemy, or past it */
interface Rock { t0: number; x0: number; y0: number; x1: number; y1: number; dur: number; miss: boolean; broke: number }

export type GooseEvent = 'windup' | 'throw' | 'rock_break' | 'rock_miss' | 'land' | 'flop' | 'uppercut' | 'megahonk' | 'whiff' | 'dropkick'

export class Goose extends Puppet {
  private last = ''
  private rng: () => number
  private holding = false
  private holdKind: 'whip' | 'flap' | null = null
  /** a heavy move under way, aimed at a note */
  private pending: Pending | null = null
  /** chart time of the last heavy wind-up, so they stay an event */
  lastHeavyT = -9
  private rock: Rock | null = null
  private rockSprite = new Sprite()
  /** props the goose throws: drawn over both fighters */
  readonly props = new Container()
  /** where a blow lands on the enemy (feet-relative to the goose's world) */
  target: [number, number] = [0, 0]
  /** the renderer keys effects and sounds off these */
  onEvent: (ev: GooseEvent, x: number, y: number, t: number) => void = () => {}
  private lastKeySeen = -1

  constructor(strips: Record<string, Strip>, feet: number, fw: number, fh: number, rng: () => number) {
    super(strips, feet, fw, fh)
    this.rng = rng
    this.facing = -1
    this.rockSprite.anchor.set(0.5)
    this.rockSprite.roundPixels = true
    this.rockSprite.visible = false
    this.props.addChild(this.rockSprite)
  }

  beat(idx: number, _phase: number): void {
    this.idleFrame = idx % 2
  }

  private pick(list: string[]): string {
    const choices = list.filter((m) => m !== this.last && this.has(m))
    const m = choices[Math.floor(this.rng() * choices.length)] ?? list[0]
    this.last = m
    return m
  }

  /** play `name` from its contact key */
  private move(name: string, t: number, count?: number): void {
    const mv = MOVES[name] ?? { keys: even(3, 1 / 12), contact: 0, lunge: 8 }
    const s = this.strips[name]
    if (!s) return
    const keys = mv.keys.slice(mv.contact)
    this.play(name, t, { keys, from: mv.contact, count: count ?? keys.length })
    this.dx = keys[0]?.dx ?? mv.lunge
    this.dy = keys[0]?.dy ?? 0
    this.lastKeySeen = -1
  }

  /**
   * A correct note.  `weight` is the note's metric weight, `gap` the seconds to
   * the next note — a long move is only chosen when there is room for it.
   * Returns the move played, so the renderer can pick its sound.
   */
  hit(t: number, weight: number, judgment: string, gap: number): string {
    if (this.holding) return ''
    // a heavy move was wound up for this note: land it
    const p = this.pending
    if (p && Math.abs(t - p.contactAt) < 0.25) {
      this.pending = null
      this.land(p.name, t, false)
      return p.name
    }
    if (p) return ''   // wound up for a note still to come: hold the pose
    let list = BY_WEIGHT[Math.max(0, Math.min(4, weight))] ?? BY_WEIGHT[2]
    if (gap < 0.22) list = ['peck', 'slap', 'flurry']
    else if (gap < 0.34) list = list.filter((m) => !['slide', 'hop_slap', 'slam', 'dropkick', 'megahonk'].includes(m))
    if (judgment !== 'perfect') list = list.filter((m) => m !== 'slide' && m !== 'dropkick')
    if (!list.length) list = ['slap']
    const name = this.pick(list)
    this.move(name, t)
    const mv = MOVES[name]
    if (mv?.kind === 'megahonk') this.onEvent('megahonk', this.x - 12 * 1, this.y - 24, t)
    if (mv?.kind === 'dropkick') this.onEvent('dropkick', this.target[0], this.target[1], t)
    return name
  }

  /** two notes at once: a spin */
  chord(t: number): void {
    if (this.holding || this.pending) return
    this.move('spin', t)
  }

  // ── heavy moves ──────────────────────────────────────────────────────────
  /**
   * Start a heavy move so its contact key falls on `contactAt`.  If there is
   * less time than the wind-up wants, the wind-up is compressed (never below
   * half speed; the caller checks that).  Returns false if it could not start.
   */
  windup(name: string, t: number, contactAt: number): boolean {
    const mv = MOVES[name]
    if (!mv || !this.has(name) || this.holding || this.pending || this.busy(t)) return false
    const want = windupSeconds(name)
    const have = contactAt - t
    if (have <= 0.05) return false
    const k = Math.min(1, have / want)
    const keys = mv.keys.slice(0, mv.contact).map((key) => ({ ...key, dur: key.dur * k }))
    // start so the wind-up ends exactly on the note; hold the last key until then
    const start = contactAt - keys.reduce((a, key) => a + key.dur, 0)
    this.play(name, start, { keys, from: 0, count: keys.length, hold: true })
    this.dx = 0
    this.pending = { name, contactAt, start }
    this.lastHeavyT = t
    this.lastKeySeen = -1
    this.onEvent('windup', this.x, this.y - 42, t)
    return true
  }

  get pendingContact(): number { return this.pending?.contactAt ?? -1 }

  /** the note the goose wound up for was missed: swing at nothing */
  whiff(t: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.land(p.name, t, true)
  }

  /** play the rest of a heavy move from its contact key; `miss` makes it a whiff */
  private land(name: string, t: number, miss: boolean): void {
    const mv = MOVES[name]
    if (!mv) return
    if (mv.kind === 'boulder') {
      // the rock is already flying: it breaks on the enemy, or sails past
      if (this.rock) {
        if (miss) { this.rock.miss = true; this.onEvent('rock_miss', this.rock.x1, this.rock.y1, t) }
        else { this.rock.broke = t; this.onEvent('rock_break', this.rock.x1, this.rock.y1, t) }
      }
      this.move(name, t)
      return
    }
    if (mv.kind === 'uppercut') {
      if (miss) { this.move('whiff', t); this.onEvent('whiff', this.x, this.y - 20, t); return }
      this.move(name, t)
      this.onEvent('uppercut', this.target[0], this.target[1], t)
      return
    }
    if (mv.kind === 'flop') {
      // a miss flops short, onto the grass between them
      this.move(name, t)
      if (miss) { this.dx = 14; this.onEvent('whiff', this.x + 14 * this.facing, this.y, t) }
      this.onEvent('flop', miss ? this.x + 14 * this.facing : this.target[0], this.y, t)
      return
    }
    this.move(name, t)
  }

  // ── holds ────────────────────────────────────────────────────────────────
  /** a hold begins: crack the whip, then keep it taut until release */
  holdStart(t: number): void {
    this.pending = null
    this.holding = true
    this.holdKind = 'whip'
    this.move('whip', t, 1)
  }

  holdEnd(t: number, clean: boolean): void {
    this.holding = false
    this.holdKind = null
    this.stop()
    if (clean) this.move('slap', t)
  }

  /** an anchor: one hand pinned — the goose flaps and holds the air */
  anchorStart(t: number): void {
    this.pending = null
    this.holding = true
    this.holdKind = 'flap'
    this.play('flap', t, { loop: true, fps: 10 })
    this.dx = 6
  }

  anchorEnd(t: number, clean: boolean): void {
    this.holding = false
    this.holdKind = null
    this.stop()
    if (clean) this.move('slap_up', t)
  }

  /** the word is done: a honk — a big one when the word was clean */
  honk(t: number, big = false): void {
    if (this.holding || this.pending) return
    if (big && this.has('megahonk')) { this.move('megahonk', t); this.onEvent('megahonk', this.x - 12, this.y - 24, t) }
    else this.move('honk', t)
  }

  cheer(t: number): void {
    if (this.holding || this.pending) return
    this.move('cheer', t)
  }

  hurt(t: number): void {
    this.holding = false
    this.holdKind = null
    this.pending = null
    this.play('hurt', t, { keys: [{ dur: 0.1 }, { dur: 0.12 }, { dur: 0.1 }] })
    this.dx = -6
    this.flash(t, 0.07)
  }

  update(t: number): void {
    // the crack is over: keep the lash taut for as long as the key is down
    if (this.holding && this.holdKind === 'whip' && this.current !== 'whip_hold' && !this.busy(t)) {
      this.play('whip_hold', t, { loop: true, fps: 4 })
      this.dx = 4
    }
    // a heavy move wound up for a note that never came
    const p = this.pending
    if (p && t > p.contactAt + 0.25) this.whiff(t)
    super.update(t)
    this.keyEvents(t)
    this.updateRock(t)
  }

  /** effects that belong to a key: the throw, the landing, the splat */
  private keyEvents(t: number): void {
    const p = this.playing
    const i = this.keyIdx
    if (!p || i < 0 || i === this.lastKeySeen) return
    this.lastKeySeen = i
    const mv = MOVES[p.name]
    if (!mv) return
    const abs = p.from + i
    if (mv.kind === 'boulder' && abs === 3 && !this.rock) {
      // the throw: the rock leaves the wings, arrives on the note
      const k = mv.keys[3]
      const x0 = this.x + (k.dx ?? 0) * this.facing + 6 * this.facing
      const y0 = this.y + (k.dy ?? 0) - 34
      const dur = this.pending ? Math.max(0.06, this.pending.contactAt - t) : 0.1
      this.rock = { t0: t, x0, y0, x1: this.target[0], y1: this.target[1], dur, miss: false, broke: -1 }
      this.onEvent('throw', x0, y0, t)
    }
    if ((mv.kind === 'boulder' && abs === 5) || (mv.kind === 'uppercut' && abs === 5) || (p.name === 'hop_slap' && abs === 2)
        || (mv.kind === 'dropkick' && abs === 1)) {
      this.onEvent('land', this.x + (this.dx) * this.facing, this.y, t)
    }
  }

  private updateRock(t: number): void {
    const r = this.rock
    const s = this.rockSprite
    if (!r) { s.visible = false; return }
    const rock = this.strips.rock, brk = this.strips.rock_break
    if (r.broke >= 0) {
      const i = Math.floor((t - r.broke) * 15)
      if (!brk || i >= brk.frames.length) { this.rock = null; s.visible = false; return }
      s.texture = brk.frames[i]
      s.visible = true
      s.x = Math.round(r.x1); s.y = Math.round(r.y1)
      return
    }
    // the flight, in a few hard steps — an arc that peaks a little above the line
    const total = r.miss ? r.dur + 0.28 : r.dur
    const k = (t - r.t0) / total
    if (k >= 1) {
      if (r.miss) { this.rock = null; s.visible = false; return }
      // arrived and nobody said hit or miss yet: hold at the target until they do
    }
    const kk = Math.min(1, k)
    const steps = r.miss ? 8 : 3
    const q = Math.round(kk * steps) / steps
    // a miss keeps going along the same line, past the enemy and off the screen
    const reach = r.miss ? 1 + 0.28 / r.dur * 1.2 : 1
    const x = r.x0 + (r.x1 - r.x0) * q * reach
    const y = r.y0 + (r.y1 - r.y0) * q * reach - Math.round(6 * Math.sin(Math.PI * Math.min(1, q * reach)))
    s.texture = rock?.frames[0] ?? s.texture
    s.visible = Boolean(rock)
    s.x = Math.round(x); s.y = Math.round(y)
  }

  get isHolding(): boolean { return this.holding }
  get isWindingUp(): boolean { return this.pending !== null }
}

// ═══════════════════════════════════════════════════════════════════════════
export class Enemy extends Puppet {
  /** chart time the current attack lands, or -1 */
  private contactT = -1
  dead = false
  private launchT = -9
  /** chart time it was sent off the top of the screen, or -9 */
  private flyT = -9
  /** in the air after an uppercut, whole pixels at 12 steps a second */
  private static LAUNCH = [-5, -9, -12, -13, -13, -11, -8, -4, 0]

  beat(idx: number, phase: number): void {
    const n = this.strips.idle.frames.length
    // two frames a beat: an 8-frame idle loops once a bar
    this.idleFrame = ((idx % 4) * 2 + (phase < 0.5 ? 0 : 1)) % n
  }

  /** hit by the goose.  `strong` plays the whole hurt strip; every hit flashes and shoves. */
  hit(t: number, strong: boolean, shove = 2): void {
    if (this.dead) return
    this.flash(t, 0.07)
    this.knock(t, -shove * this.facing, 0.09)
    if (strong && !this.attacking(t)) this.play('hurt', t, { fps: 14 })
  }

  /** the uppercut: up, a hang at the top, and down, hurting all the way */
  launch(t: number): void {
    if (this.dead) return
    this.launchT = t
    this.flash(t, 0.08)
    this.play('hurt', t, { keys: even(this.strips.hurt?.frames.length ?? 3, 0.25), hold: false })
    this.knock(t, -4 * this.facing, 0.6)
  }

  attacking(t: number): boolean {
    return this.playing?.name === 'attack' && this.busy(t)
  }

  /**
   * Answer a miss.  Returns the chart time the blow lands (the attack's contact
   * frame), or -1 if an attack is already under way and this one is swallowed.
   */
  attack(t: number, contactFrame: number): number {
    if (this.dead || this.attacking(t)) return -1
    const fps = 12
    this.play('attack', t, { fps })
    this.contactT = t + contactFrame / fps
    return this.contactT
  }

  die(t: number): void {
    this.dead = true
    this.play('die', t, { fps: 10 })
  }

  /** beaten: knocked up and off the screen, hurt all the way */
  flyOff(t: number): void {
    this.dead = true
    this.flyT = t
    this.play('hurt', t, { fps: 12, loop: true })
  }

  get flying(): boolean { return this.flyT >= 0 }

  update(t: number): void {
    if (this.flyT >= 0) {
      const age = t - this.flyT
      super.update(t)
      // up and away, faster every frame, a little back; gone past the top
      this.sprite.x = Math.round(this.x - age * 70 * this.facing)
      this.sprite.y = Math.round(this.y - 30 * age - 520 * age * age)
      this.sprite.visible = this.sprite.y > -80
      return
    }
    if (this.dead && this.strips.die) {
      const s = this.strips.die
      const i = Math.min(s.frames.length - 1, Math.floor((t - (this.playing?.t0 ?? t)) * 10))
      this.sprite.texture = s.frames[i]
      this.sprite.scale.x = this.facing
      this.sprite.x = Math.round(this.x)
      this.sprite.y = Math.round(this.y)
      return
    }
    const li = Math.floor((t - this.launchT) * 12)
    const lift = li >= 0 && li < Enemy.LAUNCH.length ? Enemy.LAUNCH[li] : 0
    super.update(t)
    if (lift) this.sprite.y = Math.round(this.y + lift)
  }
}

/** Wrap both in one container so the fight can be moved as a unit. */
export class Fight {
  readonly container = new Container()
  constructor(readonly goose: Goose, readonly enemy: Enemy) {
    this.container.addChild(enemy.sprite, goose.sprite, goose.props)
  }
  /** after placing: tell the goose where its blows land */
  aim(): void {
    this.goose.target = [this.enemy.x + 2 * this.enemy.facing, this.enemy.y - 22]
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/** the least a heavy move is worth winding up for, and the room it needs */
const HEAVY_MIN_WEIGHT = 3
const HEAVY_GAP_AFTER = 0.32
const HEAVY_EVERY = 2.4

interface ChartNote { timestamp: number; weight: number; hit: boolean; hold_duration: number; is_rest: boolean; char: string }

/**
 * The goose reads ahead: if the next note is an accent with room around it and
 * the wind-up would fit, start a heavy move aimed at it.  Called every frame
 * by the renderer with the events from the current one on.
 */
export function planHeavy(goose: Goose, notes: ChartNote[], t: number, rng: () => number): void {
  if (goose.isHolding || goose.isWindingUp || goose.busy(t)) return
  if (t - goose.lastHeavyT < HEAVY_EVERY) return
  let next: ChartNote | null = null
  let after: ChartNote | null = null
  for (const ev of notes) {
    if (ev.is_rest || !ev.char || ev.hit || ev.timestamp < t - 0.05) continue
    if (!next) next = ev
    else { after = ev; break }
  }
  if (!next || next.hold_duration > 0) return
  const w = next.weight >= 0 ? next.weight : 2
  if (w < HEAVY_MIN_WEIGHT) return
  if (after && after.timestamp - next.timestamp < HEAVY_GAP_AFTER) return
  const lead = next.timestamp - t
  // boulders on downbeats, the rest shared; a move only when at least half its wind-up fits
  const order = w >= 4 ? ['boulder', 'uppercut', 'bellyflop'] : ['uppercut', 'bellyflop', 'boulder']
  const pickFrom = rng() < 0.5 ? order : [order[1], order[0], order[2]]
  for (const name of pickFrom) {
    const want = windupSeconds(name)
    if (lead > want + 0.02 || lead < want * 0.5) continue
    if (goose.windup(name, t, next.timestamp)) return
  }
}
