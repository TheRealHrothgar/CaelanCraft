// Caelancraft — save / load of player meta and world edits. See src/CONTRACTS.md §14.
// PURE: the storage backend is injected (default globalThis.localStorage); no DOM, no timers,
// no Math.random. Everything lives under one key (SAVE_KEY) as one JSON document.
//
// Note: docs/SPEC-gameplay.md §8 describes a multi-key layout (`caelancraft:v1:meta` +
// `caelancraft:v1:chunk:<cx>,<cz>`) and an (x-innermost) localIndex formula. CONTRACTS.md wins:
// single key, `(lx*16+lz)*128+ly` local indices as produced by world.exportEdits().
import { CHUNK_VOLUME, HOTBAR_SIZE, PITCH_LIMIT } from './config.js';
import { DEFAULT_HOTBAR } from './blocks.js';

/** @typedef {import('./types.js').SaveData} SaveData */
/** @typedef {import('./types.js').EditsJSON} EditsJSON */

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
 * and non-array entries are dropped; `time` is wrapped into [0,1) and `pitch` clamped.
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
  Object.defineProperty(save, 'warnings', { value: warnings, enumerable: false, writable: true, configurable: true });
  return save;
}

// ---------------------------------------------------------------------------------------------
// storage wrappers

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
