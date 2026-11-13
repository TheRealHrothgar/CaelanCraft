// Unit tests for src/storage.js — see src/CONTRACTS.md §14 and docs/PLAN-build.md §2.10.
// Storage wrappers are exercised against a Map-backed fake { getItem, setItem, removeItem }.
import { describe, it, expect } from 'vitest';
import {
  CHUNK_VOLUME, HOTBAR_SIZE, PITCH_LIMIT, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_LABEL_CHARS, STEP_COOLDOWN_MAX_S,
  REPEAT_MIN_S, REPEAT_MAX_S, MAX_RUNE_SCRIPT_LINES, GEN_LATEST, PACK_SLOTS, WEAR_SLOTS, BASKET_SLOTS, REMAINS_SLOTS,
  MAX_FIRE_SLOTS, MAX_CIRCUIT_PARTS,
} from '../../src/config.js';
import { localIndex, chunkKey, worldToChunk, worldToLocal } from '../../src/coords.js';
import { BLOCK, DEFAULT_HOTBAR } from '../../src/blocks.js';
import {
  SAVE_KEY, SAVE_VERSION, SURVIVAL_SAVE_VERSION, DEFAULT_SAVE_HOTBAR, DEFAULT_PHYSICS_SWITCHES, PHYSICS_SWITCH_NAMES,
  SAVE_MODES, DEATH_CAUSES, SURVIVAL_STATS, serializeSave, deserializeSave, saveGame, loadGame, hasSave, clearSave,
  normalizePhysicsSwitches, normalizeSurvivalJSON, normalizeContainersJSON, isSurvivalSave, unloadableReason,
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
    // v0.9 (DESIGN-survival §9.6): version 3 (a world with gen ≥ 2 or a survival state) is read too; 4 is still unknown.
    expect(deserializeSave(JSON.stringify({ ...base, version: 3 }))).not.toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: 4 }))).toBeNull();
    expect(deserializeSave(JSON.stringify({ ...base, version: '3' }))).toBeNull();
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

// ---------------------------------------------------------------------------------------------
// Optional `runes` field (CONTRACTS §14 / §27): absent unless the world has customised rune blocks.

/** EditsJSON recording BLOCK.RUNE_BLOCK at cell (q, y, r) (plus any extra pairs). */
function runeEdits(cells, extra = {}) {
  /** @type {Record<string, number[]>} */
  const edits = { ...extra };
  for (const [q, y, r] of cells) {
    const key = chunkKey(worldToChunk(q), worldToChunk(r));
    const li = localIndex(worldToLocal(q), y, worldToLocal(r));
    edits[key] = (edits[key] || []).concat([li, BLOCK.RUNE_BLOCK]);
  }
  return edits;
}

