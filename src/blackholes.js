// Caelancraft — Black Holes: placed cells that pull the player in and swallow the cells around them.
// See src/CONTRACTS.md §29. Pure: the world is reached only through the callbacks passed to update().
//
// Holes are tracked by cell key. Worldgen never emits BLACK_HOLE, so every hole in a world is a recorded edit:
// main seeds the tracker from World.edits on load (loadFromEdits) and keeps it in step through World.onBlockChange.
// Holes past BLACK_HOLE_MAX_TRACKED are remembered as inert and woken, oldest first, when tracked ones go.
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, BLACK_HOLE_MAX_TRACKED, BLACK_HOLE_RESPAWN_RINGS,
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, PLAYER_HEIGHT,
} from './config.js';
import { BLOCK, isLiquid, isSolid } from './blocks.js';
import { chunkKey, forEachEditedCell, localIndex } from './coords.js';
import { HEX_DIRS, hexToWorld, hexDistance, worldToHex } from './hex.js';
import { playerIntersectsBlock } from './physics.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * @typedef {Object} BlackHole
 * @property {string} key  "q,y,r"
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} cx   world centre x
 * @property {number} cy   world centre y (y + 0.5)
 * @property {number} cz   world centre z
 * @property {boolean} due  owes one eat in the current round (every hole gets one per BLACK_HOLE_EAT_INTERVAL_S)
 * @property {number} offset index into EAT_OFFSETS where the nearest-first search resumes
 */

/**
 * @typedef {Object} BlackHoleWorld
 * @property {GetBlockFn} getBlock
 * @property {(q: number, y: number, r: number, id: number) => boolean} setBlock
 * @property {(q: number, r: number) => boolean} isLoaded   true when the column's chunk is loaded
 */

/**
 * @typedef {Object} RespawnWorld  what respawnPoint reads
 * @property {GetBlockFn} getBlock                               live blocks (edits included) of loaded chunks
 * @property {(q: number, r: number) => boolean} isLoaded       true when the column's chunk is loaded
 * @property {(q: number, r: number) => number} surfaceHeight   worldgen terrain height (World.getSurfaceHeight)
 * @property {(q: number, r: number) => boolean} hasEdits       true when World.edits records a cell of the column (columnHasEdits)
 */

/** "q,y,r" — same shape as rune keys. */
export function holeKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Cells a black hole may swallow: anything except air, liquids (no draining oceans), bedrock (the world floor),
 * Rune Blocks (they carry scripts) and other black holes.
 * @param {number} id
 */
export function canSwallow(id) {
  return id !== BLOCK.AIR && id !== BLOCK.BEDROCK && id !== BLOCK.RUNE_BLOCK && id !== BLOCK.BLACK_HOLE && !isLiquid(id);
}

/**
 * Relative cells (dq, dy, dr) whose centre lies within BLACK_HOLE_EAT_RADIUS of the hole's centre, excluding the
 * hole itself, sorted nearest-first (ties: dy, then dq, then dr) so each hole carves a growing ball.
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const EAT_OFFSETS = (() => {
  const R = BLACK_HOLE_EAT_RADIUS;
  const [ox, oz] = hexToWorld(0, 0);
  /** @type {[number, number, number, number][]} */
  const list = [];
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = -R; dr <= R; dr++) {
      if (hexDistance(0, 0, dq, dr) > R) continue;
      const [x, z] = hexToWorld(dq, dr);
      for (let dy = -R; dy <= R; dy++) {
        if (dq === 0 && dr === 0 && dy === 0) continue;
        const d = Math.hypot(x - ox, dy, z - oz);
        if (d <= R) list.push([d, dq, dy, dr]);
      }
    }
  }
  list.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1] || a[3] - b[3]);
  return Object.freeze(list.map(([, dq, dy, dr]) => Object.freeze([dq, dy, dr])));
})();

/**
 * Column offsets of the hex rings 0..BLACK_HOLE_RESPAWN_RINGS, ring by ring (ring n starts at n × HEX_DIRS[4] and
 * walks n steps along each of the six directions, like World.findSpawn's spiral), flattened as dq, dr pairs.
 */
const RESPAWN_OFFSETS = (() => {
  const out = [0, 0];
  for (let n = 1; n <= BLACK_HOLE_RESPAWN_RINGS; n++) {
    let dq = HEX_DIRS[4][0] * n;
    let dr = HEX_DIRS[4][1] * n;
    for (let side = 0; side < 6; side++) {
      for (let j = 0; j < n; j++) {
        out.push(dq, dr);
        dq += HEX_DIRS[side][0];
        dr += HEX_DIRS[side][1];
      }
    }
  }
  return Int16Array.from(out);
})();

