// Unit tests for src/explosions.js — lighting (R, campfire, `ignite`), lit barrel entities and fuse timers, snuffing,
// merged chain blasts, the crater (shape, blast-proof cells, the edit cap), debris, knockback, the rim support seed,
// flash / shake, saving, undo and streaming (CONTRACTS §37). Fake world from the fixtures unless a real World matters.
import { describe, it, expect } from 'vitest';
import {
  BARREL_FUSE_S, MAX_LIT_BARRELS, MAX_DEBRIS, BLAST_RADIUS, BLAST_MAX_RADIUS, BLAST_IMPULSE, BLAST_MIN_UP,
  BLAST_FLASH_S, BLAST_SHAKE_S, BLAST_SHAKE_RANGE, BLAST_JITTER, BARREL_TIMER_FUSE_MIN_S, BARREL_TIMER_FUSE_MAX_S,
  MAX_TOTAL_EDITS, PIG_RADIUS, PIG_HEIGHT, PLAYER_HEIGHT,
} from '../../src/config.js';
import { BLOCK, isSolid } from '../../src/blocks.js';
import { HEX_DIRS, hexToWorld, worldToHex } from '../../src/hex.js';
import { createPlayer, createBody, findStandingY } from '../../src/physics.js';
import { resolveBodies } from '../../src/bodies.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { BLAST_PROOF_IDS, LIT_BARREL_GROUP, blastRadius, isBlastProof } from '../../src/explosions.js';
import { createWorldGen } from '../../src/worldgen.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10
const DT = 1 / 60;

function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? GROUND, seed: opts.seed ?? 7 });
  const fx = { particles: [], sounds: [], said: [], knocks: [] };
  const bodies = opts.bodies ?? [];
  const hooks = {
    particles: (kind, x, y, z, count, o) => fx.particles.push({ kind, x, y, z, count, o }),
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    say: (text) => fx.said.push(text),
    bodies: () => bodies,
    player: () => opts.player ?? null,
    knock: (body, vx, vy, vz, fromX, fromZ) => {
      fx.knocks.push({ body, vx, vy, vz, fromX, fromZ });
      body.vx += vx;
      body.vy += vy;
      body.vz += vz;
      body.onGround = false;
    },
  };
  const physics = attachPhysics(world, BlockPhysics, hooks);
  return { world, physics, fx, ex: physics.explosions };
}

/** Step frames until `cond()` holds (or a cap). @returns {number} frames stepped */
function stepUntil(physics, cond, max = 2000) {
  let n = 0;
  while (!cond() && n < max) {
    physics.step(DT);
    n++;
  }
  return n;
}

/** Step frames, recording every blast (merged chains count once). */
function stepRecording(physics, frames) {
  const ex = physics.explosions;
  const blasts = [];
  let seen = ex.blastCount;
  for (let i = 0; i < frames; i++) {
    physics.step(DT);
    if (ex.blastCount !== seen) {
      expect(ex.blastCount).toBe(seen + 1); // at most one explosion per frame
      seen = ex.blastCount;
      blasts.push({ frame: i, ...ex.lastBlast });
    }
  }
  return blasts;
}

const centre = (q, y, r) => {
  const [x, z] = hexToWorld(q, r);
  return [x, y + 0.5, z];
};

/** Cells within hex distance `radius` of (q, r), centre first. */
function disc(q, r, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) out.push([q + dq, r + dr]);
  }
  return out.sort((a, b) => Math.hypot(...hexToWorld(a[0] - q, a[1] - r)) - Math.hypot(...hexToWorld(b[0] - q, b[1] - r)));
}

describe('helpers', () => {
  it('blast radius 3.5·∛n capped at 8; blast-proof ids', () => {
    expect(blastRadius(1)).toBe(BLAST_RADIUS);
    expect(blastRadius(8)).toBeCloseTo(7, 9);
    expect(blastRadius(29)).toBe(BLAST_MAX_RADIUS);
    expect(blastRadius(1000)).toBe(BLAST_MAX_RADIUS);
    for (const id of [B.AIR, B.WATER, B.WATER_FLOW_3, B.WATER_FALL, B.BEDROCK, B.OBSIDIAN, B.RUNE_BLOCK, B.BLACK_HOLE, 255]) {
      expect(isBlastProof(id), String(id)).toBe(true);
    }
    for (const id of [B.STONE, B.DIRT, B.OAK_LOG, B.OAK_LEAVES, B.GLASS, B.SAND, B.CAMPFIRE, B.BLAST_BARREL]) {
      expect(isBlastProof(id), String(id)).toBe(false);
    }
    expect(BLAST_PROOF_IDS).toContain(B.OBSIDIAN);
  });
});

