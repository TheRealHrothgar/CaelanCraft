// Caelancraft — World: chunk streaming, block edits and mesh orchestration.
// See src/CONTRACTS.md §9 and §9.1. Pure except for the `performance.now` clock (Date.now fallback),
// which is only used as the default `now` option; tests inject `now: () => 0`.
//
// findSpawn is bounded to SPAWN_MAX_RINGS rings and update() keeps walking the ring in count-only
// mode after the budget trips so pendingGen/pendingMesh describe the whole ring (both accepted by §9).
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, RENDER_DISTANCE, DATA_RADIUS_EXTRA,
  UNLOAD_RADIUS_EXTRA, BUILD_BUDGET_MS, MAX_BUILDS_PER_UPDATE,
} from './config.js';
import { chunkKey, parseChunkKey, localIndex, indexToLocal } from './coords.js';
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

/** findSpawn spiral: step in blocks and the maximum ring searched before falling back. */
const SPAWN_STEP = 4;
const SPAWN_MAX_RINGS = 128; // 512 blocks in every direction

// Numeric chunk id used for the allocation-free lookup index. cx, cz are shifted into
// [0, 2^21) and packed into one double (exact up to 2^53). Chunks beyond ±2^20 (16.7 million
// blocks) are far outside float-precision playability anyway.
const ID_OFFSET = 1 << 20;
const ID_SPAN = 1 << 21;

