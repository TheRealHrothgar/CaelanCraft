// Tests for generation 3's flora (v0.14, CONTRACTS §76 flora): food in bunches, and less of it. The food plants no
// longer come from the per-column roll but from PATCH_TABLE; mushroom troops also grow on cave floors. Generations 1 and 2
// must stay byte for byte what they were. Everything is derived from fixed seeds, so the numbers quoted here never move
// unless the generator does.
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../../src/config.js';
import { floorDiv, columnIndex, localIndex } from '../../src/coords.js';
import { HEX_DIRS, hexLength } from '../../src/hex.js';
import { BLOCK, BLOCKS, BIOME, BIOME_NAMES } from '../../src/blocks.js';
import { hash3, rand3 } from '../../src/noise.js';
import {
  createWorldGen, FLORA_TABLE, FLORA_SALT, PATCH_TABLE, PATCH_SALT, PATCH_MIX_STEP, CAVE_TROOP, FRECKLECAP_SHARES,
  FOREST_EDGE_HUMIDITY,
} from '../../src/worldgen.js';
import { ITEMS } from '../../src/items.js';
import { PICKABLE } from '../../src/harvest.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const gen1 = createWorldGen(SEED, { gen: 1 });
const gen2 = createWorldGen(SEED, { gen: 2 });
const gen3 = createWorldGen(SEED, { gen: 3 });

/** Cached chunks per generator. */
const caches = new Map([[gen1, new Map()], [gen2, new Map()], [gen3, new Map()]]);
function chunkOf(g, cq, cr) {
  const cache = caches.get(g);
  const key = `${cq},${cr}`;
  let c = cache.get(key);
  if (!c) {
    c = g.generateChunk(cq, cr);
    cache.set(key, c);
  }
  return c;
}
const at = (d, lq, y, lr) => d.blocks[localIndex(lq, y, lr)];
const digest = (d) => createHash('sha256').update(d.blocks).update(d.biomes).update(d.heights).digest('hex').slice(0, 32);

/** The plants that count as FOOD, and the patch kind each belongs to (the two mushrooms are one kind: a troop mixes them). */
const KIND_OF = new Map([
  [B.HONEYBERRY_BUSH, 'honeyberry'], [B.TUBER_PLANT, 'tuber'], [B.PRICKLY_PEAR, 'prickly_pear'], [B.CATTAILS, 'cattails'],
  [B.HONEYCAP_MUSHROOM, 'mushrooms'], [B.FRECKLECAP_MUSHROOM, 'mushrooms'], [B.ONION_PLANT, 'onion'], [B.CARROT_PLANT, 'carrot'],
  [B.HAZEL_THICKET, 'hazel'], [B.CRAB_APPLE_BUSH, 'crab_apple'], [B.HEALWORT_PLANT, 'healwort'],
]);
/** Patch plants that are not food: the look-alike poisons, the herb is medicine. Counted apart. */
const NOT_FOOD = new Set([B.FRECKLECAP_MUSHROOM, B.HEALWORT_PLANT]);
const PATCH_IDS = new Set(PATCH_TABLE.flatMap((row) => (row.mixId !== undefined ? [row.id, row.mixId] : [row.id])));
const LEAF_IDS = new Set([B.OAK_LEAVES, B.SPRUCE_LEAVES, B.BIRCH_LEAVES]);
const MUSHROOMS = new Set([B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM]);
const DISC2 = [];
for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) if (hexLength(dq, dr) <= 2) DISC2.push([dq, dr]);

// ---- the contract, re-derived (independent of the generator's own loops) ----------------------------------------------

/** @type {Map<string, { q: number, r: number, share: number }|null>} */
const patchCache = new Map();
/** The patch in grid cell (kq, kr) of a row (salt = PATCH_SALT + its index), or null. */
function patchOf(g, row, salt, kq, kr, chanceAt) {
  const key = `${g.gen}:${salt}:${kq},${kr}`;
  if (patchCache.has(key)) return patchCache.get(key);
  const h = hash3(kq, kr, salt, g.seed);
  const roll = (h >>> 16) / 65536;
  const q = kq * row.cell + (((h & 0xff) * row.cell) >> 8);
  const r = kr * row.cell + ((((h >>> 8) & 0xff) * row.cell) >> 8);
  let out = null;
  if (roll < chanceAt(g.getColumn(q, r))) {
    const share = row.mixShares ? row.mixShares[hash3(kr, kq, salt + PATCH_MIX_STEP, g.seed) % row.mixShares.length] : 0;
    out = { q, r, share, key };
  }
  patchCache.set(key, out);
  return out;
}
/** The chance of a PATCH_TABLE row at a centre column: its biome's, but 0 for a forest centre that is not the forest's edge. */
const chanceOf = (row) => (col) => (row.edgeBelow !== undefined && col.biome === BIOME.FOREST && col.humidity >= row.edgeBelow ? 0 : row.chance[col.biome]);

/**
 * The plant a patch row puts at column (q, r), from the first of its patches (grid order) that covers the column — or
 * null when the fill roll fails or no patch covers it.
 */
