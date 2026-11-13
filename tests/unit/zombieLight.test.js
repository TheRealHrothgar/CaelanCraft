// Light as a defence against zombies (CONTRACTS §86): no spawning on lit ground, dread of strong block light, shy idle
// zombies that drift away from it, and slower, weaker, lower-climbing zombies in proportion to the light they stand in.
// Most scenes use the flat fake world of zombies.test.js with a FAKED block-light field; the ones that are about the
// light model itself (a real torch, a wall in the way, a fire that has burned out) use a real World and its LightEngine.
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import {
  ZOMBIE_MAX, ZOMBIE_DAMAGE, ZOMBIE_FIRE_FEAR, ZOMBIE_SPAWN_FIRE_CLEAR, ZOMBIE_CHASE_SPEED, WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED,
  LIGHT_MAX, TORCH_LIGHT, CAMPFIRE_LIGHT, GLOWSTONE_LIGHT, LAMP_LIGHT_MIN, LAMP_LIGHT_MAX,
} from '../../src/config.js';
import {
  Zombies, KIND_STATS, ZOMBIE_KINDS, CLIMB, DAY_ALPHA_FACTOR, DAY_ALPHA_DAMAGE, AVOID_S,
  GLARE_CHECK_S, ZOMBIE_SPAWN_LIGHT_MAX, ZOMBIE_DREAD_LIGHT, ALPHA_DREAD_LIGHT, ZOMBIE_SHY_LIGHT, GLARE_SLOW, GLARE_WEAK,
  GLARE_CLIMB, DRIFT_SPREAD, SHIELD_RATE, SPAWN_REFUSALS,
  glareOf, dreadLight, glareSpeed, spawnChance, standLight, shieldTarget, gaitOf, damageOf, strikeDamage, maxClimb, isDormant,
} from '../../src/zombies.js';
import { seededRng } from '../../src/pigs.js';
import { createPlayer } from '../../src/physics.js';
import { hexToWorld, worldToHex, hexLength } from '../../src/hex.js';
import { World } from '../../src/world.js';
import { LIGHT_EMISSION } from '../../src/light.js';
import { columnHasEdits } from '../../src/blackholes.js';
import { flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10;
/** Flat grass world: stone below GROUND − 1, grass at GROUND − 1, air above (as zombies.test.js). */
const flat = (_q, y) => (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
const loaded = () => true;
const DT = 1 / 60;

/**
 * A faked block-light field over the flat world, shaped like the real one in the open: `level` in cell (tq, GROUND, tr),
 * one less per cell away on the level and per cell up, nothing in the ground.
 */
const pointLight = (level, tq = 0, tr = 0) => (q, y, r) => (y >= GROUND ? Math.max(0, level - hexLength(q - tq, r - tr) - (y - GROUND)) : 0);
/** The same light everywhere above the ground. */
const uniform = (level) => (_q, y) => (y >= GROUND ? level : 0);

/** A night-time world view around a player. */
function view(getBlock, player, extra = {}) {
  return { getBlock, isLoaded: loaded, player, isDay: false, ...extra };
}

/** Spawning hooks for the flat, fully loaded world with no edits. */
const spawnHooks = () => ({
  isLoadedCell: () => true,
  groundHeight: () => GROUND - 1,
  isNaturalGround: (q, y, r) => y === GROUND - 1 && flat(q, y, r) !== B.AIR,
  columnEdited: () => false,
});

function run(zombies, world, seconds, each) {
  for (let f = 0; f < seconds * 60; f++) {
    const ev = zombies.update(DT, world);
    if (each && each(ev, f) === false) return f;
  }
  return -1;
}

const standing = (x, z, y = GROUND) => {
  const p = createPlayer(x, y, z);
  p.onGround = true;
  return p;
};

/** The block light a zombie stands in right now (a live look, not its last sample). */
const lightAt = (blockLight, zb) => {
  const [q, r] = worldToHex(zb.x, zb.z);
  return standLight(blockLight, q, Math.floor(zb.y + 0.01), r);
};

// ---- a real World (flat stone to FLOOR) with its own LightEngine ----------------------------------------------------
const FLOOR = 30;
const FEET = FLOOR + 1;

function realWorld() {
  const world = new World({ worldGen: flatWorldGen(FLOOR), renderDistance: 1, now: () => 0 });
  for (let i = 0; i < 50; i++) {
    const r = world.update(0, 0, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) return world;
  }
  throw new Error('world did not settle');
}

/** The view main gives the zombies, over a real World: `blockLight` is the LightEngine's own accessor. */
function realView(world, player = null) {
  return {
    getBlock: (q, y, r) => world.getBlock(q, y, r),
    isLoaded: (x, z) => world.hasChunkAt(x, z),
    player,
    isDay: false,
    isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
    groundHeight: (q, r) => world.terrainHeightAt(q, r),
    isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
    columnEdited: (q, r) => columnHasEdits(world.edits, q, r),
    blockLight: (q, y, r) => world.light.blockAt(q, y, r),
  };
}

describe('zombies and light — the numbers (CONTRACTS §86)', () => {
  it('the constants of the brief, and what they mean around a torch and a campfire', () => {
    expect(GLARE_CHECK_S).toBe(0.5);
    expect(ZOMBIE_SPAWN_LIGHT_MAX).toBe(7);
    expect(ZOMBIE_DREAD_LIGHT).toBe(10);
    expect(ALPHA_DREAD_LIGHT).toBe(13);
    expect(ZOMBIE_SHY_LIGHT).toBe(6);
    expect(GLARE_SLOW).toBe(0.5);
    expect(GLARE_WEAK).toBe(0.7);
    expect(GLARE_CLIMB).toBe(0.5);
    expect(LIGHT_MAX).toBe(15);
    // the order the rules rely on: shy < no spawning < dread < the alpha's dread ≤ the brightest light there is
    expect(ZOMBIE_SHY_LIGHT).toBeLessThan(ZOMBIE_SPAWN_LIGHT_MAX);
    expect(ZOMBIE_SPAWN_LIGHT_MAX).toBeLessThan(ZOMBIE_DREAD_LIGHT);
    expect(ZOMBIE_DREAD_LIGHT).toBeLessThan(ALPHA_DREAD_LIGHT);
    expect(ALPHA_DREAD_LIGHT).toBeLessThanOrEqual(LIGHT_MAX);
    // light falls by 1 a cell: walkers and runners keep 3 cells off a torch, 4 off a campfire (its own safe zone) …
    expect(TORCH_LIGHT - ZOMBIE_DREAD_LIGHT).toBe(3);
    expect(CAMPFIRE_LIGHT - ZOMBIE_DREAD_LIGHT).toBe(4);
    expect(CAMPFIRE_LIGHT - ZOMBIE_DREAD_LIGHT).toBe(ZOMBIE_FIRE_FEAR);
    // … nothing comes up within 6 cells of a torch …
    expect(TORCH_LIGHT - ZOMBIE_SPAWN_LIGHT_MAX).toBe(6);
    // … and the alpha keeps off the torch's own cell only: one torch does not stop it
    expect(ALPHA_DREAD_LIGHT).toBe(TORCH_LIGHT);
    // the emitters are the light model's (the campfire, the torch, glowstone; a cold fire pit and an unlit lamp give none)
    expect(LIGHT_EMISSION[B.TORCH]).toBe(TORCH_LIGHT);
    expect(LIGHT_EMISSION[B.CAMPFIRE]).toBe(CAMPFIRE_LIGHT);
    expect(LIGHT_EMISSION[B.GLOWSTONE]).toBe(GLOWSTONE_LIGHT);
    expect(LIGHT_EMISSION[B.FIRE_PIT]).toBe(0);
    expect(LIGHT_EMISSION[B.FILAMENT_LAMP]).toBe(0);
    expect([LAMP_LIGHT_MIN, LAMP_LIGHT_MAX]).toEqual([7, 14]);
  });

  it('glareOf, dreadLight, spawnChance, standLight and shieldTarget', () => {
    expect(glareOf({ glare: 0.4 })).toBe(0.4);
    for (const bad of [undefined, null, {}, { glare: NaN }, { glare: -1 }, { glare: '0.5x' }]) expect(glareOf(bad)).toBe(0);
    expect(glareOf({ glare: 3 })).toBe(1);
    expect(dreadLight({ kind: 'walker' })).toBe(ZOMBIE_DREAD_LIGHT);
    expect(dreadLight({ kind: 'runner' })).toBe(ZOMBIE_DREAD_LIGHT);
    expect(dreadLight({ kind: 'alpha' })).toBe(ALPHA_DREAD_LIGHT);
    expect(dreadLight(null)).toBe(ZOMBIE_DREAD_LIGHT);
    // spawning: certain in the dark, 1 − light / 7 below 7, never from 7 up
    expect(spawnChance(0)).toBe(1);
    for (let l = 1; l < ZOMBIE_SPAWN_LIGHT_MAX; l++) expect(spawnChance(l)).toBeCloseTo(1 - l / 7, 12);
    expect(spawnChance(6)).toBeCloseTo(1 / 7, 12);
    for (let l = ZOMBIE_SPAWN_LIGHT_MAX; l <= LIGHT_MAX; l++) expect(spawnChance(l)).toBe(0);
    expect(spawnChance(NaN)).toBe(1);
    // the light it stands in: the brighter of its feet and head cells
    const lit = (q, y) => (y === 5 ? 9 : y === 6 ? 11 : 2);
    expect(standLight(lit, 0, 5, 0)).toBe(11);
    expect(standLight(lit, 0, 4, 0)).toBe(9);
    expect(standLight(lit, 0, 6, 0)).toBe(11);
    expect(standLight(lit, 0, 8, 0)).toBe(2);
    expect(standLight(null, 0, 5, 0)).toBe(0);
    expect(standLight(undefined, 0, 5, 0)).toBe(0);
    // the arm across the face: nothing up to ZOMBIE_SHY_LIGHT, all the way at the light it dreads
    const at = (kind, light) => shieldTarget({ kind, glare: light / LIGHT_MAX });
    expect(at('walker', 0)).toBe(0);
    expect(at('walker', ZOMBIE_SHY_LIGHT)).toBe(0);
    expect(at('walker', 8)).toBeCloseTo(0.5, 9);
    expect(at('walker', ZOMBIE_DREAD_LIGHT)).toBeCloseTo(1, 9);
    expect(at('walker', LIGHT_MAX)).toBe(1);
    expect(at('alpha', ZOMBIE_DREAD_LIGHT)).toBeCloseTo(4 / 7, 9);
    expect(at('alpha', ALPHA_DREAD_LIGHT)).toBeCloseTo(1, 9);
  });
});

describe('zombies and light — none comes up on lit ground', () => {
  it('around a real torch: nothing within 6 cells, then 1 in 7, 2 in 7 … and as ever from 13 cells out', () => {
    const world = realWorld();
    const [tq, tr] = [8, 8];
    world.setBlock(tq, FEET, tr, B.TORCH);
    world.flushLight();
    const v = realView(world);
    const zs = new Zombies(seededRng(1));
    for (let d = 0; d <= 15; d++) {
      const at = `${d} cells from the torch`;
      // the light model: 13 in the torch's own cell, one less per cell
      expect(v.blockLight(tq + d, FEET, tr), at).toBe(Math.max(0, TORCH_LIGHT - d));
      const y = zs.spawnHeightAt(v, tq + d, tr);
      const report = zs.spawnReport(tq + d, tr, v);
      if (d <= TORCH_LIGHT - ZOMBIE_SPAWN_LIGHT_MAX) {
        expect(y, at).toBeNull();
        expect(zs.spawnChanceAt(v, tq + d, tr), at).toBe(0);
        expect(report, at).toMatchObject({ y: null, why: d === 0 ? 'not open air above' : 'lit', chance: 0 });
      } else {
        expect(y, at).toBe(FEET);
        expect(zs.spawnChanceAt(v, tq + d, tr), at).toBeCloseTo(d >= TORCH_LIGHT ? 1 : (d - 6) / 7, 12);
        expect(report, at).toMatchObject({ y: FEET, why: '', light: Math.max(0, TORCH_LIGHT - d) });
        expect(report.chance, at).toBe(zs.spawnChanceAt(v, tq + d, tr));
      }
    }
    // in every direction: the 127 cells of the disc of radius 6 are refused, and no other
    let refused = 0;
    for (let dq = -14; dq <= 14; dq++) {
      for (let dr = -14; dr <= 14; dr++) {
        if (hexLength(dq, dr) > 14) continue;
        const no = zs.spawnHeightAt(v, tq + dq, tr + dr) === null;
        expect(no, `${dq},${dr}`).toBe(hexLength(dq, dr) <= 6);
        if (no) refused++;
      }
    }
    expect(refused).toBe(127);
    expect(SPAWN_REFUSALS).toContain('lit');
    // take the torch away: the ground is as it was
    world.setBlock(tq, FEET, tr, B.AIR);
    world.flushLight();
    expect(zs.spawnChanceAt(v, tq + 2, tr)).toBe(1);
  });

  it('a night of spawn attempts around lit ground never puts one where the light is 7 or more', () => {
    // Twelve faked torches on a circle 28 from the player: most of the spawning ring (16–40) is lit by one or another.
    const torches = [];
    for (let k = 0; k < 12; k++) torches.push(worldToHex(Math.cos((k * Math.PI) / 6) * 28, Math.sin((k * Math.PI) / 6) * 28));
    const blockLight = (q, y, r) => {
      let best = 0;
      if (y < GROUND) return 0;
      for (const [tq, tr] of torches) best = Math.max(best, TORCH_LIGHT - hexLength(q - tq, r - tr) - (y - GROUND));
      return best;
    };
    const player = standing(0, 0);
    const world = { ...view(flat, player), ...spawnHooks(), blockLight };
    const zs = new Zombies(seededRng(23));
    const height = zs.spawnHeightAt.bind(zs);
    let refused = 0;
    let dimTried = 0;
    zs.spawnHeightAt = (w, q, r) => {
      const y = height(w, q, r);
      if (y === null) refused++; // on this flat, open ground only light refuses a column
      else if (standLight(blockLight, q, y, r) > 0) dimTried++;
      return y;
    };
    let spawned = 0;
    let dimSpawned = 0;
    for (let n = 0; n < 3000; n++) {
      zs.clear();
      zs.events.spawned.length = 0;
      zs._spawnNear(player, world);
      for (const zb of zs.events.spawned) {
        spawned++;
        const l = lightAt(blockLight, zb);
        expect(l).toBeLessThan(ZOMBIE_SPAWN_LIGHT_MAX);
        if (l > 0) dimSpawned++;
      }
    }
    expect(refused).toBeGreaterThan(1000); // plenty of attempts did land on bright ground
    expect(spawned).toBeGreaterThan(2000); // … and the night still brought its zombies, on darker ground
    // dim ground (light 1–6) is thinned, not closed: some come up there, clearly fewer than were tried
    expect(dimSpawned).toBeGreaterThan(100);
    expect(dimSpawned).toBeLessThan(dimTried * 0.75);
  });

  it('the chance is 1 − light / 7, by simulation: one roll per column that would do in the dark', () => {
    const player = standing(0, 0);
    for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 9, 15]) {
      const world = { ...view(flat, player), ...spawnHooks(), blockLight: uniform(level) };
      const zs = new Zombies(seededRng(100 + level));
      const height = zs.spawnHeightAt.bind(zs);
      let fit = 0;
      zs.spawnHeightAt = (w, q, r) => {
        const y = height(w, q, r);
        if (y !== null) fit++;
        return y;
      };
      let spawned = 0;
      for (let n = 0; n < 2500; n++) {
        zs.clear();
        spawned += zs._spawnNear(player, world);
      }
      if (level >= ZOMBIE_SPAWN_LIGHT_MAX) {
        expect(fit, `light ${level}`).toBe(0); // refused outright
        expect(spawned, `light ${level}`).toBe(0);
      } else {
        expect(fit, `light ${level}`).toBeGreaterThan(3000);
        expect(spawned / fit, `light ${level}`).toBeCloseTo(1 - level / ZOMBIE_SPAWN_LIGHT_MAX, 1);
        expect(Math.abs(spawned / fit - (1 - level / ZOMBIE_SPAWN_LIGHT_MAX)), `light ${level}`).toBeLessThan(0.035);
        if (level === 0) expect(spawned).toBe(fit); // the dark: no roll at all
      }
    }
  });

  it('spawnReport reads the world view of the last update, for the console', () => {
    const zs = new Zombies(seededRng(2));
    expect(zs.world).toBeNull();
    expect(zs.spawnReport(20, 0)).toEqual({ y: null, why: 'no spawning hooks', light: null, chance: 0 });
    const world = { ...view(flat, null), ...spawnHooks(), blockLight: pointLight(TORCH_LIGHT, 20, 0) };
    zs.update(DT, world);
    expect(zs.world).toBe(world);
    expect(zs.spawnReport(20, 0)).toEqual({ y: null, why: 'lit', light: 13, chance: 0 });
    expect(zs.spawnReport(26, 0)).toEqual({ y: null, why: 'lit', light: 7, chance: 0 });
    expect(zs.spawnReport(27, 0)).toEqual({ y: GROUND, why: '', light: 6, chance: spawnChance(6) });
    expect(zs.spawnReport(40, 0)).toEqual({ y: GROUND, why: '', light: 0, chance: 1 });
    expect(zs.spawnReport(40, 0, { ...world, columnEdited: () => true })).toMatchObject({ y: null, why: 'column built in', chance: 0 });
    expect(zs.spawnReport(40, 0, { ...world, isLoadedCell: () => false })).toEqual({ y: null, why: 'not loaded', light: null, chance: 0 });
    // every refusal has its word
    expect(SPAWN_REFUSALS).toEqual(['', 'no spawning hooks', 'not loaded', 'no ground', 'ground not natural', 'not open air above',
      'column built in', 'lit', 'campfire near', 'no room']);
  });
});

