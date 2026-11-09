// Tests for src/mesher.js (hexagonal-prism cells) — see src/CONTRACTS.md §10.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, WATER_SURFACE_HEIGHT, AO_CURVE, TOP_UV_SCALE } from '../../src/config.js';
import { chunkKey, columnIndex, localIndex } from '../../src/coords.js';
import {
  HEX_DIRS, HEX_CORNERS, HEX_SIZE, HEX_ROW_SPACING, FACE_NORMALS, FACE_SHADE, FACE_OPPOSITE, FACE_TOP, FACE_BOTTOM,
} from '../../src/hex.js';
import { BLOCK, BIOME, getFaceTile, tileToUV, isOpaque } from '../../src/blocks.js';
import { buildChunkMesh, vertexAO, hexCornerAO, createMeshBuilder, BIOME_TINT, isTintedFace } from '../../src/mesher.js';
import { createWorldGen } from '../../src/worldgen.js';
import { makeChunkData, makeChunkDataGetter, setWorldBlock, countFaces } from '../helpers/fixtures.js';

const B = BLOCK;
const TOP_ORDER = [0, 5, 4, 3, 2, 1];
const BOTTOM_ORDER = [0, 1, 2, 3, 4, 5];

/** Build a Map<chunkKey, ChunkData> from a list of [q, y, r, id]. */
function world(cells) {
  const chunks = new Map();
  for (const [q, y, r, id] of cells) setWorldBlock(chunks, q, y, r, id);
  return chunks;
}

/** Mesh chunk (cq, cr) over a chunk map. */
function mesh(chunks, cq = 0, cr = 0) {
  return buildChunkMesh(cq, cr, makeChunkDataGetter(chunks));
}

/** Every non-null layer of a ChunkMeshData. */
function layers(m) {
  return [m.opaque, m.cutout, m.translucent].filter(Boolean);
}

/** Index of the side face whose normal matches n (within tolerance), or -1. */
function sideIndex(n) {
  for (let j = 0; j < 6; j++) {
    const f = FACE_NORMALS[j];
    if (Math.abs(f[0] - n[0]) < 1e-5 && Math.abs(f[1] - n[1]) < 1e-5 && Math.abs(f[2] - n[2]) < 1e-5) return j;
  }
  return -1;
}

/**
 * Split a layer into its faces by walking vertices and indices in emission order. A face is a side quad
 * (4 verts / 6 indices) unless its normal is ±Y, in which case it is a hexagonal cap (7 verts / 18 indices).
 * Each face carries the chunk-local centre (cx, cz) and the cell height (cellY) of the cell that emitted it.
 */
function faces(layer) {
  const out = [];
  const p = layer.positions;
  const n = layer.normals;
  let v = 0;
  let i = 0;
  while (v < layer.vertexCount) {
    const ny = n[v * 3 + 1];
    const isCap = Math.abs(ny) === 1;
    const nv = isCap ? 7 : 4;
    const ni = isCap ? 18 : 6;
    const verts = [];
    const uvs = [];
    const colors = [];
    for (let k = 0; k < nv; k++) {
      const vi = v + k;
      verts.push([p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]]);
      uvs.push([layer.uvs[vi * 2], layer.uvs[vi * 2 + 1]]);
      colors.push([layer.colors[vi * 3], layer.colors[vi * 3 + 1], layer.colors[vi * 3 + 2]]);
    }
    const normal = [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]];
    const idx = Array.from(layer.indices.subarray(i, i + ni));
    const face = isCap ? (ny > 0 ? FACE_TOP : FACE_BOTTOM) : sideIndex(normal);
    let cx;
    let cz;
    let cellY;
    if (isCap) {
      cx = verts[0][0];
      cz = verts[0][2];
      cellY = ny > 0 ? Math.ceil(verts[0][1] - 1e-6) - 1 : verts[0][1];
    } else {
      // vertex 1 is the bottom corner `face` of the cell
      cx = verts[1][0] - HEX_CORNERS[face][0];
      cz = verts[1][2] - HEX_CORNERS[face][1];
      cellY = Math.floor(verts[0][1] + 1e-6); // a water side face may start above the cell floor (§35.4)
    }
    out.push({ face, base: v, verts, uvs, colors, idx, normal, cx, cz, cellY, isCap });
    v += nv;
    i += ni;
  }
  expect(v).toBe(layer.vertexCount);
  expect(i).toBe(layer.indexCount);
  expect(layer.indices.length).toBe(layer.indexCount);
  return out;
}

/** All faces of every layer. */
function allFaces(m) {
  return layers(m).flatMap(faces);
}

/** Chunk-local centre of local cell (lq, lr). */
function centreOf(lq, lr) {
  return [lq + lr / 2, lr * HEX_ROW_SPACING];
}

/** Faces emitted by the cell at local (lq, ly, lr). */
function facesAt(m, lq, ly, lr) {
  const [cx, cz] = centreOf(lq, lr);
  return allFaces(m).filter((f) => Math.abs(f.cx - cx) < 1e-4 && Math.abs(f.cz - cz) < 1e-4 && f.cellY === ly);
}

function faceSet(fs) {
  return [...new Set(fs.map((f) => f.face))].sort((a, b) => a - b);
}

/** Geometric normal of a triangle must point along the vertex normal (CCW seen from outside). */
function expectWindingsConsistent(layer) {
  const P = layer.positions;
  const N = layer.normals;
  const I = layer.indices;
  let bad = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3;
    const b = I[i + 1] * 3;
    const c = I[i + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * N[a] + ny * N[a + 1] + nz * N[a + 2] <= 1e-9) bad++;
  }
  expect(bad).toBe(0);
}

function expectGrey(color, value) {
  expect(color[0]).toBeCloseTo(value, 5);
  expect(color[1]).toBeCloseTo(value, 5);
  expect(color[2]).toBeCloseTo(value, 5);
}

const A = [5, 10, 7]; // the reference cell used by most scenes: local (5, 7), y 10
const [AQ, AY, AR] = A;

/** [q, y, r] of A offset by side direction j and dy. */
function near(j, dy = 0) {
  return [AQ + HEX_DIRS[j][0], AY + dy, AR + HEX_DIRS[j][1]];
}

// ---------------------------------------------------------------------------------------------------

describe('vertexAO / hexCornerAO', () => {
  it('vertexAO follows the classic 0..3 rule', () => {
    expect(vertexAO(0, 0, 0)).toBe(3);
    expect(vertexAO(1, 0, 0)).toBe(2);
    expect(vertexAO(0, 1, 0)).toBe(2);
    expect(vertexAO(0, 0, 1)).toBe(2);
    expect(vertexAO(1, 0, 1)).toBe(1);
    expect(vertexAO(0, 1, 1)).toBe(1);
    expect(vertexAO(1, 1, 0)).toBe(0);
    expect(vertexAO(1, 1, 1)).toBe(0);
  });
  it('hexCornerAO is 3 minus the number of opaque corner neighbours', () => {
    expect(hexCornerAO(0, 0)).toBe(3);
    expect(hexCornerAO(1, 0)).toBe(2);
    expect(hexCornerAO(0, 1)).toBe(2);
    expect(hexCornerAO(1, 1)).toBe(1);
  });
});

