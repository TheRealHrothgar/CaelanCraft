// Unit tests for §100's first rule: fish belong to their water (src/populations.js, src/animals.js). The user: "Fish seem
// to appear and disappear spontaneously in small pond or stream." A fish is never made or removed where the player can
// see it (`inView`), a body of water holds fish by its size (a tiny pond one at most), and a fish keeps to its water.
import { describe, it, expect } from 'vitest';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { SEA_LEVEL } from '../../src/config.js';
import { hexToWorld, hexLength, worldToHex } from '../../src/hex.js';
import { createPlayer } from '../../src/physics.js';
import { Animals, fishDepth, fishWater, FISH_DEEP, FISH_RISE, FISH_DART } from '../../src/animals.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import {
  Fauna, ZONE_SIZE, SCAN_S, SLEEP_RADIUS, FISH_CELLS, FISH_K_MAX, FISH_BODIES_MAX, fishCapOf, zoneKey, zoneLand, seedZone,
  makeRecord, validateFaunaJSON,
} from '../../src/populations.js';
import * as THREE from 'three';
import { pointInView, VIEW_SEEN_DIST } from '../../src/main.js';
import { createAnimalRenderer, MODELS } from '../../src/animalRenderer.js';

const B = BLOCK;
const GROUND = 10;

/** Flat grass at GROUND − 1; `water` columns "q,r" hold WATER there instead (`deep`: four cells of it). */
function pondWorld(water, deep = new Set()) {
  return (q, y, r) => {
    const k = `${q},${r}`;
    if (deep.has(k) && y >= GROUND - 4 && y <= GROUND - 1) return B.WATER;
    if (water.has(k) && y === GROUND - 1) return B.WATER;
    return y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR;
  };
}
/** The seven columns of a pond round (q, r). */
const pondCols = (q, r) => {
  const out = new Set();
  for (let dq = -1; dq <= 1; dq++) for (let dr = -1; dr <= 1; dr++) if (hexLength(dq, dr) <= 1) out.add(`${q + dq},${r + dr}`);
  return out;
};
function fakeGen({ stream = () => false, pond = () => false } = {}) {
  return { getColumn: () => ({ height: SEA_LEVEL + 8, biome: BIOME.PLAINS }), streamAt: stream, pondAt: pond };
}
function makeEnv(getBlock, player, more = {}) {
  const env = {
    t: 0, now: () => env.t, player, getBlock, isLoadedCell: () => true, isLoaded: () => true, groundHeight: () => GROUND - 1,
    isNaturalGround: () => true, getBiome: () => BIOME.PLAINS, gen: null, seed: 1, ...more,
  };
  return env;
}
const standing = (x, z) => Object.assign(createPlayer(x, GROUND, z), { onGround: true });
function putZone(fauna, zq, zr, K, land = {}, list = []) {
  const z = {
    key: zoneKey(zq, zr), zq, zr, t: fauna.now, t0: fauna.now, seeded: true, touched: true, list,
    land: { K, g: 1, w: 1, c: 0, ws: [], wk: [], mix: { plains: 1 }, ...land },
  };
  fauna.zones.set(z.key, z);
  return z;
}
const fishRec = (sex, q, r, more = {}) => {
  const [x, z] = hexToWorld(q, r);
  return Object.assign(makeRecord('fish', sex, -50, x, GROUND - 0.4, z, true, 0), more);
};

