// Caelancraft — animals: cattle, sheep, horses and wolves (PURE). See src/CONTRACTS.md §69.
//
// An animal is a body (physics.createBody) driven through the same stepPlayer physics as the player, the pigs and the
// zombies, so it slides along honeycomb walls, hops one-cell ledges, swims and takes part in resolveBodies.
//
// They are hard to come by and wary: small herds appear rarely, far from the player, and a wild animal that notices
// the player (within its species' `notice` distance — much less when the player sneaks, more when sprinting) runs until
// it is `calm` distance away, and the herd runs with it. Getting one takes work:
//   - stalk it (sneak), or throw a spear or a dart (looseItems);
//   - hold out food it likes (`lure`): it does not flee and comes up to you (unless you sprint);
//   - set a Snare: an animal that steps into one is held for TRAP_HOLD_S; a baited snare draws animals from BAIT_RANGE.
// Cattle and sheep give meat, hide and wool (a sheep can also be sheared, and its fleece grows back). Horses and wolves
// are TAMED by feeding: a tame horse waits where it is left and can be ridden (`ride`), a tame wolf follows the player
// and bites the zombies near it. Tame animals never flee, never despawn and are saved; so is every other animal.
import { GRAVITY, WALK_SPEED, SPRINT_SPEED, WARY_SNEAK_FACTOR, WARY_SPRINT_FACTOR } from './config.js';
import { createBody, stepPlayer, findFreeY, isFreeAt, isSwimWater } from './physics.js';
import { hexToWorld, worldToHex } from './hex.js';
import { yawToForward } from './coords.js';
import { BLOCK, BIOME, isSolid } from './blocks.js';
import { fireAhead, shoreYaw, isOpen, wrapAngle, SWIM_REAIM_S } from './pigs.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

const TWO_PI = Math.PI * 2;

/** What the grazers come to: plants. */
export const PLANT_LURE = Object.freeze(['wild_tuber', 'honeyberries', 'tussock', 'cattail_root']);
/** What a wolf comes to: meat, raw or roast. */
export const MEAT_LURE = Object.freeze(['raw_pork', 'roast_pork', 'raw_beef', 'roast_beef', 'raw_mutton', 'roast_mutton']);

/**
 * The species. `radius` / `height` / `mass` the body; `health` hit points; `notice` how near (m) a walking player may
 * come before it runs, `fleeScale` (× WALK_SPEED, or × SPRINT_SPEED with `fleeSprint`) how fast; `turn` rad/s; `herd`
 * the natural group size [min, max]; `lure` the food it comes to and is fed; `tame` the feeds that tame it (0: never).
 */
export const SPECIES = Object.freeze({
  cow: Object.freeze({ name: 'Cow', radius: 0.44, height: 1.3, mass: 2.4, health: 10, notice: 9, fleeScale: 1.0, fleeSprint: false, turn: 3.2, herd: Object.freeze([2, 4]), lure: PLANT_LURE, tame: 0, voice: 'moo' }),
  sheep: Object.freeze({ name: 'Sheep', radius: 0.36, height: 0.95, mass: 0.9, health: 6, notice: 10, fleeScale: 1.1, fleeSprint: false, turn: 4, herd: Object.freeze([2, 4]), lure: PLANT_LURE, tame: 0, voice: 'baa' }),
  horse: Object.freeze({ name: 'Horse', radius: 0.44, height: 1.55, mass: 2.6, health: 12, notice: 13, fleeScale: 1.45, fleeSprint: true, turn: 3.5, herd: Object.freeze([2, 3]), lure: PLANT_LURE, tame: 3, voice: 'neigh' }),
  wolf: Object.freeze({ name: 'Wolf', radius: 0.3, height: 0.8, mass: 0.8, health: 8, notice: 11, fleeScale: 1.15, fleeSprint: true, turn: 5, herd: Object.freeze([2, 3]), lure: MEAT_LURE, tame: 3, voice: 'woof' }),
});
/** @typedef {'cow'|'sheep'|'horse'|'wolf'} AnimalKind */
export const ANIMAL_KINDS = Object.freeze(/** @type {AnimalKind[]} */ (Object.keys(SPECIES)));

/** At most this many animals in a world. */
export const ANIMAL_MAX = 24;
/** A sneaking player is noticed at this share of `notice`; a sprinting one from this much farther. */
export const SNEAK_NOTICE = WARY_SNEAK_FACTOR;
export const SPRINT_NOTICE = WARY_SPRINT_FACTOR;
/** It runs until the player is this many times `notice` away. */
export const CALM_FACTOR = 2.2;
/** A hit makes it (and its herd within HERD_ALARM) run for at least this long (s). */
export const HIT_FLEE_S = 6;
export const HERD_ALARM = 12;
/** Fed cattle and sheep stay calm (they do not flee) this long (s). */
export const FED_CALM_S = 40;
/** A lured animal comes from this far (m) and stops this close. */
export const LURE_RANGE = 11;
export const LURE_STOP = 2.2;
/** The hurt flash; hits during it are ignored. Knockback (m/s) and hop. */
export const ANIMAL_HURT_S = 0.5;
export const ANIMAL_KNOCKBACK = 4.5;
/** A sheared sheep's fleece is back after this long (s). Shearing gives SHEAR_WOOL[0]..[1] wool. */
export const SHEAR_REGROW_S = 300;
export const SHEAR_WOOL = Object.freeze([1, 2]);
/** A milked cow gives milk again after this long (s). */
export const MILK_REGROW_S = 240;

/** Snares: a caught animal is held this long (s), then breaks free and cannot be caught again for TRAP_IMMUNE_S. */
export const TRAP_HOLD_S = 90;
export const TRAP_IMMUNE_S = 20;
/** A baited snare draws calm animals from this many cells; they look for one every BAIT_CHECK_S. */
export const BAIT_RANGE = 7;
export const BAIT_CHECK_S = 2;

