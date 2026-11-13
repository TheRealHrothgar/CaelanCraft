// Unit tests for src/populations.js — animals that live in the world (CONTRACTS §88): live and dormant animals, zones and
// their carrying capacity, seeding, the logistic curve through real births, pairs, food and water, the young, wanderers,
// the surplus, livestock in a pen, sex in names and models, the save, and what it all costs.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { SEA_LEVEL, DAY_LENGTH_SECONDS, PIG_HEALTH } from '../../src/config.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { createPlayer } from '../../src/physics.js';
import { Animals, SPECIES, ANIMAL_MAX, SHEAR_REGROW_S, MILK_REGROW_S, HOME_RANGE, validateAnimalsJSON } from '../../src/animals.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { createAnimalRenderer, bodyVariant } from '../../src/animalRenderer.js';
import { rollMobDrops } from '../../src/harvest.js';
import { serializeSave, deserializeSave } from '../../src/storage.js';
import { createWorldGen } from '../../src/worldgen.js';
import {
  Fauna, FAUNA_KINDS, ZONE_SIZE, LIVE_RADIUS, SLEEP_RADIUS, LIVE_MAX, SCAN_S, STEP_DAYS, MATE_RANGE, FEED_RANGE, FED_DAYS,
  YOUNG_SCALE, YOUTH_DAYS, REST_DAYS, BIRTH_RATE, LITTER, BASE_K, FISH_CELLS, FISH_K_MAX, DRY_WATER, SEED_SHARE, WANDER_DAYS,
  WANDER_SOURCE_MIN, CATCH_UP_DAYS, TAME_CAP, ZONE_MAX, ZONE_ANIMALS_MAX, NAMES, zoneOf, zoneKey, zoneDistance, zoneLand,
  suitability, growthScale, nameOf, animalName, youngDrops, litterSize, makeRecord, scanHabitat, validateFaunaJSON,
} from '../../src/populations.js';

const B = BLOCK;
const GROUND = 10;

/** Flat land: `top` at GROUND − 1 over stone, air above; `extra` maps "q,y,r" → block id. */
function flatWorld(extra = new Map(), top = B.GRASS_BLOCK) {
  return (q, y, r) => extra.get(`${q},${y},${r}`) ?? (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? top : B.AIR);
}
/** A generator for the zones' land: one height (above the sea), a biome by column, streams by column. */
function fakeGen({ biome = () => BIOME.PLAINS, stream = () => false, height = SEA_LEVEL + 8 } = {}) {
  return { getColumn: (q, r) => ({ height, biome: biome(q, r) }), streamAt: stream };
}
/** A FaunaWorld with a clock the test sets. */
function makeEnv(getBlock, player, more = {}) {
  const env = {
    t: 0, now: () => env.t, player, getBlock, isLoadedCell: () => true, groundHeight: () => GROUND - 1, isNaturalGround: () => true,
    getBiome: () => BIOME.PLAINS, gen: null, seed: 1, ...more,
  };
  return env;
}
const standing = (x, z, more = {}) => Object.assign(createPlayer(x, GROUND, z), { onGround: true }, more);
/** A zone made by hand: its land given, already seeded (no animals but `list`). */
function putZone(fauna, zq, zr, K, land = {}, list = []) {
  const z = {
    key: zoneKey(zq, zr), zq, zr, t: fauna.now, t0: fauna.now, seeded: true, touched: true, list,
    land: { K, g: 1, w: 1, c: 0, ws: [], mix: { plains: 1 }, ...land },
  };
  fauna.zones.set(z.key, z);
  return z;
}
/** A grown record standing at world (x, z) on the flat land. */
const rec = (kind, sex, x, z, more = {}) => Object.assign(makeRecord(kind, sex, -50, x, GROUND, z, true, 0), more);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe('populations — zones and their land', () => {
  it('a zone is 64 × 64 cells of (q, r); its distance from a point is 0 inside and grows outside', () => {
    expect(ZONE_SIZE).toBe(64);
    expect(zoneOf(0, 0)).toEqual([0, 0]);
    expect(zoneOf(63, 63)).toEqual([0, 0]);
    expect(zoneOf(64, -1)).toEqual([1, -1]);
    expect(zoneOf(-64, -65)).toEqual([-1, -2]);
    const [x, z] = hexToWorld(32, 32);
    expect(zoneDistance(0, 0, x, z)).toBe(0);
    expect(zoneDistance(1, 0, x, z)).toBeGreaterThan(25);
    expect(zoneDistance(1, 0, x, z)).toBeLessThan(40);
    expect(zoneDistance(5, 5, x, z)).toBeGreaterThan(200);
    expect(FAUNA_KINDS).toEqual(['cow', 'sheep', 'horse', 'wolf', 'deer', 'rabbit', 'pheasant', 'turkey', 'bear', 'fish', 'pig']);
  });

  it('K = base × biome share × food × water: a plains valley with a stream holds its base; dry land a third of it; the desert nothing', () => {
    expect(BASE_K).toEqual({ rabbit: 12, deer: 8, sheep: 8, pheasant: 6, turkey: 6, cow: 6, pig: 6, horse: 4, wolf: 3, bear: 1 });
    expect(DRY_WATER).toBe(0.35);
    // a stream down one column of q in the zone: fresh water in it
    const wet = zoneLand(fakeGen({ stream: (q) => q === 20 }), 0, 0);
    // the plains are the best land for cattle, sheep, horses, rabbits and pheasants (HERD_WEIGHTS), half as good for deer
    expect(wet.K).toEqual({ cow: 6, sheep: 8, horse: 4, deer: 4, rabbit: 12, pheasant: 6, turkey: 2, pig: 3, fish: 8 });
    expect([wet.w, wet.g, wet.c]).toEqual([1, 1, 64]);
    expect(wet.mix).toEqual({ plains: 1 });
    // fish: one per FISH_CELLS fresh water columns of the zone, at most FISH_K_MAX
    expect(wet.K.fish).toBe(Math.min(FISH_K_MAX, Math.round(64 / FISH_CELLS)));
    expect(zoneLand(fakeGen({ stream: (q) => q >= 10 && q < 20 }), 0, 0).K.fish).toBe(FISH_K_MAX);
    // no fresh water in it or beside it: DRY_WATER of each
    const dry = zoneLand(fakeGen(), 0, 0);
    expect(dry.w).toBe(DRY_WATER);
    expect(dry.K).toEqual({ cow: 2, sheep: 3, horse: 1, deer: 1, rabbit: 4, pheasant: 2, turkey: 1, pig: 1 });
    // water just beside the zone (within WATER_BESIDE cells) counts; water far off does not
    expect(zoneLand(fakeGen({ stream: (q) => q === -3 }), 0, 0).w).toBe(1);
    expect(zoneLand(fakeGen({ stream: (q) => q === -30 }), 0, 0).w).toBe(DRY_WATER);
    // the forest: deer, turkeys, wolves and a bear
    const forest = zoneLand(fakeGen({ biome: () => BIOME.FOREST, stream: (q) => q === 20 }), 0, 0);
    expect(forest.K).toMatchObject({ deer: 8, turkey: 6, wolf: 3, bear: 1, pig: 6 });
    // the desert, the beach and the sea hold nothing that walks; a plain under the sea level grazes nothing
    for (const b of [BIOME.DESERT, BIOME.BEACH, BIOME.OCEAN, BIOME.SNOWY_PEAKS]) {
      expect(zoneLand(fakeGen({ biome: () => b, stream: (q) => q === 20 }), 0, 0).K, `biome ${b}`).toEqual({ fish: 8 });
    }
    expect(zoneLand(fakeGen({ height: SEA_LEVEL - 4 }), 0, 0).K).toEqual({});
    // half plains, half desert: about half the plains' share (a kind the biome never had keeps K 0)
    const half = zoneLand(fakeGen({ biome: (q) => (q < 32 ? BIOME.PLAINS : BIOME.DESERT), stream: (q) => q === 20 }), 0, 0);
    expect(half.K.rabbit).toBe(6);
    expect(half.K.wolf).toBeUndefined();
    expect(half.mix).toEqual({ plains: 0.5, desert: 0.5 });
    expect(suitability('wolf', BIOME.PLAINS)).toBe(0);
    expect(suitability('deer', BIOME.FOREST)).toBe(1);
    expect(suitability('deer', BIOME.PLAINS)).toBe(0.5);
    // no generator: an empty land
    expect(zoneLand(null, 0, 0).K).toEqual({});
  });

  it('the real generator: the same seed gives the same land; the land is sampled sparsely and cached', () => {
    const a = createWorldGen(4242, { gen: 5 });
    const b = createWorldGen(4242, { gen: 5 });
    for (const [zq, zr] of [[0, 0], [2, -1], [-3, 4]]) expect(zoneLand(a, zq, zr)).toEqual(zoneLand(b, zq, zr));
    const fauna = new Fauna();
    const env = makeEnv(flatWorld(), null, { gen: a, seed: 4242 });
    let calls = 0;
    const counted = { ...a, getColumn: (q, r) => { calls++; return a.getColumn(q, r); } };
    env.gen = counted;
    const z = fauna.zone(1, 1, true, env);
    const first = calls;
    expect(first).toBeLessThan(400); // 256 samples (and a few for the seeding)
    fauna.zone(1, 1, true, env);
    expect(calls).toBe(first); // cached
    expect(z.land).not.toBeNull();
  });
});