describe('§100 fish — a body of water holds fish by its size', () => {
  it('fishCapOf: round(columns / FISH_CELLS), at most FISH_K_MAX; a seven-column pond holds one at most', () => {
    expect([FISH_CELLS, FISH_K_MAX, FISH_BODIES_MAX]).toEqual([12, 6, 6]);
    expect(fishCapOf(0)).toBe(0);
    expect(fishCapOf(5)).toBe(0);
    expect(fishCapOf(7)).toBe(1);
    expect(fishCapOf(64)).toBe(5);
    expect(fishCapOf(1000)).toBe(FISH_K_MAX);
  });

  it('zoneLand tells the waters apart: a pond and a stream are two bodies, each with what it holds', () => {
    const pond = pondCols(10, 10);
    const land = zoneLand(fakeGen({ stream: (q) => q === 40, pond: (q, r) => pond.has(`${q},${r}`) }), 0, 0);
    expect(land.c).toBe(64 + 7); // every column counted, the pond's exactly
    expect(land.ws.length).toBe(2);
    expect(land.wk).toEqual([5, 1]); // the stream (64 columns) first, then the pond
    expect(pond.has(`${land.ws[1][0]},${land.ws[1][1]}`)).toBe(true); // a column of the pond itself
    expect(land.K.fish).toBe(6);
    // a tiny pond alone: one fish at most
    expect(zoneLand(fakeGen({ pond: (q, r) => pond.has(`${q},${r}`) }), 0, 0).K.fish).toBe(1);
    // a puddle of three columns holds none
    const puddle = new Set(['10,10', '11,10', '10,11']);
    expect(zoneLand(fakeGen({ pond: (q, r) => puddle.has(`${q},${r}`) }), 0, 0).K.fish).toBeUndefined();
  });

  it('seeding puts fish two by two into the body with the most room, never past what it holds', () => {
    const pond = pondCols(10, 10);
    const gen = fakeGen({ stream: (q) => q === 40, pond: (q, r) => pond.has(`${q},${r}`) });
    for (let s = 0; s < 20; s++) {
      const zone = { key: '0,0', zq: 0, zr: 0, t: 0, t0: 0, land: zoneLand(gen, 0, 0), seeded: false, touched: false, list: [] };
      zone.land.K.fish = 6;
      const out = seedZone(zone, gen, s, 0).filter((r) => r.kind === 'fish');
      const inPond = out.filter((r) => hexLength(worldToHex(r.x, r.z)[0] - 10, worldToHex(r.x, r.z)[1] - 10) <= 2);
      expect(inPond.length).toBeLessThanOrEqual(1);
      expect(out.length).toBe(Math.round(6 * 0.35)); // SEED_SHARE of K
      expect(new Set(out.map((r) => r.sex)).size).toBe(2); // a pair, in the stream
    }
  });

  it('a pair breeds up to what its water holds and no further, whatever the zone holds', () => {
    const fauna = new Fauna({ rng: seededRng(7), life: { youth: { fish: 1 }, rest: { fish: 0 }, rate: { fish: 2 } } });
    const env = makeEnv(pondWorld(new Set()), null);
    // two bodies: a pond holding 2 (the pair is there) and a stream holding 4 far off; the zone holds 6
    const z = putZone(fauna, 0, 0, { fish: 6 }, { ws: [[10, 10], [50, 50]], wk: [2, 4] },
      [fishRec('f', 10, 10), fishRec('m', 10, 11)]);
    fauna.step(60, env);
    expect(z.list.filter((r) => r.kind === 'fish').length).toBe(2); // the pond is full: no young
    // a pair in a body that holds four: they fill it, and stop there
    const f2 = new Fauna({ rng: seededRng(8), life: { youth: { fish: 1 }, rest: { fish: 0 }, rate: { fish: 2 } } });
    const z2 = putZone(f2, 0, 0, { fish: 6 }, { ws: [[10, 10], [50, 50]], wk: [2, 4] }, [fishRec('f', 50, 50), fishRec('m', 50, 51)]);
    f2.step(60, env);
    const near50 = z2.list.filter((r) => r.kind === 'fish' && hexLength(worldToHex(r.x, r.z)[0] - 50, worldToHex(r.x, r.z)[1] - 50) < 5);
    expect(near50.length).toBe(4);
    expect(z2.list.filter((r) => r.kind === 'fish').length).toBe(4); // none of the young was put in the pond
  });

  it('a land saved before §100 (spots, no `wk`) has its waters worked out again; the save keeps `wk`', () => {
    const pond = pondCols(10, 10);
    const gen = fakeGen({ pond: (q, r) => pond.has(`${q},${r}`) });
    const fauna = new Fauna({ rng: seededRng(9) });
    fauna.load({ v: 1, z: [{ q: 0, r: 0, t: 0, K: { fish: 3 }, g: 1, w: 1, c: 8, ws: [[10, 10]] }] });
    const z = fauna.zones.get('0,0');
    expect(z.land.wk).toBe(null);
    fauna.zone(0, 0, true, makeEnv(pondWorld(pond), null, { gen }));
    expect(z.land.wk).toEqual([1]);
    expect(z.land.K.fish).toBe(1);
    const saved = fauna.export();
    expect(saved.z[0].wk).toEqual([1]);
    expect(validateFaunaJSON(saved).zones[0].wk).toEqual([1]);
    // a `wk` that does not match its spots is dropped (and worked out again)
    expect(validateFaunaJSON({ v: 1, z: [{ q: 0, r: 0, t: 0, K: { fish: 1 }, ws: [[1, 1]], wk: [1, 2] }] }).zones[0].wk).toBeUndefined();
  });
});

