// Caelancraft — Black Holes: dormant Collapsar Charges that collapse, when set off, into permanent spiralling vortices
// that pull bodies in and swallow the cells around them. See src/CONTRACTS.md §29 and docs/DESIGN-circuits.md §2
// (black holes v2, CONTRACTS §54 once integrated). Pure: the world is reached only through the callbacks passed in.
//
// Holes are tracked by cell key. Worldgen never emits BLACK_HOLE, so every hole in a world is a recorded edit:
// main seeds the tracker from World.edits on load (loadFromEdits) and keeps it in step through World.onBlockChange.
// Holes past BLACK_HOLE_MAX_TRACKED are remembered as inert and woken, oldest first, when tracked ones go.
//
// v2 (DESIGN-circuits §2.3): a hole has a phase derived from its `age`, the seconds since its charge began arming.
//   ARM (0 – 0.4 s)      the charge is still a block (an `arming` entry, not a hole yet); breaking it cancels
//   FLASH (0.4 – 0.7)    update has written BLACK_HOLE into the cell; the scene light and the screen flash
//   IMPLODE (0.7 – 1.9)  the charge copy crumples, a shell of light collapses; the pull ramps as s²
//   VORTEX (1.9 – ∞)     pull with swirl, eating and swallowing
// Ages advance only in update(dt), so pausing freezes them. Phases are never saved: a hole loaded from edits, or added
// with no phase, is a VORTEX at once (age Infinity). Every phase change is queued as a BlackHoleEvent for main's sounds,
// flashes and particles (drainEvents), so this module itself never plays or draws anything.
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, BLACK_HOLE_MAX_TRACKED, BLACK_HOLE_RESPAWN_RINGS,
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, PLAYER_HEIGHT,
  BLACK_HOLE_ARM_S, BLACK_HOLE_FLASH_S, BLACK_HOLE_IMPLODE_S, BLACK_HOLE_SWIRL, BLACK_HOLE_SWIRL_CORE,
  BLACK_HOLE_FLASH_INTENSITY, BLACK_HOLE_FLASH_COLOR, BLACK_HOLE_PINCH_DEG, BLACK_HOLE_PINCH_RANGE,
  BLACK_HOLE_STRETCH_DEG,
} from './config.js';
import { BLOCK, isLiquid, isSolid } from './blocks.js';
import { chunkKey, forEachEditedCell, localIndex } from './coords.js';
import { HEX_DIRS, hexToWorld, hexDistance, worldToHex } from './hex.js';
import { playerIntersectsBlock } from './physics.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/** @typedef {import('./types.js').BlackHoleEvent} BlackHoleEvent */
/** @typedef {import('./types.js').VortexView} VortexView */

/** A hole's phase (DESIGN-circuits §2.3). ARM belongs to an arming charge; a tracked hole is FLASH, IMPLODE or VORTEX. */
export const PHASE = Object.freeze({ ARM: 0, FLASH: 1, IMPLODE: 2, VORTEX: 3 });
/** Ages at which FLASH, IMPLODE and VORTEX begin. */
const T_FLASH = BLACK_HOLE_ARM_S;
const T_IMPLODE = T_FLASH + BLACK_HOLE_FLASH_S;
const T_VORTEX = T_IMPLODE + BLACK_HOLE_IMPLODE_S;
/** The photon-ring flare when a vortex forms (§2.3): a VortexView's `s` runs 0 → 1 over it, then stays 1. */
const FORM_FLARE_S = 0.25;
/** Ages are summed from dt, so a boundary counts as reached within this (0.1 + 0.1 + 0.1 + 0.1 is 0.4 ± 1 ulp). */
const AGE_EPS = 1e-9;
/** Pending events kept for main (drainEvents); past this the oldest are dropped. */
const MAX_PENDING_EVENTS = 1024;
/** The charge copy is pushed while its implosion scale is above this (fallingRenderer treats a scale ≤ 0 as 1). */
const MIN_COPY_SCALE = 0.01;
/** Camera shake during IMPLODE: amplitude (m) and rate (Hz), falling off over BLACK_HOLE_PINCH_RANGE (§2.4.6). */
const SHAKE_M = 0.05;
const SHAKE_HZ = 9;
/** An inert hole's (and a switched-off hole's) draw strength. */
const WEAK = 0.2;
/** vortexViews rescans the inert set when the eye has moved this far (or the set changed). */
const INERT_RESCAN_MOVE = 8;
const PHASE_NAMES = Object.freeze(['arming', 'flash', 'imploding', 'vortex']);

/**
 * @typedef {Object} BlackHole
 * @property {string} key  "q,y,r"
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} cx   world centre x
 * @property {number} cy   world centre y (y + 0.5)
 * @property {number} cz   world centre z
 * @property {boolean} due  owes one eat in the current round (every VORTEX hole gets one per BLACK_HOLE_EAT_INTERVAL_S)
 * @property {number} offset index into EAT_OFFSETS where the nearest-first search resumes
 * @property {number} age   seconds since its charge began arming (BLACK_HOLE_ARM_S at FLASH; Infinity when it was loaded
 *                          or added as a VORTEX)
 * @property {number} phase PHASE.FLASH, IMPLODE or VORTEX (derived from age)
 * @property {number} s     progress through the phase, 0..1 (VORTEX: through the 0.25 s forming flare; 1 when loaded)
 * @property {number} seed  0..1, a hash of the cell (the disk's arm angle)
 * @property {boolean} fromCharge  the cell was a COLLAPSAR_CHARGE before (the charge copy is drawn)
 */

/**
 * A charge that is arming (phase ARM): the cell still holds the COLLAPSAR_CHARGE.
 * @typedef {Object} ArmingCharge
 * @property {string} key
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} age   seconds since activate
 * @property {number} seed
 */

/**
 * @typedef {Object} EatRecord  one swallowed cell (update's result), with the centre of the hole that ate it
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} id   the cell's old block id
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 */

