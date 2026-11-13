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
  // v0.8 block physics (docs/DESIGN-physics.md §0): flowing / falling water levels and the powder keg. POWDER_KEG is the
  // canonical key (DESIGN-circuits §1.1); BLAST_BARREL is its deprecated alias with the same id, kept so the explosions and
  // physics code and their tests need no rename. New code writes POWDER_KEG.
  WATER_FLOW_1: 68, WATER_FLOW_2: 69, WATER_FLOW_3: 70, WATER_FLOW_4: 71, WATER_FLOW_5: 72, WATER_FLOW_6: 73,
  WATER_FALL: 74, POWDER_KEG: 75, BLAST_BARREL: 75,
  // v0.9 survival (docs/DESIGN-survival.md §8.1): ores, wild plants and their picked variants, workplaces, containers,
  // ground litter and the cold fire pit. Only generation-2 worlds generate the ores, plants and litter.
  COPPER_ORE: 76, TIN_ORE: 77, HONEYBERRY_BUSH: 78, HONEYBERRY_BUSH_BARE: 79, TUSSOCK: 80, CATTAILS: 81, TUBER_PLANT: 82,
  PRICKLY_PEAR: 83, PRICKLY_PEAR_BARE: 84, WORK_STUMP: 85, KILN: 86, BLOOMERY: 87, FORGE: 88, WICKER_BASKET: 89,
  SLEEPING_HIDE: 90, REMAINS: 91, LOOSE_STONES: 92, FALLEN_BRANCHES: 93, FIRE_PIT: 94,
  // Powder and circuits (docs/DESIGN-circuits.md §1.2–§1.3, renumbered after survival's 76–94): the dormant Collapsar Charge,
  // the Powder Fuse, the Torch, four wires and the devices. Worldgen never emits them; their state lives in circuitStore.js
  // and circuits.js, never in the block id.
  COLLAPSAR_CHARGE: 95, POWDER_FUSE: 96, TORCH: 97, COPPER_WIRE: 98, BROWN_WIRE: 99, WHITE_WIRE: 100, EARTH_WIRE: 101,
  TERMINAL_BOARD: 102, VOLTAIC_BATTERY: 103, BLASTING_MACHINE: 104, SELENIUM_PANEL: 105, KNIFE_SWITCH: 106, PUSH_BUTTON: 107,
  CLOCKWORK_TIMER: 108, RELAY: 109, IGNITER: 110, FILAMENT_LAMP: 111, ELECTRIC_BELL: 112, SPARK_TRANSMITTER: 113,
  COHERER_RECEIVER: 114,
  // v0.11 (CONTRACTS §67): the Workbench, the workshop where the advanced circuit devices are made
  WORKBENCH: 115,
  // v0.11 (CONTRACTS §69): the Snare — set, baited (R with food), and sprung (holding an animal); all three give the Snare
  SNARE: 116, SNARE_BAITED: 117, SNARE_SPRUNG: 118,
  // v0.13's Flinty Gravel, withdrawn in v0.14 (CONTRACTS §76: it read as coal). The id stays for saves made in between:
  // it looks, digs and falls exactly like gravel and is never generated or placed.
  FLINT_GRAVEL: 119,
  // v0.14 (§76 water): Tainted Water — a murky still-water SOURCE (most generation-3 ponds). It is water in every respect
  // (isWater, isWaterSource, level 7, fall-through, liquid); only its look and what drinking it does differ.
  TAINTED_WATER: 120,
  // v0.14 (§76 fauna): a pheasant's or turkey's nest on the ground, with eggs (R picks them). Its picked twin is 132.
  GROUND_NEST: 121,
  // v0.14 (§76 flora): the new wild plants of generation 3. Two mushrooms that look alike (one feeds, one poisons), two
  // roots, a nut thicket and a fruit bush with their picked variants (which regrow), and the healing herb with its cut
  // variant.
  HONEYCAP_MUSHROOM: 122, FRECKLECAP_MUSHROOM: 123, ONION_PLANT: 124, CARROT_PLANT: 125, HAZEL_THICKET: 126,
  HAZEL_THICKET_BARE: 127, CRAB_APPLE_BUSH: 128, CRAB_APPLE_BUSH_BARE: 129, HEALWORT_PLANT: 130, HEALWORT_PLANT_BARE: 131,
  // v0.14 (§76 fauna): the nest once its eggs are taken (a hen lays in it again)
  GROUND_NEST_EMPTY: 132,
  // §80 farming: a seed in the ground and the sprout it becomes, one of each per crop kind, in CROP_ROWS order.
  // The id carries the whole state of a planted cell (farming.js Growth reads it), so a save needs no field for it.
  PLANTED_CARROT: 133, PLANTED_ONION: 134, PLANTED_TUBER: 135, PLANTED_HONEYBERRY: 136, PLANTED_HAZEL: 137,
  PLANTED_CRAB_APPLE: 138, PLANTED_HEALWORT: 139, PLANTED_PRICKLY_PEAR: 140, PLANTED_CATTAILS: 141,
  CARROT_SPROUT: 142, ONION_SPROUT: 143, TUBER_SPROUT: 144, HONEYBERRY_SPROUT: 145, HAZEL_SPROUT: 146,
  CRAB_APPLE_SPROUT: 147, HEALWORT_SPROUT: 148, PRICKLY_PEAR_SPROUT: 149, CATTAILS_SPROUT: 150,
  // §81: plants that are not food. Greenery (a fern, daisies, a thistle), the two look-alikes that poison (the Hemlock
  // beside the Wild Carrot, the Nightshade beside the Honeyberry, with its picked variant) and two plants worth having
  // (Flax for fibre, Aloe for its leaf). Only generation-4 worlds generate them.
  FERN: 151, MEADOW_DAISIES: 152, THISTLE: 153, HEMLOCK: 154, NIGHTSHADE_BUSH: 155, NIGHTSHADE_BUSH_BARE: 156,
  FLAX: 157, ALOE: 158,
  // §83 (the laws of water): standing water has three depths. WATER and TAINTED_WATER are FULL; these are the same two
  // SOURCES with less in the cell: low (about two thirds) and shallow (ankle-deep). Never placed by hand, no item: a
  // pool gets there by being drunk from, drying in the sun, spilling through a breach or filling in the rain.
  WATER_LOW: 159, WATER_SHALLOW: 160, TAINTED_WATER_LOW: 161, TAINTED_WATER_SHALLOW: 162,
  // §85 (a place to stay): what a homestead is built from. A natural SPRING (only generation-5 worlds generate it) and
  // a WELL give water a few times a day: drawn from, each becomes its *_DRAWN twin and comes back by itself. A
  // RAIN_BARREL fills in the rain and stores water: the id carries how many pots it holds (0..3), so a save needs no
  // field for it. Two places to sleep: a GRASS_BED and a BED (furniture: the sleep rules read these keys).
  SPRING: 163, SPRING_DRAWN: 164, WELL: 165, WELL_DRAWN: 166,
  RAIN_BARREL: 167, RAIN_BARREL_1: 168, RAIN_BARREL_2: 169, RAIN_BARREL_3: 170, GRASS_BED: 171, BED: 172,
});
export const BLOCK_COUNT = 173;

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
  // v0.9 survival blocks (§8.1). PLANT_TOP_CLEAR is all alpha 0: the top and bottom of the short plants, litter and fire pit.
  COPPER_ORE: 77, TIN_ORE: 78, HONEYBERRY_BUSH: 79, HONEYBERRY_BUSH_BARE: 80, TUSSOCK: 81, CATTAILS_SIDE: 82, CATTAILS_TOP: 83,
  TUBER_PLANT: 84, PRICKLY_PEAR: 85, PRICKLY_PEAR_BARE: 86, STUMP_SIDE: 87, STUMP_TOP: 88, KILN_SIDE: 89, KILN_TOP: 90,
  BLOOMERY_SIDE: 91, BLOOMERY_TOP: 92, FORGE_SIDE: 93, FORGE_TOP: 94, BASKET_SIDE: 95, BASKET_TOP: 96, HIDE_SIDE: 97,
  HIDE_TOP: 98, REMAINS_SIDE: 99, REMAINS_TOP: 100, PLANT_TOP_CLEAR: 101, LOOSE_STONES: 102, FALLEN_BRANCHES: 103,
  FIRE_PIT_SIDE: 104,
  // Powder and circuits (DESIGN-circuits §1.4; painted by circuitTiles.js). CIRCUIT_CLEAR is all alpha 0: the sides and bottom
  // of the thin parts. POWDER_FUSE, TORCH, the four wires and every device's *_TOP are flat pictures on an alpha-0 background,
  // drawn only as icons; a device's *_SIDE is a swatch of its model's main colour that nothing draws.
  CIRCUIT_CLEAR: 160, COLLAPSAR_SIDE: 161, COLLAPSAR_TOP: 162, POWDER_FUSE: 163, TORCH: 164, COPPER_WIRE: 165, BROWN_WIRE: 166,
  WHITE_WIRE: 167, EARTH_WIRE: 168, TERMINAL_SIDE: 169, TERMINAL_TOP: 170, BATTERY_SIDE: 171, BATTERY_TOP: 172,
  BLASTER_SIDE: 173, BLASTER_TOP: 174, SELENIUM_SIDE: 175, SELENIUM_TOP: 176, SWITCH_SIDE: 177, SWITCH_TOP: 178,
  BUTTON_SIDE: 179, BUTTON_TOP: 180, TIMER_SIDE: 181, TIMER_TOP: 182, RELAY_SIDE: 183, RELAY_TOP: 184, IGNITER_SIDE: 185,
  IGNITER_TOP: 186, LAMP_SIDE: 187, LAMP_TOP: 188, BELL_SIDE: 189, BELL_TOP: 190, TX_SIDE: 191, TX_TOP: 192, RX_SIDE: 193,
  RX_TOP: 194,
  // v0.11 (CONTRACTS §67): the Workbench
  WORKBENCH_SIDE: 195, WORKBENCH_TOP: 196,
  // v0.11 (CONTRACTS §69, §70): the snares (floor decals), and loose stones that hold flint
  SNARE: 197, SNARE_BAITED: 198, SNARE_SPRUNG: 199, LOOSE_STONES_FLINT: 200,
  // v0.13 (CONTRACTS §75): the skins of the 3D ground litter (a rock, a flint nodule, a stick). 204 was the Flinty Gravel's
  // (withdrawn, §76) and is free.
  LITTER_ROCK: 201, LITTER_FLINT: 202, LITTER_STICK: 203,
  // v0.14 (§76 water): the murky green-brown of Tainted Water (204)
  TAINTED_WATER: 204,
  // §80 farming: a mound of tilled earth with a marker twig, and the same mound with a two-leaf seedling. Every
  // planted block shares the first and every sprout the second (207 is unused).
  SEEDBED: 205, SPROUT: 206,
  // v0.14 (§76 flora): the new wild plants, one sprite each
  HONEYCAP_MUSHROOM: 208, FRECKLECAP_MUSHROOM: 209, ONION_PLANT: 210, CARROT_PLANT: 211, HAZEL_THICKET: 212,
  HAZEL_THICKET_BARE: 213, CRAB_APPLE_BUSH: 214, CRAB_APPLE_BUSH_BARE: 215, HEALWORT_PLANT: 216, HEALWORT_PLANT_BARE: 217,
  // §81: the plants that are not food, one sprite each (the picked Nightshade shows the picked Honeyberry's; 225–227 of
  // the flora range are unused)
  FERN: 218, MEADOW_DAISIES: 219, THISTLE: 220, HEMLOCK: 221, NIGHTSHADE_BUSH: 222, FLAX: 223, ALOE: 224,
  // §85 (a place to stay), in the ids the flora range left free (207, 225–227) and the eight after the nest's (232–239;
  // 238 and 239 stay free). The spring is a prism: its rocky side, its pool, its pool drawn. The others are small 3D
  // models: each has its PICTURE (the Pack's icon, a flat 2D drawing) and, where the picture has too little solid colour
  // to wrap a box, a SKIN of plain swatches its faces are cut from (plantModels.js `tile`).
  SPRING_SIDE: 207, SPRING_TOP: 225, SPRING_DRAWN_TOP: 226, WELL: 227,
  WELL_SKIN: 232, RAIN_BARREL: 233, RAIN_BARREL_SKIN: 234, GRASS_BED: 235, BED: 236, BED_SKIN: 237,
  // v0.14 (§76 fauna): the ground nest's pictures (its icon, and what its crumbs are coloured from) and the skins its 3D
  // pieces are cut from (woven dry grass, a speckled eggshell)
  GROUND_NEST: 228, GROUND_NEST_EMPTY: 229, LITTER_NEST: 230, LITTER_EGG: 231,
  // Zombie parts (§39; atlas row 15, not block faces): the head's front, its other sides, its top; shirt; trousers; soles.
  ZOMBIE_FACE: 240, ZOMBIE_HEAD_SIDE: 241, ZOMBIE_SCALP: 242, ZOMBIE_SHIRT: 243, ZOMBIE_TROUSERS: 244, ZOMBIE_SOLE: 245,
  // The Hollow Watcher (§40; atlas row 15, not block faces): its ash-grey stone, the glow mask of that stone's cracks
  // (it must sit one tile right of the stone: the renderer reads it through a shifted clone of the atlas), its smoke.
  WATCHER_STONE: 250, WATCHER_CRACKS: 251, WATCHER_SMOKE: 252,
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
 * @property {boolean} meshed       drawn by the chunk mesher; false for blocks with their own model (campfire, black hole,
 *                                  the circuit parts but the keg), whose tiles are then used only for the hotbar / picker icon
 * @property {boolean} gravity      falls when the cell below is fall-through (sand, red sand, gravel; CONTRACTS §34)
 * @property {'prism'|'flat'} icon  how atlas.drawBlockIcon draws its hotbar / picker icon: 'prism' (default) the hexagonal
 *                                  prism; 'flat' the TOP tile alone as an unskewed 2D picture (the circuit parts but the keg:
 *                                  thin parts and device models, which are not prisms; DESIGN-circuits §1.5; and the plants
 *                                  and ground litter, which are sprites and decals)
 * @property {'prism'|'model'|'decal'|'litter'} shape  how the chunk mesher draws it: 'prism' (default) the hexagonal prism;
 *                                  'model' a small 3D model of boxes and leaf cards cut from the block's TOP tile (the wild
 *                                  plants: plantModels.js, CONTRACTS §78; they were three crossed pictures until v0.15;
 *                                  the planted seeds and sprouts of §80; and the well, the rain barrel and the two beds
 *                                  of §85);
 *                                  'decal' one flat picture of the TOP tile lying on the cell's floor (the snares); 'litter'
 *                                  a few small 3D pieces lying on the floor (loose stones, fallen branches: CONTRACTS §75).
 *                                  The terrain stays hexagonal prisms.
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
    icon: d.icon ?? 'prism',
    shape: d.shape ?? 'prism',
  };
}

