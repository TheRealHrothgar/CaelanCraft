// Unit tests for src/itemArt.js (the 16×16 item icons) and src/itemIcons.js (the icon sheet and block-item icons) —
// docs/DESIGN-survival.md §9.8 and §11 (no diagonal tool icons).
import { describe, it, expect } from 'vitest';
import { ITEMS, ITEM_KEYS, getItem } from '../../src/items.js';
import { BLOCK } from '../../src/blocks.js';
import { ITEM_ART_KEYS, ITEM_ART_SIZE, paintItem, paintMissingItem, hasItemArt, toolArtOf, HEX_BRAND } from '../../src/itemArt.js';
import { createItemIcons, iconBlockFor, sheetCell, SHEET_COLS } from '../../src/itemIcons.js';
import { FakeDocument } from '../helpers/fakeDom.js';

const N = ITEM_ART_SIZE;
const NON_BLOCK = ITEM_KEYS.filter((k) => ITEMS[k].kind !== 'block');
const TOOLS = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'tool');
/** Tools with a haft (everything but the stone hammer and the tier-0 kit: drill, crucible, mold). */
const HAFTED = TOOLS.filter((k) => k !== 'stone_hammer' && ITEMS[k].tool.tier > 0);

/** @param {Uint8ClampedArray} px @returns {Array<[number, number]>} opaque pixels */
function opaque(px) {
  const out = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (px[(y * N + x) * 4 + 3] > 0) out.push([x, y]);
  return out;
}

/** @param {Uint8ClampedArray} px */
function isChecker(px) {
  return Buffer.from(px).equals(Buffer.from(paintMissingItem()));
}

