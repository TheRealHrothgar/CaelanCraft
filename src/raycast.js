// Caelancraft — ray casting through the honeycomb of hexagonal prisms. See src/CONTRACTS.md §11. Pure.
//
// Unlike a cube grid there is no incremental DDA; instead every step computes, from scratch, where the ray
// leaves the current prism (the nearest of its 8 face planes the ray is heading out through) and moves to
// the neighbour across that face. Recomputing per cell keeps the walk exact and self-correcting: no
// accumulated error, no missed corners.
import { WORLD_HEIGHT } from './config.js';
import {
  HEX_DIRS, HEX_INRADIUS, FACE_NORMALS, FACE_OPPOSITE, FACE_TOP, FACE_BOTTOM, SIDE_FACE_COUNT, hexToWorld, worldToHex,
} from './hex.js';
import { isTargetable } from './blocks.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').BlockId} BlockId */

/**
 * Hard ceiling on steps per cast. The per-call cap is `min(ceil(maxDistance*6)+6, UNBOUNDED_ITERATION_CAP)`, so a
 * finite `maxDistance` above ~10 921 blocks is truncated at this many cells and Infinity/NaN get exactly this many;
 * either way a misuse such as `maxDistance = Infinity` in an all-AIR world can never hang the game loop.
 */
export const UNBOUNDED_ITERATION_CAP = 1 << 16;

/** A face plane only counts as an exit when the ray heads out through it at least this steeply. */
const EXIT_EPS = 1e-12;

/**
 * Casts a ray from `(ox,oy,oz)` along `(dx,dy,dz)` through the hex-prism grid and returns the first cell for
 * which `isHit(getBlock(q,y,r))` is true, or `null`.
 *
 * - The direction is normalised internally; a zero (or non-finite) direction returns `null`.
 * - If the start cell (hex.worldToHex(ox, oz), floor(oy)) is already a hit, the result has `face: -1`,
 *   a zero normal and `distance: 0`.
 * - Otherwise each step leaves the current prism through the face whose plane the ray crosses first
 *   (ties → lowest face index) and enters the neighbour through the opposite face, whose outward normal is
 *   reported as the hit normal.
 * - `distance` is measured in blocks along the *normalised* ray; a hit exactly at `maxDistance` counts.
 * - The walk stops early once the ray is below the world and not moving up, or at/above `WORLD_HEIGHT`
 *   and not moving down. It is additionally bounded by `min(ceil(maxDistance*6)+6, UNBOUNDED_ITERATION_CAP)` iterations.
 *
 * Only the returned hit object is allocated; the traversal itself is allocation-free.
 *
 * @param {GetBlockFn} getBlock  integer cell coordinates (q, y, r) → BlockId (AIR outside the world)
 * @param {number} ox  ray origin (world)
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx  ray direction (any length)
 * @param {number} dy
 * @param {number} dz
 * @param {number} maxDistance  maximum distance in blocks along the normalised ray (inclusive)
 * @param {(id: BlockId) => boolean} [isHit=isTargetable]  predicate deciding which blocks stop the ray
 * @returns {RaycastHit|null}
 */
export function raycastHex(getBlock, ox, oy, oz, dx, dy, dz, maxDistance, isHit = isTargetable) {
  // Garbage-in guard: any NaN/Infinity would poison every plane test below and spin until the cap.
  if (!Number.isFinite(ox + oy + oz + dx + dy + dz)) return null;

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return null;
  dx /= len;
  dy /= len;
  dz /= len;

  const start = worldToHex(ox, oz);
  let q = start[0];
  let r = start[1];
  let y = Math.floor(oy);

  const startId = getBlock(q, y, r);
  if (isHit(startId)) {
    return { q, y, r, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, blockId: startId };
  }

  let maxIter = Math.ceil(maxDistance * 6) + 6;
  if (!(maxIter <= UNBOUNDED_ITERATION_CAP)) maxIter = UNBOUNDED_ITERATION_CAP; // Infinity, NaN or a huge finite distance

  let tCur = 0;
  for (let i = 0; i < maxIter; i++) {
    const c = hexToWorld(q, r);
    const rx = ox - c[0];
    const rz = oz - c[1];

    // Nearest exit plane among the faces the ray is heading out through.
    let tBest = Infinity;
    let exit = -1;
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      const n = FACE_NORMALS[j];
      const denom = dx * n[0] + dz * n[2];
      if (denom <= EXIT_EPS) continue;
      const t = (HEX_INRADIUS - (rx * n[0] + rz * n[2])) / denom;
      if (t < tBest) {
        tBest = t;
        exit = j;
      }
    }
    if (dy > EXIT_EPS) {
      const t = (y + 1 - oy) / dy;
      if (t < tBest) {
        tBest = t;
        exit = FACE_TOP;
      }
    } else if (dy < -EXIT_EPS) {
      const t = (y - oy) / dy;
      if (t < tBest) {
        tBest = t;
        exit = FACE_BOTTOM;
      }
    }
    if (exit < 0) return null; // cannot happen for a unit direction; defensive

    // Floating-point guard: never walk backwards, never report -0.
    if (tBest < tCur) tBest = tCur;
    if (tBest === 0) tBest = 0;
    if (tBest > maxDistance) return null;
    tCur = tBest;

    let face;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (exit === FACE_TOP) {
      y += 1;
      face = FACE_BOTTOM;
      ny = -1;
    } else if (exit === FACE_BOTTOM) {
      y -= 1;
      face = FACE_TOP;
      ny = 1;
    } else {
      q += HEX_DIRS[exit][0];
      r += HEX_DIRS[exit][1];
      face = FACE_OPPOSITE[exit];
      nx = FACE_NORMALS[face][0];
      nz = FACE_NORMALS[face][2];
    }

    // Left the world vertically with no way back in: nothing further can be hit.
    if (y < 0 && dy <= 0) return null;
    if (y >= WORLD_HEIGHT && dy >= 0) return null;

    const id = getBlock(q, y, r);
    if (isHit(id)) {
      return { q, y, r, face, nx, ny, nz, distance: tBest, blockId: id };
    }
  }
  return null;
}
