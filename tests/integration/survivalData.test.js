// Survival data closure — docs/DESIGN-survival.md §10 "I" test 1 (CONTRACTS §42–§47). Pure modules only.
//
// Every non-block item must come from somewhere (a block drop, a pick, a tap, a mob, a recipe output, a fire transform or
// filling a pot) and go somewhere (a recipe input, a tool, wear, a bandage, a fire transform, fuel) or be food. Walking
// out from what a generation-2 world offers by hand, every recipe must become makeable without a cycle that needs itself,
// each pick tier must open the next tier's ore, and the loose stones of plains and forest must hold enough flint (§7.5).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCK_COUNT, FLINT_SHARE } from '../../src/blocks.js';
import { hexDiscCount } from '../../src/hex.js';
import { ITEMS, ITEM_KEYS, TAGS, getItem, itemForBlock, blockForItem } from '../../src/items.js';
import { BLOCK_RULES, PICKABLE, MOB_DROPS, GRAVEL_FLINT_P, canHarvest, tap } from '../../src/harvest.js';
import { RECIPES, STATION_BLOCKS } from '../../src/crafting.js';
import { FIRE_TRANSFORMS, fuelSeconds } from '../../src/cooking.js';
import { FLORA_TABLE } from '../../src/worldgen.js';
import { DART_KEYS } from '../../src/looseItems.js';

const B = BLOCK;
/** Items the game gives rather than the world (§14.2: the Handbook is in the pack when a survival state begins). */
const GIVEN = new Set(['handbook']);
/** Blocks a generation-2 world generates (§8): terrain, trees of three species, ores, ponds, flora and litter. */
const NATURAL_BLOCKS = [
  B.STONE, B.DIRT, B.GRASS_BLOCK, B.SAND, B.GRAVEL, B.CLAY, B.SANDSTONE, B.SNOW_BLOCK, B.SNOWY_GRASS, B.ICE,
  B.OAK_LOG, B.OAK_LEAVES, B.SPRUCE_LOG, B.SPRUCE_LEAVES, B.BIRCH_LOG, B.BIRCH_LEAVES,
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.COPPER_ORE, B.TIN_ORE,
  B.TUSSOCK, B.TUBER_PLANT, B.HONEYBERRY_BUSH, B.PRICKLY_PEAR, B.CATTAILS, B.LOOSE_STONES, B.FALLEN_BRANCHES,
  // v0.14 (§76 flora): what a generation-3 world grows besides
  B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.ONION_PLANT, B.CARROT_PLANT, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.HEALWORT_PLANT,
  // Not terrain, but left in the world by the Hollow Watcher's pillar traces (CONTRACTS §40.3): the only obsidian.
  B.OBSIDIAN,
];

const nonBlockKeys = ITEM_KEYS.filter((k) => ITEMS[k].kind !== 'block');

/** Every item key a drop-group list can give (all branches). */
function groupKeys(groups) {
  const out = new Set();
  for (const group of groups) for (const br of group) for (const it of br.items) out.add(it.k);
  return out;
}

/** Inputs of a recipe as lists of acceptable keys. */
function inputOptions(rec) {
  return rec.inputs.map((inp) => ('tag' in inp ? [...TAGS[inp.tag]] : [inp.k]));
}

describe('every item has a source and a use (§10 I-1)', () => {
  const sources = new Set();
  for (let id = 0; id < BLOCK_COUNT; id++) if (BLOCK_RULES[id]) for (const k of groupKeys(BLOCK_RULES[id].drops)) sources.add(k);
  for (const p of Object.values(PICKABLE)) for (const k of groupKeys(p.drops)) sources.add(k);
  for (const groups of Object.values(MOB_DROPS)) for (const k of groupKeys(groups)) sources.add(k);
  sources.add(tap(B.BIRCH_LOG, 'clay_pot', true).gives);
  sources.add('pot_water'); // R on fresh water with an empty clay pot (§4.2)
  sources.add('pot_milk'); // R on a cow with an empty clay pot (§72)
  sources.add('pot_seawater'); // … on salt water
  sources.add('pot_tainted'); // … on tainted water (§76 water)
  for (const rec of RECIPES) for (const o of rec.outputs) sources.add(o.k);
  for (const tr of Object.values(FIRE_TRANSFORMS)) sources.add(tr.to);

  const uses = new Set();
  for (const rec of RECIPES) for (const opts of inputOptions(rec)) for (const k of opts) uses.add(k);
  for (const k of Object.keys(FIRE_TRANSFORMS)) uses.add(k);
  uses.add('clay_pot'); // filled at water and tapped into (§4.2)
  for (const k of DART_KEYS) uses.add(k); // thrown (CONTRACTS §60)

  it.each(nonBlockKeys)('%s comes from somewhere', (key) => {
    expect(sources.has(key) || GIVEN.has(key)).toBe(true);
  });

  it.each(nonBlockKeys)('%s is good for something', (key) => {
    const def = getItem(key);
    const used = uses.has(key) || !!def.tool || !!def.food || !!def.heal || !!def.wear || fuelSeconds(key) > 0 || GIVEN.has(key);
    expect(used).toBe(true);
  });
});

