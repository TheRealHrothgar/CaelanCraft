// Caelancraft — loose items in the world (PURE): what a dig, a pick or a kill gives flies out of the cell to the player and
// enters the pack only when it crosses the player's threshold; what the player throws or drops flies, lands and lies on
// the ground until it is walked over. See src/CONTRACTS.md §60.
//
// An item is one stack ({k, n, d?}) with a position (its centre), a velocity and a mode:
//   'pop'  — a fresh drop hopping out of its cell (POP_S), then 'home';
//   'home' — flying straight at the player's chest, faster and faster; within PICKUP_RADIUS it is collected;
//   'fly'  — thrown, dropped or falling: gravity, bounces on the cells, a projectile hits one mob;
//   'rest' — lying on a cell; walked within COLLECT_RADIUS (after `hold`) it homes again, when the pack has room.
// A ghost item (Creative) is only the animation: it is never collected into anything and fades when it lands.
// The world, the player, the pack and the mobs come in through LooseEnv each step; nothing here touches them directly.
import { getItem } from './items.js';

/** The player's threshold: an item within this distance of the chest point (m) enters the pack. */
export const PICKUP_RADIUS = 0.6;
/** The chest point a homing item flies at, above the feet (m). */
export const PICKUP_CHEST = 0.9;
/** A fresh drop hops out of its cell for this long before it flies to the player (s). */
export const POP_S = 0.16;
/** The hop: upward speed, and up to this much sideways (m/s). */
export const POP_SPEED = 2.6;
export const POP_SIDE = 0.8;
/** Homing starts at HOME_SPEED, speeds up by HOME_ACCEL per second, up to HOME_MAX (m/s). */
export const HOME_SPEED = 2;
export const HOME_ACCEL = 26;
export const HOME_MAX = 16;
/** A drop that has homed this long is collected wherever it is (it never orbits a running player) (s). */
export const HOME_MAX_S = 3;
/** A resting item within this distance of the player's chest point flies to them (m). */
export const COLLECT_RADIUS = 1.5;
/** A thrown or dropped item waits until the player has once been this much farther than COLLECT_RADIUS from it (m). */
export const AWAY_MARGIN = 0.5;
/** A thrown or dropped item (or one the full pack turned away) cannot be collected for this long (s). */
export const THROW_HOLD_S = 1.2;
/** Gravity on a flying item (m/s²); in water it sinks at most WATER_SINK. */
export const ITEM_GRAVITY = -16;
export const WATER_SINK = 1.5;
/** Half-size of a flying item for its collisions with the cells (m). */
export const ITEM_RADIUS = 0.12;
/** What is kept of the speed across a bounce; slower landings than LAND_SPEED settle. */
export const BOUNCE = 0.3;
export const LAND_SPEED = 3;
/** A projectile slower than this hurts nothing (m/s). */
export const HIT_MIN_SPEED = 4;
/** The longest step a flying item takes between collision checks (m). */
export const MAX_STEP = 0.1;
/** A ghost lying still fades after this (s); at most GHOST_MAX ghosts at once (the oldest goes first). */
export const GHOST_REST_S = 1.2;
export const GHOST_MAX = 48;
/** Below this height an item has fallen out of the world. */
export const FLOOR_Y = -8;
/** A block item is drawn as a cell this size (fallingRenderer's instance scale). */
export const LOOSE_BLOCK_SCALE = 0.25;

/** The sounds (audio.playRecipe data, circuitSounds' format): a throw's whoosh, the pickup blip, a hit's thunk. */
export const SOUND_THROW = Object.freeze({
  dur: 0.22, gain: 0.35, layers: [{ type: 'noise', f0: 0, bp: [500, 2200], q: 1.4, gain: 0.8, attack: 0.05, decay: 0.16 }],
});
export const SOUND_PICKUP = Object.freeze({
  dur: 0.14, gain: 0.22, layers: [
    { type: 'sine', f0: 660, f1: 1180, gain: 0.7, attack: 0.004, decay: 0.12 },
    { type: 'sine', f0: 1320, f1: 1760, gain: 0.25, attack: 0.004, decay: 0.08 },
  ],
});
export const SOUND_THUNK = Object.freeze({
  dur: 0.14, gain: 0.45, layers: [
    { type: 'noise', f0: 0, lp: 900, gain: 0.8, attack: 0.002, decay: 0.1 },
    { type: 'sine', f0: 240, f1: 130, gain: 0.5, attack: 0.002, decay: 0.12 },
  ],
});

