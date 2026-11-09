// Caelancraft — explosives: lighting blast barrels, lit barrel entities, fuse timers, merged chain blasts, debris,
// knockback, flash and shake. See src/CONTRACTS.md §37 and docs/DESIGN-physics.md §7 / §10. PURE: talks to the world
// only through its BlockPhysics (ctx.peek / ctx.write / ctx.writeQuiet / hooks); no DOM, no three, no Math.random.
//
// A barrel is LIT in one of two ways:
// - an ENTITY (R on it, a campfire next to it, `ignite q y r`): the block is replaced by a persistent tumbler
//   (physics.fallers.spawnTumbler, drawn and moved by fallingblocks) that pulses, hisses, sparks, can be pushed around
//   by the player and pigs (resolveBodies; never barrel against barrel), put out with a left-click or by water, and
//   goes off when its fuse (BARREL_FUSE_S) ends. At most MAX_LIT_BARRELS entities;
// - a FUSE TIMER in place (`timers`, keyed by packCell): the block stays in the world and burns for a short while —
//   every barrel caught in a blast (BARREL_TIMER_FUSE_MIN_S … MAX_S), and barrels lit beyond MAX_LIT_BARRELS.
//
// MERGED CHAINS. Each frame the earliest expired fuse goes off TOGETHER with every fuse that expires within
// BLAST_CHAIN_WINDOW_S of it and lies within BLAST_CHAIN_DISTANCE of it: ONE blast at their mean position, radius
// BLAST_RADIUS·∛n capped at BLAST_MAX_RADIUS, at most MAX_EXPLOSIONS_PER_FRAME per frame. A pile is one bigger boom.
//
// THE BLAST (centre c, radius R), inside ONE undoable physics event ('explosion'; a chain continues the event of the
// blast that lit it — or caught it already burning — while that is still the undoable one):
//   1. every cell whose centre is within R + jitter (seeded, ±BLAST_JITTER) is destroyed, nearest first, with
//      ctx.writeQuiet — except blast-proof cells (AIR, liquids, BEDROCK, OBSIDIAN, RUNE_BLOCK, BLACK_HOLE, unloaded);
//      barrels become fuse timers; the first 'capped' write stops the breaking;
//   2. up to MAX_DEBRIS destroyed cells fly as tumbling debris (vanishing in dust where they land), some more puff dust;
//   3. bodies within 2R are knocked away (BLAST_IMPULSE·(1 − d/2R), at least BLAST_MIN_UP of it upward): the player
//      and pigs through hooks.knock (pigs squeal and flee), tumblers (lit barrels, debris) directly;
//   4. ONE support seed: the load-bearing cells on the crater rim, with the removals, cause { kind: 'explosion' } —
//      the collapse solver judges what is left hanging and trees fall away from the blast;
//   5. effects: 'boom', smoke and sparks, the flash (flash()) and the camera shake (shakeOffset()).
import {
  WORLD_HEIGHT, MAX_TUMBLING, BARREL_FUSE_S, MAX_LIT_BARRELS, MAX_EXPLOSIONS_PER_FRAME, MAX_DEBRIS, BLAST_RADIUS,
  BLAST_MAX_RADIUS, BLAST_CHAIN_WINDOW_S, BLAST_CHAIN_DISTANCE, BLAST_IMPULSE, BLAST_MIN_UP, BLAST_SHAKE_RANGE,
  BLAST_FLASH_S, BARREL_TIMER_FUSE_MIN_S, BARREL_TIMER_FUSE_MAX_S, MAX_FUSE_TIMERS, BARREL_HISS_S, BARREL_PULSE_SCALE,
  BARREL_PULSE_HZ, BLAST_JITTER, DEBRIS_SPEED_MIN, DEBRIS_SPEED_MAX, DEBRIS_UP_MIN, DEBRIS_UP_MAX, DEBRIS_SPIN,
  BLAST_DUST_CELLS, BLAST_FLASH_INTENSITY, BLAST_SHAKE_S, BLAST_SHAKE_AMPLITUDE,
} from './config.js';
import { BLOCK, UNLOADED, isFallThrough, isLiquid, isSolid, isWater } from './blocks.js';
import { HEX_DIRS, HEX_ROW_SPACING, HEX_SIZE, hexToWorld, worldToHex } from './hex.js';
import { packCell } from './coords.js';
import { hash3 } from './noise.js';
import { bodyHeight, bodyRadius } from './physics.js';
import { isAnchorCell, isLoadBearing } from './support.js';

/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').RuleContext} RuleContext */
/** @typedef {import('./blockphysics.js').SaveOverlay} SaveOverlay */
/** @typedef {import('./blockphysics.js').Cause} Cause */
/** @typedef {import('./fallingblocks.js').Tumbler} Tumbler */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * What the crosshair hit among the lit barrels.
 * @typedef {{ target: LitBarrel, distance: number }} LitBarrelHit
 */

/** The explosion light for this frame (intensity 0 = off). */
/** @typedef {{ x: number, y: number, z: number, intensity: number }} Flash */

/**
 * A lit barrel: an entity (`tumbler` set; the block was replaced by it) or a fuse timer burning in place (`tumbler`
 * null; the BLAST_BARREL block at (q, y, r) stays in the world until it goes off).
 * @typedef {Object} LitBarrel
 * @property {Tumbler|null} tumbler
 * @property {number} q        timer cell (entities: the cell they were lit in)
 * @property {number} y
 * @property {number} r
 * @property {number} fuse     seconds left (≤ 0: due; it waits while its chunk is unloaded)
 * @property {number} event    physics event whose blast lit it — or caught it while it burned (§37.3.3) — (0 = lit by
 *                             the player, a campfire or a command)
 * @property {number} phase    pulse phase (entities), radians
 * @property {number} sparkIn  seconds to its next fuse sparks
 * @property {boolean} hung    timers: a collapse found it hanging and left it in place while it burns (hangBurning)
 * @property {number} [hungEvent]  timers: physics.lastEvent's id when a collapse hung it (0 = none)
 * @property {number} [cell]   entities: packCell of the cell it rests in (occupiesCell), updated every step
 */

/**
 * What undo did with the barrels of an event (cancelEvent).
 * @typedef {Object} BarrelUndo
 * @property {number} putOut  lit barrels of the event that stopped burning (still in flight: counted by undo's message)
 * @property {number} burnt   barrels not given back because a CAMPFIRE is next to their cell (it would light them again)
 * @property {number} lost    barrels not given back for want of a loaded cell with room in their column
 */

/**
 * What the last blast did (tests, diagnostics).
 * @typedef {Object} BlastInfo
 * @property {number} x          centre (world)
 * @property {number} y
 * @property {number} z
 * @property {number} radius
 * @property {number} barrels    barrels that went off together
 * @property {number} destroyed  cells broken
 * @property {number} debris     debris tumblers thrown
 * @property {number} lit        barrels it lit as fuse timers
 * @property {number} knocked    bodies (player, pigs, tumblers) it pushed
 * @property {number} rim        load-bearing rim cells seeded for the support search
 * @property {boolean} capped    a write was refused by the edit cap: breaking stopped there
 * @property {number} event      physics event id it recorded into
 */

/** Cause of the support check a hung barrel gets when it stops burning without going off. */
const CAUSE_HUNG = Object.freeze({ kind: 'physics' });

