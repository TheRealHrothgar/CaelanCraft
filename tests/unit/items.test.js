// Unit tests for src/items.js — the survival item registry (docs/DESIGN-survival.md §5.1–§5.2, §9.2).
import { describe, it, expect } from 'vitest';
import {
  TIER, TIER_NAMES, TIER_SPEED, TOOL_TYPES, WEAR_SLOT_NAMES, TAGS, ITEMS, ITEM_KEYS,
  getItem, isItemKey, stackSize, maxDurability, itemForBlock, blockForItem, hasTag, itemName, resolveItem,
} from '../../src/items.js';
import { BLOCK, BLOCKS, BLOCK_COUNT, PICKER_ORDER, isPlaceable } from '../../src/blocks.js';

const KINDS = ['block', 'material', 'food', 'heal', 'wear', 'tool'];
/** The data field each kind carries (exactly that one). */
const FIELD_OF_KIND = { block: 'block', material: null, food: 'food', heal: 'heal', wear: 'wear', tool: 'tool' };
const LOWER_SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** §5.1 tools: key → [display name, type, tier, durability, power]. */
const TOOLS = {
  hammerstone: ['Hammerstone', 'hammer', 1, 60, 1],
  stone_chopper: ['Stone Chopper', 'axe', 1, 40, 2],
  digging_stick: ['Digging Stick', 'spade', 1, 40, 1],
  flint_knife: ['Flint Knife', 'knife', 2, 70, 1],
  flint_axe: ['Flint Axe', 'axe', 2, 90, 2],
  flint_pick: ['Flint Pick', 'pick', 2, 90, 1],
  flint_spade: ['Flint Spade', 'spade', 2, 90, 1],
  flint_spear: ['Flint Spear', 'spear', 2, 60, 3],
  copper_knife: ['Copper Knife', 'knife', 3, 140, 2],
  copper_axe: ['Copper Axe', 'axe', 3, 160, 2],
  copper_pick: ['Copper Pick', 'pick', 3, 160, 1],
  copper_spade: ['Copper Spade', 'spade', 3, 160, 1],
  copper_hammer: ['Copper Hammer', 'hammer', 3, 160, 1],
  bronze_knife: ['Bronze Knife', 'knife', 4, 260, 2],
  bronze_axe: ['Bronze Axe', 'axe', 4, 320, 3],
  bronze_pick: ['Bronze Pick', 'pick', 4, 320, 1],
  bronze_spade: ['Bronze Spade', 'spade', 4, 320, 1],
  bronze_hammer: ['Bronze Hammer', 'hammer', 4, 320, 1],
  bronze_sword: ['Bronze Sword', 'sword', 4, 280, 3],
  iron_knife: ['Iron Knife', 'knife', 5, 500, 3],
  iron_axe: ['Iron Axe', 'axe', 5, 600, 3],
  iron_pick: ['Iron Pick', 'pick', 5, 600, 1],
  iron_spade: ['Iron Spade', 'spade', 5, 600, 1],
  iron_hammer: ['Iron Hammer', 'hammer', 5, 600, 1],
  iron_sword: ['Iron Sword', 'sword', 5, 550, 4],
  steel_knife: ['Steel Knife', 'knife', 6, 1000, 3],
  steel_axe: ['Steel Axe', 'axe', 6, 1200, 4],
  steel_pick: ['Steel Pick', 'pick', 6, 1200, 1],
  steel_spade: ['Steel Spade', 'spade', 6, 1200, 1],
  steel_hammer: ['Steel Hammer', 'hammer', 6, 1200, 1],
  steel_sword: ['Steel Sword', 'sword', 6, 1100, 5],
  fire_drill: ['Fire Drill', 'firestarter', 0, 8, 1],
  crucible: ['Crucible', 'crucible', 0, 20, 1],
  casting_mold: ['Casting Mold', 'mold', 0, 12, 1],
};