describe('populations — seeding', () => {
  it('a new zone gets round(K × SEED_SHARE) of each kind, about half of each sex, in one to three groups, as columns; the same seed, the same animals', () => {
    expect(SEED_SHARE).toBe(0.6);
    const gen = fakeGen({ stream: (q) => q === 20 });
    const make = (seed) => {
      const fauna = new Fauna();
      fauna.seed = seed;
      return fauna.zone(0, 0, true, makeEnv(flatWorld(), null, { gen, seed }));
    };
    const z = make(9);
    for (const kind of FAUNA_KINDS) {
      const K = z.land.K[kind] ?? 0;
      const mine = z.list.filter((r) => r.kind === kind);
      expect(mine.length, kind).toBe(Math.round(K * SEED_SHARE));
      if (mine.length >= 2) {
        expect(mine.some((r) => r.sex === 'f') && mine.some((r) => r.sex === 'm'), kind).toBe(true);
        const f = mine.filter((r) => r.sex === 'f').length;
        expect(Math.abs(f - mine.length / 2), kind).toBeLessThanOrEqual(1);
      }
      for (const r of mine) {
        expect(r.placed).toBe(false); // a column; the height is found when it wakes
        expect(zoneOf(...worldToHex(r.x, r.z))).toEqual([0, 0]);
      }
    }
    expect(z.list.length).toBeGreaterThan(20);
    // the same seed and zone give the same animals; another seed others
    const strip = (list) => list.map((r) => [r.kind, r.sex, r.born, r.x, r.z]);
    expect(strip(make(9).list)).toEqual(strip(z.list));
    expect(strip(make(10).list)).not.toEqual(strip(z.list));
    // groups: rabbits (7 of them) in at most three clusters, each animal within a few cells of another
    const rabbits = z.list.filter((r) => r.kind === 'rabbit');
    for (const r of rabbits) {
      const nearest = Math.min(...rabbits.filter((o) => o !== r).map((o) => Math.hypot(o.x - r.x, o.z - r.z)));
      expect(nearest).toBeLessThan(MATE_RANGE);
    }
    // a quarter or so are young
    const young = z.list.filter((r) => -r.born < (YOUTH_DAYS[r.kind] ?? 1));
    expect(young.length).toBeGreaterThan(0);
    expect(young.length).toBeLessThan(z.list.length / 2);
  });
});

describe('populations — every animal persists: live near, dormant far', () => {
  const gen = fakeGen({ stream: (q) => q === 20 });
  /** The state of a body or record that must survive a sleep. */
  const state = (b) => [b.kind ?? 'pig', b.sex, b.born, b.x, b.y, b.z, b.tamed, b.trust, b.health, b.shorn > 0, b.milked > 0];

  it('walk away and come back: every animal is where it was, in the state it was; nothing despawns', () => {
    const animals = new Animals(seededRng(1));
    const pigs = new Pigs(seededRng(2));
    const fauna = new Fauna({ animals, pigs, rng: seededRng(3) });
    const player = standing(30, 30);
    const env = makeEnv(flatWorld(), player, { gen, seed: 5 });
    fauna.update(SCAN_S, env);
    expect(fauna.liveCount).toBeGreaterThan(5);
    for (let i = 0; i < 40; i++) fauna.update(SCAN_S, env); // the zones round about are made ahead, one a scan
    /** Every animal whose zone is near the start, live or asleep. */
    const nearZone = (zq, zr) => zoneDistance(zq, zr, 30, 30) < 100;
    const everyone = () => [...fauna.liveBodies().filter((b) => nearZone(...zoneOf(...worldToHex(b.x, b.z)))),
      ...[...fauna.zones.values()].filter((z) => nearZone(z.zq, z.zr)).flatMap((z) => z.list)];
    // some of them with a story: a tame cow, a shorn ewe, a hurt deer, a tame pig, a milked cow
    const cow = animals.spawn('cow', 33, GROUND, 31, 0.3, 'f');
    for (let i = 0; i < SPECIES.cow.tame; i++) animals.feed(cow, 'wild_tuber');
    animals.milk(cow);
    const ewe = animals.spawn('sheep', 35, GROUND, 28, 1, 'f');
    animals.shear(ewe);
    const deer = animals.spawn('deer', 26, GROUND, 33, -1, 'm');
    deer.health = 3;
    const pig = pigs.spawn(31, GROUND, 25, 2, 'm');
    for (let i = 0; i < 3; i++) pigs.feed(pig, 'honeyberries');
    const before = fauna.liveBodies().map(state).sort();
    const all = everyone().map(state).sort();
    const story = [cow, ewe, deer, pig].map(state);
    // far away: every one of them is asleep in its zone, as it was
    player.x = 2000;
    fauna.update(SCAN_S, env);
    expect(fauna.liveBodies().some((b) => Math.hypot(b.x - 30, b.z - 30) < 200)).toBe(false);
    const asleep = [...fauna.zones.values()].filter((z) => zoneDistance(z.zq, z.zr, 30, 30) < 100).flatMap((z) => z.list);
    for (const s of before) expect(asleep.map(state)).toContainEqual(s);
    expect(fauna.counts.slept).toBeGreaterThanOrEqual(before.length);
    // back again: they wake where they were, in the state they were; and none was lost on the way
    player.x = 30;
    for (let i = 0; i < 3; i++) fauna.update(SCAN_S, env);
    // (the nearest LIVE_MAX are awake; the four with a story stand beside the player)
    const after = fauna.liveBodies().map(state);
    for (const s of story) expect(after).toContainEqual(s);
    expect(everyone().map(state).sort()).toEqual(all);
  });

  it('a dormant animal does not move and wakes with its timers run down by the time it slept', () => {
    const animals = new Animals(seededRng(4));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(5) });
    const player = standing(10, 10);
    const env = makeEnv(flatWorld(), player);
    putZone(fauna, 0, 0, { sheep: 8, cow: 6 });
    fauna.update(SCAN_S, env);
    const ewe = animals.spawn('sheep', 12, GROUND, 12);
    animals.shear(ewe);
    const cow = animals.spawn('cow', 14, GROUND, 12);
    animals.milk(cow);
    player.x = 500;
    fauna.update(SCAN_S, env);
    expect(animals.size).toBe(0);
    // half the regrowth later (game time), back
    env.t = (SHEAR_REGROW_S / 2) / DAY_LENGTH_SECONDS;
    player.x = 10;
    fauna.update(SCAN_S, env);
    const e = animals.list.find((a) => a.kind === 'sheep');
    const c = animals.list.find((a) => a.kind === 'cow');
    expect([e.x, e.z, c.x, c.z]).toEqual([12, 12, 14, 12]);
    expect(e.shorn).toBeCloseTo(SHEAR_REGROW_S / 2, 3);
    expect(c.milked).toBeCloseTo(Math.max(0, MILK_REGROW_S - SHEAR_REGROW_S / 2), 3);
  });

  it('the live cap: at most LIVE_MAX, the nearest; hysteresis between LIVE_RADIUS and SLEEP_RADIUS; an unloaded chunk sleeps', () => {
    expect([LIVE_RADIUS, SLEEP_RADIUS, LIVE_MAX]).toEqual([72, 88, 64]);
    expect(ANIMAL_MAX).toBe(LIVE_MAX);
    const animals = new Animals(seededRng(6));
    const pigs = new Pigs(seededRng(7));
    const fauna = new Fauna({ animals, pigs, rng: seededRng(8) });
    const [cx, cz] = hexToWorld(32, 32);
    const player = standing(cx, cz);
    const env = makeEnv(flatWorld(), player);
    // a hundred rabbits within 30 m, and a doe 80 m off (between the radii)
    const list = [];
    for (let i = 0; i < 100; i++) list.push(rec('rabbit', i % 2 ? 'f' : 'm', cx + Math.cos(i) * (5 + i * 0.25), cz + Math.sin(i) * (5 + i * 0.25)));
    const doe = rec('deer', 'f', cx + 80, cz);
    list.push(doe);
    putZone(fauna, 0, 0, { rabbit: 200, deer: 8 }, {}, list);
    // a zone for the doe's ground (east of the first one)
    for (let q = 1; q <= 2; q++) putZone(fauna, q, 0, {});
    const z0 = fauna.zones.get('0,0');
    z0.list = z0.list.filter((r) => r !== doe);
    fauna.zones.get(zoneKey(...zoneOf(...worldToHex(doe.x, doe.z)))).list.push(doe);
    fauna.update(SCAN_S, env);
    expect(fauna.liveCount).toBe(LIVE_MAX);
    const liveD = fauna.liveBodies().map((b) => Math.hypot(b.x - cx, b.z - cz));
    const sleepD = [...fauna.zones.values()].flatMap((z) => z.list).filter((r) => r.kind === 'rabbit').map((r) => Math.hypot(r.x - cx, r.z - cz));
    expect(Math.max(...liveD)).toBeLessThanOrEqual(Math.min(...sleepD) + 1e-9); // the nearest are awake
    // the doe at 80 m stays asleep (beyond LIVE_RADIUS) …
    expect(fauna.liveBodies().some((b) => b.kind === 'deer')).toBe(false);
    // … but one that is awake there stays awake until SLEEP_RADIUS
    const fauna2 = new Fauna({ animals: new Animals(seededRng(9)), pigs: new Pigs(), rng: seededRng(10) });
    putZone(fauna2, 0, 0, {});
    for (let q = 1; q <= 2; q++) putZone(fauna2, q, 0, {});
    const live = fauna2.animals.spawn('deer', cx + 80, GROUND, cz);
    fauna2.update(SCAN_S, env);
    expect(fauna2.animals.list).toContain(live);
    live.x = cx + SLEEP_RADIUS + 1;
    fauna2.update(SCAN_S, env);
    expect(fauna2.animals.list).not.toContain(live);
    expect(fauna2.dormantCount).toBe(1);
    // an unloaded chunk: asleep even within LIVE_RADIUS, and not woken while it stays unloaded
    const near = fauna2.animals.spawn('deer', cx + 10, GROUND, cz);
    env.isLoadedCell = (q) => q < worldToHex(cx + 5, cz)[0];
    fauna2.update(SCAN_S, env);
    expect(fauna2.animals.list).not.toContain(near);
    fauna2.update(SCAN_S, env);
    expect(fauna2.animals.size).toBe(0);
    env.isLoadedCell = () => true;
    fauna2.update(SCAN_S, env);
    expect(fauna2.animals.list.map((a) => a.x)).toEqual([cx + 10]);
  });

  it('nothing changes without a player; the horse being ridden and a tame wolf at heel never sleep', () => {
    const animals = new Animals(seededRng(11));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(12) });
    const env = makeEnv(flatWorld(), null);
    putZone(fauna, 0, 0, {});
    const far = animals.spawn('cow', 5, GROUND, 5);
    fauna.update(SCAN_S, env);
    expect(animals.list).toContain(far);
    env.player = standing(1000, 0);
    const horse = animals.spawn('horse', 5, GROUND, 5);
    horse.tamed = true;
    horse.ridden = true;
    const wolf = animals.spawn('wolf', 6, GROUND, 5);
    wolf.tamed = true;
    fauna.update(SCAN_S, env);
    expect(animals.list).toEqual([horse, wolf]);
  });
});

