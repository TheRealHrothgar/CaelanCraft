// Caelancraft — the Fishing Rod (CONTRACTS §106). PURE: no three, no DOM.
//
// The user: "add a fishing rod to the mix as well (spear still works for shallow streams)". A spear catches a fish only
// in shallow water (spearReaches: no deeper than FISH_SHALLOW, a stream's one cell); in deeper water a startled fish
// dives out of its reach (animals.FISH_DIVE). The rod reaches any water, from the bank:
//
//   hold Place to draw the cast (DrawHold, like a throw: CAST_FULL_S to a full cast), let go — the float flies along the
//   look (castVelocity) and lands on the water (it floats) or on the ground (it lies there). On the water, after a wait a
//   fish within BITE_RADIUS that is not darting comes to it (main steers that fish by `bait()`), nibbles a while (the
//   float twitches) and bites: the float goes under for HOOK_WINDOW_S. Place now hooks it (reel() → 'caught'); Place
//   while it only nibbles pulls the float away from it ('spooked'); a bite let pass and the fish is gone ('escaped').
//   Place at any other time reels the float in. The line comes in by itself past LINE_MAX, when the rod leaves the hand,
//   and when the world or the player goes.

import { worldToHex } from './hex.js';
import { isLiquid, isSolid, waterSurfaceHeight } from './blocks.js';
import { fishWater, FISH_SHALLOW } from './animals.js';
import { CAST_FULL_S } from './looseItems.js';

/** Seconds of Place held to a full cast (looseItems.drawOf's `fullS` for the rod). */
export { CAST_FULL_S };
/** The rod's item key. */
export const ROD_KEY = 'fishing_rod';
/** The float leaves the rod at this speed for a tap, and at CAST_SPEED_FULL for a full cast (m/s). */
export const CAST_SPEED_MIN = 4;
export const CAST_SPEED_FULL = 12;
/** Lifted this much (m/s) above the look, so a cast arcs out over the water. */
export const CAST_LIFT = 2.5;
/** The float falls at this (m/s²) in flight: light, so a full cast carries 10–14 m. */
export const FLOAT_GRAVITY = 14;
/** Past this many metres from the player the line comes in by itself. */
export const LINE_MAX = 24;
/** A fish this near the float (m) may come to it. */
export const BITE_RADIUS = 6;
/** Seconds the float waits before a fish is chosen [min, max] (again after each one that comes to nothing). */
export const BITE_WAIT = Object.freeze([3, 9]);
/** Seconds a fish at the float nibbles before it bites [min, max]. */
export const NIBBLE_S = Object.freeze([1.2, 3.2]);
/** Seconds the float is under on a bite: Place then hooks the fish. */
export const HOOK_WINDOW_S = 0.9;
/** A fish this near the float (m, level) is at it. */
export const BAIT_NEAR = 0.45;
/** Seconds a chosen fish has to come to the float before it is given up (it may be in other water). */
export const COME_GIVE_UP_S = 10;
/** Seconds of floating with no fish near before the hint says so. */
export const QUIET_HINT_S = 25;
/** Seconds a cast may fly before it is taken to have landed where it is (nothing under it). */
const FLIGHT_MAX_S = 5;
/** The float's flight is stepped at most this long at a time (s), so it never skips through a thin wall. */
const FLIGHT_STEP_S = 0.02;

/** @typedef {'none'|'flying'|'float'|'coming'|'nibble'|'bite'|'ground'} LineState */
/** @typedef {'splash'|'land'|'nibble'|'bite'|'escaped'|'snap'} LineEvent */
/** @typedef {{ x: number, y: number, z: number, mode?: string }} FishLike  a fish as the line sees it (animals.js's) */
/**
 * @typedef {Object} LineEnv
 * @property {(q: number, y: number, r: number) => number} getBlock
 * @property {{ x: number, y: number, z: number }} player
 * @property {ReadonlyArray<FishLike>} fish   the live fish (a darting one, `mode` 'flee', never comes)
 */

/** The speed the float leaves the rod at for a cast drawn `f` (0..1). @param {number} f @returns {number} */
export function castSpeed(f) {
  const k = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0));
  return CAST_SPEED_MIN + (CAST_SPEED_FULL - CAST_SPEED_MIN) * k;
}

/**
 * The float's velocity for a cast drawn `f` along the unit look (dx, dy, dz), the player moving at (pvx, pvz).
 * @returns {[number, number, number]}
 */
export function castVelocity(dx, dy, dz, f, pvx = 0, pvz = 0) {
  const s = castSpeed(f);
  return [dx * s + (pvx || 0), dy * s + CAST_LIFT, dz * s + (pvz || 0)];
}

/**
 * §106: does a spear reach the fish `a` (its height and body: animals.js's)? Only in shallow water — no deeper than
 * FISH_SHALLOW from the surface to the bed of its column (a stream's one cell). With no water found it does (a fish on
 * the bank is no harder to spear). @param {(q: number, y: number, r: number) => number} getBlock
 * @param {{ x: number, y: number, z: number, height?: number }} a @returns {boolean}
 */
