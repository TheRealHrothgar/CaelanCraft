// Regression tests for the block-physics tick budget (CONTRACTS §33.1.4, §33.6.4, §34.1, §36.1.4, §36.3.1): big area
// batches, many seeds and big crumbles spread over ticks under the deadline; an area removal reads no neighbours; a
// saturated fall ring no longer starves the misc / water rings; a cut sand tower releases about one column past the
// budget; a settle never lands under a block that was beneath it. Clocks are fake and charge per clock read or per
// write, so every bound here is deterministic.
import { describe, it, expect } from 'vitest';
import { MAX_CELL_UPDATES_PER_TICK, MAX_COLUMN_FALL, PHYSICS_TICK_BUDGET_MS, WATER_TICKS } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { World } from '../../src/world.js';
import { BlockPhysics, SaveOverlay } from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
/** support.js CRUMBLE_SLICE: a big crumble's cells between two deadline checks. */
const SLICE = 64;

/** A converged real World of flat stone up to `ground`, with physics on the given clock. */
function realWorld(ground, now, hooks = {}) {
  const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(ground), now: () => 0 });
  const physics = attachPhysics(world, BlockPhysics, hooks, { now });
  for (let i = 0; i < 500; i++) {
    const r = world.update(0, 0, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) break;
  }
  return { world, physics };
}

/** A fake world whose clock advances `msPerWrite` per successful setBlock (the cost of a physics write). */
function costlyFakeWorld(msPerWrite, opts = {}) {
  let t = 0;
  const world = makeFakeWorld({ groundY: opts.groundY ?? 10 });
  const setBlock = world.setBlock.bind(world);
  let writes = 0;
  world.setBlock = (q, y, r, id, lazy) => {
    const ok = setBlock(q, y, r, id, lazy);
    if (ok) {
      writes++;
      t += msPerWrite;
    }
    return ok;
  };
  const physics = attachPhysics(world, BlockPhysics, opts.hooks ?? {}, { now: () => t });
  return { world, physics, writes: () => writes };
}

const idle = (p) => p.fallers.count === 0 && p.queued('fall') === 0 && p.queued('misc') === 0 && p.seeds.size === 0 &&
  !p.support.busy && p.trees.count === 0;

describe('area batches and big searches stop on the deadline (CORE-1, F1)', { timeout: 60000 }, () => {
  it('a 15 000-removal `fill … air` batch is swept over several ticks, and still brings down what it cut loose', () => {
    let t = 0;
    let area = false;
    const { world, physics } = realWorld(60, () => (t += 0.25), { areaJobsActive: () => area }); // every clock read: 0.25 ms
    // A slab on one pillar standing on natural ground; the dig takes the ground under it (and the pillar's foot).
    for (let y = 61; y <= 69; y++) world.setBlock(12, y, 12, B.COBBLESTONE);
    for (let q = 8; q <= 16; q++) for (let r = 8; r <= 16; r++) world.setBlock(q, 70, r, B.STONE_BRICKS);
    area = true;
    for (let q = 2; q <= 22; q++) for (let r = 2; r <= 22; r++) for (let y = 28; y <= 61; y++) world.setBlock(q, y, r, B.AIR);
    area = false;
    expect(physics.areaSeedCount).toBe(21 * 21 * 33 + 1); // y 28..60 of terrain, and the pillar's foot at y = 61
    let busyTicks = 0;
    for (let i = 0; i < 400 && (busyTicks === 0 || physics.support.busy || physics.seeds.size > 0); i++) {
      physics.tick();
      if (physics.support.busy) busyTicks++;
    }
    expect(busyTicks).toBeGreaterThanOrEqual(3); // one tick per deadline, not one 0.2 s tick
    for (let i = 0; i < 2000 && !idle(physics); i++) physics.step(1 / 20);
    expect(physics.support.stats.crumbled).toBe(1);
    expect(world.getBlock(12, 70, 12)).toBe(B.AIR);
    let bricks = 0;
    let cobble = 0;
    for (let q = 2; q <= 22; q++) for (let r = 2; r <= 22; r++) for (let y = 28; y <= 70; y++) {
      const id = world.getBlock(q, y, r);
      if (id === B.STONE_BRICKS) bricks++;
      if (id === B.COBBLESTONE) cobble++;
    }
    expect([bricks, cobble]).toEqual([81, 8]); // nothing lost or duplicated
  });

  it('thousands of pending seeds are taken in over several ticks, not in one call', () => {
    let t = 0;
    const world = makeFakeWorld({ groundY: 10 });
    const physics = attachPhysics(world, BlockPhysics, {}, { now: () => (t += 0.25) });
    for (let i = 0; i < 3000; i++) physics.seedSupport([[i, 12, 0]], { removed: [[i, 11, 0, B.STONE, 0]] });
    expect(physics.seeds.size).toBe(3000);
    physics.tick();
    expect(physics.support.busy).toBe(true);
    expect(physics.seeds.size).toBeGreaterThan(0); // the rest waits for the next tick
    for (let i = 0; i < 200 && (physics.seeds.size > 0 || physics.support.busy); i++) physics.tick();
    expect(physics.seeds.size).toBe(0);
    expect(physics.support.busy).toBe(false);
  });

  it('a step with a tiny visit budget does a bounded slice of cheap work (the starved step really is small)', () => {
    let area = true;
    const { world, physics } = realWorld(60, () => 0, { areaJobsActive: () => area });
    for (let q = 1; q <= 30; q++) for (let r = 1; r <= 30; r++) for (let y = 40; y <= 55; y++) world.setBlock(q, y, r, B.AIR);
    area = false;
    physics.flushAreaSeeds();
    const ctx = physics.ctx;
    ctx.deadline = Infinity;
    let steps = 0;
    while ((physics.seeds.size > 0 || physics.support.busy) && steps < 10000) {
      physics.support.step(ctx, physics.seeds, 16);
      steps++;
    }
    expect(steps).toBeGreaterThan(20); // 14 400 removals at ≤ 16 · 8 cheap units per step
    expect(physics.support.stats.crumbled).toBe(0); // everything is held by natural ground
  });
});

