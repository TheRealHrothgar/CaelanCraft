// Caelancraft — chunk mesher for hexagonal-prism cells. See src/CONTRACTS.md §10. Pure.
//
// buildChunkMesh(cq, cr, getChunkData) turns one 16×128×16 chunk (plus a one-cell halo read from the six
// hex-adjacent chunks) into three triangle lists — opaque, cutout (leaves/glass) and translucent (water).
// Every cell is a pointy-top hexagonal prism (src/hex.js): six side quads (faces 0..5), a hexagonal top
// (face 6) and bottom (face 7). Faces are culled with blocks.shouldRenderFace, shaded with
// FACE_SHADE × per-vertex ambient occlusion × biome tint, and emitted CCW seen from outside.
// The kit models (CONTRACTS §105: the plants, the farm's blocks, the litter) go into a fourth list of their own,
// `plantLayer` (drawn with the cutout material), so buildChunkPlants can re-mesh them alone for a change of level of detail.
//
// Performance notes: this runs on the main thread inside world.update()'s time budget, so the hot loop is
// allocation-free. The padded 18×18×128 volume and the three mesh builders are module-level scratch buffers
// reused between calls; the only allocations per call are the exact-length output arrays.
//
// Light (CONTRACTS §62): every vertex also carries `light` (2 bytes: sky, block, each level·17 so 255 = 15), read from a
// second padded volume filled from the chunks' `light` arrays (a chunk without one — or no chunk — reads as open sky,
// 15 / 0, i.e. exactly today's look). The level is SMOOTHED per vertex like the AO: the mean over the see-through cells
// that touch the vertex in front of the face (the face's own front cell always; the AO samples whenever they are not
// opaque; the diagonal only when it is not cut off by both sides), so light falls off across a face instead of stepping
// cell by cell. A face whose front cell is opaque (a lowered water surface under a block) and the plant shapes use their
// own cell's light; an emitter's faces carry at least its own block level (glowstone is fully lit).
//
// Water in brickwork (CONTRACTS §93.9): a third padded volume holds the chunks' brick pieces (`cover`). Water in a cell
// under bricks is drawn over its open pieces only (cap and floor per piece; a side only where an open piece meets it, cut
// to that piece), never toward a face brickwork closes (the brick mesher draws the brick there), and never toward a
// BRICK_SHADOW. In a BRICK_SHADOW (brickwork that left two points, or glass all round) each open piece beside water is
// drawn full of that water to its height, so a surface meets a brick wall wherever the wall is.
import { CHUNK_SIZE, WORLD_HEIGHT, AO_CURVE, TOP_UV_SCALE, ATLAS_SLOT_PX } from './config.js';
import { floorDiv, mod, localIndex } from './coords.js';
import {
  HEX_DIRS, HEX_CORNERS, HEX_SIZE, HEX_ROW_SPACING, FACE_NORMALS, FACE_SHADE, FACE_TOP, FACE_BOTTOM, FACE_COUNT,
  SIDE_FACE_COUNT,
} from './hex.js';
import {
  BLOCK, BIOME, TILE, isOpaque, shouldRenderFace, getRenderLayer, getFaceTile, tileToUV, isMeshed, isWater, waterLevel, waterSurfaceHeight, getBlockShape,
  flintAt,
} from './blocks.js';
import { FULL_SKY, LIGHT_EMISSION } from './light.js';
import { facePieces, waterCrossesFace } from './bricks.js';
import {
  furnitureModel, furnitureModelTile, BOX_QUAD_STRIDE, isKitModel, plantMesh, plantVariants, plantCardSlot,
  LOOSE_STONES_FLINT, PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_STRIDE,
} from './plantModels.js';
import { PLANT_UV_OFFSET } from './plantAtlas.js';
import {
  tileVariants, VARY_CAP, VARY_MIRROR, VARY_SHIFT, MAX_VARIANTS, BLOCK_JITTER, LEAFY, LEAF_HUE_SHIFT, variantHash,
} from './tileVariants.js';

/** @typedef {import('./types.js').MeshData} MeshData */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
/** @typedef {import('./types.js').ChunkPlantData} ChunkPlantData */
/** @typedef {import('./types.js').GetChunkDataFn} GetChunkDataFn */
/** @typedef {import('./types.js').ChunkData} ChunkData */

// ---------------------------------------------------------------------------------------------------
// Padded volume (§10.1)
// ---------------------------------------------------------------------------------------------------

/** Padded q/r extent: the chunk plus a one-cell halo on each side. */
const PAD = CHUNK_SIZE + 2; // 18
// Padded index: pIndex(pq, py, pr) = (pq * 18 + pr) * 128 + py (Y innermost, like localIndex).

/** Module-level scratch volume, zero-filled at the start of every build. */
const padded = new Uint8Array(PAD * PAD * WORLD_HEIGHT);
/** The same cells' packed light (sky << 4 | block, §62); FULL_SKY where a chunk has no light array or is missing. */
const paddedLight = new Uint8Array(PAD * PAD * WORLD_HEIGHT);
/** Scratch 3×3 array of neighbour chunk light arrays (same index as neighbourData). */
const neighbourLight = new Array(9).fill(null);

/** Scratch 3×3 array of neighbour chunk block arrays (index = (dcq+1)*3 + (dcr+1)); cleared after each build. */
const neighbourData = new Array(9).fill(null);
/** §93.9: the same cells' brick pieces (a chunk's `cover`: the low 4 bits under a brick); 0 where a chunk has none. */
const paddedCover = new Uint8Array(PAD * PAD * WORLD_HEIGHT);
/** Scratch 3×3 array of neighbour chunk cover arrays (same index as neighbourData). */
const neighbourCover = new Array(9).fill(null);
/** Some chunk of this build has brick pieces (else paddedCover is all 0 and never read). */
let coverOn = false;
/** paddedCover holds pieces from an earlier build (cleared before the next one). */
let coverDirty = false;

/** @returns {number} index into `padded` */
function pIndex(pq, py, pr) {
  return (pq * PAD + pr) * WORLD_HEIGHT + py;
}

// ---------------------------------------------------------------------------------------------------
// Biome tint (grass tops and leaves pick up the climate of their column)
// ---------------------------------------------------------------------------------------------------

/** Multiplied into the vertex colour of tinted faces, index = BIOME id. Values stay near 1 so textures keep their brightness. */
export const BIOME_TINT = Object.freeze([
  Object.freeze([0.80, 0.94, 0.74]), // OCEAN
  Object.freeze([0.92, 0.97, 0.72]), // BEACH
  Object.freeze([0.90, 1.00, 0.70]), // PLAINS
  Object.freeze([0.72, 0.98, 0.62]), // FOREST
  Object.freeze([1.00, 0.92, 0.56]), // DESERT
  Object.freeze([0.76, 0.92, 0.92]), // SNOWY
  Object.freeze([0.82, 0.94, 0.74]), // MOUNTAINS
  Object.freeze([0.82, 0.92, 0.96]), // SNOWY_PEAKS
]);

/** @returns {boolean} face `face` of block `id` is multiplied by the column's biome tint */
export function isTintedFace(id, face) {
  if (id === BLOCK.OAK_LEAVES) return true;
  return id === BLOCK.GRASS_BLOCK && face === FACE_TOP;
}

// ---------------------------------------------------------------------------------------------------
// Lookup tables (built once at module load; all indexed by BlockId 0..255)
// ---------------------------------------------------------------------------------------------------

/** OPAQUE[id] = 1 iff isOpaque(id). */
const OPAQUE = new Uint8Array(256);
/** LAYER[id] = getRenderLayer(id). */
const LAYER = new Uint8Array(256);
/** UNMESHED[id] = 1 for blocks the mesher skips (BlockDef.meshed false: they have their own model). */
const UNMESHED = new Uint8Array(256);
/** RENDER[(a << 8) | b] = 1 iff shouldRenderFace(a, b). */
const RENDER = new Uint8Array(256 * 256);
/** FACE_UV[(id * 8 + f) * 4 + k] = tileToUV(getFaceTile(id, f))[k]. */
const FACE_UV = new Float32Array(256 * FACE_COUNT * 4);
/** TINTED[id * 8 + f] = 1 iff isTintedFace(id, f). */
const TINTED = new Uint8Array(256 * FACE_COUNT);
/**
 * §90 per-cell variation. VAR_COUNT[id * 8 + f] = how many pictures face f's tile has, VAR_MODE[…] its VARY_* bits and
 * VAR_UV[((id * 8 + f) * MAX_VARIANTS + k) * 4 …] picture k's rect; VARIES[id] = 1 when any face of `id` varies or the
 * block's brightness rolls (BLOCK_JITTER).
 */
const VAR_COUNT = new Uint8Array(256 * FACE_COUNT);
const VAR_MODE = new Uint8Array(256 * FACE_COUNT);
const VAR_UV = new Float32Array(256 * FACE_COUNT * MAX_VARIANTS * 4);
const VARIES = new Uint8Array(256);
/**
 * FREE_SURFACE[id] = 1 iff water under a cell of `id` has a free, lowered surface (§10.2 step 1): AIR, or a block drawn
 * by its own model (campfire, a black hole, the thin circuit parts: v0.10). Under water or any block meshed as a full prism
 * (stone, glass, ice, leaves) a FULL water cell (source or falling) stays full height, so a submerged see-through block shows
 * no fake surface ledge.
 */
