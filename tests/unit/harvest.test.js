// Unit tests for src/harvest.js — BLOCK_RULES, break times, drops, picking, tapping, regrowth and mob drops
// (docs/DESIGN-survival.md §6, §4.2–§4.3).
import { describe, it, expect } from 'vitest';
import { REGROW_MEAN_S, MAX_REGROW_TRACKED, SEA_LEVEL } from '../../src/config.js';
import { BLOCK, BLOCKS, BLOCK_COUNT, isWater } from '../../src/blocks.js';
import { ITEMS, TOOL_TYPES, TIER_SPEED, isItemKey, itemForBlock, getItem } from '../../src/items.js';
import {
  BLOCK_RULES, ruleFor, canHarvest, breakSeconds, harvestHint, rollDrops, rollGroups, PICKABLE, isPickable, pick, tap,
  Tapped, Regrowth, RIPE_OF, ripeOf, MOB_DROPS, rollMobDrops, toolPower, UNDERWATER_DIG_FACTOR, MIN_BREAK_S,
  HAND_GATHER, handGatherHint, withArticle, DIG_TOOL_TYPES, isDeep, DEEP_BELOW_SEA,
} from '../../src/harvest.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { mulberry32 } from '../../src/noise.js';

const B = BLOCK;
const tool = (key) => getItem(key).tool;
const HAND = null;
/** A random() that returns the given values in turn (then repeats the last). */
function seq(...vals) {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
}
/** Drops as { key: n }. */
function asMap(stacks) {
  const out = {};
  for (const s of stacks) out[s.k] = s.n;
  return out;
}
/** Roll `times` times; returns { key: [counts…] } and how often each key appeared. */
function sample(fn, times, seed = 1) {
  const random = mulberry32(seed);
  const seen = {};
  for (let i = 0; i < times; i++) {
    for (const s of fn(random)) {
      (seen[s.k] ??= []).push(s.n);
    }
  }
  return seen;
}

const WOOLS = BLOCKS.filter((b) => b.name.startsWith('wool_')).map((b) => b.id);

/** §6.3 h / tool / tier for every breakable block. */
const TABLE = [
  [[B.DIRT], 0.9, 'shovel', 0],
  [[B.GRASS_BLOCK, B.SNOWY_GRASS], 1.0, 'shovel', 0],
  [[B.SAND, B.RED_SAND], 0.8, 'shovel', 0],
  [[B.GRAVEL], 1.2, 'shovel', 0],
  [[B.CLAY], 1.4, 'shovel', 0],
  [[B.SNOW_BLOCK], 0.5, 'shovel', 0],
  [[B.ICE], 1.0, 'pick', 0],
  [[B.PACKED_ICE], 2.0, 'pick', 2],
  [[B.LOOSE_STONES, B.FALLEN_BRANCHES], 0.2, null, 0],
  [[B.OAK_LEAVES, B.SPRUCE_LEAVES, B.BIRCH_LEAVES], 0.4, 'axe', 0],
  [[B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE], 0.5, 'shovel', 0],
  [[B.TUSSOCK], 0.2, 'knife', 0],
  [[B.CATTAILS], 0.3, 'knife', 0],
  [[B.TUBER_PLANT], 0.4, 'shovel', 0],
  [[B.OAK_LOG, B.SPRUCE_LOG, B.BIRCH_LOG], 3.0, 'axe', 1],
  [[B.OAK_PLANKS, B.SPRUCE_PLANKS, B.BIRCH_PLANKS], 2.0, 'axe', 1],
  [[B.BOOKSHELF], 1.5, 'axe', 1],
  [[B.WORK_STUMP], 2.5, 'axe', 1],
  [[B.WORKBENCH], 3.0, 'axe', 1], // v0.11 (CONTRACTS §67)
  [[B.SNARE, B.SNARE_BAITED, B.SNARE_SPRUNG], 0.3, null, 0], // §69
  [[B.WICKER_BASKET], 0.8, 'axe', 0],
  [[B.POWDER_KEG], 2.0, 'axe', 1],
  [[B.PUMPKIN], 1.0, 'axe', 0],
  [[B.HAY_BALE, ...WOOLS, B.HONEYCOMB_BLOCK], 0.8, 'knife', 0],
  [[B.SLEEPING_HIDE], 0.5, 'knife', 0],
  [[B.REMAINS], 0.3, null, 0],
  [[B.CAMPFIRE, B.FIRE_PIT, B.GLASS], 0.5, null, 0],
  [[B.GLOWSTONE], 1.0, 'pick', 0],
  [[B.BLACK_HOLE], 1.0, null, 0],
  [[B.KILN], 3.0, 'pick', 0],
  [[B.BLOOMERY], 4.0, 'pick', 2],
  [[B.FORGE], 5.0, 'pick', 2],
  [[B.STONE, B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.BRICKS], 3.0, 'pick', 2],
  [[B.GRANITE, B.DIORITE, B.ANDESITE, B.SLATE], 3.5, 'pick', 2],
  [[B.SANDSTONE], 2.0, 'pick', 2],
  [[B.OBSIDIAN], 2.5, 'pick', 2],
  [[B.RUNE_BLOCK], 2.0, 'pick', 2],
  [[B.COAL_ORE], 3.5, 'pick', 2],
  [[B.COPPER_ORE], 4.0, 'pick', 2],
  [[B.TIN_ORE], 4.0, 'pick', 3],
  [[B.IRON_ORE, B.GOLD_ORE], 5.0, 'pick', 4],
  [[B.DIAMOND_ORE], 4.0, 'pick', 2],
  [[B.COAL_BLOCK], 4.0, 'pick', 2],
  [[B.COPPER_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK], 5.0, 'pick', 2],
  [[B.IRON_BLOCK], 6.0, 'pick', 2],
  // DESIGN-circuits §8.3: the circuit parts
  [[B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE, B.EARTH_WIRE, B.POWDER_FUSE], 0.2, null, 0],
  [[B.TORCH], 0.3, null, 0],
  [[B.TERMINAL_BOARD, B.RELAY, B.BLASTING_MACHINE, B.SPARK_TRANSMITTER, B.CLOCKWORK_TIMER, B.FILAMENT_LAMP, B.VOLTAIC_BATTERY], 1.0, 'axe', 0],
  [[B.KNIFE_SWITCH, B.PUSH_BUTTON, B.ELECTRIC_BELL, B.IGNITER], 1.2, 'pick', 0],
  [[B.SELENIUM_PANEL, B.COHERER_RECEIVER], 0.6, null, 0],
  [[B.COLLAPSAR_CHARGE], 1.5, 'pick', 0],
];

