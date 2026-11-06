// Caelancraft — player physics: a vertical cylinder against the honeycomb of hexagonal prisms.
// See src/CONTRACTS.md §12. Pure.
//
// The player is a cylinder of diameter PLAYER_WIDTH and height PLAYER_HEIGHT standing at (x, y, z) (feet).
// Vertical movement is resolved against the cells whose hexagon overlaps the cylinder's footprint; horizontal
// movement is resolved by pushing the footprint circle out of overlapping solid hexagons along the minimum
// translation vector, which gives natural sliding along honeycomb walls. Because the footprint radius is
// smaller than a cell's inradius, the circle can only ever overlap the cell it is in plus its six neighbours.
import {
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT, GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, GROUND_ACCEL,
  AIR_ACCEL, WATER_ACCEL, WATER_GRAVITY, WATER_MAX_SINK, SWIM_UP_SPEED, SWIM_EXIT_JUMP, WATER_SPEED_FACTOR,
  MAX_SUBSTEP_DT, MAX_FRAME_DT, COLLISION_EPS, WATER_SURFACE_HEIGHT, WORLD_HEIGHT,
} from './config.js';
import { yawToForward, yawToRight } from './coords.js';
import { HEX_DIRS, HEX_SIZE, hexToWorld, worldToHex, hexCircleContact } from './hex.js';
import { isSolid, isLiquid } from './blocks.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').PlayerInput} PlayerInput */
/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} AABB */

export const PLAYER_RADIUS = PLAYER_WIDTH / 2;
if (!(PLAYER_RADIUS < HEX_SIZE / 2)) {
  // HEX_SIZE / 2 (0.289) < HEX_INRADIUS (0.5): this single check guarantees both that the player fits through
  // the HEX_SIZE-wide throat of a 1-cell passage and that the 7-column collider is exact.
  throw new Error('physics: PLAYER_WIDTH / 2 must be smaller than HEX_SIZE / 2 (1-cell passages must be passable)');
}

/**
 * Maximum push-out passes per horizontal move (each pass resolves the deepest overlap). If the footprint still
 * overlaps something after that many pushes the move is refused outright (see moveHorizontal).
 */
const MAX_PUSH_PASSES = 8;
/** Columns examined by the collider: the player's own cell plus its six neighbours. */
const COLUMN_COUNT = 7;

/** Set once the first non-finite state has been reported. */
let warnedNonFinite = false;

// Scratch state for the collider (allocation-free hot path).
const colQ = new Int32Array(COLUMN_COUNT);
const colR = new Int32Array(COLUMN_COUNT);
const colX = new Float64Array(COLUMN_COUNT);
const colZ = new Float64Array(COLUMN_COUNT);
const contact = { depth: 0, nx: 0, nz: 0 };

/** Fill colQ/colR/colX/colZ with the cell containing (px, pz) and its six neighbours. */
function gatherColumns(px, pz) {
  const c = worldToHex(px, pz);
  colQ[0] = c[0];
  colR[0] = c[1];
  for (let j = 0; j < 6; j++) {
    colQ[1 + j] = c[0] + HEX_DIRS[j][0];
    colR[1 + j] = c[1] + HEX_DIRS[j][1];
  }
  for (let i = 0; i < COLUMN_COUNT; i++) {
    const w = hexToWorld(colQ[i], colR[i]);
    colX[i] = w[0];
    colZ[i] = w[1];
  }
}

/**
 * @param {number} x feet x
 * @param {number} y feet y (bottom of the cylinder)
 * @param {number} z feet z
 * @returns {PlayerState}
 */
export function createPlayer(x, y, z) {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    onGround: false,
    flying: false,
    sneaking: false,
    sprinting: false,
    inWater: false,
    headInWater: false,
    hitWall: false,
  };
}

/** @param {PlayerState} p @returns {number} eye height above the feet */
export function getEyeHeight(p) {
  return p.sneaking && !p.flying ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
}

/**
 * Axis-aligned bounding box of the player cylinder.
 * @param {PlayerState} p
 * @param {AABB|Object} [out] reused when given
 * @returns {AABB}
 */
export function playerAABB(p, out = {}) {
  out.minX = p.x - PLAYER_RADIUS;
  out.maxX = p.x + PLAYER_RADIUS;
  out.minY = p.y;
  out.maxY = p.y + PLAYER_HEIGHT;
  out.minZ = p.z - PLAYER_RADIUS;
  out.maxZ = p.z + PLAYER_RADIUS;
  return out;
}

