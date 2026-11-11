// Caelancraft — the survival item registry: every item's key, display name, kind, stack size and data (tools, food,
// bandages, clothes), the tool tiers and the tags. Pure. See docs/DESIGN-survival.md §5.1 (CONTRACTS §43 once merged).
//
// Items are addressed by a unique lower_snake KEY; saves store keys, never numbers. Block items are generated from
// blocks.js: every placeable block except WATER, keyed by the block's `name`, stack 64. The honeyberry_bush and
// prickly_pear items place their picked (*_BARE) variant, so a transplanted bush must regrow before it gives fruit.
import { BLOCK, BLOCKS, PICKER_ORDER } from './blocks.js';

/** @typedef {import('./types.js').ItemDef} ItemDef */
/** @typedef {import('./types.js').ToolDef} ToolDef */
/** @typedef {import('./types.js').FoodDef} FoodDef */
/** @typedef {import('./types.js').WearDef} WearDef */

/** Tool tiers by name: a tool of tier t works where a rule asks for tier ≤ t (§6.1). */
export const TIER = Object.freeze({ HAND: 0, STONE: 1, FLINT: 2, COPPER: 3, BRONZE: 4, IRON: 5, STEEL: 6 });
/** Index = tier. */
export const TIER_NAMES = Object.freeze(['hand', 'stone', 'flint', 'copper', 'bronze', 'iron', 'steel']);
/** Dig speed of a tool of the right type, index = tier (the bare hand is 1). */
export const TIER_SPEED = Object.freeze([1, 1.5, 2, 2.6, 3.4, 4.5, 6]);
/** Every `ToolDef.type`, in the order the tool table first uses them. */
export const TOOL_TYPES = Object.freeze([
  'hammer', 'axe', 'shovel', 'knife', 'pick', 'spear', 'sword', 'firestarter', 'crucible', 'mold',
]);
/** The three wear slots, index = wear slot (`Pack.wear[i]`). */
export const WEAR_SLOT_NAMES = Object.freeze(['head', 'body', 'feet']);
/** Tag → member keys. A recipe's `#tag` input takes its members in this order (charcoal last: keep it for iron). */
export const TAGS = Object.freeze({
  log: Object.freeze(['oak_log', 'spruce_log', 'birch_log']),
  planks: Object.freeze(['oak_planks', 'spruce_planks', 'birch_planks']),
  fuel: Object.freeze(['coal', 'charcoal']),
  tinder: Object.freeze(['birch_bark', 'plant_fibre']),
  knapstone: Object.freeze(['flint', 'obsidian_shard']),
  sand: Object.freeze(['sand', 'red_sand']),
});

/** Stack size of every block item. */
const BLOCK_ITEM_STACK = 64;

/**
 * The tools (§5.1), all stack 1: [key, display name, type, tier, durability, power]. Power is the damage one hit deals a mob.
 * @type {ReadonlyArray<[string, string, string, number, number, number]>}
 */