describe('BLOCK_RULES (§6.3)', () => {
  it('has one entry per block id; only AIR, BEDROCK and the water family are null', () => {
    expect(BLOCK_RULES.length).toBe(BLOCK_COUNT);
    const nulls = BLOCK_RULES.map((r, id) => (r ? null : id)).filter((x) => x !== null);
    // The 20 powder-and-circuits blocks (DESIGN-circuits §1.2) have their §8.3 rows: every part comes away whole.
    expect(nulls).toEqual(BLOCKS.filter((b) => b.id === B.AIR || b.id === B.BEDROCK || isWater(b.id)).map((b) => b.id));
    for (let id = B.COLLAPSAR_CHARGE; id <= B.COHERER_RECEIVER; id++) {
      expect(rollDrops(id, null, {}, () => 0.5), BLOCKS[id].name).toEqual([{ k: BLOCKS[id].name, n: 1 }]);
    }
  });

  it('DESIGN-circuits §8.1: coal seams give pyrite, deep stone gives saltpetre (natural cells only)', () => {
    const pick2 = { type: 'pick', tier: 2, durability: 90, power: 1 };
    const always = () => 0;
    expect(asMap(rollDrops(B.COAL_ORE, pick2, { natural: true }, always))).toMatchObject({ pyrite: 1 });
    expect(asMap(rollDrops(B.COAL_ORE, pick2, { natural: false }, always)).pyrite).toBeUndefined();
    expect(asMap(rollDrops(B.STONE, pick2, { natural: true, deep: true }, always))).toMatchObject({ saltpetre: 1 });
    expect(asMap(rollDrops(B.STONE, pick2, { natural: true, deep: false }, always)).saltpetre).toBeUndefined();
    expect(asMap(rollDrops(B.STONE, pick2, { natural: false, deep: true }, always)).saltpetre).toBeUndefined();
    expect(isDeep(SEA_LEVEL - DEEP_BELOW_SEA)).toBe(true);
    expect(isDeep(SEA_LEVEL - DEEP_BELOW_SEA + 1)).toBe(false);
  });

  it('matches the table row for row (h, tool, tier)', () => {
    const seen = new Set();
    for (const [ids, h, tl, tier] of TABLE) {
      for (const id of ids) {
        expect(seen.has(id), BLOCKS[id].name).toBe(false);
        seen.add(id);
        expect(BLOCK_RULES[id], BLOCKS[id].name).toMatchObject({ h, tool: tl, tier });
      }
    }
    // every breakable block appears in the table exactly once
    const ruled = BLOCK_RULES.map((r, id) => (r ? id : -1)).filter((id) => id >= 0);
    expect([...seen].sort((a, b) => a - b)).toEqual(ruled);
  });

  it('every rule is well formed and names only real items and tool types', () => {
    for (const [id, rule] of BLOCK_RULES.entries()) {
      if (!rule) continue;
      expect(rule.h).toBeGreaterThan(0);
      expect(rule.tool === null || TOOL_TYPES.includes(rule.tool)).toBe(true);
      expect(Number.isInteger(rule.tier) && rule.tier >= 0 && rule.tier <= 6).toBe(true);
      if (rule.tier > 0) expect(rule.tool).not.toBe(null);
      for (const group of rule.drops) {
        expect(group.length).toBeGreaterThan(0);
        group.forEach((br, i) => {
          expect([null, 'shovel', 'knife', 'axe', 'pick', 'knifeInPack']).toContain(br.if);
          if (br.if === null) expect(i).toBe(group.length - 1); // an unconditional branch is always last
          for (const it of br.items) {
            expect(isItemKey(it.k), `${BLOCKS[id].name} → ${it.k}`).toBe(true);
            if (Array.isArray(it.n)) expect(it.n[0]).toBeLessThan(it.n[1]);
            else expect(it.n).toBeGreaterThan(0);
            if (it.p !== undefined) expect(it.p > 0 && it.p < 1).toBe(true);
          }
        });
      }
    }
  });

  it('"self" resolves to the block item, and blocks dropping themselves are placeable', () => {
    expect(rollDrops(B.DIRT, HAND, {}, Math.random)).toEqual([{ k: 'dirt', n: 1 }]);
    expect(rollDrops(B.RUNE_BLOCK, tool('flint_pick'), {}, Math.random)).toEqual([{ k: 'rune_block', n: 1 }]);
    expect(rollDrops(B.WOOL_PINK, HAND, {}, Math.random)).toEqual([{ k: 'wool_pink', n: 1 }]);
    expect(rollDrops(B.WORK_STUMP, tool('stone_axe'), {}, Math.random)).toEqual([{ k: 'work_stump', n: 1 }]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(BLOCK_RULES)).toBe(true);
    expect(Object.isFrozen(BLOCK_RULES[B.STONE])).toBe(true);
    expect(Object.isFrozen(BLOCK_RULES[B.STONE].drops[0][0].items[0])).toBe(true);
  });

  it('ruleFor is safe on garbage', () => {
    expect(ruleFor(B.STONE)).toBe(BLOCK_RULES[B.STONE]);
    for (const bad of [-1, BLOCK_COUNT, 255, 1.5, NaN, 'length', '__proto__', null, undefined]) expect(ruleFor(bad)).toBe(null);
  });
});