/** §5.1 materials: key → [display name, stack]. */
const MATERIALS = {
  rock: ['Rock', 64], flint: ['Flint', 32], obsidian_shard: ['Obsidian Shard', 32], stick: ['Stick', 64],
  plant_fibre: ['Plant Fibre', 64], cord: ['Cord', 32], birch_bark: ['Birch Bark', 32], clay_lump: ['Clay Lump', 32],
  coal: ['Coal', 32], charcoal: ['Charcoal', 32], malachite: ['Malachite', 32], cassiterite: ['Cassiterite', 32],
  hematite: ['Hematite', 32], gold_nugget: ['Gold Nugget', 32], rough_gem: ['Rough Gem', 16],
  copper_ingot: ['Copper Ingot', 32], tin_ingot: ['Tin Ingot', 32], bronze_ingot: ['Bronze Ingot', 32],
  iron_bloom: ['Iron Bloom', 16], wrought_iron: ['Wrought Iron Bar', 32], steel_bar: ['Steel Bar', 32],
  rawhide: ['Rawhide', 16], leather: ['Leather', 16], salt: ['Salt', 32], ice_chunk: ['Ice Chunk', 32],
  grave_rag: ['Grave Rag', 32], glass_shards: ['Glass Shards', 32], unpeeled_cactus_fruit: ['Unpeeled Cactus Fruit', 16],
  greenware_pot: ['Greenware Pot', 8], green_brick: ['Green Brick', 32], fired_brick: ['Fired Brick', 32],
  greenware_crucible: ['Greenware Crucible', 4], greenware_mold: ['Greenware Mold', 4], bellows: ['Bellows', 1],
  clay_pot: ['Clay Pot', 8], salt_pot: ['Salt-crusted Pot', 1], pot_snow: ['Pot of Snow', 1],
  handbook: ['Survival Handbook', 1], // §14: added by package H, the last material
};

/** §5.1 / §4.5 food: key → [display name, stack, satiation, hydration, sick, useS, extra]. */
const FOODS = {
  honeyberries: ['Honeyberries', 32, 4, 2, 0, 0.8, { spoilS: 1800 }],
  acorns: ['Acorns', 32, 2, -2, 0, 1.0, {}],
  leached_acorns: ['Leached Acorns', 32, 3, 0, 0, 1.0, {}],
  roasted_acorns: ['Roasted Acorns', 32, 5, 0, 0, 1.0, {}],
  pine_nuts: ['Pine Nuts', 32, 4, 0, 0, 1.0, {}],
  wild_tuber: ['Wild Tuber', 16, 4, 1, 0.05, 1.2, {}],
  baked_tuber: ['Baked Tuber', 16, 12, 0, 0, 1.2, {}],
  cattail_root: ['Cattail Root', 16, 3, 1, 0, 1.0, {}],
  roasted_cattail_root: ['Roasted Cattail Root', 16, 8, 0, 0, 1.0, {}],
  cactus_fruit: ['Cactus Fruit', 16, 3, 8, 0, 1.0, {}],
  raw_pork: ['Raw Pork', 16, 6, 0, 0.3, 1.4, { spoilS: 1200 }],
  roast_pork: ['Roast Pork', 16, 30, -2, 0, 1.6, { spoilS: 2400 }],
  charred_meat: ['Charred Meat', 16, 6, -4, 0, 1.4, {}],
  salted_pork: ['Salted Pork', 16, 18, -6, 0, 1.4, {}],
  pig_fat: ['Pig Fat', 16, 6, -2, 0.1, 1.2, {}],
  snow: ['Snow', 32, 0, 3, 0, 0.6, { temp: -0.2 }],
  pot_water: ['Pot of Water', 1, 0, 30, 0.03, 1.0, { returns: 'clay_pot' }],
  pot_boiled: ['Pot of Boiled Water', 1, 0, 30, 0, 1.0, { returns: 'clay_pot' }],
  pot_seawater: ['Pot of Seawater', 1, 0, -10, 0, 1.0, { returns: 'clay_pot' }],
  pot_sap: ['Pot of Birch Sap', 1, 2, 25, 0, 1.0, { returns: 'clay_pot' }],
};

/** §5.1 bandages: key → [display name, stack, hp, rate, useS]. */
const HEALS = {
  fibre_bandage: ['Fibre Bandage', 8, 15, 1.5, 1.5],
  rag_bandage: ['Rag Bandage', 8, 25, 2.5, 1.5],
};

