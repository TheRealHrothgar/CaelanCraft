// Caelancraft — the Pennant (CONTRACTS §101.4): where the pennants are, and how a pennant's flag lies in the wind. PURE.
//
// A pennant is a PENNANT cell: a hexagonal pole with a small cloth flag near its top, drawn by pennantRenderer.js (not
// the chunk mesher). Worldgen never makes one, so main seeds the tracker from World.edits on load (loadFromEdits) and
// keeps it in step through World.onBlockChange, like the campfires, and through World.onChunkGenerated (onChunkLoaded:
// a pennant another player placed or pulled up in a chunk not generated here comes in with that chunk).
//
// The flag is a ribbon of PENNANT_SEGMENTS columns from the pole to its tip, each column a vertical edge of the cloth.
// In a calm it hangs limp down the pole; in a breeze it lifts; in a strong breeze it streams straight out downwind. A
// wave runs along it from the pole to the tip: slow and small in a calm, quick and wide in a gust.
import { BLOCK } from './blocks.js';
import { CHUNK_SIZE } from './config.js';
import { forEachEditedCell, forEachEditedCellIn } from './coords.js';
import { hexToWorld } from './hex.js';
import { WIND_CALM } from './wind.js';

/** Columns of the flag (PENNANT_SEGMENTS + 1 vertical edges, the first at the pole). */
export const PENNANT_SEGMENTS = 8;
/** The pole's height above its cell's floor (m): tall when the cell above is open air, short under anything else. */
export const PENNANT_POLE_TALL = 1.75;
export const PENNANT_POLE_SHORT = 0.95;
/** The pole's radius (m); its six faces are the honeycomb again. */
export const PENNANT_POLE_RADIUS = 0.04;
/** The flag's length (pole to tip) and the height of its edge at the pole (the hoist), as shares of the pole's height. */
export const PENNANT_FLAG_LENGTH = 0.4;
export const PENNANT_FLAG_HOIST = 0.22;
/** The flag tapers to this share of its hoist at the tip: a pennant, not a banner. */
export const PENNANT_TIP = 0.18;
/** The flag's top edge sits this far (m) below the top of the pole, under the knob. */
export const PENNANT_FLAG_DROP = 0.05;
/** How far below the horizontal the flag's root points in a dead calm (radians, about 79°): it hangs down the pole. */
export const PENNANT_LIMP = 1.38;
/** The flag's fly droops this much more than its root, in a calm (radians, scaled by 1 − lift). */
export const PENNANT_SAG = 0.35;
/** A hanging flag's columns lean this share of its droop, growing over the first part of its length (no fold-over). */
export const PENNANT_COLUMN_LEAN = 0.5;
/**
 * Strength at which the flag starts to lift (the end of a calm, wind.WIND_CALM: it hangs while the vane says "Calm"),
 * and the span over which it comes up to straight out (at 0.7).
 */
export const PENNANT_LIFT_FROM = WIND_CALM;
export const PENNANT_LIFT_SPAN = 0.52;
/** Pennants drawn at once (nearest the eye), and how near they must be (m). */
export const PENNANT_MAX_MODELS = 24;
export const PENNANT_MODEL_RANGE = 64;

/**
 * @typedef {Object} Pennant
 * @property {string} key  "q,y,r"
 * @property {number} q
 * @property {number} y    the cell (its floor is at y)
 * @property {number} r
 * @property {number} x    world centre of the cell
 * @property {number} z
 * @property {number} seed a per-pennant phase in [0, 2π), so neighbouring flags do not wave in step
 */

/** "q,y,r" */
export function pennantKey(q, y, r) {
  return `${q},${y},${r}`;
}

