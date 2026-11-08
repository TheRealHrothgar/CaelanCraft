// Caelancraft — flowing water: the water rule, its extra trigger and reseeder, drain and currents. See src/CONTRACTS.md
// §35 and docs/DESIGN-physics.md §4 / §10.2. PURE: the world is read through ctx.peek / world.peekBlock and written only
// through ctx.write (lazy, capped, event-recorded).
//
// Water is a FAMILY of blocks: WATER (a source — it never changes by itself), WATER_FLOW_1..6 (level k, derived from
// its feeders) and WATER_FALL (water with water above it that its sides do not feed better). With E(id) = 7 for WATER,
// k for FLOW_k and, for FALL, the level of the water pouring in at the top of its column (fallLevel: 7 under a source,
// k under FLOW_k), and
//
//   spreads(n) ⇔ n is water and the cell below n is solid or a WATER source (never over FALL / FLOW / AIR),
//
// ONE rule (both the `water` ring, WATER_TICKS, and the `fall` ring, 1 tick) recomputes a cell from its neighbourhood:
//   1. a source stays a source;
//   2. a FLOW / FALL cell with ≥ WATER_SOURCE_NEIGHBOURS WATER side-neighbours over a solid or WATER floor → WATER, and
//      so does one in a cell generated as WATER (natural sea / lake refills as itself, on any floor — what saving makes
//      of it anyway);
//   3. with L = max(E(n) − 1) over the side neighbours n that spread: water above and fallLevel ≥ L → FALL;
//   4. else L ≥ 1 → FLOW_L (also under water, when the sides feed it better than the fall: a trickle landing in a
//      stream keeps the stream's level); else AIR (a campfire stays);
//   5. write the result if it differs — the scheduler's 'water' trigger re-queues the neighbourhood (the cell below
//      a new water cell on the 1-tick fall ring), so a change propagates one cell per update and a waterfall
//      advances exactly one cell per tick;
//   6. a source or flowing cell this update left unchanged, over AIR / CAMPFIRE / a FLOW no higher than itself,
//      writes FALL below it.
// Every level is exactly what its feeders imply, so taking the source away drains its flow by itself (the highest level
// left always loses its feeder). Falling keeps a stream's level and never refreshes it, so every FLOW_k is within 7 − k
// cells of a source: one source wets at most the 127 columns of a reach-6 hex disc, however the ground falls away (126
// FLOW cells on flat ground, 367 cells off a 10-high plateau, ~150 down a hillside), while a source poured over a drop
// lands at full strength and spreads a reach-6 pool where it lands. A cell's level is the best of what falls into it
// and what its sides feed it, so more water never lowers a level: water only rises toward where it settles, and a
// reload's reflow (which starts from the sources) never wets — or douses — a cell the live world keeps dry.
// Water entering a campfire puts it out ('hiss' + steam) — also one a command put there (§32).
//
// The scheduler's triggers queue a changed cell and its 8 neighbours. The rule also reads the cell BELOW each side
// neighbour and the column ABOVE a falling one, so this module adds the 'water-floor' trigger: when a cell starts / stops
// being a floor (solid or WATER) under water, the side neighbours of that water are re-queued, and when the water above
// a fall column changes, the column cells beside spreading water, the FLOW it ends on and the side neighbours of where
// it lands. It replaces the built-in 'water' reseeder with one that also wakes edited AIR next to water (a dug-out hole
// beside the sea: flow is never saved) and neighbours in chunks that are not loaded yet (they wait for their chunk), so
// streamed / reloaded water flows on.
import { WORLD_HEIGHT, WATER_CURRENT, DRAIN_MAX_RADIUS, WATER_SOURCE_NEIGHBOURS } from './config.js';
import { BLOCK, UNLOADED, isSolid, isWater, waterLevel } from './blocks.js';
import { HEX_DIRS, FACE_NORMALS, hexToWorld, worldToHex } from './hex.js';

/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').RuleContext} RuleContext */

const B = BLOCK;
/** FLOW_k = FLOW_ID0 + k for k = 1..6. */
const FLOW_ID0 = B.WATER_FLOW_1 - 1;

