// Unit tests for src/inventory.js — the survival pack, stack rules, the pack screen's mouse rules and spoilage
// (docs/DESIGN-survival.md §5.2–§5.4, §4.5).
import { describe, it, expect } from 'vitest';
import { PACK_SLOTS, WEAR_SLOTS, HOTBAR_SIZE } from '../../src/config.js';
import { ITEMS, ITEM_KEYS, TAGS, stackSize, maxDurability } from '../../src/items.js';
import {
  Pack, slotClick, returnCursor, makeStack, copyStack, canMerge, durabilityLeft, stackProblem, fitStack, spoilSlots,
  countsToStacks, aggregateStacks, stackLabel, KEEP_ON_DEATH, KEEP_REFUSED, isKept,
} from '../../src/inventory.js';
import { mulberry32 } from '../../src/noise.js';

/** A pack with the given slots set ({ index: stack }). */
function packWith(slots = {}, wear = {}) {
  const p = new Pack();
  for (const [i, s] of Object.entries(slots)) p.slots[Number(i)] = s;
  for (const [i, s] of Object.entries(wear)) p.wear[Number(i)] = s;
  return p;
}
/** The pack's non-empty slots as { index: stack }. */
function filled(p) {
  const out = {};
  p.slots.forEach((s, i) => {
    if (s) out[i] = s;
  });
  return out;
}
/** A random() that returns the given values in turn (then repeats the last). */
function seq(...vals) {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
}

describe('stack helpers', () => {
  it('makeStack / copyStack keep k, n and only a given d', () => {
    expect(makeStack('rock', 3)).toEqual({ k: 'rock', n: 3 });
    expect(makeStack('flint_axe', 1, 12)).toEqual({ k: 'flint_axe', n: 1, d: 12 });
    expect('d' in makeStack('rock')).toBe(false);
    expect(makeStack('rock')).toEqual({ k: 'rock', n: 1 });
    expect(copyStack(null)).toBe(null);
    expect(copyStack(undefined)).toBe(null);
    const s = { k: 'flint_axe', n: 1, d: 5, junk: 1 };
    const c = copyStack(s);
    expect(c).toEqual({ k: 'flint_axe', n: 1, d: 5 });
    expect(c).not.toBe(s);
  });

  it('canMerge: same key and no durability on either', () => {
    expect(canMerge({ k: 'rock', n: 1 }, { k: 'rock', n: 60 })).toBe(true);
    expect(canMerge({ k: 'rock', n: 1 }, { k: 'flint', n: 1 })).toBe(false);
    expect(canMerge({ k: 'flint_axe', n: 1, d: 3 }, { k: 'flint_axe', n: 1 })).toBe(false);
    expect(canMerge({ k: 'flint_axe', n: 1, d: 3 }, { k: 'flint_axe', n: 1, d: 3 })).toBe(false);
    expect(canMerge(null, { k: 'rock', n: 1 })).toBe(false);
    expect(canMerge({ k: 'rock', n: 1 }, null)).toBe(false);
  });

  it('durabilityLeft: d, else the full durability; 0 for items without one', () => {
    expect(durabilityLeft({ k: 'flint_axe', n: 1 })).toBe(90);
    expect(durabilityLeft({ k: 'flint_axe', n: 1, d: 7 })).toBe(7);
    expect(durabilityLeft({ k: 'rock', n: 3 })).toBe(0);
    expect(durabilityLeft(null)).toBe(0);
  });

  it('stackProblem gives the §9.6 reasons', () => {
    expect(stackProblem({ k: 'rock', n: 64 })).toBe(null);
    expect(stackProblem({ k: 'flint_axe', n: 1, d: 90 })).toBe(null);
    expect(stackProblem({ k: 'flint_axe', n: 1, d: 1 })).toBe(null);
    expect(stackProblem(null)).toBe('not an item stack');
    expect(stackProblem([1])).toBe('not an item stack');
    expect(stackProblem('rock')).toBe('not an item stack');
    expect(stackProblem({ k: 'nope', n: 1 })).toBe('unknown item "nope"');
    expect(stackProblem({ k: '__proto__', n: 1 })).toBe('unknown item "__proto__"');
    expect(stackProblem({ k: 'rock', n: 0 })).toBe('count is not 1–64');
    expect(stackProblem({ k: 'rock', n: 65 })).toBe('count is not 1–64');
    expect(stackProblem({ k: 'rock', n: 1.5 })).toBe('count is not 1–64');
    expect(stackProblem({ k: 'flint_axe', n: 2 })).toBe('count is not 1–1');
    expect(stackProblem({ k: 'flint_axe', n: 1, d: 0 })).toBe('durability is not 1–90');
    expect(stackProblem({ k: 'flint_axe', n: 1, d: 91 })).toBe('durability is not 1–90');
    expect(stackProblem({ k: 'flint_axe', n: 1, d: 2.5 })).toBe('durability is not 1–90');
    expect(stackProblem({ k: 'rock', n: 1, d: 3 })).toBe('rock has no durability');
  });

  it('stackProblem with a wear slot checks the item belongs there', () => {
    expect(stackProblem({ k: 'straw_hat', n: 1 }, 0)).toBe(null);
    expect(stackProblem({ k: 'leather_coat', n: 1 }, 1)).toBe(null);
    expect(stackProblem({ k: 'hide_shoes', n: 1 }, 2)).toBe(null);
    expect(stackProblem({ k: 'rock', n: 1 }, 0)).toBe('a wear slot holds a non-wear item');
    expect(stackProblem({ k: 'straw_hat', n: 1 }, 2)).toBe('a head item in the feet slot');
  });

  it('fitStack merges first, then fills empties, in the given order', () => {
    const slots = [null, { k: 'rock', n: 60 }, null, { k: 'rock', n: 10 }];
    expect(fitStack(slots, { k: 'rock', n: 100 }, [0, 1, 2, 3])).toBe(0);
    expect(slots).toEqual([{ k: 'rock', n: 42 }, { k: 'rock', n: 64 }, null, { k: 'rock', n: 64 }]);
    const s2 = [null, null];
    expect(fitStack(s2, { k: 'rock', n: 200 }, [1, 0])).toBe(72);
    expect(s2).toEqual([{ k: 'rock', n: 64 }, { k: 'rock', n: 64 }]);
    expect(fitStack([null], { k: 'nope', n: 3 }, [0])).toBe(3); // unknown items fit nowhere
  });

  it('spoilSlots: one roll per perishable stack, probability min(1, n·dt/spoilS)', () => {
    const slots = [{ k: 'raw_pork', n: 6 }, { k: 'rock', n: 3 }, { k: 'honeyberries', n: 1 }, null];
    const calls = [];
    const random = () => {
      calls.push(1);
      return 0.004; // raw_pork: 6/1200 = 0.005 → spoils; honeyberries: 1/1800 ≈ 0.00056 → keeps
    };
    const out = new Map();
    expect(spoilSlots(slots, 1, random, out)).toBe(true);
    expect(calls.length).toBe(2);
    expect(slots[0]).toEqual({ k: 'raw_pork', n: 5 });
    expect(slots[2]).toEqual({ k: 'honeyberries', n: 1 });
    expect(countsToStacks(out)).toEqual([{ k: 'raw_pork', n: 1 }]);
    // dt 0 never spoils and never rolls
    expect(spoilSlots(slots, 0, () => 0, new Map())).toBe(false);
  });

  it('aggregateStacks sums by key (and durability), in order of first appearance', () => {
    expect(aggregateStacks([{ k: 'rock', n: 1 }, { k: 'flint', n: 1 }, { k: 'rock', n: 2 }, null, { k: 'stick', n: 0 }]))
      .toEqual([{ k: 'rock', n: 3 }, { k: 'flint', n: 1 }]);
    expect(aggregateStacks([{ k: 'flint_axe', n: 1, d: 3 }, { k: 'flint_axe', n: 1 }]))
      .toEqual([{ k: 'flint_axe', n: 1, d: 3 }, { k: 'flint_axe', n: 1 }]);
  });

  it('stackLabel', () => {
    expect(stackLabel({ k: 'rock', n: 2 })).toBe('2 Rock');
    expect(stackLabel({ k: 'raw_pork', n: 1 })).toBe('1 Raw Pork');
  });
});