describe('populations — births: the logistic S-curve', () => {
  /** Mean N per day over `runs` runs of one zone of deer (K, N0 grown, half of each sex) advanced a day at a time. */
  function simulate({ K, N0, days, runs, life }) {
    const sum = new Array(days + 1).fill(0);
    for (let run = 0; run < runs; run++) {
      const fauna = new Fauna({ rng: seededRng(1000 + run), life });
      const env = makeEnv(flatWorld(), null);
      const z = putZone(fauna, 0, 0, { deer: K });
      for (let i = 0; i < N0; i++) z.list.push(rec('deer', i % 2 ? 'm' : 'f', 10 + i, 10));
      sum[0] += N0;
      for (let d = 1; d <= days; d++) {
        fauna.step(1, env);
        sum[d] += z.list.length;
      }
    }
    return sum.map((s) => s / runs);
  }
  const logistic = (K, N0, r) => (t) => K / (1 + ((K - N0) / N0) * Math.exp(-r * t));
  const rms = (mean, f, K) => Math.sqrt(mean.reduce((s, n, t) => s + ((n - f(t)) / K) ** 2, 0) / mean.length);

  it('with no youth and no rest, N(t) follows K / (1 + ((K − N0) / N0) e^(−r′t)), r′ = r / 2 (half are females, one young a birth)', () => {
    const K = 40;
    const N0 = 4;
    const mean = simulate({ K, N0, days: 120, runs: 40, life: { youth: { deer: 0 }, rest: { deer: 0 } } });
    const r1 = BIRTH_RATE.deer / 2;
    expect(rms(mean, logistic(K, N0, r1), K)).toBeLessThan(0.05);
    // slow from a few, fastest near half the cap, levelling off at the cap
    const growth = mean.slice(1).map((n, t) => n - mean[t]);
    const fastest = growth.indexOf(Math.max(...growth));
    expect(mean[fastest]).toBeGreaterThan(K * 0.3);
    expect(mean[fastest]).toBeLessThan(K * 0.7);
    expect(mean[120]).toBeGreaterThan(K * 0.9);
    expect(Math.max(...mean)).toBeLessThanOrEqual(K); // one young a birth: never over the cap
  });

  it('with the real youth and rest it is still the S-curve, a little slower: the effective r′ fits it', () => {
    const K = 40;
    const N0 = 4;
    const mean = simulate({ K, N0, days: 120, runs: 30 });
    let best = { r: 0, e: Infinity };
    for (let r = 0.01; r <= 0.2; r += 0.0025) {
      const e = rms(mean, logistic(K, N0, r), K);
      if (e < best.e) best = { r, e };
    }
    expect(best.e).toBeLessThan(0.06);
    expect(best.r).toBeLessThan(BIRTH_RATE.deer / 2);
    expect(best.r).toBeGreaterThan(BIRTH_RATE.deer / 6);
  });

  it('the rates and litters: a rabbit breeds fastest and has 2–4, a bear slowest and has one', () => {
    expect(BIRTH_RATE).toEqual({ rabbit: 0.5, fish: 0.4, pheasant: 0.3, turkey: 0.3, pig: 0.2, sheep: 0.15, cow: 0.12, deer: 0.12, horse: 0.08, wolf: 0.1, bear: 0.03 });
    expect(LITTER).toEqual({ rabbit: [2, 4], pig: [2, 4], wolf: [1, 3], fish: [2, 4] });
    const rng = seededRng(3);
    const sizes = new Set(Array.from({ length: 200 }, () => litterSize('rabbit', rng)));
    expect([...sizes].sort()).toEqual([2, 3, 4]);
    expect(litterSize('bear', rng)).toBe(1);
    expect(YOUTH_DAYS).toEqual({ rabbit: 1, pheasant: 2, turkey: 2, fish: 2, pig: 2, sheep: 3, deer: 3, cow: 4, wolf: 4, horse: 5, bear: 8 });
    expect(REST_DAYS).toEqual(YOUTH_DAYS);
  });
});

