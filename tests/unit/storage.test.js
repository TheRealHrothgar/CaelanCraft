// Unit tests for src/storage.js — see src/CONTRACTS.md §14 and docs/PLAN-build.md §2.10.
// Storage wrappers are exercised against a Map-backed fake { getItem, setItem, removeItem }.
import { describe, it, expect } from 'vitest';
import { CHUNK_VOLUME, HOTBAR_SIZE, PITCH_LIMIT } from '../../src/config.js';
import { localIndex } from '../../src/coords.js';
import { BLOCK, DEFAULT_HOTBAR } from '../../src/blocks.js';
import {
  SAVE_KEY, SAVE_VERSION, DEFAULT_SAVE_HOTBAR,
  serializeSave, deserializeSave, saveGame, loadGame, hasSave, clearSave,
} from '../../src/storage.js';

// ---------------------------------------------------------------------------------------------
// helpers

/** Deterministic PRNG so the "random" edit sets are reproducible (never Math.random in tests). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` unique (chunk, localIndex) edits spread over chunks with cx, cz in [-range, range].
 * Ids cover 0..24 so "edit back to AIR" pairs are included.
 * @returns {{ edits: Record<string, number[]>, chunkCount: number }}
 */
function randomEdits(count, seed, range = 6) {
  const rnd = mulberry32(seed);
  /** @type {Map<string, Map<number, number>>} */
  const chunks = new Map();
  let n = 0;
  while (n < count) {
    const cx = Math.floor(rnd() * (2 * range + 1)) - range;
    const cz = Math.floor(rnd() * (2 * range + 1)) - range;
    const li = Math.floor(rnd() * CHUNK_VOLUME);
    const id = Math.floor(rnd() * 25);
    const key = `${cx},${cz}`;
    let m = chunks.get(key);
    if (!m) {
      m = new Map();
      chunks.set(key, m);
    }
    if (m.has(li)) continue;
    m.set(li, id);
    n++;
  }
  const edits = {};
  for (const [key, m] of chunks) {
    const flat = [];
    for (const [li, id] of m) flat.push(li, id);
    edits[key] = flat;
  }
  return { edits, chunkCount: chunks.size };
}

/** A complete, valid SaveData with a realistic spawn and the default hotbar. */
function makeSave(edits = {}, overrides = {}) {
  return {
    version: SAVE_VERSION,
    seed: 123456789,
    time: 0.3,
    day: 0,
    player: { x: 0.5, y: 70, z: 0.5, yaw: Math.PI, pitch: 0, flying: false },
    hotbar: [...DEFAULT_HOTBAR],
    selected: 0,
    edits,
    ...overrides,
  };
}