describe('Pack layout', () => {
  it('has PACK_SLOTS slots and WEAR_SLOTS wear slots, all empty', () => {
    const p = new Pack();
    expect(p.slots.length).toBe(PACK_SLOTS);
    expect(p.slots.length).toBe(27);
    expect(p.wear.length).toBe(WEAR_SLOTS);
    expect(p.slots.every((s) => s === null)).toBe(true);
    expect(p.isEmpty()).toBe(true);
    expect(p.version).toBe(0);
    expect(HOTBAR_SIZE).toBe(9);
  });

  it('get / item / toolAt', () => {
    const p = packWith({ 0: { k: 'flint_pick', n: 1 }, 1: { k: 'rock', n: 3 } });
    expect(p.get(0)).toEqual({ k: 'flint_pick', n: 1 });
    expect(p.get(5)).toBe(null);
    expect(p.get(99)).toBe(null);
    expect(p.item(1).name).toBe('Rock');
    expect(p.item(2)).toBe(null);
    expect(p.toolAt(0)).toEqual({ type: 'pick', tier: 2, durability: 90, power: 1 });
    expect(p.toolAt(1)).toBe(null);
    expect(p.toolAt(2)).toBe(null);
  });

  it('setSlot / setWear copy, bump version and ignore bad indices', () => {
    const p = new Pack();
    const s = { k: 'rock', n: 2 };
    p.setSlot(4, s);
    expect(p.slots[4]).toEqual(s);
    expect(p.slots[4]).not.toBe(s);
    expect(p.version).toBe(1);
    p.setSlot(27, s);
    p.setSlot(-1, s);
    expect(p.version).toBe(1);
    p.setWear(0, { k: 'straw_hat', n: 1 });
    expect(p.wear[0]).toEqual({ k: 'straw_hat', n: 1 });
    p.setWear(3, s);
    expect(p.version).toBe(2);
    p.setSlot(4, null);
    expect(p.slots[4]).toBe(null);
  });
});

describe('Pack.add: merge order, then empties, then overflow (§5.3)', () => {
  it('fills the hotbar first, slot 0 upward', () => {
    const p = new Pack();
    expect(p.add({ k: 'rock', n: 3 })).toBe(null);
    expect(p.add({ k: 'flint', n: 1 })).toBe(null);
    expect(filled(p)).toEqual({ 0: { k: 'rock', n: 3 }, 1: { k: 'flint', n: 1 } });
    expect(p.version).toBe(2);
  });

  it('merges into existing stacks slot 0 → 26 before using an empty slot', () => {
    const p = packWith({ 3: { k: 'rock', n: 60 }, 20: { k: 'rock', n: 10 } });
    expect(p.add({ k: 'rock', n: 70 })).toBe(null);
    expect(filled(p)).toEqual({ 0: { k: 'rock', n: 12 }, 3: { k: 'rock', n: 64 }, 20: { k: 'rock', n: 64 } });
  });

  it('splits beyond the stack size into several empty slots', () => {
    const p = new Pack();
    expect(p.add({ k: 'flint', n: 70 })).toBe(null); // stack 32
    expect(filled(p)).toEqual({ 0: { k: 'flint', n: 32 }, 1: { k: 'flint', n: 32 }, 2: { k: 'flint', n: 6 } });
  });

  it('returns the overflow when the pack is full', () => {
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'stick', n: 64 };
    p.slots[26] = { k: 'rock', n: 62 };
    const over = p.add({ k: 'rock', n: 5 });
    expect(over).toEqual({ k: 'rock', n: 3 });
    expect(p.slots[26]).toEqual({ k: 'rock', n: 64 });
    expect(p.add({ k: 'flint', n: 2 })).toEqual({ k: 'flint', n: 2 });
  });

  it('does not change the version when nothing fits, and ignores empty input', () => {
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'stick', n: 64 };
    expect(p.add({ k: 'rock', n: 1 })).toEqual({ k: 'rock', n: 1 });
    expect(p.version).toBe(0);
    expect(p.add(null)).toBe(null);
    expect(p.add({ k: 'rock', n: 0 })).toBe(null);
  });

  it('unknown items fit nowhere', () => {
    const p = new Pack();
    expect(p.add({ k: 'unobtainium', n: 2 })).toEqual({ k: 'unobtainium', n: 2 });
    expect(p.isEmpty()).toBe(true);
  });

  it('never changes the stack it is given, nor stacks already in the pack (values)', () => {
    const p = packWith({ 0: { k: 'rock', n: 10 } });
    const held = p.slots[0];
    const given = { k: 'rock', n: 5 };
    p.add(given);
    expect(given).toEqual({ k: 'rock', n: 5 });
    expect(held).toEqual({ k: 'rock', n: 10 });
    expect(p.slots[0]).toEqual({ k: 'rock', n: 15 });
  });

  it('addAll returns one overflow per stack that did not fit', () => {
    const p = new Pack();
    for (let i = 1; i < PACK_SLOTS; i++) p.slots[i] = { k: 'stick', n: 64 };
    const over = p.addAll([{ k: 'rock', n: 70 }, { k: 'flint', n: 1 }]);
    expect(over).toEqual([{ k: 'rock', n: 6 }, { k: 'flint', n: 1 }]);
    expect(p.slots[0]).toEqual({ k: 'rock', n: 64 });
  });

  it('give(key, n) adds new items and returns the count left over', () => {
    const p = new Pack();
    expect(p.give('cord', 3)).toBe(0);
    expect(p.count('cord')).toBe(3);
    expect(p.give('cord', 0)).toBe(0);
    expect(p.give('cord', -2)).toBe(0);
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'cord', n: 32 };
    expect(p.give('cord', 4)).toBe(4);
  });
});

