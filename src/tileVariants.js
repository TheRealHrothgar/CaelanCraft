// Caelancraft — tile variants (CONTRACTS §90). PURE: imports blocks.js and config.js only.
//
// The world's natural and building blocks come in several pictures of the same material, painted by tilesHD.js, so a
// field of stone or a wall of planks never repeats one stamp. This module says which tiles have variants, where each
// variant sits in the atlas, how a face may turn its picture (mirror a hexagonal cap, mirror and slide a side's window)
// and how far a cell may lighten or darken its block. The mesher picks all of it per cell from a hash of the cell's
// world position (variantHash), so a block keeps its look when its chunk is re-meshed or the world is reloaded.
//
// Atlas slots: tile t's first picture is slot t (as always); its other pictures take slots from FIRST_EXTRA_SLOT up,
// in the order of SPEC below. A slot is laid out like a tile (tileToUV and atlas.tileOrigin take a slot).
import { TILE as T, BLOCK as B, getBlockDef } from './blocks.js';
import { ATLAS_TILES_PER_ROW } from './config.js';

/** A cap (top or bottom face) may be mirrored left-right and top-bottom: the hexagon inscribed in the tile maps onto itself. */
export const VARY_CAP = 1;
/** A side face may be mirrored left-right. */
export const VARY_MIRROR = 2;
/** A side face's window (the middle HEX_SIZE of the tile's width) may slide along the tile. */
export const VARY_SHIFT = 4;
/** Everything: a material with no up or down and no picture in the middle (stone, dirt, planks). */
const ALL = VARY_CAP | VARY_MIRROR | VARY_SHIFT;
/** Sides that hang from their top edge (grass and snow over dirt, logs, hay): mirrored and slid, never flipped. */
const SIDE = VARY_MIRROR | VARY_SHIFT;

/** The atlas has ATLAS_TILES_PER_ROW² slots; tile ids use 0..255, variants the rest. */
export const ATLAS_SLOTS = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
export const FIRST_EXTRA_SLOT = 256;
/** The most pictures a tile may have. */
export const MAX_VARIANTS = 4;

/** [tile, pictures, how a face may vary]. Order fixes the extra slots: append, never reorder. */
const SPEC = [
  [T.STONE, 4, ALL], [T.DIRT, 4, ALL], [T.GRASS_TOP, 4, VARY_CAP], [T.GRASS_SIDE, 4, SIDE],
  [T.COBBLESTONE, 4, ALL], [T.OAK_PLANKS, 3, ALL], [T.BEDROCK, 3, ALL], [T.WATER, 1, 0],
  [T.SAND, 4, ALL], [T.GRAVEL, 4, ALL], [T.OAK_LOG_SIDE, 3, SIDE], [T.OAK_LOG_END, 3, VARY_CAP],
  [T.OAK_LEAVES, 3, ALL], [T.GLASS, 1, 0], [T.COAL_ORE, 3, ALL], [T.IRON_ORE, 3, ALL], [T.GOLD_ORE, 3, ALL],
  [T.DIAMOND_ORE, 3, ALL], [T.SANDSTONE_TOP, 3, VARY_CAP], [T.SANDSTONE_SIDE, 3, SIDE], [T.SNOW, 3, ALL],
  [T.SNOWY_GRASS_SIDE, 3, SIDE], [T.BRICKS, 3, ALL], [T.BOOKSHELF, 3, VARY_MIRROR], [T.STONE_BRICKS, 3, ALL],
  [T.WOOL_WHITE, 2, ALL], [T.WOOL_RED, 2, ALL],
  [T.SPRUCE_LOG_SIDE, 3, SIDE], [T.SPRUCE_LOG_END, 3, VARY_CAP], [T.SPRUCE_PLANKS, 3, ALL], [T.SPRUCE_LEAVES, 3, ALL],
  [T.BIRCH_LOG_SIDE, 3, SIDE], [T.BIRCH_LOG_END, 3, VARY_CAP], [T.BIRCH_PLANKS, 3, ALL], [T.BIRCH_LEAVES, 3, ALL],
  [T.GRANITE, 3, ALL], [T.DIORITE, 3, ALL], [T.ANDESITE, 3, ALL], [T.SLATE, 3, ALL], [T.MOSSY_COBBLESTONE, 3, ALL],
  [T.MOSSY_STONE_BRICKS, 3, ALL], [T.OBSIDIAN, 3, ALL], [T.CLAY, 3, ALL], [T.RED_SAND, 4, ALL], [T.ICE, 2, ALL],
  [T.PACKED_ICE, 2, ALL], [T.COAL_BLOCK, 1, 0], [T.IRON_BLOCK, 1, 0], [T.GOLD_BLOCK, 1, 0], [T.DIAMOND_BLOCK, 1, 0],
  [T.COPPER_BLOCK, 1, 0], [T.GLOWSTONE, 2, ALL], [T.HONEYCOMB, 2, VARY_CAP | VARY_MIRROR], [T.HAY_BALE_SIDE, 2, SIDE],
  [T.HAY_BALE_TOP, 2, VARY_CAP], [T.PUMPKIN_SIDE, 2, VARY_MIRROR], [T.PUMPKIN_TOP, 1, 0],
  [T.WOOL_ORANGE, 2, ALL], [T.WOOL_YELLOW, 2, ALL], [T.WOOL_LIME, 2, ALL], [T.WOOL_GREEN, 2, ALL], [T.WOOL_CYAN, 2, ALL],
  [T.WOOL_LIGHT_BLUE, 2, ALL], [T.WOOL_BLUE, 2, ALL], [T.WOOL_PURPLE, 2, ALL], [T.WOOL_MAGENTA, 2, ALL],
  [T.WOOL_PINK, 2, ALL], [T.WOOL_BROWN, 2, ALL], [T.WOOL_BLACK, 2, ALL], [T.WOOL_GRAY, 2, ALL],
  [T.WOOL_LIGHT_GRAY, 2, ALL], [T.COPPER_ORE, 3, ALL], [T.TIN_ORE, 3, ALL], [T.TAINTED_WATER, 1, 0],
  [T.AQUIFER_SIDE, 2, ALL], [T.AQUIFER_TOP, 2, VARY_CAP],
];