/**
 * Throws: launch speed (m/s) and the power a hit deals a mob (the zombie counts hits to 4, a pig has 5 health). Rocks and
 * flint hurt a little; darts and spears more. Anything else — a block, a stick, food — is just chucked a short way.
 */
export const THROW_ROCK = Object.freeze({ speed: 13, power: 1 });
export const THROW_DART = Object.freeze({ speed: 21, power: 2 });
export const THROW_SPEAR = Object.freeze({ speed: 17, power: 4 });
export const THROW_CHUCK = Object.freeze({ speed: 6, power: 0 });
/** Drop: let go of an item a step in front of the feet (m/s forward). */
export const DROP_SPEED = 3;
/** The items that are thrown as stones. */
export const STONE_KEYS = Object.freeze(['rock', 'flint', 'obsidian_shard']);
/** The darts (made by hand: flint, a stick and plant fibre). */
export const DART_KEYS = Object.freeze(['flint_dart']);
/** A dart that hits a mob breaks with this chance (a spear takes 1 wear instead). */
export const DART_BREAK_P = 0.3;

/**
 * How an item flies when thrown. @param {string} key @returns {{ speed: number, power: number }}
 */
export function throwOf(key) {
  if (STONE_KEYS.includes(key)) return THROW_ROCK;
  if (DART_KEYS.includes(key)) return THROW_DART;
  const def = getItem(key);
  if (def && def.tool && def.tool.type === 'spear') return THROW_SPEAR;
  return THROW_CHUCK;
}

/**
 * @typedef {import('./types.js').ItemStack} ItemStack
 * @typedef {Object} LooseItem
 * @property {ItemStack} s          the stack (a copy; the module owns it)
 * @property {number} block         the block it is drawn as (a small spinning cell), or −1 for its item picture
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} vx
 * @property {number} vy
 * @property {number} vz
 * @property {'pop'|'home'|'fly'|'rest'} mode
 * @property {number} t             seconds in this mode
 * @property {number} hold          seconds before it may be collected again
 * @property {number} power         a projectile's power (0: it hurts nothing); spent on its first hit
 * @property {boolean} ghost        Creative: the animation only
 * @property {number} spin          a turn (radians) for the drawing
 * @property {boolean} away        the player has been away from it since it was thrown or dropped (only then is it
 *   collected: a dropped stack is not picked straight back up)
 */

/**
 * What one step may touch (main builds it once).
 * @typedef {Object} LooseEnv
 * @property {(x: number, y: number, z: number) => boolean} solid   the point is inside a solid cell
 * @property {(x: number, y: number, z: number) => boolean} [liquid]
 * @property {(x: number, z: number) => boolean} [loaded]   false: the column's chunk is not loaded — the item waits there
 * @property {{ x: number, y: number, z: number }|null} player       null: nobody collects (dead, or Creative for real items)
 * @property {(item: LooseItem) => (ItemStack|null)} collect          an item crossed the threshold: give it; what did not fit
 * @property {(stack: ItemStack) => boolean} [room]                   the pack can take at least one of it
 * @property {(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => (*|null)} [hitMob]  the first mob
 *   the segment enters, or null
 * @property {(item: LooseItem, mob: *) => (boolean|void)} [onHit]    a projectile hit `mob`; true: the item breaks
 * @property {(item: LooseItem, speed: number) => void} [onLand]      it hit the ground or a wall at this speed
 */

export class LooseItems {
  /** @param {() => number} [random] */
  constructor(random = Math.random) {
    /** @type {LooseItem[]} */
    this.list = [];
    this._random = random;
    /** @type {LooseItem[]|null} items added by a callback while a step runs (a kill's drops); joined after it */
    this._pending = null;
  }

