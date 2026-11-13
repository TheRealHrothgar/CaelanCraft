// Unit tests for the game of the harder land (v0.14, CONTRACTS §76 fauna): deer, rabbits, pheasants, wild turkeys, the bear
// and the fish of the streams (src/animals.js), their models (src/animalRenderer.js), what a hunt gives (harvest, items,
// cooking), the Fletched Dart (looseItems, crafting), the Ground Nest (blocks, harvest, mesher), `summon` and the save.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BLOCK, BIOME, TILE, getBlockDef, getBlockShape, isPlaceable, isSolid } from '../../src/blocks.js';
import {
  WALK_SPEED, SPRINT_SPEED, FLY_SPEED, REACH, ZOMBIE_DAMAGE, ZOMBIE_HIT_PUSH, ZOMBIE_HIT_LIFT, CHUNK_SIZE,
} from '../../src/config.js';
import {
  Animals, SPECIES, ANIMAL_KINDS, ANIMAL_MAX, SOUNDS, MEAT_LURE, HERD_WEIGHTS, BEHIND_NOTICE, noticeRange, bearRange, fishDepth, fleeSpeed, poolOf,
  validateAnimalsJSON, SNEAK_NOTICE, SPRINT_NOTICE, CALM_FACTOR, HERD_CHECK_S, HERD_TARGET, HERD_RADIUS, HERD_CHANCE, SMALL_TARGET, SMALL_CHANCE,
  BEAR_NEAR, ZIG_ANGLE, FLUSH_S, FLUSH_SPEED, TURKEY_GLIDE_S, NEST_HEN_P, NEST_FIRST_S, NEST_EVERY_S, NEST_RETRY_S, NEST_PRIVACY, NEST_SPACING,
  BEAR_WARN_S,
  BEAR_BACK_OFF, BEAR_CHARGE_DIST, BEAR_CHASE_S, BEAR_GIVE_UP, BEAR_REST_S, BEAR_REACH, BEAR_MAUL_S, BEAR_RECOVER_S, BEAR_DAMAGE, BEAR_PUSH,
  BEAR_LIFT,
  FISH_MIN_WATER, FISH_UNDER, FISH_DART, FISH_DART_S, FISH_CHECK_S, FISH_TARGET, FISH_RADIUS, FISH_MIN, FISH_MAX, FISH_CAP,
  TRAP_HOLD_S, TRAP_IMMUNE_S, ANIMAL_HURT_S, ANIMAL_KNOCKBACK,
} from '../../src/animals.js';
import { createAnimalRenderer, bodyVariant, legCount, MODELS } from '../../src/animalRenderer.js';
import { seededRng } from '../../src/pigs.js';
import { createPlayer, stepPlayer } from '../../src/physics.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { MOB_DROPS, PICKABLE, BLOCK_RULES, rollMobDrops, pick, rollDrops, isPickable } from '../../src/harvest.js';
import { ITEMS, getItem, isItemKey } from '../../src/items.js';
import { FIRE_TRANSFORMS, isSkewerFood } from '../../src/cooking.js';
import { getRecipe } from '../../src/crafting.js';
import { throwOf, dartBreakP, DART_KEYS, THROW_DART, THROW_FLETCHED, DART_BREAK_P, FLETCHED_BREAK_P } from '../../src/looseItems.js';
import { DAMAGE_CAUSES, fallDamage } from '../../src/vitals.js';
import { Survival, deathTitle } from '../../src/survival.js';
import { DEATH_CAUSES, serializeSave, deserializeSave } from '../../src/storage.js';
import { KIND_STATS } from '../../src/zombies.js';
import { paintTile } from '../../src/tiles.js';
import { paintItem, hasItemArt } from '../../src/itemArt.js';
import { buildChunkMesh, NEST_WALL, NEST_EGGS } from '../../src/mesher.js';
import { World } from '../../src/world.js';
import { parseLine, executeCommand } from '../../src/commands.js';
import { flatWorldGen, makeChunkData, makeChunkDataGetter, setWorldBlock } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10;
const DT = 1 / 60;
const NEW_KINDS = ['deer', 'rabbit', 'pheasant', 'turkey', 'bear', 'fish'];

