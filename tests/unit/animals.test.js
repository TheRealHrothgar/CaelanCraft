// Unit tests for src/animals.js — cattle, sheep, horses and wolves: wariness, luring, taming, riding, shearing, snares,
// herds and the save (CONTRACTS §69).
import { describe, it, expect } from 'vitest';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { WALK_SPEED, SPRINT_SPEED, PIG_NOTICE, WARY_SNEAK_FACTOR, WARY_VIEW_HALF_ANGLE, WARY_BEHIND_FACTOR } from '../../src/config.js';
import { isBehind, yawToForward } from '../../src/coords.js';
import {
  Animals, SPECIES, ANIMAL_KINDS, ANIMAL_MAX, noticeRange, blindTo, BEHIND_NOTICE, VIEW_HALF_ANGLE, fleeSpeed, validateAnimalsJSON, isAnimalKind,
  SNEAK_NOTICE, CALM_FACTOR, FED_CALM_S, LURE_STOP, TRAP_HOLD_S, TRAP_IMMUNE_S, BAIT_RANGE, SHEAR_REGROW_S, SHEAR_WOOL,
  WOLF_BITE_S, FOLLOW_NEAR, SADDLE_Y, RIDER_HEIGHT, RIDE_SCALE, ADULT_AGE,
  HIT_FLEE_S, ANIMAL_HURT_S, MILK_REGROW_S,
} from '../../src/animals.js';
import { LIVE_MAX } from '../../src/populations.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { createPlayer, shouldPaddle, settleFloat, FLOAT_POINT } from '../../src/physics.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { createAnimalRenderer, bodyVariant, MODELS } from '../../src/animalRenderer.js';
import * as THREE from 'three';