/** Angle (degrees, −90..90) of the principal axis of the opaque pixels; image y grows down, so +45 is the main diagonal. */
function principalAngle(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  return (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
}

describe('itemArt: coverage', () => {
  it('every non-block item in ITEMS has art, and only those (block items are drawn from the atlas)', () => {
    expect(NON_BLOCK.length).toBe(107); // 98 + the Survival Handbook (§14) + the 7 circuit materials (DESIGN-circuits §8.1) + the dart (§60)
    expect([...ITEM_ART_KEYS].sort()).toEqual([...NON_BLOCK].sort());
    expect(ITEM_ART_KEYS).toEqual(NON_BLOCK); // same order as ITEM_KEYS (tools, materials, food, bandages, clothes)
    for (const k of NON_BLOCK) expect(hasItemArt(k), k).toBe(true);
    for (const k of ITEM_KEYS.filter((key) => ITEMS[key].kind === 'block')) expect(hasItemArt(k), k).toBe(false);
  });

  it('the art table agrees with each tool\'s type and tier in the registry', () => {
    for (const k of TOOLS) {
      const [type, tier] = /** @type {[string, number]} */ (toolArtOf(k));
      expect(type, k).toBe(ITEMS[k].tool.type);
      expect(tier, k).toBe(ITEMS[k].tool.tier);
    }
    expect(toolArtOf('rock')).toBeNull();
    expect(toolArtOf('__proto__')).toBeNull();
  });

  it('every icon is 16×16 RGBA, crisp (alpha 0 or 255), neither empty nor full, and not the checker', () => {
    for (const k of NON_BLOCK) {
      const px = paintItem(k);
      expect(px).toBeInstanceOf(Uint8ClampedArray);
      expect(px.length, k).toBe(N * N * 4);
      for (let i = 3; i < px.length; i += 4) expect(px[i] === 0 || px[i] === 255, `${k} alpha`).toBe(true);
      const count = opaque(px).length;
      expect(count, `${k} opaque pixels`).toBeGreaterThanOrEqual(24);
      expect(count, `${k} transparent pixels`).toBeLessThanOrEqual(N * N - 30);
      expect(isChecker(px), k).toBe(false);
    }
  });

  it('is deterministic', () => {
    for (const k of NON_BLOCK) expect(Buffer.from(paintItem(k)).equals(Buffer.from(paintItem(k))), k).toBe(true);
  });

  it('every icon differs from every other', () => {
    const seen = new Map();
    for (const k of NON_BLOCK) {
      const sig = Buffer.from(paintItem(k)).toString('base64');
      expect(seen.get(sig), `${k} duplicates ${seen.get(sig)}`).toBeUndefined();
      seen.set(sig, k);
    }
  });

  it('unknown keys (and garbage) paint the magenta/black checker', () => {
    for (const bad of ['nope', '', '__proto__', 'constructor', 'stone', undefined, null, 7]) {
      const px = paintItem(/** @type {any} */ (bad));
      expect(isChecker(px), String(bad)).toBe(true);
      expect(px[0]).toBe(255); // magenta top-left
      expect(px[2]).toBe(255);
      expect(px[(0 * N + 15) * 4]).toBe(0); // black top-right
    }
  });
});

describe('itemArt: the art rules (§9.8, §11)', () => {
  it('no tool icon\'s opaque pixels follow either diagonal', () => {
    for (const k of TOOLS) {
      const pts = opaque(paintItem(k));
      const main = pts.filter(([x, y]) => Math.abs(x - y) <= 1).length;
      const anti = pts.filter(([x, y]) => Math.abs(x + y - 15) <= 1).length;
      expect(main, `${k}: pixels on the main diagonal band`).toBeLessThan(0.25 * pts.length);
      expect(anti, `${k}: pixels on the anti-diagonal band`).toBeLessThan(0.25 * pts.length);
    }
  });

  it('hafted tools are upright: the haft lies in columns 6–9 and the shape\'s axis is near vertical', () => {
    for (const k of HAFTED) {
      const pts = opaque(paintItem(k));
      const rowsWithHaft = new Set(pts.filter(([x]) => x >= 7 && x <= 8).map(([, y]) => y));
      expect(rowsWithHaft.size, `${k}: rows crossing columns 7–8`).toBeGreaterThanOrEqual(13);
      // nothing of the haft strays: every row from the binding down to the bottom has pixels in columns 6–9
      const outsideHaft = pts.filter(([x, y]) => y >= 12 && (x < 6 || x > 9)).length;
      if (ITEMS[k].tool.type !== 'shovel') expect(outsideHaft, `${k}: lower half outside columns 6–9`).toBe(0);
      const angle = principalAngle(pts);
      // vertical (±90) or, for the wide pick and hammer heads, horizontal (0) — never the 45° of a diagonal tool
      const fromDiagonal = Math.min(Math.abs(Math.abs(angle) - 45), 90);
      expect(fromDiagonal, `${k}: principal axis ${angle.toFixed(1)}°`).toBeGreaterThan(25);
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      expect(cx, `${k}: centre of mass x`).toBeGreaterThan(5.5);
      expect(cx, `${k}: centre of mass x`).toBeLessThan(10);
    }
  });

  it('the working end is at the top, except shovels, whose blade is at the bottom', () => {
    for (const k of HAFTED) {
      const pts = opaque(paintItem(k));
      const wide = (y0, y1) => pts.filter(([x, y]) => y >= y0 && y <= y1 && (x < 6 || x > 9)).length;
      const top = wide(0, 7);
      const bottom = wide(9, 15);
      const type = ITEMS[k].tool.type;
      if (type === 'shovel') expect(bottom, k).toBeGreaterThan(top);
      else if (['axe', 'pick', 'hammer'].includes(type)) expect(top, k).toBeGreaterThan(bottom);
      else if (type === 'sword') {
        // a long narrow blade pointing up over a crossguard in the lower half
        const rowWidth = (y) => pts.filter(([, py]) => py === y).length;
        const guard = [...Array(16).keys()].reduce((best, y) => (rowWidth(y) > rowWidth(best) ? y : best), 0);
        expect(guard, k).toBeGreaterThanOrEqual(9);
        for (let y = 0; y < 9; y++) expect(rowWidth(y), `${k} blade row ${y}`).toBeLessThanOrEqual(5);
        expect(rowWidth(1), k).toBeGreaterThan(0);
      }
      else expect(bottom, k).toBeLessThanOrEqual(top + 1); // knives and spears: slim heads, nothing wide below
    }
  });

  it('the tier shows in the head colour: each tier\'s pick differs, and copper / steel use their stated colours', () => {
    const picks = ['flint_pick', 'copper_pick', 'bronze_pick', 'iron_pick', 'steel_pick'].map((k) => Buffer.from(paintItem(k)).toString('hex'));
    expect(new Set(picks).size).toBe(5);
    const has = (k, rgb) => {
      const px = paintItem(k);
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] && px[i] === rgb[0] && px[i + 1] === rgb[1] && px[i + 2] === rgb[2]) return true;
      return false;
    };
    expect(has('copper_axe', [0xc8, 0x74, 0x3a])).toBe(true);
    expect(has('bronze_axe', [0xb0, 0x8d, 0x3a])).toBe(true);
    expect(has('iron_axe', [0x8a, 0x8f, 0x96])).toBe(true);
    expect(has('steel_axe', [0x7f, 0xb2, 0xff])).toBe(true); // the blue glint
    expect(has('flint_axe', [0xd8, 0xd2, 0xc0])).toBe(true); // the pale cortex
    // the binding: a forged eye's rivet pixel on iron and steel; a cord wrap on stone and flint
    expect(has('iron_hammer', [0xf6, 0xf2, 0xe8])).toBe(true);
    expect(has('flint_knife', [0xd8, 0xc3, 0x8c])).toBe(true);
    expect(has('copper_knife', [0xd8, 0xc3, 0x8c])).toBe(false);
  });

  it('honeyberries are dusky blue', () => {
    const px = paintItem('honeyberries');
    let blue = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] && px[i + 2] > px[i] + 40) blue++;
    expect(blue).toBeGreaterThan(20);
  });

  it('§14 the handbook: a leather-bound book tied with cord, a hex burned into the cover, pages at the edge', () => {
    expect(hasItemArt('handbook')).toBe(true);
    const px = paintItem('handbook');
    expect(isChecker(px)).toBe(false);
    const at = (x, y) => {
      const i = (y * N + x) * 4;
      return px[i + 3] ? [px[i], px[i + 1], px[i + 2]] : null;
    };
    const near = (c, rgb, tol = 4) => !!c && c.every((v, i) => Math.abs(v - rgb[i]) <= tol);
    // the hemp twine crosses the whole cover on row 10 and is knotted past the fore-edge
    for (let x = 2; x <= 12; x++) expect(near(at(x, 10), x & 1 ? [0xc9, 0xb0, 0x7a] : [0xa4, 0x8a, 0x52]), `cord ${x}`).toBe(true);
    expect(near(at(14, 10), [0xa4, 0x8a, 0x52])).toBe(true);
    // the burned hex: a charred pointy-top ring (a vertex top and bottom, straight sides) round a scorched face
    expect(HEX_BRAND).toHaveLength(14);
    for (const [x, y] of HEX_BRAND) expect(near(at(x, y), [0x26, 0x13, 0x0a]), `hex ${x},${y}`).toBe(true);
    const xs = HEX_BRAND.map(([x]) => x);
    const ys = HEX_BRAND.map(([, y]) => y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([5, 10, 2, 8]);
    expect(near(at(7, 6), [0x5e, 0x33, 0x1a])).toBe(true); // scorched inside
    // leather cover: brown (red > green > blue) over most of the icon; pale pages at the fore-edge
    let leather = 0;
    for (let y = 1; y <= 13; y++) for (let x = 4; x <= 11; x++) {
      const c = at(x, y);
      if (c && c[0] > c[1] && c[1] > c[2]) leather++;
    }
    expect(leather).toBeGreaterThan(80);
    const page = at(13, 5);
    expect(page && page[0] > 190 && page[1] > 170).toBe(true);
  });
});