  /** @returns {number} */
  get count() {
    return this.list.length;
  }

  clear() {
    this.list.length = 0;
  }

  /** @returns {LooseItem} */
  _add(s, block, x, y, z, vx, vy, vz, mode, opts) {
    const ghost = Boolean(opts && opts.ghost);
    if (ghost) {
      let ghosts = 0;
      for (const it of this.list) if (it.ghost) ghosts++;
      if (ghosts >= GHOST_MAX) {
        const i = this.list.findIndex((it) => it.ghost);
        if (i >= 0) this.list.splice(i, 1);
      }
    }
    /** @type {ItemStack} */
    const stack = { k: s.k, n: s.n };
    if (s.d !== undefined) stack.d = s.d;
    const it = /** @type {LooseItem} */ ({
      s: stack, block: Number.isInteger(block) ? block : -1, x, y, z, vx, vy, vz, mode, t: 0,
      hold: opts && opts.hold > 0 ? opts.hold : 0, power: opts && opts.power > 0 ? opts.power : 0, ghost,
      spin: this._random() * Math.PI * 2, away: !(opts && opts.away === false),
    });
    if (this._pending) this._pending.push(it);
    else this.list.push(it);
    return it;
  }

  /**
   * A drop out of a broken (or picked) cell, or off a mob: it hops out of (x, y, z) and flies to the player.
   * @param {ItemStack} s
   * @param {{ block?: number, ghost?: boolean }} [opts]
   * @returns {LooseItem|null} null for an empty stack
   */
  spawnDrop(s, x, y, z, opts = {}) {
    if (!s || !(s.n > 0) || !Number.isFinite(x + y + z)) return null;
    const a = this._random() * Math.PI * 2;
    const side = this._random() * POP_SIDE;
    return this._add(s, opts.block ?? -1, x, y, z, Math.cos(a) * side, POP_SPEED, Math.sin(a) * side, 'pop', opts);
  }

  /**
   * Throw or drop: a stack leaving (x, y, z) at velocity v. `power` > 0 makes it a projectile.
   * @param {ItemStack} s
   * It is collected only after `hold` (THROW_HOLD_S) and once the player has stepped away from it (`away` false).
   * @param {{ block?: number, ghost?: boolean, power?: number, hold?: number, away?: boolean }} [opts]
   * @returns {LooseItem|null}
   */
  launch(s, x, y, z, vx, vy, vz, opts = {}) {
    if (!s || !(s.n > 0) || !Number.isFinite(x + y + z + vx + vy + vz)) return null;
    return this._add(s, opts.block ?? -1, x, y, z, vx, vy, vz, 'fly', { hold: THROW_HOLD_S, away: false, ...opts });
  }

  /** The real (not ghost) stacks still flying to the player: a dig checks the pack has room for them too. @returns {ItemStack[]} */
  inFlight() {
    /** @type {ItemStack[]} */
    const out = [];
    for (const it of this.list) if (!it.ghost && (it.mode === 'pop' || it.mode === 'home')) out.push(it.s);
    return out;
  }

  /** Every homing item falls where it is (the player died, or left Survival). */
  release() {
    for (const it of this.list) {
      if (it.mode !== 'pop' && it.mode !== 'home') continue;
      if (it.ghost) {
        it.mode = 'rest';
        it.t = GHOST_REST_S;
        continue;
      }
      it.mode = 'fly';
      it.t = 0;
      it.vx = 0;
      it.vy = 0;
      it.vz = 0;
      it.hold = THROW_HOLD_S;
    }
    this.list = this.list.filter((it) => !(it.ghost && it.mode === 'rest' && it.t >= GHOST_REST_S));
  }

