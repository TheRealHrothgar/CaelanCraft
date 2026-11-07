// Unit tests for src/pigs.js — pig AI, physics, hits, ray targeting and save validation (CONTRACTS §30).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { PIG_MAX, PIG_RADIUS, PIG_HEIGHT, PIG_HURT_S, WORLD_HEIGHT } from '../../src/config.js';
import { Pigs, seededRng, validatePigsJSON } from '../../src/pigs.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { BlackHoles } from '../../src/blackholes.js';

const B = BLOCK;
const GROUND = 10;

/** Flat grass world: stone below GROUND − 1, grass at GROUND − 1, air above. */
const flat = (_q, y) => (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
const loaded = () => true;

function run(pigs, world, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) pigs.update(dt, world);
}

describe('Pigs.spawn / remove', () => {
  it('spawns at a position, assigns ids, refuses beyond PIG_MAX and non-finite input', () => {
    const pigs = new Pigs(seededRng(1));
    const a = pigs.spawn(1, GROUND, 2, 0.5);
    const b = pigs.spawn(3, GROUND, 4);
    expect(a).toMatchObject({ x: 1, y: GROUND, z: 2, yaw: 0.5, mode: 'idle', hurt: 0 });
    expect(b.id).not.toBe(a.id);
    expect(pigs.spawn(NaN, 0, 0)).toBeNull();
    for (let i = 2; i < PIG_MAX; i++) pigs.spawn(i, GROUND, 0);
    expect(pigs.size).toBe(PIG_MAX);
    expect(pigs.spawn(0, GROUND, 0)).toBeNull();
    expect(pigs.remove(a)).toBe(true);
    expect(pigs.remove(a)).toBe(false);
    expect(pigs.size).toBe(PIG_MAX - 1);
  });
});

describe('Pigs.update', () => {
  it('lands, then wanders around on flat ground without sinking or flying off', () => {
    const pigs = new Pigs(seededRng(7));
    const pig = pigs.spawn(0, GROUND + 3, 0);
    run(pigs, { getBlock: flat, isLoaded: loaded }, 30);
    expect(pig.y).toBeCloseTo(GROUND, 3); // resting gap COLLISION_EPS
    expect(pig.onGround).toBe(true);
    expect(Math.hypot(pig.x, pig.z)).toBeGreaterThan(0.5); // it moved
    expect(Math.hypot(pig.x, pig.z)).toBeLessThan(60);
    expect(pig.walkPhase).toBeGreaterThanOrEqual(0);
  });
  it('does not walk off a plateau edge (drops of more than one cell)', () => {
    // A 7-cell-radius plateau 5 cells above the lowland.
    const top = GROUND + 5;
    const getBlock = (q, y, r) => {
      const plateau = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 6;
      const h = plateau ? top : GROUND;
      return y < h ? B.STONE : B.AIR;
    };
    for (let seed = 1; seed <= 5; seed++) {
      const pigs = new Pigs(seededRng(seed));
      const pig = pigs.spawn(0, top, 0);
      run(pigs, { getBlock, isLoaded: loaded }, 60);
      expect(pig.y, `seed ${seed}`).toBeCloseTo(top, 3);
    }
  });
  it('freezes pigs in unloaded chunks and removes pigs that fall out of the world', () => {
    const pigs = new Pigs(seededRng(3));
    const frozen = pigs.spawn(100, GROUND + 5, 0);
    pigs.spawn(0, -15, 0); // already below the world: removed on the next update
    const world = { getBlock: () => B.AIR, isLoaded: (x) => x < 50 };
    run(pigs, world, 2);
    expect(frozen.y).toBe(GROUND + 5);
    expect(pigs.list).toEqual([frozen]);
  });
  it('reports ambient oinks now and then', () => {
    const pigs = new Pigs(seededRng(11));
    pigs.spawn(0, GROUND, 0);
    let oinks = 0;
    for (let t = 0; t < 60; t += 0.1) oinks += pigs.update(0.1, { getBlock: flat, isLoaded: loaded }).length;
    expect(oinks).toBeGreaterThanOrEqual(2);
    expect(oinks).toBeLessThanOrEqual(15);
  });
  it('black holes pull pigs in through world.pullAt', () => {
    const holes = new BlackHoles();
    const [hx, hz] = hexToWorld(0, 0);
    holes.add(0, GROUND, 0);
    const pigs = new Pigs(seededRng(5));
    const pig = pigs.spawn(hx + 2.5, GROUND, hz);
    const world = { getBlock: flat, isLoaded: loaded, pullAt: (x, y, z, out) => holes.pullAt(x, y, z, out) };
    let swallowed = false;
    for (let i = 0; i < 300 && !swallowed; i++) {
      pigs.update(1 / 60, world);
      swallowed = holes.swallowing(pig) !== null;
    }
    expect(swallowed).toBe(true);
  });
});

