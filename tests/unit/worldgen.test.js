// Tests for src/worldgen.js -- see src/CONTRACTS.md section 8 and docs/PLAN-build.md section 2.4.
// Every sample point is derived from fixed seeds / mulberry32, so the suite is fully deterministic.
import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT,
} from '../../src/config.js';
import { columnIndex, localIndex, floorDiv } from '../../src/coords.js';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { normalizeSeed, hash2, mulberry32 } from '../../src/noise.js';
import { createWorldGen, TREE_CELL, TREE_DENSITY, ORE_TABLE } from '../../src/worldgen.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const ORE_IDS = new Set([B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE]);
const TREE_IDS = new Set([B.OAK_LOG, B.OAK_LEAVES]);

/** One shared generator; chunk results are cached so the whole file stays fast. */
const gen = createWorldGen(SEED);
const chunkCache = new Map();
function chunk(cx, cz) {
  const key = `${cx},${cz}`;
  let c = chunkCache.get(key);
  if (!c) {
    c = gen.generateChunk(cx, cz);
    chunkCache.set(key, c);
  }
  return c;
}

/** Block at local coords of a ChunkData. */
function at(data, lx, ly, lz) {
  return data.blocks[localIndex(lx, ly, lz)];
}

/**
 * Merge an ncx x ncz block of chunks (starting at chunk cx0, cz0) into one world-coordinate view.
 * get(wx, wy, wz) returns -1 outside the view.
 */
function mergedView(cx0, cz0, ncx, ncz) {
  const W = ncx * CHUNK_SIZE;
  const D = ncz * CHUNK_SIZE;
  const blocks = new Uint8Array(W * D * WORLD_HEIGHT);
  const heights = new Int16Array(W * D);
  const biomes = new Uint8Array(W * D);
  for (let cx = cx0; cx < cx0 + ncx; cx++) {
    for (let cz = cz0; cz < cz0 + ncz; cz++) {
      const data = chunk(cx, cz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const vx = (cx - cx0) * CHUNK_SIZE + lx;
          const vz = (cz - cz0) * CHUNK_SIZE + lz;
          const src = localIndex(lx, 0, lz);
          blocks.set(data.blocks.subarray(src, src + WORLD_HEIGHT), (vx * D + vz) * WORLD_HEIGHT);
          heights[vx * D + vz] = data.heights[columnIndex(lx, lz)];
          biomes[vx * D + vz] = data.biomes[columnIndex(lx, lz)];
        }
      }
    }
  }
  const x0 = cx0 * CHUNK_SIZE;
  const z0 = cz0 * CHUNK_SIZE;
  const inView = (wx, wz) => wx >= x0 && wx < x0 + W && wz >= z0 && wz < z0 + D;
  return {
    x0, z0, W, D, blocks,
    inView,
    get(wx, wy, wz) {
      if (!inView(wx, wz) || wy < 0 || wy >= WORLD_HEIGHT) return -1;
      return blocks[((wx - x0) * D + (wz - z0)) * WORLD_HEIGHT + wy];
    },
    height(wx, wz) {
      return heights[(wx - x0) * D + (wz - z0)];
    },
    biome(wx, wz) {
      return biomes[(wx - x0) * D + (wz - z0)];
    },
  };
}

/**
 * Independent re-derivation of the contract's tree placement (section 8.2 step 4) so the tests can
 * check the generator's stamping against the pure getColumn-based rule.
 * @returns {{tx:number, tz:number, base:number, top:number}[]} trees whose trunk cell lies in the given world rect
 */
function expectedTrees(worldGen, xMin, xMax, zMin, zMax) {
  const out = [];
  const treeSeed = worldGen.seed ^ 0x7ee5;
  for (let kx = floorDiv(xMin - 3, TREE_CELL); kx <= floorDiv(xMax + 3, TREE_CELL); kx++) {
    for (let kz = floorDiv(zMin - 3, TREE_CELL); kz <= floorDiv(zMax + 3, TREE_CELL); kz++) {
      const hsh = hash2(kx, kz, treeSeed);
      const tx = kx * TREE_CELL + 1 + (hsh & 3);
      const tz = kz * TREE_CELL + 1 + ((hsh >>> 2) & 3);
      if (tx < xMin || tx > xMax || tz < zMin || tz > zMax) continue;
      const trunk = 4 + ((hsh >>> 4) % 3);
      const roll = ((hsh >>> 8) & 0xffff) / 65536;
      const col = worldGen.getColumn(tx, tz);
      if (roll < TREE_DENSITY[col.biome] && col.height >= SEA_LEVEL + 2 && col.height + trunk + 2 < WORLD_HEIGHT) {
        out.push({ tx, tz, base: col.height + 1, top: col.height + trunk });
      }
    }
  }
  return out;
}

