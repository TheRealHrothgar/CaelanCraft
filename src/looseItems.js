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
// Despawns (CONTRACTS §63): a real item lying loose for LOOSE_DESPAWN_S is gone (it blinks for the last LOOSE_BLINK_S);
// one that lands in a lit campfire burns at once; beyond LOOSE_MAX the oldest go; `despawnNear` clears an area (the
// `despawn` command, from the console or a Rune Block). Its age is saved.
// The world, the player, the pack and the mobs come in through LooseEnv each step; nothing here touches them directly.
import { getItem, canonicalItemKey, carriedWear } from './items.js';

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
/** A real item lying loose (thrown, dropped or turned away by a full pack) despawns after this long in a loaded chunk (s). */
export const LOOSE_DESPAWN_S = 300;
/** … blinking for its last LOOSE_BLINK_S, LOOSE_BLINK_HZ times a second. */
export const LOOSE_BLINK_S = 10;
export const LOOSE_BLINK_HZ = 4;
/** At most this many real loose items: past it, the oldest lying ones despawn first. */
export const LOOSE_MAX = 256;

/**
 * Whether a loose item is in its blink-off phase this frame (the last LOOSE_BLINK_S of its life).
 * @param {LooseItem} it @param {number} time  any running clock (s)
 */
export function blinkHidden(it, time) {
  if (it.ghost || it.mode === 'pop' || it.mode === 'home') return false;
  if (LOOSE_DESPAWN_S - it.age > LOOSE_BLINK_S) return false;
  return Math.floor(time * LOOSE_BLINK_HZ * 2) % 2 === 1;
}

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
 * flint hurt a little; spears more. Anything else — a block, a stick, food, an arrow without its bow — is just chucked a
 * short way. (§100: the Flint Dart and the Fletched Dart are retired; their keys are Flint Arrows, items.ITEM_ALIASES.)
 */
export const THROW_ROCK = Object.freeze({ speed: 13, power: 1 });
export const THROW_SPEAR = Object.freeze({ speed: 17, power: 4 });
export const THROW_CHUCK = Object.freeze({ speed: 6, power: 0 });
/** Drop: let go of an item a step in front of the feet (m/s forward). */
export const DROP_SPEED = 3;
/** The items that are thrown as stones. */
export const STONE_KEYS = Object.freeze(['rock', 'flint', 'obsidian_shard']);

// ---- §100 the bows and the arrows ---------------------------------------------------------------------------------

/** The arrows, in the order of the ages (stone first). Every bow shoots every one of them. */
export const ARROW_KEYS = Object.freeze(['stone_arrow', 'flint_arrow', 'copper_arrow', 'bronze_arrow', 'iron_arrow', 'steel_arrow']);
/** The order a bow takes its arrow from the pack (Survival): the best head first. */
export const ARROW_PREFERENCE = Object.freeze([...ARROW_KEYS].reverse());
/** What a bow shoots in Creative when the hotbar holds no arrow (Creative needs none: it shoots a ghost). */
export const DEFAULT_ARROW = 'flint_arrow';
/** What a Place press with a bow says when there is no arrow to shoot (Survival: none of any age in the pack). */
export const NO_ARROWS_HINT = 'No arrows: make them by hand from a stick, a rock or a flint, and a feather';
/** A metal head survives a miss this often (stone and flint shatter on rock more often). */
export const METAL_MISS_KEEP = 0.97;

/**
 * @typedef {Object} ArrowDef
 * @property {string} head      'stone', 'flint', 'copper', 'bronze', 'iron', 'steel'
 * @property {number} power     the power of a hit at full draw
 * @property {number} hitKeep   the chance it survives a hit on a mob, to be picked up again
 * @property {number} missKeep  the chance it survives a miss (landing on the ground or against a wall)
 */
/**
 * Every arrow by key: power by its head (stone 2, flint 3, copper 3, bronze 4, iron 5, steel 6) and how likely it is to
 * be picked up again — a hit breaks a stone head about two times in three and a steel one one time in ten; a miss lies
 * where it fell, a stone or flint head now and then shattered.
 * @type {Readonly<Record<string, Readonly<ArrowDef>>>}
 */