/**
 * Strict overlap between the player cylinder and cell (q, y, r): the footprint circle must overlap the
 * cell's hexagon and the height ranges must overlap. Touching does not count.
 * @param {PlayerState} p
 */
export function playerIntersectsBlock(p, q, y, r) {
  if (!(p.y < y + 1 && p.y + PLAYER_HEIGHT > y)) return false;
  const c = hexToWorld(q, r);
  return hexCircleContact(c[0], c[1], p.x, p.z, PLAYER_RADIUS, contact);
}

/**
 * Scan down from fromY for the first integer y where the cell below the feet is solid and the two cells
 * at the feet / head are not, in the column containing world point (x, z).
 * @param {GetBlockFn} getBlock
 * @param {number} x world x
 * @param {number} z world z
 * @param {number} fromY
 * @returns {number|null}
 */
export function findStandingY(getBlock, x, z, fromY) {
  if (!Number.isFinite(x + z + fromY)) return null;
  const [q, r] = worldToHex(x, z);
  let y = Math.min(Math.floor(fromY), WORLD_HEIGHT - 1);
  for (; y >= 1; y--) {
    if (isSolid(getBlock(q, y - 1, r)) && !isSolid(getBlock(q, y, r)) && !isSolid(getBlock(q, y + 1, r))) {
      return y;
    }
  }
  return null;
}

/**
 * True when a cylinder with its feet at world (x, cy, z) overlaps no solid cell: checks the 7 candidate columns
 * whose hexagon overlaps the footprint for solid cells in floor(cy) .. ceil(cy + PLAYER_HEIGHT) − 1.
 * @param {GetBlockFn} getBlock
 */
export function isFreeAt(getBlock, x, cy, z) {
  gatherColumns(x, z);
  const y0 = Math.floor(cy);
  const y1 = Math.ceil(cy + PLAYER_HEIGHT) - 1;
  for (let c = 0; c < COLUMN_COUNT; c++) {
    if (!hexCircleContact(colX[c], colZ[c], x, z, PLAYER_RADIUS, contact)) continue;
    for (let y = y0; y <= y1; y++) {
      if (isSolid(getBlock(colQ[c], y, colR[c]))) return false;
    }
  }
  return true;
}

/**
 * First feet height in fromY, fromY+1, …, fromY+maxUp (integers steps) at which the player cylinder standing at
 * world (x, z) overlaps no solid cell; null when none of them is free. Used by teleports so a target inside a
 * wall snaps up to the first opening above it instead of entombing the player.
 * @param {GetBlockFn} getBlock
 * @param {number} x
 * @param {number} z
 * @param {number} fromY
 * @param {number} [maxUp=2]
 * @returns {number|null}
 */
export function findFreeY(getBlock, x, z, fromY, maxUp = 2) {
  if (!Number.isFinite(x + z + fromY)) return null;
  for (let dy = 0; dy <= maxUp; dy++) {
    const cy = fromY + dy;
    if (cy + PLAYER_HEIGHT > WORLD_HEIGHT) break;
    if (isFreeAt(getBlock, x, cy, z)) return cy;
  }
  return null;
}

/**
 * The cells currently supporting the player: among the 7 candidate columns whose hexagon overlaps the footprint,
 * those whose cell at floor(p.y − 1e-3) is solid (after landing the feet sit COLLISION_EPS above the cell top, so
 * that is the cell being stood on). Empty when airborne. Writes [q, y, r] triples into `out` (cleared first).
 * @param {PlayerState} p
 * @param {GetBlockFn} getBlock
 * @param {number[][]} [out]
 * @returns {number[][]}
 */
export function supportingCells(p, getBlock, out = []) {
  out.length = 0;
  if (!Number.isFinite(p.x + p.y + p.z)) return out;
  const y = Math.floor(p.y - 1e-3);
  if (y < 0 || y >= WORLD_HEIGHT) return out;
  gatherColumns(p.x, p.z);
  for (let c = 0; c < COLUMN_COUNT; c++) {
    if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, PLAYER_RADIUS, contact)) continue;
    if (isSolid(getBlock(colQ[c], y, colR[c]))) out.push([colQ[c], y, colR[c]]);
  }
  return out;
}

/**
 * Advance the player by dt seconds. dt is clamped to MAX_FRAME_DT and split into ceil(dt / MAX_SUBSTEP_DT)
 * equal substeps. Mutates p.
 * @param {PlayerState} p
 * @param {PlayerInput} input
 * @param {GetBlockFn} getBlock
 * @param {number} dt seconds
 */
