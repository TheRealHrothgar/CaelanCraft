// Unit tests for src/fallingblocks.js — column fallers, tumblers, the gravity and campfire rules, landing rules (never
// bury a body), saving into a copy, undo hooks (CONTRACTS §34). Fake world from the fixtures unless a real World matters.
import { describe, it, expect } from 'vitest';
import { MAX_FALLING, MAX_TUMBLING, TERMINAL_VELOCITY, PIG_RADIUS, PIG_HEIGHT, MAX_TOTAL_EDITS } from '../../src/config.js';
import { BLOCK, POP_OFF_IDS } from '../../src/blocks.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { createPlayer, createBody } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { GRAVITY_RULE_IDS, liftFreeY, popOffEffect } from '../../src/fallingblocks.js';
import { createWorldGen } from '../../src/worldgen.js';
import { findStandingY } from '../../src/physics.js';
import { makeFakeWorld, attachPhysics, flatWorldGen, trivialWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // solid for y ≤ 10

function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? GROUND });
  const fx = { particles: [], sounds: [] };
  const hooks = {
    particles: (kind, x, y, z, count, o) => fx.particles.push({ kind, x, y, z, count, o }),
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    ...opts.hooks,
  };
  const physics = attachPhysics(world, BlockPhysics, hooks);
  return { world, physics, fx };
}

/** Step until no faller is left (or a frame cap). @returns {number} frames */
function settle(physics, dt = 1 / 60, max = 2000) {
  let n = 0;
  physics.step(dt);
  while ((physics.fallers.count > 0 || physics.queued() > 0) && n < max) {
    physics.step(dt);
    n++;
  }
  return n;
}

const column = (world, q, r, y0, y1) => {
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(world.getBlock(q, y, r));
  return out;
};

describe('gravity rule', () => {
  it('reacts to sand, red sand, gravel and every pop-off block (the campfire first)', () => {
    expect([...GRAVITY_RULE_IDS]).toEqual([B.SAND, B.RED_SAND, B.GRAVEL, B.FLINT_GRAVEL, ...POP_OFF_IDS]);
    expect(POP_OFF_IDS[0]).toBe(B.CAMPFIRE);
    expect(Object.isFrozen(GRAVITY_RULE_IDS)).toBe(true);
  });

  it('a sand column drops TOGETHER (one tick, same speed) and lands in order', () => {
    const { world, physics } = setup();
    const ids = [B.SAND, B.GRAVEL, B.RED_SAND, B.SAND, B.GRAVEL];
    world.setBlock(0, 19, 0, B.STONE);
    ids.forEach((id, i) => world.setBlock(0, 20 + i, 0, id));
    world.setBlock(0, 19, 0, B.AIR); // knock the support out
    physics.tick();
    expect(physics.fallers.count).toBe(5);
    const fallers = [0, 1, 2, 3, 4].map((i) => physics.fallers.faller(i)).sort((a, b) => a.y - b.y);
    expect(fallers.map((f) => f.y)).toEqual([20, 21, 22, 23, 24]);
    expect(fallers.map((f) => f.id)).toEqual(ids);
    expect(column(world, 0, 0, 20, 24).every((id) => id === B.AIR)).toBe(true);
    physics.fallers.step(0.1);
    const after = [0, 1, 2, 3, 4].map((i) => physics.fallers.faller(i)).sort((a, b) => a.y - b.y);
    expect(new Set(after.map((f) => f.vy)).size).toBe(1); // lockstep
    settle(physics);
    expect(column(world, 0, 0, 11, 16)).toEqual([...ids, B.AIR]);
    expect(physics.fallers.count).toBe(0);
  });

  it('sand on solid ground stays; over a water source, flowing water or a campfire it falls (and sinks)', () => {
    const { world, physics } = setup();
    world.setBlock(0, 11, 0, B.SAND);
    world.put(1, 11, 0, B.WATER);
    world.setBlock(1, 12, 0, B.SAND);
    world.put(2, 11, 0, B.WATER_FLOW_2);
    world.setBlock(2, 12, 0, B.SAND);
    world.put(3, 11, 0, B.CAMPFIRE);
    world.setBlock(3, 12, 0, B.GRAVEL);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(world.getBlock(1, 11, 0)).toBe(B.SAND); // v0.8 water (CONTRACTS §35.6): sank through the source
    expect(world.getBlock(1, 12, 0)).toBe(B.AIR);
    expect(world.getBlock(2, 11, 0)).toBe(B.SAND); // fell through flowing water and replaced it
    expect(world.getBlock(3, 11, 0)).toBe(B.GRAVEL); // crushed the campfire
    expect(world.getBlock(3, 12, 0)).toBe(B.AIR);
  });

  it('a campfire over a fall-through cell breaks with a puff of smoke', () => {
    const { world, physics, fx } = setup();
    world.setBlock(0, 20, 0, B.CAMPFIRE);
    physics.tick();
    expect(world.getBlock(0, 20, 0)).toBe(B.AIR);
    expect(physics.fallers.count).toBe(0);
    expect(fx.particles.some((p) => p.kind === 'smoke')).toBe(true);
    expect(fx.sounds.some((s) => s.name === 'break:wood')).toBe(true);
  });

  it('does nothing while falling is switched off (and its queued updates are skipped)', () => {
    const { world, physics } = setup();
    world.setBlock(0, 20, 0, B.SAND);
    physics.setSwitch('falling', false);
    physics.tick();
    expect(world.getBlock(0, 20, 0)).toBe(B.SAND);
  });
});

