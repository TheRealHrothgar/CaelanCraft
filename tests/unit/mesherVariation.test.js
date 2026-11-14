// Per-cell variation (CONTRACTS §90): the mesher picks each face's picture, its mirror, flip and slide, and the cell's
// brightness from a hash of the cell's world position; and the atlas that holds the pictures (atlas.createAtlasPixels,
// atlas.buildAtlasMips).
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, ATLAS_SIZE_PX, ATLAS_SLOT_PX, ATLAS_MIP_LEVELS, TILE_UV } from '../../src/config.js';
import { HEX_SIZE, HEX_ROW_SPACING, FACE_TOP, FACE_BOTTOM } from '../../src/hex.js';
import { BLOCK, TILE, getFaceTile, tileToUV } from '../../src/blocks.js';
import { buildChunkMesh, setCellVariation, cellVariationEnabled } from '../../src/mesher.js';
import { tileVariants, BLOCK_JITTER } from '../../src/tileVariants.js';
import { createAtlasPixels, buildAtlasMips, tileOrigin, paintSlot } from '../../src/atlas.js';
import { paintTileHD } from '../../src/tilesHD.js';
import { makeChunkDataGetter, setWorldBlock } from '../helpers/fixtures.js';

const B = BLOCK;

/** A one-cell-thick floor of `id` at y = 10 over chunk (0, 0), every cell's top and its six sides exposed. */
function floor(id, step = 2) {
  const chunks = new Map();
  for (let q = 0; q < CHUNK_SIZE; q += step) for (let r = 0; r < CHUNK_SIZE; r += step) setWorldBlock(chunks, q, 10, r, id);
  return chunks;
}

/** The faces of a layer: per face its 4 (side) or 7 (cap) vertices' uvs and colours, and which face it is. */
function faces(layer) {
  const out = [];
  if (!layer) return out;
  let v = 0;
  while (v < layer.vertexCount) {
    const ny = layer.normals[v * 3 + 1];
    const n = ny === 0 ? 4 : 7;
    const uvs = [];
    const cols = [];
    for (let k = 0; k < n; k++) {
      uvs.push([layer.uvs[(v + k) * 2], layer.uvs[(v + k) * 2 + 1]]);
      cols.push([layer.colors[(v + k) * 3], layer.colors[(v + k) * 3 + 1], layer.colors[(v + k) * 3 + 2]]);
    }
    out.push({ cap: ny !== 0, top: ny > 0, uvs, cols, y: layer.positions[v * 3 + 1], x: layer.positions[v * 3], z: layer.positions[v * 3 + 2] });
    v += n;
  }
  return out;
}

/** Which of `rects` holds every uv of the face (-1: none). */
function rectOf(uvs, rects) {
  return rects.findIndex(([u0, v0, u1, v1]) => uvs.every(([u, v]) => u >= u0 - 1e-6 && u <= u1 + 1e-6 && v >= v0 - 1e-6 && v <= v1 + 1e-6));
}