/** Canopy offsets of the contract: [dx, dy(relative to top), dz]. */
function canopyCells(top) {
  const cells = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const adx = Math.abs(dx);
      const adz = Math.abs(dz);
      if (!(adx === 2 && adz === 2)) {
        cells.push([dx, top - 1, dz]);
        cells.push([dx, top, dz]);
      }
      if (adx <= 1 && adz <= 1) cells.push([dx, top + 1, dz]);
      if (adx + adz <= 1) cells.push([dx, top + 2, dz]);
    }
  }
  return cells;
}

/**
 * Verify one tree in a merged view: trunk logs present, every canopy cell inside the view is
 * non-AIR (either LEAVES or something that was already there), and the top is surrounded by leaves.
 */
function checkTreeInView(view, t, { requireLeaves }) {
  for (let y = t.base; y <= t.top; y++) {
    expect(view.get(t.tx, y, t.tz)).toBe(B.OAK_LOG);
  }
  // Rooted: the block below the trunk base is the surface block of the column.
  expect([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT]).toContain(view.get(t.tx, t.base - 1, t.tz));
  expect(view.height(t.tx, t.tz)).toBe(t.base - 1);
  let leaves = 0;
  let truncated = 0;
  for (const [dx, y, dz] of canopyCells(t.top)) {
    const v = view.get(t.tx + dx, y, t.tz + dz);
    if (v === -1) continue; // outside the merged view
    if (v === B.AIR) truncated++;
    if (v === B.OAK_LEAVES) leaves++;
  }
  expect(truncated).toBe(0);
  if (requireLeaves) expect(leaves).toBeGreaterThanOrEqual(4);
  return leaves;
}

describe('worldgen exports', () => {
  it('exposes the contract constants', () => {
    expect(TREE_CELL).toBe(6);
    expect(Array.from(TREE_DENSITY)).toEqual([0, 0, 0.06, 0.7, 0, 0.06, 0, 0]);
    expect(TREE_DENSITY[BIOME.FOREST]).toBe(0.7);
    expect(TREE_DENSITY[BIOME.DESERT]).toBe(0);
    expect(ORE_TABLE.map((o) => o.id)).toEqual([B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.GRAVEL, B.DIRT]);
    expect(ORE_TABLE[0]).toMatchObject({ attempts: 18, minY: 8, maxY: 100, minSize: 6, maxSize: 10 });
    expect(ORE_TABLE[1]).toMatchObject({ attempts: 12, minY: 4, maxY: 60, minSize: 4, maxSize: 8 });
    expect(ORE_TABLE[2]).toMatchObject({ attempts: 3, minY: 4, maxY: 30, minSize: 3, maxSize: 6 });
    expect(ORE_TABLE[3]).toMatchObject({ attempts: 1, minY: 2, maxY: 14, minSize: 2, maxSize: 5 });
    expect(ORE_TABLE[4]).toMatchObject({ attempts: 4, minY: 8, maxY: 70, minSize: 10, maxSize: 16 });
    expect(ORE_TABLE[5]).toMatchObject({ attempts: 6, minY: 8, maxY: 90, minSize: 10, maxSize: 16 });
  });

  it('normalises the seed like noise.normalizeSeed', () => {
    expect(gen.seed).toBe(normalizeSeed(SEED));
    expect(createWorldGen(42).seed).toBe(42);
    expect(createWorldGen('42').seed).toBe(42);
    expect(createWorldGen(-1).seed).toBe(0xffffffff);
    expect(createWorldGen(undefined).seed).toBe(0);
  });
});