describe('runes (optional field)', () => {
  const SAVE_KEYS = ['version', 'seed', 'time', 'day', 'player', 'hotbar', 'selected', 'edits'];

  it('serializeSave omits runes when absent, null, empty, or made only of pristine (default) entries', () => {
    expect(Object.keys(JSON.parse(serializeSave(makeSave())))).toEqual(SAVE_KEYS);
    expect(Object.keys(JSON.parse(serializeSave(makeSave({}, { runes: null }))))).toEqual(SAVE_KEYS);
    expect(Object.keys(JSON.parse(serializeSave(makeSave({}, { runes: {} }))))).toEqual(SAVE_KEYS);
    const pristine = { '1,2,3': {}, '4,5,6': { script: '', enabled: true, interact: true, stepCooldown: 1 } };
    expect(Object.keys(JSON.parse(serializeSave(makeSave({}, { runes: pristine }))))).toEqual(SAVE_KEYS);
  });

  it('writes runes last, keys sorted by (q, y, r), canonicalised, with non-default fields only', () => {
    const runes = {
      '5,10,-2': { script: 'say b', label: '', enabled: true, interact: true, stepOn: false, stepCooldown: 1, repeat: false, repeatInterval: 5, chain: false },
      '-3,64,7': { script: 'say a', chain: true, stepOn: true, stepCooldown: 2.5, repeat: true, repeatInterval: 10, label: 'lift', enabled: false, interact: false },
      '05,10,-02': { script: 'say dup wins' }, // canonical form of 5,10,-2 → last write wins
      '0,0,0': { label: 'only a label' },
    };
    const parsed = JSON.parse(serializeSave(makeSave({}, { runes })));
    expect(Object.keys(parsed)).toEqual([...SAVE_KEYS, 'runes']);
    expect(Object.keys(parsed.runes)).toEqual(['-3,64,7', '0,0,0', '5,10,-2']);
    expect(parsed.runes['5,10,-2']).toEqual({ script: 'say dup wins' });
    expect(parsed.runes['0,0,0']).toEqual({ label: 'only a label' });
    expect(parsed.runes['-3,64,7']).toEqual({
      script: 'say a', label: 'lift', enabled: false, interact: false, stepOn: true, stepCooldown: 2.5, repeat: true, repeatInterval: 10, chain: true,
    });
    // Field order inside an entry is fixed.
    expect(Object.keys(parsed.runes['-3,64,7'])).toEqual(['script', 'label', 'enabled', 'interact', 'stepOn', 'stepCooldown', 'repeat', 'repeatInterval', 'chain']);
  });

  it('serializeSave is independent of insertion order for runes too', () => {
    const a = makeSave({}, { runes: { '1,1,1': { script: 'x' }, '0,0,0': { script: 'y' } } });
    const b = makeSave({}, { runes: { '0,0,0': { script: 'y' }, '1,1,1': { script: 'x' } } });
    expect(serializeSave(a)).toBe(serializeSave(b));
  });

  it('throws a TypeError for a non-object runes field (so saveGame refuses rather than writing garbage)', () => {
    for (const bad of [[], 'x', 42, true, new Map()]) {
      expect(() => serializeSave(makeSave({}, { runes: bad }))).toThrow(TypeError);
    }
    expect(saveGame(makeSave({}, { runes: [] }), fakeStorage())).toBe(false);
  });

  it('deserializeSave keeps entries whose cell is recorded as RUNE_BLOCK in edits and drops orphans with a warning', () => {
    const edits = runeEdits([[3, 64, -5]], { '0,0': [localIndex(1, 20, 1), BLOCK.STONE] });
    const text = serializeSave(makeSave(edits, {
      runes: { '3,64,-5': { script: 'say kept' }, '1,20,1': { script: 'say stone, not a rune' }, '9,9,9': { script: 'say nothing there' } },
    }));
    const out = load(text);
    expect(out.runes).toEqual({ '3,64,-5': { script: 'say kept' } });
    const w = /** @type {*} */ (out).warnings;
    expect(w.some((s) => s.includes('(1, 20, 1)'))).toBe(true);
    expect(w.some((s) => s.includes('(9, 9, 9)'))).toBe(true);
    expect(w.some((s) => s.includes('(3, 64, -5)'))).toBe(false);
  });

  it('a later edit pair for the same cell wins when deciding whether the cell is a rune block', () => {
    const q = 2, y = 30, r = 2;
    const key = chunkKey(worldToChunk(q), worldToChunk(r));
    const li = localIndex(worldToLocal(q), y, worldToLocal(r));
    // Recorded as rune, then overwritten by stone in the same chunk array → not a rune any more.
    const edits = { [key]: [li, BLOCK.RUNE_BLOCK, li, BLOCK.STONE] };
    const raw = JSON.parse(serializeSave(makeSave(edits)));
    raw.runes = { [`${q},${y},${r}`]: { script: 'say x' } };
    const out = load(JSON.stringify(raw));
    expect(out.runes).toBeUndefined();
  });

  it('drops malformed keys and non-object entries, keeps the rest', () => {
    const edits = runeEdits([[1, 5, 1]]);
    const raw = JSON.parse(serializeSave(makeSave(edits)));
    raw.runes = {
      '1,5,1': { script: 'ok' },
      '1,5': { script: 'two parts' },
      'a,b,c': { script: 'letters' },
      '1,200,1': { script: 'y out of range' },
      ' 1,5,1': { script: 'space' },
      '1,5,1,0': { script: 'four parts' },
      '2,5,2': 'not an object',
      '3,5,3': ['array'],
      '4,5,4': null,
    };
    const out = load(JSON.stringify(raw));
    expect(out.runes).toEqual({ '1,5,1': { script: 'ok' } });
    expect(/** @type {*} */ (out).warnings.length).toBeGreaterThanOrEqual(7);
  });

  it('clamps script length and line count, label length, cooldown and interval ranges; coerces booleans; defaults non-finite numbers', () => {
    const edits = runeEdits([[0, 10, 0]]);
    const raw = JSON.parse(serializeSave(makeSave(edits)));
    raw.runes = {
      '0,10,0': {
        script: 'say x\n'.repeat(MAX_RUNE_SCRIPT_LINES + 50),
        label: 'L'.repeat(MAX_RUNE_LABEL_CHARS + 20),
        stepCooldown: STEP_COOLDOWN_MAX_S * 10,
        repeatInterval: REPEAT_MIN_S / 10,
        enabled: 0,
        interact: 'yes',
        stepOn: 1,
        repeat: NaN,
        chain: 'true',
        unknownField: 123,
      },
    };
    const out = load(JSON.stringify(raw));
    const r = /** @type {*} */ (out.runes)['0,10,0'];
    expect(r.script.length).toBeLessThanOrEqual(MAX_RUNE_SCRIPT_CHARS);
    expect(r.script.split('\n').length).toBeLessThanOrEqual(MAX_RUNE_SCRIPT_LINES);
    expect(r.label).toBe('L'.repeat(MAX_RUNE_LABEL_CHARS));
    expect(r.stepCooldown).toBe(STEP_COOLDOWN_MAX_S);
    expect(r.repeatInterval).toBe(REPEAT_MIN_S);
    expect(r.enabled).toBe(false);
    expect(r.interact).toBeUndefined(); // 'yes' → true, which is the default and therefore omitted
    expect(r.stepOn).toBe(true);
    expect(r.repeat).toBeUndefined(); // NaN → false (default)
    expect(r.chain).toBe(true);
    expect('unknownField' in r).toBe(false);

    // Non-finite / huge numbers fall back to the defaults (omitted) or the cap.
    raw.runes = { '0,10,0': { script: 'a', stepCooldown: Infinity, repeatInterval: REPEAT_MAX_S * 2 } };
    const out2 = load(JSON.stringify(raw));
    const r2 = /** @type {*} */ (out2.runes)['0,10,0'];
    expect(r2.stepCooldown).toBeUndefined();
    expect(r2.repeatInterval).toBe(REPEAT_MAX_S);
  });

  it('a non-object runes field is ignored with a warning (never a null save); absent runes → no field, no warning', () => {
    const base = JSON.parse(serializeSave(makeSave()));
    for (const bad of [[], 'x', 7, true]) {
      const out = load(JSON.stringify({ ...base, runes: bad }));
      expect(out.runes).toBeUndefined();
      expect(/** @type {*} */ (out).warnings).toContain('runes: not an object, ignored');
    }
    const plain = load(JSON.stringify(base));
    expect(plain.runes).toBeUndefined();
    expect(/** @type {*} */ (plain).warnings).toEqual([]);
    // `runes: null` is also treated as absent.
    const nul = load(JSON.stringify({ ...base, runes: null }));
    expect(nul.runes).toBeUndefined();
  });

  it('roundtrips a save with a rune block edit and its script through serialize → deserialize → serialize', () => {
    const cells = [[-7, 40, 12], [16, 41, -16]];
    const edits = runeEdits(cells, { '2,2': [localIndex(0, 50, 0), BLOCK.GLASS] });
    const runes = {
      '-7,40,12': { script: 'setblock @ @1 @ stone\nsay lift', stepOn: true, stepCooldown: 2, chain: true },
      '16,41,-16': { script: 'time set noon', repeat: true, repeatInterval: 30, label: 'clock' },
    };
    const text = serializeSave(makeSave(edits, { runes }));
    const back = load(text);
    expect(back.runes).toEqual(runes);
    expect(back.edits).toEqual(edits);
    expect(serializeSave(back)).toBe(text);
    expect(Object.keys(JSON.parse(text))).toEqual([...SAVE_KEYS, 'runes']);
    // And through the storage wrappers.
    const storage = fakeStorage();
    expect(saveGame(makeSave(edits, { runes }), storage)).toBe(true);
    expect(loadGame(storage).runes).toEqual(runes);
    expect(hasSave(storage)).toBe(true);
  });
});

describe('pigs field (v0.5)', () => {
  it('is absent unless given, written even when empty, and validated on load', () => {
    expect(JSON.parse(serializeSave(makeSave())).pigs).toBeUndefined();
    expect(deserializeSave(serializeSave(makeSave())).pigs).toBeUndefined();
    const empty = deserializeSave(serializeSave(makeSave({}, { pigs: [] })));
    expect(empty.pigs).toEqual([]);
    const pigs = [{ x: 1.5, y: 20, z: -3, yaw: 0.25 }, { x: 'bad', y: 1, z: 1, yaw: 0 }];
    const text = serializeSave(makeSave({}, { pigs }));
    expect(JSON.parse(text).pigs).toEqual([pigs[0]]);
    const raw = JSON.parse(text);
    raw.pigs.push({ x: 0, y: Infinity, z: 0, yaw: 0 }, null);
    const back = deserializeSave(JSON.stringify(raw).replace('Infinity', 'null'));
    expect(back.pigs).toEqual([pigs[0]]);
    expect(back.warnings).toEqual(['pigs[1]: invalid, dropped', 'pigs[2]: invalid, dropped']);
  });
});

