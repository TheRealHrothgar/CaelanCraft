// Tests for src/mesher.js — see src/CONTRACTS.md §10 and docs/PLAN-build.md §2.6.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, WATER_SURFACE_HEIGHT, AO_CURVE, FACE_SHADE, UV_INSET, TILE_UV } from '../../src/config.js';
import { chunkKey, localIndex, FACE_NORMALS, FACE_VERTS } from '../../src/coords.js';
import { BLOCK, getFaceTile, tileToUV } from '../../src/blocks.js';
import { buildChunkMesh, vertexAO, createMeshBuilder } from '../../src/mesher.js';
import { makeChunkData, makeChunkDataGetter, setWorldBlock, countFaces } from '../helpers/fixtures.js';

const B = BLOCK;

/** Build a Map<chunkKey, ChunkData> from a list of [wx, wy, wz, id]. */
function world(blocksList) {
  const chunks = new Map();
  for (const [x, y, z, id] of blocksList) setWorldBlock(chunks, x, y, z, id);
  return chunks;
}

/** Mesh chunk (cx, cz) over a chunk map. */
function mesh(chunks, cx = 0, cz = 0) {
  return buildChunkMesh(cx, cz, makeChunkDataGetter(chunks));
}

/** Every non-null layer of a ChunkMeshData. */
function layers(m) {
  return [m.opaque, m.cutout, m.translucent].filter(Boolean);
}

/** Iterate the quads of a layer: { base, normal:[nx,ny,nz], verts:[[x,y,z]×4], uvs:[[u,v]×4], colors:[[r,g,b]×4], idx:[6] } */
function quads(layer) {
  const out = [];
  for (let q = 0; q < layer.faceCount; q++) {
    const base = q * 4;
    const verts = [];
    const uvs = [];
    const colors = [];
    for (let v = 0; v < 4; v++) {
      const i = base + v;
      verts.push([layer.positions[i * 3], layer.positions[i * 3 + 1], layer.positions[i * 3 + 2]]);
      uvs.push([layer.uvs[i * 2], layer.uvs[i * 2 + 1]]);
      colors.push([layer.colors[i * 3], layer.colors[i * 3 + 1], layer.colors[i * 3 + 2]]);
    }
    const normal = [layer.normals[base * 3], layer.normals[base * 3 + 1], layer.normals[base * 3 + 2]];
    const idx = Array.from(layer.indices.subarray(q * 6, q * 6 + 6));
    out.push({ base, normal, verts, uvs, colors, idx });
  }
  return out;
}

function faceOfNormal(n) {
  return FACE_NORMALS.findIndex((fn) => fn[0] === n[0] && fn[1] === n[1] && fn[2] === n[2]);
}

