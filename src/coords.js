// Caelancraft — coordinate helpers, face tables and orientation conventions.
// See src/CONTRACTS.md §0 and §4. Everything here is pure.
import { CHUNK_SIZE, WORLD_HEIGHT } from './config.js';

/** @returns {number} Math.floor(a / n) */
export function floorDiv(a, n) {
  return Math.floor(a / n);
}

/** @returns {number} ((a % n) + n) % n, always in [0, n) */
export function mod(a, n) {
  return ((a % n) + n) % n;
}

/** World block coordinate → chunk coordinate. */
export function worldToChunk(w) {
  return Math.floor(w / CHUNK_SIZE);
}

/** World block coordinate → local coordinate 0..15. */
export function worldToLocal(w) {
  return w - Math.floor(w / CHUNK_SIZE) * CHUNK_SIZE;
}

/** @returns {string} `${cx},${cz}` */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

/** @returns {[number, number]} [cx, cz] */
export function parseChunkKey(key) {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** (lx * 16 + lz) * 128 + ly — Y innermost so a column is contiguous. Inputs must be in range. */
export function localIndex(lx, ly, lz) {
  return (lx * CHUNK_SIZE + lz) * WORLD_HEIGHT + ly;
}

/** Inverse of localIndex. @returns {[number, number, number]} [lx, ly, lz] */
export function indexToLocal(index) {
  const ly = index % WORLD_HEIGHT;
  const col = (index - ly) / WORLD_HEIGHT;
  const lz = col % CHUNK_SIZE;
  const lx = (col - lz) / CHUNK_SIZE;
  return [lx, ly, lz];
}

/** Index into per-column arrays (biomes, heights). */
export function columnIndex(lx, lz) {
  return lx * CHUNK_SIZE + lz;
}

/** @returns {boolean} 0 <= y < WORLD_HEIGHT */
export function inHeightRange(y) {
  return y >= 0 && y < WORLD_HEIGHT;
}

export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

/** @type {number[][]} unit normal of each face */
export const FACE_NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export const FACE_OPPOSITE = [1, 0, 3, 2, 5, 4];

/** axis index (0 = x, 1 = y, 2 = z) of each face normal */
export const FACE_AXIS = [0, 0, 1, 1, 2, 2];

/** the two non-normal axes of each face, ascending */
export const FACE_TANGENTS = [
  [1, 2],
  [1, 2],
  [0, 2],
  [0, 2],
  [0, 1],
  [0, 1],
];

/** Human-readable face names, index = FaceIndex. */
export const FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

/**
 * Unit-cube corners of each face, CCW when viewed from OUTSIDE (Three.js FrontSide).
 * Order: bottom-left, bottom-right, top-right, top-left as seen from outside, where
 * "up" = +Y for side faces and -Z (north) for the +Y / -Y faces.
 * Windings verified by cross product: (v1 - v0) × (v2 - v0) equals the face normal.
 * @type {number[][][]}  [face][vertex][xyz], each component 0 or 1
 */
export const FACE_VERTS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], // +X
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // -X
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], // +Y
  [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], // -Y
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // +Z
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], // -Z
];

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
