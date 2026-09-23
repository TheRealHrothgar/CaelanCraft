// Caelancraft — Chunk container. See src/CONTRACTS.md §6. Pure.
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME } from './config.js';
import { chunkKey, localIndex } from './coords.js';

/** @typedef {import('./types.js').ChunkData} ChunkData */

export class Chunk {
  /**
   * @param {number} cx
   * @param {number} cz
   * @param {ChunkData} [data]  arrays are adopted (not copied); missing → zero-filled
   */
  constructor(cx, cz, data) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = data?.blocks ?? new Uint8Array(CHUNK_VOLUME);
    this.biomes = data?.biomes ?? new Uint8Array(CHUNK_AREA);
    this.heights = data?.heights ?? new Uint8Array(CHUNK_AREA);
    /** needs (re)meshing */
    this.dirty = true;
    /** has been handed to the renderer at least once */
    this.meshed = false;
  }

  /** @returns {number} block id, or AIR (0) when out of range */
  get(lx, ly, lz) {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || ly < 0 || ly >= WORLD_HEIGHT) return 0;
    return this.blocks[localIndex(lx, ly, lz)];
  }

  /** @returns {boolean} true iff the stored value changed (then dirty = true); false when out of range */
  set(lx, ly, lz, id) {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || ly < 0 || ly >= WORLD_HEIGHT) return false;
    const i = localIndex(lx, ly, lz);
    if (this.blocks[i] === id) return false;
    this.blocks[i] = id;
    this.dirty = true;
    return true;
  }
}
