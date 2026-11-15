// Caelancraft — the brick lattice laid over the honeycomb (CONTRACTS §93). PURE.
//
// Building materials sit on a second lattice of BRICKS: boxes 1 wide (X), BRICK_DEPTH = HEX_SIZE = 1/√3 deep (Z, half a
// hex's point-to-point height) and 1 tall, so their walls are straight along X and Z and meet at right angles. Brick
// (i, y, n) occupies x ∈ [i, i+1), z ∈ [n·s, (n+1)·s), y ∈ [y, y+1) with s = BRICK_DEPTH; the height layers are the hex
// layers. The lattice is fixed to the hexes ("the shifted layout"): the horizontal seams z = n·s pass through every even
// hex row's top point, centre and bottom point and along every odd row's vertical faces; the vertical seams x = i pass
// through the even rows' centres and along the odd rows' vertical faces. It repeats every 3 brick rows = 2 hex rows.
//
// Each brick covers exactly one PIECE of each hex it touches (verified against polygon clipping in bricks.test.js):
//   - an even-row hex (r even) splits into four quarters by its two midlines: NW, NE, SW, SE (bits 1, 2, 4, 8);
//   - an odd-row hex splits into its top point, its middle (the 1 × s box between its vertical faces) and its bottom
//     point (bits 1, 2, 4).
// With m = ⌊n / 3⌋ and t = n − 3m, brick (i, n) covers:
//   t = 0: the SE quarter of (i−m, 2m), the SW quarter of (i+1−m, 2m) and the top point of (i−m, 2m+1);
//   t = 1: the middle of (i−m, 2m+1) — this brick lies inside that one hex;
//   t = 2: the NE quarter of (i−m−1, 2m+2), the NW quarter of (i−m, 2m+2) and the bottom point of (i−m, 2m+1).
import { CHUNK_SIZE, WORLD_HEIGHT } from './config.js';
import { HEX_SIZE, SHADE_KEY_ANGLE } from './hex.js';
import { BLOCK } from './blocks.js';

/** @typedef {import('./types.js').BlockId} BlockId */

/** Depth (Z) of a brick: half a hex's point-to-point height, 1/√3 ≈ 0.577. */
export const BRICK_DEPTH = HEX_SIZE;
/** Brick chunk extent in i (X). */
export const BRICK_CHUNK_I = 16;
/** Brick chunk extent in n (Z rows): 24 rows = 13.86 units = exactly 16 hex rows, so brick chunks keep the row phase. */
export const BRICK_CHUNK_N = 24;
/** Cells per brick chunk. */
export const BRICK_CHUNK_VOLUME = BRICK_CHUNK_I * BRICK_CHUNK_N * WORLD_HEIGHT;

/** Piece bits of an even-row hex (its quarters). */
export const PIECE_NW = 1;
export const PIECE_NE = 2;
export const PIECE_SW = 4;
export const PIECE_SE = 8;
/** Piece bits of an odd-row hex. */
export const PIECE_TOP = 1;
export const PIECE_MID = 2;
export const PIECE_BOT = 4;

/** @returns {boolean} hex row r is an even row (four quarters); negatives too */
export function isEvenRow(r) {
  return (r & 1) === 0;
}

/** @returns {number} the mask of all pieces of a hex in row r: 15 (even) or 7 (odd) */
export function fullPieceMask(r) {
  return isEvenRow(r) ? 15 : 7;
}

/**
 * The piece(s) of a hex in row `r` that hold side face `j` (0 E … 5 NE, hex.js order): an E or W face of an even-row hex is
 * split by the centreline between two quarters; every other face lies in one piece.
 * @returns {number} piece bits
 */
export function facePieces(r, j) {
  if (isEvenRow(r)) return EVEN_FACE_PIECES[j];
  return ODD_FACE_PIECES[j];
}
const EVEN_FACE_PIECES = Object.freeze([PIECE_NE | PIECE_SE, PIECE_SE, PIECE_SW, PIECE_NW | PIECE_SW, PIECE_NW, PIECE_NE]);
const ODD_FACE_PIECES = Object.freeze([PIECE_MID, PIECE_BOT, PIECE_BOT, PIECE_MID, PIECE_TOP, PIECE_TOP]);

