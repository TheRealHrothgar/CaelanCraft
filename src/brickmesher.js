// Caelancraft — the brick mesher (CONTRACTS §93.4). PURE.
//
// buildBrickMesh(chunk, ctx) turns one brick chunk (bricks.js) into the same three triangle lists as the hex mesher
// (opaque, cutout, translucent) with the same vertex layout (positions, normals, uvs, colors, light), so the renderer's
// three chunk materials draw both. Each brick is a box 1 × 1 × BRICK_DEPTH; its six faces are the v0.1 cube faces with Z
// scaled to the brick depth.
//   - A face is drawn when the brick across it lets it show (blocks.shouldRenderFace), or, with no brick there, unless the
//     cell across it lies wholly inside opaque terrain (every hex piece it covers is an opaque, natural hex).
//   - Ambient occlusion is the classic voxel rule over the three cells round each vertex in front of the face; a cell
//     occludes when it holds an opaque brick or, holding none, its centre lies in an opaque terrain hex.
//   - Light (§62) is the hex light field sampled just in front of each vertex, so bricks are lit by the same sky and
//     torches as the terrain round them.
//   - Texture: one tile per unit like the hexes. The 0.577-wide faces (±X sides, and the caps across Z) show the middle
//     0.577 of the tile, exactly like a hex side face.
// Positions are chunk-local: relative to the chunk's north-west corner (16·ci, 0, 24·cn·BRICK_DEPTH).
import { WORLD_HEIGHT, AO_CURVE } from './config.js';
import { BLOCK, isOpaque, getRenderLayer, getFaceTile, tileToUV, shouldRenderFace, isBrickShadow } from './blocks.js';
import { FACE_TOP, FACE_BOTTOM, worldToHex } from './hex.js';
import { createMeshBuilder } from './mesher.js';
import {
  BRICK_DEPTH, BRICK_CHUNK_I, BRICK_CHUNK_N, BRICK_FACE_SHADE, BRICK_FACE_DIRS, BRICK_FACE_NORMALS, hexesOfBrick,
  brickIndexToLocal,
} from './bricks.js';

/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
/** @typedef {import('./bricks.js').BrickChunk} BrickChunk */

/**
 * What the mesher reads round a chunk.
 * @typedef {Object} BrickMeshContext
 * @property {(i: number, y: number, n: number) => number} getBrick   material at a brick (any chunk), AIR when none
 * @property {(q: number, y: number, r: number) => number} getHex     the hex world's id (AIR when unloaded)
 * @property {(q: number, y: number, r: number) => number} lightAt    packed light (sky << 4 | block) of a hex cell
 */

/** Unit-box corners of each face, CCW seen from outside (bottom-left, bottom-right, top-right, top-left; v0.1 order). */
const FACE_VERTS = Object.freeze([
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], // +X
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], // -X
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], // +Y
  [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], // -Y
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], // +Z
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], // -Z
]);
/** The two non-normal axes of each face (0 x, 1 y, 2 z). */
const FACE_TANGENTS = Object.freeze([[1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]]);
/** The hex face whose tile a brick face shows: the sides show side 0's tile, the caps the top / bottom tiles. */
const TILE_FACE = Object.freeze([0, 0, FACE_TOP, FACE_BOTTOM, 0, 0]);
/** Fraction of the tile each face shows across (u) and up (v): the 0.577-wide extents show the middle 0.577. */
const U_SPAN = Object.freeze([BRICK_DEPTH, BRICK_DEPTH, 1, 1, 1, 1]);
const V_SPAN = Object.freeze([1, 1, BRICK_DEPTH, BRICK_DEPTH, 1, 1]);

/** Module-level builders (render layers 0 opaque, 1 cutout, 2 translucent), reused between calls. */
const builders = [createMeshBuilder(1024), createMeshBuilder(256), createMeshBuilder(64)];

/** @returns {boolean} the hex id is solid natural terrain that hides what is against it (an opaque, non-shadow block) */
function opaqueTerrain(id) {
  return id !== BLOCK.AIR && !isBrickShadow(id) && isOpaque(id);
}

/**
 * Build the mesh of one brick chunk.
 * @param {BrickChunk} chunk
 * @param {BrickMeshContext} ctx
 * @returns {ChunkMeshData}
 */
