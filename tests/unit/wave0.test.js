import { describe, it, expect } from 'vitest';
import * as C from '../../src/config.js';
import * as coords from '../../src/coords.js';
import {
  floorDiv, mod, worldToChunk, worldToLocal, chunkKey, parseChunkKey, localIndex, indexToLocal, columnIndex,
  inHeightRange, yawToForward, yawToRight, lookDirection,
} from '../../src/coords.js';
import { FACE_TOP as HEX_FACE_TOP, FACE_BOTTOM as HEX_FACE_BOTTOM, FACE_COUNT, HEX_INRADIUS, HEX_SIZE } from '../../src/hex.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, DEFAULT_HOTBAR, PICKER_ORDER, getFaceTile, isSolid, isOpaque, isLiquid,
  isReplaceable, isTargetable, isPlaceable, isBreakable, shouldRenderFace, tileToUV, LAYER_CUTOUT, LAYER_TRANSLUCENT, LAYER_OPAQUE,
  SOUND_GROUPS,
  FACE_TOP, FACE_BOTTOM,
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
    // The collider samples only the player's cell and its six neighbours, which is only sufficient while
    // the footprint radius is smaller than a cell's inradius.
    // The player must fit through the HEX_SIZE-wide throat of a 1-cell passage (which also implies the 7-column bound).
    expect(C.PLAYER_WIDTH / 2).toBeLessThan(HEX_SIZE / 2);
    expect(C.PLAYER_WIDTH / 2).toBeLessThan(HEX_INRADIUS);
  });
  it('hex render tunables are in range', () => {
    expect(C.TOP_UV_SCALE).toBeCloseTo(Math.sqrt(3) / 2, 12);
    // Negative: the fog must end before the nearest possibly-unmeshed cell, which is (rd − 1) rings away because the
    // mesh disc is keyed by chunk origin cells (see renderer.fogRangeForRenderDistance). Never below -1.
    expect(C.FOG_FAR_CHUNK_MARGIN).toBeGreaterThanOrEqual(-1);
    expect(C.FOG_FAR_CHUNK_MARGIN).toBeLessThan(1);
    expect(C.AO_CURVE).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(C.AO_CURVE[i]).toBeGreaterThan(C.AO_CURVE[i - 1]);
    expect(C.AO_CURVE[3]).toBe(1);
    expect(C.VERSION).toBe('0.2.0');
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
    expect(parseChunkKey('0,0')).toEqual([0, 0]);
    expect(parseChunkKey(chunkKey(-0, 12))).toEqual([0, 12]);
    // Strict inverse: anything chunkKey could not have produced is [NaN, NaN], never a silent (0, 0).
    for (const bad of ['', '0', ',', ' , ', '3,', ',1', ' 1,2', '1,2 ', '1,2,3', '1.5,2', '1e3,2', '0x10,2', '+1,2', 'a,b', '--1,2', '1,-']) {
      const [cq, cr] = parseChunkKey(bad);
      expect(Number.isNaN(cq), bad).toBe(true);
      expect(Number.isNaN(cr), bad).toBe(true);
    }
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
  it('no longer carries the cube face tables (they live in hex.js)', () => {
    for (const name of ['FACE_NORMALS', 'FACE_VERTS', 'FACE_TANGENTS', 'FACE_AXIS', 'FACE_OPPOSITE', 'FACE_NAMES']) {
      expect(coords[name], name).toBeUndefined();
    }
  });
  it('inHeightRange covers exactly 0..WORLD_HEIGHT-1', () => {
    expect(inHeightRange(0)).toBe(true);
    expect(inHeightRange(C.WORLD_HEIGHT - 1)).toBe(true);
    expect(inHeightRange(-1)).toBe(false);
    expect(inHeightRange(C.WORLD_HEIGHT)).toBe(false);
    expect(inHeightRange(NaN)).toBe(false);
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
      expect(b.tiles).toHaveLength(FACE_COUNT);
    });
  });
  it('re-exports the hex top/bottom face indices', () => {
    expect(FACE_TOP).toBe(HEX_FACE_TOP);
    expect(FACE_BOTTOM).toBe(HEX_FACE_BOTTOM);
    expect(FACE_TOP).toBe(6);
    expect(FACE_BOTTOM).toBe(7);
  });
  it('every non-air block resolves 8 valid tiles: six identical sides, a top and a bottom', () => {
    const tileSet = new Set(TILE_IDS);
    for (let id = 1; id < BLOCK_COUNT; id++) {
      for (let f = 0; f < FACE_COUNT; f++) {
        const t = getFaceTile(id, f);
        expect(tileSet.has(t)).toBe(true);
        expect(t).not.toBe(TILE.MISSING);
      }
      for (let f = 1; f < 6; f++) expect(getFaceTile(id, f)).toBe(getFaceTile(id, 0));
    }
    expect(getFaceTile(BLOCK.GRASS_BLOCK, FACE_TOP)).toBe(TILE.GRASS_TOP);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, FACE_BOTTOM)).toBe(TILE.DIRT);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 0)).toBe(TILE.GRASS_SIDE);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 5)).toBe(TILE.GRASS_SIDE);
    expect(getFaceTile(BLOCK.OAK_LOG, FACE_TOP)).toBe(TILE.OAK_LOG_END);
    expect(getFaceTile(BLOCK.OAK_LOG, FACE_BOTTOM)).toBe(TILE.OAK_LOG_END);
    expect(getFaceTile(BLOCK.OAK_LOG, 3)).toBe(TILE.OAK_LOG_SIDE);
    expect(getFaceTile(BLOCK.SNOWY_GRASS, FACE_TOP)).toBe(TILE.SNOW);
    expect(getFaceTile(BLOCK.SNOWY_GRASS, FACE_BOTTOM)).toBe(TILE.DIRT);
    // Out-of-range faces and unknown ids fall back to MISSING / AIR.
    expect(getFaceTile(BLOCK.STONE, 8)).toBe(TILE.MISSING);
    expect(getFaceTile(200, 0)).toBe(TILE.MISSING);
  });
  it('RUNE_BLOCK (25) is a solid, opaque, placeable, breakable stone-sounding block with the RUNE tile on all 8 faces', () => {
    expect(BLOCK.RUNE_BLOCK).toBe(25);
    expect(TILE.RUNE).toBe(27);
    expect(TILE_IDS).toContain(TILE.RUNE);
    const def = BLOCKS[BLOCK.RUNE_BLOCK];
    expect(def.name).toBe('rune_block');
    expect(def.displayName).toBe('Rune Block');
    expect(def.solid).toBe(true);
    expect(def.opaque).toBe(true);
    expect(def.liquid).toBe(false);
    expect(isSolid(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isOpaque(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isPlaceable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isBreakable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isTargetable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isReplaceable(BLOCK.RUNE_BLOCK)).toBe(false);
    expect(def.layer).toBe(LAYER_OPAQUE);
    expect(def.soundGroup).toBe('stone');
    for (let f = 0; f < FACE_COUNT; f++) expect(getFaceTile(BLOCK.RUNE_BLOCK, f)).toBe(TILE.RUNE);
    // Picker: the rune block listed right before water, which is last.
    const iRune = PICKER_ORDER.indexOf(BLOCK.RUNE_BLOCK);
    expect(iRune).toBeGreaterThanOrEqual(0);
    expect(PICKER_ORDER[iRune + 1]).toBe(BLOCK.WATER);
    expect(PICKER_ORDER[PICKER_ORDER.length - 1]).toBe(BLOCK.WATER);
    // Not in the default hotbar.
    expect(DEFAULT_HOTBAR).not.toContain(BLOCK.RUNE_BLOCK);
  });
  it('v0.4 batch: 40 blocks appended after RUNE_BLOCK (v2 save ids unchanged), every placeable block in the picker once', () => {
    expect(BLOCK_COUNT).toBe(66);
    expect(TILE_IDS).toHaveLength(73);
    expect(BLOCK.STONE).toBe(1);
    expect(BLOCK.WOOL_RED).toBe(24);
    expect(BLOCK.SPRUCE_LOG).toBe(26);
    expect(BLOCK.WOOL_LIGHT_GRAY).toBe(65);
    expect(TILE.SPRUCE_LOG_SIDE).toBe(28);
    expect(TILE.WOOL_LIGHT_GRAY).toBe(71);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect(PICKER_ORDER).toHaveLength(64);
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
    // Logs and hay bales: distinct end tiles on top and bottom.
    expect(getFaceTile(BLOCK.SPRUCE_LOG, FACE_TOP)).toBe(TILE.SPRUCE_LOG_END);
    expect(getFaceTile(BLOCK.BIRCH_LOG, FACE_BOTTOM)).toBe(TILE.BIRCH_LOG_END);
    expect(getFaceTile(BLOCK.HAY_BALE, 0)).toBe(TILE.HAY_BALE_SIDE);
    expect(getFaceTile(BLOCK.PUMPKIN, FACE_TOP)).toBe(TILE.PUMPKIN_TOP);
    // Leaves are cutout like oak; ice is a solid, see-through, translucent block that culls against itself.
    for (const id of [BLOCK.SPRUCE_LEAVES, BLOCK.BIRCH_LEAVES]) {
      expect(BLOCKS[id].layer).toBe(LAYER_CUTOUT);
      expect(BLOCKS[id].cullSame).toBe(false);
      expect(isOpaque(id)).toBe(false);
    }
    expect(isSolid(BLOCK.ICE)).toBe(true);
    expect(isOpaque(BLOCK.ICE)).toBe(false);
    expect(BLOCKS[BLOCK.ICE].layer).toBe(LAYER_TRANSLUCENT);
    expect(shouldRenderFace(BLOCK.ICE, BLOCK.ICE)).toBe(false);
    expect(shouldRenderFace(BLOCK.STONE, BLOCK.ICE)).toBe(true);
    expect(isOpaque(BLOCK.PACKED_ICE)).toBe(true);
    // Every new block is a normal solid, breakable, placeable block with a known sound group.
    for (let id = BLOCK.SPRUCE_LOG; id < BLOCK_COUNT; id++) {
      const d = BLOCKS[id];
      expect(d.solid && d.breakable && d.placeable && !d.liquid, d.name).toBe(true);
      expect(SOUND_GROUPS).toContain(d.soundGroup);
    }
    expect(BLOCKS[BLOCK.WOOL_LIGHT_BLUE].displayName).toBe('Light Blue Wool');
    expect(DEFAULT_HOTBAR.every((id) => id < BLOCK.RUNE_BLOCK)).toBe(true);
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
  it('stores its (cq, cr) coordinates and key', () => {
    const c = new Chunk(-3, 7);
    expect(c.cq).toBe(-3);
    expect(c.cr).toBe(7);
    expect(c.key).toBe(chunkKey(-3, 7));
    expect(c.meshed).toBe(false);
    expect(c.heights.length).toBe(C.CHUNK_AREA);
  });
  it('adopts the ChunkData arrays it is given (no copy)', () => {
    const data = {
      blocks: new Uint8Array(C.CHUNK_VOLUME),
      biomes: new Uint8Array(C.CHUNK_AREA),
      heights: new Uint8Array(C.CHUNK_AREA),
    };
    data.blocks[localIndex(2, 3, 4)] = 9;
    const c = new Chunk(0, 0, data);
    expect(c.blocks).toBe(data.blocks);
    expect(c.biomes).toBe(data.biomes);
    expect(c.heights).toBe(data.heights);
    expect(c.get(2, 3, 4)).toBe(9);
  });
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
