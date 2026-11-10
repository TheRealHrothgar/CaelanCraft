// Unit tests for the creative inventory's DOM (src/pickerUI.js through src/menus.js; DESIGN-circuits §5.3–§5.9), on a fake
// DOM built from index.html: the public picker API is unchanged (showPicker, hidePicker, isPickerOpen, onPickBlock(id, slot)
// and onPickerClose), plain rounded square slots (no icons on hexagons), families open in a drawer band below their row,
// the search, the keyboard, drag-to-hotbar, the slot badges, Show all, the rail and the Recent row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMenus } from '../../src/menus.js';
import { BLOCK, DEFAULT_HOTBAR, getBlockDef } from '../../src/blocks.js';
import { partTip } from '../../src/circuitParts.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const atlas = /** @type {any} */ ({ width: 256, height: 256 });

/** @param {Record<string, Function>} [callbacks] @param {number} [width] the scroll region's clientWidth (sets the columns) */
function setup(callbacks = {}, width = 0) {
  const doc = documentFromHTML(html);
  const onPickBlock = vi.fn();
  const onPickerClose = vi.fn();
  const menus = createMenus(/** @type {any} */ (doc), atlas, /** @type {any} */ ({ onPickBlock, onPickerClose, ...callbacks }));
  const $ = (id) => /** @type {any} */ (doc.getElementById(id));
  if (width) $('picker-scroll').clientWidth = width;
  const grid = $('picker-grid');
  const cell = (id) => grid.querySelector(`.picker-cell[data-block-id="${id}"]`);
  const tile = (key) => grid.querySelector(`.picker-cell[data-family="${key}"]`);
  /** a keydown on `target` (bubbles to the document listener) */
  const key = (target, k, extra = {}) => fire(target, 'keydown', { key: k, code: extra.code ?? '', ...extra });
  return { doc, menus, $, grid, cell, tile, key, onPickBlock, onPickerClose };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the picker keeps its public API (§5.6)', () => {
  it('showPicker / hidePicker / isPickerOpen toggle #block-picker', () => {
    const { menus, $ } = setup();
    expect(menus.isPickerOpen()).toBe(false);
    expect($('block-picker').classList.contains('hidden')).toBe(true);
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect(menus.isPickerOpen()).toBe(true);
    expect($('block-picker').classList.contains('hidden')).toBe(false);
    menus.hidePicker();
    expect(menus.isPickerOpen()).toBe(false);
    expect($('block-picker').classList.contains('hidden')).toBe(true);
  });

  it('a click on a block: onPickBlock(id, null); 1–9 on the hovered block: onPickBlock(id, slot), and it stays open', () => {
    const { menus, cell, doc, onPickBlock } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(cell(BLOCK.BRICKS), 'click');
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.BRICKS, null);
    fire(cell(BLOCK.OBSIDIAN), 'mouseover');
    doc.dispatch({ type: 'keydown', key: '3', code: 'Digit3' });
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.OBSIDIAN, 2);
    expect(menus.isPickerOpen()).toBe(true);
    // no hovered block: a digit does nothing
    fire(cell(BLOCK.OBSIDIAN), 'mouseout', { relatedTarget: doc.body });
    doc.dispatch({ type: 'keydown', key: '4', code: 'Digit4' });
    expect(onPickBlock).toHaveBeenCalledTimes(2);
  });

  it('E and Esc fire onPickerClose (Esc first clears a search)', () => {
    const { menus, doc, $, onPickerClose } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    doc.dispatch({ type: 'keydown', key: 'e', code: 'KeyE' });
    expect(onPickerClose).toHaveBeenCalledTimes(1);
    doc.dispatch({ type: 'keydown', key: 'Escape', code: 'Escape' });
    expect(onPickerClose).toHaveBeenCalledTimes(2);
    $('picker-search').value = 'torch';
    fire($('picker-search'), 'input');
    doc.dispatch({ type: 'keydown', key: 'Escape', code: 'Escape' });
    expect(onPickerClose).toHaveBeenCalledTimes(2);
    expect($('picker-search').value).toBe('');
    // once hidden, the keys are not listened to any more
    menus.hidePicker();
    doc.dispatch({ type: 'keydown', key: 'e', code: 'KeyE' });
    expect(onPickerClose).toHaveBeenCalledTimes(3 - 1);
  });
});

