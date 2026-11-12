// Tests for src/worldgen.js -- see src/CONTRACTS.md §8 and, for generation 2, docs/DESIGN-survival.md §8.3–§8.4.
// Cells are hexagonal prisms addressed by axial (q, r) + y. Every sample point is derived from fixed
// seeds / mulberry32, so the suite is fully deterministic.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT, GEN_LATEST,
} from '../../src/config.js';
import { columnIndex, localIndex, floorDiv } from '../../src/coords.js';
import { HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { BLOCK, BIOME, isSolid, isGravityBlock, getBlockDef, getFaceTile, TILE } from '../../src/blocks.js';
import { normalizeSeed, hash2, hash3, rand3, mulberry32 } from '../../src/noise.js';
import {
  createWorldGen, TREE_CELL, TREE_DENSITY, ORE_TABLE, ORE_TABLE_GEN2, FLORA_TABLE, POND_CELL, POND_SALT, FLORA_SALT,
} from '../../src/worldgen.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const ORE_IDS = new Set([B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE]);
const TREE_IDS = new Set([B.OAK_LOG, B.OAK_LEAVES]);
/** Side faces whose neighbours carry the topmost leaf layer (CONTRACTS §8.2 step 4). */
const CROWN_DIRS = [0, 2, 4];

/** One shared generator; chunk results are cached so the whole file stays fast. */
const gen = createWorldGen(SEED);
const chunkCache = new Map();
function chunk(cq, cr) {
  const key = `${cq},${cr}`;
  let c = chunkCache.get(key);
  if (!c) {
    c = gen.generateChunk(cq, cr);
    chunkCache.set(key, c);
  }
  return c;
}

/** Block at local coords of a ChunkData. */
function at(data, lq, ly, lr) {
  return data.blocks[localIndex(lq, ly, lr)];
}

/**
 * Merge an ncq x ncr block of chunks (starting at chunk cq0, cr0) into one cell-coordinate view.
 * get(q, y, r) returns -1 outside the view. `getChunk` defaults to the gen-1 cache.
 */
function mergedView(cq0, cr0, ncq, ncr, getChunk = chunk) {
  const W = ncq * CHUNK_SIZE;
  const D = ncr * CHUNK_SIZE;
  const blocks = new Uint8Array(W * D * WORLD_HEIGHT);
  const heights = new Int16Array(W * D);
  const biomes = new Uint8Array(W * D);
  for (let cq = cq0; cq < cq0 + ncq; cq++) {
    for (let cr = cr0; cr < cr0 + ncr; cr++) {
      const data = getChunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const vq = (cq - cq0) * CHUNK_SIZE + lq;
          const vr = (cr - cr0) * CHUNK_SIZE + lr;
          const src = localIndex(lq, 0, lr);
          blocks.set(data.blocks.subarray(src, src + WORLD_HEIGHT), (vq * D + vr) * WORLD_HEIGHT);
          heights[vq * D + vr] = data.heights[columnIndex(lq, lr)];
          biomes[vq * D + vr] = data.biomes[columnIndex(lq, lr)];
        }
      }
    }
  }
  const q0 = cq0 * CHUNK_SIZE;
  const r0 = cr0 * CHUNK_SIZE;
  const inView = (q, r) => q >= q0 && q < q0 + W && r >= r0 && r < r0 + D;
  return {
    q0, r0, W, D, blocks,
    inView,
    get(q, y, r) {
      if (!inView(q, r) || y < 0 || y >= WORLD_HEIGHT) return -1;
      return blocks[((q - q0) * D + (r - r0)) * WORLD_HEIGHT + y];
    },
    height(q, r) {
      return heights[(q - q0) * D + (r - r0)];
    },
    biome(q, r) {
      return biomes[(q - q0) * D + (r - r0)];
    },
  };
}

/**
 * Independent re-derivation of the contract's tree placement (§8.2 step 4) so the tests can check the
 * generator's stamping against the pure getColumn-based rule.
 * @returns {{tq:number, tr:number, base:number, top:number}[]} trees whose trunk cell lies in the given (q, r) rect
 */
function expectedTrees(worldGen, qMin, qMax, rMin, rMax) {
  const out = [];
  const treeSeed = worldGen.seed ^ 0x7ee5;
  for (let kq = floorDiv(qMin - 3, TREE_CELL); kq <= floorDiv(qMax + 3, TREE_CELL); kq++) {
    for (let kr = floorDiv(rMin - 3, TREE_CELL); kr <= floorDiv(rMax + 3, TREE_CELL); kr++) {
      const hsh = hash2(kq, kr, treeSeed);
      const tq = kq * TREE_CELL + 1 + (hsh & 3);
      const tr = kr * TREE_CELL + 1 + ((hsh >>> 2) & 3);
      if (tq < qMin || tq > qMax || tr < rMin || tr > rMax) continue;
      const trunk = 4 + ((hsh >>> 4) % 3);
      const roll = ((hsh >>> 8) & 0xffff) / 65536;
      const col = worldGen.getColumn(tq, tr);
      if (roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT) {
        out.push({ tq, tr, base: col.height + 1, top: col.height + trunk });
      }
    }
  }
  return out;
}

/** Ring-2 corner cells: twice a side direction. */
function isRingCorner(dq, dr) {
  return hexLength(dq, dr) === 2 && (dq === 0 || dr === 0 || dq + dr === 0);
}

function isCrownCell(dq, dr) {
  return CROWN_DIRS.some((j) => HEX_DIRS[j][0] === dq && HEX_DIRS[j][1] === dr);
}

/** Hex canopy offsets of the contract: [dq, y, dr]. */
function canopyCells(top) {
  const cells = [];
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      const d = hexLength(dq, dr);
      if (d > 2) continue;
      if (!isRingCorner(dq, dr)) {
        cells.push([dq, top - 1, dr]);
        cells.push([dq, top, dr]);
      }
      if (d <= 1) cells.push([dq, top + 1, dr]);
      if (d === 0 || isCrownCell(dq, dr)) cells.push([dq, top + 2, dr]);
    }
  }
  return cells;
}

/**
 * Verify one tree in a merged view: trunk logs present and rooted, every canopy cell inside the view is
 * non-AIR (either LEAVES or something that was already there).
 */
function checkTreeInView(view, t, { requireLeaves }) {
  for (let y = t.base; y <= t.top; y++) {
    expect(view.get(t.tq, y, t.tr)).toBe(B.OAK_LOG);
  }
  expect([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT]).toContain(view.get(t.tq, t.base - 1, t.tr));
  expect(view.height(t.tq, t.tr)).toBe(t.base - 1);
  let leaves = 0;
  let truncated = 0;
  for (const [dq, y, dr] of canopyCells(t.top)) {
    const v = view.get(t.tq + dq, y, t.tr + dr);
    if (v === -1) continue; // outside the merged view
    if (v === B.AIR) truncated++;
    if (v === B.OAK_LEAVES) leaves++;
  }
  expect(truncated).toBe(0);
  if (requireLeaves) expect(leaves).toBeGreaterThanOrEqual(4);
  return leaves;
}

/** Surface block(s) the contract puts at `height` for a biome (MOUNTAINS stone may be replaced by ore). */
function expectedTopBlocks(biome, height) {
  switch (biome) {
    case BIOME.OCEAN: return [height >= 58 ? B.SAND : B.GRAVEL];
    case BIOME.BEACH: return [B.SAND];
    case BIOME.PLAINS:
    case BIOME.FOREST: return [B.GRASS_BLOCK];
    case BIOME.SNOWY: return [B.SNOWY_GRASS];
    case BIOME.DESERT: return [B.SAND];
    case BIOME.SNOWY_PEAKS: return [B.SNOW_BLOCK];
    default: return [B.STONE, ...ORE_IDS, B.GRAVEL, B.DIRT];
  }
}

// ---------------------------------------------------------------------------------------------

describe('worldgen exports', () => {
  it('exposes the contract constants', () => {
    expect(TREE_CELL).toBe(6);
    expect(TREE_DENSITY).toEqual([0, 0, 0.06, 0.7, 0, 0.06, 0, 0]);
    expect(TREE_DENSITY.length).toBe(8);
    expect(ORE_TABLE.length).toBe(6);
    expect(ORE_TABLE.map((o) => o.id)).toEqual([B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.GRAVEL, B.DIRT]);
    for (const o of ORE_TABLE) {
      expect(o.minY).toBeLessThanOrEqual(o.maxY);
      expect(o.minSize).toBeLessThanOrEqual(o.maxSize);
      expect(o.attempts).toBeGreaterThan(0);
    }
    expect(typeof gen.getColumn).toBe('function');
    expect(typeof gen.generateChunk).toBe('function');
  });

  it('normalises the seed like noise.normalizeSeed', () => {
    expect(gen.seed).toBe(normalizeSeed(SEED));
    expect(createWorldGen(7).seed).toBe(7);
    expect(createWorldGen('7').seed).toBe(7);
    expect(createWorldGen(undefined).seed).toBe(0);
  });
});