describe('createMeshBuilder', () => {
  it('starts empty and builds null when nothing was added', () => {
    const b = createMeshBuilder(16);
    expect(b.vertexCount).toBe(0);
    expect(b.indexCount).toBe(0);
    expect(b.faceCount).toBe(0);
    expect(b.build()).toBeNull();
  });
  it('grows vertex and index buffers independently and preserves the data already written', () => {
    const b = createMeshBuilder(8);
    const vcap = b.vertexCapacity;
    const icap = b.indexCapacity;
    b.positions[0] = 1.5;
    b.positions[1] = 2.5;
    b.normals[2] = -1;
    b.uvs[1] = 0.25;
    b.colors[0] = 0.75;
    b.indices[0] = 7;
    b.vertexCount = 1;
    b.indexCount = 1;
    b.ensure(vcap + 1, 0);
    expect(b.vertexCapacity).toBeGreaterThanOrEqual(vcap + 1);
    expect(b.indexCapacity).toBe(icap);
    b.ensure(0, icap * 3 + 1);
    expect(b.indexCapacity).toBeGreaterThanOrEqual(icap * 3 + 1);
    expect(b.positions.length).toBe(b.vertexCapacity * 3);
    expect(b.normals.length).toBe(b.vertexCapacity * 3);
    expect(b.uvs.length).toBe(b.vertexCapacity * 2);
    expect(b.colors.length).toBe(b.vertexCapacity * 3);
    expect(b.indices.length).toBe(b.indexCapacity);
    expect(b.positions[0]).toBe(1.5);
    expect(b.positions[1]).toBe(2.5);
    expect(b.normals[2]).toBe(-1);
    expect(b.uvs[1]).toBe(0.25);
    expect(b.colors[0]).toBe(0.75);
    expect(b.indices[0]).toBe(7);
  });
  it('build() returns exact-length independent copies and reset() rewinds without reallocating', () => {
    const b = createMeshBuilder(8);
    b.ensure(4, 6);
    for (let i = 0; i < 12; i++) b.positions[i] = i;
    for (let i = 0; i < 6; i++) b.indices[i] = i % 4;
    b.vertexCount = 4;
    b.indexCount = 6;
    b.faceCount = 1;
    const m = b.build();
    expect(m.positions.length).toBe(12);
    expect(m.normals.length).toBe(12);
    expect(m.uvs.length).toBe(8);
    expect(m.colors.length).toBe(12);
    expect(m.indices.length).toBe(6);
    expect(m.vertexCount).toBe(4);
    expect(m.indexCount).toBe(6);
    expect(m.faceCount).toBe(1);
    expect(m.indices).toBeInstanceOf(Uint32Array);
    b.positions[0] = 99;
    expect(m.positions[0]).toBe(0);
    const positions = b.positions;
    b.reset();
    expect(b.vertexCount).toBe(0);
    expect(b.indexCount).toBe(0);
    expect(b.faceCount).toBe(0);
    expect(b.positions).toBe(positions);
  });
});

