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
// Generation 3 (v0.14, CONTRACTS §76 flora): food is scarcer and grows in bunches. The surface pass no longer sprinkles the
// FOOD plants one roll per column: they come from PATCH_TABLE (seed-derived patch centres per plant kind, dense inside a
// patch, nothing between patches), which also brings the new plants (mushrooms, wild onion and carrot, hazel, crab apple,
// healwort); mushroom troops also grow on cave floors (CAVE_TROOP). Gravel, loose stones, fallen branches and tussock keep
// the generation-2 roll. Generations 1 and 2 are byte for byte what they were.
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
import { BLOCK, BIOME, isSolid } from './blocks.js';
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
 *   streamAt: (q: number, r: number) => boolean,
 *   streamLevelAt: (q: number, r: number) => number,
 *   pondTaintedAt: (q: number, r: number) => boolean,
 *   FLORA_TABLE: typeof FLORA_TABLE,
 *   PATCH_TABLE: typeof PATCH_TABLE,
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

/**
 * Generation-3 vein rows (v0.14, CONTRACTS §77), run after ORE_TABLE_GEN2 with `oi` continuing, so every older vein keeps
 * its rng stream. COAL SEAMS YOU CAN SEE: long, shallow seams from just under the sea's level up into the hills that
 * replace the subsoil as well as stone, so they show black in cliff sides, stream banks and on bare mountain rock.
 * @type {readonly (OreRow & { replaces?: readonly number[] })[]}
 */
export const ORE_TABLE_GEN3 = Object.freeze([
  Object.freeze({
    id: BLOCK.COAL_ORE, attempts: 8, minY: SEA_LEVEL - 4, maxY: SEA_LEVEL + 18, minSize: 12, maxSize: 20,
    replaces: Object.freeze([BLOCK.STONE, BLOCK.DIRT]),
  }),
]);

/** Pond grid (§8.4): one candidate per POND_CELL × POND_CELL cell of (q, r) index space, jittered by 0–7. */
export const POND_CELL = 20;
/** Salt of the pond hashes: `hash2(kq, kr, seed ^ POND_SALT)` for the candidate, `hash3(q, r, POND_SALT, seed)` for the rim. */
export const POND_SALT = 0x90d5;
/** Salt of the flora roll `rand3(q, r, FLORA_SALT, seed)` (§8.3 step 4). */
export const FLORA_SALT = 0xf107a;

// ---- v0.14 (§76 water): tainted ponds and streams — generation 3 only ------------------------------------------------
/** The share of generation-3 ponds whose water is TAINTED_WATER: `rand3(kq, POND_TAINT_SALT, kr, seed ^ POND_SALT)` below it. */
export const POND_TAINTED_SHARE = 0.75;
/** The `y` of the pond taint roll (see POND_TAINTED_SHARE). */
export const POND_TAINT_SALT = 0x7a1;
/** Spring grid: one candidate per STREAM_CELL × STREAM_CELL cell of (q, r) index space, anywhere in it. */
export const STREAM_CELL = 48;
/** Salt of the stream hashes: `hash2(kq, kr, seed ^ STREAM_SALT)` rolls the spring, `hash3(kq, 1, kr, …)` places it. */
export const STREAM_SALT = 0x57e4;
/** The share of spring-grid cells that try a spring at all (the land decides the rest). */
export const STREAM_CHANCE = 0.5;
/** A spring climbs at most this many columns uphill from its grid spot before it rises: streams start on higher ground. */
export const STREAM_ASCENT = 12;
/** A spring never climbs onto ground this high (bare rock, BIOME.MOUNTAINS): channels down cliffs would be deep slots. */
export const STREAM_SPRING_MAX_HEIGHT = 83;
/** … and needs ground at least this high (above the beaches). */
export const STREAM_SPRING_MIN_HEIGHT = SEA_LEVEL + 3;
/** Most columns of one stream's channel (the small pool at its end comes on top). */
export const STREAM_MAX_LEN = 64;
/** A channel shorter than this is no stream: its spring is dropped. */
export const STREAM_MIN_LEN = 10;
/**
 * How far a stream's columns can lie from its grid spot, in |dq| and in |dr|: the climb, the channel and the pool's ring.
 * A chunk asks every spring-grid cell within this reach for its stream.
 */
export const STREAM_REACH = STREAM_ASCENT + STREAM_MAX_LEN + 1;
/** Biomes a spring may rise in (index = BIOME id). A stream may run on into any land. */
const SPRING_BIOME = Object.freeze([false, false, true, true, false, true, false, false]);
/** Columns around a chunk whose stream levels the chunk needs: a channel's neighbours' neighbours decide its shape. */
export const STREAM_MARGIN = 2;
/** Side of a chunk's stream-level map (the chunk plus STREAM_MARGIN either side). */
export const STREAM_MAP_SIDE = CHUNK_SIZE + 2 * STREAM_MARGIN;
/** Traced streams / chunk maps / pond candidates kept by a generator (oldest dropped first: tracing is pure). */
const STREAM_CACHE_MAX = 1024;
const STREAM_MAP_CACHE_MAX = 512;
const POND_CACHE_MAX = 2048;

/**
 * A traced stream (§76 water): its columns as (q, r, level) triples — `level` is the y of the column's water SOURCE — and
 * their bounding box.
 * @typedef {{ cells: Int32Array, minQ: number, maxQ: number, minR: number, maxR: number }} Stream
 */