/** §5.1 clothes: key → [display name, slot, insulation, sunShade]. */
const WEARS = {
  straw_hat: ['Straw Hat', 'head', 0, 0.5],
  leather_hood: ['Leather Hood', 'head', 2, 0],
  grass_cape: ['Grass Cape', 'body', 2, 0],
  leather_coat: ['Leather Coat', 'body', 6, 0],
  hide_shoes: ['Grass-lined Shoes', 'feet', 2, 0],
};

/**
 * Every non-block key the rest of the design names (§4.2–§4.5 drinking, cooking and food; §6.3 drops and mob drops; §6.4
 * picking and tapping; §7.1–§7.3 recipes and workplaces; §9.10 smoke), so a typo in the registry fails here, before the
 * packages fork. Block keys named there are checked separately below.
 */
const REFERENCED = [
  // drops, picks, taps and mobs
  'plant_fibre', 'snow', 'rock', 'clay_lump', 'ice_chunk', 'flint', 'stick', 'acorns', 'pine_nuts', 'honeyberries',
  'cactus_fruit', 'unpeeled_cactus_fruit', 'wild_tuber', 'cattail_root', 'birch_bark', 'charcoal', 'glass_shards',
  'obsidian_shard', 'coal', 'malachite', 'cassiterite', 'hematite', 'gold_nugget', 'rough_gem', 'raw_pork', 'rawhide',
  'pig_fat', 'grave_rag', 'pot_sap', 'clay_pot',
  // fire spots
  'roast_pork', 'charred_meat', 'baked_tuber', 'roasted_cattail_root', 'leached_acorns', 'roasted_acorns', 'pot_water',
  'pot_boiled', 'pot_seawater', 'salt_pot', 'pot_snow', 'greenware_pot',
  // recipes: hand, stump, kiln, bloomery, forge
  'cord', 'hammerstone', 'stone_chopper', 'digging_stick', 'flint_knife', 'flint_axe', 'flint_pick', 'flint_spade',
  'flint_spear', 'fire_drill', 'green_brick', 'greenware_crucible', 'greenware_mold', 'straw_hat', 'grass_cape',
  'fibre_bandage', 'rag_bandage', 'salt', 'salted_pork', 'fired_brick', 'bellows', 'wrought_iron', 'leather',
  'leather_hood', 'leather_coat', 'hide_shoes', 'crucible', 'casting_mold', 'copper_ingot', 'tin_ingot', 'bronze_ingot',
  'iron_bloom', 'steel_bar',
  ...['knife', 'spade', 'axe', 'hammer', 'pick'].map((t) => `copper_${t}`),
  ...['bronze', 'iron', 'steel'].flatMap((m) => ['knife', 'spade', 'axe', 'hammer', 'pick', 'sword'].map((t) => `${m}_${t}`)),
];
/** Block items the design names as drops, recipe outputs, tag members or inputs. */
const REFERENCED_BLOCKS = [
  'dirt', 'grass_block', 'snowy_grass', 'sand', 'red_sand', 'gravel', 'clay', 'snow_block', 'ice', 'packed_ice', 'oak_leaves',
  'spruce_leaves', 'birch_leaves', 'honeyberry_bush', 'prickly_pear', 'tussock', 'cattails', 'tuber_plant', 'oak_log',
  'spruce_log', 'birch_log', 'oak_planks', 'spruce_planks', 'birch_planks', 'bookshelf', 'work_stump', 'wicker_basket',
  'powder_keg', 'pumpkin', 'hay_bale', 'honeycomb_block', 'sleeping_hide', 'campfire', 'glass', 'glowstone', 'kiln',
  'bloomery', 'forge', 'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'mossy_stone_bricks', 'bricks', 'granite',
  'diorite', 'andesite', 'slate', 'sandstone', 'obsidian', 'rune_block', 'coal_ore', 'copper_ore', 'tin_ore', 'iron_ore',
  'gold_ore', 'diamond_ore', 'coal_block', 'copper_block', 'gold_block', 'iron_block', 'diamond_block', 'stone',
  'wool_white', 'wool_light_gray',
];