describe('area-job writes (F2)', { timeout: 60000 }, () => {
  it('an area removal reads no neighbours: one chunk lookup per write serves the triggers and the collector', () => {
    let area = true;
    const { world, physics } = realWorld(60, () => 0, { areaJobsActive: () => area });
    let lookups = 0;
    const peek = world.peekBlock.bind(world);
    const getChunk = world.getChunk.bind(world);
    world.peekBlock = (q, y, r) => (lookups++, peek(q, y, r));
    world.getChunk = (cq, cr) => (lookups++, getChunk(cq, cr));
    let n = 0;
    for (let q = 2; q <= 13; q++) for (let r = 2; r <= 13; r++) for (let y = 30; y <= 50; y++) if (world.setBlock(q, y, r, B.AIR)) n++;
    expect(n).toBe(12 * 12 * 21);
    expect(lookups / n).toBeLessThanOrEqual(3); // it was ~18: 8 for the collector's neighbour list, 8 for the water check, …
    area = false;
    physics.support.step = () => 0; // keep the seed to look at it
    physics.tick();
    const seed = physics.seeds.shift();
    expect(seed.removed.length).toBe(n);
    expect(seed.cells).toEqual([]); // the search looks at the removals' neighbours itself
    expect(seed.removed.every((rm) => rm[4] === 1)).toBe(true); // untouched terrain: anchors
  });
});

describe('fair shares between the rings (CORE-2)', () => {
  it('a fall ring that is full every tick slows the misc and water rings down but never stops them', () => {
    const world = makeFakeWorld({ groundY: 10 });
    const physics = attachPhysics(world, BlockPhysics, {});
    let fall = 0;
    physics.registerRule('flood', { ring: 'fall', update: (ctx, q, y, r) => (fall++, ctx.schedule('fall', q, y, r)) });
    for (let i = 0; i < MAX_CELL_UPDATES_PER_TICK + 40; i++) physics.schedule('fall', i, 40, 7);
    const misc = [];
    const water = [];
    physics.registerRule('rec-misc', { ring: 'misc', update: (ctx) => misc.push(ctx.tick) });
    physics.registerRule('rec-water', { ring: 'water', update: (ctx) => water.push(ctx.tick) });
    physics.schedule('misc', 0, 30, 0);
    physics.schedule('water', 1, 30, 0);
    physics.tick();
    expect(misc).toEqual([1]); // a barrel by a campfire lights on the next tick
    for (let i = 1; i < WATER_TICKS; i++) physics.tick();
    expect(water).toEqual([WATER_TICKS]); // a new source flows after the water ring's delay
    expect(fall).toBeGreaterThanOrEqual(WATER_TICKS * MAX_CELL_UPDATES_PER_TICK * 0.5); // the flood keeps most of it
  });

  it('a pending collapse gets a support step every tick while the fall ring is full', () => {
    const world = makeFakeWorld({ groundY: 10 });
    const physics = attachPhysics(world, BlockPhysics, {});
    physics.registerRule('flood', { ring: 'fall', update: (ctx, q, y, r) => ctx.schedule('fall', q, y, r) });
    for (let i = 0; i < MAX_CELL_UPDATES_PER_TICK + 40; i++) physics.schedule('fall', i, 40, 7);
    const steps = [];
    physics.support.step = (ctx, seeds) => {
      steps.push(ctx.tick);
      seeds.shift();
      return 1;
    };
    world.setBlock(0, 11, 0, B.STONE);
    world.setBlock(0, 12, 0, B.STONE);
    world.setBlock(0, 11, 0, B.AIR);
    physics.tick();
    expect(steps).toEqual([1]);
  });
});