describe('createWorldGen determinism', () => {
  it('produces identical chunks for the same seed and coordinates', () => {
    const a = createWorldGen(SEED).generateChunk(2, -3);
    const b = createWorldGen(SEED).generateChunk(2, -3);
    expect(a.blocks).toEqual(b.blocks);
    expect(a.heights).toEqual(b.heights);
    expect(a.biomes).toEqual(b.biomes);
  });

  it('treats numeric and numeric-string seeds identically', () => {
    const a = createWorldGen(12345).generateChunk(0, 0);
    const b = createWorldGen('12345').generateChunk(0, 0);
    expect(a.blocks).toEqual(b.blocks);
  });

  it('returns fresh arrays of the right sizes on every call', () => {
    const a = gen.generateChunk(0, 0);
    const b = gen.generateChunk(0, 0);
    expect(a.blocks).not.toBe(b.blocks);
    expect(a.blocks).toBeInstanceOf(Uint8Array);
    expect(a.blocks.length).toBe(CHUNK_VOLUME);
    expect(a.biomes.length).toBe(CHUNK_AREA);
    expect(a.heights.length).toBe(CHUNK_AREA);
  });

  it('differs for a different seed and for a different chunk', () => {
    const a = chunk(0, 0);
    const b = createWorldGen('other-seed').generateChunk(0, 0);
    const c = chunk(1, 0);
    expect(a.blocks).not.toEqual(b.blocks);
    expect(a.blocks).not.toEqual(c.blocks);
  });
});

describe('getColumn', () => {
  it('is pure, accepts negatives and respects the height/biome rules', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 400; i++) {
      const q = Math.floor(rng() * 4000) - 2000;
      const r = Math.floor(rng() * 4000) - 2000;
      const a = gen.getColumn(q, r);
      const b = gen.getColumn(q, r);
      expect(b).toEqual(a);
      expect(Number.isInteger(a.height)).toBe(true);
      expect(a.height).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
      expect(a.height).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
      expect(a.temperature).toBeGreaterThanOrEqual(-1);
      expect(a.temperature).toBeLessThanOrEqual(1);
      expect(a.humidity).toBeGreaterThanOrEqual(-1);
      expect(a.humidity).toBeLessThanOrEqual(1);
      if (a.height <= SEA_LEVEL - 2) expect(a.biome).toBe(BIOME.OCEAN);
      else if (a.height <= SEA_LEVEL + 2) expect(a.biome).toBe(BIOME.BEACH);
      else if (a.height >= 92) expect(a.biome).toBe(BIOME.SNOWY_PEAKS);
      else if (a.height >= 84) expect(a.biome).toBe(BIOME.MOUNTAINS);
      else {
        expect([BIOME.SNOWY, BIOME.DESERT, BIOME.FOREST, BIOME.PLAINS]).toContain(a.biome);
        if (a.biome === BIOME.DESERT) {
          expect(a.temperature).toBeGreaterThan(0.35);
          expect(a.humidity).toBeLessThan(0);
        }
        if (a.biome === BIOME.SNOWY) expect(a.temperature).toBeLessThan(-0.35);
      }
    }
  });

  it('covers the whole clamp range and several biomes over a wide scan', () => {
    const biomes = new Set();
    let minH = Infinity;
    let maxH = -Infinity;
    for (let q = -1500; q <= 1500; q += 25) {
      for (let r = -1500; r <= 1500; r += 25) {
        const c = gen.getColumn(q, r);
        biomes.add(c.biome);
        minH = Math.min(minH, c.height);
        maxH = Math.max(maxH, c.height);
      }
    }
    expect(minH).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
    expect(maxH).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
    expect(maxH - minH).toBeGreaterThan(20);
    expect(biomes.size).toBeGreaterThanOrEqual(4);
    expect(biomes.has(BIOME.OCEAN)).toBe(true);
  });

  it('is sampled at the cell WORLD position: shifting (q, r) along a hex row moves 1 unit, along r moves √3/2', () => {
    // Both axial directions are world-unit steps, so a straight run of cells along +r (world direction
    // (0.5, 0.866)) must be as smooth as one along +q (world (1, 0)): neighbouring heights differ by a
    // bounded amount in every one of the six directions. With the contract's noise scales (≥ 50 cells per
    // detail period) adjacent-cell height jumps are small.
    let maxJump = 0;
    for (let q = -200; q <= 200; q += 7) {
      for (let r = -200; r <= 200; r += 7) {
        const h = gen.getColumn(q, r).height;
        for (const [dq, dr] of HEX_DIRS) {
          maxJump = Math.max(maxJump, Math.abs(gen.getColumn(q + dq, r + dr).height - h));
        }
      }
    }
    expect(maxJump).toBeLessThanOrEqual(4);
    // And the world position of a cell is what hexToWorld says: the neighbour across face 1 (0,+1) sits
    // half a unit east and one row south — not one full unit south, as a square grid would have it.
    expect(hexToWorld(0, 1)).toEqual([0.5, Math.sqrt(3) / 2]);
  });

  it('agrees with the generated heights and biomes for every column of several chunks', () => {
    for (const [cq, cr] of [[0, 0], [-1, 2], [3, -4], [-2, -2]]) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const col = gen.getColumn(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
          expect(data.heights[columnIndex(lq, lr)]).toBe(col.height);
          expect(data.biomes[columnIndex(lq, lr)]).toBe(col.biome);
        }
      }
    }
  });
});

describe('column composition', () => {
  const CHUNKS = [[0, 0], [-1, 2], [3, -4], [-2, -2], [5, 5]];

  it('has BEDROCK at y=0 in every column and never carves it', () => {
    for (const [cq, cr] of CHUNKS) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          expect(at(data, lq, 0, lr)).toBe(B.BEDROCK);
        }
      }
    }
  });

  it('uses the seeded bedrock probabilities at y=1 and y=2: rand3(q,1,r) < 0.5 and rand3(q,2,r) < 0.15', () => {
    let y1 = 0;
    let y2 = 0;
    for (const [cq, cr] of CHUNKS) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const b1 = rand3(q, 1, r, gen.seed) < 0.5;
          const b2 = rand3(q, 2, r, gen.seed) < 0.15;
          expect(at(data, lq, 1, lr) === B.BEDROCK).toBe(b1);
          expect(at(data, lq, 2, lr) === B.BEDROCK).toBe(b2);
          if (b1) y1++;
          if (b2) y2++;
        }
      }
    }
    const n = CHUNKS.length * CHUNK_AREA;
    expect(y1 / n).toBeGreaterThan(0.4);
    expect(y1 / n).toBeLessThan(0.6);
    expect(y2 / n).toBeGreaterThan(0.08);
    expect(y2 / n).toBeLessThan(0.22);
  });

  it('follows the surface rules per biome, with water only above terrain up to sea level', () => {
    for (const [cq, cr] of CHUNKS) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const height = data.heights[columnIndex(lq, lr)];
          const biome = data.biomes[columnIndex(lq, lr)];
          expect(expectedTopBlocks(biome, height)).toContain(at(data, lq, height, lr));
          if (biome === BIOME.PLAINS || biome === BIOME.FOREST) {
            // dirt depth 3 or 4 (hash2(q, r, seed) & 1); the deepest dirt cell can be carved, so check 3.
            for (let y = height - 3; y < height; y++) expect(at(data, lq, y, lr)).toBe(B.DIRT);
            const depth = 3 + (hash2(q, r, gen.seed) & 1);
            const below = at(data, lq, height - depth - 1, lr);
            expect(below).not.toBe(B.DIRT === below && depth === 4 ? -1 : B.GRASS_BLOCK);
          }
          if (biome === BIOME.BEACH || biome === BIOME.DESERT) {
            for (let y = height - 3; y < height; y++) expect(at(data, lq, y, lr)).toBe(B.SAND);
          }
          if (biome === BIOME.DESERT) {
            for (let y = height - 6; y < height - 3; y++) expect(at(data, lq, y, lr)).toBe(B.SANDSTONE);
          }
          if (biome === BIOME.SNOWY) {
            for (let y = height - 3; y < height; y++) expect(at(data, lq, y, lr)).toBe(B.DIRT);
          }
          // Water.
          if (height < SEA_LEVEL) {
            for (let y = height + 1; y <= SEA_LEVEL; y++) expect(at(data, lq, y, lr)).toBe(B.WATER);
            expect(at(data, lq, SEA_LEVEL + 1, lr)).toBe(B.AIR);
          } else {
            for (let y = 0; y < WORLD_HEIGHT; y++) expect(at(data, lq, y, lr)).not.toBe(B.WATER);
          }
          // Nothing but tree blocks above the terrain and water.
          for (let y = Math.max(height, SEA_LEVEL) + 1; y < WORLD_HEIGHT; y++) {
            const v = at(data, lq, y, lr);
            if (v !== B.AIR) expect(TREE_IDS.has(v)).toBe(true);
          }
        }
      }
    }
  });

  it('caves only carve AIR within y 6 .. height−4 (and ≤ SEA_LEVEL−12 under oceans / beaches)', () => {
    let carved = 0;
    for (const [cq, cr] of CHUNKS) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const height = data.heights[columnIndex(lq, lr)];
          const biome = data.biomes[columnIndex(lq, lr)];
          for (let y = 0; y <= height; y++) {
            if (at(data, lq, y, lr) !== B.AIR) continue;
            carved++;
            expect(y).toBeGreaterThanOrEqual(6);
            expect(y).toBeLessThanOrEqual(height - 4);
            if (biome === BIOME.OCEAN || biome === BIOME.BEACH) expect(y).toBeLessThanOrEqual(SEA_LEVEL - 12);
          }
        }
      }
    }
    expect(carved).toBeGreaterThan(50);
    expect(carved).toBeLessThan(CHUNKS.length * CHUNK_AREA * 40 * 0.5); // not hollow
  });
});