/** The +Y quad of the block at (x,y,z): its vertex 0 is corner (0,1,1) → position (x, y+1, z+1). */
function topFaceOf(layer, x, y, z) {
  return quads(layer).find((q) => faceOfNormal(q.normal) === 2 && q.verts[0][0] === x && q.verts[0][1] === y + 1 && q.verts[0][2] === z + 1);
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Structural checks every layer must satisfy: array types/lengths, index validity, 4 distinct verts per
 * quad, CCW winding, constant unit axis normals, chunk-local positions. Violations are counted in plain
 * JS and asserted once per category so large layers (tens of thousands of quads) stay fast.
 */
function checkLayerIntegrity(layer) {
  expect(layer.positions).toBeInstanceOf(Float32Array);
  expect(layer.normals).toBeInstanceOf(Float32Array);
  expect(layer.uvs).toBeInstanceOf(Float32Array);
  expect(layer.colors).toBeInstanceOf(Float32Array);
  expect(layer.indices).toBeInstanceOf(Uint32Array);
  expect(layer.vertexCount).toBe(layer.faceCount * 4);
  expect(layer.positions.length).toBe(layer.vertexCount * 3);
  expect(layer.normals.length).toBe(layer.vertexCount * 3);
  expect(layer.uvs.length).toBe(layer.vertexCount * 2);
  expect(layer.colors.length).toBe(layer.vertexCount * 3);
  expect(layer.indices.length).toBe(layer.faceCount * 6);
  const { positions, normals, indices, vertexCount, faceCount } = layer;
  let badIndexRange = 0;
  let badDistinct = 0;
  let badNormal = 0;
  let badWinding = 0;
  let badPosition = 0;
  for (let q = 0; q < faceCount; q++) {
    const base = q * 4;
    const ib = q * 6;
    const set = new Set();
    for (let k = 0; k < 6; k++) {
      const i = indices[ib + k];
      if (i >= vertexCount || i < base || i >= base + 4) badIndexRange++;
      set.add(i);
    }
    if (set.size !== 4) badDistinct++;
    const n = [normals[base * 3], normals[base * 3 + 1], normals[base * 3 + 2]];
    if (faceOfNormal(n) < 0) badNormal++;
    for (let v = 1; v < 4; v++) {
      const i = base + v;
      if (normals[i * 3] !== n[0] || normals[i * 3 + 1] !== n[1] || normals[i * 3 + 2] !== n[2]) badNormal++;
    }
    for (let v = 0; v < 4; v++) {
      const i = (base + v) * 3;
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < 0 || x > CHUNK_SIZE || y < 0 || y > WORLD_HEIGHT || z < 0 || z > CHUNK_SIZE) badPosition++;
    }
    for (let t = 0; t < 2; t++) {
      const ia = indices[ib + t * 3] * 3;
      const ic1 = indices[ib + t * 3 + 1] * 3;
      const ic2 = indices[ib + t * 3 + 2] * 3;
      const a = [positions[ia], positions[ia + 1], positions[ia + 2]];
      const b = [positions[ic1], positions[ic1 + 1], positions[ic1 + 2]];
      const c = [positions[ic2], positions[ic2 + 1], positions[ic2 + 2]];
      if (!(dot(cross(sub(b, a), sub(c, a)), n) > 0)) badWinding++;
    }
  }
  expect(badIndexRange).toBe(0);
  expect(badDistinct).toBe(0);
  expect(badNormal).toBe(0);
  expect(badWinding).toBe(0);
  expect(badPosition).toBe(0);
}

/** Deterministic synthetic terrain resembling a real worldgen chunk (worldgen.js is a stub at the time of writing). */
function syntheticTerrain(cx, cz) {
  const d = makeChunkData();
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const h = Math.round(62 + 8 * Math.sin(wx / 5) + 7 * Math.cos(wz / 6) + 3 * Math.sin((wx + wz) / 4));
      const base = localIndex(lx, 0, lz);
      for (let y = 0; y <= h; y++) {
        let id = B.STONE;
        if (y === 0) id = B.BEDROCK;
        else if (y === h) id = h < 62 ? B.SAND : B.GRASS_BLOCK;
        else if (y > h - 4) id = B.DIRT;
        else if (((wx * 73856093) ^ (y * 19349663) ^ (wz * 83492791)) % 97 === 0) id = B.COAL_ORE;
        // simple cave band
        if (y > 20 && y < 40 && Math.sin(wx / 5) * Math.cos(wz / 6) * Math.sin(y / 3) > 0.6) id = B.AIR;
        d.blocks[base + y] = id;
      }
      for (let y = h + 1; y <= 62; y++) d.blocks[base + y] = B.WATER;
      if ((wx & 7) === 3 && (wz & 7) === 5 && h >= 63) {
        for (let y = h + 1; y <= h + 4; y++) d.blocks[base + y] = B.OAK_LOG;
        d.blocks[base + h + 5] = B.OAK_LEAVES;
      }
      if ((wx & 15) === 9 && (wz & 15) === 9 && h >= 63) d.blocks[base + h + 1] = B.GLASS;
    }
  }
  return d;
}

describe('vertexAO', () => {
  it('follows the classic 0..3 rule', () => {
    expect(vertexAO(0, 0, 0)).toBe(3);
    expect(vertexAO(1, 0, 0)).toBe(2);
    expect(vertexAO(0, 1, 0)).toBe(2);
    expect(vertexAO(0, 0, 1)).toBe(2);
    expect(vertexAO(1, 0, 1)).toBe(1);
    expect(vertexAO(0, 1, 1)).toBe(1);
    expect(vertexAO(1, 1, 0)).toBe(0);
    expect(vertexAO(1, 1, 1)).toBe(0);
  });
});

