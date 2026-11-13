// Regression tests for src/styles.css — the title screen's Worlds panel (§41) and controls sheet must fit the 1280x720
// reference viewport used by scripts/smoke-windows-chrome.sh and docs/PLAN-build.md §3, and the fixed menu layers
// must be able to scroll on shorter viewports (body{overflow:hidden} means nothing else can).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTROLS_SHEET } from '../../src/menus.js';
import { BLOCK, BLOCKS } from '../../src/blocks.js';
import { SAVE_SLOTS, HOTBAR_SIZE } from '../../src/config.js';
import { ITEMS } from '../../src/items.js';
import { PARTS, isPart, partTip } from '../../src/circuitParts.js';
import { buildPickerModel, familyLine, PICKER_COL_W, PICKER_ROW_H } from '../../src/pickerModel.js';
import { createDevicePanel, panelFields, PANEL_KEYS_HINT, ACTION_LABELS } from '../../src/devicePanel.js';
import { makeCircuitWorld, FLOOR } from '../helpers/circuitWorld.js';
import { buildChapters } from '../../src/handbook.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const css = readFileSync(fileURLToPath(new URL('../../src/styles.css', import.meta.url)), 'utf8');

/**
 * Declarations of the first rule whose selector list is exactly `selector` (comments stripped).
 * @param {string} selector
 * @returns {Map<string, string>} property -> value
 */
function decls(selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(stripped)); ) {
    if (m[1].trim() !== selector) continue;
    const out = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    return out;
  }
  throw new Error(`no rule for ${selector}`);
}

/** @param {string} v e.g. "6vh" or "24px" @param {number} viewportH */
function toPx(v, viewportH) {
  const m = /^(-?[\d.]+)(px|vh)$/.exec(v);
  if (!m) throw new Error(`unsupported length ${v}`);
  return m[2] === 'vh' ? (Number(m[1]) * viewportH) / 100 : Number(m[1]);
}

describe('styles.css title screen', () => {
  const VIEWPORT_H = 720;
  const title = decls('#title-screen');

  it('fixed menu layers can scroll if their content is taller than the viewport', () => {
    expect(title.get('overflow-y')).toBe('auto');
    expect(decls('#pause-menu').get('overflow-y')).toBe('auto');
  });

  it('the splash text tracks the title padding through --title-top', () => {
    expect(title.get('padding-top')).toBe('var(--title-top)');
    expect(decls('#splash-text').get('top')).toContain('var(--title-top)');
  });

  // §41: the title shows the Worlds panel (SAVE_SLOTS rows, the storage usage bar, a status line) BESIDE the cheat sheet.
  // Measured in headless Chrome at the 1280x720 reference window (a 1258x622 viewport under --dump-dom): logo 25..153,
  // panel 181..591 (410px tall, 640px wide), sheet 181..553 (503px wide), rows 50px.
  const first = (v) => toPx(/** @type {string} */ (v).split(/\s+/)[0], VIEWPORT_H);
  const panel = decls('.worlds-panel');
  const sheet = decls('.controls-sheet');
  /** Height of the Worlds panel with every row closed. */
  function worldsPanelHeight() {
    const [padY] = /** @type {string} */ (panel.get('padding')).split(/\s+/).map((v) => toPx(v, VIEWPORT_H));
    const border = first(panel.get('border'));
    const HEAD = 23 + first(decls('.worlds-head').get('margin-bottom')); // the 20px bold "Worlds" line ≈ 23px
    const row = first(decls('.world-slot').get('min-height'));
    const gap = first(decls('#worlds-list').get('gap'));
    const USAGE = first(decls('.usage-row').get('margin-top')) + 14; // the 14px bar (10px + 2px borders) sets the line
    const message = decls('.worlds-message');
    const MESSAGE = first(message.get('margin-top')) + first(message.get('min-height'));
    return 2 * border + 2 * padY + HEAD + SAVE_SLOTS * row + (SAVE_SLOTS - 1) * gap + USAGE + MESSAGE;
  }
  /** Lines a description takes in the sheet's 58-character column (greedy word wrap, as the browser does). @param {string} text */
  function sheetLines(text) {
    const cols = Number(/minmax\(0,(\d+)ch\)/.exec(/** @type {string} */ (sheet.get('grid-template-columns')))?.[1]);
    let lines = 1;
    let len = 0;
    for (const word of text.split(' ')) {
      const add = len === 0 ? word.length : len + 1 + word.length;
      if (add > cols && len > 0) {
        lines++;
        len = word.length;
      } else len = add;
    }
    return lines;
  }
  function sheetHeight() {
    const rowGap = first(sheet.get('gap'));
    // One <kbd> row: 12px bold text + 1px padding x2 + 1px top border + 3px bottom border ≈ 20px; a description that wraps
    // takes 15px a line (13px monospace, normal line height; measured: 30px for two).
    const ROW = 20;
    const LINE = 15;
    const rows = CONTROLS_SHEET.length;
    let total = (rows - 1) * rowGap;
    for (const [, text] of CONTROLS_SHEET) total += Math.max(ROW, sheetLines(text) * LINE);
    return total;
  }

  it('the Worlds panel model matches the measured layout', () => {
    expect(SAVE_SLOTS).toBe(6);
    expect(worldsPanelHeight()).toBe(410);
    expect(CONTROLS_SHEET.length).toBe(17); // v0.3 added the console (T /), R and Shift+R rows
    // DESIGN-circuits §7.1: the RMB and R rows carry the circuits and survival wording and wrap onto a second line
    expect(sheet.get('grid-template-columns')).toBe('auto minmax(0,58ch)');
    expect(CONTROLS_SHEET.filter(([, text]) => sheetLines(text) > 1).map(([k]) => k)).toEqual(['RMB', 'R']);
    expect(sheetHeight()).toBe(392); // measured in headless Chrome at 1280x720: 392px
  });

  it('logo + the Worlds panel beside the full controls sheet fit the 1280x720 reference window (622px viewport too)', () => {
    for (const H of [720, 622]) {
      const paddingTop = toPx(/** @type {string} */ (title.get('--title-top')), H);
      // #title-logo is the 200x32 canvas at width:min(800px,90vw) -> 800px wide at 1280 -> 128px tall.
      const logo = (800 * 32) / 200;
      const mainTop = first(decls('.title-main').get('margin-top'));
      const column = Math.max(first(panel.get('margin-top')) + worldsPanelHeight(), first(sheet.get('margin-top')) + sheetHeight());
      expect(paddingTop + logo + mainTop + column, `viewport ${H}px`).toBeLessThanOrEqual(H);
    }
  });

  it('the panel and the sheet sit side by side in the 1258px-wide reference viewport, and stack in narrower windows', () => {
    const main = decls('.title-main');
    expect(main.get('flex-wrap')).toBe('wrap');
    const panelW = Number(/^min\((\d+)px,100%\)$/.exec(/** @type {string} */ (panel.get('width')))?.[1]);
    expect(panelW).toBe(640);
    const columnGap = toPx(/** @type {string} */ (main.get('gap')).split(/\s+/)[1], VIEWPORT_H);
    const padX = toPx(/** @type {string} */ (main.get('padding')).split(/\s+/)[1], VIEWPORT_H);
    const SHEET_W = 518; // measured 517.1: an 86.6px key column, 16px gap and the 58ch (414.5px) description column
    expect(2 * padX + panelW + columnGap + SHEET_W).toBeLessThanOrEqual(1258);
    // rows wrap their buttons under the name rather than overflowing a phone-width panel
    expect(decls('.world-slot').get('flex-wrap')).toBe('wrap');
    expect(decls('.slot-actions').get('flex-wrap')).toBe('wrap');
  });
});

