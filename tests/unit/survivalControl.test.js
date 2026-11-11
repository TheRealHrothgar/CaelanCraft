// Unit tests for src/survivalControl.js — hold-to-dig and hold-to-use, the R priority, RMB use, striking mobs, where the
// belongings go and the pack screen's view (docs/DESIGN-survival.md §9.4, §6.1, §4.2–§4.4, §5.3–§5.4, §2.5, §9.8).
import { describe, it, expect } from 'vitest';
import {
  DIG_TICK_S, USE_REPEAT_GAP_S, TAP_HOLD_S, RELIGHT_HOLD_S, FUEL_STICK_S, FUEL_LOG_S, WORLD_HEIGHT, STATION_RANGE,
} from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { getItem } from '../../src/items.js';
import { Pack } from '../../src/inventory.js';
import { breakSeconds } from '../../src/harvest.js';
import {
  DigState, UseState, interactKind, chooseBelongingsCell, buildPackView, strikeKind, useActionOf, placeRefusal, handKeyOf,
  stationIdOf, waterHint, HINT, KNIFE_TIER, DIG_BLOCKED_TICK_S, STATION_TABS, STATION_OF_BLOCK, BELONGINGS_SCAN_DOWN,
  HANDBOOK_ITEM, relightMissing, wearsFromDigging, wearsFromStriking, KIT_TOOL_TYPES,
} from '../../src/survivalControl.js';
import { makeGetBlock } from '../helpers/fixtures.js';

const B = BLOCK;
const DT = 1 / 64; // exact in binary, so tick boundaries are exact

/** Run a DigState for `frames` frames; returns the step results. */
function dig(state, frames, target, need, hand = 'h', held = true, dt = DT) {
  const out = [];
  for (let i = 0; i < frames; i++) out.push(state.step(dt, target, held, need, hand));
  return out;
}

describe('handKeyOf / stationIdOf / waterHint', () => {
  it('handKeyOf ignores durability but not the slot or the key', () => {
    expect(handKeyOf(2, { k: 'flint_pick', n: 1, d: 5 })).toBe(handKeyOf(2, { k: 'flint_pick', n: 1, d: 4 }));
    expect(handKeyOf(2, { k: 'flint_pick', n: 1 })).not.toBe(handKeyOf(3, { k: 'flint_pick', n: 1 }));
    expect(handKeyOf(2, { k: 'flint_pick', n: 1 })).not.toBe(handKeyOf(2, null));
  });

  it('stationIdOf maps the four workplaces', () => {
    expect(stationIdOf(B.WORK_STUMP)).toBe('stump');
    expect(stationIdOf(B.KILN)).toBe('kiln');
    expect(stationIdOf(B.BLOOMERY)).toBe('bloomery');
    expect(stationIdOf(B.FORGE)).toBe('forge');
    for (const id of [B.STONE, B.CAMPFIRE, -1, 'constructor', null]) expect(stationIdOf(id)).toBe(null);
    expect(stationIdOf(B.WORKBENCH)).toBe('workbench');
    expect(Object.keys(STATION_OF_BLOCK).length).toBe(5);
    expect(STATION_TABS.map((t) => t.id)).toEqual(['hand', 'stump', 'kiln', 'bloomery', 'forge', 'workbench']);
  });

  it('waterHint (§4.1)', () => {
    expect(waterHint(false, false)).toBe('Fresh water · R: drink');
    expect(waterHint(true, false)).toBe('Sea water (salty) · R: drink');
    expect(waterHint(false, true)).toBe('Fresh water · R: fill the pot');
    expect(waterHint(true, true)).toBe('Sea water (salty) · R: fill the pot');
  });
});

