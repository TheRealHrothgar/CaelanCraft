// Tests for src/worldgen.js -- see src/CONTRACTS.md §8.
// Cells are hexagonal prisms addressed by axial (q, r) + y. Every sample point is derived from fixed
// seeds / mulberry32, so the suite is fully deterministic.
import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT,
} from '../../src/config.js';
import { columnIndex, localIndex, floorDiv } from '../../src/coords.js';
import { HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { normalizeSeed, hash2, rand3, mulberry32 } from '../../src/noise.js';
import { createWorldGen, TREE_CELL, TREE_DENSITY, ORE_TABLE } from '../../src/worldgen.js';

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
 * get(q, y, r) returns -1 outside the view.
 */
function mergedView(cq0, cr0, ncq, ncr) {
  const W = ncq * CHUNK_SIZE;
  const D = ncr * CHUNK_SIZE;
  const blocks = new Uint8Array(W * D * WORLD_HEIGHT);
  const heights = new Int16Array(W * D);
  const biomes = new Uint8Array(W * D);
  for (let cq = cq0; cq < cq0 + ncq; cq++) {
    for (let cr = cr0; cr < cr0 + ncr; cr++) {
      const data = chunk(cq, cr);
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
});
