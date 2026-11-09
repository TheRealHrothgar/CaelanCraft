// Block physics integration — undo of a whole blast chain (CONTRACTS §33.8.4, §37.3–§37.4, §38.2–§38.3): a chain is ONE
// event however it unfolds (hung barrels fizzling in water, explosions switched off mid-chain, a barrel lit by R that
// another blast sets off early), the lit barrels it used up come back in the cells they were lit in (stacked, never
// floating, never in a campfire's cell), and undo never leaves an unlit barrel next to a campfire, which would only
// blow the restored scene up again (at once, or after a reload). Map-backed fake worlds unless saving matters.
import { describe, it, expect } from 'vitest';
import { MAX_LIT_BARRELS, BARREL_TIMER_FUSE_MAX_S } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { hexToWorld } from '../../src/hex.js';
import { createPlayer } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10
const DT = 1 / 60;
const QUIET = { say() {}, sound() {}, particles() {}, bodies: () => [], player: () => null, knock() {} };

/** A fake world with every physics feature on; every event begun is logged. */
function scene() {
  const world = makeFakeWorld({ groundY: GROUND, seed: 7 });
  const physics = attachPhysics(world, BlockPhysics, { ...QUIET });
  const events = [];
  const begin = physics.beginEvent.bind(physics);
  physics.beginEvent = (kind, cause) => {
    const ev = begin(kind, cause);
    events.push(kind);
    return ev;
  };
  return { world, physics, ex: physics.explosions, events };
}

function idle(p) {
  return p.fallers.count === 0 && p.fallers.tumblerCount === 0 && p.queued() === 0 && p.seeds.size === 0 &&
    !p.support.busy && p.trees.count === 0 && p.trees.decayCount === 0 && p.explosions.litCount === 0;
}

function settle(physics, max = 20000) {
  let n = 0;
  physics.step(DT);
  while (!idle(physics) && n < max) {
    physics.step(DT);
    n++;
  }
  return n;
}

function stepUntil(physics, cond, max = 2000) {
  let n = 0;
  while (!cond() && n < max) {
    physics.step(DT);
    n++;
  }
  return n;
}

function steps(physics, seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) physics.step(DT);
}

function disc(q, r, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) out.push([q + dq, r + dr]);
  }
  return out;
}

/** Every cell of the box as "q,y,r" → id. */
function snapshot(world, q0, q1, y0, y1, r0, r1) {
  const m = new Map();
  for (let q = q0; q <= q1; q++) for (let y = y0; y <= y1; y++) for (let r = r0; r <= r1; r++) m.set(`${q},${y},${r}`, world.getBlock(q, y, r));
  return m;
}

/** Cells of a snapshot that hold something else now. */
function differ(world, snap) {
  const out = [];
  for (const [k, id] of snap) {
    const [q, y, r] = k.split(',').map(Number);
    const now = world.getBlock(q, y, r);
    if (now !== id) out.push(`${k}: ${id}->${now}`);
  }
  return out;
}