// ---- §93.9 water in brickwork -----------------------------------------------------------------------------------------

/**
 * @param {number} cover  the pieces of hex row `r` under a brick (the low 4 bits of World.coverAt)
 * @param {number} r
 * @returns {boolean} the rest of the hex is ONE open space: not nothing, and not two pieces that touch at a point only (an
 *   even row's NW + SE or NE + SW quarters, an odd row's top and bottom points). Water may stand in it (BRICK_GAP).
 */
export function holdsWater(cover, r) {
  const open = fullPieceMask(r) & ~cover;
  if (open === 0) return false;
  if (isEvenRow(r)) return open !== (PIECE_NW | PIECE_SE) && open !== (PIECE_NE | PIECE_SW);
  return open !== (PIECE_TOP | PIECE_BOT);
}

/**
 * Water crosses side face `j` of hex A (row `rA`, cover `a`) into its neighbour B (row `rB`, cover `b`) when an open piece
 * meets the face on both sides. A brick that spans a face covers the pieces on both sides of it at once, so the two sides
 * agree everywhere but on an odd row's E and W faces, along which the seam between two middle bricks runs.
 * @returns {boolean}
 */
export function waterCrossesFace(a, rA, j, b, rB) {
  return (facePieces(rA, j) & ~a) !== 0 && (facePieces(rB, (j + 3) % 6) & ~b) !== 0;
}

/** @returns {boolean} water crosses between two layers of a hex column of row `r` (covers `a`, `b`): their open pieces overlap */
export function waterCrossesLayer(a, b, r) {
  return (fullPieceMask(r) & ~a & ~b) !== 0;
}

/** @returns {[number, number]} the brick column [i, n] containing world point (x, z) */
export function worldToBrick(x, z) {
  return [Math.floor(x), Math.floor(z / BRICK_DEPTH)];
}

/** @returns {[number, number]} the world [x, z] of brick (i, n)'s north-west corner (its minimum x and z) */
export function brickOrigin(i, n) {
  return [i, n * BRICK_DEPTH];
}

/** floor division that is right for negatives */
function fdiv(a, b) {
  return Math.floor(a / b);
}

/**
 * The hex pieces brick column (i, n) covers: 1 entry (a middle row brick) or 3. Each entry is [q, r, pieceBit].
 * @returns {Array<[number, number, number]>}
 */
export function hexesOfBrick(i, n) {
  const m = fdiv(n, 3);
  const t = n - 3 * m;
  if (t === 1) return [[i - m, 2 * m + 1, PIECE_MID]];
  if (t === 0) return [[i - m, 2 * m, PIECE_SE], [i + 1 - m, 2 * m, PIECE_SW], [i - m, 2 * m + 1, PIECE_TOP]];
  return [[i - m - 1, 2 * m + 2, PIECE_NE], [i - m, 2 * m + 2, PIECE_NW], [i - m, 2 * m + 1, PIECE_BOT]];
}

/**
 * The brick columns that cover the pieces of hex (q, r): 4 for an even row (one per quarter), 3 for an odd row. Each
 * entry is [i, n, pieceBit].
 * @returns {Array<[number, number, number]>}
 */
export function bricksOfHex(q, r) {
  if (isEvenRow(r)) {
    const m = r / 2;
    const c = q + m; // the column whose west seam runs through the hex centre
    return [[c - 1, 3 * m - 1, PIECE_NW], [c, 3 * m - 1, PIECE_NE], [c - 1, 3 * m, PIECE_SW], [c, 3 * m, PIECE_SE]];
  }
  const m = (r - 1) / 2;
  const c = q + m;
  return [[c, 3 * m, PIECE_TOP], [c, 3 * m + 1, PIECE_MID], [c, 3 * m + 2, PIECE_BOT]];
}

// ---------------------------------------------------------------------------------------------------
// Brick chunks and the grid