/** Cells a blast never breaks (besides UNLOADED): AIR, liquids, BEDROCK, OBSIDIAN, RUNE_BLOCK, BLACK_HOLE. */
export const BLAST_PROOF_IDS = Object.freeze([
  BLOCK.AIR, BLOCK.WATER, BLOCK.WATER_FLOW_1, BLOCK.WATER_FLOW_2, BLOCK.WATER_FLOW_3, BLOCK.WATER_FLOW_4,
  BLOCK.WATER_FLOW_5, BLOCK.WATER_FLOW_6, BLOCK.WATER_FALL, BLOCK.BEDROCK, BLOCK.OBSIDIAN, BLOCK.RUNE_BLOCK,
  BLOCK.BLACK_HOLE,
]);
const BLAST_PROOF = new Uint8Array(256);
for (const id of BLAST_PROOF_IDS) BLAST_PROOF[id] = 1;
BLAST_PROOF[UNLOADED] = 1;

/** @returns {boolean} a blast leaves this block alone */
export function isBlastProof(id) {
  return BLAST_PROOF[id & 255] === 1 || isLiquid(id);
}

/** @returns {number} blast radius of `n` barrels going off together: BLAST_RADIUS·∛n, at most BLAST_MAX_RADIUS */
export function blastRadius(n) {
  return Math.min(BLAST_MAX_RADIUS, BLAST_RADIUS * Math.cbrt(Math.max(1, n)));
}

/** Bodies lit barrels share: resolveBodies skips pairs with the same `group` (no barrel–barrel pairs, CONTRACTS §31). */
export const LIT_BARREL_GROUP = 'lit-barrel';

/** The 8 neighbours of a cell: six sides, then above and below, as [dq, dy, dr]. */
const NEIGHBOURS = Object.freeze([
  ...HEX_DIRS.map(([dq, dr]) => Object.freeze([dq, 0, dr])), Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
]);
/** A lit barrel entity sparks from its fuse this often (s); a fuse timer every TIMER_SPARK_S. */
const ENTITY_SPARK_S = 0.12;
const TIMER_SPARK_S = 0.2;
/** Fuse timers that spark in one frame (a field of hundreds burning stays cheap). */
const MAX_TIMER_SPARKS_PER_FRAME = 24;
/** Fizzling timers of one merged group that puff steam (they all fizzle; only one 'fizzle' sound plays). */
const MAX_FIZZLE_STEAM = 16;
/** Dust particles per destroyed cell that puffs (BLAST_DUST_CELLS of them). */
const DUST_PER_CELL = 3;
const TWO_PI = Math.PI * 2;

export class Explosions {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    this.maxLit = MAX_LIT_BARRELS;
    /** @type {LitBarrel[]} lit barrel entities (persistent tumblers) */
    this.lit = [];
    /** @type {Map<number, LitBarrel>} fuse timers burning in place, by packCell */
    this.timers = new Map();
    /** @type {Set<number>} packCell of the cell each lit barrel entity rests in (occupiesCell), rebuilt every step */
    this._litCells = new Set();
    /** @type {number[]} the same cells as flat q, y, r triples */
    this._litCellList = [];
    /** @type {number[]} scratch for the next list */
    this._litCellNext = [];
    /** blasts so far (merged chains count once) */
    this.blastCount = 0;
    /** @type {BlastInfo|null} */
    this.lastBlast = null;

    /** seconds of (unpaused) explosions.step time: drives the flash, the shake and the pulse */
    this._clock = 0;
    this._hissIn = 0;
    this._flashAt = -Infinity;
    this._flashX = 0;
    this._flashY = 0;
    this._flashZ = 0;
    this._flashPeak = 0;
    this._shakeAt = -Infinity;
    this._shakeX = 0;
    this._shakeY = 0;
    this._shakeZ = 0;
    this._shakeAmp = 0;
    /** @type {Map<number, number[][]>} event id → cells of the barrel ENTITIES its blasts used up (undo refunds them) */
    this._refunds = new Map();
    this._p = [0, 0, 0];
    this._p0 = [0, 0, 0];
    this._kick = [0, 0, 0];