const TOOL_ROWS = [
  // tier 1, stone
  ['stone_hammer', 'Stone Hammer', 'hammer', 1, 60, 1],
  ['stone_axe', 'Stone Axe', 'axe', 1, 40, 2],
  ['wooden_shovel', 'Wooden Shovel', 'shovel', 1, 40, 1],
  // tier 2, flint (knapped with the stone hammer)
  ['flint_knife', 'Flint Knife', 'knife', 2, 70, 1],
  ['flint_axe', 'Flint Axe', 'axe', 2, 90, 2],
  ['flint_pick', 'Flint Pick', 'pick', 2, 90, 1],
  ['flint_shovel', 'Flint Shovel', 'shovel', 2, 90, 1],
  ['flint_spear', 'Flint Spear', 'spear', 2, 60, 3],
  // tier 3, copper
  ['copper_knife', 'Copper Knife', 'knife', 3, 140, 2],
  ['copper_axe', 'Copper Axe', 'axe', 3, 160, 2],
  ['copper_pick', 'Copper Pick', 'pick', 3, 160, 1],
  ['copper_shovel', 'Copper Shovel', 'shovel', 3, 160, 1],
  ['copper_hammer', 'Copper Hammer', 'hammer', 3, 160, 1],
  // tier 4, bronze
  ['bronze_knife', 'Bronze Knife', 'knife', 4, 260, 2],
  ['bronze_axe', 'Bronze Axe', 'axe', 4, 320, 3],
  ['bronze_pick', 'Bronze Pick', 'pick', 4, 320, 1],
  ['bronze_shovel', 'Bronze Shovel', 'shovel', 4, 320, 1],
  ['bronze_hammer', 'Bronze Hammer', 'hammer', 4, 320, 1],
  ['bronze_sword', 'Bronze Sword', 'sword', 4, 280, 3],
  // tier 5, iron
  ['iron_knife', 'Iron Knife', 'knife', 5, 500, 3],
  ['iron_axe', 'Iron Axe', 'axe', 5, 600, 3],
  ['iron_pick', 'Iron Pick', 'pick', 5, 600, 1],
  ['iron_shovel', 'Iron Shovel', 'shovel', 5, 600, 1],
  ['iron_hammer', 'Iron Hammer', 'hammer', 5, 600, 1],
  ['iron_sword', 'Iron Sword', 'sword', 5, 550, 4],
  // tier 6, steel
  ['steel_knife', 'Steel Knife', 'knife', 6, 1000, 3],
  ['steel_axe', 'Steel Axe', 'axe', 6, 1200, 4],
  ['steel_pick', 'Steel Pick', 'pick', 6, 1200, 1],
  ['steel_shovel', 'Steel Shovel', 'shovel', 6, 1200, 1],
  ['steel_hammer', 'Steel Hammer', 'hammer', 6, 1200, 1],
  ['steel_sword', 'Steel Sword', 'sword', 6, 1100, 5],
  // tier 0: kit that wears out but cuts nothing
  ['fire_drill', 'Fire Drill', 'firestarter', 0, 8, 1],
  ['crucible', 'Crucible', 'crucible', 0, 20, 1],
  ['casting_mold', 'Casting Mold', 'mold', 0, 12, 1],
];

/** @type {ReadonlyArray<[string, string, number]>} [key, display name, stack] */
const MATERIAL_ROWS = [
  ['rock', 'Rock', 64], ['flint', 'Flint', 32], ['obsidian_shard', 'Obsidian Shard', 32], ['stick', 'Stick', 64],
  ['plant_fibre', 'Plant Fibre', 64], ['cord', 'Cord', 32], ['birch_bark', 'Birch Bark', 32], ['clay_lump', 'Clay Lump', 32],
  ['coal', 'Coal', 32], ['charcoal', 'Charcoal', 32], ['malachite', 'Malachite', 32], ['cassiterite', 'Cassiterite', 32],
  ['hematite', 'Hematite', 32], ['gold_nugget', 'Gold Nugget', 32], ['rough_gem', 'Rough Gem', 16],
  ['copper_ingot', 'Copper Ingot', 32], ['tin_ingot', 'Tin Ingot', 32], ['bronze_ingot', 'Bronze Ingot', 32],
  ['iron_bloom', 'Iron Bloom', 16], ['wrought_iron', 'Wrought Iron Bar', 32], ['steel_bar', 'Steel Bar', 32],
  ['rawhide', 'Rawhide', 16], ['leather', 'Leather', 16], ['salt', 'Salt', 32], ['ice_chunk', 'Ice Chunk', 32],
  ['grave_rag', 'Grave Rag', 32], ['glass_shards', 'Glass Shards', 32],
  // must be singed on a skewer or peeled with a knife before eating
  ['unpeeled_cactus_fruit', 'Unpeeled Cactus Fruit', 16],
  ['greenware_pot', 'Greenware Pot', 8], ['green_brick', 'Green Brick', 32], ['fired_brick', 'Fired Brick', 32],
  ['greenware_crucible', 'Greenware Crucible', 4], ['greenware_mold', 'Greenware Mold', 4], ['bellows', 'Bellows', 1],
  ['clay_pot', 'Clay Pot', 8], ['salt_pot', 'Salt-crusted Pot', 1],
  // boiled in the embers, never drunk as it is
  ['pot_snow', 'Pot of Snow', 1],
  // v0.10 circuits (DESIGN-circuits §8.1): what black powder, the fuse, the torch, the lamp, the panel and the coherer are
  // made of. Pyrite comes from coal seams, saltpetre from deep cave walls; the kiln roasts pyrite for sulfur (and selenium).
  ['pyrite', 'Pyrite', 32], ['sulfur', 'Sulfur', 32], ['selenium', 'Selenium', 16], ['saltpetre', 'Saltpetre', 32],
  ['black_powder', 'Black Powder', 32], ['carbon_filament', 'Carbon Filament', 32], ['iron_filings', 'Iron Filings', 32],
  // v0.10 throwing (CONTRACTS §60): a dart flies far and hurts more than a rock; made by hand, four at a time
  ['flint_dart', 'Flint Dart', 16],
  // §14 the Survival Handbook: every survival state starts with it; never lost on death, never discarded, never made
  // (inventory.js KEEP_ON_DEATH, handbook.js ensureHandbook). R or RMB with it in hand opens the field book.
  ['handbook', 'Survival Handbook', 1],
];

