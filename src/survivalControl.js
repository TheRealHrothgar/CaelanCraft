// Caelancraft — the survival input helpers main would otherwise hand-write: hold-to-dig and hold-to-use state machines,
// the R priority (`interactKind`), what RMB does with the selected item, striking mobs, where a death leaves the
// belongings, and the pack screen's view. Pure: no DOM, clocks or randomness. See docs/DESIGN-survival.md §9.4, §6.1,
// §4.2–§4.4, §5.3–§5.4 and §2.5 (CONTRACTS §44 once merged).
import {
  DIG_TICK_S, USE_REPEAT_GAP_S, TAP_HOLD_S, RELIGHT_HOLD_S, FUEL_STICK_S, FUEL_LOG_S, WORLD_HEIGHT, STATION_RANGE,
} from './config.js';
import { BLOCK, getBlockDef, isPopOff, isReplaceable, isSolid, isWater } from './blocks.js';
import { getItem, hasTag, itemName, maxDurability } from './items.js';
import { isPickable, tap, toolPower, DIG_TOOL_TYPES } from './harvest.js';
import { HEX_DIRS, FACE_TOP } from './hex.js';
import { plantAt } from './farming.js';
import { spotOf, spotHint } from './sleep.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./types.js').ToolDef} ToolDef */

/** A knife of at least this tier counts as "a knife in the pack" (prickly pears, tapping, drops). */
export const KNIFE_TIER = 2;
/** Holding LMB on a block the hand cannot break plays a dull dig sound this often (§6.1). */
export const DIG_BLOCKED_TICK_S = 0.5;

/** The fixed hint texts of the survival targets (§4–§6, §9.5). */
export const HINT = Object.freeze({
  fire: 'Campfire · hold food or a pot and press R',
  fullyFed: 'The fire is fully fed',
  noFuel: 'This fire needs no fuel',
  pit: 'Cold Fire Pit · hold R to relight (drill, tinder, 3 sticks)',
  stationFar: `step within ${STATION_RANGE} cells to work here`,
  tap: 'Birch Log · R: tap sap (needs a knife and an empty pot)',
  tapped: 'Birch Log · tapped today',
  basket: 'Wicker Basket · R: open',
  basketFull: 'Basket · too many containers in this world',
  belongings: 'Your Belongings · R: take back',
  hide: 'Sleeping Hide · R: sleep', // §87: every sleep spot says `<its name> · R: sleep` (sleep.spotHint)
  packFull: 'Pack full',
  needsGround: 'needs solid ground',
  protectedCell: 'Holds survival items · switch to Survival to empty it',
  read: 'Handbook · R: read',
  // v0.10 (DESIGN-circuits §8.3): a fuse is lit by hand only with a Fire Drill in the pack.
  fuseNeedsDrill: 'Powder Fuse · needs a Fire Drill (R key)',
});

/** The pocket key's item (DESIGN-circuits §4.6): a Spark Transmitter selected sends with R when nothing nearer does. */
export const POCKET_ITEM = 'spark_transmitter';

/** The Survival Handbook's item key (handbook.js HANDBOOK_KEY; §14). R (priority 10) and RMB with it in hand read it. */
export const HANDBOOK_ITEM = 'handbook';

/** Workplace block → its station id (crafting.findStations / the Making tabs). */
export const STATION_OF_BLOCK = Object.freeze({
  [BLOCK.WORK_STUMP]: 'stump',
  [BLOCK.KILN]: 'kiln',
  [BLOCK.BLOOMERY]: 'bloomery',
  [BLOCK.FORGE]: 'forge',
  [BLOCK.WORKBENCH]: 'workbench',
});

/** The Making tabs after `All`, in order: station id and label. */
export const STATION_TABS = Object.freeze([
  Object.freeze({ id: 'hand', label: 'Hands' }),
  Object.freeze({ id: 'stump', label: 'Stump' }),
  Object.freeze({ id: 'kiln', label: 'Kiln' }),
  Object.freeze({ id: 'bloomery', label: 'Bloomery' }),
  Object.freeze({ id: 'forge', label: 'Forge' }),
  Object.freeze({ id: 'workbench', label: 'Bench' }),
]);

/** @param {number} blockId @returns {string|null} the station id of a workplace block */
export function stationIdOf(blockId) {
  return Number.isInteger(blockId) && Object.hasOwn(STATION_OF_BLOCK, blockId) ? STATION_OF_BLOCK[blockId] : null;
}

/**
 * The identity of "what is in the hand" for DigState: the selected slot and its item key. Durability is left out, so
 * wear does not reset a dig, but a tool breaking (the slot empties) or another slot does.
 * @param {number} selected @param {ItemStack|null} stack @returns {string}
 */
