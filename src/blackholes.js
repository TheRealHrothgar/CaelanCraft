// Caelancraft — Black Holes: placed cells that pull the player in and swallow the cells around them.
// See src/CONTRACTS.md §29. Pure: the world is reached only through the callbacks passed to update().
//
// Holes are tracked by cell key. Worldgen never emits BLACK_HOLE, so every hole in a world is a recorded edit:
// main seeds the tracker from World.edits on load (loadFromEdits) and keeps it in step through World.onBlockChange.
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_TRACKED,
} from './config.js';
import { BLOCK, isLiquid } from './blocks.js';
import { forEachEditedCell } from './coords.js';
import { hexToWorld, hexDistance } from './hex.js';
import { playerIntersectsBlock } from './physics.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * @typedef {Object} BlackHole
 * @property {string} key  "q,y,r"
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} cx   world centre x
 * @property {number} cy   world centre y (y + 0.5)
 * @property {number} cz   world centre z
 * @property {number} timer seconds until this hole may swallow again
 * @property {number} offset index into EAT_OFFSETS where the nearest-first search resumes
 */

/**
 * @typedef {Object} BlackHoleWorld
 * @property {GetBlockFn} getBlock
 * @property {(q: number, y: number, r: number, id: number) => boolean} setBlock
 * @property {(q: number, r: number) => boolean} isLoaded   true when the column's chunk is loaded
 */

/** "q,y,r" — same shape as rune keys. */
export function holeKey(q, y, r) {
  return `${q},${y},${r}`;
}

/**
 * Cells a black hole may swallow: anything except air, liquids (no draining oceans), bedrock (the world floor),
 * Rune Blocks (they carry scripts) and other black holes.
 * @param {number} id
 */
export function canSwallow(id) {
  return id !== BLOCK.AIR && id !== BLOCK.BEDROCK && id !== BLOCK.RUNE_BLOCK && id !== BLOCK.BLACK_HOLE && !isLiquid(id);
}

/**
 * Relative cells (dq, dy, dr) whose centre lies within BLACK_HOLE_EAT_RADIUS of the hole's centre, excluding the
 * hole itself, sorted nearest-first (ties: dy, then dq, then dr) so each hole carves a growing ball.
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const EAT_OFFSETS = (() => {
  const R = BLACK_HOLE_EAT_RADIUS;
  const [ox, oz] = hexToWorld(0, 0);
  /** @type {[number, number, number, number][]} */
  const list = [];
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = -R; dr <= R; dr++) {
      if (hexDistance(0, 0, dq, dr) > R) continue;
      const [x, z] = hexToWorld(dq, dr);
      for (let dy = -R; dy <= R; dy++) {
        if (dq === 0 && dr === 0 && dy === 0) continue;
        const d = Math.hypot(x - ox, dy, z - oz);
        if (d <= R) list.push([d, dq, dy, dr]);
      }
    }
  }
  list.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1] || a[3] - b[3]);
  return Object.freeze(list.map(([, dq, dy, dr]) => Object.freeze([dq, dy, dr])));
})();

export class BlackHoles {
  constructor() {
    /** @type {Map<string, BlackHole>} */
    this.holes = new Map();
    /** round-robin start so a crowd of holes shares the per-frame eat budget fairly */
    this._cursor = 0;
  }

  get size() {
    return this.holes.size;
  }

  clear() {
    this.holes.clear();
    this._cursor = 0;
  }

  /** Track a hole at (q, y, r). @returns {boolean} false when already tracked or at BLACK_HOLE_MAX_TRACKED */
  add(q, y, r) {
    const key = holeKey(q, y, r);
    if (this.holes.has(key) || this.holes.size >= BLACK_HOLE_MAX_TRACKED) return false;
    const [cx, cz] = hexToWorld(q, r);
    this.holes.set(key, { key, q, y, r, cx, cy: y + 0.5, cz, timer: BLACK_HOLE_EAT_INTERVAL_S, offset: 0 });
    return true;
  }

  /** @returns {boolean} true when a tracked hole was removed */
  remove(q, y, r) {
    return this.holes.delete(holeKey(q, y, r));
  }

