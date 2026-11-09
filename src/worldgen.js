// Caelancraft — procedural terrain: columns, caves, ores and trees. See src/CONTRACTS.md §8. Pure.
//
// Everything here is deterministic for a given seed and never touches Math.random, window,
// document or performance. `getColumn` is the single source of truth for anything that must agree
// across chunk borders (trees, spawn, ponds, flora): it depends only on (seed, q, r).
//
// Generation 2 (docs/DESIGN-survival.md §8.3–§8.4, `createWorldGen(seed, { gen: 2 })`) adds the survival
// resources, in this order inside generateChunk: copper / tin / clay veins (ORE_TABLE_GEN2, appended after the six
// gen-1 rows so every gen-1 vein keeps its rng stream), hex ponds (before the trees), tree species (spruce in SNOWY,
// some birch in FOREST) and the surface pass `placeFlora` (FLORA_TABLE: gravel tops, loose stones, fallen branches and
// the wild plants). With `gen: 1` (the default) the output is byte-identical to the generator before v0.9.
//
// Cells are hexagonal prisms addressed by axial (q, r). Continuous noise is always sampled at the cell's
// WORLD position (hex.hexToWorld) so terrain, climate and caves are isotropic rather than sheared along
// the axial axes; discrete hashes (bedrock, dirt depth, ores, trees) use the integer cell coordinates.
//
// Chunk layout (CONTRACTS §0): `localIndex(lq, ly, lr) = (lq * 16 + lr) * 128 + ly`, so a column is
// a contiguous run of WORLD_HEIGHT bytes and can be filled with `Uint8Array.fill(id, from, to)`.
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT, GEN_LATEST,
} from './config.js';
import { floorDiv } from './coords.js';
import { HEX_DIRS, hexToWorld, hexLength } from './hex.js';
import { BLOCK, BIOME } from './blocks.js';
import { normalizeSeed, hash2, hash3, rand3, mulberry32, clamp, createNoise } from './noise.js';

/** @typedef {import('./types.js').ChunkData} ChunkData */
/** @typedef {import('./types.js').ColumnInfo} ColumnInfo */
/** @typedef {import('./types.js').WorldGen} WorldGen */

/**
 * A trunk accepted by `treeTrunkAt` (the gen-1 acceptance test) with its species: always 'oak' in generation 1.
 * @typedef {Object} TreeTrunk
 * @property {number} tq       trunk column
 * @property {number} tr
 * @property {number} height   terrain height of the trunk column (the first log is at height + 1)
 * @property {number} trunk    log count (4–6)
 * @property {number} biome
 * @property {'oak'|'spruce'|'birch'} species
 */

/**
 * An accepted hex pond (§8.4): its centre, its water level H and the centre biome.
 * @typedef {{ q: number, r: number, H: number, biome: number }} Pond
 */

/**
 * The generator handed out by createWorldGen: the CONTRACTS §8 WorldGen plus the generation-2 surface (§10 package A).
 * @typedef {WorldGen & {
 *   gen: number,
 *   pondAt: (q: number, r: number) => boolean,
 *   treeTrunkAt: (kq: number, kr: number) => TreeTrunk|null,
 *   FLORA_TABLE: typeof FLORA_TABLE,
 * }} SurvivalWorldGen
 */

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

/**
 * Generation-2 vein rows (§8.3 step 1), run after ORE_TABLE with `oi` continuing at 6, 7, 8 so every gen-1 vein keeps
 * its rng stream. `replaces` lists the ids a walk may overwrite (default STONE): copper sits high enough to show in
 * cliffs, tin is rarer and deeper, clay sits under coasts and ponds (sand, gravel and dirt).
 * @type {readonly (OreRow & { replaces?: readonly number[] })[]}
 */