describe('zombies and light — dread: walkers and runners keep out of strong light', () => {
  const torch = pointLight(TORCH_LIGHT);

  it('a walker after a player who stands at a torch stops at the edge of its light and never strikes', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const zs = new Zombies(seededRng(seed));
      const a = seed * 1.1;
      const zb = zs.spawn(Math.cos(a) * 12, GROUND, Math.sin(a) * 12);
      const player = standing(0.3, 0.2); // in the torch's own cell
      let brightest = 0;
      let nearest = Infinity;
      let attacks = 0;
      run(zs, view(flat, player, { blockLight: torch }), 40, (ev) => {
        attacks += ev.attacks.length;
        player.x = 0.3;
        player.z = 0.2;
        player.vx = player.vy = player.vz = 0;
        brightest = Math.max(brightest, lightAt(torch, zb));
        nearest = Math.min(nearest, Math.hypot(zb.x, zb.z));
      });
      expect(zb.mode, `seed ${seed}`).toBe('chase'); // it still wants you
      expect(brightest, `seed ${seed}`).toBe(ZOMBIE_DREAD_LIGHT - 1); // it came up to the edge …
      expect(nearest, `seed ${seed}`).toBeGreaterThan(TORCH_LIGHT - ZOMBIE_DREAD_LIGHT); // … and stayed more than 3 cells off
      expect(attacks, `seed ${seed}`).toBe(0);
    }
  });

  it('a runner keeps out too (at a sprint it may clip the corner of a lit cell for a frame or two, never deeper)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const zs = new Zombies(seededRng(seed));
      const a = seed * 1.1;
      const zb = zs.spawn(Math.cos(a) * 12, GROUND, Math.sin(a) * 12, 0, 'runner');
      const player = standing(0.3, 0.2);
      let brightest = 0;
      let inside = 0;
      let attacks = 0;
      run(zs, view(flat, player, { blockLight: torch }), 40, (ev) => {
        attacks += ev.attacks.length;
        player.x = 0.3;
        player.z = 0.2;
        player.vx = player.vy = player.vz = 0;
        const l = lightAt(torch, zb);
        brightest = Math.max(brightest, l);
        if (l >= ZOMBIE_DREAD_LIGHT) inside++;
      });
      expect(brightest, `seed ${seed}`).toBeLessThanOrEqual(ZOMBIE_DREAD_LIGHT);
      expect(inside, `seed ${seed}`).toBeLessThanOrEqual(6); // of 2400 frames
      expect(attacks, `seed ${seed}`).toBe(0);
    }
  });

  it('with the torch between it and the player it walks round the light, never across, and reaches them', () => {
    for (const kind of ['walker', 'runner']) {
      let reachedN = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const zs = new Zombies(seededRng(seed));
        const [x, z] = hexToWorld(-9, 0);
        const zb = zs.spawn(x, GROUND, z + (seed % 3) * 0.3, -Math.PI / 2, kind);
        const player = standing(...hexToWorld(9, 0)); // 9 cells beyond the torch: light 4, out of the dread
        let brightest = 0;
        let inside = 0;
        let reached = false;
        run(zs, view(flat, player, { blockLight: torch }), 40, (ev) => {
          reached ||= ev.attacks.length > 0;
          const l = lightAt(torch, zb);
          brightest = Math.max(brightest, l);
          if (l >= ZOMBIE_DREAD_LIGHT) inside++;
          return !reached;
        });
        if (reached) reachedN++;
        if (kind === 'walker') expect(brightest, `walker, seed ${seed}`).toBeLessThan(ZOMBIE_DREAD_LIGHT);
        else expect(inside, `runner, seed ${seed}`).toBeLessThanOrEqual(6);
        expect(brightest, `${kind}, seed ${seed}`).toBeGreaterThanOrEqual(ZOMBIE_SHY_LIGHT); // a chaser is not shy: it skirts the edge
      }
      expect(reachedN, kind).toBeGreaterThanOrEqual(5);
    }
    // the same walk with no light: straight through the torch's cell
    const zs = new Zombies(seededRng(1));
    const [x, z] = hexToWorld(-9, 0);
    const zb = zs.spawn(x, GROUND, z, -Math.PI / 2);
    const player = standing(...hexToWorld(9, 0));
    let nearest = Infinity;
    run(zs, view(flat, player), 20, (ev) => {
      nearest = Math.min(nearest, Math.hypot(zb.x, zb.z));
      return ev.attacks.length === 0;
    });
    expect(nearest).toBeLessThan(0.5);
  });

  it('the alpha dreads only the brightest light: it crosses a torch\'s glow, weakened, but not the torch\'s own cell', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const zs = new Zombies(seededRng(seed));
      const [x, z] = hexToWorld(-9, 0);
      const zb = zs.spawn(x, GROUND, z + (seed % 3) * 0.3, -Math.PI / 2, 'alpha');
      const player = standing(...hexToWorld(9, 0));
      let brightest = 0;
      let inside = 0;
      let reached = false;
      let slowest = 1;
      run(zs, view(flat, player, { blockLight: torch }), 40, (ev) => {
        reached ||= ev.attacks.length > 0;
        const l = lightAt(torch, zb);
        brightest = Math.max(brightest, l);
        if (l >= ZOMBIE_DREAD_LIGHT) inside++;
        slowest = Math.min(slowest, glareSpeed(zb));
        return !reached;
      });
      expect(reached, `seed ${seed}`).toBe(true);
      expect(inside, `seed ${seed}`).toBeGreaterThan(60); // more than a second in light a walker will not enter
      expect(brightest, `seed ${seed}`).toBe(ALPHA_DREAD_LIGHT - 1); // right past the torch, never onto it
      expect(slowest, `seed ${seed}`).toBeLessThanOrEqual(1 - GLARE_SLOW * (11 / LIGHT_MAX)); // slowed on the way
    }
    // and it comes for a player who stands AT the torch: one torch does not make a horde's leader harmless — but weaker
    const zs = new Zombies(seededRng(7));
    const zb = zs.spawn(12, GROUND, 0, 0, 'alpha');
    const player = standing(0.3, 0.2);
    const strikes = [];
    let brightest = 0;
    run(zs, view(flat, player, { blockLight: torch }), 30, (ev) => {
      for (const s of ev.attacks) strikes.push(strikeDamage(s));
      player.x = 0.3;
      player.z = 0.2;
      player.vx = player.vy = player.vz = 0;
      brightest = Math.max(brightest, lightAt(torch, zb));
    });
    expect(brightest).toBe(ALPHA_DREAD_LIGHT - 1);
    expect(strikes.length).toBeGreaterThan(3);
    const dark = strikeDamage({ kind: 'alpha' });
    for (const hp of strikes) {
      expect(hp).toBeLessThanOrEqual(Math.round(dark * (1 - GLARE_WEAK * (10 / LIGHT_MAX)))); // it struck from light 10 or more
      expect(hp).toBeGreaterThanOrEqual(1);
    }
  });

  it('a home ringed with torches no more than 7 cells apart: walkers and runners from every side never get inside; the alpha does', () => {
    // Twelve torches on the hex ring of radius 10 round the player, five cells apart along it (the Guide says 7 at most).
    const RING = 10;
    const torches = [];
    const corners = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
    for (let k = 0; k < 6; k++) {
      const [aq, ar] = corners[k];
      const [bq, br] = corners[(k + 1) % 6];
      torches.push([aq * RING, ar * RING], [(aq * RING + bq * RING) / 2, (ar * RING + br * RING) / 2]);
    }
    for (let i = 0; i < torches.length; i++) {
      const [aq, ar] = torches[i];
      const [bq, br] = torches[(i + 1) % torches.length];
      expect(hexLength(aq - bq, ar - br)).toBeLessThanOrEqual(2 * (TORCH_LIGHT - ZOMBIE_DREAD_LIGHT) + 1);
    }
    const ring = (q, y, r) => {
      if (y < GROUND) return 0;
      let best = 0;
      for (const [tq, tr] of torches) best = Math.max(best, TORCH_LIGHT - hexLength(q - tq, r - tr) - (y - GROUND));
      return best;
    };
    // the band of dread light is closed: every cell of the ring itself is lit 10 or more
    for (let q = -RING; q <= RING; q++) for (let r = -RING; r <= RING; r++) if (hexLength(q, r) === RING) expect(ring(q, GROUND, r)).toBeGreaterThanOrEqual(ZOMBIE_DREAD_LIGHT);
    const siege = (kinds, seed) => {
      const zs = new Zombies(seededRng(seed));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + seed;
        zs.spawn(Math.cos(a) * 20, GROUND, Math.sin(a) * 20, 0, kinds[k % kinds.length]);
      }
      const player = standing(0.2, 0.1);
      let innermost = Infinity;
      let attacks = 0;
      run(zs, view(flat, player, { blockLight: ring }), 45, (ev) => {
        attacks += ev.attacks.length;
        player.x = 0.2;
        player.z = 0.1;
        player.vx = player.vy = player.vz = 0;
        for (const zb of zs.list) innermost = Math.min(innermost, hexLength(...worldToHex(zb.x, zb.z)));
      });
      return { innermost, attacks, chasing: zs.list.filter((zb) => zb.mode === 'chase').length };
    };
    for (let seed = 1; seed <= 3; seed++) {
      const out = siege(['walker', 'runner'], seed);
      expect(out.attacks, `seed ${seed}`).toBe(0);
      expect(out.innermost, `seed ${seed}`).toBeGreaterThanOrEqual(RING); // none ever stood inside the ring of torches
      expect(out.chasing, `seed ${seed}`).toBeGreaterThan(0); // they have not lost interest: the light holds them
    }
    // the same siege with an alpha among them: it walks through the glow between two torches and strikes
    const led = siege(['alpha', 'walker'], 4);
    expect(led.innermost).toBeLessThan(2);
    expect(led.attacks).toBeGreaterThan(0);
  });

  it('water is no way round: a swimmer after you does not swim into the light, and one caught in it swims out', () => {
    // A pond of radius 6 (three deep) with its middle at the origin; the torch stands on its east bank, 8 cells out, and
    // the player beside the torch at the water's edge.
    const pond = (q, y, r) => (hexLength(q, r) <= 6 && y >= GROUND - 3 && y < GROUND ? B.WATER : flat(q, y, r));
    const bankTorch = pointLight(TORCH_LIGHT, 8, 0);
    for (const kind of ['walker', 'runner']) {
      for (let seed = 1; seed <= 3; seed++) {
        const run1 = (blockLight) => {
          const zs = new Zombies(seededRng(seed));
          const [x, z] = hexToWorld(-4, seed - 2); // in the water on the far side: 12 cells from the torch, dark
          const zb = zs.spawn(x, GROUND - 1.5, z, -Math.PI / 2, kind);
          const [px, pz] = hexToWorld(7, 0);
          const player = standing(px, pz);
          let attacks = 0;
          let brightest = 0;
          let inside = 0;
          let swam = 0;
          run(zs, view(pond, player, blockLight ? { blockLight } : {}), 40, (ev) => {
            attacks += ev.attacks.length;
            player.x = px;
            player.z = pz;
            player.vx = player.vy = player.vz = 0;
            if (zb.inWater) swam++;
            const l = lightAt(bankTorch, zb);
            brightest = Math.max(brightest, l);
            if (l >= ZOMBIE_DREAD_LIGHT) inside++;
          });
          return { attacks, brightest, inside, swam };
        };
        const lit = run1(bankTorch);
        expect(lit.swam, `${kind} ${seed}`).toBeGreaterThan(120); // it did swim after you
        expect(lit.attacks, `${kind} ${seed}`).toBe(0);
        // a swimmer drifts: it may slide into the outermost lit cell for a moment before it has turned, never deeper
        expect(lit.brightest, `${kind} ${seed}`).toBeLessThanOrEqual(ZOMBIE_DREAD_LIGHT);
        expect(lit.inside, `${kind} ${seed}`).toBeLessThanOrEqual(60); // of 2400 frames
        // the same swim with no light: straight across and at you
        const dark = run1(null);
        expect(dark.attacks, `${kind} ${seed}, no light`).toBeGreaterThan(0);
      }
    }
    // one swimming where a torch is set down turns for darker water and is out of the dread within a few seconds
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const [x, z] = hexToWorld(seed - 2, 1);
      const zb = zs.spawn(x, GROUND - 1.5, z, seed);
      const world = view(pond, null, { blockLight: () => 0 });
      run(zs, world, 1);
      expect(zb.inWater).toBe(true);
      const here = pointLight(TORCH_LIGHT, ...worldToHex(zb.x, zb.z));
      world.blockLight = here;
      run(zs, world, 6);
      expect(lightAt(here, zb), `seed ${seed}`).toBeLessThan(ZOMBIE_DREAD_LIGHT);
    }
  });

  it('_lightBars: dread bars every step but one into darker light; shy bars only one who is not chasing, coming from darker ground', () => {
    const zs = new Zombies(seededRng(3));
    // the zombie stands in cell (0, 0); the cell ahead is (1, 0); the field says what each holds
    const bars = (kind, own, ahead, chasing) => {
      const zb = zs.spawn(0, GROUND, 0, 0, kind);
      zs._light = (q, y) => (y !== GROUND ? 0 : q === 0 ? own : ahead);
      const out = zs._lightBars(zb, 1, GROUND, 0, chasing);
      zs.remove(zb);
      return out;
    };
    for (const kind of ['walker', 'runner']) {
      for (const chasing of [true, false]) {
        expect(bars(kind, 0, 10, chasing), kind).toBe(true); // into dread light: never
        expect(bars(kind, 9, 10, chasing), kind).toBe(true);
        expect(bars(kind, 10, 10, chasing), kind).toBe(true); // nor sideways in it
        expect(bars(kind, 12, 13, chasing), kind).toBe(true);
        expect(bars(kind, 12, 11, chasing), kind).toBe(false); // but out of it, toward darker ground: yes
        expect(bars(kind, 11, 10, chasing), kind).toBe(false);
        expect(bars(kind, 0, 5, chasing), kind).toBe(false); // dim light bars nobody
        expect(bars(kind, 12, 0, chasing), kind).toBe(false);
      }
      expect(bars(kind, 5, 6, true), kind).toBe(false); // a chaser is not shy
      expect(bars(kind, 5, 9, true), kind).toBe(false);
      expect(bars(kind, 5, 6, false), kind).toBe(true); // an idler does not step up into light 6 or more
      expect(bars(kind, 8, 9, false), kind).toBe(true);
      expect(bars(kind, 7, 7, false), kind).toBe(false); // along it, or down it, it may
      expect(bars(kind, 9, 6, false), kind).toBe(false);
    }
    expect(bars('alpha', 9, 10, true)).toBe(false); // the alpha walks into light 10, 11, 12 …
    expect(bars('alpha', 11, 12, true)).toBe(false);
    expect(bars('alpha', 12, 13, true)).toBe(true); // … not 13
    expect(bars('alpha', 14, 13, true)).toBe(false);
    expect(bars('alpha', 5, 6, false)).toBe(true); // idle, it is as shy as the others
    // one already backing out of the light (mode `avoid`) may also step along light as bright as its own, never brighter
    const backing = zs.spawn(0, GROUND, 0);
    backing.mode = 'avoid';
    zs._light = (_q, y) => (y === GROUND ? 12 : 0);
    expect(zs._lightBars(backing, 1, GROUND, 0, false)).toBe(false);
    zs._light = (q, y) => (y !== GROUND ? 0 : q === 0 ? 12 : 13);
    expect(zs._lightBars(backing, 1, GROUND, 0, false)).toBe(true);
    zs._light = (q, y) => (y !== GROUND ? 0 : q === 0 ? 5 : 10);
    expect(zs._lightBars(backing, 1, GROUND, 0, false)).toBe(true); // and from the dark it does not walk into the dread either
    zs.remove(backing);
    // the cell it is already in never bars it, and without a light accessor nothing does
    const zb = zs.spawn(0, GROUND, 0);
    zs._light = () => 14;
    expect(zs._lightBars(zb, 0, GROUND, 0, true)).toBe(false);
    expect(zs._lightBars(zb, 1, GROUND, 0, true)).toBe(true);
    zs._light = null;
    expect(zs._lightBars(zb, 1, GROUND, 0, true)).toBe(false);
  });
});

