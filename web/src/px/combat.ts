/**
 * What the goose's moves look and sound like, shared by both play screens and
 * the move gallery.
 *
 * `actors.ts` decides *what* happens — the rock leaves the wings, the enemy is
 * tossed, the goose lands — and reports it as a `GooseEvent`.  This turns each
 * into effects, the synthesised sound, and a kick of the camera where the blow
 * deserves one.
 *
 * The rule here is that the move is the thing and the effects only underline
 * it.  The frames themselves carry the motion now — smears, ghosts, dust are
 * drawn into them — so a quick blow gets at most two marks: the **trail** its
 * wing leaves (a line-art arc from the hit packs, anchored to the goose and
 * oriented the way the wing travelled) and the **spark** where it lands on the
 * enemy.  The heavy moves earn more — the ground ring of a slam, the pillar of
 * the smash, the kanji stamp, the inverted frame, a hitstop — because they are
 * rare and wound up for.  Every hit flashes the enemy white.
 */
import type { Fight, GooseEvent } from './actors'
import type { FxLayer } from './fx'

export type Sfx = (name: string, delay?: number) => void

/** the kanji a heavy blow stamps behind the enemy, and its colour — the way an anime cut does */
export const KANJI_OF: Record<string, [string, number]> = {
  uppercut: ['fist', 0xffde7b], boulder: ['rock', 0xc8ccd4], bellyflop: ['crush', 0xffa26b],
  dropkick: ['kick', 0x8effc2], megahonk: ['roar', 0xff607a],
  bodyslam: ['power', 0xffa26b], volley: ['strike', 0xffde7b],
  launch: ['soar', 0x9ad8ff], lash: ['lash', 0xffde7b], roll: ['roll', 0xc8ccd4],
  flurry: ['swift', 0xffde7b], dive: ['crush', 0xffa26b], whip_release: ['strike', 0xff9ad8],
}

export interface CombatHooks {
  /** the camera kicks `px` pixels and settles */
  kick?: (px: number) => void
  /** a small word over the goose: the "!" of a wind-up */
  mark?: (text: string, x: number, y: number, t: number) => void
  /** a big kanji behind the blow: `name` is a KANJI_OF key, `big` the 48 px face */
  kanji?: (name: string, color: number, x: number, y: number, t: number, big: boolean) => void
  /** the whole frame inverts for a few frames */
  invert?: (t: number, secs: number) => void
}

/**
 * One effect placed relative to a point, in *spec space*: forward is +x, and
 * the packs are drawn for a blow travelling to the right.  `facing` mirrors
 * the whole thing (and reverses the quarter turns) so it reads the same for a
 * goose facing left.  `fixed` opts out of that for symmetrical or vertical
 * things — a ring, a pillar.
 */
interface Mark {
  fx: string
  dx: number
  dy: number
  /** mirror in spec space (the pack's native direction is backward) */
  flip?: boolean
  /** whole quarter turns, clockwise on screen */
  turns?: number
  /** play faster than the pack's 15 fps */
  fps?: number
  ax?: number
  ay?: number
  fixed?: boolean
  /** seconds after the blow */
  delay?: number
  /** begin part-way into the strip: the first frames of some packs are a dot */
  start?: number
}

/** how a quick move dresses its hit */
interface Look {
  /** the wing's trail, anchored to the goose's feet after the lunge */
  trail?: Mark
  /** where it lands, anchored to the enemy's chest */
  spark?: Mark
  /** pixels the enemy is shoved back, and down */
  shove: number
  down?: number
  /** camera kick, pixels */
  kick?: number
  /** hitstop for both, seconds */
  stop?: number
  sfx: string[]
}

