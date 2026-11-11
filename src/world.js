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
//
// v0.8 (block physics, CONTRACTS §9.2): every edit remembers the cell's ORIGINAL (generated) id in `origins`, and a
// write that puts a cell back to its origin deletes the edit, so drained water and refilled holes cost nothing in the
// save; `editCount` is a running count. `setBlock(…, lazy = true)` (physics, black holes, explosions) marks chunks
// dirty *lazily*: update() re-meshes those nearest-first under LAZY_MESH_BUDGET_MS instead of all at once;
// `lazy = 'coalesce'` (a big crumble) also waits LAZY_COALESCE_UPDATES calls between two re-meshes of a chunk.
//
// v0.9 (docs/DESIGN-survival.md §8.3, §2.5, §3.1): `new World({ …, gen })` picks the generator version (`world.gen`; 2
// adds the survival resources), `columnAt(q, r)` hands the climate its column, and `findSurvivalSpawn()` is findSpawn's
// spiral restricted to green land (PLAINS / FOREST), cached per world.
//
// Light (CONTRACTS §62): `world.light` is the LightEngine (light.js). Every generated chunk is lit as it is registered
// (its own blocks plus its loaded neighbours; light reaching meshed neighbours re-meshes them lazily); every successful
// setBlock / loaded importEdits pair is noted and the whole batch is re-lit at the start of the next update(), before
// anything is meshed, so a re-mesh always sees light that matches its blocks. The chunks the edit itself dirties follow
// the write's lazy flag; chunks dirtied only by the light it moved are re-meshed lazily (nearest first).
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, RENDER_DISTANCE, DATA_RADIUS_EXTRA,
  UNLOAD_RADIUS_EXTRA, BUILD_BUDGET_MS, MAX_BUILDS_PER_UPDATE, LAZY_MESH_BUDGET_MS, LAZY_COALESCE_UPDATES, GEN_LATEST,
} from './config.js';
import { chunkKey, parseChunkKey, localIndex, indexToLocal } from './coords.js';
import { HEX_DIRS, hexLength, hexNormSq, hexToWorld, worldToHex } from './hex.js';
import { BLOCK, BIOME, UNLOADED, isSolid } from './blocks.js';
import { Chunk } from './chunk.js';
import { createWorldGen } from './worldgen.js';
import { buildChunkMesh } from './mesher.js';
import { LightEngine } from './light.js';
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
 * @property {WorldGen} [worldGen]       injected generator (tests); default createWorldGen(seed, { gen })
 * @property {number} [gen]              generator version (§8.3): 1 (default, today's land) .. GEN_LATEST; anything else is 1.
 *                                       With an injected worldGen it defaults to that generator's own `gen` (or 1).
 * @property {() => number} [now]        millisecond clock; default performance.now / Date.now
 */

/**
 * The column the climate samples (docs/DESIGN-survival.md §3.1).
 * @typedef {{ height: number, biome: number, temperature: number }} ColumnSample
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

/** @returns {number} squared world distance from (px, pz) to the centre cell of `chunk` (lazy re-mesh order) */
function chunkDistSq(chunk, px, pz) {
  const [cx, cz] = hexToWorld(chunk.cq * CHUNK_SIZE + CHUNK_SIZE / 2, chunk.cr * CHUNK_SIZE + CHUNK_SIZE / 2);
  return (cx - px) * (cx - px) + (cz - pz) * (cz - pz);
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

/** @returns {number} a generator version: an integer 1..GEN_LATEST (anything that is not an integer ≥ 1 is 1) */
function normalizeGen(gen) {
  return Number.isInteger(gen) && gen >= 1 ? Math.min(gen, GEN_LATEST) : 1;
}

/** @returns {boolean} the column is green land a survivor can wake on (§2.5): PLAINS or FOREST, at least SEA_LEVEL + 2 */
function isSurvivalSpawnColumn(col) {
  return col.height >= SEA_LEVEL + 2 && (col.biome === BIOME.PLAINS || col.biome === BIOME.FOREST);
}

/** @returns {boolean} the column is a findSpawn column: at least SEA_LEVEL + 2 and not OCEAN / BEACH */
function isSpawnColumn(col) {
  return col.height >= SEA_LEVEL + 2 && col.biome !== BIOME.OCEAN && col.biome !== BIOME.BEACH;
}

export class World {
  /** @param {WorldOptions} [opts] */
  constructor(opts = {}) {
    /** @type {number} normalised uint32 */
    this.seed = normalizeSeed(opts.seed ?? opts.worldGen?.seed);
    /** @type {number} */
    this.renderDistance = clampRenderDistance(opts.renderDistance ?? RENDER_DISTANCE);
    /** @type {number} generator version (1 = today's land, 2 = with the survival resources); saved as `gen` when ≥ 2 */
    this.gen = normalizeGen(opts.gen ?? /** @type {{ gen?: number }} */ (opts.worldGen ?? {}).gen);
    /** @type {WorldGen} */
    this.worldGen = opts.worldGen ?? createWorldGen(this.seed, { gen: this.gen });
    /** @type {Vec3|null} findSurvivalSpawn's cached answer */
    this._survivalSpawn = null;
    /** @type {Map<ChunkKey, Chunk>} */
    this.chunks = new Map();
    /** @type {Map<ChunkKey, Map<number, BlockId>>} inner key = localIndex */
    this.edits = new Map();
    /**
     * The id each edited cell had before its first edit (worldgen's id), same keys as `edits` — absent for edits
     * imported into a chunk that has not been generated yet (filled in by _generate). A write back to the origin
     * deletes both entries.
     * @type {Map<ChunkKey, Map<number, BlockId>>}
     */
    this.origins = new Map();
    /** running number of entries across `edits` (O(1) editCount) */
    this._editCount = 0;
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
    /**
     * Assignable hook, called at the end of _generate (inside update()) once the new chunk is registered and its
     * saved edits are applied. Block physics re-queues the updates parked on this chunk and re-seeds its edited cells.
     * @type {(cq: number, cr: number) => void}
     */
    this.onChunkGenerated = (_cq, _cr) => {};

    /** @type {() => number} */
    this._now = typeof opts.now === 'function' ? opts.now : defaultClock();

    /** @type {Map<number, Chunk>} packId → Chunk; mirrors `chunks` for string-free lookups */
    this._byId = new Map();
    /** getBlock single-entry cache (physics/raycast hit the same chunk repeatedly). */
    /** @type {Chunk|null} */
    this._lastChunk = null;
    this._lastCq = NaN;
    this._lastCr = NaN;

    /** @type {Chunk[]} scratch list of lazily dirty chunks for update() step 2 */
    this._lazyScratch = [];
    /** update() calls so far (a 'coalesce' chunk's wait, §9.2) */
    this._updateCalls = 0;

    /** Per-cell sky and block light of every loaded chunk (§62). */
    this.light = new LightEngine(this);
    /**
     * How the chunks re-lit by the pending edits are dirtied: 'coalesce' while every pending write was a 'coalesce' one,
     * otherwise lazily (null: nothing pending).
     * @type {true|'coalesce'|null}
     */
    this._lightLazy = null;

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

  /** @returns {number} total recorded edit entries across all chunks (O(1): a running count, CONTRACTS §9.2) */
  get editCount() {
    return this._editCount;
  }

  /**
   * Like getBlock, but a cell in an UNLOADED chunk reads as the `UNLOADED` sentinel (255) instead of AIR; AIR above
   * and below the world. Block physics reads through this so it can tell "empty" from "not there yet".
   * @returns {BlockId|255}
   */
  peekBlock(q, y, r) {
    y = Math.floor(y);
    if (!(y >= 0 && y < WORLD_HEIGHT)) return BLOCK.AIR; // also NaN, like getBlock
    q = Math.floor(q);
    r = Math.floor(r);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunk = cq === this._lastCq && cr === this._lastCr ? this._lastChunk : this._byId.get(packId(cq, cr));
    if (chunk === undefined || chunk === null) return UNLOADED;
    return chunk.blocks[((q - cq * CHUNK_SIZE) * CHUNK_SIZE + (r - cr * CHUNK_SIZE)) * WORLD_HEIGHT + y];
  }

  /** @returns {boolean} the cell (any chunk, loaded or not) has a recorded edit */
  hasEdit(q, y, r) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return false;
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunkEdits = this.edits.get(chunkKey(cq, cr));
    return chunkEdits !== undefined && chunkEdits.has(localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE));
  }

  /**
   * The cell's original (generated) id: its recorded origin when edited, otherwise its current id (UNLOADED when the
   * chunk is not loaded and nothing is recorded). An edited cell whose chunk was never generated reports its edit.
   * @returns {BlockId|255}
   */
  originAt(q, y, r) {
    if (y >= 0 && y < WORLD_HEIGHT) {
      const cq = Math.floor(q / CHUNK_SIZE);
      const cr = Math.floor(r / CHUNK_SIZE);
      const key = chunkKey(cq, cr);
      const li = localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE);
      const o = this.origins.get(key)?.get(li);
      if (o !== undefined) return o;
    }
    return this.peekBlock(q, y, r);
  }

  /** @returns {number} chunk.heights of column (q, r) — the generated terrain height — or −1 when not loaded */
  terrainHeightAt(q, r) {
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunk = this._byId.get(packId(cq, cr));
    if (chunk === undefined) return -1;
    return chunk.heights[(q - cq * CHUNK_SIZE) * CHUNK_SIZE + (r - cr * CHUNK_SIZE)];
  }

  /**
   * Untouched terrain (CONTRACTS §9.2): the chunk is loaded, the cell has no edit, y ≤ the column's generated height
   * and the block is solid. Support searches stop as soon as they touch it.
   * @returns {boolean}
   */
  isNaturalGround(q, y, r) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return false;
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunk = this._byId.get(packId(cq, cr));
    if (chunk === undefined) return false;
    const lq = q - cq * CHUNK_SIZE;
    const lr = r - cr * CHUNK_SIZE;
    if (y > chunk.heights[lq * CHUNK_SIZE + lr]) return false;
    const li = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y;
    if (!isSolid(chunk.blocks[li])) return false;
    const chunkEdits = this.edits.get(chunk.key);
    return chunkEdits === undefined || !chunkEdits.has(li);
  }

  /** @returns {number} terrain height from worldGen.getColumn (ignores edits) */
  getSurfaceHeight(q, r) {
    return this.worldGen.getColumn(q, r).height;
  }

  /** @returns {number} biome id from worldGen.getColumn */
  getBiome(q, r) {
    return this.worldGen.getColumn(q, r).biome;
  }

  /**
   * The generated column at (q, r) for the climate (DESIGN-survival §3.1): height, biome and the raw temperature noise
   * (−1..1), straight from worldGen.getColumn (edits are ignored). A fresh object each call.
   * @param {number} q
   * @param {number} r
   * @returns {ColumnSample}
   */
  columnAt(q, r) {
    const col = this.worldGen.getColumn(q, r);
    return { height: col.height, biome: col.biome, temperature: col.temperature };
  }

  /**
   * Light at cell (q, y, r) (§62), packed `sky << 4 | block` (light.skyLevel / blockLevel unpack it): FULL_SKY (15, 0)
   * above the world and in unloaded chunks, 0 below it. Pending edits are re-lit first.
   * @returns {number}
   */
  lightAt(q, y, r) {
    this.flushLight();
    return this.light.get(q, y, r);
  }

  /**
   * Re-light every edit since the last call (update() does this first thing). Chunks whose meshes show the change are
   * dirtied: the edited cells' own chunks were already dirtied by the write; any other meshed chunk lazily ('coalesce'
   * when every write of the batch was one).
   */
  flushLight() {
    if (!this.light.hasPending) return;
    const lazy = this._lightLazy ?? true;
    this._lightLazy = null;
    for (const c of this.light.flush()) {
      if (c.meshed) this._markChunkDirty(c, lazy);
    }
  }

  // -------------------------------------------------------------------------------------------
  // edits

  /**
   * Set a block. Records the edit (or deletes it when the cell is back to its origin), bumps editVersion and dirties
   * every LOADED chunk containing the cell or one of its six side neighbours (1–4 chunks) so neighbouring meshes
   * update their culled faces / AO. A `lazy` write (block physics, black holes, explosions) marks those chunks
   * dirty lazily — re-meshed nearest-first under LAZY_MESH_BUDGET_MS by update() — unless they are already dirty
   * non-lazily; a non-lazy write always makes them non-lazy (immediate re-mesh). `lazy = 'coalesce'` is lazy too, and
   * a chunk dirtied by nothing else waits LAZY_COALESCE_UPDATES update() calls since its last mesh (§9.2).
   * @param {number} q
   * @param {number} y
   * @param {number} r
   * @param {number} id
   * @param {boolean|'coalesce'} [lazy=false]
   * @returns {boolean} false if y out of range, id invalid, chunk not loaded, or value unchanged
   */
  setBlock(q, y, r, id, lazy = false) {
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
    const li = localIndex(lq, y, lr);
    const prev = chunk.blocks[li];
    const wasDirty = chunk.dirty;
    if (!chunk.set(lq, y, lr, id)) return false;
    chunk.dirty = wasDirty; // _markDirtyAround decides (lazy or not) for this chunk like for its neighbours

    this._recordEdit(chunk.key, li, prev, id);
    this.editVersion++;
    this._markDirtyAround(q, r, lazy);
    this._noteLight(chunk, li, lazy);
    this.onBlockChange(q, y, r, prev, id);
    return true;
  }

  /**
   * Edit bookkeeping for one changed cell: the first edit of a cell records its origin (`prev`); an edit that returns
   * the cell to its origin is deleted. Keeps `_editCount` exact. An edit without a known origin is never pruned.
   */
  _recordEdit(key, li, prev, id) {
    let chunkEdits = this.edits.get(key);
    if (chunkEdits !== undefined && chunkEdits.has(li)) {
      const chunkOrigins = this.origins.get(key);
      if (chunkOrigins !== undefined && chunkOrigins.get(li) === id) {
        chunkEdits.delete(li);
        chunkOrigins.delete(li);
        this._editCount--;
        if (chunkEdits.size === 0) this.edits.delete(key);
        if (chunkOrigins.size === 0) this.origins.delete(key);
      } else {
        chunkEdits.set(li, id);
      }
      return;
    }
    if (chunkEdits === undefined) {
      chunkEdits = new Map();
      this.edits.set(key, chunkEdits);
    }
    chunkEdits.set(li, id);
    this._editCount++;
    let chunkOrigins = this.origins.get(key);
    if (chunkOrigins === undefined) {
      chunkOrigins = new Map();
      this.origins.set(key, chunkOrigins);
    }
    chunkOrigins.set(li, prev);
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
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const li = arr[i];
        const id = arr[i + 1];
        if (!isIntIn(li, 0, CHUNK_VOLUME - 1) || !isIntIn(id, 0, 255)) continue;
        if (chunk !== undefined) {
          // Loaded: the same bookkeeping as setBlock (origin on first edit, pruning back to it), applied now, no hook.
          const current = chunk.blocks[li];
          if (current === id) continue;
          this._recordEdit(key, li, current, id);
          chunk.blocks[li] = id;
          const [lq, , lr] = indexToLocal(li);
          this._markDirtyAround(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
          this._noteLight(chunk, li, false);
        } else {
          // Not generated yet: recorded without an origin; _generate fills it in (or drops a redundant edit).
          let chunkEdits = this.edits.get(key);
          if (chunkEdits === undefined) {
            chunkEdits = new Map();
            this.edits.set(key, chunkEdits);
          }
          if (!chunkEdits.has(li)) this._editCount++;
          chunkEdits.set(li, id);
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
    // 0. Re-light this frame's edits first (§62), so every mesh built below sees light that matches its blocks.
    this.flushLight();
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

    // 2. Re-mesh edited chunks immediately (visible feedback for the player; ignores the budget). Chunks dirtied only
    //    by lazy writes (physics) are collected and re-meshed nearest-first under LAZY_MESH_BUDGET_MS — always at
    //    least one per call — so a collapse or a flood never re-meshes dozens of chunks in one frame. One dirtied
    //    only by 'coalesce' writes (a big crumble's instant part) waits until LAZY_COALESCE_UPDATES calls have passed
    //    since it was last meshed: its updates of a few frames become one re-mesh.
    const call = ++this._updateCalls;
    const lazy = this._lazyScratch;
    lazy.length = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty && chunk.meshed && this._neighboursLoaded(chunk.cq, chunk.cr)) {
        if (chunk.lazy) {
          if (chunk.coalesce && call - chunk.meshedAt < LAZY_COALESCE_UPDATES) continue;
          lazy.push(chunk);
        } else {
          this._mesh(chunk);
          meshed++;
        }
      }
    }
    if (lazy.length > 0) {
      if (lazy.length > 1) lazy.sort((a, b) => chunkDistSq(a, px, pz) - chunkDistSq(b, px, pz));
      const lazyStart = now();
      for (let i = 0; i < lazy.length; i++) {
        if (i > 0 && now() - lazyStart >= LAZY_MESH_BUDGET_MS) break;
        this._mesh(lazy[i]);
        meshed++;
      }
      lazy.length = 0;
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
        // A meshed chunk with only lazy changes is the lazy pass's job (step 2); it still counts as pending.
        if (!stopped && !(chunk.meshed && chunk.lazy) && this._neighboursLoaded(cq, cr)) {
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
    const s = this._spiralSpawn(isSpawnColumn);
    if (s) return s;
    const col = this.worldGen.getColumn(0, 0);
    return [0, Math.max(col.height, SEA_LEVEL) + 1, 0];
  }

  /**
   * Where a survivor wakes without a Sleeping Hide (DESIGN-survival §2.5): the same SPAWN_STEP spiral as findSpawn, but
   * only PLAINS or FOREST columns at least SEA_LEVEL + 2 high are accepted, so a harsh world spawn (desert, snow,
   * mountains) is not repeated. Falls back to findSpawn() when the bounded spiral finds none. Pure (getColumn only, no
   * chunk is loaded) and cached per world; every call returns a fresh copy.
   * @returns {Vec3} world [x, height+1, z] of the cell centre
   */
  findSurvivalSpawn() {
    if (this._survivalSpawn === null) this._survivalSpawn = this._spiralSpawn(isSurvivalSpawnColumn) ?? this.findSpawn();
    const s = this._survivalSpawn;
    return [s[0], s[1], s[2]];
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
    this.light.clear();
    this._lightLazy = null;
    this.chunks.clear();
    this._byId.clear();
    this._lastChunk = null;
    this._lastCq = NaN;
    this._lastCr = NaN;
  }

  // -------------------------------------------------------------------------------------------
  // internals

  /**
   * Spiral out from cell (0,0) over hex rings in SPAWN_STEP-cell steps (ring n starts at n × direction 4, then walks n
   * steps along each of the six directions in order) and return the first column `accept` takes, or null after
   * SPAWN_MAX_RINGS rings.
   * @param {(col: import('./types.js').ColumnInfo) => boolean} accept
   * @returns {Vec3|null} world [x, height+1, z] of the accepted cell centre
   */
  _spiralSpawn(accept) {
    const step = SPAWN_STEP;
    const first = this._spawnAt(0, 0, accept);
    if (first) return first;
    for (let n = 1; n <= SPAWN_MAX_RINGS; n++) {
      let dq = HEX_DIRS[4][0] * n;
      let dr = HEX_DIRS[4][1] * n;
      for (let side = 0; side < 6; side++) {
        const d = HEX_DIRS[side];
        for (let j = 0; j < n; j++) {
          const s = this._spawnAt(dq * step, dr * step, accept);
          if (s) return s;
          dq += d[0];
          dr += d[1];
        }
      }
    }
    return null;
  }

  /** @returns {Vec3|null} spawn position if cell column (q, r) passes `accept` */
  _spawnAt(q, r, accept) {
    const col = this.worldGen.getColumn(q, r);
    if (accept(col)) {
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
   * Note an edited cell for the next flushLight (§62) and fold the write's lazy flag into the batch's.
   * @param {Chunk} chunk
   * @param {number} li
   * @param {boolean|'coalesce'} lazy
   */
  _noteLight(chunk, li, lazy) {
    this.light.noteChange(chunk, li);
    if (lazy !== 'coalesce') this._lightLazy = true;
    else if (this._lightLazy === null) this._lightLazy = 'coalesce';
  }

  /**
   * Mark dirty every loaded chunk containing cell (q, r) or one of its six neighbours: 1 to 4 chunks (4 only for
   * the two index-space corner cells lq=15,lr=0 and lq=0,lr=15, whose neighbours span three other chunks).
   * @param {number} q
   * @param {number} r
   * @param {boolean|'coalesce'} [lazy=false]
   */
  _markDirtyAround(q, r, lazy = false) {
    this._markDirtyCell(q, r, lazy);
    for (let j = 0; j < 6; j++) this._markDirtyCell(q + HEX_DIRS[j][0], r + HEX_DIRS[j][1], lazy);
  }

  /**
   * Non-lazy always wins: a lazy mark never downgrades a chunk that is already dirty non-lazily; likewise a plain lazy
   * write ends a chunk's 'coalesce' wait (§9.2).
   * @param {number} q
   * @param {number} r
   * @param {boolean|'coalesce'} [lazy=false]
   */
  _markDirtyCell(q, r, lazy = false) {
    const chunk = this._byId.get(packId(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)));
    if (chunk === undefined) return;
    this._markChunkDirty(chunk, lazy);
  }

  /**
   * _markDirtyCell's rule for one chunk.
   * @param {Chunk} chunk
   * @param {boolean|'coalesce'} [lazy=false]
   */
  _markChunkDirty(chunk, lazy = false) {
    if (!lazy) {
      chunk.dirty = true;
      chunk.lazy = false;
      chunk.coalesce = false;
    } else if (!chunk.dirty) {
      chunk.dirty = true;
      chunk.lazy = true;
      chunk.coalesce = lazy === 'coalesce';
    } else if (lazy !== 'coalesce') {
      chunk.coalesce = false;
    }
  }

  /**
   * Generate chunk (cq, cr), apply saved edits (recording each cell's generated id as its origin; an edit equal to the
   * generated id is redundant and dropped), register it and fire onChunkGenerated. @returns {Chunk}
   */
  _generate(cq, cr) {
    const data = this.worldGen.generateChunk(cq, cr);
    const chunk = new Chunk(cq, cr, data);
    const chunkEdits = this.edits.get(chunk.key);
    if (chunkEdits !== undefined) {
      const blocks = chunk.blocks;
      let chunkOrigins = this.origins.get(chunk.key);
      if (chunkOrigins === undefined) {
        chunkOrigins = new Map();
        this.origins.set(chunk.key, chunkOrigins);
      }
      for (const [li, id] of chunkEdits) {
        const generated = blocks[li];
        if (generated === id) {
          chunkEdits.delete(li); // deleting the current entry while iterating a Map is safe
          chunkOrigins.delete(li);
          this._editCount--;
          continue;
        }
        chunkOrigins.set(li, generated);
        blocks[li] = id;
      }
      if (chunkEdits.size === 0) this.edits.delete(chunk.key);
      if (chunkOrigins.size === 0) this.origins.delete(chunk.key);
    }
    this.chunks.set(chunk.key, chunk);
    this._byId.set(packId(cq, cr), chunk);
    // Light it (§62): light it hands its loaded neighbours re-meshes the meshed ones, lazily.
    for (const c of this.light.lightChunk(chunk)) {
      if (c !== chunk && c.meshed) this._markChunkDirty(c, true);
    }
    this.onChunkGenerated(cq, cr);
    return chunk;
  }

  /** Build and hand off the mesh of a chunk whose 6 neighbours are loaded. */
  _mesh(chunk) {
    const meshData = buildChunkMesh(chunk.cq, chunk.cr, this.getChunkData);
    chunk.dirty = false;
    chunk.lazy = false;
    chunk.coalesce = false;
    chunk.meshed = true;
    chunk.meshedAt = this._updateCalls;
    this.onChunkMesh(chunk.key, chunk.cq, chunk.cr, meshData);
  }

  /** Drop a chunk from both indices, firing onChunkUnload if it had been meshed. */
  _removeChunk(chunk) {
    this.light.releaseChunk(chunk);
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