const T = TILE;
const B = BLOCK;

/** Shared flags of the non-source water blocks (flowing levels and falling water). */
const WATER_FAMILY = Object.freeze({
  solid: false, opaque: false, liquid: true, breakable: false, placeable: false, layer: LAYER_TRANSLUCENT, soundGroup: 'water',
});

/**
 * Flags of the survival plants (§8.1 "PLANT"), also used by the blocks with "PLANT flags" (belongings, litter, the fire
 * pit): walk-through, see-through cutout prisms that never cull against themselves. They stay not replaceable (a block is
 * never placed into one) and not fall-through (sand rests on them); a block's own sound overrides 'leaves'.
 */
const PLANT = Object.freeze({
  solid: false, opaque: false, layer: LAYER_CUTOUT, cullSame: false, soundGroup: 'leaves',
});

/** The wild plants: PLANT flags drawn as small 3D models cut from their picture (plantModels.js, §78), with that picture as a flat icon. */
const SPRITE = Object.freeze({ ...PLANT, shape: /** @type {'model'} */ ('model'), icon: /** @type {'flat'} */ ('flat') });

/**
 * §85: the well and the rain barrel — SOLID blocks (the cell collides, carries what is put on it and holds water back)
 * drawn as a small 3D model like a plant, so not opaque: the terrain draws every face round them. Flat icon.
 */