/**
 * Food and drink (§4.5): [key, display name, stack, FoodDef]. `sick` is a chance 0..1; `spoilS` the mean seconds per item
 * (absent: never spoils); `returns` the item given back (the clay pot); `temp` an instant body-temperature change in °C.
 * @type {ReadonlyArray<[string, string, number, FoodDef]>}
 */
const FOOD_ROWS = [
  ['honeyberries', 'Honeyberries', 32, { satiation: 4, hydration: 2, sick: 0, useS: 0.8, spoilS: 1800 }],
  ['acorns', 'Acorns', 32, { satiation: 2, hydration: -2, sick: 0, useS: 1.0 }], // bitter raw (tannins)
  ['leached_acorns', 'Leached Acorns', 32, { satiation: 3, hydration: 0, sick: 0, useS: 1.0 }],
  ['roasted_acorns', 'Roasted Acorns', 32, { satiation: 5, hydration: 0, sick: 0, useS: 1.0 }],
  ['pine_nuts', 'Pine Nuts', 32, { satiation: 4, hydration: 0, sick: 0, useS: 1.0 }],
  ['wild_tuber', 'Wild Tuber', 16, { satiation: 4, hydration: 1, sick: 0.05, useS: 1.2 }],
  ['baked_tuber', 'Baked Tuber', 16, { satiation: 12, hydration: 0, sick: 0, useS: 1.2 }],
  ['cattail_root', 'Cattail Root', 16, { satiation: 3, hydration: 1, sick: 0, useS: 1.0 }],
  ['roasted_cattail_root', 'Roasted Cattail Root', 16, { satiation: 8, hydration: 0, sick: 0, useS: 1.0 }],
  ['cactus_fruit', 'Cactus Fruit', 16, { satiation: 3, hydration: 8, sick: 0, useS: 1.0 }], // desert water
  ['raw_pork', 'Raw Pork', 16, { satiation: 6, hydration: 0, sick: 0.3, useS: 1.4, spoilS: 1200 }],
  ['roast_pork', 'Roast Pork', 16, { satiation: 30, hydration: -2, sick: 0, useS: 1.6, spoilS: 2400 }],
  ['charred_meat', 'Charred Meat', 16, { satiation: 6, hydration: -4, sick: 0, useS: 1.4 }],
  ['salted_pork', 'Salted Pork', 16, { satiation: 18, hydration: -6, sick: 0, useS: 1.4 }], // keeps; no fire needed
  ['pig_fat', 'Pig Fat', 16, { satiation: 6, hydration: -2, sick: 0.1, useS: 1.2 }],
  // v0.11 (CONTRACTS §69): cattle and sheep
  ['raw_beef', 'Raw Beef', 16, { satiation: 7, hydration: 0, sick: 0.3, useS: 1.4, spoilS: 1200 }],
  ['roast_beef', 'Roast Beef', 16, { satiation: 36, hydration: -2, sick: 0, useS: 1.6, spoilS: 2400 }],
  ['raw_mutton', 'Raw Mutton', 16, { satiation: 5, hydration: 0, sick: 0.3, useS: 1.4, spoilS: 1200 }],
  ['roast_mutton', 'Roast Mutton', 16, { satiation: 26, hydration: -2, sick: 0, useS: 1.6, spoilS: 2400 }],
  ['snow', 'Snow', 32, { satiation: 0, hydration: 3, sick: 0, useS: 0.6, temp: -0.2 }],
  // v0.11 (CONTRACTS §66): unboiled water poisons you one time in five; boil it on a campfire (Pot of Boiled Water: safe)
  ['pot_water', 'Pot of Water', 1, { satiation: 0, hydration: 30, sick: 0.2, useS: 1.0, returns: 'clay_pot' }],
  ['pot_boiled', 'Pot of Boiled Water', 1, { satiation: 0, hydration: 30, sick: 0, useS: 1.0, returns: 'clay_pot' }],
  ['pot_seawater', 'Pot of Seawater', 1, { satiation: 0, hydration: -10, sick: 0, useS: 1.0, returns: 'clay_pot' }],
  ['pot_sap', 'Pot of Birch Sap', 1, { satiation: 2, hydration: 25, sick: 0, useS: 1.0, returns: 'clay_pot' }],
  // v0.11 (CONTRACTS §72): milked from a cow with an empty clay pot — food and drink in one, always safe
  ['pot_milk', 'Pot of Milk', 1, { satiation: 12, hydration: 20, sick: 0, useS: 1.0, returns: 'clay_pot' }],
];

