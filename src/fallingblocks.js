// Caelancraft — falling blocks: column fallers (sand, gravel, crumble pieces, settling logs), tumbling entities (blast
// debris, lit barrels), the gravity rule and the pop-off rule. See src/CONTRACTS.md §34 and docs/DESIGN-physics.md §3.
// PURE: talks to the world only through its BlockPhysics (ctx.peek / ctx.write / hooks).
//
// POP-OFF blocks (v0.9, docs/DESIGN-survival.md §8.5: `isPopOff` — the campfire, the cold fire pit, the wild plants and
// the ground litter) break, like a campfire always has, when the cell below them is fall-through: the cell is written
// AIR with a puff that suits the block, and nothing drops.
//
// A COLUMN FALLER is a cell-sized block falling straight down its (q, r) column, kept in typed arrays. Each frame
// `vy += GRAVITY·dt` (floored at TERMINAL_VELOCITY) and the bottom sweeps from y to y + vy·dt checking EVERY cell it
// crosses, so it cannot tunnel at any frame rate (the faller is exactly one cell wide, so its column is all it can
// touch). It lands on the first cell that is not fall-through and becomes a block in the cell above it — unless that
// cell would trap the player or a pig with no room to lift them, in which case it breaks into dust instead.
//
// A TUMBLER is a body (createBody, radius FALLER_RADIUS, height FALLER_HEIGHT) moved by displaceBody in substeps of at
// most TUMBLE_SUBSTEP, with air drag, spin and ground friction. Debris vanishes in a dust puff on landing (no litter);
// `persistent` tumblers (lit barrels, owned by explosions.js) never land.
import {
  GRAVITY, TERMINAL_VELOCITY, WORLD_HEIGHT, MAX_FALLING, MAX_TUMBLING, MAX_COLUMN_FALL, FALLER_RADIUS, FALLER_HEIGHT,
  TUMBLE_SUBSTEP, TUMBLE_AIR_DRAG, TUMBLE_GROUND_FRICTION, LANDING_DUST_PER_FRAME,
} from './config.js';
import { BLOCK, UNLOADED, POP_OFF_IDS, isFallThrough, isGravityBlock, isPlant, isPopOff, isSolid } from './blocks.js';
import { HEX_ROW_SPACING, worldToHex } from './hex.js';
import { bodyHeight, bodyRadius, createBody, displaceBody, isFreeAt, playerIntersectsBlock } from './physics.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * The lowest feet height floor(y)+1 … floor(y)+maxUp at which `b` is free of solid cells, reached by moving it STRAIGHT UP
 * one cell at a time: every height on the way must be free too, so a body under a 1- or 2-thick roof is never lifted
 * through it onto the top (findFreeY tests each height on its own). null when the first blocked height comes before a
 * free one.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {PlayerState} b
 * @param {number} maxUp
 * @returns {number|null}
 */
export function liftFreeY(getBlock, b, maxUp) {
  const radius = bodyRadius(b);
  const height = bodyHeight(b);
  const from = Math.floor(b.y) + 1;
  for (let dy = 0; dy < maxUp; dy++) {
    const cy = from + dy;
    if (cy + height > WORLD_HEIGHT) return null;
    if (isFreeAt(getBlock, b.x, cy, b.z, radius, height)) return cy;
    // Not free at cy: a lift beyond it would pass through whatever blocks cy — unless only the block landing below
    // the body's top keeps cy occupied, which a higher height leaves behind. Moving up, the body only ENTERS cells above
    // its current top, so stop as soon as such a cell is solid.
    const top = Math.ceil(cy + height) - 1;
    if (!isFreeAt(getBlock, b.x, top, b.z, radius, 1)) return null;
  }
  return null;
}
/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').RuleContext} RuleContext */
/** @typedef {import('./blockphysics.js').SaveOverlay} SaveOverlay */

