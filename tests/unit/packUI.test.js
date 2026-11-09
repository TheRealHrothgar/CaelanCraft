// Unit tests for src/packUI.js (docs/DESIGN-survival.md §5.4, §9.8): the pure geometry (rosetteCells ordering, the zig-zag
// strip, card layout) and label formatters, and — on a fake DOM — that the screen draws a view and forwards raw clicks.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  rosetteCells, ringsFor, hexToPixel, stripCells, cardLayout, formatSeconds, haveNeedText, haveNeedLevel, countLabel,
  durabilityText, stackTitle, recipeTitle, stationHint, stationName, tabLabel, jobStatusText, toolLabel, toolIconKey,
  filterRecipes, demoPackView, createPackUI, STATION_TABS, CELL_S,
} from '../../src/packUI.js';
import { PACK_SLOTS, HOTBAR_SIZE, BASKET_SLOTS, REMAINS_SLOTS } from '../../src/config.js';
import { isItemKey } from '../../src/items.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

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
    expect(STATION_TABS.map(([, l]) => l)).toEqual(['All', 'Hands', 'Stump', 'Kiln', 'Bloomery', 'Forge']);
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
    expect(toolIconKey('axe', 1)).toBe('stone_chopper');
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
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Hands', 'Stump', 'Kiln', 'Bloomery', 'Forge']);
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
    const cord = root.querySelector('.recipe-card[data-recipe="cord"]');
    expect(cord.classList.contains('craftable')).toBe(true);
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
    expect(root.querySelectorAll('.recipe-card').map((c) => c.dataset.recipe)).toEqual(['leather', 'split_sticks']);
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

  it('works without #pack-screen in the page (creates it)', () => {
    const doc = documentFromHTML('<div id="hud"></div>');
    const icons = { draw: vi.fn(), canvas: vi.fn(() => doc.createElement('canvas')) };
    const ui = createPackUI(/** @type {any} */ (doc), /** @type {any} */ (icons));
    ui.open(demoPackView());
    expect(doc.getElementById('pack-screen')).toBeTruthy();
    expect(() => createPackUI(/** @type {any} */ (null), /** @type {any} */ (icons))).toThrow(TypeError);
  });
});