function rowPlantAt(g, row, salt, q, r, chanceAt) {
  if (rand3(q, r, salt, g.seed) >= row.fill) return null;
  const R = row.radius;
  for (let kq = floorDiv(q - R, row.cell); kq <= floorDiv(q + R, row.cell); kq++) {
    for (let kr = floorDiv(r - R, row.cell); kr <= floorDiv(r + R, row.cell); kr++) {
      const p = patchOf(g, row, salt, kq, kr, chanceAt);
      if (!p) continue;
      const d = hexLength(q - p.q, r - p.r);
      if (row.ring ? d !== R : d > R) continue;
      const mixed = p.share > 0 && rand3(q, r, salt + PATCH_MIX_STEP, g.seed) < p.share;
      return { row, id: mixed ? row.mixId : row.id, patch: p.key };
    }
  }
  return null;
}

/** What PATCH_TABLE puts at a column of biome `biome`: the first row (in table order) that grows there and covers it. */
function patchPlantAt(g, q, r, biome) {
  for (let i = 0; i < PATCH_TABLE.length; i++) {
    const row = PATCH_TABLE[i];
    if (row.chance[biome] === 0) continue;
    const hit = rowPlantAt(g, row, PATCH_SALT + i, q, r, chanceOf(row));
    if (hit) return hit;
  }
  return null;
}

/** A row's own height and shore conditions at column (q, r) (the generation-2 rule). */
function fits(g, row, q, r, h) {
  if (row.minHeight !== undefined && h < row.minHeight) return false;
  if (row.maxHeight !== undefined && h > row.maxHeight) return false;
  if (row.besideBelow !== undefined) return HEX_DIRS.some(([dq, dr]) => g.getColumn(q + dq, r + dr).height < row.besideBelow);
  return true;
}

/** The generation-2 roll of a column: the FLORA_TABLE row its one roll picks (fitting or not), or null. */
function rolledRow(g, table, q, r) {
  const u = rand3(q, r, FLORA_SALT, g.seed);
  let acc = 0;
  for (const row of table.rows) {
    acc += row.chance;
    if (u < acc) return row;
  }
  return null;
}

// ---- a scan: regions of 4 × 4 chunks spread over the world, with extra ones on the rarer biomes -----------------------

const SPAN = 4;
/** Region origins (chunk coordinates). */
const REGIONS = [[0, 0], [40, -30], [-60, 20], [100, 100], [-120, -80], [200, -150], [-250, 60], [30, 300], [-300, -300], [400, 10], [150, -400], [-90, 440]];
{
  // … plus regions centred on the first lattice points (every 160 columns) of each biome that the fixed list is poor in
  const want = new Map([[BIOME.DESERT, 12], [BIOME.SNOWY, 6], [BIOME.FOREST, 8], [BIOME.BEACH, 8]]);
  for (let q = -4000; q <= 4000 && want.size; q += 160) {
    for (let r = -4000; r <= 4000 && want.size; r += 160) {
      const b = gen2.getColumn(q, r).biome;
      const left = want.get(b);
      if (!left) continue;
      REGIONS.push([floorDiv(q, CHUNK_SIZE) - (SPAN >> 1), floorDiv(r, CHUNK_SIZE) - (SPAN >> 1)]);
      if (left === 1) want.delete(b);
      else want.set(b, left - 1);
    }
  }
}

/**
 * @typedef {Object} Scan
 * @property {number[]} land                       land columns per biome
 * @property {Map<string, number>} counts          `${biome}:${blockId}` → surface patch plants
 * @property {Map<string, [number, number]>} near  kind → [plants with a same-kind neighbour within 3, plants]
 * @property {number} landChunks                   chunks that are mostly land
 * @property {number} emptyChunks                  … of which hold no food plant at all
 * @property {number} cave                         mushrooms under ground
 * @property {number} caveBad                      … of which Frecklecaps
 */
/** @returns {Scan} */
function scan(g) {
  const land = new Array(8).fill(0);
  const counts = new Map();
  const near = new Map();
  let landChunks = 0;
  let emptyChunks = 0;
  let cave = 0;
  let caveBad = 0;
  for (const [rq, rr] of REGIONS) {
    /** @type {Map<number, string>} column key → kind */
    const plants = new Map();
    const key = (q, r) => (q + 100000) * 262144 + (r + 100000);
    for (let cq = rq; cq < rq + SPAN; cq++) {
      for (let cr = rr; cr < rr + SPAN; cr++) {
        const d = g.generateChunk(cq, cr); // not cached: the scan is the only reader of these
        let landHere = 0;
        let foodHere = 0;
        for (let lq = 0; lq < CHUNK_SIZE; lq++) {
          for (let lr = 0; lr < CHUNK_SIZE; lr++) {
            const ci = columnIndex(lq, lr);
            const biome = d.biomes[ci];
            const h = d.heights[ci];
            if (biome !== BIOME.OCEAN) {
              land[biome]++;
              landHere++;
            }
            const base = ci * WORLD_HEIGHT;
            const above = d.blocks[base + h + 1];
            if (KIND_OF.has(above)) {
              counts.set(`${biome}:${above}`, (counts.get(`${biome}:${above}`) ?? 0) + 1);
              plants.set(key(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr), KIND_OF.get(above));
              if (!NOT_FOOD.has(above)) foodHere++;
            }
            for (let y = 1; y < h; y++) {
              const v = d.blocks[base + y];
              if (v === B.HONEYCAP_MUSHROOM) cave++;
              else if (v === B.FRECKLECAP_MUSHROOM) {
                cave++;
                caveBad++;
              }
            }
          }
        }
        if (landHere >= 200) {
          landChunks++;
          if (foodHere === 0) emptyChunks++;
        }
      }
    }
    for (const [k, kind] of plants) {
      const q = Math.floor(k / 262144) - 100000;
      const r = (k % 262144) - 100000;
      let found = false;
      for (let dq = -3; dq <= 3 && !found; dq++) {
        for (let dr = -3; dr <= 3 && !found; dr++) {
          const dist = hexLength(dq, dr);
          if (dist >= 1 && dist <= 3 && plants.get(key(q + dq, r + dr)) === kind) found = true;
        }
      }
      const c = near.get(kind) ?? [0, 0];
      c[1]++;
      if (found) c[0]++;
      near.set(kind, c);
    }
  }
  return { land, counts, near, landChunks, emptyChunks, cave, caveBad };
}