/** A px / vh length, calc() of px / vh terms joined by + and −, or max() of those, in px for a viewport height. */
function lengthPx(v, viewportH) {
  const mx = /^(?:max|min)\((.*)\)$/.exec(v);
  if (mx) {
    // split on the top-level commas only (calc() arguments have none here, but keep it honest)
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < mx[1].length; i++) {
      const ch = mx[1][i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(mx[1].slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(mx[1].slice(start).trim());
    const values = parts.map((p) => lengthPx(p, viewportH));
    return v.startsWith('min(') ? Math.min(...values) : Math.max(...values);
  }
  const m = /^calc\((.*)\)$/.exec(v);
  if (!m) return toPx(v, viewportH);
  let total = 0;
  for (const [, sign, term] of m[1].matchAll(/([+-]?)\s*([\d.]+(?:px|vh))/g)) total += (sign === '-' ? -1 : 1) * toPx(term, viewportH);
  return total;
}

describe('styles.css block picker (DESIGN-circuits §5.4, §5.10)', () => {
  // Pixels from the viewport bottom to the hotbar's visible top: 8px offset, 40px slot + 3px padding + 2px border on
  // each side, 2px box-shadow (the hotbar stays visible and clickable while the picker is open).
  const hotbar = decls('#hotbar');
  const HOTBAR_CLEARANCE = toPx(hotbar.get('bottom'), 0) + toPx(decls('.hotbar-slot').get('height'), 0)
    + 2 * toPx(hotbar.get('padding'), 0) + 2 * 2 + 2;
  const layer = decls('#block-picker');
  const panel = decls('.picker-panel');
  const scroll = decls('#picker-scroll');
  const ONE_ROW = 64; // one row of 56px slots, with the shadow under them and the badges over their corners
  const panelBottom = (H) => lengthPx(layer.get('padding-top'), H) + lengthPx(panel.get('max-height'), H) + 2; // + 2px shadow

  it('the panel ends above the hotbar for heights 274–1440 (an 800x480 window included); its height never exceeds that bound', () => {
    expect(HOTBAR_CLEARANCE).toBe(60);
    expect(panel.get('box-sizing')).toBe('border-box'); // max-height covers the border and padding
    expect(panel.get('max-height')).toBe('max(180px,calc(100vh - 8vh - 72px))');
    for (const H of [274, 300, 382, 480, 502, 600, 622, 720, 1080, 1440]) {
      expect(panelBottom(H), `viewport ${H}px`).toBeLessThanOrEqual(H - HOTBAR_CLEARANCE - 8);
      // the fixed height (so a search never makes the panel jump) stays within the max-height
      expect(lengthPx(panel.get('height'), H), `viewport ${H}px`).toBeLessThanOrEqual(lengthPx(panel.get('max-height'), H));
    }
    expect(panel.get('width')).toBe('min(980px,calc(100vw - 48px))'); // W0's 980px, kept
  });

  it('the panel is a flex column; only the body grows and shrinks; #picker-scroll scrolls and keeps one row', () => {
    expect(panel.get('display')).toBe('flex');
    expect(panel.get('flex-direction')).toBe('column');
    const body = decls('.picker-body');
    expect(body.get('flex')).toBe('1 1 auto');
    expect(body.get('min-height')).toBe('0');
    expect(decls('.picker-head').get('flex')).toBe('0 0 auto');
    expect(decls('.picker-foot').get('flex')).toBe('0 0 auto');
    expect(scroll.get('overflow-y')).toBe('auto');
    expect(lengthPx(scroll.get('min-height'), 0)).toBeGreaterThanOrEqual(ONE_ROW);
    expect(scroll.get('overscroll-behavior')).toBe('contain');
    expect(scroll.get('scrollbar-color')).toBe('#e8b04a #2a2633');
    expect(scroll.get('position')).toBe('relative'); // the sections' offsetTop is measured from it (the rail's jumps)
    expect(decls('#picker-rail').get('flex')).toBe('0 0 40px');
  });

  it('the head and the foot fit in the 180px minimum panel with one row (the tip and the hint fold away in short windows)', () => {
    const border = toPx(/** @type {string} */ (panel.get('border')).split(/\s+/)[0], 0);
    const pad = toPx(/** @type {string} */ (panel.get('padding')), 0);
    const gap = toPx(/** @type {string} */ (panel.get('gap')), 0);
    const chrome = 2 * border + 2 * pad + 2 * gap;
    const head = toPx(/** @type {string} */ (decls('.picker-head').get('height')), 0);
    const foot = decls('.picker-foot');
    const footTop = toPx(/** @type {string} */ (foot.get('padding-top')), 0) + 1; // + the 1px rule
    const lineH = (sel) => Number(/\/(\d+)px/.exec(/** @type {string} */ (decls(sel).get('font')))?.[1]);
    const name = lineH('#picker-name');
    const blurb = toPx(/** @type {string} */ (decls('#picker-blurb').get('height')), 0); // two lines, reserved
    const hint = lineH('.picker-hint');
    const footGap = toPx(/** @type {string} */ (foot.get('gap')), 0);
    expect([name, blurb, hint]).toEqual([18, 30, 15]);
    expect(decls('.picker-hint').get('white-space')).toBe('nowrap'); // one line, however narrow
    // the compact foot (name only) under the media query's height, the full one above it
    const m = /@media \(max-height:(\d+)px\)\{#picker-blurb,\.picker-hint\{display:none\}\}/.exec(css);
    expect(m).toBeTruthy();
    const fold = Number(/** @type {RegExpExecArray} */ (m)[1]);
    const compact = chrome + head + footTop + name + ONE_ROW;
    const full = chrome + head + footTop + name + footGap + blurb + footGap + hint + ONE_ROW;
    expect(compact).toBeLessThanOrEqual(180);
    for (const H of [120, 202, 240, 273, fold]) expect(compact, `viewport ${H}`).toBeLessThanOrEqual(lengthPx(panel.get('max-height'), H));
    for (const H of [fold + 1, 360, 480, 622]) expect(full, `viewport ${H}`).toBeLessThanOrEqual(lengthPx(panel.get('max-height'), H));
  });

  it('the slots: plain 56px rounded squares 6px apart (the model\'s 62px columns and rows); sticky honey section headers', () => {
    const cell = decls('.picker-cell');
    expect([cell.get('width'), cell.get('height'), cell.get('border-radius')]).toEqual(['56px', '56px', '12px']);
    expect(cell.has('clip-path')).toBe(false);
    expect(cell.get('box-sizing')).toBe('border-box');
    const row = decls('.picker-row');
    expect([row.get('height'), row.get('gap')]).toEqual(['56px', '6px']);
    expect(decls('.picker-row + .picker-row').get('margin-top')).toBe('6px');
    expect(() => decls('.picker-row.indent')).toThrow(); // no indented rows any more
    // the CSS agrees with pickerModel: columns and rows are both 62px apart (pickerCols, ↑ / ↓, PageUp / PageDown)
    expect(toPx(/** @type {string} */ (cell.get('width')), 0) + toPx(/** @type {string} */ (row.get('gap')), 0)).toBe(PICKER_COL_W);
    expect(toPx(/** @type {string} */ (row.get('height')), 0) + 6).toBe(PICKER_ROW_H);
    expect(decls('.picker-icon').get('width')).toBe('48px');
    const head = decls('.picker-section-head');
    expect(head.get('position')).toBe('sticky');
    expect(head.get('top')).toBe('0');
    expect(head.get('background')).toBe('#1c1a24');
    expect(head.get('font-variant')).toBe('small-caps');
    expect(head.get('font')).toMatch(/^bold 18px/);
    expect(head.get('color')).toBe('#e8b04a');
    // the badge of a block already in the hotbar is a round honey dot; a family's count badge is round too
    expect(decls('.picker-badge').get('width')).toBe('20px');
    expect(decls('.picker-badge').get('border-radius')).toBe('50%');
    expect(decls('.picker-badge').get('background')).toBe('#e8b04a');
    expect(decls('.picker-cell.in-hotbar .picker-badge').get('display')).toBe('flex');
    expect(decls('.picker-count').get('border-radius')).toBe('9px');
    // the other icon holders are rounded squares too: the rail, the header chips, the drag ghost
    expect(decls('.picker-rail-btn').get('border-radius')).toBe('9px');
    expect(decls('.picker-section-icon').get('border-radius')).toBe('7px');
    expect(decls('.picker-ghost').get('border-radius')).toBe('10px');
    // the drawer: a rounded #241f2e tray with a honey edge, its slots lined up with the section's (its margin, border and
    // padding fill the grid's 8px side padding) and its notch at the tile's column, in the model's 62px steps
    const drawer = decls('.picker-drawer');
    expect(drawer.get('background')).toBe('#241f2e');
    expect(drawer.get('border')).toBe('2px solid #e8b04a');
    expect(drawer.get('border-radius')).toBe('14px');
    const side = (v, i) => toPx(/** @type {string} */ (v).split(/\s+/)[i], 0);
    const gridPad = side(decls('#picker-grid').get('padding'), 1);
    expect(gridPad).toBe(8);
    expect(side(drawer.get('margin'), 1)).toBe(-gridPad);
    expect(2 + side(drawer.get('padding'), 1)).toBe(gridPad);
    expect(decls('.picker-drawer::after').get('left')).toBe(`calc(var(--notch-col,0) * ${PICKER_COL_W}px + 26px)`);
    // the look: survival's palette, never the grey bevel
    expect(panel.get('background')).toBe('#1c1a24');
    expect(panel.get('border')).toBe('3px solid #e8b04a');
    expect(panel.get('color')).toBe('#f3ead8');
    expect(decls('.picker-hint').get('color')).toBe('#b9ad95');
    expect(decls('.picker-ghost').get('pointer-events')).toBe('none'); // elementFromPoint finds the hotbar slot under it
  });

  it('no rule of the picker or the device panel clips anything to a hexagon (the user: no icons on hexagons)', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let checked = 0;
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (!/picker|\.cc-|#device-panel/.test(sel)) continue;
      checked++;
      expect(m[2], sel).not.toMatch(/clip-path/);
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('the picker DOM (§5.9): the ids menus.js binds, the search placeholder and the hint', () => {
    const doc = documentFromHTML(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8'));
    for (const id of ['block-picker', 'picker-grid', 'picker-name', 'picker-search', 'picker-showall', 'picker-rail',
      'picker-scroll', 'picker-blurb']) expect(doc.getElementById(id), id).toBeTruthy();
    const $ = (id) => /** @type {any} */ (doc.getElementById(id));
    expect($('picker-search').getAttribute('type')).toBe('search');
    expect($('picker-search').getAttribute('placeholder')).toBe('Search blocks  ( / )');
    expect($('picker-showall').getAttribute('type')).toBe('checkbox');
    expect($('picker-scroll').contains($('picker-grid'))).toBe(true);
    expect($('block-picker').querySelector('.picker-hint').textContent)
      .toBe('Click: selected slot · 1–9: that slot · drag onto the hotbar · ▸ opens a family · / search · E / Esc: close');
    expect($('block-picker').querySelector('.picker-panel').getAttribute('role')).toBe('dialog');
  });
});

describe('styles.css circuits screens (DESIGN-circuits §4.10, §5.10, §6.2.16–§6.2.17)', () => {
  const z = (sel) => Number(decls(sel).get('z-index'));

  it('z-order: the picker 20; the device panel 24, the rune editor\'s layer, over the HUD and the console, under the pause menu', () => {
    expect(z('#block-picker')).toBe(20);
    expect(z('#device-panel')).toBe(24);
    expect(z('#device-panel')).toBe(z('#rune-editor'));
    expect(z('#device-panel')).toBeGreaterThan(z('#hud'));
    expect(z('#device-panel')).toBeGreaterThan(z('#console'));
    expect(z('#device-panel')).toBeLessThan(z('#pause-menu'));
  });

  it('#device-panel, the picker, #btn-circuits and #btn-blackholes hold no .mc-button; every button in #device-panel is a rounded .cc-btn', () => {
    const doc = documentFromHTML(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8'));
    for (const id of ['device-panel', 'block-picker', 'btn-circuits', 'btn-blackholes', 'pause-devices']) {
      const el = /** @type {any} */ (doc.getElementById(id));
      expect(el, id).toBeTruthy();
      expect(el.classList.contains('mc-button'), id).toBe(false);
      expect(el.querySelectorAll('.mc-button'), id).toHaveLength(0);
    }
    expect(/** @type {any} */ (doc.getElementById('device-panel')).querySelectorAll('.picker-panel')).toHaveLength(0);
    // the panel as devicePanel.js builds it, for every kind of part
    const panel = createDevicePanel(/** @type {any} */ (doc), {});
    const root = /** @type {any} */ (doc.getElementById('device-panel'));
    let buttons = 0;
    for (const id of Object.keys(PARTS).map(Number).filter((id) => isPart(id))) {
      const env = makeCircuitWorld();
      env.put(0, 0, id);
      env.ticks(1);
      panel.open(/** @type {*} */ (env.circuits.panelView(0, FLOOR, 0, true)));
      for (const b of root.querySelectorAll('button')) {
        expect(b.classList.contains('cc-btn'), `${id}: ${b.textContent}`).toBe(true);
        expect(b.classList.contains('hex-button'), `${id}: ${b.textContent}`).toBe(false);
        buttons++;
      }
      expect(root.querySelectorAll('.mc-button, .picker-panel')).toHaveLength(0);
    }
    expect(buttons).toBeGreaterThan(40);
    panel.dispose();
    // the Devices row keeps survival's text-only .hex-button halves (it sits under the Mode row and carries no icon)
    for (const id of ['btn-circuits-on', 'btn-circuits-off', 'btn-blackholes-on', 'btn-blackholes-off']) {
      expect(/** @type {any} */ (doc.getElementById(id)).classList.contains('hex-button'), id).toBe(true);
      expect(/** @type {any} */ (doc.getElementById(id)).querySelectorAll('canvas, svg, img'), id).toHaveLength(0);
    }
    // and the new modules never create one
    for (const file of ['pickerUI.js', 'pickerModel.js', 'devicePanel.js']) {
      const src = readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8');
      expect(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''), file).not.toMatch(/mc-button/);
    }
    expect(decls('.cc-panel').get('background')).toBe('#1c1a24');
    expect(decls('.cc-panel').get('border')).toBe('3px solid #e8b04a');
    // rounded and friendly: the icon on a rounded square, pill buttons, rounded square wavelength keys, a battery-shaped bar
    expect(decls('.cc-icon').get('border-radius')).toBe('14px');
    expect(decls('.cc-btn').get('border-radius')).toBe('15px');
    expect(decls('.cc-seg').get('border-radius')).toBe('18px');
    expect(decls('.cc-btn.cc-wave').get('border-radius')).toBe('10px');
    expect(decls('.cc-distress-mark::before').get('border-radius')).toBe('50%');
    expect(decls('.cc-charge').get('border-radius')).toBe('9px');
  });

  it('no player-facing string has a bare [R] or "R:" (hints of every part, the controls sheet, the §3.3 / §4.6 lines, the panel, tips)', () => {
    /** @type {string[]} */
    const strings = [];
    // hintFor over every part, in a few states
    const env = makeCircuitWorld();
    const ids = Object.keys(PARTS).map(Number).filter((id) => isPart(id));
    ids.forEach((id, i) => env.put(i * 3, 0, id));
    env.ticks(2);
    const c = env.circuits;
    const at = (id) => ids.indexOf(id) * 3;
    c.switchAt(at(BLOCK.KNIFE_SWITCH), FLOOR, 0, 'on');
    c.timerAt(at(BLOCK.CLOCKWORK_TIMER), FLOOR, 0, 'start');
    c.applySettings(at(BLOCK.PUSH_BUTTON), FLOOR, 0, { nc: true, l: 'Front door' });
    c.ignite(at(BLOCK.POWDER_FUSE), FLOOR, 0);
    env.ticks(3);
    for (const id of ids) {
      const h = c.hintFor(at(id), FLOOR, 0);
      if (h) strings.push(h);
      const v = c.panelView(at(id), FLOOR, 0, true);
      if (v) strings.push(...v.readout, v.about, v.origin, ...panelFields(v).map((f) => /** @type {*} */ (f).label ?? ''));
      strings.push(partTip(id));
    }
    expect(strings.length).toBeGreaterThan(60);
    // the controls sheet, the picker's and the panel's own lines
    for (const [keys, text] of CONTROLS_SHEET) strings.push(`${keys} ${text}`, text);
    strings.push(PANEL_KEYS_HINT, ...Object.values(ACTION_LABELS));
    const doc = documentFromHTML(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8'));
    strings.push(/** @type {any} */ (doc.querySelector('.picker-hint')).textContent);
    const model = buildPickerModel();
    for (const f of model.families.values()) strings.push(familyLine(f), familyLine(f, true));
    // DESIGN-circuits §3.3 and §4.6: main's keg hints, the R key's explanation and the pocket key's toast (I wires them)
    strings.push(
      'Powder Keg · light it with a fuse, a torch or an igniter',
      'Powder Keg (explosions are off)',
      'Powder Keg · burning! left-click: pinch out the fuse',
      'lit keg · left-click: put it out',
      'Powder kegs need a flame: lay a Powder Fuse to it and light that with the R key, or wire an Igniter. Shift+R key on a part tells you more.',
      'Pocket key · 400 m · R key: send',
      'Black Hole · walk straight away · left-click: break its core',
    );
    for (const s of strings) {
      expect(s, s).not.toContain('[R]');
      expect(s, s).not.toMatch(/(^|[^+\w])R:/);
    }
    // the check itself catches the old wording
    expect('Blast Barrel · R: light').toMatch(/(^|[^+\w])R:/);
    expect('Use: rune, barrel, fire [R]').toContain('[R]');
  });

  it('the Devices row: survival\'s Mode-switch halves; the screen flash overlay fills #hud', () => {
    expect(decls('.mode-half:first-child').get('clip-path')).toBeTruthy();
    expect(decls('.device-switch .mode-half').get('min-width')).toBe('0');
    expect(decls('#flash-overlay').get('position')).toBe('absolute');
    expect(decls('#flash-overlay').get('inset')).toBe('0');
  });
});

// ---- Survival (DESIGN-survival §9.8): z-order, the HUD bookends and chips at the reference sizes, the survival hotbar, and
// no Minecraft chrome (.mc-button / .picker-panel) on any new element.
describe('styles.css survival screens', () => {
  /** "calc(50% + 201px)" → 201 */
  const fromCentre = (v) => {
    const m = /^calc\(50% \+ (\d+(?:\.\d+)?)px\)$/.exec(/** @type {string} */ (v));
    if (!m) throw new Error(`not calc(50% + Npx): ${v}`);
    return Number(m[1]);
  };
  /** "calc(50% - 209px)" at a viewport width */
  const halfMinus = (v, W) => {
    const m = /^calc\(50% - (\d+(?:\.\d+)?)px\)$/.exec(/** @type {string} */ (v));
    if (!m) throw new Error(`not calc(50% - Npx): ${v}`);
    return W / 2 - Number(m[1]);
  };
  const px = (v) => toPx(/** @type {string} */ (v).split(/\s+/)[0], 0);
  /** A box's height: its font's line height + vertical padding + borders ("bold 10px/12px monospace", "1px 5px", "1px solid"). */
  const boxH = (d) => Number(/\/(\d+)px/.exec(/** @type {string} */ (d.get('font')))?.[1])
    + 2 * toPx(/** @type {string} */ (d.get('padding')).split(/\s+/)[0], 0) + 2 * px(d.get('border'));
  /** @typedef {{x0: number, x1: number, y0: number, y1: number}} Rect  screen px, y down */
  const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  it('z-order: the pack screen shares the picker\'s layer (20); the death screen (33) sits over the pause menu, under click-to-play', () => {
    const z = (sel) => Number(decls(sel).get('z-index'));
    expect(z('#pack-screen')).toBe(20);
    expect(z('#pack-screen')).toBe(z('#block-picker'));
    expect(z('#death-screen')).toBe(33);
    expect(z('#pause-menu')).toBeLessThan(z('#death-screen'));
    expect(z('#death-screen')).toBeLessThan(z('#click-to-play'));
    expect(z('#hud')).toBeLessThan(z('#pack-screen'));
  });

  it('the survival hotbar: pointy-top hex slots 40x46, under #block-toast; Creative\'s hotbar parts stay as they were', () => {
    const slot = decls('#hotbar.survival .hotbar-slot');
    expect(slot.get('clip-path')).toBe('polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)');
    expect(slot.get('width')).toBe('40px');
    expect(slot.get('height')).toBe('46px');
    expect(decls('#hotbar.survival .hotbar-slot::before').get('clip-path')).toBe(slot.get('clip-path'));
    const [padY] = /** @type {string} */ (decls('#hotbar.survival').get('padding')).split(/\s+/).map((v) => toPx(v, 0));
    const border = px(decls('#hotbar').get('border'));
    const top = toPx(decls('#hotbar').get('bottom'), 0) + px(slot.get('height')) + 2 * padY + 2 * border + 2; // + 2px shadow
    expect(top).toBeLessThanOrEqual(toPx(decls('#block-toast').get('bottom'), 0));
    // the survival parts never show in Creative
    expect(decls('#hotbar .slot-count,#hotbar .slot-wear,#pack-glyph').get('display')).toBe('none');
    expect(decls('.hotbar-slot').get('width')).toBe('40px');
    expect(decls('.hotbar-slot').get('height')).toBe('40px');
  });

  it('the bookends, status chips and job chip avoid #block-toast, #chat-log and the hotbar at 1280x720 (and its 1258x622 viewport)', () => {
    const bar = decls('#hotbar');
    const slot = decls('#hotbar.survival .hotbar-slot');
    const [padY, padX] = /** @type {string} */ (decls('#hotbar.survival').get('padding')).split(/\s+/).map((v) => toPx(v, 0));
    const border = px(bar.get('border'));
    const barW = HOTBAR_SIZE * px(slot.get('width')) + (HOTBAR_SIZE - 1) * px(bar.get('gap')) + 2 * padX + 2 * border;
    const barH = px(slot.get('height')) + 2 * padY + 2 * border;
    expect(barW).toBe(386);
    const vit = decls('.vitals');
    const cellW = px(decls('.vital').get('width'));
    const cellH = px(decls('.vital').get('height'));
    expect([cellW, cellH]).toEqual([38, 44]);
    const pairW = 2 * cellW + px(vit.get('gap'));
    const leftOff = fromCentre(decls('#vitals-left').get('right'));
    const rightOff = fromCentre(decls('#vitals-right').get('left'));
    expect(leftOff).toBeGreaterThanOrEqual(barW / 2 + 2); // clear of the hotbar and its shadow
    const chips = decls('.status-chips');
    const chipH = boxH(decls('.chip'));
    const job = decls('.job-chip');
    const jobH = boxH(job);
    expect([chipH, jobH]).toEqual([16, 16]);
    // the longest name a toast shows (bold 18px monospace ≈ 10.8px a character, ~21px tall, 2px shadow)
    const longest = Math.max(...Object.values(ITEMS).map((d) => d.name.length), ...BLOCKS.map((b) => b.displayName.length));
    const toastHalfW = (longest * 10.8 + 2) / 2;
    const toastBottom = toPx(decls('#block-toast').get('bottom'), 0);
    const vb = toPx(vit.get('bottom'), 0);

    for (const [W, H] of [[1280, 720], [1258, 622]]) {
      /** @type {Record<string, Rect>} */
      const r = {
        hotbar: { x0: W / 2 - barW / 2 - 2, x1: W / 2 + barW / 2 + 2, y0: H - 8 - barH - 2, y1: H - 8 + 2 },
        toast: { x0: W / 2 - toastHalfW, x1: W / 2 + toastHalfW, y0: H - toastBottom - 21, y1: H - toastBottom },
        chat: { x0: 8, x1: 8 + 0.6 * W, y0: 0, y1: H - toPx(decls('#chat-log').get('bottom'), 0) },
        left: { x0: W / 2 - leftOff - pairW, x1: W / 2 - leftOff, y0: H - vb - cellH, y1: H - vb },
        right: { x0: W / 2 + rightOff, x1: W / 2 + rightOff + pairW, y0: H - vb - cellH, y1: H - vb },
        chips: {
          x0: W / 2 - fromCentre(chips.get('right')) - halfMinus(chips.get('max-width'), W), x1: W / 2 - fromCentre(chips.get('right')),
          y0: H - toPx(chips.get('bottom'), 0) - chipH, y1: H - toPx(chips.get('bottom'), 0),
        },
        job: {
          x0: W / 2 + fromCentre(job.get('left')), x1: W / 2 + fromCentre(job.get('left')) + halfMinus(job.get('max-width'), W),
          y0: H - toPx(job.get('bottom'), 0) - jobH, y1: H - toPx(job.get('bottom'), 0),
        },
      };
      for (const name of ['left', 'right', 'chips', 'job']) {
        expect(overlap(r[name], r.toast), `${name} vs #block-toast at ${W}x${H}`).toBe(false);
        expect(overlap(r[name], r.chat), `${name} vs #chat-log at ${W}x${H}`).toBe(false);
        expect(overlap(r[name], r.hotbar), `${name} vs #hotbar at ${W}x${H}`).toBe(false);
        expect(r[name].x0, `${name} on screen`).toBeGreaterThanOrEqual(0);
        expect(r[name].x1, `${name} on screen`).toBeLessThanOrEqual(W);
      }
      // the chips sit above the left bookend, the job chip above the right one
      expect(r.chips.y1).toBeLessThanOrEqual(r.left.y0);
      expect(r.chips.x1).toBe(r.left.x1);
      expect(r.job.y1).toBeLessThanOrEqual(r.right.y0);
      expect(r.job.x0).toBe(r.right.x0);
    }
    // the pack glyph overlaps the hotbar's bottom-right corner but stays clear of the right bookend
    const glyph = decls('#hotbar.survival #pack-glyph');
    const glyphRight = barW / 2 - border - toPx(/** @type {string} */ (glyph.get('right')), 0);
    expect(glyphRight).toBeLessThan(rightOff);
  });

  it('the pack screen ends above the HUD hotbar like the picker, and fits 1258x622 without scrolling', () => {
    const layer = decls('#pack-screen');
    const panel = decls('.pack-panel');
    expect(panel.get('box-sizing')).toBe('border-box');
    expect(panel.get('overflow-y')).toBe('auto');
    for (const H of [480, 622, 720, 1080]) {
      const bottom = lengthPx(layer.get('padding-top'), H) + lengthPx(panel.get('max-height'), H) + 2;
      expect(bottom, `viewport ${H}`).toBeLessThanOrEqual(H - 60 - 8);
    }
    // left column: heading, the board (the wear chain and discard hex are its tallest part), the info line, the zig-zag
    // strip and the hint (packUI.js: flat-top cells of circumradius 30)
    const S = 30;
    const cy = Math.ceil(2.5 * Math.sqrt(3) * S);
    const board = Math.round(cy + 3.1 * Math.sqrt(3) * S);
    const left = 18 + 4 + board + 4 + 17 + 4 + Math.round(Math.sqrt(3) * S * 1.5) + 6 + 15;
    const [padY] = /** @type {string} */ (panel.get('padding')).split(/\s+/).map((v) => toPx(v, 0));
    expect(left + 2 * padY + 4).toBeLessThanOrEqual(lengthPx(panel.get('max-height'), 622));
    // width: the strip beside the Making panel; the Making column shrinks before it wraps (play-test: at a 1002 px
    // viewport a fixed 520 px column wrapped under the board, below the fold)
    const stripW = 1.5 * S * 8 + 2 * S;
    const right = decls('.pack-right');
    const rightMax = toPx(/** @type {string} */ (right.get('max-width')), 0);
    const rightMin = toPx(/** @type {string} */ (right.get('min-width')), 0);
    expect(right.get('flex')).toMatch(/^1 1 /);
    expect(stripW + 22 + rightMax + 2 * 18 + 4).toBeLessThanOrEqual(1258 - 32);
    expect(stripW + 22 + rightMin + 2 * 18 + 4).toBeLessThanOrEqual(1002 - 32);
  });

  it('a field-book page never shows a horizontal scrollbar, its table heads wrap, and the book grows on tall windows', () => {
    // play-test: the rotated margin notes pushed 2–3 px past the column and Chrome painted a scrollbar strip on every
    // right-hand page with a tip; "Food and drink" was 382 px wide in a 317 px column because its heads could not wrap
    const cols = decls('.hb-columns');
    expect(cols.get('overflow-x')).toBe('hidden');
    expect(cols.get('overflow-y')).toBe('auto'); // a last resort only: pages are re-paged to their measured height
    expect(decls('.hb-text .hb-table th').get('white-space')).toBe('normal');
    const m = /^min\((\d+)px,/.exec(/** @type {string} */ (decls('.hb-book').get('height')));
    expect(Number(m[1])).toBeGreaterThanOrEqual(760);
  });

  it('the contents page fits a short window: below 600 px the chapter list is compact (play-test round 2: 800×600 scrolled)', () => {
    // At 800×600 (a 502 px viewport) the page's columns are 285 px tall; ten entries of 16px/1.5 + 3px padding were 306 px.
    // (Fourteen chapters since §85 and §87: 13px/1.3 + 1px padding fits them in 271 px.)
    const m = /@media \(max-height:600px\)\{\.hb-toc-entry\{([^{}]*)\}\}/.exec(css);
    expect(m, 'a max-height media rule for .hb-toc-entry').toBeTruthy();
    const compact = new Map(m[1].split(';').filter(Boolean).map((d) => d.split(':').map((x) => x.trim())));
    const size = Number(/^(\d+)px$/.exec(/** @type {string} */ (compact.get('font-size')))[1]);
    const line = Number(compact.get('line-height'));
    const pad = Number(/^(\d+)px 0$/.exec(/** @type {string} */ (compact.get('padding')))[1]);
    const entries = buildChapters().length;
    const list = toPx(/** @type {string} */ (decls('.hb-toc').get('margin')).split(/\s+/)[0], 0) + entries * (size * line + 2 * pad);
    expect(list).toBeLessThanOrEqual(285 - 10);
    expect(size).toBeGreaterThanOrEqual(13); // still legible
  });

  it('#death-screen and every new survival element use no .mc-button or .picker-panel; their buttons are .hex-button', () => {
    const doc = documentFromHTML(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8'));
    const ids = ['death-screen', 'pack-screen', 'pause-mode', 'vitals-left', 'vitals-right', 'status-chips', 'job-chip',
      'action-ring', 'pickup-layer', 'pack-glyph'];
    for (const id of ids) {
      const el = /** @type {any} */ (doc.getElementById(id));
      expect(el, id).toBeTruthy();
      expect(el.classList.contains('mc-button') || el.classList.contains('picker-panel'), id).toBe(false);
      expect(el.querySelectorAll('.mc-button, .picker-panel'), id).toHaveLength(0);
    }
    for (const id of ['btn-wake', 'btn-mode-creative', 'btn-mode-survival']) {
      expect(/** @type {any} */ (doc.getElementById(id)).classList.contains('hex-button'), id).toBe(true);
    }
    // and the new modules never create one
    for (const file of ['packUI.js', 'itemIcons.js', 'itemArt.js']) {
      const src = readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8');
      expect(src, file).not.toMatch(/mc-button|picker-panel/);
    }
    expect(decls('#death-screen').get('background')).toBeUndefined(); // no red tint: the honeycomb is the background
    expect(decls('.death-comb polygon').get('fill')).toBe('#1c1a24');
    expect(decls('.comb-ring').get('opacity')).toBe('.85');
    expect(decls('.death-title').get('color')).toBe('#e8b04a');
  });
});

describe('styles.css the Survival Handbook (§14)', () => {
  const z = (sel) => Number(decls(sel).get('z-index'));

  it('z-order: both readers above the HUD and below the death screen; the Guide over the pause menu, and over the title', () => {
    // the field book: over the HUD and the pack screen (it replaces it), under the console, the pause menu and the death screen
    expect(z('#handbook')).toBe(21);
    expect(z('#handbook')).toBeGreaterThan(z('#hud'));
    expect(z('#handbook')).toBeGreaterThan(z('#pack-screen'));
    expect(z('#handbook')).toBeLessThan(z('#console'));
    expect(z('#handbook')).toBeLessThan(z('#pause-menu'));
    expect(z('#handbook')).toBeLessThan(z('#death-screen'));
    // the Guide: over the pause menu it opens from, under the death screen
    expect(z('#guide')).toBe(32);
    expect(z('#guide')).toBeGreaterThan(z('#pause-menu'));
    expect(z('#guide')).toBeLessThan(z('#death-screen'));
    expect(z('#guide')).toBeGreaterThan(z('#hud'));
    // opened from the title screen it lifts over it, still under the confirm dialog
    expect(z('#guide.over-title')).toBeGreaterThan(z('#title-screen'));
    expect(z('#guide.over-title')).toBeLessThan(z('#confirm-dialog'));
  });

  it('the field book ends above the HUD\'s hotbar and vitals at every usual window height', () => {
    const m = /^min\((\d+)px,(max\(.*\))\)$/.exec(/** @type {string} */ (decls('.hb-book').get('height')));
    expect(m).toBeTruthy();
    for (const H of [480, 622, 720, 1080]) {
      const top = lengthPx(/** @type {string} */ (decls('#handbook').get('padding-top')), H);
      const height = Math.min(Number(m[1]), lengthPx(m[2], H));
      if (H >= 480) expect(top + height, `viewport ${H}`).toBeLessThanOrEqual(H - 72);
      expect(height, `viewport ${H}`).toBeGreaterThanOrEqual(300);
    }
  });

  it('the title screen still fits 1280x720 with the Guide button under the controls sheet', () => {
    const first = (v) => toPx(/** @type {string} */ (v).split(/\s+/)[0], 720);
    const sheetRows = CONTROLS_SHEET.length;
    // rows whose description is longer than the 58ch column wrap to two 15px lines (30px instead of 20: DESIGN-circuits §7.1)
    const wrapped = CONTROLS_SHEET.filter(([, text]) => text.length > 58).length;
    expect(wrapped).toBe(2);
    const sheet = first(decls('.controls-sheet').get('margin-top')) + sheetRows * 20 + wrapped * 10
      + (sheetRows - 1) * first(decls('.controls-sheet').get('gap'));
    const btn = decls('.guide-button');
    const [padY] = /** @type {string} */ (btn.get('padding')).split(/\s+/).map((v) => toPx(v, 0));
    const buttonH = first(btn.get('margin-top')) + 2 * padY + 18; // a 14px bold line ≈ 18px
    const column = sheet + buttonH;
    for (const H of [720, 622]) {
      const total = toPx(/** @type {string} */ (decls('#title-screen').get('--title-top')), H) + 128 + first(decls('.title-main').get('margin-top')) + column;
      expect(total, `viewport ${H}`).toBeLessThanOrEqual(H);
    }
    expect(decls('.title-side').get('flex-direction')).toBe('column');
    // … including the layer's own bottom padding: a title that scrolls by a few pixels shows a scrollbar and narrows
    const padBottom = toPx(/** @type {string} */ (decls('.title-main').get('padding')).split(/\s+/)[2], 0);
    const at622 = toPx(/** @type {string} */ (decls('#title-screen').get('--title-top')), 622) + 128
      + first(decls('.title-main').get('margin-top')) + column + padBottom;
    expect(at622).toBeLessThanOrEqual(622);
  });

  it('the readers\' roots are in index.html; nothing in them uses .mc-button or .picker-panel; the Guide buttons are .hex-button', () => {
    const doc = documentFromHTML(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8'));
    for (const id of ['guide', 'handbook']) {
      const el = /** @type {any} */ (doc.getElementById(id));
      expect(el, id).toBeTruthy();
      expect(el.classList.contains('layer') && el.classList.contains('hidden'), id).toBe(true);
      expect(el.querySelectorAll('.mc-button, .picker-panel'), id).toHaveLength(0);
    }
    for (const id of ['btn-guide-title', 'btn-guide-pause']) {
      const el = /** @type {any} */ (doc.getElementById(id));
      expect(el.classList.contains('hex-button'), id).toBe(true);
      expect(el.classList.contains('mc-button'), id).toBe(false);
    }
    // the field book draws its parchment and type itself: no url() images and no @font-face
    const section = css.slice(css.indexOf('The Survival Handbook (docs/DESIGN-survival.md §14'));
    expect(section.length).toBeGreaterThan(1000);
    expect(section).not.toMatch(/url\(|@font-face|@import/);
    expect(decls('.hb-page').get('font')).toMatch(/serif$/);
  });
});

describe('KNOWN-ISSUES save-slot nits (CONTRACTS §72)', () => {
  it('the title footer never takes clicks meant for the Worlds buttons, and world names are bidi-isolated', () => {
    expect(decls('#title-footer').get('pointer-events')).toBe('none');
    expect(decls('.slot-name').get('unicode-bidi')).toBe('isolate');
  });
});