const FURNITURE = Object.freeze({
  opaque: false, layer: LAYER_CUTOUT, cullSame: false, shape: /** @type {'model'} */ ('model'), icon: /** @type {'flat'} */ ('flat'),
});

/** The ground litter: PLANT flags drawn as small 3D rocks or sticks on the cell's floor (§75); its icon is its flat picture. */
const LITTER = Object.freeze({ ...PLANT, shape: /** @type {'litter'} */ ('litter'), icon: /** @type {'flat'} */ ('flat') });

/** The snares: PLANT flags drawn as a flat picture on the cell's floor (every face is that one tile), flat icon. */
const DECAL = Object.freeze({ ...PLANT, shape: /** @type {'decal'} */ ('decal'), icon: /** @type {'flat'} */ ('flat') });

/**
 * Flags of the thin circuit parts (DESIGN-circuits §1.2 "THIN": the Powder Fuse, the Torch and the four wires): walk-through,
 * not load-bearing, never meshed (circuitRenderer draws them) and shown as a flat icon of their top tile. A cell holds one
 * id, so a thin part still blocks water and is not fall-through (sand rests on it), like any block.
 */
const THIN = Object.freeze({
  solid: false, opaque: false, layer: LAYER_CUTOUT, cullSame: false, meshed: false, icon: /** @type {'flat'} */ ('flat'),
});

/**
 * Flags of the 14 circuit devices (the user's "fun and simple" redo of DESIGN-circuits §1.2 "CAB"): each is a small 3D
 * model drawn by circuitRenderer (circuitGeometry.MODELS), not a meshed hex cabinet. Still solid (the cell collides,
 * targets, carries what is put on it and is load-bearing as a whole cell), but not opaque, so the terrain draws every face
 * round it, and not meshed. The icon is its top tile, a flat picture of the model; the side tile is a swatch of its main
 * colour that nothing draws.
 */
const MODEL = Object.freeze({
  opaque: false, layer: LAYER_CUTOUT, cullSame: false, meshed: false, icon: /** @type {'flat'} */ ('flat'),
});

/** The v0.4 wool colours (white and red predate them): BLOCK/TILE key suffix and display label. */
const WOOL_COLORS = [
  ['ORANGE', 'Orange'], ['YELLOW', 'Yellow'], ['LIME', 'Lime'], ['GREEN', 'Green'], ['CYAN', 'Cyan'],
  ['LIGHT_BLUE', 'Light Blue'], ['BLUE', 'Blue'], ['PURPLE', 'Purple'], ['MAGENTA', 'Magenta'], ['PINK', 'Pink'],
  ['BROWN', 'Brown'], ['BLACK', 'Black'], ['GRAY', 'Gray'], ['LIGHT_GRAY', 'Light Gray'],
];

/**
 * The nine crop kinds of §80, in block-id order: [BLOCK key suffix, kind key, the crop's name]. The name is the display
 * name of the plant the crop grows into, less a closing " Plant": "Planted Wild Carrot", "Wild Carrot Sprout".
 * farming.js CROPS has the rest of each row (what it is planted from, its soil, what it grows into).
 * @type {ReadonlyArray<readonly [string, string, string]>}
 */
