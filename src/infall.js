// Caelancraft — swallowed blocks and mobs, visibly spiralling into a vortex (DESIGN-circuits §2.6–§2.7). Pure.
//
// BlackHoles.update eats a cell (a lazy write of AIR) and reports it with the eating hole's centre. Main hands every
// such record to addBlock: a copy of the block tears loose from exactly where the cell was, then rides the disk's own
// spiral into the core, shrinking, and is drawn through the existing fallingRenderer (renderItems → main's pooled push;
// never a second fallingRenderer, which would add a light). A swallowed pig or zombie becomes a ghost (addMob): the
// mob object itself, whose x, y, z, yaw, renderScale and renderSpin are written each step while pigRenderer and
// zombieRenderer keep drawing it. Main plays the squeal or the knock-out puff when the ghost is done.
//
// The kinematics (normative, §2.6; s = t / D, ρe = VORTEX_EVENT_R, K = VORTEX_SPIRAL_K):
//   tear (s < 0.1)  the block shudders (±0.03 at 30 Hz) and lifts 0.8·s
//   u = (s − 0.1) / 0.9;  ρ = ρ0·(1 − u)^(2/3)   (dρ/dt ∝ −1/√ρ: an accelerating plunge, like the particles)
//   θ = θ0 + K·ln(ρ0 / ρ)                       (it rides the disk's arms, in the swirl's +θ sense)
//   h = h0·(1 − u)²                              (it settles onto the disk plane before it reaches the core)
//   scale = 0.15 + 0.85·smoothstep(ρe, min(ρ0, 2.5), ρ); ry = θ + π/2; rx = 0.35·sin(7u); rz = 6u² (+ a seeded tilt)
//   done at ρ ≤ ρe or s ≥ 1: a `gone` point at the core
// Two continuity details the formulas leave open, documented here: the tear's lift settles with the same (1 − u)² as h0
// (no drop at s = 0.1), and the rotation blends in over the tear (w = smoothstep(0, 0.1, s)), so at s = 0 the copy is
// the unrotated cell exactly — a hex prism turned by an arbitrary θ0 + π/2 would visibly jump.
import {
  INFALL_VIEW_RANGE, MAX_INFALL_BLOCKS, MAX_INFALL_MOBS, INFALL_MIN_S, INFALL_MAX_S, INFALL_MOB_S, VORTEX_EVENT_R,
  VORTEX_SPIRAL_K,
} from './config.js';
// CONTRACT-ISSUE: §6.1's import graph lists `infall → config` only, but §2.6 needs isMeshed (blocks.js) to skip ids with
// no cell mesh and the cell centre (hex.js hexToWorld) to start each flight on its cell. Both are pure leaf modules.
import { isMeshed } from './blocks.js';
import { hexToWorld } from './hex.js';

/** The tear: the first tenth of a block's flight. */
export const TEAR = 0.1;
const TEAR_LIFT = 0.8;
const TEAR_JITTER = 0.03;
const TEAR_JITTER_HZ = 30;
/** A cell (or mob) closer to the core's axis than this starts its spiral this far out, at a seeded angle. */
export const MIN_RHO0 = 0.6;
/** An eaten block ends at this scale; a mob ghost's renderScale ends at MOB_END_SCALE. */
export const END_SCALE = 0.15;
export const MOB_END_SCALE = 0.1;
/** The seeded initial tilt of each block copy, ± this (radians). */
const TILT = 0.3;

/**
 * @typedef {import('./blackholes.js').EatRecord} EatRecord
 * @typedef {import('./blackholes.js').RenderPush} RenderPush
 * @typedef {import('./types.js').PlayerState} Body
 */

/**
 * @typedef {Object} InfallPose  a point of the flight, relative to the hole's centre
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} scale
 * @property {number} rx
 * @property {number} ry
 * @property {number} rz
 * @property {number} rho   distance from the core's axis
 * @property {number} theta angle about the core, θ = atan2(z, x)
 * @property {number} u     spiral progress (0 through the tear, 1 at the core)
 * @property {boolean} done ρ ≤ VORTEX_EVENT_R or s ≥ 1
 */