/** A small deterministic per-cell phase in [0, 2π). */
export function pennantSeed(q, y, r) {
  let h = Math.imul(q | 0, 0x2c1b3c6d) ^ Math.imul(y | 0, 0x297a2d39) ^ Math.imul(r | 0, 0x1b56c4e9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * Math.PI * 2;
}

/** Where the pennants are: every PENNANT cell placed in the world (World.edits) and changed since. */
export class Pennants {
  constructor() {
    /** @type {Map<string, Pennant>} */
    this.list = new Map();
  }

  get size() {
    return this.list.size;
  }

  clear() {
    this.list.clear();
  }

  /** @param {number} q @param {number} y @param {number} r */
  add(q, y, r) {
    const key = pennantKey(q, y, r);
    if (this.list.has(key)) return;
    const [x, z] = hexToWorld(q, r);
    this.list.set(key, { key, q, y, r, x, z, seed: pennantSeed(q, y, r) });
  }

  /** @param {number} q @param {number} y @param {number} r */
  remove(q, y, r) {
    this.list.delete(pennantKey(q, y, r));
  }

  /** @param {number} q @param {number} y @param {number} r @returns {boolean} */
  has(q, y, r) {
    return this.list.has(pennantKey(q, y, r));
  }

  /** World.onBlockChange: a PENNANT written or taken away. */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.PENNANT && prev !== BLOCK.PENNANT) this.add(q, y, r);
    else if (prev === BLOCK.PENNANT && next !== BLOCK.PENNANT) this.remove(q, y, r);
  }

  /** Replace the set with every PENNANT cell recorded in World.edits. */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.PENNANT, (q, y, r) => this.add(q, y, r));
  }

  /**
   * World.onChunkGenerated: bring chunk (cq, cr) into step with its blocks. Cells written into a chunk not generated
   * here (World.applyServerCell: another player's pennant on a server) fire no onBlockChange, so when the chunk comes
   * in its tracked pennants that are gone are dropped and every PENNANT in its edits is added (worldgen makes none).
   * @param {number} cq @param {number} cr
   * @param {Map<string, Map<number, number>>} edits  World.edits
   * @param {(q: number, y: number, r: number) => number} getBlock
   */
  onChunkLoaded(cq, cr, edits, getBlock) {
    for (const p of this.list.values()) {
      if (Math.floor(p.q / CHUNK_SIZE) !== cq || Math.floor(p.r / CHUNK_SIZE) !== cr) continue;
      if (getBlock(p.q, p.y, p.r) !== BLOCK.PENNANT) this.list.delete(p.key); // deleting while iterating a Map is safe
    }
    forEachEditedCellIn(edits, cq, cr, BLOCK.PENNANT, (q, y, r) => this.add(q, y, r));
  }

  /**
   * The pennants within `maxDist` of (x, y, z) (measured to the middle of the pole), nearest first (ties by key), at
   * most `limit`.
   * @param {number} x @param {number} y @param {number} z @param {number} maxDist @param {number} [limit]
   * @returns {{ pennant: Pennant, dist: number }[]}
   */
  nearest(x, y, z, maxDist, limit = Infinity) {
    /** @type {{ pennant: Pennant, dist: number }[]} */
    const out = [];
    for (const p of this.list.values()) {
      const dist = Math.hypot(p.x - x, p.y + 1 - y, p.z - z);
      if (dist <= maxDist) out.push({ pennant: p, dist });
    }
    out.sort((a, b) => a.dist - b.dist || (a.pennant.key < b.pennant.key ? -1 : 1));
    if (out.length > limit) out.length = limit;
    return out;
  }
}

/**
 * How high the pole stands (m above its cell's floor): PENNANT_POLE_TALL when the cell above is open air, else
 * PENNANT_POLE_SHORT (it never pokes through a block over it).
 * @param {number} above  the block id of the cell above
 * @returns {number}
 */
export function poleHeight(above) {
  return above === BLOCK.AIR ? PENNANT_POLE_TALL : PENNANT_POLE_SHORT;
}