const FREE_SURFACE = new Uint8Array(256);
/**
 * WET[id] = 1 for the water family (WATER, WATER_FLOW_1..6, WATER_FALL, TAINTED_WATER since §76, and the low and shallow
 * sources since §83): culled against each other by surface height — so fresh and tainted water side by side show no wall
 * between them, and a low pool beside a full one shows only the strip of the full one's surface above its own.
 */
const WET = new Uint8Array(256);
/**
 * FULL_WATER[id] = 1 for a full water cell: a FULL source (WATER, TAINTED_WATER) or falling water (level 7). A low or a
 * shallow source (§83: level 5, 3) is not: like a flowing level it keeps its own lowered surface wherever it is.
 */
const FULL_WATER = new Uint8Array(256);
/** SURFACE[id] = waterSurfaceHeight(id, AIR): the free surface of a water cell with no water above it (§10.2 step 1). */
const SURFACE = new Float64Array(256);
/**
 * SHAPE[id] (BlockDef.shape): 0 a hexagonal prism, SHAPE_DECAL a picture on the floor, SHAPE_MODEL a box model (§85's
 * furniture), SHAPE_PLANT a kit model (§105: the plants, the farm's blocks and the ground litter, 'model' and 'litter').
 */
const SHAPE = new Uint8Array(256);
const SHAPE_DECAL = 2;
const SHAPE_PLANT = 3;
const SHAPE_MODEL = 4;
/** MODELS[id]: the compiled quads of a furniture block's box model (plantModels.js), and MODEL_UV[id] the tile rect they are cut from. */
const MODELS = /** @type {(Float32Array|null)[]} */ (new Array(256).fill(null));
const MODEL_UV = /** @type {(number[]|null)[]} */ (new Array(256).fill(null));
/** VARIANTS[id]: how many variants a kit model has (§105), chosen per cell. */
const VARIANTS = new Uint8Array(256);
/** CARDED[id] = 1 for a kit model whose CARD is not its FAR model (§105.3: not the litter, not the farm's mounds). */
const CARDED = new Uint8Array(256);

for (let id = 0; id < 256; id++) {
  OPAQUE[id] = isOpaque(id) ? 1 : 0;
  LAYER[id] = getRenderLayer(id);
  UNMESHED[id] = isMeshed(id) ? 0 : 1;
  FREE_SURFACE[id] = id === BLOCK.AIR || !isMeshed(id) ? 1 : 0;
  WET[id] = isWater(id) ? 1 : 0;
  FULL_WATER[id] = waterLevel(id) === 7 ? 1 : 0;
  SURFACE[id] = WET[id] ? waterSurfaceHeight(id, BLOCK.AIR) : 1;
  const shape = getBlockShape(id);
  SHAPE[id] = shape === 'decal' ? SHAPE_DECAL : isKitModel(id) ? SHAPE_PLANT : shape === 'model' ? SHAPE_MODEL : 0;
  if (SHAPE[id] === SHAPE_MODEL) {
    MODELS[id] = furnitureModel(id);
    MODEL_UV[id] = tileToUV(furnitureModelTile(id) ?? getFaceTile(id, FACE_TOP));
  }
  VARIANTS[id] = plantVariants(id);
  CARDED[id] = isKitModel(id) && plantCardSlot(id) >= 0 ? 1 : 0;
  for (let f = 0; f < FACE_COUNT; f++) {
    const uv = tileToUV(getFaceTile(id, f));
    const o = (id * FACE_COUNT + f) * 4;
    FACE_UV[o] = uv[0];
    FACE_UV[o + 1] = uv[1];
    FACE_UV[o + 2] = uv[2];
    FACE_UV[o + 3] = uv[3];
    TINTED[id * FACE_COUNT + f] = isTintedFace(id, f) ? 1 : 0;
    const tv = tileVariants(getFaceTile(id, f));
    const vi = id * FACE_COUNT + f;
    VAR_COUNT[vi] = tv ? tv.count : 1;
    VAR_MODE[vi] = tv ? tv.mode : 0;
    for (let k = 0; k < MAX_VARIANTS; k++) VAR_UV.set(tileToUV(tv ? tv.slots[k % tv.count] : getFaceTile(id, f)), (vi * MAX_VARIANTS + k) * 4);
    if (VAR_COUNT[vi] > 1 || VAR_MODE[vi] !== 0) VARIES[id] = 1;
  }
  if (BLOCK_JITTER[id] > 0) VARIES[id] = 1;
}
for (let a = 0; a < 256; a++) {
  for (let b = 0; b < 256; b++) RENDER[(a << 8) | b] = shouldRenderFace(a, b) ? 1 : 0;
}

/**
 * §10.2 step 1: the top of water cell `a` (WET) whose upper neighbour is `above` — 1 under more water and for a FULL
 * cell (source or falling water) under a block meshed as a full prism, else its free surface SURFACE[a]. The SAME rule
 * gives a water neighbour's top for the side strips (2a), so two full cells that are both covered stand at 1 and draw
 * nothing between them (a glass floor over a pool shows no honeycomb of coincident strips).
 */
function waterTopY(a, above) {
  if (WET[above] === 1 || (FREE_SURFACE[above] === 0 && FULL_WATER[a] === 1)) return 1;
  return SURFACE[a];
}

/** Axial offsets of the six side neighbours as flat arrays. */
const DIR_DQ = new Int8Array(6);
const DIR_DR = new Int8Array(6);
for (let j = 0; j < SIDE_FACE_COUNT; j++) {
  DIR_DQ[j] = HEX_DIRS[j][0];
  DIR_DR[j] = HEX_DIRS[j][1];
}

/** Corner offsets from the cell centre. */
const CORNER_X = new Float64Array(6);
const CORNER_Z = new Float64Array(6);
for (let k = 0; k < 6; k++) {
  CORNER_X[k] = HEX_CORNERS[k][0];
  CORNER_Z[k] = HEX_CORNERS[k][1];
}

// Side-face vertex tables (index i = j * 4 + v). Vertex order per face j, CCW seen from outside:
// 0: bottom corner j+1 (left), 1: bottom corner j (right), 2: top corner j, 3: top corner j+1.
// SIDE_THIRD is the side face whose neighbour shares the vertical edge at that corner (face j−1 for
// corner j, face j+1 for corner j+1): the "third cell" around the edge, used as the horizontal AO sample.
const SIDE_CORNER = new Uint8Array(24);
const SIDE_TOP = new Uint8Array(24);
const SIDE_THIRD = new Uint8Array(24);
for (let j = 0; j < SIDE_FACE_COUNT; j++) {
  const next = (j + 1) % 6;
  const prev = (j + 5) % 6;
  SIDE_CORNER[j * 4] = next; SIDE_TOP[j * 4] = 0; SIDE_THIRD[j * 4] = next;
  SIDE_CORNER[j * 4 + 1] = j; SIDE_TOP[j * 4 + 1] = 0; SIDE_THIRD[j * 4 + 1] = prev;
  SIDE_CORNER[j * 4 + 2] = j; SIDE_TOP[j * 4 + 2] = 1; SIDE_THIRD[j * 4 + 2] = prev;
  SIDE_CORNER[j * 4 + 3] = next; SIDE_TOP[j * 4 + 3] = 1; SIDE_THIRD[j * 4 + 3] = next;
}

/** Corner emission order of the hexagonal faces: decreasing angle for the top (CCW from +Y), increasing for the bottom. */
const TOP_ORDER = Object.freeze([0, 5, 4, 3, 2, 1]);
const BOTTOM_ORDER = Object.freeze([0, 1, 2, 3, 4, 5]);

const NORMAL_X = new Float64Array(FACE_COUNT);
const NORMAL_Y = new Float64Array(FACE_COUNT);
const NORMAL_Z = new Float64Array(FACE_COUNT);
for (let f = 0; f < FACE_COUNT; f++) {
  NORMAL_X[f] = FACE_NORMALS[f][0];
  NORMAL_Y[f] = FACE_NORMALS[f][1];
  NORMAL_Z[f] = FACE_NORMALS[f][2];
}

/** Half the width of the side-face texture window, as a fraction of the tile: one edge length (texel density = 1 tile / unit). */
const SIDE_HALF_U = HEX_SIZE / 2;
/** §90: how far (whole pixels of a 32-px slot, either way) a side's window may slide and stay inside its tile. */
const SIDE_SHIFT_PX = Math.floor((0.5 - SIDE_HALF_U) * ATLAS_SLOT_PX);

// §90: the cell being meshed. buildChunkMesh sets the world column per column and `varyOn` per cell (VARIES[a] for a
// prism, 0 for a plant, litter or decal); emitSide and emitHex then pick the face's picture, its mirror and slide, and
// the cell's brightness from variantHash of the cell, so a block keeps its look through every re-mesh and reload.
let varyQ = 0;
let varyR = 0;
let varyOn = 0;
let variationEnabled = true;