describe('populations — a pair, food and water', () => {
  const grow = (fauna, z, days, env) => {
    const n0 = z.list.length;
    for (let d = 0; d < days; d++) fauna.step(1, env);
    return z.list.length - n0;
  };

  it('no growth without a pair: females alone, or a male too far (beyond MATE_RANGE), have no young', () => {
    const env = makeEnv(flatWorld(), null);
    const lonely = new Fauna({ rng: seededRng(20) });
    const z = putZone(lonely, 0, 0, { rabbit: 12 }, {}, [rec('rabbit', 'f', 10, 10), rec('rabbit', 'f', 11, 10), rec('rabbit', 'f', 12, 10)]);
    expect(grow(lonely, z, 60, env)).toBe(0);
    const apart = new Fauna({ rng: seededRng(21) });
    const z2 = putZone(apart, 0, 0, { rabbit: 12 }, {}, [rec('rabbit', 'f', 10, 10), rec('rabbit', 'm', 10 + MATE_RANGE + 1, 10)]);
    expect(grow(apart, z2, 60, env)).toBe(0);
    const close = new Fauna({ rng: seededRng(22) });
    const z3 = putZone(close, 0, 0, { rabbit: 12 }, {}, [rec('rabbit', 'f', 10, 10), rec('rabbit', 'm', 10 + MATE_RANGE - 1, 10)]);
    expect(grow(close, z3, 30, env)).toBeGreaterThan(0);
    expect(MATE_RANGE).toBe(12);
  });

  it('live: no young without grass or plants (or a feed by hand within a day) and without fresh water within FEED_RANGE', () => {
    expect(FEED_RANGE).toBe(12);
    expect(FED_DAYS).toBe(1);
    const water = new Map([[`6,${GROUND - 1},12`, B.WATER]]);
    const run = (getBlock, feed = false) => {
      const animals = new Animals(seededRng(30));
      const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(31) });
      const env = makeEnv(getBlock, standing(10, 10));
      putZone(fauna, 0, 0, { sheep: 12 });
      const pair = [animals.spawn('sheep', 10, GROUND, 10, 0, 'f'), animals.spawn('sheep', 11, GROUND, 10, 0, 'm')];
      for (let h = 1; h <= 24 * 30; h++) {
        env.t = h / 24;
        if (feed && h % 12 === 0) animals.feed(pair[0], 'wild_tuber');
        fauna.update(SCAN_S, env);
      }
      return animals.size - 2;
    };
    expect(run(flatWorld(water))).toBeGreaterThan(0); // grass and a pool: lambs
    expect(run(flatWorld(water, B.STONE))).toBe(0); // bare stone: no food
    expect(run(flatWorld(water, B.STONE), true)).toBeGreaterThan(0); // … fed by hand each day: lambs
    expect(run(flatWorld(new Map()))).toBe(0); // grass, but no water near
    const salt = new Map([[`6,${GROUND - 1},12`, B.TAINTED_WATER]]);
    expect(run(flatWorld(salt))).toBe(0); // tainted water is not fresh water
  });

  it('what counts as food and water round an animal (scanHabitat): grass, plants, crops, hay; fresh water, a spring, a barrel with water', () => {
    const at = (cells, top = B.STONE) => scanHabitat({ getBlock: flatWorld(cells, top), isLoadedCell: () => true }, 0, GROUND, 0);
    expect(at(new Map())).toBe(0);
    expect(at(new Map(), B.GRASS_BLOCK)).toBe(1);
    for (const id of [B.TUSSOCK, B.HAY_BALE, B.PLANTED_CARROT, B.SNOWY_GRASS]) expect(at(new Map([[`3,${GROUND},0`, id]])), `block ${id}`).toBe(1);
    for (const id of [B.WATER, B.WATER_LOW, B.SPRING, B.RAIN_BARREL_2]) expect(at(new Map([[`5,${GROUND},0`, id]])), `block ${id}`).toBe(2);
    expect(at(new Map([[`5,${GROUND},0`, B.RAIN_BARREL]]))).toBe(0); // an empty barrel
    expect(at(new Map([[`${FEED_RANGE + 1},${GROUND},0`, B.WATER]]))).toBe(0); // too far
    // the sea: water in a salt land's column is not fresh
    const sea = { getBlock: flatWorld(new Map([[`5,${GROUND},0`, B.WATER]]), B.STONE), isLoadedCell: () => true, getBiome: () => BIOME.OCEAN };
    expect(scanHabitat(sea, 0, GROUND, 0)).toBe(0);
  });

  it('dormant: a wild herd roams its zone (its grazing and water); in a dry zone it breeds DRY_WATER as often; a tame one keeps what it had round it', () => {
    const env = makeEnv(flatWorld(), null);
    const births = (land, more = {}) => {
      let n = 0;
      for (let run = 0; run < 20; run++) {
        const fauna = new Fauna({ rng: seededRng(40 + run), life: { youth: { sheep: 3 }, rest: { sheep: 0 }, rate: { sheep: 0.3 } } });
        const z = putZone(fauna, 0, 0, { sheep: 60 }, land, [rec('sheep', 'f', 10, 10, more), rec('sheep', 'm', 11, 10, more)]);
        fauna.step(10, env);
        n += z.list.length - 2;
      }
      return n;
    };
    const wet = births({});
    const dry = births({ w: DRY_WATER });
    expect(wet).toBeGreaterThan(20);
    expect(dry / wet).toBeGreaterThan(DRY_WATER * 0.5);
    expect(dry / wet).toBeLessThan(DRY_WATER * 1.6);
    expect(births({ g: 0 })).toBe(0); // nothing grazes there
    // a tame pair goes by what was round it when last seen: water but no food — none; both — lambs (whatever the zone)
    expect(births({ g: 0, w: DRY_WATER }, { tamed: true, habBits: 3 })).toBeGreaterThan(0);
    expect(births({}, { tamed: true, habBits: 2 })).toBe(0);
  });

  it('wolves and bears need prey: their K follows how full their prey is', () => {
    const fauna = new Fauna({ rng: seededRng(50) });
    const z = putZone(fauna, 0, 0, { wolf: 3, deer: 8, rabbit: 12 });
    expect(fauna.kOf(z, 'wolf')).toBe(0);
    for (let i = 0; i < 10; i++) z.list.push(rec(i % 2 ? 'deer' : 'rabbit', 'f', 10 + i, 10));
    expect(fauna.kOf(z, 'wolf')).toBe(Math.round(3 * (10 / 20)));
    for (let i = 0; i < 10; i++) z.list.push(rec('rabbit', 'm', 10 + i, 12));
    expect(fauna.kOf(z, 'wolf')).toBe(3);
  });
});

