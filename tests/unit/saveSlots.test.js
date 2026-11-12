// Unit tests for the save-slot API of src/storage.js — see src/CONTRACTS.md §41 (and §14 for the save document).
// Everything runs against Map-backed fakes of the Web Storage subset the module uses; the quota fake throws a
// QuotaExceededError like a full localStorage does and never changes anything when it throws.
import { describe, it, expect } from 'vitest';
import { PACK_SLOTS, GEN_LATEST } from '../../src/config.js';
import { BLOCK, DEFAULT_HOTBAR } from '../../src/blocks.js';
import {
  SAVE_VERSION, SAVE_KEY, SAVE_SLOTS, MAX_WORLD_NAME_CHARS, STORAGE_QUOTA_ESTIMATE, LEGACY_SAVE_KEY, SLOT_INDEX_KEY,
  MIGRATED_WORLD_NAME, serializeSave, deserializeSave, slotKey, isSlot, cleanWorldName, defaultWorldName, normalizeWorldName,
  normalizeWorldMeta, copyWorldName, textHash, isQuotaError, listSlots, loadSlot, saveSlot, deleteSlot, renameSlot,
  duplicateSlot, firstEmptySlot, migrateLegacySave, storageUsage,
} from '../../src/storage.js';

// ---------------------------------------------------------------------------------------------
// helpers

const NOW = 1_750_000_000_000;

/** A complete, valid SaveData (seed and a few edits vary so worlds can be told apart). */
function makeSave(seed = 1234, overrides = {}) {
  return {
    version: SAVE_VERSION,
    seed,
    time: 0.3,
    day: 2,
    player: { x: 0.5, y: 70, z: 0.5, yaw: Math.PI, pitch: 0, flying: false },
    hotbar: [...DEFAULT_HOTBAR],
    selected: 0,
    edits: { '0,0': [5, 1, 9, 2], '-1,2': [100, 4] },
    ...overrides,
  };
}

/** The world as the game sees it, meta aside (what must survive every move / copy / rename). */
function content(save) {
  expect(save).not.toBeNull();
  return serializeSave({ ...save, meta: undefined });
}

function quotaError() {
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  return e;
}

/** Map-backed fake of { getItem, setItem, removeItem } that counts writes. */
function fakeStorage(initial = []) {
  const map = new Map(initial);
  const s = {
    map,
    writes: 0,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      s.writes++;
      map.set(k, String(v));
    },
    removeItem: (k) => {
      s.writes++;
      map.delete(k);
    },
  };
  return s;
}

/** Fake with a size limit in characters (keys + values, like Chrome): a write past it throws and changes nothing. */
function limitedStorage(limit, initial = []) {
  const s = fakeStorage(initial);
  const used = () => {
    let n = 0;
    for (const [k, v] of s.map) n += k.length + v.length;
    return n;
  };
  s.setItem = (k, v) => {
    const text = String(v);
    const prev = s.map.get(k);
    const next = used() - (prev === undefined ? 0 : k.length + prev.length) + k.length + text.length;
    if (next > limit) throw quotaError();
    s.writes++;
    s.map.set(k, text);
  };
  return s;
}

/** Storage holding `worlds` = [[slot, SaveData], …] written through saveSlot. */
function withWorlds(worlds, storage = fakeStorage()) {
  for (const [slot, save] of worlds) expect(saveSlot(slot, save, storage).ok).toBe(true);
  return storage;
}

// ---------------------------------------------------------------------------------------------

