// Caelancraft — player physics: a vertical cylinder against the honeycomb of hexagonal prisms.
// See src/CONTRACTS.md §12. Pure.
//
// The player is a cylinder of diameter PLAYER_WIDTH and height PLAYER_HEIGHT standing at (x, y, z) (feet).
// Other bodies (mobs) carry their own `radius` and `height` (createBody); every routine here reads them through
// bodyRadius / bodyHeight, so a state without them is a player-sized body.
// Vertical movement is resolved against the cells whose hexagon overlaps the cylinder's footprint; horizontal
// movement is resolved by pushing the footprint circle out of overlapping solid hexagons along the minimum
// translation vector, which gives natural sliding along honeycomb walls. Because the footprint radius is
// smaller than a cell's inradius, the circle can only ever overlap the cell it is in plus its six neighbours.
import {
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT, GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, GROUND_ACCEL,
  AIR_ACCEL, WATER_ACCEL, WATER_GRAVITY, WATER_MAX_SINK, SWIM_UP_SPEED, SWIM_EXIT_JUMP, WATER_SPEED_FACTOR,
  MAX_SUBSTEP_DT, MAX_FRAME_DT, COLLISION_EPS, WORLD_HEIGHT, WADE_DEPTH, WADE_SPEED_FACTOR,
} from './config.js';
import { yawToForward, yawToRight } from './coords.js';
import { HEX_DIRS, HEX_SIZE, hexToWorld, worldToHex, hexCircleContact } from './hex.js';
import { isSolid, isLiquid, waterSurfaceHeight } from './blocks.js';

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
 * Largest body radius the 7-column collider handles exactly: a footprint circle centred anywhere in a cell can only
 * reach that cell's six neighbours while its radius is below the hexagon edge length HEX_SIZE (≈ 0.577); keep a margin.
 */
export const MAX_BODY_RADIUS = 0.5;

/** @param {PlayerState} p @returns {number} footprint radius */
export function bodyRadius(p) {
  return p.radius ?? PLAYER_RADIUS;
}
/** @param {PlayerState} p @returns {number} cylinder height */
export function bodyHeight(p) {
  return p.height ?? PLAYER_HEIGHT;
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
/**
 * A body of a given size and mass (a mob): a PlayerState plus `radius`, `height` and `mass`. Throws when the radius is
 * not in (0, MAX_BODY_RADIUS] or the height / mass are not positive.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ radius: number, height: number, mass?: number }} size
 * @returns {PlayerState}
 */
export function createBody(x, y, z, size) {
  const { radius, height, mass = 1 } = size;
  if (!(radius > 0 && radius <= MAX_BODY_RADIUS)) throw new RangeError(`createBody: radius must be in (0, ${MAX_BODY_RADIUS}]`);
  if (!(height > 0) || !(mass > 0)) throw new RangeError('createBody: height and mass must be positive');
  return Object.assign(createPlayer(x, y, z), { radius, height, mass });
}

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
  const rad = bodyRadius(p);
  out.minX = p.x - rad;
  out.maxX = p.x + rad;
  out.minY = p.y;
  out.maxY = p.y + bodyHeight(p);
  out.minZ = p.z - rad;
  out.maxZ = p.z + rad;
  return out;
}

/**
 * Strict overlap between the player cylinder and cell (q, y, r): the footprint circle must overlap the
 * cell's hexagon and the height ranges must overlap. Touching does not count.
 * @param {PlayerState} p
 */
