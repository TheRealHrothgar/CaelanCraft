// Caelancraft — Pigs: the first creatures. See src/CONTRACTS.md §30. Pure (no DOM, no three).
//
// A pig is a body (physics.createBody, PIG_RADIUS × PIG_HEIGHT, PIG_MASS) driven by a tiny AI through the same
// stepPlayer physics as the player, so it slides along honeycomb walls, hops up one-cell ledges, swims and feels black
// holes exactly like the player does. Its cylinder is used for terrain collisions, for body-to-body pushing
// (bodies.js) and as the ray target. A pig fits under a one-cell overhang but is too wide for a one-cell tunnel.
// A hit makes a pig squeal, hop back and run away for PIG_FLEE_S. Pigs never die in Creative (main only calls `hit`);
// in Survival (v0.9, DESIGN-survival §4.3, §9.3) a tool `wound`s them: PIG_HEALTH, not saved, so pigs heal on reload.
// `pruneFar` and `spawnNatural`'s ground list serve Survival's repopulation. A pig in water swims for the
// nearest bank it can reach and climb (a search over the water surface), or straight on when there is none in reach.
// It hops only one-cell ledges, and never while standing on or carrying another body, so pigs cannot climb out of a
// two-high pen on each other's backs.
import {
  PIG_MAX, PIG_RADIUS, PIG_HEIGHT, PIG_MASS, PIG_KNOCKBACK, PIG_HURT_S, PIG_FLEE_S, PIG_TURN_RATE, WORLD_HEIGHT,
  WADE_DEPTH, PIG_HEALTH, PIG_NOTICE, WARY_SNEAK_FACTOR, WARY_SPRINT_FACTOR,
} from './config.js';
import { createBody, stepPlayer, findStandingY, findFreeY, isFreeAt, isSwimWater } from './physics.js';
import { yawToForward } from './coords.js';
import {
  HEX_DIRS, HEX_INRADIUS, HEX_ROW_SPACING, FACE_NORMALS, hexToWorld, worldToHex, hexLength, hexCircleContact,
} from './hex.js';
import { BLOCK, isSolid, isLiquid, waterSurfaceHeight } from './blocks.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * @typedef {PlayerState & {
 *   id: number, yaw: number, targetYaw: number, mode: 'idle'|'walk'|'flee', timer: number,
 *   hurt: number, walkPhase: number, oinkIn: number, health: number, wallSinceAim?: boolean, trapped?: number,
 *   snareImmune?: number,
 * }} Pig
 * `walkPhase` advances with distance walked (the renderer swings the legs with it) and settles to a multiple of π
 * while the pig stands (legs straight); `oinkIn` counts down to the next ambient oink. `health` (v0.9) starts at
 * PIG_HEALTH and only `wound` lowers it (Survival); it is not saved.
 */

/** @typedef {{ x: number, y: number, z: number, yaw: number }} PigJSON */

/**
 * @typedef {Object} PigWorld
 * @property {GetBlockFn} getBlock
 * @property {(x: number, z: number) => boolean} isLoaded   true when the chunk under world (x, z) is loaded
 * @property {(x: number, y: number, z: number, out: [number, number, number]) => [number, number, number]} [pullAt]
 * @property {() => boolean} [hasCampfires]  false while the world has no CAMPFIRE cell at all (tracked or refused):
 *   walking pigs then skip the look-ahead for fire. Absent: always look.
 */

const TWO_PI = Math.PI * 2;
/** The ground `spawnNatural` places pigs on unless told otherwise (Creative: grass only). */
const DEFAULT_PIG_GROUND = Object.freeze([BLOCK.GRASS_BLOCK]);
/**
 * Hex steps a swimming pig's bank search spreads over the water surface from its own column (so it visits at most
 * 3·20·21 + 1 = 1261 water columns).
 */
export const SHORE_SEARCH = 20;
/** A swimming pig re-aims for the nearest bank this often (s). */
export const SWIM_REAIM_S = 0.75;
/**
 * Bank searches per update, all pigs together (each costs up to ~0.4 ms in open sea): pigs that fell in together
 * spread their re-aims over frames instead of all searching in one. Pigs past the budget keep their heading a frame.
 */
export const SHORE_SEARCHES_PER_UPDATE = 2;
/** Spacing (m) of the points a swimmer's straight line to its target is checked at (all must be in water columns). */
const SWIM_SIGHT_STEP = 0.25;
/** Distances (m) along the heading at which a walking pig looks for campfires. */
export const FIRE_LOOK = Object.freeze([0.25, 0.5, 0.8]);
/** A walking pig keeps its centre (the point the scorch test uses) at least this far from a campfire cell. */
export const FIRE_MARGIN = 0.15;
/** Below this horizontal speed (m/s) a pig counts as standing and its legs settle back to straight. */
export const LEG_SETTLE_SPEED = 0.2;
/** Rate (1/s) at which a standing pig's walkPhase eases to the nearest multiple of π (sin = 0: legs straight). */
export const LEG_SETTLE_RATE = 10;
/** scratch for hexCircleContact */
const contact = { depth: 0, nx: 0, nz: 0 };