/**
 * The y of the lowest water cell of the stream column at index `i` of a stream-level map (rule 3 of the streams, see
 * createWorldGen): its level, or — a lip, with a lower stream column beside it — one cell below the lowest such
 * neighbour's level. −1 when the column has no stream. `i` must lie at least one column inside the map's edge.
 * @param {Int16Array} map  STREAM_MAP_SIDE² levels, −1 for no stream
 * @param {number} i
 * @returns {number}
 */
export function streamBottom(map, i) {
  const level = map[i];
  if (level < 0) return -1;
  let low = level;
  for (let j = 0; j < 6; j++) {
    const n = map[i + HEX_DIRS[j][0] * STREAM_MAP_SIDE + HEX_DIRS[j][1]];
    if (n >= 0 && n < low) low = n;
  }
  return low < level ? low - 1 : level;
}

/**
 * Write a chunk's cells of every stream column in or beside it (rules 2 and 3 of the streams). Pure on its arguments.
 * A stream column in the chunk: AIR above its level up to one cell over the generated surface (whatever stood there), the
 * WATER source at its level, WATER_FALL below it down to `streamBottom`, and a solid bed (STONE where a cave left none).
 * For every stream column in the chunk or one column outside it: any AIR (a cave) in this chunk beside one of its water
 * cells becomes STONE — except in the part of a neighbouring stream column that is that column's own water and carved air.
 * @param {Uint8Array} blocks   the chunk's blocks
 * @param {Uint8Array} heights  its generated heights
 * @param {Int16Array} map      the stream levels of the chunk's columns plus STREAM_MARGIN either side: entry
 *   `(lq + STREAM_MARGIN) · STREAM_MAP_SIDE + lr + STREAM_MARGIN`, −1 for no stream
 */
export function stampStreams(blocks, heights, map) {
  for (let lq = -1; lq <= CHUNK_SIZE; lq++) {
    for (let lr = -1; lr <= CHUNK_SIZE; lr++) {
      const i = (lq + STREAM_MARGIN) * STREAM_MAP_SIDE + lr + STREAM_MARGIN;
      const level = map[i];
      if (level < 0) continue;
      const bottom = streamBottom(map, i);
      if (lq >= 0 && lq < CHUNK_SIZE && lr >= 0 && lr < CHUNK_SIZE) {
        const ci = lq * CHUNK_SIZE + lr;
        const base = ci * WORLD_HEIGHT;
        blocks.fill(BLOCK.AIR, base + level + 1, base + Math.min(heights[ci] + 2, WORLD_HEIGHT));
        blocks[base + level] = BLOCK.WATER;
        if (bottom < level) blocks.fill(BLOCK.WATER_FALL, base + bottom, base + level);
        if (!isSolid(blocks[base + bottom - 1])) blocks[base + bottom - 1] = BLOCK.STONE;
      }
      for (let j = 0; j < 6; j++) {
        const nlq = lq + HEX_DIRS[j][0];
        const nlr = lr + HEX_DIRS[j][1];
        if (nlq < 0 || nlq >= CHUNK_SIZE || nlr < 0 || nlr >= CHUNK_SIZE) continue;
        // a neighbouring stream column owns its cells from its own lowest water cell up
        const nBottom = streamBottom(map, i + HEX_DIRS[j][0] * STREAM_MAP_SIDE + HEX_DIRS[j][1]);
        const top = nBottom >= 0 && nBottom <= level ? nBottom - 1 : level;
        const nbase = (nlq * CHUNK_SIZE + nlr) * WORLD_HEIGHT;
        for (let y = bottom; y <= top; y++) if (blocks[nbase + y] === BLOCK.AIR) blocks[nbase + y] = BLOCK.STONE;
      }
    }
  }
}
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
 * per eligible column is compared with the cumulative chances, left to right. v0.14 (§76): a PLAINS or FOREST column has
 * about 3 flint, expected, within hex distance 20 — most of it from digging surface gravel (× harvest.GRAVEL_FLINT_P), the
 * rest loose stones × FLINT_SHARE. It was 6–7 before v0.13, all from loose stones.
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

// ---- v0.14 (§76 flora): food in bunches (generation 3) ---------------------------------------------------------------

/**
 * Salt of the patch hashes: `hash3(kq, kr, PATCH_SALT + i, seed)` is grid cell (kq, kr) of PATCH_TABLE row i (its centre
 * and its roll), `rand3(q, r, PATCH_SALT + i, seed)` a column's fill roll for that row and
 * `rand3(q, r, PATCH_SALT + PATCH_MIX_STEP + i, seed)` its look-alike roll. The cave troops use row index PATCH_TABLE.length.
 */
export const PATCH_SALT = 0x9a7c00;
/** Offset of the look-alike roll's salt from the fill roll's (above any row index). */
export const PATCH_MIX_STEP = 64;