describe('the slots, the rail and the name line (§5.4, §5.8)', () => {
  it('sections with sticky headers, rows of slots; the rail has a button per section', () => {
    const { menus, grid, $ } = setup({}, 900);
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const sections = grid.querySelectorAll('.picker-section');
    expect(sections.map((s) => s.dataset.section)).toEqual(['stone', 'earth', 'wood', 'ores', 'colour', 'glass', 'camp',
      'powder', 'circuits', 'exotic', 'liquids']);
    for (const s of sections) {
      const head = s.children[0];
      expect(head.classList.contains('picker-section-head')).toBe(true);
      // the section's icon on a small rounded square chip, then the title
      expect(head.children.map((c) => c.className)).toEqual(['picker-section-icon', 'picker-section-title']);
      expect(head.children[0].tagName).toBe('CANVAS');
    }
    expect($('picker-rail').querySelectorAll('.picker-rail-btn')).toHaveLength(11);
    // 900 px wide: (900 − 16 + 6) / 62 → 14 columns; every section fits one row of slots, none is indented
    const rows = grid.querySelectorAll('.picker-row');
    expect(Math.max(...rows.map((r) => r.children.length))).toBe(14);
    expect(rows.every((r) => r.className === 'picker-row')).toBe(true);
    expect(grid.querySelectorAll('.picker-slots')).toHaveLength(11);
    expect(grid.querySelectorAll('.picker-slots').every((s) => s.children.length === 1)).toBe(true);
    // one roving tab stop among the cells
    expect(grid.querySelectorAll('.picker-cell[tabindex="0"]')).toHaveLength(1);
  });

  it('a slot is a plain button holding the 64 px icon canvas and a (hidden) round badge; a family slot has its count and ▸', () => {
    const { menus, cell, tile } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const c = cell(BLOCK.BRICKS);
    expect(c.tagName).toBe('BUTTON');
    expect(c.children.map((x) => x.className)).toEqual(['picker-icon', 'picker-badge']);
    expect([c.children[0].width, c.children[0].height]).toEqual([64, 64]);
    const f = tile('wool');
    expect(f.classList.contains('picker-family')).toBe(true);
    expect(f.children.map((x) => x.className)).toEqual(['picker-icon', 'picker-count', 'picker-chevron']);
    expect(f.querySelector('.picker-count').textContent).toBe('16');
    expect(f.querySelector('.picker-chevron').textContent).toBe('▸');
  });

  it('hovering a block shows its name and its tip; a family shows its line', () => {
    const { menus, cell, tile, $ } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(cell(BLOCK.VOLTAIC_BATTERY), 'mouseover');
    expect($('picker-name').textContent).toBe('Voltaic Battery');
    expect($('picker-blurb').textContent).toBe(partTip(BLOCK.VOLTAIC_BATTERY));
    fire(cell(BLOCK.BRICKS), 'mouseover');
    expect($('picker-name').textContent).toBe('Bricks');
    expect($('picker-blurb').textContent).toBe('');
    fire(tile('wool'), 'mouseover');
    expect($('picker-name').textContent).toBe('Wool · 16 colours — click to open');
  });

  it('the rail scrolls a section to the top and marks it .current', () => {
    const { menus, grid, $ } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const scroll = $('picker-scroll');
    const circuits = grid.querySelector('.picker-section[data-section="circuits"]');
    circuits.offsetTop = 1234;
    scroll.scrollTo = vi.fn();
    const btn = $('picker-rail').querySelector('.picker-rail-btn[data-section="circuits"]');
    fire(btn, 'click');
    expect(scroll.scrollTo).toHaveBeenCalledWith({ top: 1234, behavior: 'smooth' });
    expect(btn.classList.contains('current')).toBe(true);
    // scrolling updates .current from the section offsets
    grid.querySelectorAll('.picker-section').forEach((s, i) => { s.offsetTop = i * 100; });
    scroll.scrollTop = 250;
    fire(scroll, 'scroll');
    expect($('picker-rail').querySelector('.current').dataset.section).toBe('wood');
  });
});

