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

describe('Pigs.update — water (play-test A1)', () => {
  /** Flat grass world with a hex pond of radius R around the origin, D cells deep, surface `drop` below the rim. */
  const pond = (R, D, drop = 0) => (q, y, r) => {
    const inPond = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= R;
    if (inPond && y >= GROUND - D - drop && y < GROUND) return y < GROUND - drop ? B.WATER : B.AIR;
    return flat(q, y, r);
  };
  /** Seconds until the pig stands on dry ground, or null. */
  function escape(getBlock, q, r, seed, seconds = 60) {
    const pigs = new Pigs(seededRng(seed));
    const [x, z] = hexToWorld(q, r);
    const pig = pigs.spawn(x, GROUND - 2.5, z, seed);
    for (let f = 0; f < seconds * 60; f++) {
      pigs.update(1 / 60, { getBlock, isLoaded: loaded });
      if (pig.onGround && !pig.inWater && pig.y >= GROUND - 1e-3) return f / 60;
    }
    return null;
  }
  it('a pig dropped anywhere in a 3-deep pond swims to the bank and climbs out', () => {
    const getBlock = pond(5, 3);
    // Centre, middle and near the edge (before the fix only pigs starting on the shore ring got out).
    for (const [q, r, seed] of [[0, 0, 1], [2, -1, 2], [-3, 1, 3], [0, 4, 4], [4, -4, 5]]) {
      const t = escape(getBlock, q, r, seed);
      expect(t, `start ${q},${r}`).not.toBeNull();
      expect(t).toBeLessThan(30);
    }
  });
  it('climbs a bank one cell above the water surface (SWIM_EXIT_JUMP)', () => {
    const getBlock = pond(3, 3, 1); // water up to GROUND − 2, an air gap, then the rim at GROUND
    expect(escape(getBlock, 0, 0, 9)).not.toBeNull();
  });
  it('with no bank in reach it stays afloat instead of resting on the bottom', () => {
    const getBlock = pond(40, 6);
    const pigs = new Pigs(seededRng(3));
    const pig = pigs.spawn(0, GROUND - 6, 0);
    let bottomFrames = 0;
    for (let f = 0; f < 30 * 60; f++) {
      pigs.update(1 / 60, { getBlock, isLoaded: loaded });
      if (f > 5 * 60 && pig.onGround) bottomFrames++;
    }
    expect(bottomFrames).toBe(0);
    expect(pig.y).toBeGreaterThan(GROUND - 1.5); // bobbing at the surface (top water cell GROUND − 1)
    expect(pig.mode).toBe('walk'); // paddling, never idle in water
  });
  it('a pig still refuses to walk into water from the shore', () => {
    const getBlock = pond(3, 3);
    const pigs = new Pigs(seededRng(4));
    const [x, z] = hexToWorld(6, 0);
    const pig = pigs.spawn(x, GROUND, z, Math.PI / 2); // yawToForward(π/2) = (−1, 0): toward the pond
    pig.mode = 'walk';
    pig.timer = 100;
    let wet = 0;
    for (let f = 0; f < 20 * 60; f++) {
      pigs.update(1 / 60, { getBlock, isLoaded: loaded });
      if (pig.inWater) wet++;
    }
    expect(wet).toBe(0);
  });
});

describe('Pigs.update — walls and hops (play-test A2)', () => {
  const walker = (pigs, x, z, yaw) => {
    const pig = pigs.spawn(x, GROUND, z, yaw);
    pig.mode = 'walk';
    pig.timer = 100;
    return pig;
  };
  /** Wall of height h over every column with q >= 3. */
  const wall = (h) => (q, y, r) => (q >= 3 && y >= GROUND && y < GROUND + h ? B.OAK_PLANKS : flat(q, y, r));
  it('a pig walking at a two-high wall turns away instead of hopping at it', () => {
    const pigs = new Pigs(seededRng(6));
    const pig = walker(pigs, 0, 0, -Math.PI / 2); // facing +x, toward the wall
    let maxY = 0;
    let vyUp = 0;
    for (let f = 0; f < 20 * 60; f++) {
      pigs.update(1 / 60, { getBlock: wall(2), isLoaded: loaded });
      maxY = Math.max(maxY, pig.y);
      if (pig.vy > 0.5) vyUp++;
    }
    expect(vyUp).toBe(0);
    expect(maxY).toBeLessThan(GROUND + 0.01);
    expect(worldToHex(pig.x, pig.z)[0]).toBeLessThan(3);
  });
  it('still hops up a one-cell ledge', () => {
    const pigs = new Pigs(seededRng(6));
    const pig = walker(pigs, 0, 0, -Math.PI / 2);
    for (let f = 0; f < 6 * 60 && !(pig.onGround && pig.y > GROUND + 0.5); f++) {
      pigs.update(1 / 60, { getBlock: wall(1), isLoaded: loaded });
    }
    expect(pig.y).toBeCloseTo(GROUND + 1, 3); // standing on the ledge (the floor is at GROUND)
  });
  it('never hops while standing on another body: the ledge counts as a wall', () => {
    const pigs = new Pigs(seededRng(6));
    const pig = walker(pigs, 1.5, 0, -Math.PI / 2);
    let jumped = false;
    for (let f = 0; f < 3 * 60; f++) {
      pig.carrier = {}; // what bodies.js leaves set after standOn
      pigs.update(1 / 60, { getBlock: wall(1), isLoaded: loaded });
      if (pig.vy > 0.5) jumped = true;
    }
    expect(jumped).toBe(false);
    expect(pig.y).toBeLessThan(GROUND + 0.01);
  });
});

