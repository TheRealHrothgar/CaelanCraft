// Caelancraft — cooking on the campfire: the seven fire spots of every campfire and the fuel of Survival-placed fires.
// Pure. See docs/DESIGN-survival.md §4.4 and §9.6 (CONTRACTS §46 once merged).
//
// Every CAMPFIRE cell has FIRE_SPOTS (7) spots: spots 0–5 are green-wood skewers planted at the six corner stones the
// campfire renderer draws (corner k at angle 60k − 90° in the XZ plane, measured from +X toward +Z), each holding ONE food
// item; spot 6 is the embers at the centre and holds ONE pot. Each spot keeps its own timer and its transforms chain (roast
// pork left on a skewer chars). A fire placed in Survival also has FUEL that counts down while it burns; at 0 it burns out
// (main writes FIRE_PIT). Fires without a fuel entry — placed in Creative, or from before v0.9 — burn forever.
//
// Entries live only for fires that hold something or have fuel; keys are "q,y,r" like runes and campfires. Nothing here
// touches the world: main reports block changes (onBlockChange), says which fires burn (isBurning) and are loaded, and
// writes the FIRE_PIT itself when a fire burns out.
import { FIRE_SPOTS, MAX_FIRE_SLOTS, CAMPFIRE_FUEL_MAX_S, FUEL_STICK_S, FUEL_LOG_S, WORLD_HEIGHT } from './config.js';
import { BLOCK, BLOCKS, isLog } from './blocks.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./types.js').FireSlotsJSON} FireSlotsJSON */

/** Spots 0..SKEWER_SPOTS−1 are skewers. */
export const SKEWER_SPOTS = 6;
/** The embers spot (the pot). */
export const EMBERS_SPOT = 6;

/**
 * What the fire does to an item on a spot: key → { to, seconds, spot }. `spot` is the kind of spot it cooks on
 * ('skewer' or 'centre', the embers). Logs are fuel, not food for the fire (§4.4).
 * @type {Readonly<Record<string, Readonly<{ to: string, seconds: number, spot: 'skewer'|'centre' }>>>}
 */
export const FIRE_TRANSFORMS = Object.freeze({
  raw_pork: Object.freeze({ to: 'roast_pork', seconds: 20, spot: 'skewer' }),
  roast_pork: Object.freeze({ to: 'charred_meat', seconds: 40, spot: 'skewer' }),
  // v0.11 (CONTRACTS §69): beef and mutton roast like pork
  raw_beef: Object.freeze({ to: 'roast_beef', seconds: 24, spot: 'skewer' }),
  roast_beef: Object.freeze({ to: 'charred_meat', seconds: 40, spot: 'skewer' }),
  raw_mutton: Object.freeze({ to: 'roast_mutton', seconds: 18, spot: 'skewer' }),
  roast_mutton: Object.freeze({ to: 'charred_meat', seconds: 40, spot: 'skewer' }),
  wild_tuber: Object.freeze({ to: 'baked_tuber', seconds: 25, spot: 'skewer' }),
  cattail_root: Object.freeze({ to: 'roasted_cattail_root', seconds: 15, spot: 'skewer' }),
  leached_acorns: Object.freeze({ to: 'roasted_acorns', seconds: 15, spot: 'skewer' }),
  unpeeled_cactus_fruit: Object.freeze({ to: 'cactus_fruit', seconds: 6, spot: 'skewer' }),
  pot_water: Object.freeze({ to: 'pot_boiled', seconds: 15, spot: 'centre' }),
  pot_seawater: Object.freeze({ to: 'salt_pot', seconds: 30, spot: 'centre' }),
  pot_snow: Object.freeze({ to: 'pot_boiled', seconds: 25, spot: 'centre' }),
  greenware_pot: Object.freeze({ to: 'clay_pot', seconds: 60, spot: 'centre' }), // pit firing: the first pottery needs no kiln
  // v0.14 (§76 flora): the wild food of generation 3 roasts on a skewer. Fire does NOT make a Frecklecap safe.
  honeycap: Object.freeze({ to: 'roasted_honeycap', seconds: 15, spot: 'skewer' }),
  frecklecap: Object.freeze({ to: 'roasted_frecklecap', seconds: 15, spot: 'skewer' }),
  wild_onion: Object.freeze({ to: 'roasted_onion', seconds: 15, spot: 'skewer' }),
  wild_carrot: Object.freeze({ to: 'roasted_carrot', seconds: 20, spot: 'skewer' }),
  hazelnuts: Object.freeze({ to: 'roasted_hazelnuts', seconds: 12, spot: 'skewer' }),
  crab_apple: Object.freeze({ to: 'baked_crab_apple', seconds: 18, spot: 'skewer' }),
});

