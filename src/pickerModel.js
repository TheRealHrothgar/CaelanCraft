// Caelancraft — the creative inventory's model: sections, families, search with aliases, the grid of rounded square slots
// and keyboard navigation. docs/DESIGN-circuits.md §5 (CONTRACTS §56 once merged). PURE: no DOM, no three, no time, no Math.random.
//
// The tables name blocks by their `name` string and resolve them through the BLOCKS list they are given, skipping names that
// are unknown or not placeable, so the model works with or without survival's blocks. Every placeable block no section names
// lands in a final "Other" section (hidden when empty): a new block can never vanish from the picker.
//
// The user named the design's "Linstock" a Torch (block `torch`); the search still finds it as "linstock" and "slow match".
//
// Every item too (the user: "there're no tools available in creative" — "every item"): after the block sections come the
// item sections (Tools, Weapons, Food, Materials, Clothes & Healing), named by item KEY and resolved through the ITEMS they are
// given. A PICK is a block id (a number, as before) or the key of an item that is not a block item (a string); block items
// stay block ids. Every such item no item section names lands in a final "Other Items" section (hidden when empty).
import { BLOCKS } from './blocks.js';
import { partTip } from './circuitParts.js';
import { ITEMS, ITEM_ALIASES, SINGULAR_NAMES, TIER_NAMES, getItem } from './items.js';
import { purposeOf } from './purpose.js';

/**
 * A slot is a plain 56 px rounded square (the user asked for no icons on hexagons); slots sit 6 px apart, so columns and
 * rows are both 62 px apart. Every row is full (`cols` slots) but the last of a run; nothing is indented.
 */
export const PICKER_SLOT_PX = 56;
export const PICKER_GAP_PX = 6;
export const PICKER_COL_W = PICKER_SLOT_PX + PICKER_GAP_PX;
export const PICKER_ROW_H = PICKER_SLOT_PX + PICKER_GAP_PX;
/** The Recent row holds this many picks (blocks and items). */
export const PICKER_RECENT_MAX = 9;

/**
 * @typedef {number|string} Pick  a block id, or the key of an item that is not a block item (items.js)
 * @typedef {{ type: 'block', id: number }} BlockEntry
 * @typedef {{ type: 'item', key: string }} ItemEntry
 * @typedef {{ type: 'family', key: string, name: string, unit: string, ids: Pick[], sectionId: string }} Family
 * @typedef {BlockEntry|ItemEntry|Family} Entry
 * @typedef {{ id: string, title: string, iconId: Pick, entries: Entry[] }} PickerSection
 * @typedef {{ kind: 'header', section: PickerSection }} HeaderRow
 * @typedef {{ kind: 'cells', cells: Entry[], drawerOf: string|null }} CellsRow
 * @typedef {HeaderRow|CellsRow} Row
 * @typedef {{ name: string, displayName: string, section: string, family: string|null, text: string }} PickInfo
 *   `name`: the block's name or the item's key
 * @typedef {{ sections: PickerSection[], families: Map<string, Family>, order: Pick[], info: Map<Pick, PickInfo> }} PickerModel
 * @typedef {{ key: string, name: string, kind: string, tool?: { type: string, tier: number, durability?: number } }} PickerItemDef
 *   what the model reads of an items.js ItemDef
 */

/** @returns {{ family: string, key: string, unit: string, members: string[] }} */
function fam(key, family, members, unit = 'kinds') {
  return Object.freeze({ family, key, unit, members: Object.freeze(members) });
}

/** @returns {{ id: string, title: string, icon: string, items: ReadonlyArray<string|ReturnType<typeof fam>> }} */
function sec(id, title, icon, items) {
  return Object.freeze({ id, title, icon, items: Object.freeze(items) });
}

/**
 * The sections in order (§5.2), by block name. A string is a single; an object is a family whose members open in a drawer.
 * The Circuits section lists the six parts of a first circuit before anything else.
 */
