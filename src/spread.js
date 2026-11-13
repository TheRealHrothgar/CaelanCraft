// Caelancraft — plants that spread on their own (CONTRACTS §80). Once a second the game looks at a few random columns
// round the player; a plant found there may seed a neighbour, the less often the more of its kind already stand near
// it, and not at all at its kind's soft maximum. Now and then a plant comes up from nothing where none stands. So a
// patch you leave a few plants in comes back over the next days, and a place picked clean stays almost bare.
// Pure: the world is read through `getBlock`, every roll takes `random` ([0, 1)). Main writes the birth it is handed.
import { WORLD_HEIGHT } from './config.js';
import { BLOCK, isLeaves, isOpaque } from './blocks.js';
import { hexDiscCount } from './hex.js';
import { REED_WATER_REACH, SOIL_EARTH, cropOf, hasSky, waterNear } from './farming.js';

const B = BLOCK;

/** Random columns looked at every second. */
export const SPREAD_SAMPLES = 48;
/** They lie within this many cells of the player (hex distance). */
export const SPREAD_RANGE = 48;
/** A plant counts its own kind within this many cells of itself (itself included). */
export const SPREAD_RADIUS = 6;
/** A new plant comes up within this many cells of its parent. */
export const SPREAD_STEP = 3;
/** Neighbours are counted, and a seed lands, at most this many cells above or below the parent. */
export const SPREAD_RISE = 4;
/** One plant standing alone on open ground gives a new plant this often on average: three game days. */
export const SPREAD_MEAN_S = 4320;
/** The columns within SPREAD_RANGE: the ones a sample is drawn from. */
export const SPREAD_COLUMNS = hexDiscCount(SPREAD_RANGE);
/**
 * The chance that a sampled plant with none of its kind near it seeds a neighbour. A given column is sampled
 * SPREAD_SAMPLES / SPREAD_COLUMNS times a second, so this makes a lone plant's births one every SPREAD_MEAN_S.
 */
export const SPREAD_BIRTH = SPREAD_COLUMNS / (SPREAD_SAMPLES * SPREAD_MEAN_S);
/** Mean seconds between the moments a plant may come up from nothing somewhere in range: ten game days. */
export const SPONTANEOUS_MEAN_S = 14400;
/** A plant comes up from nothing only where no spreading plant of any kind stands within this many cells. */
export const SPONTANEOUS_CLEAR = 3;

/** A cave floor: where the mushrooms also grow, under a roof. */
const CAVE_FLOOR = Object.freeze([B.STONE]);
const NO_GROUND = Object.freeze([]);

/**
 * @typedef {Object} SpreadKind
 * @property {string} key
 * @property {number} index                 its place in SPREAD_KINDS
 * @property {ReadonlyArray<number>} blocks  the blocks that are this kind, ripe and picked alike
 * @property {number} born                  the block a new plant comes up as
 * @property {ReadonlyArray<number>} soil   the ground it comes up on
 * @property {number} cap                   its soft maximum within SPREAD_RADIUS: at this many it seeds no more
 * @property {boolean} shade                a mushroom: it wants cover instead of sky (leaves or a roof over `soil`)
 * @property {ReadonlyArray<number>} cave   a shade kind's other ground, taken only under a roof
 * @property {boolean} reed                 it comes up only with water within farming.REED_WATER_REACH
 */

/**
 * @param {string} key @param {number[]} blocks @param {number} born @param {ReadonlyArray<number>} soil @param {number} cap
 * @param {{ shade?: boolean, cave?: ReadonlyArray<number>, reed?: boolean }} [o]
 */
const kind = (key, blocks, born, soil, cap, o = {}) => ({ key, index: 0, blocks: Object.freeze(blocks), born, soil, cap, shade: false, cave: NO_GROUND, reed: false, ...o });
/** A kind that is also a crop: it comes up as the crop's grown block, on the crop's soil (farming.js CROPS). */
const crop = (key, blocks, cap) => {
  const c = /** @type {import('./farming.js').CropDef} */ (cropOf(key));
  return kind(key, blocks, c.grown, c.soil, cap, { reed: c.reed });
};

/**
 * Every kind of plant that spreads, one row each: the nine crops first (in farming.js CROPS order), then the two
 * mushrooms, which cannot be planted and only spread. Roots and mushrooms come up ripe; a bush, a thicket, a Healwort
 * and a prickly pear come up PICKED and fruit when Regrowth says so. To add a kind, add its row.
 * @type {ReadonlyArray<SpreadKind>}
 */