describe('populations — the young', () => {
  it('born at YOUNG_SCALE, grown at YOUTH_DAYS; a young body is smaller; a young one cannot breed, give milk or wool, and gives half the meat', () => {
    expect(YOUNG_SCALE).toBeCloseTo(0.55, 9);
    expect(growthScale('cow', 0)).toBeCloseTo(YOUNG_SCALE, 9);
    expect(growthScale('cow', YOUTH_DAYS.cow / 2)).toBeCloseTo((1 + YOUNG_SCALE) / 2, 9);
    expect(growthScale('cow', YOUTH_DAYS.cow)).toBe(1);
    expect(growthScale('cow', -1)).toBeCloseTo(YOUNG_SCALE, 9);
    // a calf born to a live mother: live beside her, small, and it grows
    const animals = new Animals(seededRng(60));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(61) });
    const env = makeEnv(flatWorld(new Map([[`8,${GROUND - 1},10`, B.WATER]])), standing(10, 10));
    putZone(fauna, 0, 0, { cow: 6 });
    const cow = animals.spawn('cow', 10, GROUND, 10, 0, 'f');
    animals.spawn('cow', 11, GROUND, 10, 0, 'm');
    let h = 0;
    while (animals.size === 2 && h < 24 * 200) {
      env.t = ++h / 24;
      fauna.update(SCAN_S, env);
    }
    expect(animals.size).toBe(3);
    const calf = animals.list[2];
    expect(Math.hypot(calf.x - cow.x, calf.z - cow.z)).toBeLessThan(1.5);
    expect(calf.size).toBeLessThan(YOUNG_SCALE + 0.05);
    expect(calf.radius).toBeCloseTo(SPECIES.cow.radius * calf.size, 9);
    expect(calf.height).toBeCloseTo(SPECIES.cow.height * calf.size, 9);
    expect(cow.restUntil).toBeCloseTo(calf.born + REST_DAYS.cow, 9);
    // a calf gives no milk, a lamb no wool, a foal is not ridden
    calf.sex = 'f';
    expect(animals.milk(calf)).toBe(false);
    const lamb = animals.spawn('sheep', 20, GROUND, 20);
    lamb.size = 0.6;
    expect(animals.shear(lamb)).toBe(0);
    const foal = animals.spawn('horse', 25, GROUND, 20);
    foal.tamed = true;
    foal.size = 0.7;
    expect(animals.mount(foal)).toBe(false);
    // half the meat (rounded up)
    const full = rollMobDrops('cow', () => 0.999);
    expect(youngDrops(calf, full)).toEqual(full.map((s) => ({ ...s, n: Math.ceil(s.n / 2) })));
    expect(youngDrops(cow, full)).toBe(full);
    // it grows up in YOUTH_DAYS
    env.t = calf.born + YOUTH_DAYS.cow + 0.01;
    fauna.update(SCAN_S, env);
    expect([calf.size, calf.radius]).toEqual([1, SPECIES.cow.radius]);
  });

  it('a young female does not breed until she is grown', () => {
    const fauna = new Fauna({ rng: seededRng(62) });
    const env = makeEnv(flatWorld(), null);
    const young = makeRecord('rabbit', 'f', 0, 10, GROUND, 10, true, 0);
    const z = putZone(fauna, 0, 0, { rabbit: 12 }, {}, [young, rec('rabbit', 'm', 11, 10)]);
    const ctx = fauna._ctx(env);
    expect(fauna._able(young, 0.5, z, 'rabbit', z.list, ctx, 0)).toBe(false);
    expect(fauna._able(young, YOUTH_DAYS.rabbit + 0.01, z, 'rabbit', z.list, ctx, 0)).toBe(true);
  });

  it('a young one follows its mother', () => {
    const animals = new Animals(seededRng(63));
    const mother = animals.spawn('deer', 0, GROUND, 0, 0, 'f');
    const fawn = animals.spawn('deer', 9, GROUND, 0, 0, 'm');
    fawn.size = 0.6;
    const world = { getBlock: flatWorld(), isLoaded: () => true, player: null };
    for (let f = 0; f < 60 * 15; f++) {
      mother.x = 0;
      mother.z = 0;
      animals.update(1 / 60, world);
    }
    expect(Math.hypot(fawn.x - mother.x, fawn.z - mother.z)).toBeLessThan(4.5);
  });
});

describe('populations — a dormant zone grows as a live one does', () => {
  it('the catch-up of a sleeping zone matches the births of the same herd awake (statistically)', () => {
    const T = 4;
    const runs = 30;
    const water = new Map([[`3,${GROUND - 1},10`, B.WATER]]);
    const positions = [[10, 10, 'f'], [11, 10, 'm'], [10, 11, 'f'], [11, 11, 'm']];
    let live = 0;
    let dormant = 0;
    const liveN = [];
    const dormantN = [];
    for (let run = 0; run < runs; run++) {
      // awake: live bodies, stepped a game hour at a time
      const animals = new Animals(seededRng(70 + run));
      const fa = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(170 + run) });
      const env = makeEnv(flatWorld(water), standing(10, 10));
      putZone(fa, 0, 0, { rabbit: 12 });
      for (const [x, z, s] of positions) animals.spawn('rabbit', x, GROUND, z, 0, s);
      for (let h = 1; h <= T * 24; h++) {
        env.t = h / 24;
        fa.update(SCAN_S, env);
      }
      liveN.push(animals.size + fa.dormantCount);
      live += liveN[run];
      // asleep: the same herd as records, caught up in one go when it wakes
      const fd = new Fauna({ animals: new Animals(seededRng(270 + run)), pigs: new Pigs(), rng: seededRng(370 + run) });
      const z = putZone(fd, 0, 0, { rabbit: 12 }, {}, positions.map(([x, zz, s]) => rec('rabbit', s, x, zz)));
      const envD = makeEnv(flatWorld(water), standing(10, 10));
      envD.t = T;
      fd.update(SCAN_S, envD); // the zone comes into range: its catch-up runs before anything wakes
      expect(z.t).toBe(T);
      dormantN.push(fd.liveCount + fd.dormantCount);
      dormant += dormantN[run];
    }
    live /= runs;
    dormant /= runs;
    expect(live).toBeGreaterThan(6);
    expect(dormant).toBeGreaterThan(6);
    // means within a tenth of each other (each mean's own spread is about that)
    expect(Math.abs(live - dormant) / ((live + dormant) / 2)).toBeLessThan(0.15);
  });

  it('a catch-up is capped at CATCH_UP_DAYS, and a zone remembers when it was last brought up', () => {
    expect(CATCH_UP_DAYS).toBe(120);
    const fauna = new Fauna({ rng: seededRng(80) });
    const env = makeEnv(flatWorld(), standing(10, 10));
    const z = putZone(fauna, 0, 0, { deer: 8 }, {}, [rec('deer', 'f', 10, 10), rec('deer', 'm', 11, 10)]);
    env.t = 10000;
    fauna.update(SCAN_S, env);
    expect(z.t).toBe(10000);
    expect(fauna.liveCount + fauna.dormantCount).toBeLessThanOrEqual(8);
    // the clock set back (a `time set`): nothing happens, and the zone follows the clock
    env.t = 50;
    fauna.update(SCAN_S, env);
    fauna.step(0, env);
    expect(z.t).toBe(50);
  });
});

describe('populations — wanderers and the surplus', () => {
  /** A zone emptied of deer between neighbours; `n` deer (wild, dormant) in each of `sources` neighbours. */
  function emptied(n, sources, seed) {
    const fauna = new Fauna({ rng: seededRng(seed) });
    const z = putZone(fauna, 0, 0, { deer: 8 });
    const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (let i = 0; i < 8; i++) {
      const [dq, dr] = nbs[i];
      const list = [];
      if (i < sources) {
        for (let k = 0; k < n; k++) {
          const [x, zz] = hexToWorld(dq * 64 + 20 + k, dr * 64 + 20);
          list.push(rec('deer', k % 2 ? 'm' : 'f', x, zz));
        }
      }
      putZone(fauna, dq, dr, { deer: 8 }, {}, list);
    }
    return { fauna, z };
  }
  const stepDays = (fauna, days) => {
    const env = makeEnv(flatWorld(), null);
    const out = [];
    for (let d = 0; d < days; d++) {
      // only the emptied zone is brought up (its neighbours sleep, untouched, as they would far from the player)
      fauna._advance(fauna.zones.get('0,0'), d, d + 1, fauna._ctx(env));
      fauna._setNow(d + 1);
      out.push(fauna.zones.get('0,0').list.length);
    }
    return out;
  };

  it('an emptied zone is refilled now and then by one wandering in from a neighbour that has WANDER_SOURCE_MIN or more', () => {
    expect([WANDER_DAYS, WANDER_SOURCE_MIN]).toEqual([6, 4]);
    // one neighbour with 6 deer: about one wanderer every WANDER_DAYS while the zone lacks a male or a female
    const firsts = [];
    for (let s = 0; s < 40; s++) {
      const { fauna } = emptied(6, 1, 300 + s);
      const counts = stepDays(fauna, 40);
      const first = counts.findIndex((n) => n > 0);
      if (first >= 0) firsts.push(first + 1);
    }
    expect(firsts.length).toBeGreaterThan(30);
    const mean = firsts.reduce((a, b) => a + b, 0) / firsts.length;
    expect(mean).toBeGreaterThan(WANDER_DAYS * 0.5);
    expect(mean).toBeLessThan(WANDER_DAYS * 1.6);
    // it arrives at the edge facing where it came from (the neighbour east, q + 1), as a column to be put down on waking
    const { fauna, z } = emptied(6, 1, 77);
    stepDays(fauna, 30);
    const w = z.list[0];
    expect(w.placed).toBe(false);
    expect(worldToHex(w.x, w.z)[0]).toBeGreaterThanOrEqual(ZONE_SIZE - 5);
    // over weeks the valley comes back: a pair forms and has young
    const { fauna: f2, z: z2 } = emptied(6, 2, 78);
    const counts = stepDays(f2, 120);
    expect(counts[6]).toBeLessThan(3);
    expect(counts[119]).toBeGreaterThan(3);
    expect(z2.list.some((r) => r.sex === 'f') && z2.list.some((r) => r.sex === 'm')).toBe(true);
  });

  it('all neighbours empty (or under WANDER_SOURCE_MIN): it stays empty; a lone wanderer has no young until a mate comes', () => {
    for (let s = 0; s < 5; s++) {
      const { fauna, z } = emptied(WANDER_SOURCE_MIN - 1, 8, 400 + s);
      stepDays(fauna, 120);
      expect(z.list).toEqual([]);
    }
    const { fauna, z } = emptied(0, 0, 410);
    stepDays(fauna, 120);
    expect(z.list).toEqual([]);
    // one female alone in the zone, no neighbour to send a male: she has no young however long it is
    const lone = new Fauna({ rng: seededRng(411) });
    const lz = putZone(lone, 0, 0, { deer: 8 }, {}, [rec('deer', 'f', 10, 10)]);
    for (let d = 0; d < 120; d++) lone.step(1, makeEnv(flatWorld(), null));
    expect(lz.list).toHaveLength(1);
  });

  it('too many (K fell below N): no births, and the surplus slowly wanders out to neighbours with room — none is lost', () => {
    const fauna = new Fauna({ rng: seededRng(500), life: { rate: { deer: 0 } } });
    const list = [];
    for (let i = 0; i < 12; i++) list.push(rec('deer', i % 2 ? 'm' : 'f', 10 + i, 10));
    const a = putZone(fauna, 0, 0, { deer: 6 }, {}, list);
    const b = putZone(fauna, 1, 0, { deer: 8 });
    const full = putZone(fauna, -1, 0, { deer: 2 }, {}, [rec('deer', 'f', -20, 10), rec('deer', 'm', -21, 10)]);
    const env = makeEnv(flatWorld(), null);
    const after3 = [];
    for (let d = 0; d < 60; d++) {
      fauna._advance(a, d, d + 1, fauna._ctx(env));
      if (d === 2) after3.push(a.list.length);
    }
    expect(after3[0]).toBeGreaterThan(6); // slowly: about one a WANDER_DAYS per animal over K
    expect(a.list.length).toBe(6);
    expect(b.list.length).toBe(6);
    expect(full.list.length).toBe(2); // a neighbour with no room takes none
    expect(a.list.length + b.list.length + full.list.length).toBe(14);
    for (const r of b.list) expect(zoneOf(...worldToHex(r.x, r.z))).toEqual([1, 0]);
  });
});