/**
 * The reachability walk: starting with bare hands in a generation-2 world, keep adding what can be gathered (with the
 * tools obtained so far), picked, tapped, hunted, cooked on a campfire, filled from water or made at a workplace that can
 * itself be made, until nothing new appears. Anything that needs itself to be made never enters the set.
 * @returns {{ have: Set<string>, made: Set<string>, rounds: number }}
 */
function reach() {
  const have = new Set();
  const made = new Set();
  const tools = () => [...have].map((k) => getItem(k)?.tool).filter(Boolean);
  const hasTool = (type, tier) => tools().some((t) => t.type === type && t.tier >= tier);
  const hasAnyTool = () => tools().length > 0;
  /** branches of a drop group list that can be taken with the tools at hand (`natural` items only from untouched cells) */
  const gather = (groups, natural = true) => {
    for (const group of groups) {
      for (const br of group) {
        const ok = br.if === null || (br.if === 'knifeInPack' ? hasTool('knife', 2) : hasTool(br.if, 0));
        if (ok) for (const it of br.items) if (natural || !it.natural) have.add(it.k);
      }
    }
  };
  const breakableNow = (id) => !!BLOCK_RULES[id] && tools().concat([null]).some((t) => canHarvest(id, t));
  let rounds = 0;
  for (let changed = true; changed && rounds < 100; rounds++) {
    const before = have.size + made.size;
    for (const id of NATURAL_BLOCKS) {
      if (breakableNow(id)) gather(BLOCK_RULES[id].drops);
      if (PICKABLE[id]) gather(PICKABLE[id].drops);
    }
    // A block item can be placed and broken again: its drops, but never the `natural` ones (§6.3).
    for (const key of [...have]) {
      const id = blockForItem(key);
      if (id >= 0 && breakableNow(id)) gather(BLOCK_RULES[id].drops, false);
    }
    if (hasAnyTool()) for (const mob of ['pig', 'cow', 'sheep', 'horse', 'wolf', 'deer', 'rabbit', 'pheasant', 'turkey', 'bear']) gather(MOB_DROPS[mob]); // bare hands only shove (§4.3, §69; §76 fauna)
    if (hasTool('spear', 0)) gather(MOB_DROPS.fish); // only a spear catches a fish (§76 fauna)
    gather(PICKABLE[B.GROUND_NEST].drops); // wild pheasants and turkeys lay them; R takes the eggs (§76 fauna)
    gather(MOB_DROPS.zombie);
    if (have.has('clay_pot')) {
      have.add('pot_water');
      have.add('pot_milk'); // a cow, lured or snared (§72)
      have.add('pot_seawater');
      have.add('pot_tainted'); // tainted water (§76 water)
      if (hasTool('knife', 2)) have.add('pot_sap');
    }
    if (have.has('campfire')) for (const [k, tr] of Object.entries(FIRE_TRANSFORMS)) if (have.has(k)) have.add(tr.to);
    for (const rec of RECIPES) {
      const station = rec.station === 'hand' || have.has(itemForBlock(STATION_BLOCKS[rec.station])); // every workplace (v0.11: + the Workbench)
      const inputs = inputOptions(rec).every((opts) => opts.some((k) => have.has(k)));
      const tl = rec.tools.every((t) => hasTool(t.type, t.tier));
      if (station && inputs && tl) {
        made.add(rec.id);
        for (const o of rec.outputs) have.add(o.k);
      }
    }
    changed = have.size + made.size !== before;
  }
  return { have, made, rounds };
}

describe('the tech tree closes from bare hands (§7.4, §10 I-1)', () => {
  const { have, made } = reach();

  it('every recipe becomes makeable, in some order, without needing itself', () => {
    const unmade = RECIPES.filter((r) => !made.has(r.id)).map((r) => r.id);
    expect(unmade).toEqual([]);
  });

  it('every recipe input is obtainable', () => {
    for (const rec of RECIPES) {
      for (const opts of inputOptions(rec)) expect(opts.some((k) => have.has(k)), `${rec.id}: ${opts.join('|')}`).toBe(true);
    }
  });

  it('every non-block item is obtainable (the Handbook is given)', () => {
    const missing = nonBlockKeys.filter((k) => !have.has(k) && !GIVEN.has(k));
    expect(missing).toEqual([]);
  });

  it('the first hand-made things need nothing made before them', () => {
    // Before any tool: rock, flint, sticks and fibre come by hand, so cord and the stone hammer are the first makes.
    const first = new Set();
    for (const id of [B.LOOSE_STONES, B.FALLEN_BRANCHES, B.TUSSOCK]) {
      for (const k of groupKeys(PICKABLE[id] ? PICKABLE[id].drops : BLOCK_RULES[id].drops)) first.add(k);
    }
    for (const k of ['rock', 'flint', 'stick', 'plant_fibre']) expect(first.has(k), k).toBe(true);
    const hand = RECIPES.filter((r) => r.station === 'hand' && r.tools.length === 0 && r.inputs.every((i) => 'k' in i && first.has(i.k)));
    expect(hand.map((r) => r.id)).toEqual(expect.arrayContaining(['cord', 'stone_hammer']));
  });
});