/** GLSL-style smoothstep. */
function smoothstep(e0, e1, x) {
  if (!(e1 > e0)) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** mulberry32: the default generator when no `random` is injected (a pure module never calls Math.random). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A repeatable value in [−1, 1] for (seed, frame, axis): the tear's shudder. */
function shudder(seed, frame, axis) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(frame | 0, 0x85ebca77) ^ Math.imul(axis + 1, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * A block's flight time D (§2.6): clamp(0.25 + ρ0^1.5 / 3.6 + 0.1·|h0|, INFALL_MIN_S, INFALL_MAX_S). Callers pass
 * the start radius after the MIN_RHO0 clamp.
 * @param {number} rho0
 * @param {number} h0
 */
export function infallDuration(rho0, h0) {
  const d = 0.25 + Math.pow(Math.max(0, rho0), 1.5) / 3.6 + 0.1 * Math.abs(h0);
  return Math.min(INFALL_MAX_S, Math.max(INFALL_MIN_S, d));
}

/**
 * The flight's pose at progress s (0..1), relative to the hole's centre (pure kinematics: no shudder, no seeded tilt).
 * @param {number} s
 * @param {number} rho0 start distance from the core's axis
 * @param {number} theta0 start angle, atan2(z − cz, x − cx)
 * @param {number} h0 start height above the centre
 * @param {InfallPose} [out]
 * @returns {InfallPose}
 */
export function infallPose(s, rho0, theta0, h0, out = /** @type {InfallPose} */ ({})) {
  const ss = Math.min(1, Math.max(0, s));
  const w = smoothstep(0, TEAR, ss);
  const u = Math.min(1, Math.max(0, (ss - TEAR) / (1 - TEAR)));
  const rho = rho0 * Math.pow(1 - u, 2 / 3);
  const theta = theta0 + (rho > 1e-12 ? VORTEX_SPIRAL_K * Math.log(rho0 / rho) : 0);
  const lift = TEAR_LIFT * Math.min(ss, TEAR);
  const k = (1 - u) * (1 - u);
  out.x = rho * Math.cos(theta);
  out.z = rho * Math.sin(theta);
  out.y = (h0 + lift) * k;
  out.scale = END_SCALE + (1 - END_SCALE) * smoothstep(VORTEX_EVENT_R, Math.min(rho0, 2.5), rho);
  out.ry = theta - theta0 + w * (theta0 + Math.PI / 2);
  out.rx = w * 0.35 * Math.sin(7 * u);
  out.rz = w * 6 * u * u;
  out.rho = rho;
  out.theta = theta;
  out.u = u;
  out.done = rho <= VORTEX_EVENT_R || ss >= 1;
  return out;
}

/**
 * @typedef {Object} InfallBlock
 * @property {number} id
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} dx0   the cell centre's true offset from the centre (the tear starts exactly on the cell)
 * @property {number} dz0
 * @property {number} rho0
 * @property {number} theta0
 * @property {number} h0
 * @property {number} D
 * @property {number} t
 * @property {number} seed
 * @property {number} tx    seeded tilts
 * @property {number} ty
 * @property {number} tz
 * @property {number} x     the current pose (world)
 * @property {number} y
 * @property {number} z
 * @property {number} rx
 * @property {number} ry
 * @property {number} rz
 * @property {number} scale
 */

/**
 * @typedef {Object} InfallMob
 * @property {'pig'|'zombie'|'animal'} kind   'animal': a cow, sheep, horse or wolf (v0.11, CONTRACTS §72)
 * @property {Body & { renderScale?: number, renderSpin?: number, yaw?: number, height?: number }} body
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} rho0
 * @property {number} theta0
 * @property {number} h0
 * @property {number} half  half the body's height (its middle rides the spiral)
 * @property {number} yaw0
 * @property {number} t
 */

/**
 * @typedef {Object} InfallStep  step's result (the same object every call: read it before the next step)
 * @property {number[]} gone  x, y, z triples: where a block or ghost vanished (the core)
 * @property {{ kind: 'pig'|'zombie'|'animal', body: * }[]} mobsDone  ghosts that finished this step (squeal / knock-out puff now)
 */

export class Infall {
  /** @param {() => number} [random] a [0, 1) generator (seeded angles and tilts); defaults to a fixed-seed mulberry32 */
  constructor(random) {
    this._random = typeof random === 'function' ? random : mulberry32(0x5eed1e55);
    /** @type {InfallBlock[]} oldest first */
    this._blocks = [];
    /** @type {InfallMob[]} oldest first */
    this._mobs = [];
    /** @type {number[]} gone points of blocks finished early (the cap), reported by the next step */
    this._pendingGone = [];
    /** @type {InfallStep} */
    this._result = { gone: [], mobsDone: [] };
    /** @type {InfallPose} */
    this._pose = /** @type {InfallPose} */ ({});
    this._seed = 1;
  }

  /** Blocks and ghosts in flight. */
  get size() {
    return this._blocks.length + this._mobs.length;
  }

  /** Blocks in flight. */
  get blocks() {
    return this._blocks.length;
  }

  /** Mob ghosts in flight. */
  get mobs() {
    return this._mobs.length;
  }

  /** Drop every flight at once (no `gone` points, no mobsDone). */
  clear() {
    this._blocks.length = 0;
    this._mobs.length = 0;
    this._pendingGone.length = 0;
  }

  /**
   * Start an eaten block's flight. Added only when the cell centre is within INFALL_VIEW_RANGE of the eye and the block
   * is meshed (a campfire or a thin circuit part has no cell mesh to copy). At MAX_INFALL_BLOCKS the oldest flight
   * finishes at once (its `gone` point comes with the next step).
   * @param {EatRecord} rec
   * @param {number} eyeX
   * @param {number} eyeY
   * @param {number} eyeZ
   * @returns {boolean} true when a flight was added
   */
  addBlock(rec, eyeX, eyeY, eyeZ) {
    if (!rec || !Number.isFinite(rec.cx + rec.cy + rec.cz)) return false;
    const [px, pz] = hexToWorld(rec.q, rec.r);
    const py = rec.y + 0.5;
    if (!(Math.hypot(px - eyeX, py - eyeY, pz - eyeZ) <= INFALL_VIEW_RANGE)) return false;
    if (!isMeshed(rec.id)) return false;
    if (this._blocks.length >= MAX_INFALL_BLOCKS) {
      const old = /** @type {InfallBlock} */ (this._blocks.shift());
      this._pendingGone.push(old.cx, old.cy, old.cz);
    }
    const dx0 = px - rec.cx;
    const dz0 = pz - rec.cz;
    let rho0 = Math.hypot(dx0, dz0);
    let theta0 = Math.atan2(dz0, dx0);
    if (rho0 < MIN_RHO0) {
      rho0 = MIN_RHO0;
      theta0 = this._random() * Math.PI * 2; // straight above or below the core: it still swirls in
    }
    const h0 = py - rec.cy;
    const rand = this._random;
    /** @type {InfallBlock} */
    const b = {
      id: rec.id, cx: rec.cx, cy: rec.cy, cz: rec.cz, dx0, dz0, rho0, theta0, h0, D: infallDuration(rho0, h0), t: 0,
      seed: (this._seed = (this._seed * 1103515245 + 12345) >>> 0),
      tx: (rand() * 2 - 1) * TILT, ty: (rand() * 2 - 1) * TILT, tz: (rand() * 2 - 1) * TILT,
      x: px, y: py, z: pz, rx: 0, ry: 0, rz: 0, scale: 1,
    };
    this._blocks.push(b);
    return true;
  }

  /**
   * Start a swallowed mob's flight as a ghost (no tear, INFALL_MOB_S long). Main has already removed the mob from its
   * list; it passes `pigs.list` plus `ghosts('pig', …)` to pigRenderer (zombies likewise). Its middle rides the spiral,
   * shrinking from renderScale 1 to 0.1 and spinning (renderSpin). Past MAX_INFALL_MOBS there is no ghost.
   * @param {'pig'|'zombie'|'animal'} kind
   * @param {*} body the removed pig or zombie (x, y, z feet; yaw; height)
   * @param {number} cx the hole's centre
   * @param {number} cy
   * @param {number} cz
   * @returns {boolean} true when a ghost was added
   */
  addMob(kind, body, cx, cy, cz) {
    if (!body || this._mobs.length >= MAX_INFALL_MOBS) return false;
    if (!Number.isFinite(body.x + body.y + body.z + cx + cy + cz)) return false;
    if (this._mobs.some((m) => m.body === body)) return false;
    const half = (body.height > 0 ? body.height : 1) / 2;
    let rho0 = Math.hypot(body.x - cx, body.z - cz);
    let theta0 = Math.atan2(body.z - cz, body.x - cx);
    if (rho0 < MIN_RHO0) {
      rho0 = MIN_RHO0;
      theta0 = this._random() * Math.PI * 2;
    }
    /** @type {InfallMob} */
    const m = { kind, body, cx, cy, cz, rho0, theta0, h0: body.y + half - cy, half, yaw0: Number.isFinite(body.yaw) ? body.yaw : 0, t: 0 };
    this._mobs.push(m);
    this._writeMob(m, 0);
    return true;
  }

  /**
   * Advance every flight by dt (dt ≤ 0 freezes them).
   * @param {number} dt
   * @returns {InfallStep} the same object every call
   */
  step(dt) {
    const res = this._result;
    res.gone.length = 0;
    res.mobsDone.length = 0;
    for (const v of this._pendingGone) res.gone.push(v);
    this._pendingGone.length = 0;
    const d = dt > 0 ? dt : 0;
    let w = 0;
    for (let i = 0; i < this._blocks.length; i++) {
      const b = this._blocks[i];
      b.t += d;
      if (this._poseBlock(b)) {
        res.gone.push(b.cx, b.cy, b.cz);
        continue;
      }
      this._blocks[w++] = b;
    }
    this._blocks.length = w;
    w = 0;
    for (let i = 0; i < this._mobs.length; i++) {
      const m = this._mobs[i];
      m.t += d;
      if (this._writeMob(m, Math.min(1, m.t / INFALL_MOB_S))) {
        res.gone.push(m.cx, m.cy, m.cz);
        res.mobsDone.push({ kind: m.kind, body: m.body });
        continue;
      }
      this._mobs[w++] = m;
    }
    this._mobs.length = w;
    return res;
  }

  /** Pose block `b` at its time; true when its flight is over. */
  _poseBlock(b) {
    const s = Math.min(1, b.t / b.D);
    const p = infallPose(s, b.rho0, b.theta0, b.h0, this._pose);
    if (p.done) return true;
    let x = p.x;
    let z = p.z;
    let y = p.y;
    const wt = smoothstep(0, TEAR, s);
    if (s < TEAR) {
      // The tear starts exactly on the cell (its true offset, even when ρ0 was clamped) and shudders.
      const k = s / TEAR;
      x = b.dx0 + (x - b.dx0) * k;
      z = b.dz0 + (z - b.dz0) * k;
      const amp = TEAR_JITTER * Math.sin(Math.PI * k);
      const frame = Math.floor(b.t * TEAR_JITTER_HZ);
      x += amp * shudder(b.seed, frame, 0);
      y += amp * shudder(b.seed, frame, 1);
      z += amp * shudder(b.seed, frame, 2);
    }
    b.x = b.cx + x;
    b.y = b.cy + y;
    b.z = b.cz + z;
    b.rx = p.rx + wt * b.tx;
    b.ry = p.ry + wt * b.ty;
    b.rz = p.rz + wt * b.tz;
    b.scale = p.scale;
    return false;
  }

  /** Write ghost `m`'s body at progress s (no tear: u = s); true when its flight is over. */
  _writeMob(m, s) {
    const p = infallPose(TEAR + (1 - TEAR) * s, m.rho0, m.theta0, m.h0, this._pose);
    const body = m.body;
    const scale = MOB_END_SCALE + (1 - MOB_END_SCALE) * smoothstep(VORTEX_EVENT_R, Math.min(m.rho0, 2.5), p.rho);
    body.x = m.cx + p.x;
    body.z = m.cz + p.z;
    body.y = m.cy + m.h0 * (1 - p.u) * (1 - p.u) - m.half * scale; // h without the tear's lift
    body.yaw = m.yaw0 + (p.theta - m.theta0);
    body.renderScale = scale;
    body.renderSpin = 6 * p.u * p.u;
    if ('vx' in body) {
      body.vx = 0;
      body.vy = 0;
      body.vz = 0;
    }
    return p.done || s >= 1;
  }

  /**
   * Push every block in flight into fallingRenderer's list (main's pooled push, blockphysics' positional signature).
   * @param {RenderPush} push
   */
  renderItems(push) {
    for (const b of this._blocks) push(b.id, b.x, b.y, b.z, b.rx, b.ry, b.rz, b.scale);
  }

  /**
   * Append the ghost bodies of one kind to `out` (main: `pigs.list` plus the pig ghosts → pigRenderer.sync).
   * @param {'pig'|'zombie'|'animal'} kind
   * @param {*[]} [out]
   * @returns {*[]} out
   */
  ghosts(kind, out = []) {
    for (const m of this._mobs) if (m.kind === kind) out.push(m.body);
    return out;
  }
}
