// Caelancraft — water: the three laws of standing water, the rule for flowing water, its extra trigger and reseeder,
// drain and currents. See src/CONTRACTS.md §35 and §83, and docs/DESIGN-physics.md §4 / §10.2. PURE: the world is read
// through ctx.peek / world.peekBlock and written only through ctx.write (lazy, capped, event-recorded).
//
// Water is a FAMILY of blocks. A SOURCE is standing water: WATER and TAINTED_WATER (full) and their LOW and SHALLOW
// depths (§83). WATER_FLOW_1..6 (level k) and WATER_FALL are derived from what feeds them and are never sources.
//
// THE THREE LAWS (§83) — what the rule does when it runs on a SOURCE:
//   1. Water with nothing under it FALLS. A source whose cell below is open (AIR, a campfire, flowing or falling water)
//      moves down, one cell per `fall` tick, until it rests. Standing on water of its own kind that is not full, a
//      pool runs down into the one under it first (joined vessels), and what is left rests on top.
//   2. A pool holds only inside a BASIN. A BODY is one level of a pool: the sources of one quality joined side by side
//      at one height (`waterBodyAt`). A source is contained when each of its six side neighbours is solid or a source.
//      A body with a cell that is not contained SPILLS: every SPILL_STEP_S the whole body drops one level of depth,
//      until it is dry — from the top: while water stands over it, the level over it drains first. Two bodies of
//      different depth that come to touch level: their water is spread until no two cells differ by more than one
//      depth, and not a level of it is lost or made.
//   3. Water never comes from nothing. Flowing water never becomes a source, and a cell generated as water does not
//      fill again by itself. Besides the rain, one thing makes water, and not here: an AQUIFER (§89), a block of wet
//      rock that the water cycle (waterBodies.js feedStep) lets feed the fresh water standing on it. To this rule an
//      aquifer is any solid block.
// Two kinds of water are FED and stand outside laws 1 and 2 (and outside law 3 where it says so):
//   - THE SEA: a body of more than BODY_MAX_CELLS cells, and any body under one. It never falls (it pours), never
//     spills dry, never changes depth, and it alone keeps the two old rules that make water: a flowing or falling cell
//     generated as sea becomes sea again, and one with WATER_SOURCE_NEIGHBOURS sea sources beside it over a floor does.
//   - RUNNING WATER: a fresh source in the cell a stream was generated in (`springLevelAt`: worldGen.streamLevelAt). The
//     spring behind it holds it: it neither falls nor spills, and only the water cycle (waterBodies.js) changes its depth.
//
// FLOWING WATER. With E(id) = 7 for a full source, 5 for a low one, 3 for a shallow one, k for FLOW_k and, for FALL, the
// level of the water pouring in at the top of its column (fallLevel: E of the source there, k under FLOW_k), and
//
//   spreads(n) ⇔ n is water and the cell below n is solid or a source (never over FALL / FLOW / AIR),
//
// ONE rule (both the `water` ring, WATER_TICKS, and the `fall` ring, 1 tick) recomputes a cell that is not a source from
// its neighbourhood:
//   1. (the sea only) a FLOW / FALL cell generated as sea → that source again; one with ≥ WATER_SOURCE_NEIGHBOURS sea
//      sources beside it over a floor → a source;
//   2. with L = max(E(n) − 1) over the side neighbours n that spread: water above and fallLevel ≥ L → FALL;
//   3. else L ≥ 1 → FLOW_L (also under water, when the sides feed it better than the fall: a trickle landing in a
//      stream keeps the stream's level); else AIR (a campfire stays);
//   4. write the result if it differs — the scheduler's 'water' trigger re-queues the neighbourhood (the cell below
//      a new water cell on the 1-tick fall ring), so a change propagates one cell per update and a waterfall
//      advances exactly one cell per tick;
//   5. a flowing cell this update left unchanged (and a fed source), over AIR / CAMPFIRE / a FLOW no higher than itself,
//      writes FALL below it.
// Every level is exactly what its feeders imply, so taking the source away drains its flow by itself (the highest level
// left always loses its feeder). Falling keeps a stream's level and never refreshes it, so every FLOW_k is within 7 − k
// cells of a source: one full source wets at most the 127 columns of a reach-6 hex disc, however the ground falls away.
// A cell's level is the best of what falls into it and what its sides feed it, so more water never lowers a level.
// Water entering a campfire puts it out ('hiss' + steam) — also one a command put there (§32).
//
// The scheduler's triggers queue a changed cell and its 8 neighbours. The rule also reads the cell BELOW each side
// neighbour and the column ABOVE a falling one, so this module adds the 'water-floor' trigger: when a cell starts / stops
// being a floor (solid or a source) under water, the side neighbours of that water are re-queued, and when the water above
// a fall column changes, the column cells beside spreading water, the FLOW it ends on and the side neighbours of where
// it lands. It replaces the built-in 'water' reseeder with one that also wakes edited AIR next to water (a dug-out hole
// beside the sea: flow is never saved), edited sources themselves (one saved in mid-fall, or standing open) and
// neighbours in chunks that are not loaded yet (they wait for their chunk), so streamed / reloaded water goes on.
//
// `waterQualityAt` says whether the water in a cell is tainted, tracing flowing and falling water back to the sources
// that feed it; `waterSourceOf` gives the first of those sources (what a gulp is taken from).
import {
  CHUNK_SIZE, WORLD_HEIGHT, WATER_CURRENT, DRAIN_MAX_RADIUS, WATER_SOURCE_NEIGHBOURS, PHYSICS_TICK_S,
} from './config.js';
import {
  BLOCK, UNLOADED, isSolid, isWater, isWaterSource, isTaintedWater, waterLevel, waterDepth, waterAtDepth,
} from './blocks.js';
import { HEX_DIRS, FACE_NORMALS, hexToWorld, worldToHex } from './hex.js';
import { packCell, unpackCell, parseChunkKey } from './coords.js';

/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').RuleContext} RuleContext */

const B = BLOCK;
/** FLOW_k = FLOW_ID0 + k for k = 1..6. */
const FLOW_ID0 = B.WATER_FLOW_1 - 1;

/** A body of more cells than this is the sea (§83): it never changes depth and never spills dry. */
export const BODY_MAX_CELLS = 128;
/** A spilling body drops one level of depth this often, in seconds (§83 law 2). */
export const SPILL_STEP_S = 4;
/** SPILL_STEP_S in physics ticks. */
export const SPILL_TICKS = Math.round(SPILL_STEP_S / PHYSICS_TICK_S);
/** Most bodies that drop a level in one tick (the rest wait a tick). */
export const MAX_SPILLS_PER_TICK = 4;
/** A body under this many levels of water is not looked at any further up (the search for the sea over it stops). */
const MAX_COVER_STEPS = 32;

/** Block ids the water rule reacts to (CONTRACTS §35.1; the tainted source since §76, the lower depths since §83). */
export const WATER_RULE_IDS = Object.freeze([
  B.AIR, B.CAMPFIRE, B.WATER, B.WATER_FLOW_1, B.WATER_FLOW_2, B.WATER_FLOW_3, B.WATER_FLOW_4, B.WATER_FLOW_5,
  B.WATER_FLOW_6, B.WATER_FALL, B.TAINTED_WATER, B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW,
]);
/** Edited ids the 'water' reseeder looks at when a chunk is generated: the water family and AIR. */
const RESEED_IDS = Object.freeze([B.AIR, ...WATER_RULE_IDS.slice(2)]);

