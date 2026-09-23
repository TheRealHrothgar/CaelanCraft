import { describe, it, expect } from 'vitest';
import * as C from '../../src/config.js';
import {
  floorDiv, mod, worldToChunk, worldToLocal, chunkKey, parseChunkKey, localIndex, indexToLocal, columnIndex,
  FACE_NORMALS, FACE_VERTS, FACE_TANGENTS, FACE_AXIS, FACE_OPPOSITE, yawToForward, yawToRight, lookDirection,
} from '../../src/coords.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, DEFAULT_HOTBAR, PICKER_ORDER, getFaceTile, isSolid, isOpaque, isLiquid,
  isReplaceable, isTargetable, isPlaceable, isBreakable, shouldRenderFace, tileToUV, LAYER_CUTOUT, LAYER_TRANSLUCENT, LAYER_OPAQUE,
} from '../../src/blocks.js';
import { Chunk } from '../../src/chunk.js';

describe('config', () => {
  it('has consistent world constants', () => {
    expect(C.CHUNK_SIZE).toBe(16);
    expect(C.WORLD_HEIGHT).toBe(128);
    expect(C.CHUNK_VOLUME).toBe(16 * 16 * 128);
    expect(C.SEA_LEVEL).toBeLessThan(C.WORLD_HEIGHT - 20);
    expect(C.MAX_TERRAIN_HEIGHT).toBeLessThan(C.WORLD_HEIGHT);
  });
  it('has a sane jump height and physics knobs', () => {
    const h = (C.JUMP_VELOCITY ** 2) / (2 * -C.GRAVITY);
    expect(h).toBeGreaterThanOrEqual(1.2);
    expect(h).toBeLessThanOrEqual(1.6);
    expect(C.EYE_HEIGHT).toBeLessThan(C.PLAYER_HEIGHT);
    expect(C.MAX_FRAME_DT).toBeLessThanOrEqual(0.1);
    expect(C.REACH).toBeGreaterThanOrEqual(4);
  });
});

describe('coords', () => {
  it('floor-divides and mods negatives', () => {
    expect(floorDiv(-1, 16)).toBe(-1);
    expect(mod(-1, 16)).toBe(15);
    expect(worldToChunk(-1)).toBe(-1);
    expect(worldToChunk(-17)).toBe(-2);
    expect(worldToLocal(-1)).toBe(15);
    expect(worldToLocal(-17)).toBe(15);
    expect(worldToChunk(16)).toBe(1);
    expect(worldToLocal(16)).toBe(0);
  });
  it('round-trips chunk keys', () => {
    expect(chunkKey(-3, 7)).toBe('-3,7');
    expect(parseChunkKey('-3,7')).toEqual([-3, 7]);
  });
  it('localIndex is a bijection with the documented strides', () => {
    expect(localIndex(0, 1, 0)).toBe(1);
    expect(localIndex(0, 0, 1)).toBe(128);
    expect(localIndex(1, 0, 0)).toBe(16 * 128);
    const seen = new Uint8Array(C.CHUNK_VOLUME);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let ly = 0; ly < 128; ly++) {
      const i = localIndex(lx, ly, lz);
      expect(seen[i]).toBe(0);
      seen[i] = 1;
      expect(indexToLocal(i)).toEqual([lx, ly, lz]);
    }
    expect(columnIndex(3, 5)).toBe(3 * 16 + 5);
  });
  it('face vertex windings are CCW from outside and match normals', () => {
    for (let f = 0; f < 6; f++) {
      const [a, b, c] = FACE_VERTS[f];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]].map((v) => v + 0);
      expect(cross).toEqual(FACE_NORMALS[f]);
      // all 4 verts lie on the face plane
      const axis = FACE_AXIS[f];
      const planeVal = FACE_NORMALS[f][axis] > 0 ? 1 : 0;
      for (const v of FACE_VERTS[f]) expect(v[axis]).toBe(planeVal);
      expect(FACE_TANGENTS[f]).not.toContain(axis);
      expect(FACE_AXIS[FACE_OPPOSITE[f]]).toBe(axis);
    }
  });
  it('orientation conventions: yaw 0 faces -Z, positive yaw turns left', () => {
    const [fx, fz] = yawToForward(0);
    expect(fx).toBeCloseTo(0);
    expect(fz).toBeCloseTo(-1);
    const [rx, rz] = yawToRight(0);
    expect(rx).toBeCloseTo(1);
    expect(rz).toBeCloseTo(0);
    const [lx] = yawToForward(Math.PI / 2);
    expect(lx).toBeCloseTo(-1);
    const d = lookDirection(0, Math.PI / 2);
    expect(d[1]).toBeCloseTo(1);
  });
});