describe('buildChunkMesh — a lone cell', () => {
  const m = mesh(world([[...A, B.STONE]]));

  it('emits 8 faces: 6 side quads + 2 hexagonal caps → 38 vertices, 72 indices, opaque layer only', () => {
    expect(m.cutout).toBeNull();
    expect(m.translucent).toBeNull();
    expect(m.opaque.faceCount).toBe(8);
    expect(m.opaque.vertexCount).toBe(38);
    expect(m.opaque.indexCount).toBe(72);
    expect(m.opaque.indices.length).toBe(72);
    expect(m.opaque.positions.length).toBe(38 * 3);
    expect(m.opaque.normals.length).toBe(38 * 3);
    expect(m.opaque.uvs.length).toBe(38 * 2);
    expect(m.opaque.colors.length).toBe(38 * 3);
    expect(countFaces(m)).toBe(8);
    const fs = faces(m.opaque);
    expect(faceSet(fs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const f of fs) {
      expect(f.verts.length).toBe(f.isCap ? 7 : 4);
      expect(f.idx.length).toBe(f.isCap ? 18 : 6);
      for (const i of f.idx) {
        expect(i).toBeGreaterThanOrEqual(f.base);
        expect(i).toBeLessThan(f.base + f.verts.length);
      }
    }
  });

  it('side quad j runs bottom corner j+1, bottom corner j, top corner j, top corner j+1 around the cell centre', () => {
    const [cx, cz] = centreOf(AQ, AR);
    const fs = faces(m.opaque);
    for (let j = 0; j < 6; j++) {
      const f = fs.find((x) => x.face === j);
      expect(f).toBeDefined();
      const cj = HEX_CORNERS[j];
      const cn = HEX_CORNERS[(j + 1) % 6];
      const expected = [
        [cx + cn[0], AY, cz + cn[1]],
        [cx + cj[0], AY, cz + cj[1]],
        [cx + cj[0], AY + 1, cz + cj[1]],
        [cx + cn[0], AY + 1, cz + cn[1]],
      ];
      for (let v = 0; v < 4; v++) {
        for (let k = 0; k < 3; k++) expect(f.verts[v][k]).toBeCloseTo(expected[v][k], 5);
      }
    }
  });

  it('caps are a centre vertex followed by the six corners (top: decreasing angle, bottom: increasing)', () => {
    const [cx, cz] = centreOf(AQ, AR);
    const fs = faces(m.opaque);
    const top = fs.find((x) => x.face === FACE_TOP);
    const bottom = fs.find((x) => x.face === FACE_BOTTOM);
    expect(top.verts[0][0]).toBeCloseTo(cx, 5);
    expect(top.verts[0][1]).toBe(AY + 1);
    expect(top.verts[0][2]).toBeCloseTo(cz, 5);
    expect(bottom.verts[0][0]).toBeCloseTo(cx, 5);
    expect(bottom.verts[0][1]).toBe(AY);
    expect(bottom.verts[0][2]).toBeCloseTo(cz, 5);
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const kt = TOP_ORDER[mIdx];
      expect(top.verts[1 + mIdx][0]).toBeCloseTo(cx + HEX_CORNERS[kt][0], 5);
      expect(top.verts[1 + mIdx][1]).toBe(AY + 1);
      expect(top.verts[1 + mIdx][2]).toBeCloseTo(cz + HEX_CORNERS[kt][1], 5);
      const kb = BOTTOM_ORDER[mIdx];
      expect(bottom.verts[1 + mIdx][0]).toBeCloseTo(cx + HEX_CORNERS[kb][0], 5);
      expect(bottom.verts[1 + mIdx][1]).toBe(AY);
      expect(bottom.verts[1 + mIdx][2]).toBeCloseTo(cz + HEX_CORNERS[kb][1], 5);
    }
    // Fan: (centre, corner m, corner m+1) six times.
    for (let t = 0; t < 6; t++) {
      expect(top.idx.slice(t * 3, t * 3 + 3)).toEqual([top.base, top.base + 1 + t, top.base + 1 + ((t + 1) % 6)]);
      expect(bottom.idx.slice(t * 3, t * 3 + 3)).toEqual([bottom.base, bottom.base + 1 + t, bottom.base + 1 + ((t + 1) % 6)]);
    }
  });

  it('normals are the unit hex face normals on sides and ±Y on the caps, identical on every vertex of a face', () => {
    const L = m.opaque;
    const fs = faces(L);
    for (const f of fs) {
      const expected = FACE_NORMALS[f.face];
      for (let v = 0; v < f.verts.length; v++) {
        const vi = f.base + v;
        expect(L.normals[vi * 3]).toBeCloseTo(expected[0], 6);
        expect(L.normals[vi * 3 + 1]).toBeCloseTo(expected[1], 6);
        expect(L.normals[vi * 3 + 2]).toBeCloseTo(expected[2], 6);
      }
      const len = Math.hypot(f.normal[0], f.normal[1], f.normal[2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('every triangle is CCW seen from outside', () => {
    expectWindingsConsistent(m.opaque);
  });
});

describe('buildChunkMesh — culling between cells', () => {
  it('two cells adjacent across each of the six side directions share one culled face pair → 14 faces', () => {
    for (let j = 0; j < 6; j++) {
      const bCell = near(j);
      const m = mesh(world([[...A, B.STONE], [...bCell, B.STONE]]));
      expect(countFaces(m)).toBe(14);
      expect(faceSet(facesAt(m, AQ, AY, AR))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].filter((f) => f !== j));
      expect(faceSet(facesAt(m, bCell[0], bCell[1], bCell[2]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].filter((f) => f !== FACE_OPPOSITE[j]));
    }
  });
  it('two stacked cells cull the top of the lower and the bottom of the upper', () => {
    const m = mesh(world([[...A, B.STONE], [AQ, AY + 1, AR, B.STONE]]));
    expect(countFaces(m)).toBe(14);
    expect(faceSet(facesAt(m, AQ, AY, AR))).toEqual([0, 1, 2, 3, 4, 5, 7]);
    expect(faceSet(facesAt(m, AQ, AY + 1, AR))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('a 7-cell flower (centre + 6 neighbours) → 32 faces; the centre keeps only its caps', () => {
    const cells = [[...A, B.STONE]];
    for (let j = 0; j < 6; j++) cells.push([...near(j), B.STONE]);
    const m = mesh(world(cells));
    expect(countFaces(m)).toBe(32);
    expect(faceSet(facesAt(m, AQ, AY, AR))).toEqual([FACE_TOP, FACE_BOTTOM]);
    for (let j = 0; j < 6; j++) {
      const c = near(j);
      const fs = facesAt(m, c[0], c[1], c[2]);
      expect(fs.length).toBe(5);
      // Hidden: toward the centre and toward the two petals on either side.
      const hidden = [FACE_OPPOSITE[j], (FACE_OPPOSITE[j] + 1) % 6, (FACE_OPPOSITE[j] + 5) % 6].sort((a, b) => a - b);
      expect(faceSet(fs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].filter((f) => !hidden.includes(f)));
    }
  });
  it('empty chunk → all three layers null, no throw', () => {
    const chunks = new Map([[chunkKey(0, 0), makeChunkData()]]);
    const m = mesh(chunks);
    expect(m).toEqual({ opaque: null, cutout: null, translucent: null });
  });
  it('chunk with no data at all (getChunkData null everywhere) → all null', () => {
    expect(buildChunkMesh(0, 0, () => null)).toEqual({ opaque: null, cutout: null, translucent: null });
    expect(buildChunkMesh(3, -2, () => undefined)).toEqual({ opaque: null, cutout: null, translucent: null });
  });
  it('full STONE chunk with empty neighbours: 256 tops at y=127, border sides, bottoms culled by below-world BEDROCK', () => {
    const d = makeChunkData();
    d.blocks.fill(B.STONE);
    const chunks = new Map([[chunkKey(0, 0), d]]);
    const m = mesh(chunks);
    let border = 0;
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        for (let j = 0; j < 6; j++) {
          const nq = lq + HEX_DIRS[j][0];
          const nr = lr + HEX_DIRS[j][1];
          if (nq < 0 || nq >= CHUNK_SIZE || nr < 0 || nr >= CHUNK_SIZE) border++;
        }
      }
    }
    expect(m.cutout).toBeNull();
    expect(m.translucent).toBeNull();
    expect(m.opaque.faceCount).toBe(CHUNK_SIZE * CHUNK_SIZE + border * WORLD_HEIGHT);
    const fs = faces(m.opaque);
    expect(fs.filter((f) => f.face === FACE_BOTTOM).length).toBe(0);
    const tops = fs.filter((f) => f.face === FACE_TOP);
    expect(tops.length).toBe(CHUNK_SIZE * CHUNK_SIZE);
    for (const t of tops) expect(t.verts[0][1]).toBe(WORLD_HEIGHT);
    expectWindingsConsistent(m.opaque);
  });
  it('a dense checkerboard exceeds 65535 vertices; indices stay valid Uint32', () => {
    const d = makeChunkData();
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        for (let ly = 0; ly < 64; ly++) {
          if ((lq + lr + ly) % 2 === 0) d.blocks[localIndex(lq, ly, lr)] = B.STONE;
        }
      }
    }
    const m = mesh(new Map([[chunkKey(0, 0), d]]));
    const L = m.opaque;
    expect(L.indices).toBeInstanceOf(Uint32Array);
    expect(L.vertexCount).toBeGreaterThan(65535);
    let max = 0;
    for (let i = 0; i < L.indices.length; i++) if (L.indices[i] > max) max = L.indices[i];
    expect(max).toBe(L.vertexCount - 1);
  });
});

describe('buildChunkMesh — chunk borders and neighbours', () => {
  it('culls the face against a cell in the neighbouring chunk (via getChunkData), from both sides', () => {
    const chunks = world([[15, 10, 7, B.STONE], [16, 10, 7, B.STONE]]);
    const m0 = mesh(chunks, 0, 0);
    expect(countFaces(m0)).toBe(7);
    expect(faceSet(facesAt(m0, 15, 10, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const m1 = mesh(chunks, 1, 0);
    expect(countFaces(m1)).toBe(7);
    expect(faceSet(facesAt(m1, 0, 10, 7))).toEqual([0, 1, 2, 4, 5, 6, 7]);
  });
  it('culls across the diagonal chunk border too: (0,15)+dir(−1,+1) lives in chunk (−1,1)', () => {
    const chunks = world([[0, 10, 15, B.STONE], [-1, 10, 16, B.STONE]]);
    const m = mesh(chunks, 0, 0);
    expect(countFaces(m)).toBe(7);
    expect(faceSet(facesAt(m, 0, 10, 15))).toEqual([0, 1, 3, 4, 5, 6, 7]);
    const mN = mesh(chunks, -1, 1);
    expect(faceSet(facesAt(mN, 15, 10, 0))).toEqual([0, 1, 2, 3, 4, 6, 7]);
  });
  it('a missing neighbour chunk is treated as AIR (border face rendered)', () => {
    const chunks = world([[15, 10, 7, B.STONE]]);
    expect(countFaces(mesh(chunks, 0, 0))).toBe(8);
  });
  it('handles negative chunk coordinates with floor semantics', () => {
    const chunks = world([[-1, 10, -17, B.STONE]]);
    expect(chunks.has(chunkKey(-1, -2))).toBe(true);
    const m = mesh(chunks, -1, -2);
    expect(countFaces(m)).toBe(8);
    const fs = facesAt(m, 15, 10, 15);
    expect(fs.length).toBe(8);
    const [cx, cz] = centreOf(15, 15);
    expect(cx).toBe(22.5);
    expect(fs[0].cx).toBeCloseTo(cx, 4);
    expect(fs[0].cz).toBeCloseTo(cz, 4);
    expect(countFaces(mesh(chunks, 0, 0))).toBe(0);
  });
  it('AO reads the neighbour chunk too', () => {
    // (15,10,7) is at the +q border; (16,11,7) is across side face 0 and one up → corners 0 and 1 of the top darken.
    const chunks = world([[15, 10, 7, B.STONE], [16, 11, 7, B.STONE]]);
    const m = mesh(chunks, 0, 0);
    const top = facesAt(m, 15, 10, 7).find((f) => f.face === FACE_TOP);
    expect(top).toBeDefined();
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const k = TOP_ORDER[mIdx];
      const ao = k === 0 || k === 1 ? 2 : 3;
      expectGrey(top.colors[1 + mIdx], FACE_SHADE[FACE_TOP] * AO_CURVE[ao]);
    }
  });
  it('queries getChunkData only for the centre and its six hex neighbours — never the (±1,±1) index corners', () => {
    const chunks = world([[...A, B.STONE]]);
    const base = makeChunkDataGetter(chunks);
    const calls = [];
    const spy = (cq, cr) => {
      calls.push(`${cq},${cr}`);
      return base(cq, cr);
    };
    buildChunkMesh(0, 0, spy);
    const expected = new Set(['0,0', ...HEX_DIRS.map(([dq, dr]) => `${dq},${dr}`)]);
    expect(new Set(calls)).toEqual(expected);
    expect(calls).not.toContain('1,1');
    expect(calls).not.toContain('-1,-1');
    const bySet = new Set(calls);
    expect(bySet.size).toBe(7);
    // Negative chunk coordinates: same pattern around (−3, 2).
    calls.length = 0;
    buildChunkMesh(-3, 2, spy);
    expect(new Set(calls)).toEqual(new Set(['-3,2', ...HEX_DIRS.map(([dq, dr]) => `${-3 + dq},${2 + dr}`)]));
  });
  it('bottom faces at y=0 are culled (below-world is BEDROCK)', () => {
    const m = mesh(world([[3, 0, 3, B.STONE]]));
    expect(countFaces(m)).toBe(7);
    expect(faceSet(facesAt(m, 3, 0, 3))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('top faces at y=127 are rendered (above-world is AIR) and sit at y=128', () => {
    const m = mesh(world([[3, WORLD_HEIGHT - 1, 3, B.STONE]]));
    expect(countFaces(m)).toBe(8);
    const top = facesAt(m, 3, WORLD_HEIGHT - 1, 3).find((f) => f.face === FACE_TOP);
    expect(top.verts[0][1]).toBe(WORLD_HEIGHT);
  });
  it('never throws on malformed neighbour data (objects without blocks, short arrays)', () => {
    const chunks = world([[...A, B.STONE]]);
    const base = makeChunkDataGetter(chunks);
    const weird = (cq, cr) => {
      if (cq === 0 && cr === 0) return base(cq, cr);
      if (cq === 1) return {};
      if (cr === 1) return { blocks: new Uint8Array(10) };
      return undefined;
    };
    expect(() => buildChunkMesh(0, 0, weird)).not.toThrow();
    expect(countFaces(buildChunkMesh(0, 0, weird))).toBe(8);
    expect(buildChunkMesh(0, 0, () => ({}))).toEqual({ opaque: null, cutout: null, translucent: null });
  });
});

describe('buildChunkMesh — water', () => {
  it('water with air above: translucent layer only, every top vertex (sides and cap) lowered to WATER_SURFACE_HEIGHT', () => {
    const m = mesh(world([[...A, B.WATER]]));
    expect(m.opaque).toBeNull();
    expect(m.cutout).toBeNull();
    expect(m.translucent.faceCount).toBe(8);
    const fs = faces(m.translucent);
    const surface = AY + WATER_SURFACE_HEIGHT;
    for (const f of fs) {
      if (f.face === FACE_TOP) {
        for (const v of f.verts) expect(v[1]).toBeCloseTo(surface, 6);
      } else if (f.face === FACE_BOTTOM) {
        for (const v of f.verts) expect(v[1]).toBe(AY);
      } else {
        expect(f.verts[0][1]).toBe(AY);
        expect(f.verts[1][1]).toBe(AY);
        expect(f.verts[2][1]).toBeCloseTo(surface, 6);
        expect(f.verts[3][1]).toBeCloseTo(surface, 6);
      }
    }
    expectWindingsConsistent(m.translucent);
  });
  it('water with water above keeps a full-height prism and the shared faces are culled', () => {
    const m = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, B.WATER]]));
    expect(countFaces(m)).toBe(14);
    const lower = facesAt(m, AQ, AY, AR);
    expect(faceSet(lower)).toEqual([0, 1, 2, 3, 4, 5, 7]);
    for (const f of lower) {
      if (f.face !== FACE_BOTTOM) {
        expect(f.verts[2][1]).toBe(AY + 1);
        expect(f.verts[3][1]).toBe(AY + 1);
      }
    }
    const upper = facesAt(m, AQ, AY + 1, AR);
    expect(faceSet(upper)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const top = upper.find((f) => f.face === FACE_TOP);
    for (const v of top.verts) expect(v[1]).toBeCloseTo(AY + 1 + WATER_SURFACE_HEIGHT, 6);
  });
  it('water under any block meshed as a full prism stays full height: no fake surface under submerged glass, ice or leaves', () => {
    for (const above of [B.GLASS, B.ICE, B.OAK_LEAVES, B.STONE]) {
      const m = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, above]]));
      const water = facesAt(m, AQ, AY, AR);
      expect(water.length).toBeGreaterThan(0);
      for (const f of water) for (const v of f.verts) expect([AY, AY + 1]).toContain(v[1]);
      // The cap stays toward a see-through block, flush with that block's bottom face (like the water's side faces
      // against it), and is culled under an opaque one.
      expect(water.some((f) => f.face === FACE_TOP)).toBe(!isOpaque(above));
    }
  });
  it('water under a campfire (drawn by its own model, the cell is mostly air) keeps the lowered free surface', () => {
    // Also under the other blocks with their own model: the black hole (vortexRenderer) and a thin circuit part
    // (circuitRenderer), unmeshed since DESIGN-circuits §1.1–§1.2.
    for (const above of [B.CAMPFIRE, B.BLACK_HOLE, B.COPPER_WIRE]) {
      const m = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, above]]));
      const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
      for (const v of top.verts) expect(v[1]).toBeCloseTo(AY + WATER_SURFACE_HEIGHT, 6);
    }
  });
  it('two side-by-side water cells cull their shared face (cullSame)', () => {
    const m = mesh(world([[...A, B.WATER], [...near(2), B.WATER]]));
    expect(countFaces(m)).toBe(14);
    expect(m.translucent.faceCount).toBe(14);
  });
  it('STONE next to WATER renders the stone face; water does not render toward stone', () => {
    const m = mesh(world([[...A, B.STONE], [...near(4), B.WATER]]));
    expect(m.opaque.faceCount).toBe(8);
    expect(m.translucent.faceCount).toBe(7);
    const w = near(4);
    expect(faceSet(facesAt(m, w[0], w[1], w[2]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].filter((f) => f !== FACE_OPPOSITE[4]));
  });
  it('water renders toward glass and leaves (non-opaque, different id)', () => {
    for (const other of [B.GLASS, B.OAK_LEAVES]) {
      const m = mesh(world([[...A, B.WATER], [...near(1), other]]));
      expect(m.translucent.faceCount).toBe(8);
      expect(m.cutout.faceCount).toBe(8);
    }
  });
  it('water never occludes AO', () => {
    const cells = [[...A, B.STONE]];
    for (let j = 0; j < 6; j++) cells.push([...near(j, 1), B.WATER]);
    const m = mesh(world(cells));
    const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
    for (const c of top.colors) expectGrey(c, FACE_SHADE[FACE_TOP]);
  });
});

