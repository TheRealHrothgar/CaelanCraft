// Caelancraft — block registry, atlas tile ids, render layers, biomes, culling and UV rules.
// See src/CONTRACTS.md §5 and docs/SPEC-gameplay.md §1–§2. Pure.
import { TILE_UV, UV_INSET, ATLAS_TILES_PER_ROW, WATER_SURFACE_HEIGHT } from './config.js';
import { FACE_TOP, FACE_BOTTOM } from './hex.js';

/** Block ids. */
export const BLOCK = Object.freeze({
  AIR: 0, STONE: 1, GRASS_BLOCK: 2, DIRT: 3, COBBLESTONE: 4, OAK_PLANKS: 5, BEDROCK: 6, WATER: 7,
  SAND: 8, GRAVEL: 9, OAK_LOG: 10, OAK_LEAVES: 11, GLASS: 12, COAL_ORE: 13, IRON_ORE: 14, GOLD_ORE: 15,
  DIAMOND_ORE: 16, SANDSTONE: 17, SNOW_BLOCK: 18, SNOWY_GRASS: 19, BRICKS: 20, BOOKSHELF: 21,
  STONE_BRICKS: 22, WOOL_WHITE: 23, WOOL_RED: 24, RUNE_BLOCK: 25,
  // v0.4 block batch (appended so v2 saves keep their ids)
  SPRUCE_LOG: 26, SPRUCE_PLANKS: 27, SPRUCE_LEAVES: 28, BIRCH_LOG: 29, BIRCH_PLANKS: 30, BIRCH_LEAVES: 31,
  GRANITE: 32, DIORITE: 33, ANDESITE: 34, SLATE: 35, MOSSY_COBBLESTONE: 36, MOSSY_STONE_BRICKS: 37, OBSIDIAN: 38,
  CLAY: 39, RED_SAND: 40, ICE: 41, PACKED_ICE: 42,
  COAL_BLOCK: 43, IRON_BLOCK: 44, GOLD_BLOCK: 45, DIAMOND_BLOCK: 46, COPPER_BLOCK: 47,
  GLOWSTONE: 48, HONEYCOMB_BLOCK: 49, HAY_BALE: 50, PUMPKIN: 51,
  WOOL_ORANGE: 52, WOOL_YELLOW: 53, WOOL_LIME: 54, WOOL_GREEN: 55, WOOL_CYAN: 56, WOOL_LIGHT_BLUE: 57, WOOL_BLUE: 58,
  WOOL_PURPLE: 59, WOOL_MAGENTA: 60, WOOL_PINK: 61, WOOL_BROWN: 62, WOOL_BLACK: 63, WOOL_GRAY: 64, WOOL_LIGHT_GRAY: 65,
  BLACK_HOLE: 66, CAMPFIRE: 67,
  // v0.8 block physics (docs/DESIGN-physics.md §0): flowing / falling water levels and the blast barrel
  WATER_FLOW_1: 68, WATER_FLOW_2: 69, WATER_FLOW_3: 70, WATER_FLOW_4: 71, WATER_FLOW_5: 72, WATER_FLOW_6: 73,
  WATER_FALL: 74, BLAST_BARREL: 75,
});
export const BLOCK_COUNT = 76;

/**
 * Sentinel returned by `World.peekBlock` for a cell in an unloaded chunk (CONTRACTS §9). 255 is never a block id, so
 * every block predicate (isSolid, isFallThrough, …) treats it like AIR — physics rules test for it explicitly.
 */
export const UNLOADED = 255;

