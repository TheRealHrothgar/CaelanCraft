// Caelancraft — chunk mesher. See src/CONTRACTS.md §10. Pure: no DOM, no timers, no Math.random.
//
// buildChunkMesh(cx, cz, getChunkData) turns one 16×128×16 chunk (plus a one-block halo read from the
// eight neighbouring chunks) into three triangle lists — opaque, cutout (leaves/glass) and translucent
// (water). Faces are culled with blocks.shouldRenderFace, shaded with FACE_SHADE × per-vertex ambient
// occlusion, and emitted CCW from FACE_VERTS with the AO quad-flip rule.
//
// Performance notes: this runs on the main thread inside world.update()'s time budget, so the hot loop
// is allocation-free. The padded 18×18×128 volume and the three mesh builders are module-level scratch
// buffers reused between calls; the only allocations per call are the exact-length output arrays.
import { CHUNK_SIZE, WORLD_HEIGHT, WATER_SURFACE_HEIGHT, AO_CURVE, FACE_SHADE } from './config.js';
import { floorDiv, mod, localIndex, FACE_NORMALS, FACE_TANGENTS, FACE_VERTS } from './coords.js';
import { BLOCK, isOpaque, shouldRenderFace, getRenderLayer, getFaceTile, tileToUV } from './blocks.js';

/** @typedef {import('./types.js').MeshData} MeshData */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
/** @typedef {import('./types.js').GetChunkDataFn} GetChunkDataFn */
/** @typedef {import('./types.js').ChunkData} ChunkData */

// ---------------------------------------------------------------------------------------------------
// Padded volume (§10.1)
// ---------------------------------------------------------------------------------------------------

/** Padded X/Z extent: the chunk plus a one-block halo on each side. */
const PAD = CHUNK_SIZE + 2; // 18
// Padded index: pIndex(px, py, pz) = (px * 18 + pz) * 128 + py (Y innermost, like localIndex).

/** Module-level scratch volume, zero-filled at the start of every build. */
const padded = new Uint8Array(PAD * PAD * WORLD_HEIGHT);

/** Scratch 3×3 array of neighbour chunk data (index = (dcx+1)*3 + (dcz+1)); cleared after each build. */
const neighbourData = new Array(9).fill(null);

/** @returns {number} index into `padded` */
function pIndex(px, py, pz) {
  return (px * PAD + pz) * WORLD_HEIGHT + py;
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
/** FACE_UV[(id * 6 + f) * 4 + k] = tileToUV(getFaceTile(id, f))[k]. */
const FACE_UV = new Float32Array(256 * 6 * 4);

for (let id = 0; id < 256; id++) {
  OPAQUE[id] = isOpaque(id) ? 1 : 0;
  LAYER[id] = getRenderLayer(id);
  for (let f = 0; f < 6; f++) {
    const uv = tileToUV(getFaceTile(id, f));
    const o = (id * 6 + f) * 4;
    FACE_UV[o] = uv[0];
    FACE_UV[o + 1] = uv[1];
    FACE_UV[o + 2] = uv[2];
    FACE_UV[o + 3] = uv[3];
  }
}
for (let a = 0; a < 256; a++) {
  for (let b = 0; b < 256; b++) RENDER[(a << 8) | b] = shouldRenderFace(a, b) ? 1 : 0;
}

// Per face/vertex geometry tables (index i = f * 4 + v).
/** Unit-cube corner of vertex v of face f (0 or 1 per axis). */
const CORNER_X = new Int8Array(24);
const CORNER_Y = new Int8Array(24);
const CORNER_Z = new Int8Array(24);
/** AO sample offsets relative to the face neighbour Q: side 1, side 2 and the corner (= side1 + side2). */
const S1_X = new Int8Array(24), S1_Y = new Int8Array(24), S1_Z = new Int8Array(24);
const S2_X = new Int8Array(24), S2_Y = new Int8Array(24), S2_Z = new Int8Array(24);
const CN_X = new Int8Array(24), CN_Y = new Int8Array(24), CN_Z = new Int8Array(24);

for (let f = 0; f < 6; f++) {
  const [t1, t2] = FACE_TANGENTS[f];
  for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    const corner = FACE_VERTS[f][v];
    CORNER_X[i] = corner[0];
    CORNER_Y[i] = corner[1];
    CORNER_Z[i] = corner[2];
    const d1 = corner[t1] ? 1 : -1;
    const d2 = corner[t2] ? 1 : -1;
    const s1 = [0, 0, 0];
    const s2 = [0, 0, 0];
    s1[t1] = d1;
    s2[t2] = d2;
    S1_X[i] = s1[0]; S1_Y[i] = s1[1]; S1_Z[i] = s1[2];
    S2_X[i] = s2[0]; S2_Y[i] = s2[1]; S2_Z[i] = s2[2];
    CN_X[i] = s1[0] + s2[0]; CN_Y[i] = s1[1] + s2[1]; CN_Z[i] = s1[2] + s2[2];
  }
}