describe('tools never stack (§5.2)', () => {
  it('every item with a durability has stack 1', () => {
    for (const k of ITEM_KEYS) if (maxDurability(k) > 0) expect(stackSize(k)).toBe(1);
  });

  it('two new tools take two slots; give(key, 3) makes three', () => {
    const p = new Pack();
    p.add({ k: 'flint_axe', n: 1 });
    p.add({ k: 'flint_axe', n: 1 });
    expect(filled(p)).toEqual({ 0: { k: 'flint_axe', n: 1 }, 1: { k: 'flint_axe', n: 1 } });
    expect(p.give('flint_knife', 3)).toBe(0);
    expect(p.count('flint_knife')).toBe(3);
    expect(p.slots.filter((s) => s && s.k === 'flint_knife').every((s) => s.n === 1)).toBe(true);
  });

  it('a worn tool keeps its durability when added', () => {
    const p = new Pack();
    expect(p.add({ k: 'flint_axe', n: 1, d: 9 })).toBe(null);
    expect(p.slots[0]).toEqual({ k: 'flint_axe', n: 1, d: 9 });
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = p.slots[i] ?? { k: 'rock', n: 64 };
    expect(p.add({ k: 'flint_axe', n: 1, d: 4 })).toEqual({ k: 'flint_axe', n: 1, d: 4 });
  });
});

describe('canGive', () => {
  it('checks all stacks together and changes nothing', () => {
    const p = new Pack();
    for (let i = 2; i < PACK_SLOTS; i++) p.slots[i] = { k: 'stick', n: 64 };
    const before = JSON.stringify(p.slots);
    expect(p.canGive([{ k: 'rock', n: 64 }, { k: 'flint', n: 32 }])).toBe(true);
    expect(p.canGive([{ k: 'rock', n: 64 }, { k: 'flint', n: 32 }, { k: 'cord', n: 1 }])).toBe(false);
    expect(p.canGive([{ k: 'rock', n: 129 }])).toBe(false);
    expect(p.canGive([{ k: 'stick', n: 0 }])).toBe(true);
    expect(p.canGive([])).toBe(true);
    expect(p.canGive([{ k: 'nope', n: 1 }])).toBe(false);
    expect(JSON.stringify(p.slots)).toBe(before);
    expect(p.version).toBe(0);
  });

  it('counts merging room in partial stacks', () => {
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'rock', n: 63 };
    expect(p.canGive([{ k: 'rock', n: 27 }])).toBe(true);
    expect(p.canGive([{ k: 'rock', n: 28 }])).toBe(false);
  });
});

describe('count, take and tags', () => {
  it('count sums the pack slots only (worn items do not count)', () => {
    const p = packWith({ 0: { k: 'rock', n: 5 }, 26: { k: 'rock', n: 7 }, 3: { k: 'flint', n: 1 } }, { 0: { k: 'straw_hat', n: 1 } });
    expect(p.count('rock')).toBe(12);
    expect(p.count('straw_hat')).toBe(0);
    expect(p.count('nope')).toBe(0);
  });

  it('take works backwards from slot 26, so the hotbar keeps its things longest', () => {
    const p = packWith({ 0: { k: 'rock', n: 5 }, 10: { k: 'rock', n: 4 }, 26: { k: 'rock', n: 3 } });
    expect(p.take('rock', 5)).toBe(5);
    expect(filled(p)).toEqual({ 0: { k: 'rock', n: 5 }, 10: { k: 'rock', n: 2 } });
    expect(p.take('rock', 100)).toBe(7);
    expect(p.isEmpty()).toBe(true);
    expect(p.take('rock', 1)).toBe(0);
  });

  it('take ignores bad counts and bumps the version only when something was taken', () => {
    const p = packWith({ 0: { k: 'rock', n: 5 } });
    expect(p.take('rock', 0)).toBe(0);
    expect(p.take('rock', -3)).toBe(0);
    expect(p.take('rock', NaN)).toBe(0);
    expect(p.take('flint', 2)).toBe(0);
    expect(p.version).toBe(0);
    expect(p.take('rock', 2.9)).toBe(2);
    expect(p.version).toBe(1);
  });

  it('countTag sums the members; takeTag takes members in TAGS order, each from the back', () => {
    const p = packWith({ 0: { k: 'charcoal', n: 4 }, 5: { k: 'coal', n: 2 }, 20: { k: 'coal', n: 1 } });
    expect(TAGS.fuel).toEqual(['coal', 'charcoal']);
    expect(p.countTag('fuel')).toBe(7);
    expect(p.takeTag('fuel', 4)).toBe(4); // 3 coal (slot 20, then 5), then 1 charcoal
    expect(filled(p)).toEqual({ 0: { k: 'charcoal', n: 3 } });
    expect(p.takeTag('fuel', 10)).toBe(3);
    expect(p.takeTag('fuel', 1)).toBe(0);
  });

  it('tags of logs, tinder and knapstone', () => {
    const p = packWith({ 0: { k: 'birch_log', n: 2 }, 1: { k: 'oak_log', n: 1 }, 2: { k: 'plant_fibre', n: 5 }, 3: { k: 'obsidian_shard', n: 1 } });
    expect(p.countTag('log')).toBe(3);
    expect(p.countTag('tinder')).toBe(5);
    expect(p.countTag('knapstone')).toBe(1);
    expect(p.takeTag('log', 2)).toBe(2); // oak first (TAGS order), then birch
    expect(p.count('oak_log')).toBe(0);
    expect(p.count('birch_log')).toBe(1);
  });

  it('unknown tags hold nothing', () => {
    const p = packWith({ 0: { k: 'rock', n: 5 } });
    expect(p.countTag('nope')).toBe(0);
    expect(p.countTag('__proto__')).toBe(0);
    expect(p.takeTag('nope', 3)).toBe(0);
    expect(p.takeTag('fuel', 0)).toBe(0);
  });
});