export const ORE_TABLE_GEN2 = Object.freeze([
  Object.freeze({ id: BLOCK.COPPER_ORE, attempts: 10, minY: 30, maxY: 80, minSize: 4, maxSize: 8 }),
  Object.freeze({ id: BLOCK.TIN_ORE, attempts: 4, minY: 20, maxY: 64, minSize: 3, maxSize: 6 }),
  Object.freeze({
    id: BLOCK.CLAY, attempts: 3, minY: 52, maxY: 62, minSize: 6, maxSize: 12,
    replaces: Object.freeze([BLOCK.SAND, BLOCK.GRAVEL, BLOCK.DIRT]),
  }),
]);

/** Pond grid (§8.4): one candidate per POND_CELL × POND_CELL cell of (q, r) index space, jittered by 0–7. */
export const POND_CELL = 20;
/** Salt of the pond hashes: `hash2(kq, kr, seed ^ POND_SALT)` for the candidate, `hash3(q, r, POND_SALT, seed)` for the rim. */
export const POND_SALT = 0x90d5;
/** Salt of the flora roll `rand3(q, r, FLORA_SALT, seed)` (§8.3 step 4). */
export const FLORA_SALT = 0xf107a;
/**
 * Biomes a pond may lie in (its centre and every column within hex distance 2).
 * @type {readonly number[]}
 */
const POND_BIOMES = Object.freeze([BIOME.PLAINS, BIOME.FOREST, BIOME.SNOWY]);

/**
 * One row of the surface pass. `top` rows replace the surface block itself (gravel tops: shingle, scree, till); the
 * others stand on it at height + 1. `minHeight` / `maxHeight` / `besideBelow` (beach cattails) further require the
 * column height in minHeight..maxHeight and a side neighbour whose height is below `besideBelow`; when they fail, the
 * row's slice of the roll places nothing.
 * @typedef {Object} FloraRow
 * @property {number} id
 * @property {number} chance       this row's share of the one roll (the rows are cumulative, left to right)
 * @property {boolean} [top]
 * @property {number} [minHeight]
 * @property {number} [maxHeight]
 * @property {number} [besideBelow]
 */
/**
 * @typedef {Object} FloraBiome
 * @property {number} surface            the generated top block a column must have (with AIR above) to take flora
 * @property {readonly FloraRow[]} rows
 */

/** @returns {Readonly<FloraRow>} */
function floraRow(id, chance, extra = {}) {
  return Object.freeze({ id, chance, ...extra });
}

/**
 * The surface pass (§8.3 step 4), indexed by BIOME id (null: nothing grows). One roll `u = rand3(q, r, FLORA_SALT, s)`
 * per eligible column is compared with the cumulative chances, left to right. A PLAINS or FOREST column has about 6–7
 * flint, expected, within hex distance 20 (loose stones × the 0.5 flint chance).
 * @type {readonly (Readonly<FloraBiome>|null)[]}
 */
