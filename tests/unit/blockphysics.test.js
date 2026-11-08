// Unit tests for src/blockphysics.js — the block-physics scheduler (CONTRACTS §33): rings, dedupe, budgets, parking and
// re-seeding, triggers, switches, support seeds, undo events and the save overlay. Most run on the Map-backed fake
// world from the fixtures; the streaming / chunk-corner scenarios run on a real World.
import { describe, it, expect, vi } from 'vitest';
import {
  CHUNK_SIZE, MAX_CELL_UPDATES_PER_TICK, MAX_TOTAL_EDITS, PHYSICS_TICK_S, WATER_TICKS, UNDO_WINDOW_S,
  MAX_SUPPORT_VISITS_PER_TICK, SUPPORT_STARVED_VISITS,
} from '../../src/config.js';
import { BLOCK, UNLOADED } from '../../src/blocks.js';
import { localIndex, packCell } from '../../src/coords.js';
import { World } from '../../src/world.js';
import {
  BlockPhysics, SaveOverlay, SeedQueue, RINGS, FEATURES, WRITE_EXTERNAL, WRITE_PHYSICS, WRITE_QUIET, CAUSE_AREA,
} from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;

/** A fake world (flat stone floor at y ≤ groundY) with physics attached. */
function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? 10, now: opts.now });
  const said = [];
  const physics = attachPhysics(world, BlockPhysics, { say: (t) => said.push(t), ...opts.hooks }, opts.physicsOpts);
  return { world, physics, said };
}

/** A converged real World (flat stone floor at 10, renderDistance 2) with physics attached. */
function realWorld(opts = {}) {
  const world = new World({ seed: 1, renderDistance: opts.rd ?? 2, worldGen: flatWorldGen(opts.groundY ?? 10), now: () => 0 });
  const physics = attachPhysics(world, BlockPhysics, opts.hooks ?? {});
  converge(world, opts.px ?? 0, opts.pz ?? 0);
  return { world, physics };
}

function converge(world, px = 0, pz = 0) {
  for (let i = 0; i < 500; i++) {
    const r = world.update(px, pz, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) return;
  }
  throw new Error('world did not converge');
}

/** A rule on `ring` that records every call. */
function recorder(physics, ring = 'misc', spec = {}) {
  const calls = [];
  physics.registerRule(`rec-${ring}`, { ring, ...spec, update: (ctx, q, y, r, id) => calls.push([q, y, r, id, ctx.tick]) });
  return calls;
}

describe('constants', () => {
  it('rings, features and write modes', () => {
    expect(RINGS).toEqual(['fall', 'water', 'misc']);
    expect(FEATURES).toEqual(['falling', 'water', 'collapse', 'explosions']);
    expect(new Set([WRITE_EXTERNAL, WRITE_PHYSICS, WRITE_QUIET]).size).toBe(3);
  });

  it('owns one instance of every feature module and registers the gravity rule on the fall ring', () => {
    const { physics } = setup();
    for (const m of ['fallers', 'fluids', 'support', 'trees', 'explosions']) expect(physics[m]).toBeTruthy();
    expect(physics.ruleNames('fall')).toContain('gravity');
    expect(physics.ctx.fallers).toBe(physics.fallers);
  });
});

describe('scheduling and rings', () => {
  it('dedupes a cell per ring and runs it after the ring delay', () => {
    const { physics } = setup();
    const misc = recorder(physics, 'misc');
    const water = recorder(physics, 'water');
    expect(physics.schedule('misc', 1, 20, 2)).toBe(true);
    expect(physics.schedule('misc', 1, 20, 2)).toBe(false); // already queued
    expect(physics.schedule('water', 1, 20, 2)).toBe(true); // other ring: separate queue
    expect(physics.queued()).toBe(2);
    expect(physics.isQueued('misc', 1, 20, 2)).toBe(true);
    physics.tick();
    expect(misc).toEqual([[1, 20, 2, B.AIR, 1]]);
    expect(water).toEqual([]);
    for (let i = 1; i < WATER_TICKS; i++) physics.tick();
    expect(water).toEqual([[1, 20, 2, B.AIR, WATER_TICKS]]);
    expect(physics.queued()).toBe(0);
    // Out-of-range y is never queued; unknown rings are a programming error.
    expect(physics.schedule('misc', 0, -1, 0)).toBe(false);
    expect(() => physics.schedule('nope', 0, 0, 0)).toThrow(RangeError);
  });

  it('a cell re-scheduled by its own update runs again on a later tick, not twice in one', () => {
    const { physics } = setup();
    let n = 0;
    physics.registerRule('again', { ring: 'misc', update: (ctx, q, y, r) => (n++, ctx.schedule('misc', q, y, r)) });
    physics.schedule('misc', 0, 20, 0);
    physics.tick();
    expect(n).toBe(1);
    physics.tick();
    expect(n).toBe(2);
  });

  it('step(dt) runs at most one tick per frame and drops the leftover beyond one tick', () => {
    const { physics } = setup();
    physics.step(PHYSICS_TICK_S / 2);
    expect(physics.tickCount).toBe(0);
    physics.step(PHYSICS_TICK_S / 2);
    expect(physics.tickCount).toBe(1);
    physics.step(1); // a 1 s hitch: still one tick (slow motion, not a burst)
    expect(physics.tickCount).toBe(2);
    physics.step(0); // the leftover was capped at one tick: at most one more
    expect(physics.tickCount).toBe(3);
    physics.step(0);
    expect(physics.tickCount).toBe(3);
  });
});

