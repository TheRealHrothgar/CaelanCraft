// Caelancraft — a place to stay: natural springs, wells, rain barrels (PURE). See src/CONTRACTS.md §85.
//
// The land favours moving on: pools dry, food comes back slowly, herds are few. Staying in one place takes water all
// the year. Three things give it, each a little:
// - a SPRING, rare and found, not made: clean ground water coming up by itself, a few draws a day;
// - a WELL, built: it reaches down to the same water, which is raw, and fills slowly — slower in the dry season,
//   slower still in the desert, and wells dug close together share what the ground gives;
// - a RAIN BARREL, built: it catches the rain and keeps it, and what is poured into it, for the dry months.
// Nothing here is saved: a drawn spring, a drawn well and a barrel's water are each a block id, and everything that
// comes back does so by a memoryless chance per second, like the picked bushes of harvest.js (Regrowth).
import { DAY_LENGTH_SECONDS } from './config.js';
import { BLOCK, BIOME, isRainBarrel, isWell } from './blocks.js';
import { hexLength } from './hex.js';
import { forEachEditedCell } from './coords.js';
import { DRYNESS_RAINS, DRYNESS_DRY } from './weather.js';

const B = BLOCK;

/** A draught at a spring is worth this many gulps of water at once, and never poisons. */
export const SPRING_DRAUGHT = 3;
/** A drawn spring wells up again after this many seconds on average: a fifth of a game day, whatever the season. */
export const SPRING_MEAN_S = DAY_LENGTH_SECONDS / 5;
/** The pot a Clay Pot becomes at a spring: safe to drink as it is. */
export const SPRING_POT = 'pot_spring';
/** A drink at a well is this many gulps of fresh, raw water (each with the usual risk). */
export const WELL_GULPS = 2;
/** The pot a Clay Pot becomes at a well and at a rain barrel: fresh water, raw. */
export const WELL_POT = 'pot_water';
/**
 * A drawn well is full again after this many seconds on average: `rains` at the dryness of the rains
 * (weather.DRYNESS_RAINS), `dry` at the dry season's (DRYNESS_DRY), in a straight line between.
 */
export const WELL_MEAN_S = Object.freeze({ rains: 240, dry: 720 });
/** In the desert the ground gives a well its water this many times as slowly. */
export const WELL_DESERT_FACTOR = 3;
/** Wells within this many cells of each other (hex distance between their columns) share the ground's water. */
export const WELL_SHARE = 12;
/**
 * What a well may be dug into: the block under it must be one of these (earth, sand, gravel or clay — not rock).
 * Snowy grass is grass: without it no well could be set on untouched snowy land.
 * @type {readonly number[]}
 */
export const WELL_GROUND = Object.freeze([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT, B.SAND, B.RED_SAND, B.GRAVEL, B.CLAY]);
/** The refusal when a well is set on anything else. */
export const WELL_GROUND_HINT = 'A Well is dug into earth, sand, gravel or clay';
/** A rain barrel holds this many pots of water. */
export const BARREL_POTS = 3;
/** Under the open sky a barrel gains a pot after this many seconds of the hardest rain on average (÷ the rain reaching it). */
export const BARREL_FILL_MEAN_S = 240;
/**
 * The pots that water a crop by hand and that a barrel takes: fresh water raw or boiled, and spring water. Tainted and
 * salt water will not do.
 */
export const WATERING_POTS = Object.freeze(['pot_water', 'pot_boiled', 'pot_spring']);
/** The pot every use of one gives back. */
export const EMPTY_POT = 'clay_pot';
/** The most cells the tracker follows (wells, drawn springs and barrels that are not full). */
export const MAX_REFILL_TRACKED = 1024;
/** The target hint of a spring while someone is trying to dig it out in Survival: it cannot be broken there. */
export const SPRING_DEEP_HINT = 'Spring · the rock runs deep: it cannot be broken';
/** §89: the target hint of an aquifer while someone is trying to dig it: nothing can. */
export const AQUIFER_DEEP_HINT = 'Aquifer · water rises through this rock: it cannot be dug';

/**
 * How far away the nearest spring usually is, in cells: what worldgen's rule aims at (NATURAL_SPRING_CELL and
 * NATURAL_SPRING_CHANCE; worldgenHomestead.test.js holds the measured median inside it) and what the guide tells.
 */
export const SPRING_NEAREST_CELLS = Object.freeze([40, 80]);