describe('gravity columns (FR-1)', { timeout: 60000 }, () => {
  it('cutting a 37-column × 64 sand tower releases about one column past the budget per tick, one seed per column', () => {
    const MS_PER_WRITE = 0.02;
    let area = false;
    const { world, physics } = costlyFakeWorld(MS_PER_WRITE, { hooks: { areaJobsActive: () => area } });
    const disc = [];
    for (let dq = -3; dq <= 3; dq++) for (let dr = -3; dr <= 3; dr++) if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) <= 3) disc.push([dq, dr]);
    for (const [q, r] of disc) {
      world.put(q, 11, r, B.STONE);
      for (let y = 12; y < 76; y++) world.put(q, y, r, B.SAND);
    }
    let pushes = 0;
    const push = physics.seeds.push.bind(physics.seeds);
    physics.seeds.push = (seed) => (pushes++, push(seed));
    area = true;
    for (const [q, r] of disc) world.setBlock(q, 11, r, B.AIR);
    area = false;
    const tick = physics.tick.bind(physics);
    let maxTickWrites = 0;
    let writesBefore = 0;
    physics.tick = () => {
      writesBefore = world.writes.length;
      tick();
      maxTickWrites = Math.max(maxTickWrites, world.writes.length - writesBefore);
    };
    for (let i = 0; i < 5000 && !idle(physics); i++) physics.step(1 / 60);
    expect(idle(physics)).toBe(true);
    // ~ the budget's worth of writes plus one column (and its at-cap settles); it was ~3 000 (32 whole columns).
    expect(maxTickWrites).toBeLessThanOrEqual(PHYSICS_TICK_BUDGET_MS / MS_PER_WRITE + 2 * MAX_COLUMN_FALL + 2 * SLICE);
    expect(pushes).toBeLessThanOrEqual(2 * disc.length + 2); // one per released column (+ the area seed), not one per cell
    for (const [q, r] of disc) {
      let sand = 0;
      for (let y = 11; y < 80; y++) if (world.getBlock(q, y, r) === B.SAND) sand++;
      expect(sand).toBe(64);
      expect(world.getBlock(q, 74, r)).toBe(B.SAND);
      expect(world.getBlock(q, 75, r)).toBe(B.AIR);
    }
  });

  it('settleNow lands a block on top of the fallers still in flight below it in its column (no upside-down stack)', () => {
    const world = makeFakeWorld({ groundY: 10 });
    const physics = attachPhysics(world, BlockPhysics, {});
    physics.fallers.spawn(B.BRICKS, 0, 30, 0);
    physics.fallers.spawn(B.GLASS, 0, 31, 0);
    physics.fallers.settleNow(B.STONE, 0, 40, 0);
    expect([world.getBlock(0, 11, 0), world.getBlock(0, 12, 0), world.getBlock(0, 13, 0)]).toEqual([B.BRICKS, B.GLASS, B.STONE]);
    expect(physics.fallers.count).toBe(0);
  });

  it('fallers spawned column after column stay sorted lowest first', () => {
    const world = makeFakeWorld({ groundY: 10 });
    const physics = attachPhysics(world, BlockPhysics, {});
    for (let c = 0; c < 20; c++) for (let y = 40; y < 80; y++) physics.fallers.spawn(B.SAND, c, y, 0);
    physics.step(1 / 60);
    const ys = [];
    for (let i = 0; i < physics.fallers.count; i++) ys.push(physics.fallers.faller(i).y);
    expect(ys.length).toBe(800);
    expect(ys.every((y, i) => i === 0 || ys[i - 1] <= y)).toBe(true);
  });
});

