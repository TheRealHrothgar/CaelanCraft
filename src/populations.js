// Caelancraft — animals that live in the world (PURE; CONTRACTS §88): every animal persists, populations live in zones of
// 64 × 64 cells, and they grow on the logistic curve through real births.
//
//   - LIVE and DORMANT. An animal within LIVE_RADIUS of the player in a loaded chunk is a body in `animals.list` (or
//     `pigs.list`) with its AI and physics, at most LIVE_MAX of them, the nearest first. Beyond SLEEP_RADIUS, or in an
//     unloaded chunk, it becomes a plain record in its zone's `list`: a point that does not move and costs nothing per
//     frame. It wakes where it was, in the state it was.
//   - ZONES. A zone is a 64 × 64 square of (q, r) cells. When it is first needed its carrying capacity K per kind is worked
//     out once from the world generator (the biome mix, the grazing, fresh water in or beside it) and it is seeded with
//     SEED_SHARE of K, half of each sex, in one to three groups. Seeding is a function of the seed and the zone.
//   - BIRTHS. An adult female who is not resting, with a male of her kind within MATE_RANGE and food and water within
//     FEED_RANGE, gives birth at BIRTH_RATE × (1 − N / K) a game day: the logistic S-curve. Births are a thinned Poisson
//     process run event by event (`_advanceKind`): live zones every game hour, a dormant zone when it wakes, over the
//     time it slept (at most CATCH_UP_DAYS). Both use the same code, so a zone grows the same awake or asleep.
//   - WANDERERS. A zone that lacks a male or a female of a kind it can hold receives one now and then from a neighbour
//     with at least WANDER_SOURCE_MIN of that kind; a zone over its K sends its surplus out to neighbours with room.
//   - LIVESTOCK. Tame cattle, sheep and pigs (and horses and wolves) breed by the same rule against TAME_CAP instead of the
//     wild K: their keeper's food and water stand in for the land's. Young of a tame mother are born tame.
import { ANIMAL_KINDS, ANIMAL_MAX, SPECIES, HERD_WEIGHTS, validateAnimalsJSON } from './animals.js';
import { seededRng } from './pigs.js';
import { BLOCK, BIOME, BIOME_NAMES, isPlant, isFarmBlock, isWater, isTaintedWater, isSolid } from './blocks.js';
import { hexToWorld, worldToHex, hexLength, HEX_ROW_SPACING } from './hex.js';
import { floorDiv } from './coords.js';
import { hash2 } from './noise.js';
import { isSaltyBiome } from './climate.js';
import { isFreeAt, findStandingY } from './physics.js';
import { DAY_LENGTH_SECONDS, SEA_LEVEL, PIG_RADIUS, PIG_HEIGHT, PIG_MAX, PIG_HEALTH, WORLD_HEIGHT } from './config.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/** Every kind that lives in a zone: the Animals kinds and the pig (its own body, CONTRACTS §30). */
export const FAUNA_KINDS = Object.freeze([...ANIMAL_KINDS, 'pig']);
/** @typedef {import('./animals.js').AnimalKind|'pig'} FaunaKind */

/** A zone is ZONE_SIZE × ZONE_SIZE cells of (q, r). */
export const ZONE_SIZE = 64;
/** Animals within LIVE_RADIUS (m) of the player in loaded chunks are live, at most LIVE_MAX (pigs included); beyond
 * SLEEP_RADIUS (the hysteresis), or in an unloaded chunk, one goes dormant. */
export const LIVE_RADIUS = 72;
export const SLEEP_RADIUS = 88;
export const LIVE_MAX = 64;
/** A dormant animal nearer than the farthest live one by this much (m) takes its place when the live list is full. */
export const SWAP_MARGIN = 8;
/** The live and dormant lists are sorted out every SCAN_S (real seconds); live zones breed every STEP_DAYS (a game hour). */
export const SCAN_S = 0.5;
export const STEP_DAYS = 1 / 24;
/** A female breeds with a male of her kind within MATE_RANGE (m), food and water within FEED_RANGE cells. */
export const MATE_RANGE = 12;
export const FEED_RANGE = 12;
/** A feed by hand counts as food for FED_DAYS game days. */
export const FED_DAYS = 1;
/** A newborn is YOUNG_SCALE of adult size and grows to full size over its kind's YOUTH_DAYS game days. */
export const YOUNG_SCALE = 0.55;
export const YOUTH_DAYS = Object.freeze({
  rabbit: 1, pheasant: 2, turkey: 2, fish: 2, pig: 2, sheep: 3, deer: 3, cow: 4, wolf: 4, horse: 5, bear: 8,
});
/** After a birth a mother rests (cannot breed) REST_DAYS game days: about the time her young take to grow up. */
export const REST_DAYS = YOUTH_DAYS;
/** Births a game day of an able female when her zone is empty (× (1 − N / K)). */
export const BIRTH_RATE = Object.freeze({
  rabbit: 0.5, fish: 0.4, pheasant: 0.3, turkey: 0.3, pig: 0.2, sheep: 0.15, cow: 0.12, deer: 0.12, horse: 0.08, wolf: 0.1, bear: 0.03,
});
/** Young at a birth [min, max]; a kind not listed has one. */
export const LITTER = Object.freeze({
  rabbit: Object.freeze([2, 4]), pig: Object.freeze([2, 4]), wolf: Object.freeze([1, 3]), fish: Object.freeze([2, 4]),
});
/** Carrying capacity of a zone wholly of the kind's best land, with fresh water (fish: FISH_CELLS). */
export const BASE_K = Object.freeze({
  rabbit: 12, deer: 8, sheep: 8, pheasant: 6, turkey: 6, cow: 6, pig: 6, horse: 4, wolf: 3, bear: 1,
});
/** Fish: one for every FISH_CELLS fresh water columns of the zone, at most FISH_K_MAX. */
export const FISH_CELLS = 8;
export const FISH_K_MAX = 10;
/** A zone without fresh water in or beside it (within WATER_BESIDE cells of its edge) holds DRY_WATER of its K. */
export const DRY_WATER = 0.35;
export const WATER_BESIDE = 8;
/** A new zone starts with SEED_SHARE of K. */
export const SEED_SHARE = 0.6;
/** One wanderer a WANDER_DAYS per neighbour with at least WANDER_SOURCE_MIN of the kind; the surplus leaves as slowly. */
export const WANDER_DAYS = 6;
export const WANDER_SOURCE_MIN = 4;
/** A waking zone catches up at most CATCH_UP_DAYS of births and wanderers. */
export const CATCH_UP_DAYS = 120;
/** Tame herds breed against this cap per kind and zone instead of the wild K (the keeper feeds them). */
export const TAME_CAP = Object.freeze({ cow: 8, sheep: 10, pig: 10, horse: 6, wolf: 4 });
/** What the predators live on: their K is their full K × how full these are in the zone. */
export const PREY = Object.freeze({
  wolf: Object.freeze(['deer', 'rabbit', 'sheep', 'pheasant', 'turkey', 'pig']),
  bear: Object.freeze(['deer', 'rabbit', 'sheep', 'pig', 'fish']),
});
/** Pigs have no HERD_WEIGHTS row (they never came in herds): wild pigs root in the woods and on the plains. */
export const PIG_LANDS = Object.freeze({ [BIOME.FOREST]: 2, [BIOME.PLAINS]: 1 });
/** In memory and in a save: at most ZONE_MAX zones (the farthest without tame animals is forgotten first) and
 * ZONE_ANIMALS_MAX animals in a zone. */
export const ZONE_MAX = 256;
export const ZONE_ANIMALS_MAX = 200;
/** Zones within PRECREATE_RADIUS (m) of the player are made ahead of need, one a scan. */
export const PRECREATE_RADIUS = SLEEP_RADIUS + ZONE_SIZE;
/** The order kinds are advanced in: prey before the predators, whose K depends on them. */
const KIND_ORDER = Object.freeze(FAUNA_KINDS.filter((k) => !PREY[k]).concat(Object.keys(PREY)));
/** A spawned or adopted animal with no age of its own is this many game days old (a grown animal of every kind). */
export const ADULT_AGE = 100;

/** The names a field guide uses: [female, male, young]. */
export const NAMES = Object.freeze({
  cow: Object.freeze(['Cow', 'Bull', 'Calf']),
  sheep: Object.freeze(['Ewe', 'Ram', 'Lamb']),
  pig: Object.freeze(['Sow', 'Boar', 'Piglet']),
  horse: Object.freeze(['Mare', 'Stallion', 'Foal']),
  deer: Object.freeze(['Doe', 'Stag', 'Fawn']),
  pheasant: Object.freeze(['Hen Pheasant', 'Cock Pheasant', 'Chick']),
  turkey: Object.freeze(['Hen Turkey', 'Tom Turkey', 'Poult']),
  wolf: Object.freeze(['Wolf (she-wolf)', 'Wolf', 'Pup']),
  rabbit: Object.freeze(['Rabbit (doe)', 'Rabbit (buck)', 'Kit']),
  bear: Object.freeze(['Bear', 'Bear', 'Cub']),
  fish: Object.freeze(['Fish', 'Fish', 'Fry']),
});

const GRAZERS = Object.freeze(FAUNA_KINDS.filter((k) => !PREY[k] && k !== 'fish'));

// ---- small helpers ---------------------------------------------------------------------------------------------------

/** @returns {[number, number]} the zone of cell (q, r) */
export function zoneOf(q, r) {
  return [floorDiv(q, ZONE_SIZE), floorDiv(r, ZONE_SIZE)];
}

/** @returns {string} the key of zone (zq, zr) */
export function zoneKey(zq, zr) {
  return `${zq},${zr}`;
}

/** @param {*} kind @returns {kind is FaunaKind} */
export function isFaunaKind(kind) {
  return typeof kind === 'string' && FAUNA_KINDS.includes(kind);
}

/** The kind of a live body or a record (a pig's body says 'pig'). @returns {FaunaKind} */
function kindOf(b) {
  return b.kind ?? 'pig';
}

/** The zone of a world position. @returns {[number, number]} */
function zoneAt(x, z) {
  const [q, r] = worldToHex(x, z);
  return zoneOf(q, r);
}

/**
 * How well a land suits a kind: its HERD_WEIGHTS weight there over its best weight anywhere (pigs: PIG_LANDS), 0..1.
 * A kind the land never had is 0; fish are not of a land (0).
 */