/**
 * A cell a pig may hop up into or swim out onto: no solid, no fire, and no water it would swim in — a film shallow
 * enough to wade (surface ≤ WADE_DEPTH: flowing levels 1–3) counts as open, so a beach under a thin flow is still a bank.
 * (Zombies use the same rule, §39.)
 */
export function isOpen(id) {
  if (isSolid(id) || id === BLOCK.CAMPFIRE) return false;
  return !isLiquid(id) || waterSurfaceHeight(id, BLOCK.AIR) <= WADE_DEPTH;
}

/** CAMPFIRE at the feet level fy or one below (a fire the pig would walk or step down into). */
function isFireAt(getBlock, q, fy, r) {
  return getBlock(q, fy, r) === BLOCK.CAMPFIRE || getBlock(q, fy - 1, r) === BLOCK.CAMPFIRE;
}

// ---------------------------------------------------------------------------------------------------
// Shore search (swimming pigs). Columns are read at the swimmer's water level wy (its column's top liquid cell):
// what is liquid, solid or open (isOpen) at wy … wy + 3, as bits.
const C_LIQ = 1; // liquid at wy
const C_S0 = 2; // solid at wy
const C_S1 = 4; // solid at wy + 1
const C_S2 = 8; // solid at wy + 2
const C_O1 = 16; // open at wy + 1
const C_O2 = 32; // open at wy + 2
const C_O3 = 64; // open at wy + 3
/** Window of columns around the swimmer: one ring past SHORE_SEARCH, so the banks at the search's edge fit. */
const SW_R = SHORE_SEARCH + 1;
const SW_W = 2 * SW_R + 1;
const SW_N = SW_W * SW_W;
const SW_START = SW_R * SW_W + SW_R; // the swimmer's own column
const swDq = new Int8Array(SW_N); // window index → offset (dq, dr) and its hex distance
const swDr = new Int8Array(SW_N);
const swHex = new Uint8Array(SW_N);
for (let i = 0; i < SW_N; i++) {
  swDq[i] = Math.floor(i / SW_W) - SW_R;
  swDr[i] = (i % SW_W) - SW_R;
  swHex[i] = hexLength(swDq[i], swDr[i]);
}
/** window index step to each HEX_DIRS neighbour */
const swStep = Int32Array.from(HEX_DIRS, ([a, b]) => a * SW_W + b);
const swStamp = new Int32Array(SW_N); // == swNow: the column is read this search
const swBits = new Uint8Array(SW_N);
const swFrom = new Int32Array(SW_N); // BFS parent (−1 the start, −2 not reached)
const swQueue = new Int32Array(SW_N);
let swNow = 0;

function columnBits(getBlock, q, wy, r) {
  const a = getBlock(q, wy, r);
  const b = getBlock(q, wy + 1, r);
  if (isLiquid(a)) return C_LIQ | (isSolid(b) ? C_S1 : 0); // water: only whether it is open above matters
  const c = getBlock(q, wy + 2, r);
  return (isSolid(a) ? C_S0 : 0) | (isSolid(b) ? C_S1 : 0) | (isOpen(b) ? C_O1 : 0) | (isSolid(c) ? C_S2 : 0)
    | (isOpen(c) ? C_O2 : 0) | (isOpen(getBlock(q, wy + 3, r)) ? C_O3 : 0);
}

/** A column a pig swims through at the surface: liquid at wy, not solid at wy + 1. */
function isWaterCol(bits) {
  return (bits & (C_LIQ | C_S1)) === C_LIQ;
}

/**
 * Stand level of a bank (0 when the column is none): not liquid at wy, and either solid at wy with wy + 1 and wy + 2
 * open (level with the surface: stand at wy + 1), or solid at wy + 1 with wy + 2 and wy + 3 open (one above it, which
 * SWIM_EXIT_JUMP clears: stand at wy + 2).
 */
function bankStand(bits, wy) {
  if (bits & C_LIQ) return 0;
  if (bits & C_S1) return (bits & (C_O2 | C_O3)) === (C_O2 | C_O3) ? wy + 2 : 0;
  return (bits & (C_S0 | C_O1 | C_O2)) === (C_S0 | C_O1 | C_O2) ? wy + 1 : 0;
}

/** Bits of window column i (read once per search; a first read also marks it not reached). */
function swRead(getBlock, pq, pr, wy, i) {
  if (swStamp[i] !== swNow) {
    swStamp[i] = swNow;
    swBits[i] = columnBits(getBlock, pq + swDq[i], wy, pr + swDr[i]);
    swFrom[i] = -2;
  }
  return swBits[i];
}

/** A flank of a step that is not water and is solid where `mask` says. */
function swBlocks(getBlock, pq, pr, wy, i, mask) {
  const bits = swRead(getBlock, pq, pr, wy, i);
  return !isWaterCol(bits) && (bits & mask) !== 0;
}

