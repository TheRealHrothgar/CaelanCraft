// Caelancraft — farming (CONTRACTS §80): what can be planted and on which ground, what makes a planted cell watered and
// open to the sky, the hints a crop shows, and Growth, the tracker that rolls for every planted seed and sprout.
// Pure: the world is read through `getBlock`, the water's quality and the rain through callbacks, every roll takes
// `random` ([0, 1)).
//
// A crop has two blocks, PLANTED_<KIND> and <KIND>_SPROUT (blocks.js, ids 133–150). The block id is the whole state of a
// planted cell and every step is a memoryless chance per second, so a save needs no field for farming: Growth finds the
// cells again in World.edits, exactly as harvest.js Regrowth finds the picked bushes.
import { WORLD_HEIGHT } from './config.js';
import { BLOCK, CROP_ROWS, FARM_IDS, getBlockDef, isFarmBlock, isOpaque, isWater } from './blocks.js';
import { itemName } from './items.js';
import { forEachEditedCell } from './coords.js';

const B = BLOCK;

/** A planted cell is watered when fresh water lies within this many cells of it (hex distance). */
export const FARM_WATER_REACH = 4;
/** A reed (the cattail) does nothing at all without water this near. */
export const REED_WATER_REACH = 1;
/** §84: a planted cell is watered, too, when rain fell on it within this many seconds (one game day). */
export const RAIN_WATERS_S = 1440;
/** Mean seconds before a planted seed's sprouting moment comes: one game day watered, three dry. */
export const SPROUT_MEAN_S = Object.freeze({ watered: 1440, dry: 4320 });
/** The chance that a seed takes at that moment (it becomes a sprout); otherwise it fails and the cell is AIR again. */
export const SEED_TAKES = Object.freeze({ watered: 0.8, dry: 0.35 });
/** Mean seconds before a sprout grows up: two game days watered, five dry. */
export const GROW_MEAN_S = Object.freeze({ watered: 2880, dry: 7200 });
/** A planted block broken by hand gives its seed back this often (a sprout gives nothing). */
export const SEED_BACK_P = 0.5;
/** A seed that fails is told in the log only when the player is within this many cells of it. */
export const FAIL_NOTICE_CELLS = 24;
/** Growth tracks at most this many planted cells and sprouts. */
export const MAX_GROWTH_TRACKED = 4096;

/** Grass or dirt: where most things grow. */
export const SOIL_EARTH = Object.freeze([B.GRASS_BLOCK, B.DIRT]);
/** Sand of either colour: the prickly pear's ground. */
export const SOIL_SAND = Object.freeze([B.SAND, B.RED_SAND]);
/** A pond's bank: the cattail's ground. */
export const SOIL_SHORE = Object.freeze([B.GRASS_BLOCK, B.DIRT, B.SAND]);
/** What a hint calls each kind of ground. @type {Readonly<Record<number, string>>} */
export const SOIL_WORDS = Object.freeze({
  [B.GRASS_BLOCK]: 'grass', [B.DIRT]: 'dirt', [B.SAND]: 'sand', [B.RED_SAND]: 'red sand', [B.STONE]: 'stone',
});

/**
 * @typedef {Object} CropDef
 * @property {string} key             the kind: 'carrot', 'onion', …
 * @property {number} index           its place in CROPS (and in the PLANTED_* / *_SPROUT id runs)
 * @property {string} name            the crop's name ("Wild Carrot": blocks.js CROP_ROWS)
 * @property {ReadonlyArray<string>} from  the items that plant it
 * @property {string} back            the item a planted block broken by hand may give back
 * @property {number} planted         its PLANTED_* block
 * @property {number} sprout          its *_SPROUT block
 * @property {number} grown           the block a grown sprout becomes (a bush grows up PICKED: Regrowth brings its fruit)
 * @property {ReadonlyArray<number>} soil  the blocks it may be planted on
 * @property {boolean} reed           needs water within REED_WATER_REACH to do anything at all
 */