  /**
   * Move every item one step.
   * @param {number} dt
   * @param {LooseEnv} env
   */
  step(dt, env) {
    if (!(dt > 0)) return;
    const keep = [];
    this._pending = [];
    for (const it of this.list) {
      // Not in a loaded chunk (the player walked away): frozen, so it never falls through the missing ground.
      if (env.loaded && it.mode !== 'home' && it.mode !== 'pop' && !env.loaded(it.x, it.z)) {
        keep.push(it);
        continue;
      }
      it.t += dt;
      if (it.hold > 0) it.hold = Math.max(0, it.hold - dt);
      let alive = true;
      if (it.mode === 'pop') {
        it.vy += ITEM_GRAVITY * dt;
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        it.z += it.vz * dt;
        it.spin += dt * 6;
        if (it.t >= POP_S) {
          it.mode = 'home';
          it.t = 0;
        }
      } else if (it.mode === 'home') {
        alive = this._home(it, dt, env);
      } else if (it.mode === 'fly') {
        alive = this._fly(it, dt, env);
      } else {
        alive = this._rest(it, dt, env);
      }
      if (alive && it.y < FLOOR_Y) alive = false;
      if (alive) keep.push(it);
    }
    for (const it of this._pending) keep.push(it);
    this._pending = null;
    this.list = keep;
  }

  /** @returns {boolean} still in the world */
  _home(it, dt, env) {
    const p = env.player;
    if (!p || (!it.ghost && !env.collect)) {
      if (it.ghost) return false;
      it.mode = 'fly';
      it.t = 0;
      it.vx = it.vy = it.vz = 0;
      return true;
    }
    const tx = p.x;
    const ty = p.y + PICKUP_CHEST;
    const tz = p.z;
    let dx = tx - it.x;
    let dy = ty - it.y;
    let dz = tz - it.z;
    let d = Math.hypot(dx, dy, dz);
    const speed = Math.min(HOME_MAX, HOME_SPEED + HOME_ACCEL * it.t);
    if (d > PICKUP_RADIUS && it.t < HOME_MAX_S) {
      const stepLen = Math.min(d, speed * dt);
      it.vx = (dx / d) * speed;
      it.vy = (dy / d) * speed;
      it.vz = (dz / d) * speed;
      it.x += (dx / d) * stepLen;
      it.y += (dy / d) * stepLen;
      it.z += (dz / d) * stepLen;
      it.spin += dt * 9;
      dx = tx - it.x;
      dy = ty - it.y;
      dz = tz - it.z;
      d = Math.hypot(dx, dy, dz);
      if (d > PICKUP_RADIUS) return true;
    }
    // Crossed the threshold.
    if (it.ghost) return false;
    const left = env.collect(it);
    if (!left || !(left.n > 0)) return false;
    // The pack was full: what is left falls at the player's feet and waits.
    it.s = { k: left.k, n: left.n };
    if (left.d !== undefined) it.s.d = left.d;
    it.mode = 'fly';
    it.t = 0;
    it.x = p.x;
    it.y = p.y + 0.5;
    it.z = p.z;
    it.vx = it.vy = it.vz = 0;
    it.hold = THROW_HOLD_S;
    return true;
  }

