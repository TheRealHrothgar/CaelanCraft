// Caelancraft — the creative inventory's model: sections, families, search with aliases, the grid of rounded square slots
// and keyboard navigation. docs/DESIGN-circuits.md §5 (CONTRACTS §56 once merged). PURE: no DOM, no three, no time, no Math.random.
//
// The tables name blocks by their `name` string and resolve them through the BLOCKS list they are given, skipping names that
// are unknown or not placeable, so the model works with or without survival's blocks. Every placeable block no section names
// lands in a final "Other" section (hidden when empty): a new block can never vanish from the picker.
//
// The user named the design's "Linstock" a Torch (block `torch`); the search still finds it as "linstock" and "slow match".
import { BLOCKS } from './blocks.js';
import { partTip } from './circuitParts.js';

/**
 * A slot is a plain 56 px rounded square (the user asked for no icons on hexagons); slots sit 6 px apart, so columns and
 * rows are both 62 px apart. Every row is full (`cols` slots) but the last of a run; nothing is indented.
 */
export const PICKER_SLOT_PX = 56;
export const PICKER_GAP_PX = 6;
export const PICKER_COL_W = PICKER_SLOT_PX + PICKER_GAP_PX;
export const PICKER_ROW_H = PICKER_SLOT_PX + PICKER_GAP_PX;
/** The Recent row holds this many blocks. */
export const PICKER_RECENT_MAX = 9;

/**
 * @typedef {{ type: 'block', id: number }} BlockEntry
 * @typedef {{ type: 'family', key: string, name: string, unit: string, ids: number[], sectionId: string }} Family
 * @typedef {BlockEntry|Family} Entry
 * @typedef {{ id: string, title: string, iconId: number, entries: Entry[] }} PickerSection
 * @typedef {{ kind: 'header', section: PickerSection }} HeaderRow
 * @typedef {{ kind: 'cells', cells: Entry[], drawerOf: string|null }} CellsRow
 * @typedef {HeaderRow|CellsRow} Row
 * @typedef {{ sections: PickerSection[], families: Map<string, Family>, order: number[],
 *   info: Map<number, { name: string, displayName: string, section: string, family: string|null, text: string }> }} PickerModel
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
      'onion_plant', 'carrot_plant', 'honeycap_mushroom', 'frecklecap_mushroom', 'hazel_thicket', 'crab_apple_bush', 'healwort_plant'], 'plants'),
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
    fam('workplaces', 'Workplaces', ['work_stump', 'kiln', 'bloomery', 'forge', 'workbench'], 'workplaces'),
    'wicker_basket', 'sleeping_hide', 'snare',
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
});

/** The pseudo-section of the Recent row (never in the rail). */
export const RECENT_SECTION_ID = 'recent';
/** The section that collects placeable blocks no table names. */
export const OTHER_SECTION_ID = 'other';

/**
 * A query as matched: lower case, `_` read as a space, runs of white space collapsed, trimmed.
 * @param {unknown} q
 */