describe('tools: choice, wear and breaking (§5.3)', () => {
  it('hasTool needs the type and a tier ≥ minTier', () => {
    const p = packWith({ 5: { k: 'flint_knife', n: 1 }, 6: { k: 'stone_axe', n: 1 } });
    expect(p.hasTool('knife', 2)).toBe(true);
    expect(p.hasTool('knife', 3)).toBe(false);
    expect(p.hasTool('axe', 1)).toBe(true);
    expect(p.hasTool('axe', 2)).toBe(false);
    expect(p.hasTool('pick', 0)).toBe(false);
    expect(new Pack().hasTool('firestarter', 0)).toBe(false);
    expect(packWith({ 0: { k: 'fire_drill', n: 1 } }).hasTool('firestarter', 0)).toBe(true);
  });

  it('useTool picks the lowest qualifying tier', () => {
    const p = packWith({ 0: { k: 'bronze_hammer', n: 1 }, 1: { k: 'copper_hammer', n: 1 }, 2: { k: 'stone_hammer', n: 1 } });
    expect(p.findTool('hammer', 3)).toBe(1);
    expect(p.useTool('hammer', 3)).toEqual({ key: 'copper_hammer', broke: false });
    expect(p.slots[1]).toEqual({ k: 'copper_hammer', n: 1, d: 159 });
    expect(p.findTool('hammer', 1)).toBe(2);
    expect(p.findTool('hammer', 5)).toBe(-1);
    expect(p.useTool('hammer', 5)).toBe(null);
  });

  it('ties of tier go to the least durability left', () => {
    const p = packWith({ 0: { k: 'flint_knife', n: 1, d: 30 }, 1: { k: 'flint_knife', n: 1 }, 2: { k: 'flint_knife', n: 1, d: 12 } });
    expect(p.findTool('knife', 2)).toBe(2);
    const q = packWith({ 3: { k: 'flint_knife', n: 1 }, 7: { k: 'flint_knife', n: 1 } });
    expect(q.findTool('knife', 2)).toBe(7); // full ties: the higher slot (the hotbar keeps its things longest)
  });

  it('a tool breaks at 0 durability and the slot empties', () => {
    const p = packWith({ 4: { k: 'fire_drill', n: 1, d: 1 } });
    expect(p.useTool('firestarter', 0)).toEqual({ key: 'fire_drill', broke: true });
    expect(p.slots[4]).toBe(null);
    expect(p.hasTool('firestarter', 0)).toBe(false);
  });

  it('a new tool lasts exactly its durability in uses', () => {
    const p = packWith({ 0: { k: 'fire_drill', n: 1 } });
    for (let i = 1; i < 8; i++) expect(p.useTool('firestarter', 0)).toEqual({ key: 'fire_drill', broke: false });
    expect(p.slots[0]).toEqual({ k: 'fire_drill', n: 1, d: 1 });
    expect(p.useTool('firestarter', 0)).toEqual({ key: 'fire_drill', broke: true });
  });

  it('damage(i, n) wears the item in a slot; null for items without a durability', () => {
    const p = packWith({ 0: { k: 'flint_pick', n: 1 }, 1: { k: 'rock', n: 3 } });
    expect(p.damage(0)).toEqual({ key: 'flint_pick', broke: false });
    expect(p.slots[0].d).toBe(89);
    expect(p.damage(0, 10)).toEqual({ key: 'flint_pick', broke: false });
    expect(p.slots[0].d).toBe(79);
    expect(p.damage(0, 0)).toEqual({ key: 'flint_pick', broke: false });
    expect(p.slots[0].d).toBe(79);
    expect(p.damage(0, 500)).toEqual({ key: 'flint_pick', broke: true });
    expect(p.slots[0]).toBe(null);
    expect(p.damage(1)).toBe(null);
    expect(p.damage(2)).toBe(null);
    expect(p.slots[1]).toEqual({ k: 'rock', n: 3 });
  });
});

describe('consume, equip, unequip, insulation and shade', () => {
  it('consume uses up items from one slot', () => {
    const p = packWith({ 2: { k: 'dirt', n: 3 } });
    expect(p.consume(2)).toBe(1);
    expect(p.slots[2]).toEqual({ k: 'dirt', n: 2 });
    expect(p.consume(2, 5)).toBe(2);
    expect(p.slots[2]).toBe(null);
    expect(p.consume(2)).toBe(0);
    expect(p.consume(0, 0)).toBe(0);
  });

  it('equip swaps a wear item with the worn one in its slot', () => {
    const p = packWith({ 0: { k: 'grass_cape', n: 1 }, 1: { k: 'leather_coat', n: 1 }, 2: { k: 'rock', n: 1 } });
    expect(p.equip(0)).toBe(true);
    expect(p.wear).toEqual([null, { k: 'grass_cape', n: 1 }, null]);
    expect(p.slots[0]).toBe(null);
    expect(p.equip(1)).toBe(true);
    expect(p.wear[1]).toEqual({ k: 'leather_coat', n: 1 });
    expect(p.slots[1]).toEqual({ k: 'grass_cape', n: 1 });
    expect(p.equip(2)).toBe(false); // not a wear item
    expect(p.equip(3)).toBe(false); // empty
  });

  it('unequip moves a worn item into the pack, or nothing when there is no room', () => {
    const p = packWith({}, { 0: { k: 'straw_hat', n: 1 } });
    expect(p.unequip(0)).toBe(true);
    expect(p.wear[0]).toBe(null);
    expect(p.slots[0]).toEqual({ k: 'straw_hat', n: 1 });
    expect(p.unequip(0)).toBe(false);
    const full = packWith({}, { 2: { k: 'hide_shoes', n: 1 } });
    for (let i = 0; i < PACK_SLOTS; i++) full.slots[i] = { k: 'rock', n: 64 };
    expect(full.unequip(2)).toBe(false);
    expect(full.wear[2]).toEqual({ k: 'hide_shoes', n: 1 });
  });

  it('insulation is the sum of the worn I; sunShade the largest worn shade', () => {
    const p = new Pack();
    expect(p.insulation()).toBe(0);
    expect(p.sunShade()).toBe(0);
    p.wear = [{ k: 'leather_hood', n: 1 }, { k: 'leather_coat', n: 1 }, { k: 'hide_shoes', n: 1 }];
    expect(p.insulation()).toBe(10); // the snowy-night worked example's I 10
    expect(p.sunShade()).toBe(0);
    p.wear[0] = { k: 'straw_hat', n: 1 };
    expect(p.insulation()).toBe(8);
    expect(p.sunShade()).toBe(0.5);
  });

  it('hotbarSlotOf finds a hotbar slot holding the item and never looks in the rosette', () => {
    const p = packWith({ 3: { k: 'dirt', n: 1 }, 7: { k: 'dirt', n: 1 }, 12: { k: 'stone', n: 1 } });
    expect(p.hotbarSlotOf('dirt')).toBe(3);
    expect(p.hotbarSlotOf('stone')).toBe(-1);
    expect(p.hotbarSlotOf(null)).toBe(-1);
  });
});

