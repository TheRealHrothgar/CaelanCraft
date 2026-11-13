// Caelancraft — water that runs out (CONTRACTS §83): what the water in a cell is, what drinking and filling a pot take
// from a pool, and the water cycle: pools dry in the sun and fill in the rain, dry beds and clay basins catch the rain.
// The bodies themselves — one level of a pool, the sea, running water — and the three laws they obey are fluids.js's.
// §89 adds the AQUIFER, the one thing besides rain that makes water: a body standing on one is FED — the flow of the
// aquifer raises it to its seasonal target, the sun dries it no lower and drinking stops at shallow — a dry basin on one
// takes water, and the stream over one keeps its head in a drought (`feedStep`, `bodyFed`, `streamDryWrites`).
// Pure: the world is read through `peek`, every roll takes `random` ([0, 1)), rain and season come through an injected
// `env`. Nothing here writes: every result lists the cells to write, and main writes them.
import { WORLD_HEIGHT, CHUNK_SIZE, DAY_LENGTH_SECONDS } from './config.js';
import {
  BLOCK, UNLOADED, isOpaque, isSolid, isWater, isWaterSource, isTaintedWater, waterDepth, waterAtDepth,
} from './blocks.js';
import { HEX_DIRS, hexDiscCount, hexLength } from './hex.js';
import { BODY_MAX_CELLS, waterBodyAt, waterSourceOf } from './fluids.js';
import { hasSky } from './farming.js';
import { discCells } from './spread.js';
import { DRYNESS_RAINS, DRYNESS_DRY } from './weather.js';

/** @typedef {import('./fluids.js').WaterBody} WaterBody */

const B = BLOCK;

// ---- Using water ------------------------------------------------------------------------------------------------------

/** Gulps one cell of a body holds per level of depth. */
export const CELL_GULPS = 6;
/** Gulps filling a clay pot takes (a gulp from the hand takes 1). */
export const POT_GULPS = 4;

/**
 * @typedef {Object} WaterWorld  how this module reads the world
 * @property {(q: number, y: number, r: number) => number} peek  world.peekBlock (UNLOADED for a chunk that is not loaded;
 *   world.getBlock works too: a body at the edge of the loaded world is then not known to be cut)
 * @property {((q: number, r: number) => number)|null} [springLevelAt]  where streams run (fluids.makeSpringLookup); absent: nowhere
 * @property {((q: number, y: number, r: number) => number)|null} [originAt]  world.originAt: what a cell was generated as
 * @property {((q: number, r: number) => boolean)|null} [saltyAt]  the column's biome is salt (climate.isSaltyBiome of it)
 */

/**
 * @typedef {'fresh'|'salt'|'tainted'} WaterQuality
 * @typedef {Object} WaterInfo  what the water in a cell is
 * @property {WaterQuality} quality  tainted when any source that feeds it is; else salt for the sea and for water generated
 *   in a salt biome; else fresh
 * @property {number} depth          the depth of the source it is taken from, 1..3 (its pool's, to within one: a pool is
 *   level; 0: flowing water that no source feeds)
 * @property {boolean} sea           that body is the sea
 * @property {boolean} stream        that body is running water
 * @property {boolean} flowing       the cell itself is flowing or falling water
 * @property {number[]|null} source  the source cell [q, y, r] it is taken from (the cell itself when it is a source)
 * @property {WaterBody|null} body   that source's body (fluids.waterBodyAt)
 */

/**
 * What the water in cell (q, y, r) is: a source's own body, or — flowing and falling water — the body of the first source
 * that feeds it (fluids.waterSourceOf). SALT is the sea, whatever the biome of the column, and water that was generated
 * in a salt biome (a lagoon on a beach); rain caught in a basin on that beach is fresh. Running water is never salt.
 * @param {WaterWorld} w
 * @param {number} q @param {number} y @param {number} r
 * @returns {WaterInfo|null} null when the cell holds no water
 */
export function waterAt(w, q, y, r) {
  const id = w.peek(q, y, r);
  if (!isWater(id)) return null;
  const src = waterSourceOf(w.peek, q, y, r);
  if (src === null) return { quality: 'fresh', depth: 0, sea: false, stream: false, flowing: true, source: null, body: null };
  const body = /** @type {WaterBody} */ (waterBodyAt(w.peek, src.q, src.y, src.r, w.springLevelAt ?? null));
  let salt = body.sea;
  if (!salt && !body.stream && w.saltyAt && w.originAt && w.saltyAt(src.q, src.r)) salt = isWaterSource(w.originAt(src.q, src.y, src.r));
  return {
    quality: src.tainted ? 'tainted' : salt ? 'salt' : 'fresh',
    depth: waterDepth(src.id),
    sea: body.sea,
    stream: body.stream,
    flowing: !isWaterSource(id),
    source: [src.q, src.y, src.r],
    body,
  };
}

/**
 * The body that water is taken from first: `body`, or — while water stands over it — the body over it, and so on up
 * (a pool is used up, dries and spills from the top). Null when that cannot be told (an unloaded chunk).
 * @param {WaterWorld} w @param {WaterBody} body
 * @returns {WaterBody|null}
 */
export function topBody(w, body) {
  let top = body;
  for (let guard = 0; top.cover !== null && guard < 32; guard++) {
    const over = waterBodyAt(w.peek, top.cover[0], top.cover[1], top.cover[2], w.springLevelAt ?? null);
    if (over === null) break;
    if (over.truncated && !over.sea) return null;
    top = over;
  }
  return top;
}

/** @param {WaterBody} body @returns {boolean} drinking, the sun and the rain leave it as it is: the sea, or water under water */
function isBeyondUse(body) {
  return body.sea || (body.truncated && !body.stream);
}

/**
 * The writes by which `body` loses a level of depth (`by` −1: a shallow cell becomes AIR) or gains one (`by` +1: a full
 * cell stays full), as (q, y, r, id) quadruples. A body loses a level from its DEEPEST cells and gains one in its
 * SHALLOWEST: every cell of a level body — and of one that levelling left at two depths, only the cells that make it
 * even again.
 * @param {WaterWorld} w @param {WaterBody} body @param {number} by  −1 or +1
 * @returns {number[]}
 */
