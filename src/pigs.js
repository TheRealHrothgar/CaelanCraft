// Caelancraft — Pigs: the first creatures. See src/CONTRACTS.md §30. Pure (no DOM, no three).
//
// A pig is a body (physics.createBody, PIG_RADIUS × PIG_HEIGHT, PIG_MASS) driven by a tiny AI through the same
// stepPlayer physics as the player, so it slides along honeycomb walls, hops up one-cell ledges, swims and feels black
// holes exactly like the player does. Its cylinder is used for terrain collisions, for body-to-body pushing
// (bodies.js) and as the ray target. A pig fits under a one-cell overhang but is too wide for a one-cell tunnel.
// Pigs never die: a hit makes them squeal, hop back and run away for PIG_FLEE_S.
import {
  PIG_MAX, PIG_RADIUS, PIG_HEIGHT, PIG_MASS, PIG_KNOCKBACK, PIG_HURT_S, PIG_FLEE_S, PIG_TURN_RATE, WORLD_HEIGHT,
} from './config.js';
import { createBody, stepPlayer, findStandingY, findFreeY, isFreeAt, isSwimWater } from './physics.js';
import { yawToForward } from './coords.js';
import { hexToWorld, worldToHex } from './hex.js';
import { BLOCK, isSolid } from './blocks.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

/**
 * @typedef {PlayerState & {
 *   id: number, yaw: number, targetYaw: number, mode: 'idle'|'walk'|'flee', timer: number,
 *   hurt: number, walkPhase: number, oinkIn: number,
 * }} Pig
 * `walkPhase` advances with distance walked (the renderer swings the legs with it); `oinkIn` counts down to the
 * next ambient oink.
 */

/** @typedef {{ x: number, y: number, z: number, yaw: number }} PigJSON */

/**
 * @typedef {Object} PigWorld
 * @property {GetBlockFn} getBlock
 * @property {(x: number, z: number) => boolean} isLoaded   true when the chunk under world (x, z) is loaded
 * @property {(x: number, y: number, z: number, out: [number, number, number]) => [number, number, number]} [pullAt]
 */

const TWO_PI = Math.PI * 2;

