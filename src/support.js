// Caelancraft — collapsing structures: which cells carry load, the support search, and the collapse of what it proves
// floating. See src/CONTRACTS.md §36 and docs/DESIGN-physics.md §5 / §10. PURE: the world is read through ctx.peek
// and written only by fallers.crumble / trees.topple (quiet, lazy, event-recorded writes).
//
// The scheduler (blockphysics.js) owns the seed plumbing: removing a load-bearing cell queues a SupportSeed (its
// load-bearing neighbours + the removal) in `physics.seeds`, player-caused seeds in a priority lane, area-command
// removals batched into one seed. Each tick, while collapse is on and seeds are pending (or `busy`), it calls
// `support.step(ctx, seeds, MAX_SUPPORT_VISITS_PER_TICK)` after the fall / misc rings and before the water ring.
//
// One BATCH = every seed pending when it starts, searched as ONE multi-source search with a shared memo:
//   1. each start cell (seed cells + the load-bearing neighbours of every removal) runs a lowest-y-first DFS over
//      load-bearing cells; it is SUPPORTED on reaching an anchor, an UNLOADED cell, a cell already proven supported in
//      this batch or SUPPORT_LIMIT visits (every cell it visited joins the supported memo), else it found a FLOATING
//      component (all of it: the DFS exhausted it);
//   2. the disconnected-by-this-removal rule picks the components to collapse: one collapses only when a removal next
//      to it was supported — it was an anchor itself or touches a supported cell — directly or through other removals
//      and collapsing components of the batch. A build that already floated stays (sky bases, fill builds);
//   3. each collapsing component is a tree (trees.test → trees.topple) or crumbles (fallers.crumble), inside one
//      undoable event per batch (or the seed's own event while that is still undoable, e.g. the blast that cut it).
// Every part of a batch keeps its state across ticks (`busy`) and stops on the tick's deadline (CONTRACTS §36.1.4):
// taking the seeds in, the sweep over its start cells, the DFS (MAX_SUPPORT_VISITS_PER_TICK visits), the rule's scans
// over the removals and the crumble of a big component (a slice of CRUMBLE_SLICE cells at a time, lowest first) — a
// 30 000-cell `fill … air` is searched over a few ticks instead of freezing one frame.
import { CHUNK_SIZE, MAX_FALLING, SUPPORT_LIMIT, TREE_MAX_CELLS, WORLD_HEIGHT } from './config.js';
import { BLOCK, UNLOADED, isFallThrough, isLeaves, isSolid } from './blocks.js';
import { HEX_DIRS } from './hex.js';
import { packCell, unpackCell } from './coords.js';

/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').RuleContext} RuleContext */
/** @typedef {import('./blockphysics.js').SeedQueue} SeedQueue */
/** @typedef {import('./blockphysics.js').SupportSeed} SupportSeed */
/** @typedef {import('./blockphysics.js').PhysicsEvent} PhysicsEvent */
/** @typedef {import('./blockphysics.js').Cause} Cause */

/**
 * A connected set of load-bearing cells the search proved floating (handed to trees.test / fallers.crumble).
 * @typedef {Object} FloatingComponent
 * @property {number[][]} cells   [q, y, r, id][] — every cell of the component (rune blocks / black holes excluded)
 * @property {Cause} cause        the seed's cause (topple direction)
 * @property {number} event       physics event id the collapse records into (0 = none)
 */

/** Chat tip on the first crumble a SupportSolver sees (one per loaded world). */
export const COLLAPSE_TIP = 'Builds must touch the ground! (Esc → Physics to turn collapse off)';

/** The tick's time budget is checked every this many visits. */
const DEADLINE_CHECK_VISITS = 256;
/**
 * … and every this many units of the batch's cheap work: a seed taken in, a start cell looked at, a removal scanned by
 * the rule. A step does at most `maxVisits · CHEAP_PER_VISIT` of them (the count backstop when the clock does not move).
 */
const DEADLINE_CHECK_CHEAP = 256;
const CHEAP_PER_VISIT = 8;
/** A big component crumbles this many cells (lowest first) between two deadline checks (CONTRACTS §36.3.1). */
export const CRUMBLE_SLICE = 64;
/** A search verdict over more cells than this is written into the memo a slice at a time (cheap units, §36.1.4). */
const FINISH_SLICE = 512;
/** Crumble order key: y · 2^42 + the packed column, so a plain numeric sort gives (y, q, r) (CONTRACTS §34.2.4). */
const Y_STRIDE = 2 ** 42;
/** The `mode` a trigger receives for player / command / rune writes (blockphysics.js WRITE_EXTERNAL, CONTRACTS §33). */
const MODE_EXTERNAL = 0;

/**
 * DFS push order as [dq, dy, dr]: above, the six sides, below — the stack pops the cell below first, then the sides,
 * then the one above, so a search heads for the ground first.
 */
const PUSH_ORDER = Object.freeze([
  Object.freeze([0, 1, 0]), ...HEX_DIRS.map(([dq, dr]) => Object.freeze([dq, 0, dr])), Object.freeze([0, -1, 0]),
]);
/** PUSH_ORDER as indices into peekNeighbours' order (the 6 sides, above, below). */
const PUSH_FROM_NEIGHBOURS = Object.freeze([6, 0, 1, 2, 3, 4, 5, 7]);