describe('buildChunkMesh — flowing water surfaces (v0.8, CONTRACTS §35.4)', () => {
  const level = (k) => B.WATER_FLOW_1 + k - 1;
  const surf = (k) => (k * WATER_SURFACE_HEIGHT) / 7;
  const topOf = (fs) => fs.find((f) => f.face === FACE_TOP);

  it('a flowing level k has its surface at k/7 of a source; falling water at a source surface, full under water', () => {
    for (let k = 1; k <= 6; k++) {
      const top = topOf(facesAt(mesh(world([[...A, level(k)]])), AQ, AY, AR));
      for (const v of top.verts) expect(v[1]).toBeCloseTo(AY + surf(k), 6);
    }
    const fall = facesAt(mesh(world([[...A, B.WATER_FALL]])), AQ, AY, AR);
    for (const v of topOf(fall).verts) expect(v[1]).toBeCloseTo(AY + WATER_SURFACE_HEIGHT, 6);
    const stacked = facesAt(mesh(world([[...A, B.WATER_FALL], [AQ, AY + 1, AR, B.WATER_FLOW_2]])), AQ, AY, AR);
    expect(faceSet(stacked)).toEqual([0, 1, 2, 3, 4, 5, 7]); // no top face under more water
    for (const f of stacked) if (f.face !== FACE_BOTTOM) expect(f.verts[2][1]).toBe(AY + 1);
  });

  it('the surface of a lowered (flowing) water cell is drawn even under a solid block (low caves keep their surface)', () => {
    for (const id of [level(1), level(2), level(6)]) {
      const fs = facesAt(mesh(world([[...A, id], [AQ, AY + 1, AR, B.STONE]])), AQ, AY, AR);
      expect(faceSet(fs), String(id)).toContain(FACE_TOP);
    }
  });
  it('a full water cell (source or falling) under a solid block fills it: full height, no hidden top face', () => {
    for (const id of [B.WATER, B.WATER_FALL]) {
      const fs = facesAt(mesh(world([[...A, id], [AQ, AY + 1, AR, B.STONE]])), AQ, AY, AR);
      expect(faceSet(fs), String(id)).not.toContain(FACE_TOP);
      for (const f of fs) for (const v of f.verts) expect([AY, AY + 1]).toContain(v[1]);
    }
  });

  it('between two water cells: no top / bottom faces, and a side face only above the lower surface', () => {
    // FLOW_5 next to FLOW_2: the 5 shows the strip between the two surfaces toward the 2; the 2 shows nothing toward it.
    const m = mesh(world([[...A, level(5)], [...near(0), level(2)]]));
    const hi = facesAt(m, AQ, AY, AR).find((f) => f.face === 0);
    expect(hi.verts[0][1]).toBeCloseTo(AY + surf(2), 6);
    expect(hi.verts[1][1]).toBeCloseTo(AY + surf(2), 6);
    expect(hi.verts[2][1]).toBeCloseTo(AY + surf(5), 6);
    expect(hi.verts[3][1]).toBeCloseTo(AY + surf(5), 6);
    // The texture window is cut to the same span (v grows down the image: v1 at height 0, v0 at height 1).
    const [, v0, , v1] = tileToUV(getFaceTile(B.WATER, 0));
    expect(hi.uvs[0][1]).toBeCloseTo(v1 - (v1 - v0) * surf(2), 6);
    expect(hi.uvs[2][1]).toBeCloseTo(v1 - (v1 - v0) * surf(5), 6);
    const n = near(0);
    expect(faceSet(facesAt(m, n[0], n[1], n[2]))).not.toContain(FACE_OPPOSITE[0]);
    // Equal surfaces (a source next to falling water) cull each other; water over different water has no cap faces.
    expect(countFaces(mesh(world([[...A, B.WATER], [...near(1), B.WATER_FALL]])))).toBe(14);
    const tower = mesh(world([[...A, level(3)], [AQ, AY + 1, AR, B.WATER]]));
    expect(faceSet(facesAt(tower, AQ, AY, AR))).not.toContain(FACE_TOP);
    expect(faceSet(facesAt(tower, AQ, AY + 1, AR))).not.toContain(FACE_BOTTOM);
    expectWindingsConsistent(m.translucent);
  });

  it('a water cell under more water hides its whole side toward a neighbour that also has water above', () => {
    const m = mesh(world([[...A, B.WATER_FALL], [AQ, AY + 1, AR, B.WATER_FALL], [...near(2), B.WATER], [...near(2, 1), B.WATER_FALL]]));
    expect(faceSet(facesAt(m, AQ, AY, AR))).not.toContain(2);
    // …but toward a neighbour with a free surface it shows the strip above that surface.
    const m2 = mesh(world([[...A, B.WATER_FALL], [AQ, AY + 1, AR, B.WATER_FALL], [...near(2), B.WATER]]));
    const strip = facesAt(m2, AQ, AY, AR).find((f) => f.face === 2);
    expect(strip.verts[0][1]).toBeCloseTo(AY + WATER_SURFACE_HEIGHT, 6);
    expect(strip.verts[2][1]).toBe(AY + 1);
  });

  it('two full water cells that are both covered draw nothing between them; the step to open water stays', () => {
    // Review water-2: the neighbour's top ignored the full-prism rule, so each of two covered cells drew a 0.875..1 strip
    // toward the other (coincident pairs: a blue honeycomb under a glass floor on a pool).
    const sides = (m, j) => faceSet(facesAt(m, AQ, AY, AR)).includes(j);
    const n = near(0);
    for (const cover of [B.STONE, B.GLASS]) {
      for (const [a, b] of [[B.WATER, B.WATER], [B.WATER_FALL, B.WATER], [B.WATER, B.WATER_FALL]]) {
        const m = mesh(world([[...A, a], [AQ, AY + 1, AR, cover], [...n, b], [n[0], AY + 1, n[2], cover]]));
        expect(sides(m, 0), `${a}|${b} under ${cover}`).toBe(false);
        expect(faceSet(facesAt(m, n[0], n[1], n[2])), `${b}|${a} under ${cover}`).not.toContain(FACE_OPPOSITE[0]);
      }
    }
    // A full cell under more water next to a covered full cell: both at 1, nothing between them either.
    const deep = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, B.WATER], [...n, B.WATER], [n[0], AY + 1, n[2], B.STONE]]));
    expect(sides(deep, 0)).toBe(false);
    // A covered cell next to open water still draws the 0.875..1 step, and a covered flowing level keeps its surface.
    const step = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, B.GLASS], [...n, B.WATER]]));
    const s = facesAt(step, AQ, AY, AR).find((f) => f.face === 0);
    expect(s.verts[0][1]).toBeCloseTo(AY + WATER_SURFACE_HEIGHT, 6);
    expect(s.verts[2][1]).toBe(AY + 1);
    const low = mesh(world([[...A, B.WATER], [AQ, AY + 1, AR, B.STONE], [...n, B.WATER_FLOW_3], [n[0], AY + 1, n[2], B.STONE]]));
    expect(facesAt(low, AQ, AY, AR).find((f) => f.face === 0).verts[0][1]).toBeCloseTo(AY + surf(3), 6);
    // A 7 × 7 pool under a full glass roof: only its outer walls and bottom, no strip on any inner edge.
    const pool = [];
    for (let q = 2; q <= 8; q++) for (let r = 4; r <= 10; r++) pool.push([q, AY, r, B.WATER], [q, AY + 1, r, B.GLASS]);
    const strips = faces(mesh(world(pool)).translucent).filter((f) => !f.isCap && f.verts[0][1] > AY + 0.5);
    expect(strips.length).toBe(0);
  });
});

