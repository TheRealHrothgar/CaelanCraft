// Generation 5 (CONTRACTS §85): generation 4 with rare natural springs, and its surface gravel in small beds instead
// of single cells. Generations 1–4 must stay byte for byte what they were; generation 5 may differ from generation 4
// only at a column's surface block and in the cell on it.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, GEN_LATEST, SEA_LEVEL } from '../../src/config.js';
import { BLOCK, BLOCKS, BIOME } from '../../src/blocks.js';
import { HEX_DIRS, hexLength } from '../../src/hex.js';
import {
  createWorldGen, FLORA_TABLE, PATCH_SALT, PLANT_PATCH_SALT, PLANT_PATCHES_GEN4, GRAVEL_PATCH_SALT, GRAVEL_PATCHES_GEN5,
  NATURAL_SPRING_CELL, NATURAL_SPRING_SALT, NATURAL_SPRING_CHANCE, NATURAL_SPRING_SEARCH, NATURAL_SPRING_MIN_HIGHER, NATURAL_SPRING_CLEAR,
} from '../../src/worldgen.js';
import { GRAVEL_FLINT_P, rollDrops } from '../../src/harvest.js';
import { SPRING_NEAREST_CELLS } from '../../src/homestead.js';

const B = BLOCK;
const SEED = 4242;
const N = 10; // the measured land: the 21 × 21 chunks round the origin, 112 896 columns
const gen4 = createWorldGen(SEED, { gen: 4 });
const gen5 = createWorldGen(SEED, { gen: 5 });
const key = (q, r) => `${q},${r}`;

/** Both generations of the measured land, chunk by chunk, with what the tests below count. */
const LAND = (() => {
  const out = {
    columns: new Array(8).fill(0),
    /** surface gravel by generation: "q,r" of every column outside the ocean whose top block is GRAVEL under AIR */
    gravel: { 4: new Set(), 5: new Set() },
    gravelBy: { 4: new Array(8).fill(0), 5: new Array(8).fill(0) },
    buried: { 4: 0, 5: 0 },
    springs: /** @type {number[][]} */ ([]),
    springs4: 0,
    /** every cell that differs between the two: [q, y, r, height, id4, id5, biome] */
    diff: /** @type {number[][]} */ ([]),
  };
  for (let cq = -N; cq <= N; cq++) {
    for (let cr = -N; cr <= N; cr++) {
      const a = gen4.generateChunk(cq, cr);
      const b = gen5.generateChunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const ci = lq * CHUNK_SIZE + lr;
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const biome = b.biomes[ci];
          const h = b.heights[ci];
          out.columns[biome]++;
          const base = ci * WORLD_HEIGHT;
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const x = a.blocks[base + y];
            const z = b.blocks[base + y];
            if (x !== z) out.diff.push([q, y, r, h, x, z, biome]);
            if (x === B.SPRING) out.springs4++;
            if (z === B.SPRING) out.springs.push([q, y, r, h]);
            if (y !== h) {
              if (x === B.GRAVEL) out.buried[4]++;
              if (z === B.GRAVEL) out.buried[5]++;
            }
          }
          if (biome === BIOME.OCEAN) continue;
          for (const [g, c] of [[4, a], [5, b]]) {
            if (c.blocks[base + h] === B.GRAVEL && c.blocks[base + h + 1] === B.AIR) {
              out.gravel[g].add(key(q, r));
              out.gravelBy[g][biome]++;
            }
          }
        }
      }
    }
  }
  return out;
})();

/**
 * sha1 digests of generations 1–4, by seed: the blocks, biomes and heights of the 9 × 9 chunks round the origin, in
 * (cq, cr) order, taken at 240e2a4 (the commit §85 starts from) with the loop below.
 */
const DIGESTS = {
  'caelancraft-test': ['78cc2c6617fa5e60f97edf067c9d6b579d6547c4', '86c61a5c42ea35daf6823909d6d1e4b52f5e7d86', '2a59116110c487e1edd6b92b2d1bb82e75c281bc', '104dae6aa63723859dcd0ae7f3c5c23e1558be85'],
  4242: ['01d3d36d0e8f773e826216a8f0206d41c3888cdb', '7c9407ccfddcf1a9466af38aa9ab02d59563db5f', 'b03e6c6aefb1e6e0753661db1bd96eef3ac7edc1', 'b577abdbcb5c4f7b371910fa20f4340ef68a2624'],
  homestead: ['3c168568399f18c02e95e66f9ac95ad8d86e88dd', 'ed580564531568c5bd273b689797312a2d6a4a2a', 'd5441e10d42ceca5b2c16054b0eb4adf0667a896', 'b586f25359b120d81270f8c3fa4982115161f3f5'],
};

