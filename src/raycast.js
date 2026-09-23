// Caelancraft — voxel ray casting (Amanatides–Woo DDA). See src/CONTRACTS.md §11. Pure.
import { WORLD_HEIGHT } from './config.js';
import { FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ } from './coords.js';
import { isTargetable } from './blocks.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').BlockId} BlockId */

/**
 * Hard ceiling on DDA steps when `maxDistance` is not finite (Infinity/NaN). The contract's own cap,
 * `ceil(maxDistance*3)+3`, is used for every finite `maxDistance`; this only exists so a misuse such as
 * `maxDistance = Infinity` in an all-AIR world can never hang the game loop.
 */
export const UNBOUNDED_ITERATION_CAP = 1 << 16;

/**
 * Casts a ray from `(ox,oy,oz)` along `(dx,dy,dz)` through the voxel grid and returns the first cell for
 * which `isHit(getBlock(x,y,z))` is true, or `null`.
 *
 * - The direction is normalised internally; a zero (or non-finite) direction returns `null`.
 * - If the start cell `(floor(ox), floor(oy), floor(oz))` is already a hit, the result has `face: -1`,
 *   a zero normal and `distance: 0`.
 * - Otherwise the grid is traversed with the Amanatides–Woo algorithm. When two or three axis boundaries
 *   are crossed at exactly the same `t`, the tie is broken x, then y, then z (one cell per step, never a
 *   diagonal jump).
 * - `distance` is measured in blocks along the *normalised* ray; a hit exactly at `maxDistance` counts.
 * - The walk stops early once the ray is below the world and not moving up, or at/above `WORLD_HEIGHT`
 *   and not moving down. It is additionally bounded by `ceil(maxDistance*3)+3` iterations.
 *
 * Only the returned hit object is allocated; the traversal itself is allocation-free.
 *
 * @param {GetBlockFn} getBlock  integer world block coordinates → BlockId (AIR outside the world)
 * @param {number} ox  ray origin
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx  ray direction (any length)
 * @param {number} dy
 * @param {number} dz
 * @param {number} maxDistance  maximum distance in blocks along the normalised ray (inclusive)
 * @param {(id: BlockId) => boolean} [isHit=isTargetable]  predicate deciding which blocks stop the ray
 * @returns {RaycastHit|null}
 */
export function raycastVoxel(getBlock, ox, oy, oz, dx, dy, dz, maxDistance, isHit = isTargetable) {
  // Garbage-in guard: any NaN/Infinity would poison every tMax below and spin until the cap.
  if (!Number.isFinite(ox + oy + oz + dx + dy + dz)) return null;

  // Normalise the direction so that t is a distance in blocks.
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return null;
  dx /= len;
  dy /= len;
  dz /= len;

  // Start cell (Math.floor: correct for negative coordinates).
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const startId = getBlock(x, y, z);
  if (isHit(startId)) {
    return { x, y, z, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, blockId: startId };
  }

  // Step direction per axis: -1, 0 or +1.
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // Distance along the ray between successive boundary crossings on each axis.
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);

  // Distance along the ray to the first boundary crossing on each axis.
  let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;

  // Faces entered when stepping along each axis (the face whose normal points back toward the origin).
  const faceX = stepX > 0 ? FACE_NX : FACE_PX;
  const faceY = stepY > 0 ? FACE_NY : FACE_PY;
  const faceZ = stepZ > 0 ? FACE_NZ : FACE_PZ;

  // Iteration cap. For a unit direction at most |dx|+|dy|+|dz| <= sqrt(3) boundaries are crossed per block,
  // so the contract's 3 per block (+3) never truncates a finite ray; it is purely a termination guarantee.
  let maxIter = Math.ceil(maxDistance * 3) + 3;
  if (!(maxIter <= UNBOUNDED_ITERATION_CAP)) maxIter = UNBOUNDED_ITERATION_CAP; // Infinity or NaN

  for (let i = 0; i < maxIter; i++) {
    let t;
    let face;
    let nx = 0;
    let ny = 0;
    let nz = 0;

    // Advance along the axis whose boundary is nearest; ties break x, then y, then z.
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX;
      if (t > maxDistance) return null;
      x += stepX;
      tMaxX += tDeltaX;
      face = faceX;
      nx = -stepX;
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY;
      if (t > maxDistance) return null;
      y += stepY;
      tMaxY += tDeltaY;
      face = faceY;
      ny = -stepY;
    } else {
      t = tMaxZ;
      if (t > maxDistance) return null;
      z += stepZ;
      tMaxZ += tDeltaZ;
      face = faceZ;
      nz = -stepZ;
    }

    // Left the world vertically with no way back in: nothing further can be hit.
    if (y < 0 && stepY <= 0) return null;
    if (y >= WORLD_HEIGHT && stepY >= 0) return null;

    const id = getBlock(x, y, z);
    if (isHit(id)) {
      // `(cell - o) / d` yields -0 when the origin sits exactly on the boundary; report a clean +0.
      if (t === 0) t = 0;
      return { x, y, z, face, nx, ny, nz, distance: t, blockId: id };
    }
  }
  return null;
}