export function depthWrites(w, body, by) {
  /** @type {number[]} */
  const out = [];
  const cells = body.cells;
  const at = by < 0 ? body.depth : body.minDepth;
  const to = Math.max(0, Math.min(3, at + (by < 0 ? -1 : 1)));
  if (to === at) return out;
  for (let i = 0; i < cells.length; i += 3) {
    if (waterDepth(w.peek(cells[i], cells[i + 1], cells[i + 2])) === at) out.push(cells[i], cells[i + 1], cells[i + 2], waterAtDepth(body.tainted, to));
  }
  return out;
}

/**
 * @typedef {Object} Draw  what taking water did
 * @property {WaterInfo} info       the water it was taken from (`waterAt` of the cell)
 * @property {WaterBody|null} body  the body that paid for it: the top of the pool; null when nothing pays (the sea, running
 *   water, flowing water no source feeds)
 * @property {boolean} dropped      that body dropped one level of depth
 * @property {number[]} writes      the cells to write, as (q, y, r, id) quadruples (empty unless `dropped`)
 */

/**
 * Take `gulps` gulps of the water in cell (q, y, r): one for a drink from the hand, POT_GULPS to fill a pot. No count is
 * kept: a body of N cells drops one level of depth with probability `gulps / (N × CELL_GULPS)` (at most 1), so a level of
 * it gives N × CELL_GULPS gulps on average. One `random()` when a pool pays. The sea is never used up, and neither is
 * running water (the cycle alone changes a stream); water under water is taken from the top of its pool. A FED pool
 * (§89: `bodyFed`) pays like any other down to AQUIFER_FLOOR (shallow) and no further: there its aquifer pays.
 * @param {WaterWorld} w
 * @param {number} q @param {number} y @param {number} r
 * @param {number} gulps
 * @param {() => number} random
 * @returns {Draw|null} null when the cell holds no water
 */
export function drawWater(w, q, y, r, gulps, random) {
  const info = waterAt(w, q, y, r);
  if (info === null) return null;
  /** @type {Draw} */
  const none = { info, body: null, dropped: false, writes: [] };
  if (info.body === null || info.body.stream || isBeyondUse(info.body) || !(gulps > 0)) return none;
  const body = topBody(w, info.body);
  if (body === null || body.stream || isBeyondUse(body)) return none;
  if (body.depth <= AQUIFER_FLOOR && bodyFed(w, body)) return none; // §89: shallow on an aquifer, it is used no lower
  // (N: the cells that would drop — all of a level body, the deeper ones of a body at two depths)
  const dropped = random() < Math.min(1, gulps / (body.levels[body.depth] * CELL_GULPS));
  return { info, body, dropped, writes: dropped ? depthWrites(w, body, -1) : [] };
}

// ---- The cycle: sun and rain -------------------------------------------------------------------------------------------

/** Random columns looked at every second. */
export const CYCLE_SAMPLES = 48;
/** They lie within this many cells of the player (hex distance). */
export const CYCLE_RANGE = 48;
/** The columns within CYCLE_RANGE: the ones a sample is drawn from. */
export const CYCLE_COLUMNS = hexDiscCount(CYCLE_RANGE);
/** A standing body under the open sky loses a level of depth this often on average in dry weather: three game days. */
export const DRY_MEAN_S = 4320;
/** Running water loses a level this often on average in dry weather: two game days. */
export const STREAM_DRY_MEAN_S = 2880;
/** A body with no open sky over any of its cells (a cave pool, a roofed cistern) dries this many times slower. */
export const ROOF_DRY_FACTOR = 10;
/**
 * The spring keeps a stream's head wet: when a stream that is down to a trickle (shallow) dries, its STREAM_HEAD_CELLS
 * highest cells stay shallow, all year, whatever the drought. The rest of its bed fills again in the rain.
 */
export const STREAM_HEAD_CELLS = 3;
/** A body under the open sky gains a level this often on average in full rain; a dry bed or a clay basin takes its first water as often. */
export const FILL_MEAN_S = 360;
/** Most seconds one `waterStep` of the debug handle runs. */
export const WATER_STEP_MAX_S = 14400;

/**
 * @typedef {Object} WaterEnv  the weather, injected (main's stand-in: no rain, dryness 1)
 * @property {(q: number, r: number) => number} rain  how hard it rains over column (q, r), 0..1 (0: dry)
 * @property {() => number} dryness  how fast water dries, a factor on the drying rates (about 1 in the dry season, less in the rains; 0: not at all)
 */

/**
 * @typedef {Object} CycleWorld
 * @property {(q: number, y: number, r: number) => number} peek
 * @property {(q: number, r: number) => boolean} isLoadedCell
 * @property {number} q   the player's column
 * @property {number} r
 * @property {((q: number, r: number) => number)|null} [springLevelAt]
 * @property {((q: number, y: number, r: number) => number)|null} [originAt]
 * @property {number} [top]  the highest cell worth looking at (default: the world's top)
 * @property {(q: number, r: number, out: { blocks: Uint8Array|null, base: number }) => boolean} [column]  the cells of a loaded
 *   column, read straight from its chunk: cell y is `out.blocks[out.base + y]` (false: not there, `peek` is used). Optional:
 *   only a faster way to the same blocks.
 * @property {(cq: number, cr: number) => (Uint8Array|null)} [chunkBlocks]  the blocks of a loaded chunk (CONTRACTS §0
 *   layout), null when it is not loaded: what `AquiferIndex` finds the aquifers in (§89)
 * @property {(q: number, r: number, range: number) => number[]} [aquifers]  the aquifer cells within `range` of column
 *   (q, r) as (q, y, r) triples, when the world lists them itself (tests); else `WaterCycle.feed` finds them through
 *   `chunkBlocks` (§89)
 */

/** Scratch for `CycleWorld.column`. @type {{ blocks: Uint8Array|null, base: number }} */
const COLUMN = { blocks: null, base: 0 };

/**
 * @typedef {Object} CycleEvent  one thing the cycle did
 * @property {'dry'|'fill'|'bed'|'basin'|'feed'|'seep'} kind  a body lost a level; a body gained one; a dry natural bed took
 *   its first water again; a clay basin did; (§89) a body an aquifer feeds gained a level from it; a dry basin on an
 *   aquifer (or an emptied stream head over one) took its first water
 * @property {number} q @property {number} y @property {number} r  the cell it was found at
 * @property {number} count       the cells of the body, bed or basin
 * @property {boolean} stream     running water (a body or a bed)
 * @property {'fresh'|'tainted'} quality
 * @property {number[]} writes    the cells to write, as (q, y, r, id) quadruples
 */