describe('items — tiers, tool types, wear slots', () => {
  it('TIER, TIER_NAMES and TIER_SPEED follow §5.1', () => {
    expect(TIER).toEqual({ HAND: 0, STONE: 1, FLINT: 2, COPPER: 3, BRONZE: 4, IRON: 5, STEEL: 6 });
    expect(TIER_NAMES).toEqual(['hand', 'stone', 'flint', 'copper', 'bronze', 'iron', 'steel']);
    expect(TIER_SPEED).toEqual([1, 1.5, 2, 2.6, 3.4, 4.5, 6]);
    for (const [name, t] of Object.entries(TIER)) expect(TIER_NAMES[t]).toBe(name.toLowerCase());
    for (let t = 1; t < TIER_SPEED.length; t++) expect(TIER_SPEED[t]).toBeGreaterThan(TIER_SPEED[t - 1]);
  });
  it('TOOL_TYPES lists every tool type once; WEAR_SLOT_NAMES is head, body, feet', () => {
    expect([...TOOL_TYPES].sort()).toEqual(['axe', 'crucible', 'firestarter', 'hammer', 'knife', 'mold', 'pick', 'spade', 'spear', 'sword']);
    expect(new Set(Object.values(TOOLS).map((t) => t[1]))).toEqual(new Set(TOOL_TYPES));
    expect(WEAR_SLOT_NAMES).toEqual(['head', 'body', 'feet']);
  });
  it('everything exported is frozen, down to the nested item data', () => {
    for (const o of [TIER, TIER_NAMES, TIER_SPEED, TOOL_TYPES, WEAR_SLOT_NAMES, TAGS, ITEMS, ITEM_KEYS]) {
      expect(Object.isFrozen(o)).toBe(true);
    }
    for (const list of Object.values(TAGS)) expect(Object.isFrozen(list)).toBe(true);
    for (const def of Object.values(ITEMS)) {
      expect(Object.isFrozen(def), def.key).toBe(true);
      for (const f of ['tool', 'food', 'heal', 'wear', 'tags']) if (def[f]) expect(Object.isFrozen(def[f]), `${def.key}.${f}`).toBe(true);
    }
    expect(() => {
      ITEMS.rock.stack = 1; // modules are strict: writing a frozen property throws
    }).toThrow();
    expect(stackSize('rock')).toBe(64);
  });
});