const NORMAL_X = new Int8Array(6), NORMAL_Y = new Int8Array(6), NORMAL_Z = new Int8Array(6);
for (let f = 0; f < 6; f++) {
  NORMAL_X[f] = FACE_NORMALS[f][0];
  NORMAL_Y[f] = FACE_NORMALS[f][1];
  NORMAL_Z[f] = FACE_NORMALS[f][2];
}

// ---------------------------------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------------------------------

/**
 * Classic voxel ambient-occlusion term for one vertex.
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
 * @typedef {Object} MeshBuilder  Growable typed-array quad accumulator (one per render layer).
 * @property {Float32Array} positions
 * @property {Float32Array} normals
 * @property {Float32Array} uvs
 * @property {Float32Array} colors
 * @property {Uint32Array} indices
 * @property {number} vertexCount
 * @property {number} faceCount
 * @property {number} capacity          in quads
 * @property {() => void} reset          rewind counts (keeps capacity)
 * @property {(quads: number) => void} ensure   guarantee room for `quads` more quads (may reallocate the arrays)
 * @property {() => (MeshData|null)} build    exact-length copies of the filled prefix; null when faceCount === 0
 */

/**
 * Create a growable quad buffer. Buffers double when full; `build()` returns exact-length copies so the
 * builder can be reused for the next chunk without aliasing the returned MeshData.
 * @param {number} [initialQuads=256]
 * @returns {MeshBuilder}
 */
export function createMeshBuilder(initialQuads = 256) {
  const cap0 = Math.max(1, Math.floor(initialQuads) || 1);
  /** @type {MeshBuilder} */
  const b = {
    positions: new Float32Array(cap0 * 12),
    normals: new Float32Array(cap0 * 12),
    uvs: new Float32Array(cap0 * 8),
    colors: new Float32Array(cap0 * 12),
    indices: new Uint32Array(cap0 * 6),
    vertexCount: 0,
    faceCount: 0,
    capacity: cap0,
    reset() {
      b.vertexCount = 0;
      b.faceCount = 0;
    },
    ensure(quads) {
      const need = b.faceCount + quads;
      if (need <= b.capacity) return;
      let cap = b.capacity * 2;
      while (cap < need) cap *= 2;
      const positions = new Float32Array(cap * 12);
      positions.set(b.positions.subarray(0, b.vertexCount * 3));
      const normals = new Float32Array(cap * 12);
      normals.set(b.normals.subarray(0, b.vertexCount * 3));
      const uvs = new Float32Array(cap * 8);
      uvs.set(b.uvs.subarray(0, b.vertexCount * 2));
      const colors = new Float32Array(cap * 12);
      colors.set(b.colors.subarray(0, b.vertexCount * 3));
      const indices = new Uint32Array(cap * 6);
      indices.set(b.indices.subarray(0, b.faceCount * 6));
      b.positions = positions;
      b.normals = normals;
      b.uvs = uvs;
      b.colors = colors;
      b.indices = indices;
      b.capacity = cap;
    },
    build() {
      if (b.faceCount === 0) return null;
      const vc = b.vertexCount;
      return {
        positions: b.positions.slice(0, vc * 3),
        normals: b.normals.slice(0, vc * 3),
        uvs: b.uvs.slice(0, vc * 2),
        colors: b.colors.slice(0, vc * 3),
        indices: b.indices.slice(0, b.faceCount * 6),
        vertexCount: vc,
        faceCount: b.faceCount,
      };
    },
  };
  return b;
}

