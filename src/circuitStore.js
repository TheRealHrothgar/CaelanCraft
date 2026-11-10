// Caelancraft — the circuit side table: the settings and saved state of every configured circuit part (a switch's on/off,
// a timer's delay and mode, a relay's NO/NC and input face, a radio's wavelength, a battery's charge, labels), keyed
// "q,y,r" like the rune store. docs/DESIGN-circuits.md §4.8, §6.2.2, §6.4 (CONTRACTS §51 once merged). PURE: no DOM, no
// three, no time, no Math.random.
//
// A part with no entry behaves with its kind's defaults (`setblock` / `fill` need no special case), and a PRISTINE entry
// (every field at its default) is never saved and does not count toward MAX_CIRCUIT_PARTS. The saved kind `k` is always the
// part's PartDef.key and the fields an entry may hold are its PartDef.fields; JSON entries hold `k` and then their non-default
// fields in the canonical order k, l, on, nc, f, s, m, run, ch, c (`s` rounded to 0.5 s steps, `c` to whole amp-seconds).
import {
  MAX_CIRCUIT_PARTS, MAX_PART_LABEL_CHARS, TIMER_MIN_S, TIMER_MAX_S, TIMER_DEFAULT_S, RADIO_CHANNELS, BATTERY_CAPACITY,
} from './config.js';
import { chunkKey, inHeightRange, localIndex, worldToChunk, worldToLocal } from './coords.js';
import { DEFAULT_INPUT_FACE, partByKey } from './circuitParts.js';

/** @typedef {import('./types.js').PartState} PartState */
/** @typedef {import('./types.js').CircuitPartsJSON} CircuitPartsJSON */

/** Every store field, in canonical JSON order (after `k`). */
export const PART_FIELDS = Object.freeze(['l', 'on', 'nc', 'f', 's', 'm', 'run', 'ch', 'c']);

/** The modes each kind accepts for `m`. */
const MODES = Object.freeze({
  timer: Object.freeze(['pulse', 'hold', 'repeat']),
  rx: Object.freeze(['pulse', 'latch']),
});

/** Field defaults (§4.8). `m` is the first mode of the kind. */
const DEFAULTS = Object.freeze({
  l: '', on: false, nc: false, f: DEFAULT_INPUT_FACE, s: TIMER_DEFAULT_S, run: false, ch: 1, c: BATTERY_CAPACITY,
});

const PART_KEY_RE = /^(-?\d+),(-?\d+),(-?\d+)$/;

/** @returns {string} `${q},${y},${r}`, the store key of a cell */
export function partKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Strict inverse of partKey (like runes.parseRuneKey): y in 0..WORLD_HEIGHT−1, q and r safe integers; anything else → null.
 * Non-canonical spellings (`01,2,3`, `-0,1,2`) parse, and are rewritten canonically by normalizePartsJSON.
 * @param {string} key
 * @returns {[number, number, number]|null}
 */