/** Atlas tile ids. Tile t is drawn at pixel ((t % 16) * 16, floor(t / 16) * 16). */
export const TILE = Object.freeze({
  STONE: 0, DIRT: 1, GRASS_TOP: 2, GRASS_SIDE: 3, COBBLESTONE: 4, OAK_PLANKS: 5, BEDROCK: 6, WATER: 7,
  SAND: 8, GRAVEL: 9, OAK_LOG_SIDE: 10, OAK_LOG_END: 11, OAK_LEAVES: 12, GLASS: 13, COAL_ORE: 14,
  IRON_ORE: 15, GOLD_ORE: 16, DIAMOND_ORE: 17, SANDSTONE_TOP: 18, SANDSTONE_SIDE: 19, SNOW: 20,
  SNOWY_GRASS_SIDE: 21, BRICKS: 22, BOOKSHELF: 23, STONE_BRICKS: 24, WOOL_WHITE: 25, WOOL_RED: 26,
  RUNE: 27,
  SPRUCE_LOG_SIDE: 28, SPRUCE_LOG_END: 29, SPRUCE_PLANKS: 30, SPRUCE_LEAVES: 31, BIRCH_LOG_SIDE: 32, BIRCH_LOG_END: 33,
  BIRCH_PLANKS: 34, BIRCH_LEAVES: 35, GRANITE: 36, DIORITE: 37, ANDESITE: 38, SLATE: 39, MOSSY_COBBLESTONE: 40,
  MOSSY_STONE_BRICKS: 41, OBSIDIAN: 42, CLAY: 43, RED_SAND: 44, ICE: 45, PACKED_ICE: 46, COAL_BLOCK: 47, IRON_BLOCK: 48,
  GOLD_BLOCK: 49, DIAMOND_BLOCK: 50, COPPER_BLOCK: 51, GLOWSTONE: 52, HONEYCOMB: 53, HAY_BALE_SIDE: 54, HAY_BALE_TOP: 55,
  PUMPKIN_SIDE: 56, PUMPKIN_TOP: 57, WOOL_ORANGE: 58, WOOL_YELLOW: 59, WOOL_LIME: 60, WOOL_GREEN: 61, WOOL_CYAN: 62,
  WOOL_LIGHT_BLUE: 63, WOOL_BLUE: 64, WOOL_PURPLE: 65, WOOL_MAGENTA: 66, WOOL_PINK: 67, WOOL_BROWN: 68, WOOL_BLACK: 69,
  WOOL_GRAY: 70, WOOL_LIGHT_GRAY: 71, BLACK_HOLE: 72,
  CAMPFIRE_SIDE: 73, CAMPFIRE_TOP: 74,
  BARREL_SIDE: 75, BARREL_TOP: 76,
  // Zombie parts (§39; atlas row 15, not block faces): the head's front, its other sides, its top; shirt; trousers; soles.
  ZOMBIE_FACE: 240, ZOMBIE_HEAD_SIDE: 241, ZOMBIE_SCALP: 242, ZOMBIE_SHIRT: 243, ZOMBIE_TROUSERS: 244, ZOMBIE_SOLE: 245,
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
 * @property {boolean} meshed       drawn by the chunk mesher; false for blocks with their own model (campfire), whose
 *                                  tiles are then used only for the hotbar / picker icon
 * @property {boolean} gravity      falls when the cell below is fall-through (sand, red sand, gravel; CONTRACTS §34)
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
    meshed: d.meshed ?? true,
    gravity: d.gravity ?? false,
  };
}

const T = TILE;
const B = BLOCK;

/** Shared flags of the non-source water blocks (flowing levels and falling water). */
const WATER_FAMILY = Object.freeze({
  solid: false, opaque: false, liquid: true, breakable: false, placeable: false, layer: LAYER_TRANSLUCENT, soundGroup: 'water',
});