/** The 8 neighbours as offsets of a packCell key: the 6 sides (HEX_DIRS), above, below (y stays in 0..127). */
const KEY_OFFSETS = Object.freeze([
  ...HEX_DIRS.map(([dq, dr]) => packCell(dq, 0, dr) - packCell(0, 0, 0)), 1, -1,
]);
/** The same neighbours as offsets into a chunk's blocks array (localIndex: Y innermost, CONTRACTS §2). */
const SIDE_INDEX = Object.freeze(HEX_DIRS.map(([dq, dr]) => (dq * CHUNK_SIZE + dr) * WORLD_HEIGHT));
const [SIDE0, SIDE1, SIDE2, SIDE3, SIDE4, SIDE5] = SIDE_INDEX;

const PHASE_TAKE = 0; // taking in the seeds that were pending when the batch began
const PHASE_SEARCH = 1; // resolving the start cells (DFS)
const PHASE_INDEX = 2; // the rule: removals indexed by cell
const PHASE_SCAN = 3; // the rule: which removals were supported, which components they touch
const PHASE_SPREAD = 4; // the rule: propagation through removals and components
const PHASE_COLLAPSE = 5;

/** @returns {number} the packCell key of a crumble order value (y · Y_STRIDE + column) */
function orderKey(v) {
  const y = Math.floor(v / Y_STRIDE);
  return (v - y * Y_STRIDE) * WORLD_HEIGHT + y;
}

/**
 * The ids of the 8 neighbours of cell (q, y, r) — the 6 sides (HEX_DIRS order), above, below — exactly as
 * `world.peekBlock` returns them (UNLOADED in unloaded chunks, AIR outside 0..127). A cell away from its chunk's edges
 * is read straight from the chunk's blocks (one chunk lookup instead of eight) when the world has `getChunk`.
 * @param {*} world
 * @param {number} q   integer
 * @param {number} y   integer
 * @param {number} r   integer
 * @param {Uint8Array|number[]} out  8 slots
 * @param {*} [chunk]  the loaded chunk of column (q, r) when the caller already has it (saves the lookup)
 * @returns {Uint8Array|number[]} out
 */
export function peekNeighbours(world, q, y, r, out, chunk) {
  if (y > 0 && y < WORLD_HEIGHT - 1 && (chunk || typeof world.getChunk === 'function')) {
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const ch = chunk || world.getChunk(cq, cr);
    if (ch === undefined || ch === null) {
      for (let k = 0; k < 8; k++) out[k] = UNLOADED;
      return out;
    }
    const lq = q - cq * CHUNK_SIZE;
    const lr = r - cr * CHUNK_SIZE;
    const blocks = ch.blocks;
    const i = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y;
    if (lq > 0 && lq < CHUNK_SIZE - 1 && lr > 0 && lr < CHUNK_SIZE - 1) {
      out[0] = blocks[i + SIDE0];
      out[1] = blocks[i + SIDE1];
      out[2] = blocks[i + SIDE2];
      out[3] = blocks[i + SIDE3];
      out[4] = blocks[i + SIDE4];
      out[5] = blocks[i + SIDE5];
    } else {
      // On the chunk's edge: the sides that leave it are read from their own chunk.
      for (let k = 0; k < 6; k++) {
        const nq = lq + HEX_DIRS[k][0];
        const nr = lr + HEX_DIRS[k][1];
        out[k] = nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE ? blocks[i + SIDE_INDEX[k]] : world.peekBlock(q + HEX_DIRS[k][0], y, r + HEX_DIRS[k][1]);
      }
    }
    out[6] = blocks[i + 1];
    out[7] = blocks[i - 1];
    return out;
  }
  for (let k = 0; k < 6; k++) out[k] = world.peekBlock(q + HEX_DIRS[k][0], y, r + HEX_DIRS[k][1]);
  out[6] = world.peekBlock(q, y + 1, r);
  out[7] = world.peekBlock(q, y - 1, r);
  return out;
}

/**
 * Carries load: solid and not leaves (leaves never hold anything up — a canopy touching a hill or another tree must
 * not keep a cut trunk standing), and not a rune block (self-anchored but holding nothing). Gravity blocks resting in
 * place count. CAMPFIRE, liquids, AIR and the UNLOADED sentinel do not.
 * @param {number} id
 * @returns {boolean}
 */
export function isLoadBearing(id) {
  return isSolid(id) && !isLeaves(id) && id !== BLOCK.RUNE_BLOCK;
}

/** Never falls but holds nothing up: rune blocks (their scripts would be lost) and black holes. */
export function isSelfAnchored(id) {
  return id === BLOCK.RUNE_BLOCK || id === BLOCK.BLACK_HOLE;
}

/**
 * A support search ends (supported) on an anchor: y = 0, bedrock, or untouched terrain (world.isNaturalGround).
 * @param {*} world
 * @returns {boolean}
 */
export function isAnchorCell(world, q, y, r) {
  if (y === 0) return true;
  if (world.peekBlock(q, y, r) === BLOCK.BEDROCK) return true;
  return world.isNaturalGround(q, y, r);
}

/**
 * The DFS of one start cell, resumable across ticks.
 * @typedef {Object} Search
 * @property {number} start       packed start cell
 * @property {number} seed        index of its seed in the batch
 * @property {number[]} stack     packed cells still to visit
 * @property {Set<number>} visited  every cell pushed so far
 * @property {number[]} list      the same cells in visiting order (the component, if it floats)
 * @property {number} count       cells visited (SUPPORT_LIMIT)
 * @property {boolean} restart    a load-bearing cell appeared next to it since it began: start over
 */