describe('DigState (§6.1)', () => {
  const cell = { q: 3, y: 60, r: -2, id: B.DIRT };

  it('accumulates while the same cell, id and hand are held, and finishes at need', () => {
    const d = new DigState();
    const res = dig(d, 57, cell, 0.9); // 57/64 = 0.890625 s
    expect(res.at(-1).done).toBe(false);
    expect(res.at(-1).progress).toBeCloseTo(0.890625 / 0.9, 9);
    expect(d.step(DT, cell, true, 0.9, 'h').done).toBe(true); // 58/64 = 0.906 s
  });

  it('done stays true while held (pack full) until reset()', () => {
    const d = new DigState();
    dig(d, 64, cell, 0.5);
    const more = dig(d, 10, cell, 0.5);
    expect(more.every((s) => s.done && s.progress === 1 && !s.tick)).toBe(true);
    d.reset();
    expect(d.step(DT, cell, true, 0.5, 'h').done).toBe(false);
  });

  it('a different cell or a different id restarts it', () => {
    const d = new DigState();
    dig(d, 32, cell, 1);
    expect(d.t).toBeCloseTo(0.5, 9);
    d.step(DT, { ...cell, q: 4 }, true, 1, 'h');
    expect(d.t).toBeCloseTo(DT, 9);
    dig(d, 20, { ...cell, q: 4 }, 1);
    d.step(DT, { ...cell, q: 4, id: B.SAND }, true, 1, 'h');
    expect(d.t).toBeCloseTo(DT, 9);
    d.step(DT, { ...cell, q: 4, id: B.SAND, y: 61 }, true, 1, 'h');
    expect(d.t).toBeCloseTo(DT, 9);
  });

  it('releasing the button, losing the target or another hand resets it', () => {
    const d = new DigState();
    dig(d, 32, cell, 1);
    expect(d.step(DT, cell, false, 1, 'h')).toEqual({ progress: 0, done: false, tick: false });
    expect(d.t).toBe(0);
    dig(d, 32, cell, 1);
    expect(d.step(DT, null, true, 1, 'h')).toEqual({ progress: 0, done: false, tick: false });
    expect(d.t).toBe(0);
    dig(d, 32, cell, 1);
    const s = d.step(DT, cell, true, 1, 'other');
    expect(s.progress).toBeCloseTo(DT, 9);
    expect(s.tick).toBe(true);
  });

  it('a tool breaking mid-dig changes the hand key and resets', () => {
    const d = new DigState();
    dig(d, 32, cell, 1, handKeyOf(0, { k: 'flint_shovel', n: 1, d: 1 }));
    d.step(DT, cell, true, 0.9, handKeyOf(0, null));
    expect(d.t).toBeCloseTo(DT, 9);
  });

  it('reads blockId from a RaycastHit', () => {
    const d = new DigState();
    const hit = { q: 1, y: 2, r: 3, blockId: B.STONE, face: 6, distance: 2 };
    dig(d, 32, hit, 1.5);
    d.step(DT, { ...hit, blockId: B.COBBLESTONE }, true, 1.5, 'h');
    expect(d.t).toBeCloseTo(DT, 9);
  });

  it('ticks on the first frame and every DIG_TICK_S; never once done', () => {
    expect(DIG_TICK_S).toBe(0.25);
    const d = new DigState();
    const res = dig(d, 64, cell, 2);
    const ticks = res.map((s, i) => (s.tick ? i + 1 : 0)).filter(Boolean);
    expect(ticks).toEqual([1, 16, 32, 48, 64]);
    const e = new DigState();
    const done = dig(e, 40, cell, 0.5);
    expect(done.filter((s) => s.tick).length).toBe(2); // frames 1 and 16; frame 32 finishes (no tick)
    expect(done[31].done).toBe(true);
    expect(done[31].tick).toBe(false);
  });

  it('a block the hand cannot break: progress 0, never done, a dull tick every 0.5 s', () => {
    expect(DIG_BLOCKED_TICK_S).toBe(0.5);
    const d = new DigState();
    const need = breakSeconds(B.STONE, null);
    expect(need).toBe(Infinity);
    const res = dig(d, 128, { ...cell, id: B.STONE }, need);
    expect(res.every((s) => s.progress === 0 && !s.done)).toBe(true);
    expect(res.map((s, i) => (s.tick ? i + 1 : 0)).filter(Boolean)).toEqual([1, 32, 64, 96, 128]);
  });

  it('a near-instant block finishes on the first frame without a dig tick', () => {
    const d = new DigState();
    expect(d.step(0.1, cell, true, 0.05, 'h')).toEqual({ progress: 1, done: true, tick: false });
    const z = new DigState();
    expect(z.step(0, cell, true, 0, 'h')).toEqual({ progress: 1, done: true, tick: false });
  });

  it('need may change mid-dig (head goes under water): progress uses the new need', () => {
    const d = new DigState();
    dig(d, 32, cell, 1);
    const s = d.step(0, cell, true, 2.5, 'h');
    expect(s.progress).toBeCloseTo(0.5 / 2.5, 9);
    expect(s.done).toBe(false);
  });

  it('a negative dt never takes progress back', () => {
    const d = new DigState();
    dig(d, 16, cell, 1);
    const s = d.step(-5, cell, true, 1, 'h');
    expect(s.progress).toBeCloseTo(0.25, 9);
  });
});

describe('UseState (§4.5)', () => {
  const eat = { kind: 'eat', key: 'honeyberries', needS: 0.8 };

  it('fills over needS, is done once, then waits USE_REPEAT_GAP_S before the next', () => {
    expect(USE_REPEAT_GAP_S).toBe(0.25);
    const u = new UseState();
    let dones = 0;
    const doneAt = [];
    for (let i = 1; i <= 192; i++) {
      // 3 s at 64 fps
      const s = u.step(DT, eat, true);
      if (s.done) {
        dones++;
        doneAt.push(i * DT);
      }
    }
    // 0.8 done, gap 0.25, next 0.8 → 1.85, → 2.9
    expect(dones).toBe(3);
    expect(doneAt[0]).toBeCloseTo(0.8125, 3);
    expect(doneAt[1] - doneAt[0]).toBeCloseTo(1.05, 1);
  });

  it('progress rises, and is 0 during the gap', () => {
    const u = new UseState();
    const a = u.step(0.4, eat, true);
    expect(a).toEqual({ progress: 0.5, done: false });
    expect(u.step(0.4, eat, true)).toEqual({ progress: 1, done: true });
    expect(u.step(0.1, eat, true)).toEqual({ progress: 0, done: false });
    expect(u.step(0.1, eat, true)).toEqual({ progress: 0, done: false });
    const s = u.step(0.1, eat, true); // gap passed 0.05 s ago: that time counts toward the next use
    expect(s.done).toBe(false);
    expect(s.progress).toBeCloseTo(0.05 / 0.8, 9);
  });

  it('releasing early cancels; holding again starts over', () => {
    const u = new UseState();
    u.step(0.7, eat, true);
    expect(u.step(0.05, eat, false)).toEqual({ progress: 0, done: false });
    expect(u.step(0.7, eat, true).done).toBe(false);
    expect(u.step(0.15, eat, true).done).toBe(true);
  });

  it('another action (another item, kind or target) restarts', () => {
    const u = new UseState();
    u.step(0.7, eat, true);
    expect(u.step(0.2, { ...eat, key: 'pine_nuts', needS: 1 }, true)).toEqual({ progress: 0.2, done: false });
    const tapA = { kind: 'tap', key: 'clay_pot', needS: TAP_HOLD_S, target: [1, 60, 2] };
    u.step(3.9, tapA, true);
    expect(u.step(0.2, { ...tapA, target: [1, 61, 2] }, true).done).toBe(false);
    expect(u.step(0.2, { ...tapA, target: { q: 1, y: 61, r: 2 } }, true).done).toBe(false); // same cell, other form
    expect(u.step(3.6, { ...tapA, target: '1,61,2' }, true).done).toBe(true);
  });

  it('a null action resets', () => {
    const u = new UseState();
    u.step(0.7, eat, true);
    expect(u.step(0.1, null, true)).toEqual({ progress: 0, done: false });
    expect(u.step(0.7, eat, true).done).toBe(false);
  });

  it('repeat: false is done once per hold (wearing)', () => {
    const u = new UseState();
    const wear = { kind: 'wear', key: 'straw_hat', needS: 0, repeat: false };
    expect(u.step(DT, wear, true)).toEqual({ progress: 1, done: true });
    for (let i = 0; i < 100; i++) expect(u.step(DT, wear, true).done).toBe(false);
    u.step(DT, wear, false);
    expect(u.step(DT, wear, true).done).toBe(true);
  });

  it('relight (3 s) and tap (4 s) holds', () => {
    expect(RELIGHT_HOLD_S).toBe(3);
    const u = new UseState();
    const relight = { kind: 'pit_relight', key: null, needS: RELIGHT_HOLD_S, target: [0, 60, 0] };
    expect(u.step(2.9, relight, true).done).toBe(false);
    expect(u.step(0.11, relight, true).done).toBe(true);
  });
});