/** Map-backed fake of the Web Storage subset the module uses. */
function fakeStorage(initial = []) {
  const map = new Map(initial);
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** Fake whose setItem always throws like a full localStorage. */
function quotaStorage(initial = []) {
  const s = fakeStorage(initial);
  s.setItem = () => {
    const e = new Error('The quota has been exceeded.');
    e.name = 'QuotaExceededError';
    throw e;
  };
  return s;
}

/** Deserialise, asserting a non-null result so later property access is type-safe. */
function load(text) {
  const r = deserializeSave(text);
  expect(r).not.toBeNull();
  return /** @type {NonNullable<typeof r>} */ (r);
}

// ---------------------------------------------------------------------------------------------

describe('storage constants', () => {
  it('exports the contract key and version (v2: edits keyed by hex (q, r) chunks)', () => {
    expect(SAVE_KEY).toBe('caelancraft:v2:save');
    expect(SAVE_VERSION).toBe(2);
  });

  it('DEFAULT_SAVE_HOTBAR is a frozen copy of blocks.DEFAULT_HOTBAR', () => {
    expect(DEFAULT_SAVE_HOTBAR.length).toBe(HOTBAR_SIZE);
    expect([...DEFAULT_SAVE_HOTBAR]).toEqual([...DEFAULT_HOTBAR]);
    expect(Object.isFrozen(DEFAULT_SAVE_HOTBAR)).toBe(true);
  });
});

describe('serializeSave', () => {
  it('writes JSON with keys in a stable order', () => {
    const s = serializeSave(makeSave({ '1,2': [5, 1] }));
    const parsed = JSON.parse(s);
    expect(Object.keys(parsed)).toEqual(['version', 'seed', 'time', 'day', 'player', 'hotbar', 'selected', 'edits']);
    expect(Object.keys(parsed.player)).toEqual(['x', 'y', 'z', 'yaw', 'pitch', 'flying']);
    expect(parsed.version).toBe(SAVE_VERSION);
  });

  it('is independent of the caller\'s property insertion order', () => {
    const a = makeSave({ '3,4': [1, 2], '-1,0': [7, 8] });
    const b = {
      edits: { '-1,0': [7, 8], '3,4': [1, 2] },
      selected: a.selected,
      hotbar: [...a.hotbar],
      player: { flying: false, pitch: 0, yaw: Math.PI, z: 0.5, y: 70, x: 0.5 },
      day: a.day,
      time: a.time,
      seed: a.seed,
      version: SAVE_VERSION,
    };
    expect(serializeSave(a)).toBe(serializeSave(b));
  });

  it('sorts chunk keys numerically by cx then cz (negatives before positives)', () => {
    const s = serializeSave(makeSave({ '10,0': [1, 1], '2,-3': [1, 1], '-5,7': [1, 1], '2,-10': [1, 1], '-5,-1': [1, 1] }));
    expect(Object.keys(JSON.parse(s).edits)).toEqual(['-5,-1', '-5,7', '2,-10', '2,-3', '10,0']);
  });

  it('is deterministic: identical input → identical string, repeatedly', () => {
    const { edits } = randomEdits(300, 42);
    const data = makeSave(edits);
    const first = serializeSave(data);
    for (let i = 0; i < 5; i++) expect(serializeSave(makeSave(randomEdits(300, 42).edits))).toBe(first);
  });

  it('serialize(deserialize(s)) === s — the format is canonical/idempotent', () => {
    const s1 = serializeSave(makeSave(randomEdits(200, 7).edits, { time: 0.123456789, day: 3, selected: 4 }));
    const s2 = serializeSave(load(s1));
    expect(s2).toBe(s1);
  });

  it('canonicalises hotbar/selected on write (invalid → defaults) and coerces flying to boolean', () => {
    const parsed = JSON.parse(serializeSave(makeSave({}, {
      hotbar: [1, 2, 3],
      selected: 12,
      player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, flying: /** @type {any} */ (1) },
    })));
    expect(parsed.hotbar).toEqual([...DEFAULT_SAVE_HOTBAR]);
    expect(parsed.selected).toBe(0);
    expect(parsed.player.flying).toBe(true);
    const parsed2 = JSON.parse(serializeSave(makeSave({}, { player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } })));
    expect(parsed2.player.flying).toBe(false);
  });

  it('treats a missing edits field as {} and drops empty chunk arrays', () => {
    const data = makeSave();
    delete data.edits;
    expect(JSON.parse(serializeSave(data)).edits).toEqual({});
    expect(JSON.parse(serializeSave(makeSave({ '0,0': [], '1,1': [3, 4] }))).edits).toEqual({ '1,1': [3, 4] });
  });

  it('accepts typed arrays for edit entries and the hotbar', () => {
    const parsed = JSON.parse(serializeSave(makeSave(
      { '0,0': /** @type {any} */ (new Uint16Array([100, 3, 200, 4])) },
      { hotbar: /** @type {any} */ (Uint8Array.from(DEFAULT_HOTBAR)) },
    )));
    expect(parsed.edits).toEqual({ '0,0': [100, 3, 200, 4] });
    expect(parsed.hotbar).toEqual([...DEFAULT_HOTBAR]);
  });

  it('throws a TypeError rather than writing an unloadable save', () => {
    expect(() => serializeSave(/** @type {any} */ (null))).toThrow(TypeError);
    expect(() => serializeSave(/** @type {any} */ ('nope'))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { seed: NaN }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { time: Infinity }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { day: /** @type {any} */ ('1') }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { player: undefined }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { player: { x: NaN, y: 1, z: 1, yaw: 0, pitch: 0, flying: false } }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave({}, { player: { x: 1, y: 1, z: 1, yaw: 0, pitch: -Infinity, flying: false } }))).toThrow(TypeError);
    expect(() => serializeSave(makeSave(/** @type {any} */ ([1, 2])))).toThrow(TypeError);
    expect(() => serializeSave(makeSave(/** @type {any} */ (new Map())))).toThrow(TypeError);
  });

  it('size bounds: empty save is tiny, 1000 edits stay well under budget', () => {
    const empty = serializeSave(makeSave());
    expect(empty.length).toBeLessThan(200); // PLAN-build §2.10 (task bound is 300)
    const { edits, chunkCount } = randomEdits(1000, 99);
    expect(chunkCount).toBeGreaterThan(20);
    const big = serializeSave(makeSave(edits));
    expect(big.length).toBeLessThan(25 * 1024); // PLAN-build §2.10 (task bound is 30 KB)
  });
});