describe('createMeshBuilder', () => {
  it('starts empty and builds null when nothing was added', () => {
    const b = createMeshBuilder(4);
    expect(b.vertexCount).toBe(0);
    expect(b.faceCount).toBe(0);
    expect(b.build()).toBeNull();
  });
  it('grows its buffers when asked for more quads than its capacity', () => {
    const b = createMeshBuilder(1);
    const before = b.positions.length;
    b.ensure(100);
    expect(b.positions.length).toBeGreaterThanOrEqual(100 * 12);
    expect(b.positions.length).toBeGreaterThan(before);
    expect(b.indices).toBeInstanceOf(Uint32Array);
  });
});

describe('buildChunkMesh — basic face counts', () => {
  it('lone block → 6 faces, 24 verts, 36 indices, in the opaque layer only', () => {
    const m = mesh(world([[5, 5, 5, B.STONE]]));
    expect(m.cutout).toBeNull();
    expect(m.translucent).toBeNull();
    expect(m.opaque).not.toBeNull();
    expect(m.opaque.faceCount).toBe(6);
    expect(m.opaque.vertexCount).toBe(24);
    expect(m.opaque.indices.length).toBe(36);
    expect(m.opaque.positions.length).toBe(72);
    expect(m.opaque.normals.length).toBe(72);
    expect(m.opaque.uvs.length).toBe(48);
    expect(m.opaque.colors.length).toBe(72);
    expect(countFaces(m)).toBe(6);
    checkLayerIntegrity(m.opaque);
    // all six normals present exactly once
    const seen = quads(m.opaque).map((q) => faceOfNormal(q.normal)).sort();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('two adjacent blocks → 10 faces', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 5, 5, B.STONE]]));
    expect(countFaces(m)).toBe(10);
    checkLayerIntegrity(m.opaque);
  });

  it('3×3×3 cube → 54 faces', () => {
    const list = [];
    for (let x = 4; x < 7; x++) for (let y = 4; y < 7; y++) for (let z = 4; z < 7; z++) list.push([x, y, z, B.STONE]);
    const m = mesh(world(list));
    expect(countFaces(m)).toBe(54);
    checkLayerIntegrity(m.opaque);
  });

  it('empty chunk → all three layers null, no throw', () => {
    const chunks = new Map([[chunkKey(0, 0), makeChunkData()]]);
    const m = mesh(chunks);
    expect(m).toEqual({ opaque: null, cutout: null, translucent: null });
    expect(countFaces(m)).toBe(0);
  });

  it('chunk with no data at all (getChunkData null everywhere) → all null', () => {
    const m = buildChunkMesh(3, -2, () => null);
    expect(m).toEqual({ opaque: null, cutout: null, translucent: null });
  });

  it('full STONE chunk with empty neighbours → 4 walls + top; bottom culled by below-world BEDROCK', () => {
    const d = makeChunkData();
    d.blocks.fill(B.STONE);
    const m = mesh(new Map([[chunkKey(0, 0), d]]));
    expect(m.opaque.faceCount).toBe(4 * 16 * WORLD_HEIGHT + 256);
    const bottoms = quads(m.opaque).filter((q) => faceOfNormal(q.normal) === 3);
    expect(bottoms.length).toBe(0);
    checkLayerIntegrity(m.opaque);
  });

  it('checkerboard chunk exceeds 65535 vertices and indices stay valid Uint32', () => {
    const d = makeChunkData();
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let ly = 0; ly < WORLD_HEIGHT; ly++) {
      if ((lx + ly + lz) & 1) d.blocks[localIndex(lx, ly, lz)] = B.STONE;
    }
    const m = mesh(new Map([[chunkKey(0, 0), d]]));
    expect(m.opaque.vertexCount).toBeGreaterThan(65535);
    expect(m.opaque.indices).toBeInstanceOf(Uint32Array);
    let maxIdx = 0;
    for (let i = 0; i < m.opaque.indices.length; i++) if (m.opaque.indices[i] > maxIdx) maxIdx = m.opaque.indices[i];
    expect(maxIdx).toBe(m.opaque.vertexCount - 1);
    // every block has all six faces except those at y=0 (bottom culled by bedrock)
    const cells = 16 * 16 * WORLD_HEIGHT / 2;
    const y0Cells = 16 * 16 / 2;
    expect(m.opaque.faceCount).toBe(cells * 6 - y0Cells);
  });
});