export function suitability(kind, biome) {
  if (kind === 'pig') return (PIG_LANDS[biome] ?? 0) / 2;
  const best = BEST_WEIGHT[kind];
  if (!best) return 0;
  const w = /** @type {Record<string, number>|undefined} */ (HERD_WEIGHTS[biome]);
  return w && w[kind] ? w[kind] / best : 0;
}
/** each kind's largest HERD_WEIGHTS weight */
const BEST_WEIGHT = /** @type {Record<string, number>} */ ({});
for (const row of Object.values(HERD_WEIGHTS)) {
  for (const [k, w] of Object.entries(row)) BEST_WEIGHT[k] = Math.max(BEST_WEIGHT[k] ?? 0, w);
}

/** What grazing a generated surface of this biome gives: grass 1, snowy grass 0.5, nothing else. */
function grazingOf(biome, height) {
  if (height < SEA_LEVEL) return 0;
  if (biome === BIOME.PLAINS || biome === BIOME.FOREST) return 1;
  if (biome === BIOME.SNOWY) return 0.5;
  return 0;
}

/**
 * Size of a young animal: YOUNG_SCALE at birth, growing evenly to 1 at its kind's YOUTH_DAYS.
 * @param {string} kind @param {number} age game days @param {Readonly<Record<string, number>>} [youth] @returns {number}
 */
export function growthScale(kind, age, youth = YOUTH_DAYS) {
  const y = youth[kind] ?? 1;
  if (!(age < y)) return 1;
  return YOUNG_SCALE + (1 - YOUNG_SCALE) * Math.max(0, age) / y;
}

/** A body or record that has not grown up (its `size` below 1). */
export function isYoung(b) {
  return typeof b.size === 'number' && b.size < 1;
}

/** The field-guide name of a kind by sex and age (NAMES). */
export function nameOf(kind, sex, young) {
  const n = NAMES[kind];
  if (!n) return String(kind);
  return young ? n[2] : sex === 'm' ? n[1] : n[0];
}

/** The name of a live animal or pig: "Bull", "Ewe", "Piglet". */
export function animalName(b) {
  return nameOf(kindOf(b), b.sex, isYoung(b));
}

/** What a young animal gives: half (rounded up) of every stack it would give grown. */
export function youngDrops(b, drops) {
  if (!isYoung(b)) return drops;
  return drops.map((s) => ({ ...s, n: Math.ceil(s.n / 2) }));
}

/** Young at a birth of `kind`. */
export function litterSize(kind, rng) {
  const l = LITTER[kind];
  if (!l) return 1;
  return l[0] + Math.floor(rng() * (l[1] - l[0] + 1));
}

/** Distance (m) from world point (x, z) to segment a→b. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((x - ax) * dx + (z - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** World distance (m) from (x, z) to zone (zq, zr): 0 inside it, else to its nearest edge (a parallelogram in world space). */
export function zoneDistance(zq, zr, x, z) {
  const q0 = zq * ZONE_SIZE - 0.5;
  const r0 = zr * ZONE_SIZE - 0.5;
  const q1 = q0 + ZONE_SIZE;
  const r1 = r0 + ZONE_SIZE;
  const rf = z / HEX_ROW_SPACING;
  const qf = x - rf * 0.5;
  if (qf >= q0 && qf <= q1 && rf >= r0 && rf <= r1) return 0;
  const [ax, az] = hexToWorld(q0, r0);
  const [bx, bz] = hexToWorld(q1, r0);
  const [cx, cz] = hexToWorld(q1, r1);
  const [dx, dz] = hexToWorld(q0, r1);
  return Math.min(segDist(x, z, ax, az, bx, bz), segDist(x, z, bx, bz, cx, cz), segDist(x, z, cx, cz, dx, dz), segDist(x, z, dx, dz, ax, az));
}

// ---- carrying capacity -------------------------------------------------------------------------------------------

/**
 * A world generator as far as zones need it (worldgen.createWorldGen; only `getColumn` is required).
 * @typedef {{ getColumn: (q: number, r: number) => { height: number, biome: number },
 *   streamAt?: (q: number, r: number) => boolean, pondAt?: (q: number, r: number) => boolean,
 *   pondTaintedAt?: (q: number, r: number) => boolean,
 *   naturalSpringOf?: (kq: number, kr: number) => ({ q: number, r: number }|null) }} FaunaGen
 */

/**
 * The cached land of a zone. `K` the carrying capacity per kind (the predators' at full prey), `g` the share of its
 * columns that graze (0..1), `w` its water factor (1 or DRY_WATER), `c` its fresh water columns (estimated), `ws` up to
 * six fresh water columns [q, r] (where its fish live), `mix` the share of each land.
 * @typedef {{ K: Record<string, number>, g: number, w: number, c: number, ws: [number, number][], mix: Record<string, number> }} ZoneLand
 */

/** Sample columns: SAMPLE_STEP apart, SAMPLE_STEP / 2 in from the zone's corner (16 × 16 of them). */
const SAMPLE_STEP = 4;

/**
 * Work out a zone's land from the generator: K per kind = BASE_K × biomeShare × foodFactor × waterFactor, rounded.
 * biomeShare is the mean `suitability` over 256 sampled columns; foodFactor (grazers) the share of the sampled columns of
 * a suitable land that graze (grass 1, snowy grass ½, under water 0); for wolves and the bear it is 1 here (their K is
 * scaled by their prey when it is used); waterFactor 1 with fresh water — a stream, an untainted pond or a spring — in
 * the zone or within WATER_BESIDE cells of it, else DRY_WATER. Fish: one per FISH_CELLS fresh water columns in the zone,
 * at most FISH_K_MAX. Streams are read on every column, ponds on every other (a pond is seven columns: every one of them
 * holds a point of that lattice), springs from their grid. Deterministic.
 * @param {FaunaGen|null|undefined} gen @param {number} zq @param {number} zr @returns {ZoneLand}
 */
export function zoneLand(gen, zq, zr) {
  /** @type {ZoneLand} */
  const land = { K: {}, g: 0, w: DRY_WATER, c: 0, ws: [], mix: {} };
  if (!gen || typeof gen.getColumn !== 'function') return land;
  const q0 = zq * ZONE_SIZE;
  const r0 = zr * ZONE_SIZE;
  const n = ZONE_SIZE / SAMPLE_STEP;
  const S = n * n;
  /** @type {Record<string, number>} */
  const suit = {};
  /** @type {Record<string, number>} */
  const suitN = {};
  /** @type {Record<string, number>} */
  const graze = {};
  let grazeAll = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const col = gen.getColumn(q0 + SAMPLE_STEP / 2 + SAMPLE_STEP * i, r0 + SAMPLE_STEP / 2 + SAMPLE_STEP * j);
      const name = BIOME_NAMES[col.biome] ?? 'unknown';
      land.mix[name] = (land.mix[name] ?? 0) + 1 / S;
      const gz = grazingOf(col.biome, col.height);
      grazeAll += gz;
      for (const k of GRAZERS.concat(Object.keys(PREY))) {
        const s = suitability(k, col.biome);
        if (!(s > 0)) continue;
        suit[k] = (suit[k] ?? 0) + s;
        suitN[k] = (suitN[k] ?? 0) + 1;
        graze[k] = (graze[k] ?? 0) + gz;
      }
    }
  }
  for (const name of Object.keys(land.mix)) land.mix[name] = Math.round(land.mix[name] * 1000) / 1000;
  land.g = Math.round((grazeAll / S) * 1000) / 1000;
  // Fresh water in the zone (counted) and beside it (only whether there is any).
  let wet = 0;
  let near = false;
  /** @type {[number, number][]} */
  const spots = [];
  const B = WATER_BESIDE;
  const inZone = (q, r) => q >= q0 && q < q0 + ZONE_SIZE && r >= r0 && r < r0 + ZONE_SIZE;
  if (typeof gen.streamAt === 'function') {
    for (let q = q0 - B; q < q0 + ZONE_SIZE + B; q++) {
      for (let r = r0 - B; r < r0 + ZONE_SIZE + B; r++) {
        if (!gen.streamAt(q, r)) continue;
        near = true;
        if (inZone(q, r)) {
          wet++;
          if ((wet & 7) === 1) spots.push([q, r]);
        }
      }
    }
  }
  if (typeof gen.pondAt === 'function') {
    for (let q = q0 - B; q < q0 + ZONE_SIZE + B; q += 2) {
      for (let r = r0 - B; r < r0 + ZONE_SIZE + B; r += 2) {
        if (!gen.pondAt(q, r) || (typeof gen.pondTaintedAt === 'function' && gen.pondTaintedAt(q, r))) continue;
        near = true;
        if (inZone(q, r)) {
          wet += 4; // a point of the lattice stands for four columns
          spots.push([q, r]);
        }
      }
    }
  }
  if (typeof gen.naturalSpringOf === 'function') {
    for (let kq = zq - 1; kq <= zq + 1; kq++) {
      for (let kr = zr - 1; kr <= zr + 1; kr++) {
        const sp = gen.naturalSpringOf(kq, kr);
        if (!sp) continue;
        if (sp.q >= q0 - B && sp.q < q0 + ZONE_SIZE + B && sp.r >= r0 - B && sp.r < r0 + ZONE_SIZE + B) near = true;
      }
    }
  }
  land.w = near ? 1 : DRY_WATER;
  land.c = wet;
  // up to six spots, spread along what was found
  const step = Math.max(1, Math.ceil(spots.length / 6));
  for (let i = 0; i < spots.length && land.ws.length < 6; i += step) land.ws.push(spots[i]);
  for (const k of GRAZERS) {
    if (!suitN[k]) continue;
    const biomeShare = suit[k] / S;
    const food = graze[k] / suitN[k];
    const K = Math.round(BASE_K[k] * biomeShare * food * land.w);
    if (K > 0) land.K[k] = K;
  }
  for (const k of Object.keys(PREY)) {
    if (!suitN[k]) continue;
    const K = Math.round(BASE_K[k] * (suit[k] / S) * land.w);
    if (K > 0) land.K[k] = K;
  }
  const fish = Math.min(FISH_K_MAX, Math.round(wet / FISH_CELLS));
  if (fish > 0 && land.ws.length > 0) land.K.fish = fish;
  return land;
}

// ---- records ---------------------------------------------------------------------------------------------------