describe('createWorldGen determinism', () => {
  it('produces identical chunks for the same seed and coordinates', () => {
    const a = createWorldGen(SEED).generateChunk(2, -3);
    const b = createWorldGen(SEED).generateChunk(2, -3);
    expect(a.blocks).toEqual(b.blocks);
    expect(a.biomes).toEqual(b.biomes);
    expect(a.heights).toEqual(b.heights);
  });

  it('treats numeric and numeric-string seeds identically', () => {
    const a = createWorldGen(1234).generateChunk(0, 0);
    const b = createWorldGen('1234').generateChunk(0, 0);
    expect(a.blocks).toEqual(b.blocks);
  });

  it('returns fresh arrays of the right sizes on every call', () => {
    const a = gen.generateChunk(0, 0);
    const b = gen.generateChunk(0, 0);
    expect(a.blocks).not.toBe(b.blocks);
    expect(a.biomes).not.toBe(b.biomes);
    expect(a.heights).not.toBe(b.heights);
    expect(a.blocks).toBeInstanceOf(Uint8Array);
    expect(a.blocks.length).toBe(CHUNK_VOLUME);
    expect(a.biomes.length).toBe(CHUNK_AREA);
    expect(a.heights.length).toBe(CHUNK_AREA);
  });

  it('differs for a different seed and for a different chunk', () => {
    const a = chunk(0, 0);
    const other = createWorldGen('another seed').generateChunk(0, 0);
    expect(a.blocks).not.toEqual(other.blocks);
    expect(a.blocks).not.toEqual(chunk(1, 0).blocks);
  });
});

describe('getColumn', () => {
  it('is pure, accepts negatives and respects the height/biome rules', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 300; i++) {
      const wx = Math.floor((rng() - 0.5) * 20000);
      const wz = Math.floor((rng() - 0.5) * 20000);
      const c = gen.getColumn(wx, wz);
      expect(gen.getColumn(wx, wz)).toEqual(c);
      expect(Number.isInteger(c.height)).toBe(true);
      expect(c.height).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
      expect(c.height).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
      expect(c.temperature).toBeGreaterThanOrEqual(-1);
      expect(c.temperature).toBeLessThanOrEqual(1);
      expect(c.humidity).toBeGreaterThanOrEqual(-1);
      expect(c.humidity).toBeLessThanOrEqual(1);
      const isDesert = c.temperature > 0.35 && c.humidity < 0;
      let biome;
      if (c.height <= SEA_LEVEL - 2) biome = BIOME.OCEAN;
      else if (c.height <= SEA_LEVEL + 2) biome = BIOME.BEACH;
      else if (c.height >= 92) biome = BIOME.SNOWY_PEAKS;
      else if (c.height >= 84) biome = BIOME.MOUNTAINS;
      else if (c.temperature < -0.35) biome = BIOME.SNOWY;
      else if (isDesert) biome = BIOME.DESERT;
      else if (c.humidity > 0.15) biome = BIOME.FOREST;
      else biome = BIOME.PLAINS;
      expect(c.biome).toBe(biome);
    }
  });

  it('agrees with the generated heights and biomes for 50 random columns', () => {
    const rng = mulberry32(2024);
    for (let i = 0; i < 50; i++) {
      const cx = Math.floor(rng() * 5) - 2;
      const cz = Math.floor(rng() * 5) - 2;
      const lx = Math.floor(rng() * CHUNK_SIZE);
      const lz = Math.floor(rng() * CHUNK_SIZE);
      const data = chunk(cx, cz);
      const col = gen.getColumn(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
      const ci = columnIndex(lx, lz);
      expect(data.heights[ci]).toBe(col.height);
      expect(data.biomes[ci]).toBe(col.biome);
      // The top terrain block is present (caves never reach it) and everything above it up to the
      // sea level is water or air/tree.
      const top = at(data, lx, col.height, lz);
      expect(top).not.toBe(B.AIR);
      expect(top).not.toBe(B.WATER);
      expect(TREE_IDS.has(top)).toBe(false);
    }
  });
});