export const PICKER_SECTIONS = Object.freeze([
  sec('stone', 'Stone', 'stone', [
    fam('stone-cobble', 'Stone & Cobble', ['stone', 'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'mossy_stone_bricks']),
    fam('rock', 'Rock', ['granite', 'diorite', 'andesite', 'slate', 'sandstone']),
    'bricks', 'obsidian',
  ]),
  sec('earth', 'Earth', 'grass_block', [
    fam('soil', 'Soil', ['dirt', 'grass_block', 'snowy_grass', 'clay']),
    fam('sand-gravel', 'Sand & Gravel', ['sand', 'red_sand', 'gravel']),
    fam('snow-ice', 'Snow & Ice', ['snow_block', 'ice', 'packed_ice']),
    fam('wild-plants', 'Wild Plants', ['tussock', 'cattails', 'tuber_plant', 'honeyberry_bush', 'prickly_pear',
      // v0.14 (§76 flora)
      'onion_plant', 'carrot_plant', 'honeycap_mushroom', 'frecklecap_mushroom', 'hazel_thicket', 'crab_apple_bush', 'healwort_plant',
      // §81: the plants that are not food
      'fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'flax', 'aloe'], 'plants'),
    'hay_bale', 'pumpkin',
  ]),
  sec('wood', 'Wood', 'oak_log', [
    fam('logs', 'Logs', ['oak_log', 'spruce_log', 'birch_log'], 'woods'),
    fam('planks', 'Planks', ['oak_planks', 'spruce_planks', 'birch_planks'], 'woods'),
    fam('leaves', 'Leaves', ['oak_leaves', 'spruce_leaves', 'birch_leaves'], 'trees'),
    'bookshelf',
  ]),
  sec('ores', 'Ores & Metals', 'iron_ore', [
    fam('ores', 'Ores', ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'tin_ore'], 'ores'),
    fam('metal-blocks', 'Metal & Coal Blocks', ['coal_block', 'iron_block', 'gold_block', 'diamond_block', 'copper_block'], 'blocks'),
    'honeycomb_block',
  ]),
  sec('colour', 'Colour', 'wool_red', [
    fam('wool', 'Wool', ['wool_white', 'wool_light_gray', 'wool_gray', 'wool_black', 'wool_brown', 'wool_red', 'wool_orange',
      'wool_yellow', 'wool_lime', 'wool_green', 'wool_cyan', 'wool_light_blue', 'wool_blue', 'wool_purple', 'wool_magenta',
      'wool_pink'], 'colours'),
  ]),
  sec('glass', 'Glass & Light', 'glass', ['glass', 'glowstone']),
  sec('camp', 'Camp & Crafts', 'campfire', [
    'campfire',
    fam('workplaces', 'Workplaces', ['work_stump', 'kiln', 'bloomery', 'forge', 'workbench', 'lab'], 'workplaces'),
    'wicker_basket', 'sleeping_hide', 'snare',
    // §85: a place to stay — the two beds, the well, the rain barrel
    'grass_bed', 'bed', 'well', 'rain_barrel',
    // §101: the pennant shows the wind
    'pennant',
  ]),
  sec('powder', 'Black Powder', 'powder_keg', ['powder_keg', 'powder_fuse', 'torch']),
  sec('circuits', 'Circuits', 'voltaic_battery', [
    'voltaic_battery', 'copper_wire', 'knife_switch', 'push_button', 'igniter', 'filament_lamp',
    'blasting_machine', 'electric_bell', 'relay', 'clockwork_timer',
    fam('radio', 'Radio', ['spark_transmitter', 'coherer_receiver'], 'parts'),
    'selenium_panel',
    fam('wires', 'Insulated & Earth Wire', ['brown_wire', 'white_wire', 'earth_wire'], 'wires'),
    'terminal_board',
  ]),
  sec('exotic', 'Exotic', 'collapsar_charge', ['collapsar_charge', 'rune_block']),
  sec('liquids', 'Liquids', 'water', ['water']),
]);

/**
 * The item sections, after the block sections (and the blocks' "Other"), by item KEY: only items that are not block items
 * (a block item is its block, above). A string is a single; an object a family. Tool families run in tier order (stone or
 * flint, copper, bronze, iron, steel). Rail icons are item keys.
 */
export const PICKER_ITEM_SECTIONS = Object.freeze([
  sec('tools', 'Tools', 'iron_pick', [
    fam('picks', 'Picks', ['flint_pick', 'copper_pick', 'bronze_pick', 'iron_pick', 'steel_pick'], 'tools'),
    fam('axes', 'Axes', ['stone_axe', 'flint_axe', 'copper_axe', 'bronze_axe', 'iron_axe', 'steel_axe'], 'tools'),
    fam('shovels', 'Shovels', ['wooden_shovel', 'flint_shovel', 'copper_shovel', 'bronze_shovel', 'iron_shovel', 'steel_shovel'],
      'tools'),
    fam('hammers', 'Hammers', ['hammerstone', 'copper_hammer', 'bronze_hammer', 'iron_hammer', 'steel_hammer'], 'tools'),
    fam('knives', 'Knives', ['flint_knife', 'copper_knife', 'bronze_knife', 'iron_knife', 'steel_knife'], 'tools'),
    'fire_drill', 'crucible', 'casting_mold', 'compass', 'handbook', // §102: the Compass
  ]),
  // what hurts a creature: the swords and the spear, and what flies (looseItems.throwOf: darts, the spear, a thrown rock)
  sec('weapons', 'Weapons', 'iron_sword', [
    fam('swords', 'Swords', ['bronze_sword', 'iron_sword', 'steel_sword']),
    'flint_spear',
    fam('darts', 'Darts', ['flint_dart', 'fletched_dart']),
    'rock',
  ]),
  sec('food', 'Food', 'roast_pork', [
    fam('meat', 'Meat', ['raw_pork', 'roast_pork', 'salted_pork', 'charred_meat', 'pig_fat', 'raw_beef', 'roast_beef', 'raw_mutton',
      'roast_mutton', 'raw_venison', 'roast_venison', 'raw_rabbit', 'roast_rabbit', 'raw_fowl', 'roast_fowl', 'raw_bear',
      'roast_bear']),
    fam('fish-eggs', 'Fish & Eggs', ['raw_fish', 'roast_fish', 'raw_egg', 'roast_egg']),
    fam('fruit-nuts', 'Fruit & Nuts', ['honeyberries', 'nightshade_berries', 'crab_apple', 'baked_crab_apple', 'cactus_fruit',
      'unpeeled_cactus_fruit', 'acorns', 'leached_acorns', 'roasted_acorns', 'pine_nuts', 'hazelnuts', 'roasted_hazelnuts']),
    fam('roots', 'Roots & Tubers', ['wild_tuber', 'baked_tuber', 'cattail_root', 'roasted_cattail_root', 'wild_carrot',
      'roasted_carrot', 'hemlock_root', 'wild_onion', 'roasted_onion']),
    fam('mushrooms', 'Mushrooms', ['honeycap', 'roasted_honeycap', 'frecklecap', 'roasted_frecklecap']),
    // the empty Clay Pot first: it is the one that fills
    fam('pots', 'Pots', ['clay_pot', 'pot_water', 'pot_boiled', 'pot_spring', 'pot_tainted', 'pot_seawater', 'pot_sap', 'pot_milk',
      'pot_snow', 'salt_pot']),
    'snow',
  ]),
  sec('materials', 'Materials', 'copper_ingot', [
    fam('knapping', 'Flint & Obsidian', ['flint', 'obsidian_shard']),
    fam('wood-fibre', 'Wood & Fibre', ['stick', 'plant_fibre', 'cord', 'birch_bark']),
    fam('fuel', 'Fuel', ['coal', 'charcoal']),
    fam('minerals', 'Minerals', ['malachite', 'cassiterite', 'hematite', 'gold_nugget', 'rough_gem', 'pyrite']),
    fam('metals', 'Metals', ['copper_ingot', 'tin_ingot', 'bronze_ingot', 'iron_bloom', 'wrought_iron', 'steel_bar']),
    fam('hides', 'Hide & Rag', ['rawhide', 'leather', 'grave_rag']),
    'feather',
    fam('pottery', 'Clay & Pottery', ['clay_lump', 'greenware_pot', 'greenware_crucible', 'greenware_mold', 'green_brick',
      'fired_brick']),
    fam('powder-parts', 'Powder & Parts', ['sulfur', 'saltpetre', 'black_powder', 'selenium', 'carbon_filament', 'iron_filings']),
    fam('seeds', 'Seeds', ['carrot_seeds', 'onion_seeds', 'healwort_seeds']),
    'salt', 'ice_chunk', 'glass_shards', 'bellows',
  ]),
  sec('clothes', 'Clothes & Healing', 'straw_hat', [
    'straw_hat', 'leather_hood', 'grass_cape', 'leather_coat', 'hide_shoes',
    'fibre_bandage', 'rag_bandage', 'aloe_leaf', 'healwort', 'pot_healwort_tea',
  ]),
]);

/** The six parts of a first circuit: the Circuits section starts with these, in this order (§5.2). */
export const STARTER_PARTS = Object.freeze(['voltaic_battery', 'copper_wire', 'knife_switch', 'push_button', 'igniter',
  'filament_lamp']);

/**
 * Search aliases by block name (§5.2): the words a player might type for a block that its name does not contain. "torch",
 * "power source", "ignition switch" and "detonator" find the parts the user named.
 */
export const PICKER_ALIASES = Object.freeze({
  torch: Object.freeze(['linstock', 'slow match', 'match', 'pitch torch']),
  powder_keg: Object.freeze(['barrel', 'explosive', 'gunpowder', 'bomb', 'keg', 'blast barrel']),
  powder_fuse: Object.freeze(['safety fuse', 'fuse', 'cord']),
  collapsar_charge: Object.freeze(['black hole', 'singularity', 'vortex']),
  copper_wire: Object.freeze(['cable', 'conductor', 'wire']),
  brown_wire: Object.freeze(['insulated', 'cable', 'wire']),
  white_wire: Object.freeze(['insulated', 'cable', 'wire']),
  terminal_board: Object.freeze(['junction', 'junction box', 'splitter', 'joiner']),
  relay: Object.freeze(['repeater']),
  knife_switch: Object.freeze(['lever', 'toggle', 'ignition switch']),
  push_button: Object.freeze(['button', 'doorbell']),
  clockwork_timer: Object.freeze(['clock', 'delay', 'time switch']),
  spark_transmitter: Object.freeze(['radio', 'remote', 'wireless']),
  coherer_receiver: Object.freeze(['radio', 'remote', 'wireless']),
  blasting_machine: Object.freeze(['detonator', 'plunger', 'exploder', 'ignition']),
  igniter: Object.freeze(['electric match', 'detonator']),
  voltaic_battery: Object.freeze(['power', 'cell', 'power source', 'pile']),
  selenium_panel: Object.freeze(['selenium cell', 'solar', 'photocell', 'daylight']),
  filament_lamp: Object.freeze(['light', 'bulb']),
  pennant: Object.freeze(['flag', 'banner', 'wind', 'windsock', 'weather vane']), // §101
});

/**
 * Search aliases by item key: the words a player might type for an item that its name does not contain. Old names of an
 * item (items.ITEM_ALIASES: "stone chopper", "digging stick", "copper spade", …) and the singular of a plural name
 * (SINGULAR_NAMES: "honeyberry") are searched as well, without being listed here.
 */
export const PICKER_ITEM_ALIASES = Object.freeze({
  hammerstone: Object.freeze(['stone hammer', 'knapping']),
  fire_drill: Object.freeze(['fire starter', 'lighter', 'bow drill']),
  crucible: Object.freeze(['melting pot']),
  casting_mold: Object.freeze(['mould', 'cast']),
  handbook: Object.freeze(['book', 'guide', 'field book', 'manual']),
  compass: Object.freeze(['north', 'direction', 'navigation', 'needle']), // §102
  flint_spear: Object.freeze(['javelin', 'throw', 'hunting']),
  flint_dart: Object.freeze(['arrow', 'throw']),
  fletched_dart: Object.freeze(['arrow', 'throw', 'feathered']),
  rock: Object.freeze(['stone', 'pebble', 'throw']),
  coal: Object.freeze(['fuel']),
  charcoal: Object.freeze(['fuel']),
  copper_ingot: Object.freeze(['metal', 'bar']),
  tin_ingot: Object.freeze(['metal', 'bar']),
  bronze_ingot: Object.freeze(['metal', 'bar']),
  wrought_iron: Object.freeze(['metal', 'ingot']),
  steel_bar: Object.freeze(['metal', 'ingot']),
  malachite: Object.freeze(['copper ore']),
  cassiterite: Object.freeze(['tin ore']),
  hematite: Object.freeze(['iron ore']),
  rough_gem: Object.freeze(['diamond', 'gem']),
  black_powder: Object.freeze(['gunpowder']),
  saltpetre: Object.freeze(['saltpeter', 'nitre']),
  sulfur: Object.freeze(['sulphur', 'brimstone']),
  pot_water: Object.freeze(['drink']),
  pot_boiled: Object.freeze(['drink', 'clean water']),
  pot_spring: Object.freeze(['drink', 'clean water']),
  pot_tainted: Object.freeze(['drink']),
  pot_seawater: Object.freeze(['drink', 'sea water']),
  pot_milk: Object.freeze(['drink']),
  pot_sap: Object.freeze(['drink']),
  clay_pot: Object.freeze(['empty pot', 'bucket']),
  fibre_bandage: Object.freeze(['fiber', 'medicine']),
  rag_bandage: Object.freeze(['medicine']),
  aloe_leaf: Object.freeze(['medicine']),
  healwort: Object.freeze(['medicine', 'herb', 'cure']),
  pot_healwort_tea: Object.freeze(['medicine', 'drink', 'cure']),
  plant_fibre: Object.freeze(['fiber']),
  straw_hat: Object.freeze(['clothing', 'wear', 'sun hat']),
  leather_hood: Object.freeze(['clothing', 'wear', 'hat']),
  grass_cape: Object.freeze(['clothing', 'wear', 'cloak']),
  leather_coat: Object.freeze(['clothing', 'wear', 'jacket']),
  hide_shoes: Object.freeze(['clothing', 'wear', 'boots']),
});

/** Words for every tool of a type (`ToolDef.type`): "pickaxe" finds the picks. */
export const PICKER_TOOL_WORDS = Object.freeze({
  pick: Object.freeze(['pickaxe', 'mining']),
  axe: Object.freeze(['chopping', 'felling']),
  shovel: Object.freeze(['spade', 'digging']),
  hammer: Object.freeze(['mallet']),
  knife: Object.freeze(['blade', 'cutting']),
  sword: Object.freeze(['blade', 'weapon']),
  spear: Object.freeze(['weapon']),
});

/** The pseudo-section of the Recent row (never in the rail). */
export const RECENT_SECTION_ID = 'recent';
/** The section that collects placeable blocks no table names. */
export const OTHER_SECTION_ID = 'other';
/** The section that collects the items (not block items) no item section names: the last section. */
export const OTHER_ITEMS_SECTION_ID = 'other-items';

/**
 * A query as matched: lower case, `_` read as a space, runs of white space collapsed, trimmed.
 * @param {unknown} q
 */
export function normalizeQuery(q) {
  return String(q ?? '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {Pick} p @returns {BlockEntry|ItemEntry} the cell entry of a pick */
export function entryOf(p) {
  return typeof p === 'string' ? { type: 'item', key: p } : { type: 'block', id: p };
}

/**
 * @param {*} items  an ITEMS-like record (key → def) or a list of defs
 * @returns {PickerItemDef[]}
 */
function itemList(items) {
  if (Array.isArray(items)) return items;
  return items && typeof items === 'object' ? Object.values(items) : [];
}

/** @type {Map<string, string[]>} item key → its old keys (items.ITEM_ALIASES), searched as words */
const OLD_NAMES = new Map();
for (const [old, key] of Object.entries(ITEM_ALIASES)) {
  if (!OLD_NAMES.has(key)) OLD_NAMES.set(key, []);
  /** @type {string[]} */ (OLD_NAMES.get(key)).push(old);
}

/**
 * Build the picker's sections and families from a block list and an item list (§5.2). Block names are resolved through
 * `blocks`; unknown names, blocks that are not placeable and names already used are skipped. Item keys are resolved through
 * `items` the same way, taking only items whose kind is not 'block' (a block item is its block). A family with fewer than 2
 * resolved members becomes a single (or nothing). The block sections come first, then the blocks' "Other" (placeable blocks
 * no section names, in id order), then the item sections, then "Other Items" (items no item section names, in `items`
 * order); an empty section is left out.
 * @param {ReadonlyArray<{ id: number, name: string, displayName?: string, placeable?: boolean }>} [blocks=BLOCKS]
 * @param {Readonly<Record<string, PickerItemDef>>|ReadonlyArray<PickerItemDef>} [items=ITEMS]
 * @returns {PickerModel}
 */
export function buildPickerModel(blocks = BLOCKS, items = ITEMS) {
  /** @type {Map<string, { id: number, name: string, displayName: string }>} */
  const byName = new Map();
  /** @type {Map<number, { id: number, name: string, displayName: string }>} */
  const byId = new Map();
  for (const b of blocks || []) {
    if (!b || !b.placeable || typeof b.name !== 'string' || !Number.isInteger(b.id)) continue;
    if (byName.has(b.name) || byId.has(b.id)) continue;
    const rec = { id: b.id, name: b.name, displayName: b.displayName || b.name };
    byName.set(b.name, rec);
    byId.set(b.id, rec);
  }
  /** @type {Map<string, { key: string, displayName: string, toolType: string|null }>} */
  const byKey = new Map();
  for (const d of itemList(items)) {
    if (!d || typeof d.key !== 'string' || d.key === '' || d.kind === 'block' || byKey.has(d.key)) continue;
    byKey.set(d.key, { key: d.key, displayName: typeof d.name === 'string' && d.name ? d.name : d.key,
      toolType: d.tool && typeof d.tool.type === 'string' ? d.tool.type : null });
  }
  /** @type {Set<Pick>} block ids and item keys never collide (a number is never equal to a string) */
  const used = new Set();
  /** @param {string} name @returns {number|null} the id of a placeable, not yet used block called `name` */
  const takeBlock = (name) => {
    const b = byName.get(name);
    if (!b || used.has(b.id)) return null;
    used.add(b.id);
    return b.id;
  };
  /** @param {string} key @returns {string|null} `key`, when it is a known, not yet used item that is not a block item */
  const takeItem = (key) => {
    if (!byKey.has(key) || used.has(key)) return null;
    used.add(key);
    return key;
  };
  /** @type {PickerSection[]} */
  const sections = [];
  /** @type {Map<string, Family>} */
  const families = new Map();
  /** @type {PickerModel['info']} */
  const info = new Map();
  /** @type {Pick[]} */
  const order = [];

  /** @param {Pick} p @param {PickerSection} section @param {Family|null} family */
  const note = (p, section, family) => {
    /** @type {string} */
    let name;
    /** @type {string} */
    let displayName;
    /** @type {ReadonlyArray<string>} */
    let words;
    if (typeof p === 'string') {
      const it = /** @type {{ key: string, displayName: string, toolType: string|null }} */ (byKey.get(p));
      name = it.key;
      displayName = it.displayName;
      words = [
        ...(Object.hasOwn(SINGULAR_NAMES, p) ? [SINGULAR_NAMES[p]] : []),
        ...(OLD_NAMES.get(p) || []),
        ...(it.toolType && Object.hasOwn(PICKER_TOOL_WORDS, it.toolType) ? PICKER_TOOL_WORDS[it.toolType] : []),
        ...(Object.hasOwn(PICKER_ITEM_ALIASES, p) ? PICKER_ITEM_ALIASES[p] : []),
      ];
    } else {
      const b = /** @type {{ name: string, displayName: string }} */ (byId.get(p));
      name = b.name;
      displayName = b.displayName;
      words = PICKER_ALIASES[b.name] || [];
    }
    const text = [displayName, name.replace(/_/g, ' '), family ? family.name : '', section.title, ...words]
      .map((s) => normalizeQuery(s)).filter(Boolean).join('\n');
    info.set(p, { name, displayName, section: section.id, family: family ? family.key : null, text });
    order.push(p);
  };

  /**
   * @param {ReadonlyArray<ReturnType<typeof sec>>} table
   * @param {(name: string) => Pick|null} take
   * @param {(name: string) => Pick|null} iconOf  the table's icon name as a pick (null when unknown)
   */
  const addSections = (table, take, iconOf) => {
    for (const s of table) {
      /** @type {PickerSection} */
      const section = { id: s.id, title: s.title, iconId: -1, entries: [] };
      for (const item of s.items) {
        if (typeof item === 'string') {
          const p = take(item);
          if (p === null) continue;
          section.entries.push(entryOf(p));
          note(p, section, null);
          continue;
        }
        /** @type {Pick[]} */
        const ids = [];
        for (const m of item.members) {
          const p = take(m);
          if (p !== null) ids.push(p);
        }
        if (ids.length === 0) continue;
        if (ids.length === 1) {
          section.entries.push(entryOf(ids[0]));
          note(ids[0], section, null);
          continue;
        }
        /** @type {Family} */
        const family = { type: 'family', key: item.key, name: item.family, unit: item.unit, ids, sectionId: s.id };
        families.set(family.key, family);
        section.entries.push(family);
        for (const p of family.ids) note(p, section, family);
      }
      if (section.entries.length === 0) continue;
      const icon = iconOf(s.icon);
      section.iconId = icon !== null && used.has(icon) ? icon : firstId(section.entries[0]);
      sections.push(section);
    }
  };
  /** @param {string} id @param {string} title @param {Pick[]} rest  what no table named, in order */
  const addOther = (id, title, rest) => {
    /** @type {PickerSection} */
    const other = { id, title, iconId: -1, entries: [] };
    for (const p of rest) {
      used.add(p);
      other.entries.push(entryOf(p));
      note(p, other, null);
    }
    if (other.entries.length > 0) {
      other.iconId = firstId(other.entries[0]);
      sections.push(other);
    }
  };

  addSections(PICKER_SECTIONS, takeBlock, (name) => byName.get(name)?.id ?? null);
  addOther(OTHER_SECTION_ID, 'Other', [...byId.keys()].filter((id) => !used.has(id)).sort((a, b) => a - b));
  addSections(PICKER_ITEM_SECTIONS, takeItem, (key) => (byKey.has(key) ? key : null));
  addOther(OTHER_ITEMS_SECTION_ID, 'Other Items', [...byKey.keys()].filter((key) => !used.has(key)));
  return { sections, families, order, info };
}

/** @param {Entry} e @returns {Pick} */
function firstId(e) {
  if (e.type === 'block') return e.id;
  if (e.type === 'item') return e.key;
  return e.ids[0];
}

/**
 * The name line of a family tile (§5.2): `Wool · 16 colours — click to open` (`— click to close` while open).
 * @param {Family} family @param {boolean} [open=false]
 */
export function familyLine(family, open = false) {
  return `${family.name} · ${family.ids.length} ${family.unit} — click to ${open ? 'close' : 'open'}`;
}

/**
 * Every block and item matching `query` (§5.5): a case-insensitive substring of the display name, the name (an item's key)
 * with `_` read as a space, the family name, the section title or an alias — for an item also its old names, the singular
 * of its name and its tool type's words. Picks in section order, families flattened. An empty query matches nothing.
 * @param {PickerModel} model @param {string} query
 * @returns {Pick[]}
 */
export function searchBlocks(model, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  return model.order.filter((id) => {
    const i = model.info.get(id);
    return i !== undefined && i.text.includes(q);
  });
}

/**
 * Lay entries out as rows of `cols` square slots (the last row of a run may be shorter).
 * @param {Entry[]} entries @param {number} cols @param {string|null} drawerOf
 * @returns {CellsRow[]}
 */
function gridRows(entries, cols, drawerOf) {
  /** @type {CellsRow[]} */
  const rows = [];
  for (let i = 0; i < entries.length; i += cols) rows.push({ kind: 'cells', cells: entries.slice(i, i + cols), drawerOf });
  return rows;
}

/** @param {Entry[]} entries @returns {Entry[]} families replaced by their members, in place */
function flatten(entries) {
  /** @type {Entry[]} */
  const out = [];
  for (const e of entries) {
    if (e.type === 'family') for (const p of e.ids) out.push(entryOf(p));
    else out.push(e);
  }
  return out;
}

/**
 * The picker's rows (§5.3, §5.4). A non-empty query gives one flat grid of the matches (no headers). Otherwise the Recent
 * row (when it has picks) and then each section: a header row, then rows of `cols` slots. An open family's members never
 * flow inline: they appear only in drawer rows (`drawerOf` = its key), laid out with the same columns right after the row
 * holding the family's tile. Show all flattens every family into its section.
 * @param {PickerModel} model
 * @param {{ cols: number, openFamily?: string|null, showAll?: boolean, query?: string, recent?: Pick[] }} opts
 * @returns {Row[]}
 */
export function layoutPicker(model, opts) {
  const cols = Math.max(2, Math.floor(Number(opts && opts.cols) || 0));
  const showAll = Boolean(opts && opts.showAll);
  const open = !showAll && opts && opts.openFamily && model.families.has(opts.openFamily) ? opts.openFamily : null;
  const query = normalizeQuery(opts && opts.query);
  /** @type {Row[]} */
  const rows = [];
  if (query) {
    rows.push(...gridRows(searchBlocks(model, query).map(entryOf), cols, null));
    return rows;
  }
  const recent = (opts && Array.isArray(opts.recent) ? opts.recent : []).filter((id) => model.info.has(id));
  if (recent.length > 0) {
    /** @type {PickerSection} */
    const section = { id: RECENT_SECTION_ID, title: 'Recent', iconId: recent[0], entries: recent.map(entryOf) };
    rows.push({ kind: 'header', section });
    rows.push(...gridRows(section.entries, cols, null));
  }
  for (const section of model.sections) {
    rows.push({ kind: 'header', section });
    for (const row of gridRows(showAll ? flatten(section.entries) : section.entries, cols, null)) {
      rows.push(row);
      const family = open ? row.cells.find((e) => e.type === 'family' && e.key === open) : undefined;
      if (family && family.type === 'family') {
        rows.push(...gridRows(family.ids.map(entryOf), cols, family.key));
      }
    }
  }
  return rows;
}

/**
 * The number of slot columns that fit a grid `width` px wide: max(4, floor((width + 6) / 62)) — n slots of 56 px need
 * n · 62 − 6 px (§5.4).
 * @param {number} width
 */
export function pickerCols(width) {
  const w = Number(width);
  return Math.max(4, Math.floor(((Number.isFinite(w) ? w : 0) + PICKER_GAP_PX) / PICKER_COL_W));
}

/**
 * The next focused cell for a key (§5.7). `index` counts the cells of every `cells` row in reading order (headers skipped).
 * - ArrowLeft / ArrowRight: the previous / next cell in reading order, wrapping across rows (and stopping at the ends);
 * - ArrowUp / ArrowDown: the cell in the same column of the row above / below, or that row's last cell when it is shorter,
 *   staying put at the first / last row;
 * - PageUp / PageDown: `pageRows` rows up / down the same way; from the first / last row they go to the first / last cell;
 * - Home / End: the first / last cell.
 * Anything else returns `index`. With no cells it returns −1.
 * @param {Row[]} rows @param {number} index @param {string} key @param {number} [pageRows=1]
 * @returns {number}
 */
export function navigate(rows, index, key, pageRows = 1) {
  /** @type {CellsRow[]} */
  const cellRows = /** @type {CellsRow[]} */ (rows.filter((r) => r.kind === 'cells' && r.cells.length > 0));
  const starts = [];
  let total = 0;
  for (const r of cellRows) {
    starts.push(total);
    total += r.cells.length;
  }
  if (total === 0) return -1;
  const cur = Math.max(0, Math.min(total - 1, Math.floor(Number(index) || 0)));
  let ri = 0;
  while (ri + 1 < cellRows.length && starts[ri + 1] <= cur) ri++;
  const col = cur - starts[ri];
  /** @param {number} target */
  const toRow = (target) => starts[target] + Math.min(col, cellRows[target].cells.length - 1);
  const n = Math.max(1, Math.floor(Number(pageRows) || 1));
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, cur - 1);
    case 'ArrowRight':
      return Math.min(total - 1, cur + 1);
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    case 'ArrowUp':
      return ri > 0 ? toRow(ri - 1) : cur;
    case 'ArrowDown':
      return ri < cellRows.length - 1 ? toRow(ri + 1) : cur;
    case 'PageUp':
      return ri > 0 ? toRow(Math.max(0, ri - n)) : 0;
    case 'PageDown':
      return ri < cellRows.length - 1 ? toRow(Math.min(cellRows.length - 1, ri + n)) : total - 1;
    default:
      return cur;
  }
}

/**
 * The Recent list after picking `id` (a block id or an item key): `id` first, then the others without it, at most `max`
 * (§5.6). A new array.
 * @param {Pick[]} recent @param {Pick} id @param {number} [max=PICKER_RECENT_MAX]
 * @returns {Pick[]}
 */
export function pushRecent(recent, id, max = PICKER_RECENT_MAX) {
  const list = Array.isArray(recent) ? recent : [];
  return [id, ...list.filter((x) => x !== id)].slice(0, Math.max(0, max));
}

/**
 * The line under an item's name for the items purpose.js has no line for. No line tells what a look-alike does (§81: the
 * Frecklecap, the Hemlock Root and the Nightshade Berries are only ever shown by their numbers, like the food they imitate).
 */
export const PICKER_ITEM_LINES = Object.freeze({
  handbook: 'The field book of the wild: open it to read.',
  fletched_dart: 'A dart with feathers: it flies faster and hits harder.',
  rock: 'A stone to throw, or to make things with.',
  carrot_seeds: 'Plant it on grass or dirt.',
  onion_seeds: 'Plant it on grass or dirt.',
  healwort_seeds: 'Plant it on grass or dirt.',
  healwort: 'Bitter, but it ends a poisoning at once.',
  pot_healwort_tea: 'A safe drink that ends a poisoning. You keep the pot.',
});

/** @param {number} n @returns {string} "+4", "−6" */
function signed(n) {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * An item's line from its data: food and drink by what they give (never by their risk), bandages by what they heal, clothes
 * by where they are worn and what they do, a material as one.
 * @param {import('./types.js').ItemDef} def
 * @returns {string}
 */
function itemLine(def) {
  if (def.food) {
    const f = def.food;
    const parts = [];
    if (f.satiation) parts.push(`${signed(f.satiation)} Nourishment`);
    if (f.hydration) parts.push(`${signed(f.hydration)} Hydration`);
    const line = parts.length ? `${parts.join(', ')}.` : '';
    return f.returns === 'clay_pot' ? `${line} You keep the pot.`.trim() : line;
  }
  if (def.heal) return `Heals ${def.heal.hp} Health.`;
  if (def.wear) {
    const w = def.wear;
    const does = [w.insulation ? `+${w.insulation} °C warmth` : '', w.sunShade ? 'shade from the sun' : ''].filter(Boolean);
    return `Worn on the ${w.slot}${does.length ? `: ${does.join(', ')}` : ''}.`;
  }
  if (def.tool) {
    const tier = TIER_NAMES[def.tool.tier] || '';
    return `${tier ? `${tier[0].toUpperCase()}${tier.slice(1)} tier · ` : ''}${def.tool.durability} uses.`;
  }
  return def.kind === 'material' ? 'A material for Making.' : '';
}

/**
 * The picker's line under the name (§4.13). A block: the part's tip, or '' for a block that is not a circuit part. An item
 * key: its purpose (purpose.js), else PICKER_ITEM_LINES, else a line from its data; '' for an unknown key or a block item.
 * @param {Pick} pick
 * @returns {string}
 */
export function blurbFor(pick) {
  if (typeof pick !== 'string') return partTip(pick) || '';
  const def = getItem(pick);
  if (!def || def.kind === 'block') return '';
  return purposeOf(pick) || (Object.hasOwn(PICKER_ITEM_LINES, pick) ? PICKER_ITEM_LINES[pick] : '') || itemLine(def);
}