describe('a chain is one undo (EXP-1, EXP-3)', () => {
  it('hung barrels that fizzle in a pond join the blast: no separate collapse event, one undo restores the whole crater', () => {
    const { world, physics, ex, events } = scene();
    for (const [q, r] of disc(5, 0, 2)) for (const y of [9, 10]) world.put(q, y, r, B.WATER);
    settle(physics);
    for (let q = 1; q <= 2; q++) for (let r = -1; r <= 1; r++) for (const y of [10, 11]) world.setBlock(q, y, r, B.BLAST_BARREL);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    settle(physics);
    const snap = snapshot(world, -8, 8, 0, 14, -8, 8);
    let hungFizzles = 0;
    const unhang = ex._unhang.bind(ex);
    ex._unhang = (rec) => {
      if (rec.hung) hungFizzles++;
      unhang(rec);
    };
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    steps(physics, 15);
    settle(physics);
    expect(hungFizzles).toBeGreaterThan(0); // the case: barrels left hanging by the rim collapse went out in the pond
    expect(events).toEqual(['explosion']);
    expect(physics.lastEvent.kind).toBe('explosion');
    const res = physics.undo();
    expect(res.message).toContain('undid the explosion');
    settle(physics);
    expect(differ(world, snap)).toEqual([]);
    expect(physics.undo().ok).toBe(false);
  });

  it('switching explosions off while hung barrels burn keeps their fall in the blast event', () => {
    const { world, physics, ex, events } = scene();
    world.setBlock(2, 11, 0, B.STONE);
    for (const [q, r] of disc(2, 0, 1)) world.setBlock(q, 12, r, B.STONE);
    for (const [q, r] of disc(2, 0, 1)) world.setBlock(q, 13, r, B.BLAST_BARREL);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    settle(physics);
    const snap = snapshot(world, -8, 8, 0, 16, -8, 8);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    stepUntil(physics, () => [...ex.timers.values()].some((t) => t.hung));
    expect([...ex.timers.values()].some((t) => t.hung)).toBe(true);
    physics.setSwitch('explosions', false);
    settle(physics);
    expect(events).toEqual(['explosion']);
    const res = physics.undo();
    expect(res.message).toContain('undid the explosion');
    settle(physics);
    expect(differ(world, snap)).toEqual([]);
  });

  it('a barrel lit with R that another blast sets off early joins its chain: one undo restores both craters', () => {
    const { world, physics, ex, events } = scene();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    settle(physics);
    const snap = snapshot(world, -9, 11, 0, 14, -9, 9);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    steps(physics, 1);
    physics.asPlayer(() => ex.lightAt(2, 11, 0)); // 1 s later: its own fuse would end 1 s after the first blast
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.lit.length).toBe(1);
    expect(ex.lit[0].fuse).toBeLessThanOrEqual(BARREL_TIMER_FUSE_MAX_S); // caught: its fuse shortened…
    expect(ex.lit[0].event).toBe(physics.lastEvent.id); // …and it joined the blast's event
    stepUntil(physics, () => ex.blastCount === 2);
    expect(events).toEqual(['explosion']);
    settle(physics);
    expect(physics.undo().message).toContain('undid the explosion');
    settle(physics);
    expect(differ(world, snap)).toEqual([]); // both craters, and both barrels back where they were lit
    expect(physics.undo().ok).toBe(false);
  });

  it('a caught barrel put out before it goes off stays a barrel through the undo (where it was put out)', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    settle(physics);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    steps(physics, 1);
    physics.asPlayer(() => ex.lightAt(2, 11, 0));
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.lit[0].event).toBe(physics.lastEvent.id);
    expect(ex.snuff(ex.lit[0])).toBe(true); // left-click: a barrel block again where it rests (it may still drop)
    settle(physics);
    expect(physics.undo().message).toContain('undid the explosion');
    settle(physics);
    let barrels = 0;
    for (let q = -10; q <= 12; q++) for (let r = -10; r <= 10; r++) for (let y = 0; y <= 20; y++) if (world.getBlock(q, y, r) === B.BLAST_BARREL) barrels++;
    expect(barrels).toBe(2); // the used-up one given back, the put-out one where it came to rest
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
  });

  it('so does an R-lit barrel burning as a fuse timer (MAX_LIT_BARRELS were burning)', () => {
    const { world, physics, ex, events } = scene();
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(40 + 2 * i, 11, 40, B.BLAST_BARREL);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    settle(physics);
    const snap = snapshot(world, -9, 11, 0, 14, -9, 9);
    physics.asPlayer(() => ex.lightAt(0, 11, 0)); // an entity
    for (let i = 1; i < MAX_LIT_BARRELS; i++) ex.lightAt(40 + 2 * i, 11, 40); // entities (ignite now burns in place)
    for (const rec of ex.lit) if (rec.q >= 40) rec.fuse = 1e9; // the far ones never go off
    steps(physics, 1);
    physics.asPlayer(() => ex.lightAt(2, 11, 0)); // a fuse timer, event 0
    expect(ex.isBurning(2, 11, 0)).toBe(true);
    stepUntil(physics, () => ex.blastCount === 2);
    expect(events).toEqual(['explosion']);
    expect(physics.undo().message).toContain('undid the explosion');
    for (const rec of ex.lit) rec.fuse = 1e9;
    for (let i = 0; i < 120; i++) physics.step(DT);
    const near = [...snap].filter(([k]) => Number(k.split(',')[0]) < 30);
    expect(differ(world, new Map(near))).toEqual([]);
  });
});

describe('barrels given back by undo (EXP-2)', () => {
  it('a 2-high stack lit with R comes back as two barrels in their own cells', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(0, 12, 0, B.BLAST_BARREL);
    settle(physics);
    const snap = snapshot(world, -7, 7, 0, 14, -7, 7);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    physics.asPlayer(() => ex.lightAt(0, 12, 0)); // lit barrels never collide: the top one drops into the bottom one's cell
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.lastBlast.barrels).toBe(2);
    expect(physics.undo().ok).toBe(true);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.getBlock(0, 12, 0)).toBe(B.BLAST_BARREL);
    settle(physics);
    expect(differ(world, snap)).toEqual([]);
  });

  it('a lit barrel that went off away from its cell (over a pit) comes back where it was lit, not floating', () => {
    const { world, physics, ex } = scene();
    for (const [q, r] of disc(8, 0, 1)) for (let y = 6; y <= GROUND; y++) world.setBlock(q, y, r, B.AIR); // a pit
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    settle(physics);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    const [x8, z8] = hexToWorld(8, 0);
    const body = ex.lit[0].tumbler.body;
    body.x = x8; // shoved out over the pit: it goes off in the air there
    body.z = z8;
    body.y = 13;
    stepUntil(physics, () => ex.blastCount === 1);
    expect(physics.undo().ok).toBe(true);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    for (let y = 6; y <= 14; y++) expect(world.getBlock(8, y, 0), `pit y=${y}`).not.toBe(B.BLAST_BARREL);
  });

  it('sand resting on a lit barrel stays on it (play-test B3); undo puts the barrel back in its cell under the sand', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(0, 12, 0, B.SAND);
    settle(physics);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    steps(physics, 0.5);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR); // the sand never dropped into the lit cell
    expect(world.getBlock(0, 12, 0)).toBe(B.SAND);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(physics.undo().ok).toBe(true);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.getBlock(0, 12, 0)).toBe(B.SAND);
  });

  it('sand that drops into an empty lit cell (the barrel rolled away) gets its cell back first; the barrel comes back on top', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(0, 12, 0, B.SAND);
    settle(physics);
    physics.asPlayer(() => ex.lightAt(0, 11, 0));
    const b = ex.lit[0].tumbler.body;
    [b.x, b.z] = hexToWorld(3, 0); // rolled out from under the sand
    stepUntil(physics, () => world.getBlock(0, 11, 0) === B.SAND, 120);
    expect(world.getBlock(0, 12, 0)).toBe(B.AIR);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(physics.undo().ok).toBe(true);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(world.getBlock(0, 12, 0)).toBe(B.BLAST_BARREL);
  });
});

