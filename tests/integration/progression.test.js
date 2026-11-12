// The build tree is LOGICAL AND BLOCKING (CONTRACTS §77): starting from bare hands in a generated world, work out
// everything that can ever be obtained — by breaking and picking what the land holds, hunting, cooking and crafting —
// and check (1) that the whole tree is reachable and (2) that taking any gate away cuts off exactly what it should.
import { describe, it, expect } from 'vitest';
import { GEN_LATEST, CHUNK_VOLUME, CHUNK_SIZE } from '../../src/config.js';
import { BLOCK, BLOCKS } from '../../src/blocks.js';
import { ITEMS, ITEM_KEYS, TAGS, getItem, itemForBlock } from '../../src/items.js';
import { BLOCK_RULES, PICKABLE, MOB_DROPS, rollDrops, pick, rollMobDrops } from '../../src/harvest.js';
import { RECIPES, STATION_BLOCKS } from '../../src/crafting.js';
import { FIRE_TRANSFORMS } from '../../src/cooking.js';
import { createWorldGen } from '../../src/worldgen.js';

/**
 * Every block id the newest generator lays down: eight chunks from each kind of land (found by walking the seed's biome
 * map), ores, ponds and all.
 */
const NATURAL = (() => {
  const gen = createWorldGen(4242, { gen: GEN_LATEST });
  /** @type {Map<number, Array<[number, number]>>} biome → up to 3 chunks of it */
  const byBiome = new Map();
  for (let cq = -40; cq <= 40; cq += 1) {
    for (let cr = -40; cr <= 40; cr += 3) {
      const biome = gen.getColumn(cq * CHUNK_SIZE + 8, cr * CHUNK_SIZE + 8).biome;
      const list = byBiome.get(biome) ?? byBiome.set(biome, []).get(biome);
      if (list.length < 8) list.push([cq, cr]);
    }
  }
  const seen = new Set();
  for (const list of byBiome.values()) {
    for (const [cq, cr] of list) {
      const { blocks } = gen.generateChunk(cq, cr);
      for (let k = 0; k < CHUNK_VOLUME; k++) seen.add(blocks[k]);
    }
  }
  seen.delete(BLOCK.AIR);
  return [...seen];
})();

const ALWAYS = () => 0; // every chance succeeds: we ask what CAN drop
const TOOL_KEYS = ITEM_KEYS.filter((k) => ITEMS[k].tool);

/**
 * Everything obtainable when the items in `barred` can never be had.
 * @param {string[]} [barred]
 * @returns {Set<string>}
 */
function reachable(barred = []) {
  const no = new Set(barred);
  const have = new Set();
  const add = (k) => {
    if (!k || no.has(k) || have.has(k)) return false;
    have.add(k);
    return true;
  };
  const tools = () => TOOL_KEYS.filter((k) => have.has(k)).map((k) => getItem(k).tool);
  const hasTool = (type, tier) => tools().some((t) => t.type === type && t.tier >= tier);
  const hasInput = (inp) => ('tag' in inp ? TAGS[inp.tag].some((m) => have.has(m)) : have.has(inp.k));
  for (let changed = true; changed;) {
    changed = false;
    const hands = [null, ...tools()];
    const ctx = { natural: true, deep: true, knifeInPack: hasTool('knife', 2) };
    // what the land gives: breaking and picking
    for (const id of NATURAL) {
      if (BLOCK_RULES[id]) for (const t of hands) for (const s of rollDrops(id, t, ctx, ALWAYS)) changed = add(s.k) || changed;
      if (Object.hasOwn(PICKABLE, id)) for (const s of pick(id, ctx, ALWAYS).drops) changed = add(s.k) || changed;
    }
    // hunting needs something to hit with
    if (tools().length > 0) for (const kind of Object.keys(MOB_DROPS)) for (const s of rollMobDrops(kind, ALWAYS)) changed = add(s.k) || changed;
    // a pot at the water's edge, and a birch
    if (have.has('clay_pot')) for (const k of ['pot_water', 'pot_seawater', 'pot_snow', 'pot_sap', 'pot_milk']) changed = add(k) || changed;
    // the campfire's skewers, centre and embers
    if (have.has('campfire')) for (const [from, t] of Object.entries(FIRE_TRANSFORMS)) if (have.has(from)) changed = add(t.to) || changed;
    // crafting: the workplace must have been made, every input be on hand, every tool be good enough
    for (const r of RECIPES) {
      const station = r.station === 'hand' || have.has(itemForBlock(STATION_BLOCKS[r.station]));
      if (!station || !r.inputs.every(hasInput) || !r.tools.every((t) => hasTool(t.type, t.tier))) continue;
      for (const o of r.outputs) changed = add(o.k) || changed;
    }
  }
  return have;
}