    // (b) a campfire next to a barrel: the scheduler's 'ignite' trigger / reseeder queue the barrel in `misc`.
    physics.registerRule('ignite', {
      ring: 'misc',
      feature: 'explosions',
      ids: [BLOCK.BLAST_BARREL],
      update: (ctx, q, y, r) => this._igniteRule(ctx, q, y, r),
    });
    // A burning barrel that leaves its cell (broken, crumbled, swallowed) takes its fuse with it.
    physics.addTrigger('barrel-timers', 'explosions', (q, y, r, prev, next) => {
      if (prev === BLOCK.BLAST_BARREL && next !== BLOCK.BLAST_BARREL && this.timers.size > 0) this.timers.delete(packCell(q, y, r));
    });
  }

  /** @returns {number} lit barrels (entities + fuse timers) */
  get litCount() {
    return this.lit.length + this.timers.size;
  }

  /**
   * The BLAST_BARREL block at (q, y, r) is burning in place (a fuse timer) — main's crosshair hint.
   * @returns {boolean}
   */
  isBurning(q, y, r) {
    return this.timers.size > 0 && this.timers.has(packCell(q, y, r));
  }

  /**
   * A collapse is about to crumble the barrel at (q, y, r). When it burns in place, it stays where it is until it goes
   * off a moment later (crumbling it would take its fuse away) and is marked `hung`: should it stop burning without
   * going off (water, explosions off, undo) it gets a support check of its own, and a save drops it to where it would
   * land (CONTRACTS §38.2).
   * @returns {boolean} it burns in place (the collapse must leave it out)
   */
  hangBurning(q, y, r) {
    if (this.timers.size === 0) return false;
    const rec = this.timers.get(packCell(q, y, r));
    if (rec === undefined) return false;
    if (!rec.hung) rec.hungEvent = this.physics.lastEvent ? this.physics.lastEvent.id : 0;
    rec.hung = true;
    return true;
  }

  /**
   * A hung timer stopped burning without going off: let the collapse search judge its barrel now. Its fall belongs to
   * what left it hanging, so the seed joins the undoable event when that is the blast that lit (or caught) it, the
   * event that hung it, or an event that changed a cell next to it (a collapse begun just after hangBurning asked) —
   * else the crumble would begin a 'collapse' event of its own and take the only undo away from the blast (§38.2.2).
   */
  _unhang(rec) {
    if (!rec.hung) return;
    const physics = this.physics;
    const seed = () => physics.seedSupport([[rec.q, rec.y, rec.r]], { cause: CAUSE_HUNG });
    const ev = physics.canUndo ? physics.lastEvent : null;
    if (ev !== null && (ev.id === rec.event || ev.id === rec.hungEvent || touchedAround(ev, rec.q, rec.y, rec.r))) {
      physics.withEvent(ev.id, seed);
    } else {
      seed();
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // lighting

  /**
   * Light the BLAST_BARREL block at cell (q, y, r) (R key): it becomes a lit barrel entity (fuse BARREL_FUSE_S), or a
   * fuse timer in place when MAX_LIT_BARRELS entities (or MAX_TUMBLING tumblers) already exist.
   * @returns {boolean} lit (false: explosions off, no barrel there, or it is already burning)
   */
  lightAt(q, y, r) {
    if (!this.physics.isEnabled('explosions')) return false;
    return this._light(q, y, r);
  }

  /**
   * Console / rune `ignite q y r` (the command already checked the height range and that the chunk is loaded).
   * @returns {{ ok: boolean, message: string }}
   */
  ignite(q, y, r) {
    if (!this.physics.isEnabled('explosions')) return { ok: false, message: 'explosions are off — turn them on with `physics explosions on`' };
    const id = this.physics.ctx.peek(q, y, r);
    if (id === UNLOADED) return { ok: false, message: `cell (${q}, ${y}, ${r}) is not loaded` };
    if (id !== BLOCK.BLAST_BARREL) return { ok: false, message: `there is no blast barrel at (${q}, ${y}, ${r})` };
    if (this.timers.has(packCell(q, y, r))) return { ok: false, message: `the barrel at (${q}, ${y}, ${r}) is already burning` };
    if (!this._light(q, y, r)) return { ok: false, message: `the barrel at (${q}, ${y}, ${r}) could not be lit` };
    return { ok: true, message: `lit the blast barrel at (${q}, ${y}, ${r}) — ${BARREL_FUSE_S} s fuse` };
  }

  /**
   * `misc` rule: a barrel with a campfire among its 8 neighbours catches fire (waits for an unloaded neighbour).
   * @param {RuleContext} ctx
   */
  _igniteRule(ctx, q, y, r) {
    let unloaded = false;
    for (const [dq, dy, dr] of NEIGHBOURS) {
      const id = ctx.peek(q + dq, y + dy, r + dr);
      if (id === BLOCK.CAMPFIRE) {
        this._light(q, y, r);
        return;
      }
      if (id === UNLOADED) unloaded = true;
    }
    if (unloaded) ctx.park();
  }

  /** The barrel block at the cell becomes an entity while there is room, else a fuse timer. @returns {boolean} */
  _light(q, y, r) {
    const ctx = this.physics.ctx;
    if (ctx.peek(q, y, r) !== BLOCK.BLAST_BARREL || this.timers.has(packCell(q, y, r))) return false;
    const fallers = ctx.fallers;
    if (this.lit.length < MAX_LIT_BARRELS && fallers.tumblerCount < MAX_TUMBLING && ctx.writeQuiet(q, y, r, BLOCK.AIR) === 'ok') {
      const [x, z] = hexToWorld(q, r);
      /** @type {LitBarrel} */
      const rec = { tumbler: null, q, y, r, fuse: BARREL_FUSE_S, event: 0, phase: 0, sparkIn: 0, hung: false, hungEvent: 0 };
      const t = fallers.spawnTumbler(BLOCK.BLAST_BARREL, x, y, z, 0, 0, 0, { persistent: true, event: 0, data: rec });
      if (t !== null) {
        t.body.group = LIT_BARREL_GROUP;
        rec.tumbler = t;
        this.lit.push(rec);
        rec.cell = packCell(q, y, r);
        this._litCells.add(rec.cell); // sand above it, dropping now, must land on top of it
        this._litCellList.push(q, y, r);
        ctx.sound('hiss', x, y + 1, z, 0.8);
        ctx.particles('sparks', x, y + 1.05, z, 6, { spread: 0.1, speed: 0.35 });
        return true;
      }
      ctx.writeQuiet(q, y, r, BLOCK.BLAST_BARREL); // no tumbler after all: the block goes back
    }
    return this._addTimer(q, y, r, BARREL_FUSE_S, 0);
  }

  /**
   * Start (or shorten) a fuse timer on the barrel block at (q, y, r). A barrel already burning that a blast catches
   * (`event` > 0) joins that blast's event: its own blast continues the chain, and one undo restores both (§37.3.3).
   * @returns {boolean} a new timer started (false when it was already burning or MAX_FUSE_TIMERS are)
   */
  _addTimer(q, y, r, fuse, event) {
    const key = packCell(q, y, r);
    const old = this.timers.get(key);
    if (old !== undefined) {
      if (fuse < old.fuse) old.fuse = fuse;
      if (event > 0) old.event = event;
      return false;
    }
    if (this.timers.size >= MAX_FUSE_TIMERS) return false;
    this.timers.set(key, { tumbler: null, q, y, r, fuse, event, phase: 0, sparkIn: 0, hung: false, hungEvent: 0 });
    return true;
  }

  /** @returns {number} a seeded fuse for a barrel caught in a blast */
  _timerFuse() {
    return BARREL_TIMER_FUSE_MIN_S + this.physics.ctx.random() * (BARREL_TIMER_FUSE_MAX_S - BARREL_TIMER_FUSE_MIN_S);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the crosshair and putting barrels out

  /**
   * Nearest lit barrel entity whose body cylinder the ray (origin o, unit direction d) enters within maxDist.
   * @returns {LitBarrelHit|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const rec of this.lit) {
      const b = /** @type {Tumbler} */ (rec.tumbler).body;
      const t = rayCylinder(ox, oy, oz, dx, dy, dz, b.x, b.y, b.z, bodyRadius(b), bodyHeight(b));
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = rec;
      }
    }
    return best ? { target: best, distance: bestT } : null;
  }

  /**
   * Put out a lit barrel (left-click): back to a BLAST_BARREL block where it rests (dropping to the ground when it is
   * in the air), with a fizzle.
   * @param {*} target  LitBarrelHit.target
   * @returns {boolean}
   */
  snuff(target) {
    const i = this.lit.indexOf(target);
    if (i < 0) return false;
    this._putOut(i, false);
    return true;
  }

  /** Remove lit entity i and leave a barrel block where it rests; fizzle (and steam when water put it out). */
  _putOut(i, wet) {
    const rec = this.lit[i];
    this.lit.splice(i, 1);
    const t = /** @type {Tumbler} */ (rec.tumbler);
    const b = t.body;
    this.physics.fallers.removeTumbler(t);
    const ctx = this.physics.ctx;
    const top = b.y + bodyHeight(b);
    ctx.sound('fizzle', b.x, top, b.z, 1);
    ctx.particles(wet ? 'steam' : 'smoke', b.x, top, b.z, 8, { spread: 0.2 });
    // Not recorded into the blast that caught it (rec.event): that event's undo would take the barrel away again
    // without giving it back — it is no longer a lit barrel of the event. It stays where it was put out.
    this._placeBarrel(b, 0);
  }

  /**
   * A BLAST_BARREL block for a barrel body that stops burning: in the free cell it occupies (or up to 3 above), falling
   * as a column faller when there is nothing under it; landing never buries a body (fallingblocks' landing rules). Water
   * is fall-through (CONTRACTS §35.6), so a barrel put out in a lake sinks to the bottom; the direct write is the fallback
   * for any other liquid.
   * @param {PlayerState} b
   * @returns {boolean} placed (or dropping)
   */
  _placeBarrel(b, event) {
    const ctx = this.physics.ctx;
    const [q, r] = worldToHex(b.x, b.z);
    let cy = clampY(Math.floor(b.y + 0.05));
    for (let k = 0; ; k++) {
      const id = ctx.peek(q, cy, r);
      if (id === UNLOADED) return false;
      if (isFallThrough(id) || isLiquid(id)) break;
      if (k >= 3 || cy >= WORLD_HEIGHT - 1) return false;
      cy++;
    }
    if (isFallThrough(ctx.peek(q, cy - 1, r))) {
      ctx.fallers.spawn(BLOCK.BLAST_BARREL, q, cy, r, { event });
      return true;
    }
    if (isFallThrough(ctx.peek(q, cy, r))) return ctx.fallers.settleNow(BLOCK.BLAST_BARREL, q, cy, r, { event });
    return ctx.write(q, cy, r, BLOCK.BLAST_BARREL) === 'ok';
  }

  // -------------------------------------------------------------------------------------------------------------------
  // per frame

  /** Fuses (entities: pulse, sparks, water; timers: sparks), the hiss, merged chain blasts (≤ MAX_EXPLOSIONS_PER_FRAME). */
  step(dt) {
    if (dt > 0) {
      this._clock += dt;
      this._stepEntities(dt);
      this._stepTimers(dt);
      this._stepHiss(dt);
      for (let k = 0; k < MAX_EXPLOSIONS_PER_FRAME; k++) if (!this._detonateNext()) break;
    }
    this._updateLitCells();
  }

  /**
   * A lit barrel entity rests in cell (q, y, r) (as of the end of the last step, or since it was lit): falling blocks
   * treat the cell as occupied, so sand dropped on a burning barrel piles on top of it instead of landing in its cell
   * and popping it up through the pile (play-test B3).
   * @returns {boolean}
   */
  occupiesCell(q, y, r) {
    if (this._litCells.size === 0) return false;
    const key = packCell(q, y, r);
    if (!this._litCells.has(key)) return false;
    for (const rec of this.lit) if (rec.cell === key) return true; // not a barrel put out (or gone off) this frame
    return false;
  }

  /**
   * Rebuild the cells lit barrels rest in (the cell of the body's feet, as settleInto saves it). A cell a barrel left
   * (rolled, thrown, went off, put out as a falling block) queues the cell above it on the fall ring: a pile that rested
   * on the barrel falls.
   */
  _updateLitCells() {
    const old = this._litCellList;
    if (old.length === 0 && this.lit.length === 0) return;
    const cells = this._litCells;
    const next = this._litCellNext;
    cells.clear();
    next.length = 0;
    for (const rec of this.lit) {
      const b = /** @type {Tumbler} */ (rec.tumbler).body;
      const y = Math.floor(b.y + 0.05);
      if (!(y >= 0 && y < WORLD_HEIGHT)) {
        rec.cell = -1;
        continue;
      }
      const [q, r] = worldToHex(b.x, b.z);
      rec.cell = packCell(q, y, r);
      cells.add(rec.cell);
      next.push(q, y, r);
    }
    for (let i = 0; i < old.length; i += 3) {
      if (!cells.has(packCell(old[i], old[i + 1], old[i + 2]))) this.physics.schedule('fall', old[i], old[i + 1] + 1, old[i + 2]);
    }
    this._litCellList = next;
    this._litCellNext = old;
  }

  _stepEntities(dt) {
    const physics = this.physics;
    const world = physics.world;
    const tumblers = physics.fallers.tumblers;
    const ctx = physics.ctx;
    for (let i = this.lit.length - 1; i >= 0; i--) {
      const rec = this.lit[i];
      const t = /** @type {Tumbler} */ (rec.tumbler);
      if (tumblers.indexOf(t) < 0) {
        this.lit.splice(i, 1); // fell out of the world (or the fallers were reset)
        continue;
      }
      const b = t.body;
      const [q, r] = worldToHex(b.x, b.z);
      if (!world.hasChunkAtCell(q, r)) continue; // frozen with its chunk, like the tumbler itself
      if (isWater(world.peekBlock(q, Math.floor(b.y + 0.1), r)) || isWater(world.peekBlock(q, Math.floor(b.y + 0.6), r))) {
        this._putOut(i, true);
        continue;
      }
      rec.fuse -= dt;
      const hurry = rec.fuse < 1 ? 1 + 2 * Math.min(1, 1 - rec.fuse) : 1; // 4 Hz, rising to 12 Hz over the last second
      rec.phase = (rec.phase + TWO_PI * BARREL_PULSE_HZ * hurry * dt) % TWO_PI;
      t.scale = 1 + BARREL_PULSE_SCALE * Math.sin(rec.phase);
      rec.sparkIn -= dt;
      if (rec.sparkIn <= 0) {
        rec.sparkIn += ENTITY_SPARK_S;
        if (rec.sparkIn <= 0) rec.sparkIn = ENTITY_SPARK_S;
        ctx.particles('sparks', b.x, b.y + bodyHeight(b) + 0.05, b.z, 2, { spread: 0.08, speed: 0.25 });
      }
    }
  }

  _stepTimers(dt) {
    if (this.timers.size === 0) return;
    const world = this.physics.world;
    const ctx = this.physics.ctx;
    let sparks = 0;
    for (const rec of this.timers.values()) {
      if (!world.hasChunkAtCell(rec.q, rec.r)) continue; // waits for its chunk
      rec.fuse -= dt;
      rec.sparkIn -= dt;
      if (rec.sparkIn <= 0) {
        rec.sparkIn += TIMER_SPARK_S;
        if (rec.sparkIn <= 0) rec.sparkIn = TIMER_SPARK_S;
        if (sparks++ < MAX_TIMER_SPARKS_PER_FRAME) ctx.particles('sparks', rec.q + rec.r / 2, rec.y + 1.05, rec.r * HEX_ROW_SPACING, 1, { spread: 0.2, speed: 0.25 });
      }
    }
  }

  /** One hiss every BARREL_HISS_S, at the burning barrel nearest the player. */
  _stepHiss(dt) {
    this._hissIn -= dt;
    if (this._hissIn > 0) return;
    if (this.litCount === 0) {
      this._hissIn = 0;
      return;
    }
    this._hissIn = BARREL_HISS_S;
    const player = this.physics.hooks.player();
    const p = this._p;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    let bz = 0;
    const consider = (rec) => {
      this._position(rec, p);
      const d = player ? Math.hypot(p[0] - player.x, p[1] - player.y, p[2] - player.z) : 0;
      if (d < best) {
        best = d;
        bx = p[0];
        by = p[1];
        bz = p[2];
      }
    };
    for (const rec of this.lit) consider(rec);
    for (const rec of this.timers.values()) consider(rec);
    if (best < Infinity) this.physics.ctx.sound('hiss', bx, by, bz, 0.7);
  }

  /**
   * Set off the earliest expired fuse merged with every fuse due within BLAST_CHAIN_WINDOW_S of it and within
   * BLAST_CHAIN_DISTANCE of it (loaded ones only). Timers whose barrel is gone are dropped; timers touching water
   * fizzle out instead.
   * @returns {boolean} something went off (or fizzled)
   */
  _detonateNext() {
    let best = null;
    let bestFuse = Infinity;
    for (const rec of this.lit) {
      if (rec.fuse < bestFuse && this._loaded(rec)) {
        best = rec;
        bestFuse = rec.fuse;
      }
    }
    for (const rec of this.timers.values()) {
      if (rec.fuse < bestFuse && this._loaded(rec)) {
        best = rec;
        bestFuse = rec.fuse;
      }
    }
    if (best === null || bestFuse > 0) return false;
    const p0 = this._position(best, this._p0);
    const p = this._p;
    const limit = bestFuse + BLAST_CHAIN_WINDOW_S;
    const reach2 = BLAST_CHAIN_DISTANCE * BLAST_CHAIN_DISTANCE;
    /** @type {LitBarrel[]} */
    const group = [];
    const consider = (rec) => {
      if (rec.fuse > limit || !this._loaded(rec)) return;
      this._position(rec, p);
      const dx = p[0] - p0[0];
      const dy = p[1] - p0[1];
      const dz = p[2] - p0[2];
      if (dx * dx + dy * dy + dz * dz <= reach2) group.push(rec);
    };
    for (const rec of this.lit) consider(rec);
    for (const rec of this.timers.values()) consider(rec);
    const ctx = this.physics.ctx;
    const player = this.physics.hooks.player();
    // The timers in water fizzle: steam from each (the first MAX_FIZZLE_STEAM), ONE 'fizzle' at the one nearest the
    // player (a wet pile sent ~100 at once, and they took every audio voice from the boom, §37.2.3).
    let fizzled = 0;
    let near = Infinity;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let i = group.length - 1; i >= 0; i--) {
      const rec = group[i];
      if (rec.tumbler !== null) continue;
      const id = ctx.peek(rec.q, rec.y, rec.r);
      if (id !== BLOCK.BLAST_BARREL) {
        this.timers.delete(packCell(rec.q, rec.y, rec.r));
        group.splice(i, 1);
      } else if (this._touchesWater(rec.q, rec.y, rec.r)) {
        this.timers.delete(packCell(rec.q, rec.y, rec.r));
        group.splice(i, 1);
        this._unhang(rec);
        const x = rec.q + rec.r / 2;
        const z = rec.r * HEX_ROW_SPACING;
        if (fizzled++ < MAX_FIZZLE_STEAM) ctx.particles('steam', x, rec.y + 1, z, 8, { spread: 0.3 });
        const d = player ? Math.hypot(x - player.x, rec.y + 1 - player.y, z - player.z) : 0;
        if (d < near) {
          near = d;
          fx = x;
          fy = rec.y + 1;
          fz = z;
        }
      }
    }
    if (group.length > 0) this._explode(group); // the boom first, so the fizzle never takes its voice
    if (fizzled > 0) ctx.sound('fizzle', fx, fy, fz, 1);
    return true;
  }

  /** @returns {boolean} the barrel's column is loaded */
  _loaded(rec) {
    if (rec.tumbler === null) return this.physics.world.hasChunkAtCell(rec.q, rec.r);
    const b = rec.tumbler.body;
    const [q, r] = worldToHex(b.x, b.z);
    return this.physics.world.hasChunkAtCell(q, r);
  }

  /** @returns {number[]} out = the barrel's centre (entities: body centre; timers: cell centre) */
  _position(rec, out) {
    if (rec.tumbler === null) {
      out[0] = rec.q + rec.r / 2;
      out[1] = rec.y + 0.5;
      out[2] = rec.r * HEX_ROW_SPACING;
    } else {
      const b = rec.tumbler.body;
      out[0] = b.x;
      out[1] = b.y + bodyHeight(b) / 2;
      out[2] = b.z;
    }
    return out;
  }

  /** @returns {boolean} water above or beside the cell */
  _touchesWater(q, y, r) {
    const world = this.physics.world;
    for (let i = 0; i < 7; i++) {
      const [dq, dy, dr] = NEIGHBOURS[i];
      if (isWater(world.peekBlock(q + dq, y + dy, r + dr))) return true;
    }
    return false;
  }

  /** The merged group goes off as ONE blast inside one undoable event (a chain continues its lighter's event). */
  _explode(group) {
    const physics = this.physics;
    const ctx = physics.ctx;
    const n = group.length;
    const lastId = physics.lastEvent ? physics.lastEvent.id : 0;
    const p = this._p;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let chain = 0;
    /** @type {number[][]} the cells the barrel entities used up were lit in (undo gives them back there, §37.4.3) */
    const refund = [];
    for (const rec of group) {
      this._position(rec, p);
      sx += p[0];
      sy += p[1];
      sz += p[2];
      if (rec.event > 0 && rec.event === lastId) chain = lastId;
      if (rec.tumbler !== null) {
        refund.push([rec.q, rec.y, rec.r]);
        physics.fallers.removeTumbler(rec.tumbler);
        this.lit.splice(this.lit.indexOf(rec), 1);
      } else {
        this.timers.delete(packCell(rec.q, rec.y, rec.r));
      }
    }
    const cx = sx / n;
    const cy = sy / n;
    const cz = sz / n;
    const radius = blastRadius(n);
    /** @type {Cause} */
    const cause = { kind: 'explosion', x: cx, y: cy, z: cz };
    let token = null;
    let event;
    if (chain > 0) {
      token = physics.enterEvent(chain);
      event = chain;
    } else {
      event = physics.beginEvent('explosion', cause).id;
    }
    /** @type {number[][]} [q, y, r, prevId, wasAnchor] of every load-bearing cell removed (the support seed) */
    const removed = [];
    let info;
    try {
      // The burning barrel blocks themselves (edits, so never capped).
      for (const rec of group) {
        if (rec.tumbler === null && ctx.writeQuiet(rec.q, rec.y, rec.r, BLOCK.AIR) === 'ok') removed.push([rec.q, rec.y, rec.r, BLOCK.BLAST_BARREL, 0]);
      }
      info = this._blast(cx, cy, cz, radius, event, cause, removed);
    } finally {
      if (chain > 0) physics.exitEvent(token);
      else physics.endEvent();
    }
    info.barrels = n;
    for (const id of [...this._refunds.keys()]) if (id !== event) this._refunds.delete(id);
    if (refund.length > 0) {
      const list = this._refunds.get(event);
      if (list) list.push(...refund);
      else this._refunds.set(event, refund);
    }
    this.blastCount++;
    this.lastBlast = info;
  }

  /**
   * Break the crater, light the barrels in it, throw debris, knock bodies, seed ONE rim support search, effects.
   * Runs inside the explosion event.
   * @param {number[][]} removed  load-bearing removals so far (the barrels); the crater's are appended
   * @returns {BlastInfo}
   */
  _blast(cx, cy, cz, radius, event, cause, removed) {
    const physics = this.physics;
    const ctx = physics.ctx;
    const world = physics.world;

    // 1. Breakable cells within R + jitter, nearest first (so a capped blast still leaves a round hole). Nothing writes
    //    to the world between this scan and the loop below except the loop itself, so each cell is read once here.
    const salt = Math.floor(ctx.random() * 4294967296) | 0;
    const reach = radius + BLAST_JITTER;
    const reach2 = reach * reach;
    const [q0, r0] = worldToHex(cx, cz);
    const hr = Math.ceil((reach + HEX_SIZE) / HEX_ROW_SPACING);
    const ylo = Math.max(0, Math.floor(cy - reach - 0.5));
    const yhi = Math.min(WORLD_HEIGHT - 1, Math.ceil(cy + reach - 0.5));
    /** @type {number[]} flat [distance, q, y, r, id] per cell */
    const cand = [];
    for (let dq = -hr; dq <= hr; dq++) {
      const drLo = Math.max(-hr, -dq - hr);
      const drHi = Math.min(hr, -dq + hr);
      for (let dr = drLo; dr <= drHi; dr++) {
        const q = q0 + dq;
        const r = r0 + dr;
        const hx = q + r / 2 - cx;
        const hz = r * HEX_ROW_SPACING - cz;
        const h2 = hx * hx + hz * hz;
        if (h2 > reach2 || !world.hasChunkAtCell(q, r)) continue; // unloaded columns are blast-proof
        for (let y = ylo; y <= yhi; y++) {
          const vy = y + 0.5 - cy;
          const d2 = h2 + vy * vy;
          if (d2 > reach2) continue;
          const id = world.peekBlock(q, y, r);
          if (isBlastProof(id)) continue;
          const d = Math.sqrt(d2);
          const jitter = (hash3(q, y, r, salt) / 4294967296 * 2 - 1) * BLAST_JITTER;
          if (d <= radius + jitter) cand.push(d, q, y, r, id);
        }
      }
    }
    const order = [];
    for (let i = 0; i < cand.length; i += 5) order.push(i);
    order.sort((a, b) => cand[a] - cand[b]);

    /** @type {number[][]} [q, y, r, id] */
    const destroyed = [];
    /** @type {Set<number>} */
    const gone = new Set();
    let capped = false;
    let lit = 0;
    for (const i of order) {
      const q = cand[i + 1];
      const y = cand[i + 2];
      const r = cand[i + 3];
      const id = cand[i + 4];
      if (id === BLOCK.BLAST_BARREL) {
        if (this._addTimer(q, y, r, this._timerFuse(), event)) lit++;
        continue;
      }
      if (capped) continue;
      const bearing = isLoadBearing(id);
      const anchor = bearing && isAnchorCell(world, q, y, r);
      const res = ctx.writeQuiet(q, y, r, BLOCK.AIR);
      if (res === 'capped') {
        capped = true; // the edit cap: stop breaking (barrels in range still catch fire)
        continue;
      }
      if (res !== 'ok') continue;
      destroyed.push([q, y, r, id]);
      gone.add(packCell(q, y, r));
      if (bearing) removed.push([q, y, r, id, anchor ? 1 : 0]);
    }

    // 3. Knock bodies within 2R away (before the debris, so it is not pushed by its own blast).
    const knocked = this._knockAll(cx, cy, cz, radius, event);

    // 2. Debris and dust.
    const debris = this._throwDebris(destroyed, cx, cy, cz, event);

    // 4. ONE support search from the rim (shared memo), cause = the blast: trees fall away from it.
    /** @type {number[][]} */
    const rim = [];
    const seen = new Set();
    for (const [q, y, r] of destroyed) {
      for (const [dq, dy, dr] of NEIGHBOURS) {
        const ny = y + dy;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const k = packCell(q + dq, ny, r + dr);
        if (gone.has(k) || seen.has(k)) continue;
        seen.add(k);
        if (isLoadBearing(ctx.peek(q + dq, ny, r + dr))) rim.push([q + dq, ny, r + dr]);
      }
    }
    if (rim.length > 0 || removed.length > 0) physics.seedSupport(rim, { cause, removed });

    // 5. Effects.
    const big = (radius - BLAST_RADIUS) / (BLAST_MAX_RADIUS - BLAST_RADIUS);
    ctx.sound('boom', cx, cy, cz, Math.min(1, 0.6 + 0.4 * Math.max(0, big)));
    ctx.particles('smoke', cx, cy, cz, Math.round(16 + 8 * radius), { spread: radius * 0.5, speed: 2.2 });
    ctx.particles('sparks', cx, cy, cz, Math.round(24 + 6 * radius), { spread: 0.6, speed: 1.6 });
    this._flashAt = this._clock;
    this._flashX = cx;
    this._flashY = cy + 1;
    this._flashZ = cz;
    this._flashPeak = BLAST_FLASH_INTENSITY * radius / BLAST_RADIUS;
    this._shakeAt = this._clock;
    this._shakeX = cx;
    this._shakeY = cy;
    this._shakeZ = cz;
    this._shakeAmp = BLAST_SHAKE_AMPLITUDE * Math.sqrt(radius / BLAST_RADIUS);

    return { x: cx, y: cy, z: cz, radius, barrels: 0, destroyed: destroyed.length, debris, lit, knocked, rim: rim.length, capped, event };
  }

  /**
   * The impulse a body at distance d from the blast gets: BLAST_IMPULSE·(1 − d/2R) away from the centre (from its
   * body centre), with the upward part at least BLAST_MIN_UP.
   * @param {PlayerState} b
   * @returns {number[]|null} [vx, vy, vz] (scratch) or null beyond 2R
   */
  _impulse(b, cx, cy, cz, radius) {
    const range = 2 * radius;
    const dx = b.x - cx;
    const dy = b.y + bodyHeight(b) / 2 - cy;
    const dz = b.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (!(d < range)) return null;
    const j = BLAST_IMPULSE * (1 - d / range);
    const k = this._kick;
    if (d > 1e-6) {
      k[0] = (j * dx) / d;
      k[1] = Math.max((j * dy) / d, BLAST_MIN_UP);
      k[2] = (j * dz) / d;
    } else {
      k[0] = 0;
      k[1] = Math.max(j, BLAST_MIN_UP);
      k[2] = 0;
    }
    return k;
  }

  /**
   * Knock every body within 2R. A rider's horizontal velocity is relative to its carrier while it rides (bodies.js
   * carries it, and hands it the carrier's velocity when it leaves), so a rider whose carrier is knocked too has the
   * carrier's change taken off again: it ends up with exactly its own impulse over the ground, not its own plus the
   * carrier's (a player standing on a pig was thrown ~2.5× as far, §37.3.3).
   * @returns {number} bodies pushed: the player and pigs (hooks.knock), every tumbler (lit barrels, debris)
   */
  _knockAll(cx, cy, cz, radius, event) {
    const physics = this.physics;
    const ctx = physics.ctx;
    /** @type {Map<PlayerState, number[]>} knocked body → its [vx, vz] before the knock */
    const before = new Map();
    const bodies = physics.hooks.bodies();
    if (bodies) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const k = b && !before.has(b) ? this._impulse(b, cx, cy, cz, radius) : null;
        if (k === null) continue;
        before.set(b, [b.vx, b.vz]);
        physics.hooks.knock(b, k[0], k[1], k[2], cx, cz);
      }
    }
    for (const t of physics.fallers.tumblers) {
      const b = t.body;
      const k = before.has(b) ? null : this._impulse(b, cx, cy, cz, radius);
      if (k === null) continue;
      before.set(b, [b.vx, b.vz]);
      b.vx += k[0];
      b.vy += k[1];
      b.vz += k[2];
      b.onGround = false;
      t.wx += (ctx.random() * 2 - 1) * DEBRIS_SPIN * 0.5;
      t.wz += (ctx.random() * 2 - 1) * DEBRIS_SPIN * 0.5;
    }
    if (before.size > 1) {
      // Each carrier's change, all taken before any rider is corrected (a stack of three comes out right too).
      /** @type {[PlayerState, number, number][]} */
      const fix = [];
      for (const b of before.keys()) {
        const c = b.carrier;
        const v0 = c ? before.get(c) : undefined;
        if (v0 !== undefined) fix.push([b, /** @type {PlayerState} */ (c).vx - v0[0], /** @type {PlayerState} */ (c).vz - v0[1]]);
      }
      for (const [b, dvx, dvz] of fix) {
        b.vx -= dvx;
        b.vz -= dvz;
      }
    }
    // A lit barrel inside the crater catches the blast: its fuse shortens like a barrel block's, and it joins the
    // blast's event (its own blast continues the chain; undo puts it out, §37.3.3).
    for (const rec of this.lit) {
      this._position(rec, this._p);
      const p = this._p;
      if (Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) <= radius) {
        rec.fuse = Math.min(rec.fuse, this._timerFuse());
        if (event > 0) rec.event = event;
      }
    }
    return before.size;
  }

  /**
   * Up to MAX_DEBRIS of the destroyed solid cells (picked at random) fly as tumbling debris; BLAST_DUST_CELLS of the
   * rest puff dust. A full tumbler list turns debris into dust too.
   * @returns {number} debris thrown
   */
  _throwDebris(destroyed, cx, cy, cz, event) {
    const ctx = this.physics.ctx;
    const fallers = this.physics.fallers;
    /** @type {number[]} indices of destroyed solid cells */
    const solids = [];
    for (let i = 0; i < destroyed.length; i++) if (isSolid(destroyed[i][3])) solids.push(i);
    const picks = Math.min(MAX_DEBRIS, solids.length);
    let thrown = 0;
    /** @type {Set<number>} */
    const flew = new Set();
    for (let k = 0; k < picks; k++) {
      // Partial Fisher–Yates: solids[k] becomes a random one of the not-yet-picked.
      const j = k + Math.floor(ctx.random() * (solids.length - k));
      const tmp = solids[k];
      solids[k] = solids[j];
      solids[j] = tmp;
      const [q, y, r, id] = destroyed[solids[k]];
      flew.add(solids[k]);
      const x = q + r / 2;
      const z = r * HEX_ROW_SPACING;
      let hx = x - cx;
      let hz = z - cz;
      const hd = Math.hypot(hx, hz);
      if (hd < 0.2) {
        const a = ctx.random() * TWO_PI;
        hx = Math.cos(a);
        hz = Math.sin(a);
      } else {
        hx /= hd;
        hz /= hd;
      }
      const speed = DEBRIS_SPEED_MIN + ctx.random() * (DEBRIS_SPEED_MAX - DEBRIS_SPEED_MIN);
      const up = DEBRIS_UP_MIN + ctx.random() * (DEBRIS_UP_MAX - DEBRIS_UP_MIN);
      const spin = [(ctx.random() * 2 - 1) * DEBRIS_SPIN, (ctx.random() * 2 - 1) * DEBRIS_SPIN, (ctx.random() * 2 - 1) * DEBRIS_SPIN];
      const t = fallers.spawnTumbler(id, x, y + 0.01, z, hx * speed, up, hz * speed, { spin, event });
      if (t === null) ctx.particles('dust', x, y + 0.5, z, 6, { id, spread: 0.6 });
      else thrown++;
    }
    // Dust from an even spread of the rest (campfires: a puff of smoke).
    const rest = destroyed.length - flew.size;
    const stride = Math.max(1, Math.floor(rest / BLAST_DUST_CELLS));
    let seen = 0;
    let puffs = 0;
    for (let i = 0; i < destroyed.length && puffs < BLAST_DUST_CELLS; i++) {
      if (flew.has(i)) continue;
      if (seen++ % stride !== 0) continue;
      const [q, y, r, id] = destroyed[i];
      const kind = id === BLOCK.CAMPFIRE ? 'smoke' : 'dust';
      ctx.particles(kind, q + r / 2, y + 0.5, r * HEX_ROW_SPACING, DUST_PER_CELL, { id, spread: 0.6, speed: 1.5 });
      puffs++;
    }
    return thrown;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // rendering, bodies, saving, undo

  /**
   * Extra render items: none — lit barrels are tumblers (drawn by fallingblocks with their pulse scale) and fuse timers
   * are blocks in the world.
   * @param {(id: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number, scale?: number) => void} _push
   */
  renderItems(_push) {}

  /**
   * Append the lit barrel bodies for resolveBodies (they share LIT_BARREL_GROUP, so they push the player and pigs but
   * never each other).
   * @param {PlayerState[]} out
   */
  bodies(out) {
    for (const rec of this.lit) out.push(/** @type {Tumbler} */ (rec.tumbler).body);
  }

  /**
   * Saving: lit barrels are saved as BLAST_BARREL blocks at the cell they rest in (dropped to the ground like a
   * faller; a barrel in water keeps its cell); fuse timers are dropped (they are barrels in the world already), and a
   * HUNG one (left hanging by a collapse while it burns, §38.2) is saved dropped down its column, lowest first —
   * reloaded without its fuse it would otherwise float.
   * @param {SaveOverlay} overlay
   */
  settleInto(overlay) {
    /** @type {LitBarrel[]} */
    const hung = [];
    for (const rec of this.timers.values()) if (rec.hung) hung.push(rec);
    hung.sort((a, b) => a.y - b.y);
    for (const rec of hung) {
      const { q, y, r } = rec;
      if (overlay.peek(q, y, r) !== BLOCK.BLAST_BARREL) continue;
      let cy = y;
      while (cy > 0 && isFallThrough(overlay.peek(q, cy - 1, r))) cy--;
      if (cy === y) continue;
      overlay.set(q, y, r, BLOCK.AIR);
      overlay.set(q, cy, r, BLOCK.BLAST_BARREL);
    }
    for (const rec of this.lit) {
      const b = /** @type {Tumbler} */ (rec.tumbler).body;
      const [q, r] = worldToHex(b.x, b.z);
      let cy = clampY(Math.floor(b.y + 0.05));
      if (overlay.peek(q, cy, r) === UNLOADED) continue;
      while (cy < WORLD_HEIGHT && !isFree(overlay.peek(q, cy, r))) cy++;
      while (cy > 0 && isFallThrough(overlay.peek(q, cy - 1, r))) cy--;
      if (cy < WORLD_HEIGHT) overlay.set(q, cy, r, BLOCK.BLAST_BARREL);
    }
  }

  /**
   * Undo of event `id`, run by BlockPhysics.undo AFTER it restored the event's cells (§33.8.4), so a barrel never takes
   * a cell the restore needs (a campfire it fell into, sand that dropped into its lit cell). The barrels of the event
   * still burning stop: fuse timers are dropped (they are still barrel blocks), lit entities are removed. The lit
   * entities of the event — those its blasts used up and those still burning — are given back as BLAST_BARREL blocks
   * in the cell they were LIT in, lowest first, each moved up past cells that are neither AIR nor water (two barrels
   * of one cell stack) and down while the cell below is AIR or water. Undo never leaves an unlit barrel next to a
   * CAMPFIRE, which would only light it again (at once through the 'ignite' trigger, or on the next load through the
   * reseeder): a burning one there keeps burning (as the campfire's, event 0), a used-up one is not given back.
   * Debris is the fallers' (fallers.cancelEvent).
   * @param {number} id
   * @param {((q: number, y: number, r: number) => boolean)|null} [write]  writes a BLAST_BARREL block (undo passes its
   *   quiet, uncapped write; default ctx.writeQuiet)
   * @returns {BarrelUndo}
   */
  cancelEvent(id, write = null) {
    /** @type {BarrelUndo} */
    const res = { putOut: 0, burnt: 0, lost: 0 };
    if (!(id > 0)) return res;
    const ctx = this.physics.ctx;
    const put = write ?? ((q, y, r) => ctx.writeQuiet(q, y, r, BLOCK.BLAST_BARREL) === 'ok');
    for (const [key, rec] of this.timers) {
      if (rec.event !== id) continue;
      if (nextToCampfire(ctx, rec.q, rec.y, rec.r)) {
        rec.event = 0;
        continue;
      }
      this.timers.delete(key);
      this._unhang(rec);
      res.putOut++;
    }
    /** @type {number[][]} lit cells of the barrels to give back */
    const back = this._refunds.get(id) ?? [];
    this._refunds.delete(id);
    for (let i = this.lit.length - 1; i >= 0; i--) {
      const rec = this.lit[i];
      if (rec.event !== id) continue;
      if (nextToCampfire(ctx, rec.q, rec.y, rec.r)) {
        rec.event = 0;
        continue;
      }
      this.lit.splice(i, 1);
      this.physics.fallers.removeTumbler(/** @type {Tumbler} */ (rec.tumbler));
      back.push([rec.q, rec.y, rec.r]);
      res.putOut++;
    }
    back.sort((a, b) => a[1] - b[1]);
    for (const [q, y0, r] of back) {
      let cy = y0;
      let id2 = ctx.peek(q, cy, r);
      while (id2 !== UNLOADED && !isOpen(id2) && cy < WORLD_HEIGHT - 1) id2 = ctx.peek(q, ++cy, r);
      if (!isOpen(id2)) {
        res.lost++; // unloaded, or the column is full to the top
        continue;
      }
      while (cy > 0 && isOpen(ctx.peek(q, cy - 1, r))) cy--;
      if (nextToCampfire(ctx, q, cy, r)) res.burnt++;
      else if (!put(q, cy, r)) res.lost++;
    }
    return res;
  }

  /**
   * The explosion light for this frame: the last blast's centre, intensity BLAST_FLASH_INTENSITY·R/BLAST_RADIUS
   * fading quadratically to 0 over BLAST_FLASH_S.
   * @param {Flash} out
   * @returns {Flash} out
   */
  flash(out) {
    const age = this._clock - this._flashAt;
    if (!(age >= 0 && age < BLAST_FLASH_S)) {
      out.intensity = 0;
      return out;
    }
    const k = 1 - age / BLAST_FLASH_S;
    out.x = this._flashX;
    out.y = this._flashY;
    out.z = this._flashZ;
    out.intensity = this._flashPeak * k * k;
    return out;
  }

  /**
   * Camera shake offset for a camera at (x, y, z): the last blast's amplitude × (1 − d/BLAST_SHAKE_RANGE), fading
   * quadratically over BLAST_SHAKE_S; a deterministic mix of sines (no randomness in the render path).
   * @param {number[]} out  [dx, dy, dz]
   * @returns {number[]} out
   */
  shakeOffset(x, y, z, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const age = this._clock - this._shakeAt;
    if (!(age >= 0 && age < BLAST_SHAKE_S)) return out;
    const d = Math.hypot(x - this._shakeX, y - this._shakeY, z - this._shakeZ);
    if (!(d < BLAST_SHAKE_RANGE)) return out;
    const fade = 1 - age / BLAST_SHAKE_S;
    const a = this._shakeAmp * (1 - d / BLAST_SHAKE_RANGE) * fade * fade;
    out[0] = a * Math.sin(age * 53 + 0.7);
    out[1] = a * 0.6 * Math.sin(age * 61 + 2.1);
    out[2] = a * Math.sin(age * 47 + 4.2);
    return out;
  }

  /** Drop everything burning (the world is unchanged: lit entities simply vanish, timers stay barrels). */
  reset() {
    for (const rec of this.lit) if (rec.tumbler) this.physics.fallers.removeTumbler(rec.tumbler);
    this.lit.length = 0;
    this.timers.clear();
    this._litCells.clear();
    this._litCellList.length = 0;
    this._refunds.clear();
    this._flashAt = -Infinity;
    this._shakeAt = -Infinity;
    this._hissIn = 0;
  }

  /** The 'explosions' switch changed (off: lit barrels go out — back to blocks — and fuse timers are dropped). */
  onSwitch(on) {
    if (on) return;
    for (let i = this.lit.length - 1; i >= 0; i--) this._putOut(i, false);
    for (const rec of this.timers.values()) this._unhang(rec);
    this.timers.clear();
  }
}

