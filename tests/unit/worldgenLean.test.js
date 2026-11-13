// Tests for generation 4, the lean land (v0.15, CONTRACTS §79): generation 3 with most of its food patches gone. A
// generation-4 food patch is always a generation-3 patch of the same seed, so every food plant of the lean land stands
// where it stood in the harder land, and nothing else moves. Generation 3 itself must stay byte for byte what it was.
//
// Generation 4 also grows the plants that are not food (CONTRACTS §81): a poisonous look-alike mixed into the carrot and
// the honeyberry patches (it stands where generation 3 has the plant it imitates), four patch rows of its own and three
// kinds of greenery from the per-column roll — all of which only ever take a cell that generation 3 leaves to the air or
// to a patch plant that is gone.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, GEN_LATEST } from '../../src/config.js';
import { BLOCK, BLOCKS, BIOME } from '../../src/blocks.js';
import { hexLength } from '../../src/hex.js';
import {
  createWorldGen, PATCH_TABLE, PATCH_TABLE_GEN4, CAVE_TROOP, CAVE_TROOP_GEN4, LEAN_PATCH_CHANCE, LEAN_PATCH_FILL, FLORA_TABLE,
  FLORA_TABLE_GEN4, GREENERY_GEN4, PLANT_PATCHES_GEN4, PLANT_PATCH_SALT, PATCH_MIX_STEP, HEMLOCK_SHARES, NIGHTSHADE_SHARES,
  FRECKLECAP_SHARES, FOREST_EDGE_HUMIDITY,
} from '../../src/worldgen.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const gen3 = createWorldGen(SEED, { gen: 3 });
const gen4 = createWorldGen(SEED, { gen: 4 });
/** Every block a patch of generation 3 can place (the plants and their look-alike, the Frecklecap). */
const PATCH_IDS = new Set(PATCH_TABLE.flatMap((row) => (row.mixId !== undefined ? [row.id, row.mixId] : [row.id])));
/** What the per-column flora roll can leave where a patch plant is gone: nothing, or one of the other flora rows. */
const FLORA_IDS = new Set(FLORA_TABLE.filter(Boolean).flatMap((t) => t.rows.map((row) => row.id)));
/** §81: the plants only generation 4 grows — the two look-alikes, the two useful plants and the greenery. */
const NEW_PLANTS = new Set([B.HEMLOCK, B.NIGHTSHADE_BUSH, B.FLAX, B.ALOE, B.FERN, B.MEADOW_DAISIES, B.THISTLE]);
/** The plant a look-alike imitates. */
const IMITATES = new Map([[B.HEMLOCK, B.CARROT_PLANT], [B.NIGHTSHADE_BUSH, B.HONEYBERRY_BUSH]]);
/** A 9 × 9 block of chunks around the origin and another far away: plains, forest, beach, desert and caves. */
const CHUNKS = [];
for (let cq = -4; cq <= 4; cq++) for (let cr = -4; cr <= 4; cr++) CHUNKS.push([cq, cr], [cq + 40, cr - 25]);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