/**
 * §90: switch per-cell variation on or off (on by default). Off, every face shows its tile's first picture, unturned, at
 * its exact colour — the look before §90 at the new resolution (tests of AO and UV windows, side-by-side screenshots).
 * Chunks meshed before the call keep their look until re-meshed.
 * @param {boolean} on
 */
export function setCellVariation(on) {
  variationEnabled = !!on;
}

/** @returns {boolean} whether buildChunkMesh varies cells (§90) */
export function cellVariationEnabled() {
  return variationEnabled;
}
/** The face's roll, set by faceVariant: [rect u0, v0, u1, v1] in varUV, and the mirror / flip / slide it chose. */
const varUV = new Float32Array(4);
let varMirror = 0;
let varFlipV = 0;
let varShift = 0;

/**
 * §90: choose face `f` of block `a` at (varyQ, ly, varyR): its picture's rect into varUV, and varMirror / varFlipV /
 * varShift by the tile's VARY_* bits. Returns false (nothing chosen: use FACE_UV) when the face does not vary.
 */
function faceVariant(a, f, ly) {
  const vi = a * FACE_COUNT + f;
  const count = VAR_COUNT[vi];
  const mode = VAR_MODE[vi];
  if (count === 1 && mode === 0) return false;
  const h = variantHash(varyQ, ly, varyR, f + 1);
  const k = count > 1 ? h % count : 0;
  const o = (vi * MAX_VARIANTS + k) * 4;
  varUV[0] = VAR_UV[o];
  varUV[1] = VAR_UV[o + 1];
  varUV[2] = VAR_UV[o + 2];
  varUV[3] = VAR_UV[o + 3];
  const isCap = f >= SIDE_FACE_COUNT;
  varMirror = (isCap ? mode & VARY_CAP : mode & VARY_MIRROR) && (h >>> 8) & 1 ? 1 : 0;
  varFlipV = isCap && mode & VARY_CAP && (h >>> 9) & 1 ? 1 : 0;
  varShift = !isCap && mode & VARY_SHIFT ? ((h >>> 10) % (2 * SIDE_SHIFT_PX + 1)) - SIDE_SHIFT_PX : 0;
  return true;
}

/**
 * §90: the cell's brightness roll (1 ± BLOCK_JITTER[a]), and for leaves a drift of the red channel toward yellow or
 * blue-green; written into jit[0..2] (multipliers of r, g, b).
 */
const jit = new Float64Array(3);
function cellJitter(a, ly) {
  const amp = BLOCK_JITTER[a];
  if (amp === 0) {
    jit[0] = 1; jit[1] = 1; jit[2] = 1;
    return;
  }
  const h = variantHash(varyQ, ly, varyR, 0);
  const s = 1 + amp * ((h & 0xffff) / 32767.5 - 1);
  jit[0] = s; jit[1] = s; jit[2] = s;
  if (LEAFY[a] === 1) jit[0] *= 1 + LEAF_HUE_SHIFT * (((h >>> 16) & 0xffff) / 32767.5 - 1);
}

// ---------------------------------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------------------------------

/**
 * Classic voxel ambient-occlusion term for one side-face vertex.
 * @param {0|1} side1   first edge-adjacent neighbour is opaque
 * @param {0|1} side2   second edge-adjacent neighbour is opaque
 * @param {0|1} corner  diagonal neighbour is opaque
 * @returns {0|1|2|3} 3 = fully lit, 0 = fully occluded
 */
export function vertexAO(side1, side2, corner) {
  if (side1 && side2) return 0;
  return /** @type {0|1|2|3} */ (3 - (side1 + side2 + corner));
}

/**
 * Ambient-occlusion term for a corner of a hexagonal top/bottom face: only two cells (besides the face
 * neighbour) touch a hex corner, so the value is simply 3 minus the number of opaque ones.
 * @param {0|1} sideA
 * @param {0|1} sideB
 * @returns {1|2|3}
 */
export function hexCornerAO(sideA, sideB) {
  return /** @type {1|2|3} */ (3 - (sideA + sideB));
}

/**
 * @typedef {Object} MeshBuilder  Growable typed-array triangle accumulator (one per render layer).
 * @property {Float32Array} positions
 * @property {Float32Array} normals
 * @property {Float32Array} uvs
 * @property {Float32Array} colors
 * @property {Uint8Array} light          2 per vertex: sky·17, block·17 (§62)
 * @property {Uint32Array} indices
 * @property {number} vertexCount
 * @property {number} indexCount
 * @property {number} faceCount
 * @property {number} vertexCapacity
 * @property {number} indexCapacity
 * @property {() => void} reset          rewind counts (keeps capacity)
 * @property {(vertices: number, indices: number) => void} ensure   guarantee room for that many more vertices / indices
 * @property {() => (MeshData|null)} build    exact-length copies of the filled prefix; null when faceCount === 0
 */

/**
 * Create a growable triangle buffer. Buffers double when full; `build()` returns exact-length copies so the
 * builder can be reused for the next chunk without aliasing the returned MeshData.
 * @param {number} [initialVertices=1024]
 * @returns {MeshBuilder}
 */
export function createMeshBuilder(initialVertices = 1024) {
  const vcap0 = Math.max(8, Math.floor(initialVertices) || 8);
  const icap0 = vcap0 * 3;
  /** @type {MeshBuilder} */
  const b = {
    positions: new Float32Array(vcap0 * 3),
    normals: new Float32Array(vcap0 * 3),
    uvs: new Float32Array(vcap0 * 2),
    colors: new Float32Array(vcap0 * 3),
    light: new Uint8Array(vcap0 * 2),
    indices: new Uint32Array(icap0),
    vertexCount: 0,
    indexCount: 0,
    faceCount: 0,
    vertexCapacity: vcap0,
    indexCapacity: icap0,
    reset() {
      b.vertexCount = 0;
      b.indexCount = 0;
      b.faceCount = 0;
    },
    ensure(vertices, indices) {
      const needV = b.vertexCount + vertices;
      if (needV > b.vertexCapacity) {
        let cap = b.vertexCapacity * 2;
        while (cap < needV) cap *= 2;
        const positions = new Float32Array(cap * 3);
        positions.set(b.positions.subarray(0, b.vertexCount * 3));
        const normals = new Float32Array(cap * 3);
        normals.set(b.normals.subarray(0, b.vertexCount * 3));
        const uvs = new Float32Array(cap * 2);
        uvs.set(b.uvs.subarray(0, b.vertexCount * 2));
        const colors = new Float32Array(cap * 3);
        colors.set(b.colors.subarray(0, b.vertexCount * 3));
        const light = new Uint8Array(cap * 2);
        light.set(b.light.subarray(0, b.vertexCount * 2));
        b.positions = positions;
        b.normals = normals;
        b.uvs = uvs;
        b.colors = colors;
        b.light = light;
        b.vertexCapacity = cap;
      }
      const needI = b.indexCount + indices;
      if (needI > b.indexCapacity) {
        let cap = b.indexCapacity * 2;
        while (cap < needI) cap *= 2;
        const idx = new Uint32Array(cap);
        idx.set(b.indices.subarray(0, b.indexCount));
        b.indices = idx;
        b.indexCapacity = cap;
      }
    },
    build() {
      if (b.faceCount === 0) return null;
      const vc = b.vertexCount;
      return {
        positions: b.positions.slice(0, vc * 3),
        normals: b.normals.slice(0, vc * 3),
        uvs: b.uvs.slice(0, vc * 2),
        colors: b.colors.slice(0, vc * 3),
        light: b.light.slice(0, vc * 2),
        indices: b.indices.slice(0, b.indexCount),
        vertexCount: vc,
        indexCount: b.indexCount,
        faceCount: b.faceCount,
      };
    },
  };
  return b;
}

/**
 * Module-level builders, index = render layer (0 opaque, 1 cutout, 2 translucent), and 3 the kit models' own (§105.4:
 * drawn with the cutout material in a mesh of their own, so a change of their level of detail re-meshes only them).
 */
const builders = [createMeshBuilder(8192), createMeshBuilder(1024), createMeshBuilder(1024), createMeshBuilder(4096)];

// ---------------------------------------------------------------------------------------------------
// Padded volume fill
// ---------------------------------------------------------------------------------------------------

/** Biome array of the centre chunk during a build (null → no tint). */
let centreBiomes = null;

/**
 * Fill `padded` with the centre chunk and its six hex-adjacent neighbours, per §10.1. The two index-space
 * corner chunks ((−1,−1) and (+1,+1)) are not hex-adjacent to anything in this chunk and are never sampled,
 * so they are not even fetched. A null/undefined result (or one without a `blocks` array) is AIR.
 * @param {number} cq
 * @param {number} cr
 * @param {GetChunkDataFn} getChunkData
 * @returns {boolean} true iff the centre chunk has data
 */