describe('families open in a drawer band below their row (§5.3)', () => {
  it('a click opens the drawer right after the tile\'s row; the members appear only there; the tile shows ▾ and .open', () => {
    const { menus, grid, tile, cell } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect(cell(BLOCK.WOOL_RED)).toBeNull(); // members never flow inline
    fire(tile('wool'), 'click');
    const drawers = grid.querySelectorAll('.picker-drawer');
    expect(drawers).toHaveLength(1);
    const drawer = drawers[0];
    expect(drawer.dataset.family).toBe('wool');
    expect(drawer.querySelectorAll('.picker-cell')).toHaveLength(16);
    expect(grid.querySelectorAll(`.picker-cell[data-block-id="${BLOCK.WOOL_RED}"]`)).toHaveLength(1);
    expect(drawer.contains(cell(BLOCK.WOOL_RED))).toBe(true);
    // the band comes right after the block of slots holding the tile's row, its notch at the tile's column
    const slots = tile('wool').parentNode.parentNode;
    expect(slots.classList.contains('picker-slots')).toBe(true);
    expect(slots.parentNode.children.indexOf(drawer)).toBe(slots.parentNode.children.indexOf(slots) + 1);
    expect(drawer.dataset.tileCol).toBe('0');
    expect(tile('wool').classList.contains('open')).toBe(true);
    expect(tile('wool').getAttribute('aria-expanded')).toBe('true');
    expect(tile('wool').querySelector('.picker-chevron').textContent).toBe('▾');
    // drawer cells pick like any block
    fire(cell(BLOCK.WOOL_RED), 'click');
  });

  it('the notch points at the tile\'s column: Radio is the 11th entry of Circuits (column 10 at 14 columns, 2 at 4)', () => {
    const wide = setup({}, 900);
    wide.menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(wide.tile('radio'), 'click');
    expect(wide.grid.querySelector('.picker-drawer').dataset.tileCol).toBe('10');
    const narrow = setup({}, 300);
    narrow.menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(narrow.tile('radio'), 'click');
    expect(narrow.grid.querySelector('.picker-drawer').dataset.tileCol).toBe('2');
  });

  it('one drawer at a time; clicking the tile again closes it', () => {
    const { menus, grid, tile } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(tile('wool'), 'click');
    fire(tile('logs'), 'click');
    expect(grid.querySelectorAll('.picker-drawer').map((d) => d.dataset.family)).toEqual(['logs']);
    expect(tile('wool').classList.contains('open')).toBe(false);
    expect(tile('wool').querySelector('.picker-chevron').textContent).toBe('▸');
    fire(tile('logs'), 'click');
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(0);
  });

  it('the open family is remembered for the session (across hide / show)', () => {
    const { menus, grid, tile } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(tile('radio'), 'click');
    menus.hidePicker();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect(grid.querySelectorAll('.picker-drawer').map((d) => d.dataset.family)).toEqual(['radio']);
  });

  it('keyboard: → on a tile opens it and enters the drawer; ← on the first member or Backspace closes it, focus back on the tile', () => {
    const { menus, grid, tile, doc, key } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    tile('wool').focus();
    key(tile('wool'), 'ArrowRight');
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(1);
    expect(doc.activeElement.dataset.blockId).toBe(String(BLOCK.WOOL_WHITE));
    key(doc.activeElement, 'ArrowRight');
    expect(doc.activeElement.dataset.blockId).toBe(String(BLOCK.WOOL_LIGHT_GRAY));
    key(doc.activeElement, 'Backspace');
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(0);
    expect(doc.activeElement).toBe(tile('wool'));
    key(tile('wool'), 'Enter');
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(1);
    expect(doc.activeElement).toBe(tile('wool'));
    key(tile('wool'), 'ArrowRight'); // already open: into the drawer
    key(doc.activeElement, 'ArrowLeft'); // the first member: closes
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(0);
    expect(doc.activeElement).toBe(tile('wool'));
    key(tile('wool'), ' ');
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(1);
  });

  it('Show all flattens every family into its section, members in place (no tiles, no drawer), remembered', () => {
    const { menus, grid, $, cell } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    $('picker-showall').checked = true;
    fire($('picker-showall'), 'change');
    expect(grid.querySelectorAll('.picker-family')).toHaveLength(0);
    expect(grid.querySelectorAll('.picker-drawer')).toHaveLength(0);
    expect(cell(BLOCK.WOOL_RED)).not.toBeNull();
    expect(grid.querySelectorAll('.picker-cell')).toHaveLength(99);
    menus.hidePicker();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect($('picker-showall').checked).toBe(true);
    expect(grid.querySelectorAll('.picker-family')).toHaveLength(0);
  });
});