describe('generations 1–4 are byte for byte what they were before §85', () => {
  const digest = (seed, gen) => {
    const g = createWorldGen(seed, { gen });
    const h = createHash('sha1');
    for (let cq = -4; cq <= 4; cq++) {
      for (let cr = -4; cr <= 4; cr++) {
        const c = g.generateChunk(cq, cr);
        h.update(Buffer.from(c.blocks));
        h.update(Buffer.from(c.biomes));
        h.update(Buffer.from(c.heights));
      }
    }
    return h.digest('hex');
  };

  it('the digests of 81 chunks of each generation, on three seeds, are the ones taken from the code before the change', () => {
    for (const seed of ['caelancraft-test', 4242, 'homestead']) {
      expect([1, 2, 3, 4].map((gen) => digest(seed, gen)), String(seed)).toEqual(DIGESTS[seed]);
    }
  });

  it('no spring rises below generation 5, and the generator says so', () => {
    expect(LAND.springs4).toBe(0);
    for (const gen of [1, 2, 3, 4]) {
      const g = createWorldGen(SEED, { gen });
      for (let kq = -3; kq <= 3; kq++) for (let kr = -3; kr <= 3; kr++) expect(g.naturalSpringOf(kq, kr)).toBeNull();
      for (const [q, , r] of LAND.springs) expect(g.naturalSpringAt(q, r)).toBe(false);
    }
  });
});

describe('generation 5 is generation 4 but for its surface (worldgen.js, CONTRACTS §85)', () => {
  it('is the newest generation; its heights, biomes, trees, streams, ponds and everything under the ground are generation 4\'s', () => {
    expect(GEN_LATEST).toBe(5);
    expect(gen5.gen).toBe(5);
    expect(createWorldGen(SEED, { gen: 9 }).gen).toBe(5);
    expect(createWorldGen(SEED).gen).toBe(1);
    expect(gen5.PATCH_TABLE).toBe(gen4.PATCH_TABLE);
    expect(gen5.FLORA_TABLE).toBe(gen4.FLORA_TABLE);
    expect(LAND.diff.length).toBeGreaterThan(1000);
    for (const [q, y, r, h] of LAND.diff) expect(y === h || y === h + 1, `${q},${y},${r} (height ${h})`).toBe(true);
    // so the gravel under the ground is untouched, vein for vein
    expect(LAND.buried[5]).toBe(LAND.buried[4]);
    expect(LAND.buried[4]).toBeGreaterThan(10000);
  });

  it('what differs: a surface block that is gravel in one and the biome\'s own in the other, a spring, and the plant such a column carries', () => {
    const tops = new Map(); // "q,r" → [id4, id5] where the surface differs
    for (const [q, y, r, h, x, z] of LAND.diff) if (y === h) tops.set(key(q, r), [x, z]);
    for (const [q, y, r, h, x, z, biome] of LAND.diff) {
      const at = `${q},${y},${r}`;
      const surface = FLORA_TABLE[biome]?.surface;
      if (y === h) {
        if (z === B.SPRING) continue; // a spring takes the place of whatever the surface was
        expect([x, z].includes(B.GRAVEL), at).toBe(true);
        expect([x, z].includes(surface), at).toBe(true);
      } else {
        const top = tops.get(key(q, r));
        expect(top, at).toBeDefined(); // a plant never moves unless the ground under it changed
        // gravel or a spring took the ground: what stood on it is gone; the ground came back: a plant may stand on it now
        if (top[1] === B.GRAVEL || top[1] === B.SPRING) expect(z, at).toBe(B.AIR);
        else expect([top[0], x], at).toEqual([B.GRAVEL, B.AIR]);
      }
    }
  });
});