/**
 * Bandages (§2.3): [key, display name, stack, heal]. `hp` is queued into the pending healing, paid out at `rate` HP/s.
 * @type {ReadonlyArray<[string, string, number, {hp: number, rate: number, useS: number}]>}
 */
const HEAL_ROWS = [
  ['fibre_bandage', 'Fibre Bandage', 8, { hp: 15, rate: 1.5, useS: 1.5 }],
  ['rag_bandage', 'Rag Bandage', 8, { hp: 25, rate: 2.5, useS: 1.5 }],
];

/**
 * Clothes (§3.2), all stack 1: [key, display name, WearDef]. `insulation` is I (°C felt); `sunShade` 0..1 shades the sun term.
 * @type {ReadonlyArray<[string, string, WearDef]>}
 */
const WEAR_ROWS = [
  ['straw_hat', 'Straw Hat', { slot: 'head', insulation: 0, sunShade: 0.5 }],
  ['leather_hood', 'Leather Hood', { slot: 'head', insulation: 2, sunShade: 0 }],
  ['grass_cape', 'Grass Cape', { slot: 'body', insulation: 2, sunShade: 0 }],
  ['leather_coat', 'Leather Coat', { slot: 'body', insulation: 6, sunShade: 0 }],
  ['hide_shoes', 'Grass-lined Shoes', { slot: 'feet', insulation: 2, sunShade: 0 }],
];

/** Ripe plant → the picked variant its block item places (§5.1). @type {Map<number, number>} */
const PLACES_AS = new Map([
  [BLOCK.HONEYBERRY_BUSH, BLOCK.HONEYBERRY_BUSH_BARE],
  [BLOCK.PRICKLY_PEAR, BLOCK.PRICKLY_PEAR_BARE],
]);
/** Picked variant → the ripe block whose item it belongs to. @type {Map<number, number>} */
const ITEM_BLOCK_OF = new Map([...PLACES_AS].map(([ripe, bare]) => [bare, ripe]));
/** v0.11 (CONTRACTS §69): states of a block that give its item back (a baited or sprung snare is still the Snare). */
const SAME_ITEM = new Map([[BLOCK.SNARE_BAITED, BLOCK.SNARE], [BLOCK.SNARE_SPRUNG, BLOCK.SNARE]]);

