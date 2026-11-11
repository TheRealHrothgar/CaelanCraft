// Caelancraft — Zombies: night mobs, cartoon shamblers in three kinds (walker, runner, alpha). See src/CONTRACTS.md §39
// and §61. Pure (no DOM, no three).
//
// A zombie is a body (physics.createBody, ZOMBIE_RADIUS × ZOMBIE_HEIGHT, ZOMBIE_MASS) driven by a small AI through the
// same stepPlayer physics as the player and the pigs, so it slides along honeycomb walls, hops one-cell ledges, swims,
// feels black holes and water currents (world.pullAt) and takes part in resolveBodies (bodies.js). It is a little
// narrower than the player, so it fits through the same one-cell, two-high doorways. The renderer draws it as a cartoon
// zombie: legs, a hunched torso, arms out in front and a big lolling head (zombieRenderer.js).
// v0.10 kinds: most are walkers; RUNNER_P of the natural spawns are runners (they sprint, and go down in 3 hits); and when a
// runner is in a horde (HORDE_SIZE zombies within HORDE_RADIUS) it may become the one alpha (12 hits, harder strikes, it
// rallies the walkers near it to full speed).
//
// Zombies only come out at night (natural spawning around the player, never near a campfire, never in a column the
// player has built in), shamble about, and chase a player they can see who is on foot and not far above them: straight
// at the player, hopping ledges, turning aside for a moment when something blocks the way, never off a drop of more
// than ZOMBIE_MAX_DROP cells and never into a campfire's safe zone (ZOMBIE_FIRE_FEAR: one inside turns straight away,
// and nobody inside is struck). Within ZOMBIE_REACH they lash out once a second: the player is knocked back (main
// flashes the screen red). There is no health: nothing dies.
// v0.11: daylight no longer burns them. A zombie under open sky by day is `daylit` and nerfed (CONTRACTS §65): a walker
// goes dormant (it stands still and wakes only for a player within WALKER_WAKE_RANGE, a hit, or an alpha near), a runner
// shambles at walker speed, an alpha slows and hits softer; walls it leaps are lower by day. The player knocks one out
// with its kind's hits (ZOMBIE_HITS for a walker); a blast near it, a black hole or
// being farther than ZOMBIE_DESPAWN_DIST away also ends it. Zombies are never saved: the per-world switch is.
import {
  ZOMBIE_MAX, ZOMBIE_RADIUS, ZOMBIE_HEIGHT, ZOMBIE_MASS, ZOMBIE_TARGET_RADIUS, ZOMBIE_CHASE_SPEED, ZOMBIE_TURN_RATE,
  ZOMBIE_SIGHT, ZOMBIE_CHASE_MAX_RISE, ZOMBIE_MAX_DROP, ZOMBIE_REACH, ZOMBIE_REACH_OVERLAP, ZOMBIE_ATTACK_COOLDOWN_S,
  ZOMBIE_HIT_PUSH, ZOMBIE_HIT_LIFT, ZOMBIE_HITS, ZOMBIE_KNOCKBACK, ZOMBIE_KNOCK_LIFT, ZOMBIE_HURT_S, ZOMBIE_KO_KNOCK,
  ZOMBIE_FIRE_FEAR, ZOMBIE_SPAWN_FIRE_CLEAR, ZOMBIE_SPAWN_MIN, ZOMBIE_SPAWN_MAX, ZOMBIE_SPAWN_INTERVAL_MIN_S,
  ZOMBIE_SPAWN_INTERVAL_MAX_S, ZOMBIE_SPAWN_TRIES, ZOMBIE_DESPAWN_DIST, ZOMBIE_SOUND_RANGE, WORLD_HEIGHT, PLAYER_HEIGHT,
  GRAVITY,
} from './config.js';
import { createBody, stepPlayer, findFreeY, isFreeAt, isSwimWater } from './physics.js';
import { hexToWorld, worldToHex } from './hex.js';
import { BLOCK, isSolid, isLiquid } from './blocks.js';
import { fireAhead, shoreYaw, isOpen, wrapAngle, SWIM_REAIM_S } from './pigs.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * @typedef {PlayerState & {
 *   id: number, yaw: number, targetYaw: number, mode: 'idle'|'walk'|'chase'|'avoid', timer: number,
 *   hurt: number, hits: number, walkPhase: number, groanIn: number, attackIn: number, swing: number,
 *   burn: number, smoking: boolean, exposed: boolean, sunIn: number, fireIn: number,
 *   fireX: number, fireY: number, fireZ: number,
 *   detour: number, detourYaw: number, side: 1|-1, stuck: number, tilt: number, wallSinceAim: boolean,
 *   kind: 'walker'|'runner'|'alpha', rallied: boolean, daylit: boolean, provoked: number, daylitFor: number, burrowAt: number,
 * }} Zombie
 * `walkPhase` advances with distance walked (the renderer swings the feet with it); `swing` counts down after an
 * attack (the renderer lurches the torso); `burn` stays 0 and `smoking` false (v0.11: daylight no longer burns);
 * `exposed` / `daylit` are true under open daylight; `provoked` counts down PROVOKE_S after a hit; `tilt` is the head's
 * fixed lean (radians), chosen at spawn. `fireX/Y/Z` is the
 * floor centre of the nearest campfire within ZOMBIE_FIRE_FEAR + FIRE_WATCH at the last fire check (fireX NaN: none),
 * which it steers around between checks.
 */

/**
 * @typedef {Object} ZombieWorld
 * @property {GetBlockFn} getBlock
 * @property {(x: number, z: number) => boolean} isLoaded   true when the chunk under world (x, z) is loaded
 * @property {PlayerState|null} [player]   the player to chase, attack and measure despawning from
 * @property {boolean} [isDay]             daylight (daynight.isDayTime): no spawning, and zombies under open sky burn
 * @property {(x: number, y: number, z: number, out: [number, number, number]) => [number, number, number]} [pullAt]
 *   black holes + water currents, sampled at feet + 0.5 like pigs
 * @property {() => boolean} [hasCampfires]  false while the world has no CAMPFIRE cell: the fire checks are skipped
 * @property {(x: number, y: number, z: number, maxDist: number, out: [number, number, number]) => number} [nearestFire]
 *   distance (≤ maxDist) to the nearest campfire's floor centre, written to `out`; Infinity when none is that close
 * @property {(q: number, r: number) => boolean} [isLoadedCell]   natural spawning needs this and the next two
 * @property {(q: number, r: number) => number} [groundHeight]    generated terrain height (top solid cell), −1 unloaded
 * @property {(q: number, y: number, r: number) => boolean} [isNaturalGround]   untouched terrain (World.isNaturalGround)
 * @property {(q: number, r: number) => boolean} [columnEdited]  when given: the player built in the column (no spawning there)
 */

