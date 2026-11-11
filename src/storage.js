// Caelancraft — save / load of player meta and world edits. See src/CONTRACTS.md §14 and §41 (save slots).
// PURE: the storage backend is injected (default globalThis.localStorage); no DOM, no timers,
// no Math.random. Each world is ONE JSON document (serializeSave) under its own key: save slot n lives under
// slotKey(n) (§41); SAVE_KEY is the single save of the versions before save slots, moved into a slot by migrateLegacySave.
// The only clock is the `now` argument of the functions that stamp times (default Date.now()).
//
// v0.9 (docs/DESIGN-survival.md §1.4, §9.6): the optional `gen`, `mode`, `survival` and `containers` fields; a document
// carrying `gen` ≥ 2 or `survival` is version 3, everything else stays version 2 byte for byte.
// Circuits (docs/DESIGN-circuits.md §6.4): the optional `blackholes` and `circuits` switches and the configured parts
// (`circuitParts`), after `containers` and before `meta`. They change no version: an older client ignores them.
//
// Note: docs/SPEC-gameplay.md §8 describes a multi-key layout (`caelancraft:v1:meta` +
// `caelancraft:v1:chunk:<cx>,<cz>`) and an (x-innermost) localIndex formula. CONTRACTS.md wins:
// one key per world, `(lx*16+lz)*128+ly` local indices as produced by world.exportEdits().
import {
  CHUNK_VOLUME, HOTBAR_SIZE, PITCH_LIMIT, SAVE_SLOTS, MAX_WORLD_NAME_CHARS, STORAGE_QUOTA_ESTIMATE, CHUNK_SIZE, WORLD_HEIGHT,
  GEN_LATEST, PACK_SLOTS, WEAR_SLOTS, BASKET_SLOTS, REMAINS_SLOTS, STAT_MAX, BREATH_MAX_S, BODY_TEMP_NORMAL, BODY_TEMP_MIN,
  BODY_TEMP_MAX, SICK_MAX_S, HEAL_MAX,
} from './config.js';
import { BLOCK, DEFAULT_HOTBAR } from './blocks.js';
import { normalizeRunesJSON, validateRunesJSON } from './runes.js';
import { validatePigsJSON } from './pigs.js';
import { WEAR_SLOT_NAMES, canonicalItemKey, getItem, maxDurability, stackSize } from './items.js';
import { normalizeFiresJSON, parseCellKey } from './cooking.js';
import { normalizePartsJSON, validatePartsJSON } from './circuitStore.js';

/** @typedef {import('./types.js').SaveData} SaveData */
/** @typedef {import('./types.js').EditsJSON} EditsJSON */
/** @typedef {import('./types.js').RunesJSON} RunesJSON */

/**
 * Minimal Web Storage surface used here (localStorage satisfies it; tests use a Map-backed fake).
 * @typedef {{ getItem(key: string): (string|null), setItem(key: string, value: string): void,
 *   removeItem(key: string): void }} StorageLike
 */

export const SAVE_KEY = 'caelancraft:v2:save';
export const SAVE_VERSION = 2; // v2: edits are keyed by hex (q, r) chunks — v1 cube saves are not loadable
/**
 * v0.9 (DESIGN-survival §1.4): a document with `gen` ≥ 2 or a `survival` object is written as version 3, so an older client
 * reads it as unloadable (a damaged slot it never overwrites) instead of silently dropping the pack and regenerating gen-1
 * terrain under gen-2 edits. Everything else stays version 2, byte for byte. deserializeSave reads both.
 */
export const SURVIVAL_SAVE_VERSION = 3;

/** The canonical default hotbar (re-exported for callers that only know storage). */
export const DEFAULT_SAVE_HOTBAR = Object.freeze([...DEFAULT_HOTBAR]);
export const DEFAULT_SELECTED = 0;
/** Largest value a block id may take (ids live in Uint8Arrays). */
export const MAX_BLOCK_ID = 255;

/** Block-physics feature switches saved per world (CONTRACTS §14, §33.8); all on for a new world. */
export const PHYSICS_SWITCH_NAMES = Object.freeze(['falling', 'water', 'collapse', 'explosions']);
export const DEFAULT_PHYSICS_SWITCHES = Object.freeze({ falling: true, water: true, collapse: true, explosions: true });

/**
 * The `physics` save field in canonical form: exactly the four switches in order, each a boolean (anything that is
 * not `false` counts as on — a missing switch is a feature this save predates).
 * @param {unknown} raw  a plain object
 * @returns {{ falling: boolean, water: boolean, collapse: boolean, explosions: boolean }}
 */
export function normalizePhysicsSwitches(raw) {
  const src = isPlainObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    falling: src.falling !== false,
    water: src.water !== false,
    collapse: src.collapse !== false,
    explosions: src.explosions !== false,
  };
}

export { SAVE_SLOTS, MAX_WORLD_NAME_CHARS, STORAGE_QUOTA_ESTIMATE };

/**
 * A world name as stored: control characters become spaces, then trimmed and cut to MAX_WORLD_NAME_CHARS characters
 * (code points, so an emoji is never split) and trimmed again. '' when nothing usable is left (or `raw` is not a string).
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanWorldName(raw) {
  if (typeof raw !== 'string') return '';
  const chars = Array.from(raw.replace(/\p{Cc}/gu, ' ').trim());
  return chars.slice(0, MAX_WORLD_NAME_CHARS).join('').trim();
}

/** "World N": the name a slot's world gets when it is given none. @param {number} slot */
export function defaultWorldName(slot) {
  return `World ${slot}`;
}

/** cleanWorldName(raw), or defaultWorldName(slot) when that is empty (names are never empty). @param {unknown} raw @param {number} slot */
export function normalizeWorldName(raw, slot) {
  return cleanWorldName(raw) || defaultWorldName(slot);
}