/** Module-level builders, index = render layer (0 opaque, 1 cutout, 2 translucent). */
const builders = [createMeshBuilder(1024), createMeshBuilder(128), createMeshBuilder(128)];

// ---------------------------------------------------------------------------------------------------
// Padded volume fill
// ---------------------------------------------------------------------------------------------------

/**
 * Fill `padded` with the 3×3 chunk neighbourhood around (cx, cz), per §10.1. Each neighbour is fetched
 * from getChunkData exactly once; a null/undefined result (or one without a `blocks` array) is AIR.
 * @param {number} cx
 * @param {number} cz
 * @param {GetChunkDataFn} getChunkData
 * @returns {boolean} true iff the centre chunk has data
 */
function fillPadded(cx, cz, getChunkData) {
  padded.fill(0);
  let hasCentre = false;
  for (let dcx = -1; dcx <= 1; dcx++) {
    for (let dcz = -1; dcz <= 1; dcz++) {
      const data = getChunkData(cx + dcx, cz + dcz);
      const blocks = data && data.blocks;
      const ok = !!blocks && typeof blocks.subarray === 'function' && blocks.length >= WORLD_HEIGHT * CHUNK_SIZE * CHUNK_SIZE;
      neighbourData[(dcx + 1) * 3 + (dcz + 1)] = ok ? blocks : null;
      if (dcx === 0 && dcz === 0 && ok) hasCentre = true;
    }
  }
  for (let px = 0; px < PAD; px++) {
    const dcx = floorDiv(px - 1, CHUNK_SIZE);
    const slx = mod(px - 1, CHUNK_SIZE);
    for (let pz = 0; pz < PAD; pz++) {
      const dcz = floorDiv(pz - 1, CHUNK_SIZE);
      const blocks = neighbourData[(dcx + 1) * 3 + (dcz + 1)];
      if (!blocks) continue;
      const slz = mod(pz - 1, CHUNK_SIZE);
      const base = localIndex(slx, 0, slz);
      padded.set(blocks.subarray(base, base + WORLD_HEIGHT), pIndex(px, 0, pz));
    }
  }
  neighbourData.fill(null); // do not retain references to chunk arrays between calls
  return hasCentre;
}

/**
 * Opacity of the padded cell (px, py, pz) with the out-of-range rules of §10.1: below the world is
 * BEDROCK (opaque), above it is AIR. px/pz are always within [0, 18) for every sample the mesher takes.
 * @returns {number} 0 or 1
 */
function opaqueAt(px, py, pz) {
  if (py < 0) return 1;
  if (py >= WORLD_HEIGHT) return 0;
  return OPAQUE[padded[(px * PAD + pz) * WORLD_HEIGHT + py]];
}

// ---------------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------------

/**
 * Build the render geometry of chunk (cx, cz). Positions are chunk-local (x, z ∈ [0,16], y ∈ [0,128]);
 * the renderer offsets the mesh by (cx*16, 0, cz*16). Never throws for well-formed inputs; a chunk with
 * no visible faces yields `{ opaque: null, cutout: null, translucent: null }`.
 * @param {number} cx
 * @param {number} cz
 * @param {GetChunkDataFn} getChunkData  called only for the 3×3 neighbourhood; null → AIR
 * @returns {ChunkMeshData}
 */