describe('items — the registry', () => {
  it('keys are unique and lower_snake, and ITEM_KEYS lists exactly the ITEMS keys', () => {
    expect(ITEM_KEYS).toEqual(Object.keys(ITEMS));
    expect(new Set(ITEM_KEYS).size).toBe(ITEM_KEYS.length);
    for (const key of ITEM_KEYS) {
      expect(key, key).toMatch(LOWER_SNAKE);
      expect(ITEMS[key].key).toBe(key);
      expect(getItem(key)).toBe(ITEMS[key]);
      expect(isItemKey(key)).toBe(true);
    }
    // 34 tools, 37 materials + the handbook (§14), 20 foods, 2 bandages, 5 clothes and the 98 placeable blocks other than water
    // (DESIGN-circuits §1.5: PICKER_ORDER drops the black hole and gains the 20 circuit blocks; the blast barrel's key is now powder_keg).
    const count = (kind) => ITEM_KEYS.filter((k) => ITEMS[k].kind === kind).length;
    expect([count('tool'), count('material'), count('food'), count('heal'), count('wear'), count('block')]).toEqual([34, 38, 20, 2, 5, 98]);
    expect(ITEM_KEYS).toHaveLength(197);
  });
  it('no item clashes with another: keys and display names are unique, and no display name spells another item\'s key', () => {
    const names = new Map();
    for (const key of ITEM_KEYS) {
      const name = ITEMS[key].name;
      expect(typeof name === 'string' && name.length > 0 && name.trim() === name, key).toBe(true);
      const norm = name.toLowerCase().replace(/\s+/g, '_');
      expect(names.has(norm), `${key} and ${names.get(norm)} are both "${name}"`).toBe(false);
      names.set(norm, key);
      if (isItemKey(norm)) expect(norm, `the name of ${key} is the key of another item`).toBe(key);
    }
  });
  it('every item has a known kind and exactly the data field of its kind', () => {
    for (const def of Object.values(ITEMS)) {
      expect(KINDS, def.key).toContain(def.kind);
      for (const f of ['block', 'tool', 'food', 'heal', 'wear']) {
        expect(f in def, `${def.key}.${f}`).toBe(FIELD_OF_KIND[def.kind] === f);
      }
      const allowed = new Set(['key', 'name', 'kind', 'stack', 'tags', FIELD_OF_KIND[def.kind]]);
      for (const f of Object.keys(def)) expect(allowed.has(f), `${def.key} has ${f}`).toBe(true);
    }
  });
  it('display order: tools, materials, food, bandages, clothes, then the block items in PICKER_ORDER order', () => {
    const kinds = ITEM_KEYS.map((k) => ITEMS[k].kind);
    const order = ['tool', 'material', 'food', 'heal', 'wear', 'block'];
    for (let i = 1; i < kinds.length; i++) {
      expect(order.indexOf(kinds[i]), ITEM_KEYS[i]).toBeGreaterThanOrEqual(order.indexOf(kinds[i - 1]));
    }
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'tool')).toEqual(Object.keys(TOOLS));
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'material')).toEqual(Object.keys(MATERIALS));
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food')).toEqual(Object.keys(FOODS));
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'heal')).toEqual(Object.keys(HEALS));
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'wear')).toEqual(Object.keys(WEARS));
    const blockOrder = PICKER_ORDER.filter((id) => id !== BLOCK.WATER).map((id) => BLOCKS[id].name);
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'block')).toEqual(blockOrder);
  });
  it('stacks are valid: positive integers, block items 64, tools and clothes 1', () => {
    for (const def of Object.values(ITEMS)) {
      expect(Number.isInteger(def.stack) && def.stack >= 1 && def.stack <= 64, def.key).toBe(true);
      expect(stackSize(def.key)).toBe(def.stack);
      if (def.kind === 'block') expect(def.stack, def.key).toBe(64);
      if (def.kind === 'tool' || def.kind === 'wear') expect(def.stack, def.key).toBe(1);
    }
  });
  it('tools: the §5.1 table exactly; stack 1 and a durability, and only tools have one', () => {
    for (const [key, [name, type, tier, durability, power]] of Object.entries(TOOLS)) {
      const def = getItem(key);
      expect(def, key).not.toBeNull();
      expect([def.name, def.kind, def.stack], key).toEqual([name, 'tool', 1]);
      expect(def.tool, key).toEqual({ type, tier, durability, power });
      expect(maxDurability(key)).toBe(durability);
      expect(durability > 0 && Number.isInteger(durability)).toBe(true);
      expect(TOOL_TYPES).toContain(type);
      expect(tier >= 0 && tier < TIER_NAMES.length).toBe(true);
    }
    for (const def of Object.values(ITEMS)) expect(maxDurability(def.key) > 0, def.key).toBe(def.kind === 'tool');
    // The metal tiers are complete: knife, axe, pick, spade and hammer from copper up, swords from bronze up.
    for (const [metal, tier] of [['copper', 3], ['bronze', 4], ['iron', 5], ['steel', 6]]) {
      for (const t of ['knife', 'axe', 'pick', 'spade', 'hammer', ...(tier >= 4 ? ['sword'] : [])]) {
        expect(getItem(`${metal}_${t}`)?.tool, `${metal}_${t}`).toMatchObject({ type: t, tier });
      }
    }
    // There is no stone pick: the flint pick (tier 2) is the first way into rock.
    expect(Object.values(ITEMS).filter((d) => d.tool?.type === 'pick').map((d) => d.tool.tier).sort()).toEqual([2, 3, 4, 5, 6]);
  });
  it('materials, food, bandages and clothes: the §5.1 / §4.5 tables exactly', () => {
    for (const [key, [name, stack]] of Object.entries(MATERIALS)) {
      const def = getItem(key);
      expect([def.name, def.kind, def.stack], key).toEqual([name, 'material', stack]);
    }
    for (const [key, [name, stack, satiation, hydration, sick, useS, extra]] of Object.entries(FOODS)) {
      const def = getItem(key);
      expect([def.name, def.kind, def.stack], key).toEqual([name, 'food', stack]);
      expect(def.food, key).toEqual({ satiation, hydration, sick, useS, ...extra });
    }
    for (const [key, [name, stack, hp, rate, useS]] of Object.entries(HEALS)) {
      expect(getItem(key), key).toEqual({ key, name, kind: 'heal', stack, heal: { hp, rate, useS } });
    }
    for (const [key, [name, slot, insulation, sunShade]] of Object.entries(WEARS)) {
      expect(getItem(key), key).toEqual({ key, name, kind: 'wear', stack: 1, wear: { slot, insulation, sunShade } });
      expect(WEAR_SLOT_NAMES).toContain(slot);
    }
    // Every wear slot has something to wear; leather head-to-toe is I 10 (the §3.4 worked example).
    for (const slot of WEAR_SLOT_NAMES) expect(Object.values(WEARS).some((w) => w[1] === slot), slot).toBe(true);
    expect(['leather_hood', 'leather_coat', 'hide_shoes'].reduce((s, k) => s + getItem(k).wear.insulation, 0)).toBe(10);
  });
  it('food data is coherent: returns name a real item, chances are 0..1, only three foods spoil', () => {
    for (const def of Object.values(ITEMS)) {
      if (!def.food) continue;
      const f = def.food;
      expect(f.sick >= 0 && f.sick <= 1 && f.useS > 0, def.key).toBe(true);
      if (f.returns !== undefined) expect(isItemKey(f.returns), def.key).toBe(true);
      if (f.spoilS !== undefined) expect(f.spoilS, def.key).toBeGreaterThan(0);
    }
    expect(Object.values(ITEMS).filter((d) => d.food?.spoilS).map((d) => d.key)).toEqual(['honeyberries', 'raw_pork', 'roast_pork']);
    // pot_snow and unpeeled_cactus_fruit are materials: boiled, singed or peeled first, never eaten as they are.
    expect(getItem('pot_snow').kind).toBe('material');
    expect(getItem('unpeeled_cactus_fruit').kind).toBe('material');
  });
  it('§14 the Survival Handbook: a plain item, stack 1, no durability, never spoils, places nothing, resolvable by name', () => {
    expect(getItem('handbook')).toEqual({ key: 'handbook', name: 'Survival Handbook', kind: 'material', stack: 1 });
    expect(stackSize('handbook')).toBe(1);
    expect(maxDurability('handbook')).toBe(0);
    expect(blockForItem('handbook')).toBe(-1);
    expect(resolveItem('handbook')).toEqual({ key: 'handbook' });
    expect(resolveItem('Survival Handbook')).toEqual({ key: 'handbook' });
    // the last material, right before the food (ITEM_KEYS order)
    const materials = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'material');
    expect(materials[materials.length - 1]).toBe('handbook');
  });
  it('every key the rest of the design names exists (drops, picks, fire spots, recipes, workplaces)', () => {
    for (const key of REFERENCED) expect(isItemKey(key), key).toBe(true);
    for (const key of REFERENCED_BLOCKS) {
      expect(getItem(key)?.kind, key).toBe('block');
    }
  });
});