export function parsePartKey(key) {
  const m = PART_KEY_RE.exec(String(key));
  if (!m) return null;
  const q = Number(m[1]);
  const y = Number(m[2]);
  const r = Number(m[3]);
  if (!inHeightRange(y) || !Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return null;
  return [q + 0, y, r + 0];
}

/** @returns {readonly string[]|null} the store fields of kind `k` (PartDef.fields), null for an unknown kind */
function fieldsOf(k) {
  const def = partByKey(k);
  return def ? def.fields : null;
}

/** @returns {*} the default of `field` for kind `k` */
function fieldDefault(k, field) {
  if (field === 'm') return MODES[k] ? MODES[k][0] : '';
  return DEFAULTS[field];
}

/**
 * Fresh defaults for a kind: `{ k, …its fields at their defaults }` in canonical order, or null for an unknown kind (or a
 * key with no store fields at all, such as a wire: those parts never have an entry).
 * @param {string} k
 * @returns {Record<string, *>|null}
 */
export function defaultPart(k) {
  const fields = fieldsOf(k);
  if (!fields || fields.length === 0) return null;
  /** @type {Record<string, *>} */
  const out = { k };
  for (const f of PART_FIELDS) if (fields.includes(f)) out[f] = fieldDefault(k, f);
  return out;
}

/** @returns {number} v rounded to the nearest 0.5 */
function halfStep(v) {
  return Math.round(v * 2) / 2;
}

/**
 * Validate one field value for kind `k`. Out-of-range numbers are clamped (and rounded to their grid) silently; a value of
 * the wrong type, a non-finite number or an unknown mode is invalid (→ `{ ok: false }`, the caller uses the default).
 * @returns {{ ok: boolean, value?: * }}
 */
function checkField(k, field, v) {
  switch (field) {
    case 'l':
      if (typeof v !== 'string') return { ok: false };
      return { ok: true, value: v.trim().slice(0, MAX_PART_LABEL_CHARS).trim() };
    case 'on':
    case 'nc':
    case 'run':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false };
    case 'f':
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
      return { ok: true, value: Math.min(6, Math.max(0, Math.round(v))) };
    case 's':
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
      return { ok: true, value: Math.min(TIMER_MAX_S, Math.max(TIMER_MIN_S, halfStep(v))) };
    case 'm':
      return typeof v === 'string' && MODES[k] && MODES[k].includes(v) ? { ok: true, value: v } : { ok: false };
    case 'ch':
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
      return { ok: true, value: Math.min(RADIO_CHANNELS, Math.max(1, Math.round(v))) };
    case 'c':
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false };
      return { ok: true, value: Math.min(BATTERY_CAPACITY, Math.max(0, Math.round(v))) };
    default:
      return { ok: false };
  }
}

/**
 * Every field of kind `k` from a raw record, each validated and clamped: labels trimmed to MAX_PART_LABEL_CHARS, `s` to
 * TIMER_MIN_S..TIMER_MAX_S in 0.5 s steps, `ch` 1..RADIO_CHANNELS, `c` 0..BATTERY_CAPACITY (whole amp-seconds), `f` 0..6, `m`
 * one of the kind's modes (timer pulse/hold/repeat, receiver pulse/latch), `on`/`nc`/`run` booleans. Fields the kind does
 * not have are dropped (`nc` exists only on buttons and relays); a missing field takes its default; an invalid one takes its
 * default and is reported through `onInvalid(field)`.
 * @param {string} k
 * @param {*} raw
 * @param {(field: string) => void} [onInvalid]
 * @returns {Record<string, *>|null} `{ k, …fields }` in canonical order; null for an unknown kind or one with no fields
 */
export function normalizePart(k, raw, onInvalid) {
  const fields = fieldsOf(k);
  if (!fields || fields.length === 0) return null;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /** @type {Record<string, *>} */
  const out = { k };
  for (const f of PART_FIELDS) {
    if (!fields.includes(f)) continue;
    const v = src[f];
    if (v === undefined) {
      out[f] = fieldDefault(k, f);
      continue;
    }
    const res = checkField(k, f, v);
    if (res.ok) out[f] = res.value;
    else {
      out[f] = fieldDefault(k, f);
      if (onInvalid) onInvalid(f);
    }
  }
  return out;
}

/** @returns {boolean} every field of the (normalised) state is at its kind's default */
function isPristine(state) {
  const fields = fieldsOf(state.k);
  if (!fields) return true;
  for (const f of fields) if (!sameValue(f, state[f], fieldDefault(state.k, f))) return false;
  return true;
}

/** Field equality as saved: `c` compares in whole amp-seconds, `s` in 0.5 s steps. */
function sameValue(field, a, b) {
  if (field === 'c') return Math.round(a) === Math.round(b);
  if (field === 's') return halfStep(a) === halfStep(b);
  return a === b;
}

/**
 * The JSON entry of a part: `k` and its non-default fields in canonical order (`s` rounded to 0.5 steps, `c` to an integer);
 * null when the part is pristine (nothing to save) or of no known kind.
 * @param {Record<string, *>} state  a PartState (or any record with `k` and the kind's fields)
 * @returns {{ k: string }|null}
 */