describe('biome coverage (5x5 scan)', () => {
  it('finds water somewhere and at least one forest with logs', () => {
    let water = 0;
    let logs = 0;
    const biomes = new Set();
    for (let cq = -2; cq <= 2; cq++) {
      for (let cr = -2; cr <= 2; cr++) {
        const data = chunk(cq, cr);
        for (let i = 0; i < CHUNK_AREA; i++) biomes.add(data.biomes[i]);
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          if (data.blocks[i] === B.WATER) water++;
          else if (data.blocks[i] === B.OAK_LOG) logs++;
        }
      }
    }
    expect(water).toBeGreaterThan(0);
    expect(logs).toBeGreaterThan(0);
    expect(biomes.size).toBeGreaterThanOrEqual(2);
  });
});

describe('trees', () => {
  it('are rooted: every LOG stands on GRASS_BLOCK/SNOWY_GRASS/DIRT/LOG and never below sea level', () => {
    let logs = 0;
    for (let cq = -2; cq <= 2; cq++) {
      for (let cr = -2; cr <= 2; cr++) {
        const data = chunk(cq, cr);
        for (let lq = 0; lq < CHUNK_SIZE; lq++) {
          for (let lr = 0; lr < CHUNK_SIZE; lr++) {
            for (let y = 1; y < WORLD_HEIGHT; y++) {
              if (at(data, lq, y, lr) !== B.OAK_LOG) continue;
              logs++;
              expect(y).toBeGreaterThan(SEA_LEVEL + 2);
              expect([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT, B.OAK_LOG]).toContain(at(data, lq, y - 1, lr));
            }
          }
        }
      }
    }
    expect(logs).toBeGreaterThan(0);
  });

  it('match the getColumn-only placement rule and have a complete hex canopy', () => {
    let trees = 0;
    for (const [ccq, ccr] of [[0, 0], [-1, 1], [2, -2], [1, 1], [-2, -1]]) {
      const view = mergedView(ccq - 1, ccr - 1, 3, 3);
      const q0 = ccq * CHUNK_SIZE;
      const r0 = ccr * CHUNK_SIZE;
      const expected = expectedTrees(gen, q0, q0 + 15, r0, r0 + 15);
      for (const t of expected) {
        expect(t.top - t.base + 1).toBeGreaterThanOrEqual(4);
        expect(t.top - t.base + 1).toBeLessThanOrEqual(6);
        checkTreeInView(view, t, { requireLeaves: true });
        trees++;
      }
      // Conversely, every trunk base in the centre chunk is one of the expected trees.
      const bases = new Set(expected.map((t) => `${t.tq},${t.base},${t.tr}`));
      for (let q = q0; q < q0 + 16; q++) {
        for (let r = r0; r < r0 + 16; r++) {
          for (let y = 1; y < WORLD_HEIGHT; y++) {
            if (view.get(q, y, r) === B.OAK_LOG && view.get(q, y - 1, r) !== B.OAK_LOG) {
              expect(bases.has(`${q},${y},${r}`)).toBe(true);
            }
          }
        }
      }
    }
    expect(trees).toBeGreaterThan(0);
  });

  it('an isolated tree has EXACTLY the hex canopy: 12 + 12 + 7 + 4 leaf cells around a 4–6 log trunk', () => {
    // Find trees whose nearest other tree is at least 6 cells away (hex distance), so no canopies overlap,
    // and whose canopy lies above the local terrain (so every canopy cell was AIR).
    let checked = 0;
    for (let ccq = -3; ccq <= 3 && checked < 3; ccq++) {
      for (let ccr = -3; ccr <= 3 && checked < 3; ccr++) {
        const q0 = ccq * CHUNK_SIZE;
        const r0 = ccr * CHUNK_SIZE;
        const all = expectedTrees(gen, q0 - 8, q0 + 23, r0 - 8, r0 + 23);
        const inner = all.filter((t) => t.tq >= q0 + 3 && t.tq <= q0 + 12 && t.tr >= r0 + 3 && t.tr <= r0 + 12);
        for (const t of inner) {
          const isolated = all.every((o) => o === t || hexLength(o.tq - t.tq, o.tr - t.tr) >= 6);
          if (!isolated) continue;
          const data = chunk(ccq, ccr);
          let aboveTerrain = true;
          for (let dq = -3; dq <= 3; dq++) {
            for (let dr = -3; dr <= 3; dr++) {
              if (hexLength(dq, dr) > 3) continue;
              const h = data.heights[columnIndex(t.tq - q0 + dq, t.tr - r0 + dr)];
              if (h >= t.top - 1) aboveTerrain = false;
            }
          }
          if (!aboveTerrain) continue;
          // Leaves only fill AIR, so the trunk column (logs up to `top`) is excluded from the leaf set.
          const expected = new Set(
            canopyCells(t.top)
              .filter(([dq, y, dr]) => !(dq === 0 && dr === 0 && y <= t.top))
              .map(([dq, y, dr]) => `${t.tq + dq},${y},${t.tr + dr}`),
          );
          expect(expected.size).toBe(12 + 12 + 7 + 4);
          const actual = new Set();
          for (let dq = -3; dq <= 3; dq++) {
            for (let dr = -3; dr <= 3; dr++) {
              for (let y = t.top - 3; y <= t.top + 3; y++) {
                if (at(data, t.tq - q0 + dq, y, t.tr - r0 + dr) === B.OAK_LEAVES) actual.add(`${t.tq + dq},${y},${t.tr + dr}`);
              }
            }
          }
          expect([...actual].sort()).toEqual([...expected].sort());
          // Layer shapes: top−1/top = 13 canopy cells (ring ≤ 1 plus the six ring-2 edge cells) minus the log,
          // top+1 = 7 (ring ≤ 1), top+2 = 4 (trunk column + CROWN_DIRS neighbours).
          const layer = (y) => [...actual].filter((k) => Number(k.split(',')[1]) === y).length;
          expect(layer(t.top - 1)).toBe(12);
          expect(layer(t.top)).toBe(12);
          expect(layer(t.top + 1)).toBe(7);
          expect(layer(t.top + 2)).toBe(4);
          for (let y = t.base; y <= t.top; y++) expect(at(data, t.tq - q0, y, t.tr - r0)).toBe(B.OAK_LOG);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('are never stamped outside the chunk that is generated and only fill AIR with leaves', () => {
    const data = chunk(0, 0);
    const trees = expectedTrees(gen, -2, 17, -2, 17);
    const allowed = new Set();
    for (const t of trees) {
      for (let y = t.base; y <= t.top; y++) allowed.add(`${t.tq},${y},${t.tr}`);
      for (const [dq, y, dr] of canopyCells(t.top)) allowed.add(`${t.tq + dq},${y},${t.tr + dr}`);
    }
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const v = at(data, lq, y, lr);
          if (TREE_IDS.has(v)) expect(allowed.has(`${lq},${y},${lr}`)).toBe(true);
        }
      }
    }
  });

  it('only grow where the biome density roll passes and the column is at least SEA_LEVEL+2', () => {
    for (let ccq = -2; ccq <= 2; ccq++) {
      for (let ccr = -2; ccr <= 2; ccr++) {
        const q0 = ccq * CHUNK_SIZE;
        const r0 = ccr * CHUNK_SIZE;
        const data = chunk(ccq, ccr);
        for (const t of expectedTrees(gen, q0, q0 + 15, r0, r0 + 15)) {
          const col = gen.getColumn(t.tq, t.tr);
          expect(TREE_DENSITY[col.biome]).toBeGreaterThan(0);
          expect(col.height).toBeGreaterThanOrEqual(SEA_LEVEL + 2);
          expect(at(data, t.tq - q0, t.base, t.tr - r0)).toBe(B.OAK_LOG);
        }
      }
    }
  });
});

describe('cross-chunk consistency', () => {
  /** Trees whose canopy (radius 2) straddles the seam between chunk (cq, cr) and its +q (dcq = 1) or +r neighbour. */
  function straddling(cq, cr, dcq) {
    const q0 = cq * CHUNK_SIZE;
    const r0 = cr * CHUNK_SIZE;
    const all = expectedTrees(gen, q0 - 2, q0 + 2 * CHUNK_SIZE + 1, r0 - 2, r0 + 2 * CHUNK_SIZE + 1);
    return all.filter((t) => {
      if (dcq === 1) return t.tq >= q0 + CHUNK_SIZE - 2 && t.tq <= q0 + CHUNK_SIZE + 1 && t.tr >= r0 && t.tr < r0 + CHUNK_SIZE;
      return t.tr >= r0 + CHUNK_SIZE - 2 && t.tr <= r0 + CHUNK_SIZE + 1 && t.tq >= q0 && t.tq < q0 + CHUNK_SIZE;
    });
  }

  it('shows no truncated canopies across a q-seam or an r-seam in merged views', () => {
    let found = 0;
    for (let cq = -3; cq <= 3; cq++) {
      for (let cr = -3; cr <= 3; cr++) {
        for (const dcq of [1, 0]) {
          const trees = straddling(cq, cr, dcq);
          if (trees.length === 0) continue;
          const view = mergedView(cq - 1, cr - 1, 3, 3);
          for (const t of trees) {
            checkTreeInView(view, t, { requireLeaves: false });
            found++;
          }
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('stamps identical tree cells regardless of which chunk generates them', () => {
    // For a straddling tree, each of its cells inside chunk A must equal what the standalone generation of
    // chunk A produced, and likewise for chunk B — and both must agree with the contract's canopy rule.
    let compared = 0;
    for (let cq = -3; cq <= 3; cq++) {
      for (let cr = -3; cr <= 3; cr++) {
        for (const dcq of [1, 0]) {
          for (const t of straddling(cq, cr, dcq)) {
            const cells = canopyCells(t.top).map(([dq, y, dr]) => [t.tq + dq, y, t.tr + dr]);
            for (let y = t.base; y <= t.top; y++) cells.push([t.tq, y, t.tr]);
            let inA = 0;
            let inB = 0;
            for (const [q, y, r] of cells) {
              const ccq = floorDiv(q, CHUNK_SIZE);
              const ccr = floorDiv(r, CHUNK_SIZE);
              const data = chunk(ccq, ccr);
              const v = at(data, q - ccq * CHUNK_SIZE, y, r - ccr * CHUNK_SIZE);
              expect(v).not.toBe(B.AIR);
              if (ccq === cq && ccr === cr) inA++;
              else inB++;
            }
            expect(inA).toBeGreaterThan(0);
            expect(inB).toBeGreaterThan(0);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('ores', () => {
  function countOres(chunks) {
    const counts = new Map([...ORE_IDS].map((id) => [id, 0]));
    for (const [cq, cr] of chunks) {
      const data = chunk(cq, cr);
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        const v = data.blocks[i];
        if (ORE_IDS.has(v)) counts.set(v, counts.get(v) + 1);
      }
    }
    return counts;
  }

  const SIXTEEN = [];
  for (let cq = -2; cq <= 1; cq++) for (let cr = -2; cr <= 1; cr++) SIXTEEN.push([cq, cr]);

  it('exist with plausible counts over 16 chunks', () => {
    const counts = countOres(SIXTEEN);
    expect(counts.get(B.COAL_ORE)).toBeGreaterThan(16 * 18 * 2);
    expect(counts.get(B.IRON_ORE)).toBeGreaterThan(16 * 12 * 1);
    expect(counts.get(B.GOLD_ORE)).toBeGreaterThan(0);
    expect(counts.get(B.DIAMOND_ORE)).toBeGreaterThan(0);
    expect(counts.get(B.COAL_ORE)).toBeGreaterThan(counts.get(B.IRON_ORE));
    expect(counts.get(B.IRON_ORE)).toBeGreaterThan(counts.get(B.GOLD_ORE));
    expect(counts.get(B.GOLD_ORE)).toBeGreaterThan(counts.get(B.DIAMOND_ORE));
  });

  it('places every ore within its table y-range (± walk length) and diamonds only deep down', () => {
    const range = new Map(ORE_TABLE.filter((o) => ORE_IDS.has(o.id)).map((o) => [o.id, o]));
    for (const [cq, cr] of SIXTEEN) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const v = at(data, lq, y, lr);
            if (!ORE_IDS.has(v)) continue;
            const o = range.get(v);
            expect(y).toBeGreaterThanOrEqual(Math.max(1, o.minY - o.maxSize));
            expect(y).toBeLessThanOrEqual(o.maxY + o.maxSize);
            if (v === B.DIAMOND_ORE) expect(y).toBeLessThanOrEqual(14 + 5);
          }
        }
      }
    }
  });

  it('only replaces STONE: never above the terrain, in surface layers, in water or in bedrock', () => {
    for (const [cq, cr] of SIXTEEN) {
      const data = chunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const height = data.heights[columnIndex(lq, lr)];
          const biome = data.biomes[columnIndex(lq, lr)];
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const v = at(data, lq, y, lr);
            if (!ORE_IDS.has(v)) continue;
            expect(y).toBeGreaterThan(0);
            expect(y).toBeLessThanOrEqual(height);
            if (biome !== BIOME.MOUNTAINS) expect(y).not.toBe(height);
            if (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.SNOWY || biome === BIOME.BEACH || biome === BIOME.OCEAN) {
              expect(y).toBeLessThan(height - 2); // the 3 surface/filler layers are never stone
            }
            if (biome === BIOME.DESERT) expect(y).toBeLessThan(height - 5);
            // Bedrock is never replaced (y=1 / y=2 bedrock cells keep their id).
            expect(at(data, lq, 0, lr)).toBe(B.BEDROCK);
          }
        }
      }
    }
  });

  it('veins are connected through the 8 cell neighbours (6 sides, up, down): every ore touches STONE or ore', () => {
    const view = mergedView(-1, -1, 3, 3);
    let ores = 0;
    for (let q = 0; q < CHUNK_SIZE; q++) {
      for (let r = 0; r < CHUNK_SIZE; r++) {
        for (let y = 1; y < WORLD_HEIGHT; y++) {
          const v = view.get(q, y, r);
          if (!ORE_IDS.has(v)) continue;
          ores++;
          let touching = false;
          const around = [[q, y + 1, r], [q, y - 1, r], ...HEX_DIRS.map(([dq, dr]) => [q + dq, y, r + dr])];
          for (const [nq, ny, nr] of around) {
            const n = view.get(nq, ny, nr);
            if (n === B.STONE || ORE_IDS.has(n)) touching = true;
          }
          expect(touching).toBe(true);
        }
      }
    }
    expect(ores).toBeGreaterThan(0);
  });
});

describe('performance', () => {
  it('generates a warm chunk in ≤ 8 ms on average over 10 chunks', () => {
    for (let i = 0; i < 3; i++) gen.generateChunk(50 + i, 50); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) gen.generateChunk(60 + i, -60 + i);
    const avg = (performance.now() - t0) / 10;
    expect(avg).toBeLessThan(8);
  });

  it('generates a warm generation-2 chunk in ≤ 8 ms on average over 10 chunks (DESIGN-survival §8.3)', () => {
    const g2 = createWorldGen(SEED, { gen: 2 });
    for (let i = 0; i < 3; i++) g2.generateChunk(50 + i, 50); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) g2.generateChunk(60 + i, -60 + i);
    const avg = (performance.now() - t0) / 10;
    expect(avg).toBeLessThan(8);
  });

  it('generates a warm generation-3 chunk in ≤ 8 ms on average over 10 chunks (§76 flora: the food patches and cave troops)', () => {
    const g3 = createWorldGen(SEED, { gen: 3 });
    for (let i = 0; i < 3; i++) g3.generateChunk(50 + i, 50); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) g3.generateChunk(60 + i, -60 + i);
    const avg = (performance.now() - t0) / 10;
    expect(avg).toBeLessThan(8);
  });
});

// =============================================================================================
// Generation 2: the survival resources (docs/DESIGN-survival.md §8.3–§8.4, package A tests 1–9).

const gen2 = createWorldGen(SEED, { gen: 2 });
const chunk2Cache = new Map();
/** A cached generation-2 chunk of SEED. */
function chunk2(cq, cr) {
  const key = `${cq},${cr}`;
  let c = chunk2Cache.get(key);
  if (!c) {
    c = gen2.generateChunk(cq, cr);
    chunk2Cache.set(key, c);
  }
  return c;
}
/** Block at cell (q, y, r) of the generation-2 world (generates the chunk on demand). */
function cell2(q, y, r) {
  const cq = floorDiv(q, CHUNK_SIZE);
  const cr = floorDiv(r, CHUNK_SIZE);
  return at(chunk2(cq, cr), q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE);
}

/** sha256 of a chunk's three arrays (first 32 hex digits). */
function digest(d) {
  return createHash('sha256').update(d.blocks).update(d.biomes).update(d.heights).digest('hex').slice(0, 32);
}

/** Chunks of SEED compared cell by cell between generation 1 and 2. */
const CMP = [[0, 0], [1, 0], [0, 1], [-1, 2], [3, -4], [-2, -2], [5, 5], [12, -7], [2, 2], [-3, 1], [4, -1], [-5, 3]];

/** The flora / litter ids of FLORA_TABLE (the rows that stand on the surface; gravel tops excluded). */
const FLORA_IDS = new Set(FLORA_TABLE.filter(Boolean).flatMap((t) => t.rows.filter((row) => !row.top).map((row) => row.id)));
const LEAF_IDS = new Set([B.OAK_LEAVES, B.SPRUCE_LEAVES, B.BIRCH_LEAVES]);
const POND_BIOMES = [BIOME.PLAINS, BIOME.FOREST, BIOME.SNOWY];

/** A sparse scan of 121 generation-2 chunks spread over 130 chunks each way (for rates and ponds). */
let scanCache = null;
function scan() {
  if (!scanCache) {
    scanCache = [];
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) scanCache.push([i * 13, j * 13]);
  }
  return scanCache;
}

/** The accepted pond centres of grid cells kq, kr in [k0, k1] (pondAt holds at a centre exactly when it is accepted). */
function pondCentres(g, k0, k1) {
  const out = [];
  for (let kq = k0; kq <= k1; kq++) {
    for (let kr = k0; kr <= k1; kr++) {
      const h = hash2(kq, kr, g.seed ^ POND_SALT);
      const q = kq * POND_CELL + 2 + (h & 7);
      const r = kr * POND_CELL + 2 + ((h >>> 3) & 7);
      if (g.pondAt(q, r)) out.push({ kq, kr, q, r, h, H: g.getColumn(q, r).height, biome: g.getColumn(q, r).biome });
    }
  }
  return out;
}

/** The hex offsets within distance 2 (19 columns, centre first). */
const DISC2 = [];
for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) if (hexLength(dq, dr) <= 2) DISC2.push([dq, dr, hexLength(dq, dr)]);
DISC2.sort((a, b) => a[2] - b[2]);

describe('generation 2: the generator surface', () => {
  it('gen 1 is byte-identical to the generator before v0.9 (checksums pinned before the change)', () => {
    const PINNED = [
      ['caelancraft-test', 0, 0, 'ba19062a5808524ea11789c6b23f7c51'], ['caelancraft-test', 1, 0, '848b42776e4f7c4c51ab16d7d8dfcfbb'],
      ['caelancraft-test', -1, 2, 'a9944a0f1601507ec9ee4f2a654d7492'], ['caelancraft-test', 3, -4, 'b92d33159fbb4b2d24f5bc52ba43aa6d'],
      ['caelancraft-test', -2, -2, '9f43864b239f7d2fc01cb4215de92d87'], ['caelancraft-test', 5, 5, '65909b7ae138783979528a34da4cce1d'],
      ['caelancraft-test', 12, -7, '8e9b35b4a991adae0df3d18127c43550'], [1, 0, 0, '2791ec977c4934e4ef477ab8fcfcccaf'],
      [1, -3, 1, '95b586bf372526523aedc043b372fa10'], [1, 2, 2, 'f8f3d23c77e11137c6902b8be4db292d'],
      ['survival', 0, 0, 'a2dd4003a283bdb39480e033eb8c4bd2'], ['survival', 4, -1, 'b77dbbb874c202a6a2c788a8d4d1b413'],
    ];
    for (const [seed, cq, cr, sum] of PINNED) {
      expect(digest(createWorldGen(seed).generateChunk(cq, cr)), `${seed} ${cq},${cr}`).toBe(sum);
      expect(digest(createWorldGen(seed, { gen: 1 }).generateChunk(cq, cr)), `${seed} ${cq},${cr} gen 1`).toBe(sum);
    }
    // Anything that is not an integer ≥ 1 is generation 1 too.
    for (const bad of [0, -2, 1.5, '2', null, undefined, NaN]) {
      const g = createWorldGen(1, { gen: /** @type {*} */ (bad) });
      expect(g.gen, String(bad)).toBe(1);
      expect(digest(g.generateChunk(0, 0))).toBe('2791ec977c4934e4ef477ab8fcfcccaf');
    }
    // …and generation 2 differs.
    expect(digest(createWorldGen(1, { gen: 2 }).generateChunk(0, 0))).not.toBe('2791ec977c4934e4ef477ab8fcfcccaf');
  });

  it('exposes gen, pondAt, treeTrunkAt and FLORA_TABLE on the generator; gen is clamped to 1..GEN_LATEST', () => {
    expect(gen.gen).toBe(1);
    expect(gen2.gen).toBe(2);
    expect(createWorldGen(1, { gen: 99 }).gen).toBe(GEN_LATEST);
    for (const g of [gen, gen2]) {
      expect(typeof g.pondAt).toBe('function');
      expect(typeof g.treeTrunkAt).toBe('function');
      expect(g.FLORA_TABLE).toBe(FLORA_TABLE);
    }
    // Generation 1 has no ponds.
    for (const p of pondCentres(gen2, -6, 6)) expect(gen.pondAt(p.q, p.r)).toBe(false);
    expect(ORE_TABLE.length).toBe(6); // the gen-1 rows are untouched
    expect(Object.isFrozen(ORE_TABLE_GEN2)).toBe(true);
    expect(Object.isFrozen(FLORA_TABLE)).toBe(true);
    expect(POND_CELL).toBe(20);
    expect(typeof POND_SALT).toBe('number');
    expect(typeof FLORA_SALT).toBe('number');
  });

  it('ORE_TABLE_GEN2 is the §8.3 table: copper, tin, clay (clay replaces sand, gravel and dirt)', () => {
    const rows = ORE_TABLE_GEN2.map((o) => [o.id, o.attempts, o.minY, o.maxY, o.minSize, o.maxSize, o.replaces ? [...o.replaces] : null]);
    expect(rows).toEqual([
      [B.COPPER_ORE, 10, 30, 80, 4, 8, null],
      [B.TIN_ORE, 4, 20, 64, 3, 6, null],
      [B.CLAY, 3, 52, 62, 6, 12, [B.SAND, B.GRAVEL, B.DIRT]],
    ]);
  });

  it('FLORA_TABLE is the §8.3 table, indexed by biome (cumulative chances below 1)', () => {
    const view = (biome) => {
      const t = FLORA_TABLE[biome];
      return t && { surface: t.surface, rows: t.rows.map((row) => [row.id, row.chance, row.top ? 'top' : 'on']) };
    };
    expect(FLORA_TABLE.length).toBe(8);
    expect(view(BIOME.OCEAN)).toBe(null);
    expect(view(BIOME.SNOWY_PEAKS)).toBe(null);
    expect(view(BIOME.PLAINS)).toEqual({
      surface: B.GRASS_BLOCK,
      rows: [[B.GRAVEL, 0.015, 'top'], [B.LOOSE_STONES, 0.012, 'on'], [B.FALLEN_BRANCHES, 0.005, 'on'], [B.TUSSOCK, 0.06, 'on'],
        [B.TUBER_PLANT, 0.008, 'on'], [B.HONEYBERRY_BUSH, 0.006, 'on']],
    });
    expect(view(BIOME.FOREST)).toEqual({
      surface: B.GRASS_BLOCK,
      rows: [[B.GRAVEL, 0.02, 'top'], [B.LOOSE_STONES, 0.01, 'on'], [B.FALLEN_BRANCHES, 0.04, 'on'], [B.TUSSOCK, 0.03, 'on'],
        [B.TUBER_PLANT, 0.004, 'on'], [B.HONEYBERRY_BUSH, 0.02, 'on']],
    });
    expect(view(BIOME.SNOWY)).toEqual({
      surface: B.SNOWY_GRASS,
      rows: [[B.GRAVEL, 0.02, 'top'], [B.LOOSE_STONES, 0.02, 'on'], [B.FALLEN_BRANCHES, 0.015, 'on'], [B.TUSSOCK, 0.02, 'on'],
        [B.HONEYBERRY_BUSH, 0.005, 'on']],
    });
    expect(view(BIOME.DESERT)).toEqual({ surface: B.SAND, rows: [[B.LOOSE_STONES, 0.01, 'on'], [B.PRICKLY_PEAR, 0.008, 'on']] });
    expect(view(BIOME.BEACH)).toEqual({
      surface: B.SAND, rows: [[B.GRAVEL, 0.12, 'top'], [B.LOOSE_STONES, 0.06, 'on'], [B.CATTAILS, 0.03, 'on']],
    });
    const cattails = FLORA_TABLE[BIOME.BEACH].rows[2];
    expect([cattails.minHeight, cattails.maxHeight, cattails.besideBelow]).toEqual([62, 63, 62]);
    expect(view(BIOME.MOUNTAINS)).toEqual({ surface: B.STONE, rows: [[B.GRAVEL, 0.06, 'top'], [B.LOOSE_STONES, 0.05, 'on']] });
    for (const t of FLORA_TABLE) if (t) expect(t.rows.reduce((s, row) => s + row.chance, 0)).toBeLessThan(1);
  });
});

describe('generation 2: determinism and chunk borders', () => {
  it('is deterministic and every chunk is the same whichever order its neighbours are generated in', () => {
    const coords = [[0, 0], [1, 0], [0, 1], [1, -1], [-1, 1], [-1, 0], [0, -1]];
    const a = createWorldGen(SEED, { gen: 2 });
    const b = createWorldGen(SEED, { gen: 2 });
    const first = coords.map(([q, r]) => digest(a.generateChunk(q, r)));
    const second = [...coords].reverse().map(([q, r]) => digest(b.generateChunk(q, r))).reverse();
    expect(second).toEqual(first);
    expect(first).toEqual(coords.map(([q, r]) => digest(chunk2(q, r))));
  });

  it('pond water is exactly where pondAt says, on both sides of every chunk border', () => {
    let straddling = 0;
    for (const p of pondCentres(gen2, -12, 12)) {
      const chunks = new Set();
      for (const [dq, dr, d] of DISC2) {
        if (d > 1) continue;
        const q = p.q + dq;
        const r = p.r + dr;
        if (gen2.getColumn(q, r).height !== p.H) continue;
        chunks.add(`${floorDiv(q, CHUNK_SIZE)},${floorDiv(r, CHUNK_SIZE)}`);
        expect(gen2.pondAt(q, r)).toBe(true);
        expect([B.WATER, B.ICE]).toContain(cell2(q, p.H, r));
      }
      if (chunks.size > 1) straddling++;
    }
    expect(straddling).toBeGreaterThan(0);
    // Conversely, every water or ice cell above sea level in these chunks belongs to a pond column.
    for (const [cq, cr] of [[-1, -1], [0, 0], [1, 2], [-2, 3], [4, 4], [6, -3]]) {
      const d = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          for (let y = SEA_LEVEL + 1; y < WORLD_HEIGHT; y++) {
            const v = at(d, lq, y, lr);
            if (v === B.WATER || v === B.ICE) expect(gen2.pondAt(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr)).toBe(true);
          }
        }
      }
    }
  });

  it('spruce and birch trees whose canopy straddles a chunk border keep their species on both sides', () => {
    let checked = 0;
    let straddling = 0;
    for (let kq = -40; kq <= 40 && checked < 24; kq++) {
      for (let kr = -40; kr <= 40 && checked < 24; kr++) {
        const t = gen2.treeTrunkAt(kq, kr);
        if (!t || t.species === 'oak') continue;
        // Only isolated trees (no other trunk within 5, so no canopy overlaps): every canopy cell is this tree's.
        let isolated = true;
        for (let okq = kq - 2; okq <= kq + 2; okq++) {
          for (let okr = kr - 2; okr <= kr + 2; okr++) {
            if (okq === kq && okr === kr) continue;
            const o = gen2.treeTrunkAt(okq, okr);
            if (o && hexLength(o.tq - t.tq, o.tr - t.tr) < 5) isolated = false;
          }
        }
        if (!isolated) continue;
        const log = t.species === 'spruce' ? B.SPRUCE_LOG : B.BIRCH_LOG;
        const leaves = t.species === 'spruce' ? B.SPRUCE_LEAVES : B.BIRCH_LEAVES;
        const top = t.height + t.trunk;
        for (let y = t.height + 1; y <= top; y++) expect(cell2(t.tq, y, t.tr)).toBe(log);
        const chunks = new Set();
        for (const [dq, dr, d] of DISC2) {
          const q = t.tq + dq;
          const r = t.tr + dr;
          chunks.add(`${floorDiv(q, CHUNK_SIZE)},${floorDiv(r, CHUNK_SIZE)}`);
          // Layer top+1 (d ≤ 1) is above all terrain within reach, so it is always this tree's leaves.
          if (d <= 1) expect(cell2(q, top + 1, r), `${q},${top + 1},${r}`).toBe(leaves);
          for (let y = top - 1; y <= top + 2; y++) {
            const v = cell2(q, y, r);
            if (LEAF_IDS.has(v)) expect(v).toBe(leaves);
          }
        }
        if (chunks.size > 1) straddling++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(straddling).toBeGreaterThan(0);
  });
});

describe('generation 2: ores and clay', () => {
  it('every gen-1 vein is unchanged; every other difference from gen 1 is a survival resource', () => {
    const counts = new Map();
    for (const [cq, cr] of CMP) {
      const a = chunk(cq, cr);
      const b = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const height = a.heights[columnIndex(lq, lr)];
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const u = at(a, lq, y, lr);
            const v = at(b, lq, y, lr);
            if (ORE_IDS.has(u)) expect(v, 'gen-1 ore').toBe(u);
            if (u === v) continue;
            const ok =
              (u === B.STONE && (v === B.COPPER_ORE || v === B.TIN_ORE)) ||
              ((u === B.SAND || u === B.GRAVEL || u === B.DIRT) && v === B.CLAY) ||
              ((u === B.GRASS_BLOCK || u === B.SNOWY_GRASS) && (v === B.WATER || v === B.ICE) && y === height) ||
              ([B.GRASS_BLOCK, B.SNOWY_GRASS, B.SAND, B.STONE].includes(u) && v === B.GRAVEL && y === height) ||
              ((u === B.AIR || LEAF_IDS.has(u)) && FLORA_IDS.has(v) && y === height + 1) ||
              (u === B.OAK_LOG && (v === B.SPRUCE_LOG || v === B.BIRCH_LOG)) ||
              (u === B.OAK_LEAVES && (v === B.SPRUCE_LEAVES || v === B.BIRCH_LEAVES));
            expect(ok, `${cq},${cr} (${lq},${y},${lr}): ${u} → ${v}`).toBe(true);
            counts.set(v, (counts.get(v) ?? 0) + 1);
          }
        }
      }
    }
    for (const id of [B.COPPER_ORE, B.TIN_ORE, B.CLAY, B.TUSSOCK, B.LOOSE_STONES]) expect(counts.get(id) ?? 0, `id ${id}`).toBeGreaterThan(0);
  });

  it('§76: Flinty Gravel (v0.13) is withdrawn — never generated, and its id is gravel in all but number', () => {
    for (const [cq, cr] of CMP.slice(0, 6)) {
      for (const c of [chunk(cq, cr), chunk2(cq, cr)]) expect(c.blocks.includes(B.FLINT_GRAVEL)).toBe(false);
    }
    const legacy = getBlockDef(B.FLINT_GRAVEL);
    expect([legacy.displayName, legacy.placeable, isGravityBlock(B.FLINT_GRAVEL)]).toEqual(['Gravel', false, true]);
    for (let f = 0; f < 8; f++) expect(getFaceTile(B.FLINT_GRAVEL, f)).toBe(TILE.GRAVEL);
    expect(TILE.FLINT_GRAVEL).toBeUndefined();
  });

  it('copper and tin stay in their y ranges and replace STONE only; clay replaces only sand, gravel and dirt', () => {
    const range = (o) => [o.minY - o.maxSize, o.maxY + o.maxSize];
    const [cu, sn, clay] = ORE_TABLE_GEN2.map(range);
    const seen = { cu: 0, sn: 0, clay: 0 };
    for (const [cq, cr] of CMP) {
      const a = chunk(cq, cr);
      const b = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const height = b.heights[columnIndex(lq, lr)];
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const v = at(b, lq, y, lr);
            const u = at(a, lq, y, lr);
            if (v === B.COPPER_ORE) {
              seen.cu++;
              expect(u).toBe(B.STONE);
              expect(y).toBeGreaterThanOrEqual(cu[0]);
              expect(y).toBeLessThanOrEqual(cu[1]);
            } else if (v === B.TIN_ORE) {
              seen.sn++;
              expect(u).toBe(B.STONE);
              expect(y).toBeGreaterThanOrEqual(sn[0]);
              expect(y).toBeLessThanOrEqual(sn[1]);
            } else if (v === B.CLAY) {
              seen.clay++;
              expect([B.SAND, B.GRAVEL, B.DIRT]).toContain(u);
              const pondFloor = y === height - 1 && gen2.pondAt(q, r);
              if (!pondFloor) {
                expect(y).toBeGreaterThanOrEqual(clay[0]);
                expect(y).toBeLessThanOrEqual(clay[1]);
              }
            }
          }
        }
      }
    }
    expect(seen.cu).toBeGreaterThan(seen.sn); // 10 attempts against 4
    expect(seen.sn).toBeGreaterThan(0);
    expect(seen.clay).toBeGreaterThan(0);
  });
});