describe('items — block items', () => {
  it('every placeable block except WATER has an item: key = block name, its display name, stack 64', () => {
    for (const d of BLOCKS) {
      if (!d.placeable || d.id === BLOCK.WATER) continue;
      const def = getItem(d.name);
      expect(def, d.name).not.toBeNull();
      expect([def.kind, def.name, def.stack], d.name).toEqual(['block', d.displayName, 64]);
      expect(itemForBlock(d.id)).toBe(d.name);
    }
    expect(isItemKey('water')).toBe(false);
    expect(itemForBlock(BLOCK.WATER)).toBeNull();
  });
  it('LOOSE_STONES, FALLEN_BRANCHES, FIRE_PIT and REMAINS (and every other unplaceable block) have none', () => {
    for (const id of [BLOCK.LOOSE_STONES, BLOCK.FALLEN_BRANCHES, BLOCK.FIRE_PIT, BLOCK.REMAINS]) {
      expect(isPlaceable(id)).toBe(false);
      expect(itemForBlock(id), BLOCKS[id].name).toBeNull();
      expect(isItemKey(BLOCKS[id].name), BLOCKS[id].name).toBe(false);
    }
    for (const d of BLOCKS) {
      if (d.placeable || d.id === BLOCK.HONEYBERRY_BUSH_BARE || d.id === BLOCK.PRICKLY_PEAR_BARE) continue;
      expect(itemForBlock(d.id), d.name).toBeNull();
      expect(isItemKey(d.name), d.name).toBe(false);
    }
    for (const id of [-1, BLOCK_COUNT, 200, 255, NaN, 1.5]) expect(itemForBlock(id)).toBeNull();
  });
  it('the bush items: both bush blocks give the ripe item, and the item places the picked variant', () => {
    expect(itemForBlock(BLOCK.HONEYBERRY_BUSH)).toBe('honeyberry_bush');
    expect(itemForBlock(BLOCK.HONEYBERRY_BUSH_BARE)).toBe('honeyberry_bush');
    expect(itemForBlock(BLOCK.PRICKLY_PEAR)).toBe('prickly_pear');
    expect(itemForBlock(BLOCK.PRICKLY_PEAR_BARE)).toBe('prickly_pear');
    expect(blockForItem('honeyberry_bush')).toBe(BLOCK.HONEYBERRY_BUSH_BARE);
    expect(blockForItem('prickly_pear')).toBe(BLOCK.PRICKLY_PEAR_BARE);
    expect(getItem('honeyberry_bush').name).toBe('Honeyberry Bush');
    expect(isItemKey('honeyberry_bush_bare') || isItemKey('prickly_pear_bare')).toBe(false);
  });
  it('blockForItem and itemForBlock round-trip; non-block items place nothing', () => {
    for (const def of Object.values(ITEMS)) {
      if (def.kind === 'block') {
        expect(blockForItem(def.key)).toBe(def.block);
        expect(itemForBlock(def.block), def.key).toBe(def.key);
        expect(def.block >= 0 && def.block < BLOCK_COUNT).toBe(true);
      } else {
        expect(blockForItem(def.key), def.key).toBe(-1);
      }
    }
    for (const key of ['', 'nope', 'water', 'honeyberry_bush_bare', '__proto__', 'constructor']) expect(blockForItem(key)).toBe(-1);
    for (const key of ['stone', 'kiln', 'campfire', 'tussock', 'work_stump']) expect(blockForItem(key)).toBe(BLOCK[key.toUpperCase()]);
  });
});

