// Unit tests for src/fluids.js — flowing water (CONTRACTS §35, DESIGN-physics §4): the water rule (spreads-sideways,
// fed levels, falling, the ≥ 3 infinite-source rule, downward), its floor trigger and reseeder (streaming / reloads),
// campfires, drain, currents and the save rule. Map-backed fake worlds from the fixtures unless a real World matters
// (chunk corners while streaming, the seed-42 sea).
//
// Since §83 (the laws of water) a source that nothing feeds does not last: on open ground it spills dry in 12 s, in
// mid-air it falls. So wherever these tests want a source that KEEPS feeding its flow — what they are about — the
// source stands in a SPRING cell (`setup({ springs })`: a cell a stream was generated in, which is running water: fed,
// it neither falls nor spills). What an unfed source does is tests/unit/waterLaws.test.js's subject; the cases here that
// place one say so.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHUNK_SIZE, WATER_CURRENT, DRAIN_MAX_RADIUS, WATER_SOURCE_NEIGHBOURS, WORLD_HEIGHT,
} from '../../src/config.js';
import { BLOCK, isWater, waterLevel, waterSurfaceHeight } from '../../src/blocks.js';
import { HEX_DIRS, FACE_NORMALS, hexToWorld, hexLength } from '../../src/hex.js';
import { World } from '../../src/world.js';
import { createWorldGen } from '../../src/worldgen.js';
import { BlockPhysics, SaveOverlay } from '../../src/blockphysics.js';
import * as fluidsModule from '../../src/fluids.js';
import { executeCommand, parseLine } from '../../src/commands.js';
import { createPlayer } from '../../src/physics.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';
import { withSprings, rest } from '../helpers/water.js';

const B = BLOCK;
const { WATER_RULE_IDS, isFlowingWater, isWaterFloor, flowId } = fluidsModule;
const flow = (k) => B.WATER_FLOW_1 + k - 1;

/** A generator like `gen` whose streams run (also) through `springs`, [q, y, r] cells: a source there is fed. */
function genWithSprings(gen, springs) {
  const levels = new Map(springs.map(([q, y, r]) => [`${q},${r}`, y]));
  const own = typeof gen.streamLevelAt === 'function' ? (q, r) => gen.streamLevelAt(q, r) : () => -1;
  return { ...gen, streamLevelAt: (q, r) => levels.get(`${q},${r}`) ?? own(q, r) };
}

/**
 * A fake world (stone for y ≤ groundY) with physics attached; `fx` records sounds and particles. `springs`: [q, y, r]
 * cells in which a source is running water (§83: fed — it keeps feeding its flow).
 */
function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? 0 });
  if (opts.springs) withSprings(world, opts.springs);
  const fx = { sounds: [], particles: [], said: [] };
  const physics = attachPhysics(world, BlockPhysics, {
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, count) => fx.particles.push({ kind, x, y, z, count }),
    say: (t) => fx.said.push(t),
  });
  return { world, physics, fx };
}

/** Tick until nothing is queued (parked updates wait for their chunk). @returns {number} ticks run */
function settle(physics, max = 20000) {
  let t = 0;
  while (physics.queued() > 0 && t < max) {
    physics.tick();
    t++;
  }
  if (physics.queued() > 0) throw new Error(`water did not settle within ${max} ticks`);
  return t;
}

/** Water cells in the hex prism of radius R around (q0, r0), y0..y1. */
function census(world, R, y0, y1, q0 = 0, r0 = 0) {
  const c = { water: 0, sources: 0, flow: 0, fall: 0, maxR: 0, cells: [] };
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = -R; dr <= R; dr++) {
      const d = hexLength(dq, dr);
      if (d > R) continue;
      for (let y = y0; y <= y1; y++) {
        const id = world.getBlock(q0 + dq, y, r0 + dr);
        if (!isWater(id)) continue;
        c.water++;
        if (id === B.WATER) c.sources++;
        else if (id === B.WATER_FALL) c.fall++;
        else c.flow++;
        if (d > c.maxR) c.maxR = d;
        c.cells.push([q0 + dq, y, r0 + dr, id]);
      }
    }
  }
  return c;
}

/** Stone hex plateau of radius `rad` from y 1 to `top` on a y = 0 floor. */
function plateau(world, rad, top) {
  for (let q = -rad; q <= rad; q++) {
    for (let r = -rad; r <= rad; r++) if (hexLength(q, r) <= rad) for (let y = 1; y <= top; y++) world.put(q, y, r, B.STONE);
  }
}

/**
 * A sea with a straight shore along r = 0 on a world whose ground is y ≤ 3: at y = 4..top, natural WATER where r < 0
 * and natural stone where r ≥ 0 (within |q|, |r| ≤ 24 — beyond that the fake world is open air, never reached).
 */
function seaWorld(world, top = 4) {
  for (let q = -24; q <= 24; q++) {
    for (let r = -24; r <= 24; r++) for (let y = 4; y <= top; y++) world.put(q, y, r, r < 0 ? B.WATER : B.STONE);
  }
}

/** Water cells on the land side of the shore (r ≥ 1), y 4..top. */
function landWater(world, top = 6) {
  let n = 0;
  for (let q = -24; q <= 24; q++) for (let r = 1; r <= 24; r++) for (let y = 4; y <= top; y++) if (isWater(world.getBlock(q, y, r))) n++;
  return n;
}

describe('predicates and registration', () => {
  it('rule ids, floors, flow ids, surface heights', () => {
    expect([...WATER_RULE_IDS]).toEqual([B.AIR, B.CAMPFIRE, B.WATER, 68, 69, 70, 71, 72, 73, B.WATER_FALL, B.TAINTED_WATER,
      B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW]); // + the second source (§76 water) and the lower depths (§83)
    expect(isFlowingWater(flow(1)) && isFlowingWater(flow(6))).toBe(true);
    expect(isFlowingWater(B.WATER) || isFlowingWater(B.WATER_FALL)).toBe(false);
    expect(isWaterFloor(B.STONE) && isWaterFloor(B.GLASS) && isWaterFloor(B.WATER)).toBe(true);
    for (const id of [B.AIR, B.WATER_FALL, flow(3), B.CAMPFIRE, 255]) expect(isWaterFloor(id), String(id)).toBe(false);
    expect([0, 1, 6, 7, 2.5].map(flowId)).toEqual([B.AIR, flow(1), flow(6), flow(6), flow(2)]);
    expect(waterSurfaceHeight(B.WATER, B.AIR)).toBe(0.875);
    expect(waterSurfaceHeight(B.WATER_FALL, B.STONE)).toBe(0.875);
    expect(waterSurfaceHeight(flow(2), B.AIR)).toBeCloseTo(0.25, 12);
    expect(waterSurfaceHeight(flow(2), B.WATER_FALL)).toBe(1);
    expect(waterSurfaceHeight(B.STONE, B.AIR)).toBe(0);
  });

  it('fallLevel: falling water carries the level of the water pouring in at the top of its column', () => {
    const { fallLevel } = fluidsModule;
    expect(typeof fallLevel).toBe('function');
    const column = (...ids) => ({ peek: (_q, y, _r) => ids[y] ?? B.AIR }); // ids[0] is the bottom of the column
    expect(fallLevel(column(B.WATER_FALL, B.WATER_FALL, B.WATER), 0, 0, 0)).toBe(7);
    expect(fallLevel(column(B.WATER_FALL, B.WATER_FALL, flow(4)), 0, 0, 0)).toBe(4);
    expect(fallLevel(column(B.WATER_FALL, flow(1)), 0, 0, 0)).toBe(1);
    expect(fallLevel(column(B.WATER_FALL, B.WATER_FALL), 0, 0, 0)).toBe(0); // nothing feeds it: a stale fall feeds nothing
    expect(fallLevel(column(B.WATER_FALL, B.STONE), 0, 0, 0)).toBe(0);
  });

  it('registers one rule on the water and fall rings, the floor trigger, and replaces the water reseeder', () => {
    const { physics } = setup();
    expect(physics.ruleNames('water')).toEqual(['water']);
    expect(physics.ruleNames('fall')).toEqual(['gravity', 'water']);
    expect(physics._triggers.map((t) => t.name)).toEqual(['gravity', 'water', 'ignite', 'water-floor', 'support', 'barrel-timers']); // + collapse's and explosions' own
    expect(physics._reseeders.filter((r) => r.name === 'water').length).toBe(1);
    expect(physics._reseeders.find((r) => r.name === 'water').mask[B.AIR]).toBe(1);
  });
});

