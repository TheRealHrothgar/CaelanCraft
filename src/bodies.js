// Caelancraft — body-to-body physics: the player and mobs collide, push each other, and stand (and ride) on top
// of each other. See src/CONTRACTS.md §31. Pure.
//
// Every body is a vertical cylinder (physics.js bodyRadius / bodyHeight) with a mass (PLAYER_MASS when absent).
// resolveBodies runs once per frame AFTER every body has been stepped against the terrain:
//   1. Riders are carried: a body that ended last frame standing on another moves by that carrier's displacement,
//      in steps short enough that it cannot tunnel through a wall. A carrier that jumped further than any body can
//      move in one frame was teleported: its riders are left behind.
//   2. Each overlapping pair is separated along its shallower axis:
//      - vertical (the upper body's feet are in the top part of the lower one and the vertical overlap is the
//        smaller): the upper body is lifted out, lands (onGround, never falling faster than the carrier, but not
//        thrown upward by a rising one — the carry already lifts it) and records the carrier for step 1 next frame;
//      - horizontal: the pair is pushed apart along the line between their centres, each side moving in proportion
//        to the OTHER's mass. Displacement goes through the terrain (physics.displaceBody), so a body pinned against
//        a wall cannot be pushed into it — the other body takes the rest of the separation. The approaching part
//        of their relative velocity is removed with a perfectly inelastic, mass-weighted impulse (momentum kept).
//        Nearly coincident centres get a per-pair direction and each push is capped, so a pile of bodies dropped on
//        one spot eases apart in every direction over a few frames instead of shooting out along one line.
//   Pairs are visited in index order for BODY_PASSES passes so chains (player → pig → pig) settle in one frame.
//   3. A rider that stopped standing on its carrier (jumped or walked off) keeps the carrier's horizontal velocity.
import { PLAYER_MASS, BODY_PASSES, COLLISION_EPS } from './config.js';
import { bodyRadius, bodyHeight, displaceBody } from './physics.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */

/** The upper body only stands on the lower one when its feet are above this fraction of the lower body's height. */
const STAND_FRACTION = 0.5;
/** Horizontal overlap (world units) a stand needs at least, so brushing the rim does not count as standing. */
const STAND_MIN_OVERLAP = 0.05;
/** A body resting within this gap above another one's top still stands on it (keeps the ride link and onGround). */
const STAND_TOLERANCE = 0.01;
/**
 * Below this centre distance the push direction is blended with a fixed per-pair direction (fully at 0): the line
 * between two almost coincident centres is noise, and taking it for every pair lines a pile up along one axis.
 */
export const BODY_NEAR_DIST = 0.25;
/** Most one pair is pushed apart in one pass (BODY_PASSES passes per frame): deep pile-ups ease apart over frames. */
export const BODY_MAX_PUSH = 0.25;
/**
 * Most the separation pushes move one body in one frame, all its pairs and passes together (30 m/s at 60 fps): in a
 * pile every body overlaps every other one, and uncapped pushes add up to multi-unit pops.
 */
export const BODY_MAX_SHOVE = 0.5;
/**
 * A rider is carried in steps of at most this (half a cell's inradius), so a wall it meets pushes it back the way it
 * came: it slides, never tunnels.
 */
export const CARRY_STEP = 0.25;
/**
 * A carrier that moved more than this since last frame was teleported (fly-sprinting 21.6 m/s and falling at
 * terminal velocity 60 m/s move at most ~6.4 per MAX_FRAME_DT frame): its riders stay behind instead.
 */
export const CARRY_MAX_MOVE = 8;

/** @param {PlayerState} b */
export function bodyMass(b) {
  return b.mass ?? PLAYER_MASS;
}

/**
 * Fixed push direction (radians) for the pair at list indices i < j: well spread (an integer hash) and stable for as
 * long as the list keeps its order.
 */