describe('deserializeSave', () => {
  it('roundtrips 1000 random edits across many chunks plus all meta', () => {
    const { edits, chunkCount } = randomEdits(1000, 2024);
    expect(chunkCount).toBeGreaterThan(20);
    const data = makeSave(edits, {
      seed: 4022250974,
      time: 0.61803398875,
      day: 12,
      player: { x: -123.456, y: 71.25, z: 987.001, yaw: -2.5, pitch: 0.75, flying: true },
      hotbar: [BLOCK.STONE, BLOCK.AIR, BLOCK.GLASS, BLOCK.WATER, 200, 255, BLOCK.WOOL_RED, BLOCK.DIRT, BLOCK.SAND],
      selected: 8,
    });
    const out = load(serializeSave(data));
    expect(out).toEqual(data);
    // arrays are fresh copies, not references into the input
    expect(out.hotbar).not.toBe(data.hotbar);
    expect(Object.keys(out.edits).length).toBe(chunkCount);
    // every localIndex within a chunk survives exactly once
    for (const key of Object.keys(edits)) {
      expect(out.edits[key].length).toBe(edits[key].length);
      expect(out.edits[key].length % 2).toBe(0);
    }
  });

  it('roundtrips negative chunk keys and edge local indices', () => {
    const edits = {
      '-1,-1': [localIndex(15, 127, 15), BLOCK.BRICKS, localIndex(0, 0, 0), BLOCK.AIR],
      '-3,2': [localIndex(7, 64, 9), BLOCK.GLASS],
      '5,-7': [CHUNK_VOLUME - 1, 255, 0, 1],
    };
    const out = load(serializeSave(makeSave(edits)));
    expect(out.edits).toEqual(edits);
  });

  it('last write wins for repeated local indices within a chunk', () => {
    const text = JSON.stringify(makeSave({
      '2,3': [100, BLOCK.STONE, 200, BLOCK.DIRT, 100, BLOCK.GLASS, 100, BLOCK.AIR, 200, BLOCK.SAND],
    }));
    const out = load(text);
    expect(out.edits['2,3']).toEqual([100, BLOCK.AIR, 200, BLOCK.SAND]);
  });

  it('merges duplicate chunk keys that only differ in formatting (last write wins)', () => {
    const text = JSON.stringify(makeSave({ '01,2': [5, BLOCK.STONE, 6, BLOCK.DIRT], '1,2': [5, BLOCK.GLASS] }));
    const out = load(text);
    expect(out.edits).toEqual({ '1,2': [5, BLOCK.GLASS, 6, BLOCK.DIRT] });
  });

  it('returns null for wrong/missing version (a v1 cube-world save is NOT loadable)', () => {
    const base = makeSave({ '0,0': [1, 1] });
    expect(deserializeSave(JSON.stringify({ ...base, version: 0 }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: 1 }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: 3 }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: '2' }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: null }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: SAVE_VERSION }))).not.toBeNull();
    const noVersion = /** @type {any} */ ({ ...base });
    delete noVersion.version;
    expect(deserializeSave(JSON.stringify(noVersion))).toBeNull();
  });

  it('returns null for garbage, empty and non-string input without throwing', () => {
    for (const bad of ['', ' ', 'not json', '{', '{"version":2', '[]', '[1,2]', 'null', '42', '"str"', 'true', '{}']) {
      expect(deserializeSave(bad)).toBeNull();
    }
    for (const notText of [undefined, null, 123, {}, [], () => {}, Symbol('x')]) {
      expect(deserializeSave(/** @type {any} */ (notText))).toBeNull();
    }
  });

  it('returns null when a required meta field is missing or not a finite number', () => {
    const base = makeSave({ '0,0': [1, 1] });
    for (const field of ['seed', 'time', 'day', 'player', 'edits']) {
      const copy = /** @type {any} */ ({ ...base });
      delete copy[field];
      expect(deserializeSave(JSON.stringify(copy)), `missing ${field}`).toBeNull();
    }
    expect(deserializeSave(JSON.stringify({ ...base, seed: null }))).toBeNull(); // NaN/Infinity serialise as null
    expect(deserializeSave(JSON.stringify({ ...base, seed: '123' }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, time: 'noon' }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, day: [1] }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, edits: [] }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, edits: 'x' }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, edits: null }))).toBeNull();
  });

  it('returns null when the player block is missing or has a non-finite number', () => {
    const base = makeSave();
    for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) {
      const player = /** @type {any} */ ({ ...base.player });
      delete player[field];
      expect(deserializeSave(JSON.stringify({ ...base, player })), `missing player.${field}`).toBeNull();
      player[field] = null;
      expect(deserializeSave(JSON.stringify({ ...base, player })), `null player.${field}`).toBeNull();
      player[field] = '1';
      expect(deserializeSave(JSON.stringify({ ...base, player })), `string player.${field}`).toBeNull();
    }
    expect(deserializeSave(JSON.stringify({ ...base, player: null }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, player: [1, 2, 3] }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, player: 'here' }))).toBeNull();
  });

  it('coerces player.flying to a strict boolean (missing/non-boolean → false)', () => {
    const base = makeSave();
    const noFlying = /** @type {any} */ ({ ...base.player });
    delete noFlying.flying;
    expect(load(JSON.stringify({ ...base, player: noFlying })).player.flying).toBe(false);
    expect(load(JSON.stringify({ ...base, player: { ...base.player, flying: 'yes' } })).player.flying).toBe(false);
    expect(load(JSON.stringify({ ...base, player: { ...base.player, flying: 1 } })).player.flying).toBe(false);
    expect(load(JSON.stringify({ ...base, player: { ...base.player, flying: true } })).player.flying).toBe(true);
  });

  it('wraps time into [0,1) and clamps pitch to ±PITCH_LIMIT', () => {
    const base = makeSave();
    expect(load(JSON.stringify({ ...base, time: 1.25 })).time).toBeCloseTo(0.25, 12);
    expect(load(JSON.stringify({ ...base, time: -0.25 })).time).toBeCloseTo(0.75, 12);
    expect(load(JSON.stringify({ ...base, time: 1 })).time).toBe(0);
    expect(load(JSON.stringify({ ...base, time: 0.999 })).time).toBe(0.999);
    const up = load(JSON.stringify({ ...base, player: { ...base.player, pitch: 3 } }));
    expect(up.player.pitch).toBe(PITCH_LIMIT);
    const down = load(JSON.stringify({ ...base, player: { ...base.player, pitch: -3 } }));
    expect(down.player.pitch).toBe(-PITCH_LIMIT);
    expect(load(JSON.stringify({ ...base, player: { ...base.player, pitch: 0.5 } })).player.pitch).toBe(0.5);
  });

  it('drops invalid edit pairs: ids > 255, negative ids, non-integers, out-of-range local indices', () => {
    const text = JSON.stringify(makeSave({
      '0,0': [
        10, 256, // id too large
        11, 1000, // id too large
        12, -1, // negative id
        13, 1.5, // non-integer id
        14, '3', // string id
        15, null, // null id
        -1, BLOCK.STONE, // negative localIndex
        CHUNK_VOLUME, BLOCK.STONE, // localIndex == volume
        1e9, BLOCK.STONE, // huge localIndex
        2.5, BLOCK.STONE, // fractional localIndex
        '7', BLOCK.STONE, // string localIndex
        20, BLOCK.DIRT, // valid
        CHUNK_VOLUME - 1, 255, // valid (edge)
        0, 0, // valid (edit back to AIR)
      ],
    }));
    const out = load(text);
    expect(out.edits).toEqual({ '0,0': [20, BLOCK.DIRT, CHUNK_VOLUME - 1, 255, 0, 0] });
  });

  it('drops the dangling element of an odd-length array but keeps the complete pairs', () => {
    const out = load(JSON.stringify(makeSave({ '4,4': [1, BLOCK.STONE, 2, BLOCK.DIRT, 3] })));
    expect(out.edits).toEqual({ '4,4': [1, BLOCK.STONE, 2, BLOCK.DIRT] });
  });

  it('drops non-array entries, malformed chunk keys, and chunks left with no valid pairs', () => {
    const raw = makeSave();
    raw.edits = /** @type {any} */ ({
      '1,1': [5, BLOCK.STONE],
      '2,2': 'nope',
      '3,3': { 0: 5, 1: 1 },
      '4,4': null,
      '5,5': [],
      '6,6': [999999, BLOCK.STONE], // only invalid pairs → chunk omitted
      'a,b': [5, BLOCK.STONE],
      '1': [5, BLOCK.STONE],
      '1,2,3': [5, BLOCK.STONE],
      '1.5,2': [5, BLOCK.STONE],
      ' 1,2': [5, BLOCK.STONE],
      constructor: [5, BLOCK.STONE],
    });
    // An object literal's `__proto__:` sets the prototype, so create the OWN key the way JSON.parse would.
    Object.defineProperty(raw.edits, '__proto__', { value: [5, BLOCK.STONE], enumerable: true, configurable: true });
    const text = serializeSaveRawForTest(raw);
    expect(text).toContain('"__proto__"');
    const out = load(text);
    expect(out.edits).toEqual({ '1,1': [5, BLOCK.STONE] });
    expect(Object.getPrototypeOf(out.edits)).toBe(Object.prototype);
    expect(Object.keys(out.edits)).toEqual(['1,1']);
  });

  it('falls back to the default hotbar/selected when they are missing or invalid', () => {
    const base = makeSave();
    const cases = [
      { hotbar: undefined, selected: undefined },
      { hotbar: [1, 2, 3], selected: 9 },
      { hotbar: [...DEFAULT_HOTBAR, 1], selected: -1 },
      { hotbar: [1, 2, 3, 4, 5, 6, 7, 8, 256], selected: 1.5 },
      { hotbar: [1, 2, 3, 4, 5, 6, 7, 8, -1], selected: '3' },
      { hotbar: [1, 2, 3, 4, 5, 6, 7, 8, 2.5], selected: null },
      { hotbar: [1, 2, 3, 4, 5, 6, 7, 8, '9'], selected: [2] },
      { hotbar: 'grass', selected: NaN },
      { hotbar: { 0: 1 }, selected: {} },
    ];
    for (const c of cases) {
      const out = load(JSON.stringify({ ...base, ...c }));
      expect(out.hotbar, JSON.stringify(c)).toEqual([...DEFAULT_SAVE_HOTBAR]);
      expect(out.selected, JSON.stringify(c)).toBe(0);
      expect(Object.isFrozen(out.hotbar)).toBe(false); // a fresh mutable copy, never the shared constant
      out.hotbar[0] = 99;
      expect(DEFAULT_SAVE_HOTBAR[0]).toBe(DEFAULT_HOTBAR[0]);
    }
    const ok = load(JSON.stringify({ ...base, hotbar: [0, 255, 1, 2, 3, 4, 5, 6, 7], selected: 8 }));
    expect(ok.hotbar).toEqual([0, 255, 1, 2, 3, 4, 5, 6, 7]);
    expect(ok.selected).toBe(8);
  });

  it('attaches a non-enumerable warnings array describing what was dropped/defaulted', () => {
    const out = load(JSON.stringify({
      ...makeSave({ '0,0': [1, 1, 2, 999], 'bad': [1, 1] }),
      hotbar: [1],
      selected: 42,
    }));
    const warnings = /** @type {any} */ (out).warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(out)).not.toContain('warnings');
    expect(JSON.parse(JSON.stringify(out)).warnings).toBeUndefined();
    // a clean save has no warnings
    const clean = load(serializeSave(makeSave({ '0,0': [1, 1] })));
    expect(/** @type {any} */ (clean).warnings).toEqual([]);
  });

  it('ignores unknown extra fields', () => {
    const out = load(JSON.stringify({ ...makeSave(), savedAt: 123, extra: { a: 1 }, player: { ...makeSave().player, foo: 'bar' } }));
    expect(Object.keys(out)).toEqual(['version', 'seed', 'time', 'day', 'player', 'hotbar', 'selected', 'edits']);
    expect(Object.keys(out.player)).toEqual(['x', 'y', 'z', 'yaw', 'pitch', 'flying']);
  });
});

