// Caelancraft — procedural terrain: columns, caves, ores and trees. See src/CONTRACTS.md §8. Pure.
//
// Everything here is deterministic for a given seed and never touches Math.random, window,
// document or performance. `getColumn` is the single source of truth for anything that must agree
// across chunk borders (trees, spawn): it depends only on (seed, wx, wz).
//
// Chunk layout (CONTRACTS §0): `localIndex(lx, ly, lz) = (lx * 16 + lz) * 128 + ly`, so a column is
// a contiguous run of WORLD_HEIGHT bytes and can be filled with `Uint8Array.fill(id, from, to)`.
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT,
} from './config.js';
import { floorDiv } from './coords.js';
import { BLOCK, BIOME } from './blocks.js';
import { normalizeSeed, hash2, hash3, rand3, mulberry32, clamp, createNoise } from './noise.js';

/** @typedef {import('./types.js').ChunkData} ChunkData */
/** @typedef {import('./types.js').ColumnInfo} ColumnInfo */
/** @typedef {import('./types.js').WorldGen} WorldGen */

/** Side of the jittered grid cell that holds at most one tree candidate. */
export const TREE_CELL = 6;

/** Probability that a tree cell in the given biome (index = BIOME id) actually grows a tree. */
export const TREE_DENSITY = Object.freeze([0, 0, 0.06, 0.7, 0, 0.06, 0, 0]);

/**
 * @typedef {Object} OreRow
 * @property {number} id        block id placed (replaces STONE only)
 * @property {number} attempts  random walks per chunk
 * @property {number} minY      inclusive origin y range
 * @property {number} maxY
 * @property {number} minSize   inclusive number of walk steps
 * @property {number} maxSize
 */

/** @type {readonly OreRow[]} */
export const ORE_TABLE = Object.freeze([
  Object.freeze({ id: BLOCK.COAL_ORE, attempts: 18, minY: 8, maxY: 100, minSize: 6, maxSize: 10 }),
  Object.freeze({ id: BLOCK.IRON_ORE, attempts: 12, minY: 4, maxY: 60, minSize: 4, maxSize: 8 }),
  Object.freeze({ id: BLOCK.GOLD_ORE, attempts: 3, minY: 4, maxY: 30, minSize: 3, maxSize: 6 }),
  Object.freeze({ id: BLOCK.DIAMOND_ORE, attempts: 1, minY: 2, maxY: 14, minSize: 2, maxSize: 5 }),
  Object.freeze({ id: BLOCK.GRAVEL, attempts: 4, minY: 8, maxY: 70, minSize: 10, maxSize: 16 }),
  Object.freeze({ id: BLOCK.DIRT, attempts: 6, minY: 8, maxY: 90, minSize: 10, maxSize: 16 }),
]);

// Terrain constants from CONTRACTS §8.1 / §8.2.
const SURFACE_DEPTH = 3;            // ocean / beach / snowy / desert filler depth
const SANDSTONE_DEPTH = 3;          // below the desert sand
const OCEAN_SAND_MIN_HEIGHT = 58;   // ocean floor is sand from this height up, gravel below
const CAVE_MIN_Y = 6;
const CAVE_TAPER_TOP = 12;
const CAVE_TOP_MARGIN = 4;          // caves never reach the top 4 terrain blocks
const CAVE_THRESHOLD = 0.12;
const CAVERN_MAX_Y = 45;
const CAVERN_THRESHOLD = 0.55;
const OCEAN_CAVE_MAX_Y = SEA_LEVEL - 12;
const TREE_SALT = 0x7ee5;
const CANOPY_RADIUS = 2;

/**
 * Create a deterministic world generator.
 * @param {string|number|null|undefined} seed  user-facing seed; normalised with `normalizeSeed`
 * @returns {WorldGen}
 */
