// Regression tests for src/styles.css — the title screen's Worlds panel (§41) and controls sheet must fit the 1280x720
// reference viewport used by scripts/smoke-windows-chrome.sh and docs/PLAN-build.md §3, and the fixed menu layers
// must be able to scroll on shorter viewports (body{overflow:hidden} means nothing else can).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTROLS_SHEET } from '../../src/menus.js';
import { PICKER_ORDER, BLOCKS } from '../../src/blocks.js';
import { SAVE_SLOTS, HOTBAR_SIZE } from '../../src/config.js';
import { ITEMS } from '../../src/items.js';
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

  // DESIGN-circuits §5.10: the v0.9 test "the 1280x720 reference window (622px viewport) still shows the whole grid without
  // scrolling" is gone. With the 20 circuit blocks PICKER_ORDER holds 99 blocks (7 rows of 15), so the picker scrolls by
  // design; the test above pins the scrolling grid, and package D's honeycomb picker replaces this block of tests.
  it('the grid keeps its 980px width at the 1280x720 reference window (it now scrolls: 99 blocks)', () => {
    expect(grid.get('width')).toBe('min(980px,calc(100vw - 48px))');
    expect(980).toBeLessThanOrEqual(1258 - 48); // the 1258px-wide reference viewport gives the grid its full width
    expect(Math.ceil(PICKER_ORDER.length / Math.floor((980 + 4) / (60 + 4)))).toBe(7);
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
    const sheet = first(decls('.controls-sheet').get('margin-top')) + sheetRows * 20 + (sheetRows - 1) * first(decls('.controls-sheet').get('gap'));
    const btn = decls('.guide-button');
    const [padY] = /** @type {string} */ (btn.get('padding')).split(/\s+/).map((v) => toPx(v, 0));
    const buttonH = first(btn.get('margin-top')) + 2 * padY + 18; // a 14px bold line ≈ 18px
    const column = sheet + buttonH;
    for (const H of [720, 622]) {
      const total = toPx(/** @type {string} */ (decls('#title-screen').get('--title-top')), H) + 128 + first(decls('.title-main').get('margin-top')) + column;
      expect(total, `viewport ${H}`).toBeLessThanOrEqual(H);
    }
    expect(decls('.title-side').get('flex-direction')).toBe('column');
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