describe('lighting', () => {
  it('R lights a barrel: the block becomes a persistent, pulsing, hissing, sparking entity with a 3 s fuse', () => {
    const { world, physics, fx, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    expect(ex.lightAt(0, 11, 0)).toBe(true);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(ex.lit.length).toBe(1);
    expect(ex.litCount).toBe(1);
    const t = physics.fallers.tumblers[0];
    expect(physics.fallers.tumblerCount).toBe(1);
    expect(t.persistent).toBe(true);
    expect(t.id).toBe(B.BLAST_BARREL);
    expect(t.body.group).toBe(LIT_BARREL_GROUP);
    expect(ex.lit[0].fuse).toBe(BARREL_FUSE_S);
    expect(ex.lightAt(0, 11, 0)).toBe(false); // nothing left to light there
    const scales = new Set();
    for (let i = 0; i < 60; i++) {
      physics.step(DT);
      scales.add(Math.round(t.scale * 1000));
    }
    expect(ex.lit[0].fuse).toBeCloseTo(BARREL_FUSE_S - 1, 6);
    expect(scales.size).toBeGreaterThan(5); // pulsing
    expect(Math.max(...scales) / 1000).toBeLessThanOrEqual(1.04 + 1e-9);
    expect(fx.sounds.filter((s) => s.name === 'hiss').length).toBeGreaterThanOrEqual(2);
    expect(fx.particles.some((p) => p.kind === 'sparks')).toBe(true);
    expect(t.body.y).toBeCloseTo(11, 1); // rests on the ground where the block was
    expect(physics.bodies([])).toEqual([t.body]);
  });

  it('explosions off: nothing lights and `ignite` explains; ignite refuses non-barrels and burning ones', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    physics.setSwitch('explosions', false);
    expect(ex.lightAt(0, 11, 0)).toBe(false);
    expect(ex.ignite(0, 11, 0)).toEqual({ ok: false, message: expect.stringContaining('explosions are off') });
    physics.setSwitch('explosions', true);
    expect(ex.ignite(1, 11, 0).message).toContain('no blast barrel');
    const res = ex.ignite(0, 11, 0);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('lit the blast barrel at (0, 11, 0)');
    expect(ex.litCount).toBe(1);
    // A barrel burning in place (a fuse timer) cannot be lit twice.
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(10 + i * 2, 11, 10, B.BLAST_BARREL);
    for (let i = 0; i < MAX_LIT_BARRELS; i++) ex.ignite(10 + i * 2, 11, 10);
    expect(ex.timers.size).toBe(1);
    expect(ex.ignite(2, 11, 0).ok).toBe(true); // timer (entities are full)
    expect(ex.ignite(2, 11, 0).message).toContain('already burning');
    expect(ex.lightAt(2, 11, 0)).toBe(false);
  });

  it('a campfire next to a barrel lights it (misc rule), whichever is placed second', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(1, 11, 0, B.CAMPFIRE);
    physics.tick();
    expect(ex.litCount).toBe(1);
    world.setBlock(10, 11, 0, B.CAMPFIRE);
    world.setBlock(10, 12, 0, B.BLAST_BARREL); // on top of the fire
    physics.tick();
    expect(ex.litCount).toBe(2);
    expect(world.getBlock(10, 12, 0)).toBe(B.AIR);
  });

  it('the ignition rule waits for an unloaded neighbour chunk and lights once it loads', () => {
    const { world, physics, ex } = setup();
    world.setBlock(15, 11, 0, B.BLAST_BARREL); // chunk (0, 0); its east neighbour (16, 11, 0) is in chunk (1, 0)
    world.unload(1, 0);
    world.put(16, 11, 0, B.CAMPFIRE); // a campfire waiting in the unloaded chunk
    physics.schedule('misc', 15, 11, 0);
    physics.tick();
    expect(ex.litCount).toBe(0);
    expect(physics.parkedCount).toBe(1);
    world.load(1, 0);
    physics.tick();
    expect(ex.litCount).toBe(1);
  });

  it('beyond MAX_LIT_BARRELS lit barrels burn as fuse timers in place', () => {
    const { world, physics, ex } = setup();
    const n = MAX_LIT_BARRELS + 8;
    for (let i = 0; i < n; i++) world.setBlock(i * 3, 11, 0, B.BLAST_BARREL);
    for (let i = 0; i < n; i++) expect(ex.ignite(i * 3, 11, 0).ok).toBe(true);
    expect(ex.lit.length).toBe(MAX_LIT_BARRELS);
    expect(physics.fallers.tumblerCount).toBe(MAX_LIT_BARRELS);
    expect(ex.timers.size).toBe(8);
    expect(ex.litCount).toBe(n);
    for (let i = MAX_LIT_BARRELS; i < n; i++) {
      expect(world.getBlock(i * 3, 11, 0)).toBe(B.BLAST_BARREL); // still a block, burning
      expect(ex.timers.get([...ex.timers.keys()][i - MAX_LIT_BARRELS]).fuse).toBe(BARREL_FUSE_S);
    }
  });

  it('a burning barrel block that is broken stops burning', () => {
    const { world, physics, ex } = setup();
    for (let i = 0; i <= MAX_LIT_BARRELS; i++) world.setBlock(i * 3, 11, 0, B.BLAST_BARREL);
    for (let i = 0; i <= MAX_LIT_BARRELS; i++) ex.ignite(i * 3, 11, 0);
    expect(ex.timers.size).toBe(1);
    world.setBlock(MAX_LIT_BARRELS * 3, 11, 0, B.AIR);
    expect(ex.timers.size).toBe(0);
    physics.step(DT);
  });
});