/** The chance per look of something that happens once every `meanS` seconds to a thing found in ONE column. */
function lookChance(dt, meanS) {
  return (dt * CYCLE_COLUMNS) / (CYCLE_SAMPLES * meanS);
}

/** `random()` as an index below `n`. */
function pickIndex(random, n) {
  return Math.min(n - 1, Math.floor(random() * n));
}

/** @returns {boolean} `id` is open to water: AIR, or flowing / falling water */
function isOpenCell(id) {
  return id === B.AIR || (isWater(id) && !isWaterSource(id));
}

/**
 * What the cycle finds in column (q, r), looking down from `top`:
 *  - the stream's own cell, when a stream runs here: its water (`water`), or — open — its dry bed (`spring`);
 *  - else the highest source of the column (`water`; `sky` false when an opaque block lies over it);
 *  - with `beds` (it rains), under the open sky: an open cell that lies on a block (leaves, plants and glass are looked
 *    through for the next one down) — `bed` when that cell was generated as a source and the block is solid, `basin`
 *    when it is AIR on CLAY;
 *  - else the highest source of the column (`water`; `sky` false when an opaque block lies over it).
 * @param {CycleWorld} w @param {number} q @param {number} r
 * @param {boolean} [beds]  look for dry beds and basins too
 * @returns {{ kind: 'water'|'spring'|'bed'|'basin', y: number, sky: boolean }|null}
 */
export function columnWater(w, q, r, beds = false) {
  const peek = w.peek;
  const top = w.top ?? WORLD_HEIGHT - 1;
  const level = w.springLevelAt ? w.springLevelAt(q, r) : -1;
  if (level >= 0 && level <= top) {
    const id = peek(q, level, r);
    if (isWaterSource(id) && !isTaintedWater(id)) return { kind: 'water', y: level, sky: hasSky(peek, q, level, r, top) };
    if (isOpenCell(id)) return beds && hasSky(peek, q, level, r, top) ? { kind: 'spring', y: level, sky: true } : null;
  }
  // The column is read straight from its chunk when the world can hand it over (48 columns of 128 cells a second).
  const direct = typeof w.column === 'function' && w.column(q, r, COLUMN);
  const blocks = direct ? COLUMN.blocks : null;
  const base = direct ? COLUMN.base : 0;
  let roof = false;
  let open = true; // the cell above y is open (AIR or flowing water) …
  let air = true; // … and AIR
  for (let y = top; y >= 0; y--) {
    const id = blocks !== null ? blocks[base + y] : peek(q, y, r);
    if (id === B.AIR) {
      open = true;
      air = true;
      continue;
    }
    const kind = CELL_KIND[id];
    if (kind === KIND_SOURCE) return { kind: 'water', y, sky: !roof };
    if (kind === KIND_FLOWING) {
      open = true;
      air = false;
      continue;
    }
    if (id === UNLOADED) return null;
    if (beds && !roof && open && y < top && kind === KIND_OPAQUE && isSolid(id)) {
      // (the ground itself: leaves, glass and plants over it are looked through, and what a cell was generated as is
      // asked once a column)
      if (w.originAt && isWaterSource(w.originAt(q, y + 1, r))) return { kind: 'bed', y: y + 1, sky: true };
      if (air && id === B.CLAY) return { kind: 'basin', y: y + 1, sky: true };
    }
    if (kind === KIND_OPAQUE) roof = true;
    open = false;
    air = false;
  }
  return null;
}

/** The cells within two cells of a cell, itself included: what `isDeepInBody` vouches for. */
const BIG_BODY_CELLS = hexDiscCount(2);

/**
 * @returns {boolean} every cell within two cells of (q, y, r), at its height, holds the same standing water `id` (the
 *   same kind at the same depth, and not running water): they are all one body, which therefore has at least
 *   BIG_BODY_CELLS cells at that depth
 */
function isDeepInBody(w, q, y, r, id) {
  const cells = discCells(2);
  const springAt = w.springLevelAt ?? null;
  const fresh = !isTaintedWater(id);
  for (let i = 0; i < cells.length; i += 2) {
    const nq = q + cells[i];
    const nr = r + cells[i + 1];
    if (w.peek(nq, y, nr) !== id) return false;
    if (fresh && springAt !== null && springAt(nq, nr) === y) return false;
  }
  return true;
}

/** What a block is to the look down a column: a source, flowing water, an opaque block (a roof), or anything else. */
const KIND_SOURCE = 1;
const KIND_FLOWING = 2;
const KIND_OPAQUE = 3;
const CELL_KIND = new Uint8Array(256);
for (let id = 0; id < 256; id++) CELL_KIND[id] = isWaterSource(id) ? KIND_SOURCE : isWater(id) ? KIND_FLOWING : isOpaque(id) ? KIND_OPAQUE : 0;

/** @returns {boolean} some cell of `body` has the open sky over it */
function bodyHasSky(w, body) {
  const top = w.top ?? WORLD_HEIGHT - 1;
  const cells = body.cells;
  for (let i = 0; i < cells.length; i += 3) if (hasSky(w.peek, cells[i], cells[i + 1], cells[i + 2], top)) return true;
  return false;
}

/**
 * The dry bed that cell (q, y, r) is part of (§83): the connected open cells that were generated as one body's water.
 *  - a STREAM's bed (`spring`): the open cells of the stream, joined along it from column to column;
 *  - a standing pool's bed: the open cells at this height generated as sources of the bed's quality, each on a floor (a
 *    solid block, or a FULL source: water under it fills first). A bed whose generated body is the sea is none: the
 *    sea comes back by itself.
 * At most BODY_MAX_CELLS cells. Every cell becomes shallow water of the quality it was generated as.
 * @param {CycleWorld} w @param {number} q @param {number} y @param {number} r @param {boolean} spring
 * @returns {{ cells: number[], count: number, tainted: boolean }|null}
 */