/**
 * @typedef {Object} BlackHoleWorld
 * @property {GetBlockFn} getBlock
 * @property {(q: number, y: number, r: number, id: number) => boolean} setBlock   eats (main: lazy)
 * @property {(q: number, r: number) => boolean} isLoaded   true when the column's chunk is loaded
 * @property {(q: number, y: number, r: number, id: number, lazy: boolean) => boolean} [place]  the ARM → FLASH write of
 *   BLACK_HOLE (main: world.setBlock(q, y, r, id, lazy)); without it update falls back to setBlock
 */

/**
 * @typedef {Object} ActivateWorld  what activate reads
 * @property {GetBlockFn} getBlock
 * @property {(q: number, r: number) => boolean} isLoaded
 */

/**
 * @typedef {Object} ActivateResult
 * @property {boolean} ok
 * @property {string} message
 * @property {boolean} [quiet]  a refusal that should say nothing (the charge is already collapsing)
 */

/**
 * @typedef {(id: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number, scale?: number) => void} RenderPush
 *   one moving block for fallingRenderer (blockphysics' RenderItem fields, positional: no allocation)
 */

/**
 * Phase and progress of an age (DESIGN-circuits §2.3). VORTEX progress runs through the forming flare (0.25 s) and
 * is 1 for an infinite age (a hole loaded as a vortex).
 * @param {number} age
 * @param {number[]} [out]
 * @returns {number[]} out = [phase, s]
 */
export function phaseAt(age, out = [0, 0]) {
  const a = age + AGE_EPS;
  if (a < T_FLASH) {
    out[0] = PHASE.ARM;
    out[1] = Math.max(0, age) / BLACK_HOLE_ARM_S;
  } else if (a < T_IMPLODE) {
    out[0] = PHASE.FLASH;
    out[1] = Math.max(0, Math.min(1, (age - T_FLASH) / BLACK_HOLE_FLASH_S));
  } else if (a < T_VORTEX) {
    out[0] = PHASE.IMPLODE;
    out[1] = Math.max(0, Math.min(1, (age - T_IMPLODE) / BLACK_HOLE_IMPLODE_S));
  } else {
    out[0] = PHASE.VORTEX;
    out[1] = age === Infinity ? 1 : Math.max(0, Math.min(1, (age - T_VORTEX) / FORM_FLARE_S));
  }
  return out;
}

/**
 * The pull's strength factor for a phase (§2.3): 0 in ARM and FLASH, s² in IMPLODE, 1 in VORTEX.
 * @param {number} phase
 * @param {number} s
 */
export function pullFactor(phase, s) {
  if (phase === PHASE.VORTEX) return 1;
  if (phase === PHASE.IMPLODE) return s * s;
  return 0;
}