const B = BLOCK;
const GROUND = 10;
const DT = 1 / 60;
/** Flat grass world: grass at GROUND − 1, air above. `extra` maps "q,y,r" → block id (snares). */
function flatWorld(extra = new Map()) {
  return (q, y, r) => extra.get(`${q},${y},${r}`) ?? (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
}
const view = (getBlock, player, more = {}) => ({ getBlock, isLoaded: () => true, player, heldKey: null, ...more });
const standing = (x, z, more = {}) => Object.assign(createPlayer(x, GROUND, z), { onGround: true }, more);
function run(as, world, seconds, each) {
  for (let f = 0; f < seconds * 60; f++) {
    const ev = as.update(DT, world);
    if (each && each(ev, f) === false) return f;
  }
  return -1;
}

describe('animals — the species', () => {
  it('the kinds, with bodies that fit the collider; spawn refuses junk and stops at ANIMAL_MAX', () => {
    // v0.14 (§76 fauna): + deer, rabbit, pheasant, turkey, bear and fish (tests/unit/fauna.test.js)
    expect(ANIMAL_KINDS).toEqual(['cow', 'sheep', 'horse', 'wolf', 'deer', 'rabbit', 'pheasant', 'turkey', 'bear', 'fish']);
    expect(ANIMAL_MAX).toBe(64); // 24 until v0.14, 40 until §88: the live list holds up to LIVE_MAX
    expect(ANIMAL_MAX).toBe(LIVE_MAX);
    const as = new Animals(seededRng(1));
    as.now = 7;
    for (const k of ANIMAL_KINDS) {
      const a = as.spawn(k, 0, GROUND, 0);
      expect(a).toMatchObject({ kind: k, radius: SPECIES[k].radius, height: SPECIES[k].height, health: SPECIES[k].health, tamed: false });
      expect(a.radius).toBeLessThanOrEqual(0.5);
      // §88: a spawn is a grown female unless told otherwise
      expect(a).toMatchObject({ sex: 'f', born: 7 - ADULT_AGE, size: 1 });
    }
    expect(as.spawn('cow', 0, GROUND, 0, 0, 'm').sex).toBe('m');
    expect(as.spawn('dragon', 0, GROUND, 0)).toBeNull();
    expect(as.spawn('cow', NaN, GROUND, 0)).toBeNull();
    expect(isAnimalKind('wolf') && !isAnimalKind('pig') && !isAnimalKind('__proto__')).toBe(true);
    while (as.size < ANIMAL_MAX) as.spawn('sheep', as.size, GROUND, 0);
    expect(as.spawn('sheep', 0, GROUND, 5)).toBeNull();
    // §88: horses, wolves and now cattle and sheep can be tamed; a horse outruns a sprinting player, cattle do not
    expect(ANIMAL_KINDS.filter((k) => SPECIES[k].tame > 0)).toEqual(['cow', 'sheep', 'horse', 'wolf']);
    expect(fleeSpeed('horse')).toBeGreaterThan(SPRINT_SPEED);
    expect(fleeSpeed('cow')).toBeLessThan(SPRINT_SPEED);
    expect(fleeSpeed('cow')).toBeCloseTo(WALK_SPEED, 6);
  });
});

describe('animals — wary: they run from a player who comes near', () => {
  it('a walking player within `notice` startles it and its herd; they run until CALM_FACTOR × notice away', () => {
    const as = new Animals(seededRng(2));
    const a = as.spawn('sheep', 0, GROUND, 0);
    const mate = as.spawn('sheep', 2, GROUND, 2);
    const loner = as.spawn('cow', 3, GROUND, 0);
    const player = standing(-(SPECIES.sheep.notice - 1), 0);
    const ev = as.update(DT, view(flatWorld(), player));
    expect(ev.startled).toEqual(expect.arrayContaining([a, mate]));
    expect(a.mode).toBe('flee');
    expect(mate.mode).toBe('flee');
    expect(loner.mode).not.toBe('flee'); // the cow is 12 m from the player: beyond its notice of 9, and no sheep
    run(as, view(flatWorld(), player), 6);
    const d = Math.hypot(a.x - player.x, a.z - player.z);
    expect(d).toBeGreaterThan(SPECIES.sheep.notice * CALM_FACTOR - 1);
    expect(a.x).toBeGreaterThan(5); // straight away from the player
  });

  it('sneaking gets much closer; a flying player and nobody at all scare nothing', () => {
    expect(SNEAK_NOTICE).toBe(WARY_SNEAK_FACTOR);
    for (const [more, flees] of [[{ sneaking: true }, false], [{ flying: true }, false], [{}, true]]) {
      const as = new Animals(seededRng(3));
      const a = as.spawn('cow', 0, GROUND, 0);
      const player = standing(-5, 0, more);
      // stepPlayer is not run on this player, so the flags stay as set
      as.update(DT, view(flatWorld(), player));
      expect(a.mode === 'flee', JSON.stringify(more)).toBe(flees);
    }
    const a = { kind: 'horse' };
    expect(noticeRange(a, { sneaking: true })).toBeCloseTo(SPECIES.horse.notice * SNEAK_NOTICE, 9);
    expect(noticeRange(a, { sprinting: true })).toBeGreaterThan(SPECIES.horse.notice);
    const quiet = new Animals(seededRng(4));
    const s = quiet.spawn('sheep', 0, GROUND, 0);
    run(quiet, view(flatWorld(), null), 3);
    expect(s.mode).not.toBe('flee');
  });

  it('a horse runs faster than the player can sprint; it does not run off an edge', () => {
    const as = new Animals(seededRng(5));
    const a = as.spawn('horse', 0, GROUND, 0);
    const player = standing(-6, 0);
    let top = 0;
    run(as, view(flatWorld(), player), 2, () => {
      top = Math.max(top, Math.hypot(a.vx, a.vz));
    });
    expect(top).toBeGreaterThan(SPRINT_SPEED);
    // a cliff 4 cells east: it turns aside instead of going over
    const cliff = (q, y, r) => (q >= 5 ? B.AIR : flatWorld()(q, y, r));
    const bs = new Animals(seededRng(6));
    const b = bs.spawn('sheep', 0, GROUND, 0);
    run(bs, view(cliff, standing(-6, 0)), 5);
    expect(b.y).toBeGreaterThan(GROUND - 0.5);
  });
});

describe('animals — luring, feeding and taming', () => {
  it('food it likes in the player\'s hand: it does not run, and comes up to LURE_STOP', () => {
    const as = new Animals(seededRng(7));
    const a = as.spawn('sheep', 0, GROUND, 0);
    const player = standing(-7, 0);
    run(as, view(flatWorld(), player, { heldKey: 'wild_tuber' }), 8);
    expect(a.mode).toBe('lure');
    expect(Math.hypot(a.x - player.x, a.z - player.z)).toBeLessThan(LURE_STOP + 0.6);
    // a wolf wants meat, not tubers
    const ws = new Animals(seededRng(8));
    const w = ws.spawn('wolf', 0, GROUND, 0);
    ws.update(DT, view(flatWorld(), player, { heldKey: 'wild_tuber' }));
    expect(w.mode).toBe('flee');
  });

  it('feeding calms cattle and sheep; three feeds tame a horse or a wolf; the wrong food does nothing', () => {
    const as = new Animals(seededRng(9));
    const cow = as.spawn('cow', 0, GROUND, 0);
    expect(as.feed(cow, 'raw_pork')).toEqual({ ok: false });
    expect(as.feed(cow, 'honeyberries')).toEqual({ ok: true, calmed: true });
    expect(cow.calm).toBe(FED_CALM_S);
    as.update(DT, view(flatWorld(), standing(-2, 0)));
    expect(cow.mode).not.toBe('flee'); // calm: the player may come close
    expect(cow.tamed).toBe(false);
    const horse = as.spawn('horse', 20, GROUND, 0);
    expect(as.feed(horse, 'wild_tuber')).toEqual({ ok: true, calmed: true });
    expect(as.feed(horse, 'wild_tuber')).toEqual({ ok: true, calmed: true });
    expect(as.feed(horse, 'honeyberries')).toEqual({ ok: true, tamed: true });
    expect(horse.tamed).toBe(true);
    const wolf = as.spawn('wolf', 40, GROUND, 0);
    expect(as.feed(wolf, 'honeyberries').ok).toBe(false);
    for (let i = 0; i < SPECIES.wolf.tame; i++) as.feed(wolf, 'raw_mutton');
    expect(wolf.tamed).toBe(true);
    // a tame animal never runs, and food heals it
    wolf.health = 3;
    as.feed(wolf, 'roast_pork');
    expect(wolf.health).toBe(6);
    run(as, view(flatWorld(), standing(40.5, 1)), 1);
    expect(wolf.mode).not.toBe('flee');
    expect(horse.mode).not.toBe('flee');
  });
});

describe('animals — a tame horse is ridden, a tame wolf follows and guards', () => {
  it('mount: only a tame horse; ridden it is taller, goes where the rider steers at RIDE_SCALE, and leaps on jump', () => {
    const as = new Animals(seededRng(10));
    const wild = as.spawn('horse', 0, GROUND, 0);
    expect(as.mount(wild)).toBe(false);
    for (let i = 0; i < 3; i++) as.feed(wild, 'wild_tuber');
    expect(as.mount(wild)).toBe(true);
    expect(wild.height).toBeCloseTo(SPECIES.horse.height + RIDER_HEIGHT, 9);
    expect(SADDLE_Y).toBeGreaterThan(1);
    const getBlock = flatWorld();
    const input = { forward: 1, strafe: 0, sprint: true, jump: false, yaw: -Math.PI / 2 }; // east
    let top = 0;
    for (let f = 0; f < 120; f++) {
      as.ride(wild, input, getBlock, DT);
      top = Math.max(top, Math.hypot(wild.vx, wild.vz));
    }
    expect(wild.x).toBeGreaterThan(12);
    expect(top).toBeCloseTo(SPRINT_SPEED * RIDE_SCALE, 0);
    // update() leaves a ridden horse to ride()
    const x = wild.x;
    as.update(DT, view(getBlock, standing(x, 0)));
    expect(wild.x).toBe(x);
    // Space: a leap of about two cells
    let peak = 0;
    for (let f = 0; f < 90; f++) {
      as.ride(wild, { forward: 0, jump: f === 0, yaw: 0 }, getBlock, DT);
      peak = Math.max(peak, wild.y - GROUND);
    }
    expect(peak).toBeGreaterThan(1.9);
    expect(peak).toBeLessThan(2.6);
    as.dismount(wild);
    expect(wild.ridden).toBe(false);
    expect(wild.height).toBe(SPECIES.horse.height);
    expect([wild.homeX, wild.homeZ]).toEqual([wild.x, wild.z]);
  });

  it('a tame wolf keeps by the player, sits when told, and bites a zombie near it once a second', () => {
    const as = new Animals(seededRng(11));
    const wolf = as.spawn('wolf', 0, GROUND, 0);
    for (let i = 0; i < 3; i++) as.feed(wolf, 'raw_pork');
    const player = standing(12, 0);
    run(as, view(flatWorld(), player), 5);
    expect(Math.hypot(wolf.x - player.x, wolf.z - player.z)).toBeLessThan(FOLLOW_NEAR + 1);
    wolf.sitting = true;
    player.x = 30;
    run(as, view(flatWorld(), player), 3);
    expect(wolf.x).toBeLessThan(13);
    wolf.sitting = false;
    const zombie = { x: player.x + 2, y: GROUND, z: 0 };
    let bites = 0;
    let first = -1;
    run(as, view(flatWorld(), player, { threats: [zombie] }), 8, (ev, f) => {
      if (ev.bites.length) {
        expect(ev.bites[0]).toEqual({ wolf, target: zombie });
        if (first < 0) first = f;
        bites += ev.bites.length;
      }
    });
    expect(bites).toBeGreaterThanOrEqual(2);
    expect(bites).toBeLessThanOrEqual(Math.ceil((8 - first / 60) / WOLF_BITE_S) + 1);
  });
});

describe('animals — hunting and shearing', () => {
  it('wound: a blow takes health, knocks it back and sets the herd running; hits during the flash are ignored; 0 kills', () => {
    const as = new Animals(seededRng(12));
    const a = as.spawn('cow', 2, GROUND, 0);
    const mate = as.spawn('cow', 4, GROUND, 1);
    expect(as.wound(a, 3, 0, 0)).toBe('hit');
    expect(a.health).toBe(SPECIES.cow.health - 3);
    expect(a.hurt).toBe(ANIMAL_HURT_S);
    expect(a.vx).toBeGreaterThan(0);
    expect(a.mode).toBe('flee');
    expect(mate.mode).toBe('flee');
    expect(mate.timer).toBeGreaterThanOrEqual(HIT_FLEE_S);
    expect(as.wound(a, 3, 0, 0)).toBeNull(); // still flashing
    a.hurt = 0;
    expect(as.wound(a, 0, 0, 0)).toBe('hit'); // a shove: no damage
    expect(a.health).toBe(SPECIES.cow.health - 3);
    a.hurt = 0;
    expect(as.wound(a, 99, 0, 0)).toBe('dead');
    expect(as.list).toEqual([mate]);
    expect(as.wound(a, 1, 0, 0)).toBeNull();
  });

  it('shear: a sheep gives 1–2 wool and its fleece grows back; nothing else is sheared', () => {
    const as = new Animals(seededRng(13));
    const sheep = as.spawn('sheep', 0, GROUND, 0);
    const n = as.shear(sheep);
    expect(n).toBeGreaterThanOrEqual(SHEAR_WOOL[0]);
    expect(n).toBeLessThanOrEqual(SHEAR_WOOL[1]);
    expect(sheep.shorn).toBe(SHEAR_REGROW_S);
    expect(as.shear(sheep)).toBe(0);
    expect(bodyVariant(sheep)).toBe('alt');
    sheep.shorn = 0;
    expect(as.shear(sheep)).toBeGreaterThan(0);
    expect(as.shear(as.spawn('cow', 5, GROUND, 0))).toBe(0);
  });
});

describe('animals — snares', () => {
  const key = (q, y, r) => `${q},${y},${r}`;
  it('a wild animal that steps into a set snare is held TRAP_HOLD_S, then breaks free and is immune for a while', () => {
    const cells = new Map([[key(0, GROUND, 0), B.SNARE]]);
    const getBlock = flatWorld(cells);
    const as = new Animals(seededRng(14));
    const [x, z] = hexToWorld(0, 0);
    const a = as.spawn('sheep', x, GROUND, z);
    const ev = as.update(DT, view(getBlock, null));
    expect(ev.caught).toEqual([{ animal: a, cell: [0, GROUND, 0] }]);
    cells.set(key(0, GROUND, 0), B.SNARE_SPRUNG); // what main does
    expect(a.trapped).toBe(TRAP_HOLD_S);
    run(as, view(getBlock, standing(1, 0)), 3); // the player walks right up: it cannot run
    expect(worldToHex(a.x, a.z)).toEqual([0, 0]);
    expect(as.wound(a, 2, 1, 0)).toBe('hit'); // and can be struck in place
    expect(worldToHex(a.x, a.z)).toEqual([0, 0]);
    let freed = null;
    a.trapped = 0.5;
    run(as, view(getBlock, null), 1, (e) => {
      if (e.freed.length) freed = e.freed[0];
    });
    expect(freed).toEqual({ cell: [0, GROUND, 0], escaped: true });
    expect(a.trapped).toBe(0);
    expect(a.immune).toBeGreaterThan(TRAP_IMMUNE_S - 2);
    expect(a.mode).toBe('flee');
  });

  it('breaking the snare lets it go at once; a tame animal is never caught; death frees the snare', () => {
    const cells = new Map([[key(0, GROUND, 0), B.SNARE]]);
    const getBlock = flatWorld(cells);
    const as = new Animals(seededRng(15));
    as.spawn('cow', 0, GROUND, 0);
    as.update(DT, view(getBlock, null));
    cells.set(key(0, GROUND, 0), B.SNARE_SPRUNG);
    run(as, view(getBlock, null), 0.5);
    cells.delete(key(0, GROUND, 0)); // dug up
    let freed = null;
    run(as, view(getBlock, null), 0.2, (e) => {
      if (e.freed.length) freed = e.freed[0];
    });
    expect(freed).toEqual({ cell: [0, GROUND, 0], escaped: false });
    // death while held
    const cells2 = new Map([[key(0, GROUND, 0), B.SNARE]]);
    const bs = new Animals(seededRng(16));
    const b = bs.spawn('sheep', 0, GROUND, 0);
    bs.update(DT, view(flatWorld(cells2), null));
    cells2.set(key(0, GROUND, 0), B.SNARE_SPRUNG);
    expect(bs.wound(b, 99, 1, 0)).toBe('dead');
    expect(bs.update(DT, view(flatWorld(cells2), null)).freed).toEqual([{ cell: [0, GROUND, 0], escaped: false }]);
    // tame
    const cells3 = new Map([[key(0, GROUND, 0), B.SNARE]]);
    const cs = new Animals(seededRng(17));
    const h = cs.spawn('horse', 0, GROUND, 0);
    for (let i = 0; i < 3; i++) cs.feed(h, 'wild_tuber');
    expect(cs.update(DT, view(flatWorld(cells3), null)).caught).toEqual([]);
  });

  it('a baited snare draws a calm animal from BAIT_RANGE cells; an unbaited one does not', () => {
    for (const [id, comes] of [[B.SNARE_BAITED, true], [B.SNARE, false]]) {
      const cells = new Map([[key(BAIT_RANGE - 2, GROUND, 0), id]]);
      const as = new Animals(() => 0.5);
      const a = as.spawn('sheep', 0, GROUND, 0);
      a.timer = 999; // it would stand idle for ever
      let caught = false;
      run(as, view(flatWorld(cells), null), 12, (ev) => {
        if (ev.caught.length) caught = true;
        return !caught;
      });
      expect(caught, String(id)).toBe(comes);
      if (comes) expect(a.trapCell).toEqual([BAIT_RANGE - 2, GROUND, 0]);
    }
  });
});

describe('animals — none appears or goes by itself (§88: populations.js); the save', () => {
  it('the live list neither spawns herds nor despawns the far ones: a wild animal 1000 m away stays (it is put to sleep by the store)', () => {
    // (the herds that appeared near the player and the despawning beyond DESPAWN_DIST are retired: tests/unit/populations.test.js
    // checks where animals now come from, and that walking away keeps every one)
    const as = new Animals(seededRng(18));
    const wild = as.spawn('cow', 1000, GROUND, 0);
    const player = standing(0, 0, { flying: true });
    const world = view(flatWorld(), player, {
      getBiome: () => BIOME.PLAINS, groundHeight: () => GROUND - 1, isNaturalGround: () => true, isLoadedCell: () => true,
    });
    let despawned = 0;
    run(as, world, 600, (ev) => {
      despawned += ev.despawned;
    });
    expect(despawned).toBe(0);
    expect(as.list).toEqual([wild]);
    expect('spawned' in as.events).toBe(false);
  });

  it('detach takes one out of the list without letting its snare go (it sleeps held); remove lets it go', () => {
    const as = new Animals(seededRng(21));
    const a = as.spawn('cow', 0, GROUND, 0);
    a.trapped = 30;
    a.trapCell = [0, GROUND, 0];
    expect(as.detach(a)).toBe(true);
    expect(as.events.freed).toEqual([]);
    expect(as.detach(a)).toBe(false);
    const b = as.spawn('cow', 0, GROUND, 0);
    b.trapped = 30;
    b.trapCell = [1, GROUND, 1];
    as.remove(b);
    expect(as.events.freed).toEqual([{ cell: [1, GROUND, 1], escaped: false }]);
  });

  it('export / load keep every animal with its taming, trust, fleece and snare; bad entries are dropped', () => {
    const as = new Animals(seededRng(22));
    const horse = as.spawn('horse', 1.234, GROUND, 2);
    for (let i = 0; i < 3; i++) as.feed(horse, 'wild_tuber');
    const wolf = as.spawn('wolf', 3, GROUND, 4);
    as.feed(wolf, 'raw_pork');
    const sheep = as.spawn('sheep', 5, GROUND, 6);
    as.shear(sheep);
    const cow = as.spawn('cow', 7, GROUND, 8);
    cow.trapped = 40.2;
    cow.trapCell = [9, GROUND, 9];
    const saved = JSON.parse(JSON.stringify(as.export()));
    expect(saved[0]).toMatchObject({ k: 'horse', x: 1.23, t: 1 });
    expect(saved[1]).toMatchObject({ k: 'wolf', tr: 1 });
    expect(saved[2]).toMatchObject({ k: 'sheep', s: SHEAR_REGROW_S });
    expect(saved[3]).toMatchObject({ k: 'cow', tp: 41, tc: [9, GROUND, 9] });
    const back = new Animals(seededRng(23));
    back.load([...saved, { k: 'dragon', x: 0, y: 0, z: 0 }, { k: 'cow', x: NaN, y: 0, z: 0 }, null]);
    expect(back.list.map((a) => [a.kind, a.tamed, a.trust, a.shorn > 0, a.trapped > 0])).toEqual([
      ['horse', true, 0, false, false], ['wolf', false, 1, false, false], ['sheep', false, 0, true, false], ['cow', false, 0, false, true],
    ]);
    const v = validateAnimalsJSON([{ k: 'cow', x: 0, y: 1, z: 2, t: 1 }, { k: 'deer', x: 0, y: 1, z: 2, t: 1 }, 'junk']);
    // §88: a cow may be tame now; a deer never is
    expect(v.animals).toEqual([{ k: 'cow', x: 0, y: 1, z: 2, yaw: 0, h: SPECIES.cow.health, t: 1 }, { k: 'deer', x: 0, y: 1, z: 2, yaw: 0, h: SPECIES.deer.health }]);
    expect(v.warnings).toEqual(['animals[2]: invalid, dropped']);
    expect(validateAnimalsJSON(undefined)).toEqual({ animals: [], warnings: [] });
  });
});

describe('stalking from behind (v0.16, CONTRACTS §69 amendment)', () => {
  it('isBehind: a point is out of sight when it is more than the half angle from straight ahead', () => {
    // yaw 0 faces −z (yawToForward = (−sin, −cos))
    expect(yawToForward(0).map((v) => v + 0)).toEqual([0, -1]);
    expect(isBehind(0, 0, -5, WARY_VIEW_HALF_ANGLE)).toBe(false); // straight ahead
    expect(isBehind(0, 5, 0, WARY_VIEW_HALF_ANGLE)).toBe(false); // beside it
    expect(isBehind(0, -5, 0, WARY_VIEW_HALF_ANGLE)).toBe(false);
    expect(isBehind(0, 0, 5, WARY_VIEW_HALF_ANGLE)).toBe(true); // straight behind
    // the edge of the blind arc is 120° from ahead: 119° is seen, 121° is not
    const at = (deg) => [Math.sin((deg * Math.PI) / 180) * 4, -Math.cos((deg * Math.PI) / 180) * 4];
    for (const side of [1, -1]) {
      expect(isBehind(0, ...at(side * 119), WARY_VIEW_HALF_ANGLE)).toBe(false);
      expect(isBehind(0, ...at(side * 121), WARY_VIEW_HALF_ANGLE)).toBe(true);
    }
    expect(isBehind(Math.PI / 2, 5, 0, WARY_VIEW_HALF_ANGLE)).toBe(true); // facing −x: +x is behind
    expect(isBehind(0, 0, 0, WARY_VIEW_HALF_ANGLE)).toBe(false);
    expect(isBehind(NaN, 0, 5, WARY_VIEW_HALF_ANGLE)).toBe(false);
    expect([VIEW_HALF_ANGLE, BEHIND_NOTICE]).toEqual([WARY_VIEW_HALF_ANGLE, WARY_BEHIND_FACTOR]);
  });

  it('noticeRange: sneaking from behind halves the sneaking distance; walking or sprinting from behind changes nothing', () => {
    const deer = { kind: 'deer', x: 0, z: 0, yaw: 0 }; // facing −z
    const n = SPECIES.deer.notice;
    const behind = { x: 0, z: 4 };
    const ahead = { x: 0, z: -4 };
    expect(blindTo(deer, behind)).toBe(true);
    expect(blindTo(deer, ahead)).toBe(false);
    expect(noticeRange(deer, { ...behind, sneaking: true })).toBeCloseTo(n * SNEAK_NOTICE * BEHIND_NOTICE, 9);
    expect(noticeRange(deer, { ...ahead, sneaking: true })).toBeCloseTo(n * SNEAK_NOTICE, 9);
    expect(noticeRange(deer, { ...behind })).toBe(n); // it hears a walker
    expect(noticeRange(deer, { ...behind, sprinting: true })).toBeGreaterThan(n);
    // without positions (or a heading) there is no blind side
    expect(noticeRange({ kind: 'deer' }, { sneaking: true })).toBeCloseTo(n * SNEAK_NOTICE, 9);
    expect(blindTo({ kind: 'deer', x: 0, z: 0 }, behind)).toBe(false);
  });

  it('a sneaker at a deer\'s back comes within reach; the same distance in front of it sends it running; so does its turning round', () => {
    const near = SPECIES.deer.notice * SNEAK_NOTICE * 0.7; // 4.5 m: inside the sneaking distance, outside half of it
    const still = (yaw) => {
      const as = new Animals(seededRng(5));
      const a = as.spawn('deer', 0, GROUND, 0, yaw);
      a.targetYaw = yaw;
      return [as, a];
    };
    // the deer faces −z; the player sneaks at +z (behind it)
    const [as, a] = still(0);
    as.update(DT, view(flatWorld(), standing(0, near, { sneaking: true })));
    expect(a.mode).not.toBe('flee');
    // the same player in front of it
    const [bs, b] = still(0);
    bs.update(DT, view(flatWorld(), standing(0, -near, { sneaking: true })));
    expect(b.mode).toBe('flee');
    // walking up behind it is heard
    const [cs, c] = still(0);
    cs.update(DT, view(flatWorld(), standing(0, near)));
    expect(c.mode).toBe('flee');
    // it turns its head toward the sneaker: now it sees
    const [ds, d] = still(0);
    const player = standing(0, near, { sneaking: true });
    ds.update(DT, view(flatWorld(), player));
    expect(d.mode).not.toBe('flee');
    d.yaw = Math.PI; // facing +z
    d.targetYaw = Math.PI;
    ds.update(DT, view(flatWorld(), player));
    expect(d.mode).toBe('flee');
    // and even from behind there is a limit
    const [es, e] = still(0);
    es.update(DT, view(flatWorld(), standing(0, SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE - 0.3, { sneaking: true })));
    expect(e.mode).toBe('flee');
  });

  it('a pig has the same blind side', () => {
    const pigWorld = (player) => ({ getBlock: flatWorld(), isLoaded: () => true, player });
    const near = PIG_NOTICE * WARY_SNEAK_FACTOR * 0.75; // 1.8 m
    const ps = new Pigs(seededRng(31));
    const pig = ps.spawn(0, GROUND, 0, 0); // facing −z
    ps.update(DT, pigWorld(standing(0, near, { sneaking: true })));
    expect(pig.mode).not.toBe('flee');
    const qs = new Pigs(seededRng(31));
    const front = qs.spawn(0, GROUND, 0, 0);
    qs.update(DT, pigWorld(standing(0, -near, { sneaking: true })));
    expect(front.mode).toBe('flee');
  });
});

describe('pigs are wary too, and can be snared (CONTRACTS §69)', () => {
  const pigWorld = (player) => ({ getBlock: flatWorld(), isLoaded: () => true, player });
  it('a pig runs from a walking player within PIG_NOTICE, not from a sneaking one at that distance', () => {
    const ps = new Pigs(seededRng(30));
    const pig = ps.spawn(0, GROUND, 0);
    ps.update(DT, pigWorld(standing(-(PIG_NOTICE - 1), 0, { sneaking: true })));
    expect(pig.mode).not.toBe('flee');
    ps.update(DT, pigWorld(standing(-(PIG_NOTICE - 1), 0)));
    expect(pig.mode).toBe('flee');
    const x0 = pig.x;
    for (let f = 0; f < 60; f++) ps.update(DT, pigWorld(standing(-(PIG_NOTICE - 1), 0)));
    expect(pig.x).toBeGreaterThan(x0 + 1.5);
  });
  it('a snared pig (`trapped`) stays put and counts down', () => {
    const ps = new Pigs(seededRng(31));
    const pig = ps.spawn(0, GROUND, 0);
    pig.trapped = 2;
    for (let f = 0; f < 60; f++) ps.update(DT, pigWorld(standing(-2, 0)));
    expect([pig.x, pig.z]).toEqual([0, 0]);
    expect(pig.trapped).toBeCloseTo(1, 1);
  });
});

describe('animalRenderer — chunky box models', () => {
  it('draws each animal as one body (or its variant) and four legs; a hurt one on the red twins', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const by = (name) => r.group.children.find((m) => m.name === name);
    const mk = (kind, more = {}) => ({ kind, x: 0, y: 10, z: 0, yaw: 0, walkPhase: 0, hurt: 0, shorn: 0, tamed: false, ...more });
    r.sync([mk('cow'), mk('sheep'), mk('sheep', { shorn: 9 }), mk('horse', { tamed: true }), mk('wolf', { hurt: 0.2 }), mk('wolf', { tamed: true })]);
    expect(r.count()).toBe(6);
    expect(by('cow-body').count).toBe(1);
    expect(by('cow-legs').count).toBe(4);
    expect(by('sheep-body').count).toBe(1);
    expect(by('sheep-alt').count).toBe(1); // shorn
    expect(by('sheep-legs').count).toBe(8);
    expect(by('horse-alt').count).toBe(1); // saddled
    expect(by('horse-body').count).toBe(0);
    expect(by('wolf-body-hurt').count).toBe(1);
    expect(by('wolf-alt').count).toBe(1); // collared
    expect(by('wolf-legs-hurt').count).toBe(4);
    // the legs stand on the ground, and each model is about as tall as its body
    for (const kind of ANIMAL_KINDS) {
      const boxes = MODELS[kind].body;
      const top = Math.max(...boxes.map((b) => b[4] + b[1] / 2));
      expect(top, kind).toBeGreaterThan(SPECIES[kind].height - 0.1);
      expect(top, kind).toBeLessThan(SPECIES[kind].height + 0.6);
    }
    r.sync([]);
    expect(r.group.children.every((m) => m.count === 0 && !m.visible)).toBe(true);
    r.dispose();
  });
});