/** True when every SWIM_SIGHT_STEP point from (x, z) to (tx, tz) lies in a water column, the start or target column. */
function swimClear(getBlock, pq, pr, wy, x, z, tx, tz, target) {
  const n = Math.ceil(Math.hypot(tx - x, tz - z) / SWIM_SIGHT_STEP);
  for (let k = 1; k <= n; k++) {
    const [q, r] = worldToHex(x + ((tx - x) * k) / n, z + ((tz - z) * k) / n);
    const dq = q - pq;
    const dr = r - pr;
    if (hexLength(dq, dr) > SW_R) return false;
    const i = (dq + SW_R) * SW_W + (dr + SW_R);
    if (i !== target && i !== SW_START && !isWaterCol(swRead(getBlock, pq, pr, wy, i))) return false;
  }
  return true;
}

/**
 * Where a pig swimming at (x, z) in column (pq, pr), top water cell wy, should head for the nearest bank it can reach
 * and climb, or null when there is none within SHORE_SEARCH steps over the water. A breadth-first search over water
 * columns (§30): a step from one column to a neighbour is passable unless BOTH cells flanking their shared edge block
 * it (a pig is too wide for a one-cell gap) — for a step into water, a flank blocks when it is not water and is solid
 * at wy or wy + 1; for a step onto a bank, when it is not water and is solid at the bank's stand level. The first
 * layer with a reachable bank wins, the bank nearest (x, z) of that layer. The heading is the farthest point of the
 * path (the bank, then the water columns back toward the pig) whose straight line from the pig stays in water.
 * @returns {[number, number]|null} world (x, z) to swim toward
 */
