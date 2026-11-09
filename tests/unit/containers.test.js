// Unit tests for src/containers.js — wicker baskets and "Your Belongings" (docs/DESIGN-survival.md §5.6, §2.5, §9.6).
import { describe, it, expect } from 'vitest';
import { BASKET_SLOTS, REMAINS_SLOTS, MAX_CONTAINERS, PACK_SLOTS } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { Containers, CONTAINER_KINDS, containerKey, parseContainerKey } from '../../src/containers.js';
import { Pack } from '../../src/inventory.js';
import { mulberry32 } from '../../src/noise.js';

const B = BLOCK;
/** A basket entry at (q, y, r) holding the given { slot: stack }. */
function withBasket(c, q, y, r, slots = {}) {
  c.onBlockChange(q, y, r, B.AIR, B.WICKER_BASKET);
  const e = c.get(q, y, r);
  for (const [i, s] of Object.entries(slots)) e.slots[Number(i)] = s;
  return e;
}

describe('keys', () => {
  it('containerKey / parseContainerKey round-trip, negatives included', () => {
    expect(containerKey(-3, 60, 12)).toBe('-3,60,12');
    expect(parseContainerKey('-3,60,12')).toEqual([-3, 60, 12]);
    for (const bad of ['', '1,2', '1,2,3,4', 'a,b,c', '1.5,2,3', ' 1,2,3', '1,2,3 ', null, 5, '+1,2,3', '1e3,2,3']) {
      expect(parseContainerKey(bad)).toBe(null);
    }
  });

  it('CONTAINER_KINDS: basket 18 slots on WICKER_BASKET, remains 30 on REMAINS', () => {
    expect(CONTAINER_KINDS.basket).toEqual({ block: B.WICKER_BASKET, slots: BASKET_SLOTS, title: 'Wicker Basket' });
    expect(CONTAINER_KINDS.remains).toEqual({ block: B.REMAINS, slots: REMAINS_SLOTS, title: 'Your Belongings' });
    expect(BASKET_SLOTS).toBe(18);
    expect(REMAINS_SLOTS).toBe(30);
    expect(Containers.title('basket')).toBe('Wicker Basket');
    expect(Containers.title('remains')).toBe('Your Belongings');
    expect(Containers.title('nope')).toBe('?');
  });
});