export const ARROWS = Object.freeze({
  stone_arrow: Object.freeze({ head: 'stone', power: 2, hitKeep: 0.35, missKeep: 0.85 }),
  flint_arrow: Object.freeze({ head: 'flint', power: 3, hitKeep: 0.5, missKeep: 0.9 }),
  copper_arrow: Object.freeze({ head: 'copper', power: 3, hitKeep: 0.7, missKeep: METAL_MISS_KEEP }),
  bronze_arrow: Object.freeze({ head: 'bronze', power: 4, hitKeep: 0.75, missKeep: METAL_MISS_KEEP }),
  iron_arrow: Object.freeze({ head: 'iron', power: 5, hitKeep: 0.85, missKeep: METAL_MISS_KEEP }),
  steel_arrow: Object.freeze({ head: 'steel', power: 6, hitKeep: 0.9, missKeep: METAL_MISS_KEEP }),
});

/** @param {string|null|undefined} key @returns {Readonly<ArrowDef>|null} the arrow, or null for anything else */
export function arrowOf(key) {
  return typeof key === 'string' && Object.hasOwn(ARROWS, key) ? ARROWS[key] : null;
}

/** The chance that projectile `key` breaks on a mob it hits: an arrow 1 − hitKeep; 0 for anything else. @param {string} key */
export function hitBreakP(key) {
  const a = arrowOf(key);
  return a ? Math.round((1 - a.hitKeep) * 1000) / 1000 : 0;
}

/** The chance that projectile `key` breaks when it misses and lands: an arrow 1 − missKeep; 0 otherwise. @param {string} key */
export function missBreakP(key) {
  const a = arrowOf(key);
  return a ? Math.round((1 - a.missKeep) * 1000) / 1000 : 0;
}

/**
 * The arrow a bow takes: the first of ARROW_PREFERENCE (steel, iron, bronze, copper, flint, stone) of which `count` has
 * any, or null when there is none. @param {(key: string) => number} count @returns {string|null}
 */
export function pickArrow(count) {
  for (const k of ARROW_PREFERENCE) if (Number(count(k)) > 0) return k;
  return null;
}

/**
 * @typedef {Object} BowDef
 * @property {number} drawS      seconds to full draw
 * @property {number} speed      the arrow's speed at full draw (m/s)
 * @property {number} spreadDeg  the half-angle of the random cone an arrow leaves in (degrees)
 * @property {number} gravity    the share of ITEM_GRAVITY its arrow falls by while a projectile
 */
/**
 * The bows (ToolDef.type 'bow'): the Crude Bow is a green sapling, quick to draw and wild; the Recurve Bow a fire-hardened
 * stave backed with sinew, a little slower to draw but half as fast again, flatter and true.
 * @type {Readonly<Record<string, Readonly<BowDef>>>}
 */
export const BOWS = Object.freeze({
  crude_bow: Object.freeze({ drawS: 1.0, speed: 28, spreadDeg: 3, gravity: 0.6 }),
  recurve_bow: Object.freeze({ drawS: 1.2, speed: 42, spreadDeg: 0.8, gravity: 0.5 }),
});

/** @param {string|null|undefined} key @returns {Readonly<BowDef>|null} the bow, or null for anything else */
export function bowOf(key) {
  return typeof key === 'string' && Object.hasOwn(BOWS, key) ? BOWS[key] : null;
}

/**
 * §100 the draw: Place held with a spear or a bow in hand draws back; released, it throws (or shoots) with the speed and
 * power of the draw: DRAW_FULL_S to full for a spear, the bow's own `drawS` for a bow. A tap gives DRAW_SPEED_MIN of the
 * speed and DRAW_POWER_MIN of the power; a full draw DRAW_SPEED_FULL and DRAW_POWER_FULL (G throws at once at throwOf's
 * own, 1 and 1). A bow's arrow at full draw flies at the bow's `speed` exactly (the same shares, scaled to it).
 */
