/**
 * The two on the left: the goose, and whoever it is fighting.
 *
 * A `Puppet` is one sprite showing one frame of one strip.  Frames change by
 * snapping — there is no in-between — and the idle is locked to the song: the
 * goose's two idle frames alternate on the beat, the enemy's eight-frame idle
 * steps twice a beat so it loops once a bar.  When the song is fast the
 * characters bob fast; that is the point.
 *
 * Every key of a move has its own duration.  That is what the animation
 * references agree makes a hit feel heavy: a wind-up you can read, one or two
 * keys at full extension held for 100–250 ms, then a fast recovery — "four
 * frames that feel like twelve" — rather than an even fps.  The keys are
 * drawn (web/tools/goose_frames.py): squash, stretch, smears, the body seen
 * from behind or upside down where the move turns it.
 *
 * Quick moves are *reactions*: a correct note plays the move from its contact
 * key, so the hit lands on the press; the wind-up keys before it are what the
 * gallery shows and what a performed move plays.  Heavy moves are
 * *anticipated*: the goose can see the chart, so before an accent it starts
 * the hoist or the crouch (`windup`), timed so the contact key falls exactly on
 * the note.  Land the note and the blow lands; miss it and the goose whiffs —
 * the boulder sails past, the roll goes wide.
 *
 * A key can carry the body: `dx` toward the enemy, `dy` up.  That is how the
 * goose lunges, jumps, and — in the flurry — dashes right round the enemy,
 * punching from above and from behind (a key drawn facing the other way).
 *
 * The enemy takes every hit with a white flash and a shove, the full hurt
 * animation on the accented ones, gets launched by the uppercut, tossed high
 * and tumbling by the beak flip, slammed down by the tail lash, and answers a
 * miss with its attack, whose contact frame is when the goose gets hurt —
 * unless the goose lands the next note first and dodges it.
 */
import { ColorMatrixFilter, Container, Sprite } from 'pixi.js'
import type { Strip } from './assets'

/** one key of a move: how long it shows and where the body is (pixels, before facing) */
export interface Key { dur: number; dx?: number; dy?: number }
interface Move {
  keys: Key[]
  /** the key on which the blow lands; keys before it are the wind-up */
  contact: number
  /** how far the whole goose snaps toward the enemy for the move (keys without their own dx) */
  lunge: number
  /** something other than a slap happens at contact, or on later keys */
  kind?: 'boulder' | 'uppercut' | 'flop' | 'megahonk' | 'dropkick' | 'bodyslam' | 'volley' | 'launch' | 'roll' | 'flurry' | 'dive'
}

/** n keys of `secs` each */
const even = (n: number, secs: number): Key[] => Array.from({ length: n }, () => ({ dur: secs }))

/**
 * Airborne keys are drawn lower in their 64 px frame to leave room overhead
 * (goose_frames.py's `D`), so their `dy` is that offset plus the jump.
 */