export function normalizeQuery(q) {
  return String(q ?? '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the picker's sections and families from a block list (§5.2). Names are resolved through `blocks`; unknown names, blocks
 * that are not placeable and names already used are skipped. A family with fewer than 2 resolved members becomes a single (or
 * nothing). Placeable blocks no section names go to a final "Other" section, in id order; it is left out when empty.
 * @param {ReadonlyArray<{ id: number, name: string, displayName?: string, placeable?: boolean }>} [blocks=BLOCKS]
 * @returns {PickerModel}
 */
export function buildPickerModel(blocks = BLOCKS) {
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
  /** @type {Set<number>} */
  const used = new Set();
  /** @returns {number|null} the id of a placeable, not yet used block called `name` */
  const take = (name) => {
    const b = byName.get(name);
    if (!b || used.has(b.id)) return null;
    used.add(b.id);
    return b.id;
  };
  /** @type {PickerSection[]} */
  const sections = [];
  /** @type {Map<string, Family>} */
  const families = new Map();
  /** @type {PickerModel['info']} */
  const info = new Map();
  /** @type {number[]} */
  const order = [];

  const note = (id, section, family) => {
    const b = /** @type {{ name: string, displayName: string }} */ (byId.get(id));
    const aliases = PICKER_ALIASES[b.name] || [];
    const text = [b.displayName, b.name.replace(/_/g, ' '), family ? family.name : '', section.title, ...aliases]
      .map((s) => normalizeQuery(s)).filter(Boolean).join('\n');
    info.set(id, { name: b.name, displayName: b.displayName, section: section.id, family: family ? family.key : null, text });
    order.push(id);
  };

  for (const s of PICKER_SECTIONS) {
    /** @type {PickerSection} */
    const section = { id: s.id, title: s.title, iconId: -1, entries: [] };
    for (const item of s.items) {
      if (typeof item === 'string') {
        const id = take(item);
        if (id === null) continue;
        section.entries.push({ type: 'block', id });
        note(id, section, null);
        continue;
      }
      const ids = item.members.map(take).filter((id) => id !== null);
      if (ids.length === 0) continue;
      if (ids.length === 1) {
        section.entries.push({ type: 'block', id: /** @type {number} */ (ids[0]) });
        note(ids[0], section, null);
        continue;
      }
      /** @type {Family} */
      const family = { type: 'family', key: item.key, name: item.family, unit: item.unit, ids: /** @type {number[]} */ (ids),
        sectionId: s.id };
      families.set(family.key, family);
      section.entries.push(family);
      for (const id of family.ids) note(id, section, family);
    }
    if (section.entries.length === 0) continue;
    const icon = byName.get(s.icon);
    section.iconId = icon && used.has(icon.id) ? icon.id : firstId(section.entries[0]);
    sections.push(section);
  }
  /** @type {PickerSection} */
  const other = { id: OTHER_SECTION_ID, title: 'Other', iconId: -1, entries: [] };
  const rest = [...byName.values()].filter((b) => !used.has(b.id)).sort((a, b) => a.id - b.id);
  for (const b of rest) {
    used.add(b.id);
    other.entries.push({ type: 'block', id: b.id });
    note(b.id, other, null);
  }
  if (other.entries.length > 0) {
    other.iconId = firstId(other.entries[0]);
    sections.push(other);
  }
  return { sections, families, order, info };
}

/** @param {Entry} e @returns {number} */
function firstId(e) {
  return e.type === 'block' ? e.id : e.ids[0];
}

/**
 * The name line of a family tile (§5.2): `Wool · 16 colours — click to open` (`— click to close` while open).
 * @param {Family} family @param {boolean} [open=false]
 */
export function familyLine(family, open = false) {
  return `${family.name} · ${family.ids.length} ${family.unit} — click to ${open ? 'close' : 'open'}`;
}

/**
 * Every block matching `query` (§5.5): a case-insensitive substring of the display name, the name with `_` read as a space,
 * the family name, the section title or an alias. Block ids in section order, families flattened. An empty query matches
 * nothing.
 * @param {PickerModel} model @param {string} query
 * @returns {number[]}
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
    if (e.type === 'block') out.push(e);
    else for (const id of e.ids) out.push({ type: 'block', id });
  }
  return out;
}

/**
 * The picker's rows (§5.3, §5.4). A non-empty query gives one flat grid of the matches (no headers). Otherwise the Recent
 * row (when it has blocks) and then each section: a header row, then rows of `cols` slots. An open family's members never
 * flow inline: they appear only in drawer rows (`drawerOf` = its key), laid out with the same columns right after the row
 * holding the family's tile. Show all flattens every family into its section.
 * @param {PickerModel} model
 * @param {{ cols: number, openFamily?: string|null, showAll?: boolean, query?: string, recent?: number[] }} opts
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
    rows.push(...gridRows(searchBlocks(model, query).map((id) => ({ type: 'block', id })), cols, null));
    return rows;
  }
  const recent = (opts && Array.isArray(opts.recent) ? opts.recent : []).filter((id) => model.info.has(id));
  if (recent.length > 0) {
    /** @type {PickerSection} */
    const section = { id: RECENT_SECTION_ID, title: 'Recent', iconId: recent[0], entries: recent.map((id) => ({ type: 'block', id })) };
    rows.push({ kind: 'header', section });
    rows.push(...gridRows(section.entries, cols, null));
  }
  for (const section of model.sections) {
    rows.push({ kind: 'header', section });
    for (const row of gridRows(showAll ? flatten(section.entries) : section.entries, cols, null)) {
      rows.push(row);
      const family = open ? row.cells.find((e) => e.type === 'family' && e.key === open) : undefined;
      if (family && family.type === 'family') {
        rows.push(...gridRows(family.ids.map((id) => ({ type: 'block', id })), cols, family.key));
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
 * The Recent list after picking `id`: `id` first, then the others without it, at most `max` (§5.6). A new array.
 * @param {number[]} recent @param {number} id @param {number} [max=PICKER_RECENT_MAX]
 * @returns {number[]}
 */
export function pushRecent(recent, id, max = PICKER_RECENT_MAX) {
  const list = Array.isArray(recent) ? recent : [];
  return [id, ...list.filter((x) => x !== id)].slice(0, Math.max(0, max));
}

/** The picker's line under the name (§4.13): the part's tip, or '' for a block that is not a circuit part. @param {number} id */
export function blurbFor(id) {
  return partTip(id) || '';
}