/** Flat grass world: grass at GROUND − 1, air above. `extra` maps "q,y,r" → block id. */
function flatWorld(extra = new Map()) {
  return (q, y, r) => extra.get(`${q},${y},${r}`) ?? (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
}
/** The same land with a channel of water one cell deep in its top layer: rows r0..r1, for q −len..len. */
function channelWorld(len = 8, r0 = 0, r1 = 1, extra = new Map()) {
  const water = new Map(extra);
  for (let q = -len; q <= len; q++) for (let r = r0; r <= r1; r++) water.set(`${q},${GROUND - 1},${r}`, B.WATER);
  return flatWorld(water);
}
const view = (getBlock, player, more = {}) => ({ getBlock, isLoaded: () => true, player, heldKey: null, ...more });
const standing = (x, z, more = {}) => Object.assign(createPlayer(x, GROUND, z), { onGround: true }, more);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function run(as, world, seconds, each) {
  for (let f = 0; f < seconds * 60; f++) {
    const ev = as.update(DT, world);
    if (each && each(ev, f) === false) return f;
  }
  return -1;
}

describe('fauna — the kinds (§76)', () => {
  it('six new kinds beside the four; none is lured or tamed; each has a voice and a place to appear', () => {
    expect(ANIMAL_KINDS.slice(4)).toEqual(NEW_KINDS);
    const as = new Animals(seededRng(1));
    for (const k of NEW_KINDS) {
      const sp = SPECIES[k];
      expect([sp.lure.length, sp.tame], k).toEqual([0, 0]);
      expect(sp.radius, k).toBeLessThanOrEqual(0.5);
      expect(Object.hasOwn(SOUNDS, sp.voice), `${k}: ${sp.voice}`).toBe(true);
      const a = as.spawn(k, 0, GROUND, 0);
      expect(a).toMatchObject({ kind: k, health: sp.health, tamed: false, variant: 0, air: 0, rear: 0 });
      for (const food of ['wild_tuber', 'raw_pork', 'honeyberries']) expect(as.feed(a, food), `${k} ${food}`).toEqual({ ok: false });
      expect(a.tamed).toBe(false);
    }
    // every sound a new behaviour plays exists and ends within its length
    for (const name of ['bleat', 'squeak', 'cackle', 'gobble', 'grunt', 'growl', 'roar', 'plop', 'flush']) {
      const s = SOUNDS[name];
      expect(s.layers.length, name).toBeGreaterThan(0);
      for (const l of s.layers) expect((l.delay ?? 0) + (l.attack ?? 0.002) + l.decay, name).toBeLessThanOrEqual(s.dur + 1e-9);
    }
    // the pools: herds (the big animals), small game, fish
    expect(ANIMAL_KINDS.map(poolOf)).toEqual(['herd', 'herd', 'herd', 'herd', 'herd', 'small', 'small', 'small', 'herd', 'fish']);
    expect(poolOf('dragon')).toBe('herd');
    // where they appear: deer in forest and plains; the bear in forest, mountains and snowy land; fish in no land's table
    const lands = (k) => Object.keys(HERD_WEIGHTS).map(Number).filter((b) => (HERD_WEIGHTS[b][k] ?? 0) > 0).sort();
    expect(lands('deer')).toEqual([BIOME.PLAINS, BIOME.FOREST]);
    expect(lands('bear')).toEqual([BIOME.FOREST, BIOME.SNOWY, BIOME.MOUNTAINS].sort());
    expect(lands('pheasant')).toEqual([BIOME.PLAINS, BIOME.FOREST]);
    expect(lands('turkey')).toEqual([BIOME.PLAINS, BIOME.FOREST]);
    expect(lands('rabbit')).toHaveLength(4);
    expect(lands('fish')).toEqual([]);
    for (const w of Object.values(HERD_WEIGHTS)) for (const k of Object.keys(w)) expect(ANIMAL_KINDS).toContain(k);
    // a wolf comes to the game meats too (not to fish or eggs)
    for (const m of ['venison', 'rabbit', 'fowl', 'bear']) expect(MEAT_LURE).toEqual(expect.arrayContaining([`raw_${m}`, `roast_${m}`]));
    for (const k of MEAT_LURE) expect(isItemKey(k), k).toBe(true);
    expect(ANIMAL_MAX).toBe(40);
  });

  it('who outruns whom: deer, rabbits, turkeys and the bear beat a sprint; the deer is the wariest thing on land', () => {
    for (const k of ['deer', 'rabbit', 'turkey', 'bear']) expect(fleeSpeed(k), k).toBeGreaterThan(SPRINT_SPEED);
    expect(fleeSpeed('bear')).toBeLessThan(SPRINT_SPEED * 1.2); // a head start is enough to get away
    expect(FLUSH_SPEED).toBe(FLY_SPEED);
    expect(FLUSH_SPEED).toBeGreaterThan(1.8 * SPRINT_SPEED);
    const runners = ANIMAL_KINDS.filter((k) => !SPECIES[k].predator);
    expect(Math.max(...runners.map((k) => SPECIES[k].notice))).toBe(SPECIES.deer.notice);
    expect(SPECIES.deer.notice * SNEAK_NOTICE).toBeGreaterThan(REACH); // sneaking does not bring a deer within arm's reach …
    expect(SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE).toBeLessThan(REACH); // … unless it is from behind (v0.16),
    // and then only with an axe's reach or more (survivalControl.STRIKE_REACH: axe 4, knife 3)
    expect(SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE).toBeGreaterThan(3);
    expect(SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE).toBeLessThan(4);
    for (const k of ['rabbit', 'pheasant', 'turkey', 'fish']) expect(SPECIES[k].notice * SNEAK_NOTICE, k).toBeLessThan(REACH);
  });
});

describe('fauna — deer: very skittish herds', () => {
  it('a deer notices a walker at 16 m, a sneaker at 6.4, a sprinter at 21.6', () => {
    const n = SPECIES.deer.notice;
    expect([n, n * SNEAK_NOTICE, n * SPRINT_NOTICE]).toEqual([16, 6.4, 16 * SPRINT_NOTICE]);
    const cases = [[{}, 15, true], [{}, 17, false], [{ sneaking: true }, 7, false], [{ sneaking: true }, 6, true],
      [{ sprinting: true }, 21, true], [{ sprinting: true }, 22.5, false]];
    for (const [more, d, flees] of cases) {
      const as = new Animals(seededRng(2));
      const a = as.spawn('deer', 0, GROUND, 0);
      as.update(DT, view(flatWorld(), standing(-d, 0, more)));
      expect(a.mode === 'flee', `${JSON.stringify(more)} at ${d}`).toBe(flees);
    }
  });

  it('the herd bolts together, faster than the player can sprint, and does not stop until it is far away', () => {
    const as = new Animals(seededRng(3));
    const herd = [as.spawn('deer', 0, GROUND, 0), as.spawn('deer', 3, GROUND, 2), as.spawn('deer', 2, GROUND, -4)];
    const player = standing(-15, 0);
    const world = view(flatWorld(), player);
    const ev = as.update(DT, world);
    expect(ev.startled).toEqual(expect.arrayContaining(herd));
    let top = 0;
    const far = herd.map(() => 0);
    run(as, world, 8, () => {
      top = Math.max(top, Math.hypot(herd[0].vx, herd[0].vz));
      herd.forEach((a, i) => {
        far[i] = Math.max(far[i], dist(a, player));
      });
    });
    expect(top).toBeGreaterThan(SPRINT_SPEED * 1.2);
    // farther than any other animal bolts: its own `calm` (2.5 × notice = 40 m) against CALM_FACTOR × notice
    expect(SPECIES.deer.calm).toBeGreaterThan(CALM_FACTOR);
    for (const d of far) expect(d).toBeGreaterThan(SPECIES.deer.notice * SPECIES.deer.calm - 1);
    for (const k of ['cow', 'sheep', 'horse', 'wolf']) expect(SPECIES.deer.notice * SPECIES.deer.calm).toBeGreaterThan(SPECIES[k].notice * CALM_FACTOR);
  });

  it('every natural herd of deer has one stag, and a stag stays a stag through the save', () => {
    const as = new Animals(seededRng(4));
    const hooks = { getBiome: () => BIOME.FOREST, groundHeight: () => GROUND - 1, isNaturalGround: () => true, isLoadedCell: () => true };
    const world = view(flatWorld(), standing(0, 0, { flying: true }), hooks);
    let deer = [];
    for (let k = 0; k < 400 && deer.length === 0; k++) {
      as.clear();
      as._spawnHerd(world.player, world, 'herd');
      deer = as.list.filter((a) => a.kind === 'deer');
    }
    expect(deer.length).toBeGreaterThanOrEqual(SPECIES.deer.herd[0]);
    expect(deer.length).toBeLessThanOrEqual(SPECIES.deer.herd[1]);
    expect(deer.filter((a) => a.variant === 1)).toHaveLength(1);
    expect(bodyVariant(deer.find((a) => a.variant === 1))).toBe('alt');
    expect(bodyVariant(deer.find((a) => a.variant === 0))).toBe('body');
    const back = new Animals(seededRng(5));
    back.load(JSON.parse(JSON.stringify(as.export())));
    expect(back.list.map((a) => a.variant)).toEqual(as.list.map((a) => a.variant));
    // only a deer can be a stag
    expect(validateAnimalsJSON([{ k: 'cow', x: 0, y: 1, z: 2, v: 1 }, { k: 'deer', x: 0, y: 1, z: 2, v: 1 }]).animals.map((e) => e.v)).toEqual([undefined, 1]);
  });
});

describe('fauna — rabbits: small, quick, zig-zagging', () => {
  it('a running rabbit swerves to both sides of the line away from the player, again and again', () => {
    const as = new Animals(seededRng(6));
    const a = as.spawn('rabbit', 0, GROUND, 0);
    const player = standing(-5, 0);
    const world = view(flatWorld(), player);
    let flips = 0;
    let last = 0;
    let top = 0;
    const sides = new Set();
    run(as, world, 2.5, () => {
      if (a.mode !== 'flee') return;
      const speed = Math.hypot(a.vx, a.vz);
      top = Math.max(top, speed);
      if (speed < 2) return;
      // which side of the line from the player through the rabbit it is running to
      const ax = a.x - player.x;
      const az = a.z - player.z;
      const side = Math.sign(ax * a.vz - az * a.vx);
      if (side !== 0 && last !== 0 && side !== last) flips++;
      if (side !== 0) {
        last = side;
        sides.add(side);
      }
    });
    expect(flips).toBeGreaterThanOrEqual(3);
    expect([...sides].sort()).toEqual([-1, 1]);
    expect(top).toBeGreaterThan(SPRINT_SPEED);
    expect(ZIG_ANGLE).toBeGreaterThan(0.5);
    expect(a.x).toBeGreaterThan(5); // and still it gets away from the player
    // it is a small target: its cylinder is a fifth of a cow's width … and has no padding
    expect(SPECIES.rabbit.radius).toBeLessThan(SPECIES.cow.radius / 2);
    expect(SPECIES.rabbit.pad).toBeUndefined();
  });

  it('a set snare catches a rabbit that steps into it, and a baited one draws it from cells away', () => {
    const [sx, sz] = hexToWorld(0, 0);
    const as = new Animals(seededRng(7));
    const a = as.spawn('rabbit', sx, GROUND, sz);
    const ev = as.update(DT, view(flatWorld(new Map([[`0,${GROUND},0`, B.SNARE]])), null));
    expect(ev.caught.map((c) => [c.animal, c.cell])).toEqual([[a, [0, GROUND, 0]]]);
    expect(a.trapped).toBe(TRAP_HOLD_S);

    const [bx, bz] = hexToWorld(4, 0);
    const baited = new Map([[`4,${GROUND},0`, B.SNARE_BAITED]]);
    const bs = new Animals(seededRng(8));
    const b = bs.spawn('rabbit', sx, GROUND, sz);
    let caught = null;
    run(bs, view(flatWorld(baited), null), 40, (e) => {
      if (e.caught.length) caught = e.caught[0];
      return caught === null;
    });
    expect(caught).not.toBeNull();
    expect(caught.animal).toBe(b);
    expect(Math.hypot(b.x - bx, b.z - bz)).toBeLessThan(0.6);
  });
});

describe('fauna — snares let go once (the freed event is not repeated)', () => {
  it('a snare that has released an animal holds the next one it catches', () => {
    const cells = new Map([[`0,${GROUND},0`, B.SNARE]]);
    const getBlock = flatWorld(cells);
    const [x, z] = hexToWorld(0, 0);
    const as = new Animals(seededRng(9));
    const a = as.spawn('rabbit', x, GROUND, z);
    const world = view(getBlock, null);
    /** what main does with the events */
    const apply = (ev) => {
      for (const c of ev.caught) cells.set(c.cell.join(','), B.SNARE_SPRUNG);
      for (const f of ev.freed) if (cells.get(f.cell.join(',')) === B.SNARE_SPRUNG) cells.set(f.cell.join(','), B.SNARE);
    };
    let caught = 0;
    let freedFrames = 0;
    run(as, world, TRAP_HOLD_S + 2, (ev) => {
      caught += ev.caught.length;
      if (ev.freed.length) freedFrames++;
      apply(ev);
    });
    expect([caught, freedFrames]).toEqual([1, 1]); // caught once, let go once — reported in one frame only
    expect(cells.get(`0,${GROUND},0`)).toBe(B.SNARE);
    // put it back in the noose once it may be caught again: this time it is held as long as the first
    a.immune = 0;
    a.mode = 'idle';
    a.x = x;
    a.z = z;
    a.vx = 0;
    a.vz = 0;
    let held = 0;
    run(as, world, 5, (ev) => {
      apply(ev);
      if (a.trapped > 0) held++;
    });
    expect(held).toBeGreaterThan(4 * 60);
    expect(cells.get(`0,${GROUND},0`)).toBe(B.SNARE_SPRUNG);
    // remove() between two updates still frees the snare, once
    as.remove(a);
    expect(as.update(DT, world).freed).toHaveLength(1);
    expect(as.update(DT, world).freed).toHaveLength(0);
    expect(TRAP_IMMUNE_S).toBeGreaterThan(0);
  });
});

describe('fauna — pheasants flush, turkeys dart off', () => {
  it('a spooked pheasant bursts into the air, flies low and fast, and lands well away from the player', () => {
    const as = new Animals(seededRng(10));
    const a = as.spawn('pheasant', 0, GROUND, 0);
    const mate = as.spawn('pheasant', 1.5, GROUND, 1);
    const player = standing(-(SPECIES.pheasant.notice - 1), 0);
    const world = view(flatWorld(), player);
    const start = dist(a, player);
    let flushed = [];
    let maxY = 0;
    let top = 0;
    let airS = 0;
    let lowest = Infinity;
    const flewAs = new Set();
    run(as, world, 10, (ev) => {
      flushed = flushed.concat(ev.flushed);
      maxY = Math.max(maxY, a.y - GROUND);
      lowest = Math.min(lowest, a.y);
      if (a.air !== 0) {
        airS += DT;
        top = Math.max(top, Math.hypot(a.vx, a.vz));
        flewAs.add(a.flying);
      }
    });
    expect(flushed).toEqual(expect.arrayContaining([a, mate])); // the whole covey goes up, once each
    expect(flushed).toHaveLength(2);
    expect([...flewAs]).toEqual([true]); // through physics' flight: no gravity while it is up
    // a LOW arc: well off the ground, never far above its cruise height
    expect(maxY).toBeGreaterThan(1.5);
    expect(maxY).toBeLessThan(SPECIES.pheasant.cruise + 0.5);
    expect(lowest).toBeGreaterThan(GROUND - 0.01);
    // fast: about twice a sprint
    expect(top).toBeGreaterThan(FLUSH_SPEED * 0.95);
    expect(airS).toBeGreaterThan(FLUSH_S[0]);
    expect(airS).toBeLessThan(FLUSH_S[1] + 1.2); // its time in the air, and the glide down
    // down again, on the ground, calm — and well away: farther than it started, by tens of metres
    expect([a.air, a.flying, a.onGround]).toEqual([0, false, true]);
    expect(a.y).toBeCloseTo(GROUND, 1);
    expect(a.mode).not.toBe('flee');
    expect(dist(a, player)).toBeGreaterThan(start + 20);
    expect(dist(a, player)).toBeGreaterThan(SPECIES.pheasant.notice * 4);
    expect(dist(mate, player)).toBeGreaterThan(start + 20);
  });

  it('left alone it stays on the ground; a sneaking player comes within 3 m before it goes up', () => {
    const quiet = new Animals(seededRng(11));
    const q = quiet.spawn('pheasant', 0, GROUND, 0);
    let everUp = false;
    run(quiet, view(flatWorld(), null), 20, () => {
      if (q.air !== 0 || q.y > GROUND + 0.6) everUp = true;
    });
    expect(everUp).toBe(false);
    for (const [d, up] of [[3.2, false], [2.5, true]]) {
      const as = new Animals(seededRng(12));
      const a = as.spawn('pheasant', 0, GROUND, 0);
      const ev = as.update(DT, view(flatWorld(), standing(-d, 0, { sneaking: true })));
      expect([ev.flushed.length, a.air > 0], `sneaking at ${d}`).toEqual(up ? [1, true] : [0, false]);
    }
    expect(noticeRange({ kind: 'pheasant' }, { sneaking: true })).toBeCloseTo(2.8, 9);
  });

  it('a blow flushes it too: the flush is reported by the next update, once', () => {
    const as = new Animals(seededRng(13));
    const a = as.spawn('pheasant', 0, GROUND, 0);
    a.health = 5; // so the blow does not kill it
    const world = view(flatWorld(), null);
    as.update(DT, world);
    expect(as.wound(a, 1, -3, 0)).toBe('hit');
    expect(a.air).toBeGreaterThan(0);
    expect(as.update(DT, world).flushed).toEqual([a]);
    expect(as.update(DT, world).flushed).toEqual([]);
    // it flies away from where the blow came from
    run(as, world, 5);
    expect(a.x).toBeGreaterThan(15);
    expect(a.air).toBe(0);
  });

  it('a turkey darts off: a short, low glide, then a run faster than the player can sprint', () => {
    const as = new Animals(seededRng(14));
    const a = as.spawn('turkey', 0, GROUND, 0);
    const player = standing(-6, 0);
    const world = view(flatWorld(), player);
    let maxY = 0;
    let airS = 0;
    let flushed = 0;
    let groundTop = 0;
    let landed = -1;
    run(as, world, 4, (ev, f) => {
      flushed += ev.flushed.length;
      // the player sprints after it, so it keeps running once it is down
      player.x += SPRINT_SPEED * DT;
      maxY = Math.max(maxY, a.y - GROUND);
      if (a.air !== 0) airS += DT;
      else if (flushed > 0 && landed < 0) landed = f;
      // its speed on foot, once the glide's own speed has worn off
      if (landed >= 0 && f > landed + 30 && a.mode === 'flee') groundTop = Math.max(groundTop, Math.hypot(a.vx, a.vz));
    });
    expect(flushed).toBe(1);
    expect(airS).toBeGreaterThan(TURKEY_GLIDE_S - 0.05);
    expect(airS).toBeLessThan(FLUSH_S[0]); // far shorter than a pheasant's flight
    expect(maxY).toBeGreaterThan(0.4);
    expect(maxY).toBeLessThan(SPECIES.turkey.cruise + 0.4); // and far lower
    expect(SPECIES.turkey.cruise).toBeLessThan(SPECIES.pheasant.cruise / 2);
    expect(groundTop).toBeGreaterThan(SPRINT_SPEED * 1.1);
    expect(groundTop).toBeLessThan(fleeSpeed('turkey') + 0.2);
    expect(dist(a, player)).toBeGreaterThan(6); // the sprinting player has not gained on it
  });
});

describe('fauna — ground nests', () => {
  it('a hen left in peace lays a nest where she stands; never while the player is near; never beside a full nest', () => {
    const lay = (kind, extra, player) => {
      const as = new Animals(seededRng(15));
      const a = as.spawn(kind, 0, GROUND, 0);
      a.nestIn = 0.01;
      a.onGround = true;
      const ev = as.update(DT, view(flatWorld(extra), player));
      return { laid: ev.laid.map((n) => ({ ...n })), a };
    };
    const [q0, r0] = worldToHex(0, 0);
    for (const kind of ['pheasant', 'turkey']) {
      const { laid, a } = lay(kind, new Map(), null);
      expect(laid, kind).toEqual([{ cell: [q0, GROUND, r0], refill: false }]);
      expect(a.nestIn).toBeGreaterThanOrEqual(NEST_EVERY_S[0] - DT);
      expect(a.nestIn).toBeLessThanOrEqual(NEST_EVERY_S[1]);
    }
    // somebody is watching (sneaking, so she is not spooked): no nest, and she tries again soon
    const watched = lay('pheasant', new Map(), standing(-(NEST_PRIVACY - 2), 0, { sneaking: true }));
    expect(watched.laid).toEqual([]);
    expect(watched.a.nestIn).toBeCloseTo(NEST_RETRY_S, 5);
    expect(lay('pheasant', new Map(), standing(-(NEST_PRIVACY + 2), 0, { sneaking: true })).laid).toHaveLength(1);
    // a nest with eggs within NEST_SPACING cells: none here; just outside: one
    expect(lay('pheasant', new Map([[`${NEST_SPACING},${GROUND},0`, B.GROUND_NEST]]), null).laid).toEqual([]);
    expect(lay('pheasant', new Map([[`${NEST_SPACING + 1},${GROUND},0`, B.GROUND_NEST]]), null).laid).toHaveLength(1);
    // an EMPTY nest that near is laid in again instead
    expect(lay('turkey', new Map([[`3,${GROUND},-2`, B.GROUND_NEST_EMPTY]]), null).laid).toEqual([{ cell: [3, GROUND, -2], refill: true }]);
    // no nest into a cell that holds something, and other kinds never lay
    expect(lay('pheasant', new Map([[`${q0},${GROUND},${r0}`, B.TUSSOCK]]), null).laid).toEqual([]);
    for (const kind of ['deer', 'rabbit', 'cow']) expect(lay(kind, new Map(), null).laid, kind).toEqual([]);
    expect(SPECIES.pheasant.nests && SPECIES.turkey.nests).toBe(true);
    // about half the birds are laying hens, and a hen's first nest comes a minute or more after she appears; the rest
    // of the birds, and every other kind, never lay
    const flock = new Animals(seededRng(150));
    const birds = Array.from({ length: 36 }, (_, i) => flock.spawn(i % 2 ? 'pheasant' : 'turkey', i * 3, GROUND, 0));
    const hens = birds.filter((a) => Number.isFinite(a.nestIn));
    expect(hens.length).toBeGreaterThan(36 * NEST_HEN_P - 9);
    expect(hens.length).toBeLessThan(36 * NEST_HEN_P + 9);
    for (const a of hens) expect(a.nestIn >= NEST_FIRST_S[0] && a.nestIn <= NEST_FIRST_S[1]).toBe(true);
    expect(NEST_FIRST_S[0]).toBeGreaterThanOrEqual(60);
    expect(flock.spawn('deer', 200, GROUND, 0).nestIn).toBe(Infinity);
    // … so a bird that is no hen walks about for ten minutes and lays nothing
    const cock = new Animals(seededRng(151));
    const c = cock.spawn('pheasant', 0, GROUND, 0);
    c.nestIn = Infinity;
    let laidByCock = 0;
    for (let f = 0; f < 600; f++) laidByCock += cock.update(1, view(flatWorld(), null)).laid.length;
    expect(laidByCock).toBe(0);
  });

  it('the Ground Nest: R takes 1–3 eggs (and now and then a feather) and leaves it empty; breaking it gives fewer', () => {
    expect([B.GROUND_NEST, B.GROUND_NEST_EMPTY]).toEqual([121, 132]); // either side of the ten plants
    for (const id of [B.GROUND_NEST, B.GROUND_NEST_EMPTY]) {
      const d = getBlockDef(id);
      expect([d.solid, d.placeable, d.icon, getBlockShape(id), isSolid(id), isPlaceable(id)], d.name).toEqual([false, false, 'flat', 'litter', false, false]);
      expect(BLOCK_RULES[id]).toMatchObject({ h: 0.3, tool: null, tier: 0 });
    }
    expect(getBlockDef(B.GROUND_NEST).displayName).toBe('Ground Nest');
    expect(isPickable(B.GROUND_NEST) && !isPickable(B.GROUND_NEST_EMPTY)).toBe(true);
    expect(PICKABLE[B.GROUND_NEST].to).toBe(B.GROUND_NEST_EMPTY);
    expect(pick(B.GROUND_NEST, {}, () => 0)).toEqual({ to: B.GROUND_NEST_EMPTY, drops: [{ k: 'raw_egg', n: 1 }, { k: 'feather', n: 1 }] });
    expect(pick(B.GROUND_NEST, {}, () => 0.99)).toEqual({ to: B.GROUND_NEST_EMPTY, drops: [{ k: 'raw_egg', n: 3 }] });
    expect(rollDrops(B.GROUND_NEST, null, {}, () => 0.99)).toEqual([{ k: 'raw_egg', n: 2 }, { k: 'plant_fibre', n: 1 }]);
    expect(rollDrops(B.GROUND_NEST_EMPTY, null, {}, () => 0.5)).toEqual([{ k: 'plant_fibre', n: 1 }]);
  });

  it('is drawn as 3D pieces: a ring of grass bundles round a bed, and three eggs only in the full one', () => {
    const mesh = (id) => {
      const chunks = new Map();
      setWorldBlock(chunks, 4, 20, 4, B.GRASS_BLOCK);
      setWorldBlock(chunks, 4, 21, 4, id);
      if (!chunks.has('0,0')) chunks.set('0,0', makeChunkData());
      return buildChunkMesh(0, 0, makeChunkDataGetter(chunks));
    };
    const faces = (m) => (m.cutout ? m.cutout.faceCount : 0);
    const none = faces(mesh(B.AIR));
    const empty = faces(mesh(B.GROUND_NEST_EMPTY)) - none;
    const full = faces(mesh(B.GROUND_NEST)) - none;
    // five visible faces a box (its underside is never drawn): the bed and the wall; then two boxes an egg
    expect(empty).toBe((1 + NEST_WALL.count) * 5);
    expect(full - empty).toBe(NEST_EGGS * 2 * 5);
    // its pictures: the bowl is a cut-out with something in it, the skins are opaque
    for (const t of [TILE.GROUND_NEST, TILE.GROUND_NEST_EMPTY]) {
      const px = paintTile(t);
      let holes = 0;
      let solid = 0;
      for (let i = 3; i < px.length; i += 4) (px[i] === 0 ? holes++ : solid++);
      expect(holes).toBeGreaterThan(40);
      expect(solid).toBeGreaterThan(100);
    }
    expect([TILE.GROUND_NEST, TILE.GROUND_NEST_EMPTY, TILE.LITTER_NEST, TILE.LITTER_EGG]).toEqual([228, 229, 230, 231]);
    expect(Array.from(paintTile(TILE.GROUND_NEST))).not.toEqual(Array.from(paintTile(TILE.GROUND_NEST_EMPTY)));
  });
});

describe('fauna — the bear: a warning, then a charge', () => {
  it('ignores a player at a distance; inside its warning distance it rears up, faces them and stands', () => {
    const as = new Animals(seededRng(16));
    const a = as.spawn('bear', 0, GROUND, 0);
    const player = standing(-(SPECIES.bear.notice + 3), 0);
    const world = view(flatWorld(), player);
    let events = 0;
    run(as, world, 6, (ev) => {
      events += ev.warned.length + ev.charged.length + ev.mauls.length + ev.startled.length;
    });
    expect(events).toBe(0);
    expect(['idle', 'walk']).toContain(a.mode); // it goes about its business; it does not run away either
    expect(a.rear).toBeLessThan(0.01);
    // the player walks in to 8 m
    player.x = a.x - 8;
    player.z = a.z;
    const ev = as.update(DT, world);
    expect(ev.warned).toEqual([a]);
    expect(a.mode).toBe('warn');
    run(as, world, 1);
    expect(a.rear).toBeGreaterThan(0.95); // reared up within a second: the warning is plain to see
    expect(Math.hypot(a.vx, a.vz)).toBeLessThan(0.05);
    expect(Math.cos(a.yaw - Math.atan2(-(player.x - a.x), -(player.z - a.z)))).toBeGreaterThan(0.99); // it faces the player
    expect(as.update(DT, world).warned).toEqual([]); // one growl a warning
  });

  it('a player who backs away during the warning is left alone', () => {
    const as = new Animals(seededRng(17));
    const a = as.spawn('bear', 0, GROUND, 0);
    const player = standing(-8, 0);
    const world = view(flatWorld(), player);
    let warned = 0;
    let charged = 0;
    run(as, world, BEAR_WARN_S + 4, (ev, f) => {
      warned += ev.warned.length;
      charged += ev.charged.length;
      if (f > 30 && dist(a, player) < 14) player.x -= WALK_SPEED * DT; // half a second to take it in, then walk back
    });
    expect([warned, charged]).toEqual([1, 0]);
    expect(a.mode).not.toBe('charge');
    expect(a.rear).toBeLessThan(0.05); // down on all fours again
    // the warning is long enough to walk out of: the distance to gain takes less than half of it
    expect((SPECIES.bear.notice * (BEAR_BACK_OFF - 1)) / WALK_SPEED).toBeLessThan(BEAR_WARN_S / 2);
  });

  it('a player who stays is charged, mauled and thrown; it gives up after the chase and rests', () => {
    const as = new Animals(seededRng(18));
    const a = as.spawn('bear', 0, GROUND, 0);
    const player = standing(-8, 0);
    const world = view(flatWorld(), player);
    let t = 0;
    let chargedAt = -1;
    let gaveUpAt = -1;
    let top = 0;
    const mauls = [];
    run(as, world, BEAR_WARN_S + BEAR_CHASE_S + 3, (ev) => {
      t += DT;
      if (ev.charged.length && chargedAt < 0) chargedAt = t;
      if (ev.mauls.length) {
        mauls.push({ t, vx: player.vx, vy: player.vy, vz: player.vz, onGround: player.onGround });
        // the player is not stepped here: take the throw off again so each maul is seen by itself
        player.vx = 0;
        player.vy = 0;
        player.vz = 0;
      }
      if (chargedAt >= 0 && gaveUpAt < 0 && a.mode !== 'charge') gaveUpAt = t;
      top = Math.max(top, Math.hypot(a.vx, a.vz));
    });
    // the charge comes when the warning is over, not before
    expect(chargedAt).toBeGreaterThan(BEAR_WARN_S - 0.05);
    expect(chargedAt).toBeLessThan(BEAR_WARN_S + 0.1);
    expect(top).toBeGreaterThan(SPRINT_SPEED); // faster than the player can sprint
    expect(top).toBeLessThan(fleeSpeed('bear') + 0.1);
    // the maul: thrown BEAR_PUSH away from the bear (it came from +x) and BEAR_LIFT up
    expect(mauls.length).toBeGreaterThanOrEqual(3);
    expect(mauls[0].vx).toBeCloseTo(-BEAR_PUSH, 1);
    expect(mauls[0].vy).toBe(BEAR_LIFT);
    expect(Math.abs(mauls[0].vz)).toBeLessThan(0.5);
    expect(mauls[0].onGround).toBe(false);
    for (let i = 1; i < mauls.length; i++) expect(mauls[i].t - mauls[i - 1].t).toBeGreaterThan(BEAR_MAUL_S - 0.02);
    expect(dist(a, player)).toBeLessThan(BEAR_REACH + 0.2);
    // it gives up BEAR_CHASE_S after it began, and leaves the player alone for BEAR_REST_S though they stand beside it
    expect(gaveUpAt - chargedAt).toBeGreaterThan(BEAR_CHASE_S - 0.1);
    expect(gaveUpAt - chargedAt).toBeLessThan(BEAR_CHASE_S + 0.1);
    expect(a.rest).toBeGreaterThan(0);
    let again = 0;
    run(as, world, BEAR_REST_S - 3.5, (ev) => {
      again += ev.warned.length + ev.charged.length + ev.mauls.length;
    });
    expect(again).toBe(0);
  });

  it('a player who runs gets away: one maul at most from a bear they blundered into, and the chase ends', () => {
    const getBlock = flatWorld();
    const as = new Animals(seededRng(19));
    const a = as.spawn('bear', 0, GROUND, 0);
    const player = standing(-(BEAR_CHARGE_DIST - 0.5), 0);
    const world = view(getBlock, player);
    const away = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, yaw: Math.atan2(1, 0) }; // −x
    let mauls = 0;
    let charged = 0;
    let end = -1;
    run(as, world, BEAR_CHASE_S + 4, (ev, f) => {
      stepPlayer(player, away, getBlock, DT);
      mauls += ev.mauls.length;
      charged += ev.charged.length;
      if (charged && end < 0 && a.mode !== 'charge') end = f / 60;
    });
    expect(charged).toBe(1); // inside BEAR_CHARGE_DIST it charges at once, without the warning
    // it catches them once (they were too close), then gathers itself for BEAR_RECOVER_S — and a sprint does the rest
    expect(mauls).toBe(1);
    expect(BEAR_RECOVER_S * SPRINT_SPEED).toBeGreaterThan((fleeSpeed('bear') - SPRINT_SPEED) * BEAR_CHASE_S);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(BEAR_CHASE_S + 0.2);
    expect(dist(a, player)).toBeGreaterThan(8);
    // too far to bother: beyond BEAR_GIVE_UP it stops at once
    const bs = new Animals(seededRng(20));
    const b = bs.spawn('bear', 0, GROUND, 0);
    bs.wound(b, 1, -1, 0);
    expect(b.mode).toBe('charge');
    bs.update(DT, view(getBlock, standing(-(BEAR_GIVE_UP + 2), 0)));
    expect(b.mode).not.toBe('charge');
  });

  it('hurting it provokes it from afar: it does not run, a blow hardly moves it, and the charge is reported next update', () => {
    const as = new Animals(seededRng(21));
    const a = as.spawn('bear', 0, GROUND, 0);
    const player = standing(-18, 0); // a spear's throw away: far outside its warning distance
    const world = view(flatWorld(), player);
    run(as, world, 1);
    expect(a.mode).not.toBe('charge');
    expect(as.wound(a, 4, player.x, player.z)).toBe('hit');
    expect(a.health).toBe(SPECIES.bear.health - 4);
    expect(a.mode).toBe('charge');
    expect(Math.hypot(a.vx, a.vz)).toBeLessThan(ANIMAL_KNOCKBACK / 2);
    expect(as.wound(a, 4, player.x, player.z)).toBeNull(); // still flashing
    expect(as.update(DT, world).charged).toEqual([a]);
    expect(as.update(DT, world).charged).toEqual([]);
    const d0 = dist(a, player);
    run(as, world, 1.5);
    expect(dist(a, player)).toBeLessThan(d0 - 5); // it comes at the player
    // a blow during the chase starts the count again
    a.chase = 1;
    a.hurt = 0;
    as.wound(a, 1, player.x, player.z);
    expect(a.chase).toBe(BEAR_CHASE_S);
    // it takes a real fight: more blows than anything else that is hunted
    expect(SPECIES.bear.health).toBeGreaterThan(2 * Math.max(...ANIMAL_KINDS.filter((k) => k !== 'bear').map((k) => SPECIES[k].health)));
    expect(ANIMAL_HURT_S).toBeGreaterThan(0);
  });

  it('a sneaking player is warned too, before the distance at which it charges at once', () => {
    const sneaker = { sneaking: true };
    expect(noticeRange({ kind: 'bear' }, sneaker)).toBeLessThan(BEAR_CHARGE_DIST + 0.5); // the plain rule would leave no room …
    expect(bearRange({ kind: 'bear' }, sneaker)).toBeGreaterThan(BEAR_CHARGE_DIST + 1); // … so the warning never shrinks that far
    expect(bearRange({ kind: 'bear' }, {})).toBe(SPECIES.bear.notice);
    expect(bearRange({ kind: 'bear' }, { sprinting: true })).toBeCloseTo(SPECIES.bear.notice * SPRINT_NOTICE, 9);
    const as = new Animals(seededRng(22));
    const a = as.spawn('bear', 0, GROUND, 0);
    const d = bearRange(a, sneaker) - 0.3;
    const ev = as.update(DT, view(flatWorld(), standing(-d, 0, sneaker)));
    expect([ev.warned.length, ev.charged.length, a.mode]).toEqual([1, 0, 'warn']);
    // a flying player (Creative) is nothing to it
    const bs = new Animals(seededRng(23));
    const b = bs.spawn('bear', 0, GROUND, 0);
    let n = 0;
    run(bs, view(flatWorld(), standing(-2, 0, { flying: true })), 4, (e) => {
      n += e.warned.length + e.charged.length + e.mauls.length;
    });
    expect([n, b.mode === 'charge']).toEqual([0, false]);
  });

  it('its maul is in line with the zombies and the fall table, and is a cause of its own', () => {
    const alpha = Math.round(ZOMBIE_DAMAGE * KIND_STATS.alpha.damage);
    expect(BEAR_DAMAGE).toBe(18);
    expect(BEAR_DAMAGE).toBeGreaterThan(alpha); // worse than an alpha's strike (14) …
    expect(BEAR_DAMAGE).toBeLessThanOrEqual(3 * ZOMBIE_DAMAGE); // … but no more than three walkers'
    expect(BEAR_PUSH).toBeGreaterThan(ZOMBIE_HIT_PUSH);
    expect(BEAR_LIFT).toBeGreaterThan(ZOMBIE_HIT_LIFT);
    expect(BEAR_MAUL_S).toBeGreaterThan(1); // slower than a zombie's strike
    // about what a seven-cell fall costs; five mauls do not kill a healthy player, six do
    const fall = (cells) => fallDamage(Math.sqrt(2 * 28 * cells));
    expect(BEAR_DAMAGE).toBeGreaterThan(fall(6));
    expect(BEAR_DAMAGE).toBeLessThan(fall(8));
    expect(5 * BEAR_DAMAGE).toBeLessThan(100);
    expect(DAMAGE_CAUSES).toContain('bear');
    expect(DEATH_CAUSES).toContain('bear');
    expect(deathTitle('bear')).toBe('A bear brought you down.');
    const s = new Survival();
    s.setMode('survival');
    expect(s.damage(BEAR_DAMAGE, 'bear')).toBe(false);
    expect(s.vitals.health).toBe(100 - BEAR_DAMAGE);
    expect(s.damage(100, 'bear')).toBe(true);
    expect(s.dead).toBe('bear');
  });

  it('a snare neither holds nor draws a bear', () => {
    const [x, z] = hexToWorld(0, 0);
    const cells = new Map([[`0,${GROUND},0`, B.SNARE], [`3,${GROUND},0`, B.SNARE_BAITED]]);
    const as = new Animals(seededRng(24));
    const a = as.spawn('bear', x, GROUND, z);
    let caught = 0;
    run(as, view(flatWorld(cells), null), 20, (ev) => {
      caught += ev.caught.length;
      expect(a.mode).not.toBe('bait');
    });
    expect([caught, a.trapped]).toEqual([0, 0]);
    expect(SPECIES.bear.snare).toBe(false);
  });
});

