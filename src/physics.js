// Caelancraft — player physics: swept AABB against the voxel grid. See src/CONTRACTS.md §12. Pure.
//
import {
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT, GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, GROUND_ACCEL,
  AIR_ACCEL, WATER_ACCEL, WATER_GRAVITY, WATER_MAX_SINK, SWIM_UP_SPEED, SWIM_EXIT_JUMP, WATER_SPEED_FACTOR,
  MAX_SUBSTEP_DT, MAX_FRAME_DT, COLLISION_EPS, WATER_SURFACE_HEIGHT, WORLD_HEIGHT,
} from './config.js';
import { yawToForward, yawToRight } from './coords.js';
import { isSolid, isLiquid } from './blocks.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').PlayerInput} PlayerInput */
/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} AABB */

const HALF_WIDTH = PLAYER_WIDTH / 2;
const AXIS_X = 0;
const AXIS_Y = 1;
const AXIS_Z = 2;

/** Set once the first non-finite state has been reported. */
let warnedNonFinite = false;

/**
 * @param {number} x feet x
 * @param {number} y feet y (bottom of the AABB)
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
 * @param {PlayerState} p
 * @param {AABB|Object} [out] reused when given
 * @returns {AABB}
 */
export function playerAABB(p, out = {}) {
  out.minX = p.x - HALF_WIDTH;
  out.maxX = p.x + HALF_WIDTH;
  out.minY = p.y;
  out.maxY = p.y + PLAYER_HEIGHT;
  out.minZ = p.z - HALF_WIDTH;
  out.maxZ = p.z + HALF_WIDTH;
  return out;
}

/**
 * Strict overlap between the player AABB and block cell [bx,bx+1)×[by,by+1)×[bz,bz+1).
 * Touching faces do not count.
 * @param {PlayerState} p
 */
export function playerIntersectsBlock(p, bx, by, bz) {
  return (
    p.x - HALF_WIDTH < bx + 1 && p.x + HALF_WIDTH > bx &&
    p.y < by + 1 && p.y + PLAYER_HEIGHT > by &&
    p.z - HALF_WIDTH < bz + 1 && p.z + HALF_WIDTH > bz
  );
}

/**
 * Scan down from fromY for the first integer y where block(y-1) is solid and blocks y and y+1 are not.
 * @param {GetBlockFn} getBlock
 * @param {number} x continuous or integer world x
 * @param {number} z
 * @param {number} fromY
 * @returns {number|null}
 */
export function findStandingY(getBlock, x, z, fromY) {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  if (!Number.isFinite(fromY)) return null;
  let y = Math.min(Math.floor(fromY), WORLD_HEIGHT - 1);
  for (; y >= 1; y--) {
    if (isSolid(getBlock(bx, y - 1, bz)) && !isSolid(getBlock(bx, y, bz)) && !isSolid(getBlock(bx, y + 1, bz))) {
      return y;
    }
  }
  return null;
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

  // 1. Environment.
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  const feet = getBlock(bx, Math.floor(p.y + 0.1), bz);
  const chest = getBlock(bx, Math.floor(p.y + 1.0), bz);
  p.inWater = isLiquid(feet) || isLiquid(chest);
  const eyeY = p.y + getEyeHeight(p);
  const eyeCell = Math.floor(eyeY);
  // Only the topmost water block (non-water above) has its surface lowered to WATER_SURFACE_HEIGHT.
  p.headInWater = isLiquid(getBlock(bx, eyeCell, bz))
    && (isLiquid(getBlock(bx, eyeCell + 1, bz)) || eyeY - eyeCell < WATER_SURFACE_HEIGHT);
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
  p.vx += (wx * speed - p.vx) * k;
  p.vz += (wz * speed - p.vz) * k;

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

  // 4. Move Y → X → Z.
  p.onGround = false;
  p.hitWall = false;

  const dy = p.vy * h;
  if (moveAxis(p, AXIS_Y, dy, getBlock)) {
    if (dy < 0) {
      p.onGround = true;
      if (flying) p.flying = false; // landing ends flight
    }
    p.vy = 0;
  }
  if (moveAxis(p, AXIS_X, p.vx * h, getBlock)) {
    p.vx = 0;
    p.hitWall = true;
  }
  if (moveAxis(p, AXIS_Z, p.vz * h, getBlock)) {
    p.vz = 0;
    p.hitWall = true;
  }

  sanitize(p);
}

/**
 * Translate the player along one axis and push it back out of any solid cell it now overlaps.
 * Allocation-free.
 * @param {PlayerState} p
 * @param {0|1|2} axis
 * @param {number} delta
 * @param {GetBlockFn} getBlock
 * @returns {boolean} true when a collision was resolved
 */
function moveAxis(p, axis, delta, getBlock) {
  if (delta === 0) return false;

  if (axis === AXIS_X) p.x += delta;
  else if (axis === AXIS_Y) p.y += delta;
  else p.z += delta;

  const minX = p.x - HALF_WIDTH;
  const maxX = p.x + HALF_WIDTH;
  const minY = p.y;
  const maxY = p.y + PLAYER_HEIGHT;
  const minZ = p.z - HALF_WIDTH;
  const maxZ = p.z + HALF_WIDTH;

  const x0 = Math.floor(minX);
  const x1 = Math.ceil(maxX) - 1;
  const y0 = Math.floor(minY);
  const y1 = Math.ceil(maxY) - 1;
  const z0 = Math.floor(minZ);
  const z1 = Math.ceil(maxZ) - 1;

  // Track the extreme cell face on the moving axis over every solid cell overlapped.
  let hit = false;
  let nearestMin = Infinity;  // min(cellMin[axis]) — used when delta > 0
  let nearestMax = -Infinity; // max(cellMax[axis]) — used when delta < 0

  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        if (!isSolid(getBlock(x, y, z))) continue;
        hit = true;
        const c = axis === AXIS_X ? x : axis === AXIS_Y ? y : z;
        if (c < nearestMin) nearestMin = c;
        if (c + 1 > nearestMax) nearestMax = c + 1;
      }
    }
  }
  if (!hit) return false;

  if (axis === AXIS_Y) {
    if (delta > 0) p.y = nearestMin - PLAYER_HEIGHT - COLLISION_EPS;
    else p.y = nearestMax + COLLISION_EPS;
  } else if (axis === AXIS_X) {
    if (delta > 0) p.x = nearestMin - HALF_WIDTH - COLLISION_EPS;
    else p.x = nearestMax + HALF_WIDTH + COLLISION_EPS;
  } else {
    if (delta > 0) p.z = nearestMin - HALF_WIDTH - COLLISION_EPS;
    else p.z = nearestMax + HALF_WIDTH + COLLISION_EPS;
  }
  return true;
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