describe('baskets', () => {
  it('placing a basket creates an empty 18-slot entry', () => {
    const c = new Containers();
    expect(c.onBlockChange(1, 64, -2, B.AIR, B.WICKER_BASKET)).toEqual([]);
    const e = c.get(1, 64, -2);
    expect(e.kind).toBe('basket');
    expect([e.q, e.y, e.r]).toEqual([1, 64, -2]);
    expect(e.slots).toEqual(new Array(18).fill(null));
    expect(c.size).toBe(1);
    expect(c.hasItems(1, 64, -2)).toBe(false);
    expect(c.version).toBe(1);
  });

  it('changing the cell to anything else releases its stacks and removes the entry', () => {
    const c = new Containers();
    withBasket(c, 0, 60, 0, { 2: { k: 'rock', n: 5 }, 9: { k: 'flint_axe', n: 1, d: 3 } });
    expect(c.hasItems(0, 60, 0)).toBe(true);
    expect(c.contents(0, 60, 0)).toEqual([{ k: 'rock', n: 5 }, { k: 'flint_axe', n: 1, d: 3 }]);
    const released = c.onBlockChange(0, 60, 0, B.WICKER_BASKET, B.AIR);
    expect(released).toEqual([{ k: 'rock', n: 5 }, { k: 'flint_axe', n: 1, d: 3 }]);
    expect(c.get(0, 60, 0)).toBe(null);
    expect(c.size).toBe(0);
    expect(c.hasItems(0, 60, 0)).toBe(false);
    expect(c.contents(0, 60, 0)).toEqual([]);
  });

  it('water flowing in, a blast or a command (any next id) releases the same way', () => {
    for (const next of [B.WATER, B.WATER_FLOW_3, B.STONE, B.REMAINS, B.BLACK_HOLE]) {
      const c = new Containers();
      withBasket(c, 5, 5, 5, { 0: { k: 'stick', n: 1 } });
      expect(c.onBlockChange(5, 5, 5, B.WICKER_BASKET, next)).toEqual([{ k: 'stick', n: 1 }]);
      expect(c.get(5, 5, 5)).toBe(null);
    }
  });

  it('writes elsewhere and same-id writes are ignored', () => {
    const c = new Containers();
    withBasket(c, 0, 60, 0, { 0: { k: 'rock', n: 1 } });
    const v = c.version;
    expect(c.onBlockChange(0, 61, 0, B.AIR, B.STONE)).toEqual([]);
    expect(c.onBlockChange(0, 60, 0, B.WICKER_BASKET, B.WICKER_BASKET)).toEqual([]);
    expect(c.version).toBe(v);
    expect(c.hasItems(0, 60, 0)).toBe(true);
  });

  it('at MAX_CONTAINERS a new basket gets no storage', () => {
    expect(MAX_CONTAINERS).toBe(1024);
    const c = new Containers();
    for (let i = 0; i < MAX_CONTAINERS; i++) c.onBlockChange(i, 60, 0, B.AIR, B.WICKER_BASKET);
    expect(c.size).toBe(MAX_CONTAINERS);
    c.onBlockChange(-1, 60, 0, B.AIR, B.WICKER_BASKET);
    expect(c.get(-1, 60, 0)).toBe(null);
    expect(c.ensureBasket(-1, 60, 0)).toBe(null);
    // freeing one makes room again
    c.onBlockChange(0, 60, 0, B.WICKER_BASKET, B.AIR);
    expect(c.ensureBasket(-1, 60, 0)).not.toBe(null);
  });

  it('ensureBasket returns the existing basket, makes a missing one, and never replaces belongings', () => {
    const c = new Containers();
    const e = withBasket(c, 1, 1, 1);
    expect(c.ensureBasket(1, 1, 1)).toBe(e);
    const made = c.ensureBasket(2, 2, 2);
    expect(made.kind).toBe('basket');
    expect(made.slots.length).toBe(18);
    c.addRemains(3, 3, 3, [{ k: 'rock', n: 1 }]);
    expect(c.ensureBasket(3, 3, 3)).toBe(null);
    expect(c.get(3, 3, 3).kind).toBe('remains');
  });

  it('a basket placed over a cell that held belongings releases them first', () => {
    const c = new Containers();
    c.addRemains(0, 0, 0, [{ k: 'rock', n: 2 }]);
    expect(c.onBlockChange(0, 0, 0, B.REMAINS, B.WICKER_BASKET)).toEqual([{ k: 'rock', n: 2 }]);
    expect(c.get(0, 0, 0).kind).toBe('basket');
  });

  it('touch bumps the version after in-place slot edits; clear empties', () => {
    const c = new Containers();
    withBasket(c, 0, 0, 0);
    const v = c.version;
    c.touch();
    expect(c.version).toBe(v + 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.version).toBe(v + 2);
    c.clear();
    expect(c.version).toBe(v + 2);
  });
});