/** Wrap an angle into (−π, π]. */
function wrapAngle(a) {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * A block placed into a pig (commands can fill cells pigs stand in): lift it to the first free height within three
 * cells, or leave it (the terrain sweep will snap it) when there is none.
 */
function unstick(pig, getBlock) {
  if (isFreeAt(getBlock, pig.x, pig.y, pig.z, PIG_RADIUS, PIG_HEIGHT)) return;
  const fy = findFreeY(getBlock, pig.x, pig.z, Math.floor(pig.y) + 1, 3, PIG_RADIUS, PIG_HEIGHT);
  if (fy !== null) {
    pig.y = fy;
    pig.vy = 0;
  }
}

/** mulberry32: a small seeded generator for deterministic natural spawns. @returns {() => number} */
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Pigs {
  /** @param {() => number} [rng] uniform [0, 1); Math.random by default (AI choices need not be reproducible) */
  constructor(rng = Math.random) {
    /** @type {Pig[]} */
    this.list = [];
    this._rng = rng;
    this._nextId = 1;
    /** @type {[number, number, number]} */
    this._pull = [0, 0, 0];
    /** @type {Pig[]} pigs that stepped into a campfire during the last update (they yelp and jump out) */
    this.scorched = [];
    this._input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pullX: 0, pullY: 0, pullZ: 0 };
  }

  get size() {
    return this.list.length;
  }

  clear() {
    this.list.length = 0;
  }

  /**
   * Add a pig standing at feet (x, y, z) facing `yaw`. @returns {Pig|null} null when PIG_MAX pigs exist or the
   * position is not finite
   */
  spawn(x, y, z, yaw = 0) {
    if (this.list.length >= PIG_MAX || !Number.isFinite(x + y + z + yaw)) return null;
    const pig = /** @type {Pig} */ (Object.assign(createBody(x, y, z, { radius: PIG_RADIUS, height: PIG_HEIGHT, mass: PIG_MASS }), {
      id: this._nextId++,
      yaw: wrapAngle(yaw),
      targetYaw: wrapAngle(yaw),
      mode: 'idle',
      timer: 0.5 + this._rng() * 2,
      hurt: 0,
      walkPhase: 0,
      oinkIn: 4 + this._rng() * 10,
    }));
    this.list.push(pig);
    return pig;
  }

  /** @returns {boolean} true when the pig was in the list */
  remove(pig) {
    const i = this.list.indexOf(pig);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  /**
   * Advance every pig whose chunk is loaded (others are frozen in place). Pigs that fall below the world are removed.
   * @param {number} dt
   * @param {PigWorld} world
   * @returns {Pig[]} pigs whose ambient oink is due this frame
   */
  update(dt, world) {
    /** @type {Pig[]} */
    const oinks = [];
    this.scorched.length = 0;
    if (!(dt > 0)) return oinks;
    const input = this._input;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const pig = this.list[i];
      if (pig.y < -16) {
        this.list.splice(i, 1);
        continue;
      }
      if (!world.isLoaded(pig.x, pig.z)) continue;
      unstick(pig, world.getBlock);
      this._think(pig, dt, world.getBlock);

      // Turn toward the target heading at PIG_TURN_RATE.
      const dYaw = wrapAngle(pig.targetYaw - pig.yaw);
      const maxTurn = PIG_TURN_RATE * dt;
      pig.yaw = wrapAngle(pig.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));

      const moving = pig.mode !== 'idle' && Math.abs(dYaw) < 1.2;
      input.forward = moving ? 1 : 0;
      input.sneak = pig.mode === 'walk'; // sneak speed (1.31 m/s) is a pig's amble; fleeing uses walk speed
      input.jump = moving && (pig.hitWall || pig.inWater);
      input.yaw = pig.yaw;
      if (world.pullAt) {
        world.pullAt(pig.x, pig.y + 0.5, pig.z, this._pull);
        input.pullX = this._pull[0];
        input.pullY = this._pull[1];
        input.pullZ = this._pull[2];
      } else {
        input.pullX = 0;
        input.pullY = 0;
        input.pullZ = 0;
      }
      const x0 = pig.x;
      const z0 = pig.z;
      stepPlayer(pig, input, world.getBlock, dt);
      pig.sneaking = false; // a pig has no eye height to lower; keep the flag meaningful for the player only
      pig.walkPhase = (pig.walkPhase + Math.hypot(pig.x - x0, pig.z - z0) * 4) % TWO_PI;
      // Standing in a campfire: hop out away from its centre (hit() also starts the flee and the hurt flash).
      const [cq, cr] = worldToHex(pig.x, pig.z);
      if (world.getBlock(cq, Math.floor(pig.y + 0.05), cr) === BLOCK.CAMPFIRE && pig.hurt === 0) {
        const [fx, fz] = hexToWorld(cq, cr);
        if (this.hit(pig, fx, fz)) this.scorched.push(pig);
      }
      if (pig.hurt > 0) pig.hurt = Math.max(0, pig.hurt - dt);

      pig.oinkIn -= dt;
      if (pig.oinkIn <= 0) {
        pig.oinkIn = 6 + this._rng() * 12;
        oinks.push(pig);
      }
    }
    return oinks;
  }

  /** AI: idle ↔ wander, flee after a hit, and never walk off a drop of more than one cell or into water it would swim in. */
  _think(pig, dt, getBlock) {
    pig.timer -= dt;
    if (pig.timer <= 0) {
      if (pig.mode === 'idle') {
        pig.mode = 'walk';
        pig.targetYaw = wrapAngle(pig.yaw + (this._rng() * 2 - 1) * Math.PI);
        pig.timer = 1.5 + this._rng() * 4;
      } else {
        pig.mode = 'idle';
        pig.timer = 1 + this._rng() * 4;
      }
    }
    if (pig.mode === 'walk' && pig.onGround && !this._safeAhead(pig, getBlock)) {
      // Edge or water ahead: stop and look somewhere else.
      pig.mode = 'idle';
      pig.timer = 0.5 + this._rng();
      pig.targetYaw = wrapAngle(pig.yaw + Math.PI * (0.5 + this._rng()));
    }
  }

  /** The cell 0.8 ahead has ground within one cell below the feet and no water a pig would swim in (films are fine). */
  _safeAhead(pig, getBlock) {
    const [fx, fz] = yawToForward(pig.yaw);
    const [q, r] = worldToHex(pig.x + fx * 0.8, pig.z + fz * 0.8);
    const fy = Math.floor(pig.y + 0.01);
    if (isSwimWater(getBlock, q, fy, r)) return false;
    if (getBlock(q, fy, r) === BLOCK.CAMPFIRE) return false; // pigs keep away from fire
    return isSolid(getBlock(q, fy - 1, r)) || isSolid(getBlock(q, fy - 2, r)) || isSolid(getBlock(q, fy, r));
  }

  /**
   * Hit a pig from a point (the player's position): knockback away from it, a hop, a hurt flash and a flee.
   * @returns {boolean} false while the pig is still flashing from the last hit
   */
  hit(pig, fromX, fromZ) {
    if (pig.hurt > 0) return false;
    let dx = pig.x - fromX;
    let dz = pig.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = 0;
      dz = -1;
    } else {
      dx /= d;
      dz /= d;
    }
    pig.vx = dx * PIG_KNOCKBACK;
    pig.vz = dz * PIG_KNOCKBACK;
    pig.vy = Math.max(pig.vy, 5);
    pig.onGround = false;
    pig.hurt = PIG_HURT_S;
    pig.mode = 'flee';
    pig.timer = PIG_FLEE_S;
    pig.targetYaw = Math.atan2(-dx, -dz); // yawToForward(yaw) = (−sin, −cos): face along (dx, dz)
    pig.oinkIn = 3 + this._rng() * 6;
    return true;
  }

  /**
   * Nearest pig whose body cylinder the ray (origin o, unit direction d) enters within maxDist.
   * @returns {{ pig: Pig, distance: number }|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    const R2 = PIG_RADIUS * PIG_RADIUS;
    for (const pig of this.list) {
      // Ray vs vertical cylinder: solve the horizontal circle, then clip to the cylinder's height; also the caps.
      const px = ox - pig.x;
      const pz = oz - pig.z;
      const y0 = pig.y;
      const y1 = pig.y + PIG_HEIGHT;
      const a = dx * dx + dz * dz;
      const b = px * dx + pz * dz;
      const c = px * px + pz * pz - R2;
      /** @type {number[]} */
      const ts = [];
      if (a > 1e-12) {
        const disc = b * b - a * c;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          for (const t of [(-b - s) / a, (-b + s) / a]) {
            const y = oy + dy * t;
            if (y >= y0 && y <= y1) ts.push(t);
          }
        }
      }
      if (Math.abs(dy) > 1e-12) {
        for (const yc of [y0, y1]) {
          const t = (yc - oy) / dy;
          const hx = px + dx * t;
          const hz = pz + dz * t;
          if (hx * hx + hz * hz <= R2) ts.push(t);
        }
      }
      // Origin inside the cylinder counts as a hit at 0.
      if (c <= 0 && oy >= y0 && oy <= y1) ts.push(0);
      for (const t of ts) {
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = pig;
        }
      }
    }
    return best ? { pig: best, distance: bestT } : null;
  }

  /** @returns {PigJSON[]} positions rounded to millimetres */
  export() {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return this.list.map((p) => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r3(p.yaw) }));
  }

  /** Replace every pig with the (already validated) saved ones. */
  load(list) {
    this.clear();
    for (const p of list) this.spawn(p.x, p.y, p.z, p.yaw);
  }

  /**
   * Place up to `count` pigs on grass cells around (q0, r0) at hex distance minDist..maxDist, deterministically from
   * `seed`. Columns whose chunk is not loaded or whose surface is not GRASS_BLOCK are skipped.
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @returns {number} pigs placed
   */
  spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist = 4, maxDist = 18) {
    const rng = seededRng(seed ^ 0x9e3779b9);
    let placed = 0;
    for (let attempt = 0; attempt < count * 40 && placed < count; attempt++) {
      const ang = rng() * TWO_PI;
      const dist = minDist + rng() * (maxDist - minDist);
      const [cx, cz] = hexToWorld(q0, r0);
      const [q, r] = worldToHex(cx + Math.cos(ang) * dist, cz + Math.sin(ang) * dist);
      if (!isLoadedCell(q, r)) continue;
      const [x, z] = hexToWorld(q, r);
      const fy = findStandingY(getBlock, x, z, WORLD_HEIGHT - 2);
      if (fy === null || getBlock(q, fy - 1, r) !== BLOCK.GRASS_BLOCK) continue;
      if (this.spawn(x, fy, z, rng() * TWO_PI - Math.PI)) placed++;
    }
    return placed;
  }
}

/**
 * Validate a saved `pigs` field: an array of {x, y, z, yaw} with finite numbers (y within −16..WORLD_HEIGHT);
 * anything else is dropped with a warning, and at most PIG_MAX are kept.
 * @param {unknown} raw
 * @returns {{ pigs: PigJSON[], warnings: string[] }}
 */
export function validatePigsJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {PigJSON[]} */
  const pigs = [];
  if (!Array.isArray(raw)) return { pigs, warnings: ['pigs: not an array, ignored'] };
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const ok = p && typeof p === 'object'
      && [p.x, p.y, p.z, p.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))
      && p.y >= -16 && p.y <= WORLD_HEIGHT;
    if (!ok) {
      warnings.push(`pigs[${i}]: invalid, dropped`);
      continue;
    }
    if (pigs.length >= PIG_MAX) {
      warnings.push(`pigs: more than ${PIG_MAX}, extra dropped`);
      break;
    }
    pigs.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw });
  }
  return { pigs, warnings };
}