/** @returns {number} unique numeric id for chunk (cx, cz) */
function packId(cx, cz) {
  return (cx + ID_OFFSET) * ID_SPAN + (cz + ID_OFFSET);
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

    /** @type {(key: ChunkKey, cx: number, cz: number, meshData: ChunkMeshData) => void} */
    this.onChunkMesh = (_key, _cx, _cz, _meshData) => {};
    /** @type {(key: ChunkKey) => void} */
    this.onChunkUnload = (_key) => {};

    /** @type {() => number} */
    this._now = typeof opts.now === 'function' ? opts.now : defaultClock();

    /** @type {Map<number, Chunk>} packId → Chunk; mirrors `chunks` for string-free lookups */
    this._byId = new Map();
    /** getBlock single-entry cache (physics/raycast hit the same chunk repeatedly). */
    /** @type {Chunk|null} */
    this._lastChunk = null;
    this._lastCx = NaN;
    this._lastCz = NaN;

    /** RING_OFFSETS as parallel typed arrays, sorted nearest-first (see _computeRing). */
    this._ringDx = new Int16Array(0);
    this._ringDz = new Int16Array(0);
    this._ringCheb = new Uint8Array(0);
    this._computeRing();

    /**
     * Block id at world coordinates; AIR when y is out of range or the chunk is not loaded.
     * ARROW PROPERTY: safe to pass around detached. Never allocates.
     * @type {(wx: number, wy: number, wz: number) => BlockId}
     */
    this.getBlock = (wx, wy, wz) => {
      wy = Math.floor(wy);
      if (!(wy >= 0 && wy < WORLD_HEIGHT)) return BLOCK.AIR; // also rejects NaN
      wx = Math.floor(wx);
      wz = Math.floor(wz);
      const cx = Math.floor(wx / CHUNK_SIZE);
      const cz = Math.floor(wz / CHUNK_SIZE);
      let chunk;
      if (cx === this._lastCx && cz === this._lastCz) {
        chunk = this._lastChunk;
      } else {
        chunk = this._byId.get(packId(cx, cz));
        if (chunk === undefined) return BLOCK.AIR;
        this._lastChunk = chunk;
        this._lastCx = cx;
        this._lastCz = cz;
      }
      const lx = wx - cx * CHUNK_SIZE;
      const lz = wz - cz * CHUNK_SIZE;
      return chunk.blocks[(lx * CHUNK_SIZE + lz) * WORLD_HEIGHT + wy];
    };

    /**
     * Loaded chunk at chunk coordinates or null. ARROW PROPERTY (handed to the mesher).
     * @type {(cx: number, cz: number) => Chunk|null}
     */
    this.getChunkData = (cx, cz) => this._byId.get(packId(cx, cz)) ?? null;

    if (opts.edits) {
      this.importEdits(opts.edits);
      this.editVersion = 0; // restoring a save is not a new edit
    }
  }

  // -------------------------------------------------------------------------------------------
  // queries

  /** @returns {Chunk|undefined} */
  getChunk(cx, cz) {
    return this._byId.get(packId(cx, cz));
  }

  /** @returns {boolean} a chunk is loaded under world column (wx, wz) */
  hasChunkAt(wx, wz) {
    return this._byId.has(packId(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
  }

  /** @returns {boolean} chunk exists, is not dirty and has been meshed */
  isReadyAt(wx, wz) {
    const chunk = this._byId.get(packId(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    return chunk !== undefined && !chunk.dirty && chunk.meshed;
  }

  /** @returns {number} number of loaded chunks */
  get chunkCount() {
    return this.chunks.size;
  }

  /** @returns {number} terrain height from worldGen.getColumn (ignores edits) */
  getSurfaceHeight(wx, wz) {
    return this.worldGen.getColumn(wx, wz).height;
  }

  /** @returns {number} biome id from worldGen.getColumn */
  getBiome(wx, wz) {
    return this.worldGen.getColumn(wx, wz).biome;
  }

  // -------------------------------------------------------------------------------------------
  // edits

  /**
   * Set a block. Records the edit, bumps editVersion and dirties every LOADED chunk containing
   * (wx+dx, wz+dz) for dx,dz ∈ {-1,0,1} so neighbouring meshes update their culled faces / AO.
   * @returns {boolean} false if y out of range, id invalid, chunk not loaded, or value unchanged
   */
  setBlock(wx, wy, wz, id) {
    wy = Math.floor(wy);
    if (!(wy >= 0 && wy < WORLD_HEIGHT)) return false;
    if (!isIntIn(id, 0, 255)) return false;
    wx = Math.floor(wx);
    wz = Math.floor(wz);
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const chunk = this._byId.get(packId(cx, cz));
    if (chunk === undefined) return false;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    if (!chunk.set(lx, wy, lz, id)) return false;

    let chunkEdits = this.edits.get(chunk.key);
    if (chunkEdits === undefined) {
      chunkEdits = new Map();
      this.edits.set(chunk.key, chunkEdits);
    }
    chunkEdits.set(localIndex(lx, wy, lz), id);
    this.editVersion++;
    this._markDirtyAround(wx, wz);
    return true;
  }

  /** @returns {EditsJSON} `{ "cx,cz": [localIndex, id, localIndex, id, ...] }` (fresh arrays) */
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
      const [cx, cz] = parseChunkKey(rawKey);
      if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
      const key = chunkKey(cx, cz);
      const chunk = this._byId.get(packId(cx, cz));
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
          const [lx, , lz] = indexToLocal(li);
          this._markDirtyAround(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // streaming

  /**
   * One streaming step (CONTRACTS §9.1): unload far chunks, re-mesh edited chunks, then walk the
   * precomputed ring nearest-first generating missing chunks and meshing chunks whose 8 neighbours
   * exist, stopping after MAX_BUILDS_PER_UPDATE builds or when `budgetMs` has elapsed.
   * @param {number} px  player x (blocks)
   * @param {number} pz  player z (blocks)
   * @param {number} [budgetMs]
   * @returns {UpdateResult}
   */
  update(px, pz, budgetMs = BUILD_BUDGET_MS) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
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
      const ddx = chunk.cx - pcx;
      const ddz = chunk.cz - pcz;
      const d = ddx < 0 ? -ddx : ddx;
      const e = ddz < 0 ? -ddz : ddz;
      if ((d > e ? d : e) > unloadRadius) {
        this._removeChunk(chunk);
        unloaded++;
      }
    }

    // 2. Re-mesh edited chunks immediately (visible feedback for the player; ignores the budget).
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty && chunk.meshed && this._neighboursLoaded(chunk.cx, chunk.cz)) {
        this._mesh(chunk);
        meshed++;
      }
    }

    // 3. Ring walk, nearest first. After the budget/cap trips we keep walking in count-only mode
    //    so pendingGen / pendingMesh describe the whole ring.
    const dxs = this._ringDx;
    const dzs = this._ringDz;
    const chebs = this._ringCheb;
    const n = dxs.length;
    let stopped = false;
    for (let i = 0; i < n; i++) {
      const cx = pcx + dxs[i];
      const cz = pcz + dzs[i];
      const inMeshRadius = chebs[i] <= renderDistance;
      let chunk = this._byId.get(packId(cx, cz));

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
        chunk = this._generate(cx, cz);
        builds++;
        generated++;
        if (builds >= MAX_BUILDS_PER_UPDATE || now() - start >= budgetMs) stopped = true;
      }

      if (inMeshRadius && chunk.dirty) {
        if (!stopped && this._neighboursLoaded(cx, cz)) {
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
   * Spiral out from (0,0) in SPAWN_STEP-block steps until a column is above sea level and not
   * OCEAN/BEACH. Falls back to the origin column (raised to sea level) if nothing is found within
   * SPAWN_MAX_RINGS rings, so an all-ocean generator cannot hang the game.
   * @returns {Vec3} [x+0.5, height+1, z+0.5]
   */
  findSpawn() {
    const step = SPAWN_STEP;
    for (let r = 0; r <= SPAWN_MAX_RINGS; r++) {
      if (r === 0) {
        const s = this._spawnAt(0, 0);
        if (s) return s;
        continue;
      }
      // Top and bottom rows (z = ∓r), left to right.
      for (let i = -r; i <= r; i++) {
        let s = this._spawnAt(i * step, -r * step);
        if (s) return s;
        s = this._spawnAt(i * step, r * step);
        if (s) return s;
      }
      // Left and right columns (x = ∓r) without the corners already visited.
      for (let j = -r + 1; j <= r - 1; j++) {
        let s = this._spawnAt(-r * step, j * step);
        if (s) return s;
        s = this._spawnAt(r * step, j * step);
        if (s) return s;
      }
    }
    const col = this.worldGen.getColumn(0, 0);
    return [0.5, Math.max(col.height, SEA_LEVEL) + 1, 0.5];
  }

  /** Clamp to 1..16 and rebuild the ring offsets; far chunks are dropped on the next update(). */
  setRenderDistance(n) {
    const rd = clampRenderDistance(n);
    if (rd === this.renderDistance && this._ringDx.length > 0) return;
    this.renderDistance = rd;
    this._computeRing();
  }

  /** Remove every chunk, firing onChunkUnload for the meshed ones. Edits are kept. */
  dispose() {
    for (const chunk of this.chunks.values()) this._removeChunk(chunk);
    this.chunks.clear();
    this._byId.clear();
    this._lastChunk = null;
    this._lastCx = NaN;
    this._lastCz = NaN;
  }

  // -------------------------------------------------------------------------------------------
  // internals

  /** @returns {Vec3|null} spawn position if column (x, z) is a valid spawn */
  _spawnAt(x, z) {
    const col = this.worldGen.getColumn(x, z);
    if (col.height >= SEA_LEVEL + 2 && col.biome !== BIOME.OCEAN && col.biome !== BIOME.BEACH) {
      return [x + 0.5, col.height + 1, z + 0.5];
    }
    return null;
  }

  /** Precompute RING_OFFSETS: Chebyshev disc of radius renderDistance + DATA_RADIUS_EXTRA, sorted by dx²+dz², ties dz then dx. */
  _computeRing() {
    const radius = this.renderDistance + DATA_RADIUS_EXTRA;
    const side = radius * 2 + 1;
    const count = side * side;
    const dx = new Int16Array(count);
    const dz = new Int16Array(count);
    const order = new Array(count);
    let i = 0;
    for (let z = -radius; z <= radius; z++) {
      for (let x = -radius; x <= radius; x++) {
        dx[i] = x;
        dz[i] = z;
        order[i] = i;
        i++;
      }
    }
    order.sort((a, b) => {
      const da = dx[a] * dx[a] + dz[a] * dz[a];
      const db = dx[b] * dx[b] + dz[b] * dz[b];
      if (da !== db) return da - db;
      if (dz[a] !== dz[b]) return dz[a] - dz[b];
      return dx[a] - dx[b];
    });
    const ringDx = new Int16Array(count);
    const ringDz = new Int16Array(count);
    const ringCheb = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const o = order[k];
      ringDx[k] = dx[o];
      ringDz[k] = dz[o];
      ringCheb[k] = Math.max(Math.abs(dx[o]), Math.abs(dz[o]));
    }
    this._ringDx = ringDx;
    this._ringDz = ringDz;
    this._ringCheb = ringCheb;
  }

  /** @returns {boolean} all 8 horizontal neighbours of chunk (cx, cz) are loaded */
  _neighboursLoaded(cx, cz) {
    const byId = this._byId;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        if (!byId.has(packId(cx + dx, cz + dz))) return false;
      }
    }
    return true;
  }

  /** Mark dirty every loaded chunk containing (wx+dx, wz+dz), dx,dz ∈ {-1,0,1}: 1 to 4 chunks. */
  _markDirtyAround(wx, wz) {
    const cx0 = Math.floor((wx - 1) / CHUNK_SIZE);
    const cx1 = Math.floor((wx + 1) / CHUNK_SIZE);
    const cz0 = Math.floor((wz - 1) / CHUNK_SIZE);
    const cz1 = Math.floor((wz + 1) / CHUNK_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const chunk = this._byId.get(packId(cx, cz));
        if (chunk !== undefined) chunk.dirty = true;
      }
    }
  }

  /** Generate chunk (cx, cz), apply saved edits and register it. @returns {Chunk} */
  _generate(cx, cz) {
    const data = this.worldGen.generateChunk(cx, cz);
    const chunk = new Chunk(cx, cz, data);
    const chunkEdits = this.edits.get(chunk.key);
    if (chunkEdits !== undefined) {
      const blocks = chunk.blocks;
      for (const [li, id] of chunkEdits) blocks[li] = id;
    }
    this.chunks.set(chunk.key, chunk);
    this._byId.set(packId(cx, cz), chunk);
    return chunk;
  }

  /** Build and hand off the mesh of a chunk whose 8 neighbours are loaded. */
  _mesh(chunk) {
    const meshData = buildChunkMesh(chunk.cx, chunk.cz, this.getChunkData);
    chunk.dirty = false;
    chunk.meshed = true;
    this.onChunkMesh(chunk.key, chunk.cx, chunk.cz, meshData);
  }

  /** Drop a chunk from both indices, firing onChunkUnload if it had been meshed. */
  _removeChunk(chunk) {
    this.chunks.delete(chunk.key);
    this._byId.delete(packId(chunk.cx, chunk.cz));
    if (chunk === this._lastChunk) {
      this._lastChunk = null;
      this._lastCx = NaN;
      this._lastCz = NaN;
    }
    if (chunk.meshed) this.onChunkUnload(chunk.key);
  }
}