describe('buildChunkMesh — chunk borders and neighbours', () => {
  it('culls the face against a block in the neighbouring chunk (via getChunkData)', () => {
    const chunks = world([[15, 5, 5, B.STONE], [16, 5, 5, B.STONE]]);
    const m0 = mesh(chunks, 0, 0);
    expect(countFaces(m0)).toBe(5);
    expect(quads(m0.opaque).some((q) => faceOfNormal(q.normal) === 0)).toBe(false);
    const m1 = mesh(chunks, 1, 0);
    expect(countFaces(m1)).toBe(5);
    expect(quads(m1.opaque).some((q) => faceOfNormal(q.normal) === 1)).toBe(false);
    // positions are chunk-local in both
    checkLayerIntegrity(m0.opaque);
    checkLayerIntegrity(m1.opaque);
    for (const q of quads(m1.opaque)) for (const v of q.verts) expect(v[0]).toBeLessThanOrEqual(1);
  });

  it('a missing neighbour chunk is treated as AIR (border face rendered)', () => {
    const m = mesh(world([[15, 5, 5, B.STONE]]));
    expect(countFaces(m)).toBe(6);
    const m2 = mesh(world([[0, 5, 0, B.STONE]]));
    expect(countFaces(m2)).toBe(6);
  });

  it('handles negative chunk coordinates with floor semantics', () => {
    // (-1,5,-1) is local (15,5,15) of chunk (-1,-1)
    const chunks = world([[-1, 5, -1, B.STONE]]);
    const m = mesh(chunks, -1, -1);
    expect(countFaces(m)).toBe(6);
    for (const q of quads(m.opaque)) for (const v of q.verts) {
      expect(v[0]).toBeGreaterThanOrEqual(15);
      expect(v[2]).toBeGreaterThanOrEqual(15);
    }
    // a neighbour across the negative border culls the +X face
    setWorldBlock(chunks, 0, 5, -1, B.STONE);
    const m2 = mesh(chunks, -1, -1);
    expect(countFaces(m2)).toBe(5);
    expect(quads(m2.opaque).some((q) => faceOfNormal(q.normal) === 0)).toBe(false);
    // and the +Z face across the border into chunk (-1, 0): (-1,5,-1) is local z=15, its +Z neighbour is z=0
    setWorldBlock(chunks, -1, 5, 0, B.STONE);
    const m3 = mesh(chunks, -1, -1);
    expect(countFaces(m3)).toBe(4);
    expect(quads(m3.opaque).some((q) => faceOfNormal(q.normal) === 4)).toBe(false);
  });

  it('AO reads the neighbour chunk too', () => {
    // block at (15,5,5); occluder above-and-beside in chunk 1 at (16,6,5)
    const chunks = world([[15, 5, 5, B.STONE], [16, 6, 5, B.STONE]]);
    const m = mesh(chunks, 0, 0);
    const top = topFaceOf(m.opaque, 15, 5, 5);
    const dark = top.colors.filter((c) => c[0] < FACE_SHADE[2] - 1e-6);
    expect(dark.length).toBe(2);
  });

  it('only queries getChunkData for the 3×3 neighbourhood', () => {
    const chunks = world([[5, 5, 5, B.STONE]]);
    const getter = makeChunkDataGetter(chunks);
    const calls = [];
    buildChunkMesh(2, -3, (cx, cz) => {
      calls.push([cx, cz]);
      return getter(cx, cz);
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const [cx, cz] of calls) {
      expect(Math.abs(cx - 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(cz + 3)).toBeLessThanOrEqual(1);
    }
    const distinct = new Set(calls.map(([a, b]) => `${a},${b}`));
    expect(distinct.size).toBeLessThanOrEqual(9);
  });

  it('bottom faces at y=0 are culled (below-world is BEDROCK)', () => {
    const m = mesh(world([[5, 0, 5, B.STONE]]));
    expect(countFaces(m)).toBe(5);
    expect(quads(m.opaque).some((q) => faceOfNormal(q.normal) === 3)).toBe(false);
  });

  it('top faces at y=127 are rendered (above-world is AIR)', () => {
    const m = mesh(world([[5, WORLD_HEIGHT - 1, 5, B.STONE]]));
    expect(countFaces(m)).toBe(6);
    const top = quads(m.opaque).find((q) => faceOfNormal(q.normal) === 2);
    for (const v of top.verts) expect(v[1]).toBe(WORLD_HEIGHT);
    // fully lit: nothing above the world can occlude
    for (const c of top.colors) expect(c[0]).toBeCloseTo(FACE_SHADE[2], 6);
  });
});

describe('buildChunkMesh — water', () => {
  it('water with air above: translucent layer only, every y=1 corner lowered to WATER_SURFACE_HEIGHT', () => {
    const m = mesh(world([[5, 60, 5, B.WATER]]));
    expect(m.opaque).toBeNull();
    expect(m.cutout).toBeNull();
    expect(m.translucent.faceCount).toBe(6);
    checkLayerIntegrity(m.translucent);
    const qs = quads(m.translucent);
    const top = qs.find((q) => faceOfNormal(q.normal) === 2);
    for (const v of top.verts) expect(v[1]).toBeCloseTo(60 + WATER_SURFACE_HEIGHT, 6);
    // side faces: their upper corners are lowered too
    for (const q of qs) {
      const f = faceOfNormal(q.normal);
      if (f === 2 || f === 3) continue;
      const ys = q.verts.map((v) => v[1]).sort();
      expect(ys).toEqual([60, 60, 60 + WATER_SURFACE_HEIGHT, 60 + WATER_SURFACE_HEIGHT]);
    }
    const bottom = qs.find((q) => faceOfNormal(q.normal) === 3);
    for (const v of bottom.verts) expect(v[1]).toBe(60);
  });

  it('water with water above keeps a full-height cube and the shared face is culled', () => {
    const m = mesh(world([[5, 60, 5, B.WATER], [5, 61, 5, B.WATER]]));
    expect(countFaces(m)).toBe(10);
    const qs = quads(m.translucent);
    // no face at the internal boundary y=61
    for (const q of qs) {
      const f = faceOfNormal(q.normal);
      if (f === 2) expect(q.verts[0][1]).toBeCloseTo(61 + WATER_SURFACE_HEIGHT, 6);
      if (f === 3) expect(q.verts[0][1]).toBe(60);
    }
    // the lower block's side faces go from 60 to 61 (topY = 1 since water is above)
    const lowerSides = qs.filter((q) => faceOfNormal(q.normal) >= 4 && q.verts.some((v) => v[1] === 60));
    expect(lowerSides.length).toBe(2);
    for (const q of lowerSides) expect(Math.max(...q.verts.map((v) => v[1]))).toBe(61);
  });

  it('two side-by-side water blocks cull their shared face', () => {
    const m = mesh(world([[5, 60, 5, B.WATER], [6, 60, 5, B.WATER]]));
    expect(countFaces(m)).toBe(10);
  });

  it('STONE next to WATER renders the stone face; water does not render toward stone', () => {
    const m = mesh(world([[5, 60, 5, B.STONE], [6, 60, 5, B.WATER]]));
    expect(m.opaque.faceCount).toBe(6);
    expect(m.translucent.faceCount).toBe(5);
    expect(quads(m.translucent).some((q) => faceOfNormal(q.normal) === 1)).toBe(false);
  });

  it('water renders toward glass and leaves (non-opaque, different id)', () => {
    const m = mesh(world([[5, 60, 5, B.WATER], [6, 60, 5, B.GLASS], [4, 60, 5, B.OAK_LEAVES]]));
    expect(m.translucent.faceCount).toBe(6);
  });

  it('water never occludes AO', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 6, 5, B.WATER]]));
    const top = topFaceOf(m.opaque, 5, 5, 5);
    for (const c of top.colors) expect(c[0]).toBeCloseTo(FACE_SHADE[2] * AO_CURVE[3], 6);
  });
});

