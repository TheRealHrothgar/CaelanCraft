// Regression tests for src/styles.css — the title screen's Worlds panel (§41) and controls sheet must fit the 1280x720
// reference viewport used by scripts/smoke-windows-chrome.sh and docs/PLAN-build.md §3, and the fixed menu layers
// must be able to scroll on shorter viewports (body{overflow:hidden} means nothing else can).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTROLS_SHEET } from '../../src/menus.js';
import { PICKER_ORDER } from '../../src/blocks.js';
import { SAVE_SLOTS } from '../../src/config.js';

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
  function sheetHeight() {
    const rowGap = first(sheet.get('gap'));
    // One <kbd> row: 12px bold text + 1px padding x2 + 1px top border + 3px bottom border ≈ 20px.
    const ROW = 20;
    const rows = CONTROLS_SHEET.length;
    return rows * ROW + (rows - 1) * rowGap;
  }

  it('the Worlds panel model matches the measured layout', () => {
    expect(SAVE_SLOTS).toBe(6);
    expect(worldsPanelHeight()).toBe(410);
    expect(CONTROLS_SHEET.length).toBe(17); // v0.3 added the console (T /), R and Shift+R rows
    expect(sheetHeight()).toBe(372);
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
    const SHEET_W = 503; // measured: the widest row is "Shift R" + "Edit the targeted Rune Block (also opens on placing one)"
    expect(2 * padX + panelW + columnGap + SHEET_W).toBeLessThanOrEqual(1258);
    // rows wrap their buttons under the name rather than overflowing a phone-width panel
    expect(decls('.world-slot').get('flex-wrap')).toBe('wrap');
    expect(decls('.slot-actions').get('flex-wrap')).toBe('wrap');
  });
});

/** A px / vh length, calc() of px / vh terms joined by + and −, or max() of those, in px for a viewport height. */
function lengthPx(v, viewportH) {
  const mx = /^max\((.*)\)$/.exec(v);
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
    return Math.max(...parts.map((p) => lengthPx(p, viewportH)));
  }
  const m = /^calc\((.*)\)$/.exec(v);
  if (!m) return toPx(v, viewportH);
  let total = 0;
  for (const [, sign, term] of m[1].matchAll(/([+-]?)\s*([\d.]+(?:px|vh))/g)) total += (sign === '-' ? -1 : 1) * toPx(term, viewportH);
  return total;
}

describe('styles.css block picker', () => {
  // Pixels from the viewport bottom to the hotbar's visible top: 8px offset, 40px slot + 3px padding + 2px border on
  // each side, 2px box-shadow (the hotbar stays visible and clickable while the picker is open).
  const hotbar = decls('#hotbar');
  const HOTBAR_CLEARANCE = toPx(hotbar.get('bottom'), 0) + toPx(decls('.hotbar-slot').get('height'), 0)
    + 2 * toPx(hotbar.get('padding'), 0) + 2 * 2 + 2;
  const layer = decls('#block-picker');
  const panel = decls('.picker-panel');
  const grid = decls('#picker-grid');

  // 4px border + 12px padding on each side, 16px bold title and name (~19px lines), 8px grid margins, and the 12px hint
  // (~15px a line) on two lines: it wraps below ~640px wide (measured in Chrome: 114px of chrome at 512 wide, 100 at 1280).
  const CHROME_TWO_LINE_HINT = 2 * 4 + 2 * 12 + 19 + 19 + 2 * 15 + 2 * 8;
  const ONE_ROW = 60;
  const panelBottom = (H) => lengthPx(layer.get('padding-top'), H) + lengthPx(panel.get('max-height'), H) + 2; // + 2px shadow

  it('the panel never reaches the hotbar at any usual viewport height (an 800x480 window included)', () => {
    expect(HOTBAR_CLEARANCE).toBe(60);
    expect(panel.get('box-sizing')).toBe('border-box'); // max-height covers the border and padding
    for (const H of [274, 300, 382, 480, 502, 600, 622, 720, 1080, 1440]) {
      expect(panelBottom(H), `viewport ${H}px`).toBeLessThanOrEqual(H - HOTBAR_CLEARANCE - 8);
    }
  });

  it('a tiny window (512x202 and smaller) still shows a row of blocks to pick: only then may the panel overlap the hotbar', () => {
    // Regression: at a 202px viewport #picker-grid shrank to 0px, so nothing could be picked.
    expect(lengthPx(grid.get('min-height'), 0)).toBeGreaterThanOrEqual(ONE_ROW);
    expect(lengthPx(grid.get('min-height'), 0)).toBeLessThan(2 * ONE_ROW); // about one row, not a fixed big panel
    for (const H of [120, 202, 240, 273]) {
      const room = lengthPx(panel.get('max-height'), H);
      expect(room, `viewport ${H}px`).toBeGreaterThanOrEqual(CHROME_TWO_LINE_HINT + lengthPx(grid.get('min-height'), 0));
      expect(room).toBeLessThanOrEqual(CHROME_TWO_LINE_HINT + lengthPx(grid.get('min-height'), 0) + 8); // no more than needed
    }
    // Narrower still (a three-line hint): the panel scrolls rather than spilling past its border.
    expect(panel.get('overflow-y')).toBe('auto');
  });

  it('only the grid shrinks and scrolls, so the title, name and a wrapped hint can never push the panel down', () => {
    expect(panel.get('display')).toBe('flex');
    expect(panel.get('flex-direction')).toBe('column');
    expect(grid.get('overflow-y')).toBe('auto');
    expect(grid.get('flex')).toMatch(/^0 1 /);
    expect(grid.get('max-height')).not.toMatch(/vh/); // the viewport bound lives on the panel, which sees all the chrome
  });

  it('the 1280x720 reference window (622px viewport) still shows the whole grid without scrolling', () => {
    const H = 622;
    // 4px border + 12px padding on each side, 16px bold title and name (~19px lines), 12px hint (~15px), 8px grid margins.
    const chrome = 2 * 4 + 2 * 12 + 19 + 19 + 15 + 2 * 8;
    const cols = Math.floor((820 + 4) / (60 + 4)); // grid width min(820px, 100vw − 48px) = 820px at 1258px wide
    const rows = Math.ceil(PICKER_ORDER.length / cols);
    expect(lengthPx(panel.get('max-height'), H)).toBeGreaterThanOrEqual(chrome + rows * 60 + (rows - 1) * 4);
  });
});