/** @returns {string} the brick chunk key `${ci},${cn}` */
export function brickChunkKey(ci, cn) {
  return `${ci},${cn}`;
}

/** @returns {number} index of local cell (li, y, ln) in a brick chunk: (li · 24 + ln) · 128 + y */
export function brickLocalIndex(li, y, ln) {
  return (li * BRICK_CHUNK_N + ln) * WORLD_HEIGHT + y;
}

/** @returns {[number, number, number]} [li, y, ln] of a brick chunk local index */
export function brickIndexToLocal(index) {
  const y = index % WORLD_HEIGHT;
  const col = (index - y) / WORLD_HEIGHT;
  const ln = col % BRICK_CHUNK_N;
  const li = (col - ln) / BRICK_CHUNK_N;
  return [li, y, ln];
}

/** Brick chunk keys must be exactly two optionally-negative decimal integers (coords.parseChunkKey's rule). */
const BRICK_KEY_RE = /^(-?\d+),(-?\d+)$/;

/** @returns {[number, number]} [ci, cn], or [NaN, NaN] for anything brickChunkKey could not have made */
export function parseBrickChunkKey(key) {
  const m = typeof key === 'string' ? BRICK_KEY_RE.exec(key) : null;
  if (m === null) return [NaN, NaN];
  return [Number(m[1]), Number(m[2])];
}

export class BrickChunk {
  /**
   * @param {number} ci
   * @param {number} cn
   */
  constructor(ci, cn) {
    this.ci = ci;
    this.cn = cn;
    this.key = brickChunkKey(ci, cn);
    /** material id per cell, 0 = no brick */
    this.blocks = new Uint8Array(BRICK_CHUNK_VOLUME);
    /** local indices of the occupied cells (iteration without scanning the array) */
    this.cells = new Set();
    /** needs (re)meshing */
    this.dirty = true;
    /** a mesh of it is installed */
    this.meshed = false;
  }

  /** @returns {number} bricks in this chunk */
  get count() {
    return this.cells.size;
  }
}

/**
 * Every brick of a world, by brick chunk. Bricks are never generated: a chunk exists only while it holds a brick, so the
 * grid's whole state is the player's building. `getBlock` never allocates.
 */
export class BrickGrid {
  constructor() {
    /** @type {Map<string, BrickChunk>} */
    this.chunks = new Map();
    /** incremented on every change (autosave, tests) */
    this.version = 0;
    /** @type {BrickChunk|null} */
    this._last = null;
    this._lastCi = NaN;
    this._lastCn = NaN;
    /**
     * Brick (i, y, n) at its material id; AIR when there is none or y is out of range. ARROW PROPERTY.
     * @type {(i: number, y: number, n: number) => BlockId}
     */
    this.getBlock = (i, y, n) => {
      if (!(y >= 0 && y < WORLD_HEIGHT)) return BLOCK.AIR;
      const ci = Math.floor(i / BRICK_CHUNK_I);
      const cn = Math.floor(n / BRICK_CHUNK_N);
      let chunk;
      if (ci === this._lastCi && cn === this._lastCn) chunk = this._last;
      else {
        chunk = this.chunks.get(brickChunkKey(ci, cn)) ?? null;
        this._last = chunk;
        this._lastCi = ci;
        this._lastCn = cn;
      }
      if (chunk === null) return BLOCK.AIR;
      return chunk.blocks[brickLocalIndex(i - ci * BRICK_CHUNK_I, y, n - cn * BRICK_CHUNK_N)];
    };
  }

  /** @returns {number} bricks in the world */
  get count() {
    let n = 0;
    for (const c of this.chunks.values()) n += c.cells.size;
    return n;
  }

  /** @returns {BrickChunk|undefined} */
  getChunk(ci, cn) {
    return this.chunks.get(brickChunkKey(ci, cn));
  }