describe('snuffing', () => {
  it('left-click (raycast + snuff) puts a lit barrel out: a barrel block again where it rests, with a fizzle', () => {
    const { world, physics, fx, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    for (let i = 0; i < 10; i++) physics.step(DT);
    const [x, z] = hexToWorld(0, 0);
    // Eye 3 m south of the barrel, looking north (−Z).
    const hit = ex.raycast(x, 11.5, z + 3, 0, 0, -1, 5);
    expect(hit).not.toBeNull();
    expect(hit.distance).toBeCloseTo(3 - 0.45, 1);
    expect(ex.raycast(x, 11.5, z + 3, 0, 0, 1, 5)).toBeNull(); // looking away
    expect(ex.raycast(x, 11.5, z + 3, 0, 0, -1, 2)).toBeNull(); // out of reach
    expect(ex.raycast(x, 14, z + 3, 0, 0, -1, 5)).toBeNull(); // above it
    expect(ex.snuff(hit.target)).toBe(true);
    expect(ex.snuff(hit.target)).toBe(false);
    expect(ex.litCount).toBe(0);
    expect(physics.fallers.tumblerCount).toBe(0);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(fx.sounds.some((s) => s.name === 'fizzle')).toBe(true);
    for (let i = 0; i < 300; i++) physics.step(DT);
    expect(ex.blastCount).toBe(0);
  });

  it('a barrel put out in mid-air drops to the ground as a block', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    const rec = ex.lit[0];
    rec.tumbler.body.y = 20.3;
    rec.tumbler.body.vy = 0;
    expect(ex.snuff(rec)).toBe(true);
    expect(world.getBlock(0, 20, 0)).toBe(B.AIR);
    stepUntil(physics, () => physics.fallers.count === 0);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
  });

  it('water puts a lit barrel out (steam, fizzle); the barrel takes the water cell', () => {
    const { world, physics, fx, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    physics.step(DT);
    world.setBlock(0, 11, 0, B.WATER); // water pours into the cell the lit barrel stands in
    physics.step(DT);
    expect(ex.litCount).toBe(0);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(fx.particles.some((p) => p.kind === 'steam')).toBe(true);
    expect(fx.sounds.some((s) => s.name === 'fizzle')).toBe(true);
  });

  it('a fuse timer touching water fizzles out instead of going off', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(1, 11, 0, B.WATER);
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(40 + i * 2, 11, 40, B.BLAST_BARREL);
    for (let i = 0; i < MAX_LIT_BARRELS; i++) ex.ignite(40 + i * 2, 11, 40);
    for (const rec of ex.lit) rec.fuse = 100; // keep the entities quiet
    ex.ignite(0, 11, 0);
    expect(ex.timers.size).toBe(1);
    stepUntil(physics, () => ex.timers.size === 0, 400);
    expect(ex.blastCount).toBe(0);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
  });

  it('switching explosions off puts every lit barrel out and drops the fuse timers', () => {
    const { world, physics, ex } = setup();
    for (let i = 0; i <= MAX_LIT_BARRELS; i++) world.setBlock(i * 3, 11, 0, B.BLAST_BARREL);
    for (let i = 0; i <= MAX_LIT_BARRELS; i++) ex.ignite(i * 3, 11, 0);
    expect(ex.litCount).toBe(MAX_LIT_BARRELS + 1);
    physics.setSwitch('explosions', false);
    expect(ex.litCount).toBe(0);
    expect(physics.fallers.tumblerCount).toBe(0);
    for (let i = 0; i <= MAX_LIT_BARRELS; i++) expect(world.getBlock(i * 3, 11, 0)).toBe(B.BLAST_BARREL);
    for (let i = 0; i < 300; i++) physics.step(DT);
    expect(ex.blastCount).toBe(0);
  });
});

