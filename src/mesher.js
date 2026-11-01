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
import { CHUNK_SIZE, WORLD_HEIGHT, WATER_SURFACE_HEIGHT, AO_CURVE, TOP_UV_SCALE } from './config.js';
import { floorDiv, mod, localIndex } from './coords.js';
import {
  HEX_DIRS, HEX_CORNERS, HEX_SIZE, HEX_ROW_SPACING, FACE_NORMALS, FACE_SHADE, FACE_TOP, FACE_BOTTOM, FACE_COUNT,
  SIDE_FACE_COUNT,
} from './hex.js';
import { BLOCK, BIOME, isOpaque, shouldRenderFace, getRenderLayer, getFaceTile, tileToUV } from './blocks.js';

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
/** RENDER[(a << 8) | b] = 1 iff shouldRenderFace(a, b). */
const RENDER = new Uint8Array(256 * 256);
/** FACE_UV[(id * 8 + f) * 4 + k] = tileToUV(getFaceTile(id, f))[k]. */
const FACE_UV = new Float32Array(256 * FACE_COUNT * 4);
/** TINTED[id * 8 + f] = 1 iff isTintedFace(id, f). */
const TINTED = new Uint8Array(256 * FACE_COUNT);

for (let id = 0; id < 256; id++) {
  OPAQUE[id] = isOpaque(id) ? 1 : 0;
  LAYER[id] = getRenderLayer(id);
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
        b.positions = positions;
        b.normals = normals;
        b.uvs = uvs;
        b.colors = colors;
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
  centreBiomes = null;
  let hasCentre = false;
  for (let dcq = -1; dcq <= 1; dcq++) {
    for (let dcr = -1; dcr <= 1; dcr++) {
      if (dcq === dcr && dcq !== 0) {
        neighbourData[(dcq + 1) * 3 + (dcr + 1)] = null;
        continue;
      }
      const data = getChunkData(cq + dcq, cr + dcr);
      const blocks = data && data.blocks;
      const ok = !!blocks && typeof blocks.subarray === 'function' && blocks.length >= WORLD_HEIGHT * CHUNK_SIZE * CHUNK_SIZE;
      neighbourData[(dcq + 1) * 3 + (dcr + 1)] = ok ? blocks : null;
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
    }
  }
  neighbourData.fill(null); // do not retain references to chunk arrays between calls
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

// ---------------------------------------------------------------------------------------------------
// Face emission
// ---------------------------------------------------------------------------------------------------

/**
 * Emit side face `f` (0..5) of the cell at padded column (pq, pr), height ly, whose centre is at local
 * (cx, cz). `topY` is the height of the cell's top (1, or WATER_SURFACE_HEIGHT for a water surface).
 */
function emitSide(bld, f, pq, pr, ly, cx, cz, topY, a, tr, tg, tb) {
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
  const qq = pq + DIR_DQ[f];
  const qr = pr + DIR_DR[f];

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

    const vi = b + v;
    const p3 = vi * 3;
    positions[p3] = cx + CORNER_X[k];
    positions[p3 + 1] = ly + (top ? topY : 0);
    positions[p3 + 2] = cz + CORNER_Z[k];
    normals[p3] = nx;
    normals[p3 + 1] = 0;
    normals[p3 + 2] = nz;
    const p2 = vi * 2;
    // Vertices 0 and 3 are the left edge of the face seen from outside, 1 and 2 the right edge.
    uvs[p2] = (v === 1 || v === 2) ? uMid + uHalf : uMid - uHalf;
    uvs[p2 + 1] = top ? v0 : v1;
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
function emitHex(bld, f, pq, pr, ly, cx, cz, topY, a, tr, tg, tb) {
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
  const uo = (a * FACE_COUNT + f) * 4;
  const u0 = FACE_UV[uo];
  const v0 = FACE_UV[uo + 1];
  const u1 = FACE_UV[uo + 2];
  const v1 = FACE_UV[uo + 3];
  const du = u1 - u0;
  const dv = v1 - v0;
  const uSign = isTop ? TOP_UV_SCALE : -TOP_UV_SCALE; // the bottom face is seen mirrored

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

  const WATER = BLOCK.WATER;
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
        if (a === 0) continue;

        // §10.2 step 1: water surface height applies to every top vertex of this cell.
        let topY = 1;
        if (a === WATER) {
          const above = ly + 1 < WORLD_HEIGHT ? padded[colBase + ly + 1] : 0;
          if (above !== WATER) topY = WATER_SURFACE_HEIGHT;
        }

        const renderRow = a << 8;
        const layer = LAYER[a];
        const bld = layer === 0 ? opaqueB : layer === 1 ? cutoutB : translucentB;
        const tintRow = a * FACE_COUNT;

        for (let f = 0; f < SIDE_FACE_COUNT; f++) {
          const q = padded[((pq + DIR_DQ[f]) * PAD + (pr + DIR_DR[f])) * WORLD_HEIGHT + ly];
          if (RENDER[renderRow | q] === 0) continue;
          const t = TINTED[tintRow + f];
          emitSide(bld, f, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
        }
        {
          const q = ly + 1 >= WORLD_HEIGHT ? 0 : padded[colBase + ly + 1];
          if (RENDER[renderRow | q] !== 0) {
            const t = TINTED[tintRow + FACE_TOP];
            emitHex(bld, FACE_TOP, pq, pr, ly, cx, cz, topY, a, t ? tint[0] : 1, t ? tint[1] : 1, t ? tint[2] : 1);
          }
        }
        {
          const q = ly - 1 < 0 ? BEDROCK : padded[colBase + ly - 1];
          if (RENDER[renderRow | q] !== 0) {
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