  /**
   * Put material `id` (0 = remove) at brick (i, y, n). The caller checks occupancy (§93.5); this only stores.
   * @returns {boolean} false when y is out of range, id is not an integer 0..254, or nothing changed
   */
  setBlock(i, y, n, id) {
    if (!Number.isInteger(i) || !Number.isInteger(n) || !Number.isInteger(y)) return false;
    if (!(y >= 0 && y < WORLD_HEIGHT)) return false;
    if (!Number.isInteger(id) || id < 0 || id > 254) return false;
    const ci = Math.floor(i / BRICK_CHUNK_I);
    const cn = Math.floor(n / BRICK_CHUNK_N);
    const key = brickChunkKey(ci, cn);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      if (id === BLOCK.AIR) return false;
      chunk = new BrickChunk(ci, cn);
      this.chunks.set(key, chunk);
      if (ci === this._lastCi && cn === this._lastCn) this._last = chunk;
    }
    const li = brickLocalIndex(i - ci * BRICK_CHUNK_I, y, n - cn * BRICK_CHUNK_N);
    if (chunk.blocks[li] === id) return false;
    chunk.blocks[li] = id;
    if (id === BLOCK.AIR) chunk.cells.delete(li);
    else chunk.cells.add(li);
    chunk.dirty = true;
    this.version++;
    this._markNeighboursDirty(i, y, n);
    return true;
  }

  /** A brick on a chunk's edge changes its neighbour chunk's culled faces and shading too. */
  _markNeighboursDirty(i, y, n) {
    for (const [di, dn] of NEIGHBOUR_COLUMNS) {
      const ni = i + di;
      const nn = n + dn;
      const c = this.chunks.get(brickChunkKey(Math.floor(ni / BRICK_CHUNK_I), Math.floor(nn / BRICK_CHUNK_N)));
      if (c !== undefined) c.dirty = true;
    }
  }

  /** Drop chunks that hold no brick (their mesh, if any, must be removed by the caller first). @returns {string[]} dropped keys */
  pruneEmpty() {
    const dropped = [];
    for (const [key, c] of this.chunks) {
      if (c.cells.size === 0) {
        this.chunks.delete(key);
        dropped.push(key);
      }
    }
    if (dropped.length > 0) {
      this._last = null;
      this._lastCi = NaN;
      this._lastCn = NaN;
    }
    return dropped;
  }

  /**
   * Every brick as [i, y, n, id], chunks in key order, cells in index order (tests, debugging).
   * @returns {Array<[number, number, number, number]>}
   */
  list() {
    /** @type {Array<[number, number, number, number]>} */
    const out = [];
    for (const key of [...this.chunks.keys()].sort(compareKeys)) {
      const c = /** @type {BrickChunk} */ (this.chunks.get(key));
      for (const li of [...c.cells].sort((a, b) => a - b)) {
        const [l, y, ln] = brickIndexToLocal(li);
        out.push([c.ci * BRICK_CHUNK_I + l, y, c.cn * BRICK_CHUNK_N + ln, c.blocks[li]]);
      }
    }
    return out;
  }

  /**
   * The save form: `{ "ci,cn": [localIndex, id, localIndex, id, …] }`, keys sorted, pairs by index; empty chunks left out.
   * @returns {Record<string, number[]>}
   */
  export() {
    /** @type {Record<string, number[]>} */
    const out = {};
    const keys = [...this.chunks.keys()].sort(compareKeys);
    for (const key of keys) {
      const c = /** @type {BrickChunk} */ (this.chunks.get(key));
      if (c.cells.size === 0) continue;
      const arr = [];
      for (const li of [...c.cells].sort((a, b) => a - b)) arr.push(li, c.blocks[li]);
      out[key] = arr;
    }
    return out;
  }

  /**
   * Replace every brick with a saved set (validated with normalizeBricksJSON first). Nothing else (shadows, meshes) is
   * touched: the World re-derives its shadows from the grid.
   * @param {unknown} json
   * @returns {string[]} warnings
   */
  load(json) {
    const { bricks, warnings } = normalizeBricksJSON(json);
    this.chunks.clear();
    this._last = null;
    this._lastCi = NaN;
    this._lastCn = NaN;
    for (const [key, arr] of Object.entries(bricks)) {
      const [ci, cn] = parseBrickChunkKey(key);
      const chunk = new BrickChunk(ci, cn);
      for (let k = 0; k < arr.length; k += 2) {
        chunk.blocks[arr[k]] = arr[k + 1];
        chunk.cells.add(arr[k]);
      }
      this.chunks.set(key, chunk);
    }
    this.version++;
    return warnings;
  }
}

