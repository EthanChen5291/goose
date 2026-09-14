/**
 * What the goose's moves look and sound like, shared by both play screens.
 *
 * `actors.ts` decides *what* happens — the rock leaves the wings, the enemy is
 * launched, the goose lands — and reports it as a `GooseEvent`.  This turns each
 * into the small effect from the pack, the synthesised sound, and a kick of the
 * camera where the blow deserves one.  Every effect is the `_s` size, drawn at
 * the point the event names, so a 28 px goose is never lost under it.
 */
import type { Fight, GooseEvent } from './actors'
import type { FxLayer } from './fx'

export type Sfx = (name: string, delay?: number) => void

/** the kanji a blow stamps behind the enemy, and its colour — the way an anime cut does */
export const KANJI_OF: Record<string, [string, number]> = {
  uppercut: ['fist', 0xffde7b], boulder: ['rock', 0xc8ccd4], bellyflop: ['crush', 0xffa26b],
  dropkick: ['kick', 0x8effc2], megahonk: ['roar', 0xff607a], slam: ['strike', 0xffde7b],
  slide: ['swift', 0x8eccff], hop_slap: ['soar', 0xaed0e6], spin: ['slash', 0xffaaf1],
}

export interface CombatHooks {
  /** a big kanji behind the blow: `name` is a KANJI_OF key, `big` the 48 px face */
  kanji?: (name: string, color: number, x: number, y: number, t: number, big: boolean) => void
  /** the whole frame inverts for a few frames */
  invert?: (t: number, secs: number) => void
}

export function gooseEffects(fight: Fight, fx: FxLayer, sfx: Sfx, kick: (px: number) => void,
                             ring: (x: number, y: number, t: number, r0: number, r1: number, dur: number) => void,
                             mark: (text: string, x: number, y: number, t: number) => void,
                             hooks: CombatHooks = {}) {
  const stamp = (move: string, x: number, y: number, t: number, big = true): void => {
    const k = KANJI_OF[move]
    if (k && hooks.kanji) { hooks.kanji(k[0], k[1], x, y, t, big); sfx('kanji') }
  }
  return (ev: GooseEvent, x: number, y: number, t: number): void => {
    const { enemy } = fight
    switch (ev) {
      case 'windup':
        // the goose is loading something: a "!" over its head, and a rising tone
        mark('!', x, y + 12, t)
        sfx('windup')
        break
      case 'throw':
        sfx('whoosh')
        break
      case 'rock_break':
        // the boulder lands and comes apart on the enemy
        enemy.hit(t, true, 5)
        fx.spawn('dust_s', x, y + 12, t)
        fx.spawn('burst_star_s', x, y - 6, t)
        sfx('rock_break')
        kick(3)
        stamp('boulder', x - 4 * fight.goose.facing, y - 14, t)
        hooks.invert?.(t, 0.07)
        break
      case 'rock_miss':
        sfx('whiff')
        break
      case 'uppercut':
        enemy.launch(t)
        fx.spawn('burst_star_s', x, y - 10, t)
        fx.spawn('attack_up_s', x, y, t)
        sfx('uppercut')
        kick(2)
        stamp('uppercut', x - 4 * fight.goose.facing, y - 18, t)
        hooks.invert?.(t, 0.07)
        break
      case 'flop':
        fx.spawn('dust_s', x, y - 4, t)
        sfx('splat')
        kick(2)
        stamp('bellyflop', x, y - 26, t)
        break
      case 'land':
        fx.spawn('puff_s', x, y - 6, t)
        sfx('thud')
        break
      case 'megahonk':
        // rings off the beak, three of them, and the enemy leans away
        ring(x, y, t, 4, 12, 0.18)
        ring(x, y, t + 0.06, 4, 16, 0.22)
        ring(x, y, t + 0.12, 6, 16, 0.26)
        enemy.knock(t, -5 * enemy.facing, 0.2)
        sfx('megahonk')
        stamp('megahonk', x - 16 * fight.goose.facing, y - 10, t, false)
        break
      case 'dropkick':
        sfx('jump')
        stamp('dropkick', x, y - 28, t, false)
        break
      case 'whiff':
        fx.spawn('puff_s', x, y, t)
        sfx('whiff')
        break
    }
  }
}

/** moves whose sound is already made by their events; the generic slap is not added */
export const SELF_VOICED = new Set(['boulder', 'uppercut', 'bellyflop', 'megahonk', 'dropkick', 'whiff'])
