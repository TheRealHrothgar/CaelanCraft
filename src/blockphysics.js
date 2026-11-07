// Caelancraft — block physics scheduler: ticks, delay rings, budgets, parking, triggers, switches, support seeds, undo
// events and the rule registry every physics feature plugs into. See src/CONTRACTS.md §33 and docs/DESIGN-physics.md
// §2 / §10. PURE: no DOM, no three, no Math.random (a seeded rng is handed to rules), no `performance` (the clock is
// the world's injected `now`).
//
// One BlockPhysics per World (main creates it in startLoading). It owns the feature modules — falling blocks (§34),
// fluids (§35), support / collapse and trees (§36), explosions (§37) — and drives them in a fixed order:
//
//   step(dt): ≤ 1 tick (PHYSICS_TICK_S) → fallers.step → trees.step → explosions.step
//   tick:     fall ring → misc ring → support search → water ring, all under ONE budget
//             (PHYSICS_TICK_BUDGET_MS, MAX_CELL_UPDATES_PER_TICK, MAX_SUPPORT_VISITS_PER_TICK)
//
// A queued update is a CELL in a delay ring. When it is due, every registered rule of that ring whose feature is
// switched on and whose `ids` include the cell's block runs `update(ctx, q, y, r, id)`. Rules read through
// `ctx.peek` (UNLOADED for unloaded chunks → `ctx.park()` waits for that chunk) and write through `ctx.write`
// (a lazy World.setBlock that refuses NEW edit entries beyond MAX_TOTAL_EDITS). Every block change from any source
// comes back through `onBlockChange` (main forwards World.onBlockChange), where the built-in triggers queue the cells
// that may react; a switched-off feature drops its triggers instead of queueing them.
import {
  CHUNK_SIZE, WORLD_HEIGHT, MAX_TOTAL_EDITS, PHYSICS_TICK_S, WATER_TICKS, PHYSICS_TICK_BUDGET_MS,
  MAX_CELL_UPDATES_PER_TICK, MAX_SUPPORT_VISITS_PER_TICK, MAX_PARKED_UPDATES, MAX_PENDING_SUPPORT_SEEDS,
  UNDO_WINDOW_S, UNDO_MAX_CELLS, SUPPORT_STARVE_TICKS, SUPPORT_STARVED_VISITS,
} from './config.js';
import {
  BLOCK, UNLOADED, isFallThrough, isGravityBlock, isSolid, isWater, isWaterSource,
} from './blocks.js';
import { HEX_DIRS } from './hex.js';
import { chunkKey, localIndex, packCell, unpackCell } from './coords.js';
import { mulberry32 } from './noise.js';
import { FallingBlocks } from './fallingblocks.js';
import { Fluids } from './fluids.js';
import { SupportSolver, isLoadBearing } from './support.js';
import { Trees } from './trees.js';
import { Explosions } from './explosions.js';

/** @typedef {import('./types.js').EditsJSON} EditsJSON */
/** @typedef {import('./types.js').PlayerState} PlayerState */

// ---------------------------------------------------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------------------------------------------------

/** Delay rings, in tick order of their index: `fall` (1 tick), `water` (WATER_TICKS), `misc` (1 tick). */
export const RINGS = Object.freeze(['fall', 'water', 'misc']);
/** Ticks between scheduling a cell and its update, per ring index. */
export const RING_DELAY = Object.freeze([1, WATER_TICKS, 1]);
/** Feature switches (saved per world). `paused` (console `physics off`) is separate and not saved. */
export const FEATURES = Object.freeze(['falling', 'water', 'collapse', 'explosions']);

/** Who made a block change, as seen by triggers (3rd-from-last argument of a trigger is the mode). */
export const WRITE_EXTERNAL = 0; // player, commands, runes, black holes, …
export const WRITE_PHYSICS = 1; // ctx.write from a rule / faller landing
export const WRITE_QUIET = 2; // ctx.writeQuiet: physics' own batched removals (crumble, topple, blast, undo): no support seed

/**
 * Why something happened; trees use it for the topple direction (player within TREE_CAUSE_RANGE, else away from an
 * explosion, else seeded random).
 * @typedef {{ kind: 'player'|'explosion'|'area'|'world'|'physics', x?: number, y?: number, z?: number }} Cause
 */
export const CAUSE_WORLD = Object.freeze({ kind: 'world' });
export const CAUSE_PHYSICS = Object.freeze({ kind: 'physics' });
export const CAUSE_AREA = Object.freeze({ kind: 'area' });

/**
 * One queued support check (CONTRACTS §33.6). `cells` are the load-bearing cells to test (the neighbours of the
 * removed cells, or a crater rim); `removed` lists the removals that caused it as [q, y, r, prevId, wasAnchor 0|1]
 * (empty for explicit seeds) so the solver can apply the disconnected-by-this-removal rule.
 * @typedef {Object} SupportSeed
 * @property {number[][]} cells       [q, y, r][]; cells already pending in an earlier seed are omitted
 * @property {number[][]} removed     [q, y, r, prevId, wasAnchor][]
 * @property {Cause} cause
 * @property {boolean} priority       player-caused: searched before every normal seed
 * @property {number} event           id of the physics event open when it was seeded (0 = none)
 * @property {number} tick            tickCount when it was seeded
 */

/**
 * A rule: what a queued cell does when it is due.
 * @typedef {Object} RuleSpec
 * @property {string|string[]} ring   one ring name or several (`rings` is accepted as an alias)
 * @property {string|null} [feature]  switch that gates it ('falling'|'water'|'collapse'|'explosions'); null = always
 * @property {number[]} [ids]         block ids it reacts to (others are skipped without calling it); omit for all
 * @property {(ctx: RuleContext, q: number, y: number, r: number, id: number) => void} update
 */

/**
 * The single context object handed to rules, reseeders and feature modules (allocated once per BlockPhysics).
 * @typedef {Object} RuleContext
 * @property {BlockPhysics} physics
 * @property {*} world
 * @property {PhysicsHooks} hooks
 * @property {number} tick                            current tick number (getter)
 * @property {number} time                            seconds of play time (getter)
 * @property {number} deadline                        clock ms at which the current tick's budget ends
 * @property {() => number} now                       the world's ms clock
 * @property {(q: number, y: number, r: number) => number} peek    World.peekBlock; remembers the last UNLOADED cell for park()
 * @property {(q: number, y: number, r: number, id: number) => 'ok'|'failed'|'capped'} write       lazy, seeds support on removals
 * @property {(q: number, y: number, r: number, id: number) => 'ok'|'failed'|'capped'} writeQuiet  lazy, never seeds support
 * @property {(ring: string, q: number, y: number, r: number, delay?: number) => boolean} schedule
 * @property {(q?: number, r?: number) => void} park  park the CURRENT update on the chunk of column (q, r) (default: the last UNLOADED peek)
 * @property {() => number} random                   seeded uniform [0, 1)
 * @property {(text: string) => void} say
 * @property {(name: string, x: number, y: number, z: number, volume?: number) => void} sound
 * @property {(kind: string, x: number, y: number, z: number, count?: number, opts?: object) => void} particles
 * @property {FallingBlocks} fallers
 * @property {Fluids} fluids
 * @property {SupportSolver} support
 * @property {Trees} trees
 * @property {Explosions} explosions
 */