function fillPadded(cq, cr, getChunkData) {
  padded.fill(0);
  paddedLight.fill(FULL_SKY);
  if (coverDirty) {
    paddedCover.fill(0);
    coverDirty = false;
  }
  centreBiomes = null;
  let hasCentre = false;
  let anyCover = false;
  for (let dcq = -1; dcq <= 1; dcq++) {
    for (let dcr = -1; dcr <= 1; dcr++) {
      if (dcq === dcr && dcq !== 0) {
        neighbourData[(dcq + 1) * 3 + (dcr + 1)] = null;
        neighbourLight[(dcq + 1) * 3 + (dcr + 1)] = null;
        neighbourCover[(dcq + 1) * 3 + (dcr + 1)] = null;
        continue;
      }
      const data = getChunkData(cq + dcq, cr + dcr);
      const blocks = data && data.blocks;
      const ok = !!blocks && typeof blocks.subarray === 'function' && blocks.length >= WORLD_HEIGHT * CHUNK_SIZE * CHUNK_SIZE;
      neighbourData[(dcq + 1) * 3 + (dcr + 1)] = ok ? blocks : null;
      const light = ok ? /** @type {{ light?: Uint8Array|null }} */ (data).light : null;
      neighbourLight[(dcq + 1) * 3 + (dcr + 1)] = light instanceof Uint8Array && light.length >= blocks.length ? light : null;
      const cover = ok ? /** @type {{ cover?: Uint8Array|null }} */ (data).cover : null;
      const hasCover = cover instanceof Uint8Array && cover.length >= blocks.length;
      neighbourCover[(dcq + 1) * 3 + (dcr + 1)] = hasCover ? cover : null;
      if (hasCover) anyCover = true;
      if (dcq === 0 && dcr === 0 && ok) {
        hasCentre = true;
        const biomes = data.biomes;
        centreBiomes = biomes && biomes.length >= CHUNK_SIZE * CHUNK_SIZE ? biomes : null;
      }
    }
  }
  for (let pq = 0; pq < PAD; pq++) {
    const dcq = floorDiv(pq - 1, CHUNK_SIZE);
    const slq = mod(pq - 1, CHUNK_SIZE);
    for (let pr = 0; pr < PAD; pr++) {
      const dcr = floorDiv(pr - 1, CHUNK_SIZE);
      const blocks = neighbourData[(dcq + 1) * 3 + (dcr + 1)];
      if (!blocks) continue;
      const slr = mod(pr - 1, CHUNK_SIZE);
      const base = localIndex(slq, 0, slr);
      padded.set(blocks.subarray(base, base + WORLD_HEIGHT), pIndex(pq, 0, pr));
      const light = neighbourLight[(dcq + 1) * 3 + (dcr + 1)];
      if (light) paddedLight.set(light.subarray(base, base + WORLD_HEIGHT), pIndex(pq, 0, pr));
      const cover = anyCover ? neighbourCover[(dcq + 1) * 3 + (dcr + 1)] : null;
      if (cover) paddedCover.set(cover.subarray(base, base + WORLD_HEIGHT), pIndex(pq, 0, pr));
    }
  }
  coverOn = anyCover;
  if (anyCover) coverDirty = true;
  neighbourData.fill(null); // do not retain references to chunk arrays between calls
  neighbourLight.fill(null);
  neighbourCover.fill(null);
  return hasCentre;
}

/**
 * Opacity of the padded cell (pq, py, pr) with the out-of-range rules of §10.1: below the world is
 * BEDROCK (opaque), above it is AIR. pq/pr are always within [0, 18) for every sample the mesher takes.
 * @returns {number} 0 or 1
 */
function opaqueAt(pq, py, pr) {
  if (py < 0) return 1;
  if (py >= WORLD_HEIGHT) return 0;
  return OPAQUE[padded[(pq * PAD + pr) * WORLD_HEIGHT + py]];
}

/**
 * Packed light (sky << 4 | block) of the padded cell (pq, py, pr): open sky above the world, dark below it.
 * @returns {number}
 */
function lightAt(pq, py, pr) {
  if (py < 0) return 0;
  if (py >= WORLD_HEIGHT) return FULL_SKY;
  return paddedLight[(pq * PAD + pr) * WORLD_HEIGHT + py];
}

/** Sky·17 and block·17 of a packed light byte (a whole level → a multiple of 17, 15 → 255). */
function writeLight(out, o, packed) {
  out[o] = (packed >> 4) * 17;
  out[o + 1] = (packed & 15) * 17;
}

// ---------------------------------------------------------------------------------------------------
// Face emission
// ---------------------------------------------------------------------------------------------------

/**
 * §93.9: while `clipOn`, emitSide draws only the part of the face from `clipA` to `clipB` of the way from its corner j to
 * its corner j + 1 (water in brickwork meeting the face with one of its two quarters).
 */
let clipOn = false;
let clipA = 0;
let clipB = 1;

/**
 * Emit side face `f` (0..5) of the cell at padded column (pq, pr), height ly, whose centre is at local
 * (cx, cz). The quad spans `bottomY .. topY` above the cell's floor: 0 .. 1 for a full face; a water surface lowers
 * `topY`, and between two water cells only the part of the higher surface above the lower one is drawn (`bottomY`).
 * The texture window is cut to the same span (v1 at height 0, v0 at height 1), and to clipA .. clipB while clipOn.
 */
function emitSide(bld, f, pq, pr, ly, cx, cz, topY, bottomY, a, tr, tg, tb) {
  bld.ensure(4, 6);
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const b = bld.vertexCount;
  const shade = FACE_SHADE[f];
  const nx = NORMAL_X[f];
  const nz = NORMAL_Z[f];
  const uo = (a * FACE_COUNT + f) * 4;
  const varied = varyOn === 1 && faceVariant(a, f, ly);
  const uvs4 = varied ? varUV : FACE_UV;
  const ub = varied ? 0 : uo;
  const u0 = uvs4[ub];
  const v0 = uvs4[ub + 1];
  const u1 = uvs4[ub + 2];
  const v1 = uvs4[ub + 3];
  const uMid = (u0 + u1) * 0.5 + (varied ? ((u1 - u0) * varShift) / ATLAS_SLOT_PX : 0);
  // §90: a mirrored side reads its window right to left.
  const uHalf = (u1 - u0) * SIDE_HALF_U * (varied && varMirror ? -1 : 1);
  if (varyOn === 1) {
    cellJitter(a, ly);
    tr *= jit[0]; tg *= jit[1]; tb *= jit[2];
  }
  const vTop = topY === 1 ? v0 : v1 - (v1 - v0) * topY;
  const vBottom = bottomY === 0 ? v1 : v1 - (v1 - v0) * bottomY;
  const qq = pq + DIR_DQ[f];
  const qr = pr + DIR_DR[f];
  const light = bld.light;
  // §62: the face's front cell (its own cell when that is opaque), then per vertex the see-through AO samples.
  const front = opaqueAt(qq, ly, qr) ? lightAt(pq, ly, pr) : lightAt(qq, ly, qr);
  const frontSky = front >> 4;
  const frontBlock = front & 15;
  const emit = LIGHT_EMISSION[a];

  let ao0 = 0, ao1 = 0, ao2 = 0, ao3 = 0;
  for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    const k = SIDE_CORNER[i];
    const top = SIDE_TOP[i];
    const third = SIDE_THIRD[i];
    const tq = pq + DIR_DQ[third];
    const trr = pr + DIR_DR[third];
    const dy = top ? 1 : -1;
    // §10.2: the third cell around the vertical edge (horizontal), the face neighbour above/below (vertical)
    // and the third cell above/below (corner).
    const s1 = opaqueAt(tq, ly, trr);
    const s2 = opaqueAt(qq, ly + dy, qr);
    const c = opaqueAt(tq, ly + dy, trr);
    const ao = (s1 & s2) ? 0 : 3 - (s1 + s2 + c);
    if (v === 0) ao0 = ao; else if (v === 1) ao1 = ao; else if (v === 2) ao2 = ao; else ao3 = ao;
    let sky = frontSky;
    let blk = frontBlock;
    let n = 1;
    if (s1 === 0) {
      const l = lightAt(tq, ly, trr);
      sky += l >> 4; blk += l & 15; n++;
    }
    if (s2 === 0) {
      const l = lightAt(qq, ly + dy, qr);
      sky += l >> 4; blk += l & 15; n++;
    }
    if (c === 0 && (s1 & s2) === 0) {
      const l = lightAt(tq, ly + dy, trr);
      sky += l >> 4; blk += l & 15; n++;
    }
    const lb = blk / n;
    light[(b + v) * 2] = Math.round((sky / n) * 17);
    light[(b + v) * 2 + 1] = Math.round((lb > emit ? lb : emit) * 17);

    const vi = b + v;
    const p3 = vi * 3;
    const p2 = vi * 2;
    if (clipOn) {
      const tt = k === f ? clipA : clipB;
      const k1 = f === 5 ? 0 : f + 1;
      positions[p3] = cx + CORNER_X[f] + (CORNER_X[k1] - CORNER_X[f]) * tt;
      positions[p3 + 2] = cz + CORNER_Z[f] + (CORNER_Z[k1] - CORNER_Z[f]) * tt;
      uvs[p2] = uMid + uHalf - 2 * uHalf * tt;
    } else {
      positions[p3] = cx + CORNER_X[k];
      positions[p3 + 2] = cz + CORNER_Z[k];
      // Vertices 0 and 3 are the left edge of the face seen from outside, 1 and 2 the right edge.
      uvs[p2] = (v === 1 || v === 2) ? uMid + uHalf : uMid - uHalf;
    }
    positions[p3 + 1] = ly + (top ? topY : bottomY);
    normals[p3] = nx;
    normals[p3 + 1] = 0;
    normals[p3 + 2] = nz;
    uvs[p2 + 1] = top ? vTop : vBottom;
    const col = shade * AO_CURVE[ao];
    // §90: a cell's brightness roll may lift a colour past 1; colours stay in (0, 1].
    colors[p3] = Math.min(1, col * tr);
    colors[p3 + 1] = Math.min(1, col * tg);
    colors[p3 + 2] = Math.min(1, col * tb);
  }

  // Diagonal joins the brighter pair; both orders are CCW.
  const ib = bld.indexCount;
  if (ao0 + ao2 >= ao1 + ao3) {
    indices[ib] = b; indices[ib + 1] = b + 1; indices[ib + 2] = b + 2;
    indices[ib + 3] = b; indices[ib + 4] = b + 2; indices[ib + 5] = b + 3;
  } else {
    indices[ib] = b + 1; indices[ib + 1] = b + 2; indices[ib + 2] = b + 3;
    indices[ib + 3] = b + 1; indices[ib + 4] = b + 3; indices[ib + 5] = b;
  }
  bld.vertexCount = b + 4;
  bld.indexCount = ib + 6;
  bld.faceCount += 1;
}

