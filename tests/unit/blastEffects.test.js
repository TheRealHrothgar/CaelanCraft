// What a blast does to bodies and to the speakers (CONTRACTS §31, §37.2.3, §37.3.3): every body gets the same push —
// a pig flashes and flees but gets no pigs.hit kick on top, and a player standing on a pig is not thrown with the
// pig's push added to its own — and a wet pile going off plays ONE fizzle per merged group, after the boom (a hundred
// fizzles at once took every audio voice, the boom's included). Fake world from the fixtures.
import { describe, it, expect } from 'vitest';
import { MAX_LIT_BARRELS, PIG_RADIUS, PIG_HEIGHT, PIG_MASS, PIG_HURT_S } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { hexToWorld } from '../../src/hex.js';
import { createPlayer, createBody, stepPlayer } from '../../src/physics.js';
import { resolveBodies } from '../../src/bodies.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10
const DT = 1 / 60;
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

function disc(q, r, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) out.push([q + dq, r + dr]);
  }
  return out;
}

function setup(bodies = [], player = null) {
  const world = makeFakeWorld({ groundY: GROUND, seed: 7 });
  const fx = { sounds: [], particles: [], knocks: [], frame: 0 };
  const hooks = {
    say() {},
    sound: (name) => fx.sounds.push({ name, frame: fx.frame }),
    particles: (kind, _x, _y, _z, count) => fx.particles.push({ kind, count, frame: fx.frame }),
    bodies: () => bodies,
    player: () => player,
    knock: (body, vx, vy, vz) => {
      fx.knocks.push({ body, vx, vy, vz });
      body.vx += vx;
      body.vy += vy;
      body.vz += vz;
      body.onGround = false;
    },
  };
  const physics = attachPhysics(world, BlockPhysics, hooks);
  return { world, physics, fx, ex: physics.explosions };
}

describe('the same push for every body (EXP-4)', () => {
  it('pigs.hit without its kick (a blast, a log) flashes the pig and makes it flee, but leaves its velocity alone', () => {
    const pigs = new Pigs(seededRng(2));
    const pig = pigs.spawn(3, GROUND + 1, 0);
    pig.vx = 1.5;
    pig.vy = -0.5;
    pig.vz = 0.25;
    pig.onGround = true;
    expect(pigs.hit(pig, 0, 0, false)).toBe(true);
    expect([pig.vx, pig.vy, pig.vz, pig.onGround]).toEqual([1.5, -0.5, 0.25, true]);
    expect(pig.hurt).toBe(PIG_HURT_S);
    expect(pig.mode).toBe('flee');
    expect(pig.targetYaw).toBeCloseTo(-Math.PI / 2, 9); // away from the blast (+x)
    expect(pigs.hit(pig, 0, 0, false)).toBe(false); // still flashing
  });

  /**
   * A player at hex distance 2 from a barrel, on the ground or standing on a pig, the barrel lit; main's frame order
   * (bodies step, physics step, resolveBodies). @returns {{ impulse: number, peak: number }} the player's own
   * horizontal knock and its peak speed over the GROUND (from its displacement; its vx is the pig-relative one while
   * it rides) in the first half second.
   */
  function throwPlayer(ride) {
    const [x0, z0] = hexToWorld(2, 0);
    const pig = createBody(x0, GROUND + 1, z0, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: PIG_MASS });
    const player = createPlayer(x0, GROUND + 1 + (ride ? PIG_HEIGHT : 0), z0);
    const list = ride ? [player, pig] : [player];
    const { world, physics, fx, ex } = setup(list, player);
    for (const [q, r] of disc(0, 0, 9)) for (let y = 6; y <= GROUND; y++) world.setBlock(q, y, r, B.OBSIDIAN); // a floor the blast leaves alone
    world.setBlock(0, GROUND + 1, 0, B.BLAST_BARREL);
    const frame = () => {
      for (const b of list) stepPlayer(b, IDLE, world.getBlock, DT);
      physics.step(DT);
      const all = [...list];
      physics.bodies(all);
      resolveBodies(all, world.getBlock);
    };
    for (let i = 0; i < 30; i++) frame();
    if (ride) expect(player.carrier).toBe(pig);
    expect(ex.ignite(0, GROUND + 1, 0).ok).toBe(true);
    while (ex.blastCount === 0) frame();
    const k = fx.knocks.find((e) => e.body === player);
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const [px, pz] = [player.x, player.z];
      frame();
      peak = Math.max(peak, Math.hypot(player.x - px, player.z - pz) / DT);
    }
    return { impulse: Math.hypot(k.vx, k.vz), peak };
  }

  it('a player standing on a pig is thrown with its own push, not its own plus the pig\'s', () => {
    const ground = throwPlayer(false);
    const ride = throwPlayer(true);
    expect(ground.peak).toBeLessThanOrEqual(ground.impulse * 1.02);
    expect(ride.peak).toBeGreaterThan(0.5 * ride.impulse);
    expect(ride.peak).toBeLessThanOrEqual(ride.impulse * 1.05); // was ~2.5× (the pig's push added once or twice)
  });

  it('a body that lands on a moving carrier keeps its velocity over the ground; leaving again changes nothing', () => {
    const g = createBody(0, GROUND, 0, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: PIG_MASS });
    const p = createPlayer(0.1, GROUND + PIG_HEIGHT - 0.02, 0);
    const flat = (_q, y) => (y < GROUND ? B.STONE : B.AIR);
    g.vx = 3;
    p.vx = 1;
    resolveBodies([p, g], flat); // lands: a new ride
    expect(p.carrier).toBe(g);
    expect(p.vx + g.vx).toBeCloseTo(1, 9); // still 1 m/s over the ground (relative −2 to the pig)
    resolveBodies([p, g], flat); // still riding: no second conversion
    expect(p.vx).toBeCloseTo(-2, 9);
    p.y += 0.5; // off it again: the release hands the pig's velocity back
    resolveBodies([p, g], flat);
    expect(p.carrier).toBeNull();
    expect(p.vx).toBeCloseTo(1, 9);
  });
});

