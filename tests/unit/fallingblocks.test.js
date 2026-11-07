// Unit tests for src/fallingblocks.js — column fallers, tumblers, the gravity and campfire rules, landing rules (never
// bury a body), saving into a copy, undo hooks (CONTRACTS §34). Fake world from the fixtures unless a real World matters.
import { describe, it, expect } from 'vitest';
import { MAX_FALLING, MAX_TUMBLING, TERMINAL_VELOCITY, PIG_RADIUS, PIG_HEIGHT, MAX_TOTAL_EDITS } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { createPlayer, createBody } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { GRAVITY_RULE_IDS } from '../../src/fallingblocks.js';
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
  it('reacts to sand, red sand, gravel and the campfire', () => {
    expect([...GRAVITY_RULE_IDS].sort()).toEqual([B.SAND, B.GRAVEL, B.RED_SAND, B.CAMPFIRE].sort());
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