export function createWorldGen(seed) {
  const s = normalizeSeed(seed);

  // Derived noise seeds, salts 1..8 in contract order.
  const nCont = createNoise(hash3(s, 1, 0, 0));
  const nDetail = createNoise(hash3(s, 2, 0, 0));
  const nMount = createNoise(hash3(s, 3, 0, 0));
  const nTemp = createNoise(hash3(s, 4, 0, 0));
  const nHumid = createNoise(hash3(s, 5, 0, 0));
  const nCaveA = createNoise(hash3(s, 6, 0, 0));
  const nCaveB = createNoise(hash3(s, 7, 0, 0));
  const nCavern = createNoise(hash3(s, 8, 0, 0));

  const treeSeed = s ^ TREE_SALT;

  /**
   * Terrain height / biome / climate of one world column. Pure in (seed, wx, wz).
   * @param {number} wx
   * @param {number} wz
   * @returns {ColumnInfo}
   */
  function getColumn(wx, wz) {
    const c = nCont.fbm2D(wx / 500, wz / 500, 3);
    const d = nDetail.fbm2D(wx / 50, wz / 50, 2);
    const mRaw = nMount.fbm2D(wx / 250, wz / 250, 2);
    const m = clamp((mRaw - 0.25) / 0.75, 0, 1);
    const T = nTemp.fbm2D(wx / 400 + 1000, wz / 400, 2);
    const H = nHumid.fbm2D(wx / 400, wz / 400 + 1000, 2);
    const isDesert = T > 0.35 && H < 0;
    const height = clamp(
      Math.round(66 + c * 14 + d * (isDesert ? 2 : 4) + m * m * 48),
      MIN_TERRAIN_HEIGHT,
      MAX_TERRAIN_HEIGHT,
    );
    let biome;
    if (height <= SEA_LEVEL - 2) biome = BIOME.OCEAN;
    else if (height <= SEA_LEVEL + 2) biome = BIOME.BEACH;
    else if (height >= 92) biome = BIOME.SNOWY_PEAKS;
    else if (height >= 84) biome = BIOME.MOUNTAINS;
    else if (T < -0.35) biome = BIOME.SNOWY;
    else if (isDesert) biome = BIOME.DESERT;
    else if (H > 0.15) biome = BIOME.FOREST;
    else biome = BIOME.PLAINS;
    return { height, biome, temperature: T, humidity: H };
  }

  /**
   * Step 1: terrain column `y = 0..height` plus water, written into the contiguous run starting at
   * `base` (= localIndex(lx, 0, lz)).
   * @param {Uint8Array} blocks
   * @param {number} base
   * @param {number} wx
   * @param {number} wz
   * @param {number} height
   * @param {number} biome
   */
  function fillColumn(blocks, base, wx, wz, height, biome) {
    // Stone core for the whole column; the surface layers overwrite the top of it.
    blocks.fill(BLOCK.STONE, base, base + height + 1);

    switch (biome) {
      case BIOME.OCEAN: {
        const id = height >= OCEAN_SAND_MIN_HEIGHT ? BLOCK.SAND : BLOCK.GRAVEL;
        fillLayer(blocks, base, height - SURFACE_DEPTH, height, id);
        break;
      }
      case BIOME.BEACH:
        fillLayer(blocks, base, height - SURFACE_DEPTH, height, BLOCK.SAND);
        break;
      case BIOME.PLAINS:
      case BIOME.FOREST: {
        const depth = 3 + (hash2(wx, wz, s) & 1);
        fillLayer(blocks, base, height - depth, height - 1, BLOCK.DIRT);
        blocks[base + height] = BLOCK.GRASS_BLOCK;
        break;
      }
      case BIOME.SNOWY:
        fillLayer(blocks, base, height - SURFACE_DEPTH, height - 1, BLOCK.DIRT);
        blocks[base + height] = BLOCK.SNOWY_GRASS;
        break;
      case BIOME.DESERT:
        fillLayer(blocks, base, height - SURFACE_DEPTH - SANDSTONE_DEPTH, height - SURFACE_DEPTH - 1, BLOCK.SANDSTONE);
        fillLayer(blocks, base, height - SURFACE_DEPTH, height, BLOCK.SAND);
        break;
      case BIOME.SNOWY_PEAKS:
        blocks[base + height] = BLOCK.SNOW_BLOCK;
        break;
      case BIOME.MOUNTAINS:
      default:
        // STONE everywhere.
        break;
    }

    // Bedrock floor: solid at y=0, probabilistic at y=1 and y=2. Applied last so it always wins.
    blocks[base] = BLOCK.BEDROCK;
    if (rand3(wx, 1, wz, s) < 0.5) blocks[base + 1] = BLOCK.BEDROCK;
    if (rand3(wx, 2, wz, s) < 0.15) blocks[base + 2] = BLOCK.BEDROCK;

    // Water fills the column above the terrain up to sea level.
    if (height < SEA_LEVEL) blocks.fill(BLOCK.WATER, base + height + 1, base + SEA_LEVEL + 1);
  }

  /**
   * Step 2: carve caves in one column. Reads and writes only that column, so the result is the same
   * whether it runs per column or as a separate pass after all columns are filled.
   * @param {Uint8Array} blocks
   * @param {number} base
   * @param {number} wx
   * @param {number} wz
   * @param {number} height
   * @param {number} biome
   */
  function carveColumn(blocks, base, wx, wz, height, biome) {
    let yMax = height - CAVE_TOP_MARGIN;
    if ((biome === BIOME.OCEAN || biome === BIOME.BEACH) && yMax > OCEAN_CAVE_MAX_Y) yMax = OCEAN_CAVE_MAX_Y;
    const ax = wx / 40;
    const az = wz / 40;
    const bx = ax + 300;
    const bz = az - 300;
    const vx = wx / 70;
    const vz = wz / 70;
    for (let y = CAVE_MIN_Y; y <= yMax; y++) {
      const i = base + y;
      if (blocks[i] === BLOCK.BEDROCK) continue;
      let carve = false;
      // Spaghetti tunnels: the intersection of two thin noise shells, tapered shut near the floor.
      const th = y < CAVE_TAPER_TOP ? CAVE_THRESHOLD * ((y - CAVE_MIN_Y) / (CAVE_TAPER_TOP - CAVE_MIN_Y)) : CAVE_THRESHOLD;
      if (th > 0) {
        const a = nCaveA.noise3D(ax, y / 28, az);
        if (a < th && a > -th) {
          const b = nCaveB.noise3D(bx, y / 28, bz);
          if (b < th && b > -th) carve = true;
        }
      }
      // Cheese caverns in the deep.
      if (!carve && y < CAVERN_MAX_Y && nCavern.fbm3D(vx, y / 50, vz, 2) > CAVERN_THRESHOLD) carve = true;
      if (carve) blocks[i] = BLOCK.AIR;
    }
  }

  /**
   * Step 3: ore veins as seeded random walks that replace STONE only.
   * @param {Uint8Array} blocks
   * @param {number} cx
   * @param {number} cz
   */
  function placeOres(blocks, cx, cz) {
    for (let oi = 0; oi < ORE_TABLE.length; oi++) {
      const o = ORE_TABLE[oi];
      for (let i = 0; i < o.attempts; i++) {
        const rng = mulberry32(hash3(cx, cz, oi * 1000 + i, s));
        let x = Math.floor(rng() * CHUNK_SIZE);
        let z = Math.floor(rng() * CHUNK_SIZE);
        let y = o.minY + Math.floor(rng() * (o.maxY - o.minY + 1));
        const size = o.minSize + Math.floor(rng() * (o.maxSize - o.minSize + 1));
        placeOreCell(blocks, x, y, z, o.id);
        for (let step = 0; step < size; step++) {
          const axis = Math.floor(rng() * 3);
          const dir = rng() < 0.5 ? -1 : 1;
          if (axis === 0) x += dir;
          else if (axis === 1) y += dir;
          else z += dir;
          placeOreCell(blocks, x, y, z, o.id);
        }
      }
    }
  }

  /**
   * Step 4: trees from the jittered TREE_CELL grid. Only cells inside this chunk are written; the
   * decision whether a tree exists depends solely on getColumn, so neighbouring chunks agree.
   * @param {Uint8Array} blocks
   * @param {number} cx
   * @param {number} cz
   */
  function placeTrees(blocks, cx, cz) {
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const kx0 = floorDiv(ox - 3, TREE_CELL);
    const kx1 = floorDiv(ox + CHUNK_SIZE + 2, TREE_CELL);
    const kz0 = floorDiv(oz - 3, TREE_CELL);
    const kz1 = floorDiv(oz + CHUNK_SIZE + 2, TREE_CELL);
    for (let kx = kx0; kx <= kx1; kx++) {
      for (let kz = kz0; kz <= kz1; kz++) {
        const hsh = hash2(kx, kz, treeSeed);
        const tx = kx * TREE_CELL + 1 + (hsh & 3);
        const tz = kz * TREE_CELL + 1 + ((hsh >>> 2) & 3);
        const lx0 = tx - ox;
        const lz0 = tz - oz;
        // A tree only touches this chunk when its canopy overlaps it; skip the noise work otherwise.
        if (lx0 < -CANOPY_RADIUS || lx0 >= CHUNK_SIZE + CANOPY_RADIUS ||
            lz0 < -CANOPY_RADIUS || lz0 >= CHUNK_SIZE + CANOPY_RADIUS) continue;
        const trunk = 4 + ((hsh >>> 4) % 3);
        const roll = ((hsh >>> 8) & 0xffff) / 65536;
        const col = getColumn(tx, tz);
        if (!(roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT)) {
          continue;
        }
        stampTree(blocks, lx0, lz0, col.height + 1, col.height + trunk);
      }
    }
  }

  /**
   * @param {number} cx
   * @param {number} cz
   * @returns {ChunkData} fresh arrays
   */
  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_AREA);
    const heights = new Uint8Array(CHUNK_AREA);
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    // Steps 1 and 2 are column-local, so they share one pass over the columns for cache locality.
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = ox + lx;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wz = oz + lz;
        const ci = lx * CHUNK_SIZE + lz;          // columnIndex(lx, lz)
        const base = ci * WORLD_HEIGHT;           // localIndex(lx, 0, lz)
        const col = getColumn(wx, wz);
        heights[ci] = col.height;
        biomes[ci] = col.biome;
        fillColumn(blocks, base, wx, wz, col.height, col.biome);
        carveColumn(blocks, base, wx, wz, col.height, col.biome);
      }
    }

    placeOres(blocks, cx, cz);
    placeTrees(blocks, cx, cz);

    return { blocks, biomes, heights };
  }

  return { seed: s, getColumn, generateChunk };
}

