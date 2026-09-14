/**
 * Which enemy and which scene a song gets.
 *
 * There is no level editor yet: a song's level is picked from its id, so the
 * same song always faces the same enemy on the same ground, and neighbouring
 * songs in the list get different ones.
 */
export interface EnemySpec {
  char: string
  /** the attack strip's contact frame: when the blow lands on the goose */
  contact: number
  /** the strip that plays when the enemy wins */
  taunt: string
}

export const ENEMIES: Record<string, EnemySpec> = {
  skeleton_white: { char: 'skeleton_white', contact: 5, taunt: 'attack2' },
  skeleton_yellow: { char: 'skeleton_yellow', contact: 5, taunt: 'attack2' },
  ninja: { char: 'ninja', contact: 7, taunt: 'attack' },
}

export interface LevelSpec { enemy: EnemySpec; scene: string }

const ROTATION: [string, string][] = [
  ['skeleton_white', 'meadow'],
  ['ninja', 'pillars_dusk'],
  ['skeleton_yellow', 'ruins_night'],
  ['skeleton_white', 'steps_dawn'],
  ['ninja', 'storm_flat'],
  ['skeleton_yellow', 'pillars_night'],
  ['skeleton_white', 'ruins_dusk'],
  ['ninja', 'steps_noon'],
]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export function levelFor(songId: string): LevelSpec {
  const [enemy, scene] = ROTATION[hash(songId) % ROTATION.length]
  return { enemy: ENEMIES[enemy], scene }
}
