// Caelancraft — chunk indexing and orientation conventions. See src/CONTRACTS.md §0 and §4. Pure.
//
// Cells are hexagonal prisms addressed by axial (q, r) plus integer y (geometry in src/hex.js). Chunks are
// 16×16 parallelograms in (q, r) index space; the helpers below convert between cell, chunk and local
// coordinates exactly like a square grid would, because the index space IS a square grid.
import { CHUNK_SIZE, WORLD_HEIGHT } from './config.js';

/** @returns {number} Math.floor(a / n) */
export function floorDiv(a, n) {
  return Math.floor(a / n);
}

/** @returns {number} ((a % n) + n) % n, always in [0, n) */
export function mod(a, n) {
  return ((a % n) + n) % n;
}

/** Cell coordinate (q or r) → chunk coordinate. */
export function worldToChunk(w) {
  return Math.floor(w / CHUNK_SIZE);
}

/** Cell coordinate (q or r) → local coordinate 0..15. */
export function worldToLocal(w) {
  return w - Math.floor(w / CHUNK_SIZE) * CHUNK_SIZE;
}

/** @returns {string} `${cq},${cr}` */
export function chunkKey(cq, cr) {
  return `${cq},${cr}`;
}

/** Exactly what chunkKey produces: two optionally-negative decimal integers joined by a comma. */
const CHUNK_KEY_RE = /^(-?\d+),(-?\d+)$/;

/**
 * Inverse of chunkKey. Anything chunkKey could not have produced — no comma, an empty half (',' or '3,'),
 * whitespace, a '+' sign, exponent/hex forms, extra fields — yields [NaN, NaN] so callers that check
 * Number.isInteger skip it instead of silently reading it as chunk (0, 0).
 * @returns {[number, number]} [cq, cr]
 */
export function parseChunkKey(key) {
  const m = CHUNK_KEY_RE.exec(key);
  if (m === null) return [NaN, NaN];
  return [Number(m[1]), Number(m[2])];
}

/** (lq * 16 + lr) * 128 + ly — Y innermost so a column is contiguous. Inputs must be in range. */
export function localIndex(lq, ly, lr) {
  return (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + ly;
}

/** Inverse of localIndex. @returns {[number, number, number]} [lq, ly, lr] */
export function indexToLocal(index) {
  const ly = index % WORLD_HEIGHT;
  const col = (index - ly) / WORLD_HEIGHT;
  const lr = col % CHUNK_SIZE;
  const lq = (col - lr) / CHUNK_SIZE;
  return [lq, ly, lr];
}

/** Index into per-column arrays (biomes, heights). */
export function columnIndex(lq, lr) {
  return lq * CHUNK_SIZE + lr;
}

/** @returns {boolean} 0 <= y < WORLD_HEIGHT */
export function inHeightRange(y) {
  return y >= 0 && y < WORLD_HEIGHT;
}

/**
 * yaw = 0 faces -Z; positive yaw turns left (counter-clockwise seen from +Y).
 * @returns {[number, number]} [fx, fz] horizontal forward unit vector
 */
export function yawToForward(yaw) {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** @returns {[number, number]} [rx, rz] horizontal right unit vector */
export function yawToRight(yaw) {
  return [Math.cos(yaw), -Math.sin(yaw)];
}

/** @returns {[number, number, number]} unit look direction */
export function lookDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
