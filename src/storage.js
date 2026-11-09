// Caelancraft — save / load of player meta and world edits. See src/CONTRACTS.md §14 and §41 (save slots).
// PURE: the storage backend is injected (default globalThis.localStorage); no DOM, no timers,
// no Math.random. Each world is ONE JSON document (serializeSave) under its own key: save slot n lives under
// slotKey(n) (§41); SAVE_KEY is the single save of the versions before save slots, moved into a slot by migrateLegacySave.
// The only clock is the `now` argument of the functions that stamp times (default Date.now()).
//
// Note: docs/SPEC-gameplay.md §8 describes a multi-key layout (`caelancraft:v1:meta` +
// `caelancraft:v1:chunk:<cx>,<cz>`) and an (x-innermost) localIndex formula. CONTRACTS.md wins:
// one key per world, `(lx*16+lz)*128+ly` local indices as produced by world.exportEdits().
import { CHUNK_VOLUME, HOTBAR_SIZE, PITCH_LIMIT, SAVE_SLOTS, MAX_WORLD_NAME_CHARS, STORAGE_QUOTA_ESTIMATE } from './config.js';
import { DEFAULT_HOTBAR } from './blocks.js';
import { normalizeRunesJSON, validateRunesJSON } from './runes.js';
import { validatePigsJSON } from './pigs.js';

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
// serialise

/**
 * Canonical JSON text of a save: fixed key order, chunk keys sorted, invalid hotbar/selected
 * replaced by defaults, empty chunk arrays dropped. Edit pairs are copied verbatim (validation is
 * the loader's job) so autosave stays cheap.
 *
 * Throws a TypeError instead of producing a document that deserializeSave would reject
 * (non-finite seed/time/day or player numbers, missing player, edits that are not an EditsJSON
 * object). saveGame() turns that into `false` so a good save on disk is never overwritten.
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
 * Returns null on: unparsable/non-object JSON, `version !== SAVE_VERSION`, missing or non-finite
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
 * An optional `meta` object (the world's name and times, §41) is kept as normalizeWorldMeta gives it (unusable fields are
 * dropped with a warning, a non-object with `meta: not an object, ignored`).
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
  if (raw.version !== SAVE_VERSION) return null;
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
 */

/**
 * @typedef {{ name: string, seed: number, createdAt: number, lastPlayed: number, bytes: number, hash: number }
 *   | { damaged: true, bytes: number, hash: number }} SlotIndexEntry
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
  return { name: e.name, seed: e.seed, createdAt, lastPlayed, bytes, hash };
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

/** @returns {SlotIndexEntry} what the index says about a slot holding `text` (parses it) */
function entryFromText(text, fallback) {
  const bytes = text.length;
  const hash = textHash(text);
  const save = deserializeSave(text);
  if (!save) return { damaged: true, bytes, hash };
  const meta = /** @type {*} */ (save).meta || {};
  return { name: meta.name || fallback, seed: save.seed, createdAt: meta.createdAt ?? 0, lastPlayed: meta.lastPlayed ?? 0, bytes, hash };
}

/** @returns {SlotIndexEntry} the entry for `text` = serializeSave(data), just written (no parse) */
function entryFromData(data, text, fallback) {
  const meta = normalizeWorldMeta(data.meta) || {};
  return {
    name: meta.name || fallback, seed: data.seed, createdAt: meta.createdAt ?? 0, lastPlayed: meta.lastPlayed ?? 0,
    bytes: text.length, hash: textHash(text),
  };
}

/** @returns {SlotInfo} */
function slotInfo(slot, entry, legacy) {
  /** @type {SlotInfo} */
  const info = { slot, status: 'empty', name: '', seed: null, createdAt: 0, lastPlayed: 0, bytes: 0, legacy: false };
  if (!entry) return info;
  if ('damaged' in entry) return { ...info, status: 'damaged', bytes: entry.bytes, legacy };
  const { name, seed, createdAt, lastPlayed, bytes } = entry;
  return { ...info, status: 'world', name, seed, createdAt, lastPlayed, bytes, legacy };
}

/**
 * Every slot, in order, for the Worlds screen. Never throws. A cached index entry is used only when it matches its slot's
 * text (length and hash); otherwise the slot's document is parsed (unparsable → 'damaged') and, with `repair`, the
 * rebuilt index is written back (best effort; pass `repair: false` when nothing may be written, e.g. under ?nosave).
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
    if (text !== null) {
      const c = cached[n - 1];
      entry = c && c.bytes === text.length && c.hash === textHash(text) ? c : entryFromText(text, fallbackName(n, key));
    }
    entries.push(entry);
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
