// Caelancraft — body-to-body physics: the player and mobs collide, push each other, and stand (and ride) on top
// of each other. See src/CONTRACTS.md §31. Pure.
//
// Every body is a vertical cylinder (physics.js bodyRadius / bodyHeight) with a mass (PLAYER_MASS when absent).
// resolveBodies runs once per frame AFTER every body has been stepped against the terrain:
//   1. Riders are carried: a body that ended last frame standing on another moves by that carrier's displacement.
//   2. Each overlapping pair is separated along its shallower axis:
//      - vertical (the upper body's feet are in the top part of the lower one and the vertical overlap is the
//        smaller): the upper body is lifted out, lands (onGround, no downward speed relative to the carrier) and
//        records the carrier for step 1 next frame;
//      - horizontal: the pair is pushed apart along the line between their centres, each side moving in proportion
//        to the OTHER's mass. Displacement goes through the terrain (physics.displaceBody), so a body pinned against
//        a wall cannot be pushed into it — the other body takes the rest of the separation. The approaching part
//        of their relative velocity is removed with a perfectly inelastic, mass-weighted impulse (momentum kept).
//   Pairs are visited in index order for BODY_PASSES passes so chains (player → pig → pig) settle in one frame.
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

/** @param {PlayerState} b */
export function bodyMass(b) {
  return b.mass ?? PLAYER_MASS;
}

/**
 * Overlap of two body cylinders. Positive `horizontal` and `vertical` both mean they intersect.
 * @param {PlayerState} a
 * @param {PlayerState} b
 * @returns {{ horizontal: number, vertical: number, nx: number, nz: number, dist: number }} n points from a to b
 */
export function bodyOverlap(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const horizontal = bodyRadius(a) + bodyRadius(b) - dist;
  const vertical = Math.min(a.y + bodyHeight(a), b.y + bodyHeight(b)) - Math.max(a.y, b.y);
  // Coincident centres: any direction separates them; +x keeps it deterministic.
  const nx = dist > 1e-9 ? dx / dist : 1;
  const nz = dist > 1e-9 ? dz / dist : 0;
  return { horizontal, vertical, nx, nz, dist };
}

/**
 * Carry riders, then separate every overlapping pair (see the file comment). Mutates the bodies.
 * @param {PlayerState[]} bodies   the player and every active mob (frozen mobs should be left out)
 * @param {GetBlockFn} getBlock
 * @returns {number} pairs that were in contact this frame
 */
export function resolveBodies(bodies, getBlock) {
  carryRiders(bodies, getBlock);
  let contacts = 0;
  for (let pass = 0; pass < BODY_PASSES; pass++) {
    let any = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (separatePair(bodies[i], bodies[j], getBlock)) {
          any = true;
          if (pass === 0) contacts++;
        }
      }
    }
    if (!any) break;
  }
  return contacts;
}

/**
 * A body that stood on a carrier at the end of last frame moves with it (horizontally and vertically), as long as
 * the carrier is still in this frame's list. The link is cleared here and re-made by separatePair if it still stands.
 * @param {PlayerState[]} bodies
 * @param {GetBlockFn} getBlock
 */
function carryRiders(bodies, getBlock) {
  for (const b of bodies) {
    const c = b.carrier;
    b.carrier = null;
    if (!c || !b.carrierAt || !bodies.includes(c)) continue;
    const dx = c.x - b.carrierAt[0];
    const dy = c.y - b.carrierAt[1];
    const dz = c.z - b.carrierAt[2];
    if (dx !== 0 || dy !== 0 || dz !== 0) displaceBody(b, dx, dy, dz, getBlock);
  }
}

/**
 * Separate one pair. @returns {boolean} true when they overlapped
 * @param {PlayerState} a
 * @param {PlayerState} b
 * @param {GetBlockFn} getBlock
 */
function separatePair(a, b, getBlock) {
  const o = bodyOverlap(a, b);
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
  const total = o.horizontal + COLLISION_EPS;
  const shareB = ma / (ma + mb);
  const movedB = pushAlong(b, o.nx, o.nz, total * shareB, getBlock);
  const movedA = pushAlong(a, -o.nx, -o.nz, total - movedB, getBlock);
  const left = total - movedB - movedA;
  if (left > 1e-6) pushAlong(b, o.nx, o.nz, left, getBlock); // A was pinned: B takes what is left if it can

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

/** `upper` stands on `lower`: grounded, no downward speed relative to it, and carried by it next frame. */
function standOn(upper, lower) {
  upper.onGround = true;
  if (upper.vy < lower.vy) upper.vy = lower.vy;
  upper.carrier = lower;
  upper.carrierAt = [lower.x, lower.y, lower.z];
}

/**
 * Move a body `dist` along unit (nx, nz) through the terrain. @returns {number} distance actually gained along n
 * @param {PlayerState} p
 */
function pushAlong(p, nx, nz, dist, getBlock) {
  if (!(dist > 0)) return 0;
  const x0 = p.x;
  const z0 = p.z;
  displaceBody(p, nx * dist, 0, nz * dist, getBlock);
  return Math.max(0, (p.x - x0) * nx + (p.z - z0) * nz);
}