/** The v0.4 wool colours (white and red predate them): BLOCK/TILE key suffix and display label. */
const WOOL_COLORS = [
  ['ORANGE', 'Orange'], ['YELLOW', 'Yellow'], ['LIME', 'Lime'], ['GREEN', 'Green'], ['CYAN', 'Cyan'],
  ['LIGHT_BLUE', 'Light Blue'], ['BLUE', 'Blue'], ['PURPLE', 'Purple'], ['MAGENTA', 'Magenta'], ['PINK', 'Pink'],
  ['BROWN', 'Brown'], ['BLACK', 'Black'], ['GRAY', 'Gray'], ['LIGHT_GRAY', 'Light Gray'],
];

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
  def({ id: B.SAND, name: 'sand', displayName: 'Sand', tiles: tiles(T.SAND), soundGroup: 'sand', gravity: true }),
  def({ id: B.GRAVEL, name: 'gravel', displayName: 'Gravel', tiles: tiles(T.GRAVEL), soundGroup: 'gravel', gravity: true }),
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
  // Rune Block: a programmable honeycomb cell. Its script and trigger settings live in runes.js (RuneStore),
  // not in the chunk byte array; see CONTRACTS §27.
  def({ id: B.RUNE_BLOCK, name: 'rune_block', displayName: 'Rune Block', tiles: tiles(T.RUNE), soundGroup: 'stone' }),
  // ---- v0.4 batch. Worldgen does not emit any of these yet; they are builder's blocks.
  def({ id: B.SPRUCE_LOG, name: 'spruce_log', displayName: 'Spruce Log', tiles: tiles(T.SPRUCE_LOG_SIDE, T.SPRUCE_LOG_END), soundGroup: 'wood' }),
  def({ id: B.SPRUCE_PLANKS, name: 'spruce_planks', displayName: 'Spruce Planks', tiles: tiles(T.SPRUCE_PLANKS), soundGroup: 'wood' }),
  def({ id: B.SPRUCE_LEAVES, name: 'spruce_leaves', displayName: 'Spruce Leaves', tiles: tiles(T.SPRUCE_LEAVES), opaque: false, cullSame: false, layer: LAYER_CUTOUT, soundGroup: 'leaves' }),
  def({ id: B.BIRCH_LOG, name: 'birch_log', displayName: 'Birch Log', tiles: tiles(T.BIRCH_LOG_SIDE, T.BIRCH_LOG_END), soundGroup: 'wood' }),
  def({ id: B.BIRCH_PLANKS, name: 'birch_planks', displayName: 'Birch Planks', tiles: tiles(T.BIRCH_PLANKS), soundGroup: 'wood' }),
  def({ id: B.BIRCH_LEAVES, name: 'birch_leaves', displayName: 'Birch Leaves', tiles: tiles(T.BIRCH_LEAVES), opaque: false, cullSame: false, layer: LAYER_CUTOUT, soundGroup: 'leaves' }),
  def({ id: B.GRANITE, name: 'granite', displayName: 'Granite', tiles: tiles(T.GRANITE), soundGroup: 'stone' }),
  def({ id: B.DIORITE, name: 'diorite', displayName: 'Diorite', tiles: tiles(T.DIORITE), soundGroup: 'stone' }),
  def({ id: B.ANDESITE, name: 'andesite', displayName: 'Andesite', tiles: tiles(T.ANDESITE), soundGroup: 'stone' }),
  def({ id: B.SLATE, name: 'slate', displayName: 'Slate', tiles: tiles(T.SLATE), soundGroup: 'stone' }),
  def({ id: B.MOSSY_COBBLESTONE, name: 'mossy_cobblestone', displayName: 'Mossy Cobblestone', tiles: tiles(T.MOSSY_COBBLESTONE), soundGroup: 'stone' }),
  def({ id: B.MOSSY_STONE_BRICKS, name: 'mossy_stone_bricks', displayName: 'Mossy Stone Bricks', tiles: tiles(T.MOSSY_STONE_BRICKS), soundGroup: 'stone' }),
  def({ id: B.OBSIDIAN, name: 'obsidian', displayName: 'Obsidian', tiles: tiles(T.OBSIDIAN), soundGroup: 'stone' }),
  def({ id: B.CLAY, name: 'clay', displayName: 'Clay', tiles: tiles(T.CLAY), soundGroup: 'dirt' }),
  def({ id: B.RED_SAND, name: 'red_sand', displayName: 'Red Sand', tiles: tiles(T.RED_SAND), soundGroup: 'sand', gravity: true }),
  // Ice is solid but see-through: translucent layer, faces between two ice cells culled (like water).
  def({ id: B.ICE, name: 'ice', displayName: 'Ice', tiles: tiles(T.ICE), opaque: false, layer: LAYER_TRANSLUCENT, soundGroup: 'glass' }),
  def({ id: B.PACKED_ICE, name: 'packed_ice', displayName: 'Packed Ice', tiles: tiles(T.PACKED_ICE), soundGroup: 'glass' }),
  def({ id: B.COAL_BLOCK, name: 'coal_block', displayName: 'Block of Coal', tiles: tiles(T.COAL_BLOCK), soundGroup: 'stone' }),
  def({ id: B.IRON_BLOCK, name: 'iron_block', displayName: 'Block of Iron', tiles: tiles(T.IRON_BLOCK), soundGroup: 'stone' }),
  def({ id: B.GOLD_BLOCK, name: 'gold_block', displayName: 'Block of Gold', tiles: tiles(T.GOLD_BLOCK), soundGroup: 'stone' }),
  def({ id: B.DIAMOND_BLOCK, name: 'diamond_block', displayName: 'Block of Diamond', tiles: tiles(T.DIAMOND_BLOCK), soundGroup: 'stone' }),
  def({ id: B.COPPER_BLOCK, name: 'copper_block', displayName: 'Block of Copper', tiles: tiles(T.COPPER_BLOCK), soundGroup: 'stone' }),
  // Glowstone only LOOKS lit (bright tile); there is no block-light engine yet.
  def({ id: B.GLOWSTONE, name: 'glowstone', displayName: 'Glowstone', tiles: tiles(T.GLOWSTONE), soundGroup: 'glass' }),
  def({ id: B.HONEYCOMB_BLOCK, name: 'honeycomb_block', displayName: 'Honeycomb Block', tiles: tiles(T.HONEYCOMB), soundGroup: 'cloth' }),
  def({ id: B.HAY_BALE, name: 'hay_bale', displayName: 'Hay Bale', tiles: tiles(T.HAY_BALE_SIDE, T.HAY_BALE_TOP), soundGroup: 'grass' }),
  def({ id: B.PUMPKIN, name: 'pumpkin', displayName: 'Pumpkin', tiles: tiles(T.PUMPKIN_SIDE, T.PUMPKIN_TOP), soundGroup: 'wood' }),
  ...WOOL_COLORS.map(([key, label]) => def({
    id: B[`WOOL_${key}`], name: `wool_${key.toLowerCase()}`, displayName: `${label} Wool`, tiles: tiles(T[`WOOL_${key}`]), soundGroup: 'cloth',
  })),
  // Black Hole: pulls the player and swallows nearby cells (blackholes.js, CONTRACTS §29). Not solid, so the player
  // can fall in — touching it sends them back to spawn. Breakable like any block; breaking it stops it.
  def({ id: B.BLACK_HOLE, name: 'black_hole', displayName: 'Black Hole', tiles: tiles(T.BLACK_HOLE), solid: false, opaque: false, soundGroup: 'glass' }),
  // Campfire: its own model, light, smoke and crackle (campfires.js / campfireRenderer.js, CONTRACTS §32). Not solid and
  // not meshed; its tiles only draw the icon.
  def({ id: B.CAMPFIRE, name: 'campfire', displayName: 'Campfire', tiles: tiles(T.CAMPFIRE_SIDE, T.CAMPFIRE_TOP), solid: false, opaque: false, layer: LAYER_CUTOUT, soundGroup: 'wood', meshed: false }),
  // ---- v0.8 block physics. Flowing water levels 1..6 and falling water are WATER's family (fluids.js, CONTRACTS §35):
  // liquid, never placed or broken by hand, drawn with the water tile. Only WATER itself is a source.
  ...[1, 2, 3, 4, 5, 6].map((k) => def({
    id: B[`WATER_FLOW_${k}`], name: `water_flow_${k}`, displayName: `Flowing Water ${k}`, tiles: tiles(T.WATER), ...WATER_FAMILY,
  })),
  def({ id: B.WATER_FALL, name: 'water_fall', displayName: 'Falling Water', tiles: tiles(T.WATER), ...WATER_FAMILY }),
  // Blast Barrel: an explosive (explosions.js, CONTRACTS §37). A plain solid block until lit (R, a campfire next to it,
  // `ignite`, or a blast); lit barrels are entities. Lid tile on top and bottom.
  def({ id: B.BLAST_BARREL, name: 'blast_barrel', displayName: 'Blast Barrel', tiles: tiles(T.BARREL_SIDE, T.BARREL_TOP), soundGroup: 'wood' }),
];

