// Unit tests for the survival parts of src/menus.js (docs/DESIGN-survival.md §9.8, §1.1, §1.5, §2.5): the pause menu's
// Mode switch, Undo in Survival, confirm() on the old delete dialog, the death screen, and the reworded controls sheet.
// The menus run on a fake DOM built from index.html (tests/helpers/fakeDom.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createMenus, undoButtonLabel, CONTROLS_SHEET, deathCombCells, deathCombExtent, DEATH_COMB_RINGS, DEATH_COMB_CELL,
  DEATH_COMB_CLOSE_S, DEATH_COMB_FADE_S,
  GAME_MODES, WAKE_LABEL, DEATH_QUIT_LABEL,
} from '../../src/menus.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const atlas = /** @type {any} */ ({ width: 256, height: 256 });
const PHYSICS = { switches: { falling: true, water: true, collapse: true, explosions: true }, canUndo: true, undoKind: 'explosion' };

/** @param {Record<string, Function>} [callbacks] */
function setup(callbacks = {}) {
  const doc = documentFromHTML(html);
  const menus = createMenus(/** @type {any} */ (doc), atlas, /** @type {any} */ (callbacks));
  return { doc, menus, $: (id) => /** @type {any} */ (doc.getElementById(id)) };
}

beforeEach(() => {
  // the atlas helpers need a real canvas; menus reports that once with console.warn and carries on
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Mode switch [ Creative | Survival ]', () => {
  it('has two halves in the #pause-mode row, after Creatures', () => {
    const { $ } = setup();
    const row = $('pause-mode');
    expect(row.classList.contains('physics-row')).toBe(true);
    expect($('btn-mode').parentNode).toBe(row);
    const panel = row.parentNode;
    expect(panel.children.indexOf(row)).toBe(panel.children.indexOf($('pause-creatures')) + 1);
    expect($('btn-mode').children.map((b) => b.id)).toEqual(['btn-mode-creative', 'btn-mode-survival']);
    expect(GAME_MODES).toEqual(['creative', 'survival']);
  });

  it('the active half is filled (class active) and aria-pressed; setModeState moves it', () => {
    const { menus, $ } = setup();
    const c = $('btn-mode-creative');
    const s = $('btn-mode-survival');
    expect(menus.getModeState()).toBe('creative');
    expect([c.getAttribute('aria-pressed'), s.getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    expect(c.classList.contains('active')).toBe(true);
    menus.setModeState('survival');
    expect([c.getAttribute('aria-pressed'), s.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    expect(s.classList.contains('active')).toBe(true);
    expect(c.classList.contains('active')).toBe(false);
    expect($('btn-mode').dataset.mode).toBe('survival');
    menus.setModeState(/** @type {any} */ ('garbage'));
    expect(menus.getModeState()).toBe('creative');
  });

  it('only the inactive half fires onModeSelect', () => {
    const onModeSelect = vi.fn();
    const { menus, $ } = setup({ onModeSelect });
    $('btn-mode-creative').click();
    expect(onModeSelect).not.toHaveBeenCalled();
    $('btn-mode-survival').click();
    expect(onModeSelect).toHaveBeenCalledWith('survival');
    menus.setModeState('survival');
    onModeSelect.mockClear();
    $('btn-mode-survival').click();
    expect(onModeSelect).not.toHaveBeenCalled();
    $('btn-mode-creative').click();
    expect(onModeSelect).toHaveBeenCalledWith('creative');
  });
});

describe('Undo in Survival (§1.5)', () => {
  it('undoButtonLabel says "not in Survival" whatever there is to undo', () => {
    expect(undoButtonLabel(true, 'explosion', true)).toBe('Undo (not in Survival)');
    expect(undoButtonLabel(false, undefined, true)).toBe('Undo (not in Survival)');
    expect(undoButtonLabel(true, 'explosion')).toBe('Undo Last Explosion');
    expect(undoButtonLabel(true, 'explosion', false)).toBe('Undo Last Explosion');
    expect(undoButtonLabel(false)).toBe('Undo (nothing to undo)');
  });

  it('the pause menu disables #btn-undo-physics in Survival and onUndoPhysics never fires', () => {
    const onUndoPhysics = vi.fn();
    const { menus, $ } = setup({ onUndoPhysics });
    menus.showPause(42, { ...PHYSICS, survival: true }, 'World 1');
    const undo = $('btn-undo-physics');
    expect(undo.disabled).toBe(true);
    expect(undo.textContent).toBe('Undo (not in Survival)');
    undo.click();
    expect(onUndoPhysics).not.toHaveBeenCalled();
    menus.setPhysicsState({ ...PHYSICS, survival: false });
    expect(undo.disabled).toBe(false);
    expect(undo.textContent).toBe('Undo Last Explosion');
    undo.click();
    expect(onUndoPhysics).toHaveBeenCalledTimes(1);
  });
});

describe('confirm()', () => {
  it('resets #confirm-yes / #confirm-no and the danger class on every call', async () => {
    const { menus, $ } = setup();
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    expect(yes.classList.contains('danger')).toBe(true); // index.html's delete dialog
    const p1 = menus.confirm({ title: 'Bring survival resources into this world?', detail: 'This cannot be undone.', yes: 'Bring them', no: 'Cancel' });
    expect($('confirm-dialog').classList.contains('hidden')).toBe(false);
    expect($('confirm-text').textContent).toBe('Bring survival resources into this world?');
    expect($('confirm-detail').textContent).toBe('This cannot be undone.');
    expect(yes.textContent).toBe('Bring them');
    expect(no.textContent).toBe('Cancel');
    expect(yes.classList.contains('danger')).toBe(false);
    expect(menus.isConfirmOpen()).toBe(true);
    yes.click();
    await expect(p1).resolves.toBe(true);
    expect(menus.isConfirmOpen()).toBe(false);
    expect($('confirm-dialog').classList.contains('hidden')).toBe(true);
    const p2 = menus.confirm({ title: 'Really?', danger: true });
    expect(yes.textContent).toBe('OK');
    expect(no.textContent).toBe('Cancel');
    expect(yes.classList.contains('danger')).toBe(true);
    no.click();
    await expect(p2).resolves.toBe(false);
  });

  it('resolves false on hidePause(), showTitle(), Esc, the backdrop, and a newer question', async () => {
    const { menus, $ } = setup();
    menus.showPause(1, PHYSICS, 'W');
    const a = menus.confirm({ title: 'A' });
    menus.hidePause();
    await expect(a).resolves.toBe(false);
    expect($('confirm-dialog').classList.contains('hidden')).toBe(true);
    const b = menus.confirm({ title: 'B' });
    menus.showTitle([], {});
    await expect(b).resolves.toBe(false);
    const c = menus.confirm({ title: 'C' });
    fire($('confirm-dialog'), 'keydown', { key: 'Escape' });
    await expect(c).resolves.toBe(false);
    const d = menus.confirm({ title: 'D' });
    fire($('confirm-dialog'), 'click', { target: $('confirm-dialog') });
    await expect(d).resolves.toBe(false);
    const e = menus.confirm({ title: 'E' });
    const f = menus.confirm({ title: 'F' });
    await expect(e).resolves.toBe(false);
    expect($('confirm-text').textContent).toBe('F');
    $('confirm-yes').click();
    await expect(f).resolves.toBe(true);
    menus.dispose();
    await expect(menus.confirm({ title: 'after dispose' })).resolves.toBe(false);
  });

  it('the world delete flow runs on it: "Delete" in the danger colour, onDeleteWorld only on yes', () => {
    const onDeleteWorld = vi.fn();
    const { menus, $ } = setup({ onDeleteWorld });
    const slots = [{ slot: 1, status: 'world', name: 'Castle', seed: 7, createdAt: 1, lastPlayed: 2, bytes: 100, legacy: false }];
    menus.showTitle(slots, { now: 10 });
    menus.confirm({ title: 'something else', yes: 'Fine' }); // a different question first: Delete must reset the labels
    $('worlds-list').querySelector('button[data-action="delete"]').click();
    expect($('confirm-text').textContent).toBe('Delete “Castle”?');
    expect($('confirm-yes').textContent).toBe('Delete');
    expect($('confirm-yes').classList.contains('danger')).toBe(true);
    $('confirm-no').click();
    expect(onDeleteWorld).not.toHaveBeenCalled();
    $('worlds-list').querySelector('button[data-action="delete"]').click();
    $('confirm-yes').click();
    expect(onDeleteWorld).toHaveBeenCalledWith(1); // synchronously, as before
  });
});

describe('the death screen (§2.5)', () => {
  it('shows the cause, the detail and where the belongings lie; hides "where" when they were lost', () => {
    const { menus, $ } = setup();
    expect($('death-screen').classList.contains('hidden')).toBe(true);
    menus.showDeath('The ground came up too fast.', 'Your belongings lie where you fell.', 'Your belongings lie at q 120, r −40, height 63.');
    expect($('death-screen').classList.contains('hidden')).toBe(false);
    expect($('death-screen').classList.contains('closing')).toBe(true);
    expect(menus.isDeathOpen()).toBe(true);
    expect($('death-title').textContent).toBe('The ground came up too fast.');
    expect($('death-detail').textContent).toBe('Your belongings lie where you fell.');
    expect($('death-where').classList.contains('hidden')).toBe(false);
    menus.showDeath('Swallowed by a black hole.', 'Your belongings are lost.');
    expect($('death-where').classList.contains('hidden')).toBe(true);
    menus.hideDeath();
    expect($('death-screen').classList.contains('hidden')).toBe(true);
    expect(menus.isDeathOpen()).toBe(false);
  });

  it('has no "You died!" headline, a hex "Wake up" and a small "Save & quit" link wired to their callbacks', () => {
    const onWake = vi.fn();
    const onDeathQuit = vi.fn();
    const { menus, doc, $ } = setup({ onWake, onDeathQuit });
    menus.showDeath('Buried alive.', 'Your belongings lie where you fell.');
    expect($('death-screen').textContent).not.toMatch(/you died/i);
    expect($('btn-wake').textContent).toBe(WAKE_LABEL);
    expect($('btn-wake').classList.contains('hex-button')).toBe(true);
    expect($('btn-death-quit').textContent).toBe(DEATH_QUIT_LABEL);
    expect($('btn-death-quit').classList.contains('text-link')).toBe(true);
    expect(doc.activeElement).toBe($('btn-wake'));
    $('btn-wake').click();
    expect(onWake).toHaveBeenCalledTimes(1);
    $('btn-death-quit').click();
    expect(onDeathQuit).toHaveBeenCalledTimes(1);
    // no .mc-button or .picker-panel anywhere in it (§11)
    expect($('death-screen').querySelectorAll('.mc-button, .picker-panel').length).toBe(0);
  });

  it('the honeycomb closes ring by ring from the outside in, within 1.2 s, and covers the whole window', () => {
    const cells = deathCombCells();
    const maxRing = Math.max(...cells.map((c) => c.ring));
    expect(maxRing).toBeGreaterThan(DEATH_COMB_RINGS); // the corners of a wide window lie beyond the inscribed rings
    const centre = cells.filter((c) => c.ring === 0);
    expect(centre).toHaveLength(1);
    expect(centre[0].delay).toBeCloseTo(DEATH_COMB_CLOSE_S - DEATH_COMB_FADE_S, 9);
    expect(cells.filter((c) => c.ring === maxRing).every((c) => c.delay === 0)).toBe(true);
    for (const c of cells) expect(c.delay + DEATH_COMB_FADE_S).toBeLessThanOrEqual(DEATH_COMB_CLOSE_S + 1e-9);
    // a ring never starts before the ring outside it, and every ring between the centre and the corners is there
    for (let r = 1; r <= maxRing; r++) {
      const inner = cells.find((c) => c.ring === r - 1);
      const outerRing = cells.find((c) => c.ring === r);
      expect(outerRing, `ring ${r}`).toBeTruthy();
      expect(inner.delay).toBeGreaterThan(outerRing.delay);
    }
    // the comb has no holes over the viewBox: every point (corners and edges included) is within a cell's circumradius
    const [halfW, halfH] = deathCombExtent();
    for (let x = -halfW; x <= halfW; x += halfW / 8) {
      for (const y of [-halfH, -halfH / 2, 0, halfH / 2, halfH]) {
        const d = Math.min(...cells.map((c) => Math.hypot(c.x - x, c.y - y)));
        expect(d, `point ${x},${y}`).toBeLessThanOrEqual(DEATH_COMB_CELL + 1e-9);
      }
    }
    const { menus, $ } = setup();
    menus.showDeath('x', 'y');
    expect($('death-comb').getAttribute('viewBox')).toBe(`${-halfW} ${-halfH} ${2 * halfW} ${2 * halfH}`);
    expect($('death-comb').getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
    const rings = $('death-comb').querySelectorAll('.comb-ring');
    expect(rings).toHaveLength(maxRing + 1);
    expect(rings[0].getAttribute('data-ring')).toBe(String(maxRing)); // outermost first
    expect(rings[0].getAttribute('style')).toBe('animation-delay:0s');
    expect($('death-comb').querySelectorAll('polygon')).toHaveLength(cells.length);
    menus.showDeath('again', 'y'); // built once
    expect($('death-comb').querySelectorAll('.comb-ring')).toHaveLength(maxRing + 1);
  });
});

describe('the controls sheet (§9.8)', () => {
  it('still 17 rows, with the survival wording (RMB and R merged with the circuits wording, DESIGN-circuits §7.1)', () => {
    expect(CONTROLS_SHEET).toHaveLength(17);
    const row = (k) => CONTROLS_SHEET.find(([key]) => key === k)?.[1];
    expect(row('LMB')).toBe('Break block (hold) · Survival: hold to dig');
    expect(row('RMB')).toBe('Place · right-click works switches, timers, plungers (Shift: place) · Survival: use the item in hand');
    expect(row('E')).toBe('Blocks · Survival: pack & making');
    expect(row('R')).toBe('R key: use a switch, timer, fuse, radio key or rune · Survival: fire, water, plants, basket');
    expect(row('Space Space')).toBe('Double-tap: fly (or F) · Creative');
  });
});

describe('§14 the Guide buttons (title screen and pause menu)', () => {
  it('a Guide .hex-button under the title screen\'s controls sheet, and one in the pause menu after the Mode row', () => {
    const { $ } = setup();
    const title = $('btn-guide-title');
    const pause = $('btn-guide-pause');
    for (const b of [title, pause]) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.classList.contains('hex-button')).toBe(true);
      expect(b.classList.contains('mc-button')).toBe(false);
      expect(b.textContent).toBe('Survival Guide');
    }
    // beside the controls sheet: the sheet and the button share the title's second column
    const side = title.parentNode;
    expect(side.classList.contains('title-side')).toBe(true);
    expect(side.children.indexOf($('title-controls'))).toBe(side.children.indexOf(title) - 1);
    expect(side.parentNode.classList.contains('title-main')).toBe(true);
    // in the pause menu after the Mode row and the circuits' Devices row (DESIGN-circuits §7.1: the Guide right above Save &
    // Quit, then Mode, then Devices after Creatures)
    const panel = pause.parentNode;
    expect(panel.children.indexOf(pause)).toBeGreaterThan(panel.children.indexOf($('pause-mode')));
    expect(panel.children.indexOf(pause)).toBe(panel.children.indexOf($('pause-devices')) + 1);
    expect(panel.children.indexOf(pause)).toBe(panel.children.indexOf($('btn-quit')) - 1);
  });

  it('each fires onGuide with where it was pressed, in either mode', () => {
    const onGuide = vi.fn();
    const { menus, $ } = setup({ onGuide });
    fire($('btn-guide-title'), 'click');
    expect(onGuide).toHaveBeenLastCalledWith('title');
    menus.hideTitle();
    menus.showPause(7);
    for (const mode of ['creative', 'survival']) {
      menus.setModeState(/** @type {any} */ (mode));
      fire($('btn-guide-pause'), 'click');
      expect(onGuide).toHaveBeenLastCalledWith('pause');
    }
    expect(onGuide).toHaveBeenCalledTimes(3);
  });

  it('without an onGuide callback the buttons do nothing (and throw nothing)', () => {
    const { $ } = setup();
    expect(() => fire($('btn-guide-title'), 'click')).not.toThrow();
    expect(() => fire($('btn-guide-pause'), 'click')).not.toThrow();
  });
});
