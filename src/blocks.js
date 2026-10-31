// Caelancraft — block registry, atlas tile ids, render layers, biomes, culling and UV rules.
// See src/CONTRACTS.md §5 and docs/SPEC-gameplay.md §1–§2. Pure.
import { TILE_UV, UV_INSET, ATLAS_TILES_PER_ROW } from './config.js';
import { FACE_TOP, FACE_BOTTOM } from './hex.js';

/** Block ids. */
export const BLOCK = Object.freeze({
  AIR: 0, STONE: 1, GRASS_BLOCK: 2, DIRT: 3, COBBLESTONE: 4, OAK_PLANKS: 5, BEDROCK: 6, WATER: 7,
  SAND: 8, GRAVEL: 9, OAK_LOG: 10, OAK_LEAVES: 11, GLASS: 12, COAL_ORE: 13, IRON_ORE: 14, GOLD_ORE: 15,
  DIAMOND_ORE: 16, SANDSTONE: 17, SNOW_BLOCK: 18, SNOWY_GRASS: 19, BRICKS: 20, BOOKSHELF: 21,
  STONE_BRICKS: 22, WOOL_WHITE: 23, WOOL_RED: 24,
});
export const BLOCK_COUNT = 25;

/** Atlas tile ids. Tile t is drawn at pixel ((t % 16) * 16, floor(t / 16) * 16). */
export const TILE = Object.freeze({
  STONE: 0, DIRT: 1, GRASS_TOP: 2, GRASS_SIDE: 3, COBBLESTONE: 4, OAK_PLANKS: 5, BEDROCK: 6, WATER: 7,
  SAND: 8, GRAVEL: 9, OAK_LOG_SIDE: 10, OAK_LOG_END: 11, OAK_LEAVES: 12, GLASS: 13, COAL_ORE: 14,
  IRON_ORE: 15, GOLD_ORE: 16, DIAMOND_ORE: 17, SANDSTONE_TOP: 18, SANDSTONE_SIDE: 19, SNOW: 20,
  SNOWY_GRASS_SIDE: 21, BRICKS: 22, BOOKSHELF: 23, STONE_BRICKS: 24, WOOL_WHITE: 25, WOOL_RED: 26,
  MISSING: 255,
});
/** Every tile id the atlas must paint. */
export const TILE_IDS = Object.freeze(Object.values(TILE));

export const LAYER_OPAQUE = 0;
export const LAYER_CUTOUT = 1;
export const LAYER_TRANSLUCENT = 2;

export const BIOME = Object.freeze({
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, MOUNTAINS: 6, SNOWY_PEAKS: 7,
});
export const BIOME_NAMES = Object.freeze(['ocean', 'beach', 'plains', 'forest', 'desert', 'snowy', 'mountains', 'snowy_peaks']);

export const SOUND_GROUPS = Object.freeze([
  'stone', 'dirt', 'grass', 'sand', 'gravel', 'wood', 'leaves', 'glass', 'snow', 'cloth', 'water',
]);

/**
 * @typedef {Object} BlockDef
 * @property {number} id
 * @property {string} name          lower_snake
 * @property {string} displayName
 * @property {number[]} tiles       8 tile ids, index = FaceIndex (sides 0..5, 6 top, 7 bottom)
 * @property {boolean} solid        blocks the player
 * @property {boolean} opaque       fully hides adjacent faces and occludes AO
 * @property {boolean} liquid
 * @property {boolean} breakable
 * @property {boolean} placeable    can be put in the hotbar / placed
 * @property {boolean} cullSame     faces between two blocks of this id are culled
 * @property {number} layer         RenderLayer
 * @property {string|null} soundGroup
 */

/** tiles helper: six sides, then top, then bottom */
function tiles(side, top = side, bottom = top) {
  return [side, side, side, side, side, side, top, bottom];
}

/**
 * @param {Partial<BlockDef> & {id:number, name:string, displayName:string, tiles:number[]}} d
 * @returns {BlockDef}
 */
function def(d) {
  const solid = d.solid ?? true;
  const layer = d.layer ?? LAYER_OPAQUE;
  return {
    id: d.id,
    name: d.name,
    displayName: d.displayName,
    tiles: d.tiles,
    solid,
    opaque: d.opaque ?? (solid && layer === LAYER_OPAQUE),
    liquid: d.liquid ?? false,
    breakable: d.breakable ?? true,
    placeable: d.placeable ?? true,
    cullSame: d.cullSame ?? true,
    layer,
    soundGroup: d.soundGroup ?? null,
  };
}