describe('save slots: constants, names and the meta field', () => {
  it('six slots, one key each, plus the index; the legacy key is the old single save', () => {
    expect(SAVE_SLOTS).toBe(6);
    expect(slotKey(1)).toBe('caelancraft:v2:slot:1');
    expect(slotKey(6)).toBe('caelancraft:v2:slot:6');
    expect(SLOT_INDEX_KEY).toBe('caelancraft:v2:slots');
    expect(LEGACY_SAVE_KEY).toBe(SAVE_KEY);
    expect(LEGACY_SAVE_KEY).toBe('caelancraft:v2:save');
    expect(STORAGE_QUOTA_ESTIMATE).toBe(5 * 1024 * 1024);
    for (const n of [1, 3, 6]) expect(isSlot(n)).toBe(true);
    for (const n of [0, 7, -1, 1.5, '1', NaN, null, undefined]) expect(isSlot(n)).toBe(false);
  });

  it('names are trimmed, cut to 24 characters, never empty (fallback "World N"), duplicates allowed', () => {
    expect(MAX_WORLD_NAME_CHARS).toBe(24);
    expect(cleanWorldName('  Castle  ')).toBe('Castle');
    expect(cleanWorldName('a'.repeat(40))).toBe('a'.repeat(24));
    expect(cleanWorldName('abcdefghijklmnopqrstuvw  xyz')).toBe('abcdefghijklmnopqrstuvw'); // cut, then trimmed again
    expect(cleanWorldName('line\nbreak\ttab')).toBe('line break tab');
    expect(cleanWorldName('😀'.repeat(30))).toBe('😀'.repeat(24)); // code points: an emoji is never split
    for (const bad of ['', '   ', '\n\t', 42, null, undefined, {}]) expect(cleanWorldName(bad)).toBe('');
    // KNOWN-ISSUES (save slots): invisible format characters are dropped, so an invisible-only name is no name and
    // bidi controls cannot garble the list
    for (const invisible of ['\u200b', '\u200b\u200d\ufeff', '\u202e\u202c', ' \u2060 ']) expect(cleanWorldName(invisible)).toBe('');
    expect(cleanWorldName('Ca\u200bstle\u202e')).toBe('Castle');
    expect(normalizeWorldName('\u200b\u200b', 3)).toBe('World 3');
    expect(defaultWorldName(4)).toBe('World 4');
    expect(normalizeWorldName('   ', 4)).toBe('World 4');
    expect(normalizeWorldName(undefined, 2)).toBe('World 2');
    expect(normalizeWorldName(' Home ', 2)).toBe('Home');
  });

  it('copy names keep within the limit', () => {
    expect(copyWorldName('Castle')).toBe('Castle (copy)');
    const long = 'x'.repeat(24);
    expect(copyWorldName(long)).toBe('x'.repeat(17) + ' (copy)');
    expect(copyWorldName(long).length).toBe(24);
    expect(copyWorldName('Castle (copy)')).toBe('Castle (copy) (copy)');
  });

  it('meta is written last, canonical, and only when given (older documents serialise byte-identically)', () => {
    const plain = serializeSave(makeSave());
    expect(plain).not.toContain('meta');
    expect(serializeSave({ ...makeSave(), meta: undefined })).toBe(plain);
    expect(serializeSave({ ...makeSave(), meta: {} })).toBe(plain); // nothing usable → omitted
    const text = serializeSave({ ...makeSave(), meta: { lastPlayed: NOW + 0.7, name: '  Home  ', createdAt: NOW - 5, junk: 1 } });
    expect(text.endsWith(`,"meta":{"name":"Home","createdAt":${NOW - 5},"lastPlayed":${NOW}}}`)).toBe(true);
    expect(text.startsWith(`{"version":2,"seed":1234,`)).toBe(true);
    expect(() => serializeSave({ ...makeSave(), meta: 'Home' })).toThrow(TypeError);
    expect(normalizeWorldMeta({ name: '', createdAt: -1, lastPlayed: Infinity })).toBeNull();
  });

  it('meta round-trips; unusable fields are dropped with warnings, never a null save', () => {
    const s = deserializeSave(serializeSave({ ...makeSave(), meta: { name: 'Home', createdAt: 1, lastPlayed: 2 } }));
    expect(s.meta).toEqual({ name: 'Home', createdAt: 1, lastPlayed: 2 });
    const raw = JSON.parse(serializeSave(makeSave()));
    const bad = deserializeSave(JSON.stringify({ ...raw, meta: { name: '   ', createdAt: 'yesterday', lastPlayed: 5 } }));
    expect(bad).not.toBeNull();
    expect(bad.meta).toEqual({ lastPlayed: 5 });
    expect(bad.warnings).toEqual(expect.arrayContaining(['meta.name: not a usable name, ignored', 'meta.createdAt: not a timestamp, ignored']));
    const notObj = deserializeSave(JSON.stringify({ ...raw, meta: 'Home' }));
    expect(notObj).not.toBeNull();
    expect(notObj.meta).toBeUndefined();
    expect(notObj.warnings).toContain('meta: not an object, ignored');
  });

  it('textHash is FNV-1a (32-bit) and isQuotaError knows the browsers\' spellings', () => {
    expect(textHash('')).toBe(0x811c9dc5);
    expect(textHash('a')).toBe(0xe40c292c);
    expect(textHash('foobar')).toBe(0xbf9cf968);
    expect(isQuotaError(quotaError())).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('nope'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('save slots: save, load, list', () => {
  it('an empty storage lists six empty slots and writes nothing', () => {
    const storage = fakeStorage();
    const slots = listSlots(storage);
    expect(slots).toHaveLength(SAVE_SLOTS);
    slots.forEach((s, i) => {
      expect(s).toEqual({ slot: i + 1, status: 'empty', name: '', seed: null, createdAt: 0, lastPlayed: 0, bytes: 0, legacy: false });
    });
    expect(storage.writes).toBe(0);
    expect(firstEmptySlot(storage)).toBe(1);
  });

  it('each slot keeps its own world under its own key', () => {
    const storage = withWorlds([
      [1, makeSave(11, { meta: { name: 'Alpha', createdAt: NOW - 1000, lastPlayed: NOW - 10 } })],
      [3, makeSave(33, { meta: { name: 'Gamma', createdAt: NOW - 2000, lastPlayed: NOW - 20 } })],
    ]);
    expect(loadSlot(1, storage).seed).toBe(11);
    expect(loadSlot(3, storage).seed).toBe(33);
    expect(loadSlot(2, storage)).toBeNull();
    expect(storage.map.has(slotKey(1)) && storage.map.has(slotKey(3)) && !storage.map.has(slotKey(2))).toBe(true);
    const slots = listSlots(storage);
    expect(slots.map((s) => s.status)).toEqual(['world', 'empty', 'world', 'empty', 'empty', 'empty']);
    expect(slots[0]).toMatchObject({ name: 'Alpha', seed: 11, createdAt: NOW - 1000, lastPlayed: NOW - 10 });
    expect(slots[2]).toMatchObject({ name: 'Gamma', seed: 33 });
    expect(slots[0].bytes).toBe(storage.map.get(slotKey(1)).length);
    expect(firstEmptySlot(storage)).toBe(2);
    // overwriting one slot leaves the others alone
    expect(saveSlot(1, makeSave(12, { meta: { name: 'Alpha' } }), storage).ok).toBe(true);
    expect(loadSlot(1, storage).seed).toBe(12);
    expect(loadSlot(3, storage).seed).toBe(33);
  });

  it('loadSlot always hands back a name and both times (fallback "World N", 0 = unknown)', () => {
    const storage = withWorlds([[5, makeSave(5)]]);
    expect(loadSlot(5, storage).meta).toEqual({ name: 'World 5', createdAt: 0, lastPlayed: 0 });
    expect(listSlots(storage)[4]).toMatchObject({ status: 'world', name: 'World 5', createdAt: 0, lastPlayed: 0 });
  });

  it('bad slot numbers and missing storage never throw', () => {
    const storage = fakeStorage();
    expect(saveSlot(0, makeSave(), storage)).toEqual({ ok: false, reason: 'invalid' });
    expect(saveSlot(7, makeSave(), storage)).toEqual({ ok: false, reason: 'invalid' });
    expect(saveSlot(1, { nope: true }, storage)).toEqual({ ok: false, reason: 'invalid' });
    expect(loadSlot(9, storage)).toBeNull();
    expect(saveSlot(1, makeSave(), undefined)).toMatchObject({ ok: false }); // Node: no localStorage
    expect(saveSlot(1, makeSave(), /** @type {*} */ ({}))).toEqual({ ok: false, reason: 'unavailable' });
    expect(loadSlot(1, /** @type {*} */ ({}))).toBeNull();
    expect(listSlots(/** @type {*} */ (null)).every((s) => s.status === 'empty')).toBe(true);
    expect(migrateLegacySave(/** @type {*} */ ({}))).toEqual({ status: 'unavailable' });
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('x'); } };
    expect(listSlots(throwing)).toHaveLength(SAVE_SLOTS);
    expect(saveSlot(1, makeSave(), throwing)).toEqual({ ok: false, reason: 'error' });
    expect(deleteSlot(1, throwing)).toBe(true); // nothing readable = already empty
  });

  it('storageUsage sums the slot sizes against the quota estimate', () => {
    const storage = withWorlds([[1, makeSave(1)], [2, makeSave(2)]]);
    const slots = listSlots(storage);
    const u = storageUsage(slots);
    expect(u.used).toBe(slots[0].bytes + slots[1].bytes);
    expect(u.quota).toBe(STORAGE_QUOTA_ESTIMATE);
    expect(u.fraction).toBeCloseTo(u.used / STORAGE_QUOTA_ESTIMATE, 12);
    expect(storageUsage([{ bytes: STORAGE_QUOTA_ESTIMATE * 3 }]).fraction).toBe(1);
    expect(storageUsage(null)).toEqual({ used: 0, quota: STORAGE_QUOTA_ESTIMATE, fraction: 0 });
  });
});

describe('save slots: the index is a cache that is never trusted blindly', () => {
  const worlds = () => withWorlds([
    [1, makeSave(11, { meta: { name: 'Alpha', createdAt: 100, lastPlayed: 200 } })],
    [4, makeSave(44, { meta: { name: 'Delta', createdAt: 300, lastPlayed: 400 } })],
  ]);
  const summary = (slots) => slots.map((s) => `${s.slot}:${s.status}:${s.name}:${s.seed}:${s.lastPlayed}:${s.bytes}`);

  it('a consistent index is used as is and not rewritten', () => {
    const storage = worlds();
    const before = summary(listSlots(storage));
    const writes = storage.writes;
    expect(summary(listSlots(storage))).toEqual(before);
    expect(storage.writes).toBe(writes);
  });

  it('a missing index is rebuilt from the slot keys (names and times live in the documents)', () => {
    const storage = worlds();
    const expected = summary(listSlots(storage));
    storage.map.delete(SLOT_INDEX_KEY);
    expect(summary(listSlots(storage))).toEqual(expected);
    expect(storage.map.has(SLOT_INDEX_KEY)).toBe(true);
  });

  it('a corrupt or foreign index is rebuilt', () => {
    for (const junk of ['{not json', '[]', '{"version":99,"slots":[]}', '{"version":1,"slots":[null,null]}', '"x"']) {
      const storage = worlds();
      const expected = summary(listSlots(storage));
      storage.map.set(SLOT_INDEX_KEY, junk);
      expect(summary(listSlots(storage)), junk).toEqual(expected);
      expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).version).toBe(1);
    }
  });

  it('entries that do not match their slot are rebuilt: wrong text, ghost worlds, missing worlds, bad fields', () => {
    const storage = worlds();
    const expected = summary(listSlots(storage));
    const index = JSON.parse(storage.map.get(SLOT_INDEX_KEY));
    // slot 1: a lying entry with the right size but another hash; slot 2: a ghost world over an empty slot;
    // slot 4: dropped; slot 6: an entry whose name is not a clean name
    index.slots[0] = { ...index.slots[0], name: 'Liar', hash: (index.slots[0].hash + 1) >>> 0 };
    index.slots[1] = { name: 'Ghost', seed: 1, createdAt: 0, lastPlayed: 0, bytes: 10, hash: 1 };
    index.slots[3] = null;
    index.slots[5] = { name: '  padded  ', seed: 1, createdAt: 0, lastPlayed: 0, bytes: 10, hash: 1 };
    storage.map.set(SLOT_INDEX_KEY, JSON.stringify(index));
    expect(summary(listSlots(storage))).toEqual(expected);
    // a slot edited behind the index's back (another tab, devtools) is listed as it now is
    storage.map.set(slotKey(4), serializeSave(makeSave(45, { meta: { name: 'Edited', lastPlayed: 500 } })));
    expect(listSlots(storage)[3]).toMatchObject({ status: 'world', name: 'Edited', seed: 45, lastPlayed: 500 });
    storage.map.delete(slotKey(1));
    expect(listSlots(storage)[0].status).toBe('empty');
  });

  it('with repair: false (?nosave) nothing is written', () => {
    const storage = worlds();
    storage.map.delete(SLOT_INDEX_KEY);
    const writes = storage.writes;
    expect(listSlots(storage, { repair: false })[3].name).toBe('Delta');
    expect(storage.writes).toBe(writes);
    expect(storage.map.has(SLOT_INDEX_KEY)).toBe(false);
  });

  it('an index that cannot be written (storage full) does not stop the listing', () => {
    const storage = worlds();
    storage.map.delete(SLOT_INDEX_KEY);
    storage.setItem = () => {
      throw quotaError();
    };
    expect(listSlots(storage).map((s) => s.name)).toEqual(['Alpha', '', '', 'Delta', '', '']);
  });
});

describe('save slots: damaged worlds', () => {
  const damagedTexts = ['{not json', '[1,2,3]', JSON.stringify({ version: 1, seed: 1 }), '{"version":2,"seed":"x"}', 'null'];

  it('an unparsable or invalid document lists as "damaged", loads as null, and can only be deleted', () => {
    for (const junk of damagedTexts) {
      const storage = withWorlds([[2, makeSave(2, { meta: { name: 'Fine' } })]]);
      storage.map.set(slotKey(3), junk);
      const slots = listSlots(storage);
      expect(slots[2], junk).toMatchObject({ slot: 3, status: 'damaged', name: '', seed: null, bytes: junk.length });
      expect(slots[1]).toMatchObject({ status: 'world', name: 'Fine' });
      expect(loadSlot(3, storage)).toBeNull();
      expect(renameSlot(3, 'Fixed', storage)).toEqual({ ok: false, reason: 'damaged' });
      expect(duplicateSlot(3, storage, NOW)).toEqual({ ok: false, reason: 'damaged' });
      expect(storage.map.get(slotKey(3))).toBe(junk); // untouched until the player deletes it
      expect(firstEmptySlot(storage)).toBe(1); // a damaged slot is not empty
      expect(deleteSlot(3, storage)).toBe(true);
      expect(storage.map.has(slotKey(3))).toBe(false);
      expect(listSlots(storage)[2].status).toBe('empty');
    }
  });

  it('a damaged slot stays damaged through the index (cached as damaged, still checked by hash)', () => {
    const storage = fakeStorage([[slotKey(6), '{broken']]);
    expect(listSlots(storage)[5].status).toBe('damaged');
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[5]).toMatchObject({ damaged: true, bytes: 7 });
    expect(listSlots(storage)[5].status).toBe('damaged');
    storage.map.set(slotKey(6), serializeSave(makeSave(6))); // repaired by hand
    expect(listSlots(storage)[5]).toMatchObject({ status: 'world', name: 'World 6', seed: 6 });
  });
});