describe('zombies and light — one that finds itself in bright light leaves it', () => {
  const torch = pointLight(TORCH_LIGHT);

  it('a walker or a runner set down beside a torch turns for darker ground at once and is out of the dread within 3 s', () => {
    for (const kind of ['walker', 'runner']) {
      for (let seed = 1; seed <= 5; seed++) {
        const zs = new Zombies(seededRng(seed));
        const [x, z] = hexToWorld(seed % 2, seed % 2 === 0 ? 1 : 0); // the torch's cell, or the one beside it
        const zb = zs.spawn(x + 0.1, GROUND, z, seed, kind);
        const world = view(flat, null, { blockLight: torch });
        const start = lightAt(torch, zb);
        expect(start).toBeGreaterThanOrEqual(12);
        zs.update(DT, world);
        expect(zb.light, `${kind} ${seed}`).toBe(start); // its first look is immediate
        expect(zb.glare, `${kind} ${seed}`).toBeCloseTo(start / LIGHT_MAX, 12);
        expect(zb.mode, `${kind} ${seed}`).toBe('avoid');
        expect(zb.timer, `${kind} ${seed}`).toBeCloseTo(AVOID_S - DT, 9);
        run(zs, world, 3);
        expect(lightAt(torch, zb), `${kind} ${seed}`).toBeLessThan(ZOMBIE_DREAD_LIGHT);
        // and with nobody to chase it keeps going: half a minute later it is off the lit ground altogether
        run(zs, world, 27);
        expect(lightAt(torch, zb), `${kind} ${seed}`).toBeLessThan(ZOMBIE_SHY_LIGHT);
      }
    }
  });

  it('a torch set down beside a zombie that is chasing: it notices within GLARE_CHECK_S, backs out, and does not strike from the light', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(0.2, GROUND, 0.1, -Math.PI / 2);
      const player = standing(14, 0);
      const world = view(flat, player, { blockLight: () => 0 });
      run(zs, world, 0.5);
      expect(zb.mode).toBe('chase');
      expect(zb.glare).toBe(0);
      // the torch goes down in the cell the zombie is in; the player stands just beside it, in the light too
      const [q, r] = worldToHex(zb.x, zb.z);
      const lit = pointLight(TORCH_LIGHT, q, r);
      world.blockLight = lit;
      player.x = zb.x + 1;
      player.z = zb.z;
      let noticed = -1;
      let struckInLight = 0;
      run(zs, world, 4, (ev, f) => {
        if (noticed < 0 && zb.glare > 0) noticed = f * DT;
        for (const s of ev.attacks) if (lightAt(lit, s) >= ZOMBIE_DREAD_LIGHT) struckInLight++;
        player.vx = player.vy = player.vz = 0;
      });
      expect(noticed, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(noticed, `seed ${seed}`).toBeLessThanOrEqual(GLARE_CHECK_S);
      expect(lightAt(lit, zb), `seed ${seed}`).toBeLessThan(ZOMBIE_DREAD_LIGHT);
      expect(struckInLight, `seed ${seed}`).toBeLessThanOrEqual(1); // at most the blow already on its way when the torch went down
    }
  });

  it('by day the day rules stand: a walker dormant in the sun stays dormant beside a torch, and wakes as before — weak', () => {
    const zs = new Zombies(seededRng(8));
    const [x, z] = hexToWorld(1, 0); // beside the torch: light 12
    const zb = zs.spawn(x, GROUND, z, 0);
    const day = (player) => ({ getBlock: flat, isLoaded: loaded, player, isDay: true, blockLight: torch });
    run(zs, day(standing(x + 10, z)), 6);
    expect(isDormant(zb)).toBe(true);
    expect(zb.mode).toBe('idle');
    expect(Math.hypot(zb.x - x, zb.z - z)).toBeLessThan(0.05); // it never stirred
    expect(zb.light).toBe(12); // … though it stands in the glare
    // a player within WALKER_WAKE_RANGE wakes it, as §65 says; it strikes for a fraction of a walker's blow
    const near = standing(x + 1, z);
    const strikes = [];
    run(zs, day(near), 3, (ev) => {
      for (const s of ev.attacks) strikes.push(strikeDamage(s));
      near.x = zb.x + 1;
      near.z = zb.z;
      near.vx = near.vy = near.vz = 0;
    });
    expect(strikes.length).toBeGreaterThan(0);
    for (const hp of strikes) expect(hp).toBeLessThanOrEqual(Math.round(ZOMBIE_DAMAGE * (1 - GLARE_WEAK * (ZOMBIE_DREAD_LIGHT / LIGHT_MAX))));
  });

  it('an alpha set down on a torch steps off it; hemmed in, or with nowhere darker beside it, a zombie stays put', () => {
    const zs = new Zombies(seededRng(5));
    const [x, z] = hexToWorld(0, 0);
    const alpha = zs.spawn(x, GROUND, z, 0, 'alpha');
    const world = view(flat, null, { blockLight: torch });
    zs.update(DT, world);
    expect(alpha.mode).toBe('avoid');
    run(zs, world, 3);
    expect(lightAt(torch, alpha)).toBeLessThan(ALPHA_DREAD_LIGHT);
    // the same light everywhere: no darker ground to turn to, so it does not flee (and is not stuck in `avoid`)
    const zs2 = new Zombies(seededRng(6));
    const stuck = zs2.spawn(x, GROUND, z);
    const bright = view(flat, null, { blockLight: uniform(12) });
    zs2.update(DT, bright);
    expect(stuck.light).toBe(12);
    expect(stuck.mode).toBe('idle');
    run(zs2, bright, 20);
    expect(Math.hypot(stuck.x - x, stuck.z - z)).toBeLessThan(0.6); // it cannot step anywhere: every cell is as bright
    // walled in on every side by a two-high wall, beside the torch: nowhere to go
    const pit = (q, y, r) => (hexLength(q, r) === 1 && y >= GROUND && y < GROUND + 2 ? B.STONE : flat(q, y, r));
    const zs3 = new Zombies(seededRng(7));
    const held = zs3.spawn(x, GROUND, z);
    zs3.update(DT, view(pit, null, { blockLight: torch }));
    expect(held.light).toBe(13);
    expect(held.mode).toBe('idle');
    expect(Number.isNaN(zs3._darkerYaw(held, pit, true))).toBe(true);
  });
});