/**
 * Emit the hexagonal top (f = 6) or bottom (f = 7) face as a 6-triangle fan around a centre vertex whose
 * colour is the mean of the six corners (smooth AO across the face).
 */
/** §70: when set, emitHex draws this tile rect [u0, v0, u1, v1] instead of the block's own (a decal's variant picture). */
let decalUV = /** @type {Float32Array|null} */ (null);
/** The flint variant of the loose stones (tile LOOSE_STONES_FLINT). */
const FLINT_UV = Float32Array.from(tileToUV(TILE.LOOSE_STONES_FLINT));

function emitHex(bld, f, pq, pr, ly, cx, cz, topY, a, tr, tg, tb, own = -1) {
  bld.ensure(7, 18);
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const b = bld.vertexCount;
  const isTop = f === FACE_TOP;
  const order = isTop ? TOP_ORDER : BOTTOM_ORDER;
  const dy = isTop ? 1 : -1;
  const ny = isTop ? 1 : -1;
  const yPos = isTop ? ly + topY : ly;
  const shade = FACE_SHADE[f];
  const varied = decalUV === null && varyOn === 1 && faceVariant(a, f, ly);
  const uvs4 = decalUV ?? (varied ? varUV : FACE_UV);
  const ub = decalUV || varied ? 0 : (a * FACE_COUNT + f) * 4;
  const u0 = uvs4[ub];
  const v0 = uvs4[ub + 1];
  const u1 = uvs4[ub + 2];
  const v1 = uvs4[ub + 3];
  const du = u1 - u0;
  const dv = v1 - v0;
  // The bottom face is seen mirrored; §90: a varied cap may also be mirrored left-right and top-bottom (the inscribed
  // hexagon maps onto itself either way).
  const uSign = (isTop ? TOP_UV_SCALE : -TOP_UV_SCALE) * (varied && varMirror ? -1 : 1);
  const vSign = TOP_UV_SCALE * (varied && varFlipV ? -1 : 1);
  if (varyOn === 1) {
    cellJitter(a, ly);
    tr *= jit[0]; tg *= jit[1]; tb *= jit[2];
  }
  const light = bld.light;
  // §62: the cell in front of the cap (its own cell when that is opaque, or for a decal: `own`), then per corner the two
  // see-through side cells that share it.
  const front = own >= 0 ? own : opaqueAt(pq, ly + dy, pr) ? lightAt(pq, ly, pr) : lightAt(pq, ly + dy, pr);
  const emit = LIGHT_EMISSION[a];
  let skySum = 0;
  let blockSum = 0;

  let sum = 0;
  for (let m = 0; m < 6; m++) {
    const k = order[m];
    const dA = (k + 5) % 6; // the two side neighbours sharing corner k: faces k−1 and k
    const dB = k;
    const sA = opaqueAt(pq + DIR_DQ[dA], ly + dy, pr + DIR_DR[dA]);
    const sB = opaqueAt(pq + DIR_DQ[dB], ly + dy, pr + DIR_DR[dB]);
    const col = shade * AO_CURVE[3 - (sA + sB)];
    sum += col;
    const vi = b + 1 + m;
    let sky = front >> 4;
    let blk = front & 15;
    if (own < 0) {
      let n = 1;
      if (sA === 0) {
        const l = lightAt(pq + DIR_DQ[dA], ly + dy, pr + DIR_DR[dA]);
        sky += l >> 4; blk += l & 15; n++;
      }
      if (sB === 0) {
        const l = lightAt(pq + DIR_DQ[dB], ly + dy, pr + DIR_DR[dB]);
        sky += l >> 4; blk += l & 15; n++;
      }
      sky /= n;
      blk /= n;
    }
    if (blk < emit) blk = emit;
    skySum += sky;
    blockSum += blk;
    light[vi * 2] = Math.round(sky * 17);
    light[vi * 2 + 1] = Math.round(blk * 17);
    const p3 = vi * 3;
    positions[p3] = cx + CORNER_X[k];
    positions[p3 + 1] = yPos;
    positions[p3 + 2] = cz + CORNER_Z[k];
    normals[p3] = 0;
    normals[p3 + 1] = ny;
    normals[p3 + 2] = 0;
    const p2 = vi * 2;
    uvs[p2] = u0 + du * (0.5 + uSign * CORNER_X[k]);
    uvs[p2 + 1] = v0 + dv * (0.5 + vSign * CORNER_Z[k]);
    colors[p3] = Math.min(1, col * tr);
    colors[p3 + 1] = Math.min(1, col * tg);
    colors[p3 + 2] = Math.min(1, col * tb);
  }
  // Centre vertex.
  const c3 = b * 3;
  positions[c3] = cx;
  positions[c3 + 1] = yPos;
  positions[c3 + 2] = cz;
  normals[c3] = 0;
  normals[c3 + 1] = ny;
  normals[c3 + 2] = 0;
  uvs[b * 2] = u0 + du * 0.5;
  uvs[b * 2 + 1] = v0 + dv * 0.5;
  const cc = sum / 6;
  colors[c3] = Math.min(1, cc * tr);
  colors[c3 + 1] = Math.min(1, cc * tg);
  colors[c3 + 2] = Math.min(1, cc * tb);
  light[b * 2] = Math.round((skySum / 6) * 17);
  light[b * 2 + 1] = Math.round((blockSum / 6) * 17);

  const ib = bld.indexCount;
  for (let m = 0; m < 6; m++) {
    const o = ib + m * 3;
    indices[o] = b;
    indices[o + 1] = b + 1 + m;
    indices[o + 2] = b + 1 + (m === 5 ? 0 : m + 1);
  }
  bld.vertexCount = b + 7;
  bld.indexCount = ib + 18;
  bld.faceCount += 1;
}

// §93.9: the pieces of a hex a brick can cover (bricks.js PIECE_*: bit k is entry k), as polygons [x0, z0, x1, z1, …]
// round the cell centre, in the turn of HEX_CORNERS (a cap is drawn the other way round). An even row's four quarters
// (NW, NE, SW, SE: cut through the centre both ways), an odd row's top point, middle and bottom point.
const HS = HEX_SIZE;
const EVEN_PIECES = Object.freeze([
  Float64Array.of(-0.5, 0, -0.5, -HS / 2, 0, -HS, 0, 0),
  Float64Array.of(0, -HS, 0.5, -HS / 2, 0.5, 0, 0, 0),
  Float64Array.of(0, 0, 0, HS, -0.5, HS / 2, -0.5, 0),
  Float64Array.of(0, 0, 0.5, 0, 0.5, HS / 2, 0, HS),
]);
const ODD_PIECES = Object.freeze([
  Float64Array.of(-0.5, -HS / 2, 0, -HS, 0.5, -HS / 2),
  Float64Array.of(0.5, -HS / 2, 0.5, HS / 2, -0.5, HS / 2, -0.5, -HS / 2),
  Float64Array.of(0.5, HS / 2, 0, HS, -0.5, HS / 2),
]);