describe('dumpAll, spoil, export and load', () => {
  it('dumpAll returns every pack then worn stack and empties the pack', () => {
    const p = packWith({ 26: { k: 'rock', n: 1 }, 0: { k: 'flint', n: 2 } }, { 1: { k: 'grass_cape', n: 1 } });
    expect(p.dumpAll()).toEqual([{ k: 'flint', n: 2 }, { k: 'rock', n: 1 }, { k: 'grass_cape', n: 1 }]);
    expect(p.isEmpty()).toBe(true);
    const v = p.version;
    expect(p.dumpAll()).toEqual([]);
    expect(p.version).toBe(v);
  });

  it('a full pack and full wear dump at most 30 stacks', () => {
    const p = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) p.slots[i] = { k: 'rock', n: 1 };
    p.wear = [{ k: 'straw_hat', n: 1 }, { k: 'grass_cape', n: 1 }, { k: 'hide_shoes', n: 1 }];
    expect(p.dumpAll().length).toBe(30);
  });

  it('spoil follows min(1, n·dt/spoilS) per stack: rates over many seconds', () => {
    // Raw pork, spoilS 1200: a stack of 12 loses about 12/1200 = 1 % per second → ~ 10 in 1000 one-item checks… measure
    // the per-check probability on a refilled stack instead.
    const random = mulberry32(42);
    let lost = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const p = packWith({ 0: { k: 'raw_pork', n: 12 } });
      const bad = p.spoil(1, random);
      if (bad.length) {
        expect(bad).toEqual([{ k: 'raw_pork', n: 1 }]);
        lost++;
      }
    }
    expect(lost / trials).toBeGreaterThan(0.008);
    expect(lost / trials).toBeLessThan(0.012);
  });

  it('spoil: honeyberries (1800 s) vs roast pork (2400 s), and min(1, …) at large dt', () => {
    const p = packWith({ 0: { k: 'honeyberries', n: 30 }, 1: { k: 'roast_pork', n: 16 } });
    const r = seq(30 / 1800 - 1e-9, 16 / 2400 + 1e-9);
    expect(p.spoil(1, r)).toEqual([{ k: 'honeyberries', n: 1 }]);
    expect(p.slots[1]).toEqual({ k: 'roast_pork', n: 16 });
    const q = packWith({ 0: { k: 'raw_pork', n: 1 } });
    expect(q.spoil(5000, () => 0.999999)).toEqual([{ k: 'raw_pork', n: 1 }]);
    expect(q.slots[0]).toBe(null);
  });

  it('spoil aggregates by key and never touches items that do not spoil', () => {
    const p = packWith({
      0: { k: 'raw_pork', n: 2 }, 1: { k: 'raw_pork', n: 3 }, 2: { k: 'salted_pork', n: 5 }, 3: { k: 'baked_tuber', n: 4 },
      4: { k: 'rock', n: 9 }, 5: { k: 'pot_water', n: 1 },
    });
    let calls = 0;
    const out = p.spoil(1, () => {
      calls++;
      return 0;
    });
    expect(calls).toBe(2);
    expect(out).toEqual([{ k: 'raw_pork', n: 2 }]);
    expect(filled(p)).toEqual({
      0: { k: 'raw_pork', n: 1 }, 1: { k: 'raw_pork', n: 2 }, 2: { k: 'salted_pork', n: 5 }, 3: { k: 'baked_tuber', n: 4 },
      4: { k: 'rock', n: 9 }, 5: { k: 'pot_water', n: 1 },
    });
  });

  it('every perishable item is food with a spoilS; nothing else spoils', () => {
    const perishable = ITEM_KEYS.filter((k) => ITEMS[k].food?.spoilS);
    expect(perishable.sort()).toEqual(['honeyberries', 'raw_bear', 'raw_beef', 'raw_egg', 'raw_fish', 'raw_fowl', 'raw_mutton', 'raw_pork', 'raw_rabbit',
      'raw_venison', 'roast_bear', 'roast_beef', 'roast_egg', 'roast_fish', 'roast_fowl', 'roast_mutton', 'roast_pork', 'roast_rabbit',
      'roast_venison']); // v0.14 (§76 fauna): + game and eggs
    const p = new Pack();
    ITEM_KEYS.filter((k) => !perishable.includes(k)).slice(0, PACK_SLOTS).forEach((k, i) => (p.slots[i] = { k, n: 1 }));
    const before = JSON.stringify(p.slots);
    expect(p.spoil(1, () => 0)).toEqual([]);
    expect(JSON.stringify(p.slots)).toBe(before);
    expect(p.version).toBe(0);
  });

  it('export copies; load restores it', () => {
    const p = packWith({ 0: { k: 'flint_axe', n: 1, d: 5 }, 13: { k: 'rock', n: 7 } }, { 2: { k: 'hide_shoes', n: 1 } });
    const json = p.export();
    expect(json.pack.length).toBe(27);
    expect(json.wear).toEqual([null, null, { k: 'hide_shoes', n: 1 }]);
    json.pack[13].n = 99; // a copy
    expect(p.slots[13].n).toBe(7);
    const q = new Pack();
    expect(q.load(p.export())).toEqual([]);
    expect(q.export()).toEqual(p.export());
    expect(q.version).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(p.export()))).toEqual(p.export());
  });

  it('load accepts a whole SurvivalJSON, null and garbage', () => {
    const q = packWith({ 0: { k: 'rock', n: 1 } });
    expect(q.load(null)).toEqual([]);
    expect(q.isEmpty()).toBe(true);
    expect(q.load('x')).toEqual([]);
    expect(q.load({ health: 50, pack: [{ k: 'cord', n: 2 }], wear: [] })).toEqual(['pack: 1 slots, not 27', 'wear: 0 slots, not 3']);
    expect(q.slots[0]).toEqual({ k: 'cord', n: 2 });
    expect(q.load({ pack: 'nope' })).toEqual(['pack: not a list, emptied']);
    expect(q.isEmpty()).toBe(true);
  });

  it('load drops bad stacks with a reason, including wear items in the wrong slot', () => {
    const pack = new Array(27).fill(null);
    pack[0] = { k: 'nope', n: 1 };
    pack[1] = { k: 'rock', n: 65 };
    pack[2] = { k: 'flint_axe', n: 1, d: 0 };
    pack[3] = { k: 'rock', n: 2 };
    const wear = [{ k: 'hide_shoes', n: 1 }, { k: 'rock', n: 1 }, { k: 'hide_shoes', n: 1 }];
    const q = new Pack();
    expect(q.load({ pack, wear })).toEqual([
      'pack[0]: unknown item "nope", dropped',
      'pack[1]: count is not 1–64, dropped',
      'pack[2]: durability is not 1–90, dropped',
      'wear[0]: a feet item in the head slot, dropped',
      'wear[1]: a wear slot holds a non-wear item, dropped',
    ]);
    expect(filled(q)).toEqual({ 3: { k: 'rock', n: 2 } });
    expect(q.wear).toEqual([null, null, { k: 'hide_shoes', n: 1 }]);
  });

  it('a long pack list is cut to 27', () => {
    const q = new Pack();
    const pack = new Array(30).fill(null);
    pack[29] = { k: 'rock', n: 1 };
    pack[26] = { k: 'flint', n: 1 };
    expect(q.load({ pack })).toEqual(['pack: 30 slots, not 27']);
    expect(q.slots.length).toBe(27);
    expect(filled(q)).toEqual({ 26: { k: 'flint', n: 1 } });
  });

  it('clear and touch bump the version', () => {
    const p = packWith({ 0: { k: 'rock', n: 1 } });
    p.clear();
    expect(p.isEmpty()).toBe(true);
    expect(p.version).toBe(1);
    p.touch();
    expect(p.version).toBe(2);
  });
});

