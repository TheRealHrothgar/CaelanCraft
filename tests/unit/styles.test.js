// Regression tests for src/styles.css — the title-screen controls sheet must fit the 1280x720 reference
// viewport used by scripts/smoke-windows-chrome.sh and docs/PLAN-build.md §3, and the fixed menu layers
// must be able to scroll on shorter viewports (body{overflow:hidden} means nothing else can).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTROLS_SHEET } from '../../src/menus.js';
import { PICKER_ORDER } from '../../src/blocks.js';

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

  it('logo + menu + full controls sheet fit inside a 1280x720 viewport', () => {
    const paddingTop = toPx(/** @type {string} */ (title.get('--title-top')), VIEWPORT_H);
    // #title-logo is the 200x32 canvas at width:min(800px,90vw) -> 800px wide at 1280 -> 128px tall.
    const logo = (800 * 32) / 200;
    const menuTop = toPx(/** @type {string} */ (decls('.title-menu').get('margin-top')), VIEWPORT_H);
    // Seed row (16px font input, 6px padding, 2px border ≈ 34px) + two .mc-button (18px font, 10px padding,
    // 2px border ≈ 45px each) + two 8px flex gaps. Measured from the 1280x720 reference screenshot.
    const menu = 34 + 45 * 2 + 8 * 2;
    const sheet = decls('.controls-sheet');
    const sheetTop = toPx(/** @type {string} */ (sheet.get('margin-top')), VIEWPORT_H);
    const rowGap = toPx(/** @type {string} */ (sheet.get('gap')).split(/\s+/)[0], VIEWPORT_H);
    // One <kbd> row: 12px bold text + 1px padding x2 + 1px top border + 3px bottom border ≈ 20px.
    const ROW = 20;
    const rows = CONTROLS_SHEET.length;
    const sheetH = rows * ROW + (rows - 1) * rowGap;
    const total = paddingTop + logo + menuTop + menu + sheetTop + sheetH;
    // v0.3 added the console (T /), R and Shift+R rows: 17 rows.
    expect(rows).toBe(17);
    expect(total).toBeLessThanOrEqual(VIEWPORT_H);
  });
});

/** A px / vh length, or calc() of px / vh terms joined by + and −, in px for a viewport height. */
function lengthPx(v, viewportH) {
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

  it('the panel never reaches the hotbar, whatever the viewport height (an 800x480 window included)', () => {
    expect(HOTBAR_CLEARANCE).toBe(60);
    expect(panel.get('box-sizing')).toBe('border-box'); // max-height covers the border and padding
    for (const H of [300, 382, 480, 502, 600, 622, 720, 1080, 1440]) {
      const bottom = lengthPx(layer.get('padding-top'), H) + lengthPx(panel.get('max-height'), H) + 2; // + 2px shadow
      expect(bottom).toBeLessThanOrEqual(H - HOTBAR_CLEARANCE - 8);
    }
  });

  it('only the grid shrinks and scrolls, so the title, name and a wrapped hint can never push the panel down', () => {
    expect(panel.get('display')).toBe('flex');
    expect(panel.get('flex-direction')).toBe('column');
    expect(grid.get('overflow-y')).toBe('auto');
    expect(grid.get('min-height')).toBe('0');
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
