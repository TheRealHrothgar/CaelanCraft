// Unit tests for src/packUI.js (docs/DESIGN-survival.md §5.4, §9.8): the pure geometry (rosetteCells ordering, the zig-zag
// strip, card layout) and label formatters, and — on a fake DOM — that the screen draws a view and forwards raw clicks.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  rosetteCells, ringsFor, hexToPixel, stripCells, cardLayout, formatSeconds, haveNeedText, haveNeedLevel, countLabel,
  durabilityText, stackTitle, recipeTitle, stationHint, stationName, tabLabel, jobStatusText, toolLabel, toolIconKey,
  filterRecipes, demoPackView, createPackUI, STATION_TABS, CELL_S, searchRecipes, recipeSearchText, treeFactsFromView,
  makesMany, MAKE_MANY, revealSignature,
} from '../../src/packUI.js';
import { buildTreeModel, treeStates, revealTree, revealedTree, isCircuitKey } from '../../src/buildTree.js';
import { PACK_SLOTS, HOTBAR_SIZE, BASKET_SLOTS, REMAINS_SLOTS } from '../../src/config.js';
import { isItemKey, ITEM_KEYS, stackSize } from '../../src/items.js';
import { RECIPES } from '../../src/crafting.js';
import { documentFromHTML, fire, FakeElement } from '../helpers/fakeDom.js';

/** Hex distance of an axial cell from the centre. */
const ring = ([q, r]) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));

describe('rosetteCells', () => {
  it('ring 1 is the six neighbours clockwise from the top: N, NE, SE, S, SW, NW', () => {
    expect(rosetteCells(1)).toEqual([[0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]]);
  });

  it('ring 2 follows ring 1, twelve cells clockwise from the top', () => {
    const cells = rosetteCells(2);
    expect(cells).toHaveLength(18);
    expect(cells.slice(0, 6)).toEqual(rosetteCells(1));
    expect(cells.slice(6)).toEqual([
      [0, -2], [1, -2], [2, -2], [2, -1], [2, 0], [1, 1], [0, 2], [-1, 2], [-2, 2], [-2, 1], [-2, 0], [-1, -1],
    ]);
  });

  it('every ring is complete, unique, centre excluded, and walks clockwise on screen', () => {
    for (const rings of [1, 2, 3, 4]) {
      const cells = rosetteCells(rings);
      expect(cells).toHaveLength(3 * rings * (rings + 1));
      expect(new Set(cells.map((c) => c.join())).size).toBe(cells.length);
      expect(cells.some(([q, r]) => q === 0 && r === 0)).toBe(false);
      let start = 0;
      for (let k = 1; k <= rings; k++) {
        const ringCells = cells.slice(start, start + 6 * k);
        start += 6 * k;
        expect(ringCells.every((c) => ring(c) === k)).toBe(true);
        // screen angle clockwise from straight up strictly increases around the ring, starting at 0 (the top)
        const angles = ringCells.map(([q, r]) => {
          const [x, y] = hexToPixel(q, r, 1);
          const a = Math.atan2(x, -y);
          return a < -1e-9 ? a + 2 * Math.PI : Math.max(0, a);
        });
        expect(angles[0]).toBeCloseTo(0, 9);
        for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
      }
    }
  });

  it('the pack rosette is 18 cells (slots 9–26) and a basket\'s is too; belongings would need a third ring', () => {
    expect(PACK_SLOTS - HOTBAR_SIZE).toBe(18);
    expect(ringsFor(PACK_SLOTS - HOTBAR_SIZE)).toBe(2);
    expect(ringsFor(BASKET_SLOTS)).toBe(2);
    expect(ringsFor(REMAINS_SLOTS)).toBe(3);
    expect(ringsFor(6)).toBe(1);
    expect(ringsFor(7)).toBe(2);
    expect(ringsFor(0)).toBe(0);
    expect(rosetteCells(0)).toEqual([]);
    expect(rosetteCells(/** @type {any} */ ('x'))).toEqual([]);
  });
});

describe('flat-top geometry', () => {
  it('hexToPixel: N is straight up, the six neighbours are all √3·s away', () => {
    const [x, y] = hexToPixel(0, -1, 10);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(-10 * Math.sqrt(3), 9);
    for (const [q, r] of rosetteCells(1)) expect(Math.hypot(...hexToPixel(q, r, 10))).toBeCloseTo(10 * Math.sqrt(3), 9);
  });

  it('the hotbar strip zig-zags: every other cell half a cell lower, neighbours touching', () => {
    const cells = stripCells(HOTBAR_SIZE, CELL_S);
    expect(cells).toHaveLength(9);
    const h = Math.sqrt(3) * CELL_S;
    cells.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(1.5 * CELL_S * i, 9);
      expect(y).toBeCloseTo(i % 2 ? h / 2 : 0, 9);
    });
    for (let i = 1; i < cells.length; i++) {
      const d = Math.hypot(cells[i][0] - cells[i - 1][0], cells[i][1] - cells[i - 1][1]);
      expect(d).toBeCloseTo(h, 9); // adjacent hexes
    }
  });

  it('recipe cards: tools take the lower-right hex first, inputs fill from the top', () => {
    expect(cardLayout(1, 0)).toEqual({ inputs: ['N'], tools: [] });
    expect(cardLayout(3, 1)).toEqual({ inputs: ['N', 'NE', 'NW'], tools: ['SE'] });
    expect(cardLayout(3, 2)).toEqual({ inputs: ['N', 'NE', 'NW'], tools: ['SE', 'S'] });
    expect(cardLayout(4, 2)).toEqual({ inputs: ['N', 'NE', 'NW', 'SW'], tools: ['SE', 'S'] });
    expect(cardLayout(6, 0).inputs).toEqual(['N', 'NE', 'NW', 'SW', 'S', 'SE']);
    expect(cardLayout(6, 2).inputs).toHaveLength(4); // never more than six on the ring
  });
});