/** JSON.stringify would call toJSON etc.; here we just need a text with the odd keys preserved verbatim. */
function serializeSaveRawForTest(raw) {
  const editsText = Object.keys(raw.edits)
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(raw.edits[k])}`)
    .join(',');
  const { edits: _e, ...rest } = raw;
  return `${JSON.stringify(rest).slice(0, -1)},"edits":{${editsText}}}`;
}

describe('saveGame / loadGame / hasSave / clearSave (Map-backed fake storage)', () => {
  it('saves under SAVE_KEY, reports presence, loads an equal object and clears', () => {
    const storage = fakeStorage();
    const data = makeSave(randomEdits(250, 5).edits, { day: 2, selected: 3 });
    expect(hasSave(storage)).toBe(false);
    expect(loadGame(storage)).toBeNull();

    expect(saveGame(data, storage)).toBe(true);
    expect(storage.map.size).toBe(1);
    expect(storage.map.get(SAVE_KEY)).toBe(serializeSave(data));
    expect(hasSave(storage)).toBe(true);
    expect(loadGame(storage)).toEqual(data);

    clearSave(storage);
    expect(storage.map.size).toBe(0);
    expect(hasSave(storage)).toBe(false);
    expect(loadGame(storage)).toBeNull();
    // clearing twice is harmless
    expect(() => clearSave(storage)).not.toThrow();
  });

  it('a later save overwrites an earlier one (last write wins at the storage level)', () => {
    const storage = fakeStorage();
    saveGame(makeSave({ '0,0': [1, BLOCK.STONE] }), storage);
    saveGame(makeSave({ '0,0': [1, BLOCK.GLASS], '1,0': [2, BLOCK.DIRT] }, { day: 5 }), storage);
    const out = loadGame(storage);
    expect(out?.day).toBe(5);
    expect(out?.edits).toEqual({ '0,0': [1, BLOCK.GLASS], '1,0': [2, BLOCK.DIRT] });
  });

  it('returns false / null / false when storage is missing or lacks the needed method', () => {
    const data = makeSave();
    for (const missing of [null, undefined, 0, '', {}, { getItem: 1 }]) {
      expect(saveGame(data, /** @type {any} */ (missing))).toBe(false);
      expect(loadGame(/** @type {any} */ (missing))).toBeNull();
      expect(hasSave(/** @type {any} */ (missing))).toBe(false);
      expect(() => clearSave(/** @type {any} */ (missing))).not.toThrow();
    }
  });

  it('uses globalThis.localStorage by default, which is absent in Node', () => {
    expect(globalThis.localStorage).toBeUndefined();
    expect(saveGame(makeSave())).toBe(false);
    expect(loadGame()).toBeNull();
    expect(hasSave()).toBe(false);
    expect(() => clearSave()).not.toThrow();
  });

  it('returns false when setItem throws (quota exceeded) and leaves the previous save intact', () => {
    const good = makeSave({ '0,0': [1, BLOCK.STONE] });
    const prior = serializeSave(good);
    const storage = quotaStorage([[SAVE_KEY, prior]]);
    expect(saveGame(makeSave({ '0,0': [1, BLOCK.GLASS] }), storage)).toBe(false);
    expect(storage.map.get(SAVE_KEY)).toBe(prior);
    expect(loadGame(storage)).toEqual(good);
    // an always-throwing empty store simply has no save
    expect(saveGame(good, quotaStorage())).toBe(false);
    expect(hasSave(quotaStorage())).toBe(false);
  });

  it('returns false (and does not write) when the data cannot be serialised', () => {
    const good = makeSave();
    const storage = fakeStorage();
    expect(saveGame(good, storage)).toBe(true);
    const prior = storage.map.get(SAVE_KEY);
    const broken = makeSave({}, { player: { x: NaN, y: 1, z: 1, yaw: 0, pitch: 0, flying: false } });
    expect(saveGame(broken, storage)).toBe(false);
    expect(storage.map.get(SAVE_KEY)).toBe(prior);
    expect(saveGame(/** @type {any} */ (undefined), storage)).toBe(false);
    expect(storage.map.get(SAVE_KEY)).toBe(prior);
  });

  it('treats a corrupt or foreign blob under SAVE_KEY as "no save"', () => {
    for (const blob of ['garbage', '{"version":1}', '{"version":2}', '', '{}', 'null']) {
      const storage = fakeStorage([[SAVE_KEY, blob]]);
      expect(hasSave(storage), blob).toBe(false);
      expect(loadGame(storage), blob).toBeNull();
    }
    // non-string values from an odd storage implementation are ignored too
    const weird = fakeStorage();
    weird.getItem = () => /** @type {any} */ ({ version: SAVE_VERSION });
    expect(loadGame(weird)).toBeNull();
  });

  it('swallows getItem/removeItem exceptions', () => {
    const storage = fakeStorage([[SAVE_KEY, serializeSave(makeSave())]]);
    storage.getItem = () => {
      throw new Error('SecurityError');
    };
    storage.removeItem = () => {
      throw new Error('SecurityError');
    };
    expect(loadGame(storage)).toBeNull();
    expect(hasSave(storage)).toBe(false);
    expect(() => clearSave(storage)).not.toThrow();
  });

  it('does not touch other keys in the same storage', () => {
    const storage = fakeStorage([['other:key', 'keep me']]);
    saveGame(makeSave(), storage);
    clearSave(storage);
    expect(storage.map.get('other:key')).toBe('keep me');
    expect(storage.map.size).toBe(1);
  });
});