describe('zombies and light — shy: idle zombies keep off lit ground and drift away from it', () => {
  const torch = pointLight(TORCH_LIGHT);

  it('wandering by a torch for three minutes, none steps from darker ground into light 6 or more; without the rule they do', () => {
    let steppedUp = 0;
    let litFrames = 0;
    let litFramesBlind = 0;
    for (let seed = 1; seed <= 8; seed++) {
      for (const sees of [true, false]) {
        const zs = new Zombies(seededRng(seed));
        const a = seed * 0.9;
        const zb = zs.spawn(Math.cos(a) * 9, GROUND, Math.sin(a) * 9, seed); // 9 or so cells out: light 3–5
        const world = view(flat, null, sees ? { blockLight: torch } : {});
        let before = lightAt(torch, zb);
        let cell = worldToHex(zb.x, zb.z).join();
        expect(before).toBeLessThan(ZOMBIE_SHY_LIGHT);
        run(zs, world, 180, () => {
          const now = lightAt(torch, zb);
          const at = worldToHex(zb.x, zb.z).join();
          if (sees) {
            if (at !== cell && now >= ZOMBIE_SHY_LIGHT && now > before) steppedUp++;
            if (now >= ZOMBIE_SHY_LIGHT) litFrames++;
          } else if (now >= ZOMBIE_SHY_LIGHT) litFramesBlind++;
          before = now;
          cell = at;
        });
        // … and it has drifted right off the lit ground (13 cells or more from the torch)
        if (sees) expect(lightAt(torch, zb), `seed ${seed}`).toBe(0);
      }
    }
    expect(steppedUp).toBe(0);
    expect(litFrames).toBe(0);
    expect(litFramesBlind).toBeGreaterThan(600); // the same zombies, blind to light, mill about on it
  });

  it('an idle zombie in any block light sets off toward darker ground (within DRIFT_SPREAD of straight at it)', () => {
    expect(DRIFT_SPREAD).toBeGreaterThan(0);
    expect(DRIFT_SPREAD).toBeLessThan(Math.PI / 3); // never as far round as the next cell over
    for (let seed = 1; seed <= 12; seed++) {
      const zs = new Zombies(seededRng(seed));
      const [x, z] = hexToWorld(7, -2); // light 6
      const zb = zs.spawn(x, GROUND, z, seed * 0.7);
      const world = view(flat, null, { blockLight: torch });
      run(zs, world, 6, () => zb.mode !== 'walk');
      expect(zb.mode, `seed ${seed}`).toBe('walk');
      // away from the torch at the origin: its heading points outward. (The darker cells beside it lie within 60° of
      // straight out; it aims at the centre of one, give or take DRIFT_SPREAD.)
      const out = Math.atan2(-zb.x, -zb.z); // the yaw that faces straight away from (0, 0): yawToForward = (−sin, −cos)
      const off = Math.abs(Math.atan2(Math.sin(zb.targetYaw - out), Math.cos(zb.targetYaw - out)));
      expect(off, `seed ${seed}`).toBeLessThan(Math.PI / 3 + DRIFT_SPREAD);
    }
    // in the dark it wanders any way it likes, exactly as before (same draws)
    const a = new Zombies(seededRng(9));
    const b = new Zombies(seededRng(9));
    const za = a.spawn(3, GROUND, 4, 1);
    const zb = b.spawn(3, GROUND, 4, 1);
    run(a, view(flat, null), 30);
    run(b, view(flat, null, { blockLight: () => 0 }), 30);
    expect([zb.x, zb.z, zb.yaw, zb.mode]).toEqual([za.x, za.z, za.yaw, za.mode]);
  });
});