describe('slotClick (§5.4)', () => {
  /** A session with a pack built from slots, an optional cursor and container. */
  function session(slots = {}, cursor = null, container = null, wear = {}) {
    return { pack: packWith(slots, wear), cursor, container };
  }

  it('left, empty cursor: picks up the whole stack', () => {
    const s = session({ 4: { k: 'rock', n: 9 } });
    const res = slotClick(s, 'pack', 4, 0, false);
    expect(res).toEqual({ changed: true, container: false, discarded: null });
    expect(s.cursor).toEqual({ k: 'rock', n: 9 });
    expect(s.pack.slots[4]).toBe(null);
    expect(s.pack.version).toBe(1);
  });

  it('left on an empty slot with an empty cursor does nothing', () => {
    const s = session();
    expect(slotClick(s, 'pack', 4, 0, false).changed).toBe(false);
    expect(s.pack.version).toBe(0);
  });

  it('left with a cursor: an empty slot takes it all', () => {
    const s = session({}, { k: 'rock', n: 9 });
    slotClick(s, 'pack', 20, 0, false);
    expect(s.cursor).toBe(null);
    expect(s.pack.slots[20]).toEqual({ k: 'rock', n: 9 });
  });

  it('left with a cursor: same key merges up to the stack size and keeps the rest', () => {
    const s = session({ 2: { k: 'flint', n: 30 } }, { k: 'flint', n: 5 });
    slotClick(s, 'pack', 2, 0, false);
    expect(s.pack.slots[2]).toEqual({ k: 'flint', n: 32 });
    expect(s.cursor).toEqual({ k: 'flint', n: 3 });
    // a full stack takes nothing
    expect(slotClick(s, 'pack', 2, 0, false).changed).toBe(false);
    expect(s.cursor).toEqual({ k: 'flint', n: 3 });
    // and a merge that empties the cursor
    const t = session({ 2: { k: 'flint', n: 3 } }, { k: 'flint', n: 5 });
    slotClick(t, 'pack', 2, 0, false);
    expect(t.pack.slots[2]).toEqual({ k: 'flint', n: 8 });
    expect(t.cursor).toBe(null);
  });

  it('left with a cursor: a different key swaps; so does a worn tool of the same key', () => {
    const s = session({ 2: { k: 'flint', n: 3 } }, { k: 'rock', n: 5 });
    slotClick(s, 'pack', 2, 0, false);
    expect(s.pack.slots[2]).toEqual({ k: 'rock', n: 5 });
    expect(s.cursor).toEqual({ k: 'flint', n: 3 });
    const t = session({ 0: { k: 'flint_axe', n: 1, d: 4 } }, { k: 'flint_axe', n: 1 });
    slotClick(t, 'pack', 0, 0, false);
    expect(t.pack.slots[0]).toEqual({ k: 'flint_axe', n: 1 });
    expect(t.cursor).toEqual({ k: 'flint_axe', n: 1, d: 4 });
  });

  it('right, empty cursor: picks up half, rounded up', () => {
    const s = session({ 1: { k: 'rock', n: 7 } });
    slotClick(s, 'pack', 1, 2, false);
    expect(s.cursor).toEqual({ k: 'rock', n: 4 });
    expect(s.pack.slots[1]).toEqual({ k: 'rock', n: 3 });
    const t = session({ 1: { k: 'rock', n: 1 } });
    slotClick(t, 'pack', 1, 2, false);
    expect(t.cursor).toEqual({ k: 'rock', n: 1 });
    expect(t.pack.slots[1]).toBe(null);
    const u = session({ 1: { k: 'flint_axe', n: 1, d: 3 } });
    slotClick(u, 'pack', 1, 2, false);
    expect(u.cursor).toEqual({ k: 'flint_axe', n: 1, d: 3 });
  });

  it('right with a cursor: puts 1 into an empty or same-key slot, else nothing', () => {
    const s = session({ 1: { k: 'rock', n: 7 }, 2: { k: 'flint', n: 1 }, 3: { k: 'rock', n: 64 } }, { k: 'rock', n: 2 });
    slotClick(s, 'pack', 1, 2, false);
    expect(s.pack.slots[1]).toEqual({ k: 'rock', n: 8 });
    expect(s.cursor).toEqual({ k: 'rock', n: 1 });
    expect(slotClick(s, 'pack', 2, 2, false).changed).toBe(false); // different key
    expect(slotClick(s, 'pack', 3, 2, false).changed).toBe(false); // full
    slotClick(s, 'pack', 9, 2, false);
    expect(s.pack.slots[9]).toEqual({ k: 'rock', n: 1 });
    expect(s.cursor).toBe(null);
  });

  it('right with a worn tool on the cursor puts it (with its durability) into an empty slot only', () => {
    const s = session({ 1: { k: 'flint_axe', n: 1 } }, { k: 'flint_axe', n: 1, d: 3 });
    expect(slotClick(s, 'pack', 1, 2, false).changed).toBe(false);
    slotClick(s, 'pack', 2, 2, false);
    expect(s.pack.slots[2]).toEqual({ k: 'flint_axe', n: 1, d: 3 });
    expect(s.cursor).toBe(null);
  });

  it('wear slots accept only wear items for that slot', () => {
    const s = session({}, { k: 'rock', n: 1 });
    expect(slotClick(s, 'wear', 0, 0, false).changed).toBe(false);
    expect(slotClick(s, 'wear', 0, 2, false).changed).toBe(false);
    s.cursor = { k: 'hide_shoes', n: 1 };
    expect(slotClick(s, 'wear', 0, 0, false).changed).toBe(false); // feet item, head slot
    slotClick(s, 'wear', 2, 0, false);
    expect(s.pack.wear[2]).toEqual({ k: 'hide_shoes', n: 1 });
    expect(s.cursor).toBe(null);
    // swap a worn item for another of the same slot
    s.cursor = { k: 'leather_coat', n: 1 };
    s.pack.wear[1] = { k: 'grass_cape', n: 1 };
    slotClick(s, 'wear', 1, 0, false);
    expect(s.pack.wear[1]).toEqual({ k: 'leather_coat', n: 1 });
    expect(s.cursor).toEqual({ k: 'grass_cape', n: 1 });
    // picking up from a wear slot
    s.cursor = null;
    slotClick(s, 'wear', 1, 0, false);
    expect(s.cursor).toEqual({ k: 'leather_coat', n: 1 });
    expect(s.pack.wear[1]).toBe(null);
    // a right click puts the one wear item in
    slotClick(s, 'wear', 1, 2, false);
    expect(s.pack.wear[1]).toEqual({ k: 'leather_coat', n: 1 });
    expect(s.cursor).toBe(null);
  });

  it('a cursor wear item may swap out of a pack slot, but a non-wear item never swaps into a wear slot', () => {
    const s = session({}, { k: 'rock', n: 3 }, null, { 0: { k: 'straw_hat', n: 1 } });
    expect(slotClick(s, 'wear', 0, 0, false).changed).toBe(false);
    expect(s.pack.wear[0]).toEqual({ k: 'straw_hat', n: 1 });
  });

  it('shift + left: hotbar ↔ rosette when no container is open', () => {
    const s = session({ 0: { k: 'rock', n: 10 }, 12: { k: 'rock', n: 60 }, 15: { k: 'flint', n: 1 } });
    slotClick(s, 'pack', 0, 0, true);
    expect(filled(s.pack)).toEqual({ 9: { k: 'rock', n: 6 }, 12: { k: 'rock', n: 64 }, 15: { k: 'flint', n: 1 } });
    slotClick(s, 'pack', 15, 0, true);
    expect(s.pack.slots[0]).toEqual({ k: 'flint', n: 1 });
    expect(s.pack.slots[15]).toBe(null);
  });

  it('shift + left leaves what does not fit in the source slot', () => {
    const s = session({ 0: { k: 'rock', n: 10 } });
    for (let i = 9; i < 27; i++) s.pack.slots[i] = { k: 'rock', n: 60 };
    slotClick(s, 'pack', 0, 0, true);
    expect(s.pack.slots[9]).toEqual({ k: 'rock', n: 64 });
    expect(s.pack.slots[11]).toEqual({ k: 'rock', n: 62 });
    expect(s.pack.slots[0]).toBe(null);
    const t = session({ 0: { k: 'flint', n: 3 } });
    for (let i = 9; i < 27; i++) t.pack.slots[i] = { k: 'rock', n: 64 };
    expect(slotClick(t, 'pack', 0, 0, true).changed).toBe(false);
    expect(t.pack.slots[0]).toEqual({ k: 'flint', n: 3 });
  });

  it('shift + left: pack → the open container; container → pack', () => {
    const basket = new Array(18).fill(null);
    basket[0] = { k: 'rock', n: 60 };
    const s = session({ 3: { k: 'rock', n: 10 }, 4: { k: 'flint', n: 2 } }, null, basket);
    let res = slotClick(s, 'pack', 3, 0, true);
    expect(res).toEqual({ changed: true, container: true, discarded: null });
    expect(basket[0]).toEqual({ k: 'rock', n: 64 });
    expect(basket[1]).toEqual({ k: 'rock', n: 6 });
    expect(s.pack.slots[3]).toBe(null);
    res = slotClick(s, 'container', 1, 0, true);
    expect(res.container).toBe(true);
    expect(basket[1]).toBe(null);
    expect(s.pack.slots[0]).toEqual({ k: 'rock', n: 6 }); // the add order: hotbar first
    expect(s.pack.slots[4]).toEqual({ k: 'flint', n: 2 });
  });

  it('shift + left: wear → pack', () => {
    const s = session({}, null, null, { 1: { k: 'grass_cape', n: 1 } });
    slotClick(s, 'wear', 1, 0, true);
    expect(s.pack.wear[1]).toBe(null);
    expect(s.pack.slots[0]).toEqual({ k: 'grass_cape', n: 1 });
    expect(slotClick(s, 'wear', 1, 0, true).changed).toBe(false);
  });

  it('container slots follow the same click rules', () => {
    const basket = new Array(18).fill(null);
    basket[5] = { k: 'stick', n: 9 };
    const s = session({}, null, basket);
    let res = slotClick(s, 'container', 5, 2, false);
    expect(res.container).toBe(true);
    expect(s.cursor).toEqual({ k: 'stick', n: 5 });
    expect(basket[5]).toEqual({ k: 'stick', n: 4 });
    res = slotClick(s, 'container', 6, 0, false);
    expect(res).toEqual({ changed: true, container: true, discarded: null });
    expect(basket[6]).toEqual({ k: 'stick', n: 5 });
    expect(s.pack.version).toBe(0);
  });

  it('a container click with no container open, and bad areas or indices, do nothing', () => {
    const s = session({ 0: { k: 'rock', n: 1 } });
    expect(slotClick(s, 'container', 0, 0, false).changed).toBe(false);
    expect(slotClick(s, 'pack', 27, 0, false).changed).toBe(false);
    expect(slotClick(s, 'pack', -1, 0, false).changed).toBe(false);
    expect(slotClick(s, 'pack', 0.5, 0, false).changed).toBe(false);
    expect(slotClick(s, 'wear', 3, 0, false).changed).toBe(false);
    expect(slotClick(s, 'nowhere', 0, 0, false).changed).toBe(false);
    expect(slotClick(s, 'pack', 0, 1, false).changed).toBe(false); // middle button
    expect(s.pack.slots[0]).toEqual({ k: 'rock', n: 1 });
  });

  it('discard destroys the cursor stack', () => {
    const s = session({}, { k: 'raw_pork', n: 3 });
    const res = slotClick(s, 'discard', 0, 0, false);
    expect(res).toEqual({ changed: true, container: false, discarded: { k: 'raw_pork', n: 3 } });
    expect(s.cursor).toBe(null);
    expect(slotClick(s, 'discard', 0, 0, false)).toEqual({ changed: false, container: false, discarded: null });
  });

  it('nothing is created or destroyed by any sequence of clicks except discard', () => {
    const random = mulberry32(7);
    const basket = new Array(18).fill(null);
    const s = session({ 0: { k: 'rock', n: 50 }, 1: { k: 'flint_axe', n: 1, d: 3 }, 5: { k: 'straw_hat', n: 1 }, 9: { k: 'stick', n: 64 } }, null, basket);
    const total = () => {
      const all = [...s.pack.slots, ...s.pack.wear, ...basket, s.cursor].filter(Boolean);
      const out = {};
      for (const st of all) out[st.k] = (out[st.k] ?? 0) + st.n;
      return out;
    };
    const before = total();
    const areas = ['pack', 'wear', 'container'];
    for (let i = 0; i < 3000; i++) {
      const area = areas[Math.floor(random() * 3)];
      const size = area === 'pack' ? 27 : area === 'wear' ? 3 : 18;
      slotClick(s, area, Math.floor(random() * size), random() < 0.5 ? 0 : 2, random() < 0.2);
      for (const st of [...s.pack.slots, ...basket, s.cursor].filter(Boolean)) expect(stackProblem(st)).toBe(null);
      s.pack.wear.forEach((st, w) => st && expect(stackProblem(st, w)).toBe(null));
    }
    expect(total()).toEqual(before);
  });

  it('returnCursor puts the cursor stack back with pack.add and returns the overflow', () => {
    const s = session({}, { k: 'rock', n: 3 });
    expect(returnCursor(s)).toBe(null);
    expect(s.cursor).toBe(null);
    expect(s.pack.slots[0]).toEqual({ k: 'rock', n: 3 });
    expect(returnCursor(s)).toBe(null);
    for (let i = 0; i < 27; i++) s.pack.slots[i] = { k: 'stick', n: 64 };
    s.cursor = { k: 'rock', n: 2 };
    expect(returnCursor(s)).toEqual({ k: 'rock', n: 2 });
    expect(s.cursor).toBe(null);
  });
});