describe('animals — milk (CONTRACTS §72)', () => {
  it('a cow gives milk once, then again after MILK_REGROW_S; nothing else is milked; the wait is saved', () => {
    const as = new Animals(seededRng(40));
    const cow = as.spawn('cow', 0, GROUND, 0);
    expect(as.milk(cow)).toBe(true);
    expect(cow.milked).toBe(MILK_REGROW_S);
    expect(as.milk(cow)).toBe(false);
    expect(as.export()[0].m).toBe(MILK_REGROW_S);
    const back = new Animals(seededRng(41));
    back.load(as.export());
    expect(back.list[0].milked).toBe(MILK_REGROW_S);
    cow.milked = 0;
    expect(as.milk(cow)).toBe(true);
    expect(as.milk(as.spawn('sheep', 3, GROUND, 0))).toBe(false);
    expect(as.milk(as.spawn('horse', 6, GROUND, 0))).toBe(false);
  });
});

describe('animalRenderer — a black hole\'s ghost (renderScale, renderSpin)', () => {
  it('scales the whole animal about its feet and adds the spin to its yaw; without them nothing changes', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const mesh = r.group.children.find((m) => m.name === 'cow-body');
    const legs = r.group.children.find((m) => m.name === 'cow-legs');
    const base = { kind: 'cow', x: 2, y: 10, z: 3, yaw: 0.4, walkPhase: 0, hurt: 0, shorn: 0, tamed: false };
    const mat = (m, i = 0) => {
      const out = new THREE.Matrix4();
      m.getMatrixAt(i, out);
      return out;
    };
    r.sync([base]);
    const plain = mat(mesh).toArray();
    r.sync([{ ...base, renderScale: 1, renderSpin: 0 }]);
    expect(mat(mesh).toArray()).toEqual(plain);
    r.sync([{ ...base, renderScale: 0.5, renderSpin: 1 }]);
    const s = new THREE.Vector3().setFromMatrixScale(mat(mesh));
    expect(s.x).toBeCloseTo(0.5, 5);
    expect(s.y).toBeCloseTo(0.5, 5);
    const hip = new THREE.Vector3().setFromMatrixPosition(mat(legs));
    expect(hip.y).toBeCloseTo(10 + MODELS.cow.legH * 0.5, 5); // the hips, half as high
    const e = new THREE.Euler().setFromRotationMatrix(mat(mesh), 'YXZ');
    expect(e.y).toBeCloseTo(1.4, 5);
    r.dispose();
  });
});

