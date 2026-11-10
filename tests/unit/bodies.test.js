// Unit tests for src/bodies.js and the per-body sizes in src/physics.js — collisions, pushing, standing and riding
// (CONTRACTS §31).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { PIG_RADIUS, PIG_HEIGHT, PIG_MASS, PLAYER_MASS, COLLISION_EPS } from '../../src/config.js';
import {
  resolveBodies, bodyOverlap, bodyMass, detachBody, pairAngle, BODY_MAX_SHOVE, CARRY_MAX_MOVE,
} from '../../src/bodies.js';
import {
  createPlayer, createBody, stepPlayer, displaceBody, bodyRadius, bodyHeight, isFreeAt, PLAYER_RADIUS, MAX_BODY_RADIUS,
} from '../../src/physics.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';

const B = BLOCK;
const GROUND = 10;
/** Flat world: solid below GROUND. */
const flat = (_q, y) => (y < GROUND ? B.STONE : B.AIR);
const pig = (x, y, z) => createBody(x, y, z, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: PIG_MASS });
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

/** Max pairwise overlap among bodies (≤ 0 when nobody intersects). */
function worstOverlap(bodies) {
  let worst = -Infinity;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const o = bodyOverlap(bodies[i], bodies[j]);
      if (o.vertical > 0) worst = Math.max(worst, o.horizontal);
    }
  }
  return worst;
}