/**
 * @param {Map<string, Map<number, number>>} edits World.edits (chunk key → Map(localIndex → id))
 * @returns {boolean} true when any cell of column (q, r) is a recorded edit
 */
export function columnHasEdits(edits, q, r) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const m = edits.get(chunkKey(cq, cr));
  if (m === undefined || m.size === 0) return false;
  const base = localIndex(q - cq * CHUNK_SIZE, 0, r - cr * CHUNK_SIZE); // a column's cells are contiguous, y innermost
  for (let y = 0; y < WORLD_HEIGHT; y++) if (m.has(base + y)) return true;
  return false;
}

/**
 * Feet height of the highest place to stand in loaded column (q, r): one above its topmost solid cell, with AIR in the
 * two cells the body takes (water, a campfire or a black hole there → null) under the world's ceiling.
 * @param {GetBlockFn} getBlock
 * @returns {number|null}
 */
function standingTop(getBlock, q, r) {
  for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
    if (!isSolid(getBlock(q, y, r))) continue; // air, or water / a hole / a campfire hanging above the ground
    const feet = y + 1;
    if (feet + PLAYER_HEIGHT > WORLD_HEIGHT) return null;
    return getBlock(q, feet, r) === BLOCK.AIR && getBlock(q, feet + 1, r) === BLOCK.AIR ? feet : null;
  }
  return null;
}

/** Packed id of chunk (cq, cr), the same scheme as World's lookup index. */
function chunkId(cq, cr) {
  return (cq + (1 << 20)) * (1 << 21) + (cr + (1 << 20));
}

/**
 * Add to `set` the chunks an eat at column (q, r) dirties: World.setBlock marks the cell's chunk and the chunks of its
 * six side neighbours (they differ only at a chunk border).
 * @param {number[]} set distinct chunk ids (a few entries)
 * @returns {number[]} set
 */
function addEatChunks(set, q, r) {
  for (let i = -1; i < 6; i++) {
    const nq = i < 0 ? q : q + HEX_DIRS[i][0];
    const nr = i < 0 ? r : r + HEX_DIRS[i][1];
    const id = chunkId(Math.floor(nq / CHUNK_SIZE), Math.floor(nr / CHUNK_SIZE));
    if (!set.includes(id)) set.push(id);
  }
  return set;
}

export class BlackHoles {
  constructor() {
    /** @type {Map<string, BlackHole>} */
    this.holes = new Map();
    /** @type {Map<string, [number, number, number]>} BLACK_HOLE cells refused at the cap (inert), oldest first */
    this._inert = new Map();
    /** round-robin start so a crowd of holes shares the per-frame limits fairly */
    this._cursor = 0;
    /** seconds until the next eating round (one shared clock keeps holes in step, so a chunk is re-meshed once a round) */
    this._clock = BLACK_HOLE_EAT_INTERVAL_S;
    /** @type {number[]} scratch: chunk ids dirtied by the current update's eats */
    this._eatChunks = [];
    /** @type {number[]} scratch: the same plus one candidate eat's chunks */
    this._tryChunks = [];
  }

  get size() {
    return this.holes.size;
  }

  /** BLACK_HOLE cells left untracked because the cap was full: they do nothing until remove() wakes them. */
  get inert() {
    return this._inert.size;
  }

  clear() {
    this.holes.clear();
    this._inert.clear();
    this._cursor = 0;
    this._clock = BLACK_HOLE_EAT_INTERVAL_S;
  }

  /**
   * Track a hole at (q, y, r). Past BLACK_HOLE_MAX_TRACKED the cell is remembered as inert instead, and remove()
   * wakes it once a tracked hole goes.
   * @returns {boolean} false when already tracked or at BLACK_HOLE_MAX_TRACKED
   */
  add(q, y, r) {
    const key = holeKey(q, y, r);
    if (this.holes.has(key)) return false;
    if (this.holes.size >= BLACK_HOLE_MAX_TRACKED) {
      if (!this._inert.has(key)) this._inert.set(key, [q, y, r]);
      return false;
    }
    this._inert.delete(key);
    if (this.holes.size === 0) this._clock = BLACK_HOLE_EAT_INTERVAL_S; // a lone new hole first eats one interval after it appears
    const [cx, cz] = hexToWorld(q, r);
    this.holes.set(key, { key, q, y, r, cx, cy: y + 0.5, cz, due: false, offset: 0 });
    return true;
  }