/** A tame wolf: follows beyond FOLLOW_NEAR, runs beyond FOLLOW_RUN, is brought back beyond FOLLOW_TELEPORT (m). */
export const FOLLOW_NEAR = 3.5;
export const FOLLOW_RUN = 9;
export const FOLLOW_TELEPORT = 32;
/** It goes for a zombie within WOLF_GUARD (m) of it, bites within WOLF_BITE_REACH every WOLF_BITE_S for WOLF_BITE power. */
export const WOLF_GUARD = 9;
export const WOLF_BITE_REACH = 1.25;
export const WOLF_BITE_S = 1;
export const WOLF_BITE = 2;
/** A tame horse left alone wanders at most this far (m) from where it was left. */
export const HOME_RANGE = 4;

/** Riding: the saddle is this far above the horse's feet; ridden, the horse's body is this much taller (the rider). */
export const SADDLE_Y = 1.15;
export const RIDER_HEIGHT = 1.25;
/** A ridden horse moves at × this of the walking (or, sprinting, the sprint) speed, and leaps this many cells on Space. */
export const RIDE_SCALE = 1.55;
export const RIDE_LEAP = 2.2;

/** Natural herds: checked every HERD_CHECK_S; a herd appears with HERD_CHANCE while fewer than HERD_TARGET wild animals
 * are within HERD_RADIUS of the player — HERD_MIN..HERD_MAX away, on natural grass. Beyond DESPAWN_DIST a wild one goes. */
export const HERD_CHECK_S = 60;
export const HERD_CHANCE = 0.45;
export const HERD_TARGET = 5;
export const HERD_RADIUS = 96;
export const HERD_MIN = 34;
export const HERD_MAX = 64;
export const HERD_TRIES = 10;
export const DESPAWN_DIST = 150;
/** Species weights by biome (index = BIOME id); a biome with no weights grows no herds. */
export const HERD_WEIGHTS = Object.freeze({
  [BIOME.PLAINS]: Object.freeze({ cow: 3, sheep: 3, horse: 1.5 }),
  [BIOME.FOREST]: Object.freeze({ wolf: 2, sheep: 1, cow: 1 }),
  [BIOME.MOUNTAINS]: Object.freeze({ sheep: 3, wolf: 1 }),
  [BIOME.SNOWY]: Object.freeze({ wolf: 2, sheep: 0.5 }),
});

/** The voices and the snare's snap (audio.playRecipe data). Gentle, short, never startling. */
export const SOUNDS = Object.freeze({
  moo: Object.freeze({ dur: 0.9, gain: 0.3, layers: [{ type: 'saw', f0: 150, f1: 118, lp: 620, gain: 0.7, attack: 0.12, decay: 0.75 }, { type: 'sine', f0: 300, f1: 236, gain: 0.25, attack: 0.12, decay: 0.7 }] }),
  baa: Object.freeze({ dur: 0.55, gain: 0.26, layers: [{ type: 'saw', f0: 430, f1: 380, lp: 1500, gain: 0.6, attack: 0.04, decay: 0.48, lfoHz: 13, lfoDepth: 0.55 }] }),
  neigh: Object.freeze({ dur: 0.8, gain: 0.26, layers: [{ type: 'saw', f0: 880, f1: 420, lp: 2200, gain: 0.55, attack: 0.05, decay: 0.7, lfoHz: 11, lfoDepth: 0.5 }] }),
  woof: Object.freeze({ dur: 0.22, gain: 0.3, layers: [{ type: 'saw', f0: 260, f1: 170, lp: 900, gain: 0.7, attack: 0.01, decay: 0.18 }, { type: 'noise', f0: 0, bp: 700, q: 1.5, gain: 0.3, attack: 0.01, decay: 0.12 }] }),
  whine: Object.freeze({ dur: 0.35, gain: 0.22, layers: [{ type: 'sine', f0: 700, f1: 980, gain: 0.6, attack: 0.05, decay: 0.28 }] }),
  snare: Object.freeze({ dur: 0.18, gain: 0.4, layers: [{ type: 'noise', f0: 0, hp: 1800, gain: 0.7, attack: 0.002, decay: 0.08 }, { type: 'sine', f0: 520, f1: 240, gain: 0.4, attack: 0.002, decay: 0.14 }] }),
  tame: Object.freeze({ dur: 0.5, gain: 0.25, layers: [{ type: 'sine', f0: 523, f1: 523, gain: 0.5, attack: 0.01, decay: 0.2 }, { type: 'sine', f0: 784, f1: 784, gain: 0.5, attack: 0.01, decay: 0.3, delay: 0.14 }] }),
});

/**
 * @typedef {PlayerState & {
 *   id: number, kind: AnimalKind, yaw: number, targetYaw: number, mode: 'idle'|'walk'|'flee'|'lure'|'bait'|'follow'|'hunt',
 *   timer: number, hurt: number, health: number, walkPhase: number, voiceIn: number,
 *   tamed: boolean, trust: number, calm: number, shorn: number, milked: number, sitting: boolean, ridden: boolean,
 *   homeX: number, homeZ: number, trapped: number, trapT: number, trapCell: [number, number, number]|null, immune: number,
 *   baitIn: number, baitX: number, baitZ: number, biteIn: number, side: 1|-1, speedScale: number, wallSinceAim: boolean,
 * }} Animal
 */

/**
 * @typedef {Object} AnimalWorld
 * @property {GetBlockFn} getBlock
 * @property {(x: number, z: number) => boolean} isLoaded
 * @property {PlayerState|null} [player]      whom the wild ones run from and the tame wolves follow (null: nobody)
 * @property {string|null} [heldKey]          the item in the player's hand (a lure?)
 * @property {ReadonlyArray<PlayerState>} [threats]  the zombies a tame wolf goes for
 * @property {(x: number, y: number, z: number, out: [number, number, number]) => *} [pullAt]
 * @property {() => boolean} [hasCampfires]
 * @property {(q: number, r: number) => number} [getBiome]            natural herds need this and the next three
 * @property {(q: number, r: number) => number} [groundHeight]
 * @property {(q: number, y: number, r: number) => boolean} [isNaturalGround]
 * @property {(q: number, r: number) => boolean} [isLoadedCell]
 */