describe('per-body sizes in physics', () => {
  it('createBody validates its size; a plain player state is player-sized', () => {
    const p = createPlayer(0, 0, 0);
    expect(bodyRadius(p)).toBe(PLAYER_RADIUS);
    expect(bodyMass(p)).toBe(PLAYER_MASS);
    const g = pig(0, 0, 0);
    expect([bodyRadius(g), bodyHeight(g), bodyMass(g)]).toEqual([PIG_RADIUS, PIG_HEIGHT, PIG_MASS]);
    expect(() => createBody(0, 0, 0, { radius: MAX_BODY_RADIUS + 0.01, height: 1 })).toThrow(RangeError);
    expect(() => createBody(0, 0, 0, { radius: 0.3, height: 0 })).toThrow(RangeError);
  });
  it('a pig walks under a one-cell overhang that stops the player', () => {
    // Ground at GROUND; a roof cell at GROUND + 1 over every column with q >= 2 (a one-cell-high crawlspace).
    const getBlock = (q, y) => (y < GROUND || (y === GROUND + 1 && q >= 2) ? B.STONE : B.AIR);
    const [x0, z0] = hexToWorld(0, 0);
    // yaw −π/2 faces +x (yawToForward = (−sin, −cos)), toward increasing q.
    const walk = { ...IDLE, forward: 1, yaw: -Math.PI / 2 };
    const g = pig(x0, GROUND, z0);
    const p = createPlayer(x0, GROUND, z0);
    for (let i = 0; i < 180; i++) {
      stepPlayer(g, walk, getBlock, 1 / 60);
      stepPlayer(p, walk, getBlock, 1 / 60);
    }
    expect(worldToHex(g.x, g.z)[0]).toBeGreaterThanOrEqual(4);
    expect(worldToHex(p.x, p.z)[0]).toBeLessThan(2);
    expect(g.y).toBeCloseTo(GROUND, 3);
  });
  it('isFreeAt honours the given size', () => {
    const roof = (q, y) => (y < GROUND || y === GROUND + 1 ? B.STONE : B.AIR);
    expect(isFreeAt(roof, 0, GROUND, 0)).toBe(false);
    expect(isFreeAt(roof, 0, GROUND, 0, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
  });
  it('displaceBody slides through terrain and lands on floors', () => {
    const wall = (q, y) => (y < GROUND || q >= 3 ? B.STONE : B.AIR);
    const g = pig(0, GROUND + 0.5, 0);
    g.vy = -3;
    const res = displaceBody(g, 10, -1, 0, wall);
    expect(res).toEqual({ hitWall: true, hitFloorOrCeiling: true });
    expect(isFreeAt(wall, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
    expect(g.y).toBeCloseTo(GROUND + COLLISION_EPS, 9);
    expect(g.onGround).toBe(true);
    expect(g.vy).toBe(0);
  });
});

describe('resolveBodies — sideways pushes', () => {
  it('separates an overlapping pair, each moving in proportion to the other one\'s mass', () => {
    const p = createPlayer(0, GROUND, 0);
    const g = pig(0.5, GROUND, 0);
    const overlap = PLAYER_RADIUS + PIG_RADIUS - 0.5;
    expect(resolveBodies([p, g], flat)).toBe(1);
    expect(g.x - p.x).toBeCloseTo(PLAYER_RADIUS + PIG_RADIUS + COLLISION_EPS, 9);
    const total = overlap + COLLISION_EPS;
    expect(-p.x).toBeCloseTo(total * (PIG_MASS / (PIG_MASS + PLAYER_MASS)), 9);
    expect(g.x - 0.5).toBeCloseTo(total * (PLAYER_MASS / (PIG_MASS + PLAYER_MASS)), 9);
    expect(p.z).toBe(0);
    expect(resolveBodies([p, g], flat)).toBe(0); // resolved
  });
  it('ignores bodies that only overlap in plan but not in height', () => {
    const p = createPlayer(0, GROUND, 0);
    const g = pig(0.2, GROUND + 5, 0);
    expect(resolveBodies([p, g], flat)).toBe(0);
    expect(g.x).toBe(0.2);
  });
  it('removes the approaching relative velocity and keeps momentum (inelastic)', () => {
    const p = createPlayer(0, GROUND, 0);
    const g = pig(0.6, GROUND, 0);
    p.vx = 3;
    resolveBodies([p, g], flat);
    expect(p.vx).toBeCloseTo(g.vx, 9);
    expect(PLAYER_MASS * p.vx + PIG_MASS * g.vx).toBeCloseTo(3 * PLAYER_MASS, 9);
    // Separating bodies keep their velocities.
    const a = createPlayer(0, GROUND, 0);
    const b = pig(0.6, GROUND, 0);
    a.vx = -1;
    b.vx = 1;
    resolveBodies([a, b], flat);
    expect([a.vx, b.vx]).toEqual([-1, 1]);
  });
  it('a pig pinned against a wall does not enter it: the player takes the whole separation', () => {
    // Wall from q = 2; put the pig flush against it.
    const wall = (q, y) => (y < GROUND || q >= 2 ? B.STONE : B.AIR);
    const g = pig(0, GROUND, 0);
    for (let i = 0; i < 40; i++) displaceBody(g, 0.1, 0, 0, wall); // small steps settle it into the wall's notch
    expect(g.x).toBeGreaterThan(0.9);
    const gx = g.x;
    const gz = g.z;
    const p = createPlayer(gx - 0.5, GROUND, 0);
    p.z = gz;
    resolveBodies([p, g], wall);
    expect(g.x).toBeCloseTo(gx, 6);
    expect(isFreeAt(wall, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
    expect(g.x - p.x).toBeCloseTo(PLAYER_RADIUS + PIG_RADIUS + COLLISION_EPS, 6);
  });
  it('a walking player shoves a pig along and never walks through it', () => {
    const p = createPlayer(0, GROUND, 0);
    const g = pig(1.5, GROUND, 0);
    const walk = { ...IDLE, forward: 1, yaw: -Math.PI / 2 }; // +x
    for (let i = 0; i < 120; i++) {
      stepPlayer(p, walk, flat, 1 / 60);
      stepPlayer(g, IDLE, flat, 1 / 60);
      resolveBodies([p, g], flat);
      expect(worstOverlap([p, g])).toBeLessThanOrEqual(1e-9);
    }
    expect(g.x).toBeGreaterThan(5); // pushed several units
    expect(g.x).toBeGreaterThan(p.x);
    expect(Math.abs(g.z)).toBeLessThan(1e-9);
  });
  it('coincident centres separate along the pair\'s own direction (+x by default)', () => {
    const a = pig(1, GROUND, 2);
    const b = pig(1, GROUND, 2);
    expect(bodyOverlap(a, b)).toMatchObject({ nx: 1, nz: 0, dist: 0 });
    const o = bodyOverlap(a, b, 2);
    expect(o.nx).toBeCloseTo(Math.cos(2), 12);
    expect(o.nz).toBeCloseTo(Math.sin(2), 12);
    // Far enough apart, the real line between the centres wins outright.
    b.x += 0.3;
    expect(bodyOverlap(a, b, 2)).toMatchObject({ nx: 1, nz: 0 });
    expect(new Set([pairAngle(0, 1), pairAngle(0, 2), pairAngle(1, 2), pairAngle(3, 7)]).size).toBe(4);
  });
  it('32 bodies dropped on one point ease apart in every direction, never popping more than BODY_MAX_SHOVE a frame', () => {
    // Play-test A5: 32 `summon pig` lines in one rune frame put every pig on the same point; they used to shoot out
    // in one line along +x, up to 3 units in a frame.
    const list = [];
    for (let i = 0; i < 32; i++) list.push(pig(2, GROUND, -1.732));
    let maxShove = 0;
    let settled = null;
    for (let f = 0; f < 60; f++) {
      for (const g of list) stepPlayer(g, IDLE, flat, 1 / 60);
      const before = list.map((g) => [g.x, g.z]);
      resolveBodies(list, flat);
      list.forEach((g, i) => { maxShove = Math.max(maxShove, Math.hypot(g.x - before[i][0], g.z - before[i][1])); });
      if (settled === null && worstOverlap(list) < 0.02) settled = f;
    }
    expect(maxShove).toBeLessThanOrEqual(BODY_MAX_SHOVE + 1e-9);
    expect(settled).not.toBeNull();
    expect(settled).toBeLessThan(40);
    const span = (k) => Math.max(...list.map((g) => g[k])) - Math.min(...list.map((g) => g[k]));
    expect(span('x')).toBeGreaterThan(2.5);
    expect(span('z')).toBeGreaterThan(2.5); // a disc, not a row
    expect(span('x')).toBeLessThan(8);
    for (const g of list) expect(g.y).toBeCloseTo(GROUND, 3);
  });
  it('a crowd of pigs dropped on one spot in a pen spreads out without overlaps or wall intrusions', () => {
    // A hex pen of radius 3 cells.
    const pen = (q, y, r) => {
      const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      return y < GROUND || (d > 3 && y < GROUND + 3) ? B.STONE : B.AIR;
    };
    const list = [];
    for (let i = 0; i < 8; i++) list.push(pig(0.01 * i, GROUND, 0.013 * i));
    for (let f = 0; f < 90; f++) {
      for (const g of list) stepPlayer(g, IDLE, pen, 1 / 60);
      resolveBodies(list, pen);
    }
    expect(worstOverlap(list)).toBeLessThan(0.02);
    for (const g of list) {
      expect(isFreeAt(pen, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
      expect(g.y).toBeGreaterThanOrEqual(GROUND - 1e-9);
    }
  });
});

describe('resolveBodies — standing and riding', () => {
  it('a player dropped onto a pig lands on its back and stays there', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0.05, GROUND + 2, 0);
    for (let i = 0; i < 120; i++) {
      stepPlayer(g, IDLE, flat, 1 / 60);
      stepPlayer(p, IDLE, flat, 1 / 60);
      resolveBodies([p, g], flat);
    }
    expect(p.y).toBeCloseTo(GROUND + PIG_HEIGHT, 1);
    expect(p.y).toBeGreaterThan(GROUND + PIG_HEIGHT - 0.05);
    expect(p.onGround).toBe(true);
    expect(g.y).toBeCloseTo(GROUND, 3);
    // Standing on the pig still lets the player jump.
    stepPlayer(p, { ...IDLE, jump: true }, flat, 1 / 60);
    expect(p.vy).toBeGreaterThan(0);
  });
  it('a rider is carried by its moving carrier', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0, GROUND + PIG_HEIGHT - 0.01, 0);
    resolveBodies([p, g], flat);
    expect(p.carrier).toBe(g);
    g.x += 0.5;
    g.z -= 0.25;
    resolveBodies([p, g], flat);
    expect(p.x).toBeCloseTo(0.5, 9);
    expect(p.z).toBeCloseTo(-0.25, 9);
    expect(p.carrier).toBe(g);
    // A carrier that leaves the list no longer carries.
    g.x += 1;
    resolveBodies([p], flat);
    expect(p.x).toBeCloseTo(0.5, 9);
    expect(p.carrier).toBeNull();
  });
  /** A pig resting on the head of a player standing at the origin (settled for 1 s, as main.js steps them). */
  function pigOnHead(getBlock = flat) {
    const pigs = new Pigs(seededRng(1));
    const p = createPlayer(0, GROUND, 0);
    const g = pigs.spawn(0, GROUND + 1.8 + 0.3, 0);
    g.timer = 1e9; // stays idle: only the physics acts
    const frame = (input = IDLE) => {
      stepPlayer(p, input, getBlock, 1 / 60);
      pigs.update(1 / 60, { getBlock, isLoaded: () => true });
      resolveBodies([p, g], getBlock);
    };
    for (let i = 0; i < 60; i++) frame();
    expect(g.carrier).toBe(p);
    return { p, g, frame };
  }
  it('a rider stays on a jumping carrier: no gap opens and the link holds (play-test A6)', () => {
    for (const walkFirst of [false, true]) {
      const { p, g, frame } = pigOnHead();
      const walk = { ...IDLE, forward: 1 };
      if (walkFirst) for (let i = 0; i < 120; i++) frame(walk);
      let maxGap = 0;
      for (let i = 0; i < 50; i++) {
        frame({ ...(walkFirst ? walk : IDLE), jump: i === 0 });
        maxGap = Math.max(maxGap, g.y - (p.y + 1.8));
        expect(g.carrier, `frame ${i}`).toBe(p);
      }
      expect(maxGap).toBeLessThan(0.011);
      expect(Math.hypot(g.x - p.x, g.z - p.z)).toBeLessThan(1e-6);
      expect(g.y).toBeCloseTo(p.y + 1.8, 2);
    }
  });
  it('jumping off a walking carrier keeps its horizontal velocity, so the rider lands back on it', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0, GROUND + PIG_HEIGHT - 0.01, 0);
    const walk = { ...IDLE, forward: 1, sneak: true }; // the pig ambles along −z
    for (let i = 0; i < 60; i++) {
      stepPlayer(g, walk, flat, 1 / 60);
      stepPlayer(p, IDLE, flat, 1 / 60);
      resolveBodies([p, g], flat);
    }
    expect(p.carrier).toBe(g);
    stepPlayer(g, walk, flat, 1 / 60);
    stepPlayer(p, { ...IDLE, jump: true }, flat, 1 / 60);
    resolveBodies([p, g], flat);
    expect(p.carrier).toBeNull();
    expect(p.vz).toBeCloseTo(g.vz, 6); // the pig's motion, not a dead stop
    let relanded = false;
    for (let i = 0; i < 90 && !relanded; i++) {
      stepPlayer(g, walk, flat, 1 / 60);
      stepPlayer(p, IDLE, flat, 1 / 60);
      resolveBodies([p, g], flat);
      relanded = p.carrier === g;
    }
    expect(relanded).toBe(true);
  });
  it('a carrier that teleports leaves its rider behind (play-test A3)', () => {
    const { p, g, frame } = pigOnHead();
    // detachBody is what game.teleport calls: no link survives either way.
    const q = pig(0, GROUND - 0.9, 0);
    p.carrier = q;
    detachBody(p, [g]);
    expect(p.carrier).toBeNull();
    expect(g.carrier).toBeNull();
    // Without the detach, a jump beyond CARRY_MAX_MOVE is still not carried.
    const { p: p2, g: g2 } = pigOnHead();
    const [gx, gy, gz] = [g2.x, g2.y, g2.z];
    p2.x += CARRY_MAX_MOVE + 18;
    resolveBodies([p2, g2], flat);
    expect([g2.x, g2.y, g2.z]).toEqual([gx, gy, gz]);
    expect(g2.carrier).toBeNull();
    frame(); // the first pair carries on without errors
  });
  it('a rider carried fast into a wall slides against it instead of tunnelling through', () => {
    // A one-cell-thick beam at head height (q = 3, y = GROUND + 2): the player passes under it, the pig on its head
    // does not. The player moves 1.2 a frame (fly-sprinting at 10 fps).
    const beam = (q, y) => (y < GROUND || (q === 3 && y === GROUND + 2) ? B.STONE : B.AIR);
    const { p, g } = pigOnHead(beam);
    for (let i = 0; i < 6; i++) {
      p.x += 1.2;
      resolveBodies([p, g], beam);
      expect(isFreeAt(beam, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
      expect(g.x).toBeLessThan(2.5); // never past the beam's near face
    }
  });
  it('sideways contact low on the other body is a push, not a stand', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0.6, GROUND + 0.1, 0); // feet below half the pig's height
    resolveBodies([p, g], flat);
    expect(p.y).toBe(GROUND + 0.1);
    expect(p.x - g.x).toBeCloseTo(PLAYER_RADIUS + PIG_RADIUS + COLLISION_EPS, 9);
  });
  it('when a ceiling blocks the lift, the bodies are pushed apart sideways instead', () => {
    const ceiling = (q, y) => (y < GROUND || y >= GROUND + 2 ? B.STONE : B.AIR);
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0.1, GROUND + 0.2, 0);
    p.y = GROUND + 2 - 1.8 - COLLISION_EPS; // head touching the ceiling
    const y0 = p.y;
    resolveBodies([p, g], ceiling);
    expect(p.y).toBeCloseTo(y0, 9);
    expect(bodyOverlap(p, g).horizontal).toBeLessThanOrEqual(1e-9);
  });
});

describe('pigs use their body', () => {
  it('pigs are pig-sized and the ray targets that body', () => {
    const pigs = new Pigs(seededRng(1));
    const g = pigs.spawn(0, GROUND, -3);
    expect([bodyRadius(g), bodyHeight(g), bodyMass(g)]).toEqual([PIG_RADIUS, PIG_HEIGHT, PIG_MASS]);
    expect(pigs.raycast(0, GROUND + 0.5, 0, 0, 0, -1, 10).distance).toBeCloseTo(3 - PIG_RADIUS, 9);
  });
  it('pigs stay inside a two-high pen: no hopping at it, no climbing on each other (play-test A2)', () => {
    // A radius-4 hexring of oak planks, two high, on flat ground; 8 pigs inside, stepped like main.js.
    const ring = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    const pen = (q, y, r) => (y < GROUND || (ring(q, r) === 4 && y < GROUND + 2) ? B.STONE : B.AIR);
    const pigs = new Pigs(seededRng(3));
    const inner = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1], [2, -1]];
    for (const [q, r] of inner) pigs.spawn(...hexToWorld(q, r).flatMap((v, i) => (i === 0 ? [v, GROUND] : [v])), q + r);
    let maxY = 0;
    for (let f = 0; f < 60 * 60; f++) { // before the fix the first pig was out within 4 s, 6 of 8 within a minute
      pigs.update(1 / 60, { getBlock: pen, isLoaded: () => true });
      resolveBodies(pigs.list, pen);
      for (const g of pigs.list) maxY = Math.max(maxY, g.y);
    }
    for (const g of pigs.list) {
      const [q, r] = worldToHex(g.x, g.z);
      expect(ring(q, r)).toBeLessThan(4);
      expect(isFreeAt(pen, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
    }
    expect(maxY).toBeLessThan(GROUND + 0.5); // nobody even got onto another pig's back
  }, 20000);
  it('pigs in a walled pool do not escape on each other\'s backs: no swim exit jump while carrying or riding (play-test PB-1)', () => {
    // A radius-3 pool, water three deep with its surface cell at GROUND − 1, inside a rim that stands to GROUND + 1:
    // the bank floor is ~2.1 above the water surface, out of one pig's swim exit jump.
    const ring = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    const pool = (q, y, r) => {
      const d = ring(q, r);
      if (d <= 3) return y < GROUND - 3 ? B.STONE : y < GROUND ? B.WATER : B.AIR;
      return y <= GROUND + 1 ? B.STONE : B.AIR;
    };
    const escapes = [];
    for (const seed of [1, 2, 3]) {
      const pigs = new Pigs(seededRng(seed));
      for (const [q, r] of [[0, 0], [1, 0], [0, 1], [-1, 0]]) pigs.spawn(...hexToWorld(q, r).flatMap((v, i) => (i === 0 ? [v, GROUND - 1] : [v])), q);
      for (let f = 0; f < 90 * 60; f++) {
        pigs.update(1 / 60, { getBlock: pool, isLoaded: () => true });
        resolveBodies(pigs.list, pool);
      }
      escapes.push(pigs.list.filter((g) => ring(...worldToHex(g.x, g.z)) >= 4).length);
    }
    expect(escapes).toEqual([0, 0, 0]);
  }, 60000);
  it('a pig with a block placed in it climbs out', () => {
    const cells = new Set();
    const getBlock = (q, y, r) => (y < GROUND || cells.has(`${q},${y},${r}`) ? B.STONE : B.AIR);
    const pigs = new Pigs(seededRng(1));
    const g = pigs.spawn(0, GROUND, 0);
    cells.add(`0,${GROUND},0`);
    pigs.update(1 / 60, { getBlock, isLoaded: () => true });
    expect(g.y).toBeGreaterThanOrEqual(GROUND + 1);
    expect(isFreeAt(getBlock, g.x, g.y, g.z, PIG_RADIUS, PIG_HEIGHT)).toBe(true);
  });
});

describe('landSpeed on bodies (v0.9 survival, DESIGN-survival §9.3)', () => {
  it('landing on a body records the speed the stand cut off (falls onto mobs hurt)', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0, GROUND + PIG_HEIGHT - 0.2, 0);
    p.vy = -15;
    p.landSpeed = 0;
    resolveBodies([p, g], flat);
    expect(p.carrier).toBe(g);
    expect(p.landSpeed).toBe(15);
    expect(p.vy).toBe(0);
  });

  it('keeps the larger of a terrain landing and a body landing; no record when nothing was cut', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0, GROUND + PIG_HEIGHT - 0.2, 0);
    p.vy = -6;
    p.landSpeed = 9;
    resolveBodies([p, g], flat);
    expect(p.landSpeed).toBe(9);
    // A rider moving up with a jumping carrier is not landing.
    const h = pig(0, GROUND, 0);
    h.vy = 4;
    const q = createPlayer(0, GROUND + PIG_HEIGHT - 0.2, 0);
    q.vy = 1;
    resolveBodies([q, h], flat);
    expect(q.carrier).toBe(h);
    expect(q.landSpeed).toBeUndefined();
  });

  it('a body without the field gets it; the clamp to a falling carrier only records when it cut something', () => {
    const g = pig(0, GROUND + 5, 0);
    g.vy = -10; // falling carrier
    const p = createPlayer(0, GROUND + 5 + PIG_HEIGHT - 0.2, 0);
    p.vy = -8; // slower than the carrier: nothing cut
    resolveBodies([p, g], flat);
    expect(p.landSpeed).toBeUndefined();
    p.vy = -12;
    p.y = g.y + PIG_HEIGHT - 0.2;
    resolveBodies([p, g], flat);
    expect(p.landSpeed).toBe(12);
    expect(p.vy).toBe(-10);
  });

  it('resting on a pig across frames records only the small gravity step each frame', () => {
    const g = pig(0, GROUND, 0);
    const p = createPlayer(0, GROUND + 2, 0);
    let max = 0;
    for (let i = 0; i < 120; i++) {
      stepPlayer(g, IDLE, flat, 1 / 60);
      stepPlayer(p, IDLE, flat, 1 / 60);
      resolveBodies([p, g], flat);
      if (i > 60) max = Math.max(max, p.landSpeed);
    }
    expect(p.carrier).toBe(g);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(1);
  });
});