describe('save slots: a failed save keeps the previous one', () => {
  it('a save that does not fit fails with reason quota and leaves the old save byte for byte', () => {
    const small = makeSave(7, { meta: { name: 'Keep me' } });
    const storage = limitedStorage(4000);
    expect(saveSlot(2, small, storage).ok).toBe(true);
    const before = storage.map.get(slotKey(2));
    const big = makeSave(7, { meta: { name: 'Keep me' }, edits: { '0,0': Array.from({ length: 4000 }, (_, i) => (i % 2 ? 1 : i)) } });
    expect(saveSlot(2, big, storage)).toEqual({ ok: false, reason: 'quota' });
    expect(storage.map.get(slotKey(2))).toBe(before);
    expect(content(loadSlot(2, storage))).toBe(content(small));
    expect(listSlots(storage)[1]).toMatchObject({ status: 'world', name: 'Keep me' });
  });

  it('a new world that does not fit leaves its slot empty', () => {
    const storage = limitedStorage(100);
    expect(saveSlot(4, makeSave(4), storage)).toEqual({ ok: false, reason: 'quota' });
    expect(storage.map.has(slotKey(4))).toBe(false);
    expect(listSlots(storage)[3].status).toBe('empty');
  });

  it('a backend that clobbers the key and then throws is put back', () => {
    const storage = withWorlds([[1, makeSave(1, { meta: { name: 'Old' } })]]);
    const before = storage.map.get(slotKey(1));
    const set = storage.setItem;
    storage.setItem = (k, v) => {
      if (k === slotKey(1) && String(v) !== before) {
        storage.map.set(k, String(v).slice(0, 20)); // half-written
        throw quotaError();
      }
      set(k, v);
    };
    expect(saveSlot(1, makeSave(1, { meta: { name: 'New' }, day: 9 }), storage)).toEqual({ ok: false, reason: 'quota' });
    expect(storage.map.get(slotKey(1))).toBe(before);
  });

  it('a backend that silently keeps something else is reported as an error and put back', () => {
    const storage = withWorlds([[1, makeSave(1, { meta: { name: 'Old' } })]]);
    const before = storage.map.get(slotKey(1));
    const set = storage.setItem;
    storage.setItem = (k, v) => set(k, k === slotKey(1) && String(v) !== before ? String(v).slice(0, 30) : v);
    expect(saveSlot(1, makeSave(1, { day: 9 }), storage)).toEqual({ ok: false, reason: 'error' });
    expect(storage.map.get(slotKey(1))).toBe(before);
  });
});

