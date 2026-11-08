// Unit tests for src/support.js — the support search (lowest-y-first multi-source DFS, shared memo, natural-ground
// anchors, visit budget and resumable search), the disconnected-by-this-removal rule and the collapse itself (crumble,
// rune blocks staying put, hanging leaves, the first-collapse tip, undo) (CONTRACTS §36.1–§36.2). Map-backed fake
// world from the fixtures; a real World where natural ground / streaming matters.
import { describe, it, expect } from 'vitest';
import { SUPPORT_LIMIT, MAX_SUPPORT_VISITS_PER_TICK } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { HEX_DIRS, hexToWorld } from '../../src/hex.js';
import { createPlayer, playerIntersectsBlock } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { COLLAPSE_TIP, peekNeighbours } from '../../src/support.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural ground for y ≤ 10

function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? GROUND, groundId: opts.groundId, now: opts.now });
  const said = [];
  const fx = { sounds: [], particles: [] };
  const hooks = {
    say: (t) => said.push(t),
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, count, o) => fx.particles.push({ kind, x, y, z, count, o }),
    ...opts.hooks,
  };
  const physics = attachPhysics(world, BlockPhysics, hooks, opts.physicsOpts);
  return { world, physics, said, fx };
}

/** A converged real World (flat terrain of `id` up to GROUND) with physics attached. */
function realWorld(opts = {}) {
  const world = new World({ seed: 1, renderDistance: opts.rd ?? 2, worldGen: flatWorldGen(GROUND, opts.id ?? B.STONE), now: () => 0 });
  const physics = attachPhysics(world, BlockPhysics, opts.hooks ?? {});
  for (let i = 0; i < 500; i++) {
    const r = world.update(opts.px ?? 0, opts.pz ?? 0, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) break;
  }
  return { world, physics };
}

const idle = (p) => p.fallers.count === 0 && p.queued() === 0 && p.seeds.size === 0 && !p.support.busy &&
  p.trees.count === 0 && p.trees.decayCount === 0;

/** Step frames until nothing is pending (or a cap). @returns {number} frames */
function settle(physics, max = 3000) {
  let n = 0;
  physics.step(1 / 60);
  while (!idle(physics) && n < max) {
    physics.step(1 / 60);
    n++;
  }
  return n;
}

/** Put `id` in every cell of the list (as edits, through the hooks). */
function build(world, cells, id = B.STONE) {
  for (const [q, y, r] of cells) world.setBlock(q, y, r, id);
}

/** Cells holding `id` in the box. */
function count(world, id, q0, q1, y0, y1, r0, r1) {
  let n = 0;
  for (let q = q0; q <= q1; q++) for (let y = y0; y <= y1; y++) for (let r = r0; r <= r1; r++) if (world.getBlock(q, y, r) === id) n++;
  return n;
}

/** A bridge: pillars of stone at q = 0 and q = 8 (y 11..14), a plank deck at y = 15 from q 0..8 (r = 0). */
function bridge(world) {
  for (let y = 11; y <= 14; y++) {
    world.setBlock(0, y, 0, B.STONE);
    world.setBlock(8, y, 0, B.STONE);
  }
  for (let q = 0; q <= 8; q++) world.setBlock(q, 15, 0, B.OAK_PLANKS);
}