describe('gravel in small beds (GRAVEL_PATCHES_GEN5)', () => {
  it('the rows: a bed of seven columns, now and then a spread of nineteen, in the biomes that had gravel; their salts are their own', () => {
    expect(GRAVEL_PATCH_SALT).toBe(PLANT_PATCH_SALT + PLANT_PATCHES_GEN4.length);
    expect(GRAVEL_PATCH_SALT).toBe(15);
    expect(GRAVEL_PATCHES_GEN5.map((row) => [row.key, row.id, row.cell, row.radius, row.fill, row.salt])).toEqual([
      ['gravel_bed', B.GRAVEL, 10, 1, 0.9, 15], ['gravel_spread', B.GRAVEL, 24, 2, 0.85, 16],
    ]);
    const chances = (row) => Object.fromEntries(Object.entries(BIOME).filter(([, id]) => row.chance[id] > 0).map(([k, id]) => [k, row.chance[id]]));
    expect(chances(GRAVEL_PATCHES_GEN5[0])).toEqual({ BEACH: 0.84, PLAINS: 0.085, FOREST: 0.115, SNOWY: 0.115, MOUNTAINS: 0.34 });
    expect(chances(GRAVEL_PATCHES_GEN5[1])).toEqual({ BEACH: 0.5, PLAINS: 0.07, FOREST: 0.1, SNOWY: 0.1, MOUNTAINS: 0.3 });
    // exactly the biomes whose per-column roll had a gravel slice (FLORA_TABLE's `top` rows), which now places nothing
    const had = Object.entries(BIOME).filter(([, id]) => FLORA_TABLE[id]?.rows.some((row) => row.top && row.id === B.GRAVEL)).map(([k]) => k);
    expect(had).toEqual(['BEACH', 'PLAINS', 'FOREST', 'SNOWY', 'MOUNTAINS']);
    for (const row of GRAVEL_PATCHES_GEN5) expect(Object.keys(chances(row))).toEqual(had);
    expect(Object.isFrozen(GRAVEL_PATCHES_GEN5) && GRAVEL_PATCHES_GEN5.every(Object.isFrozen)).toBe(true);
    void PATCH_SALT;
  });

  it('measured: about half the surface gravel of generation 4, biome by biome; scattered before, in beds after', () => {
    const [g4, g5] = [LAND.gravel[4], LAND.gravel[5]];
    expect(g4.size).toBeGreaterThan(2000);
    expect(g5.size / g4.size).toBeGreaterThan(0.42);
    expect(g5.size / g4.size).toBeLessThan(0.6);
    for (const biome of [BIOME.BEACH, BIOME.PLAINS, BIOME.FOREST, BIOME.SNOWY]) {
      const ratio = LAND.gravelBy[5][biome] / LAND.gravelBy[4][biome];
      expect(LAND.gravelBy[4][biome], BLOCKS[0].name + biome).toBeGreaterThan(100);
      expect(ratio, `biome ${biome}`).toBeGreaterThan(0.35);
      expect(ratio, `biome ${biome}`).toBeLessThan(0.7);
    }
    expect(LAND.gravelBy[5][BIOME.DESERT] + LAND.gravelBy[4][BIOME.DESERT]).toBe(0);
    /** The share of gravel columns with a gravel neighbour, and the mean number of such neighbours. */
    const clustering = (set) => {
      let withOne = 0;
      let sum = 0;
      for (const k of set) {
        const [q, r] = k.split(',').map(Number);
        let n = 0;
        for (const [dq, dr] of HEX_DIRS) if (set.has(key(q + dq, r + dr))) n++;
        if (n > 0) withOne++;
        sum += n;
      }
      return [withOne / set.size, sum / set.size];
    };
    const [share4, mean4] = clustering(g4);
    const [share5, mean5] = clustering(g5);
    expect(share4).toBeLessThan(0.45); // grey freckles: most gravel cells stand alone (the beach's shingle touches now and then)
    expect(mean4).toBeLessThan(0.7);
    expect(share5).toBeGreaterThan(0.97); // a bed: nearly every gravel cell has gravel beside it
    expect(mean5).toBeGreaterThan(2.5);
    // on the plains, where it matters most: one cell in 70 before, alone; now a bed in sight now and then
    const plains = (set) => [...set].filter((k) => gen5.getColumn(...k.split(',').map(Number)).biome === BIOME.PLAINS);
    const alone = (list, set) => list.filter((k) => {
      const [q, r] = k.split(',').map(Number);
      return !HEX_DIRS.some(([dq, dr]) => set.has(key(q + dq, r + dr)));
    }).length / list.length;
    expect(alone(plains(g4), g4)).toBeGreaterThan(0.85);
    expect(alone(plains(g5), g5)).toBeLessThan(0.03);
  });

  it('the beds are smallish: most are 5 to 7 columns, the big ones under two dozen', () => {
    const set = LAND.gravel[5];
    const seen = new Set();
    const sizes = [];
    for (const k of set) {
      if (seen.has(k)) continue;
      let size = 0;
      const stack = [k];
      seen.add(k);
      while (stack.length > 0) {
        const [q, r] = stack.pop().split(',').map(Number);
        size++;
        for (const [dq, dr] of HEX_DIRS) {
          const n = key(q + dq, r + dr);
          if (set.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      sizes.push(size);
    }
    sizes.sort((a, b) => a - b);
    const pct = (p) => sizes[Math.floor(p * (sizes.length - 1))];
    expect(sizes.length).toBeGreaterThan(150);
    expect(pct(0.5)).toBeGreaterThanOrEqual(4);
    expect(pct(0.5)).toBeLessThanOrEqual(7);
    expect(pct(0.9)).toBeLessThanOrEqual(24);
    expect(sizes.filter((n) => n <= 24).length / sizes.length).toBeGreaterThan(0.93); // (two beds now and then touch on a beach)
  });

  it('flint still comes from digging it: a bed is wild gravel, one cell in eight or so turns up a Flint', () => {
    expect(GRAVEL_FLINT_P).toBe(0.12);
    expect(rollDrops(B.GRAVEL, null, { natural: true }, () => 0.1)).toEqual([{ k: 'rock', n: 2 }, { k: 'flint', n: 1 }]);
    expect(rollDrops(B.GRAVEL, null, { natural: false }, () => 0.1)).toEqual([{ k: 'rock', n: 2 }]);
  });
});

describe('natural springs (naturalSpringOf, naturalSpringAt)', () => {
  /** Every spring of the grid cells −K..K. */
  const K = 24;
  const ALL = [];
  for (let kq = -K; kq <= K; kq++) for (let kr = -K; kr <= K; kr++) {
    const sp = gen5.naturalSpringOf(kq, kr);
    if (sp) ALL.push({ ...sp, kq, kr });
  }
  const CELLS = (2 * K + 1) ** 2;

  it('the rule\'s numbers', () => {
    expect([NATURAL_SPRING_CELL, NATURAL_SPRING_SALT, NATURAL_SPRING_SEARCH, NATURAL_SPRING_MIN_HIGHER, NATURAL_SPRING_CLEAR]).toEqual([64, 0x5b21, 6, 2, 4]);
    expect(Object.fromEntries(Object.entries(BIOME).map(([k, id]) => [k, NATURAL_SPRING_CHANCE[id]]))).toEqual({
      OCEAN: 0, BEACH: 0, PLAINS: 0.5, FOREST: 0.5, DESERT: 0.15, SNOWY: 0.25, MOUNTAINS: 0.5, SNOWY_PEAKS: 0,
    });
    expect(Object.isFrozen(NATURAL_SPRING_CHANCE)).toBe(true);
  });

  it('the land has exactly the springs the rule names: a SPRING block at the column\'s height, under the open air, and no other', () => {
    expect(LAND.springs.length).toBeGreaterThanOrEqual(6);
    for (const [q, y, r, h] of LAND.springs) {
      expect(y, `${q},${r}`).toBe(h);
      expect(gen5.naturalSpringAt(q, r), `${q},${r}`).toBe(true);
    }
    const inLand = ALL.filter((sp) => Math.abs(Math.floor(sp.q / CHUNK_SIZE)) <= N && Math.abs(Math.floor(sp.r / CHUNK_SIZE)) <= N);
    expect(inLand.map((sp) => key(sp.q, sp.r)).sort()).toEqual(LAND.springs.map(([q, , r]) => key(q, r)).sort());
    for (const sp of inLand) {
      const c = gen5.generateChunk(Math.floor(sp.q / CHUNK_SIZE), Math.floor(sp.r / CHUNK_SIZE));
      const ci = (sp.q - Math.floor(sp.q / CHUNK_SIZE) * CHUNK_SIZE) * CHUNK_SIZE + (sp.r - Math.floor(sp.r / CHUNK_SIZE) * CHUNK_SIZE);
      expect(c.heights[ci]).toBe(sp.y);
      expect([c.blocks[ci * WORLD_HEIGHT + sp.y], c.blocks[ci * WORLD_HEIGHT + sp.y + 1]]).toEqual([B.SPRING, B.AIR]);
      expect(c.blocks[ci * WORLD_HEIGHT + sp.y - 1]).not.toBe(B.AIR); // it stands on the ground it replaced the top of
    }
    // nothing generates the drawn spring, a well, a barrel or a bed
    expect(LAND.diff.some(([, , , , , z]) => z > B.SPRING)).toBe(false);
    for (const [q, r] of [[0, 0], [5, -9], [1000, 1000]]) expect(typeof gen5.naturalSpringAt(q, r)).toBe('boolean');
    expect(gen5.naturalSpringAt(0.5, 0) || gen5.naturalSpringAt(NaN, 0)).toBe(false);
    expect(gen5.naturalSpringOf(0.5, 0)).toBeNull();
  });

  it('the same from every chunk and in any order: a fresh generator asked about one cell alone gives the same spring', () => {
    for (const sp of ALL.filter((_, i) => i % 9 === 0)) {
      const fresh = createWorldGen(SEED, { gen: 5 });
      expect(fresh.naturalSpringOf(sp.kq, sp.kr)).toEqual({ q: sp.q, r: sp.r, y: sp.y });
      expect(fresh.naturalSpringAt(sp.q, sp.r)).toBe(true);
      expect(fresh.naturalSpringAt(sp.q + 1, sp.r)).toBe(false);
    }
    // another seed, another land
    const other = createWorldGen(SEED + 1, { gen: 5 });
    const moved = ALL.filter((sp) => {
      const o = other.naturalSpringOf(sp.kq, sp.kr);
      return !o || o.q !== sp.q || o.r !== sp.r;
    });
    expect(moved.length).toBeGreaterThan(ALL.length * 0.95);
  });

  it('where the ground suits it: within 6 cells of its cell\'s spot, at the foot of a slope or in a hollow, never on a ledge, a beach or the sea', () => {
    const higher = [0, 0, 0, 0, 0, 0, 0];
    for (const sp of ALL) {
      const col = gen5.getColumn(sp.q, sp.r);
      expect(col.height).toBe(sp.y);
      expect(NATURAL_SPRING_CHANCE[col.biome], key(sp.q, sp.r)).toBeGreaterThan(0);
      expect(sp.y).toBeGreaterThan(SEA_LEVEL + 2);
      let n = 0;
      for (const [dq, dr] of HEX_DIRS) {
        const nh = gen5.getColumn(sp.q + dq, sp.r + dr).height;
        if (nh > sp.y) n++;
        expect(nh, key(sp.q, sp.r)).toBeGreaterThanOrEqual(sp.y - 1);
      }
      expect(n, key(sp.q, sp.r)).toBeGreaterThanOrEqual(NATURAL_SPRING_MIN_HIGHER);
      higher[n]++;
      // it lies within the search of its own cell's spot, so within reach of that cell
      expect(Math.floor(sp.q / NATURAL_SPRING_CELL) - sp.kq, key(sp.q, sp.r)).toBeGreaterThanOrEqual(-1);
      expect(sp.q).toBeGreaterThanOrEqual(sp.kq * NATURAL_SPRING_CELL - NATURAL_SPRING_SEARCH);
      expect(sp.q).toBeLessThan((sp.kq + 1) * NATURAL_SPRING_CELL + NATURAL_SPRING_SEARCH);
      expect(sp.r).toBeGreaterThanOrEqual(sp.kr * NATURAL_SPRING_CELL - NATURAL_SPRING_SEARCH);
      expect(sp.r).toBeLessThan((sp.kr + 1) * NATURAL_SPRING_CELL + NATURAL_SPRING_SEARCH);
    }
    // most sit well into a slope: three or more neighbours above them
    expect((higher[3] + higher[4] + higher[5] + higher[6]) / ALL.length).toBeGreaterThan(0.5);
  });

  it('a spring is not a stream\'s head: no stream runs within 4 cells of one, no pond holds one, no tree stands in one', () => {
    let streamNear = 0;
    for (const sp of ALL.filter((_, i) => i % 3 === 0)) {
      for (let dq = -NATURAL_SPRING_CLEAR; dq <= NATURAL_SPRING_CLEAR; dq++) {
        for (let dr = -NATURAL_SPRING_CLEAR; dr <= NATURAL_SPRING_CLEAR; dr++) {
          if (hexLength(dq, dr) > NATURAL_SPRING_CLEAR) continue;
          expect(gen5.streamAt(sp.q + dq, sp.r + dr), key(sp.q, sp.r)).toBe(false);
        }
      }
      for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) expect(gen5.pondAt(sp.q + dq, sp.r + dr), key(sp.q, sp.r)).toBe(false);
      const t = gen5.treeTrunkAt(Math.floor(sp.q / 6), Math.floor(sp.r / 6));
      expect(t !== null && t.tq === sp.q && t.tr === sp.r, key(sp.q, sp.r)).toBe(false);
      let near = false;
      for (let dq = -10; dq <= 10 && !near; dq++) for (let dr = -10; dr <= 10 && !near; dr++) if (hexLength(dq, dr) <= 10 && gen5.streamAt(sp.q + dq, sp.r + dr)) near = true;
      if (near) streamNear++;
    }
    // and most have no stream anywhere near: they are their own kind of water
    expect(streamNear / Math.ceil(ALL.length / 3)).toBeLessThan(0.3);
  });

  it('rare: about one in 14 000 columns; from a point on land the nearest is typically 40 to 80 cells away', () => {
    const columns = CELLS * NATURAL_SPRING_CELL ** 2;
    expect(columns / ALL.length).toBeGreaterThan(10000);
    expect(columns / ALL.length).toBeLessThan(18000);
    expect(ALL.length / CELLS).toBeLessThan(0.5); // fewer than the chance: the sea, the beach, the desert, ground that does not suit
    // by land: none in the sea, on a beach or on the snowy peaks; plains and forest have nearly all
    const by = new Array(8).fill(0);
    for (const sp of ALL) by[gen5.getColumn(sp.q, sp.r).biome]++;
    expect(by[BIOME.OCEAN] + by[BIOME.BEACH] + by[BIOME.SNOWY_PEAKS]).toBe(0);
    expect((by[BIOME.PLAINS] + by[BIOME.FOREST]) / ALL.length).toBeGreaterThan(0.7);
    expect(by[BIOME.DESERT]).toBeGreaterThan(0); // an oasis spring
    expect(by[BIOME.SNOWY]).toBeGreaterThan(0);
    // the nearest spring from 2 000 points on land, well inside the measured grid
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const span = (K - 3) * NATURAL_SPRING_CELL;
    const near = [];
    while (near.length < 2000) {
      const q = Math.floor((rnd() * 2 - 1) * span);
      const r = Math.floor((rnd() * 2 - 1) * span);
      if (gen5.getColumn(q, r).biome === BIOME.OCEAN) continue;
      let best = Infinity;
      for (const sp of ALL) best = Math.min(best, hexLength(sp.q - q, sp.r - r));
      near.push(best);
    }
    near.sort((a, b) => a - b);
    const pct = (p) => near[Math.floor(p * (near.length - 1))];
    expect(pct(0.5)).toBeGreaterThanOrEqual(SPRING_NEAREST_CELLS[0]);
    expect(pct(0.5)).toBeLessThanOrEqual(SPRING_NEAREST_CELLS[1]);
    expect(pct(0.25)).toBeGreaterThan(25); // worth a journey: seldom on the doorstep …
    expect(pct(0.1)).toBeGreaterThan(12);
    expect(pct(0.9)).toBeLessThan(130); // … and seldom out of reach
    // the desert's are far rarer for the land it covers than the plains'
    const cols = new Array(8).fill(0);
    for (let i = 0; i < 20000; i++) cols[gen5.getColumn(Math.floor((rnd() * 2 - 1) * span), Math.floor((rnd() * 2 - 1) * span)).biome]++;
    expect(by[BIOME.DESERT] / cols[BIOME.DESERT]).toBeLessThan((by[BIOME.PLAINS] / cols[BIOME.PLAINS]) * 0.6);
  });

  it('finding a cell\'s spring is cheap, and it is remembered', () => {
    const g = createWorldGen(SEED + 7, { gen: 5 });
    const t0 = performance.now();
    let n = 0;
    for (let kq = -8; kq <= 8; kq++) for (let kr = -8; kr <= 8; kr++) if (g.naturalSpringOf(kq, kr)) n++;
    const cold = (performance.now() - t0) / 289;
    expect(n).toBeGreaterThan(40);
    expect(cold).toBeLessThan(25); // ms a cell, cold, on a busy machine (measured: about 0.6)
    const t1 = performance.now();
    for (let kq = -8; kq <= 8; kq++) for (let kr = -8; kr <= 8; kr++) g.naturalSpringOf(kq, kr);
    expect((performance.now() - t1) / 289).toBeLessThan(cold);
  });
});