describe('buildChunkMesh — cutout layer', () => {
  it('GLASS–GLASS culled (14 faces), all in the cutout layer', () => {
    const m = mesh(world([[...A, B.GLASS], [...near(0), B.GLASS]]));
    expect(m.opaque).toBeNull();
    expect(m.translucent).toBeNull();
    expect(m.cutout.faceCount).toBe(14);
  });
  it('STONE next to GLASS renders the stone face; glass culls toward stone', () => {
    const m = mesh(world([[...A, B.STONE], [...near(3), B.GLASS]]));
    expect(m.opaque.faceCount).toBe(8);
    expect(m.cutout.faceCount).toBe(7);
  });
  it('LEAVES–LEAVES both rendered (16 faces)', () => {
    const m = mesh(world([[...A, B.OAK_LEAVES], [...near(5), B.OAK_LEAVES]]));
    expect(m.cutout.faceCount).toBe(16);
  });
  it('GLASS next to LEAVES: both faces rendered (different ids, both non-opaque)', () => {
    const m = mesh(world([[...A, B.GLASS], [...near(2), B.OAK_LEAVES]]));
    expect(m.cutout.faceCount).toBe(16);
  });
  it('glass and leaves do not occlude AO', () => {
    for (const other of [B.GLASS, B.OAK_LEAVES]) {
      const cells = [[...A, B.STONE]];
      for (let j = 0; j < 6; j++) cells.push([...near(j, 1), other]);
      const m = mesh(world(cells));
      const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
      for (const c of top.colors) expectGrey(c, FACE_SHADE[FACE_TOP]);
    }
  });
});