export function dryBedAt(w, q, y, r, spring) {
  const peek = w.peek;
  const springAt = w.springLevelAt ?? null;
  const originAt = w.originAt ?? null;
  let tainted = false;
  if (spring) {
    if (springAt === null || springAt(q, r) !== y || !isOpenCell(peek(q, y, r))) return null;
  } else {
    if (originAt === null) return null;
    const origin = originAt(q, y, r);
    if (!isWaterSource(origin) || !isOpenCell(peek(q, y, r)) || !isBedFloor(peek(q, y - 1, r))) return null;
    tainted = isTaintedWater(origin);
    // the sea's bed is the sea's business (fluids.js): its generated body is looked at as fluids looks at it
    const generated = waterBodyAt(originAt, q, y, r, springAt);
    if (generated === null || generated.sea || generated.stream || generated.truncated) return null;
  }
  const cells = [q, y, r];
  const seen = new Set([`${q},${y},${r}`]);
  for (let i = 0; i < cells.length && cells.length < BODY_MAX_CELLS * 3; i += 3) {
    for (let j = 0; j < 6 && cells.length < BODY_MAX_CELLS * 3; j++) {
      const nq = cells[i] + HEX_DIRS[j][0];
      const nr = cells[i + 2] + HEX_DIRS[j][1];
      let ny = cells[i + 1];
      if (spring) {
        ny = /** @type {(q: number, r: number) => number} */ (springAt)(nq, nr);
        if (ny < 0 || !isOpenCell(peek(nq, ny, nr))) continue;
      } else {
        if (!isOpenCell(peek(nq, ny, nr)) || !isBedFloor(peek(nq, ny - 1, nr))) continue;
        const origin = /** @type {(q: number, y: number, r: number) => number} */ (originAt)(nq, ny, nr);
        if (!isWaterSource(origin) || isTaintedWater(origin) !== tainted) continue;
        if (!tainted && springAt !== null && springAt(nq, nr) === ny) continue; // the stream's own cell
      }
      const key = `${nq},${ny},${nr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push(nq, ny, nr);
    }
  }
  return { cells, count: cells.length / 3, tainted };
}

/** @returns {boolean} a dry bed's cell can take water over `below`: a solid block or a FULL source */
function isBedFloor(below) {
  return isSolid(below) || waterDepth(below) === 3;
}

/**
 * The dry clay basin that cell (q, y, r) is part of (§83, "clay holds rain"): the connected AIR cells at this height
 * that lie on CLAY, when every other side neighbour of every one of them is solid or a source — a basin that would hold
 * water. Null when it would not (an open side, a cell off the clay), when it is larger than BODY_MAX_CELLS cells, or when
 * (q, y, r) is not AIR on CLAY.
 * @param {CycleWorld} w @param {number} q @param {number} y @param {number} r
 * @returns {{ cells: number[], count: number, tainted: boolean }|null}
 */
export function clayBasinAt(w, q, y, r) {
  const peek = w.peek;
  if (peek(q, y, r) !== B.AIR || peek(q, y - 1, r) !== B.CLAY) return null;
  const cells = [q, y, r];
  const seen = new Set([`${q},${r}`]);
  for (let i = 0; i < cells.length; i += 3) {
    for (let j = 0; j < 6; j++) {
      const nq = cells[i] + HEX_DIRS[j][0];
      const nr = cells[i + 2] + HEX_DIRS[j][1];
      const n = peek(nq, y, nr);
      if (isSolid(n) || isWaterSource(n)) continue;
      if (n !== B.AIR || peek(nq, y - 1, nr) !== B.CLAY) return null; // open, and not part of the basin: it would not hold
      const key = `${nq},${nr}`;
      if (seen.has(key)) continue;
      if (cells.length >= BODY_MAX_CELLS * 3) return null;
      seen.add(key);
      cells.push(nq, y, nr);
    }
  }
  return { cells, count: cells.length / 3, tainted: false };
}

/**
 * One step of the water cycle: at most one event.
 * CYCLE_SAMPLES times: one `random()` picks a column within CYCLE_RANGE of the player (`spread.discCells` order). In a
 * loaded column that holds something (`columnWater`), one more `random()` is the roll; an event that happens once every
 * M seconds to a thing of N cells takes a roll below `dt × CYCLE_COLUMNS / (CYCLE_SAMPLES × M × N)` — the thing is found
 * through each of its N columns, so that is once every M seconds for the BODY, whatever its size:
 *  - DRY weather (`env.rain(q, r)` is 0), a body of water: it loses a level of depth every DRY_MEAN_S / dryness
 *    (× ROOF_DRY_FACTOR with no open sky over any of its cells), but a FED body (§89) none below its seasonal target
 *    (`aquiferTarget`); running water every STREAM_DRY_MEAN_S / dryness;
 *  - RAIN, a body of water under the open sky that is not full: it gains a level every FILL_MEAN_S / rain;
 *  - RAIN, a dry natural bed or a dry clay basin under the open sky: every cell of it becomes shallow water, as often.
 * The sea never changes, water under water neither dries nor fills, and a body cut by an unloaded chunk waits.
 * @param {number} dt seconds
 * @param {() => number} random
 * @param {CycleWorld} w
 * @param {WaterEnv} env
 * @returns {CycleEvent|null} the first thing that happened
 */
export function cycleStep(dt, random, w, env) {
  if (!(dt > 0)) return null;
  const range = discCells(CYCLE_RANGE);
  const dryness = Math.max(0, Number(env.dryness()) || 0);
  for (let s = 0; s < CYCLE_SAMPLES; s++) {
    const i = pickIndex(random, CYCLE_COLUMNS) * 2;
    const q = w.q + range[i];
    const r = w.r + range[i + 1];
    if (!w.isLoadedCell(q, r)) continue;
    const rain = Math.max(0, Math.min(1, Number(env.rain(q, r)) || 0));
    const found = columnWater(w, q, r, rain > 0);
    if (found === null) continue;
    if (found.kind !== 'water') {
      const u = random();
      const p1 = lookChance(dt, FILL_MEAN_S / rain);
      if (!(u < p1)) continue; // (not even a bed of one cell would fill)
      const bed = found.kind === 'basin' ? clayBasinAt(w, q, found.y, r) : dryBedAt(w, q, found.y, r, found.kind === 'spring');
      if (bed === null || !(u < p1 / bed.count)) continue;
      /** @type {number[]} */
      const writes = [];
      for (let k = 0; k < bed.cells.length; k += 3) {
        // (a basin's cell that was generated as tainted water comes back tainted: the generated quality wins)
        const tainted = found.kind === 'basin' ? !!w.originAt && isTaintedWater(w.originAt(bed.cells[k], bed.cells[k + 1], bed.cells[k + 2])) : bed.tainted;
        writes.push(bed.cells[k], bed.cells[k + 1], bed.cells[k + 2], waterAtDepth(tainted, 1));
      }
      return {
        kind: found.kind === 'basin' ? 'basin' : 'bed', q, y: found.y, r, count: bed.count, stream: found.kind === 'spring',
        quality: bed.tainted ? 'tainted' : 'fresh', writes,
      };
    }
    const u = random();
    // The most this roll could ask for (a body of one cell): below it, the body is worth finding.
    const p1 = rain > 0 ? lookChance(dt, FILL_MEAN_S / rain) : dryness > 0 ? lookChance(dt, Math.min(DRY_MEAN_S, STREAM_DRY_MEAN_S) / dryness) : 0;
    if (!(u < p1)) continue;
    // Before the body is searched, two cheap looks spare most of a coast's samples the search (the sea is the largest
    // body there is, and the one nothing happens to):
    const id = w.peek(q, found.y, r);
    const running = !!w.springLevelAt && w.springLevelAt(q, r) === found.y;
    // in rain a full cell has nothing to gain (a body gains a level in its shallowest cells, and is found through them);
    if (rain > 0 && waterDepth(id) === 3) continue;
    // and a cell with standing water of its kind and depth all round it, two cells out, is one of 19 such cells at least.
    if (!running && !(u < p1 / BIG_BODY_CELLS) && isDeepInBody(w, q, found.y, r, id)) continue;
    const body = waterBodyAt(w.peek, q, found.y, r, w.springLevelAt ?? null);
    if (body === null || body.covered || isBeyondUse(body)) continue;
    // A body gains a level in its shallowest cells and loses one from its deepest (`depthWrites`): it is found through
    // those N cells, all of a level body.
    const depth = waterDepth(id);
    if (rain > 0) {
      if (body.minDepth >= 3 || depth !== body.minDepth || !(u < p1 / body.levels[depth])) continue;
      if (!found.sky && !bodyHasSky(w, body)) continue;
      return { kind: 'fill', q, y: found.y, r, count: body.count, stream: body.stream, quality: body.quality, writes: depthWrites(w, body, 1) };
    }
    if (depth !== body.depth) continue;
    let mean = (body.stream ? STREAM_DRY_MEAN_S : DRY_MEAN_S) / dryness;
    if (!(u < lookChance(dt, mean) / body.levels[depth])) continue;
    if (!body.stream && !found.sky && !bodyHasSky(w, body)) {
      mean *= ROOF_DRY_FACTOR;
      if (!(u < lookChance(dt, mean) / body.levels[depth])) continue;
    }
    // §89: the sun dries a fed pool no lower than its seasonal target (asked only once the roll has won)
    if (!body.stream && depth <= aquiferTarget(dryness) && bodyFed(w, body)) continue;
    // a stream down to a trickle dries from its mouth up, and its head never does (the spring behind it)
    const writes = body.stream && depth === 1 ? streamDryWrites(w, body) : depthWrites(w, body, -1);
    if (writes.length === 0) continue;
    return { kind: 'dry', q, y: found.y, r, count: body.count, stream: body.stream, quality: body.quality, writes };
  }
  return null;
}

/**
 * The writes by which a shallow STREAM dries: every shallow cell becomes AIR but its head. The head is the cells an
 * AQUIFER feeds (§89: `aquiferUnder` — in generation 6 the stream's first cell, over the aquifer at the floor of its
 * column); a stream with none of them (generations 3–5) keeps its STREAM_HEAD_CELLS highest (where the spring is; ties go
 * to the smaller q, then r). A stream that is only its head any more loses nothing.
 * @param {WaterWorld} w @param {WaterBody} body
 * @returns {number[]} (q, y, r, id) quadruples
 */
export function streamDryWrites(w, body) {
  /** @type {number[][]} */
  const shallow = [];
  const cells = body.cells;
  for (let i = 0; i < cells.length; i += 3) {
    if (waterDepth(w.peek(cells[i], cells[i + 1], cells[i + 2])) === 1) shallow.push([cells[i], cells[i + 1], cells[i + 2]]);
  }
  if (shallow.length * 3 !== cells.length) return depthWrites(w, body, -1); // not all shallow yet: an ordinary level
  /** @type {number[]} */
  const out = [];
  const fed = shallow.filter((c) => aquiferUnder(w.peek, c[0], c[1], c[2]));
  if (fed.length > 0) {
    for (const c of shallow) if (!fed.includes(c)) out.push(c[0], c[1], c[2], BLOCK.AIR);
    return out;
  }
  shallow.sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2]);
  for (let i = STREAM_HEAD_CELLS; i < shallow.length; i++) out.push(shallow[i][0], shallow[i][1], shallow[i][2], BLOCK.AIR);
  return out;
}

// ---- The aquifer (§89): the one thing besides rain that makes water ---------------------------------------------------

/** One game hour in seconds: AQUIFER_FLOW is given per game hour. */
export const AQUIFER_HOUR_S = DAY_LENGTH_SECONDS / 24;
/**
 * What an aquifer gives, in cell-levels of water a game hour: `rains` at the dryness of the rains (weather.DRYNESS_RAINS),
 * `dry` at the dry season's (DRYNESS_DRY), in a straight line between and no further either way. A fed body that rises
 * N cells at a time gains a level about every N / flow game hours: a small basin fills fast and a big one slowly.
 */
export const AQUIFER_FLOW = Object.freeze({ rains: 12, dry: 3 });
/** Below this dryness (half way from the rains' to the dry season's: the turn of the season) a fed body rises to FULL, from it on to LOW. */
export const AQUIFER_FULL_BELOW = (DRYNESS_RAINS + DRYNESS_DRY) / 2;
/** No sun and no gulp takes a fed body below this depth: shallow. Never dry. */
export const AQUIFER_FLOOR = 1;
/** The most cells round the player `aquiferNear` of the debug handle looks (the cycle itself looks CYCLE_RANGE). */
export const AQUIFER_NEAR_MAX = 256;

/**
 * @param {number} dryness  the season's (weather.seasonOf(day).dryness)
 * @returns {number} what an aquifer gives at that dryness, in cell-levels a game hour (AQUIFER_FLOW; the dry season's
 *   when the dryness is not a number)
 */
export function aquiferFlow(dryness) {
  if (!Number.isFinite(dryness)) return AQUIFER_FLOW.dry;
  const t = Math.max(0, Math.min(1, (dryness - DRYNESS_RAINS) / (DRYNESS_DRY - DRYNESS_RAINS)));
  return AQUIFER_FLOW.rains + (AQUIFER_FLOW.dry - AQUIFER_FLOW.rains) * t;
}

/**
 * @param {number} dryness @returns {number} the depth a fed body rises to: 3 (full) in the rains, 2 (low) in the dry
 *   season (from AQUIFER_FULL_BELOW on, and when the dryness is not a number)
 */
export function aquiferTarget(dryness) {
  return dryness < AQUIFER_FULL_BELOW ? 3 : 2;
}

/**
 * @returns {boolean} the first cell under (q, y, r) that is not falling water is an AQUIFER: what stands in (q, y, r) is
 *   what that aquifer feeds (the falling water under a stream's lip is looked through)
 */
export function aquiferUnder(peek, q, y, r) {
  let yy = y - 1;
  let id = peek(q, yy, r);
  while (id === B.WATER_FALL && yy > 0) id = peek(q, --yy, r);
  return id === B.AQUIFER;
}

/**
 * @param {{ peek: (q: number, y: number, r: number) => number }} w @param {WaterBody} body
 * @returns {boolean} the body is FED (§89): fresh water, not the sea, with a cell over an aquifer (`aquiferUnder`)
 */
export function bodyFed(w, body) {
  if (body.tainted || body.sea) return false;
  const cells = body.cells;
  for (let i = 0; i < cells.length; i += 3) if (aquiferUnder(w.peek, cells[i], cells[i + 1], cells[i + 2])) return true;
  return false;
}

/**
 * The dry basin over an aquifer (§89) that cell (q, y, r) is part of: (q, y, r) is AIR on the AQUIFER, and the basin is
 * the connected AIR cells at this height that each lie on a solid block, when every other side neighbour of every one of
 * them is solid or a source — a basin that would hold water. Null when it would not (an open side, a cell over a drop, a
 * plant or a torch in the wall, a stream's own cell, an unloaded chunk), when it is larger than BODY_MAX_CELLS cells,
 * or when (q, y, r) is not AIR on an aquifer.
 * @param {CycleWorld|WaterWorld} w @param {number} q @param {number} y @param {number} r
 * @returns {{ cells: number[], count: number, tainted: boolean }|null}
 */
export function aquiferBasinAt(w, q, y, r) {
  const peek = w.peek;
  if (peek(q, y, r) !== B.AIR || peek(q, y - 1, r) !== B.AQUIFER) return null;
  const springAt = w.springLevelAt ?? null;
  const cells = [q, y, r];
  const seen = new Set([`${q},${r}`]);
  for (let i = 0; i < cells.length; i += 3) {
    for (let j = 0; j < 6; j++) {
      const nq = cells[i] + HEX_DIRS[j][0];
      const nr = cells[i + 2] + HEX_DIRS[j][1];
      const n = peek(nq, y, nr);
      if (isSolid(n) || isWaterSource(n)) continue;
      if (n !== B.AIR || !isSolid(peek(nq, y - 1, nr))) return null; // open, and no floor to hold water: it would spill
      if (springAt !== null && springAt(nq, nr) === y) return null; // a stream's dry bed is the stream's
      const key = `${nq},${nr}`;
      if (seen.has(key)) continue;
      if (cells.length >= BODY_MAX_CELLS * 3) return null;
      seen.add(key);
      cells.push(nq, y, nr);
    }
  }
  return { cells, count: cells.length / 3, tainted: false };
}

/**
 * What an aquifer at (q, y, r) feeds, as the cycle sees it (`feedStep`):
 *  - `stream`: a stream runs in its column above it (`springLevelAt`) — `y` is the stream's own cell; `open` when that
 *    cell and everything between are AIR or falling water (someone emptied the head);
 *  - `pool`: a fresh source stands on it (`y` its cell);
 *  - `basin`: AIR stands on it (`y` its cell);
 *  - `none`: anything else (a tainted pool, a block: the SPRING over one, the earth over a buried one).
 * @param {CycleWorld|WaterWorld} w @param {number} q @param {number} y @param {number} r
 * @returns {{ kind: 'stream'|'pool'|'basin'|'none', y: number, open: boolean }}
 */
export function aquiferFeeds(w, q, y, r) {
  const peek = w.peek;
  const level = w.springLevelAt ? w.springLevelAt(q, r) : -1;
  if (level > y) {
    let open = true;
    for (let yy = y + 1; yy < level && open; yy++) {
      const c = peek(q, yy, r);
      open = c === B.AIR || c === B.WATER_FALL;
    }
    return { kind: 'stream', y: level, open: open && isOpenCell(peek(q, level, r)) };
  }
  const id = peek(q, y + 1, r);
  if (isWaterSource(id) && !isTaintedWater(id)) return { kind: 'pool', y: y + 1, open: false };
  if (id === B.AIR) return { kind: 'basin', y: y + 1, open: true };
  return { kind: 'none', y: y + 1, open: false };
}

/**
 * One step of the aquifers (§89): what each aquifer of `aquifers` ((q, y, r) triples: those round the player) does in
 * `dt` seconds. It gives `aquiferFlow(env.dryness())` cell-levels a game hour (AQUIFER_HOUR_S). Each aquifer in a loaded
 * chunk with something it can feed draws ONE `random()` `u`, in list order; with `flow` as above and `N` the cells that
 * would change, an event that adds N cell-levels takes `u < dt × flow / (N × AQUIFER_HOUR_S)` (at most 1):
 *  - FEED: the fresh body standing on it (`waterBodyAt`) — contained, not the sea, not running water, not under water,
 *    not cut by an unloaded chunk — gains a level in its shallowest cells (`depthWrites`), while that is below its
 *    seasonal target (`aquiferTarget`: full in the rains, low in the dry season). N = those cells.
 *  - SEEP: the dry basin on it (`aquiferBasinAt`) takes its first water: every cell shallow and fresh. N = its cells.
 *  - SEEP: a stream's head over it that someone emptied (`aquiferFeeds` open) takes shallow water again: N = 1. The
 *    stream's water itself is not raised by the flow — it follows the rain; its head is kept in a drought
 *    (`streamDryWrites`).
 * A tainted pool on an aquifer gets nothing (fed water is fresh; the tainted water stays until it is gone). The roll is
 * drawn before the body is searched, and a body is searched only when the roll is below the chance for one cell.
 * @param {number} dt seconds
 * @param {() => number} random
 * @param {CycleWorld} w
 * @param {WaterEnv} env
 * @param {ArrayLike<number>} aquifers
 * @returns {CycleEvent[]} every event (most steps: none), in list order
 */
export function feedStep(dt, random, w, env, aquifers) {
  /** @type {CycleEvent[]} */
  const out = [];
  if (!(dt > 0)) return out;
  const dryness = Number(env.dryness());
  const flow = aquiferFlow(dryness);
  const target = aquiferTarget(dryness);
  const chance = (/** @type {number} */ n) => Math.min(1, (dt * flow) / (n * AQUIFER_HOUR_S));
  const one = chance(1); // the most any roll can ask: a body of one cell
  for (let i = 0; i + 2 < aquifers.length; i += 3) {
    const q = aquifers[i];
    const y = aquifers[i + 1];
    const r = aquifers[i + 2];
    if (!w.isLoadedCell(q, r) || w.peek(q, y, r) !== B.AQUIFER) continue;
    const feeds = aquiferFeeds(w, q, y, r);
    if (feeds.kind === 'none' || (feeds.kind === 'stream' && !feeds.open)) continue;
    const u = random();
    if (!(u < one)) continue;
    if (feeds.kind === 'stream') {
      out.push({ kind: 'seep', q, y: feeds.y, r, count: 1, stream: true, quality: 'fresh', writes: [q, feeds.y, r, B.WATER_SHALLOW] });
      continue;
    }
    if (feeds.kind === 'basin') {
      const basin = aquiferBasinAt(w, q, feeds.y, r);
      if (basin === null || !(u < chance(basin.count))) continue;
      /** @type {number[]} */
      const writes = [];
      for (let k = 0; k < basin.cells.length; k += 3) writes.push(basin.cells[k], basin.cells[k + 1], basin.cells[k + 2], B.WATER_SHALLOW);
      out.push({ kind: 'seep', q, y: feeds.y, r, count: basin.count, stream: false, quality: 'fresh', writes });
      continue;
    }
    const body = waterBodyAt(w.peek, q, feeds.y, r, w.springLevelAt ?? null);
    if (body === null || body.stream || body.sea || body.truncated || body.covered || !body.contained) continue;
    if (body.minDepth >= target || !(u < chance(body.levels[body.minDepth]))) continue;
    out.push({ kind: 'feed', q, y: feeds.y, r, count: body.count, stream: false, quality: 'fresh', writes: depthWrites(w, body, 1) });
  }
  return out;
}

/**
 * @typedef {Object} AquiferInfo  what an aquifer is doing (the debug handle's `aquiferNear`)
 * @property {number} q @property {number} y @property {number} r  the aquifer
 * @property {'stream'|'pool'|'basin'|'none'} feeds  what stands on it (`aquiferFeeds`)
 * @property {number} cells     the cells of the body it feeds (a stream: the stream; a dry basin: the basin; 0: none, or
 *   a basin that would not hold water)
 * @property {number} depth     that body's depth, 0..3 (a basin: 0)
 * @property {number} target    the depth it is fed up to in this season (a stream: AQUIFER_FLOOR, its head kept wet; none: 0)
 * @property {boolean} fed      it is fed now: a contained fresh body, a basin that holds, a stream (or its emptied head)
 */

/**
 * What the aquifer at (q, y, r) feeds, and how (§89; for the debug handle).
 * @param {CycleWorld} w @param {number} q @param {number} y @param {number} r @param {WaterEnv} env
 * @returns {AquiferInfo}
 */
export function aquiferInfo(w, q, y, r, env) {
  const feeds = aquiferFeeds(w, q, y, r);
  const target = aquiferTarget(Number(env.dryness()));
  /** @type {AquiferInfo} */
  const info = { q, y, r, feeds: feeds.kind, cells: 0, depth: 0, target: 0, fed: false };
  if (feeds.kind === 'basin') {
    const basin = aquiferBasinAt(w, q, feeds.y, r);
    return { ...info, cells: basin ? basin.count : 0, target, fed: basin !== null };
  }
  if (feeds.kind === 'none') return info;
  const body = feeds.open ? null : waterBodyAt(w.peek, q, feeds.y, r, w.springLevelAt ?? null);
  if (feeds.kind === 'stream') return { ...info, cells: body ? body.count : 0, depth: body ? body.depth : 0, target: AQUIFER_FLOOR, fed: true };
  if (body === null) return info;
  return {
    ...info, cells: body.count, depth: body.depth, target,
    fed: !body.stream && !body.sea && !body.covered && body.contained && !body.truncated,
  };
}

/** Chunks an AquiferIndex remembers before it starts over. */
const AQUIFER_INDEX_MAX = 4096;

/** @returns {number} a number naming chunk (cq, cr) */
function chunkNumber(cq, cr) {
  return (cq + 0x8000) * 0x10000 + (cr + 0x8000);
}

/**
 * Where the aquifers are (§89): every AQUIFER cell of a loaded chunk, found once by scanning its blocks
 * (`Uint8Array.indexOf`) and remembered for as long as the chunk keeps the same blocks array (a chunk loaded again, or a
 * new world, is scanned again). Generated aquifers never move; one set or taken away by a command is found again after
 * `changed` (main calls it from World.onBlockChange through `WaterCycle.onBlockChange`).
 */
export class AquiferIndex {
  constructor() {
    /** @type {Map<number, { blocks: Uint8Array, cells: Int32Array }>} chunk → its blocks and its aquifers' (q, y, r) */
    this.chunks = new Map();
  }

  /**
   * The aquifers within `range` (hex distance between columns) of column (q, r), in the loaded chunks (`w.chunkBlocks`;
   * none without it), as (q, y, r) triples, chunk by chunk.
   * @param {{ chunkBlocks?: (cq: number, cr: number) => (Uint8Array|null) }} w
   * @param {number} q @param {number} r @param {number} range
   * @returns {number[]}
   */
  near(w, q, r, range) {
    /** @type {number[]} */
    const out = [];
    if (typeof w.chunkBlocks !== 'function' || !(range >= 0)) return out;
    for (let cq = Math.floor((q - range) / CHUNK_SIZE); cq <= Math.floor((q + range) / CHUNK_SIZE); cq++) {
      for (let cr = Math.floor((r - range) / CHUNK_SIZE); cr <= Math.floor((r + range) / CHUNK_SIZE); cr++) {
        const key = chunkNumber(cq, cr);
        const blocks = w.chunkBlocks(cq, cr);
        if (!blocks) {
          this.chunks.delete(key);
          continue;
        }
        let entry = this.chunks.get(key);
        if (entry === undefined || entry.blocks !== blocks) {
          if (this.chunks.size >= AQUIFER_INDEX_MAX) this.chunks.clear();
          entry = { blocks, cells: scanAquifers(blocks, cq, cr) };
          this.chunks.set(key, entry);
        }
        const cells = entry.cells;
        for (let i = 0; i < cells.length; i += 3) if (hexLength(cells[i] - q, cells[i + 2] - r) <= range) out.push(cells[i], cells[i + 1], cells[i + 2]);
      }
    }
    return out;
  }

  /** A block of column (q, r) became or stopped being an AQUIFER: its chunk is scanned again when next asked about. */
  changed(q, r) {
    this.chunks.delete(chunkNumber(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)));
  }

  clear() {
    this.chunks.clear();
  }
}

/** @returns {Int32Array} the (q, y, r) of every AQUIFER in the blocks of chunk (cq, cr) */
function scanAquifers(blocks, cq, cr) {
  /** @type {number[]} */
  const out = [];
  for (let i = blocks.indexOf(B.AQUIFER); i >= 0; i = blocks.indexOf(B.AQUIFER, i + 1)) {
    const y = i % WORLD_HEIGHT;
    const col = (i - y) / WORLD_HEIGHT;
    const lr = col % CHUNK_SIZE;
    out.push(cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE, y, cr * CHUNK_SIZE + lr);
  }
  return Int32Array.from(out);
}

/**
 * The water cycle of one session: `step` is `cycleStep`, `feed` the aquifers' step (§89, `feedStep`), and it keeps count
 * for the debug handle. Nothing here is saved: a pool's depth is the blocks it is made of, and the aquifers are blocks.
 */
export class WaterCycle {
  constructor() {
    /** §89: where the aquifers round the player are */
    this.aquifers = new AquiferIndex();
    this.clear();
  }

  clear() {
    /** Levels of depth bodies lost to the sun. */
    this.dried = 0;
    /** Levels bodies gained from the rain. */
    this.filled = 0;
    /** Dry natural beds that took water again. */
    this.beds = 0;
    /** Dry clay basins that took their first water. */
    this.basins = 0;
    /** Levels pools lost to drinking and to pots (main counts them: `used()`). */
    this.drawn = 0;
    /** §89: levels bodies gained from the aquifers under them. */
    this.fed = 0;
    /** §89: dry basins on an aquifer (and emptied stream heads over one) that took their first water. */
    this.seeped = 0;
    /** @type {CycleEvent|null} the last event */
    this.last = null;
    this.aquifers.clear();
  }

  /** Events so far (the aquifers' too). */
  get events() {
    return this.dried + this.filled + this.beds + this.basins + this.fed + this.seeped;
  }

  /** A pool dropped a level because it was drunk from or a pot was filled. */
  used() {
    this.drawn++;
  }

  /**
   * @param {number} dt @param {() => number} random @param {CycleWorld} w @param {WaterEnv} env
   * @returns {CycleEvent|null} what to write
   */
  step(dt, random, w, env) {
    const ev = cycleStep(dt, random, w, env);
    if (ev) {
      if (ev.kind === 'dry') this.dried++;
      else if (ev.kind === 'fill') this.filled++;
      else if (ev.kind === 'bed') this.beds++;
      else this.basins++;
      this.last = ev;
    }
    return ev;
  }

  /**
   * §89: one step of the aquifers within CYCLE_RANGE of the player (`feedStep`): `w.aquifers` when the world lists them,
   * else the ones `this.aquifers` finds in `w.chunkBlocks`.
   * @param {number} dt @param {() => number} random @param {CycleWorld} w @param {WaterEnv} env
   * @returns {CycleEvent[]} what to write (most steps: nothing)
   */
  feed(dt, random, w, env) {
    const cells = typeof w.aquifers === 'function' ? w.aquifers(w.q, w.r, CYCLE_RANGE) : this.aquifers.near(w, w.q, w.r, CYCLE_RANGE);
    const evs = cells.length === 0 ? [] : feedStep(dt, random, w, env, cells);
    for (const ev of evs) {
      if (ev.kind === 'feed') this.fed++;
      else this.seeped++;
      this.last = ev;
    }
    return evs;
  }

  /** World.onBlockChange (§89): an aquifer set or taken away (a command) is looked for again in its chunk. */
  onBlockChange(q, _y, r, prev, next) {
    if (prev === B.AQUIFER || next === B.AQUIFER) this.aquifers.changed(q, r);
  }
}

/**
 * Write what an event or a draw lists: every (q, y, r, id) of `writes` whose cell is still water or open (a cell that has
 * become something else since is left alone), lazily, like regrowth and spread.
 * @param {{ getBlock: (q: number, y: number, r: number) => number, setBlock: (q: number, y: number, r: number, id: number, lazy?: boolean) => boolean }} world
 * @param {number[]} writes
 * @returns {number} cells written
 */
export function applyWaterWrites(world, writes) {
  let n = 0;
  for (let i = 0; i < writes.length; i += 4) {
    const now = world.getBlock(writes[i], writes[i + 1], writes[i + 2]);
    if (now !== B.AIR && !isWater(now)) continue;
    if (world.setBlock(writes[i], writes[i + 1], writes[i + 2], writes[i + 3], true)) n++;
  }
  return n;
}