/** @returns {number} y clamped to 0..WORLD_HEIGHT−1 */
function clampY(y) {
  return y < 0 ? 0 : y >= WORLD_HEIGHT ? WORLD_HEIGHT - 1 : y;
}

/** A lit barrel saved into the overlay may rest in AIR, a campfire, flowing / falling water or a water source. */
function isFree(id) {
  return isFallThrough(id) || isLiquid(id);
}

/** A barrel undo gives back may go into AIR or water (not a campfire's cell: it would take the campfire's place). */
function isOpen(id) {
  return isFallThrough(id) && id !== BLOCK.CAMPFIRE;
}

/** @returns {boolean} a CAMPFIRE is among the cell's 8 neighbours (an unlit barrel there catches fire) */
function nextToCampfire(ctx, q, y, r) {
  for (const [dq, dy, dr] of NEIGHBOURS) if (ctx.peek(q + dq, y + dy, r + dr) === BLOCK.CAMPFIRE) return true;
  return false;
}

/** @returns {boolean} physics event `ev` changed one of the 8 neighbours of cell (q, y, r) */
function touchedAround(ev, q, y, r) {
  if (ev.cells.size === 0) return false;
  for (const [dq, dy, dr] of NEIGHBOURS) {
    const ny = y + dy;
    if (ny >= 0 && ny < WORLD_HEIGHT && ev.cells.has(packCell(q + dq, ny, r + dr))) return true;
  }
  return false;
}

/**
 * Ray (origin o, unit direction d) against a vertical cylinder (feet (bx, by, bz), radius, height): the smallest t ≥ 0
 * where it enters (0 when the origin is inside), else −1. Same model as pigs.raycast.
 * @returns {number}
 */
function rayCylinder(ox, oy, oz, dx, dy, dz, bx, by, bz, radius, height) {
  const px = ox - bx;
  const pz = oz - bz;
  const y0 = by;
  const y1 = by + height;
  const R2 = radius * radius;
  const c = px * px + pz * pz - R2;
  if (c <= 0 && oy >= y0 && oy <= y1) return 0;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = px * dx + pz * dz;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        const yy = oy + dy * t;
        if (t >= 0 && yy >= y0 && yy <= y1 && t < best) best = t;
      }
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (const yc of [y0, y1]) {
      const t = (yc - oy) / dy;
      const hx = px + dx * t;
      const hz = pz + dz * t;
      if (t >= 0 && hx * hx + hz * hz <= R2 && t < best) best = t;
    }
  }
  return best === Infinity ? -1 : best;
}
