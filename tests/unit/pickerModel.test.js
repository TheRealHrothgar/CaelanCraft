// Unit tests for src/pickerModel.js, the creative inventory's pure model (DESIGN-circuits §5.2–§5.7, §5.10): sections and
// families resolved by name (with and without survival's blocks), search with aliases, the grid of rounded square slots
// with its drawer bands, keyboard navigation and the Recent list; and every item that is not a block item (tools, weapons,
// food, materials, clothes, bandages) in the item sections after the blocks, picked by its key.
import { describe, it, expect } from 'vitest';
import {
  buildPickerModel, searchBlocks, layoutPicker, navigate, pushRecent, blurbFor, familyLine, normalizeQuery, pickerCols, entryOf,
  PICKER_SECTIONS, PICKER_ITEM_SECTIONS, PICKER_ALIASES, PICKER_ITEM_ALIASES, PICKER_ITEM_LINES, PICKER_TOOL_WORDS, STARTER_PARTS,
  OTHER_SECTION_ID, OTHER_ITEMS_SECTION_ID, RECENT_SECTION_ID, PICKER_RECENT_MAX,
  PICKER_SLOT_PX, PICKER_GAP_PX, PICKER_COL_W, PICKER_ROW_H,
} from '../../src/pickerModel.js';
import { BLOCKS, BLOCK, PICKER_ORDER, isPlaceable } from '../../src/blocks.js';
import { partTip } from '../../src/circuitParts.js';
import { ITEMS, ITEM_KEYS, TIER_NAMES, getItem } from '../../src/items.js';
import { purposeOf, PURPOSE_MAX } from '../../src/purpose.js';

/** Survival's blocks (DESIGN-survival §8.1): ids 76–94. A BLOCKS list without them is what main looked like before W0. */
const SURVIVAL_NAMES = new Set(['copper_ore', 'tin_ore', 'honeyberry_bush', 'honeyberry_bush_bare', 'tussock', 'cattails',
  'tuber_plant', 'prickly_pear', 'prickly_pear_bare', 'work_stump', 'kiln', 'bloomery', 'forge', 'wicker_basket',
  'sleeping_hide', 'remains', 'loose_stones', 'fallen_branches', 'fire_pit', 'workbench', 'lab', 'snare', 'snare_baited', 'snare_sprung', // + v0.11's Workbench (a workplace)
  // v0.14 (§76 flora): the wild plants of generation 3
  'honeycap_mushroom', 'frecklecap_mushroom', 'onion_plant', 'carrot_plant', 'hazel_thicket', 'hazel_thicket_bare', 'crab_apple_bush',
  'crab_apple_bush_bare', 'healwort_plant', 'healwort_plant_bare',
  // §81: the plants that are not food
  'fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'nightshade_bush_bare', 'flax', 'aloe',
  // §85: a place to stay
  'spring', 'spring_drawn', 'well', 'well_drawn', 'rain_barrel', 'rain_barrel_1', 'rain_barrel_2', 'rain_barrel_3', 'grass_bed', 'bed']);
const NO_SURVIVAL = BLOCKS.filter((b) => !SURVIVAL_NAMES.has(b.name));

/** @param {ReturnType<typeof buildPickerModel>} model @returns {Array<number|string>} every pick across sections (families expanded) */
function allPicks(model) {
  const out = [];
  for (const s of model.sections) {
    for (const e of s.entries) out.push(...(e.type === 'block' ? [e.id] : e.type === 'item' ? [e.key] : e.ids));
  }
  return out;
}
/** @param {ReturnType<typeof buildPickerModel>} model @returns {number[]} every block id across sections (families expanded) */
const allIds = (model) => /** @type {number[]} */ (allPicks(model).filter((p) => typeof p === 'number'));
/** @param {ReturnType<typeof buildPickerModel>} model @returns {string[]} every item key across sections (families expanded) */
const allKeys = (model) => /** @type {string[]} */ (allPicks(model).filter((p) => typeof p === 'string'));
/** Every item that is not a block item, in ITEM_KEYS order. */
const NON_BLOCK_KEYS = ITEM_KEYS.filter((k) => ITEMS[k].kind !== 'block');
const byName = (name) => /** @type {*} */ (BLOCKS.find((b) => b.name === name)).id;
const names = (model, ids) => ids.map((id) => model.info.get(id).name);
const BLOCK_TITLES = ['Stone', 'Earth', 'Wood', 'Ores & Metals', 'Colour', 'Glass & Light', 'Camp & Crafts', 'Black Powder',
  'Circuits', 'Exotic', 'Liquids'];
const ITEM_TITLES = ['Tools', 'Weapons', 'Food', 'Materials', 'Clothes & Healing'];