describe('Pigs.update — campfires (play-test C5)', () => {
  const withFires = (fires) => (q, y, r) => (y === GROUND && fires.has(`${q},${r}`) ? B.CAMPFIRE : flat(q, y, r));
  it('a pig that sets off while still turning does not cut the corner of a fire cell', () => {
    // From the play-test trace: at rest just west of fire cell (6, 0), a new walk heading (−1.63) is picked while the
    // pig faces −0.9. It moves once within 1.2 rad, so the single 0.8 look-ahead point swept an arc below the fire's
    // bottom corner and the centre then walked through it. A family of nearby starts: before the fix 40% got burnt.
    const getBlock = withFires(new Set(['6,0']));
    let starts = 0;
    for (let dx = -0.1; dx <= 0.1001; dx += 0.04) {
      for (let dz = -0.06; dz <= 0.0601; dz += 0.02) {
        for (const yaw of [-0.8, -0.9, -1.0]) {
          const pigs = new Pigs(seededRng(1));
          const pig = pigs.spawn(5.18 + dx, GROUND, -0.54 + dz, yaw);
          Object.assign(pig, { onGround: true, mode: 'walk', timer: 100, targetYaw: -1.63 });
          for (let f = 0; f < 120 && pig.mode === 'walk'; f++) {
            pigs.update(1 / 60, { getBlock, isLoaded: loaded });
            expect(pigs.scorched, `start +${dx.toFixed(2)},+${dz.toFixed(2)} yaw ${yaw}`).toHaveLength(0);
          }
          starts++;
        }
      }
    }
    expect(starts).toBe(126);
  });
  it('a pig does not step down a one-cell ledge onto a campfire', () => {
    // Plateau one cell high for q < 3; the fire sits on the low ground at (3, 0), right below the edge.
    const getBlock = (q, y, r) => {
      if (y === GROUND && q < 3) return B.STONE;
      if (y === GROUND && q === 3 && r === 0) return B.CAMPFIRE;
      return flat(q, y, r);
    };
    const pigs = new Pigs(seededRng(2));
    const pig = pigs.spawn(0, GROUND + 1, 0, -Math.PI / 2); // walking +x along r = 0, straight at it
    pig.mode = 'walk';
    pig.timer = 100;
    let burnt = 0;
    for (let f = 0; f < 6 * 60; f++) {
      pigs.update(1 / 60, { getBlock, isLoaded: loaded });
      burnt += pigs.scorched.length;
    }
    expect(burnt).toBe(0);
  });
});

describe('Pigs.update — legs (play-test A7)', () => {
  it('a standing pig\'s legs settle back to straight; a walking pig\'s keep swinging', () => {
    const pigs = new Pigs(seededRng(1));
    const pig = pigs.spawn(0, GROUND, 0);
    pig.timer = 100; // idle
    pig.walkPhase = 1.0; // frozen mid-stride: sin = 0.84
    for (let f = 0; f < 60; f++) pigs.update(1 / 60, { getBlock: flat, isLoaded: loaded });
    expect(Math.abs(Math.sin(pig.walkPhase))).toBeLessThan(0.01);
    pig.mode = 'walk';
    const phases = new Set();
    for (let f = 0; f < 60; f++) {
      pigs.update(1 / 60, { getBlock: flat, isLoaded: loaded });
      phases.add(Math.round(Math.sin(pig.walkPhase) * 10));
    }
    expect(phases.size).toBeGreaterThan(5);
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