export function stepPlayer(p, input, getBlock, dt) {
  if (!(dt > 0)) return; // also rejects NaN
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
  const n = Math.ceil(dt / MAX_SUBSTEP_DT);
  const h = dt / n;

  sanitize(p);

  // Wish direction is constant across substeps: compute it once per frame.
  const forward = input.forward || 0;
  const strafe = input.strafe || 0;
  const yaw = input.yaw || 0;
  const [fx, fz] = yawToForward(yaw);
  const [rx, rz] = yawToRight(yaw);
  let wx = fx * forward + rx * strafe;
  let wz = fz * forward + rz * strafe;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl;
    wz /= wl;
  }

  for (let i = 0; i < n; i++) {
    substep(p, input, getBlock, h, wx, wz);
  }
}

/**
 * One substep of h seconds per §12.1.
 * @param {PlayerState} p
 * @param {PlayerInput} input
 * @param {GetBlockFn} getBlock
 * @param {number} h
 * @param {number} wx normalised wish direction x
 * @param {number} wz normalised wish direction z
 */
function substep(p, input, getBlock, h, wx, wz) {
  const jump = !!input.jump;
  const sneak = !!input.sneak;

  // 1. Environment (sampled in the column under the player's centre).
  const [bq, br] = worldToHex(p.x, p.z);
  const feet = getBlock(bq, Math.floor(p.y + 0.1), br);
  const chest = getBlock(bq, Math.floor(p.y + 1.0), br);
  p.inWater = isLiquid(feet) || isLiquid(chest);
  const eyeY = p.y + getEyeHeight(p);
  const eyeCell = Math.floor(eyeY);
  // Only the topmost water block (non-water above) has its surface lowered to WATER_SURFACE_HEIGHT.
  p.headInWater = isLiquid(getBlock(bq, eyeCell, br))
    && (isLiquid(getBlock(bq, eyeCell + 1, br)) || eyeY - eyeCell < WATER_SURFACE_HEIGHT);
  p.sneaking = sneak && !p.flying;
  p.sprinting = !!input.sprint && (input.forward || 0) > 0 && !p.sneaking;

  const flying = p.flying;
  const inWater = p.inWater;

  // 2. Horizontal.
  let speed;
  if (flying) speed = p.sprinting ? FLY_SPRINT_SPEED : FLY_SPEED;
  else if (p.sneaking) speed = SNEAK_SPEED;
  else if (p.sprinting) speed = SPRINT_SPEED;
  else speed = WALK_SPEED;
  if (inWater && !flying) speed *= WATER_SPEED_FACTOR;
  const accel = flying || p.onGround ? GROUND_ACCEL : inWater ? WATER_ACCEL : AIR_ACCEL;
  const k = 1 - Math.exp(-accel * h);
  p.vx += (wx * speed - p.vx) * k + (input.pullX || 0) * h;
  p.vz += (wz * speed - p.vz) * k + (input.pullZ || 0) * h;

  // 3. Vertical.
  if (flying) {
    const target = ((jump ? 1 : 0) - (sneak ? 1 : 0)) * FLY_VERTICAL_SPEED;
    p.vy += (target - p.vy) * (1 - Math.exp(-GROUND_ACCEL * h));
  } else if (inWater) {
    if (jump) p.vy = p.hitWall ? SWIM_EXIT_JUMP : SWIM_UP_SPEED;
    else p.vy = Math.max(p.vy + WATER_GRAVITY * h, WATER_MAX_SINK);
  } else {
    if (jump && p.onGround) p.vy = JUMP_VELOCITY;
    p.vy = Math.max(p.vy + GRAVITY * h, TERMINAL_VELOCITY);
  }
  // External pull (black holes) acts in every mode; terminal velocity still caps a downward drag.
  if (input.pullY) p.vy = Math.max(p.vy + input.pullY * h, TERMINAL_VELOCITY);

  // 4. Move: vertical first, then the horizontal plane.
  p.onGround = false;
  p.hitWall = false;

  const dy = p.vy * h;
  if (moveVertical(p, dy, getBlock)) {
    if (dy < 0) {
      p.onGround = true;
      if (flying) p.flying = false; // landing ends flight
    }
    p.vy = 0;
  }
  if (moveHorizontal(p, p.vx * h, p.vz * h, getBlock)) {
    p.hitWall = true;
  }

  sanitize(p);
}

/**
 * Translate the player vertically and push it back out of any solid cell its footprint overlaps.
 * @param {PlayerState} p
 * @param {number} delta
 * @param {GetBlockFn} getBlock
 * @returns {boolean} true when a collision was resolved
 */