/**
 * The rest of each crop's row, by kind (the order, the ids and the names come from blocks.js CROP_ROWS). `back` is the
 * first `from` item unless stated: a planted Cactus Fruit comes back unpeeled, whichever of the two went in.
 * @type {Record<string, { from: string[], back?: string, grown: number, soil: ReadonlyArray<number>, reed?: boolean }>}
 */
const CROP_DATA = {
  carrot: { from: ['carrot_seeds'], grown: B.CARROT_PLANT, soil: SOIL_EARTH },
  onion: { from: ['onion_seeds', 'wild_onion'], grown: B.ONION_PLANT, soil: SOIL_EARTH },
  tuber: { from: ['wild_tuber'], grown: B.TUBER_PLANT, soil: SOIL_EARTH },
  honeyberry: { from: ['honeyberries'], grown: B.HONEYBERRY_BUSH_BARE, soil: SOIL_EARTH },
  hazel: { from: ['hazelnuts'], grown: B.HAZEL_THICKET_BARE, soil: SOIL_EARTH },
  crab_apple: { from: ['crab_apple'], grown: B.CRAB_APPLE_BUSH_BARE, soil: SOIL_EARTH },
  healwort: { from: ['healwort_seeds'], grown: B.HEALWORT_PLANT_BARE, soil: SOIL_EARTH },
  prickly_pear: { from: ['cactus_fruit', 'unpeeled_cactus_fruit'], back: 'unpeeled_cactus_fruit', grown: B.PRICKLY_PEAR_BARE, soil: SOIL_SAND },
  cattails: { from: ['cattail_root'], grown: B.CATTAILS, soil: SOIL_SHORE, reed: true },
};

/** The nine crops, in block-id order. @type {ReadonlyArray<CropDef>} */
export const CROPS = Object.freeze(CROP_ROWS.map(([, key, name], index) => {
  const d = CROP_DATA[key];
  return Object.freeze({
    key, index, name, from: Object.freeze([...d.from]), back: d.back ?? d.from[0], planted: B.PLANTED_CARROT + index,
    sprout: B.CARROT_SPROUT + index, grown: d.grown, soil: d.soil, reed: d.reed === true,
  });
}));

/** Item key → the kind of crop it plants. @type {Readonly<Record<string, string>>} */
export const PLANTABLE = Object.freeze(Object.fromEntries(CROPS.flatMap((c) => c.from.map((k) => [k, c.key]))));

/** @type {Readonly<Record<string, CropDef>>} */
const CROP_BY_KEY = Object.freeze(Object.fromEntries(CROPS.map((c) => [c.key, c])));

/** @param {string} kind @returns {CropDef|null} the crop of a kind key */
export function cropOf(kind) {
  return typeof kind === 'string' && Object.hasOwn(CROP_BY_KEY, kind) ? CROP_BY_KEY[kind] : null;
}

/** @param {string|null|undefined} key an item key @returns {CropDef|null} the crop it plants */
export function cropOfItem(key) {
  return typeof key === 'string' && Object.hasOwn(PLANTABLE, key) ? CROP_BY_KEY[PLANTABLE[key]] : null;
}

/** @param {number} id @returns {boolean} a PLANTED_* block: a seed in the ground */
export function isPlanted(id) {
  return id >= B.PLANTED_CARROT && id < B.CARROT_SPROUT;
}

/** @param {number} id @returns {boolean} a *_SPROUT block */
export function isSprout(id) {
  return id >= B.CARROT_SPROUT && id <= B.CATTAILS_SPROUT;
}

/** @param {number} id @returns {CropDef|null} the crop of a planted block or a sprout */
export function cropOfBlock(id) {
  if (!Number.isInteger(id) || !isFarmBlock(id)) return null;
  return CROPS[(id - B.PLANTED_CARROT) % CROPS.length];
}