describe('useActionOf (RMB in Survival)', () => {
  it('food is eaten; food that returns a pot is drunk', () => {
    expect(useActionOf({ k: 'roast_pork', n: 3 })).toEqual({ kind: 'eat', key: 'roast_pork', needS: 1.6 });
    expect(useActionOf({ k: 'snow', n: 3 })).toEqual({ kind: 'eat', key: 'snow', needS: 0.6 });
    for (const k of ['pot_water', 'pot_boiled', 'pot_seawater', 'pot_sap']) {
      expect(useActionOf({ k, n: 1 })).toEqual({ kind: 'drink', key: k, needS: 1.0 });
    }
  });

  it('bandages, clothes and blocks', () => {
    expect(useActionOf({ k: 'fibre_bandage', n: 2 })).toEqual({ kind: 'bandage', key: 'fibre_bandage', needS: 1.5 });
    expect(useActionOf({ k: 'leather_coat', n: 1 })).toEqual({ kind: 'wear', key: 'leather_coat', needS: 0, repeat: false });
    expect(useActionOf({ k: 'dirt', n: 5 })).toEqual({ kind: 'place', key: 'dirt', block: B.DIRT });
    expect(useActionOf({ k: 'honeyberry_bush', n: 1 })).toEqual({ kind: 'place', key: 'honeyberry_bush', block: B.HONEYBERRY_BUSH_BARE });
    expect(useActionOf({ k: 'campfire', n: 1 })).toEqual({ kind: 'place', key: 'campfire', block: B.CAMPFIRE });
  });

  it('tools, materials, unknown keys and an empty hand do nothing', () => {
    expect(useActionOf({ k: 'flint_axe', n: 1 })).toBe(null);
    expect(useActionOf({ k: 'rock', n: 1 })).toBe(null);
    expect(useActionOf({ k: 'pot_snow', n: 1 })).toBe(null); // a material: only boiled
    expect(useActionOf({ k: 'unpeeled_cactus_fruit', n: 1 })).toBe(null);
    expect(useActionOf({ k: 'nope', n: 1 })).toBe(null);
    expect(useActionOf(null)).toBe(null);
  });
});

describe('placeRefusal (§5.3)', () => {
  const ground = makeGetBlock({ '0,59,0': B.DIRT, '1,59,0': B.WATER, '2,59,0': B.TUSSOCK });

  it('a pop-off block over a cell that is not solid is refused', () => {
    expect(placeRefusal(ground, B.TUSSOCK, 0, 60, 0)).toBe(null);
    expect(placeRefusal(ground, B.TUSSOCK, 5, 60, 5)).toBe(HINT.needsGround);
    expect(placeRefusal(ground, B.CAMPFIRE, 1, 60, 0)).toBe('needs solid ground'); // over water
    expect(placeRefusal(ground, B.HONEYBERRY_BUSH_BARE, 2, 60, 0)).toBe('needs solid ground'); // over a plant
    expect(placeRefusal(ground, B.CAMPFIRE, 0, 60, 0)).toBe(null);
  });

  it('other blocks are never refused here', () => {
    expect(placeRefusal(ground, B.STONE, 5, 60, 5)).toBe(null);
    expect(placeRefusal(ground, B.WICKER_BASKET, 5, 60, 5)).toBe(null);
    expect(placeRefusal(ground, B.SAND, 5, 60, 5)).toBe(null);
  });
});

describe('strikeKind (§4.3, §6.1)', () => {
  it('bare hands never wound a pig: they only shove it', () => {
    expect(strikeKind('pig', null)).toEqual({ call: 'hit', power: 0 });
    expect(strikeKind('pig', 'rock')).toEqual({ call: 'hit', power: 0 }); // a non-tool item is a bare hand
    expect(strikeKind('pig', undefined)).toEqual({ call: 'hit', power: 0 });
  });

  it('any held tool wounds a pig with its power', () => {
    expect(strikeKind('pig', getItem('stone_axe').tool)).toEqual({ call: 'wound', power: 2 });
    expect(strikeKind('pig', 'flint_spear')).toEqual({ call: 'wound', power: 3 });
    expect(strikeKind('pig', 'fire_drill')).toEqual({ call: 'wound', power: 1 });
  });

  it('zombies are hit with the tool power, bare hands 1', () => {
    expect(strikeKind('zombie', null)).toEqual({ call: 'hit', power: 1 });
    expect(strikeKind('zombie', 'steel_sword')).toEqual({ call: 'hit', power: 5 });
    expect(strikeKind('zombie', getItem('bronze_axe').tool)).toEqual({ call: 'hit', power: 3 });
  });
});