/** The words on the target hints. */
export const HOMESTEAD_HINT = Object.freeze({
  springDrink: 'Spring · R: drink',
  springFill: 'Spring · R: fill the pot',
  springDrawn: 'Spring · drawn, it wells up again',
  wellDrink: 'Well · full · R: drink',
  wellFill: 'Well · full · R: fill the pot',
  wellDrawn: 'Well · drawn, it is filling',
});

/**
 * The hint of a block that Survival cannot break and that says why (§85: a spring; §89: an aquifer). Null for every
 * other block.
 * @param {number} id @returns {string|null}
 */
export function deepHint(id) {
  if (id === B.AQUIFER) return AQUIFER_DEEP_HINT;
  return id === B.SPRING || id === B.SPRING_DRAWN ? SPRING_DEEP_HINT : null;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Mean seconds for a drawn well to fill: WELL_MEAN_S.rains at dryness DRYNESS_RAINS (0.3) to WELL_MEAN_S.dry at
 * DRYNESS_DRY (1), in a straight line between (and no further either way); × WELL_DESERT_FACTOR in the DESERT; × the
 * number of wells that share the ground with it, itself included.
 * @param {number} dryness  weather.seasonOf(day).dryness
 * @param {number} biome    the biome of the well's column
 * @param {number} [wells]  wells within WELL_SHARE cells of it, itself included (at least 1)
 * @returns {number}
 */
export function wellMeanS(dryness, biome, wells = 1) {
  const t = clamp((dryness - DRYNESS_RAINS) / (DRYNESS_DRY - DRYNESS_RAINS), 0, 1);
  const season = WELL_MEAN_S.rains + (WELL_MEAN_S.dry - WELL_MEAN_S.rains) * (Number.isFinite(t) ? t : 1);
  return season * (biome === BIOME.DESERT ? WELL_DESERT_FACTOR : 1) * Math.max(1, Math.floor(wells) || 1);
}

/** @param {number} id @returns {number} the pots a rain barrel holds, 0..BARREL_POTS; −1 for anything else */
export function barrelPots(id) {
  return isRainBarrel(id) ? id - B.RAIN_BARREL : -1;
}

/** @param {number} pots @returns {number} the rain barrel block that holds `pots` pots (clamped to 0..BARREL_POTS) */
export function barrelWith(pots) {
  return B.RAIN_BARREL + clamp(Math.floor(pots) || 0, 0, BARREL_POTS);
}

/** `2 pots of 3`, `1 pot of 3`. @param {number} pots @returns {string} */
function potsOf(pots) {
  return `${pots} ${pots === 1 ? 'pot' : 'pots'} of ${BARREL_POTS}`;
}

/**
 * @typedef {Object} HomesteadAction
 * @property {'draw'|'homestead_hint'} kind  `draw`: R does something; `homestead_hint`: it only says how things stand
 * @property {number} q @property {number} y @property {number} r   the block
 * @property {'spring'|'well'|'barrel'} source
 * @property {'drink'|'fill'|'pour'} [mode]  draw: drink from it, fill the empty pot in hand, pour the pot in hand in
 * @property {string} [gives]   fill: the pot the Clay Pot becomes; pour: the empty pot that comes back
 * @property {number} [gulps]   drink: how many gulps of fresh water it is worth
 * @property {boolean} [safe]   drink: it cannot poison (spring water)
 * @property {number} [to]      draw: the block the cell becomes
 * @property {string} hint
 */

/**
 * What R does on a spring, a well or a rain barrel with `selectedKey` in hand (interactKind's step 7d), or null for
 * any other block.
 * - SPRING: an empty Clay Pot is filled with spring water; anything else, a draught. Either way it is drawn.
 * - WELL: an empty Clay Pot is filled with fresh raw water; anything else, a drink. Either way it is drawn.
 * - a drawn spring or well only says that it is filling.
 * - RAIN BARREL: an empty Clay Pot takes a pot of fresh raw water out (when it holds any); a Pot of Water, of Boiled
 *   Water or of Spring Water is poured in (when there is room); otherwise it says what it holds.
 * @param {number} id the block @param {string|null} selectedKey @param {number} q @param {number} y @param {number} r
 * @returns {HomesteadAction|null}
 */
export function homesteadAction(id, selectedKey, q, y, r) {
  const pot = selectedKey === EMPTY_POT;
  const H = HOMESTEAD_HINT;
  switch (id) {
    case B.SPRING:
      return pot
        ? { kind: 'draw', q, y, r, source: 'spring', mode: 'fill', gives: SPRING_POT, to: B.SPRING_DRAWN, hint: H.springFill }
        : { kind: 'draw', q, y, r, source: 'spring', mode: 'drink', gulps: SPRING_DRAUGHT, safe: true, to: B.SPRING_DRAWN, hint: H.springDrink };
    case B.SPRING_DRAWN:
      return { kind: 'homestead_hint', q, y, r, source: 'spring', hint: H.springDrawn };
    case B.WELL:
      return pot
        ? { kind: 'draw', q, y, r, source: 'well', mode: 'fill', gives: WELL_POT, to: B.WELL_DRAWN, hint: H.wellFill }
        : { kind: 'draw', q, y, r, source: 'well', mode: 'drink', gulps: WELL_GULPS, safe: false, to: B.WELL_DRAWN, hint: H.wellDrink };
    case B.WELL_DRAWN:
      return { kind: 'homestead_hint', q, y, r, source: 'well', hint: H.wellDrawn };
    default:
  }
  const pots = barrelPots(id);
  if (pots < 0) return null;
  const holds = pots === 0 ? 'Rain Barrel · empty' : `Rain Barrel · ${potsOf(pots)}`;
  if (pot) {
    if (pots === 0) return { kind: 'homestead_hint', q, y, r, source: 'barrel', hint: `${holds}: it fills in the rain` };
    return { kind: 'draw', q, y, r, source: 'barrel', mode: 'fill', gives: WELL_POT, to: barrelWith(pots - 1), hint: `${holds} · R: fill the pot` };
  }
  if (selectedKey !== null && WATERING_POTS.includes(selectedKey)) {
    if (pots >= BARREL_POTS) return { kind: 'homestead_hint', q, y, r, source: 'barrel', hint: `${holds} · full` };
    return { kind: 'draw', q, y, r, source: 'barrel', mode: 'pour', gives: EMPTY_POT, to: barrelWith(pots + 1), hint: `${holds} · R: pour it in` };
  }
  return {
    kind: 'homestead_hint', q, y, r, source: 'barrel',
    hint: pots === 0 ? `${holds}: it fills in the rain` : `${holds} · R with an empty pot: take water`,
  };
}

// ---- What comes back by itself --------------------------------------------------------------------------------------

/** The blocks the tracker follows: a drawn spring, every well (a full one only to be counted), a barrel with room. */
export const REFILL_IDS = Object.freeze([B.SPRING_DRAWN, B.WELL, B.WELL_DRAWN, B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2]);

/** @param {number} id @returns {boolean} the tracker follows it */
export function isRefillBlock(id) {
  return id === B.SPRING_DRAWN || isWell(id) || (id >= B.RAIN_BARREL && id <= B.RAIN_BARREL_2);
}

/**
 * @typedef {Object} RefillEnv  what the step asks of the world's weather (main: the live weather; tests: anything)
 * @property {() => number} dryness                          the season's dryness (weather.seasonOf(day).dryness)
 * @property {(q: number, r: number) => number} biome        the biome of a column
 * @property {(q: number, y: number, r: number) => number} rain  the rain REACHING a cell, 0..1 (weather.rainReaching:
 *   0 under a roof, a third under leaves, 0 where it falls as snow)
 */
/** @typedef {{ q: number, y: number, r: number, from: number, to: number }} RefillEvent  one cell to write */

/**
 * Tracks the drawn springs, the wells and the rain barrels that have room (at most MAX_REFILL_TRACKED), modelled on
 * harvest.Regrowth. Main feeds it World.onBlockChange and `loadFromEdits`, and while Survival is active calls
 * `step(1, random, isLoadedCell, env)` once a second, writing each returned event when the cell still holds `from`.
 */
export class Refill {
  constructor() {
    /** @type {Map<string, { q: number, y: number, r: number, id: number }>} "q,y,r" → the cell and its block */
    this.cells = new Map();
  }

  get size() {
    return this.cells.size;
  }

  /** @returns {boolean} */
  has(q, y, r) {
    return this.cells.has(`${q},${y},${r}`);
  }

  /** Track a cell (no-op when full; a known cell takes the new id). @param {number} id @returns {boolean} tracked */
  track(q, y, r, id) {
    if (!Number.isInteger(id) || !isRefillBlock(id)) return false;
    const key = `${q},${y},${r}`;
    if (!this.cells.has(key) && this.cells.size >= MAX_REFILL_TRACKED) return false;
    this.cells.set(key, { q, y, r, id });
    return true;
  }

  /** @returns {boolean} whether it was tracked */
  untrack(q, y, r) {
    return this.cells.delete(`${q},${y},${r}`);
  }

  /** World.onBlockChange. */
  onBlockChange(q, y, r, _prev, next) {
    if (isRefillBlock(next)) this.track(q, y, r, next);
    else this.untrack(q, y, r);
  }

  /**
   * Track every such cell recorded in World.edits. A drawn spring is an edit of a generated spring, and a well or a
   * barrel was set down by somebody: worldgen emits none of the tracked blocks.
   */
  loadFromEdits(edits) {
    this.clear();
    for (const id of REFILL_IDS) forEachEditedCell(edits, id, (q, y, r) => this.track(q, y, r, id));
  }

  clear() {
    this.cells.clear();
  }

  /**
   * The wells that share the ground with the one in column (q, r): every tracked well, full or drawn, whose column is
   * within WELL_SHARE cells of it, whatever its height — the well itself included when it is tracked.
   * @param {number} q @param {number} r @returns {number}
   */
  wellsNear(q, r) {
    let n = 0;
    for (const c of this.cells.values()) if (isWell(c.id) && hexLength(c.q - q, c.r - r) <= WELL_SHARE) n++;
    return n;
  }

  /**
   * One step. Cells in unloaded chunks are frozen (no roll), and a full well draws none (it is tracked to be counted).
   * Every other tracked cell draws one `random()` `u`, in tracking order:
   * - a drawn spring wells up when `u < dt / SPRING_MEAN_S`;
   * - a drawn well is full when `u < dt / wellMeanS(dryness, biome, wellsNear)`;
   * - a barrel with room gains a pot when `u < dt × rain / BARREL_FILL_MEAN_S`, `rain` being what reaches it.
   * The world's weather is asked only when `u` is below the chance at its best (a wet season, a lone well; the hardest
   * rain), so a dry day costs nothing; the outcome is the same as asking first. A cell with an event is given the
   * block it becomes (main's write says the same through onBlockChange): a spring is forgotten, a filled barrel too.
   * @param {number} dt seconds
   * @param {() => number} random
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @param {RefillEnv} env
   * @returns {RefillEvent[]} the cells to write
   */
  step(dt, random, isLoadedCell, env) {
    /** @type {RefillEvent[]} */
    const out = [];
    if (!(dt > 0)) return out;
    for (const [key, c] of this.cells) {
      if (c.id === B.WELL || !isLoadedCell(c.q, c.r)) continue;
      const u = random();
      let to = -1;
      if (c.id === B.SPRING_DRAWN) {
        if (u < Math.min(1, dt / SPRING_MEAN_S)) to = B.SPRING;
      } else if (c.id === B.WELL_DRAWN) {
        if (!(u < Math.min(1, dt / WELL_MEAN_S.rains))) continue;
        if (u < Math.min(1, dt / wellMeanS(env.dryness(), env.biome(c.q, c.r), this.wellsNear(c.q, c.r)))) to = B.WELL;
      } else {
        if (!(u < Math.min(1, dt / BARREL_FILL_MEAN_S))) continue;
        const rain = env.rain(c.q, c.y, c.r);
        if (rain > 0 && u < Math.min(1, (dt * Math.min(1, rain)) / BARREL_FILL_MEAN_S)) to = c.id + 1;
      }
      if (to < 0) continue;
      out.push({ q: c.q, y: c.y, r: c.r, from: c.id, to });
      if (isRefillBlock(to)) c.id = to;
      else this.cells.delete(key);
    }
    return out;
  }
}

/**
 * The once-a-second work of §85 on a world: every Refill event is written lazily (`world.setBlock(q, y, r, to, true)`,
 * as regrowth writes) when the cell still holds `from`. The write comes back through World.onBlockChange.
 * @param {number} dt seconds
 * @param {() => number} random
 * @param {{ world: { getBlock: (q: number, y: number, r: number) => number, setBlock: (q: number, y: number, r: number, id: number, lazy?: boolean) => boolean },
 *   refill: Refill, isLoadedCell: (q: number, r: number) => boolean, env: RefillEnv }} f
 * @returns {{ springs: number, wells: number, barrels: number }} what was written
 */
export function homesteadSecondOn(dt, random, f) {
  const { world } = f;
  const done = { springs: 0, wells: 0, barrels: 0 };
  for (const ev of f.refill.step(dt, random, f.isLoadedCell, f.env)) {
    if (world.getBlock(ev.q, ev.y, ev.r) !== ev.from || !world.setBlock(ev.q, ev.y, ev.r, ev.to, true)) continue;
    if (ev.to === B.SPRING) done.springs++;
    else if (ev.to === B.WELL) done.wells++;
    else done.barrels++;
  }
  return done;
}