describe('the blast', () => {
  it('crater: broken cells lie within R + jitter, every breakable cell within R − jitter breaks; size within the sphere bounds', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    const blasts = stepRecording(physics, Math.ceil(BARREL_FUSE_S / DT) + 5);
    expect(blasts.length).toBe(1);
    const b = blasts[0];
    expect(b.radius).toBe(BLAST_RADIUS);
    expect(b.barrels).toBe(1);
    expect(b.x).toBeCloseTo(0, 6);
    expect(b.y).toBeGreaterThan(11.4);
    expect(b.y).toBeLessThan(11.6);
    let inner = 0;
    let outer = 0;
    let broken = 0;
    const halves = [0, 0];
    for (const [q, r] of disc(0, 0, 8)) {
      for (let y = 0; y <= GROUND; y++) {
        const [cx, cy, cz] = centre(q, y, r);
        const d = Math.hypot(cx - b.x, cy - b.y, cz - b.z);
        const id = world.getBlock(q, y, r);
        if (d <= BLAST_RADIUS - BLAST_JITTER) {
          inner++;
          expect(id, `inner ${q},${y},${r}`).toBe(B.AIR);
        }
        if (d <= BLAST_RADIUS + BLAST_JITTER) outer++;
        if (d > BLAST_RADIUS + BLAST_JITTER) expect(id, `outer ${q},${y},${r}`).toBe(B.STONE);
        if (id === B.AIR) {
          broken++;
          halves[cx < b.x ? 0 : 1]++;
        }
      }
    }
    expect(broken).toBe(b.destroyed);
    expect(broken).toBeGreaterThanOrEqual(inner);
    expect(broken).toBeLessThanOrEqual(outer);
    // A bowl, not a slab: both halves are close in size and the crater is deepest in the middle.
    expect(Math.abs(halves[0] - halves[1]) / broken).toBeLessThan(0.25);
    let deepest = 11;
    while (deepest > 0 && world.getBlock(0, deepest - 1, 0) === B.AIR) deepest--;
    expect(deepest).toBeLessThanOrEqual(9);
    expect(world.getBlock(5, 10, 0)).toBe(B.STONE);
    expect(physics.lastEvent.kind).toBe('explosion');
    expect(physics.lastEvent.cause.kind).toBe('explosion');
  });

  it('blast-proof cells survive: obsidian, bedrock, rune blocks, black holes, water', () => {
    const { world, physics, ex } = setup();
    // The water source sits in a one-cell pit (y 10, walled by stone), so it cannot flow to the lit barrel and put it
    // out during the fuse (fluids.js is live since the integration merge).
    const keep = [[1, 11, 0, B.OBSIDIAN], [0, 10, 1, B.BEDROCK], [-1, 11, 0, B.RUNE_BLOCK], [0, 12, -1, B.BLACK_HOLE],
      [-1, 10, 2, B.WATER], [1, 9, -1, B.OBSIDIAN]];
    for (const [q, y, r, id] of keep) world.setBlock(q, y, r, id);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    for (const [q, y, r, id] of keep) expect(world.getBlock(q, y, r), `${q},${y},${r}`).toBe(id);
    expect(world.getBlock(0, 10, 0)).toBe(B.AIR); // the stone next to them is gone
    expect(world.getBlock(1, 10, 0)).toBe(B.AIR);
  });

  it('a 30-barrel pile goes off as ONE merged blast after the barrel that lit it (radius capped at 8)', () => {
    const { world, physics, ex } = setup();
    const pile = [];
    for (const [q, r] of disc(0, 0, 2)) pile.push([q, 11, r]);
    for (const [q, r] of disc(0, 0, 2).slice(0, 11)) pile.push([q, 12, r]);
    expect(pile.length).toBe(30);
    for (const [q, y, r] of pile) world.setBlock(q, y, r, B.BLAST_BARREL);
    expect(ex.lightAt(0, 12, 0)).toBe(true); // the top centre one
    const blasts = stepRecording(physics, Math.ceil((BARREL_FUSE_S + BARREL_TIMER_FUSE_MAX_S) / DT) + 30);
    expect(blasts.length).toBe(2);
    expect(blasts[0].barrels).toBe(1);
    expect(blasts[0].lit).toBe(29); // every other barrel of the pile caught fire
    expect(blasts[1].barrels).toBe(29);
    expect(blasts[1].radius).toBe(BLAST_MAX_RADIUS);
    const gap = (blasts[1].frame - blasts[0].frame) * DT;
    expect(gap).toBeGreaterThanOrEqual(BARREL_TIMER_FUSE_MIN_S - DT);
    expect(gap).toBeLessThanOrEqual(BARREL_TIMER_FUSE_MAX_S + DT);
    expect(ex.litCount).toBe(0);
    for (const [q, y, r] of pile) expect(world.getBlock(q, y, r)).toBe(B.AIR);
    // The merged centre is the pile's middle.
    expect(Math.hypot(blasts[1].x, blasts[1].z)).toBeLessThan(0.6);
  });

  it('thirty barrels lit together (ignite) are ONE blast', () => {
    const { world, physics, ex } = setup();
    const pile = [];
    for (const [q, r] of disc(0, 0, 3).slice(0, 30)) pile.push([q, 11, r]);
    for (const [q, y, r] of pile) world.setBlock(q, y, r, B.BLAST_BARREL);
    for (const [q, y, r] of pile) expect(ex.ignite(q, y, r).ok).toBe(true);
    expect(ex.lit.length).toBe(30);
    const blasts = stepRecording(physics, Math.ceil(BARREL_FUSE_S / DT) + 30);
    expect(blasts.length).toBe(1);
    expect(blasts[0].barrels).toBe(30);
    expect(blasts[0].radius).toBe(BLAST_MAX_RADIUS);
    expect(ex.litCount).toBe(0);
    expect(physics.fallers.tumblers.every((t) => !t.persistent)).toBe(true);
  });

  it('far-apart barrels due together go off on consecutive frames (≤ 1 explosion per frame); close ones merge only within the window', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(40, 11, 0, B.BLAST_BARREL);
    ex.ignite(0, 11, 0);
    ex.ignite(40, 11, 0);
    const blasts = stepRecording(physics, Math.ceil(BARREL_FUSE_S / DT) + 10);
    expect(blasts.length).toBe(2);
    expect(blasts[1].frame - blasts[0].frame).toBe(1);
    expect(blasts.every((b) => b.barrels === 1)).toBe(true);

    // Six apart (outside each other's crater) but lit 1 s apart: two blasts, not one.
    const s = setup();
    s.world.setBlock(0, 11, 0, B.BLAST_BARREL);
    s.world.setBlock(6, 11, 0, B.BLAST_BARREL);
    s.ex.ignite(0, 11, 0);
    for (let i = 0; i < 60; i++) s.physics.step(DT);
    s.ex.ignite(6, 11, 0);
    const b2 = stepRecording(s.physics, Math.ceil((BARREL_FUSE_S + 1) / DT) + 10);
    expect(b2.length).toBe(2);
    expect(b2.map((b) => b.barrels)).toEqual([1, 1]);
  });

  it('barrels caught in a blast burn as short fuse timers in place, then go off', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(world.getBlock(2, 11, 0)).toBe(B.BLAST_BARREL);
    expect(ex.timers.size).toBe(1);
    const rec = [...ex.timers.values()][0];
    expect(rec.fuse).toBeGreaterThanOrEqual(BARREL_TIMER_FUSE_MIN_S - 2 * DT);
    expect(rec.fuse).toBeLessThanOrEqual(BARREL_TIMER_FUSE_MAX_S);
    expect(rec.event).toBe(ex.lastBlast.event);
    stepUntil(physics, () => ex.blastCount === 2, 100);
    expect(ex.blastCount).toBe(2);
    expect(world.getBlock(2, 11, 0)).toBe(B.AIR);
  });

  it('bodies within 2R get the impulse away from the blast, at least BLAST_MIN_UP upward; pigs via hooks.knock; tumblers too', () => {
    const [x0, z0] = hexToWorld(0, 0);
    const player = createPlayer(x0 + 4, 11, z0);
    const pig = createBody(x0 - 2, 11, z0, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: 0.7 });
    const far = createBody(x0, 11, z0 + 7.5, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: 0.7 });
    const { world, physics, fx, ex } = setup({ bodies: [player, pig, far] });
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    const crate = physics.fallers.spawnTumbler(B.STONE, x0, 11, z0 - 3, 0, 0, 0, { persistent: true });
    stepUntil(physics, () => ex.blastCount === 1);
    const b = ex.lastBlast;
    const R2 = 2 * b.radius;
    const kp = fx.knocks.find((k) => k.body === player);
    const dp = Math.hypot(player.x - b.x, player.y + PLAYER_HEIGHT / 2 - b.y, player.z - b.z);
    const j = BLAST_IMPULSE * (1 - dp / R2);
    expect(kp.vx).toBeCloseTo((j * (player.x - b.x)) / dp, 6); // away (+x)
    expect(kp.vx).toBeGreaterThan(0);
    expect(kp.vy).toBe(BLAST_MIN_UP); // the upward floor
    expect(Math.abs(kp.vz)).toBeLessThan(0.5);
    expect([kp.fromX, kp.fromZ]).toEqual([b.x, b.z]);
    const kg = fx.knocks.find((k) => k.body === pig);
    expect(kg.vx).toBeLessThan(0); // away (−x), stronger: nearer
    expect(Math.abs(kg.vx)).toBeGreaterThan(Math.abs(kp.vx));
    expect(kg.vy).toBeGreaterThanOrEqual(BLAST_MIN_UP);
    expect(fx.knocks.find((k) => k.body === far)).toBeUndefined(); // beyond 2R
    expect(far.vx + far.vy + far.vz).toBe(0);
    expect(crate.body.vz).toBeLessThan(0); // pushed north, away
    expect(crate.body.vy).toBeGreaterThan(0);
    expect(b.knocked).toBe(3);
  });

  it('debris: at most MAX_DEBRIS tumblers fly outward and up, then vanish in dust (no litter)', () => {
    const { world, physics, fx, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    const b = ex.lastBlast;
    const debris = physics.fallers.tumblers;
    expect(b.debris).toBe(MAX_DEBRIS);
    expect(debris.length).toBe(MAX_DEBRIS);
    for (const t of debris) {
      expect(t.persistent).toBe(false);
      expect(t.event).toBe(b.event);
      expect(isSolid(t.id)).toBe(true);
      const out = (t.body.x - b.x) * t.body.vx + (t.body.z - b.z) * t.body.vz;
      expect(out).toBeGreaterThan(0);
      expect(t.body.vy).toBeGreaterThan(2);
    }
    const writesBefore = world.writes.length;
    const dustBefore = fx.particles.filter((p) => p.kind === 'dust').length;
    stepUntil(physics, () => physics.fallers.tumblerCount === 0, 1200);
    expect(physics.fallers.tumblerCount).toBe(0);
    expect(fx.particles.filter((p) => p.kind === 'dust').length).toBeGreaterThan(dustBefore);
    expect(world.writes.slice(writesBefore).filter((w) => w.id !== B.AIR)).toEqual([]);
    expect(fx.sounds.filter((s) => s.name === 'boom').length).toBe(1);
  });

  it('the edit cap stops breaking (one chat line) while barrels in range still catch fire', () => {
    const { world, physics, fx, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    world.editCount = MAX_TOTAL_EDITS + 10;
    ex.lightAt(0, 11, 0); // the barrel's cell is an edit: lighting it is not capped
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.lastBlast.capped).toBe(true);
    expect(ex.lastBlast.destroyed).toBe(0);
    expect(ex.lastBlast.lit).toBe(1);
    for (const [q, r] of disc(0, 0, 4)) for (let y = 6; y <= GROUND; y++) expect(world.getBlock(q, y, r)).toBe(B.STONE);
    expect(fx.said.filter((t) => t.includes('holding back')).length).toBe(1);
    stepUntil(physics, () => ex.blastCount === 2, 100);
    expect(world.getBlock(2, 11, 0)).toBe(B.AIR); // its own cell was an edit
    expect(fx.said.filter((t) => t.includes('holding back')).length).toBe(1);
  });

  it('ONE support seed from the crater rim, with the removals and the blast as its cause (none while collapse is off)', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    expect(physics.seeds.size).toBe(0); // lighting is quiet
    stepUntil(physics, () => ex.blastCount === 1);
    const b = ex.lastBlast;
    expect(physics.seeds.size).toBe(1);
    const seed = physics.seeds.peek();
    expect(seed.cause).toEqual({ kind: 'explosion', x: b.x, y: b.y, z: b.z });
    expect(seed.event).toBe(b.event);
    expect(seed.removed.length).toBe(b.destroyed);
    expect(seed.removed.every((c) => c[3] === B.STONE && c[4] === 1)).toBe(true); // natural ground
    expect(seed.cells.length).toBe(b.rim);
    expect(b.rim).toBeGreaterThan(20);
    for (const [q, y, r] of seed.cells) {
      expect(world.getBlock(q, y, r)).toBe(B.STONE);
      const open = HEX_DIRS.some(([dq, dr]) => world.getBlock(q + dq, y, r + dr) === B.AIR)
        || world.getBlock(q, y + 1, r) === B.AIR || world.getBlock(q, y - 1, r) === B.AIR;
      expect(open).toBe(true);
    }

    const s = setup();
    s.physics.setSwitch('collapse', false);
    s.world.setBlock(0, 11, 0, B.BLAST_BARREL);
    s.ex.lightAt(0, 11, 0);
    stepUntil(s.physics, () => s.ex.blastCount === 1);
    expect(s.physics.seeds.size).toBe(0);
  });

  it('a lit barrel inside the crater is thrown and its fuse shortens', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    for (let i = 0; i < 60; i++) physics.step(DT); // 1 s later: outside the merge window
    ex.lightAt(2, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.lit.length).toBe(1);
    expect(ex.lit[0].fuse).toBeLessThanOrEqual(BARREL_TIMER_FUSE_MAX_S);
    expect(ex.lit[0].tumbler.body.vx).toBeGreaterThan(0);
  });

  it('flash and shake peak at the blast and fade; the shake only within BLAST_SHAKE_RANGE', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    const f = { x: 0, y: 0, z: 0, intensity: 0 };
    stepUntil(physics, () => ex.blastCount === 1);
    const b = ex.lastBlast;
    expect(ex.flash(f).intensity).toBeGreaterThan(0);
    expect(f.x).toBeCloseTo(b.x, 6);
    expect(f.y).toBeCloseTo(b.y + 1, 6);
    let maxShake = 0;
    const out = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      ex.shakeOffset(b.x + 3, b.y, b.z, out);
      maxShake = Math.max(maxShake, Math.hypot(...out));
      expect(ex.shakeOffset(b.x + BLAST_SHAKE_RANGE + 1, b.y, b.z, [1, 1, 1])).toEqual([0, 0, 0]);
      physics.step(DT);
    }
    expect(maxShake).toBeGreaterThan(0.01);
    expect(maxShake).toBeLessThan(0.5);
    for (let i = 0; i < Math.ceil(Math.max(BLAST_FLASH_S, BLAST_SHAKE_S) / DT); i++) physics.step(DT);
    expect(ex.flash(f).intensity).toBe(0);
    expect(ex.shakeOffset(b.x, b.y, b.z, out)).toEqual([0, 0, 0]);
  });

  it('fuses wait while their chunk is unloaded and resume when it loads', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    physics.step(DT);
    world.unload(0, 0);
    for (let i = 0; i < Math.ceil((BARREL_FUSE_S + 1) / DT); i++) physics.step(DT);
    expect(ex.blastCount).toBe(0);
    expect(ex.litCount).toBe(1);
    world.load(0, 0);
    stepUntil(physics, () => ex.blastCount === 1, Math.ceil(BARREL_FUSE_S / DT) + 5);
    expect(ex.blastCount).toBe(1);
  });
});