/** The eight neighbouring columns of a brick column. */
const NEIGHBOUR_COLUMNS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);

/** Chunk keys in numeric (ci, then cn) order. */
function compareKeys(a, b) {
  const [ai, an] = parseBrickChunkKey(a);
  const [bi, bn] = parseBrickChunkKey(b);
  return ai - bi || an - bn;
}

/**
 * Validate a saved bricks object: keys must be brick chunk keys, values even-length integer arrays of [localIndex, id]
 * with 0 ≤ localIndex < BRICK_CHUNK_VOLUME and 1 ≤ id ≤ 254 (AIR pairs are dropped silently; later pairs win). Anything
 * else is dropped with a warning. Never throws.
 * @param {unknown} raw
 * @returns {{ bricks: Record<string, number[]>, warnings: string[] }}
 */
export function normalizeBricksJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, number[]>} */
  const bricks = {};
  if (raw == null) return { bricks, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('bricks: not an object, ignored');
    return { bricks, warnings };
  }
  const keys = Object.keys(raw).sort(compareKeys);
  for (const key of keys) {
    const [ci, cn] = parseBrickChunkKey(key);
    if (!Number.isInteger(ci) || !Number.isInteger(cn)) {
      warnings.push(`bricks: bad chunk key ${JSON.stringify(key)}, dropped`);
      continue;
    }
    const arr = /** @type {Record<string, unknown>} */ (raw)[key];
    if (!Array.isArray(arr)) {
      warnings.push(`bricks: ${key} is not an array, dropped`);
      continue;
    }
    /** @type {Map<number, number>} */
    const cells = new Map();
    let bad = 0;
    for (let k = 0; k + 1 < arr.length; k += 2) {
      const li = arr[k];
      const id = arr[k + 1];
      if (!Number.isInteger(li) || li < 0 || li >= BRICK_CHUNK_VOLUME || !Number.isInteger(id) || id < 0 || id > 254) {
        bad++;
        continue;
      }
      if (id === 0) cells.delete(li);
      else cells.set(li, id);
    }
    if (arr.length % 2 === 1) bad++;
    if (bad > 0) warnings.push(`bricks: ${bad} bad pair(s) in ${key}, dropped`);
    if (cells.size === 0) continue;
    const out = [];
    for (const li of [...cells.keys()].sort((a, b) => a - b)) out.push(li, /** @type {number} */ (cells.get(li)));
    bricks[key] = out;
  }
  return { bricks, warnings };
}

// ---------------------------------------------------------------------------------------------------
// Hex chunks ↔ brick chunks

/**
 * The brick chunks whose bricks can touch hex chunk (cq, cr): rows n ∈ [24·cr − 1, 24·cr + 23], columns
 * i ∈ [16·cq + 8·cr − 1, 16·cq + 8·cr + 22].
 * @returns {Array<[number, number]>} [ci, cn] pairs
 */
export function brickChunksOfHexChunk(cq, cr) {
  const i0 = Math.floor((CHUNK_SIZE * cq + (CHUNK_SIZE / 2) * cr - 1) / BRICK_CHUNK_I);
  const i1 = Math.floor((CHUNK_SIZE * cq + (CHUNK_SIZE / 2) * cr + CHUNK_SIZE + CHUNK_SIZE / 2 - 2) / BRICK_CHUNK_I);
  const n0 = Math.floor(((3 * CHUNK_SIZE) / 2 * cr - 1) / BRICK_CHUNK_N);
  const n1 = Math.floor(((3 * CHUNK_SIZE) / 2 * cr + (3 * CHUNK_SIZE) / 2 - 1) / BRICK_CHUNK_N);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let ci = i0; ci <= i1; ci++) for (let cn = n0; cn <= n1; cn++) out.push([ci, cn]);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Faces, shading, the raycast and contact