describe('save slots: rename, duplicate, delete', () => {
  it('rename, duplicate and the legacy move keep the night of the last Watcher sighting (§14 watcherNight)', () => {
    const orig = makeSave(8, { watcherNight: 5, meta: { name: 'Night', createdAt: 100, lastPlayed: 200 } });
    const storage = withWorlds([[3, orig]]);
    expect(renameSlot(3, 'Renamed', storage).ok).toBe(true);
    expect(loadSlot(3, storage).watcherNight).toBe(5);
    expect(duplicateSlot(3, storage, NOW)).toMatchObject({ ok: true, slot: 1 });
    expect(loadSlot(1, storage).watcherNight).toBe(5);
    const legacy = fakeStorage([[LEGACY_SAVE_KEY, serializeSave(makeSave(9, { watcherNight: 2 }))]]);
    expect(migrateLegacySave(legacy, NOW)).toMatchObject({ status: 'migrated', slot: 1 });
    expect(loadSlot(1, legacy).watcherNight).toBe(2);
  });

  it('rename changes only the name (normalised), keeps the times and the world', () => {
    const orig = makeSave(8, { meta: { name: 'Before', createdAt: 100, lastPlayed: 200 } });
    const storage = withWorlds([[3, orig]]);
    expect(renameSlot(3, '   A much longer name than allowed here   ', storage)).toMatchObject({ ok: true, name: 'A much longer name than' });
    const after = loadSlot(3, storage);
    expect(after.meta).toEqual({ name: 'A much longer name than', createdAt: 100, lastPlayed: 200 });
    expect(content(after)).toBe(content(orig));
    expect(listSlots(storage)[2].name).toBe('A much longer name than');
    expect(renameSlot(3, '  ', storage)).toMatchObject({ ok: true, name: 'World 3' }); // no empty names
    expect(renameSlot(3, 'Same', storage).ok).toBe(true);
    expect(renameSlot(4, 'Same', withWorlds([[4, makeSave(4)]], storage)).ok).toBe(true); // duplicates allowed
    expect(listSlots(storage).filter((s) => s.name === 'Same')).toHaveLength(2);
    expect(renameSlot(5, 'Nothing here', storage)).toEqual({ ok: false, reason: 'empty' });
  });

  it('a rename that does not fit keeps the old document', () => {
    const storage = limitedStorage(0);
    storage.map.set(slotKey(1), serializeSave(makeSave(1, { meta: { name: 'A' } })));
    const before = storage.map.get(slotKey(1));
    expect(renameSlot(1, 'A longer name', storage)).toEqual({ ok: false, reason: 'quota' });
    expect(storage.map.get(slotKey(1))).toBe(before);
  });

  it('duplicate copies into the first empty slot as "<name> (copy)", created now, last played when the original was', () => {
    const orig = makeSave(21, { meta: { name: 'Base', createdAt: 100, lastPlayed: 200 }, runes: undefined });
    const storage = withWorlds([[1, makeSave(1)], [2, orig], [4, makeSave(4)]]);
    const res = duplicateSlot(2, storage, NOW);
    expect(res).toMatchObject({ ok: true, slot: 3, name: 'Base (copy)' });
    const copy = loadSlot(3, storage);
    expect(copy.meta).toEqual({ name: 'Base (copy)', createdAt: NOW, lastPlayed: 200 });
    expect(content(copy)).toBe(content(orig));
    expect(content(loadSlot(2, storage))).toBe(content(orig)); // the original is untouched
    expect(loadSlot(2, storage).meta.name).toBe('Base');
    expect(listSlots(storage)[2]).toMatchObject({ status: 'world', name: 'Base (copy)', seed: 21 });
  });

  it('duplicate needs an empty slot and room; otherwise nothing is written', () => {
    const full = withWorlds(Array.from({ length: SAVE_SLOTS }, (_, i) => [i + 1, makeSave(i + 1)]));
    const writes = full.writes;
    expect(firstEmptySlot(full)).toBe(0);
    expect(duplicateSlot(1, full, NOW)).toEqual({ ok: false, reason: 'full' });
    expect(full.writes).toBe(writes);
    const tight = limitedStorage(0);
    tight.map.set(slotKey(1), serializeSave(makeSave(1)));
    expect(duplicateSlot(1, tight, NOW)).toEqual({ ok: false, reason: 'quota' });
    expect(tight.map.has(slotKey(2))).toBe(false);
    expect(duplicateSlot(5, fakeStorage(), NOW)).toEqual({ ok: false, reason: 'empty' });
  });

  it('delete empties exactly one slot and its index entry', () => {
    const storage = withWorlds([[1, makeSave(1)], [2, makeSave(2)]]);
    listSlots(storage);
    expect(deleteSlot(1, storage)).toBe(true);
    expect(storage.map.has(slotKey(1))).toBe(false);
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[0]).toBeNull();
    expect(listSlots(storage).map((s) => s.status)).toEqual(['empty', 'world', 'empty', 'empty', 'empty', 'empty']);
    expect(deleteSlot(1, storage)).toBe(true); // already empty
    expect(deleteSlot(0, storage)).toBe(false);
    const stuck = withWorlds([[1, makeSave(1)]]);
    stuck.removeItem = () => {
      throw new Error('nope');
    };
    expect(deleteSlot(1, stuck)).toBe(false);
    expect(loadSlot(1, stuck)).not.toBeNull();
  });
});