describe('bodies, saving and undo', () => {
  it('lit barrels push the player and pigs in resolveBodies, never each other', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(1, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    ex.lightAt(1, 11, 0);
    const [b1, b2] = physics.bodies([]);
    b2.x = b1.x + 0.3; // overlapping
    const before = [b1.x, b2.x];
    resolveBodies([b1, b2], world.getBlock);
    expect([b1.x, b2.x]).toEqual(before);
    const player = createPlayer(b1.x - 0.5, 11, b1.z);
    resolveBodies([player, b1, b2], world.getBlock);
    expect(b1.x - player.x).toBeGreaterThan(0.5); // pushed apart
  });

  it('saving writes a lit barrel as a barrel block where it would rest; the live world is untouched', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(3, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    ex.lit[0].tumbler.body.y = 17.2; // knocked up into the air
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(30 + 2 * i, 11, 30, B.BLAST_BARREL);
    for (let i = 0; i < MAX_LIT_BARRELS - 1; i++) ex.ignite(30 + 2 * i, 11, 30);
    ex.ignite(3, 11, 0); // a fuse timer: stays a barrel in the save
    expect(ex.timers.size).toBe(1);
    const edits = physics.exportEdits();
    const saved = new World({ seed: 7, renderDistance: 0, worldGen: () => { throw new Error('unused'); }, now: () => 0, edits });
    expect(saved.edits.get('0,0').get((0 * 16 + 0) * 128 + 11)).toBe(B.BLAST_BARREL);
    expect(saved.edits.get('0,0').get((3 * 16 + 0) * 128 + 11)).toBe(B.BLAST_BARREL);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 17, 0)).toBe(B.AIR);
    expect(ex.litCount).toBe(MAX_LIT_BARRELS + 1);
  });

  it('sand on a burning barrel rests on it, and the blast goes off inside the pile (play-test B3)', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    for (let y = 12; y <= 15; y++) world.setBlock(0, y, 0, B.SAND);
    world.setBlock(0, 20, 0, B.SAND); // and one that drops onto the pile from higher up
    ex.lightAt(0, 11, 0);
    const b = ex.lit[0].tumbler.body;
    stepUntil(physics, () => physics.fallers.count === 0 && physics.queued('fall') === 0, 120);
    for (let i = 0; i < 60; i++) physics.step(DT);
    expect(b.y).toBeCloseTo(11, 1); // it used to pop up through the sand, one cell per landing, to y 16
    expect([11, 12, 13, 14, 15, 16, 17].map((y) => world.getBlock(0, y, 0))).toEqual([B.AIR, B.SAND, B.SAND, B.SAND, B.SAND, B.SAND, B.AIR]);
    expect(ex.occupiesCell(0, 11, 0)).toBe(true);
    // Saved now: the barrel block where it burns, the pile on top of it.
    const saved = new World({ seed: 7, renderDistance: 0, worldGen: () => { throw new Error('unused'); }, now: () => 0, edits: physics.exportEdits() });
    expect([11, 12, 16].map((y) => saved.edits.get('0,0').get(y))).toEqual([B.BLAST_BARREL, B.SAND, B.SAND]);
    stepUntil(physics, () => ex.blastCount > 0, 400);
    expect(ex.blastCount).toBe(1);
    expect(world.getBlock(0, 10, 0)).toBe(B.AIR); // the crater is dug from inside the pile, into the ground below it
  });

  it('a pile resting on a burning barrel falls into its cell when the barrel is pushed out from under it', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    for (let y = 12; y <= 14; y++) world.setBlock(0, y, 0, B.SAND);
    ex.lightAt(0, 11, 0);
    for (let i = 0; i < 30; i++) physics.step(DT);
    expect(world.getBlock(0, 12, 0)).toBe(B.SAND);
    const b = ex.lit[0].tumbler.body;
    [b.x, b.z] = hexToWorld(2, 0); // rolled two cells away
    stepUntil(physics, () => physics.fallers.count === 0 && physics.queued('fall') === 0 && world.getBlock(0, 11, 0) !== B.AIR, 120);
    expect([11, 12, 13, 14].map((y) => world.getBlock(0, y, 0))).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
    expect(ex.occupiesCell(0, 11, 0)).toBe(false);
    expect(ex.occupiesCell(2, 11, 0)).toBe(true);
  });

  it('undo restores the crater, removes the debris in flight and puts the barrel back', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    const destroyed = ex.lastBlast.destroyed;
    expect(physics.fallers.tumblerCount).toBe(MAX_DEBRIS);
    expect(physics.canUndo).toBe(true);
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.restored).toBe(destroyed);
    expect(res.message).toContain('undid the explosion');
    expect(physics.fallers.tumblerCount).toBe(0);
    for (const [q, r] of disc(0, 0, 5)) for (let y = 1; y <= GROUND; y++) expect(world.getBlock(q, y, r)).toBe(B.STONE);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.editCount).toBe(1); // only the barrel is an edit again
  });

  it('a chain continues the event of the blast that lit it: one undo restores both craters and both barrels', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(3, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 2);
    const ev = physics.lastEvent;
    expect(ex.lastBlast.event).toBe(ev.id);
    const res = physics.undo();
    expect(res.ok).toBe(true);
    for (const [q, r] of disc(1, 0, 6)) for (let y = 1; y <= GROUND; y++) expect(world.getBlock(q, y, r), `${q},${y},${r}`).toBe(B.STONE);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.getBlock(3, 11, 0)).toBe(B.BLAST_BARREL);
    expect(ex.litCount).toBe(0);
  });

  it('undo while the caught barrels still burn drops their fuses (they stay barrels)', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    world.setBlock(2, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    stepUntil(physics, () => ex.blastCount === 1);
    expect(ex.timers.size).toBe(1);
    const res = physics.undo();
    expect(res.message).toContain('still in flight');
    expect(ex.timers.size).toBe(0);
    for (let i = 0; i < 120; i++) physics.step(DT);
    expect(ex.blastCount).toBe(1);
    expect(world.getBlock(2, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
  });

  it('reset drops everything burning; paused physics freezes fuses', () => {
    const { world, physics, ex } = setup();
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    ex.lightAt(0, 11, 0);
    physics.setPaused(true);
    for (let i = 0; i < 400; i++) physics.step(DT);
    expect(ex.lit[0].fuse).toBe(BARREL_FUSE_S);
    physics.setPaused(false);
    physics.clear();
    expect(ex.litCount).toBe(0);
    expect(physics.fallers.tumblerCount).toBe(0);
    for (let i = 0; i < 400; i++) physics.step(DT);
    expect(ex.blastCount).toBe(0);
  });
});