export function partToJSON(state) {
  if (!state || typeof state !== 'object') return null;
  const fields = fieldsOf(state.k);
  if (!fields || fields.length === 0) return null;
  /** @type {Record<string, *>} */
  const out = { k: state.k };
  let any = false;
  for (const f of PART_FIELDS) {
    if (!fields.includes(f)) continue;
    const v = state[f];
    if (v === undefined || sameValue(f, v, fieldDefault(state.k, f))) continue;
    out[f] = f === 'c' ? Math.round(v) : f === 's' ? halfStep(v) : v;
    any = true;
  }
  return any ? /** @type {{ k: string }} */ (out) : null;
}

/** Numeric total order over part keys: q, then y, then r. */
function compareKeys(a, b) {
  const ka = parsePartKey(a);
  const kb = parsePartKey(b);
  if (!ka || !kb) return a < b ? -1 : a > b ? 1 : 0;
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/** `circuitParts[q,y,r]` as the warnings print it (the canonical key). */
function at(key) {
  return `circuitParts[${key}]`;
}

/**
 * Canonicalise a raw CircuitPartsJSON (§6.4): keys parsed strictly and rewritten canonically (last write wins), each entry
 * normalised through normalizePart and reduced to its non-default fields, pristine entries dropped, at most MAX_CIRCUIT_PARTS
 * kept in key order. Never throws. Warnings (each repair once): `circuitParts: not an object, ignored`,
 * `circuitParts["…"]: not a cell key, dropped`, `circuitParts[q,y,r]: not an object, dropped`,
 * `circuitParts[q,y,r]: unknown kind "x", dropped`, `circuitParts[q,y,r].s: invalid, reset`,
 * `circuitParts: more than 4096 entries, the rest dropped`.
 * @param {unknown} json
 * @param {number} [max]  the cap (default MAX_CIRCUIT_PARTS)
 * @returns {{ parts: CircuitPartsJSON, warnings: string[] }}
 */
export function normalizePartsJSON(json, max = MAX_CIRCUIT_PARTS) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {CircuitPartsJSON} */
  const parts = {};
  if (json === undefined || json === null) return { parts, warnings };
  if (typeof json !== 'object' || Array.isArray(json) || json instanceof Map) {
    warnings.push('circuitParts: not an object, ignored');
    return { parts, warnings };
  }
  /** @type {Map<string, { k: string }>} */
  const byKey = new Map();
  for (const rawKey of Object.keys(json)) {
    const cell = parsePartKey(rawKey);
    if (!cell) {
      warnings.push(`circuitParts[${JSON.stringify(rawKey)}]: not a cell key, dropped`);
      continue;
    }
    const key = partKey(cell[0], cell[1], cell[2]);
    const v = json[rawKey];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`${at(key)}: not an object, dropped`);
      continue;
    }
    const def = partByKey(v.k);
    if (!def || def.fields.length === 0) {
      warnings.push(`${at(key)}: unknown kind ${JSON.stringify(String(v.k))}, dropped`);
      continue;
    }
    const state = normalizePart(v.k, v, (f) => warnings.push(`${at(key)}.${f}: invalid, reset`));
    const entry = state ? partToJSON(state) : null;
    if (entry) byKey.set(key, entry);
    else byKey.delete(key);
  }
  const keys = [...byKey.keys()].sort(compareKeys);
  if (keys.length > max) warnings.push(`circuitParts: more than ${max} entries, the rest dropped`);
  const n = Math.min(keys.length, max);
  for (let i = 0; i < n; i++) parts[keys[i]] = /** @type {*} */ (byKey.get(keys[i]));
  return { parts, warnings };
}

/**
 * normalizePartsJSON plus the load-time orphan check (§6.4): worldgen never emits a circuit part, so every entry's cell must
 * hold that kind's block (`partByKey(k).id`) in the repaired `edits` of the same save; others are dropped with
 * `circuitParts[q,y,r]: no <kind> there, dropped`. Each chunk's lookup is built ONCE (Map<chunkKey, Map<localIndex, id>>),
 * so every entry is checked in O(1) — never a scan of its chunk's edit list. `perChunk` (deserializeSave's own map of the
 * repaired edits) is used as it is when given, and `edits` is then never read.
 * @param {unknown} json
 * @param {Record<string, number[]>|null|undefined} edits   repaired EditsJSON (chunk key → [localIndex, id, …])
 * @param {Map<string, Map<number, number>>} [perChunk]
 * @returns {{ parts: CircuitPartsJSON, warnings: string[] }}
 */