/** Integer milliseconds since the epoch, or null for anything that is not a finite number ≥ 0. */
function cleanTimestamp(v) {
  return isFiniteNumber(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * The optional `meta` save field (§41) in canonical form: `{ name?, createdAt?, lastPlayed? }` in this key order, only the
 * usable fields (name through cleanWorldName, times as integer ms ≥ 0). null when `raw` is not an object or nothing is left.
 * @param {unknown} raw
 * @returns {{ name?: string, createdAt?: number, lastPlayed?: number }|null}
 */
export function normalizeWorldMeta(raw) {
  if (!isPlainObject(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {{ name?: string, createdAt?: number, lastPlayed?: number }} */
  const out = {};
  const name = cleanWorldName(src.name);
  if (name) out.name = name;
  const createdAt = cleanTimestamp(src.createdAt);
  if (createdAt !== null) out.createdAt = createdAt;
  const lastPlayed = cleanTimestamp(src.lastPlayed);
  if (lastPlayed !== null) out.lastPlayed = lastPlayed;
  return Object.keys(out).length > 0 ? out : null;
}

/** Chunk keys are `${cx},${cz}` with optional minus signs; nothing else is accepted on load. */
const CHUNK_KEY_RE = /^-?\d+,-?\d+$/;
const PLAYER_NUMBER_FIELDS = ['x', 'y', 'z', 'yaw', 'pitch'];

// ---------------------------------------------------------------------------------------------
// small predicates

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Non-null object that is not an array (JSON "object"). */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidBlockId(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_BLOCK_ID;
}

function isValidLocalIndex(v) {
  return Number.isInteger(v) && v >= 0 && v < CHUNK_VOLUME;
}

/** A night number (watcher.nightKey: main's day counter starts at 1, so the first night is 0): a whole number ≥ 0. */
function isNightNumber(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isValidSelected(v) {
  return Number.isInteger(v) && v >= 0 && v < HOTBAR_SIZE;
}

/**
 * Plain arrays pass through; numeric typed arrays are copied to plain arrays; anything else → null.
 * @param {unknown} v
 * @returns {number[]|null}
 */
function toPlainArray(v) {
  if (Array.isArray(v)) return v;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return Array.from(/** @type {ArrayLike<number>} */ (/** @type {unknown} */ (v)));
  }
  return null;
}

/** @returns {number[]|null} a fresh 9-element hotbar copy when `v` is valid, else null */
function validHotbarCopy(v) {
  const arr = toPlainArray(v);
  if (!arr || arr.length !== HOTBAR_SIZE) return null;
  for (let i = 0; i < HOTBAR_SIZE; i++) if (!isValidBlockId(arr[i])) return null;
  return arr.slice();
}

/** Day fraction wrapped into [0,1) (identity for values already in range). */
function wrapTime(t) {
  const w = t - Math.floor(t);
  return w >= 1 || w < 0 ? 0 : w; // guards float edge cases such as -1e-17 - floor(-1e-17) === 1
}

function clampPitch(p) {
  return p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p;
}

/** "01,2" → "1,2", "-0,3" → "0,3"; input must already match CHUNK_KEY_RE. */
function canonicalChunkKey(key) {
  const i = key.indexOf(',');
  return `${Number(key.slice(0, i))},${Number(key.slice(i + 1))}`;
}

/**
 * Total order over chunk keys: well-formed keys first, by cx then cz numerically; anything else
 * after them in plain string order. Deterministic regardless of the caller's insertion order.
 */
function compareChunkKeys(a, b) {
  const va = CHUNK_KEY_RE.test(a);
  const vb = CHUNK_KEY_RE.test(b);
  if (va && vb) {
    const ia = a.indexOf(',');
    const ib = b.indexOf(',');
    const dx = Number(a.slice(0, ia)) - Number(b.slice(0, ib));
    if (dx !== 0) return dx;
    const dz = Number(a.slice(ia + 1)) - Number(b.slice(ib + 1));
    if (dz !== 0) return dz;
  } else if (va !== vb) {
    return va ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Survival fields (v0.9; docs/DESIGN-survival.md §1.4, §9.6): gen, mode, survival, containers

/** The survival modes a save may name. */
export const SAVE_MODES = Object.freeze(['creative', 'survival']);

/** Causes of death a saved `survival.dead` may name (DESIGN-survival §2.4). */
export const DEATH_CAUSES = Object.freeze([
  'fall', 'drown', 'buried', 'crush', 'fire', 'zombie', 'blast', 'log', 'blackhole', 'starve', 'thirst', 'cold', 'heat', 'sick',
  'void', 'command',
]);

/** Largest bandage payout rate saved (`healRate`, HP/s). */
const HEAL_RATE_MAX = 5;

/** @returns {readonly [string, number, number, number]} a frozen stat row */
function statRow(name, lo, hi, fresh) {
  return /** @type {readonly [string, number, number, number]} */ (Object.freeze([name, lo, hi, fresh]));
}

/** The stats of a SurvivalJSON in canonical order: [name, min, max, fresh value (§2.1)]. */
export const SURVIVAL_STATS = Object.freeze([
  statRow('health', 0, STAT_MAX, STAT_MAX),
  statRow('satiation', 0, STAT_MAX, 80),
  statRow('hydration', 0, STAT_MAX, 80),
  statRow('temp', BODY_TEMP_MIN, BODY_TEMP_MAX, BODY_TEMP_NORMAL),
  statRow('breath', 0, BREATH_MAX_S, BREATH_MAX_S),
  statRow('wet', 0, 1, 0),
  statRow('sick', 0, SICK_MAX_S, 0),
  statRow('heal', 0, HEAL_MAX, 0),
  statRow('healRate', 0, HEAL_RATE_MAX, 0),
]);

/** Three decimal places, never −0 (NaN stays NaN). */
function round3(v) {
  return Math.round(v * 1000) / 1000 + 0;
}

/**
 * Check one saved item stack (§5.2).
 * @param {unknown} raw
 * @returns {{ stack: {k: string, n: number, d?: number}, note?: string }|{ reason: string }}   `note`: a repair made
 */
function checkStack(raw) {
  const v = /** @type {Record<string, any>} */ (raw);
  if (!isPlainObject(v) || typeof v.k !== 'string') return { reason: 'not an item stack' };
  // v0.10 (DESIGN-circuits §8.3): `black_hole` and `blast_barrel` stacks are the Collapsar Charge and the Powder Keg now.
  const k = canonicalItemKey(v.k);
  const def = getItem(k);
  if (!def) return { reason: `unknown item ${JSON.stringify(v.k)}` };
  const max = stackSize(k);
  if (!Number.isInteger(v.n) || v.n < 1 || v.n > max) return { reason: `count is not 1–${max}` };
  /** @type {{k: string, n: number, d?: number}} */
  const stack = { k, n: v.n };
  if (v.d === undefined || v.d === null) return { stack };
  const dmax = maxDurability(k);
  if (dmax === 0) return { stack, note: `durability ignored (${def.name} never wears)` };
  if (!Number.isInteger(v.d) || v.d < 1 || v.d > dmax) return { reason: `durability is not 1–${dmax}` };
  stack.d = v.d;
  return { stack };
}

/**
 * A list of stack slots (pack, wear, a container): bad stacks become null with `<at>[i]: <reason>, dropped`.
 * @param {unknown[]} list
 * @param {string} at        warning prefix, e.g. 'survival.pack'
 * @param {string[]} warnings
 * @param {(def: import('./types.js').ItemDef, i: number) => string} [slotRule]   '' or why slot i may not hold it
 * @returns {({k: string, n: number, d?: number}|null)[]}
 */
function normalizeStacks(list, at, warnings, slotRule) {
  return list.map((v, i) => {
    if (v === null || v === undefined) return null;
    const c = checkStack(v);
    if ('reason' in c) {
      warnings.push(`${at}[${i}]: ${c.reason}, dropped`);
      return null;
    }
    const why = slotRule ? slotRule(/** @type {import('./types.js').ItemDef} */ (getItem(c.stack.k)), i) : '';
    if (why) {
      warnings.push(`${at}[${i}]: ${why}, dropped`);
      return null;
    }
    if (c.note) warnings.push(`${at}[${i}]: ${c.note}`);
    return c.stack;
  });
}

/** A fixed-size slot list: padded with null or cut, with a warning; a non-array is all empty. */
function fixedSlots(raw, size, at, warnings) {
  if (!Array.isArray(raw)) {
    warnings.push(`${at}: not a list, emptied`);
    return new Array(size).fill(null);
  }
  if (raw.length === size) return raw;
  warnings.push(`${at}: ${raw.length} slots, expected ${size} (${raw.length < size ? 'padded' : 'cut'})`);
  return raw.length < size ? raw.concat(new Array(size - raw.length).fill(null)) : raw.slice(0, size);
}

/** Wear slot i holds only wear items made for it. */
function wearSlotRule(def, i) {
  if (def.kind !== 'wear' || !def.wear) return 'not a wear item';
  return def.wear.slot === WEAR_SLOT_NAMES[i] ? '' : `a ${def.wear.slot} item in the ${WEAR_SLOT_NAMES[i]} slot`;
}

/**
 * The id `edits` (repaired EditsJSON: one pair per local index) records at cell (q, y, r), or −1 when none. Builds a
 * per-chunk lookup in `cache` so many checks against one save stay cheap.
 * @param {Record<string, number[]>} edits
 * @param {Map<string, Map<number, number>>} cache
 */
function editIdAt(edits, cache, q, y, r) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const key = `${cq},${cr}`;
  let cells = cache.get(key);
  if (!cells) {
    cells = new Map();
    const arr = edits && Object.hasOwn(edits, key) ? edits[key] : null;
    if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) cells.set(arr[i], arr[i + 1]);
    cache.set(key, cells);
  }
  const li = ((q - cq * CHUNK_SIZE) * CHUNK_SIZE + (r - cr * CHUNK_SIZE)) * WORLD_HEIGHT + y;
  return cells.get(li) ?? -1;
}

/**
 * The `survival` save field in canonical form (§9.6): the stats rounded to 3 decimal places in key order, `spawn`, `deaths`,
 * `dead` (only when set), `pack` (PACK_SLOTS), `wear` (WEAR_SLOTS) and `fires`. Never fails: a bad stat is reset to its
 * fresh value (`survival.<stat>: invalid, reset`), a bad stack is dropped (`survival.pack[i]: <reason>, dropped`), a pack or
 * wear list of the wrong length is padded or cut, and the fires are canonicalised by cooking.normalizeFiresJSON — checked
 * against `opts.edits` when given (an entry whose cell is not CAMPFIRE or FIRE_PIT there is dropped).
 * @param {unknown} raw
 * @param {string[]} [warnings]   repairs are pushed here
 * @param {{ edits?: Record<string, number[]> }} [opts]
 * @returns {import('./types.js').SurvivalJSON}
 */
export function normalizeSurvivalJSON(raw, warnings = [], opts = {}) {
  const src = isPlainObject(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, lo, hi, fresh] of SURVIVAL_STATS) {
    const v = isFiniteNumber(src[name]) ? round3(src[name]) : NaN;
    if (v >= lo && v <= hi) out[name] = v;
    else {
      out[name] = fresh;
      warnings.push(`survival.${name}: invalid, reset`);
    }
  }
  const sp = src.spawn;
  if (sp === null || sp === undefined) out.spawn = null;
  else if (Array.isArray(sp) && sp.length === 3 && Number.isSafeInteger(sp[0]) && Number.isSafeInteger(sp[2])
    && Number.isInteger(sp[1]) && sp[1] >= 0 && sp[1] < WORLD_HEIGHT) out.spawn = [sp[0] + 0, sp[1], sp[2] + 0];
  else {
    out.spawn = null;
    warnings.push('survival.spawn: invalid, reset');
  }
  if (Number.isSafeInteger(src.deaths) && src.deaths >= 0) out.deaths = src.deaths;
  else {
    out.deaths = 0;
    warnings.push('survival.deaths: invalid, reset');
  }
  if (src.dead !== undefined && src.dead !== null) {
    if (DEATH_CAUSES.includes(src.dead)) out.dead = src.dead;
    else warnings.push('survival.dead: not a cause of death, ignored');
  }
  out.pack = normalizeStacks(fixedSlots(src.pack, PACK_SLOTS, 'survival.pack', warnings), 'survival.pack', warnings);
  out.wear = normalizeStacks(fixedSlots(src.wear, WEAR_SLOTS, 'survival.wear', warnings), 'survival.wear', warnings, wearSlotRule);
  const edits = opts && opts.edits;
  /** @type {Map<string, Map<number, number>>} */
  const cache = new Map();
  const fires = normalizeFiresJSON(src.fires, {
    prefix: 'survival.fires',
    cellOk: edits ? (q, y, r) => {
      const id = editIdAt(edits, cache, q, y, r);
      return id === BLOCK.CAMPFIRE || id === BLOCK.FIRE_PIT;
    } : undefined,
  });
  for (const w of fires.warnings) warnings.push(w);
  out.fires = fires.fires;
  // v0.10 (CONTRACTS §60): the items lying loose in the world, written only when there are any.
  if (src.loose !== undefined) {
    const loose = normalizeLooseJSON(src.loose, warnings);
    if (loose.length > 0) out.loose = loose;
  }
  return /** @type {import('./types.js').SurvivalJSON} */ (out);
}

/** At most this many loose items are kept in a save (the rest are dropped with one warning). */
export const LOOSE_SAVE_MAX = 2000;
/** A saved loose item's age `a` (whole seconds lying loose) is at most this (looseItems.LOOSE_DESPAWN_S). */
export const LOOSE_AGE_MAX = 300;

/**
 * The `survival.loose` list in canonical form (CONTRACTS §60, §63): `{ k, n, d?, a?, x, y, z }` in that key order, `k` a
 * non-empty string, `n` an integer 1–999, `d` (a tool's wear left) an integer ≥ 0 or absent, `a` (seconds lying loose) an
 * integer 1–LOOSE_AGE_MAX or absent (0 is dropped), x y z finite (rounded to 3 places). Bad
 * entries are dropped with a warning; anything but an array is ignored.
 * @param {*} raw
 * @param {string[]} [warnings]
 * @returns {{ k: string, n: number, d?: number, x: number, y: number, z: number }[]}
 */
export function normalizeLooseJSON(raw, warnings = []) {
  if (!Array.isArray(raw)) {
    warnings.push('survival.loose: not a list, ignored');
    return [];
  }
  /** @type {{ k: string, n: number, d?: number, a?: number, x: number, y: number, z: number }[]} */
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    const okStack = isPlainObject(o) && typeof o.k === 'string' && o.k !== '' && Number.isInteger(o.n) && o.n >= 1 && o.n <= 999;
    const okPos = okStack && isFiniteNumber(o.x) && isFiniteNumber(o.y) && isFiniteNumber(o.z);
    const okD = okPos && (o.d === undefined || (Number.isInteger(o.d) && o.d >= 0));
    const okA = okD && (o.a === undefined || (Number.isInteger(o.a) && o.a >= 0 && o.a <= LOOSE_AGE_MAX));
    if (!okA) {
      warnings.push(`survival.loose[${i}]: invalid, dropped`);
      continue;
    }
    if (out.length >= LOOSE_SAVE_MAX) {
      warnings.push(`survival.loose: more than ${LOOSE_SAVE_MAX} items, the rest dropped`);
      break;
    }
    /** @type {*} */
    const e = { k: o.k, n: o.n };
    if (o.d !== undefined) e.d = o.d;
    if (o.a) e.a = o.a;
    e.x = round3(o.x);
    e.y = round3(o.y);
    e.z = round3(o.z);
    out.push(e);
  }
  return out;
}

/**
 * The `containers` save field in canonical form (§5.6, §9.6): keys "q,y,r" parsed strictly and rewritten canonically (last
 * write wins), sorted by (q, y, r); each entry `{ kind, slots }`. An entry is dropped for a malformed key, an unknown kind,
 * slots that are not a list or more than the kind holds (basket BASKET_SLOTS, remains REMAINS_SLOTS), or — when
 * `opts.edits` is given — a cell not recorded there as WICKER_BASKET (basket) or REMAINS (remains). Bad stacks become null.
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @param {{ edits?: Record<string, number[]> }} [opts]
 * @returns {import('./types.js').ContainersJSON}
 */
export function normalizeContainersJSON(raw, warnings = [], opts = {}) {
  if (!isPlainObject(raw)) return {};
  const src = /** @type {Record<string, any>} */ (raw);
  const edits = opts && opts.edits;
  /** @type {Map<string, Map<number, number>>} */
  const cache = new Map();
  /** @type {Map<string, { cell: [number, number, number], entry: { kind: 'basket'|'remains', slots: ({k: string, n: number, d?: number}|null)[] } }>} */
  const kept = new Map();
  for (const rawKey of Object.keys(src)) {
    const cell = parseCellKey(rawKey);
    if (!cell) {
      warnings.push(`containers: dropped entry with malformed key ${JSON.stringify(rawKey)}`);
      continue;
    }
    const key = `${cell[0]},${cell[1]},${cell[2]}`;
    const at = `containers[${key}]`;
    const v = src[rawKey];
    if (!isPlainObject(v)) {
      warnings.push(`${at}: not an object, dropped`);
      continue;
    }
    if (v.kind !== 'basket' && v.kind !== 'remains') {
      warnings.push(`${at}: unknown kind ${JSON.stringify(v.kind ?? null)}, dropped`);
      continue;
    }
    if (!Array.isArray(v.slots)) {
      warnings.push(`${at}: slots is not a list, dropped`);
      continue;
    }
    const max = v.kind === 'basket' ? BASKET_SLOTS : REMAINS_SLOTS;
    if (v.slots.length > max) {
      warnings.push(`${at}: ${v.slots.length} slots, more than a ${v.kind === 'basket' ? 'basket' : 'belongings heap'} holds (${max}), dropped`);
      continue;
    }
    if (edits) {
      const want = v.kind === 'basket' ? BLOCK.WICKER_BASKET : BLOCK.REMAINS;
      if (editIdAt(edits, cache, cell[0], cell[1], cell[2]) !== want) {
        warnings.push(`${at}: no ${v.kind === 'basket' ? 'basket' : 'belongings'} there, dropped`);
        continue;
      }
    }
    kept.delete(key);
    kept.set(key, { cell, entry: { kind: v.kind, slots: normalizeStacks(v.slots, `${at}.slots`, warnings) } });
  }
  /** @type {Record<string, any>} */
  const out = {};
  const sorted = [...kept.values()].sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1] || a.cell[2] - b.cell[2]);
  for (const { cell, entry } of sorted) out[`${cell[0]},${cell[1]},${cell[2]}`] = entry;
  return out;
}