/** @param {Scan} s @param {number} biome @returns {number} food plants (not the look-alike, not the herb) in a biome */
function foodIn(s, biome) {
  let n = 0;
  for (const [k, c] of s.counts) {
    const [b, id] = k.split(':').map(Number);
    if (b === biome && !NOT_FOOD.has(id)) n += c;
  }
  return n;
}
/** @param {Scan} s @param {number} id @param {number} [biome] @returns {number} plants of one block (in one biome, or anywhere) */
function countOf(s, id, biome) {
  let n = 0;
  for (const [k, c] of s.counts) {
    const [b, i] = k.split(':').map(Number);
    if (i === id && (biome === undefined || b === biome)) n += c;
  }
  return n;
}
/** @param {Scan} s @returns {[number, number]} [food plants with a same-kind neighbour within 3 cells, food plants] */
function clustered(s) {
  let a = 0;
  let b = 0;
  for (const [kind, [w, t]] of s.near) {
    if (kind === 'healwort') continue;
    a += w;
    b += t;
  }
  return [a, b];
}

/** @type {Scan} */
let s2;
/** @type {Scan} */
let s3;
beforeAll(() => {
  s2 = scan(gen2);
  s3 = scan(gen3);
}, 180000);

// =====================================================================================================================

describe('generations 1 and 2 are byte for byte what they were', () => {
  it('generation 2 matches the checksums taken before generation 3 existed; so does generation 1', () => {
    // sha256 of blocks + biomes + heights, first 32 hex digits, taken at the foundation commit (56fa30d)
    const GEN2 = [
      ['caelancraft-test', 0, 0, '4510e63fb637083d0998fd9fd459a9cf'], ['caelancraft-test', 1, 0, 'db12dbcce2ac32553508e81150d07c4c'],
      ['caelancraft-test', -1, 2, 'eb0f8cd3f9d27094e3c3d00dd608f583'], ['caelancraft-test', 3, -4, 'c54e9860a07d42c2b602466e4fa7209c'],
      ['caelancraft-test', -2, -2, 'c691db6c7ec6347a239336fd8aae9f11'], ['caelancraft-test', 5, 5, 'c2ffd6f0f162d305d651c79e3fcef0cd'],
      ['caelancraft-test', 12, -7, 'eb80a50525bcd64ee2ae5cb40eeb965c'], ['caelancraft-test', 26, -39, '0c72be13aaa1792bb5c1addefff18b94'],
      ['caelancraft-test', -65, 13, '42bb945bfb985b0824f1405777d52223'], [1, 0, 0, 'acc37e329ed491c194a565398413840a'],
      [1, -3, 1, 'e2ec2199da3f5ff1a75e47212921f906'], [1, 2, 2, '7f36e867dccccac20f2ac083182fb0f0'],
      ['survival', 0, 0, 'bd593b26c757262af8a5dd9bf3234991'], ['survival', 4, -1, '61ffb065d621ba30dda920f8e9c46b63'],
      [4242, 0, 0, 'd03ff4a0714f48a810bc4bf2cb8343d1'], [4242, -1, 0, 'd2250589c6023656ad17ac78e7d41cea'],
      [4242, 7, 3, '440cb508736f082d60c0442e9b60cfbb'],
    ];
    const gens = new Map();
    for (const [seed, cq, cr, sum] of GEN2) {
      if (!gens.has(seed)) gens.set(seed, createWorldGen(seed, { gen: 2 }));
      expect(digest(gens.get(seed).generateChunk(cq, cr)), `gen 2 ${seed} ${cq},${cr}`).toBe(sum);
    }
    // generation 1 (the pins of worldgen.test.js, three of them again here)
    expect(digest(chunkOf(gen1, 0, 0))).toBe('ba19062a5808524ea11789c6b23f7c51');
    expect(digest(chunkOf(gen1, 12, -7))).toBe('8e9b35b4a991adae0df3d18127c43550');
    expect(digest(createWorldGen(1).generateChunk(2, 2))).toBe('f8f3d23c77e11137c6902b8be4db292d');
    // and generation 3 is a different land
    expect(digest(chunkOf(gen3, 0, 0))).not.toBe('4510e63fb637083d0998fd9fd459a9cf');
  });

  it('no generation below 3 ever holds a new plant, on the surface or in a cave', () => {
    const NEW = new Uint8Array(256);
    for (const id of [B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.ONION_PLANT, B.CARROT_PLANT, B.HAZEL_THICKET, B.HAZEL_THICKET_BARE,
      B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE, B.RESERVED_120, B.RESERVED_121]) NEW[id] = 1;
    for (const g of [gen1, gen2]) {
      for (const [cq, cr] of [[0, 0], [1, 0], [3, -4], [-2, -2], [5, 5], [12, -7], [40, -30], [-60, 20]]) {
        const blocks = chunkOf(g, cq, cr).blocks;
        let found = 0;
        for (let i = 0; i < blocks.length; i++) found += NEW[blocks[i]];
        expect(found, `gen ${g.gen} chunk ${cq},${cr}`).toBe(0);
      }
    }
    // generation 3 never generates a picked variant or a placeholder either
    for (const [cq, cr] of [[0, 0], [1, 0], [40, -30], [-60, 20]]) {
      const blocks = chunkOf(gen3, cq, cr).blocks;
      for (const id of [B.HAZEL_THICKET_BARE, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT_BARE, B.HONEYBERRY_BUSH_BARE, B.RESERVED_120, B.RESERVED_121]) {
        expect(blocks.includes(id), BLOCKS[id].name).toBe(false);
      }
    }
  });
});