/** @type {Map<string, { to: string, seconds: number, spot: string }>} the same, safe against '__proto__' and friends */
const TRANSFORM = new Map(Object.entries(FIRE_TRANSFORMS));

/** The food a player can put on a skewer (§4.4). */
export const SKEWER_FOODS = Object.freeze(['raw_pork', 'raw_beef', 'raw_mutton', 'wild_tuber', 'cattail_root', 'leached_acorns', 'unpeeled_cactus_fruit',
  'honeycap', 'frecklecap', 'wild_onion', 'wild_carrot', 'hazelnuts', 'crab_apple']); // v0.14 (§76 flora)
/** The pots a player can put in the embers. */
export const CENTRE_POTS = Object.freeze(['pot_water', 'pot_seawater', 'pot_snow', 'greenware_pot']);

const SKEWER_FOOD_SET = new Set(SKEWER_FOODS);
const CENTRE_POT_SET = new Set(CENTRE_POTS);

/** @returns {Set<string>} the starting keys and everything their transforms chain into */
function chainClosure(starts) {
  const out = new Set();
  for (let k of starts) {
    while (k !== undefined && !out.has(k)) {
      out.add(k);
      k = TRANSFORM.get(k)?.to;
    }
  }
  return out;
}

/** Every key that can be on a skewer / in the embers: what can be put there and what the fire turns it into. */
const SKEWER_KEYS = chainClosure(SKEWER_FOODS);
const CENTRE_KEYS = chainClosure(CENTRE_POTS);

/** @param {number} i @returns {'skewer'|'centre'} */
export function spotKind(i) {
  return i < SKEWER_SPOTS ? 'skewer' : 'centre';
}

/** @param {string} key @returns {boolean} a food that can be put on a skewer */
export function isSkewerFood(key) {
  return SKEWER_FOOD_SET.has(key);
}

/** @param {string} key @returns {boolean} a pot that can be put in the embers */
export function isCentrePot(key) {
  return CENTRE_POT_SET.has(key);
}

/**
 * Whether `key` may sit on spot `i` in a save: something that can be put there, or what the fire makes of it.
 * CONTRACT-ISSUE: DESIGN-survival §9.6 says a spot is emptied "when its k has no FIRE_TRANSFORMS entry for that spot's kind",
 * which read literally would throw away every finished item on reload (baked_tuber, charred_meat, cactus_fruit,
 * pot_boiled, salt_pot and clay_pot have no transform of their own). The check accepts the transform chain instead: what can
 * be put on that kind of spot and everything the fire turns it into.
 * @param {number} i @param {string} key @returns {boolean}
 */
export function spotAccepts(i, key) {
  return (spotKind(i) === 'skewer' ? SKEWER_KEYS : CENTRE_KEYS).has(key);
}

/**
 * An item on a spot has finished at least one transform exactly when it is not something a player can put there (none of
 * the transform results can be put on a fire), so this needs no per-spot state.
 * @param {string} key @returns {boolean}
 */
export function hasCooked(key) {
  return !SKEWER_FOOD_SET.has(key) && !CENTRE_POT_SET.has(key);
}