describe('save slots: moving the old single save into slot 1', () => {
  const legacyWorld = () => makeSave(99, { edits: { '3,-4': [10, 7, 11, 7], '0,0': [1, 2] }, zombies: false });

  it('nothing to do without a legacy save', () => {
    const storage = fakeStorage();
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'none' });
    expect(storage.writes).toBe(0);
  });

  it('a legacy save becomes slot 1 "My World", the world unchanged, and only then is removed', () => {
    const legacy = serializeSave(legacyWorld());
    const storage = fakeStorage([[LEGACY_SAVE_KEY, legacy]]);
    const order = [];
    const set = storage.setItem;
    const remove = storage.removeItem;
    storage.setItem = (k, v) => (order.push(`set ${k}`), set(k, v));
    storage.removeItem = (k) => (order.push(`remove ${k}`), remove(k));
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'migrated', slot: 1 });
    expect(order.indexOf(`set ${slotKey(1)}`)).toBeLessThan(order.indexOf(`remove ${LEGACY_SAVE_KEY}`));
    expect(storage.map.has(LEGACY_SAVE_KEY)).toBe(false);
    const moved = loadSlot(1, storage);
    expect(content(moved)).toBe(content(deserializeSave(legacy)));
    expect(moved.meta).toEqual({ name: MIGRATED_WORLD_NAME, createdAt: NOW, lastPlayed: NOW });
    expect(MIGRATED_WORLD_NAME).toBe('My World');
    expect(listSlots(storage)[0]).toMatchObject({ status: 'world', name: 'My World', seed: 99, legacy: false });
    expect(migrateLegacySave(storage, NOW + 1)).toEqual({ status: 'none' }); // idempotent
  });

  it('a damaged legacy save is moved verbatim and lists as damaged (never thrown away unasked)', () => {
    const storage = fakeStorage([[LEGACY_SAVE_KEY, '{"version":1,"cubes":true}']]);
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'migrated', slot: 1 });
    expect(storage.map.get(slotKey(1))).toBe('{"version":1,"cubes":true}');
    expect(listSlots(storage)[0].status).toBe('damaged');
  });

  it('with slot 1 taken it goes to the first empty slot; with none free it stays where it is', () => {
    const legacy = serializeSave(legacyWorld());
    // (slots first: while a legacy save waits and slot 1 has no key of its own, saving slot 1 writes the legacy save)
    const storage = withWorlds([[1, makeSave(1)], [2, makeSave(2)]]);
    storage.map.set(LEGACY_SAVE_KEY, legacy);
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'migrated', slot: 3 });
    expect(loadSlot(3, storage).meta.name).toBe('My World');
    expect(loadSlot(1, storage).seed).toBe(1);
    const full = withWorlds(Array.from({ length: SAVE_SLOTS }, (_, i) => [i + 1, makeSave(i + 1)]));
    full.map.set(LEGACY_SAVE_KEY, legacy);
    expect(migrateLegacySave(full, NOW)).toEqual({ status: 'no-room' });
    expect(full.map.get(LEGACY_SAVE_KEY)).toBe(legacy);
  });

  it('a copy that does not fit is deferred: the legacy save stays, slot 1 reads and writes it in place', () => {
    const legacyData = { ...legacyWorld(), edits: { '0,0': Array.from({ length: 600 }, (_, i) => (i % 2 ? 3 : 1000 + i)) } };
    const legacy = serializeSave(legacyData);
    expect(legacy.length).toBeGreaterThan(2000);
    // room for the legacy save once, not twice
    const storage = limitedStorage(LEGACY_SAVE_KEY.length + legacy.length + 400, [[LEGACY_SAVE_KEY, legacy]]);
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'deferred', slot: 1, reason: 'quota' });
    expect(storage.map.get(LEGACY_SAVE_KEY)).toBe(legacy);
    expect(storage.map.has(slotKey(1))).toBe(false);
    const info = listSlots(storage)[0];
    expect(info).toMatchObject({ status: 'world', name: 'My World', seed: 99, legacy: true });
    const loaded = loadSlot(1, storage);
    expect(content(loaded)).toBe(content(legacyData));
    expect(loaded.meta.name).toBe('My World');
    // playing it saves in place (the only place it fits)
    expect(saveSlot(1, { ...loaded, day: 7, meta: { ...loaded.meta, lastPlayed: NOW } }, storage).ok).toBe(true);
    expect(deserializeSave(storage.map.get(LEGACY_SAVE_KEY)).day).toBe(7);
    expect(storage.map.has(slotKey(1))).toBe(false);
    expect(renameSlot(1, 'Big Base', storage).ok).toBe(true);
    expect(listSlots(storage)[0]).toMatchObject({ name: 'Big Base', legacy: true });
    // once there is room the move goes through and keeps the name it was given meanwhile
    storage.setItem = (k, v) => storage.map.set(k, String(v));
    expect(migrateLegacySave(storage, NOW + 5)).toEqual({ status: 'migrated', slot: 1 });
    expect(storage.map.has(LEGACY_SAVE_KEY)).toBe(false);
    expect(loadSlot(1, storage)).toMatchObject({ day: 7, meta: { name: 'Big Base', lastPlayed: NOW } });
  });

  it('deleting slot 1 while it is still the legacy save removes the legacy save', () => {
    const storage = fakeStorage([[LEGACY_SAVE_KEY, serializeSave(legacyWorld())]]);
    expect(deleteSlot(1, storage)).toBe(true);
    expect(storage.map.has(LEGACY_SAVE_KEY)).toBe(false);
    expect(listSlots(storage)[0].status).toBe('empty');
  });

  it('a copy that does not read back identical is removed and the legacy save kept', () => {
    const legacy = serializeSave(legacyWorld());
    const storage = fakeStorage([[LEGACY_SAVE_KEY, legacy]]);
    const set = storage.setItem;
    storage.setItem = (k, v) => set(k, k.startsWith('caelancraft:v2:slot:') ? String(v).slice(0, -2) : v);
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'failed', slot: 1, reason: 'verify' });
    expect(storage.map.get(LEGACY_SAVE_KEY)).toBe(legacy);
    expect(storage.map.has(slotKey(1))).toBe(false);
  });

  it('a legacy key that cannot be removed is finished next time without a second copy', () => {
    const legacy = serializeSave(legacyWorld());
    const storage = fakeStorage([[LEGACY_SAVE_KEY, legacy]]);
    const remove = storage.removeItem;
    storage.removeItem = (k) => {
      if (k === LEGACY_SAVE_KEY) throw new Error('nope');
      remove(k);
    };
    expect(migrateLegacySave(storage, NOW)).toEqual({ status: 'migrated', slot: 1, legacyKept: true });
    expect(storage.map.get(LEGACY_SAVE_KEY)).toBe(legacy);
    expect(listSlots(storage).map((s) => s.status)).toEqual(['world', 'empty', 'empty', 'empty', 'empty', 'empty']);
    storage.removeItem = remove;
    expect(migrateLegacySave(storage, NOW + 1)).toEqual({ status: 'migrated', slot: 1 });
    expect(storage.map.has(LEGACY_SAVE_KEY)).toBe(false);
    expect(storage.map.has(slotKey(2))).toBe(false);
  });

  it('a legacy save written again by an old tab after the move is kept as another world, not merged', () => {
    const storage = fakeStorage([[LEGACY_SAVE_KEY, serializeSave(legacyWorld())]]);
    migrateLegacySave(storage, NOW);
    storage.map.set(LEGACY_SAVE_KEY, serializeSave({ ...legacyWorld(), day: 30 }));
    expect(migrateLegacySave(storage, NOW + 1)).toEqual({ status: 'migrated', slot: 2 });
    expect(loadSlot(1, storage).day).toBe(2);
    expect(loadSlot(2, storage).day).toBe(30);
  });
});