describe('pop-off blocks (DESIGN-survival §8.5)', () => {
  const PLANTS = [B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE, B.TUSSOCK, B.CATTAILS, B.TUBER_PLANT, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE];

  it('a plant, litter or a fire pit pops when the dirt below it is removed; nothing drops, nothing falls', () => {
    for (const id of POP_OFF_IDS) {
      const { world, physics, fx } = setup();
      world.setBlock(2, 11, 2, B.DIRT);
      world.setBlock(2, 12, 2, id);
      settle(physics);
      expect(world.getBlock(2, 12, 2), `id ${id} on dirt`).toBe(id); // resting on solid ground
      world.setBlock(2, 11, 2, B.AIR); // dig the dirt out
      expect(physics.isQueued('fall', 2, 12, 2)).toBe(true);
      physics.tick();
      expect(world.getBlock(2, 12, 2), `id ${id}`).toBe(B.AIR);
      expect(world.getBlock(2, 11, 2)).toBe(B.AIR); // it did not fall into the hole
      expect(physics.fallers.count).toBe(0);
      expect(physics.fallers.tumblerCount).toBe(0);
      expect(fx.particles.length).toBe(1);
      expect(fx.sounds.length).toBe(1);
    }
  });

  it('each kind pops with its own puff: plants leaves (prickly pear green dust), stones grey dust, branches wood, campfire smoke', () => {
    const want = (id) => {
      if (id === B.CAMPFIRE) return { kind: 'smoke', count: 10, sound: 'break:wood' };
      if (id === B.PRICKLY_PEAR || id === B.PRICKLY_PEAR_BARE) return { kind: 'dust', count: 4, sound: 'break:leaves' };
      if (PLANTS.includes(id)) return { kind: 'leaves', count: 6, sound: 'break:leaves' };
      if (id === B.FALLEN_BRANCHES) return { kind: 'dust', count: 4, sound: 'break:wood' };
      return { kind: 'dust', count: 4, sound: 'break:stone' }; // LOOSE_STONES, FIRE_PIT
    };
    for (const id of POP_OFF_IDS) {
      const { world, physics, fx } = setup();
      world.setBlock(-3, 20, 5, id); // floating: queued at once
      physics.tick();
      expect(world.getBlock(-3, 20, 5)).toBe(B.AIR);
      const w = want(id);
      const [x, z] = hexToWorld(-3, 5);
      expect(fx.particles.length, `id ${id}`).toBe(1);
      const p = fx.particles[0];
      expect([p.kind, p.count], `id ${id}`).toEqual([w.kind, w.count]);
      expect(p.x).toBeCloseTo(x, 9);
      expect(p.z).toBeCloseTo(z, 9);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThan(21);
      expect(fx.sounds.map((s) => s.name), `id ${id}`).toEqual([w.sound]);
      expect(popOffEffect(id)).toMatchObject({ kind: w.kind, count: w.count, sound: w.sound });
      if (id === B.CAMPFIRE) {
        expect(p.o).toBeUndefined(); // the campfire's puff is unchanged
      } else {
        // An explicit colour: the short plants' and litter's top tile is clear, so a block-id colour would be black.
        expect(p.o.color).toHaveLength(3);
        for (const c of p.o.color) {
          expect(c).toBeGreaterThan(0.1);
          expect(c).toBeLessThan(0.9);
        }
        if (w.kind === 'leaves' || id === B.PRICKLY_PEAR) expect(p.o.color[1]).toBeGreaterThan(p.o.color[2]); // green
      }
    }
  });

  it('a pop-off block over water, flowing water, a campfire or air pops; over leaves, glass, a plant or sand it stays', () => {
    const { world, physics } = setup();
    const under = [B.WATER, B.WATER_FLOW_3, B.CAMPFIRE, B.AIR, B.OAK_LEAVES, B.GLASS, B.TUSSOCK, B.SAND];
    under.forEach((u, i) => {
      world.put(i * 3, 11, 0, u);
      world.setBlock(i * 3, 12, 0, B.HONEYBERRY_BUSH);
    });
    for (let i = 0; i < 30; i++) physics.step(1 / 60);
    under.forEach((u, i) => {
      const fallThrough = [B.WATER, B.WATER_FLOW_3, B.CAMPFIRE, B.AIR].includes(u);
      expect(world.getBlock(i * 3, 12, 0), `bush over ${u}`).toBe(fallThrough ? B.AIR : B.HONEYBERRY_BUSH);
    });
  });

  it('pop-off blocks are not fall-through: sand dropped on a tussock rests on it, and a stack of plants pops from the bottom up', () => {
    const { world, physics } = setup();
    world.setBlock(0, 11, 0, B.TUSSOCK);
    world.setBlock(0, 18, 0, B.SAND); // falls and lands on the tussock
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.TUSSOCK);
    expect(world.getBlock(0, 12, 0)).toBe(B.SAND);
    // A column of plants on dirt: taking the dirt pops the lowest, then the next, one tick each.
    world.setBlock(4, 11, 4, B.DIRT);
    for (let y = 12; y <= 14; y++) world.setBlock(4, y, 4, PLANTS[y - 12]);
    settle(physics);
    expect([12, 13, 14].map((y) => world.getBlock(4, y, 4))).toEqual(PLANTS.slice(0, 3));
    world.setBlock(4, 11, 4, B.AIR);
    physics.tick();
    expect([12, 13, 14].map((y) => world.getBlock(4, y, 4))).toEqual([B.AIR, PLANTS[1], PLANTS[2]]);
    settle(physics);
    expect([12, 13, 14].map((y) => world.getBlock(4, y, 4))).toEqual([B.AIR, B.AIR, B.AIR]);
  });

  it('a campfire still breaks the same way, and the stations / containers never pop', () => {
    const { world, physics } = setup();
    for (const [i, id] of [B.WORK_STUMP, B.KILN, B.BLOOMERY, B.FORGE, B.WICKER_BASKET, B.SLEEPING_HIDE, B.REMAINS].entries()) {
      world.setBlock(i * 2, 20, 0, id);
    }
    world.setBlock(30, 20, 0, B.CAMPFIRE);
    settle(physics);
    for (const [i, id] of [B.WORK_STUMP, B.KILN, B.BLOOMERY, B.FORGE, B.WICKER_BASKET, B.SLEEPING_HIDE, B.REMAINS].entries()) {
      expect(world.getBlock(i * 2, 20, 0), `id ${id}`).toBe(id);
    }
    expect(world.getBlock(30, 20, 0)).toBe(B.AIR);
  });

  it('switched off, pop-off blocks float (the trigger is dropped and never replayed)', () => {
    const { world, physics } = setup();
    physics.setSwitch('falling', false);
    world.setBlock(1, 20, 1, B.LOOSE_STONES);
    physics.setSwitch('falling', true);
    settle(physics);
    expect(world.getBlock(1, 20, 1)).toBe(B.LOOSE_STONES);
  });
});