export function playerIntersectsBlock(p, q, y, r) {
  if (!(p.y < y + 1 && p.y + bodyHeight(p) > y)) return false;
  const c = hexToWorld(q, r);
  return hexCircleContact(c[0], c[1], p.x, p.z, bodyRadius(p), contact);
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
 * whose hexagon overlaps the footprint for solid cells in floor(cy) .. ceil(cy + height) − 1.
 * @param {GetBlockFn} getBlock
 * @param {number} [radius=PLAYER_RADIUS]
 * @param {number} [height=PLAYER_HEIGHT]
 */
export function isFreeAt(getBlock, x, cy, z, radius = PLAYER_RADIUS, height = PLAYER_HEIGHT) {
  gatherColumns(x, z);
  const y0 = Math.floor(cy);
  const y1 = Math.ceil(cy + height) - 1;
  for (let c = 0; c < COLUMN_COUNT; c++) {
    if (!hexCircleContact(colX[c], colZ[c], x, z, radius, contact)) continue;
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
 * @param {number} [radius=PLAYER_RADIUS]
 * @param {number} [height=PLAYER_HEIGHT]
 * @returns {number|null}
 */
export function findFreeY(getBlock, x, z, fromY, maxUp = 2, radius = PLAYER_RADIUS, height = PLAYER_HEIGHT) {
  if (!Number.isFinite(x + z + fromY)) return null;
  for (let dy = 0; dy <= maxUp; dy++) {
    const cy = fromY + dy;
    if (cy + height > WORLD_HEIGHT) break;
    if (isFreeAt(getBlock, x, cy, z, radius, height)) return cy;
  }
  return null;
}

/**
 * Is the point at height `py` in cell column (q, r) under a water surface? The point's cell must be water and the point
 * below that cell's surface (`waterSurfaceHeight`: 1 under more water, 0.875 at a source's or falling water's top,
 * k/7 · 0.875 in flowing water of level k). Used for the chest and eye samples of stepPlayer.
 * @param {GetBlockFn} getBlock
 * @returns {boolean}
 */
export function isUnderSurface(getBlock, q, py, r) {
  const cy = Math.floor(py);
  const id = getBlock(q, cy, r);
  return isLiquid(id) && py - cy < waterSurfaceHeight(id, getBlock(q, cy + 1, r));
}

/**
 * Whether a swimming mob should paddle up this frame (KNOWN-ISSUES V1; CONTRACTS §72): only while its float point —
 * FLOAT_POINT of the way up its body — is under water, or it presses into a bank (the exit jump). So it rides low in the
 * water with its back out instead of being launched clear of the surface and looking as if it stood on it.
 * @param {GetBlockFn} getBlock @param {PlayerState} p  a body with `inWater` / `hitWall` from its last step
 * @returns {boolean}
 */
export function shouldPaddle(getBlock, p) {
  if (!p.inWater) return false;
  if (p.hitWall) return true;
  const [q, r] = worldToHex(p.x, p.z);
  return isUnderSurface(getBlock, q, p.y + bodyHeight(p) * FLOAT_POINT, r);
}
/** Where a swimming mob floats: this share of its height is under water. */
export const FLOAT_POINT = 0.45;
/** A swimmer riding higher than its float line settles back at this speed (m/s); within FLOAT_NEAR below it, it rises gently. */
export const FLOAT_SETTLE = 2;
export const FLOAT_NEAR = 0.25;
export const FLOAT_RISE = 0.8;

/**
 * After a mob's step in water (KNOWN-ISSUES V1): keep it at its float line — the surface of the water column it is in,
 * FLOAT_POINT of its height above its feet. Riding higher (the paddle carried it up), it settles back down and stops
 * rising; just under the line it rises gently, so it does not overshoot and bob. Left alone: a body on the ground, one
 * pressing into a bank or still carried up by an exit jump (so it can climb out), and one over no water.
 * @param {GetBlockFn} getBlock @param {PlayerState} p @param {number} dt
 */
export function settleFloat(getBlock, p, dt) {
  if (p.onGround || p.hitWall || p.vy > SWIM_UP_SPEED + 0.01) return;
  const [q, r] = worldToHex(p.x, p.z);
  const h = bodyHeight(p);
  // The water surface of this column, looking down from just above the head to the feet.
  let surface = NaN;
  for (let cy = Math.floor(p.y + h); cy >= Math.floor(p.y) - 1; cy--) {
    const id = getBlock(q, cy, r);
    if (!isLiquid(id)) continue;
    const above = getBlock(q, cy + 1, r);
    if (isLiquid(above)) continue;
    surface = cy + waterSurfaceHeight(id, above);
    break;
  }
  if (Number.isNaN(surface)) return;
  const line = surface - h * FLOAT_POINT; // where its feet belong
  if (p.y > line) {
    if (p.y - line > h * (1 - FLOAT_POINT)) return; // well clear of the water (falling in, or thrown): leave it to gravity
    p.y = Math.max(line, p.y - FLOAT_SETTLE * dt);
    if (p.vy > 0) p.vy = 0;
  } else if (line - p.y < FLOAT_NEAR && p.vy > FLOAT_RISE) {
    p.vy = FLOAT_RISE;
  }
}

/**
 * Would a body standing on the floor below cell (q, y, r) — or one step down, in (q, y − 1, r) — have to SWIM there?
 * True when that water is two or more cells deep or its surface is more than WADE_DEPTH above the floor; a shallow film
 * is wading. Pigs use it to keep out of deep water only (CONTRACTS §30).
 * @param {GetBlockFn} getBlock
 * @returns {boolean}
 */
export function isSwimWater(getBlock, q, y, r) {
  let top = y;
  let id = getBlock(q, top, r);
  if (!isLiquid(id)) {
    top = y - 1;
    id = getBlock(q, top, r);
    if (!isLiquid(id)) return false;
  }
  if (isLiquid(getBlock(q, top - 1, r))) return true;
  return waterSurfaceHeight(id, getBlock(q, top + 1, r)) > WADE_DEPTH;
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
    if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, bodyRadius(p), contact)) continue;
    if (isSolid(getBlock(colQ[c], y, colR[c]))) out.push([colQ[c], y, colR[c]]);
  }
  return out;
}

