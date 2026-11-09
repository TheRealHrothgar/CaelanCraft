// Unit tests for src/circuitStore.js — the circuit side table (DESIGN-circuits §4.8, §6.2.2, §6.4; package B): kinds and
// defaults, pristine entries (free, never saved), normalisation and clamps, the JSON form and its canonical order, the cap,
// the orphan check against the repaired edits (one per-chunk map, never a per-entry scan), replaceAll and export.
import { describe, it, expect } from 'vitest';
import {
  MAX_CIRCUIT_PARTS, MAX_PART_LABEL_CHARS, TIMER_MIN_S, TIMER_MAX_S, RADIO_CHANNELS, BATTERY_CAPACITY, CHUNK_SIZE, WORLD_HEIGHT,
} from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { PARTS, partByKey } from '../../src/circuitParts.js';
import { localIndex } from '../../src/coords.js';
import {
  CircuitStore, PART_FIELDS, defaultPart, normalizePart, normalizePartsJSON, partKey, parsePartKey, partToJSON,
  validatePartsJSON,
} from '../../src/circuitStore.js';

const B = BLOCK;

/** An EditsJSON holding block `id` at each of the cells. */
function editsWith(cells) {
  /** @type {Record<string, number[]>} */
  const edits = {};
  for (const [q, y, r, id] of cells) {
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const key = `${cq},${cr}`;
    (edits[key] ??= []).push(localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE), id);
  }
  return edits;
}

describe('keys', () => {
  it('partKey / parsePartKey round-trip strictly, negatives included', () => {
    expect(partKey(3, 11, -4)).toBe('3,11,-4');
    expect(parsePartKey('3,11,-4')).toEqual([3, 11, -4]);
    expect(parsePartKey('-17,0,-1')).toEqual([-17, 0, -1]);
    expect(parsePartKey('01,2,3')).toEqual([1, 2, 3]);
    expect(Object.is(parsePartKey('-0,2,-0')[0], 0)).toBe(true);
    for (const bad of ['', '1,2', '1,2,3,4', '1, 2, 3', 'a,b,c', '1.5,2,3', `1,${WORLD_HEIGHT},3`, '1,-1,3', '1e3,2,3',
      '99999999999999999999,2,3', null, undefined]) {
      expect(parsePartKey(/** @type {*} */ (bad)), String(bad)).toBeNull();
    }
  });
});