describe('undo next to a campfire (F3, EXP-2)', () => {
  it('a campfire-lit barrel is not given back: the campfire comes back, and nothing goes off again', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.CAMPFIRE);
    world.setBlock(1, 11, 0, B.BLAST_BARREL); // the campfire lights it
    stepUntil(physics, () => ex.blastCount === 1, 400);
    expect(ex.blastCount).toBe(1);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR); // the blast broke the campfire
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('1 barrel next to a campfire not given back');
    expect(world.getBlock(0, 11, 0)).toBe(B.CAMPFIRE);
    expect(world.getBlock(1, 11, 0)).toBe(B.AIR);
    steps(physics, 10);
    expect(ex.blastCount).toBe(1);
    expect(ex.litCount).toBe(0);
    expect(world.getBlock(0, 11, 0)).toBe(B.CAMPFIRE);
  });

  it('a barrel placed on a campfire falls into its cell when lit; undo puts the campfire back, not the barrel', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 11, 0, B.CAMPFIRE);
    world.setBlock(0, 12, 0, B.BLAST_BARREL);
    stepUntil(physics, () => ex.blastCount === 1, 400);
    expect(physics.undo().message).toContain('next to a campfire not given back');
    expect(world.getBlock(0, 11, 0)).toBe(B.CAMPFIRE);
    expect(world.getBlock(0, 12, 0)).toBe(B.AIR);
    steps(physics, 6);
    expect(ex.blastCount).toBe(1);
  });

  it('a barrel the campfire set burning keeps burning through an undo of the blast that caught it', () => {
    const { world, physics, ex } = scene();
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(40 + 2 * i, 11, 40, B.BLAST_BARREL);
    for (let i = 0; i < MAX_LIT_BARRELS; i++) ex.ignite(40 + 2 * i, 11, 40);
    for (const rec of ex.lit) rec.fuse = 1e9; // every entity slot taken: what lights next burns as a fuse timer
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    physics.asPlayer(() => ex.lightAt(0, 11, 0)); // timer, 3 s
    steps(physics, 1);
    world.setBlock(3, 11, 0, B.CAMPFIRE);
    world.setBlock(2, 11, 0, B.BLAST_BARREL); // the campfire lights it: timer, 3 s, ends 1 s after the first blast
    physics.tick();
    expect(ex.isBurning(2, 11, 0)).toBe(true);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.isBurning(2, 11, 0)).toBe(true); // caught (fuse shortened), not gone off yet
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(world.getBlock(3, 11, 0)).toBe(B.CAMPFIRE);
    expect(ex.isBurning(2, 11, 0)).toBe(true); // undo cannot put it out: the campfire would light it again
    stepUntil(physics, () => ex.blastCount === 2);
    expect(ex.blastCount).toBe(2);
    expect(physics.lastEvent.kind).toBe('explosion'); // its own event now
  });

  it('a real World: after the undo, a save and a reload, the campfire stands and nothing blows up', () => {
    const boot = (edits) => {
      const world = new World({ seed: 3, renderDistance: 1, worldGen: flatWorldGen(GROUND), now: () => 0, edits });
      const player = createPlayer(0.5, GROUND + 1, -20);
      const physics = attachPhysics(world, BlockPhysics, { ...QUIET, bodies: () => [player], player: () => player });
      for (let i = 0; i < 500; i++) {
        const r = world.update(player.x, player.z, Infinity);
        if (r.pendingGen === 0 && r.pendingMesh === 0) break;
      }
      return { world, physics, ex: physics.explosions };
    };
    const a = boot();
    a.world.setBlock(0, 11, 0, B.CAMPFIRE);
    a.world.setBlock(1, 11, 0, B.BLAST_BARREL);
    stepUntil(a.physics, () => a.ex.blastCount === 1, 400);
    expect(a.physics.undo().ok).toBe(true);
    steps(a.physics, 6);
    expect(a.ex.blastCount).toBe(1);
    const b = boot(a.physics.exportEdits());
    expect(b.world.getBlock(0, 11, 0)).toBe(B.CAMPFIRE);
    steps(b.physics, 6);
    expect(b.ex.blastCount).toBe(0);
    expect(b.ex.litCount).toBe(0);
    expect(b.world.getBlock(0, 11, 0)).toBe(B.CAMPFIRE);
  });
});
