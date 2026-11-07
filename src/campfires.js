// Caelancraft — Campfires: where they are, which are near, and how they flicker. See src/CONTRACTS.md §32. Pure.
//
// A campfire is a CAMPFIRE cell. Worldgen never emits one, so main seeds the tracker from World.edits on load
// (loadFromEdits) and keeps it in step through World.onBlockChange, exactly like black holes. The model, light and
// smoke are drawn by campfireRenderer.js; this module only answers "which fires, where, how bright".
//
// At most CAMPFIRE_MAX_TRACKED fires are tracked (they are scanned every frame). Fires past the cap are remembered as
// `refused`; while there are any, retrack() keeps the tracked set to the fires nearest the player, so the fires you
// can see always have their model and light. Burning never depends on tracking: it reads the block.
//
// A re-pick is a streaming selection with no sort: every known fire's position also sits in dense typed arrays, and the
// re-pick walks them once keeping the CAMPFIRE_MAX_TRACKED nearest in a bounded max-heap. The tracked fires go in first,
// so the heap is full from the start and a fire farther than its farthest costs one compare (the common case). It walks
// at most CAMPFIRE_RETRACK_BATCH fires a call, so hundreds of thousands of fires take a few frames instead of stalling
// one, and then only the fires that change side move in or out of the small tracked map.
import { CAMPFIRE_MAX_TRACKED, CAMPFIRE_RETRACK_DISTANCE, CAMPFIRE_RETRACK_BATCH } from './config.js';
import { BLOCK, isLiquid } from './blocks.js';
import { forEachEditedCell } from './coords.js';
import { hexToWorld, worldToHex } from './hex.js';

/**
 * @typedef {Object} Campfire
 * @property {string} key  "q,y,r"
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} x    world centre of the cell's floor
 * @property {number} z
 * @property {number} seed per-fire phase so neighbouring fires do not flicker in step
 * @property {number} slot internal: index in the dense position arrays, −1 once removed
 * @property {number} mark internal: the last re-pick that kept it
 */

/** "q,y,r" */
export function campfireKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Flame brightness at time t (seconds): a sum of three incommensurate sines, deterministic per seed, always within
 * [0.75, 1.25] and averaging 1.
 * @param {number} t
 * @param {number} seed
 */
export function flicker(t, seed) {
  const v = 0.12 * Math.sin(t * 7.3 + seed) + 0.08 * Math.sin(t * 13.1 + seed * 1.7) + 0.05 * Math.sin(t * 23.7 + seed * 2.9);
  return 1 + v;
}