const T = TILE;
const B = BLOCK;

/** @type {BlockDef[]} indexed by id */
export const BLOCKS = [
  def({ id: B.AIR, name: 'air', displayName: 'Air', tiles: tiles(T.MISSING), solid: false, opaque: false, breakable: false, placeable: false }),
  def({ id: B.STONE, name: 'stone', displayName: 'Stone', tiles: tiles(T.STONE), soundGroup: 'stone' }),
  def({ id: B.GRASS_BLOCK, name: 'grass_block', displayName: 'Grass Block', tiles: tiles(T.GRASS_SIDE, T.GRASS_TOP, T.DIRT), soundGroup: 'grass' }),
  def({ id: B.DIRT, name: 'dirt', displayName: 'Dirt', tiles: tiles(T.DIRT), soundGroup: 'dirt' }),
  def({ id: B.COBBLESTONE, name: 'cobblestone', displayName: 'Cobblestone', tiles: tiles(T.COBBLESTONE), soundGroup: 'stone' }),
  def({ id: B.OAK_PLANKS, name: 'oak_planks', displayName: 'Oak Planks', tiles: tiles(T.OAK_PLANKS), soundGroup: 'wood' }),
  def({ id: B.BEDROCK, name: 'bedrock', displayName: 'Bedrock', tiles: tiles(T.BEDROCK), breakable: false, placeable: false, soundGroup: 'stone' }),
  def({ id: B.WATER, name: 'water', displayName: 'Water', tiles: tiles(T.WATER), solid: false, opaque: false, liquid: true, breakable: false, layer: LAYER_TRANSLUCENT, soundGroup: 'water' }),
  def({ id: B.SAND, name: 'sand', displayName: 'Sand', tiles: tiles(T.SAND), soundGroup: 'sand' }),
  def({ id: B.GRAVEL, name: 'gravel', displayName: 'Gravel', tiles: tiles(T.GRAVEL), soundGroup: 'gravel' }),
  def({ id: B.OAK_LOG, name: 'oak_log', displayName: 'Oak Log', tiles: tiles(T.OAK_LOG_SIDE, T.OAK_LOG_END, T.OAK_LOG_END), soundGroup: 'wood' }),
  def({ id: B.OAK_LEAVES, name: 'oak_leaves', displayName: 'Oak Leaves', tiles: tiles(T.OAK_LEAVES), opaque: false, cullSame: false, layer: LAYER_CUTOUT, soundGroup: 'leaves' }),
  def({ id: B.GLASS, name: 'glass', displayName: 'Glass', tiles: tiles(T.GLASS), opaque: false, layer: LAYER_CUTOUT, soundGroup: 'glass' }),
  def({ id: B.COAL_ORE, name: 'coal_ore', displayName: 'Coal Ore', tiles: tiles(T.COAL_ORE), soundGroup: 'stone' }),
  def({ id: B.IRON_ORE, name: 'iron_ore', displayName: 'Iron Ore', tiles: tiles(T.IRON_ORE), soundGroup: 'stone' }),
  def({ id: B.GOLD_ORE, name: 'gold_ore', displayName: 'Gold Ore', tiles: tiles(T.GOLD_ORE), soundGroup: 'stone' }),
  def({ id: B.DIAMOND_ORE, name: 'diamond_ore', displayName: 'Diamond Ore', tiles: tiles(T.DIAMOND_ORE), soundGroup: 'stone' }),
  def({ id: B.SANDSTONE, name: 'sandstone', displayName: 'Sandstone', tiles: tiles(T.SANDSTONE_SIDE, T.SANDSTONE_TOP, T.SANDSTONE_TOP), soundGroup: 'stone' }),
  def({ id: B.SNOW_BLOCK, name: 'snow_block', displayName: 'Snow Block', tiles: tiles(T.SNOW), soundGroup: 'snow' }),
  def({ id: B.SNOWY_GRASS, name: 'snowy_grass', displayName: 'Snowy Grass', tiles: tiles(T.SNOWY_GRASS_SIDE, T.SNOW, T.DIRT), soundGroup: 'snow' }),
  def({ id: B.BRICKS, name: 'bricks', displayName: 'Bricks', tiles: tiles(T.BRICKS), soundGroup: 'stone' }),
  def({ id: B.BOOKSHELF, name: 'bookshelf', displayName: 'Bookshelf', tiles: tiles(T.BOOKSHELF, T.OAK_PLANKS, T.OAK_PLANKS), soundGroup: 'wood' }),
  def({ id: B.STONE_BRICKS, name: 'stone_bricks', displayName: 'Stone Bricks', tiles: tiles(T.STONE_BRICKS), soundGroup: 'stone' }),
  def({ id: B.WOOL_WHITE, name: 'wool_white', displayName: 'White Wool', tiles: tiles(T.WOOL_WHITE), soundGroup: 'cloth' }),
  def({ id: B.WOOL_RED, name: 'wool_red', displayName: 'Red Wool', tiles: tiles(T.WOOL_RED), soundGroup: 'cloth' }),
];