export function spearReaches(getBlock, a) {
  const [q, r] = worldToHex(a.x, a.z);
  const w = fishWater(getBlock, q, r, a.y + (a.height ?? 0.2) / 2);
  return !w || w.surface - w.bed <= FISH_SHALLOW;
}

/**
 * The water surface the float sits on at (x, y, z): the height of the top of the water in that column within a cell
 * above or below, or NaN when there is none.
 * @param {(q: number, y: number, r: number) => number} getBlock @returns {number}
 */
export function floatSurface(getBlock, x, y, z) {
  const [q, r] = worldToHex(x, z);
  let cy = Math.floor(y);
  if (!isLiquid(getBlock(q, cy, r))) {
    if (isLiquid(getBlock(q, cy - 1, r))) cy -= 1;
    else return NaN;
  }
  let top = cy;
  while (top - cy < 8 && isLiquid(getBlock(q, top + 1, r))) top++;
  return top + waterSurfaceHeight(getBlock(q, top, r), getBlock(q, top + 1, r));
}

/**
 * The line from the rod's tip to the float as `n` points (x, y, z flat): a straight line sagging by at most `slack`, two
 * thirds of the way out (6.75 t² (1 − t)): a line hangs from a raised tip mostly where it nears the water, and stays
 * nearly straight by the tip (in first person the tip is a span from the eye, where a dip would fill the view).
 * Tight (no sag) when slack is 0. @returns {Float32Array}
 */
export function lineCurve(tip, end, n = 16, slack = 0) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    out[i * 3] = tip[0] + (end[0] - tip[0]) * t;
    out[i * 3 + 1] = tip[1] + (end[1] - tip[1]) * t - slack * 6.75 * t * t * (1 - t);
    out[i * 3 + 2] = tip[2] + (end[2] - tip[2]) * t;
  }
  return out;
}

/** How much the line sags (m) for a float `d` m off: a slack line, drawn tight while a fish is on. */
export function lineSlack(d, tight = false) {
  return tight ? 0.02 : Math.min(0.6, 0.03 * d);
}

/** The float on the line: where it is, what it does, and the fish that comes to it. */
export class FishingLine {
  /** @param {() => number} [rng] */
  constructor(rng = Math.random) {
    this.rng = rng;
    /** @type {LineState} */
    this.state = 'none';
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    /** seconds left in this state (flight: seconds flown) */
    this.t = 0;
    /** @type {FishLike|null} the fish coming to the float, nibbling or biting */
    this.fish = null;
    /** seconds of floating with no fish near (the quiet hint at QUIET_HINT_S) */
    this.quiet = 0;
    /** 0..1: how far under the float is (a twitch on a nibble, all the way on a bite); eases back */
    this.dip = 0;
    /** seconds to the next twitch while a fish nibbles */
    this._twitch = 0;
  }

  /** The line is out (cast, flying, floating or lying on land). */
  get out() {
    return this.state !== 'none';
  }

  /** The float is on the water (waiting, a fish coming, nibbling or biting). */
  get onWater() {
    return this.state === 'float' || this.state === 'coming' || this.state === 'nibble' || this.state === 'bite';
  }

  /** Reel in at once: nothing is caught (the rod left the hand, the world or the player went). */
  reset() {
    this.state = 'none';
    this.t = 0;
    this.fish = null;
    this.quiet = 0;
    this.dip = 0;
  }

  /**
   * Cast the float from (x, y, z) at velocity (vx, vy, vz) (castVelocity).
   * @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz
   */
  cast(x, y, z, vx, vy, vz) {
    this.reset();
    this.state = 'flying';
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
  }

  /**
   * Place with the line out: on a bite the fish is hooked ('caught'); while it only nibbles the float is pulled from
   * it ('spooked'); else the float comes in ('reeled'). The line is in afterwards.
   * @returns {{ result: 'caught'|'spooked'|'reeled', fish: FishLike|null }}
   */
  reel() {
    const fish = this.fish;
    const result = this.state === 'bite' && fish ? 'caught' : this.state === 'nibble' && fish ? 'spooked' : 'reeled';
    this.reset();
    return { result, fish: result === 'reeled' ? null : fish };
  }

  /**
   * The fish main steers to the float (animals.js `a.bait`), or null: the one coming to it or nibbling.
   * @returns {{ fish: FishLike, x: number, z: number }|null}
   */
  bait() {
    if (!this.fish || (this.state !== 'coming' && this.state !== 'nibble')) return null;
    return { fish: this.fish, x: this.x, z: this.z };
  }

  /** @param {ReadonlyArray<number>} range [a, b] @returns {number} a random number in [a, b) */
  _between([a, b]) {
    return a + (b - a) * this.rng();
  }