/**
 * Whether a save (or SaveData about to be saved) is a Survival world: `mode: 'survival'` on generation 2 or later (a
 * Survival mode on generation 1 loads in Creative, §1.3).
 * @param {unknown} data
 * @returns {boolean}
 */
export function isSurvivalSave(data) {
  if (!isPlainObject(data)) return false;
  const d = /** @type {Record<string, unknown>} */ (data);
  return d.mode === 'survival' && Number.isInteger(d.gen) && /** @type {number} */ (d.gen) >= 2;
}

/**
 * Why a save text cannot be loaded, for messages: '' when deserializeSave accepts it.
 * @param {string} text
 * @returns {string}  e.g. 'gen 3: made by a newer version of Caelancraft', 'version 4: not a version this game reads'
 */
export function unloadableReason(text) {
  if (deserializeSave(text)) return '';
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'not a save (unreadable text)';
  }
  if (!isPlainObject(raw)) return 'not a save';
  if (raw.version !== SAVE_VERSION && raw.version !== SURVIVAL_SAVE_VERSION) {
    return `version ${JSON.stringify(raw.version ?? null)}: not a version this game reads`;
  }
  if (Number.isInteger(raw.gen) && raw.gen > GEN_LATEST) return `gen ${raw.gen}: made by a newer version of Caelancraft`;
  return 'a required field is missing or invalid';
}

// ---------------------------------------------------------------------------------------------
// serialise

/**
 * Canonical JSON text of a save: fixed key order, chunk keys sorted, invalid hotbar/selected
 * replaced by defaults, empty chunk arrays dropped. Edit pairs are copied verbatim (validation is
 * the loader's job) so autosave stays cheap.
 *
 * Throws a TypeError instead of producing a document that deserializeSave would reject
 * (non-finite seed/time/day or player numbers, missing player, edits that are not an EditsJSON
 * object, a `gen` above GEN_LATEST) or silently losing state (a `survival` or `containers` that is not an
 * object). saveGame() turns that into `false` so a good save on disk is never overwritten.
 * Written as version 3 (SURVIVAL_SAVE_VERSION) exactly when `gen` ≥ 2 or `survival` is present, else version 2.
 * @param {SaveData} data
 * @returns {string}
 */