describe('buildPickerModel: sections and families (§5.2)', () => {
  it('every placeable block appears exactly once across the sections (families and singles)', () => {
    const model = buildPickerModel();
    const ids = allIds(model);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual([...PICKER_ORDER].sort((a, b) => a - b));
    expect(ids.every((id) => isPlaceable(id))).toBe(true);
    expect(ids).not.toContain(BLOCK.BLACK_HOLE); // the vortex is not placeable: the picker gives the charge
    expect(model.order).toHaveLength(allPicks(model).length);
    expect(model.order.filter((p) => typeof p === 'number')).toHaveLength(ids.length);
  });

  it('… and with a BLOCKS list without survival\'s blocks: their names are skipped, nothing is lost', () => {
    const model = buildPickerModel(NO_SURVIVAL);
    const ids = allIds(model);
    expect(new Set(ids).size).toBe(ids.length);
    const placeable = NO_SURVIVAL.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect([...ids].sort((a, b) => a - b)).toEqual(placeable);
    // the Workplaces family and the Wild Plants family vanish, Ores loses two members, Camp & Crafts keeps the campfire
    expect(model.families.has('workplaces')).toBe(false);
    expect(model.families.has('wild-plants')).toBe(false);
    expect(model.families.get('ores')?.ids).toHaveLength(4);
    expect(model.sections.find((s) => s.id === 'camp')?.entries).toEqual([{ type: 'block', id: BLOCK.CAMPFIRE }]);
    expect(model.sections.some((s) => s.id === OTHER_SECTION_ID)).toBe(false);
  });

  it('the sections, in order, with the rail icons the table names', () => {
    const model = buildPickerModel();
    expect(model.sections.map((s) => s.title)).toEqual([...BLOCK_TITLES, ...ITEM_TITLES]);
    // block sections show a block (its id), item sections an item (its key)
    expect(model.sections.map((s) => s.iconId)).toEqual([...PICKER_SECTIONS.map((s) => byName(s.icon)),
      ...PICKER_ITEM_SECTIONS.map((s) => s.icon)]);
    expect(model.sections.find((s) => s.id === 'powder')?.entries.map((e) => e.type === 'block' && model.info.get(e.id).name))
      .toEqual(['powder_keg', 'powder_fuse', 'torch']);
    // the Wool family holds the 16 in today's light-to-dark order
    expect(names(model, /** @type {*} */ (model.families.get('wool')).ids)).toEqual(PICKER_ORDER
      .map((id) => BLOCKS[id].name).filter((n) => n.startsWith('wool_')));
  });

  it('unknown names are skipped; "Other" collects every placeable block no section names; a 1-member family is a single', () => {
    const fake = [
      ...NO_SURVIVAL.filter((b) => !['spruce_log', 'birch_log', 'diorite'].includes(b.name)),
      { id: 200, name: 'mystery_block', displayName: 'Mystery Block', placeable: true },
      { id: 201, name: 'not_placeable', displayName: 'Ghost', placeable: false },
    ];
    const model = buildPickerModel(fake);
    const other = /** @type {*} */ (model.sections.find((s) => s.id === OTHER_SECTION_ID));
    // the blocks' Other comes after the block sections and before the item sections
    expect(model.sections.indexOf(other)).toBe(model.sections.findIndex((s) => s.id === 'tools') - 1);
    expect(other.id).toBe(OTHER_SECTION_ID);
    expect(other.title).toBe('Other');
    expect(other.entries).toEqual([{ type: 'block', id: 200 }]);
    expect(other.iconId).toBe(200);
    expect(allIds(model)).not.toContain(201);
    // Logs lost two of three members: it is now a single oak log, where the family was
    expect(model.families.has('logs')).toBe(false);
    const wood = /** @type {*} */ (model.sections.find((s) => s.id === 'wood'));
    expect(wood.entries[0]).toEqual({ type: 'block', id: BLOCK.OAK_LOG });
    // Rock lost one member and stays a family of four
    expect(model.families.get('rock')?.ids).toHaveLength(4);
  });

  it('the Circuits section starts with the six starter parts, in order; Radio and the insulated wires are families', () => {
    const model = buildPickerModel();
    const circuits = /** @type {*} */ (model.sections.find((s) => s.id === 'circuits'));
    expect(circuits.entries.slice(0, 6).map((e) => model.info.get(e.id).name)).toEqual([...STARTER_PARTS]);
    expect(STARTER_PARTS).toEqual(['voltaic_battery', 'copper_wire', 'knife_switch', 'push_button', 'igniter', 'filament_lamp']);
    expect(names(model, /** @type {*} */ (model.families.get('radio')).ids)).toEqual(['spark_transmitter', 'coherer_receiver']);
    expect(names(model, /** @type {*} */ (model.families.get('wires')).ids)).toEqual(['brown_wire', 'white_wire', 'earth_wire']);
    expect(circuits.iconId).toBe(BLOCK.VOLTAIC_BATTERY);
  });

  it('a family tile\'s line: "Wool · 16 colours — click to open"', () => {
    const model = buildPickerModel();
    expect(familyLine(/** @type {*} */ (model.families.get('wool')))).toBe('Wool · 16 colours — click to open');
    expect(familyLine(/** @type {*} */ (model.families.get('wool')), true)).toBe('Wool · 16 colours — click to close');
    expect(familyLine(/** @type {*} */ (model.families.get('radio')))).toBe('Radio · 2 parts — click to open');
    for (const line of [...model.families.values()].map((f) => familyLine(f))) expect(line).not.toMatch(/[+−]/);
  });

  it('blurbFor: the part\'s tip under its name, nothing for an ordinary block', () => {
    expect(blurbFor(BLOCK.TORCH)).toBe(partTip(BLOCK.TORCH));
    expect(blurbFor(BLOCK.VOLTAIC_BATTERY)).toMatch(/^Volta's pile/);
    expect(blurbFor(BLOCK.STONE)).toBe('');
  });
});

describe('buildPickerModel: every item (tools, weapons, food, materials, clothes and healing)', () => {
  const model = buildPickerModel();
  const section = (id) => /** @type {*} */ (model.sections.find((s) => s.id === id));
  /** @param {string} id @returns {string[]} the keys of a section, families expanded */
  const keysOf = (id) => section(id).entries.flatMap((e) => (e.type === 'item' ? [e.key] : e.type === 'family' ? e.ids : []));

  it('every item that is not a block item appears exactly once, picked by its key; block items stay block ids', () => {
    const keys = allKeys(model);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...NON_BLOCK_KEYS].sort());
    expect(NON_BLOCK_KEYS.length).toBeGreaterThan(140);
    for (const k of keys) expect(getItem(k)?.kind, k).not.toBe('block');
    // a block item (the Torch, the Campfire) is its block: a number, never its key
    expect(model.info.has('torch')).toBe(false);
    expect(model.info.has(BLOCK.TORCH)).toBe(true);
    // the item sections follow the block sections; no item sits in a block section and no block in an item section
    const firstItem = model.sections.findIndex((s) => s.id === 'tools');
    model.sections.forEach((s, i) => {
      const picks = s.entries.flatMap((e) => (e.type === 'block' ? [e.id] : e.type === 'item' ? [e.key] : e.ids));
      for (const p of picks) expect(typeof p, `${s.id}: ${p}`).toBe(i < firstItem ? 'number' : 'string');
    });
    // nothing is left for "Other Items": the tables name every item
    expect(model.sections.some((s) => s.id === OTHER_ITEMS_SECTION_ID)).toBe(false);
  });

  it('the item tables name only real items that are not block items; family keys are unique across both tables', () => {
    const famKeys = [];
    for (const s of PICKER_ITEM_SECTIONS) {
      for (const it of s.items) {
        for (const k of typeof it === 'string' ? [it] : it.members) {
          expect(getItem(k), `${s.id}: ${k}`).not.toBeNull();
          expect(getItem(k)?.kind, k).not.toBe('block');
        }
        if (typeof it !== 'string') famKeys.push(it.key);
      }
      expect(getItem(s.icon), s.icon).not.toBeNull();
    }
    for (const s of PICKER_SECTIONS) for (const it of s.items) if (typeof it !== 'string') famKeys.push(it.key);
    expect(new Set(famKeys).size).toBe(famKeys.length);
    expect(new Set([...PICKER_SECTIONS, ...PICKER_ITEM_SECTIONS].map((s) => s.id)).size).toBe(16);
  });

  it('the item sections, their rail icons and their entries', () => {
    expect(PICKER_ITEM_SECTIONS.map((s) => [s.id, s.title, s.icon])).toEqual([
      ['tools', 'Tools', 'iron_pick'], ['weapons', 'Weapons', 'iron_sword'], ['food', 'Food', 'roast_pork'],
      ['materials', 'Materials', 'copper_ingot'], ['clothes', 'Clothes & Healing', 'straw_hat']]);
    const kinds = (id) => section(id).entries.map((e) => (e.type === 'family' ? `[${e.key}]` : e.key));
    expect(kinds('tools')).toEqual(['[picks]', '[axes]', '[shovels]', '[hammers]', '[knives]', 'fire_drill', 'crucible',
      'casting_mold', 'handbook']);
    expect(kinds('weapons')).toEqual(['[swords]', 'flint_spear', '[darts]', '[bows]', 'rock']); // §100: + Bows & Arrows
    expect(kinds('food')).toEqual(['[meat]', '[fish-eggs]', '[fruit-nuts]', '[roots]', '[mushrooms]', '[pots]', 'snow']);
    expect(kinds('clothes')).toEqual(['straw_hat', 'leather_hood', 'grass_cape', 'leather_coat', 'hide_shoes', 'fibre_bandage',
      'rag_bandage', 'aloe_leaf', 'healwort', 'pot_healwort_tea']);
    // at 14 columns (1280 × 720) every item section is one row of tiles
    for (const s of PICKER_ITEM_SECTIONS) expect(section(s.id).entries.length, s.id).toBeLessThanOrEqual(14);
    expect(familyLine(/** @type {*} */ (model.families.get('picks')))).toBe('Picks · 5 tools — click to open');
    expect(familyLine(/** @type {*} */ (model.families.get('meat')))).toBe('Meat · 17 kinds — click to open');
  });

  it('items keep their sections: tools by type in tier order, weapons, food, materials, clothes and healing', () => {
    const tools = NON_BLOCK_KEYS.filter((k) => ITEMS[k].kind === 'tool');
    for (const k of tools) {
      const type = /** @type {*} */ (ITEMS[k]).tool.type;
      expect(model.info.get(k)?.section, k).toBe(type === 'sword' || type === 'spear' || type === 'bow' ? 'weapons' : 'tools');
    }
    // each tool family holds every tool of its type, lowest tier first
    for (const [fam, type] of [['picks', 'pick'], ['axes', 'axe'], ['shovels', 'shovel'], ['hammers', 'hammer'], ['knives', 'knife'],
      ['swords', 'sword']]) {
      const want = tools.filter((k) => /** @type {*} */ (ITEMS[k]).tool.type === type)
        .sort((a, b) => /** @type {*} */ (ITEMS[a]).tool.tier - /** @type {*} */ (ITEMS[b]).tool.tier);
      expect(model.families.get(fam)?.ids, fam).toEqual(want);
    }
    expect(model.families.get('picks')?.ids.map((k) => TIER_NAMES[/** @type {*} */ (ITEMS[k]).tool.tier]))
      .toEqual(['flint', 'copper', 'bronze', 'iron', 'steel']);
    // clothes and bandages: Clothes & Healing; food: Food, but the two cures sit with the bandages
    for (const k of NON_BLOCK_KEYS.filter((x) => ITEMS[x].kind === 'wear' || ITEMS[x].kind === 'heal')) {
      expect(model.info.get(k)?.section, k).toBe('clothes');
    }
    const cures = ['healwort', 'pot_healwort_tea'];
    for (const k of NON_BLOCK_KEYS.filter((x) => ITEMS[x].kind === 'food')) {
      expect(model.info.get(k)?.section, k).toBe(cures.includes(k) ? 'clothes' : 'food');
    }
    // materials: Materials, except what is thrown, the field book and what belongs with the food (the pots, the cactus fruit)
    const elsewhere = { rock: 'weapons', flint_dart: 'weapons', fletched_dart: 'weapons', arrow: 'weapons', handbook: 'tools', clay_pot: 'food',
      salt_pot: 'food', pot_snow: 'food', unpeeled_cactus_fruit: 'food' };
    for (const k of NON_BLOCK_KEYS.filter((x) => ITEMS[x].kind === 'material')) {
      expect(model.info.get(k)?.section, k).toBe(elsewhere[k] ?? 'materials');
    }
    expect(keysOf('weapons')).toEqual(['bronze_sword', 'iron_sword', 'steel_sword', 'flint_spear', 'flint_dart', 'fletched_dart',
      'bow', 'arrow', 'rock']);
  });

  it('an item no table names goes to a last "Other Items" section; block items and junk in the list are skipped', () => {
    const fake = [
      ...Object.values(ITEMS).filter((d) => d.key !== 'iron_sword' && d.key !== 'steel_sword'),
      { key: 'mystery_widget', name: 'Mystery Widget', kind: 'material' },
      { key: 'stone', name: 'Stone', kind: 'block' }, // a block item: never an item pick
      null, { key: '', name: 'Nothing', kind: 'material' },
    ];
    const m = buildPickerModel(BLOCKS, /** @type {*} */ (fake));
    const last = m.sections[m.sections.length - 1];
    expect(last).toMatchObject({ id: OTHER_ITEMS_SECTION_ID, title: 'Other Items', iconId: 'mystery_widget',
      entries: [{ type: 'item', key: 'mystery_widget' }] });
    expect(m.info.has('stone')).toBe(false);
    // Swords lost two of three: the Bronze Sword is a single where the family was
    expect(m.families.has('swords')).toBe(false);
    expect(m.sections.find((s) => s.id === 'weapons')?.entries[0]).toEqual({ type: 'item', key: 'bronze_sword' });
    // the Weapons rail icon (the Iron Sword) is gone: the section's first entry stands in
    expect(m.sections.find((s) => s.id === 'weapons')?.iconId).toBe('bronze_sword');
    // no items at all: the block sections only, as before
    const blocksOnly = buildPickerModel(BLOCKS, []);
    expect(blocksOnly.sections.map((s) => s.title)).toEqual(BLOCK_TITLES);
    expect(blocksOnly.order.every((p) => typeof p === 'number')).toBe(true);
  });

  it('blurbFor an item: its purpose, else its own line, else a line from its data; every item has one that fits', () => {
    expect(blurbFor('iron_pick')).toBe(purposeOf('iron_pick'));
    expect(blurbFor('fire_drill')).toBe('Lights a campfire or a torch.');
    expect(blurbFor('handbook')).toBe(PICKER_ITEM_LINES.handbook);
    expect(blurbFor('honeyberries')).toBe('+4 Nourishment, +2 Hydration.');
    expect(blurbFor('salted_pork')).toBe('+18 Nourishment, −6 Hydration.');
    expect(blurbFor('pot_boiled')).toBe('+30 Hydration. You keep the pot.');
    expect(blurbFor('fibre_bandage')).toBe('Heals 15 Health.');
    expect(blurbFor('straw_hat')).toBe('Worn on the head: shade from the sun.');
    expect(blurbFor('leather_coat')).toBe('Worn on the body: +6 °C warmth.');
    expect(blurbFor('flint')).toBe('A material for Making.');
    for (const k of NON_BLOCK_KEYS) {
      const line = blurbFor(k);
      expect(line, k).not.toBe('');
      expect(line.length, k).toBeLessThanOrEqual(PURPOSE_MAX);
    }
    // §81: a look-alike reads like the food it imitates, never as poison
    expect(blurbFor('nightshade_berries')).toBe(blurbFor('honeyberries'));
    expect(blurbFor('hemlock_root')).toBe(blurbFor('wild_carrot'));
    for (const k of ['frecklecap', 'roasted_frecklecap', 'hemlock_root', 'nightshade_berries']) expect(blurbFor(k)).not.toMatch(/poison|sick|toxic/i);
    // unknown keys and block-item keys have none; a block keeps its tip
    expect(blurbFor('no_such_item')).toBe('');
    expect(blurbFor('torch')).toBe('');
    expect(blurbFor(BLOCK.TORCH)).toBe(partTip(BLOCK.TORCH));
  });
});