/** Skewer k's corner angle in radians (60k − 90°, XZ plane from +X toward +Z), as campfireRenderer places the stones. */
export const SKEWER_ANGLES = Object.freeze(Array.from({ length: SKEWER_SPOTS }, (_, k) => ((60 * k - 90) * Math.PI) / 180));

/** Log item keys (block items of the log blocks): fuel worth FUEL_LOG_S. */
const LOG_KEYS = new Set(BLOCKS.filter((b) => isLog(b.id)).map((b) => b.name));

/**
 * Seconds of fuel one item adds to a campfire: a stick FUEL_STICK_S, a log FUEL_LOG_S, anything else 0 (not fuel).
 * @param {string} key @returns {number}
 */
export function fuelSeconds(key) {
  if (key === 'stick') return FUEL_STICK_S;
  return LOG_KEYS.has(key) ? FUEL_LOG_S : 0;
}

/** "4:10" for 250 s (whole seconds, rounded up). */
export function formatFuel(seconds) {
  const s = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys and the save format
// ---------------------------------------------------------------------------------------------------------------------

const CELL_KEY_RE = /^(-?\d+),(-?\d+),(-?\d+)$/;

/** @returns {string} "q,y,r" */
export function fireKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Strict "q,y,r" key parsing (integers, y inside the world): the key format of fires and containers.
 * @param {unknown} key
 * @returns {[number, number, number]|null}
 */
export function parseCellKey(key) {
  const m = CELL_KEY_RE.exec(String(key));
  if (!m) return null;
  const q = Number(m[1]);
  const y = Number(m[2]);
  const r = Number(m[3]);
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r) || !(y >= 0 && y < WORLD_HEIGHT)) return null;
  return [q + 0, y, r + 0];
}

/** @returns {number} -1 / 0 / 1 ordering parsed cells by q, then y, then r */
function compareCells(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Three decimal places, never −0. */
function round3(v) {
  return Math.round(v * 1000) / 1000 + 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Canonicalise raw FireSlotsJSON (the `fires` of a SurvivalJSON): keys parsed strictly and rewritten canonically (last
 * write wins), sorted by (q, y, r); `s` exactly FIRE_SPOTS long; numbers rounded to 3 decimal places. Whole entries are
 * dropped for a malformed key, an `s` that is not FIRE_SPOTS long, a bad `f` (not a number 0..CAMPFIRE_FUEL_MAX_S), a cell
 * `cellOk` rejects (storage: not CAMPFIRE or FIRE_PIT in the save's edits) and beyond MAX_FIRE_SLOTS entries; a spot is
 * emptied when its item cannot be on that kind of spot or its `t` is not a number ≥ 0. Entries with no items and no fuel
 * are left out. Every repair is described in `warnings`.
 * @param {unknown} raw
 * @param {{ prefix?: string, cellOk?: (q: number, y: number, r: number) => boolean }} [opts]
 * @returns {{ fires: FireSlotsJSON, warnings: string[] }}
 */
export function normalizeFiresJSON(raw, opts = {}) {
  const prefix = opts.prefix ?? 'fires';
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, { cell: [number, number, number], entry: { s: ({k: string, t: number}|null)[], f?: number } }>} */
  const kept = new Map();
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) warnings.push(`${prefix}: not an object, ignored`);
    return { fires: {}, warnings };
  }
  for (const rawKey of Object.keys(/** @type {object} */ (raw))) {
    const cell = parseCellKey(rawKey);
    if (!cell) {
      warnings.push(`${prefix}: dropped entry with malformed key ${JSON.stringify(rawKey)}`);
      continue;
    }
    const key = fireKey(...cell);
    const v = /** @type {Record<string, any>} */ (raw)[rawKey];
    const at = `${prefix}[${key}]`;
    if (!isPlainObject(v) || !Array.isArray(v.s) || v.s.length !== FIRE_SPOTS) {
      warnings.push(`${at}: not ${FIRE_SPOTS} spots, dropped`);
      continue;
    }
    let f;
    if (v.f !== undefined) {
      f = typeof v.f === 'number' && Number.isFinite(v.f) ? round3(v.f) : NaN;
      if (!(f >= 0 && f <= CAMPFIRE_FUEL_MAX_S)) {
        warnings.push(`${at}: bad fuel, dropped`);
        continue;
      }
    }
    const s = v.s.map((spot, i) => {
      if (spot === null || spot === undefined) return null;
      const k = isPlainObject(spot) ? spot.k : undefined;
      if (typeof k !== 'string' || !spotAccepts(i, k)) {
        warnings.push(`${at}.s[${i}]: ${JSON.stringify(k ?? null)} cannot be ${spotKind(i) === 'skewer' ? 'on a skewer' : 'in the embers'}, emptied`);
        return null;
      }
      const t = typeof spot.t === 'number' && Number.isFinite(spot.t) ? round3(spot.t) : NaN;
      if (!(t >= 0)) {
        warnings.push(`${at}.s[${i}]: bad time, emptied`);
        return null;
      }
      return { k, t };
    });
    if (f === undefined && s.every((x) => x === null)) {
      kept.delete(key);
      continue;
    }
    if (opts.cellOk && !opts.cellOk(cell[0], cell[1], cell[2])) {
      warnings.push(`${at}: no campfire there, dropped`);
      continue;
    }
    /** @type {{ s: ({k: string, t: number}|null)[], f?: number }} */
    const entry = { s };
    if (f !== undefined) entry.f = f;
    kept.delete(key); // last write wins, at its own place in key order below
    kept.set(key, { cell, entry });
  }
  const sorted = [...kept.values()].sort((a, b) => compareCells(a.cell, b.cell));
  if (sorted.length > MAX_FIRE_SLOTS) {
    warnings.push(`${prefix}: more than ${MAX_FIRE_SLOTS} fires, ${sorted.length - MAX_FIRE_SLOTS} dropped`);
    sorted.length = MAX_FIRE_SLOTS;
  }
  /** @type {FireSlotsJSON} */
  const fires = {};
  for (const { cell, entry } of sorted) fires[fireKey(...cell)] = entry;
  return { fires, warnings };
}