export function validatePartsJSON(json, edits, perChunk) {
  const { parts, warnings } = normalizePartsJSON(json);
  /** @type {Map<string, Map<number, number>>} */
  const lookup = perChunk instanceof Map ? perChunk : new Map();
  const own = !(perChunk instanceof Map);
  /** @type {CircuitPartsJSON} */
  const out = {};
  for (const key of Object.keys(parts)) {
    const cell = /** @type {[number, number, number]} */ (parsePartKey(key));
    const [q, y, r] = cell;
    const ck = chunkKey(worldToChunk(q), worldToChunk(r));
    let cells = lookup.get(ck);
    if (cells === undefined && own) {
      cells = new Map();
      const arr = edits && typeof edits === 'object' && Object.hasOwn(edits, ck) ? edits[ck] : null;
      if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) cells.set(arr[i], arr[i + 1]);
      lookup.set(ck, cells);
    }
    const id = cells ? cells.get(localIndex(worldToLocal(q), y, worldToLocal(r))) : undefined;
    const entry = parts[key];
    const def = partByKey(entry.k);
    if (def && id === def.id) out[key] = entry;
    else warnings.push(`${at(key)}: no ${entry.k} there, dropped`);
  }
  return { parts: out, warnings };
}

// ---------------------------------------------------------------------------------------------------------------------
// CircuitStore

/** @returns {PartState} a full PartState for a cell from a normalised field record */
function makeState(q, y, r, fields) {
  return /** @type {PartState} */ ({ key: partKey(q, y, r), q, y, r, ...fields });
}

/**
 * The world-level side table (§4.8), modelled on RuneStore: it survives chunk unloads, entries are created on demand, only
 * non-default fields are saved, and pristine entries are free (they neither save nor count toward the cap).
 */
export class CircuitStore {
  /** @param {number} [max=MAX_CIRCUIT_PARTS] */
  constructor(max = MAX_CIRCUIT_PARTS) {
    /** @type {Map<string, PartState>} */
    this.map = new Map();
    /** @type {Set<string>} keys of the non-pristine entries (the ones export() writes and the cap counts) */
    this._stored = new Set();
    /** bumped on every saved change; reset to 0 by replaceAll (autosave compares it like World.editVersion) */
    this.version = 0;
    this.max = max;
  }

  /** @returns {number} non-pristine entries (the ones saved; only these count toward the cap) */
  get size() {
    return this._stored.size;
  }

  /** @returns {PartState|undefined} */
  get(key) {
    return this.map.get(key);
  }

  /** @returns {boolean} */
  has(key) {
    return this.map.has(key);
  }

  /**
   * The entry at (q, y, r), created pristine when absent (or when it holds another kind: the cell's part changed). Pristine
   * entries are free, so this always succeeds. Null for a kind with no store fields (wires, fuses, the torch, the keg).
   * @param {number} q @param {number} y @param {number} r
   * @param {string} k  the part's PartDef.key
   * @returns {PartState|null}
   */
  ensure(q, y, r, k) {
    const key = partKey(q, y, r);
    const existing = this.map.get(key);
    if (existing && existing.k === k) return existing;
    const fields = defaultPart(k);
    if (!fields) return null;
    if (existing) this.delete(key);
    const state = makeState(q, y, r, fields);
    this.map.set(key, state);
    return state;
  }