export function serializeSave(data) {
  if (!isPlainObject(data)) throw new TypeError('serializeSave: data must be a SaveData object');
  const { seed, time, day, player, edits } = data;
  if (!isFiniteNumber(seed)) throw new TypeError('serializeSave: seed must be a finite number');
  if (!isFiniteNumber(time)) throw new TypeError('serializeSave: time must be a finite number');
  if (!isFiniteNumber(day)) throw new TypeError('serializeSave: day must be a finite number');
  if (!isPlainObject(player)) throw new TypeError('serializeSave: player must be an object');
  for (const f of PLAYER_NUMBER_FIELDS) {
    if (!isFiniteNumber(player[f])) throw new TypeError(`serializeSave: player.${f} must be a finite number`);
  }
  if (edits != null && (!isPlainObject(edits) || edits instanceof Map)) {
    throw new TypeError('serializeSave: edits must be an EditsJSON object (use world.exportEdits())');
  }
  if (data.runes != null && (!isPlainObject(data.runes) || data.runes instanceof Map)) {
    throw new TypeError('serializeSave: runes must be a RunesJSON object (use runes.export())');
  }
  if (data.meta != null && !isPlainObject(data.meta)) throw new TypeError('serializeSave: meta must be an object');
  if (data.survival != null && (!isPlainObject(data.survival) || data.survival instanceof Map)) {
    throw new TypeError('serializeSave: survival must be a SurvivalJSON object');
  }
  if (data.containers != null && (!isPlainObject(data.containers) || data.containers instanceof Map)) {
    throw new TypeError('serializeSave: containers must be a ContainersJSON object (use containers.export())');
  }
  if (data.circuitParts != null && (!isPlainObject(data.circuitParts) || data.circuitParts instanceof Map)) {
    throw new TypeError('serializeSave: circuitParts must be a CircuitPartsJSON object (use circuitStore.export())');
  }
  if (Number.isInteger(data.gen) && data.gen > GEN_LATEST) {
    throw new TypeError(`serializeSave: gen ${data.gen} is newer than this game (${GEN_LATEST})`);
  }

  /** @type {Record<string, number[]>} */
  const outEdits = {};
  if (edits != null) {
    const keys = Object.keys(edits).sort(compareChunkKeys);
    for (const key of keys) {
      const arr = toPlainArray(edits[key]);
      if (arr && arr.length > 0) outEdits[key] = arr;
    }
  }

  const out = {
    version: SAVE_VERSION,
    seed,
    time: wrapTime(time),
    day,
    player: {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: clampPitch(player.pitch),
      flying: Boolean(player.flying),
    },
    hotbar: validHotbarCopy(data.hotbar) ?? DEFAULT_SAVE_HOTBAR.slice(),
    selected: isValidSelected(data.selected) ? data.selected : DEFAULT_SELECTED,
    edits: outEdits,
  };
  // Runes are optional and omitted when empty, so worlds without customised rune blocks serialise exactly as before.
  if (data.runes != null) {
    const runes = normalizeRunesJSON(data.runes).runes;
    if (Object.keys(runes).length > 0) /** @type {*} */ (out).runes = runes;
  }
  // Pigs are optional too, but an empty list IS written: "this world's pigs are all gone" must survive a reload
  // (an absent field means "never had pigs" and main places natural ones).
  if (data.pigs != null) /** @type {*} */ (out).pigs = validatePigsJSON(data.pigs).pigs;
  // Block-physics switches (v0.8): written whenever given. An absent field on load means "saved before v0.8".
  if (data.physics != null) /** @type {*} */ (out).physics = normalizePhysicsSwitches(data.physics);
  // Zombies switch (§39): written whenever given (anything but `false` is on). Absent on load = on.
  if (data.zombies != null) /** @type {*} */ (out).zombies = data.zombies !== false;
  // The Hollow Watcher's switch (§40): the same rule. The Watcher itself is a sighting and never saved.
  if (data.watcher != null) /** @type {*} */ (out).watcher = data.watcher !== false;
  // The night of its last natural sighting (§40.1), so a reload in the same night cannot bring a second one. Written only
  // as a night number (anything else is left out); absent — no sighting yet, or an older save — means none.
  if (isNightNumber(data.watcherNight)) /** @type {*} */ (out).watcherNight = data.watcherNight;
  // Survival (v0.9, DESIGN-survival §1.4 / §9.6), in this order: the generator version (only when ≥ 2: absent = 1, today's
  // land), the mode, the frozen or live survival state (canonical), and the baskets and belongings (only when non-empty).
  // None of them is written for a Creative world that never entered Survival, so it serialises byte-identically to before.
  if (Number.isInteger(data.gen) && data.gen >= 2) /** @type {*} */ (out).gen = data.gen;
  if (SAVE_MODES.includes(data.mode)) /** @type {*} */ (out).mode = data.mode;
  if (data.survival != null) /** @type {*} */ (out).survival = normalizeSurvivalJSON(data.survival);
  if (data.containers != null) {
    const containers = normalizeContainersJSON(data.containers);
    if (Object.keys(containers).length > 0) /** @type {*} */ (out).containers = containers;
  }
  // Circuits (DESIGN-circuits §6.4), in this order: the black-holes and circuits switches (written whenever given; anything
  // but `false` is on, the `zombies` rule; absent on load = on) and the configured parts (only when non-empty).
  if (data.blackholes != null) /** @type {*} */ (out).blackholes = data.blackholes !== false;
  if (data.circuits != null) /** @type {*} */ (out).circuits = data.circuits !== false;
  if (data.circuitParts != null) {
    const parts = normalizePartsJSON(data.circuitParts).parts;
    if (Object.keys(parts).length > 0) /** @type {*} */ (out).circuitParts = parts;
  }
  // Version 3 exactly when gen ≥ 2 or a survival state is present (older clients then show the slot as damaged).
  if (/** @type {*} */ (out).gen !== undefined || /** @type {*} */ (out).survival !== undefined) {
    /** @type {*} */ (out).version = SURVIVAL_SAVE_VERSION;
  }
  // The world's name and times (§41): last, canonical (normalizeWorldMeta), omitted when nothing usable is given.
  const meta = data.meta != null ? normalizeWorldMeta(data.meta) : null;
  if (meta) /** @type {*} */ (out).meta = meta;
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------------------------
// deserialise

/**
 * Parse and strictly validate a save document.
 *
 * Returns null on: unparsable/non-object JSON, a `version` other than SAVE_VERSION (2) or SURVIVAL_SAVE_VERSION (3), an
 * integer `gen` above GEN_LATEST (a newer generator: see unloadableReason), missing or non-finite
 * `seed`/`time`/`day`, missing `player` or non-finite `player.{x,y,z,yaw,pitch}`, or `edits`
 * that is not an object. Recoverable problems are repaired instead: invalid hotbar/selected →
 * defaults; edit pairs failing `0 <= localIndex < CHUNK_VOLUME` / `0 <= id <= 255` / integer-ness
 * are dropped (last write wins for duplicates, dangling odd element dropped); malformed chunk keys
 * and non-array entries are dropped; `time` is wrapped into [0,1) and `pitch` clamped. An optional `runes`
 * field is validated with runes.validateRunesJSON (invalid or orphaned entries dropped) and only kept when non-empty.
 * An optional `pigs` array is validated with pigs.validatePigsJSON and kept (even when empty).
 * An optional `physics` object (block-physics switches) is normalised with normalizePhysicsSwitches; a non-object is
 * dropped with a warning (the save then reads as one from before v0.8).
 * An optional boolean `zombies` (the world's zombies switch, §39) is kept; anything else is dropped with a warning
 * (absent means on).
 * An optional boolean `watcher` (the world's Hollow Watcher switch, §40) is kept the same way (absent means on).
 * An optional `watcherNight` (the night of the world's last natural Watcher sighting, §40.1) is kept when it is a whole
 * number ≥ 0; anything else is dropped with a warning (absent means none).
 * An optional `meta` object (the world's name and times, §41) is kept as normalizeWorldMeta gives it (unusable fields are
 * dropped with a warning, a non-object with `meta: not an object, ignored`).
 * Survival (v0.9, DESIGN-survival §9.6): `gen` is kept when it is an integer ≥ 2 (1 is dropped, anything else warns
 * `gen: not a generator version, treated as 1`); `mode` when it is 'creative' or 'survival' (a Survival mode on generation 1
 * loads as 'creative' with `mode: survival needs generation 2; loaded in Creative`); `survival` through normalizeSurvivalJSON
 * (its fires checked against the repaired edits); `containers` through normalizeContainersJSON (checked against the edits,
 * kept when non-empty). The result's `version` is 3 exactly when it has `gen` ≥ 2 or `survival`, else 2.
 * Circuits (DESIGN-circuits §6.4): booleans `blackholes` and `circuits` are kept (anything else is dropped with
 * `blackholes: not a boolean, treated as on`); `circuitParts` through circuitStore.validatePartsJSON against the repaired
 * edits (orphans, unknown kinds, bad keys and fields repaired with a warning each; kept when non-empty; a non-object warns
 * `circuitParts: not an object, ignored`).
 * Every repair is described in a non-enumerable `warnings: string[]` on the result.
 * @param {string} text
 * @returns {SaveData|null}
 */
export function deserializeSave(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  if (raw.version !== SAVE_VERSION && raw.version !== SURVIVAL_SAVE_VERSION) return null;
  // A world from a newer generator cannot be read: its untouched land would be regenerated wrongly under its edits.
  if (Number.isInteger(raw.gen) && raw.gen > GEN_LATEST) return null;
  if (!isFiniteNumber(raw.seed) || !isFiniteNumber(raw.time) || !isFiniteNumber(raw.day)) return null;
  const p = raw.player;
  if (!isPlainObject(p)) return null;
  for (const f of PLAYER_NUMBER_FIELDS) if (!isFiniteNumber(p[f])) return null;
  if (!isPlainObject(raw.edits)) return null;

  /** @type {string[]} */
  const warnings = [];

  let hotbar = validHotbarCopy(raw.hotbar);
  if (!hotbar) {
    hotbar = DEFAULT_SAVE_HOTBAR.slice();
    warnings.push('hotbar: invalid or missing, using defaults');
  }
  let selected = raw.selected;
  if (!isValidSelected(selected)) {
    selected = DEFAULT_SELECTED;
    warnings.push('selected: invalid or missing, using default');
  }

  // Validate edits into Map<canonicalKey, Map<localIndex, id>> so duplicates resolve last-write-wins.
  /** @type {Map<string, Map<number, number>>} */
  const perChunk = new Map();
  for (const key of Object.keys(raw.edits)) {
    if (!CHUNK_KEY_RE.test(key)) {
      warnings.push(`edits: dropped entry with malformed chunk key ${JSON.stringify(key)}`);
      continue;
    }
    const arr = raw.edits[key];
    if (!Array.isArray(arr)) {
      warnings.push(`edits[${key}]: dropped non-array entry`);
      continue;
    }
    const canonical = canonicalChunkKey(key);
    let cells = perChunk.get(canonical);
    if (!cells) {
      cells = new Map();
      perChunk.set(canonical, cells);
    }
    let dropped = 0;
    const n = arr.length;
    for (let i = 0; i + 1 < n; i += 2) {
      const li = arr[i];
      const id = arr[i + 1];
      if (isValidLocalIndex(li) && isValidBlockId(id)) cells.set(li, id);
      else dropped++;
    }
    if (n % 2 === 1) dropped++; // dangling element of an odd-length array
    if (dropped > 0) warnings.push(`edits[${key}]: dropped ${dropped} invalid pair(s)`);
  }

  /** @type {Record<string, number[]>} */
  const edits = {};
  for (const [key, cells] of perChunk) {
    if (cells.size === 0) continue;
    const flat = new Array(cells.size * 2);
    let i = 0;
    for (const [li, id] of cells) {
      flat[i++] = li;
      flat[i++] = id;
    }
    edits[key] = flat;
  }

  /** @type {SaveData} */
  const save = {
    version: SAVE_VERSION,
    seed: raw.seed,
    time: wrapTime(raw.time),
    day: raw.day,
    player: {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: clampPitch(p.pitch),
      flying: p.flying === true,
    },
    hotbar,
    selected,
    edits,
  };
  if (raw.runes !== undefined) {
    if (!isPlainObject(raw.runes)) {
      warnings.push('runes: not an object, ignored');
    } else {
      const v = validateRunesJSON(raw.runes, edits);
      for (const w of v.warnings) warnings.push(w);
      if (Object.keys(v.runes).length > 0) save.runes = v.runes;
    }
  }
  if (raw.pigs !== undefined) {
    const v = validatePigsJSON(raw.pigs);
    for (const w of v.warnings) warnings.push(w);
    save.pigs = v.pigs;
  }
  if (raw.physics !== undefined) {
    if (!isPlainObject(raw.physics)) {
      warnings.push('physics: not an object, ignored');
    } else {
      for (const name of PHYSICS_SWITCH_NAMES) {
        const v = raw.physics[name];
        if (v !== undefined && typeof v !== 'boolean') warnings.push(`physics.${name}: not a boolean, treated as on`);
      }
      /** @type {*} */ (save).physics = normalizePhysicsSwitches(raw.physics);
    }
  }
  if (raw.zombies !== undefined) {
    if (typeof raw.zombies === 'boolean') /** @type {*} */ (save).zombies = raw.zombies;
    else warnings.push('zombies: not a boolean, treated as on');
  }
  if (raw.watcher !== undefined) {
    if (typeof raw.watcher === 'boolean') /** @type {*} */ (save).watcher = raw.watcher;
    else warnings.push('watcher: not a boolean, treated as on');
  }
  if (raw.watcherNight !== undefined) {
    if (isNightNumber(raw.watcherNight)) /** @type {*} */ (save).watcherNight = raw.watcherNight;
    else warnings.push('watcherNight: not a night number, ignored');
  }
  // Survival (v0.9): never a null save for these fields (gen > GEN_LATEST was refused above).
  let gen = 1;
  if (raw.gen !== undefined) {
    if (Number.isInteger(raw.gen) && raw.gen >= 1) gen = raw.gen;
    else warnings.push('gen: not a generator version, treated as 1');
  }
  if (gen >= 2) /** @type {*} */ (save).gen = gen;
  if (raw.mode !== undefined) {
    if (!SAVE_MODES.includes(raw.mode)) warnings.push('mode: not creative or survival, treated as creative');
    else if (raw.mode === 'survival' && gen < 2) {
      // Only possible by hand-editing (§1.3): no silent terrain rewrite. The pause menu offers the upgrade as usual.
      warnings.push('mode: survival needs generation 2; loaded in Creative');
      /** @type {*} */ (save).mode = 'creative';
    } else /** @type {*} */ (save).mode = raw.mode;
  }
  if (raw.survival !== undefined) {
    if (!isPlainObject(raw.survival)) warnings.push('survival: not an object, ignored');
    else /** @type {*} */ (save).survival = normalizeSurvivalJSON(raw.survival, warnings, { edits });
  }
  if (raw.containers !== undefined) {
    if (!isPlainObject(raw.containers)) warnings.push('containers: not an object, ignored');
    else {
      const containers = normalizeContainersJSON(raw.containers, warnings, { edits });
      if (Object.keys(containers).length > 0) /** @type {*} */ (save).containers = containers;
    }
  }
  for (const name of ['blackholes', 'circuits']) {
    if (raw[name] === undefined) continue;
    if (typeof raw[name] === 'boolean') /** @type {*} */ (save)[name] = raw[name];
    else warnings.push(`${name}: not a boolean, treated as on`);
  }
  if (raw.circuitParts !== undefined) {
    if (!isPlainObject(raw.circuitParts)) warnings.push('circuitParts: not an object, ignored');
    else {
      // The orphan check reuses this function's own per-chunk map of the repaired edits: O(1) per entry.
      const v = validatePartsJSON(raw.circuitParts, edits, perChunk);
      for (const w of v.warnings) warnings.push(w);
      if (Object.keys(v.parts).length > 0) /** @type {*} */ (save).circuitParts = v.parts;
    }
  }
  if (gen >= 2 || /** @type {*} */ (save).survival !== undefined) save.version = SURVIVAL_SAVE_VERSION;
  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) {
      warnings.push('meta: not an object, ignored');
    } else {
      if (raw.meta.name !== undefined && cleanWorldName(raw.meta.name) === '') warnings.push('meta.name: not a usable name, ignored');
      for (const f of ['createdAt', 'lastPlayed']) {
        if (raw.meta[f] !== undefined && cleanTimestamp(raw.meta[f]) === null) warnings.push(`meta.${f}: not a timestamp, ignored`);
      }
      const meta = normalizeWorldMeta(raw.meta);
      if (meta) /** @type {*} */ (save).meta = meta;
    }
  }
  Object.defineProperty(save, 'warnings', { value: warnings, enumerable: false, writable: true, configurable: true });
  return save;
}