/** "grass or dirt", "grass, dirt or sand". @param {ReadonlyArray<number>} soil @returns {string} */
export function soilWords(soil) {
  const words = soil.map((id) => SOIL_WORDS[id] ?? getBlockDef(id).displayName.toLowerCase());
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

// ---- The ground, the sky and the water ---------------------------------------------------------------------------------

/**
 * Open sky over cell (q, y, r): no opaque block anywhere above it in its column. Leaves and glass let the light
 * through; a roof of planks, a cave and a tree trunk do not.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} [top] the highest cell to look at (the world's top)
 * @returns {boolean}
 */
export function hasSky(getBlock, q, y, r, top = WORLD_HEIGHT - 1) {
  for (let yy = y + 1; yy <= top; yy++) if (isOpaque(getBlock(q, yy, r))) return false;
  return true;
}

/**
 * Water near the plant in cell (q, y, r): a water cell within `reach` cells (hex distance) at the level of the soil under
 * it (y − 1), one below or one above. With `isFresh`, only a cell it accepts counts.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} reach
 * @param {((q: number, y: number, r: number) => boolean)|null} [isFresh]
 * @returns {boolean}
 */
export function waterNear(getBlock, q, y, r, reach, isFresh = null) {
  for (let dq = -reach; dq <= reach; dq++) {
    const lo = Math.max(-reach, -dq - reach);
    const hi = Math.min(reach, -dq + reach);
    for (let dr = lo; dr <= hi; dr++) {
      for (let yy = y; yy >= y - 2; yy--) {
        if (isWater(getBlock(q + dq, yy, r + dr)) && (!isFresh || isFresh(q + dq, yy, r + dr))) return true;
      }
    }
  }
  return false;
}

/**
 * @typedef {'fresh'|'salt'|'tainted'} WaterQuality  what survivalControl.waterKind calls a water cell
 * @typedef {{ sky: boolean, watered: boolean, reed: boolean, rain?: boolean }} CropState
 *   `sky` open sky above; `watered` fresh water within FARM_WATER_REACH, or (§84) rain on the cell within RAIN_WATERS_S;
 *   `rain` (present, and true, only then) the rain alone waters it: no fresh water in reach; `reed` false only for a
 *   cattail with no water within REED_WATER_REACH
 * @typedef {(q: number, y: number, r: number) => boolean} RainedFn  rain fell on cell (q, y, r) within RAIN_WATERS_S
 *   (main: the rain reaches the cell, weather.rainExposure, and it rained there, weather.rainedWithin; snow is not rain)
 */

/**
 * What the plant in cell (q, y, r) has: sky, water, and (a reed) water beside it. Fresh water is water that is neither
 * tainted nor salt, judged as the drinking code judges it (`waterQuality`: main's waterQualityOf); without the callback
 * every water counts as fresh. With no fresh water in reach, rain that fell on the cell (`rained`, §84) waters it as
 * well. A reed takes any water to stand in, but rain is not water to stand in.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {((q: number, y: number, r: number) => WaterQuality)|null|undefined} waterQuality
 * @param {number} q @param {number} y @param {number} r @param {CropDef} crop
 * @param {RainedFn|null} [rained]
 * @returns {CropState}
 */
export function cropState(getBlock, waterQuality, q, y, r, crop, rained = null) {
  const isFresh = waterQuality ? (wq, wy, wr) => waterQuality(wq, wy, wr) === 'fresh' : null;
  const near = waterNear(getBlock, q, y, r, FARM_WATER_REACH, isFresh);
  const rain = !near && !!rained && rained(q, y, r);
  /** @type {CropState} */
  const state = {
    sky: hasSky(getBlock, q, y, r),
    watered: near || rain,
    reed: !crop.reed || waterNear(getBlock, q, y, r, REED_WATER_REACH),
  };
  if (rain) state.rain = true;
  return state;
}

// ---- Planting ------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Planting
 * @property {CropDef} crop
 * @property {number} block               the PLANTED_* block to write
 * @property {[number, number, number]} cell  where: the cell above the soil
 * @property {string} hint                the target hint: `Grass Block · R: plant Carrot Seeds`
 */

/**
 * What R would plant with item `key` in hand, aiming at the TOP of the block in cell (q, y, r): the soil must suit the
 * crop and the cell above it must be AIR. Main writes `block` at `cell` the way a player places a block and uses up one
 * item.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {string|null|undefined} key the selected item
 * @returns {Planting|null} null when the item plants nothing or this ground will not do
 */
export function plantAt(getBlock, key, q, y, r) {
  const crop = cropOfItem(key);
  if (!crop || !(y >= 0 && y + 1 < WORLD_HEIGHT)) return null;
  const soil = getBlock(q, y, r);
  if (!crop.soil.includes(soil) || getBlock(q, y + 1, r) !== B.AIR) return null;
  return {
    crop, block: crop.planted, cell: [q, y + 1, r],
    hint: `${getBlockDef(soil).displayName} · R: plant ${itemName(/** @type {string} */ (key))}`,
  };
}

/**
 * The hint for the wrong ground: a plantable item in hand, aiming at the top of a block with AIR above that its crop
 * does not grow in. `Carrot Seeds grow in grass or dirt`, `Cactus Fruit grows in sand or red sand`.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {string|null|undefined} key the selected item
 * @returns {string|null} null when the item plants nothing, the ground suits it, or the cell above is taken
 */
export function wrongGroundHint(getBlock, key, q, y, r) {
  const crop = cropOfItem(key);
  if (!crop || crop.soil.includes(getBlock(q, y, r)) || getBlock(q, y + 1, r) !== B.AIR) return null;
  const name = itemName(/** @type {string} */ (key));
  return `${name} ${/s$/.test(name) ? 'grow' : 'grows'} in ${soilWords(crop.soil)}`;
}

/**
 * The target hint of a planted cell or a sprout: `Planted Wild Carrot · watered` (§84: `… · watered by rain` when only
 * the rain waters it), `… · dry: slow, and it may not take` (a sprout has taken already: `… · dry: slow`),
 * `… · needs open sky`, and for a cattail away from water `… · needs water beside it`.
 * @param {number} id a PLANTED_* or *_SPROUT block
 * @param {CropState} state
 * @returns {string|null} null for any other block
 */
export function farmHint(id, state) {
  const crop = cropOfBlock(id);
  if (!crop) return null;
  const name = getBlockDef(id).displayName;
  if (!state.sky) return `${name} · needs open sky`;
  if (!state.reed) return `${name} · needs water beside it`;
  if (state.watered) return `${name} · ${state.rain ? 'watered by rain' : 'watered'}`;
  return `${name} · ${isPlanted(id) ? 'dry: slow, and it may not take' : 'dry: slow'}`;
}

/** The log line of a seed that failed: `A planted Wild Carrot did not take.` @param {CropDef} crop @returns {string} */
export function failLine(crop) {
  return `A planted ${crop.key === 'cattails' ? 'Cattail' : crop.name} did not take.`;
}

// ---- Growth ----------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} GrowthEvent  one cell to write
 * @property {number} q @property {number} y @property {number} r
 * @property {number} from   the block the cell held (main writes only when it still does)
 * @property {number} to     the sprout, the grown plant, or AIR for a seed that did not take
 * @property {CropDef} crop
 * @property {boolean} took  false for a seed that did not take
 */

/**
 * Tracks the planted cells and sprouts (at most MAX_GROWTH_TRACKED). Main feeds it World.onBlockChange and
 * `loadFromEdits`, and while Survival is active calls `step(1, random, isLoadedCell, getBlock, waterQuality, rained)` once a
 * second, writing each returned event with `world.setBlock` (the write comes back through onBlockChange: a sprout is
 * tracked again, a grown plant or a failed seed is not).
 */
export class Growth {
  constructor() {
    /** @type {Map<string, { q: number, y: number, r: number, id: number }>} "q,y,r" → the cell and its farm block */
    this.cells = new Map();
  }

  get size() {
    return this.cells.size;
  }

  /** @returns {boolean} */
  has(q, y, r) {
    return this.cells.has(`${q},${y},${r}`);
  }

  /** Track a farm cell (no-op when full; a known cell takes the new id). @param {number} id @returns {boolean} tracked */
  track(q, y, r, id) {
    if (!Number.isInteger(id) || !isFarmBlock(id)) return false;
    const key = `${q},${y},${r}`;
    if (!this.cells.has(key) && this.cells.size >= MAX_GROWTH_TRACKED) return false;
    this.cells.set(key, { q, y, r, id });
    return true;
  }

  /** @returns {boolean} whether it was tracked */
  untrack(q, y, r) {
    return this.cells.delete(`${q},${y},${r}`);
  }

  /** World.onBlockChange. */
  onBlockChange(q, y, r, _prev, next) {
    if (isFarmBlock(next)) this.track(q, y, r, next);
    else this.untrack(q, y, r);
  }

  /** Track every farm cell recorded in World.edits (worldgen never emits one, so they are always edits). */
  loadFromEdits(edits) {
    this.clear();
    for (const id of FARM_IDS) forEachEditedCell(edits, id, (q, y, r) => this.track(q, y, r, id));
  }

  clear() {
    this.cells.clear();
  }

  /**
   * One step. Cells in unloaded chunks are frozen (no roll). Every other tracked cell draws one `random()`, in tracking
   * order: its moment comes with probability `min(1, dt / mean)`, the mean being SPROUT_MEAN_S (a planted seed) or
   * GROW_MEAN_S (a sprout), `watered` or `dry`. Nothing happens without open sky, nor to a reed without water beside
   * it. The world is looked at only when the roll is below the watered chance, so a big field costs nothing; the
   * outcome is the same as looking first. At its moment a planted seed draws once more: it takes with probability
   * SEED_TAKES (watered or dry) and becomes its sprout, else it fails and the cell becomes AIR. A sprout becomes its
   * crop's `grown` block. Cells with an event stop being tracked (main's write tracks a sprout again).
   * @param {number} dt seconds
   * @param {() => number} random
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @param {(q: number, y: number, r: number) => number} getBlock
   * @param {((q: number, y: number, r: number) => WaterQuality)|null} [waterQuality]
   * @param {RainedFn|null} [rained]  rain fell on the cell within RAIN_WATERS_S: it then counts as watered (§84)
   * @returns {GrowthEvent[]} the cells to write
   */
  step(dt, random, isLoadedCell, getBlock, waterQuality = null, rained = null) {
    /** @type {GrowthEvent[]} */
    const out = [];
    if (!(dt > 0)) return out;
    for (const [key, c] of this.cells) {
      if (!isLoadedCell(c.q, c.r)) continue;
      const crop = /** @type {CropDef} */ (cropOfBlock(c.id));
      const seed = isPlanted(c.id);
      const mean = seed ? SPROUT_MEAN_S : GROW_MEAN_S;
      const u = random();
      if (!(u < Math.min(1, dt / mean.watered))) continue;
      const state = cropState(getBlock, waterQuality, c.q, c.y, c.r, crop, rained);
      if (!state.sky || !state.reed) continue;
      if (!state.watered && !(u < Math.min(1, dt / mean.dry))) continue;
      const took = !seed || random() < (state.watered ? SEED_TAKES.watered : SEED_TAKES.dry);
      out.push({ q: c.q, y: c.y, r: c.r, from: c.id, to: !took ? B.AIR : seed ? crop.sprout : crop.grown, crop, took });
      this.cells.delete(key);
    }
    return out;
  }
}