/**
 * A component the batch proved floating.
 * @typedef {Object} Component
 * @property {number[]} keys      packed cells
 * @property {number} seed        index of the seed whose start cell found it
 * @property {boolean} stale      the world changed next to it during the batch: never collapsed
 * @property {boolean} collapse   picked by the disconnected-by-this-removal rule
 */

/**
 * A component being crumbled a slice at a time (lowest cells first).
 * @typedef {Object} Crumbling
 * @property {Float64Array} order   its cells as y · Y_STRIDE + packed column, sorted: (y, q, r) — re-read slice by slice
 * @property {number} at            next cell to crumble
 * @property {number} settle        the lowest this many cells settle instantly (the faller slots free when it began)
 * @property {number} leafAt        next cell whose leaves are checked once every cell is down (-1: still crumbling)
 * @property {number} removed       cells crumbled so far
 * @property {SupportSeed} seed     the seed whose start cell found it (cause, event)
 * @property {PhysicsEvent|null} event  the event its writes record into (chosen at its first live slice)
 * @property {boolean} own          the event is the batch's own 'collapse' event
 */

/**
 * A search verdict being written into the memo a slice at a time.
 * @typedef {Object} Finishing
 * @property {Search} search
 * @property {boolean} supported
 * @property {number} at            next index into search.list
 * @property {number} index         component index (floating verdicts)
 */

/**
 * Every part is resumable (cursors), so a batch spreads over as many ticks as its deadline checks need.
 * @typedef {Object} Batch
 * @property {SupportSeed[]} seeds
 * @property {number} take          seeds still to take in (those pending when the batch began)
 * @property {number[][]} removals  [q, y, r, prevId, wasAnchor][] of every seed, in seed order
 * @property {number} si            start-cell cursor: seed index
 * @property {number} ci            … index into that seed's cells
 * @property {number} ri            … index into that seed's removals
 * @property {number} di            … neighbour (PUSH_ORDER index) of that removal
 * @property {number} nbFor         global removal index whose neighbour ids are in `nb` (-1: none)
 * @property {Uint8Array} nb        neighbour ids of that removal (peekNeighbours order)
 * @property {number} at            cursor of the rule's scans (PHASE_INDEX, PHASE_SCAN)
 * @property {Map<number, number>|null} remIndex   packed removed cell → removal index (the rule)
 * @property {number[]} remKeys     packed cell of each removal (the rule)
 * @property {Uint8Array|null} supported           per removal: proven supported (the rule)
 * @property {Map<number, number[]>|null} compRems  component index → adjacent removal indices (the rule)
 * @property {number[]} queue       removals whose support still has to spread (the rule)
 * @property {number} phase         PHASE_TAKE → PHASE_SEARCH → PHASE_INDEX → PHASE_SCAN → PHASE_SPREAD → PHASE_COLLAPSE
 * @property {number[]} collapses   component indices to collapse, in order
 * @property {number} collapseAt    next of them
 * @property {Crumbling|null} crumbling  the component being crumbled now
 * @property {PhysicsEvent|null} event  the batch's own 'collapse' event once one was needed
 */

/**
 * The support search (CONTRACTS §36.2): all seeds of a batch as ONE multi-source, lowest-y-first DFS with a shared
 * memo; supported on an anchor, an UNLOADED cell, a cell proven supported in this batch, or SUPPORT_LIMIT visits; a
 * floating component found from a removal's seeds collapses only if that removed cell was supported. Collapse:
 * `ctx.trees.test(component)` → `ctx.trees.topple(...)`, else `ctx.fallers.crumble(cells)`, inside
 * `physics.beginEvent('collapse', cause)` / `endEvent()`.
 */
export class SupportSolver {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    /** @type {Batch|null} */
    this._batch = null;
    /** @type {Search|null} */
    this._search = null;
    /** @type {Set<number>} packed cells proven supported in the current batch */
    this._supported = new Set();
    /** @type {Map<number, number>} packed cell → index into _components */
    this._floating = new Map();
    /** @type {Component[]} */
    this._components = [];
    this._visits = 0;
    this._sinceCheck = 0;
    this._cheap = 0;
    this._cheapSinceCheck = 0;
    this._maxCheap = Infinity;
    /** the first-crumble chat tip was said (per loaded world: one SupportSolver per World) */
    this.tipSaid = false;
    this._cell = [0, 0, 0];
    /** scratch: neighbour ids (peekNeighbours) */
    this._nb = new Uint8Array(8);
    /** @type {Finishing|null} a big verdict still being written into the memo */
    this._finishing = null;
    /** counters for tests / diagnostics */
    this.stats = { batches: 0, searches: 0, visits: 0, floating: 0, crumbled: 0, toppled: 0, restarts: 0 };

