// Caelancraft — water that runs out (CONTRACTS §83): what the water in a cell is, what drinking and filling a pot take
// from a pool, and the water cycle: pools dry in the sun and fill in the rain, dry beds and clay basins catch the rain.
// The bodies themselves — one level of a pool, the sea, running water — and the three laws they obey are fluids.js's.
// Pure: the world is read through `peek`, every roll takes `random` ([0, 1)), rain and season come through an injected
// `env`. Nothing here writes: every result lists the cells to write, and main writes them.
import { WORLD_HEIGHT } from './config.js';
import {
  BLOCK, UNLOADED, isOpaque, isSolid, isWater, isWaterSource, isTaintedWater, waterDepth, waterAtDepth,
} from './blocks.js';
import { HEX_DIRS, hexDiscCount } from './hex.js';
import { BODY_MAX_CELLS, waterBodyAt, waterSourceOf } from './fluids.js';
import { hasSky } from './farming.js';
import { discCells } from './spread.js';

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
 * running water (the cycle alone changes a stream); water under water is taken from the top of its pool.
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
 */

/** Scratch for `CycleWorld.column`. @type {{ blocks: Uint8Array|null, base: number }} */
const COLUMN = { blocks: null, base: 0 };

/**
 * @typedef {Object} CycleEvent  one thing the cycle did
 * @property {'dry'|'fill'|'bed'|'basin'} kind  a body lost a level; a body gained one; a dry natural bed took its first
 *   water again; a clay basin did
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
 *    (× ROOF_DRY_FACTOR with no open sky over any of its cells); running water every STREAM_DRY_MEAN_S / dryness;
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
    return { kind: 'dry', q, y: found.y, r, count: body.count, stream: body.stream, quality: body.quality, writes: depthWrites(w, body, -1) };
  }
  return null;
}

/**
 * The water cycle of one session: `step` is `cycleStep`, and it keeps count for the debug handle. Nothing here is saved:
 * a pool's depth is the blocks it is made of.
 */
export class WaterCycle {
  constructor() {
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
    /** @type {CycleEvent|null} the last event */
    this.last = null;
  }

  /** Events so far. */
  get events() {
    return this.dried + this.filled + this.beds + this.basins;
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