/**
 * What one update did, for main's sounds and effects. The arrays are reused by the next update.
 * @typedef {Object} ZombieEvents
 * @property {Zombie[]} attacks     hit the player this frame (the player's velocity is already set)
 * @property {Zombie[]} groans      ambient groans due
 * @property {Zombie[]} ignited     started smouldering this frame (daylight)
 * @property {Zombie[]} burned      burned away this frame (removed)
 * @property {Zombie[]} knockedOut  knocked out by a campfire's last hit this frame (removed)
 * @property {Zombie[]} scorched    stepped into a campfire and hopped out (one hit)
 * @property {Zombie[]} spawned     placed by natural spawning this frame
 * @property {number} despawned     removed for being farther than ZOMBIE_DESPAWN_DIST from the player
 * @property {Zombie[]} alphas      v0.10: a runner in a horde became the alpha this frame
 * @property {Zombie[]} burrowed    v0.11 (§68): burrowed back into the ground by day this frame (removed)
 */

// ---- v0.10 kinds (CONTRACTS §61) -----------------------------------------------------------------------------------

/** The kinds of zombie: the common walker, the rarer runner, and the ultra-rare alpha a horde raises from a runner. */
export const ZOMBIE_KINDS = Object.freeze(['walker', 'runner', 'alpha']);
/**
 * Per kind: `chase` the forward input while chasing (×WALK_SPEED, or ×SPRINT_SPEED with `sprint`), `factor` a speed factor
 * on top (physics speedFactor), `hits` the hits that knock it out, `damage` the strike's damage multiplier (main scales
 * ZOMBIE_DAMAGE), `groan` the groan interval's multiplier, `drops` how many times main rolls its drops.
 */
export const KIND_STATS = Object.freeze({
  walker: Object.freeze({ chase: ZOMBIE_CHASE_SPEED, sprint: false, factor: 1, hits: ZOMBIE_HITS, damage: 1, groan: 1, drops: 1 }),
  runner: Object.freeze({ chase: 1, sprint: true, factor: 0.95, hits: 3, damage: 1, groan: 0.7, drops: 1 }),
  alpha: Object.freeze({ chase: 1, sprint: false, factor: 0.97, hits: 12, damage: 1.75, groan: 1.4, drops: 3 }),
});
/** A natural spawn is a runner with this chance (else a walker). */
export const RUNNER_P = 0.12;
/** Zombies (the runner too) within HORDE_RADIUS of a runner, at least HORDE_SIZE of them, are a horde … */
export const HORDE_RADIUS = 10;
export const HORDE_SIZE = 6;
/** … checked every HORDE_CHECK_S; then, with ALPHA_CONVERT_P per check, the runner becomes the alpha. At most ALPHA_MAX. */
export const HORDE_CHECK_S = 2;
export const ALPHA_CONVERT_P = 0.03;
export const ALPHA_MAX = 1;
/** Walkers within ALPHA_RALLY of an alpha chase at full walking speed (it rallies the horde). */
export const ALPHA_RALLY = 14;
/** A knock (blast) must be this many times ZOMBIE_KO_KNOCK to knock an alpha out at once. */
export const ALPHA_KO_KNOCK = 1.6;

/** An alpha's roar when a horde raises it (audio.playRecipe data). */
export const SOUND_ROAR = Object.freeze({
  dur: 1.1, gain: 0.55, layers: [
    { type: 'saw', f0: 120, f1: 70, lp: [900, 300], gain: 0.7, attack: 0.08, decay: 0.95, lfoHz: 9, lfoDepth: 0.25 },
    { type: 'saw', f0: 182, f1: 104, lp: 1200, gain: 0.35, attack: 0.1, decay: 0.9 },
    { type: 'noise', f0: 0, bp: [700, 250], q: 1.2, gain: 0.4, attack: 0.05, decay: 0.8 },
  ],
});

/** @param {*} zb @returns {'walker'|'runner'|'alpha'} */
export function kindOf(zb) {
  const k = zb && zb.kind;
  return k === 'runner' || k === 'alpha' ? k : 'walker';
}

/** @param {*} zb the kind's stats (KIND_STATS) */
export function statsOf(zb) {
  return KIND_STATS[kindOf(zb)];
}

// ---- v0.11 day and night, jumps (CONTRACTS §65) ---------------------------------------------------------------------

/**
 * v0.11 (CONTRACTS §68): a zombie in open daylight that is not chasing anyone burrows back into the ground after
 * DAWN_BURROW_MIN_S + up to DAWN_BURROW_RAND_S of it (its own draw, so a crowd goes one by one); time in shade or at night
 * winds its count back down. One chasing you stays until it gives up.
 */
export const DAWN_BURROW_MIN_S = 10;
export const DAWN_BURROW_RAND_S = 20;

/** A dormant walker wakes for a player this close (m), … */
export const WALKER_WAKE_RANGE = 4;
/** … and stays awake this long after a hit or a knock (s). */
export const PROVOKE_S = 20;
/** By day an alpha moves at this speed factor and strikes for this damage multiplier. */
export const DAY_ALPHA_FACTOR = 0.82;
export const DAY_ALPHA_DAMAGE = 1.25;
/** The highest wall (cells) each kind gets on top of, at night (or in shade) and in open daylight. */
export const CLIMB = Object.freeze({
  walker: Object.freeze({ night: 1, day: 1 }),
  runner: Object.freeze({ night: 2, day: 1 }),
  alpha: Object.freeze({ night: 4, day: 2 }),
});
/** A leap clears the wall by this much (cells). */
export const LEAP_MARGIN = 0.35;

/** @param {*} zb @returns {number} the highest wall it climbs now */
export function maxClimb(zb) {
  const c = CLIMB[kindOf(zb)];
  return zb && zb.daylit ? c.day : c.night;
}

/** @param {*} zb @returns {boolean} a walker in open daylight, not provoked and not rallied by an alpha */
export function isDormant(zb) {
  return kindOf(zb) === 'walker' && Boolean(zb.daylit) && !(zb.provoked > 0) && !zb.rallied;
}