/**
 * A dormant animal: a point in its zone. `placed` false: only its column is known (x, z its centre); a height is found
 * when it wakes. Times are game days (`born`, `restUntil`, `fedAt`, `slept` when it went to sleep, `since` when it came
 * into this zone); `shorn`, `milked` and `trapped` are seconds left when it went to sleep. `habBits` what it had within
 * FEED_RANGE when last seen (1 food, 2 water; −1 not known): a tame one keeps breeding on it while you are away.
 * @typedef {{ kind: FaunaKind, sex: 'f'|'m', born: number, x: number, y: number, z: number, yaw: number, placed: boolean,
 *   health: number, tamed: boolean, trust: number, homeX: number, homeZ: number, shorn: number, milked: number,
 *   sitting: boolean, trapped: number, trapCell: [number, number, number]|null, restUntil: number, fedAt: number,
 *   habBits: number, slept: number, since: number, rec: true }} FaunaRecord
 */

/**
 * A zone in memory. `land` null until it is first needed (its K is then worked out); `seeded` once its first animals
 * are in (seeded as of `t0`, the game day it was made); `touched` once anything has changed it since (an untouched zone is
 * saved without its animals: loading seeds it again, the same way). `t` the game day it was last brought up to.
 * @typedef {{ key: string, zq: number, zr: number, t: number, t0: number, land: ZoneLand|null, seeded: boolean,
 *   touched: boolean, list: FaunaRecord[] }} Zone
 */

/** Max health of a kind. */
function maxHealth(kind) {
  return kind === 'pig' ? PIG_HEALTH : SPECIES[kind].health;
}

/** A fresh record of `kind` at (x, y, z). @returns {FaunaRecord} */
export function makeRecord(kind, sex, born, x, y, z, placed, now) {
  return {
    kind, sex, born, x, y, z, yaw: 0, placed, health: maxHealth(kind), tamed: false, trust: 0, homeX: x, homeZ: z,
    shorn: 0, milked: 0, sitting: false, trapped: 0, trapCell: null, restUntil: -Infinity, fedAt: -Infinity, habBits: -1,
    slept: now, since: now, rec: true,
  };
}

/**
 * Seed a zone's first animals: round(K × SEED_SHARE) of each kind (none of a kind with K 0), about half of each sex (at
 * least one of each when there are two or more), in one to three groups around columns of a land that suits the kind
 * and grazes (fish: around its water). Positions are columns only (`placed` false). A quarter are young. Deterministic
 * from `seed` and the zone.
 * @param {Zone} zone @param {FaunaGen|null|undefined} gen @param {number} seed @param {number} now
 * @param {Readonly<Record<string, number>>} [youth]
 * @returns {FaunaRecord[]} the records added to zone.list
 */
export function seedZone(zone, gen, seed, now, youth = YOUTH_DAYS) {
  const land = zone.land;
  /** @type {FaunaRecord[]} */
  const out = [];
  if (!land) return out;
  const q0 = zone.zq * ZONE_SIZE;
  const r0 = zone.zr * ZONE_SIZE;
  FAUNA_KINDS.forEach((kind, ki) => {
    const K = land.K[kind] ?? 0;
    const n = Math.round(K * SEED_SHARE);
    if (n <= 0) return;
    const rng = seededRng(hash2(zone.zq * 37 + ki, zone.zr * 41 - ki, (seed ^ 0x5eedf0) | 0));
    // the group centres: columns that suit the kind (rejection sampling on the generator), or its water
    /** @type {[number, number][]} */
    const centres = [];
    const G = Math.max(1, Math.min(3, Math.ceil(n / 4)));
    for (let tries = 0; tries < 40 && centres.length < G; tries++) {
      if (kind === 'fish') {
        if (land.ws.length === 0) break;
        centres.push(land.ws[Math.floor(rng() * land.ws.length)]);
        continue;
      }
      const q = q0 + 6 + Math.floor(rng() * (ZONE_SIZE - 12));
      const r = r0 + 6 + Math.floor(rng() * (ZONE_SIZE - 12));
      if (!gen) break;
      const col = gen.getColumn(q, r);
      if (suitability(kind, col.biome) > 0 && grazingOf(col.biome, col.height) > 0) centres.push([q, r]);
    }
    if (centres.length === 0) return;
    // sexes: about half each, at least one of each from two up; alternating, so each group of two or more has both
    let females = n >= 2 ? Math.max(1, Math.min(n - 1, Math.round(n / 2 + (rng() - 0.5)))) : rng() < 0.5 ? 1 : 0;
    /** @type {('f'|'m')[]} */
    const sexes = [];
    for (let i = 0; i < n; i++) {
      const wantF = i % 2 === 0 ? females > 0 : females >= n - i;
      sexes.push(wantF ? 'f' : 'm');
      if (wantF) females--;
    }
    const per = Math.ceil(n / centres.length);
    const y = youth[kind] ?? 1;
    for (let i = 0; i < n; i++) {
      const [cq, cr] = centres[Math.min(centres.length - 1, Math.floor(i / per))];
      const spread = kind === 'fish' ? 1 : 4;
      const q = cq + Math.round((rng() * 2 - 1) * spread);
      const r = cr + Math.round((rng() * 2 - 1) * spread);
      const [x, z] = hexToWorld(q, r);
      const age = rng() < 0.25 ? rng() * y : y + rng() * 3 * y;
      const rec = makeRecord(kind, sexes[i], now - age, x, 0, z, false, now);
      rec.yaw = rng() * Math.PI * 2 - Math.PI;
      zone.list.push(rec);
      out.push(rec);
    }
  });
  return out;
}

// ---- the habitat round an animal --------------------------------------------------------------------------------

/** What a grazer eats: grass, any wild plant or crop, a hay bale. */
export function isGrazing(id) {
  return id === BLOCK.GRASS_BLOCK || id === BLOCK.SNOWY_GRASS || id === BLOCK.HAY_BALE || isPlant(id) || isFarmBlock(id);
}

/** What an animal drinks: fresh water (not tainted, not in a salt land's column), a welling spring, a rain barrel with water. */
export function isDrinkable(id, q, r, getBiome) {
  if (id === BLOCK.SPRING || id === BLOCK.RAIN_BARREL_1 || id === BLOCK.RAIN_BARREL_2 || id === BLOCK.RAIN_BARREL_3) return true;
  if (!isWater(id) || isTaintedWater(id)) return false;
  return !(getBiome && isSaltyBiome(getBiome(q, r)));
}

/**
 * Food (bit 1) and water (bit 2) within FEED_RANGE cells of column (q0, r0), from three cells under the feet level y0 to
 * two above. Columns not loaded are skipped. Stops as soon as it has both.
 * @param {{ getBlock: GetBlockFn, isLoadedCell?: (q: number, r: number) => boolean, getBiome?: (q: number, r: number) => number }} env
 * @returns {number}
 */
export function scanHabitat(env, q0, y0, r0, range = FEED_RANGE) {
  const getBlock = env.getBlock;
  let bits = 0;
  for (let dq = -range; dq <= range; dq++) {
    const lo = Math.max(-range, -dq - range);
    const hi = Math.min(range, -dq + range);
    for (let dr = lo; dr <= hi; dr++) {
      const q = q0 + dq;
      const r = r0 + dr;
      if (env.isLoadedCell && !env.isLoadedCell(q, r)) continue;
      for (let y = y0 - 3; y <= y0 + 2; y++) {
        if (y < 0 || y >= WORLD_HEIGHT) continue;
        const id = getBlock(q, y, r);
        if (!(bits & 1) && isGrazing(id)) bits |= 1;
        else if (!(bits & 2) && isDrinkable(id, q, r, env.getBiome)) bits |= 2;
        if (bits === 3) return 3;
      }
    }
  }
  return bits;
}

// ---- the store -----------------------------------------------------------------------------------------------

/**
 * What the store needs from the game (main: the animals' world view, with the clock and the generator).
 * @typedef {Object} FaunaWorld
 * @property {() => number} now                     the world clock in game days (weather.worldSeconds / DAY_LENGTH_SECONDS)
 * @property {PlayerState|null} [player]            the zones round the player are live (null: nothing changes)
 * @property {GetBlockFn} getBlock
 * @property {(q: number, r: number) => boolean} isLoadedCell
 * @property {(q: number, r: number) => number} [groundHeight]     the generated height of a loaded column
 * @property {(q: number, y: number, r: number) => boolean} [isNaturalGround]
 * @property {(q: number, r: number) => number} [getBiome]
 * @property {FaunaGen|null} [gen]                  the world generator (a zone's K)
 * @property {number} [seed]                        the world seed (a zone's seeding)
 */

/**
 * The life tables a store runs on (tests may pass their own).
 * @typedef {{ youth: Readonly<Record<string, number>>, rest: Readonly<Record<string, number>>,
 *   rate: Readonly<Record<string, number>> }} LifeTables
 */

/** @type {LifeTables} */
const DEFAULT_LIFE = Object.freeze({ youth: YOUTH_DAYS, rest: REST_DAYS, rate: BIRTH_RATE });

/** What happened in a step (for the debug handle and the tests). */
function emptyCounts() {
  return { births: 0, young: 0, wanderersIn: 0, wanderedOut: 0, woke: 0, slept: 0, zonesMade: 0 };
}

export class Fauna {
  /**
   * @param {{ animals?: import('./animals.js').Animals|null, pigs?: import('./pigs.js').Pigs|null, rng?: () => number,
   *   life?: Partial<LifeTables> }} [opts]
   */
  constructor(opts = {}) {
    this.animals = opts.animals ?? null;
    this.pigs = opts.pigs ?? null;
    this._rng = opts.rng ?? Math.random;
    /** @type {LifeTables} */
    this.life = { ...DEFAULT_LIFE, ...(opts.life ?? {}) };
    /** @type {Map<string, Zone>} */
    this.zones = new Map();
    /** the world clock (game days) at the last update */
    this.now = 0;
    this.seed = 0;
    /** @type {FaunaWorld|null} */
    this._env = null;
    this._scanIn = 0;
    this._stepAt = NaN;
    /** @type {Set<string>} the zones within SLEEP_RADIUS at the last scan */
    this._active = new Set();
    this.counts = emptyCounts();
    /** timings of the last scan, step and catch-up (ms) */
    this.timing = { scanMs: 0, stepMs: 0, catchUpMs: 0, catchUpDays: 0 };
  }

  /** Every live body: the animals, then the pigs. @returns {any[]} */
  liveBodies() {
    const out = [];
    if (this.animals) for (const a of this.animals.list) out.push(a);
    if (this.pigs) for (const p of this.pigs.list) out.push(p);
    return out;
  }

  get liveCount() {
    return (this.animals ? this.animals.list.length : 0) + (this.pigs ? this.pigs.list.length : 0);
  }

  /** How many dormant records in all. */
  get dormantCount() {
    let n = 0;
    for (const z of this.zones.values()) n += z.list.length;
    return n;
  }