describe('column composition', () => {
  const coords = [[0, 0], [1, 0], [-1, -1], [3, -2], [-4, 2]];

  it('has BEDROCK at y=0 in every column and never carves it', () => {
    for (const [cx, cz] of coords) {
      const data = chunk(cx, cz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          expect(at(data, lx, 0, lz)).toBe(B.BEDROCK);
          for (let y = 1; y <= 2; y++) {
            const v = at(data, lx, y, lz);
            expect(v === B.BEDROCK || v === B.STONE || ORE_IDS.has(v) || v === B.GRAVEL || v === B.DIRT).toBe(true);
          }
        }
      }
    }
  });

  it('uses the seeded bedrock probabilities at y=1 and y=2', () => {
    let y1 = 0;
    let y2 = 0;
    let n = 0;
    for (const [cx, cz] of coords) {
      const data = chunk(cx, cz);
      for (let ci = 0; ci < CHUNK_AREA; ci++) {
        n++;
        if (data.blocks[ci * WORLD_HEIGHT + 1] === B.BEDROCK) y1++;
        if (data.blocks[ci * WORLD_HEIGHT + 2] === B.BEDROCK) y2++;
      }
    }
    expect(y1 / n).toBeGreaterThan(0.4);
    expect(y1 / n).toBeLessThan(0.6);
    expect(y2 / n).toBeGreaterThan(0.08);
    expect(y2 / n).toBeLessThan(0.25);
  });

  it('follows the surface rules: grass over dirt, water only at/below sea level above terrain', () => {
    for (const [cx, cz] of coords) {
      const data = chunk(cx, cz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const ci = columnIndex(lx, lz);
          const h = data.heights[ci];
          const biome = data.biomes[ci];
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const v = at(data, lx, y, lz);
            if (v === B.GRASS_BLOCK) {
              expect(y).toBe(h);
              expect(at(data, lx, y - 1, lz)).toBe(B.DIRT);
              expect([BIOME.PLAINS, BIOME.FOREST]).toContain(biome);
            }
            if (v === B.SNOWY_GRASS) {
              expect(y).toBe(h);
              expect(at(data, lx, y - 1, lz)).toBe(B.DIRT);
              expect(biome).toBe(BIOME.SNOWY);
            }
            if (v === B.WATER) {
              expect(y).toBeLessThanOrEqual(SEA_LEVEL);
              expect(y).toBeGreaterThan(h);
            }
            if (y > h && y <= SEA_LEVEL && h < SEA_LEVEL) expect(v).toBe(B.WATER);
          }
          // The terrain top block is intact and biome-appropriate.
          const top = at(data, lx, h, lz);
          switch (biome) {
            case BIOME.OCEAN: expect(top).toBe(h >= 58 ? B.SAND : B.GRAVEL); break;
            case BIOME.BEACH: expect(top).toBe(B.SAND); break;
            case BIOME.PLAINS:
            case BIOME.FOREST: expect(top).toBe(B.GRASS_BLOCK); break;
            case BIOME.SNOWY: expect(top).toBe(B.SNOWY_GRASS); break;
            case BIOME.DESERT:
              expect(top).toBe(B.SAND);
              for (let y = h - 3; y >= h - 6; y--) expect(at(data, lx, y, lz)).toBe(B.SANDSTONE);
              break;
            case BIOME.MOUNTAINS: expect(top).toBe(B.STONE); break;
            case BIOME.SNOWY_PEAKS:
              expect(top).toBe(B.SNOW_BLOCK);
              expect(at(data, lx, h - 1, lz)).toBe(B.STONE);
              break;
            default: throw new Error(`unknown biome ${biome}`);
          }
          if (h < SEA_LEVEL) expect(at(data, lx, SEA_LEVEL + 1, lz)).not.toBe(B.WATER);
        }
      }
    }
  });

  it('places nothing above MAX_TERRAIN_HEIGHT + 8 except leaves and logs', () => {
    for (const [cx, cz] of coords) {
      const data = chunk(cx, cz);
      for (let ci = 0; ci < CHUNK_AREA; ci++) {
        for (let y = MAX_TERRAIN_HEIGHT + 9; y < WORLD_HEIGHT; y++) {
          const v = data.blocks[ci * WORLD_HEIGHT + y];
          expect(v === B.AIR || TREE_IDS.has(v)).toBe(true);
        }
      }
    }
  });
});