/** Default hotbar: grass, dirt, stone, cobble, planks, log, leaves, glass, bricks. */
export const DEFAULT_HOTBAR = Object.freeze([
  B.GRASS_BLOCK, B.DIRT, B.STONE, B.COBBLESTONE, B.OAK_PLANKS, B.OAK_LOG, B.OAK_LEAVES, B.GLASS, B.BRICKS,
]);

/** Order of the 23 placeable blocks in the block picker. */
export const PICKER_ORDER = Object.freeze([
  B.STONE, B.COBBLESTONE, B.STONE_BRICKS, B.DIRT, B.GRASS_BLOCK, B.SNOWY_GRASS, B.SAND, B.SANDSTONE, B.GRAVEL,
  B.SNOW_BLOCK, B.OAK_LOG, B.OAK_PLANKS, B.OAK_LEAVES, B.BOOKSHELF, B.GLASS, B.BRICKS, B.WOOL_WHITE, B.WOOL_RED,
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.WATER,
]);

/** @returns {BlockDef} the block definition; unknown ids return the AIR definition */
export function getBlockDef(id) {
  return BLOCKS[id] ?? BLOCKS[0];
}
export function isSolid(id) {
  return getBlockDef(id).solid;
}
export function isOpaque(id) {
  return getBlockDef(id).opaque;
}
export function isLiquid(id) {
  return getBlockDef(id).liquid;
}
export function isBreakable(id) {
  return getBlockDef(id).breakable;
}
export function isPlaceable(id) {
  return getBlockDef(id).placeable;
}
/** AIR or a liquid can be replaced by a placed block. */
export function isReplaceable(id) {
  return id === B.AIR || getBlockDef(id).liquid;
}
/** The raycast stops on targetable blocks: anything that is not AIR and not a liquid. */
export function isTargetable(id) {
  return id !== B.AIR && !getBlockDef(id).liquid;
}
export function getRenderLayer(id) {
  return getBlockDef(id).layer;
}
/** @param {number} face FaceIndex @returns {number} tile id */
export function getFaceTile(id, face) {
  return getBlockDef(id).tiles[face] ?? T.MISSING;
}

/**
 * Culling rule. `a` is the block whose face is considered, `b` its neighbour in the face direction.
 * @returns {boolean} true when the face of `a` toward `b` must be rendered
 */
export function shouldRenderFace(a, b) {
  if (a === B.AIR) return false;
  const da = getBlockDef(a);
  const db = getBlockDef(b);
  if (da.opaque) return !db.opaque;
  if (b === a) return !da.cullSame;
  return !db.opaque;
}

/**
 * Atlas UV rectangle of a tile with UV_INSET applied. flipY = false: v0 is the TOP row of the tile image.
 * @returns {[number, number, number, number]} [u0, v0, u1, v1]
 */
export function tileToUV(tile) {
  const tx = tile % ATLAS_TILES_PER_ROW;
  const ty = Math.floor(tile / ATLAS_TILES_PER_ROW);
  return [
    tx * TILE_UV + UV_INSET,
    ty * TILE_UV + UV_INSET,
    (tx + 1) * TILE_UV - UV_INSET,
    (ty + 1) * TILE_UV - UV_INSET,
  ];
}

// Re-export the two face constants most callers need alongside block helpers.
export { FACE_TOP, FACE_BOTTOM };