/** Small deterministic per-cell phase in [0, 2π). */
function cellSeed(q, y, r) {
  let h = Math.imul(q, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(r, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** Distance from (x, y, z) to a fire, as `nearest` measures it (the fire's point 0.3 above its floor centre). */
function fireDist(fire, x, y, z) {
  return Math.hypot(fire.x - x, fire.y + 0.3 - y, fire.z - z);
}

/**
 * Hand-placement water rule (§32): a campfire never goes into a liquid or directly under one, and a liquid never goes
 * directly on top of a campfire — water would put it out.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} id the block being placed at (q, y, r)
 * @returns {boolean} true when the placement must be refused
 */
export function wouldDouseCampfire(getBlock, id, q, y, r) {
  if (id === BLOCK.CAMPFIRE) return isLiquid(getBlock(q, y, r)) || isLiquid(getBlock(q, y + 1, r));
  if (isLiquid(id)) return getBlock(q, y - 1, r) === BLOCK.CAMPFIRE;
  return false;
}

/**
 * Player scorch rule (§32): a non-flying player whose feet cell (`floor(y + 0.05)`) is a campfire is bounced out —
 * horizontal 5 m/s away from the cell centre (along `awayDir` at dead centre), `vy ≥ 5`. Reads the block, so it holds
 * for every campfire, tracked or not.
 * @param {{ x: number, y: number, z: number, vx: number, vy: number, vz: number, onGround: boolean, flying: boolean }} player
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {() => [number, number]} awayDir unit (dx, dz) to use when the player is exactly at the centre
 * @returns {boolean} whether the player was bounced
 */
export function scorchPlayer(player, getBlock, awayDir) {
  if (player.flying) return false;
  const [cq, cr] = worldToHex(player.x, player.z);
  if (getBlock(cq, Math.floor(player.y + 0.05), cr) !== BLOCK.CAMPFIRE) return false;
  const [fx, fz] = hexToWorld(cq, cr);
  let dx = player.x - fx;
  let dz = player.z - fz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) [dx, dz] = awayDir();
  else [dx, dz] = [dx / d, dz / d];
  player.vx = dx * 5;
  player.vz = dz * 5;
  player.vy = Math.max(player.vy, 5);
  player.onGround = false;
  return true;
}

/** Read-only view of a Campfires' known fires that are not tracked (`Campfires.refused`). */
class RefusedView {
  /** @param {Campfires} owner */
  constructor(owner) {
    this._owner = owner;
  }

  get size() {
    return this._owner.known.size - this._owner.fires.size;
  }

  /** @param {string} key */
  has(key) {
    return this._owner.known.has(key) && !this._owner.fires.has(key);
  }

  /** @param {string} key @returns {Campfire|undefined} */
  get(key) {
    return this.has(key) ? this._owner.known.get(key) : undefined;
  }

  /** @returns {Generator<Campfire>} */
  *values() {
    for (const fire of this._owner.known.values()) if (!this._owner.fires.has(fire.key)) yield fire;
  }
}

export class Campfires {
  constructor() {
    /** @type {Map<string, Campfire>} tracked: what `nearest` scans, at most CAMPFIRE_MAX_TRACKED */
    this.fires = new Map();
    /**
     * @type {Map<string, Campfire>} every known CAMPFIRE cell, tracked or not. Only add/remove change it: a re-pick moves
     * fires in and out of the small `fires` map, never through this big one (a Map that churns compacts itself in O(n)).
     */
    this.known = new Map();
    /** read-only view of the known fires that are not tracked (refused at the cap; empty unless there are more) */
    this.refused = new RefusedView(this);
    /** @type {Campfire[]} every known fire, densely packed (fire.slot is its index; removal swaps the last one in) */
    this._slots = [];
    /** cell-floor positions by slot (x, y, z), read by a re-pick without touching the fire objects */
    this._px = new Float64Array(64);
    this._py = new Float64Array(64);
    this._pz = new Float64Array(64);
    /** a fire was refused or a tracked one removed since the last re-pick started (or one ended short) */
    this._stale = false;
    /** where the last finished re-pick measured from */
    this._at = [NaN, NaN, NaN];
    /**
     * The re-pick in progress, or null: the point it measures from (y already lowered by the 0.3 of fireDist), the
     * next slot to visit, and the (negative) Campfire.mark of the fires it offered up front — the tracked ones, which the
     * walk then skips.
     * @type {{ x: number, y: number, z: number, next: number, seed: number }|null}
     */
    this._pass = null;
    /** re-picks started so far (their up-front stamp is −this) */
    this._passes = 0;
    /** bounded max-heap of the nearest fires visited so far: squared distance and fire, farthest at index 0 */
    this._heapD = new Float64Array(CAMPFIRE_MAX_TRACKED);
    /** @type {(Campfire|null)[]} */
    this._heapF = new Array(CAMPFIRE_MAX_TRACKED).fill(null);
    this._heapN = 0;
    /** re-picks finished so far: a finished re-pick stamps the fires it keeps with this (Campfire.mark) */
    this._marks = 0;
  }

  /** tracked fires */
  get size() {
    return this.fires.size;
  }

  /** every known CAMPFIRE cell, tracked or not */
  get total() {
    return this.known.size;
  }

  clear() {
    this.fires.clear();
    this.known.clear();
    for (const fire of this._slots) fire.slot = -1;
    this._slots.length = 0;
    this._stale = false;
    this._at = [NaN, NaN, NaN];
    this._endPass();
  }

  /** @returns {boolean} true when tracked; false when already known or past CAMPFIRE_MAX_TRACKED (then it is refused) */
  add(q, y, r) {
    const key = campfireKey(q, y, r);
    if (this.known.has(key)) return false;
    const [x, z] = hexToWorld(q, r);
    const slot = this._slots.length;
    /** @type {Campfire} */
    const fire = { key, q, y, r, x, z, seed: cellSeed(q, y, r), slot, mark: 0 };
    this.known.set(key, fire);
    if (slot >= this._px.length) this._grow();
    this._slots.push(fire);
    this._px[slot] = x;
    this._py[slot] = y;
    this._pz[slot] = z;
    if (this.fires.size < CAMPFIRE_MAX_TRACKED) {
      this.fires.set(key, fire);
      return true;
    }
    // A re-pick in progress walks up to the last slot on every call, so it sees this fire too; otherwise start one.
    if (this._pass === null) this._stale = true;
    return false;
  }

  /** @returns {boolean} whether the cell was known (tracked or refused) */
  remove(q, y, r) {
    const key = campfireKey(q, y, r);
    const fire = this.known.get(key);
    if (fire === undefined) return false;
    this.known.delete(key);
    this._unslot(fire); // slot −1: a re-pick under way that holds it in its heap will not keep it
    if (this.fires.delete(key) && this.known.size > this.fires.size) this._stale = true; // a refused fire can take its place
    return true;
  }

  /**
   * Swap-remove `fire` from the dense arrays. When a re-pick is under way and the last fire moves from the part it has
   * not walked yet into the part it has, the fire is offered to it right away.
   */
  _unslot(fire) {
    const i = fire.slot;
    const last = this._slots.length - 1;
    if (i !== last) {
      const moved = this._slots[last];
      this._slots[i] = moved;
      moved.slot = i;
      this._px[i] = this._px[last];
      this._py[i] = this._py[last];
      this._pz[i] = this._pz[last];
      const pass = this._pass;
      if (pass !== null && i < pass.next && last >= pass.next && moved.mark !== pass.seed) {
        const dx = moved.x - pass.x;
        const dy = moved.y - pass.y;
        const dz = moved.z - pass.z;
        this._offer(moved, dx * dx + dy * dy + dz * dz);
      }
    }
    this._slots.pop();
    fire.slot = -1;
  }

  /** Double the dense position arrays. */
  _grow() {
    const grown = (a) => {
      const b = new Float64Array(a.length * 2);
      b.set(a);
      return b;
    };
    this._px = grown(this._px);
    this._py = grown(this._py);
    this._pz = grown(this._pz);
  }

  /** whether the cell is a TRACKED fire */
  has(q, y, r) {
    return this.fires.has(campfireKey(q, y, r));
  }

  /** World.onBlockChange hook. */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.CAMPFIRE && prev !== BLOCK.CAMPFIRE) this.add(q, y, r);
    else if (prev === BLOCK.CAMPFIRE && next !== BLOCK.CAMPFIRE) this.remove(q, y, r);
  }

  /** Replace the tracked set with every CAMPFIRE cell recorded in World.edits (past the cap: refused, see retrack). */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.CAMPFIRE, (q, y, r) => this.add(q, y, r));
  }

  /**
   * While some fires are refused, make the tracked set the CAMPFIRE_MAX_TRACKED fires nearest (x, y, z) (as `nearest`
   * measures, compared squared; ties by key). Cheap no-op otherwise. A re-pick starts when a fire was refused or a
   * tracked one removed since the last one started, or (x, y, z) is CAMPFIRE_RETRACK_DISTANCE or more from where the
   * last one measured. It visits at most CAMPFIRE_RETRACK_BATCH fires per call, measuring from where it started (fires
   * added meanwhile are visited too, removed ones are not kept), offers the tracked fires first so that it skips at one
   * compare every fire farther than the heap's farthest, and swaps the tracked set when it has seen every fire; if
   * removals left it short, another re-pick follows. Call once a frame.
   * @returns {boolean} whether this call finished a re-pick (the tracked set is now the nearest)
   */
  retrack(x, y, z) {
    if (this.known.size === this.fires.size) {
      if (this._pass !== null) this._endPass(); // everything fits: nothing to pick
      return false;
    }
    if (this._pass === null) {
      const [ax, ay, az] = this._at;
      if (!this._stale && Math.hypot(x - ax, y - ay, z - az) < CAMPFIRE_RETRACK_DISTANCE) return false;
      this._stale = false;
      this._heapN = 0;
      const pass = { x, y: y - 0.3, z, next: 0, seed: -++this._passes };
      this._pass = pass;
      // Offer the tracked fires first: they exist, and with a full tracked set the heap is full from the start, its
      // farthest no farther than the farthest tracked fire, so the walk below skips nearly everything at one compare.
      for (const fire of this.fires.values()) {
        const dx = fire.x - pass.x;
        const dy = fire.y - pass.y;
        const dz = fire.z - pass.z;
        fire.mark = pass.seed;
        this._offer(fire, dx * dx + dy * dy + dz * dz);
      }
    }
    const pass = this._pass;
    const ox = pass.x;
    const oy = pass.y;
    const oz = pass.z;
    const seed = pass.seed;
    const PX = this._px;
    const PY = this._py;
    const PZ = this._pz;
    const slots = this._slots;
    const D = this._heapD;
    const K = CAMPFIRE_MAX_TRACKED;
    const n = slots.length;
    const end = Math.min(n, pass.next + CAMPFIRE_RETRACK_BATCH);
    // Once the heap is full, skip anything farther than its farthest (ties go to _offer: by key).
    let lim = this._heapN === K ? D[0] : Infinity;
    for (let i = pass.next; i < end; i++) {
      const dx = PX[i] - ox;
      const dy = PY[i] - oy;
      const dz = PZ[i] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > lim) continue; // the common case
      const fire = slots[i];
      if (fire.mark === seed) continue; // offered up front
      this._offer(fire, d2);
      if (this._heapN === K) lim = D[0];
    }
    pass.next = end;
    if (end < n) return false;
    // The kept fires are the nearest there are (every fire was offered once, and anything skipped was farther than all
    // kept), but fires removed meanwhile drop out of them, and the walk may have skipped the next ones past a heap root
    // that a removed fire held: with fewer than it should keep, it keeps those and asks for another re-pick.
    if (this._applyPass() < Math.min(K, this.known.size)) this._stale = true;
    this._at = [pass.x, pass.y + 0.3, pass.z];
    return true;
  }

  /**
   * Keep `fire` among the CAMPFIRE_MAX_TRACKED nearest seen so far (max-heap on (d2, key): the root is the farthest).
   * @param {Campfire} fire
   * @param {number} d2 squared distance
   */
  _offer(fire, d2) {
    const D = this._heapD;
    const F = this._heapF;
    const n = this._heapN;
    const key = fire.key;
    if (n < CAMPFIRE_MAX_TRACKED) {
      let i = n;
      this._heapN = n + 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        const pd = D[parent];
        if (pd > d2 || (pd === d2 && /** @type {Campfire} */ (F[parent]).key > key)) break;
        D[i] = pd;
        F[i] = F[parent];
        i = parent;
      }
      D[i] = d2;
      F[i] = fire;
      return;
    }
    const rd = D[0];
    if (d2 > rd || (d2 === rd && key > /** @type {Campfire} */ (F[0]).key)) return; // farther than all kept: the common case
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      let c = l;
      const rr = l + 1;
      if (rr < n && (D[rr] > D[l] || (D[rr] === D[l] && /** @type {Campfire} */ (F[rr]).key > /** @type {Campfire} */ (F[l]).key))) c = rr;
      const cd = D[c];
      if (cd < d2 || (cd === d2 && /** @type {Campfire} */ (F[c]).key < key)) break;
      D[i] = cd;
      F[i] = F[c];
      i = c;
    }
    D[i] = d2;
    F[i] = fire;
  }

  /**
   * A re-pick has seen every fire: track exactly the kept ones that still exist. O(cap): only the fires that change side
   * go in or out of `fires`, and `known` is not touched.
   * @returns {number} how many it kept
   */
  _applyPass() {
    const mark = ++this._marks;
    const F = this._heapF;
    const n = this._heapN;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const fire = /** @type {Campfire} */ (F[i]);
      if (fire.slot < 0) continue; // removed meanwhile
      fire.mark = mark;
      live++;
    }
    for (const fire of this.fires.values()) {
      if (fire.mark !== mark) this.fires.delete(fire.key); // deleting the visited entry is safe during Map iteration
    }
    for (let i = 0; i < n; i++) {
      const fire = /** @type {Campfire} */ (F[i]);
      if (fire.mark === mark && !this.fires.has(fire.key)) this.fires.set(fire.key, fire);
    }
    this._endPass();
    return live;
  }

  _endPass() {
    this._pass = null;
    this._heapF.fill(null, 0, this._heapN); // do not keep removed fires alive
    this._heapN = 0;
  }

  /**
   * Fires whose floor centre is within `maxDist` of (x, y, z), nearest first, at most `limit`.
   * @returns {{ fire: Campfire, dist: number }[]}
   */
  nearest(x, y, z, maxDist, limit = Infinity) {
    /** @type {{ fire: Campfire, dist: number }[]} */
    const out = [];
    for (const fire of this.fires.values()) {
      const dist = fireDist(fire, x, y, z);
      if (dist <= maxDist) out.push({ fire, dist });
    }
    out.sort((a, b) => a.dist - b.dist || (a.fire.key < b.fire.key ? -1 : 1));
    if (out.length > limit) out.length = limit;
    return out;
  }
}