/**
 * What one update did, for main's sounds, blocks and effects. The arrays are reused by the next update.
 * @typedef {Object} AnimalEvents
 * @property {Animal[]} voices      ambient calls due
 * @property {Animal[]} startled    started to run from the player this frame
 * @property {{ animal: Animal, cell: [number, number, number] }[]} caught   stepped into a snare (main springs the block)
 * @property {{ cell: [number, number, number], escaped: boolean }[]} freed  a snare let go (main resets the block)
 * @property {{ wolf: Animal, target: * }[]} bites   a tame wolf bit a threat (main applies it)
 * @property {Animal[]} spawned     placed by natural spawning
 * @property {number} despawned
 */

/** Ray (origin o, unit direction d) against an upright cylinder at feet (cx, y0, cz): entry distance, or −1. */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, y0, cz, radius, height) {
  const px = ox - cx;
  const pz = oz - cz;
  const y1 = y0 + height;
  const r2 = radius * radius;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = px * dx + pz * dz;
    const disc = b * b - a * (px * px + pz * pz - r2);
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = oy + dy * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (const yc of [y0, y1]) {
      const t = (yc - oy) / dy;
      if (!(t >= 0 && t < best)) continue;
      const hx = px + dx * t;
      const hz = pz + dz * t;
      if (hx * hx + hz * hz <= r2) best = t;
    }
  }
  return best === Infinity ? -1 : best;
}

/** Yaw that faces from (x, z) toward (tx, tz): yawToForward(yaw) = (−sin, −cos). */
function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}

/** @param {*} kind @returns {kind is AnimalKind} */
export function isAnimalKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(SPECIES, kind);
}

/** How near the player may come before `a` runs (m): its species' `notice`, less for a sneaker, more for a sprinter. */
export function noticeRange(a, player) {
  const n = SPECIES[a.kind].notice;
  if (player.sneaking) return n * SNEAK_NOTICE;
  if (player.sprinting) return n * SPRINT_NOTICE;
  return n;
}