describe('column fallers', () => {
  it('swept: never tunnels through a one-cell platform at 10 fps (terminal velocity 60 m/s)', () => {
    const { world, physics } = setup();
    world.setBlock(3, 50, 3, B.GLASS); // a thin platform high above the ground
    physics.fallers.spawn(B.SAND, 3, 120, 3);
    let maxSpeed = 0;
    for (let i = 0; i < 60 && physics.fallers.count > 0; i++) {
      physics.fallers.step(0.1);
      const f = physics.fallers.faller(0);
      if (f) maxSpeed = Math.max(maxSpeed, -f.vy);
    }
    expect(maxSpeed).toBeGreaterThan(-TERMINAL_VELOCITY * 0.6); // well over several cells per frame
    expect(world.getBlock(3, 51, 3)).toBe(B.SAND);
    expect(column(world, 3, 3, 11, 49).every((id) => id === B.AIR)).toBe(true);
  });

  it('a block that appears inside a falling block makes it rest on top of it', () => {
    const { world, physics } = setup();
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    physics.fallers.step(0.05);
    const y = physics.fallers.faller(0).y; // a little below 30
    world.setBlock(0, Math.floor(y), 0, B.STONE);
    physics.fallers.step(0.05);
    expect(world.getBlock(0, Math.floor(y) + 1, 0)).toBe(B.SAND);
  });

  it('falls out of the world below y = 0 (removed, nothing placed)', () => {
    const world = new World({ seed: 1, renderDistance: 1, worldGen: trivialWorldGen(), now: () => 0 });
    let r;
    do r = world.update(0, 0, Infinity);
    while (r.pendingGen || r.pendingMesh);
    const physics = attachPhysics(world, BlockPhysics);
    world.setBlock(0, 5, 0, B.SAND);
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    expect(physics.fallers.count).toBe(0);
    for (let y = 0; y < 10; y++) expect(world.getBlock(0, y, 0)).toBe(B.AIR);
  });

  it('freezes while its column is unloaded', () => {
    const { world, physics } = setup();
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    world.unload(0, 0);
    physics.fallers.step(0.1);
    expect(physics.fallers.faller(0).y).toBe(30);
  });

  it('one thud per frame, at the landing nearest the player; dust in the block colour', () => {
    const { physics, fx } = setup({ hooks: { player: () => ({ x: 4, y: 11, z: 0 }) } });
    physics.fallers.spawn(B.SAND, 0, 11, 0);
    physics.fallers.spawn(B.GRAVEL, 4, 11, 0);
    physics.fallers.step(0.02);
    const thuds = fx.sounds.filter((s) => s.name === 'thud');
    expect(thuds.length).toBe(1);
    expect(thuds[0].x).toBeCloseTo(4);
    expect(fx.particles.filter((p) => p.kind === 'dust').map((p) => p.o.id).sort()).toEqual([B.SAND, B.GRAVEL].sort());
  });

  it('beyond MAX_FALLING the lowest cells of a crumble settle instantly and the top ones animate', () => {
    const { world, physics } = setup();
    // 2 columns of 520 cells would not fit: build 33 columns × 32 cells (1056 > 1024).
    const cells = [];
    for (let c = 0; c < 33; c++) for (let y = 40; y < 72; y++) {
      world.put(c, y, 5, B.STONE);
      cells.push([c, y, 5]);
    }
    physics.fallers.crumble(cells);
    expect(physics.fallers.count).toBe(MAX_FALLING);
    // 32 lowest cells (by y, ties by q) were dropped at once: the y = 40 layer is on the ground already.
    let onGround = 0;
    for (let c = 0; c < 33; c++) if (world.getBlock(c, 11, 5) === B.STONE) onGround++;
    expect(onGround).toBe(1056 - MAX_FALLING);
    settle(physics);
    for (let c = 0; c < 33; c++) expect(column(world, c, 5, 11, 43)).toEqual([...Array(32).fill(B.STONE), B.AIR]);
  });
});

