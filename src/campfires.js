// Caelancraft — Campfires: where they are, which are near, and how they flicker. See src/CONTRACTS.md §32. Pure.
//
// A campfire is a CAMPFIRE cell. Worldgen never emits one, so main seeds the tracker from World.edits on load
// (loadFromEdits) and keeps it in step through World.onBlockChange, exactly like black holes. The model, light and
// smoke are drawn by campfireRenderer.js; this module only answers "which fires, where, how bright".
import { CAMPFIRE_MAX_TRACKED } from './config.js';
import { BLOCK } from './blocks.js';
import { forEachEditedCell } from './coords.js';
import { hexToWorld } from './hex.js';

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

export class Campfires {
  constructor() {
    /** @type {Map<string, Campfire>} */
    this.fires = new Map();
  }

  get size() {
    return this.fires.size;
  }

  clear() {
    this.fires.clear();
  }

  /** @returns {boolean} false when already tracked or at CAMPFIRE_MAX_TRACKED */
  add(q, y, r) {
    const key = campfireKey(q, y, r);
    if (this.fires.has(key) || this.fires.size >= CAMPFIRE_MAX_TRACKED) return false;
    const [x, z] = hexToWorld(q, r);
    this.fires.set(key, { key, q, y, r, x, z, seed: cellSeed(q, y, r) });
    return true;
  }

  /** @returns {boolean} */
  remove(q, y, r) {
    return this.fires.delete(campfireKey(q, y, r));
  }

  has(q, y, r) {
    return this.fires.has(campfireKey(q, y, r));
  }

  /** World.onBlockChange hook. */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.CAMPFIRE && prev !== BLOCK.CAMPFIRE) this.add(q, y, r);
    else if (prev === BLOCK.CAMPFIRE && next !== BLOCK.CAMPFIRE) this.remove(q, y, r);
  }

  /** Replace the tracked set with every CAMPFIRE cell recorded in World.edits. */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.CAMPFIRE, (q, y, r) => this.add(q, y, r));
  }

  /**
   * Fires whose floor centre is within `maxDist` of (x, y, z), nearest first, at most `limit`.
   * @returns {{ fire: Campfire, dist: number }[]}
   */
  nearest(x, y, z, maxDist, limit = Infinity) {
    /** @type {{ fire: Campfire, dist: number }[]} */
    const out = [];
    for (const fire of this.fires.values()) {
      const dist = Math.hypot(fire.x - x, fire.y + 0.3 - y, fire.z - z);
      if (dist <= maxDist) out.push({ fire, dist });
    }
    out.sort((a, b) => a.dist - b.dist || (a.fire.key < b.fire.key ? -1 : 1));
    if (out.length > limit) out.length = limit;
    return out;
  }
}