export const FLORA_TABLE = Object.freeze([
  /* OCEAN */ null,
  /* BEACH */ Object.freeze({
    surface: BLOCK.SAND,
    rows: Object.freeze([
      floraRow(BLOCK.GRAVEL, 0.12, { top: true }), // shingle
      floraRow(BLOCK.LOOSE_STONES, 0.06),
      floraRow(BLOCK.CATTAILS, 0.03, { minHeight: SEA_LEVEL, maxHeight: SEA_LEVEL + 1, besideBelow: SEA_LEVEL }),
    ]),
  }),
  /* PLAINS */ Object.freeze({
    surface: BLOCK.GRASS_BLOCK,
    rows: Object.freeze([
      floraRow(BLOCK.GRAVEL, 0.015, { top: true }),
      floraRow(BLOCK.LOOSE_STONES, 0.012),
      floraRow(BLOCK.FALLEN_BRANCHES, 0.005),
      floraRow(BLOCK.TUSSOCK, 0.06),
      floraRow(BLOCK.TUBER_PLANT, 0.008),
      floraRow(BLOCK.HONEYBERRY_BUSH, 0.006),
    ]),
  }),
  /* FOREST */ Object.freeze({
    surface: BLOCK.GRASS_BLOCK,
    rows: Object.freeze([
      floraRow(BLOCK.GRAVEL, 0.02, { top: true }),
      floraRow(BLOCK.LOOSE_STONES, 0.01),
      floraRow(BLOCK.FALLEN_BRANCHES, 0.04),
      floraRow(BLOCK.TUSSOCK, 0.03),
      floraRow(BLOCK.TUBER_PLANT, 0.004),
      floraRow(BLOCK.HONEYBERRY_BUSH, 0.02),
    ]),
  }),
  /* DESERT */ Object.freeze({
    surface: BLOCK.SAND,
    rows: Object.freeze([
      floraRow(BLOCK.LOOSE_STONES, 0.01),
      floraRow(BLOCK.PRICKLY_PEAR, 0.008),
    ]),
  }),
  /* SNOWY */ Object.freeze({
    surface: BLOCK.SNOWY_GRASS,
    rows: Object.freeze([
      floraRow(BLOCK.GRAVEL, 0.02, { top: true }), // till
      floraRow(BLOCK.LOOSE_STONES, 0.02),
      floraRow(BLOCK.FALLEN_BRANCHES, 0.015),
      floraRow(BLOCK.TUSSOCK, 0.02),
      floraRow(BLOCK.HONEYBERRY_BUSH, 0.005),
    ]),
  }),
  /* MOUNTAINS */ Object.freeze({
    surface: BLOCK.STONE,
    rows: Object.freeze([
      floraRow(BLOCK.GRAVEL, 0.06, { top: true }), // scree
      floraRow(BLOCK.LOOSE_STONES, 0.05),
    ]),
  }),
  /* SNOWY_PEAKS */ null,
]);

/** Hex offsets at distance 1..2 from a centre (the 18 columns a pond checks besides its centre). */
const DISC2_RING = Object.freeze((() => {
  const out = [];
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      const d = hexLength(dq, dr);
      if (d >= 1 && d <= 2) out.push(Object.freeze([dq, dr, d]));
    }
  }
  return out;
})());