describe('the water rule', () => {
  it('one source on flat ground: exactly 126 flowing cells (a reach-6 hex disc), level 7 − distance', () => {
    const { world, physics } = setup({ springs: [[0, 1, 0]] });
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    const c = census(world, 12, 0, 4);
    expect(c.sources).toBe(1);
    expect(c.flow).toBe(126);
    expect(c.flow).toBeLessThanOrEqual(127);
    expect(c.fall).toBe(0);
    expect(c.maxR).toBe(6);
    for (const [q, y, r, id] of c.cells) {
      expect(y).toBe(1);
      if (id !== B.WATER) expect(waterLevel(id), `${q},${r}`).toBe(7 - hexLength(q, r));
    }
    // Take the source away: everything drains and every edit is pruned again.
    world.setBlock(0, 1, 0, B.AIR);
    settle(physics);
    expect(census(world, 12, 0, 4).water).toBe(0);
    expect(world.editCount).toBe(0);
    // §83: the same source with no spring behind it wets the same disc at first — and then runs out by itself: a source
    // on open ground stands open, so it drops a level every 4 s (its flow shrinking with it) until nothing is left.
    const plain = setup();
    plain.world.setBlock(0, 1, 0, B.WATER);
    settle(plain.physics);
    expect(census(plain.world, 12, 0, 4).flow).toBe(126);
    expect(plain.physics.fluids.pendingSpills).toBe(1);
    rest(plain.physics);
    expect(census(plain.world, 12, 0, 4).water).toBe(0);
    expect(plain.world.editCount).toBe(0);
  });

  it('one source on a 10-high plateau stays bounded (hundreds of cells, not thousands) and fully drains', () => {
    const { world, physics } = setup({ springs: [[0, 11, 0]] });
    plateau(world, 3, 10);
    world.setBlock(0, 11, 0, B.WATER);
    settle(physics);
    const c = census(world, 24, 0, 14);
    // 61 on top (37 on the plateau + 24 FLOW_3 over the edge), 24 waterfalls of 10 cells, and at the bottom the falls
    // spread at the level that poured in (3): FLOW_2 one ring out, FLOW_1 the next — 66 cells (270 when a landing fall
    // counted as a fresh source, before the slope fix: review water-3).
    expect(c.water).toBe(367);
    expect(c.fall).toBe(240);
    expect(c.maxR).toBe(6);
    expect(c.cells.filter(([, y]) => y === 1).map(([, , , id]) => id).filter((id) => id !== B.WATER_FALL).sort())
      .toEqual([...Array(30).fill(flow(2)), ...Array(36).fill(flow(1))].sort());
    // Mid-cliff falling water never spreads: only the 24 fall cells at y = 5.
    expect(c.cells.filter(([, y]) => y === 5).length).toBe(24);
    expect(c.cells.filter(([, y]) => y === 5).every(([q, , r, id]) => id === B.WATER_FALL && hexLength(q, r) === 4)).toBe(true);
    world.setBlock(0, 11, 0, B.AIR);
    settle(physics);
    expect(census(world, 24, 0, 14).water).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('two adjacent sources do NOT spread into a lake; nor do three around a hole (the ≥ 3 rule is the sea\'s alone since §83)', () => {
    expect(WATER_SOURCE_NEIGHBOURS).toBe(3);
    const a = setup({ springs: [[0, 1, 0], [1, 1, 0]] });
    a.world.setBlock(0, 1, 0, B.WATER);
    a.world.setBlock(1, 1, 0, B.WATER);
    settle(a.physics);
    const ca = census(a.world, 30, 0, 4);
    expect(ca.sources).toBe(2);
    expect(ca.water).toBe(140); // the union of two reach-6 discs
    // The two shared neighbours have two WATER neighbours each: flowing, not sources.
    expect(a.world.getBlock(0, 1, 1)).toBe(flow(6));
    expect(a.world.getBlock(1, 1, -1)).toBe(flow(6));

    // Three sources around a hole: until §83 the hole and its three other neighbours became sources (a closed pool of 7,
    // four of them from nothing). Water never comes from nothing now: the hole holds flowing water and the three stay three.
    const springs = [0, 2, 4].map((j) => [HEX_DIRS[j][0], 1, HEX_DIRS[j][1]]);
    const b = setup({ springs });
    for (const [q, y, r] of springs) b.world.setBlock(q, y, r, B.WATER);
    settle(b.physics);
    const cb = census(b.world, 30, 0, 4);
    expect(cb.sources).toBe(3);
    expect(cb.maxR).toBe(7);
    expect(b.world.getBlock(0, 1, 0)).toBe(flow(6));
    for (const j of [1, 3, 5]) expect(b.world.getBlock(HEX_DIRS[j][0], 1, HEX_DIRS[j][1])).toBe(flow(6));
    // … and with no spring behind them the three are gone in 12 s, never having been more than three.
    const c = setup();
    for (const [q, y, r] of springs) c.world.setBlock(q, y, r, B.WATER);
    let most = 0;
    for (let i = 0; i < 300; i++) {
      c.physics.tick();
      if (i % 5 === 0) most = Math.max(most, census(c.world, 4, 0, 3).sources);
    }
    rest(c.physics);
    expect(most).toBe(3);
    expect(census(c.world, 30, 0, 4).water).toBe(0);
  });

  it('a hole next to a straight sea edge fills (flowing over falling water) without flooding the land', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.AIR); // dug into the shore: two sea cells beside it, not three
    world.setBlock(0, 3, 0, B.AIR);
    settle(physics);
    expect(world.getBlock(0, 4, 0)).toBe(flow(6));
    expect(world.getBlock(0, 3, 0)).toBe(B.WATER_FALL);
    expect(landWater(world)).toBe(0); // nothing on the land
    expect(world.editCount).toBe(2);
    // A one-deep hole in a concave bit of shore (three WATER neighbours, a floor below) becomes a source.
    world.setBlock(5, 4, 0, B.WATER);
    world.setBlock(6, 4, 0, B.AIR);
    settle(physics);
    expect(world.getBlock(6, 4, 0)).toBe(B.WATER);
    expect(world.getBlock(0, 4, 0)).toBe(flow(6)); // the two-deep one has falling water below it: no floor, stays flowing
  });

  it('a drained patch of open sea refills to sources and leaves no edits behind', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 12);
    const res = physics.fluids.drain(0, 8, -15, 5);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^drained \d+ water cells within 5 — the water around it flows back in$/);
    settle(physics);
    let notSea = 0;
    for (let q = -8; q <= 8; q++) for (let r = -22; r <= -8; r++) for (let y = 4; y <= 12; y++) if (world.getBlock(q, y, r) !== B.WATER) notSea++;
    expect(notSea).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('…on an uneven seabed too: natural water refills as natural water, whatever the floor (review water-1)', () => {
    // One seabed cell in four raised by one: the bottom ring of the drained patch touches sand, not three sources, and the
    // ring above it stood on falling water — 436 cells stayed AIR and 754 edits were left before natural water healed.
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 12);
    for (let q = -24; q <= 24; q++) for (let r = -24; r < 0; r++) if (((q * 7 + r * 13) & 3) === 0) world.put(q, 4, r, B.STONE);
    const sea = new Map();
    for (let q = -8; q <= 8; q++) for (let r = -22; r <= -8; r++) for (let y = 4; y <= 12; y++) sea.set(`${q},${y},${r}`, world.getBlock(q, y, r));
    expect(physics.fluids.drain(0, 8, -15, 5).message).toMatch(/^drained \d+ water cells within 5 — the water around it flows back in$/);
    settle(physics);
    const wrong = [...sea].filter(([k, id]) => world.getBlock(...k.split(',').map(Number)) !== id);
    expect(wrong).toEqual([]);
    expect(world.editCount).toBe(0);
  });

  it('a sea cell taken out at the shore comes back as a source, as a reload would make it', () => {
    // r = −1 is the sea's edge row; this cell has only two sea sides at its own height, so rule 2a's ≥ 3 never applied.
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 6);
    world.put(4, 5, -1, B.STONE); // a rock beside it: two WATER sides left (and the shore)
    world.put(3, 5, -2, B.STONE);
    expect(HEX_DIRS.filter(([dq, dr]) => world.getBlock(3 + dq, 5, -1 + dr) === B.WATER).length).toBe(2);
    world.setBlock(3, 5, -1, B.AIR);
    settle(physics);
    expect(world.getBlock(3, 5, -1)).toBe(B.WATER);
    expect(world.editCount).toBe(0);
    expect(physics.exportEdits()).toEqual({});
  });

  it('a waterfall advances one cell per tick and spreads only where it lands', () => {
    const { world, physics } = setup({ groundY: 0, springs: [[0, 21, 0]] });
    world.put(0, 20, 0, B.STONE);
    world.setBlock(0, 21, 0, B.WATER); // a source on a one-cell pillar top far above the ground
    for (let i = 0; i < 6; i++) physics.tick(); // the side flow appears after WATER_TICKS
    const falls = () => census(world, 2, 0, 21).fall;
    const f0 = falls();
    expect(f0).toBeGreaterThan(0);
    physics.tick();
    expect(falls()).toBe(f0 + 6); // six falls (one under each side flow) advance one cell each
    settle(physics);
    const c = census(world, 14, 0, 22);
    expect(c.cells.filter(([, y]) => y > 1 && y < 20).every(([, , , id]) => id === B.WATER_FALL)).toBe(true);
    expect(c.cells.filter(([, y]) => y === 1).length).toBeGreaterThan(6);
  });

  it('a fed source poured over a drop lands at full strength: a waterfall and a reach-6 pool where it lands', () => {
    // (a spring: with nothing behind it a source in mid-air does not pour, it FALLS — §83 law 1, waterLaws.test.js)
    const { world, physics } = setup({ springs: [[0, 11, 0]] });
    world.setBlock(0, 11, 0, B.WATER); // in mid-air, ten cells above the ground
    settle(physics);
    const c = census(world, 12, 0, 12);
    expect(c.fall).toBe(10); // y 1..10 under the source
    expect(c.flow).toBe(126);
    for (const [q, y, r, id] of c.cells) if (isFlowingWater(id)) expect(y === 1 && waterLevel(id) === 7 - hexLength(q, r), `${q},${y},${r}`).toBe(true);
    world.setBlock(0, 11, 0, B.AIR);
    settle(physics);
    expect(census(world, 12, 0, 12).water).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('down a staircase a stream keeps losing level: it stops within reach 6 of its source (review water-3)', () => {
    // 1-high steps every 3 cells, 15 steps down toward +q, 91 cells wide. When a landing fall counted 7 again, every step
    // restarted a reach-6 disc and the sheet widened by ~9 cells a step (24,409 cells on the reviewer's 40-step stairs).
    const { world, physics } = setup({ springs: [[2, 21, 0]] });
    const h = (q) => (q < 0 ? 20 : Math.max(5, 20 - Math.floor(q / 3)));
    for (let q = -8; q <= 50; q++) for (let r = -45; r <= 45; r++) for (let y = 1; y <= h(q); y++) world.put(q, y, r, B.STONE);
    world.setBlock(2, 21, 0, B.WATER); // on the top step, two cells from its edge
    settle(physics);
    const c = census(world, 60, 0, 22, 2, 0);
    expect(c.maxR).toBeLessThanOrEqual(6);
    expect(c.water).toBeLessThan(200);
    // Every flowing level is exactly 7 minus its distance from the source: falling never refreshed it.
    for (const [q, , r, id] of c.cells) if (isFlowingWater(id)) expect(waterLevel(id), `${q},${r}`).toBe(7 - hexLength(q - 2, r));
    world.setBlock(2, 21, 0, B.AIR);
    settle(physics);
    expect(census(world, 60, 0, 22, 2, 0).water).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('a stream over a ledge feeds the level it had, and follows that level when it changes (the fall trigger)', () => {
    // A one-wide channel at y = 6 (floor y ≤ 5) ends at q = 3 over a 4-deep pit (q = 3, 4; floor y = 1).
    const { world, physics } = setup({ groundY: 5, springs: [[0, 6, 0], [2, 6, 0]] });
    for (let q = -2; q <= 8; q++) for (let r = -2; r <= 2; r++) if (r !== 0 || q < 0) world.put(q, 6, r, B.STONE);
    for (const q of [3, 4]) for (let y = 2; y <= 5; y++) world.setBlock(q, y, 0, B.AIR);
    world.setBlock(0, 6, 0, B.WATER);
    settle(physics);
    // FLOW_4 at q = 3 hangs over the pit: the fall below it lands at y = 2 and feeds q = 4 at 4 − 1.
    expect(world.getBlock(3, 6, 0)).toBe(flow(4));
    expect([5, 4, 3, 2].map((y) => world.getBlock(3, y, 0))).toEqual([B.WATER_FALL, B.WATER_FALL, B.WATER_FALL, B.WATER_FALL]);
    expect(world.getBlock(4, 2, 0)).toBe(flow(3));
    // A source dropped right onto the channel's end raises the fall's level: the landing feeds 6 now.
    world.setBlock(2, 6, 0, B.WATER);
    settle(physics);
    expect(world.getBlock(3, 6, 0)).toBe(flow(6));
    expect(world.getBlock(4, 2, 0)).toBe(flow(5));
    world.setBlock(2, 6, 0, B.AIR); // and back down: the far side of the pit follows
    settle(physics);
    expect(world.getBlock(4, 2, 0)).toBe(flow(3));
  });

  it('a trickle falling into a stream feeds it and never lowers it; the stream follows the fall when it rises or goes', () => {
    // Review water-3 regression: a FALL took the level at the top of its column and ignored its sides, so a FLOW_1
    // trickle dripping onto a FLOW_5 channel cell made it FALL (1) and dried everything downstream ('W 6 F . . . . . .').
    // Main channel at y = 6 along +q (floor y ≤ 5, stone roof at y = 7) from a source at q = 0; an upper channel at
    // y = 10 along r (q = 2, floor y = 9) from a source at (2, 10, 6) whose FLOW_1 tip at (2, 10, 0) drips through a
    // 3-high shaft (2, 7..9, 0) onto (2, 6, 0).
    const scene = (order) => {
      // (every source of this test is a spring: both channels' own, the one set on the trickle's tip, the two of the end)
      const { world, physics } = setup({ groundY: 5, springs: [[0, 6, 0], [2, 10, 6], [2, 10, 0], [4, 6, 0], [3, 10, 0]] });
      for (let q = -3; q <= 12; q++) {
        for (let r = -3; r <= 9; r++) {
          if (!(r === 0 && q >= 0)) world.put(q, 6, r, B.STONE);
          for (let y = 7; y <= 9; y++) if (!(q === 2 && r === 0)) world.put(q, y, r, B.STONE);
          if (!(q === 2 && r >= 0 && r <= 6)) world.put(q, 10, r, B.STONE);
        }
      }
      const main = () => world.setBlock(0, 6, 0, B.WATER);
      const trickle = () => world.setBlock(2, 10, 6, B.WATER);
      if (order === 'stream first') main();
      else trickle();
      settle(physics);
      if (order === 'stream first') trickle();
      else main();
      settle(physics);
      return { world, physics };
    };
    const row = (world) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((q) => world.getBlock(q, 6, 0));
    const full = [B.WATER, flow(6), flow(5), flow(4), flow(3), flow(2), flow(1), B.AIR, B.AIR];
    for (const order of ['stream first', 'trickle first']) {
      const { world, physics } = scene(order);
      expect([5, 4, 3, 2, 1, 0].map((r) => world.getBlock(2, 10, r)), order).toEqual([6, 5, 4, 3, 2, 1].map(flow));
      expect([9, 8, 7].map((y) => world.getBlock(2, y, 0)), order).toEqual([B.WATER_FALL, B.WATER_FALL, B.WATER_FALL]);
      expect(row(world), order).toEqual(full); // the landing is FLOW_5: its side feeds it better than the fall (1)
      // The fall rises above the stream (a source at the tip): the landing falls at 7 and feeds the channel at 6.
      world.setBlock(2, 10, 0, B.WATER);
      settle(physics);
      expect(row(world), order).toEqual([B.WATER, flow(6), B.WATER_FALL, flow(6), flow(5), flow(4), flow(3), flow(2), flow(1)]);
      world.setBlock(2, 10, 0, B.AIR); // and back to the trickle: the landing is FLOW_5 again
      settle(physics);
      expect(row(world), order).toEqual(full);
      world.setBlock(0, 6, 0, B.AIR); // the stream's source goes: only the trickle's fall is left, feeding nothing
      settle(physics);
      expect(row(world), order).toEqual([B.AIR, B.AIR, B.WATER_FALL, B.AIR, B.AIR, B.AIR, B.AIR, B.AIR, B.AIR]);
      world.setBlock(0, 6, 0, B.WATER);
      settle(physics);
      expect(row(world), order).toEqual(full);
      world.setBlock(2, 10, 6, B.AIR); // the trickle's source goes: the stream is untouched
      settle(physics);
      expect(row(world), order).toEqual(full);
      expect(world.getBlock(2, 7, 0)).toBe(B.AIR);
      world.setBlock(0, 6, 0, B.AIR);
      settle(physics);
      expect(world.editCount).toBe(0);
    }
    // A second source at q = 4: the landing's sides are fed 6 by the sources whatever the fall does. A source beside
    // the trickle's tip raises it to FLOW_6 (the landing falls at 6); walling that source in again drops the tip
    // straight back to FLOW_1 with no gap in the column, and nothing beside the landing changes — only the trigger's
    // walk down the column makes the landing compare again.
    const { world, physics } = scene('stream first');
    world.setBlock(4, 6, 0, B.WATER);
    settle(physics);
    expect(row(world).slice(0, 5)).toEqual([B.WATER, flow(6), flow(5), flow(6), B.WATER]);
    world.setBlock(3, 10, 0, B.WATER);
    settle(physics);
    expect(world.getBlock(2, 10, 0)).toBe(flow(6));
    expect(row(world).slice(0, 5)).toEqual([B.WATER, flow(6), B.WATER_FALL, flow(6), B.WATER]);
    world.setBlock(3, 10, 0, B.STONE);
    settle(physics);
    expect(world.getBlock(2, 10, 0)).toBe(flow(1));
    expect(row(world).slice(0, 5)).toEqual([B.WATER, flow(6), flow(5), flow(6), B.WATER]);
  });

  it('removing the floor under flowing water re-evaluates what it fed (the water-floor trigger)', () => {
    // A one-wide channel along +q at y = 6 on a y ≤ 5 floor: levels 6, 5, 4, 3, 2, 1.
    const { world, physics } = setup({ groundY: 5, springs: [[0, 6, 0]] });
    for (let q = -2; q <= 10; q++) for (let r = -2; r <= 2; r++) if (r !== 0 || q < 0 || q > 7) world.put(q, 6, r, B.STONE);
    world.setBlock(0, 6, 0, B.WATER);
    settle(physics);
    expect([1, 2, 3, 4, 5, 6, 7].map((q) => world.getBlock(q, 6, 0))).toEqual([flow(6), flow(5), flow(4), flow(3), flow(2), flow(1), B.AIR]);
    world.setBlock(2, 5, 0, B.AIR); // the floor under level 5 goes: it falls instead of spreading
    settle(physics);
    expect(world.getBlock(2, 5, 0)).toBe(B.WATER_FALL);
    expect(world.getBlock(2, 6, 0)).toBe(flow(5));
    expect([3, 4, 5, 6].map((q) => world.getBlock(q, 6, 0))).toEqual([B.AIR, B.AIR, B.AIR, B.AIR]);
    world.setBlock(2, 5, 0, B.STONE); // and back: the channel refills
    settle(physics);
    expect([2, 3, 4, 5, 6].map((q) => world.getBlock(q, 6, 0))).toEqual([flow(5), flow(4), flow(3), flow(2), flow(1)]);
  });

  it('water entering a campfire puts it out with a hiss and steam (sideways and from above)', () => {
    const { world, physics, fx } = setup({ springs: [[0, 1, 0]] });
    world.setBlock(2, 1, 0, B.CAMPFIRE);
    world.put(5, 3, 0, B.STONE);
    world.setBlock(5, 1, 0, B.CAMPFIRE);
    world.setBlock(5, 2, 0, B.WATER); // over the campfire, on nothing: it falls into it (the source itself, since §83)
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    expect(world.getBlock(2, 1, 0)).toBe(flow(5));
    expect(isWater(world.getBlock(5, 1, 0))).toBe(true);
    expect(world.getBlock(5, 2, 0)).toBe(B.AIR); // it moved down: it is no longer where it was put
    expect(fx.sounds.filter((s) => s.name === 'hiss').length).toBe(2);
    expect(fx.particles.filter((p) => p.kind === 'steam').length).toBe(2);
    expect(fx.sounds.some((s) => s.name === 'splash')).toBe(true);
  });

  it('sand sinks through a source to the bottom of the water (the faller crushes the bottom cell)', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 8);
    world.setBlock(0, 9, -10, B.SAND); // dropped on the sea surface
    for (let i = 0; i < 600 && (physics.fallers.count > 0 || physics.queued() > 0); i++) physics.step(1 / 60);
    expect(world.getBlock(0, 4, -10)).toBe(B.SAND);
    for (let y = 5; y <= 8; y++) expect(world.getBlock(0, y, -10)).toBe(B.WATER);
    expect(world.getBlock(0, 9, -10)).toBe(B.AIR);
  });

  it('the water switch: off drops the updates; on again never floods after the fact', () => {
    const { world, physics } = setup({ springs: [[0, 1, 0]] });
    physics.setSwitch('water', false);
    world.setBlock(0, 1, 0, B.WATER);
    for (let i = 0; i < 40; i++) physics.tick();
    expect(census(world, 8, 0, 3).water).toBe(1);
    physics.setSwitch('water', true);
    for (let i = 0; i < 40; i++) physics.tick();
    expect(census(world, 8, 0, 3).water).toBe(1);
    world.setBlock(1, 1, 0, B.STONE); // a change in the open cells beside it wakes it
    world.setBlock(1, 1, 0, B.AIR);
    settle(physics);
    expect(census(world, 8, 0, 3).water).toBe(127);
  });

  it('a campfire a COMMAND writes into, under or beside water is put out too; it burns only with water off or physics paused', () => {
    // Review F4: §32 said a command-placed campfire under water "still burns" while §35.2 puts out any campfire water
    // reaches. Water puts fires out, whoever placed them: §32 now says so, and the command path is pinned here.
    const run = (mode) => {
      const { world, physics, fx } = setup({ groundY: 3 });
      seaWorld(world, 6); // natural sea at r < 0, y 4..6; stone shore at r ≥ 0
      world.put(0, 4, 6, B.AIR); // a dry pit in the shore for the "water poured on it" case
      world.put(0, 5, 6, B.AIR);
      if (mode === 'water off') physics.setSwitch('water', false);
      if (mode === 'paused') physics.setPaused(true);
      const [x, z] = hexToWorld(0, 20);
      const ctx = { world, player: { ...createPlayer(x, 30, z), flying: true }, controls: { yaw: 0, pitch: 0 }, physics, seed: 1 };
      const cmd = (line) => executeCommand(parseLine(line), ctx);
      const steps = (n) => {
        for (let i = 0; i < n; i++) physics.step(0.05); // as the game steps it (a paused physics skips its ticks)
      };
      world.setBlock(3, 4, 0, B.AIR); // a hole dug in the shore beside the sea: flowing water fills it (water on)
      steps(40);
      expect(cmd('setblock 0 4 -10 campfire').message).toBe('set campfire at (0, 4, -10)'); // on the seabed, sea above it
      expect(cmd('setblock 3 4 0 campfire').ok).toBe(true); // beside the sea, in the hole
      expect(cmd('setblock 0 4 6 campfire').ok).toBe(true); // in the dry pit…
      expect(cmd('setblock 0 5 6 water').ok).toBe(true); // …with a source written on top of it
      steps(200);
      const cells = [[0, 4, -10], [3, 4, 0], [0, 4, 6]].map(([q, y, r]) => world.getBlock(q, y, r));
      return { cells, hisses: fx.sounds.filter((s) => s.name === 'hiss').length };
    };
    const on = run('water on');
    // Put out, each with a hiss: the sea closes over the first (the sea refills as the sea), the shore hole floods
    // again, the poured source falls into the pit — the source itself (§83 law 1), which then rests there.
    expect(on.cells).toEqual([B.WATER, flow(6), B.WATER]);
    expect(on.hisses).toBe(3);
    for (const mode of ['water off', 'paused']) {
      const off = run(mode);
      expect(off, mode).toEqual({ cells: [B.CAMPFIRE, B.CAMPFIRE, B.CAMPFIRE], hisses: 0 });
    }
    // And the two normative sections agree now.
    const contracts = readFileSync(fileURLToPath(new URL('../../src/CONTRACTS.md', import.meta.url)), 'utf8');
    const s32 = contracts.slice(contracts.indexOf('Water rule (`wouldDouseCampfire`'), contracts.indexOf('\nPigs: a walking pig'));
    expect(s32).not.toMatch(/still burns/);
    expect(s32).toMatch(/§35\.2/);
  });

  it('stops spreading at the edit cap ("capped") without throwing', () => {
    const { world, physics } = setup({ springs: [[0, 1, 0]] });
    world.editCount = 299990; // just below MAX_TOTAL_EDITS: a few writes, then 'capped'
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    const c = census(world, 8, 0, 3);
    expect(c.water).toBeGreaterThan(1);
    expect(c.water).toBeLessThan(127);
    expect(physics.fluids.stats.writes).toBe(c.water - 1);
  });
});