describe('biome coverage (5x5 scan)', () => {
  it('finds water somewhere and at least one forest with logs', () => {
    let water = 0;
    let forestLogs = 0;
    const biomesSeen = new Set();
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const data = chunk(cx, cz);
        let logs = 0;
        let forestCols = 0;
        for (let ci = 0; ci < CHUNK_AREA; ci++) {
          biomesSeen.add(data.biomes[ci]);
          if (data.biomes[ci] === BIOME.FOREST) forestCols++;
        }
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          const v = data.blocks[i];
          if (v === B.WATER) water++;
          else if (v === B.OAK_LOG) logs++;
        }
        if (forestCols > 0 && logs > 0) forestLogs += logs;
      }
    }
    expect(water).toBeGreaterThan(0);
    expect(forestLogs).toBeGreaterThan(0);
    expect(biomesSeen.has(BIOME.FOREST)).toBe(true);
    expect(biomesSeen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('trees', () => {
  it('are rooted: every LOG stands on GRASS_BLOCK/SNOWY_GRASS/DIRT/LOG and never below sea level', () => {
    let logs = 0;
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const data = chunk(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            for (let y = 1; y < WORLD_HEIGHT; y++) {
              if (at(data, lx, y, lz) !== B.OAK_LOG) continue;
              logs++;
              expect(y).toBeGreaterThan(SEA_LEVEL + 2);
              expect([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT, B.OAK_LOG]).toContain(at(data, lx, y - 1, lz));
            }
          }
        }
      }
    }
    expect(logs).toBeGreaterThan(0);
  });

  it('match the getColumn-only placement rule and have >= 4 leaves around the top log', () => {
    // Use a 3x3 merged view and inspect the trees rooted in the centre chunk so the whole canopy
    // is inside the view.
    let trees = 0;
    for (const [ccx, ccz] of [[0, 0], [-1, 1], [2, -2], [1, 1]]) {
      const view = mergedView(ccx - 1, ccz - 1, 3, 3);
      const x0 = ccx * CHUNK_SIZE;
      const z0 = ccz * CHUNK_SIZE;
      const expected = expectedTrees(gen, x0, x0 + 15, z0, z0 + 15);
      for (const t of expected) {
        expect(t.top - t.base + 1).toBeGreaterThanOrEqual(4);
        expect(t.top - t.base + 1).toBeLessThanOrEqual(6);
        checkTreeInView(view, t, { requireLeaves: true });
        trees++;
      }
      // Conversely, every trunk base in the centre chunk is one of the expected trees.
      const bases = new Set(expected.map((t) => `${t.tx},${t.base},${t.tz}`));
      for (let wx = x0; wx < x0 + 16; wx++) {
        for (let wz = z0; wz < z0 + 16; wz++) {
          for (let y = 1; y < WORLD_HEIGHT; y++) {
            if (view.get(wx, y, wz) === B.OAK_LOG && view.get(wx, y - 1, wz) !== B.OAK_LOG) {
              expect(bases.has(`${wx},${y},${wz}`)).toBe(true);
            }
          }
        }
      }
    }
    expect(trees).toBeGreaterThan(0);
  });

  it('are never stamped outside the chunk that is generated and only fill AIR with leaves', () => {
    // A tree rooted just outside chunk (0,0) still contributes its in-chunk canopy cells; a chunk
    // must contain no tree blocks unless a valid tree overlaps it.
    const data = chunk(0, 0);
    const trees = expectedTrees(gen, -2, 17, -2, 17);
    const allowed = new Set();
    for (const t of trees) {
      for (let y = t.base; y <= t.top; y++) allowed.add(`${t.tx},${y},${t.tz}`);
      for (const [dx, y, dz] of canopyCells(t.top)) allowed.add(`${t.tx + dx},${y},${t.tz + dz}`);
    }
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const v = at(data, lx, y, lz);
          if (TREE_IDS.has(v)) expect(allowed.has(`${lx},${y},${lz}`)).toBe(true);
        }
      }
    }
  });
});

