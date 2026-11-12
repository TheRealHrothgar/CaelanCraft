// Caelancraft — chunk mesher for hexagonal-prism cells. See src/CONTRACTS.md §10. Pure.
//
// buildChunkMesh(cq, cr, getChunkData) turns one 16×128×16 chunk (plus a one-cell halo read from the six
// hex-adjacent chunks) into three triangle lists — opaque, cutout (leaves/glass) and translucent (water).
// Every cell is a pointy-top hexagonal prism (src/hex.js): six side quads (faces 0..5), a hexagonal top
// (face 6) and bottom (face 7). Faces are culled with blocks.shouldRenderFace, shaded with
// FACE_SHADE × per-vertex ambient occlusion × biome tint, and emitted CCW seen from outside.
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
import { CHUNK_SIZE, WORLD_HEIGHT, AO_CURVE, TOP_UV_SCALE } from './config.js';
import { floorDiv, mod, localIndex } from './coords.js';
import {
  HEX_DIRS, HEX_CORNERS, HEX_SIZE, HEX_ROW_SPACING, FACE_NORMALS, FACE_SHADE, FACE_TOP, FACE_BOTTOM, FACE_COUNT,
  SIDE_FACE_COUNT,
} from './hex.js';
import {
  BLOCK, BIOME, TILE, isOpaque, shouldRenderFace, getRenderLayer, getFaceTile, tileToUV, isMeshed, isWater, waterSurfaceHeight, getBlockShape,
  flintAt,
} from './blocks.js';
import { FULL_SKY, LIGHT_EMISSION } from './light.js';

/** @typedef {import('./types.js').MeshData} MeshData */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
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
 * FREE_SURFACE[id] = 1 iff water under a cell of `id` has a free, lowered surface (§10.2 step 1): AIR, or a block drawn
 * by its own model (campfire, a black hole, the thin circuit parts: v0.10). Under water or any block meshed as a full prism
 * (stone, glass, ice, leaves) a FULL water cell (source or falling) stays full height, so a submerged see-through block shows
 * no fake surface ledge.
 */
const FREE_SURFACE = new Uint8Array(256);
/** WET[id] = 1 for the water family (WATER, WATER_FLOW_1..6, WATER_FALL): culled against each other by surface height. */
const WET = new Uint8Array(256);
/** SURFACE[id] = waterSurfaceHeight(id, AIR): the free surface of a water cell with no water above it (§10.2 step 1). */
const SURFACE = new Float64Array(256);
/** SHAPE[id] (BlockDef.shape): 0 a hexagonal prism, SHAPE_CROSS three crossed pictures, SHAPE_DECAL a picture on the floor. */
const SHAPE = new Uint8Array(256);
const SHAPE_CROSS = 1;
const SHAPE_DECAL = 2;
const SHAPE_LITTER = 3;