// ---------------------------------------------------------------------------------------------
// v0.9 survival fields through the slot API (docs/DESIGN-survival.md §9.6)

/** A Survival world: generation 2, mode survival, a pack, a fire on a campfire cell and a basket. */
function survivalWorld(seed = 50, overrides = {}) {
  // cells (0, 64, 0) and (1, 64, 0) live in chunk 0,0: local index (lq·16 + lr)·128 + y
  const fireLi = (0 * 16 + 0) * 128 + 64;
  const basketLi = (1 * 16 + 0) * 128 + 64;
  return makeSave(seed, {
    edits: { '0,0': [fireLi, BLOCK.CAMPFIRE, basketLi, BLOCK.WICKER_BASKET] },
    gen: 2,
    mode: 'survival',
    survival: {
      health: 90, satiation: 70, hydration: 60, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0, healRate: 0,
      spawn: null, deaths: 0,
      pack: [{ k: 'rock', n: 5 }, ...new Array(PACK_SLOTS - 1).fill(null)],
      wear: [null, null, null],
      fires: { '0,64,0': { s: [{ k: 'raw_pork', t: 3 }, null, null, null, null, null, null], f: 200 } },
    },
    containers: { '1,64,0': { kind: 'basket', slots: [{ k: 'stick', n: 4 }] } },
    ...overrides,
  });
}

/** The four survival fields of a loaded save. */
function survivalFields(save) {
  expect(save).not.toBeNull();
  return { gen: save.gen, mode: save.mode, survival: save.survival, containers: save.containers, version: save.version };
}

