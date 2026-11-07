// Unit tests for src/bodies.js and the per-body sizes in src/physics.js — collisions, pushing, standing and riding
// (CONTRACTS §31).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { PIG_RADIUS, PIG_HEIGHT, PIG_MASS, PLAYER_MASS, COLLISION_EPS } from '../../src/config.js';
import { resolveBodies, bodyOverlap, bodyMass } from '../../src/bodies.js';
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
