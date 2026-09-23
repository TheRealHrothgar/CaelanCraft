// Regression tests for src/styles.css — the title-screen controls sheet must fit the 1280x720 reference
// viewport used by scripts/smoke-windows-chrome.sh and docs/PLAN-build.md §3, and the fixed menu layers
// must be able to scroll on shorter viewports (body{overflow:hidden} means nothing else can).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTROLS_SHEET } from '../../src/menus.js';

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
    expect(rows).toBe(14);
    expect(total).toBeLessThanOrEqual(VIEWPORT_H);
  });
});