/**
 * A tumbling entity. `body` is a PlayerState-shaped body (feet position, velocities, radius/height/mass).
 * @typedef {Object} Tumbler
 * @property {number} id          block id it is drawn as
 * @property {PlayerState} body
 * @property {number} rx          rotation (Euler 'YXZ'), radians
 * @property {number} ry
 * @property {number} rz
 * @property {number} wx          spin, rad/s
 * @property {number} wy
 * @property {number} wz
 * @property {number} scale       drawn scale (lit barrels pulse)
 * @property {boolean} persistent never lands / vanishes (lit barrels); its owner removes it
 * @property {number} event       physics event id (0 = none)
 * @property {*} data             owner payload (explosions.js keeps its fuse here)
 */

/** Gravity blocks and the pop-off blocks (CAMPFIRE first, then the rest of POP_OFF_IDS): what the gravity rule reacts to. */
export const GRAVITY_RULE_IDS = Object.freeze([BLOCK.SAND, BLOCK.RED_SAND, BLOCK.GRAVEL, ...POP_OFF_IDS]);

/** Grey stone dust (loose stones, a cold fire pit), green pad dust (a prickly pear), bark dust (fallen branches). */
const POP_GREY = Object.freeze([0.56, 0.55, 0.52]);
const POP_PAD_GREEN = Object.freeze([0.36, 0.56, 0.23]);
const POP_BARK = Object.freeze([0.42, 0.3, 0.19]);
/** Leaf colours of the plants' particles (their tiles' foliage; the short plants' top tile is clear, so not by `id`). */
const POP_LEAF = Object.freeze({
  [BLOCK.HONEYBERRY_BUSH]: Object.freeze([0.2, 0.42, 0.31]),
  [BLOCK.HONEYBERRY_BUSH_BARE]: Object.freeze([0.2, 0.42, 0.31]),
  [BLOCK.TUSSOCK]: Object.freeze([0.62, 0.64, 0.3]),
  [BLOCK.CATTAILS]: Object.freeze([0.4, 0.52, 0.23]),
  [BLOCK.TUBER_PLANT]: Object.freeze([0.33, 0.55, 0.24]),
});

/**
 * The puff of a pop-off block (DESIGN-survival §8.5): a campfire keeps its smoke and wood crack; a plant scatters 6
 * leaves (a prickly pear 4 green dust) with 'break:leaves'; loose stones and a fire pit 4 grey dust with 'break:stone';
 * fallen branches 4 bark-brown dust with 'break:wood'.
 * @param {number} id  a pop-off id
 * @returns {{ kind: 'smoke'|'leaves'|'dust', count: number, dy: number, color: readonly number[]|null, sound: string }}
 */
export function popOffEffect(id) {
  if (id === BLOCK.CAMPFIRE) return { kind: 'smoke', count: 10, dy: 0.3, color: null, sound: 'break:wood' };
  if (id === BLOCK.PRICKLY_PEAR || id === BLOCK.PRICKLY_PEAR_BARE) {
    return { kind: 'dust', count: 4, dy: 0.4, color: POP_PAD_GREEN, sound: 'break:leaves' };
  }
  if (isPlant(id)) return { kind: 'leaves', count: 6, dy: 0.4, color: POP_LEAF[id], sound: 'break:leaves' };
  if (id === BLOCK.FALLEN_BRANCHES) return { kind: 'dust', count: 4, dy: 0.15, color: POP_BARK, sound: 'break:wood' };
  return { kind: 'dust', count: 4, dy: 0.2, color: POP_GREY, sound: 'break:stone' }; // LOOSE_STONES, FIRE_PIT
}

/** A body a landing block would trap is lifted to the first free height among floor(y)+1 … floor(y)+1+this. */
const LIFT_MAX_UP = 3;
/** More spawns than this since the last frame's sort → one O(n log n) sort instead of the insertion sort. */
const SORT_FULL_AFTER = 32;

/** @returns {number} a key for column (q, r) */
function colKey(q, r) {
  return (q + 2097152) * 4194304 + (r + 2097152);
}

export class FallingBlocks {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    /** column fallers in flight */
    this.count = 0;
    this._cap = 0;
    this._id = new Uint8Array(0);
    this._q = new Int32Array(0);
    this._r = new Int32Array(0);
    this._y = new Float64Array(0);
    this._vy = new Float32Array(0);
    this._ev = new Int32Array(0);
    this._dead = new Uint8Array(0);
    this._grow(64);
    /** @type {Tumbler[]} */
    this.tumblers = [];