  /** Back to waiting on the water, with a fresh wait before another fish is chosen. */
  _wait() {
    this.state = 'float';
    this.fish = null;
    this.t = this._between(BITE_WAIT);
  }

  /**
   * One frame. @param {number} dt @param {LineEnv} env
   * @returns {LineEvent|null} what happened (main plays it and says it)
   */
  step(dt, env) {
    if (this.state === 'none' || !(dt > 0)) return null;
    const p = env.player;
    if (Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z) > LINE_MAX) {
      this.reset();
      return 'snap';
    }
    this.dip = Math.max(0, this.dip - dt * 3);
    if (this.state === 'flying') return this._fly(dt, env);
    if (this.state === 'ground') return null;
    // on the water: it rides the surface; the water gone, it lies where it is
    const surface = floatSurface(env.getBlock, this.x, this.y + 0.3, this.z);
    if (Number.isNaN(surface)) {
      this.fish = null;
      this.state = 'ground';
      return null;
    }
    this.y = surface;
    const fishHere = (f) => !!f && env.fish.includes(f) && f.mode !== 'flee';
    const level = (f) => Math.hypot(f.x - this.x, f.z - this.z);
    if (this.state === 'float') {
      this.fish = null; // the one that got away was handed to main with its 'escaped'
      this.t -= dt;
      let near = null;
      let best = BITE_RADIUS;
      for (const f of env.fish) {
        if (f.mode === 'flee') continue;
        const d = level(f);
        if (d <= best && Math.abs(f.y - this.y) < 2.5) {
          best = d;
          near = f;
        }
      }
      if (!near) this.quiet += dt;
      else this.quiet = 0;
      if (this.t <= 0) {
        if (near) {
          this.state = 'coming';
          this.fish = near;
          this.t = COME_GIVE_UP_S;
        } else {
          this.t = this._between(BITE_WAIT);
        }
      }
      return null;
    }
    if (!fishHere(this.fish)) {
      // it darted off, was caught by something else, or swam out of the world: wait for another
      this._wait();
      return null;
    }
    const f = /** @type {FishLike} */ (this.fish);
    if (this.state === 'coming') {
      this.t -= dt;
      if (level(f) <= BAIT_NEAR) {
        this.state = 'nibble';
        this.t = this._between(NIBBLE_S);
        this._twitch = 0.3;
      } else if (this.t <= 0) {
        this._wait(); // it never got here (other water, or the way round is too long): another may
      }
      return null;
    }
    if (this.state === 'nibble') {
      this.t -= dt;
      if (this.t <= 0) {
        this.state = 'bite';
        this.t = HOOK_WINDOW_S;
        this.dip = 1;
        return 'bite';
      }
      this._twitch -= dt;
      if (this._twitch <= 0) {
        this._twitch = 0.45 + this.rng() * 0.6;
        this.dip = Math.max(this.dip, 0.35);
        return 'nibble';
      }
      return null;
    }
    // the bite: the float is held under until the window closes; then the fish has the bait and is gone
    this.dip = 1;
    this.t -= dt;
    if (this.t <= 0) {
      this.state = 'float';
      this.t = this._between(BITE_WAIT);
      this.dip = 0;
      return 'escaped'; // `fish` stays set until the next frame, for main to send it off
    }
    return null;
  }

  /** The cast in flight: it falls, lands on water (floats) or on anything solid (lies there). @returns {LineEvent|null} */
  _fly(dt, env) {
    let left = dt;
    while (left > 0) {
      const h = Math.min(FLIGHT_STEP_S, left);
      left -= h;
      this.t += h;
      this.vy -= FLOAT_GRAVITY * h;
      const nx = this.x + this.vx * h;
      const ny = this.y + this.vy * h;
      const nz = this.z + this.vz * h;
      const [q, r] = worldToHex(nx, nz);
      const cy = Math.floor(ny);
      const id = env.getBlock(q, cy, r);
      if (isLiquid(id)) {
        const surface = floatSurface(env.getBlock, nx, ny, nz);
        if (!Number.isNaN(surface) && ny <= surface) {
          this.x = nx;
          this.z = nz;
          this.y = surface;
          this.vx = this.vy = this.vz = 0;
          this._wait();
          this.quiet = 0;
          this.dip = 0.6; // it lands with a bob
          return 'splash';
        }
      } else if (isSolid(id) || ny < 0) {
        // it lies where it hit: on top of a cell it fell onto, else just short of the wall
        if (this.vy < 0 && ny < cy + 1 && this.y >= cy + 1 - 1e-6) this.y = cy + 1;
        this.vx = this.vy = this.vz = 0;
        this.state = 'ground';
        this.fish = null;
        return 'land';
      }
      this.x = nx;
      this.y = ny;
      this.z = nz;
      if (this.t > FLIGHT_MAX_S) {
        this.state = 'ground';
        return 'land';
      }
    }
    return null;
  }
}