// ---------------------------------------------------------------------------------------------------------------------
// FireSlots
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} FireEntry
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {({ k: string, t: number }|null)[]} s   FIRE_SPOTS spots; `t` = seconds cooked toward the next transform
 * @property {number|undefined} f                    fuel left in seconds; undefined = the fire burns forever
 * @property {boolean} out                           its burn-out was reported (not saved)
 */

/**
 * @typedef {Object} SpotView
 * @property {string} k
 * @property {number} progress      0..1 toward the next transform (1 when nothing more happens to it)
 * @property {number} secondsLeft   until the next transform (0 when none)
 * @property {string|null} next     what it becomes next, or null
 */

/** The fire spots and fuel of every campfire and fire pit that holds something or has fuel. */
export class FireSlots {
  constructor() {
    /** @type {Map<string, FireEntry>} */
    this.map = new Map();
    /** bumped on every change of items, fuel entries or transforms (not on the fuel countdown itself) */
    this.version = 0;
  }

  /** @returns {number} fires with an entry */
  get size() {
    return this.map.size;
  }

  /** @returns {boolean} the fire has an entry (items or fuel) */
  has(q, y, r) {
    return this.map.has(fireKey(q, y, r));
  }

  /** @returns {FireEntry|null} the entry, created (not stored) when absent; null when absent and the cap is reached */
  _entry(q, y, r) {
    const e = this.map.get(fireKey(q, y, r));
    if (e) return e;
    if (this.map.size >= MAX_FIRE_SLOTS) return null;
    return { q, y, r, s: new Array(FIRE_SPOTS).fill(null), f: undefined, out: false };
  }

  /** Store `e` (when it holds anything), or forget it (when it holds nothing and has no fuel). */
  _keep(e) {
    const key = fireKey(e.q, e.y, e.r);
    if (e.f === undefined && e.s.every((x) => x === null)) this.map.delete(key);
    else this.map.set(key, e);
  }