/**
 * @typedef {Object} TileVariants
 * @property {number} count   pictures (1..MAX_VARIANTS)
 * @property {number} mode    VARY_* bits
 * @property {readonly number[]} slots  atlas slot of each picture (slots[0] is the tile itself)
 */

/** @type {Map<number, TileVariants>} */
const BY_TILE = new Map();
{
  let next = FIRST_EXTRA_SLOT;
  for (const [tile, count, mode] of SPEC) {
    if (BY_TILE.has(tile)) throw new Error(`tileVariants: tile ${tile} listed twice`);
    if (!(count >= 1 && count <= MAX_VARIANTS)) throw new Error(`tileVariants: tile ${tile} has ${count} pictures`);
    const slots = [tile];
    for (let k = 1; k < count; k++) slots.push(next++);
    BY_TILE.set(tile, Object.freeze({ count, mode, slots: Object.freeze(slots) }));
  }
  if (next > ATLAS_SLOTS) throw new Error('tileVariants: the atlas has no room for every variant');
}

/** Every tile with an entry, in SPEC order (tilesHD.js paints exactly these). */
export const VARIANT_TILES = Object.freeze(SPEC.map((s) => s[0]));

/** One past the last slot in use. */
export const USED_SLOTS = Math.max(FIRST_EXTRA_SLOT, ...[...BY_TILE.values()].flatMap((v) => v.slots)) + 1;

/** @param {number} tile @returns {TileVariants|null} */
export function tileVariants(tile) {
  return BY_TILE.get(tile) ?? null;
}

/** How many pictures tile `tile` has (1 for every tile without an entry). */
export function variantCount(tile) {
  return BY_TILE.get(tile)?.count ?? 1;
}

/** Atlas slot of picture `k` of tile `tile` (k wraps; a tile without variants is its own slot). */
export function variantSlot(tile, k) {
  const v = BY_TILE.get(tile);
  if (!v) return tile;
  return v.slots[((k % v.count) + v.count) % v.count];
}

/** The VARY_* bits of tile `tile` (0 for a tile without an entry). */
export function variantMode(tile) {
  return BY_TILE.get(tile)?.mode ?? 0;
}

/**
 * Every (slot → [tile, picture]) pair beyond the tiles themselves, in slot order.
 * @returns {Array<[number, number, number]>} [slot, tile, picture]
 */
