// Caelancraft — how the player's avatar moves (PURE: no three, no DOM). See src/CONTRACTS.md §91.
//
// AvatarMotion turns what the player does each frame (the look, the velocity, standing, sneaking, swimming, flying,
// riding, asleep) into joint angles for avatarRenderer.js — the third-person model and the first-person arm:
//   - a walk cycle whose phase runs with the distance walked (AVATAR_STRIDE_M a leg) and whose size grows with the speed;
//     the arms swing against the legs;
//   - a slow breath while standing still;
//   - the head follows the look: its pitch clamped to ±AVATAR_HEAD_PITCH_MAX, its yaw first — the body turns after it at
//     AVATAR_BODY_TURN per second (twice that while walking), never letting the head turn more than AVATAR_HEAD_YAW_MAX;
//   - a swing of the right arm on a break, a place or a strike (swing(): AVATAR_SWING_S long);
//   - a crouch while sneaking, a swimming stroke, arms out when flying, a seat on a horse, lying down asleep.
import {
  AVATAR_BODY_TURN, AVATAR_HEAD_YAW_MAX, AVATAR_HEAD_PITCH_MAX, AVATAR_SWING_S, AVATAR_STRIDE_M, WALK_SPEED, SPRINT_SPEED,
} from './config.js';

/**
 * What the player does this frame.
 * @typedef {Object} MotionInput
 * @property {number} yaw      the look (radians, §0)
 * @property {number} pitch
 * @property {number} vx       velocity (m/s)
 * @property {number} vz
 * @property {boolean} onGround
 * @property {boolean} [sneaking]
 * @property {boolean} [swimming]  in water and not standing on anything
 * @property {boolean} [flying]
 * @property {boolean} [riding]
 * @property {boolean} [sleeping]  lying down (§87)
 */

/**
 * The joint angles (radians) and offsets (metres) of one frame. Signs follow the model (it faces −Z): a positive arm or
 * leg swing is forward; a negative lean bends the torso forward; a positive bodyPitch tips the body onto its back.
 * @typedef {Object} AvatarPose
 * @property {number} bodyYaw     the body's yaw (world)
 * @property {number} headYaw     the head's turn from the body
 * @property {number} headPitch   the head's nod (positive looks up)
 * @property {number} legSwing    the right leg's swing (the left leg's is its negative)
 * @property {number} legRaise    both legs forward (sitting on a horse; a little back when flying)
 * @property {number} legSpread   both legs out to the sides
 * @property {number} armSwing    the right arm's walking swing (the left arm's is its negative)
 * @property {number} armReach    both arms raised forward (swimming, riding)
 * @property {number} armSpread   both arms out to the sides
 * @property {number} elbow       both elbows' bend
 * @property {number} reachR      the right arm's extra swing forward for an action
 * @property {number} twistR      … turned in across the body
 * @property {number} lean        the torso's lean (negative: forward)
 * @property {number} twist       the torso's turn toward an action
 * @property {number} hipDrop     how far the hips sink (crouching)
 * @property {number} chestLift   how far the torso rises with the idle breath (m)
 * @property {number} bodyPitch   the whole body tipped about the hips (swimming forward, lying on its back)
 * @property {number} lie         0 standing .. 1 lying down
 * @property {number} ride        0 standing .. 1 sitting on a horse
 * @property {number} breath      0..1 of the idle breath
 * @property {number} fpSwing     the first-person arm's swing, 0..1 through it, or −1 between swings
 * @property {number} fpBobX      the first-person arm's bob while walking (m, camera space)
 * @property {number} fpBobY
 */

const TAU = Math.PI * 2;

