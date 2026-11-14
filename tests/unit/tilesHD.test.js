// Tests for src/tilesHD.js and src/tileVariants.js — the 32-px pictures and their variants (CONTRACTS §90).
import { describe, it, expect } from 'vitest';
import { paintTileHD, upscale16, averageColorHD, HD_TILES, HD_PX, hasHDTile } from '../../src/tilesHD.js';
import {
  VARIANT_TILES, tileVariants, variantCount, variantSlot, variantMode, extraSlots, variantHash, BLOCK_JITTER, LEAFY,
  FIRST_EXTRA_SLOT, ATLAS_SLOTS, MAX_VARIANTS, USED_SLOTS, VARY_CAP, VARY_MIRROR, VARY_SHIFT,
} from '../../src/tileVariants.js';
import { paintTile, averageColor, TILE_NAMES } from '../../src/tiles.js';
import { TILE, BLOCK, BLOCKS, getFaceTile } from '../../src/blocks.js';
import { ATLAS_TILES_PER_ROW } from '../../src/config.js';
import { FACE_COUNT } from '../../src/hex.js';

const BYTES = HD_PX * HD_PX * 4;

/** Every (tile, picture) pair tilesHD paints. */
const PICTURES = HD_TILES.flatMap((t) => Array.from({ length: variantCount(t) }, (_, v) => [t, v]));

function alphaCounts(px) {
  const counts = new Map();
  for (let i = 3; i < px.length; i += 4) counts.set(px[i], (counts.get(px[i]) ?? 0) + 1);
  return counts;
}