describe('zombies and light — weaker in the light, in proportion', () => {
  const LEVELS = [0, 1, 3, 6, 7, 8, 9, 10, 12, 13, 15];

  it('speed × (1 − 0.5 g), strike × (1 − 0.7 g), multiplied with the kind, the day and the rally', () => {
    for (const light of LEVELS) {
      const glare = light / LIGHT_MAX;
      const slow = 1 - GLARE_SLOW * glare;
      const weak = 1 - GLARE_WEAK * glare;
      expect(glareSpeed({ glare }), `light ${light}`).toBeCloseTo(slow, 12);
      for (const kind of ZOMBIE_KINDS) {
        const st = KIND_STATS[kind];
        const at = `${kind}, light ${light}`;
        // at night: the kind's own gait, slowed
        expect(gaitOf({ kind, glare }), at).toEqual({ chase: st.chase, sprint: st.sprint, factor: st.factor * slow });
        expect(damageOf({ kind, glare }), at).toBeCloseTo(st.damage * weak, 12);
        expect(strikeDamage({ kind, glare }), at).toBe(Math.max(1, Math.round(ZOMBIE_DAMAGE * st.damage * weak)));
      }
      // by day the day factors stay, and the light multiplies them
      expect(gaitOf({ kind: 'runner', daylit: true, glare })).toEqual({ chase: ZOMBIE_CHASE_SPEED, sprint: false, factor: slow });
      expect(gaitOf({ kind: 'alpha', daylit: true, glare })).toEqual({ chase: 1, sprint: false, factor: DAY_ALPHA_FACTOR * slow });
      expect(damageOf({ kind: 'alpha', daylit: true, glare })).toBeCloseTo(DAY_ALPHA_DAMAGE * weak, 12);
      // a walker rallied by an alpha still chases at 1, slowed by the light
      expect(gaitOf({ kind: 'walker', rallied: true, glare })).toEqual({ chase: 1, sprint: false, factor: slow });
    }
    // in the dark nothing changed (the values §61 and §65 pin)
    expect(gaitOf({ kind: 'runner' })).toEqual({ chase: 1, sprint: true, factor: 0.95 });
    expect(damageOf({ kind: 'alpha' })).toBe(1.75);
    expect(damageOf({ kind: 'alpha', daylit: true })).toBe(DAY_ALPHA_DAMAGE);
    // the figures a player meets: a walker at the edge of a torch's dread (light 9), an alpha beside the torch (light 12)
    expect(strikeDamage({ kind: 'walker' })).toBe(8);
    expect(strikeDamage({ kind: 'walker', glare: 9 / 15 })).toBe(5);
    expect(glareSpeed({ glare: 9 / 15 })).toBeCloseTo(0.7, 12);
    expect(strikeDamage({ kind: 'alpha' })).toBe(14);
    expect(strikeDamage({ kind: 'alpha', glare: 12 / 15 })).toBe(6);
    expect(strikeDamage({ kind: 'alpha', daylit: true, glare: 12 / 15 })).toBe(4);
    expect(glareSpeed({ glare: 12 / 15 })).toBeCloseTo(0.6, 12);
    // in the brightest light there is: half speed, three tenths of the blow — never nothing
    expect(glareSpeed({ glare: 1 })).toBe(0.5);
    expect(strikeDamage({ kind: 'walker', glare: 1 })).toBe(2);
    expect(strikeDamage({ kind: 'walker', glare: 1 }, 1)).toBe(1); // rounded, never below 1
    expect(strikeDamage({ kind: 'walker', glare: 1 }, 0.4)).toBe(1);
  });

  it('measured: a chaser\'s speed in even light is its dark speed × (1 − 0.5 × light / 15), by night and by day', () => {
    /** The top horizontal speed of a zombie chasing a far player for 3 s in the same light everywhere. */
    const topSpeed = (kind, light, isDay = false) => {
      const zs = new Zombies(seededRng(4));
      const [x, z] = hexToWorld(0, 0);
      const zb = zs.spawn(x, GROUND, z, -Math.PI / 2, kind);
      const player = standing(x + 22, z);
      let top = 0;
      run(zs, { getBlock: flat, isLoaded: loaded, player, isDay, blockLight: uniform(light) }, 3, () => {
        top = Math.max(top, Math.hypot(zb.vx, zb.vz));
      });
      expect(zb.light).toBe(light);
      return top;
    };
    const dark = { walker: topSpeed('walker', 0), runner: topSpeed('runner', 0), alpha: topSpeed('alpha', 0) };
    expect(dark.walker).toBeCloseTo(WALK_SPEED * ZOMBIE_CHASE_SPEED, 1);
    expect(dark.runner).toBeCloseTo(SPRINT_SPEED * KIND_STATS.runner.factor, 1);
    expect(dark.alpha).toBeCloseTo(WALK_SPEED * KIND_STATS.alpha.factor, 1);
    for (const light of [3, 6, 9]) {
      for (const kind of ZOMBIE_KINDS) {
        expect(topSpeed(kind, light) / dark[kind], `${kind}, light ${light}`).toBeCloseTo(1 - GLARE_SLOW * (light / LIGHT_MAX), 2);
      }
    }
    expect(topSpeed('alpha', 12) / dark.alpha).toBeCloseTo(0.6, 2); // the alpha still walks in light 12
    // by day (open sky): the runner shambles and the alpha slows as §65 says, and the light multiplies that
    const dayRunner = topSpeed('runner', 0, true);
    const dayAlpha = topSpeed('alpha', 0, true);
    expect(dayRunner).toBeCloseTo(WALK_SPEED * ZOMBIE_CHASE_SPEED, 1);
    expect(dayAlpha).toBeCloseTo(WALK_SPEED * DAY_ALPHA_FACTOR, 1);
    expect(topSpeed('runner', 9, true) / dayRunner).toBeCloseTo(0.7, 2);
    expect(topSpeed('alpha', 9, true) / dayAlpha).toBeCloseTo(0.7, 2);
    expect(topSpeed('alpha', 9, true)).toBeCloseTo(WALK_SPEED * DAY_ALPHA_FACTOR * 0.7, 1);
  });

  it('measured: a wanderer shambles slower in the light too', () => {
    const amble = (light) => {
      const zs = new Zombies(seededRng(8));
      const zb = zs.spawn(0, GROUND, 0, 0);
      let top = 0;
      run(zs, view(flat, null, { blockLight: uniform(light) }), 3, () => {
        Object.assign(zb, { mode: 'walk', timer: 10, targetYaw: 0 });
        top = Math.max(top, Math.hypot(zb.vx, zb.vz));
      });
      return top;
    };
    const dark = amble(0);
    expect(dark).toBeCloseTo(SNEAK_SPEED, 1);
    expect(amble(5) / dark).toBeCloseTo(1 - GLARE_SLOW * (5 / LIGHT_MAX), 2);
  });

  it('the strikes main counts: a zombie that hits you from the light hits softer (strikeDamage of the striker)', () => {
    const hp = (kind, light) => {
      const zs = new Zombies(seededRng(5));
      const zb = zs.spawn(0, GROUND, 0, 0, kind);
      const player = standing(0.8, 0);
      let first = null;
      run(zs, view(flat, player, { blockLight: uniform(light) }), 2, (ev) => {
        if (ev.attacks.length) first = strikeDamage(ev.attacks[0]);
        return first === null;
      });
      expect(zb.light).toBe(light);
      return first;
    };
    expect(hp('walker', 0)).toBe(8);
    expect(hp('walker', 6)).toBe(Math.round(8 * (1 - 0.7 * 0.4))); // 6
    expect(hp('walker', 9)).toBe(5);
    expect(hp('runner', 9)).toBe(5);
    expect(hp('alpha', 0)).toBe(14);
    expect(hp('alpha', 9)).toBe(8);
    expect(hp('alpha', 12)).toBe(6);
  });
});