  /** Forget every zone (the live lists are left alone). */
  clear() {
    this.zones.clear();
    this._active.clear();
    this._scanIn = 0;
    this._stepAt = NaN;
    this.counts = emptyCounts();
  }

  /** Set the clock on the store and the two live lists (feeding stamps `fedAt` with it). */
  _setNow(now) {
    this.now = now;
    if (this.animals) this.animals.now = now;
    if (this.pigs) this.pigs.now = now;
  }

  /**
   * One frame: every SCAN_S the live and dormant animals are sorted out round the player; every STEP_DAYS of game time
   * the live zones breed. Costs a timer check on other frames.
   * @param {number} dt @param {FaunaWorld} env
   */
  update(dt, env) {
    this._env = env;
    if (typeof env.seed === 'number') this.seed = env.seed;
    const now = env.now();
    if (!Number.isFinite(now)) return;
    this._setNow(now);
    this._scanIn -= dt;
    if (this._scanIn <= 0) {
      this._scanIn = SCAN_S;
      const t0 = performance.now();
      this.scan(env);
      this.timing.scanMs = performance.now() - t0;
    }
    if (!(now - this._stepAt < STEP_DAYS) || now < this._stepAt) {
      this._stepAt = now;
      const t0 = performance.now();
      const ctx = this._ctx(env);
      for (const key of this._active) {
        const z = this.zones.get(key);
        if (z) this._advance(z, z.t, now, ctx);
      }
      this.timing.stepMs = performance.now() - t0;
    }
  }

  /** Get zone (zq, zr), making it (its land worked out and its first animals seeded) when `make`. @returns {Zone|null} */
  zone(zq, zr, make = true, env = this._env) {
    const key = zoneKey(zq, zr);
    let z = this.zones.get(key) ?? null;
    if (!z) {
      if (!make) return null;
      z = { key, zq, zr, t: this.now, t0: this.now, land: null, seeded: false, touched: false, list: [] };
      this.zones.set(key, z);
    }
    if (make) this._fill(z, env);
    return z;
  }

  /** Work out a zone's land and seed it, when not done yet. */
  _fill(z, env) {
    if (!z.land) {
      if (!env || !env.gen) return;
      z.land = zoneLand(env.gen, z.zq, z.zr);
      this.counts.zonesMade++;
    }
    if (!z.seeded) {
      z.seeded = true;
      seedZone(z, env ? env.gen ?? null : null, this.seed, z.t0, this.life.youth);
      if (z.list.length > ZONE_ANIMALS_MAX) z.list.length = ZONE_ANIMALS_MAX;
    }
  }