describe('§14.2 the handbook stays with you (KEEP_ON_DEATH)', () => {
  const BOOK = { k: 'handbook', n: 1 };
  function session(slots = {}, cursor = null, container = null) {
    return { pack: packWith(slots), cursor, container };
  }

  it('KEEP_ON_DEATH is the handbook; isKept tells a kept stack', () => {
    expect([...KEEP_ON_DEATH]).toEqual(['handbook']);
    expect(Object.isFrozen(KEEP_ON_DEATH)).toBe(true);
    expect(isKept(BOOK)).toBe(true);
    expect([isKept({ k: 'rock', n: 1 }), isKept(null), isKept(undefined)]).toEqual([false, false, false]);
    expect(KEEP_REFUSED).toBe('The handbook stays with you.');
  });

  it('dumpAll (death) leaves it in its slot and gives up everything else', () => {
    const p = packWith({ 0: { k: 'flint_pick', n: 1, d: 40 }, 8: BOOK, 20: { k: 'rock', n: 5 } }, { 1: { k: 'grass_cape', n: 1 } });
    const v = p.version;
    expect(p.dumpAll()).toEqual([{ k: 'flint_pick', n: 1, d: 40 }, { k: 'rock', n: 5 }, { k: 'grass_cape', n: 1 }]);
    expect(filled(p)).toEqual({ 8: BOOK });
    expect(p.wear).toEqual([null, null, null]);
    expect(p.version).toBeGreaterThan(v);
    // a pack holding only the handbook: nothing to dump, nothing changes
    const v2 = p.version;
    expect(p.dumpAll()).toEqual([]);
    expect(p.version).toBe(v2);
    expect(filled(p)).toEqual({ 8: BOOK });
  });

  it('the discard hex refuses it: the cursor keeps it and the result says why; other stacks still go', () => {
    const s = session({}, BOOK);
    const res = slotClick(s, 'discard', 0, 0, false);
    expect(res).toEqual({ changed: false, container: false, discarded: null, refused: KEEP_REFUSED });
    expect(s.cursor).toEqual(BOOK);
    s.cursor = { k: 'rock', n: 3 };
    expect(slotClick(s, 'discard', 0, 0, false)).toEqual({ changed: true, container: false, discarded: { k: 'rock', n: 3 } });
  });

  it('a basket refuses it, by click, right-click, swap or shift-click; taking one out of a basket is allowed', () => {
    const basket = new Array(18).fill(null);
    basket[3] = { k: 'acorns', n: 6 };
    // left click on an empty basket slot, and on a full one (a swap)
    for (const i of [0, 3]) {
      const s = session({}, BOOK, basket);
      const res = slotClick(s, 'container', i, 0, false);
      expect(res.refused, `slot ${i}`).toBe(KEEP_REFUSED);
      expect(res.changed).toBe(false);
      expect(s.cursor).toEqual(BOOK);
    }
    // right click: put one
    const s = session({}, BOOK, basket);
    expect(slotClick(s, 'container', 0, 2, false).refused).toBe(KEEP_REFUSED);
    expect(basket[0]).toBe(null);
    // shift-click from the pack while the basket is open
    const s2 = session({ 8: BOOK }, null, basket);
    expect(slotClick(s2, 'pack', 8, 0, true).refused).toBe(KEEP_REFUSED);
    expect(s2.pack.slots[8]).toEqual(BOOK);
    expect(basket.filter(Boolean)).toEqual([{ k: 'acorns', n: 6 }]);
    // with no basket open, shift-click still moves it between the hotbar and the rosette
    const s3 = session({ 8: BOOK });
    expect(slotClick(s3, 'pack', 8, 0, true).changed).toBe(true);
    expect(s3.pack.slots[9]).toEqual(BOOK);
    // and moving it about the pack is ordinary
    const s4 = session({ 8: BOOK });
    slotClick(s4, 'pack', 8, 0, false);
    slotClick(s4, 'pack', 2, 0, false);
    expect(filled(s4.pack)).toEqual({ 2: BOOK });
    // one that got into a basket some other way can be taken out
    const old = new Array(18).fill(null);
    old[5] = BOOK;
    const s5 = session({}, null, old);
    expect(slotClick(s5, 'container', 5, 0, false).changed).toBe(true);
    expect(s5.cursor).toEqual(BOOK);
  });

  it('returnCursor never leaves it behind: in a full pack it takes the last other stack\'s place', () => {
    const s = session({}, BOOK);
    expect(returnCursor(s)).toBe(null);
    expect(s.pack.slots[0]).toEqual(BOOK);
    const full = session({}, BOOK);
    for (let i = 0; i < 27; i++) full.pack.slots[i] = { k: 'stick', n: 64 };
    full.pack.slots[26] = { k: 'rock', n: 7 };
    const v = full.pack.version;
    expect(returnCursor(full)).toEqual({ k: 'rock', n: 7 });
    expect(full.pack.slots[26]).toEqual(BOOK);
    expect(full.cursor).toBe(null);
    expect(full.pack.version).toBeGreaterThan(v);
  });
});