/** @returns {ItemDef[]} every item in ITEM_KEYS order, not yet frozen and without tags */
function buildDefs() {
  /** @type {ItemDef[]} */
  const defs = [];
  for (const [key, name, type, tier, durability, power] of TOOL_ROWS) {
    defs.push({ key, name, kind: 'tool', stack: 1, tool: { type, tier, durability, power } });
  }
  for (const [key, name, stack] of MATERIAL_ROWS) defs.push({ key, name, kind: 'material', stack });
  for (const [key, name, stack, food] of FOOD_ROWS) defs.push({ key, name, kind: 'food', stack, food: { ...food } });
  for (const [key, name, stack, heal] of HEAL_ROWS) defs.push({ key, name, kind: 'heal', stack, heal: { ...heal } });
  for (const [key, name, wear] of WEAR_ROWS) defs.push({ key, name, kind: 'wear', stack: 1, wear: { ...wear } });
  for (const id of PICKER_ORDER) {
    if (id === BLOCK.WATER) continue; // water is carried in a pot, never as a block
    const b = BLOCKS[id];
    defs.push({ key: b.name, name: b.displayName, kind: 'block', stack: BLOCK_ITEM_STACK, block: PLACES_AS.get(id) ?? id });
  }
  return defs;
}

/** @template T @param {T} o @returns {T} o and every nested plain object / array, frozen */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Item names are compared lower-case with runs of whitespace as '_' (`Pot of Water` → `pot_of_water`). */
function normalizeName(s) {
  return s.trim().toLowerCase().replace(/\s+/g, '_');
}

/** @type {Map<string, ItemDef>} key → def */
const BY_KEY = new Map();
/** @type {Map<number, string>} block id → item key (picked plants map to their ripe item) */
const KEY_OF_BLOCK = new Map();
/** @type {Map<string, string>} normalised display name → key */
const KEY_OF_NAME = new Map();

for (const def of buildDefs()) {
  if (BY_KEY.has(def.key)) throw new Error(`items: duplicate item key "${def.key}"`);
  const tags = Object.keys(TAGS).filter((tag) => TAGS[tag].includes(def.key));
  if (tags.length) def.tags = tags;
  BY_KEY.set(def.key, deepFreeze(def));
  const display = normalizeName(def.name);
  if (KEY_OF_NAME.has(display)) throw new Error(`items: "${def.key}" and "${KEY_OF_NAME.get(display)}" share the name ${def.name}`);
  KEY_OF_NAME.set(display, def.key);
  if (def.kind === 'block') KEY_OF_BLOCK.set(ITEM_BLOCK_OF.get(def.block) ?? def.block, def.key);
}
for (const [bare, ripe] of ITEM_BLOCK_OF) KEY_OF_BLOCK.set(bare, /** @type {string} */ (KEY_OF_BLOCK.get(ripe)));
for (const [state, base] of SAME_ITEM) KEY_OF_BLOCK.set(state, /** @type {string} */ (KEY_OF_BLOCK.get(base)));

/** Every item by key, in ITEM_KEYS order. @type {Readonly<Record<string, ItemDef>>} */
export const ITEMS = Object.freeze(Object.fromEntries(BY_KEY));
/** Display order: tools, materials, food, bandages, clothes, then the block items in PICKER_ORDER order. */
export const ITEM_KEYS = Object.freeze([...BY_KEY.keys()]);

/**
 * Old item keys still found in saves (DESIGN-circuits §8.3): `black_hole` is no longer placeable, so it is no longer an
 * item — a stack of it is the Collapsar Charge; `blast_barrel` is the Powder Keg's old name; v0.11 renamed the tools to
 * their everyday names (hammerstone → stone_hammer, stone_chopper → stone_axe, digging_stick → wooden_shovel, *_spade →
 * *_shovel; CONTRACTS §64). Saved pack, wear, basket and
 * remains stacks (storage.js, inventory.js, containers.js) and typed item names (resolveItem) read through it.
 */