/**
 * Box faces of a brick, index = brick face: 0 +X (east), 1 −X (west), 2 +Y (top), 3 −Y (bottom), 4 +Z (south), 5 −Z
 * (north) — the v0.1 cube order.
 */
export const BRICK_FACE_NORMALS = Object.freeze([
  Object.freeze([1, 0, 0]), Object.freeze([-1, 0, 0]), Object.freeze([0, 1, 0]),
  Object.freeze([0, -1, 0]), Object.freeze([0, 0, 1]), Object.freeze([0, 0, -1]),
]);
export const BRICK_FACE_TOP = 2;
export const BRICK_FACE_BOTTOM = 3;
/** Column / layer offset [di, dy, dn] across each brick face. */
export const BRICK_FACE_DIRS = Object.freeze([
  Object.freeze([1, 0, 0]), Object.freeze([-1, 0, 0]), Object.freeze([0, 1, 0]),
  Object.freeze([0, -1, 0]), Object.freeze([0, 0, 1]), Object.freeze([0, 0, -1]),
]);
export const BRICK_FACE_OPPOSITE = Object.freeze([1, 0, 3, 2, 5, 4]);

/**
 * Shade of each brick face, the hex faces' rule (hex.FACE_SHADE): sides 0.8 + 0.1·(n · key) with the key light at
 * SHADE_KEY_ANGLE, rounded to 3 dp; top 1.0, bottom 0.55. ±X equal the hex E / W shades.
 */
export const BRICK_FACE_SHADE = Object.freeze(BRICK_FACE_NORMALS.map((nrm, f) => {
  if (f === BRICK_FACE_TOP) return 1.0;
  if (f === BRICK_FACE_BOTTOM) return 0.55;
  return Math.round((0.8 + 0.1 * (nrm[0] * Math.cos(SHADE_KEY_ANGLE) + nrm[2] * Math.sin(SHADE_KEY_ANGLE))) * 1000) / 1000;
}));

/**
 * @typedef {Object} BrickHit
 * @property {'brick'} layer
 * @property {number} i
 * @property {number} y
 * @property {number} n
 * @property {number} face      brick face entered (0..5), −1 when the ray starts inside the brick
 * @property {number} nx        outward normal of that face
 * @property {number} ny
 * @property {number} nz
 * @property {number} distance  along the normalised ray
 * @property {number} px        the point where the ray enters the brick
 * @property {number} py
 * @property {number} pz
 * @property {BlockId} blockId
 */

/**
 * Amanatides–Woo through the brick lattice (cells 1 × 1 × s): the first brick whose id passes `isHit` (default: any brick)
 * within `maxDistance` (inclusive), or null. The direction is normalised; a zero or non-finite input returns null.
 * @param {(i: number, y: number, n: number) => BlockId} getBrick
 * @param {number} ox
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @param {number} maxDistance
 * @param {(id: BlockId) => boolean} [isHit]
 * @returns {BrickHit|null}
 */
