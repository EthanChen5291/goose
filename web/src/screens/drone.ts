/**
 * A camera on a drone, with somebody flying it.
 *
 * The title's camera glides between marks on an eased curve, the way a
 * dolly on rails does.  Out over the islands the shot is a quadcopter's, and
 * a quadcopter is never quite where its pilot wants it:
 *
 *   · it has mass.  Thrust ramps up, the craft leans into its acceleration,
 *     it banks through a turn and overshoots its mark before it settles
 *     (an underdamped spring on position, with a top speed and a top
 *     acceleration so a long leg is a run at cruise, not a spring).
 *   · the pilot has hands.  The point they are flying at wanders a little
 *     off the mark — more the faster they go — and every so often they
 *     notice and correct.  A new mark is looked at first and flown to a
 *     beat later.
 *   · the gimbal is its own thing.  It pans at a limited rate, swings past
 *     what it was told to look at and comes back, and it has a separate,
 *     slower time constant from the body (CameraService's `RotSmoothness`
 *     beside its `Smoothness`).
 *   · the air is not still.  A low hum of hand-held drift on the frame,
 *     buffeting that grows with speed, and a shake that can be asked for
 *     (`shake`), sampled every second or third frame and held between
 *     samples — CameraService's trick, and in a pixel buffer a held offset
 *     reads as a jolt where a smooth one reads as blur.
 *
 * The director sets marks (`fly`, `lookAt`, `cut`); the drone gets there
 * its own way.  `apply` writes the result to a three.js camera.
 */
import * as THREE from 'three'

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const UP = new THREE.Vector3(0, 1, 0)

export interface FlyOptions {
  /** top speed, units/s */
  cruise?: number
  /** top acceleration, units/s² */
  accel?: number
  /** the field of view to arrive with */
  fov?: number
  /** how far off the mark the pilot's aim may wander at speed, units */
  sloppy?: number
  /** seconds the pilot looks before pushing the stick */
  hesitate?: number
}

export class Drone {
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  /** where the body is being flown to, and the pilot's aim at it (the goal plus their error) */
  readonly goal = new THREE.Vector3()
  private readonly aim = new THREE.Vector3()
  /** what the gimbal was told to look at, and where it is actually pointed (as angles) */
  readonly lookGoal = new THREE.Vector3(1, 0, 0)
  private yaw = 0
  private pitch = 0
  private yawVel = 0
  private pitchVel = 0
  private roll = 0
  fov = 38
  private fovGoal = 38
  private fovVel = 0
  private cruise = 90
  private accel = 70
  private sloppy = 3
  private hesitate = 0.3
  private goalSetAt = -9
  /** the pilot's error: a slow wander per axis, and a correction that decays */
  private readonly errPhase = [Math.random() * 7, Math.random() * 7, Math.random() * 7]
  private readonly correction = new THREE.Vector3()
  /** where the correction is going: the stick is pushed over a few frames, not in one */
  private readonly correctionGoal = new THREE.Vector3()
  private nextCorrection = 0
  /** the shake asked for: how hard, until when, and the held offset */
  private shakeAmp = 0
  private shakeUntil = -9
  private shakeDur = 1
  private readonly shakeOff = new THREE.Vector3()
  private shakeRoll = 0
  private shakeFrames = 0
  /** how much the frame hums at rest, world units */
  hum = 0.12
  /** buffeting at cruise, world units */
  buffet = 0.5
  /** how far the drone banks into a turn, radians per unit of lateral acceleration */
  bank = 0.0045
  private t = 0
  private readonly acc = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()

  /** put the drone here, still, looking at `look` — a hard cut */
  cut(pos: THREE.Vector3, look: THREE.Vector3, fov = 38): void {
    this.pos.copy(pos)
    this.vel.set(0, 0, 0)
    this.goal.copy(pos)
    this.aim.copy(pos)
    this.lookGoal.copy(look)
    this.dir.copy(look).sub(pos).normalize()
    this.yaw = Math.atan2(this.dir.z, this.dir.x)
    this.pitch = Math.asin(clamp(this.dir.y, -1, 1))
    this.yawVel = this.pitchVel = 0
    this.roll = 0
    this.fov = this.fovGoal = fov
    this.fovVel = 0
    this.correction.set(0, 0, 0)
    this.goalSetAt = -9
  }

