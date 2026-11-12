// worldgen.js, generation 3 (CONTRACTS §77): coal seams you can see. Kept in its own file beside worldgen.test.js.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { createWorldGen, ORE_TABLE, ORE_TABLE_GEN2, ORE_TABLE_GEN3 } from '../../src/worldgen.js';

const SEED = 'caelancraft-test';
const B = BLOCK;
const gen2 = createWorldGen(SEED, { gen: 2 });
const gen3 = createWorldGen(SEED, { gen: 3 });
const CHUNKS = [[0, 0], [1, 0], [0, 1], [-1, 2], [3, -4], [-2, -2], [5, 5], [12, -7], [2, 2], [-3, 1], [4, -1], [-5, 3]];
const at = (c, lq, y, lr) => c.blocks[(lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y];

describe('generation 3: coal seams you can see (§77)', () => {
  it('ORE_TABLE_GEN3 is one long shallow coal row that takes subsoil as well as stone', () => {
    expect(ORE_TABLE_GEN3.map((o) => [o.id, o.attempts, o.minY, o.maxY, o.minSize, o.maxSize, [...o.replaces]])).toEqual([
      [B.COAL_ORE, 8, SEA_LEVEL - 4, SEA_LEVEL + 18, 12, 20, [B.STONE, B.DIRT]],
    ]);
    expect(Object.isFrozen(ORE_TABLE_GEN3)).toBe(true);
    // older rows keep their place, so their rng streams do not move
    expect(ORE_TABLE[0].id).toBe(B.COAL_ORE);
    expect(ORE_TABLE_GEN2).toHaveLength(3);
  });

  it('the seams only ADD coal (in place of stone or dirt), and much of it lies at or above the sea', () => {
    let added = 0;
    let exposed = 0;
    let shallow2 = 0;
    let shallow3 = 0;
    for (const [cq, cr] of CHUNKS) {
      const a = gen2.generateChunk(cq, cr);
      const b = gen3.generateChunk(cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const u = at(a, lq, y, lr);
            const v = at(b, lq, y, lr);
            if (u === B.COAL_ORE) expect(v).toBe(B.COAL_ORE); // nothing is taken away
            if (y >= SEA_LEVEL - 4) {
              if (u === B.COAL_ORE) shallow2++;
              if (v === B.COAL_ORE) shallow3++;
            }
            if (v !== B.COAL_ORE || u === B.COAL_ORE) continue;
            // whatever else generation 3 changes, a new coal cell stands where stone or subsoil was
            expect([B.STONE, B.DIRT]).toContain(u);
            expect(y).toBeGreaterThanOrEqual(SEA_LEVEL - 4 - ORE_TABLE_GEN3[0].maxSize);
            added++;
            // open to the air on some side or on top: a seam the player can see
            const open = (q, yy, r) => q >= 0 && q < CHUNK_SIZE && r >= 0 && r < CHUNK_SIZE && yy < WORLD_HEIGHT && at(b, q, yy, r) === B.AIR;
            if (open(lq, y + 1, lr) || open(lq + 1, y, lr) || open(lq - 1, y, lr) || open(lq, y, lr + 1) || open(lq, y, lr - 1)) exposed++;
          }
        }
      }
    }
    expect(added).toBeGreaterThan(100);
    expect(shallow3).toBeGreaterThan(shallow2 * 1.5); // clearly more coal near the surface than before
    expect(exposed).toBeGreaterThan(5); // and some of it shows
  });

  it('generation 2 has none of this: its chunks are what they were', () => {
    const again = createWorldGen(SEED, { gen: 2 });
    for (const [cq, cr] of CHUNKS.slice(0, 4)) {
      expect(Buffer.from(again.generateChunk(cq, cr).blocks).equals(Buffer.from(gen2.generateChunk(cq, cr).blocks))).toBe(true);
    }
    expect(gen3.gen).toBe(3);
  });
});