describe('save slots: survival worlds (v0.9)', () => {
  it('save, load and list a Survival world: version 3, the fields intact, "mode: survival" on its SlotInfo', () => {
    const world = survivalWorld(50, { meta: { name: 'Wild' } });
    const storage = withWorlds([[2, world], [3, makeSave(3, { meta: { name: 'Builder' } })]]);
    expect(JSON.parse(storage.map.get(slotKey(2))).version).toBe(3);
    const loaded = loadSlot(2, storage);
    expect(loaded.warnings).toEqual([]);
    expect(survivalFields(loaded)).toEqual({
      gen: 2, mode: 'survival', survival: deserializeSave(serializeSave(world)).survival, containers: world.containers, version: 3,
    });
    const slots = listSlots(storage);
    expect(slots[1]).toMatchObject({ status: 'world', name: 'Wild', mode: 'survival' });
    expect(slots[2]).toMatchObject({ status: 'world', name: 'Builder' });
    expect('mode' in slots[2]).toBe(false); // Creative worlds carry no mode
    expect(JSON.parse(storage.map.get(slotKey(3))).version).toBe(2);
  });

  it('the mode is listed from both entry paths (a fresh save, and a rebuild from the text); version-3 slots are indexed damaged', () => {
    const storage = withWorlds([[1, survivalWorld()], [2, makeSave(2)], [3, survivalWorld(51, { mode: 'creative' })]]);
    let index = JSON.parse(storage.map.get(SLOT_INDEX_KEY));
    expect(index.slots[0]).toMatchObject({ damaged: true }); // entryFromData (saveSlot): a version-3 document, never a rich entry
    expect(index.slots[1].mode).toBeUndefined(); // a version-2 Creative world keeps its rich entry
    expect(index.slots[1].name).toBe('World 2');
    expect(index.slots[2]).toMatchObject({ damaged: true }); // gen 2 with a frozen survival state: version 3 as well
    expect(listSlots(storage).map((s) => s.mode)).toEqual(['survival', undefined, undefined, undefined, undefined, undefined]);
    expect(listSlots(storage).map((s) => s.status)).toEqual(['world', 'world', 'world', 'empty', 'empty', 'empty']);
    storage.map.delete(SLOT_INDEX_KEY);
    expect(listSlots(storage).map((s) => s.mode)).toEqual(['survival', undefined, undefined, undefined, undefined, undefined]);
    index = JSON.parse(storage.map.get(SLOT_INDEX_KEY));
    expect(index.slots[0]).toMatchObject({ damaged: true }); // entryFromText (the rebuild) writes the same form
    expect(index.slots[1].name).toBe('World 2');
    // a consistent index is used as is for the version-2 slot (no rewrite)
    const writes = storage.writes;
    expect(listSlots(storage)[1].name).toBe('World 2');
    expect(storage.writes).toBe(writes);
    // an index entry with a mode that is not 'survival' is not trusted: rebuilt from the document
    index.slots[1] = { ...index.slots[1], mode: 'hardcore' };
    storage.map.set(SLOT_INDEX_KEY, JSON.stringify(index));
    expect(listSlots(storage)[1].mode).toBeUndefined();
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[1].mode).toBeUndefined();
  });

  it('a hand-edited Survival mode on generation 1 is listed (and loads) as a Creative world', () => {
    const storage = fakeStorage([[slotKey(1), serializeSave(makeSave(1, { mode: 'survival' }))]]);
    expect(listSlots(storage)[0].mode).toBeUndefined();
    const s = loadSlot(1, storage);
    expect(s.mode).toBe('creative');
    expect(s.warnings).toContain('mode: survival needs generation 2; loaded in Creative');
  });

  it('rename, duplicate and the legacy move keep gen, mode, survival and containers', () => {
    const world = survivalWorld(60, { meta: { name: 'Wild', createdAt: 100, lastPlayed: 200 } });
    const expected = survivalFields(deserializeSave(serializeSave(world)));
    const storage = withWorlds([[3, world]]);
    expect(renameSlot(3, 'Wilder', storage).ok).toBe(true);
    expect(survivalFields(loadSlot(3, storage))).toEqual(expected);
    expect(listSlots(storage)[2]).toMatchObject({ name: 'Wilder', mode: 'survival' });
    expect(duplicateSlot(3, storage, NOW)).toMatchObject({ ok: true, slot: 1, name: 'Wilder (copy)' });
    expect(survivalFields(loadSlot(1, storage))).toEqual(expected);
    expect(listSlots(storage)[0]).toMatchObject({ name: 'Wilder (copy)', mode: 'survival' });
    const legacy = fakeStorage([[LEGACY_SAVE_KEY, serializeSave({ ...world, meta: undefined })]]);
    expect(listSlots(legacy, { repair: false })[0]).toMatchObject({ legacy: true, mode: 'survival' });
    expect(migrateLegacySave(legacy, NOW)).toMatchObject({ status: 'migrated', slot: 1 });
    expect(survivalFields(loadSlot(1, legacy))).toEqual(expected);
  });

  it('a world from a newer generator is damaged: never loaded, renamed or copied, only deleted', () => {
    const raw = JSON.parse(serializeSave(survivalWorld()));
    const newer = JSON.stringify({ ...raw, gen: GEN_LATEST + 1 });
    const storage = fakeStorage([[slotKey(4), newer]]);
    expect(listSlots(storage)[3]).toMatchObject({ status: 'damaged', bytes: newer.length });
    expect(loadSlot(4, storage)).toBeNull();
    expect(renameSlot(4, 'x', storage)).toEqual({ ok: false, reason: 'damaged' });
    expect(duplicateSlot(4, storage, NOW)).toEqual({ ok: false, reason: 'damaged' });
    expect(storage.map.get(slotKey(4))).toBe(newer);
  });

  it('a world an older client called "damaged" in the shared index is checked again and listed as the world it is', () => {
    const text = serializeSave(survivalWorld(70, { meta: { name: 'Newer' } }));
    // what a v0.8 tab writes after listing a version-3 slot it cannot read
    const index = { version: 1, slots: [{ damaged: true, bytes: text.length, hash: textHash(text) }, null, null, null, null, null] };
    const storage = fakeStorage([[slotKey(1), text], [SLOT_INDEX_KEY, JSON.stringify(index)]]);
    expect(listSlots(storage)[0]).toMatchObject({ status: 'world', name: 'Newer', seed: 70, mode: 'survival' });
    // and the index keeps the damaged form for it (§41.1 v0.9): a version-3 world is never indexed as a world an older client
    // would trust — see 'a version-3 save is indexed as damaged' below
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[0]).toEqual({ damaged: true, bytes: text.length, hash: textHash(text) });
    // a truly damaged slot stays damaged, and its (unchanged) index entry is not rewritten
    const junk = fakeStorage([[slotKey(2), '{broken']]);
    listSlots(junk);
    const writes = junk.writes;
    expect(listSlots(junk)[1].status).toBe('damaged');
    expect(junk.writes).toBe(writes);
  });
});