/** Block ids the water rule reacts to (CONTRACTS §35.1). */
export const WATER_RULE_IDS = Object.freeze([
  B.AIR, B.CAMPFIRE, B.WATER, B.WATER_FLOW_1, B.WATER_FLOW_2, B.WATER_FLOW_3, B.WATER_FLOW_4, B.WATER_FLOW_5,
  B.WATER_FLOW_6, B.WATER_FALL,
]);
/** Edited ids the 'water' reseeder looks at when a chunk is generated: the water family and AIR. */
const RESEED_IDS = Object.freeze([B.AIR, ...WATER_RULE_IDS.slice(2)]);

/** Side-neighbour offsets and the unit world direction toward each (FACE_NORMALS of the side faces). */
const DQ = HEX_DIRS.map((d) => d[0]);
const DR = HEX_DIRS.map((d) => d[1]);
const NX = HEX_DIRS.map((_, j) => FACE_NORMALS[j][0]);
const NZ = HEX_DIRS.map((_, j) => FACE_NORMALS[j][2]);

/** @returns {boolean} WATER_FLOW_1..6 */
export function isFlowingWater(id) {
  return id >= B.WATER_FLOW_1 && id <= B.WATER_FLOW_6;
}

/** @returns {boolean} water standing on `below` spreads sideways: a solid floor or a WATER source (DESIGN §4) */
export function isWaterFloor(below) {
  return below === B.WATER || isSolid(below);
}

/** @returns {number} the id of flowing water of level `level` (1..6); ≤ 0 → AIR, ≥ 7 → WATER_FLOW_6 */
export function flowId(level) {
  if (!(level >= 1)) return B.AIR;
  return FLOW_ID0 + Math.min(6, Math.floor(level));
}

/**
 * E of the falling water at (q, y, r) (CONTRACTS §35.1): the level of the water pouring in at the top of its column —
 * 7 under a source, k under WATER_FLOW_k, 0 when nothing feeds it (a stale fall, about to go). Falling keeps a stream's
 * level, it never refreshes it: without this every 1-high step of a slope restarted a full reach-6 disc (review water-3).
 * @param {{ peek(q: number, y: number, r: number): number }} ctx
 * @returns {number}
 */
export function fallLevel(ctx, q, y, r) {
  let yy = y + 1;
  let top = ctx.peek(q, yy, r);
  while (top === B.WATER_FALL) top = ctx.peek(q, ++yy, r);
  return top === B.WATER || isFlowingWater(top) ? waterLevel(top) : 0;
}

/** @returns {boolean} the scheduler may need to (re)run the water rule here: open, flowing or falling, or not loaded yet */
function isWakeable(id) {
  return id === B.AIR || id === B.CAMPFIRE || id === B.WATER_FALL || isFlowingWater(id) || id === UNLOADED;
}

export class Fluids {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    this.maxDrainRadius = DRAIN_MAX_RADIUS;
    /** rule updates run / cells written by the rule (status and tests) */
    this.stats = { updates: 0, writes: 0 };
    physics.registerRule('water', {
      rings: ['water', 'fall'],
      feature: 'water',
      ids: WATER_RULE_IDS,
      update: (ctx, q, y, r, id) => this._update(ctx, q, y, r, id),
    });
    physics.addTrigger('water-floor', 'water', (q, y, r, prev, next) => this._onFloorChange(q, y, r, prev, next));
    // Replaces the scheduler's built-in 'water' reseeder (same name, CONTRACTS §33.4).
    physics.addReseeder('water', 'water', RESEED_IDS, (ctx, q, y, r, id) => this._reseed(q, y, r, id));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the rule (CONTRACTS §35.2)