describe('kinds, defaults and normalisation', () => {
  it('defaultPart gives each kind its §4.8 fields in canonical order; kinds without fields have none', () => {
    expect(defaultPart('switch')).toEqual({ k: 'switch', l: '', on: false });
    expect(defaultPart('button')).toEqual({ k: 'button', l: '', nc: false });
    expect(defaultPart('timer')).toEqual({ k: 'timer', l: '', on: false, f: 3, s: 5, m: 'pulse', run: false });
    expect(Object.keys(defaultPart('timer'))).toEqual(['k', 'l', 'on', 'f', 's', 'm', 'run']);
    expect(defaultPart('relay')).toEqual({ k: 'relay', l: '', nc: false, f: 3 });
    expect(defaultPart('tx')).toEqual({ k: 'tx', l: '', ch: 1 });
    expect(defaultPart('rx')).toEqual({ k: 'rx', l: '', on: false, f: 3, m: 'pulse', ch: 1 });
    expect(defaultPart('battery')).toEqual({ k: 'battery', l: '', c: BATTERY_CAPACITY });
    for (const k of ['terminal', 'blaster', 'selenium', 'igniter', 'lamp', 'bell', 'charge']) expect(defaultPart(k)).toEqual({ k, l: '' });
    for (const k of ['copper_wire', 'brown_wire', 'white_wire', 'earth_wire', 'fuse', 'torch', 'keg', 'campfire', 'nope', '']) {
      expect(defaultPart(k), k).toBeNull();
    }
    // Every kind's fields are exactly its PartDef.fields, which only name store fields.
    for (const p of Object.values(PARTS)) {
      for (const f of p.fields) expect(PART_FIELDS).toContain(f);
      const d = defaultPart(p.key);
      if (p.fields.length > 0 && partByKey(p.key)) expect(Object.keys(d).slice(1).sort()).toEqual([...p.fields].sort());
    }
  });

  it('normalizePart clamps and rounds every field, drops fields the kind lacks and reports invalid ones', () => {
    /** @type {string[]} */
    const bad = [];
    const t = normalizePart('timer', { s: 7.3, f: 9, m: 'repeat', run: true, on: 'yes', nc: true, ch: 4, junk: 1, l: '  Front door  ' }, (f) => bad.push(f));
    expect(t).toEqual({ k: 'timer', l: 'Front door', on: false, f: 6, s: 7.5, m: 'repeat', run: true });
    expect(bad).toEqual(['on']);
    expect(normalizePart('timer', { s: 0 }).s).toBe(TIMER_MIN_S);
    expect(normalizePart('timer', { s: 0.74 }).s).toBe(0.5);
    expect(normalizePart('timer', { s: 0.76 }).s).toBe(1);
    expect(normalizePart('timer', { s: 1e9 }).s).toBe(TIMER_MAX_S);
    expect(normalizePart('timer', { s: -3 }).s).toBe(TIMER_MIN_S);
    expect(normalizePart('timer', { f: -2 }).f).toBe(0);
    expect(normalizePart('timer', { f: 2.6 }).f).toBe(3);
    expect(normalizePart('tx', { ch: 0 }).ch).toBe(1);
    expect(normalizePart('tx', { ch: 99 }).ch).toBe(RADIO_CHANNELS);
    expect(normalizePart('tx', { ch: 7.4 }).ch).toBe(7);
    expect(normalizePart('battery', { c: -5 }).c).toBe(0);
    expect(normalizePart('battery', { c: 1e9 }).c).toBe(BATTERY_CAPACITY);
    expect(normalizePart('battery', { c: 12.6 }).c).toBe(13);
    // m per kind: a receiver takes pulse / latch, a timer pulse / hold / repeat.
    expect(normalizePart('rx', { m: 'latch' }).m).toBe('latch');
    const rxBad = [];
    expect(normalizePart('rx', { m: 'hold' }, (f) => rxBad.push(f)).m).toBe('pulse');
    expect(rxBad).toEqual(['m']);
    expect(normalizePart('timer', { m: 'latch' }).m).toBe('pulse');
    // nc exists only on buttons and relays
    expect(normalizePart('button', { nc: true })).toEqual({ k: 'button', l: '', nc: true });
    expect(normalizePart('relay', { nc: true }).nc).toBe(true);
    expect('nc' in normalizePart('switch', { nc: true })).toBe(false);
    expect('nc' in normalizePart('timer', { nc: true })).toBe(false);
    // labels: trimmed, at most MAX_PART_LABEL_CHARS
    expect(normalizePart('lamp', { l: 'x'.repeat(40) }).l).toBe('x'.repeat(MAX_PART_LABEL_CHARS));
    expect(normalizePart('lamp', { l: '   ' }).l).toBe('');
    const lb = [];
    expect(normalizePart('lamp', { l: 42 }, (f) => lb.push(f)).l).toBe('');
    expect(lb).toEqual(['l']);
    // non-finite numbers and wrong types are invalid
    const inv = [];
    normalizePart('battery', { c: NaN }, (f) => inv.push(f));
    normalizePart('battery', { c: '50' }, (f) => inv.push(f));
    normalizePart('timer', { s: Infinity }, (f) => inv.push(f));
    expect(inv).toEqual(['c', 'c', 's']);
    expect(normalizePart('nope', {})).toBeNull();
    expect(normalizePart('copper_wire', {})).toBeNull();
    expect(normalizePart('switch', null)).toEqual({ k: 'switch', l: '', on: false });
  });

  it('partToJSON writes k and the non-default fields in canonical order; pristine → null', () => {
    expect(partToJSON({ k: 'switch', l: '', on: false })).toBeNull();
    expect(partToJSON({ k: 'switch', l: '', on: true })).toEqual({ k: 'switch', on: true });
    const j = partToJSON({ k: 'rx', l: 'Gate', on: true, f: 4, m: 'latch', ch: 3 });
    expect(Object.keys(j)).toEqual(['k', 'l', 'on', 'f', 'm', 'ch']);
    expect(partToJSON({ k: 'battery', l: '', c: 1234.6 })).toEqual({ k: 'battery', c: 1235 });
    expect(partToJSON({ k: 'battery', l: '', c: BATTERY_CAPACITY - 0.2 })).toBeNull(); // rounds to full
    expect(partToJSON({ k: 'timer', l: '', on: false, f: 3, s: 10, m: 'pulse', run: false })).toEqual({ k: 'timer', s: 10 });
    expect(partToJSON({ k: 'nope' })).toBeNull();
    expect(partToJSON(null)).toBeNull();
  });
});

