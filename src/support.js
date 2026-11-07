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
// The search keeps its state across ticks (`busy`): MAX_SUPPORT_VISITS_PER_TICK visits and the tick's time budget
// (checked every 256 visits) bound each step.
import { SUPPORT_LIMIT, WORLD_HEIGHT } from './config.js';
import { BLOCK, UNLOADED, isLeaves, isSolid } from './blocks.js';
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
/** The `mode` a trigger receives for player / command / rune writes (blockphysics.js WRITE_EXTERNAL, CONTRACTS §33). */
const MODE_EXTERNAL = 0;

/**
 * DFS push order as [dq, dy, dr]: above, the six sides, below — the stack pops the cell below first, then the sides,
 * then the one above, so a search heads for the ground first.
 */
const PUSH_ORDER = Object.freeze([
  Object.freeze([0, 1, 0]), ...HEX_DIRS.map(([dq, dr]) => Object.freeze([dq, 0, dr])), Object.freeze([0, -1, 0]),
]);

const PHASE_SEARCH = 0;
const PHASE_COLLAPSE = 1;

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
 * @typedef {Object} Batch
 * @property {SupportSeed[]} seeds
 * @property {number[]} starts      packed start cells (deduplicated), in seed order
 * @property {number[]} startSeed   seed index of each start
 * @property {number} next          next start to search
 * @property {number[][]} removals  [q, y, r, prevId, wasAnchor][] of every seed
 * @property {number} phase         PHASE_SEARCH → PHASE_COLLAPSE
 * @property {number[]} collapses   component indices to collapse, in order
 * @property {number} collapseAt    next of them
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
    /** the first-crumble chat tip was said (per loaded world: one SupportSolver per World) */
    this.tipSaid = false;
    this._cell = [0, 0, 0];
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
   * Advance the search by at most `maxVisits` visited cells (and the tick's time budget: ctx.now() vs ctx.deadline,
   * checked every 256 visits); pull seeds with `seeds.shift()` (priority lane first). A finished batch collapses what
   * it found floating (checking the deadline after each collapse) and the next batch starts while budget is left.
   * @param {RuleContext} ctx
   * @param {SeedQueue} seeds
   * @param {number} maxVisits
   * @returns {number} cells visited this call
   */
  step(ctx, seeds, maxVisits) {
    this._visits = 0;
    this._sinceCheck = 0;
    const max = maxVisits > 0 ? maxVisits : Infinity;
    for (;;) {
      if (this._batch === null) {
        if (seeds.size === 0) break;
        this._beginBatch(seeds);
      }
      const batch = /** @type {Batch} */ (this._batch);
      if (batch.phase === PHASE_SEARCH) {
        if (!this._searchAll(ctx, max)) break; // out of budget: resume next tick
        this._decide(ctx);
      }
      if (!this._collapseSome(ctx)) break;
      this._endBatch();
      if (this._visits >= max || ctx.now() >= ctx.deadline) break;
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

  // -------------------------------------------------------------------------------------------------------------------
  // batches

  /** Take every pending seed into one batch with a fresh memo. */
  _beginBatch(seeds) {
    /** @type {Batch} */
    const batch = {
      seeds: [], starts: [], startSeed: [], next: 0, removals: [], phase: PHASE_SEARCH, collapses: [], collapseAt: 0, event: null,
    };
    const seen = new Set();
    const add = (q, y, r, si) => {
      if (!(y >= 0 && y < WORLD_HEIGHT)) return;
      const k = packCell(q, y, r);
      if (seen.has(k)) return;
      seen.add(k);
      batch.starts.push(k);
      batch.startSeed.push(si);
    };
    for (let seed = seeds.shift(); seed !== null; seed = seeds.shift()) {
      const si = batch.seeds.length;
      batch.seeds.push(seed);
      for (const c of seed.cells) add(c[0], c[1], c[2], si);
      // The seed queue leaves out cells already pending in an earlier seed: every removal's own neighbours are
      // searched here regardless, so the rule below sees all of them (non-load-bearing ones are skipped cheaply).
      for (const rm of seed.removed) {
        batch.removals.push(rm);
        for (const [dq, dy, dr] of PUSH_ORDER) add(rm[0] + dq, rm[1] + dy, rm[2] + dr, si);
      }
    }
    this._batch = batch;
    this._search = null;
    this._supported.clear();
    this._floating.clear();
    this._components.length = 0;
    this.stats.batches++;
  }

  _endBatch() {
    this._batch = null;
    this._search = null;
    this._supported.clear();
    this._floating.clear();
    this._components.length = 0;
  }

  /** Resolve every start cell. @returns {boolean} done (false: out of budget) */
  _searchAll(ctx, max) {
    const batch = /** @type {Batch} */ (this._batch);
    for (;;) {
      if (this._search === null) {
        if (batch.next >= batch.starts.length) return true;
        const i = batch.next++;
        this._begin(ctx, batch.starts[i], batch.startSeed[i]);
        continue;
      }
      if (!this._run(ctx, max)) return false;
    }
  }

  /** Start the DFS of one start cell (or settle it at once: memoised, not load-bearing, UNLOADED or an anchor). */
  _begin(ctx, key, seedIndex) {
    if (this._supported.has(key) || this._floating.has(key)) return;
    const c = unpackCell(key, this._cell);
    const id = ctx.peek(c[0], c[1], c[2]);
    if (id === UNLOADED || (isLoadBearing(id) && isAnchorCell(ctx.world, c[0], c[1], c[2]))) {
      this._supported.add(key);
      return;
    }
    if (!isLoadBearing(id)) return;
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

  /** Record the verdict of the current search. @returns {true} */
  _finish(supported) {
    const s = /** @type {Search} */ (this._search);
    this._search = null;
    if (supported) {
      for (const k of s.visited) {
        this._supported.add(k);
        const old = this._floating.get(k);
        if (old !== undefined) this._components[old].stale = true; // joined to support since: never collapse it
      }
      return true;
    }
    const index = this._components.length;
    this._components.push({ keys: s.list, seed: s.seed, stale: false, collapse: false });
    for (const k of s.list) {
      const old = this._floating.get(k);
      if (old !== undefined) this._components[old].stale = true; // superseded by this one
      this._floating.set(k, index);
    }
    this.stats.floating++;
    return true;
  }

  _onPlaced(q, y, r) {
    for (const [dq, dy, dr] of PUSH_ORDER) {
      const ny = y + dy;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const k = packCell(q + dq, ny, r + dr);
      if (this._search !== null && this._search.visited.has(k)) this._search.restart = true;
      const ci = this._floating.get(k);
      if (ci !== undefined) this._components[ci].stale = true;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the disconnected-by-this-removal rule

  /**
   * Pick the floating components to collapse. A removal was SUPPORTED when it was an anchor itself (untouched terrain,
   * bedrock, y = 0) or touches a supported cell or an UNLOADED one; a floating component next to a supported removal
   * was connected to the ground through it, so it collapses — and every other removal next to that component was
   * supported too (through it), and so on: the rule propagates through the removals and components of the batch
   * (several cells cut at once, e.g. an area command or a crater). A component next to no supported removal floated
   * before (a sky base, a fill build): it stays. Components found from a seed without removals (an explicit
   * `seedSupport`, e.g. a crater rim) collapse outright.
   */
  _decide(ctx) {
    const batch = /** @type {Batch} */ (this._batch);
    const comps = this._components;
    for (const comp of comps) if (batch.seeds[comp.seed].removed.length === 0) comp.collapse = true;

    const rems = batch.removals;
    const n = rems.length;
    if (n > 0 && comps.length > 0) {
      /** @type {Map<number, number>} packed removed cell → removal index */
      const remIndex = new Map();
      for (let i = 0; i < n; i++) {
        const k = packCell(rems[i][0], rems[i][1], rems[i][2]);
        if (!remIndex.has(k)) remIndex.set(k, i);
      }
      /** @type {number[][]} per removal: adjacent component indices */
      const adjComps = [];
      /** @type {number[][]} per removal: adjacent removal indices */
      const adjRems = [];
      /** @type {Map<number, number[]>} component index → adjacent removal indices */
      const compRems = new Map();
      const supported = new Uint8Array(n);
      const queue = [];
      for (let i = 0; i < n; i++) {
        const [q, y, r, , wasAnchor] = rems[i];
        const ac = [];
        const ar = [];
        let ok = wasAnchor === 1;
        for (const [dq, dy, dr] of PUSH_ORDER) {
          const ny = y + dy;
          if (ny < 0 || ny >= WORLD_HEIGHT) continue;
          const k = packCell(q + dq, ny, r + dr);
          const ci = this._floating.get(k);
          if (ci !== undefined && !comps[ci].stale) {
            ac.push(ci);
            let list = compRems.get(ci);
            if (list === undefined) compRems.set(ci, (list = []));
            list.push(i);
          }
          const ri = remIndex.get(k);
          if (ri !== undefined && ri !== i) ar.push(ri);
          if (!ok && (this._supported.has(k) || ctx.peek(q + dq, ny, r + dr) === UNLOADED)) ok = true;
        }
        adjComps.push(ac);
        adjRems.push(ar);
        if (ok) {
          supported[i] = 1;
          queue.push(i);
        }
      }
      while (queue.length > 0) {
        const i = /** @type {number} */ (queue.pop());
        for (const ci of adjComps[i]) {
          if (comps[ci].collapse) continue;
          comps[ci].collapse = true;
          for (const j of /** @type {number[]} */ (compRems.get(ci))) {
            if (supported[j] === 0) {
              supported[j] = 1;
              queue.push(j);
            }
          }
        }
        for (const j of adjRems[i]) {
          if (supported[j] === 0) {
            supported[j] = 1;
            queue.push(j);
          }
        }
      }
    }
    for (let ci = 0; ci < comps.length; ci++) if (comps[ci].collapse && !comps[ci].stale) batch.collapses.push(ci);
    batch.phase = PHASE_COLLAPSE;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // collapse

  /** Collapse the batch's components, checking the deadline after each. @returns {boolean} all done */
  _collapseSome(ctx) {
    const batch = /** @type {Batch} */ (this._batch);
    while (batch.collapseAt < batch.collapses.length) {
      const comp = this._components[batch.collapses[batch.collapseAt++]];
      if (!comp.stale) this._collapse(ctx, comp);
      if (batch.collapseAt < batch.collapses.length && ctx.now() >= ctx.deadline) return false;
    }
    return true;
  }

  /**
   * Topple (a tree) or crumble one floating component. The writes record into the seed's own event while it is still
   * the undoable one (the blast whose rim search found it), else into the batch's 'collapse' event (one per batch, so
   * one undo restores everything an action brought down). Its kind reads 'falling tree' while it holds only trees.
   * @param {RuleContext} ctx
   * @param {Component} comp
   */
  _collapse(ctx, comp) {
    const physics = this.physics;
    const batch = /** @type {Batch} */ (this._batch);
    /** @type {number[][]} [q, y, r, id] — re-read: a search may have spanned ticks */
    const cells = [];
    const c = this._cell;
    const explosions = ctx.explosions;
    for (const k of comp.keys) {
      unpackCell(k, c);
      const id = ctx.peek(c[0], c[1], c[2]);
      if (!isLoadBearing(id)) continue;
      // A barrel burning in place (a fuse timer: caught in the blast that cut this build) stays where it is until it
      // goes off, a fraction of a second later — crumbling it would take its fuse away (CONTRACTS §38.2).
      if (id === BLOCK.BLAST_BARREL && explosions && explosions.hangBurning(c[0], c[1], c[2])) continue;
      cells.push([c[0], c[1], c[2], id]);
    }
    if (cells.length === 0) return;
    const seed = batch.seeds[comp.seed];
    const cause = seed.cause;
    const last = physics.lastEvent;
    /** @type {PhysicsEvent} */
    let ev;
    let own = false;
    let opened = false;
    if (seed.event > 0 && last !== null && last.id === seed.event) {
      ev = last;
    } else if (batch.event !== null && last === batch.event) {
      ev = batch.event;
      own = true;
    } else {
      ev = physics.beginEvent('collapse', cause);
      batch.event = ev;
      own = true;
      opened = true;
    }
    const token = opened ? null : physics.enterEvent(ev.id);
    try {
      /** @type {FloatingComponent} */
      const component = { cells, cause, event: ev.id };
      const tree = ctx.trees.test(component);
      if (tree && ctx.trees.topple(tree, component, { cause, event: ev.id })) {
        this.stats.toppled++;
        if (opened) ev.kind = 'falling tree';
      } else if (ctx.fallers.crumble(cells, { event: ev.id }) > 0) {
        ctx.trees.decayHangingLeaves(cells, { event: ev.id });
        this.stats.crumbled++;
        if (own) ev.kind = 'collapse';
        if (!this.tipSaid) {
          this.tipSaid = true;
          ctx.say(COLLAPSE_TIP);
        }
      }
    } finally {
      if (opened) physics.endEvent();
      else physics.exitEvent(token);
    }
  }
}