describe('label formatters', () => {
  it('formatSeconds', () => {
    expect(formatSeconds(0)).toBe('0 s');
    expect(formatSeconds(2.2)).toBe('3 s');
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(59.5)).toBe('1:00');
    expect(formatSeconds(65)).toBe('1:05');
    expect(formatSeconds(250)).toBe('4:10');
    expect(formatSeconds(1200)).toBe('20:00');
    expect(formatSeconds(NaN)).toBe('0 s');
    expect(formatSeconds(-4)).toBe('0 s');
  });

  it('have/need, green or red', () => {
    expect(haveNeedText(3, 6)).toBe('3/6');
    expect(haveNeedText(12.7, 6)).toBe('12/6');
    expect(haveNeedText(5000, 7)).toBe('999/7');
    expect(haveNeedText(-1, 2)).toBe('0/2');
    expect(haveNeedLevel(6, 6)).toBe('ok');
    expect(haveNeedLevel(5, 6)).toBe('short');
  });

  it('counts, durability, stack titles', () => {
    expect(countLabel(null)).toBe('');
    expect(countLabel({ k: 'rock', n: 1 })).toBe('');
    expect(countLabel({ k: 'rock', n: 12 })).toBe('12');
    expect(durabilityText({ k: 'flint_axe', n: 1, d: 45 })).toBe('45/90');
    expect(durabilityText({ k: 'flint_axe', n: 1 })).toBe('90/90');
    expect(durabilityText({ k: 'rock', n: 3 })).toBe('');
    expect(durabilityText(null)).toBe('');
    expect(stackTitle({ k: 'rock', n: 12 })).toBe('Rock ×12');
    expect(stackTitle({ k: 'flint_axe', n: 1, d: 45 })).toBe('Flint Axe · 45/90');
    expect(stackTitle({ k: 'pot_water', n: 1 })).toBe('Pot of Water');
    expect(stackTitle(null)).toBe('');
    expect(recipeTitle({ k: 'stick', n: 6 })).toBe('Stick ×6');
    expect(recipeTitle({ k: 'kiln', n: 1 })).toBe('Kiln');
  });

  it('stations, tabs, hints, jobs, tools', () => {
    expect(STATION_TABS.map(([, l]) => l)).toEqual(['All', 'Hands', 'Stump', 'Kiln', 'Bloomery', 'Forge', 'Bench', 'Lab']);
    expect(tabLabel('kiln')).toBe('Kiln');
    expect(tabLabel('all')).toBe('All');
    expect(stationName('stump')).toBe('Work Stump');
    expect(stationHint('kiln')).toBe('build a Kiln nearby');
    expect(stationHint('stump')).toBe('build a Work Stump nearby');
    expect(stationHint('hand')).toBe('');
    expect(jobStatusText({ progress: 0.4, waiting: false })).toBe('40%');
    expect(jobStatusText({ progress: 0.4, waiting: true })).toBe('waiting');
    expect(jobStatusText({ progress: 0, waiting: 'Kiln too far' })).toBe('Kiln too far');
    expect(toolLabel({ type: 'axe', tier: 1 })).toBe('axe≥1');
    expect(toolLabel({ type: 'axe', tier: 1, label: 'an axe' })).toBe('an axe');
  });

  it('a required tool shows the cheapest tool that qualifies', () => {
    expect(toolIconKey('axe', 1)).toBe('stone_axe');
    expect(toolIconKey('axe', 2)).toBe('flint_axe');
    expect(toolIconKey('hammer', 1)).toBe('hammerstone');
    expect(toolIconKey('hammer', 4)).toBe('bronze_hammer');
    expect(toolIconKey('knife', 2)).toBe('flint_knife');
    expect(toolIconKey('firestarter', 0)).toBe('fire_drill');
    expect(toolIconKey('crucible', 0)).toBe('crucible');
    expect(toolIconKey('mold', 0)).toBe('casting_mold');
    expect(toolIconKey('pick', 7)).toBeNull();
  });

  it('tab filtering keeps the order', () => {
    const rs = /** @type {any[]} */ ([{ id: 'a', station: 'hand' }, { id: 'b', station: 'kiln' }, { id: 'c', station: 'hand' }]);
    expect(filterRecipes(rs, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterRecipes(rs, 'hand').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRecipes(rs, 'forge')).toEqual([]);
    expect(filterRecipes(/** @type {any} */ (null), 'all')).toEqual([]);
  });

  it('the demo view is a valid view of real items (the ?ui=pack story)', () => {
    const v = demoPackView();
    expect(v.slots).toHaveLength(PACK_SLOTS);
    expect(v.wear).toHaveLength(3);
    for (const s of [...v.slots, ...v.wear]) if (s) expect(isItemKey(s.k), s.k).toBe(true);
    for (const r of v.recipes) {
      expect(isItemKey(r.out.k), r.id).toBe(true);
      for (const i of r.inputs) if (i.k) expect(isItemKey(i.k), i.k).toBe(true);
    }
    expect(v.container).toBeNull();
    expect(demoPackView({ basket: true }).container?.slots).toHaveLength(BASKET_SLOTS);
  });
});