export function pairAngle(i, j) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Overlap of two body cylinders. Positive `horizontal` and `vertical` both mean they intersect.
 * @param {PlayerState} a
 * @param {PlayerState} b
 * @param {number} [angle=0] the pair's own direction, blended in below BODY_NEAR_DIST (coincident → exactly it)
 * @returns {{ horizontal: number, vertical: number, nx: number, nz: number, dist: number }} n points from a to b
 */
export function bodyOverlap(a, b, angle = 0) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const horizontal = bodyRadius(a) + bodyRadius(b) - dist;
  const vertical = Math.min(a.y + bodyHeight(a), b.y + bodyHeight(b)) - Math.max(a.y, b.y);
  let nx = dx;
  let nz = dz;
  const w = BODY_NEAR_DIST - dist;
  if (w > 0) {
    nx += w * Math.cos(angle);
    nz += w * Math.sin(angle);
  }
  const len = Math.hypot(nx, nz);
  if (len > 1e-12) {
    nx /= len;
    nz /= len;
  } else {
    nx = 1; // the blend cancelled the offset exactly: any direction separates them
    nz = 0;
  }
  return { horizontal, vertical, nx, nz, dist };
}

/** Scratch: each body's carrier at the start of resolveBodies (for the release in step 3). */
const prevCarrier = [];
/** Scratch: separation distance each body may still be pushed this frame (BODY_MAX_SHOVE). */
const shove = [];

/**
 * Carry riders, then separate every overlapping pair (see the file comment). Mutates the bodies.
 * @param {PlayerState[]} bodies   the player and every active mob (frozen mobs should be left out)
 * @param {GetBlockFn} getBlock
 * @returns {number} pairs that were in contact this frame
 */
export function resolveBodies(bodies, getBlock) {
  carryRiders(bodies, getBlock);
  shove.length = bodies.length;
  shove.fill(BODY_MAX_SHOVE);
  let contacts = 0;
  for (let pass = 0; pass < BODY_PASSES; pass++) {
    let any = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (separatePair(bodies, i, j, getBlock)) {
          any = true;
          if (pass === 0) contacts++;
        }
      }
    }
    if (!any) break;
  }
  // A rider that left its (still present) carrier keeps the carrier's horizontal motion: jumping off a walking pig
  // keeps you going with it (and landing on it again) instead of stopping dead in the air.
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const c = prevCarrier[i];
    if (c && b.carrier !== c) {
      b.vx += c.vx;
      b.vz += c.vz;
    }
  }
  prevCarrier.length = 0;
  return contacts;
}

/**
 * Detach `body` from whatever it stands on and drop every rider standing on it (a teleport: nobody comes along, and
 * nobody inherits its motion). Call it whenever a body is moved by something other than physics.
 * @param {PlayerState} body
 * @param {Iterable<PlayerState>} others   bodies that might be riding it
 */
export function detachBody(body, others) {
  body.carrier = null;
  for (const o of others) if (o.carrier === body) o.carrier = null;
}

/**
 * A body that stood on a carrier at the end of last frame moves with it (horizontally and vertically), as long as
 * the carrier is still in this frame's list and did not teleport. The link is cleared here and re-made by
 * separatePair if it still stands; prevCarrier remembers it for the release (step 3).
 * @param {PlayerState[]} bodies
 * @param {GetBlockFn} getBlock
 */
function carryRiders(bodies, getBlock) {
  prevCarrier.length = bodies.length;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const c = b.carrier;
    b.carrier = null;
    prevCarrier[i] = null;
    if (!c || !b.carrierAt || !bodies.includes(c)) continue;
    const dx = c.x - b.carrierAt[0];
    const dy = c.y - b.carrierAt[1];
    const dz = c.z - b.carrierAt[2];
    const d = Math.hypot(dx, dy, dz);
    if (!(d <= CARRY_MAX_MOVE)) continue; // teleported (or non-finite): the rider stays and falls
    prevCarrier[i] = c;
    if (d === 0) continue;
    const n = Math.ceil(d / CARRY_STEP);
    for (let k = 0; k < n; k++) displaceBody(b, dx / n, dy / n, dz / n, getBlock);
  }
}

