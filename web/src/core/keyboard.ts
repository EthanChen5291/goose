/**
 * Keyboard geography: which hand, finger, lane and column a letter belongs to.
 * A port of game/keyboard.py, tables and all.
 *
 * Lanes are the four hand zones of the Highway (left outer, left inner, right
 * inner, right outer).  Columns are the finger sub-columns inside a lane, in
 * design pixels relative to the lane centre.  Fingers are 0..9 left pinky to
 * right pinky.  Rows: 0 top, 1 home, 2 bottom.
 */

export const LANE_COLORS: Record<number, number> = {
  0: 0xffaaf1,   // L1 pink
  1: 0xffc18e,   // L2 orange
  2: 0x8eccff,   // L3 blue
  3: 0x8effc2,   // L4 green
}
export const LANE_COLOR_NAMES: Record<number, string> = {
  0: 'pink', 1: 'orange', 2: 'blue', 3: 'green',
}
export const GOLD = 0xffde7b
export const MISS_RED = 0xff607a
export const INK = 0x0b0b12

const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/** finger index per key column (0..9), for the 10-column keyboard */
const FINGER_BY_COL = [0, 1, 2, 3, 3, 6, 6, 7, 8, 9]
/** lane per column */
const LANE_BY_COL = [0, 0, 1, 1, 1, 2, 2, 3, 3, 3]
/** finger sub-column offset (design px) per column, inside its lane */
const COLUMN_OFFSET_BY_COL = [-40, 40, -64, 0, 64, -40, 40, -64, 0, 64]

export const LANE_OF: Record<string, number> = {}
export const FINGER_OF: Record<string, number> = {}
export const ROW_OF: Record<string, number> = {}
export const COLUMN_OFFSET_OF: Record<string, number> = {}
export const COLUMN_OF: Record<string, number> = {}

for (let r = 0; r < QWERTY_ROWS.length; r++) {
  const keys = QWERTY_ROWS[r]
  for (let c = 0; c < keys.length; c++) {
    // rows are left-aligned; z is column 0
    const col = Math.min(c, 9)
    const ch = keys[c]
    LANE_OF[ch] = LANE_BY_COL[col]
    FINGER_OF[ch] = FINGER_BY_COL[col]
    ROW_OF[ch] = r
    COLUMN_OFFSET_OF[ch] = COLUMN_OFFSET_BY_COL[col]
    COLUMN_OF[ch] = col
  }
}

/** 0 left, 1 right */
export const HAND_OF: Record<string, number> = Object.fromEntries(
  Object.entries(FINGER_OF).map(([ch, f]) => [ch, f <= 4 ? 0 : 1]),
)

export const FINGER_NAMES = [
  'left pinky', 'left ring', 'left middle', 'left index', 'left index',
  'right index', 'right index', 'right middle', 'right ring', 'right pinky',
]
export const HOME_KEY_OF_FINGER: Record<number, string> = {
  0: 'a', 1: 's', 2: 'd', 3: 'f', 6: 'j', 7: 'k', 8: 'l', 9: ';',
}
export const LEFT_HAND_LETTERS = 'qwertasdfgzxcvb'
export const RIGHT_HAND_LETTERS = 'yuiophjklnm'

export const MIRROR: Record<string, string> = {
  a: ';', s: 'l', d: 'k', f: 'j', g: 'h', q: 'p', w: 'o', e: 'i',
  r: 'u', t: 'y', v: 'm', b: 'n', c: ',', x: '.', z: '/',
}
for (const [k, v] of Object.entries({ ...MIRROR })) {
  if (/^[a-z]$/i.test(v)) MIRROR[v] = k
}

export const laneOf = (ch: string): number => LANE_OF[ch.toLowerCase()] ?? 1
export const columnOffsetOf = (ch: string): number => COLUMN_OFFSET_OF[ch.toLowerCase()] ?? 0
export const fingerOf = (ch: string): number => FINGER_OF[ch.toLowerCase()] ?? 3
export const handOf = (ch: string): number => HAND_OF[ch.toLowerCase()] ?? 0
export const rowOf = (ch: string): number => ROW_OF[ch.toLowerCase()] ?? 1
export const laneColor = (lane: number): number => LANE_COLORS[lane] ?? 0xffffff

/** 0 if every letter is left-hand, 1 if every letter is right-hand, else null. */
export function handOfWord(word: string): number | null {
  const hands = new Set<number>()
  for (const c of word) if (/[a-z]/i.test(c)) hands.add(handOf(c))
  return hands.size === 1 ? [...hands][0] : null
}