const MOVES: Record<string, Move> = {
  // ── quick moves: a reaction plays from `contact`; the gallery and `perform` play the whole ──
  // weight back · crouch · the swing as a smear · CONTACT (held) · overshoot · through · the wing swings back · settle · bounce · home
  slap: {
    keys: [{ dur: 0.04 }, { dur: 0.06 }, { dur: 0.03 }, { dur: 0.1 }, { dur: 0.05 }, { dur: 0.05 }, { dur: 0.05 },
           { dur: 0.06 }, { dur: 0.06 }, { dur: 0.05 }],
    contact: 3, lunge: 12,
  },
  // the head coils · coiled (held) · the STAB (held) · a pixel further · back
  peck: { keys: [{ dur: 0.05 }, { dur: 0.08 }, { dur: 0.09 }, { dur: 0.05 }, { dur: 0.06 }], contact: 2, lunge: 8 },
  // anticipation · crouch (held) · the spring · turning (seen from behind) · turning through · CONTACT out of the spin (held) · through · land · stand
  hop_slap: {
    keys: [{ dur: 0.05 }, { dur: 0.1 }, { dur: 0.06, dy: -14, dx: 2 }, { dur: 0.06, dy: -24, dx: 5 }, { dur: 0.05, dy: -26, dx: 9 },
           { dur: 0.1, dy: -22, dx: 12 }, { dur: 0.06, dy: -12, dx: 14 }, { dur: 0.08, dx: 14 }, { dur: 0.06, dx: 12 }],
    contact: 5, lunge: 12,
  },
  // a step · the spring · the legs swing in · CONTACT: both feet forward (held) · the sweep across · onto the back · the roll · up
  dropkick: {
    keys: [{ dur: 0.06 }, { dur: 0.07, dy: -12, dx: 4 }, { dur: 0.05, dy: -16, dx: 10 }, { dur: 0.12, dy: -14, dx: 16 },
           { dur: 0.06, dy: -10, dx: 18 }, { dur: 0.1, dx: 16 }, { dur: 0.08, dx: 14 }, { dur: 0.08, dx: 12 }],
    contact: 3, lunge: 16, kind: 'dropkick',
  },
  // reach to the hip · grab · raise it, leaning back · held · the crack begins · CONTACT: the lash straight (held) · recoil · slack · coiled
  whip: {
    keys: [{ dur: 0.06 }, { dur: 0.06 }, { dur: 0.08 }, { dur: 0.1 }, { dur: 0.04 }, { dur: 0.1 }, { dur: 0.07 }, { dur: 0.08 }, { dur: 0.08 }],
    contact: 5, lunge: 4,
  },
  // twist · first turn · the wheel, four keys · slowing · settle
  spin: { keys: [{ dur: 0.05 }, { dur: 0.04 }, { dur: 0.05 }, { dur: 0.05 }, { dur: 0.05 }, { dur: 0.05 }, { dur: 0.06 }, { dur: 0.06 }], contact: 2, lunge: 8 },
  // punches from every side, the body carried round the enemy: front · dash up and over · from ABOVE · round the far
  // side · from BEHIND (drawn facing away, mirrored back) · dash back · the BIG one (held) · recover
  flurry: {
    keys: [{ dur: 0.07, dx: 14 }, { dur: 0.05, dx: 26, dy: -22 }, { dur: 0.07, dx: 46, dy: -30 }, { dur: 0.05, dx: 62, dy: -14 },
           { dur: 0.07, dx: 66, dy: -2 }, { dur: 0.05, dx: 30, dy: -12 }, { dur: 0.12, dx: 14 }, { dur: 0.06, dx: 8 }],
    contact: 0, lunge: 14, kind: 'flurry',
  },
  // the follow-up on a fallen enemy: spring · drop · CONTACT: the punch down (held) · bounce off · stand
  dive: {
    keys: [{ dur: 0.05, dx: 6 }, { dur: 0.06, dx: 18, dy: -16 }, { dur: 0.12, dx: 30, dy: -6 }, { dur: 0.07, dx: 26 }, { dur: 0.06, dx: 20 }],
    contact: 2, lunge: 20, kind: 'dive',
  },
  // inhale, three keys, the last held · the neck whips forward · the honk begins · CONTACT (held) · held on · exhale · idle
  megahonk: {
    keys: [{ dur: 0.08 }, { dur: 0.08 }, { dur: 0.14 }, { dur: 0.05 }, { dur: 0.04 }, { dur: 0.14 }, { dur: 0.1 }, { dur: 0.1 }, { dur: 0.06 }],
    contact: 5, lunge: 2, kind: 'megahonk',
  },
  cheer: { keys: [{ dur: 0.14, dy: -4 }, { dur: 0.12 }], contact: 0, lunge: 0 },
  // taken, not given: knocked back on the spot, a stumble, recover
  hurt: { keys: [{ dur: 0.08, dx: -4 }, { dur: 0.1, dx: -8 }, { dur: 0.1, dx: -6 }, { dur: 0.08, dx: -4 }, { dur: 0.08, dx: -2 }], contact: 0, lunge: -6 },
  // the two dodges: drop · FLAT (held) · up · idle, and lean · EDGE-ON (held) · back · idle
  dodge_flat: { keys: [{ dur: 0.04 }, { dur: 0.24 }, { dur: 0.06 }, { dur: 0.05 }], contact: 1, lunge: 0 },
  dodge_side: { keys: [{ dur: 0.04 }, { dur: 0.24 }, { dur: 0.06 }, { dur: 0.05 }], contact: 1, lunge: 0 },

  // ── the heavy ones: a long wind-up the chart lets the goose start early ──
  // squat · grab · heave to the chest · hoist overhead · the spring · the leap · the THROW (the rock is in the air) · it lands · land · stand
  boulder: {
    keys: [{ dur: 0.14 }, { dur: 0.12 }, { dur: 0.14 }, { dur: 0.16, dy: -16 }, { dur: 0.1, dy: -16 }, { dur: 0.14, dy: -38, dx: 4 },
           { dur: 0.08, dy: -36, dx: 6 }, { dur: 0.12, dy: -22, dx: 6 }, { dur: 0.1 }, { dur: 0.08 }],
    contact: 7, lunge: 6, kind: 'boulder',
  },
  // crouch · loaded, wing bent square (held) · the rise · the BLOW · full extension (held) · the hang · the fall · land
  uppercut: {
    keys: [{ dur: 0.12 }, { dur: 0.2 }, { dur: 0.06, dy: -12, dx: 6 }, { dur: 0.1, dy: -20, dx: 12 }, { dur: 0.14, dy: -28, dx: 14 },
           { dur: 0.1, dy: -30, dx: 14 }, { dur: 0.07, dy: -16, dx: 14 }, { dur: 0.1, dx: 12 }],
    contact: 3, lunge: 14, kind: 'uppercut',
  },
  // squat · leap · belly-down over the enemy · the splat (held) · up · stand
  bellyflop: {
    keys: [{ dur: 0.12 }, { dur: 0.14, dy: -26 }, { dur: 0.14, dy: -26, dx: 30 }, { dur: 0.22, dx: 30 },
           { dur: 0.1, dx: 30 }, { dur: 0.08 }],
    contact: 3, lunge: 0, kind: 'flop',
  },
  // coil · spring · rise · the hang, spread at the top (held) · the drop · the SLAM, flat on the enemy (held) · bounce · stand
  bodyslam: {
    keys: [{ dur: 0.12 }, { dur: 0.09, dy: -14 }, { dur: 0.1, dy: -34, dx: 12 }, { dur: 0.24, dy: -46, dx: 30 },
           { dur: 0.06, dy: -20, dx: 38 }, { dur: 0.22, dx: 40 }, { dur: 0.1, dx: 34, dy: -8 }, { dur: 0.1, dx: 30 }],
    contact: 5, lunge: 0, kind: 'bodyslam',
  },
  // the reference combo: squat over the rock · toss it up · watch it hang · load like a batter · the BAT · through ·
  // crouch · dash after it · leap, wing overhead · the SMASH (held) · skid · stand
  volley: {
    keys: [{ dur: 0.12 }, { dur: 0.1 }, { dur: 0.16 }, { dur: 0.14 }, { dur: 0.08, dx: 6 }, { dur: 0.08, dx: 8 }, { dur: 0.08, dx: 8 },
           { dur: 0.07, dx: 22 }, { dur: 0.09, dx: 34, dy: -24 }, { dur: 0.22, dx: 42, dy: -8 }, { dur: 0.12, dx: 42 }, { dur: 0.08, dx: 40 }],
    contact: 9, lunge: 0, kind: 'volley',
  },
  // the beak flip and the lash: the head goes low · coiled under the enemy (held) · the FLIP, the enemy goes high · watch ·
  // dash up · turning over · upside down over it · the TAIL LASH down · falling · land · stand
  launch: {
    keys: [{ dur: 0.1, dx: 8 }, { dur: 0.18, dx: 8 }, { dur: 0.1, dx: 8 }, { dur: 0.1, dx: 6 }, { dur: 0.07, dy: -30, dx: 10 },
           { dur: 0.07, dy: -52, dx: 18 }, { dur: 0.1, dy: -62, dx: 30 }, { dur: 0.12, dy: -52, dx: 34 }, { dur: 0.08, dy: -26, dx: 32 },
           { dur: 0.1, dx: 30 }, { dur: 0.08, dx: 28 }],
    contact: 2, lunge: 8, kind: 'launch',
  },
  // the roll: tuck · the ball (held) · in · HIT the enemy against the wall · bounce back · in · hit · back · in · hit · unroll · stand
  roll: {
    keys: [{ dur: 0.12 }, { dur: 0.16 }, { dur: 0.06, dx: 10 }, { dur: 0.1, dx: 26 }, { dur: 0.07, dx: 12 }, { dur: 0.06, dx: 20 },
           { dur: 0.1, dx: 28 }, { dur: 0.07, dx: 14 }, { dur: 0.06, dx: 22 }, { dur: 0.1, dx: 28 }, { dur: 0.08, dx: 20 }, { dur: 0.08, dx: 10 }],
    contact: 3, lunge: 0, kind: 'roll',
  },
}

