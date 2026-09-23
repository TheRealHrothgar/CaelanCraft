// Shared test fixtures. See src/CONTRACTS.md §24.
import { CHUNK_AREA, CHUNK_VOLUME, CHUNK_SIZE, WORLD_HEIGHT } from '../../src/config.js';
import { chunkKey, localIndex, columnIndex } from '../../src/coords.js';
import { BLOCK, BIOME } from '../../src/blocks.js';

/**
 * getBlock over a Map keyed "x,y,z" → id. Unknown cells return `fill`.
 * @param {Map<string, number>|Record<string, number>} map
 */
export function makeGetBlock(map, fill = BLOCK.AIR) {
  const m = map instanceof Map ? map : new Map(Object.entries(map));
  return (x, y, z) => {
    if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    const v = m.get(`${x},${y},${z}`);
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

/** Convenience: set a block in a Map<chunkKey, ChunkData> by WORLD coords, creating chunks on demand. */
export function setWorldBlock(chunks, wx, wy, wz, id) {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cz = Math.floor(wz / CHUNK_SIZE);
  const key = chunkKey(cx, cz);
  let c = chunks.get(key);
  if (!c) {
    c = makeChunkData();
    chunks.set(key, c);
  }
  c.blocks[localIndex(wx - cx * CHUNK_SIZE, wy, wz - cz * CHUNK_SIZE)] = id;
}

/** isSolidAt for an infinite flat floor: solid iff y <= groundY. */
export function flatIsSolid(groundY) {
  return (_x, y, _z) => y <= groundY;
}

/** getBlock for an infinite flat floor of `id` up to groundY (inclusive), AIR above. */
export function flatGetBlock(groundY, id = BLOCK.STONE) {
  return (_x, y, _z) => (y >= 0 && y <= groundY ? id : BLOCK.AIR);
}

/** Total faces across all non-null layers of a ChunkMeshData. */
export function countFaces(chunkMesh) {
  let n = 0;
  for (const layer of [chunkMesh.opaque, chunkMesh.cutout, chunkMesh.translucent]) {
    if (layer) n += layer.indices.length / 6;
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
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const base = localIndex(lx, 0, lz);
          d.blocks.fill(id, base, base + groundY + 1);
          void columnIndex;
        }
      }
      return d;
    },
  };
}