  /**
   * Forget the hole at (q, y, r), tracked or inert. A freed tracked slot goes to the oldest inert hole.
   * @returns {boolean} true when a tracked hole was removed
   */
  remove(q, y, r) {
    const key = holeKey(q, y, r);
    this._inert.delete(key);
    if (!this.holes.delete(key)) return false;
    for (const [k, [iq, iy, ir]] of this._inert) {
      if (this.holes.size >= BLACK_HOLE_MAX_TRACKED) break;
      this._inert.delete(k); // deleting the entry being visited is safe during Map iteration
      this.add(iq, iy, ir);
    }
    return true;
  }

  /** World.onBlockChange hook. */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.BLACK_HOLE && prev !== BLOCK.BLACK_HOLE) this.add(q, y, r);
    else if (prev === BLOCK.BLACK_HOLE && next !== BLOCK.BLACK_HOLE) this.remove(q, y, r);
    else if (canSwallow(next) && this.holes.size > 0) this._reopen(q, y, r); // new food: holes nearby look again
  }

  /**
   * Replace the tracked set with every BLACK_HOLE cell recorded in `edits` (World.edits: chunk key → Map(localIndex → id)).
   * @param {Map<string, Map<number, number>>} edits
   */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.BLACK_HOLE, (q, y, r) => this.add(q, y, r));
  }

  /**
   * Sum of the pulls on a point, in m/s²: each hole within BLACK_HOLE_PULL_RADIUS pulls toward its centre with
   * BLACK_HOLE_PULL_STRENGTH · (1 − d/R)².
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {[number, number, number]} [out]
   * @returns {[number, number, number]}
   */
  pullAt(x, y, z, out = [0, 0, 0]) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const R = BLACK_HOLE_PULL_RADIUS;
    for (const h of this.holes.values()) {
      const dx = h.cx - x;
      const dy = h.cy - y;
      const dz = h.cz - z;
      const d = Math.hypot(dx, dy, dz);
      if (!(d < R) || d < 1e-6) continue;
      const f = 1 - d / R;
      const a = (BLACK_HOLE_PULL_STRENGTH * f * f) / d;
      out[0] += dx * a;
      out[1] += dy * a;
      out[2] += dz * a;
    }
    return out;
  }

  /**
   * @param {PlayerState} p
   * @returns {BlackHole|null} a hole whose cell the player's body overlaps (the player has been swallowed)
   */
  swallowing(p) {
    for (const h of this.holes.values()) {
      if (playerIntersectsBlock(p, h.q, h.y, h.r)) return h;
    }
    return null;
  }

  /**
   * Distance from (x, y, z) to the nearest tracked hole centre (Infinity without holes). Returns early, with that
   * smaller distance, as soon as a hole closer than `stopBelow` turns up.
   */
  nearestDistance(x, y, z, stopBelow = 0) {
    const stopSq = stopBelow > 0 ? stopBelow * stopBelow : 0;
    let best = Infinity;
    for (const h of this.holes.values()) {
      const dx = h.cx - x;
      const dy = h.cy - y;
      const dz = h.cz - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        if (d2 < stopSq) break;
      }
    }
    return Math.sqrt(best);
  }

  /**
   * Where a swallowed player comes back. Columns are tried over the hex rings 0..BLACK_HOLE_RESPAWN_RINGS around the
   * world spawn's column, nearest ring first, and the first place to stand whose body middle (feet + PLAYER_HEIGHT / 2)
   * is at least BLACK_HOLE_PULL_RADIUS from every tracked hole wins. There the pull is zero and no eat ball reaches the
   * floor, so no hole can reach a player standing there. A loaded column is read live, so edits count (ground a hole
   * ate, a house built over spawn): the feet go on its topmost solid cell, with AIR for the body. An unloaded column is judged
   * from worldgen (dry land: surface height ≥ SEA_LEVEL, feet at height + 1) and skipped when it has recorded edits.
   * If nothing is out of reach, the candidate farthest from every hole wins; with no candidate at all, `spawn`.
   * @param {[number, number, number]} spawn World.findSpawn() (world feet position)
   * @param {RespawnWorld} world
   * @returns {[number, number, number]} world feet position
   */
  respawnPoint(spawn, world) {
    const [q0, r0] = worldToHex(spawn[0], spawn[2]);
    /** @type {[number, number, number]|null} */
    let best = null;
    let bestD = -1;
    for (let i = 0; i < RESPAWN_OFFSETS.length; i += 2) {
      const q = q0 + RESPAWN_OFFSETS[i];
      const r = r0 + RESPAWN_OFFSETS[i + 1];
      let y = null;
      if (world.isLoaded(q, r)) {
        y = standingTop(world.getBlock, q, r);
      } else if (!world.hasEdits(q, r)) {
        const h = world.surfaceHeight(q, r);
        if (h >= SEA_LEVEL && h + 1 + PLAYER_HEIGHT <= WORLD_HEIGHT) y = h + 1;
      }
      if (y === null) continue;
      const [x, z] = hexToWorld(q, r);
      const d = this.nearestDistance(x, y + PLAYER_HEIGHT / 2, z, bestD);
      if (d >= BLACK_HOLE_PULL_RADIUS) return [x, y, z];
      if (d > bestD) {
        bestD = d;
        best = [x, y, z];
      }
    }
    return best ?? spawn;
  }

  /**
   * Eat in rounds. A shared clock starts a round every BLACK_HOLE_EAT_INTERVAL_S (one per call at most, however long
   * the frame), and each hole then owes one eat (`due`; owed eats never pile up). A due hole swallows its nearest
   * swallowable cell, at most BLACK_HOLE_MAX_EATS_PER_FRAME across all holes, and only while this call's eats dirty no
   * more than max(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, chunks already dirtied by this call) distinct chunks: World.update
   * re-meshes each of them at once, and the first eat always goes. Because the holes stay in step, a chunk full of
   * holes is re-meshed once a round rather than every frame. A hole held back by a limit stays due, and the first one
   * held back starts the next call, so crowds in different chunks take turns. A due hole in an unloaded column, or
   * whose search is exhausted, is skipped and stays due: frozen until its chunk loads or a cell inside its ball
   * changes (onBlockChange reopens the search). A search that finds nothing spends the hole's eat for the round.
   * @param {number} dt
   * @param {BlackHoleWorld} world
   * @returns {{q:number, y:number, r:number, id:number}[]} the cells swallowed this call (old ids)
   */
  update(dt, world) {
    /** @type {{q:number, y:number, r:number, id:number}[]} */
    const eaten = [];
    const n = this.holes.size;
    if (n === 0 || !(dt > 0)) return eaten;
    this._clock -= dt;
    if (this._clock <= 0) {
      this._clock += BLACK_HOLE_EAT_INTERVAL_S;
      if (this._clock <= 0) this._clock = BLACK_HOLE_EAT_INTERVAL_S;
      for (const h of this.holes.values()) h.due = true;
    }
    const list = Array.from(this.holes.values());
    const start = this._cursor % n;
    const dirtied = this._eatChunks;
    dirtied.length = 0;
    let nextStart = -1; // the first due hole a limit held back
    for (let i = 0; i < n; i++) {
      const h = list[(start + i) % n];
      if (!h.due || h.offset >= EAT_OFFSETS.length || !world.isLoaded(h.q, h.r)) continue;
      if (eaten.length >= BLACK_HOLE_MAX_EATS_PER_FRAME) {
        if (nextStart < 0) nextStart = (start + i) % n;
        continue;
      }
      const cell = this._nextCell(h, world);
      if (cell !== null && eaten.length > 0) {
        const tried = this._tryChunks;
        tried.length = 0;
        for (const c of dirtied) tried.push(c);
        // Chunks this call already dirtied are re-meshed anyway, so more eats inside them cost no extra mesh.
        if (addEatChunks(tried, cell[0], cell[2]).length > Math.max(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, dirtied.length)) {
          if (nextStart < 0) nextStart = (start + i) % n;
          continue;
        }
      }
      h.due = false;
      if (cell === null) continue;
      const [q, y, r, id] = cell;
      // setBlock fires onBlockChange with next = AIR, which reopens nothing: h.offset stays on this (now empty) cell.
      if (world.setBlock(q, y, r, BLOCK.AIR)) {
        eaten.push({ q, y, r, id });
        addEatChunks(dirtied, q, r);
      }
    }
    this._cursor = nextStart >= 0 ? nextStart : (start + 1) % n;
    return eaten;
  }

  /**
   * Nearest swallowable loaded cell of `h`, resuming from h.offset (cells before it were empty or protected).
   * @returns {[number, number, number, number]|null} [q, y, r, id]
   */
  _nextCell(h, world) {
    for (; h.offset < EAT_OFFSETS.length; h.offset++) {
      const [dq, dy, dr] = EAT_OFFSETS[h.offset];
      const q = h.q + dq;
      const y = h.y + dy;
      const r = h.r + dr;
      if (!world.isLoaded(q, r)) return null; // wait for the chunk rather than skipping past it
      const id = world.getBlock(q, y, r);
      if (canSwallow(id)) return [q, y, r, id];
    }
    return null;
  }

  /** A cell changed: every hole whose ball contains it restarts its nearest-first search. */
  _reopen(q, y, r) {
    for (const h of this.holes.values()) {
      if (Math.abs(y - h.y) > BLACK_HOLE_EAT_RADIUS) continue;
      if (hexDistance(h.q, h.r, q, r) > BLACK_HOLE_EAT_RADIUS) continue;
      h.offset = 0;
    }
  }
}