describe('buildChunkMesh — UVs', () => {
  const m = mesh(world([[...A, B.GRASS_BLOCK]]));
  // GRASS_BLOCK has distinct side / top / bottom tiles, so a wrong face→tile mapping would show.

  it('side quads use the centred window uMid ± (u1−u0)·HEX_SIZE/2 with v1 at the bottom and v0 at the top', () => {
    const fs = faces(m.opaque);
    for (let j = 0; j < 6; j++) {
      const f = fs.find((x) => x.face === j);
      const [u0, v0, u1, v1] = tileToUV(getFaceTile(B.GRASS_BLOCK, j));
      const uMid = (u0 + u1) / 2;
      const uHalf = ((u1 - u0) * HEX_SIZE) / 2;
      const expected = [[uMid - uHalf, v1], [uMid + uHalf, v1], [uMid + uHalf, v0], [uMid - uHalf, v0]];
      for (let v = 0; v < 4; v++) {
        expect(f.uvs[v][0]).toBeCloseTo(expected[v][0], 6);
        expect(f.uvs[v][1]).toBeCloseTo(expected[v][1], 6);
      }
    }
  });
  it('caps map the hexagon inscribed in the tile: centre at the tile centre, corners scaled by TOP_UV_SCALE (bottom mirrored in u)', () => {
    const fs = faces(m.opaque);
    for (const face of [FACE_TOP, FACE_BOTTOM]) {
      const f = fs.find((x) => x.face === face);
      const [u0, v0, u1, v1] = tileToUV(getFaceTile(B.GRASS_BLOCK, face));
      const du = u1 - u0;
      const dv = v1 - v0;
      const uSign = face === FACE_TOP ? TOP_UV_SCALE : -TOP_UV_SCALE;
      expect(f.uvs[0][0]).toBeCloseTo(u0 + du * 0.5, 6);
      expect(f.uvs[0][1]).toBeCloseTo(v0 + dv * 0.5, 6);
      const order = face === FACE_TOP ? TOP_ORDER : BOTTOM_ORDER;
      for (let mIdx = 0; mIdx < 6; mIdx++) {
        const k = order[mIdx];
        expect(f.uvs[1 + mIdx][0]).toBeCloseTo(u0 + du * (0.5 + uSign * HEX_CORNERS[k][0]), 6);
        expect(f.uvs[1 + mIdx][1]).toBeCloseTo(v0 + dv * (0.5 + TOP_UV_SCALE * HEX_CORNERS[k][1]), 6);
      }
    }
  });
  it('every UV lies inside the tile rect of getFaceTile(id, face)', () => {
    for (const id of [B.GRASS_BLOCK, B.OAK_LOG, B.SANDSTONE, B.BOOKSHELF, B.WATER, B.OAK_LEAVES]) {
      const mm = mesh(world([[...A, id]]));
      for (const f of allFaces(mm)) {
        const [u0, v0, u1, v1] = tileToUV(getFaceTile(id, f.face));
        for (const [u, v] of f.uvs) {
          expect(u).toBeGreaterThanOrEqual(u0 - 1e-6);
          expect(u).toBeLessThanOrEqual(u1 + 1e-6);
          expect(v).toBeGreaterThanOrEqual(v0 - 1e-6);
          expect(v).toBeLessThanOrEqual(v1 + 1e-6);
        }
      }
    }
  });
});