/**
 * One kind of food patch (generation 3). Grid cell (kq, kr) of a `cell` × `cell` grid over (q, r) holds at most one patch
 * centre, anywhere in the cell; it exists when the cell's roll is below `chance[biome of the centre column]`. A column
 * within `radius` of the centre (exactly AT `radius` for a `ring`) whose own biome has a chance above 0 holds the plant
 * when its fill roll is below `fill`. The surface pass then places it under the same conditions as any flora (the biome's
 * surface with AIR above, and the row's own `minHeight` / `maxHeight` / `besideBelow`).
 * @typedef {Object} PatchRow
 * @property {string} key                    the kind's name
 * @property {number} id                     the plant block
 * @property {number} cell                   grid cell side, 8..256
 * @property {readonly number[]} chance      index = BIOME id (0: the kind never grows there)
 * @property {number} radius                 hex radius of a patch
 * @property {number} fill                   share of a patch's columns that hold a plant
 * @property {boolean} [ring]                a fairy ring: plants only at distance `radius`
 * @property {number} [mixId]                a second block mixed in (the look-alike)
 * @property {readonly number[]} [mixShares] the look-alike's share of a patch's plants: one of these, picked per patch
 * @property {number} [edgeBelow]            a FOREST centre needs humidity below this (the forest's edge, next to plains)
 * @property {number} [minHeight]
 * @property {number} [maxHeight]
 * @property {number} [besideBelow]
 */

/** @returns {Readonly<PatchRow>} `chances` is { BIOME key: chance }; every other biome gets 0 */
function patchRow(key, id, cell, chances, radius, fill, extra = {}) {
  const chance = Object.freeze(Object.keys(BIOME).map((k) => chances[k] ?? 0));
  return Object.freeze({ key, id, cell, chance, radius, fill, ...extra });
}

/**
 * The humidity where FOREST begins (getColumn: 0.15) plus a margin: a forest column drier than this is the forest's edge.
 * Wild onion and carrot grow on plains and along that edge, never deep in the woods.
 */
export const FOREST_EDGE_HUMIDITY = 0.22;

/**
 * The share of Frecklecaps in a mushroom troop, picked per troop: some are all good, most are mixed, some are all bad —
 * so every mushroom has to be looked at.
 */
export const FRECKLECAP_SHARES = Object.freeze([0, 0.15, 0.3, 0.5, 1]);

/**
 * The food patches of generation 3, in priority order (where two patches overlap, the earlier row has the column). The
 * numbers are tuned so that a land biome holds about half the food plants it had in generation 2, counting the new kinds
 * (worldgenFlora.test.js measures it): what was sprinkled one plant here, one there, now stands in bunches of 3–8 with long
 * empty stretches between them.
 * @type {readonly Readonly<PatchRow>[]}
 */
export const PATCH_TABLE = Object.freeze([
  patchRow('honeyberry', BLOCK.HONEYBERRY_BUSH, 32, { PLAINS: 0.19, FOREST: 0.62, SNOWY: 0.25 }, 2, 0.35),
  patchRow('tuber', BLOCK.TUBER_PLANT, 36, { PLAINS: 0.42, FOREST: 0.27 }, 2, 0.3),
  patchRow('prickly_pear', BLOCK.PRICKLY_PEAR, 28, { DESERT: 0.45 }, 2, 0.4),
  // reed beds: only the shore columns of a patch take cattails (the generation-2 shore rule)
  patchRow('cattails', BLOCK.CATTAILS, 24, { BEACH: 0.6 }, 3, 0.7, { minHeight: SEA_LEVEL, maxHeight: SEA_LEVEL + 1, besideBelow: SEA_LEVEL }),
  // fairy rings in the woods: Honeycaps with Frecklecaps among them
  patchRow('mushrooms', BLOCK.HONEYCAP_MUSHROOM, 36, { FOREST: 0.6 }, 2, 0.7, {
    ring: true, mixId: BLOCK.FRECKLECAP_MUSHROOM, mixShares: FRECKLECAP_SHARES,
  }),
  patchRow('onion', BLOCK.ONION_PLANT, 40, { PLAINS: 0.2, FOREST: 0.27 }, 2, 0.4, { edgeBelow: FOREST_EDGE_HUMIDITY }),
  patchRow('carrot', BLOCK.CARROT_PLANT, 40, { PLAINS: 0.31, FOREST: 0.31 }, 2, 0.35, { edgeBelow: FOREST_EDGE_HUMIDITY }),
  patchRow('hazel', BLOCK.HAZEL_THICKET, 40, { FOREST: 0.43 }, 1, 0.8),
  patchRow('crab_apple', BLOCK.CRAB_APPLE_BUSH, 44, { PLAINS: 0.46, FOREST: 0.46 }, 2, 0.22),
  // rare: about one small patch (two to four plants) in 10 000 columns of plains or forest — the nearest is some 50 cells
  // away, so it is found by exploring, and once found it is worth more cut (it regrows) than pulled up
  patchRow('healwort', BLOCK.HEALWORT_PLANT, 64, { PLAINS: 0.4, FOREST: 0.4, SNOWY: 0.2 }, 1, 0.45),
]);

/**
 * Mushroom troops on cave floors (generation 3): the same two mushrooms, in the dark. A grid cell holds a troop with
 * `chance`; each column within `radius` whose fill roll passes gets a mushroom on the floor of its HIGHEST cave — the
 * first AIR cell with STONE under it, looking down from the cave ceiling limit — if it has one.
 */