// ---------------------------------------------------------------------------------------------
// storage wrappers (the single SAVE_KEY save of the versions before save slots; main uses the slot API below)

/**
 * `globalThis.localStorage`, or undefined when it is absent (Node) or merely touching it throws
 * (sandboxed iframes / cookies disabled raise SecurityError on access).
 * @returns {StorageLike|undefined}
 */
function defaultStorage() {
  try {
    return /** @type {StorageLike|undefined} */ (globalThis.localStorage);
  } catch {
    return undefined;
  }
}

/** @returns {boolean} `s` is an object exposing `method` as a function */
function hasMethod(s, method) {
  return s != null && (typeof s === 'object' || typeof s === 'function') && typeof s[method] === 'function';
}

/**
 * Serialise and write the save. Never throws.
 * @param {SaveData} data
 * @param {StorageLike} [storage]
 * @returns {boolean} false when storage is missing, the data cannot be serialised, or setItem throws
 *   (e.g. QuotaExceededError). On false the previously stored save, if any, is untouched.
 */
export function saveGame(data, storage = defaultStorage()) {
  if (!hasMethod(storage, 'setItem')) return false;
  let text;
  try {
    text = serializeSave(data);
  } catch {
    return false;
  }
  try {
    storage.setItem(SAVE_KEY, text);
  } catch {
    return false;
  }
  return true;
}