describe('mesher — per-cell variation (§90)', () => {
  it('is on by default and can be switched off', () => {
    expect(cellVariationEnabled()).toBe(true);
    setCellVariation(false);
    expect(cellVariationEnabled()).toBe(false);
    setCellVariation(true);
  });

  it('a stone floor uses every picture of stone, each face wholly inside one picture', () => {
    const m = buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.STONE)));
    const rects = tileVariants(TILE.STONE).slots.map((s) => tileToUV(s));
    const used = new Set();
    for (const f of faces(m.opaque)) {
      const k = rectOf(f.uvs, rects);
      expect(k).toBeGreaterThanOrEqual(0);
      used.add(k);
    }
    expect(used.size).toBe(rects.length);
  });

  it('caps are the inscribed hexagon, mirrored and flipped in all four ways across a floor', () => {
    const m = buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.STONE)));
    const kinds = new Set();
    for (const f of faces(m.opaque)) {
      if (!f.top) continue;
      const [cu, cv] = f.uvs[0]; // the centre vertex: the middle of its picture
      const rect = tileToUV(tileVariants(TILE.STONE).slots[rectOf(f.uvs, tileVariants(TILE.STONE).slots.map((s) => tileToUV(s)))]);
      expect(cu).toBeCloseTo((rect[0] + rect[2]) / 2, 6);
      expect(cv).toBeCloseTo((rect[1] + rect[3]) / 2, 6);
      // corner 1 of the fan: which quadrant of the picture it lands in tells the mirror and the flip
      const [u1, v1] = f.uvs[1];
      kinds.add(`${Math.sign(u1 - cu)},${Math.sign(v1 - cv)}`);
    }
    expect(kinds.size).toBe(4);
  });

  it('sides keep the HEX_SIZE-wide window, slid at most a few pixels and sometimes mirrored, never out of the picture', () => {
    const m = buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.STONE)));
    const rects = tileVariants(TILE.STONE).slots.map((s) => tileToUV(s));
    let mirrored = 0;
    let slid = 0;
    let sides = 0;
    for (const f of faces(m.opaque)) {
      if (f.cap) continue;
      sides++;
      const rect = rects[rectOf(f.uvs, rects)];
      const w = rect[2] - rect[0];
      // vertices 0 and 3 are the face's left edge seen from outside, 1 and 2 its right edge
      const left = f.uvs[0][0];
      const right = f.uvs[1][0];
      expect(Math.abs(right - left)).toBeCloseTo(w * HEX_SIZE, 6);
      if (right < left) mirrored++;
      const mid = (left + right) / 2;
      const off = ((mid - (rect[0] + rect[2]) / 2) / w) * ATLAS_SLOT_PX;
      expect(Math.abs(off - Math.round(off))).toBeLessThan(1e-3);
      expect(Math.abs(off)).toBeLessThanOrEqual(6);
      if (Math.round(off) !== 0) slid++;
    }
    expect(mirrored / sides).toBeGreaterThan(0.3);
    expect(mirrored / sides).toBeLessThan(0.7);
    expect(slid / sides).toBeGreaterThan(0.7);
  });

  it('the cell brightness rolls within ± BLOCK_JITTER and colours stay in (0, 1]', () => {
    setCellVariation(false);
    const plain = faces(buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.STONE))).opaque);
    setCellVariation(true);
    const varied = faces(buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.STONE))).opaque);
    expect(varied.length).toBe(plain.length);
    const amp = BLOCK_JITTER[B.STONE];
    const ratios = new Set();
    for (let i = 0; i < plain.length; i++) {
      for (let k = 0; k < plain[i].cols.length; k++) {
        for (let c = 0; c < 3; c++) {
          const v = varied[i].cols[k][c];
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(1);
          const ratio = v / plain[i].cols[k][c];
          expect(ratio).toBeGreaterThanOrEqual(1 - amp - 1e-6);
          expect(ratio).toBeLessThanOrEqual(1 + amp + 1e-6);
          if (!plain[i].cap) ratios.add(Math.round(ratio * 1000));
        }
      }
    }
    expect(ratios.size).toBeGreaterThan(10);
  });

  it('a block keeps its look: the same cell meshes the same, whatever else is in the chunk', () => {
    const lone = new Map();
    setWorldBlock(lone, 6, 10, 6, B.DIRT);
    const crowd = floor(B.DIRT);
    const pick = (m) => faces(m.opaque).filter((f) => f.top)
      .find((f) => Math.abs(f.y - 11) < 1e-6 && Math.abs(f.x - (6 + 6 * 0.5)) < 1e-6 && Math.abs(f.z - 6 * HEX_ROW_SPACING) < 1e-6);
    const a = pick(buildChunkMesh(0, 0, makeChunkDataGetter(lone)));
    const b = pick(buildChunkMesh(0, 0, makeChunkDataGetter(crowd)));
    expect(a.uvs).toEqual(b.uvs);
    expect(a.cols).toEqual(b.cols);
  });

  it('neighbouring chunks get different looks for the same local cell (the hash is of the WORLD cell)', () => {
    const chunks = new Map();
    setWorldBlock(chunks, 3, 10, 3, B.STONE);
    setWorldBlock(chunks, 3 + CHUNK_SIZE, 10, 3, B.STONE);
    setWorldBlock(chunks, 3 + 2 * CHUNK_SIZE, 10, 3, B.STONE);
    const looks = [0, 1, 2].map((cq) => JSON.stringify(faces(buildChunkMesh(cq, 0, makeChunkDataGetter(chunks)).opaque).map((f) => f.uvs)));
    expect(new Set(looks).size).toBeGreaterThan(1);
  });

  it('water, glass and a device never vary: their UVs are the tile\'s own', () => {
    for (const id of [B.WATER, B.GLASS, B.KILN]) {
      const m = buildChunkMesh(0, 0, makeChunkDataGetter(floor(id, 4)));
      for (const layer of [m.opaque, m.cutout, m.translucent]) {
        for (const f of faces(layer)) {
          const face = f.cap ? (f.top ? FACE_TOP : FACE_BOTTOM) : 0;
          const tile = getFaceTile(id, face);
          expect(rectOf(f.uvs, [tileToUV(tile)]), `${id}`).toBe(0);
        }
      }
    }
  });

  it('switched off, every face shows its tile\'s first picture at its exact colour', () => {
    setCellVariation(false);
    const m = buildChunkMesh(0, 0, makeChunkDataGetter(floor(B.GRASS_BLOCK)));
    setCellVariation(true);
    for (const f of faces(m.opaque)) {
      const face = f.cap ? (f.top ? FACE_TOP : FACE_BOTTOM) : 0;
      expect(rectOf(f.uvs, [tileToUV(getFaceTile(B.GRASS_BLOCK, face))])).toBe(0);
    }
  });
});