describe('PATCH_TABLE (§76 flora)', () => {
  const row = (key) => PATCH_TABLE.find((r) => r.key === key);
  const biomesOf = (r) => r.chance.map((c, b) => (c > 0 ? BIOME_NAMES[b] : null)).filter(Boolean);

  it('is frozen, exposed on the generator, and every row is well formed', () => {
    expect(gen3.PATCH_TABLE).toBe(PATCH_TABLE);
    expect(Object.isFrozen(PATCH_TABLE) && PATCH_TABLE.every((r) => Object.isFrozen(r) && Object.isFrozen(r.chance))).toBe(true);
    expect(PATCH_TABLE.map((r) => r.key)).toEqual(['honeyberry', 'tuber', 'prickly_pear', 'cattails', 'mushrooms', 'onion', 'carrot',
      'hazel', 'crab_apple', 'healwort']);
    expect(new Set(PATCH_TABLE.map((r) => r.id)).size).toBe(PATCH_TABLE.length);
    for (const r of PATCH_TABLE) {
      expect(r.chance, r.key).toHaveLength(8);
      for (const c of r.chance) expect(c >= 0 && c < 1, r.key).toBe(true);
      expect(Number.isInteger(r.cell) && r.cell >= 8 && r.cell <= 256, r.key).toBe(true); // the jitter is 8 bits per axis
      expect(Number.isInteger(r.radius) && r.radius >= 1 && r.radius <= 3, r.key).toBe(true);
      expect(r.fill > 0 && r.fill <= 1, r.key).toBe(true);
      // a patch is a bunch: 3 to 30 plants expected, in a cell large enough to leave long gaps round it
      const columns = r.ring ? 6 * r.radius : 3 * r.radius * (r.radius + 1) + 1;
      expect(columns * r.fill, r.key).toBeGreaterThanOrEqual(3);
      expect(r.cell, r.key).toBeGreaterThanOrEqual(8 * r.radius);
      // never in the sea, on a mountain or on the peaks
      expect([r.chance[BIOME.OCEAN], r.chance[BIOME.MOUNTAINS], r.chance[BIOME.SNOWY_PEAKS]], r.key).toEqual([0, 0, 0]);
    }
    expect(PATCH_SALT).not.toBe(FLORA_SALT);
    expect(PATCH_MIX_STEP).toBeGreaterThan(PATCH_TABLE.length);
  });

  it('every land biome that had food keeps a food kind, and every new plant has a biome where it belongs', () => {
    // the food rows of generation 2's table, biome by biome, are all patch kinds now
    for (let b = 0; b < 8; b++) {
      const old = (FLORA_TABLE[b]?.rows ?? []).filter((r) => PATCH_IDS.has(r.id));
      const kinds = PATCH_TABLE.filter((r) => r.chance[b] > 0 && !NOT_FOOD.has(r.id));
      if (old.length > 0) expect(kinds.length, BIOME_NAMES[b]).toBeGreaterThan(0);
      for (const o of old) expect(row(KIND_OF.get(o.id)).chance[b], `${BIOME_NAMES[b]} ${BLOCKS[o.id].name}`).toBeGreaterThan(0);
    }
    expect([BIOME.BEACH, BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY].every((b) => PATCH_TABLE.some((r) => r.chance[b] > 0))).toBe(true);
    // where each kind grows
    expect(biomesOf(row('honeyberry'))).toEqual(['plains', 'forest', 'snowy']);
    expect(biomesOf(row('tuber'))).toEqual(['plains', 'forest']);
    expect(biomesOf(row('prickly_pear'))).toEqual(['desert']);
    expect(biomesOf(row('cattails'))).toEqual(['beach']);
    expect(biomesOf(row('mushrooms'))).toEqual(['forest']);
    expect(biomesOf(row('hazel'))).toEqual(['forest']);
    expect(biomesOf(row('onion'))).toEqual(['plains', 'forest']);
    expect(biomesOf(row('carrot'))).toEqual(['plains', 'forest']);
    expect(biomesOf(row('crab_apple'))).toEqual(['plains', 'forest']);
    expect(biomesOf(row('healwort'))).toEqual(['plains', 'forest', 'snowy']);
    // onion and carrot: plains, and only the forest's edge
    expect([row('onion').edgeBelow, row('carrot').edgeBelow]).toEqual([FOREST_EDGE_HUMIDITY, FOREST_EDGE_HUMIDITY]);
    expect(FOREST_EDGE_HUMIDITY).toBeGreaterThan(0.15); // FOREST begins at humidity 0.15
    expect(PATCH_TABLE.filter((r) => r.edgeBelow !== undefined).map((r) => r.key)).toEqual(['onion', 'carrot']);
    // the cattails keep the generation-2 shore rule; the mushrooms grow in rings, good and bad mixed
    expect([row('cattails').minHeight, row('cattails').maxHeight, row('cattails').besideBelow]).toEqual([SEA_LEVEL, SEA_LEVEL + 1, SEA_LEVEL]);
    expect(row('mushrooms')).toMatchObject({ id: B.HONEYCAP_MUSHROOM, mixId: B.FRECKLECAP_MUSHROOM, ring: true, radius: 2 });
    expect(row('mushrooms').mixShares).toBe(FRECKLECAP_SHARES);
    expect([...FRECKLECAP_SHARES]).toEqual([0, 0.15, 0.3, 0.5, 1]); // some troops all good, some all bad, most mixed
    expect(CAVE_TROOP).toMatchObject({ id: B.HONEYCAP_MUSHROOM, mixId: B.FRECKLECAP_MUSHROOM, mixShares: FRECKLECAP_SHARES });
    expect(Object.isFrozen(CAVE_TROOP)).toBe(true);
    // every patch plant is one the player can pick with R, and all but the look-alike are safe to eat as picked
    for (const id of PATCH_IDS) {
      if (id === B.CATTAILS || id === B.TUBER_PLANT) continue; // pulled with the left button, as before
      expect(Object.hasOwn(PICKABLE, id), BLOCKS[id].name).toBe(true);
    }
    expect(ITEMS.frecklecap.food.sick).toBe(1);
  });

  it('the healing herb is the rarest patch: the smallest expected share of columns of any kind in plains and forest', () => {
    const density = (r, b) => (r.chance[b] * (r.ring ? 6 * r.radius : 3 * r.radius * (r.radius + 1) + 1) * r.fill) / (r.cell * r.cell);
    for (const b of [BIOME.PLAINS, BIOME.FOREST]) {
      const others = PATCH_TABLE.filter((r) => r.key !== 'healwort' && r.chance[b] > 0 && r.edgeBelow === undefined);
      for (const o of others) expect(density(row('healwort'), b), `${BIOME_NAMES[b]} ${o.key}`).toBeLessThan(density(o, b));
      // about one small patch per 10 000 columns (the nearest some 50 cells away): found by exploring, not at every turn
      const perPatch = (row('healwort').cell ** 2) / row('healwort').chance[b];
      expect(perPatch).toBeGreaterThan(8000);
      expect(perPatch).toBeLessThan(14000);
      // and its patches are rarer than any other kind's, edge kinds included
      for (const o of PATCH_TABLE) if (o.key !== 'healwort' && o.chance[b] > 0) expect((o.cell ** 2) / o.chance[b], o.key).toBeLessThan(perPatch);
    }
  });
});