describe('items — tags', () => {
  it('TAGS is §5.1 exactly, in taking order, and lists only existing keys', () => {
    expect(TAGS).toEqual({
      log: ['oak_log', 'spruce_log', 'birch_log'],
      planks: ['oak_planks', 'spruce_planks', 'birch_planks'],
      fuel: ['coal', 'charcoal'],
      tinder: ['birch_bark', 'plant_fibre'],
      knapstone: ['flint', 'obsidian_shard'],
      sand: ['sand', 'red_sand'],
    });
    for (const [tag, keys] of Object.entries(TAGS)) {
      expect(tag).toMatch(LOWER_SNAKE);
      expect(new Set(keys).size, tag).toBe(keys.length);
      for (const key of keys) expect(isItemKey(key), `#${tag}: ${key}`).toBe(true);
    }
  });
  it('hasTag and ItemDef.tags agree with TAGS', () => {
    for (const key of ITEM_KEYS) {
      const expected = Object.keys(TAGS).filter((tag) => TAGS[tag].includes(key));
      expect(getItem(key).tags ?? [], key).toEqual(expected);
      for (const tag of Object.keys(TAGS)) expect(hasTag(key, tag)).toBe(expected.includes(tag));
    }
    expect(hasTag('charcoal', 'fuel') && hasTag('birch_log', 'log') && hasTag('red_sand', 'sand')).toBe(true);
    expect(hasTag('stick', 'fuel') || hasTag('oak_log', 'planks') || hasTag('flint', 'nope')).toBe(false);
    for (const tag of ['__proto__', 'constructor', 'toString', '', undefined, null]) expect(hasTag('coal', tag)).toBe(false);
    expect(hasTag('nope', 'log')).toBe(false);
  });
});