  /** The zones within SLEEP_RADIUS of (x, z) (made when missing). @returns {Zone[]} */
  _activeZones(env, x, z) {
    const [pq, pr] = worldToHex(x, z);
    const [zq, zr] = zoneOf(pq, pr);
    /** @type {Zone[]} */
    const out = [];
    for (let dq = -2; dq <= 2; dq++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (zoneDistance(zq + dq, zr + dr, x, z) > SLEEP_RADIUS) continue;
        const zone = this.zone(zq + dq, zr + dr, true, env);
        if (zone) out.push(zone);
      }
    }
    return out;
  }

  /** The live bodies by zone key and by kind (one pass). */
  _ctx(env) {
    /** @type {Map<string, any[]>} */
    const byZone = new Map();
    /** @type {Map<string, any[]>} */
    const byKind = new Map();
    for (const b of this.liveBodies()) {
      const [zq, zr] = zoneAt(b.x, b.z);
      const key = zoneKey(zq, zr);
      let l = byZone.get(key);
      if (!l) byZone.set(key, (l = []));
      l.push(b);
      const k = kindOf(b);
      let m = byKind.get(k);
      if (!m) byKind.set(k, (m = []));
      m.push(b);
    }
    return { env, byZone, byKind };
  }

  /**
   * Sort out the live and the dormant round the player: the zones within SLEEP_RADIUS are made and caught up as they come
   * into range, live animals beyond SLEEP_RADIUS (or whose chunk went) go to sleep, dormant ones within LIVE_RADIUS in
   * loaded chunks wake (nearest first, at most LIVE_MAX), young ones grow.
   * @param {FaunaWorld} env
   */
  scan(env) {
    const p = env.player;
    if (!p) return;
    const now = this.now;
    const active = this._activeZones(env, p.x, p.z);
    // zones that come into range catch up the time they slept, before anything wakes from them
    const ctx = this._ctx(env);
    for (const z of active) {
      if (this._active.has(z.key)) continue;
      const t0 = performance.now();
      const days = now - z.t;
      this._advance(z, z.t, now, ctx);
      if (days > 0) {
        this.timing.catchUpMs = performance.now() - t0;
        this.timing.catchUpDays = Math.min(days, CATCH_UP_DAYS);
      }
    }
    this._active = new Set(active.map((z) => z.key));
    this._sleepFar(env, p);
    this._wakeNear(env, p, active);
    this._growAll(now);
    this._precreate(env, p);
    this._evict(p);
  }

  /** A body that never sleeps: the horse being ridden, a tame wolf that follows the player. */
  _keepsAwake(b) {
    return b.ridden === true || (b.kind === 'wolf' && b.tamed && !b.sitting);
  }

  _sleepFar(env, p) {
    for (const b of this.liveBodies()) {
      if (this._keepsAwake(b)) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      const [q, r] = worldToHex(b.x, b.z);
      if (d > SLEEP_RADIUS || !env.isLoadedCell(q, r)) this.sleep(b, env);
    }
  }

  /**
   * Put a live body to sleep: a record in the zone it stands in (brought up to now first), and out of its live list.
   * @returns {FaunaRecord|null}
   */
  sleep(b, env = this._env) {
    const [zq, zr] = zoneAt(b.x, b.z);
    const z = this.zone(zq, zr, true, env);
    if (!z) return null;
    if (z.t < this.now && !this._active.has(z.key)) this._advance(z, z.t, this.now, this._ctx(env));
    const rec = this.toRecord(b, env);
    if (kindOf(b) === 'pig') this.pigs?.remove(b);
    else this.animals?.detach(b);
    if (z.list.length < ZONE_ANIMALS_MAX) z.list.push(rec);
    z.touched = true;
    this.counts.slept++;
    return rec;
  }

  /** The record of a live body (it stays live). @returns {FaunaRecord} */
  toRecord(b, env = this._env) {
    const kind = kindOf(b);
    const now = this.now;
    const rec = makeRecord(kind, b.sex === 'm' ? 'm' : 'f', Number.isFinite(b.born) ? b.born : now - ADULT_AGE, b.x, b.y, b.z, true, now);
    rec.yaw = b.yaw ?? 0;
    rec.health = Number.isFinite(b.health) ? b.health : maxHealth(kind);
    rec.tamed = !!b.tamed;
    rec.trust = b.trust ?? 0;
    rec.homeX = Number.isFinite(b.homeX) ? b.homeX : b.x;
    rec.homeZ = Number.isFinite(b.homeZ) ? b.homeZ : b.z;
    rec.shorn = b.shorn > 0 ? b.shorn : 0;
    rec.milked = b.milked > 0 ? b.milked : 0;
    rec.sitting = !!b.sitting;
    if (b.trapped > 0 && b.trapCell) {
      rec.trapped = b.trapped;
      rec.trapCell = [b.trapCell[0], b.trapCell[1], b.trapCell[2]];
    }
    rec.restUntil = Number.isFinite(b.restUntil) ? b.restUntil : -Infinity;
    rec.fedAt = Number.isFinite(b.fedAt) ? b.fedAt : -Infinity;
    rec.habBits = typeof b.habBits === 'number' ? b.habBits : -1;
    // a tame one keeps what it has round it while you are away: look once more if that is old
    if (rec.tamed && env && kind !== 'fish' && !(now - (b.habAt ?? -Infinity) < 1)) {
      const [q, r] = worldToHex(b.x, b.z);
      if (env.isLoadedCell(q, r)) rec.habBits = scanHabitat(env, q, Math.floor(b.y + 0.05), r);
    }
    return rec;
  }

  _wakeNear(env, p, active) {
    /** @type {{ d: number, rec: FaunaRecord, z: Zone }[]} */
    const cands = [];
    for (const z of active) {
      for (const rec of z.list) {
        const d = Math.hypot(rec.x - p.x, rec.z - p.z);
        if (d > LIVE_RADIUS) continue;
        const [q, r] = worldToHex(rec.x, rec.z);
        if (env.isLoadedCell(q, r)) cands.push({ d, rec, z });
      }
    }
    if (cands.length === 0) return;
    cands.sort((a, b) => a.d - b.d);
    const woke = new Set();
    let swaps = 4;
    for (const c of cands) {
      if (this.liveCount >= LIVE_MAX) {
        // full: the farthest live one gives way to a nearer sleeper, a few a scan
        let far = null;
        let fd = c.d + SWAP_MARGIN;
        for (const b of this.liveBodies()) {
          if (this._keepsAwake(b)) continue;
          const d = Math.hypot(b.x - p.x, b.z - p.z);
          if (d > fd) {
            fd = d;
            far = b;
          }
        }
        if (!far || swaps-- <= 0) break;
        this.sleep(far, env);
      }
      const body = this.wake(c.rec, env);
      if (body) {
        woke.add(c.rec);
        c.z.touched = true;
      }
    }
    if (woke.size === 0) return;
    for (const z of active) if (z.list.some((r) => woke.has(r))) z.list = z.list.filter((r) => !woke.has(r));
  }

  /**
   * Wake a record: a live body where it was (a column-only record is put on the ground there first), in the state it
   * was, its timers run down by the time it slept. The record is NOT taken out of its zone (the caller does).
   * @returns {any|null} the body, or null (no room, nowhere to stand, not loaded)
   */
  wake(rec, env = this._env) {
    if (!env) return null;
    const kind = rec.kind;
    const isPig = kind === 'pig';
    if (isPig ? !this.pigs || this.pigs.list.length >= PIG_MAX : !this.animals || this.animals.list.length >= ANIMAL_MAX) return null;
    let x = rec.x;
    let y = rec.y;
    let z = rec.z;
    if (!rec.placed) {
      const spot = this._place(rec, env);
      if (!spot) return null;
      [x, y, z] = spot;
    }
    const body = isPig ? /** @type {*} */ (this.pigs).spawn(x, y, z, rec.yaw, rec.sex)
      : /** @type {*} */ (this.animals).spawn(kind, x, y, z, rec.yaw, rec.sex);
    if (!body) return null;
    const asleepS = Math.max(0, (this.now - rec.slept) * DAY_LENGTH_SECONDS);
    body.born = rec.born;
    body.restUntil = rec.restUntil;
    body.fedAt = rec.fedAt;
    body.habBits = rec.habBits;
    body.habAt = -Infinity;
    body.health = Math.min(maxHealth(kind), rec.health);
    body.tamed = rec.tamed;
    body.trust = rec.trust;
    body.homeX = rec.placed ? rec.homeX : x;
    body.homeZ = rec.placed ? rec.homeZ : z;
    if (!isPig) {
      body.shorn = Math.max(0, rec.shorn - asleepS);
      body.milked = Math.max(0, rec.milked - asleepS);
      body.sitting = rec.sitting;
      if (rec.trapped > 0 && rec.trapCell) {
        const c = rec.trapCell;
        const sprung = env.getBlock(c[0], c[1], c[2]) === BLOCK.SNARE_SPRUNG;
        const left = rec.trapped - asleepS;
        if (left > 0 && sprung) {
          body.trapped = left;
          body.trapT = 1;
          body.trapCell = [c[0], c[1], c[2]];
        } else if (sprung) {
          // it pulled free while you were away: the snare sets itself again
          /** @type {*} */ (this.animals).events.freed.push({ cell: [c[0], c[1], c[2]], escaped: true });
        }
      }
    }
    this._grow(body, this.now);
    this.counts.woke++;
    return body;
  }

  /** Where a column-only record stands: its column or one near it. @returns {[number, number, number]|null} */
  _place(rec, env) {
    const [q0, r0] = worldToHex(rec.x, rec.z);
    if (rec.kind === 'fish') {
      for (let rad = 0; rad <= 3; rad++) {
        for (const [q, r] of ring(q0, r0, rad)) {
          if (!env.isLoadedCell(q, r) || !this.animals) continue;
          const y = this.animals.fishSpotAt(/** @type {*} */ (env), q, r);
          if (!Number.isNaN(y)) {
            const [x, z] = hexToWorld(q, r);
            return [x, y, z];
          }
        }
      }
      return null;
    }
    const radius = rec.kind === 'pig' ? PIG_RADIUS : SPECIES[rec.kind].radius;
    const height = rec.kind === 'pig' ? PIG_HEIGHT : SPECIES[rec.kind].height;
    for (const strict of [true, false]) {
      for (let rad = 0; rad <= 6; rad++) {
        for (const [q, r] of ring(q0, r0, rad)) {
          const y = standAt(env, q, r, radius, height, strict);
          if (y !== null) {
            const [x, z] = hexToWorld(q, r);
            return [x, y, z];
          }
        }
      }
    }
    return null;
  }

  /** Size of every live young one by its age; a young animal's body is that much smaller. */
  _growAll(now) {
    for (const b of this.liveBodies()) this._grow(b, now);
  }

  _grow(b, now) {
    const kind = kindOf(b);
    const s = growthScale(kind, now - (Number.isFinite(b.born) ? b.born : now - ADULT_AGE), this.life.youth);
    if (b.size === s) return;
    b.size = s;
    if (kind === 'pig' || b.ridden) return; // a piglet keeps the pig's collider (pigs.js uses its constants)
    const sp = SPECIES[kind];
    b.radius = sp.radius * s;
    b.height = sp.height * s;
  }

  /** Make one missing zone within PRECREATE_RADIUS (the nearest), so the zones you walk into are ready. */
  _precreate(env, p) {
    const [pq, pr] = worldToHex(p.x, p.z);
    const [zq, zr] = zoneOf(pq, pr);
    let best = null;
    let bd = PRECREATE_RADIUS;
    for (let dq = -3; dq <= 3; dq++) {
      for (let dr = -3; dr <= 3; dr++) {
        const z = this.zones.get(zoneKey(zq + dq, zr + dr));
        if (z && z.land && z.seeded) continue;
        const d = zoneDistance(zq + dq, zr + dr, p.x, p.z);
        if (d < bd) {
          bd = d;
          best = [zq + dq, zr + dr];
        }
      }
    }
    if (best) this.zone(best[0], best[1], true, env);
  }

  /** Over ZONE_MAX: forget the farthest zone that holds no tame animal and is not in range. */
  _evict(p) {
    while (this.zones.size > ZONE_MAX) {
      let worst = null;
      let wd = -1;
      for (const z of this.zones.values()) {
        if (this._active.has(z.key) || z.list.some((r) => r.tamed)) continue;
        const d = zoneDistance(z.zq, z.zr, p.x, p.z);
        if (d > wd) {
          wd = d;
          worst = z;
        }
      }
      if (!worst) return;
      this.zones.delete(worst.key);
    }
  }

  // ---- births and wanderers ---------------------------------------------------------------------------------

  /**
   * Bring a zone from t0 to t1 (at most CATCH_UP_DAYS of it): births, wanderers in, the surplus out, kind by kind (prey
   * first: a predator's K follows its prey). Its live bodies (ctx.byZone) take part where they stand.
   * @param {Zone} z @param {number} t0 @param {number} t1 @param {ReturnType<Fauna['_ctx']>} ctx
   */
  _advance(z, t0, t1, ctx) {
    if (t1 < z.t) {
      z.t = t1; // the clock went back (a `time set`): nothing happens
      return;
    }
    if (!z.land || !(t1 > t0)) {
      z.t = Math.max(z.t, t1);
      return;
    }
    const from = Math.max(t0, t1 - CATCH_UP_DAYS);
    /** @type {Map<string, any[]>} */
    const byKind = new Map();
    for (const rec of z.list) {
      let l = byKind.get(rec.kind);
      if (!l) byKind.set(rec.kind, (l = []));
      l.push(rec);
    }
    for (const b of ctx.byZone.get(z.key) ?? []) {
      const k = kindOf(b);
      let l = byKind.get(k);
      if (!l) byKind.set(k, (l = []));
      l.push(b);
    }
    for (const kind of KIND_ORDER) {
      const members = byKind.get(kind) ?? [];
      const K = this.kOf(z, kind, byKind);
      if (members.length === 0 && K < 1) continue;
      if (!byKind.has(kind)) byKind.set(kind, members);
      this._advanceKind(z, kind, members, K, from, t1, ctx);
    }
    z.t = t1;
  }

  /**
   * The K of a kind in a zone now: the cached one, a predator's scaled by how full its prey is (wild and tame).
   * @param {Zone} z @param {string} kind @param {Map<string, any[]>} [byKind] its members by kind (else counted here)
   */
  kOf(z, kind, byKind) {
    if (!z.land) return 0;
    const K = z.land.K[kind] ?? 0;
    const prey = PREY[kind];
    if (!prey || K <= 0) return K;
    let n = 0;
    let k = 0;
    for (const p of prey) {
      k += z.land.K[p] ?? 0;
      n += byKind ? (byKind.get(p)?.length ?? 0) : z.list.filter((r) => r.kind === p).length;
    }
    if (k <= 0) return 0;
    return Math.round(K * Math.min(1, n / k));
  }

  /** The prey of a predator in a zone (members). */
  _preyIn(z, kind, ctx) {
    const prey = PREY[kind];
    if (!prey) return 0;
    let n = 0;
    for (const r of z.list) if (prey.includes(r.kind)) n++;
    for (const b of ctx.byZone.get(z.key) ?? []) if (prey.includes(kindOf(b))) n++;
    return n;
  }

  /**
   * The event loop of one kind in one zone over [t0, t1]: competing exponential clocks for a birth candidate (BIRTH_RATE
   * × the females), a wanderer in (one a WANDER_DAYS per neighbour that can send one, while the zone lacks a male or a
   * female and is under K) and one wandering out (the surplus over K, each one a WANDER_DAYS). A birth candidate is a
   * random female; she gives birth when she is able and with probability (1 − N / K) — thinning, which makes the births
   * exactly a Poisson process at her rate × (1 − N / K).
   */
  _advanceKind(z, kind, members, K, t0, t1, ctx) {
    const rng = this._rng;
    const r = this.life.rate[kind] ?? 0;
    const cap = TAME_CAP[kind] ?? 0;
    let females = 0;
    let wildN = 0;
    let tameN = 0;
    let wildF = 0;
    let wildM = 0;
    for (const m of members) {
      if (m.sex === 'f') females++;
      if (m.tamed) tameN++;
      else {
        wildN++;
        if (m.sex === 'f') wildF++;
        else wildM++;
      }
    }
    /** @type {{ z: Zone, n: number, dormant: FaunaRecord[] }[]|null} */
    let sources = null;
    /** @type {{ z: Zone, n: number, K: number }[]|null} */
    let targets = null;
    let preyNow = -1;
    let t = t0;
    for (let guard = 0; guard < 20000; guard++) {
      const lacking = wildF === 0 || wildM === 0;
      let rateIn = 0;
      if (lacking && K >= 1 && wildN < K && !(kind === 'fish' && (!z.land || z.land.ws.length === 0))) {
        sources ??= this._sources(z, kind, ctx);
        rateIn = sources.length / WANDER_DAYS;
      }
      let rateOut = 0;
      if (wildN > K) {
        targets ??= this._targets(z, kind, ctx);
        if (targets.length > 0) rateOut = (wildN - K) / WANDER_DAYS;
      }
      const rateB = r * females;
      const R = rateB + rateIn + rateOut;
      if (!(R > 0)) break;
      t += -Math.log(1 - rng()) / R;
      if (t >= t1) break;
      const u = rng() * R;
      if (u < rateB) {
        // a birth candidate: a random female
        let k = Math.floor(rng() * females);
        let f = null;
        for (const m of members) {
          if (m.sex !== 'f') continue;
          if (k-- === 0) {
            f = m;
            break;
          }
        }
        if (!f) continue;
        if (preyNow < 0 && PREY[kind]) preyNow = this._preyIn(z, kind, ctx);
        if (!this._able(f, t, z, kind, members, ctx, preyNow)) continue;
        const room = f.tamed ? (cap > 0 ? 1 - tameN / cap : 0) : (K > 0 ? 1 - wildN / K : 0);
        if (!(rng() < room)) continue;
        const n = litterSize(kind, rng);
        for (let i = 0; i < n; i++) {
          const young = this._birth(f, t, z, kind, ctx);
          if (!young) break;
          members.push(young);
          if (young.sex === 'f') females++;
          if (young.tamed) tameN++;
          else {
            wildN++;
            if (young.sex === 'f') wildF++;
            else wildM++;
          }
          this.counts.young++;
        }
        f.restUntil = t + (this.life.rest[kind] ?? 0);
        this.counts.births++;
        z.touched = true;
      } else if (u < rateB + rateIn && sources && sources.length > 0) {
        // a wanderer comes in from a neighbour that has some
        const si = Math.floor(rng() * sources.length);
        const s = sources[si];
        const ri = Math.floor(rng() * s.dormant.length);
        const rec = s.dormant[ri];
        s.dormant.splice(ri, 1);
        s.z.list.splice(s.z.list.indexOf(rec), 1);
        s.n--;
        s.z.touched = true;
        if (s.n < WANDER_SOURCE_MIN || s.dormant.length === 0) sources.splice(si, 1);
        this._moveTo(rec, z, s.z, t);
        members.push(rec);
        if (rec.sex === 'f') {
          females++;
          wildF++;
        } else wildM++;
        wildN++;
        this.counts.wanderersIn++;
        z.touched = true;
      } else if (targets && targets.length > 0) {
        // one of the surplus wanders out, to the neighbour with the most room
        const mine = members.filter((m) => m.rec && !m.tamed);
        if (mine.length === 0) continue;
        targets.sort((a, b) => (b.K - b.n) - (a.K - a.n));
        const tg = targets[0];
        const rec = mine[Math.floor(rng() * mine.length)];
        members.splice(members.indexOf(rec), 1);
        z.list.splice(z.list.indexOf(rec), 1);
        if (rec.sex === 'f') {
          females--;
          wildF--;
        } else wildM--;
        wildN--;
        this._moveTo(rec, tg.z, z, t);
        tg.n++;
        tg.z.touched = true;
        if (tg.n >= tg.K) targets.splice(0, 1);
        this.counts.wanderedOut++;
        z.touched = true;
      }
    }
  }

  /** The neighbours that can send a wanderer of `kind`: at least WANDER_SOURCE_MIN of it (wild), one of them dormant. */
  _sources(z, kind, ctx) {
    const out = [];
    for (const nb of this._neighbours(z)) {
      const dormant = nb.list.filter((r) => r.kind === kind && !r.tamed);
      if (dormant.length === 0) continue;
      let n = dormant.length;
      for (const b of ctx.byZone.get(nb.key) ?? []) if (kindOf(b) === kind && !b.tamed) n++;
      if (n >= WANDER_SOURCE_MIN) out.push({ z: nb, n, dormant });
    }
    return out;
  }

  /** The neighbours with room for `kind` (wild N under their K). */
  _targets(z, kind, ctx) {
    const out = [];
    for (const nb of this._neighbours(z)) {
      if (!nb.land) continue;
      const K = this.kOf(nb, kind);
      let n = 0;
      for (const r of nb.list) if (r.kind === kind && !r.tamed) n++;
      for (const b of ctx.byZone.get(nb.key) ?? []) if (kindOf(b) === kind && !b.tamed) n++;
      if (n < K) out.push({ z: nb, n, K });
    }
    return out;
  }

  /** The eight zones round z that are in memory with their land. @returns {Zone[]} */
  _neighbours(z) {
    const out = [];
    for (let dq = -1; dq <= 1; dq++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dq === 0 && dr === 0) continue;
        const nb = this.zones.get(zoneKey(z.zq + dq, z.zr + dr));
        if (nb && nb.land && nb.seeded) out.push(nb);
      }
    }
    return out;
  }

  /**
   * Move a record into zone `to`, as a column (put down on waking): beside one of its kind already there (it finds the
   * others: a pair that came in from opposite sides must be able to meet), else at the edge facing `from` (a fish: into
   * the zone's water).
   */
  _moveTo(rec, to, from, t) {
    const rng = this._rng;
    let q;
    let r;
    const kin = to.list.filter((o) => o.kind === rec.kind && !o.tamed);
    if (kin.length > 0) {
      const k = kin[Math.floor(rng() * kin.length)];
      const [kq, kr] = worldToHex(k.x, k.z);
      const lo = (zc) => zc * ZONE_SIZE + 1;
      const hi = (zc) => zc * ZONE_SIZE + ZONE_SIZE - 2;
      q = Math.max(lo(to.zq), Math.min(hi(to.zq), kq + Math.round((rng() * 2 - 1) * 2)));
      r = Math.max(lo(to.zr), Math.min(hi(to.zr), kr + Math.round((rng() * 2 - 1) * 2)));
      if (rec.kind === 'fish') [q, r] = [kq, kr];
    } else if (rec.kind === 'fish' && to.land && to.land.ws.length > 0) {
      [q, r] = to.land.ws[Math.floor(rng() * to.land.ws.length)];
    } else {
      const edge = (d, base) => (d < 0 ? base + 1 + Math.floor(rng() * 3) : d > 0 ? base + ZONE_SIZE - 4 + Math.floor(rng() * 3)
        : base + 8 + Math.floor(rng() * (ZONE_SIZE - 16)));
      q = edge(from.zq - to.zq, to.zq * ZONE_SIZE);
      r = edge(from.zr - to.zr, to.zr * ZONE_SIZE);
    }
    const [x, z] = hexToWorld(q, r);
    rec.x = x;
    rec.z = z;
    rec.y = 0;
    rec.placed = false;
    rec.habBits = -1;
    rec.homeX = x;
    rec.homeZ = z;
    rec.since = t;
    rec.slept = Math.min(rec.slept, t);
    to.list.push(rec);
  }

  /**
   * A female is able to breed at t: grown up, not resting, a grown male of her kind within MATE_RANGE, food and water
   * near (see _fedWatered). Members that came into the zone after t do not count yet.
   */
  _able(f, t, z, kind, members, ctx, prey) {
    if (f.sex !== 'f' || (f.rec && f.since > t)) return false;
    const youth = this.life.youth[kind] ?? 0;
    if (t - f.born < youth || t < f.restUntil) return false;
    if (!this._hasMate(f, t, kind, members, ctx, youth)) return false;
    return this._fedWatered(f, t, z, kind, ctx, prey);
  }

  _hasMate(f, t, kind, members, ctx, youth) {
    const R2 = MATE_RANGE * MATE_RANGE;
    const near = (m) => m.sex === 'm' && t - m.born >= youth && !(m.rec && m.since > t)
      && (m.x - f.x) * (m.x - f.x) + (m.z - f.z) * (m.z - f.z) <= R2;
    for (const m of members) if (near(m)) return true;
    if (!f.rec) for (const m of ctx.byKind.get(kind) ?? []) if (near(m)) return true; // a live male across the zone's edge
    return false;
  }

  /**
   * Food and water within FEED_RANGE. Fish: always. A feed by hand within FED_DAYS is food. Wolves and the bear: prey in
   * the zone is food. Otherwise a LIVE animal looks round itself (scanHabitat, at most once a game hour); a dormant TAME
   * one has what it had round it when last seen; a dormant WILD one roams its zone: food when the zone grazes, water when
   * the zone has fresh water — and in a dry zone only DRY_WATER of the time (rain pools, dew).
   */
  _fedWatered(f, t, z, kind, ctx, prey) {
    if (kind === 'fish') return true;
    const fed = t - f.fedAt <= FED_DAYS;
    let food;
    let water;
    const env = ctx.env;
    if (!f.rec && env) {
      const [q, r] = worldToHex(f.x, f.z);
      if (env.isLoadedCell(q, r)) {
        if (!(Math.abs(t - (f.habAt ?? -Infinity)) < STEP_DAYS)) {
          f.habBits = scanHabitat(env, q, Math.floor(f.y + 0.05), r);
          f.habAt = t;
        }
        food = (f.habBits & 1) !== 0;
        water = (f.habBits & 2) !== 0;
      }
    }
    if (food === undefined) {
      if (f.tamed && f.habBits >= 0) {
        food = (f.habBits & 1) !== 0;
        water = (f.habBits & 2) !== 0;
      } else {
        const land = /** @type {ZoneLand} */ (z.land);
        food = land.g > 0;
        water = land.w >= 1 || this._rng() < land.w;
      }
    }
    if (PREY[kind]) food = prey > 0;
    return (food || fed) && !!water;
  }

  /**
   * A young one of mother `f`, born at t: live beside her when she is live and there is room, else a record beside her.
   * Tame when she is tame. @returns {any|null}
   */
  _birth(f, t, z, kind, ctx) {
    const rng = this._rng;
    const sex = rng() < 0.5 ? 'f' : 'm';
    const dx = (rng() - 0.5) * 1.2;
    const dz = (rng() - 0.5) * 1.2;
    if (!f.rec && ctx.env && this.liveCount < LIVE_MAX) {
      const isPig = kind === 'pig';
      const body = isPig ? this.pigs?.spawn(f.x + dx * 0.5, f.y, f.z + dz * 0.5, rng() * Math.PI * 2 - Math.PI, sex)
        : this.animals?.spawn(kind, f.x + dx * 0.5, f.y, f.z + dz * 0.5, rng() * Math.PI * 2 - Math.PI, sex);
      if (body) {
        body.born = t;
        body.tamed = !!f.tamed;
        body.homeX = Number.isFinite(f.homeX) ? f.homeX : f.x;
        body.homeZ = Number.isFinite(f.homeZ) ? f.homeZ : f.z;
        body.habBits = f.habBits ?? -1;
        body.habAt = f.habAt ?? -Infinity;
        this._grow(body, this.now);
        ctx.byKind.get(kind)?.push(body);
        return body;
      }
    }
    if (z.list.length >= ZONE_ANIMALS_MAX) return null;
    const placed = f.rec ? f.placed : true;
    let [bx, bz] = [f.x + dx, f.z + dz];
    if (!placed) [bx, bz] = hexToWorld(...worldToHex(bx, bz)); // a column-only mother: her young stand in a column too
    const rec = makeRecord(kind, sex, t, bx, f.y, bz, placed, t);
    rec.yaw = rng() * Math.PI * 2 - Math.PI;
    rec.tamed = !!f.tamed;
    rec.homeX = Number.isFinite(f.homeX) ? f.homeX : f.x;
    rec.homeZ = Number.isFinite(f.homeZ) ? f.homeZ : f.z;
    rec.habBits = f.habBits ?? -1;
    z.list.push(rec);
    return rec;
  }

  // ---- the debug handle ------------------------------------------------------------------------------------------

  /**
   * Advance every zone in memory as if `days` game days had passed (their clocks, the ages and the waits of their animals
   * and of the live ones run back by `days`, then each zone is brought up to now: at most CATCH_UP_DAYS of it).
   * @returns {{ days: number, zones: number, births: number, young: number, wanderersIn: number, wanderedOut: number }}
   */
  step(days, env = this._env) {
    const d = Number.isFinite(days) && days > 0 ? days : 0;
    const before = { ...this.counts };
    const shift = (o) => {
      o.born -= d;
      if (Number.isFinite(o.restUntil)) o.restUntil -= d;
      if (Number.isFinite(o.fedAt)) o.fedAt -= d;
      if (Number.isFinite(o.habAt)) o.habAt -= d;
    };
    for (const z of this.zones.values()) {
      z.t -= d;
      z.t0 -= d;
      if (z.seeded) z.touched = true;
      for (const rec of z.list) {
        shift(rec);
        rec.slept -= d;
        rec.since -= d;
      }
    }
    for (const b of this.liveBodies()) {
      if (!Number.isFinite(b.born)) b.born = this.now - ADULT_AGE;
      shift(b);
    }
    const ctx = this._ctx(env);
    for (const z of [...this.zones.values()]) this._advance(z, z.t, this.now, ctx);
    this._growAll(this.now);
    return {
      days: d, zones: this.zones.size, births: this.counts.births - before.births, young: this.counts.young - before.young,
      wanderersIn: this.counts.wanderersIn - before.wanderersIn, wanderedOut: this.counts.wanderedOut - before.wanderedOut,
    };
  }

  /**
   * What zone of cell (q, r) holds: `{ zone: [zq, zr], biomes, water, kinds: { kind: { N, K, f, m, young, able } } }`
   * (live and dormant together; `able` the females able to breed now). Makes the zone when it is not in memory.
   */
  zoneReport(q, r, env = this._env) {
    const [zq, zr] = zoneOf(Math.floor(q), Math.floor(r));
    const z = this.zone(zq, zr, true, env);
    if (!z) return null;
    const ctx = this._ctx(env);
    /** @type {Map<string, any[]>} */
    const byKind = new Map();
    for (const m of [...z.list, ...(ctx.byZone.get(z.key) ?? [])]) {
      const k = kindOf(m);
      let l = byKind.get(k);
      if (!l) byKind.set(k, (l = []));
      l.push(m);
    }
    /** @type {Record<string, { N: number, K: number, f: number, m: number, young: number, able: number }>} */
    const kinds = {};
    for (const kind of FAUNA_KINDS) {
      const members = byKind.get(kind) ?? [];
      const K = this.kOf(z, kind, byKind);
      if (members.length === 0 && K === 0) continue;
      const youth = this.life.youth[kind] ?? 0;
      const prey = this._preyIn(z, kind, ctx);
      const saved = this._rng;
      this._rng = () => 0; // the dry-zone water chance counts as met: "able" is what could breed
      let able = 0;
      for (const f of members) if (this._able(f, this.now, z, kind, members, ctx, prey)) able++;
      this._rng = saved;
      kinds[kind] = {
        N: members.length, K, f: members.filter((m) => m.sex === 'f').length, m: members.filter((m) => m.sex === 'm').length,
        young: members.filter((m) => this.now - m.born < youth).length, able,
      };
    }
    // the biome mix is not saved: work it out again for a zone that came from a save
    if (z.land && Object.keys(z.land.mix).length === 0 && env && env.gen) z.land.mix = zoneLand(env.gen, zq, zr).mix;
    return { zone: [zq, zr], biomes: z.land ? { ...z.land.mix } : {}, water: z.land ? z.land.w : 0, kinds };
  }

  /** The F3 overlay's line for the zone of world (x, z): `Fauna: zone 0 -1 · rabbit 7/12 · deer 3/8`. */
  debugLine(x, z) {
    const [zq, zr] = zoneAt(x, z);
    const zone = this.zones.get(zoneKey(zq, zr));
    if (!zone || !zone.land) return `Fauna: zone ${zq} ${zr} (not made)`;
    const ctx = this._ctx(null);
    /** @type {Map<string, any[]>} */
    const byKind = new Map();
    for (const m of [...zone.list, ...(ctx.byZone.get(zone.key) ?? [])]) {
      const k = kindOf(m);
      let l = byKind.get(k);
      if (!l) byKind.set(k, (l = []));
      l.push(m);
    }
    const parts = [];
    for (const kind of FAUNA_KINDS) {
      const n = byKind.get(kind)?.length ?? 0;
      const K = this.kOf(zone, kind, byKind);
      if (n > 0 || K > 0) parts.push(`${kind} ${n}/${K}`);
    }
    return `Fauna: zone ${zq} ${zr} · ${parts.length ? parts.join(' · ') : 'none'}`;
  }

  // ---- the save ----------------------------------------------------------------------------------------------

  /**
   * The `fauna` save field: every zone in memory with its clock, its land and its animals — the dormant records and the
   * live bodies standing in it (as records; they stay live). A zone untouched since its seeding is written without its
   * animals (`s: 1`): loading seeds it again, the same way. See validateFaunaJSON for the form.
   */
  export() {
    const ctx = this._ctx(null);
    const now = this.now;
    /** @type {any[]} */
    const zones = [];
    const seen = new Set();
    const write = (z, live) => {
      /** @type {any} */
      const o = { q: z.zq, r: z.zr, t: z.t };
      if (z.land) Object.assign(o, landJSON(z.land));
      // untouched since its seeding: its records ARE its seeding, made again on load (only the live ones are written)
      const regen = z.seeded && !z.touched;
      if (!z.seeded || regen) {
        o.u = 1;
        o.t0 = z.t0;
      }
      const all = [...(regen ? [] : z.list).map((r) => recordJSON(r, z)), ...live.map((b) => recordJSON(this.toRecord(b, null), z))];
      if (all.length > 0) o.a = all.slice(0, ZONE_ANIMALS_MAX);
      zones.push(o);
    };
    for (const z of this.zones.values()) {
      seen.add(z.key);
      write(z, ctx.byZone.get(z.key) ?? []);
    }
    // live bodies in a zone that is not in memory (summoned far away): a zone of their own, its land worked out on load
    for (const [key, live] of ctx.byZone) {
      if (seen.has(key)) continue;
      const [zq, zr] = key.split(',').map(Number);
      write({ key, zq, zr, t: now, t0: now, land: null, seeded: false, touched: true, list: [] }, live);
    }
    return { v: 1, z: zones.slice(0, ZONE_MAX) };
  }

  /**
   * Replace everything with a save: the `fauna` field (validateFaunaJSON's form), and the animals of an older save's
   * `animals` and `pigs` fields, each put into its zone where it stood (a stag stays a male; the others get a sex). The
   * live lists are emptied: the first scan wakes what is near. A zone saved unseeded (`u: 1`) is seeded when it is next
   * needed, with `seed`, as of its `t0`: an untouched zone comes back exactly as it was.
   * @param {*} json @param {{ animals?: *, pigs?: *, seed?: number, now?: number }} [old]
   */
  load(json, old = {}) {
    this.clear();
    if (this.animals) this.animals.load([]); // empties the list and the carried events
    if (this.pigs) this.pigs.clear();
    if (typeof old.seed === 'number') this.seed = old.seed;
    const now = Number.isFinite(old.now) ? /** @type {number} */ (old.now) : 0;
    this._setNow(now);
    const { zones } = validateFaunaJSON(json);
    for (const o of zones) {
      const list = (o.a ?? []).map((a) => recordFromJSON(a, o.t));
      /** @type {Zone} */
      const z = {
        key: zoneKey(o.q, o.r), zq: o.q, zr: o.r, t: o.t, t0: o.t0 ?? o.t, land: null, seeded: o.u !== 1,
        touched: o.u !== 1 || list.length > 0, list,
      };
      if (o.K) z.land = { K: { ...o.K }, g: o.g ?? 0, w: o.w ?? DRY_WATER, c: o.c ?? 0, ws: (o.ws ?? []).map((p) => [p[0], p[1]]), mix: {} };
      this.zones.set(z.key, z);
    }
    // an older save: its animals and pigs go into their zones as they stood
    const adopt = (rec) => {
      const [zq, zr] = zoneAt(rec.x, rec.z);
      const key = zoneKey(zq, zr);
      let z = this.zones.get(key);
      if (!z) {
        z = { key, zq, zr, t: now, t0: now, land: null, seeded: false, touched: true, list: [] };
        this.zones.set(key, z);
      }
      z.touched = true;
      z.list.push(rec);
    };
    if (old.animals != null) {
      for (const o of validateAnimalsJSON(old.animals).animals) {
        const sex = o.k === 'deer' && o.v === 1 ? 'm' : this._rng() < 0.5 ? 'f' : 'm';
        const rec = makeRecord(o.k, sex, now - ADULT_AGE, o.x, o.y, o.z, true, now);
        rec.yaw = o.yaw;
        rec.health = o.h;
        rec.tamed = o.t === 1;
        rec.trust = o.tr ?? 0;
        rec.shorn = o.s ?? 0;
        rec.milked = o.m ?? 0;
        rec.sitting = o.sit === 1;
        if (o.tp && o.tc) {
          rec.trapped = o.tp;
          rec.trapCell = [o.tc[0], o.tc[1], o.tc[2]];
        }
        adopt(rec);
      }
    }
    if (Array.isArray(old.pigs)) {
      for (const p of old.pigs) {
        if (!p || ![p.x, p.y, p.z, p.yaw].every(Number.isFinite)) continue;
        const rec = makeRecord('pig', this._rng() < 0.5 ? 'f' : 'm', now - ADULT_AGE, p.x, p.y, p.z, true, now);
        rec.yaw = p.yaw;
        adopt(rec);
      }
    }
  }
}