  /**
   * Put ONE item on the fire: a skewer food on the free skewer nearest `facing`, a pot in the embers when they are free.
   * `facing` is the direction from the fire's centre toward where the item should go — main passes the angle toward the
   * player, `Math.atan2(pz − fz, px − fx)` (XZ plane, from +X toward +Z) — so the item lands on the near side; a
   * non-finite `facing` takes the lowest free skewer. Main checks that the fire burns and takes the item from the pack.
   * @param {number} q @param {number} y @param {number} r
   * @param {string} key
   * @param {number} [facing]
   * @returns {number} the spot used, or −1 (wrong kind of item, no free spot, or MAX_FIRE_SLOTS fires already hold things)
   */
  put(q, y, r, key, facing) {
    const skewer = SKEWER_FOOD_SET.has(key);
    if (!skewer && !CENTRE_POT_SET.has(key)) return -1;
    const e = this._entry(q, y, r);
    if (!e) return -1;
    const spot = skewer ? nearestFreeSkewer(e.s, facing) : e.s[EMBERS_SPOT] === null ? EMBERS_SPOT : -1;
    if (spot < 0) return -1;
    e.s[spot] = { k: key, t: 0 };
    this._keep(e);
    this.version++;
    return spot;
  }

  /** @returns {boolean} `put` would find a spot for `key` on this fire */
  canPut(q, y, r, key) {
    const skewer = SKEWER_FOOD_SET.has(key);
    if (!skewer && !CENTRE_POT_SET.has(key)) return false;
    const e = this._entry(q, y, r);
    if (!e) return false;
    return skewer ? e.s.slice(0, SKEWER_SPOTS).includes(null) : e.s[EMBERS_SPOT] === null;
  }

  /**
   * Take every spot whose item has finished at least one transform, or everything when none has. With `give`, a spot is
   * emptied only when `give(key)` accepts its item (main: it fit in the pack), so whatever does not fit stays on the fire.
   * @param {number} q @param {number} y @param {number} r
   * @param {(key: string) => boolean} [give]
   * @returns {ItemStack[]} one { k, n: 1 } per spot taken, in spot order
   */
  takeReady(q, y, r, give) {
    const e = this.map.get(fireKey(q, y, r));
    if (!e) return [];
    const full = e.s.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    const done = full.filter((i) => hasCooked(/** @type {{k: string}} */ (e.s[i]).k));
    /** @type {ItemStack[]} */
    const out = [];
    for (const i of done.length > 0 ? done : full) {
      const k = /** @type {{k: string}} */ (e.s[i]).k;
      if (give && !give(k)) continue;
      out.push({ k, n: 1 });
      e.s[i] = null;
    }
    if (out.length > 0) {
      this._keep(e);
      this.version++;
    }
    return out;
  }

  /** @returns {boolean} any spot of this fire holds an item */
  hasItems(q, y, r) {
    const e = this.map.get(fireKey(q, y, r));
    return Boolean(e && e.s.some((x) => x !== null));
  }

  /**
   * Give the fire `fuel` seconds of fuel (clamped to 0..CAMPFIRE_FUEL_MAX_S): a campfire placed in Survival, or a relit pit.
   * @returns {boolean} false when MAX_FIRE_SLOTS other fires already have entries (this one then burns forever)
   */
  light(q, y, r, fuel) {
    const e = this._entry(q, y, r);
    if (!e) return false;
    e.f = Math.max(0, Math.min(CAMPFIRE_FUEL_MAX_S, Number.isFinite(fuel) ? fuel : 0));
    e.out = false;
    this._keep(e);
    this.version++;
    return true;
  }