describe('each pick tier opens the next tier of ore (§6.3, §7.4)', () => {
  const pickOf = (key) => getItem(key).tool;
  it('bare hands and a stone tool cannot cut rock; a flint pick can (no stone pick exists)', () => {
    expect(canHarvest(B.STONE, null)).toBe(false);
    expect(canHarvest(B.STONE, getItem('stone_axe').tool)).toBe(false);
    expect(ITEMS.stone_pick).toBeUndefined();
    expect(canHarvest(B.STONE, pickOf('flint_pick'))).toBe(true);
  });

  it.each([
    ['flint_pick', B.COPPER_ORE, B.TIN_ORE],
    ['copper_pick', B.TIN_ORE, B.IRON_ORE],
    ['bronze_pick', B.IRON_ORE, null],
    ['iron_pick', B.IRON_ORE, null],
    ['steel_pick', B.IRON_ORE, null],
  ])('%s mines block %i and not the next tier\'s', (pickKey, ore, next) => {
    expect(canHarvest(ore, pickOf(pickKey))).toBe(true);
    expect(canHarvest(B.COAL_ORE, pickOf(pickKey))).toBe(true);
    if (next !== null) expect(canHarvest(next, pickOf(pickKey))).toBe(false);
  });

  it('obsidian needs only a flint pick; gold needs iron and gems need steel (§77)', () => {
    expect(canHarvest(B.OBSIDIAN, pickOf('flint_pick'))).toBe(true);
    expect(canHarvest(B.GOLD_ORE, pickOf('bronze_pick'))).toBe(false);
    expect(canHarvest(B.GOLD_ORE, pickOf('iron_pick'))).toBe(true);
    expect(canHarvest(B.DIAMOND_ORE, pickOf('iron_pick'))).toBe(false);
    expect(canHarvest(B.DIAMOND_ORE, pickOf('steel_pick'))).toBe(true);
  });

  it('each tier\'s pick is made from what the tier before it mines', () => {
    const recipe = (id) => RECIPES.find((r) => r.id === id);
    expect(recipe('copper_pick').inputs.some((i) => i.k === 'copper_ingot')).toBe(true);
    expect(recipe('copper_ingot').inputs.some((i) => i.k === 'malachite')).toBe(true);
    expect(recipe('bronze_ingot').inputs.map((i) => i.k)).toEqual(expect.arrayContaining(['copper_ingot', 'tin_ingot']));
    expect(recipe('tin_ingot').inputs.some((i) => i.k === 'cassiterite')).toBe(true);
    expect(recipe('iron_bloom').inputs.some((i) => i.k === 'hematite')).toBe(true);
  });
});

describe('flint near a plains or forest start (§7.5, §8.3)', () => {
  const flintChance = PICKABLE[B.LOOSE_STONES].drops.flatMap((g) => g.flatMap((br) => br.items)).find((it) => it.k === 'flint').p;
  const columns = hexDiscCount(20); // 1 261 columns within hex distance 20

  // v0.14 (§76): flint is rare (it was 6–7 within distance 20, all from loose stones) and comes mostly from digging gravel.
  it.each([['PLAINS', 2], ['FOREST', 3]])('%s: about 3 flint expected within hex distance 20, most of it from gravel', (_name, biome) => {
    const stones = FLORA_TABLE[biome].rows.find((r) => r.id === B.LOOSE_STONES);
    const gravel = FLORA_TABLE[biome].rows.find((r) => r.id === B.GRAVEL);
    const fromStones = columns * stones.chance * flintChance;
    const fromGravel = columns * gravel.chance * GRAVEL_FLINT_P;
    expect(flintChance).toBe(FLINT_SHARE);
    expect(fromStones + fromGravel).toBeGreaterThanOrEqual(3); // still there to be found on the first day
    expect(fromStones + fromGravel).toBeLessThan(5); // rarer than it was
    expect(fromGravel).toBeGreaterThan(fromStones * 2); // usually found by digging gravel
  });

  it('wild gravel gives flint by chance, by hand or with a shovel; mined stone never', () => {
    expect([...groupKeys(BLOCK_RULES[B.GRAVEL].drops)]).toContain('flint');
    expect([...groupKeys(BLOCK_RULES[B.STONE].drops)]).not.toContain('flint');
  });
});