const LOOKS: Record<string, Look> = {
  // the slap: a full-size forward swipe off the wing — the drawn smear carries the swing, this is the crack of it
  slap: { trail: { fx: 'arc_c', dx: 22, dy: -18, fps: 30 }, spark: { fx: 'star_s', dx: 0, dy: -2 }, shove: 3, kick: 1, sfx: ['slap'] },
  // a jab: no trail, the debris fans away from the beak
  peck: { spark: { fx: 'spray_s', dx: 2, dy: -2, fps: 24 }, shove: 1, sfx: ['peck'] },
  // the slap out of the spin, down and forward
  hop_slap: { trail: { fx: 'arc_down', dx: 14, dy: -18, fps: 30 }, spark: { fx: 'star_s', dx: 0, dy: -4 }, shove: 3, down: 1, kick: 1, sfx: ['slap@0.0'] },
  // the lash cracks: an X where the tip lands, the lash itself is drawn
  whip: { spark: { fx: 'cross', dx: 0, dy: -4, fps: 30 }, shove: 3, kick: 1, sfx: ['whip'] },
  // a turn: a ring round the goose
  spin: { trail: { fx: 'ring_s', dx: 0, dy: -14, fps: 30, fixed: true }, spark: { fx: 'cross_s', dx: 0, dy: -4, fps: 30 }, shove: 2, sfx: ['whoosh', 'slap@0.04'] },
  // the first punch of the flurry; the rest come as events from their keys
  flurry: { spark: { fx: 'star_s', dx: 0, dy: -4, fps: 30 }, shove: 2, sfx: ['slap2'] },
  cheer: { shove: 0, sfx: [] },
}

/** moves whose sound and enemy reaction are made by their events; `blow` adds nothing */
export const SELF_VOICED = new Set(['boulder', 'uppercut', 'bellyflop', 'megahonk', 'dropkick', 'bodyslam', 'volley', 'launch', 'roll', 'dive'])

export class Combat {
  constructor(private fight: Fight, private fx: FxLayer, private sfx: Sfx, private hooks: CombatHooks = {}) {}

  /** the goose's `onEvent`, bound */
  readonly onEvent = (ev: GooseEvent, x: number, y: number, t: number): void => this.event(ev, x, y, t)

  // ── placing ─────────────────────────────────────────────────────────────
  private place(m: Mark, ox: number, oy: number, t: number): void {
    const facing = this.fight.goose.facing
    const mirror = !m.fixed && facing === -1
    const turns = m.turns ?? 0
    this.fx.spawn(m.fx, ox + m.dx * facing, oy + m.dy, t + (m.delay ?? 0), {
      flipX: (m.flip ?? false) !== mirror,
      quarterTurns: mirror ? (4 - turns) % 4 : turns,
      fps: m.fps, ax: m.ax, ay: m.ay, startFrame: m.start,
    })
  }

  /** at the goose's feet, after its lunge */
  private atGoose(m: Mark, t: number): void {
    const g = this.fight.goose
    this.place(m, g.x + g.dx * g.facing, g.y + g.dy, t)
  }

  /** at the enemy's chest */
  private atTarget(m: Mark, t: number): void {
    const [tx, ty] = this.fight.goose.target
    this.place(m, tx, ty, t)
  }

  private play(names: string[]): void {
    for (const n of names) {
      const [name, d] = n.split('@')
      this.sfx(name, d ? Number(d) : 0)
    }
  }

  private stamp(move: string, x: number, y: number, t: number, big = true): void {
    const k = KANJI_OF[move]
    if (k && this.hooks.kanji) { this.hooks.kanji(k[0], k[1], x, y, t, big); this.sfx('kanji') }
  }

  private stop(t: number, secs: number): void {
    this.fight.goose.freeze(t, secs)
    this.fight.enemy.freeze(t, secs)
  }

  // ── a quick blow ────────────────────────────────────────────────────────
  /**
   * The goose just played `mv` on a correct note.  Sound it, land it on the
   * enemy, and mark it — once at the wing, once where it hit.  Heavy moves are
   * skipped here: their events did all of this.
   */
  blow(mv: string, judgment: string, weight: number, t: number): void {
    if (!mv || SELF_VOICED.has(mv)) return
    const { enemy } = this.fight
    const look = LOOKS[mv] ?? { spark: { fx: 'star_s', dx: 0, dy: -4 }, shove: 2, sfx: ['slap'] }
    this.play(look.sfx.map((s) => (s === 'slap' && Math.random() < 0.5 ? 'slap2' : s)))
    const strong = weight >= 3 || (judgment === 'perfect' && mv === 'hop_slap')
    if (strong && !look.sfx.some((s) => s.startsWith('enemy_hit'))) this.sfx('enemy_hit', 0.03)
    enemy.hit(t, strong, look.shove, look.down ?? 0)
    if (look.trail) this.atGoose(look.trail, t)
    if (look.spark) this.atTarget(look.spark, t)
    if (look.kick) this.hooks.kick?.(look.kick)
    if (look.stop) this.stop(t, look.stop)
  }

