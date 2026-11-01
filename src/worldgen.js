// Caelancraft — procedural terrain: columns, caves, ores and trees. See src/CONTRACTS.md §8. Pure.
//
// Everything here is deterministic for a given seed and never touches Math.random, window,
// document or performance. `getColumn` is the single source of truth for anything that must agree
// across chunk borders (trees, spawn): it depends only on (seed, q, r).
//
// Cells are hexagonal prisms addressed by axial (q, r). Continuous noise is always sampled at the cell's
// WORLD position (hex.hexToWorld) so terrain, climate and caves are isotropic rather than sheared along
// the axial axes; discrete hashes (bedrock, dirt depth, ores, trees) use the integer cell coordinates.
//
// Chunk layout (CONTRACTS §0): `localIndex(lq, ly, lr) = (lq * 16 + lr) * 128 + ly`, so a column is
// a contiguous run of WORLD_HEIGHT bytes and can be filled with `Uint8Array.fill(id, from, to)`.
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT,
} from './config.js';
import { floorDiv } from './coords.js';
import { HEX_DIRS, hexToWorld, hexLength } from './hex.js';
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
/** Side faces whose neighbours carry the topmost leaf layer (T+2) besides the trunk column. */
const CROWN_DIRS = Object.freeze([0, 2, 4]);

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
   * Terrain height / biome / climate of one cell column. Pure in (seed, q, r); noise is sampled at the
   * cell's world position so the terrain is isotropic.
   * @param {number} q
   * @param {number} r
   * @returns {ColumnInfo}
   */
  function getColumn(q, r) {
    const [wx, wz] = hexToWorld(q, r);
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
   * @param {number} q
   * @param {number} r
   * @param {number} height
   * @param {number} biome
   */
  function fillColumn(blocks, base, q, r, height, biome) {
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
        const depth = 3 + (hash2(q, r, s) & 1);
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
    if (rand3(q, 1, r, s) < 0.5) blocks[base + 1] = BLOCK.BEDROCK;
    if (rand3(q, 2, r, s) < 0.15) blocks[base + 2] = BLOCK.BEDROCK;

    // Water fills the column above the terrain up to sea level.
    if (height < SEA_LEVEL) blocks.fill(BLOCK.WATER, base + height + 1, base + SEA_LEVEL + 1);
  }

  /**
   * Step 2: carve caves in one column. Reads and writes only that column, so the result is the same
   * whether it runs per column or as a separate pass after all columns are filled.
   * @param {Uint8Array} blocks
   * @param {number} base
   * @param {number} wx  world x of the cell centre
   * @param {number} wz  world z of the cell centre
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
   * Step 3: ore veins as seeded random walks over the 8 cell neighbours (6 sides, up, down) that replace
   * STONE only.
   * @param {Uint8Array} blocks
   * @param {number} cq
   * @param {number} cr
   */
  function placeOres(blocks, cq, cr) {
    for (let oi = 0; oi < ORE_TABLE.length; oi++) {
      const o = ORE_TABLE[oi];
      for (let i = 0; i < o.attempts; i++) {
        const rng = mulberry32(hash3(cq, cr, oi * 1000 + i, s));
        let lq = Math.floor(rng() * CHUNK_SIZE);
        let lr = Math.floor(rng() * CHUNK_SIZE);
        let y = o.minY + Math.floor(rng() * (o.maxY - o.minY + 1));
        const size = o.minSize + Math.floor(rng() * (o.maxSize - o.minSize + 1));
        placeOreCell(blocks, lq, y, lr, o.id);
        for (let step = 0; step < size; step++) {
          const dir = Math.floor(rng() * 8);
          if (dir === 6) y += 1;
          else if (dir === 7) y -= 1;
          else {
            lq += HEX_DIRS[dir][0];
            lr += HEX_DIRS[dir][1];
          }
          placeOreCell(blocks, lq, y, lr, o.id);
        }
      }
    }
  }

  /**
   * Step 4: trees from the jittered TREE_CELL grid in (q, r) index space. Only cells inside this chunk are
   * written; the decision whether a tree exists depends solely on getColumn, so neighbouring chunks agree.
   * @param {Uint8Array} blocks
   * @param {number} cq
   * @param {number} cr
   */
  function placeTrees(blocks, cq, cr) {
    const oq = cq * CHUNK_SIZE;
    const or = cr * CHUNK_SIZE;
    const kq0 = floorDiv(oq - 3, TREE_CELL);
    const kq1 = floorDiv(oq + CHUNK_SIZE + 2, TREE_CELL);
    const kr0 = floorDiv(or - 3, TREE_CELL);
    const kr1 = floorDiv(or + CHUNK_SIZE + 2, TREE_CELL);
    for (let kq = kq0; kq <= kq1; kq++) {
      for (let kr = kr0; kr <= kr1; kr++) {
        const hsh = hash2(kq, kr, treeSeed);
        const tq = kq * TREE_CELL + 1 + (hsh & 3);
        const tr = kr * TREE_CELL + 1 + ((hsh >>> 2) & 3);
        const lq0 = tq - oq;
        const lr0 = tr - or;
        // A tree only touches this chunk when its canopy overlaps it; skip the noise work otherwise.
        if (lq0 < -CANOPY_RADIUS || lq0 >= CHUNK_SIZE + CANOPY_RADIUS ||
            lr0 < -CANOPY_RADIUS || lr0 >= CHUNK_SIZE + CANOPY_RADIUS) continue;
        const trunk = 4 + ((hsh >>> 4) % 3);
        const roll = ((hsh >>> 8) & 0xffff) / 65536;
        const col = getColumn(tq, tr);
        if (!(roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT)) {
          continue;
        }
        stampTree(blocks, lq0, lr0, col.height + 1, col.height + trunk);
      }
    }
  }

  /**
   * @param {number} cq
   * @param {number} cr
   * @returns {ChunkData} fresh arrays
   */
  function generateChunk(cq, cr) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_AREA);
    const heights = new Uint8Array(CHUNK_AREA);
    const oq = cq * CHUNK_SIZE;
    const or = cr * CHUNK_SIZE;

    // Steps 1 and 2 are column-local, so they share one pass over the columns for cache locality.
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      const q = oq + lq;
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const r = or + lr;
        const ci = lq * CHUNK_SIZE + lr;          // columnIndex(lq, lr)
        const base = ci * WORLD_HEIGHT;           // localIndex(lq, 0, lr)
        const col = getColumn(q, r);
        const [wx, wz] = hexToWorld(q, r);
        heights[ci] = col.height;
        biomes[ci] = col.biome;
        fillColumn(blocks, base, q, r, col.height, col.biome);
        carveColumn(blocks, base, wx, wz, col.height, col.biome);
      }
    }

    placeOres(blocks, cq, cr);
    placeTrees(blocks, cq, cr);

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
 * @param {number} lq local
 * @param {number} y
 * @param {number} lr local
 * @param {number} id
 */