describe('interactKind: the R priority (§9.4)', () => {
  /** A PackOps-like pack built from { key: count }; tools by key. */
  function fakePack(items = {}) {
    const p = new Pack();
    let i = 0;
    for (const [k, n] of Object.entries(items)) p.slots[i++] = { k, n };
    return p;
  }
  const hit = (blockId, distance = 3, q = 1, y = 60, r = 2) => ({ q, y, r, blockId, distance });
  const water = (distance = 2, q = 4, y = 59, r = 5, blockId = B.WATER) => ({ q, y, r, blockId, distance });
  const SPOT = { raw_pork: 'skewer', wild_tuber: 'skewer', roast_pork: 'skewer', pot_water: 'centre', greenware_pot: 'centre', pot_snow: 'embers' };
  const fireSpotKind = (k) => SPOT[k] ?? null;
  /** A fireView giving these spots (index → item) for every cell. */
  const fireView = (spots) => () => ({ spots: Array.from({ length: 7 }, (_, i) => (spots[i] ? { k: spots[i] } : null)), fuel: 100 });
  const ctx = (o) => ({ hit: null, waterHit: null, headInWater: false, selectedKey: null, pack: fakePack(), fireSpotKind, ...o });

  describe('1. campfire', () => {
    it('puts a skewer food on a free skewer', () => {
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'raw_pork', fireView: fireView({}) })))
        .toEqual({ kind: 'fire_put', q: 1, y: 60, r: 2, key: 'raw_pork', spot: 'skewer' });
    });

    it('a fire with no entry (view null) has every spot free', () => {
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'wild_tuber', fireView: () => null })).kind).toBe('fire_put');
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'wild_tuber' })).kind).toBe('fire_put');
    });

    it('all six skewers taken: no put, so it takes', () => {
      const full = fireView({ 0: 'raw_pork', 1: 'raw_pork', 2: 'raw_pork', 3: 'raw_pork', 4: 'raw_pork', 5: 'raw_pork' });
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'raw_pork', fireView: full })).kind).toBe('fire_take');
    });

    it('puts a centre pot in the embers when spot 6 is free (centre or embers)', () => {
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'pot_water', fireView: fireView({ 0: 'raw_pork' }) })))
        .toEqual({ kind: 'fire_put', q: 1, y: 60, r: 2, key: 'pot_water', spot: 'centre' });
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'pot_snow', fireView: fireView({}) })).spot).toBe('centre');
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'pot_water', fireView: fireView({ 6: 'greenware_pot' }) })).kind).toBe('fire_take');
    });

    it('feeds a stick or a log', () => {
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'stick' })))
        .toEqual({ kind: 'fire_feed', q: 1, y: 60, r: 2, key: 'stick', seconds: FUEL_STICK_S });
      for (const k of ['oak_log', 'spruce_log', 'birch_log']) {
        expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: k }))).toEqual({ kind: 'fire_feed', q: 1, y: 60, r: 2, key: k, seconds: FUEL_LOG_S });
      }
      expect(FUEL_STICK_S).toBe(40);
      expect(FUEL_LOG_S).toBe(300);
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'oak_planks' })).kind).toBe('fire_hint');
    });

    it('otherwise takes when anything is on it, else the hint', () => {
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), fireView: fireView({ 3: 'roast_pork' }) }))).toEqual({ kind: 'fire_take', q: 1, y: 60, r: 2 });
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'rock', fireView: fireView({ 6: 'pot_water' }) })).kind).toBe('fire_take');
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), fireView: fireView({}) })))
        .toEqual({ kind: 'fire_hint', q: 1, y: 60, r: 2, hint: 'Campfire · hold food or a pot and press R' });
      expect(interactKind(ctx({ hit: hit(B.CAMPFIRE), selectedKey: 'raw_pork', fireSpotKind: undefined })).kind).toBe('fire_hint');
    });
  });

  describe('2. cold fire pit', () => {
    const relightKit = { fire_drill: 1, birch_bark: 1, stick: 3 };

    it('takes what is on it first', () => {
      expect(interactKind(ctx({ hit: hit(B.FIRE_PIT), pack: fakePack(relightKit), selectedKey: 'stick', fireView: fireView({ 2: 'raw_pork' }) })))
        .toEqual({ kind: 'pit_take', q: 1, y: 60, r: 2 });
    });

    it('relights with a fire drill, 1 tinder and 3 sticks in the pack', () => {
      expect(interactKind(ctx({ hit: hit(B.FIRE_PIT), pack: fakePack(relightKit), fireView: () => null })))
        .toEqual({ kind: 'pit_relight', q: 1, y: 60, r: 2, needS: RELIGHT_HOLD_S, hint: HINT.pit });
      expect(interactKind(ctx({ hit: hit(B.FIRE_PIT), pack: fakePack({ fire_drill: 1, plant_fibre: 1, stick: 9 }) })).kind).toBe('pit_relight');
    });

    it('anything missing gives the hint, naming what is missing (play-test: a fire died at night for want of one stick)', () => {
      const cases = [
        [{ birch_bark: 1, stick: 3 }, 'a fire drill'],
        [{ fire_drill: 1, stick: 3 }, 'tinder'],
        [{ fire_drill: 1, birch_bark: 1, stick: 2 }, '1 more stick'],
        [{ fire_drill: 1, birch_bark: 1 }, '3 more sticks'],
        [{}, 'a fire drill, tinder and 3 more sticks'],
      ];
      for (const [kit, missing] of cases) {
        expect(interactKind(ctx({ hit: hit(B.FIRE_PIT), pack: fakePack(kit) })), JSON.stringify(kit))
          .toEqual({ kind: 'pit_hint', q: 1, y: 60, r: 2, hint: `Cold Fire Pit · relight needs ${missing}` });
      }
      expect(relightMissing(fakePack({ fire_drill: 1, birch_bark: 1, stick: 3 }))).toEqual([]);
      expect(HINT.pit).toBe('Cold Fire Pit · hold R to relight (drill, tinder, 3 sticks)'); // the relight hint itself
    });
  });

  it('3. picks ripe bushes, prickly pears and litter, whatever is in the hand', () => {
    for (const id of [B.HONEYBERRY_BUSH, B.PRICKLY_PEAR, B.LOOSE_STONES, B.FALLEN_BRANCHES]) {
      expect(interactKind(ctx({ hit: hit(id), selectedKey: 'clay_pot' }))).toEqual({ kind: 'pick', q: 1, y: 60, r: 2, id });
    }
    expect(interactKind(ctx({ hit: hit(B.HONEYBERRY_BUSH_BARE) }))).toBe(null);
    expect(interactKind(ctx({ hit: hit(B.PRICKLY_PEAR_BARE) }))).toBe(null);
  });

  describe('4. birch log', () => {
    it('taps with an empty clay pot selected and a knife ≥ 2 in the pack', () => {
      expect(KNIFE_TIER).toBe(2);
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG), selectedKey: 'clay_pot', pack: fakePack({ clay_pot: 1, flint_knife: 1 }) })))
        .toEqual({ kind: 'tap', q: 1, y: 60, r: 2, needS: TAP_HOLD_S, hint: HINT.tap });
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG), selectedKey: 'clay_pot', pack: fakePack({ steel_knife: 1 }) })).kind).toBe('tap');
    });

    it('the hint otherwise (no pot, no knife, a stone knife does not exist)', () => {
      const hint = { kind: 'tap_hint', q: 1, y: 60, r: 2, hint: 'Birch Log · R: tap sap (needs a knife and an empty pot)' };
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG), selectedKey: 'pot_water', pack: fakePack({ flint_knife: 1 }) }))).toEqual(hint);
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG), selectedKey: 'clay_pot', pack: fakePack({ clay_pot: 1 }) }))).toEqual(hint);
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG) }))).toEqual(hint);
    });

    it('once a day per cell', () => {
      const tapped = (q, y, r) => q === 1 && y === 60 && r === 2;
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG), selectedKey: 'clay_pot', pack: fakePack({ flint_knife: 1 }), tappedToday: tapped })))
        .toEqual({ kind: 'tap_hint', q: 1, y: 60, r: 2, hint: 'Birch Log · tapped today' });
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG, 3, 9), selectedKey: 'clay_pot', pack: fakePack({ flint_knife: 1 }), tappedToday: tapped })).kind).toBe('tap');
    });

    it('other logs are not tapped', () => {
      expect(interactKind(ctx({ hit: hit(B.OAK_LOG), selectedKey: 'clay_pot', pack: fakePack({ flint_knife: 1 }) }))).toBe(null);
    });
  });

  it('5–7. basket, belongings, Sleeping Hide and workplaces', () => {
    expect(interactKind(ctx({ hit: hit(B.WICKER_BASKET) }))).toEqual({ kind: 'basket', q: 1, y: 60, r: 2, hint: HINT.basket });
    expect(interactKind(ctx({ hit: hit(B.REMAINS) }))).toEqual({ kind: 'belongings', q: 1, y: 60, r: 2, hint: 'Your Belongings · R: take back' });
    expect(interactKind(ctx({ hit: hit(B.SLEEPING_HIDE) }))).toEqual({ kind: 'hide', q: 1, y: 60, r: 2, hint: 'Sleeping Hide · R: wake here' });
    expect(interactKind(ctx({ hit: hit(B.KILN) }))).toEqual({ kind: 'station', q: 1, y: 60, r: 2, station: 'kiln', hint: 'Kiln · R: open Making' });
    expect(interactKind(ctx({ hit: hit(B.WORK_STUMP) })).station).toBe('stump');
    expect(interactKind(ctx({ hit: hit(B.BLOOMERY) })).station).toBe('bloomery');
    expect(interactKind(ctx({ hit: hit(B.FORGE) })).hint).toBe('Forge · R: open Making');
  });

  it('7. a workplace in the crosshair but beyond STATION_RANGE of the feet is `station_far`: R does nothing, the hint says to step closer', () => {
    // play-test: R reaches 5 cells, Making counts a workplace as near within 3, so R on a far kiln opened a Making where
    // every kiln card said "build a Kiln nearby"
    const near = (s) => s === 'stump';
    expect(interactKind(ctx({ hit: hit(B.KILN), stationNear: near })))
      .toEqual({ kind: 'station_far', q: 1, y: 60, r: 2, station: 'kiln', hint: `Kiln · step within ${STATION_RANGE} cells to work here` });
    expect(interactKind(ctx({ hit: hit(B.WORK_STUMP), stationNear: near })).kind).toBe('station');
    expect(interactKind(ctx({ hit: hit(B.FORGE), stationNear: () => false })).hint).toBe('Forge · step within 3 cells to work here');
    expect(interactKind(ctx({ hit: hit(B.KILN) })).kind).toBe('station'); // no stationNear given: every workplace counts as near
  });

  describe('8. water', () => {
    it('drinks water nearer than the hit, or with no hit, whatever is in the hand', () => {
      expect(interactKind(ctx({ hit: hit(B.STONE, 5), waterHit: water(2), selectedKey: 'flint_pick' })))
        .toEqual({ kind: 'drink', q: 4, y: 59, r: 5 });
      expect(interactKind(ctx({ waterHit: water(2, 0, 0, 0, B.WATER_FLOW_2) }))).toEqual({ kind: 'drink', q: 0, y: 0, r: 0 });
    });

    it('fills an empty clay pot instead', () => {
      expect(interactKind(ctx({ waterHit: water(), selectedKey: 'clay_pot' }))).toEqual({ kind: 'fill', q: 4, y: 59, r: 5 });
    });

    it('says whether the water is salty when the context can tell', () => {
      const salty = (q) => q > 0;
      expect(interactKind(ctx({ waterHit: water(), salty }))).toEqual({ kind: 'drink', q: 4, y: 59, r: 5, salty: true, hint: 'Sea water (salty) · R: drink' });
      expect(interactKind(ctx({ waterHit: water(2, -4), selectedKey: 'clay_pot', salty })))
        .toEqual({ kind: 'fill', q: -4, y: 59, r: 5, salty: false, hint: 'Fresh water · R: fill the pot' });
    });

    it('water behind the hit is not drunk; a waterHit that is not water is ignored', () => {
      expect(interactKind(ctx({ hit: hit(B.STONE, 2), waterHit: water(5) }))).toBe(null);
      expect(interactKind(ctx({ hit: hit(B.STONE, 2), waterHit: hit(B.STONE, 2) }))).toBe(null);
      expect(interactKind(ctx({ waterHit: hit(B.DIRT, 1) }))).toBe(null);
    });

    it('a target seen through nearer water does not take the R (§4.2 over the §9.4 order)', () => {
      expect(interactKind(ctx({ hit: hit(B.BIRCH_LOG, 4), waterHit: water(1), selectedKey: 'clay_pot', pack: fakePack({ flint_knife: 1 }) })).kind).toBe('fill');
      expect(interactKind(ctx({ hit: hit(B.LOOSE_STONES, 3), waterHit: water(2) })).kind).toBe('drink');
      // and a target in front of the water does
      expect(interactKind(ctx({ hit: hit(B.LOOSE_STONES, 1), waterHit: water(2) })).kind).toBe('pick');
    });
  });

  it('9. head under water: drink here; a block target still comes first', () => {
    expect(interactKind(ctx({ headInWater: true, selectedKey: 'clay_pot' }))).toEqual({ kind: 'drink_here' });
    expect(interactKind(ctx({ headInWater: true, hit: hit(B.STONE) }))).toEqual({ kind: 'drink_here' });
    expect(interactKind(ctx({ headInWater: true, hit: hit(B.WICKER_BASKET) })).kind).toBe('basket');
  });

  it('10. the handbook in hand: read it (§14.2), after every target and water case, before barrels and runes', () => {
    const book = { selectedKey: 'handbook' };
    expect(HANDBOOK_ITEM).toBe('handbook');
    expect(HINT.read).toBe('Handbook · R: read');
    expect(interactKind(ctx({ ...book }))).toEqual({ kind: 'read', hint: 'Handbook · R: read' });
    expect(interactKind(ctx({ ...book, hit: hit(B.STONE) })).kind).toBe('read');
    expect(interactKind(ctx({ ...book, hit: hit(B.BLAST_BARREL) })).kind).toBe('read');
    expect(interactKind(ctx({ ...book, hit: hit(B.RUNE_BLOCK) })).kind).toBe('read');
    // anything with a higher priority still wins
    expect(interactKind(ctx({ ...book, hit: hit(B.LOOSE_STONES) })).kind).toBe('pick');
    expect(interactKind(ctx({ ...book, hit: hit(B.CAMPFIRE), fireView: fireView({ 2: 'roast_pork' }) })).kind).toBe('fire_take');
    expect(interactKind(ctx({ ...book, hit: hit(B.WICKER_BASKET) })).kind).toBe('basket');
    expect(interactKind(ctx({ ...book, waterHit: water(2) })).kind).toBe('drink');
    expect(interactKind(ctx({ ...book, headInWater: true })).kind).toBe('drink_here');
  });

  it("11. otherwise null: today's barrel and rune behaviour", () => {
    expect(interactKind(ctx({ hit: hit(B.BLAST_BARREL) }))).toBe(null);
    expect(interactKind(ctx({ hit: hit(B.RUNE_BLOCK) }))).toBe(null);
    expect(interactKind(ctx({ hit: hit(B.STONE) }))).toBe(null);
    expect(interactKind(ctx({}))).toBe(null);
    expect(interactKind(ctx({ selectedKey: 'rock' }))).toBe(null);
  });
});