// ---------------------------------------------------------------------------------------------
// Circuits (docs/DESIGN-circuits.md §6.4): the black-holes and circuits switches and the configured parts.

describe('save slots: circuit fields', () => {
  /** A world with both switches off and two configured parts (their blocks recorded in the edits). */
  const circuitWorld = (seed = 80, overrides = {}) => makeSave(seed, {
    // (5, 64, 0) is chunk (0, 0), local index (5·16 + 0)·128 + 64; (−3, 70, 2) is chunk (−1, 0), local (13·16 + 2)·128 + 70
    edits: { '0,0': [(5 * 16) * 128 + 64, BLOCK.KNIFE_SWITCH], '-1,0': [(13 * 16 + 2) * 128 + 70, BLOCK.SPARK_TRANSMITTER] },
    blackholes: false,
    circuits: false,
    circuitParts: { '5,64,0': { k: 'switch', on: true }, '-3,70,2': { k: 'tx', l: 'Gate', ch: 7 } },
    ...overrides,
  });
  /** The three circuit fields of a loaded save. */
  const circuitFields = (save) => {
    expect(save).not.toBeNull();
    return { blackholes: save.blackholes, circuits: save.circuits, circuitParts: save.circuitParts };
  };

  it('save and load keep them; a world without them stays version 2 and byte-identical', () => {
    const storage = withWorlds([[1, circuitWorld()], [2, makeSave(2)]]);
    expect(circuitFields(loadSlot(1, storage))).toEqual({
      blackholes: false, circuits: false, circuitParts: { '-3,70,2': { k: 'tx', l: 'Gate', ch: 7 }, '5,64,0': { k: 'switch', on: true } },
    });
    expect(loadSlot(1, storage).version).toBe(SAVE_VERSION);
    expect(storage.map.get(slotKey(2))).toBe(serializeSave(makeSave(2)));
    expect(storage.map.get(slotKey(2))).not.toContain('circuit');
  });

  it('rename, duplicate and the legacy move keep blackholes, circuits and circuitParts', () => {
    const world = circuitWorld(81, { meta: { name: 'Wired', createdAt: 100, lastPlayed: 200 } });
    const expected = circuitFields(deserializeSave(serializeSave(world)));
    expect(expected.circuitParts).toBeDefined();
    const storage = withWorlds([[3, world]]);
    expect(renameSlot(3, 'Rewired', storage).ok).toBe(true);
    expect(circuitFields(loadSlot(3, storage))).toEqual(expected);
    expect(duplicateSlot(3, storage, NOW)).toMatchObject({ ok: true, slot: 1, name: 'Rewired (copy)' });
    expect(circuitFields(loadSlot(1, storage))).toEqual(expected);
    const legacy = fakeStorage([[LEGACY_SAVE_KEY, serializeSave({ ...world, meta: undefined })]]);
    expect(migrateLegacySave(legacy, NOW)).toMatchObject({ status: 'migrated', slot: 1 });
    expect(circuitFields(loadSlot(1, legacy))).toEqual(expected);
  });
});

describe('a version-3 save seen by an older client through the shared slot index (§42, DESIGN-survival §1.4)', () => {
  /** v0.8's index-entry trust rule, as src/storage.js@24b63f9 had it (validIndexEntry + listSlots): any well-formed rich entry
   *  whose bytes and hash match the slot text is listed as a WORLD without parsing the document. */
  function v08TrustsAsWorld(entry, text) {
    if (!entry || typeof entry !== 'object') return false;
    const { bytes, hash } = entry;
    if (!Number.isInteger(bytes) || bytes <= 0 || !Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) return false;
    if (entry.damaged === true) return false; // v0.8 shows the slot as damaged: what §42 wants
    if (typeof entry.name !== 'string' || entry.name === '' || typeof entry.seed !== 'number') return false;
    return bytes === text.length && hash === textHash(text);
  }

  it('a version-3 save is indexed as damaged, so a v0.8 client never lists it as a world it could overwrite (play-test: its ?autoplay boot saved a fresh gen-1 world over it)', () => {
    const storage = fakeStorage();
    const world = survivalWorld(42, { meta: { name: 'My survival world' } });
    expect(saveSlot(1, world, storage).ok).toBe(true);
    const text = storage.map.get(slotKey(1));
    expect(JSON.parse(text).version).toBe(3);
    const entry = JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[0];
    expect(entry).toEqual({ damaged: true, bytes: text.length, hash: textHash(text) });
    expect(v08TrustsAsWorld(entry, text)).toBe(false);
    // this client still lists it as the Survival world it is (a damaged entry is always parsed again, §41.1)
    expect(listSlots(storage)[0]).toMatchObject({ status: 'world', name: 'My survival world', seed: 42, mode: 'survival' });
    // and a listing does not "repair" the entry back into a rich one
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[0]).toEqual(entry);
    // rename and duplicate keep the rule
    expect(renameSlot(1, 'Renamed', storage).ok).toBe(true);
    expect(JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[0].damaged).toBe(true);
    expect(duplicateSlot(1, storage, NOW).ok).toBe(true);
    const copy = JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[1];
    expect(copy.damaged).toBe(true);
    expect(listSlots(storage)[1]).toMatchObject({ status: 'world', name: 'Renamed (copy)', mode: 'survival' });
  });

  it('a version-2 (Creative, generation 1) save keeps its rich entry, byte for byte as before', () => {
    const storage = fakeStorage();
    expect(saveSlot(2, makeSave(2, { meta: { name: 'Builder', createdAt: 5, lastPlayed: 6 } }), storage).ok).toBe(true);
    const text = storage.map.get(slotKey(2));
    expect(JSON.parse(text).version).toBe(2);
    const entry = JSON.parse(storage.map.get(SLOT_INDEX_KEY)).slots[1];
    expect(entry).toEqual({ name: 'Builder', seed: 2, createdAt: 5, lastPlayed: 6, bytes: text.length, hash: textHash(text) });
    expect(v08TrustsAsWorld(entry, text)).toBe(true);
  });
});