  /** @returns {boolean} */
  _fly(it, dt, env) {
    const wet = env.liquid ? env.liquid(it.x, it.y, it.z) : false;
    it.vy += ITEM_GRAVITY * dt;
    if (wet) {
      it.vx *= Math.max(0, 1 - 4 * dt);
      it.vz *= Math.max(0, 1 - 4 * dt);
      if (it.vy < -WATER_SINK) it.vy = -WATER_SINK;
      if (it.vy > WATER_SINK) it.vy = Math.max(WATER_SINK, it.vy * Math.max(0, 1 - 4 * dt));
    }
    const speed0 = Math.hypot(it.vx, it.vy, it.vz);
    it.spin += dt * Math.min(14, 2 + speed0);
    const n = Math.max(1, Math.ceil((speed0 * dt) / MAX_STEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      // A projectile tests its path against the mobs before the cells.
      if (it.power > 0 && env.hitMob && Math.hypot(it.vx, it.vy, it.vz) >= HIT_MIN_SPEED) {
        const mob = env.hitMob(it.x, it.y, it.z, it.x + it.vx * h, it.y + it.vy * h, it.z + it.vz * h);
        if (mob) {
          const broke = env.onHit ? env.onHit(it, mob) : false;
          it.power = 0;
          if (broke) return false;
          it.vx *= -0.15;
          it.vz *= -0.15;
          it.vy = Math.max(it.vy * 0.2, 1);
          continue;
        }
      }
      const R = ITEM_RADIUS;
      const nx = it.x + it.vx * h;
      if (env.solid(nx + Math.sign(it.vx) * R, it.y, it.z)) {
        if (env.onLand && Math.abs(it.vx) > LAND_SPEED) env.onLand(it, Math.abs(it.vx));
        it.vx = -it.vx * BOUNCE;
        it.power = 0;
      } else {
        it.x = nx;
      }
      const nz = it.z + it.vz * h;
      if (env.solid(it.x, it.y, nz + Math.sign(it.vz) * R)) {
        if (env.onLand && Math.abs(it.vz) > LAND_SPEED) env.onLand(it, Math.abs(it.vz));
        it.vz = -it.vz * BOUNCE;
        it.power = 0;
      } else {
        it.z = nz;
      }
      const ny = it.y + it.vy * h;
      if (it.vy <= 0 && env.solid(it.x, ny - R, it.z)) {
        const hitSpeed = -it.vy;
        it.y = Math.floor(ny - R) + 1 + R;
        it.power = 0;
        if (env.onLand) env.onLand(it, hitSpeed);
        if (hitSpeed > LAND_SPEED) {
          it.vy = hitSpeed * BOUNCE;
          it.vx *= 0.5;
          it.vz *= 0.5;
        } else {
          it.vx = it.vy = it.vz = 0;
          it.mode = 'rest';
          it.t = 0;
          return true;
        }
      } else if (it.vy > 0 && env.solid(it.x, ny + R, it.z)) {
        it.vy = 0;
      } else {
        it.y = ny;
      }
    }
    return true;
  }

  /** @returns {boolean} */
  _rest(it, dt, env) {
    if (it.ghost) return it.t < GHOST_REST_S;
    // The cell under it went: it falls again.
    if (!env.solid(it.x, it.y - ITEM_RADIUS - 0.05, it.z)) {
      it.mode = 'fly';
      it.t = 0;
      return true;
    }
    const p = env.player;
    if (!p || !env.collect) return true;
    const d = Math.hypot(p.x - it.x, p.y + PICKUP_CHEST - it.y, p.z - it.z);
    if (!it.away) {
      if (d > COLLECT_RADIUS + AWAY_MARGIN) it.away = true;
      return true;
    }
    if (it.hold > 0 || d > COLLECT_RADIUS) return true;
    if (env.room && !env.room(it.s)) return true;
    it.mode = 'home';
    it.t = 0;
    return true;
  }

  /** The real items for the save: `[{ k, n, d?, x, y, z }]` (ghosts are not saved). */
  serialize() {
    return this.list.filter((it) => !it.ghost).map((it) => {
      const o = /** @type {*} */ ({ k: it.s.k, n: it.s.n, x: round3(it.x), y: round3(it.y), z: round3(it.z) });
      if (it.s.d !== undefined) o.d = it.s.d;
      return o;
    });
  }

  /**
   * Put saved items back (each falls where it was and waits to be walked over). Bad entries are skipped.
   * @param {*} list
   * @param {(key: string) => number} [blockOf]  the block a key is drawn as (−1: its picture)
   * @returns {number} how many were loaded
   */
  load(list, blockOf) {
    this.clear();
    if (!Array.isArray(list)) return 0;
    for (const o of list) {
      if (!o || typeof o.k !== 'string' || !getItem(o.k) || !Number.isInteger(o.n) || o.n < 1) continue;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
      /** @type {ItemStack} */
      const s = { k: o.k, n: o.n };
      if (Number.isInteger(o.d) && o.d >= 0) s.d = o.d;
      const it = this._add(s, blockOf ? blockOf(o.k) : -1, o.x, o.y, o.z, 0, 0, 0, 'fly', { hold: 0 });
      it.t = 0;
    }
    return this.list.length;
  }
}

/** @param {number} v */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}