describe('generation 4: the lean land (worldgen.js, CONTRACTS §79)', () => {
  it('was the newest generation until §85 added the fifth, and its table begins with PATCH_TABLE thinned row for row', () => {
    expect(GEN_LATEST).toBe(6); // §85: generation 5 is generation 4 with natural springs, and its gravel in beds; §89: 6 adds aquifers
    expect(gen4.gen).toBe(4);
    expect(createWorldGen(SEED, { gen: 9 }).gen).toBe(GEN_LATEST); // a number above the newest is the newest
    expect([LEAN_PATCH_CHANCE, LEAN_PATCH_FILL]).toEqual([0.45, 0.8]);
    // §81: four rows of plants that are not food follow PATCH_TABLE's ten (tested below)
    expect(PATCH_TABLE_GEN4).toHaveLength(PATCH_TABLE.length + 4);
    PATCH_TABLE.forEach((row, i) => {
      const lean = PATCH_TABLE_GEN4[i];
      expect([lean.key, lean.id, lean.cell, lean.radius, lean.ring], row.key).toEqual([row.key, row.id, row.cell, row.radius, row.ring]);
      expect(lean.salt, row.key).toBeUndefined(); // its salt is its index, as in generation 3: the same centres and rolls
      expect(lean.fill, row.key).toBeCloseTo(row.fill * LEAN_PATCH_FILL, 12);
      // the Healwort heals, it does not feed: its patches are kept (it was already about one in 10 000 columns)
      const keep = row.key === 'healwort' ? 1 : LEAN_PATCH_CHANCE;
      row.chance.forEach((c, b) => expect(lean.chance[b], `${row.key} biome ${b}`).toBeCloseTo(c * keep, 12));
      // §81: the look-alike of a row. The carrot row gets the Hemlock and the honeyberry row the Nightshade; every other
      // row keeps what it had (the mushrooms their Frecklecap, the rest none)
      const mix = { carrot: [B.HEMLOCK, HEMLOCK_SHARES], honeyberry: [B.NIGHTSHADE_BUSH, NIGHTSHADE_SHARES] }[row.key] ?? [row.mixId, row.mixShares];
      expect([lean.mixId, lean.mixShares], row.key).toEqual(mix);
    });
    expect(PATCH_TABLE_GEN4[4]).toMatchObject({ key: 'mushrooms', mixId: B.FRECKLECAP_MUSHROOM, mixShares: FRECKLECAP_SHARES });
    expect(PATCH_TABLE.filter((row) => row.mixId !== undefined).map((row) => row.key)).toEqual(['mushrooms']); // generation 3 is as it was
    expect(CAVE_TROOP_GEN4.chance).toBeCloseTo(CAVE_TROOP.chance * LEAN_PATCH_CHANCE, 12);
    expect(CAVE_TROOP_GEN4.fill).toBeCloseTo(CAVE_TROOP.fill * LEAN_PATCH_FILL, 12);
    expect(gen4.PATCH_TABLE).toBe(PATCH_TABLE_GEN4);
    expect(gen3.PATCH_TABLE).toBe(PATCH_TABLE);
  });

  it('every food plant of generation 4 stands where generation 3 has the same plant, a look-alike where it has the plant it imitates; a new plant only on a cell that was air or a patch plant; nothing else moves', () => {
    let food3 = 0;
    let food4 = 0;
    let lookalike4 = 0;
    /** new plants by what generation 3 has in their cell: 'air', 'twin' (the plant a look-alike imitates) or 'gone' (another patch plant) */
    const under = { air: 0, twin: 0, gone: 0 };
    const count = new Map();
    for (const [cq, cr] of CHUNKS) {
      const a = gen3.generateChunk(cq, cr).blocks;
      const b = gen4.generateChunk(cq, cr).blocks;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (PATCH_IDS.has(x)) food3++;
        if (PATCH_IDS.has(y)) {
          food4++;
          if (y === B.FRECKLECAP_MUSHROOM) lookalike4++;
          if (x !== y) throw new Error(`chunk ${cq},${cr} cell ${i}: generation 4 has ${BLOCKS[y].name} where generation 3 has ${BLOCKS[x].name}`);
        } else if (NEW_PLANTS.has(y)) {
          // §81: a plant that is not food. Generation 3 has air there, or a patch plant (the one a look-alike imitates, or one
          // whose patch generation 4 lost) — never grass, stones or a branch: what the roll of generation 3 puts down stays
          count.set(y, (count.get(y) ?? 0) + 1);
          if (x === B.AIR) under.air++;
          else if (x === IMITATES.get(y)) under.twin++;
          else if (PATCH_IDS.has(x)) under.gone++;
          else throw new Error(`chunk ${cq},${cr} cell ${i}: generation 4 has ${BLOCKS[y].name} where generation 3 has ${BLOCKS[x].name}`);
          // it stands on the very ground generation 3 has there (never on a gravel patch that came with the lean land)
          if (a[i - 1] !== b[i - 1]) throw new Error(`chunk ${cq},${cr} cell ${i}: the ground under ${BLOCKS[y].name} changed`);
        } else if (x !== y) {
          // a patch plant that is gone leaves air, or what the per-column roll puts there instead (grass, stones, a
          // branch on the same cell; a gravel patch in the ground cell below)
          const here = PATCH_IDS.has(x);
          const above = i % WORLD_HEIGHT < WORLD_HEIGHT - 1 && PATCH_IDS.has(a[i + 1]);
          if (!(here || above)) throw new Error(`chunk ${cq},${cr} cell ${i}: ${BLOCKS[x].name} became ${BLOCKS[y].name} away from any patch plant`);
          if (!(y === B.AIR || FLORA_IDS.has(y))) throw new Error(`chunk ${cq},${cr} cell ${i}: a patch plant became ${BLOCKS[y].name}`);
        }
      }
    }
    // 162 chunks (41 472 columns): generation 3 has 310 patch plants there. Generation 4 had 106 of them before §81 and has
    // 103 now: three became a look-alike (0.45 of the patches × 0.8 of their plants = 0.36, give or take: the Healwort
    // keeps its patches, and the look-alikes take a share of the carrots and honeyberries)
    expect(food3).toBeGreaterThan(250);
    expect(food4 / food3).toBeGreaterThan(0.22);
    expect(food4 / food3).toBeLessThan(0.48);
    expect(food4).toBeGreaterThan(60); // lean, not barren
    expect(lookalike4).toBeGreaterThan(0); // the Frecklecap still hides among the Honeycaps
    expect(CHUNKS.length * CHUNK_SIZE * CHUNK_SIZE).toBe(162 * 256);
    // §81: the land is full of plants all the same — far more of them than of food (here 692 ferns, daisies and thistles
    // against 103 food plants)
    const n = (id) => count.get(id) ?? 0;
    const greenery = n(B.FERN) + n(B.MEADOW_DAISIES) + n(B.THISTLE);
    expect(greenery).toBeGreaterThan(5 * food4);
    // … most on what was open ground; some look-alikes where generation 3 has their twin; a few where a patch is gone
    expect(under.air).toBeGreaterThan(greenery * 0.95);
    expect(under.twin).toBeGreaterThan(0);
    expect(under.air + under.twin + under.gone).toBe([...count.values()].reduce((s, c) => s + c, 0));
    expect(n(B.HEMLOCK) + n(B.NIGHTSHADE_BUSH)).toBeGreaterThanOrEqual(under.twin);
  });

  it('streams, ponds and the stream map are generation 3\'s', () => {
    for (let q = -80; q <= 80; q += 3) {
      for (let r = -80; r <= 80; r += 3) {
        if (gen3.streamAt(q, r) !== gen4.streamAt(q, r) || gen3.streamLevelAt(q, r) !== gen4.streamLevelAt(q, r)
          || gen3.pondTaintedAt(q, r) !== gen4.pondTaintedAt(q, r)) throw new Error(`water differs at ${q},${r}`);
      }
    }
    const c3 = gen3.getColumn(12, -7);
    expect(gen4.getColumn(12, -7)).toEqual(c3);
  });
});