describe('Pack.canExchange: room once the inputs are gone (§7.2 "Pack full")', () => {
  it('a recipe that gives back the slot it takes fits a full pack (play-test: scrape_salt waited "Pack full" for ever)', () => {
    const pack = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) pack.setSlot(i, { k: i === 0 ? 'salt_pot' : 'stone_hammer', n: 1 });
    expect(pack.canGive([{ k: 'salt', n: 1 }, { k: 'clay_pot', n: 1 }])).toBe(false);
    // once the salt pot is taken its slot is free; salt and the pot both need a slot, so only one of the two outputs fits …
    expect(pack.canExchange([['salt_pot', 1]], [{ k: 'salt', n: 1 }, { k: 'clay_pot', n: 1 }])).toBe(false);
    // … unless a stack can merge (salt onto salt)
    pack.setSlot(1, { k: 'salt', n: 3 });
    expect(pack.canExchange([['salt_pot', 1]], [{ k: 'salt', n: 1 }, { k: 'clay_pot', n: 1 }])).toBe(true);
    expect(pack.count('salt_pot')).toBe(1); // nothing changed
    expect(pack.count('salt')).toBe(3);
  });

  it('takes come off slot 26 back to 0 like take(), and a partial take leaves the rest of the stack', () => {
    const pack = new Pack();
    pack.setSlot(0, { k: 'rock', n: 5 });
    pack.setSlot(26, { k: 'rock', n: 2 });
    for (let i = 1; i < 26; i++) pack.setSlot(i, { k: 'stone_hammer', n: 1 });
    // taking 2 rock empties slot 26 only; a stick then fits there
    expect(pack.canExchange([['rock', 2]], [{ k: 'stick', n: 1 }])).toBe(true);
    // taking 1 rock leaves slot 26 with one rock: no free slot for the stick
    expect(pack.canExchange([['rock', 1]], [{ k: 'stick', n: 1 }])).toBe(false);
    expect(pack.canExchange(new Map([['rock', 7]]), [{ k: 'stick', n: 64 }, { k: 'flint', n: 1 }])).toBe(true);
    expect(pack.canExchange([], [{ k: 'stick', n: 1 }])).toBe(false); // no takes: canGive
  });
});