describe('real worldgen (seed 42)', () => {
  it('a barrel at the spawn digs a crater into real terrain and re-meshes lazily', () => {
    const world = new World({ seed: 42, renderDistance: 2, worldGen: createWorldGen(42), now: () => 0 });
    const [sx, , sz] = world.findSpawn();
    let res;
    do res = world.update(sx, sz, Infinity);
    while (res.pendingGen || res.pendingMesh);
    const fy = findStandingY(world.getBlock, sx, sz, 120);
    const [pq, pr] = worldToHex(sx, sz);
    const [bq, br] = [pq + 4, pr];
    let by = 120;
    while (by > 0 && !isSolid(world.getBlock(bq, by - 1, br))) by--;
    const player = createPlayer(sx, fy, sz);
    const physics = attachPhysics(world, BlockPhysics, { bodies: () => [player], player: () => player });
    world.setBlock(bq, by, br, B.BLAST_BARREL);
    const editsBefore = world.editCount;
    expect(physics.explosions.ignite(bq, by, br).ok).toBe(true);
    for (let i = 0; i < 400; i++) {
      physics.step(DT);
      if (physics.explosions.blastCount > 0) break;
      world.update(player.x, player.z, Infinity);
    }
    const b = physics.explosions.lastBlast;
    expect(b).not.toBeNull();
    expect(b.destroyed).toBeGreaterThan(40);
    expect(world.editCount).toBeGreaterThan(editsBefore + 40);
    expect(world.getBlock(bq, by - 1, br)).toBe(B.AIR);
    expect([...world.chunks.values()].some((c) => c.dirty && c.lazy)).toBe(true);
    expect(player.vy).toBeGreaterThanOrEqual(BLAST_MIN_UP); // 4 cells away: knocked up
    for (let i = 0; i < 30; i++) {
      physics.step(DT);
      world.update(player.x, player.z, Infinity);
    }
    for (const [q, r] of disc(bq, br, 5)) expect(world.isReadyAtCell(q, r)).toBe(true); // re-meshed
  });
});