describe('buildChunkMesh — cutout layer', () => {
  it('GLASS–GLASS culled (10 faces), all in the cutout layer', () => {
    const m = mesh(world([[5, 5, 5, B.GLASS], [6, 5, 5, B.GLASS]]));
    expect(m.opaque).toBeNull();
    expect(m.translucent).toBeNull();
    expect(m.cutout.faceCount).toBe(10);
    checkLayerIntegrity(m.cutout);
  });

  it('STONE next to GLASS renders the stone face; glass culls toward stone', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 5, 5, B.GLASS]]));
    expect(m.opaque.faceCount).toBe(6);
    expect(quads(m.opaque).some((q) => faceOfNormal(q.normal) === 0)).toBe(true);
    expect(m.cutout.faceCount).toBe(5);
    expect(quads(m.cutout).some((q) => faceOfNormal(q.normal) === 1)).toBe(false);
  });

  it('LEAVES–LEAVES both rendered (12 faces)', () => {
    const m = mesh(world([[5, 5, 5, B.OAK_LEAVES], [6, 5, 5, B.OAK_LEAVES]]));
    expect(m.cutout.faceCount).toBe(12);
    checkLayerIntegrity(m.cutout);
  });

  it('GLASS next to LEAVES: both faces rendered (different ids, both non-opaque)', () => {
    const m = mesh(world([[5, 5, 5, B.GLASS], [6, 5, 5, B.OAK_LEAVES]]));
    expect(m.cutout.faceCount).toBe(12);
  });

  it('glass and leaves do not occlude AO', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 6, 5, B.GLASS], [4, 6, 5, B.OAK_LEAVES]]));
    const top = topFaceOf(m.opaque, 5, 5, 5);
    for (const c of top.colors) expect(c[0]).toBeCloseTo(FACE_SHADE[2], 6);
  });
});