/**
 * Read and validate the save. Never throws.
 * @param {StorageLike} [storage]
 * @returns {SaveData|null} null when storage is missing, empty, unreadable, or holds an invalid document
 */
export function loadGame(storage = defaultStorage()) {
  if (!hasMethod(storage, 'getItem')) return null;
  let text;
  try {
    text = storage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  return typeof text === 'string' ? deserializeSave(text) : null;
}

/**
 * True iff a LOADABLE save exists (a corrupt blob under SAVE_KEY counts as no save, so the title
 * screen never offers a "Continue" that would silently start a fresh world).
 * @param {StorageLike} [storage]
 * @returns {boolean}
 */
export function hasSave(storage = defaultStorage()) {
  return loadGame(storage) !== null;
}

/**
 * Remove the save. Never throws; a no-op when storage is missing.
 * @param {StorageLike} [storage]
 * @returns {void}
 */
export function clearSave(storage = defaultStorage()) {
  if (!hasMethod(storage, 'removeItem')) return;
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    // nothing sensible to do; the caller's next hasSave() reports the truth
  }
}

// ---------------------------------------------------------------------------------------------
// save slots (CONTRACTS §41)
//
// Slot n (1..SAVE_SLOTS) keeps its world under slotKey(n) as one serializeSave document whose `meta` carries the name and
// times, so the document alone is the truth. SLOT_INDEX_KEY only caches what the Worlds screen lists, and every cached entry
// is checked against its slot's text (length and FNV-1a hash) before it is used: a missing, corrupt or stale index is rebuilt
// from the documents. Every write keeps the slot's previous text when it fails (Web Storage leaves a key untouched when
// setItem throws; a backend that does not is put back), and nothing here ever throws.

export const LEGACY_SAVE_KEY = SAVE_KEY;                 // the one save of the versions before save slots
export const SLOT_KEY_PREFIX = 'caelancraft:v2:slot:';  // + slot number 1..SAVE_SLOTS
export const SLOT_INDEX_KEY = 'caelancraft:v2:slots';
export const SLOT_INDEX_VERSION = 1;
/** Name of the world moved over from LEGACY_SAVE_KEY (when its document carries none). */
export const MIGRATED_WORLD_NAME = 'My World';
/** Appended to a duplicated world's name (the base is shortened so the whole name fits MAX_WORLD_NAME_CHARS). */
export const COPY_SUFFIX = ' (copy)';

/**
 * One row of the Worlds screen.
 * @typedef {Object} SlotInfo
 * @property {number} slot            1..SAVE_SLOTS
 * @property {'empty'|'world'|'damaged'} status   damaged = text is stored but deserializeSave rejects it
 * @property {string} name            '' unless status is 'world'
 * @property {number|null} seed       null unless status is 'world'
 * @property {number} createdAt       ms since the epoch, 0 = unknown
 * @property {number} lastPlayed      ms since the epoch, 0 = unknown
 * @property {number} bytes           characters stored for the slot (0 when empty)
 * @property {boolean} legacy         slot 1 still read from LEGACY_SAVE_KEY (its move is pending, §41.3)
 * @property {'survival'} [mode]      present (v0.9) only for a world in Survival mode
 */

/**
 * `mode: 'survival'` marks a Survival world (isSurvivalSave) so the Worlds panel can say "· Survival".
 * @typedef {{ name: string, seed: number, createdAt: number, lastPlayed: number, bytes: number, hash: number,
 *   mode?: 'survival' } | { damaged: true, bytes: number, hash: number }} SlotIndexEntry
 */

/**
 * Outcome of a slot write. `reason`: 'quota' (storage full), 'error' (the backend threw something else or did not keep
 * the text), 'unavailable' (no storage), 'invalid' (bad slot or data), 'empty' / 'damaged' (nothing usable to work on),
 * 'full' (no empty slot to copy into).
 * @typedef {{ ok: boolean, reason?: string, bytes?: number, slot?: number, name?: string }} SlotResult
 */

/** @param {number} slot @returns {string} */
export function slotKey(slot) {
  return SLOT_KEY_PREFIX + slot;
}