export const SPREAD_KINDS = Object.freeze([
  crop('carrot', [B.CARROT_PLANT], 8),
  crop('onion', [B.ONION_PLANT], 8),
  crop('tuber', [B.TUBER_PLANT], 6),
  crop('honeyberry', [B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE], 5),
  crop('hazel', [B.HAZEL_THICKET, B.HAZEL_THICKET_BARE], 4),
  crop('crab_apple', [B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE], 4),
  crop('healwort', [B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE], 3),
  crop('prickly_pear', [B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE], 5),
  crop('cattails', [B.CATTAILS], 10),
  kind('honeycap', [B.HONEYCAP_MUSHROOM], B.HONEYCAP_MUSHROOM, SOIL_EARTH, 8, { shade: true, cave: CAVE_FLOOR }),
  kind('frecklecap', [B.FRECKLECAP_MUSHROOM], B.FRECKLECAP_MUSHROOM, SOIL_EARTH, 6, { shade: true, cave: CAVE_FLOOR }),
].map((k, index) => Object.freeze({ ...k, index })));

/** Block id → the index of its kind in SPREAD_KINDS, or −1. */
const KIND_OF_BLOCK = new Int8Array(256).fill(-1);
for (const k of SPREAD_KINDS) {
  for (const id of k.blocks) {
    if (KIND_OF_BLOCK[id] >= 0) throw new Error(`spread: block ${id} is in two kinds`);
    KIND_OF_BLOCK[id] = k.index;
  }
}

/** @param {number} id @returns {SpreadKind|null} the spreading kind a block is */
export function spreadKindOf(id) {
  return Number.isInteger(id) && id >= 0 && id < 256 && KIND_OF_BLOCK[id] >= 0 ? SPREAD_KINDS[KIND_OF_BLOCK[id]] : null;
}

/**
 * How freely a plant seeds with `n` of its kind within SPREAD_RADIUS (itself included): 1 for a plant alone, falling in
 * a straight line to 0 at the cap and staying 0 beyond it. `(cap − n) / (cap − 1)`.
 * @param {number} n @param {number} cap @returns {number} 0..1
 */
export function crowding(n, cap) {
  if (!(cap > 1)) return 0;
  return Math.min(1, Math.max(0, (cap - n) / (cap - 1)));
}

/** The chance a sampled plant seeds a neighbour in `dt` seconds. @param {number} n @param {number} cap @param {number} [dt] */
export function birthChance(n, cap, dt = 1) {
  return Math.min(1, SPREAD_BIRTH * crowding(n, cap) * dt);
}

/** @type {Map<number, Int16Array>} radius → the disc's cells as (dq, dr) pairs */
const DISCS = new Map();

/**
 * The cells within `radius` of (0, 0) as (dq, dr) pairs, dq rising then dr rising: hexDiscCount(radius) of them, the
 * middle one (0, 0). Cached; do not write to it.
 * @param {number} radius @returns {Int16Array}
 */
export function discCells(radius) {
  let cells = DISCS.get(radius);
  if (!cells) {
    cells = new Int16Array(hexDiscCount(radius) * 2);
    let i = 0;
    for (let dq = -radius; dq <= radius; dq++) {
      for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
        cells[i++] = dq;
        cells[i++] = dr;
      }
    }
    DISCS.set(radius, cells);
  }
  return cells;
}

/** `random()` as an index below `n`. */
function pickIndex(random, n) {
  return Math.min(n - 1, Math.floor(random() * n));
}

/**
 * The plant of column (q, r) that can seed: the highest spreading plant, looking down from `top`. A plant that needs
 * the sky does not seed from under a roof (an opaque block above it; leaves let the light through), so the look goes
 * on down past it: a mushroom may stand in a cave below.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} q @param {number} r @param {number} [top]
 * @returns {{ y: number, kind: SpreadKind }|null}
 */
export function spreaderAt(getBlock, q, r, top = WORLD_HEIGHT - 1) {
  let roofed = false;
  for (let y = top; y >= 1; y--) {
    const id = getBlock(q, y, r);
    if (id === B.AIR) continue;
    const k = KIND_OF_BLOCK[id] ?? -1;
    if (k >= 0) {
      if (SPREAD_KINDS[k].shade || !roofed) return { y, kind: SPREAD_KINDS[k] };
    } else if (isOpaque(id)) roofed = true;
  }
  return null;
}