/**
 * §93.9: the top (f = FACE_TOP, at height `topY`) or bottom face of the pieces `mask` of the cell (padded column (pq, pr),
 * height ly, centre (cx, cz); `even`: its row is even) — each piece a fan of its own, with the block's cap texture laid as
 * on the whole hexagon, no AO, and the light of the cell in front of it.
 */
function emitPieces(bld, f, pq, pr, ly, cx, cz, topY, a, mask, even, tr, tg, tb) {
  const polys = even ? EVEN_PIECES : ODD_PIECES;
  const isTop = f === FACE_TOP;
  const dy = isTop ? 1 : -1;
  const yPos = isTop ? ly + topY : ly;
  const uo = (a * FACE_COUNT + f) * 4;
  const u0 = FACE_UV[uo];
  const v0 = FACE_UV[uo + 1];
  const du = FACE_UV[uo + 2] - u0;
  const dv = FACE_UV[uo + 3] - v0;
  const uSign = isTop ? TOP_UV_SCALE : -TOP_UV_SCALE;
  const front = opaqueAt(pq, ly + dy, pr) ? lightAt(pq, ly, pr) : lightAt(pq, ly + dy, pr);
  const emit = LIGHT_EMISSION[a];
  const sky = (front >> 4) * 17;
  const blk = Math.max(front & 15, emit) * 17;
  const col = FACE_SHADE[f] * AO_CURVE[3];
  const r = Math.min(1, col * tr);
  const g = Math.min(1, col * tg);
  const bl = Math.min(1, col * tb);
  for (let k = 0; k < polys.length; k++) {
    if ((mask & (1 << k)) === 0) continue;
    const poly = polys[k];
    const nv = poly.length / 2;
    bld.ensure(nv, (nv - 2) * 3);
    const positions = bld.positions;
    const normals = bld.normals;
    const uvs = bld.uvs;
    const colors = bld.colors;
    const light = bld.light;
    const indices = bld.indices;
    const b = bld.vertexCount;
    for (let m = 0; m < nv; m++) {
      const src = isTop ? nv - 1 - m : m;
      const x = poly[src * 2];
      const z = poly[src * 2 + 1];
      const vi = b + m;
      const p3 = vi * 3;
      positions[p3] = cx + x;
      positions[p3 + 1] = yPos;
      positions[p3 + 2] = cz + z;
      normals[p3] = 0;
      normals[p3 + 1] = dy;
      normals[p3 + 2] = 0;
      uvs[vi * 2] = u0 + du * (0.5 + uSign * x);
      uvs[vi * 2 + 1] = v0 + dv * (0.5 + TOP_UV_SCALE * z);
      colors[p3] = r;
      colors[p3 + 1] = g;
      colors[p3 + 2] = bl;
      light[vi * 2] = sky;
      light[vi * 2 + 1] = blk;
    }
    const ib = bld.indexCount;
    for (let m = 1; m < nv - 1; m++) {
      const o = ib + (m - 1) * 3;
      indices[o] = b;
      indices[o + 1] = b + m;
      indices[o + 2] = b + m + 1;
    }
    bld.vertexCount = b + nv;
    bld.indexCount = ib + (nv - 2) * 3;
    bld.faceCount += 1;
  }
}

/** §93.9: the half of side face `f` of an even row's cell that its one open quarter `open` meets, as clipA .. clipB. */
function clipToQuarter(f, open) {
  // E (0) runs from the NE corner (0) to the SE corner (1); W (3) from the SW corner (3) to the NW corner (4).
  const first = f === 0 ? open === 2 : open === 4; // NE on the east face, SW on the west face: the first half
  clipA = first ? 0 : 0.5;
  clipB = first ? 0.5 : 1;
  clipOn = true;
}

/** A decal lies this far above the cell's floor (clear of the ground's top face, no z-fighting). */
export const DECAL_Y = 0.02;