/**
 * Everything physics needs from the game, all optional (no-ops by default). Main builds it once per world.
 * @typedef {Object} PhysicsHooks
 * @property {(text: string) => void} [say]                     chat line
 * @property {() => boolean} [areaJobsActive]                   an area command is still writing (RuneRunner.hasActiveJobs)
 * @property {() => PlayerState[]} [bodies]                     player + pigs in loaded chunks: never buried by a landing block
 * @property {() => PlayerState|null} [player]                  for cause positions, sound distance and nearest-landing thuds
 * @property {(name: string, x: number, y: number, z: number, volume?: number) => void} [sound]
 *   'thud' | 'splash' | 'boom' | 'hiss' | 'creak' | 'fizzle' | 'crackle' | 'break:<soundGroup>'; main applies distance falloff
 * @property {(kind: string, x: number, y: number, z: number, count?: number, opts?: object) => void} [particles]
 *   kinds 'dust' | 'leaves' | 'smoke' | 'sparks' | 'steam'; opts { id?, color?, spread?, speed?, vx?, vy?, vz? } (particles.js)
 * @property {(body: PlayerState, vx: number, vy: number, vz: number, fromX: number, fromZ: number) => void} [knock]
 *   add an impulse to a body (explosions, tree impacts); main also makes a pig flee and squeal
 */

/**
 * The last physics event (explosion, collapse, toppled tree) for undo: every cell it changed — and every cell its
 * fallers / logs later landed in — with the id before the event first touched it and the id the event wrote last.
 * @typedef {Object} PhysicsEvent
 * @property {number} id
 * @property {string} kind              'explosion' | 'collapse' | 'tree' | …
 * @property {Cause} cause
 * @property {number} time              physics.time when it began
 * @property {Map<number, number>} cells  packCell key → prevId·256 + wroteId
 * @property {boolean} truncated        more than UNDO_MAX_CELLS cells: the rest were not recorded
 */

/** One item for fallingRenderer.sync: a moving cell's centre, rotation (Euler order 'YXZ') and uniform scale. */
/** @typedef {{ id: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number }} RenderItem */

const HOOK_NAMES = Object.freeze(['say', 'areaJobsActive', 'bodies', 'player', 'sound', 'particles', 'knock']);
const NO_BODIES = Object.freeze([]);
const DEFAULT_HOOKS = Object.freeze({
  say: () => {},
  areaJobsActive: () => false,
  bodies: () => NO_BODIES,
  player: () => null,
  sound: () => {},
  particles: () => {},
  knock: (body, vx, vy, vz) => {
    body.vx += vx;
    body.vy += vy;
    body.vz += vz;
    body.onGround = false;
  },
});

const FALL = 0;
const WATER = 1;
const MISC = 2;
/** Parked entries are `ringIndex · PARK_STRIDE + packCell(...)`; packed keys stay below 2^49 < PARK_STRIDE. */
const PARK_STRIDE = 2 ** 50;
/** The time budget is checked every this many cell updates. */
const TIME_CHECK_MASK = 31;
/** The 8 neighbours of a cell: six sides, then above and below, as [dq, dy, dr]. */
const NEIGHBOURS = Object.freeze([
  ...HEX_DIRS.map(([dq, dr]) => Object.freeze([dq, 0, dr])), Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
]);

/** @returns {number} ring index for a ring name; throws on unknown names (a programming error) */
function ringIndex(ring) {
  const i = RINGS.indexOf(ring);
  if (i < 0) throw new RangeError(`unknown physics ring "${ring}" (expected ${RINGS.join(', ')})`);
  return i;
}

