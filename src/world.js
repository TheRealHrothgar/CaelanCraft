// Caelancraft — World: chunk streaming, block edits and mesh orchestration.
// See src/CONTRACTS.md §9 and §9.1. Pure except for the `performance.now` clock (Date.now fallback),
// which is only used as the default `now` option; tests inject `now: () => 0`.
//
// Cells are hexagonal prisms addressed by axial (q, r) + y; chunks are 16×16 in (q, r). Because the chunk
// lattice is itself a regular hex lattice in world space, streaming uses HEX distance in chunk coordinates:
// the loaded region is a hexagon of chunks around the player, and a chunk is meshed once its six
// hex-adjacent chunks exist (the mesher's halo only ever reads those).
//
// findSpawn is bounded to SPAWN_MAX_RINGS rings and update() keeps walking the ring in count-only
// mode after the budget trips so pendingGen/pendingMesh describe the whole ring (both accepted by §9).
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, RENDER_DISTANCE, DATA_RADIUS_EXTRA,
  UNLOAD_RADIUS_EXTRA, BUILD_BUDGET_MS, MAX_BUILDS_PER_UPDATE,
} from './config.js';
import { chunkKey, parseChunkKey, localIndex, indexToLocal } from './coords.js';
import { HEX_DIRS, hexLength, hexNormSq, hexToWorld, worldToHex } from './hex.js';
import { BLOCK, BIOME } from './blocks.js';
import { Chunk } from './chunk.js';
import { createWorldGen } from './worldgen.js';
import { buildChunkMesh } from './mesher.js';
import { normalizeSeed } from './noise.js';

/** @typedef {import('./types.js').BlockId} BlockId */
/** @typedef {import('./types.js').ChunkKey} ChunkKey */
/** @typedef {import('./types.js').Vec3} Vec3 */
/** @typedef {import('./types.js').WorldGen} WorldGen */
/** @typedef {import('./types.js').EditsJSON} EditsJSON */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */

/**
 * @typedef {Object} WorldOptions
 * @property {string|number} [seed]
 * @property {number} [renderDistance]   default RENDER_DISTANCE, clamped 1..16
 * @property {EditsJSON} [edits]         saved edits to merge before any chunk is generated
 * @property {WorldGen} [worldGen]       injected generator (tests); default createWorldGen(seed)
 * @property {() => number} [now]        millisecond clock; default performance.now / Date.now
 */

/**
 * @typedef {Object} UpdateResult
 * @property {number} generated   chunks generated this call
 * @property {number} meshed      chunk meshes built this call (including edit re-meshes)
 * @property {number} unloaded    chunks removed this call
 * @property {number} pendingGen  ring entries still without a chunk
 * @property {number} pendingMesh ring entries within renderDistance still missing or dirty
 */

const MIN_RENDER_DISTANCE = 1;
const MAX_RENDER_DISTANCE = 16;

/** findSpawn spiral: step in cells and the maximum ring searched before falling back. */
const SPAWN_STEP = 4;
const SPAWN_MAX_RINGS = 128; // 512 cells in every direction

// Numeric chunk id used for the allocation-free lookup index. cq, cr are shifted into
// [0, 2^21) and packed into one double (exact up to 2^53). Chunks beyond ±2^20 (16.7 million
// cells) are far outside float-precision playability anyway.
const ID_OFFSET = 1 << 20;
const ID_SPAN = 1 << 21;

/** @returns {number} unique numeric id for chunk (cq, cr) */
function packId(cq, cr) {
  return (cq + ID_OFFSET) * ID_SPAN + (cr + ID_OFFSET);
}

/** @returns {() => number} millisecond clock */
function defaultClock() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
}

/** @returns {number} render distance clamped to the allowed range (non-finite → default) */
function clampRenderDistance(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return RENDER_DISTANCE;
  return Math.max(MIN_RENDER_DISTANCE, Math.min(MAX_RENDER_DISTANCE, Math.floor(n)));
}