  /**
   * Recompute cell (q, y, r) holding `id` (AIR, CAMPFIRE or water). Reads every input before writing anything, so a
   * park (a side neighbour in an unloaded chunk) never leaves half an update behind.
   * @param {RuleContext} ctx
   */
  _update(ctx, q, y, r, id) {
    this.stats.updates++;
    let target = id;
    if (id !== B.WATER) {
      let fed = 0;
      let sources = 0;
      for (let j = 0; j < 6; j++) {
        const nq = q + DQ[j];
        const nr = r + DR[j];
        const n = ctx.peek(nq, y, nr);
        if (n === UNLOADED) {
          // Wait for that chunk; water here may have to flow into it, so its cell is queued too (it parks itself).
          if (isWater(id)) ctx.schedule('water', nq, y, nr);
          ctx.park(nq, nr);
          return;
        }
        if (!isWater(n)) continue;
        if (n === B.WATER) sources++;
        if (isWaterFloor(ctx.peek(nq, y - 1, nr))) {
          const l = (n === B.WATER_FALL ? fallLevel(ctx, nq, y, nr) : waterLevel(n)) - 1;
          if (l > fed) fed = l;
        }
      }
      const above = ctx.peek(q, y + 1, r);
      if (id !== B.AIR && id !== B.CAMPFIRE
        && ((sources >= WATER_SOURCE_NEIGHBOURS && isWaterFloor(ctx.peek(q, y - 1, r))) || this._isNaturalWater(q, y, r))) {
        target = B.WATER; // infinite source (a hole in a lake refills as lake); natural water refills as natural water
      } else if (isWater(above) && (fed === 0 || fallLevel(ctx, q, y, r) >= fed)) {
        target = B.WATER_FALL; // the water pouring in from above feeds it at least as well as its sides do
      } else if (fed > 0) {
        // (also under water: fed better from its sides than by the fall above — a trickle landing in a stream — it keeps
        // the stream's level, so more water above never lowers a cell below; review water-3 regression)
        target = FLOW_ID0 + fed;
      } else {
        target = id === B.CAMPFIRE ? B.CAMPFIRE : B.AIR;
      }
    }

    if (target !== id) {
      if (ctx.write(q, y, r, target) === 'ok') {
        this.stats.writes++;
        if (id === B.CAMPFIRE) this._douse(ctx, q, y, r);
        else if (!isWater(id)) this._splashIfLanding(ctx, q, y, r, target);
      }
      // Written ('ok'): the trigger has queued the cell below on the fall ring, so a waterfall advances exactly one
      // cell per tick. 'capped': physics holds water back (the chat line is said).
      return;
    }

    // 6. Downward: a settled source or flowing cell over an open cell (or over flowing water no higher than itself)
    // falls into it. Falling water's front is left to the trigger (it queued the cell below), or a waterfall would
    // advance two cells a tick. A FLOW below that is higher than this cell is fed better from its sides: left alone.
    if ((target === B.WATER || isFlowingWater(target)) && y > 0) {
      const below = ctx.peek(q, y - 1, r);
      if (below === B.AIR || below === B.CAMPFIRE || (isFlowingWater(below) && waterLevel(below) <= waterLevel(target))) {
        if (ctx.write(q, y - 1, r, B.WATER_FALL) === 'ok') {
          this.stats.writes++;
          if (below === B.CAMPFIRE) this._douse(ctx, q, y - 1, r);
          else if (below === B.AIR) this._splashIfLanding(ctx, q, y - 1, r, B.WATER_FALL);
        }
      }
    }
  }

  /**
   * @returns {boolean} the cell was generated as WATER (natural sea / lake): flowing or falling water there is the sea
   *   coming back, saved as WATER anyway (§33.9 drops the edit), so the rule makes it a source in the live world too.
   */
  _isNaturalWater(q, y, r) {
    const world = this.physics.world;
    return typeof world.originAt === 'function' && world.originAt(q, y, r) === B.WATER;
  }

  /** A campfire was flooded: it is out (the write already replaced it). */
  _douse(ctx, q, y, r) {
    const [x, z] = hexToWorld(q, r);
    ctx.sound('hiss', x, y + 0.5, z, 1);
    ctx.particles('steam', x, y + 0.6, z, 12, { spread: 0.3, speed: 1.2 });
  }