export const CROP_ROWS = Object.freeze(/** @type {Array<readonly [string, string, string]>} */ ([
  ['CARROT', 'carrot', 'Wild Carrot'], ['ONION', 'onion', 'Wild Onion'], ['TUBER', 'tuber', 'Wild Tuber'],
  ['HONEYBERRY', 'honeyberry', 'Honeyberry Bush'], ['HAZEL', 'hazel', 'Hazel Thicket'],
  ['CRAB_APPLE', 'crab_apple', 'Crab Apple Bush'], ['HEALWORT', 'healwort', 'Healwort'],
  ['PRICKLY_PEAR', 'prickly_pear', 'Prickly Pear'], ['CATTAILS', 'cattails', 'Cattails'],
]).map((row) => Object.freeze(row)));

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
  // Black Hole: the active vortex (blackholes.js, CONTRACTS §29; DESIGN-circuits §2). It pulls the player and swallows
  // nearby cells. Not solid, so the player can fall in — touching it sends them back to spawn. Breakable like any block;
  // breaking it stops it. Not placeable: the picker gives the dormant Collapsar Charge, and a cell becomes a hole only by
  // activation, `setblock`/`fill … black_hole` or an old save. Not meshed: vortexRenderer draws it.
  def({ id: B.BLACK_HOLE, name: 'black_hole', displayName: 'Black Hole', tiles: tiles(T.BLACK_HOLE), solid: false, opaque: false, placeable: false, soundGroup: 'glass', meshed: false }),
  // Campfire: its own model, light, smoke and crackle (campfires.js / campfireRenderer.js, CONTRACTS §32). Not solid and
  // not meshed; its tiles only draw the icon.
  def({ id: B.CAMPFIRE, name: 'campfire', displayName: 'Campfire', tiles: tiles(T.CAMPFIRE_SIDE, T.CAMPFIRE_TOP), solid: false, opaque: false, layer: LAYER_CUTOUT, soundGroup: 'wood', meshed: false }),
  // ---- v0.8 block physics. Flowing water levels 1..6 and falling water are WATER's family (fluids.js, CONTRACTS §35):
  // liquid, never placed or broken by hand, drawn with the water tile. Only WATER itself is a source.
  ...[1, 2, 3, 4, 5, 6].map((k) => def({
    id: B[`WATER_FLOW_${k}`], name: `water_flow_${k}`, displayName: `Flowing Water ${k}`, tiles: tiles(T.WATER), ...WATER_FAMILY,
  })),
  def({ id: B.WATER_FALL, name: 'water_fall', displayName: 'Falling Water', tiles: tiles(T.WATER), ...WATER_FAMILY }),
  // Powder Keg (the v0.8 "Blast Barrel"; DESIGN-circuits §1.1, §3): an explosive (explosions.js, CONTRACTS §37). A plain
  // solid block until lit by a fuse, a torch, an igniter, a campfire beside it, `ignite` or a blast; it then burns where it
  // stands. Lid tile on top and bottom (its painters live in circuitTiles.js). Saves store the id, so the rename changes none.
  def({ id: B.POWDER_KEG, name: 'powder_keg', displayName: 'Powder Keg', tiles: tiles(T.BARREL_SIDE, T.BARREL_TOP), soundGroup: 'wood' }),
  // ---- v0.9 survival (docs/DESIGN-survival.md §8.1). Only generation-2 worldgen emits the ores, plants and litter.
  def({ id: B.COPPER_ORE, name: 'copper_ore', displayName: 'Copper Ore', tiles: tiles(T.COPPER_ORE), soundGroup: 'stone' }),
  def({ id: B.TIN_ORE, name: 'tin_ore', displayName: 'Tin Ore', tiles: tiles(T.TIN_ORE), soundGroup: 'stone' }),
  // Wild plants (PLANT). A picked bush or pear becomes its *_BARE variant, which regrows and is never placed by hand.
  // Each is a SPRITE block: a small 3D model cut from its picture (§78), never a hexagonal prism.
  def({ id: B.HONEYBERRY_BUSH, name: 'honeyberry_bush', displayName: 'Honeyberry Bush', tiles: tiles(T.HONEYBERRY_BUSH), ...SPRITE }),
  def({ id: B.HONEYBERRY_BUSH_BARE, name: 'honeyberry_bush_bare', displayName: 'Picked Honeyberry Bush', tiles: tiles(T.HONEYBERRY_BUSH_BARE), ...SPRITE, placeable: false }),
  def({ id: B.TUSSOCK, name: 'tussock', displayName: 'Tussock Grass', tiles: tiles(T.TUSSOCK), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.CATTAILS, name: 'cattails', displayName: 'Cattails', tiles: tiles(T.CATTAILS_SIDE), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.TUBER_PLANT, name: 'tuber_plant', displayName: 'Wild Tuber Plant', tiles: tiles(T.TUBER_PLANT), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.PRICKLY_PEAR, name: 'prickly_pear', displayName: 'Prickly Pear', tiles: tiles(T.PRICKLY_PEAR), ...SPRITE }),
  def({ id: B.PRICKLY_PEAR_BARE, name: 'prickly_pear_bare', displayName: 'Picked Prickly Pear', tiles: tiles(T.PRICKLY_PEAR_BARE), ...SPRITE, placeable: false }),
  // Workplaces (§7.1): plain solid blocks that crafting.findStations looks for near the player.
  def({ id: B.WORK_STUMP, name: 'work_stump', displayName: 'Work Stump', tiles: tiles(T.STUMP_SIDE, T.STUMP_TOP, T.OAK_LOG_END), soundGroup: 'wood' }),
  def({ id: B.KILN, name: 'kiln', displayName: 'Kiln', tiles: tiles(T.KILN_SIDE, T.KILN_TOP), soundGroup: 'stone' }),
  def({ id: B.BLOOMERY, name: 'bloomery', displayName: 'Bloomery', tiles: tiles(T.BLOOMERY_SIDE, T.BLOOMERY_TOP), soundGroup: 'stone' }),
  def({ id: B.FORGE, name: 'forge', displayName: 'Forge', tiles: tiles(T.FORGE_SIDE, T.FORGE_TOP), soundGroup: 'stone' }),
  // Containers (§5.6; their contents live in containers.js, keyed "q,y,r") and the Sleeping Hide (the waking place, §2.5).
  def({ id: B.WICKER_BASKET, name: 'wicker_basket', displayName: 'Wicker Basket', tiles: tiles(T.BASKET_SIDE, T.BASKET_TOP), soundGroup: 'wood' }),
  def({ id: B.SLEEPING_HIDE, name: 'sleeping_hide', displayName: 'Sleeping Hide', tiles: tiles(T.HIDE_SIDE, T.HIDE_TOP), soundGroup: 'cloth' }),
  def({ id: B.REMAINS, name: 'remains', displayName: 'Your Belongings', tiles: tiles(T.REMAINS_SIDE, T.REMAINS_TOP), ...PLANT, soundGroup: 'cloth', placeable: false }),
  // Ground litter (picked with R or broken by hand) and the cold fire pit a burnt-out campfire leaves: a meshed cutout block,
  // so campfires.js, the campfire renderer and the zombie safe zone never see it. None of these is placed by hand.
  def({ id: B.LOOSE_STONES, name: 'loose_stones', displayName: 'Loose Stones', tiles: tiles(T.LOOSE_STONES), ...LITTER, soundGroup: 'stone', placeable: false }),
  def({ id: B.FALLEN_BRANCHES, name: 'fallen_branches', displayName: 'Fallen Branches', tiles: tiles(T.FALLEN_BRANCHES), ...LITTER, soundGroup: 'wood', placeable: false }),
  def({ id: B.FIRE_PIT, name: 'fire_pit', displayName: 'Cold Fire Pit', tiles: tiles(T.FIRE_PIT_SIDE, T.PLANT_TOP_CLEAR, T.PLANT_TOP_CLEAR), ...PLANT, soundGroup: 'stone', placeable: false }),
  // ---- Powder and circuits (DESIGN-circuits §1.2). The part table, predicates and connection rules live in circuitParts.js.
  // The devices carry the MODEL flags: solid, unmeshed 3D models drawn by circuitRenderer, whose moving and lit bits are
  // overlays, so a state change never re-meshes a chunk; their top tile is the icon picture. THIN parts are drawn by
  // circuitRenderer too: their top tile is the icon picture, their sides and bottom CIRCUIT_CLEAR.
  def({ id: B.COLLAPSAR_CHARGE, name: 'collapsar_charge', displayName: 'Collapsar Charge', tiles: tiles(T.COLLAPSAR_SIDE, T.COLLAPSAR_TOP), ...MODEL, soundGroup: 'glass' }),
  def({ id: B.POWDER_FUSE, name: 'powder_fuse', displayName: 'Powder Fuse', tiles: tiles(T.CIRCUIT_CLEAR, T.POWDER_FUSE, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'cloth' }),
  def({ id: B.TORCH, name: 'torch', displayName: 'Torch', tiles: tiles(T.CIRCUIT_CLEAR, T.TORCH, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'wood' }),
  def({ id: B.COPPER_WIRE, name: 'copper_wire', displayName: 'Copper Wire', tiles: tiles(T.CIRCUIT_CLEAR, T.COPPER_WIRE, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'cloth' }),
  def({ id: B.BROWN_WIRE, name: 'brown_wire', displayName: 'Brown Wire', tiles: tiles(T.CIRCUIT_CLEAR, T.BROWN_WIRE, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'cloth' }),
  def({ id: B.WHITE_WIRE, name: 'white_wire', displayName: 'White Wire', tiles: tiles(T.CIRCUIT_CLEAR, T.WHITE_WIRE, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'cloth' }),
  def({ id: B.EARTH_WIRE, name: 'earth_wire', displayName: 'Earth Wire', tiles: tiles(T.CIRCUIT_CLEAR, T.EARTH_WIRE, T.CIRCUIT_CLEAR), ...THIN, soundGroup: 'cloth' }),
  def({ id: B.TERMINAL_BOARD, name: 'terminal_board', displayName: 'Terminal Board', tiles: tiles(T.TERMINAL_SIDE, T.TERMINAL_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.VOLTAIC_BATTERY, name: 'voltaic_battery', displayName: 'Voltaic Battery', tiles: tiles(T.BATTERY_SIDE, T.BATTERY_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.BLASTING_MACHINE, name: 'blasting_machine', displayName: 'Blasting Machine', tiles: tiles(T.BLASTER_SIDE, T.BLASTER_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.SELENIUM_PANEL, name: 'selenium_panel', displayName: 'Selenium Panel', tiles: tiles(T.SELENIUM_SIDE, T.SELENIUM_TOP), ...MODEL, soundGroup: 'glass' }),
  def({ id: B.KNIFE_SWITCH, name: 'knife_switch', displayName: 'Knife Switch', tiles: tiles(T.SWITCH_SIDE, T.SWITCH_TOP), ...MODEL, soundGroup: 'stone' }),
  def({ id: B.PUSH_BUTTON, name: 'push_button', displayName: 'Push Button', tiles: tiles(T.BUTTON_SIDE, T.BUTTON_TOP), ...MODEL, soundGroup: 'stone' }),
  def({ id: B.CLOCKWORK_TIMER, name: 'clockwork_timer', displayName: 'Clockwork Timer', tiles: tiles(T.TIMER_SIDE, T.TIMER_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.RELAY, name: 'relay', displayName: 'Relay', tiles: tiles(T.RELAY_SIDE, T.RELAY_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.IGNITER, name: 'igniter', displayName: 'Igniter', tiles: tiles(T.IGNITER_SIDE, T.IGNITER_TOP), ...MODEL, soundGroup: 'stone' }),
  def({ id: B.FILAMENT_LAMP, name: 'filament_lamp', displayName: 'Filament Lamp', tiles: tiles(T.LAMP_SIDE, T.LAMP_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.ELECTRIC_BELL, name: 'electric_bell', displayName: 'Electric Bell', tiles: tiles(T.BELL_SIDE, T.BELL_TOP), ...MODEL, soundGroup: 'stone' }),
  def({ id: B.SPARK_TRANSMITTER, name: 'spark_transmitter', displayName: 'Spark Transmitter', tiles: tiles(T.TX_SIDE, T.TX_TOP), ...MODEL, soundGroup: 'wood' }),
  def({ id: B.COHERER_RECEIVER, name: 'coherer_receiver', displayName: 'Coherer Receiver', tiles: tiles(T.RX_SIDE, T.RX_TOP), ...MODEL, soundGroup: 'glass' }),
  // v0.11 (CONTRACTS §67): the Workbench (a workplace; appended so ids stay positional)
  def({ id: B.WORKBENCH, name: 'workbench', displayName: 'Workbench', tiles: tiles(T.WORKBENCH_SIDE, T.WORKBENCH_TOP, T.OAK_PLANKS), soundGroup: 'wood' }),
  // v0.11 (CONTRACTS §69): the snares lie on the ground like litter; only the set one is placeable (and is the item)
  def({ id: B.SNARE, name: 'snare', displayName: 'Snare', tiles: tiles(T.SNARE), ...DECAL, soundGroup: 'wood' }),
  def({ id: B.SNARE_BAITED, name: 'snare_baited', displayName: 'Baited Snare', tiles: tiles(T.SNARE_BAITED), ...DECAL, soundGroup: 'wood', placeable: false }),
  def({ id: B.SNARE_SPRUNG, name: 'snare_sprung', displayName: 'Sprung Snare', tiles: tiles(T.SNARE_SPRUNG), ...DECAL, soundGroup: 'wood', placeable: false }),
  // v0.13's Flinty Gravel (withdrawn, §76): kept so saves that hold id 119 still load. It is gravel in all but its id.
  def({ id: B.FLINT_GRAVEL, name: 'flint_gravel', displayName: 'Gravel', tiles: tiles(T.GRAVEL), soundGroup: 'gravel', gravity: true, placeable: false }),
  // v0.14 (§76 water): Tainted Water, a second water SOURCE with WATER's flags and its own murky tile. Worldgen writes it
  // (generation-3 ponds) and `setblock … tainted_water` can; it is never placed by hand, so it has no picker entry and no item.
  def({ id: B.TAINTED_WATER, name: 'tainted_water', displayName: 'Tainted Water', tiles: tiles(T.TAINTED_WATER), solid: false, opaque: false, liquid: true, breakable: false, placeable: false, layer: LAYER_TRANSLUCENT, soundGroup: 'water' }),
  // v0.14 (§76 fauna): the ground nest lies on the ground like litter (small 3D pieces); it is never placed by hand
  def({ id: B.GROUND_NEST, name: 'ground_nest', displayName: 'Ground Nest', tiles: tiles(T.GROUND_NEST), ...LITTER, soundGroup: 'grass', placeable: false }),
  // ---- v0.14 (§76 flora): the wild plants of generation 3, all small 3D models (SPRITE) picked with R. The two mushrooms
  // look alike on purpose: the Honeycap feeds, the Frecklecap poisons, and only their caps and stems tell them apart. A
  // picked thicket or bush, and a cut Healwort, is its *_BARE variant: it regrows and is never placed by hand.
  def({ id: B.HONEYCAP_MUSHROOM, name: 'honeycap_mushroom', displayName: 'Honeycap Mushroom', tiles: tiles(T.HONEYCAP_MUSHROOM), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.FRECKLECAP_MUSHROOM, name: 'frecklecap_mushroom', displayName: 'Frecklecap Mushroom', tiles: tiles(T.FRECKLECAP_MUSHROOM), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.ONION_PLANT, name: 'onion_plant', displayName: 'Wild Onion Plant', tiles: tiles(T.ONION_PLANT), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.CARROT_PLANT, name: 'carrot_plant', displayName: 'Wild Carrot Plant', tiles: tiles(T.CARROT_PLANT), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.HAZEL_THICKET, name: 'hazel_thicket', displayName: 'Hazel Thicket', tiles: tiles(T.HAZEL_THICKET), ...SPRITE }),
  def({ id: B.HAZEL_THICKET_BARE, name: 'hazel_thicket_bare', displayName: 'Picked Hazel Thicket', tiles: tiles(T.HAZEL_THICKET_BARE), ...SPRITE, placeable: false }),
  def({ id: B.CRAB_APPLE_BUSH, name: 'crab_apple_bush', displayName: 'Crab Apple Bush', tiles: tiles(T.CRAB_APPLE_BUSH), ...SPRITE }),
  def({ id: B.CRAB_APPLE_BUSH_BARE, name: 'crab_apple_bush_bare', displayName: 'Picked Crab Apple Bush', tiles: tiles(T.CRAB_APPLE_BUSH_BARE), ...SPRITE, placeable: false }),
  def({ id: B.HEALWORT_PLANT, name: 'healwort_plant', displayName: 'Healwort Plant', tiles: tiles(T.HEALWORT_PLANT), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.HEALWORT_PLANT_BARE, name: 'healwort_plant_bare', displayName: 'Cut Healwort Plant', tiles: tiles(T.HEALWORT_PLANT_BARE), ...SPRITE, soundGroup: 'grass', placeable: false }),
  // v0.14 (§76 fauna): the nest once its eggs are taken
  def({ id: B.GROUND_NEST_EMPTY, name: 'ground_nest_empty', displayName: 'Empty Nest', tiles: tiles(T.GROUND_NEST_EMPTY), ...LITTER, soundGroup: 'grass', placeable: false }),
  // ---- §80 farming: a planted seed (133–141) and its sprout (142–150), one of each per crop kind. Small 3D models
  // (SPRITE) like the plants: every planted block is the one seedbed, every sprout the one seedling. Never placed by
  // hand (R with a seed plants one: farming.js), so they have no picker entry and no item; they pop off like a plant.
  ...CROP_ROWS.map(([key, name, label]) => def({
    id: B[`PLANTED_${key}`], name: `planted_${name}`, displayName: `Planted ${label}`, tiles: tiles(T.SEEDBED), ...SPRITE, soundGroup: 'grass', placeable: false,
  })),
  ...CROP_ROWS.map(([key, name, label]) => def({
    id: B[`${key}_SPROUT`], name: `${name}_sprout`, displayName: `${label} Sprout`, tiles: tiles(T.SPROUT), ...SPRITE, soundGroup: 'grass', placeable: false,
  })),
  // ---- §81: plants that are not food, all small 3D models (SPRITE). The Hemlock is the Wild Carrot's look-alike and the
  // Nightshade the Honeyberry's: both poison, and no name says so (their flowers, stems and berries do). A picked
  // Nightshade is its *_BARE variant, drawn as the picked Honeyberry: it regrows and is never placed by hand.
  def({ id: B.FERN, name: 'fern', displayName: 'Fern', tiles: tiles(T.FERN), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.MEADOW_DAISIES, name: 'meadow_daisies', displayName: 'Meadow Daisies', tiles: tiles(T.MEADOW_DAISIES), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.THISTLE, name: 'thistle', displayName: 'Thistle', tiles: tiles(T.THISTLE), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.HEMLOCK, name: 'hemlock', displayName: 'Hemlock', tiles: tiles(T.HEMLOCK), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.NIGHTSHADE_BUSH, name: 'nightshade_bush', displayName: 'Nightshade Bush', tiles: tiles(T.NIGHTSHADE_BUSH), ...SPRITE }),
  def({ id: B.NIGHTSHADE_BUSH_BARE, name: 'nightshade_bush_bare', displayName: 'Picked Nightshade Bush', tiles: tiles(T.HONEYBERRY_BUSH_BARE), ...SPRITE, placeable: false }),
  def({ id: B.FLAX, name: 'flax', displayName: 'Flax', tiles: tiles(T.FLAX), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.ALOE, name: 'aloe', displayName: 'Aloe', tiles: tiles(T.ALOE), ...SPRITE, soundGroup: 'grass' }),
  // ---- §83: the two lower depths of standing water, fresh and tainted. SOURCES like WATER and TAINTED_WATER (their
  // flags and their tiles); only how much is in the cell differs (waterDepth, waterLevel, waterSurfaceHeight).
  def({ id: B.WATER_LOW, name: 'water_low', displayName: 'Low Water', tiles: tiles(T.WATER), ...WATER_FAMILY }),
  def({ id: B.WATER_SHALLOW, name: 'water_shallow', displayName: 'Shallow Water', tiles: tiles(T.WATER), ...WATER_FAMILY }),
  def({ id: B.TAINTED_WATER_LOW, name: 'tainted_water_low', displayName: 'Low Tainted Water', tiles: tiles(T.TAINTED_WATER), ...WATER_FAMILY }),
  def({ id: B.TAINTED_WATER_SHALLOW, name: 'tainted_water_shallow', displayName: 'Shallow Tainted Water', tiles: tiles(T.TAINTED_WATER), ...WATER_FAMILY }),
  // ---- §85: a place to stay. The SPRING is ground: a solid, opaque prism of rock with a pool in its top, set into the
  // land by generation 5 in place of the surface block. It is no water block (nothing flows from it, it waters no crop):
  // it is a place to drink. Never placed by hand, no item; harvest.js gives it no rule, so Survival cannot break it.
  def({ id: B.SPRING, name: 'spring', displayName: 'Spring', tiles: tiles(T.SPRING_SIDE, T.SPRING_TOP, T.STONE), soundGroup: 'stone', placeable: false }),
  def({ id: B.SPRING_DRAWN, name: 'spring_drawn', displayName: 'Spring (drawn)', tiles: tiles(T.SPRING_SIDE, T.SPRING_DRAWN_TOP, T.STONE), soundGroup: 'stone', placeable: false }),
  // The well and the rain barrel: solid 3D models (FURNITURE). Only the full well and the empty barrel are placed by
  // hand (and are the items); the other states are reached by drawing, by the ground's water and by the rain.
  def({ id: B.WELL, name: 'well', displayName: 'Well', tiles: tiles(T.WELL), ...FURNITURE, soundGroup: 'stone' }),
  def({ id: B.WELL_DRAWN, name: 'well_drawn', displayName: 'Well (drawn)', tiles: tiles(T.WELL), ...FURNITURE, soundGroup: 'stone', placeable: false }),
  def({ id: B.RAIN_BARREL, name: 'rain_barrel', displayName: 'Rain Barrel', tiles: tiles(T.RAIN_BARREL), ...FURNITURE, soundGroup: 'wood' }),
  ...[1, 2, 3].map((k) => def({
    id: B[`RAIN_BARREL_${k}`], name: `rain_barrel_${k}`, displayName: `Rain Barrel (${k} ${k === 1 ? 'pot' : 'pots'})`, tiles: tiles(T.RAIN_BARREL), ...FURNITURE, soundGroup: 'wood', placeable: false,
  })),
  // The two beds: low 3D models you walk over (the PLANT flags, like a snare or a seedbed), one cell each.
  def({ id: B.GRASS_BED, name: 'grass_bed', displayName: 'Grass Bed', tiles: tiles(T.GRASS_BED), ...SPRITE, soundGroup: 'grass' }),
  def({ id: B.BED, name: 'bed', displayName: 'Bed', tiles: tiles(T.BED), ...SPRITE, soundGroup: 'wood' }),
];

/**
 * Old block names that still resolve (DESIGN-circuits §1.5): `commands.resolveBlock` consults this right after its exact-name
 * pass (and accepts the display-name form, `blast barrel`), so rune scripts written as `setblock … blast_barrel` keep working.
 * @type {Readonly<Record<string, number>>}
 */
export const BLOCK_ALIASES = Object.freeze({ blast_barrel: B.POWDER_KEG });

/** Default hotbar: grass, dirt, stone, cobble, planks, log, leaves, glass, bricks. */
export const DEFAULT_HOTBAR = Object.freeze([
  B.GRASS_BLOCK, B.DIRT, B.STONE, B.COBBLESTONE, B.OAK_PLANKS, B.OAK_LOG, B.OAK_LEAVES, B.GLASS, B.BRICKS,
]);

/**
 * Order of the 119 placeable blocks, grouped by family; RUNE_BLOCK and WATER stay last. It is the flat list of every placeable
 * block (survival's ITEM_KEYS and the `blocks` command use it); the picker's sections come from pickerModel.js. The Black
 * Hole is not placeable (DESIGN-circuits §1.5); the Powder Keg follows the campfire, then the 20 circuit blocks in §1.2 order.
 */
export const PICKER_ORDER = Object.freeze([
  // stone
  B.STONE, B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.GRANITE, B.DIORITE, B.ANDESITE,
  B.SLATE, B.OBSIDIAN, B.BRICKS, B.SANDSTONE,
  // earth (v0.9: the wild plants right after the pumpkin)
  B.DIRT, B.GRASS_BLOCK, B.SNOWY_GRASS, B.SAND, B.RED_SAND, B.GRAVEL, B.CLAY, B.SNOW_BLOCK, B.ICE, B.PACKED_ICE,
  B.HAY_BALE, B.PUMPKIN, B.TUSSOCK, B.CATTAILS, B.TUBER_PLANT, B.HONEYBERRY_BUSH, B.PRICKLY_PEAR,
  // v0.14 (§76 flora): the seven new wild plants, after the old five
  B.ONION_PLANT, B.CARROT_PLANT, B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.HEALWORT_PLANT,
  // §81: the seven plants that are not food, after them
  B.FERN, B.MEADOW_DAISIES, B.THISTLE, B.HEMLOCK, B.NIGHTSHADE_BUSH, B.FLAX, B.ALOE,
  // wood
  B.OAK_LOG, B.OAK_PLANKS, B.OAK_LEAVES, B.SPRUCE_LOG, B.SPRUCE_PLANKS, B.SPRUCE_LEAVES, B.BIRCH_LOG, B.BIRCH_PLANKS,
  B.BIRCH_LEAVES, B.BOOKSHELF, B.GLASS, B.GLOWSTONE,
  // minerals (v0.9: copper and tin ore right after diamond ore)
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.COPPER_ORE, B.TIN_ORE, B.COAL_BLOCK, B.IRON_BLOCK, B.GOLD_BLOCK,
  B.DIAMOND_BLOCK, B.COPPER_BLOCK, B.HONEYCOMB_BLOCK,
  // wool, light to dark around the colour wheel
  B.WOOL_WHITE, B.WOOL_LIGHT_GRAY, B.WOOL_GRAY, B.WOOL_BLACK, B.WOOL_BROWN, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW,
  B.WOOL_LIME, B.WOOL_GREEN, B.WOOL_CYAN, B.WOOL_LIGHT_BLUE, B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_MAGENTA, B.WOOL_PINK,
  // special (v0.9: the workplaces, the basket and the Sleeping Hide right before the campfire)
  B.WORK_STUMP, B.KILN, B.BLOOMERY, B.FORGE, B.WORKBENCH, B.WICKER_BASKET, B.SLEEPING_HIDE, B.SNARE,
  // §85: the two beds, the well and the rain barrel, after the snare
  B.GRASS_BED, B.BED, B.WELL, B.RAIN_BARREL,
  B.CAMPFIRE, B.POWDER_KEG,
  // powder and circuits (DESIGN-circuits §1.2 table order)
  B.COLLAPSAR_CHARGE, B.POWDER_FUSE, B.TORCH, B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE, B.EARTH_WIRE, B.TERMINAL_BOARD,
  B.VOLTAIC_BATTERY, B.BLASTING_MACHINE, B.SELENIUM_PANEL, B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.RELAY,
  B.IGNITER, B.FILAMENT_LAMP, B.ELECTRIC_BELL, B.SPARK_TRANSMITTER, B.COHERER_RECEIVER,
  B.RUNE_BLOCK, B.WATER,
]);

/**
 * The 25 wild-plant ids (§8.1 "PLANT"), ripe and picked, in id order: HONEYBERRY_BUSH … PRICKLY_PEAR_BARE (78–84),
 * since v0.14 (§76 flora) HONEYCAP_MUSHROOM … HEALWORT_PLANT_BARE (122–131) and, since §81, FERN … ALOE (151–158).
 */
export const PLANT_IDS = Object.freeze([
  B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE, B.TUSSOCK, B.CATTAILS, B.TUBER_PLANT, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE,
  B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.ONION_PLANT, B.CARROT_PLANT, B.HAZEL_THICKET, B.HAZEL_THICKET_BARE,
  B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE,
  B.FERN, B.MEADOW_DAISIES, B.THISTLE, B.HEMLOCK, B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE, B.FLAX, B.ALOE,
]);

/**
 * The 18 farm ids of §80, in id order: the nine planted blocks (133–141), then the nine sprouts (142–150). They are not
 * wild plants (`isPlant` is false: nothing generates them, nothing picks them), but they pop off like one.
 */
export const FARM_IDS = Object.freeze(Array.from({ length: 2 * CROP_ROWS.length }, (_, i) => B.PLANTED_CARROT + i));

/**
 * The 47 pop-off ids (§8.5), in id order: CAMPFIRE, the plants, the two kinds of litter, FIRE_PIT and, since §80, the 18
 * farm blocks (the eight plants of §81 come after them). A pop-off block breaks (is written AIR and drops nothing) when
 * the cell below it becomes fall-through.
 */
export const POP_OFF_IDS = Object.freeze(
  [B.CAMPFIRE, ...PLANT_IDS, B.LOOSE_STONES, B.FALLEN_BRANCHES, B.FIRE_PIT, ...FARM_IDS].sort((a, b) => a - b),
);

/**
 * The ten homestead ids of §85, in id order: SPRING, SPRING_DRAWN, WELL, WELL_DRAWN, RAIN_BARREL, RAIN_BARREL_1..3,
 * GRASS_BED, BED.
 */
export const HOMESTEAD_IDS = Object.freeze(Array.from({ length: 10 }, (_, i) => B.SPRING + i));
/**
 * The eight of them drawn as small 3D models (plantModels.js): the two wells, the four barrels, the two beds. With the
 * wild plants and the farm blocks they are every `'model'` block there is.
 */
export const FURNITURE_MODEL_IDS = Object.freeze(HOMESTEAD_IDS.filter((id) => id >= B.WELL));

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
/** false for blocks drawn by their own model instead of the chunk mesher (campfire, black hole, the circuit parts but the keg). */
/** How the chunk mesher draws `id` (BlockDef.shape): 'prism', 'model' (the wild plants), 'decal' (the snares) or 'litter'. */
/**
 * The share of natural loose stones that hold flint (made visible: CONTRACTS §70). 0.06 since v0.13 (it was 0.5): flint is
 * rare and comes mostly from digging gravel (harvest.GRAVEL_FLINT_P, §76).
 */
export const FLINT_SHARE = 0.06;

/**
 * Whether the loose stones at column (q, r) hold flint: a fixed coin toss per column, so the mesher can draw those with
 * the flint tile (LOOSE_STONES_FLINT) and picking them gives exactly what the player saw.
 * @param {number} q @param {number} r @returns {boolean}
 */
export function flintAt(q, r) {
  let h = (Math.imul(q | 0, 0x27d4eb2d) ^ Math.imul(r | 0, 0x165667b1) ^ 0x5f1a7e) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 < FLINT_SHARE;
}

export function getBlockShape(id) {
  return getBlockDef(id).shape;
}

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
/** One of the wild plants, ripe or picked (`PLANT_IDS`: 78–84, since v0.14 122–131 and, since §81, 151–158). */
export function isPlant(id) {
  return (id >= B.HONEYBERRY_BUSH && id <= B.PRICKLY_PEAR_BARE) || (id >= B.HONEYCAP_MUSHROOM && id <= B.HEALWORT_PLANT_BARE)
    || (id >= B.FERN && id <= B.ALOE);
}
/** Ground litter: LOOSE_STONES or FALLEN_BRANCHES. */
export function isLitter(id) {
  return id === B.LOOSE_STONES || id === B.FALLEN_BRANCHES;
}
/** A planted seed or a sprout (§80; `FARM_IDS`: 133–150). */
export function isFarmBlock(id) {
  return id >= B.PLANTED_CARROT && id <= B.CATTAILS_SPROUT;
}
/** CAMPFIRE, FIRE_PIT, a plant, litter or a farm block (`POP_OFF_IDS`): breaks when the cell below becomes fall-through (§8.5). */
export function isPopOff(id) {
  return id === B.CAMPFIRE || id === B.FIRE_PIT || isPlant(id) || isLitter(id) || isFarmBlock(id);
}
/** A workplace (§7.1): WORK_STUMP, KILN, BLOOMERY or FORGE. */
export function isStation(id) {
  return id === B.WORK_STUMP || id === B.KILN || id === B.BLOOMERY || id === B.FORGE || id === B.WORKBENCH;
}
/** A natural spring, welling or drawn (§85): SPRING or SPRING_DRAWN. */
export function isSpring(id) {
  return id === B.SPRING || id === B.SPRING_DRAWN;
}
/** A well, full or drawn (§85): WELL or WELL_DRAWN. */
export function isWell(id) {
  return id === B.WELL || id === B.WELL_DRAWN;
}
/** A rain barrel, whatever it holds (§85): RAIN_BARREL, RAIN_BARREL_1, _2 or _3. */
export function isRainBarrel(id) {
  return id >= B.RAIN_BARREL && id <= B.RAIN_BARREL_3;
}
/** A block whose contents live in containers.js (§5.6): WICKER_BASKET or REMAINS. */
export function isContainerBlock(id) {
  return id === B.WICKER_BASKET || id === B.REMAINS;
}
/**
 * The water family: the six SOURCES — WATER and TAINTED_WATER (full) and their LOW and SHALLOW depths (§83) — and the
 * flowing levels WATER_FLOW_1..6 and WATER_FALL that sources feed.
 */
export function isWater(id) {
  return id === B.WATER || (id >= B.WATER_FLOW_1 && id <= B.WATER_FALL) || id === B.TAINTED_WATER || (id >= B.WATER_LOW && id <= B.TAINTED_WATER_SHALLOW);
}
/**
 * A water SOURCE: standing water of any depth, fresh or tainted (WATER, TAINTED_WATER and, since §83, WATER_LOW,
 * WATER_SHALLOW, TAINTED_WATER_LOW, TAINTED_WATER_SHALLOW). FLOW / FALL are derived from sources and are not sources.
 */
export function isWaterSource(id) {
  return id === B.WATER || id === B.TAINTED_WATER || (id >= B.WATER_LOW && id <= B.TAINTED_WATER_SHALLOW);
}
/** A tainted source of any depth: TAINTED_WATER, TAINTED_WATER_LOW or TAINTED_WATER_SHALLOW. */
export function isTaintedWater(id) {
  return id === B.TAINTED_WATER || id === B.TAINTED_WATER_LOW || id === B.TAINTED_WATER_SHALLOW;
}
/** The depths of standing water (§83): how much a source cell holds. */
export const WATER_DEPTH_FULL = 3;
export const WATER_DEPTH_LOW = 2;
export const WATER_DEPTH_SHALLOW = 1;
/** The words for the depths, by depth (index 0: no water). */
export const WATER_DEPTH_WORDS = Object.freeze(['dry', 'shallow', 'low', 'full']);
/** Height of the surface of a low and of a shallow source above the cell's bottom (a full one: WATER_SURFACE_HEIGHT). */
export const WATER_LOW_SURFACE = 0.55;
export const WATER_SHALLOW_SURFACE = 0.22;
/** The strength E of a low and of a shallow source in the water rule (a full one: 7): what flows out of it starts at E − 1. */
export const WATER_LOW_LEVEL = 5;
export const WATER_SHALLOW_LEVEL = 3;
/**
 * The depth of a source (§83): 3 full (WATER, TAINTED_WATER), 2 low, 1 shallow; 0 for anything that is not a source
 * (flowing and falling water too).
 * @param {number} id @returns {number} 0..3
 */
export function waterDepth(id) {
  if (id === B.WATER || id === B.TAINTED_WATER) return 3;
  if (id === B.WATER_LOW || id === B.TAINTED_WATER_LOW) return 2;
  if (id === B.WATER_SHALLOW || id === B.TAINTED_WATER_SHALLOW) return 1;
  return 0;
}
/** Source ids by [tainted 0 | 1][depth 0..3]; depth 0 is AIR. */
const SOURCE_AT_DEPTH = Object.freeze([
  Object.freeze([B.AIR, B.WATER_SHALLOW, B.WATER_LOW, B.WATER]),
  Object.freeze([B.AIR, B.TAINTED_WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER]),
]);
/**
 * The source block of a quality at a depth (§83): depth 3 or more the full block, 2 low, 1 shallow, below 1 AIR.
 * @param {'fresh'|'tainted'|boolean} quality  'tainted' (or true) for tainted water, anything else fresh
 * @param {number} depth
 * @returns {number} block id
 */
export function waterAtDepth(quality, depth) {
  const d = depth >= 3 ? 3 : depth >= 1 ? Math.floor(depth) : 0;
  return SOURCE_AT_DEPTH[quality === 'tainted' || quality === true ? 1 : 0][d];
}
/**
 * Water level, the strength E of the water rule (§35.1, §83): a full source and WATER_FALL → 7, a low source → 5, a
 * shallow source → 3, WATER_FLOW_k → k, anything else → 0.
 */
export function waterLevel(id) {
  if (id === B.WATER || id === B.WATER_FALL || id === B.TAINTED_WATER) return 7;
  if (id >= B.WATER_FLOW_1 && id <= B.WATER_FLOW_6) return id - B.WATER_FLOW_1 + 1;
  if (id === B.WATER_LOW || id === B.TAINTED_WATER_LOW) return WATER_LOW_LEVEL;
  if (id === B.WATER_SHALLOW || id === B.TAINTED_WATER_SHALLOW) return WATER_SHALLOW_LEVEL;
  return 0;
}
/**
 * A falling block passes through (and a gravity block / campfire falls into) this cell: AIR, any water (sources too —
 * sand sinks to the bottom of a lake, CONTRACTS §35.6) or a CAMPFIRE. NOT the UNLOADED sentinel.
 */
export function isFallThrough(id) {
  return id === B.AIR || id === B.CAMPFIRE || isWater(id);
}
/**
 * Height of the water surface inside a water cell, above the cell's bottom (CONTRACTS §35.4, §83): 1 when water is above
 * it (the surface is further up), else WATER_SURFACE_HEIGHT for a full source or falling water, WATER_LOW_SURFACE for a
 * low source, WATER_SHALLOW_SURFACE for a shallow one and k/7 of WATER_SURFACE_HEIGHT for WATER_FLOW_k; 0 for anything
 * that is not water. The mesher draws these surfaces and physics.js wades / swims by them.
 * @param {number} id
 * @param {number} aboveId  the block above the cell
 * @returns {number}
 */
export function waterSurfaceHeight(id, aboveId) {
  if (!isWater(id)) return 0;
  if (isWater(aboveId)) return 1;
  if (id >= B.WATER_FLOW_1 && id <= B.WATER_FLOW_6) return ((id - B.WATER_FLOW_1 + 1) * WATER_SURFACE_HEIGHT) / 7;
  if (id === B.WATER_LOW || id === B.TAINTED_WATER_LOW) return WATER_LOW_SURFACE;
  if (id === B.WATER_SHALLOW || id === B.TAINTED_WATER_SHALLOW) return WATER_SHALLOW_SURFACE;
  return WATER_SURFACE_HEIGHT;
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