describe('collapse: the disconnected-by-this-removal rule', () => {
  it('a pillar-supported bridge stands on one pillar and crumbles when its last pillar is removed', () => {
    const { world, physics, said } = setup();
    bridge(world);
    physics.asPlayer(() => world.setBlock(0, 12, 0, B.AIR)); // one pillar cut: still held by the other
    settle(physics);
    expect(physics.support.stats.crumbled).toBe(0);
    expect(world.getBlock(4, 15, 0)).toBe(B.OAK_PLANKS);
    expect(world.getBlock(0, 13, 0)).toBe(B.STONE); // the pillar stub hangs from the deck

    physics.asPlayer(() => world.setBlock(8, 12, 0, B.AIR)); // the last pillar
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
    expect(said).toContain(COLLAPSE_TIP);
    expect(physics.lastEvent.kind).toBe('collapse');
    expect(count(world, B.OAK_PLANKS, 0, 8, 15, 15, 0, 0)).toBe(0);
    settle(physics);
    // Everything landed: 9 planks + the two pillar stubs (2 cells each) on the ground or the pillar bases.
    expect(count(world, B.OAK_PLANKS, -1, 9, 11, 20, -1, 1)).toBe(9);
    expect(count(world, B.STONE, -1, 9, 11, 20, -1, 1)).toBe(2 + 4);
    expect(world.getBlock(0, 11, 0)).toBe(B.STONE); // the pillar base stayed
    expect([12, 13].map((y) => world.getBlock(0, y, 0))).toEqual([B.STONE, B.STONE]); // the stub landed on it
    expect(world.getBlock(0, 14, 0)).toBe(B.OAK_PLANKS); // and the deck's end on that
    expect(world.getBlock(4, 11, 0)).toBe(B.OAK_PLANKS); // the middle of the deck lies on the ground
    expect(said.filter((t) => t === COLLAPSE_TIP)).toHaveLength(1);
  });

  it('a build that already floated (placed in mid-air, e.g. by fill) does NOT crumble when one of its blocks is broken', () => {
    const { world, physics } = setup();
    const platform = [];
    for (let q = 0; q < 6; q++) for (let r = 0; r < 6; r++) platform.push([q, 30, r]);
    build(world, platform, B.COBBLESTONE); // placement never checks support
    build(world, [[2, 31, 2], [2, 32, 2], [3, 31, 3]], B.OAK_PLANKS);
    physics.asPlayer(() => world.setBlock(2, 30, 2, B.AIR)); // a hole in the middle
    physics.asPlayer(() => world.setBlock(0, 30, 3, B.AIR));
    for (let q = 0; q < 6; q++) physics.asPlayer(() => world.setBlock(q, 30, 4, B.AIR)); // cut it in two
    settle(physics);
    expect(physics.support.stats.floating).toBeGreaterThan(0); // the search did find it floating …
    expect(physics.support.stats.crumbled).toBe(0); // … and left it alone
    expect(physics.fallers.count).toBe(0);
    expect(count(world, B.COBBLESTONE, 0, 5, 30, 30, 0, 5)).toBe(36 - 8);
    expect(world.getBlock(2, 32, 2)).toBe(B.OAK_PLANKS); // the plank on the hole's rim stays too
  });

  it('an area batch (several cuts at once) brings down every part that was held through the cut cells', () => {
    let active = true;
    const { world, physics } = setup({ hooks: { areaJobsActive: () => active } });
    bridge(world);
    // One command removes the whole pillar at q = 8, a deck cell and a cell of the other pillar: the deck splits in
    // two halves that touch only removed cells — the rule follows the cut cells back to the ground.
    for (let y = 11; y <= 14; y++) world.setBlock(8, y, 0, B.AIR);
    world.setBlock(4, 15, 0, B.AIR);
    world.setBlock(0, 13, 0, B.AIR);
    expect(physics.seeds.size).toBe(0);
    active = false;
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(2); // q 0..3 (with the stub at y 14) and q 5..8
    settle(physics);
    expect(count(world, B.OAK_PLANKS, 0, 8, 15, 15, 0, 0)).toBe(0);
  });

  it('a removal next to an unloaded chunk counts as supported; a search reaching one counts as supported', () => {
    const { world, physics } = setup();
    for (let q = 10; q <= 20; q++) world.setBlock(q, 20, 0, B.STONE); // a beam running into chunk (1, 0)
    for (let y = 11; y < 20; y++) world.setBlock(10, y, 0, B.STONE); // on a pillar at q = 10
    world.unload(1, 0); // q ≥ 16 not loaded
    physics.asPlayer(() => world.setBlock(10, 15, 0, B.AIR));
    settle(physics);
    expect(physics.support.stats.crumbled).toBe(0);
    expect(world.getBlock(12, 20, 0)).toBe(B.STONE);
  });
});