describe('§14.2 RMB with the handbook', () => {
  it('reads it at once: needS 0, once per press (no repeat)', () => {
    expect(useActionOf({ k: 'handbook', n: 1 })).toEqual({ kind: 'read', key: 'handbook', needS: 0, repeat: false });
  });
  it('a UseState completes the read on the first frame and does not repeat while held', () => {
    const u = new UseState();
    const act = useActionOf({ k: 'handbook', n: 1 });
    expect(u.step(DT, act, true).done).toBe(true);
    for (let i = 0; i < 64; i++) expect(u.step(DT, act, true).done).toBe(false);
  });
});

describe('chooseBelongingsCell (§2.5)', () => {
  it('standing on the ground: the feet cell', () => {
    const g = makeGetBlock({ '0,59,0': B.GRASS_BLOCK });
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 60, 0]);
  });

  it('in mid-air: scans down to the ground (at most 8 cells)', () => {
    const g = makeGetBlock({ '2,49,-3': B.STONE });
    expect(chooseBelongingsCell(g, 2, 55, -3)).toEqual([2, 50, -3]);
    expect(chooseBelongingsCell(g, 2, 58, -3)).toEqual([2, 50, -3]); // exactly 8 down
    expect(BELONGINGS_SCAN_DOWN).toBe(8);
    expect(chooseBelongingsCell(g, 2, 59, -3)).toEqual([2, 59, -3]); // 9 down: too far, stays at the feet
  });

  it('on a ledge: the feet cell when the column below it is solid', () => {
    const g = makeGetBlock({ '0,59,0': B.STONE, '1,40,0': B.STONE });
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 60, 0]);
    // a feet cell just past the edge falls to the ledge below if it is near enough
    const h = makeGetBlock({ '0,59,0': B.STONE, '1,55,0': B.STONE });
    expect(chooseBelongingsCell(h, 1, 60, 0)).toEqual([1, 56, 0]);
  });

  it('in water: at the bottom of the water, which is replaceable', () => {
    const g = makeGetBlock({ '0,57,0': B.SAND, '0,58,0': B.WATER, '0,59,0': B.WATER, '0,60,0': B.WATER });
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 58, 0]);
    const flow = makeGetBlock({ '0,57,0': B.SAND, '0,58,0': B.WATER_FLOW_3 });
    expect(chooseBelongingsCell(flow, 0, 58, 0)).toEqual([0, 58, 0]);
  });

  it('a taken ground cell (a plant, a campfire) tries up to 3 above', () => {
    const g = makeGetBlock({ '0,59,0': B.DIRT, '0,60,0': B.TUSSOCK, '0,61,0': B.OAK_LEAVES });
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 62, 0]);
  });

  it('boxed in above: tries the 6 side neighbours in HEX_DIRS order', () => {
    const map = { '0,59,0': B.STONE };
    for (let y = 60; y <= 63; y++) map[`0,${y},0`] = B.STONE;
    map['1,60,0'] = B.STONE; // E taken
    const g = makeGetBlock(map);
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 60, 1]); // SE
  });

  it('boxed in completely (a burial): the feet cell itself, so the heap replaces the block that killed the player', () => {
    // play-test: a `buried` death lost every belonging, because only AIR or a liquid could take the REMAINS
    const g = makeGetBlock({}, B.STONE);
    expect(chooseBelongingsCell(g, 0, 60, 0)).toEqual([0, 60, 0]);
    // never bedrock: the first candidate that is not (the cell above the feet here)
    const cells = new Map([['0,60,0', B.BEDROCK]]);
    expect(chooseBelongingsCell(makeGetBlock(cells, B.STONE), 0, 60, 0)).toEqual([0, 61, 0]);
    // all bedrock: lost
    expect(chooseBelongingsCell(makeGetBlock({}, B.BEDROCK), 0, 60, 0)).toBe(null);
  });

  it('negative coordinates, the world top, the void and garbage', () => {
    const g = makeGetBlock({ '-20,59,-7': B.DIRT });
    expect(chooseBelongingsCell(g, -20, 60, -7)).toEqual([-20, 60, -7]);
    const top = makeGetBlock({ [`5,${WORLD_HEIGHT - 2},5`]: B.STONE });
    expect(chooseBelongingsCell(top, 5, WORLD_HEIGHT + 3, 5)).toEqual([5, WORLD_HEIGHT - 1, 5]);
    expect(chooseBelongingsCell(g, 0, -1, 0)).toBe(null);
    expect(chooseBelongingsCell(g, NaN, 60, 0)).toBe(null);
    // at the bottom of the world with nothing below: the feet cell
    expect(chooseBelongingsCell(makeGetBlock({}), 0, 0, 0)).toEqual([0, 0, 0]);
  });
});