/** @returns {number} a generator version: an integer 1..GEN_LATEST (anything else is generation 1) */
function normalizeGen(gen) {
  return Number.isInteger(gen) && gen >= 1 ? Math.min(gen, GEN_LATEST) : 1;
}

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
 * @param {{ gen?: number }} [opts]  `gen` 1 (default: today's terrain, byte for byte) or 2 (the survival resources)
 * @returns {SurvivalWorldGen}
 */
export function createWorldGen(seed, opts = {}) {
  const s = normalizeSeed(seed);
  const gen = normalizeGen(opts?.gen ?? 1);
  const gen2 = gen >= 2;

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
  const pondSeed = s ^ POND_SALT;

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
   * STONE only — and, in generation 2, the ORE_TABLE_GEN2 rows (clay replaces sand, gravel and dirt).
   * @param {Uint8Array} blocks
   * @param {number} cq
   * @param {number} cr
   */
  function placeOres(blocks, cq, cr) {
    for (let oi = 0; oi < ORE_TABLE.length; oi++) placeVeins(blocks, cq, cr, oi, ORE_TABLE[oi], STONE_ONLY);
    if (!gen2) return;
    // Generation 2: appended rows, so `oi` (the rng stream) of every gen-1 row is unchanged.
    for (let k = 0; k < ORE_TABLE_GEN2.length; k++) {
      placeVeins(blocks, cq, cr, ORE_TABLE.length + k, ORE_TABLE_GEN2[k], GEN2_REPLACES[k]);
    }
  }

  /**
   * The `attempts` random walks of one ore row (`oi` seeds them), each replacing the ids `replaces` marks.
   * @param {Uint8Array} blocks
   * @param {number} cq
   * @param {number} cr
   * @param {number} oi
   * @param {OreRow} o
   * @param {Uint8Array} replaces  256-entry mask
   */
  function placeVeins(blocks, cq, cr, oi, o, replaces) {
    for (let i = 0; i < o.attempts; i++) {
      const rng = mulberry32(hash3(cq, cr, oi * 1000 + i, s));
      let lq = Math.floor(rng() * CHUNK_SIZE);
      let lr = Math.floor(rng() * CHUNK_SIZE);
      let y = o.minY + Math.floor(rng() * (o.maxY - o.minY + 1));
      const size = o.minSize + Math.floor(rng() * (o.maxSize - o.minSize + 1));
      placeOreCell(blocks, lq, y, lr, o.id, replaces);
      for (let step = 0; step < size; step++) {
        const dir = Math.floor(rng() * 8);
        if (dir === 6) y += 1;
        else if (dir === 7) y -= 1;
        else {
          lq += HEX_DIRS[dir][0];
          lr += HEX_DIRS[dir][1];
        }
        placeOreCell(blocks, lq, y, lr, o.id, replaces);
      }
    }
  }

  /**
   * Step 4: trees from the jittered TREE_CELL grid in (q, r) index space. Only cells inside this chunk are
   * written; the decision whether a tree exists depends solely on getColumn (treeTrunkAt), so neighbouring chunks
   * agree. Generation 2 stamps spruce and birch as well as oak.
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
        const lq0 = kq * TREE_CELL + 1 + (hsh & 3) - oq;
        const lr0 = kr * TREE_CELL + 1 + ((hsh >>> 2) & 3) - or;
        // A tree only touches this chunk when its canopy overlaps it; skip the noise work otherwise.
        if (lq0 < -CANOPY_RADIUS || lq0 >= CHUNK_SIZE + CANOPY_RADIUS ||
            lr0 < -CANOPY_RADIUS || lr0 >= CHUNK_SIZE + CANOPY_RADIUS) continue;
        const t = api.treeTrunkAt(kq, kr);
        if (t === null) continue;
        const ids = SPECIES_IDS[t.species];
        stampTree(blocks, lq0, lr0, t.height + 1, t.height + t.trunk, ids[0], ids[1]);
      }
    }
  }

  /**
   * The tree of grid cell (kq, kr), or null: exactly the gen-1 acceptance test (hash jitter, TREE_DENSITY roll, height
   * ≥ SEA_LEVEL + 2, room for the canopy), plus the species (generation 2: SNOWY → spruce; FOREST → birch when
   * `((hsh >>> 24) & 3) === 0`, else oak; everything else oak; generation 1: always oak). It depends only on
   * getColumn and never on ponds, so ponds may consult trees without any recursion (§8.3).
   * @param {number} kq
   * @param {number} kr
   * @returns {TreeTrunk|null}
   */
  function treeTrunkAt(kq, kr) {
    const hsh = hash2(kq, kr, treeSeed);
    const tq = kq * TREE_CELL + 1 + (hsh & 3);
    const tr = kr * TREE_CELL + 1 + ((hsh >>> 2) & 3);
    const trunk = 4 + ((hsh >>> 4) % 3);
    const roll = ((hsh >>> 8) & 0xffff) / 65536;
    const col = getColumn(tq, tr);
    if (!(roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT)) {
      return null;
    }
    /** @type {'oak'|'spruce'|'birch'} */
    let species = 'oak';
    if (gen2) {
      if (col.biome === BIOME.SNOWY) species = 'spruce';
      else if (col.biome === BIOME.FOREST && ((hsh >>> 24) & 3) === 0) species = 'birch';
    }
    return { tq, tr, height: col.height, trunk, biome: col.biome, species };
  }

  // ---- ponds (§8.4) ------------------------------------------------------------------------------------------------

  /**
   * The pond of grid cell (kq, kr), or null. Cheapest tests first: the hash roll, then the centre's biome, then the
   * 18 other columns within hex distance 2 (height ≥ H and a pond biome), then the trunks within distance 2.
   * @param {number} kq
   * @param {number} kr
   * @returns {Pond|null}
   */
  function pondCandidate(kq, kr) {
    const h = hash2(kq, kr, pondSeed);
    if (((h >>> 8) & 0xffff) / 65536 >= 0.5) return null;
    const pq = kq * POND_CELL + 2 + (h & 7);
    const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
    const centre = getColumn(pq, pr);
    if (!POND_BIOMES.includes(centre.biome)) return null;
    const H = centre.height;
    for (let i = 0; i < DISC2_RING.length; i++) {
      const c = getColumn(pq + DISC2_RING[i][0], pr + DISC2_RING[i][1]);
      if (c.height < H || !POND_BIOMES.includes(c.biome)) return null;
    }
    // No trunk within hex distance 2. Trunks lie at k·6 + 1..4, so only a few grid cells can hold one that close.
    for (let tkq = floorDiv(pq - 6, TREE_CELL); tkq <= floorDiv(pq + 1, TREE_CELL); tkq++) {
      for (let tkr = floorDiv(pr - 6, TREE_CELL); tkr <= floorDiv(pr + 1, TREE_CELL); tkr++) {
        const th = hash2(tkq, tkr, treeSeed);
        const tq = tkq * TREE_CELL + 1 + (th & 3);
        const tr = tkr * TREE_CELL + 1 + ((th >>> 2) & 3);
        if (hexLength(tq - pq, tr - pr) > 2) continue;
        if (api.treeTrunkAt(tkq, tkr) !== null) return null;
      }
    }
    return { q: pq, r: pr, H, biome: centre.biome };
  }

  /**
   * True for the columns that hold a pond's water: within hex distance 1 of an accepted pond centre and at its level H
   * (every column within distance 2 is at least H high). Pure; always false in generation 1.
   * @param {number} q
   * @param {number} r
   * @returns {boolean}
   */
  function pondAt(q, r) {
    if (!gen2) return false;
    // Centres lie at k·20 + 2..9: only grid cells whose centre can be within distance 1 of (q, r) matter.
    for (let kq = floorDiv(q - 10, POND_CELL); kq <= floorDiv(q - 1, POND_CELL); kq++) {
      for (let kr = floorDiv(r - 10, POND_CELL); kr <= floorDiv(r - 1, POND_CELL); kr++) {
        const h = hash2(kq, kr, pondSeed);
        const pq = kq * POND_CELL + 2 + (h & 7);
        const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        if (hexLength(q - pq, r - pr) > 1) continue;
        const pond = pondCandidate(kq, kr);
        if (pond !== null && getColumn(q, r).height === pond.H) return true;
      }
    }
    return false;
  }

  /**
   * Generation 2, before the trees: write this chunk's cells of every pond whose disc of radius 2 overlaps it. Within
   * distance 1 at height H: WATER at H (ICE when the centre is SNOWY: a frozen pond) over CLAY at H − 1. At distance 2
   * at height H: CATTAILS at H + 1 when `(hash3(q, r, POND_SALT, s) & 3) === 0`, LOOSE_STONES when `& 7` is 1. Every
   * neighbour of a pond cell is solid at H, so the water never flows.
   * @param {Uint8Array} blocks
   * @param {Uint8Array} heights
   * @param {number} cq
   * @param {number} cr
   */
  function placePonds(blocks, heights, cq, cr) {
    const oq = cq * CHUNK_SIZE;
    const or = cr * CHUNK_SIZE;
    // A centre at k·20 + 2..9 reaches 2 cells either side.
    for (let kq = floorDiv(oq - 11, POND_CELL); kq <= floorDiv(oq + CHUNK_SIZE - 1, POND_CELL); kq++) {
      for (let kr = floorDiv(or - 11, POND_CELL); kr <= floorDiv(or + CHUNK_SIZE - 1, POND_CELL); kr++) {
        const h = hash2(kq, kr, pondSeed);
        const pq = kq * POND_CELL + 2 + (h & 7);
        const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        if (pq + 2 < oq || pq - 2 >= oq + CHUNK_SIZE || pr + 2 < or || pr - 2 >= or + CHUNK_SIZE) continue;
        const pond = pondCandidate(kq, kr);
        if (pond === null) continue;
        const water = pond.biome === BIOME.SNOWY ? BLOCK.ICE : BLOCK.WATER;
        for (let i = -1; i < DISC2_RING.length; i++) {
          const dq = i < 0 ? 0 : DISC2_RING[i][0];
          const dr = i < 0 ? 0 : DISC2_RING[i][1];
          const lq = pq + dq - oq;
          const lr = pr + dr - or;
          if (lq < 0 || lq >= CHUNK_SIZE || lr < 0 || lr >= CHUNK_SIZE) continue;
          const ci = lq * CHUNK_SIZE + lr;
          if (heights[ci] !== pond.H) continue;
          const base = ci * WORLD_HEIGHT;
          if (i < 0 || DISC2_RING[i][2] === 1) {
            blocks[base + pond.H] = water;
            blocks[base + pond.H - 1] = BLOCK.CLAY;
          } else {
            const rim = hash3(pq + dq, pr + dr, POND_SALT, s);
            if ((rim & 3) === 0) blocks[base + pond.H + 1] = BLOCK.CATTAILS;
            else if ((rim & 7) === 1) blocks[base + pond.H + 1] = BLOCK.LOOSE_STONES;
          }
        }
      }
    }
  }

  // ---- flora (§8.3 step 4) -----------------------------------------------------------------------------------------

  /**
   * Generation 2, last: the surface pass. A column takes flora when its generated top (heights[ci]) is still its
   * biome's surface block with AIR above it (so never a trunk, a pond or a pond-rim plant); one roll against the
   * cumulative FLORA_TABLE chances picks at most one row. Every decision depends only on (seed, q, r), getColumn and
   * the column's own cells, so chunks agree across borders.
   * @param {Uint8Array} blocks
   * @param {Uint8Array} heights
   * @param {Uint8Array} biomes
   * @param {number} cq
   * @param {number} cr
   */
  function placeFlora(blocks, heights, biomes, cq, cr) {
    const oq = cq * CHUNK_SIZE;
    const or = cr * CHUNK_SIZE;
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const ci = lq * CHUNK_SIZE + lr;
        const table = FLORA_TABLE[biomes[ci]];
        if (!table) continue;
        const height = heights[ci];
        const top = ci * WORLD_HEIGHT + height;
        if (blocks[top] !== table.surface || blocks[top + 1] !== BLOCK.AIR) continue;
        const q = oq + lq;
        const r = or + lr;
        const u = rand3(q, r, FLORA_SALT, s);
        let acc = 0;
        for (let i = 0; i < table.rows.length; i++) {
          const row = table.rows[i];
          acc += row.chance;
          if (u >= acc) continue;
          if (floraFits(row, q, r, height)) blocks[row.top ? top : top + 1] = row.id;
          break;
        }
      }
    }
  }

  /** @returns {boolean} the row's height / shore condition holds at column (q, r) (a row without one always fits) */
  function floraFits(row, q, r, height) {
    if (row.minHeight !== undefined && height < row.minHeight) return false;
    if (row.maxHeight !== undefined && height > row.maxHeight) return false;
    if (row.besideBelow !== undefined) {
      for (let j = 0; j < 6; j++) {
        if (getColumn(q + HEX_DIRS[j][0], r + HEX_DIRS[j][1]).height < row.besideBelow) return true;
      }
      return false;
    }
    return true;
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
    if (gen2) placePonds(blocks, heights, cq, cr);
    placeTrees(blocks, cq, cr);
    if (gen2) placeFlora(blocks, heights, biomes, cq, cr);

    return { blocks, biomes, heights };
  }

  // Internal cross-calls (trees and ponds → treeTrunkAt) go through this object, so tests can spy on them.
  /** @type {SurvivalWorldGen} */
  const api = { seed: s, gen, getColumn, generateChunk, pondAt, treeTrunkAt, FLORA_TABLE };
  return api;
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