    // A block placed (by the player, a command or a rune) next to a search in progress, or next to a floating
    // component not collapsed yet, may connect it to the ground: restart that search / never collapse that component
    // on a stale verdict. Physics' own landings are ignored (a pile under a falling build changes nothing worth a
    // restart). Removals need no such care — they queue their own seed, searched by the next batch.
    physics.addTrigger('support', 'collapse', (q, y, r, prev, next, mode) => {
      if (this._batch !== null && mode === MODE_EXTERNAL && isLoadBearing(next) && !isLoadBearing(prev)) this._onPlaced(q, y, r);
    });
  }

  /** @returns {boolean} a search is in progress (the scheduler calls step() even with no new seeds) */
  get busy() {
    return this._batch !== null;
  }

  /**
   * Advance the batch by at most `maxVisits` visited cells and `maxVisits · CHEAP_PER_VISIT` units of cheap work (a seed
   * taken in, a start cell looked at, a removal scanned by the rule), and by the tick's time budget: ctx.now() vs
   * ctx.deadline, checked every 256 visits, every 256 cheap units, after each collapsed component and after each
   * crumbled slice. Every part keeps its cursor and resumes next tick. A new batch takes the seeds pending when it
   * begins (`seeds.shift()`, priority lane first); a finished batch collapses what it found floating and the next batch
   * starts while budget is left.
   * @param {RuleContext} ctx
   * @param {SeedQueue} seeds
   * @param {number} maxVisits
   * @returns {number} cells visited this call
   */
  step(ctx, seeds, maxVisits) {
    this._visits = 0;
    this._sinceCheck = 0;
    this._cheap = 0;
    this._cheapSinceCheck = 0;
    const max = maxVisits > 0 ? maxVisits : Infinity;
    this._maxCheap = max * CHEAP_PER_VISIT;
    if (this._batch !== null) this._batch.nbFor = -1; // the world may have changed since the last step
    for (;;) {
      if (this._batch === null) {
        if (seeds.size === 0) break;
        this._beginBatch(seeds);
      }
      const batch = /** @type {Batch} */ (this._batch);
      if (batch.phase === PHASE_TAKE && !this._take(ctx, seeds)) break;
      if (batch.phase === PHASE_SEARCH) {
        if (!this._searchAll(ctx, max)) break; // out of budget: resume next tick
        this._beginDecide();
      }
      if (batch.phase < PHASE_COLLAPSE && !this._decide(ctx)) break;
      if (!this._collapseSome(ctx)) break;
      this._endBatch();
      if (this._visits >= max || this._cheap >= this._maxCheap || ctx.now() >= ctx.deadline) break;
    }
    this.stats.visits += this._visits;
    return this._visits;
  }

  /** Forget any search in progress (collapse switched off, world reset). */
  reset() {
    this._endBatch();
  }

  /** The 'collapse' switch changed (the scheduler already cleared its seeds when switched off). */
  onSwitch(on) {
    if (!on) this.reset();
  }

  /**
   * Undo of event `id` (physics.undo, CONTRACTS §36.3.2): a batch whose collapse records into it — the component still
   * crumbling, or one still to come — stops there; what still hangs stays where it is, like everything undo puts back.
   * @returns {number} 0 (nothing of it is in flight)
   */
  cancelEvent(id) {
    const batch = this._batch;
    if (!(id > 0) || batch === null || batch.phase !== PHASE_COLLAPSE) return 0;
    let hit = (batch.event !== null && batch.event.id === id) || (batch.crumbling !== null && batch.crumbling.event !== null && batch.crumbling.event.id === id);
    for (let k = batch.collapseAt; k < batch.collapses.length && !hit; k++) {
      hit = batch.seeds[this._components[batch.collapses[k]].seed].event === id;
    }
    if (hit) this._endBatch();
    return 0;
  }

  /**
   * Saving (never touches the live world): what the open batch decided to collapse but has not brought down yet — the
   * rest of the component crumbling now and the components after it — is saved fallen. Each of its cells still
   * load-bearing in the overlay, lowest first, is moved down its column like a column faller (CONTRACTS §36.6.4). A
   * burning barrel is left to explosions.settleInto. Runs after fallers.settleInto.
   * @param {import('./blockphysics.js').SaveOverlay} overlay
   */
  settleInto(overlay) {
    const batch = this._batch;
    if (batch === null || batch.phase !== PHASE_COLLAPSE) return;
    /** @type {number[][]} */
    const cells = [];
    const cr = batch.crumbling;
    if (cr !== null && cr.leafAt < 0) for (let i = cr.at; i < cr.order.length; i++) cells.push(unpackCell(orderKey(cr.order[i])));
    for (let k = batch.collapseAt; k < batch.collapses.length; k++) {
      const comp = this._components[batch.collapses[k]];
      if (!comp.stale) for (const key of comp.keys) cells.push(unpackCell(key));
    }
    if (cells.length === 0) return;
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    const explosions = this.physics.explosions;
    for (const [q, y, r] of cells) {
      const id = overlay.peek(q, y, r);
      if (!isLoadBearing(id)) continue;
      if (id === BLOCK.BLAST_BARREL && explosions && typeof explosions.isBurning === 'function' && explosions.isBurning(q, y, r)) continue;
      overlay.set(q, y, r, BLOCK.AIR);
      let cy = y;
      while (cy > 0 && isFallThrough(overlay.peek(q, cy - 1, r))) cy--;
      overlay.set(q, cy, r, id);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // batches

  /** Open a batch for the seeds pending now, with a fresh memo (_take takes them in). */
  _beginBatch(seeds) {
    /** @type {Batch} */
    const batch = {
      seeds: [], take: seeds.size, removals: [], si: 0, ci: 0, ri: 0, di: 0, nbFor: -1, nb: this._nb, at: 0,
      remIndex: null, remKeys: [], supported: null, compRems: null, queue: [], phase: PHASE_TAKE, collapses: [],
      collapseAt: 0, crumbling: null, event: null,
    };
    this._batch = batch;
    this._search = null;
    this._finishing = null;
    this._supported.clear();
    this._floating.clear();
    this._components.length = 0;
    this.stats.batches++;
  }

  _endBatch() {
    this._batch = null;
    this._search = null;
    this._finishing = null;
    this._supported.clear();
    this._floating.clear();
    this._components.length = 0;
  }

  /** Count `units` of cheap work. @returns {boolean} the step is out of budget (count backstop, or the deadline) */
  _spendCheap(ctx, units) {
    this._cheap += units;
    this._cheapSinceCheck += units;
    if (this._cheapSinceCheck >= DEADLINE_CHECK_CHEAP) {
      this._cheapSinceCheck = 0;
      if (ctx.now() >= ctx.deadline) return true;
    }
    return this._cheap >= this._maxCheap;
  }

  /** Take in the seeds that were pending when the batch began. @returns {boolean} done (false: out of budget) */
  _take(ctx, seeds) {
    const batch = /** @type {Batch} */ (this._batch);
    while (batch.take > 0 && seeds.size > 0) {
      const seed = /** @type {SupportSeed} */ (seeds.shift());
      batch.take--;
      batch.seeds.push(seed);
      if (this._spendCheap(ctx, 1 + seed.cells.length) && batch.take > 0 && seeds.size > 0) return false;
    }
    batch.phase = PHASE_SEARCH;
    return true;
  }

  /**
   * Resolve every start cell, in seed order: each seed's cells, then the 8 neighbours (PUSH_ORDER) of each of its
   * removals — the seed queue leaves out cells already pending in an earlier seed, every removal's own neighbours are
   * searched regardless, so the rule sees all of them. A start already in the memo, or not load-bearing, costs one
   * cheap unit; a removal whose 8 neighbours hold nothing load-bearing (inside a dug-out volume) costs one in all.
   * @returns {boolean} done (false: out of budget)
   */
  _searchAll(ctx, max) {
    const batch = /** @type {Batch} */ (this._batch);
    const world = ctx.world;
    const nb = batch.nb;
    for (;;) {
      if (this._finishing !== null) {
        if (!this._finishSome(ctx)) return false;
        continue;
      }
      if (this._search !== null) {
        if (!this._run(ctx, max)) return false;
        continue;
      }
      if (batch.si >= batch.seeds.length) return true;
      const seed = batch.seeds[batch.si];
      if (batch.ci < seed.cells.length) {
        const c = seed.cells[batch.ci++];
        this._begin(ctx, c[0], c[1], c[2], world.peekBlock(c[0], c[1], c[2]), batch.si);
        if (this._spendCheap(ctx, 1)) return false;
        continue;
      }
      if (batch.ri >= seed.removed.length) {
        batch.si++;
        batch.ci = 0;
        batch.ri = 0;
        batch.di = 0;
        continue;
      }
      const rm = seed.removed[batch.ri];
      const here = batch.si * 2 ** 24 + batch.ri;
      if (batch.nbFor !== here) {
        peekNeighbours(world, rm[0], rm[1], rm[2], nb);
        batch.nbFor = here;
        if (batch.di === 0) {
          let any = false;
          for (let k = 0; k < 8 && !any; k++) any = nb[k] === UNLOADED || isLoadBearing(nb[k]);
          if (!any) {
            batch.ri++;
            if (this._spendCheap(ctx, 1)) return false;
            continue;
          }
        }
      }
      const d = batch.di;
      if (++batch.di === 8) {
        batch.di = 0;
        batch.ri++;
      }
      const id = nb[PUSH_FROM_NEIGHBOURS[d]];
      if (id === UNLOADED || isLoadBearing(id)) {
        const o = PUSH_ORDER[d];
        this._begin(ctx, rm[0] + o[0], rm[1] + o[1], rm[2] + o[2], id, batch.si);
      }
      if (this._spendCheap(ctx, 1)) return false;
    }
  }

  /**
   * Start the DFS of one start cell holding `id` (or settle it at once: not load-bearing, memoised, UNLOADED or an
   * anchor).
   */
  _begin(ctx, q, y, r, id, seedIndex) {
    if (id !== UNLOADED && !isLoadBearing(id)) return;
    const key = packCell(q, y, r);
    if (this._supported.has(key) || this._floating.has(key)) return;
    if (id === UNLOADED || isAnchorCell(ctx.world, q, y, r)) {
      this._supported.add(key);
      return;
    }
    this._search = { start: key, seed: seedIndex, stack: [key], visited: new Set([key]), list: [key], count: 0, restart: false };
    this.stats.searches++;
  }

  /**
   * Run the current DFS until it ends or the budget is spent. Neighbours are checked when pushed, so an anchor next
   * to any visited cell ends the search at once.
   * @returns {boolean} the search ended (false: out of budget, state kept)
   */
  _run(ctx, max) {
    const s = /** @type {Search} */ (this._search);
    const world = ctx.world;
    const supported = this._supported;
    const c = this._cell;
    while (s.stack.length > 0) {
      if (this._visits >= max) return false;
      if (this._sinceCheck >= DEADLINE_CHECK_VISITS) {
        this._sinceCheck = 0;
        if (ctx.now() >= ctx.deadline) return false;
      }
      if (s.restart) {
        s.restart = false;
        s.stack = [s.start];
        s.visited = new Set([s.start]);
        s.list = [s.start];
        s.count = 0;
        this.stats.restarts++;
      }
      unpackCell(/** @type {number} */ (s.stack.pop()), c);
      const q = c[0];
      const y = c[1];
      const r = c[2];
      const id = ctx.peek(q, y, r);
      if (id === UNLOADED) return this._finish(true);
      if (!isLoadBearing(id)) continue; // changed since it was pushed (a search spanning ticks)
      this._visits++;
      this._sinceCheck++;
      if (++s.count >= SUPPORT_LIMIT) return this._finish(true);
      for (let i = 0; i < PUSH_ORDER.length; i++) {
        const d = PUSH_ORDER[i];
        const ny = y + d[1];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nq = q + d[0];
        const nr = r + d[2];
        const nk = packCell(nq, ny, nr);
        if (s.visited.has(nk)) continue;
        if (supported.has(nk)) return this._finish(true);
        const nid = ctx.peek(nq, ny, nr);
        if (nid === UNLOADED) return this._finish(true);
        if (!isLoadBearing(nid)) continue;
        if (isAnchorCell(world, nq, ny, nr)) return this._finish(true);
        s.visited.add(nk);
        s.list.push(nk);
        s.stack.push(nk);
      }
    }
    return this._finish(false);
  }

  /**
   * Record the verdict of the current search: every pushed cell joins the supported memo, or the cells become a
   * floating component. A big verdict is written FINISH_SLICE cells at a time (_finishSome, under the cheap budget)
   * before the next start cell is looked at. @returns {true}
   */
  _finish(supported) {
    const s = /** @type {Search} */ (this._search);
    this._search = null;
    let index = -1;
    if (!supported) {
      index = this._components.length;
      this._components.push({ keys: s.list, seed: s.seed, stale: false, collapse: false });
      this.stats.floating++;
    }
    this._finishing = { search: s, supported, at: 0, index };
    if (s.list.length <= FINISH_SLICE) this._finishSome(null);
    return true;
  }

  /** Write the next cells of a verdict into the memo. @returns {boolean} done (false: out of budget) */
  _finishSome(ctx) {
    const f = /** @type {Finishing} */ (this._finishing);
    const list = f.search.list;
    const comps = this._components;
    while (f.at < list.length) {
      const end = Math.min(f.at + FINISH_SLICE, list.length);
      for (let i = f.at; i < end; i++) {
        const k = list[i];
        const old = this._floating.get(k);
        if (f.supported) {
          this._supported.add(k);
          if (old !== undefined) comps[old].stale = true; // joined to support since: never collapse it
        } else {
          if (old !== undefined) comps[old].stale = true; // superseded by this one
          this._floating.set(k, f.index);
        }
      }
      const n = end - f.at;
      f.at = end;
      if (ctx !== null && this._spendCheap(ctx, n) && f.at < list.length) return false;
    }
    this._finishing = null;
    return true;
  }

  _onPlaced(q, y, r) {
    const f = this._finishing;
    for (const [dq, dy, dr] of PUSH_ORDER) {
      const ny = y + dy;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const k = packCell(q + dq, ny, r + dr);
      if (this._search !== null && this._search.visited.has(k)) this._search.restart = true;
      const ci = this._floating.get(k);
      if (ci !== undefined) this._components[ci].stale = true;
      if (f !== null && !f.supported && f.search.visited.has(k)) this._components[f.index].stale = true;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the disconnected-by-this-removal rule

  /**
   * The search is done. Components found from a seed without removals (an explicit `seedSupport`, e.g. a crater rim)
   * collapse outright; with floating components and removals both present the rule's passes follow, else the collapse.
   */
  _beginDecide() {
    const batch = /** @type {Batch} */ (this._batch);
    const comps = this._components;
    let removals = 0;
    for (const seed of batch.seeds) removals += seed.removed.length;
    for (const comp of comps) if (batch.seeds[comp.seed].removed.length === 0) comp.collapse = true;
    batch.si = 0;
    batch.ri = 0;
    batch.at = 0;
    if (removals > 0 && comps.length > 0) {
      batch.remIndex = new Map();
      batch.phase = PHASE_INDEX;
    } else {
      this._pickCollapses();
    }
  }

  /**
   * Pick the floating components to collapse. A removal was SUPPORTED when it was an anchor itself (untouched terrain,
   * bedrock, y = 0) or touches a supported cell or an UNLOADED one; a floating component next to a supported removal
   * was connected to the ground through it, so it collapses — and every other removal next to that component was
   * supported too (through it), and so on: the rule propagates through the removals and components of the batch
   * (several cells cut at once, e.g. an area command or a crater). A component next to no supported removal floated
   * before (a sky base, a fill build): it stays. Three resumable passes over the removals (index them by cell; find the
   * supported ones and the components each touches; spread), each checking the deadline every 32 removals.
   * @returns {boolean} done (false: out of budget)
   */
  _decide(ctx) {
    const batch = /** @type {Batch} */ (this._batch);
    const comps = this._components;
    const floating = this._floating;
    if (batch.phase === PHASE_INDEX) {
      const remIndex = /** @type {Map<number, number>} */ (batch.remIndex);
      while (batch.si < batch.seeds.length) {
        const removed = batch.seeds[batch.si].removed;
        if (batch.ri >= removed.length) {
          batch.si++;
          batch.ri = 0;
          continue;
        }
        const rm = removed[batch.ri++];
        const k = packCell(rm[0], rm[1], rm[2]);
        const i = batch.removals.length;
        batch.removals.push(rm);
        batch.remKeys.push(k);
        if (!remIndex.has(k)) remIndex.set(k, i);
        if (this._spendCheap(ctx, 2)) return false;
      }
      batch.supported = new Uint8Array(batch.removals.length);
      batch.compRems = new Map();
      batch.queue = [];
      batch.at = 0;
      batch.phase = PHASE_SCAN;
    }
    const rems = batch.removals;
    const keys = batch.remKeys;
    const supported = /** @type {Uint8Array} */ (batch.supported);
    const compRems = /** @type {Map<number, number[]>} */ (batch.compRems);
    const queue = batch.queue;
    if (batch.phase === PHASE_SCAN) {
      const memo = this._supported;
      const nb = batch.nb;
      while (batch.at < rems.length) {
        const i = batch.at++;
        const rm = rems[i];
        const k = keys[i];
        const y = rm[1];
        let ok = rm[4] === 1;
        for (let d = 0; d < 8; d++) {
          if ((d === 6 && y + 1 >= WORLD_HEIGHT) || (d === 7 && y === 0)) continue;
          const nk = k + KEY_OFFSETS[d];
          const ci = floating.get(nk);
          if (ci !== undefined && !comps[ci].stale) {
            let list = compRems.get(ci);
            if (list === undefined) compRems.set(ci, (list = []));
            list.push(i);
          }
          if (!ok && memo.has(nk)) ok = true;
        }
        if (!ok) {
          peekNeighbours(ctx.world, rm[0], y, rm[2], nb);
          for (let d = 0; d < 8 && !ok; d++) ok = nb[d] === UNLOADED;
        }
        if (ok) {
          supported[i] = 1;
          queue.push(i);
        }
        if (this._spendCheap(ctx, CHEAP_PER_VISIT) && batch.at < rems.length) return false;
      }
      batch.phase = PHASE_SPREAD;
    }
    // PHASE_SPREAD
    const remIndex = /** @type {Map<number, number>} */ (batch.remIndex);
    while (queue.length > 0) {
      const i = /** @type {number} */ (queue.pop());
      const k = keys[i];
      const y = rems[i][1];
      for (let d = 0; d < 8; d++) {
        if ((d === 6 && y + 1 >= WORLD_HEIGHT) || (d === 7 && y === 0)) continue;
        const nk = k + KEY_OFFSETS[d];
        const ci = floating.get(nk);
        if (ci !== undefined && !comps[ci].stale && !comps[ci].collapse) {
          comps[ci].collapse = true;
          const list = compRems.get(ci);
          if (list !== undefined) {
            for (const j of list) {
              if (supported[j] === 0) {
                supported[j] = 1;
                queue.push(j);
              }
            }
          }
        }
        const ri = remIndex.get(nk);
        if (ri !== undefined && supported[ri] === 0) {
          supported[ri] = 1;
          queue.push(ri);
        }
      }
      if (this._spendCheap(ctx, CHEAP_PER_VISIT) && queue.length > 0) return false;
    }
    this._pickCollapses();
    return true;
  }

  /** The components the rule picked, in the order they were found; the rule's scratch is dropped. */
  _pickCollapses() {
    const batch = /** @type {Batch} */ (this._batch);
    const comps = this._components;
    for (let ci = 0; ci < comps.length; ci++) if (comps[ci].collapse && !comps[ci].stale) batch.collapses.push(ci);
    batch.removals = [];
    batch.remKeys = [];
    batch.remIndex = null;
    batch.supported = null;
    batch.compRems = null;
    batch.queue = [];
    batch.phase = PHASE_COLLAPSE;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // collapse

  /**
   * Collapse the batch's components in order, checking the deadline after each one and after each slice of a crumble.
   * @returns {boolean} all done
   */
  _collapseSome(ctx) {
    const batch = /** @type {Batch} */ (this._batch);
    for (;;) {
      if (batch.crumbling !== null) {
        this._crumbleSlice(ctx);
      } else if (batch.collapseAt < batch.collapses.length) {
        const comp = this._components[batch.collapses[batch.collapseAt++]];
        if (!comp.stale) this._collapse(ctx, comp);
      } else {
        return true;
      }
      if (batch.crumbling === null && batch.collapseAt >= batch.collapses.length) return true;
      if (ctx.now() >= ctx.deadline) return false;
    }
  }

  /**
   * Topple (a tree) or start crumbling one floating component. The writes record into the seed's own event while it
   * is still the undoable one (the blast whose rim search found it), else into the batch's 'collapse' event (one per
   * batch, so one undo restores everything an action brought down). Its kind reads 'falling tree' while it holds only
   * trees. A component small enough to be a tree is re-read whole for the tree test; a crumble goes a slice of
   * CRUMBLE_SLICE cells at a time, lowest first, each slice re-read (_crumbleSlice).
   * @param {RuleContext} ctx
   * @param {Component} comp
   */
  _collapse(ctx, comp) {
    const physics = this.physics;
    const batch = /** @type {Batch} */ (this._batch);
    const seed = batch.seeds[comp.seed];
    if (comp.keys.length > TREE_MAX_CELLS) {
      this._startCrumble(ctx, seed, comp.keys, null, false); // no tree (§36.4.1): its event is chosen at the first live slice
      return;
    }
    /** @type {number[][]} [q, y, r, id] — re-read: a search may have spanned ticks */
    const cells = [];
    const c = this._cell;
    for (const k of comp.keys) {
      unpackCell(k, c);
      const id = this._liveId(ctx, c[0], c[1], c[2]);
      if (id >= 0) cells.push([c[0], c[1], c[2], id]);
    }
    if (cells.length === 0) return;
    const { ev, own, opened } = this._eventFor(seed);
    const token = physics.enterEvent(ev.id);
    try {
      /** @type {FloatingComponent} */
      const component = { cells, cause: seed.cause, event: ev.id };
      const tree = ctx.trees.test(component);
      if (tree && ctx.trees.topple(tree, component, { cause: seed.cause, event: ev.id })) {
        this.stats.toppled++;
        if (opened) ev.kind = 'falling tree';
        return;
      }
    } finally {
      physics.exitEvent(token);
    }
    this._startCrumble(ctx, seed, cells.map((cell) => packCell(cell[0], cell[1], cell[2])), ev, own);
  }

  /**
   * The event a collapse of this batch records into: the seed's own while it is still the undoable one, else the
   * batch's 'collapse' event — opened now when needed (begun and ended at once: it stays physics.lastEvent, and every
   * write of the collapse re-enters it, until another event begins).
   * @param {SupportSeed} seed
   * @returns {{ ev: PhysicsEvent, own: boolean, opened: boolean }}
   */
  _eventFor(seed) {
    const physics = this.physics;
    const batch = /** @type {Batch} */ (this._batch);
    const last = physics.lastEvent;
    if (seed.event > 0 && last !== null && last.id === seed.event) return { ev: last, own: false, opened: false };
    if (batch.event !== null && last === batch.event) return { ev: batch.event, own: true, opened: false };
    const ev = physics.beginEvent('collapse', seed.cause);
    physics.endEvent();
    batch.event = ev;
    return { ev, own: true, opened: true };
  }

  /**
   * Begin crumbling the cells `keys` (packed) lowest first: their (y, q, r) order is one native numeric sort of
   * y · Y_STRIDE + column; the faller slots free now decide how many of the lowest settle instantly.
   * @param {RuleContext} ctx
   * @param {SupportSeed} seed
   * @param {number[]} keys
   * @param {PhysicsEvent|null} ev
   * @param {boolean} own
   */
  _startCrumble(ctx, seed, keys, ev, own) {
    const batch = /** @type {Batch} */ (this._batch);
    const n = keys.length;
    const order = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      const y = k % WORLD_HEIGHT;
      order[i] = y * Y_STRIDE + (k - y) / WORLD_HEIGHT;
    }
    order.sort();
    const free = Math.max(0, MAX_FALLING - ctx.fallers.count);
    batch.crumbling = { order, at: 0, settle: Math.max(0, n - free), leafAt: -1, removed: 0, seed, event: ev, own };
    this._crumbleSlice(ctx);
  }

  /**
   * The cell's id when it still belongs in a collapse: load-bearing, and not a barrel burning in place (a fuse timer:
   * caught in the blast that cut this build — it stays where it is until it goes off, a fraction of a second later;
   * crumbling it would take its fuse away, CONTRACTS §38.2). @returns {number} id, or −1
   */
  _liveId(ctx, q, y, r) {
    const id = ctx.peek(q, y, r);
    if (!isLoadBearing(id)) return -1;
    const explosions = ctx.explosions;
    if (id === BLOCK.BLAST_BARREL && explosions && explosions.hangBurning(q, y, r)) return -1;
    return id;
  }

  /**
   * The next slice of the component being crumbled: CRUMBLE_SLICE cells (lowest first, re-read) go to
   * `fallers.crumble` — the lowest `settle` cells of the whole component settle instantly, the rest animate, so the pile
   * keeps its order while a big build comes down from the bottom over a few ticks. Once every cell is down, the hanging
   * leaves next to them are checked (`trees.decayHangingLeaves`), 4 slices' worth at a time.
   */
  _crumbleSlice(ctx) {
    const batch = /** @type {Batch} */ (this._batch);
    const cr = /** @type {Crumbling} */ (batch.crumbling);
    const order = cr.order;
    const n = order.length;
    if (cr.leafAt >= 0) {
      const end = Math.min(cr.leafAt + CRUMBLE_SLICE * 4, n);
      /** @type {number[][]} */
      const cells = [];
      for (let i = cr.leafAt; i < end; i++) cells.push(unpackCell(orderKey(order[i])));
      ctx.trees.decayHangingLeaves(cells, { event: /** @type {PhysicsEvent} */ (cr.event).id });
      cr.leafAt = end;
      if (end >= n) batch.crumbling = null;
      return;
    }
    const end = Math.min(cr.at + CRUMBLE_SLICE, n);
    /** @type {number[][]} */
    const slice = [];
    let settle = 0;
    const c = this._cell;
    for (let i = cr.at; i < end; i++) {
      unpackCell(orderKey(order[i]), c);
      const id = this._liveId(ctx, c[0], c[1], c[2]);
      if (id < 0) continue;
      slice.push([c[0], c[1], c[2], id]);
      if (i < cr.settle) settle++;
    }
    cr.at = end;
    if (slice.length > 0) {
      if (cr.event === null) {
        const e = this._eventFor(cr.seed);
        cr.event = e.ev;
        cr.own = e.own;
      }
      const ev = cr.event;
      const physics = this.physics;
      const token = physics.enterEvent(ev.id);
      let removed;
      try {
        removed = ctx.fallers.crumble(slice, { event: ev.id, settle });
      } finally {
        physics.exitEvent(token);
      }
      if (removed > 0 && cr.removed === 0) {
        this.stats.crumbled++;
        if (cr.own) ev.kind = 'collapse';
        if (!this.tipSaid) {
          this.tipSaid = true;
          ctx.say(COLLAPSE_TIP);
        }
      }
      cr.removed += removed;
    }
    if (cr.at >= n) {
      if (cr.removed > 0) cr.leafAt = 0;
      else batch.crumbling = null;
    }
  }
}
