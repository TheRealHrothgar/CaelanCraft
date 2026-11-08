// Cost of the walking pig's fire look-ahead (CONTRACTS §30 AI step 3, §32 "Pigs"): play-test follow-up to C5. The
// look-ahead used to run hexToWorld + hexCircleContact on six neighbours of three points for every walking pig every
// frame, fire or no fire (~1 ms per frame for 32 pigs). Counted, not timed: hex.js is wrapped to count the exact contact
// tests, and getBlock counts the cell reads.
import { describe, it, expect, vi } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { Pigs, seededRng, FIRE_LOOK } from '../../src/pigs.js';
import { hexToWorld } from '../../src/hex.js';

const calls = vi.hoisted(() => ({ contact: 0 }));
vi.mock('../../src/hex.js', async (importOriginal) => {
  const hex = await importOriginal();
  return {
    ...hex,
    hexCircleContact: (...args) => {
      calls.contact++;
      return hex.hexCircleContact(...args);
    },
  };
});

const GROUND = 10;
const flat = (_q, y) => (y < GROUND ? BLOCK.STONE : BLOCK.AIR);

/** 32 pigs forced to walk on open ground, spread out (as the re-verifier's rv-cost-flat). */
function walkers() {
  const pigs = new Pigs(seededRng(1));
  for (let i = 0; i < 32; i++) {
    const [x, z] = hexToWorld((i % 8) * 3 - 12, Math.floor(i / 8) * 3 - 6);
    pigs.spawn(x, GROUND, z, i);
  }
  for (const p of pigs.list) Object.assign(p, { onGround: true, mode: 'walk', timer: 1e9 });
  return pigs;
}

describe('fire look-ahead cost (follow-up C5)', () => {
  it('with no campfire around, a walking pig does no contact geometry at all', () => {
    const pigs = walkers();
    for (let f = 0; f < 60; f++) pigs.update(1 / 60, { getBlock: flat, isLoaded: () => true }); // headings vary
    calls.contact = 0; // (physics uses hexCircleContact too: count the look-ahead alone)
    for (const pig of pigs.list) pigs._fireAhead(pig, GROUND, flat);
    expect(calls.contact).toBe(0); // was 3 points × 6 neighbours = 18 per pig per frame
  });
  it('reads only the cells a look point can reach: its own and the neighbours within FIRE_MARGIN of it', () => {
    const pigs = walkers();
    let reads = 0;
    const counting = (q, y, r) => {
      reads++;
      return flat(q, y, r);
    };
    for (const pig of pigs.list) pigs._fireAhead(pig, GROUND, counting);
    // Each point reads its cell (two levels) unless it is the previous point's, plus two levels of at most two
    // neighbours (a point near a corner is near two edges).
    expect(reads).toBeLessThanOrEqual(pigs.size * FIRE_LOOK.length * 2 * 3);
  });
  it('skips the look-ahead entirely while the world reports no campfire (PigWorld.hasCampfires)', () => {
    let readsWith = 0;
    let readsWithout = 0;
    const a = walkers();
    const b = walkers();
    for (let f = 0; f < 30; f++) {
      a.update(1 / 60, { getBlock: (q, y, r) => (readsWith++, flat(q, y, r)), isLoaded: () => true, hasCampfires: () => true });
      b.update(1 / 60, { getBlock: (q, y, r) => (readsWithout++, flat(q, y, r)), isLoaded: () => true, hasCampfires: () => false });
    }
    expect(readsWithout).toBeLessThan(readsWith);
    // Same walk either way (no fire anywhere): the flag only saves work.
    expect(b.list.map((p) => [p.x, p.z])).toEqual(a.list.map((p) => [p.x, p.z]));
  });
  it('still computes the exact contact for a neighbour that is a campfire, and turns the pig away', () => {
    // Fire cell (1, 0) (its west edge is x = 0.5); the pig walks +z along x = 0.4, so its look points stay in cell
    // (0, 0), 0.1 from that edge: only the exact contact with the neighbour can see the fire.
    const fire = (q, y, r) => (y === GROUND && q === 1 && r === 0 ? BLOCK.CAMPFIRE : flat(q, y, r));
    const pigs = new Pigs(seededRng(1));
    const pig = pigs.spawn(0.4, GROUND, -0.5, Math.PI); // yawToForward(π) = (0, 1)
    Object.assign(pig, { onGround: true, mode: 'walk', timer: 100 });
    calls.contact = 0;
    expect(pigs._fireAhead(pig, GROUND, fire)).toBe(true);
    expect(calls.contact).toBeGreaterThan(0);
    pigs.update(1 / 60, { getBlock: fire, isLoaded: () => true, hasCampfires: () => true });
    expect(pig.mode).toBe('idle'); // stopped to look elsewhere
  });
});