/** The ring of cells at hex distance `rad` round (q0, r0) (the cell itself for 0). @returns {[number, number][]} */
function ring(q0, r0, rad) {
  if (rad === 0) return [[q0, r0]];
  /** @type {[number, number][]} */
  const out = [];
  for (let dq = -rad; dq <= rad; dq++) {
    for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
      if (hexLength(dq, dr) === rad) out.push([q0 + dq, r0 + dr]);
    }
  }
  return out;
}

/**
 * The feet height an animal of this size may stand at in column (q, r): loaded, room for the body, on solid ground.
 * `strict`: natural grass or snowy grass with two open cells above (where herds were always put, Animals.spawnHeightAt);
 * otherwise any top a body fits on. @returns {number|null}
 */
function standAt(env, q, r, radius, height, strict) {
  if (!env.isLoadedCell(q, r)) return null;
  const getBlock = env.getBlock;
  const [x, z] = hexToWorld(q, r);
  if (strict) {
    if (!env.groundHeight || !env.isNaturalGround) return null;
    const h = env.groundHeight(q, r);
    if (!(h >= 0) || !env.isNaturalGround(q, h, r)) return null;
    const top = getBlock(q, h, r);
    if (top !== BLOCK.GRASS_BLOCK && top !== BLOCK.SNOWY_GRASS) return null;
    if (getBlock(q, h + 1, r) !== BLOCK.AIR || getBlock(q, h + 2, r) !== BLOCK.AIR) return null;
    return isFreeAt(getBlock, x, h + 1, z, radius, height) ? h + 1 : null;
  }
  const fy = findStandingY(getBlock, x, z, WORLD_HEIGHT - 2);
  if (fy === null || !isSolid(getBlock(q, fy - 1, r))) return null;
  if (getBlock(q, fy, r) !== BLOCK.AIR) return null;
  return isFreeAt(getBlock, x, fy, z, radius, height) ? fy : null;
}