describe('chunk borders, corners and streaming', () => {
  it('a source on a chunk-corner cell flows into all the chunks around it', () => {
    const { world, physics } = setup({ springs: [[15, 1, 15]] });
    world.setBlock(15, 1, 15, B.WATER); // chunk (0, 0); its neighbours reach chunks (1, 0), (0, 1) and (1, 1)
    settle(physics);
    const c = census(world, 8, 0, 3, 15, 15);
    expect(c.water).toBe(127);
    const chunks = new Set(c.cells.map(([q, , r]) => `${Math.floor(q / CHUNK_SIZE)},${Math.floor(r / CHUNK_SIZE)}`));
    expect([...chunks].sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });

  it('flow toward unloaded chunks waits (parks) and finishes when they load', () => {
    const { world, physics } = setup({ springs: [[15, 1, 15]] });
    world.unload(1, 0);
    world.unload(0, 1);
    world.unload(1, 1);
    world.setBlock(15, 1, 15, B.WATER);
    settle(physics);
    expect(physics.parkedCount).toBeGreaterThan(0);
    expect(census(world, 8, 0, 3, 15, 15).water).toBeLessThan(127);
    world.load(1, 1);
    world.load(1, 0);
    world.load(0, 1);
    settle(physics);
    expect(census(world, 8, 0, 3, 15, 15).water).toBe(127);
    expect(physics.parkedCount).toBe(0);
  });

  it('flow into a chunk that loads later resumes even when the cell beside it does not change', () => {
    const { world, physics } = setup({ springs: [[14, 1, 5]] });
    world.unload(1, 0);
    world.setBlock(14, 1, 5, B.WATER); // two cells from chunk (1, 0)
    settle(physics);
    expect(world.getBlock(16, 1, 5)).toBe(B.AIR); // unloaded: getBlock reads AIR
    world.load(1, 0);
    settle(physics);
    expect(world.getBlock(16, 1, 5)).toBe(flow(5));
    expect(census(world, 8, 0, 3, 14, 5).water).toBe(127);
  });

  it('a chunk corner on a real World (flat terrain, streaming hooks forwarded like main)', () => {
    const world = new World({ seed: 1, renderDistance: 2, worldGen: genWithSprings(flatWorldGen(10), [[-1, 11, -1]]), now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    for (let i = 0; i < 500; i++) {
      const s = world.update(0, 0, Infinity);
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    world.setBlock(-1, 11, -1, B.WATER); // chunk (−1, −1): the cell meets chunks (0, −1) and (−1, 0)
    settle(physics);
    const c = census(world, 8, 10, 13, -1, -1);
    expect(c.water).toBe(127);
    expect(c.cells.every(([, y]) => y === 11)).toBe(true);
  });
});

describe('saving and reloading', () => {
  it('flow is never saved: a dug hole beside the sea saves as AIR, a refilled sea cell as the sea', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.AIR);
    world.setBlock(3, 4, -1, B.AIR); // a sea surface cell removed at the shore (two sea sides + the shore)
    settle(physics);
    expect(world.getBlock(0, 4, 0)).toBe(flow(6));
    expect(isWater(world.getBlock(3, 4, -1))).toBe(true);
    const edits = physics.exportEdits();
    const values = Object.values(edits).flatMap((arr) => arr.filter((_, i) => i % 2 === 1));
    expect(values.every((id) => !isWater(id) || id === B.WATER)).toBe(true);
    expect(values).toContain(B.AIR); // the dug hole
    expect(values.filter((id) => id === B.AIR).length).toBe(1); // the sea cell reverts to its generated WATER
    expect(world.getBlock(0, 4, 0)).toBe(flow(6)); // the live world is untouched
    expect(new SaveOverlay(world).toJSON()).toEqual(edits);
  });

  it('on reload, edited AIR beside natural water and edited sources wake up and flow again', () => {
    const { world, physics } = setup({ groundY: 3, springs: [[8, 5, 6]] });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.AIR);
    world.setBlock(0, 3, 0, B.AIR);
    world.setBlock(8, 5, 6, B.WATER); // a placed source up on the land (in a spring cell: it keeps running)
    settle(physics);
    const saved = physics.exportEdits();

    // A fresh world with the same terrain and the saved edits, then the chunks "generate".
    const w2 = withSprings(makeFakeWorld({ groundY: 3 }), [[8, 5, 6]]);
    seaWorld(w2);
    for (const [key, arr] of Object.entries(saved)) {
      const [cq, cr] = key.split(',').map(Number);
      for (let i = 0; i < arr.length; i += 2) {
        const li = arr[i];
        const y = li % WORLD_HEIGHT;
        const col = (li - y) / WORLD_HEIGHT;
        const lr = col % CHUNK_SIZE;
        w2.setBlock(cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE, y, cr * CHUNK_SIZE + lr, arr[i + 1]);
      }
    }
    expect(w2.getBlock(0, 4, 0)).toBe(B.AIR);
    const p2 = attachPhysics(w2, BlockPhysics);
    for (const cq of [-2, -1, 0, 1]) for (const cr of [-2, -1, 0, 1]) w2.load(cq, cr);
    settle(p2);
    expect(w2.getBlock(0, 4, 0)).toBe(flow(6));
    expect(w2.getBlock(0, 3, 0)).toBe(B.WATER_FALL);
    expect(census(w2, 8, 5, 5, 8, 6).water).toBe(census(world, 8, 5, 5, 8, 6).water);
    expect(census(w2, 8, 5, 5, 8, 6).water).toBe(127);
  });

  /**
   * A converged real World on `worldGen` around cell (8, 8) from saved `edits`, physics wired like main; `wet` collects
   * every cell that turned to water while it ran (the reflow's path, not just where it ends).
   */
  function loadWorld(worldGen, edits) {
    const world = new World({ seed: 1, renderDistance: 2, worldGen, now: () => 0, edits });
    const physics = attachPhysics(world, BlockPhysics);
    const wet = new Set();
    const forward = world.onBlockChange;
    world.onBlockChange = (q, y, r, prev, next) => {
      if (isWater(next)) wet.add(`${q},${y},${r}`);
      forward(q, y, r, prev, next);
    };
    const [x, z] = hexToWorld(8, 8);
    for (let i = 0; i < 500; i++) {
      const s = world.update(x, z, Infinity);
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    return { world, physics, wet };
  }
  /** Save (exportEdits, JSON round trip like storage) → a fresh World → settle; compare cells q, r ∈ [lo, hi], y0..y1. */
  function reloadAndCompare(live, worldGen, lo, hi, y0, y1) {
    const saved = JSON.parse(JSON.stringify(live.physics.exportEdits()));
    const re = loadWorld(worldGen, saved);
    re.wet.clear(); // count from the first tick (generation itself writes nothing through onBlockChange)
    settle(re.physics);
    const differ = [];
    const flooded = []; // cells the reflow wet that end dry: water the live world never had there
    let campfires = 0;
    for (let q = lo; q <= hi; q++) {
      for (let r = lo; r <= hi; r++) {
        for (let y = y0; y <= y1; y++) {
          const a = live.world.getBlock(q, y, r);
          const b = re.world.getBlock(q, y, r);
          if (a === B.CAMPFIRE) campfires++;
          if (a !== b) differ.push(`${q},${y},${r}: live ${a} reload ${b}`);
        }
      }
    }
    for (const k of re.wet) if (!isWater(re.world.getBlock(...k.split(',').map(Number)))) flooded.push(k);
    return { differ, flooded, campfires };
  }

  it('a reload reaches the live state: a trickle into a stream, and a campfire put out only where live play puts it out', () => {
    // Review water-3 regression: a fall lowered the stream it landed in, so a reload's reflow (both sources at once)
    // briefly ran the stream past the cut before the trickle arrived — a campfire on the dry channel floor there burned
    // on live but was put out on reload ('W 6 F . . C . . .' vs 'W 6 F . . . . . .').
    const gen = genWithSprings(flatWorldGen(5), [[4, 6, 4], [6, 10, 10]]); // (both sources are springs: they keep running)
    const live = loadWorld(gen);
    const w = live.world;
    // The trickle scene of the rule test above, at (4, 4): main channel (q ≥ 4, 6, 4), shaft (6, 7..9, 4), upper
    // channel (6, 10, 4..10).
    for (let q = -1; q <= 13; q++) {
      for (let r = -1; r <= 13; r++) {
        if (!(r === 4 && q >= 4)) w.setBlock(q, 6, r, B.STONE);
        for (let y = 7; y <= 9; y++) if (!(q === 6 && r === 4)) w.setBlock(q, y, r, B.STONE);
        if (!(q === 6 && r >= 4 && r <= 10)) w.setBlock(q, 10, r, B.STONE);
      }
    }
    w.setBlock(4, 6, 4, B.WATER);
    w.setBlock(6, 10, 10, B.WATER);
    settle(live.physics);
    const row = (world) => [4, 5, 6, 7, 8, 9, 10, 11, 12].map((q) => world.getBlock(q, 6, 4));
    expect(row(w)).toEqual([B.WATER, flow(6), flow(5), flow(4), flow(3), flow(2), flow(1), B.AIR, B.AIR]);
    w.setBlock(9, 6, 4, B.CAMPFIRE); // into the stream: put out at once
    w.setBlock(11, 6, 4, B.CAMPFIRE); // on the dry floor past the stream's end: burns
    settle(live.physics);
    expect(row(w)).toEqual([B.WATER, flow(6), flow(5), flow(4), flow(3), flow(2), flow(1), B.CAMPFIRE, B.AIR]);
    const res = reloadAndCompare(live, gen, -2, 14, 5, 11);
    expect(res.differ).toEqual([]);
    expect(res.flooded).toEqual([]);
    expect(res.campfires).toBe(1);
  });

  it('live play and a reload agree on stepped terrain with falls into streams: the reflow only ever rises', () => {
    // Blocky terraces (3 × 3 patches, 0..4 high steps) with sources on the ground and in mid-air: streams pour over
    // steps into other streams. Campfires on every dry floor cell beside water after it settles, then a source taken
    // away. The reload starts from the sources only; with more water never lowering a level it climbs straight to the
    // live state — nothing it wets on the way ends dry, no campfire goes out that live play keeps lit.
    const height = (seed, q, r) => 5 + ((((Math.floor(q / 3) * 92837111) ^ (Math.floor(r / 3) * 689287499) ^ (seed * 283923481)) >>> 0) % 5);
    for (const seed of [1, 2, 3, 4]) {
      // The seven sources, drawn first: each stands in a spring cell (running water: it pours over the steps for good;
      // two in one column share the later one's spring — the other is then an unfed source, which falls and spills).
      let s = seed * 7919;
      const rnd = (n) => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
      };
      const sources = [];
      for (let i = 0; i < 7; i++) {
        const q = 3 + rnd(10);
        const r = 3 + rnd(10);
        sources.push([q, height(seed, q, r) + 1 + (rnd(3) === 0 ? 3 + rnd(4) : 0), r]); // a third of them poured from mid-air
      }
      const gen = genWithSprings({
        seed,
        getColumn: (q, r) => ({ height: height(seed, q, r), biome: 0, temperature: 0, humidity: 0 }),
        generateChunk: (cq, cr) => {
          const d = { blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
          for (let lq = 0; lq < CHUNK_SIZE; lq++) {
            for (let lr = 0; lr < CHUNK_SIZE; lr++) {
              const h = height(seed, cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
              d.heights[lq * CHUNK_SIZE + lr] = h;
              d.blocks.fill(B.STONE, (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT, (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + h + 1);
            }
          }
          return d;
        },
      }, sources);
      const live = loadWorld(gen);
      const w = live.world;
      for (const [q, y, r] of sources) {
        w.setBlock(q, y, r, B.WATER);
        rest(live.physics);
      }
      w.setBlock(...sources[0], B.AIR);
      rest(live.physics);
      let lit = 0;
      for (let q = -4; q <= 19; q++) {
        for (let r = -4; r <= 19; r++) {
          const y = height(seed, q, r) + 1;
          if (w.getBlock(q, y, r) !== B.AIR || !HEX_DIRS.some(([dq, dr]) => isWater(w.getBlock(q + dq, y, r + dr)))) continue;
          w.setBlock(q, y, r, B.CAMPFIRE);
          lit++;
        }
      }
      rest(live.physics);
      expect(lit, `seed ${seed}`).toBeGreaterThan(10);
      const res = reloadAndCompare(live, gen, -8, 23, 5, 20);
      expect(res.differ, `seed ${seed}`).toEqual([]);
      expect(res.flooded, `seed ${seed}`).toEqual([]);
      expect(res.campfires, `seed ${seed}`).toBe(lit);
    }
  });

  it('a source whose open neighbour lies in a chunk loaded later still wakes it', () => {
    const { world, physics } = setup({ springs: [[15, 1, 3]] });
    world.unload(1, 0);
    physics.setSwitch('water', false);
    world.setBlock(15, 1, 3, B.WATER); // edited source on the border of chunk (1, 0)
    physics.setSwitch('water', true);
    world.load(0, 0); // its chunk "generates": the reseeder queues its neighbours (the unloaded ones park)
    settle(physics);
    world.load(1, 0);
    settle(physics);
    expect(world.getBlock(16, 1, 3)).toBe(flow(6));
    expect(census(world, 8, 0, 3, 15, 3).water).toBe(127);
  });
});

describe('drain', () => {
  it('removes every water cell within the radius (hex distance and |dy|) and the flow it fed drains', () => {
    const { world, physics } = setup({ springs: [[0, 1, 0], [0, 1, 9]] });
    world.setBlock(0, 1, 0, B.WATER);
    world.setBlock(0, 1, 9, B.WATER); // outside radius 6
    settle(physics);
    const res = physics.fluids.drain(0, 1, 0, 6);
    expect(res).toEqual({ ok: true, message: expect.stringMatching(/^drained \d+ water cells within 6/) });
    expect(world.getBlock(0, 1, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 1, 9)).toBe(B.WATER);
    settle(physics);
    expect(census(world, 6, 0, 3).cells.every(([q, , r]) => hexLength(q, r - 9) <= 6)).toBe(true);
    expect(census(world, 16, 0, 3, 0, 9).water).toBe(127);
  });

  it('nothing to drain, bad radius, height range and unloaded columns', () => {
    const { world, physics } = setup();
    expect(physics.fluids.drain(0, 1, 0, 4)).toEqual({ ok: true, message: 'no water to drain within 4' });
    expect(physics.fluids.drain(0, 1, 0, DRAIN_MAX_RADIUS + 1).ok).toBe(false);
    expect(physics.fluids.drain(0, 1, 0, -1).ok).toBe(false);
    world.setBlock(0, 9, 0, B.WATER);
    expect(physics.fluids.drain(0, 1, 0, 4).message).toBe('no water to drain within 4'); // |dy| = 8 > 4
    world.unload(1, 0);
    world.setBlock(3, 1, 0, B.WATER);
    const res = physics.fluids.drain(10, 1, 0, 8);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/drained 1 water cell within 8 \(\d+ columns not loaded\)/);
  });
});

describe('currents', () => {
  it('push away from the source in flowing water, down in falling water, nothing in a source or with water off', () => {
    const { world, physics } = setup({ springs: [[0, 1, 0]] });
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    const out = [9, 9, 9];
    const [x2, z2] = hexToWorld(2, 0); // level 5, two cells east of the source
    physics.fluids.currentAt(x2, 1.1, z2, out);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(WATER_CURRENT, 9);
    expect(out[0]).toBeCloseTo(WATER_CURRENT * FACE_NORMALS[0][0], 9); // straight east: away from the source
    const [x0, z0] = hexToWorld(0, 0);
    expect(physics.fluids.currentAt(x0, 1.1, z0, out)).toEqual([0, 0, 0]);
    expect(physics.fluids.currentAt(x2, 5.1, z2, out)).toEqual([0, 0, 0]); // dry air
    world.setBlock(5, 3, 5, B.WATER);
    world.setBlock(5, 2, 5, B.WATER_FALL);
    const [x5, z5] = hexToWorld(5, 5);
    expect(physics.fluids.currentAt(x5, 2.1, z5, out)).toEqual([0, -WATER_CURRENT, 0]);
    physics.setSwitch('water', false);
    expect(physics.fluids.currentAt(x2, 1.1, z2, out)).toEqual([0, 0, 0]);
  });

  it('a level surrounded by equal or higher water has no sideways current; walls are not targets', () => {
    const { world, physics } = setup();
    // FLOW_3 in a pocket: two sides FLOW_4, others stone → nothing lower → no current.
    for (let j = 0; j < 6; j++) world.put(HEX_DIRS[j][0], 1, HEX_DIRS[j][1], j < 2 ? flow(4) : B.STONE);
    world.put(0, 1, 0, flow(3));
    const [x, z] = hexToWorld(0, 0);
    expect(physics.fluids.currentAt(x, 1.1, z, [1, 1, 1])).toEqual([0, 0, 0]);
  });
});

describe('real worldgen (seed 42)', () => {
  it('the open sea heals a removed surface source; a hole dug into the shore fills; the land is not flooded', () => {
    const SEA = 62; // SEA_LEVEL: the highest WATER y in oceans
    const world = new World({ seed: 42, renderDistance: 3, worldGen: createWorldGen(42), now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    for (let i = 0; i < 2000; i++) {
      const s = world.update(0, 0, Infinity);
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    const sides = (q, r) => HEX_DIRS.map(([dq, dr]) => [q + dq, r + dr]);
    let open = null;
    let shore = null;
    for (let q = -40; q <= 40 && !(open && shore); q++) {
      for (let r = -40; r <= 40; r++) {
        if (!open && world.getBlock(q, SEA, r) === B.WATER && world.getBlock(q, SEA - 1, r) === B.WATER
          && sides(q, r).every(([a, b]) => world.getBlock(a, SEA, b) === B.WATER)) open = [q, r];
        if (!shore && world.terrainHeightAt(q, r) === SEA && world.getBlock(q, SEA + 1, r) === B.AIR
          && sides(q, r).some(([a, b]) => world.getBlock(a, SEA, b) === B.WATER)) shore = [q, r];
      }
    }
    expect(open, 'an open-sea cell near spawn').not.toBeNull();
    expect(shore, 'a shore cell near spawn').not.toBeNull();

    // WATER selected + left-click on the open sea: the source goes, and the sea fills it back in (≥ 3 WATER sides).
    world.setBlock(open[0], SEA, open[1], B.AIR);
    settle(physics);
    expect(world.getBlock(open[0], SEA, open[1])).toBe(B.WATER);
    expect(world.editCount).toBe(0);

    // Dig the shore cell: it fills with water (flowing, or sea where three sea cells surround it), nothing else changes.
    world.setBlock(shore[0], SEA, shore[1], B.AIR);
    settle(physics);
    expect(isWater(world.getBlock(shore[0], SEA, shore[1]))).toBe(true);
    expect(world.editCount).toBe(1);
  });
});

describe('real worldgen: drained sea and hillside streams (review water-1, water-3)', () => {
  /** A real World of `seed` loaded at render distance 3 around cell (q, r), physics forwarded like main; `springs` as in `setup`. */
  function realWorld(seed, q, r, springs = []) {
    const world = new World({ seed, renderDistance: 3, worldGen: genWithSprings(createWorldGen(seed), springs), now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    const [x, z] = hexToWorld(q, r);
    for (let i = 0; i < 2000; i++) {
      const s = world.update(x, z, Infinity);
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    return { world, physics };
  }

  it('seed 42: `drain 6` on open sea over a sloping seabed refills to the generated sea, no edits left', () => {
    // Before natural water healed: 163 cells stayed AIR (a hexagonal crater in the surface), 205 FLOW / FALL, 369 edits.
    const { world, physics } = realWorld(42, 29, 24);
    const before = new Map();
    for (let dq = -8; dq <= 8; dq++) for (let dr = -8; dr <= 8; dr++) for (let y = 54; y <= 64; y++) before.set(`${29 + dq},${y},${24 + dr}`, world.getBlock(29 + dq, y, 24 + dr));
    const floors = new Set();
    for (let dq = -6; dq <= 6; dq++) for (let dr = -6; dr <= 6; dr++) if (hexLength(dq, dr) <= 6) floors.add(world.terrainHeightAt(29 + dq, 24 + dr));
    expect(floors.size, 'the seabed under the patch is not flat').toBeGreaterThan(1);
    const res = physics.fluids.drain(29, 62, 24, 6);
    expect(res.message).toBe('drained 408 water cells within 6 — the water around it flows back in');
    settle(physics);
    const wrong = [...before].filter(([k, id]) => world.getBlock(...k.split(',').map(Number)) !== id);
    expect(wrong).toEqual([]);
    expect(world.editCount).toBe(0);
  });

  it('seed 7: one source on the highest hilltop near spawn wets one reach-6 stream (~150 cells), not 10,000', () => {
    const { world, physics } = realWorld(7, 39, -29, [[39, 89, -29]]); // (a spring on the hilltop: it keeps running)
    expect(world.terrainHeightAt(39, -29)).toBe(88);
    expect(world.getBlock(39, 89, -29)).toBe(B.AIR);
    world.setBlock(39, 89, -29, B.WATER);
    settle(physics);
    let n = 0;
    let maxR = 0;
    for (const [key, edits] of world.edits) {
      const [cq, cr] = key.split(',').map(Number);
      for (const [li, id] of edits) {
        if (!isWater(id)) continue;
        const y = li % WORLD_HEIGHT;
        const col = (li - y) / WORLD_HEIGHT;
        const lr = col % CHUNK_SIZE;
        n++;
        maxR = Math.max(maxR, hexLength(cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE - 39, cr * CHUNK_SIZE + lr + 29));
      }
    }
    expect(physics.parkedCount).toBe(0); // it never reached the edge of the loaded area (8,566 cells and 65 parked before)
    expect(maxR).toBeLessThanOrEqual(6);
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(250);
    world.setBlock(39, 89, -29, B.AIR);
    settle(physics);
    expect(world.editCount).toBe(0);
  });
});