describe('landing never buries a body', () => {
  /** Player standing in column (0, 0) near its east edge so the body overlaps cell (1, 0) too. */
  function standing() {
    const [x, z] = hexToWorld(0, 0);
    return createPlayer(x + 0.3, GROUND + 1 + 1e-5, z);
  }

  it('a block landing in the player\'s cell lifts the player on top of it', () => {
    let p;
    const { world, physics } = setup({ hooks: { bodies: () => [p], player: () => p } });
    p = standing();
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(p.y).toBe(12);
  });

  it('reports the lift through hooks.lifted(body, cells), so main can deal crush damage (§2.4; play-test: the lift happened inside the step and unstickPlayer never saw it)', () => {
    let p;
    const lifted = [];
    const { world, physics } = setup({ hooks: { bodies: () => [p], player: () => p, lifted: (b, cells) => lifted.push([b, cells]) } });
    p = standing();
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(lifted).toEqual([[p, 1]]);
    // more sand on the same column: one lift per landing
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    physics.fallers.spawn(B.GRAVEL, 0, 32, 0);
    settle(physics);
    expect(p.y).toBe(14);
    expect(lifted.map(([, c]) => c)).toEqual([1, 1, 1]);
    // the default hook is a no-op (the hook is optional)
    const other = setup({ hooks: { bodies: () => [p], player: () => p } });
    p = standing();
    other.physics.fallers.spawn(B.SAND, 0, 30, 0);
    expect(() => settle(other.physics)).not.toThrow();
  });

  it('with no room to lift the player the block breaks into dust instead', () => {
    let p;
    const { world, physics, fx } = setup({ hooks: { bodies: () => [p], player: () => p } });
    p = standing();
    // The player also overlaps column (1, 0): a wall there from y 12 up leaves no free height within 3 cells.
    for (let y = 12; y <= 17; y++) world.setBlock(1, y, 0, B.STONE);
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(p.y).toBeCloseTo(GROUND + 1, 3);
    expect(fx.particles.some((e) => e.kind === 'dust' && e.o.id === B.SAND)).toBe(true);
    expect(fx.sounds.some((s) => s.name === 'thud')).toBe(false);
  });

  it('never lifts a body up through a solid roof: under a 1- or 2-thick roof the block breaks instead (play-test SAND-1)', () => {
    for (const thick of [1, 2]) {
      let p;
      const { world, physics, fx } = setup({ hooks: { bodies: () => [p], player: () => p } });
      p = standing(); // feet at y 11 in column (0, 0), overlapping (1, 0)
      // A 2-high room: a stone roof over both columns from y 13, `thick` cells thick.
      for (const [q, r] of [[0, 0], [1, 0]]) for (let y = 13; y < 13 + thick; y++) world.setBlock(q, y, r, B.STONE);
      physics.fallers.spawn(B.SAND, 1, 12, 0); // into the neighbour column at the feet level
      settle(physics);
      expect(p.y, `thick ${thick}`).toBeCloseTo(GROUND + 1, 3); // was lifted to y 14 / 15, on top of the roof
      expect(world.getBlock(1, 11, 0)).toBe(B.AIR);
      expect(fx.particles.some((e) => e.kind === 'dust' && e.o.id === B.SAND)).toBe(true);
    }
  });
  it('liftFreeY: the first free height going straight up, or null when a solid is in the way', () => {
    const p = createPlayer(0, GROUND + 1, 0); // feet 11, height 1.8
    const roofAt = (h) => (_q, y) => (y <= GROUND || y === h ? B.STONE : B.AIR);
    expect(liftFreeY((_q, y) => (y <= GROUND ? B.STONE : B.AIR), p, 3)).toBe(12); // open sky
    expect(liftFreeY(roofAt(14), p, 3)).toBe(12); // 12 … 13.8 clears a roof at 14
    expect(liftFreeY(roofAt(13), p, 3)).toBeNull(); // the head would enter the roof: never lifted through to 14
    // A block already inside the body (one that landed in its head cell) is not in the way: the body pops on top of it.
    expect(liftFreeY(roofAt(12), p, 3)).toBe(13);
  });
  it('pigs are lifted with their own size', () => {
    let pig;
    const { physics } = setup({ hooks: { bodies: () => [pig] } });
    const [x, z] = hexToWorld(2, 2);
    pig = createBody(x, GROUND + 1, z, { radius: PIG_RADIUS, height: PIG_HEIGHT });
    physics.fallers.spawn(B.GRAVEL, 2, 25, 2);
    settle(physics);
    expect(pig.y).toBe(12);
  });

  it("a refused landing write ('capped') breaks the block too", () => {
    const { world, physics, fx } = setup();
    physics.fallers.spawn(B.SAND, 0, 20, 0);
    world.editCount = MAX_TOTAL_EDITS;
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(fx.particles.some((e) => e.kind === 'dust')).toBe(true);
  });
});