describe('budgets', () => {
  it('stops at MAX_CELL_UPDATES_PER_TICK and resumes FIFO from the head next tick (nothing starves)', () => {
    const { physics } = setup();
    const calls = recorder(physics, 'misc');
    const n = MAX_CELL_UPDATES_PER_TICK * 2 + 50;
    for (let i = 0; i < n; i++) physics.schedule('misc', i, 20, 0);
    physics.tick();
    expect(calls.length).toBe(MAX_CELL_UPDATES_PER_TICK);
    physics.tick();
    expect(calls.length).toBe(MAX_CELL_UPDATES_PER_TICK * 2);
    // Cells scheduled now go behind the leftovers.
    physics.schedule('misc', -5, 20, -5);
    physics.tick();
    expect(calls.length).toBe(n + 1);
    expect(calls.map((c) => c[0])).toEqual([...Array.from({ length: n }, (_, i) => i), -5]);
  });

  it('checks the time budget every 32 updates', () => {
    let t = 0;
    const { physics } = setup({ physicsOpts: { now: () => t++ } }); // every clock read costs 1 ms
    const calls = recorder(physics, 'misc');
    for (let i = 0; i < 200; i++) physics.schedule('misc', i, 20, 0);
    physics.tick();
    // start = 0; checks at 32 (1 ms), 64 (2 ms), 96 (3 ms ≥ PHYSICS_TICK_BUDGET_MS) → stop.
    expect(calls.length).toBe(96);
    expect(physics.stats.lastTickUpdates).toBe(96);
  });

  it('rings run fall → misc → water and share the budget', () => {
    const { physics } = setup();
    const order = [];
    for (const ring of RINGS) physics.registerRule(`o-${ring}`, { ring, update: () => order.push(ring) });
    physics.schedule('water', 0, 20, 0, 1);
    physics.schedule('misc', 0, 20, 0);
    physics.schedule('fall', 0, 20, 0);
    physics.tick();
    expect(order).toEqual(['fall', 'misc', 'water']);
  });
});