/**
 * The authored keys of a move, copied — for anything that wants to play the
 * whole of it rather than react with it (the move gallery's looping grid).
 */
export function moveKeys(name: string): Key[] | null {
  const mv = MOVES[name]
  return mv ? mv.keys.map((k) => ({ ...k })) : null
}

/** the heavy moves, and how long their wind-up takes */
export const HEAVY = ['boulder', 'uppercut', 'bellyflop', 'bodyslam', 'volley', 'launch', 'roll', 'megahonk']
export function windupSeconds(name: string): number {
  const mv = MOVES[name]
  if (!mv) return 0
  let s = 0
  for (let i = 0; i < mv.contact; i++) s += mv.keys[i].dur
  return s
}

/** moves by the note's metric weight: accents get the big ones, sixteenths the quick ones */
const BY_WEIGHT: Record<number, string[]> = {
  4: ['hop_slap', 'flurry', 'dropkick', 'whip', 'slap'],
  3: ['slap', 'hop_slap', 'whip', 'dropkick', 'flurry'],
  2: ['slap', 'peck', 'whip', 'slap'],
  1: ['peck', 'slap', 'peck'],
  0: ['peck', 'slap'],
}
/** how long a quick move takes from its contact key on: the room it needs before the next note */
function tailSeconds(name: string): number {
  const mv = MOVES[name]
  if (!mv) return 0.2
  let s = 0
  for (let i = mv.contact; i < mv.keys.length; i++) s += mv.keys[i].dur
  return s
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

/** every colour to white, alpha kept: the hit flash, on whatever frame is showing */
const WHITE_FLASH = new ColorMatrixFilter()
WHITE_FLASH.matrix = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]

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
  protected flashFrom = -9
  /** idle frame chosen from the beat; set by `beat()` */
  protected idleFrame = 0
  protected shove = 0
  protected shoveY = 0
  protected shoveUntil = -9
  /** hitstop: the frame on screen is held until this time */
  private freezeUntil = -9
  private freezeHeld = false
  private heldT = NaN
  private heldRes = false
  /** the key currently shown, for callers that key effects to frames */
  protected keyIdx = -1
  get keyIndex(): number { return this.keyIdx }

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

  /** the white flash of a hit: every colour of whatever frame is showing goes white, blinking twice a strong one */
  flash(t: number, seconds = 0.1): void { this.flashFrom = t; this.flashUntil = t + seconds }

  /** knocked a few pixels for a moment — sideways, and down or up if the blow came from above or below */
  knock(t: number, px: number, seconds = 0.1, py = 0): void { this.shove = px; this.shoveY = py; this.shoveUntil = t + seconds }

  /**
   * Hitstop: hold whatever frame is showing for `seconds`.  The first update
   * after the call still draws (so the contact frame is what gets held), the
   * rest are skipped; nothing about the move's timing changes.
   */
  freeze(t: number, seconds: number): void { this.freezeUntil = t + seconds; this.freezeHeld = false }

  /** true when this frame is held by a hitstop; one answer per `t` */
  protected isHeld(t: number): boolean {
    if (t !== this.heldT) {
      this.heldT = t
      this.heldRes = t < this.freezeUntil && this.freezeHeld
      if (!this.heldRes) this.freezeHeld = t < this.freezeUntil
    }
    return this.heldRes
  }

  /** the beat, so the idle can follow it: index and 0..1 phase */
  beat(_idx: number, _phase: number): void { /* per character */ }

  update(t: number): void {
    if (this.isHeld(t)) return
    this.render(t)
  }

  /** the frame for `t`: texture, lunge, shove, flash — the body of `update` */
  protected render(t: number): void {
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
    this.sprite.texture = tex
    // the flash: on for the first two thirds, off a moment, on again — a blink, not a smear
    let white = false
    if (t < this.flashUntil) {
      const q = (t - this.flashFrom) / Math.max(1e-3, this.flashUntil - this.flashFrom)
      white = q < 0.55 || q > 0.72
    }
    const cur = this.sprite.filters as unknown[] | null
    const has = Array.isArray(cur) && cur.length > 0
    if (white !== has) this.sprite.filters = white ? [WHITE_FLASH] : []
    const shove = t < this.shoveUntil ? this.shove : 0
    const shoveY = t < this.shoveUntil ? this.shoveY : 0
    this.sprite.scale.x = this.facing
    this.sprite.x = Math.round(this.x + this.dx * this.facing + shove)
    this.sprite.y = Math.round(this.y + this.dy + shoveY)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/** what a heavy move has going: the note it is aimed at, and whether it has been resolved */
interface Pending { name: string; contactAt: number; start: number }
/**
 * The boulder in flight.  `arc`: from the goose's wings to the enemy, or past
 * it (the boulder move).  `toss`: straight up off the wings, slowing to a hang
 * (the volley), then `shot`: batted flat at the enemy.
 */
interface Rock {
  t0: number; x0: number; y0: number; x1: number; y1: number; dur: number; miss: boolean; broke: number
  mode: 'arc' | 'toss' | 'shot'
}

export type GooseEvent = 'windup' | 'throw' | 'rock_break' | 'rock_miss' | 'land' | 'flop' | 'uppercut' | 'megahonk' | 'whiff' | 'dropkick'
  | 'jump' | 'slam' | 'volley_toss' | 'volley_bat' | 'volley_rock' | 'volley_dash' | 'volley_smash'
  | 'launch' | 'lash' | 'roll_hit' | 'roll_miss' | 'flurry_above' | 'flurry_behind' | 'flurry_big' | 'dive' | 'dodge' | 'whip_release'

/** a heavy move chosen for a coming accent, waiting for its wind-up window */
interface Plan { name: string; at: number }

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
  /** the heavy move `planHeavy` has picked for the next accent, if any */
  plan: Plan | null = null
  /** after a lash the next note within this time is the second punch */
  private followUpUntil = -9
  private dodgeFlip = false

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
    // the enemy is down from the lash: the second punch
    if (t < this.followUpUntil && this.has('dive')) { this.followUpUntil = -9; return this.fire('dive', t) }
    let list = BY_WEIGHT[Math.max(0, Math.min(4, weight))] ?? BY_WEIGHT[2]
    // only moves whose tail fits before the next note (the flurry takes half a second; a peck, a tenth)
    list = list.filter((m) => tailSeconds(m) <= Math.max(0.16, gap + 0.06))
    if (judgment !== 'perfect') list = list.filter((m) => m !== 'dropkick' && m !== 'flurry')
    if (!list.length) list = gap < 0.2 ? ['peck'] : ['slap']
    return this.fire(this.pick(list), t)
  }

  /** play a quick move from its contact key and raise the event its kind owes */
  private fire(name: string, t: number): string {
    if (!this.has(name)) return ''
    this.move(name, t)
    this.kindEvents(name, t)
    return name
  }

  /** the event a quick move's kind owes at its contact */
  private kindEvents(name: string, t: number): void {
    const mv = MOVES[name]
    if (mv?.kind === 'megahonk') this.onEvent('megahonk', this.x - 12, this.y - 24, t)
    if (mv?.kind === 'dropkick') this.onEvent('dropkick', this.target[0], this.target[1], t)
    if (mv?.kind === 'dive') this.onEvent('dive', this.target[0], this.target[1] + 10, t)
  }

  /**
   * Play `name` on purpose (the gallery, a scripted moment), whole.  A heavy
   * move winds up from now and lands on its own when its contact time comes.
   * A quick move plays every key from the first — the wind-up a reaction would
   * skip included — lunging from its contact key on; `update` reports the blow
   * at that moment through `takeLanded`.  Returns the move, or '' if it could
   * not start.
   */
  perform(name: string, t: number): string {
    if (!this.has(name) || this.holding) return ''
    if (HEAVY.includes(name)) {
      if (!this.windup(name, t, t + windupSeconds(name) + 0.02)) return ''
      this.autoLand = true
      return name
    }
    const mv = MOVES[name]
    if (!mv) return this.fire(name, t)
    const keys = mv.keys.map((k, i) => (i >= mv.contact && k.dx === undefined ? { ...k, dx: mv.lunge } : k))
    this.play(name, t, { keys, from: 0, count: keys.length })
    this.dx = keys[0].dx ?? 0
    this.dy = keys[0].dy ?? 0
    this.lastKeySeen = -1
    this.fullContact = { name, at: t + windupSeconds(name) }
    return name
  }

  /** a quick move performed whole: its contact still to come */
  private fullContact: { name: string; at: number } | null = null

  /** set by `perform`: the pending heavy move lands by itself at its contact time */
  private autoLand = false
  /** the move that landed by itself this frame, for the caller to dress; cleared when read */
  takeLanded(): string {
    const m = this.landed
    this.landed = ''
    return m
  }
  private landed = ''

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
    this.dx = keys[0]?.dx ?? 0
    this.pending = { name, contactAt, start }
    this.plan = null
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
    this.missing = miss
    switch (mv.kind) {
      case 'boulder':
        // the rock is already flying: it breaks on the enemy, or sails past
        if (this.rock) {
          if (miss) { this.rock.miss = true; this.onEvent('rock_miss', this.rock.x1, this.rock.y1, t) }
          else { this.rock.broke = t; this.onEvent('rock_break', this.rock.x1, this.rock.y1, t) }
        }
        this.move(name, t)
        return
      case 'uppercut':
        this.move(name, t)
        if (miss) this.onEvent('whiff', this.x + 14 * this.facing, this.y - 30, t)
        else this.onEvent('uppercut', this.target[0], this.target[1], t)
        return
      case 'flop':
        // a miss flops short, onto the ground between them
        this.move(name, t)
        if (miss) { this.dx = 14; this.onEvent('whiff', this.x + 14 * this.facing, this.y, t) }
        this.onEvent('flop', miss ? this.x + 14 * this.facing : this.target[0], this.y, t)
        return
      case 'bodyslam':
        this.move(name, t)
        if (miss) { this.dx = 22; this.onEvent('whiff', this.x + 22 * this.facing, this.y, t); return }
        this.onEvent('slam', this.target[0], this.y, t)
        return
      case 'volley':
        // the rock already landed on its own key; the smash is what the note decides
        this.move(name, t)
        if (miss) { this.onEvent('whiff', this.x + 40 * this.facing, this.y - 10, t); return }
        this.onEvent('volley_smash', this.target[0], this.target[1], t)
        return
      case 'launch':
        // the flip: the enemy goes high; the lash comes on its own key
        this.move(name, t)
        if (miss) { this.onEvent('whiff', this.x + 12 * this.facing, this.y - 30, t); return }
        this.onEvent('launch', this.target[0], this.target[1], t)
        return
      case 'roll':
        // the first hit against the wall; two more come on their keys
        this.move(name, t)
        if (miss) { this.onEvent('roll_miss', this.x + 26 * this.facing, this.y - 10, t); return }
        this.onEvent('roll_hit', this.target[0], this.target[1], t)
        return
      case 'megahonk':
        this.move(name, t)
        if (miss) { this.onEvent('whiff', this.x - 8 * this.facing, this.y - 30, t); return }
        this.onEvent('megahonk', this.x - 12, this.y - 24, t)
        return
      default:
        this.move(name, t)
    }
  }
  /** the heavy move under way was a whiff: its later keys hit nothing */
  private missing = false

  // ── holds ────────────────────────────────────────────────────────────────
  /** a hold begins: the lash cracks on the press, then stays taut until release */
  holdStart(t: number): void {
    this.pending = null
    this.holding = true
    this.holdKind = 'whip'
    this.move('whip', t, 1)
  }

  /** the hold ends: the recoil, and — clean — the release everyone feels */
  holdEnd(t: number, clean: boolean): void {
    this.holding = false
    this.holdKind = null
    this.stop()
    const mv = MOVES.whip
    this.play('whip', t, { keys: mv.keys.slice(6), from: 6, count: 3 })
    this.dx = 4
    this.lastKeySeen = -1
    if (clean) this.onEvent('whip_release', this.target[0], this.target[1], t)
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
    if (clean) this.move('slap', t)
  }

  /** the word is done: a big honk when the word was clean and nothing else is on */
  honk(t: number, big = false): void {
    if (this.holding || this.pending || this.busy(t)) return
    if (big && this.has('megahonk')) { this.move('megahonk', t); this.onEvent('megahonk', this.x - 12, this.y - 24, t) }
  }

  cheer(t: number): void {
    if (this.holding || this.pending) return
    this.move('cheer', t)
  }

  hurt(t: number): void {
    this.holding = false
    this.holdKind = null
    this.pending = null
    this.followUpUntil = -9
    this.play('hurt', t, { keys: MOVES.hurt.keys })
    this.dx = -4
    this.flash(t, 0.1)
  }

  /** the enemy's blow was coming and the goose read it: flat to the ground, or a step out of the plane */
  dodge(t: number): void {
    if (this.holding || this.pending) return
    this.dodgeFlip = !this.dodgeFlip
    const name = this.dodgeFlip ? 'dodge_flat' : 'dodge_side'
    if (!this.has(name)) return
    this.play(name, t, { keys: MOVES[name].keys })
    this.dx = 0
    this.lastKeySeen = -1
    this.onEvent('dodge', this.x, this.y - 12, t)
  }

  update(t: number): void {
    // the crack is over: keep the lash taut for as long as the key is down
    if (this.holding && this.holdKind === 'whip' && this.current !== 'whip_hold' && !this.busy(t)) {
      this.play('whip_hold', t, { loop: true, fps: 4 })
      this.dx = 4
    }
    // a heavy move wound up for a note that never came — or, performed on purpose, one that lands itself
    const p = this.pending
    if (p && this.autoLand && t >= p.contactAt) { this.autoLand = false; this.landed = this.hit(t, 4, 'perfect', 1) }
    else if (p && t > p.contactAt + 0.25) { this.autoLand = false; this.whiff(t) }
    const fc = this.fullContact
    if (fc && t >= fc.at) { this.fullContact = null; this.kindEvents(fc.name, t); this.landed = fc.name }
    if (this.isHeld(t)) return
    this.render(t)
    this.keyEvents(t)
    this.updateRock(t)
  }

  /** effects that belong to a key: the throw, the landing, the lash, the later hits of a roll */
  private keyEvents(t: number): void {
    const p = this.playing
    const i = this.keyIdx
    if (!p || i < 0 || i === this.lastKeySeen) return
    this.lastKeySeen = i
    const mv = MOVES[p.name]
    if (!mv) return
    const abs = p.from + i
    const fx = this.x + this.dx * this.facing
    if (mv.kind === 'boulder' && abs === 6 && !this.rock) {
      // the throw: the rock leaves the wings, arrives on the note
      const k = mv.keys[6]
      const x0 = this.x + (k.dx ?? 0) * this.facing + 8 * this.facing
      const y0 = this.y + (k.dy ?? 0) - 40
      const dur = this.pending ? Math.max(0.06, this.pending.contactAt - t) : 0.1
      this.rock = { t0: t, x0, y0, x1: this.target[0], y1: this.target[1], dur, miss: false, broke: -1, mode: 'arc' }
      this.onEvent('throw', x0, y0, t)
    }
    if (mv.kind === 'boulder' && abs === 8) this.onEvent('land', fx, this.y, t)
    if (mv.kind === 'volley') {
      if (abs === 1 && !this.rock) {
        // the toss: straight up off the wings, slowing to a hang over the goose's head
        const x0 = fx + 4 * this.facing, y0 = this.y - 32
        this.rock = { t0: t, x0, y0, x1: x0, y1: y0 - 34, dur: p.keys[1].dur + p.keys[2].dur + p.keys[3].dur, miss: false, broke: -1, mode: 'toss' }
        this.onEvent('volley_toss', x0, y0, t)
      }
      if (abs === 4 && this.rock) {
        // the bat: from wherever it hangs, flat at the enemy, arriving as the next key starts
        const r = this.rock
        const [rx, ry] = this.rockPos(t)
        r.mode = 'shot'; r.t0 = t; r.x0 = rx; r.y0 = ry; r.x1 = this.target[0]; r.y1 = this.target[1]; r.dur = Math.max(0.05, p.keys[4].dur)
        this.onEvent('volley_bat', fx + 12 * this.facing, this.y - 34, t)
      }
      if (abs === 5) {
        this.rock = null
        this.rockSprite.visible = false
        this.onEvent('volley_rock', this.target[0], this.target[1], t)
      }
      if (abs === 7) this.onEvent('volley_dash', this.x + 2 * this.facing, this.y - 8, t)
      if (abs === 10) this.onEvent('land', fx, this.y, t)
    }
    if (mv.kind === 'bodyslam') {
      if (abs === 1) this.onEvent('jump', this.x, this.y, t)
      if (abs === 7) this.onEvent('land', fx, this.y, t)
    }
    if (mv.kind === 'launch') {
      if (abs === 4) this.onEvent('jump', fx, this.y, t)
      if (abs === 7 && !this.missing) { this.onEvent('lash', this.target[0], this.target[1], t); this.followUpUntil = t + 0.6 }
      if (abs === 9) this.onEvent('land', fx, this.y, t)
    }
    if (mv.kind === 'roll' && (abs === 6 || abs === 9) && !this.missing) this.onEvent('roll_hit', this.target[0], this.target[1], t)
    if (mv.kind === 'flurry') {
      if (abs === 2) this.onEvent('flurry_above', this.target[0], this.target[1] - 10, t)
      if (abs === 4) this.onEvent('flurry_behind', this.target[0], this.target[1], t)
      if (abs === 6) this.onEvent('flurry_big', this.target[0], this.target[1], t)
    }
    if ((mv.kind === 'uppercut' && abs === 7) || (p.name === 'hop_slap' && abs === 7) || (mv.kind === 'dropkick' && abs === 5)
        || (mv.kind === 'dive' && abs === 3)) {
      this.onEvent('land', fx, this.y, t)
    }
    if (p.name === 'hop_slap' && abs === 2) this.onEvent('jump', this.x, this.y, t)
  }

  /** where the rock is right now, by its mode */
  private rockPos(t: number): [number, number] {
    const r = this.rock!
    if (r.mode === 'toss') {
      // up fast, slowing to the hang: six hard steps along an ease-out
      const q = Math.min(1, (t - r.t0) / Math.max(0.01, r.dur))
      const e = 1 - (1 - q) * (1 - q)
      const qq = Math.round(e * 6) / 6
      return [r.x0, r.y0 + (r.y1 - r.y0) * qq]
    }
    if (r.mode === 'shot') {
      const q = Math.min(1, (t - r.t0) / Math.max(0.01, r.dur))
      const qq = Math.round(q * 3) / 3
      return [r.x0 + (r.x1 - r.x0) * qq, r.y0 + (r.y1 - r.y0) * qq]
    }
    // the arc, in a few hard steps, peaking a little above the line
    const total = r.miss ? r.dur + 0.28 : r.dur
    const k = (t - r.t0) / total
    const kk = Math.min(1, k)
    const steps = r.miss ? 8 : 3
    const q = Math.round(kk * steps) / steps
    // a miss keeps going along the same line, past the enemy and off the screen
    const reach = r.miss ? 1 + 0.28 / r.dur * 1.2 : 1
    const x = r.x0 + (r.x1 - r.x0) * q * reach
    const y = r.y0 + (r.y1 - r.y0) * q * reach - Math.round(6 * Math.sin(Math.PI * Math.min(1, q * reach)))
    return [x, y]
  }

  private updateRock(t: number): void {
    const r = this.rock
    const s = this.rockSprite
    if (!r) { s.visible = false; return }
    const rock = this.strips.rock, brk = this.strips.rock_break
    if (r.broke >= 0) {
      const i = Math.floor((t - r.broke) * 16)
      if (!brk || i >= brk.frames.length) { this.rock = null; s.visible = false; return }
      s.texture = brk.frames[i]
      s.visible = true
      s.x = Math.round(r.x1); s.y = Math.round(r.y1)
      return
    }
    // a missed arc sails off; anything else that has arrived holds where it is until told what happened
    if (r.mode === 'arc' && r.miss && (t - r.t0) / (r.dur + 0.28) >= 1) { this.rock = null; s.visible = false; return }
    const [x, y] = this.rockPos(t)
    s.texture = rock?.frames[0] ?? s.texture
    s.visible = Boolean(rock)
    s.x = Math.round(x); s.y = Math.round(y)
  }

  get isHolding(): boolean { return this.holding }
  get isWindingUp(): boolean { return this.pending !== null }
  /** true while the lash's second punch is on offer */
  get followUpOpen(): boolean { return this.followUpUntil > 0 }
}