describe('searchBlocks (§5.5)', () => {
  const model = buildPickerModel();
  const find = (q) => names(model, searchBlocks(model, q));

  it('aliases: the words the user used find the parts', () => {
    expect(find('torch')).toEqual(['torch']);
    expect(find('linstock')).toEqual(['torch']);
    expect(find('slow match')).toEqual(['torch']);
    expect(find('black hole')).toEqual(['collapsar_charge']);
    expect(find('barrel')).toEqual(['rain_barrel', 'powder_keg']); // §85: the Rain Barrel by its name, then the keg by its alias
    expect(find('ignition switch')).toEqual(['knife_switch']);
    expect(find('power source')).toEqual(['voltaic_battery']);
    expect(find('repeater')).toEqual(['relay']);
    expect(find('splitter')).toEqual(['terminal_board']);
    // "detonator": the blasting machine and the igniter, in section order (the igniter is a starter part)
    expect(find('detonator').sort()).toEqual(['blasting_machine', 'igniter']);
    expect(find('detonator')).toEqual(['igniter', 'blasting_machine']);
    expect(find('radio')).toEqual(['spark_transmitter', 'coherer_receiver']);
  });

  it('case-insensitive; underscores read as spaces; extra white space ignored', () => {
    expect(find('TORCH')).toEqual(['torch']);
    expect(find('Powder_Keg')).toEqual(['powder_keg']);
    expect(find('  powder   keg ')).toEqual(['powder_keg']);
    expect(find('push button')).toEqual(['push_button']);
    expect(normalizeQuery('  Ignition_SWITCH ')).toBe('ignition switch');
  });

  it('display names, family names and section titles match too; families are flattened; nothing for an empty query', () => {
    expect(find('wool')).toHaveLength(16); // the family name (and each display name)
    expect(find('circuits')).toHaveLength(17); // the section title: its 17 parts
    expect(find('soil')).toEqual(['dirt', 'grass_block', 'snowy_grass', 'clay']);
    expect(find('red wool')).toEqual(['wool_red']);
    expect(find('')).toEqual([]);
    expect(find('   ')).toEqual([]);
    expect(find('no such block')).toEqual([]);
    // results come in section order
    const all = searchBlocks(model, 'o');
    expect(all).toEqual(model.order.filter((id) => all.includes(id)));
  });

  it('every alias in the table names a real block and finds it', () => {
    for (const [name, aliases] of Object.entries(PICKER_ALIASES)) {
      const id = byName(name);
      for (const a of aliases) expect(searchBlocks(model, a), `${name}: ${a}`).toContain(id);
    }
  });

  it('items by name, key, family, section and alias: "sword", "pick" and "pickaxe", food, "spade", "throw"', () => {
    expect(find('sword')).toEqual(['bronze_sword', 'iron_sword', 'steel_sword']);
    expect(searchBlocks(model, 'sword').every((p) => typeof p === 'string')).toBe(true); // item keys
    const picks = ['flint_pick', 'copper_pick', 'bronze_pick', 'iron_pick', 'steel_pick'];
    expect(find('pick')).toEqual(picks);
    expect(find('pickaxe')).toEqual(picks);
    expect(find('Iron Pick')).toEqual(['iron_pick']);
    expect(find('iron_pick')).toEqual(['iron_pick']);
    // "food" is the section: every item in it
    const food = /** @type {*} */ (model.sections.find((s) => s.id === 'food')).entries.flatMap((e) => (e.type === 'family' ? e.ids : [e.key]));
    expect(find('food')).toEqual(food);
    expect(find('food')).toContain('roast_pork');
    expect(find('roast pork')).toEqual(['roast_pork']);
    expect(find('roast')).toEqual(expect.arrayContaining(['roast_pork', 'roast_beef', 'roast_fish', 'roasted_acorns']));
    expect(find('meat')).toEqual(expect.arrayContaining(['raw_pork', 'roast_bear', 'charred_meat'])); // the family name
    // the singular of a plural name: "berry" finds the Honeyberries (and the bush block, by its own name)
    expect(find('berry')).toEqual(['honeyberry_bush', 'honeyberries', 'nightshade_berries']);
    // old names (items.ITEM_ALIASES) and the tool type's words
    expect(find('spade')).toEqual(['wooden_shovel', 'flint_shovel', 'copper_shovel', 'bronze_shovel', 'iron_shovel', 'steel_shovel']);
    expect(find('stone chopper')).toEqual(['stone_axe']);
    expect(find('digging stick')).toEqual(['wooden_shovel']);
    expect(find('throw')).toEqual(['flint_spear', 'flint_dart', 'fletched_dart', 'rock']);
    expect(find('weapon')).toEqual(['bronze_sword', 'iron_sword', 'steel_sword', 'flint_spear', 'flint_dart', 'fletched_dart', 'bow', 'arrow', 'rock']);
    expect(find('tools')).toHaveLength(31);
    expect(find('bandage')).toEqual(['fibre_bandage', 'rag_bandage']);
    expect(find('hat')).toEqual(['straw_hat', 'leather_hood']);
    // blocks and items together, blocks first (section order)
    const iron = searchBlocks(model, 'iron');
    expect(iron.filter((p) => typeof p === 'number').map((id) => model.info.get(id)?.name)).toEqual(['iron_ore', 'iron_block']);
    expect(iron.indexOf('iron_pick')).toBeGreaterThan(iron.indexOf(BLOCK.IRON_BLOCK));
  });

  it('§100 the bow: Bows & Arrows among the Weapons, the stave with the wood; "archery", "shoot", "arrow" and "bow" find them', () => {
    const fam = /** @type {*} */ (model.families.get('bows'));
    expect(fam.ids).toEqual(['bow', 'arrow']);
    expect(familyLine(fam)).toBe('Bows & Arrows · 2 kinds — click to open');
    expect(model.info.get('bow')).toMatchObject({ section: 'weapons', family: 'bows', displayName: 'Bow' });
    expect(model.info.get('bow_stave')).toMatchObject({ section: 'materials', family: 'wood-fibre' });
    expect(model.families.get('wood-fibre')?.ids).toEqual(['stick', 'bow_stave', 'plant_fibre', 'cord', 'birch_bark']);
    expect(find('archery')).toEqual(['bow', 'arrow', 'bow_stave']);
    expect(find('shoot')).toEqual(['bow', 'arrow']);
    expect(find('arrow')).toEqual(['bow', 'arrow']); // the family name; the darts are darts, not arrows
    expect(find('bow')).toEqual(expect.arrayContaining(['bow', 'arrow', 'bow_stave', 'fire_drill'])); // and the bow drill
    expect(find('longbow')).toEqual(['bow']);
    for (const k of ['bow', 'bow_stave', 'arrow']) expect(blurbFor(k), k).toBe(purposeOf(k));
  });

  it('every item alias and tool word finds its items', () => {
    for (const [key, aliases] of Object.entries(PICKER_ITEM_ALIASES)) {
      expect(getItem(key)?.kind, key).not.toBe('block');
      for (const a of aliases) expect(searchBlocks(model, a), `${key}: ${a}`).toContain(key);
    }
    for (const [type, words] of Object.entries(PICKER_TOOL_WORDS)) {
      const keys = NON_BLOCK_KEYS.filter((k) => /** @type {*} */ (ITEMS[k]).tool?.type === type);
      expect(keys.length, type).toBeGreaterThan(0);
      for (const w of words) expect(searchBlocks(model, w), `${type}: ${w}`).toEqual(expect.arrayContaining(keys));
    }
  });
});