describe('zombies and light — in strong light it climbs only its day height', () => {
  it('maxClimb: the day height from glare 0.5 (light 8) up, by night as well', () => {
    expect(GLARE_CLIMB * LIGHT_MAX).toBe(7.5); // light 8 is the first whole level at or over it
    for (const kind of ZOMBIE_KINDS) {
      for (let light = 0; light <= LIGHT_MAX; light++) {
        const glare = light / LIGHT_MAX;
        expect(maxClimb({ kind, glare }), `${kind}, light ${light}`).toBe(light >= 8 ? CLIMB[kind].day : CLIMB[kind].night);
        expect(maxClimb({ kind, glare, daylit: true }), `${kind}, light ${light}, day`).toBe(CLIMB[kind].day);
      }
    }
    expect(maxClimb({ kind: 'runner', glare: 7 / 15 })).toBe(2);
    expect(maxClimb({ kind: 'runner', glare: 8 / 15 })).toBe(1);
    expect(maxClimb({ kind: 'alpha', glare: 7 / 15 })).toBe(4);
    expect(maxClimb({ kind: 'alpha', glare: 8 / 15 })).toBe(2);
  });

  it('a runner leaps a 2-cell wall in light 7 but not in light 8; an alpha a 4-cell wall in 7, only 2 cells in 8', () => {
    /** A wall `h` cells high for q ≥ 3; the player stands on top of it (zombies.test.js "jumps"). */
    const wallWorld = (h) => (q, y, r) => (q >= 3 && y >= GROUND && y < GROUND + h ? B.STONE : flat(q, y, r));
    const reaches = (kind, h, light) => {
      const zs = new Zombies(seededRng(40 + h));
      const [x, z] = hexToWorld(0, 0);
      const zb = zs.spawn(x, GROUND, z, -Math.PI / 2, kind);
      const player = standing(hexToWorld(6, 0)[0], 0, GROUND + h);
      run(zs, view(wallWorld(h), player, { blockLight: uniform(light) }), 10, () => zb.y < GROUND + h - 0.01);
      return zb.y >= GROUND + h - 0.01;
    };
    expect(reaches('runner', 2, 0)).toBe(true);
    expect(reaches('runner', 2, 7)).toBe(true);
    expect(reaches('runner', 2, 8)).toBe(false);
    expect(reaches('runner', 1, 8)).toBe(true);
    expect(reaches('alpha', 4, 7)).toBe(true);
    expect(reaches('alpha', 4, 8)).toBe(false);
    expect(reaches('alpha', 2, 8)).toBe(true);
    expect(reaches('walker', 1, 9)).toBe(true);
  });
});