/** @param {*} zb @returns {{ chase: number, sprint: boolean, factor: number }} how it chases now */
export function gaitOf(zb) {
  const st = statsOf(zb);
  const kind = kindOf(zb);
  if (zb && zb.daylit) {
    if (kind === 'runner') return { chase: ZOMBIE_CHASE_SPEED, sprint: false, factor: 1 }; // a shambler by day
    if (kind === 'alpha') return { chase: st.chase, sprint: false, factor: DAY_ALPHA_FACTOR };
  }
  return { chase: zb && zb.rallied && st.chase < 1 ? 1 : st.chase, sprint: st.sprint, factor: st.factor };
}

/** @param {*} zb @returns {number} its strike's damage multiplier now (main × ZOMBIE_DAMAGE) */
export function damageOf(zb) {
  return kindOf(zb) === 'alpha' && zb && zb.daylit ? DAY_ALPHA_DAMAGE : statsOf(zb).damage;
}

const TWO_PI = Math.PI * 2;
/** A zombie in daylight looks up its column this often (s); the first look after dusk → dawn is immediate. */
export const SUN_CHECK_S = 0.25;
/** A zombie looks for a campfire within ZOMBIE_FIRE_FEAR this often (s). */
export const FIRE_CHECK_S = 0.2;
/** The fire check also remembers the nearest campfire up to this far outside ZOMBIE_FIRE_FEAR, to steer around it. */
export const FIRE_WATCH = 2;
/** Turning away from a campfire lasts this long (s), walking at chase speed. */
export const AVOID_S = 0.8;
/** A chaser blocked ahead takes another heading for this long (s; plus up to DETOUR_RAND_S). */
export const DETOUR_S = 0.5;
export const DETOUR_RAND_S = 0.6;
/** A chaser pressing into a wall it cannot hop for this long (s) also takes a detour. */
export const STUCK_S = 0.25;
/** Bank searches per update, all zombies together (pigs.js shoreYaw; ~0.4 ms each in open sea). */
export const ZOMBIE_SHORE_SEARCHES = 1;
/** The torso's lurch after an attack lasts this long (s). */
export const SWING_S = 0.35;
/** A zombie steps forward only while its heading is within this of its yaw (rad), like a pig. */
export const MOVE_CONE = 1.2;
/** Below this horizontal speed (m/s) a zombie counts as standing and its feet settle back to straight. */
const LEG_SETTLE_SPEED = 0.2;
const LEG_SETTLE_RATE = 10;

/** Yaw that faces from (x, z) toward (tx, tz): yawToForward(yaw) = (−sin, −cos). */
function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}

/**
 * A zombie sound's volume for a listener: 1 at the listener, fading linearly to 0 at ZOMBIE_SOUND_RANGE (0 beyond).
 * @param {{ x: number, y: number, z: number }} zb
 * @param {{ x: number, y: number, z: number }} listener
 */
export function zombieVolume(zb, listener) {
  const d = Math.hypot(zb.x - listener.x, zb.y - listener.y, zb.z - listener.z);
  return d < ZOMBIE_SOUND_RANGE ? 1 - d / ZOMBIE_SOUND_RANGE : 0;
}

/**
 * The loudest zombieVolume among `list` (0 when none is in range). main plays each kind of zombie sound at most once a
 * frame at this volume, so a crowd igniting or burning out together at dawn is one voice, not one per zombie.
 * @param {Iterable<{ x: number, y: number, z: number }>} list
 * @param {{ x: number, y: number, z: number }} listener
 */
export function loudestVolume(list, listener) {
  let best = 0;
  for (const zb of list) best = Math.max(best, zombieVolume(zb, listener));
  return best;
}

/** No solid cell in column (q, r) from y0 up to the top of the world (getBlock is AIR above it). */
export function openSky(getBlock, q, y0, r) {
  for (let y = Math.max(0, y0); y < WORLD_HEIGHT; y++) if (isSolid(getBlock(q, y, r))) return false;
  return true;
}

/**
 * Ray (origin o, unit direction d) against a vertical cylinder (feet centre (cx, y0, cz), radius, height): the
 * distance where it enters (0 when the origin is inside), or −1 when it misses. Allocation-free.
 */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, y0, cz, radius, height) {
  const y1 = y0 + height;
  const px = ox - cx;
  const pz = oz - cz;
  const r2 = radius * radius;
  const c = px * px + pz * pz - r2;
  if (c <= 0 && oy >= y0 && oy <= y1) return 0;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = px * dx + pz * dz;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a; // the entry through the side
      const y = oy + dy * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (let k = 0; k < 2; k++) {
      const t = ((k === 0 ? y0 : y1) - oy) / dy;
      if (!(t >= 0 && t < best)) continue;
      const hx = px + dx * t;
      const hz = pz + dz * t;
      if (hx * hx + hz * hz <= r2) best = t;
    }
  }
  return best === Infinity ? -1 : best;
}