export const ITEM_ALIASES = Object.freeze({
  black_hole: 'collapsar_charge', blast_barrel: 'powder_keg',
  // v0.11 normative tool names (CONTRACTS §64)
  hammerstone: 'stone_hammer', stone_chopper: 'stone_axe', digging_stick: 'wooden_shovel', flint_spade: 'flint_shovel',
  copper_spade: 'copper_shovel', bronze_spade: 'bronze_shovel', iron_spade: 'iron_shovel', steel_spade: 'steel_shovel',
});

/** @param {*} key @returns {*} the current key of a possibly old one (anything else unchanged) */
export function canonicalItemKey(key) {
  return typeof key === 'string' && Object.hasOwn(ITEM_ALIASES, key) ? ITEM_ALIASES[key] : key;
}

/** @param {string} key @returns {ItemDef|null} */
export function getItem(key) {
  return (typeof key === 'string' && BY_KEY.get(key)) || null;
}

/** @param {string} key @returns {boolean} */
export function isItemKey(key) {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** @param {string} key @returns {number} how many fit in one slot; 0 for unknown keys */
export function stackSize(key) {
  return getItem(key)?.stack ?? 0;
}

/** @param {string} key @returns {number} a new tool's durability; 0 = the item has none (it never wears) */
export function maxDurability(key) {
  return getItem(key)?.tool?.durability ?? 0;
}

/**
 * The item a block gives as itself (`self` drops, middle mouse): its block item; a picked plant gives its ripe plant's item.
 * @param {number} blockId @returns {string|null} null when the block has no item (AIR, water, bedrock, litter, …)
 */
export function itemForBlock(blockId) {
  return KEY_OF_BLOCK.get(blockId) ?? null;
}

/** @param {string} key @returns {number} the block id the item places (a bush item places its picked variant), or -1 */
export function blockForItem(key) {
  return getItem(key)?.block ?? -1;
}

/** @param {string} key @param {string} tag @returns {boolean} the key is one of the tag's members */
export function hasTag(key, tag) {
  return typeof tag === 'string' && Object.hasOwn(TAGS, tag) && TAGS[tag].includes(key);
}

/**
 * @param {string} key @param {number} [n]  a count: 1 picks the singular of a plural display name (SINGULAR_NAMES)
 * @returns {string} the display name; '?' for unknown keys
 */
export function itemName(key, n) {
  const def = getItem(key);
  if (!def) return '?';
  return n === 1 && Object.hasOwn(SINGULAR_NAMES, key) ? SINGULAR_NAMES[key] : def.name;
}

/**
 * Display names that are plural, and what ONE of them is called (`itemName(key, 1)`: "1 Honeyberry went bad.", not
 * "1 Honeyberries"). Stack labels and recipe rows keep the plural.
 * @type {Readonly<Record<string, string>>}
 */
export const SINGULAR_NAMES = Object.freeze({
  honeyberries: 'Honeyberry', acorns: 'Acorn', leached_acorns: 'Leached Acorn', roasted_acorns: 'Roasted Acorn',
  pine_nuts: 'Pine Nut', glass_shards: 'Glass Shard', iron_filings: 'Iron Filing',
});

/**
 * Resolve a typed item token (console `pack add`): an item key, or a display name with spaces written as '_'
 * (`pot_of_water`, `Wrought_Iron_Bar`). Case-insensitive; surrounding whitespace is ignored.
 * @param {string} token
 * @returns {{ key: string }|{ error: string }}
 */
export function resolveItem(token) {
  const raw = String(token ?? '').trim();
  const t = normalizeName(raw);
  if (t === '') return { error: 'expected an item name' };
  if (BY_KEY.has(t)) return { key: t };
  if (Object.hasOwn(ITEM_ALIASES, t)) return { key: ITEM_ALIASES[t] };
  const key = KEY_OF_NAME.get(t);
  if (key !== undefined) return { key };
  return { error: `unknown item "${raw}" (type items to list them)` };
}