/** Side-neighbour offsets and the unit world direction toward each (FACE_NORMALS of the side faces). */
const DQ = HEX_DIRS.map((d) => d[0]);
const DR = HEX_DIRS.map((d) => d[1]);
const NX = HEX_DIRS.map((_, j) => FACE_NORMALS[j][0]);
const NZ = HEX_DIRS.map((_, j) => FACE_NORMALS[j][2]);

/** @returns {boolean} WATER_FLOW_1..6 */
export function isFlowingWater(id) {
  return id >= B.WATER_FLOW_1 && id <= B.WATER_FLOW_6;
}

/** @returns {boolean} water standing on `below` spreads sideways: a solid floor or a water source (DESIGN §4) */
export function isWaterFloor(below) {
  return isWaterSource(below) || isSolid(below);
}

/**
 * @returns {boolean} water can move into a cell holding `id`: AIR, a campfire, flowing or falling water. A source over
 *   such a cell has nothing under it (§83 law 1). Everything else holds it up: solid blocks, sources, and the blocks a
 *   cell can hold that water never enters (a plant, a torch, a wire), as they hold sand.
 */
export function isOpenToWater(id) {
  return id === B.AIR || id === B.CAMPFIRE || (id >= B.WATER_FLOW_1 && id <= B.WATER_FALL);
}

/** @returns {number} the id of flowing water of level `level` (1..6); ≤ 0 → AIR, ≥ 7 → WATER_FLOW_6 */
export function flowId(level) {
  if (!(level >= 1)) return B.AIR;
  return FLOW_ID0 + Math.min(6, Math.floor(level));
}

/**
 * E of the falling water at (q, y, r) (CONTRACTS §35.1): the level of the water pouring in at the top of its column —
 * E of the source there (7 full, 5 low, 3 shallow), k under WATER_FLOW_k, 0 when nothing feeds it (a stale fall, about
 * to go). Falling keeps a stream's level, it never refreshes it: without this every 1-high step of a slope restarted a
 * full reach-6 disc (review water-3).
 * @param {{ peek(q: number, y: number, r: number): number }} ctx
 * @returns {number}
 */
export function fallLevel(ctx, q, y, r) {
  let yy = y + 1;
  let top = ctx.peek(q, yy, r);
  while (top === B.WATER_FALL) top = ctx.peek(q, ++yy, r);
  return isWaterSource(top) || isFlowingWater(top) ? waterLevel(top) : 0;
}

/** @returns {boolean} the scheduler may need to (re)run the water rule here: open, flowing or falling, or not loaded yet */
function isWakeable(id) {
  return id === B.AIR || id === B.CAMPFIRE || id === B.WATER_FALL || isFlowingWater(id) || id === UNLOADED;
}

/** Most cells one `waterQualityAt` trace visits: a reach-6 cone of FLOW cells plus the fall columns that feed it. */
export const QUALITY_TRACE_MAX = 256;

/**
 * Trace the water in cell (q, y, r) back to the sources that feed it (CONTRACTS §76 water, §83). A source is its own.
 * Flowing and falling water is traced upstream, breadth first:
 *   - falling water (WATER_FALL) is fed by the water above it;
 *   - flowing water (WATER_FLOW_k) is fed by each side neighbour that spreads (it stands on a floor) with E = k + 1 — the
 *     neighbours the water rule took its level from — and by any water above it (a trickle landing in a stream).
 * The search is bounded (QUALITY_TRACE_MAX cells; UNLOADED cells are skipped).
 * @param {(q: number, y: number, r: number) => number} getBlock  world.getBlock or world.peekBlock
 * @param {number} q @param {number} y @param {number} r
 * @param {boolean} [first]  true: stop at the first source reached (`tainted` is then that source's own)
 * @returns {{ q: number, y: number, r: number, id: number, tainted: boolean }|null} the first source reached — what a gulp
 *   from this cell is taken from — with `tainted` true when ANY source reached is tainted; null when the cell is not water
 *   or no source is found (stale water that is about to drain)
 */
export function waterSourceOf(getBlock, q, y, r, first = false) {
  const id0 = getBlock(q, y, r);
  if (isWaterSource(id0)) return { q, y, r, id: id0, tainted: isTaintedWater(id0) };
  if (!isWater(id0)) return null;
  const peekCtx = { peek: getBlock };
  /** @type {number[]} cells to look at, as (q, y, r) triples */
  const todo = [q, y, r];
  const seen = new Set([`${q},${y},${r}`]);
  const push = (nq, ny, nr) => {
    const key = `${nq},${ny},${nr}`;
    if (seen.has(key) || seen.size >= QUALITY_TRACE_MAX) return;
    seen.add(key);
    todo.push(nq, ny, nr);
  };
  /** @type {{ q: number, y: number, r: number, id: number, tainted: boolean }|null} */
  let found = null;
  for (let i = 0; i < todo.length; i += 3) {
    const cq = todo[i];
    const cy = todo[i + 1];
    const cr = todo[i + 2];
    const id = getBlock(cq, cy, cr);
    if (isWaterSource(id)) {
      const tainted = isTaintedWater(id);
      if (found === null) found = { q: cq, y: cy, r: cr, id, tainted };
      if (tainted) {
        found.tainted = true;
        return found; // taint never dilutes: nothing more to learn
      }
      if (first) return found;
      continue;
    }
    if (!isWater(id)) continue;
    // FLOW or FALL: the water above it feeds it …
    if (isWater(getBlock(cq, cy + 1, cr))) push(cq, cy + 1, cr);
    if (id === B.WATER_FALL) continue;
    // … and a FLOW_k also takes its level from the spreading side neighbours one level up.
    const level = waterLevel(id);
    for (let j = 0; j < 6; j++) {
      const nq = cq + DQ[j];
      const nr = cr + DR[j];
      const n = getBlock(nq, cy, nr);
      if (!isWater(n) || !isWaterFloor(getBlock(nq, cy - 1, nr))) continue;
      const e = n === B.WATER_FALL ? fallLevel(peekCtx, nq, cy, nr) : waterLevel(n);
      if (e === level + 1) push(nq, cy, nr);
    }
  }
  return found;
}

/**
 * Whether the water in cell (q, y, r) is fresh or tainted (CONTRACTS §76 water). A source is what it is: tainted at any
 * depth, or fresh. Flowing and falling water is whatever feeds it (`waterSourceOf`): TAINTED when ANY source reached is
 * tainted (taint never dilutes: a spillway dug out of a tainted pond runs tainted all the way), else fresh — also when
 * the bounded search finds no source at all (stale water that is about to drain). Not water → 'fresh'. Salt is a matter
 * of the sea (waterBodies.waterAt), judged by the caller.
 * @param {(q: number, y: number, r: number) => number} getBlock  world.getBlock or world.peekBlock
 * @param {number} q @param {number} y @param {number} r
 * @returns {'fresh'|'tainted'}
 */
export function waterQualityAt(getBlock, q, y, r) {
  const src = waterSourceOf(getBlock, q, y, r);
  return src !== null && src.tainted ? 'tainted' : 'fresh';
}

// ---------------------------------------------------------------------------------------------------------------------
// springs and bodies (CONTRACTS §83)