describe('rule registry', () => {
  it('rules see only their ids and only while their feature is on; several rules may share a ring', () => {
    const { physics, world } = setup();
    world.put(0, 20, 0, B.STONE);
    const sandOnly = recorder(physics, 'misc', { ids: [B.SAND] });
    const all = [];
    physics.registerRule('all', { ring: 'misc', feature: 'water', update: (ctx, q, y, r, id) => all.push(id) });
    physics.schedule('misc', 0, 20, 0);
    physics.tick();
    expect(sandOnly).toEqual([]);
    expect(all).toEqual([B.STONE]);
    physics.setSwitch('water', false);
    physics.schedule('misc', 0, 20, 0);
    physics.tick();
    expect(all).toEqual([B.STONE]);
  });

  it('a rule can be registered on several rings, replaced by name and unregistered', () => {
    const { physics } = setup();
    const seen = [];
    physics.registerRule('multi', { rings: ['water', 'fall'], update: (ctx) => seen.push(ctx.tick) });
    expect(physics.ruleNames('water')).toEqual(['water', 'multi']); // fluids.js registers 'water' first
    expect(physics.ruleNames('fall')).toContain('multi');
    physics.registerRule('multi', { ring: 'misc', update: () => seen.push('misc') });
    expect(physics.ruleNames('water')).toEqual(['water']);
    expect(physics.ruleNames('misc')).toEqual(['ignite', 'multi']); // after explosions' campfire-ignition rule
    expect(physics.unregisterRule('multi')).toBe(true);
    expect(physics.unregisterRule('multi')).toBe(false);
  });

  it('a throwing rule does not stop the tick (warned once)', () => {
    const { physics } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    physics.registerRule('boom', { ring: 'misc', update: () => {
      throw new Error('boom');
    } });
    const calls = recorder(physics, 'misc');
    physics.schedule('misc', 0, 20, 0);
    physics.schedule('misc', 1, 20, 0);
    physics.tick();
    expect(calls.length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('ctx.write', () => {
  it('is a lazy setBlock; ok when the cell already holds the id; failed in unloaded chunks', () => {
    const { physics, world } = setup();
    const ctx = physics.ctx;
    expect(ctx.write(0, 20, 0, B.STONE)).toBe('ok');
    expect(world.writes.at(-1)).toEqual({ q: 0, y: 20, r: 0, id: B.STONE, lazy: true });
    expect(ctx.write(0, 20, 0, B.STONE)).toBe('ok');
    expect(world.writes.length).toBe(1);
    world.unload(5, 5);
    expect(ctx.write(5 * CHUNK_SIZE, 20, 5 * CHUNK_SIZE, B.STONE)).toBe('failed');
    expect(ctx.write(0, 200, 0, B.STONE)).toBe('failed');
  });

  it("is 'capped' only for a NEW edit entry once editCount reaches MAX_TOTAL_EDITS, with one chat line", () => {
    const { physics, world, said } = setup();
    const ctx = physics.ctx;
    world.setBlock(0, 20, 0, B.STONE); // an existing edit
    world.editCount = MAX_TOTAL_EDITS;
    expect(ctx.write(1, 20, 0, B.STONE)).toBe('capped');
    expect(ctx.write(2, 20, 0, B.STONE)).toBe('capped');
    expect(said.length).toBe(1);
    expect(ctx.write(0, 20, 0, B.DIRT)).toBe('ok'); // modifies an existing entry
    expect(ctx.write(0, 20, 0, B.AIR)).toBe('ok'); // back to the origin: removes an entry
    expect(world.getBlock(1, 20, 0)).toBe(B.AIR);
  });

  it('reports the write mode to triggers: physics / quiet / external', () => {
    const { physics, world } = setup();
    const modes = [];
    physics.addTrigger('spy', null, (q, y, r, prev, next, mode) => modes.push(mode));
    physics.ctx.write(0, 20, 0, B.STONE);
    physics.ctx.writeQuiet(1, 20, 0, B.STONE);
    world.setBlock(2, 20, 0, B.STONE);
    expect(modes).toEqual([WRITE_PHYSICS, WRITE_QUIET, WRITE_EXTERNAL]);
  });
});

describe('parking and re-seeding', () => {
  it('an update that needs an unloaded cell parks on that chunk and re-runs when it is generated', () => {
    const { physics, world } = setup();
    const seen = [];
    physics.registerRule('peek-east', {
      ring: 'misc',
      update: (ctx, q, y, r) => {
        const east = ctx.peek(q + 1, y, r);
        if (east === UNLOADED) return ctx.park();
        seen.push(east);
      },
    });
    world.unload(1, 0);
    physics.schedule('misc', CHUNK_SIZE - 1, 20, 0); // the chunk-edge cell whose east neighbour is in chunk (1, 0)
    physics.tick();
    expect(seen).toEqual([]);
    expect(physics.parkedCount).toBe(1);
    expect(physics.queued()).toBe(0);
    world.put(CHUNK_SIZE, 20, 0, B.GLASS);
    world.load(1, 0); // fires onChunkGenerated
    expect(physics.parkedCount).toBe(0);
    physics.tick();
    expect(seen).toEqual([B.GLASS]);
  });

  it('a queued cell in an unloaded chunk parks itself', () => {
    const { physics, world } = setup();
    const calls = recorder(physics, 'misc');
    world.unload(2, 2);
    physics.schedule('misc', 2 * CHUNK_SIZE + 3, 20, 2 * CHUNK_SIZE + 3);
    physics.tick();
    expect(calls).toEqual([]);
    expect(physics.parkedCount).toBe(1);
    world.load(2, 2);
    physics.tick();
    expect(calls.length).toBe(1);
  });

  it('re-seeds edited gravity blocks over a fall-through cell when their chunk is generated (streaming / reload)', () => {
    const { physics, world } = setup();
    physics.setSwitch('falling', false);
    world.setBlock(3, 20, 3, B.SAND); // floating sand edit; the trigger is dropped while falling is off
    expect(physics.queued()).toBe(0);
    physics.setSwitch('falling', true);
    expect(physics.queued()).toBe(0); // switching back on never acts retroactively
    world.unload(0, 0);
    world.load(0, 0);
    expect(physics.isQueued('fall', 3, 20, 3)).toBe(true);
    physics.tick();
    expect(world.getBlock(3, 20, 3)).toBe(B.AIR);
    expect(physics.fallers.count).toBe(1);
  });

  it('re-seeds edited water: sources wake their open neighbours, flowing water itself (reseeders follow the switches)', () => {
    const { physics, world } = setup();
    physics.setSwitch('water', false);
    world.setBlock(0, 11, 0, B.WATER);
    world.setBlock(5, 11, 5, B.WATER_FLOW_3);
    expect(physics.queued()).toBe(0);
    world.load(0, 0);
    expect(physics.queued()).toBe(0); // water off: not re-seeded
    physics.setSwitch('water', true);
    world.load(0, 0);
    expect(physics.isQueued('water', 1, 11, 0)).toBe(true); // an air neighbour of the source
    expect(physics.isQueued('water', 0, 11, 0)).toBe(false); // sources never change by themselves
    expect(physics.isQueued('water', 5, 11, 5)).toBe(true);
  });
});

describe('built-in triggers', () => {
  it('falling: removing a block queues the gravity block above; a gravity block placed over air queues itself', () => {
    const { physics, world } = setup();
    world.put(0, 12, 0, B.SAND);
    world.setBlock(0, 11, 0, B.STONE);
    expect(physics.queued('fall')).toBe(0);
    world.setBlock(0, 11, 0, B.AIR);
    expect(physics.isQueued('fall', 0, 12, 0)).toBe(true);
    world.setBlock(4, 20, 4, B.GRAVEL);
    expect(physics.isQueued('fall', 4, 20, 4)).toBe(true);
    world.setBlock(6, 11, 6, B.SAND); // on the ground: nothing to do
    expect(physics.isQueued('fall', 6, 11, 6)).toBe(false);
    world.setBlock(7, 20, 7, B.CAMPFIRE); // a floating campfire breaks
    expect(physics.isQueued('fall', 7, 20, 7)).toBe(true);
  });

  it('water: placing water queues it and its open neighbours; an open cell under water uses the fall ring', () => {
    const { physics, world } = setup();
    world.setBlock(0, 15, 0, B.WATER);
    expect(physics.isQueued('water', 0, 15, 0)).toBe(true);
    expect(physics.isQueued('water', 1, 15, 0)).toBe(true);
    expect(physics.isQueued('fall', 0, 14, 0)).toBe(true); // air below water: will become falling water
    expect(physics.isQueued('water', 0, 14, 0)).toBe(false);
    // A change of fall-through-ness next to water queues it too; a change that is neither does not.
    const { physics: p2, world: w2 } = setup();
    w2.put(0, 11, 0, B.WATER);
    w2.setBlock(1, 11, 0, B.STONE);
    expect(p2.isQueued('water', 0, 11, 0)).toBe(true);
    const { physics: p3, world: w3 } = setup();
    w3.put(0, 11, 0, B.WATER);
    w3.setBlock(1, 10, 0, B.DIRT); // stone → dirt under a neighbour: nothing changes for water
    expect(p3.queued()).toBe(0);
  });

  it('explosions: a campfire next to a barrel (either order) queues the barrel in the misc ring', () => {
    const { physics, world } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    expect(physics.queued('misc')).toBe(0);
    world.setBlock(1, 11, 0, B.CAMPFIRE);
    expect(physics.isQueued('misc', 0, 11, 0)).toBe(true);
    const { physics: p2, world: w2 } = setup();
    w2.setBlock(0, 11, 0, B.CAMPFIRE);
    w2.setBlock(0, 12, 0, B.BLAST_BARREL);
    expect(p2.isQueued('misc', 0, 12, 0)).toBe(true);
  });

  it('a switched-off feature drops its triggers (and switching it on later does not replay them)', () => {
    const { physics, world } = setup();
    for (const f of FEATURES) physics.setSwitch(f, false);
    world.setBlock(0, 20, 0, B.SAND);
    world.setBlock(2, 15, 2, B.WATER);
    world.setBlock(4, 11, 4, B.BLAST_BARREL);
    world.setBlock(5, 11, 4, B.CAMPFIRE);
    world.setBlock(6, 10, 6, B.AIR);
    expect(physics.queued()).toBe(0);
    expect(physics.seeds.size).toBe(0);
    for (const f of FEATURES) physics.setSwitch(f, true);
    physics.tick();
    expect(world.getBlock(0, 20, 0)).toBe(B.SAND);
    expect(physics.fallers.count).toBe(0);
  });

  it('paused: no ticks and frozen entities, but triggers still queue', () => {
    const { physics, world } = setup();
    physics.setPaused(true);
    world.setBlock(0, 20, 0, B.SAND);
    for (let i = 0; i < 10; i++) physics.step(1 / 60);
    expect(physics.tickCount).toBe(0);
    expect(world.getBlock(0, 20, 0)).toBe(B.SAND);
    expect(physics.isQueued('fall', 0, 20, 0)).toBe(true);
    physics.setPaused(false);
    for (let i = 0; i < 4; i++) physics.step(1 / 60);
    expect(world.getBlock(0, 20, 0)).toBe(B.AIR);
  });
});

describe('switches', () => {
  it('export / import (missing or non-boolean → on), switchVersion bumps on changes only', () => {
    const { physics } = setup();
    expect(physics.exportSwitches()).toEqual({ falling: true, water: true, collapse: true, explosions: true });
    const v = physics.switchVersion;
    expect(physics.setSwitch('collapse', false)).toBe(true);
    expect(physics.setSwitch('collapse', false)).toBe(false);
    expect(physics.setSwitch('nope', false)).toBe(false);
    expect(physics.switchVersion).toBe(v + 1);
    physics.importSwitches({ falling: false, water: 'yes' });
    expect(physics.exportSwitches()).toEqual({ falling: false, water: true, collapse: true, explosions: true });
    expect(physics.switchVersion).toBe(v + 1); // importing is not a change to save
  });

  it('tells the feature module through onSwitch', () => {
    const { physics } = setup();
    const spy = vi.fn();
    physics.explosions.onSwitch = spy;
    physics.setSwitch('explosions', false);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

describe('support seeds', () => {
  it('removing a load-bearing cell seeds its load-bearing neighbours with the removal; the solver gets the queue', () => {
    const { physics, world } = setup();
    world.setBlock(0, 11, 0, B.STONE);
    world.setBlock(0, 12, 0, B.STONE);
    world.setBlock(1, 11, 0, B.OAK_LEAVES); // leaves never carry load: not a seed cell
    const steps = [];
    physics.support.step = (ctx, seeds, maxVisits) => {
      steps.push({ size: seeds.size, seed: seeds.shift(), maxVisits });
      return 5;
    };
    world.setBlock(0, 11, 0, B.AIR);
    expect(physics.seeds.size).toBe(1);
    const peeked = physics.seeds.peek();
    expect(peeked.cells.map((c) => c.join())).toEqual(expect.arrayContaining(['0,12,0', '0,10,0']));
    expect(peeked.cells.map((c) => c.join())).not.toContain('1,11,0');
    expect(peeked.removed).toEqual([[0, 11, 0, B.STONE, 0]]);
    expect(peeked.cause.kind).toBe('world');
    expect(peeked.priority).toBe(false);
    physics.tick();
    expect(steps.length).toBe(1);
    expect(steps[0].maxVisits).toBe(8192);
    expect(physics.stats.lastSupportVisits).toBe(5);
  });

  it('a collapse is never starved by a full fall ring: it gets its share every tick (fair shares, §33.1.3 / §38.4)', () => {
    let t = 0;
    const { physics, world } = setup({ physicsOpts: { now: () => t } });
    // A fall-ring rule that re-queues MORE than a tick's worth of cells forever (a huge waterfall / cascade).
    physics.registerRule('flood', { ring: 'fall', update: (ctx, q, y, r) => ctx.schedule('fall', q, y, r) });
    for (let i = 0; i < MAX_CELL_UPDATES_PER_TICK + 40; i++) physics.schedule('fall', i, 40, 7);
    const steps = [];
    physics.support.step = (ctx, seeds, maxVisits) => {
      steps.push({ tick: ctx.tick, maxVisits, deadline: ctx.deadline });
      seeds.shift();
      return 1;
    };
    world.setBlock(0, 11, 0, B.STONE);
    world.setBlock(0, 12, 0, B.STONE);
    world.setBlock(0, 11, 0, B.AIR); // a pending collapse check
    physics.tick();
    expect(steps.length).toBe(1); // the fall ring stopped at its share (FALL_SHARE) for it
    expect(steps[0].maxVisits).toBe(MAX_SUPPORT_VISITS_PER_TICK);
    // A ring that overran the whole budget (one huge update) still leaves the collapse a small step.
    physics.registerRule('slow', { ring: 'fall', update: () => (t += 10) });
    physics.schedule('fall', 0, 60, 0, 1);
    physics.schedule('fall', 1, 60, 0, 1);
    world.setBlock(1, 11, 1, B.STONE);
    world.setBlock(1, 12, 1, B.STONE);
    world.setBlock(1, 11, 1, B.AIR);
    physics.tick();
    expect(steps.length).toBe(2);
    expect(steps[1].maxVisits).toBe(SUPPORT_STARVED_VISITS);
    physics.unregisterRule('slow');
    // With the ring calm again, support gets its full budget at once.
    physics.unregisterRule('flood');
    for (let i = 0; i < 3; i++) physics.tick();
    world.setBlock(0, 12, 0, B.AIR);
    world.setBlock(0, 13, 0, B.STONE);
    world.setBlock(0, 12, 0, B.STONE);
    world.setBlock(0, 12, 0, B.AIR);
    physics.tick();
    expect(steps.at(-1).maxVisits).toBe(MAX_SUPPORT_VISITS_PER_TICK);
  });

  it('a removed untouched-terrain cell is reported as an anchor', () => {
    const { physics, world } = setup();
    world.setBlock(0, 10, 0, B.AIR); // natural ground at y ≤ 10
    expect(physics.seeds.peek().removed[0][4]).toBe(1);
  });

  it('player-caused removals go to the priority lane; quiet writes and collapse-off seed nothing', () => {
    const { physics, world } = setup({ hooks: { player: () => ({ x: 1, y: 11, z: 2 }) } });
    world.setBlock(5, 10, 5, B.AIR); // world-caused
    physics.asPlayer(() => world.setBlock(8, 10, 8, B.AIR));
    const first = physics.seeds.shift();
    expect(first.cause).toEqual({ kind: 'player', x: 1, y: 11, z: 2 });
    expect(first.priority).toBe(true);
    expect(physics.seeds.shift().cause.kind).toBe('world');
    physics.ctx.writeQuiet(3, 10, 3, B.AIR);
    expect(physics.seeds.size).toBe(0);
    physics.setSwitch('collapse', false);
    world.setBlock(4, 10, 4, B.AIR);
    expect(physics.seeds.size).toBe(0);
  });

  it('while area jobs run, removals are collected and become ONE seed (cause area) once they end', () => {
    let active = true;
    const { physics, world } = setup({ hooks: { areaJobsActive: () => active } });
    for (let q = 0; q < 5; q++) world.setBlock(q, 10, 0, B.AIR);
    expect(physics.seeds.size).toBe(0);
    expect(physics.areaSeedCount).toBe(5);
    physics.support.step = () => 0; // keep the seed so the test can look at it
    physics.tick();
    expect(physics.seeds.size).toBe(0); // still active
    active = false;
    physics.tick();
    expect(physics.areaSeedCount).toBe(0);
    const seed = physics.seeds.shift();
    expect(seed.cause).toBe(CAUSE_AREA);
    expect(seed.removed.length).toBe(5);
    // Neighbour cells are deduped across the batch.
    const keys = seed.cells.map((c) => c.join());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the seed queue dedupes pending cells and keeps priority first', () => {
    const q = new SeedQueue(3);
    expect(q.push({ cells: [[0, 1, 0], [1, 1, 0]], removed: [], priority: false })).toBe(true);
    expect(q.push({ cells: [[0, 1, 0]], removed: [], priority: false })).toBe(false); // nothing new
    expect(q.push({ cells: [[0, 1, 0]], removed: [[0, 2, 0, 1, 0]], priority: true })).toBe(true); // a removal is kept
    expect(q.size).toBe(2);
    expect(q.shift().priority).toBe(true);
    expect(q.shift().cells.length).toBe(2);
    expect(q.shift()).toBeNull();
  });
});

describe('events and undo', () => {
  it('records event writes (first prev, last wrote) and restores what is still as the event left it', () => {
    const { physics, world } = setup();
    world.setBlock(0, 11, 0, B.BRICKS);
    world.setBlock(1, 11, 0, B.BRICKS);
    const ev = physics.beginEvent('explosion', { kind: 'explosion', x: 0, y: 11, z: 0 });
    physics.ctx.writeQuiet(0, 11, 0, B.AIR);
    physics.ctx.writeQuiet(1, 11, 0, B.AIR);
    physics.ctx.writeQuiet(1, 11, 0, B.GLASS); // second write to the same cell: still restored to BRICKS
    physics.endEvent();
    physics.ctx.write(5, 11, 5, B.STONE); // outside the event
    expect(ev.cells.get(packCell(1, 11, 0))).toBe(B.BRICKS * 256 + B.GLASS);
    expect(ev.cells.size).toBe(2);
    world.setBlock(0, 11, 0, B.DIRT); // the player changed it since: left alone
    expect(physics.canUndo).toBe(true);
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.restored).toBe(1);
    expect(res.message).toContain('changed since');
    expect(world.getBlock(1, 11, 0)).toBe(B.BRICKS);
    expect(world.getBlock(0, 11, 0)).toBe(B.DIRT);
    expect(world.getBlock(5, 11, 5)).toBe(B.STONE);
    expect(physics.undo().ok).toBe(false); // one level only
  });

  it("fallers remember their event: landings are recorded later; undo removes those still in flight", () => {
    const { physics, world } = setup();
    for (let y = 20; y < 23; y++) world.setBlock(0, y, 0, B.STONE);
    physics.beginEvent('collapse');
    physics.fallers.crumble([[0, 20, 0], [0, 21, 0], [0, 22, 0]]);
    physics.endEvent();
    expect(physics.fallers.count).toBe(3);
    for (let i = 0; i < 200 && physics.fallers.count > 0; i++) physics.step(1 / 60);
    expect([11, 12, 13].map((y) => world.getBlock(0, y, 0))).toEqual([B.STONE, B.STONE, B.STONE]);
    expect(physics.lastEvent.cells.has(packCell(0, 11, 0))).toBe(true);
    const res = physics.undo();
    expect(res.restored).toBe(6);
    expect([11, 12, 13, 20, 21, 22].map((y) => world.getBlock(0, y, 0))).toEqual([0, 0, 0, B.STONE, B.STONE, B.STONE]);
    // In flight: removed by undo, cells restored.
    physics.beginEvent('collapse');
    physics.fallers.crumble([[0, 20, 0]]);
    physics.endEvent();
    physics.step(1 / 60);
    expect(physics.fallers.count).toBe(1);
    const res2 = physics.undo();
    expect(res2.message).toContain('in flight');
    expect(physics.fallers.count).toBe(0);
    expect(world.getBlock(0, 20, 0)).toBe(B.STONE);
  });

  it('undo is refused when there is nothing to undo or the event is older than UNDO_WINDOW_S', () => {
    const { physics } = setup();
    expect(physics.undo()).toMatchObject({ ok: false });
    physics.beginEvent('tree');
    physics.endEvent();
    physics.setPaused(true); // time still advances
    physics.step(UNDO_WINDOW_S / 2);
    physics.step(UNDO_WINDOW_S / 2 + 1);
    expect(physics.canUndo).toBe(false);
    expect(physics.undo().message).toContain('too late');
  });

  it('withEvent / enterEvent only record into the current undoable event', () => {
    const { physics } = setup();
    const old = physics.beginEvent('collapse');
    physics.endEvent();
    physics.beginEvent('explosion');
    physics.endEvent();
    physics.withEvent(old.id, () => physics.ctx.write(0, 20, 0, B.STONE));
    expect(old.cells.size).toBe(0);
    physics.withEvent(physics.lastEvent, () => physics.ctx.write(1, 20, 0, B.STONE));
    expect(physics.lastEvent.cells.size).toBe(1);
  });
});

describe('save overlay', () => {
  it('drops flowing / falling water whose origin is AIR, saves any other as AIR, keeps sources', () => {
    const { world, physics } = setup();
    world.setBlock(0, 11, 0, B.WATER_FLOW_3); // origin AIR → dropped
    world.setBlock(1, 10, 0, B.WATER_FALL); // origin STONE → AIR
    world.setBlock(2, 11, 0, B.WATER); // source → kept
    const out = physics.exportEdits();
    const pairs = out['0,0'];
    const ids = new Map();
    for (let i = 0; i < pairs.length; i += 2) ids.set(pairs[i], pairs[i + 1]);
    expect([...ids.values()].sort()).toEqual([B.AIR, B.WATER].sort());
    expect(world.editCount).toBe(3); // the live world is untouched
  });

  it('peek reads the overlay first; set records into the exported edits across chunks', () => {
    const { world } = setup();
    const ov = new SaveOverlay(world);
    expect(ov.peek(0, 11, 0)).toBe(B.AIR);
    expect(ov.set(-1, 11, -1, B.SAND)).toBe(true);
    expect(ov.set(0, 500, 0, B.SAND)).toBe(false);
    expect(ov.peek(-1, 11, -1)).toBe(B.SAND);
    expect(world.getBlock(-1, 11, -1)).toBe(B.AIR);
    expect(Object.keys(ov.toJSON())).toEqual(['-1,-1']);
  });
});

describe('real World', () => {
  it('chunk-corner cells never starve: sand at every corner cell of a chunk falls while hundreds of updates are queued', () => {
    const { world, physics } = realWorld();
    // The two index-space corner cells (lq=15, lr=0) and (lq=0, lr=15) dirty FOUR chunks per write.
    const corners = [[15, 0], [0, 15], [16, -1], [-1, 16], [0, 0], [15, 15]];
    for (let i = 0; i < 600; i++) physics.schedule('misc', 40 + (i % 20), 30, Math.floor(i / 20));
    for (const [q, r] of corners) for (let y = 30; y < 33; y++) world.setBlock(q, y, r, B.SAND);
    for (let i = 0; i < 240; i++) {
      physics.step(1 / 60);
      world.update(0, 0, Infinity);
    }
    for (const [q, r] of corners) {
      expect([11, 12, 13, 14].map((y) => world.getBlock(q, y, r)), `${q},${r}`).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
    }
    expect(physics.fallers.count).toBe(0);
    // Physics writes are lazy: re-meshed by world.update's lazy pass, every chunk clean in the end.
    expect([...world.chunks.values()].filter((c) => c.dirty && c.meshed).length).toBe(0);
  });

  it('re-seeds a floating sand edit when its chunk streams back in', () => {
    const { world, physics } = realWorld();
    physics.setSwitch('falling', false);
    world.setBlock(3, 30, 3, B.SAND);
    physics.setSwitch('falling', true);
    const far = 100 * CHUNK_SIZE;
    converge(world, far, 0); // (0,0) unloads
    expect(world.getChunk(0, 0)).toBeUndefined();
    converge(world, 0, 0); // and comes back: onChunkGenerated re-seeds the edit
    expect(physics.isQueued('fall', 3, 30, 3)).toBe(true);
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    expect(world.getBlock(3, 11, 3)).toBe(B.SAND);
    expect(world.getBlock(3, 30, 3)).toBe(B.AIR);
  });

  it('statusText lists the switches and counters', () => {
    const { physics } = realWorld({ rd: 1 });
    physics.setSwitch('collapse', false);
    const t = physics.statusText();
    expect(t).toContain('collapse off');
    expect(t).toContain('queued 0');
    expect(t).toContain(`/ ${MAX_TOTAL_EDITS}`);
  });
});

describe('a queued fall survives a save and reload (FR-5: rings are not saved)', () => {
  /** Flat stone to y 10 with a NATURAL 3-high sand column at (2, 11..13, 2) (terrain height 13 there). */
  function sandWorldGen() {
    const flat = flatWorldGen(10);
    return {
      ...flat,
      generateChunk: (cq, cr) => {
        const d = flat.generateChunk(cq, cr);
        if (cq === 0 && cr === 0) {
          for (let y = 11; y <= 13; y++) d.blocks[localIndex(2, y, 2)] = B.SAND;
          d.heights[2 * CHUNK_SIZE + 2] = 13;
        }
        return d;
      },
    };
  }
  /** A converged World (+ physics, wired like main: physics before the first chunk) from `edits`. */
  function load(edits) {
    const world = new World({ seed: 1, renderDistance: 1, worldGen: sandWorldGen(), now: () => 0, edits });
    const physics = attachPhysics(world, BlockPhysics);
    converge(world);
    return { world, physics };
  }
  const column = (world) => [10, 11, 12, 13].map((y) => world.getBlock(2, y, 2));
  const run = (physics) => {
    for (let i = 0; i < 240; i++) physics.step(1 / 60);
  };

  it('natural sand over a cell the player just emptied falls after the reload (saved paused, or before the next tick)', () => {
    for (const paused of [true, false]) {
      const { world, physics } = load();
      expect(column(world)).toEqual([B.STONE, B.SAND, B.SAND, B.SAND]);
      expect(world.hasEdit(2, 11, 2)).toBe(false); // natural: no reseeder looks at it
      physics.setPaused(paused); // `physics off` still queues the trigger
      physics.asPlayer(() => world.setBlock(2, 10, 2, B.AIR));
      expect(physics.isQueued('fall', 2, 11, 2)).toBe(true);
      const saved = JSON.parse(JSON.stringify(physics.exportEdits())); // autosave / save & quit: the fall ring is lost
      const re = load(saved);
      expect(column(re.world), `paused ${paused}`).toEqual([B.AIR, B.SAND, B.SAND, B.SAND]);
      expect(re.physics.isQueued('fall', 2, 11, 2)).toBe(true); // re-seeded from the edited AIR below it
      run(re.physics);
      expect(column(re.world), `paused ${paused}`).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
      // …exactly where the live session puts it.
      physics.setPaused(false);
      run(physics);
      expect(column(world)).toEqual(column(re.world));
    }
  });

  it('an edited fall-through cell generated solid (dug out) re-seeds only a gravity block or campfire above it, and only while falling is on', () => {
    const { world, physics } = setup(); // natural stone for y ≤ 10
    for (const f of ['water', 'collapse']) physics.setSwitch(f, false); // only the gravity reseeder at work
    physics.setSwitch('falling', false);
    world.put(5, 11, 5, B.GRAVEL); // natural gravel, natural campfire (no edits) and a stone on top of the ground
    world.put(8, 11, 8, B.CAMPFIRE);
    world.put(7, 11, 7, B.STONE);
    world.put(9, 10, 9, B.AIR); // a natural cave cell under natural gravel…
    world.put(9, 11, 9, B.GRAVEL);
    world.setBlock(5, 10, 5, B.AIR); // dug out from under them while falling is off (the triggers are dropped)
    world.setBlock(8, 10, 8, B.WATER);
    world.setBlock(7, 10, 7, B.AIR);
    world.setBlock(9, 10, 9, B.WATER); // …that only changed to another fall-through id: no live trigger would fire
    expect(physics.queued()).toBe(0);
    world.unload(0, 0);
    world.load(0, 0);
    expect(physics.queued()).toBe(0); // reseeders follow the switches
    physics.setSwitch('falling', true);
    world.unload(0, 0);
    world.load(0, 0); // streaming back in / a reload
    expect(physics.isQueued('fall', 5, 11, 5)).toBe(true);
    expect(physics.isQueued('fall', 8, 11, 8)).toBe(true);
    expect(physics.isQueued('fall', 7, 11, 7)).toBe(false); // stone does not fall
    expect(physics.isQueued('fall', 9, 11, 9)).toBe(false); // generated fall-through below: nothing was dug out
    expect(physics.queued()).toBe(2);
    physics.tick();
    expect(world.getBlock(5, 11, 5)).toBe(B.AIR); // the gravel is falling
    expect(physics.fallers.count).toBe(1);
    expect(world.getBlock(8, 11, 8)).toBe(B.AIR); // the campfire over water broke
  });

  it('a source or campfire put in a natural cave under natural sand leaves the sand put: live, after a reload, after streaming back', () => {
    // FR-5 follow-up (review render-save-trees): the reseeder re-queued natural sand above ANY edited fall-through cell,
    // but the live trigger only fires when a cell BECOMES fall-through. Worldgen leaves natural sand resting on cave air;
    // a water source or campfire the player put under it never moved it live, yet a reload or a stream-in dropped it and
    // crushed what the player had put there (column 1,1,7,9,9 → 1,1,9,9,0 on seed 42).
    const flat = flatWorldGen(12);
    const caveGen = {
      ...flat,
      generateChunk: (cq, cr) => {
        const d = flat.generateChunk(cq, cr);
        if (cq === 0 && cr === 0) {
          d.blocks[localIndex(5, 9, 5)] = B.AIR; // a one-cell cave…
          d.blocks[localIndex(5, 10, 5)] = B.SAND; // …with natural sand resting on its air
          d.blocks[localIndex(5, 11, 5)] = B.SAND;
        }
        return d;
      },
    };
    const make = (edits) => {
      const world = new World({ seed: 1, renderDistance: 1, worldGen: caveGen, now: () => 0, edits });
      const physics = attachPhysics(world, BlockPhysics);
      converge(world);
      return { world, physics };
    };
    const cave = (world) => [8, 9, 10, 11, 12].map((y) => world.getBlock(5, y, 5));
    for (const put of [B.WATER, B.CAMPFIRE]) {
      const live = make();
      expect(cave(live.world)).toEqual([B.STONE, B.AIR, B.SAND, B.SAND, B.STONE]);
      live.physics.asPlayer(() => live.world.setBlock(5, 9, 5, put));
      run(live.physics);
      const want = [B.STONE, put, B.SAND, B.SAND, B.STONE];
      expect(cave(live.world), `live ${put}`).toEqual(want);
      const re = make(JSON.parse(JSON.stringify(live.physics.exportEdits())));
      expect(re.physics.isQueued('fall', 5, 10, 5), `reload ${put}`).toBe(false);
      run(re.physics);
      expect(cave(re.world), `reload ${put}`).toEqual(want);
      converge(live.world, 100 * CHUNK_SIZE, 0); // streamed out…
      expect(live.world.getChunk(0, 0)).toBeUndefined();
      converge(live.world, 0, 0); // …and back in
      run(live.physics);
      expect(cave(live.world), `stream-in ${put}`).toEqual(want);
    }
  });
});