/**
 * sha1 digests of generations 1, 2 and 3, by seed: the blocks of the 5 × 5 chunks round the origin, taken at c644cb2 (the
 * commit §81 starts from) with the loop below.
 */
const DIGESTS = {
  [SEED]: ['71e32231ef86005fb6a67a22e5817b366d21e501', '979314b597ffffb32d8477ee09af299b58dd683e', '0ffa140ff78303ebd66a3c342f93a66d1ca59662'],
  4242: ['f08e35be4b0a67306fe72743da1ebf72be0898ef', '3362a819bb7007b14e15692b0d170ad7683ee60a', 'eed835ff1e90ecd82fdcfacc64ce772b5598a2de'],
};

describe('generations 1–3 are byte for byte what they were before §81', () => {
  /** sha1 over the blocks of the 5 × 5 chunks round the origin, in (cq, cr) order. */
  const digest = (seed, gen) => {
    const g = createWorldGen(seed, { gen });
    const h = createHash('sha1');
    for (let cq = -2; cq <= 2; cq++) for (let cr = -2; cr <= 2; cr++) h.update(Buffer.from(g.generateChunk(cq, cr).blocks));
    return h.digest('hex');
  };

  it('the digests of 25 chunks of each generation, on two seeds, are the ones taken from the code before the change', () => {
    expect([1, 2, 3].map((gen) => digest(SEED, gen))).toEqual(DIGESTS[SEED]);
    expect([1, 2, 3].map((gen) => digest(4242, gen))).toEqual(DIGESTS[4242]);
  });

  it('none of the new plants grows below generation 4', () => {
    for (const gen of [1, 2, 3]) {
      const g = createWorldGen(SEED, { gen });
      for (const [cq, cr] of CHUNKS.slice(0, 40)) {
        const { blocks } = g.generateChunk(cq, cr);
        for (let i = 0; i < blocks.length; i++) if (blocks[i] >= B.FERN && blocks[i] <= B.ALOE) throw new Error(`generation ${gen} grew ${BLOCKS[blocks[i]].name}`);
      }
      expect(g.FLORA_TABLE).toBe(FLORA_TABLE);
    }
  });
});