describe('one fizzle per merged group, after the boom (EXP-5)', () => {
  it('seven wet barrels and two dry ones due together: one boom, then one fizzle, and steam from each wet one', () => {
    const { world, physics, fx, ex } = setup();
    physics.setSwitch('water', false); // the water stays exactly where it is put
    for (let i = 0; i < MAX_LIT_BARRELS; i++) world.setBlock(40 + 2 * i, GROUND + 1, 40, B.BLAST_BARREL);
    for (let i = 0; i < MAX_LIT_BARRELS; i++) ex.ignite(40 + 2 * i, GROUND + 1, 40);
    for (const rec of ex.lit) rec.fuse = 1e9; // every entity slot taken: the rest burn as fuse timers in place
    const wet = [];
    for (let q = 0; q <= 6; q++) wet.push([q, GROUND + 1, 4]);
    for (const [q, y, r] of wet) {
      world.setBlock(q, y, r, B.BLAST_BARREL);
      world.put(q, y + 1, r, B.WATER);
    }
    const dry = [[0, GROUND + 1, 0], [2, GROUND + 1, 0]];
    for (const [q, y, r] of dry) world.setBlock(q, y, r, B.BLAST_BARREL);
    for (const [q, y, r] of [...wet, ...dry]) expect(ex.ignite(q, y, r).ok).toBe(true);
    expect(ex.timers.size).toBe(9);
    fx.sounds.length = 0;
    fx.particles.length = 0;
    while (ex.blastCount === 0 && fx.frame < 400) {
      fx.frame++;
      physics.step(DT);
    }
    expect(ex.blastCount).toBe(1);
    expect(ex.lastBlast.barrels).toBe(2);
    const names = fx.sounds.filter((s) => s.frame === fx.frame && (s.name === 'boom' || s.name === 'fizzle')).map((s) => s.name);
    expect(names).toEqual(['boom', 'fizzle']); // was seven fizzles, all before the boom
    expect(fx.particles.filter((p) => p.kind === 'steam' && p.frame === fx.frame).length).toBe(7);
    expect(fx.sounds.filter((s) => s.name === 'fizzle').length).toBe(1);
  });
});