export function buildBrickMesh(chunk, ctx) {
  for (const b of builders) b.reset();
  const { getBrick, getHex, lightAt } = ctx;
  const ci0 = chunk.ci * BRICK_CHUNK_I;
  const cn0 = chunk.cn * BRICK_CHUNK_N;
  const s = BRICK_DEPTH;

  /** A cell (any chunk) occludes for AO: an opaque brick, or no brick and an opaque terrain hex at its centre. */
  const occludes = (i, y, n) => {
    if (y < 0) return 1;
    if (y >= WORLD_HEIGHT) return 0;
    const b = getBrick(i, y, n);
    if (b !== BLOCK.AIR) return isOpaque(b) ? 1 : 0;
    const [q, r] = worldToHex(i + 0.5, (n + 0.5) * s);
    return opaqueTerrain(getHex(q, y, r)) ? 1 : 0;
  };
  /** The cell across a face is wholly inside opaque terrain (so the face can never be seen). */
  const buriedInTerrain = (i, y, n) => {
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    for (const [q, r] of hexesOfBrick(i, n)) if (!opaqueTerrain(getHex(q, y, r))) return false;
    return true;
  };

  const cell = [0, 0, 0];
  for (const li of chunk.cells) {
    const a = chunk.blocks[li];
    if (a === BLOCK.AIR) continue;
    const [lx, y, ln] = brickIndexToLocal(li);
    const i = ci0 + lx;
    const n = cn0 + ln;
    const bld = builders[getRenderLayer(a)] ?? builders[0];
    for (let f = 0; f < 6; f++) {
      const d = BRICK_FACE_DIRS[f];
      const ni = i + d[0];
      const ny = y + d[1];
      const nn = n + d[2];
      if (ny >= 0 && ny < WORLD_HEIGHT) {
        const nb = getBrick(ni, ny, nn);
        if (nb !== BLOCK.AIR) {
          if (!shouldRenderFace(a, nb)) continue;
        } else if (buriedInTerrain(ni, ny, nn)) continue;
      } else if (ny < 0) continue; // nothing ever sees the underside of the world

      bld.ensure(4, 6);
      const base = bld.vertexCount;
      const [t1, t2] = FACE_TANGENTS[f];
      const nrm = BRICK_FACE_NORMALS[f];
      const shade = BRICK_FACE_SHADE[f];
      const uv = tileToUV(getFaceTile(a, TILE_FACE[f]));
      const uMid = (uv[0] + uv[2]) / 2;
      const vMid = (uv[1] + uv[3]) / 2;
      const uHalf = ((uv[2] - uv[0]) * U_SPAN[f]) / 2;
      const vHalf = ((uv[3] - uv[1]) * V_SPAN[f]) / 2;
      const aoV = [0, 0, 0, 0];
      for (let v = 0; v < 4; v++) {
        const corner = FACE_VERTS[f][v];
        // AO: the three cells round this corner in the layer in front of the face.
        cell[0] = ni;
        cell[1] = ny;
        cell[2] = nn;
        const d1 = corner[t1] ? 1 : -1;
        const d2 = corner[t2] ? 1 : -1;
        const c1 = [ni, ny, nn];
        const c2 = [ni, ny, nn];
        const cc = [ni, ny, nn];
        c1[t1] += d1;
        c2[t2] += d2;
        cc[t1] += d1;
        cc[t2] += d2;
        const s1 = occludes(c1[0], c1[1], c1[2]);
        const s2 = occludes(c2[0], c2[1], c2[2]);
        const sc = occludes(cc[0], cc[1], cc[2]);
        const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
        aoV[v] = ao;
        const vi = base + v;
        const x = lx + corner[0];
        const yy = y + corner[1];
        const z = (ln + corner[2]) * s;
        bld.positions[vi * 3] = x;
        bld.positions[vi * 3 + 1] = yy;
        bld.positions[vi * 3 + 2] = z;
        bld.normals[vi * 3] = nrm[0];
        bld.normals[vi * 3 + 1] = nrm[1];
        bld.normals[vi * 3 + 2] = nrm[2];
        // uv[0]=(left, bottom) uv[1]=(right, bottom) uv[2]=(right, top) uv[3]=(left, top); flipY = false: v0 is the top row.
        bld.uvs[vi * 2] = v === 1 || v === 2 ? uMid + uHalf : uMid - uHalf;
        bld.uvs[vi * 2 + 1] = v === 0 || v === 1 ? vMid + vHalf : vMid - vHalf;
        const col = shade * AO_CURVE[ao];
        bld.colors[vi * 3] = col;
        bld.colors[vi * 3 + 1] = col;
        bld.colors[vi * 3 + 2] = col;
        // §62: the hex light just in front of the vertex (nudged off the brick's edges toward the face's middle).
        const wx = ci0 + x + nrm[0] * 0.05 + (corner[0] ? -0.04 : 0.04) * (nrm[0] === 0 ? 1 : 0);
        const wy = yy + nrm[1] * 0.05 + (corner[1] ? -0.04 : 0.04) * (nrm[1] === 0 ? 1 : 0);
        const wz = cn0 * s + z + nrm[2] * 0.05 + (corner[2] ? -0.04 : 0.04) * (nrm[2] === 0 ? 1 : 0);
        const [hq, hr] = worldToHex(wx, wz);
        const packed = lightAt(hq, Math.floor(wy), hr);
        bld.light[vi * 2] = (packed >> 4) * 17;
        bld.light[vi * 2 + 1] = (packed & 15) * 17;
      }
      const ib = bld.indexCount;
      if (aoV[0] + aoV[2] >= aoV[1] + aoV[3]) {
        bld.indices.set([base, base + 1, base + 2, base, base + 2, base + 3], ib);
      } else {
        bld.indices.set([base + 1, base + 2, base + 3, base + 1, base + 3, base], ib);
      }
      bld.vertexCount = base + 4;
      bld.indexCount = ib + 6;
      bld.faceCount += 1;
    }
  }
  return { opaque: builders[0].build(), cutout: builders[1].build(), translucent: builders[2].build() };
}