// ---- save forms -------------------------------------------------------------------------------------------------

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** The land of a zone as saved: `K` (only kinds above 0), `g`, `w`, `c`, `ws` (the biome mix is not saved: zoneReport works it out again). */
function landJSON(land) {
  /** @type {any} */
  const o = { K: { ...land.K }, g: land.g, w: land.w };
  if (land.c > 0) o.c = land.c;
  if (land.ws.length > 0) o.ws = land.ws.map((p) => [p[0], p[1]]);
  return o;
}

/**
 * A record as saved: a placed one `{ k, s, b, x, y, z, w? … }` (m, to 0.01; its heading `w` to 0.1 rad), a column-only
 * one `{ k, s, b, q, r … }` (its cell); then `h` only below full health, `t` / `hx` / `hz` / `tr` taming, `sh` / `mi` /
 * `tp` / `tc` / `sit` as the old `animals` field, `rs` resting until, `fd` fed at, `hb` what a tame one had round it,
 * `d` when it went to sleep (only with a timer that runs down: `sh`, `mi`, `tp`), `sn` when it came into the zone (only
 * when later than the zone's clock). Game days to 0.1 (`b`) or 0.01; seconds rounded up.
 */
function recordJSON(r, z) {
  /** @type {any} */
  const o = { k: r.kind, s: r.sex, b: round(r.born, 1) };
  if (r.placed) {
    o.x = round(r.x, 2);
    o.y = round(r.y, 2);
    o.z = round(r.z, 2);
    if (round(r.yaw, 1)) o.w = round(r.yaw, 1);
  } else {
    [o.q, o.r] = worldToHex(r.x, r.z);
  }
  if (r.health < maxHealth(r.kind)) o.h = round(r.health, 2);
  if (r.tamed) {
    o.t = 1;
    if (Math.hypot(r.homeX - r.x, r.homeZ - r.z) > 0.01) {
      o.hx = round(r.homeX, 2);
      o.hz = round(r.homeZ, 2);
    }
  } else if (r.trust > 0) o.tr = r.trust;
  if (r.shorn > 0) o.sh = Math.ceil(r.shorn);
  if (r.milked > 0) o.mi = Math.ceil(r.milked);
  if (r.sitting) o.sit = 1;
  if (r.trapped > 0 && r.trapCell) {
    o.tp = Math.ceil(r.trapped);
    o.tc = [r.trapCell[0], r.trapCell[1], r.trapCell[2]];
  }
  if (Number.isFinite(r.restUntil) && r.restUntil > z.t) o.rs = round(r.restUntil, 2);
  if (Number.isFinite(r.fedAt) && r.fedAt > z.t - FED_DAYS) o.fd = round(r.fedAt, 2);
  if (r.habBits >= 0 && r.tamed) o.hb = r.habBits;
  if ((o.sh || o.mi || o.tp) && Math.abs(r.slept - z.t) > 0.005) o.d = round(r.slept, 2);
  if (r.since > z.t + 0.005) o.sn = round(r.since, 2);
  return o;
}

