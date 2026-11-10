// Caelancraft — item icons for the survival screens (hotbar stacks, the pack screen, pickup tokens, recipe cards).
// See docs/DESIGN-survival.md §9.8 ("itemIcons.js"); CONTRACTS §48 once merged.
//
// DOM module (canvas 2D). Imports: config, items, atlas, itemArt (the §9.1 import graph). Nothing touches the DOM at module
// top level, so it can be imported (and unit-tested with a fake document) under Node.
// - Block items are drawn as hexagonal-prism icons by atlas.drawBlockIcon; the two bush items show their RIPE plant, though
//   they place the picked one (§5.1).
// - Every other item is blitted from a lazily painted 16-column sheet of itemArt icons (16×16 each) with nearest-neighbour
//   scaling, so a 32 px hotbar icon is each art pixel doubled.
import { ATLAS_TILE_PX } from './config.js';
import { getItem, itemForBlock, blockForItem } from './items.js';
import { drawBlockIcon } from './atlas.js';
import { ITEM_ART_KEYS, ITEM_ART_SIZE, paintItem, paintMissingItem } from './itemArt.js';

/** Icons per sheet row. */
export const SHEET_COLS = 16;
/** Default icon size in CSS pixels (the hotbar's canvas.slot-icon). */
export const DEFAULT_ICON_PX = 32;

/** Sheet cell of every art key; the cell after the last one holds the 'missing' checker. */
const SHEET_INDEX = new Map(ITEM_ART_KEYS.map((k, i) => [k, i]));
const MISSING_CELL = ITEM_ART_KEYS.length;
const SHEET_CELLS = ITEM_ART_KEYS.length + 1;

/** Highest block id scanned when looking for the block a block item's icon shows. */
const MAX_BLOCK_ID = 255;

// CONTRACT-ISSUE: §9.8 says block items "call drawBlockIcon with blockForItem (the ripe bush for the bush items)", but
// §5.1 (W0's items.js) makes blockForItem('honeyberry_bush') the PICKED bush (the item places it). The icon follows the
// parenthesis: iconBlockFor finds the ripe block through itemForBlock, so no items.js change is needed.
/** @type {Map<string, number>|null} block item key → block id its icon shows */
let iconBlocks = null;

/**
 * The block whose prism a block item's icon shows: the block the item places, except for the bush items, which place their
 * picked variant but show the ripe plant (the other block that maps back to the same item). -1 when the key is not a
 * block item.
 * @param {string} key
 * @returns {number}
 */
export function iconBlockFor(key) {
  if (getItem(key)?.kind !== 'block') return -1;
  if (!iconBlocks) {
    iconBlocks = new Map();
    for (let id = 0; id <= MAX_BLOCK_ID; id++) {
      const k = itemForBlock(id);
      if (k === null) continue;
      // first id wins, except that an id other than the one the item places replaces it (the ripe bush)
      if (!iconBlocks.has(k) || iconBlocks.get(k) === blockForItem(k)) iconBlocks.set(k, id);
    }
  }
  return iconBlocks.get(key) ?? blockForItem(key);
}

/**
 * Sheet cell of an item ([column, row]); unknown keys and block items get the checker cell (block items never use the sheet).
 * @param {string} key
 * @returns {[number, number]}
 */
export function sheetCell(key) {
  const i = SHEET_INDEX.get(key) ?? MISSING_CELL;
  return [i % SHEET_COLS, Math.floor(i / SHEET_COLS)];
}

/**
 * @typedef {Object} ItemIcons
 * @property {(ctx: CanvasRenderingContext2D, key: string|null, size?: number) => void} draw
 *   clear the size×size square at (0,0) and draw the item's icon into it (nothing for a null / empty key)
 * @property {(key: string|null, size?: number) => HTMLCanvasElement} canvas   a new size×size canvas holding the icon
 * @property {() => number} paintedCount   how many sheet cells have been painted so far (lazy painting; for tests)
 */

/**
 * @param {Document} doc
 * @param {HTMLCanvasElement} atlasCanvas  from atlas.createAtlasCanvas()
 * @returns {ItemIcons}
 */
export function createItemIcons(doc, atlasCanvas) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createItemIcons: a Document is required');

  /** @type {HTMLCanvasElement|null} */
  let sheet = null;
  /** @type {CanvasRenderingContext2D|null} */
  let sheetCtx = null;
  /** @type {Set<number>} */
  const painted = new Set();

  /** @param {number} size @returns {HTMLCanvasElement} */
  function newCanvas(size) {
    const c = /** @type {HTMLCanvasElement} */ (doc.createElement('canvas'));
    c.width = size;
    c.height = size;
    return c;
  }

  function ensureSheet() {
    if (sheet) return;
    const rows = Math.ceil(SHEET_CELLS / SHEET_COLS);
    sheet = newCanvas(SHEET_COLS * ITEM_ART_SIZE);
    sheet.height = rows * ITEM_ART_SIZE;
    sheetCtx = sheet.getContext('2d');
  }

  /** Paint one cell of the sheet the first time it is needed. @param {string} key @returns {[number, number]} pixel origin */
  function ensureCell(key) {
    ensureSheet();
    const i = SHEET_INDEX.get(key) ?? MISSING_CELL;
    const [col, row] = [i % SHEET_COLS, Math.floor(i / SHEET_COLS)];
    const sx = col * ITEM_ART_SIZE;
    const sy = row * ITEM_ART_SIZE;
    if (!painted.has(i) && sheetCtx) {
      painted.add(i);
      const img = sheetCtx.createImageData(ITEM_ART_SIZE, ITEM_ART_SIZE);
      img.data.set(i === MISSING_CELL ? paintMissingItem() : paintItem(key));
      sheetCtx.putImageData(img, sx, sy);
    }
    return [sx, sy];
  }

  /** @type {ItemIcons['draw']} */
  function draw(ctx, key, size = DEFAULT_ICON_PX) {
    if (!ctx || !(size > 0)) return;
    if (typeof key === 'string' && getItem(key)?.kind === 'block') {
      drawBlockIcon(ctx, atlasCanvas, iconBlockFor(key), size); // clears the square itself
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, size, size);
    if (typeof key === 'string' && key !== '') {
      const [sx, sy] = ensureCell(key);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(/** @type {HTMLCanvasElement} */ (sheet), sx, sy, ITEM_ART_SIZE, ITEM_ART_SIZE, 0, 0, size, size);
    }
    ctx.restore();
  }

  /** @type {ItemIcons['canvas']} */
  function canvas(key, size = DEFAULT_ICON_PX) {
    const c = newCanvas(size);
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      draw(ctx, key, size);
    }
    return c;
  }

  return { draw, canvas, paintedCount: () => painted.size };
}

// The sheet's art is 16 px, like an atlas tile: block and item icons scale the same way.
if (ITEM_ART_SIZE !== ATLAS_TILE_PX) throw new Error('itemIcons: item art and atlas tiles must be the same size');