describe('collapse: anchors and cost', { timeout: 20000 }, () => {
  it('a house on natural sand stands (natural ground anchors, gravity blocks included)', () => {
    const { world, physics } = realWorld({ id: B.SAND });
    const walls = [];
    for (let q = -2; q <= 2; q++) {
      for (let y = 11; y <= 13; y++) {
        walls.push([q, y, -2], [q, y, 2]);
        if (Math.abs(q) === 2) for (let r = -1; r <= 1; r++) walls.push([q, y, r]);
      }
    }
    build(world, walls, B.OAK_PLANKS);
    const roof = [];
    for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) roof.push([q, 14, r]);
    build(world, roof, B.STONE_BRICKS);
    physics.asPlayer(() => world.setBlock(0, 11, -2, B.AIR)); // a door
    physics.asPlayer(() => world.setBlock(0, 12, -2, B.AIR));
    physics.asPlayer(() => world.setBlock(-2, 12, 0, B.AIR)); // a window
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(physics.support.stats.crumbled).toBe(0);
    expect(physics.fallers.count).toBe(0);
    expect(count(world, B.STONE_BRICKS, -2, 2, 14, 14, -2, 2)).toBe(25);
    expect(world.getBlock(0, 10, 0)).toBe(B.SAND); // the beach under it did not move either
  });

  it('breaking a block of plain terrain costs a handful of visits (every neighbour is natural ground)', () => {
    const { world, physics } = realWorld();
    physics.asPlayer(() => world.setBlock(3, 10, 3, B.AIR));
    physics.asPlayer(() => world.setBlock(3, 9, 3, B.AIR));
    physics.tick();
    expect(physics.stats.lastSupportVisits).toBeLessThanOrEqual(2);
    expect(physics.support.stats.searches).toBe(0); // every start cell was an anchor
    expect(physics.support.busy).toBe(false);
  });

  it('breaking a wall block of a big house on the ground stays cheap (the DFS heads down first)', () => {
    const { world, physics } = realWorld();
    const cells = [];
    for (let q = -6; q <= 6; q++) for (let y = 11; y <= 18; y++) for (const r of [-6, 6]) cells.push([q, y, r]);
    for (let r = -5; r <= 5; r++) for (let y = 11; y <= 18; y++) for (const q of [-6, 6]) cells.push([q, y, r]);
    for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) cells.push([q, 19, r]);
    build(world, cells, B.BRICKS); // ~570 cells
    physics.asPlayer(() => world.setBlock(0, 16, -6, B.AIR));
    physics.tick();
    expect(physics.stats.lastSupportVisits).toBeLessThanOrEqual(40);
    expect(physics.support.stats.crumbled).toBe(0);
  });

  it('rune blocks and black holes stay put while the cells around them fall (self-anchored, holding nothing)', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 19; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 4; q++) for (const r of [0, 1]) world.setBlock(q, 20, r, B.OAK_PLANKS); // a 2-wide deck
    world.setBlock(2, 20, 0, B.RUNE_BLOCK); // in the deck
    world.setBlock(4, 21, 0, B.RUNE_BLOCK); // on top of it
    world.setBlock(5, 20, 0, B.BLACK_HOLE); // at its end
    world.setBlock(3, 19, 1, B.RUNE_BLOCK); // and hanging under it: holds nothing up
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    settle(physics);
    expect(physics.support.stats.crumbled).toBe(1);
    for (const [q, y, r] of [[2, 20, 0], [4, 21, 0], [3, 19, 1]]) expect(world.getBlock(q, y, r), `${q},${y},${r}`).toBe(B.RUNE_BLOCK);
    expect(world.getBlock(5, 20, 0)).toBe(B.BLACK_HOLE);
    for (const q of [0, 1, 3, 4]) expect(world.getBlock(q, 20, 0)).toBe(B.AIR);
    expect(world.getBlock(4, 11, 0)).toBe(B.OAK_PLANKS); // the plank under the rune block on top fell from under it
    expect(world.getBlock(2, 11, 1)).toBe(B.OAK_PLANKS);
    expect(world.getBlock(3, 20, 1)).toBe(B.OAK_PLANKS); // the plank over the hanging rune block rests on it
    expect(world.getBlock(3, 11, 1)).toBe(B.AIR);
  });

  it('sand resting on a build crumbles with it; a campfire on top breaks through the normal trigger', () => {
    const { world, physics, fx } = setup();
    for (let y = 11; y <= 14; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 3; q++) world.setBlock(q, 15, 0, B.OAK_PLANKS);
    world.setBlock(2, 16, 0, B.SAND);
    world.setBlock(3, 16, 0, B.CAMPFIRE);
    physics.asPlayer(() => world.setBlock(0, 12, 0, B.AIR));
    settle(physics);
    expect(world.getBlock(2, 12, 0)).toBe(B.SAND);
    expect(world.getBlock(2, 11, 0)).toBe(B.OAK_PLANKS);
    expect(count(world, B.CAMPFIRE, -1, 4, 11, 20, -1, 1)).toBe(0);
    expect(fx.particles.some((p) => p.kind === 'smoke')).toBe(true);
  });
});