describe('search (§5.5)', () => {
  it('typing filters: one flat grid of matches; "No blocks match" when nothing does', () => {
    const { menus, grid, $ } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const search = $('picker-search');
    search.value = 'torch';
    fire(search, 'input');
    expect(grid.querySelectorAll('.picker-section')).toHaveLength(0);
    expect(grid.querySelectorAll('.picker-cell').map((c) => Number(c.dataset.blockId))).toEqual([BLOCK.TORCH]);
    expect(grid.querySelector('.picker-results').textContent).toBe('1 block');
    search.value = 'detonator';
    fire(search, 'input');
    expect(grid.querySelectorAll('.picker-cell').map((c) => Number(c.dataset.blockId))).toEqual([BLOCK.IGNITER, BLOCK.BLASTING_MACHINE]);
    search.value = 'xyzzy';
    fire(search, 'input');
    expect(grid.querySelectorAll('.picker-cell')).toHaveLength(0);
    expect(grid.querySelector('.picker-results').textContent).toBe('No blocks match "xyzzy"');
  });

  it('in the field, E and digits type (no close, no pick); Enter picks the first match; ↓ goes to the first result', () => {
    const { menus, $, key, onPickBlock, onPickerClose, doc } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const search = $('picker-search');
    search.focus();
    search.value = 'power source';
    fire(search, 'input');
    key(search, 'e', { code: 'KeyE' });
    key(search, '3', { code: 'Digit3' });
    expect(onPickerClose).not.toHaveBeenCalled();
    expect(onPickBlock).not.toHaveBeenCalled();
    key(search, 'ArrowDown');
    expect(doc.activeElement.dataset.blockId).toBe(String(BLOCK.VOLTAIC_BATTERY));
    search.focus();
    key(search, 'Enter');
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.VOLTAIC_BATTERY, null);
    // Esc with text clears; Esc when empty closes
    key(search, 'Escape');
    expect(search.value).toBe('');
    expect(onPickerClose).not.toHaveBeenCalled();
    key(search, 'Escape');
    expect(onPickerClose).toHaveBeenCalledTimes(1);
  });

  it('/ focuses the search; a new opening starts with an empty search', () => {
    const { menus, $, doc } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    doc.dispatch({ type: 'keydown', key: '/', code: 'Slash' });
    expect(doc.activeElement).toBe($('picker-search'));
    $('picker-search').value = 'wool';
    fire($('picker-search'), 'input');
    menus.hidePicker();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect($('picker-search').value).toBe('');
    expect($('picker-grid').querySelectorAll('.picker-section').length).toBeGreaterThan(0);
  });
});

describe('keyboard in the grid (§5.7)', () => {
  it('arrows move the roving focus (column by column), Enter picks, digits put the focused block in a slot', () => {
    const { menus, grid, doc, key, cell, onPickBlock } = setup({}, 900);
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    // with focus on the page, an arrow focuses the roving cell (the first)
    doc.dispatch({ type: 'keydown', key: 'ArrowDown', target: doc.body });
    const first = grid.querySelector('.picker-cell');
    expect(doc.activeElement === first).toBe(true);
    // → walks the reading order (from a block: the family tiles open instead)
    cell(BLOCK.BRICKS).focus();
    key(cell(BLOCK.BRICKS), 'ArrowRight');
    expect(doc.activeElement === cell(BLOCK.OBSIDIAN)).toBe(true);
    expect(grid.querySelectorAll('.picker-cell[tabindex="0"]').length).toBe(1);
    expect(cell(BLOCK.OBSIDIAN).getAttribute('tabindex')).toBe('0');
    key(doc.activeElement, 'End');
    expect(doc.activeElement.dataset.blockId).toBe(String(BLOCK.WATER));
    key(doc.activeElement, 'ArrowUp'); // the Exotic row: the charge sits right above water
    expect(doc.activeElement.dataset.blockId).toBe(String(BLOCK.COLLAPSAR_CHARGE));
    key(doc.activeElement, '5', { code: 'Digit5' });
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.COLLAPSAR_CHARGE, 4);
    key(doc.activeElement, 'Home');
    expect(doc.activeElement === first).toBe(true);
    // Enter on a block puts it in the selected slot (main closes the picker)
    cell(BLOCK.OBSIDIAN).focus();
    key(cell(BLOCK.OBSIDIAN), 'Enter');
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.OBSIDIAN, null);
    // ↓ from a section's row to the next section's row
    cell(BLOCK.BRICKS).focus();
    key(cell(BLOCK.BRICKS), 'ArrowDown');
    expect(doc.activeElement.closest('.picker-section').dataset.section).toBe('earth');
  });
});