export function handKeyOf(selected, stack) {
  return `${selected}:${stack ? stack.k : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hold to dig (§6.1)

/**
 * @typedef {Object} DigStep
 * @property {number} progress  0..1 (0 while the block cannot be broken)
 * @property {boolean} done     t ≥ need. It stays true while the same dig is held, until reset(): when the pack is full
 *                              the block is not broken and the dig finishes as soon as there is room.
 * @property {boolean} tick     play the dig sound and dust now: on the first frame and every DIG_TICK_S
 *                              (DIG_BLOCKED_TICK_S when the block cannot be broken); never once done
 */

/**
 * Holding LMB on the same cell (q, y, r) with the same block id and the same hand accumulates `t`. A different cell or
 * id, a released button or another hand resets it; main also calls `reset()` when a modal opens and after it breaks the
 * block (so a block falling into the same cell starts a fresh dig).
 */
export class DigState {
  constructor() {
    this.reset();
  }

  reset() {
    /** Seconds dug on the current target. */
    this.t = 0;
    this.q = 0;
    this.y = 0;
    this.r = 0;
    this.id = -1;
    /** @type {string|number|null} */
    this.hand = null;
    this.active = false;
    this._ticks = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {{q: number, y: number, r: number, id?: number, blockId?: number}|null} target the targeted cell (a RaycastHit
   *   works: its blockId is read when id is absent); null when nothing is targeted
   * @param {boolean} held LMB is down
   * @param {number} need harvest.breakSeconds for this block and hand (Infinity: cannot)
   * @param {string|number|null} handKey handKeyOf(selected, stack)
   * @returns {DigStep}
   */
  step(dt, target, held, need, handKey) {
    if (!held || !target) {
      if (this.active) this.reset();
      return { progress: 0, done: false, tick: false };
    }
    const id = target.id ?? target.blockId ?? -1;
    let first = false;
    if (!this.active || target.q !== this.q || target.y !== this.y || target.r !== this.r || id !== this.id || handKey !== this.hand) {
      this.reset();
      this.active = true;
      this.q = target.q;
      this.y = target.y;
      this.r = target.r;
      this.id = id;
      this.hand = handKey;
      first = true;
    }
    const finite = Number.isFinite(need) && need >= 0;
    if (dt > 0) this.t += dt;
    const done = finite && this.t >= need;
    let tick = false;
    if (!done) {
      const n = Math.floor(this.t / (finite ? DIG_TICK_S : DIG_BLOCKED_TICK_S));
      if (first || n > this._ticks) tick = true;
      this._ticks = Math.max(this._ticks, n);
    }
    const progress = !finite ? 0 : need === 0 ? 1 : Math.min(1, this.t / need);
    return { progress, done, tick };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hold to use (§4.5, §4.2, §4.4)

/**
 * @typedef {Object} UseAction
 * @property {string} kind      'eat', 'drink', 'bandage', 'wear', 'tap', 'pit_relight', …
 * @property {string|null} [key] the item key used
 * @property {number} needS     seconds to hold (food.useS, TAP_HOLD_S, RELIGHT_HOLD_S); 0 = on the press
 * @property {[number, number, number]|{q: number, y: number, r: number}|string} [target] the cell, for R holds
 * @property {boolean} [repeat] false: once per hold (wearing); default true: the next starts after USE_REPEAT_GAP_S
 */

/** @param {UseAction} a @returns {string} */
function actionId(a) {
  const t = a.target;
  let tk = '';
  if (Array.isArray(t)) tk = t.join(',');
  else if (t && typeof t === 'object') tk = `${t.q},${t.y},${t.r}`;
  else if (t !== undefined && t !== null) tk = String(t);
  return `${a.kind}|${a.key ?? ''}|${tk}`;
}

/**
 * Hold RMB to eat, drink, bandage or wear; hold R to tap or relight. The action fills over `needS` and is `done` once;
 * releasing early (or another action) cancels. Still holding, the next one starts after USE_REPEAT_GAP_S (the ring is
 * empty meanwhile), unless `repeat` is false.
 */
export class UseState {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {string|null} */
    this.id = null;
    this.t = 0;
    /** Seconds into the gap after a use; −1 when not in a gap. */
    this.gap = -1;
    this.spent = false;
  }

  /**
   * @param {number} dt @param {UseAction|null} action what holding does now (null: nothing) @param {boolean} held
   * @returns {{ progress: number, done: boolean }}
   */
  step(dt, action, held) {
    if (!held || !action) {
      if (this.id !== null) this.reset();
      return { progress: 0, done: false };
    }
    const id = actionId(action);
    if (id !== this.id) {
      this.reset();
      this.id = id;
    }
    if (this.spent) return { progress: 0, done: false };
    let left = dt > 0 ? dt : 0;
    if (this.gap >= 0) {
      this.gap += left;
      if (this.gap < USE_REPEAT_GAP_S) return { progress: 0, done: false };
      left = this.gap - USE_REPEAT_GAP_S;
      this.gap = -1;
      this.t = 0;
    }
    this.t += left;
    const need = Number.isFinite(action.needS) && action.needS > 0 ? action.needS : 0;
    if (this.t >= need) {
      this.t = 0;
      if (action.repeat === false) this.spent = true;
      else this.gap = 0;
      return { progress: 1, done: true };
    }
    return { progress: this.t / need, done: false };
  }
}

/**
 * What RMB does with the selected stack in Survival (§0, §4.5): eat or drink food (food that gives back a pot is drunk),
 * apply a bandage, wear clothes, place a block, or read the handbook (§14.2: at once, no hold: needS 0, once per press).
 * null for tools and other materials.
 * @param {ItemStack|null} stack
 * @returns {({kind: 'eat'|'drink'|'bandage'|'wear'|'read', key: string, needS: number, repeat?: boolean}|
 *   {kind: 'place', key: string, block: number})|null}
 */
export function useActionOf(stack) {
  const def = stack ? getItem(stack.k) : null;
  if (!def) return null;
  if (def.key === HANDBOOK_ITEM) return { kind: 'read', key: def.key, needS: 0, repeat: false };
  if (def.food) return { kind: def.food.returns ? 'drink' : 'eat', key: def.key, needS: def.food.useS };
  if (def.heal) return { kind: 'bandage', key: def.key, needS: def.heal.useS };
  if (def.wear) return { kind: 'wear', key: def.key, needS: 0, repeat: false };
  if (def.kind === 'block' && def.block !== undefined) return { kind: 'place', key: def.key, block: def.block };
  return null;
}

/**
 * Survival placing (§5.3): a pop-off block (plant, litter, campfire, fire pit) over a cell that is not solid is refused,
 * and nothing is consumed (the falling trigger would pop it on the next tick and destroy the item).
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} id the block being placed at (q, y, r)
 * @returns {string|null} the refusal hint, or null when the placement may go ahead (the usual §23 rules still apply)
 */
export function placeRefusal(getBlock, id, q, y, r) {
  return isPopOff(id) && !isSolid(getBlock(q, y - 1, r)) ? HINT.needsGround : null;
}

/**
 * LMB on a mob in Survival (§4.3, §6.1). Zombies take `zombies.hit(zb, x, z, power)` (bare hands: 1). A pig is wounded
 * (`pigs.wound(pig, power, x, z)`) only by a held tool; bare hands (or a non-tool item) only shove it (`pigs.hit`).
 * @param {'pig'|'zombie'} mob
 * @param {ToolDef|string|null} tool the selected item's ToolDef (or its item key); null for the hand
 * @returns {{ call: 'wound'|'hit', power: number }}
 */
export function strikeKind(mob, tool) {
  const t = typeof tool === 'string' ? (getItem(tool)?.tool ?? null) : (tool ?? null);
  if (mob === 'pig') return t ? { call: 'wound', power: toolPower(t) } : { call: 'hit', power: 0 };
  return { call: 'hit', power: toolPower(t) };
}

/**
 * v0.16: how far a strike reaches (cells from the eye to the body), by the kind of tool in the hand. Bare hands (and
 * anything that is not one of these tools) reach `hand`. Digging, placing, picking and R keep config.REACH.
 */
export const STRIKE_REACH = Object.freeze({ hand: 2, knife: 3, hammer: 3, axe: 4, pick: 4, shovel: 4, sword: 5, spear: 6 });
/** The longest reach of all (the spear's): how far the crosshair looks for a mob. */
export const STRIKE_REACH_MAX = Math.max(...Object.values(STRIKE_REACH));

/**
 * How far a strike with `tool` reaches.
 * @param {ToolDef|string|null|undefined} tool the selected item's ToolDef (or its item key); null for the hand
 * @returns {number} cells
 */
export function strikeReach(tool) {
  const t = typeof tool === 'string' ? (getItem(tool)?.tool ?? null) : (tool ?? null);
  const reach = t ? /** @type {Record<string, number>} */ (STRIKE_REACH)[t.type] : undefined;
  return reach ?? STRIKE_REACH.hand;
}

/**
 * The hint for a mob under the crosshair that the hand's reach does not cover: `Deer · out of reach: a Flint Knife
 * reaches 3 cells`.
 * @param {string} name the mob's name @param {string|null} toolName the held tool's name, or null for bare hands
 * @param {number} reach
 */
export function outOfReachHint(name, toolName, reach) {
  return `${name} · out of reach: ${toolName ? `your ${toolName} reaches` : 'bare hands reach'} ${reach} cells`;
}

// ---------------------------------------------------------------------------------------------------------------------
// R (§9.4)

/**
 * @typedef {{q: number, y: number, r: number, blockId: number, distance?: number, face?: number}} TargetHit  a RaycastHit (or
 *   its fields; `face` is the FaceIndex the ray entered through, read by the planting step)
 */

/**
 * @typedef {Object} InteractContext
 * @property {TargetHit|null} hit           the normal target (LMB/RMB's; water never stops it)
 * @property {TargetHit|null} [waterHit]    the second ray's hit, which stops at water (§4.2); null when not cast
 * @property {boolean} [headInWater]
 * @property {string|null} selectedKey      the selected stack's item key (null: empty hand)
 * @property {{count(k: string): number, countTag(t: string): number, hasTool(type: string, minTier: number): boolean}} pack
 * @property {(q: number, y: number, r: number) => ({spots: ReadonlyArray<any>}|null)} [fireView]  cooking FireSlots.view
 * @property {(key: string) => (string|null)} [fireSpotKind]  which spot an item cooks on: 'skewer', 'centre' (or
 *   'embers'), or null (main passes cooking.js's FIRE_TRANSFORMS lookup)
 * @property {(q: number, y: number, r: number) => boolean} [tappedToday]  harvest.Tapped for today's game day
 * @property {(q: number, r: number) => boolean} [salty]  water at that column is salt (climate.isSaltyBiome of its biome)
 * @property {(q: number, y: number, r: number) => WaterQuality} [waterQuality]  v0.14 (§76 water): what the water in that
 *   cell is (main: waterBodies.waterAt — tainted, salt for the sea, else fresh); when given it is used instead of `salty`
 * @property {(q: number, y: number, r: number) => number} [waterDepth]  (CONTRACTS §83) the depth of the pool the water in
 *   that cell is taken from: 3 full, 2 low, 1 shallow, 0 when that is not told (the hint then names no depth)
 * @property {(station: string) => boolean} [stationNear]  the workplace of that station id is within STATION_RANGE of the
 *   feet (main: `!!stations[id]` from crafting.findStations); absent → every targeted workplace counts as near
 * @property {(id: number) => boolean} [partR]  v0.10 (DESIGN-circuits §4.9): the targeted block is a circuit part with an R
 *   action of its own (main: circuits on and main.hasRAction); absent → no circuit steps (no `circuit`, no `pocket`)
 * @property {(q: number, y: number, r: number) => number} [getBlock]  the world, for the planting step of §80 (the soil
 *   and the cell above it); absent → no `plant`
 */

/**
 * @typedef {Object} InteractAction
 * @property {string} kind  fire_put | fire_feed | fire_take | fire_hint | pit_take | pit_relight | pit_hint | pick | tap |
 *   tap_hint | basket | belongings | hide | station | station_far | fill | drink | drink_here | read | circuit | fuse_hint |
 *   pocket (v0.10) | plant (§80)
 * @property {number} [q] @property {number} [y] @property {number} [r]   the cell acted on (the water cell for fill/drink)
 * @property {string} [key]      fire_put / fire_feed / plant: the selected item
 * @property {'skewer'|'centre'} [spot]  fire_put
 * @property {number} [seconds]  fire_feed: fuel one item adds (FUEL_STICK_S or FUEL_LOG_S)
 * @property {number} [id]       pick: the block picked
 * @property {number} [block]    plant: the PLANTED_* block to write in the cell above (q, y, r), the soil
 * @property {number} [needS]    tap / pit_relight: seconds R must be held
 * @property {string} [station]  station: its id ('stump', 'kiln', 'bloomery', 'forge')
 * @property {boolean} [salty]   fill / drink, when the context gives `salty` (or `waterQuality`: quality === 'salt')
 * @property {WaterQuality} [quality]  fill / drink, when the context gives `waterQuality` (§76)
 * @property {string} [hint]     the target hint text, where it is fixed
 */

/** @param {ReadonlyArray<any>|undefined} spots @param {number} from @param {number} to (exclusive) */
function anyFree(spots, from, to) {
  for (let i = from; i < to; i++) if (!spots || !spots[i]) return true;
  return false;
}

/**
 * The R priority in Survival (§9.4): the first case that applies.
 * 1. CAMPFIRE → `fire_put` (a skewer food or a centre pot selected, and a free spot of that kind), `fire_feed` (a stick or a
 *    `#log` selected), `fire_take` (its spots hold anything), else `fire_hint`;
 * 2. FIRE_PIT → `pit_take` (its spots hold anything), else `pit_relight` (a fire drill, 1 `#tinder` and 3 sticks in the
 *    pack), else `pit_hint` (its hint names what is missing: `Cold Fire Pit · relight needs a fire drill and 2 more sticks`);
 * 3. a ripe honeyberry bush or prickly pear, loose stones, fallen branches → `pick`;
 * 4. BIRCH_LOG → `tap` (an empty clay pot selected, a knife ≥ 2 in the pack, not tapped today), else `tap_hint`;
 * 5. WICKER_BASKET → `basket`; REMAINS → `belongings`;
 * 6. a sleep spot (§87, sleep.SPOTS: the SLEEPING_HIDE, and the beds where their blocks exist) → `hide` (hint
 *    `Sleeping Hide · R: sleep`; main lies down on it and makes it the waking place);
 * 7. a workplace → `station`, or `station_far` (hint `Kiln · step within 3 cells to work here`) when `stationNear` says
 *    Making does not count it as near;
 * 7b. v0.10 (DESIGN-circuits §4.9, §8.3): a circuit part with an R action of its own (`partR`) → `circuit` (main runs
 *    circuits.interact 'r'); a Powder Fuse without a Fire Drill in the pack → `fuse_hint` instead;
 * 7c. §80: a plantable item is selected (farming.PLANTABLE) and the ray entered the TOP of a block that is soil for its
 *    crop, with AIR above → `plant` (hint `Grass Block · R: plant Carrot Seeds`; `getBlock` must be given). Soil is
 *    none of the blocks of cases 1–7b, so whatever R did before, it still does: a plant in the crosshair is picked;
 * 8. `waterHit` is water nearer than `hit` (or there is no hit) → `fill` with an empty clay pot selected, else `drink`;
 * 9. the head is under water → `drink_here`;
 * 10. the handbook is selected → `read` (§14.2: before the rune and the keg explanation);
 * 10b. v0.10: a Spark Transmitter is selected (and `partR` is given) → `pocket` (the pocket key sends, §4.6);
 * 11. null: the rune, then the keg or charge explanation (main's interactTarget; kegs no longer light on the R key).
 * @param {InteractContext} c
 * @returns {InteractAction|null}
 */
export function interactKind(c) {
  const sel = c.selectedKey ?? null;
  const wh = c.waterHit ?? null;
  const water = wh && isWater(wh.blockId) ? wh : null;
  // CONTRACT-ISSUE: §9.4 lists the `hit` cases (1–7) before water (8), but §4.2 says R uses `waterHit` whenever it hits
  // water NEARER than `hit`. They differ only for a block seen through water (a log in a pond); §4.2 is followed: water in
  // front of the block takes the R, so cases 1–7 apply only to a hit that no water hides.
  const waterFirst = !!water && (!c.hit || (water.distance ?? 0) < (c.hit.distance ?? Infinity));
  const h = waterFirst ? null : c.hit;

  if (h) {
    const { q, y, r } = h;
    const id = h.blockId;
    if (id === BLOCK.CAMPFIRE || id === BLOCK.FIRE_PIT) {
      const view = c.fireView ? c.fireView(q, y, r) : null;
      const spots = view?.spots;
      const holds = !!spots && spots.some((s) => !!s);
      if (id === BLOCK.FIRE_PIT) {
        if (holds) return { kind: 'pit_take', q, y, r };
        const missing = relightMissing(c.pack);
        if (missing.length === 0) return { kind: 'pit_relight', q, y, r, needS: RELIGHT_HOLD_S, hint: HINT.pit };
        return { kind: 'pit_hint', q, y, r, hint: `Cold Fire Pit · relight needs ${listJoin(missing)}` };
      }
      if (sel) {
        const kind = c.fireSpotKind ? c.fireSpotKind(sel) : null;
        if (kind === 'skewer' && anyFree(spots, 0, 6)) return { kind: 'fire_put', q, y, r, key: sel, spot: 'skewer' };
        if ((kind === 'centre' || kind === 'embers') && anyFree(spots, 6, 7)) return { kind: 'fire_put', q, y, r, key: sel, spot: 'centre' };
        if (sel === 'stick') return { kind: 'fire_feed', q, y, r, key: sel, seconds: FUEL_STICK_S };
        if (hasTag(sel, 'log')) return { kind: 'fire_feed', q, y, r, key: sel, seconds: FUEL_LOG_S };
      }
      if (holds) return { kind: 'fire_take', q, y, r };
      return { kind: 'fire_hint', q, y, r, hint: HINT.fire };
    }
    if (isPickable(id)) return { kind: 'pick', q, y, r, id };
    if (id === BLOCK.BIRCH_LOG) {
      const ok = !!tap(id, sel, c.pack.hasTool('knife', KNIFE_TIER));
      if (ok && c.tappedToday && c.tappedToday(q, y, r)) return { kind: 'tap_hint', q, y, r, hint: HINT.tapped };
      return ok ? { kind: 'tap', q, y, r, needS: TAP_HOLD_S, hint: HINT.tap } : { kind: 'tap_hint', q, y, r, hint: HINT.tap };
    }
    if (id === BLOCK.WICKER_BASKET) return { kind: 'basket', q, y, r, hint: HINT.basket };
    if (id === BLOCK.REMAINS) return { kind: 'belongings', q, y, r, hint: HINT.belongings };
    const bed = spotOf(id); // §87
    if (bed) return { kind: 'hide', q, y, r, hint: spotHint(bed) };
    const station = stationIdOf(id);
    if (station) {
      const name = getBlockDef(id).displayName;
      // R reaches REACH cells but Making counts a workplace as near only within STATION_RANGE of the feet (§7.2): a
      // workplace in the crosshair but too far to work at says so instead of opening a Making full of greyed cards.
      if (c.stationNear && !c.stationNear(station)) return { kind: 'station_far', q, y, r, station, hint: `${name} · ${HINT.stationFar}` };
      return { kind: 'station', q, y, r, station, hint: `${name} · R: open Making` };
    }
    if (c.partR && c.partR(id)) {
      if (id === BLOCK.POWDER_FUSE && !c.pack.hasTool('firestarter', 0)) return { kind: 'fuse_hint', q, y, r, hint: HINT.fuseNeedsDrill };
      return { kind: 'circuit', q, y, r };
    }
    if (sel && c.getBlock && h.face === FACE_TOP) {
      const planting = plantAt(c.getBlock, sel, q, y, r);
      if (planting) return { kind: 'plant', q, y, r, key: sel, block: planting.block, hint: planting.hint };
    }
  }
  if (waterFirst) {
    const fill = sel === 'clay_pot';
    /** @type {InteractAction} */
    const act = { kind: fill ? 'fill' : 'drink', q: water.q, y: water.y, r: water.r };
    if (c.waterQuality) {
      // §76: the hint names what the player is looking at — fresh, salt or tainted — and the action carries it;
      // §83: and how much is left of the pool it is taken from (full, low, shallow)
      act.quality = c.waterQuality(water.q, water.y, water.r);
      act.salty = act.quality === 'salt';
      act.hint = waterHint(act.quality, fill, c.waterDepth ? c.waterDepth(water.q, water.y, water.r) : 0);
    } else if (c.salty) {
      act.salty = c.salty(water.q, water.r);
      act.hint = waterHint(act.salty, fill);
    }
    return act;
  }
  if (c.headInWater) return { kind: 'drink_here' };
  if (sel === HANDBOOK_ITEM) return { kind: 'read', hint: HINT.read };
  if (sel === POCKET_ITEM && c.partR) return { kind: 'pocket' };
  return null;
}

/**
 * What a cold pit's relight still lacks (§4.4: a fire drill, 1 `#tinder`, 3 sticks), for the pit hint: `a fire drill`,
 * `tinder`, `2 more sticks` — empty when it can be relit.
 * @param {{count(k: string): number, countTag(t: string): number, hasTool(type: string, minTier: number): boolean}} pack
 * @returns {string[]}
 */
export function relightMissing(pack) {
  const out = [];
  if (!pack.hasTool('firestarter', 0)) out.push('a fire drill');
  if (pack.countTag('tinder') < 1) out.push('tinder');
  const sticks = RELIGHT_STICKS - pack.count('stick');
  if (sticks > 0) out.push(`${sticks} more stick${sticks === 1 ? '' : 's'}`);
  return out;
}
/** Sticks a relight takes (§4.4). */
export const RELIGHT_STICKS = 3;

/** "a, b and c". @param {string[]} parts */
function listJoin(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Wear from digging (§6.1 step 6): a block broken wears the selected tool only when it is a digging tool — an axe,
 * shovel, pick, knife or hammer. A spear or sword wears on the blows it lands (`wearsFromStriking`), never on a dig; the
 * kiln kit (fire drill, crucible, casting mold) wears only in the jobs that need it (play-test: a fresh mold in the hand
 * was destroyed by digging eight blocks of clay).
 * @param {ToolDef|null|undefined} tool  the selected stack's ToolDef
 */
export function wearsFromDigging(tool) {
  return !!tool && DIG_TOOL_TYPES.has(tool.type);
}

/**
 * Wear from a blow that lands on a mob (§4.3, §6.1): every tool but the kiln kit, which cuts nothing.
 * @param {ToolDef|null|undefined} tool
 */
export function wearsFromStriking(tool) {
  return !!tool && !KIT_TOOL_TYPES.has(tool.type);
}
/** Tool types of the tier-0 kit that wears out but cuts nothing (items.js). */
export const KIT_TOOL_TYPES = Object.freeze(new Set(['firestarter', 'crucible', 'mold']));

/**
 * What a cell of water is to drink (v0.14, CONTRACTS §76 water): 'fresh' (a small risk raw), 'salt' (sea water: it only
 * makes you thirstier) or 'tainted' (murky standing water, or water flowing out of it: a high risk raw).
 * @typedef {'fresh'|'salt'|'tainted'} WaterQuality
 */

/**
 * The quality of a water cell from its facts: tainted wins (a Tainted Water source, or water traced back to one —
 * fluids.waterQualityAt); then running water is fresh, also where a stream crosses a beach on its way to the sea; then
 * salt; else fresh. Since §83 `salty` is: the water is the SEA (a body of more than fluids.BODY_MAX_CELLS cells, whatever
 * the biome of the column), or it was generated in a salt biome (climate.isSaltyBiome) — waterBodies.waterAt decides.
 * @param {boolean} tainted @param {boolean} salty @param {boolean} [stream] @returns {WaterQuality}
 */
export function waterKind(tainted, salty, stream = false) {
  return tainted ? 'tainted' : salty && !stream ? 'salt' : 'fresh';
}

/** The pot a Clay Pot becomes when filled from water of each quality (§4.1, §76). */
export const WATER_POTS = Object.freeze({ fresh: 'pot_water', salt: 'pot_seawater', tainted: 'pot_tainted' });

/** @param {WaterQuality|boolean} quality  (a boolean is the old `salty` flag) @returns {WaterQuality} */
function qualityOf(quality) {
  if (quality === 'tainted' || quality === 'salt' || quality === 'fresh') return quality;
  return quality ? 'salt' : 'fresh';
}

/** The first part of the water hint, per quality. */
const WATER_LABELS = Object.freeze({ fresh: 'Fresh water', salt: 'Sea water (salty)', tainted: 'Tainted water' });

/** The words for how much is left of a pool, by depth 1..3 (CONTRACTS §83; blocks.WATER_DEPTH_WORDS). */
const DEPTH_WORDS = Object.freeze(['', 'shallow', 'low', 'full']);

/**
 * The water target hint (§4.1, §76): `Fresh water · R: drink`, `Sea water (salty) · R: drink`, `Tainted water · R: drink
 * (risky)`, or `… · R: fill the pot` with an empty clay pot selected. With a `depth` (§83) fresh and tainted water say
 * how much is left of the pool: `Fresh water · full · R: drink`, `Tainted water · low · R: drink (risky)`, `Fresh water ·
 * shallow · R: fill the pot`. Sea water names no depth: the sea does not run out.
 * @param {WaterQuality|boolean} quality  what the water is (a boolean is the old `salty` flag: true = salt)
 * @param {boolean} potSelected
 * @param {number} [depth]  the depth of the pool it is taken from: 3 full, 2 low, 1 shallow; anything else: not said
 */
export function waterHint(quality, potSelected, depth = 0) {
  const q = qualityOf(quality);
  const verb = potSelected ? 'fill the pot' : q === 'tainted' ? 'drink (risky)' : 'drink';
  const left = q !== 'salt' && (depth === 1 || depth === 2 || depth === 3) ? ` · ${DEPTH_WORDS[depth]}` : '';
  return `${WATER_LABELS[q]}${left} · R: ${verb}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Death (§2.5)

/** How far below the feet cell the belongings scan looks for ground. */
export const BELONGINGS_SCAN_DOWN = 8;
/** How many cells above the ground cell are tried. */
export const BELONGINGS_TRY_UP = 3;

/**
 * Where a death leaves "Your Belongings" (§2.5). From the feet cell, first scan down to the first cell standing on a solid
 * one (at most 8 cells; none → the feet cell), so a death in mid-air leaves them on the ground. Try that cell, then up to 3
 * cells above it, then its 6 side neighbours; the first that `isReplaceable` (AIR or a liquid) is the place. When none is
 * (a death buried in solid ground: a cave-in, a block written onto the player), the same candidates are tried again for
 * the first solid cell that is not BEDROCK — the heap replaces the block that killed the player and is dug out like any
 * other, so a burial never costs the pack (§2.5).
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} q @param {number} y @param {number} r the feet cell
 * @returns {[number, number, number]|null} null when every candidate is bedrock or unloaded (the items are lost)
 */
export function chooseBelongingsCell(getBlock, q, y, r) {
  if (!Number.isFinite(q + y + r) || y < 0) return null;
  const top = Math.min(Math.floor(y), WORLD_HEIGHT - 1);
  let base = top;
  for (let i = 0; i <= BELONGINGS_SCAN_DOWN; i++) {
    const cy = top - i;
    if (cy - 1 < 0) break;
    if (isSolid(getBlock(q, cy - 1, r))) {
      base = cy;
      break;
    }
  }
  /** @type {[number, number, number][]} */
  const tries = [];
  for (let dy = 0; dy <= BELONGINGS_TRY_UP; dy++) tries.push([q, base + dy, r]);
  for (const [dq, dr] of HEX_DIRS) tries.push([q + dq, base, r + dr]);
  for (const cell of tries) {
    const cy = cell[1];
    if (cy < 0 || cy >= WORLD_HEIGHT) continue;
    if (isReplaceable(getBlock(cell[0], cy, cell[2]))) return cell;
  }
  for (const cell of tries) {
    const cy = cell[1];
    if (cy < 0 || cy >= WORLD_HEIGHT) continue;
    const id = getBlock(cell[0], cy, cell[2]);
    if (isSolid(id) && id !== BLOCK.BEDROCK) return cell;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The pack screen's view (§9.8)

/**
 * @typedef {Object} HoverInfo  what the centre hex shows
 * @property {'pack'|'wear'|'container'|'cursor'} area  where the item is
 * @property {number} index     its slot (−1 for the cursor)
 * @property {string} k
 * @property {number} n
 * @property {string} name      display name
 * @property {number} durability     durability left (0: the item has none)
 * @property {number} maxDurability  0: the item has none
 */

/**
 * @typedef {Object} PackViewInput
 * @property {{slots: ReadonlyArray<ItemStack|null>, wear: ReadonlyArray<ItemStack|null>}} pack
 * @property {number} selected
 * @property {ItemStack|null} [cursor]
 * @property {{area: 'pack'|'wear'|'container', index: number}|null} [hover]  the slot under the mouse
 * @property {{kind?: string, title?: string, slots: ReadonlyArray<ItemStack|null>}|null} [container]  the open basket
 * @property {Record<string, any>|null} [stations]  crafting.findStations: { hand: true, stump?: [q,y,r], kiln?, … }
 * @property {string} [tab]     'all' or a station id
 * @property {ReadonlyArray<{station: string}>} [recipes]  crafting.listRecipes (RecipeView[]), already sorted
 * @property {ReadonlyArray<{station: string, jobs: ReadonlyArray<any>}>} [lanes]  craftQueue.lanes()
 * @property {{text: string, error?: boolean}|null} [message]  a line for the screen itself (§14.4 "The handbook stays with
 *   you.", a Make result): the HUD's target hint is not drawn under the pack screen
 */

/**
 * @typedef {Object} PackView
 * @property {(ItemStack|null)[]} slots
 * @property {(ItemStack|null)[]} wear
 * @property {number} selected
 * @property {ItemStack|null} cursor
 * @property {HoverInfo|null} hover
 * @property {{title: string, slots: (ItemStack|null)[]}|null} container
 * @property {{id: string, label: string, near: boolean}[]} stations
 * @property {string} tab
 * @property {any[]} recipes   the RecipeViews of the tab
 * @property {{station: string, label: string, jobs: {name: string, progress: number, waiting: any}[]}[]} lanes  busy lanes only
 * @property {{text: string, error: boolean}|null} message  the screen's own feedback line (refusals, Make results)
 */

/** @param {ItemStack|null|undefined} s @returns {ItemStack|null} */
function copy(s) {
  if (!s) return null;
  return s.d === undefined ? { k: s.k, n: s.n } : { k: s.k, n: s.n, d: s.d };
}

/** @param {ItemStack} s @param {HoverInfo['area']} area @param {number} index @returns {HoverInfo} */
function hoverInfo(s, area, index) {
  const max = maxDurability(s.k);
  return { area, index, k: s.k, n: s.n, name: itemName(s.k), durability: max ? (s.d ?? max) : 0, maxDurability: max };
}

/** @param {any} job @returns {{name: string, progress: number, waiting: any}} */
function jobView(job) {
  const name = job.name ?? (job.out?.k ? itemName(job.out.k) : null) ?? job.recipeId ?? job.id ?? '?';
  let progress = job.progress;
  if (typeof progress !== 'number') progress = job.seconds > 0 ? (job.t ?? 0) / job.seconds : 0;
  progress = Math.min(1, Math.max(0, progress || 0));
  return { name: String(name), progress, waiting: job.waiting ?? false };
}

const TAB_LABEL = Object.fromEntries(STATION_TABS.map((t) => [t.id, t.label]));

/**
 * The pack screen's view object (§9.8), a snapshot: stacks are copied, so the screen may keep it and diff the next one.
 * - `stations`: the five Making tabs after `All` (`Hands` is always near);
 * - `tab`: an unknown tab becomes 'all'; `recipes`: the given RecipeViews of that tab, in the given order;
 * - `hover`: the hovered slot's item, else the cursor's, else null;
 * - `lanes`: one row per busy station;
 * - `message`: the screen's feedback line, or null.
 * @param {PackViewInput} input
 * @returns {PackView}
 */
export function buildPackView(input) {
  const { pack } = input;
  const cursor = copy(input.cursor);
  const container = input.container
    ? {
      title: input.container.title ?? (input.container.kind === 'remains' ? 'Your Belongings' : 'Wicker Basket'),
      slots: input.container.slots.map(copy),
    }
    : null;

  /** @type {HoverInfo|null} */
  let hover = null;
  const hv = input.hover;
  if (hv) {
    const src = hv.area === 'pack' ? pack.slots : hv.area === 'wear' ? pack.wear : hv.area === 'container' ? input.container?.slots : null;
    const s = src ? src[hv.index] : null;
    if (s) hover = hoverInfo(s, hv.area, hv.index);
  }
  if (!hover && cursor) hover = hoverInfo(cursor, 'cursor', -1);

  const st = input.stations ?? {};
  const stations = STATION_TABS.map((t) => ({ id: t.id, label: t.label, near: t.id === 'hand' || !!st[t.id] }));
  const tab = input.tab && (input.tab === 'all' || Object.hasOwn(TAB_LABEL, input.tab)) ? input.tab : 'all';
  const recipes = (input.recipes ?? []).filter((rv) => tab === 'all' || rv.station === tab);

  // CONTRACT-ISSUE: the doc fixes the view's lane rows ({ station, jobs: [{ name, progress, waiting }] }) but not the shape
  // of CraftQueue.lanes(); a job may give `name`, or `out: {k}` / `recipeId`, and `progress`, or `t` and `seconds`.
  const lanes = (input.lanes ?? [])
    .filter((l) => l && l.jobs && l.jobs.length > 0)
    .map((l) => ({ station: l.station, label: TAB_LABEL[l.station] ?? String(l.station), jobs: l.jobs.map(jobView) }));

  return {
    slots: pack.slots.map(copy),
    wear: pack.wear.map(copy),
    selected: input.selected,
    cursor,
    hover,
    container,
    stations,
    tab,
    message: input.message && input.message.text ? { text: String(input.message.text), error: !!input.message.error } : null,
    recipes: [...recipes],
    lanes,
  };
}