describe('itemIcons', () => {
  /** A fake atlas canvas. */
  const atlas = /** @type {any} */ ({ width: 256, height: 256 });

  it('the sheet has 16 columns and a checker cell after the last icon', () => {
    expect(SHEET_COLS).toBe(16);
    expect(sheetCell(ITEM_ART_KEYS[0])).toEqual([0, 0]);
    expect(sheetCell(ITEM_ART_KEYS[17])).toEqual([1, 1]);
    const n = ITEM_ART_KEYS.length;
    expect(sheetCell('no_such_item')).toEqual([n % 16, Math.floor(n / 16)]);
  });

  it('block items show their block; the bush items show the RIPE plant they do not place', () => {
    expect(iconBlockFor('stone')).toBe(BLOCK.STONE);
    expect(iconBlockFor('campfire')).toBe(BLOCK.CAMPFIRE);
    expect(getItem('honeyberry_bush')?.block).toBe(BLOCK.HONEYBERRY_BUSH_BARE);
    expect(iconBlockFor('honeyberry_bush')).toBe(BLOCK.HONEYBERRY_BUSH);
    expect(iconBlockFor('prickly_pear')).toBe(BLOCK.PRICKLY_PEAR);
    expect(iconBlockFor('rock')).toBe(-1);
    expect(iconBlockFor('nope')).toBe(-1);
  });

  it('draws block items with drawBlockIcon and other items from the lazily painted sheet', () => {
    const doc = new FakeDocument();
    const icons = createItemIcons(/** @type {any} */ (doc), atlas);
    expect(icons.paintedCount()).toBe(0);
    const c = /** @type {any} */ (icons.canvas('flint_pick', 32));
    expect(c.width).toBe(32);
    const calls = c.getContext('2d').calls;
    const draw = calls.find((x) => x[0] === 'drawImage');
    expect(draw).toBeTruthy();
    const [col, row] = sheetCell('flint_pick');
    expect(draw.slice(2)).toEqual([col * 16, row * 16, 16, 16, 0, 0, 32, 32]); // nearest-neighbour ×2
    expect(icons.paintedCount()).toBe(1);
    icons.canvas('flint_pick', 16);
    expect(icons.paintedCount()).toBe(1); // painted once
    icons.canvas('rock', 16);
    expect(icons.paintedCount()).toBe(2);
    // a block item never touches the sheet: drawBlockIcon draws the prism from the atlas
    const b = /** @type {any} */ (icons.canvas('honeyberry_bush', 32));
    const bcalls = b.getContext('2d').calls;
    expect(bcalls.some((x) => x[0] === 'drawImage' && x[1] === atlas)).toBe(true);
    expect(icons.paintedCount()).toBe(2);
  });

  it('an empty key clears the square; an unknown key draws the checker cell', () => {
    const doc = new FakeDocument();
    const icons = createItemIcons(/** @type {any} */ (doc), atlas);
    const c = /** @type {any} */ (doc.createElement('canvas'));
    const ctx = c.getContext('2d');
    icons.draw(ctx, null, 32);
    expect(ctx.calls.some((x) => x[0] === 'clearRect')).toBe(true);
    expect(ctx.calls.some((x) => x[0] === 'drawImage')).toBe(false);
    icons.draw(ctx, 'mystery', 32);
    const d = ctx.calls.filter((x) => x[0] === 'drawImage').pop();
    const [col, row] = sheetCell('mystery');
    expect(d.slice(2, 4)).toEqual([col * 16, row * 16]);
  });

  it('the sheet cells hold paintItem\'s pixels', () => {
    const doc = new FakeDocument();
    const icons = createItemIcons(/** @type {any} */ (doc), atlas);
    icons.canvas('roast_pork', 16);
    const sheet = doc.documentElement; // the sheet canvas is not in the tree; find it through a draw call instead
    expect(sheet).toBeTruthy();
    const c = /** @type {any} */ (icons.canvas('roast_pork', 16));
    const sheetCanvas = c.getContext('2d').calls.find((x) => x[0] === 'drawImage')[1];
    const put = sheetCanvas.getContext('2d').calls.find((x) => x[0] === 'putImageData');
    expect(Buffer.from(put[1].data).equals(Buffer.from(paintItem('roast_pork')))).toBe(true);
  });

  it('needs a document', () => {
    expect(() => createItemIcons(/** @type {any} */ (null), atlas)).toThrow(TypeError);
  });
});