describe('generation 2: flora (§8.3 step 4)', () => {
  it('each eligible column gets exactly what its one roll against the cumulative FLORA_TABLE picks', () => {
    let placed = 0;
    let eligible = 0;
    for (const [cq, cr] of CMP) {
      const a = chunk(cq, cr);
      const b = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const ci = columnIndex(lq, lr);
          const table = FLORA_TABLE[b.biomes[ci]];
          const h = b.heights[ci];
          if (!table || at(a, lq, h, lr) !== table.surface || at(a, lq, h + 1, lr) !== B.AIR) continue;
          // Ponds and their rims (written before the flora pass) and new-species canopies are not flora's business.
          let nearPond = false;
          for (const [dq, dr] of DISC2) if (gen2.pondAt(q + dq, r + dr)) nearPond = true;
          if (nearPond || LEAF_IDS.has(at(b, lq, h + 1, lr))) continue;
          eligible++;
          const u = rand3(q, r, FLORA_SALT, gen2.seed);
          let acc = 0;
          let want = null;
          for (const row of table.rows) {
            acc += row.chance;
            if (u < acc) {
              const shore = row.besideBelow === undefined ||
                HEX_DIRS.some(([dq, dr]) => gen2.getColumn(q + dq, r + dr).height < row.besideBelow);
              const fits = (row.minHeight === undefined || h >= row.minHeight) && (row.maxHeight === undefined || h <= row.maxHeight) && shore;
              want = fits ? row : null;
              break;
            }
          }
          const top = at(b, lq, h, lr);
          const above = at(b, lq, h + 1, lr);
          if (!want) {
            expect([top, above], `${q},${r}`).toEqual([table.surface, B.AIR]);
          } else if (want.top) {
            expect([top, above], `${q},${r}`).toEqual([want.id, B.AIR]);
            placed++;
          } else {
            expect([top, above], `${q},${r}`).toEqual([table.surface, want.id]);
            placed++;
          }
        }
      }
    }
    expect(eligible).toBeGreaterThan(1000);
    expect(placed).toBeGreaterThan(20);
  });

  it('plants and litter stand on their biome surface (or a pond rim); over a scan each rate is within ±50 % of §8.3', () => {
    const eligible = new Map();
    const hits = new Map();
    const shore = { n: 0, cattails: 0 };
    for (const [cq, cr] of scan()) {
      const d = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const ci = columnIndex(lq, lr);
          const biome = d.biomes[ci];
          const table = FLORA_TABLE[biome];
          const h = d.heights[ci];
          const top = at(d, lq, h, lr);
          const above = at(d, lq, h + 1, lr);
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          if (FLORA_IDS.has(above)) {
            expect(isSolid(top), `${q},${r}`).toBe(true);
            if (table && table.rows.some((row) => row.id === above && !row.top) && top === table.surface) {
              // a flora row of this biome on its surface
            } else {
              // otherwise only a pond rim's cattails or loose stones, on a pond biome's surface
              expect([B.CATTAILS, B.LOOSE_STONES], `${q},${r}`).toContain(above);
              expect(POND_BIOMES).toContain(biome);
              expect([B.GRASS_BLOCK, B.SNOWY_GRASS]).toContain(top);
            }
          }
          if (!table) {
            expect(FLORA_IDS.has(above) && !POND_BIOMES.includes(biome), `flora in biome ${biome}`).toBe(false);
            continue;
          }
          // Eligible after the fact: the surface (or a gravel top) with AIR or one flora block above it.
          const gravelTop = top === B.GRAVEL && table.rows[0].top;
          if (!((top === table.surface && (above === B.AIR || FLORA_IDS.has(above))) || (gravelTop && above === B.AIR))) continue;
          eligible.set(biome, (eligible.get(biome) ?? 0) + 1);
          const id = gravelTop ? B.GRAVEL : above;
          if (id !== B.AIR) hits.set(`${biome}:${id}`, (hits.get(`${biome}:${id}`) ?? 0) + 1);
          if (biome === BIOME.BEACH && h >= 62 && h <= 63 && HEX_DIRS.some(([dq, dr]) => gen2.getColumn(q + dq, r + dr).height < 62)) {
            shore.n++;
            if (above === B.CATTAILS) shore.cattails++;
          }
        }
      }
    }
    let rows = 0;
    for (const biome of [BIOME.BEACH, BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY, BIOME.MOUNTAINS]) {
      const n = eligible.get(biome) ?? 0;
      expect(n, `eligible columns in biome ${biome}`).toBeGreaterThan(250);
      for (const row of FLORA_TABLE[biome].rows) {
        if (row.besideBelow !== undefined) continue; // conditional: measured on the shore below
        const ratio = (hits.get(`${biome}:${row.id}`) ?? 0) / (row.chance * n);
        expect(ratio, `biome ${biome} id ${row.id}`).toBeGreaterThanOrEqual(0.5);
        expect(ratio, `biome ${biome} id ${row.id}`).toBeLessThanOrEqual(1.5);
        rows++;
      }
    }
    expect(rows).toBe(23); // every unconditional row of the six tables
    expect(shore.n * 0.03).toBeGreaterThan(10);
    const ratio = shore.cattails / (shore.n * 0.03);
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });
});