describe('big crumbles come down a slice at a time (FR-2)', { timeout: 60000 }, () => {
  const STRIPES = [B.BRICKS, B.STONE_BRICKS, B.OAK_PLANKS];
  const N = 12; // a 12 × 12 × 12 box (1728 cells) on one pillar
  function floatingBox(msPerWrite) {
    const fx = costlyFakeWorld(msPerWrite);
    const { world } = fx;
    for (let y = 11; y <= 19; y++) world.put(0, y, 0, B.COBBLESTONE);
    for (let q = 0; q < N; q++) for (let r = 0; r < N; r++) for (let y = 20; y < 20 + N; y++) world.put(q, y, r, STRIPES[y % 3]);
    return fx;
  }
  const original = (y) => STRIPES[y % 3];

  it('spreads over ticks within the budget, keeps every stack in order and loses nothing', () => {
    const MS_PER_WRITE = 0.02;
    const { world, physics } = floatingBox(MS_PER_WRITE);
    const tick = physics.tick.bind(physics);
    let maxTickWrites = 0;
    let crumbleTicks = 0;
    physics.tick = () => {
      const before = world.writes.length;
      const crumbled = physics.support.stats.crumbled;
      tick();
      const n = world.writes.length - before;
      maxTickWrites = Math.max(maxTickWrites, n);
      if (n > 0 && (physics.support.busy || physics.support.stats.crumbled > crumbled)) crumbleTicks++;
    };
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    for (let i = 0; i < 6000 && !idle(physics); i++) physics.step(1 / 60);
    expect(idle(physics)).toBe(true);
    expect(physics.support.stats.crumbled).toBe(1);
    expect(crumbleTicks).toBeGreaterThanOrEqual(5); // it was one tick of ~3 500 writes
    expect(maxTickWrites).toBeLessThanOrEqual(PHYSICS_TICK_BUDGET_MS / MS_PER_WRITE + 4 * SLICE);
    for (let q = 0; q < N; q++) for (let r = 0; r < N; r++) {
      const stack = [];
      for (let y = 11; y < 40; y++) {
        const id = world.getBlock(q, y, r);
        if (id !== B.AIR && id !== B.COBBLESTONE) stack.push(id);
      }
      expect(stack).toEqual(Array.from({ length: N }, (_, k) => original(20 + k))); // bottom layer lowest
    }
  });

  it('undo while it is still coming down stops it and puts the whole build back', () => {
    const { world, physics } = floatingBox(0.02);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    for (let i = 0; i < 400 && physics.support.stats.crumbled === 0; i++) physics.tick();
    for (let i = 0; i < 3; i++) physics.tick();
    expect(physics.support.busy).toBe(true); // part of it still hangs
    expect(world.getBlock(5, 20 + N - 1, 5)).toBe(original(20 + N - 1));
    expect(physics.undo().ok).toBe(true);
    expect(physics.support.busy).toBe(false);
    for (let i = 0; i < 600 && !idle(physics); i++) physics.step(1 / 60);
    for (let q = 0; q < N; q++) for (let r = 0; r < N; r++) for (let y = 20; y < 20 + N; y++) expect(world.getBlock(q, y, r)).toBe(original(y));
    expect(world.getBlock(5, 11, 5)).toBe(B.AIR);
  });

  it('a save while it is still coming down saves the hanging part fallen (nothing floats after a reload)', () => {
    const { world, physics } = floatingBox(0.02);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    for (let i = 0; i < 400 && physics.support.stats.crumbled === 0; i++) physics.tick();
    physics.tick();
    expect(physics.support.busy).toBe(true);
    const overlay = new SaveOverlay(world);
    physics.fallers.settleInto(overlay);
    physics.support.settleInto(overlay);
    for (let q = 0; q < N; q++) for (let r = 0; r < N; r++) {
      const stack = [];
      for (let y = 11; y < 40; y++) {
        const id = overlay.peek(q, y, r);
        if (id !== B.AIR && id !== B.COBBLESTONE) stack.push(id);
      }
      expect(stack).toEqual(Array.from({ length: N }, (_, k) => original(20 + k)));
      expect(overlay.peek(q, 20 + N - 1, r)).toBe(B.AIR);
    }
  });
});