// ═══════════════════════════════════════════════════════════════════════════
export class Enemy extends Puppet {
  /** chart time the current attack lands, or -1 */
  private contactT = -1
  dead = false
  private launchT = -9
  /** the beak flip: up high and tumbling, from when, for how long, how high */
  private tossT = -9
  private tossDur = 0
  private tossH = 0
  /** slammed out of the toss by the lash: from when */
  private slamT = -9
  private slamFromY = 0
  /** chart time it was sent off the top of the screen, or -9 */
  private flyT = -9
  /** in the air after an uppercut, whole pixels at 12 steps a second */
  private static LAUNCH = [-5, -9, -12, -13, -13, -11, -8, -4, 0]

  beat(idx: number, phase: number): void {
    const n = this.strips.idle.frames.length
    // two frames a beat: an 8-frame idle loops once a bar
    this.idleFrame = ((idx % 4) * 2 + (phase < 0.5 ? 0 : 1)) % n
  }

  /**
   * Hit by the goose.  `strong` plays the whole hurt strip; every hit flashes
   * white and shoves — back, and `down` pixels into the ground when the blow
   * came from above (a slam), for `secs`.  `dir` +1 shoves it toward the wall
   * behind it (the usual), -1 toward the goose (a punch from behind).
   */
  hit(t: number, strong: boolean, shove = 2, down = 0, secs = 0.09, dir = 1): void {
    if (this.dead) return
    this.flash(t, strong ? 0.14 : 0.1)
    this.knock(t, -shove * this.facing * dir, secs, down)
    if (strong && !this.attacking(t) && this.tossT < 0) this.play('hurt', t, { fps: 14 })
  }