/** Chunks a spring lookup remembers before it starts over. */
const SPRING_CACHE_MAX = 2048;

/**
 * A fast `springLevelAt(q, r)`: the y of the cell a stream's water was generated in, in column (q, r), or −1
 * (`worldGen.streamLevelAt`, remembered a chunk at a time). A fresh source standing in that cell is RUNNING water
 * (§83). −1 everywhere when the generator has no streams.
 * @param {() => ({ streamLevelAt?: (q: number, r: number) => number }|null|undefined)} getWorldGen  the world's generator, asked on every call
 * @returns {((q: number, r: number) => number) & { clear(): void }}
 */
export function makeSpringLookup(getWorldGen) {
  /** @type {Map<number, Int16Array|null>} */
  const cache = new Map();
  /** @type {*} */
  let gen = null;
  /** @type {((q: number, r: number) => number)|null} */
  let fn = null;
  let lastKey = NaN;
  /** @type {Int16Array|null} */
  let lastMap = null;
  const clear = () => {
    cache.clear();
    lastKey = NaN;
    lastMap = null;
  };
  const lookup = (q, r) => {
    const g = getWorldGen() ?? null;
    if (g !== gen) {
      gen = g;
      fn = g !== null && typeof g.streamLevelAt === 'function' ? (a, b) => g.streamLevelAt(a, b) : null;
      clear();
    }
    if (fn === null) return -1;
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const key = cq * 0x100000 + cr;
    if (key !== lastKey) {
      let map = cache.get(key);
      if (map === undefined) {
        map = null;
        for (let lq = 0; lq < CHUNK_SIZE; lq++) {
          for (let lr = 0; lr < CHUNK_SIZE; lr++) {
            const level = fn(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
            if (!(level >= 0)) continue;
            if (map === null) map = new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(-1);
            map[lq * CHUNK_SIZE + lr] = level;
          }
        }
        if (cache.size >= SPRING_CACHE_MAX) cache.clear();
        cache.set(key, map);
      }
      lastKey = key;
      lastMap = map;
    }
    return lastMap === null ? -1 : lastMap[(q - cq * CHUNK_SIZE) * CHUNK_SIZE + (r - cr * CHUNK_SIZE)];
  };
  lookup.clear = clear;
  return lookup;
}

/**
 * One body of standing water (§83): one level of a pool.
 * @typedef {Object} WaterBody
 * @property {number[]} cells      its cells as (q, y, r) triples, the asked cell first (at most BODY_MAX_CELLS)
 * @property {number} count        how many cells that is
 * @property {'fresh'|'tainted'} quality
 * @property {boolean} tainted
 * @property {number} depth        the depth of its deepest cell, 1..3
 * @property {number} minDepth     the depth of its shallowest cell (a levelled body: `depth` or one less)
 * @property {number[]} levels     how many of its cells stand at each depth, index 0..3
 * @property {number} units        the sum of its cells' depths
 * @property {boolean} sea         more than BODY_MAX_CELLS cells, or under a body that is the sea
 * @property {boolean} stream      running water: fresh sources in the cells a stream was generated in
 * @property {boolean} contained   every side neighbour of every cell is solid or a source
 * @property {boolean} covered     a source stands over one of its cells
 * @property {number[]|null} cover that source's cell [q, y, r]
 * @property {boolean} truncated   it touches a chunk that is not loaded: what it really is cannot be told yet
 * @property {number[]|null} unloaded  a column [q, r] of that chunk
 */

/** Offsets of the body search's own cell keys: a body of BODY_MAX_CELLS cells reaches no further than that from its first cell. */
const KEY_OFF = BODY_MAX_CELLS + 2;
const KEY_SPAN = 2 * KEY_OFF + 1;

/**
 * The body of standing water that the source in cell (q, y, r) belongs to (§83), or null when that cell is not a source.
 * A body is ONE LEVEL of a pool: the sources of one quality (fresh or tainted) joined side by side at one height. Running
 * water is its own kind of body: the fresh sources standing in the cells a stream was generated in, joined along the
 * stream from column to column whatever the step between them; it is never part of a standing body beside it (to that
 * body it is a wall of water).
 * The search stops at BODY_MAX_CELLS cells: one more makes a standing body the sea (a longer stream is cut there).
 * A body under water is the sea when the body over it is.
 * @param {(q: number, y: number, r: number) => number} peek  world.peekBlock (UNLOADED for a chunk that is not loaded;
 *   world.getBlock works too: a body at the edge of the loaded world is then not known to be cut)
 * @param {number} q @param {number} y @param {number} r
 * @param {((q: number, r: number) => number)|null} [springAt]  `makeSpringLookup`'s; null: no running water
 * @param {number} [steps]  how many bodies under this one the search has come up through (internal)
 * @returns {WaterBody|null}
 */
export function waterBodyAt(peek, q, y, r, springAt = null, steps = 0) {
  const id0 = peek(q, y, r);
  if (!isWaterSource(id0)) return null;
  const tainted = isTaintedWater(id0);
  const stream = !tainted && springAt !== null && springAt(q, r) === y;
  /** @type {number[]} */
  const cells = [q, y, r];
  const seen = new Set([(KEY_OFF * KEY_SPAN + KEY_OFF) * WORLD_HEIGHT + y]);
  let units = 0;
  let minDepth = 3;
  let depth = 0;
  const levels = [0, 0, 0, 0];
  let contained = true;
  let truncated = false;
  let big = false;
  /** @type {number[]|null} */
  let cover = null;
  /** @type {number[]|null} */
  let unloaded = null;
  for (let i = 0; i < cells.length; i += 3) {
    const cq = cells[i];
    const cy = cells[i + 1];
    const cr = cells[i + 2];
    const d = waterDepth(i === 0 ? id0 : peek(cq, cy, cr));
    units += d;
    levels[d]++;
    if (d < minDepth) minDepth = d;
    if (d > depth) depth = d;
    if (cover === null && isWaterSource(peek(cq, cy + 1, cr))) cover = [cq, cy + 1, cr];
    for (let j = 0; j < 6; j++) {
      const nq = cq + DQ[j];
      const nr = cr + DR[j];
      const n = peek(nq, cy, nr);
      if (n === UNLOADED) {
        truncated = true;
        if (unloaded === null) unloaded = [nq, nr];
        continue;
      }
      let ny = cy;
      if (stream) {
        if (!isWaterSource(n) && !isSolid(n)) contained = false;
        const level = springAt(nq, nr);
        if (level < 0) continue;
        const m = level === cy ? n : peek(nq, level, nr);
        if (!isWaterSource(m) || isTaintedWater(m)) continue;
        ny = level;
      } else {
        if (!isWaterSource(n)) {
          if (!isSolid(n)) contained = false;
          continue;
        }
        if (isTaintedWater(n) !== tainted) continue;
        if (!tainted && springAt !== null && springAt(nq, nr) === cy) continue; // running water: not this pool's
      }
      const key = ((nq - q + KEY_OFF) * KEY_SPAN + (nr - r + KEY_OFF)) * WORLD_HEIGHT + ny;
      if (seen.has(key)) continue;
      if (cells.length >= BODY_MAX_CELLS * 3) {
        big = true;
        continue;
      }
      seen.add(key);
      cells.push(nq, ny, nr);
    }
    if (big && !stream) break; // the sea: nothing more to learn
  }
  let sea = big && !stream;
  if (!sea && !stream && cover !== null && steps < MAX_COVER_STEPS) {
    const over = waterBodyAt(peek, cover[0], cover[1], cover[2], springAt, steps + 1);
    if (over !== null) {
      if (over.sea) sea = true;
      else if (over.truncated && !over.stream && !truncated) {
        truncated = true;
        unloaded = over.unloaded;
      }
    }
  }
  return {
    cells, count: cells.length / 3, quality: tainted ? 'tainted' : 'fresh', tainted, depth, minDepth, levels, units,
    sea, stream, contained, covered: cover !== null, cover, truncated, unloaded,
  };
}

/**
 * Whether cell (q, y, r) was GENERATED as part of the sea: its generated block is a source whose generated body
 * (`waterBodyAt` over `world.originAt`) is the sea. Only such a cell fills again by itself (§83 law 3).
 * @param {{ originAt?: (q: number, y: number, r: number) => number }} world
 * @param {number} q @param {number} y @param {number} r
 * @param {((q: number, r: number) => number)|null} [springAt]
 * @returns {{ id: number, sea: boolean, truncated: boolean, unloaded: number[]|null }|null} the generated source and what its
 *   body is (`truncated`: part of it lies in a chunk that is not loaded, and it is not known to be the sea); null when the
 *   cell was not generated as a source (or the world keeps no origins)
 */
export function naturalSeaAt(world, q, y, r, springAt = null) {
  if (typeof world.originAt !== 'function') return null;
  const id = world.originAt(q, y, r);
  if (!isWaterSource(id)) return null;
  const body = waterBodyAt((a, b, c) => /** @type {*} */ (world).originAt(a, b, c), q, y, r, springAt);
  if (body === null) return null;
  return { id, sea: body.sea, truncated: body.truncated && !body.sea, unloaded: body.unloaded };
}

/** Natural-sea answers a Fluids remembers (a cell's generated body never changes). */
const SEA_CACHE_MAX = 16384;

export class Fluids {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    this.maxDrainRadius = DRAIN_MAX_RADIUS;
    /**
     * rule updates run / cells written by the rule, and (§83) sources moved down a cell, levels dropped by spilling
     * bodies and bodies levelled (status and tests)
     */
    this.stats = { updates: 0, writes: 0, moved: 0, spilled: 0, levelled: 0 };
    /** `springLevelAt(q, r)`: where the world's streams run (§83); main hands it to waterBodies.js too */
    this.springLevelAt = makeSpringLookup(() => (physics.world ? physics.world.worldGen : null));
    /** @type {Map<number, number>} packed cell of a source seen standing open → the tick its body is next looked at */
    this._spills = new Map();
    /** @type {Map<number, number>} packed cell → the tick its body last dropped a level by spilling */
    this._spillStamp = new Map();
    this._spillDue = Infinity;
    /** bodies searched by `tick` so far this tick */
    this._spillLooks = 0;
    /** @type {Map<number, number>} packed cell a falling source came down into → the tick it did (one cell a tick) */
    this._landed = new Map();
    /** @type {Map<number, boolean>} packed cell → it was generated as sea */
    this._seaCache = new Map();
    this._cell = [0, 0, 0];
    physics.registerRule('water', {
      rings: ['water', 'fall'],
      feature: 'water',
      ids: WATER_RULE_IDS,
      update: (ctx, q, y, r, id) => this._update(ctx, q, y, r, id),
    });
    physics.addTrigger('water-floor', 'water', (q, y, r, prev, next) => this._onFloorChange(q, y, r, prev, next));
    // Replaces the scheduler's built-in 'water' reseeder (same name, CONTRACTS §33.4).
    physics.addReseeder('water', 'water', RESEED_IDS, (ctx, q, y, r, id) => this._reseed(q, y, r, id));
  }

  /** @returns {number} sources seen standing open whose bodies are still to be looked at (spilling, §83 law 2) */
  get pendingSpills() {
    return this._spills.size;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the rule (CONTRACTS §35.2, §83)

  /**
   * Recompute cell (q, y, r) holding `id` (AIR, CAMPFIRE or water). Reads every input before writing anything, so a
   * park (a side neighbour in an unloaded chunk) never leaves half an update behind.
   * @param {RuleContext} ctx
   */
  _update(ctx, q, y, r, id) {
    this.stats.updates++;
    if (isWaterSource(id)) {
      this._updateSource(ctx, q, y, r, id);
      return;
    }
    // (no source here any more: an appointment made for one that stood open in this cell is void — a source put here
    // later starts its own 4 s)
    if (this._spills.size > 0) this._spills.delete(packCell(q, y, r));
    let target;
    let fed = 0;
    let sources = 0;
    for (let j = 0; j < 6; j++) {
      const nq = q + DQ[j];
      const nr = r + DR[j];
      const n = ctx.peek(nq, y, nr);
      if (n === UNLOADED) {
        // Wait for that chunk; water here may have to flow into it, so its cell is queued too (it parks itself).
        if (isWater(id)) ctx.schedule('water', nq, y, nr);
        ctx.park(nq, nr);
        return;
      }
      if (!isWater(n)) continue;
      if (isWaterSource(n)) sources++;
      if (isWaterFloor(ctx.peek(nq, y - 1, nr))) {
        const l = (n === B.WATER_FALL ? fallLevel(ctx, nq, y, nr) : waterLevel(n)) - 1;
        if (l > fed) fed = l;
      }
    }
    const above = ctx.peek(q, y + 1, r);
    const wet = id !== B.AIR && id !== B.CAMPFIRE;
    // §83 law 3: only the sea makes water. Flowing or falling water in a cell generated as sea is the sea coming back …
    const natural = wet ? this._naturalSea(ctx, q, y, r) : 0;
    if (natural < 0) return; // its generated body runs into a chunk that is not loaded: parked until it is
    let seaSource = 0;
    if (natural === 0 && wet && sources >= WATER_SOURCE_NEIGHBOURS && isWaterFloor(ctx.peek(q, y - 1, r))) {
      seaSource = this._seaAround(ctx, q, y, r); // … and so is a hole in it with sea on three sides (a pocket of the shore)
    }
    if (natural > 0) {
      target = natural;
    } else if (seaSource !== 0) {
      target = seaSource;
    } else if (!wet && isWaterSource(above)) {
      // An open cell under a SOURCE: what comes down is the source's own business (§83 law 1) — it falls into this
      // cell, or, fed, pours into it. It is woken to do so (on a reload nothing else wakes it); this cell only takes
      // what its sides feed it meanwhile.
      this._wake(q, y + 1, r);
      target = fed > 0 ? FLOW_ID0 + fed : id;
    } else if (isWater(above) && (fed === 0 || fallLevel(ctx, q, y, r) >= fed)) {
      target = B.WATER_FALL; // the water pouring in from above feeds it at least as well as its sides do
    } else if (fed > 0) {
      // (also under water: fed better from its sides than by the fall above — a trickle landing in a stream — it keeps
      // the stream's level, so more water above never lowers a cell below; review water-3 regression)
      target = FLOW_ID0 + fed;
    } else {
      target = id === B.CAMPFIRE ? B.CAMPFIRE : B.AIR;
    }

    if (target !== id) {
      if (ctx.write(q, y, r, target) === 'ok') {
        this.stats.writes++;
        if (id === B.CAMPFIRE) this._douse(ctx, q, y, r);
        else if (!isWater(id)) this._splashIfLanding(ctx, q, y, r, target);
      }
      // Written ('ok'): the trigger has queued the cell below on the fall ring, so a waterfall advances exactly one
      // cell per tick. 'capped': physics holds water back (the chat line is said).
      return;
    }

    // Downward: a settled flowing cell over an open cell (or over flowing water no higher than itself) falls into it.
    // Falling water's front is left to the trigger (it queued the cell below), or a waterfall would advance two cells a
    // tick. A FLOW below that is higher than this cell is fed better from its sides: left alone.
    if (isFlowingWater(target) && y > 0) this._pour(ctx, q, y, r, target);
  }

  /** A flowing cell or a fed source over AIR, a campfire or flowing water no higher than itself: falling water below it. */
  _pour(ctx, q, y, r, id) {
    const below = ctx.peek(q, y - 1, r);
    if (below === B.AIR || below === B.CAMPFIRE || (isFlowingWater(below) && waterLevel(below) <= waterLevel(id))) {
      if (ctx.write(q, y - 1, r, B.WATER_FALL) === 'ok') {
        this.stats.writes++;
        if (below === B.CAMPFIRE) this._douse(ctx, q, y - 1, r);
        else if (below === B.AIR) this._splashIfLanding(ctx, q, y - 1, r, B.WATER_FALL);
      }
    }
  }

  /**
   * The rule on a SOURCE (§83): the three laws.
   * @param {RuleContext} ctx
   */
  _updateSource(ctx, q, y, r, id) {
    const tainted = isTaintedWater(id);
    const spring = !tainted && this.springLevelAt(q, r) === y;
    const below = y > 0 ? ctx.peek(q, y - 1, r) : B.BEDROCK;
    if (isOpenToWater(below)) {
      // Law 1: nothing under it. Fed water (running water, the sea) does not fall: it pours, as it always did.
      let fed = spring;
      if (!fed) {
        const body = waterBodyAt(ctx.peek, q, y, r, this.springLevelAt);
        if (body !== null && body.sea) fed = true;
        else if (body !== null && body.truncated) {
          this._parkOn(ctx, body); // it may be the sea: wait until the rest of it is loaded
          return;
        }
      }
      if (fed) this._pour(ctx, q, y, r, id);
      else if (this._landed.get(packCell(q, y, r)) === ctx.tick) ctx.schedule('fall', q, y, r); // one cell a tick: it came down this tick
      else this._sink(ctx, q, y, r, id, below);
      return;
    }
    if (spring) return; // running water neither levels nor spills: the cycle alone changes it
    // Standing on water of its own kind that is not full: the pool under it fills from the pool it is part of first
    // (running water is never topped up).
    if (isWaterSource(below) && waterDepth(below) < 3 && isTaintedWater(below) === tainted && !(!tainted && this.springLevelAt(q, r) === y - 1)) {
      if (this._drainInto(ctx, q, y, r)) return; // written: its cells run again
    }
    // Law 2: is it contained, and level with the pool it stands in?
    const depth = waterDepth(id);
    let contained = true;
    let uneven = false;
    for (let j = 0; j < 6; j++) {
      const nq = q + DQ[j];
      const nr = r + DR[j];
      const n = ctx.peek(nq, y, nr);
      if (n === UNLOADED) continue; // (a wall for now: the cell runs again when that chunk's water wakes)
      if (isWaterSource(n)) {
        if (waterDepth(n) !== depth && isTaintedWater(n) === tainted && !(!tainted && this.springLevelAt(nq, nr) === y)) uneven = true;
      } else if (!isSolid(n)) {
        contained = false;
      }
    }
    if (uneven && this._level(ctx, q, y, r)) return; // written: its cells run again
    if (!contained) this._markSpill(q, y, r);
  }

  /**
   * Law 1: the source in (q, y, r) goes down into the open cell below it (`below`: AIR, a campfire, flowing or falling
   * water). Taken away above first, then put below past the edit cap, so that a fall never makes two of it and never
   * loses it.
   * @param {RuleContext} ctx
   */
  _sink(ctx, q, y, r, id, below) {
    if (this._put(ctx, q, y, r, B.AIR) !== 'ok') return; // 'capped': physics holds water back
    this.stats.writes++;
    if (this._put(ctx, q, y - 1, r, id, true) !== 'ok') return;
    this.stats.writes++;
    this.stats.moved++;
    this._landed.set(packCell(q, y - 1, r), ctx.tick);
    if (below === B.CAMPFIRE) this._douse(ctx, q, y - 1, r);
    else if (!isWater(below) && isWaterFloor(ctx.peek(q, y - 2, r))) {
      const [x, z] = hexToWorld(q, r);
      ctx.sound('splash', x, y - 0.5, z, 0.8);
    }
  }

  /**
   * Spread `total` levels of depth over the cells of `body`, as level as three depths allow: every cell takes
   * `floor(total / count)` and the levels left over go one each to the cells that stood deepest (ties: the lower q,
   * then the lower r), so that no two cells differ by more than one depth and not a level is lost or made; more than
   * the body holds (3 a cell) is not put in. The cells that come down are written first, then the ones that come up
   * (those past the edit cap when `forced`): at no moment is there more water than `total` — or, coming down, than there
   * was.
   * @param {RuleContext} ctx @param {WaterBody} body @param {number} total @param {boolean} [forced]
   * @returns {{ wrote: number, change: number }} cells written, and by how many levels the body's water really changed
   *   (a write the edit cap refused changes nothing)
   */
  _distribute(ctx, body, total, forced = false) {
    const cells = body.cells;
    const n = body.count;
    /** @type {number[]} */
    const depths = [];
    for (let i = 0; i < cells.length; i += 3) depths.push(waterDepth(ctx.peek(cells[i], cells[i + 1], cells[i + 2])));
    const base = Math.min(3, Math.max(0, Math.floor(total / n)));
    const extra = base >= 3 ? 0 : Math.max(0, total - base * n);
    const order = depths.map((_, i) => i).sort((a, b) => depths[b] - depths[a] || cells[a * 3] - cells[b * 3] || cells[a * 3 + 2] - cells[b * 3 + 2]);
    const to = new Array(n).fill(base);
    for (let k = 0; k < extra; k++) to[order[k]] = base + 1;
    let wrote = 0;
    let change = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if (to[i] === depths[i] || (pass === 0) !== (to[i] < depths[i])) continue;
        if (this._put(ctx, cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2], waterAtDepth(body.tainted, to[i]), forced && pass === 1) !== 'ok') continue;
        wrote++;
        change += to[i] - depths[i];
      }
    }
    return { wrote, change };
  }

  /**
   * The source in (q, y, r) stands on water of its own kind that is not full: the body under it fills up from the body
   * it is part of, as much as that one has (joined vessels: water over a pool that has room runs down into it). The
   * upper body comes down first, by as many levels as the lower one has room for or by all it holds; then the lower
   * one takes exactly what came down (`_distribute`). Under the sea the lower body simply fills.
   * @param {RuleContext} ctx
   * @returns {boolean} a cell was written (or the update was parked on an unloaded chunk)
   */
  _drainInto(ctx, q, y, r) {
    const springAt = this.springLevelAt;
    const upper = waterBodyAt(ctx.peek, q, y, r, springAt);
    const lower = waterBodyAt(ctx.peek, q, y - 1, r, springAt);
    if (upper === null || lower === null || upper.stream || lower.stream) return false;
    for (const body of [upper, lower]) {
      if (body.truncated && !body.sea) {
        this._parkOn(ctx, body);
        return true;
      }
    }
    const room = 3 * lower.count - lower.units;
    if (room <= 0) return false;
    let wrote = 0;
    let came = room; // (the sea has it to give)
    if (!upper.sea) {
      const down = this._distribute(ctx, upper, upper.units - Math.min(upper.units, room));
      wrote += down.wrote;
      came = -down.change;
    }
    if (came > 0) wrote += this._distribute(ctx, lower, lower.units + came, true).wrote;
    if (wrote > 0) {
      this.stats.writes += wrote;
      this.stats.levelled++;
    }
    return wrote > 0;
  }

  /**
   * Law 2, levelling: the body of (q, y, r) holds cells of different depth (two pools have come to touch). While no two
   * of its cells differ by more than one depth it is level enough; else its water is spread evenly (`_distribute`):
   * nothing is lost and nothing made. The sea fills its shallower cells up.
   * @param {RuleContext} ctx
   * @returns {boolean} a cell was written (or the update was parked on an unloaded chunk)
   */
  _level(ctx, q, y, r) {
    const body = waterBodyAt(ctx.peek, q, y, r, this.springLevelAt);
    if (body === null || body.stream) return false;
    if (body.truncated && !body.sea) {
      this._parkOn(ctx, body);
      return true; // not known yet: nothing more to do here until that chunk loads
    }
    if (!body.sea && body.depth - body.minDepth <= 1) return false;
    const wrote = this._distribute(ctx, body, body.sea ? 3 * body.count : body.units).wrote;
    if (wrote > 0) {
      this.stats.writes += wrote;
      this.stats.levelled++;
    }
    return wrote > 0;
  }

  /**
   * Write a cell of STANDING water (a source moved, lowered, raised or taken away by the laws). Like ctx.write (ctx.writeForced
   * with `forced`), and — while the last explosion, collapse or fallen tree can still be undone — recorded with that event:
   * a pool the event breached runs out afterwards, by these writes, and `undo` must put it back as it was (CONTRACTS §38.3,
   * §83; water that flowed INTO the crater is undo's own business).
   * @param {RuleContext} ctx
   * @returns {'ok'|'failed'|'capped'}
   */
  _put(ctx, q, y, r, id, forced = false) {
    const physics = this.physics;
    if (physics.openEventId !== 0 || !physics.canUndo) return forced ? ctx.writeForced(q, y, r, id) : ctx.write(q, y, r, id);
    const token = physics.enterEvent(/** @type {{ id: number }} */ (physics.lastEvent).id);
    try {
      return forced ? ctx.writeForced(q, y, r, id) : ctx.write(q, y, r, id);
    } finally {
      physics.exitEvent(token);
    }
  }

  /** Park the current update on the unloaded chunk a body runs into. */
  _parkOn(ctx, body) {
    if (body.unloaded !== null) ctx.park(body.unloaded[0], body.unloaded[1]);
  }

  /** Law 2: the source in (q, y, r) stands open. Its body is looked at in SPILL_STEP_S (kept: an earlier appointment). */
  _markSpill(q, y, r) {
    const key = packCell(q, y, r);
    if (this._spills.has(key)) return;
    const due = this.physics.tickCount + SPILL_TICKS;
    this._spills.set(key, due);
    if (due < this._spillDue) this._spillDue = due;
  }

  /**
   * Once a tick (BlockPhysics.tick, while the water switch is on): the sources that stood open SPILL_STEP_S ago. At most
   * MAX_SPILLS_PER_TICK bodies drop a level in one tick.
   * @param {RuleContext} ctx
   */
  tick(ctx) {
    if (this._landed.size > 0) this._landed.clear(); // (last tick's landings)
    const spills = this._spills;
    if (spills.size === 0) {
      if (this._spillStamp.size > 0) this._spillStamp.clear();
      return;
    }
    const now = this.physics.tickCount;
    if (now < this._spillDue) return;
    let next = Infinity;
    this._spillLooks = 0;
    /** @type {number[]} entries to look at again, as (key, tick) pairs */
    const again = [];
    for (const [key, due] of spills) {
      if (due > now) {
        if (due < next) next = due;
        continue;
      }
      if (this._spillLooks >= MAX_SPILLS_PER_TICK) {
        next = now + 1; // enough bodies searched for one tick: the rest are looked at in the next
        continue;
      }
      spills.delete(key);
      const at = this._spill(ctx, key, now);
      if (at > 0) again.push(key, at);
    }
    for (let i = 0; i < again.length; i += 2) {
      spills.set(again[i], again[i + 1]);
      if (again[i + 1] < next) next = again[i + 1];
    }
    this._spillDue = next;
  }

  /**
   * One source that stood open, SPILL_STEP_S later. Still a source, still open, and its body neither the sea nor running
   * water: the body drops one level of depth — or, while water stands over it, the body over it does (a pool drains from
   * the top down to the breach). One drop per body every SPILL_STEP_S, however many of its cells stand open.
   * @param {RuleContext} ctx
   * @returns {number} the tick to look at this cell again, or 0 when there is nothing more to do for it
   */
  _spill(ctx, key, now) {
    const c = unpackCell(key, this._cell);
    const q = c[0];
    const y = c[1];
    const r = c[2];
    const id = ctx.peek(q, y, r);
    if (!isWaterSource(id)) return 0;
    const springAt = this.springLevelAt;
    if (!isTaintedWater(id) && springAt(q, r) === y) return 0;
    let open = false;
    for (let j = 0; j < 6 && !open; j++) {
      const n = ctx.peek(q + DQ[j], y, r + DR[j]);
      open = n !== UNLOADED && !isWaterSource(n) && !isSolid(n);
    }
    if (!open) return 0; // closed again: the pool holds
    // Its body (or the water over it) dropped less than a step ago, through another of its open cells: not yet.
    const own = this._spillStamp.get(key);
    if (own !== undefined && now - own < SPILL_TICKS) return own + SPILL_TICKS;
    this._spillLooks++;
    const body = waterBodyAt(ctx.peek, q, y, r, springAt);
    if (body === null || body.sea) return 0; // the sea never spills dry
    if (body.truncated) return now + SPILL_TICKS; // part of it is not loaded: it may be the sea
    let top = body;
    /** @type {WaterBody[]} the bodies under the one that drops */
    const under = [];
    for (let guard = 0; top.cover !== null && guard < MAX_COVER_STEPS; guard++) {
      const over = waterBodyAt(ctx.peek, top.cover[0], top.cover[1], top.cover[2], springAt);
      if (over === null || over.stream) break; // (running water over it is fed: this level goes instead)
      if (over.sea) return 0;
      if (over.truncated) return now + SPILL_TICKS;
      under.push(top);
      top = over;
    }
    const cells = top.cells;
    const stamp = this._spillStamp.get(packCell(cells[0], cells[1], cells[2]));
    if (stamp !== undefined && now - stamp < SPILL_TICKS) return stamp + SPILL_TICKS; // it dropped less than a step ago
    for (const b of under) for (let i = 0; i < b.cells.length; i += 3) this._spillStamp.set(packCell(b.cells[i], b.cells[i + 1], b.cells[i + 2]), now);
    let wrote = 0;
    for (let i = 0; i < cells.length; i += 3) {
      const d = waterDepth(ctx.peek(cells[i], cells[i + 1], cells[i + 2]));
      if (d === 0) continue;
      this._spillStamp.set(packCell(cells[i], cells[i + 1], cells[i + 2]), now);
      // (its deepest cells: all of them, but for a body that levelling left at two depths, which is made even first)
      if (d === top.depth && this._put(ctx, cells[i], cells[i + 1], cells[i + 2], waterAtDepth(top.tainted, d - 1)) === 'ok') wrote++;
    }
    this.stats.writes += wrote;
    if (wrote > 0) this.stats.spilled++;
    // Look again in a step, while this cell still holds water (it has run dry: nothing more to do for it).
    return isWaterSource(ctx.peek(q, y, r)) ? now + SPILL_TICKS : 0;
  }

  /**
   * @returns {number} the source the cell was generated as when it was generated as SEA (so flowing water there is the sea
   *   coming back, saved as generated anyway: §33.9 drops the edit), 0 when it was not, −1 when its generated body runs
   *   into a chunk that is not loaded (the update is parked on it)
   */
  _naturalSea(ctx, q, y, r) {
    const key = packCell(q, y, r);
    const known = this._seaCache.get(key);
    const world = this.physics.world;
    if (known !== undefined) return known ? world.originAt(q, y, r) : 0;
    const nat = naturalSeaAt(world, q, y, r, this.springLevelAt);
    if (nat === null) return 0;
    if (nat.truncated) {
      if (ctx !== null && nat.unloaded !== null) ctx.park(nat.unloaded[0], nat.unloaded[1]);
      return -1;
    }
    if (this._seaCache.size >= SEA_CACHE_MAX) this._seaCache.clear();
    this._seaCache.set(key, nat.sea);
    return nat.sea ? nat.id : 0;
  }

  /** @returns {boolean} the cell was generated as part of the sea (see `_naturalSea`; false while that cannot be told) */
  _isNaturalWater(q, y, r) {
    return this._naturalSea(null, q, y, r) > 0;
  }

  /**
   * @returns {number} the source a flowing cell with sources beside it becomes: WATER (TAINTED_WATER when one of them is
   *   tainted) when at least WATER_SOURCE_NEIGHBOURS of its side neighbours are sources of the SEA, else 0
   */
  _seaAround(ctx, q, y, r) {
    let n = 0;
    let tainted = false;
    for (let j = 0; j < 6; j++) {
      const nq = q + DQ[j];
      const nr = r + DR[j];
      const id = ctx.peek(nq, y, nr);
      if (!isWaterSource(id)) continue;
      const body = waterBodyAt(ctx.peek, nq, y, nr, this.springLevelAt);
      if (body === null || !body.sea) continue;
      n++;
      if (isTaintedWater(id)) tainted = true;
    }
    if (n < WATER_SOURCE_NEIGHBOURS) return 0;
    return tainted ? B.TAINTED_WATER : B.WATER;
  }

  /** A campfire was flooded: it is out (the write already replaced it). */
  _douse(ctx, q, y, r) {
    const [x, z] = hexToWorld(q, r);
    ctx.sound('hiss', x, y + 0.5, z, 1);
    ctx.particles('steam', x, y + 0.6, z, 12, { spread: 0.3, speed: 1.2 });
  }

  /** Water that just appeared in an empty cell splashes when it lands on something (or starts from a full source). */
  _splashIfLanding(ctx, q, y, r, target) {
    const landing = target === B.WATER_FALL ? isWaterFloor(ctx.peek(q, y - 1, r)) : target === flowId(6);
    if (!landing) return;
    const [x, z] = hexToWorld(q, r);
    ctx.sound('splash', x, y + 0.5, z, target === B.WATER_FALL ? 0.8 : 0.4);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // trigger and reseeder (CONTRACTS §35.3)

  /**
   * 'water-floor' trigger: a cell started or stopped being a floor (solid or a source) under water — that water starts /
   * stops spreading sideways, so its side neighbours (which the scheduler's own trigger does not reach) are re-queued.
   * Also: the water directly above a fall column changed — its fallLevel did too, all the way down. Re-queued: every
   * FALL of the column beside spreading water (rule 2 compares the fall with that side feed), the FLOW the column
   * ends on (fed better from its sides: it compares again) and, where the column lands on a floor, the landing's side
   * neighbours (what it feeds).
   */
  _onFloorChange(q, y, r, prev, next) {
    const world = this.physics.world;
    if (isWaterFloor(prev) !== isWaterFloor(next) && isWater(world.peekBlock(q, y + 1, r))) {
      for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], y + 1, r + DR[j]);
    }
    if (prev !== next && (isWater(prev) || isWater(next)) && world.peekBlock(q, y - 1, r) === B.WATER_FALL) {
      for (let yy = y - 1; ; yy--) {
        if (this._besideSpreadingWater(q, yy, r)) this._wake(q, yy, r);
        if (yy === 0) break;
        const below = world.peekBlock(q, yy - 1, r);
        if (below === B.WATER_FALL) continue;
        if (isFlowingWater(below)) this._wake(q, yy - 1, r);
        else if (isWaterFloor(below)) for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], yy, r + DR[j]);
        break;
      }
    }
  }

  /** @returns {boolean} a side neighbour of (q, y, r) is water that spreads (it stands on a floor) */
  _besideSpreadingWater(q, y, r) {
    const world = this.physics.world;
    for (let j = 0; j < 6; j++) {
      const nq = q + DQ[j];
      const nr = r + DR[j];
      if (isWater(world.peekBlock(nq, y, nr)) && isWaterFloor(world.peekBlock(nq, y - 1, nr))) return true;
    }
    return false;
  }

  /**
   * Chunk generated: every EDITED cell of it with an id in RESEED_IDS. Water of any kind wakes itself (a source may have
   * been saved in mid-fall, or standing open: §83) and its open neighbours; edited AIR that touches water (or a chunk not
   * loaded yet) wakes itself. Neighbours in chunks that are not loaded yet are queued anyway: they park until their chunk
   * arrives.
   */
  _reseed(q, y, r, id) {
    if (id === B.AIR) {
      if (this._touchesWater(q, y, r)) this._wake(q, y, r);
      return;
    }
    this._wake(q, y, r);
    for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], y, r + DR[j]);
    this._wakeIfOpen(q, y + 1, r);
    this._wakeIfOpen(q, y - 1, r);
  }

  /** @returns {boolean} a side neighbour or the cell above is water, or a side neighbour is in an unloaded chunk */
  _touchesWater(q, y, r) {
    const world = this.physics.world;
    if (isWater(world.peekBlock(q, y + 1, r))) return true;
    for (let j = 0; j < 6; j++) {
      const n = world.peekBlock(q + DQ[j], y, r + DR[j]);
      if (n === UNLOADED || isWater(n)) return true;
    }
    return false;
  }

  _wakeIfOpen(q, y, r) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return;
    if (isWakeable(this.physics.world.peekBlock(q, y, r))) this._wake(q, y, r);
  }

  /**
   * Queue the water rule on cell (q, y, r): falling water, open cells under water and sources with nothing under them in
   * `fall` (one cell a tick), the rest in `water`.
   */
  _wake(q, y, r) {
    const world = this.physics.world;
    const id = world.peekBlock(q, y, r);
    let intoFall;
    if (id === B.WATER_FALL) intoFall = true;
    else if (isWaterSource(id)) intoFall = y > 0 && isOpenToWater(world.peekBlock(q, y - 1, r));
    else intoFall = id !== UNLOADED && isWater(world.peekBlock(q, y + 1, r));
    this.physics.schedule(intoFall ? 'fall' : 'water', q, y, r);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // drain and currents (CONTRACTS §35.5)

  /**
   * `drain [radius]` (console: around the player's cell; rune: around the rune): every water cell within hex distance
   * `radius` and |dy| ≤ radius becomes AIR (lazy physics writes; stops when the edit cap refuses). The sea around the
   * drained space flows back in by the normal rules, and the message says so; a pool or a stream does not come back
   * (§83 law 3: what is left of a pool spills through the hole).
   * @returns {{ ok: boolean, message: string }}
   */
  drain(q, y, r, radius) {
    const R = Math.floor(Number(radius));
    if (!Number.isFinite(q + y + r) || !(R >= 0 && R <= this.maxDrainRadius)) {
      return { ok: false, message: `drain needs a cell and a radius 0..${this.maxDrainRadius}` };
    }
    const physics = this.physics;
    const world = physics.world;
    const ctx = physics.ctx;
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(WORLD_HEIGHT - 1, y + R);
    let removed = 0;
    let natural = 0;
    let unloaded = 0;
    let capped = false;
    outer: for (let dq = -R; dq <= R; dq++) {
      const drMin = Math.max(-R, -dq - R);
      const drMax = Math.min(R, -dq + R);
      for (let dr = drMin; dr <= drMax; dr++) {
        const cq = q + dq;
        const cr = r + dr;
        if (!world.hasChunkAtCell(cq, cr)) {
          unloaded++;
          continue;
        }
        for (let cy = y0; cy <= y1; cy++) {
          const id = world.peekBlock(cq, cy, cr);
          if (!isWater(id)) continue;
          // (only the first natural sea cell is looked for: one is enough for the message)
          const wasNatural = natural === 0 && isWaterSource(id) && !world.hasEdit(cq, cy, cr) && this._isNaturalWater(cq, cy, cr);
          const res = ctx.write(cq, cy, cr, B.AIR);
          if (res === 'capped') {
            capped = true;
            break outer;
          }
          if (res === 'ok') {
            removed++;
            if (wasNatural) natural++;
          }
        }
      }
    }
    if (removed === 0) {
      const why = capped ? ' (the world already has too many edited cells)' : unloaded > 0 ? ' in the loaded chunks' : '';
      return { ok: true, message: `no water to drain within ${R}${why}` };
    }
    let message = `drained ${removed} water cell${removed === 1 ? '' : 's'} within ${R}`;
    if (natural > 0 && this._waterAround(q, y0, y1, r, R)) message += ' — the water around it flows back in';
    if (capped) message += ' (stopped: the world already has too many edited cells)';
    if (unloaded > 0) message += ` (${unloaded} column${unloaded === 1 ? '' : 's'} not loaded)`;
    return { ok: true, message };
  }

  /** @returns {boolean} water just outside a drained range (the ring at R + 1, or the layer above it) */
  _waterAround(q, y0, y1, r, R) {
    const world = this.physics.world;
    for (let dq = -R - 1; dq <= R + 1; dq++) {
      for (let dr = Math.max(-R - 1, -dq - R - 1); dr <= Math.min(R + 1, -dq + R + 1); dr++) {
        const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (d <= R && isWater(world.peekBlock(q + dq, y1 + 1, r + dr))) return true;
        if (d !== R + 1) continue;
        for (let cy = y0; cy <= y1; cy++) if (isWater(world.peekBlock(q + dq, cy, r + dr))) return true;
      }
    }
    return false;
  }

  /**
   * Current acceleration for a body sampled at WORLD (x, y, z) = its feet + 0.1 (main and pigs sum it into their pull
   * input): WATER_CURRENT toward the lowest-level open side neighbour in a FLOW cell (ties: their mean direction; AIR
   * counts as level 0, solid cells are walls), straight down in falling water, nothing in a source, elsewhere or while
   * the water switch is off.
   * @param {number[]} out  [ax, ay, az] m/s²
   * @returns {number[]} out
   */
  currentAt(x, y, z, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (!this.physics.switches.water || !Number.isFinite(x + y + z)) return out;
    const world = this.physics.world;
    const [q, r] = worldToHex(x, z);
    const cy = Math.floor(y);
    const id = world.peekBlock(q, cy, r);
    if (id === B.WATER_FALL) {
      out[1] = -WATER_CURRENT;
      return out;
    }
    if (!isFlowingWater(id)) return out;
    const own = waterLevel(id);
    let min = own;
    let sx = 0;
    let sz = 0;
    for (let j = 0; j < 6; j++) {
      const n = world.peekBlock(q + DQ[j], cy, r + DR[j]);
      if (n === UNLOADED || isSolid(n)) continue;
      const l = waterLevel(n);
      if (l < min) {
        min = l;
        sx = NX[j];
        sz = NZ[j];
      } else if (l === min && l < own) {
        sx += NX[j];
        sz += NZ[j];
      }
    }
    const len = Math.hypot(sx, sz);
    if (min >= own || len < 1e-9) return out;
    out[0] = (sx / len) * WATER_CURRENT;
    out[2] = (sz / len) * WATER_CURRENT;
    return out;
  }

  /** Nothing of the world is held between updates but the appointments of spilling bodies: the world is the state. */
  reset() {
    this.stats.updates = 0;
    this.stats.writes = 0;
    this.stats.moved = 0;
    this.stats.spilled = 0;
    this.stats.levelled = 0;
    this._spills.clear();
    this._spillStamp.clear();
    this._spillDue = Infinity;
    this._landed.clear();
    this._seaCache.clear();
    this.springLevelAt.clear();
  }

  /** The 'water' switch changed: switched off, the rule, trigger and reseeder are skipped and no body spills any more. */
  onSwitch(on) {
    if (!on) {
      this._spills.clear();
      this._spillStamp.clear();
      this._spillDue = Infinity;
    }
  }
}

/**
 * The cell of entry `li` of chunk `key` in World.edits, for the save rule of §33.9 (SaveOverlay): whether flowing water
 * saved in a cell generated as water reloads as that water (the sea) or as AIR (a pool, a stream: §83 law 3).
 * @param {{ originAt?: (q: number, y: number, r: number) => number }} world
 * @param {string} key  chunk key "cq,cr"
 * @param {number} li   localIndex in the chunk
 * @param {((q: number, r: number) => number)|null} [springAt]
 * @returns {boolean} the cell was generated as sea — also when that cannot be told (part of its body is not loaded)
 */
export function editIsNaturalSea(world, key, li, springAt = null) {
  const [cq, cr] = parseChunkKey(key);
  if (!Number.isInteger(cq) || !Number.isInteger(cr)) return true;
  const y = li % WORLD_HEIGHT;
  const col = (li - y) / WORLD_HEIGHT;
  const lr = col % CHUNK_SIZE;
  const nat = naturalSeaAt(world, cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE, y, cr * CHUNK_SIZE + lr, springAt);
  return nat === null ? typeof world.originAt !== 'function' : nat.sea || nat.truncated;
}