describe('the build tree: logical and blocking (§77)', () => {
  const all = reachable();

  it('from bare hands, every tool, every workplace and every recipe can be reached', () => {
    for (const k of TOOL_KEYS) expect(all.has(k), k).toBe(true);
    for (const id of Object.values(STATION_BLOCKS)) expect(all.has(itemForBlock(id)), BLOCKS[id].name).toBe(true);
    const never = RECIPES.filter((r) => !r.outputs.every((o) => all.has(o.k))).map((r) => r.id);
    expect(never).toEqual([]);
  });

  /** Every tool of `type` at `tier` or better: the things a "needs a pick of iron or better" gate is about. */
  const atLeast = (type, tier) => TOOL_KEYS.filter((k) => getItem(k).tool.type === type && getItem(k).tool.tier >= tier);

  /**
   * [name, the things taken away, what must become unreachable, what must stay reachable]. A tool gate takes away that
   * tool AND every better one of its kind: the rule is "a pick of copper or better", and a better pick must itself lie
   * beyond the gate for the gate to block (the test would fail if it did not).
   */
  const GATES = [
    ['any hammer (the Stone Hammer first)', atLeast('hammer', 1), ['stone_axe', 'flint_knife', 'flint_pick', 'work_stump', 'kiln', 'copper_ingot'], ['cord', 'fire_drill', 'campfire', 'rock']],
    ['any axe (the Stone Axe first)', atLeast('axe', 1), ['work_stump', 'wooden_shovel', 'oak_log', 'oak_planks', 'charcoal', 'bellows'], ['stone_hammer', 'cord', 'flint_pick', 'coal', 'flint_shovel', 'kiln']],
    ['an axe of flint or better (planks)', atLeast('axe', 2), ['oak_planks', 'bellows', 'bloomery', 'wrought_iron'], ['work_stump', 'kiln', 'copper_ingot', 'bronze_ingot']],
    // the first shovel is what digs clay: with no shovel there is no kiln, no pot, no metal
    ['any shovel (the Wooden Shovel first)', atLeast('shovel', 1), ['clay_lump', 'kiln', 'clay_pot', 'crucible', 'copper_ingot'], ['flint_pick', 'coal', 'work_stump', 'malachite']],
    ['a knife (flint or better)', atLeast('knife', 2), ['leather', 'bellows', 'bloomery', 'wrought_iron'], ['copper_ingot', 'bronze_ingot', 'kiln']],
    ['a pick of flint or better', atLeast('pick', 2), ['rock_from_stone', 'coal', 'malachite', 'copper_ingot', 'bronze_ingot', 'wrought_iron', 'steel_bar', 'workbench'], ['flint_knife', 'kiln', 'clay_pot', 'charcoal']],
    ['a pick of copper or better', atLeast('pick', 3), ['cassiterite', 'tin_ingot', 'bronze_ingot', 'hematite', 'wrought_iron'], ['copper_ingot', 'copper_hammer', 'copper_wire', 'coal']],
    ['a pick of bronze or better', atLeast('pick', 4), ['hematite', 'iron_bloom', 'wrought_iron', 'steel_bar', 'forge'], ['bronze_ingot', 'bronze_hammer', 'bronze_sword']],
    ['a pick of iron or better', atLeast('pick', 5), ['gold_nugget', 'gold_block', 'rough_gem'], ['wrought_iron', 'iron_hammer', 'steel_bar', 'workbench']],
    ['the Steel Pick', atLeast('pick', 6), ['rough_gem', 'diamond_block'], ['gold_nugget', 'steel_bar', 'steel_hammer', 'workbench']],
    ['a hammer of copper or better', atLeast('hammer', 3), ['copper_wire', 'stone_bricks', 'wrought_iron', 'workbench'], ['copper_pick', 'bronze_ingot', 'iron_bloom']],
    ['a hammer of bronze or better', atLeast('hammer', 4), ['wrought_iron', 'forge', 'iron_pick', 'steel_bar'], ['iron_bloom', 'bronze_pick', 'hematite', 'copper_wire']],
    ['a hammer of iron or better', atLeast('hammer', 5), ['steel_bar', 'steel_pick', 'workbench', 'rough_gem'], ['wrought_iron', 'iron_pick', 'gold_nugget']],
    ['the Steel Hammer', atLeast('hammer', 6), ['diamond_block'], ['steel_bar', 'rough_gem', 'workbench']],
    ['the Fire Drill', ['fire_drill'], ['campfire', 'torch', 'pot_boiled', 'roast_pork'], ['kiln', 'clay_pot', 'copper_ingot']],
    // coal, not charcoal, smelts ore
    ['coal', ['coal'], ['copper_ingot', 'tin_ingot', 'bronze_ingot', 'copper_pick', 'wrought_iron', 'steel_bar'], ['charcoal', 'clay_pot', 'fired_brick', 'crucible', 'malachite']],
    ['charcoal', ['charcoal'], ['iron_bloom', 'wrought_iron', 'glass', 'steel_bar'], ['copper_ingot', 'bronze_ingot', 'fired_brick', 'bronze_pick']],
    ['the Kiln', ['kiln'], ['copper_ingot', 'charcoal', 'fired_brick', 'bloomery', 'wrought_iron'], ['clay_pot', 'flint_pick', 'coal']],
    ['the Crucible', ['crucible'], ['bronze_ingot', 'copper_pick', 'copper_hammer', 'cassiterite'], ['copper_ingot', 'casting_mold']],
    ['the Casting Mold', ['casting_mold'], ['copper_pick', 'copper_hammer', 'cassiterite', 'bronze_ingot'], ['copper_ingot', 'crucible']],
    ['the Bellows', ['bellows'], ['bloomery', 'forge', 'wrought_iron', 'glass'], ['bronze_ingot', 'leather']],
    ['the Bloomery', ['bloomery'], ['wrought_iron', 'glass', 'forge', 'steel_bar'], ['bronze_pick', 'hematite', 'fired_brick']],
    ['the Forge', ['forge'], ['iron_pick', 'steel_bar', 'workbench'], ['wrought_iron', 'bronze_hammer']],
    ['the Workbench', ['workbench'], ['relay'], ['steel_bar', 'knife_switch']],
  ];

  it.each(GATES)('without %s the next step is closed', (_name, barred, lost, kept) => {
    const got = reachable(barred);
    for (const k of barred) expect(all.has(k), `${k} is normally reachable`).toBe(true);
    for (const k of lost) {
      if (k === 'rock_from_stone') {
        // stone itself: only a pick breaks it
        expect(rollDrops(BLOCK.STONE, null, {}, ALWAYS)).toEqual([]);
        continue;
      }
      expect(all.has(k), `${k} is normally reachable`).toBe(true);
      expect(got.has(k), `${k} must be closed`).toBe(false);
    }
    for (const k of kept) expect(got.has(k), `${k} must stay open`).toBe(true);
  });

  it('each step of every ladder opens something the step below does not', () => {
    // [kind, the tiers that are steps]: having tier t must reach more than having only the tiers below it
    for (const [type, tiers] of [['pick', [2, 3, 4, 5, 6]], ['hammer', [1, 3, 4, 5, 6]], ['axe', [1, 2]], ['shovel', [1]], ['knife', [2]]]) {
      for (const t of tiers) {
        const below = reachable(atLeast(type, t)); // nothing of this tier or better
        const withIt = reachable(atLeast(type, t + 1)); // this tier, nothing better
        const opened = [...withIt].filter((k) => !below.has(k) && !(ITEMS[k].tool && ITEMS[k].tool.type === type));
        expect(opened.length, `${type} tier ${t} opens nothing`).toBeGreaterThan(0);
      }
    }
  });
});