describe('atlas — the pictures and their mipmaps (§90)', () => {
  const pixels = createAtlasPixels();

  it('is ATLAS_SIZE_PX square with every tile and every extra picture in its slot', () => {
    expect(pixels.length).toBe(ATLAS_SIZE_PX * ATLAS_SIZE_PX * 4);
    const slotPixels = (slot) => {
      const [sx, sy] = tileOrigin(slot);
      const out = new Uint8ClampedArray(ATLAS_SLOT_PX * ATLAS_SLOT_PX * 4);
      for (let y = 0; y < ATLAS_SLOT_PX; y++) {
        out.set(pixels.subarray(((sy + y) * ATLAS_SIZE_PX + sx) * 4, ((sy + y) * ATLAS_SIZE_PX + sx + ATLAS_SLOT_PX) * 4), y * ATLAS_SLOT_PX * 4);
      }
      return out;
    };
    expect(slotPixels(TILE.STONE)).toEqual(paintTileHD(TILE.STONE, 0));
    const stone = tileVariants(TILE.STONE);
    for (let k = 1; k < stone.count; k++) expect(slotPixels(stone.slots[k])).toEqual(paintTileHD(TILE.STONE, k));
    expect(slotPixels(TILE.KILN_SIDE)).toEqual(paintSlot(TILE.KILN_SIDE, 0));
    expect(tileToUV(stone.slots[1])[2] - tileToUV(stone.slots[1])[0]).toBeCloseTo(TILE_UV, 3);
  });

  it('mip levels halve down to one texel per slot, and a slot never takes colour from its neighbour', () => {
    const mips = buildAtlasMips(pixels);
    expect(mips).toHaveLength(ATLAS_MIP_LEVELS);
    expect(mips.map((m) => m.width)).toEqual(Array.from({ length: ATLAS_MIP_LEVELS }, (_, l) => ATLAS_SIZE_PX >> l));
    expect(mips[ATLAS_MIP_LEVELS - 1].width).toBe(ATLAS_SIZE_PX / ATLAS_SLOT_PX);
    // Repaint one slot and rebuild: only that slot's texels change, at every level.
    const changed = pixels.slice();
    const [sx, sy] = tileOrigin(TILE.STONE);
    for (let y = 0; y < ATLAS_SLOT_PX; y++) for (let x = 0; x < ATLAS_SLOT_PX; x++) changed.set([255, 0, 255, 255], ((sy + y) * ATLAS_SIZE_PX + sx + x) * 4);
    const mips2 = buildAtlasMips(changed);
    const leaks = [];
    for (let l = 1; l < ATLAS_MIP_LEVELS; l++) {
      const w = mips[l].width;
      const per = ATLAS_SLOT_PX >> l;
      const A = mips[l].data;
      const C = mips2[l].data;
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          const inStone = x >= sx >> l && x < (sx >> l) + per && y >= sy >> l && y < (sy >> l) + per;
          const o = (y * w + x) * 4;
          const ok = inStone
            ? C[o] === 255 && C[o + 1] === 0 && C[o + 2] === 255 && C[o + 3] === 255
            : A[o] === C[o] && A[o + 1] === C[o + 1] && A[o + 2] === C[o + 2] && A[o + 3] === C[o + 3];
          if (!ok && leaks.length < 5) leaks.push(`level ${l} texel ${x},${y}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('far away a leaf canopy stays solid and keeps its leaf colour (alpha is the most opaque child)', () => {
    const mips = buildAtlasMips(pixels);
    const top = mips[ATLAS_MIP_LEVELS - 1];
    const w = top.width;
    const at = (slot) => {
      const [sx, sy] = tileOrigin(slot);
      const o = ((sy / ATLAS_SLOT_PX) * w + sx / ATLAS_SLOT_PX) * 4;
      return [...top.data.subarray(o, o + 4)];
    };
    const leaf = at(TILE.OAK_LEAVES);
    expect(leaf[3]).toBe(255);
    expect(leaf[1]).toBeGreaterThan(leaf[0]);
    expect(at(TILE.WATER)[3]).toBe(178);
    expect(at(TILE.PLANT_TOP_CLEAR)[3]).toBe(0);
  });
});
