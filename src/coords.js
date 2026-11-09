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

/**
 * Call fn(q, y, r) for every recorded edit (World.edits: chunk key → Map(localIndex → id)) whose id is `id`.
 * Malformed chunk keys are skipped. Blocks worldgen never emits (black holes, campfires) are found this way on load.
 * @param {Map<string, Map<number, number>>} edits
 * @param {number} id
 * @param {(q: number, y: number, r: number) => void} fn
 */
export function forEachEditedCell(edits, id, fn) {
  for (const [key, chunkEdits] of edits) {
    const [cq, cr] = parseChunkKey(key);
    if (!Number.isInteger(cq) || !Number.isInteger(cr)) continue;
    for (const [li, v] of chunkEdits) {
      if (v !== id) continue;
      const [lq, ly, lr] = indexToLocal(li);
      fn(cq * CHUNK_SIZE + lq, ly, cr * CHUNK_SIZE + lr);
    }
  }
}

// Packed cell keys (block physics, CONTRACTS §33): q and r offset by 2^20 into 21 bits each, y in 7 bits, as ONE double
// (exact: the largest key is below 2^49), like world.js packs chunk ids. Cells beyond ±2^20 are far outside playability.
const CELL_OFFSET = 1 << 20;
const CELL_SPAN = 1 << 21;

/** @returns {number} unique non-negative integer key of cell (q, y, r); y must be 0..WORLD_HEIGHT−1 */
export function packCell(q, y, r) {
  return ((q + CELL_OFFSET) * CELL_SPAN + (r + CELL_OFFSET)) * WORLD_HEIGHT + y;
}

/**
 * Inverse of packCell. Writes [q, y, r] into `out` (default: a fresh array).
 * @param {number} key
 * @param {number[]} [out]
 * @returns {number[]} out
 */
export function unpackCell(key, out = [0, 0, 0]) {
  const y = key % WORLD_HEIGHT;
  const col = (key - y) / WORLD_HEIGHT;
  const r = col % CELL_SPAN;
  out[0] = (col - r) / CELL_SPAN - CELL_OFFSET;
  out[1] = y;
  out[2] = r - CELL_OFFSET;
  return out;
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