/** Deterministic 0..1 from a world cell (how a plant or a piece of litter is turned, nudged and sized). */
export function cellHash(q, r, salt = 0) {
  let h = Math.imul(q | 0, 0x27d4eb2d) ^ Math.imul((r | 0) + salt * 0x9e3779b9, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------------
// §105: the plants, the farm's blocks and the ground litter as kit models on the plant atlas
// ---------------------------------------------------------------------------------------------------

/** A plant model is turned by any angle, moved off the cell's middle by up to MODEL_JITTER (m) … */
export const MODEL_JITTER = 0.04;
/** … and sized between MODEL_SCALE_MIN and MODEL_SCALE_MAX of its drawing, per world cell: no two plants quite alike. */
export const MODEL_SCALE_MIN = 0.9;
export const MODEL_SCALE_MAX = 1.05;
/**
 * A chunk draws at most this many triangles of NEAR plants: past it, the rest of its plants (in meshing order) are drawn
 * FAR. A field planted solid in Creative stays affordable; the land's own plants never come near it (CONTRACTS §105.5).
 */
export const PLANT_NEAR_TRIS_MAX = 60000;

/** The plant triangles of the chunk being built, near and in all; how many plant cells it holds, and how many of them
 * have a card of their own (CARDED). */
let plantNearTris = 0;
let plantTris = 0;
let plantCells = 0;
let plantCarded = 0;

/** Start counting a chunk's plants. */
function resetPlantCounts() {
  plantNearTris = 0;
  plantTris = 0;
  plantCells = 0;
  plantCarded = 0;
}

/**
 * The variant of kit model `a` at world column (wq, wr): LOOSE_STONES shows its flint one where blocks.flintAt says the
 * column holds flint (§70), every other model one of its variants by cellHash (salt 7).
 */
export function plantVariantAt(a, wq, wr) {
  if (a === BLOCK.LOOSE_STONES && flintAt(wq, wr)) return LOOSE_STONES_FLINT;
  const n = VARIANTS[a];
  return n > 1 ? Math.floor(cellHash(wq, wr, 7) * n) : 0;
}

/**
 * A kit model (§105): block `a`'s compiled plant at level of detail `lod` (its variant for the cell), turned by
 * cellHash(q, r) · 2π, nudged by up to MODEL_JITTER (salts 1, 2) and sized MODEL_SCALE_MIN..MAX (salt 5), into `bld`
 * (the chunk's plant layer). Its uvs are the plant atlas's — a CARD's too — moved PLANT_UV_OFFSET along u (the cutout
 * material samples the plant atlas there). Every vertex is lit by the plant's own cell (§62) and coloured grey by its
 * baked shade (plantKit compile: openness, slope, contact). No tint, no AO from the terrain, no culling.
 */
function emitPlant(bld, wq, wr, ly, cx, cz, a, own, lod) {
  let L = lod;
  if (L === PLANT_LOD_NEAR && plantNearTris >= PLANT_NEAR_TRIS_MAX) L = PLANT_LOD_FAR;
  const m = plantMesh(a, L, plantVariantAt(a, wq, wr));
  if (m === null) return;
  const nv = m.verts;
  const ni = m.tris * 3;
  bld.ensure(nv, ni);
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const light = bld.light;
  const turn = cellHash(wq, wr) * Math.PI * 2;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const k = MODEL_SCALE_MIN + (MODEL_SCALE_MAX - MODEL_SCALE_MIN) * cellHash(wq, wr, 5);
  const ox = cx + (cellHash(wq, wr, 1) - 0.5) * 2 * MODEL_JITTER;
  const oz = cz + (cellHash(wq, wr, 2) - 0.5) * 2 * MODEL_JITTER;
  const du = PLANT_UV_OFFSET;
  const d = m.data;
  const b = bld.vertexCount;
  for (let v = 0, o = 0; v < nv; v++, o += PLANT_STRIDE) {
    const x = d[o];
    const z = d[o + 2];
    const p3 = (b + v) * 3;
    positions[p3] = ox + (x * c + z * s) * k;
    positions[p3 + 1] = ly + d[o + 1] * k;
    positions[p3 + 2] = oz + (-x * s + z * c) * k;
    const nx = d[o + 3];
    const nz = d[o + 5];
    normals[p3] = nx * c + nz * s;
    normals[p3 + 1] = d[o + 4];
    normals[p3 + 2] = -nx * s + nz * c;
    const p2 = (b + v) * 2;
    uvs[p2] = d[o + 6] + du;
    uvs[p2 + 1] = d[o + 7];
    const shade = d[o + 8];
    colors[p3] = shade;
    colors[p3 + 1] = shade;
    colors[p3 + 2] = shade;
    writeLight(light, p2, own);
  }
  const idx = m.index;
  let ib = bld.indexCount;
  for (let t = 0; t < ni; t++) indices[ib++] = idx[t] + b;
  bld.vertexCount = b + nv;
  bld.indexCount = ib;
  bld.faceCount += m.tris;
  plantTris += m.tris;
  plantCells++;
  plantCarded += CARDED[a];
  if (L === PLANT_LOD_NEAR) plantNearTris += m.tris;
}

// ---------------------------------------------------------------------------------------------------
// §85: the furniture (the well, the rain barrel, the two beds) as box models cut from 16-px skins
// ---------------------------------------------------------------------------------------------------

/** How much darker a box model's faces are where they meet the ground (contact shade), and the light on its faces. */
export const BOX_GROUND_SHADE = 0.78;
const BOX_KEY_X = 0.35;
const BOX_KEY_Y = 0.85;
const BOX_KEY_Z = 0.4;
/** Texels per metre on a box model's skin (a 16-texel tile spans one cell). */
const BOX_TEXELS = 16;

/**
 * A piece of furniture (§85, BlockDef.shape 'model' without a kit model): the compiled quads of its box model, turned,
 * nudged and sized per world cell like a plant, cut from its own tile, in the cutout layer. Faces are shaded by where
 * they face (top brightest) × the quad's shade, darker where they meet the ground, and lit by the cell's own light.
 */
function emitModel(bld, wq, wr, ly, cx, cz, a, own) {
  const quads = MODELS[a];
  const uv = MODEL_UV[a];
  if (quads === null || uv === null) return;
  const n = quads.length / BOX_QUAD_STRIDE;
  bld.ensure(4 * n, 6 * n);
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const light = bld.light;
  const turn = cellHash(wq, wr) * Math.PI * 2;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const k = MODEL_SCALE_MIN + (MODEL_SCALE_MAX - MODEL_SCALE_MIN) * cellHash(wq, wr, 5);
  const ox = cx + (cellHash(wq, wr, 1) - 0.5) * 2 * MODEL_JITTER;
  const oz = cz + (cellHash(wq, wr, 2) - 0.5) * 2 * MODEL_JITTER;
  const du = (uv[2] - uv[0]) / BOX_TEXELS;
  const dv = (uv[3] - uv[1]) / BOX_TEXELS;
  let b = bld.vertexCount;
  let ib = bld.indexCount;
  for (let q = 0, o = 0; q < n; q++, o += BOX_QUAD_STRIDE) {
    const mx = quads[o + 20];
    const ny = quads[o + 21];
    const mz = quads[o + 22];
    const nx = mx * c + mz * s;
    const nz = -mx * s + mz * c;
    const shade = quads[o + 23] * (0.58 + 0.42 * Math.min(1, Math.max(0, 0.5 + 0.5 * (nx * BOX_KEY_X + ny * BOX_KEY_Y + nz * BOX_KEY_Z))));
    for (let v = 0; v < 4; v++) {
      const p = o + v * 5;
      const x = quads[p];
      const y = quads[p + 1];
      const z = quads[p + 2];
      const p3 = (b + v) * 3;
      positions[p3] = ox + (x * c + z * s) * k;
      positions[p3 + 1] = ly + y * k;
      positions[p3 + 2] = oz + (-x * s + z * c) * k;
      normals[p3] = nx;
      normals[p3 + 1] = ny;
      normals[p3 + 2] = nz;
      const p2 = (b + v) * 2;
      uvs[p2] = uv[0] + quads[p + 3] * du;
      uvs[p2 + 1] = uv[1] + quads[p + 4] * dv;
      const col = shade * (y < 0.03 ? BOX_GROUND_SHADE : 1);
      colors[p3] = col;
      colors[p3 + 1] = col;
      colors[p3 + 2] = col;
      writeLight(light, (b + v) * 2, own);
    }
    indices[ib] = b; indices[ib + 1] = b + 1; indices[ib + 2] = b + 2;
    indices[ib + 3] = b; indices[ib + 4] = b + 2; indices[ib + 5] = b + 3;
    b += 4;
    ib += 6;
  }
  bld.vertexCount = b;
  bld.indexCount = ib;
  bld.faceCount += n;
}

// ---------------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------------

const BRICK_SHADOW = BLOCK.BRICK_SHADOW;

/**
 * §93.9: a BRICK_SHADOW cell (padded column (pq, pr), row lr, height ly): every open piece of it that meets a face with
 * water beyond it (an open piece on that side too) is drawn full of that water, to the highest such water's surface
 * (waterTopY), as that water's cap — none where the water goes on above it or a brick's floor lies on it. Water to the
 * sides of such a point draws no side toward it (buildChunkMesh), so a surface runs on into the corner of the brick.
 */
function drawThrough(pq, pr, lr, ly, cx, cz, colBase, even, tint) {
  const cover = paddedCover[colBase + ly] & 15;
  const open = (even ? 15 : 7) & ~cover;
  if (open === 0) return;
  const above = ly + 1 < WORLD_HEIGHT ? padded[colBase + ly + 1] : 0;
  const coverAbove = ly + 1 < WORLD_HEIGHT ? paddedCover[colBase + ly + 1] & 15 : 0;
  for (let p = 1; p <= open; p <<= 1) {
    if ((open & p) === 0) continue;
    let level = -1;
    let water = 0;
    for (let f = 0; f < SIDE_FACE_COUNT; f++) {
      if ((facePieces(lr, f) & p) === 0) continue;
      const nBase = ((pq + DIR_DQ[f]) * PAD + (pr + DIR_DR[f])) * WORLD_HEIGHT;
      const n = padded[nBase + ly];
      if (WET[n] === 0) continue;
      const nr = lr + DIR_DR[f];
      if ((facePieces(nr, (f + 3) % 6) & ~(paddedCover[nBase + ly] & 15)) === 0) continue;
      const top = waterTopY(n, ly + 1 < WORLD_HEIGHT ? padded[nBase + ly + 1] : 0);
      if (top > level) {
        level = top;
        water = n;
      }
    }
    if (level < 0) continue;
    if (level >= 1 && ((WET[above] === 1 && (coverAbove & p) === 0) || (coverAbove & p) !== 0)) continue;
    const bld = builders[LAYER[water]];
    const t = TINTED[water * FACE_COUNT + FACE_TOP];
    emitPieces(bld, FACE_TOP, pq, pr, ly, cx, cz, level, water, p, even, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
  }
}

/**
 * Build the render geometry of chunk (cq, cr). Positions are chunk-local: relative to the centre of local
 * cell (0, 0) (hex.chunkOrigin), which is where the renderer places the mesh. Never throws for well-formed
 * inputs; a chunk with no visible faces yields `{ opaque: null, cutout: null, translucent: null }`.
 * @param {number} cq
 * @param {number} cr
 * @param {GetChunkDataFn} getChunkData  called for the centre chunk and its six hex neighbours; null → AIR
 * @param {{ plantLod?: number }} [opts]  the level of detail of its plants (§105: PLANT_LOD_NEAR, the default; FAR; CARD)
 * @returns {ChunkMeshData}  with, when it drew any kit model, `plantLayer` (their geometry, drawn with the cutout
 *   material), `plants` (how many kit-model cells), `plantTris` (their triangles) and `plantCards` (how many of them have a
 *   card of their own)
 */
export function buildChunkMesh(cq, cr, getChunkData, opts = {}) {
  const plantLod = opts.plantLod ?? PLANT_LOD_NEAR;
  resetPlantCounts();
  const opaqueB = builders[0];
  const cutoutB = builders[1];
  const translucentB = builders[2];
  const plantB = builders[3];
  opaqueB.reset();
  cutoutB.reset();
  translucentB.reset();
  plantB.reset();

  if (!fillPadded(cq, cr, getChunkData)) {
    return { opaque: null, cutout: null, translucent: null };
  }

  const BEDROCK = BLOCK.BEDROCK;
  const biomes = centreBiomes;

  for (let lq = 0; lq < CHUNK_SIZE; lq++) {
    const pq = lq + 1;
    for (let lr = 0; lr < CHUNK_SIZE; lr++) {
      const pr = lr + 1;
      const colBase = (pq * PAD + pr) * WORLD_HEIGHT;
      const cx = lq + lr * 0.5;
      const cz = lr * HEX_ROW_SPACING;
      const tint = BIOME_TINT[biomes ? biomes[lq * CHUNK_SIZE + lr] : BIOME.PLAINS] ?? BIOME_TINT[BIOME.PLAINS];
      varyQ = cq * CHUNK_SIZE + lq;
      varyR = cr * CHUNK_SIZE + lr;

      const even = (lr & 1) === 0; // (a chunk is an even number of rows deep: the row's parity is lr's)
      for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
        const a = padded[colBase + ly];
        if (a === 0 || UNMESHED[a] === 1) {
          // air, or a block drawn by its own model (campfire); §93.9: brickwork's leftover points beside water hold it
          if (a === BRICK_SHADOW && coverOn) drawThrough(pq, pr, lr, ly, cx, cz, colBase, even, tint);
          continue;
        }

        // §10.2 step 1: a water cell's surface height (waterSurfaceHeight: lower for flowing levels; 1 under more water)
        // applies to every top vertex of this cell. A full cell (source or falling water) under a block meshed as a
        // full prism stays full height; a flowing level keeps its own height wherever it is.
        const wet = WET[a];
        const above = ly + 1 < WORLD_HEIGHT ? padded[colBase + ly + 1] : 0;
        const topY = wet ? waterTopY(a, above) : 1;
        // §93.9: the pieces of a water cell under bricks (0: none, or no bricks round this chunk)
        const own = wet && coverOn ? paddedCover[colBase + ly] & 15 : 0;

        const renderRow = a << 8;
        const layer = LAYER[a];
        const bld = layer === 0 ? opaqueB : layer === 1 ? cutoutB : translucentB;
        const tintRow = a * FACE_COUNT;

        // A plant or a piece of litter is a kit model, furniture a box model, a snare a picture on the floor: never a
        // hexagonal prism (no faces, no culling).
        const shape = SHAPE[a];
        varyOn = shape === 0 && variationEnabled ? VARIES[a] : 0;
        if (shape !== 0) {
          const t = TINTED[tintRow + FACE_TOP];
          const tr = t ? tint[0] : 1;
          const tg = t ? tint[1] : 1;
          const tb = t ? tint[2] : 1;
          const own = lightAt(pq, ly, pr); // a plant or a decal is lit by its own cell (§62)
          if (shape === SHAPE_PLANT) emitPlant(plantB, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr, ly, cx, cz, a, own, plantLod);
          else if (shape === SHAPE_MODEL) emitModel(bld, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr, ly, cx, cz, a, own);
          else {
            // §70: the loose stones that hold flint are drawn with the flint tile, so flint can be seen where it lies.
            decalUV = a === BLOCK.LOOSE_STONES && flintAt(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr) ? FLINT_UV : null;
            emitHex(bld, FACE_TOP, pq, pr, ly, cx, cz, DECAL_Y, a, tr, tg, tb, own);
            decalUV = null;
          }
          continue;
        }

        for (let f = 0; f < SIDE_FACE_COUNT; f++) {
          const nBase = ((pq + DIR_DQ[f]) * PAD + (pr + DIR_DR[f])) * WORLD_HEIGHT;
          const q = padded[nBase + ly];
          let bottomY = 0;
          if (wet && coverOn) {
            // §93.9: never toward brickwork's shadow (a brick face there, or a point drawn full of this water), never
            // across a face brickwork closes; where only one of an even row's two quarters meets the face, half of it.
            if (q === BRICK_SHADOW) continue;
            const theirs = paddedCover[nBase + ly] & 15;
            if ((own | theirs) !== 0) {
              if (!waterCrossesFace(own, lr, f, theirs, lr + DIR_DR[f])) continue;
              if (own !== 0 && even && (f === 0 || f === 3)) {
                const open = facePieces(lr, f) & ~own;
                if (open !== facePieces(lr, f)) clipToQuarter(f, open);
              }
            }
          }
          if (wet && WET[q]) {
            // Two water cells: only the part of this surface above the neighbour's (§10.2 step 2a), the neighbour's
            // top by the same step-1 rule as this cell's (a covered full neighbour stands at 1 too).
            const nTop = waterTopY(q, ly + 1 < WORLD_HEIGHT ? padded[nBase + ly + 1] : 0);
            if (nTop >= topY) {
              clipOn = false;
              continue;
            }
            bottomY = nTop;
          } else if (RENDER[renderRow | q] === 0) {
            clipOn = false;
            continue;
          }
          const t = TINTED[tintRow + f];
          emitSide(bld, f, pq, pr, ly, cx, cz, topY, bottomY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
          clipOn = false;
        }
        {
          // A lowered water surface is always drawn (even under a solid: a low cave keeps its surface); never between
          // two water cells. A full-height one follows the normal culling rule (none under an opaque block, flush under a
          // see-through one).
          const q = above;
          if (wet ? !WET[q] && (topY < 1 || RENDER[renderRow | q] !== 0) : RENDER[renderRow | q] !== 0) {
            const t = TINTED[tintRow + FACE_TOP];
            // §93.9: water under bricks or among them: its open pieces, but where a brick's floor lies on the surface
            const capOver = wet && coverOn && topY >= 1 && ly + 1 < WORLD_HEIGHT ? paddedCover[colBase + ly + 1] & 15 : 0;
            if (own === 0 && capOver === 0) {
              emitHex(bld, FACE_TOP, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
            } else {
              const mask = (even ? 15 : 7) & ~own & ~capOver;
              if (mask !== 0) emitPieces(bld, FACE_TOP, pq, pr, ly, cx, cz, topY, a, mask, even, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
            }
          }
        }
        {
          const q = ly - 1 < 0 ? BEDROCK : padded[colBase + ly - 1];
          if (wet ? !WET[q] && RENDER[renderRow | q] !== 0 : RENDER[renderRow | q] !== 0) {
            const t = TINTED[tintRow + FACE_BOTTOM];
            const under = wet && coverOn && ly > 0 ? paddedCover[colBase + ly - 1] & 15 : 0;
            if (own === 0 && under === 0) {
              emitHex(bld, FACE_BOTTOM, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
            } else {
              const mask = (even ? 15 : 7) & ~own & ~under; // (§93.9: not on a brick's top)
              if (mask !== 0) emitPieces(bld, FACE_BOTTOM, pq, pr, ly, cx, cz, topY, a, mask, even, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
            }
          }
        }
      }
    }
  }

  varyOn = 0;
  /** @type {ChunkMeshData} */
  const out = {
    opaque: opaqueB.build(),
    cutout: cutoutB.build(),
    translucent: translucentB.build(),
  };
  if (plantCells > 0) {
    out.plantLayer = plantB.build();
    out.plants = plantCells;
    out.plantTris = plantTris;
    out.plantCards = plantCarded;
  }
  return out;
}

/**
 * §105.5: ONLY the kit models of chunk (cq, cr) at level of detail `plantLod` — exactly the `plantLayer` (and counts)
 * buildChunkMesh gives the same chunk — for a change of their level of detail: nothing else of the chunk is meshed, and
 * only the chunk's own blocks and light are read (a plant is lit by its own cell). `plantsOnly` marks it for the
 * renderer (setChunkMesh replaces the chunk's plant mesh and keeps the rest).
 * @param {number} cq
 * @param {number} cr
 * @param {GetChunkDataFn} getChunkData  called for the chunk itself only
 * @param {{ plantLod?: number }} [opts]
 * @returns {ChunkPlantData}
 */
export function buildChunkPlants(cq, cr, getChunkData, opts = {}) {
  const plantLod = opts.plantLod ?? PLANT_LOD_NEAR;
  resetPlantCounts();
  const plantB = builders[3];
  plantB.reset();
  const data = getChunkData(cq, cr);
  const blocks = data && data.blocks;
  const n = WORLD_HEIGHT * CHUNK_SIZE * CHUNK_SIZE;
  if (!blocks || typeof blocks.subarray !== 'function' || blocks.length < n) {
    return { plantsOnly: true, plantLayer: null, plants: 0, plantTris: 0, plantCards: 0 };
  }
  const lightArr = /** @type {{ light?: Uint8Array|null }} */ (data).light;
  const light = lightArr instanceof Uint8Array && lightArr.length >= blocks.length ? lightArr : null;
  for (let lq = 0; lq < CHUNK_SIZE; lq++) {
    for (let lr = 0; lr < CHUNK_SIZE; lr++) {
      const base = localIndex(lq, 0, lr);
      for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
        const a = blocks[base + ly];
        if (SHAPE[a] !== SHAPE_PLANT || UNMESHED[a] === 1) continue;
        const own = light ? light[base + ly] : FULL_SKY;
        emitPlant(plantB, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr, ly, lq + lr * 0.5, lr * HEX_ROW_SPACING, a, own, plantLod);
      }
    }
  }
  return { plantsOnly: true, plantLayer: plantB.build(), plants: plantCells, plantTris, plantCards: plantCarded };
}

/** Scratch chunk for buildCellMesh: one cell in an otherwise empty chunk (plains biome so tinted faces look normal). */
let cellChunk = null;

/**
 * The exact chunk geometry of a single, fully exposed cell of block `id` (every face, no AO, plains tint), centred on
 * the origin: x/z around (0, 0) like a cell at axial (0, 0), y from −0.5 to +0.5. Used to draw moving blocks (falling
 * sand, debris, toppling trees). The cell is meshed at y = 1 of a lone chunk so the bottom face is not culled against
 * the bedrock rule below the world. Fresh arrays per call; callers cache per id.
 * @param {number} id
 * @returns {ChunkMeshData}
 */
export function buildCellMesh(id) {
  if (cellChunk === null) {
    cellChunk = {
      blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT),
      biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(BIOME.PLAINS),
      heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE),
    };
  }
  const i = localIndex(0, 1, 0);
  cellChunk.blocks[i] = id;
  // §105: a plant's moving cell is its FAR kit model (plant-atlas uvs: fallingRenderer's cutout material binds the plant
  // atlas), in the cutout layer
  const out = buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? cellChunk : null), { plantLod: PLANT_LOD_FAR });
  cellChunk.blocks[i] = 0;
  if (out.plantLayer !== undefined) {
    if (out.cutout === null) out.cutout = out.plantLayer;
    delete out.plantLayer;
  }
  for (const layer of [out.opaque, out.cutout, out.translucent]) {
    if (!layer) continue;
    const pos = layer.positions;
    for (let k = 1; k < pos.length; k += 3) pos[k] -= 1.5;
  }
  return out;
}