describe('normalizePartsJSON and validatePartsJSON (§6.4)', () => {
  it('canonical keys (last write wins), pristine dropped, every repair warned once, sorted', () => {
    const { parts, warnings } = normalizePartsJSON({
      '5,11,0': { k: 'switch', on: true },
      '01,11,0': { k: 'relay', nc: true, f: 'x' },
      '1,11,0': { k: 'relay', nc: true, f: 5 },
      '2,11,0': { k: 'switch' },
      '3,11,0': { k: 'flux' },
      '4,11,0': 'nope',
      'a,b,c': { k: 'switch', on: true },
      '-3,11,2': { k: 'timer', s: 30, m: 'repeat', run: true },
    });
    expect(Object.keys(parts)).toEqual(['-3,11,2', '1,11,0', '5,11,0']);
    expect(parts['1,11,0']).toEqual({ k: 'relay', nc: true, f: 5 });
    expect(parts['-3,11,2']).toEqual({ k: 'timer', s: 30, m: 'repeat', run: true });
    expect(warnings).toContain('circuitParts["a,b,c"]: not a cell key, dropped');
    expect(warnings).toContain('circuitParts[3,11,0]: unknown kind "flux", dropped');
    expect(warnings).toContain('circuitParts[1,11,0].f: invalid, reset');
    expect(warnings).toContain('circuitParts[4,11,0]: not an object, dropped');
    expect(normalizePartsJSON([]).warnings).toEqual(['circuitParts: not an object, ignored']);
    expect(normalizePartsJSON(null)).toEqual({ parts: {}, warnings: [] });
    expect(normalizePartsJSON({ '1,2,3': { k: 'keg' } }).warnings).toEqual(['circuitParts[1,2,3]: unknown kind "keg", dropped']);
  });

  it('cuts beyond the cap in key order with one warning', () => {
    /** @type {Record<string, *>} */
    const json = {};
    for (let i = 0; i < 12; i++) json[`${11 - i},5,0`] = { k: 'switch', on: true };
    const { parts, warnings } = normalizePartsJSON(json, 10);
    expect(Object.keys(parts).length).toBe(10);
    expect(Object.keys(parts)[0]).toBe('0,5,0');
    expect(parts['11,5,0']).toBeUndefined();
    expect(warnings).toEqual(['circuitParts: more than 10 entries, the rest dropped']);
    const big = {};
    for (let i = 0; i <= MAX_CIRCUIT_PARTS; i++) big[`${i},5,0`] = { k: 'switch', on: true };
    expect(normalizePartsJSON(big).warnings).toEqual([`circuitParts: more than ${MAX_CIRCUIT_PARTS} entries, the rest dropped`]);
  });

  it('validatePartsJSON drops orphans and wrong kinds against the repaired edits', () => {
    const edits = editsWith([[1, 11, 0, B.KNIFE_SWITCH], [-20, 11, 5, B.RELAY], [3, 11, 0, B.STONE], [40, 11, -40, B.CLOCKWORK_TIMER]]);
    const { parts, warnings } = validatePartsJSON({
      '1,11,0': { k: 'switch', on: true },
      '-20,11,5': { k: 'relay', nc: true },
      '3,11,0': { k: 'switch', on: true }, // stone there
      '2,11,0': { k: 'switch', on: true }, // nothing there
      '40,11,-40': { k: 'relay', nc: true }, // a timer there, not a relay
    }, edits);
    expect(Object.keys(parts).sort()).toEqual(['-20,11,5', '1,11,0']);
    expect(warnings).toEqual(expect.arrayContaining([
      'circuitParts[3,11,0]: no switch there, dropped',
      'circuitParts[2,11,0]: no switch there, dropped',
      'circuitParts[40,11,-40]: no relay there, dropped',
    ]));
    expect(validatePartsJSON({ '1,11,0': { k: 'switch', on: true } }, null).parts).toEqual({});
  });

  it('validatePartsJSON builds ONE lookup per chunk from the edits (no per-entry scan), or reuses perChunk without reading edits', () => {
    const cells = [];
    for (let i = 0; i < 200; i++) cells.push([i % 16, 11 + Math.floor(i / 16), 0, B.KNIFE_SWITCH]);
    const edits = editsWith(cells);
    const arr = edits['0,0'];
    let reads = 0;
    const spied = {
      '0,0': new Proxy(arr, {
        get(target, prop) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
          return Reflect.get(target, prop);
        },
      }),
    };
    /** @type {Record<string, *>} */
    const json = {};
    for (const [q, y, r] of cells) json[`${q},${y},${r}`] = { k: 'switch', on: true };
    const { parts } = validatePartsJSON(json, spied);
    expect(Object.keys(parts).length).toBe(200);
    expect(reads).toBe(arr.length); // each element read once in all: the chunk's map is built once
    // perChunk given: edits are never touched.
    const perChunk = new Map([['0,0', new Map(cells.map(([q, y, r, id]) => [localIndex(q, y, r), id]))]]);
    const throwing = new Proxy({}, { get() { throw new Error('edits must not be read'); } });
    expect(Object.keys(validatePartsJSON(json, /** @type {*} */ (throwing), perChunk).parts).length).toBe(200);
  });
});