describe('cross-chunk consistency', () => {
  it('shows no truncated canopies across a chunk border in a merged 32-wide view', () => {
    // Pick a border (cx,cz)/(cx+1,cz) where at least one tree trunk stands within 2 blocks of the
    // seam (so its radius-2 canopy covers both sides), keeping the check meaningful regardless of
    // the exact hash outcome for this seed.
    let cx0 = null;
    let cz0 = null;
    let straddling = [];
    outer: for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -8; cx <= 8; cx++) {
        const t = expectedTrees(gen, cx * CHUNK_SIZE + 14, cx * CHUNK_SIZE + 17, cz * CHUNK_SIZE, cz * CHUNK_SIZE + 15);
        if (t.length > 0) { cx0 = cx; cz0 = cz; straddling = t; break outer; }
      }
    }
    expect(straddling.length).toBeGreaterThan(0);
    const view = mergedView(cx0, cz0, 2, 1);
    const x0 = cx0 * CHUNK_SIZE;
    const z0 = cz0 * CHUNK_SIZE;
    const seam = x0 + CHUNK_SIZE;
    // Every tree whose canopy straddles the seam must be complete on both sides of the border.
    for (const t of straddling) checkTreeInView(view, t, { requireLeaves: false });

    // Compare each LOG/LEAVES cell near the border with what the neighbouring chunk produced
    // at the same world coordinates: both chunks must agree on the complete shape, i.e. for every
    // trunk top in the merged view the whole canopy pattern is non-AIR on both sides of the seam.
    let checked = 0;
    for (let wx = seam - 4; wx <= seam + 3; wx++) {
      for (let wz = z0; wz < z0 + CHUNK_SIZE; wz++) {
        for (let y = 1; y < WORLD_HEIGHT - 2; y++) {
          if (view.get(wx, y, wz) !== B.OAK_LOG || view.get(wx, y + 1, wz) === B.OAK_LOG) continue;
          checked++;
          for (const [dx, cy, dz] of canopyCells(y)) {
            const v = view.get(wx + dx, cy, wz + dz);
            if (v === -1) continue;
            expect(v).not.toBe(B.AIR);
          }
        }
      }
    }
    // Sanity: the region actually contains tree material on both sides of the seam.
    let borderTreeCells = 0;
    for (let wz = z0; wz < z0 + CHUNK_SIZE; wz++) {
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        if (TREE_IDS.has(view.get(seam - 1, y, wz)) && TREE_IDS.has(view.get(seam, y, wz))) borderTreeCells++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(straddling.length);
    expect(borderTreeCells).toBeGreaterThan(0);
  });

  it('keeps every tree intact across all borders of a 3x3 block around several chunks', () => {
    let straddlers = 0;
    for (const [ccx, ccz] of [[0, 0], [-2, 1], [3, -3], [-1, -1]]) {
      const view = mergedView(ccx - 1, ccz - 1, 3, 3);
      const xMin = (ccx - 1) * CHUNK_SIZE;
      const zMin = (ccz - 1) * CHUNK_SIZE;
      const trees = expectedTrees(gen, xMin, xMin + 47, zMin, zMin + 47);
      for (const t of trees) {
        // Does this tree's canopy cross an internal chunk border of the view?
        const lx = t.tx - xMin;
        const lz = t.tz - zMin;
        const crossX = Math.floor((lx - 2) / 16) !== Math.floor((lx + 2) / 16);
        const crossZ = Math.floor((lz - 2) / 16) !== Math.floor((lz + 2) / 16);
        if (crossX || crossZ) straddlers++;
        checkTreeInView(view, t, { requireLeaves: false });
      }
    }
    expect(straddlers).toBeGreaterThan(0);
  });

  it('stamps identical tree cells regardless of which chunk generates them', () => {
    // The world coordinates of tree cells at the (0,0)/(1,0) border, as produced by each chunk,
    // must be exactly the set predicted by the pure placement rule restricted to that chunk.
    for (const [cx, cz] of [[0, 0], [1, 0]]) {
      const data = chunk(cx, cz);
      const x0 = cx * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      const trees = expectedTrees(gen, x0 - 2, x0 + 17, z0 - 2, z0 + 17);
      for (const t of trees) {
        for (let y = t.base; y <= t.top; y++) {
          const lx = t.tx - x0;
          const lz = t.tz - z0;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          expect(at(data, lx, y, lz)).toBe(B.OAK_LOG);
        }
      }
    }
  });
});