/**
 * Fill `y = yLo..yHi` (inclusive, clamped to the column) of the column starting at `base`.
 * @param {Uint8Array} blocks
 * @param {number} base
 * @param {number} yLo
 * @param {number} yHi
 * @param {number} id
 */
function fillLayer(blocks, base, yLo, yHi, id) {
  if (yLo < 0) yLo = 0;
  if (yHi >= WORLD_HEIGHT) yHi = WORLD_HEIGHT - 1;
  if (yHi < yLo) return;
  blocks.fill(id, base + yLo, base + yHi + 1);
}

/**
 * Replace STONE with `id` at a local cell when the cell lies inside the chunk.
 * @param {Uint8Array} blocks
 * @param {number} x local
 * @param {number} y
 * @param {number} z local
 * @param {number} id
 */
function placeOreCell(blocks, x, y, z, id) {
  if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
  const i = (x * CHUNK_SIZE + z) * WORLD_HEIGHT + y;
  if (blocks[i] === BLOCK.STONE) blocks[i] = id;
}

/**
 * Put OAK_LEAVES at a cell if (and only if) it is AIR.
 * @param {Uint8Array} blocks
 * @param {number} i local index
 */
function leaf(blocks, i) {
  if (blocks[i] === BLOCK.AIR) blocks[i] = BLOCK.OAK_LEAVES;
}