describe('CircuitStore', () => {
  it('ensure makes a free pristine entry; set changes it; pristine entries are neither counted nor saved', () => {
    const s = new CircuitStore();
    const e = s.ensure(1, 11, 0, 'switch');
    expect(e).toMatchObject({ key: '1,11,0', q: 1, y: 11, r: 0, k: 'switch', l: '', on: false });
    expect(s.size).toBe(0);
    expect(s.version).toBe(0);
    expect(s.export()).toEqual({});
    expect(s.ensure(1, 11, 0, 'switch')).toBe(e);
    const set = s.set(1, 11, 0, 'switch', { on: true });
    expect(set).toBe(e); // updated in place
    expect(e.on).toBe(true);
    expect(s.size).toBe(1);
    expect(s.version).toBe(1);
    expect(s.export()).toEqual({ '1,11,0': { k: 'switch', on: true } });
    s.set(1, 11, 0, 'switch', { on: true }); // no change: no bump
    expect(s.version).toBe(1);
    s.set(1, 11, 0, 'switch', { on: false });
    expect(s.size).toBe(0);
    expect(s.version).toBe(2);
    expect(s.get('1,11,0')).toBe(e);
    expect(s.ensure(1, 11, 0, 'nope')).toBeNull();
    expect(s.ensure(2, 11, 0, 'copper_wire')).toBeNull();
  });

  it('set merges only the defined fields, normalises, and replaces an entry of another kind', () => {
    const s = new CircuitStore();
    s.set(0, 5, 0, 'timer', { s: 30, m: 'hold' });
    s.set(0, 5, 0, 'timer', { s: undefined, f: 1 });
    expect(s.get('0,5,0')).toMatchObject({ s: 30, m: 'hold', f: 1 });
    s.set(0, 5, 0, 'relay', { nc: true });
    expect(s.get('0,5,0')).toEqual({ key: '0,5,0', q: 0, y: 5, r: 0, k: 'relay', l: '', nc: true, f: 3 });
    expect(s.size).toBe(1);
    expect(s.set(0, 5, 0, 'copper_wire', {})).toBeNull();
  });

  it('caps saved entries at max: a new non-pristine entry past it is refused, edits of stored ones and pristine ones are not', () => {
    const s = new CircuitStore(3);
    for (let i = 0; i < 3; i++) expect(s.set(i, 5, 0, 'switch', { on: true })).not.toBeNull();
    expect(s.set(9, 5, 0, 'switch', { on: true })).toBeNull();
    expect(s.get('9,5,0')).toBeUndefined();
    expect(s.ensure(9, 5, 0, 'switch')).not.toBeNull(); // pristine is free
    expect(s.set(9, 5, 0, 'switch', { on: true })).toBeNull();
    expect(s.set(0, 5, 0, 'switch', { l: 'still fine' })).not.toBeNull();
    s.set(1, 5, 0, 'switch', { on: false }); // back to pristine: frees a slot
    expect(s.size).toBe(2);
    expect(s.set(9, 5, 0, 'switch', { on: true })).not.toBeNull();
    expect(new CircuitStore().max).toBe(MAX_CIRCUIT_PARTS);
  });

  it('delete, clear, replaceAll (version 0) and a sorted export', () => {
    const s = new CircuitStore();
    s.set(5, 5, 5, 'lamp', { l: 'Porch' });
    s.set(-5, 5, 5, 'lamp', { l: 'Hall' });
    s.set(0, 5, 0, 'tx', { ch: 7 });
    expect(Object.keys(s.export())).toEqual(['-5,5,5', '0,5,0', '5,5,5']);
    const v = s.version;
    expect(s.delete('0,5,0')).toBe(true);
    expect(s.delete('0,5,0')).toBe(false);
    expect(s.version).toBe(v + 1);
    const json = s.export();
    const t = new CircuitStore();
    t.set(1, 1, 1, 'switch', { on: true });
    expect(t.replaceAll(json)).toEqual([]);
    expect(t.version).toBe(0);
    expect(t.export()).toEqual(json);
    expect(t.get('1,1,1')).toBeUndefined();
    expect(t.get('-5,5,5')).toMatchObject({ q: -5, y: 5, r: 5, k: 'lamp', l: 'Hall' });
    expect(t.replaceAll({ 'x': {} })).toEqual(['circuitParts["x"]: not a cell key, dropped']);
    expect(t.size).toBe(0);
    t.set(1, 1, 1, 'switch', { on: true });
    t.clear();
    expect(t.size).toBe(0);
    expect(t.export()).toEqual({});
    expect(t.replaceAll(null)).toEqual([]);
    expect(t.list()).toEqual([]);
  });

  it('setCharge drains in place: fractional in memory, a version bump only on whole percents, whole amp-seconds when saved', () => {
    const s = new CircuitStore();
    expect(s.setCharge(0, 5, 0, BATTERY_CAPACITY - 0.05)).toBe(true);
    const e = s.get('0,5,0');
    expect(e.c).toBeCloseTo(BATTERY_CAPACITY - 0.05, 9);
    expect(s.version).toBe(1); // 100 % → 99 %
    let v = s.version;
    for (let i = 0; i < 100; i++) s.setCharge(0, 5, 0, e.c - 0.05);
    expect(s.version).toBe(v); // 5 amp-seconds is not a whole percent of 3600
    s.setCharge(0, 5, 0, BATTERY_CAPACITY * 0.98 - 1);
    expect(s.version).toBe(v + 1);
    v = s.version;
    expect(s.export()['0,5,0'].c).toBe(Math.round(e.c));
    s.setCharge(0, 5, 0, BATTERY_CAPACITY);
    expect(s.size).toBe(0);
    expect(s.version).toBe(v + 1);
    s.setCharge(0, 5, 0, -10);
    expect(e.c).toBe(0);
    const capped = new CircuitStore(0);
    expect(capped.setCharge(1, 1, 1, 100)).toBe(false);
    expect(capped.get('1,1,1')?.c ?? BATTERY_CAPACITY).toBe(BATTERY_CAPACITY);
  });
});