export class Animals {
  /** @param {() => number} [rng] uniform [0, 1) */
  constructor(rng = Math.random) {
    /** @type {Animal[]} */
    this.list = [];
    this._rng = rng;
    this._nextId = 1;
    this._spawnIn = HERD_CHECK_S / 3;
    /** @type {AnimalEvents} */
    this.events = { voices: [], startled: [], caught: [], freed: [], bites: [], spawned: [], despawned: 0 };
    /** @type {[number, number, number]} */
    this._pull = [0, 0, 0];
    this._fires = true;
    this._input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pullX: 0, pullY: 0, pullZ: 0, speedFactor: 1 };
  }

  get size() {
    return this.list.length;
  }

  clear() {
    this.list.length = 0;
  }

  /**
   * Add an animal of `kind` standing at feet (x, y, z). @returns {Animal|null} null at ANIMAL_MAX, for an unknown kind or
   * a non-finite position
   */
  spawn(kind, x, y, z, yaw = 0) {
    if (!isAnimalKind(kind) || this.list.length >= ANIMAL_MAX || !Number.isFinite(x + y + z + yaw)) return null;
    const sp = SPECIES[kind];
    const a = /** @type {Animal} */ (Object.assign(createBody(x, y, z, { radius: sp.radius, height: sp.height, mass: sp.mass }), {
      id: this._nextId++,
      kind,
      yaw: wrapAngle(yaw),
      targetYaw: wrapAngle(yaw),
      mode: 'idle',
      timer: 0.5 + this._rng() * 2,
      hurt: 0,
      health: sp.health,
      walkPhase: 0,
      voiceIn: 6 + this._rng() * 20,
      tamed: false,
      trust: 0,
      calm: 0,
      shorn: 0,
      milked: 0,
      sitting: false,
      ridden: false,
      homeX: x,
      homeZ: z,
      trapped: 0,
      trapT: 0,
      trapCell: null,
      immune: 0,
      baitIn: this._rng() * BAIT_CHECK_S,
      baitX: NaN,
      baitZ: NaN,
      biteIn: 0,
      side: this._rng() < 0.5 ? 1 : -1,
      speedScale: 1,
      wallSinceAim: false,
    }));
    this.list.push(a);
    return a;
  }

  /** @returns {boolean} true when it was in the list */
  remove(a) {
    const i = this.list.indexOf(a);
    if (i < 0) return false;
    if (a.trapCell) this.events.freed.push({ cell: a.trapCell, escaped: false });
    a.trapCell = null;
    this.list.splice(i, 1);
    return true;
  }

  /**
   * Natural herds, then every animal: despawn, snares, AI, physics.
   * @param {number} dt
   * @param {AnimalWorld} world
   * @returns {AnimalEvents} this.events (reused; `freed` may already hold what remove() queued since the last update)
   */
  update(dt, world) {
    const ev = this.events;
    ev.voices.length = 0;
    ev.startled.length = 0;
    ev.caught.length = 0;
    ev.bites.length = 0;
    ev.spawned.length = 0;
    ev.despawned = 0;
    const queued = ev.freed.splice(0);
    if (!(dt > 0)) {
      for (const f of queued) ev.freed.push(f);
      return ev;
    }
    for (const f of queued) ev.freed.push(f);
    const player = world.player ?? null;
    const getBlock = world.getBlock;
    this._fires = world.hasCampfires ? !!world.hasCampfires() : true;

    if (player && world.groundHeight && world.getBiome) {
      this._spawnIn -= dt;
      if (this._spawnIn <= 0) {
        this._spawnIn = HERD_CHECK_S;
        this._spawnHerd(player, world);
      }
    }

    const input = this._input;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      if (a.y < -16) {
        this.remove(a);
        continue;
      }
      if (player && !a.tamed && !(a.trapped > 0) && Math.hypot(a.x - player.x, a.z - player.z) > DESPAWN_DIST) {
        this.list.splice(i, 1);
        ev.despawned++;
        continue;
      }
      if (!world.isLoaded(a.x, a.z)) continue; // frozen until its chunk is back
      if (a.hurt > 0) a.hurt = Math.max(0, a.hurt - dt);
      if (a.calm > 0) a.calm = Math.max(0, a.calm - dt);
      if (a.shorn > 0) a.shorn = Math.max(0, a.shorn - dt);
      if (a.milked > 0) a.milked = Math.max(0, a.milked - dt);
      if (a.immune > 0) a.immune = Math.max(0, a.immune - dt);
      if (a.biteIn > 0) a.biteIn -= dt;
      a.voiceIn -= dt;
      if (a.voiceIn <= 0) {
        a.voiceIn = 14 + this._rng() * 30;
        ev.voices.push(a);
      }
      if (a.ridden) continue; // ride() moves it

      // Held by a snare: it struggles on the spot until the time is up, or the snare is gone.
      if (a.trapped > 0) {
        a.trapped -= dt;
        a.trapT += dt;
        const c = /** @type {[number, number, number]} */ (a.trapCell);
        const gone = a.trapT > 0.25 && getBlock(c[0], c[1], c[2]) !== BLOCK.SNARE_SPRUNG;
        if (a.trapped <= 0 || gone) {
          this._release(a, !gone);
        } else {
          const [cx, cz] = hexToWorld(c[0], c[2]);
          a.x = cx;
          a.z = cz;
          a.vx = 0;
          a.vz = 0;
          a.walkPhase = (a.walkPhase + dt * 9) % TWO_PI; // it struggles
          a.yaw = wrapAngle(a.yaw + Math.sin(a.trapT * 5) * dt * 1.5);
          continue;
        }
      }

      this._unstick(a, getBlock);
      const sp = SPECIES[a.kind];
      const gait = this._think(a, dt, world, player, ev);

      const dYaw = wrapAngle(a.targetYaw - a.yaw);
      const maxTurn = sp.turn * dt;
      a.yaw = wrapAngle(a.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));
      const moving = gait !== 'stand' && a.hurt <= 0.25 && Math.abs(wrapAngle(a.targetYaw - a.yaw)) < 1.2;
      input.forward = moving ? 1 : 0;
      input.sneak = moving && gait === 'amble';
      input.sprint = moving && gait === 'run' && sp.fleeSprint;
      a.speedScale = gait === 'run' ? sp.fleeScale : gait === 'trot' ? 0.75 : 1;
      const ledge = moving && a.hitWall && this._ledgeAhead(a, getBlock);
      input.jump = a.inWater || ledge;
      input.yaw = a.yaw;
      if (world.pullAt) {
        world.pullAt(a.x, a.y + 0.5, a.z, this._pull);
        input.pullX = this._pull[0];
        input.pullY = this._pull[1];
        input.pullZ = this._pull[2];
      } else {
        input.pullX = 0;
        input.pullY = 0;
        input.pullZ = 0;
      }
      const x0 = a.x;
      const z0 = a.z;
      stepPlayer(a, input, getBlock, dt);
      a.sneaking = false;
      a.sprinting = false;
      if (a.hitWall) a.wallSinceAim = true;
      this._stride(a, x0, z0, dt);

      // A snare underfoot catches a wild animal.
      if (!a.tamed && a.immune <= 0) {
        const [q, r] = worldToHex(a.x, a.z);
        const y = Math.floor(a.y + 0.05);
        const id = getBlock(q, y, r);
        if (id === BLOCK.SNARE || id === BLOCK.SNARE_BAITED) {
          a.trapped = TRAP_HOLD_S;
          a.trapT = 0;
          a.trapCell = [q, y, r];
          a.mode = 'idle';
          ev.caught.push({ animal: a, cell: [q, y, r] });
        }
      }
    }
    return ev;
  }

  /** The legs: walkPhase advances with the distance walked and settles straight when standing. */
  _stride(a, x0, z0, dt) {
    const stride = Math.hypot(a.x - x0, a.z - z0);
    a.walkPhase = (a.walkPhase + stride * (a.kind === 'horse' || a.kind === 'cow' ? 2.4 : 3.6)) % TWO_PI;
    if (stride < 0.2 * dt) {
      const straight = Math.round(a.walkPhase / Math.PI) * Math.PI;
      a.walkPhase += (straight - a.walkPhase) * (1 - Math.exp(-10 * dt));
    }
  }

  /** A snare lets go: the animal runs (when it broke free by itself) and cannot be caught for TRAP_IMMUNE_S. */
  _release(a, escaped) {
    if (a.trapCell) this.events.freed.push({ cell: a.trapCell, escaped });
    a.trapCell = null;
    a.trapped = 0;
    a.immune = TRAP_IMMUNE_S;
    if (!a.tamed) {
      a.mode = 'flee';
      a.timer = HIT_FLEE_S;
      a.targetYaw = wrapAngle(a.yaw + Math.PI * (0.5 + this._rng()));
    }
  }

  /**
   * AI. @returns {'stand'|'amble'|'trot'|'walk'|'run'} how it moves this frame
   * @param {Animal} a @param {number} dt @param {AnimalWorld} world @param {PlayerState|null} player @param {AnimalEvents} ev
   */
  _think(a, dt, world, player, ev) {
    const getBlock = world.getBlock;
    a.timer -= dt;
    if (a.inWater) return this._swim(a, getBlock);
    if (a.tamed) return a.kind === 'wolf' ? this._tameWolf(a, dt, world, player, ev) : this._tameHorse(a, getBlock);

    const p = player && !player.flying ? player : null;
    const d = p ? Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) : Infinity;
    const sp = SPECIES[a.kind];
    const lured = p !== null && !p.sprinting && typeof world.heldKey === 'string' && sp.lure.includes(world.heldKey);

    // Running: until the player is far enough (and any hit's time is up).
    if (a.mode === 'flee') {
      const far = d > sp.notice * CALM_FACTOR;
      if ((far && a.timer <= 0) || (lured && a.timer <= 0 && d > LURE_STOP)) {
        a.mode = 'idle';
        a.timer = 1 + this._rng() * 2;
      } else {
        if (p && d < sp.notice * CALM_FACTOR) this._aimAway(a, p.x, p.z);
        this._steerSafe(a, getBlock);
        return 'run';
      }
    }
    // The player comes too near: run (unless it is fed, lured, or the player holds its food).
    if (p && a.calm <= 0 && !lured && d < noticeRange(a, p)) {
      this._startle(a, p.x, p.z, ev);
      return 'run';
    }
    // Lured: it comes up to the food in the player's hand.
    if (lured && d <= LURE_RANGE) {
      a.mode = 'lure';
      a.targetYaw = yawToward(a.x, a.z, /** @type {PlayerState} */ (p).x, /** @type {PlayerState} */ (p).z);
      if (d <= LURE_STOP) return 'stand';
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'trot';
    }
    if (a.mode === 'lure') {
      a.mode = 'idle';
      a.timer = 1;
    }
    // A baited snare nearby: it wanders over.
    a.baitIn -= dt;
    if (a.baitIn <= 0) {
      a.baitIn = BAIT_CHECK_S;
      this._findBait(a, getBlock);
    }
    if (Number.isFinite(a.baitX) && a.immune <= 0) {
      a.mode = 'bait';
      a.targetYaw = yawToward(a.x, a.z, a.baitX, a.baitZ);
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'amble';
    }
    if (a.mode === 'bait') {
      a.mode = 'idle';
      a.timer = 1;
    }
    return this._wander(a, getBlock);
  }

  /** idle ↔ wander, like a pig; a walker stops at an edge, water, a wall or a fire. */
  _wander(a, getBlock) {
    if (a.timer <= 0) {
      if (a.mode === 'idle') {
        a.mode = 'walk';
        a.targetYaw = wrapAngle(a.yaw + (this._rng() * 2 - 1) * Math.PI);
        // The herd keeps together: half the time it heads for the nearest of its kind that has drifted away.
        const mate = this._nearestKin(a);
        if (mate && this._rng() < 0.5 && Math.hypot(mate.x - a.x, mate.z - a.z) > 5) a.targetYaw = yawToward(a.x, a.z, mate.x, mate.z);
        a.timer = 1.5 + this._rng() * 4;
      } else {
        a.mode = 'idle';
        a.timer = 2 + this._rng() * 6;
      }
    }
    if (a.mode !== 'walk') return 'stand';
    if (a.onGround && !this._safeAhead(a, getBlock)) {
      a.mode = 'idle';
      a.timer = 0.5 + this._rng();
      a.targetYaw = wrapAngle(a.yaw + Math.PI * (0.5 + this._rng()));
      return 'stand';
    }
    return 'amble';
  }

  /** Swimming: head for the nearest bank it can climb, like a pig. */
  _swim(a, getBlock) {
    const due = a.mode !== 'walk' || a.timer <= 0 || a.timer > SWIM_REAIM_S;
    a.mode = 'walk';
    if (due) {
      a.timer = SWIM_REAIM_S;
      const shore = shoreYaw(getBlock, a.x, a.y, a.z);
      if (shore !== null) a.targetYaw = shore;
      else if (a.wallSinceAim) a.targetYaw = wrapAngle(a.yaw + (this._rng() * 2 - 1) * Math.PI * 0.75);
      a.wallSinceAim = false;
    }
    return 'walk';
  }

  /** A tame horse left alone: it grazes within HOME_RANGE of where it was left. */
  _tameHorse(a, getBlock) {
    const dh = Math.hypot(a.homeX - a.x, a.homeZ - a.z);
    if (dh > HOME_RANGE) {
      a.mode = 'walk';
      a.timer = 1;
      a.targetYaw = yawToward(a.x, a.z, a.homeX, a.homeZ);
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'amble';
    }
    return this._wander(a, getBlock);
  }

  /** A tame wolf: sits where told; else goes for a zombie near it, or keeps by the player. */
  _tameWolf(a, dt, world, player, ev) {
    const getBlock = world.getBlock;
    if (a.sitting || !player) {
      a.mode = 'idle';
      return 'stand';
    }
    const dp = Math.hypot(player.x - a.x, player.z - a.z);
    if (dp > FOLLOW_TELEPORT) {
      // Left behind: it turns up beside the player, where there is room.
      const [q, r] = worldToHex(player.x + 1.2 * a.side, player.z);
      const [x, z] = hexToWorld(q, r);
      const fy = findFreeY(getBlock, x, z, Math.max(0, Math.floor(player.y)), 2, a.radius, a.height);
      if (fy !== null) {
        a.x = x;
        a.y = fy;
        a.z = z;
        a.vx = a.vy = a.vz = 0;
      }
      return 'stand';
    }
    // A zombie near: go for it.
    let target = null;
    let best = WOLF_GUARD;
    for (const t of world.threats ?? []) {
      const d = Math.hypot(t.x - a.x, t.y - a.y, t.z - a.z);
      if (d < best && Math.hypot(t.x - player.x, t.z - player.z) < WOLF_GUARD * 2) {
        best = d;
        target = t;
      }
    }
    if (target) {
      a.mode = 'hunt';
      a.targetYaw = yawToward(a.x, a.z, target.x, target.z);
      if (best <= WOLF_BITE_REACH) {
        if (a.biteIn <= 0) {
          a.biteIn = WOLF_BITE_S;
          ev.bites.push({ wolf: a, target });
        }
        return 'stand';
      }
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'run';
    }
    if (dp > FOLLOW_NEAR) {
      a.mode = 'follow';
      a.targetYaw = yawToward(a.x, a.z, player.x, player.z);
      if (a.onGround && !this._safeAhead(a, getBlock)) return 'stand';
      return dp > FOLLOW_RUN ? 'run' : 'walk';
    }
    a.mode = 'idle';
    a.targetYaw = yawToward(a.x, a.z, player.x, player.z);
    return 'stand';
  }

  /** It notices the player and runs; the herd within HERD_ALARM runs with it. */
  _startle(a, fromX, fromZ, ev, seconds = 0) {
    for (const o of this.list) {
      if (o.kind !== a.kind || o.tamed || o.trapped > 0 || o.ridden) continue;
      if (o !== a && Math.hypot(o.x - a.x, o.z - a.z) > HERD_ALARM) continue;
      const left = o.mode === 'flee' ? Math.max(0, o.timer) : 0;
      if (o.mode !== 'flee' && ev) ev.startled.push(o);
      o.mode = 'flee';
      o.timer = Math.max(left, seconds, 1);
      o.calm = 0;
      this._aimAway(o, fromX, fromZ);
    }
  }

  /** Head straight away from (x, z), a little to its own side so a herd fans out. */
  _aimAway(a, x, z) {
    a.targetYaw = wrapAngle(yawToward(a.x, a.z, x, z) + Math.PI + a.side * 0.25);
  }

  /** Running at an edge, water, a wall or a fire: swing to the clearer side instead of stopping. */
  _steerSafe(a, getBlock) {
    if (!a.onGround || this._safeAt(a, a.targetYaw, getBlock)) return;
    for (const turn of [0.7, -0.7, 1.4, -1.4, 2.2, -2.2]) {
      const yaw = wrapAngle(a.targetYaw + turn * a.side);
      if (this._safeAt(a, yaw, getBlock)) {
        a.targetYaw = yaw;
        return;
      }
    }
  }

  /** The nearest other animal of its kind, or null. */
  _nearestKin(a) {
    let best = null;
    let bd = Infinity;
    for (const o of this.list) {
      if (o === a || o.kind !== a.kind) continue;
      const d = Math.hypot(o.x - a.x, o.z - a.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Look for the nearest baited snare within BAIT_RANGE cells (feet level ±1); remember its centre, or forget. */
  _findBait(a, getBlock) {
    a.baitX = NaN;
    a.baitZ = NaN;
    const [q0, r0] = worldToHex(a.x, a.z);
    const y0 = Math.floor(a.y + 0.05);
    let bd = Infinity;
    for (let dq = -BAIT_RANGE; dq <= BAIT_RANGE; dq++) {
      for (let dr = Math.max(-BAIT_RANGE, -dq - BAIT_RANGE); dr <= Math.min(BAIT_RANGE, -dq + BAIT_RANGE); dr++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (getBlock(q0 + dq, y0 + dy, r0 + dr) !== BLOCK.SNARE_BAITED) continue;
          const [x, z] = hexToWorld(q0 + dq, r0 + dr);
          const d = Math.hypot(x - a.x, z - a.z);
          if (d < bd) {
            bd = d;
            a.baitX = x;
            a.baitZ = z;
          }
        }
      }
    }
  }

  /** @returns {[number, number, number]} the cell 0.8 ahead along `yaw`, and the feet level */
  _aheadCell(a, yaw = a.yaw) {
    const [fx, fz] = yawToForward(yaw);
    const [q, r] = worldToHex(a.x + fx * (a.radius + 0.5), a.z + fz * (a.radius + 0.5));
    return [q, r, Math.floor(a.y + 0.01)];
  }

  /** The way along `yaw` is no water to swim in, no fire, has ground within two cells below, and no wall but a hop. */
  _safeAt(a, yaw, getBlock) {
    const [q, r, fy] = this._aheadCell(a, yaw);
    if (isSwimWater(getBlock, q, fy, r)) return false;
    if (this._fires && fireAhead(getBlock, a.x, a.z, yaw, fy)) return false;
    if (isSolid(getBlock(q, fy, r))) return isOpen(getBlock(q, fy + 1, r)) && isOpen(getBlock(q, fy + 2, r));
    return isSolid(getBlock(q, fy - 1, r)) || isSolid(getBlock(q, fy - 2, r));
  }

  _safeAhead(a, getBlock) {
    return this._safeAt(a, a.yaw, getBlock);
  }

  /** A one-cell ledge straight ahead with room on top. */
  _ledgeAhead(a, getBlock) {
    const [q, r, fy] = this._aheadCell(a);
    return isSolid(getBlock(q, fy, r)) && isOpen(getBlock(q, fy + 1, r));
  }

  /** A block placed into it: lift it to the first free height within three cells. */
  _unstick(a, getBlock) {
    if (isFreeAt(getBlock, a.x, a.y, a.z, a.radius, a.height)) return;
    const fy = findFreeY(getBlock, a.x, a.z, Math.floor(a.y) + 1, 3, a.radius, a.height);
    if (fy !== null) {
      a.y = fy;
      a.vy = 0;
    }
  }

  /**
   * A blow of `power` from (fromX, fromZ): ignored (null) while it still flashes; else health −= power. At 0 it is removed
   * ('dead'); else it is knocked back, flashes, and it and its herd run ('hit'). A snared animal takes the blow in place.
   * @returns {'hit'|'dead'|null}
   */
  wound(a, power, fromX, fromZ) {
    if (a.hurt > 0 || !this.list.includes(a)) return null;
    const p = typeof power === 'number' && power > 0 && Number.isFinite(power) ? power : 0;
    a.health -= p;
    if (a.health <= 0) {
      this.remove(a);
      return 'dead';
    }
    a.hurt = ANIMAL_HURT_S;
    if (!(a.trapped > 0) && !a.ridden) {
      let dx = a.x - fromX;
      let dz = a.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      a.vx = dx * ANIMAL_KNOCKBACK;
      a.vz = dz * ANIMAL_KNOCKBACK;
      a.vy = Math.max(a.vy, 4);
      a.onGround = false;
      if (!a.tamed) this._startle(a, fromX, fromZ, null, HIT_FLEE_S);
    }
    return 'hit';
  }

  /**
   * Feed it `key` (R with the food in hand, within reach). Cattle and sheep calm down for FED_CALM_S; a horse or a wolf
   * gains trust and, at its species' `tame` feeds, is tamed. @returns {{ ok: boolean, tamed?: boolean, calmed?: boolean }}
   */
  feed(a, key) {
    const sp = SPECIES[a.kind];
    if (!sp.lure.includes(key) || !this.list.includes(a)) return { ok: false };
    if (a.tamed) {
      a.health = Math.min(sp.health, a.health + 3); // food heals a tame animal
      return { ok: true };
    }
    a.calm = FED_CALM_S;
    if (a.mode === 'flee') {
      a.mode = 'idle';
      a.timer = 1;
    }
    if (sp.tame <= 0) return { ok: true, calmed: true };
    a.trust += 1;
    if (a.trust < sp.tame) return { ok: true, calmed: true };
    a.tamed = true;
    a.calm = 0;
    a.homeX = a.x;
    a.homeZ = a.z;
    if (a.trapped > 0) this._release(a, false);
    return { ok: true, tamed: true };
  }

  /**
   * Milk a cow into an empty clay pot: true when it gave milk (a cow that was milked less than MILK_REGROW_S ago, or
   * anything that is not a cow, gives none).
   */
  milk(a) {
    if (a.kind !== 'cow' || a.milked > 0 || !this.list.includes(a)) return false;
    a.milked = MILK_REGROW_S;
    return true;
  }

  /** Shear a sheep that has its fleece: SHEAR_WOOL wool, and it grows back in SHEAR_REGROW_S. @returns {number} wool */
  shear(a) {
    if (a.kind !== 'sheep' || a.shorn > 0 || !this.list.includes(a)) return 0;
    a.shorn = SHEAR_REGROW_S;
    return SHEAR_WOOL[0] + Math.floor(this._rng() * (SHEAR_WOOL[1] - SHEAR_WOOL[0] + 1));
  }

  /** Mount a tame horse: it is taller by RIDER_HEIGHT while ridden (it cannot pass where its rider could not). */
  mount(a) {
    if (a.kind !== 'horse' || !a.tamed || a.ridden || !this.list.includes(a)) return false;
    a.ridden = true;
    a.height = SPECIES.horse.height + RIDER_HEIGHT;
    a.mode = 'idle';
    return true;
  }

  /** Get off: the horse waits around here. */
  dismount(a) {
    if (!a.ridden) return;
    a.ridden = false;
    a.height = SPECIES.horse.height;
    a.homeX = a.x;
    a.homeZ = a.z;
    a.mode = 'idle';
    a.timer = 2;
    a.speedScale = 1;
  }

  /**
   * One step of a ridden horse, driven by the rider's input (forward / strafe / sprint / jump and the look yaw): RIDE_SCALE
   * times the walking or sprinting speed, hopping one-cell ledges by itself and leaping RIDE_LEAP cells on jump.
   * @param {Animal} a
   * @param {{ forward?: number, strafe?: number, sprint?: boolean, jump?: boolean, yaw?: number, pullX?: number, pullY?: number, pullZ?: number }} input
   * @param {GetBlockFn} getBlock
   * @param {number} dt
   */
  ride(a, input, getBlock, dt) {
    if (!a.ridden || !(dt > 0)) return;
    const inp = this._input;
    const fwd = input.forward || 0;
    inp.forward = fwd;
    inp.strafe = (input.strafe || 0) * 0.6;
    inp.sneak = false;
    inp.sprint = !!input.sprint && fwd > 0;
    inp.yaw = input.yaw || 0;
    inp.pullX = input.pullX || 0;
    inp.pullY = input.pullY || 0;
    inp.pullZ = input.pullZ || 0;
    a.yaw = wrapAngle(inp.yaw);
    a.targetYaw = a.yaw;
    a.speedScale = RIDE_SCALE;
    const ledge = fwd > 0 && a.hitWall && this._ledgeAhead(a, getBlock);
    inp.jump = a.inWater || ledge;
    if (input.jump && a.onGround && !a.inWater) {
      a.vy = Math.sqrt(2 * -GRAVITY * RIDE_LEAP);
      a.onGround = false;
    }
    const x0 = a.x;
    const z0 = a.z;
    stepPlayer(a, inp, getBlock, dt);
    a.sneaking = false;
    a.sprinting = false;
    this._stride(a, x0, z0, dt);
  }

  /**
   * Nearest animal whose body cylinder the ray (origin o, unit direction d) enters within maxDist.
   * @returns {{ animal: Animal, distance: number }|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const a of this.list) {
      if (a.ridden) continue;
      const t = rayCylinder(ox, oy, oz, dx, dy, dz, a.x, a.y, a.z, a.radius + 0.06, a.height);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = a;
      }
    }
    return best ? { animal: best, distance: bestT } : null;
  }

  /**
   * Natural herds: one try per check. A herd of a kind the biome grows appears HERD_MIN..HERD_MAX from the player on
   * natural ground with two open cells above, while fewer than HERD_TARGET wild animals are within HERD_RADIUS.
   * @returns {number} animals placed
   */
  _spawnHerd(player, world) {
    let near = 0;
    for (const a of this.list) if (!a.tamed && Math.hypot(a.x - player.x, a.z - player.z) <= HERD_RADIUS) near++;
    if (near >= HERD_TARGET || this.list.length >= ANIMAL_MAX || this._rng() >= HERD_CHANCE) return 0;
    for (let k = 0; k < HERD_TRIES; k++) {
      const ang = this._rng() * TWO_PI;
      const d = HERD_MIN + this._rng() * (HERD_MAX - HERD_MIN);
      const [q, r] = worldToHex(player.x + Math.cos(ang) * d, player.z + Math.sin(ang) * d);
      const weights = HERD_WEIGHTS[/** @type {number} */ (/** @type {*} */ (world).getBiome(q, r))];
      if (!weights) continue;
      const kind = this._pickKind(weights);
      const sp = SPECIES[kind];
      const n = sp.herd[0] + Math.floor(this._rng() * (sp.herd[1] - sp.herd[0] + 1));
      let placed = 0;
      for (let m = 0; m < n * 3 && placed < n && this.list.length < ANIMAL_MAX; m++) {
        const mq = q + Math.round((this._rng() * 2 - 1) * 3);
        const mr = r + Math.round((this._rng() * 2 - 1) * 3);
        const fy = this.spawnHeightAt(world, mq, mr, sp);
        if (fy === null) continue;
        const [x, z] = hexToWorld(mq, mr);
        if (this.list.some((o) => Math.hypot(o.x - x, o.z - z) < 1)) continue;
        const a = this.spawn(kind, x, fy, z, this._rng() * TWO_PI);
        if (!a) break;
        this.events.spawned.push(a);
        placed++;
      }
      if (placed > 0) return placed;
    }
    return 0;
  }

  /** @param {Record<string, number>} weights @returns {AnimalKind} */
  _pickKind(weights) {
    let total = 0;
    for (const w of Object.values(weights)) total += w;
    let roll = this._rng() * total;
    for (const [k, w] of Object.entries(weights)) {
      roll -= w;
      if (roll < 0) return /** @type {AnimalKind} */ (k);
    }
    return /** @type {AnimalKind} */ (Object.keys(weights)[0]);
  }

  /** The feet y an animal may appear at in column (q, r): loaded, natural ground, two open cells above, room. Else null. */
  spawnHeightAt(world, q, r, sp) {
    if (!world.isLoadedCell || !world.groundHeight || !world.isNaturalGround) return null;
    if (!world.isLoadedCell(q, r)) return null;
    const h = world.groundHeight(q, r);
    if (!(h >= 0) || !world.isNaturalGround(q, h, r)) return null;
    const getBlock = world.getBlock;
    if (getBlock(q, h, r) !== BLOCK.GRASS_BLOCK && getBlock(q, h, r) !== BLOCK.SNOWY_GRASS) return null;
    if (getBlock(q, h + 1, r) !== BLOCK.AIR || getBlock(q, h + 2, r) !== BLOCK.AIR) return null;
    const [x, z] = hexToWorld(q, r);
    return isFreeAt(getBlock, x, h + 1, z, sp.radius, sp.height) ? h + 1 : null;
  }

  /** For the save: every animal (ridden ones as standing). */
  export() {
    return this.list.map((a) => {
      /** @type {*} */
      const o = { k: a.kind, x: round2(a.x), y: round2(a.y), z: round2(a.z), yaw: round2(a.yaw), h: round2(a.health) };
      if (a.tamed) o.t = 1;
      else if (a.trust > 0) o.tr = a.trust;
      if (a.shorn > 0) o.s = Math.ceil(a.shorn);
      if (a.milked > 0) o.m = Math.ceil(a.milked);
      if (a.sitting) o.sit = 1;
      if (a.trapped > 0 && a.trapCell) {
        o.tp = Math.ceil(a.trapped);
        o.tc = [a.trapCell[0], a.trapCell[1], a.trapCell[2]];
      }
      return o;
    });
  }

  /** Put saved animals back (validateAnimalsJSON's form). */
  load(list) {
    this.clear();
    this.events.freed.length = 0;
    const { animals } = validateAnimalsJSON(list);
    for (const o of animals) {
      const a = this.spawn(/** @type {AnimalKind} */ (o.k), o.x, o.y, o.z, o.yaw);
      if (!a) break;
      a.health = o.h;
      a.tamed = o.t === 1;
      a.trust = o.tr ?? 0;
      a.shorn = o.s ?? 0;
      a.milked = o.m ?? 0;
      a.sitting = o.sit === 1;
      if (o.tp && o.tc) {
        a.trapped = o.tp;
        a.trapT = 1;
        a.trapCell = [o.tc[0], o.tc[1], o.tc[2]];
      }
    }
  }
}

/** @param {number} v */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * The `animals` save field in canonical form: `[{ k, x, y, z, yaw, h, t?, tr?, s?, sit?, tp?, tc? }]`, at most ANIMAL_MAX;
 * bad entries are dropped with a warning.
 * @param {*} raw
 * @returns {{ animals: *[], warnings: string[] }}
 */
export function validateAnimalsJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {*[]} */
  const animals = [];
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push('animals: not a list, ignored');
    return { animals, warnings };
  }
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    const ok = o && typeof o === 'object' && isAnimalKind(o.k) && fin(o.x) && fin(o.y) && fin(o.z);
    if (!ok) {
      warnings.push(`animals[${i}]: invalid, dropped`);
      continue;
    }
    if (animals.length >= ANIMAL_MAX) {
      warnings.push(`animals: more than ${ANIMAL_MAX}, the rest dropped`);
      break;
    }
    const sp = SPECIES[/** @type {AnimalKind} */ (o.k)];
    /** @type {*} */
    const e = { k: o.k, x: round2(o.x), y: round2(o.y), z: round2(o.z), yaw: fin(o.yaw) ? round2(o.yaw) : 0 };
    e.h = fin(o.h) && o.h > 0 ? Math.min(sp.health, round2(o.h)) : sp.health;
    if (o.t === 1 && sp.tame > 0) e.t = 1;
    else if (Number.isInteger(o.tr) && o.tr > 0 && o.tr < sp.tame) e.tr = o.tr;
    if (Number.isInteger(o.s) && o.s > 0 && o.k === 'sheep') e.s = Math.min(SHEAR_REGROW_S, o.s);
    if (Number.isInteger(o.m) && o.m > 0 && o.k === 'cow') e.m = Math.min(MILK_REGROW_S, o.m);
    if (o.sit === 1 && e.t === 1 && o.k === 'wolf') e.sit = 1;
    if (Number.isInteger(o.tp) && o.tp > 0 && Array.isArray(o.tc) && o.tc.length === 3 && o.tc.every(Number.isSafeInteger)) {
      e.tp = Math.min(TRAP_HOLD_S, o.tp);
      e.tc = [o.tc[0], o.tc[1], o.tc[2]];
    }
    animals.push(e);
  }
  return { animals, warnings };
}

/** The top speed an animal of `kind` runs at (m/s), for the handbook and the tests. */
export function fleeSpeed(kind) {
  const sp = SPECIES[kind];
  return sp.fleeScale * (sp.fleeSprint ? SPRINT_SPEED : WALK_SPEED);
}