export function buildChunkMesh(cx, cz, getChunkData) {
  const opaqueB = builders[0];
  const cutoutB = builders[1];
  const translucentB = builders[2];
  opaqueB.reset();
  cutoutB.reset();
  translucentB.reset();

  if (!fillPadded(cx, cz, getChunkData)) {
    return { opaque: null, cutout: null, translucent: null };
  }

  const WATER = BLOCK.WATER;
  const BEDROCK = BLOCK.BEDROCK;

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const px = lx + 1;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const pz = lz + 1;
      const colBase = (px * PAD + pz) * WORLD_HEIGHT;
      for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
        const a = padded[colBase + ly];
        if (a === 0) continue;

        // §10.2 step 1: water surface height applies to every y=1 corner of this block.
        let topY = 1;
        if (a === WATER) {
          const above = ly + 1 < WORLD_HEIGHT ? padded[colBase + ly + 1] : 0;
          if (above !== WATER) topY = WATER_SURFACE_HEIGHT;
        }

        const renderRow = a << 8;
        const layer = LAYER[a];
        const bld = layer === 0 ? opaqueB : layer === 1 ? cutoutB : translucentB;
        const uvBase = a * 24; // (a * 6 + f) * 4 with f = 0

        for (let f = 0; f < 6; f++) {
          const nx = NORMAL_X[f];
          const ny = NORMAL_Y[f];
          const nz = NORMAL_Z[f];
          const qx = px + nx;
          const qy = ly + ny;
          const qz = pz + nz;
          const q = qy < 0 ? BEDROCK : qy >= WORLD_HEIGHT ? 0 : padded[(qx * PAD + qz) * WORLD_HEIGHT + qy];
          if (RENDER[renderRow | q] === 0) continue;

          // --- emit one quad ---
          bld.ensure(1);
          const positions = bld.positions;
          const normals = bld.normals;
          const uvs = bld.uvs;
          const colors = bld.colors;
          const indices = bld.indices;
          const b = bld.vertexCount;
          const shade = FACE_SHADE[f];
          const uo = uvBase + f * 4;
          const u0 = FACE_UV[uo];
          const v0 = FACE_UV[uo + 1];
          const u1 = FACE_UV[uo + 2];
          const v1 = FACE_UV[uo + 3];

          let ao0 = 0, ao1 = 0, ao2 = 0, ao3 = 0;
          for (let v = 0; v < 4; v++) {
            const i = f * 4 + v;
            // §10.2 step 2: ambient occlusion from the three cells around this corner, beyond the face.
            const s1 = opaqueAt(qx + S1_X[i], qy + S1_Y[i], qz + S1_Z[i]);
            const s2 = opaqueAt(qx + S2_X[i], qy + S2_Y[i], qz + S2_Z[i]);
            const c = opaqueAt(qx + CN_X[i], qy + CN_Y[i], qz + CN_Z[i]);
            const ao = (s1 & s2) ? 0 : 3 - (s1 + s2 + c);
            if (v === 0) ao0 = ao; else if (v === 1) ao1 = ao; else if (v === 2) ao2 = ao; else ao3 = ao;

            const vi = b + v;
            const p3 = vi * 3;
            // step 3: position and normal
            positions[p3] = lx + CORNER_X[i];
            positions[p3 + 1] = ly + (CORNER_Y[i] ? topY : 0);
            positions[p3 + 2] = lz + CORNER_Z[i];
            normals[p3] = nx;
            normals[p3 + 1] = ny;
            normals[p3 + 2] = nz;
            // step 4: uv[0]=(u0,v1) uv[1]=(u1,v1) uv[2]=(u1,v0) uv[3]=(u0,v0)
            const p2 = vi * 2;
            uvs[p2] = (v === 1 || v === 2) ? u1 : u0;
            uvs[p2 + 1] = (v === 0 || v === 1) ? v1 : v0;
            // step 5: colour
            const col = shade * AO_CURVE[ao];
            colors[p3] = col;
            colors[p3 + 1] = col;
            colors[p3 + 2] = col;
          }

          // step 6: diagonal joins the brighter pair; both orders are CCW.
          const ib = bld.faceCount * 6;
          if (ao0 + ao2 >= ao1 + ao3) {
            indices[ib] = b; indices[ib + 1] = b + 1; indices[ib + 2] = b + 2;
            indices[ib + 3] = b; indices[ib + 4] = b + 2; indices[ib + 5] = b + 3;
          } else {
            indices[ib] = b + 1; indices[ib + 1] = b + 2; indices[ib + 2] = b + 3;
            indices[ib + 3] = b + 1; indices[ib + 4] = b + 3; indices[ib + 5] = b;
          }
          bld.vertexCount = b + 4;
          bld.faceCount += 1;
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
