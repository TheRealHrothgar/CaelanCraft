// Caelancraft — Campfires: where they are, which are near, and how they flicker. See src/CONTRACTS.md §32. Pure.
//
// A campfire is a CAMPFIRE cell. Worldgen never emits one, so main seeds the tracker from World.edits on load
// (loadFromEdits) and keeps it in step through World.onBlockChange, exactly like black holes. The model, light and
// smoke are drawn by campfireRenderer.js; this module only answers "which fires, where, how bright".
//
// At most CAMPFIRE_MAX_TRACKED fires are tracked (they are scanned every frame). Fires past the cap are remembered as
// `refused`; while there are any, retrack() keeps the tracked set to the fires nearest the player, so the fires you
// can see always have their model and light. Burning never depends on tracking: it reads the block.
import { CAMPFIRE_MAX_TRACKED, CAMPFIRE_RETRACK_DISTANCE } from './config.js';
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

export class Campfires {
  constructor() {
    /** @type {Map<string, Campfire>} tracked: what `nearest` scans, at most CAMPFIRE_MAX_TRACKED */
    this.fires = new Map();
    /** @type {Map<string, Campfire>} CAMPFIRE cells past the cap (empty unless there are more than the cap) */
    this.refused = new Map();
    /** a fire was refused or a tracked one removed since the last retrack */
    this._stale = false;
    /** where the last retrack measured from */
    this._at = [NaN, NaN, NaN];
  }

  /** tracked fires */
  get size() {
    return this.fires.size;
  }

  /** every known CAMPFIRE cell, tracked or not */
  get total() {
    return this.fires.size + this.refused.size;
  }

  clear() {
    this.fires.clear();
    this.refused.clear();
    this._stale = false;
    this._at = [NaN, NaN, NaN];
  }

  /** @returns {boolean} true when tracked; false when already known or past CAMPFIRE_MAX_TRACKED (then it is refused) */
  add(q, y, r) {
    const key = campfireKey(q, y, r);
    if (this.fires.has(key) || this.refused.has(key)) return false;
    const [x, z] = hexToWorld(q, r);
    const fire = { key, q, y, r, x, z, seed: cellSeed(q, y, r) };
    if (this.fires.size < CAMPFIRE_MAX_TRACKED) {
      this.fires.set(key, fire);
      return true;
    }
    this.refused.set(key, fire);
    this._stale = true;
    return false;
  }

  /** @returns {boolean} whether the cell was known (tracked or refused) */
  remove(q, y, r) {
    const key = campfireKey(q, y, r);
    if (this.fires.delete(key)) {
      if (this.refused.size > 0) this._stale = true; // a refused fire can take the free place
      return true;
    }
    return this.refused.delete(key);
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
   * measures; ties by key). Cheap no-op otherwise. Rebuilds only when a fire was refused or a tracked one removed since
   * the last rebuild, or (x, y, z) is CAMPFIRE_RETRACK_DISTANCE or more from where it last rebuilt. Call once a frame.
   * @returns {boolean} whether it rebuilt
   */
  retrack(x, y, z) {
    if (this.refused.size === 0) return false;
    const [ax, ay, az] = this._at;
    if (!this._stale && Math.hypot(x - ax, y - ay, z - az) < CAMPFIRE_RETRACK_DISTANCE) return false;
    const all = [...this.fires.values(), ...this.refused.values()];
    const dist = new Float64Array(all.length);
    for (let i = 0; i < all.length; i++) dist[i] = fireDist(all[i], x, y, z);
    const order = Array.from(all.keys());
    order.sort((a, b) => dist[a] - dist[b] || (all[a].key < all[b].key ? -1 : 1));
    this.fires.clear();
    this.refused.clear();
    for (let i = 0; i < order.length; i++) {
      const fire = all[order[i]];
      (i < CAMPFIRE_MAX_TRACKED ? this.fires : this.refused).set(fire.key, fire);
    }
    this._stale = false;
    this._at = [x, y, z];
    return true;
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