describe('§99: ×5 only for what stacks (pure)', () => {
  it('makesMany: true for an output that stacks, false for a tool, the hammerstone or anything of stack 1', () => {
    expect(MAKE_MANY).toBe(5);
    expect(makesMany({ k: 'cord', n: 1 })).toBe(true);
    expect(makesMany({ k: 'charcoal', n: 1 })).toBe(true);
    expect(makesMany({ k: 'campfire', n: 1 })).toBe(true);
    for (const k of ['hammerstone', 'stone_axe', 'wooden_shovel', 'flint_spear', 'steel_pick', 'fire_drill', 'bellows']) {
      expect(makesMany({ k, n: 1 }), k).toBe(false);
    }
    expect(makesMany({ k: 'no_such_item', n: 1 })).toBe(false);
    expect(makesMany(null)).toBe(false);
    // every recipe: ×5 exactly when its output stacks
    for (const r of RECIPES) expect(makesMany(r.outputs[0]), r.id).toBe(stackSize(r.outputs[0].k) > 1);
    expect(ITEM_KEYS.filter((k) => stackSize(k) === 1).length).toBeGreaterThan(30);
  });
});

describe('§94: search and the build tree facts (pure)', () => {
  const recipes = demoPackView().recipes;
  it('search text: output, inputs (and a tag\'s members), tools, workplace, purpose', () => {
    const spear = recipes.find((r) => r.id === 'flint_spear');
    const text = recipeSearchText(spear);
    for (const w of ['flint spear', 'stick', 'cord', 'flint', 'obsidian', 'work stump', 'hammer']) expect(text, w).toContain(w);
  });
  it('every word must match, in any order and case; an empty query keeps all', () => {
    expect(searchRecipes(recipes, '').length).toBe(recipes.length);
    expect(searchRecipes(recipes, '   ').length).toBe(recipes.length);
    expect(searchRecipes(recipes, 'LEATHER').map((r) => r.id)).toEqual(['leather']);
    expect(searchRecipes(recipes, 'stick stump').map((r) => r.id)).toEqual(['flint_spear', 'split_sticks']);
    expect(searchRecipes(recipes, 'stump stick').map((r) => r.id)).toEqual(['flint_spear', 'split_sticks']);
    expect(searchRecipes(recipes, 'zzz')).toEqual([]);
    expect(searchRecipes(/** @type {any} */ (null), 'x')).toEqual([]);
  });
  it('tree facts: counts across the pack, a tool or better, ready recipes, near workplaces', () => {
    const v = demoPackView();
    const f = treeFactsFromView(v);
    expect(f.count('rock')).toBe(23);
    expect(f.count('straw_hat')).toBe(1); // worn counts
    expect(f.hasTool('pick', 2)).toBe(true);
    expect(f.hasTool('pick', 3)).toBe(false);
    expect(f.canMake('cord')).toBe(true);
    expect(f.canMake('charcoal')).toBe(false);
    expect(f.near('stump')).toBe(true);
    expect(f.near('kiln')).toBe(false);
  });
});