describe('generation 3: every column is what the contract says (and chunks agree at their borders)', () => {
  /** Two contiguous blocks of chunks (plains, forest and their borders), then chunks on desert, beach and snowy land. */
  const CHUNKS = [];
  for (let cq = -3; cq <= 3; cq++) for (let cr = -3; cr <= 2; cr++) CHUNKS.push([cq, cr]);
  for (let cq = 40; cq <= 43; cq++) for (let cr = -30; cr <= -27; cr++) CHUNKS.push([cq, cr]);
  CHUNKS.push([-60, 20], [-60, 21], [100, 100], [12, -7]);
  for (const b of [BIOME.DESERT, BIOME.BEACH, BIOME.SNOWY]) {
    let found = 0;
    for (let q = -4000; q <= 4000 && found < 3; q += 160) {
      for (let r = -4000; r <= 4000 && found < 3; r += 160) {
        if (gen2.getColumn(q, r).biome !== b) continue;
        CHUNKS.push([floorDiv(q, CHUNK_SIZE), floorDiv(r, CHUNK_SIZE)], [floorDiv(q, CHUNK_SIZE) + 1, floorDiv(r, CHUNK_SIZE)]);
        found++;
      }
    }
  }

  it('the surface: a patch plant where PATCH_TABLE puts one, else the generation-2 roll without its food rows', () => {
    const violations = [];
    const placed = new Map(); // patch → the chunks its plants stand in
    const seen = { patch: 0, kept: 0, dropped: 0, eligible: 0 };
    const byBiome = new Map();
    for (const [cq, cr] of CHUNKS) {
      const a = chunkOf(gen1, cq, cr);
      const b = chunkOf(gen2, cq, cr);
      const c = chunkOf(gen3, cq, cr);
      expect(Buffer.from(c.heights).equals(Buffer.from(b.heights)) && Buffer.from(c.biomes).equals(Buffer.from(b.biomes))).toBe(true);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const ci = columnIndex(lq, lr);
          const biome = c.biomes[ci];
          const h = c.heights[ci];
          const got = [at(c, lq, h, lr), at(c, lq, h + 1, lr)];
          const was = [at(b, lq, h, lr), at(b, lq, h + 1, lr)];
          const table = FLORA_TABLE[biome];
          // Eligible for the surface pass: the biome's surface with AIR over it when the pass begins. Generation 1 shows
          // the land before ponds and flora; a clay vein (generation 2 and up) may have taken a beach's top sand since.
          const eligible = !!table && at(a, lq, h, lr) === table.surface && at(a, lq, h + 1, lr) === B.AIR && !LEAF_IDS.has(was[1])
            && (was[0] === table.surface || was[0] === B.GRAVEL);
          let nearPond = false;
          for (const [dq, dr] of DISC2) if (gen2.pondAt(q + dq, r + dr)) nearPond = true;
          let want;
          if (nearPond) {
            // ponds and their rims are written before the flora pass: the rim plants stay, and a free rim column takes
            // flora like any other. Either way it is the generation-2 cell or a patch plant on the surface.
            const p = table ? patchPlantAt(gen3, q, r, biome) : null;
            if (got.join() !== was.join() && !(p && got[0] === table.surface && got[1] === p.id) && !(got[0] === table?.surface && got[1] === B.AIR)) {
              violations.push(`${q},${r} beside a pond: ${was} → ${got}`);
            }
            continue;
          }
          if (!eligible) want = was;
          else {
            seen.eligible++;
            const p = patchPlantAt(gen3, q, r, biome);
            if (p && fits(gen3, p.row, q, r, h)) {
              want = [table.surface, p.id];
              seen.patch++;
              byBiome.set(biome, (byBiome.get(biome) ?? 0) + 1);
              if (!placed.has(p.patch)) placed.set(p.patch, new Set());
              placed.get(p.patch).add(`${cq},${cr}`);
            } else {
              const rolled = rolledRow(gen3, table, q, r);
              if (!rolled || !fits(gen3, rolled, q, r, h)) want = [table.surface, B.AIR];
              else if (PATCH_IDS.has(rolled.id)) {
                want = [table.surface, B.AIR]; // a food row: generation 3 places nothing
                seen.dropped++;
              } else {
                want = rolled.top ? [rolled.id, B.AIR] : [table.surface, rolled.id];
                if (want.join() !== was.join()) violations.push(`${q},${r}: a kept row moved (${was} → ${want})`);
                seen.kept++;
              }
            }
          }
          if (got.join() !== want.join()) violations.push(`${q},${r} biome ${biome}: got ${got}, want ${want}`);
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(seen.eligible).toBeGreaterThan(5000);
    expect(seen.patch).toBeGreaterThan(60); // patch plants were really checked …
    expect(seen.kept).toBeGreaterThan(300); // … and so were gravel, stones, branches and tussock, unmoved
    expect(seen.dropped).toBeGreaterThan(30); // … and the sprinkled food of generation 2 is gone
    for (const b of [BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY]) expect(byBiome.get(b) ?? 0, BIOME_NAMES[b]).toBeGreaterThan(0);
    // a patch can span chunks: some do here, and each was whole on both sides (every column above matched)
    const spanning = [...placed.values()].filter((chunks) => chunks.size > 1).length;
    expect(spanning).toBeGreaterThanOrEqual(2);
  });

  it('everything else is generation 2, but for mushrooms on cave floors exactly where CAVE_TROOP puts them', () => {
    const violations = [];
    let cave = 0;
    const troops = new Map();
    const salt = PATCH_SALT + PATCH_TABLE.length;
    const CAVE_TOP_MARGIN = 4;
    const CAVE_MIN_Y = 6;
    for (const [cq, cr] of CHUNKS) {
      const b = chunkOf(gen2, cq, cr);
      const c = chunkOf(gen3, cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const h = c.heights[columnIndex(lq, lr)];
          // where the contract puts a cave mushroom in this column, if anywhere (the generation-2 column is the cave)
          let wantY = -1;
          let wantId = 0;
          const troop = rowPlantAt(gen3, CAVE_TROOP, salt, q, r, () => CAVE_TROOP.chance);
          if (troop) {
            for (let y = h - CAVE_TOP_MARGIN; y > CAVE_MIN_Y; y--) {
              if (at(b, lq, y, lr) !== B.AIR || at(b, lq, y - 1, lr) === B.AIR) continue;
              if (at(b, lq, y - 1, lr) === B.STONE) {
                wantY = y;
                wantId = troop.id;
              }
              break;
            }
          }
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            if (y === h || y === h + 1) continue; // the surface pass (the test above)
            const u = at(b, lq, y, lr);
            const v = at(c, lq, y, lr);
            const want = y === wantY ? wantId : u;
            if (v !== want) violations.push(`${q},${y},${r}: gen 2 ${u}, gen 3 ${v}, want ${want}`);
          }
          if (wantY >= 0) {
            cave++;
            if (!troops.has(troop.patch)) troops.set(troop.patch, new Set());
            troops.get(troop.patch).add(`${cq},${cr}`);
            // in the dark, on stone, under at least four cells of ground
            expect(wantY).toBeLessThanOrEqual(h - CAVE_TOP_MARGIN);
            expect(MUSHROOMS.has(wantId)).toBe(true);
          }
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(cave).toBeGreaterThan(5);
    expect([...troops.values()].some((chunks) => chunks.size > 1) || troops.size > 3).toBe(true);
  });

  it('is deterministic: a chunk is the same whatever was generated before it, by a fresh generator too', () => {
    const coords = [[0, 0], [1, 0], [0, 1], [1, -1], [-1, 1], [-1, 0], [0, -1], [40, -30]];
    const fresh = createWorldGen(SEED, { gen: 3 });
    const backwards = [...coords].reverse().map(([q, r]) => digest(fresh.generateChunk(q, r))).reverse();
    expect(backwards).toEqual(coords.map(([q, r]) => digest(chunkOf(gen3, q, r))));
    // one generator's scratch never leaks from one chunk into the next
    const again = createWorldGen(SEED, { gen: 3 });
    again.generateChunk(40, -30);
    expect(digest(again.generateChunk(0, 0))).toBe(digest(chunkOf(gen3, 0, 0)));
  });

  it('a patch plant stands on its biome\'s surface with open air over it — never on gravel, in water, on a trunk or stacked', () => {
    let checked = 0;
    for (const [cq, cr] of CHUNKS) {
      const c = chunkOf(gen3, cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const ci = columnIndex(lq, lr);
          const h = c.heights[ci];
          const above = at(c, lq, h + 1, lr);
          if (!PATCH_IDS.has(above) || gen3.pondAt(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr)) continue;
          const table = FLORA_TABLE[c.biomes[ci]];
          if (above === B.CATTAILS && at(c, lq, h, lr) !== table.surface) continue; // a pond rim's, on grass in any pond biome
          expect(at(c, lq, h, lr), `${cq},${cr} ${lq},${lr}`).toBe(table.surface);
          const over = at(c, lq, h + 2, lr);
          expect(over === B.AIR || LEAF_IDS.has(over), `${cq},${cr} ${lq},${lr} over`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe('generation 3: less food, and in bunches (measured over the scan)', () => {
  const FOOD_BIOMES = [BIOME.BEACH, BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY];

  it('the scan is wide enough to measure: thousands of land columns of every food biome', () => {
    expect(REGIONS.length).toBe(46);
    for (const b of FOOD_BIOMES) expect(s2.land[b], BIOME_NAMES[b]).toBeGreaterThan(10000);
    expect(s3.land).toEqual(s2.land); // the land itself is the same
  });

  it('about half the food plants of generation 2 — every food biome has fewer, and none has none', () => {
    const total2 = FOOD_BIOMES.reduce((n, b) => n + foodIn(s2, b), 0);
    const total3 = FOOD_BIOMES.reduce((n, b) => n + foodIn(s3, b), 0);
    // MEASURED on this scan (736 chunks): 2293 food plants in generation 2, 1069 in generation 3 — a ratio of 0.47.
    // By biome: beach 37 → 18, plains 793 → 358, forest 1038 → 424, desert 254 → 164, snowy 171 → 105.
    expect(total2).toBeGreaterThan(2000);
    expect(total3 / total2).toBeGreaterThan(0.38);
    expect(total3 / total2).toBeLessThan(0.65);
    for (const b of FOOD_BIOMES) {
      const [n2, n3] = [foodIn(s2, b), foodIn(s3, b)];
      expect(n3, `${BIOME_NAMES[b]}: some food`).toBeGreaterThan(0);
      expect(n3, `${BIOME_NAMES[b]}: less food (${n2} → ${n3})`).toBeLessThan(n2 * 0.85);
      expect(n3, `${BIOME_NAMES[b]}: not a famine (${n2} → ${n3})`).toBeGreaterThan(n2 * 0.25);
    }
    // nothing grows where nothing grew: no food on mountains, peaks or the sea floor
    for (const b of [BIOME.OCEAN, BIOME.MOUNTAINS, BIOME.SNOWY_PEAKS]) expect(foodIn(s3, b)).toBe(0);
    // the old kinds, each scarcer than it was
    for (const id of [B.HONEYBERRY_BUSH, B.TUBER_PLANT, B.PRICKLY_PEAR]) {
      expect(countOf(s3, id), BLOCKS[id].name).toBeGreaterThan(0);
      expect(countOf(s3, id), BLOCKS[id].name).toBeLessThan(countOf(s2, id) * 0.8);
    }
    // the honeyberry stays the commonest food plant of the woods
    for (const id of [B.TUBER_PLANT, B.HONEYCAP_MUSHROOM, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.ONION_PLANT, B.CARROT_PLANT]) {
      expect(countOf(s3, B.HONEYBERRY_BUSH, BIOME.FOREST), BLOCKS[id].name).toBeGreaterThan(countOf(s3, id, BIOME.FOREST));
    }
  });

  it('clustered: nearly every food plant has another of its kind within 3 cells (a third did in generation 2)', () => {
    const [w2, t2] = clustered(s2);
    const [w3, t3] = clustered(s3);
    // MEASURED: 35 % in generation 2, 94 % in generation 3.
    expect(w2 / t2).toBeLessThan(0.5);
    expect(w3 / t3).toBeGreaterThan(0.9);
    for (const [kind, [w, t]] of s3.near) {
      if (t < 20) continue;
      expect(w / t, kind).toBeGreaterThan(kind === 'cattails' ? 0.6 : 0.85); // cattails also ring ponds, a few at a time
    }
    expect(t3).toBeGreaterThan(800);
  });

  it('nothing for a while, then a bunch: most stretches of land hold no food at all, where few did before', () => {
    // MEASURED: of the 716 chunks that are mostly land, 16 % held no food plant in generation 2 and 67 % hold none in
    // generation 3; a chunk that does hold food holds 3.8 plants in generation 2 and 4.5 in generation 3.
    expect(s2.landChunks).toBe(s3.landChunks);
    expect(s2.landChunks).toBeGreaterThan(400);
    expect(s2.emptyChunks / s2.landChunks).toBeLessThan(0.4);
    expect(s3.emptyChunks / s3.landChunks).toBeGreaterThan(0.6);
    // … and a chunk that has food has more of it than before
    const total = (s) => FOOD_BIOMES.reduce((n, b) => n + foodIn(s, b), 0);
    const perStocked = (s) => total(s) / (s.landChunks - s.emptyChunks);
    expect(perStocked(s3)).toBeGreaterThan(perStocked(s2) * 1.1);
  });

  it('each new plant grows where it belongs, and nowhere else', () => {
    const where = (id) => FOOD_BIOMES.concat([BIOME.OCEAN, BIOME.MOUNTAINS, BIOME.SNOWY_PEAKS]).filter((b) => countOf(s3, id, b) > 0).map((b) => BIOME_NAMES[b]);
    expect(where(B.HONEYCAP_MUSHROOM)).toEqual(['forest']);
    expect(where(B.FRECKLECAP_MUSHROOM)).toEqual(['forest']);
    expect(where(B.HAZEL_THICKET)).toEqual(['forest']);
    expect(where(B.ONION_PLANT)).toEqual(['plains', 'forest']);
    expect(where(B.CARROT_PLANT)).toEqual(['plains', 'forest']);
    expect(where(B.CRAB_APPLE_BUSH)).toEqual(['plains', 'forest']);
    expect(where(B.HEALWORT_PLANT).slice(0, 2)).toEqual(['plains', 'forest']); // and, more rarely still, on snowy land
    expect(where(B.HEALWORT_PLANT).every((name) => ['plains', 'forest', 'snowy'].includes(name))).toBe(true);
    expect(where(B.PRICKLY_PEAR)).toEqual(['desert']);
    for (const id of [B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.ONION_PLANT, B.CARROT_PLANT, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.HEALWORT_PLANT]) {
      expect(countOf(s2, id), BLOCKS[id].name).toBe(0);
      expect(countOf(s3, id), BLOCKS[id].name).toBeGreaterThan(id === B.HEALWORT_PLANT ? 8 : 20);
    }
    // onion and carrot are plants of the open: far more of them on plains than in the forest (its edge only), per column
    for (const id of [B.ONION_PLANT, B.CARROT_PLANT]) {
      expect(countOf(s3, id, BIOME.PLAINS) / s3.land[BIOME.PLAINS], BLOCKS[id].name).toBeGreaterThan(1.5 * (countOf(s3, id, BIOME.FOREST) / s3.land[BIOME.FOREST]));
    }
  });

  it('mushrooms: a good share of every troop\'s kind is the look-alike, so each one has to be looked at', () => {
    const good = countOf(s3, B.HONEYCAP_MUSHROOM);
    const bad = countOf(s3, B.FRECKLECAP_MUSHROOM);
    // MEASURED: 87 Honeycaps and 51 Frecklecaps on the surface (37 % bad; FRECKLECAP_SHARES average 39 %), and 489
    // mushrooms in caves, 225 of them Frecklecaps.
    expect(good).toBeGreaterThan(bad);
    expect(bad / (good + bad)).toBeGreaterThan(0.2);
    expect(bad / (good + bad)).toBeLessThan(0.6);
    // and in caves, the same two
    expect(s2.cave).toBe(0);
    expect(s3.cave).toBeGreaterThan(100);
    expect(s3.caveBad / s3.cave).toBeGreaterThan(0.2);
    expect(s3.caveBad / s3.cave).toBeLessThan(0.65);
  });

  it('the healing herb is rare but there: under one plant in 2000 columns of its land, and still found in the scan', () => {
    const herb = countOf(s3, B.HEALWORT_PLANT);
    const landOfIt = s3.land[BIOME.PLAINS] + s3.land[BIOME.FOREST] + s3.land[BIOME.SNOWY];
    // MEASURED: 44 plants on 114 070 columns of plains, forest and snowy land — one in about 2600, in patches of 2–4
    // (against 260 honeyberry bushes and 177 tuber plants).
    expect(herb).toBeGreaterThan(8);
    expect(herb / landOfIt).toBeLessThan(1 / 2000);
    expect(herb / landOfIt).toBeGreaterThan(1 / 12000);
    // it comes in small patches too: you find two or three together
    const [w, t] = s3.near.get('healwort');
    expect(w / t).toBeGreaterThan(0.7);
    // far rarer than the common food plants of its land
    for (const id of [B.HONEYBERRY_BUSH, B.TUBER_PLANT]) expect(herb * 2, BLOCKS[id].name).toBeLessThan(countOf(s3, id));
  });
});