/**
 * Advance the player by dt seconds. dt is clamped to MAX_FRAME_DT and split into ceil(dt / MAX_SUBSTEP_DT)
 * equal substeps. Mutates p.
 * v0.9 (DESIGN-survival §9.3): `p.landSpeed` is set to 0 on entry (a dt ≤ 0 or NaN step changes nothing at all), then
 * to the fastest downward speed (m/s) at which a substep's vertical move hit a floor (0 without a landing; standing
 * records one substep of gravity). `input.speedFactor` (0..1, absent = 1) scales the horizontal target speed on foot,
 * never in flight.
 * @param {PlayerState} p
 * @param {PlayerInput} input
 * @param {GetBlockFn} getBlock
 * @param {number} dt seconds
 */
export function stepPlayer(p, input, getBlock, dt) {
  if (!(dt > 0)) return; // also rejects NaN (the state is left exactly as it was)
  // v0.9 (DESIGN-survival §9.3): the fastest landing of THIS step; survival.step consumes it (reads, then zeroes it).
  p.landSpeed = 0;
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

  // 1. Environment (sampled in the column under the player's centre). v0.8: water surfaces follow waterSurfaceHeight
  // (a flowing level k is k/7 of a full surface); a body swims only where the water over the floor of its feet column is
  // two cells deep or its surface is more than WADE_DEPTH above that floor (isSwimWater), or its chest point is under
  // water — shallower water (a level-1 film) is wading: walking, just slower.
  const [bq, br] = worldToHex(p.x, p.z);
  const feetY = Math.floor(p.y + 0.1);
  const feet = getBlock(bq, feetY, br);
  const chestPoint = p.y + Math.min(1.0, bodyHeight(p) * 0.6); // a short body's chest is lower
  const feetWet = isLiquid(feet);
  // Depth is measured over the FLOOR of the feet column (isSwimWater), not below the body's own feet: a body floating
  // near the top of deep water is still swimming (it keeps its buoyancy and SWIM_EXIT_JUMP), while a body standing in
  // a film is wading.
  p.inWater = (feetWet && isSwimWater(getBlock, bq, feetY, br)) || isUnderSurface(getBlock, bq, chestPoint, br);
  const wading = feetWet && !p.inWater;
  p.headInWater = isUnderSurface(getBlock, bq, p.y + getEyeHeight(p), br);
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
  else if (wading && !flying) speed *= WADE_SPEED_FACTOR;
  // v0.9 (DESIGN-survival §9.3): survival slowness (hunger, cold, wounds…) scales the target speed on foot, never in flight.
  if (!flying) speed *= speedFactorOf(input);
  // v0.11 (CONTRACTS §69): a body's own `speedScale` (a running horse, a trotting sheep) scales it too; absent or bad = 1.
  if (!flying && typeof p.speedScale === 'number' && p.speedScale > 0 && Number.isFinite(p.speedScale)) speed *= p.speedScale;
  const accel = flying || p.onGround ? GROUND_ACCEL : inWater ? WATER_ACCEL : AIR_ACCEL;
  const k = 1 - Math.exp(-accel * h);
  // External pull (black holes) moves the velocity the relaxation heads for by pull / GROUND_ACCEL, in every mode.
  // The drift it adds is then pull / GROUND_ACCEL whatever the substep size or the accel state. A raw pull·h here
  // would drift pull·h/k: about 18 % more on the ground at 60 Hz and 5× more in the air (AIR_ACCEL).
  p.vx += (wx * speed + (input.pullX || 0) / GROUND_ACCEL - p.vx) * k;
  p.vz += (wz * speed + (input.pullZ || 0) / GROUND_ACCEL - p.vz) * k;

  // 3. Vertical.
  if (flying) {
    const target = ((jump ? 1 : 0) - (sneak ? 1 : 0)) * FLY_VERTICAL_SPEED + (input.pullY || 0) / GROUND_ACCEL;
    p.vy += (target - p.vy) * (1 - Math.exp(-GROUND_ACCEL * h));
  } else if (inWater) {
    // input.noExitJump: paddle up but never launch out of the water at a bank (a pig carrying another pig, §30).
    if (jump) p.vy = p.hitWall && !input.noExitJump ? SWIM_EXIT_JUMP : SWIM_UP_SPEED;
    else p.vy = Math.max(p.vy + WATER_GRAVITY * h, WATER_MAX_SINK);
  } else {
    if (jump && p.onGround) p.vy = JUMP_VELOCITY;
    p.vy = Math.max(p.vy + GRAVITY * h, TERMINAL_VELOCITY);
  }
  // Falling and swimming have no relaxation, so there the pull is a plain acceleration (terminal velocity still caps a
  // downward drag); flying took it into its target above.
  if (input.pullY && !flying) p.vy = Math.max(p.vy + input.pullY * h, TERMINAL_VELOCITY);

  // 4. Move: vertical first, then the horizontal plane.
  p.onGround = false;
  p.hitWall = false;

  const dy = p.vy * h;
  if (moveVertical(p, dy, getBlock)) {
    if (dy < 0) {
      p.onGround = true;
      if (flying) p.flying = false; // landing ends flight
      // v0.9 (DESIGN-survival §9.3): the impact speed, before vy is zeroed (fall damage). In every mode, for every body.
      // Resting on the ground records the one substep of gravity (GRAVITY·h ≈ 0.47 m/s at 60 Hz): far below any harm.
      const impact = -p.vy;
      if (impact > (p.landSpeed || 0)) p.landSpeed = impact;
    }
    p.vy = 0;
  }
  if (moveHorizontal(p, p.vx * h, p.vz * h, getBlock)) {
    p.hitWall = true;
  }

  sanitize(p);
}