describe('generation 2: hex ponds (§8.4)', () => {
  it('accepts exactly the candidates of the §8.4 rule (roll, biomes, heights ≥ H, no trunk within 2)', () => {
    let accepted = 0;
    let rejectedRolls = 0;
    for (let kq = -15; kq <= 15; kq++) {
      for (let kr = -15; kr <= 15; kr++) {
        const h = hash2(kq, kr, gen2.seed ^ POND_SALT);
        const q = kq * POND_CELL + 2 + (h & 7);
        const r = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        const H = gen2.getColumn(q, r).height;
        let want = ((h >>> 8) & 0xffff) / 65536 < 0.5;
        if (!want) rejectedRolls++;
        for (const [dq, dr] of DISC2) {
          const c = gen2.getColumn(q + dq, r + dr);
          if (c.height < H || !POND_BIOMES.includes(c.biome)) want = false;
        }
        for (let tkq = floorDiv(q - 8, TREE_CELL); tkq <= floorDiv(q + 8, TREE_CELL) && want; tkq++) {
          for (let tkr = floorDiv(r - 8, TREE_CELL); tkr <= floorDiv(r + 8, TREE_CELL); tkr++) {
            const t = gen2.treeTrunkAt(tkq, tkr);
            if (t && hexLength(t.tq - q, t.tr - r) <= 2) want = false;
          }
        }
        expect(gen2.pondAt(q, r), `pond ${kq},${kr}`).toBe(want);
        if (want) accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(20);
    expect(rejectedRolls).toBeGreaterThan(300); // about half of the 961 candidates fail the roll
  });

  it('writes water (ice when snowy) over clay within distance 1, the rim plants at distance 2, and nothing flows', () => {
    let water = 0;
    let ice = 0;
    let cattails = 0;
    let stones = 0;
    for (const p of pondCentres(gen2, -12, 12)) {
      const liquid = p.biome === BIOME.SNOWY ? B.ICE : B.WATER;
      if (liquid === B.ICE) ice++;
      else water++;
      for (const [dq, dr, d] of DISC2) {
        const q = p.q + dq;
        const r = p.r + dr;
        const height = gen2.getColumn(q, r).height;
        expect(height).toBeGreaterThanOrEqual(p.H);
        if (d <= 1) {
          if (height === p.H) {
            expect(cell2(q, p.H, r)).toBe(liquid);
            expect(cell2(q, p.H - 1, r)).toBe(B.CLAY);
            expect([B.AIR, ...LEAF_IDS]).toContain(cell2(q, p.H + 1, r)); // open water: no trunk, no plant
            // Every side neighbour at H is the same water or solid, so the pond never flows.
            for (const [nq, nr] of HEX_DIRS) {
              const n = cell2(q + nq, p.H, r + nr);
              expect(n === liquid || isSolid(n), `${q + nq},${p.H},${r + nr} = ${n}`).toBe(true);
            }
          } else {
            expect(gen2.pondAt(q, r)).toBe(false);
            expect(cell2(q, p.H, r)).not.toBe(liquid);
          }
        } else if (height === p.H) {
          const rim = hash3(q, r, POND_SALT, gen2.seed);
          const v = cell2(q, p.H + 1, r);
          if ((rim & 3) === 0) {
            expect(v).toBe(B.CATTAILS);
            cattails++;
          } else if ((rim & 7) === 1) {
            expect(v).toBe(B.LOOSE_STONES);
            stones++;
          } else {
            // No rim plant (flora may still put loose stones or a plant there later; it never grows cattails here).
            expect(v, `${q},${r}`).not.toBe(B.CATTAILS);
          }
        }
      }
    }
    expect(water).toBeGreaterThan(0);
    expect(ice).toBeGreaterThan(0);
    expect(cattails).toBeGreaterThan(0);
    expect(stones).toBeGreaterThan(0);
  });

  it('a pond is never in OCEAN / BEACH / DESERT / mountain land, and pondAt is false for every column of a gen-1 world', () => {
    for (const p of pondCentres(gen2, -12, 12)) {
      expect(POND_BIOMES).toContain(p.biome);
      expect(p.H).toBeGreaterThanOrEqual(SEA_LEVEL + 3);
      expect(gen.pondAt(p.q, p.r)).toBe(false);
    }
  });
});

describe('generation 2: trees (§8.3 step 3)', () => {
  it('treeTrunkAt is exactly the gen-1 acceptance test, in both generations', () => {
    const want = new Map(expectedTrees(gen, -200, 200, -200, 200).map((t) => [`${t.tq},${t.tr}`, t]));
    let n = 0;
    for (let kq = floorDiv(-200, TREE_CELL) - 1; kq <= floorDiv(200, TREE_CELL) + 1; kq++) {
      for (let kr = floorDiv(-200, TREE_CELL) - 1; kr <= floorDiv(200, TREE_CELL) + 1; kr++) {
        const t1 = gen.treeTrunkAt(kq, kr);
        const t2 = gen2.treeTrunkAt(kq, kr);
        expect(t2 === null).toBe(t1 === null);
        if (!t1) continue;
        expect({ ...t2, species: 'oak' }).toEqual(t1);
        if (t1.tq < -200 || t1.tq > 200 || t1.tr < -200 || t1.tr > 200) continue;
        const e = want.get(`${t1.tq},${t1.tr}`);
        expect(e, `${t1.tq},${t1.tr}`).toBeDefined();
        expect([e.base, e.top]).toEqual([t1.height + 1, t1.height + t1.trunk]);
        n++;
      }
    }
    expect(n).toBe(want.size);
  });

  it('spruce in SNOWY, birch in FOREST when ((hsh >>> 24) & 3) === 0, oak elsewhere; generation 1 is all oak', () => {
    const species = { oak: 0, spruce: 0, birch: 0 };
    for (let kq = -80; kq <= 80; kq++) {
      for (let kr = -80; kr <= 80; kr++) {
        const t1 = gen.treeTrunkAt(kq, kr);
        if (t1) expect(t1.species).toBe('oak');
        const t = gen2.treeTrunkAt(kq, kr);
        if (!t) continue;
        const hsh = hash2(kq, kr, gen2.seed ^ 0x7ee5);
        let want = 'oak';
        if (t.biome === BIOME.SNOWY) want = 'spruce';
        else if (t.biome === BIOME.FOREST && ((hsh >>> 24) & 3) === 0) want = 'birch';
        expect(t.species).toBe(want);
        species[t.species]++;
      }
    }
    expect(species.spruce).toBeGreaterThan(0);
    expect(species.birch).toBeGreaterThan(0);
    expect(species.oak).toBeGreaterThan(species.birch); // birch is a quarter of the forest
  });

  it('the scan holds spruce logs only in SNOWY columns and birch logs in FOREST ones (with their own leaves)', () => {
    const found = { spruce: 0, birch: 0, spruceLeaves: 0, birchLeaves: 0 };
    for (const [cq, cr] of scan()) {
      const d = chunk2(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const biome = d.biomes[columnIndex(lq, lr)];
          for (let y = 1; y < WORLD_HEIGHT; y++) {
            const v = at(d, lq, y, lr);
            if (v === B.SPRUCE_LEAVES) found.spruceLeaves++;
            else if (v === B.BIRCH_LEAVES) found.birchLeaves++;
            if (at(d, lq, y - 1, lr) === v) continue; // count trunk bases only
            if (v === B.SPRUCE_LOG) {
              expect(biome).toBe(BIOME.SNOWY);
              found.spruce++;
            } else if (v === B.BIRCH_LOG) {
              expect(biome).toBe(BIOME.FOREST);
              found.birch++;
            } else if (v === B.OAK_LOG) {
              expect(biome).not.toBe(BIOME.SNOWY);
            }
          }
        }
      }
    }
    expect(found.spruce).toBeGreaterThan(0);
    expect(found.birch).toBeGreaterThan(0);
    expect(found.spruceLeaves).toBeGreaterThan(found.spruce);
    expect(found.birchLeaves).toBeGreaterThan(found.birch);
  });

  it('no trunk stands in or beside a pond, and treeTrunkAt never consults ponds (spy)', () => {
    const g = createWorldGen(SEED, { gen: 2 });
    expect(g.treeTrunkAt.toString()).not.toMatch(/pond/i);
    const pondSpy = vi.spyOn(g, 'pondAt');
    for (let kq = -40; kq <= 40; kq++) for (let kr = -40; kr <= 40; kr++) g.treeTrunkAt(kq, kr);
    for (const [cq, cr] of [[0, 0], [1, 1], [-2, 3]]) g.generateChunk(cq, cr);
    expect(pondSpy).not.toHaveBeenCalled();
    pondSpy.mockRestore();
    // Ponds do consult the trees (through the same treeTrunkAt that places them).
    const trunkSpy = vi.spyOn(g, 'treeTrunkAt');
    const ponds = pondCentres(g, -12, 12);
    expect(trunkSpy).toHaveBeenCalled();
    trunkSpy.mockRestore();
    // Every trunk is at least 3 from every pond centre, so never on or next to its water.
    for (const p of ponds) {
      for (let tkq = floorDiv(p.q - 8, TREE_CELL); tkq <= floorDiv(p.q + 8, TREE_CELL); tkq++) {
        for (let tkr = floorDiv(p.r - 8, TREE_CELL); tkr <= floorDiv(p.r + 8, TREE_CELL); tkr++) {
          const t = g.treeTrunkAt(tkq, tkr);
          if (t) expect(hexLength(t.tq - p.q, t.tr - p.r)).toBeGreaterThanOrEqual(3);
        }
      }
      for (const [dq, dr, d] of DISC2) {
        if (d > 1) continue;
        for (let y = p.H; y <= p.H + 6; y++) expect([B.OAK_LOG, B.SPRUCE_LOG, B.BIRCH_LOG]).not.toContain(cell2(p.q + dq, y, p.r + dr));
      }
    }
  });
});