/** @returns {Uint8Array} a 256-entry mask with 1 at each listed id */
function idMask(ids) {
  const m = new Uint8Array(256);
  for (const id of ids) m[id] = 1;
  return m;
}

/** The default vein mask: STONE only. */
const STONE_ONLY = idMask([BLOCK.STONE]);
/** Masks of the ORE_TABLE_GEN2 rows (their `replaces`, default STONE). */
const GEN2_REPLACES = Object.freeze(ORE_TABLE_GEN2.map((o) => (o.replaces ? idMask(o.replaces) : STONE_ONLY)));
/** [log, leaves] ids per species. */
const SPECIES_IDS = Object.freeze({
  oak: Object.freeze([BLOCK.OAK_LOG, BLOCK.OAK_LEAVES]),
  spruce: Object.freeze([BLOCK.SPRUCE_LOG, BLOCK.SPRUCE_LEAVES]),
  birch: Object.freeze([BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES]),
});

/**
 * Replace a block the mask allows (STONE for every gen-1 row) with `id` at a local cell when the cell lies inside the
 * chunk.
 * @param {Uint8Array} blocks
 * @param {number} lq local
 * @param {number} y
 * @param {number} lr local
 * @param {number} id
 * @param {Uint8Array} replaces  256-entry mask
 */