    // Per-frame landing effects: one thud (the landing nearest the player), dust for the first few landings.
    this._landings = 0;
    this._thudD = Infinity;
    this._thudX = 0;
    this._thudY = 0;
    this._thudZ = 0;

    // Landing overlay for liftFreeY: the world plus the block about to land.
    this._ovQ = 0;
    this._ovY = -1;
    this._ovR = 0;
    this._ovId = 0;
    this._overlayGet = (q, y, r) => (q === this._ovQ && y === this._ovY && r === this._ovR ? this._ovId : physics.world.getBlock(q, y, r));
    /** @type {(PlayerState|number)[]} scratch: body, newY pairs */
    this._lifts = [];
    this._colIds = new Uint8Array(MAX_COLUMN_FALL);
    /** @type {number[]} scratch index list for settleInto / the full sort */
    this._order = [];
    /** spawns since the last sort (they are appended unsorted) */
    this._spawned = 0;
    /** @type {Map<number, number>} column key → column fallers in flight in it (settleNow keeps a column's order) */
    this._colCount = new Map();
    /** _stepFallers is running (its indices must not move) */
    this._stepping = false;

    physics.registerRule('gravity', {
      ring: 'fall',
      feature: 'falling',
      ids: GRAVITY_RULE_IDS,
      update: (ctx, q, y, r, id) => this._gravityRule(ctx, q, y, r, id),
    });
  }

  /** @returns {number} tumblers in flight (debris + lit barrels) */
  get tumblerCount() {
    return this.tumblers.length;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // spawning

  /**
   * Start a column faller of block `id` at cell (q, y, r) (bottom at y; the cell itself is NOT touched — remove the
   * block first if it is in the world). Beyond MAX_FALLING it settles instantly instead.
   * @param {number} id
   * @param {number} q
   * @param {number} y
   * @param {number} r
   * @param {{ vy?: number, event?: number }} [opts]  event defaults to physics.openEventId
   * @returns {boolean} true when it animates, false when it settled instantly (or fell out of the world)
   */
  spawn(id, q, y, r, opts = {}) {
    const ev = opts.event ?? this.physics.openEventId;
    if (this.count >= MAX_FALLING) {
      this.settleNow(id, q, y, r, { event: ev });
      return false;
    }
    this._spawn(id, q, y, r, opts.vy ?? 0, ev);
    return true;
  }

  /**
   * Remove these cells from the world (quietly: no support seeds — the caller queues one boundary search) and drop
   * them as fallers, lowest first; beyond MAX_FALLING the LOWEST cells settle instantly and the top ones animate, so
   * the pile keeps its order. `settle` asks for at least that many of the lowest to settle instantly (a big component
   * crumbled a slice at a time, support.js). AIR / unloaded cells are skipped; a cell whose removal is refused stays put.
   * @param {number[][]} cells  [q, y, r][]
   * @param {{ event?: number, settle?: number }} [opts]
   * @returns {number} cells dropped
   */
  crumble(cells, opts = {}) {
    const ctx = this.physics.ctx;
    const ev = opts.event ?? this.physics.openEventId;
    /** @type {number[][]} [q, y, r, id] */
    const list = [];
    for (const c of cells) {
      const id = ctx.peek(c[0], c[1], c[2]);
      if (id === BLOCK.AIR || id === UNLOADED) continue;
      list.push([c[0], c[1], c[2], id]);
    }
    list.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    const removed = [];
    const token = this.physics.enterEvent(ev);
    for (const c of list) if (ctx.writeQuiet(c[0], c[1], c[2], BLOCK.AIR) === 'ok') removed.push(c);
    this.physics.exitEvent(token);
    const settle = Math.max(0, removed.length - (MAX_FALLING - this.count), opts.settle ?? 0);
    for (let i = 0; i < removed.length; i++) {
      const [q, y, r, id] = removed[i];
      if (i < settle || this.count >= MAX_FALLING) this.settleNow(id, q, y, r, { event: ev });
      else this._spawn(id, q, y, r, 0, ev);
    }
    return removed.length;
  }

  /**
   * Drop block `id` from cell (q, y, r) to its landing cell right now (no animation), with the same landing rules as
   * an animated faller. Column fallers still in flight BELOW it in its column settle first (lowest first), so a block
   * never ends up under one that was beneath it (a column cut again while it falls, a crumble slice at the cap).
   * @param {{ event?: number }} [opts]
   * @returns {boolean} placed
   */
  settleNow(id, q, y, r, opts = {}) {
    const ev = opts.event ?? this.physics.openEventId;
    const world = this.physics.world;
    if (this._colCount.size > 0 && !this._stepping && this._colCount.has(colKey(q, r))) this._settleColumnBelow(q, r, y);
    let cy = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(y)));
    while (cy >= 0 && isFallThrough(world.peekBlock(q, cy - 1, r)) && !this._litAt(q, cy - 1, r)) cy--;
    if (cy < 0) return false; // fell out of the world
    return this._placeLanded(id, q, cy, r, ev);
  }

  /**
   * Start a tumbling entity at WORLD position (x, y, z) (feet) with velocity (vx, vy, vz).
   * @param {number} id  block id it is drawn as
   * @param {{ spin?: number[], persistent?: boolean, event?: number, data?: * }} [opts]
   * @returns {Tumbler|null} null at MAX_TUMBLING (callers turn extra debris into dust)
   */
  spawnTumbler(id, x, y, z, vx = 0, vy = 0, vz = 0, opts = {}) {
    if (this.tumblers.length >= MAX_TUMBLING || !Number.isFinite(x + y + z + vx + vy + vz)) return null;
    const body = createBody(x, y, z, { radius: FALLER_RADIUS, height: FALLER_HEIGHT, mass: 1 });
    body.vx = vx;
    body.vy = vy;
    body.vz = vz;
    const spin = opts.spin ?? [0, 0, 0];
    /** @type {Tumbler} */
    const t = {
      id, body, rx: 0, ry: 0, rz: 0, wx: spin[0] ?? 0, wy: spin[1] ?? 0, wz: spin[2] ?? 0, scale: 1,
      persistent: !!opts.persistent, event: opts.event ?? this.physics.openEventId, data: opts.data ?? null,
    };
    this.tumblers.push(t);
    return t;
  }

  /** @returns {boolean} the tumbler was in flight */
  removeTumbler(t) {
    const i = this.tumblers.indexOf(t);
    if (i < 0) return false;
    this.tumblers.splice(i, 1);
    return true;
  }

  /** Settle every column faller in flight in column (q, r) below height y now, lowest first. */
  _settleColumnBelow(q, r, y) {
    const world = this.physics.world;
    const order = this._order;
    order.length = 0;
    for (let i = 0; i < this.count; i++) if (this._q[i] === q && this._r[i] === r && this._y[i] < y && !this._dead[i]) order.push(i);
    if (order.length === 0) return;
    order.sort((a, b) => this._y[a] - this._y[b]);
    for (const i of order) {
      this._dead[i] = 1;
      let cy = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(this._y[i])));
      while (cy >= 0 && isFallThrough(world.peekBlock(q, cy - 1, r)) && !this._litAt(q, cy - 1, r)) cy--;
      if (cy >= 0) this._placeLanded(this._id[i], q, cy, r, this._ev[i]);
    }
    order.length = 0;
    this._compact();
  }

  /** Remove the fallers and non-persistent tumblers of event `id` (undo). @returns {number} removed */
  cancelEvent(id) {
    if (!(id > 0)) return 0;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this._ev[i] === id) {
        this._dead[i] = 1;
        n++;
      }
    }
    if (n > 0) this._compact();
    for (let i = this.tumblers.length - 1; i >= 0; i--) {
      const t = this.tumblers[i];
      if (t.event === id && !t.persistent) {
        this.tumblers.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  /** Drop everything in flight. */
  reset() {
    this.count = 0;
    this.tumblers.length = 0;
    this._colCount.clear();
    this._spawned = 0;
  }

  /**
   * The i-th column faller (tests / diagnostics).
   * @returns {{ id: number, q: number, y: number, r: number, vy: number, event: number }|null}
   */
  faller(i) {
    if (!(i >= 0 && i < this.count)) return null;
    return { id: this._id[i], q: this._q[i], y: this._y[i], r: this._r[i], vy: this._vy[i], event: this._ev[i] };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // per frame

  /** Move every faller and tumbler by dt; land / vanish; one thud for the landing nearest the player. */
  step(dt) {
    if (dt > 0) {
      this._stepFallers(dt);
      this._stepTumblers(dt);
    }
    this._flushEffects();
  }

  /**
   * Fallers are processed LOWEST FIRST (the arrays are kept sorted by y with an insertion sort, which is linear on the
   * nearly sorted order falling preserves), so within a column every landing block is already in the world when the
   * faller above it sweeps: a whole stack landing in one frame piles up exactly, in order.
   */
  _stepFallers(dt) {
    const world = this.physics.world;
    const dv = GRAVITY * dt;
    this._sortByY();
    this._stepping = true;
    try {
      this._moveFallers(world, dv, dt);
    } finally {
      this._stepping = false;
    }
  }

  _moveFallers(world, dv, dt) {
    const n = this.count;
    const lit = this._anyLit();
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const q = this._q[i];
      const r = this._r[i];
      if (!world.hasChunkAtCell(q, r)) continue; // frozen while its column is unloaded
      let vy = this._vy[i] + dv;
      if (vy < TERMINAL_VELOCITY) vy = TERMINAL_VELOCITY;
      const y0 = this._y[i];
      const y1 = y0 + vy * dt;
      const c0 = Math.floor(y0);
      let land = NaN;
      if (y0 > c0 && c0 >= 0 && c0 < WORLD_HEIGHT && !isFallThrough(world.peekBlock(q, c0, r))) {
        land = c0 + 1; // something appeared inside the faller: rest on top of it
      } else {
        // Swept: every cell whose top lies in (y1, y0] — exact because the faller is one cell wide.
        const end = Math.floor(y1);
        for (let b = Math.min(c0 - 1, WORLD_HEIGHT - 1); b >= end && b >= 0; b--) {
          if (!isFallThrough(world.peekBlock(q, b, r)) || (lit && this._litAt(q, b, r))) {
            land = b + 1;
            break;
          }
        }
      }
      if (land === land || y1 < 0) {
        this._dead[i] = 1;
        removed++;
        if (land === land) this._placeLanded(this._id[i], q, land, r, this._ev[i]);
        continue; // (y1 < 0: fell out of the world)
      }
      this._y[i] = y1;
      this._vy[i] = vy;
    }
    if (removed > 0) this._compact();
  }

  /**
   * Sort the parallel arrays by y (ascending): an insertion sort, linear on the nearly sorted order falling keeps —
   * unless many fallers were appended since the last sort (a gravity column or crumble slice spawns bottom-up, column
   * after column: quadratic for the insertion sort), then one index sort.
   */
  _sortByY() {
    const many = this._spawned > SORT_FULL_AFTER;
    this._spawned = 0;
    if (many && this.count > 1) {
      this._fullSort();
      return;
    }
    const ys = this._y;
    for (let i = 1; i < this.count; i++) {
      if (ys[i - 1] <= ys[i]) continue;
      const id = this._id[i];
      const q = this._q[i];
      const r = this._r[i];
      const y = ys[i];
      const vy = this._vy[i];
      const ev = this._ev[i];
      let j = i - 1;
      while (j >= 0 && ys[j] > y) {
        this._id[j + 1] = this._id[j];
        this._q[j + 1] = this._q[j];
        this._r[j + 1] = this._r[j];
        ys[j + 1] = ys[j];
        this._vy[j + 1] = this._vy[j];
        this._ev[j + 1] = this._ev[j];
        j--;
      }
      this._id[j + 1] = id;
      this._q[j + 1] = q;
      this._r[j + 1] = r;
      ys[j + 1] = y;
      this._vy[j + 1] = vy;
      this._ev[j + 1] = ev;
    }
  }

  /** Stable index sort of the parallel arrays by y. */
  _fullSort() {
    const n = this.count;
    const ys = this._y;
    const order = this._order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => ys[a] - ys[b] || a - b);
    const permute = (arr) => {
      const copy = arr.slice(0, n);
      for (let k = 0; k < n; k++) arr[k] = copy[order[k]];
    };
    permute(this._id);
    permute(this._q);
    permute(this._r);
    permute(this._y);
    permute(this._vy);
    permute(this._ev);
    order.length = 0;
  }

  /** Drop every entry marked in `_dead`, keeping the order. */
  _compact() {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this._dead[i]) {
        this._dead[i] = 0;
        const ck = colKey(this._q[i], this._r[i]);
        const left = (this._colCount.get(ck) ?? 1) - 1;
        if (left > 0) this._colCount.set(ck, left);
        else this._colCount.delete(ck);
        continue;
      }
      if (w !== i) {
        this._id[w] = this._id[i];
        this._q[w] = this._q[i];
        this._r[w] = this._r[i];
        this._y[w] = this._y[i];
        this._vy[w] = this._vy[i];
        this._ev[w] = this._ev[i];
      }
      w++;
    }
    this.count = w;
  }

  _stepTumblers(dt) {
    const world = this.physics.world;
    const getBlock = world.getBlock;
    const drag = Math.pow(TUMBLE_AIR_DRAG, 60 * dt);
    const friction = Math.pow(TUMBLE_GROUND_FRICTION, 60 * dt);
    const list = this.tumblers;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      const b = t.body;
      const [cq, cr] = worldToHex(b.x, b.z);
      if (!world.hasChunkAtCell(cq, cr)) continue;
      b.vy = Math.max(b.vy + GRAVITY * dt, TERMINAL_VELOCITY);
      b.vx *= drag;
      b.vy *= drag;
      b.vz *= drag;
      if (b.onGround) {
        b.vx *= friction;
        b.vz *= friction;
        t.wx *= friction;
        t.wy *= friction;
        t.wz *= friction;
      }
      const dx = b.vx * dt;
      const dy = b.vy * dt;
      const dz = b.vz * dt;
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / TUMBLE_SUBSTEP));
      b.onGround = false;
      let landed = false;
      for (let k = 0; k < n; k++) {
        const res = displaceBody(b, dx / n, dy / n, dz / n, getBlock);
        if (res.hitFloorOrCeiling && dy < 0 && b.onGround) landed = true;
      }
      t.rx += t.wx * dt;
      t.ry += t.wy * dt;
      t.rz += t.wz * dt;
      if (b.y < -16 || (landed && !t.persistent)) {
        if (landed) this._dust(t.id, b.x, b.y, b.z, 10);
        list.splice(i, 1);
      }
    }
  }

  /**
   * Push each moving cell to the renderer: fallers at their cell centre, tumblers at their body centre with spin.
   * @param {(id: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number, scale?: number) => void} push
   */
  renderItems(push) {
    for (let i = 0; i < this.count; i++) {
      const q = this._q[i];
      const r = this._r[i];
      push(this._id[i], q + r / 2, this._y[i] + 0.5, r * HEX_ROW_SPACING, 0, 0, 0, 1);
    }
    for (const t of this.tumblers) {
      const b = t.body;
      push(t.id, b.x, b.y + bodyHeight(b) / 2, b.z, t.rx, t.ry, t.rz, t.scale);
    }
  }

  /**
   * Saving (never touches the live world): every column faller is written at the cell it would land in, lowest
   * first so stacked fallers keep their order. Debris is dropped (it vanishes anyway); persistent tumblers are their
   * owner's job (explosions saves lit barrels as barrels).
   * @param {SaveOverlay} overlay
   */
  settleInto(overlay) {
    const order = this._order;
    order.length = 0;
    for (let i = 0; i < this.count; i++) order.push(i);
    order.sort((a, b) => this._y[a] - this._y[b]);
    for (const i of order) {
      const q = this._q[i];
      const r = this._r[i];
      let cy = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(this._y[i])));
      if (overlay.peek(q, cy, r) === UNLOADED) continue; // its column streamed out: nothing to stand on
      while (cy < WORLD_HEIGHT && (!isFallThrough(overlay.peek(q, cy, r)) || this._litAt(q, cy, r))) cy++;
      while (cy >= 0 && isFallThrough(overlay.peek(q, cy - 1, r)) && !this._litAt(q, cy - 1, r)) cy--;
      if (cy >= 0 && cy < WORLD_HEIGHT) overlay.set(q, cy, r, this._id[i]);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // rules

  /**
   * `fall` ring: a gravity block over a fall-through cell drops — together with the gravity blocks stacked on it
   * (up to MAX_COLUMN_FALL), bottom first; a pop-off block (a campfire, a fire pit, a plant, litter) over a fall-through
   * cell breaks with its puff (popOffEffect) and drops nothing.
   * @param {RuleContext} ctx
   */
  _gravityRule(ctx, q, y, r, id) {
    const below = ctx.peek(q, y - 1, r);
    if (below === UNLOADED) {
      ctx.park();
      return;
    }
    if (!isFallThrough(below) || this._litAt(q, y - 1, r)) return; // resting on the ground, or on a burning barrel
    const x = q + r / 2;
    const z = r * HEX_ROW_SPACING;
    if (isPopOff(id)) {
      if (ctx.write(q, y, r, BLOCK.AIR) === 'ok') {
        const fx = popOffEffect(id);
        ctx.particles(fx.kind, x, y + fx.dy, z, fx.count, fx.color ? { color: [...fx.color] } : undefined);
        ctx.sound(fx.sound, x, y + 0.5, z);
      }
      return;
    }
    if (!isGravityBlock(id)) return;
    const ids = this._colIds;
    let n = 0;
    // Quiet writes and ONE support seed for the column (with all its removals) instead of one per cell (§34.1).
    for (let cy = y; cy < WORLD_HEIGHT && n < MAX_COLUMN_FALL; cy++) {
      const cid = cy === y ? id : ctx.peek(q, cy, r);
      if (!isGravityBlock(cid)) break;
      if (ctx.writeQuiet(q, cy, r, BLOCK.AIR) !== 'ok') break; // capped: the rest of the column stays
      ids[n++] = cid;
    }
    if (n > 0 && this.physics.switches.collapse) {
      const removed = [];
      for (let k = 0; k < n; k++) removed.push([q, y + k, r, ids[k]]);
      const cause = this.physics.cause;
      this.physics.seedRemovals(removed, cause ? { cause, priority: cause.kind === 'player' } : {});
    }
    const settle = Math.max(0, n - (MAX_FALLING - this.count));
    const ev = this.physics.openEventId;
    for (let k = 0; k < n; k++) {
      if (k < settle) this.settleNow(ids[k], q, y + k, r, { event: ev });
      else this._spawn(ids[k], q, y + k, r, 0, ev);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // internals

  _spawn(id, q, y, r, vy, ev) {
    if (this.count >= this._cap) this._grow(Math.min(MAX_FALLING, this._cap * 2));
    const i = this.count++;
    this._spawned++;
    const ck = colKey(q, r);
    this._colCount.set(ck, (this._colCount.get(ck) ?? 0) + 1);
    this._id[i] = id;
    this._q[i] = q;
    this._r[i] = r;
    this._y[i] = y;
    this._vy[i] = vy;
    this._ev[i] = ev;
  }

  _grow(cap) {
    const n = Math.max(cap, this.count);
    const copy = (Ctor, old) => {
      const a = new Ctor(n);
      a.set(old.subarray(0, this.count));
      return a;
    };
    this._id = copy(Uint8Array, this._id);
    this._q = copy(Int32Array, this._q);
    this._r = copy(Int32Array, this._r);
    this._y = copy(Float64Array, this._y);
    this._vy = copy(Float32Array, this._vy);
    this._ev = copy(Int32Array, this._ev);
    this._dead = new Uint8Array(n);
    this._cap = n;
  }


  /**
   * Land block `id` into cell (q, cy, r). A body the block would trap is lifted with liftFreeY (from floor(y)+1, up to
   * LIFT_MAX_UP, sweeping up one cell at a time so it never passes through a solid roof) and reported through
   * `hooks.lifted(body, cells)`; when one has no room the block breaks into dust instead (never bury the player). A refused write
   * ('capped' / 'failed') also breaks it. The write is recorded into event `ev` while that is still undoable.
   * @returns {boolean} placed
   */
  _placeLanded(id, q, cy, r, ev) {
    const physics = this.physics;
    const world = physics.world;
    const x = q + r / 2;
    const z = r * HEX_ROW_SPACING;
    // The landing cell must be free (a block may have appeared in it, or a burning barrel rests in it): rest on top.
    let tries = 0;
    while (cy < WORLD_HEIGHT && (!isFallThrough(world.peekBlock(q, cy, r)) || this._litAt(q, cy, r)) && tries < 4) {
      cy++;
      tries++;
    }
    if (cy >= WORLD_HEIGHT || !isFallThrough(world.peekBlock(q, cy, r)) || this._litAt(q, cy, r)) {
      this._dust(id, x, Math.min(cy, WORLD_HEIGHT - 1), z, 8);
      return false;
    }
    const lifts = this._lifts;
    lifts.length = 0;
    if (isSolid(id)) {
      const bodies = physics.hooks.bodies();
      if (bodies && bodies.length > 0) {
        this._ovQ = q;
        this._ovY = cy;
        this._ovR = r;
        this._ovId = id;
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i];
          if (!b || !playerIntersectsBlock(b, q, cy, r)) continue;
          const fy = liftFreeY(this._overlayGet, b, LIFT_MAX_UP);
          if (fy === null) {
            this._ovY = -1;
            this._dust(id, x, cy, z, 12);
            return false;
          }
          lifts.push(b, fy);
        }
        this._ovY = -1;
      }
    }
    const token = physics.enterEvent(ev);
    const res = physics.ctx.write(q, cy, r, id);
    physics.exitEvent(token);
    if (res !== 'ok') {
      this._dust(id, x, cy, z, 8);
      return false;
    }
    for (let i = 0; i < lifts.length; i += 2) {
      const b = /** @type {PlayerState} */ (lifts[i]);
      const fy = /** @type {number} */ (lifts[i + 1]);
      const cells = Math.max(1, Math.ceil(fy - b.y - 1e-6));
      b.y = fy;
      if (b.vy < 0) b.vy = 0;
      physics.hooks.lifted(b, cells); // the body is free now: only this tells main it was crushed (§2.4)
    }
    lifts.length = 0;
    this._noteLanding(id, x, cy, z);
    return true;
  }

  /** @returns {boolean} some lit barrel entity rests in a cell (explosions.occupiesCell can be true) */
  _anyLit() {
    const ex = this.physics.explosions;
    return !!ex && ex.lit.length > 0;
  }

  /**
   * A lit barrel entity rests in cell (q, y, r): blocks fall onto it, never into its cell (play-test B3: sand landing
   * in it popped the barrel up through the pile).
   * @returns {boolean}
   */
  _litAt(q, y, r) {
    const ex = this.physics.explosions;
    return !!ex && ex.occupiesCell(q, y, r);
  }

  _noteLanding(id, x, y, z) {
    if (this._landings < LANDING_DUST_PER_FRAME) this._dust(id, x, y, z, 6);
    this._landings++;
    const p = this.physics.hooks.player();
    const d = p ? Math.hypot(x - p.x, y - p.y, z - p.z) : 0;
    if (d < this._thudD) {
      this._thudD = d;
      this._thudX = x;
      this._thudY = y;
      this._thudZ = z;
    }
  }

  _flushEffects() {
    if (this._landings > 0) this.physics.hooks.sound('thud', this._thudX, this._thudY, this._thudZ, 1);
    this._landings = 0;
    this._thudD = Infinity;
  }

  /** Dust in the block's colour around the base of cell (x, y, z) — spread past the cell so a landed block shows it. */
  _dust(id, x, y, z, count) {
    this.physics.hooks.particles('dust', x, y + 0.1, z, count, { id, spread: 0.8 });
  }
}