/** A cell's seed for the disk's arm angle: a 32-bit integer hash of (q, y, r) mapped to [0, 1). */
export function holeSeed(q, y, r) {
  let h = Math.imul(q | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(r | 0, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * @typedef {Object} RespawnWorld  what respawnPoint reads
 * @property {GetBlockFn} getBlock                               live blocks (edits included) of loaded chunks
 * @property {(q: number, r: number) => boolean} isLoaded       true when the column's chunk is loaded
 * @property {(q: number, r: number) => number} surfaceHeight   worldgen terrain height (World.getSurfaceHeight)
 * @property {(q: number, r: number) => boolean} hasEdits       true when World.edits records a cell of the column (columnHasEdits)
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

/**
 * Column offsets of the hex rings 0..BLACK_HOLE_RESPAWN_RINGS, ring by ring (ring n starts at n × HEX_DIRS[4] and
 * walks n steps along each of the six directions, like World.findSpawn's spiral), flattened as dq, dr pairs.
 */
const RESPAWN_OFFSETS = (() => {
  const out = [0, 0];
  for (let n = 1; n <= BLACK_HOLE_RESPAWN_RINGS; n++) {
    let dq = HEX_DIRS[4][0] * n;
    let dr = HEX_DIRS[4][1] * n;
    for (let side = 0; side < 6; side++) {
      for (let j = 0; j < n; j++) {
        out.push(dq, dr);
        dq += HEX_DIRS[side][0];
        dr += HEX_DIRS[side][1];
      }
    }
  }
  return Int16Array.from(out);
})();

/**
 * @param {Map<string, Map<number, number>>} edits World.edits (chunk key → Map(localIndex → id))
 * @returns {boolean} true when any cell of column (q, r) is a recorded edit
 */
export function columnHasEdits(edits, q, r) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const m = edits.get(chunkKey(cq, cr));
  if (m === undefined || m.size === 0) return false;
  const base = localIndex(q - cq * CHUNK_SIZE, 0, r - cr * CHUNK_SIZE); // a column's cells are contiguous, y innermost
  for (let y = 0; y < WORLD_HEIGHT; y++) if (m.has(base + y)) return true;
  return false;
}

/**
 * Feet height of the lowest place to stand in loaded column (q, r) at or above `fromFeet` (the column's natural ground,
 * worldgen surface + 1): a solid floor cell with AIR in the two cells the body takes (water, a campfire or a black hole
 * there do not count), under the world's ceiling. The search climbs through solid cells (blocks stacked on the ground
 * lift you onto them) and one-cell gaps, but two non-solid cells in a row that are no place to stand end it (null): the
 * ground spot is taken by water, a hole or a fire, or was dug away, and anything higher would be a roof, a sky platform
 * or a canopy over that gap. So a house built over the ground keeps you inside it.
 * @param {GetBlockFn} getBlock
 * @param {number} fromFeet
 * @returns {number|null}
 */
function standingFrom(getBlock, q, r, fromFeet) {
  let feet = Math.max(1, fromFeet);
  let below = getBlock(q, feet - 1, r);
  let at = getBlock(q, feet, r);
  let run = isSolid(below) ? 0 : 1; // non-solid cells in a row, up to and including `at` once updated
  for (; feet + PLAYER_HEIGHT <= WORLD_HEIGHT; feet++) {
    const head = getBlock(q, feet + 1, r);
    if (at === BLOCK.AIR && head === BLOCK.AIR && isSolid(below)) return feet;
    run = isSolid(at) ? 0 : run + 1;
    if (run >= 2) return null;
    below = at;
    at = head;
  }
  return null;
}

/** Packed id of chunk (cq, cr), the same scheme as World's lookup index. */
function chunkId(cq, cr) {
  return (cq + (1 << 20)) * (1 << 21) + (cr + (1 << 20));
}

/**
 * Add to `set` the chunks an eat at column (q, r) dirties: World.setBlock marks the cell's chunk and the chunks of its
 * six side neighbours (they differ only at a chunk border).
 * @param {number[]} set distinct chunk ids (a few entries)
 * @returns {number[]} set
 */
function addEatChunks(set, q, r) {
  for (let i = -1; i < 6; i++) {
    const nq = i < 0 ? q : q + HEX_DIRS[i][0];
    const nr = i < 0 ? r : r + HEX_DIRS[i][1];
    const id = chunkId(Math.floor(nq / CHUNK_SIZE), Math.floor(nr / CHUNK_SIZE));
    if (!set.includes(id)) set.push(id);
  }
  return set;
}

export class BlackHoles {
  constructor() {
    /** @type {Map<string, BlackHole>} */
    this.holes = new Map();
    /** @type {Map<string, [number, number, number]>} BLACK_HOLE cells refused at the cap (inert), oldest first */
    this._inert = new Map();
    /** @type {Map<string, ArmingCharge>} charges set off and still arming (the cell holds the charge) */
    this._arming = new Map();
    /** @type {BlackHoleEvent[]} phase changes not yet drained by main */
    this._events = [];
    /** round-robin start so a crowd of holes shares the per-frame limits fairly */
    this._cursor = 0;
    /** seconds until the next eating round (one shared clock keeps holes in step, so a chunk is re-meshed once a round) */
    this._clock = BLACK_HOLE_EAT_INTERVAL_S;
    /** @type {number[]} scratch: chunk ids dirtied by the current update's eats */
    this._eatChunks = [];
    /** @type {number[]} scratch: the same plus one candidate eat's chunks */
    this._tryChunks = [];
    /** @type {number[]} scratch for phaseAt */
    this._ps = [0, 0];
    /** the per-world `blackholes` switch (saved by main; §2.8) */
    this.enabled = true;
    /** bumps whenever `enabled` changes (main's autosave watches it) */
    this.switchVersion = 0;
    /** bumps whenever the inert set changes (vortexViews' cached inert list) */
    this._inertVersion = 0;
    /** vortexViews' cache of inert holes near the eye: [cx, cy, cz, seed] rows, nearest first (_inertNear) */
    this._inertCache = { version: -1, x: 0, y: 0, z: 0, range: -1, rows: /** @type {number[][]} */ ([]) };
    /** @type {{ d2: number, kind: number, src: * }[]} vortexViews' pooled candidates */
    this._cands = [];
    /** @type {VortexView[]} vortexViews' pooled views */
    this._viewPool = [];
    /** @type {{ d2: number, kind: number, src: * }[]} vortexViews' scratch: candidates sorted by distance */
    this._order = [];
  }

  get size() {
    return this.holes.size;
  }

  /** BLACK_HOLE cells left untracked because the cap was full: they do nothing until remove() wakes them. */
  get inert() {
    return this._inert.size;
  }

  /** Charges currently arming (set off, still a block). */
  get arming() {
    return this._arming.size;
  }

  /**
   * The Collapsar Charge at (q, y, r) has been set off and is still arming (main's circuits hook `chargeArming`: the hint
   * reads `Collapsar Charge · collapsing!`).
   * @returns {boolean}
   */
  isArming(q, y, r) {
    return this._arming.size > 0 && this._arming.has(holeKey(q, y, r));
  }

  /**
   * Something needs update() even with no tracked hole: a charge is arming, a hole is still forming, or events wait
   * to be drained. Main steps black holes while `size > 0 || busy`.
   */
  get busy() {
    if (this._arming.size > 0 || this._events.length > 0) return true;
    for (const h of this.holes.values()) if (h.phase !== PHASE.VORTEX) return true;
    return false;
  }

  /** Forget every hole, arming charge and pending event (a new world). The `enabled` switch is kept. */
  clear() {
    this.holes.clear();
    this._inert.clear();
    this._arming.clear();
    this._events.length = 0;
    this._inertVersion++;
    this._cursor = 0;
    this._clock = BLACK_HOLE_EAT_INTERVAL_S;
  }

  /**
   * The per-world switch (§2.8). Off: pullAt is 0, update eats nothing, swallowing is null, activate refuses, arming
   * charges are cancelled (they stay dormant charges) and holes still forming jump straight to VORTEX; the renderer
   * draws vortices at strength 0.2. On again: nothing that happened meanwhile is acted on (CONTRACTS pitfall 28).
   * @param {boolean} on
   */
  setEnabled(on) {
    const v = !!on;
    if (v === this.enabled) return;
    this.enabled = v;
    this.switchVersion++;
    if (v) {
      this._clock = BLACK_HOLE_EAT_INTERVAL_S;
      return;
    }
    for (const a of this._arming.values()) this._event('cancelled', a);
    this._arming.clear();
    for (const h of this.holes.values()) {
      if (h.phase === PHASE.VORTEX) continue;
      h.age = Infinity;
      h.phase = PHASE.VORTEX;
      h.s = 1;
    }
  }

  /**
   * Track a hole at (q, y, r). Past BLACK_HOLE_MAX_TRACKED the cell is remembered as inert instead, and remove()
   * wakes it once a tracked hole goes. With no phase (or VORTEX) the hole is a full vortex at once (loading, survival's
   * tests); with PHASE.FLASH it starts its flash with age = BLACK_HOLE_ARM_S and queues the `flash` event (IMPLODE
   * likewise from the implosion). While black holes are switched off every hole is added as a VORTEX.
   * @param {number} q
   * @param {number} y
   * @param {number} r
   * @param {number} [phase]
   * @returns {boolean} false when already tracked or at BLACK_HOLE_MAX_TRACKED
   */
  add(q, y, r, phase = PHASE.VORTEX) {
    return this._add(q, y, r, phase, false);
  }

  /** add() plus the charge flag (onBlockChange). */
  _add(q, y, r, phase, fromCharge) {
    const key = holeKey(q, y, r);
    if (this.holes.has(key)) return false;
    if (this.holes.size >= BLACK_HOLE_MAX_TRACKED) {
      if (!this._inert.has(key)) {
        this._inert.set(key, [q, y, r]);
        this._inertVersion++;
      }
      return false;
    }
    if (this._inert.delete(key)) this._inertVersion++;
    if (this.holes.size === 0) this._clock = BLACK_HOLE_EAT_INTERVAL_S; // a lone new hole first eats one interval after it appears
    const [cx, cz] = hexToWorld(q, r);
    let age = Infinity;
    if (this.enabled && phase !== PHASE.VORTEX) age = phase === PHASE.IMPLODE ? T_IMPLODE : T_FLASH;
    const [ph, s] = phaseAt(age, this._ps);
    /** @type {BlackHole} */
    const h = {
      key, q, y, r, cx, cy: y + 0.5, cz, due: false, offset: 0,
      age, phase: ph, s, seed: holeSeed(q, y, r), fromCharge: !!fromCharge && ph !== PHASE.VORTEX,
    };
    this.holes.set(key, h);
    if (ph === PHASE.FLASH) this._event('flash', h);
    else if (ph === PHASE.IMPLODE) this._event('implode', h);
    return true;
  }

  /**
   * Forget the hole at (q, y, r), tracked or inert. A freed tracked slot goes to the oldest inert hole (as a VORTEX).
   * @returns {boolean} true when a tracked hole was removed
   */
  remove(q, y, r) {
    const key = holeKey(q, y, r);
    if (this._inert.delete(key)) this._inertVersion++;
    if (!this.holes.delete(key)) return false;
    for (const [k, [iq, iy, ir]] of this._inert) {
      if (this.holes.size >= BLACK_HOLE_MAX_TRACKED) break;
      this._inert.delete(k); // deleting the entry being visited is safe during Map iteration
      this._inertVersion++;
      this.add(iq, iy, ir);
    }
    return true;
  }

  /**
   * World.onBlockChange hook — bookkeeping only (CONTRACTS pitfall 34: never a world write from here).
   * - BLACK_HOLE appears: a hole at FLASH (`fromCharge` when the cell held a COLLAPSAR_CHARGE); an arming entry there
   *   is consumed.
   * - BLACK_HOLE disappears (broken, replaced): the hole goes, with a `collapsed` event.
   * - An arming charge disappears any other way (broken, blasted, swallowed, crumbled): `cancelled`.
   * - A swallowable cell appears: holes nearby look again.
   */
  onBlockChange(q, y, r, prev, next) {
    if (next === BLOCK.BLACK_HOLE && prev !== BLOCK.BLACK_HOLE) {
      this._arming.delete(holeKey(q, y, r));
      this._add(q, y, r, PHASE.FLASH, prev === BLOCK.COLLAPSAR_CHARGE);
    } else if (prev === BLOCK.BLACK_HOLE && next !== BLOCK.BLACK_HOLE) {
      const key = holeKey(q, y, r);
      const h = this.holes.get(key);
      const wasInert = this._inert.has(key);
      if (this.remove(q, y, r) && h) this._event('collapsed', h);
      else if (wasInert) this._event('collapsed', this._centreOf(q, y, r));
    } else {
      if (prev === BLOCK.COLLAPSAR_CHARGE && next !== BLOCK.COLLAPSAR_CHARGE) {
        const key = holeKey(q, y, r);
        const a = this._arming.get(key);
        if (a) {
          this._arming.delete(key);
          this._event('cancelled', a);
        }
      }
      if (canSwallow(next) && this.holes.size > 0) this._reopen(q, y, r); // new food: holes nearby look again
    }
  }

  /**
   * Replace the tracked set with every BLACK_HOLE cell recorded in `edits` (World.edits: chunk key → Map(localIndex → id)),
   * all as full vortices (no flash: an old save's holes, or a reload during FLASH or IMPLODE, §2.3). Arming charges and
   * pending events are forgotten: a reload during ARM leaves a dormant charge.
   * @param {Map<string, Map<number, number>>} edits
   */
  loadFromEdits(edits) {
    this.clear();
    forEachEditedCell(edits, BLOCK.BLACK_HOLE, (q, y, r) => this.add(q, y, r));
  }

  /**
   * Set off the Collapsar Charge at (q, y, r) (§2.2): it starts arming, and update() turns the cell into a BLACK_HOLE
   * BLACK_HOLE_ARM_S later. Refused while black holes are off, when the cell is unloaded or holds no charge, and (quietly:
   * an igniter refires every 0.5 s) when it is already arming.
   * @param {number} q
   * @param {number} y
   * @param {number} r
   * @param {ActivateWorld} world
   * @returns {ActivateResult}
   */
  activate(q, y, r, world) {
    const at = `(${q}, ${y}, ${r})`;
    if (!this.enabled) return { ok: false, message: 'black holes are off — turn them on with `blackholes on`' };
    if (!world.isLoaded(q, r)) return { ok: false, message: `cell ${at} is not loaded` };
    if (world.getBlock(q, y, r) !== BLOCK.COLLAPSAR_CHARGE) return { ok: false, message: `there is no collapsar charge at ${at}` };
    const key = holeKey(q, y, r);
    if (this._arming.has(key)) return { ok: false, quiet: true, message: `the charge at ${at} is already collapsing` };
    const [cx, cz] = hexToWorld(q, r);
    /** @type {ArmingCharge} */
    const a = { key, q, y, r, cx, cy: y + 0.5, cz, age: 0, seed: holeSeed(q, y, r) };
    this._arming.set(key, a);
    this._event('arm', a);
    return { ok: true, message: `the collapsar charge at ${at} is collapsing` };
  }

  /**
   * Hand main every pending event, oldest first, and forget them.
   * @param {BlackHoleEvent[]} [out]
   * @returns {BlackHoleEvent[]} out
   */
  drainEvents(out = []) {
    for (const e of this._events) out.push(e);
    this._events.length = 0;
    return out;
  }

  /** Queue an event for main. @param {BlackHoleEvent['type']} type */
  _event(type, h) {
    if (this._events.length >= MAX_PENDING_EVENTS) this._events.shift();
    this._events.push({ type, q: h.q, y: h.y, r: h.r, cx: h.cx, cy: h.cy, cz: h.cz });
  }

  /** The centre of cell (q, y, r) as an event source. */
  _centreOf(q, y, r) {
    const [cx, cz] = hexToWorld(q, r);
    return { q, y, r, cx, cy: y + 0.5, cz };
  }

  /**
   * Sum of the pulls on a point, in m/s² (§2.5). For each hole with strength factor k_p (pullFactor of its phase; 0
   * while switched off) and body offset v = point − centre, d = |v|, ρ = hypot(vx, vz), 0 < d < R:
   *   g = BLACK_HOLE_PULL_STRENGTH · (1 − d/R)² · k_p;  radial = −g·v/d  (the v0.5 pull, unchanged)
   *   swirl = BLACK_HOLE_SWIRL · g · min(1, ρ / BLACK_HOLE_SWIRL_CORE) along +θ = (−vz, 0, vx)/ρ (θ = atan2(vz, vx))
   * so a body drifts in on a logarithmic spiral at about 58° to the radius, straightening inside 1.5 units.
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
    if (!this.enabled) return out;
    const R = BLACK_HOLE_PULL_RADIUS;
    for (const h of this.holes.values()) {
      const k = pullFactor(h.phase, h.s);
      if (k <= 0) continue;
      const dx = h.cx - x; // −v
      const dy = h.cy - y;
      const dz = h.cz - z;
      const d = Math.hypot(dx, dy, dz);
      if (!(d < R) || d < 1e-6) continue;
      const f = 1 - d / R;
      const g = BLACK_HOLE_PULL_STRENGTH * f * f * k;
      const a = g / d;
      out[0] += dx * a;
      out[1] += dy * a;
      out[2] += dz * a;
      const rho = Math.hypot(dx, dz);
      if (rho > 1e-6) {
        const w = (BLACK_HOLE_SWIRL * g * Math.min(1, rho / BLACK_HOLE_SWIRL_CORE)) / rho;
        out[0] += dz * w; // −vz = dz
        out[2] -= dx * w; // vx = −dx
      }
    }
    return out;
  }

  /**
   * @param {PlayerState} p
   * @returns {BlackHole|null} a VORTEX hole whose cell the body overlaps (it has been swallowed); null while switched off
   */
  swallowing(p) {
    if (!this.enabled) return null;
    for (const h of this.holes.values()) {
      if (h.phase !== PHASE.VORTEX) continue;
      if (playerIntersectsBlock(p, h.q, h.y, h.r)) return h;
    }
    return null;
  }

  /**
   * Distance from (x, y, z) to the nearest tracked hole centre (Infinity without holes). Returns early, with that
   * smaller distance, as soon as a hole closer than `stopBelow` turns up.
   */
  nearestDistance(x, y, z, stopBelow = 0) {
    const stopSq = stopBelow > 0 ? stopBelow * stopBelow : 0;
    let best = Infinity;
    for (const h of this.holes.values()) {
      const dx = h.cx - x;
      const dy = h.cy - y;
      const dz = h.cz - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        if (d2 < stopSq) break;
      }
    }
    return Math.sqrt(best);
  }

  /**
   * Where a swallowed player comes back. Columns are tried over the hex rings 0..BLACK_HOLE_RESPAWN_RINGS around the
   * world spawn's column, nearest ring first, and the first place to stand whose body middle (feet + PLAYER_HEIGHT / 2)
   * is at least BLACK_HOLE_PULL_RADIUS from every tracked hole wins. There the pull is zero and no eat ball reaches the
   * floor, so no hole can reach a player standing there. A loaded column is read live, so edits count (ground a hole
   * ate, a house built over spawn): searching upward from its natural ground (worldgen surface + 1, which for spawn's own
   * column is findSpawn's height), the feet go on the first solid cell with AIR for the body — inside a house over spawn,
   * never on its roof or on a platform or canopy high above. An unloaded column is judged from worldgen (dry land:
   * surface height ≥ SEA_LEVEL, feet at height + 1) and skipped when it has recorded edits.
   * If nothing is out of reach, the candidate farthest from every hole wins; with no candidate at all, `spawn`.
   * @param {[number, number, number]} spawn World.findSpawn() (world feet position)
   * @param {RespawnWorld} world
   * @returns {[number, number, number]} world feet position
   */
  respawnPoint(spawn, world) {
    const [q0, r0] = worldToHex(spawn[0], spawn[2]);
    /** @type {[number, number, number]|null} */
    let best = null;
    let bestD = -1;
    for (let i = 0; i < RESPAWN_OFFSETS.length; i += 2) {
      const q = q0 + RESPAWN_OFFSETS[i];
      const r = r0 + RESPAWN_OFFSETS[i + 1];
      let y = null;
      const h = world.surfaceHeight(q, r);
      if (world.isLoaded(q, r)) {
        y = standingFrom(world.getBlock, q, r, h + 1);
      } else if (!world.hasEdits(q, r)) {
        if (h >= SEA_LEVEL && h + 1 + PLAYER_HEIGHT <= WORLD_HEIGHT) y = h + 1;
      }
      if (y === null) continue;
      const [x, z] = hexToWorld(q, r);
      const d = this.nearestDistance(x, y + PLAYER_HEIGHT / 2, z, bestD);
      if (d >= BLACK_HOLE_PULL_RADIUS) return [x, y, z];
      if (d > bestD) {
        bestD = d;
        best = [x, y, z];
      }
    }
    return best ?? spawn;
  }


  /**
   * One frame of black holes (does nothing while switched off or for dt ≤ 0):
   * 1. Forming holes age by dt; each phase boundary crossed queues its event (`implode`, `formed`).
   * 2. Arming charges age; one that reaches BLACK_HOLE_ARM_S becomes a hole: `world.place(q, y, r, BLACK_HOLE, lazy)`,
   *    only if the cell still holds the charge (else `cancelled`) — non-lazily for the first 2 such writes of this call,
   *    lazily for the rest (a fuse setting off 20 charges in one tick must not re-mesh 80 chunks in one frame; the
   *    charge copy hides the delay). The write's onBlockChange adds the hole at FLASH (`flash`) with the arming's age.
   *    An arming charge in an unloaded column waits at the end of ARM until its chunk loads.
   * 3. Eating, VORTEX holes only, in rounds (CONTRACTS §29): a shared clock starts a round every
   *    BLACK_HOLE_EAT_INTERVAL_S (one per call at most, however long the frame), and each VORTEX hole then owes one eat
   *    (`due`; owed eats never pile up). A due hole swallows its nearest swallowable cell, at most
   *    BLACK_HOLE_MAX_EATS_PER_FRAME across all holes, and only while this call's eats dirty no more than
   *    max(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, chunks already dirtied by this call) distinct chunks: World.update
   *    re-meshes each of them at once, and the first eat always goes. Because the holes stay in step, a chunk full of
   *    holes is re-meshed once a round rather than every frame. A hole held back by a limit stays due, and the first
   *    one held back starts the next call, so crowds in different chunks take turns. A due hole in an unloaded column,
   *    or whose search is exhausted, is skipped and stays due: frozen until its chunk loads or a cell inside its ball
   *    changes (onBlockChange reopens the search). A search that finds nothing spends the hole's eat for the round.
   * @param {number} dt
   * @param {BlackHoleWorld} world
   * @returns {EatRecord[]} the cells swallowed this call (old ids, with the eating hole's centre)
   */
  update(dt, world) {
    /** @type {EatRecord[]} */
    const eaten = [];
    if (!(dt > 0) || !this.enabled) return eaten;
    const ps = this._ps;
    for (const h of this.holes.values()) {
      if (h.age === Infinity) continue;
      const before = h.phase;
      h.age += dt;
      phaseAt(h.age, ps);
      h.phase = ps[0];
      h.s = ps[1];
      for (let p = before + 1; p <= h.phase; p++) this._event(p === PHASE.IMPLODE ? 'implode' : p === PHASE.VORTEX ? 'formed' : 'flash', h);
    }
    if (this._arming.size > 0) this._arm(dt, world);
    const n = this.holes.size;
    if (n === 0) return eaten;
    this._clock -= dt;
    if (this._clock <= 0) {
      this._clock += BLACK_HOLE_EAT_INTERVAL_S;
      if (this._clock <= 0) this._clock = BLACK_HOLE_EAT_INTERVAL_S;
      for (const h of this.holes.values()) h.due = h.phase === PHASE.VORTEX;
    }
    const list = Array.from(this.holes.values());
    const start = this._cursor % n;
    const dirtied = this._eatChunks;
    dirtied.length = 0;
    let nextStart = -1; // the first due hole a limit held back
    for (let i = 0; i < n; i++) {
      const h = list[(start + i) % n];
      if (!h.due || h.offset >= EAT_OFFSETS.length || !world.isLoaded(h.q, h.r)) continue;
      if (eaten.length >= BLACK_HOLE_MAX_EATS_PER_FRAME) {
        if (nextStart < 0) nextStart = (start + i) % n;
        continue;
      }
      const cell = this._nextCell(h, world);
      if (cell !== null && eaten.length > 0) {
        const tried = this._tryChunks;
        tried.length = 0;
        for (const c of dirtied) tried.push(c);
        // Chunks this call already dirtied are re-meshed anyway, so more eats inside them cost no extra mesh.
        if (addEatChunks(tried, cell[0], cell[2]).length > Math.max(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, dirtied.length)) {
          if (nextStart < 0) nextStart = (start + i) % n;
          continue;
        }
      }
      h.due = false;
      if (cell === null) continue;
      const [q, y, r, id] = cell;
      // setBlock fires onBlockChange with next = AIR, which reopens nothing: h.offset stays on this (now empty) cell.
      if (world.setBlock(q, y, r, BLOCK.AIR)) {
        eaten.push({ q, y, r, id, cx: h.cx, cy: h.cy, cz: h.cz });
        addEatChunks(dirtied, q, r);
      }
    }
    this._cursor = nextStart >= 0 ? nextStart : (start + 1) % n;
    return eaten;
  }

  /** update step 2: age the arming charges and turn those whose ARM is over into holes. */
  _arm(dt, world) {
    let eager = 0;
    for (const a of Array.from(this._arming.values())) { // a copy: the writes below change the map
      a.age += dt;
      if (a.age + AGE_EPS < T_FLASH) continue;
      if (!world.isLoaded(a.q, a.r)) {
        a.age = T_FLASH; // frozen at the end of ARM until the chunk loads
        continue;
      }
      this._arming.delete(a.key);
      if (world.getBlock(a.q, a.y, a.r) !== BLOCK.COLLAPSAR_CHARGE) {
        this._event('cancelled', a);
        continue;
      }
      const lazy = eager >= 2;
      const ok = world.place ? world.place(a.q, a.y, a.r, BLOCK.BLACK_HOLE, lazy) : world.setBlock(a.q, a.y, a.r, BLOCK.BLACK_HOLE);
      if (!ok) {
        this._event('cancelled', a);
        continue;
      }
      if (!lazy) eager++;
      // The write's onBlockChange added the hole at FLASH; a world not wired to onBlockChange gets it here.
      if (!this.holes.has(a.key) && !this._inert.has(a.key)) this._add(a.q, a.y, a.r, PHASE.FLASH, true);
      const h = this.holes.get(a.key);
      if (h && h.phase === PHASE.FLASH) {
        h.age = Math.max(T_FLASH, Math.min(a.age, T_IMPLODE - AGE_EPS * 2)); // its overshoot of ARM counts toward FLASH
        h.s = phaseAt(h.age, this._ps)[1];
      }
    }
  }

  /**
   * The scene light for the brightest hole in FLASH (§2.3): at its centre, warm white BLACK_HOLE_FLASH_COLOR,
   * intensity BLACK_HOLE_FLASH_INTENSITY · (1 − u)² with u the FLASH progress. Intensity 0 when no hole flashes.
   * Main passes the brighter of this and explosions.flash to fallingRenderer.setFlash (one shared light).
   * @param {{ x: number, y: number, z: number, intensity: number, color?: number }} [out]
   */
  flash(out = { x: 0, y: 0, z: 0, intensity: 0, color: BLACK_HOLE_FLASH_COLOR }) {
    out.intensity = 0;
    out.color = BLACK_HOLE_FLASH_COLOR;
    for (const h of this.holes.values()) {
      if (h.phase !== PHASE.FLASH) continue;
      const k = 1 - h.s;
      const v = BLACK_HOLE_FLASH_INTENSITY * k * k;
      if (v <= out.intensity) continue;
      out.intensity = v;
      out.x = h.cx;
      out.y = h.cy;
      out.z = h.cz;
    }
    return out;
  }

  /**
   * Camera effects at the eye (§2.4.6), summed by main with its own:
   * - fov: the IMPLODE pinch −BLACK_HOLE_PINCH_DEG·(1 − d/24)·sin(π·s) (the strongest one), plus the stretch
   *   +BLACK_HOLE_STRETCH_DEG·(1 − d/10)² inside the pull radius of the nearest VORTEX (not while switched off);
   * - sx, sy, sz: a 0.05 m, 9 Hz shake during IMPLODE, falling off over 24 units (the strongest hole's, timed by its age).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{ fov: number, sx: number, sy: number, sz: number }} [out]
   */
  cameraFx(x, y, z, out = { fov: 0, sx: 0, sy: 0, sz: 0 }) {
    let pinch = 0;
    let amp = 0;
    let shakeAge = 0;
    let nearest = Infinity;
    for (const h of this.holes.values()) {
      const d = Math.hypot(h.cx - x, h.cy - y, h.cz - z);
      if (h.phase === PHASE.IMPLODE) {
        if (!(d < BLACK_HOLE_PINCH_RANGE)) continue;
        const k = 1 - d / BLACK_HOLE_PINCH_RANGE;
        const p = -BLACK_HOLE_PINCH_DEG * k * Math.sin(Math.PI * h.s);
        if (p < pinch) pinch = p;
        if (SHAKE_M * k > amp) {
          amp = SHAKE_M * k;
          shakeAge = h.age;
        }
      } else if (h.phase === PHASE.VORTEX && d < nearest) {
        nearest = d;
      }
    }
    let stretch = 0;
    if (this.enabled && nearest < BLACK_HOLE_PULL_RADIUS) {
      const k = 1 - nearest / BLACK_HOLE_PULL_RADIUS;
      stretch = BLACK_HOLE_STRETCH_DEG * k * k;
    }
    out.fov = pinch + stretch;
    const w = 2 * Math.PI * SHAKE_HZ * shakeAge;
    out.sx = amp * Math.sin(w);
    out.sy = amp * 0.6 * Math.sin(w * 1.37 + 1.1);
    out.sz = amp * Math.cos(w * 0.83 + 0.4);
    return out;
  }

  /**
   * What vortexRenderer draws (§2.4 budget), nearest first: every tracked hole, every arming charge (phase ARM) and
   * every inert hole (strength 0.2, a VORTEX) whose centre is within `range` of the eye, at most `maxCores`; the
   * nearest `maxFull` get `full = true` (disk, shell and lensed band). Tracked holes have strength 1, or 0.2 while
   * switched off. Inert holes are rescanned only when the inert set changes or the eye moves 8 units (a cached list).
   * The view objects are pooled: they stay valid until the next call.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} range
   * @param {number} maxFull
   * @param {number} maxCores
   * @param {VortexView[]} [out]
   * @returns {VortexView[]} out
   */
  vortexViews(x, y, z, range, maxFull, maxCores, out = []) {
    const r2 = range * range;
    const cands = this._cands;
    let n = 0;
    const take = (d2, kind, src) => {
      let c = cands[n];
      if (c === undefined) cands[n] = c = { d2: 0, kind: 0, src: null };
      c.d2 = d2;
      c.kind = kind;
      c.src = src;
      n++;
    };
    for (const h of this.holes.values()) {
      const d2 = (h.cx - x) ** 2 + (h.cy - y) ** 2 + (h.cz - z) ** 2;
      if (d2 <= r2) take(d2, 0, h);
    }
    for (const a of this._arming.values()) {
      const d2 = (a.cx - x) ** 2 + (a.cy - y) ** 2 + (a.cz - z) ** 2;
      if (d2 <= r2) take(d2, 1, a);
    }
    if (this._inert.size > 0) {
      for (const row of this._inertNear(x, y, z, range, maxCores)) {
        const d2 = (row[0] - x) ** 2 + (row[1] - y) ** 2 + (row[2] - z) ** 2;
        if (d2 <= r2) take(d2, 2, row);
      }
    }
    const order = this._order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = cands[i];
    order.sort((a, b) => a.d2 - b.d2);
    const m = Math.max(0, Math.min(n, Math.floor(maxCores)));
    out.length = m;
    const weak = this.enabled ? 1 : WEAK;
    for (let i = 0; i < m; i++) {
      const c = order[i];
      let v = this._viewPool[i];
      if (v === undefined) {
        v = { cx: 0, cy: 0, cz: 0, phase: 0, s: 0, strength: 0, seed: 0, age: 0, full: false };
        this._viewPool[i] = v;
      }
      if (c.kind === 2) {
        const row = c.src;
        v.cx = row[0];
        v.cy = row[1];
        v.cz = row[2];
        v.phase = PHASE.VORTEX;
        v.s = 1;
        v.strength = WEAK;
        v.seed = row[3];
        v.age = Infinity;
      } else {
        const h = c.src;
        v.cx = h.cx;
        v.cy = h.cy;
        v.cz = h.cz;
        v.seed = h.seed;
        v.age = h.age;
        if (c.kind === 1) {
          v.phase = PHASE.ARM;
          v.s = Math.min(1, h.age / BLACK_HOLE_ARM_S);
          v.strength = 1;
        } else {
          v.phase = h.phase;
          v.s = h.s;
          v.strength = weak;
        }
      }
      v.full = i < maxFull;
      out[i] = v;
    }
    for (let i = 0; i < n; i++) cands[i].src = null;
    order.length = 0;
    return out;
  }

  /**
   * Inert holes near the eye, nearest first (at most `max`), as [cx, cy, cz, seed] rows: the cached list, rebuilt when
   * the inert set changed, the range changed or the eye moved INERT_RESCAN_MOVE units since it was built. The list
   * covers range + INERT_RESCAN_MOVE, so nothing within range is missed between rescans.
   */
  _inertNear(x, y, z, range, max) {
    const c = this._inertCache;
    const moved = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (c.version === this._inertVersion && c.range === range && moved < INERT_RESCAN_MOVE) return c.rows;
    const reach = range + INERT_RESCAN_MOVE;
    /** @type {[number, number[]][]} */
    const found = [];
    for (const [q, iy, r] of this._inert.values()) {
      const [cx, cz] = hexToWorld(q, r);
      const cy = iy + 0.5;
      const d2 = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
      if (d2 <= reach * reach) found.push([d2, [cx, cy, cz, holeSeed(q, iy, r)]]);
    }
    found.sort((a, b) => a[0] - b[0]);
    if (found.length > max) found.length = Math.max(0, Math.floor(max));
    c.rows = found.map((f) => f[1]);
    c.version = this._inertVersion;
    c.range = range;
    c.x = x;
    c.y = y;
    c.z = z;
    return c.rows;
  }

  /**
   * The charge copy (§2.3), for holes made from a charge (`fromCharge`), from FLASH start through IMPLODE: a
   * COLLAPSAR_CHARGE block at the cell centre that swells in FLASH (scale 1 + 0.1·sin(π·u)) and crumples in IMPLODE
   * (scale 1 − s/0.7, spinning ry = 14·s², tilting rx toward 0.6), no longer pushed once its scale reaches 0.01
   * (never a scale ≤ 0: fallingRenderer would draw it at full size). A setblock hole has none.
   * @param {RenderPush} push
   */
  renderItems(push) {
    for (const h of this.holes.values()) {
      if (!h.fromCharge) continue;
      if (h.phase === PHASE.FLASH) {
        push(BLOCK.COLLAPSAR_CHARGE, h.cx, h.cy, h.cz, 0, 0, 0, 1 + 0.1 * Math.sin(Math.PI * h.s));
      } else if (h.phase === PHASE.IMPLODE) {
        const scale = 1 - h.s / 0.7;
        if (scale <= MIN_COPY_SCALE) continue;
        push(BLOCK.COLLAPSAR_CHARGE, h.cx, h.cy, h.cz, 0.6 * Math.min(1, h.s / 0.7), 14 * h.s * h.s, 0, scale);
      }
    }
  }

  /** `blackholes status`: 'black holes on · 3 active (1 forming), 0 inert'. Arming charges count as active and forming. */
  status() {
    let forming = this._arming.size;
    for (const h of this.holes.values()) if (h.phase !== PHASE.VORTEX) forming++;
    const active = this.holes.size + this._arming.size;
    return `black holes ${this.enabled ? 'on' : 'off'} · ${active} active${forming > 0 ? ` (${forming} forming)` : ''}, ${this._inert.size} inert`;
  }

  /**
   * `blackholes list`: the `n` nearest holes, arming charges and inert holes to (x, y, z), nearest first, as
   * '(3, 20, -4) · vortex · 12 m' (phases: arming, flash, imploding, vortex, inert).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [n]
   * @returns {string[]}
   */
  list(x, y, z, n = 8) {
    /** @type {[number, string][]} */
    const rows = [];
    const row = (q, iy, r, cx, cy, cz, what) => {
      const d = Math.hypot(cx - x, cy - y, cz - z);
      rows.push([d, `(${q}, ${iy}, ${r}) · ${what} · ${Math.round(d)} m`]);
    };
    for (const h of this.holes.values()) row(h.q, h.y, h.r, h.cx, h.cy, h.cz, PHASE_NAMES[h.phase]);
    for (const a of this._arming.values()) row(a.q, a.y, a.r, a.cx, a.cy, a.cz, PHASE_NAMES[PHASE.ARM]);
    for (const [q, iy, r] of this._inert.values()) {
      const [cx, cz] = hexToWorld(q, r);
      row(q, iy, r, cx, iy + 0.5, cz, 'inert');
    }
    rows.sort((a, b) => a[0] - b[0]);
    return rows.slice(0, Math.max(0, Math.floor(n))).map((r) => r[1]);
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