describe('blocks', () => {
  it('ids are contiguous and names unique', () => {
    expect(BLOCKS.length).toBe(BLOCK_COUNT);
    const names = new Set();
    BLOCKS.forEach((b, i) => {
      expect(b.id).toBe(i);
      expect(names.has(b.name)).toBe(false);
      names.add(b.name);
      expect(BLOCK[b.name.toUpperCase()]).toBe(i);
      expect(b.tiles).toHaveLength(6);
    });
  });
  it('every non-air block resolves 6 valid tiles', () => {
    const tileSet = new Set(TILE_IDS);
    for (let id = 1; id < BLOCK_COUNT; id++) {
      for (let f = 0; f < 6; f++) {
        const t = getFaceTile(id, f);
        expect(tileSet.has(t)).toBe(true);
        expect(t).not.toBe(TILE.MISSING);
      }
    }
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 2)).toBe(TILE.GRASS_TOP);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 3)).toBe(TILE.DIRT);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 0)).toBe(TILE.GRASS_SIDE);
  });
  it('flags are consistent', () => {
    for (const b of BLOCKS) {
      if (b.opaque) expect(b.solid).toBe(true);
      if (b.liquid) expect(b.solid).toBe(false);
    }
    expect(isSolid(BLOCK.WATER)).toBe(false);
    expect(isLiquid(BLOCK.WATER)).toBe(true);
    expect(isOpaque(BLOCK.GLASS)).toBe(false);
    expect(isSolid(BLOCK.GLASS)).toBe(true);
    expect(isOpaque(BLOCK.OAK_LEAVES)).toBe(false);
    expect(BLOCKS[BLOCK.OAK_LEAVES].cullSame).toBe(false);
    expect(BLOCKS[BLOCK.OAK_LEAVES].layer).toBe(LAYER_CUTOUT);
    expect(BLOCKS[BLOCK.GLASS].layer).toBe(LAYER_CUTOUT);
    expect(BLOCKS[BLOCK.WATER].layer).toBe(LAYER_TRANSLUCENT);
    expect(BLOCKS[BLOCK.STONE].layer).toBe(LAYER_OPAQUE);
    expect(isBreakable(BLOCK.BEDROCK)).toBe(false);
    expect(isPlaceable(BLOCK.BEDROCK)).toBe(false);
    expect(isPlaceable(BLOCK.WATER)).toBe(true);
    expect(isReplaceable(BLOCK.WATER)).toBe(true);
    expect(isReplaceable(BLOCK.AIR)).toBe(true);
    expect(isReplaceable(BLOCK.STONE)).toBe(false);
    expect(isTargetable(BLOCK.WATER)).toBe(false);
    expect(isTargetable(BLOCK.STONE)).toBe(true);
  });
  it('hotbar and picker contain unique placeable ids', () => {
    expect(DEFAULT_HOTBAR).toHaveLength(9);
    expect(new Set(DEFAULT_HOTBAR).size).toBe(9);
    for (const id of DEFAULT_HOTBAR) expect(isPlaceable(id)).toBe(true);
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
  });
  it('culling rule', () => {
    const { AIR, STONE, WATER, GLASS, OAK_LEAVES } = BLOCK;
    expect(shouldRenderFace(AIR, STONE)).toBe(false);
    expect(shouldRenderFace(STONE, AIR)).toBe(true);
    expect(shouldRenderFace(STONE, STONE)).toBe(false);
    expect(shouldRenderFace(STONE, WATER)).toBe(true);
    expect(shouldRenderFace(STONE, GLASS)).toBe(true);
    expect(shouldRenderFace(WATER, WATER)).toBe(false);
    expect(shouldRenderFace(WATER, AIR)).toBe(true);
    expect(shouldRenderFace(WATER, STONE)).toBe(false);
    expect(shouldRenderFace(GLASS, GLASS)).toBe(false);
    expect(shouldRenderFace(OAK_LEAVES, OAK_LEAVES)).toBe(true);
    expect(shouldRenderFace(WATER, GLASS)).toBe(true);
  });
  it('tileToUV rectangles are inside [0,1], inset, and non-overlapping', () => {
    const [u0, v0, u1, v1] = tileToUV(TILE.STONE);
    expect(u0).toBeCloseTo(C.UV_INSET, 10);
    expect(v0).toBeCloseTo(C.UV_INSET, 10);
    expect(u1).toBeCloseTo(C.TILE_UV - C.UV_INSET, 10);
    expect(v1).toBeCloseTo(C.TILE_UV - C.UV_INSET, 10);
    const [a0, b0, a1, b1] = tileToUV(TILE.DIRT); // tile 1: next column, same row
    expect(a0).toBeGreaterThan(u1);
    expect(b0).toBe(v0);
    expect(a1).toBeLessThanOrEqual(1);
    expect(b1).toBeLessThanOrEqual(1);
    const [m0, n0, m1, n1] = tileToUV(TILE.MISSING); // tile 255: bottom-right
    expect(m1).toBeLessThanOrEqual(1);
    expect(n1).toBeLessThanOrEqual(1);
    expect(m0).toBeGreaterThan(0.9);
    expect(n0).toBeGreaterThan(0.9);
  });
});

describe('chunk', () => {
  it('get/set round trip with dirty flag and range checks', () => {
    const c = new Chunk(-1, 2);
    expect(c.key).toBe('-1,2');
    expect(c.dirty).toBe(true);
    c.dirty = false;
    expect(c.set(3, 7, 11, 5)).toBe(true);
    expect(c.dirty).toBe(true);
    expect(c.get(3, 7, 11)).toBe(5);
    expect(c.set(3, 7, 11, 5)).toBe(false);
    expect(c.get(16, 0, 0)).toBe(0);
    expect(c.get(0, 128, 0)).toBe(0);
    expect(c.get(0, -1, 0)).toBe(0);
    expect(c.set(16, 0, 0, 1)).toBe(false);
    expect(c.blocks).toBeInstanceOf(Uint8Array);
    expect(c.blocks.length).toBe(C.CHUNK_VOLUME);
    expect(c.biomes.length).toBe(C.CHUNK_AREA);
    let nonzero = 0;
    for (const v of c.blocks) if (v) nonzero++;
    expect(nonzero).toBe(1);
  });
});