/** @param {unknown} n @returns {boolean} an integer 1..SAVE_SLOTS */
export function isSlot(n) {
  return Number.isInteger(n) && /** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= SAVE_SLOTS;
}

/**
 * "<name> (copy)", the name shortened first so the result keeps within MAX_WORLD_NAME_CHARS.
 * @param {string} name
 */
export function copyWorldName(name) {
  const base = Array.from(cleanWorldName(name)).slice(0, MAX_WORLD_NAME_CHARS - COPY_SUFFIX.length).join('').trim();
  return (base + COPY_SUFFIX).trim();
}

/**
 * 32-bit FNV-1a over the UTF-16 code units of `text` (the index's consistency check; not cryptographic).
 * @param {string} text
 * @returns {number} uint32
 */
export function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {unknown} err @returns {boolean} the error a full Web Storage throws (Chrome / Safari / old Firefox spellings) */
export function isQuotaError(err) {
  if (err === null || typeof err !== 'object') return false;
  const e = /** @type {{ name?: unknown, code?: unknown }} */ (err);
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
}

/** @returns {string|null} the stored text, null when absent, empty, unreadable or storage is missing */
function readText(storage, key) {
  if (!hasMethod(storage, 'getItem')) return null;
  try {
    const t = storage.getItem(key);
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** @returns {'ok'|'quota'|'error'|'unavailable'} */
function writeText(storage, key, text) {
  if (!hasMethod(storage, 'setItem')) return 'unavailable';
  try {
    storage.setItem(key, text);
    return 'ok';
  } catch (err) {
    return isQuotaError(err) ? 'quota' : 'error';
  }
}

/** @returns {boolean} the key is gone afterwards */
function removeKey(storage, key) {
  if (!hasMethod(storage, 'removeItem')) return false;
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  return readText(storage, key) === null;
}

/**
 * Where slot `slot` lives right now, and its text: its own key, except that slot 1 is read from (and written to)
 * LEGACY_SAVE_KEY while the old single save has not been moved into it yet (§41.3).
 * @returns {{ key: string, text: string|null }}
 */
function readSlot(storage, slot) {
  const own = readText(storage, slotKey(slot));
  if (own !== null || slot !== 1) return { key: slotKey(slot), text: own };
  const legacy = readText(storage, LEGACY_SAVE_KEY);
  return legacy !== null ? { key: LEGACY_SAVE_KEY, text: legacy } : { key: slotKey(1), text: null };
}

/** The name a world without one is listed under: MIGRATED_WORLD_NAME while it is the legacy save, else "World N". */
function fallbackName(slot, key) {
  return key === LEGACY_SAVE_KEY ? MIGRATED_WORLD_NAME : defaultWorldName(slot);
}

/**
 * Write `text` under `key`, keeping `prev` (the text stored there before, null = nothing) whenever the write does not
 * stick: a throwing setItem must leave the key alone, and a backend that clobbers it anyway, or keeps something else, is
 * put back to `prev`.
 * @returns {'ok'|'quota'|'error'|'unavailable'}
 */
function writeKeepingPrevious(storage, key, text, prev) {
  if (!hasMethod(storage, 'getItem') || !hasMethod(storage, 'setItem')) return 'unavailable';
  const res = writeText(storage, key, text);
  if (res === 'ok' && readText(storage, key) === text) return 'ok';
  if (readText(storage, key) !== prev) {
    if (prev === null) removeKey(storage, key);
    else writeText(storage, key, prev);
  }
  return res === 'ok' ? 'error' : res;
}

/** @returns {SlotIndexEntry|null} a validated copy of a stored index entry, null when it is not one */
function validIndexEntry(e) {
  if (!isPlainObject(e)) return null;
  const { bytes, hash } = e;
  if (!Number.isInteger(bytes) || bytes <= 0 || !Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) return null;
  if (e.damaged === true) return { damaged: true, bytes, hash };
  if (typeof e.name !== 'string' || e.name === '' || cleanWorldName(e.name) !== e.name || !isFiniteNumber(e.seed)) return null;
  const createdAt = cleanTimestamp(e.createdAt);
  const lastPlayed = cleanTimestamp(e.lastPlayed);
  if (createdAt === null || lastPlayed === null) return null;
  if (e.mode !== undefined && e.mode !== 'survival') return null;
  /** @type {SlotIndexEntry} */
  const entry = { name: e.name, seed: e.seed, createdAt, lastPlayed, bytes, hash };
  if (e.mode === 'survival') entry.mode = 'survival';
  return entry;
}

/**
 * The stored index, entry by entry; anything unusable (missing key, bad JSON, wrong version or length, a bad entry)
 * reads as null, i.e. "rebuild from the slot".
 * @returns {{ raw: string|null, entries: (SlotIndexEntry|null)[] }}
 */
function readIndex(storage) {
  const raw = readText(storage, SLOT_INDEX_KEY);
  /** @type {(SlotIndexEntry|null)[]} */
  const entries = new Array(SAVE_SLOTS).fill(null);
  if (raw === null) return { raw, entries };
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { raw, entries };
  }
  if (!isPlainObject(doc) || doc.version !== SLOT_INDEX_VERSION || !Array.isArray(doc.slots) || doc.slots.length !== SAVE_SLOTS) {
    return { raw, entries };
  }
  for (let i = 0; i < SAVE_SLOTS; i++) entries[i] = validIndexEntry(doc.slots[i]);
  return { raw, entries };
}

/** @param {(SlotIndexEntry|null)[]} entries @returns {string} */
function indexText(entries) {
  return JSON.stringify({ version: SLOT_INDEX_VERSION, slots: entries });
}

/** Best effort: a failed index write only means the next listing rebuilds the entry. */
function writeIndexEntry(storage, slot, entry) {
  const { entries } = readIndex(storage);
  entries[slot - 1] = entry;
  writeText(storage, SLOT_INDEX_KEY, indexText(entries));
}

/**
 * A document is written as version 3 (SURVIVAL_SAVE_VERSION) exactly when it has `gen` ≥ 2 or a survival state.
 * @param {*} data  SaveData, or what deserializeSave returned
 */
export function isVersionThree(data) {
  return isPlainObject(data) && ((Number.isInteger(data.gen) && data.gen >= 2) || data.survival !== undefined);
}

/**
 * The index entry WRITTEN for a slot: a version-3 document gets `{ damaged: true, bytes, hash }`, never the rich entry.
 * §42 / DESIGN-survival §1.4 promise that an older client (v0.8 in another tab, or a rollback) shows such a slot as
 * damaged and never overwrites it; v0.8 trusts any rich entry whose bytes and hash match, so a rich entry would list the
 * Survival world as a normal world there and its `?autoplay` boot would save a fresh gen-1 world over it (play-test).
 * v0.9's listSlots never trusts a damaged entry (it parses the slot again, §41.1), so this client still lists the world.
 * @param {SlotIndexEntry} entry  the rich entry of the slot's document
 * @param {boolean} versionThree
 * @returns {SlotIndexEntry}
 */
function indexEntryOf(entry, versionThree) {
  return versionThree ? { damaged: true, bytes: entry.bytes, hash: entry.hash } : entry;
}

/**
 * @returns {{ info: SlotIndexEntry, index: SlotIndexEntry }} what a slot holding `text` is (parses it) — `info` for the
 *   Worlds screen, `index` the entry to write (indexEntryOf)
 */
function entryFromText(text, fallback) {
  const bytes = text.length;
  const hash = textHash(text);
  const save = deserializeSave(text);
  if (!save) {
    /** @type {SlotIndexEntry} */
    const damaged = { damaged: true, bytes, hash };
    return { info: damaged, index: damaged };
  }
  const meta = /** @type {*} */ (save).meta || {};
  /** @type {SlotIndexEntry} */
  const entry = { name: meta.name || fallback, seed: save.seed, createdAt: meta.createdAt ?? 0, lastPlayed: meta.lastPlayed ?? 0, bytes, hash };
  if (isSurvivalSave(save)) entry.mode = 'survival';
  return { info: entry, index: indexEntryOf(entry, isVersionThree(save)) };
}

/** @returns {SlotIndexEntry} the entry to WRITE for `text` = serializeSave(data), just written (no parse; indexEntryOf) */
function entryFromData(data, text, fallback) {
  const meta = normalizeWorldMeta(data.meta) || {};
  /** @type {SlotIndexEntry} */
  const entry = {
    name: meta.name || fallback, seed: data.seed, createdAt: meta.createdAt ?? 0, lastPlayed: meta.lastPlayed ?? 0,
    bytes: text.length, hash: textHash(text),
  };
  if (isSurvivalSave(data)) entry.mode = 'survival';
  return indexEntryOf(entry, isVersionThree(data));
}

/** @returns {SlotInfo} */
function slotInfo(slot, entry, legacy) {
  /** @type {SlotInfo} */
  const info = { slot, status: 'empty', name: '', seed: null, createdAt: 0, lastPlayed: 0, bytes: 0, legacy: false };
  if (!entry) return info;
  if ('damaged' in entry) return { ...info, status: 'damaged', bytes: entry.bytes, legacy };
  const { name, seed, createdAt, lastPlayed, bytes } = entry;
  /** @type {SlotInfo} */
  const out = { ...info, status: 'world', name, seed, createdAt, lastPlayed, bytes, legacy };
  if (entry.mode === 'survival') out.mode = 'survival';
  return out;
}

/**
 * Every slot, in order, for the Worlds screen. Never throws. A cached index entry is used only when it matches its slot's
 * text (length and hash) and is not 'damaged' (a damaged slot is always parsed again: a version-3 world is indexed as
 * damaged for older clients' sake, indexEntryOf); otherwise the slot's document is parsed (unparsable → 'damaged') and,
 * with `repair`, the rebuilt index is written back (best effort; pass `repair: false` when nothing may be written, e.g.
 * under ?nosave). A Survival world's SlotInfo carries `mode: 'survival'`.
 * @param {StorageLike} [storage]
 * @param {{ repair?: boolean }} [opts]
 * @returns {SlotInfo[]}
 */
export function listSlots(storage = defaultStorage(), opts = {}) {
  const repair = !opts || opts.repair !== false;
  const { raw, entries: cached } = readIndex(storage);
  /** @type {(SlotIndexEntry|null)[]} */
  const entries = [];
  /** @type {SlotInfo[]} */
  const out = [];
  for (let n = 1; n <= SAVE_SLOTS; n++) {
    const { key, text } = readSlot(storage, n);
    let entry = null;
    let index = null;
    if (text !== null) {
      const c = cached[n - 1];
      // A cached 'damaged' entry is never trusted (§41.1 v0.9): a version-3 world is INDEXED as damaged on purpose (so an
      // older client sharing the index never overwrites it), and a v0.8 tab writes the same for it; the slot is parsed
      // again and listed as the world it is. Truly damaged slots are rare, so the parse is cheap.
      const usable = c && c.bytes === text.length && c.hash === textHash(text) && !('damaged' in c);
      if (usable) {
        entry = c;
        index = c;
      } else {
        const e = entryFromText(text, fallbackName(n, key));
        entry = e.info;
        index = e.index;
      }
    }
    entries.push(index);
    out.push(slotInfo(n, entry, key === LEGACY_SAVE_KEY));
  }
  if (repair) {
    const next = indexText(entries);
    if (next !== raw && (raw !== null || entries.some((e) => e !== null))) writeText(storage, SLOT_INDEX_KEY, next);
  }
  return out;
}

/**
 * Read and validate one slot's world. Never throws. The result always carries `meta` with a name (the document's, else
 * MIGRATED_WORLD_NAME for a legacy save not moved yet, else "World N") and both times (0 = unknown).
 * @param {number} slot
 * @param {StorageLike} [storage]
 * @returns {SaveData|null} null for a bad slot number, an empty slot or a damaged one
 */
export function loadSlot(slot, storage = defaultStorage()) {
  if (!isSlot(slot)) return null;
  const { key, text } = readSlot(storage, slot);
  if (text === null) return null;
  const save = deserializeSave(text);
  if (!save) return null;
  const meta = /** @type {*} */ (save).meta || {};
  /** @type {*} */ (save).meta = { name: meta.name || fallbackName(slot, key), createdAt: meta.createdAt ?? 0, lastPlayed: meta.lastPlayed ?? 0 };
  return save;
}

/**
 * Serialise `data` and write it to `slot` (to LEGACY_SAVE_KEY while slot 1 is still read from there), then refresh the
 * slot's index entry. Never throws. On failure the slot's previous save is left exactly as it was.
 * @param {number} slot
 * @param {SaveData} data
 * @param {StorageLike} [storage]
 * @returns {SlotResult} `{ ok: true, bytes }` or `{ ok: false, reason: 'invalid'|'unavailable'|'quota'|'error' }`
 */
export function saveSlot(slot, data, storage = defaultStorage()) {
  if (!isSlot(slot)) return { ok: false, reason: 'invalid' };
  if (!hasMethod(storage, 'getItem') || !hasMethod(storage, 'setItem')) return { ok: false, reason: 'unavailable' };
  let text;
  try {
    text = serializeSave(data);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const { key, text: prev } = readSlot(storage, slot);
  const res = writeKeepingPrevious(storage, key, text, prev);
  if (res !== 'ok') return { ok: false, reason: res };
  writeIndexEntry(storage, slot, entryFromData(data, text, fallbackName(slot, key)));
  return { ok: true, bytes: text.length };
}

/**
 * Empty a slot (its world is gone for good). Never throws.
 * @param {number} slot
 * @param {StorageLike} [storage]
 * @returns {boolean} true when the slot is empty afterwards (also when it already was)
 */
export function deleteSlot(slot, storage = defaultStorage()) {
  if (!isSlot(slot)) return false;
  const { key, text } = readSlot(storage, slot);
  if (text !== null && !removeKey(storage, key)) return false;
  writeIndexEntry(storage, slot, null);
  return true;
}

/**
 * Give a slot's world a new name (normalizeWorldName: trimmed, at most MAX_WORLD_NAME_CHARS, never empty). Rewrites the
 * document with the same content; on failure the old document stays. Never throws.
 * @param {number} slot
 * @param {string} name
 * @param {StorageLike} [storage]
 * @returns {SlotResult} `{ ok: true, name, bytes }` or `{ ok: false, reason }`
 */
export function renameSlot(slot, name, storage = defaultStorage()) {
  if (!isSlot(slot)) return { ok: false, reason: 'invalid' };
  const { key, text } = readSlot(storage, slot);
  if (text === null) return { ok: false, reason: 'empty' };
  const save = deserializeSave(text);
  if (!save) return { ok: false, reason: 'damaged' };
  const newName = normalizeWorldName(name, slot);
  const data = { ...save, meta: { .../** @type {*} */ (save).meta, name: newName } };
  const out = serializeSave(data);
  const res = writeKeepingPrevious(storage, key, out, text);
  if (res !== 'ok') return { ok: false, reason: res };
  writeIndexEntry(storage, slot, entryFromData(data, out, newName));
  return { ok: true, name: newName, bytes: out.length };
}

/**
 * The first empty slot, or 0 when all SAVE_SLOTS hold something (a damaged slot is not empty).
 * @param {StorageLike} [storage]
 * @returns {number}
 */
export function firstEmptySlot(storage = defaultStorage()) {
  for (let n = 1; n <= SAVE_SLOTS; n++) if (readSlot(storage, n).text === null) return n;
  return 0;
}

/**
 * Copy a slot's world into the first empty slot as "<name> (copy)" (copyWorldName), created `now` and last played when the
 * original was. Nothing is written when there is no empty slot or the copy does not fit. Never throws.
 * @param {number} slot
 * @param {StorageLike} [storage]
 * @param {number} [now]  ms since the epoch
 * @returns {SlotResult} `{ ok: true, slot, name, bytes }` or `{ ok: false, reason: 'invalid'|'empty'|'damaged'|'full'|'quota'|'error'|'unavailable' }`
 */
export function duplicateSlot(slot, storage = defaultStorage(), now = Date.now()) {
  if (!isSlot(slot)) return { ok: false, reason: 'invalid' };
  const { key, text } = readSlot(storage, slot);
  if (text === null) return { ok: false, reason: 'empty' };
  const save = deserializeSave(text);
  if (!save) return { ok: false, reason: 'damaged' };
  const target = firstEmptySlot(storage);
  if (!target) return { ok: false, reason: 'full' };
  const meta = /** @type {*} */ (save).meta || {};
  const name = copyWorldName(meta.name || fallbackName(slot, key));
  const data = { ...save, meta: { name, createdAt: now, lastPlayed: meta.lastPlayed ?? now } };
  const out = serializeSave(data);
  const res = writeKeepingPrevious(storage, slotKey(target), out, null);
  if (res !== 'ok') return { ok: false, reason: res };
  writeIndexEntry(storage, target, entryFromData(data, out, name));
  return { ok: true, slot: target, name, bytes: out.length };
}

/** The same world in both texts, `meta` aside (the legacy save and its moved copy). */
function sameWorld(text, legacy, legacySave) {
  if (text === legacy) return true;
  if (!legacySave) return false;
  const save = deserializeSave(text);
  if (!save) return false;
  return serializeSave({ ...save, meta: undefined }) === serializeSave({ ...legacySave, meta: undefined });
}

/**
 * Move the single save of the versions before save slots (LEGACY_SAVE_KEY) into a slot: slot 1 when it is empty, else the
 * first empty one. A loadable save gets `meta` (its own, else name MIGRATED_WORLD_NAME and both times `now`); a damaged one
 * is copied verbatim (it then lists as 'damaged' and can only be deleted). The legacy key is removed ONLY after the copy
 * was written and read back identical. Never throws, never loses the save. Status:
 *   'none'        nothing to move
 *   'migrated'    `slot`: moved (also when an earlier run had copied it but could not remove the legacy key);
 *                 `legacyKept: true` when the copy is in place but the legacy key could not be removed (finished next time)
 *   'deferred'    `slot`, `reason`: the copy could not be written (e.g. 'quota': the save is too big to exist twice); the
 *                 legacy key is untouched and, when the target was slot 1, slot 1 keeps reading and writing it (§41.3)
 *   'failed'      `slot`, `reason: 'verify'`: the copy did not read back identical; it is removed and the legacy key kept
 *   'no-room'     every slot is taken; the legacy key is left alone
 *   'unavailable' no usable storage
 * @param {StorageLike} [storage]
 * @param {number} [now]  ms since the epoch
 * @returns {{ status: 'none'|'migrated'|'deferred'|'failed'|'no-room'|'unavailable', slot?: number, reason?: string,
 *   legacyKept?: boolean }}
 */
export function migrateLegacySave(storage = defaultStorage(), now = Date.now()) {
  if (!hasMethod(storage, 'getItem') || !hasMethod(storage, 'setItem') || !hasMethod(storage, 'removeItem')) {
    return { status: 'unavailable' };
  }
  const legacy = readText(storage, LEGACY_SAVE_KEY);
  if (legacy === null) return { status: 'none' };
  const legacySave = deserializeSave(legacy);
  let target = 0;
  for (let n = 1; n <= SAVE_SLOTS; n++) {
    const own = readText(storage, slotKey(n));
    if (own === null) {
      if (!target) target = n;
    } else if (sameWorld(own, legacy, legacySave)) {
      // An earlier run copied it here but could not remove the legacy key: finish the move.
      return removeKey(storage, LEGACY_SAVE_KEY) ? { status: 'migrated', slot: n } : { status: 'migrated', slot: n, legacyKept: true };
    }
  }
  if (!target) return { status: 'no-room' };
  const key = slotKey(target);
  let doc = legacy;
  /** @type {SlotIndexEntry} */
  let entry;
  if (legacySave) {
    const m = /** @type {*} */ (legacySave).meta || {};
    const data = { ...legacySave, meta: { name: m.name || MIGRATED_WORLD_NAME, createdAt: m.createdAt ?? now, lastPlayed: m.lastPlayed ?? now } };
    doc = serializeSave(data);
    entry = entryFromData(data, doc, MIGRATED_WORLD_NAME);
  } else {
    entry = { damaged: true, bytes: legacy.length, hash: textHash(legacy) };
  }
  const res = writeText(storage, key, doc);
  if (res !== 'ok') {
    if (readText(storage, key) !== null) removeKey(storage, key); // never leave half a copy behind
    return { status: 'deferred', slot: target, reason: res };
  }
  if (readText(storage, key) !== doc) {
    removeKey(storage, key);
    return { status: 'failed', slot: target, reason: 'verify' };
  }
  writeIndexEntry(storage, target, entry);
  return removeKey(storage, LEGACY_SAVE_KEY) ? { status: 'migrated', slot: target } : { status: 'migrated', slot: target, legacyKept: true };
}

/**
 * What the slots take of the browser's localStorage: the sum of their sizes against STORAGE_QUOTA_ESTIMATE.
 * @param {SlotInfo[]} slots
 * @returns {{ used: number, quota: number, fraction: number }}  fraction clamped to 0..1
 */
export function storageUsage(slots) {
  let used = 0;
  for (const s of Array.isArray(slots) ? slots : []) if (s && Number.isFinite(s.bytes) && s.bytes > 0) used += s.bytes;
  const quota = STORAGE_QUOTA_ESTIMATE;
  return { used, quota, fraction: Math.min(1, used / quota) };
}