describe('buildChunkMesh — UVs, positions and vertex order', () => {
  it('UVs lie inside the tile rect of getFaceTile and follow the exact vertex→uv assignment', () => {
    const m = mesh(world([[5, 5, 5, B.GRASS_BLOCK]]));
    const qs = quads(m.opaque);
    const tilesSeen = new Set();
    for (const q of qs) {
      const f = faceOfNormal(q.normal);
      const tile = getFaceTile(B.GRASS_BLOCK, f);
      tilesSeen.add(tile);
      const [u0, v0, u1, v1] = tileToUV(tile);
      // inside the inset rect
      for (const [u, v] of q.uvs) {
        expect(u).toBeGreaterThanOrEqual(u0 - 1e-7);
        expect(u).toBeLessThanOrEqual(u1 + 1e-7);
        expect(v).toBeGreaterThanOrEqual(v0 - 1e-7);
        expect(v).toBeLessThanOrEqual(v1 + 1e-7);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      // the rect really is the tile inset by UV_INSET
      const tx = tile % 16;
      const ty = Math.floor(tile / 16);
      expect(u0).toBeCloseTo(tx * TILE_UV + UV_INSET, 9);
      expect(v1).toBeCloseTo((ty + 1) * TILE_UV - UV_INSET, 9);
      // exact assignment: uv[0]=(u0,v1), uv[1]=(u1,v1), uv[2]=(u1,v0), uv[3]=(u0,v0)
      expect(q.uvs[0][0]).toBeCloseTo(u0, 6);
      expect(q.uvs[0][1]).toBeCloseTo(v1, 6);
      expect(q.uvs[1][0]).toBeCloseTo(u1, 6);
      expect(q.uvs[1][1]).toBeCloseTo(v1, 6);
      expect(q.uvs[2][0]).toBeCloseTo(u1, 6);
      expect(q.uvs[2][1]).toBeCloseTo(v0, 6);
      expect(q.uvs[3][0]).toBeCloseTo(u0, 6);
      expect(q.uvs[3][1]).toBeCloseTo(v0, 6);
    }
    // grass block: top, side and bottom tiles differ
    expect(tilesSeen.size).toBe(3);
  });

  it('vertex positions follow FACE_VERTS order offset by the block position', () => {
    const m = mesh(world([[3, 7, 9, B.STONE]]));
    for (const q of quads(m.opaque)) {
      const f = faceOfNormal(q.normal);
      for (let v = 0; v < 4; v++) {
        const c = FACE_VERTS[f][v];
        expect(q.verts[v]).toEqual([3 + c[0], 7 + c[1], 9 + c[2]]);
      }
    }
  });

  it('normals are unit axis vectors matching FACE_NORMALS', () => {
    const m = mesh(world([[5, 5, 5, B.STONE]]));
    for (const q of quads(m.opaque)) {
      const len = Math.hypot(...q.normal);
      expect(len).toBeCloseTo(1, 9);
      expect(faceOfNormal(q.normal)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildChunkMesh — ambient occlusion and colours', () => {
  it('lone block is fully lit: colour = FACE_SHADE[f] on every vertex, grey', () => {
    const m = mesh(world([[5, 5, 5, B.STONE]]));
    for (const q of quads(m.opaque)) {
      const f = faceOfNormal(q.normal);
      for (const c of q.colors) {
        expect(c[0]).toBeCloseTo(FACE_SHADE[f] * AO_CURVE[3], 6);
        expect(c[1]).toBeCloseTo(c[0], 9);
        expect(c[2]).toBeCloseTo(c[0], 9);
      }
    }
  });

  it('a neighbour above-and-beside darkens exactly 2 of the 4 top vertices to AO level 2', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 6, 5, B.STONE]]));
    const top = topFaceOf(m.opaque, 5, 5, 5);
    const lit = top.colors.filter((c) => Math.abs(c[0] - FACE_SHADE[2] * AO_CURVE[3]) < 1e-6);
    const dark = top.colors.filter((c) => Math.abs(c[0] - FACE_SHADE[2] * AO_CURVE[2]) < 1e-6);
    expect(lit.length).toBe(2);
    expect(dark.length).toBe(2);
    // the dark vertices are the ones on the +X edge
    for (let v = 0; v < 4; v++) {
      const isDark = Math.abs(top.colors[v][0] - FACE_SHADE[2] * AO_CURVE[2]) < 1e-6;
      expect(isDark).toBe(top.verts[v][0] === 6);
    }
    // the +X side face samples around Q=(6,5,5): its two upper corners see (6,6,5) as side1 → AO 2
    const px = quads(m.opaque).find((q) => faceOfNormal(q.normal) === 0 && q.verts[0][0] === 6 && q.verts[0][1] === 5);
    for (let v = 0; v < 4; v++) {
      const expected = px.verts[v][1] === 6 ? AO_CURVE[2] : AO_CURVE[3];
      expect(px.colors[v][0]).toBeCloseTo(FACE_SHADE[0] * expected, 6);
    }
  });

  it('two side occluders at a corner give AO 0 (fully dark) at that vertex', () => {
    // top face of (5,5,5); occluders at (6,6,5) [+X] and (5,6,6) [+Z] → corner (1,1,1) has s1 && s2 → 0
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 6, 5, B.STONE], [5, 6, 6, B.STONE]]));
    const top = topFaceOf(m.opaque, 5, 5, 5);
    const idx = top.verts.findIndex((v) => v[0] === 6 && v[2] === 6);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(top.colors[idx][0]).toBeCloseTo(FACE_SHADE[2] * AO_CURVE[0], 6);
    // the two vertices sharing one occluder are level 2; the far vertex is level 3
    const levels = top.colors.map((c) => AO_CURVE.findIndex((a) => Math.abs(a * FACE_SHADE[2] - c[0]) < 1e-6)).sort();
    expect(levels).toEqual([0, 2, 2, 3]);
  });

  it('a diagonal-only occluder gives AO 2 at a single vertex', () => {
    const m = mesh(world([[5, 5, 5, B.STONE], [6, 6, 6, B.STONE]]));
    const top = topFaceOf(m.opaque, 5, 5, 5);
    const levels = top.colors.map((c) => AO_CURVE.findIndex((a) => Math.abs(a * FACE_SHADE[2] - c[0]) < 1e-6));
    expect(levels.filter((l) => l === 2).length).toBe(1);
    expect(levels.filter((l) => l === 3).length).toBe(3);
  });

  it('flips the quad diagonal toward the brighter pair', () => {
    // Default order: ao[0]+ao[2] >= ao[1]+ao[3]  → b,b+1,b+2, b,b+2,b+3
    const m1 = mesh(world([[5, 5, 5, B.STONE], [6, 6, 6, B.STONE]])); // darkens v1 (corner 1,1,1)
    const top1 = topFaceOf(m1.opaque, 5, 5, 5);
    const b1 = top1.base;
    expect(top1.idx).toEqual([b1, b1 + 1, b1 + 2, b1, b1 + 2, b1 + 3]);
    // Flipped: darken v0 (corner 0,1,1) with a diagonal occluder at (4,6,6)
    const m2 = mesh(world([[5, 5, 5, B.STONE], [4, 6, 6, B.STONE]]));
    const top2 = topFaceOf(m2.opaque, 5, 5, 5);
    const b2 = top2.base;
    expect(top2.idx).toEqual([b2 + 1, b2 + 2, b2 + 3, b2 + 1, b2 + 3, b2]);
    // both are still CCW
    checkLayerIntegrity(m1.opaque);
    checkLayerIntegrity(m2.opaque);
  });

  it('every colour is FACE_SHADE[f] × one of the AO_CURVE values', () => {
    const chunks = new Map([[chunkKey(0, 0), syntheticTerrain(0, 0)]]);
    const m = mesh(chunks);
    for (const layer of layers(m)) {
      for (const q of quads(layer)) {
        const f = faceOfNormal(q.normal);
        for (const c of q.colors) {
          const hit = AO_CURVE.some((a) => Math.abs(a * FACE_SHADE[f] - c[0]) < 1e-6);
          expect(hit).toBe(true);
        }
      }
    }
  });
});