/**
 * Separate the pair at indices i < j. @returns {boolean} true when they overlapped
 * @param {PlayerState[]} bodies
 * @param {number} i
 * @param {number} j
 * @param {GetBlockFn} getBlock
 */
function separatePair(bodies, i, j, getBlock) {
  const a = bodies[i];
  const b = bodies[j];
  const o = bodyOverlap(a, b, pairAngle(i, j));
  if (o.horizontal <= 0) return false;
  const upper = a.y >= b.y ? a : b;
  const lower = upper === a ? b : a;
  if (o.vertical <= 0) {
    // Not touching — unless the upper body rests right on the lower one's top: then it still stands there.
    if (o.vertical > -STAND_TOLERANCE && o.horizontal > STAND_MIN_OVERLAP && upper.vy <= lower.vy + 1e-9) {
      standOn(upper, lower);
    }
    return false;
  }

  // Vertical: stand the upper body on the lower one.
  if (
    o.vertical < o.horizontal
    && o.horizontal > STAND_MIN_OVERLAP
    && upper.y >= lower.y + bodyHeight(lower) * STAND_FRACTION
  ) {
    const lift = o.vertical + COLLISION_EPS;
    const before = upper.y;
    displaceBody(upper, 0, lift, 0, getBlock);
    if (upper.y - before >= lift - 1e-9) {
      standOn(upper, lower);
      return true;
    }
    // A ceiling stopped the lift: fall through and push them apart sideways instead.
    upper.y = before;
  }

  // Horizontal: push apart, each moving in proportion to the other's mass, through the terrain.
  const ma = bodyMass(a);
  const mb = bodyMass(b);
  const total = Math.min(o.horizontal + COLLISION_EPS, BODY_MAX_PUSH);
  const shareB = ma / (ma + mb);
  const movedB = pushAlong(b, j, o.nx, o.nz, total * shareB, getBlock);
  const movedA = pushAlong(a, i, -o.nx, -o.nz, total - movedB, getBlock);
  const left = total - movedB - movedA;
  if (left > 1e-6) pushAlong(b, j, o.nx, o.nz, left, getBlock); // A was pinned: B takes what is left if it can

  // Inelastic impulse along the normal: remove the approaching relative velocity, keep momentum.
  const vrel = (b.vx - a.vx) * o.nx + (b.vz - a.vz) * o.nz;
  if (vrel < 0) {
    const j = -vrel / (1 / ma + 1 / mb);
    a.vx -= (j / ma) * o.nx;
    a.vz -= (j / ma) * o.nz;
    b.vx += (j / mb) * o.nx;
    b.vz += (j / mb) * o.nz;
  }
  return true;
}

/**
 * `upper` stands on `lower`: grounded, never falling faster than it, and carried by it next frame. A RISING carrier
 * does not hand its upward speed to the rider: the carry already lifts the rider by the carrier's displacement, and
 * adding the speed too would launch it (riders floated 0.13 above a jumping carrier and were dropped).
 */
function standOn(upper, lower) {
  upper.onGround = true;
  const floor = Math.min(lower.vy, 0);
  if (upper.vy < floor) upper.vy = floor;
  upper.carrier = lower;
  upper.carrierAt = [lower.x, lower.y, lower.z];
}

/**
 * Move body k (`p`) `dist` along unit (nx, nz) through the terrain, at most its remaining shove budget.
 * @param {PlayerState} p
 * @returns {number} distance actually gained along n
 */
function pushAlong(p, k, nx, nz, dist, getBlock) {
  dist = Math.min(dist, shove[k]);
  if (!(dist > 0)) return 0;
  const x0 = p.x;
  const z0 = p.z;
  displaceBody(p, nx * dist, 0, nz * dist, getBlock);
  const moved = Math.max(0, (p.x - x0) * nx + (p.z - z0) * nz);
  shove[k] -= moved;
  return moved;
}