describe('generation 4: the plants that are not food (worldgen.js, CONTRACTS §81)', () => {
  const row = (key) => PATCH_TABLE_GEN4.find((r) => r.key === key);
  const biomesOf = (r) => r.chance.map((c, b) => (c > 0 ? b : -1)).filter((b) => b >= 0);

  it('the greenery: FLORA_TABLE_GEN4 is FLORA_TABLE with the new rows after each biome\'s own, so no slice of the roll moves', () => {
    expect(GREENERY_GEN4).toEqual({
      PLAINS: [{ id: B.MEADOW_DAISIES, chance: 0.04 }, { id: B.THISTLE, chance: 0.01 }],
      FOREST: [{ id: B.FERN, chance: 0.05 }],
      MOUNTAINS: [{ id: B.THISTLE, chance: 0.01 }],
    });
    expect(FLORA_TABLE_GEN4).toHaveLength(FLORA_TABLE.length);
    FLORA_TABLE.forEach((table, biome) => {
      const lean = FLORA_TABLE_GEN4[biome];
      const extra = GREENERY_GEN4[Object.keys(BIOME)[biome]];
      if (!extra) {
        expect(lean, `biome ${biome}`).toBe(table); // nothing added: the very same table
        return;
      }
      expect(lean.surface).toBe(table.surface);
      expect(lean.rows.slice(0, table.rows.length), `biome ${biome}`).toEqual(table.rows); // every old row, in its place
      lean.rows.slice(0, table.rows.length).forEach((r, i) => expect(r).toBe(table.rows[i]));
      expect(lean.rows.slice(table.rows.length), `biome ${biome}`).toEqual(extra);
      expect(lean.rows.reduce((s, r) => s + r.chance, 0)).toBeLessThan(1);
    });
    expect(Object.isFrozen(FLORA_TABLE_GEN4) && FLORA_TABLE_GEN4.every((t) => t === null || (Object.isFrozen(t) && Object.isFrozen(t.rows)))).toBe(true);
    expect(gen4.FLORA_TABLE).toBe(FLORA_TABLE_GEN4);
    expect(gen3.FLORA_TABLE).toBe(FLORA_TABLE);
    // the greenery is not food and no patch row places it: its rows are rolled, not skipped
    for (const rows of Object.values(GREENERY_GEN4)) for (const r of rows) expect(PATCH_TABLE_GEN4.some((p) => p.id === r.id || p.mixId === r.id)).toBe(false);
  });

  it('the look-alike shares: about a third of the carrots of a patch, about a fifth of the honeyberries', () => {
    expect([...HEMLOCK_SHARES]).toEqual([0, 0.25, 0.5, 0.5]);
    expect([...NIGHTSHADE_SHARES]).toEqual([0, 0, 0.25, 0.5]);
    expect(mean(HEMLOCK_SHARES)).toBeCloseTo(0.3125, 12);
    expect(mean(NIGHTSHADE_SHARES)).toBeCloseTo(0.1875, 12);
    expect(Object.isFrozen(HEMLOCK_SHARES) && Object.isFrozen(NIGHTSHADE_SHARES)).toBe(true);
    // no patch is all look-alike (a Frecklecap troop can be): there is always a real plant to compare with
    expect(Math.max(...HEMLOCK_SHARES, ...NIGHTSHADE_SHARES)).toBe(0.5);
    expect(Math.max(...FRECKLECAP_SHARES)).toBe(1);
  });

  it('the four new patch rows: salts of their own, small patches, each as common as the brief of §81 says', () => {
    expect(PATCH_TABLE_GEN4.slice(PATCH_TABLE.length)).toEqual([...PLANT_PATCHES_GEN4]);
    expect(PLANT_PATCHES_GEN4.map((r) => [r.key, r.id, r.cell, r.radius, r.fill])).toEqual([
      ['hemlock', B.HEMLOCK, 40, 1, 0.35], ['nightshade', B.NIGHTSHADE_BUSH, 32, 1, 0.35], ['flax', B.FLAX, 40, 1, 0.65], ['aloe', B.ALOE, 28, 1, 0.43],
    ]);
    // salts: PATCH_TABLE's rows use their index (0–9) and the cave troops PATCH_TABLE.length (10); the new rows 11–14
    expect(PLANT_PATCH_SALT).toBe(PATCH_TABLE.length + 1);
    expect(PLANT_PATCHES_GEN4.map((r) => r.salt)).toEqual([11, 12, 13, 14]);
    const salts = [...PATCH_TABLE.map((_, i) => i), PATCH_TABLE.length, ...PLANT_PATCHES_GEN4.map((r) => r.salt)];
    expect(new Set(salts).size).toBe(salts.length);
    expect(Math.max(...salts)).toBeLessThan(PATCH_MIX_STEP); // the look-alike rolls (salt + PATCH_MIX_STEP) stay clear of them
    for (const r of PLANT_PATCHES_GEN4) {
      expect(Object.isFrozen(r) && Object.isFrozen(r.chance), r.key).toBe(true);
      expect([r.mixId, r.ring], r.key).toEqual([undefined, undefined]);
    }
    // hemlock: the wild carrot's own patches again — its cell, its generation-4 chances, the forest's edge only — but small
    expect(row('hemlock').chance).toEqual(row('carrot').chance);
    expect([row('hemlock').cell, row('hemlock').edgeBelow]).toEqual([row('carrot').cell, FOREST_EDGE_HUMIDITY]);
    expect(biomesOf(row('hemlock'))).toEqual([BIOME.PLAINS, BIOME.FOREST]);
    expect(row('hemlock').radius).toBeLessThan(row('carrot').radius);
    // nightshade: the honeyberry's forest patches again, small; no patches of its own on plains or in the snow
    expect(biomesOf(row('nightshade'))).toEqual([BIOME.FOREST]);
    expect([row('nightshade').cell, row('nightshade').chance[BIOME.FOREST]]).toEqual([row('honeyberry').cell, row('honeyberry').chance[BIOME.FOREST]]);
    // flax: as many patches as the wild onion had on generation-3 plains; a full patch is 7 columns × 0.65 = 4.6 plants
    const onion3 = PATCH_TABLE.find((r) => r.key === 'onion');
    expect(biomesOf(row('flax'))).toEqual([BIOME.PLAINS]);
    expect([row('flax').cell, row('flax').chance[BIOME.PLAINS]]).toEqual([onion3.cell, onion3.chance[BIOME.PLAINS]]);
    expect(7 * row('flax').fill).toBeGreaterThan(3);
    expect(7 * row('flax').fill).toBeLessThan(6);
    // aloe: half as many patches as the prickly pear had in the generation-3 desert; a full patch is 7 × 0.43 = 3 plants
    const pear3 = PATCH_TABLE.find((r) => r.key === 'prickly_pear');
    expect(biomesOf(row('aloe'))).toEqual([BIOME.DESERT]);
    expect([row('aloe').cell, row('aloe').chance[BIOME.DESERT]]).toEqual([pear3.cell, pear3.chance[BIOME.DESERT] / 2]);
    expect(7 * row('aloe').fill).toBeGreaterThan(2);
    expect(7 * row('aloe').fill).toBeLessThan(4);
  });

  it('measured over 1 089 chunks: how much of each grows, and where', () => {
    // seed 4242, the 33 × 33 chunks round the origin: 126 000 columns of plains, 50 000 of forest, 32 000 of desert
    const gen = createWorldGen(4242, { gen: 4 });
    const R = 16;
    const columns = new Array(8).fill(0);
    /** @type {Map<number, number[]>} plant id → how many stand in each biome */
    const grown = new Map();
    /** @type {Map<number, [number, number][]>} where every plant of the patch kinds stands */
    const where = new Map([[B.FLAX, []], [B.ALOE, []], [B.HEMLOCK, []], [B.NIGHTSHADE_BUSH, []]]);
    for (let cq = -R; cq <= R; cq++) {
      for (let cr = -R; cr <= R; cr++) {
        const c = gen.generateChunk(cq, cr);
        for (let ci = 0; ci < CHUNK_SIZE * CHUNK_SIZE; ci++) {
          const biome = c.biomes[ci];
          columns[biome]++;
          const id = c.blocks[ci * WORLD_HEIGHT + c.heights[ci] + 1];
          if (!NEW_PLANTS.has(id) && id !== B.CARROT_PLANT && id !== B.HONEYBERRY_BUSH) continue;
          if (!grown.has(id)) grown.set(id, new Array(8).fill(0));
          grown.get(id)[biome]++;
          where.get(id)?.push([cq * CHUNK_SIZE + (ci >> 4), cr * CHUNK_SIZE + (ci & 15)]);
        }
      }
    }
    const n = (id, biome) => grown.get(id)?.[biome] ?? 0;
    const total = (id) => (grown.get(id) ?? []).reduce((s, x) => s + x, 0);
    const biomes = (id) => (grown.get(id) ?? []).map((x, b) => (x > 0 ? b : -1)).filter((b) => b >= 0);
    const share = (id, biome) => n(id, biome) / columns[biome];
    expect(columns[BIOME.PLAINS]).toBeGreaterThan(100000);
    expect(columns[BIOME.FOREST]).toBeGreaterThan(40000);
    expect(columns[BIOME.DESERT]).toBeGreaterThan(15000);

    // ---- the greenery, by the roll: ferns on about 5 % of the forest's columns, daisies on about 4 % of the plains',
    // a thistle on about 1 % of the plains' and of the mountains' — and nowhere else
    expect(biomes(B.FERN)).toEqual([BIOME.FOREST]);
    expect(biomes(B.MEADOW_DAISIES)).toEqual([BIOME.PLAINS]);
    expect(biomes(B.THISTLE)).toEqual([BIOME.PLAINS, BIOME.MOUNTAINS]);
    expect(share(B.FERN, BIOME.FOREST)).toBeGreaterThan(0.045);
    expect(share(B.FERN, BIOME.FOREST)).toBeLessThan(0.052);
    expect(share(B.MEADOW_DAISIES, BIOME.PLAINS)).toBeGreaterThan(0.036);
    expect(share(B.MEADOW_DAISIES, BIOME.PLAINS)).toBeLessThan(0.042);
    expect(share(B.THISTLE, BIOME.PLAINS)).toBeGreaterThan(0.008);
    expect(share(B.THISTLE, BIOME.PLAINS)).toBeLessThan(0.012);
    expect(share(B.THISTLE, BIOME.MOUNTAINS)).toBeGreaterThan(0.005);
    expect(share(B.THISTLE, BIOME.MOUNTAINS)).toBeLessThan(0.02);

    // ---- the look-alikes. About half of what looks like a wild carrot is Hemlock (its share of the carrots' patches,
    // and as many small patches of its own); Nightshade is rarer: about four bushes in ten in the forest, where it has
    // patches of its own, and about one in six elsewhere, where it is only mixed in
    const hemlock = total(B.HEMLOCK);
    const carrots = total(B.CARROT_PLANT);
    expect(hemlock + carrots).toBeGreaterThan(40);
    expect(hemlock / (hemlock + carrots)).toBeGreaterThan(0.35);
    expect(hemlock / (hemlock + carrots)).toBeLessThan(0.65);
    expect(biomes(B.HEMLOCK).every((b) => b === BIOME.PLAINS || b === BIOME.FOREST)).toBe(true);
    const nightForest = n(B.NIGHTSHADE_BUSH, BIOME.FOREST);
    const berryForest = n(B.HONEYBERRY_BUSH, BIOME.FOREST);
    expect(nightForest + berryForest).toBeGreaterThan(60);
    expect(nightForest / (nightForest + berryForest)).toBeGreaterThan(0.25);
    expect(nightForest / (nightForest + berryForest)).toBeLessThan(0.6);
    const nightElse = total(B.NIGHTSHADE_BUSH) - nightForest;
    const berryElse = total(B.HONEYBERRY_BUSH) - berryForest;
    expect(nightElse / (nightElse + berryElse)).toBeLessThan(0.35);
    expect(biomes(B.NIGHTSHADE_BUSH).every((b) => [BIOME.PLAINS, BIOME.FOREST, BIOME.SNOWY].includes(b))).toBe(true); // where the honeyberry grows

    // ---- the useful plants: flax on the plains only, aloe in the desert only, both in small tight patches
    expect(biomes(B.FLAX)).toEqual([BIOME.PLAINS]);
    expect(biomes(B.ALOE)).toEqual([BIOME.DESERT]);
    /** The patches of a kind: plants within two cells of each other are one patch (a patch is seven columns across three). */
    const patches = (id) => {
      const left = [...where.get(id)];
      const out = [];
      while (left.length) {
        const patch = [left.pop()];
        for (let k = 0; k < patch.length; k++) {
          for (let j = left.length - 1; j >= 0; j--) {
            if (hexLength(left[j][0] - patch[k][0], left[j][1] - patch[k][1]) <= 2) patch.push(...left.splice(j, 1));
          }
        }
        out.push(patch.length);
      }
      return out;
    };
    const flax = patches(B.FLAX);
    const aloe = patches(B.ALOE);
    // flax: patches of 3–6 (at most the seven columns of a patch), about one plant in 2 000 columns of plains
    expect(flax.length).toBeGreaterThan(8);
    expect(mean(flax)).toBeGreaterThan(3);
    expect(mean(flax)).toBeLessThan(6);
    expect(Math.max(...flax)).toBeLessThanOrEqual(7);
    expect(columns[BIOME.PLAINS] / total(B.FLAX)).toBeGreaterThan(1200);
    expect(columns[BIOME.PLAINS] / total(B.FLAX)).toBeLessThan(3500);
    // aloe: patches of 2–4, about one plant in 800 columns of desert
    expect(aloe.length).toBeGreaterThan(4);
    expect(mean(aloe)).toBeGreaterThan(2);
    expect(mean(aloe)).toBeLessThan(4);
    expect(Math.max(...aloe)).toBeLessThanOrEqual(7);
    expect(columns[BIOME.DESERT] / total(B.ALOE)).toBeGreaterThan(400);
    expect(columns[BIOME.DESERT] / total(B.ALOE)).toBeLessThan(2000);
    // the look-alikes' own patches are small too: no hemlock or nightshade stands in a crowd of its own kind
    expect(Math.max(...patches(B.HEMLOCK))).toBeLessThanOrEqual(10);
    expect(Math.max(...patches(B.NIGHTSHADE_BUSH))).toBeLessThanOrEqual(10);
  });

  it('every new plant stands on its biome\'s own ground with air above it', () => {
    const ground = { [B.FERN]: [B.GRASS_BLOCK], [B.MEADOW_DAISIES]: [B.GRASS_BLOCK], [B.THISTLE]: [B.GRASS_BLOCK, B.STONE],
      [B.HEMLOCK]: [B.GRASS_BLOCK], [B.NIGHTSHADE_BUSH]: [B.GRASS_BLOCK, B.SNOWY_GRASS], [B.FLAX]: [B.GRASS_BLOCK], [B.ALOE]: [B.SAND] };
    let seen = 0;
    for (const [cq, cr] of CHUNKS) {
      const c = gen4.generateChunk(cq, cr);
      for (let ci = 0; ci < CHUNK_SIZE * CHUNK_SIZE; ci++) {
        for (let y = 1; y < WORLD_HEIGHT - 1; y++) {
          const id = c.blocks[ci * WORLD_HEIGHT + y];
          if (!NEW_PLANTS.has(id)) continue;
          seen++;
          // on the generated surface (never in a cave, on a tree or in water), its ground the biome's surface block
          if (y !== c.heights[ci] + 1) throw new Error(`${BLOCKS[id].name} at height ${y}, surface ${c.heights[ci]}`);
          if (!ground[id].includes(c.blocks[ci * WORLD_HEIGHT + y - 1])) throw new Error(`${BLOCKS[id].name} on ${BLOCKS[c.blocks[ci * WORLD_HEIGHT + y - 1]].name}`);
          if (c.blocks[ci * WORLD_HEIGHT + y + 1] !== B.AIR) throw new Error(`${BLOCKS[id].name} under ${BLOCKS[c.blocks[ci * WORLD_HEIGHT + y + 1]].name}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(500); // 706 in these 162 chunks
  });

  it('a chunk and its neighbours agree: the same column holds the same plant whichever chunk asks (patches straddle borders)', () => {
    // generateChunk is pure in (seed, cq, cr); a patch that crosses a border is written by each chunk for its own columns.
    // Generate twice from fresh generators, in a different order: the bytes must match.
    const a = createWorldGen(SEED, { gen: 4 });
    const b = createWorldGen(SEED, { gen: 4 });
    const order = CHUNKS.slice(0, 30);
    const first = order.map(([cq, cr]) => a.generateChunk(cq, cr).blocks);
    const second = [...order].reverse().map(([cq, cr]) => b.generateChunk(cq, cr).blocks).reverse();
    first.forEach((blocks, i) => expect(Buffer.compare(Buffer.from(blocks), Buffer.from(second[i])), `chunk ${order[i]}`).toBe(0));
  });
});