describe('buildPackView (§9.8)', () => {
  function packWith(slots = {}, wear = {}) {
    const p = new Pack();
    for (const [i, s] of Object.entries(slots)) p.slots[Number(i)] = s;
    for (const [i, s] of Object.entries(wear)) p.wear[Number(i)] = s;
    return p;
  }

  it('has the view shape, with copied stacks', () => {
    const pack = packWith({ 0: { k: 'rock', n: 3 } }, { 1: { k: 'grass_cape', n: 1 } });
    const view = buildPackView({ pack, selected: 4, cursor: null });
    expect(Object.keys(view).sort()).toEqual(['container', 'cursor', 'hover', 'lanes', 'message', 'recipes', 'selected', 'slots', 'stations', 'tab', 'wear'].sort());
    expect(view.message).toBe(null);
    expect(view.slots.length).toBe(27);
    expect(view.slots[0]).toEqual({ k: 'rock', n: 3 });
    expect(view.slots[0]).not.toBe(pack.slots[0]);
    expect(view.wear).toEqual([null, { k: 'grass_cape', n: 1 }, null]);
    expect(view.selected).toBe(4);
    expect(view.cursor).toBe(null);
    expect(view.hover).toBe(null);
    expect(view.container).toBe(null);
    expect(view.tab).toBe('all');
    expect(view.recipes).toEqual([]);
    expect(view.lanes).toEqual([]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('hover: the hovered slot, else the cursor, with name and durability', () => {
    const pack = packWith({ 2: { k: 'flint_axe', n: 1, d: 30 } }, { 0: { k: 'straw_hat', n: 1 } });
    const basket = new Array(18).fill(null);
    basket[3] = { k: 'stick', n: 5 };
    const base = { pack, selected: 0, container: { kind: 'basket', slots: basket } };
    expect(buildPackView({ ...base, hover: { area: 'pack', index: 2 } }).hover)
      .toEqual({ area: 'pack', index: 2, k: 'flint_axe', n: 1, name: 'Flint Axe', durability: 30, maxDurability: 90 });
    expect(buildPackView({ ...base, hover: { area: 'wear', index: 0 } }).hover.name).toBe('Straw Hat');
    expect(buildPackView({ ...base, hover: { area: 'container', index: 3 } }).hover)
      .toEqual({ area: 'container', index: 3, k: 'stick', n: 5, name: 'Stick', durability: 0, maxDurability: 0 });
    // an empty hovered slot shows the cursor's item
    expect(buildPackView({ ...base, hover: { area: 'pack', index: 9 }, cursor: { k: 'flint_pick', n: 1 } }).hover)
      .toEqual({ area: 'cursor', index: -1, k: 'flint_pick', n: 1, name: 'Flint Pick', durability: 90, maxDurability: 90 });
    expect(buildPackView({ ...base, hover: { area: 'container', index: 0 } }).hover).toBe(null);
    expect(buildPackView({ pack, selected: 0, hover: { area: 'container', index: 3 } }).hover).toBe(null);
  });

  it('container: title by kind (or given), copied slots', () => {
    const pack = new Pack();
    const slots = [{ k: 'rock', n: 1 }, null];
    expect(buildPackView({ pack, selected: 0, container: { kind: 'basket', slots } }).container)
      .toEqual({ title: 'Wicker Basket', slots: [{ k: 'rock', n: 1 }, null] });
    expect(buildPackView({ pack, selected: 0, container: { kind: 'remains', slots } }).container.title).toBe('Your Belongings');
    expect(buildPackView({ pack, selected: 0, container: { title: 'Mine', slots } }).container.title).toBe('Mine');
    expect(buildPackView({ pack, selected: 0, container: { kind: 'basket', slots } }).container.slots[0]).not.toBe(slots[0]);
  });

  it('stations: the six tabs; Hands is always near, the rest when findStations found them', () => {
    const view = buildPackView({ pack: new Pack(), selected: 0, stations: { hand: true, kiln: [1, 2, 3] } });
    expect(view.stations).toEqual([
      { id: 'hand', label: 'Hands', near: true },
      { id: 'stump', label: 'Stump', near: false },
      { id: 'kiln', label: 'Kiln', near: true },
      { id: 'bloomery', label: 'Bloomery', near: false },
      { id: 'forge', label: 'Forge', near: false },
      { id: 'workbench', label: 'Bench', near: false },
    ]);
    expect(buildPackView({ pack: new Pack(), selected: 0 }).stations.filter((s) => s.near).map((s) => s.id)).toEqual(['hand']);
  });

  it('recipes: those of the tab in the given order; an unknown tab is All', () => {
    const recipes = [{ id: 'charcoal', station: 'kiln' }, { id: 'cord', station: 'hand' }, { id: 'clay_pot', station: 'kiln' }];
    const pack = new Pack();
    expect(buildPackView({ pack, selected: 0, recipes, tab: 'kiln' }).recipes.map((r) => r.id)).toEqual(['charcoal', 'clay_pot']);
    expect(buildPackView({ pack, selected: 0, recipes, tab: 'hand' }).recipes.map((r) => r.id)).toEqual(['cord']);
    expect(buildPackView({ pack, selected: 0, recipes, tab: 'all' }).recipes.map((r) => r.id)).toEqual(['charcoal', 'cord', 'clay_pot']);
    const odd = buildPackView({ pack, selected: 0, recipes, tab: 'constructor' });
    expect(odd.tab).toBe('all');
    expect(odd.recipes.length).toBe(3);
  });

  it('lanes: one row per busy station; job names and progress from several shapes', () => {
    const lanes = [
      { station: 'hand', jobs: [] },
      { station: 'kiln', jobs: [{ name: 'Copper Ingot', progress: 0.25, waiting: 'Kiln too far' }, { recipeId: 'charcoal', t: 10, seconds: 40 }] },
      { station: 'forge', jobs: [{ out: { k: 'steel_bar', n: 1 }, progress: 7 }] },
    ];
    const view = buildPackView({ pack: new Pack(), selected: 0, lanes });
    expect(view.lanes).toEqual([
      { station: 'kiln', label: 'Kiln', jobs: [{ name: 'Copper Ingot', progress: 0.25, waiting: 'Kiln too far' }, { name: 'charcoal', progress: 0.25, waiting: false }] },
      { station: 'forge', label: 'Forge', jobs: [{ name: 'Steel Bar', progress: 1, waiting: false }] },
    ]);
  });
});

describe('wear on a dig or a blow (§6.1 step 6)', () => {
  const tool = (k) => getItem(k).tool;
  it('a dig wears only digging tools: axe, shovel, pick, knife, hammer', () => {
    for (const k of ['stone_axe', 'flint_shovel', 'flint_pick', 'flint_knife', 'stone_hammer', 'steel_axe', 'iron_hammer']) {
      expect(wearsFromDigging(tool(k)), k).toBe(true);
    }
    // play-test: a Crucible (20), Casting Mold (12) or Fire Drill (8) in the hand was used up by digging dirt
    for (const k of ['crucible', 'casting_mold', 'fire_drill', 'flint_spear', 'bronze_sword']) expect(wearsFromDigging(tool(k)), k).toBe(false);
    expect(wearsFromDigging(null)).toBe(false);
    expect(wearsFromDigging(undefined)).toBe(false);
  });

  it('a blow that lands wears everything but the kiln kit', () => {
    for (const k of ['stone_axe', 'flint_spear', 'bronze_sword', 'flint_pick']) expect(wearsFromStriking(tool(k)), k).toBe(true);
    for (const k of ['crucible', 'casting_mold', 'fire_drill']) expect(wearsFromStriking(tool(k)), k).toBe(false);
    expect([...KIT_TOOL_TYPES].sort()).toEqual(['crucible', 'firestarter', 'mold']);
    expect(wearsFromStriking(null)).toBe(false);
  });
});

describe('buildPackView: the screen\'s own message line (§9.8)', () => {
  it('carries the message given, with its error flag, else null', () => {
    const pack = new Pack();
    expect(buildPackView({ pack, selected: 0, message: { text: 'The handbook stays with you.', error: true } }).message)
      .toEqual({ text: 'The handbook stays with you.', error: true });
    expect(buildPackView({ pack, selected: 0, message: { text: 'Making 5 × Cord' } }).message).toEqual({ text: 'Making 5 × Cord', error: false });
    expect(buildPackView({ pack, selected: 0, message: { text: '' } }).message).toBe(null);
    expect(buildPackView({ pack, selected: 0, message: null }).message).toBe(null);
  });
});