/** @returns {boolean} true iff `v` is an integer in [lo, hi] */
function isIntIn(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

export class World {
  /** @param {WorldOptions} [opts] */
  constructor(opts = {}) {
    /** @type {number} normalised uint32 */
    this.seed = normalizeSeed(opts.seed ?? opts.worldGen?.seed);
    /** @type {number} */
    this.renderDistance = clampRenderDistance(opts.renderDistance ?? RENDER_DISTANCE);
    /** @type {WorldGen} */
    this.worldGen = opts.worldGen ?? createWorldGen(this.seed);
    /** @type {Map<ChunkKey, Chunk>} */
    this.chunks = new Map();
    /** @type {Map<ChunkKey, Map<number, BlockId>>} inner key = localIndex */
    this.edits = new Map();
    /** incremented on every successful setBlock (autosave uses it) */
    this.editVersion = 0;

    /** @type {(key: ChunkKey, cq: number, cr: number, meshData: ChunkMeshData) => void} */
    this.onChunkMesh = (_key, _cq, _cr, _meshData) => {};
    /** @type {(key: ChunkKey) => void} */
    this.onChunkUnload = (_key) => {};
    /**
     * Assignable hook, called synchronously from setBlock (only) after a successful change, once the edit is
     * recorded and the chunks are marked dirty. Not fired by importEdits or by applying saved edits on generation.
     * @type {(q: number, y: number, r: number, prev: BlockId, next: BlockId) => void}
     */
    this.onBlockChange = (_q, _y, _r, _prev, _next) => {};

    /** @type {() => number} */
    this._now = typeof opts.now === 'function' ? opts.now : defaultClock();

    /** @type {Map<number, Chunk>} packId → Chunk; mirrors `chunks` for string-free lookups */
    this._byId = new Map();
    /** getBlock single-entry cache (physics/raycast hit the same chunk repeatedly). */
    /** @type {Chunk|null} */
    this._lastChunk = null;
    this._lastCq = NaN;
    this._lastCr = NaN;

    /** RING_OFFSETS as parallel typed arrays, sorted nearest-first (see _computeRing). */
    this._ringDq = new Int16Array(0);
    this._ringDr = new Int16Array(0);
    this._ringDist = new Uint8Array(0);
    this._computeRing();

    /**
     * Block id at cell (q, y, r); AIR when y is out of range or the chunk is not loaded.
     * ARROW PROPERTY: safe to pass around detached. Never allocates.
     * @type {(q: number, y: number, r: number) => BlockId}
     */
    this.getBlock = (q, y, r) => {
      y = Math.floor(y);
      if (!(y >= 0 && y < WORLD_HEIGHT)) return BLOCK.AIR; // also rejects NaN
      q = Math.floor(q);
      r = Math.floor(r);
      const cq = Math.floor(q / CHUNK_SIZE);
      const cr = Math.floor(r / CHUNK_SIZE);
      let chunk;
      if (cq === this._lastCq && cr === this._lastCr) {
        chunk = this._lastChunk;
      } else {
        chunk = this._byId.get(packId(cq, cr));
        if (chunk === undefined) return BLOCK.AIR;
        this._lastChunk = chunk;
        this._lastCq = cq;
        this._lastCr = cr;
      }
      const lq = q - cq * CHUNK_SIZE;
      const lr = r - cr * CHUNK_SIZE;
      return chunk.blocks[(lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y];
    };

    /**
     * Loaded chunk at chunk coordinates or null. ARROW PROPERTY (handed to the mesher).
     * @type {(cq: number, cr: number) => Chunk|null}
     */
    this.getChunkData = (cq, cr) => this._byId.get(packId(cq, cr)) ?? null;

    if (opts.edits) {
      this.importEdits(opts.edits);
      this.editVersion = 0; // restoring a save is not a new edit
    }
  }

  // -------------------------------------------------------------------------------------------
  // queries

  /** @returns {Chunk|undefined} */
  getChunk(cq, cr) {
    return this._byId.get(packId(cq, cr));
  }

  /** @returns {BlockId} block at WORLD position (x, y, z) — convenience over getBlock(worldToHex(x, z)) */
  getBlockAt(x, y, z) {
    if (!Number.isFinite(x + y + z)) return BLOCK.AIR;
    const [q, r] = worldToHex(x, z);
    return this.getBlock(q, Math.floor(y), r);
  }

  /** @returns {boolean} a chunk is loaded under the cell containing world point (wx, wz) */
  hasChunkAt(wx, wz) {
    if (!Number.isFinite(wx + wz)) return false;
    const [q, r] = worldToHex(wx, wz);
    return this.hasChunkAtCell(q, r);
  }

  /** @returns {boolean} a chunk is loaded under cell column (q, r) */
  hasChunkAtCell(q, r) {
    return this._byId.has(packId(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)));
  }

  /** @returns {boolean} chunk under world point (wx, wz) exists, is not dirty and has been meshed */
  isReadyAt(wx, wz) {
    if (!Number.isFinite(wx + wz)) return false;
    const [q, r] = worldToHex(wx, wz);
    return this.isReadyAtCell(q, r);
  }

  /** @returns {boolean} chunk under cell column (q, r) exists, is not dirty and has been meshed */
  isReadyAtCell(q, r) {
    const chunk = this._byId.get(packId(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)));
    return chunk !== undefined && !chunk.dirty && chunk.meshed;
  }

  /** @returns {number} number of loaded chunks */
  get chunkCount() {
    return this.chunks.size;
  }

  /** @returns {number} total recorded edits (cells that differ from worldgen or were edited back), across all chunks */
  get editCount() {
    let n = 0;
    for (const m of this.edits.values()) n += m.size;
    return n;
  }

  /** @returns {number} terrain height from worldGen.getColumn (ignores edits) */
  getSurfaceHeight(q, r) {
    return this.worldGen.getColumn(q, r).height;
  }

  /** @returns {number} biome id from worldGen.getColumn */
  getBiome(q, r) {
    return this.worldGen.getColumn(q, r).biome;
  }

  // -------------------------------------------------------------------------------------------
  // edits

  /**
   * Set a block. Records the edit, bumps editVersion and dirties every LOADED chunk containing the cell or
   * one of its six side neighbours (1–4 chunks) so neighbouring meshes update their culled faces / AO.
   * @returns {boolean} false if y out of range, id invalid, chunk not loaded, or value unchanged
   */
  setBlock(q, y, r, id) {
    y = Math.floor(y);
    if (!(y >= 0 && y < WORLD_HEIGHT)) return false;
    if (!isIntIn(id, 0, 255)) return false;
    q = Math.floor(q);
    r = Math.floor(r);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunk = this._byId.get(packId(cq, cr));
    if (chunk === undefined) return false;
    const lq = q - cq * CHUNK_SIZE;
    const lr = r - cr * CHUNK_SIZE;
    const prev = chunk.blocks[localIndex(lq, y, lr)];
    if (!chunk.set(lq, y, lr, id)) return false;

    let chunkEdits = this.edits.get(chunk.key);
    if (chunkEdits === undefined) {
      chunkEdits = new Map();
      this.edits.set(chunk.key, chunkEdits);
    }
    chunkEdits.set(localIndex(lq, y, lr), id);
    this.editVersion++;
    this._markDirtyAround(q, r);
    this.onBlockChange(q, y, r, prev, id);
    return true;
  }

  /** @returns {EditsJSON} `{ "cq,cr": [localIndex, id, localIndex, id, ...] }` (fresh arrays) */
  exportEdits() {
    /** @type {EditsJSON} */
    const out = {};
    for (const [key, chunkEdits] of this.edits) {
      if (chunkEdits.size === 0) continue;
      const arr = new Array(chunkEdits.size * 2);
      let i = 0;
      for (const [li, id] of chunkEdits) {
        arr[i++] = li;
        arr[i++] = id;
      }
      out[key] = arr;
    }
    return out;
  }

  /**
   * Merge saved edits (last write wins). Malformed keys / pairs are skipped. For loaded chunks the
   * blocks are applied immediately and the affected chunks (plus border neighbours) marked dirty.
   * @param {EditsJSON|null|undefined} editsJson
   */
  importEdits(editsJson) {
    if (!editsJson || typeof editsJson !== 'object') return;
    for (const rawKey of Object.keys(editsJson)) {
      const arr = editsJson[rawKey];
      if (!Array.isArray(arr)) continue;
      const [cq, cr] = parseChunkKey(rawKey);
      if (!Number.isInteger(cq) || !Number.isInteger(cr)) continue;
      const key = chunkKey(cq, cr);
      const chunk = this._byId.get(packId(cq, cr));
      let chunkEdits = this.edits.get(key);
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const li = arr[i];
        const id = arr[i + 1];
        if (!isIntIn(li, 0, CHUNK_VOLUME - 1) || !isIntIn(id, 0, 255)) continue;
        if (chunkEdits === undefined) {
          chunkEdits = new Map();
          this.edits.set(key, chunkEdits);
        }
        chunkEdits.set(li, id);
        if (chunk !== undefined && chunk.blocks[li] !== id) {
          chunk.blocks[li] = id;
          chunk.dirty = true;
          const [lq, , lr] = indexToLocal(li);
          this._markDirtyAround(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // streaming

  /**
   * One streaming step (CONTRACTS §9.1): unload far chunks, re-mesh edited chunks, then walk the
   * precomputed ring nearest-first generating missing chunks and meshing chunks whose 6 hex neighbours
   * exist, stopping after MAX_BUILDS_PER_UPDATE builds or when `budgetMs` has elapsed.
   * @param {number} px  player world x
   * @param {number} pz  player world z
   * @param {number} [budgetMs]
   * @returns {UpdateResult}
   */
  update(px, pz, budgetMs = BUILD_BUDGET_MS) {
    // A non-finite position would generate and mesh a phantom 'NaN,NaN' chunk that nothing ever unloads.
    if (!Number.isFinite(px + pz)) return { generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 };
    const [pq, pr] = worldToHex(px, pz);
    const pcq = Math.floor(pq / CHUNK_SIZE);
    const pcr = Math.floor(pr / CHUNK_SIZE);
    const now = this._now;
    const start = now();
    const renderDistance = this.renderDistance;
    let builds = 0;
    let generated = 0;
    let meshed = 0;
    let unloaded = 0;
    let pendingGen = 0;
    let pendingMesh = 0;

    // 1. Unload everything beyond the unload radius (edits stay in `this.edits`).
    const unloadRadius = renderDistance + UNLOAD_RADIUS_EXTRA;
    for (const chunk of this.chunks.values()) {
      if (hexLength(chunk.cq - pcq, chunk.cr - pcr) > unloadRadius) {
        this._removeChunk(chunk);
        unloaded++;
      }
    }

    // 2. Re-mesh edited chunks immediately (visible feedback for the player; ignores the budget).
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty && chunk.meshed && this._neighboursLoaded(chunk.cq, chunk.cr)) {
        this._mesh(chunk);
        meshed++;
      }
    }

    // 3. Ring walk, nearest first. After the budget/cap trips we keep walking in count-only mode
    //    so pendingGen / pendingMesh describe the whole ring.
    const dqs = this._ringDq;
    const drs = this._ringDr;
    const dists = this._ringDist;
    const n = dqs.length;
    let stopped = false;
    for (let i = 0; i < n; i++) {
      const cq = pcq + dqs[i];
      const cr = pcr + drs[i];
      const inMeshRadius = dists[i] <= renderDistance;
      let chunk = this._byId.get(packId(cq, cr));

      if (stopped) {
        if (chunk === undefined) {
          pendingGen++;
          if (inMeshRadius) pendingMesh++;
        } else if (inMeshRadius && chunk.dirty) {
          pendingMesh++;
        }
        continue;
      }

      if (chunk === undefined) {
        chunk = this._generate(cq, cr);
        builds++;
        generated++;
        if (builds >= MAX_BUILDS_PER_UPDATE || now() - start >= budgetMs) stopped = true;
      }

      if (inMeshRadius && chunk.dirty) {
        if (!stopped && this._neighboursLoaded(cq, cr)) {
          this._mesh(chunk);
          builds++;
          meshed++;
          if (builds >= MAX_BUILDS_PER_UPDATE || now() - start >= budgetMs) stopped = true;
        } else {
          pendingMesh++;
        }
      }
    }

    return { generated, meshed, unloaded, pendingGen, pendingMesh };
  }

  /**
   * Spiral out from cell (0,0) over hex rings in SPAWN_STEP-cell steps until a column is above sea level and
   * not OCEAN/BEACH. Falls back to the origin column (raised to sea level) if nothing is found within
   * SPAWN_MAX_RINGS rings, so an all-ocean generator cannot hang the game.
   * @returns {Vec3} world [x, height+1, z] of the cell centre
   */
  findSpawn() {
    const step = SPAWN_STEP;
    const first = this._spawnAt(0, 0);
    if (first) return first;
    for (let n = 1; n <= SPAWN_MAX_RINGS; n++) {
      // Walk ring n: start at n × direction 4, then n steps along each of the six directions in order.
      let dq = HEX_DIRS[4][0] * n;
      let dr = HEX_DIRS[4][1] * n;
      for (let side = 0; side < 6; side++) {
        const d = HEX_DIRS[side];
        for (let j = 0; j < n; j++) {
          const s = this._spawnAt(dq * step, dr * step);
          if (s) return s;
          dq += d[0];
          dr += d[1];
        }
      }
    }
    const col = this.worldGen.getColumn(0, 0);
    return [0, Math.max(col.height, SEA_LEVEL) + 1, 0];
  }

  /** Clamp to 1..16 and rebuild the ring offsets; far chunks are dropped on the next update(). */
  setRenderDistance(n) {
    const rd = clampRenderDistance(n);
    if (rd === this.renderDistance && this._ringDq.length > 0) return;
    this.renderDistance = rd;
    this._computeRing();
  }

  /** Remove every chunk, firing onChunkUnload for the meshed ones. Edits are kept. */
  dispose() {
    for (const chunk of this.chunks.values()) this._removeChunk(chunk);
    this.chunks.clear();
    this._byId.clear();
    this._lastChunk = null;
    this._lastCq = NaN;
    this._lastCr = NaN;
  }

  // -------------------------------------------------------------------------------------------
  // internals

  /** @returns {Vec3|null} spawn position if cell column (q, r) is a valid spawn */
  _spawnAt(q, r) {
    const col = this.worldGen.getColumn(q, r);
    if (col.height >= SEA_LEVEL + 2 && col.biome !== BIOME.OCEAN && col.biome !== BIOME.BEACH) {
      const [x, z] = hexToWorld(q, r);
      return [x, col.height + 1, z];
    }
    return null;
  }

  /**
   * Precompute RING_OFFSETS: the hex disc of radius renderDistance + DATA_RADIUS_EXTRA in chunk coordinates,
   * sorted by world distance between chunk centres (∝ dq² + dq·dr + dr²), ties dr then dq.
   */
  _computeRing() {
    const radius = this.renderDistance + DATA_RADIUS_EXTRA;
    const dqList = [];
    const drList = [];
    for (let r = -radius; r <= radius; r++) {
      for (let q = -radius; q <= radius; q++) {
        if (hexLength(q, r) > radius) continue;
        dqList.push(q);
        drList.push(r);
      }
    }
    const count = dqList.length;
    const order = new Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    order.sort((a, b) => {
      const da = hexNormSq(dqList[a], drList[a]);
      const db = hexNormSq(dqList[b], drList[b]);
      if (da !== db) return da - db;
      if (drList[a] !== drList[b]) return drList[a] - drList[b];
      return dqList[a] - dqList[b];
    });
    const ringDq = new Int16Array(count);
    const ringDr = new Int16Array(count);
    const ringDist = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const o = order[k];
      ringDq[k] = dqList[o];
      ringDr[k] = drList[o];
      ringDist[k] = hexLength(dqList[o], drList[o]);
    }
    this._ringDq = ringDq;
    this._ringDr = ringDr;
    this._ringDist = ringDist;
  }

  /** @returns {boolean} all 6 hex-adjacent neighbours of chunk (cq, cr) are loaded */
  _neighboursLoaded(cq, cr) {
    const byId = this._byId;
    for (let j = 0; j < 6; j++) {
      if (!byId.has(packId(cq + HEX_DIRS[j][0], cr + HEX_DIRS[j][1]))) return false;
    }
    return true;
  }

  /**
   * Mark dirty every loaded chunk containing cell (q, r) or one of its six neighbours: 1 to 4 chunks (4 only for
   * the two index-space corner cells lq=15,lr=0 and lq=0,lr=15, whose neighbours span three other chunks).
   */
  _markDirtyAround(q, r) {
    this._markDirtyCell(q, r);
    for (let j = 0; j < 6; j++) this._markDirtyCell(q + HEX_DIRS[j][0], r + HEX_DIRS[j][1]);
  }

  _markDirtyCell(q, r) {
    const chunk = this._byId.get(packId(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)));
    if (chunk !== undefined) chunk.dirty = true;
  }

  /** Generate chunk (cq, cr), apply saved edits and register it. @returns {Chunk} */
  _generate(cq, cr) {
    const data = this.worldGen.generateChunk(cq, cr);
    const chunk = new Chunk(cq, cr, data);
    const chunkEdits = this.edits.get(chunk.key);
    if (chunkEdits !== undefined) {
      const blocks = chunk.blocks;
      for (const [li, id] of chunkEdits) blocks[li] = id;
    }
    this.chunks.set(chunk.key, chunk);
    this._byId.set(packId(cq, cr), chunk);
    return chunk;
  }

  /** Build and hand off the mesh of a chunk whose 6 neighbours are loaded. */
  _mesh(chunk) {
    const meshData = buildChunkMesh(chunk.cq, chunk.cr, this.getChunkData);
    chunk.dirty = false;
    chunk.meshed = true;
    this.onChunkMesh(chunk.key, chunk.cq, chunk.cr, meshData);
  }

  /** Drop a chunk from both indices, firing onChunkUnload if it had been meshed. */
  _removeChunk(chunk) {
    this.chunks.delete(chunk.key);
    this._byId.delete(packId(chunk.cq, chunk.cr));
    if (chunk === this._lastChunk) {
      this._lastChunk = null;
      this._lastCq = NaN;
      this._lastCr = NaN;
    }
    if (chunk.meshed) this.onChunkUnload(chunk.key);
  }
}