describe('Pigs.hit', () => {
  it('knocks the pig away from the hitter, flashes, flees, and ignores hits during the flash', () => {
    const pigs = new Pigs(seededRng(2));
    const pig = pigs.spawn(3, GROUND, 0);
    pig.onGround = true;
    expect(pigs.hit(pig, 0, 0)).toBe(true);
    expect(pig.vx).toBeGreaterThan(0);
    expect(pig.vz).toBeCloseTo(0, 9);
    expect(pig.vy).toBeGreaterThan(0);
    expect(pig.hurt).toBe(PIG_HURT_S);
    expect(pig.mode).toBe('flee');
    // Flee heading points away from the hitter (+x): yawToForward(yaw) = (−sin, −cos) ⇒ yaw = −π/2.
    expect(pig.targetYaw).toBeCloseTo(-Math.PI / 2, 9);
    expect(pigs.hit(pig, 0, 0)).toBe(false);
    run(pigs, { getBlock: flat, isLoaded: loaded }, 2);
    expect(pig.hurt).toBe(0);
    expect(pig.x).toBeGreaterThan(4); // it got knocked / ran away from the hitter
  });
});

describe('Pigs.raycast', () => {
  it('hits the nearest pig cylinder along the ray within maxDist', () => {
    const pigs = new Pigs(seededRng(1));
    const near = pigs.spawn(0, 0, -3);
    pigs.spawn(0, 0, -6);
    const h = pigs.raycast(0, 0.5, 0, 0, 0, -1, 10);
    expect(h.pig).toBe(near);
    expect(h.distance).toBeCloseTo(3 - PIG_RADIUS, 9);
    expect(pigs.raycast(0, 0.5, 0, 0, 0, -1, 2)).toBeNull();
    expect(pigs.raycast(0, 0.5, 0, 0, 0, 1, 10)).toBeNull(); // behind
    expect(pigs.raycast(0, PIG_HEIGHT + 0.2, 0, 0, 0, -1, 10)).toBeNull(); // over its back
  });
  it('hits through the top cap when looking down on a pig', () => {
    const pigs = new Pigs(seededRng(1));
    const pig = pigs.spawn(0, 0, 0);
    const h = pigs.raycast(0.1, 3, 0.1, 0, -1, 0, 5);
    expect(h.pig).toBe(pig);
    expect(h.distance).toBeCloseTo(3 - PIG_HEIGHT, 9);
  });
});

describe('export / load / validatePigsJSON', () => {
  it('round-trips positions (rounded to mm)', () => {
    const pigs = new Pigs(seededRng(1));
    pigs.spawn(1.23456, GROUND, -7.0001, 1);
    const json = pigs.export();
    expect(json).toEqual([{ x: 1.235, y: GROUND, z: -7, yaw: 1 }]);
    const back = new Pigs();
    back.load(validatePigsJSON(JSON.parse(JSON.stringify(json))).pigs);
    expect(back.list).toHaveLength(1);
    expect(back.list[0]).toMatchObject({ x: 1.235, y: GROUND, z: -7, yaw: 1 });
  });
  it('drops invalid entries and caps at PIG_MAX', () => {
    const v = validatePigsJSON([{ x: 0, y: 1, z: 2, yaw: 0 }, { x: 'a', y: 1, z: 2, yaw: 0 }, null, { x: 0, y: WORLD_HEIGHT + 1, z: 0, yaw: 0 }]);
    expect(v.pigs).toEqual([{ x: 0, y: 1, z: 2, yaw: 0 }]);
    expect(v.warnings).toHaveLength(3);
    expect(validatePigsJSON({}).pigs).toEqual([]);
    const many = Array.from({ length: PIG_MAX + 3 }, () => ({ x: 0, y: 0, z: 0, yaw: 0 }));
    expect(validatePigsJSON(many).pigs).toHaveLength(PIG_MAX);
  });
});

describe('Pigs.spawnNatural', () => {
  it('places pigs only on grass, within range, deterministically from the seed', () => {
    const sandEast = (q, y, r) => {
      if (y < GROUND - 1) return B.STONE;
      if (y === GROUND - 1) return hexToWorld(q, r)[0] > 0 ? B.SAND : B.GRASS_BLOCK;
      return B.AIR;
    };
    const a = new Pigs();
    expect(a.spawnNatural(5, 0, 0, 42, sandEast, () => true)).toBe(5);
    for (const p of a.list) {
      const [q, r] = worldToHex(p.x, p.z);
      expect(sandEast(q, GROUND - 1, r)).toBe(B.GRASS_BLOCK);
      expect(p.y).toBe(GROUND);
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(19);
    }
    const b = new Pigs();
    b.spawnNatural(5, 0, 0, 42, sandEast, () => true);
    expect(b.export()).toEqual(a.export());
    // No grass anywhere → no pigs (and no endless loop).
    const c = new Pigs();
    expect(c.spawnNatural(5, 0, 0, 42, (_q, y) => (y < GROUND ? B.SAND : B.AIR), () => true)).toBe(0);
  });
});