/** Default hotbar: grass, dirt, stone, cobble, planks, log, leaves, glass, bricks. */
export const DEFAULT_HOTBAR = Object.freeze([
  B.GRASS_BLOCK, B.DIRT, B.STONE, B.COBBLESTONE, B.OAK_PLANKS, B.OAK_LOG, B.OAK_LEAVES, B.GLASS, B.BRICKS,
]);

/** Order of the 67 placeable blocks in the block picker, grouped by family. */
export const PICKER_ORDER = Object.freeze([
  // stone
  B.STONE, B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.GRANITE, B.DIORITE, B.ANDESITE,
  B.SLATE, B.OBSIDIAN, B.BRICKS, B.SANDSTONE,
  // earth
  B.DIRT, B.GRASS_BLOCK, B.SNOWY_GRASS, B.SAND, B.RED_SAND, B.GRAVEL, B.CLAY, B.SNOW_BLOCK, B.ICE, B.PACKED_ICE,
  B.HAY_BALE, B.PUMPKIN,
  // wood
  B.OAK_LOG, B.OAK_PLANKS, B.OAK_LEAVES, B.SPRUCE_LOG, B.SPRUCE_PLANKS, B.SPRUCE_LEAVES, B.BIRCH_LOG, B.BIRCH_PLANKS,
  B.BIRCH_LEAVES, B.BOOKSHELF, B.GLASS, B.GLOWSTONE,
  // minerals
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.COAL_BLOCK, B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK,
  B.COPPER_BLOCK, B.HONEYCOMB_BLOCK,
  // wool, light to dark around the colour wheel
  B.WOOL_WHITE, B.WOOL_LIGHT_GRAY, B.WOOL_GRAY, B.WOOL_BLACK, B.WOOL_BROWN, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW,
  B.WOOL_LIME, B.WOOL_GREEN, B.WOOL_CYAN, B.WOOL_LIGHT_BLUE, B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_MAGENTA, B.WOOL_PINK,
  // special
  B.CAMPFIRE, B.BLAST_BARREL, B.BLACK_HOLE, B.RUNE_BLOCK, B.WATER,
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
/** false for blocks drawn by their own model instead of the chunk mesher (campfire). */
export function isMeshed(id) {
  return getBlockDef(id).meshed;
}
/** Falls when the cell below is fall-through (BlockDef.gravity: sand, red sand, gravel). */
export function isGravityBlock(id) {
  return getBlockDef(id).gravity;
}
/** OAK / SPRUCE / BIRCH leaves: never load-bearing (CONTRACTS §36). */
export function isLeaves(id) {
  return id === B.OAK_LEAVES || id === B.SPRUCE_LEAVES || id === B.BIRCH_LEAVES;
}
/** OAK / SPRUCE / BIRCH logs (what a tree is made of, CONTRACTS §36). */
export function isLog(id) {
  return id === B.OAK_LOG || id === B.SPRUCE_LOG || id === B.BIRCH_LOG;
}
/** WATER, WATER_FLOW_1..6 or WATER_FALL. */
export function isWater(id) {
  return id === B.WATER || (id >= B.WATER_FLOW_1 && id <= B.WATER_FALL);
}
/** Only WATER is a source (never changes by itself; FLOW/FALL are derived from sources). */
export function isWaterSource(id) {
  return id === B.WATER;
}
/** Water level: WATER and WATER_FALL → 7, WATER_FLOW_k → k, anything else → 0. */
export function waterLevel(id) {
  if (id === B.WATER || id === B.WATER_FALL) return 7;
  if (id >= B.WATER_FLOW_1 && id <= B.WATER_FLOW_6) return id - B.WATER_FLOW_1 + 1;
  return 0;
}
/**
 * A falling block passes through (and a gravity block / campfire falls into) this cell: AIR, any water (sources too —
 * sand sinks to the bottom of a lake, CONTRACTS §35.6) or a CAMPFIRE. NOT the UNLOADED sentinel.
 */
export function isFallThrough(id) {
  return id === B.AIR || id === B.CAMPFIRE || id === B.WATER || (id >= B.WATER_FLOW_1 && id <= B.WATER_FALL);
}
/**
 * Height of the water surface inside a water cell, above the cell's bottom (CONTRACTS §35.4): 1 when water is above it
 * (the surface is further up), else WATER_SURFACE_HEIGHT for a source or falling water and k/7 of it for WATER_FLOW_k;
 * 0 for anything that is not water. The mesher draws these surfaces and physics.js wades / swims by them.
 * @param {number} id
 * @param {number} aboveId  the block above the cell
 * @returns {number}
 */
export function waterSurfaceHeight(id, aboveId) {
  const level = waterLevel(id);
  if (level === 0) return 0;
  if (isWater(aboveId)) return 1;
  return level === 7 ? WATER_SURFACE_HEIGHT : (level * WATER_SURFACE_HEIGHT) / 7;
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