describe('zombies and light — light behind a wall does not count (a real World and its LightEngine)', () => {
  /** A torch at (8, 8) with a stone wall right behind it: q = 9, six cells high, from r = −8 to r = 24. */
  function walled() {
    const world = realWorld();
    for (let r = -8; r <= 24; r++) for (let y = FEET; y < FEET + 6; y++) world.setBlock(9, y, r, B.STONE);
    world.setBlock(8, FEET, 8, B.TORCH);
    world.flushLight();
    return world;
  }

  it('the torch lights the side it shines on; behind the wall the ground is dark and zombies come up as ever', () => {
    const world = walled();
    const v = realView(world);
    const zs = new Zombies(seededRng(1));
    for (let d = 1; d <= 12; d++) expect(v.blockLight(8 - d, FEET, 8), `lit side, ${d} cells`).toBe(TORCH_LIGHT - d);
    for (let d = 2; d <= 12; d++) expect(v.blockLight(8 + d, FEET, 8), `dark side, ${d} cells`).toBe(0);
    // spawning: refused 4 cells out on the lit side, certain 4 cells out on the dark side
    expect(zs.spawnHeightAt(v, 4, 8)).toBeNull();
    expect(zs.spawnReport(4, 8, v).why).toBe('lit');
    expect(zs.spawnHeightAt(v, 12, 8)).toBe(FEET);
    expect(zs.spawnChanceAt(v, 12, 8)).toBe(1);
    expect(zs.spawnChanceAt(v, 10, 8)).toBe(1); // right against the wall
  });

  it('a walker reaches and strikes a player behind the wall, two cells from the torch; on the lit side it never does', () => {
    const world = walled();
    // behind the wall: the player at (11, 8), the walker from (22, 8)
    {
      const zs = new Zombies(seededRng(2));
      const player = standing(...hexToWorld(11, 8), FEET);
      const [x, z] = hexToWorld(22, 8);
      const zb = zs.spawn(x, FEET, z, Math.PI / 2);
      const v = realView(world, player);
      let attacks = 0;
      let brightest = 0;
      run(zs, v, 20, (ev) => {
        attacks += ev.attacks.length;
        brightest = Math.max(brightest, lightAt(v.blockLight, zb));
        return attacks === 0;
      });
      expect(attacks).toBeGreaterThan(0);
      expect(brightest).toBe(0);
      expect(zb.glare).toBe(0); // at full strength
    }
    // the lit side: the player at (6, 8), two cells from the torch (light 11), the walker from (−4, 8)
    {
      const zs = new Zombies(seededRng(2));
      const [px, pz] = hexToWorld(6, 8);
      const player = standing(px, pz, FEET);
      const [x, z] = hexToWorld(-4, 8);
      const zb = zs.spawn(x, FEET, z, -Math.PI / 2);
      const v = realView(world, player);
      expect(v.blockLight(6, FEET, 8)).toBe(11);
      let attacks = 0;
      let brightest = 0;
      run(zs, v, 30, (ev) => {
        attacks += ev.attacks.length;
        player.x = px;
        player.z = pz;
        player.vx = player.vy = player.vz = 0;
        brightest = Math.max(brightest, lightAt(v.blockLight, zb));
      });
      expect(attacks).toBe(0);
      expect(brightest).toBe(ZOMBIE_DREAD_LIGHT - 1);
      expect(zb.glare).toBeGreaterThan(0);
    }
  });

  it('a lit lamp is light like any other (LightEngine.setEmitter); switched off it protects nothing', () => {
    const world = realWorld();
    const v = realView(world);
    const zs = new Zombies(seededRng(3));
    world.light.setEmitter(8, FEET, 8, LAMP_LIGHT_MAX); // main does this for a lit Filament Lamp (§72)
    world.flushLight();
    expect(v.blockLight(8 + 4, FEET, 8)).toBe(LAMP_LIGHT_MAX - 4);
    expect(zs.spawnHeightAt(v, 8 + 7, 8)).toBeNull(); // 14 − 7 = 7
    expect(zs.spawnHeightAt(v, 8 + 8, 8)).toBe(FEET);
    world.light.setEmitter(8, FEET, 8, LAMP_LIGHT_MIN); // barely glowing: its own cell only
    world.flushLight();
    expect(zs.spawnHeightAt(v, 8, 8)).toBeNull();
    expect(zs.spawnHeightAt(v, 9, 8)).toBe(FEET);
    world.light.setEmitter(8, FEET, 8, 0);
    world.flushLight();
    expect(zs.spawnChanceAt(v, 8, 8)).toBe(1);
  });
});