/**
 * Stamp one oak tree whose trunk is at chunk-local (lx0, lz0) — possibly outside 0..15 — writing
 * only the cells that fall inside this chunk. Logs overwrite anything; leaves fill AIR only, so the
 * result is independent of the order in which overlapping trees are stamped.
 * @param {Uint8Array} blocks
 * @param {number} lx0
 * @param {number} lz0
 * @param {number} base  first log y (terrain height + 1)
 * @param {number} top   last log y; leaves occupy top-1 .. top+2 (top+2 < WORLD_HEIGHT guaranteed by caller)
 */
function stampTree(blocks, lx0, lz0, base, top) {
  if (lx0 >= 0 && lx0 < CHUNK_SIZE && lz0 >= 0 && lz0 < CHUNK_SIZE) {
    const col = (lx0 * CHUNK_SIZE + lz0) * WORLD_HEIGHT;
    blocks.fill(BLOCK.OAK_LOG, col + base, col + top + 1);
  }
  for (let dx = -CANOPY_RADIUS; dx <= CANOPY_RADIUS; dx++) {
    const lx = lx0 + dx;
    if (lx < 0 || lx >= CHUNK_SIZE) continue;
    const adx = dx < 0 ? -dx : dx;
    for (let dz = -CANOPY_RADIUS; dz <= CANOPY_RADIUS; dz++) {
      const lz = lz0 + dz;
      if (lz < 0 || lz >= CHUNK_SIZE) continue;
      const adz = dz < 0 ? -dz : dz;
      const col = (lx * CHUNK_SIZE + lz) * WORLD_HEIGHT;
      // Two wide layers (5x5 minus corners) at top-1 and top.
      if (!(adx === 2 && adz === 2)) {
        leaf(blocks, col + top - 1);
        leaf(blocks, col + top);
      }
      // 3x3 at top+1.
      if (adx <= 1 && adz <= 1) leaf(blocks, col + top + 1);
      // Plus shape at top+2.
      if (adx + adz <= 1) leaf(blocks, col + top + 2);
    }
  }
}