function shoreTarget(getBlock, x, z, pq, pr, wy) {
  swNow++;
  swRead(getBlock, pq, pr, wy, SW_START);
  swFrom[SW_START] = -1;
  swQueue[0] = SW_START;
  let head = 0;
  let tail = 1;
  let layerEnd = 1;
  let best = -1;
  let bestFrom = -1;
  let bestD2 = Infinity;
  while (head < tail) {
    if (head === layerEnd) {
      if (best >= 0) break; // the nearest layer with a bank is done
      layerEnd = tail;
    }
    const i = swQueue[head++];
    for (let k = 0; k < 6; k++) {
      const n = i + swStep[k];
      if (swStamp[n] === swNow && swFrom[n] !== -2) continue; // already queued
      const bits = swRead(getBlock, pq, pr, wy, n);
      const water = isWaterCol(bits) && swHex[n] <= SHORE_SEARCH;
      const stand = water ? 0 : bankStand(bits, wy);
      if (!water && !stand) continue;
      // The cells either side of the edge crossed: both blocking is a one-cell gap the pig is too wide for.
      const mask = water ? C_S0 | C_S1 : stand === wy + 1 ? C_S1 : C_S2;
      if (
        swBlocks(getBlock, pq, pr, wy, i + swStep[(k + 5) % 6], mask)
        && swBlocks(getBlock, pq, pr, wy, i + swStep[(k + 1) % 6], mask)
      ) continue;
      if (water) {
        swFrom[n] = i;
        swQueue[tail++] = n;
        continue;
      }
      const [bx, bz] = hexToWorld(pq + swDq[n], pr + swDr[n]);
      const d2 = (bx - x) * (bx - x) + (bz - z) * (bz - z);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = n;
        bestFrom = i;
      }
    }
  }
  if (best < 0) return null;
  // Aim at the farthest point along the path that the pig can swim to in a straight line (at worst the next column).
  let node = best;
  let next = bestFrom;
  for (;;) {
    const [tx, tz] = hexToWorld(pq + swDq[node], pr + swDr[node]);
    if (next === SW_START || swimClear(getBlock, pq, pr, wy, x, z, tx, tz, node)) return [tx, tz];
    node = next;
    next = swFrom[node];
  }
}

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a) {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * A block placed into a pig (commands can fill cells pigs stand in): lift it to the first free height within three
 * cells, or leave it (the terrain sweep will snap it) when there is none.
 */
function unstick(pig, getBlock) {
  if (isFreeAt(getBlock, pig.x, pig.y, pig.z, PIG_RADIUS, PIG_HEIGHT)) return;
  const fy = findFreeY(getBlock, pig.x, pig.z, Math.floor(pig.y) + 1, 3, PIG_RADIUS, PIG_HEIGHT);
  if (fy !== null) {
    pig.y = fy;
    pig.vy = 0;
  }
}

/**
 * True when a point FIRE_LOOK ahead of (x, z) along `yaw` lies within FIRE_MARGIN of a campfire cell at the feet level
 * fy or one below (a fire the walker would step down into). Several points, each with a margin, cover the cell corners
 * and the arc of a turn that a single look-ahead point skips. Cheap where there is no fire: a neighbour cell can only
 * be within the margin when the point is that close to their shared edge (the neighbour lies beyond it), so only
 * those neighbours are read, and the exact contact is computed only for a neighbour that IS a campfire. Shared by
 * walking pigs (§30) and zombies (§39).
 * @param {GetBlockFn} getBlock
 * @returns {boolean}
 */
export function fireAhead(getBlock, x, z, yaw, fy) {
  const [fx, fz] = yawToForward(yaw);
  let lastQ = NaN;
  let lastR = NaN;
  for (const s of FIRE_LOOK) {
    const px = x + fx * s;
    const pz = z + fz * s;
    const [cq, cr] = worldToHex(px, pz);
    if ((cq !== lastQ || cr !== lastR) && isFireAt(getBlock, cq, fy, cr)) return true;
    lastQ = cq;
    lastR = cr;
    const dx = px - (cq + cr * 0.5); // offset from the centre of cell (cq, cr) (hexToWorld)
    const dz = pz - cr * HEX_ROW_SPACING;
    for (let k = 0; k < 6; k++) {
      const n = FACE_NORMALS[k]; // also the world offset of neighbour k (HEX_DIRS[k])
      if (HEX_INRADIUS - (dx * n[0] + dz * n[2]) >= FIRE_MARGIN) continue; // farther than the margin from edge k
      const q = cq + HEX_DIRS[k][0];
      const r = cr + HEX_DIRS[k][1];
      if (!isFireAt(getBlock, q, fy, r)) continue;
      const [hx, hz] = hexToWorld(q, r);
      if (hexCircleContact(hx, hz, px, pz, FIRE_MARGIN, contact)) return true;
    }
  }
  return false;
}

/**
 * Heading (yaw) toward the nearest bank a swimmer at feet (x, y0, z) can reach over the water and climb (shoreTarget),
 * null when its column has no water at the feet or one above, or no bank is within SHORE_SEARCH steps. Shared by
 * swimming pigs (§30) and zombies (§39).
 * @param {GetBlockFn} getBlock
 * @returns {number|null}
 */
export function shoreYaw(getBlock, x, y0, z) {
  const [pq, pr] = worldToHex(x, z);
  let y = Math.floor(y0);
  if (!isLiquid(getBlock(pq, y, pr))) y++;
  if (!isLiquid(getBlock(pq, y, pr))) return null;
  while (y < WORLD_HEIGHT - 1 && isLiquid(getBlock(pq, y + 1, pr))) y++;
  const target = shoreTarget(getBlock, x, z, pq, pr, y);
  if (!target) return null;
  return Math.atan2(-(target[0] - x), -(target[1] - z)); // yawToForward(yaw) = (−sin, −cos)
}

/**
 * The pig's head, snout and ears in pig space (src/pigRenderer.js builds the model facing −Z with its feet at y 0,
 * rotation.y = yaw): the head box spans z −0.69 … −0.33, the snout reaches −0.77, the ears rise to ~1.0. All of it
 * sticks out of the PIG_RADIUS collision cylinder, which covers the body.
 */
export const PIG_HEAD_BOX = Object.freeze({ x: 0.22, y0: 0.49, y1: 1.0, z0: -0.78, z1: -0.33 });

/**
 * Distance along the ray (origin o, unit direction d) to where it enters PIG_HEAD_BOX around `pig`, 0 when the origin is
 * inside, Infinity when it misses. Slab test in pig space (the inverse of the model's rotation about y by pig.yaw).
 * @returns {number}
 */
export function rayHeadBox(pig, ox, oy, oz, dx, dy, dz) {
  const c = Math.cos(pig.yaw);
  const s = Math.sin(pig.yaw);
  const wx = ox - pig.x;
  const wz = oz - pig.z;
  const o = [wx * c - wz * s, oy - pig.y, wx * s + wz * c];
  const d = [dx * c - dz * s, dy, dx * s + dz * c];
  const lo = [-PIG_HEAD_BOX.x, PIG_HEAD_BOX.y0, PIG_HEAD_BOX.z0];
  const hi = [PIG_HEAD_BOX.x, PIG_HEAD_BOX.y1, PIG_HEAD_BOX.z1];
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return Infinity;
      continue;
    }
    let t0 = (lo[k] - o[k]) / d[k];
    let t1 = (hi[k] - o[k]) / d[k];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return Infinity;
  }
  if (tmax < 0) return Infinity;
  return Math.max(tmin, 0);
}