describe('tileVariants — the table', () => {
  it('every varied tile is a real tile with 1..MAX_VARIANTS pictures, and tilesHD paints exactly those tiles', () => {
    for (const t of VARIANT_TILES) {
      expect(TILE_NAMES[t], `tile ${t}`).toBeTypeOf('string');
      const v = tileVariants(t);
      expect(v.count).toBeGreaterThanOrEqual(1);
      expect(v.count).toBeLessThanOrEqual(MAX_VARIANTS);
      expect(v.slots[0]).toBe(t);
    }
    expect([...HD_TILES].sort((a, b) => a - b)).toEqual([...VARIANT_TILES].sort((a, b) => a - b));
  });

  it('extra slots are unique, start at FIRST_EXTRA_SLOT and fit the atlas', () => {
    const extras = extraSlots();
    const slots = extras.map((e) => e[0]);
    expect(new Set(slots).size).toBe(slots.length);
    expect(Math.min(...slots)).toBe(FIRST_EXTRA_SLOT);
    expect(Math.max(...slots)).toBeLessThan(ATLAS_SLOTS);
    expect(USED_SLOTS).toBe(Math.max(...slots) + 1);
    expect(ATLAS_SLOTS).toBe(ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW);
    // consecutive: the extra slots are packed
    expect(slots).toEqual(Array.from({ length: slots.length }, (_, i) => FIRST_EXTRA_SLOT + i));
    for (const [slot, tile, k] of extras) expect(variantSlot(tile, k)).toBe(slot);
  });

  it('variantSlot wraps the picture index; a tile without variants is its own slot with mode 0', () => {
    expect(variantSlot(TILE.STONE, 0)).toBe(TILE.STONE);
    expect(variantSlot(TILE.STONE, 4)).toBe(TILE.STONE);
    expect(variantSlot(TILE.STONE, -1)).toBe(variantSlot(TILE.STONE, 3));
    expect(variantCount(TILE.KILN_SIDE)).toBe(1);
    expect(variantSlot(TILE.KILN_SIDE, 2)).toBe(TILE.KILN_SIDE);
    expect(variantMode(TILE.KILN_SIDE)).toBe(0);
  });

  it('water, glass and the metal blocks never vary; grass and stone do', () => {
    for (const t of [TILE.WATER, TILE.TAINTED_WATER, TILE.GLASS, TILE.IRON_BLOCK, TILE.GOLD_BLOCK]) {
      expect(variantCount(t)).toBe(1);
      expect(variantMode(t)).toBe(0);
    }
    expect(variantMode(TILE.STONE)).toBe(VARY_CAP | VARY_MIRROR | VARY_SHIFT);
    // a side that hangs from its top edge is never flipped top to bottom (sides cannot be anyway: only caps flip)
    expect(variantMode(TILE.GRASS_SIDE) & VARY_CAP).toBe(0);
    expect(variantCount(TILE.GRASS_TOP)).toBeGreaterThan(1);
  });

  it('BLOCK_JITTER is small, and zero for water, glass, metal and every device', () => {
    for (let id = 0; id < 256; id++) {
      expect(BLOCK_JITTER[id]).toBeGreaterThanOrEqual(0);
      expect(BLOCK_JITTER[id]).toBeLessThanOrEqual(0.06 + 1e-6);
    }
    for (const id of [BLOCK.WATER, BLOCK.GLASS, BLOCK.IRON_BLOCK, BLOCK.GOLD_BLOCK, BLOCK.TORCH, BLOCK.FILAMENT_LAMP, BLOCK.KILN]) {
      expect(BLOCK_JITTER[id]).toBe(0);
    }
    expect(BLOCK_JITTER[BLOCK.STONE]).toBeGreaterThan(0);
    expect([...LEAFY].reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('variantHash is deterministic, depends on every input and spreads evenly', () => {
    expect(variantHash(3, 40, -7, 2)).toBe(variantHash(3, 40, -7, 2));
    const base = variantHash(3, 40, -7, 2);
    for (const other of [variantHash(4, 40, -7, 2), variantHash(3, 41, -7, 2), variantHash(3, 40, -6, 2), variantHash(3, 40, -7, 3)]) {
      expect(other).not.toBe(base);
    }
    const bins = [0, 0, 0, 0];
    for (let q = -20; q < 20; q++) for (let r = -20; r < 20; r++) bins[variantHash(q, 64, r, 7) % 4]++;
    for (const b of bins) expect(b / 1600).toBeGreaterThan(0.2);
  });
});

describe('tilesHD — pictures', () => {
  it('paints a 32×32 RGBA picture for every picture of every varied tile, deterministically', () => {
    const bad = [];
    for (const [t, v] of PICTURES) {
      const a = paintTileHD(t, v);
      const b = paintTileHD(t, v);
      if (!(a instanceof Uint8ClampedArray) || a.length !== BYTES || !Buffer.from(a).equals(Buffer.from(b))) bad.push(`${TILE_NAMES[t]}#${v}`);
    }
    expect(bad).toEqual([]);
  });

  it('the pictures of one tile all differ (a field of one block never repeats one stamp)', () => {
    for (const t of HD_TILES) {
      const n = variantCount(t);
      const seen = new Set();
      for (let v = 0; v < n; v++) seen.add(Buffer.from(paintTileHD(t, v)).toString('base64'));
      expect(seen.size, TILE_NAMES[t]).toBe(n);
    }
  });

  it('returns null for a tile it does not paint (the atlas doubles the 16-px tile instead)', () => {
    expect(hasHDTile(TILE.KILN_SIDE)).toBe(false);
    expect(paintTileHD(TILE.KILN_SIDE, 0)).toBeNull();
    expect(paintTileHD(TILE.MISSING, 0)).toBeNull();
  });

  it('keeps the alpha rules of §15: water 178, ice 200 everywhere; glass a clear interior in an opaque frame', () => {
    for (const t of [TILE.WATER, TILE.TAINTED_WATER]) expect([...alphaCounts(paintTileHD(t, 0))]).toEqual([[178, 1024]]);
    for (let v = 0; v < variantCount(TILE.ICE); v++) expect([...alphaCounts(paintTileHD(TILE.ICE, v))]).toEqual([[200, 1024]]);
    const glass = alphaCounts(paintTileHD(TILE.GLASS, 0));
    expect([...glass.keys()].sort((a, b) => a - b)).toEqual([0, 255]);
    expect(glass.get(0)).toBeGreaterThan(700);
  });

  it('leaves have 12–32 % holes (alpha 0), every other pixel opaque', () => {
    for (const t of [TILE.OAK_LEAVES, TILE.SPRUCE_LEAVES, TILE.BIRCH_LEAVES]) {
      for (let v = 0; v < variantCount(t); v++) {
        const c = alphaCounts(paintTileHD(t, v));
        expect([...c.keys()].sort((a, b) => a - b)).toEqual([0, 255]);
        expect(c.get(0) / 1024).toBeGreaterThanOrEqual(0.12);
        expect(c.get(0) / 1024).toBeLessThanOrEqual(0.32);
      }
    }
  });

  it('every other picture is opaque everywhere', () => {
    const special = new Set([TILE.WATER, TILE.TAINTED_WATER, TILE.ICE, TILE.GLASS, TILE.OAK_LEAVES, TILE.SPRUCE_LEAVES, TILE.BIRCH_LEAVES]);
    for (const [t, v] of PICTURES) {
      if (special.has(t)) continue;
      expect([...alphaCounts(paintTileHD(t, v))], `${TILE_NAMES[t]}#${v}`).toEqual([[255, 1024]]);
    }
  });

  it('keeps each material close to the colour it had at 16 px (the world still reads the same at a glance)', () => {
    // Pictures whose look was redrawn on purpose: the pumpkin's cap (ribs to the hexagon's corners) and glass (its
    // frame and glints; the interior is clear either way).
    const redrawn = new Set([TILE.PUMPKIN_TOP, TILE.GLASS]);
    for (const t of HD_TILES) {
      if (redrawn.has(t)) continue;
      const a = averageColor(t);
      const b = averageColorHD(paintTileHD(t, 0));
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      expect(d, `${TILE_NAMES[t]}: ${a.map(Math.round)} → ${b.map(Math.round)}`).toBeLessThan(42);
    }
  });

  it('upscale16 doubles a 16-px tile pixel for pixel', () => {
    const src = paintTile(TILE.KILN_SIDE);
    const big = upscale16(src);
    expect(big.length).toBe(BYTES);
    let wrong = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const s = ((y >> 1) * 16 + (x >> 1)) * 4;
        const d = (y * 32 + x) * 4;
        for (let c = 0; c < 4; c++) if (big[d + c] !== src[s + c]) wrong++;
      }
    }
    expect(wrong).toBe(0);
  });

  it('the grass block keeps its tinted top distinct from its untinted side (the cap is multiplied by the biome tint)', () => {
    const top = averageColorHD(paintTileHD(TILE.GRASS_TOP, 0));
    expect(top[1]).toBeGreaterThan(top[0]);
    expect(top[1]).toBeGreaterThan(top[2]);
    // the side's top rows are green, its bottom rows dirt
    const side = paintTileHD(TILE.GRASS_SIDE, 0);
    const px = (x, y) => [side[(y * 32 + x) * 4], side[(y * 32 + x) * 4 + 1], side[(y * 32 + x) * 4 + 2]];
    for (let x = 0; x < 32; x++) {
      const [r, g] = px(x, 1);
      expect(g, `x ${x}`).toBeGreaterThan(r);
      const [r2, g2] = px(x, 30);
      expect(r2, `x ${x}`).toBeGreaterThan(g2 - 6);
    }
  });

  it('every block face that shows a varied tile can reach all of its pictures', () => {
    for (const def of BLOCKS) {
      for (let f = 0; f < FACE_COUNT; f++) {
        const t = getFaceTile(def.id, f);
        const v = tileVariants(t);
        if (!v) continue;
        const reached = new Set();
        for (let k = 0; k < 64; k++) reached.add(variantSlot(t, k));
        expect(reached.size).toBe(v.count);
      }
    }
  });
});