export const DRAW_FULL_S = 1;
export const DRAW_SPEED_MIN = 0.4;
export const DRAW_SPEED_FULL = 1.15;
export const DRAW_POWER_MIN = 0.4;
export const DRAW_POWER_FULL = 1;
/** §100: how far the view closes in at full draw (a share of the field of view: the steadying of the aim). */
export const DRAW_ZOOM = 0.1;

/**
 * The draw after `heldS` seconds of Place: 0..1. @param {number} heldS @param {number} [fullS] seconds to full draw
 * (DRAW_FULL_S; a bow's `drawS`)
 */
export function drawFraction(heldS, fullS = DRAW_FULL_S) {
  const full = Number.isFinite(fullS) && fullS > 0 ? fullS : DRAW_FULL_S;
  return Number.isFinite(heldS) && heldS > 0 ? Math.min(1, heldS / full) : 0;
}

/**
 * The throw of a draw: `base` (throwOf, a spear's) scaled by the draw `f` (0..1).
 * @param {{ speed: number, power: number }} base @param {number} f @returns {{ speed: number, power: number }}
 */
export function drawnThrow(base, f) {
  const u = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  const speed = base.speed * (DRAW_SPEED_MIN + (DRAW_SPEED_FULL - DRAW_SPEED_MIN) * u);
  const power = base.power > 0 ? Math.round(base.power * (DRAW_POWER_MIN + (DRAW_POWER_FULL - DRAW_POWER_MIN) * u) * 10) / 10 : 0;
  return { speed: Math.round(speed * 100) / 100, power };
}

/**
 * A bow's shot of `arrowKey` at draw `f`: the speed (the bow's at full draw, the draw's shares of it below), the power
 * (the arrow's at full draw), the gravity share and the spread (radians, the cone's half-angle). An unknown bow shoots as
 * the Crude Bow, an unknown arrow as a Flint Arrow.
 * @param {string} bowKey @param {string|null} arrowKey @param {number} f
 * @returns {{ speed: number, power: number, gravity: number, spread: number }}
 */
export function bowShot(bowKey, arrowKey, f) {
  const bow = bowOf(bowKey) ?? BOWS.crude_bow;
  const arrow = arrowOf(arrowKey) ?? ARROWS[DEFAULT_ARROW];
  const t = drawnThrow({ speed: bow.speed / DRAW_SPEED_FULL, power: arrow.power }, f);
  return { speed: t.speed, power: t.power, gravity: bow.gravity, spread: (bow.spreadDeg * Math.PI) / 180 };
}

/**
 * A direction drawn uniformly over the cap of directions within `spread` radians of (dx, dy, dz): the bow's random cone.
 * spread ≤ 0 gives the aim itself. @param {number} dx @param {number} dy @param {number} dz @param {number} spread
 * @param {() => number} random [0, 1) @returns {[number, number, number]} a unit vector
 */
export function spreadDir(dx, dy, dz, spread, random) {
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  if (!(spread > 0)) return [ax, ay, az];
  // uniform over the spherical cap: cos θ uniform in [cos spread, 1], the turn about the aim uniform
  const cosT = 1 - random() * (1 - Math.cos(spread));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = random() * Math.PI * 2;
  // two unit vectors across the aim
  const [ux, uy, uz] = Math.abs(ay) < 0.9 ? cross(ax, ay, az, 0, 1, 0) : cross(ax, ay, az, 1, 0, 0);
  const ul = Math.hypot(ux, uy, uz) || 1;
  const e1x = ux / ul;
  const e1y = uy / ul;
  const e1z = uz / ul;
  const [e2x, e2y, e2z] = cross(ax, ay, az, e1x, e1y, e1z);
  const c = Math.cos(phi) * sinT;
  const sn = Math.sin(phi) * sinT;
  return [ax * cosT + e1x * c + e2x * sn, ay * cosT + e1y * c + e2y * sn, az * cosT + e1z * c + e2z * sn];
}