describe('buildChunkMesh — ambient occlusion and colours', () => {
  it('lone block is fully lit: colour = FACE_SHADE[f] on every vertex, grey', () => {
    const m = mesh(world([[...A, B.STONE]]));
    for (const f of faces(m.opaque)) {
      for (const c of f.colors) expectGrey(c, FACE_SHADE[f.face]);
    }
  });

  it('side face: a cell above the face neighbour darkens the two top vertices to AO 2 (s2 sample)', () => {
    const m = mesh(world([[...A, B.STONE], [...near(0, 1), B.STONE]]));
    const f = facesAt(m, AQ, AY, AR).find((x) => x.face === 0);
    expect(f).toBeDefined();
    expectGrey(f.colors[0], FACE_SHADE[0]);
    expectGrey(f.colors[1], FACE_SHADE[0]);
    expectGrey(f.colors[2], FACE_SHADE[0] * AO_CURVE[2]);
    expectGrey(f.colors[3], FACE_SHADE[0] * AO_CURVE[2]);
    // ao0+ao2 = 5 = ao1+ao3 → default diagonal
    expect(f.idx).toEqual([f.base, f.base + 1, f.base + 2, f.base, f.base + 2, f.base + 3]);
  });

  it('side face: the third cell around the vertical edge (face j+1 neighbour) darkens vertices 0 and 3 (s1 sample)', () => {
    const m = mesh(world([[...A, B.STONE], [...near(1), B.STONE]]));
    const f = facesAt(m, AQ, AY, AR).find((x) => x.face === 0);
    expectGrey(f.colors[0], FACE_SHADE[0] * AO_CURVE[2]);
    expectGrey(f.colors[1], FACE_SHADE[0]);
    expectGrey(f.colors[2], FACE_SHADE[0]);
    expectGrey(f.colors[3], FACE_SHADE[0] * AO_CURVE[2]);
    expect(f.idx).toEqual([f.base, f.base + 1, f.base + 2, f.base, f.base + 2, f.base + 3]);
  });

  it('side face: third cell + face neighbour above → AO 0 at the shared top vertex', () => {
    const m = mesh(world([[...A, B.STONE], [...near(1), B.STONE], [...near(0, 1), B.STONE]]));
    const f = facesAt(m, AQ, AY, AR).find((x) => x.face === 0);
    expectGrey(f.colors[3], FACE_SHADE[0] * AO_CURVE[0]); // top corner 1: s1 (dir 1) and s2 (above Q)
    expectGrey(f.colors[0], FACE_SHADE[0] * AO_CURVE[2]); // bottom corner 1: s1 only
    expectGrey(f.colors[2], FACE_SHADE[0] * AO_CURVE[2]); // top corner 0: s2 only
    expectGrey(f.colors[1], FACE_SHADE[0]);
    // ao = [2, 3, 2, 0]: 4 ≥ 3 → default diagonal
    expect(f.idx).toEqual([f.base, f.base + 1, f.base + 2, f.base, f.base + 2, f.base + 3]);
  });

  it('side face: a corner-only occluder (third cell above) gives AO 2 at a single vertex', () => {
    const m = mesh(world([[...A, B.STONE], [...near(1, 1), B.STONE]]));
    const f = facesAt(m, AQ, AY, AR).find((x) => x.face === 0);
    expectGrey(f.colors[3], FACE_SHADE[0] * AO_CURVE[2]);
    expectGrey(f.colors[0], FACE_SHADE[0]);
    expectGrey(f.colors[1], FACE_SHADE[0]);
    expectGrey(f.colors[2], FACE_SHADE[0]);
  });

  it('flips the quad diagonal toward the brighter pair', () => {
    // Darken vertices 0 (corner 1, bottom: third cell dir 1 below) and 2 (corner 0, top: third cell dir 5 above).
    const m = mesh(world([[...A, B.STONE], [...near(1, -1), B.STONE], [...near(5, 1), B.STONE]]));
    const f = facesAt(m, AQ, AY, AR).find((x) => x.face === 0);
    expectGrey(f.colors[0], FACE_SHADE[0] * AO_CURVE[2]);
    expectGrey(f.colors[1], FACE_SHADE[0]);
    expectGrey(f.colors[2], FACE_SHADE[0] * AO_CURVE[2]);
    expectGrey(f.colors[3], FACE_SHADE[0]);
    // ao0+ao2 = 4 < ao1+ao3 = 6 → flipped diagonal
    expect(f.idx).toEqual([f.base + 1, f.base + 2, f.base + 3, f.base + 1, f.base + 3, f.base]);
    expectWindingsConsistent(m.opaque);
  });

  it('top cap: a raised neighbour darkens the two corners it shares; the centre is the mean of the six corners', () => {
    const m = mesh(world([[...A, B.STONE], [...near(0, 1), B.STONE]]));
    const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
    const shade = FACE_SHADE[FACE_TOP];
    let sum = 0;
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const k = TOP_ORDER[mIdx];
      const ao = k === 0 || k === 1 ? 2 : 3; // corners 0 and 1 are shared with side face 0
      const col = shade * AO_CURVE[ao];
      sum += col;
      expectGrey(top.colors[1 + mIdx], col);
    }
    expectGrey(top.colors[0], sum / 6);
  });

  it('top cap: two raised neighbours sharing a corner give AO 1 there', () => {
    const m = mesh(world([[...A, B.STONE], [...near(0, 1), B.STONE], [...near(1, 1), B.STONE]]));
    const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
    const shade = FACE_SHADE[FACE_TOP];
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const k = TOP_ORDER[mIdx];
      // corner 1 touches faces 0 and 1 (both raised) → 1; corners 0 and 2 touch one raised face → 2
      const ao = k === 1 ? 1 : k === 0 || k === 2 ? 2 : 3;
      expectGrey(top.colors[1 + mIdx], shade * AO_CURVE[ao]);
    }
  });

  it('bottom cap samples the neighbours one level DOWN', () => {
    const m = mesh(world([[...A, B.STONE], [...near(3, -1), B.STONE]]));
    const bottom = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_BOTTOM);
    const shade = FACE_SHADE[FACE_BOTTOM];
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const k = BOTTOM_ORDER[mIdx];
      const ao = k === 3 || k === 4 ? 2 : 3; // face 3 spans corners 3 and 4
      expectGrey(bottom.colors[1 + mIdx], shade * AO_CURVE[ao]);
    }
    // A raised neighbour does not affect the bottom cap.
    const m2 = mesh(world([[...A, B.STONE], [...near(3, 1), B.STONE]]));
    const bottom2 = facesAt(m2, AQ, AY, AR).find((f) => f.face === FACE_BOTTOM);
    for (const c of bottom2.colors) expectGrey(c, shade);
  });

  it('every side / corner colour is FACE_SHADE[f] × an AO_CURVE value and every cap centre is the corner mean (untinted STONE scene)', () => {
    const cells = [];
    for (let dq = -2; dq <= 2; dq++) {
      for (let dr = -2; dr <= 2; dr++) {
        for (let dy = -1; dy <= 1; dy++) {
          if ((dq * 7 + dr * 3 + dy * 5 + 100) % 3 !== 0) cells.push([AQ + dq, AY + dy, AR + dr, B.STONE]);
        }
      }
    }
    const m = mesh(world(cells));
    const allowed = (f) => AO_CURVE.map((a) => a * FACE_SHADE[f]);
    let checked = 0;
    for (const f of faces(m.opaque)) {
      const options = allowed(f.face);
      const first = f.isCap ? 1 : 0;
      let sum = 0;
      for (let v = first; v < f.verts.length; v++) {
        const c = f.colors[v];
        expect(c[1]).toBeCloseTo(c[0], 6);
        expect(c[2]).toBeCloseTo(c[0], 6);
        expect(options.some((o) => Math.abs(o - c[0]) < 1e-5)).toBe(true);
        sum += c[0];
        checked++;
      }
      if (f.isCap) expect(f.colors[0][0]).toBeCloseTo(sum / 6, 5);
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('buildChunkMesh — biome tint', () => {
  it('isTintedFace: grass top and every leaves face, nothing else', () => {
    expect(isTintedFace(B.GRASS_BLOCK, FACE_TOP)).toBe(true);
    expect(isTintedFace(B.GRASS_BLOCK, FACE_BOTTOM)).toBe(false);
    for (let j = 0; j < 6; j++) expect(isTintedFace(B.GRASS_BLOCK, j)).toBe(false);
    for (let f = 0; f < 8; f++) {
      expect(isTintedFace(B.OAK_LEAVES, f)).toBe(true);
      expect(isTintedFace(B.STONE, f)).toBe(false);
      expect(isTintedFace(B.SNOWY_GRASS, f)).toBe(false);
      expect(isTintedFace(B.DIRT, f)).toBe(false);
    }
    expect(BIOME_TINT.length).toBe(8);
    for (const t of BIOME_TINT) {
      expect(t.length).toBe(3);
      for (const c of t) {
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
  it('GRASS_BLOCK: only the top cap is multiplied by the column biome tint', () => {
    const chunks = world([[...A, B.GRASS_BLOCK]]);
    chunks.get(chunkKey(0, 0)).biomes[columnIndex(AQ, AR)] = BIOME.FOREST;
    const m = mesh(chunks);
    const tint = BIOME_TINT[BIOME.FOREST];
    for (const f of faces(m.opaque)) {
      for (const c of f.colors) {
        if (f.face === FACE_TOP) {
          expect(c[0]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[0], 5);
          expect(c[1]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[1], 5);
          expect(c[2]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[2], 5);
        } else {
          expectGrey(c, FACE_SHADE[f.face]);
        }
      }
    }
  });
  it('OAK_LEAVES: every face is tinted; STONE never is', () => {
    const chunks = world([[...A, B.OAK_LEAVES], [AQ, AY + 3, AR, B.STONE]]);
    chunks.get(chunkKey(0, 0)).biomes[columnIndex(AQ, AR)] = BIOME.DESERT;
    const m = mesh(chunks);
    const tint = BIOME_TINT[BIOME.DESERT];
    for (const f of faces(m.cutout)) {
      for (const c of f.colors) {
        expect(c[0]).toBeCloseTo(FACE_SHADE[f.face] * tint[0], 5);
        expect(c[1]).toBeCloseTo(FACE_SHADE[f.face] * tint[1], 5);
        expect(c[2]).toBeCloseTo(FACE_SHADE[f.face] * tint[2], 5);
      }
    }
    for (const f of faces(m.opaque)) for (const c of f.colors) expectGrey(c, FACE_SHADE[f.face]);
  });
  it('tint follows the biome of each column, and AO still applies underneath it', () => {
    const chunks = world([[...A, B.GRASS_BLOCK], [...near(0), B.GRASS_BLOCK], [...near(0, 1), B.STONE]]);
    const biomes = chunks.get(chunkKey(0, 0)).biomes;
    biomes[columnIndex(AQ, AR)] = BIOME.SNOWY;
    const n0 = near(0);
    biomes[columnIndex(n0[0], n0[2])] = BIOME.PLAINS;
    const m = mesh(chunks);
    const top = facesAt(m, AQ, AY, AR).find((f) => f.face === FACE_TOP);
    const tint = BIOME_TINT[BIOME.SNOWY];
    for (let mIdx = 0; mIdx < 6; mIdx++) {
      const k = TOP_ORDER[mIdx];
      const ao = k === 0 || k === 1 ? 2 : 3;
      const base = FACE_SHADE[FACE_TOP] * AO_CURVE[ao];
      expect(top.colors[1 + mIdx][0]).toBeCloseTo(base * tint[0], 5);
      expect(top.colors[1 + mIdx][1]).toBeCloseTo(base * tint[1], 5);
      expect(top.colors[1 + mIdx][2]).toBeCloseTo(base * tint[2], 5);
    }
    // The grass under the stone has no top face; its visible sides are untinted (grey, shade × an AO level —
    // cell A is the third cell around two of its vertical edges, so some vertices are AO-darkened).
    const sideFaces = facesAt(m, n0[0], n0[1], n0[2]);
    expect(sideFaces.length).toBeGreaterThan(0);
    for (const f of sideFaces) {
      expect(f.face).not.toBe(FACE_TOP);
      for (const c of f.colors) {
        expect(c[1]).toBeCloseTo(c[0], 6);
        expect(c[2]).toBeCloseTo(c[0], 6);
        expect(AO_CURVE.some((a) => Math.abs(a * FACE_SHADE[f.face] - c[0]) < 1e-5)).toBe(true);
      }
    }
  });
  it('a chunk without a biomes array falls back to the PLAINS tint', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    blocks[localIndex(AQ, AY, AR)] = B.GRASS_BLOCK;
    const m = buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? { blocks } : null));
    const top = faces(m.opaque).find((f) => f.face === FACE_TOP);
    const tint = BIOME_TINT[BIOME.PLAINS];
    for (const c of top.colors) {
      expect(c[0]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[0], 5);
      expect(c[1]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[1], 5);
      expect(c[2]).toBeCloseTo(FACE_SHADE[FACE_TOP] * tint[2], 5);
    }
  });
});

describe('buildChunkMesh — terrain-scale behaviour (seed 1)', () => {
  const wg = createWorldGen(1);
  const R = 4;
  const chunks = new Map();
  for (let cq = -R; cq <= R; cq++) for (let cr = -R; cr <= R; cr++) chunks.set(chunkKey(cq, cr), wg.generateChunk(cq, cr));
  const get = makeChunkDataGetter(chunks);
  const meshes = [];
  for (let cq = -R + 1; cq <= R - 1; cq++) for (let cr = -R + 1; cr <= R - 1; cr++) meshes.push({ cq, cr, m: buildChunkMesh(cq, cr, get) });

  it('produces structurally valid layers; across the area every layer kind appears', () => {
    let sawCutout = false;
    let sawTranslucent = false;
    for (const { m } of meshes) {
      expect(m.opaque).not.toBeNull();
      if (m.cutout) sawCutout = true;
      if (m.translucent) sawTranslucent = true;
      for (const L of layers(m)) {
        expect(L.positions.length).toBe(L.vertexCount * 3);
        expect(L.normals.length).toBe(L.vertexCount * 3);
        expect(L.uvs.length).toBe(L.vertexCount * 2);
        expect(L.colors.length).toBe(L.vertexCount * 3);
        expect(L.indices.length).toBe(L.indexCount);
        expect(L.indices).toBeInstanceOf(Uint32Array);
        expect(L.indexCount % 3).toBe(0);
        let max = 0;
        for (let i = 0; i < L.indices.length; i++) if (L.indices[i] > max) max = L.indices[i];
        expect(max).toBeLessThan(L.vertexCount);
        expect(L.faceCount).toBeGreaterThan(0);
        faces(L); // walks every face and asserts the cursors line up
      }
    }
    expect(sawCutout).toBe(true);
    expect(sawTranslucent).toBe(true);
  });

  it('every triangle of every layer is CCW seen from outside', () => {
    for (const { m } of meshes) for (const L of layers(m)) expectWindingsConsistent(L);
  });

  it('positions stay inside the chunk parallelogram plus one corner radius; y within [0, 128]', () => {
    const minX = -0.5 - 1e-4;
    const maxX = CHUNK_SIZE - 1 + (CHUNK_SIZE - 1) / 2 + 0.5 + 1e-4;
    const minZ = -HEX_SIZE - 1e-4;
    const maxZ = (CHUNK_SIZE - 1) * HEX_ROW_SPACING + HEX_SIZE + 1e-4;
    let outside = 0;
    let vertices = 0;
    for (const { m } of meshes) {
      for (const L of layers(m)) {
        const P = L.positions;
        for (let i = 0; i < P.length; i += 3) {
          vertices++;
          if (P[i] < minX || P[i] > maxX || P[i + 1] < 0 || P[i + 1] > WORLD_HEIGHT || P[i + 2] < minZ || P[i + 2] > maxZ) outside++;
        }
      }
    }
    expect(vertices).toBeGreaterThan(10000);
    expect(outside).toBe(0);
  });

  it('every colour component is within (0, 1]', () => {
    let bad = 0;
    let count = 0;
    for (const { m } of meshes) {
      for (const L of layers(m)) {
        for (let i = 0; i < L.colors.length; i++) {
          count++;
          const c = L.colors[i];
          if (!(c > 0 && c <= 1 + 1e-6)) bad++;
        }
      }
    }
    expect(count).toBeGreaterThan(10000);
    expect(bad).toBe(0);
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const a = buildChunkMesh(0, 0, get);
    const b = buildChunkMesh(0, 0, get);
    for (const name of ['opaque', 'cutout', 'translucent']) {
      if (!a[name]) {
        expect(b[name]).toBeNull();
        continue;
      }
      for (const arr of ['positions', 'normals', 'uvs', 'colors', 'indices']) expect(b[name][arr]).toEqual(a[name][arr]);
      expect(b[name].vertexCount).toBe(a[name].vertexCount);
      expect(b[name].indexCount).toBe(a[name].indexCount);
      expect(b[name].faceCount).toBe(a[name].faceCount);
    }
  });

  it('returned arrays are independent copies (a later build does not alter an earlier result)', () => {
    const first = buildChunkMesh(0, 0, get);
    const snapshot = {
      positions: first.opaque.positions.slice(),
      indices: first.opaque.indices.slice(),
      colors: first.opaque.colors.slice(),
    };
    buildChunkMesh(1, -1, get);
    buildChunkMesh(-2, 2, get);
    expect(first.opaque.positions).toEqual(snapshot.positions);
    expect(first.opaque.indices).toEqual(snapshot.indices);
    expect(first.opaque.colors).toEqual(snapshot.colors);
  });

  it('meshes a real chunk in under 25 ms (warm, averaged)', () => {
    for (let i = 0; i < 3; i++) buildChunkMesh(0, 0, get);
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) buildChunkMesh(0, 0, get);
    const avg = (performance.now() - t0) / runs;
    expect(avg).toBeLessThan(25);
  });
});