describe('§100 fish — never made or removed in sight', () => {
  /** A pond round (10, 10) with the player beside it and a dormant pair in it. */
  function pondScene(seen) {
    const pond = pondCols(10, 10);
    const animals = new Animals(seededRng(3));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(4) });
    const [px, pz] = hexToWorld(10, 14);
    const player = standing(px, pz);
    const env = makeEnv(pondWorld(pond), player, { inView: () => seen.value });
    const z = putZone(fauna, 0, 0, { fish: 2 }, { ws: [[10, 10]], wk: [2] }, [fishRec('f', 10, 10), fishRec('m', 11, 10)]);
    return { animals, fauna, env, z, player, pond };
  }

  it('a dormant fish does not wake where the player is looking; it wakes once the player looks away', () => {
    const seen = { value: true };
    const { animals, fauna, env, z } = pondScene(seen);
    for (let i = 0; i < 4; i++) fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(0);
    expect(z.list.length).toBe(2);
    seen.value = false;
    fauna.update(SCAN_S, env);
    expect(animals.list.map((a) => a.kind)).toEqual(['fish', 'fish']);
    // in its own water, swimming
    for (const a of animals.list) expect(Number.isNaN(fishDepth(env.getBlock, ...worldToHex(a.x, a.z), a.y + a.height / 2))).toBe(false);
  });

  it('a fish in deep water may wake in sight, at the bottom, and rises slowly', () => {
    const deep = new Set(['10,10']);
    const animals = new Animals(seededRng(5));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(6) });
    const player = standing(...hexToWorld(10, 13));
    const env = makeEnv(pondWorld(new Set(), deep), player, { inView: () => true });
    putZone(fauna, 0, 0, { fish: 1 }, { ws: [[10, 10]], wk: [1] }, [fishRec('f', 10, 10)]);
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(1);
    const a = animals.list[0];
    const w = fishWater(env.getBlock, 10, 10, GROUND - 1);
    expect(w.swim - w.bed).toBeGreaterThanOrEqual(FISH_DEEP);
    expect(a.y).toBeCloseTo(w.bed + 0.06, 5);
    const y0 = a.y;
    animals.update(0.5, env);
    expect(a.y - y0).toBeLessThanOrEqual(FISH_RISE * 0.5 + 1e-9);
    expect(a.y).toBeGreaterThan(y0);
  });

  it('a live fish far off but in sight does not go to sleep until it is out of sight', () => {
    const seen = { value: true };
    const { animals, fauna, env, player } = pondScene(seen);
    seen.value = false;
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(2);
    seen.value = true;
    player.x += SLEEP_RADIUS + 20; // on a loaded chunk, far, and looking at it
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(2);
    seen.value = false;
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(0);
  });

  it('young born where the player could see them wait as records and wake unseen', () => {
    const seen = { value: false };
    const animals = new Animals(seededRng(11));
    const fauna = new Fauna({ animals, pigs: new Pigs(), rng: seededRng(12), life: { youth: { fish: 0.01 }, rest: { fish: 0 }, rate: { fish: 40 } } });
    const pond = new Set();
    for (let q = 5; q < 25; q++) for (let r = 9; r <= 11; r++) pond.add(`${q},${r}`);
    const player = standing(...hexToWorld(15, 14));
    const env = makeEnv(pondWorld(pond), player, { inView: () => seen.value });
    const z = putZone(fauna, 0, 0, { fish: 6 }, { ws: [[15, 10]], wk: [6] }, [fishRec('f', 15, 10), fishRec('m', 16, 10)]);
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(2);
    seen.value = true;
    env.t = 0.2; // a few game hours: births in the live zone
    fauna.update(SCAN_S, env);
    expect(fauna.counts.young).toBeGreaterThan(0);
    expect(animals.list.length).toBe(2); // none appeared in sight
    expect(z.list.filter((r) => r.kind === 'fish').length).toBe(fauna.counts.young);
    seen.value = false;
    fauna.update(SCAN_S, env);
    expect(animals.list.length).toBe(2 + fauna.counts.young);
  });

  it('a darting fish in a narrow, crooked stream never leaves the water, even over long frames', () => {
    // a one-column-wide stream that zigzags: the hex corner beside each bend is dry
    const water = new Set();
    let q = 0;
    let r = 0;
    for (let i = 0; i < 40; i++) {
      water.add(`${q},${r}`);
      if (i % 2 === 0) q++;
      else r++;
    }
    const gb = pondWorld(water);
    const animals = new Animals(seededRng(21));
    const [x0, z0] = hexToWorld(0, 0);
    const y0 = fishDepth(gb, 0, 0, GROUND - 0.5);
    const fish = [animals.spawn('fish', x0, y0, z0), animals.spawn('fish', ...[hexToWorld(5, 5)].flatMap(([x, z]) => [x, y0, z]))];
    const player = standing(...hexToWorld(3, 3));
    const env = { getBlock: gb, isLoaded: () => true, player, heldKey: null };
    let despawned = 0;
    for (let i = 0; i < 2000; i++) {
      const p = i % 50 < 5 ? player : null; // the player comes and goes: the school darts at FISH_DART
      despawned += animals.update(i % 7 === 0 ? 0.25 : 1 / 30, { ...env, player: p }).despawned;
      for (const a of animals.list) {
        expect(water.has(worldToHex(a.x, a.z).join(','))).toBe(true);
      }
    }
    expect(FISH_DART).toBeGreaterThan(5);
    expect(despawned).toBe(0);
    expect(animals.list.length).toBe(fish.length);
  });

  it('a stranded fish lies in sight and is gone only once nobody can see it', () => {
    const water = new Set(['0,0']);
    const cells = new Set(water);
    const gb = (q, y, r) => (cells.has(`${q},${r}`) && y === GROUND - 1 ? B.WATER : pondWorld(new Set())(q, y, r));
    const animals = new Animals(seededRng(31));
    const [x0, z0] = hexToWorld(0, 0);
    const a = animals.spawn('fish', x0, fishDepth(gb, 0, 0, GROUND - 0.5), z0);
    let seen = true;
    const env = { getBlock: gb, isLoaded: () => true, player: null, heldKey: null, inView: () => seen };
    cells.clear();
    for (let i = 0; i < 10; i++) expect(animals.update(0.1, env).despawned).toBe(0);
    expect(animals.list).toContain(a);
    expect(a.stranded).toBe(true);
    seen = false;
    expect(animals.update(0.1, env).despawned).toBe(1);
    expect(animals.list).not.toContain(a);
  });

  it('a fish in water drunk down to shallow holds still in it, alive', () => {
    const cells = new Map([['0,0', B.WATER]]);
    const gb = (q, y, r) => (y === GROUND - 1 && cells.has(`${q},${r}`) ? cells.get(`${q},${r}`) : pondWorld(new Set())(q, y, r));
    const animals = new Animals(seededRng(41));
    const [x0, z0] = hexToWorld(0, 0);
    const a = animals.spawn('fish', x0, fishDepth(gb, 0, 0, GROUND - 0.5), z0);
    cells.set('0,0', B.WATER_SHALLOW);
    for (let i = 0; i < 20; i++) expect(animals.update(0.1, { getBlock: gb, isLoaded: () => true, player: null }).despawned).toBe(0);
    expect(animals.list).toContain(a);
    expect(a.stranded).toBe(false);
    expect(a.y).toBeLessThan(GROUND - 1 + 0.2);
  });

  it('ZONE_SIZE stays what the bodies were measured in', () => {
    expect(ZONE_SIZE).toBe(64);
  });

  it("main's inView (pointInView): in front of the camera, on screen (a little past its edge) and within VIEW_SEEN_DIST", () => {
    const cam = new THREE.PerspectiveCamera(70, 16 / 10, 0.05, 500);
    cam.position.set(0, 1.6, 0);
    cam.lookAt(0, 1.6, -10); // looking down −z
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    expect(pointInView(cam, 0, 1, -10)).toBe(true);
    expect(pointInView(cam, 0, 1, 10)).toBe(false); // behind
    expect(pointInView(cam, 30, 1, -2)).toBe(false); // far off to the side
    expect(pointInView(cam, 0, 1, -(VIEW_SEEN_DIST + 5))).toBe(false); // too far to make out a fish
    expect(pointInView(null, 0, 0, 0)).toBe(false);
  });
});