describe('collapse: crumble details', { timeout: 20000 }, () => {
  it('a log cabin with a leaf roof crumbles (it is no tree); its roof decays instead of hanging in the air', () => {
    const { world, physics } = setup();
    world.setBlock(0, 11, 0, B.STONE); // the cabin sits on one stone pillar
    world.setBlock(0, 12, 0, B.STONE);
    const ring = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
    world.setBlock(0, 13, 0, B.OAK_LOG); // floor
    for (const [q, r] of ring) world.setBlock(q, 13, r, B.OAK_LOG);
    for (let y = 14; y <= 15; y++) for (const [q, r] of ring) world.setBlock(q, y, r, B.SPRUCE_LOG);
    world.setBlock(0, 16, 0, B.OAK_LEAVES);
    for (const [q, r] of ring) world.setBlock(q, 16, r, B.OAK_LEAVES);
    // A hedge on the ground next to the pillar must NOT decay (it rests on natural ground).
    world.setBlock(2, 11, 0, B.OAK_LEAVES);
    world.setBlock(2, 12, 0, B.OAK_LEAVES);
    physics.asPlayer(() => world.setBlock(0, 12, 0, B.AIR));
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.support.stats.toppled).toBe(0);
    expect(physics.trees.count).toBe(0);
    expect(physics.trees.decayCount).toBe(7);
    settle(physics);
    expect(count(world, B.OAK_LEAVES, -2, 2, 13, 20, -2, 2)).toBe(0); // the roof decayed
    expect(world.getBlock(2, 11, 0)).toBe(B.OAK_LEAVES); // the hedge stayed
    expect(world.getBlock(2, 12, 0)).toBe(B.OAK_LEAVES);
    expect(count(world, B.OAK_LOG, -2, 2, 11, 20, -2, 2) + count(world, B.SPRUCE_LOG, -2, 2, 11, 20, -2, 2)).toBe(19);
    expect(physics.trees.stats.decayed).toBe(7);
    expect(physics.lastEvent.kind).toBe('collapse');
    const res = physics.undo(); // the crumble AND the decayed roof come back
    expect(res.ok).toBe(true);
    expect(world.getBlock(0, 16, 0)).toBe(B.OAK_LEAVES);
    expect(world.getBlock(1, 15, 0)).toBe(B.SPRUCE_LOG);
    expect(world.getBlock(0, 13, 0)).toBe(B.OAK_LOG);
  });

  it('undo restores a crumbled bridge (one event for the whole batch)', () => {
    const { world, physics } = setup();
    bridge(world);
    physics.asPlayer(() => world.setBlock(0, 12, 0, B.AIR));
    physics.asPlayer(() => world.setBlock(8, 12, 0, B.AIR));
    settle(physics);
    expect(physics.canUndo).toBe(true);
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('undid the collapse');
    for (let q = 0; q <= 8; q++) expect(world.getBlock(q, 15, 0)).toBe(B.OAK_PLANKS);
    expect(world.getBlock(0, 13, 0)).toBe(B.STONE);
    expect(world.getBlock(4, 11, 0)).toBe(B.AIR);
  });

  it('beyond MAX_FALLING the lowest cells settle instantly and the top keeps falling (no upside-down pile)', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 19; y++) world.setBlock(0, y, 0, B.STONE);
    // A 1200-cell tower of alternating layers (3 × 4 cells, y 20..119) joined to the pillar top by one cell.
    const ids = [];
    for (let y = 20; y < 120; y++) {
      for (let q = 1; q <= 3; q++) for (let r = 0; r < 4; r++) world.setBlock(q, y, r, (y & 1) ? B.BRICKS : B.STONE_BRICKS);
      ids.push(y);
    }
    world.setBlock(0, 20, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.fallers.count).toBe(1024);
    settle(physics, 20000);
    // Column (2, 1): the layers land in their original order, bottom layer lowest.
    const col = [];
    for (let y = 11; y < 11 + ids.length; y++) col.push(world.getBlock(2, y, 1));
    expect(col).toEqual(ids.map((y) => ((y & 1) ? B.BRICKS : B.STONE_BRICKS)));
  });
});