describe('physics field (v0.8 block-physics switches)', () => {
  it('is absent unless given (an absent field means the world predates block physics)', () => {
    expect(JSON.parse(serializeSave(makeSave())).physics).toBeUndefined();
    expect(deserializeSave(serializeSave(makeSave())).physics).toBeUndefined();
  });

  it('round-trips the four switches in canonical order', () => {
    const physics = { explosions: false, collapse: false, water: true, falling: true };
    const text = serializeSave(makeSave({}, { physics }));
    expect(text).toContain('"physics":{"falling":true,"water":true,"collapse":false,"explosions":false}');
    expect(deserializeSave(text).physics).toEqual({ falling: true, water: true, collapse: false, explosions: false });
    expect(PHYSICS_SWITCH_NAMES).toEqual(['falling', 'water', 'collapse', 'explosions']);
    expect(DEFAULT_PHYSICS_SWITCHES).toEqual({ falling: true, water: true, collapse: true, explosions: true });
  });

  it('normalises: anything that is not false is on; unknown keys dropped', () => {
    expect(normalizePhysicsSwitches({ falling: false, water: 0, extra: true })).toEqual({ falling: false, water: true, collapse: true, explosions: true });
    expect(normalizePhysicsSwitches(null)).toEqual(DEFAULT_PHYSICS_SWITCHES);
  });

  it('a malformed field is dropped with a warning (never a null save); non-boolean switches warn and read as on', () => {
    const raw = JSON.parse(serializeSave(makeSave()));
    raw.physics = 'yes';
    const a = deserializeSave(JSON.stringify(raw));
    expect(a).not.toBeNull();
    expect(a.physics).toBeUndefined();
    expect(a.warnings).toContain('physics: not an object, ignored');
    raw.physics = { falling: 'no', collapse: false };
    const b = deserializeSave(JSON.stringify(raw));
    expect(b.physics).toEqual({ falling: true, water: true, collapse: false, explosions: true });
    expect(b.warnings).toContain('physics.falling: not a boolean, treated as on');
  });

  it('worlds without the field serialise byte-identically to before', () => {
    const data = makeSave({ '0,0': [5, BLOCK.STONE] });
    expect(serializeSave(data)).toBe(serializeSave({ ...data, physics: undefined }));
  });
});

describe('zombies field (§39: the per-world zombies switch; zombies themselves are never saved)', () => {
  it('is absent unless given, and absent reads as on (new worlds and older saves have zombies)', () => {
    expect(JSON.parse(serializeSave(makeSave())).zombies).toBeUndefined();
    expect(deserializeSave(serializeSave(makeSave())).zombies).toBeUndefined();
  });

  it('round-trips on and off', () => {
    const off = serializeSave(makeSave({}, { zombies: false }));
    expect(off).toContain('"zombies":false');
    expect(deserializeSave(off).zombies).toBe(false);
    expect(deserializeSave(serializeSave(makeSave({}, { zombies: true }))).zombies).toBe(true);
  });

  it('a non-boolean field is dropped with a warning (never a null save)', () => {
    const raw = JSON.parse(serializeSave(makeSave()));
    raw.zombies = 'nope';
    const s = deserializeSave(JSON.stringify(raw));
    expect(s).not.toBeNull();
    expect(s.zombies).toBeUndefined();
    expect(s.warnings).toContain('zombies: not a boolean, treated as on');
  });
});

describe('watcher field (§40: the per-world Hollow Watcher switch; the Watcher itself is never saved)', () => {
  it('is absent unless given (absent reads as on), round-trips on and off, and a non-boolean is dropped with a warning', () => {
    expect(JSON.parse(serializeSave(makeSave())).watcher).toBeUndefined();
    expect(deserializeSave(serializeSave(makeSave())).watcher).toBeUndefined();
    const off = serializeSave(makeSave({}, { watcher: false }));
    expect(off).toContain('"watcher":false');
    expect(deserializeSave(off).watcher).toBe(false);
    expect(deserializeSave(serializeSave(makeSave({}, { watcher: true }))).watcher).toBe(true);
    const raw = JSON.parse(serializeSave(makeSave()));
    raw.watcher = 3;
    const s = deserializeSave(JSON.stringify(raw));
    expect(s).not.toBeNull();
    expect(s.watcher).toBeUndefined();
    expect(s.warnings).toContain('watcher: not a boolean, treated as on');
  });
});