/** @param {number} a @returns {number} a in (−π, π] */
export function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** Ease `v` toward `target` at `rate` per second over `dt`. */
function ease(v, target, rate, dt) {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The size of the walk cycle's leg swing at walking pace, and at a sprint. */
export const LEG_SWING = 0.6;
export const LEG_SWING_SPRINT = 0.8;
/** The arms swing this share of the legs' swing. */
export const ARM_SHARE = 0.75;
/** How far the right arm swings forward at the top of an action swing. */
export const SWING_REACH = 1.9;

/** The animation state of one avatar. */
export class AvatarMotion {
  constructor() {
    /** the body's yaw (NaN until the first step) */
    this.bodyYaw = NaN;
    /** the walk cycle's phase (radians: π a stride) and how much of a walk it is (0..1) */
    this.phase = 0;
    this.walk = 0;
    /** seconds stepped */
    this.time = 0;
    /** seconds into the current action swing (≥ AVATAR_SWING_S: none) */
    this.swingT = AVATAR_SWING_S;
    this.crouch = 0;
    this.swim = 0;
    this.fly = 0;
    this.ride = 0;
    this.lie = 0;
    /** @type {AvatarPose} reused every step */
    this.pose = {
      bodyYaw: 0, headYaw: 0, headPitch: 0, legSwing: 0, legRaise: 0, legSpread: 0, armSwing: 0, armReach: 0, armSpread: 0, elbow: 0,
      reachR: 0, twistR: 0, lean: 0, twist: 0, hipDrop: 0, chestLift: 0, bodyPitch: 0, lie: 0, ride: 0, breath: 0, fpSwing: -1, fpBobX: 0,
      fpBobY: 0,
    };
  }

  /** Start a swing of the right arm (a break, a place, a strike); a swing under way starts again only past its middle. */
  swing() {
    if (this.swingT < AVATAR_SWING_S / 2) return;
    this.swingT = 0;
  }

  /** @returns {boolean} a swing is under way */
  get swinging() {
    return this.swingT < AVATAR_SWING_S;
  }

  /**
   * Turn the body to `yaw` at once and stop every movement (a new world, a teleport, a new avatar).
   * @param {number} yaw
   */
  reset(yaw) {
    this.bodyYaw = Number.isFinite(yaw) ? yaw : 0;
    this.walk = 0;
    this.swingT = AVATAR_SWING_S;
    this.crouch = 0;
    this.swim = 0;
    this.fly = 0;
    this.ride = 0;
    this.lie = 0;
  }

  /**
   * One frame.
   * @param {number} dt  seconds (0: the same pose again)
   * @param {MotionInput} s
   * @returns {AvatarPose}
   */
  step(dt, s) {
    const t = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this.time += t;
    const yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
    const speed = Math.hypot(s.vx || 0, s.vz || 0);
    const sleeping = !!s.sleeping;
    const riding = !!s.riding && !sleeping;
    const swimming = !!s.swimming && !riding && !sleeping;
    const flying = !!s.flying && !riding && !sleeping;
    const grounded = !!s.onGround && !flying;

    // the stances, each easing in and out
    this.crouch = ease(this.crouch, s.sneaking && grounded && !riding ? 1 : 0, 12, t);
    this.swim = ease(this.swim, swimming ? clamp(speed / 1.2, 0, 1) : 0, 4, t);
    this.fly = ease(this.fly, flying ? 1 : 0, 6, t);
    this.ride = riding ? 1 : ease(this.ride, 0, 20, t);
    this.lie = ease(this.lie, sleeping ? 1 : 0, 3, t);

    // the walk: the phase runs with the distance, the size with the speed (standing on something or swimming)
    const moving = (grounded || swimming) && !riding && !sleeping;
    this.walk = ease(this.walk, moving ? clamp(speed / WALK_SPEED, 0, 1) : 0, 10, t);
    if (moving) this.phase = (this.phase + (speed * t * Math.PI) / AVATAR_STRIDE_M) % TAU;

    // the body turns after the head
    if (!Number.isFinite(this.bodyYaw)) this.bodyYaw = yaw;
    const rate = AVATAR_BODY_TURN * (speed > 0.5 ? 2 : 1);
    this.bodyYaw = wrapAngle(this.bodyYaw + wrapAngle(yaw - this.bodyYaw) * (1 - Math.exp(-rate * t)));
    let headYaw = wrapAngle(yaw - this.bodyYaw);
    if (Math.abs(headYaw) > AVATAR_HEAD_YAW_MAX) {
      this.bodyYaw = wrapAngle(yaw - Math.sign(headYaw) * AVATAR_HEAD_YAW_MAX);
      headYaw = Math.sign(headYaw) * AVATAR_HEAD_YAW_MAX;
    }

    // the action swing
    if (this.swingT < AVATAR_SWING_S) this.swingT += t;
    const sw = this.swingT < AVATAR_SWING_S ? this.swingT / AVATAR_SWING_S : -1;
    const lift = sw >= 0 ? Math.sin(Math.PI * Math.pow(sw, 0.7)) : 0;

    const p = this.pose;
    const sprint = clamp((speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED), 0, 1);
    const legAmp = (LEG_SWING + (LEG_SWING_SPRINT - LEG_SWING) * sprint) * this.walk * (1 - this.swim);
    const sinP = Math.sin(this.phase);
    const breath = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    const still = 1 - this.walk;
    const flutter = Math.sin(this.time * 9) * 0.35 * this.swim;
    const stroke = this.swim * (0.5 + 0.5 * Math.sin(this.time * 3.5));

    p.bodyYaw = this.bodyYaw;
    p.headYaw = sleeping ? 0 : headYaw * (1 - this.lie);
    p.headPitch = clamp(Number.isFinite(s.pitch) ? s.pitch : 0, -AVATAR_HEAD_PITCH_MAX, AVATAR_HEAD_PITCH_MAX) * (1 - this.lie)
      + 0.55 * this.swim;
    p.legSwing = (sinP * legAmp + flutter) * (1 - this.ride) * (1 - this.lie);
    p.legRaise = 1.3 * this.ride - 0.12 * this.fly;
    p.legSpread = 0.38 * this.ride + 0.04 * this.fly;
    p.armSwing = -sinP * legAmp * ARM_SHARE * (1 - this.ride) * (1 - this.lie);
    p.armReach = 2.6 * stroke + 0.55 * this.ride - 0.25 * this.fly;
    p.armSpread = 0.05 + 0.03 * breath * still + 0.5 * stroke + 0.18 * this.fly;
    p.elbow = 0.12 + 0.1 * this.walk + 0.55 * this.ride + 0.3 * this.crouch;
    p.reachR = SWING_REACH * lift;
    p.twistR = 0.35 * lift;
    p.lean = -0.5 * this.crouch - 0.12 * this.fly - 0.05 * this.walk * sprint;
    p.twist = 0.2 * lift;
    p.hipDrop = 0.08 * this.crouch;
    p.chestLift = 0.005 * breath * still;
    p.bodyPitch = -1.2 * this.swim * (1 - this.lie) + (Math.PI / 2) * this.lie;
    p.lie = this.lie;
    p.ride = this.ride;
    p.breath = breath;
    p.fpSwing = sw;
    p.fpBobX = 0.014 * sinP * this.walk;
    p.fpBobY = -0.02 * Math.abs(sinP) * this.walk + 0.004 * (breath - 0.5) * still;
    return p;
  }
}