describe('the pack screen on a page', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
  function setup(callbacks = {}) {
    const doc = documentFromHTML(html);
    const icons = { draw: vi.fn(), canvas: vi.fn(() => doc.createElement('canvas')), paintedCount: () => 0 };
    const ui = createPackUI(/** @type {any} */ (doc), /** @type {any} */ (icons), callbacks);
    return { doc, ui, icons, root: /** @type {any} */ (doc.getElementById('pack-screen')) };
  }
  const cell = (root, area, i) => root.querySelector(`.pack-cell[data-area="${area}"][data-index="${i}"]`);

  it('opens on #pack-screen with 27 pack cells, 3 wear cells and a discard hex; closes again', () => {
    const { ui, root } = setup();
    expect(root.classList.contains('hidden')).toBe(true);
    ui.open(demoPackView());
    expect(ui.isOpen()).toBe(true);
    expect(root.classList.contains('hidden')).toBe(false);
    expect(root.querySelectorAll('.pack-cell[data-area="pack"]')).toHaveLength(PACK_SLOTS);
    expect(root.querySelectorAll('.pack-cell[data-area="wear"]')).toHaveLength(3);
    expect(root.querySelectorAll('.pack-cell[data-area="discard"]')).toHaveLength(1);
    expect(root.querySelectorAll('.pack-strip .pack-cell')).toHaveLength(HOTBAR_SIZE);
    expect(root.querySelectorAll('.pack-rosette .pack-cell[data-area="pack"]')).toHaveLength(18);
    ui.close();
    expect(ui.isOpen()).toBe(false);
    expect(root.classList.contains('hidden')).toBe(true);
  });

  it('draws counts, the selected strip cell and wear outlines', () => {
    const { ui, root } = setup();
    const v = demoPackView();
    ui.open(v);
    expect(cell(root, 'pack', 6).querySelector('.cell-count').textContent).toBe('23'); // rock ×23
    expect(cell(root, 'pack', 0).classList.contains('selected')).toBe(true);
    expect(cell(root, 'pack', 0).querySelector('.cell-wear').getAttribute('class')).toBe('cell-wear good'); // 51/90
    expect(cell(root, 'pack', 1).querySelector('.cell-wear').getAttribute('class')).toBe('cell-wear low'); // 18/90
    expect(cell(root, 'pack', 2).querySelector('.cell-wear').getAttribute('class')).toBe('cell-wear hidden'); // new
    expect(cell(root, 'wear', 0).title).toBe('Straw Hat');
  });

  it('forwards raw clicks: left / right / shift on slots, discard, and nothing for the middle button', () => {
    const onSlot = vi.fn();
    const onDiscard = vi.fn();
    const { ui, root } = setup({ onSlot, onDiscard });
    ui.open(demoPackView({ basket: true }));
    fire(cell(root, 'pack', 12).querySelector('canvas'), 'mousedown', { button: 0 });
    expect(onSlot).toHaveBeenLastCalledWith('pack', 12, 0, false);
    fire(cell(root, 'pack', 3), 'mousedown', { button: 2, shiftKey: true });
    expect(onSlot).toHaveBeenLastCalledWith('pack', 3, 2, true);
    fire(cell(root, 'wear', 1), 'mousedown', { button: 0 });
    expect(onSlot).toHaveBeenLastCalledWith('wear', 1, 0, false);
    fire(cell(root, 'container', 17), 'mousedown', { button: 0, shiftKey: true });
    expect(onSlot).toHaveBeenLastCalledWith('container', 17, 0, true);
    const n = onSlot.mock.calls.length;
    fire(cell(root, 'pack', 3), 'mousedown', { button: 1 });
    fire(root.querySelector('.pack-centre'), 'mousedown', { button: 0 });
    expect(onSlot.mock.calls.length).toBe(n);
    fire(cell(root, 'discard', 0), 'mousedown', { button: 0 });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    // the context menu never opens over the screen
    const e = { type: 'contextmenu', bubbles: true };
    root.querySelector('.pack-panel').dispatchEvent(e);
    expect(/** @type {any} */ (e).defaultPrevented).toBe(true);
  });

  it('§14: right-click on the handbook reads it (onRead, not onSlot); so does the Read button, shown while the pack holds it', () => {
    const onSlot = vi.fn();
    const onRead = vi.fn();
    const { ui, root } = setup({ onSlot, onRead });
    const v = demoPackView();
    const at = v.slots.findIndex((s) => s && s.k === 'handbook');
    expect(at).toBeGreaterThanOrEqual(0); // the ?ui=pack story carries the handbook too
    ui.open(v);
    fire(cell(root, 'pack', at), 'mousedown', { button: 2 });
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onSlot).not.toHaveBeenCalled();
    // a left click picks it up as usual (to move it about)
    fire(cell(root, 'pack', at), 'mousedown', { button: 0 });
    expect(onSlot).toHaveBeenLastCalledWith('pack', at, 0, false);
    // with a stack on the cursor, a right-click is the usual "put one"
    ui.refresh({ ...v, cursor: { k: 'rock', n: 2 } });
    fire(cell(root, 'pack', at), 'mousedown', { button: 2 });
    expect(onSlot).toHaveBeenLastCalledWith('pack', at, 2, false);
    expect(onRead).toHaveBeenCalledTimes(1);
    // right-click on anything else is the usual "take half"
    fire(cell(root, 'pack', 6), 'mousedown', { button: 2 });
    expect(onSlot).toHaveBeenLastCalledWith('pack', 6, 2, false);
    // the Read button
    const read = root.querySelector('.pack-read');
    expect(read.classList.contains('hex-button')).toBe(true);
    expect(read.classList.contains('hidden')).toBe(false);
    fire(read, 'click');
    expect(onRead).toHaveBeenCalledTimes(2);
    const without = demoPackView();
    without.slots[at] = null;
    ui.refresh(without);
    expect(read.classList.contains('hidden')).toBe(true);
  });

  it('a basket replaces the Making panel, never stacked above the pack', () => {
    const { ui, root } = setup();
    ui.open(demoPackView({ basket: true }));
    expect(root.querySelector('.making').classList.contains('hidden')).toBe(true);
    expect(root.querySelector('.container-panel').classList.contains('hidden')).toBe(false);
    expect(root.querySelectorAll('.pack-cell[data-area="container"]')).toHaveLength(BASKET_SLOTS);
    expect(root.querySelector('.container-panel .pack-heading').textContent).toBe('Wicker Basket');
    ui.refresh(demoPackView());
    expect(root.querySelector('.making').classList.contains('hidden')).toBe(false);
    expect(root.querySelector('.container-panel').classList.contains('hidden')).toBe(true);
  });

  it('the centre hex and info line show the hovered stack, else the cursor\'s', () => {
    const { ui, root } = setup();
    const v = demoPackView();
    ui.open(v);
    const info = root.querySelector('.pack-info');
    expect(info.textContent).toBe('');
    fire(cell(root, 'pack', 1), 'mouseover', {});
    expect(info.textContent).toBe('Flint Axe · 18/90');
    fire(root.querySelector('.pack-panel'), 'mouseover', {});
    expect(info.textContent).toBe('');
    ui.refresh({ ...v, cursor: { k: 'cord', n: 3 } });
    expect(info.textContent).toBe('Cord ×3');
    expect(root.querySelector('.pack-cursor').classList.contains('hidden')).toBe(false);
    ui.refresh({ ...v, cursor: null });
    expect(root.querySelector('.pack-cursor').classList.contains('hidden')).toBe(true);
  });

  it('the cursor stack shows under the mouse at once and follows it', () => {
    const { ui, root } = setup();
    const v = demoPackView();
    ui.open(v);
    fire(cell(root, 'pack', 9), 'mousedown', { button: 0, clientX: 300, clientY: 200 });
    ui.refresh({ ...v, cursor: { k: 'plant_fibre', n: 31 } });
    const cursor = root.querySelector('.pack-cursor');
    expect(cursor.classList.contains('hidden')).toBe(false);
    expect(cursor.style.transform).toBe(`translate(${300 - CELL_S}px, ${Math.round(200 - (Math.sqrt(3) * CELL_S) / 2)}px)`);
    fire(root.querySelector('.pack-panel'), 'mousemove', { clientX: 500, clientY: 400 });
    expect(cursor.style.transform).toBe(`translate(${500 - CELL_S}px, ${Math.round(400 - (Math.sqrt(3) * CELL_S) / 2)}px)`);
    expect(cursor.querySelector('.cell-count').textContent).toBe('31');
  });

  it('Making: tabs (far stations dimmed), recipe cards as mini rosettes with have/need, Make / ×5, lanes with ✕', () => {
    const onTab = vi.fn();
    const onMake = vi.fn();
    const onCancelJob = vi.fn();
    const { ui, root } = setup({ onTab, onMake, onCancelJob });
    const v = demoPackView();
    ui.open(v);
    const tabs = root.querySelectorAll('.making-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Hands', 'Stump', 'Kiln', 'Bloomery', 'Forge', 'Bench', 'Lab']);
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[3].classList.contains('far')).toBe(true);
    expect(tabs[3].title).toBe('build a Kiln nearby');
    tabs[3].click();
    expect(onTab).toHaveBeenCalledWith('kiln');
    const cards = root.querySelectorAll('.recipe-card');
    expect(cards).toHaveLength(v.recipes.length);
    const spear = root.querySelector('.recipe-card[data-recipe="flint_spear"]');
    expect(spear.querySelectorAll('.card-in')).toHaveLength(3);
    expect(spear.querySelectorAll('.card-tool')).toHaveLength(1);
    expect(spear.querySelector('.card-tool').classList.contains('short')).toBe(true);
    expect(spear.querySelectorAll('.card-badge').map((b) => b.textContent)).toEqual(['3/1', '14/2', '4/1']);
    expect(spear.querySelector('.card-make').hasAttribute('disabled')).toBe(true); // no hammer
    // §99: a tool is made one at a time — its card has Make and no ×5
    expect(spear.querySelectorAll('.card-make').map((b) => b.textContent)).toEqual(['Make']);
    // §77: what the thing is for, one line under its name, with the whole line as a tooltip
    expect(spear.querySelector('.card-purpose').textContent).toBe('The hunting weapon: thrust it or throw it.');
    expect(spear.querySelector('.card-purpose').title).toBe('The hunting weapon: thrust it or throw it.');
    expect(root.querySelector('.recipe-card[data-recipe="cord"] .card-purpose').textContent).toBe('Binds every hafted tool.');
    const cord = root.querySelector('.recipe-card[data-recipe="cord"]');
    expect(cord.classList.contains('craftable')).toBe(true);
    expect(cord.querySelectorAll('.card-make').map((b) => b.textContent)).toEqual(['Make', '×5']);
    const [make1, make5] = cord.querySelectorAll('.card-make');
    make1.click();
    expect(onMake).toHaveBeenLastCalledWith('cord', 1);
    make5.click();
    expect(onMake).toHaveBeenLastCalledWith('cord', 5);
    const charcoal = root.querySelector('.recipe-card[data-recipe="charcoal"]');
    expect(charcoal.classList.contains('far')).toBe(true);
    expect(charcoal.querySelector('.card-meta').textContent).toBe('40 s · build a Kiln nearby');
    const n = onMake.mock.calls.length;
    charcoal.querySelector('.card-make').click();
    expect(onMake.mock.calls.length).toBe(n); // disabled
    const lanes = root.querySelectorAll('.lane-row');
    expect(lanes.map((l) => l.dataset.station)).toEqual(['hand', 'kiln']);
    expect(lanes[1].querySelector('.job-status').textContent).toBe('Kiln too far');
    lanes[0].querySelectorAll('.job-cancel')[1].click();
    expect(onCancelJob).toHaveBeenCalledWith('hand', 1);
  });

  it('a tab lists only its station\'s recipes; a refresh keeps the same card elements', () => {
    const { ui, root } = setup();
    const v = demoPackView();
    ui.open(v);
    const cord = root.querySelector('.recipe-card[data-recipe="cord"]');
    ui.refresh({ ...v, tab: 'stump' });
    expect(root.querySelectorAll('.recipe-card').map((c) => c.dataset.recipe)).toEqual(['flint_spear', 'leather', 'split_sticks']); // §94: the flint spear is made at the stump
    ui.refresh(v);
    expect(root.querySelector('.recipe-card[data-recipe="cord"]')).toBe(cord);
  });

  it('refresh redraws only what changed', () => {
    const { ui, icons, doc } = setup();
    const v = demoPackView();
    ui.open(v);
    const drawn = icons.draw.mock.calls.length;
    const writes = doc.writes;
    ui.refresh({ ...v });
    expect(icons.draw.mock.calls.length).toBe(drawn);
    expect(doc.writes).toBe(writes);
    const slots = v.slots.slice();
    slots[6] = { k: 'rock', n: 24 };
    ui.refresh({ ...v, slots });
    expect(icons.draw.mock.calls.length).toBe(drawn); // same item: only the count changes
    expect(doc.writes).toBeGreaterThan(writes);
  });

  it('E and Esc close (a document listener only while open); key repeats are ignored', () => {
    const onClose = vi.fn();
    const { ui, doc, root } = setup({ onClose });
    ui.open(demoPackView());
    expect(doc.listenerCount('keydown')).toBe(1);
    doc.dispatch({ type: 'keydown', code: 'KeyE', repeat: true });
    expect(onClose).not.toHaveBeenCalled();
    doc.dispatch({ type: 'keydown', code: 'KeyE' });
    expect(onClose).toHaveBeenCalledTimes(1);
    doc.dispatch({ type: 'keydown', key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    root.querySelector('.pack-close').click();
    expect(onClose).toHaveBeenCalledTimes(3);
    ui.close();
    expect(doc.listenerCount('keydown')).toBe(0);
    doc.dispatch({ type: 'keydown', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('uses .hex-button and never .mc-button or .picker-panel (§11)', () => {
    const { ui, root } = setup();
    ui.open(demoPackView());
    expect(root.querySelectorAll('.mc-button, .picker-panel')).toHaveLength(0);
    expect(root.querySelectorAll('.hex-button').length).toBeGreaterThan(10);
    ui.refresh(demoPackView({ basket: true }));
    expect(root.querySelectorAll('.mc-button, .picker-panel')).toHaveLength(0);
  });

  it('dispose removes its listeners and content; refresh while closed does nothing', () => {
    const onSlot = vi.fn();
    const { ui, root, doc } = setup({ onSlot });
    ui.refresh(demoPackView());
    expect(root.children).toHaveLength(0);
    ui.open(demoPackView());
    ui.dispose();
    expect(root.children).toHaveLength(0);
    expect(doc.listenerCount('keydown')).toBe(0);
    ui.open(demoPackView());
    expect(ui.isOpen()).toBe(false);
  });

  it('shows the view\'s message line on the screen itself (play-test: the Handbook\'s refusal was never seen)', () => {
    const { ui, root } = setup();
    const view = demoPackView();
    ui.open({ ...view, message: null });
    const line = root.querySelector('.pack-message');
    expect(line).toBeTruthy();
    expect(line.textContent).toBe('');
    ui.refresh({ ...view, message: { text: 'The handbook stays with you.', error: true } });
    expect(line.textContent).toBe('The handbook stays with you.');
    expect(line.classList.contains('error')).toBe(true);
    ui.refresh({ ...view, message: { text: 'Making 5 × Cord', error: false } });
    expect(line.textContent).toBe('Making 5 × Cord');
    expect(line.classList.contains('error')).toBe(false);
    ui.refresh({ ...view, message: null });
    expect(line.textContent).toBe('');
    expect(line.getAttribute('role')).toBe('status');
  });

  it('§94: the search box narrows the list by name, input or workplace; typing never closes the pack; Esc clears it first', () => {
    const onClose = vi.fn();
    const onTab = vi.fn();
    const { ui, root } = setup({ onClose, onTab });
    ui.open({ ...demoPackView(), tab: 'stump' });
    const search = root.querySelector('.making-search');
    expect(search).toBeTruthy();
    const ids = () => root.querySelectorAll('.recipe-card').map((c) => c.dataset.recipe);
    search.value = 'leather';
    fire(search, 'input');
    expect(onTab).toHaveBeenCalledWith('all'); // a search looks at every workplace
    ui.refresh({ ...demoPackView(), tab: 'all' });
    expect(ids()).toEqual(['leather']);
    search.value = 'kiln';
    fire(search, 'input');
    expect(ids()).toEqual(['kiln', 'charcoal', 'copper_pick']); // the Kiln itself and what is made at it
    search.value = 'nothing like this';
    fire(search, 'input');
    expect(ids()).toEqual([]);
    expect(root.querySelector('.recipe-empty').textContent).toBe('Nothing here matches “nothing like this”');
    // an E typed into the box is a letter, not "close"
    fire(search, 'keydown', { key: 'e', code: 'KeyE' });
    expect(onClose).not.toHaveBeenCalled();
    // Esc empties the box first, then closes as ever
    fire(search, 'keydown', { key: 'Escape', code: 'Escape' });
    expect(search.value).toBe('');
    expect(ids().length).toBe(demoPackView().recipes.length);
    expect(onClose).not.toHaveBeenCalled();
    fire(search, 'keydown', { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('§94: the build tree opens over the screen with what is revealed, shows their states, and a click searches for it', () => {
    const onTab = vi.fn();
    const { ui, root, doc } = setup({ onTab });
    const view = { ...demoPackView(), tab: 'hand' };
    ui.open(view);
    const tree = root.querySelector('.build-tree');
    expect(tree.classList.contains('hidden')).toBe(true);
    root.querySelector('.tree-open').click();
    expect(ui.isTreeOpen()).toBe(true);
    expect(tree.classList.contains('hidden')).toBe(false);
    // §94.4: what the demo pack has, can make, or is one step from (its view has no `had`: what it carries counts)
    const model = buildTreeModel();
    const facts = treeFactsFromView(view);
    const shown = revealedTree(model, revealTree(model, { states: treeStates(model, facts), canMake: facts.canMake }));
    expect(root.querySelectorAll('.tree-node')).toHaveLength(shown.nodes.length);
    expect(shown.nodes.length).toBeLessThan(model.nodes.length);
    expect(root.querySelectorAll('.tree-col-head')).toHaveLength(6);
    expect(root.querySelectorAll('.tree-edge')).toHaveLength(shown.edges.length);
    const at = (id) => root.querySelector(`.tree-node[data-node="${id}"]`);
    expect(at('rock').getAttribute('data-state')).toBe('have'); // the demo pack holds 23 rock
    expect(at('flint_pick').getAttribute('data-state')).toBe('have');
    expect(at('@kiln').getAttribute('data-state')).toBe('ready'); // the demo can make a Kiln now
    expect(at('@lab').getAttribute('data-state')).toBe('locked');
    expect(at('#sand').getAttribute('data-state')).toBe('gather');
    expect(at('cassiterite')).toBeNull(); // tin ore wants a copper pick: two steps off, not shown
    // a workplace is a colour, not a level: what is made at the Kiln is filled with the Kiln's, so are the links into it;
    // each column is tinted with its own workplace's; the workplace heads its column with its recipe and what it unlocks
    expect(at('copper_ingot').querySelector('.tree-fill').classList.contains('ws-kiln')).toBe(true);
    expect(at('rock').querySelector('.tree-fill').classList.contains('ws-gather')).toBe(true);
    expect(at('stone_axe').querySelector('.tree-fill').classList.contains('ws-hand')).toBe(true);
    expect(root.querySelectorAll('.tree-col').map((c) => c.className.replace(' unreached', '').replace(' veiled', ''))).toEqual(
      ['stump', 'kiln', 'bloomery', 'forge', 'workbench', 'lab'].map((s) => `tree-col ws-${s}`));
    // a column not reached is a dim head: its name and what it needs, no unlocks; a workplace in sight shows its unlocks
    expect(at('@lab').classList.contains('veiled')).toBe(true);
    expect(root.querySelector('.tree-col.ws-lab').classList.contains('unreached')).toBe(true);
    expect(at('@lab').querySelectorAll('.tree-needs .tree-mini')).toHaveLength(model.byId.get('@lab').needs.length);
    expect(at('@lab').querySelector('.tree-unlocks')).toBeNull();
    // §94.4a: the strip shows only what is shown of what it unlocks (had, makeable now or a step away), at most 6 icons
    const stumpUnlocks = shown.byId.get('@stump').unlocks;
    expect(stumpUnlocks.length).toBeGreaterThan(0);
    expect(stumpUnlocks.length).toBeLessThan(model.byId.get('@stump').unlocks.length);
    expect(at('@stump').querySelectorAll('.tree-unlocks .tree-mini')).toHaveLength(Math.min(6, stumpUnlocks.length));
    // each column with hidden things says how many: a "?" in its build lane
    const more = root.querySelector('.tree-node[data-node="?lab"]');
    expect(more.classList.contains('tree-node-more')).toBe(true);
    expect(more.getAttribute('data-state')).toBe('more');
    expect(more.querySelector('.tree-label').textContent).toBe(`${shown.byId.get('?lab').more} more`);
    expect(root.querySelectorAll('.tree-node-more')).toHaveLength(shown.nodes.filter((n) => n.more !== undefined).length);
    expect(root.querySelectorAll('.tree-edge.ws-kiln').length).toBeGreaterThan(0);
    // a click on the "more" marker does nothing
    more.querySelector('.tree-label').click();
    expect(ui.isTreeOpen()).toBe(true);
    // Esc goes back to Making, not out of the pack
    fire(doc.body, 'keydown', { key: 'Escape', code: 'Escape' });
    expect(ui.isTreeOpen()).toBe(false);
    expect(ui.isOpen()).toBe(true);
    // a click on a node closes the tree and searches the list for it
    root.querySelector('.tree-open').click();
    at('leather').querySelector('.tree-label').click();
    expect(ui.isTreeOpen()).toBe(false);
    expect(root.querySelector('.making-search').value).toBe('Leather');
    expect(onTab).toHaveBeenCalledWith('all');
    ui.close();
    expect(ui.isTreeOpen()).toBe(false);
  });

  it('§94.4: the tree grows as things are had (drawn again only then), and with the circuits off has no Lab and no circuits', () => {
    const { ui, root } = setup();
    const start = { ...demoPackView(), slots: demoPackView().slots.map((s) => (s && s.k === 'handbook' ? s : null)), wear: [null, null, null],
      ready: [], had: ['handbook'], circuits: true };
    ui.open(start);
    ui.openTree();
    const ids = () => root.querySelectorAll('.tree-node').map((n) => n.getAttribute('data-node')).filter((id) => !id.startsWith('@') && !id.startsWith('?')).sort();
    // the start of a world: the first steps only (the stump's column counts its 2 hidden nodes and its 18 unlocks)
    expect(ids()).toEqual(['cord', 'hammerstone', 'plant_fibre', 'rock', 'stick']);
    expect(root.querySelector('.tree-node[data-node="?stump"] .tree-label').textContent).toBe(`${2 + buildTreeModel().byId.get('@stump').unlocks.length} more`);
    expect(root.querySelector('.tree-node[data-node="@stump"] .tree-unlocks')).toBeNull();
    const canvas = root.querySelector('.tree-canvas');
    // a refresh that changes no reveal keeps the drawing
    ui.refresh({ ...start });
    expect(root.querySelector('.tree-canvas')).toBe(canvas);
    // a kit had (a flint knife, cord, a stone axe): the tree grows
    ui.refresh({ ...start, had: ['handbook', 'flint_knife', 'cord', 'stone_axe'] });
    expect(root.querySelector('.tree-canvas')).not.toBe(canvas);
    expect(ids()).toEqual(expect.arrayContaining(['#log', 'stone_axe', 'flint_knife', 'leather', 'wooden_shovel']));
    expect(root.querySelector('.tree-node[data-node="flint_knife"]').getAttribute('data-state')).toBe('locked'); // had, not carried
    // the circuits off: no Lab column, no circuit anywhere in the tree's nodes or unlocks
    const all = ITEM_KEYS.filter((k) => k !== 'handbook');
    ui.refresh({ ...start, had: all, circuits: false });
    expect(root.querySelectorAll('.tree-col-head')).toHaveLength(5);
    expect(root.querySelector('.tree-col.ws-lab')).toBeNull();
    expect(root.querySelector('.tree-key.ws-lab')).toBeNull();
    expect(root.querySelector('.tree-node[data-node="@lab"]')).toBeNull();
    for (const id of ids()) expect(isCircuitKey(id), id).toBe(false);
    expect(root.querySelectorAll('.tree-node-more')).toHaveLength(0);
    // the Workbench's strip names no copper wire (no circuit shows at all), and it unlocks nothing to show
    const bench = root.querySelector('.tree-node[data-node="@workbench"]');
    expect(bench.querySelector('.tree-unlocks')).toBeNull();
    expect(bench.querySelectorAll('.tree-needs .tree-mini')).toHaveLength(5);
    expect(bench.querySelectorAll('.tree-needs .tree-mini').map((m) => m.title).join(' ')).not.toMatch(/wire/i);
    expect(bench.title).not.toMatch(/wire/i);
    // on again: the Lab is back
    ui.refresh({ ...start, had: all, circuits: true });
    expect(root.querySelectorAll('.tree-col-head')).toHaveLength(6);
    expect(root.querySelector('.tree-node[data-node="relay"]')).toBeNull(); // devices are the Lab's unlocks, not nodes
    expect(root.querySelector('.tree-node[data-node="voltaic_battery"]')).not.toBeNull();
  });

  it('§94.4: a workplace not in sight is a dim head and banner, even when early things in its column show', () => {
    const { ui, root } = setup();
    const empty = demoPackView().slots.map((s) => (s && s.k === 'handbook' ? s : null));
    // rock, sticks and plant fibre picked up: the fire drill (in the Workbench's column) shows, the Workbench does not come forward
    ui.open({ ...demoPackView(), slots: empty, wear: [null, null, null], ready: ['cord', 'hammerstone'], had: ['handbook', 'rock', 'stick', 'plant_fibre'] });
    ui.openTree();
    const col = (s) => root.querySelector(`.tree-col.ws-${s}`);
    const head = (s) => root.querySelector(`.tree-node[data-node="@${s}"]`);
    expect(root.querySelector('.tree-node[data-node="fire_drill"]')).not.toBeNull();
    expect(col('workbench').classList.contains('unreached')).toBe(false); // its column shows the fire drill …
    expect(col('workbench').classList.contains('veiled')).toBe(true); // … under a dim banner
    expect(head('workbench').classList.contains('veiled')).toBe(true);
    expect(col('kiln').classList.contains('unreached')).toBe(true);
    expect(head('kiln').classList.contains('veiled')).toBe(true);
    // a stone axe had: the Work Stump is in sight, its head and banner lit
    ui.refresh({ ...demoPackView(), slots: empty, wear: [null, null, null], ready: [], had: ['handbook', 'rock', 'stick', 'plant_fibre', 'cord', 'hammerstone', 'stone_axe'] });
    expect(head('stump').classList.contains('veiled')).toBe(false);
    expect(col('stump').classList.contains('veiled')).toBe(false);
    expect(head('workbench').classList.contains('veiled')).toBe(true);
  });

  it('§94.4: drawing the tree again as it grows adds no listeners; its clicks and hovers still work, and dispose removes them', () => {
    const { ui, root } = setup();
    const start = { ...demoPackView(), slots: demoPackView().slots.map((s) => (s && s.k === 'handbook' ? s : null)), wear: [null, null, null],
      ready: [], had: ['handbook'], circuits: true };
    ui.open(start);
    ui.openTree();
    const tree = root.querySelector('.build-tree');
    const add = vi.spyOn(FakeElement.prototype, 'addEventListener');
    const grow = [['rock', 'stick', 'plant_fibre'], ['cord', 'hammerstone'], ['stone_axe'], ['flint_knife', 'oak_log'], ['work_stump', 'clay_lump']];
    const had = ['handbook'];
    const canvases = new Set([root.querySelector('.tree-canvas')]);
    for (const step of grow) {
      had.push(...step);
      ui.refresh({ ...start, had: [...had] });
      canvases.add(root.querySelector('.tree-canvas'));
    }
    expect(canvases.size).toBe(grow.length + 1); // drawn again each time …
    expect(add).not.toHaveBeenCalled(); // … with no listener added
    add.mockRestore();
    // the delegated listeners on the tree: hover lights a node's links, the back button goes to Making, a node searches
    const axe = root.querySelector('.tree-node[data-node="stone_axe"]');
    fire(axe.querySelector('.tree-label'), 'mouseover');
    expect(root.querySelectorAll('.tree-edge.hot').length).toBeGreaterThan(0);
    fire(tree, 'mouseleave');
    expect(root.querySelectorAll('.tree-edge.hot')).toHaveLength(0);
    root.querySelector('.tree-close').click();
    expect(ui.isTreeOpen()).toBe(false);
    ui.openTree();
    root.querySelector('.tree-node[data-node="stone_axe"] .tree-label').click();
    expect(ui.isTreeOpen()).toBe(false);
    expect(root.querySelector('.making-search').value).toBe('Stone Axe');
    ui.dispose();
    for (const type of ['click', 'mouseover', 'mouseleave']) expect(tree.listenerCount(type), type).toBe(0);
  });

  it('§94.4: the reveal signature changes with what is shown, the columns and the circuits', () => {
    const m = buildTreeModel();
    const st = (have) => treeStates(m, { count: (k) => (have.includes(k) ? 1 : 0), hasTool: () => false, canMake: () => false, near: () => false });
    const a = revealSignature(m, revealTree(m, { states: st([]), had: [] }));
    expect(revealSignature(m, revealTree(m, { states: st([]), had: ['handbook'] }))).toBe(a);
    expect(revealSignature(m, revealTree(m, { states: st(['cord']), had: [] }))).not.toBe(a);
    const off = buildTreeModel({ circuits: false });
    expect(revealSignature(off, revealTree(off, { states: treeStates(off, { count: () => 0, hasTool: () => false, canMake: () => false, near: () => false }) }))).not.toBe(a);
  });

  it('works without #pack-screen in the page (creates it)', () => {
    const doc = documentFromHTML('<div id="hud"></div>');
    const icons = { draw: vi.fn(), canvas: vi.fn(() => doc.createElement('canvas')) };
    const ui = createPackUI(/** @type {any} */ (doc), /** @type {any} */ (icons));
    ui.open(demoPackView());
    expect(doc.getElementById('pack-screen')).toBeTruthy();
    expect(() => createPackUI(/** @type {any} */ (null), /** @type {any} */ (icons))).toThrow(TypeError);
  });
});