export const CAVE_TROOP = Object.freeze({
  key: 'cave_mushrooms', id: BLOCK.HONEYCAP_MUSHROOM, cell: 28, chance: 0.3, radius: 2, fill: 0.5,
  mixId: BLOCK.FRECKLECAP_MUSHROOM, mixShares: FRECKLECAP_SHARES,
});

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
 * @param {{ gen?: number }} [opts]  `gen` 1 (default: today's terrain, byte for byte), 2 (the survival resources) or 3
 *   (v0.14: the harder land)
 * @returns {SurvivalWorldGen}
 */
export function createWorldGen(seed, opts = {}) {
  const s = normalizeSeed(seed);
  const gen = normalizeGen(opts?.gen ?? 1);
  const gen2 = gen >= 2;
  /** v0.14 (CONTRACTS §76): the harder land — streams, tainted ponds, scarcer food in bunches, new plants. New worlds only. */
  const gen3 = gen >= 3;

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
    if (!gen3) return;
    // Generation 3 (§77): the shallow coal seams, again appended.
    for (let k = 0; k < ORE_TABLE_GEN3.length; k++) {
      placeVeins(blocks, cq, cr, ORE_TABLE.length + ORE_TABLE_GEN2.length + k, ORE_TABLE_GEN3[k], GEN3_REPLACES[k]);
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
   * @param {Int16Array|null} [streamMap]  generation 3: the chunk's stream levels (`streamLevels`), or null
   */
  function placeTrees(blocks, cq, cr, streamMap = null) {
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
        // §76 water (generation 3): no tree grows in a stream — its column is carved, the trunk would hang over the water.
        // (treeTrunkAt itself stays the gen-1 test; the trunk is within STREAM_MARGIN of the chunk, so the map covers it.)
        if (streamMap !== null && streamMap[(lq0 + STREAM_MARGIN) * STREAM_MAP_SIDE + lr0 + STREAM_MARGIN] >= 0) continue;
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
        // §76 water (generation 3): standing water is usually tainted — the whole pond or none of it (a frozen pond stays ice)
        const water = pond.biome === BIOME.SNOWY ? BLOCK.ICE : gen3 && pondTainted(kq, kr) ? BLOCK.TAINTED_WATER : BLOCK.WATER;
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
    // Generation 3 (§76 flora): the food plants stand in patches; the per-column roll below keeps only the other rows.
    if (gen3) markPatches(biomes, cq, cr);
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
        if (gen3 && patchRowOf[ci] !== 0 && floraFits(PATCH_TABLE[patchRowOf[ci] - 1], q, r, height)) {
          blocks[top + 1] = patchPlant[ci];
          continue;
        }
        const u = rand3(q, r, FLORA_SALT, s);
        let acc = 0;
        for (let i = 0; i < table.rows.length; i++) {
          const row = table.rows[i];
          acc += row.chance;
          if (u >= acc) continue;
          // Generation 3: a food row's slice of the roll places nothing, so the other rows fall exactly where they did.
          if (gen3 && PATCH_FOOD[row.id] === 1) break;
          if (floraFits(row, q, r, height)) blocks[row.top ? top : top + 1] = row.id;
          break;
        }
      }
    }
  }

  // ---- food patches (generation 3, §76 flora) ----------------------------------------------------------------------

  /** Scratch of markPatches, per column of the chunk being generated: PATCH_TABLE row index + 1 (0: none) and the plant. */
  const patchRowOf = new Uint8Array(gen3 ? CHUNK_AREA : 0);
  const patchPlant = new Uint8Array(gen3 ? CHUNK_AREA : 0);

  /**
   * The patch of grid cell (kq, kr) of a patch row (`salt` = PATCH_SALT + its index): its centre and its look-alike
   * share, or null when the cell holds none. `chanceOf(col)` is the chance at the centre column. Pure in (seed, kq, kr).
   * @param {{ cell: number, mixShares?: readonly number[] }} row
   * @param {number} salt @param {number} kq @param {number} kr @param {number} maxChance
   * @param {(col: ColumnInfo) => number} chanceOf
   * @returns {{ q: number, r: number, share: number }|null}
   */
  function patchCentre(row, salt, kq, kr, maxChance, chanceOf) {
    const h = hash3(kq, kr, salt, s);
    const roll = (h >>> 16) / 65536;
    if (roll >= maxChance) return null; // cheapest first: most cells are empty whatever their biome
    const pq = kq * row.cell + (((h & 0xff) * row.cell) >> 8);
    const pr = kr * row.cell + ((((h >>> 8) & 0xff) * row.cell) >> 8);
    if (roll >= chanceOf(getColumn(pq, pr))) return null;
    const shares = row.mixShares;
    const share = shares ? shares[hash3(kr, kq, salt + PATCH_MIX_STEP, s) % shares.length] : 0;
    return { q: pq, r: pr, share };
  }

  /**
   * Call `visit(lq, lr, plantId)` for every column of chunk (cq, cr) that a patch of `row` covers and whose fill roll
   * passes, patch by patch in grid order (kq, then kr). Every decision depends only on (seed, q, r) and the row, so a
   * patch that straddles chunks is the same patch in each of them.
   * @param {{ id: number, cell: number, radius: number, fill: number, ring?: boolean, mixId?: number,
   *   mixShares?: readonly number[] }} row
   * @param {number} salt @param {number} maxChance @param {(col: ColumnInfo) => number} chanceOf
   * @param {number} cq @param {number} cr
   * @param {(lq: number, lr: number, plantId: number) => void} visit
   */
  function forEachPatchColumn(row, salt, maxChance, chanceOf, cq, cr, visit) {
    const oq = cq * CHUNK_SIZE;
    const or = cr * CHUNK_SIZE;
    const R = row.radius;
    for (let kq = floorDiv(oq - R, row.cell); kq <= floorDiv(oq + CHUNK_SIZE - 1 + R, row.cell); kq++) {
      for (let kr = floorDiv(or - R, row.cell); kr <= floorDiv(or + CHUNK_SIZE - 1 + R, row.cell); kr++) {
        const patch = patchCentre(row, salt, kq, kr, maxChance, chanceOf);
        if (patch === null) continue;
        const lq0 = patch.q - oq;
        const lr0 = patch.r - or;
        for (let dq = -R; dq <= R; dq++) {
          const lq = lq0 + dq;
          if (lq < 0 || lq >= CHUNK_SIZE) continue;
          for (let dr = -R; dr <= R; dr++) {
            const lr = lr0 + dr;
            if (lr < 0 || lr >= CHUNK_SIZE) continue;
            const d = hexLength(dq, dr);
            if (row.ring ? d !== R : d > R) continue;
            const q = oq + lq;
            const r = or + lr;
            if (rand3(q, r, salt, s) >= row.fill) continue;
            const mixed = patch.share > 0 && rand3(q, r, salt + PATCH_MIX_STEP, s) < patch.share;
            visit(lq, lr, mixed ? /** @type {number} */ (row.mixId) : row.id);
          }
        }
      }
    }
  }

  /**
   * Fill patchRowOf / patchPlant for chunk (cq, cr): the first PATCH_TABLE row (then the first patch in grid order) that
   * covers a column and passes its fill roll has it. A column takes a kind only where its own biome grows it.
   * @param {Uint8Array} biomes
   * @param {number} cq
   * @param {number} cr
   */
  function markPatches(biomes, cq, cr) {
    patchRowOf.fill(0);
    for (let i = 0; i < PATCH_TABLE.length; i++) {
      const row = PATCH_TABLE[i];
      const chanceOf = (col) => (
        row.edgeBelow !== undefined && col.biome === BIOME.FOREST && col.humidity >= row.edgeBelow ? 0 : row.chance[col.biome]
      );
      forEachPatchColumn(row, PATCH_SALT + i, PATCH_MAX_CHANCE[i], chanceOf, cq, cr, (lq, lr, plantId) => {
        const ci = lq * CHUNK_SIZE + lr;
        if (patchRowOf[ci] !== 0 || row.chance[biomes[ci]] === 0) return;
        patchRowOf[ci] = i + 1;
        patchPlant[ci] = plantId;
      });
    }
  }

  /**
   * Generation 3: mushroom troops on cave floors (CAVE_TROOP). A covered column gets a mushroom in the first AIR cell
   * with STONE under it, looking down from the caves' ceiling limit: the floor of its highest cave. Reads and writes only
   * that column, so chunks agree.
   * @param {Uint8Array} blocks
   * @param {Uint8Array} heights
   * @param {number} cq
   * @param {number} cr
   */
  function placeCaveTroops(blocks, heights, cq, cr) {
    const chanceOf = () => CAVE_TROOP.chance;
    forEachPatchColumn(CAVE_TROOP, PATCH_SALT + PATCH_TABLE.length, CAVE_TROOP.chance, chanceOf, cq, cr, (lq, lr, plantId) => {
      const ci = lq * CHUNK_SIZE + lr;
      const base = ci * WORLD_HEIGHT;
      for (let y = heights[ci] - CAVE_TOP_MARGIN; y > CAVE_MIN_Y; y--) {
        if (blocks[base + y] !== BLOCK.AIR) continue;
        if (blocks[base + y - 1] === BLOCK.AIR) continue; // still inside the cave: keep going down to its floor
        if (blocks[base + y - 1] === BLOCK.STONE) blocks[base + y] = plantId;
        return; // the highest cave only, whatever its floor is made of
      }
    });
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

  // ---- v0.14 (§76 water): tainted ponds and streams — generation 3 only ---------------------------------------------
  //
  // A STREAM is a one-column-wide ribbon of fresh WATER sources that starts at a spring on higher ground and runs down
  // the land until it meets the sea, a pond or a hollow (where it ends in a small pool). Three rules make it cheap,
  // the same from every chunk, and AT REST for the fluid simulation (fluids.js: loading it floods nothing, dries nothing):
  //
  // 1. WHERE. One spring candidate per STREAM_CELL grid cell, from hashes of the seed. It climbs a few columns uphill,
  //    then the channel follows steepest descent on `rawHeight` — the terrain height before rounding, a smooth field
  //    with no flat terraces — so a path never loops or touches itself. Everything is a pure function of (seed, grid
  //    cell): a chunk asks the grid cells within STREAM_REACH for their streams (traced once, cached) and writes the
  //    columns that fall inside it.
  // 2. HOW HIGH. A stream column's water SOURCE is at `level` = the lowest generated height among the column itself and
  //    its six neighbours (never below SEA_LEVEL): the lowest bank holds it, and the column is carved down to it. The
  //    level depends on the column alone, so two streams that share a column agree.
  // 3. WHERE THE LEVEL DROPS. A source standing on a floor spreads into any open cell beside it — and the column of a
  //    lower neighbouring stream column IS open beside it (carved). So a stream column with a lower stream neighbour is
  //    a LIP: under its source the column is a shaft of WATER_FALL down to one cell below the lowest such neighbour's
  //    level, on a solid bed. A source over falling water does not spread (CONTRACTS §35.1), the shaft's cells are fed
  //    from the source above them, and its bottom stands one cell under every neighbouring source, beside their beds:
  //    nothing next to it is open, and no cell beside it is a source that could turn it into one. Any air a cave left in
  //    a bed or beside a water cell is filled with stone.
  //
  // Ponds keep their ground (every column within 2 of a pond's centre): a stream ends beside it, or — when the rim
  // column would stand exactly at the pond's level — in it. No tree grows in a stream column, and the flora pass skips
  // one by itself (its top is water or air, not the biome's surface).

  const streamSeed = s ^ STREAM_SALT;
  /** @type {Map<string, Stream|null>} traced streams by spring-grid cell "kq,kr" */
  const streamCache = new Map();
  /** @type {Map<string, Int16Array|null>} stream levels around a chunk by "cq,cr" (see streamLevels) */
  const streamMapCache = new Map();
  /** @type {Map<string, Pond|null>} pond candidates the stream tracer has asked about, by "kq,kr" */
  const pondCache = new Map();
  /** rawHeight of the columns the current trace has looked at, keyed by their offset from (memoQ, memoR). */
  const fieldMemo = new Map();
  let memoQ = 0;
  let memoR = 0;

  /** Keep `cache` under `max` entries: the oldest half goes first (everything in it can be computed again). */
  function trimCache(cache, max) {
    if (cache.size < max) return;
    let drop = cache.size - (max >> 1);
    for (const key of cache.keys()) {
      cache.delete(key);
      if (--drop <= 0) break;
    }
  }

  /** @returns {boolean} the accepted pond of grid cell (kq, kr) holds TAINTED_WATER in generation 3 (a frozen one: ice) */
  function pondTainted(kq, kr) {
    return rand3(kq, POND_TAINT_SALT, kr, pondSeed) < POND_TAINTED_SHARE;
  }

  /**
   * True for the pond water columns (`pondAt`) of a pond whose water is tainted: generation 3, the pond's roll, and not
   * a frozen pond. Pure; false below generation 3.
   * @param {number} q @param {number} r @returns {boolean}
   */
  function pondTaintedAt(q, r) {
    if (!gen3) return false;
    for (let kq = floorDiv(q - 10, POND_CELL); kq <= floorDiv(q - 1, POND_CELL); kq++) {
      for (let kr = floorDiv(r - 10, POND_CELL); kr <= floorDiv(r - 1, POND_CELL); kr++) {
        const h = hash2(kq, kr, pondSeed);
        const pq = kq * POND_CELL + 2 + (h & 7);
        const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        if (hexLength(q - pq, r - pr) > 1) continue;
        const pond = pondOf(kq, kr);
        if (pond !== null && getColumn(q, r).height === pond.H) return pond.biome !== BIOME.SNOWY && pondTainted(kq, kr);
      }
    }
    return false;
  }

  /** `pondCandidate(kq, kr)`, remembered: a stream skirting a pond asks about it column after column. */
  function pondOf(kq, kr) {
    const key = `${kq},${kr}`;
    let pond = pondCache.get(key);
    if (pond === undefined) {
      trimCache(pondCache, POND_CACHE_MAX);
      pond = pondCandidate(kq, kr);
      pondCache.set(key, pond);
    }
    return pond;
  }

  /**
   * The accepted pond whose ground holds column (q, r) — a column within hex distance 2 of its centre: its water, its
   * rim — or null. (Centres lie at k·20 + 2..9, at least 13 apart: at most one pond is that near.)
   * @param {number} q @param {number} r @returns {Pond|null}
   */
  function pondNear(q, r) {
    for (let kq = floorDiv(q - 11, POND_CELL); kq <= floorDiv(q, POND_CELL); kq++) {
      for (let kr = floorDiv(r - 11, POND_CELL); kr <= floorDiv(r, POND_CELL); kr++) {
        const h = hash2(kq, kr, pondSeed);
        const pq = kq * POND_CELL + 2 + (h & 7);
        const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        if (hexLength(q - pq, r - pr) > 2) continue;
        const pond = pondOf(kq, kr);
        if (pond !== null) return pond;
      }
    }
    return null;
  }

  /**
   * The terrain height of column (q, r) BEFORE rounding and clamping: getColumn's own formula, so that
   * `groundOf(rawHeight(q, r)) === getColumn(q, r).height` (a test holds the two together). Streams run down this smooth
   * field: the rounded heights are terraces, where steepest descent has nowhere to go.
   * @param {number} q @param {number} r @returns {number}
   */
  function rawHeight(q, r) {
    const [wx, wz] = hexToWorld(q, r);
    const c = nCont.fbm2D(wx / 500, wz / 500, 3);
    const d = nDetail.fbm2D(wx / 50, wz / 50, 2);
    const mRaw = nMount.fbm2D(wx / 250, wz / 250, 2);
    const m = clamp((mRaw - 0.25) / 0.75, 0, 1);
    const T = nTemp.fbm2D(wx / 400 + 1000, wz / 400, 2);
    // (desert — hot and dry — halves the detail; the humidity is only looked at where it is hot enough to matter)
    const desert = T > 0.35 && nHumid.fbm2D(wx / 400, wz / 400 + 1000, 2) < 0;
    return 66 + c * 14 + d * (desert ? 2 : 4) + m * m * 48;
  }

  /** @returns {number} the generated terrain height a raw height rounds to */
  function groundOf(raw) {
    return clamp(Math.round(raw), MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
  }

  /** rawHeight(q, r), remembered for the trace in hand (a path looks at each column from several sides). */
  function field(q, r) {
    const key = ((q - memoQ + 512) << 10) | (r - memoR + 512);
    let v = fieldMemo.get(key);
    if (v === undefined) {
      v = rawHeight(q, r);
      fieldMemo.set(key, v);
    }
    return v;
  }

  /**
   * The level a stream has in column (q, r) (rule 2): the lowest generated height among the column and its six
   * neighbours, never below SEA_LEVEL. Every neighbour is then solid at that y, or sea water.
   * @param {number} q @param {number} r @returns {number}
   */
  function levelOf(q, r) {
    let m = groundOf(field(q, r));
    for (let j = 0; j < 6; j++) {
      const g = groundOf(field(q + HEX_DIRS[j][0], r + HEX_DIRS[j][1]));
      if (g < m) m = g;
    }
    return m > SEA_LEVEL ? m : SEA_LEVEL;
  }

  /**
   * Trace the stream of spring-grid cell (kq, kr), or null when it has none (rule 1). Pure in (seed, kq, kr).
   * @param {number} kq @param {number} kr @returns {Stream|null}
   */
  function traceStream(kq, kr) {
    if (((hash2(kq, kr, streamSeed) >>> 8) & 0xffff) / 65536 >= STREAM_CHANCE) return null;
    const spot = hash3(kq, 1, kr, streamSeed);
    let cq = kq * STREAM_CELL + (spot % STREAM_CELL);
    let cr = kr * STREAM_CELL + ((spot >>> 8) % STREAM_CELL);
    fieldMemo.clear();
    memoQ = cq;
    memoR = cr;

    // The spring: up to STREAM_ASCENT columns uphill from the grid spot, but not onto bare rock. (A spot in the sea or on
    // the rock has no spring: said first, it saves the climb.)
    const spotGround = groundOf(field(cq, cr));
    if (spotGround < SEA_LEVEL || spotGround > STREAM_SPRING_MAX_HEIGHT) return null;
    for (let step = 0; step < STREAM_ASCENT; step++) {
      let best = field(cq, cr);
      let bj = -1;
      for (let j = 0; j < 6; j++) {
        const v = field(cq + HEX_DIRS[j][0], cr + HEX_DIRS[j][1]);
        if (v > best) {
          best = v;
          bj = j;
        }
      }
      if (bj < 0 || groundOf(best) > STREAM_SPRING_MAX_HEIGHT) break;
      cq += HEX_DIRS[bj][0];
      cr += HEX_DIRS[bj][1];
    }
    const spring = getColumn(cq, cr);
    if (!SPRING_BIOME[spring.biome] || spring.height < STREAM_SPRING_MIN_HEIGHT || pondNear(cq, cr) !== null) return null;

    // The channel: steepest descent on the raw height until the sea, a pond, a hollow or STREAM_MAX_LEN columns.
    /** @type {number[]} (q, r) pairs */
    const path = [];
    let hollow = false;
    for (;;) {
      path.push(cq, cr);
      if (path.length >= 2 * STREAM_MAX_LEN) break;
      let best = field(cq, cr);
      let bj = -1;
      for (let j = 0; j < 6; j++) {
        const v = field(cq + HEX_DIRS[j][0], cr + HEX_DIRS[j][1]);
        if (v < best) {
          best = v;
          bj = j;
        }
      }
      if (bj < 0) {
        hollow = true; // nowhere lower: the stream ends here, in a pool
        break;
      }
      if (groundOf(best) < SEA_LEVEL) break; // the next column is sea: this one is the mouth (its level is SEA_LEVEL)
      const nq = cq + HEX_DIRS[bj][0];
      const nr = cr + HEX_DIRS[bj][1];
      const pond = pondNear(nq, nr);
      if (pond !== null) {
        // A pond's ground is the pond's: carving it lower would let the pond run out. The stream ends beside it — or on
        // the rim column, when that would stand exactly at the pond's level (a mouth, flush with the pond's water).
        if (levelOf(nq, nr) === pond.H) path.push(nq, nr);
        break;
      }
      cq = nq;
      cr = nr;
    }
    if (path.length < 2 * STREAM_MIN_LEN) return null;

    // The pool in a hollow: the neighbours of the last column that are land at its water's level or one cell above it and
    // would stand at the same level themselves (so their own banks hold it) — never a pond's ground.
    if (hollow) {
      const level = levelOf(cq, cr);
      const pq = path[path.length - 4];
      const pr = path[path.length - 3];
      for (let j = 0; j < 6; j++) {
        const nq = cq + HEX_DIRS[j][0];
        const nr = cr + HEX_DIRS[j][1];
        if (nq === pq && nr === pr) continue; // the channel itself
        const ground = groundOf(field(nq, nr));
        if (ground < level || ground > level + 1 || levelOf(nq, nr) !== level || pondNear(nq, nr) !== null) continue;
        path.push(nq, nr);
      }
    }

    const n = path.length / 2;
    const cells = new Int32Array(n * 3);
    let minQ = Infinity;
    let maxQ = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (let i = 0; i < n; i++) {
      const q = path[2 * i];
      const r = path[2 * i + 1];
      cells[3 * i] = q;
      cells[3 * i + 1] = r;
      cells[3 * i + 2] = levelOf(q, r);
      if (q < minQ) minQ = q;
      if (q > maxQ) maxQ = q;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    return { cells, minQ, maxQ, minR, maxR };
  }

  /** The stream of spring-grid cell (kq, kr), traced once. @returns {Stream|null} */
  function streamOf(kq, kr) {
    const key = `${kq},${kr}`;
    let stream = streamCache.get(key);
    if (stream === undefined) {
      trimCache(streamCache, STREAM_CACHE_MAX);
      stream = traceStream(kq, kr);
      streamCache.set(key, stream);
    }
    return stream;
  }

  /**
   * The stream levels around chunk (cq, cr): a STREAM_MAP_SIDE² map over the chunk's columns plus STREAM_MARGIN either
   * side — entry `(lq + STREAM_MARGIN) · STREAM_MAP_SIDE + lr + STREAM_MARGIN` is the level of the stream in column
   * (oq + lq, or + lr), −1 for none — or null when no stream comes that near (most chunks). Remembered per chunk.
   * @param {number} cq @param {number} cr @returns {Int16Array|null}
   */
  function streamLevels(cq, cr) {
    const key = `${cq},${cr}`;
    const cached = streamMapCache.get(key);
    if (cached !== undefined) return cached;
    const q0 = cq * CHUNK_SIZE - STREAM_MARGIN;
    const r0 = cr * CHUNK_SIZE - STREAM_MARGIN;
    const q1 = q0 + STREAM_MAP_SIDE - 1;
    const r1 = r0 + STREAM_MAP_SIDE - 1;
    /** @type {Int16Array|null} */
    let map = null;
    for (let kq = floorDiv(q0 - STREAM_REACH, STREAM_CELL); kq <= floorDiv(q1 + STREAM_REACH, STREAM_CELL); kq++) {
      for (let kr = floorDiv(r0 - STREAM_REACH, STREAM_CELL); kr <= floorDiv(r1 + STREAM_REACH, STREAM_CELL); kr++) {
        const stream = streamOf(kq, kr);
        if (stream === null || stream.maxQ < q0 || stream.minQ > q1 || stream.maxR < r0 || stream.minR > r1) continue;
        const cells = stream.cells;
        for (let i = 0; i < cells.length; i += 3) {
          const lq = cells[i] - q0;
          const lr = cells[i + 1] - r0;
          if (lq < 0 || lq >= STREAM_MAP_SIDE || lr < 0 || lr >= STREAM_MAP_SIDE) continue;
          if (map === null) map = new Int16Array(STREAM_MAP_SIDE * STREAM_MAP_SIDE).fill(-1);
          map[lq * STREAM_MAP_SIDE + lr] = cells[i + 2]; // (two streams in one column agree: the level is the column's)
        }
      }
    }
    trimCache(streamMapCache, STREAM_MAP_CACHE_MAX);
    streamMapCache.set(key, map);
    return map;
  }

  /**
   * Whether column (q, r) is on a generated STREAM: running fresh water (generation 3, CONTRACTS §76) — a column of its
   * channel or of the pool at its end. Pure. Always false below generation 3. The stream's water is the WATER source at
   * `streamLevelAt(q, r)` (with falling water under it at a step); it is there until someone moves it.
   * @param {number} q @param {number} r @returns {boolean}
   */
  function streamAt(q, r) {
    return streamLevelAt(q, r) >= 0;
  }

  /**
   * The y of the water source of the stream in column (q, r) as generated, or −1 when the column has no stream
   * (generation 3; always −1 below it). Pure.
   * @param {number} q @param {number} r @returns {number}
   */
  function streamLevelAt(q, r) {
    if (!gen3 || !Number.isInteger(q) || !Number.isInteger(r)) return -1;
    const cq = floorDiv(q, CHUNK_SIZE);
    const cr = floorDiv(r, CHUNK_SIZE);
    const map = streamLevels(cq, cr);
    if (map === null) return -1;
    return map[(q - cq * CHUNK_SIZE + STREAM_MARGIN) * STREAM_MAP_SIDE + (r - cr * CHUNK_SIZE) + STREAM_MARGIN];
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
    // §76 water (generation 3): streams after the ponds (a stream's mouth clears the rim plant it replaces) and before
    // the trees and the flora (neither grows in a stream column).
    const streamMap = gen3 ? streamLevels(cq, cr) : null;
    if (streamMap !== null) stampStreams(blocks, heights, streamMap);
    placeTrees(blocks, cq, cr, streamMap);
    if (gen2) placeFlora(blocks, heights, biomes, cq, cr);
    if (gen3) placeCaveTroops(blocks, heights, cq, cr);

    return { blocks, biomes, heights };
  }

  // Internal cross-calls (trees and ponds → treeTrunkAt) go through this object, so tests can spy on them.
  /** @type {SurvivalWorldGen} */
  const api = { seed: s, gen, getColumn, generateChunk, pondAt, treeTrunkAt, streamAt, streamLevelAt, pondTaintedAt, FLORA_TABLE, PATCH_TABLE };
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
const GEN3_REPLACES = Object.freeze(ORE_TABLE_GEN3.map((o) => (o.replaces ? idMask(o.replaces) : STONE_ONLY)));
/** The ids PATCH_TABLE places (§76 flora): in generation 3 the per-column flora roll never places these. */
const PATCH_FOOD = idMask(PATCH_TABLE.map((row) => row.id));
/** The largest chance of each PATCH_TABLE row over the biomes: a grid cell whose roll is not below it holds no patch. */
const PATCH_MAX_CHANCE = Object.freeze(PATCH_TABLE.map((row) => Math.max(...row.chance)));
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