  /** World.onBlockChange hook. */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.BLACK_HOLE && prev !== BLOCK.BLACK_HOLE) this.add(q, y, r);
    else if (prev === BLOCK.BLACK_HOLE && next !== BLOCK.BLACK_HOLE) this.remove(q, y, r);
    else if (canSwallow(next) && this.holes.size > 0) this._reopen(q, y, r); // new food: holes nearby look again
  }

  /**
   * Replace the tracked set with every BLACK_HOLE cell recorded in `edits` (World.edits: chunk key → Map(localIndex → id)).
   * @param {Map<string, Map<number, number>>} edits
   */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.BLACK_HOLE, (q, y, r) => this.add(q, y, r));
  }

  /**
   * Sum of the pulls on a point, in m/s²: each hole within BLACK_HOLE_PULL_RADIUS pulls toward its centre with
   * BLACK_HOLE_PULL_STRENGTH · (1 − d/R)².
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {[number, number, number]} [out]
   * @returns {[number, number, number]}
   */
  pullAt(x, y, z, out = [0, 0, 0]) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const R = BLACK_HOLE_PULL_RADIUS;
    for (const h of this.holes.values()) {
      const dx = h.cx - x;
      const dy = h.cy - y;
      const dz = h.cz - z;
      const d = Math.hypot(dx, dy, dz);
      if (!(d < R) || d < 1e-6) continue;
      const f = 1 - d / R;
      const a = (BLACK_HOLE_PULL_STRENGTH * f * f) / d;
      out[0] += dx * a;
      out[1] += dy * a;
      out[2] += dz * a;
    }
    return out;
  }

  /**
   * @param {PlayerState} p
   * @returns {BlackHole|null} a hole whose cell the player's body overlaps (the player has been swallowed)
   */
  swallowing(p) {
    for (const h of this.holes.values()) {
      if (playerIntersectsBlock(p, h.q, h.y, h.r)) return h;
    }
    return null;
  }

  /**
   * Advance every hole's timer; holes whose timer ran out swallow their nearest swallowable cell, at most
   * BLACK_HOLE_MAX_EATS_PER_FRAME across all holes. Holes in unloaded chunks are frozen (and so is the cell they
   * would eat when that cell's chunk is unloaded). A hole whose ball is empty keeps its timer at zero and costs
   * nothing until a cell inside it changes (onBlockChange reopens the search).
   * @param {number} dt
   * @param {BlackHoleWorld} world
   * @returns {{q:number, y:number, r:number, id:number}[]} the cells swallowed this call (old ids)
   */
  update(dt, world) {
    /** @type {{q:number, y:number, r:number, id:number}[]} */
    const eaten = [];
    const n = this.holes.size;
    if (n === 0 || !(dt > 0)) return eaten;
    const list = Array.from(this.holes.values());
    const start = this._cursor % n;
    for (let i = 0; i < n; i++) {
      const h = list[(start + i) % n];
      if (!world.isLoaded(h.q, h.r)) continue;
      if (h.offset >= EAT_OFFSETS.length) continue; // exhausted: nothing left to eat
      h.timer -= dt;
      if (h.timer > 0) continue;
      if (eaten.length >= BLACK_HOLE_MAX_EATS_PER_FRAME) {
        h.timer = 0; // ready; first in line next frame
        continue;
      }
      h.timer += BLACK_HOLE_EAT_INTERVAL_S;
      if (h.timer < 0) h.timer = 0;
      const cell = this._nextCell(h, world);
      if (cell === null) continue;
      const [q, y, r, id] = cell;
      // setBlock fires onBlockChange with next = AIR, which reopens nothing: h.offset stays on this (now empty) cell.
      if (world.setBlock(q, y, r, BLOCK.AIR)) eaten.push({ q, y, r, id });
    }
    this._cursor = (start + 1) % Math.max(1, n);
    return eaten;
  }

  /**
   * Nearest swallowable loaded cell of `h`, resuming from h.offset (cells before it were empty or protected).
   * @returns {[number, number, number, number]|null} [q, y, r, id]
   */
  _nextCell(h, world) {
    for (; h.offset < EAT_OFFSETS.length; h.offset++) {
      const [dq, dy, dr] = EAT_OFFSETS[h.offset];
      const q = h.q + dq;
      const y = h.y + dy;
      const r = h.r + dr;
      if (!world.isLoaded(q, r)) return null; // wait for the chunk rather than skipping past it
      const id = world.getBlock(q, y, r);
      if (canSwallow(id)) return [q, y, r, id];
    }
    return null;
  }

  /** A cell changed: every hole whose ball contains it restarts its nearest-first search. */
  _reopen(q, y, r) {
    for (const h of this.holes.values()) {
      if (Math.abs(y - h.y) > BLACK_HOLE_EAT_RADIUS) continue;
      if (hexDistance(h.q, h.r, q, r) > BLACK_HOLE_EAT_RADIUS) continue;
      h.offset = 0;
    }
  }
}