describe('watcherNight field (§40.1: the night of the last natural Watcher sighting, so a reload cannot bring a second)', () => {
  it('is absent unless given — old saves load without it — and round-trips a night number, written after `watcher`', () => {
    expect(JSON.parse(serializeSave(makeSave())).watcherNight).toBeUndefined();
    expect(deserializeSave(serializeSave(makeSave())).watcherNight).toBeUndefined();
    expect(serializeSave(makeSave({}, { watcherNight: null }))).toBe(serializeSave(makeSave())); // byte-identical without it
    for (const n of [0, 1, 7, 123456]) {
      const text = serializeSave(makeSave({}, { watcherNight: n }));
      expect(deserializeSave(text).watcherNight).toBe(n);
      expect(deserializeSave(text).warnings).toEqual([]);
    }
    const keys = Object.keys(JSON.parse(serializeSave(makeSave({}, { watcher: false, watcherNight: 4, meta: { name: 'W' } }))));
    expect(keys.slice(-3)).toEqual(['watcher', 'watcherNight', 'meta']);
  });

  it('is never trusted blindly: anything but a whole night number ≥ 0 is dropped with a warning (never a null save)', () => {
    for (const bad of [-1, 2.5, '3', true, null, {}, [3], 1e300, Number.MAX_SAFE_INTEGER + 2]) {
      const raw = JSON.parse(serializeSave(makeSave()));
      raw.watcherNight = bad;
      const s = deserializeSave(JSON.stringify(raw));
      expect(s, JSON.stringify(bad)).not.toBeNull();
      expect(s.watcherNight).toBeUndefined();
      expect(s.warnings).toContain('watcherNight: not a night number, ignored');
    }
    // serializeSave leaves an unusable value out rather than writing something the loader would drop.
    for (const bad of [-1, 2.5, NaN, Infinity, '3']) {
      expect(JSON.parse(serializeSave(makeSave({}, { watcherNight: bad }))).watcherNight).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Survival fields (v0.9, docs/DESIGN-survival.md §1.4 and §9.6): gen, mode, survival, containers

/** EditsJSON recording [q, y, r, id] cells. */
function editsAt(cells) {
  /** @type {Record<string, number[]>} */
  const edits = {};
  for (const [q, y, r, id] of cells) {
    const key = chunkKey(worldToChunk(q), worldToChunk(r));
    (edits[key] ??= []).push(localIndex(worldToLocal(q), y, worldToLocal(r)), id);
  }
  return edits;
}

const s7 = (over = {}) => Object.assign(new Array(7).fill(null), over);
const nulls = (n) => new Array(n).fill(null);

/** A valid survival state (as main builds it: survival.export() + pack.export() + fires). */
function survivalState(over = {}) {
  return {
    health: 87.25, satiation: 64, hydration: 51, temp: 36.9, breath: 20, wet: 0, sick: 0, heal: 0, healRate: 0,
    fatigue: 0, // CONTRACTS §87 (a save from before it has none: sleep.test.js)
    spawn: [10, 64, -3], deaths: 2,
    pack: [{ k: 'rock', n: 12 }, { k: 'flint_pick', n: 1, d: 40 }, ...nulls(PACK_SLOTS - 2)],
    wear: [{ k: 'straw_hat', n: 1 }, null, { k: 'hide_shoes', n: 1 }],
    fires: {},
    ...over,
  };
}

/** A save whose raw JSON has `field` set to `value` (bypassing serializeSave), deserialised. */
function loadWith(fields, edits = {}) {
  const raw = JSON.parse(serializeSave(makeSave(edits)));
  return load(JSON.stringify({ ...raw, ...fields }));
}

describe('survival save fields (v0.9): presence, defaults and the version', () => {
  it('each field is absent unless given, and absent reads as the default (no field, no warning)', () => {
    const base = makeSave({ '1,2': [5, 1] });
    const text = serializeSave(base);
    for (const f of ['gen', 'mode', 'survival', 'containers']) expect(text).not.toContain(`"${f}"`);
    const back = load(text);
    for (const f of ['gen', 'mode', 'survival', 'containers']) expect(back[f], f).toBeUndefined();
    expect(back.warnings).toEqual([]);
    expect(back.version).toBe(2);
    expect(SAVE_MODES).toEqual(['creative', 'survival']);
  });

  it('a Creative save without the fields is byte-identical to before, and still version 2', () => {
    const base = makeSave({ '1,2': [5, 1] });
    const expected = `{"version":2,"seed":123456789,"time":0.3,"day":0,"player":{"x":0.5,"y":70,"z":0.5,"yaw":${Math.PI},"pitch":0,`
      + `"flying":false},"hotbar":${JSON.stringify(DEFAULT_HOTBAR)},"selected":0,"edits":{"1,2":[5,1]}}`;
    expect(serializeSave(base)).toBe(expected);
    // what main writes for a world that never entered Survival: every field undefined (or gen 1, or nothing usable)
    for (const extra of [
      { gen: undefined, mode: undefined, survival: undefined, containers: undefined },
      { gen: 1 }, { gen: null }, { gen: 0 }, { gen: 2.5 }, { mode: null }, { mode: 'hardcore' }, { survival: null },
      { containers: null }, { containers: {} }, { containers: { 'x': { kind: 'basket', slots: [] } } },
    ]) {
      expect(serializeSave({ ...base, ...extra }), JSON.stringify(extra)).toBe(expected);
    }
  });

  it('is version 3 exactly when gen ≥ 2 or a survival state is present', () => {
    expect(SURVIVAL_SAVE_VERSION).toBe(3);
    const v = (extra) => JSON.parse(serializeSave({ ...makeSave(), ...extra })).version;
    expect(v({})).toBe(2);
    expect(v({ gen: 2 })).toBe(3);
    expect(v({ survival: survivalState() })).toBe(3);
    expect(v({ gen: 2, mode: 'survival', survival: survivalState() })).toBe(3);
    expect(v({ mode: 'creative' })).toBe(2);
    expect(v({ mode: 'survival' })).toBe(2);
    expect(v({ containers: { '0,64,0': { kind: 'basket', slots: [] } } })).toBe(2);
    // the loaded document's version says the same of what it holds
    expect(loadWith({ version: 3 }).version).toBe(2);
    expect(loadWith({ version: 2, gen: 2 }).version).toBe(3);
    expect(loadWith({ survival: survivalState() }).version).toBe(3);
  });

  it('writes the fields after watcherNight and before meta: gen, mode, survival, containers', () => {
    const edits = editsAt([[0, 64, 0, BLOCK.WICKER_BASKET]]);
    const text = serializeSave({
      ...makeSave(edits), watcher: true, watcherNight: 3, gen: 2, mode: 'survival', survival: survivalState(),
      containers: { '0,64,0': { kind: 'basket', slots: [] } }, meta: { name: 'Home' },
    });
    expect(Object.keys(JSON.parse(text)).slice(-7)).toEqual(['watcher', 'watcherNight', 'gen', 'mode', 'survival', 'containers', 'meta']);
    expect(text.startsWith('{"version":3,')).toBe(true);
  });

  it('round-trips all four fields; serialize(deserialize(s)) === s', () => {
    const edits = editsAt([
      [3, 64, -5, BLOCK.CAMPFIRE], [-20, 70, 4, BLOCK.FIRE_PIT], [0, 64, 0, BLOCK.WICKER_BASKET], [-1, 30, -40, BLOCK.REMAINS],
    ]);
    const fires = {
      '-20,70,4': { s: s7({ 2: { k: 'roast_pork', t: 3.5 } }) },
      '3,64,-5': { s: s7({ 0: { k: 'raw_pork', t: 12.25 }, 6: { k: 'pot_water', t: 1 } }), f: 250.5 },
    };
    const containers = {
      '-1,30,-40': { kind: 'remains', slots: [{ k: 'rock', n: 3 }, null, { k: 'flint_knife', n: 1, d: 12 }] },
      '0,64,0': { kind: 'basket', slots: [...nulls(17), { k: 'honeyberries', n: 9 }] },
    };
    const data = { ...makeSave(edits), gen: 2, mode: 'survival', survival: survivalState({ fires, dead: 'fall' }), containers };
    const text = serializeSave(data);
    const back = load(text);
    expect(back.warnings).toEqual([]);
    expect(back.version).toBe(3);
    expect(back.gen).toBe(2);
    expect(back.mode).toBe('survival');
    expect(back.survival).toEqual({ ...survivalState({ fires, dead: 'fall' }) });
    expect(Object.keys(back.survival.fires)).toEqual(['-20,70,4', '3,64,-5']);
    expect(back.containers).toEqual(containers);
    expect(Object.keys(back.containers)).toEqual(['-1,30,-40', '0,64,0']);
    expect(serializeSave(back)).toBe(text);
    // gen alone, mode creative with a frozen state (a world switched back to Creative)
    const frozen = load(serializeSave({ ...makeSave(), gen: 2, mode: 'creative', survival: survivalState() }));
    expect(frozen.mode).toBe('creative');
    expect(frozen.survival.health).toBe(87.25);
  });
});

describe('survival save fields: gen and mode', () => {
  it('gen > GEN_LATEST is unloadable (and serializeSave refuses to write it)', () => {
    expect(GEN_LATEST).toBe(5); // §85: natural springs and gravel in beds (4 was v0.15's lean land, §79)
    const raw = JSON.parse(serializeSave(makeSave()));
    const newer = JSON.stringify({ ...raw, version: 3, gen: GEN_LATEST + 1 });
    expect(deserializeSave(newer)).toBeNull();
    expect(unloadableReason(newer)).toBe(`gen ${GEN_LATEST + 1}: made by a newer version of Caelancraft`);
    expect(() => serializeSave({ ...makeSave(), gen: GEN_LATEST + 1 })).toThrow(TypeError);
    expect(saveGame({ ...makeSave(), gen: 99 }, fakeStorage())).toBe(false);
    expect(unloadableReason(serializeSave(makeSave()))).toBe('');
    expect(unloadableReason('{nope')).toBe('not a save (unreadable text)');
    expect(unloadableReason('[]')).toBe('not a save');
    expect(unloadableReason(JSON.stringify({ ...raw, version: 4 }))).toBe('version 4: not a version this game reads');
    expect(unloadableReason(JSON.stringify({ ...raw, seed: 'x' }))).toBe('a required field is missing or invalid');
  });

  it('gen: 1 is dropped silently; anything that is not an integer ≥ 1 is dropped with a warning', () => {
    const one = loadWith({ gen: 1 });
    expect(one.gen).toBeUndefined();
    expect(one.warnings).toEqual([]);
    for (const bad of [0, -2, 2.5, '2', null, true, {}, [2]]) {
      const s = loadWith({ gen: bad });
      expect(s.gen, JSON.stringify(bad)).toBeUndefined();
      expect(s.warnings).toEqual(['gen: not a generator version, treated as 1']);
    }
    expect(loadWith({ gen: 2 }).gen).toBe(2);
  });

  it('mode: anything but creative or survival is dropped with a warning; survival on generation 1 loads in Creative', () => {
    for (const bad of ['Survival', 'hardcore', 1, null, true, {}]) {
      const s = loadWith({ mode: bad });
      expect(s.mode, JSON.stringify(bad)).toBeUndefined();
      expect(s.warnings).toEqual(['mode: not creative or survival, treated as creative']);
    }
    expect(loadWith({ mode: 'creative' }).mode).toBe('creative');
    const handEdited = loadWith({ mode: 'survival' });
    expect(handEdited.mode).toBe('creative');
    expect(handEdited.warnings).toEqual(['mode: survival needs generation 2; loaded in Creative']);
    const fine = loadWith({ gen: 2, mode: 'survival' });
    expect(fine.mode).toBe('survival');
    expect(fine.warnings).toEqual([]);
  });

  it('isSurvivalSave: mode survival on generation 2 or later', () => {
    expect(isSurvivalSave({ mode: 'survival', gen: 2 })).toBe(true);
    for (const d of [{ mode: 'survival' }, { mode: 'survival', gen: 1 }, { mode: 'creative', gen: 2 }, {}, null, 'survival', []]) {
      expect(isSurvivalSave(d), JSON.stringify(d)).toBe(false);
    }
  });
});

describe('survival save fields: the survival state', () => {
  it('a non-object survival is ignored with a warning (never a null save); serializeSave refuses one', () => {
    for (const bad of ['x', 5, [], true, null]) {
      const s = loadWith({ survival: bad });
      expect(s.survival, JSON.stringify(bad)).toBeUndefined();
      expect(s.warnings).toEqual(['survival: not an object, ignored']);
    }
    for (const bad of ['x', 5, [], true, new Map()]) {
      expect(() => serializeSave({ ...makeSave(), survival: /** @type {any} */ (bad) }), String(bad)).toThrow(TypeError);
    }
  });

  it('canonical form: key order, numbers rounded to 3 places (never −0), `dead` only when set', () => {
    const n = normalizeSurvivalJSON(survivalState({ health: 50.123456, wet: -0.0001, temp: 37.00049 }));
    expect(Object.keys(n)).toEqual([...SURVIVAL_STATS.map((s) => s[0]), 'spawn', 'deaths', 'pack', 'wear', 'fires']);
    expect(SURVIVAL_STATS.map((s) => s[0])).toEqual(['health', 'satiation', 'hydration', 'temp', 'breath', 'wet', 'sick', 'heal', 'healRate',
      'fatigue']); // fatigue: CONTRACTS §87
    expect(n.health).toBe(50.123);
    expect(Object.is(n.wet, 0)).toBe(true);
    expect(n.temp).toBe(37);
    expect(Object.keys(normalizeSurvivalJSON(survivalState({ dead: 'drown' })))).toContain('dead');
    expect(normalizeSurvivalJSON(survivalState({ dead: null })).dead).toBeUndefined();
    // the bounds themselves are fine
    const edges = normalizeSurvivalJSON(survivalState({ health: 0, satiation: 100, hydration: 0, temp: 25, breath: 0, wet: 1, sick: 600, heal: 50, healRate: 5 }));
    expect(edges).toMatchObject({ health: 0, satiation: 100, hydration: 0, temp: 25, breath: 0, wet: 1, sick: 600, heal: 50, healRate: 5 });
    expect(normalizeSurvivalJSON(survivalState({ temp: 45 })).temp).toBe(45);
  });

  it('a bad stat is reset to its fresh value with `survival.<stat>: invalid, reset`', () => {
    const fresh = { health: 100, satiation: 80, hydration: 80, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0, healRate: 0 };
    const bad = { health: [-1, 100.1], satiation: [NaN, 101], hydration: ['50', null], temp: [24.9, 45.1], breath: [21, -0.5], wet: [1.5, -1], sick: [601, -1], heal: [51, 'x'], healRate: [6, {}] };
    for (const [stat, values] of Object.entries(bad)) {
      for (const value of [...values, undefined]) {
        const st = survivalState({ [stat]: value });
        if (value === undefined) delete st[stat];
        const s = loadWith({ survival: st });
        expect(s.survival[stat], `${stat} ${value}`).toBe(fresh[stat]);
        expect(s.warnings).toEqual([`survival.${stat}: invalid, reset`]);
      }
    }
  });

  it('spawn, deaths and dead are checked', () => {
    for (const bad of [[1, 2], [1, 200, 3], [1.5, 2, 3], 'x', {}, [1, -1, 2]]) {
      const s = loadWith({ survival: survivalState({ spawn: bad }) });
      expect(s.survival.spawn, JSON.stringify(bad)).toBeNull();
      expect(s.warnings).toEqual(['survival.spawn: invalid, reset']);
    }
    expect(loadWith({ survival: survivalState({ spawn: null }) }).warnings).toEqual([]);
    expect(loadWith({ survival: survivalState({ spawn: [-5, 0, 7] }) }).survival.spawn).toEqual([-5, 0, 7]);
    for (const bad of [-1, 1.5, '2', null]) {
      const s = loadWith({ survival: survivalState({ deaths: bad }) });
      expect(s.survival.deaths).toBe(0);
      expect(s.warnings).toEqual(['survival.deaths: invalid, reset']);
    }
    for (const cause of DEATH_CAUSES) expect(loadWith({ survival: survivalState({ dead: cause }) }).survival.dead).toBe(cause);
    expect(DEATH_CAUSES).toEqual(expect.arrayContaining(['fall', 'drown', 'buried', 'crush', 'fire', 'zombie', 'blast', 'log', 'blackhole', 'starve', 'thirst', 'cold', 'heat', 'void', 'command']));
    for (const bad of ['eaten', 5, true, '']) {
      const s = loadWith({ survival: survivalState({ dead: bad }) });
      expect(s.survival.dead).toBeUndefined();
      expect(s.warnings).toEqual(['survival.dead: not a cause of death, ignored']);
    }
  });

  it('bad pack stacks are dropped with their reason; a wrong pack length is padded or cut', () => {
    const pack = [
      { k: 'nope', n: 1 }, // unknown item
      { k: 'rock', n: 0 }, { k: 'rock', n: 65 }, { k: 'rock', n: 1.5 }, { k: 'rock', n: '3' }, // counts
      { k: 'flint_pick', n: 2 }, // tools never stack
      { k: 'flint_pick', n: 1, d: 0 }, { k: 'flint_pick', n: 1, d: 91 }, { k: 'flint_pick', n: 1, d: 2.5 }, // durability
      'rock', 7, { n: 3 }, // not stacks
      { k: 'flint_pick', n: 1, d: 90 }, { k: 'stick', n: 64, d: null }, { k: 'rock', n: 5, d: 3 }, // fine (the last loses d)
      ...nulls(PACK_SLOTS - 15),
    ];
    const s = loadWith({ survival: survivalState({ pack }) });
    expect(s.survival.pack).toEqual([
      ...nulls(12), { k: 'flint_pick', n: 1, d: 90 }, { k: 'stick', n: 64 }, { k: 'rock', n: 5 }, ...nulls(PACK_SLOTS - 15),
    ]);
    expect(s.warnings).toEqual([
      'survival.pack[0]: unknown item "nope", dropped',
      'survival.pack[1]: count is not 1–64, dropped',
      'survival.pack[2]: count is not 1–64, dropped',
      'survival.pack[3]: count is not 1–64, dropped',
      'survival.pack[4]: count is not 1–64, dropped',
      'survival.pack[5]: count is not 1–1, dropped',
      'survival.pack[6]: durability is not 1–90, dropped',
      'survival.pack[7]: durability is not 1–90, dropped',
      'survival.pack[8]: durability is not 1–90, dropped',
      'survival.pack[9]: not an item stack, dropped',
      'survival.pack[10]: not an item stack, dropped',
      'survival.pack[11]: not an item stack, dropped',
      'survival.pack[14]: durability ignored (Rock never wears)',
    ]);
    const short = loadWith({ survival: survivalState({ pack: [{ k: 'rock', n: 1 }] }) });
    expect(short.survival.pack).toEqual([{ k: 'rock', n: 1 }, ...nulls(PACK_SLOTS - 1)]);
    expect(short.warnings).toEqual([`survival.pack: 1 slots, expected ${PACK_SLOTS} (padded)`]);
    const long = loadWith({ survival: survivalState({ pack: [...nulls(PACK_SLOTS), { k: 'rock', n: 1 }] }) });
    expect(long.survival.pack).toEqual(nulls(PACK_SLOTS));
    expect(long.warnings).toEqual([`survival.pack: ${PACK_SLOTS + 1} slots, expected ${PACK_SLOTS} (cut)`]);
    const none = loadWith({ survival: survivalState({ pack: 'full of rocks' }) });
    expect(none.survival.pack).toEqual(nulls(PACK_SLOTS));
    expect(none.warnings).toEqual(['survival.pack: not a list, emptied']);
  });

  it('a wear slot holds only wear items made for it', () => {
    const s = loadWith({ survival: survivalState({ wear: [{ k: 'leather_coat', n: 1 }, { k: 'rock', n: 1 }, { k: 'straw_hat', n: 2 }] }) });
    expect(s.survival.wear).toEqual(nulls(WEAR_SLOTS));
    expect(s.warnings).toEqual([
      'survival.wear[0]: a body item in the head slot, dropped',
      'survival.wear[1]: not a wear item, dropped',
      'survival.wear[2]: count is not 1–1, dropped',
    ]);
    const ok = loadWith({ survival: survivalState({ wear: [{ k: 'leather_hood', n: 1 }, { k: 'grass_cape', n: 1 }, { k: 'hide_shoes', n: 1 }] }) });
    expect(ok.warnings).toEqual([]);
    const two = loadWith({ survival: survivalState({ wear: [null, null] }) });
    expect(two.survival.wear).toEqual(nulls(3));
    expect(two.warnings).toEqual(['survival.wear: 2 slots, expected 3 (padded)']);
  });

  it('fires are validated against the edits: only CAMPFIRE or FIRE_PIT cells keep their spots', () => {
    const edits = editsAt([[3, 64, -5, BLOCK.CAMPFIRE], [4, 64, -5, BLOCK.FIRE_PIT], [5, 64, -5, BLOCK.STONE]]);
    const fires = {
      '3,64,-5': { s: s7({ 0: { k: 'raw_pork', t: 1 } }), f: 100 },
      '4,64,-5': { s: s7({ 6: { k: 'clay_pot', t: 0 } }) },
      '5,64,-5': { s: s7({ 0: { k: 'raw_pork', t: 1 } }) },
      '6,64,-5': { s: s7(), f: 50 },
    };
    const s = loadWith({ gen: 2, survival: survivalState({ fires }) }, edits);
    expect(Object.keys(s.survival.fires)).toEqual(['3,64,-5', '4,64,-5']);
    expect(s.warnings).toEqual(['survival.fires[5,64,-5]: no campfire there, dropped', 'survival.fires[6,64,-5]: no campfire there, dropped']);
    // the repaired edits decide (a later pair for the same cell wins)
    const relit = { ...edits };
    const key = chunkKey(worldToChunk(5), worldToChunk(-5));
    relit[key] = [...relit[key], localIndex(worldToLocal(5), 64, worldToLocal(-5)), BLOCK.CAMPFIRE];
    expect(Object.keys(loadWith({ survival: survivalState({ fires }) }, relit).survival.fires)).toEqual(['3,64,-5', '4,64,-5', '5,64,-5']);
    // a non-object fires field is emptied with a warning; bad entries go through cooking's rules
    const junk = loadWith({ survival: survivalState({ fires: 'hot' }) });
    expect(junk.survival.fires).toEqual({});
    expect(junk.warnings).toEqual(['survival.fires: not an object, ignored']);
    const badSpot = loadWith({ survival: survivalState({ fires: { '3,64,-5': { s: s7({ 0: { k: 'pot_water', t: 0 } }), f: 5 } } }) }, edits);
    expect(badSpot.warnings).toEqual(['survival.fires[3,64,-5].s[0]: "pot_water" cannot be on a skewer, emptied']);
    expect(badSpot.survival.fires['3,64,-5']).toEqual({ s: s7(), f: 5 });
    const tooMany = {};
    for (let i = 0; i <= MAX_FIRE_SLOTS; i++) tooMany[`${i},64,0`] = { s: s7(), f: 1 };
    expect(normalizeSurvivalJSON(survivalState({ fires: tooMany })).fires['256,64,0']).toBeUndefined();
  });
});

describe('survival save fields: containers', () => {
  const edits = editsAt([[0, 64, 0, BLOCK.WICKER_BASKET], [1, 64, 0, BLOCK.REMAINS], [2, 64, 0, BLOCK.STONE], [-3, 10, 7, BLOCK.WICKER_BASKET]]);

  it('are kept when the edits record their block, canonical and sorted; empty after checks → no field', () => {
    const containers = {
      '1,64,0': { kind: 'remains', slots: nulls(REMAINS_SLOTS) },
      '0,64,0': { slots: [{ k: 'rock', n: 2 }], kind: 'basket', extra: 1 },
      '-03,10,7': { kind: 'basket', slots: [] },
    };
    const s = loadWith({ containers }, edits);
    expect(s.warnings).toEqual([]);
    expect(s.containers).toEqual({
      '-3,10,7': { kind: 'basket', slots: [] },
      '0,64,0': { kind: 'basket', slots: [{ k: 'rock', n: 2 }] },
      '1,64,0': { kind: 'remains', slots: nulls(REMAINS_SLOTS) },
    });
    expect(Object.keys(s.containers)).toEqual(['-3,10,7', '0,64,0', '1,64,0']);
    expect(Object.keys(s.containers['0,64,0'])).toEqual(['kind', 'slots']);
    const gone = loadWith({ containers: { '2,64,0': { kind: 'basket', slots: [] } } }, edits);
    expect(gone.containers).toBeUndefined();
    expect(gone.warnings).toEqual(['containers[2,64,0]: no basket there, dropped']);
  });

  it('drops entries with a bad key, kind, slot list or size, or the wrong block; bad stacks become null', () => {
    const containers = {
      'a,b,c': { kind: 'basket', slots: [] },
      '0,64,0': 'basket',
      '1,64,0': { kind: 'chest', slots: [] },
      '-3,10,7': { kind: 'basket', slots: 'lots' },
    };
    const s = loadWith({ containers }, edits);
    expect(s.containers).toBeUndefined();
    expect(s.warnings).toEqual([
      'containers: dropped entry with malformed key "a,b,c"',
      'containers[0,64,0]: not an object, dropped',
      'containers[1,64,0]: unknown kind "chest", dropped',
      'containers[-3,10,7]: slots is not a list, dropped',
    ]);
    const big = loadWith({ containers: { '0,64,0': { kind: 'basket', slots: nulls(BASKET_SLOTS + 1) }, '1,64,0': { kind: 'remains', slots: nulls(REMAINS_SLOTS + 1) } } }, edits);
    expect(big.containers).toBeUndefined();
    expect(big.warnings).toEqual([
      `containers[0,64,0]: ${BASKET_SLOTS + 1} slots, more than a basket holds (${BASKET_SLOTS}), dropped`,
      `containers[1,64,0]: ${REMAINS_SLOTS + 1} slots, more than a belongings heap holds (${REMAINS_SLOTS}), dropped`,
    ]);
    const swapped = loadWith({ containers: { '0,64,0': { kind: 'remains', slots: [] }, '1,64,0': { kind: 'basket', slots: [] } } }, edits);
    expect(swapped.warnings).toEqual(['containers[0,64,0]: no belongings there, dropped', 'containers[1,64,0]: no basket there, dropped']);
    const stacks = loadWith({ containers: { '0,64,0': { kind: 'basket', slots: [{ k: 'rock', n: 99 }, { k: 'rock', n: 9 }, { k: 'zzz', n: 1 }] } } }, edits);
    expect(stacks.containers['0,64,0'].slots).toEqual([null, { k: 'rock', n: 9 }, null]);
    expect(stacks.warnings).toEqual(['containers[0,64,0].slots[0]: count is not 1–64, dropped', 'containers[0,64,0].slots[2]: unknown item "zzz", dropped']);
    for (const bad of ['x', 3, [], null]) {
      const n = loadWith({ containers: bad }, edits);
      expect(n.containers).toBeUndefined();
      expect(n.warnings).toEqual(['containers: not an object, ignored']);
    }
  });

  it('serializeSave writes containers canonically, only when non-empty, and refuses a non-object', () => {
    const out = JSON.parse(serializeSave({ ...makeSave(), containers: { '2,1,0': { kind: 'basket', slots: [] }, '1,1,0': { kind: 'remains', slots: [null] } } }));
    expect(Object.keys(out.containers)).toEqual(['1,1,0', '2,1,0']);
    expect(normalizeContainersJSON('x')).toEqual({});
    for (const bad of ['x', 3, [], new Map()]) expect(() => serializeSave({ ...makeSave(), containers: /** @type {any} */ (bad) })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Circuits (docs/DESIGN-circuits.md §6.4): the black-holes and circuits switches and the configured parts.

describe('circuit save fields: blackholes, circuits, circuitParts', () => {
  /** A switch, a timer and a relay recorded in the edits. */
  const partEdits = () => editsAt([[1, 64, 0, BLOCK.KNIFE_SWITCH], [-20, 64, 5, BLOCK.CLOCKWORK_TIMER], [3, 70, -40, BLOCK.RELAY]]);
  const parts = () => ({
    '1,64,0': { k: 'switch', on: true },
    '-20,64,5': { k: 'timer', l: 'Gate', on: true, f: 1, s: 30, m: 'hold' },
    '3,70,-40': { k: 'relay', nc: true },
  });

  it('each field is absent unless given; absent reads as on / no parts (no warning); a world without them is unchanged', () => {
    const base = makeSave({ '1,2': [5, 1] });
    const text = serializeSave(base);
    for (const f of ['blackholes', 'circuits', 'circuitParts']) expect(text).not.toContain(`"${f}"`);
    const back = load(text);
    expect(back.warnings).toEqual([]);
    expect(back.blackholes).toBeUndefined();
    expect(back.circuits).toBeUndefined();
    expect(back.circuitParts).toBeUndefined();
    expect(serializeSave({ ...base, circuitParts: {} })).toBe(text); // empty parts are not written
    expect(serializeSave({ ...base, circuitParts: { '1,2,3': { k: 'switch' } } })).toBe(text); // pristine: nothing to save
    expect(serializeSave({ ...base, blackholes: null, circuits: undefined, circuitParts: null })).toBe(text);
    expect(text.startsWith('{"version":2,')).toBe(true);
  });

  it('the switches: written whenever given, anything but false is on, a non-boolean on load is dropped with a warning', () => {
    const out = JSON.parse(serializeSave({ ...makeSave(), blackholes: false, circuits: true }));
    expect(out.blackholes).toBe(false);
    expect(out.circuits).toBe(true);
    expect(JSON.parse(serializeSave({ ...makeSave(), blackholes: /** @type {any} */ (0), circuits: /** @type {any} */ ('off') }))).toMatchObject({ blackholes: true, circuits: true });
    const off = load(serializeSave({ ...makeSave(), blackholes: false, circuits: false }));
    expect(off.blackholes).toBe(false);
    expect(off.circuits).toBe(false);
    expect(off.warnings).toEqual([]);
    const bad = loadWith({ blackholes: 'yes', circuits: 1 });
    expect(bad.blackholes).toBeUndefined();
    expect(bad.circuits).toBeUndefined();
    expect(bad.warnings).toEqual(['blackholes: not a boolean, treated as on', 'circuits: not a boolean, treated as on']);
  });

  it('writes the fields after containers and before meta, with survival\'s fields present (a literal object)', () => {
    const edits = editsAt([[0, 64, 0, BLOCK.WICKER_BASKET], [1, 64, 0, BLOCK.KNIFE_SWITCH]]);
    const text = serializeSave({
      version: 2, seed: 7, time: 0.5, day: 3, player: { x: 0.5, y: 70, z: 0.5, yaw: 0, pitch: 0, flying: false },
      hotbar: [...DEFAULT_HOTBAR], selected: 0, edits, runes: {}, pigs: [], physics: DEFAULT_PHYSICS_SWITCHES, zombies: true,
      watcher: true, watcherNight: 3, gen: 2, mode: 'survival', survival: survivalState(),
      containers: { '0,64,0': { kind: 'basket', slots: [] } }, blackholes: true, circuits: false,
      circuitParts: { '1,64,0': { k: 'switch', on: true } }, meta: { name: 'Home' },
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      'version', 'seed', 'time', 'day', 'player', 'hotbar', 'selected', 'edits', 'pigs', 'physics', 'zombies', 'watcher',
      'watcherNight', 'gen', 'mode', 'survival', 'containers', 'blackholes', 'circuits', 'circuitParts', 'meta',
    ]);
    expect(text.startsWith('{"version":3,')).toBe(true); // survival decides the version; circuits change none
  });

  it('circuitParts round-trips canonically: keys sorted, k first, non-default fields only, s in 0.5 steps, c whole', () => {
    const edits = editsAt([...[[1, 64, 0, BLOCK.KNIFE_SWITCH], [-20, 64, 5, BLOCK.CLOCKWORK_TIMER], [3, 70, -40, BLOCK.RELAY]],
      [9, 64, 9, BLOCK.VOLTAIC_BATTERY]]);
    const text = serializeSave({ ...makeSave(edits), circuitParts: { ...parts(), '9,64,9': { k: 'battery', c: 1234.7 },
      '-20,64,5': { m: 'hold', s: 29.8, on: true, f: 1, l: 'Gate', k: 'timer' } } });
    const out = JSON.parse(text).circuitParts;
    expect(Object.keys(out)).toEqual(['-20,64,5', '1,64,0', '3,70,-40', '9,64,9']);
    expect(Object.keys(out['-20,64,5'])).toEqual(['k', 'l', 'on', 'f', 's', 'm']);
    expect(out['-20,64,5']).toEqual({ k: 'timer', l: 'Gate', on: true, f: 1, s: 30, m: 'hold' });
    expect(out['9,64,9']).toEqual({ k: 'battery', c: 1235 });
    const back = load(text);
    expect(back.warnings).toEqual([]);
    expect(back.circuitParts).toEqual(out);
    expect(serializeSave(back)).toBe(text);
    for (const bad of ['x', 3, [], new Map()]) expect(() => serializeSave({ ...makeSave(), circuitParts: /** @type {any} */ (bad) })).toThrow(TypeError);
  });

  it('every repair row of §6.4 warns and drops or resets, and never makes the save unloadable', () => {
    const edits = partEdits();
    const n = loadWith({ circuitParts: 'x' }, edits);
    expect(n.circuitParts).toBeUndefined();
    expect(n.warnings).toEqual(['circuitParts: not an object, ignored']);
    expect(loadWith({ circuitParts: [] }, edits).warnings).toEqual(['circuitParts: not an object, ignored']);
    const v = loadWith({
      circuitParts: {
        ...parts(),
        'a,b,c': { k: 'switch', on: true },
        '2,64,0': { k: 'flux' },
        '4,64,0': { k: 'switch', on: true }, // nothing recorded there: an orphan
        '-20,64,5': { k: 'timer', s: 'soon', m: 'hold' },
        '3,70,-40': { k: 'timer', s: 9 }, // a relay there, not a timer
      },
    }, edits);
    expect(v.circuitParts).toEqual({ '-20,64,5': { k: 'timer', m: 'hold' }, '1,64,0': { k: 'switch', on: true } });
    expect(v.warnings).toEqual(expect.arrayContaining([
      'circuitParts["a,b,c"]: not a cell key, dropped',
      'circuitParts[2,64,0]: unknown kind "flux", dropped',
      'circuitParts[-20,64,5].s: invalid, reset',
      'circuitParts[4,64,0]: no switch there, dropped',
      'circuitParts[3,70,-40]: no timer there, dropped',
    ]));
    expect(v.warnings.length).toBe(5);
    // More than MAX_CIRCUIT_PARTS entries: cut in key order.
    /** @type {Record<string, *>} */
    const many = {};
    const cells = [];
    for (let i = 0; i < MAX_CIRCUIT_PARTS + 3; i++) {
      const q = i % 16;
      const y = 1 + Math.floor(i / 256);
      const r = Math.floor(i / 16) % 16;
      many[`${q},${y},${r}`] = { k: 'switch', on: true };
      cells.push([q, y, r, BLOCK.KNIFE_SWITCH]);
    }
    const big = loadWith({ circuitParts: many }, editsAt(cells));
    expect(Object.keys(big.circuitParts).length).toBe(MAX_CIRCUIT_PARTS);
    expect(big.warnings).toEqual([`circuitParts: more than ${MAX_CIRCUIT_PARTS} entries, the rest dropped`]);
  });

  it('an orphan check sees the REPAIRED edits: a later pair for the cell decides, an invalid pair is not there', () => {
    const li = localIndex(1, 64, 0);
    const v = loadWith({ circuitParts: { '1,64,0': { k: 'switch', on: true }, '2,64,0': { k: 'relay', nc: true } } },
      { '0,0': [li, BLOCK.STONE, li, BLOCK.KNIFE_SWITCH, localIndex(2, 64, 0), 999] });
    expect(v.circuitParts).toEqual({ '1,64,0': { k: 'switch', on: true } });
    expect(v.warnings).toContain('circuitParts[2,64,0]: no relay there, dropped');
  });
});