  /** Water that just appeared in an empty cell splashes when it lands on something (or starts from a source). */
  _splashIfLanding(ctx, q, y, r, target) {
    const landing = target === B.WATER_FALL ? isWaterFloor(ctx.peek(q, y - 1, r)) : target === flowId(6);
    if (!landing) return;
    const [x, z] = hexToWorld(q, r);
    ctx.sound('splash', x, y + 0.5, z, target === B.WATER_FALL ? 0.8 : 0.4);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // trigger and reseeder (CONTRACTS §35.3)

  /**
   * 'water-floor' trigger: a cell started or stopped being a floor (solid or WATER) under water — that water starts /
   * stops spreading sideways, so its side neighbours (which the scheduler's own trigger does not reach) are re-queued.
   * Also: the water directly above a fall column changed — its fallLevel did too, all the way down. Re-queued: every
   * FALL of the column beside spreading water (rule 2b compares the fall with that side feed), the FLOW the column
   * ends on (fed better from its sides: it compares again) and, where the column lands on a floor, the landing's side
   * neighbours (what it feeds).
   */
  _onFloorChange(q, y, r, prev, next) {
    const world = this.physics.world;
    if (isWaterFloor(prev) !== isWaterFloor(next) && isWater(world.peekBlock(q, y + 1, r))) {
      for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], y + 1, r + DR[j]);
    }
    if (prev !== next && (isWater(prev) || isWater(next)) && world.peekBlock(q, y - 1, r) === B.WATER_FALL) {
      for (let yy = y - 1; ; yy--) {
        if (this._besideSpreadingWater(q, yy, r)) this._wake(q, yy, r);
        if (yy === 0) break;
        const below = world.peekBlock(q, yy - 1, r);
        if (below === B.WATER_FALL) continue;
        if (isFlowingWater(below)) this._wake(q, yy - 1, r);
        else if (isWaterFloor(below)) for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], yy, r + DR[j]);
        break;
      }
    }
  }

  /** @returns {boolean} a side neighbour of (q, y, r) is water that spreads (it stands on a floor) */
  _besideSpreadingWater(q, y, r) {
    const world = this.physics.world;
    for (let j = 0; j < 6; j++) {
      const nq = q + DQ[j];
      const nr = r + DR[j];
      if (isWater(world.peekBlock(nq, y, nr)) && isWaterFloor(world.peekBlock(nq, y - 1, nr))) return true;
    }
    return false;
  }

  /**
   * Chunk generated: every EDITED cell of it with an id in RESEED_IDS. Sources wake their open neighbours, flowing /
   * falling water itself and its open neighbours, and edited AIR that touches water (or a chunk not loaded yet) itself.
   * Neighbours in chunks that are not loaded yet are queued anyway: they park until their chunk arrives.
   */
  _reseed(q, y, r, id) {
    if (id === B.AIR) {
      if (this._touchesWater(q, y, r)) this._wake(q, y, r);
      return;
    }
    if (id !== B.WATER) this._wake(q, y, r);
    for (let j = 0; j < 6; j++) this._wakeIfOpen(q + DQ[j], y, r + DR[j]);
    this._wakeIfOpen(q, y + 1, r);
    this._wakeIfOpen(q, y - 1, r);
  }

  /** @returns {boolean} a side neighbour or the cell above is water, or a side neighbour is in an unloaded chunk */
  _touchesWater(q, y, r) {
    const world = this.physics.world;
    if (isWater(world.peekBlock(q, y + 1, r))) return true;
    for (let j = 0; j < 6; j++) {
      const n = world.peekBlock(q + DQ[j], y, r + DR[j]);
      if (n === UNLOADED || isWater(n)) return true;
    }
    return false;
  }

  _wakeIfOpen(q, y, r) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return;
    if (isWakeable(this.physics.world.peekBlock(q, y, r))) this._wake(q, y, r);
  }

  /** Queue the water rule on cell (q, y, r): falling water and open cells under water in `fall`, the rest in `water`. */
  _wake(q, y, r) {
    const world = this.physics.world;
    const id = world.peekBlock(q, y, r);
    const intoFall = id === B.WATER_FALL || (id !== B.WATER && id !== UNLOADED && isWater(world.peekBlock(q, y + 1, r)));
    this.physics.schedule(intoFall ? 'fall' : 'water', q, y, r);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // drain and currents (CONTRACTS §35.5)

  /**
   * `drain [radius]` (console: around the player's cell; rune: around the rune): every water cell within hex distance
   * `radius` and |dy| ≤ radius becomes AIR (lazy physics writes; stops when the edit cap refuses). Natural water
   * around the drained space flows back in by the normal rules; the message says so.
   * @returns {{ ok: boolean, message: string }}
   */
  drain(q, y, r, radius) {
    const R = Math.floor(Number(radius));
    if (!Number.isFinite(q + y + r) || !(R >= 0 && R <= this.maxDrainRadius)) {
      return { ok: false, message: `drain needs a cell and a radius 0..${this.maxDrainRadius}` };
    }
    const physics = this.physics;
    const world = physics.world;
    const ctx = physics.ctx;
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(WORLD_HEIGHT - 1, y + R);
    let removed = 0;
    let natural = 0;
    let unloaded = 0;
    let capped = false;
    outer: for (let dq = -R; dq <= R; dq++) {
      const drMin = Math.max(-R, -dq - R);
      const drMax = Math.min(R, -dq + R);
      for (let dr = drMin; dr <= drMax; dr++) {
        const cq = q + dq;
        const cr = r + dr;
        if (!world.hasChunkAtCell(cq, cr)) {
          unloaded++;
          continue;
        }
        for (let cy = y0; cy <= y1; cy++) {
          const id = world.peekBlock(cq, cy, cr);
          if (!isWater(id)) continue;
          const wasNatural = id === B.WATER && !world.hasEdit(cq, cy, cr);
          const res = ctx.write(cq, cy, cr, B.AIR);
          if (res === 'capped') {
            capped = true;
            break outer;
          }
          if (res === 'ok') {
            removed++;
            if (wasNatural) natural++;
          }
        }
      }
    }
    if (removed === 0) {
      const why = capped ? ' (the world already has too many edited cells)' : unloaded > 0 ? ' in the loaded chunks' : '';
      return { ok: true, message: `no water to drain within ${R}${why}` };
    }
    let message = `drained ${removed} water cell${removed === 1 ? '' : 's'} within ${R}`;
    if (natural > 0 && this._waterAround(q, y0, y1, r, R)) message += ' — the water around it flows back in';
    if (capped) message += ' (stopped: the world already has too many edited cells)';
    if (unloaded > 0) message += ` (${unloaded} column${unloaded === 1 ? '' : 's'} not loaded)`;
    return { ok: true, message };
  }

  /** @returns {boolean} water just outside a drained range (the ring at R + 1, or the layer above it) */
  _waterAround(q, y0, y1, r, R) {
    const world = this.physics.world;
    for (let dq = -R - 1; dq <= R + 1; dq++) {
      for (let dr = Math.max(-R - 1, -dq - R - 1); dr <= Math.min(R + 1, -dq + R + 1); dr++) {
        const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (d <= R && isWater(world.peekBlock(q + dq, y1 + 1, r + dr))) return true;
        if (d !== R + 1) continue;
        for (let cy = y0; cy <= y1; cy++) if (isWater(world.peekBlock(q + dq, cy, r + dr))) return true;
      }
    }
    return false;
  }

  /**
   * Current acceleration for a body sampled at WORLD (x, y, z) = its feet + 0.1 (main and pigs sum it into their pull
   * input): WATER_CURRENT toward the lowest-level open side neighbour in a FLOW cell (ties: their mean direction; AIR
   * counts as level 0, solid cells are walls), straight down in falling water, nothing in a source, elsewhere or while
   * the water switch is off.
   * @param {number[]} out  [ax, ay, az] m/s²
   * @returns {number[]} out
   */
  currentAt(x, y, z, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (!this.physics.switches.water || !Number.isFinite(x + y + z)) return out;
    const world = this.physics.world;
    const [q, r] = worldToHex(x, z);
    const cy = Math.floor(y);
    const id = world.peekBlock(q, cy, r);
    if (id === B.WATER_FALL) {
      out[1] = -WATER_CURRENT;
      return out;
    }
    if (!isFlowingWater(id)) return out;
    const own = waterLevel(id);
    let min = own;
    let sx = 0;
    let sz = 0;
    for (let j = 0; j < 6; j++) {
      const n = world.peekBlock(q + DQ[j], cy, r + DR[j]);
      if (n === UNLOADED || isSolid(n)) continue;
      const l = waterLevel(n);
      if (l < min) {
        min = l;
        sx = NX[j];
        sz = NZ[j];
      } else if (l === min && l < own) {
        sx += NX[j];
        sz += NZ[j];
      }
    }
    const len = Math.hypot(sx, sz);
    if (min >= own || len < 1e-9) return out;
    out[0] = (sx / len) * WATER_CURRENT;
    out[2] = (sz / len) * WATER_CURRENT;
    return out;
  }

  /** Nothing is held between updates: the world is the state. */
  reset() {
    this.stats.updates = 0;
    this.stats.writes = 0;
  }

  /** The 'water' switch changed: nothing to do (switched off, the rule, trigger and reseeder are skipped). */
  onSwitch(_on) {}
}