describe('layoutPicker: the grid of square slots (§5.3, §5.4)', () => {
  const model = buildPickerModel();
  const cellRows = (rows) => rows.filter((r) => r.kind === 'cells');

  it('slots are 56 px squares 6 px apart: columns and rows are both 62 px apart', () => {
    expect([PICKER_SLOT_PX, PICKER_GAP_PX, PICKER_COL_W, PICKER_ROW_H]).toEqual([56, 6, 62, 62]);
  });

  it('headers come first in each section; every row holds `cols` slots but the last of a section; nothing is indented', () => {
    const rows = layoutPicker(model, { cols: 5, showAll: true });
    expect(rows[0].kind).toBe('header');
    let seen = 0;
    let inSection = -1;
    for (const r of rows) {
      if (r.kind === 'header') {
        inSection = 0;
        seen++;
        continue;
      }
      expect(inSection).toBeGreaterThanOrEqual(0);
      expect(r.cells.length).toBeGreaterThan(0);
      expect(r.cells.length).toBeLessThanOrEqual(5);
      expect(r).not.toHaveProperty('indent');
      inSection++;
    }
    expect(seen).toBe(model.sections.length);
    // in a section with more than one row, every row but the last is full
    const circuitsAt = rows.findIndex((r) => r.kind === 'header' && r.section.id === 'circuits');
    const circuitRows = [];
    for (let i = circuitsAt + 1; i < rows.length && rows[i].kind === 'cells'; i++) circuitRows.push(rows[i]);
    expect(circuitRows.map((r) => r.cells.length)).toEqual([5, 5, 5, 2]); // 17 parts flattened
    // collapsed at 14 columns (1280 px wide) the Circuits section is one row: 14 entries, Radio and the wires as tiles
    const wide = layoutPicker(model, { cols: 14 });
    const at = wide.findIndex((r) => r.kind === 'header' && r.section.id === 'circuits');
    expect(wide[at + 1].kind === 'cells' && wide[at + 1].cells.length).toBe(14);
    expect(wide[at + 2].kind).toBe('header');
  });

  it('with show-all every family is flattened into its section, members in place', () => {
    const rows = layoutPicker(model, { cols: 15, showAll: true, openFamily: 'wool' });
    const entries = cellRows(rows).flatMap((r) => r.cells);
    expect(entries.every((e) => e.type === 'block' || e.type === 'item')).toBe(true);
    expect(entries.filter((e) => e.type === 'block')).toHaveLength(PICKER_ORDER.length);
    expect(entries.filter((e) => e.type === 'item')).toHaveLength(NON_BLOCK_KEYS.length);
    expect(cellRows(rows).every((r) => r.drawerOf === null)).toBe(true); // no drawer while flattened
  });

  it('collapsed: families are tiles; an open family\'s members appear only in its drawer rows, right after its row', () => {
    const closed = layoutPicker(model, { cols: 6 });
    const tiles = cellRows(closed).flatMap((r) => r.cells);
    expect(tiles.filter((e) => e.type === 'family')).toHaveLength(model.families.size);
    expect(tiles.some((e) => e.type === 'block' && e.id === BLOCK.WOOL_RED)).toBe(false); // members never flow inline

    for (const key of ['wool', 'radio', 'logs', 'wires']) {
      const rows = layoutPicker(model, { cols: 6, openFamily: key });
      const family = /** @type {*} */ (model.families.get(key));
      const tileRow = rows.findIndex((r) => r.kind === 'cells' && r.cells.some((e) => e.type === 'family' && e.key === key));
      expect(tileRow).toBeGreaterThan(0);
      const drawer = [];
      for (let i = tileRow + 1; i < rows.length && rows[i].kind === 'cells' && rows[i].drawerOf === key; i++) drawer.push(rows[i]);
      expect(drawer.length).toBeGreaterThan(0);
      expect(drawer.flatMap((r) => r.cells).map((e) => e.type === 'block' && e.id)).toEqual(family.ids);
      // the drawer is laid out with the same columns: full rows, the last one may be shorter
      drawer.forEach((r, i) => {
        if (i < drawer.length - 1) expect(r.cells.length).toBe(6);
        else expect(r.cells.length).toBeLessThanOrEqual(6);
      });
      // nowhere else
      const elsewhere = rows.filter((r) => r.kind === 'cells' && r.drawerOf !== key).flatMap((r) => r.cells);
      for (const id of family.ids) expect(elsewhere.some((e) => e.type === 'block' && e.id === id), `${key}: ${id}`).toBe(false);
      expect(rows.filter((r) => r.kind === 'cells' && r.drawerOf !== null && r.drawerOf !== key)).toHaveLength(0);
    }
    // an unknown family opens nothing
    expect(layoutPicker(model, { cols: 6, openFamily: 'nope' })).toEqual(closed);
  });

  it('a section\'s rows continue after the drawer: the drawer never shifts the rows of its section', () => {
    // with 4 columns Circuits has rows [4, 4, 4, 2]: Radio (11th entry) sits in the third row
    const closed = cellRows(layoutPicker(model, { cols: 4 }));
    const open = cellRows(layoutPicker(model, { cols: 4, openFamily: 'radio' }));
    expect(open.filter((r) => r.drawerOf === null)).toEqual(closed);
    const at = open.findIndex((r) => r.cells.some((e) => e.type === 'family' && e.key === 'radio'));
    expect(open[at + 1].drawerOf).toBe('radio');
    expect(open[at + 2].drawerOf).toBe(null);
  });

  it('a query replaces the sections with one flat grid of the matches (no headers, families flattened)', () => {
    const rows = layoutPicker(model, { cols: 4, query: 'wool', openFamily: 'wool', recent: [BLOCK.STONE] });
    expect(rows.every((r) => r.kind === 'cells')).toBe(true);
    expect(rows.flatMap((r) => /** @type {*} */ (r).cells).map((e) => e.id)).toEqual(searchBlocks(model, 'wool'));
    expect(rows.map((r) => /** @type {*} */ (r).cells.length)).toEqual([4, 4, 4, 4]);
    expect(layoutPicker(model, { cols: 5, query: 'circuits' }).map((r) => /** @type {*} */ (r).cells.length)).toEqual([5, 5, 5, 2]);
    expect(layoutPicker(model, { cols: 4, query: 'zzz' })).toEqual([]);
  });

  it('the Recent row sits above the first section, and is left out when empty', () => {
    const rows = layoutPicker(model, { cols: 6, recent: [BLOCK.TORCH, BLOCK.STONE, 250] });
    expect(rows[0]).toMatchObject({ kind: 'header', section: { id: RECENT_SECTION_ID, title: 'Recent' } });
    expect(rows[1]).toMatchObject({ kind: 'cells', cells: [{ type: 'block', id: BLOCK.TORCH }, { type: 'block', id: BLOCK.STONE }] });
    expect(rows[2]).toMatchObject({ kind: 'header', section: { id: 'stone' } });
    expect(layoutPicker(model, { cols: 6, recent: [] })[0]).toMatchObject({ kind: 'header', section: { id: 'stone' } });
  });

  it('items: item entries in the sections, the drawers, a search and the Recent row', () => {
    const rows = layoutPicker(model, { cols: 14, openFamily: 'picks', recent: ['iron_sword', BLOCK.STONE, 'no_such_item', 12.5] });
    expect(rows[1]).toMatchObject({ kind: 'cells', cells: [{ type: 'item', key: 'iron_sword' }, { type: 'block', id: BLOCK.STONE }] });
    expect(/** @type {*} */ (rows[0]).section.iconId).toBe('iron_sword');
    const at = rows.findIndex((r) => r.kind === 'header' && r.section.id === 'tools');
    expect(rows[at + 1].kind === 'cells' && rows[at + 1].cells[0]).toMatchObject({ type: 'family', key: 'picks' });
    expect(rows[at + 2]).toMatchObject({ kind: 'cells', drawerOf: 'picks' });
    expect(/** @type {*} */ (rows[at + 2]).cells.map((e) => e.key)).toEqual(model.families.get('picks')?.ids);
    expect(/** @type {*} */ (rows[at + 1]).cells.find((e) => e.type === 'item')).toEqual({ type: 'item', key: 'fire_drill' });
    const found = layoutPicker(model, { cols: 4, query: 'sword' });
    expect(found).toEqual([{ kind: 'cells', drawerOf: null, cells: ['bronze_sword', 'iron_sword', 'steel_sword'].map(entryOf) }]);
    expect(entryOf('iron_sword')).toEqual({ type: 'item', key: 'iron_sword' });
    expect(entryOf(BLOCK.STONE)).toEqual({ type: 'block', id: BLOCK.STONE });
  });

  it('pickerCols: max(4, floor((width + 6) / 62)) — n slots need n · 62 − 6 px', () => {
    expect(pickerCols(878)).toBe(14); // the grid at 1280 x 720
    expect(pickerCols(62 * 10 - 6)).toBe(10);
    expect(pickerCols(62 * 10 - 7)).toBe(9);
    expect(pickerCols(100)).toBe(4);
    expect(pickerCols(0)).toBe(4);
    expect(pickerCols(NaN)).toBe(4);
  });
});