describe('belongings', () => {
  it('addRemains makes a REMAINS entry beyond the cap', () => {
    const c = new Containers();
    for (let i = 0; i < MAX_CONTAINERS; i++) c.onBlockChange(i, 60, 0, B.AIR, B.WICKER_BASKET);
    const stacks = [{ k: 'rock', n: 3 }, { k: 'straw_hat', n: 1 }];
    expect(c.addRemains(-9, 61, 4, stacks)).toEqual([]);
    expect(c.size).toBe(MAX_CONTAINERS + 1);
    const e = c.get(-9, 61, 4);
    expect(e.kind).toBe('remains');
    expect(e.slots).toEqual(stacks);
    expect(e.slots[0]).not.toBe(stacks[0]); // copies
  });

  it('keeps at most REMAINS_SLOTS stacks; the rest (and an old entry there) come back', () => {
    const c = new Containers();
    const many = Array.from({ length: 32 }, (_, i) => ({ k: 'rock', n: i + 1 }));
    const lost = c.addRemains(0, 0, 0, many);
    expect(c.get(0, 0, 0).slots.length).toBe(30);
    expect(lost).toEqual([{ k: 'rock', n: 31 }, { k: 'rock', n: 32 }]);
    expect(c.addRemains(0, 0, 0, [null, { k: 'flint', n: 1 }])).toEqual(many.slice(0, 30)); // the old entry's stacks
    expect(c.get(0, 0, 0).slots).toEqual([{ k: 'flint', n: 1 }]);
    withBasket(c, 1, 1, 1, { 4: { k: 'stick', n: 6 } });
    expect(c.addRemains(1, 1, 1, [{ k: 'rock', n: 1 }])).toEqual([{ k: 'stick', n: 6 }]);
  });

  it('a full death (27 + 3 stacks) fits', () => {
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'rock', n: i + 1 };
    p.wear = [{ k: 'straw_hat', n: 1 }, { k: 'leather_coat', n: 1 }, { k: 'hide_shoes', n: 1 }];
    const c = new Containers();
    expect(c.addRemains(0, 60, 0, p.dumpAll())).toEqual([]);
    expect(c.get(0, 60, 0).slots.length).toBe(30);
  });

  it('takeAll moves what fits into the pack and leaves the overflow inside', () => {
    const c = new Containers();
    c.addRemains(2, 62, -3, [{ k: 'rock', n: 50 }, { k: 'flint_axe', n: 1, d: 7 }, { k: 'rock', n: 10 }, { k: 'stick', n: 64 }]);
    const p = new Pack();
    for (let i = 2; i < PACK_SLOTS; i++) p.slots[i] = { k: 'cord', n: 32 };
    p.slots[0] = { k: 'rock', n: 60 };
    const res = c.takeAll(2, 62, -3, p);
    // rock: 4 merge into slot 0, 46 into slot 1 (the only empty one) → the axe and the sticks find no room
    expect(res.moved).toEqual([{ k: 'rock', n: 60 }]);
    expect(res.empty).toBe(false);
    expect(c.get(2, 62, -3).slots).toEqual([null, { k: 'flint_axe', n: 1, d: 7 }, null, { k: 'stick', n: 64 }]);
    expect(p.slots[0]).toEqual({ k: 'rock', n: 64 });
    expect(p.slots[1]).toEqual({ k: 'rock', n: 56 });
    // with room, everything comes out and the entry reports empty (main then writes AIR)
    p.slots.fill(null);
    const res2 = c.takeAll(2, 62, -3, p);
    expect(res2.moved).toEqual([{ k: 'flint_axe', n: 1, d: 7 }, { k: 'stick', n: 64 }]);
    expect(res2.empty).toBe(true);
    expect(c.hasItems(2, 62, -3)).toBe(false);
    // and writing AIR removes the empty entry, releasing nothing
    expect(c.onBlockChange(2, 62, -3, B.REMAINS, B.AIR)).toEqual([]);
    expect(c.size).toBe(0);
  });

  it('takeAll on a cell with no entry reports empty and moves nothing', () => {
    const c = new Containers();
    expect(c.takeAll(0, 0, 0, new Pack())).toEqual({ moved: [], empty: true });
  });

  it('takeAll with a completely full pack changes nothing', () => {
    const c = new Containers();
    c.addRemains(0, 0, 0, [{ k: 'flint', n: 3 }]);
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'cord', n: 32 };
    const v = c.version;
    expect(c.takeAll(0, 0, 0, p)).toEqual({ moved: [], empty: false });
    expect(c.version).toBe(v);
  });

  it('breaking belongings releases everything (main gives it to the pack)', () => {
    const c = new Containers();
    c.addRemains(0, 0, 0, [{ k: 'rock', n: 1 }, { k: 'flint', n: 2 }]);
    expect(c.onBlockChange(0, 0, 0, B.REMAINS, B.AIR)).toEqual([{ k: 'rock', n: 1 }, { k: 'flint', n: 2 }]);
  });
});

describe('spoilage in containers (§4.5)', () => {
  it('spoils perishable stacks in loaded entries only', () => {
    const c = new Containers();
    withBasket(c, 0, 60, 0, { 0: { k: 'raw_pork', n: 4 }, 1: { k: 'rock', n: 9 } });
    withBasket(c, 1000, 60, 0, { 0: { k: 'raw_pork', n: 4 } });
    c.addRemains(5, 60, 5, [{ k: 'honeyberries', n: 3 }, { k: 'salted_pork', n: 2 }]);
    let calls = 0;
    const v = c.version;
    const out = c.spoil(1, () => {
      calls++;
      return 0;
    }, (q, _r) => q < 500);
    expect(calls).toBe(2); // raw pork in the loaded basket, honeyberries in the belongings
    expect(out).toEqual([{ k: 'raw_pork', n: 1 }, { k: 'honeyberries', n: 1 }]);
    expect(c.get(0, 60, 0).slots[0]).toEqual({ k: 'raw_pork', n: 3 });
    expect(c.get(1000, 60, 0).slots[0]).toEqual({ k: 'raw_pork', n: 4 });
    expect(c.get(5, 60, 5).slots).toEqual([{ k: 'honeyberries', n: 2 }, { k: 'salted_pork', n: 2 }]);
    expect(c.version).toBe(v + 1);
  });

  it('the rate follows min(1, n·dt/spoilS): a basket is not a larder', () => {
    const random = mulberry32(5);
    let lost = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const c = new Containers();
      withBasket(c, 0, 0, 0, { 3: { k: 'roast_pork', n: 16 } });
      lost += c.spoil(1, random, () => true).length;
    }
    expect(lost / trials).toBeGreaterThan((16 / 2400) * 0.8);
    expect(lost / trials).toBeLessThan((16 / 2400) * 1.2);
  });

  it('nothing to spoil leaves the version alone', () => {
    const c = new Containers();
    withBasket(c, 0, 0, 0, { 0: { k: 'salt', n: 2 } });
    const v = c.version;
    expect(c.spoil(1, () => 0, () => true)).toEqual([]);
    expect(c.version).toBe(v);
  });
});