/**
 * How far the flag stands out in a wind of `strength` (0..1): 0 hangs limp, 1 straight out. It starts to lift at
 * PENNANT_LIFT_FROM and is straight out by PENNANT_LIFT_FROM + PENNANT_LIFT_SPAN (a breeze); it comes up quickly at first.
 * @param {number} strength @returns {number}
 */
export function flagLift(strength) {
  const s = Number.isFinite(strength) ? strength : 0;
  const x = Math.min(1, Math.max(0, (s - PENNANT_LIFT_FROM) / PENNANT_LIFT_SPAN));
  return 1 - (1 - x) * (1 - x);
}

/**
 * The flag's wave: its speed (radians a second) and its sideways reach at the tip (m), for a flag of `length`.
 * @param {number} strength @param {number} gust @param {number} length
 * @returns {{ omega: number, amp: number }}
 */
export function flagWave(strength, gust, length) {
  const s = Number.isFinite(strength) ? Math.max(0, strength) : 0;
  const g = Number.isFinite(gust) ? Math.min(1, Math.max(0, gust)) : 0;
  const lift = flagLift(s);
  return { omega: 2.5 + 9 * s + 6 * g, amp: length * (0.06 + 0.14 * lift + 0.12 * g) };
}

/** Floats `flagRibbon` writes: (PENNANT_SEGMENTS + 1) columns × 2 vertices (top, bottom) × xyz. */
export const FLAG_FLOATS = (PENNANT_SEGMENTS + 1) * 2 * 3;

/**
 * The flag's cloth at time `t`, in the pennant's own frame: +x downwind (level), +y up, +z across the wind, its root's top
 * corner at the origin (the caller puts it under the knob, on the pole). Writes
 * (PENNANT_SEGMENTS + 1) columns, each its top then its bottom vertex: column 0 is the hoist on the pole (x = z = 0,
 * vertical, from y = 0 down to y = −hoist), the last the tip.
 * @param {number} strength 0..1  @param {number} gust 0..1  @param {number} t seconds  @param {number} seed phase
 * @param {number} length m  @param {number} hoist m  @param {Float32Array|number[]} [out]  FLAG_FLOATS numbers
 * @returns {Float32Array|number[]}
 */
export function flagRibbon(strength, gust, t, seed, length, hoist, out = new Float32Array(FLAG_FLOATS)) {
  const n = PENNANT_SEGMENTS;
  const lift = flagLift(strength);
  const droop = PENNANT_LIMP * (1 - lift);
  const sag = PENNANT_SAG * (1 - lift);
  const { omega, amp } = flagWave(strength, gust, length);
  const ds = length / n;
  const time = Number.isFinite(t) ? t : 0;
  let cx = 0;
  let cy = -hoist / 2;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const d = droop + sag * u;
    if (i > 0) {
      const dm = droop + sag * (u - 0.5 / n); // the segment's own angle, at its middle
      cx += ds * Math.cos(dm);
      cy -= ds * Math.sin(dm);
    }
    const phase = 2 * Math.PI * 1.2 * u - omega * time + seed;
    const z = amp * Math.pow(u, 1.3) * Math.sin(phase);
    const ripple = 0.3 * amp * u * Math.cos(phase) * lift;
    const half = (hoist / 2) * (1 - (1 - PENNANT_TIP) * u);
    // the column's direction: upright at the pole, leaning with the droop farther out so a hanging cloth never folds
    // onto itself
    const ramp = u >= 0.35 ? 1 : (u / 0.35) * (u / 0.35) * (3 - (2 * u) / 0.35);
    const lean = PENNANT_COLUMN_LEAN * d * ramp;
    const ux = Math.sin(lean) * half;
    const uy = Math.cos(lean) * half;
    const o = i * 6;
    out[o] = cx + ux;
    out[o + 1] = cy + ripple + uy;
    out[o + 2] = z;
    out[o + 3] = cx - ux;
    out[o + 4] = cy + ripple - uy;
    out[o + 5] = z;
  }
  return out;
}