/**
 * The survival slow-down factor of an input (DESIGN-survival §9.3): `input.speedFactor`, clamped to 0..1; 1 when absent
 * or not a finite number.
 * @param {PlayerInput} input
 * @returns {number}
 */
export function speedFactorOf(input) {
  const f = input.speedFactor;
  if (typeof f !== 'number' || !Number.isFinite(f)) return 1;
  return f < 0 ? 0 : f > 1 ? 1 : f;
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

  const rad = bodyRadius(p);
  const height = bodyHeight(p);
  const y0 = Math.floor(p.y);
  const y1 = Math.ceil(p.y + height) - 1;
  gatherColumns(p.x, p.z);

  let hit = false;
  let nearestMin = Infinity;  // min(cell bottom) — used when moving up
  let nearestMax = -Infinity; // max(cell top) — used when moving down
  for (let c = 0; c < COLUMN_COUNT; c++) {
    if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, rad, contact)) continue;
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
  if (delta > 0) p.y = nearestMin - height - COLLISION_EPS;
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

  const rad = bodyRadius(p);
  const y0 = Math.floor(p.y);
  const y1 = Math.ceil(p.y + bodyHeight(p)) - 1;
  let collided = false;

  // MAX_PUSH_PASSES pushes plus one final re-check (the last iteration only tests).
  for (let pass = 0; pass <= MAX_PUSH_PASSES; pass++) {
    gatherColumns(p.x, p.z);
    let bestDepth = 0;
    let bnx = 0;
    let bnz = 0;
    for (let c = 0; c < COLUMN_COUNT; c++) {
      if (!hexCircleContact(colX[c], colZ[c], p.x, p.z, rad, contact)) continue;
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
 * Displace a body through the terrain (no gravity, no input): horizontal first, sliding along walls exactly like
 * walking, then vertical. Used to push bodies apart and to carry riders. Velocities into walls are removed.
 * @param {PlayerState} p
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @param {GetBlockFn} getBlock
 * @returns {{ hitWall: boolean, hitFloorOrCeiling: boolean }}
 */
export function displaceBody(p, dx, dy, dz, getBlock) {
  sanitize(p);
  const hitWall = Number.isFinite(dx + dz) ? moveHorizontal(p, dx, dz, getBlock) : false;
  const hitFloorOrCeiling = Number.isFinite(dy) ? moveVertical(p, dy, getBlock) : false;
  if (hitFloorOrCeiling) {
    if (dy < 0) p.onGround = true;
    if ((dy < 0 && p.vy < 0) || (dy > 0 && p.vy > 0)) p.vy = 0;
  }
  return { hitWall, hitFloorOrCeiling };
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