describe('fauna — fish keep to the water', () => {
  it('fishDepth: under the surface of water deep enough, never in a film, a cell up or down counts', () => {
    const gb = channelWorld();
    const top = GROUND - 1 + 0.875; // a source's surface
    expect(fishDepth(gb, 0, 0, GROUND - 0.5)).toBeCloseTo(top - FISH_UNDER, 9);
    expect(fishDepth(gb, 0, 0, GROUND + 0.4)).toBeCloseTo(top - FISH_UNDER, 9); // from the cell above
    expect(fishDepth(gb, 0, 0, GROUND - 1.5)).toBeCloseTo(top - FISH_UNDER, 9); // from the cell below
    expect(Number.isNaN(fishDepth(gb, 0, 5, GROUND - 0.5))).toBe(true); // dry land
    expect(Number.isNaN(fishDepth(gb, 0, 0, GROUND + 3))).toBe(true); // far above it
    // a film of flowing water is too shallow; a deeper flow is not
    const film = flatWorld(new Map([[`0,${GROUND - 1},0`, B.WATER_FLOW_1], [`1,${GROUND - 1},0`, B.WATER_FLOW_5]]));
    expect(Number.isNaN(fishDepth(film, 0, 0, GROUND - 0.5))).toBe(true);
    expect(fishDepth(film, 1, 0, GROUND - 0.5)).toBeGreaterThan(GROUND - 1);
    expect(FISH_MIN_WATER).toBeLessThan(0.875);
    // in deep water it stays near the top, where it can be seen and speared
    const deep = flatWorld(new Map([0, 1, 2, 3].map((d) => [`0,${GROUND - 1 - d},0`, B.WATER])));
    expect(fishDepth(deep, 0, 0, GROUND - 3.5)).toBeCloseTo(top - FISH_UNDER, 9);
  });

  it('a minute in a channel, with a player walking its bank: never a frame out of the water', () => {
    const gb = channelWorld(8, 0, 1);
    const as = new Animals(seededRng(25));
    const [x0, z0] = hexToWorld(0, 0);
    const y0 = fishDepth(gb, 0, 0, GROUND - 0.5);
    const school = [as.spawn('fish', x0, y0, z0), as.spawn('fish', x0 + 1, y0, z0), as.spawn('fish', x0 - 1.2, y0, z0 + 0.5)];
    const player = standing(x0 - 12, z0 - 2.5);
    let dry = 0;
    let above = 0;
    let moved = 0;
    run(as, view(gb, player), 60, (ev, f) => {
      // up and down the bank, past the school
      player.x += (Math.floor(f / 900) % 2 === 0 ? 1 : -1) * 1.6 * DT;
      for (const fish of school) {
        const [q, r] = worldToHex(fish.x, fish.z);
        if (gb(q, GROUND - 1, r) !== B.WATER) dry++;
        if (fish.y + fish.height > GROUND - 1 + 0.875) above++;
      }
      moved += Math.hypot(school[0].vx, school[0].vz);
    });
    expect([dry, above]).toEqual([0, 0]);
    expect(as.list).toEqual(school); // all three still there
    expect(moved).toBe(0); // it has no velocity of its own for the body solver to act on (it is moved by its own rule)
    for (const fish of school) expect(fish.inWater).toBe(true);
  });

  it('they dart away from a player who comes near, the school together, then hold still; a sneaker comes close', () => {
    const gb = channelWorld(10, 0, 1);
    const as = new Animals(seededRng(26));
    const [x0, z0] = hexToWorld(0, 0);
    const y0 = fishDepth(gb, 0, 0, GROUND - 0.5);
    const a = as.spawn('fish', x0, y0, z0);
    const mate = as.spawn('fish', x0 + 1.5, y0, z0 + 0.3);
    // far away: nothing
    const world = view(gb, standing(x0 - 9, z0));
    let startled = 0;
    run(as, world, 3, (ev) => {
      startled += ev.startled.length;
    });
    expect(startled).toBe(0);
    // the player comes to 3 m (on the water's line, so "away" is along the channel)
    const player = standing(a.x - 3, a.z);
    world.player = player;
    const d0 = dist(a, player);
    const ev = as.update(DT, world);
    expect(ev.startled).toEqual(expect.arrayContaining([a, mate]));
    expect(a.mode).toBe('flee');
    let top = 0;
    let px = a.x;
    let pz = a.z;
    run(as, world, FISH_DART_S, () => {
      top = Math.max(top, Math.hypot(a.x - px, a.z - pz) / DT);
      px = a.x;
      pz = a.z;
    });
    expect(top).toBeCloseTo(FISH_DART, 1);
    expect(dist(a, player)).toBeGreaterThan(d0 + 3);
    // the dart is short: it holds still afterwards, even with the player near
    run(as, world, 0.3);
    expect(a.mode).not.toBe('flee');
    expect(a.calm).toBeGreaterThan(0);
    // sneaking: within two metres before they go
    for (const [d, darts] of [[2.2, false], [1.5, true]]) {
      const bs = new Animals(seededRng(27));
      const b = bs.spawn('fish', x0, y0, z0);
      bs.update(DT, view(gb, standing(x0 - d, z0, { sneaking: true })));
      expect(b.mode === 'flee', `sneaking at ${d}`).toBe(darts);
    }
    expect(SPECIES.fish.notice * SNEAK_NOTICE).toBeLessThan(REACH); // a thrust reaches a fish you have crept up on
  });

  it('a fish whose water is gone is gone; a blow does not knock it out of the water; its target is padded', () => {
    const cells = new Map();
    for (let q = -3; q <= 3; q++) cells.set(`${q},${GROUND - 1},0`, B.WATER);
    const gb = flatWorld(cells);
    const as = new Animals(seededRng(28));
    const [x0, z0] = hexToWorld(0, 0);
    const y0 = fishDepth(gb, 0, 0, GROUND - 0.5);
    const a = as.spawn('fish', x0, y0, z0);
    const mate = as.spawn('fish', x0 + 1, y0, z0);
    a.health = 5;
    expect(as.wound(a, 1, x0 - 2, z0)).toBe('hit');
    expect([a.vx, a.vy, a.vz, a.y]).toEqual([0, 0, 0, y0]); // no knockback, no hop
    expect([a.mode, mate.mode]).toEqual(['flee', 'flee']); // the school darts
    expect(as.wound(mate, SPECIES.fish.health, x0, z0)).toBe('dead');
    // the crosshair: a ray that passes 0.25 m beside a fish still finds it (its bare cylinder is 0.16 wide), a rabbit's not
    const hit = as.raycast(a.x - 3, a.y + 0.1, a.z + 0.25, 1, 0, 0, 6);
    expect(hit && hit.animal).toBe(a);
    expect(SPECIES.fish.radius + 0.06).toBeLessThan(0.25);
    // drain its cell: it is removed at the next update, quietly
    const [q, r] = worldToHex(a.x, a.z);
    cells.delete(`${q},${GROUND - 1},${r}`);
    const ev = as.update(DT, view(gb, null));
    expect(as.list.includes(a)).toBe(false);
    expect(ev.despawned).toBe(1);
  });

  it('schools appear only in stream water, away from the player, a few at a time', () => {
    // a stream along r = 0..1; the same water elsewhere (a pond, r = 6..7) is not a stream
    const cells = new Map();
    for (let q = -40; q <= 40; q++) for (const r of [0, 1, 6, 7]) cells.set(`${q},${GROUND - 1},${r}`, B.WATER);
    const gb = flatWorld(cells);
    const hooks = {
      getBiome: () => BIOME.DESERT, // no herds, so only fish appear
      groundHeight: () => GROUND - 1,
      isNaturalGround: () => true,
      isLoadedCell: () => true,
      streamAt: (q, r) => r === 0 || r === 1,
    };
    const as = new Animals(seededRng(29));
    const player = standing(0, -6, { flying: true });
    const world = view(gb, player, hooks);
    const born = [];
    run(as, world, FISH_CHECK_S * 30, (ev) => {
      for (const a of ev.spawned) born.push({ kind: a.kind, d: dist(a, player), cell: worldToHex(a.x, a.z), y: a.y });
    });
    expect(born.length).toBeGreaterThanOrEqual(SPECIES.fish.herd[0]);
    for (const b of born) {
      expect(b.kind).toBe('fish');
      expect(b.cell[1] === 0 || b.cell[1] === 1, `row ${b.cell[1]}`).toBe(true); // in the stream, not the pond
      expect(b.d).toBeGreaterThan(FISH_MIN - 3);
      expect(b.d).toBeLessThan(FISH_MAX + 3);
      expect(b.y).toBeCloseTo(GROUND - 1 + 0.875 - FISH_UNDER, 5);
    }
    // few: never more than a school over the target near the player, never more than FISH_CAP in all
    const near = as.list.filter((a) => dist(a, player) <= FISH_RADIUS).length;
    expect(near).toBeLessThanOrEqual(FISH_TARGET + SPECIES.fish.herd[1] - 1);
    expect(as.size).toBeLessThanOrEqual(FISH_CAP);
    // no stream, no fish: with the foundation's streamAt (always false), and with no streamAt at all
    for (const streamAt of [() => false, undefined]) {
      const none = new Animals(seededRng(30));
      run(none, view(gb, standing(0, -6, { flying: true }), { ...hooks, streamAt }), FISH_CHECK_S * 10);
      expect(none.size).toBe(0);
    }
    // a fish left far behind goes sooner than a land animal (its own despawn distance)
    const far = new Animals(seededRng(31));
    far.spawn('fish', SPECIES.fish.despawn + 5, fishDepth(gb, 0, 0, GROUND - 0.5), 0);
    expect(far.update(DT, view(gb, standing(0, 0))).despawned).toBe(1);
  });
});