  /**
   * Feed the fire: add `seconds` of fuel, up to CAMPFIRE_FUEL_MAX_S.
   * @returns {'ok'|'full'|'untracked'} 'full' (nothing added) at the cap; 'untracked' for a fire without fuel (it burns
   *   forever: "This fire needs no fuel")
   */
  addFuel(q, y, r, seconds) {
    const e = this.map.get(fireKey(q, y, r));
    if (!e || e.f === undefined) return 'untracked';
    if (e.f >= CAMPFIRE_FUEL_MAX_S) return 'full';
    e.f = Math.min(CAMPFIRE_FUEL_MAX_S, e.f + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0));
    if (e.f > 0) e.out = false;
    this.version++;
    return 'ok';
  }

  /** @returns {number|null} fuel left in seconds, or null (no fuel entry: the fire burns forever) */
  fuel(q, y, r) {
    const e = this.map.get(fireKey(q, y, r));
    return e && e.f !== undefined ? e.f : null;
  }

  /**
   * Cook and burn for dt seconds (call only while Survival is active: nothing catches up later). A fire is stepped only
   * while `isLoaded(q, r)` and `isBurning(q, y, r)` (main: the cell is CAMPFIRE, not a cold FIRE_PIT). Its fuel counts down;
   * items cook only while there is fuel (or the fire has no fuel entry); a fire whose fuel reaches 0 is reported in
   * `burntOut` ONCE (main writes FIRE_PIT). `cooking` counts the items still cooking on burning fires (the sizzle).
   * @param {number} dt
   * @param {((q: number, y: number, r: number) => boolean)|null} isBurning
   * @param {((q: number, r: number) => boolean)|null} isLoaded
   * @returns {{ burntOut: [number, number, number][], cooking: number }}
   */
  step(dt, isBurning, isLoaded) {
    /** @type {[number, number, number][]} */
    const burntOut = [];
    let cooking = 0;
    if (!(Number.isFinite(dt) && dt > 0)) return { burntOut, cooking };
    for (const e of this.map.values()) {
      if (isLoaded && !isLoaded(e.q, e.r)) continue;
      if (isBurning && !isBurning(e.q, e.y, e.r)) continue;
      let cookDt = dt;
      if (e.f !== undefined) {
        if (e.f <= 0) {
          if (!e.out) {
            e.out = true;
            burntOut.push([e.q, e.y, e.r]);
          }
          continue;
        }
        cookDt = Math.min(dt, e.f);
        e.f = Math.max(0, e.f - dt);
      }
      for (const spot of e.s) {
        if (!spot) continue;
        let tr = TRANSFORM.get(spot.k);
        if (!tr) continue;
        spot.t += cookDt;
        while (tr && spot.t >= tr.seconds) {
          spot.t -= tr.seconds;
          spot.k = tr.to;
          tr = TRANSFORM.get(spot.k);
          this.version++;
        }
        if (tr) cooking++;
        else spot.t = 0;
      }
      if (e.f === 0 && !e.out) {
        e.out = true;
        burntOut.push([e.q, e.y, e.r]);
        this.version++;
      }
    }
    return { burntOut, cooking };
  }

  /**
   * A block changed (main forwards every change). A fire cell that stays a fire (CAMPFIRE ↔ FIRE_PIT: a burn-out or a
   * relight) keeps its spots; becoming a FIRE_PIT drops the fuel entry (a cold pit has no fuel; relighting calls light()).
   * Anything else releases the entry's items — into the pack when the player broke it in Survival (main's releaseToPack),
   * otherwise lost.
   * @returns {ItemStack[]} the released items, one { k, n: 1 } per spot
   */
  onBlockChange(q, y, r, prev, next) {
    const key = fireKey(q, y, r);
    const e = this.map.get(key);
    if (!e) return [];
    const wasFire = prev === BLOCK.CAMPFIRE || prev === BLOCK.FIRE_PIT;
    if (next === BLOCK.CAMPFIRE || next === BLOCK.FIRE_PIT) {
      if (!wasFire) return this._release(key, e); // an entry left by something else never passes to a new fire
      if (next === BLOCK.FIRE_PIT && e.f !== undefined) {
        e.f = undefined;
        e.out = false;
        this._keep(e);
        this.version++;
      }
      return [];
    }
    return this._release(key, e);
  }

  /** @returns {ItemStack[]} */
  _release(key, e) {
    this.map.delete(key);
    this.version++;
    return e.s.filter((x) => x !== null).map((x) => ({ k: /** @type {{k: string}} */ (x).k, n: 1 }));
  }

  /**
   * What is on a fire, for the renderer and the hint.
   * @returns {{ spots: (SpotView|null)[], fuel: number|null }|null} null when the fire has no entry
   */
  view(q, y, r) {
    const e = this.map.get(fireKey(q, y, r));
    if (!e) return null;
    return {
      spots: e.s.map((x) => {
        if (!x) return null;
        const tr = TRANSFORM.get(x.k);
        if (!tr) return { k: x.k, progress: 1, secondsLeft: 0, next: null };
        return { k: x.k, progress: Math.min(1, x.t / tr.seconds), secondsLeft: Math.max(0, tr.seconds - x.t), next: tr.to };
      }),
      fuel: e.f !== undefined ? e.f : null,
    };
  }

  /** @returns {FireSlotsJSON} the entries in key order (canonical: normalizeFiresJSON(export()) is the same) */
  export() {
    /** @type {Record<string, unknown>} */
    const raw = {};
    for (const [key, e] of this.map) {
      /** @type {{ s: ({k: string, t: number}|null)[], f?: number }} */
      const entry = { s: e.s.map((x) => (x ? { k: x.k, t: x.t } : null)) };
      if (e.f !== undefined) entry.f = e.f;
      raw[key] = entry;
    }
    return normalizeFiresJSON(raw).fires;
  }

  /**
   * Replace everything with a saved FireSlotsJSON (normalised again here, so a bad document cannot break the store).
   * @param {unknown} json
   * @returns {string[]} what was repaired
   */
  load(json) {
    const { fires, warnings } = normalizeFiresJSON(json ?? {});
    this.map.clear();
    for (const key of Object.keys(fires)) {
      const [q, y, r] = /** @type {[number, number, number]} */ (parseCellKey(key));
      const v = fires[key];
      this.map.set(key, { q, y, r, s: v.s.map((x) => (x ? { k: x.k, t: x.t } : null)), f: v.f, out: false });
    }
    this.version++;
    return warnings;
  }

  /** Forget every fire (a new world). */
  clear() {
    if (this.map.size > 0) this.version++;
    this.map.clear();
  }
}