describe('§100 fish — each fish counts in the water it is in, and every water is stocked', () => {
  /** A stream down q = 5 (the zone's whole length) and a seven-column pond round (9, 3), near the stream's north end. */
  const streamAndPond = () => {
    const pond = pondCols(9, 3);
    return { pond, gen: fakeGen({ stream: (q) => q === 5, pond: (q, r) => pond.has(`${q},${r}`) }) };
  };
  const LIFE = { youth: { fish: 1 }, rest: { fish: 0 }, rate: { fish: 2 } };

  it('zoneLand maps every column to its body: a pair at the far end of a stream, nearer the pond\'s middle, is the stream\'s and breeds', () => {
    const { gen } = streamAndPond();
    const land = zoneLand(gen, 0, 0);
    expect(land.ws).toEqual([[5, 31], [9, 3]]);
    expect(land.wk).toEqual([5, 1]);
    expect(land.wb[5 * ZONE_SIZE + 1]).toBe(0);
    expect(land.wb[9 * ZONE_SIZE + 3]).toBe(1);
    expect(land.wb[20 * ZONE_SIZE + 20]).toBe(-1);
    const fauna = new Fauna({ rng: seededRng(7), life: LIFE });
    const z = putZone(fauna, 0, 0, { fish: 6 }, { ...land, K: { fish: 6 } }, [fishRec('f', 5, 1), fishRec('m', 5, 2)]);
    // (5, 1) is nearer the pond's middle (9, 3) than the stream's (5, 31), and it is the stream's all the same
    expect(fauna._bodyAt(z, ...hexToWorld(5, 1))).toBe(0);
    // on the bank beside it, where a young one may be born: the stream's too, not the pond's
    expect(fauna._bodyAt(z, ...hexToWorld(6, 0))).toBe(0);
    expect(fauna._bodies(z, z.list).room).toEqual([3, 1]);
    fauna.step(120, makeEnv(pondWorld(new Set()), null));
    const fish = z.list.filter((r) => r.kind === 'fish');
    expect(fish.length).toBeGreaterThan(2); // they bred
    expect(fish.length).toBeLessThanOrEqual(5); // and filled the stream no further than it holds
    expect(fish.every((r) => fauna._bodyAt(z, r.x, r.z) === 0)).toBe(true); // every one of them in the stream
  });

  it('the column map is not saved: a land read from a save has it worked out again from the generator', () => {
    const { gen } = streamAndPond();
    const env = makeEnv(pondWorld(new Set()), null, { gen });
    const a = new Fauna({ rng: seededRng(1) });
    a.zone(0, 0, true, env);
    const saved = JSON.parse(JSON.stringify(a.export()));
    expect(saved.z[0].wb).toBeUndefined();
    const b = new Fauna({ rng: seededRng(2) });
    b.load(saved);
    const z = b.zones.get('0,0');
    expect(z.land.wb).toBeUndefined();
    b.zone(0, 0, true, env);
    expect(z.land.wb).toEqual(zoneLand(gen, 0, 0).wb);
    // a generator whose waters are not the saved ones: no map (the nearest body, as before)
    const c = new Fauna({ rng: seededRng(3) });
    c.load(saved);
    c.zone(0, 0, true, makeEnv(pondWorld(new Set()), null, { gen: fakeGen({ stream: (q) => q === 7 }) }));
    expect(c.zones.get('0,0').land.wb).toBe(null);
  });

  it('an empty pond beside a stream that breeds is stocked by a wanderer from a neighbour', () => {
    const fauna = new Fauna({ rng: seededRng(13) });
    // zone (0, 0): a stream full with both sexes (5 of 5) and a pond (1) with no fish
    const z = putZone(fauna, 0, 0, { fish: 6 }, { ws: [[40, 32], [10, 10]], wk: [5, 1] },
      [0, 1, 2, 3, 4].map((i) => fishRec(i % 2 ? 'm' : 'f', 40, 30 + i)));
    // zone (1, 0): a stream of dormant fish that can send one
    putZone(fauna, 1, 0, { fish: 5 }, { ws: [[104, 32]], wk: [5] }, [0, 1, 2, 3, 4].map((i) => fishRec(i % 2 ? 'm' : 'f', 104, 30 + i)));
    const inBody = (bi) => z.list.filter((r) => r.kind === 'fish' && fauna._bodyAt(z, r.x, r.z) === bi).length;
    expect(inBody(1)).toBe(0);
    fauna.step(60, makeEnv(pondWorld(new Set()), null));
    expect(inBody(1)).toBe(1); // the pond has its fish
    expect(inBody(0)).toBe(5); // and the stream no more than it holds
    expect(fauna.counts.wanderersIn).toBe(1);
  });

  it('a wanderer goes where its sex is missing: a male to a stream of females, a female to the empty pond', () => {
    const fauna = new Fauna({ rng: seededRng(17) });
    const z = putZone(fauna, 0, 0, { fish: 6 }, { ws: [[40, 32], [10, 10]], wk: [5, 1] }, [fishRec('f', 40, 32), fishRec('f', 40, 33)]);
    const nb = putZone(fauna, 1, 0, { fish: 5 }, { ws: [[104, 32]], wk: [5] });
    const male = fishRec('m', 104, 30);
    fauna._moveTo(male, z, nb, 0, fauna._bodies(z, z.list));
    expect(fauna._bodyAt(z, male.x, male.z)).toBe(0);
    const female = fishRec('f', 104, 31);
    fauna._moveTo(female, z, nb, 0, fauna._bodies(z, z.list));
    expect(fauna._bodyAt(z, female.x, female.z)).toBe(1);
  });

  it('a stranded fish drops to the bed of a drained pond and is drawn lying on its side', () => {
    let wet = true;
    const BED = GROUND - 3; // three cells of water over stone round (0, 0): the bed's top is y = BED
    const gb = (q, y, r) => {
      if (hexLength(q, r) > 1) return pondWorld(new Set())(q, y, r);
      if (y < BED) return B.STONE;
      return y < GROUND && wet ? B.WATER : B.AIR; // drained: the cells are empty
    };
    const animals = new Animals(seededRng(51));
    const [x0, z0] = hexToWorld(0, 0);
    const a = animals.spawn('fish', x0, fishDepth(gb, 0, 0, GROUND - 0.5), z0);
    const env = { getBlock: gb, isLoaded: () => true, player: null, heldKey: null, inView: () => true };
    for (let i = 0; i < 10; i++) animals.update(0.1, env);
    expect(a.y).toBeGreaterThan(BED + 2); // swimming just under the surface
    wet = false;
    for (let i = 0; i < 20; i++) expect(animals.update(0.1, env).despawned).toBe(0);
    expect(a.stranded).toBe(true);
    expect(a.y).toBeCloseTo(BED, 6); // on the bed, not in the air where the water was
    // drawn on its side: its up turned flat, its trunk on the bed
    const r = createAnimalRenderer(new THREE.Scene());
    const body = r.group.children.find((m) => m.name === 'fish-body');
    const M = new THREE.Matrix4();
    const up = () => {
      body.getMatrixAt(0, M);
      return new THREE.Vector3(0, 1, 0).transformDirection(M);
    };
    // the fish's own geometry (its trunk and fins, one part: §69.1), placed as drawn
    const lowest = () => {
      body.getMatrixAt(0, M);
      const pos = body.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      let lo = Infinity;
      for (let i = 0; i < pos.count; i++) lo = Math.min(lo, v.fromBufferAttribute(pos, i).applyMatrix4(M).y);
      return lo;
    };
    const spine = () => {
      body.getMatrixAt(0, M);
      return new THREE.Vector3(0, MODELS.fish.lie.mid, 0).applyMatrix4(M).y;
    };
    r.sync([a]);
    expect(Math.abs(up().y)).toBeLessThan(1e-6);
    expect(lowest() - a.y).toBeGreaterThan(-0.05); // a fin at most a little in the mud
    expect(lowest() - a.y).toBeLessThan(0.05);
    // its trunk on the bed: the spine about the trunk's half width above it
    expect(spine() - a.y).toBeGreaterThan(0.04);
    expect(spine() - a.y).toBeLessThan(0.1);
    r.sync([{ ...a, stranded: false }]);
    expect(up().y).toBeCloseTo(1, 6); // swimming, upright
    r.dispose();
  });
});