describe('items — lookups', () => {
  it('unknown keys: getItem null, isItemKey false, stackSize 0, maxDurability 0, blockForItem -1, itemName "?"', () => {
    for (const bad of ['', 'nope', 'Rock', ' rock', 'rock ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 0, 1, {}, []]) {
      // @ts-ignore — deliberately passing garbage
      expect(getItem(bad), String(bad)).toBeNull();
      // @ts-ignore
      expect(isItemKey(bad)).toBe(false);
      // @ts-ignore
      expect(stackSize(bad)).toBe(0);
      // @ts-ignore
      expect(maxDurability(bad)).toBe(0);
      // @ts-ignore
      expect(blockForItem(bad)).toBe(-1);
      // @ts-ignore
      expect(itemName(bad)).toBe('?');
    }
  });
  it('itemName gives the display name; maxDurability is 0 for items that never wear', () => {
    expect(itemName('rock')).toBe('Rock');
    expect(itemName('wrought_iron')).toBe('Wrought Iron Bar');
    expect(itemName('hide_shoes')).toBe('Grass-lined Shoes');
    expect(itemName('remains')).toBe('?');
    expect(itemName('wool_white')).toBe('White Wool');
    expect(maxDurability('rock')).toBe(0);
    expect(maxDurability('straw_hat')).toBe(0);
    expect(maxDurability('stone')).toBe(0);
    expect(maxDurability('steel_pick')).toBe(1200);
  });
});

describe('items — resolveItem', () => {
  it('resolves keys and display names (spaces as "_"), case-insensitively', () => {
    expect(resolveItem('rock')).toEqual({ key: 'rock' });
    expect(resolveItem('ROCK')).toEqual({ key: 'rock' });
    expect(resolveItem('  flint_pick  ')).toEqual({ key: 'flint_pick' });
    expect(resolveItem('Pot_of_Water')).toEqual({ key: 'pot_water' });
    expect(resolveItem('pot of boiled water')).toEqual({ key: 'pot_boiled' });
    expect(resolveItem('wrought_iron_bar')).toEqual({ key: 'wrought_iron' });
    expect(resolveItem('wrought_iron')).toEqual({ key: 'wrought_iron' });
    expect(resolveItem('Grass-lined_Shoes')).toEqual({ key: 'hide_shoes' });
    expect(resolveItem('salt-crusted_pot')).toEqual({ key: 'salt_pot' });
    expect(resolveItem('white_wool')).toEqual({ key: 'wool_white' });
    expect(resolveItem('Tussock_Grass')).toEqual({ key: 'tussock' });
    expect(resolveItem('block_of_coal')).toEqual({ key: 'coal_block' });
  });
  it('every item resolves from its key and from its display name', () => {
    for (const key of ITEM_KEYS) {
      expect(resolveItem(key)).toEqual({ key });
      expect(resolveItem(key.toUpperCase())).toEqual({ key });
      expect(resolveItem(ITEMS[key].name.replace(/ /g, '_'))).toEqual({ key });
      expect(resolveItem(ITEMS[key].name)).toEqual({ key });
    }
  });
  it('rejects empty and unknown tokens with a message (no prefixes, no block-only names)', () => {
    expect(resolveItem('')).toEqual({ error: 'expected an item name' });
    expect(resolveItem('   ')).toEqual({ error: 'expected an item name' });
    expect(resolveItem(undefined)).toEqual({ error: 'expected an item name' });
    expect(resolveItem(null)).toEqual({ error: 'expected an item name' });
    expect(resolveItem('zzz')).toEqual({ error: 'unknown item "zzz" (type items to list them)' });
    expect(resolveItem(' Zzz ')).toEqual({ error: 'unknown item "Zzz" (type items to list them)' });
    for (const bad of ['roc', 'flint_p', 'water', 'your_belongings', 'loose_stones', 'honeyberry_bush_bare', '__proto__', 'constructor']) {
      expect('error' in resolveItem(bad), bad).toBe(true);
    }
  });
});