describe('export and load', () => {
  it('exports every entry (empty baskets too), keys sorted by (q, y, r), slots copied', () => {
    const c = new Containers();
    withBasket(c, 5, 60, 0, { 1: { k: 'rock', n: 2 } });
    withBasket(c, -2, 70, 3);
    c.addRemains(-2, 61, 9, [{ k: 'flint_axe', n: 1, d: 2 }]);
    const json = c.export();
    expect(Object.keys(json)).toEqual(['-2,61,9', '-2,70,3', '5,60,0']);
    expect(json['-2,61,9']).toEqual({ kind: 'remains', slots: [{ k: 'flint_axe', n: 1, d: 2 }] });
    expect(json['-2,70,3'].slots).toEqual(new Array(18).fill(null));
    expect(json['5,60,0'].slots[1]).toEqual({ k: 'rock', n: 2 });
    json['5,60,0'].slots[1].n = 50;
    expect(c.get(5, 60, 0).slots[1].n).toBe(2);
    expect(new Containers().export()).toEqual({});
  });

  it('load(export()) round-trips, through JSON too', () => {
    const c = new Containers();
    withBasket(c, 5, 60, 0, { 17: { k: 'pot_water', n: 1 } });
    c.addRemains(-1, 2, -3, [{ k: 'rock', n: 64 }, { k: 'straw_hat', n: 1 }]);
    const d = new Containers();
    expect(d.load(JSON.parse(JSON.stringify(c.export())))).toEqual([]);
    expect(d.export()).toEqual(c.export());
    expect(d.get(-1, 2, -3).q).toBe(-1);
    expect(d.size).toBe(2);
  });

  it('load drops bad entries and bad stacks with warnings', () => {
    const d = new Containers();
    const warnings = d.load({
      'x,y,z': { kind: 'basket', slots: [] },
      '1,2,3': { kind: 'chest', slots: [] },
      '1,2,4': { kind: 'basket', slots: new Array(19).fill(null) },
      '1,2,5': { kind: 'remains', slots: 'no' },
      '1,2,6': null,
      '1,2,7': { kind: 'basket', slots: [{ k: 'nope', n: 1 }, { k: 'rock', n: 2 }, { k: 'rock', n: 99 }] },
      '1,2,8': { kind: 'remains', slots: new Array(30).fill({ k: 'flint', n: 1 }) },
    });
    expect(warnings).toEqual([
      'containers[x,y,z]: malformed key, dropped',
      'containers[1,2,3]: unknown kind, dropped',
      'containers[1,2,4]: bad slots, dropped',
      'containers[1,2,5]: bad slots, dropped',
      'containers[1,2,6]: unknown kind, dropped',
      'containers[1,2,7][0]: unknown item "nope", dropped',
      'containers[1,2,7][2]: count is not 1–64, dropped',
    ]);
    expect(d.size).toBe(2);
    const basket = d.get(1, 2, 7);
    expect(basket.slots.length).toBe(18); // padded
    expect(basket.slots.slice(0, 3)).toEqual([null, { k: 'rock', n: 2 }, null]);
    expect(d.get(1, 2, 8).slots.length).toBe(30);
  });

  it('load caps baskets at MAX_CONTAINERS but always keeps belongings', () => {
    const json = {};
    for (let i = 0; i < MAX_CONTAINERS + 3; i++) json[`${i},0,0`] = { kind: 'basket', slots: [] };
    json['-1,0,0'] = { kind: 'remains', slots: [{ k: 'rock', n: 1 }] };
    const d = new Containers();
    const w = d.load(json);
    expect(w.length).toBe(3);
    expect(w[0]).toMatch(/too many containers, dropped$/);
    expect(d.size).toBe(MAX_CONTAINERS + 1);
    expect(d.get(-1, 0, 0).kind).toBe('remains');
  });

  it('load of null, arrays or garbage gives an empty store', () => {
    const d = new Containers();
    withBasket(d, 0, 0, 0);
    for (const bad of [null, undefined, [], 'x', 7]) {
      expect(d.load(bad)).toEqual([]);
      expect(d.size).toBe(0);
    }
  });
});