function placeOreCell(blocks, lq, y, lr, id, replaces) {
  if (lq < 0 || lq >= CHUNK_SIZE || lr < 0 || lr >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
  const i = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y;
  if (replaces[blocks[i]] === 1) blocks[i] = id;
}

/**
 * Put `leafId` at a cell if (and only if) it is AIR.
 * @param {Uint8Array} blocks
 * @param {number} i local index
 * @param {number} leafId
 */
function leaf(blocks, i, leafId) {
  if (blocks[i] === BLOCK.AIR) blocks[i] = leafId;
}

/**
 * Stamp one tree whose trunk is at chunk-local (lq0, lr0) — possibly outside 0..15 — writing only the cells that fall
 * inside this chunk (generation 1 always passes oak). Logs overwrite anything; leaves fill AIR only. Every chunk stamps
 * overlapping trees in the same grid order (kq, then kr), so even mixed-species canopies agree across chunk borders.
 *
 * Canopy (hex distance d from the trunk): y ∈ {top−1, top}: d ≤ 1 plus the six ring-2 cells that are
 * not ring corners (13 cells); y = top+1: d ≤ 1 (7 cells); y = top+2: the trunk column plus the
 * neighbours across side faces CROWN_DIRS (4 cells).
 * @param {Uint8Array} blocks
 * @param {number} lq0
 * @param {number} lr0
 * @param {number} base  first log y (terrain height + 1)
 * @param {number} top   last log y; leaves occupy top-1 .. top+2 (top+2 < WORLD_HEIGHT guaranteed by caller)
 * @param {number} logId
 * @param {number} leafId
 */
function stampTree(blocks, lq0, lr0, base, top, logId, leafId) {
  if (lq0 >= 0 && lq0 < CHUNK_SIZE && lr0 >= 0 && lr0 < CHUNK_SIZE) {
    const col = (lq0 * CHUNK_SIZE + lr0) * WORLD_HEIGHT;
    blocks.fill(logId, col + base, col + top + 1);
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
        leaf(blocks, col + top - 1, leafId);
        leaf(blocks, col + top, leafId);
      }
      if (d <= 1) leaf(blocks, col + top + 1, leafId);
      if (d === 0 || isCrownCell(dq, dr)) leaf(blocks, col + top + 2, leafId);
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