describe('navigate (§5.7)', () => {
  // a hand-made layout: header, rows of 4 / 3 (a section's short last row) / 4, a header, a row of 2
  const b = (id) => ({ type: 'block', id });
  /** @type {any[]} */
  const rows = [
    { kind: 'header', section: { id: 'a' } },
    { kind: 'cells', cells: [b(0), b(1), b(2), b(3)], drawerOf: null },
    { kind: 'cells', cells: [b(4), b(5), b(6)], drawerOf: null },
    { kind: 'cells', cells: [b(7), b(8), b(9), b(10)], drawerOf: null },
    { kind: 'header', section: { id: 'b' } },
    { kind: 'cells', cells: [b(11), b(12)], drawerOf: null },
  ];

  it('← / → walk the reading order and wrap across rows (and headers), stopping at the ends', () => {
    expect(navigate(rows, 0, 'ArrowRight')).toBe(1);
    expect(navigate(rows, 3, 'ArrowRight')).toBe(4); // end of row 1 → start of the indented row
    expect(navigate(rows, 4, 'ArrowLeft')).toBe(3);
    expect(navigate(rows, 10, 'ArrowRight')).toBe(11); // across the header
    expect(navigate(rows, 0, 'ArrowLeft')).toBe(0);
    expect(navigate(rows, 12, 'ArrowRight')).toBe(12);
  });

  it('↑ / ↓ go to the same column of the row above / below, or to its last cell when that row is shorter', () => {
    expect(navigate(rows, 0, 'ArrowDown')).toBe(4);
    expect(navigate(rows, 1, 'ArrowDown')).toBe(5);
    expect(navigate(rows, 3, 'ArrowDown')).toBe(6); // column 3 → the short row's last cell
    expect(navigate(rows, 5, 'ArrowUp')).toBe(1);
    expect(navigate(rows, 6, 'ArrowUp')).toBe(2);
    expect(navigate(rows, 5, 'ArrowDown')).toBe(8);
    expect(navigate(rows, 6, 'ArrowDown')).toBe(9);
    // straight down and up again comes back, column for column
    for (let i = 0; i < 11; i++) {
      const down = navigate(rows, i, 'ArrowDown');
      if (i <= 2 || (i >= 4 && i <= 6)) expect(navigate(rows, down, 'ArrowUp'), String(i)).toBe(i);
    }
    expect(navigate(rows, 9, 'ArrowDown')).toBe(12); // across the header: column 2 → the short row's last cell
    expect(navigate(rows, 10, 'ArrowDown')).toBe(12);
    expect(navigate(rows, 11, 'ArrowUp')).toBe(7);
    expect(navigate(rows, 0, 'ArrowUp')).toBe(0); // the first row stays
    expect(navigate(rows, 12, 'ArrowDown')).toBe(12); // the last row stays
  });

  it('Home / End; PageUp / PageDown by n rows, and to the first / last cell from the edge rows', () => {
    expect(navigate(rows, 6, 'Home')).toBe(0);
    expect(navigate(rows, 2, 'End')).toBe(12);
    expect(navigate(rows, 1, 'PageDown', 2)).toBe(8);
    expect(navigate(rows, 1, 'PageDown', 9)).toBe(12); // clamped to the last row, same column
    expect(navigate(rows, 12, 'PageUp', 2)).toBe(5);
    expect(navigate(rows, 12, 'PageUp', 3)).toBe(1);
    expect(navigate(rows, 2, 'PageUp', 3)).toBe(0); // from the first row: the first cell
    expect(navigate(rows, 11, 'PageDown', 3)).toBe(12); // from the last row: the last cell
  });

  it('other keys keep the index; no cells gives −1', () => {
    expect(navigate(rows, 5, 'KeyQ')).toBe(5);
    expect(navigate(rows, 99, 'KeyQ')).toBe(12);
    expect(navigate([{ kind: 'header', section: {} }], 0, 'ArrowDown')).toBe(-1);
  });

  it('works on a real layout with a drawer: ↓ from a family tile enters its drawer', () => {
    const model = buildPickerModel();
    const real = layoutPicker(model, { cols: 6, openFamily: 'wool' });
    const flat = real.filter((r) => r.kind === 'cells').flatMap((r) => /** @type {*} */ (r).cells);
    const tile = flat.findIndex((e) => e.type === 'family' && e.key === 'wool');
    const below = navigate(real, tile, 'ArrowDown');
    expect(flat[below]).toEqual({ type: 'block', id: BLOCK.WOOL_WHITE });
  });
});