describe('fauna — rarity: herds and small game appear independently', () => {
  const hooks = (biome) => ({ getBiome: () => biome, groundHeight: () => GROUND - 1, isNaturalGround: () => true, isLoadedCell: () => true });
  it('each pool keeps to its own target; the forest grows deer, bears and birds; never a second bear', () => {
    const as = new Animals(seededRng(32));
    const player = standing(0, 0, { flying: true });
    const world = view(flatWorld(), player, hooks(BIOME.FOREST));
    const seen = new Set();
    let maxBears = 0;
    let maxHerd = 0;
    let maxSmall = 0;
    // an hour of checks; whatever appears is cleared away now and then, so many groups are drawn
    for (let k = 0; k < 400; k++) {
      as._spawnHerd(player, world, 'herd');
      as._spawnHerd(player, world, 'small');
      for (const a of as.list) seen.add(a.kind);
      const near = as.list.filter((a) => dist(a, player) <= HERD_RADIUS);
      maxBears = Math.max(maxBears, near.filter((a) => a.kind === 'bear').length);
      maxHerd = Math.max(maxHerd, near.filter((a) => poolOf(a.kind) === 'herd').length);
      maxSmall = Math.max(maxSmall, near.filter((a) => poolOf(a.kind) === 'small').length);
      if (k % 4 === 3) {
        // the herds move on — but a bear that has come stays, so a second one is refused again and again
        as.list = as.list.filter((a) => a.kind === 'bear');
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(HERD_WEIGHTS[BIOME.FOREST]).sort());
    expect(maxBears).toBe(BEAR_NEAR);
    expect(maxHerd).toBeLessThanOrEqual(HERD_TARGET + SPECIES.deer.herd[1] - 1);
    expect(maxSmall).toBeLessThanOrEqual(SMALL_TARGET + 3);
    expect(maxSmall).toBeGreaterThan(0);
    // rarer than before: the chances
    expect([HERD_CHANCE, SMALL_CHANCE]).toEqual([0.2, 0.25]); // v0.15 (§79): 0.35 and 0.4 before
    expect([HERD_TARGET, SMALL_TARGET]).toEqual([3, 3]); // 5 and 4 before
    expect(HERD_CHECK_S).toBe(60);
  });

  it('a full count of herd animals does not keep the small game away, nor the other way round', () => {
    const player = standing(0, 0, { flying: true });
    const world = view(flatWorld(), player, hooks(BIOME.PLAINS));
    const as = new Animals(() => 0.1); // every chance roll passes
    for (let i = 0; i < HERD_TARGET; i++) as.spawn('cow', 20 + i * 2, GROUND, 0);
    expect(as._spawnHerd(player, world, 'herd')).toBe(0);
    expect(as._spawnHerd(player, world, 'small')).toBeGreaterThan(0);
    const bs = new Animals(() => 0.1);
    for (let i = 0; i < SMALL_TARGET; i++) bs.spawn('rabbit', 20 + i * 2, GROUND, 0);
    expect(bs._spawnHerd(player, world, 'small')).toBe(0);
    expect(bs._spawnHerd(player, world, 'herd')).toBeGreaterThan(0);
    // the mountains have no birds: a small group there is rabbits
    const cs = new Animals(() => 0.1);
    cs._spawnHerd(player, view(flatWorld(), player, hooks(BIOME.MOUNTAINS)), 'small');
    expect(cs.list.length).toBeGreaterThan(0);
    expect(cs.list.every((a) => a.kind === 'rabbit')).toBe(true);
    // the desert grows nothing
    expect(cs._pickKind({}, 'small')).toBeNull();
  });
});

describe('fauna — what a hunt gives', () => {
  const least = () => 0;
  const most = () => 0.999;
  it('MOB_DROPS: venison and hide, a little rabbit, fowl and feathers, a fish, and the bear\'s big reward', () => {
    expect(rollMobDrops('deer', least)).toEqual([{ k: 'raw_venison', n: 2 }, { k: 'rawhide', n: 1 }]);
    expect(rollMobDrops('deer', most)).toEqual([{ k: 'raw_venison', n: 3 }, { k: 'rawhide', n: 1 }]);
    expect(rollMobDrops('rabbit', least)).toEqual([{ k: 'raw_rabbit', n: 1 }, { k: 'rawhide', n: 1 }]);
    expect(rollMobDrops('rabbit', most)).toEqual([{ k: 'raw_rabbit', n: 1 }]);
    expect(rollMobDrops('pheasant', least)).toEqual([{ k: 'raw_fowl', n: 1 }, { k: 'feather', n: 2 }]);
    expect(rollMobDrops('pheasant', most)).toEqual([{ k: 'raw_fowl', n: 1 }, { k: 'feather', n: 4 }]);
    expect(rollMobDrops('turkey', least)).toEqual([{ k: 'raw_fowl', n: 2 }, { k: 'feather', n: 2 }]);
    expect(rollMobDrops('turkey', most)).toEqual([{ k: 'raw_fowl', n: 3 }, { k: 'feather', n: 4 }]);
    expect(rollMobDrops('fish', most)).toEqual([{ k: 'raw_fish', n: 1 }]);
    expect(rollMobDrops('bear', least)).toEqual([{ k: 'raw_bear', n: 6 }, { k: 'rawhide', n: 2 }]);
    expect(rollMobDrops('bear', most)).toEqual([{ k: 'raw_bear', n: 8 }, { k: 'rawhide', n: 3 }]);
    for (const k of ANIMAL_KINDS) expect(Object.hasOwn(MOB_DROPS, k), k).toBe(true);
    // the bear is the richest kill there is; a rabbit the poorest meat
    const food = (kind, rnd) => rollMobDrops(kind, rnd).reduce((sum, s) => sum + (FIRE_TRANSFORMS[s.k] ? ITEMS[FIRE_TRANSFORMS[s.k].to].food.satiation * s.n : 0), 0);
    for (const k of ANIMAL_KINDS.filter((x) => x !== 'bear')) expect(food('bear', least), k).toBeGreaterThan(food(k, most));
    expect(food('rabbit', most)).toBeLessThan(food('pheasant', least) + 5);
    expect(food('deer', least)).toBeGreaterThan(2 * food('turkey', most) - 60);
  });

  it('game is risky raw and good roasted; an egg too; every pair roasts on a skewer', () => {
    for (const m of ['venison', 'rabbit', 'fowl', 'fish', 'bear', 'egg']) {
      const raw = ITEMS[`raw_${m}`];
      const roast = ITEMS[`roast_${m}`];
      expect([raw.kind, roast.kind], m).toEqual(['food', 'food']);
      expect(raw.food.sick, m).toBeGreaterThanOrEqual(0.25);
      expect(roast.food.sick, m).toBe(0);
      expect(roast.food.satiation, m).toBeGreaterThanOrEqual(2.5 * raw.food.satiation);
      expect(raw.food.spoilS > 0 && roast.food.spoilS > 0, m).toBe(true);
      expect(FIRE_TRANSFORMS[`raw_${m}`]).toMatchObject({ to: `roast_${m}`, spot: 'skewer' });
      expect(isSkewerFood(`raw_${m}`), m).toBe(true);
      expect(hasItemArt(`raw_${m}`) && hasItemArt(`roast_${m}`), m).toBe(true);
      expect(Array.from(paintItem(`raw_${m}`))).not.toEqual(Array.from(paintItem(`roast_${m}`)));
    }
    for (const m of ['venison', 'rabbit', 'fowl', 'fish', 'bear']) expect(FIRE_TRANSFORMS[`roast_${m}`].to).toBe('charred_meat'); // left on, it chars
    expect(FIRE_TRANSFORMS.roast_egg).toBeUndefined(); // an egg in its shell does not
    expect([ITEMS.raw_egg.name, ITEMS.roast_egg.name, ITEMS.raw_bear.name, ITEMS.feather.name]).toEqual(['Raw Egg', 'Roast Egg', 'Raw Bear Meat', 'Feather']);
    // venison is the big hunt's meat: a roast is worth about a roast of pork
    expect(Math.abs(ITEMS.roast_venison.food.satiation - ITEMS.roast_pork.food.satiation)).toBeLessThanOrEqual(4);
    expect(ITEMS.roast_rabbit.food.satiation).toBeLessThan(ITEMS.roast_venison.food.satiation / 1.5);
    expect(ITEMS.raw_fish.food.spoilS).toBeLessThan(ITEMS.raw_pork.food.spoilS);
  });

  it('feathers fletch a better dart: faster, harder, tougher — made at hand like the plain one', () => {
    expect(getItem('feather')).toMatchObject({ kind: 'material', stack: 32 });
    expect(getItem('fletched_dart')).toMatchObject({ kind: 'material', stack: 16 });
    const rec = getRecipe('fletched_dart');
    expect(rec.station).toBe('hand');
    expect(rec.inputs).toEqual([{ k: 'flint', n: 1 }, { k: 'stick', n: 1 }, { k: 'feather', n: 2 }, { k: 'plant_fibre', n: 1 }]);
    expect(rec.outputs).toEqual([{ k: 'fletched_dart', n: 4 }]);
    expect(rec.tools).toEqual([{ type: 'hammer', tier: 1 }]);
    const plain = getRecipe('flint_dart');
    expect(rec.outputs[0].n).toBe(plain.outputs[0].n);
    expect(DART_KEYS).toEqual(['flint_dart', 'fletched_dart']);
    expect(throwOf('fletched_dart')).toBe(THROW_FLETCHED);
    expect(throwOf('flint_dart')).toBe(THROW_DART);
    expect(THROW_FLETCHED.speed).toBeGreaterThan(THROW_DART.speed);
    expect(THROW_FLETCHED.power).toBe(THROW_DART.power + 1);
    expect([dartBreakP('fletched_dart'), dartBreakP('flint_dart'), dartBreakP('flint_spear')]).toEqual([FLETCHED_BREAK_P, DART_BREAK_P, 0]);
    expect(FLETCHED_BREAK_P).toBeLessThan(DART_BREAK_P);
    // one fletched dart brings down a pheasant or a rabbit, two a turkey; a deer takes three
    const darts = (k) => Math.ceil(SPECIES[k].health / THROW_FLETCHED.power);
    expect([darts('pheasant'), darts('rabbit'), darts('turkey'), darts('deer')]).toEqual([1, 1, 2, 3]);
    expect(hasItemArt('feather') && hasItemArt('fletched_dart')).toBe(true);
    expect(Array.from(paintItem('fletched_dart'))).not.toEqual(Array.from(paintItem('flint_dart')));
  });
});

describe('fauna — the save', () => {
  it('every new kind round-trips; what it was doing is not saved; a save from before v0.14 reads exactly as it did', () => {
    const as = new Animals(seededRng(33));
    const made = NEW_KINDS.map((k, i) => as.spawn(k, i * 3 + 0.126, GROUND, -i, 0.5));
    made[0].variant = 1; // a stag
    made[1].health = 1; // a hurt rabbit
    made[2].air = 2; // a pheasant in the air
    made[4].mode = 'charge'; // a charging bear
    made[4].chase = 5;
    made[4].rear = 1;
    const saved = JSON.parse(JSON.stringify(as.export()));
    expect(saved.map((o) => o.k)).toEqual(NEW_KINDS);
    expect(saved[0]).toEqual({ k: 'deer', x: 0.13, y: GROUND, z: 0, yaw: 0.5, h: SPECIES.deer.health, v: 1 });
    expect(saved[1]).toEqual({ k: 'rabbit', x: 3.13, y: GROUND, z: -1, yaw: 0.5, h: 1 });
    for (const o of saved.slice(1)) expect(Object.keys(o).sort()).toEqual(['h', 'k', 'x', 'y', 'yaw', 'z']);
    expect(validateAnimalsJSON(saved)).toEqual({ animals: JSON.parse(JSON.stringify(saved)), warnings: [] }); // canonical already
    const back = new Animals(seededRng(34));
    back.load(saved);
    expect(back.list.map((a) => [a.kind, a.variant, a.health, a.air, a.mode, a.chase, a.rear])).toEqual([
      ['deer', 1, 8, 0, 'idle', 0, 0], ['rabbit', 0, 1, 0, 'idle', 0, 0], ['pheasant', 0, 2, 0, 'idle', 0, 0], ['turkey', 0, 4, 0, 'idle', 0, 0],
      ['bear', 0, 30, 0, 'idle', 0, 0], ['fish', 0, 2, 0, 'idle', 0, 0],
    ]);
    expect(JSON.parse(JSON.stringify(back.export()))).toEqual(saved);
    // through the save file
    const text = serializeSave({ seed: 7, time: 0.3, day: 2, player: { x: 0, y: 20, z: 0, yaw: 0, pitch: 0 }, edits: {}, animals: saved });
    expect(deserializeSave(text).animals).toEqual(saved);

    // a v0.13 save: the four old kinds with every field they had, 24 of them — unchanged, nothing dropped, no warning
    const old = [];
    for (let i = 0; i < 24; i++) {
      const k = ['cow', 'sheep', 'horse', 'wolf'][i % 4];
      const o = { k, x: i, y: 12, z: 3 - i, yaw: 1.25, h: 5 };
      if (k === 'horse') o.t = 1;
      if (k === 'wolf') o.tr = 2;
      if (k === 'sheep') o.s = 120;
      if (k === 'cow') {
        o.m = 60;
        o.tp = 30;
        o.tc = [i, 12, 3 - i];
      }
      old.push(o);
    }
    const v = validateAnimalsJSON(JSON.parse(JSON.stringify(old)));
    expect(v).toEqual({ animals: old, warnings: [] });
    const loaded = new Animals(seededRng(35));
    loaded.load(old);
    expect(loaded.size).toBe(24);
    expect(JSON.parse(JSON.stringify(loaded.export()))).toEqual(old);
    expect(loaded.list.every((a) => a.variant === 0 && a.air === 0 && a.rear === 0)).toBe(true);
    // the cap is ANIMAL_MAX now
    const many = Array.from({ length: ANIMAL_MAX + 3 }, (_, i) => ({ k: 'rabbit', x: i, y: 12, z: 0 }));
    const capped = validateAnimalsJSON(many);
    expect(capped.animals).toHaveLength(ANIMAL_MAX);
    expect(capped.warnings).toEqual([`animals: more than ${ANIMAL_MAX}, the rest dropped`]);
  });
});

describe('fauna — the models', () => {
  const mk = (kind, more = {}) => ({ kind, x: 0, y: 10, z: 0, yaw: 0, walkPhase: 0, hurt: 0, shorn: 0, tamed: false, variant: 0, air: 0, rear: 0, swipe: 0, ...more });
  const by = (r, name) => r.group.children.find((m) => m.name === name);
  const mat = (mesh, i = 0) => {
    const out = new THREE.Matrix4();
    mesh.getMatrixAt(i, out);
    return out;
  };
  /** the highest and the foremost (−z) point of a model's boxes */
  const reach = (boxes) => ({ top: Math.max(...boxes.map((b) => b[4] + b[1] / 2)), front: Math.min(...boxes.map((b) => b[5] - b[2] / 2)),
    back: Math.max(...boxes.map((b) => b[5] + b[2] / 2)), wide: Math.max(...boxes.map((b) => Math.abs(b[3]) + b[0] / 2)) * 2 });

  it('one body each, legs by kind (four, a bird\'s two, a fish\'s none), a stag on the antlered body; hurt on the red twins', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    r.sync([mk('deer'), mk('deer', { variant: 1 }), mk('rabbit'), mk('pheasant'), mk('turkey', { hurt: 0.3 }), mk('bear'), mk('fish'), mk('fish')]);
    expect(r.count()).toBe(8);
    expect([by(r, 'deer-body').count, by(r, 'deer-alt').count, by(r, 'deer-legs').count]).toEqual([1, 1, 8]);
    expect([by(r, 'rabbit-body').count, by(r, 'rabbit-legs').count]).toEqual([1, 4]);
    expect([by(r, 'pheasant-body').count, by(r, 'pheasant-legs').count, by(r, 'pheasant-wings').count]).toEqual([1, 2, 0]); // wings only in the air
    expect([by(r, 'turkey-body-hurt').count, by(r, 'turkey-legs-hurt').count, by(r, 'turkey-body').count]).toEqual([1, 2, 0]);
    expect([by(r, 'bear-body').count, by(r, 'bear-legs').count, by(r, 'bear-head').count]).toEqual([1, 4, 1]);
    expect(by(r, 'fish-body').count).toBe(2);
    expect(by(r, 'fish-legs')).toBeUndefined();
    expect(ANIMAL_KINDS.map((k) => legCount(MODELS[k]))).toEqual([4, 4, 4, 4, 4, 4, 2, 2, 4, 0]);
    r.sync([]);
    expect(r.group.children.every((m) => m.count === 0 && !m.visible)).toBe(true);
    r.dispose();
  });

  it('each is told from the others by one bold feature: antlers, ears, a long tail, a fan, bulk', () => {
    const doe = reach(MODELS.deer.body);
    const stag = reach(MODELS.deer.alt);
    expect(stag.top).toBeGreaterThan(doe.top + 0.3); // antlers stand well above a doe's ears …
    expect(stag.wide).toBeGreaterThan(doe.wide + 0.15); // … and spread wider than its body
    const rabbit = reach(MODELS.rabbit.body);
    const rabbitBack = Math.max(...MODELS.rabbit.body.filter((b) => b[0] >= 0.16).map((b) => b[4] + b[1] / 2));
    expect(rabbit.top).toBeGreaterThan(rabbitBack + 0.2); // ears stand a hand above its head and back
    const pheasant = reach(MODELS.pheasant.body);
    expect(pheasant.back).toBeGreaterThan(-pheasant.front * 2); // the tail is longer than the rest of the bird
    const turkey = reach(MODELS.turkey.body);
    expect(turkey.wide).toBeGreaterThan(0.9); // the fan, far wider than the body in front of it
    expect(turkey.wide).toBeGreaterThan(2.5 * MODELS.turkey.body[0][0]);
    expect(turkey.wide).toBeGreaterThan(pheasant.wide * 2.5);
    expect(turkey.top).toBeGreaterThan(pheasant.top * 1.7);
    const bear = reach(MODELS.bear.body);
    expect(MODELS.bear.body[0][0]).toBeGreaterThanOrEqual(2 * MODELS.deer.body[0][0]); // a trunk twice a deer's width
    for (const k of [0, 1, 2]) expect(MODELS.bear.body[0][k], `box side ${k}`).toBeGreaterThan(MODELS.cow.body[0][k] * 1.2); // bigger than a cow all round
    expect(MODELS.bear.legW).toBeGreaterThan(2 * MODELS.deer.legW);
    expect(bear.top).toBeLessThan(doe.top); // low and heavy on all fours
    // a fish's body rides under the water's surface, but its back fin stands out of it: that is how one is spotted
    const fishTop = reach(MODELS.fish.body).top;
    expect(SPECIES.fish.height).toBeLessThan(FISH_UNDER);
    expect(fishTop).toBeGreaterThan(FISH_UNDER + 0.05);
    // no two of the new kinds share a main colour
    const main = NEW_KINDS.map((k) => MODELS[k].body[0][6]);
    expect(new Set(main).size).toBe(NEW_KINDS.length);
    // the new models stand on the ground and are about as tall as their bodies (as the old ones are)
    for (const kind of NEW_KINDS) {
      const { top } = reach(MODELS[kind].body);
      expect(top, kind).toBeGreaterThan(SPECIES[kind].height - 0.1);
      expect(top, kind).toBeLessThan(SPECIES[kind].height + 0.6);
      const low = Math.min(...MODELS[kind].body.map((b) => b[4] - b[1] / 2));
      expect(low, kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('flight: a bird in the air beats two wings and tucks its legs; on the ground it has none spread', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const wings = by(r, 'pheasant-wings');
    const legs = by(r, 'pheasant-legs');
    r.sync([mk('pheasant')]);
    const standingLeg = new THREE.Euler().setFromRotationMatrix(mat(legs), 'XYZ').x;
    expect(wings.count).toBe(0);
    r.sync([mk('pheasant', { air: 1.5, walkPhase: Math.PI / 2 })]); // wings at the top of the beat
    expect(wings.count).toBe(2);
    const up = [0, 1].map((i) => new THREE.Vector3(1, 0, 0).applyMatrix4(mat(wings, i)));
    r.sync([mk('pheasant', { air: 1.5, walkPhase: -Math.PI / 2 })]); // and at the bottom
    const down = [0, 1].map((i) => new THREE.Vector3(1, 0, 0).applyMatrix4(mat(wings, i)));
    // the tips are one each side of the body, and both rise and fall together
    expect(Math.sign(up[0].x)).toBe(-Math.sign(up[1].x));
    for (const i of [0, 1]) expect(up[i].y - down[i].y).toBeGreaterThan(0.8);
    expect(up[0].y).toBeCloseTo(up[1].y, 5);
    const flyingLeg = new THREE.Euler().setFromRotationMatrix(mat(legs), 'XYZ').x;
    expect(Math.abs(flyingLeg - standingLeg)).toBeGreaterThan(0.9); // tucked back
    // a turkey glides on wings too; a rabbit has none
    expect(by(r, 'turkey-wings')).toBeDefined();
    expect(by(r, 'rabbit-wings')).toBeUndefined();
    r.dispose();
  });

  it('the rear-up: a rearing bear\'s head rises by most of a metre and its forelegs leave the ground', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const body = by(r, 'bear-body');
    const headMesh = by(r, 'bear-head');
    const legs = by(r, 'bear-legs');
    const head = new THREE.Vector3(0, 1.12, -0.92); // the head box's centre
    const headAt = (rear) => {
      r.sync([mk('bear', { rear })]);
      return head.clone().applyMatrix4(mat(headMesh));
    };
    const pitchOf = (mesh) => new THREE.Euler().setFromRotationMatrix(mat(mesh), 'YXZ').x;
    const down = headAt(0);
    const half = headAt(0.5);
    const up = headAt(1);
    expect(down.y).toBeCloseTo(11.12, 5);
    expect(half.y).toBeGreaterThan(down.y + 0.3);
    expect(up.y).toBeGreaterThan(down.y + 0.7);
    expect(up.y).toBeGreaterThan(10 + 1.9); // it towers over the player
    // the body is nearly upright, but the head has its own neck and stays level: it looks at the player, not at the sky
    expect(headMesh.count).toBe(1);
    expect(Math.abs(pitchOf(body))).toBeGreaterThan(1.1);
    expect(Math.abs(pitchOf(headMesh))).toBeLessThan(0.2);
    expect(MODELS.bear.head.boxes.length).toBeGreaterThan(4);
    expect(by(r, 'deer-head')).toBeUndefined(); // only the bear has one
    // hips: the two front ones go up with the shoulders, the hind ones stay where they were
    const hipY = (i) => new THREE.Vector3().setFromMatrixPosition(mat(legs, i)).y;
    r.sync([mk('bear', { rear: 0 })]);
    const flat = [0, 1, 2, 3].map(hipY);
    r.sync([mk('bear', { rear: 1 })]);
    const reared = [0, 1, 2, 3].map(hipY);
    expect(reared[0]).toBeGreaterThan(flat[0] + 0.5);
    expect(reared[1]).toBeGreaterThan(flat[1] + 0.5);
    expect(reared[2]).toBeCloseTo(flat[2], 5);
    expect(reared[3]).toBeCloseTo(flat[3], 5);
    // the swipe moves the forelegs
    const armX = () => new THREE.Euler().setFromRotationMatrix(mat(legs, 0), 'XYZ').x;
    const held = armX();
    r.sync([mk('bear', { rear: 1, swipe: 0.4 })]);
    expect(Math.abs(armX() - held)).toBeGreaterThan(0.5);
    r.dispose();
  });
});

describe('fauna — summon (the debug command)', () => {
  /** A converged flat world with a little pond two cells in front of the player. */
  function makeCtx() {
    const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0 });
    let res;
    do res = world.update(0, 0, Infinity);
    while (res.pendingGen > 0 || res.pendingMesh > 0);
    const [px, pz] = hexToWorld(0, 0);
    const player = createPlayer(px, GROUND + 1, pz);
    return { world, player, controls: { yaw: 0, pitch: 0 }, animals: new Animals(seededRng(36)) };
  }
  const exec = (ctx, line) => executeCommand(parseLine(line), ctx);

  it('puts every new kind in front of the player; a stag is a deer with antlers', () => {
    const ctx = makeCtx();
    for (const kind of ['deer', 'rabbit', 'pheasant', 'turkey', 'bear']) {
      const res = exec(ctx, `summon ${kind}`);
      expect(res, kind).toMatchObject({ ok: true });
      expect(res.message).toContain(`summoned a ${SPECIES[kind].name.toLowerCase()} at `);
      const a = ctx.animals.list[ctx.animals.list.length - 1];
      expect([a.kind, a.y]).toEqual([kind, GROUND + 1]);
    }
    expect(exec(ctx, 'summon stag')).toMatchObject({ ok: true, message: expect.stringContaining('summoned a stag at ') });
    const stag = ctx.animals.list[ctx.animals.list.length - 1];
    expect([stag.kind, stag.variant]).toEqual(['deer', 1]);
    expect(exec(ctx, 'summon deer 2 11 2')).toMatchObject({ ok: true });
    expect(ctx.animals.list[ctx.animals.list.length - 1].variant).toBe(0);
    expect(parseLine('summon dragon').message).toContain('deer, stag, rabbit, pheasant, turkey, bear, fish');
    expect(CHUNK_SIZE).toBeGreaterThan(4);
  });

  it('a fish only goes into water: where the player looks, or in the cell named', () => {
    const ctx = makeCtx();
    expect(exec(ctx, 'summon fish')).toMatchObject({ ok: false, message: expect.stringContaining('a fish needs water') });
    expect(ctx.animals.size).toBe(0);
    // a pond in the ground, in front of the player (yaw 0 looks along −z)
    const [q, r] = worldToHex(ctx.player.x, ctx.player.z - 3);
    ctx.world.setBlock(q, GROUND, r, B.WATER);
    const res = exec(ctx, 'summon fish');
    expect(res).toMatchObject({ ok: true, message: `summoned a fish at ${q} ${GROUND} ${r}` });
    const fish = ctx.animals.list[0];
    expect(fish.kind).toBe('fish');
    expect(fish.y).toBeCloseTo(GROUND + 0.875 - FISH_UNDER, 5);
    expect(exec(ctx, `summon fish ${q} ${GROUND + 1} ${r}`)).toMatchObject({ ok: true }); // named from the cell above the water
    expect(exec(ctx, `summon fish ${q + 3} ${GROUND + 1} ${r}`)).toMatchObject({ ok: false });
    expect(ctx.animals.size).toBe(2);
    // and it lives there
    const ev = ctx.animals.update(DT, { getBlock: ctx.world.getBlock, isLoaded: () => true, player: null });
    expect([ev.despawned, ctx.animals.size]).toEqual([0, 2]);
  });
});