describe('the search itself', { timeout: 20000 }, () => {
  it('runs as a resumable DFS under a visit budget (busy in between), with the same verdict', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 300; q++) world.setBlock(q, 20, 0, B.STONE); // a long beam
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    const ctx = physics.ctx;
    ctx.deadline = Infinity;
    const steps = [];
    while (physics.seeds.size > 0 || physics.support.busy) {
      steps.push(physics.support.step(ctx, physics.seeds, 64));
      expect(steps.length).toBeLessThan(100);
    }
    expect(steps.length).toBeGreaterThan(4);
    expect(steps.slice(0, -1).every((v) => v === 64)).toBe(true);
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.fallers.count).toBe(305);
  });

  it('honours the tick time budget (checked every 256 visits) and resumes next tick', () => {
    let t = 0;
    const { world, physics } = setup({ now: () => t });
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 2000; q++) world.setBlock(q, 20, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    const ctx = physics.ctx;
    ctx.deadline = 3;
    t = 5; // already late: one batch of 256 visits, then it stops
    const v = physics.support.step(ctx, physics.seeds, MAX_SUPPORT_VISITS_PER_TICK);
    expect(v).toBe(256);
    expect(physics.support.busy).toBe(true);
    t = 0;
    while (physics.support.busy) physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
  });

  it('SUPPORT_LIMIT visits count as supported (a huge floating build is left alone)', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 19; y++) world.setBlock(0, y, 0, B.STONE);
    const side = Math.ceil(Math.sqrt(SUPPORT_LIMIT + 100));
    for (let q = 0; q < side; q++) for (let r = 0; r < side; r++) world.put(q, 20, r, B.STONE); // no hooks: fast
    world.setBlock(0, 20, 0, B.COBBLESTONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    for (let i = 0; i < 4; i++) physics.tick();
    expect(physics.support.busy).toBe(false);
    expect(physics.support.stats.crumbled).toBe(0);
    expect(world.getBlock(5, 20, 5)).toBe(B.STONE);
  });

  it('a block placed next to a search in progress restarts it (the build is supported again)', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 300; q++) world.setBlock(q, 20, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    const ctx = physics.ctx;
    ctx.deadline = Infinity;
    physics.support.step(ctx, physics.seeds, 64);
    expect(physics.support.busy).toBe(true);
    for (let y = 11; y <= 19; y++) world.setBlock(30, y, 0, B.STONE); // a new pillar under a cell already visited
    while (physics.support.busy) physics.support.step(ctx, physics.seeds, 64);
    expect(physics.support.stats.restarts).toBeGreaterThan(0);
    expect(physics.support.stats.crumbled).toBe(0);
    expect(world.getBlock(300, 20, 0)).toBe(B.STONE);
  });

  it('the shared memo: a later seed meeting cells an earlier search proved supported stops at once', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 50; q++) world.setBlock(q, 20, 0, B.STONE);
    world.setBlock(25, 21, 0, B.STONE);
    world.setBlock(26, 21, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(25, 21, 0, B.AIR));
    physics.asPlayer(() => world.setBlock(26, 21, 0, B.AIR));
    expect(physics.seeds.size).toBe(2);
    physics.tick();
    expect(physics.support.stats.searches).toBe(1); // (25, 20) walked to the pillar; (26, 20) was already proven
    expect(physics.support.stats.crumbled).toBe(0);
  });

  it('two cuts in one batch (player first): the part beyond the second cut was held through the first one', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 50; q++) world.setBlock(q, 20, 0, B.STONE);
    world.setBlock(40, 20, 0, B.AIR); // world-caused: q 41..50 still held through q 1..39
    physics.asPlayer(() => world.setBlock(10, 20, 0, B.AIR)); // player-caused, searched first
    expect(physics.seeds.peek().priority).toBe(true);
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(2); // q 11..39 and, through the cut at 40, q 41..50
    expect(physics.fallers.count).toBe(29 + 10);
  });

  it('a seed without removals (an explicit seedSupport, e.g. a crater rim) collapses what it finds floating', () => {
    const { world, physics } = setup();
    for (let q = 0; q < 3; q++) world.setBlock(q, 30, 0, B.STONE); // floats already
    physics.seedSupport([[1, 30, 0]], { cause: { kind: 'explosion', x: 1, y: 29, z: 0 } });
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.fallers.count).toBe(3);
  });

  it("a collapse found from a blast's rim seed records into the blast's event (one undo restores both)", () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 14; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 3; q++) world.setBlock(q, 15, 0, B.OAK_PLANKS);
    const ev = physics.beginEvent('explosion', { kind: 'explosion', x: 0, y: 12, z: 0 });
    physics.ctx.writeQuiet(0, 12, 0, B.AIR);
    physics.ctx.writeQuiet(0, 13, 0, B.AIR);
    physics.seedSupport([[0, 11, 0], [0, 14, 0]], { cause: ev.cause, removed: [[0, 12, 0, B.STONE, 0], [0, 13, 0, B.STONE, 0]] });
    physics.endEvent();
    settle(physics);
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.lastEvent).toBe(ev);
    physics.undo();
    for (let y = 11; y <= 14; y++) expect(world.getBlock(0, y, 0)).toBe(B.STONE);
    for (let q = 0; q <= 3; q++) expect(world.getBlock(q, 15, 0)).toBe(B.OAK_PLANKS);
  });

  it('collapse off: nothing is searched, and switching it on later does not replay old removals', () => {
    const { world, physics } = setup();
    bridge(world);
    physics.setSwitch('collapse', false);
    world.setBlock(0, 12, 0, B.AIR);
    world.setBlock(8, 12, 0, B.AIR);
    settle(physics);
    physics.setSwitch('collapse', true);
    settle(physics);
    expect(physics.support.stats.batches).toBe(0);
    expect(world.getBlock(4, 15, 0)).toBe(B.OAK_PLANKS);
  });

  it('switching collapse off mid-search forgets the search', () => {
    const { world, physics } = setup();
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 1; q <= 300; q++) world.setBlock(q, 20, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    physics.ctx.deadline = Infinity;
    physics.support.step(physics.ctx, physics.seeds, 64);
    expect(physics.support.busy).toBe(true);
    physics.setSwitch('collapse', false);
    expect(physics.support.busy).toBe(false);
  });
});