describe('swimming mobs float low and steady (KNOWN-ISSUES V1; CONTRACTS §72)', () => {
  /** A lake: stone below y 4, water y 4..9 (its surface at 9.875), air above. */
  const lake = (_q, y) => (y < 4 ? B.STONE : y < GROUND ? B.WATER : B.AIR);
  const SURFACE = GROUND - 1 + 0.875;
  it('shouldPaddle: only while the float point is under water, or pressing into a bank', () => {
    const body = { x: 0, z: 0, y: SURFACE - 1, height: 1, radius: 0.3, inWater: true, hitWall: false };
    expect(shouldPaddle(lake, body)).toBe(true); // deep
    body.y = SURFACE - 1 * FLOAT_POINT + 0.05; // the float point just above the surface
    expect(shouldPaddle(lake, body)).toBe(false);
    body.hitWall = true;
    expect(shouldPaddle(lake, body)).toBe(true); // the exit jump at a bank
    expect(shouldPaddle(lake, { ...body, inWater: false })).toBe(false);
  });
  it('an animal and a zombie dropped in a lake settle with FLOAT_POINT of their height under water, without bobbing', () => {
    const as = new Animals(seededRng(50));
    const cow = as.spawn('cow', 0, GROUND + 0.5, 0);
    cow.timer = 999;
    const ys = [];
    for (let f = 0; f < 300; f++) {
      as.update(DT, { getBlock: lake, isLoaded: () => true, player: null });
      if (f >= 150) ys.push(cow.y);
    }
    const line = SURFACE - cow.height * FLOAT_POINT;
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.08); // steady
    expect(Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - line)).toBeLessThan(0.08); // at its float line
    expect(Math.max(...ys) + cow.height).toBeGreaterThan(SURFACE + 0.3); // its back shows …
    expect(Math.max(...ys)).toBeLessThan(SURFACE - 0.3); // … and its feet never reach the surface
  });
  it('settleFloat leaves a body on the ground, at a bank, in an exit jump, or well above the water alone', () => {
    const mk = (more) => ({ x: 0, z: 0, y: SURFACE - 0.2, vy: 1, height: 1, radius: 0.3, onGround: false, hitWall: false, ...more });
    for (const more of [{ onGround: true }, { hitWall: true }, { vy: 8.7 }, { y: SURFACE + 0.4 }]) {
      const b = mk(more);
      const before = { y: b.y, vy: b.vy };
      settleFloat(lake, b, DT);
      expect({ y: b.y, vy: b.vy }, JSON.stringify(more)).toEqual(before);
    }
    const high = mk({});
    settleFloat(lake, high, DT);
    expect(high.y).toBeLessThan(SURFACE - 0.2); // riding too high: it settles back …
    expect(high.vy).toBe(0); // … and stops rising
  });
});