/** @returns {number} the free skewer whose corner is nearest the `facing` angle (ties: the lower index), or −1 */
function nearestFreeSkewer(spots, facing) {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < SKEWER_SPOTS; k++) {
    if (spots[k] !== null) continue;
    if (!Number.isFinite(facing)) return k;
    const a = SKEWER_ANGLES[k] - facing;
    const d = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    if (d < bestD - 1e-9) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/**
 * The fire part of the campfire hint: "3 roasting (next 14 s) · 2 done · fuel 4:10". `roasting` counts the items that
 * have not finished a transform yet (with the soonest one's seconds), `done` the ones that have; the fuel part is left
 * out for a fire without fuel. '' when there is nothing to say.
 * @param {{ spots: (SpotView|null)[], fuel: number|null }|null} view
 * @returns {string}
 */
export function fireHint(view) {
  if (!view) return '';
  let roasting = 0;
  let done = 0;
  let next = Infinity;
  for (const s of view.spots) {
    if (!s) continue;
    if (hasCooked(s.k)) done++;
    else {
      roasting++;
      next = Math.min(next, s.secondsLeft);
    }
  }
  const parts = [];
  if (roasting > 0) parts.push(`${roasting} roasting (next ${Math.ceil(next)} s)`);
  if (done > 0) parts.push(`${done} done`);
  if (view.fuel !== null) parts.push(`fuel ${formatFuel(view.fuel)}`);
  return parts.join(' · ');
}