describe('populations — livestock', () => {
  /** A pen: a wall two cells high round radius `R` of (0, 0), grass inside, a trough of water. */
  function pen(R = 6) {
    const cells = new Map();
    for (let dq = -R - 1; dq <= R + 1; dq++) {
      for (let dr = -R - 1; dr <= R + 1; dr++) {
        const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (d === R + 1) for (const y of [GROUND, GROUND + 1]) cells.set(`${100 + dq},${y},${100 + dr}`, B.OAK_PLANKS);
      }
    }
    cells.set(`${102},${GROUND - 1},${100}`, B.WATER);
    return flatWorld(cells);
  }
  const [px, pz] = hexToWorld(100, 100);

  it('cattle, sheep and pigs are tamed by three feeds; tame, they do not run, follow the food in your hand and stay where they are left', () => {
    const animals = new Animals(seededRng(600));
    const cow = animals.spawn('cow', px, GROUND, pz, 0, 'f');
    for (let i = 0; i < SPECIES.cow.tame - 1; i++) expect(animals.feed(cow, 'wild_tuber')).toEqual({ ok: true, calmed: true });
    expect(animals.feed(cow, 'wild_tuber')).toEqual({ ok: true, tamed: true });
    expect([SPECIES.cow.tame, SPECIES.sheep.tame]).toEqual([3, 3]);
    const getBlock = pen();
    // a sprinting player right beside it: it does not run, and it keeps within HOME_RANGE of where it was tamed
    const sprinter = standing(px + 2, pz, { sprinting: true });
    let far = 0;
    for (let f = 0; f < 60 * 60; f++) {
      animals.update(1 / 60, { getBlock, isLoaded: () => true, player: sprinter, heldKey: null });
      expect(cow.mode).not.toBe('flee');
      far = Math.max(far, Math.hypot(cow.x - px, cow.z - pz));
    }
    expect(far).toBeLessThan(HOME_RANGE + 1);
    // with its food in hand, it follows — and where it ends up is its new home
    const free = new Animals(seededRng(601));
    const c2 = free.spawn('cow', 0, GROUND, 0, 0, 'f');
    for (let i = 0; i < 3; i++) free.feed(c2, 'honeyberries');
    const lead = standing(-6, 0);
    for (let f = 0; f < 60 * 8; f++) free.update(1 / 60, { getBlock: flatWorld(), isLoaded: () => true, player: lead, heldKey: 'wild_tuber' });
    expect(Math.hypot(c2.x - lead.x, c2.z - lead.z)).toBeLessThan(3);
    expect(Math.hypot(c2.homeX - c2.x, c2.homeZ - c2.z)).toBeLessThan(0.5);
  });

  it('a tame pair in a pen with grass and water has young, tame too; the herd stops at TAME_CAP; a wall two high holds them', () => {
    expect(TAME_CAP).toEqual({ cow: 8, sheep: 10, pig: 10, horse: 6, wolf: 4 });
    const animals = new Animals(seededRng(610));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(611) });
    const env = makeEnv(pen(), standing(px + 30, pz));
    // the zone of the pen holds no wild sheep at all: the keeper's food and water stand in for the land's
    putZone(fauna, ...zoneOf(100, 100), {}, { g: 0, w: DRY_WATER });
    const ewe = animals.spawn('sheep', px, GROUND, pz, 0, 'f');
    const ram = animals.spawn('sheep', px + 1, GROUND, pz, 0, 'm');
    for (const s of [ewe, ram]) for (let i = 0; i < 3; i++) animals.feed(s, 'tussock');
    for (let h = 1; h <= 24 * 90; h++) {
      env.t = h / 24;
      fauna.update(SCAN_S, env);
    }
    expect(animals.size).toBeGreaterThan(2);
    expect(animals.size).toBeLessThanOrEqual(TAME_CAP.sheep + LITTER_MAX);
    expect(animals.list.every((a) => a.tamed)).toBe(true);
    // a minute of their life: none leaves the pen
    for (let f = 0; f < 60 * 60; f++) animals.update(1 / 60, { getBlock: env.getBlock, isLoaded: () => true, player: null, heldKey: null });
    for (const a of animals.list) expect(Math.hypot(a.x - px, a.z - pz), a.kind).toBeLessThan(7);
    // a pen of TAME_CAP tame cows (and a bull) is full: no calves
    const full = new Fauna({ rng: seededRng(612) });
    const list = Array.from({ length: TAME_CAP.cow }, (_, i) => rec('cow', i === 0 ? 'm' : 'f', 10 + i * 0.5, 10, { tamed: true, habBits: 3 }));
    const fz = putZone(full, 0, 0, {}, {}, list);
    for (let d = 0; d < 60; d++) full.step(1, makeEnv(flatWorld(), null));
    expect(fz.list).toHaveLength(TAME_CAP.cow);
  });
  const LITTER_MAX = 1;
});