export class Zombies {
  /** @param {() => number} [rng] uniform [0, 1); Math.random by default */
  constructor(rng = Math.random) {
    /** @type {Zombie[]} */
    this.list = [];
    this._rng = rng;
    this._nextId = 1;
    this._enabled = true;
    /** bumped whenever the saved on/off switch changes (main autosaves on it) */
    this.switchVersion = 0;
    /** seconds to the next natural spawn attempt (counts only at night) */
    this._spawnIn = 6;
    /** @type {ZombieEvents} */
    this.events = { attacks: [], groans: [], ignited: [], burned: [], knockedOut: [], scorched: [], spawned: [], despawned: 0, alphas: [], burrowed: [] };
    /** seconds to the next horde check (v0.10) */
    this._hordeIn = HORDE_CHECK_S;
    /** @type {Set<object>} scratch: bodies some zombie stood on at the end of last frame */
    this._carriers = new Set();
    this._fires = true;
    this._shoreBudget = ZOMBIE_SHORE_SEARCHES;
    /** @type {[number, number, number]} */
    this._pull = [0, 0, 0];
    /** @type {[number, number, number]} */
    this._fire = [0, 0, 0];
    this._input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pullX: 0, pullY: 0, pullZ: 0 };
  }

  get size() {
    return this.list.length;
  }

  /** The saved per-world switch: off means no zombies at all (none spawn, summon refuses). */
  get enabled() {
    return this._enabled;
  }

  /**
   * Turn zombies on or off for this world; off removes every zombie. @returns {boolean} true when it changed
   */
  setEnabled(on) {
    const next = !!on;
    if (next === this._enabled) return false;
    this._enabled = next;
    this.switchVersion++;
    if (!next) this.clear();
    return true;
  }

  clear() {
    this.list.length = 0;
  }

  /**
   * Add a zombie of `kind` (default a walker; anything else is one) standing at feet (x, y, z) facing `yaw`.
   * @returns {Zombie|null} null when switched off, at ZOMBIE_MAX, or for a non-finite position
   */
  spawn(x, y, z, yaw = 0, kind = 'walker') {
    if (!this._enabled || this.list.length >= ZOMBIE_MAX || !Number.isFinite(x + y + z + yaw)) return null;
    const zb = /** @type {Zombie} */ (Object.assign(createBody(x, y, z, { radius: ZOMBIE_RADIUS, height: ZOMBIE_HEIGHT, mass: ZOMBIE_MASS }), {
      id: this._nextId++,
      yaw: wrapAngle(yaw),
      targetYaw: wrapAngle(yaw),
      mode: 'idle',
      timer: 0.5 + this._rng() * 2,
      hurt: 0,
      hits: 0,
      walkPhase: 0,
      groanIn: 3 + this._rng() * 8,
      attackIn: 0,
      swing: 0,
      burn: 0,
      smoking: false,
      exposed: false,
      sunIn: 0,
      fireIn: this._rng() * FIRE_CHECK_S,
      fireX: NaN,
      fireY: 0,
      fireZ: 0,
      detour: 0,
      detourYaw: 0,
      side: this._rng() < 0.5 ? 1 : -1,
      stuck: 0,
      tilt: (this._rng() * 2 - 1) * 0.28,
      wallSinceAim: false,
      kind: kindOf({ kind }),
      rallied: false,
      daylit: false,
      provoked: 0,
      daylitFor: 0,
      burrowAt: DAWN_BURROW_MIN_S + this._rng() * DAWN_BURROW_RAND_S,
    }));
    this.list.push(zb);
    return zb;
  }

  /** @returns {boolean} true when the zombie was in the list */
  remove(zb) {
    const i = this.list.indexOf(zb);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  /**
   * Natural spawning, then every zombie: despawn far away, freeze in unloaded chunks, daylight, AI, physics, campfire
   * scorch and attacks.
   * @param {number} dt
   * @param {ZombieWorld} world
   * @returns {ZombieEvents} this.events (reused)
   */
  update(dt, world) {
    const ev = this.events;
    ev.attacks.length = 0;
    ev.groans.length = 0;
    ev.ignited.length = 0;
    ev.burned.length = 0;
    ev.knockedOut.length = 0;
    ev.scorched.length = 0;
    ev.spawned.length = 0;
    ev.despawned = 0;
    ev.alphas.length = 0;
    ev.burrowed.length = 0;
    if (!(dt > 0)) return ev;
    const player = world.player ?? null;
    const getBlock = world.getBlock;
    const isDay = !!world.isDay;
    this._fires = world.hasCampfires ? !!world.hasCampfires() : true;
    this._shoreBudget = ZOMBIE_SHORE_SEARCHES;

    if (this._enabled && player && !isDay && world.groundHeight) {
      this._spawnIn -= dt;
      if (this._spawnIn <= 0) {
        this._spawnIn = ZOMBIE_SPAWN_INTERVAL_MIN_S + this._rng() * (ZOMBIE_SPAWN_INTERVAL_MAX_S - ZOMBIE_SPAWN_INTERVAL_MIN_S);
        this._spawnNear(player, world);
      }
    }

    const carriers = this._carriers;
    carriers.clear();
    for (const zb of this.list) if (zb.carrier) carriers.add(zb.carrier);
    const input = this._input;
    /** @type {boolean|null} the player inside a campfire's safe zone: looked up once, at the first strike due */
    let playerSafe = null;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const zb = this.list[i];
      if (zb.y < -16) {
        this.list.splice(i, 1);
        continue;
      }
      if (player && Math.hypot(zb.x - player.x, zb.z - player.z) > ZOMBIE_DESPAWN_DIST) {
        this.list.splice(i, 1);
        ev.despawned++;
        continue;
      }
      if (!world.isLoaded(zb.x, zb.z)) continue; // frozen until its chunk is back
      this._unstick(zb, getBlock);

      // Daylight: under open sky (and out of water) it is `daylit` — no longer burned (v0.11, CONTRACTS §65) but nerfed by
      // kind (dormant walkers, shambling runners, a tamer alpha); in shade, underground or at night it is at full strength.
      if (isDay) {
        zb.sunIn -= dt;
        if (zb.sunIn <= 0) {
          zb.sunIn = SUN_CHECK_S;
          const [q, r] = worldToHex(zb.x, zb.z);
          // Wet = swimming, or water at its feet or just under them (a swimmer bobbing up out of the surface).
          const wet = zb.inWater || isLiquid(getBlock(q, Math.floor(zb.y + 0.1), r)) || isLiquid(getBlock(q, Math.floor(zb.y - 0.5), r));
          zb.exposed = !wet && openSky(getBlock, q, Math.ceil(zb.y + ZOMBIE_HEIGHT), r);
        }
      } else {
        zb.exposed = false;
        zb.sunIn = 0;
      }
      zb.daylit = zb.exposed;
      zb.smoking = false;
      zb.burn = 0;
      if (zb.provoked > 0) zb.provoked = Math.max(0, zb.provoked - dt);
      // §68: out in the daylight with nobody to chase, it burrows away after its own while.
      if (zb.daylit && zb.mode !== 'chase') {
        zb.daylitFor += dt;
        if (zb.daylitFor >= zb.burrowAt) {
          this.list.splice(i, 1);
          ev.burrowed.push(zb);
          continue;
        }
      } else if (!zb.daylit) {
        zb.daylitFor = Math.max(0, zb.daylitFor - dt);
      }

      const canHop = !zb.carrier && !carriers.has(zb);
      const chasing = this._think(zb, dt, world, player, canHop);

      const dYaw = wrapAngle(zb.targetYaw - zb.yaw);
      const maxTurn = ZOMBIE_TURN_RATE * dt;
      zb.yaw = wrapAngle(zb.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));
      const near = chasing && player !== null && Math.hypot(player.x - zb.x, player.z - zb.z) < 0.35; // right under / on top
      const moving = zb.mode !== 'idle' && zb.hurt <= 0 && !near && Math.abs(wrapAngle(zb.targetYaw - zb.yaw)) < MOVE_CONE;
      const brisk = zb.mode === 'chase' || zb.mode === 'avoid';
      const gait = gaitOf(zb);
      // A walker chases at ZOMBIE_CHASE_SPEED (full walking speed near an alpha), a runner sprints (by day it shambles like
      // a walker), an alpha walks briskly (slower by day).
      input.forward = moving ? (brisk ? gait.chase : 1) : 0;
      input.sneak = moving && !brisk; // a wandering zombie shambles at sneak speed (1.31 m/s)
      input.sprint = moving && brisk && gait.sprint;
      input.speedFactor = brisk ? gait.factor : 1;
      // In water it always paddles up (it floats; pressing into a bank gives SWIM_EXIT_JUMP); on land it hops only a
      // one-cell ledge straight ahead with room for its height.
      const ledge = moving && zb.hitWall && canHop ? this._ledgeAhead(zb, getBlock) : 0;
      input.jump = zb.inWater || ledge === 1;
      // A higher wall (runners 2 at night, alphas 4 at night, 2 by day): one leap tall enough to clear it.
      if (ledge >= 2 && zb.onGround) {
        zb.vy = Math.sqrt(2 * -GRAVITY * (ledge + LEAP_MARGIN));
        zb.onGround = false;
      }
      input.yaw = zb.yaw;
      if (world.pullAt) {
        world.pullAt(zb.x, zb.y + 0.5, zb.z, this._pull);
        input.pullX = this._pull[0];
        input.pullY = this._pull[1];
        input.pullZ = this._pull[2];
      } else {
        input.pullX = 0;
        input.pullY = 0;
        input.pullZ = 0;
      }
      const x0 = zb.x;
      const z0 = zb.z;
      stepPlayer(zb, input, getBlock, dt);
      zb.sneaking = false;
      if (zb.hitWall) zb.wallSinceAim = true;
      // A chaser pressing into a wall it cannot hop turns aside after STUCK_S.
      if (chasing && moving && zb.onGround && zb.hitWall && !ledge) {
        zb.stuck += dt;
        if (zb.stuck >= STUCK_S) this._startDetour(zb);
      } else {
        zb.stuck = 0;
      }
      const stride = Math.hypot(zb.x - x0, zb.z - z0);
      zb.walkPhase = (zb.walkPhase + stride * 3.2) % TWO_PI;
      if (stride < LEG_SETTLE_SPEED * dt) {
        const straight = Math.round(zb.walkPhase / Math.PI) * Math.PI;
        zb.walkPhase += (straight - zb.walkPhase) * (1 - Math.exp(-LEG_SETTLE_RATE * dt));
      }

      // Standing in a campfire: hop out away from its centre; it counts as a hit (the last one knocks it out).
      const [cq, cr] = worldToHex(zb.x, zb.z);
      if (zb.hurt <= 0 && getBlock(cq, Math.floor(zb.y + 0.05), cr) === BLOCK.CAMPFIRE) {
        const [fx, fz] = hexToWorld(cq, cr);
        const res = this.hit(zb, fx, fz);
        if (res === 'ko') {
          ev.knockedOut.push(zb);
          continue;
        }
        if (res === 'hit') ev.scorched.push(zb);
      }
      if (zb.hurt > 0) zb.hurt = Math.max(0, zb.hurt - dt);
      if (zb.swing > 0) zb.swing = Math.max(0, zb.swing - dt);
      if (zb.attackIn > 0) zb.attackIn -= dt;

      // Nobody inside a campfire's safe zone is struck: not by a zombie turning away from a fire, not by one inside a
      // zone (it turns away now), and not a player inside one.
      if (player && zb.hurt <= 0 && zb.attackIn <= 0 && zb.mode !== 'avoid' && this._canReach(zb, player, getBlock)) {
        if (playerSafe === null) playerSafe = this._inSafeZone(player, world);
        if (!playerSafe && !this._fireFear(zb, world)) {
          this._strike(zb, player);
          ev.attacks.push(zb);
        }
      }

      zb.groanIn -= dt;
      if (zb.groanIn <= 0) {
        zb.groanIn = (zb.mode === 'chase' ? 3 + this._rng() * 5 : 6 + this._rng() * 10) * statsOf(zb).groan;
        ev.groans.push(zb);
      }
    }
    this._hordeIn -= dt;
    if (this._hordeIn <= 0) {
      this._hordeIn = HORDE_CHECK_S;
      this._hordeCheck(ev);
    }
    return ev;
  }

  /** A player the zombie goes after: on foot, within ZOMBIE_SIGHT, and not more than ZOMBIE_CHASE_MAX_RISE above it. */
  _canChase(zb, player) {
    if (!player || player.flying) return false;
    const dy = player.y - zb.y;
    if (dy > ZOMBIE_CHASE_MAX_RISE) return false;
    const d = Math.hypot(player.x - zb.x, dy, player.z - zb.z);
    // A dormant walker (in open daylight, not provoked, no alpha near) wakes only for a player within WALKER_WAKE_RANGE.
    if (isDormant(zb)) return d <= WALKER_WAKE_RANGE;
    return d <= ZOMBIE_SIGHT;
  }

  /**
   * AI: keep away from campfires, chase a visible player (straight at them, detouring when blocked), swim for the
   * shore when there is no one to chase, else idle ↔ wander like a pig.
   * @returns {boolean} true while chasing
   */
  _think(zb, dt, world, player, canHop) {
    const getBlock = world.getBlock;
    zb.timer -= dt;
    if (zb.detour > 0) zb.detour -= dt;
    // Campfires are safe zones: within ZOMBIE_FIRE_FEAR of one, walk straight away from it for AVOID_S. The check also
    // remembers the nearest fire a little farther out, which _safeAhead steers around until the next check.
    if (!this._fires) {
      zb.fireX = NaN;
    } else if (world.nearestFire) {
      zb.fireIn -= dt;
      if (zb.fireIn <= 0) {
        zb.fireIn = FIRE_CHECK_S;
        const d = world.nearestFire(zb.x, zb.y + 1, zb.z, ZOMBIE_FIRE_FEAR + FIRE_WATCH, this._fire);
        this._rememberFire(zb, d);
        if (d < ZOMBIE_FIRE_FEAR) this._startAvoid(zb);
      }
    }
    if (zb.mode === 'avoid') {
      // Walking away from a fire never takes it off a drop or into a wall: it stops there instead.
      // (Checked once it would step: while it turns, the cell ahead is still the fire side.)
      const facing = Math.abs(wrapAngle(zb.targetYaw - zb.yaw)) < MOVE_CONE;
      if (zb.timer > 0 && !(facing && zb.onGround && !this._safeAhead(zb, getBlock, canHop, false))) return false;
      zb.mode = 'idle';
      zb.timer = 0.3;
    }
    const chase = this._canChase(zb, player);
    if (zb.inWater) {
      if (chase) {
        zb.mode = 'chase';
        zb.targetYaw = yawToward(zb.x, zb.z, player.x, player.z);
        return true;
      }
      // Swimming with no one to chase: head for the nearest bank it can reach and climb, like a pig (pigs.js).
      const due = zb.mode !== 'walk' || zb.timer <= 0 || zb.timer > SWIM_REAIM_S;
      zb.mode = 'walk';
      if (due && this._shoreBudget > 0) {
        this._shoreBudget--;
        zb.timer = SWIM_REAIM_S;
        const shore = shoreYaw(getBlock, zb.x, zb.y, zb.z);
        if (shore !== null) zb.targetYaw = shore;
        else if (zb.wallSinceAim) zb.targetYaw = wrapAngle(zb.yaw + (this._rng() * 2 - 1) * Math.PI * 0.75);
        zb.wallSinceAim = false;
      }
      return false;
    }
    if (chase) {
      if (zb.mode !== 'chase') {
        zb.mode = 'chase';
        zb.groanIn = Math.min(zb.groanIn, 0.2 + this._rng() * 0.6); // it groans when it notices you
      }
      if (zb.detour > 0) {
        zb.targetYaw = zb.detourYaw;
      } else if (Math.hypot(player.x - zb.x, player.z - zb.z) >= 0.35) {
        zb.targetYaw = yawToward(zb.x, zb.z, player.x, player.z);
      }
      // Blocked ahead (a drop, a wall it cannot hop, a fire): take another heading for a moment. Checked whenever it
      // would step forward (within MOVE_CONE of its heading), so it never steps along an unsafe yaw while turning: a
      // new detour turns it further toward its side, until the way ahead is clear.
      if (zb.onGround && Math.abs(wrapAngle(zb.targetYaw - zb.yaw)) < MOVE_CONE && !this._safeAhead(zb, getBlock, canHop, true)) {
        this._startDetour(zb);
      }
      return true;
    }
    if (zb.mode === 'chase') {
      zb.mode = 'idle';
      zb.timer = 1 + this._rng() * 2;
      zb.detour = 0;
    }
    if (isDormant(zb)) {
      // Dormant by day: it stands where it is, swaying, until something wakes it.
      zb.mode = 'idle';
      zb.timer = Math.max(zb.timer, 0.5);
      return false;
    }
    if (zb.timer <= 0) {
      if (zb.mode === 'idle') {
        zb.mode = 'walk';
        zb.targetYaw = wrapAngle(zb.yaw + (this._rng() * 2 - 1) * Math.PI);
        zb.timer = 1.5 + this._rng() * 4;
      } else {
        zb.mode = 'idle';
        zb.timer = 1 + this._rng() * 4;
      }
    }
    if (zb.mode === 'walk' && zb.onGround && !this._safeAhead(zb, getBlock, canHop, false)) {
      zb.mode = 'idle';
      zb.timer = 0.5 + this._rng();
      zb.targetYaw = wrapAngle(zb.yaw + Math.PI * (0.5 + this._rng()));
    }
    return false;
  }

  /** Remember the fire `nearestFire` just wrote to this._fire (distance d), or forget it when d is Infinity. */
  _rememberFire(zb, d) {
    if (d === Infinity) {
      zb.fireX = NaN;
      return;
    }
    zb.fireX = this._fire[0];
    zb.fireY = this._fire[1];
    zb.fireZ = this._fire[2];
  }

  /** Turn straight away from the fire in this._fire: mode avoid for AVOID_S. */
  _startAvoid(zb) {
    zb.mode = 'avoid';
    zb.timer = AVOID_S;
    zb.detour = 0;
    const away = Math.hypot(zb.x - this._fire[0], zb.z - this._fire[2]) > 1e-6
      ? yawToward(this._fire[0], this._fire[2], zb.x, zb.z) : zb.yaw + Math.PI;
    zb.targetYaw = wrapAngle(away);
  }

  /** A body (a player) inside a campfire's safe zone: within ZOMBIE_FIRE_FEAR of one, measured from y + 1. */
  _inSafeZone(body, world) {
    if (!this._fires || !world.nearestFire) return false;
    return world.nearestFire(body.x, body.y + 1, body.z, ZOMBIE_FIRE_FEAR, this._fire) < ZOMBIE_FIRE_FEAR;
  }

  /** The zombie is inside a campfire's safe zone right now (a live look-up): it turns away from that fire. */
  _fireFear(zb, world) {
    if (!this._inSafeZone(zb, world)) return false;
    this._rememberFire(zb, 0);
    this._startAvoid(zb);
    return true;
  }

  /**
   * The next steps (0.8 along the yaw) lead deeper into the remembered campfire's safe zone: the point there is within
   * ZOMBIE_FIRE_FEAR of it (measured from y + 1, like nearestFire) and nearer to it than the zombie is now. Walking
   * out of a zone, or along its edge, is fine.
   */
  _intoFire(zb) {
    if (Number.isNaN(zb.fireX)) return false;
    const dy = zb.y + 1 - zb.fireY;
    const ax = zb.x - Math.sin(zb.yaw) * 0.8 - zb.fireX;
    const az = zb.z - Math.cos(zb.yaw) * 0.8 - zb.fireZ;
    const ahead = ax * ax + dy * dy + az * az;
    if (ahead >= ZOMBIE_FIRE_FEAR * ZOMBIE_FIRE_FEAR) return false;
    const hx = zb.x - zb.fireX;
    const hz = zb.z - zb.fireZ;
    return ahead < hx * hx + dy * dy + hz * hz;
  }

  /**
   * Turn 60°–120° toward the zombie's own side for DETOUR_S … DETOUR_S + DETOUR_RAND_S. Always the same side, so a
   * zombie blocked again and again works its way around the obstacle instead of dithering in front of it.
   */
  _startDetour(zb) {
    zb.detourYaw = wrapAngle(zb.yaw + zb.side * (Math.PI / 3) * (1 + this._rng()));
    zb.detour = DETOUR_S + this._rng() * DETOUR_RAND_S;
    zb.targetYaw = zb.detourYaw;
    zb.stuck = 0;
  }

  /** @returns {[number, number, number]} the cell (q, r) 0.8 ahead along the yaw, and the feet level fy */
  _aheadCell(zb) {
    const [q, r] = worldToHex(zb.x - Math.sin(zb.yaw) * 0.8, zb.z - Math.cos(zb.yaw) * 0.8);
    return [q, r, Math.floor(zb.y + 0.01)];
  }

  /**
   * The cell 0.8 ahead is fine to walk into: not water a wanderer would swim in (a chaser wades in after you), no
   * campfire within FIRE_MARGIN of the next steps (pigs.fireAhead), not deeper into a campfire's safe zone (_intoFire),
   * room for the body (open at the feet and the cell above, or a one-cell ledge with two open cells on it while
   * `canHop`), and a drop of at most ZOMBIE_MAX_DROP cells: ground within ZOMBIE_MAX_DROP + 1 cells below the feet
   * level (ground at fy − d is a drop of d − 1; water to land in counts for a chaser).
   */
  _safeAhead(zb, getBlock, canHop, chasing) {
    const [q, r, fy] = this._aheadCell(zb);
    if (!chasing && isSwimWater(getBlock, q, fy, r)) return false;
    if (this._fires && (fireAhead(getBlock, zb.x, zb.z, zb.yaw, fy) || this._intoFire(zb))) return false;
    if (isSolid(getBlock(q, fy, r))) return canHop && this._climbAt(zb, getBlock, q, fy, r) > 0;
    if (isSolid(getBlock(q, fy + 1, r))) return false; // a one-high gap: too low for a zombie
    for (let d = 1; d <= ZOMBIE_MAX_DROP + 1; d++) {
      const id = getBlock(q, fy - d, r);
      if (isSolid(id)) return true;
      if (isLiquid(id)) return chasing;
    }
    return false;
  }

  /**
   * The wall straight ahead it can get on top of: its height in cells (1 = a hop; up to `maxClimb(zb)`) when there is room
   * for a zombie on top and head room above itself, else 0.
   */
  _ledgeAhead(zb, getBlock) {
    const [q, r, fy] = this._aheadCell(zb);
    return this._climbAt(zb, getBlock, q, fy, r);
  }

  /** The height of the wall starting at cell (q, fy, r) when this zombie can climb it (≤ maxClimb, room on top), else 0. */
  _climbAt(zb, getBlock, q, fy, r) {
    const max = maxClimb(zb);
    let h = 0;
    while (h <= max && isSolid(getBlock(q, fy + h, r))) h++;
    if (h === 0 || h > max) return 0;
    if (!isOpen(getBlock(q, fy + h, r)) || !isOpen(getBlock(q, fy + h + 1, r))) return 0;
    // a leap (2 cells or more) needs head room over its own cell
    if (h >= 2) {
      const [mq, mr] = worldToHex(zb.x, zb.z);
      for (let k = 2; k <= h + 1; k++) if (!isOpen(getBlock(mq, fy + k, mr))) return 0;
    }
    return h;
  }

  /**
   * The player within ZOMBIE_REACH (horizontal), heights overlapping by more than ZOMBIE_REACH_OVERLAP, not riding this
   * zombie, and no solid cell between their chests.
   */
  _canReach(zb, player, getBlock) {
    // A player riding this zombie is out of its reach: the attack test runs before body resolution lifts a rider that
    // gravity sank a few millimetres into the zombie's top, so without this every rider counted as overlapping.
    if (player.carrier === zb) return false;
    const dx = player.x - zb.x;
    const dz = player.z - zb.z;
    if (dx * dx + dz * dz > ZOMBIE_REACH * ZOMBIE_REACH) return false;
    // Heights must overlap by more than ZOMBIE_REACH_OVERLAP (also covers the landing frame, before the ride link exists).
    if (!(zb.y < player.y + (player.height ?? PLAYER_HEIGHT) && player.y < zb.y + ZOMBIE_HEIGHT - ZOMBIE_REACH_OVERLAP)) return false;
    const cy = (zb.y + player.y) / 2 + 1.2;
    for (let k = 1; k <= 2; k++) {
      const [q, r] = worldToHex(zb.x + (dx * k) / 3, zb.z + (dz * k) / 3);
      if (isSolid(getBlock(q, Math.floor(cy), r))) return false;
    }
    return true;
  }

  /** Knock the player back from the zombie (no damage): ZOMBIE_HIT_PUSH away plus ZOMBIE_HIT_LIFT up. */
  _strike(zb, player) {
    let dx = player.x - zb.x;
    let dz = player.z - zb.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = -Math.sin(zb.yaw);
      dz = -Math.cos(zb.yaw);
    } else {
      dx /= d;
      dz /= d;
    }
    player.vx = dx * ZOMBIE_HIT_PUSH;
    player.vz = dz * ZOMBIE_HIT_PUSH;
    player.vy = Math.max(player.vy, ZOMBIE_HIT_LIFT);
    player.onGround = false;
    zb.attackIn = ZOMBIE_ATTACK_COOLDOWN_S;
    zb.swing = SWING_S;
  }

  /** A block placed into a zombie: lift it to the first free height within three cells (else leave it). */
  _unstick(zb, getBlock) {
    if (isFreeAt(getBlock, zb.x, zb.y, zb.z, ZOMBIE_RADIUS, ZOMBIE_HEIGHT)) return;
    const fy = findFreeY(getBlock, zb.x, zb.z, Math.floor(zb.y) + 1, 3, ZOMBIE_RADIUS, ZOMBIE_HEIGHT);
    if (fy !== null) {
      zb.y = fy;
      zb.vy = 0;
    }
  }

  /**
   * The player hits a zombie from a point: knockback away from it, a hop, a red flash and a short stun. Each hit adds
   * `power` to `hits` (v0.9, DESIGN-survival §9.3: a Survival tool's power; bare hands and Creative 1); reaching
   * ZOMBIE_HITS knocks it out (it is removed; main puffs it away). A power that is not a positive number counts as 1.
   * @param {number} [power=1]
   * @returns {'hit'|'ko'|null} null while it is still flashing from the last hit (the hit is ignored)
   */
  hit(zb, fromX, fromZ, power = 1) {
    if (zb.hurt > 0) return null;
    zb.provoked = PROVOKE_S; // v0.11: a hit wakes a dormant walker
    zb.hits += typeof power === 'number' && power > 0 && Number.isFinite(power) ? power : 1;
    if (zb.hits >= statsOf(zb).hits) {
      this.remove(zb);
      return 'ko';
    }
    let dx = zb.x - fromX;
    let dz = zb.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = Math.sin(zb.yaw); // backwards
      dz = Math.cos(zb.yaw);
    } else {
      dx /= d;
      dz /= d;
    }
    zb.vx = dx * ZOMBIE_KNOCKBACK;
    zb.vz = dz * ZOMBIE_KNOCKBACK;
    zb.vy = Math.max(zb.vy, ZOMBIE_KNOCK_LIFT);
    zb.onGround = false;
    zb.hurt = ZOMBIE_HURT_S;
    zb.attackIn = Math.max(zb.attackIn, ZOMBIE_HURT_S);
    zb.detour = 0;
    return 'hit';
  }

  /**
   * An impulse from block physics (a blast, a landing log): at least ZOMBIE_KO_KNOCK m/s knocks the zombie out (a
   * blast within about its radius); weaker ones fling it and count as a hit (unless it is still flashing).
   * @returns {'hit'|'ko'}
   */
  knock(zb, vx, vy, vz) {
    zb.provoked = PROVOKE_S;
    if (Math.hypot(vx, vy, vz) >= ZOMBIE_KO_KNOCK * (kindOf(zb) === 'alpha' ? ALPHA_KO_KNOCK : 1)) {
      this.remove(zb);
      return 'ko';
    }
    zb.vx += vx;
    zb.vy += vy;
    zb.vz += vz;
    zb.onGround = false;
    if (zb.hurt <= 0) {
      zb.hits++;
      zb.hurt = ZOMBIE_HURT_S;
      if (zb.hits >= statsOf(zb).hits) {
        this.remove(zb);
        return 'ko';
      }
    }
    return 'hit';
  }

  /**
   * Nearest zombie whose target cylinder (ZOMBIE_TARGET_RADIUS × ZOMBIE_HEIGHT at its feet) the ray (origin o, unit
   * direction d) enters within maxDist.
   * @returns {{ zombie: Zombie, distance: number }|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const zb of this.list) {
      const t = rayCylinder(ox, oy, oz, dx, dy, dz, zb.x, zb.y, zb.z, ZOMBIE_TARGET_RADIUS, ZOMBIE_HEIGHT);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = zb;
      }
    }
    return best ? { zombie: best, distance: bestT } : null;
  }

  /**
   * Whether a zombie may spawn standing on natural ground at column (q, r): loaded, its generated top cell untouched
   * and solid, two AIR cells above it (no water, fire, leaves or logs), no player edits in the column, no campfire
   * within ZOMBIE_SPAWN_FIRE_CLEAR and room for the body. @returns {number|null} the feet y, or null
   * @param {ZombieWorld} world
   */
  spawnHeightAt(world, q, r) {
    if (!world.isLoadedCell || !world.groundHeight || !world.isNaturalGround) return null;
    if (!world.isLoadedCell(q, r)) return null;
    const h = world.groundHeight(q, r);
    if (!(h >= 0 && h + 3 < WORLD_HEIGHT)) return null;
    if (!world.isNaturalGround(q, h, r)) return null;
    const getBlock = world.getBlock;
    if (getBlock(q, h + 1, r) !== BLOCK.AIR || getBlock(q, h + 2, r) !== BLOCK.AIR) return null;
    if (world.columnEdited && world.columnEdited(q, r)) return null;
    const [x, z] = hexToWorld(q, r);
    if (world.nearestFire && this._fires && world.nearestFire(x, h + 1, z, ZOMBIE_SPAWN_FIRE_CLEAR, this._fire) <= ZOMBIE_SPAWN_FIRE_CLEAR) return null;
    if (!isFreeAt(getBlock, x, h + 1, z, ZOMBIE_RADIUS, ZOMBIE_HEIGHT)) return null;
    return h + 1;
  }

  /**
   * v0.10 hordes (CONTRACTS §61): mark the walkers an alpha rallies; then, while fewer than ALPHA_MAX alphas are about, a
   * runner with at least HORDE_SIZE zombies (itself too) within HORDE_RADIUS becomes the alpha with ALPHA_CONVERT_P.
   * @param {ZombieEvents} ev
   */
  _hordeCheck(ev) {
    const list = this.list;
    let alphas = 0;
    for (const zb of list) {
      zb.rallied = false;
      if (zb.kind === 'alpha') alphas++;
    }
    if (alphas > 0) {
      for (const a of list) {
        if (a.kind !== 'alpha') continue;
        for (const zb of list) if (zb !== a && Math.hypot(zb.x - a.x, zb.y - a.y, zb.z - a.z) <= ALPHA_RALLY) zb.rallied = true;
      }
    }
    if (alphas >= ALPHA_MAX) return;
    for (const zb of list) {
      if (zb.kind !== 'runner') continue;
      let n = 0;
      for (const o of list) if (Math.hypot(o.x - zb.x, o.y - zb.y, o.z - zb.z) <= HORDE_RADIUS) n++;
      if (n < HORDE_SIZE) continue;
      if (this._rng() >= ALPHA_CONVERT_P) continue;
      zb.kind = 'alpha';
      zb.hits = 0;
      ev.alphas.push(zb);
      return;
    }
  }

  /**
   * One natural spawn attempt: 1 zombie (sometimes 2, the second near the first) on natural ground between
   * ZOMBIE_SPAWN_MIN and ZOMBIE_SPAWN_MAX (horizontally) from the player, within ZOMBIE_SPAWN_TRIES columns.
   * @param {PlayerState} player
   * @param {ZombieWorld} world
   * @returns {number} zombies placed
   */
  _spawnNear(player, world) {
    const want = this._rng() < 0.35 ? 2 : 1;
    let placed = 0;
    let ax = 0;
    let az = 0;
    for (let k = 0; k < ZOMBIE_SPAWN_TRIES && placed < want && this.list.length < ZOMBIE_MAX; k++) {
      const ang = this._rng() * TWO_PI;
      let x;
      let z;
      if (placed === 0) {
        const d = ZOMBIE_SPAWN_MIN + this._rng() * (ZOMBIE_SPAWN_MAX - ZOMBIE_SPAWN_MIN);
        x = player.x + Math.cos(ang) * d;
        z = player.z + Math.sin(ang) * d;
      } else {
        const d = 1.5 + this._rng() * 2;
        x = ax + Math.cos(ang) * d;
        z = az + Math.sin(ang) * d;
      }
      const [q, r] = worldToHex(x, z);
      const [cx, cz] = hexToWorld(q, r);
      const dh = Math.hypot(cx - player.x, cz - player.z);
      if (dh < ZOMBIE_SPAWN_MIN || dh > ZOMBIE_SPAWN_MAX + 1) continue;
      const fy = this.spawnHeightAt(world, q, r);
      if (fy === null) continue;
      const yaw = wrapAngle(yawToward(cx, cz, player.x, player.z) + (this._rng() * 2 - 1) * Math.PI * 0.5);
      const zb = this.spawn(cx, fy, cz, yaw, this._rng() < RUNNER_P ? 'runner' : 'walker');
      if (!zb) break;
      this.events.spawned.push(zb);
      if (placed === 0) {
        ax = cx;
        az = cz;
      }
      placed++;
    }
    return placed;
  }
}