describe('ores', () => {
  const view = mergedView(-2, -2, 4, 4); // 16 chunks

  function countAll() {
    const counts = new Map();
    for (let i = 0; i < view.blocks.length; i++) {
      const v = view.blocks[i];
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return counts;
  }

  it('exist with plausible counts over 16 chunks', () => {
    const counts = countAll();
    const coal = counts.get(B.COAL_ORE) ?? 0;
    const iron = counts.get(B.IRON_ORE) ?? 0;
    const gold = counts.get(B.GOLD_ORE) ?? 0;
    const diamond = counts.get(B.DIAMOND_ORE) ?? 0;
    // 18 attempts x up to 11 cells x 16 chunks = 3168 upper bound.
    expect(coal).toBeGreaterThanOrEqual(128);
    expect(coal).toBeLessThanOrEqual(3168);
    expect(iron).toBeGreaterThan(0);
    expect(iron).toBeLessThanOrEqual(coal);
    expect(gold).toBeGreaterThan(0);
    expect(gold).toBeLessThan(iron);
    expect(diamond).toBeGreaterThan(0);
    expect(diamond).toBeLessThanOrEqual(16 * 6);
  });

  it('places diamonds only deep down', () => {
    const o = ORE_TABLE[3];
    let n = 0;
    for (let wx = view.x0; wx < view.x0 + view.W; wx++) {
      for (let wz = view.z0; wz < view.z0 + view.D; wz++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          if (view.get(wx, y, wz) !== B.DIAMOND_ORE) continue;
          n++;
          // Origin y <= maxY, plus at most maxSize walk steps upward.
          expect(y).toBeLessThanOrEqual(o.maxY + o.maxSize);
          expect(y).toBeLessThan(16 + o.maxSize);
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('never appear above y 100 + walk length and every ore is adjacent to STONE', () => {
    // Ore cells were STONE, so their neighbours are STONE or something that also replaced STONE
    // (another vein cell, a DIRT/GRAVEL pocket) or cave AIR. Nearly all of them touch STONE directly.
    const stoneDerived = new Set([B.STONE, B.AIR, ...ORE_TABLE.map((o) => o.id)]);
    let ores = 0;
    let directStone = 0;
    for (let wx = view.x0; wx < view.x0 + view.W; wx++) {
      for (let wz = view.z0; wz < view.z0 + view.D; wz++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const v = view.get(wx, y, wz);
          if (!ORE_IDS.has(v)) continue;
          ores++;
          expect(y).toBeLessThanOrEqual(100 + 10);
          const nbs = [
            view.get(wx + 1, y, wz), view.get(wx - 1, y, wz),
            view.get(wx, y + 1, wz), view.get(wx, y - 1, wz),
            view.get(wx, y, wz + 1), view.get(wx, y, wz - 1),
          ];
          // Neighbours outside the merged view are unknown (-1); ignore them.
          const known = nbs.filter((n) => n !== -1);
          if (known.includes(B.STONE)) directStone++;
          expect(known.some((n) => stoneDerived.has(n))).toBe(true);
        }
      }
    }
    expect(ores).toBeGreaterThan(0);
    expect(directStone / ores).toBeGreaterThan(0.995);
  });

  it('only replaces STONE: ores never sit where terrain, water or tree blocks were', () => {
    // Ore cells must be strictly below the terrain height of their column (the surface block is
    // never STONE except in MOUNTAINS, where ores are allowed on the surface).
    for (let wx = view.x0; wx < view.x0 + view.W; wx++) {
      for (let wz = view.z0; wz < view.z0 + view.D; wz++) {
        const h = view.height(wx, wz);
        const biome = view.biome(wx, wz);
        for (let y = h; y < WORLD_HEIGHT; y++) {
          const v = view.get(wx, y, wz);
          if (ORE_IDS.has(v)) {
            expect(y).toBe(h);
            expect(biome).toBe(BIOME.MOUNTAINS);
          }
        }
      }
    }
  });
});

describe('caves', () => {
  it('carve some underground AIR below y 50 but not too much, and never in ocean/beach columns above y 50', () => {
    let air = 0;
    let cells = 0;
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        const data = chunk(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const ci = columnIndex(lx, lz);
            const h = data.heights[ci];
            const biome = data.biomes[ci];
            for (let y = 3; y <= h - 4 && y < 50; y++) {
              cells++;
              if (at(data, lx, y, lz) === B.AIR) air++;
            }
            // Never carve the top 4 terrain blocks.
            for (let y = Math.max(0, h - 3); y <= h; y++) expect(at(data, lx, y, lz)).not.toBe(B.AIR);
            // Below y 6 nothing is carved.
            for (let y = 0; y < 6; y++) expect(at(data, lx, y, lz)).not.toBe(B.AIR);
            // Ocean/beach columns are never drained.
            if (biome === BIOME.OCEAN || biome === BIOME.BEACH) {
              for (let y = SEA_LEVEL - 11; y <= h; y++) expect(at(data, lx, y, lz)).not.toBe(B.AIR);
            }
          }
        }
      }
    }
    expect(air).toBeGreaterThan(0);
    expect(air / cells).toBeLessThan(0.4);
  });
});

describe('performance', () => {
  it('generates 9 chunks in under 3000 ms', () => {
    const g = createWorldGen('perf');
    const t0 = performance.now();
    for (let cx = 10; cx < 13; cx++) {
      for (let cz = 10; cz < 13; cz++) g.generateChunk(cx, cz);
    }
    const ms = performance.now() - t0;
    console.log(`worldgen: 9 chunks in ${ms.toFixed(1)} ms (${(ms / 9).toFixed(2)} ms/chunk)`);
    expect(ms).toBeLessThan(3000);
  });
});