export function raycastBricks(getBrick, ox, oy, oz, dx, dy, dz, maxDistance, isHit = (id) => id !== BLOCK.AIR) {
  if (!Number.isFinite(ox + oy + oz + dx + dy + dz) || !(maxDistance >= 0)) return null;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return null;
  dx /= len;
  dy /= len;
  dz /= len;
  const s = BRICK_DEPTH;
  let i = Math.floor(ox);
  let y = Math.floor(oy);
  let n = Math.floor(oz / s);
  const startId = y >= 0 && y < WORLD_HEIGHT ? getBrick(i, y, n) : BLOCK.AIR;
  if (startId !== BLOCK.AIR && isHit(startId)) {
    return { layer: 'brick', i, y, n, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, px: ox, py: oy, pz: oz, blockId: startId };
  }
  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepN = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaI = stepI !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? 1 / Math.abs(dy) : Infinity;
  const tDeltaN = stepN !== 0 ? s / Math.abs(dz) : Infinity;
  let tMaxI = stepI > 0 ? (i + 1 - ox) / dx : stepI < 0 ? (i - ox) / dx : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
  let tMaxN = stepN > 0 ? ((n + 1) * s - oz) / dz : stepN < 0 ? (n * s - oz) / dz : Infinity;
  const maxSteps = Math.min(1 << 16, Math.ceil(maxDistance * 4) + 8);
  for (let k = 0; k < maxSteps; k++) {
    let t;
    let face;
    if (tMaxI <= tMaxY && tMaxI <= tMaxN) {
      t = tMaxI;
      i += stepI;
      tMaxI += tDeltaI;
      face = stepI > 0 ? 1 : 0; // entered through its west (−X) face when moving +X
    } else if (tMaxY <= tMaxN) {
      t = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      face = stepY > 0 ? BRICK_FACE_BOTTOM : BRICK_FACE_TOP;
    } else {
      t = tMaxN;
      n += stepN;
      tMaxN += tDeltaN;
      face = stepN > 0 ? 5 : 4;
    }
    if (t > maxDistance) return null;
    if (y < 0 && stepY <= 0) return null;
    if (y >= WORLD_HEIGHT && stepY >= 0) return null;
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    const id = getBrick(i, y, n);
    if (id !== BLOCK.AIR && isHit(id)) {
      const nrm = BRICK_FACE_NORMALS[face];
      return {
        layer: 'brick', i, y, n, face, nx: nrm[0], ny: nrm[1], nz: nrm[2], distance: t,
        px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t, blockId: id,
      };
    }
  }
  return null;
}

/**
 * Circle (centre (px, pz), radius) against brick column (i, n)'s rectangle. Strict overlap like hex.hexCircleContact:
 * on overlap `out.depth` > 0 and the unit push direction (rectangle → circle) are written.
 * @param {number} i
 * @param {number} n
 * @param {number} px
 * @param {number} pz
 * @param {number} radius
 * @param {{ depth: number, nx: number, nz: number }} out
 * @returns {boolean}
 */
export function brickCircleContact(i, n, px, pz, radius, out) {
  const x0 = i;
  const x1 = i + 1;
  const z0 = n * BRICK_DEPTH;
  const z1 = z0 + BRICK_DEPTH;
  if (px > x0 && px < x1 && pz > z0 && pz < z1) {
    // Centre inside: push out through the nearest side.
    const dl = px - x0;
    const dr = x1 - px;
    const dn = pz - z0;
    const ds = z1 - pz;
    const m = Math.min(dl, dr, dn, ds);
    out.depth = radius + m;
    out.nx = m === dl ? -1 : m === dr ? 1 : 0;
    out.nz = m === dl || m === dr ? 0 : m === dn ? -1 : 1;
    return true;
  }
  const cx = px < x0 ? x0 : px > x1 ? x1 : px;
  const cz = pz < z0 ? z0 : pz > z1 ? z1 : pz;
  const ddx = px - cx;
  const ddz = pz - cz;
  const dist = Math.sqrt(ddx * ddx + ddz * ddz);
  const depth = radius - dist;
  if (depth <= 0) return false;
  if (dist > 1e-9) {
    out.nx = ddx / dist;
    out.nz = ddz / dist;
  } else {
    out.nx = 0;
    out.nz = 0;
  }
  out.depth = depth;
  return true;
}

/**
 * Whether a vertical cylinder (feet (px, py, pz), radius, height) overlaps brick (i, y, n). Touching does not count.
 * @returns {boolean}
 */
export function cylinderIntersectsBrick(px, py, pz, radius, height, i, y, n) {
  if (!(py < y + 1 && py + height > y)) return false;
  return brickCircleContact(i, n, px, pz, radius, SCRATCH_CONTACT);
}
const SCRATCH_CONTACT = { depth: 0, nx: 0, nz: 0 };
