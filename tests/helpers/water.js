// Test helpers for water (CONTRACTS §83): springs on a fake world, resting, and counting what is there.
import { BLOCK, isWater, isWaterSource, waterDepth } from '../../src/blocks.js';
import { hexLength } from '../../src/hex.js';

const B = BLOCK;

/**
 * Give a world a generator that says where streams run: `cells` are the [q, y, r] cells a stream's water was generated
 * in. A fresh source standing in one is RUNNING water (fed: it neither falls nor spills). Call it before the physics
 * looks at those columns (the lookup is remembered a chunk at a time).
 * @param {*} world @param {number[][]} cells
 * @returns {*} world
 */
export function withSprings(world, cells) {
  const levels = new Map(cells.map(([q, y, r]) => [`${q},${r}`, y]));
  const streamLevelAt = (q, r) => levels.get(`${q},${r}`) ?? -1;
  world.worldGen = { ...(world.worldGen ?? {}), streamLevelAt, streamAt: (q, r) => streamLevelAt(q, r) >= 0 };
  return world;
}

/** Tick until no rule update is queued (parked updates wait for their chunk). @returns {number} ticks run */
export function settle(physics, max = 20000) {
  let t = 0;
  while (physics.queued() > 0 && t < max) {
    physics.tick();
    t++;
  }
  if (physics.queued() > 0) throw new Error(`water did not settle within ${max} ticks`);
  return t;
}

/**
 * Tick until the water is AT REST: no rule update queued and no pool still to be looked at for spilling (§83 law 2).
 * @returns {number} ticks run
 */
export function rest(physics, max = 20000) {
  let t = 0;
  while ((physics.queued() > 0 || physics.fluids.pendingSpills > 0) && t < max) {
    physics.tick();
    t++;
  }
  if (physics.queued() > 0 || physics.fluids.pendingSpills > 0) throw new Error(`water was not at rest within ${max} ticks`);
  return t;
}

/** Run exactly `n` ticks. */
export function ticks(physics, n) {
  for (let i = 0; i < n; i++) physics.tick();
}

/**
 * The water in the hex prism of radius R around (q0, r0), y0..y1.
 * @returns {{ water: number, sources: number, units: number, flow: number, fall: number, cells: number[][] }}
 *   `units` the sum of the sources' depths; `cells` every water cell as [q, y, r, id]
 */
export function waterCensus(world, R, y0, y1, q0 = 0, r0 = 0) {
  const c = { water: 0, sources: 0, units: 0, flow: 0, fall: 0, cells: /** @type {number[][]} */ ([]) };
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = -R; dr <= R; dr++) {
      if (hexLength(dq, dr) > R) continue;
      for (let y = y0; y <= y1; y++) {
        const id = world.getBlock(q0 + dq, y, r0 + dr);
        if (!isWater(id)) continue;
        c.water++;
        if (isWaterSource(id)) {
          c.sources++;
          c.units += waterDepth(id);
        } else if (id === B.WATER_FALL) c.fall++;
        else c.flow++;
        c.cells.push([q0 + dq, y, r0 + dr, id]);
      }
    }
  }
  return c;
}

/** The seven cells of a hex pond: the centre and the six cells round it, as [q, r]. */
export function pondCells(q0 = 0, r0 = 0) {
  return [[q0, r0], [q0 + 1, r0], [q0, r0 + 1], [q0 - 1, r0 + 1], [q0 - 1, r0], [q0, r0 - 1], [q0 + 1, r0 - 1]];
}

/**
 * Put a generated pond into a fake world whose ground reaches `y`: the seven cells at height `y` hold `id` (no edit, no
 * hook: as if generated), on a CLAY floor at `y − 1`. Every neighbour is the world's ground, so it is contained.
 */
export function putPond(world, y, id = B.WATER, q0 = 0, r0 = 0) {
  for (const [q, r] of pondCells(q0, r0)) {
    world.put(q, y, r, id);
    world.put(q, y - 1, r, B.CLAY);
  }
}