/** @returns {[number, number, number]} a × b */
function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/**
 * @typedef {Object} DrawDef  what a Place held with an item in hand draws
 * @property {boolean} bow       a bow: it shoots an arrow from the pack (or Creative's hotbar); else it throws itself
 * @property {string|null} shoots  what a throw throws (its own key); null for a bow (the arrow is chosen at the release)
 * @property {{ speed: number, power: number }|null} base   a throw's (drawnThrow); null for a bow (bowShot)
 * @property {number} fullS      seconds to full draw
 */

/**
 * §100: what a Place held with `key` in hand draws, or null: a spear draws itself back to throw it; a bow (ToolDef.type
 * 'bow') draws an arrow. An arrow in hand draws nothing: it needs a bow. @param {string|null} key @returns {DrawDef|null}
 */
export function drawOf(key) {
  if (!key) return null;
  const def = getItem(key);
  const type = def && def.tool ? def.tool.type : null;
  if (type === 'spear') return { bow: false, shoots: key, base: THROW_SPEAR, fullS: DRAW_FULL_S };
  if (type === 'bow') return { bow: true, shoots: null, base: null, fullS: (bowOf(key) ?? BOWS.crude_bow).drawS };
  return null;
}

/**
 * How an item flies when thrown. @param {string} key @returns {{ speed: number, power: number }}
 */
