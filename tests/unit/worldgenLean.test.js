// Tests for generation 4, the lean land (v0.15, CONTRACTS §79): generation 3 with most of its food patches gone. A
// generation-4 patch is always a generation-3 patch of the same seed, so every food plant of the lean land stands where
// it stood in the harder land, and nothing else moves. Generation 3 itself must stay byte for byte what it was.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, GEN_LATEST } from '../../src/config.js';
import { BLOCK, BLOCKS } from '../../src/blocks.js';
import {
  createWorldGen, PATCH_TABLE, PATCH_TABLE_GEN4, CAVE_TROOP, CAVE_TROOP_GEN4, LEAN_PATCH_CHANCE, LEAN_PATCH_FILL, FLORA_TABLE,
} from '../../src/worldgen.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const gen3 = createWorldGen(SEED, { gen: 3 });
const gen4 = createWorldGen(SEED, { gen: 4 });
/** Every block a patch can place (the plants and their look-alikes). */
const PATCH_IDS = new Set(PATCH_TABLE.flatMap((row) => (row.mixId !== undefined ? [row.id, row.mixId] : [row.id])));
/** What the per-column flora roll can leave where a patch plant is gone: nothing, or one of the other flora rows. */
const FLORA_IDS = new Set(FLORA_TABLE.filter(Boolean).flatMap((t) => t.rows.map((row) => row.id)));
/** A 9 × 9 block of chunks around the origin and another far away: plains, forest, beach, desert and caves. */
const CHUNKS = [];
for (let cq = -4; cq <= 4; cq++) for (let cr = -4; cr <= 4; cr++) CHUNKS.push([cq, cr], [cq + 40, cr - 25]);

describe('generation 4: the lean land (worldgen.js, CONTRACTS §79)', () => {
  it('is the newest generation, and its table is PATCH_TABLE thinned row for row', () => {
    expect(GEN_LATEST).toBe(4);
    expect(gen4.gen).toBe(4);
    expect(createWorldGen(SEED, { gen: 9 }).gen).toBe(4); // a number above the newest is the newest
    expect([LEAN_PATCH_CHANCE, LEAN_PATCH_FILL]).toEqual([0.45, 0.8]);
    expect(PATCH_TABLE_GEN4).toHaveLength(PATCH_TABLE.length);
    PATCH_TABLE.forEach((row, i) => {
      const lean = PATCH_TABLE_GEN4[i];
      expect([lean.key, lean.id, lean.cell, lean.radius, lean.ring, lean.mixId], row.key).toEqual([row.key, row.id, row.cell, row.radius, row.ring, row.mixId]);
      expect(lean.fill, row.key).toBeCloseTo(row.fill * LEAN_PATCH_FILL, 12);
      // the Healwort heals, it does not feed: its patches are kept (it was already about one in 10 000 columns)
      const keep = row.key === 'healwort' ? 1 : LEAN_PATCH_CHANCE;
      row.chance.forEach((c, b) => expect(lean.chance[b], `${row.key} biome ${b}`).toBeCloseTo(c * keep, 12));
    });
    expect(CAVE_TROOP_GEN4.chance).toBeCloseTo(CAVE_TROOP.chance * LEAN_PATCH_CHANCE, 12);
    expect(CAVE_TROOP_GEN4.fill).toBeCloseTo(CAVE_TROOP.fill * LEAN_PATCH_FILL, 12);
    expect(gen4.PATCH_TABLE).toBe(PATCH_TABLE_GEN4);
    expect(gen3.PATCH_TABLE).toBe(PATCH_TABLE);
  });

  it('every patch plant of generation 4 stands where generation 3 has the same plant; nothing but the flora cells moves', () => {
    let food3 = 0;
    let food4 = 0;
    let lookalike4 = 0;
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
    // 162 chunks (41 472 columns): generation 3 has 310 patch plants there, generation 4 106. 0.45 of the patches × 0.8
    // of their plants = 0.36, give or take (the Healwort keeps its patches)
    expect(food3).toBeGreaterThan(250);
    expect(food4 / food3).toBeGreaterThan(0.24);
    expect(food4 / food3).toBeLessThan(0.48);
    expect(food4).toBeGreaterThan(60); // lean, not barren
    expect(lookalike4).toBeGreaterThan(0); // the Frecklecap still hides among the Honeycaps
    expect(CHUNKS.length * CHUNK_SIZE * CHUNK_SIZE).toBe(162 * 256);
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