describe('populations — sex shown in names and models', () => {
  it('a field guide\'s names: female, male, young', () => {
    expect(NAMES).toEqual({
      cow: ['Cow', 'Bull', 'Calf'], sheep: ['Ewe', 'Ram', 'Lamb'], pig: ['Sow', 'Boar', 'Piglet'], horse: ['Mare', 'Stallion', 'Foal'],
      deer: ['Doe', 'Stag', 'Fawn'], pheasant: ['Hen Pheasant', 'Cock Pheasant', 'Chick'], turkey: ['Hen Turkey', 'Tom Turkey', 'Poult'],
      wolf: ['Wolf (she-wolf)', 'Wolf', 'Pup'], rabbit: ['Rabbit (doe)', 'Rabbit (buck)', 'Kit'], bear: ['Bear', 'Bear', 'Cub'],
      fish: ['Fish', 'Fish', 'Fry'],
    });
    for (const k of FAUNA_KINDS) expect(NAMES[k], k).toBeDefined();
    expect(nameOf('cow', 'm', false)).toBe('Bull');
    expect(nameOf('cow', 'm', true)).toBe('Calf');
    const animals = new Animals(seededRng(700));
    const bull = animals.spawn('cow', 0, GROUND, 0, 0, 'm');
    expect(animalName(bull)).toBe('Bull');
    bull.size = 0.7;
    expect(animalName(bull)).toBe('Calf');
    const pigs = new Pigs(seededRng(701));
    expect(animalName(pigs.spawn(0, GROUND, 0, 0, 'm'))).toBe('Boar');
    expect(animalName(pigs.spawn(0, GROUND, 0))).toBe('Sow');
  });

  it('the models: a bull, a ram, a stag, a cock pheasant and a tom turkey on their own bodies; the young small, on the female\'s', () => {
    const mk = (kind, more = {}) => ({ kind, x: 0, y: 10, z: 0, yaw: 0, walkPhase: 0, hurt: 0, shorn: 0, tamed: false, air: 0, rear: 0, swipe: 0, sex: 'f', size: 1, ...more });
    expect(bodyVariant(mk('cow', { sex: 'm' }))).toBe('male');
    expect(bodyVariant(mk('cow', { sex: 'm', size: 0.6 }))).toBe('body');
    expect(bodyVariant(mk('sheep', { sex: 'm', shorn: 5 }))).toBe('maleAlt');
    expect(bodyVariant(mk('sheep', { sex: 'f', shorn: 5 }))).toBe('alt');
    expect(bodyVariant(mk('horse', { sex: 'm' }))).toBe('body'); // alike
    expect(bodyVariant(mk('horse', { sex: 'm', tamed: true }))).toBe('alt');
    for (const k of ['rabbit', 'wolf', 'bear', 'fish']) expect(bodyVariant(mk(k, { sex: 'm' })), k).toBe('body');
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const by = (name) => r.group.children.find((m) => m.name === name);
    r.sync([mk('cow'), mk('cow', { sex: 'm' }), mk('cow', { sex: 'm', size: 0.55 }), mk('sheep', { sex: 'm' }), mk('pheasant', { sex: 'm' }), mk('turkey', { sex: 'm' })]);
    expect([by('cow-body').count, by('cow-male').count, by('sheep-male').count, by('pheasant-male').count, by('turkey-male').count]).toEqual([2, 1, 1, 1, 1]);
    const m = new THREE.Matrix4();
    by('cow-body').getMatrixAt(1, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(0.55, 6); // the calf, drawn small
    r.dispose();
  });
});

describe('populations — the save', () => {
  it('export → validate → load → export is the same; an untouched zone is saved without its animals and comes back the same', () => {
    const gen = fakeGen({ stream: (q) => q === 20 });
    const animals = new Animals(seededRng(800));
    const pigs = new Pigs(seededRng(801));
    const fauna = new Fauna({ animals, pigs, rng: seededRng(802) });
    const player = standing(30, 30);
    const env = makeEnv(flatWorld(), player, { gen, seed: 77 });
    env.t = 3.25;
    for (let i = 0; i < 6; i++) fauna.update(SCAN_S, env);
    const cow = animals.spawn('cow', 31, GROUND, 31, 0.5, 'f');
    for (let i = 0; i < 3; i++) animals.feed(cow, 'wild_tuber');
    animals.milk(cow);
    const saved = JSON.parse(JSON.stringify(fauna.export()));
    expect(saved.v).toBe(1);
    expect(saved.z.length).toBe(fauna.zones.size);
    // the precreated zones nobody came near are written as unseeded: their land and when they were made, no animals
    const untouched = saved.z.filter((z) => z.u === 1 && !z.a);
    expect(untouched.length).toBeGreaterThan(0);
    for (const z of untouched) expect(Object.keys(z).sort()).toEqual(expect.arrayContaining(['q', 'r', 't', 't0', 'u']));
    // canonical already
    expect(validateFaunaJSON(saved)).toEqual({ zones: saved.z, warnings: [] });
    // a live one is written where it stands, with its state
    const all = saved.z.flatMap((z) => z.a ?? []);
    expect(all).toContainEqual(expect.objectContaining({ k: 'cow', s: 'f', x: 31, y: GROUND, z: 31, w: 0.5, t: 1, mi: MILK_REGROW_S }));
    // back: the same document again; the untouched zones, once needed, are seeded exactly as before
    const back = new Fauna({ animals: new Animals(seededRng(803)), pigs: new Pigs(seededRng(804)), rng: seededRng(805) });
    back.load(saved, { seed: 77, now: 3.25 });
    expect(back.liveCount).toBe(0); // the first scan wakes what is near
    expect(JSON.parse(JSON.stringify(back.export()))).toEqual(saved);
    for (const zj of untouched) {
      const a = fauna.zones.get(zoneKey(zj.q, zj.r));
      const b = back.zone(zj.q, zj.r, true, makeEnv(flatWorld(), null, { gen, seed: 77 }));
      if (!a.seeded) fauna.zone(zj.q, zj.r, true, env);
      expect(b.list.map((r) => [r.kind, r.sex, r.born, r.x, r.z])).toEqual(a.list.map((r) => [r.kind, r.sex, r.born, r.x, r.z]));
    }
    // and the woken cow is the cow
    const envB = makeEnv(flatWorld(), standing(30, 30), { gen, seed: 77 });
    envB.t = 3.25;
    back.update(SCAN_S, envB);
    const c = back.animals.list.find((a) => a.kind === 'cow' && a.tamed);
    expect([c.x, c.y, c.z, c.yaw, c.sex, c.milked]).toEqual([31, GROUND, 31, 0.5, 'f', MILK_REGROW_S]);
  });

  it('validateFaunaJSON drops bad zones and animals with a warning and keeps to ZONE_MAX zones of ZONE_ANIMALS_MAX animals', () => {
    expect([ZONE_MAX, ZONE_ANIMALS_MAX]).toEqual([256, 200]);
    const good = { k: 'deer', s: 'f', b: -3, x: 1.5, y: GROUND, z: 2.5 };
    const v = validateFaunaJSON({
      v: 1,
      z: [
        { q: 0, r: 0, t: 5, K: { deer: 8, dragon: 3, cow: -1 }, g: 2, w: 0.7, a: [good, { k: 'dragon', s: 'f', b: 0, x: 0, y: 0, z: 0 }, { k: 'deer', s: 'x', b: 0, q: 1, r: 1 },
          { k: 'cow', s: 'm', b: 0, q: 1, r: 2, t: 1 }, { k: 'deer', s: 'm', b: 0, q: 1, r: 2, t: 1 }, null] },
        { q: 0, r: 0, t: 1 },
        { q: 'x', r: 0, t: 1 },
      ],
    });
    expect(v.warnings).toEqual(['fauna.z[0].a[1]: invalid, dropped', 'fauna.z[0].a[2]: invalid, dropped', 'fauna.z[0].a[5]: invalid, dropped',
      'fauna.z[1]: zone 0,0 twice, dropped', 'fauna.z[2]: invalid, dropped']);
    expect(v.zones).toHaveLength(1);
    expect(v.zones[0]).toMatchObject({ K: { deer: 8 }, g: 1, w: DRY_WATER });
    // a cow may be tame, a deer never
    expect(v.zones[0].a).toEqual([good, { k: 'cow', s: 'm', b: 0, q: 1, r: 2, t: 1 }, { k: 'deer', s: 'm', b: 0, q: 1, r: 2 }]);
    const many = { v: 1, z: Array.from({ length: ZONE_MAX + 2 }, (_, i) => ({ q: i, r: 0, t: 0, a: i === 0 ? Array.from({ length: ZONE_ANIMALS_MAX + 1 }, () => good) : [] })) };
    const capped = validateFaunaJSON(many);
    expect(capped.zones).toHaveLength(ZONE_MAX);
    expect(capped.zones[0].a).toHaveLength(ZONE_ANIMALS_MAX);
    expect(capped.warnings).toEqual([`fauna.z[0]: more than ${ZONE_ANIMALS_MAX} animals, the rest dropped`, `fauna: more than ${ZONE_MAX} zones, the rest dropped`]);
    expect(validateFaunaJSON('junk').warnings).toEqual(['fauna: not a fauna object, ignored']);
    expect(validateFaunaJSON(undefined)).toEqual({ zones: [], warnings: [] });
  });

  it('through the save file: `fauna` is written and read back; an older save\'s `animals` and `pigs` go into their zones exactly as they stood', () => {
    const fauna = { v: 1, z: [{ q: 0, r: 0, t: 2, K: { deer: 8 }, g: 1, w: 1, a: [{ k: 'deer', s: 'm', b: -9, x: 3, y: GROUND, z: 4, w: 1.2 }] }] };
    const base = { seed: 7, time: 0.3, day: 3, player: { x: 0, y: 20, z: 0, yaw: 0, pitch: 0 }, edits: {} };
    const text = serializeSave({ ...base, fauna });
    expect(deserializeSave(text).fauna).toEqual(fauna);
    const bad = deserializeSave(JSON.stringify({ ...JSON.parse(text), fauna: { v: 1, z: [{ q: 0, r: 0, t: 1, a: [{ k: 'cow' }] }] } }));
    expect(bad.warnings).toContain('fauna.z[0].a[0]: invalid, dropped');
    // a save from before §88: its animals and pigs, every field they had
    const old = [
      { k: 'horse', x: 5.5, y: GROUND, z: 6.25, yaw: 1.25, h: 7, t: 1 },
      { k: 'deer', x: 7, y: GROUND, z: 8, yaw: 0, h: 8, v: 1 },
      { k: 'sheep', x: 9, y: GROUND, z: 2, yaw: 0, h: 6, s: 120 },
      { k: 'cow', x: -200, y: GROUND, z: 3, yaw: 0, h: 10, m: 60 },
    ];
    const oldPigs = [{ x: 12.5, y: GROUND, z: 13, yaw: 0.5 }];
    const loaded = deserializeSave(serializeSave({ ...base, animals: old, pigs: oldPigs }));
    expect(loaded.animals).toEqual(validateAnimalsJSON(old).animals);
    const animals = new Animals(seededRng(820));
    const pigs = new Pigs(seededRng(821));
    const store = new Fauna({ animals, pigs, rng: seededRng(822) });
    store.load(loaded.fauna, { animals: loaded.animals, pigs: loaded.pigs, seed: 7, now: 2.3 });
    expect(store.dormantCount).toBe(5);
    expect(store.zones.has(zoneKey(...zoneOf(...worldToHex(-200, 3))))).toBe(true);
    const env = makeEnv(flatWorld(), standing(5, 5));
    env.t = 2.3;
    store.update(SCAN_S, env);
    const horse = animals.list.find((a) => a.kind === 'horse');
    expect([horse.x, horse.y, horse.z, horse.yaw, horse.health, horse.tamed]).toEqual([5.5, GROUND, 6.25, 1.25, 7, true]);
    expect(animals.list.find((a) => a.kind === 'deer')).toMatchObject({ sex: 'm', variant: 1 }); // a stag stays a stag
    expect(animals.list.find((a) => a.kind === 'sheep').shorn).toBe(120);
    const pig = pigs.list[0];
    expect([pig.x, pig.y, pig.z, pig.yaw, pig.health]).toEqual([12.5, GROUND, 13, 0.5, PIG_HEALTH]);
    expect(animals.list.find((a) => a.kind === 'cow')).toBeUndefined(); // 200 m away: asleep where it stood
  });
});

describe('populations — the debug handle', () => {
  it('zoneReport: the zone, its biome mix and per kind N, K, f, m, young and able; step advances every zone in memory', () => {
    const fauna = new Fauna({ rng: seededRng(900) });
    const env = makeEnv(flatWorld(), null, { gen: fakeGen({ stream: (q) => q === 20 }), seed: 3 });
    const young = makeRecord('deer', 'f', 0, 12, GROUND, 10, true, 0);
    putZone(fauna, 0, 0, { deer: 8 }, {}, [rec('deer', 'f', 10, 10), rec('deer', 'm', 11, 10), rec('deer', 'f', 40, 10), young]);
    const rep = fauna.zoneReport(5, 5, env);
    expect(rep.zone).toEqual([0, 0]);
    expect(rep.biomes).toEqual({ plains: 1 });
    expect(rep.kinds.deer).toEqual({ N: 4, K: 8, f: 3, m: 1, young: 1, able: 1 }); // the far doe has no male near; the fawn is young
    const before = fauna.zones.get('0,0').list.length;
    const res = fauna.step(60, env);
    expect(res.days).toBe(60);
    expect(res.zones).toBe(1);
    expect(fauna.zones.get('0,0').list.length).toBe(before + res.young);
    expect(res.births).toBeGreaterThan(0);
    // a zone not in memory is made for the report
    const made = fauna.zoneReport(200, 200, env);
    expect(made.zone).toEqual([3, 3]);
    expect(Object.keys(made.kinds).length).toBeGreaterThan(3);
    expect(fauna.debugLine(...hexToWorld(5, 5))).toMatch(/^Fauna: zone 0 0 · deer \d+\/8$/);
  });
});

describe('populations — what it costs', () => {
  it('dormant animals cost nothing per frame: frames between scans do not touch them', () => {
    const fauna = new Fauna({ animals: new Animals(seededRng(950)), pigs: new Pigs(), rng: seededRng(951) });
    const env = makeEnv(flatWorld(), standing(10, 10));
    for (let i = 0; i < 40; i++) putZone(fauna, 10 + i, 10, { rabbit: 12 }, {}, Array.from({ length: 150 }, (_, k) => rec('rabbit', 'f', 640 + i * 64 + k * 0.1, 600)));
    expect(fauna.dormantCount).toBe(6000);
    // spy on the far zones' lists: no frame reads them, scans included (they are not in range)
    let reads = 0;
    for (const z of fauna.zones.values()) {
      const list = z.list;
      Object.defineProperty(z, 'list', { get: () => { reads++; return list; }, set: () => {}, configurable: true });
    }
    putZone(fauna, 0, 0, {});
    for (let f = 0; f < 600; f++) fauna.update(1 / 60, env);
    expect(reads).toBe(0);
  });

  it('a waking zone catches up 120 days in a couple of milliseconds (the real generator\'s land); a frame between scans costs a timer', () => {
    const gen = createWorldGen(31337, { gen: 5 });
    // each of 25 zones woken 120 days after it was made, five times over (the same land, other dice); a zone's time is
    // its best of the five, so a busy test machine (the suite runs on all cores) does not decide it
    const best = new Array(25).fill(Infinity);
    for (let rep = 0; rep < 5; rep++) {
      const fauna = new Fauna({ rng: seededRng(960 + rep) });
      const env = makeEnv(flatWorld(), null, { gen, seed: 31337 });
      const zones = [];
      for (let zq = -2; zq <= 2; zq++) for (let zr = -2; zr <= 2; zr++) zones.push(fauna.zone(zq, zr, true, env));
      fauna._setNow(CATCH_UP_DAYS);
      const ctx = fauna._ctx(env);
      zones.forEach((z, i) => {
        const t0 = performance.now();
        fauna._advance(z, 0, CATCH_UP_DAYS, ctx);
        best[i] = Math.min(best[i], performance.now() - t0);
      });
    }
    // the median zone well under a millisecond, the slowest within a couple (measured on a quiet machine: median
    // 0.3 ms, the slowest of 169 zones 2.6 ms)
    expect(median(best)).toBeLessThan(1);
    expect(Math.max(...best)).toBeLessThan(4);
    // a frame between scans
    const animals = new Animals(seededRng(970));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(971) });
    const env = makeEnv(flatWorld(), standing(10, 10));
    putZone(fauna, 0, 0, {});
    for (let i = 0; i < LIVE_MAX; i++) animals.spawn('rabbit', 5 + (i % 8), GROUND, 5 + Math.floor(i / 8));
    fauna.update(SCAN_S, env);
    const t0 = performance.now();
    for (let f = 0; f < 2000; f++) fauna.update(1 / 600, env); // (a tenth of a scan a call: one scan in 300 frames)
    const per = (performance.now() - t0) / 2000;
    expect(per).toBeLessThan(0.05);
    expect(STEP_DAYS).toBeCloseTo(1 / 24, 12);
  });
});