for (let id = 0; id < 256; id++) {
  OPAQUE[id] = isOpaque(id) ? 1 : 0;
  LAYER[id] = getRenderLayer(id);
  UNMESHED[id] = isMeshed(id) ? 0 : 1;
  FREE_SURFACE[id] = id === BLOCK.AIR || !isMeshed(id) ? 1 : 0;
  WET[id] = isWater(id) ? 1 : 0;
  SURFACE[id] = WET[id] ? waterSurfaceHeight(id, BLOCK.AIR) : 1;
  const shape = getBlockShape(id);
  SHAPE[id] = shape === 'cross' ? SHAPE_CROSS : shape === 'decal' ? SHAPE_DECAL : shape === 'litter' ? SHAPE_LITTER : 0;
  for (let f = 0; f < FACE_COUNT; f++) {
    const uv = tileToUV(getFaceTile(id, f));
    const o = (id * FACE_COUNT + f) * 4;
    FACE_UV[o] = uv[0];
    FACE_UV[o + 1] = uv[1];
    FACE_UV[o + 2] = uv[2];
    FACE_UV[o + 3] = uv[3];
    TINTED[id * FACE_COUNT + f] = isTintedFace(id, f) ? 1 : 0;
  }
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
  if (WET[above] === 1 || (FREE_SURFACE[above] === 0 && (a === BLOCK.WATER || a === BLOCK.WATER_FALL))) return 1;
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

/** Module-level builders, index = render layer (0 opaque, 1 cutout, 2 translucent). */
const builders = [createMeshBuilder(8192), createMeshBuilder(1024), createMeshBuilder(1024)];

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
  centreBiomes = null;
  let hasCentre = false;
  for (let dcq = -1; dcq <= 1; dcq++) {
    for (let dcr = -1; dcr <= 1; dcr++) {
      if (dcq === dcr && dcq !== 0) {
        neighbourData[(dcq + 1) * 3 + (dcr + 1)] = null;
        neighbourLight[(dcq + 1) * 3 + (dcr + 1)] = null;
        continue;
      }
      const data = getChunkData(cq + dcq, cr + dcr);
      const blocks = data && data.blocks;
      const ok = !!blocks && typeof blocks.subarray === 'function' && blocks.length >= WORLD_HEIGHT * CHUNK_SIZE * CHUNK_SIZE;
      neighbourData[(dcq + 1) * 3 + (dcr + 1)] = ok ? blocks : null;
      const light = ok ? /** @type {{ light?: Uint8Array|null }} */ (data).light : null;
      neighbourLight[(dcq + 1) * 3 + (dcr + 1)] = light instanceof Uint8Array && light.length >= blocks.length ? light : null;
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
    }
  }
  neighbourData.fill(null); // do not retain references to chunk arrays between calls
  neighbourLight.fill(null);
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
 * Emit side face `f` (0..5) of the cell at padded column (pq, pr), height ly, whose centre is at local
 * (cx, cz). The quad spans `bottomY .. topY` above the cell's floor: 0 .. 1 for a full face; a water surface lowers
 * `topY`, and between two water cells only the part of the higher surface above the lower one is drawn (`bottomY`).
 * The texture window is cut to the same span (v1 at height 0, v0 at height 1).
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
  const u0 = FACE_UV[uo];
  const v0 = FACE_UV[uo + 1];
  const u1 = FACE_UV[uo + 2];
  const v1 = FACE_UV[uo + 3];
  const uMid = (u0 + u1) * 0.5;
  const uHalf = (u1 - u0) * SIDE_HALF_U;
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
    positions[p3] = cx + CORNER_X[k];
    positions[p3 + 1] = ly + (top ? topY : bottomY);
    positions[p3 + 2] = cz + CORNER_Z[k];
    normals[p3] = nx;
    normals[p3 + 1] = 0;
    normals[p3 + 2] = nz;
    const p2 = vi * 2;
    // Vertices 0 and 3 are the left edge of the face seen from outside, 1 and 2 the right edge.
    uvs[p2] = (v === 1 || v === 2) ? uMid + uHalf : uMid - uHalf;
    uvs[p2 + 1] = top ? vTop : vBottom;
    const col = shade * AO_CURVE[ao];
    colors[p3] = col * tr;
    colors[p3 + 1] = col * tg;
    colors[p3 + 2] = col * tb;
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
  const uvs4 = decalUV ?? FACE_UV;
  const ub = decalUV ? 0 : (a * FACE_COUNT + f) * 4;
  const u0 = uvs4[ub];
  const v0 = uvs4[ub + 1];
  const u1 = uvs4[ub + 2];
  const v1 = uvs4[ub + 3];
  const du = u1 - u0;
  const dv = v1 - v0;
  const uSign = isTop ? TOP_UV_SCALE : -TOP_UV_SCALE; // the bottom face is seen mirrored
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
    uvs[p2 + 1] = v0 + dv * (0.5 + TOP_UV_SCALE * CORNER_Z[k]);
    colors[p3] = col * tr;
    colors[p3 + 1] = col * tg;
    colors[p3 + 2] = col * tb;
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
  colors[c3] = cc * tr;
  colors[c3 + 1] = cc * tg;
  colors[c3 + 2] = cc * tb;
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

/** A crossed plant is three vertical pictures 60° apart through (about) the cell's middle … */
export const CROSS_PLANES = 3;
/** … each half this wide (the cell is 1 across its flats) and one cell tall, its bottom on the cell's floor … */
export const CROSS_HALF_WIDTH = 0.48;
/** … turned by a per-cell angle and moved off the centre by up to this, so a meadow is not a grid of identical tufts. */
export const CROSS_JITTER = 0.05;
/** The pictures darken toward their roots (a little grounding without real occlusion): bottom × this, top × 1. */
export const CROSS_ROOT_SHADE = 0.72;
/** A decal lies this far above the cell's floor (clear of the ground's top face, no z-fighting). */
export const DECAL_Y = 0.02;

/** Deterministic 0..1 from a world cell (the plants' jitter). */
export function cellHash(q, r, salt = 0) {
  let h = Math.imul(q | 0, 0x27d4eb2d) ^ Math.imul((r | 0) + salt * 0x9e3779b9, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * A crossed plant (BlockDef.shape 'cross'): CROSS_PLANES vertical quads of the block's TOP tile through the cell's middle,
 * 60° apart, turned and nudged per world cell (wq, wr) by cellHash. The cutout material is double-sided, so each plane is one
 * quad seen from both sides. Normals point up, so the sun lights the plant like the ground it grows on.
 */
function emitCross(bld, wq, wr, ly, cx, cz, a, tr, tg, tb, own) {
  bld.ensure(4 * CROSS_PLANES, 6 * CROSS_PLANES);
  const light = bld.light;
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const uo = (a * FACE_COUNT + FACE_TOP) * 4;
  const u0 = FACE_UV[uo];
  const v0 = FACE_UV[uo + 1];
  const u1 = FACE_UV[uo + 2];
  const v1 = FACE_UV[uo + 3];
  const turn = cellHash(wq, wr) * (Math.PI / 3);
  const ox = cx + (cellHash(wq, wr, 1) - 0.5) * 2 * CROSS_JITTER;
  const oz = cz + (cellHash(wq, wr, 2) - 0.5) * 2 * CROSS_JITTER;
  const shade = FACE_SHADE[FACE_TOP];
  let b = bld.vertexCount;
  let ib = bld.indexCount;
  for (let p = 0; p < CROSS_PLANES; p++) {
    const theta = turn + (p * Math.PI) / CROSS_PLANES;
    const dx = Math.cos(theta) * CROSS_HALF_WIDTH;
    const dz = Math.sin(theta) * CROSS_HALF_WIDTH;
    for (let v = 0; v < 4; v++) {
      const right = v === 1 || v === 2;
      const top = v >= 2;
      const p3 = (b + v) * 3;
      positions[p3] = right ? ox + dx : ox - dx;
      positions[p3 + 1] = top ? ly + 1 : ly;
      positions[p3 + 2] = right ? oz + dz : oz - dz;
      normals[p3] = 0;
      normals[p3 + 1] = 1;
      normals[p3 + 2] = 0;
      const p2 = (b + v) * 2;
      uvs[p2] = right ? u1 : u0;
      uvs[p2 + 1] = top ? v0 : v1;
      const col = shade * (top ? 1 : CROSS_ROOT_SHADE);
      colors[p3] = col * tr;
      colors[p3 + 1] = col * tg;
      colors[p3 + 2] = col * tb;
      writeLight(light, (b + v) * 2, own);
    }
    indices[ib] = b; indices[ib + 1] = b + 1; indices[ib + 2] = b + 2;
    indices[ib + 3] = b; indices[ib + 4] = b + 2; indices[ib + 5] = b + 3;
    b += 4;
    ib += 6;
  }
  bld.vertexCount = b;
  bld.indexCount = ib;
  bld.faceCount += CROSS_PLANES;
}

// ---------------------------------------------------------------------------------------------------
// §75: ground litter as small 3D pieces
// ---------------------------------------------------------------------------------------------------

/** The skins the litter's faces are cut from (tile rects [u0, v0, u1, v1]). */
const ROCK_UV = Float32Array.from(tileToUV(TILE.LITTER_ROCK));
const FLINT_ROCK_UV = Float32Array.from(tileToUV(TILE.LITTER_FLINT));
const STICK_UV = Float32Array.from(tileToUV(TILE.LITTER_STICK));
/** Texels per metre on the litter (the terrain's own density: a 16-texel tile spans one cell). */
const LITTER_TEXELS = 16;

/**
 * The loose stones of one cell: [distance from the cell's middle, width, height, depth, cap scale, cap height] (m). A
 * stone is a block with a smaller block on top (the cap), so it reads as a rounded lump, not a cube.
 */
export const LITTER_ROCKS = Object.freeze([
  Object.freeze([0.15, 0.36, 0.15, 0.29, 0.64, 0.085]),
  Object.freeze([0.23, 0.25, 0.115, 0.2, 0.6, 0.06]),
  Object.freeze([0.28, 0.15, 0.085, 0.13, 0, 0]),
]);
/**
 * The fallen branches of one cell: [length, thickness, offset along the first stick, turn from it (rad), pitch (rad),
 * height of its middle] (m). The first lies flat; the second rests across it; the third is a twig standing off it.
 */
export const LITTER_STICKS = Object.freeze([
  Object.freeze([0.8, 0.085, 0, 0, 0, 0.0425]),
  Object.freeze([0.56, 0.07, 0.07, 1.15, 0.17, 0.115]),
  Object.freeze([0.26, 0.055, 0.2, 0.8, 0.6, 0.115]),
  Object.freeze([0.3, 0.06, -0.26, 2.3, 0, 0.03]),
]);
/** How much darker the faces of a piece are where it meets the ground (contact shade), and the light on its faces. */
export const LITTER_GROUND_SHADE = 0.78;
const LITTER_KEY_X = 0.35;
const LITTER_KEY_Y = 0.85;
const LITTER_KEY_Z = 0.4;

/** The three axes of a box face: [normal axis, u axis, v axis] (0 x, 1 y, 2 z), +face then −face of each axis. */
const BOX_AXES = [[0, 2, 1], [1, 0, 2], [2, 0, 1]];
/** Whether u × v points along +normal for each of those (1) or against it (−1): it decides the winding. */
const BOX_PARITY = [-1, -1, 1];
const boxP = [0, 0, 0];

/**
 * One box of the litter: half sizes (hx, hy, hz), centre (x, y, z) in chunk-local space, turned `pitch` about its own z
 * axis (its +x end lifts) and then `yaw` about +y. Every face is cut from `uv` at texel offset (tu, tv), sized by the
 * face's own size, and shaded by where it faces (top brightest) and darker where it meets the ground.
 */
function emitBox(bld, x, y, z, hx, hy, hz, yaw, pitch, uv, tu, tv, own, floorY) {
  bld.ensure(24, 36);
  const positions = bld.positions;
  const normals = bld.normals;
  const uvs = bld.uvs;
  const colors = bld.colors;
  const indices = bld.indices;
  const light = bld.light;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const half = [hx, hy, hz];
  const du = (uv[2] - uv[0]) / LITTER_TEXELS;
  const dv = (uv[3] - uv[1]) / LITTER_TEXELS;
  let b = bld.vertexCount;
  let ib = bld.indexCount;
  let faces = 0;
  for (let ax = 0; ax < 3; ax++) {
    const [na, ua, va] = BOX_AXES[ax];
    for (let sign = 1; sign >= -1; sign -= 2) {
      if (na === 1 && sign < 0 && pitch === 0) continue; // a piece lying flat: its underside is never seen
      // the face's size in texels, and where on the skin it is cut from (kept inside the tile)
      const wu = Math.max(1, Math.min(LITTER_TEXELS, half[ua] * 2 * LITTER_TEXELS));
      const wv = Math.max(1, Math.min(LITTER_TEXELS, half[va] * 2 * LITTER_TEXELS));
      const u0 = Math.min(tu + faces * 3, LITTER_TEXELS - wu);
      const v0 = Math.min(tv + faces * 2, LITTER_TEXELS - wv);
      // the outward normal, turned
      boxP[0] = 0; boxP[1] = 0; boxP[2] = 0;
      boxP[na] = sign;
      const nx0 = boxP[0] * cp - boxP[1] * sp;
      const ny = boxP[0] * sp + boxP[1] * cp;
      const nx = nx0 * cy + boxP[2] * sy;
      const nz = -nx0 * sy + boxP[2] * cy;
      const shade = 0.58 + 0.42 * Math.min(1, Math.max(0, 0.5 + 0.5 * (nx * LITTER_KEY_X + ny * LITTER_KEY_Y + nz * LITTER_KEY_Z)));
      for (let v = 0; v < 4; v++) {
        const su = v === 1 || v === 2 ? 1 : -1;
        const sv = v >= 2 ? 1 : -1;
        boxP[na] = sign * half[na];
        boxP[ua] = su * half[ua];
        boxP[va] = sv * half[va];
        const px0 = boxP[0] * cp - boxP[1] * sp;
        const py = boxP[0] * sp + boxP[1] * cp;
        const wx = px0 * cy + boxP[2] * sy;
        const wz = -px0 * sy + boxP[2] * cy;
        const p3 = (b + v) * 3;
        positions[p3] = x + wx;
        positions[p3 + 1] = y + py;
        positions[p3 + 2] = z + wz;
        normals[p3] = nx;
        normals[p3 + 1] = ny;
        normals[p3 + 2] = nz;
        const p2 = (b + v) * 2;
        uvs[p2] = uv[0] + (u0 + (su > 0 ? wu : 0)) * du;
        uvs[p2 + 1] = uv[1] + (v0 + (sv > 0 ? 0 : wv)) * dv;
        const col = shade * (y + py - floorY < 0.03 ? LITTER_GROUND_SHADE : 1);
        colors[p3] = col;
        colors[p3 + 1] = col;
        colors[p3 + 2] = col;
        writeLight(light, (b + v) * 2, own);
      }
      // counter-clockwise seen from outside, so the two-sided cutout material lights the outside
      if (BOX_PARITY[ax] * sign > 0) {
        indices[ib] = b; indices[ib + 1] = b + 1; indices[ib + 2] = b + 2;
        indices[ib + 3] = b; indices[ib + 4] = b + 2; indices[ib + 5] = b + 3;
      } else {
        indices[ib] = b; indices[ib + 1] = b + 2; indices[ib + 2] = b + 1;
        indices[ib + 3] = b; indices[ib + 4] = b + 3; indices[ib + 5] = b + 2;
      }
      b += 4;
      ib += 6;
      faces++;
    }
  }
  bld.vertexCount = b;
  bld.indexCount = ib;
  bld.faceCount += faces;
}

// v0.14 (§76 fauna): the ground nest, in the litter's style
const NEST_UV = Float32Array.from(tileToUV(TILE.LITTER_NEST));
const EGG_UV = Float32Array.from(tileToUV(TILE.LITTER_EGG));
/**
 * The nest's wall: NEST_WALL.count bundles of dry grass in a ring of radius `r` (m), each `len` long, `thick` wide and
 * `h` high; its bed is a flat pad `bed` across and `bedH` thick. The eggs: NEST_EGGS of them, `eggR` from the middle,
 * each `egg` wide and `eggH` high with a smaller cap on top (so it reads as rounded, like the stones).
 */
export const NEST_WALL = Object.freeze({ count: 6, r: 0.27, len: 0.33, thick: 0.11, h: 0.13, bed: 0.36, bedH: 0.045 });
export const NEST_EGGS = 3;
export const NEST_EGG = Object.freeze({ r: 0.085, w: 0.11, h: 0.1, cap: 0.6, capH: 0.045 });

/**
 * A Ground Nest (BLOCK.GROUND_NEST / GROUND_NEST_EMPTY): a low ring of grass bundles round a bed, and — `eggs` — three
 * pale eggs lying in it. Turned per cell like the rest of the litter.
 */
function emitNest(bld, wq, wr, ly, cx, cz, eggs, turn, own) {
  const W = NEST_WALL;
  emitBox(bld, cx, ly + W.bedH / 2, cz, W.bed / 2, W.bedH / 2, W.bed / 2, turn, 0, NEST_UV, 9, 9, own, ly);
  for (let i = 0; i < W.count; i++) {
    const ang = turn + (i * Math.PI * 2) / W.count;
    const h = W.h * (0.85 + 0.3 * cellHash(wq, wr, 40 + i)); // an uneven rim
    // yaw π/2 − ang lays the bundle along the ring (emitBox turns a box's long x axis to (cos yaw, −sin yaw))
    emitBox(bld, cx + Math.cos(ang) * W.r, ly + h / 2, cz + Math.sin(ang) * W.r, W.len / 2, h / 2, W.thick / 2, Math.PI / 2 - ang, 0, NEST_UV,
      Math.floor(cellHash(wq, wr, 46 + i) * 8), Math.floor(cellHash(wq, wr, 52 + i) * 8), own, ly);
  }
  if (!eggs) return;
  const E = NEST_EGG;
  for (let i = 0; i < NEST_EGGS; i++) {
    const ang = turn + 0.5 + (i * Math.PI * 2) / NEST_EGGS;
    const x = cx + Math.cos(ang) * E.r;
    const z = cz + Math.sin(ang) * E.r;
    const yaw = cellHash(wq, wr, 58 + i) * Math.PI;
    const y0 = ly + W.bedH;
    // floorY far below: an egg lies on the bed, not on the ground — no contact shade on its sides
    emitBox(bld, x, y0 + E.h / 2, z, E.w / 2, E.h / 2, E.w / 2, yaw, 0, EGG_UV, i * 4, i * 3, own, ly - 1);
    emitBox(bld, x, y0 + E.h + E.capH / 2, z, (E.w * E.cap) / 2, E.capH / 2, (E.w * E.cap) / 2, yaw, 0, EGG_UV, i * 4 + 2, i * 3 + 1, own, ly - 1);
  }
}

/**
 * Ground litter (BlockDef.shape 'litter', CONTRACTS §75): LOOSE_STONES as three stones of different sizes (one of them a
 * dark FLINT nodule where blocks.flintAt says the column holds flint), FALLEN_BRANCHES as sticks lying across each other
 * with a twig standing up. Every cell's pieces are turned and placed by cellHash, so no two cells look alike. They are in
 * the cutout layer, lit by their own cell.
 */
function emitLitter(bld, wq, wr, ly, cx, cz, a, own) {
  const turn = cellHash(wq, wr, 3) * Math.PI * 2;
  if (a === BLOCK.GROUND_NEST || a === BLOCK.GROUND_NEST_EMPTY) {
    emitNest(bld, wq, wr, ly, cx, cz, a === BLOCK.GROUND_NEST, turn, own);
    return;
  }
  if (a === BLOCK.LOOSE_STONES) {
    const flint = flintAt(wq, wr);
    for (let i = 0; i < LITTER_ROCKS.length; i++) {
      const [dist, w, h, d, cap, capH] = LITTER_ROCKS[i];
      const ang = turn + i * 2.2 + (cellHash(wq, wr, 4 + i) - 0.5) * 0.7;
      const x = cx + Math.cos(ang) * dist;
      const z = cz + Math.sin(ang) * dist;
      const yaw = cellHash(wq, wr, 8 + i) * Math.PI;
      const uv = flint && i === 1 ? FLINT_ROCK_UV : ROCK_UV;
      const tu = Math.floor(cellHash(wq, wr, 12 + i) * 8);
      const tv = Math.floor(cellHash(wq, wr, 16 + i) * 8);
      emitBox(bld, x, ly + h / 2, z, w / 2, h / 2, d / 2, yaw, 0, uv, tu, tv, own, ly);
      if (cap > 0) emitBox(bld, x, ly + h + capH / 2, z, (w * cap) / 2, capH / 2, (d * cap) / 2, yaw + 0.35, 0, uv, tu + 3, tv + 2, own, ly);
    }
    return;
  }
  const ax = Math.cos(turn);
  const az = -Math.sin(turn);
  for (let i = 0; i < LITTER_STICKS.length; i++) {
    const [len, thick, along, off, pitch, mid] = LITTER_STICKS[i];
    const jitter = (cellHash(wq, wr, 20 + i) - 0.5) * 0.5;
    const tu = Math.floor(cellHash(wq, wr, 24 + i) * 3);
    const tv = Math.floor(cellHash(wq, wr, 28 + i) * 12);
    emitBox(bld, cx + ax * along, ly + mid, cz + az * along, len / 2, thick / 2, thick / 2, turn + (i === 0 ? 0 : off + jitter), pitch, STICK_UV, tu, tv, own, ly);
  }
}

// ---------------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------------

/**
 * Build the render geometry of chunk (cq, cr). Positions are chunk-local: relative to the centre of local
 * cell (0, 0) (hex.chunkOrigin), which is where the renderer places the mesh. Never throws for well-formed
 * inputs; a chunk with no visible faces yields `{ opaque: null, cutout: null, translucent: null }`.
 * @param {number} cq
 * @param {number} cr
 * @param {GetChunkDataFn} getChunkData  called for the centre chunk and its six hex neighbours; null → AIR
 * @returns {ChunkMeshData}
 */
export function buildChunkMesh(cq, cr, getChunkData) {
  const opaqueB = builders[0];
  const cutoutB = builders[1];
  const translucentB = builders[2];
  opaqueB.reset();
  cutoutB.reset();
  translucentB.reset();

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

      for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
        const a = padded[colBase + ly];
        if (a === 0 || UNMESHED[a] === 1) continue; // air, or a block drawn by its own model (campfire)

        // §10.2 step 1: a water cell's surface height (waterSurfaceHeight: lower for flowing levels; 1 under more water)
        // applies to every top vertex of this cell. A full cell (source or falling water) under a block meshed as a
        // full prism stays full height; a flowing level keeps its own height wherever it is.
        const wet = WET[a];
        const above = ly + 1 < WORLD_HEIGHT ? padded[colBase + ly + 1] : 0;
        const topY = wet ? waterTopY(a, above) : 1;

        const renderRow = a << 8;
        const layer = LAYER[a];
        const bld = layer === 0 ? opaqueB : layer === 1 ? cutoutB : translucentB;
        const tintRow = a * FACE_COUNT;

        // A plant is crossed pictures and ground litter a picture on the floor: never a hexagonal prism (no faces, no culling).
        const shape = SHAPE[a];
        if (shape !== 0) {
          const t = TINTED[tintRow + FACE_TOP];
          const tr = t ? tint[0] : 1;
          const tg = t ? tint[1] : 1;
          const tb = t ? tint[2] : 1;
          const own = lightAt(pq, ly, pr); // a plant or a decal is lit by its own cell (§62)
          if (shape === SHAPE_CROSS) emitCross(bld, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr, ly, cx, cz, a, tr, tg, tb, own);
          else if (shape === SHAPE_LITTER) emitLitter(bld, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr, ly, cx, cz, a, own);
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
          if (wet && WET[q]) {
            // Two water cells: only the part of this surface above the neighbour's (§10.2 step 2a), the neighbour's
            // top by the same step-1 rule as this cell's (a covered full neighbour stands at 1 too).
            const nTop = waterTopY(q, ly + 1 < WORLD_HEIGHT ? padded[nBase + ly + 1] : 0);
            if (nTop >= topY) continue;
            bottomY = nTop;
          } else if (RENDER[renderRow | q] === 0) {
            continue;
          }
          const t = TINTED[tintRow + f];
          emitSide(bld, f, pq, pr, ly, cx, cz, topY, bottomY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
        }
        {
          // A lowered water surface is always drawn (even under a solid: a low cave keeps its surface); never between
          // two water cells. A full-height one follows the normal culling rule (none under an opaque block, flush under a
          // see-through one).
          const q = above;
          if (wet ? !WET[q] && (topY < 1 || RENDER[renderRow | q] !== 0) : RENDER[renderRow | q] !== 0) {
            const t = TINTED[tintRow + FACE_TOP];
            emitHex(bld, FACE_TOP, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
          }
        }
        {
          const q = ly - 1 < 0 ? BEDROCK : padded[colBase + ly - 1];
          if (wet ? !WET[q] && RENDER[renderRow | q] !== 0 : RENDER[renderRow | q] !== 0) {
            const t = TINTED[tintRow + FACE_BOTTOM];
            emitHex(bld, FACE_BOTTOM, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
          }
        }
      }
    }
  }

  return {
    opaque: opaqueB.build(),
    cutout: cutoutB.build(),
    translucent: translucentB.build(),
  };
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
  const out = buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? cellChunk : null));
  cellChunk.blocks[i] = 0;
  for (const layer of [out.opaque, out.cutout, out.translucent]) {
    if (!layer) continue;
    const pos = layer.positions;
    for (let k = 1; k < pos.length; k += 3) pos[k] -= 1.5;
  }
  return out;
}
