// Caelancraft — Chunk container. See src/CONTRACTS.md §6. Pure.
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME } from './config.js';
import { chunkKey, localIndex } from './coords.js';

/** @typedef {import('./types.js').ChunkData} ChunkData */

export class Chunk {
  /**
   * @param {number} cq  chunk coordinate along q
   * @param {number} cr  chunk coordinate along r
   * @param {ChunkData} [data]  arrays are adopted (not copied); missing → zero-filled
   */
  constructor(cq, cr, data) {
    this.cq = cq;
    this.cr = cr;
    this.key = chunkKey(cq, cr);
    this.blocks = data?.blocks ?? new Uint8Array(CHUNK_VOLUME);
    this.biomes = data?.biomes ?? new Uint8Array(CHUNK_AREA);
    this.heights = data?.heights ?? new Uint8Array(CHUNK_AREA);
    /** needs (re)meshing */
    this.dirty = true;
    /** dirty only through lazy (physics) writes: World.update re-meshes it under LAZY_MESH_BUDGET_MS (CONTRACTS §9.2) */
    this.lazy = false;
    /** dirty only through 'coalesce' writes: re-meshed at most every LAZY_COALESCE_UPDATES update() calls (§9.2) */
    this.coalesce = false;
    /** World.update call count when it was last meshed (−Infinity: never) */
    this.meshedAt = -Infinity;
    /** has been handed to the renderer at least once */
    this.meshed = false;
    /**
     * Light levels (§62), indexed like `blocks`: one byte per cell, sky << 4 | block. Null until World lights the chunk
     * (light.js LightEngine.lightChunk); the mesher reads a missing array as open sky.
     * @type {Uint8Array|null}
     */
    this.light = null;
    /**
     * Per column (columnIndex): the lowest y of the unbroken sky-15 run from the top (light.js); null until lit.
     * @type {Uint8Array|null}
     */
    this.lightTop = null;
    /** light.js bookkeeping: the engine slot naming this chunk in its flood queues (−1: not lit) */
    this.lightSlot = -1;
  }

  /** @returns {number} block id, or AIR (0) when out of range */
  get(lq, ly, lr) {
    if (lq < 0 || lq >= CHUNK_SIZE || lr < 0 || lr >= CHUNK_SIZE || ly < 0 || ly >= WORLD_HEIGHT) return 0;
    return this.blocks[localIndex(lq, ly, lr)];
  }

  /** @returns {boolean} true iff the stored value changed (then dirty = true); false when out of range */
  set(lq, ly, lr, id) {
    if (lq < 0 || lq >= CHUNK_SIZE || lr < 0 || lr >= CHUNK_SIZE || ly < 0 || ly >= WORLD_HEIGHT) return false;
    const i = localIndex(lq, ly, lr);
    if (this.blocks[i] === id) return false;
    this.blocks[i] = id;
    this.dirty = true;
    return true;
  }
}
