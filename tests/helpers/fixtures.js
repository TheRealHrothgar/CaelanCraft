// Shared test fixtures. See src/CONTRACTS.md §24.
import { CHUNK_AREA, CHUNK_VOLUME, CHUNK_SIZE, WORLD_HEIGHT } from '../../src/config.js';
import { chunkKey, localIndex, columnIndex } from '../../src/coords.js';
import { BLOCK, BIOME } from '../../src/blocks.js';

/**
 * getBlock over a Map keyed "q,y,r" → id (axial q, height y, axial r). Unknown cells return `fill`.
 * @param {Map<string, number>|Record<string, number>} map
 */
export function makeGetBlock(map, fill = BLOCK.AIR) {
  const m = map instanceof Map ? map : new Map(Object.entries(map));
  return (q, y, r) => {
    if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    const v = m.get(`${q},${y},${r}`);
    return v === undefined ? fill : v;
  };
}

/** Zeroed ChunkData. */
export function makeChunkData() {
  return {
    blocks: new Uint8Array(CHUNK_VOLUME),
    biomes: new Uint8Array(CHUNK_AREA),
    heights: new Uint8Array(CHUNK_AREA),
  };
}

/**
 * getChunkData over a Map keyed chunkKey → ChunkData (or Chunk). Missing → null.
 * @param {Map<string, any>} chunks
 */
export function makeChunkDataGetter(chunks) {
  return (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null;
}

/** Convenience: set a block in a Map<chunkKey, ChunkData> by CELL coords (q, y, r), creating chunks on demand. */
export function setWorldBlock(chunks, q, y, r, id) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const key = chunkKey(cq, cr);
  let c = chunks.get(key);
  if (!c) {
    c = makeChunkData();
    chunks.set(key, c);
  }
  c.blocks[localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE)] = id;
}

/** isSolidAt for an infinite flat floor: solid iff y <= groundY. */
export function flatIsSolid(groundY) {
  return (_q, y, _r) => y <= groundY;
}

/** getBlock for an infinite flat floor of `id` up to groundY (inclusive), AIR above. */
export function flatGetBlock(groundY, id = BLOCK.STONE) {
  return (_q, y, _r) => (y >= 0 && y <= groundY ? id : BLOCK.AIR);
}

/** Total faces (side quads and hexagonal caps alike) across all non-null layers of a ChunkMeshData. */
export function countFaces(chunkMesh) {
  let n = 0;
  for (const layer of [chunkMesh.opaque, chunkMesh.cutout, chunkMesh.translucent]) {
    if (layer) n += layer.faceCount;
  }
  return n;
}

/** A WorldGen that produces all-AIR chunks (heights 0, biome PLAINS); getColumn reports height 0. */
export function trivialWorldGen(seed = 1) {
  return {
    seed,
    getColumn: () => ({ height: 0, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
    generateChunk: () => {
      const d = makeChunkData();
      d.biomes.fill(BIOME.PLAINS);
      return d;
    },
  };
}

/** A WorldGen producing a flat world: `id` for 0..groundY, AIR above, everywhere. */
export function flatWorldGen(groundY, id = BLOCK.STONE, seed = 1) {
  return {
    seed,
    getColumn: () => ({ height: groundY, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
    generateChunk: () => {
      const d = makeChunkData();
      d.biomes.fill(BIOME.PLAINS);
      d.heights.fill(groundY);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const base = localIndex(lq, 0, lr);
          d.blocks.fill(id, base, base + groundY + 1);
          void columnIndex;
        }
      }
      return d;
    },
  };
}