  // ── the events of the heavy moves ───────────────────────────────────────
  private event(ev: GooseEvent, x: number, y: number, t: number): void {
    const { goose, enemy } = this.fight
    const f = goose.facing
    switch (ev) {
      case 'windup':
        // the goose is loading something: a "!" over its head, and a rising tone
        this.hooks.mark?.('!', x, y + 12, t)
        this.sfx('windup')
        break
      case 'throw':
      case 'volley_toss':
        this.sfx('whoosh')
        break
      case 'rock_break':
        // the boulder lands and comes apart on the enemy: its chunks are drawn (rock_break), the packs add the dust
        enemy.hit(t, true, 6, 1, 0.14)
        this.place({ fx: 'shards', dx: 0, dy: -6, fps: 20, fixed: true }, x, y, t)
        this.place({ fx: 'star', dx: 0, dy: -4, fps: 30, fixed: true }, x, y, t)
        this.place({ fx: 'ground_ring_s', dx: 0, dy: 20, fps: 24, fixed: true, delay: 0.05 }, x, y, t)
        this.sfx('rock_break')
        this.hooks.kick?.(3)
        this.stamp('boulder', x - 4 * f, y - 16, t)
        this.hooks.invert?.(t, 0.07)
        this.stop(t, 0.07)
        break
      case 'rock_miss':
        this.sfx('whiff')
        break
      case 'uppercut':
        // the rising arc off the wing, the star at the chin, and the enemy goes up
        enemy.launch(t)
        this.atGoose({ fx: 'arc_rise', dx: 6, dy: -26, turns: 2, fps: 30 }, t)
        this.place({ fx: 'star', dx: 0, dy: -6, fps: 30, fixed: true }, x, y, t)
        this.sfx('uppercut')
        this.hooks.kick?.(2)
        this.stamp('uppercut', x - 4 * f, y - 18, t)
        this.hooks.invert?.(t, 0.07)
        this.stop(t, 0.06)
        break
      case 'flop':
        // belly first: a ring on the ground, shards up
        enemy.hit(t, true, 5, 2, 0.14)
        this.place({ fx: 'ground_ring_s', dx: 0, dy: -3, fps: 24, fixed: true }, x, y, t)
        this.place({ fx: 'shards_s', dx: 0, dy: -12, fps: 20, fixed: true }, x, y, t)
        this.sfx('splat')
        this.hooks.kick?.(2)
        this.stamp('bellyflop', x, y - 26, t)
        this.stop(t, 0.05)
        break
      case 'jump':
        this.sfx('jump')
        this.fx.spawn('puff_s', x, y - 4, t)
        break
      case 'land':
        this.fx.spawn('puff_s', x, y - 6, t)
        this.sfx('thud')
        break
      case 'megahonk':
        // the drawn waves come off the beak; the packs add three rings racing ahead of them, and the enemy is blown back
        this.place({ fx: 'ring_s', dx: 10, dy: 0, fps: 30 }, x, y, t)
        this.place({ fx: 'ring', dx: 18, dy: 0, fps: 30, delay: 0.05 }, x, y, t)
        this.place({ fx: 'ring', dx: 28, dy: 0, fps: 24, delay: 0.1 }, x, y, t)
        enemy.hit(t, true, 6, 0, 0.26)
        this.sfx('megahonk')
        this.hooks.kick?.(2)
        this.stamp('megahonk', x - 14 * f, y - 14, t)
        this.hooks.invert?.(t, 0.05)
        break
      case 'dropkick':
        // both feet: debris low and forward
        enemy.hit(t, true, 5, 0, 0.12)
        this.place({ fx: 'spray_b_s', dx: 2, dy: 4, fps: 24 }, x, y, t)
        this.sfx('enemy_hit', 0.02)
        this.sfx('slap')
        this.hooks.kick?.(1)
        this.stamp('dropkick', x, y - 28, t, false)
        break
      case 'slam':
        // the body slam lands: the enemy driven into the ground, a shockwave ring round it, debris thrown up
        enemy.hit(t, true, 4, 3, 0.22)
        this.place({ fx: 'ground_ring_b', dx: 0, dy: -4, fps: 22, fixed: true }, x, y, t)
        this.place({ fx: 'shards', dx: 0, dy: -34, fps: 20, fixed: true }, x, y, t)
        this.sfx('bodyslam')
        this.hooks.kick?.(4)
        this.stamp('bodyslam', x + 14 * f, y - 30, t)
        this.hooks.invert?.(t, 0.08)
        this.stop(t, 0.09)
        break
      case 'volley_bat':
        // the wing bats the rock out of the air
        this.place({ fx: 'arc_c_s', dx: 0, dy: 0, fps: 30 }, x, y, t)
        this.sfx('bat')
        this.hooks.kick?.(1)
        break
      case 'volley_rock':
        // the rock breaks on the enemy: the first hit of the combo
        enemy.hit(t, true, 4, 0, 0.1)
        this.place({ fx: 'shatter_b', dx: 0, dy: 0, fps: 20, fixed: true }, x, y, t)
        this.place({ fx: 'star_s', dx: 0, dy: -4, fps: 30, fixed: true }, x, y, t)
        this.sfx('rock_break')
        this.hooks.kick?.(2)
        enemy.freeze(t, 0.04)
        break
      case 'volley_dash':
        this.place({ fx: 'streak_s', dx: -8, dy: 0, flip: true, fps: 20 }, x, y, t)
        this.sfx('dash')
        break
      case 'volley_smash':
        // the overhead smash: the crescent off the wing, the burst on the enemy, a pillar off the ground behind it
        enemy.hit(t, true, 4, 3, 0.22)
        this.atGoose({ fx: 'arc_down', dx: 8, dy: -22, fps: 30 }, t)
        this.place({ fx: 'spike_burst_s', dx: 0, dy: 0, fps: 24, fixed: true }, x, y, t)
        this.place({ fx: 'streak_orange', dx: 0, dy: 0, turns: 3, ax: 0, ay: 0.5, fps: 20, fixed: true }, x, enemy.y, t)
        this.place({ fx: 'shards', dx: 0, dy: -8, fps: 20, fixed: true, delay: 0.04 }, x, y, t)
        this.sfx('smash')
        this.hooks.kick?.(4)
        this.stamp('volley', x + 10 * f, y - 26, t)
        this.hooks.invert?.(t, 0.07)
        this.stop(t, 0.08)
        break
      case 'launch':
        // the beak flip: the enemy goes high and tumbling; a rising arc at the chin, a star, the sky kanji
        enemy.toss(t)
        this.atGoose({ fx: 'arc_rise', dx: 10, dy: -20, turns: 2, fps: 30 }, t)
        this.place({ fx: 'star_s', dx: 0, dy: -4, fps: 30, fixed: true }, x, y, t)
        this.sfx('flip')
        this.hooks.kick?.(2)
        this.stamp('launch', x + 6 * f, y - 34, t)
        this.stop(t, 0.05)
        break
      case 'lash':
        // the tail lash: the enemy driven from the top of its toss into the ground, a crescent off the tail,
        // a shockwave where it lands, shards, the frame inverted, a long hitstop
        enemy.slamDown(t)
        enemy.hit(t, true, 3, 3, 0.24)
        this.atGoose({ fx: 'arc_down', dx: 6, dy: 14, fps: 30 }, t)
        this.place({ fx: 'ground_ring_b', dx: 0, dy: 20, fps: 22, fixed: true, delay: 0.1 }, x, y, t)
        this.place({ fx: 'shards', dx: 0, dy: -4, fps: 20, fixed: true, delay: 0.1 }, x, y, t)
        this.place({ fx: 'spike_burst_s', dx: 0, dy: 10, fps: 24, fixed: true, delay: 0.1 }, x, y, t)
        this.sfx('lash')
        this.sfx('bodyslam', 0.1)
        this.hooks.kick?.(4)
        this.stamp('lash', x - 12 * f, y - 30, t + 0.1)
        this.hooks.invert?.(t + 0.1, 0.07)
        this.stop(t + 0.1, 0.09)
        break
      case 'dive':
        // the second punch, down onto the fallen enemy: a ring on the ground, debris, the crush kanji
        enemy.hit(t, true, 3, 3, 0.18)
        this.place({ fx: 'ground_ring_s', dx: 0, dy: 10, fps: 24, fixed: true }, x, y, t)
        this.place({ fx: 'spray_b_s', dx: 2, dy: 6, fps: 24 }, x, y, t)
        this.sfx('smash')
        this.hooks.kick?.(3)
        this.stamp('dive', x + 8 * f, y - 28, t, false)
        this.hooks.invert?.(t, 0.05)
        this.stop(t, 0.06)
        break
      case 'roll_hit':
        // the ball hits the enemy and the enemy hits the wall: debris off it toward the wall, dust off the ball, a kick
        enemy.hit(t, true, 6, 0, 0.14)
        this.place({ fx: 'spray_b_s', dx: -4, dy: -2, fps: 24 }, x, y, t)
        this.place({ fx: 'star_s', dx: 0, dy: -4, fps: 30, fixed: true }, x, y, t)
        this.atGoose({ fx: 'puff_s', dx: -8, dy: -6, fps: 20 }, t)
        this.sfx('roll')
        this.sfx('enemy_hit', 0.02)
        this.hooks.kick?.(3)
        this.stop(t, 0.05)
        if (Math.random() < 0.34) this.stamp('roll', x + 16 * f, y - 30, t, false)
        break
      case 'roll_miss':
        this.fx.spawn('puff_s', x, y, t)
        this.sfx('whiff')
        break
      case 'flurry_above':
        // the punch from above: the enemy driven down a little
        enemy.hit(t, false, 1, 2, 0.08)
        this.place({ fx: 'star_s', dx: 0, dy: -6, fps: 30, fixed: true }, x, y, t)
        this.sfx('slap2')
        break
      case 'flurry_behind':
        // the punch from behind: shoved toward the goose's side for once
        enemy.hit(t, false, 2, 0, 0.08, -1)
        this.place({ fx: 'star_s', dx: -4, dy: -2, fps: 30, fixed: true }, x, y, t)
        this.sfx('slap')
        break
      case 'flurry_big':
        // the last, both wings: a spiky burst, a kick, a hitstop, the swift kanji
        enemy.hit(t, true, 5, 0, 0.14)
        this.place({ fx: 'spike_burst_s', dx: 0, dy: -2, fps: 24, fixed: true }, x, y, t)
        this.sfx('slap')
        this.sfx('enemy_hit', 0.02)
        this.hooks.kick?.(2)
        this.stop(t, 0.05)
        this.stamp('flurry', x - 6 * f, y - 30, t, false)
        break
      case 'whip_release':
        // the hold let go clean: everything the lash stored up goes off on the enemy at once
        enemy.hit(t, true, 6, 0, 0.18)
        this.place({ fx: 'spike_burst', dx: 0, dy: -2, fps: 24, fixed: true }, x, y, t)
        this.place({ fx: 'ring', dx: 0, dy: -4, fps: 30, fixed: true }, x, y, t)
        this.place({ fx: 'shards_b', dx: 0, dy: -10, fps: 20, fixed: true, delay: 0.03 }, x, y, t)
        this.sfx('whip_boom')
        this.hooks.kick?.(3)
        this.stamp('whip_release', x + 8 * f, y - 30, t)
        this.hooks.invert?.(t, 0.06)
        this.stop(t, 0.06)
        break
      case 'dodge':
        this.fx.spawn('puff_s', x, y, t)
        this.sfx('whoosh')
        break
      case 'whiff':
        this.fx.spawn('puff_s', x, y, t)
        this.sfx('whiff')
        break
    }
  }
}
