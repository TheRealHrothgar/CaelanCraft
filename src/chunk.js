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
    /** has been handed to the renderer at least once */
    this.meshed = false;
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
