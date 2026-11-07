// Unit tests for src/fluids.js — flowing water (CONTRACTS §35, DESIGN-physics §4): the water rule (spreads-sideways,
// fed levels, falling, the ≥ 3 infinite-source rule, downward), its floor trigger and reseeder (streaming / reloads),
// campfires, drain, currents and the save rule. Map-backed fake worlds from the fixtures unless a real World matters
// (chunk corners while streaming, the seed-42 sea).
import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WATER_CURRENT, DRAIN_MAX_RADIUS, WATER_SOURCE_NEIGHBOURS, WORLD_HEIGHT,
} from '../../src/config.js';
import { BLOCK, isWater, waterLevel, waterSurfaceHeight } from '../../src/blocks.js';
import { HEX_DIRS, FACE_NORMALS, hexToWorld, hexLength } from '../../src/hex.js';
import { World } from '../../src/world.js';
import { createWorldGen } from '../../src/worldgen.js';
import { BlockPhysics, SaveOverlay } from '../../src/blockphysics.js';
import { WATER_RULE_IDS, isFlowingWater, isWaterFloor, flowId } from '../../src/fluids.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const flow = (k) => B.WATER_FLOW_1 + k - 1;

/** A fake world (stone for y ≤ groundY) with physics attached; `fx` records sounds and particles. */
function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? 0 });
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
    expect([...WATER_RULE_IDS]).toEqual([B.AIR, B.CAMPFIRE, B.WATER, 68, 69, 70, 71, 72, 73, B.WATER_FALL]);
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
    const { world, physics } = setup();
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
  });

  it('one source on a 10-high plateau stays bounded (hundreds of cells, not thousands) and fully drains', () => {
    const { world, physics } = setup();
    plateau(world, 3, 10);
    world.setBlock(0, 11, 0, B.WATER);
    settle(physics);
    const c = census(world, 24, 0, 14);
    // 61 on top (37 on the plateau + 24 over the edge), 24 waterfalls of 10 cells, 270 spreading at the bottom.
    expect(c.water).toBe(571);
    expect(c.fall).toBe(240);
    expect(c.maxR).toBe(10);
    // Mid-cliff falling water never spreads: only the 24 fall cells at y = 5.
    expect(c.cells.filter(([, y]) => y === 5).length).toBe(24);
    expect(c.cells.filter(([, y]) => y === 5).every(([q, , r, id]) => id === B.WATER_FALL && hexLength(q, r) === 4)).toBe(true);
    world.setBlock(0, 11, 0, B.AIR);
    settle(physics);
    expect(census(world, 24, 0, 14).water).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('two adjacent sources do NOT spread into a lake (≥ 3 rule); three around a hole make a closed 7-source pool', () => {
    expect(WATER_SOURCE_NEIGHBOURS).toBe(3);
    const a = setup();
    a.world.setBlock(0, 1, 0, B.WATER);
    a.world.setBlock(1, 1, 0, B.WATER);
    settle(a.physics);
    const ca = census(a.world, 30, 0, 4);
    expect(ca.sources).toBe(2);
    expect(ca.water).toBe(140); // the union of two reach-6 discs
    // The two shared neighbours have two WATER neighbours each: flowing, not sources.
    expect(a.world.getBlock(0, 1, 1)).toBe(flow(6));
    expect(a.world.getBlock(1, 1, -1)).toBe(flow(6));

    const b = setup();
    for (const j of [0, 2, 4]) b.world.setBlock(HEX_DIRS[j][0], 1, HEX_DIRS[j][1], B.WATER);
    settle(b.physics);
    const cb = census(b.world, 30, 0, 4);
    expect(cb.sources).toBe(7); // the hole and its three other neighbours become sources, then it stops
    expect(cb.maxR).toBe(7);
    expect(b.world.getBlock(0, 1, 0)).toBe(B.WATER);
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

  it('a waterfall advances one cell per tick and spreads only where it lands', () => {
    const { world, physics } = setup({ groundY: 0 });
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

  it('removing the floor under flowing water re-evaluates what it fed (the water-floor trigger)', () => {
    // A one-wide channel along +q at y = 6 on a y ≤ 5 floor: levels 6, 5, 4, 3, 2, 1.
    const { world, physics } = setup({ groundY: 5 });
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
    const { world, physics, fx } = setup();
    world.setBlock(2, 1, 0, B.CAMPFIRE);
    world.put(5, 3, 0, B.STONE);
    world.setBlock(5, 1, 0, B.CAMPFIRE);
    world.setBlock(5, 2, 0, B.WATER); // over the campfire, on nothing: it falls into it
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    expect(world.getBlock(2, 1, 0)).toBe(flow(5));
    expect(isWater(world.getBlock(5, 1, 0))).toBe(true);
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
    const { world, physics } = setup();
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

  it('stops spreading at the edit cap ("capped") without throwing', () => {
    const { world, physics } = setup();
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
    const { world, physics } = setup();
    world.setBlock(15, 1, 15, B.WATER); // chunk (0, 0); its neighbours reach chunks (1, 0), (0, 1) and (1, 1)
    settle(physics);
    const c = census(world, 8, 0, 3, 15, 15);
    expect(c.water).toBe(127);
    const chunks = new Set(c.cells.map(([q, , r]) => `${Math.floor(q / CHUNK_SIZE)},${Math.floor(r / CHUNK_SIZE)}`));
    expect([...chunks].sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });

  it('flow toward unloaded chunks waits (parks) and finishes when they load', () => {
    const { world, physics } = setup();
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
    const { world, physics } = setup();
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
    const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(10), now: () => 0 });
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
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.AIR);
    world.setBlock(0, 3, 0, B.AIR);
    world.setBlock(8, 5, 6, B.WATER); // a placed source up on the land
    settle(physics);
    const saved = physics.exportEdits();

    // A fresh world with the same terrain and the saved edits, then the chunks "generate".
    const w2 = makeFakeWorld({ groundY: 3 });
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
  });

  it('a source whose open neighbour lies in a chunk loaded later still wakes it', () => {
    const { world, physics } = setup();
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
    const { world, physics } = setup();
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
    const { world, physics } = setup();
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