describe('real World', { timeout: 20000 }, () => {
  it('a beam across chunk borders crumbles when its pillar is cut', () => {
    const { world, physics } = realWorld({ rd: 2 });
    for (let y = 11; y <= 20; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 30; q++) world.setBlock(q, 20, 0, B.STONE);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR));
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1); // everything loaded: the beam falls
    expect(physics.fallers.count).toBeGreaterThan(20);
  });

  it('a platform over a chunk corner (four chunks) held by one pillar crumbles whole, and lands whole', () => {
    const { world, physics } = realWorld({ rd: 2 });
    for (let y = 11; y <= 19; y++) world.setBlock(12, y, 12, B.STONE);
    for (let q = 12; q <= 19; q++) for (let r = 12; r <= 19; r++) world.setBlock(q, 20, r, B.OAK_PLANKS);
    physics.asPlayer(() => world.setBlock(12, 15, 12, B.AIR));
    physics.tick();
    expect(physics.support.stats.crumbled).toBe(1);
    expect(physics.fallers.count).toBe(64 + 4);
    settle(physics);
    expect(count(world, B.OAK_PLANKS, 12, 19, 11, 20, 12, 19)).toBe(64);
    expect(count(world, B.OAK_PLANKS, 12, 19, 20, 20, 12, 19)).toBe(0);
  });

  it('peekNeighbours gives exactly what world.peekBlock gives, also for a cell of an unloaded chunk beside loaded ones', () => {
    const { world } = realWorld({ rd: 1 });
    world.setBlock(47, 11, 5, B.BRICKS); // chunk (2, 0), loaded; (3, 0) is not (beyond rd + DATA_RADIUS_EXTRA)
    expect(world.getChunk(2, 0)).toBeDefined();
    expect(world.getChunk(3, 0)).toBeUndefined();
    const out = new Uint8Array(8);
    const want = (q, y, r) => [
      ...HEX_DIRS.map(([dq, dr]) => world.peekBlock(q + dq, y, r + dr)), world.peekBlock(q, y + 1, r), world.peekBlock(q, y - 1, r),
    ];
    for (const [q, y, r] of [[48, 11, 5], [48, 10, 0], [48, 0, 5], [48, 127, 5], [47, 11, 5], [5, 11, 5], [33, 11, 15]]) {
      expect([...peekNeighbours(world, q, y, r, out)], `${q},${y},${r}`).toEqual(want(q, y, r));
    }
    expect(peekNeighbours(world, 48, 11, 5, out)[3]).toBe(B.BRICKS); // the side in loaded chunk (2, 0); it read UNLOADED
  });

  it('a crumbling deck never buries the player standing under it (lifted onto the pile, or the block breaks)', () => {
    const { world, physics } = realWorld({ rd: 2 });
    const [x, z] = hexToWorld(3, 0);
    const player = createPlayer(x, GROUND + 1, z);
    physics.hooks.bodies = () => [player];
    for (let y = 11; y <= 13; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 5; q++) world.setBlock(q, 14, 0, B.BRICKS);
    physics.asPlayer(() => world.setBlock(0, 12, 0, B.AIR));
    settle(physics);
    expect(physics.support.stats.crumbled).toBe(1);
    for (let y = 11; y <= 14; y++) expect(playerIntersectsBlock(player, 3, y, 0) && world.getBlock(3, y, 0) !== B.AIR).toBe(false);
    expect(player.y).toBeGreaterThanOrEqual(GROUND + 2); // it rode the brick that landed on it
  });
});