/** @returns {Uint8Array|null} 256-entry membership mask for `ids`, or null for "every id" */
function idMask(ids) {
  if (ids == null) return null;
  const m = new Uint8Array(256);
  for (const id of ids) if (Number.isInteger(id) && id >= 0 && id < 256) m[id] = 1;
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// Delay ring: FIFO of packed cell keys with their due tick, deduplicated by key. Every entry of a ring has the same
// delay, so the ring is sorted by due tick by construction: pop from the head while due ≤ now.
// ---------------------------------------------------------------------------------------------------------------------

class CellRing {
  constructor() {
    this._cap = 256; // power of two
    this._keys = new Float64Array(this._cap);
    this._due = new Float64Array(this._cap);
    this._head = 0;
    this.size = 0;
    /** @type {Set<number>} keys currently queued */
    this.queued = new Set();
  }

  /** @returns {boolean} false when the key is already queued (dedupe) */
  push(key, due) {
    if (this.queued.has(key)) return false;
    if (this.size === this._cap) this._grow();
    const i = (this._head + this.size) & (this._cap - 1);
    this._keys[i] = key;
    this._due[i] = due;
    this.size++;
    this.queued.add(key);
    return true;
  }

  headDue() {
    return this._due[this._head];
  }

  shift() {
    const key = this._keys[this._head];
    this._head = (this._head + 1) & (this._cap - 1);
    this.size--;
    this.queued.delete(key);
    return key;
  }

  clear() {
    this._head = 0;
    this.size = 0;
    this.queued.clear();
  }

  _grow() {
    const cap = this._cap * 2;
    const keys = new Float64Array(cap);
    const due = new Float64Array(cap);
    for (let k = 0; k < this.size; k++) {
      const i = (this._head + k) & (this._cap - 1);
      keys[k] = this._keys[i];
      due[k] = this._due[i];
    }
    this._keys = keys;
    this._due = due;
    this._cap = cap;
    this._head = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Support-seed queue: two FIFO lanes (player-caused first), cell-level dedupe against everything still pending.
// ---------------------------------------------------------------------------------------------------------------------

export class SeedQueue {
  constructor(max = MAX_PENDING_SUPPORT_SEEDS) {
    this.max = max;
    /** @type {SupportSeed[]} */
    this._priority = [];
    /** @type {SupportSeed[]} */
    this._normal = [];
    this._ph = 0;
    this._nh = 0;
    /** @type {Set<number>} packed cells of every pending seed */
    this.pendingCells = new Set();
    this.dropped = 0;
  }

  /** @returns {number} pending seeds */
  get size() {
    return this._priority.length - this._ph + this._normal.length - this._nh;
  }

  /**
   * Queue a seed; cells already pending are left out of it. A seed left with no cells and no removals is dropped.
   * @param {SupportSeed} seed
   * @returns {boolean} queued
   */
  push(seed) {
    if (this.size >= this.max) {
      this.dropped++;
      return false;
    }
    const cells = [];
    for (const c of seed.cells) {
      const k = packCell(c[0], c[1], c[2]);
      if (this.pendingCells.has(k)) continue;
      this.pendingCells.add(k);
      cells.push(c);
    }
    if (cells.length === 0 && seed.removed.length === 0) return false;
    seed.cells = cells;
    (seed.priority ? this._priority : this._normal).push(seed);
    return true;
  }

  /** @returns {SupportSeed|null} the oldest priority seed, else the oldest normal one; its cells stop being pending */
  shift() {
    let seed = null;
    if (this._ph < this._priority.length) {
      seed = this._priority[this._ph];
      this._priority[this._ph++] = /** @type {*} */ (null);
      if (this._ph > 64 && this._ph * 2 > this._priority.length) {
        this._priority = this._priority.slice(this._ph);
        this._ph = 0;
      }
    } else if (this._nh < this._normal.length) {
      seed = this._normal[this._nh];
      this._normal[this._nh++] = /** @type {*} */ (null);
      if (this._nh > 64 && this._nh * 2 > this._normal.length) {
        this._normal = this._normal.slice(this._nh);
        this._nh = 0;
      }
    }
    if (seed) for (const c of seed.cells) this.pendingCells.delete(packCell(c[0], c[1], c[2]));
    return seed;
  }

  /** @returns {SupportSeed|null} the seed shift() would return, without removing it */
  peek() {
    if (this._ph < this._priority.length) return this._priority[this._ph];
    if (this._nh < this._normal.length) return this._normal[this._nh];
    return null;
  }

  clear() {
    this._priority.length = 0;
    this._normal.length = 0;
    this._ph = 0;
    this._nh = 0;
    this.pendingCells.clear();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Save overlay: the live world plus the cells settled into the save, so saving never mutates the world.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A copy-on-write view used while building a save: `peek` reads the overlay, then the live world; `set` records a
 * cell in the overlay and in the edits that will be exported. Feature modules' `settleInto(overlay)` write their
 * in-flight entities (fallers, logs, lit barrels) into it.
 */
export class SaveOverlay {
  /** @param {*} world */
  constructor(world) {
    this.world = world;
    /** @type {Map<number, number>} packed cell → id */
    this.cells = new Map();
    /** @type {Map<string, Map<number, number>>} chunk key → localIndex → id, overriding world.edits */
    this.extra = new Map();
  }

  /** @returns {number} id at the cell as the save will see it (UNLOADED for unloaded chunks, AIR outside 0..127) */
  peek(q, y, r) {
    if (y >= 0 && y < WORLD_HEIGHT) {
      const v = this.cells.get(packCell(q, y, r));
      if (v !== undefined) return v;
    }
    return this.world.peekBlock(q, y, r);
  }

  /** Record `id` at the cell for the save. @returns {boolean} false outside 0..WORLD_HEIGHT−1 */
  set(q, y, r, id) {
    if (!(y >= 0 && y < WORLD_HEIGHT) || !Number.isInteger(id)) return false;
    this.cells.set(packCell(q, y, r), id);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const key = chunkKey(cq, cr);
    let m = this.extra.get(key);
    if (m === undefined) {
      m = new Map();
      this.extra.set(key, m);
    }
    m.set(localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE), id);
    return true;
  }

  /**
   * The edits to save: world.edits overridden by the overlay, with flowing / falling water left out (CONTRACTS
   * §33.9, §35.6): a FLOW/FALL edit whose origin is AIR or WATER is dropped (the cell reloads as generated — a refilled
   * hole in a lake is lake again, not an air pocket), any other becomes AIR — sources re-flow on load.
   * @returns {EditsJSON} fresh arrays
   */
  toJSON() {
    /** @type {EditsJSON} */
    const out = {};
    const origins = this.world.origins instanceof Map ? this.world.origins : null;
    const emit = (key, entries) => {
      const chunkOrigins = origins ? origins.get(key) : undefined;
      const arr = [];
      for (const [li, rawId] of entries) {
        let id = rawId;
        if (isWater(id) && !isWaterSource(id)) {
          const origin = chunkOrigins ? chunkOrigins.get(li) : undefined;
          if (origin === BLOCK.AIR || origin === BLOCK.WATER) continue;
          id = BLOCK.AIR;
        }
        arr.push(li, id);
      }
      if (arr.length > 0) out[key] = arr;
    };
    for (const [key, chunkEdits] of this.world.edits) {
      const extra = this.extra.get(key);
      if (extra === undefined) {
        emit(key, chunkEdits);
      } else {
        const merged = new Map(chunkEdits);
        for (const [li, id] of extra) merged.set(li, id);
        emit(key, merged);
      }
    }
    for (const [key, extra] of this.extra) if (!this.world.edits.has(key)) emit(key, extra);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// BlockPhysics
// ---------------------------------------------------------------------------------------------------------------------

export class BlockPhysics {
  /**
   * @param {*} world   a World (or any object with its physics surface: peekBlock, getBlock, setBlock(q,y,r,id,lazy),
   *                    hasChunkAtCell, editCount, hasEdit, originAt, terrainHeightAt, isNaturalGround, edits, seed)
   * @param {PhysicsHooks} [hooks]
   * @param {{ now?: () => number }} [opts]  ms clock for the tick budget (default: the world's clock, else 0)
   */
  constructor(world, hooks = {}, opts = {}) {
    this.world = world;
    /** @type {Required<PhysicsHooks>} */
    this.hooks = /** @type {*} */ ({});
    for (const name of HOOK_NAMES) {
      const fn = hooks && typeof hooks[name] === 'function' ? hooks[name] : DEFAULT_HOOKS[name];
      this.hooks[name] = fn;
    }
    const worldNow = world && typeof world._now === 'function' ? world._now : null;
    /** @type {() => number} */
    this._now = typeof opts.now === 'function' ? opts.now : worldNow ?? (() => 0);

    /** feature switches (saved per world); a switched-off feature drops its triggers and skips its rules */
    this.switches = { falling: true, water: true, collapse: true, explosions: true };
    /** bumps on every switch change (main's autosave watches it) */
    this.switchVersion = 0;
    /** console `physics off`: no ticks and frozen entities; triggers still queue (not saved) */
    this.paused = false;

    this.tickCount = 0;
    /** seconds of play time seen by step() (paused or not); undo windows are measured on it */
    this.time = 0;
    this._acc = 0;
    this.stats = { ticks: 0, updates: 0, lastTickUpdates: 0, lastTickMs: 0, lastSupportVisits: 0 };
    /** ticks in a row the fall / misc rings spent the whole budget while a collapse was pending */
    this._supportStarved = 0;

    this._rings = [new CellRing(), new CellRing(), new CellRing()];
    /** @type {{ name: string, feature: string|null, mask: Uint8Array|null, update: Function }[][]} per ring index */
    this._rules = [[], [], []];
    /** @type {{ name: string, feature: string|null, fn: Function }[]} */
    this._triggers = [];
    /** @type {{ name: string, feature: string|null, mask: Uint8Array, fn: Function }[]} */
    this._reseeders = [];
    this._reseedMask = new Uint8Array(256);

    /** @type {Map<string, Set<number>>} chunk key → parked ring·PARK_STRIDE + packed cell */
    this._parked = new Map();
    this._parkedCount = 0;
    this.parkedDropped = 0;
    this._parkReq = false;
    this._parkQ = 0;
    this._parkR = 0;

    this.seeds = new SeedQueue();
    /** @type {Map<number, number[]>} neighbour cells collected while area jobs run */
    this._areaCells = new Map();
    /** @type {number[][]} removals collected while area jobs run */
    this._areaRemoved = [];

    this._writeMode = WRITE_EXTERNAL;
    this._writeSeq = 0;
    /** @type {Cause|null} */
    this._cause = null;
    /** @type {PhysicsEvent|null} event that ctx.write currently records into */
    this._event = null;
    /** @type {(PhysicsEvent|null)[]} */
    this._eventStack = [];
    /** @type {PhysicsEvent|null} the one undoable event */
    this.lastEvent = null;
    this._eventSeq = 0;
    this._cappedSaid = false;

    this._rng = mulberry32(((world && world.seed) >>> 0) ^ 0x5eed9e37);
    this._cell = [0, 0, 0];
    this._budget = { updates: 0, start: 0, out: false };

    /** @type {RenderItem[]} pooled render items; renderItems() fills the first `count` */
    this._itemPool = [];
    this._renderList = { items: this._itemPool, count: 0 };
    this._push = (id, x, y, z, rx = 0, ry = 0, rz = 0, scale = 1) => {
      const list = this._renderList;
      let it = this._itemPool[list.count];
      if (it === undefined) {
        it = { id: 0, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
        this._itemPool.push(it);
      }
      it.id = id;
      it.x = x;
      it.y = y;
      it.z = z;
      it.rx = rx;
      it.ry = ry;
      it.rz = rz;
      it.scale = scale;
      list.count++;
    };

    /** @type {RuleContext} */
    this.ctx = this._makeContext();
    this._installBuiltins();

    // Feature modules (each registers its own rules in its constructor).
    this.fallers = new FallingBlocks(this);
    this.fluids = new Fluids(this);
    this.support = new SupportSolver(this);
    this.trees = new Trees(this);
    this.explosions = new Explosions(this);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // registry

  /**
   * Register (or replace, by name) a rule. See RuleSpec.
   * @param {string} name
   * @param {RuleSpec & { rings?: string|string[] }} spec
   */
  registerRule(name, spec) {
    this.unregisterRule(name);
    const ringsSpec = spec.rings ?? spec.ring;
    const rings = Array.isArray(ringsSpec) ? ringsSpec : [ringsSpec];
    if (typeof spec.update !== 'function') throw new TypeError(`registerRule ${name}: update must be a function`);
    const rule = { name, feature: spec.feature ?? null, mask: idMask(spec.ids), update: spec.update, warned: false };
    for (const ring of rings) this._rules[ringIndex(ring)].push(rule);
  }

  /** @returns {boolean} a rule of that name existed */
  unregisterRule(name) {
    let found = false;
    for (const list of this._rules) {
      const i = list.findIndex((r) => r.name === name);
      if (i >= 0) {
        list.splice(i, 1);
        found = true;
      }
    }
    return found;
  }

  /** @returns {string[]} registered rule names of a ring, in run order */
  ruleNames(ring) {
    return this._rules[ringIndex(ring)].map((r) => r.name);
  }

  /**
   * Register (or replace, by name) a trigger: called from onBlockChange for every block change while its feature is
   * on. Built-ins: 'gravity' (falling), 'water' (water), 'ignite' (explosions).
   * @param {string} name
   * @param {string|null} feature
   * @param {(q: number, y: number, r: number, prev: number, next: number, mode: number) => void} fn
   */
  addTrigger(name, feature, fn) {
    this.removeTrigger(name);
    this._triggers.push({ name, feature, fn });
  }

  /** @returns {boolean} */
  removeTrigger(name) {
    const i = this._triggers.findIndex((t) => t.name === name);
    if (i < 0) return false;
    this._triggers.splice(i, 1);
    return true;
  }

  /**
   * Register (or replace, by name) a reseeder: when a chunk is generated (first load, or reloaded after streaming
   * out), every EDITED cell of it whose id is in `ids` is handed to fn(ctx, q, y, r, id), which schedules what must
   * resume. Built-ins: 'gravity', 'water', 'ignite'.
   * @param {string} name
   * @param {string|null} feature
   * @param {number[]} ids
   * @param {(ctx: RuleContext, q: number, y: number, r: number, id: number) => void} fn
   */
  addReseeder(name, feature, ids, fn) {
    this.removeReseeder(name);
    this._reseeders.push({ name, feature, mask: /** @type {Uint8Array} */ (idMask(ids)), fn });
    this._rebuildReseedMask();
  }

  /** @returns {boolean} */
  removeReseeder(name) {
    const i = this._reseeders.findIndex((t) => t.name === name);
    if (i < 0) return false;
    this._reseeders.splice(i, 1);
    this._rebuildReseedMask();
    return true;
  }

  _rebuildReseedMask() {
    this._reseedMask.fill(0);
    for (const rs of this._reseeders) for (let id = 0; id < 256; id++) if (rs.mask[id]) this._reseedMask[id] = 1;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // scheduling

  /**
   * Queue cell (q, y, r) in `ring`, due after the ring's delay (or `delay` ticks, ≥ 1). Deduplicated: a cell already
   * queued in that ring keeps its earlier slot. Queues even while paused.
   * @returns {boolean} newly queued
   */
  schedule(ring, q, y, r, delay) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return false;
    const ri = ringIndex(ring);
    const d = Number.isInteger(delay) && delay >= 1 ? delay : RING_DELAY[ri];
    return this._rings[ri].push(packCell(q, y, r), this.tickCount + d);
  }

  /** @returns {number} updates waiting in `ring` (all rings when omitted) */
  queued(ring) {
    if (ring === undefined) return this._rings[0].size + this._rings[1].size + this._rings[2].size;
    return this._rings[ringIndex(ring)].size;
  }

  /** @returns {boolean} cell (q, y, r) is queued in `ring` */
  isQueued(ring, q, y, r) {
    return this._rings[ringIndex(ring)].queued.has(packCell(q, y, r));
  }

  /** @returns {number} updates parked on unloaded chunks */
  get parkedCount() {
    return this._parkedCount;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // switches

  /** @returns {boolean} the feature's switch is on (does not look at `paused`) */
  isEnabled(feature) {
    return this.switches[feature] === true;
  }

  /**
   * Turn a feature on or off. Off drops what it has queued (support seeds for 'collapse'); its queued cell updates are
   * skipped when they come up. The feature module hears about it through `onSwitch(on)` when it has one.
   * @returns {boolean} changed
   */
  setSwitch(name, on) {
    if (!FEATURES.includes(name)) return false;
    const v = !!on;
    if (this.switches[name] === v) return false;
    this.switches[name] = v;
    this.switchVersion++;
    if (name === 'collapse' && !v) {
      this.seeds.clear();
      this._areaCells.clear();
      this._areaRemoved.length = 0;
    }
    const owners = { falling: [this.fallers], water: [this.fluids], collapse: [this.support, this.trees], explosions: [this.explosions] }[name];
    for (const m of owners) if (m && typeof m.onSwitch === 'function') m.onSwitch(v);
    return true;
  }

  /** Console `physics off|on`: stop / resume ticks and entity motion. Not saved. */
  setPaused(on) {
    this.paused = !!on;
  }

  /** @returns {{ falling: boolean, water: boolean, collapse: boolean, explosions: boolean }} a copy for the save */
  exportSwitches() {
    return { falling: this.switches.falling, water: this.switches.water, collapse: this.switches.collapse, explosions: this.switches.explosions };
  }

  /** Apply saved switches (missing / non-boolean fields → on). Does not bump switchVersion. */
  importSwitches(raw) {
    for (const name of FEATURES) {
      const v = raw && typeof raw === 'object' && typeof raw[name] === 'boolean' ? raw[name] : true;
      if (this.switches[name] !== v) {
        const before = this.switchVersion;
        this.setSwitch(name, v);
        this.switchVersion = before;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // causes and events

  /** Run fn with the player as the cause of every change it makes (main wraps break / place). */
  asPlayer(fn) {
    const p = this.hooks.player();
    return this.withCause(p ? { kind: 'player', x: p.x, y: p.y, z: p.z } : { kind: 'player' }, fn);
  }

  /** Run fn with `cause` as the cause of its changes. */
  withCause(cause, fn) {
    const prev = this._cause;
    this._cause = cause;
    try {
      return fn();
    } finally {
      this._cause = prev;
    }
  }

  /** @returns {Cause|null} the cause set by asPlayer / withCause, if any */
  get cause() {
    return this._cause;
  }

  /**
   * Open a new undoable event; it replaces the previous one (one level of undo). Writes through ctx.write /
   * writeQuiet are recorded into it until endEvent(); fallers spawned meanwhile remember it (openEventId) and record
   * their landings into it later.
   * @param {string} kind
   * @param {Cause|null} [cause]
   * @returns {PhysicsEvent}
   */
  beginEvent(kind, cause = null) {
    /** @type {PhysicsEvent} */
    const ev = { id: ++this._eventSeq, kind, cause: cause ?? this._cause ?? CAUSE_PHYSICS, time: this.time, cells: new Map(), truncated: false };
    this.lastEvent = ev;
    this._eventStack.push(this._event);
    this._event = ev;
    return ev;
  }

  endEvent() {
    this._event = this._eventStack.length > 0 ? /** @type {PhysicsEvent|null} */ (this._eventStack.pop()) : null;
  }

  /** @returns {number} id of the event writes are currently recorded into (0 = none) */
  get openEventId() {
    return this._event ? this._event.id : 0;
  }

  /**
   * Record later writes into event `id` (e.g. a faller landing) — only while it is still the undoable one.
   * @returns {PhysicsEvent|null} token for exitEvent
   */
  enterEvent(id) {
    const prev = this._event;
    this._event = id > 0 && this.lastEvent && this.lastEvent.id === id ? this.lastEvent : null;
    return prev;
  }

  /** @param {PhysicsEvent|null} token from enterEvent */
  exitEvent(token) {
    this._event = token;
  }

  /** Run fn with writes recorded into event `id` (an id or a PhysicsEvent). */
  withEvent(id, fn) {
    const token = this.enterEvent(typeof id === 'object' && id ? id.id : id);
    try {
      return fn();
    } finally {
      this.exitEvent(token);
    }
  }

  /** @returns {boolean} there is an event undo() would act on */
  get canUndo() {
    return this.lastEvent !== null && this.time - this.lastEvent.time <= UNDO_WINDOW_S;
  }

  /**
   * Undo the last physics event within UNDO_WINDOW_S: remove its entities still in flight (fallers, logs, debris,
   * lit barrels — the latter refunded as barrels by explosions.cancelEvent), then restore every recorded cell whose
   * current id is still what the event wrote — or, where the event wrote AIR, water that has flowed in since (a
   * flooded crater fills back in instead of leaving water pockets inside the restored ground, CONTRACTS §38.3).
   * Writes are quiet (no support seeds) and lazy.
   * @returns {{ ok: boolean, message: string, restored: number }}
   */
  undo() {
    const ev = this.lastEvent;
    if (!ev) return { ok: false, message: 'nothing to undo (only the last explosion, collapse or falling tree can be undone)', restored: 0 };
    if (this.time - ev.time > UNDO_WINDOW_S) {
      this.lastEvent = null;
      return { ok: false, message: `the last ${ev.kind} was more than ${UNDO_WINDOW_S} s ago — too late to undo`, restored: 0 };
    }
    this.lastEvent = null;
    const savedEvent = this._event;
    this._event = null;
    let inFlight = 0;
    inFlight += this.fallers.cancelEvent(ev.id) | 0;
    inFlight += this.trees.cancelEvent(ev.id) | 0;
    inFlight += this.explosions.cancelEvent(ev.id) | 0;
    let restored = 0;
    let changed = 0;
    let unloaded = 0;
    const c = this._cell;
    for (const [key, code] of ev.cells) {
      unpackCell(key, c);
      const prev = Math.floor(code / 256);
      const wrote = code - prev * 256;
      const current = this.world.peekBlock(c[0], c[1], c[2]);
      if (current === UNLOADED) {
        unloaded++;
        continue;
      }
      if (current !== wrote && !(wrote === BLOCK.AIR && isWater(current))) {
        changed++;
        continue;
      }
      if (prev === wrote) continue;
      if (this._write(c[0], c[1], c[2], prev, WRITE_QUIET, true) === 'ok') restored++;
    }
    this._event = savedEvent;
    let message = `undid the ${ev.kind}: restored ${restored} block${restored === 1 ? '' : 's'}`;
    if (inFlight > 0) message += `, removed ${inFlight} still in flight`;
    if (changed > 0) message += ` (${changed} changed since, left alone)`;
    if (unloaded > 0) message += ` (${unloaded} in unloaded chunks)`;
    if (ev.truncated) message += ' (the event was too large to record completely)';
    return { ok: true, message, restored };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // block changes (main forwards World.onBlockChange) and streaming (World.onChunkGenerated)

  /**
   * Every block change from any source: run the triggers of the switched-on features, then seed a support check when
   * a load-bearing cell was removed (unless the write was quiet; while area jobs run, external removals are collected
   * and searched once the jobs end).
   */
  onBlockChange(q, y, r, prev, next) {
    const mode = this._writeMode;
    const triggers = this._triggers;
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      if (t.feature !== null && this.switches[t.feature] !== true) continue;
      t.fn(q, y, r, prev, next, mode);
    }
    if (this.switches.collapse && mode !== WRITE_QUIET && isLoadBearing(prev) && !isLoadBearing(next)) {
      if (mode === WRITE_EXTERNAL && this._cause === null && this.hooks.areaJobsActive()) {
        this.collectAreaSeed(q, y, r, prev);
      } else {
        const cause = this._cause ?? (mode === WRITE_EXTERNAL ? CAUSE_WORLD : CAUSE_PHYSICS);
        this.seedRemoval(q, y, r, prev, { cause, priority: cause.kind === 'player' });
      }
    }
  }

  /** A chunk was generated: re-queue the updates parked on it, then re-seed its edited physics-active cells. */
  onChunkGenerated(cq, cr) {
    const key = chunkKey(cq, cr);
    const parked = this._parked.get(key);
    if (parked !== undefined) {
      this._parked.delete(key);
      this._parkedCount -= parked.size;
      for (const pk of parked) {
        const ri = Math.floor(pk / PARK_STRIDE);
        this._rings[ri].push(pk - ri * PARK_STRIDE, this.tickCount + 1);
      }
    }
    if (this._reseeders.length === 0 || !this.world.edits) return;
    const chunkEdits = this.world.edits.get(key);
    if (chunkEdits === undefined) return;
    const mask = this._reseedMask;
    const q0 = cq * CHUNK_SIZE;
    const r0 = cr * CHUNK_SIZE;
    for (const [li, id] of chunkEdits) {
      if (mask[id] === 0) continue;
      const y = li % WORLD_HEIGHT;
      const col = (li - y) / WORLD_HEIGHT;
      const lr = col % CHUNK_SIZE;
      const q = q0 + (col - lr) / CHUNK_SIZE;
      const r = r0 + lr;
      for (const rs of this._reseeders) {
        if (rs.mask[id] === 0) continue;
        if (rs.feature !== null && this.switches[rs.feature] !== true) continue;
        rs.fn(this.ctx, q, y, r, id);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // support seeds (the search itself is support.js)

  /**
   * Queue a support check of `cells` (e.g. a crater rim). Dropped while collapse is off.
   * @param {number[][]} cells   [q, y, r][]
   * @param {{ priority?: boolean, cause?: Cause|null, removed?: number[][] }} [opts]
   * @returns {boolean} queued
   */
  seedSupport(cells, opts = {}) {
    if (!this.switches.collapse || !Array.isArray(cells)) return false;
    const removed = Array.isArray(opts.removed) ? opts.removed : [];
    if (cells.length === 0 && removed.length === 0) return false;
    return this.seeds.push({
      cells: cells.slice(),
      removed,
      cause: opts.cause ?? this._cause ?? CAUSE_PHYSICS,
      priority: !!opts.priority,
      event: this.openEventId,
      tick: this.tickCount,
    });
  }

  /**
   * Seed the load-bearing neighbours of a removed cell (prev = the id it had).
   * @param {{ priority?: boolean, cause?: Cause|null }} [opts]
   * @returns {boolean} queued
   */
  seedRemoval(q, y, r, prev, opts = {}) {
    if (!this.switches.collapse) return false;
    const cells = this._loadBearingNeighbours(q, y, r);
    if (cells.length === 0) return false;
    return this.seedSupport(cells, { ...opts, removed: [[q, y, r, prev, this._wasAnchor(q, y, r, prev) ? 1 : 0]] });
  }

  /**
   * While area commands run, removals are collected here instead of being searched one by one; the batch becomes ONE
   * seed (cause 'area') at the first tick with no active area job.
   */
  collectAreaSeed(q, y, r, prev) {
    if (!this.switches.collapse) return;
    this._areaRemoved.push([q, y, r, prev, this._wasAnchor(q, y, r, prev) ? 1 : 0]);
    for (const c of this._loadBearingNeighbours(q, y, r)) this._areaCells.set(packCell(c[0], c[1], c[2]), c);
  }

  /** @returns {number} removals collected for the next area seed */
  get areaSeedCount() {
    return this._areaRemoved.length;
  }

  /** Turn the collected area removals into one seed now (normally automatic once no area job runs). */
  flushAreaSeeds() {
    if (this._areaRemoved.length === 0) return false;
    const cells = [...this._areaCells.values()];
    const removed = this._areaRemoved;
    this._areaCells = new Map();
    this._areaRemoved = [];
    return this.seedSupport(cells, { cause: CAUSE_AREA, removed });
  }

  _loadBearingNeighbours(q, y, r) {
    const cells = [];
    for (const [dq, dy, dr] of NEIGHBOURS) {
      const ny = y + dy;
      if (!(ny >= 0 && ny < WORLD_HEIGHT)) continue;
      if (isLoadBearing(this.world.peekBlock(q + dq, ny, r + dr))) cells.push([q + dq, ny, r + dr]);
    }
    return cells;
  }

  /** Was the removed cell itself an anchor (untouched terrain, bedrock or y = 0) before it was removed? */
  _wasAnchor(q, y, r, prev) {
    if (y === 0 || prev === BLOCK.BEDROCK) return true;
    const w = this.world;
    if (!isSolid(prev) || typeof w.terrainHeightAt !== 'function' || typeof w.originAt !== 'function') return false;
    // The write already happened: the cell had no edit before it iff its recorded origin is the id it had.
    return y <= w.terrainHeightAt(q, r) && w.originAt(q, y, r) === prev;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // per frame

  /**
   * Advance physics by dt seconds: at most ONE tick (the leftover beyond one tick is dropped, so below 20 fps physics
   * runs in slow motion instead of piling up), then the entities (fallers, trees, lit barrels / blasts). Nothing moves
   * while paused.
   */
  step(dt) {
    if (!(dt > 0)) dt = 0;
    this.time += dt;
    if (this._cappedSaid && this.world.editCount < MAX_TOTAL_EDITS * 0.95) this._cappedSaid = false;
    if (this.paused) return;
    this._acc += dt;
    if (this._acc >= PHYSICS_TICK_S) {
      this._acc = Math.min(this._acc - PHYSICS_TICK_S, PHYSICS_TICK_S);
      this.tick();
    }
    this.fallers.step(dt);
    this.trees.step(dt);
    this.explosions.step(dt);
  }

  /** Run one tick now (tests and step()). */
  tick() {
    this.tickCount++;
    this.stats.ticks++;
    const b = this._budget;
    b.updates = 0;
    b.out = false;
    b.start = this._now();
    this.ctx.deadline = b.start + PHYSICS_TICK_BUDGET_MS;
    if (this._areaRemoved.length > 0 && !this.hooks.areaJobsActive()) this.flushAreaSeeds();

    this._drain(FALL);
    if (!b.out) this._drain(MISC);
    this.stats.lastSupportVisits = 0;
    if (this.switches.collapse && (this.seeds.size > 0 || this.support.busy)) {
      // A long waterfall or gravity cascade can fill the fall ring every tick; a collapse (a cut tree, a crater rim)
      // must not wait for it to calm down: after SUPPORT_STARVE_TICKS starved ticks it gets a small slice anyway.
      if (!b.out) {
        this._supportStarved = 0;
        this.stats.lastSupportVisits = this.support.step(this.ctx, this.seeds, MAX_SUPPORT_VISITS_PER_TICK) | 0;
      } else if (++this._supportStarved >= SUPPORT_STARVE_TICKS) {
        this._supportStarved = 0;
        this.stats.lastSupportVisits = this.support.step(this.ctx, this.seeds, SUPPORT_STARVED_VISITS) | 0;
      }
    } else {
      this._supportStarved = 0;
    }
    if (!b.out) this._drain(WATER);
    this.stats.lastTickUpdates = b.updates;
    this.stats.updates += b.updates;
    this.stats.lastTickMs = this._now() - b.start;
  }

  _drain(ri) {
    const ring = this._rings[ri];
    const b = this._budget;
    const tick = this.tickCount;
    while (ring.size > 0 && ring.headDue() <= tick) {
      if (b.updates >= MAX_CELL_UPDATES_PER_TICK) {
        b.out = true;
        return;
      }
      if (b.updates > 0 && (b.updates & TIME_CHECK_MASK) === 0 && this._now() - b.start >= PHYSICS_TICK_BUDGET_MS) {
        b.out = true;
        return;
      }
      this._runCell(ri, ring.shift());
      b.updates++;
    }
  }

  _runCell(ri, key) {
    const c = unpackCell(key, this._cell);
    const q = c[0];
    const y = c[1];
    const r = c[2];
    let id = this.world.peekBlock(q, y, r);
    if (id === UNLOADED) {
      this._park(ri, key, q, r);
      return;
    }
    const rules = this._rules[ri];
    const ctx = this.ctx;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.feature !== null && this.switches[rule.feature] !== true) continue;
      if (rule.mask !== null && rule.mask[id] === 0) continue;
      ctx.unloadedQ = NaN;
      ctx.unloadedR = NaN;
      this._parkReq = false;
      const seq = this._writeSeq;
      try {
        rule.update(ctx, q, y, r, id);
      } catch (err) {
        if (!rule.warned) {
          rule.warned = true;
          console.warn(`Caelancraft physics: rule ${rule.name} threw (further errors silenced):`, err);
        }
      }
      if (this._parkReq) {
        this._park(ri, key, this._parkQ, this._parkR);
        return;
      }
      if (this._writeSeq !== seq) id = this.world.peekBlock(q, y, r);
    }
  }

  _park(ri, key, q, r) {
    if (this._parkedCount >= MAX_PARKED_UPDATES) {
      this.parkedDropped++;
      return;
    }
    const ck = chunkKey(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE));
    let set = this._parked.get(ck);
    if (set === undefined) {
      set = new Set();
      this._parked.set(ck, set);
    }
    const pk = ri * PARK_STRIDE + key;
    if (!set.has(pk)) {
      set.add(pk);
      this._parkedCount++;
    }
  }

  /**
   * The moving cells to draw this frame (fallers, tumblers, toppling logs), pooled: read `items[0 .. count)`.
   * @returns {{ items: RenderItem[], count: number }}
   */
  renderItems() {
    this._renderList.count = 0;
    this.fallers.renderItems(this._push);
    this.trees.renderItems(this._push);
    this.explosions.renderItems(this._push);
    return this._renderList;
  }

  /**
   * Extra bodies for resolveBodies (lit barrels; explosions.js decides which).
   * @param {PlayerState[]} [out]
   * @returns {PlayerState[]} out
   */
  bodies(out = []) {
    this.explosions.bodies(out);
    return out;
  }

  /**
   * The edits to save, without touching the live world: a copy of world.edits with every in-flight faller settled
   * at its landing cell, logs dropped from their current pose, lit barrels saved as barrels (each feature's
   * settleInto), and FLOW/FALL edits left out (SaveOverlay.toJSON).
   * @returns {EditsJSON}
   */
  exportEdits() {
    const overlay = new SaveOverlay(this.world);
    this.fallers.settleInto(overlay);
    this.trees.settleInto(overlay);
    this.explosions.settleInto(overlay);
    return overlay.toJSON();
  }

  /** Counters for `physics status` and F3. */
  status() {
    return {
      paused: this.paused,
      switches: this.exportSwitches(),
      queued: { fall: this._rings[FALL].size, water: this._rings[WATER].size, misc: this._rings[MISC].size },
      parked: this._parkedCount,
      seeds: this.seeds.size + (this._areaRemoved.length > 0 ? 1 : 0),
      fallers: this.fallers.count,
      tumblers: this.fallers.tumblerCount,
      trees: this.trees.count,
      litBarrels: this.explosions.litCount,
      edits: this.world.editCount,
      tick: this.tickCount,
      lastTickMs: this.stats.lastTickMs,
      lastTickUpdates: this.stats.lastTickUpdates,
      canUndo: this.canUndo,
    };
  }

  /** @returns {string} one line for the console / F3 */
  statusText() {
    const s = this.status();
    const sw = FEATURES.map((f) => `${f} ${s.switches[f] ? 'on' : 'off'}`).join(', ');
    const q = s.queued;
    return `physics ${s.paused ? 'PAUSED' : 'running'} · ${sw} · queued ${q.fall + q.water + q.misc} (fall ${q.fall}, water ${q.water}, misc ${q.misc})` +
      ` · parked ${s.parked} · support seeds ${s.seeds} · falling ${s.fallers} · tumbling ${s.tumblers} · trees ${s.trees}` +
      ` · lit barrels ${s.litBarrels} · edits ${s.edits} / ${MAX_TOTAL_EDITS}${s.canUndo ? ` · undo: ${this.lastEvent.kind}` : ''}`;
  }

  /** Drop everything queued and in flight (the world is unchanged). */
  clear() {
    for (const ring of this._rings) ring.clear();
    this._parked.clear();
    this._parkedCount = 0;
    this.seeds.clear();
    this._areaCells.clear();
    this._areaRemoved.length = 0;
    this.lastEvent = null;
    this._event = null;
    this._eventStack.length = 0;
    for (const m of [this.fallers, this.fluids, this.support, this.trees, this.explosions]) if (typeof m.reset === 'function') m.reset();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // internals

  /**
   * The one physics write path. Lazy World.setBlock; refuses a NEW edit entry once world.editCount reaches
   * MAX_TOTAL_EDITS ('capped', one chat line), records into the open event.
   * @returns {'ok'|'failed'|'capped'}
   */
  _write(q, y, r, id, mode, ignoreCap = false) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return 'failed';
    const world = this.world;
    const current = world.peekBlock(q, y, r);
    if (current === UNLOADED) return 'failed';
    if (current === id) return 'ok';
    if (!ignoreCap && world.editCount >= MAX_TOTAL_EDITS && !world.hasEdit(q, y, r)) {
      if (!this._cappedSaid) {
        this._cappedSaid = true;
        this.hooks.say(`Block physics is holding back: the world already has ${MAX_TOTAL_EDITS} edited cells (the save limit), so water stops spreading and blasts stop breaking blocks.`);
      }
      return 'capped';
    }
    const prevMode = this._writeMode;
    this._writeMode = mode;
    let ok;
    try {
      ok = world.setBlock(q, y, r, id, true);
    } finally {
      this._writeMode = prevMode;
    }
    if (!ok) return 'failed';
    this._writeSeq++;
    const ev = this._event;
    if (ev !== null && ev === this.lastEvent) {
      const k = packCell(q, y, r);
      const old = ev.cells.get(k);
      if (old === undefined) {
        if (ev.cells.size < UNDO_MAX_CELLS) ev.cells.set(k, current * 256 + id);
        else ev.truncated = true;
      } else {
        ev.cells.set(k, old - (old % 256) + id);
      }
    }
    return 'ok';
  }

  /** @returns {RuleContext} */
  _makeContext() {
    const physics = this;
    const world = this.world;
    const hooks = this.hooks;
    const ctx = {
      physics,
      world,
      hooks,
      deadline: 0,
      unloadedQ: NaN,
      unloadedR: NaN,
      get tick() {
        return physics.tickCount;
      },
      get time() {
        return physics.time;
      },
      now: () => physics._now(),
      peek: (q, y, r) => {
        const v = world.peekBlock(q, y, r);
        if (v === UNLOADED) {
          ctx.unloadedQ = q;
          ctx.unloadedR = r;
        }
        return v;
      },
      write: (q, y, r, id) => physics._write(q, y, r, id, WRITE_PHYSICS),
      writeQuiet: (q, y, r, id) => physics._write(q, y, r, id, WRITE_QUIET),
      schedule: (ring, q, y, r, delay) => physics.schedule(ring, q, y, r, delay),
      park: (q, r) => {
        const pq = q === undefined ? ctx.unloadedQ : q;
        const pr = r === undefined ? ctx.unloadedR : r;
        if (!Number.isFinite(pq + pr)) return;
        physics._parkReq = true;
        physics._parkQ = pq;
        physics._parkR = pr;
      },
      random: () => physics._rng(),
      say: (text) => hooks.say(text),
      sound: (name, x, y, z, volume = 1) => hooks.sound(name, x, y, z, volume),
      particles: (kind, x, y, z, count = 8, opts = undefined) => hooks.particles(kind, x, y, z, count, opts),
      get fallers() {
        return physics.fallers;
      },
      get fluids() {
        return physics.fluids;
      },
      get support() {
        return physics.support;
      },
      get trees() {
        return physics.trees;
      },
      get explosions() {
        return physics.explosions;
      },
    };
    return /** @type {RuleContext} */ (/** @type {*} */ (ctx));
  }

  /** The §2 triggers and reseeders: which cells each kind of change queues, per feature. */
  _installBuiltins() {
    const world = this.world;
    const peek = (q, y, r) => world.peekBlock(q, y, r);

    // ---- falling: the cell above a cell that became fall-through; a gravity block / campfire placed over one.
    this.addTrigger('gravity', 'falling', (q, y, r, prev, next) => {
      if (!isFallThrough(prev) && isFallThrough(next)) {
        const above = peek(q, y + 1, r);
        if (isGravityBlock(above) || above === BLOCK.CAMPFIRE) this.schedule('fall', q, y + 1, r);
      }
      if ((isGravityBlock(next) || next === BLOCK.CAMPFIRE) && isFallThrough(peek(q, y - 1, r))) this.schedule('fall', q, y, r);
    });
    this.addReseeder('gravity', 'falling', [BLOCK.SAND, BLOCK.RED_SAND, BLOCK.GRAVEL, BLOCK.CAMPFIRE], (ctx, q, y, r) => {
      if (isFallThrough(peek(q, y - 1, r))) this.schedule('fall', q, y, r);
    });

    // ---- water: any change involving water, or a change of fall-through-ness / solidity next to water, queues the
    // cell and its water / air neighbours. Cells that are (or are about to become) falling water use the fall ring.
    this.addTrigger('water', 'water', (q, y, r, prev, next) => {
      if (isWater(prev) || isWater(next)) {
        this.scheduleWaterAround(q, y, r);
      } else if ((isFallThrough(prev) !== isFallThrough(next) || isSolid(prev) !== isSolid(next)) && this._hasWaterNeighbour(q, y, r)) {
        this.scheduleWaterAround(q, y, r);
      }
    });
    const waterIds = [BLOCK.WATER, BLOCK.WATER_FLOW_1, BLOCK.WATER_FLOW_2, BLOCK.WATER_FLOW_3, BLOCK.WATER_FLOW_4,
      BLOCK.WATER_FLOW_5, BLOCK.WATER_FLOW_6, BLOCK.WATER_FALL];
    this.addReseeder('water', 'water', waterIds, (ctx, q, y, r, id) => {
      // Sources only wake their open neighbours (flow edits are not saved: this is how a lake re-flows on load).
      if (isWaterSource(id)) this._scheduleOpenNeighbours(q, y, r);
      else this.scheduleWaterAround(q, y, r);
    });

    // ---- explosions: a campfire and a barrel ending up next to each other queue the barrel (ignition, misc ring).
    this.addTrigger('ignite', 'explosions', (q, y, r, prev, next) => {
      if (next === BLOCK.CAMPFIRE) {
        for (const [dq, dy, dr] of NEIGHBOURS) {
          if (peek(q + dq, y + dy, r + dr) === BLOCK.BLAST_BARREL) this.schedule('misc', q + dq, y + dy, r + dr);
        }
      } else if (next === BLOCK.BLAST_BARREL && this._hasNeighbour(q, y, r, BLOCK.CAMPFIRE)) {
        this.schedule('misc', q, y, r);
      }
    });
    this.addReseeder('ignite', 'explosions', [BLOCK.BLAST_BARREL], (ctx, q, y, r) => {
      if (this._hasNeighbour(q, y, r, BLOCK.CAMPFIRE)) this.schedule('misc', q, y, r);
    });
  }

  /**
   * Queue cell (q, y, r) and its water / air / campfire neighbours for the water rule: falling water (and an open cell
   * under water) in the `fall` ring, everything else in the `water` ring.
   */
  scheduleWaterAround(q, y, r) {
    this._scheduleWaterCell(q, y, r);
    for (const [dq, dy, dr] of NEIGHBOURS) this._scheduleWaterCell(q + dq, y + dy, r + dr);
  }

  _scheduleWaterCell(q, y, r) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return;
    const id = this.world.peekBlock(q, y, r);
    if (!(isWater(id) || id === BLOCK.AIR || id === BLOCK.CAMPFIRE)) return;
    const intoFall = id === BLOCK.WATER_FALL || (!isWaterSource(id) && isWater(this.world.peekBlock(q, y + 1, r)));
    this.schedule(intoFall ? 'fall' : 'water', q, y, r);
  }

  _scheduleOpenNeighbours(q, y, r) {
    for (const [dq, dy, dr] of NEIGHBOURS) {
      const id = this.world.peekBlock(q + dq, y + dy, r + dr);
      if (id === BLOCK.AIR || id === BLOCK.CAMPFIRE || (isWater(id) && !isWaterSource(id))) this._scheduleWaterCell(q + dq, y + dy, r + dr);
    }
  }

  _hasWaterNeighbour(q, y, r) {
    for (const [dq, dy, dr] of NEIGHBOURS) if (isWater(this.world.peekBlock(q + dq, y + dy, r + dr))) return true;
    return false;
  }

  _hasNeighbour(q, y, r, id) {
    for (const [dq, dy, dr] of NEIGHBOURS) if (this.world.peekBlock(q + dq, y + dy, r + dr) === id) return true;
    return false;
  }
}