describe('saving settles fallers into a copy', () => {
  it('exportEdits writes each faller at its landing cell without touching the live world', () => {
    const world = new World({ seed: 1, renderDistance: 1, worldGen: flatWorldGen(GROUND), now: () => 0 });
    let r;
    do r = world.update(0, 0, Infinity);
    while (r.pendingGen || r.pendingMesh);
    const physics = attachPhysics(world, BlockPhysics);
    for (let y = 30; y < 33; y++) world.setBlock(2, y, 2, B.SAND);
    physics.step(1 / 60);
    physics.step(1 / 60);
    physics.step(1 / 60); // first tick: three fallers
    for (let i = 0; i < 5; i++) physics.step(1 / 60);
    expect(physics.fallers.count).toBe(3);
    const before = { version: world.editVersion, edits: JSON.stringify(world.exportEdits()), count: world.editCount };
    const saved = physics.exportEdits();
    expect(world.editVersion).toBe(before.version);
    expect(JSON.stringify(world.exportEdits())).toBe(before.edits);
    expect(world.editCount).toBe(before.count);
    expect(physics.fallers.count).toBe(3);
    // A world loaded from the save has the sand where the fallers land.
    const w2 = new World({ seed: 1, renderDistance: 1, worldGen: flatWorldGen(GROUND), now: () => 0, edits: saved });
    do r = w2.update(0, 0, Infinity);
    while (r.pendingGen || r.pendingMesh);
    expect(column(w2, 2, 2, 11, 14)).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
    for (let y = 30; y < 33; y++) expect(w2.getBlock(2, y, 2)).toBe(B.AIR);
    // …and the live simulation lands them in the same cells.
    settle(physics);
    expect(column(world, 2, 2, 11, 14)).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
  });
});