describe('zombies and light — the campfire\'s own rules stand', () => {
  const [fx, fz] = hexToWorld(0, 0);
  const withFire = (q, y, r) => (q === 0 && r === 0 && y === GROUND ? B.CAMPFIRE : flat(q, y, r));
  const nearestFire = (x, y, z, maxDist, out) => {
    const d = Math.hypot(x - fx, y - GROUND, z - fz);
    if (d > maxDist) return Infinity;
    out[0] = fx;
    out[1] = GROUND;
    out[2] = fz;
    return d;
  };
  const fireLight = pointLight(CAMPFIRE_LIGHT);
  const fireView = (player) => view(withFire, player, { nearestFire, hasCampfires: () => true, blockLight: fireLight });
  const ZONE = Math.sqrt(ZOMBIE_FIRE_FEAR ** 2 - 1);

  it('the safe zone keeps every kind out — the alpha too, though a campfire\'s light alone would let it nearer', () => {
    expect(CAMPFIRE_LIGHT - ALPHA_DREAD_LIGHT).toBeLessThan(ZOMBIE_FIRE_FEAR);
    for (const kind of ZOMBIE_KINDS) {
      for (let seed = 1; seed <= 3; seed++) {
        const zs = new Zombies(seededRng(seed));
        const zb = zs.spawn(fx + 12, GROUND, fz + seed, 0, kind);
        const player = standing(fx + 1.2, fz);
        let closest = Infinity;
        let attacks = 0;
        run(zs, fireView(player), 30, (ev) => {
          attacks += ev.attacks.length;
          closest = Math.min(closest, Math.hypot(zb.x - fx, zb.z - fz));
          player.x = fx + 1.2;
          player.z = fz;
        });
        expect(attacks, `${kind}, seed ${seed}`).toBe(0);
        expect(closest, `${kind}, seed ${seed}`).toBeGreaterThan(ZOMBIE_FIRE_FEAR - 1.2); // zombies.test.js's own bound
      }
    }
  });

  it('nobody inside the zone is struck, and a zombie inside it never strikes: with light, as without', () => {
    // a player inside, an alpha just outside the zone (in light 9 or so, which it does not dread): never struck
    for (const [px, struck] of [[fx + 3.3, false], [fx + 5.2, true]]) {
      const zs = new Zombies(seededRng(4));
      const zb = zs.spawn(px + 1.1, GROUND, fz, Math.PI / 2, 'alpha');
      const player = standing(px, fz);
      let attacks = 0;
      run(zs, fireView(player), 3, (ev) => {
        attacks += ev.attacks.length;
        zb.x = px + 1.1;
        zb.z = fz;
        player.x = px;
        player.z = fz;
        player.vx = player.vy = player.vz = 0;
      });
      expect(attacks > 0, `player at ${px}`).toBe(struck);
    }
    // a zombie summoned inside the zone walks out of it
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(fx - 1.5, GROUND, fz + 0.4, seed);
      run(zs, fireView(null), 4);
      expect(Math.hypot(zb.x - fx, zb.z - fz), `seed ${seed}`).toBeGreaterThan(ZONE);
    }
  });

  it('no zombie comes up within ZOMBIE_SPAWN_FIRE_CLEAR of a fire, even where its light has thinned to less than 7', () => {
    const zs = new Zombies(seededRng(5));
    const v = { ...fireView(null), ...spawnHooks() };
    zs.update(DT, v);
    // Along the row: 7 cells out the light is 14 − 7 = 7 (refused as lit); 8 cells out it is 6, which alone would let
    // one in seven through — but that column is within ZOMBIE_SPAWN_FIRE_CLEAR (8) of the fire, so the fire rule refuses it.
    expect(fireLight(7, GROUND, 0)).toBe(ZOMBIE_SPAWN_LIGHT_MAX);
    expect(fireLight(8, GROUND, 0)).toBe(6);
    expect(zs.spawnReport(7, 0)).toMatchObject({ y: null, why: 'lit' });
    expect(zs.spawnReport(8, 0)).toEqual({ y: null, why: 'campfire near', light: 6, chance: 0 });
    expect(zs.spawnReport(9, 0)).toEqual({ y: GROUND, why: '', light: 5, chance: spawnChance(5) });
    // every column within 8 of the fire is refused, by one rule or the other; the fire rule alone refuses some
    const byFire = [];
    for (let q = -10; q <= 10; q++) {
      for (let r = -10; r <= 10; r++) {
        const [x, z] = hexToWorld(q, r);
        const rep = zs.spawnReport(q, r);
        if (Math.hypot(x - fx, z - fz) <= ZOMBIE_SPAWN_FIRE_CLEAR) {
          expect(rep.y, `${q},${r}`).toBeNull();
          if (rep.why === 'campfire near') byFire.push(rep.light);
        }
      }
    }
    expect(byFire.length).toBeGreaterThan(0);
    for (const l of byFire) expect(l).toBeLessThan(ZOMBIE_SPAWN_LIGHT_MAX);
  });

  it('a fire that has burned out gives no light and no protection (a real World: CAMPFIRE, then FIRE_PIT)', () => {
    const world = realWorld();
    const v = realView(world);
    const zs = new Zombies(seededRng(6));
    world.setBlock(8, FEET, 8, B.CAMPFIRE);
    world.flushLight();
    expect(v.blockLight(8 + 4, FEET, 8)).toBe(ZOMBIE_DREAD_LIGHT);
    expect(zs.spawnHeightAt(v, 8 + 7, 8)).toBeNull();
    world.setBlock(8, FEET, 8, B.FIRE_PIT);
    world.flushLight();
    for (let d = 1; d <= 8; d++) expect(v.blockLight(8 + d, FEET, 8)).toBe(0);
    expect(zs.spawnChanceAt(v, 8 + 2, 8)).toBe(1);
    // a walker walks straight up to a player beside the cold pit and strikes
    const [px, pz] = hexToWorld(9, 8);
    const player = standing(px, pz, FEET);
    const [x, z] = hexToWorld(18, 8);
    zs.spawn(x, FEET, z, Math.PI / 2);
    let attacks = 0;
    run(zs, realView(world, player), 20, (ev) => {
      attacks += ev.attacks.length;
      return attacks === 0;
    });
    expect(attacks).toBeGreaterThan(0);
  });
});

describe('zombies and light — what the checks cost', () => {
  /** ZOMBIE_MAX zombies of every kind around a player they chase, strike and are shoved back from. */
  function crowd(seed) {
    const zs = new Zombies(seededRng(seed));
    for (let i = 0; i < ZOMBIE_MAX; i++) {
      const a = (i / ZOMBIE_MAX) * Math.PI * 2;
      zs.spawn(Math.cos(a) * (6 + (i % 5) * 3), GROUND, Math.sin(a) * (6 + (i % 5) * 3), i, ZOMBIE_KINDS[i % 3]);
    }
    return zs;
  }

  it('in the dark the light rules change nothing: the same crowd, step for step, with and without the accessor', () => {
    const a = crowd(11);
    const b = crowd(11);
    const pa = standing(0, 0);
    const pb = standing(0, 0);
    const wa = { ...view(flat, pa), ...spawnHooks() };
    const wb = { ...view(flat, pb), ...spawnHooks(), blockLight: () => 0 };
    let strikes = 0;
    for (let f = 0; f < 60 * 40; f++) {
      strikes += a.update(DT, wa).attacks.length;
      b.update(DT, wb);
      for (const p of [pa, pb]) Object.assign(p, { x: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    }
    expect(strikes).toBeGreaterThan(10);
    expect(b.size).toBe(a.size);
    expect(b.list.map((z) => [z.id, z.kind, z.x, z.y, z.z, z.yaw, z.mode])).toEqual(a.list.map((z) => [z.id, z.kind, z.x, z.y, z.z, z.yaw, z.mode]));
    for (const zb of b.list) expect([zb.light, zb.glare, zb.shield]).toEqual([0, 0, 0]);
  });

  it('counted: with ZOMBIE_MAX zombies, at most two light reads a zombie a frame, plus two every GLARE_CHECK_S', () => {
    const zs = crowd(12);
    expect(zs.size).toBe(ZOMBIE_MAX);
    const player = standing(0, 0);
    let reads = 0;
    const world = view(flat, player, {
      blockLight: () => {
        reads++;
        return 0;
      },
    });
    const FRAMES = 600;
    for (let f = 0; f < FRAMES; f++) {
      zs.update(DT, world);
      Object.assign(player, { x: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    }
    const looks = Math.ceil((FRAMES * DT) / GLARE_CHECK_S) + 1;
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(ZOMBIE_MAX * (FRAMES * 2 + looks * 2));
    expect(reads / FRAMES / ZOMBIE_MAX).toBeLessThanOrEqual(2 + (2 * looks) / FRAMES); // ≈ 2.07 reads a zombie a frame
  });

  it('timed against a real LightEngine: the same crowd costs no measurable extra', () => {
    const world = realWorld();
    world.setBlock(8, FEET, 8, B.TORCH);
    world.flushLight();
    const time = (withLight) => {
      const zs = new Zombies(seededRng(13));
      const [cx, cz] = hexToWorld(8, 8);
      for (let i = 0; i < ZOMBIE_MAX; i++) {
        const a = (i / ZOMBIE_MAX) * Math.PI * 2;
        zs.spawn(cx + Math.cos(a) * (5 + (i % 4) * 2), FEET, cz + Math.sin(a) * (5 + (i % 4) * 2), i, ZOMBIE_KINDS[i % 3]);
      }
      const player = standing(cx, cz, FEET);
      const v = realView(world, player);
      if (!withLight) delete v.blockLight;
      const t0 = performance.now();
      for (let f = 0; f < 300; f++) {
        zs.update(DT, v);
        Object.assign(player, { x: cx, z: cz, vx: 0, vy: 0, vz: 0 });
      }
      return performance.now() - t0;
    };
    time(true); // warm both paths
    time(false);
    let lit = Infinity;
    let dark = Infinity;
    for (let k = 0; k < 5; k++) {
      lit = Math.min(lit, time(true));
      dark = Math.min(dark, time(false));
    }
    // The best of five, interleaved, on whatever machine: the lit run (which also steers round a torch) within 1.6× the
    // dark one plus 15 ms of slack over 300 updates — a loose bound that a per-frame flood or scan would break at once.
    expect(lit).toBeLessThan(dark * 1.6 + 15);
  });
});

describe('zombies and light — the arm across the face (Zombie.shield, for the renderer)', () => {
  it('eases toward shieldTarget at SHIELD_RATE: up in the light, down again in the dark, 0 without a light accessor', () => {
    expect(SHIELD_RATE).toBeGreaterThan(1);
    const zs = new Zombies(seededRng(14));
    const zb = zs.spawn(0, GROUND, 0);
    Object.assign(zb, { mode: 'idle', timer: 1e9 });
    const lit = view(flat, null, { blockLight: uniform(9) });
    zs.update(DT, lit);
    expect(zb.shield).toBeGreaterThan(0);
    expect(zb.shield).toBeLessThan(0.1); // no jump
    run(zs, lit, 2);
    expect(zb.shield).toBeCloseTo(shieldTarget(zb), 3);
    expect(shieldTarget(zb)).toBeCloseTo(0.75, 9);
    const dark = view(flat, null, { blockLight: uniform(0) });
    run(zs, dark, 2);
    expect(zb.shield).toBeLessThan(0.01);
    run(zs, lit, 1);
    zs.update(DT, view(flat, null)); // no accessor: no light rules at all
    expect([zb.light, zb.glare, zb.shield]).toEqual([0, 0, 0]);
  });
});