describe('pushRecent (§5.6)', () => {
  it('newest first, distinct, at most 9; a new array', () => {
    const a = [3, 2, 1];
    const b = pushRecent(a, 2);
    expect(b).toEqual([2, 3, 1]);
    expect(a).toEqual([3, 2, 1]);
    let r = [];
    for (let id = 1; id <= 12; id++) r = pushRecent(r, id);
    expect(r).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(PICKER_RECENT_MAX).toBe(9);
    expect(pushRecent(r, 5)).toEqual([5, 12, 11, 10, 9, 8, 7, 6, 4]);
    expect(pushRecent(/** @type {*} */ (null), 7)).toEqual([7]);
    expect(pushRecent([1, 2], 3, 2)).toEqual([3, 1]);
  });

  it('blocks and items mixed: an item key is distinct by ===, so the block 12 and the key "12" are two picks', () => {
    let r = pushRecent([], BLOCK.STONE);
    r = pushRecent(r, 'iron_pick');
    r = pushRecent(r, 'roast_pork');
    expect(r).toEqual(['roast_pork', 'iron_pick', BLOCK.STONE]);
    expect(pushRecent(r, 'iron_pick')).toEqual(['iron_pick', 'roast_pork', BLOCK.STONE]);
    expect(pushRecent(r, BLOCK.STONE)).toEqual([BLOCK.STONE, 'roast_pork', 'iron_pick']);
    expect(pushRecent([12], '12')).toEqual(['12', 12]);
  });
});