  /**
   * Merge the DEFINED fields of `partial` into the entry at (q, y, r) of kind `k` (a fresh one when absent or of another
   * kind), normalising every field (normalizePart). The entry object is updated in place, so references stay valid.
   * @param {number} q @param {number} y @param {number} r
   * @param {string} k
   * @param {Record<string, *>|null|undefined} partial
   * @returns {PartState|null} null when the kind has no fields, or when the result would be a new saved (non-pristine)
   *   entry past the cap (the part then works with its defaults)
   */
  set(q, y, r, k, partial) {
    const key = partKey(q, y, r);
    const existing = this.map.get(key);
    const base = existing && existing.k === k ? existing : null;
    /** @type {Record<string, *>} */
    const merged = {};
    if (base) for (const f of PART_FIELDS) if (base[f] !== undefined) merged[f] = base[f];
    if (partial && typeof partial === 'object') {
      for (const f of Object.keys(partial)) if (partial[f] !== undefined) merged[f] = partial[f];
    }
    const fields = normalizePart(k, merged);
    if (!fields) return null;
    const pristine = isPristine(fields);
    const wasStored = base !== null && this._stored.has(key);
    if (!pristine && !wasStored && this._stored.size >= this.max) return null;
    if (existing && !base) this.delete(key);
    const before = base ? partToJSON(base) : null;
    let state = base;
    if (state) {
      for (const f of PART_FIELDS) delete state[f];
      Object.assign(state, fields);
    } else {
      state = makeState(q, y, r, fields);
      this.map.set(key, state);
    }
    if (pristine) this._stored.delete(key);
    else this._stored.add(key);
    const after = partToJSON(state);
    if (JSON.stringify(before) !== JSON.stringify(after)) this.version++;
    return state;
  }

  /**
   * The engine's battery drain (§4.7 step 7): set the charge of the battery at (q, y, r) to `c` amp-seconds (clamped
   * 0..BATTERY_CAPACITY, kept fractional in memory) IN PLACE, bumping `version` only when the charge crosses a whole percent
   * (§4.7 step 7: autosave follows a draining battery once per percent). Not a §6.2.2 method: set() would normalise `c` to
   * whole amp-seconds.
   * @returns {boolean} false when the entry would be a new saved one past the cap (the battery then stays as it was)
   */
  setCharge(q, y, r, c) {
    const key = partKey(q, y, r);
    let state = this.map.get(key);
    if (!state || state.k !== 'battery') {
      state = this.ensure(q, y, r, 'battery');
      if (!state) return false;
    }
    const v = Math.min(BATTERY_CAPACITY, Math.max(0, Number.isFinite(c) ? c : 0));
    const old = state.c;
    const wasStored = this._stored.has(key);
    const stored = !isPristine({ ...state, c: v });
    if (stored && !wasStored && this._stored.size >= this.max) return false;
    state.c = v;
    if (stored) this._stored.add(key);
    else this._stored.delete(key);
    const pct = (x) => Math.floor((x / BATTERY_CAPACITY) * 100);
    if (pct(old) !== pct(v)) this.version++;
    return true;
  }

  /** @returns {boolean} true when an entry was removed */
  delete(key) {
    const had = this.map.delete(key);
    if (had && this._stored.delete(key)) this.version++;
    return had;
  }

  /** Drop every entry. */
  clear() {
    if (this._stored.size > 0) this.version++;
    this.map.clear();
    this._stored.clear();
  }

  /**
   * Replace every entry with the (normalised) contents of `json`; version resets to 0 afterwards (restoring a save is not
   * an edit). Orphans are the loader's business (validatePartsJSON in deserializeSave).
   * @param {CircuitPartsJSON|null|undefined} json
   * @returns {string[]} warnings
   */
  replaceAll(json) {
    this.map.clear();
    this._stored.clear();
    const { parts, warnings } = normalizePartsJSON(json ?? null, this.max);
    for (const key of Object.keys(parts)) {
      const cell = parsePartKey(key);
      const fields = cell ? normalizePart(parts[key].k, parts[key]) : null;
      if (!cell || !fields) continue;
      this.map.set(key, makeState(cell[0], cell[1], cell[2], fields));
      this._stored.add(key);
    }
    this.version = 0;
    return warnings;
  }

  /** @returns {CircuitPartsJSON} the non-pristine entries, non-default fields only, keys sorted by (q, y, r) */
  export() {
    /** @type {CircuitPartsJSON} */
    const out = {};
    for (const key of [...this._stored].sort(compareKeys)) {
      const entry = partToJSON(/** @type {PartState} */ (this.map.get(key)));
      if (entry) out[key] = /** @type {*} */ (entry);
    }
    return out;
  }

  /** @returns {PartState[]} every entry (pristine ones included), sorted by (q, y, r) */
  list() {
    return [...this.map.keys()].sort(compareKeys).map((k) => /** @type {PartState} */ (this.map.get(k)));
  }
}