describe('the hotbar: badges, drag and drop (§5.6)', () => {
  it('blocks in the hotbar show their slot number; the selected slot\'s block has the honey ring', () => {
    const { menus, cell } = setup();
    const bar = [BLOCK.BRICKS, BLOCK.OBSIDIAN, 0, 0, 0, 0, 0, 0, BLOCK.TORCH];
    menus.showPicker(bar, 8);
    expect(cell(BLOCK.BRICKS).dataset.slot).toBe('0');
    expect(cell(BLOCK.BRICKS).classList.contains('in-hotbar')).toBe(true);
    expect(cell(BLOCK.BRICKS).querySelector('.picker-badge').textContent).toBe('1');
    expect(cell(BLOCK.TORCH).querySelector('.picker-badge').textContent).toBe('9');
    expect(cell(BLOCK.TORCH).classList.contains('selected')).toBe(true);
    expect(cell(BLOCK.BRICKS).classList.contains('selected')).toBe(false);
    expect(cell(BLOCK.WATER).classList.contains('in-hotbar')).toBe(false);
    expect(cell(BLOCK.WATER).querySelector('.picker-badge').textContent).toBe('');
    expect(cell(BLOCK.BRICKS).title).toBe(`${getBlockDef(BLOCK.BRICKS).displayName} — slot 1`);
    // showPicker while open (a hotbar click) refreshes the badges only
    menus.showPicker(bar, 0);
    expect(cell(BLOCK.BRICKS).classList.contains('selected')).toBe(true);
    expect(cell(BLOCK.TORCH).classList.contains('selected')).toBe(false);
  });

  it('a digit updates the badge at once (main does not call showPicker again)', () => {
    const { menus, cell, doc } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    fire(cell(BLOCK.OBSIDIAN), 'mouseover');
    doc.dispatch({ type: 'keydown', key: '7', code: 'Digit7' });
    expect(cell(BLOCK.OBSIDIAN).querySelector('.picker-badge').textContent).toBe('7');
  });

  it('dragging a block more than 6 px shows a ghost; dropping it on a hotbar slot picks it into that slot and stays open', () => {
    vi.useFakeTimers();
    const { menus, cell, doc, $, onPickBlock } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const slot = doc.querySelectorAll('.hotbar-slot')[5];
    doc.elementFromPoint = vi.fn((x) => (x > 500 ? slot.querySelector('canvas') : doc.body));
    const c = cell(BLOCK.TORCH);
    fire(c, 'pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    doc.dispatch({ type: 'pointermove', clientX: 13, clientY: 12, pointerId: 1 }); // 3.6 px: not yet
    expect(doc.body.querySelectorAll('.picker-ghost')).toHaveLength(0);
    doc.dispatch({ type: 'pointermove', clientX: 600, clientY: 650, pointerId: 1 });
    expect(doc.body.querySelectorAll('.picker-ghost')).toHaveLength(1);
    expect(slot.classList.contains('drop-target')).toBe(true);
    expect($('block-picker').classList.contains('dragging')).toBe(true);
    doc.dispatch({ type: 'pointerup', clientX: 600, clientY: 650, pointerId: 1 });
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.TORCH, 5);
    expect(menus.isPickerOpen()).toBe(true);
    expect(doc.body.querySelectorAll('.picker-ghost')).toHaveLength(0);
    expect(slot.classList.contains('drop-target')).toBe(false);
    expect(c.querySelector('.picker-badge').textContent).toBe('6');
    // the click that follows the drag (pointer capture) is swallowed
    fire(c, 'click');
    expect(onPickBlock).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    fire(c, 'click');
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.TORCH, null);
  });

  it('a drop anywhere else cancels; a small wobble is still a click', () => {
    vi.useFakeTimers();
    const { menus, cell, doc, onPickBlock } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    doc.elementFromPoint = vi.fn(() => doc.body);
    const c = cell(BLOCK.STONE_BRICKS) || cell(BLOCK.BRICKS);
    fire(c, 'pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
    doc.dispatch({ type: 'pointermove', clientX: 200, clientY: 10, pointerId: 2 });
    doc.dispatch({ type: 'pointerup', clientX: 200, clientY: 10, pointerId: 2 });
    expect(onPickBlock).not.toHaveBeenCalled();
    expect(doc.body.querySelectorAll('.picker-ghost')).toHaveLength(0);
    vi.runAllTimers(); // the swallowed click belongs to that gesture only
    // a 4 px wobble: no drag; the click picks
    const d = cell(BLOCK.OBSIDIAN);
    fire(d, 'pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 3 });
    doc.dispatch({ type: 'pointermove', clientX: 14, clientY: 10, pointerId: 3 });
    doc.dispatch({ type: 'pointerup', clientX: 14, clientY: 10, pointerId: 3 });
    fire(d, 'click');
    expect(onPickBlock).toHaveBeenLastCalledWith(BLOCK.OBSIDIAN, null);
  });

  it('dragging empty space scrolls the region (and swallows the click)', () => {
    vi.useFakeTimers();
    const { menus, $, doc, onPickBlock } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const scroll = $('picker-scroll');
    scroll.scrollTop = 300;
    const row = $('picker-grid').querySelector('.picker-row');
    fire(row, 'pointerdown', { button: 0, clientX: 50, clientY: 400, pointerId: 4 });
    doc.dispatch({ type: 'pointermove', clientX: 50, clientY: 397, pointerId: 4 });
    expect(scroll.scrollTop).toBe(300); // under 6 px
    doc.dispatch({ type: 'pointermove', clientX: 50, clientY: 300, pointerId: 4 });
    expect(scroll.scrollTop).toBe(400);
    expect(scroll.classList.contains('grabbing')).toBe(true);
    doc.dispatch({ type: 'pointerup', clientX: 50, clientY: 300, pointerId: 4 });
    expect(scroll.classList.contains('grabbing')).toBe(false);
    fire(row, 'click');
    expect(onPickBlock).not.toHaveBeenCalled();
  });
});

describe('the Recent row (§5.6)', () => {
  it('appears above the first section on the next opening, newest first, and is hidden while empty', () => {
    const { menus, grid, cell, doc } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect(grid.querySelector('.picker-section[data-section="recent"]')).toBeNull();
    fire(cell(BLOCK.BRICKS), 'click');
    fire(cell(BLOCK.OBSIDIAN), 'mouseover');
    doc.dispatch({ type: 'keydown', key: '2', code: 'Digit2' });
    // the grid does not jump under the pointer while it stays open
    expect(grid.querySelector('.picker-section[data-section="recent"]')).toBeNull();
    menus.hidePicker();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    const recent = grid.querySelector('.picker-section[data-section="recent"]');
    expect(grid.children[0]).toBe(recent);
    expect(recent.querySelectorAll('.picker-cell').map((c) => Number(c.dataset.blockId))).toEqual([BLOCK.OBSIDIAN, BLOCK.BRICKS]);
  });
});

describe('lifecycle', () => {
  it('dispose removes the document listeners and empties the grid', () => {
    const { menus, doc, $ } = setup();
    menus.showPicker([...DEFAULT_HOTBAR], 0);
    expect(doc.listenerCount('keydown')).toBeGreaterThan(0);
    menus.dispose();
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(doc.listenerCount('pointermove')).toBe(0);
    expect($('picker-grid').children).toHaveLength(0);
    expect(menus.isPickerOpen()).toBe(false);
  });
});