export function throwOf(key) {
  if (STONE_KEYS.includes(key)) return THROW_ROCK;
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
 * @property {number} [grav]        the share (§100) of ITEM_GRAVITY it falls by while a projectile (1; a bow's arrow less)
 * @property {boolean} ghost        Creative: the animation only
 * @property {number} spin          a turn (radians) for the drawing
 * @property {boolean} away        the player has been away from it since it was thrown or dropped (only then is it
 *   collected: a dropped stack is not picked straight back up)
 * @property {number} age           seconds it has lain loose (thrown, dropped or falling) in a loaded chunk; despawns at
 *   LOOSE_DESPAWN_S
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
 * @property {(item: LooseItem, why: 'hit'|'miss') => void} [onBreak] a real arrow broke (§100) — on the mob it hit (a roll of
 *   hitBreakP) or where it landed after a miss (missBreakP); it is gone
 * @property {(item: LooseItem, speed: number) => void} [onLand]      it hit the ground or a wall at this speed
 * @property {(x: number, y: number, z: number) => boolean} [burning]  the point is in a lit fire: a real item there burns
 * @property {(item: LooseItem, why: 'time'|'fire'|'cap'|'clear') => void} [onDespawn]  a real item despawned
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
      age: opts && opts.age > 0 ? opts.age : 0,
      grav: opts && opts.gravity > 0 ? opts.gravity : 1,
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
   * @param {{ block?: number, ghost?: boolean, power?: number, hold?: number, away?: boolean, gravity?: number }} [opts]
   *   `gravity` (§100): the share of ITEM_GRAVITY it falls by while it is a projectile (an arrow: ARROW_GRAVITY)
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
      // Despawns: a real item lying loose ages; one in a lit fire burns at once.
      if (!it.ghost && (it.mode === 'fly' || it.mode === 'rest')) {
        it.age += dt;
        const why = it.age >= LOOSE_DESPAWN_S ? 'time' : env.burning && env.burning(it.x, it.y, it.z) ? 'fire' : null;
        if (why) {
          if (env.onDespawn) env.onDespawn(it, why);
          continue;
        }
      }
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
    this._cap(env);
  }

  /** Past LOOSE_MAX real items, the oldest lying ones (by age) despawn. */
  _cap(env) {
    let real = 0;
    for (const it of this.list) if (!it.ghost) real++;
    if (real <= LOOSE_MAX) return;
    const lying = this.list.filter((it) => !it.ghost && (it.mode === 'fly' || it.mode === 'rest')).sort((a, b) => b.age - a.age);
    const gone = new Set(lying.slice(0, real - LOOSE_MAX));
    for (const it of gone) if (env && env.onDespawn) env.onDespawn(it, 'cap');
    this.list = this.list.filter((it) => !gone.has(it));
  }

  /**
   * Despawn the real items lying loose within `radius` of (x, y, z) (Infinity: everywhere). Drops flying to the player are
   * spared (they are already on their way into the pack); ghosts too.
   * @param {(item: LooseItem, why: 'clear') => void} [onDespawn]
   * @returns {number} how many went
   */
  despawnNear(x, y, z, radius = Infinity, onDespawn) {
    let n = 0;
    this.list = this.list.filter((it) => {
      if (it.ghost || it.mode === 'pop' || it.mode === 'home') return true;
      if (Number.isFinite(radius) && Math.hypot(it.x - x, it.y - y, it.z - z) > radius) return true;
      if (onDespawn) onDespawn(it, 'clear');
      n++;
      return false;
    });
    return n;
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
    it.vy += ITEM_GRAVITY * (it.power > 0 ? it.grav ?? 1 : 1) * dt; // §100: an arrow in flight drops less
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
          // §100: a real arrow survives a hit with its head's hitKeep
          if (!it.ghost && hitBreakP(it.s.k) > 0 && this._random() < hitBreakP(it.s.k)) {
            if (env.onBreak) env.onBreak(it, 'hit');
            return false;
          }
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
        if (this._missBreaks(it, env)) return false;
        it.vx = -it.vx * BOUNCE;
        it.power = 0;
      } else {
        it.x = nx;
      }
      const nz = it.z + it.vz * h;
      if (env.solid(it.x, it.y, nz + Math.sign(it.vz) * R)) {
        if (env.onLand && Math.abs(it.vz) > LAND_SPEED) env.onLand(it, Math.abs(it.vz));
        if (this._missBreaks(it, env)) return false;
        it.vz = -it.vz * BOUNCE;
        it.power = 0;
      } else {
        it.z = nz;
      }
      const ny = it.y + it.vy * h;
      if (it.vy <= 0 && env.solid(it.x, ny - R, it.z)) {
        const hitSpeed = -it.vy;
        it.y = Math.floor(ny - R) + 1 + R;
        if (this._missBreaks(it, env)) return false;
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

  /**
   * §100: a real arrow still a projectile has missed and struck the ground or a wall: it survives with its head's
   * missKeep (one roll, then it is spent). @returns {boolean} it broke (onBreak was told)
   */
  _missBreaks(it, env) {
    if (!(it.power > 0) || it.ghost) return false;
    const p = missBreakP(it.s.k);
    if (!(p > 0) || !(this._random() < p)) return false;
    if (env.onBreak) env.onBreak(it, 'miss');
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

  /** The real items for the save: `[{ k, n, d?, a?, x, y, z }]` (`a` its age in whole seconds when > 0; ghosts not saved). */
  serialize() {
    return this.list.filter((it) => !it.ghost).map((it) => {
      const o = /** @type {*} */ ({ k: it.s.k, n: it.s.n });
      if (it.s.d !== undefined) o.d = it.s.d;
      const a = Math.floor(it.age);
      if (a > 0) o.a = Math.min(a, LOOSE_DESPAWN_S);
      o.x = round3(it.x);
      o.y = round3(it.y);
      o.z = round3(it.z);
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
    for (const raw of list) {
      const o = raw && typeof raw.k === 'string' ? { ...raw, k: canonicalItemKey(raw.k) } : raw; // old tool names (§64)
      if (!o || typeof o.k !== 'string' || !getItem(o.k) || !Number.isInteger(o.n) || o.n < 1) continue;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
      /** @type {ItemStack} */
      const s = { k: o.k, n: o.n };
      if (Number.isInteger(o.d) && o.d >= 0) s.d = o.k === raw.k ? o.d : carriedWear(o.d, o.k); // §100: a Bow's wear, at most a Crude Bow's
      const age = Number.isFinite(o.a) && o.a > 0 ? Math.min(o.a, LOOSE_DESPAWN_S) : 0;
      const it = this._add(s, blockOf ? blockOf(o.k) : -1, o.x, o.y, o.z, 0, 0, 0, 'fly', { hold: 0, age });
      it.t = 0;
    }
    return this.list.length;
  }
}

/** @param {number} v */
function round3(v) {
  return Math.round(v * 1000) / 1000;
}