function placeOreCell(blocks, lq, y, lr, id) {
  if (lq < 0 || lq >= CHUNK_SIZE || lr < 0 || lr >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
  const i = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y;
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
 * Stamp one oak tree whose trunk is at chunk-local (lq0, lr0) — possibly outside 0..15 — writing
 * only the cells that fall inside this chunk. Logs overwrite anything; leaves fill AIR only, so the
 * result is independent of the order in which overlapping trees are stamped.
 *
 * Canopy (hex distance d from the trunk): y ∈ {top−1, top}: d ≤ 1 plus the six ring-2 cells that are
 * not ring corners (13 cells); y = top+1: d ≤ 1 (7 cells); y = top+2: the trunk column plus the
 * neighbours across side faces CROWN_DIRS (4 cells).
 * @param {Uint8Array} blocks
 * @param {number} lq0
 * @param {number} lr0
 * @param {number} base  first log y (terrain height + 1)
 * @param {number} top   last log y; leaves occupy top-1 .. top+2 (top+2 < WORLD_HEIGHT guaranteed by caller)
 */
function stampTree(blocks, lq0, lr0, base, top) {
  if (lq0 >= 0 && lq0 < CHUNK_SIZE && lr0 >= 0 && lr0 < CHUNK_SIZE) {
    const col = (lq0 * CHUNK_SIZE + lr0) * WORLD_HEIGHT;
    blocks.fill(BLOCK.OAK_LOG, col + base, col + top + 1);
  }
  for (let dq = -CANOPY_RADIUS; dq <= CANOPY_RADIUS; dq++) {
    const lq = lq0 + dq;
    if (lq < 0 || lq >= CHUNK_SIZE) continue;
    for (let dr = -CANOPY_RADIUS; dr <= CANOPY_RADIUS; dr++) {
      const lr = lr0 + dr;
      if (lr < 0 || lr >= CHUNK_SIZE) continue;
      const d = hexLength(dq, dr);
      if (d > CANOPY_RADIUS) continue;
      const col = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT;
      // Ring-2 corners are the cells at twice a side direction: one axial component is 0 or they sum to 0.
      const isCorner = d === 2 && (dq === 0 || dr === 0 || dq + dr === 0);
      if (!isCorner) {
        leaf(blocks, col + top - 1);
        leaf(blocks, col + top);
      }
      if (d <= 1) leaf(blocks, col + top + 1);
      if (d === 0 || isCrownCell(dq, dr)) leaf(blocks, col + top + 2);
    }
  }
}

/** @returns {boolean} (dq, dr) is the neighbour across one of CROWN_DIRS */
function isCrownCell(dq, dr) {
  for (let i = 0; i < CROWN_DIRS.length; i++) {
    const d = HEX_DIRS[CROWN_DIRS[i]];
    if (d[0] === dq && d[1] === dr) return true;
  }
  return false;
}