/** A validated saved record back in memory. @returns {FaunaRecord} */
function recordFromJSON(o, t) {
  const placed = typeof o.y === 'number';
  const [x, z] = placed ? [o.x, o.z] : hexToWorld(o.q, o.r);
  const rec = makeRecord(o.k, o.s, o.b, x, placed ? o.y : 0, z, placed, t);
  rec.yaw = o.w ?? 0;
  if (o.h !== undefined) rec.health = o.h;
  rec.tamed = o.t === 1;
  rec.trust = o.tr ?? 0;
  if (o.hx !== undefined) {
    rec.homeX = o.hx;
    rec.homeZ = o.hz;
  }
  rec.shorn = o.sh ?? 0;
  rec.milked = o.mi ?? 0;
  rec.sitting = o.sit === 1;
  if (o.tp && o.tc) {
    rec.trapped = o.tp;
    rec.trapCell = [o.tc[0], o.tc[1], o.tc[2]];
  }
  if (o.rs !== undefined) rec.restUntil = o.rs;
  if (o.fd !== undefined) rec.fedAt = o.fd;
  if (o.hb !== undefined) rec.habBits = o.hb;
  rec.slept = o.d ?? t;
  rec.since = o.sn ?? t;
  return rec;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The `fauna` save field in canonical form: `{ v: 1, z: [zone…] }`, a zone `{ q, r, t, K?, g?, w?, c?, ws?, m?, u?: 1,
 * t0?, a?: [record…] }` (recordJSON's form): `u: 1` a zone not seeded yet — or untouched since its seeding, which is the
 * same thing, since seeding is a function of the seed, the zone and `t0`. At most ZONE_MAX
 * zones and ZONE_ANIMALS_MAX animals in a zone; a zone with a bad position or clock, a record of an unknown kind, sex or
 * with a bad number is dropped with a warning; a duplicate zone keeps the first.
 * @param {*} raw
 * @returns {{ zones: any[], warnings: string[] }}
 */
export function validateFaunaJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {any[]} */
  const zones = [];
  if (raw === undefined || raw === null) return { zones, warnings };
  if (typeof raw !== 'object' || !Array.isArray(raw.z)) {
    warnings.push('fauna: not a fauna object, ignored');
    return { zones, warnings };
  }
  const seen = new Set();
  for (let i = 0; i < raw.z.length; i++) {
    const o = raw.z[i];
    if (!o || typeof o !== 'object' || !Number.isSafeInteger(o.q) || !Number.isSafeInteger(o.r) || !fin(o.t)) {
      warnings.push(`fauna.z[${i}]: invalid, dropped`);
      continue;
    }
    const key = zoneKey(o.q, o.r);
    if (seen.has(key)) {
      warnings.push(`fauna.z[${i}]: zone ${key} twice, dropped`);
      continue;
    }
    if (zones.length >= ZONE_MAX) {
      warnings.push(`fauna: more than ${ZONE_MAX} zones, the rest dropped`);
      break;
    }
    seen.add(key);
    /** @type {any} */
    const z = { q: o.q, r: o.r, t: o.t };
    if (o.u === 1) {
      z.u = 1;
      if (fin(o.t0)) z.t0 = o.t0;
    }
    if (o.K && typeof o.K === 'object') {
      z.K = {};
      for (const k of FAUNA_KINDS) if (Number.isInteger(o.K[k]) && o.K[k] > 0) z.K[k] = Math.min(o.K[k], ZONE_ANIMALS_MAX);
      z.g = fin(o.g) ? Math.max(0, Math.min(1, o.g)) : 0;
      z.w = o.w === 1 ? 1 : DRY_WATER;
      if (Number.isInteger(o.c) && o.c > 0) z.c = o.c;
      const ws = Array.isArray(o.ws) ? o.ws.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger)).slice(0, 6) : [];
      if (ws.length > 0) z.ws = ws.map((p) => [p[0], p[1]]);

    }
    if (o.a !== undefined) {
      z.a = [];
      const list = Array.isArray(o.a) ? o.a : [];
      if (!Array.isArray(o.a)) warnings.push(`fauna.z[${i}].a: not a list, ignored`);
      for (let j = 0; j < list.length; j++) {
        const a = list[j];
        const placed = a && fin(a.x) && fin(a.y) && fin(a.z);
        const column = a && Number.isSafeInteger(a.q) && Number.isSafeInteger(a.r);
        const ok = a && typeof a === 'object' && isFaunaKind(a.k) && (a.s === 'f' || a.s === 'm') && fin(a.b) && (placed || column);
        if (!ok) {
          warnings.push(`fauna.z[${i}].a[${j}]: invalid, dropped`);
          continue;
        }
        if (z.a.length >= ZONE_ANIMALS_MAX) {
          warnings.push(`fauna.z[${i}]: more than ${ZONE_ANIMALS_MAX} animals, the rest dropped`);
          break;
        }
        /** @type {any} */
        const e = { k: a.k, s: a.s, b: a.b };
        if (placed) {
          e.x = a.x;
          e.y = Math.max(-16, Math.min(WORLD_HEIGHT, a.y));
          e.z = a.z;
          if (fin(a.w)) e.w = a.w;
        } else {
          e.q = a.q;
          e.r = a.r;
        }
        const max = maxHealth(a.k);
        if (fin(a.h) && a.h > 0 && a.h < max) e.h = a.h;
        const tameable = a.k === 'pig' || /** @type {*} */ (SPECIES)[a.k].tame > 0;
        if (a.t === 1 && tameable) {
          e.t = 1;
          if (fin(a.hx) && fin(a.hz)) {
            e.hx = a.hx;
            e.hz = a.hz;
          }
        } else if (Number.isInteger(a.tr) && a.tr > 0) e.tr = a.tr;
        if (Number.isInteger(a.sh) && a.sh > 0 && a.k === 'sheep') e.sh = a.sh;
        if (Number.isInteger(a.mi) && a.mi > 0 && a.k === 'cow') e.mi = a.mi;
        if (a.sit === 1 && e.t === 1 && a.k === 'wolf') e.sit = 1;
        if (Number.isInteger(a.tp) && a.tp > 0 && Array.isArray(a.tc) && a.tc.length === 3 && a.tc.every(Number.isSafeInteger)) {
          e.tp = a.tp;
          e.tc = [a.tc[0], a.tc[1], a.tc[2]];
        }
        for (const f of ['rs', 'fd', 'd', 'sn']) if (fin(a[f])) e[f] = a[f];
        if (Number.isInteger(a.hb) && a.hb >= 0 && a.hb <= 3) e.hb = a.hb;
        z.a.push(e);
      }
    }
    zones.push(z);
  }
  return { zones, warnings };
}