describe('tumblers', () => {
  it('debris flies, spins and vanishes in a puff of dust when it lands; persistent ones stay', () => {
    const { physics, fx } = setup();
    const [x, z] = hexToWorld(0, 0);
    const debris = physics.fallers.spawnTumbler(B.STONE, x, 15, z, 3, 6, 0, { spin: [4, 0, 2] });
    const barrel = physics.fallers.spawnTumbler(B.BLAST_BARREL, x + 5, 15, z, 0, 0, 0, { persistent: true });
    expect(physics.fallers.tumblerCount).toBe(2);
    let maxY = 0;
    for (let i = 0; i < 300 && physics.fallers.tumblers.includes(debris); i++) {
      physics.step(1 / 60);
      maxY = Math.max(maxY, debris.body.y);
    }
    expect(maxY).toBeGreaterThan(15.5);
    expect(physics.fallers.tumblers.includes(debris)).toBe(false);
    expect(debris.rx).not.toBe(0);
    expect(fx.particles.some((p) => p.kind === 'dust' && p.o.id === B.STONE)).toBe(true);
    expect(physics.fallers.tumblers.includes(barrel)).toBe(true);
    expect(barrel.body.y).toBeCloseTo(GROUND + 1, 3);
    expect(barrel.body.onGround).toBe(true);
    expect(physics.fallers.removeTumbler(barrel)).toBe(true);
  });

  it('fast debris does not tunnel through a one-cell wall (substeps)', () => {
    const { world, physics } = setup();
    for (let y = 11; y < 16; y++) world.setBlock(3, y, 0, B.STONE);
    const [x, z] = hexToWorld(0, 0);
    const t = physics.fallers.spawnTumbler(B.DIRT, x, 12, z, 60, 0, 0);
    physics.fallers.step(0.1);
    const [wx] = hexToWorld(3, 0);
    expect(t.body.x).toBeLessThan(wx);
  });

  it('caps at MAX_TUMBLING (callers turn the rest into dust)', () => {
    const { physics } = setup();
    for (let i = 0; i < MAX_TUMBLING; i++) expect(physics.fallers.spawnTumbler(B.STONE, i, 30, 0)).not.toBeNull();
    expect(physics.fallers.spawnTumbler(B.STONE, 0, 30, 5)).toBeNull();
  });
});