  /** the uppercut: up, a hang at the top, and down, hurting all the way */
  launch(t: number): void {
    if (this.dead) return
    this.launchT = t
    this.flash(t, 0.1)
    this.play('hurt', t, { keys: even(this.strips.hurt?.frames.length ?? 3, 0.25), hold: false })
    this.knock(t, -4 * this.facing, 0.6)
  }

  /** the beak flip: thrown high, tumbling as it goes, hanging at the top until the lash */
  toss(t: number, height = 62, dur = 0.7): void {
    if (this.dead) return
    this.tossT = t
    this.tossDur = dur
    this.tossH = height
    this.slamT = -9
    this.flash(t, 0.1)
    this.play('hurt', t, { keys: even(this.strips.hurt?.frames.length ?? 3, 0.12), loop: true })
  }

  /** the lash: out of the toss and straight down into the ground */
  slamDown(t: number): void {
    if (this.tossT < 0) return
    this.slamFromY = this.airLift(t)
    this.slamT = t
    this.flash(t, 0.12)
  }

  /** how far above the ground the toss has it, in pixels (negative), right now */
  airLift(t: number): number {
    if (this.tossT < 0) return 0
    if (this.slamT >= 0) {
      const q = Math.min(1, (t - this.slamT) / 0.12)
      return Math.round(this.slamFromY * (1 - q * q))
    }
    const q = Math.min(1, (t - this.tossT) / this.tossDur)
    // up fast, slowing to the hang: hard steps
    const e = 1 - (1 - q) * (1 - q)
    return -Math.round((Math.round(e * 8) / 8) * this.tossH)
  }