describe('buildChunkMesh — terrain-scale behaviour', () => {
  function terrainWorld() {
    const chunks = new Map();
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) chunks.set(chunkKey(cx, cz), syntheticTerrain(cx, cz));
    return chunks;
  }

  it('produces structurally valid layers for a terrain-like chunk (all three layers present)', () => {
    const m = mesh(terrainWorld());
    expect(m.opaque).not.toBeNull();
    expect(m.cutout).not.toBeNull();
    expect(m.translucent).not.toBeNull();
    for (const layer of layers(m)) checkLayerIntegrity(layer);
    // every water top face sits at WATER_SURFACE_HEIGHT above its block
    for (const q of quads(m.translucent)) {
      if (faceOfNormal(q.normal) !== 2) continue;
      const frac = q.verts[0][1] - Math.floor(q.verts[0][1]);
      expect(frac === 0 || Math.abs(frac - WATER_SURFACE_HEIGHT) < 1e-6).toBe(true);
    }
  });

  it('is deterministic: identical inputs produce identical outputs', () => {
    const chunks = terrainWorld();
    const a = mesh(chunks);
    const b = mesh(chunks);
    for (const k of ['opaque', 'cutout', 'translucent']) {
      expect(a[k].vertexCount).toBe(b[k].vertexCount);
      expect(a[k].faceCount).toBe(b[k].faceCount);
      expect(a[k].positions).toEqual(b[k].positions);
      expect(a[k].normals).toEqual(b[k].normals);
      expect(a[k].uvs).toEqual(b[k].uvs);
      expect(a[k].colors).toEqual(b[k].colors);
      expect(a[k].indices).toEqual(b[k].indices);
    }
  });

  it('returned arrays are independent copies (not aliased scratch buffers)', () => {
    const chunks = terrainWorld();
    const a = mesh(chunks);
    const snapshot = a.opaque.positions.slice();
    mesh(world([[1, 1, 1, B.STONE]]));
    expect(a.opaque.positions).toEqual(snapshot);
    expect(a.opaque.positions.length).toBe(a.opaque.vertexCount * 3);
  });

  it('meshes a terrain-like chunk quickly (perf guard)', () => {
    const chunks = terrainWorld();
    const getter = makeChunkDataGetter(chunks);
    buildChunkMesh(0, 0, getter); // warm up
    const times = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      buildChunkMesh(0, 0, getter);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[3];
    console.log(`mesher perf: median ${median.toFixed(2)} ms (min ${times[0].toFixed(2)} ms)`);
    expect(median).toBeLessThan(50);
  });
});