describe('rendering items and undo hooks', () => {
  it('pushes fallers at their cell centre and tumblers at their body centre with rotation and scale', () => {
    const { physics } = setup();
    physics.fallers.spawn(B.SAND, 2, 30, 1);
    const t = physics.fallers.spawnTumbler(B.BLAST_BARREL, 1, 20, 1, 0, 0, 0, { persistent: true });
    t.ry = 0.5;
    t.scale = 1.04;
    const list = physics.renderItems();
    expect(list.count).toBe(2);
    const [x, z] = hexToWorld(2, 1);
    expect(list.items[0]).toMatchObject({ id: B.SAND, y: 30.5, rx: 0, scale: 1 });
    expect(list.items[0].x).toBeCloseTo(x);
    expect(list.items[0].z).toBeCloseTo(z);
    expect(list.items[1]).toMatchObject({ id: B.BLAST_BARREL, x: 1, z: 1, ry: 0.5, scale: 1.04 });
    expect(list.items[1].y).toBeCloseTo(20 + 0.49);
    expect(physics.renderItems().items).toBe(list.items); // pooled
  });

  it('cancelEvent removes the event\'s fallers and debris but not persistent tumblers', () => {
    const { physics } = setup();
    const ev = physics.beginEvent('explosion');
    physics.fallers.spawn(B.SAND, 0, 30, 0);
    physics.fallers.spawnTumbler(B.STONE, 0, 30, 0);
    physics.fallers.spawnTumbler(B.BLAST_BARREL, 0, 30, 0, 0, 0, 0, { persistent: true });
    physics.endEvent();
    physics.fallers.spawn(B.SAND, 5, 30, 0); // no event
    expect(physics.fallers.cancelEvent(ev.id)).toBe(2);
    expect(physics.fallers.count).toBe(1);
    expect(physics.fallers.tumblerCount).toBe(1);
    expect(physics.fallers.cancelEvent(0)).toBe(0);
  });
});

describe('real worldgen (seed 42)', () => {
  it('a sand column dropped onto the standing player lands under them: the player rides up, nothing is lost', () => {
    const world = new World({ seed: 42, renderDistance: 2, worldGen: createWorldGen(42), now: () => 0 });
    const [sx, , sz] = world.findSpawn();
    let r;
    do r = world.update(sx, sz, Infinity);
    while (r.pendingGen || r.pendingMesh);
    const fy = findStandingY(world.getBlock, sx, sz, 120);
    const player = createPlayer(sx, fy, sz);
    const physics = attachPhysics(world, BlockPhysics, { bodies: () => [player], player: () => player });
    const [pq, pr] = worldToHex(sx, sz); // the spawn is a cell centre
    const top = fy + 8;
    for (let y = top; y < top + 4; y++) world.setBlock(pq, y, pr, B.SAND);
    for (let i = 0; i < 300 && (physics.fallers.count > 0 || physics.queued() > 0 || i < 5); i++) {
      physics.step(1 / 60);
      world.update(player.x, player.z, Infinity);
    }
    let sand = 0;
    for (let y = fy; y < top + 4; y++) if (world.getBlock(pq, y, pr) === B.SAND) sand++;
    expect(sand).toBe(4);
    expect(world.getBlock(pq, fy, pr)).toBe(B.SAND);
    expect(player.y).toBe(fy + 4); // lifted onto the pile, never inside it
  });
});