/** mulberry32: a small seeded generator for deterministic natural spawns. @returns {() => number} */
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Pigs {
  /** @param {() => number} [rng] uniform [0, 1); Math.random by default (AI choices need not be reproducible) */
  constructor(rng = Math.random) {
    /** @type {Pig[]} */
    this.list = [];
    this._rng = rng;
    this._nextId = 1;
    /** @type {[number, number, number]} */
    this._pull = [0, 0, 0];
    /** @type {Pig[]} pigs that stepped into a campfire during the last update (they yelp and jump out) */
    this.scorched = [];
    /** @type {Set<object>} scratch: bodies some pig stood on at the end of last frame */
    this._carriers = new Set();
    /** this update: the world may have a campfire (PigWorld.hasCampfires), so walking pigs look ahead for fire */
    this._fires = true;
    /** bank searches left this update (SHORE_SEARCHES_PER_UPDATE) */
    this._shoreBudget = SHORE_SEARCHES_PER_UPDATE;
    this._input = {
      forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pullX: 0, pullY: 0, pullZ: 0, noExitJump: false,
    };
  }

  get size() {
    return this.list.length;
  }

  clear() {
    this.list.length = 0;
  }

  /**
   * Add a pig standing at feet (x, y, z) facing `yaw`. @returns {Pig|null} null when PIG_MAX pigs exist or the
   * position is not finite
   */
  spawn(x, y, z, yaw = 0) {
    if (this.list.length >= PIG_MAX || !Number.isFinite(x + y + z + yaw)) return null;
    const pig = /** @type {Pig} */ (Object.assign(createBody(x, y, z, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: PIG_MASS }), {
      id: this._nextId++,
      yaw: wrapAngle(yaw),
      targetYaw: wrapAngle(yaw),
      mode: 'idle',
      timer: 0.5 + this._rng() * 2,
      hurt: 0,
      walkPhase: 0,
      oinkIn: 4 + this._rng() * 10,
      health: PIG_HEALTH,
    }));
    this.list.push(pig);
    return pig;
  }

  /** @returns {boolean} true when the pig was in the list */
  remove(pig) {
    const i = this.list.indexOf(pig);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  /**
   * Advance every pig whose chunk is loaded (others are frozen in place). Pigs that fall below the world are removed.
   * @param {number} dt
   * @param {PigWorld} world
   * @returns {Pig[]} pigs whose ambient oink is due this frame
   */
  update(dt, world) {
    /** @type {Pig[]} */
    const oinks = [];
    this.scorched.length = 0;
    if (!(dt > 0)) return oinks;
    const input = this._input;
    this._fires = world.hasCampfires ? !!world.hasCampfires() : true;
    this._shoreBudget = SHORE_SEARCHES_PER_UPDATE;
    // Ride links are the ones made at the end of last frame (bodies.js keeps them until the next resolveBodies).
    const carriers = this._carriers;
    carriers.clear();
    for (const pig of this.list) if (pig.carrier) carriers.add(pig.carrier);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const pig = this.list[i];
      if (pig.y < -16) {
        this.list.splice(i, 1);
        continue;
      }
      if (!world.isLoaded(pig.x, pig.z)) continue;
      unstick(pig, world.getBlock);
      // v0.11 (CONTRACTS §69): held by a snare (main sets `trapped` and pins it) — it strains on the spot.
      if (pig.trapped > 0) {
        pig.trapped = Math.max(0, pig.trapped - dt);
        pig.vx = 0;
        pig.vz = 0;
        pig.walkPhase = (pig.walkPhase + dt * 9) % TWO_PI;
        if (pig.hurt > 0) pig.hurt = Math.max(0, pig.hurt - dt);
        continue;
      }
      // §69: pigs are wary — one that notices the player (nearer when sneaking, farther when sprinting) runs.
      const pl = world.player;
      if (pl && !pl.flying && pig.mode !== 'flee') {
        const notice = PIG_NOTICE * (pl.sneaking ? WARY_SNEAK_FACTOR : pl.sprinting ? WARY_SPRINT_FACTOR : 1);
        const dx = pig.x - pl.x;
        const dz = pig.z - pl.z;
        if (Math.hypot(dx, pig.y - pl.y, dz) < notice) {
          pig.mode = 'flee';
          pig.timer = PIG_FLEE_S;
          pig.targetYaw = Math.atan2(-dx, -dz); // yawToForward(yaw) = (−sin, −cos): straight away from the player
        }
      }
      // A pig standing on another body, or carrying a pig, never hops: stacked pigs would climb any wall.
      const canHop = !pig.carrier && !carriers.has(pig);
      this._think(pig, dt, world.getBlock, canHop);

      // Turn toward the target heading at PIG_TURN_RATE.
      const dYaw = wrapAngle(pig.targetYaw - pig.yaw);
      const maxTurn = PIG_TURN_RATE * dt;
      pig.yaw = wrapAngle(pig.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));

      const moving = pig.mode !== 'idle' && Math.abs(dYaw) < 1.2;
      input.forward = moving ? 1 : 0;
      input.sneak = pig.mode === 'walk'; // sneak speed (1.31 m/s) is a pig's amble; fleeing uses walk speed
      // In water a pig always paddles up (it floats, and pressing into a bank gives SWIM_EXIT_JUMP); on land it
      // hops only at a one-cell ledge straight ahead.
      input.jump = pig.inWater || (moving && pig.hitWall && canHop && this._ledgeAhead(pig, world.getBlock));
      // The swim exit jump (SWIM_EXIT_JUMP at a bank) is a hop too: a pig carrying or riding another would launch its
      // rider over a wall no single pig can climb (play-test PB-1).
      input.noExitJump = !canHop;
      input.yaw = pig.yaw;
      if (world.pullAt) {
        world.pullAt(pig.x, pig.y + 0.5, pig.z, this._pull);
        input.pullX = this._pull[0];
        input.pullY = this._pull[1];
        input.pullZ = this._pull[2];
      } else {
        input.pullX = 0;
        input.pullY = 0;
        input.pullZ = 0;
      }
      const x0 = pig.x;
      const z0 = pig.z;
      stepPlayer(pig, input, world.getBlock, dt);
      pig.sneaking = false; // a pig has no eye height to lower; keep the flag meaningful for the player only
      // Remembered until the next swim re-aim: a swimmer pressed into a high wall exit-jumps and only touches it on
      // some frames, so the instant hitWall at re-aim time is usually false and it would never turn away.
      if (pig.hitWall) pig.wallSinceAim = true;
      const stride = Math.hypot(pig.x - x0, pig.z - z0);
      pig.walkPhase = (pig.walkPhase + stride * 4) % TWO_PI;
      if (stride < LEG_SETTLE_SPEED * dt) {
        // Standing still: ease to the nearest multiple of π, where the swing sin(walkPhase) is 0 (legs straight).
        const straight = Math.round(pig.walkPhase / Math.PI) * Math.PI;
        pig.walkPhase += (straight - pig.walkPhase) * (1 - Math.exp(-LEG_SETTLE_RATE * dt));
      }
      // Standing in a campfire: hop out away from its centre (hit() also starts the flee and the hurt flash).
      const [cq, cr] = worldToHex(pig.x, pig.z);
      if (world.getBlock(cq, Math.floor(pig.y + 0.05), cr) === BLOCK.CAMPFIRE && pig.hurt === 0) {
        const [fx, fz] = hexToWorld(cq, cr);
        if (this.hit(pig, fx, fz)) this.scorched.push(pig);
      }
      if (pig.hurt > 0) pig.hurt = Math.max(0, pig.hurt - dt);

      pig.oinkIn -= dt;
      if (pig.oinkIn <= 0) {
        pig.oinkIn = 6 + this._rng() * 12;
        oinks.push(pig);
      }
    }
    return oinks;
  }

  /**
   * AI: idle ↔ wander, flee after a hit; never walk off a drop of more than one cell, into water, into a wall it
   * cannot hop or toward a campfire; and swim for the shore when in water.
   * @param {boolean} canHop  false while the pig stands on, or carries, another body
   */
  _think(pig, dt, getBlock, canHop) {
    pig.timer -= dt;
    if (pig.inWater && pig.mode !== 'flee') {
      // Swimming: never idle; head for the nearest bank it can reach and climb, re-aimed every SWIM_REAIM_S (at once
      // when it has just fallen in with a long walk timer). The edge rule does not apply, since all around is water.
      // With no bank in reach it keeps its heading, so it crosses open water in a straight line instead of circling;
      // only a wall in the way turns it. Past this update's search budget, a due re-aim waits for the next frame.
      const due = pig.mode !== 'walk' || pig.timer <= 0 || pig.timer > SWIM_REAIM_S;
      pig.mode = 'walk';
      if (due && this._shoreBudget > 0) {
        this._shoreBudget--;
        pig.timer = SWIM_REAIM_S;
        const shore = this._shoreYaw(pig, getBlock);
        if (shore !== null) pig.targetYaw = shore;
        else if (pig.wallSinceAim) pig.targetYaw = wrapAngle(pig.yaw + (this._rng() * 2 - 1) * Math.PI * 0.75);
        pig.wallSinceAim = false;
      }
      return;
    }
    if (pig.timer <= 0) {
      if (pig.mode === 'idle') {
        pig.mode = 'walk';
        pig.targetYaw = wrapAngle(pig.yaw + (this._rng() * 2 - 1) * Math.PI);
        pig.timer = 1.5 + this._rng() * 4;
      } else {
        pig.mode = 'idle';
        pig.timer = 1 + this._rng() * 4;
      }
    }
    if (pig.mode === 'walk' && pig.onGround && !this._safeAhead(pig, getBlock, canHop)) {
      // Edge, water, wall or fire ahead: stop and look somewhere else.
      pig.mode = 'idle';
      pig.timer = 0.5 + this._rng();
      pig.targetYaw = wrapAngle(pig.yaw + Math.PI * (0.5 + this._rng()));
    }
  }

  /** @returns {[number, number, number]} the cell (q, r) 0.8 ahead along the yaw, and the feet level fy */
  _aheadCell(pig) {
    const [fx, fz] = yawToForward(pig.yaw);
    const [q, r] = worldToHex(pig.x + fx * 0.8, pig.z + fz * 0.8);
    return [q, r, Math.floor(pig.y + 0.01)];
  }

  /**
   * The cell 0.8 ahead is not water a pig would swim in (physics.isSwimWater — films are fine), has ground within
   * two cells below the feet, and is not a wall: a solid cell
   * there only passes as a one-cell ledge the pig can hop (open cell above it) while `canHop`. And the centre's path
   * over the next 0.8 keeps FIRE_MARGIN away from every campfire.
   */
  _safeAhead(pig, getBlock, canHop) {
    const [q, r, fy] = this._aheadCell(pig);
    const at = getBlock(q, fy, r);
    const below = getBlock(q, fy - 1, r);
    if (isSwimWater(getBlock, q, fy, r)) return false; // films a pig can wade through are fine
    if (this._fires && this._fireAhead(pig, fy, getBlock)) return false; // pigs keep away from fire
    if (isSolid(at)) return canHop && isOpen(getBlock(q, fy + 1, r));
    return isSolid(below) || isSolid(getBlock(q, fy - 2, r));
  }

  /** A one-cell ledge straight ahead (solid at the feet, open above): the only wall worth hopping at. */
  _ledgeAhead(pig, getBlock) {
    const [q, r, fy] = this._aheadCell(pig);
    return isSolid(getBlock(q, fy, r)) && isOpen(getBlock(q, fy + 1, r));
  }

  /** A campfire within FIRE_MARGIN of the pig's next steps (fireAhead along its yaw at feet level fy). */
  _fireAhead(pig, fy, getBlock) {
    return fireAhead(getBlock, pig.x, pig.z, pig.yaw, fy);
  }

  /** Heading toward the nearest bank the swimming pig can reach and climb (shoreYaw), or null. */
  _shoreYaw(pig, getBlock) {
    return shoreYaw(getBlock, pig.x, pig.y, pig.z);
  }

  /**
   * Hit a pig from a point (the player's position): knockback away from it, a hop, a hurt flash and a flee. With
   * `kick` false (a blast or a log, which push every body the same through PhysicsHooks.knock) only the flash and the
   * flee: the pig's velocity is left alone.
   * @returns {boolean} false while the pig is still flashing from the last hit
   */
  hit(pig, fromX, fromZ, kick = true) {
    if (pig.hurt > 0) return false;
    let dx = pig.x - fromX;
    let dz = pig.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = 0;
      dz = -1;
    } else {
      dx /= d;
      dz /= d;
    }
    if (kick) {
      pig.vx = dx * PIG_KNOCKBACK;
      pig.vz = dz * PIG_KNOCKBACK;
      pig.vy = Math.max(pig.vy, 5);
      pig.onGround = false;
    }
    pig.hurt = PIG_HURT_S;
    pig.mode = 'flee';
    pig.timer = PIG_FLEE_S;
    pig.targetYaw = Math.atan2(-dx, -dz); // yawToForward(yaw) = (−sin, −cos): face along (dx, dz)
    pig.oinkIn = 3 + this._rng() * 6;
    return true;
  }

  /**
   * A Survival strike with a tool of `power` (DESIGN-survival §4.3, §9.3): ignored (null) while the pig still flashes from
   * the last hit, or when it is no longer in the list; otherwise `health −= power`. At 0 or below the pig is removed
   * ('dead'); else it is `hit` from (fromX, fromZ): knockback, flash and flee ('hit'). A power that is not a positive
   * number wounds nothing (the hit still shoves). Creative never calls this, so pigs never die there.
   * @param {Pig} pig
   * @param {number} power  the tool's power (items ToolDef.power)
   * @returns {'hit'|'dead'|null}
   */
  wound(pig, power, fromX, fromZ) {
    if (pig.hurt > 0 || !this.list.includes(pig)) return null;
    const p = typeof power === 'number' && power > 0 && Number.isFinite(power) ? power : 0;
    pig.health = (Number.isFinite(pig.health) ? pig.health : PIG_HEALTH) - p;
    if (pig.health <= 0) {
      this.remove(pig);
      return 'dead';
    }
    this.hit(pig, fromX, fromZ);
    return 'hit';
  }

  /**
   * Remove the one pig farthest from world (x, z) whose cell is not loaded and whose horizontal distance is more than
   * `minDist` (Survival repopulation, DESIGN-survival §4.3: pigs left behind would otherwise fill PIG_MAX for good).
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @returns {boolean} false when no pig qualifies
   */
  pruneFar(x, z, isLoadedCell, minDist) {
    let best = -1;
    let bestD = minDist;
    for (let i = 0; i < this.list.length; i++) {
      const pig = this.list[i];
      const d = Math.hypot(pig.x - x, pig.z - z);
      if (!(d > bestD)) continue;
      const [q, r] = worldToHex(pig.x, pig.z);
      if (isLoadedCell(q, r)) continue;
      best = i;
      bestD = d;
    }
    if (best < 0) return false;
    this.list.splice(best, 1);
    return true;
  }

  /**
   * Nearest pig whose body cylinder the ray (origin o, unit direction d) enters within maxDist.
   * @returns {{ pig: Pig, distance: number }|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    const R2 = PIG_RADIUS * PIG_RADIUS;
    for (const pig of this.list) {
      // The drawn head, snout and ears reach past the collision cylinder: the ray also hits a box around them, turned
      // with the pig, so clicking its head never breaks the block behind it (play-test PB-3).
      const tb = rayHeadBox(pig, ox, oy, oz, dx, dy, dz);
      if (tb < bestT) {
        bestT = tb;
        best = pig;
      }
      // Ray vs vertical cylinder: solve the horizontal circle, then clip to the cylinder's height; also the caps.
      const px = ox - pig.x;
      const pz = oz - pig.z;
      const y0 = pig.y;
      const y1 = pig.y + PIG_HEIGHT;
      const a = dx * dx + dz * dz;
      const b = px * dx + pz * dz;
      const c = px * px + pz * pz - R2;
      /** @type {number[]} */
      const ts = [];
      if (a > 1e-12) {
        const disc = b * b - a * c;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          for (const t of [(-b - s) / a, (-b + s) / a]) {
            const y = oy + dy * t;
            if (y >= y0 && y <= y1) ts.push(t);
          }
        }
      }
      if (Math.abs(dy) > 1e-12) {
        for (const yc of [y0, y1]) {
          const t = (yc - oy) / dy;
          const hx = px + dx * t;
          const hz = pz + dz * t;
          if (hx * hx + hz * hz <= R2) ts.push(t);
        }
      }
      // Origin inside the cylinder counts as a hit at 0.
      if (c <= 0 && oy >= y0 && oy <= y1) ts.push(0);
      for (const t of ts) {
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = pig;
        }
      }
    }
    return best ? { pig: best, distance: bestT } : null;
  }

  /** @returns {PigJSON[]} positions rounded to millimetres */
  export() {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    // A pig above the world (on a flying player's head, thrown by a blast) is saved at the top and falls on reload.
    return this.list.map((p) => ({ x: r3(p.x), y: Math.min(r3(p.y), WORLD_HEIGHT), z: r3(p.z), yaw: r3(p.yaw) }));
  }

  /** Replace every pig with the (already validated) saved ones. */
  load(list) {
    this.clear();
    for (const p of list) this.spawn(p.x, p.y, p.z, p.yaw);
  }

  /**
   * Place up to `count` pigs on grass cells around (q0, r0) at hex distance minDist..maxDist, deterministically from
   * `seed`. Columns whose chunk is not loaded or whose surface is not one of `surfaces` (GRASS_BLOCK by default; Survival
   * repopulation passes [GRASS_BLOCK, SNOWY_GRASS], v0.9) are skipped.
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @param {ReadonlyArray<number>} [surfaces]  block ids a pig may stand on
   * @returns {number} pigs placed
   */
  spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist = 4, maxDist = 18, surfaces = DEFAULT_PIG_GROUND) {
    const rng = seededRng(seed ^ 0x9e3779b9);
    let placed = 0;
    for (let attempt = 0; attempt < count * 40 && placed < count; attempt++) {
      const ang = rng() * TWO_PI;
      const dist = minDist + rng() * (maxDist - minDist);
      const [cx, cz] = hexToWorld(q0, r0);
      const [q, r] = worldToHex(cx + Math.cos(ang) * dist, cz + Math.sin(ang) * dist);
      if (!isLoadedCell(q, r)) continue;
      const [x, z] = hexToWorld(q, r);
      const fy = findStandingY(getBlock, x, z, WORLD_HEIGHT - 2);
      if (fy === null || !surfaces.includes(getBlock(q, fy - 1, r))) continue;
      if (this.spawn(x, fy, z, rng() * TWO_PI - Math.PI)) placed++;
    }
    return placed;
  }
}

/**
 * Validate a saved `pigs` field: an array of {x, y, z, yaw} with finite numbers and y ≥ −16 (a y above WORLD_HEIGHT is
 * clamped to it, so the pig falls back in rather than vanishing); anything else is dropped with a warning, and at most
 * PIG_MAX are kept.
 * @param {unknown} raw
 * @returns {{ pigs: PigJSON[], warnings: string[] }}
 */
export function validatePigsJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {PigJSON[]} */
  const pigs = [];
  if (!Array.isArray(raw)) return { pigs, warnings: ['pigs: not an array, ignored'] };
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const ok = p && typeof p === 'object'
      && [p.x, p.y, p.z, p.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))
      && p.y >= -16;
    if (!ok) {
      warnings.push(`pigs[${i}]: invalid, dropped`);
      continue;
    }
    if (pigs.length >= PIG_MAX) {
      warnings.push(`pigs: more than ${PIG_MAX}, extra dropped`);
      break;
    }
    pigs.push({ x: p.x, y: Math.min(p.y, WORLD_HEIGHT), z: p.z, yaw: p.yaw });
  }
  return { pigs, warnings };
}