function moveVertical(p, delta, getBlock) {
  if (delta === 0) return false;
  p.y += delta;

  const y0 = Math.floor(p.y);
  const y1 = Math.ceil(p.y + PLAYER_HEIGHT) - 1;
  gatherColumns(p.x, p.z);

  let hit = false;
  let nearestMin = Infinity;  // min(cell bottom) — used when moving up
  let nearestMax = -Infinity; // max(cell top) — used when moving down
  for (let c = 0; c < COLUMN_COUNT; c++) {
    if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, PLAYER_RADIUS, contact)) continue;
    const q = colQ[c];
    const r = colR[c];
    for (let y = y0; y <= y1; y++) {
      if (!isSolid(getBlock(q, y, r))) continue;
      hit = true;
      if (y < nearestMin) nearestMin = y;
      if (y + 1 > nearestMax) nearestMax = y + 1;
    }
  }
  if (!hit) return false;
  if (delta > 0) p.y = nearestMin - PLAYER_HEIGHT - COLLISION_EPS;
  else p.y = nearestMax + COLLISION_EPS;
  return true;
}

/**
 * Translate the player horizontally and push the footprint circle out of every solid hexagon it overlaps,
 * deepest first, up to MAX_PUSH_PASSES times. Each push removes the velocity component into the wall so the
 * player slides along it. The move always ends overlap-free: if the pushes have not converged after
 * MAX_PUSH_PASSES (two near-antiparallel contacts, e.g. the two wall corners pinching the throat of a
 * 1-cell-wide passage) the move is refused and the player stays where it started — a residual overlap
 * would otherwise be "resolved" by the next vertical sweep as a snap onto / under the wall.
 * @param {PlayerState} p
 * @param {number} dx
 * @param {number} dz
 * @param {GetBlockFn} getBlock
 * @returns {boolean} true when at least one collision was resolved (or the move was refused)
 */
function moveHorizontal(p, dx, dz, getBlock) {
  if (dx === 0 && dz === 0) return false;
  const x0 = p.x;
  const z0 = p.z;
  p.x += dx;
  p.z += dz;

  const y0 = Math.floor(p.y);
  const y1 = Math.ceil(p.y + PLAYER_HEIGHT) - 1;
  let collided = false;

  // MAX_PUSH_PASSES pushes plus one final re-check (the last iteration only tests).
  for (let pass = 0; pass <= MAX_PUSH_PASSES; pass++) {
    gatherColumns(p.x, p.z);
    let bestDepth = 0;
    let bnx = 0;
    let bnz = 0;
    for (let c = 0; c < COLUMN_COUNT; c++) {
      if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, PLAYER_RADIUS, contact)) continue;
      if (contact.depth <= bestDepth) continue;
      const q = colQ[c];
      const r = colR[c];
      let solid = false;
      for (let y = y0; y <= y1; y++) {
        if (isSolid(getBlock(q, y, r))) {
          solid = true;
          break;
        }
      }
      if (!solid) continue;
      bestDepth = contact.depth;
      bnx = contact.nx;
      bnz = contact.nz;
    }
    if (bestDepth <= 0) return collided; // overlap-free: done
    if (pass === MAX_PUSH_PASSES) {
      // Did not converge: refuse the move. The pre-move position is overlap-free (every move ends that way),
      // so the vertical sweep can never see a horizontal overlap it did not create.
      p.x = x0;
      p.z = z0;
      p.vx = 0;
      p.vz = 0;
      return true;
    }
    const push = bestDepth + COLLISION_EPS;
    p.x += bnx * push;
    p.z += bnz * push;
    const into = p.vx * bnx + p.vz * bnz;
    if (into < 0) {
      p.vx -= into * bnx;
      p.vz -= into * bnz;
    }
    collided = true;
  }
  return collided;
}

/**
 * Non-finite state → zero velocities (and zero any non-finite position component so getBlock keeps
 * receiving integers); console.warn once per session.
 * @param {PlayerState} p
 */
function sanitize(p) {
  const velOk = Number.isFinite(p.vx) && Number.isFinite(p.vy) && Number.isFinite(p.vz);
  const posOk = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  if (velOk && posOk) return;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  if (!Number.isFinite(p.x)) p.x = 0;
  if (!Number.isFinite(p.y)) p.y = 0;
  if (!Number.isFinite(p.z)) p.z = 0;
  if (!warnedNonFinite) {
    warnedNonFinite = true;
    console.warn('[physics] non-finite player state detected; velocities reset');
  }
}