  /** fly to `pos`; the drone leaves after a beat and arrives with some overshoot */
  fly(pos: THREE.Vector3, opts: FlyOptions = {}): void {
    const moved = this.goal.distanceTo(pos) > 0.5
    this.goal.copy(pos)
    this.cruise = opts.cruise ?? this.cruise
    this.accel = opts.accel ?? this.accel
    this.sloppy = opts.sloppy ?? this.sloppy
    this.hesitate = opts.hesitate ?? this.hesitate
    if (opts.fov !== undefined) this.fovGoal = opts.fov
    if (moved) {
      // a fresh mark from a standstill is looked at first; one taken on the fly keeps the thrust it has
      if (this.vel.length() < this.cruise * 0.3) this.goalSetAt = this.t
      this.nextCorrection = this.t + 0.4 + Math.random() * 0.5
    }
  }

  /** point the gimbal at `p` (it gets there at its own pace) */
  lookAt(p: THREE.Vector3): void { this.lookGoal.copy(p) }

  setFov(f: number): void { this.fovGoal = f }

  /** a jolt: `amp` world units, fading out over `dur` seconds */
  shake(amp: number, dur = 0.5): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp)
    this.shakeUntil = this.t + dur
    this.shakeDur = dur
    this.shakeFrames = 0
  }

  /** distance left to the mark */
  remaining(): number { return this.pos.distanceTo(this.goal) }
  speed(): number { return this.vel.length() }
  /** true once the drone is on its mark and near enough to still */
  settled(within = 2.5, slower = 6): boolean { return this.remaining() < within && this.vel.length() < slower }

  update(t: number, dt: number): void {
    this.t = t
    const speed = this.vel.length()
    const k = clamp(speed / Math.max(1, this.cruise), 0, 1)

    // ── the pilot's aim: the mark, plus a wander that grows with speed, plus the odd correction ──
    if (t > this.nextCorrection) {
      // they notice they are off and nudge the stick — a step in the aim, which the body then chases
      this.nextCorrection = t + 0.7 + Math.random() * 1.1
      this.correctionGoal.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5).multiplyScalar(this.sloppy * (0.4 + k))
    }
    this.correctionGoal.multiplyScalar(Math.exp(-dt * 1.4))
    this.correction.lerp(this.correctionGoal, 1 - Math.exp(-dt * 5))
    const wander = this.sloppy * (0.25 + 0.75 * k)
    this.aim.copy(this.goal).add(this.correction)
    this.aim.x += Math.sin(t * 0.37 + this.errPhase[0]) * wander
    this.aim.y += Math.sin(t * 0.29 + this.errPhase[1]) * wander * 0.5
    this.aim.z += Math.sin(t * 0.43 + this.errPhase[2]) * wander

    // ── the body: an underdamped spring toward the aim, capped in thrust and speed ──
    // ω from the stopping distance at cruise: a = ω²·d, and the run decelerates over d ≈ v²/(2a)
    const omega = Math.sqrt(2 * this.accel / Math.max(20, this.cruise)) * 1.15
    const zeta = 0.72
    this.tmp.copy(this.aim).sub(this.pos)
    this.acc.copy(this.tmp).multiplyScalar(omega * omega).addScaledVector(this.vel, -2 * zeta * omega)
    // the thrust ramps in after the pilot has looked at the new mark
    const since = t - this.goalSetAt
    const thrust = this.goalSetAt < 0 ? 1 : clamp((since - this.hesitate) / 0.35, 0, 1)
    const aMax = this.accel * (0.15 + 0.85 * thrust * thrust)
    if (this.acc.length() > aMax) this.acc.setLength(aMax)
    this.vel.addScaledVector(this.acc, dt)
    if (this.vel.length() > this.cruise) this.vel.setLength(this.cruise)
    this.pos.addScaledVector(this.vel, dt)

    // ── the gimbal: rate-limited springs on yaw and pitch, so a big pan swings past and comes back ──
    this.tmp.copy(this.lookGoal).sub(this.pos)
    const dist = Math.max(1e-3, this.tmp.length())
    this.tmp.divideScalar(dist)
    const wantYaw = Math.atan2(this.tmp.z, this.tmp.x)
    const wantPitch = Math.asin(clamp(this.tmp.y, -1, 1))
    const gw = 4.2, gz = 0.62
    const yawErr = wrap(wantYaw - this.yaw)
    this.yawVel += (yawErr * gw * gw - this.yawVel * 2 * gz * gw) * dt
    this.yawVel = clamp(this.yawVel, -2.6, 2.6)
    this.yaw = wrap(this.yaw + this.yawVel * dt)
    const pitchErr = wantPitch - this.pitch
    this.pitchVel += (pitchErr * gw * gw - this.pitchVel * 2 * gz * gw) * dt
    this.pitchVel = clamp(this.pitchVel, -2.0, 2.0)
    this.pitch = clamp(this.pitch + this.pitchVel * dt, -1.45, 1.45)

    // ── the body leans: banking into lateral acceleration, a dip under forward thrust ──
    this.dir.set(Math.cos(this.pitch) * Math.cos(this.yaw), Math.sin(this.pitch), Math.cos(this.pitch) * Math.sin(this.yaw))
    this.right.crossVectors(this.dir, UP).normalize()
    const lateral = this.acc.dot(this.right)
    const forward = this.acc.dot(this.dir)
    const rollGoal = clamp(-lateral * this.bank, -0.28, 0.28) + Math.sin(t * 0.8) * 0.006 * (1 + k)
    this.roll += (rollGoal - this.roll) * (1 - Math.exp(-dt * 3.2))
    const dip = clamp(-forward * 0.0012, -0.06, 0.06)

    // ── the air: a hum at rest, buffeting at speed, and the held shake ──
    const humAmp = this.hum + this.buffet * k * k
    this.tmp2.set(
      Math.sin(t * 1.7 + 0.3) * 0.6 + Math.sin(t * 3.1 + 1.1) * 0.4,
      Math.sin(t * 1.3 + 2.0) * 0.6 + Math.sin(t * 2.7 + 0.7) * 0.4,
      Math.sin(t * 1.9 + 1.4) * 0.6 + Math.sin(t * 3.4 + 2.2) * 0.4,
    ).multiplyScalar(humAmp)
    if (t < this.shakeUntil) {
      // resampled every second or third frame, held in between
      if (this.shakeFrames <= 0) {
        this.shakeFrames = 2 + Math.floor(Math.random() * 2)
        const left = (this.shakeUntil - t) / this.shakeDur
        const a = this.shakeAmp * left * left
        this.shakeOff.set((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 1.4 * a, (Math.random() - 0.5) * 2 * a)
        this.shakeRoll = (Math.random() - 0.5) * 0.08 * left
      }
      this.shakeFrames -= 1
    } else { this.shakeOff.set(0, 0, 0); this.shakeRoll = 0; this.shakeAmp = 0 }

    // ── the lens: a spring to its goal, opened a touch by speed ──
    const fw = 5, fz = 0.8
    const fovWant = this.fovGoal + k * 5
    this.fovVel += ((fovWant - this.fov) * fw * fw - this.fovVel * 2 * fz * fw) * dt
    this.fov += this.fovVel * dt

    this.outPos.copy(this.pos).add(this.tmp2).add(this.shakeOff)
    this.outRoll = this.roll + this.shakeRoll
    this.outPitch = this.pitch + dip + Math.sin(t * 2.3) * 0.004 * (1 + k) + this.tmp2.y * 0.01
    this.outYaw = this.yaw + Math.sin(t * 1.9 + 0.5) * 0.004 * (1 + k) + this.tmp2.x * 0.008
  }

  private readonly outPos = new THREE.Vector3()
  private outRoll = 0
  private outPitch = 0
  private outYaw = 0
  private readonly at = new THREE.Vector3()

  /** the frame: position, aim and roll onto the camera, and its fov */
  apply(camera: THREE.PerspectiveCamera): void {
    camera.position.copy(this.outPos)
    this.at.set(Math.cos(this.outPitch) * Math.cos(this.outYaw), Math.sin(this.outPitch), Math.cos(this.outPitch) * Math.sin(this.outYaw)).add(this.outPos)
    camera.up.copy(UP)
    camera.lookAt(this.at)
    camera.rotateZ(this.outRoll)
    camera.fov = this.fov
    camera.updateProjectionMatrix()
  }

  /** the direction the frame is pointed */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.outPitch) * Math.cos(this.outYaw), Math.sin(this.outPitch), Math.cos(this.outPitch) * Math.sin(this.outYaw))
  }
}