  get airborne(): boolean { return this.tossT >= 0 }

  attacking(t: number): boolean {
    return this.playing?.name === 'attack' && this.busy(t)
  }

  /**
   * Answer a miss.  Returns the chart time the blow lands (the attack's contact
   * frame), or -1 if an attack is already under way and this one is swallowed.
   */
  attack(t: number, contactFrame: number): number {
    if (this.dead || this.attacking(t) || this.tossT >= 0) return -1
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
      this.sprite.rotation = 0
      this.sprite.x = Math.round(this.x)
      this.sprite.y = Math.round(this.y)
      return
    }
    // the toss: hanging until the lash brings it down, or falling on its own after a while
    if (this.tossT >= 0) {
      const over = this.slamT >= 0 ? t - this.slamT > 0.14 : t - this.tossT > this.tossDur + 1.2
      if (over) {
        this.tossT = -9
        this.slamT = -9
        this.sprite.rotation = 0
        this.sprite.anchor.set(0.5, this.feet / this.fh)
        this.play('hurt', t, { fps: 14 })
      }
    }
    const li = Math.floor((t - this.launchT) * 12)
    const lift = li >= 0 && li < Enemy.LAUNCH.length ? Enemy.LAUNCH[li] : 0
    super.update(t)
    if (lift) this.sprite.y = Math.round(this.y + lift)
    if (this.tossT >= 0) {
      // tumbling: a quarter turn every tenth of a second on the way up, laid flat and falling after the lash
      const air = this.airLift(t)
      const turns = this.slamT >= 0 ? 6 : Math.floor((t - this.tossT) / 0.1)
      this.sprite.anchor.set(0.5, 0.5)
      this.sprite.rotation = (turns % 4) * Math.PI / 2 * -this.facing
      this.sprite.y = Math.round(this.y - (this.fh - this.feet) - 12 + air)
    }
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

interface ChartNote {
  timestamp: number; weight: number; hit: boolean; hold_duration: number; is_rest: boolean; char: string
  word_text?: string; char_idx?: number
}

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
  // one move is chosen per accent and kept, so the long ones get their turn: the rock moves and the
  // combos want a downbeat, the rest take any accent; the last letter of a word is the honk's
  if (!goose.plan || goose.plan.at !== next.timestamp) {
    const lastOfWord = next.word_text !== undefined && next.char_idx === next.word_text.length - 1
    let pool = w >= 4 ? ['boulder', 'volley', 'bodyslam', 'launch', 'roll', 'uppercut', 'bellyflop'] : ['uppercut', 'bellyflop', 'bodyslam', 'launch']
    if (lastOfWord) pool = ['megahonk', 'megahonk', ...pool]
    // the roll and the lash need room after them too
    const room = after ? after.timestamp - next.timestamp : 9
    if (room < 0.9) pool = pool.filter((n) => n !== 'roll' && n !== 'launch')
    const fits = pool.filter((n) => goose.has(n) && lead >= windupSeconds(n) * 0.5)
    if (!fits.length) return
    goose.plan = { name: fits[Math.floor(rng() * fits.length)], at: next.timestamp }
  }
  const name = goose.plan.name
  const want = windupSeconds(name)
  // too early: wait for the window; too late: let it go
  if (lead > want + 0.02) return
  if (lead < want * 0.5) { goose.plan = null; return }
  if (!goose.windup(name, t, next.timestamp)) goose.plan = null
}