/**
 * How many plants of `kind` stand within SPREAD_RADIUS cells of (q, y, r), that cell included: one per column that
 * holds the kind within SPREAD_RISE cells above or below y.
 * @param {(q: number, y: number, r: number) => number} getBlock @param {SpreadKind} kind
 * @returns {number}
 */
export function countKind(getBlock, kind, q, y, r) {
  const cells = discCells(SPREAD_RADIUS);
  let n = 0;
  for (let i = 0; i < cells.length; i += 2) {
    for (let yy = y - SPREAD_RISE; yy <= y + SPREAD_RISE; yy++) {
      if (KIND_OF_BLOCK[getBlock(q + cells[i], yy, r + cells[i + 1])] === kind.index) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** @returns {boolean} a spreading plant of any kind stands within `reach` cells of (q, y, r), SPREAD_RISE up or down */
export function plantNear(getBlock, q, y, r, reach) {
  const cells = discCells(reach);
  for (let i = 0; i < cells.length; i += 2) {
    for (let yy = y - SPREAD_RISE; yy <= y + SPREAD_RISE; yy++) {
      if (KIND_OF_BLOCK[getBlock(q + cells[i], yy, r + cells[i + 1])] >= 0) return true;
    }
  }
  return false;
}

/** What is over cell (q, y, r): 2 a roof (an opaque block), 1 leaves only, 0 nothing. */
function coverOver(getBlock, q, y, r, top) {
  let cover = 0;
  for (let yy = y + 1; yy <= top; yy++) {
    const id = getBlock(q, yy, r);
    if (isOpaque(id)) return 2;
    if (isLeaves(id)) cover = 1;
  }
  return cover;
}

/**
 * Whether a plant of `kind` can come up in cell (q, y, r): the cell is AIR over the kind's soil and under the open sky,
 * with water beside it for a reed. A shade kind (a mushroom) wants cover instead of sky: its soil under leaves or a
 * roof, or its cave ground under a roof.
 * @param {(q: number, y: number, r: number) => number} getBlock @param {SpreadKind} kind
 * @param {number} q @param {number} y @param {number} r @param {number} [top]
 * @returns {boolean}
 */
export function canGrowAt(getBlock, kind, q, y, r, top = WORLD_HEIGHT - 1) {
  if (!(y >= 1 && y <= top) || getBlock(q, y, r) !== B.AIR) return false;
  const below = getBlock(q, y - 1, r);
  if (kind.shade) {
    if (kind.soil.includes(below)) return coverOver(getBlock, q, y, r, top) > 0;
    return kind.cave.includes(below) && coverOver(getBlock, q, y, r, top) === 2;
  }
  if (!kind.soil.includes(below)) return false;
  if (kind.reed && !waterNear(getBlock, q, y, r, REED_WATER_REACH)) return false;
  return hasSky(getBlock, q, y, r, top);
}

/**
 * Where a seed of `kind` from a parent at height `y` lands in column (q, r): the highest cell within SPREAD_RISE of y
 * in which the kind can grow, or −1.
 * @returns {number}
 */
export function siteNear(getBlock, kind, q, r, y, top = WORLD_HEIGHT - 1) {
  for (let yy = Math.min(top, y + SPREAD_RISE); yy >= y - SPREAD_RISE; yy--) if (canGrowAt(getBlock, kind, q, yy, r, top)) return yy;
  return -1;
}

/**
 * The open cell on top of column (q, r): the cell above the first block that is neither AIR nor leaves, looking down
 * from `top`, when that cell is AIR; else −1 (leaves resting on the ground, a full column).
 * @returns {number}
 */
export function surfaceCell(getBlock, q, r, top = WORLD_HEIGHT - 1) {
  for (let y = top; y >= 0; y--) {
    const id = getBlock(q, y, r);
    if (id === B.AIR || isLeaves(id)) continue;
    return y < top && getBlock(q, y + 1, r) === B.AIR ? y + 1 : -1;
  }
  return -1;
}

/**
 * @typedef {Object} SpreadWorld
 * @property {(q: number, y: number, r: number) => number} getBlock
 * @property {(q: number, r: number) => boolean} isLoadedCell
 * @property {number} q   the player's column
 * @property {number} r
 * @property {number} [top]  the highest cell worth looking at (default: the world's top)
 */

/**
 * @typedef {Object} Birth  one new plant to write
 * @property {number} q @property {number} y @property {number} r   the cell (AIR when it was chosen)
 * @property {number} id     the block: the kind's `born`
 * @property {SpreadKind} kind
 * @property {boolean} seeded  true: a plant nearby seeded it (`parent` is that plant's cell); false: it came from nothing
 * @property {[number, number, number]|null} parent
 */

/**
 * One step of spreading: at most one birth.
 * 1. SPREAD_SAMPLES times: one `random()` picks a column within SPREAD_RANGE of the player (`discCells` order). In a
 *    loaded column whose `spreaderAt` is a plant with a `birthChance` above 0 (its kind counted by `countKind`), one
 *    more `random()` below that chance makes it seed; a third picks one of the other columns within SPREAD_STEP of it,
 *    and when that column is loaded and has a `siteNear`, the new plant comes up there and the step ends. A seed that
 *    finds no site is lost.
 * 2. With no birth so far, one `random()` below `dt / SPONTANEOUS_MEAN_S` is the moment for a plant from nothing: one
 *    more picks a column in range; when it is loaded, has a `surfaceCell` and no spreading plant within
 *    SPONTANEOUS_CLEAR cells of it, one more picks among the kinds that can grow there (`canGrowAt`), if any.
 * @param {number} dt seconds
 * @param {() => number} random
 * @param {SpreadWorld} world
 * @returns {Birth|null}
 */
export function spreadStep(dt, random, world) {
  if (!(dt > 0)) return null;
  const { getBlock, isLoadedCell } = world;
  const top = world.top ?? WORLD_HEIGHT - 1;
  const range = discCells(SPREAD_RANGE);
  const step = discCells(SPREAD_STEP);
  const others = step.length / 2 - 1;
  for (let s = 0; s < SPREAD_SAMPLES; s++) {
    const i = pickIndex(random, SPREAD_COLUMNS) * 2;
    const q = world.q + range[i];
    const r = world.r + range[i + 1];
    if (!isLoadedCell(q, r)) continue;
    const plant = spreaderAt(getBlock, q, r, top);
    if (!plant) continue;
    const p = birthChance(countKind(getBlock, plant.kind, q, plant.y, r), plant.kind.cap, dt);
    if (!(p > 0) || !(random() < p)) continue;
    let j = pickIndex(random, others);
    if (j >= others / 2) j++; // the middle cell is the parent's own
    const sq = q + step[j * 2];
    const sr = r + step[j * 2 + 1];
    if (!isLoadedCell(sq, sr)) continue;
    const sy = siteNear(getBlock, plant.kind, sq, sr, plant.y, top);
    if (sy < 0) continue;
    return { q: sq, y: sy, r: sr, id: plant.kind.born, kind: plant.kind, seeded: true, parent: [q, plant.y, r] };
  }
  if (!(random() < Math.min(1, dt / SPONTANEOUS_MEAN_S))) return null;
  const i = pickIndex(random, SPREAD_COLUMNS) * 2;
  const q = world.q + range[i];
  const r = world.r + range[i + 1];
  if (!isLoadedCell(q, r)) return null;
  const y = surfaceCell(getBlock, q, r, top);
  if (y < 0 || plantNear(getBlock, q, y, r, SPONTANEOUS_CLEAR)) return null;
  const able = SPREAD_KINDS.filter((k) => canGrowAt(getBlock, k, q, y, r, top));
  if (able.length === 0) return null;
  const kindHere = able[pickIndex(random, able.length)];
  return { q, y, r, id: kindHere.born, kind: kindHere, seeded: false, parent: null };
}

/**
 * The spreading of one session: `step` is `spreadStep`, and it keeps count for the debug handle (how many plants
 * were seeded, how many came from nothing, and the last birth). Nothing here is saved: a new plant is an ordinary
 * edit of the world.
 */
export class Spread {
  constructor() {
    this.clear();
  }

  clear() {
    /** Plants seeded by a plant nearby. */
    this.seeded = 0;
    /** Plants that came up from nothing. */
    this.spontaneous = 0;
    /** @type {Birth|null} the last birth */
    this.last = null;
  }

  /** Births so far. */
  get births() {
    return this.seeded + this.spontaneous;
  }

  /** @param {number} dt @param {() => number} random @param {SpreadWorld} world @returns {Birth|null} the plant to write */
  step(dt, random, world) {
    const birth = spreadStep(dt, random, world);
    if (birth) {
      if (birth.seeded) this.seeded++;
      else this.spontaneous++;
      this.last = birth;
    }
    return birth;
  }
}
