/**
 * Where everything sits, in game pixels, for a buffer of a given size.
 *
 * The screen is two halves.  The left is the fight: the enemy near the edge,
 * the goose to its right, both on the ground.  The right is the highway: four
 * lanes falling onto hit circles that sit on the same ground line, so a note is
 * caught where the goose is standing.  The word block is under the ground, in
 * the dirt, where the dark tiles give the letters their contrast.
 *
 * Numbers are whole pixels.  Nothing here is scaled; a bigger window gives a
 * bigger buffer and the highway gets wider lanes, not bigger circles.
 */

export class PxLayout {
  /** the fight column's width */
  readonly fightW: number
  /** highway left edge and lane width */
  readonly hwX0: number
  readonly laneW: number
  readonly laneCenters: number[]

  constructor(readonly w: number, readonly h: number, readonly groundY: number) {
    this.fightW = Math.max(128, Math.min(172, Math.round(w * 0.36)))
    this.hwX0 = this.fightW
    this.laneW = Math.floor((w - this.hwX0 - 4) / 4)
    this.laneCenters = [0, 1, 2, 3].map((i) => this.hwX0 + i * this.laneW + Math.floor(this.laneW / 2))
  }

  /** centre of the hit circles: sitting on the grass */
  get slotY(): number { return this.groundY - 11 }
  get spawnY(): number { return -14 }
  get fallPx(): number { return this.slotY - this.spawnY }

  get hwX1(): number { return this.hwX0 + 4 * this.laneW }
  get hwCx(): number { return this.hwX0 + 2 * this.laneW }

  laneCenter(lane: number): number { return this.laneCenters[Math.max(0, Math.min(3, lane))] }
  laneX0(lane: number): number { return this.hwX0 + lane * this.laneW }

  // ── the fight ────────────────────────────────────────────────────────────
  /** enemy feet x: a little in from the edge */
  get enemyX(): number { return 40 }
  /** goose feet x: where the skeleton's sword just reaches */
  get gooseX(): number { return this.enemyX + 48 }

  // ── notes ────────────────────────────────────────────────────────────────
  get noteR(): number { return 8 }
  get ringR(): number { return 10 }

  // ── the word block, in the dirt ──────────────────────────────────────────
  get wordY(): number { return this.groundY + 20 }
  get wordAdvance(): number { return 10 }
  get queueY(): number { return this.groundY + 36 }

  // ── HUD ──────────────────────────────────────────────────────────────────
  get scorePos(): [number, number] { return [4, 4] }
  get accPos(): [number, number] { return [this.w - 4, 4] }
  get comboPos(): [number, number] { return [this.hwCx, Math.round(this.h * 0.36)] }
  get livesPos(): [number, number] { return [4, 14] }
  get rushBar(): [number, number, number, number] { return [4, 22, 48, 3] }
  get tagPos(): [number, number] { return [this.hwCx, 12] }
}