describe('breakSeconds and canHarvest (§6.1)', () => {
  it('the worked example times', () => {
    const rows = [
      [B.DIRT, HAND, 0.9],
      [B.DIRT, 'wooden_shovel', 0.6],
      [B.OAK_LOG, 'stone_axe', 2.0],
      [B.OAK_LOG, 'flint_axe', 1.5],
      [B.OAK_LOG, 'steel_axe', 0.5],
      [B.STONE, 'flint_pick', 1.5],
      [B.STONE, 'bronze_pick', 0.88],
      [B.IRON_ORE, 'bronze_pick', 1.47],
      [B.OBSIDIAN, 'flint_pick', 1.25],
    ];
    for (const [id, key, s] of rows) expect(breakSeconds(id, key ? tool(key) : null)).toBeCloseTo(s, 2);
  });

  it('a tool of another type counts as the hand', () => {
    expect(breakSeconds(B.DIRT, tool('steel_pick'))).toBeCloseTo(0.9, 9);
    expect(breakSeconds(B.GRAVEL, tool('flint_axe'))).toBeCloseTo(1.2, 9);
    expect(breakSeconds(B.TUSSOCK, tool('fire_drill'))).toBeCloseTo(0.2, 9);
  });

  it('speed is TIER_SPEED of the tool tier, for every tier', () => {
    const picks = ['flint_pick', 'copper_pick', 'bronze_pick', 'iron_pick', 'steel_pick'];
    for (const k of picks) expect(breakSeconds(B.STONE, tool(k))).toBeCloseTo(3 / TIER_SPEED[tool(k).tier], 9);
    expect(breakSeconds(B.DIRT, tool('wooden_shovel'))).toBeCloseTo(0.9 / 1.5, 9);
  });

  it('cannot: below the tier, the wrong type, or the hand where a tier is needed → Infinity', () => {
    expect(breakSeconds(B.STONE, HAND)).toBe(Infinity);
    expect(breakSeconds(B.STONE, tool('stone_axe'))).toBe(Infinity);
    expect(breakSeconds(B.STONE, tool('stone_hammer'))).toBe(Infinity); // no stone pick exists: flint is the first way in
    expect(breakSeconds(B.OAK_LOG, HAND)).toBe(Infinity);
    expect(breakSeconds(B.OAK_LOG, tool('flint_knife'))).toBe(Infinity);
    expect(breakSeconds(B.PACKED_ICE, HAND)).toBe(Infinity);
    expect(breakSeconds(B.TIN_ORE, tool('flint_pick'))).toBe(Infinity);
    expect(breakSeconds(B.TIN_ORE, tool('copper_pick'))).toBeCloseTo(4 / 2.6, 9);
    expect(breakSeconds(B.IRON_ORE, tool('copper_pick'))).toBe(Infinity);
    expect(breakSeconds(B.GOLD_ORE, tool('bronze_pick'))).toBeCloseTo(5 / 3.4, 9);
    expect(breakSeconds(B.BLOOMERY, HAND)).toBe(Infinity);
    expect(canHarvest(B.STONE, HAND)).toBe(false);
    expect(canHarvest(B.STONE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(B.DIRT, HAND)).toBe(true);
  });

  it('obsidian, gems and storage blocks need only a flint pick', () => {
    for (const id of [B.OBSIDIAN, B.DIAMOND_ORE, B.COAL_BLOCK, B.COPPER_BLOCK, B.GOLD_BLOCK, B.IRON_BLOCK, B.DIAMOND_BLOCK]) {
      expect(canHarvest(id, tool('flint_pick')), BLOCKS[id].name).toBe(true);
    }
  });

  it('bare hands can break dirt, sand, gravel, clay, snow, leaves, plants, litter and glass (§6.2)', () => {
    const ids = [B.DIRT, B.SAND, B.GRAVEL, B.CLAY, B.SNOW_BLOCK, B.OAK_LEAVES, B.TUSSOCK, B.HONEYBERRY_BUSH, B.LOOSE_STONES,
      B.FALLEN_BRANCHES, B.GLASS, B.CATTAILS, B.TUBER_PLANT, B.PRICKLY_PEAR];
    for (const id of ids) expect(breakSeconds(id, HAND), BLOCKS[id].name).toBeLessThan(Infinity);
  });

  it('null rules are unbreakable with anything', () => {
    for (const id of [B.AIR, B.BEDROCK, B.WATER, B.WATER_FLOW_3, B.WATER_FALL]) {
      expect(breakSeconds(id, tool('steel_pick'))).toBe(Infinity);
      expect(canHarvest(id, HAND)).toBe(false);
    }
    expect(breakSeconds(200, HAND)).toBe(Infinity);
  });

  it('under water takes 2.5×, and nothing is faster than 0.05 s', () => {
    expect(UNDERWATER_DIG_FACTOR).toBe(2.5);
    expect(breakSeconds(B.DIRT, HAND, true)).toBeCloseTo(2.25, 9);
    expect(breakSeconds(B.STONE, tool('flint_pick'), true)).toBeCloseTo(3.75, 9);
    expect(breakSeconds(B.TUSSOCK, tool('steel_knife'))).toBe(MIN_BREAK_S); // 0.2 / 6 < 0.05
    expect(breakSeconds(B.TUSSOCK, tool('steel_knife'), true)).toBeCloseTo(0.125, 9);
    expect(breakSeconds(B.STONE, HAND, true)).toBe(Infinity);
  });

  it('harvestHint names the minimum tool', () => {
    expect(harvestHint(B.IRON_ORE)).toBe('Iron Ore · needs a bronze pick or better');
    expect(harvestHint(B.TIN_ORE)).toBe('Tin Ore · needs a copper pick or better');
    expect(harvestHint(B.STONE)).toBe('Stone · needs a flint pick or better');
    expect(harvestHint(B.OAK_LOG)).toBe('Oak Log · needs a stone axe or better');
    expect(harvestHint(B.DIRT)).toBe(null);
    expect(harvestHint(B.BEDROCK)).toBe(null);
  });
});

describe('rollDrops (§6.3)', () => {
  it('a group gives the first branch whose condition holds', () => {
    expect(rollDrops(B.GRAVEL, tool('flint_shovel'), {}, seq(0))).toEqual([{ k: 'gravel', n: 1 }]);
    expect(rollDrops(B.GRAVEL, HAND, {}, seq(0))).toEqual([{ k: 'rock', n: 2 }]);
    expect(rollDrops(B.GRAVEL, tool('flint_pick'), {}, seq(0))).toEqual([{ k: 'rock', n: 2 }]);
    expect(rollDrops(B.ICE, tool('flint_pick'), {}, seq(0))).toEqual([{ k: 'ice_chunk', n: 2 }]);
    expect(rollDrops(B.ICE, HAND, {}, seq(0))).toEqual([{ k: 'ice_chunk', n: 1 }]);
    expect(rollDrops(B.CLAY, HAND, {}, seq(0))).toEqual([{ k: 'clay_lump', n: 6 }]);
    expect(rollDrops(B.SNOW_BLOCK, HAND, {}, seq(0))).toEqual([{ k: 'snow', n: 6 }]);
    expect(rollDrops(B.PACKED_ICE, tool('flint_pick'), {}, seq(0))).toEqual([{ k: 'ice_chunk', n: 3 }]);
  });

  it('grass and snowy grass: self with a shovel; else dirt and a natural extra', () => {
    expect(rollDrops(B.GRASS_BLOCK, tool('wooden_shovel'), { natural: true }, seq(0))).toEqual([{ k: 'grass_block', n: 1 }]);
    expect(rollDrops(B.GRASS_BLOCK, HAND, { natural: true }, seq(0.1))).toEqual([{ k: 'dirt', n: 1 }, { k: 'plant_fibre', n: 1 }]);
    expect(rollDrops(B.GRASS_BLOCK, HAND, { natural: true }, seq(0.3))).toEqual([{ k: 'dirt', n: 1 }]);
    expect(rollDrops(B.GRASS_BLOCK, HAND, { natural: false }, seq(0))).toEqual([{ k: 'dirt', n: 1 }]);
    expect(rollDrops(B.SNOWY_GRASS, HAND, { natural: true }, seq(0))).toEqual([{ k: 'dirt', n: 1 }, { k: 'snow', n: 1 }]);
    expect(rollDrops(B.SNOWY_GRASS, HAND, { natural: false }, seq(0))).toEqual([{ k: 'dirt', n: 1 }]);
    expect(rollDrops(B.SNOWY_GRASS, tool('flint_shovel'), { natural: true }, seq(0))).toEqual([{ k: 'snowy_grass', n: 1 }]);
  });

  it('natural loose stones give flint about half the time over 400 seeded rolls; never when natural is false', () => {
    const nat = sample((r) => rollDrops(B.LOOSE_STONES, HAND, { natural: true }, r), 400, 11);
    expect(nat.flint.length / 400).toBeGreaterThan(0.42);
    expect(nat.flint.length / 400).toBeLessThan(0.58);
    expect(nat.rock.length).toBe(400);
    expect(new Set(nat.rock)).toEqual(new Set([1, 2]));
    const edited = sample((r) => rollDrops(B.LOOSE_STONES, HAND, { natural: false }, r), 400, 11);
    expect(edited.flint).toBeUndefined();
    expect(edited.rock.length).toBe(400);
  });

  it('`natural` comes from the argument only (absent counts as edited)', () => {
    expect(rollDrops(B.LOOSE_STONES, HAND, {}, seq(0, 0))).toEqual([{ k: 'rock', n: 1 }]);
    expect(rollDrops(B.LOOSE_STONES, HAND, { natural: true }, seq(0, 0))).toEqual([{ k: 'rock', n: 1 }, { k: 'flint', n: 1 }]);
    expect(rollDrops(B.LOOSE_STONES, HAND, { natural: true }, seq(0.99, 0.5))).toEqual([{ k: 'rock', n: 2 }]);
  });

  it('a natural item that is skipped draws no random number', () => {
    let calls = 0;
    const r = () => {
      calls++;
      return 0;
    };
    rollDrops(B.LOOSE_STONES, HAND, { natural: false }, r);
    expect(calls).toBe(1); // only the rock range
    calls = 0;
    rollDrops(B.LOOSE_STONES, HAND, { natural: true }, r);
    expect(calls).toBe(2);
  });

  it('stone gives rock, and flint at p 0.05 from untouched stone', () => {
    expect(rollDrops(B.STONE, tool('flint_pick'), { natural: true }, seq(0.04))).toEqual([{ k: 'rock', n: 2 }, { k: 'flint', n: 1 }]);
    expect(rollDrops(B.STONE, tool('flint_pick'), { natural: true }, seq(0.06))).toEqual([{ k: 'rock', n: 2 }]);
    expect(rollDrops(B.STONE, tool('flint_pick'), { natural: false }, seq(0))).toEqual([{ k: 'rock', n: 2 }]);
    expect(rollDrops(B.STONE, HAND, { natural: true }, seq(0))).toEqual([]); // cannot be harvested by hand
  });

  it('leaves by hand give no stick (only the odd nut); an axe lops self and a natural stick', () => {
    const hand = sample((r) => rollDrops(B.OAK_LEAVES, HAND, { natural: true }, r), 2000, 3);
    expect(hand.stick).toBeUndefined();
    expect(hand.oak_leaves).toBeUndefined();
    expect(hand.acorns.length / 2000).toBeGreaterThan(0.06);
    expect(hand.acorns.length / 2000).toBeLessThan(0.1);
    expect(rollDrops(B.BIRCH_LEAVES, HAND, { natural: true }, seq(0))).toEqual([]);
    expect(rollDrops(B.OAK_LEAVES, tool('stone_axe'), { natural: true }, seq(0.5))).toEqual([{ k: 'oak_leaves', n: 1 }, { k: 'stick', n: 1 }]);
    expect(rollDrops(B.OAK_LEAVES, tool('stone_axe'), { natural: false }, seq(0))).toEqual([{ k: 'oak_leaves', n: 1 }]);
    expect(rollDrops(B.SPRUCE_LEAVES, HAND, { natural: true }, seq(0.07))).toEqual([{ k: 'pine_nuts', n: 1 }]);
    expect(rollDrops(B.SPRUCE_LEAVES, HAND, { natural: false }, seq(0))).toEqual([]);
    expect(rollDrops(B.BIRCH_LEAVES, tool('flint_axe'), { natural: true }, seq(0))).toEqual([{ k: 'birch_leaves', n: 1 }, { k: 'stick', n: 1 }]);
  });

  it('plants give themselves only with a shovel', () => {
    for (const id of [B.TUSSOCK, B.CATTAILS, B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE, B.TUBER_PLANT]) {
      const self = itemForBlock(id);
      for (const t of [HAND, tool('flint_knife'), tool('flint_axe'), tool('flint_pick')]) {
        const got = sample((r) => rollDrops(id, t, { natural: true, knifeInPack: true }, r), 50, id);
        expect(got[self], `${BLOCKS[id].name} without a shovel`).toBeUndefined();
      }
      if (id !== B.TUBER_PLANT) {
        const dug = rollDrops(id, tool('wooden_shovel'), { natural: true }, seq(0));
        expect(asMap(dug)[self], `${BLOCKS[id].name} with a shovel`).toBe(1);
      }
    }
  });

  it('tussock: shovel → self; knife → fibre 2–3; else fibre 1–2', () => {
    expect(rollDrops(B.TUSSOCK, tool('flint_shovel'), {}, seq(0))).toEqual([{ k: 'tussock', n: 1 }]);
    const knife = sample((r) => rollDrops(B.TUSSOCK, tool('flint_knife'), {}, r), 300, 5);
    expect(new Set(knife.plant_fibre)).toEqual(new Set([2, 3]));
    const hand = sample((r) => rollDrops(B.TUSSOCK, HAND, {}, r), 300, 5);
    expect(new Set(hand.plant_fibre)).toEqual(new Set([1, 2]));
  });

  it('cattails: knife → fibre 3 + root p 0.5; else fibre 2 + root p 0.3', () => {
    expect(rollDrops(B.CATTAILS, tool('copper_knife'), {}, seq(0.49))).toEqual([{ k: 'plant_fibre', n: 3 }, { k: 'cattail_root', n: 1 }]);
    expect(rollDrops(B.CATTAILS, tool('copper_knife'), {}, seq(0.51))).toEqual([{ k: 'plant_fibre', n: 3 }]);
    expect(rollDrops(B.CATTAILS, HAND, {}, seq(0.29))).toEqual([{ k: 'plant_fibre', n: 2 }, { k: 'cattail_root', n: 1 }]);
    expect(rollDrops(B.CATTAILS, HAND, {}, seq(0.31))).toEqual([{ k: 'plant_fibre', n: 2 }]);
    expect(rollDrops(B.CATTAILS, tool('flint_shovel'), {}, seq(0))).toEqual([{ k: 'cattails', n: 1 }]);
  });

  it('tuber: shovel → 2–3 tubers + fibre; else 1 tuber + fibre', () => {
    const dug = sample((r) => rollDrops(B.TUBER_PLANT, tool('wooden_shovel'), {}, r), 200, 9);
    expect(new Set(dug.wild_tuber)).toEqual(new Set([2, 3]));
    expect(new Set(dug.plant_fibre)).toEqual(new Set([1]));
    expect(rollDrops(B.TUBER_PLANT, HAND, {}, seq(0.9))).toEqual([{ k: 'wild_tuber', n: 1 }, { k: 'plant_fibre', n: 1 }]);
  });

  it('honeyberry bush: berries 2–4 and sticks 1–2 always; the bush itself with a shovel', () => {
    const hand = sample((r) => rollDrops(B.HONEYBERRY_BUSH, HAND, {}, r), 400, 2);
    expect(new Set(hand.honeyberries)).toEqual(new Set([2, 3, 4]));
    expect(new Set(hand.stick)).toEqual(new Set([1, 2]));
    expect(hand.honeyberry_bush).toBeUndefined();
    expect(rollDrops(B.HONEYBERRY_BUSH, tool('flint_shovel'), {}, seq(0))).toEqual([
      { k: 'honeyberry_bush', n: 1 }, { k: 'honeyberries', n: 2 }, { k: 'stick', n: 1 },
    ]);
    expect(rollDrops(B.HONEYBERRY_BUSH_BARE, tool('flint_shovel'), {}, seq(0.99))).toEqual([{ k: 'honeyberry_bush', n: 1 }, { k: 'stick', n: 2 }]);
    expect(rollDrops(B.HONEYBERRY_BUSH_BARE, HAND, {}, seq(0))).toEqual([{ k: 'stick', n: 1 }]);
  });

  it('prickly pear: knife in pack → cactus fruit; else unpeeled', () => {
    expect(rollDrops(B.PRICKLY_PEAR, HAND, { knifeInPack: true }, seq(0))).toEqual([{ k: 'cactus_fruit', n: 1 }]);
    expect(rollDrops(B.PRICKLY_PEAR, HAND, { knifeInPack: false }, seq(0.99))).toEqual([{ k: 'unpeeled_cactus_fruit', n: 2 }]);
    expect(rollDrops(B.PRICKLY_PEAR, tool('flint_shovel'), { knifeInPack: true }, seq(0))).toEqual([
      { k: 'prickly_pear', n: 1 }, { k: 'cactus_fruit', n: 1 },
    ]);
    expect(rollDrops(B.PRICKLY_PEAR_BARE, HAND, { knifeInPack: true }, seq(0))).toEqual([]);
    expect(rollDrops(B.PRICKLY_PEAR_BARE, tool('flint_shovel'), {}, seq(0))).toEqual([{ k: 'prickly_pear', n: 1 }]);
  });

  it('birch logs: self, and birch bark at p 0.5 from untouched logs', () => {
    expect(rollDrops(B.BIRCH_LOG, tool('flint_axe'), { natural: true }, seq(0.4))).toEqual([{ k: 'birch_log', n: 1 }, { k: 'birch_bark', n: 1 }]);
    expect(rollDrops(B.BIRCH_LOG, tool('flint_axe'), { natural: true }, seq(0.6))).toEqual([{ k: 'birch_log', n: 1 }]);
    expect(rollDrops(B.BIRCH_LOG, tool('flint_axe'), { natural: false }, seq(0))).toEqual([{ k: 'birch_log', n: 1 }]);
    expect(rollDrops(B.OAK_LOG, tool('flint_axe'), { natural: true }, seq(0))).toEqual([{ k: 'oak_log', n: 1 }]);
  });

  it('ores and the rest', () => {
    expect(rollDrops(B.COAL_ORE, tool('flint_pick'), {}, seq(0.99))).toEqual([{ k: 'coal', n: 2 }]);
    expect(rollDrops(B.COPPER_ORE, tool('flint_pick'), {}, seq(0))).toEqual([{ k: 'malachite', n: 1 }]);
    expect(rollDrops(B.IRON_ORE, tool('bronze_pick'), {}, seq(0.6))).toEqual([{ k: 'hematite', n: 2 }]);
    expect(rollDrops(B.GOLD_ORE, tool('iron_pick'), {}, seq(0))).toEqual([{ k: 'gold_nugget', n: 1 }]);
    expect(rollDrops(B.DIAMOND_ORE, tool('flint_pick'), {}, seq(0))).toEqual([{ k: 'rough_gem', n: 1 }]);
    expect(rollDrops(B.OBSIDIAN, tool('flint_pick'), {}, seq(0.99))).toEqual([{ k: 'obsidian_shard', n: 3 }]);
    expect(rollDrops(B.GLASS, HAND, {}, seq(0))).toEqual([{ k: 'glass_shards', n: 1 }]);
    expect(rollDrops(B.CAMPFIRE, HAND, {}, seq(0))).toEqual([{ k: 'rock', n: 4 }]);
    expect(rollDrops(B.FIRE_PIT, HAND, {}, seq(0))).toEqual([{ k: 'rock', n: 4 }, { k: 'charcoal', n: 1 }]);
    expect(rollDrops(B.REMAINS, HAND, {}, seq(0))).toEqual([]);
    expect(rollDrops(B.BLACK_HOLE, HAND, {}, seq(0))).toEqual([]);
    expect(rollDrops(B.FALLEN_BRANCHES, HAND, {}, seq(0))).toEqual([{ k: 'stick', n: 2 }]);
    expect(rollDrops(B.WICKER_BASKET, HAND, {}, seq(0))).toEqual([{ k: 'wicker_basket', n: 1 }]);
    expect(rollDrops(B.KILN, HAND, {}, seq(0))).toEqual([{ k: 'kiln', n: 1 }]);
  });

  it('aggregates by key: tin ore gives 1 cassiterite, 2 at p 0.25', () => {
    expect(rollDrops(B.TIN_ORE, tool('copper_pick'), {}, seq(0.2))).toEqual([{ k: 'cassiterite', n: 2 }]);
    expect(rollDrops(B.TIN_ORE, tool('copper_pick'), {}, seq(0.3))).toEqual([{ k: 'cassiterite', n: 1 }]);
    const got = sample((r) => rollDrops(B.TIN_ORE, tool('copper_pick'), {}, r), 2000, 4);
    const twos = got.cassiterite.filter((n) => n === 2).length / 2000;
    expect(twos).toBeGreaterThan(0.21);
    expect(twos).toBeLessThan(0.29);
  });

  it('nothing drops when the tool cannot harvest the block, or for unbreakable blocks', () => {
    expect(rollDrops(B.IRON_ORE, tool('copper_pick'), { natural: true }, seq(0))).toEqual([]);
    expect(rollDrops(B.OAK_LOG, HAND, { natural: true }, seq(0))).toEqual([]);
    expect(rollDrops(B.BEDROCK, tool('steel_pick'), {}, seq(0))).toEqual([]);
    expect(rollDrops(B.WATER, HAND, {}, seq(0))).toEqual([]);
  });

  it('ranges are uniform and inclusive', () => {
    const got = sample((r) => rollDrops(B.HONEYBERRY_BUSH, HAND, {}, r), 3000, 8);
    for (const n of [2, 3, 4]) {
      const share = got.honeyberries.filter((x) => x === n).length / 3000;
      expect(share).toBeGreaterThan(0.29);
      expect(share).toBeLessThan(0.38);
    }
    // a random() that returns (just under) 1 stays in range
    expect(rollDrops(B.FALLEN_BRANCHES, HAND, {}, () => 0.9999999)).toEqual([{ k: 'stick', n: 3 }]);
  });

  it('rollGroups on an empty list gives nothing', () => {
    expect(rollGroups([], null, {}, seq(0))).toEqual([]);
  });
});

describe('picking with R (§6.4)', () => {
  it('PICKABLE has exactly the four rows', () => {
    expect(Object.keys(PICKABLE).map(Number).sort((a, b) => a - b)).toEqual([B.HONEYBERRY_BUSH, B.PRICKLY_PEAR, B.LOOSE_STONES, B.FALLEN_BRANCHES]);
    expect(isPickable(B.HONEYBERRY_BUSH)).toBe(true);
    for (const id of [B.HONEYBERRY_BUSH_BARE, B.PRICKLY_PEAR_BARE, B.TUSSOCK, B.STONE, B.AIR, -1, 'toString', undefined]) {
      expect(isPickable(id)).toBe(false);
      expect(pick(id, {}, seq(0))).toBe(null);
    }
  });

  it('a ripe honeyberry bush becomes picked and gives 2–4 berries', () => {
    expect(pick(B.HONEYBERRY_BUSH, {}, seq(0))).toEqual({ to: B.HONEYBERRY_BUSH_BARE, drops: [{ k: 'honeyberries', n: 2 }] });
    const got = sample((r) => pick(B.HONEYBERRY_BUSH, {}, r).drops, 300, 6);
    expect(new Set(got.honeyberries)).toEqual(new Set([2, 3, 4]));
    expect(Object.keys(got)).toEqual(['honeyberries']);
  });

  it('a prickly pear gives peeled fruit with a knife in the pack, else unpeeled', () => {
    expect(pick(B.PRICKLY_PEAR, { knifeInPack: true }, seq(0.99))).toEqual({ to: B.PRICKLY_PEAR_BARE, drops: [{ k: 'cactus_fruit', n: 2 }] });
    expect(pick(B.PRICKLY_PEAR, { knifeInPack: false }, seq(0))).toEqual({ to: B.PRICKLY_PEAR_BARE, drops: [{ k: 'unpeeled_cactus_fruit', n: 1 }] });
  });

  it('loose stones become AIR: rock 1–2 and natural flint at p 0.5', () => {
    expect(pick(B.LOOSE_STONES, { natural: true }, seq(0, 0.49))).toEqual({ to: B.AIR, drops: [{ k: 'rock', n: 1 }, { k: 'flint', n: 1 }] });
    expect(pick(B.LOOSE_STONES, { natural: true }, seq(0.6, 0.51))).toEqual({ to: B.AIR, drops: [{ k: 'rock', n: 2 }] });
    const edited = sample((r) => pick(B.LOOSE_STONES, { natural: false }, r).drops, 300, 12);
    expect(edited.flint).toBeUndefined();
    const nat = sample((r) => pick(B.LOOSE_STONES, { natural: true }, r).drops, 400, 12);
    expect(nat.flint.length / 400).toBeGreaterThan(0.42);
    expect(nat.flint.length / 400).toBeLessThan(0.58);
  });

  it('fallen branches become AIR: 2–3 sticks', () => {
    const got = sample((r) => pick(B.FALLEN_BRANCHES, {}, r).drops, 200, 13);
    expect(new Set(got.stick)).toEqual(new Set([2, 3]));
    expect(pick(B.FALLEN_BRANCHES, {}, seq(0)).to).toBe(B.AIR);
  });

  it('pick works without a context object', () => {
    expect(pick(B.LOOSE_STONES, undefined, seq(0, 0))).toEqual({ to: B.AIR, drops: [{ k: 'rock', n: 1 }] });
  });
});

describe('tapping birch sap (§4.2)', () => {
  it('needs a birch log, an empty clay pot selected and a knife in the pack', () => {
    expect(tap(B.BIRCH_LOG, 'clay_pot', true)).toEqual({ gives: 'pot_sap', takes: 'clay_pot', wears: 'knife' });
    expect(tap(B.OAK_LOG, 'clay_pot', true)).toBe(null);
    expect(tap(B.BIRCH_LOG, 'pot_water', true)).toBe(null);
    expect(tap(B.BIRCH_LOG, null, true)).toBe(null);
    expect(tap(B.BIRCH_LOG, 'clay_pot', false)).toBe(null);
    expect(isItemKey('pot_sap') && isItemKey('clay_pot')).toBe(true);
  });

  it('Tapped: once per cell per game day', () => {
    const t = new Tapped();
    expect(t.canTap('1,60,2', 3)).toBe(true);
    t.mark('1,60,2', 3);
    expect(t.canTap('1,60,2', 3)).toBe(false);
    expect(t.canTap('1,61,2', 3)).toBe(true);
    expect(t.canTap('1,60,2', 4)).toBe(true);
    t.mark('1,61,2', 3);
    expect(t.days.size).toBe(2);
    t.mark('5,5,5', 4); // a new day forgets yesterday's taps
    expect(t.days.size).toBe(1);
    expect(t.canTap('1,60,2', 4)).toBe(true);
    expect(t.canTap('5,5,5', 4)).toBe(false);
    t.clear();
    expect(t.canTap('5,5,5', 4)).toBe(true);
  });
});

describe('Regrowth (§6.5)', () => {
  const loaded = () => true;

  it('RIPE_OF / ripeOf map the picked variants to the ripe blocks', () => {
    expect(ripeOf(B.HONEYBERRY_BUSH_BARE)).toBe(B.HONEYBERRY_BUSH);
    expect(ripeOf(B.PRICKLY_PEAR_BARE)).toBe(B.PRICKLY_PEAR);
    for (const id of [B.HONEYBERRY_BUSH, B.AIR, -3, 'constructor', null]) expect(ripeOf(id)).toBe(-1);
    expect(Object.isFrozen(RIPE_OF)).toBe(true);
  });

  it('tracks picked cells from onBlockChange and untracks any other write', () => {
    const g = new Regrowth();
    g.onBlockChange(1, 60, -2, B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE);
    g.onBlockChange(-4, 61, 7, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE);
    g.onBlockChange(9, 9, 9, B.AIR, B.DIRT);
    expect(g.size).toBe(2);
    expect(g.has(1, 60, -2)).toBe(true);
    g.onBlockChange(1, 60, -2, B.HONEYBERRY_BUSH_BARE, B.AIR); // dug up
    expect(g.has(1, 60, -2)).toBe(false);
    g.onBlockChange(-4, 61, 7, B.PRICKLY_PEAR_BARE, B.PRICKLY_PEAR); // regrown
    expect(g.size).toBe(0);
    expect(g.track(0, 0, 0, B.STONE)).toBe(false);
    expect(g.untrack(5, 5, 5)).toBe(false);
  });

  it('never tracks more than MAX_REGROW_TRACKED cells', () => {
    expect(MAX_REGROW_TRACKED).toBe(4096);
    const g = new Regrowth();
    for (let i = 0; i < MAX_REGROW_TRACKED + 50; i++) g.onBlockChange(i, 60, 0, B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE);
    expect(g.size).toBe(MAX_REGROW_TRACKED);
    expect(g.has(MAX_REGROW_TRACKED, 60, 0)).toBe(false);
    expect(g.track(0, 60, 0, B.PRICKLY_PEAR_BARE)).toBe(true); // re-tracking a known cell is fine at the cap
    g.untrack(0, 60, 0);
    expect(g.track(MAX_REGROW_TRACKED + 10, 60, 0, B.HONEYBERRY_BUSH_BARE)).toBe(true);
  });

  it('loadFromEdits finds the picked cells (negative coordinates too) and replaces the old set', () => {
    const edits = new Map();
    const put = (q, y, r, id) => {
      const cq = Math.floor(q / 16);
      const cr = Math.floor(r / 16);
      const key = chunkKey(cq, cr);
      if (!edits.has(key)) edits.set(key, new Map());
      edits.get(key).set(localIndex(q - cq * 16, y, r - cr * 16), id);
    };
    put(-5, 60, 20, B.HONEYBERRY_BUSH_BARE);
    put(33, 70, -1, B.PRICKLY_PEAR_BARE);
    put(2, 64, 2, B.HONEYBERRY_BUSH);
    put(3, 64, 2, B.AIR);
    edits.set('bad key', new Map([[0, B.HONEYBERRY_BUSH_BARE]]));
    const g = new Regrowth();
    g.track(100, 100, 100, B.HONEYBERRY_BUSH_BARE);
    g.loadFromEdits(edits);
    expect(g.size).toBe(2);
    expect(g.has(-5, 60, 20)).toBe(true);
    expect(g.has(33, 70, -1)).toBe(true);
    expect(g.has(100, 100, 100)).toBe(false);
    g.clear();
    expect(g.size).toBe(0);
  });

  it('a cell regrows with probability 1/REGROW_MEAN_S per 1 s step: one game day on average', () => {
    expect(REGROW_MEAN_S).toBe(600);
    const g = new Regrowth();
    const random = mulberry32(99);
    const N = 400;
    for (let i = 0; i < N; i++) g.track(i, 60, 0, B.HONEYBERRY_BUSH_BARE);
    let regrown = 0;
    let sumT = 0;
    for (let s = 1; s <= 3000 && g.size > 0; s++) {
      const out = g.step(1, random, loaded);
      regrown += out.length;
      sumT += out.length * s;
    }
    expect(regrown).toBeGreaterThan(N * 0.95);
    const mean = sumT / regrown;
    expect(mean).toBeGreaterThan(520);
    expect(mean).toBeLessThan(680);
  });

  it('step returns { q, y, r, id: ripe } and stops tracking the cell', () => {
    const g = new Regrowth();
    g.track(-1, 50, -2, B.PRICKLY_PEAR_BARE);
    g.track(4, 51, 5, B.HONEYBERRY_BUSH_BARE);
    expect(g.step(1, seq(0.5, 0.5), loaded)).toEqual([]);
    const out = g.step(1, seq(0, 0.9), loaded);
    expect(out).toEqual([{ q: -1, y: 50, r: -2, id: B.PRICKLY_PEAR }]);
    expect(g.has(-1, 50, -2)).toBe(false);
    expect(g.size).toBe(1);
  });

  it('cells in unloaded chunks are frozen: no roll, no regrowth', () => {
    const g = new Regrowth();
    g.track(0, 60, 0, B.HONEYBERRY_BUSH_BARE);
    g.track(500, 60, 500, B.HONEYBERRY_BUSH_BARE);
    let calls = 0;
    const isLoaded = (q, r) => {
      expect(Number.isInteger(q) && Number.isInteger(r)).toBe(true);
      return q < 100;
    };
    const out = g.step(1, () => {
      calls++;
      return 0;
    }, isLoaded);
    expect(calls).toBe(1);
    expect(out.map((c) => c.q)).toEqual([0]);
    expect(g.has(500, 60, 500)).toBe(true);
    for (let i = 0; i < 100; i++) g.step(1, () => 0, () => false);
    expect(g.has(500, 60, 500)).toBe(true);
  });

  it('dt scales the chance (capped at 1); dt ≤ 0 does nothing', () => {
    const g = new Regrowth();
    g.track(0, 60, 0, B.HONEYBERRY_BUSH_BARE);
    expect(g.step(0, () => 0, loaded)).toEqual([]);
    expect(g.step(-1, () => 0, loaded)).toEqual([]);
    expect(g.step(60, seq(60 / 600 + 0.001), loaded)).toEqual([]);
    expect(g.step(60, seq(60 / 600 - 0.001), loaded).length).toBe(1);
    g.track(0, 60, 0, B.HONEYBERRY_BUSH_BARE);
    expect(g.step(1e6, () => 0.99999, loaded).length).toBe(1);
  });
});

describe('mob drops and tool power (§4.3, §5.1)', () => {
  it('MOB_DROPS name real items', () => {
    for (const groups of Object.values(MOB_DROPS)) {
      for (const g of groups) for (const br of g) for (const it of br.items) expect(isItemKey(it.k)).toBe(true);
    }
  });

  it('a pig gives raw pork 2–3, 1 rawhide and pig fat at p 0.6', () => {
    const got = sample((r) => rollMobDrops('pig', r), 2000, 21);
    expect(got.raw_pork.length).toBe(2000);
    expect(new Set(got.raw_pork)).toEqual(new Set([2, 3]));
    expect(new Set(got.rawhide)).toEqual(new Set([1]));
    expect(got.rawhide.length).toBe(2000);
    expect(got.pig_fat.length / 2000).toBeGreaterThan(0.56);
    expect(got.pig_fat.length / 2000).toBeLessThan(0.64);
  });

  it('a zombie gives a grave rag at p 0.5; unknown mobs nothing', () => {
    expect(rollMobDrops('zombie', seq(0.49))).toEqual([{ k: 'grave_rag', n: 1 }]);
    expect(rollMobDrops('zombie', seq(0.5))).toEqual([]);
    expect(rollMobDrops('dragon', seq(0))).toEqual([]);
    // v0.11 (§69): cattle give beef and hide, sheep mutton and wool, horses and wolves hide
    expect(rollMobDrops('cow', seq(0))).toEqual([{ k: 'raw_beef', n: 3 }, { k: 'rawhide', n: 1 }]);
    expect(rollMobDrops('sheep', seq(0.99))).toEqual([{ k: 'raw_mutton', n: 2 }, { k: 'wool_white', n: 2 }]);
    expect(rollMobDrops('horse', seq(0)).map((s) => s.k)).toEqual(['rawhide']);
    expect(rollMobDrops('wolf', seq(0))).toEqual([{ k: 'rawhide', n: 1 }]);
    expect(rollMobDrops('__proto__', seq(0))).toEqual([]);
  });

  it('toolPower: the tool power; bare hands 1', () => {
    expect(toolPower(null)).toBe(1);
    expect(toolPower(tool('stone_axe'))).toBe(2);
    expect(toolPower(tool('flint_spear'))).toBe(3);
    expect(toolPower(tool('steel_sword'))).toBe(5);
    for (const def of Object.values(ITEMS)) if (def.tool) expect(toolPower(def.tool)).toBe(def.tool.power);
  });
});

describe('the bare-hand gathering hint (§6.2; play-test fb-first-hour)', () => {
  const B = BLOCK;
  it('tussock, cattails, the tuber plant, gravel and clay say to hold the left mouse button, with the Handbook\'s verb', () => {
    // their neighbours (loose stones, fallen branches) say "R: pick"; these gave no hint at all and R did nothing
    expect(handGatherHint(B.TUSSOCK)).toBe('Tussock Grass · hold LMB: pull');
    expect(handGatherHint(B.CATTAILS)).toBe('Cattails · hold LMB: pull');
    expect(handGatherHint(B.TUBER_PLANT)).toBe('Wild Tuber Plant · hold LMB: pull');
    expect(handGatherHint(B.GRAVEL)).toBe('Gravel · hold LMB: dig');
    expect(handGatherHint(B.CLAY)).toBe('Clay · hold LMB: dig');
    for (const id of Object.keys(HAND_GATHER).map(Number)) {
      expect(isPickable(id), String(id)).toBe(false); // R picks none of them …
      expect(canHarvest(id, null), String(id)).toBe(true); // … and bare hands break all of them
      expect(harvestHint(id)).toBe(null); // no tier hint competes
    }
  });

  it('every other block has none (ordinary digging has no hint, as in Creative)', () => {
    for (const id of [B.DIRT, B.STONE, B.OAK_LEAVES, B.LOOSE_STONES, B.HONEYBERRY_BUSH, B.AIR, -1, 999]) expect(handGatherHint(id)).toBe(null);
    expect(handGatherHint(/** @type {any} */ ('constructor'))).toBe(null);
  });
});

describe('articles and dig-tool types', () => {
  it('withArticle: "a bronze pick", "an iron hammer" (play-test: "needs a iron hammer")', () => {
    expect(withArticle('bronze pick')).toBe('a bronze pick');
    expect(withArticle('iron hammer or better')).toBe('an iron hammer or better');
    expect(withArticle('obsidian knife')).toBe('an obsidian knife');
  });

  it('DIG_TOOL_TYPES are the five that break blocks; spear, sword and the kiln kit are not among them', () => {
    expect([...DIG_TOOL_TYPES].sort()).toEqual(['axe', 'hammer', 'knife', 'pick', 'shovel']);
    for (const t of ['spear', 'sword', 'firestarter', 'crucible', 'mold']) expect(DIG_TOOL_TYPES.has(t)).toBe(false);
    // every rule's tool is a dig-tool type
    for (const rule of BLOCK_RULES) if (rule && rule.tool) expect(DIG_TOOL_TYPES.has(rule.tool), rule.tool).toBe(true);
  });
});