export function extraSlots() {
  const out = [];
  for (const [tile, v] of BY_TILE) for (let k = 1; k < v.count; k++) out.push([v.slots[k], tile, k]);
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-cell shade: a block may be a little lighter or darker than its neighbours (natural materials more, made ones less)
// ---------------------------------------------------------------------------------------------------------------

/** [block, ± brightness]. Blocks not listed keep their exact colour (water, glass, metal, lamps, every device). */
const JITTER_SPEC = [
  [B.STONE, 0.05], [B.GRASS_BLOCK, 0.04], [B.DIRT, 0.05], [B.COBBLESTONE, 0.05], [B.OAK_PLANKS, 0.035],
  [B.BEDROCK, 0.05], [B.SAND, 0.03], [B.GRAVEL, 0.05], [B.OAK_LOG, 0.04], [B.OAK_LEAVES, 0.06], [B.COAL_ORE, 0.04],
  [B.IRON_ORE, 0.04], [B.GOLD_ORE, 0.04], [B.DIAMOND_ORE, 0.04], [B.SANDSTONE, 0.03], [B.SNOW_BLOCK, 0.02],
  [B.SNOWY_GRASS, 0.03], [B.BRICKS, 0.035], [B.BOOKSHELF, 0.03], [B.STONE_BRICKS, 0.035], [B.WOOL_WHITE, 0.015],
  [B.WOOL_RED, 0.02], [B.SPRUCE_LOG, 0.04], [B.SPRUCE_PLANKS, 0.035], [B.SPRUCE_LEAVES, 0.06], [B.BIRCH_LOG, 0.03],
  [B.BIRCH_PLANKS, 0.035], [B.BIRCH_LEAVES, 0.06], [B.GRANITE, 0.04], [B.DIORITE, 0.03], [B.ANDESITE, 0.04],
  [B.SLATE, 0.04], [B.MOSSY_COBBLESTONE, 0.05], [B.MOSSY_STONE_BRICKS, 0.04], [B.OBSIDIAN, 0.05], [B.CLAY, 0.03],
  [B.RED_SAND, 0.03], [B.ICE, 0.02], [B.PACKED_ICE, 0.03], [B.HAY_BALE, 0.04], [B.PUMPKIN, 0.04],
  [B.WOOL_ORANGE, 0.02], [B.WOOL_YELLOW, 0.02], [B.WOOL_LIME, 0.02], [B.WOOL_GREEN, 0.02], [B.WOOL_CYAN, 0.02],
  [B.WOOL_LIGHT_BLUE, 0.02], [B.WOOL_BLUE, 0.02], [B.WOOL_PURPLE, 0.02], [B.WOOL_MAGENTA, 0.02], [B.WOOL_PINK, 0.02],
  [B.WOOL_BROWN, 0.02], [B.WOOL_BLACK, 0.02], [B.WOOL_GRAY, 0.02], [B.WOOL_LIGHT_GRAY, 0.02], [B.COPPER_ORE, 0.04],
  [B.TIN_ORE, 0.04], [B.AQUIFER, 0.04], [B.FLINT_GRAVEL, 0.05],
];

/** Leaves also drift a little toward yellow or blue-green, cell by cell (red channel ± this × the brightness roll). */
export const LEAF_HUE_SHIFT = 0.05;

/** BLOCK_JITTER[id]: the ± brightness of block `id` (0: never varies). */
export const BLOCK_JITTER = new Float32Array(256);
/** LEAFY[id] = 1 for the three leaves. */
export const LEAFY = new Uint8Array(256);
for (const [id, amp] of JITTER_SPEC) {
  if (getBlockDef(id).id !== id) throw new Error(`tileVariants: block ${id} is not registered`);
  BLOCK_JITTER[id] = amp;
}
LEAFY[B.OAK_LEAVES] = 1;
LEAFY[B.SPRUCE_LEAVES] = 1;
LEAFY[B.BIRCH_LEAVES] = 1;

/**
 * A well-mixed uint32 from a world cell and a salt (the mesher's per-cell roll: brightness, then one per face).
 * @param {number} q @param {number} y @param {number} r @param {number} [salt=0]
 * @returns {number} uint32
 */
export function variantHash(q, y, r, salt = 0) {
  let h = Math.imul(q | 0, 0x27d4eb2d) ^ Math.imul(r | 0, 0x165667b1) ^ Math.imul((y | 0) + 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ Math.imul(salt | 0, 0x85ebca6b), 0x2c1b3c6d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 12;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 16;
  return h >>> 0;
}
