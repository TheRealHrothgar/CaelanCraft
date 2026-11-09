// Caelancraft — falling trees: tree test for a floating component, topple simulation (shake, rod dynamics, collision),
// impact, leaf decay. See src/CONTRACTS.md §36 and docs/DESIGN-physics.md §6 / §10. PURE; drawn by fallingRenderer
// through renderItems().
//
// Logs carry, leaves don't: the support search (support.js) never steps from a leaf into a log, so a cut trunk floats
// even when its canopy touches another tree or a hillside. A floating component is a TREE when it is only logs, at
// least 3 of them, in ≤ 2 adjacent (q, r) columns; its leaves are the leaf cells within TREE_LEAF_RADIUS of those
// columns, from the lowest floating log up to the top log + TREE_LEAF_ABOVE, that are not nearer to another log
// column (ties → this tree). Anything else (a log cabin) crumbles.
//
// topple() removes the tree's cells at once (ctx.writeQuiet inside the caller's undo event) and keeps them as ONE
// rigid body rotating about the PIVOT — the top centre of the cut cell — toward one of the six side directions (away
// from a blast or the player, else seeded random): a TREE_SHAKE_S wobble with a creak, then the rod model
// θ'' = (3g / 2h)·sin θ from TREE_THETA0, integrated in TREE_SUBSTEP_S substeps. A log centre entering a solid that is
// not leaves (or an unloaded cell) stops it at the last free pose; else it stops lying flat (θ = π/2). IMPACT: the
// leaves burst into leaf particles, every log becomes a column faller at the cell its centre is in (the next free cell
// toward the pivot when taken), so the trunk ends up lying on the ground; bodies near a landing log are knocked; thud.
// Leaves left with no log within LEAF_DECAY_RANGE decay (removed over LEAF_DECAY_S with leaf particles), and so do
// natural leaves next to the felled tree left hanging from nothing (a trunk felled earlier, lying on the ground below,
// kept them from both the tree and that rule). At most
// TREE_MAX_TOPPLING fall at once; more wait (already out of the world, drawn standing) TREE_QUEUE_GAP_S apart.
import {
  GRAVITY, WORLD_HEIGHT, TREE_MAX_CELLS, TREE_MAX_TOPPLING, TREE_QUEUE_GAP_S, TREE_SHAKE_S, TREE_THETA0, TREE_CAUSE_RANGE,
  TREE_LEAF_RADIUS, TREE_LEAF_ABOVE, TREE_MAX_QUEUED, TREE_SHAKE_ANGLE, TREE_SHAKE_WOBBLES, TREE_SUBSTEP_S,
  TREE_KNOCK_RADIUS, TREE_KNOCK_SPEED, TREE_KNOCK_UP, TREE_LEAF_PARTICLES, LEAF_DECAY_RANGE, LEAF_DECAY_S,
} from './config.js';
import { BLOCK, UNLOADED, isFallThrough, isLeaves, isLog, isSolid } from './blocks.js';
import { FACE_NORMALS, HEX_DIRS, HEX_ROW_SPACING, hexLength, worldToHex } from './hex.js';
import { packCell } from './coords.js';
import { bodyHeight } from './physics.js';
import { isLoadBearing } from './support.js';

/** @typedef {import('./blockphysics.js').BlockPhysics} BlockPhysics */
/** @typedef {import('./blockphysics.js').Cause} Cause */
/** @typedef {import('./blockphysics.js').SaveOverlay} SaveOverlay */
/** @typedef {import('./support.js').FloatingComponent} FloatingComponent */

/**
 * What `test` found: the tree's cells and where it pivots.
 * @typedef {Object} TreeInfo
 * @property {number[][]} logs     [q, y, r, id][] lowest first
 * @property {number[][]} leaves   [q, y, r, id][]
 * @property {number[]} cut        [q, y, r] the cell below the lowest floating log (the stump / removed cell)
 * @property {number[]} pivot      [x, y, z] WORLD position of the top centre of the cut cell
 */

/**
 * A tree out of the world: waiting for a slot, shaking or falling. Cells 0 … nLogs−1 are its logs (lowest first),
 * the rest its leaves; `offsets` holds each cell centre minus the pivot.
 * @typedef {Object} ToppleJob
 * @property {number[]} ids
 * @property {Float64Array} offsets  [ox, oy, oz] per cell
 * @property {number} nLogs
 * @property {number} px            pivot (world)
 * @property {number} py
 * @property {number} pz
 * @property {number} pq            pivot column (frozen while it is unloaded)
 * @property {number} pr
 * @property {number} dir           side direction 0..5 it falls toward
 * @property {number} kx            rotation axis (horizontal, ⟂ dir): up × dir = (dz, 0, −dx)
 * @property {number} kz
 * @property {number} rodK          3g / 2h
 * @property {number} phase         PHASE_QUEUED | PHASE_SHAKE | PHASE_FALL
 * @property {number} t             seconds shaking
 * @property {number} theta         tilt, rad
 * @property {number} omega         rad/s
 * @property {number} event         physics event its landings record into (0 = none)
 */

/** A leaf waiting to decay. @typedef {{ q: number, y: number, r: number, id: number, t: number, event: number }} LeafDecay */

const PHASE_QUEUED = 0;
const PHASE_SHAKE = 1;
const PHASE_FALL = 2;
const HALF_PI = Math.PI / 2;
/** 8-neighbourhood as [dq, dy, dr]. */
const NEIGHBOURS = Object.freeze([
  ...HEX_DIRS.map(([dq, dr]) => Object.freeze([dq, 0, dr])), Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
]);
/** Snapping a log toward the pivot tries points this far apart along the trunk axis. */
const SNAP_STEP = 0.35;

/**
 * Euler angles (order 'YXZ', three.js convention) of a rotation by `theta` about the horizontal unit axis (kx, 0, kz)
 * — the tilt of a toppling tree. Rodrigues' matrix, decomposed like `Euler.setFromRotationMatrix(m, 'YXZ')`.
 * @param {number} kx
 * @param {number} kz
 * @param {number} theta
 * @param {number[]} [out]
 * @returns {number[]} [rx, ry, rz]
 */
export function tiltEuler(kx, kz, theta, out = [0, 0, 0]) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  const m23 = -s * kx;
  out[0] = Math.asin(Math.max(-1, Math.min(1, -m23)));
  if (Math.abs(m23) < 0.9999999) {
    out[1] = Math.atan2(t * kx * kz, c + t * kz * kz);
    out[2] = Math.atan2(s * kz, c);
  } else {
    out[1] = Math.atan2(-t * kx * kz, c + t * kx * kx);
    out[2] = 0;
  }
  return out;
}

/** @returns {number} tilt during the shake: TREE_THETA0 eased in, plus TREE_SHAKE_WOBBLES whole wobbles of ±TREE_SHAKE_ANGLE */
export function shakeAngle(t) {
  const u = Math.max(0, Math.min(1, t / TREE_SHAKE_S));
  return TREE_THETA0 * u * u + TREE_SHAKE_ANGLE * Math.sin(2 * Math.PI * TREE_SHAKE_WOBBLES * u);
}

export class Trees {
  /** @param {BlockPhysics} physics */
  constructor(physics) {
    this.physics = physics;
    /** at most this many topple at once; the rest wait in a queue (TREE_QUEUE_GAP_S apart) */
    this.maxToppling = TREE_MAX_TOPPLING;
    /** @type {ToppleJob[]} shaking or falling */
    this._active = [];
    /** @type {number[]} scratch: the landing height of each impact cell (_impact) */
    this._lands = [];
    /** @type {ToppleJob[]} out of the world, waiting for a slot */
    this._queue = [];
    this._gap = 0;
    /** @type {LeafDecay[]} */
    this._decays = [];
    /** @type {Set<number>} packed cells of _decays */
    this._decayKeys = new Set();
    this._euler = [0, 0, 0];
    this._p = [0, 0, 0];
    /** counters for tests / diagnostics */
    this.stats = { toppled: 0, impacts: 0, decayed: 0 };
  }

  /** @returns {number} trees toppling or queued */
  get count() {
    return this._active.length + this._queue.length;
  }

  /** @returns {number} leaves waiting to decay */
  get decayCount() {
    return this._decays.length;
  }

  /**
   * The trees out of the world, falling first, then waiting (read-only view for tests / diagnostics).
   * @returns {{ dir: number, phase: 'queued'|'shake'|'fall', theta: number, logs: number, cells: number, event: number }[]}
   */
  get jobs() {
    const name = ['queued', 'shake', 'fall'];
    return [...this._active, ...this._queue].map((j) => ({
      dir: j.dir, phase: /** @type {'queued'|'shake'|'fall'} */ (name[j.phase]), theta: this._angle(j), logs: j.nLogs,
      cells: j.ids.length, event: j.event,
    }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // tree test

  /**
   * Is this floating component a tree? Only logs, ≥ 3 of them, in ≤ 2 adjacent columns, and ≤ TREE_MAX_CELLS cells
   * with its leaves.
   * @param {FloatingComponent} component
   * @returns {TreeInfo|null}
   */
  test(component) {
    const cells = component && component.cells;
    if (!Array.isArray(cells) || cells.length < 3 || cells.length > TREE_MAX_CELLS) return null;
    /** @type {number[][]} distinct [q, r] log columns */
    const cols = [];
    for (const c of cells) {
      if (!isLog(c[3])) return null;
      if (!cols.some((col) => col[0] === c[0] && col[1] === c[2])) {
        if (cols.length === 2) return null;
        cols.push([c[0], c[2]]);
      }
    }
    if (cols.length === 2 && hexLength(cols[0][0] - cols[1][0], cols[0][1] - cols[1][1]) !== 1) return null;
    const logs = cells.map((c) => [c[0], c[1], c[2], c[3]]).sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    const ylo = logs[0][1];
    const yhi = logs[logs.length - 1][1];
    const leaves = this._ownLeaves(cols, ylo, yhi);
    if (logs.length + leaves.length > TREE_MAX_CELLS) return null;
    const [cq, , cr] = logs[0];
    return { logs, leaves, cut: [cq, ylo - 1, cr], pivot: [cq + cr / 2, ylo, cr * HEX_ROW_SPACING] };
  }

  /** Leaf cells within TREE_LEAF_RADIUS of the columns, y in [ylo, yhi + TREE_LEAF_ABOVE], not nearer another log column. */
  _ownLeaves(cols, ylo, yhi) {
    const peek = this.physics.ctx.peek;
    const R = TREE_LEAF_RADIUS;
    const y1 = Math.min(yhi + TREE_LEAF_ABOVE, WORLD_HEIGHT - 1);
    /** @type {number[][]} */
    const out = [];
    const seen = new Set();
    for (const [cq, cr] of cols) {
      for (let dq = -R; dq <= R; dq++) {
        for (let dr = -R; dr <= R; dr++) {
          if (hexLength(dq, dr) > R) continue;
          const q = cq + dq;
          const r = cr + dr;
          const ck = packCell(q, 0, r);
          if (seen.has(ck)) continue;
          seen.add(ck);
          let dOwn = Infinity;
          for (const col of cols) dOwn = Math.min(dOwn, hexLength(q - col[0], r - col[1]));
          for (let y = ylo; y <= y1; y++) {
            const id = peek(q, y, r);
            if (isLeaves(id) && !this._foreignLogNearer(q, y, r, dOwn, cols)) out.push([q, y, r, id]);
          }
        }
      }
    }
    return out;
  }

  /** @returns {boolean} a log column other than `cols` is strictly nearer to leaf (q, y, r) than dOwn */
  _foreignLogNearer(q, y, r, dOwn, cols) {
    const peek = this.physics.ctx.peek;
    const R = dOwn - 1;
    for (let dq = -R; dq <= R; dq++) {
      for (let dr = -R; dr <= R; dr++) {
        if (hexLength(dq, dr) > R) continue;
        const nq = q + dq;
        const nr = r + dr;
        if (cols.some((col) => col[0] === nq && col[1] === nr)) continue;
        for (let yy = Math.max(0, y - TREE_LEAF_ABOVE); yy <= Math.min(WORLD_HEIGHT - 1, y + TREE_LEAF_ABOVE); yy++) {
          if (isLog(peek(nq, yy, nr))) return true;
        }
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // topple

  /**
   * Start (or queue) the topple: removes the tree's cells from the world quietly (recorded into `opts.event`) and
   * animates it. Refuses (→ the caller crumbles it) beyond TREE_MAX_CELLS, when TREE_MAX_QUEUED trees already wait,
   * or when none of its logs could be removed (the edit cap).
   * @param {TreeInfo} tree
   * @param {FloatingComponent} component
   * @param {{ cause?: Cause, event?: number }} [opts]
   * @returns {boolean} the tree will topple (false → crumble it)
   */
  topple(tree, component, opts = {}) {
    if (!tree || !Array.isArray(tree.logs) || tree.logs.length === 0 || !Array.isArray(tree.leaves)) return false;
    if (tree.logs.length + tree.leaves.length > TREE_MAX_CELLS) return false;
    const wait = this._active.length >= this.maxToppling || this._queue.length > 0;
    if (wait && this._queue.length >= TREE_MAX_QUEUED) return false;
    const job = this._makeJob(tree, opts.cause ?? (component && component.cause) ?? null, opts.event ?? this.physics.openEventId);
    if (job === null) return false;
    this.stats.toppled++;
    if (wait) this._queue.push(job);
    else this._begin(job);
    return true;
  }

  /** Remove the tree's cells, measure it and pick its direction. @returns {ToppleJob|null} null: no log removed */
  _makeJob(tree, cause, event) {
    const physics = this.physics;
    const ctx = physics.ctx;
    /** @type {number[][]} */
    const logs = [];
    /** @type {number[][]} */
    const leaves = [];
    const token = physics.enterEvent(event);
    try {
      for (const c of tree.logs) if (ctx.peek(c[0], c[1], c[2]) === c[3] && ctx.writeQuiet(c[0], c[1], c[2], BLOCK.AIR) === 'ok') logs.push(c);
      if (logs.length === 0) return null;
      for (const c of tree.leaves) if (ctx.peek(c[0], c[1], c[2]) === c[3] && ctx.writeQuiet(c[0], c[1], c[2], BLOCK.AIR) === 'ok') leaves.push(c);
    } finally {
      physics.exitEvent(token);
    }
    const [px, py, pz] = tree.pivot;
    const n = logs.length + leaves.length;
    const ids = new Array(n);
    const offsets = new Float64Array(n * 3);
    let top = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = i < logs.length ? logs[i] : leaves[i - logs.length];
      ids[i] = c[3];
      offsets[i * 3] = c[0] + c[2] / 2 - px;
      offsets[i * 3 + 1] = c[1] + 0.5 - py;
      offsets[i * 3 + 2] = c[2] * HEX_ROW_SPACING - pz;
      if (i < logs.length) top = Math.max(top, c[1] + 1);
    }
    const dir = this._direction(px, py, pz, cause);
    const [dx, , dz] = FACE_NORMALS[dir];
    /** @type {ToppleJob} */
    const job = {
      ids, offsets, nLogs: logs.length, px, py, pz, pq: tree.cut[0], pr: tree.cut[2], dir, kx: dz, kz: -dx,
      rodK: (3 * Math.abs(GRAVITY)) / (2 * Math.max(1, top - py)), phase: PHASE_QUEUED, t: 0, theta: 0, omega: 0, event,
    };
    this._decayOrphans(logs, event);
    // A canopy leaf a trunk lying on the ground nearby kept from both rules above (it is "nearer another log", which
    // holds nothing up) would float: natural leaf clusters next to the removed cells that touch nothing load-bearing
    // decay too. Natural only — a player's leaves are never taken by this.
    this.decayHangingLeaves([...logs, ...leaves], { event, naturalOnly: true });
    return job;
  }

  /**
   * The side direction (0..5) closest to "away from the cause": away from a blast centre; else away from the player
   * when within TREE_CAUSE_RANGE (the cause's position for a player cause, else where the player is now); else seeded
   * random.
   */
  _direction(px, py, pz, cause) {
    let vx = 0;
    let vz = 0;
    if (cause && cause.kind === 'explosion' && Number.isFinite(cause.x) && Number.isFinite(cause.z)) {
      vx = px - /** @type {number} */ (cause.x);
      vz = pz - /** @type {number} */ (cause.z);
    }
    if (vx * vx + vz * vz < 1e-9) {
      const fromCause = cause && cause.kind === 'player' && Number.isFinite(Number(cause.x) + Number(cause.y) + Number(cause.z));
      const p = fromCause ? cause : this.physics.hooks.player();
      if (p && Number.isFinite(p.x + p.y + p.z) && Math.hypot(px - p.x, py - p.y, pz - p.z) <= TREE_CAUSE_RANGE) {
        vx = px - p.x;
        vz = pz - p.z;
      }
    }
    if (vx * vx + vz * vz < 1e-9) return Math.min(5, Math.floor(this.physics.ctx.random() * 6));
    let best = 0;
    let bestDot = -Infinity;
    for (let j = 0; j < 6; j++) {
      const d = FACE_NORMALS[j][0] * vx + FACE_NORMALS[j][2] * vz;
      if (d > bestDot) {
        bestDot = d;
        best = j;
      }
    }
    return best;
  }

  /** A slot is free: shake (and creak). */
  _begin(job) {
    job.phase = PHASE_SHAKE;
    job.t = 0;
    const mid = this._rodLength(job) / 2;
    this.physics.ctx.sound('creak', job.px, job.py + mid, job.pz);
    this._active.push(job);
  }

  _rodLength(job) {
    return (3 * Math.abs(GRAVITY)) / (2 * job.rodK);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // per frame

  /** Advance toppling trees (shake, rod dynamics, impact) and decaying leaves by dt. */
  step(dt) {
    if (!(dt > 0)) return;
    if (this._queue.length > 0) {
      this._gap -= dt;
      while (this._queue.length > 0 && this._active.length < this.maxToppling && this._gap <= 0) {
        this._begin(/** @type {ToppleJob} */ (this._queue.shift()));
        this._gap = TREE_QUEUE_GAP_S;
      }
    } else {
      this._gap = 0;
    }
    const world = this.physics.world;
    for (let i = this._active.length - 1; i >= 0; i--) {
      const job = this._active[i];
      if (!world.hasChunkAtCell(job.pq, job.pr)) continue; // frozen while its chunk is unloaded
      if (this._advance(job, dt)) {
        this._active.splice(i, 1);
        this._impact(job);
      }
    }
    this._stepDecays(dt);
  }

  /** @returns {boolean} the tree hit something or lies flat (impact now) */
  _advance(job, dt) {
    if (job.phase === PHASE_SHAKE) {
      job.t += dt;
      if (job.t < TREE_SHAKE_S) return false;
      job.phase = PHASE_FALL;
      job.theta = TREE_THETA0;
      job.omega = 0;
      return this._hits(job, job.theta);
    }
    const n = Math.max(1, Math.ceil(dt / TREE_SUBSTEP_S));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      job.omega += job.rodK * Math.sin(job.theta) * h;
      let next = job.theta + job.omega * h;
      const flat = next >= HALF_PI;
      if (flat) next = HALF_PI;
      if (this._hits(job, next)) return true; // stop at the last free pose
      job.theta = next;
      if (flat) return true;
    }
    return false;
  }

  /** @returns {number} the job's current tilt */
  _angle(job) {
    if (job.phase === PHASE_SHAKE) return shakeAngle(job.t);
    if (job.phase === PHASE_FALL) return job.theta;
    return 0;
  }

  /**
   * World centre of cell i of the job at tilt (cos c, sin s): pivot + R·offset (Rodrigues about the axis k).
   * @returns {number[]} this._p
   */
  _pose(job, i, c, s) {
    const o = job.offsets;
    const ox = o[i * 3];
    const oy = o[i * 3 + 1];
    const oz = o[i * 3 + 2];
    const kx = job.kx;
    const kz = job.kz;
    const kd = (kx * ox + kz * oz) * (1 - c);
    const p = this._p;
    p[0] = job.px + ox * c - kz * oy * s + kx * kd;
    p[1] = job.py + oy * c + (kz * ox - kx * oz) * s;
    p[2] = job.pz + oz * c + kx * oy * s + kz * kd;
    return p;
  }

  /** @returns {boolean} some log centre at tilt theta is inside a solid that is not leaves (or an unloaded cell) */
  _hits(job, theta) {
    const peek = this.physics.ctx.peek;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let i = 0; i < job.nLogs; i++) {
      const p = this._pose(job, i, c, s);
      const y = Math.floor(p[1]);
      if (y < 0) return true;
      if (y >= WORLD_HEIGHT) continue;
      const [q, r] = worldToHex(p[0], p[2]);
      const id = peek(q, y, r);
      if (id === UNLOADED || (isSolid(id) && !isLeaves(id))) return true;
    }
    return false;
  }

  /**
   * The cell each log lands in at tilt theta: the cell its centre is in, else the first free one stepping toward the
   * pivot, else the first free one up the pivot column. Free = fall-through per `peek` and not taken by another log.
   * @param {ToppleJob} job
   * @param {number} theta
   * @param {(q: number, y: number, r: number) => number} peek
   * @returns {number[][]} [q, y, r, id][]
   */
  _snap(job, theta, peek) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const taken = new Set();
    /** @type {number[][]} */
    const out = [];
    const tryCell = (x, yf, z, id) => {
      const y = Math.floor(yf);
      if (y < 0 || y >= WORLD_HEIGHT) return false;
      const [q, r] = worldToHex(x, z);
      const k = packCell(q, y, r);
      if (taken.has(k) || !isFallThrough(peek(q, y, r))) return false;
      taken.add(k);
      out.push([q, y, r, id]);
      return true;
    };
    for (let i = 0; i < job.nLogs; i++) {
      const id = job.ids[i];
      const p = this._pose(job, i, c, s);
      const x = p[0];
      const y = p[1];
      const z = p[2];
      const len = Math.hypot(x - job.px, y - job.py, z - job.pz);
      let placed = false;
      for (let d = len; d >= 0 && !placed; d -= SNAP_STEP) {
        const f = len > 0 ? d / len : 0;
        placed = tryCell(job.px + (x - job.px) * f, job.py + (y - job.py) * f, job.pz + (z - job.pz) * f, id);
      }
      for (let cy = Math.floor(job.py); cy < WORLD_HEIGHT && !placed; cy++) placed = tryCell(job.px, cy, job.pz, id);
    }
    return out;
  }

  /**
   * Impact: logs → column fallers at their cells (they drop to the ground lying along the fall direction), leaves →
   * a burst of leaf particles, bodies near a landing log knocked away, one thud.
   */
  _impact(job) {
    const physics = this.physics;
    const ctx = physics.ctx;
    this.stats.impacts++;
    const cells = this._snap(job, job.theta, ctx.peek);
    for (const [q, y, r, id] of cells) ctx.fallers.spawn(id, q, y, r, { event: job.event });

    const c = Math.cos(job.theta);
    const s = Math.sin(job.theta);
    const nLeaves = job.ids.length - job.nLogs;
    if (nLeaves > 0) {
      const per = Math.max(1, Math.floor(TREE_LEAF_PARTICLES / nLeaves));
      for (let i = job.nLogs; i < job.ids.length; i++) {
        const p = this._pose(job, i, c, s);
        ctx.particles('leaves', p[0], p[1], p[2], per, { id: job.ids[i], spread: 0.6 });
      }
    }

    const bodies = physics.hooks.bodies();
    if (bodies && bodies.length > 0) {
      // Each log's drop path: from its cell down to the cell it lands in. A tree cut at eye level lies well above the
      // bodies it then drops onto, so testing the lying pose alone missed them (they were lifted onto the trunk, G7).
      const lands = this._lands;
      lands.length = 0;
      for (const [q, y, r] of cells) {
        let ly = y;
        while (ly > 0 && isFallThrough(ctx.peek(q, ly - 1, r))) ly--;
        lands.push(ly);
      }
      for (const b of bodies) {
        if (!b) continue;
        const by = b.y + bodyHeight(b) / 2;
        for (let k = 0; k < cells.length; k++) {
          const [q, y, r] = cells[k];
          const lx = q + r / 2;
          const lz = r * HEX_ROW_SPACING;
          const py = Math.min(Math.max(by, lands[k] + 0.5), y + 0.5); // nearest point of the path to the body's middle
          if (Math.hypot(b.x - lx, by - py, b.z - lz) >= TREE_KNOCK_RADIUS) continue;
          let hx = b.x - lx;
          let hz = b.z - lz;
          const hl = Math.hypot(hx, hz);
          if (hl < 1e-6) {
            hx = -job.kz; // the fall direction (dx, dz) = (−kz, kx)
            hz = job.kx;
          } else {
            hx /= hl;
            hz /= hl;
          }
          physics.hooks.knock(b, hx * TREE_KNOCK_SPEED, TREE_KNOCK_UP, hz * TREE_KNOCK_SPEED, lx, lz);
          break; // once per body
        }
      }
    }
    if (job.nLogs > 0) {
      const p = this._pose(job, job.nLogs >> 1, c, s);
      ctx.sound('thud', p[0], p[1], p[2]);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // leaf decay

  /**
   * After a topple: leaves within LEAF_DECAY_RANGE of the removed logs that now have no log within LEAF_DECAY_RANGE
   * (hex distance and |dy|) decay.
   * @param {number[][]} logs  removed logs [q, y, r, id]
   */
  _decayOrphans(logs, event) {
    const peek = this.physics.ctx.peek;
    const R = LEAF_DECAY_RANGE;
    /** @type {number[][]} distinct [q, r] */
    const cols = [];
    let ylo = Infinity;
    let yhi = -Infinity;
    for (const c of logs) {
      if (!cols.some((col) => col[0] === c[0] && col[1] === c[2])) cols.push([c[0], c[2]]);
      ylo = Math.min(ylo, c[1]);
      yhi = Math.max(yhi, c[1]);
    }
    // Logs still standing nearby (other trunks, builds): within 2R of the columns, |dy| ≤ 2R of the removed span.
    /** @type {number[][]} */
    const near = [];
    const nearCols = new Set();
    const y0 = Math.max(0, ylo - 2 * R);
    const y1 = Math.min(WORLD_HEIGHT - 1, yhi + 2 * R);
    for (const [cq, cr] of cols) {
      for (let dq = -2 * R; dq <= 2 * R; dq++) {
        for (let dr = -2 * R; dr <= 2 * R; dr++) {
          if (hexLength(dq, dr) > 2 * R) continue;
          const ck = packCell(cq + dq, 0, cr + dr);
          if (nearCols.has(ck)) continue;
          nearCols.add(ck);
          for (let y = y0; y <= y1; y++) if (isLog(peek(cq + dq, y, cr + dr))) near.push([cq + dq, y, cr + dr]);
        }
      }
    }
    const seen = new Set();
    for (const [cq, cr] of cols) {
      for (let dq = -R; dq <= R; dq++) {
        for (let dr = -R; dr <= R; dr++) {
          if (hexLength(dq, dr) > R) continue;
          const q = cq + dq;
          const r = cr + dr;
          const ck = packCell(q, 0, r);
          if (seen.has(ck)) continue;
          seen.add(ck);
          for (let y = Math.max(0, ylo - R); y <= Math.min(WORLD_HEIGHT - 1, yhi + R); y++) {
            const id = peek(q, y, r);
            if (!isLeaves(id)) continue;
            if (near.some((l) => Math.abs(l[1] - y) <= R && hexLength(l[0] - q, l[2] - r) <= R)) continue;
            this._queueDecay(q, y, r, id, event);
          }
        }
      }
    }
  }

  /**
   * After a crumble (support.js) or a topple (`naturalOnly`): leaves that hung only from the removed cells decay —
   * every cluster of leaves next to `cells` (connected through leaves, ≤ TREE_MAX_CELLS) that touches no load-bearing
   * cell (and no unloaded one). A hedge on the ground or a canopy held by its trunk stays.
   * @param {number[][]} cells  the removed cells [q, y, r, …] (already AIR)
   * @param {{ event?: number, naturalOnly?: boolean }} [opts]  naturalOnly: queue only cells with no edit (never a
   *        player's leaves; they still count as part of their cluster)
   * @returns {number} leaves queued to decay
   */
  decayHangingLeaves(cells, opts = {}) {
    const peek = this.physics.ctx.peek;
    const event = opts.event ?? this.physics.openEventId;
    const world = this.physics.world;
    const naturalOnly = opts.naturalOnly === true;
    /** @type {Map<number, boolean>} packed leaf cell → its cluster is held */
    const verdict = new Map();
    let queued = 0;
    for (const c of cells) {
      for (const [dq, dy, dr] of NEIGHBOURS) {
        const sq = c[0] + dq;
        const sy = c[1] + dy;
        const sr = c[2] + dr;
        if (!(sy >= 0 && sy < WORLD_HEIGHT)) continue;
        const sk = packCell(sq, sy, sr);
        if (verdict.has(sk) || !isLeaves(peek(sq, sy, sr))) continue;
        // Flood the cluster through leaves until something holds it.
        const visited = new Set([sk]);
        /** @type {number[][]} */
        const cluster = [[sq, sy, sr, peek(sq, sy, sr)]];
        const stack = [cluster[0]];
        let held = false;
        while (stack.length > 0 && !held) {
          const [q, y, r] = /** @type {number[]} */ (stack.pop());
          for (const [eq, ey, er] of NEIGHBOURS) {
            const nq = q + eq;
            const ny = y + ey;
            const nr = r + er;
            if (!(ny >= 0 && ny < WORLD_HEIGHT)) continue;
            const nk = packCell(nq, ny, nr);
            if (visited.has(nk)) continue;
            const id = peek(nq, ny, nr);
            if (id === UNLOADED || isLoadBearing(id) || verdict.get(nk) === true) {
              held = true;
              break;
            }
            if (!isLeaves(id)) continue;
            if (cluster.length >= TREE_MAX_CELLS) {
              held = true;
              break;
            }
            visited.add(nk);
            const cell = [nq, ny, nr, id];
            cluster.push(cell);
            stack.push(cell);
          }
        }
        for (const k of visited) verdict.set(k, held);
        if (held) continue;
        for (const [q, y, r, id] of cluster) {
          if (naturalOnly && world.hasEdit(q, y, r)) continue;
          if (this._queueDecay(q, y, r, id, event)) queued++;
        }
      }
    }
    return queued;
  }

  /** @returns {boolean} queued (each cell once) */
  _queueDecay(q, y, r, id, event) {
    const k = packCell(q, y, r);
    if (this._decayKeys.has(k)) return false;
    this._decayKeys.add(k);
    this._decays.push({ q, y, r, id, t: LEAF_DECAY_S * (0.15 + 0.85 * this.physics.ctx.random()), event });
    return true;
  }

  _stepDecays(dt) {
    const list = this._decays;
    if (list.length === 0) return;
    const physics = this.physics;
    const ctx = physics.ctx;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      d.t -= dt;
      if (d.t > 0) continue;
      list[i] = list[list.length - 1];
      list.pop();
      this._decayKeys.delete(packCell(d.q, d.y, d.r));
      if (ctx.peek(d.q, d.y, d.r) !== d.id) continue; // changed (or unloaded) meanwhile
      const token = physics.enterEvent(d.event);
      const res = ctx.writeQuiet(d.q, d.y, d.r, BLOCK.AIR);
      physics.exitEvent(token);
      if (res !== 'ok') continue;
      this.stats.decayed++;
      ctx.particles('leaves', d.q + d.r / 2, d.y + 0.5, d.r * HEX_ROW_SPACING, 4, { id: d.id, spread: 0.5 });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // drawing, saving, undo

  /**
   * Push the toppling (and waiting) trees' logs and leaves: block id, cell centre, rotation Euler 'YXZ', scale.
   * @param {(id: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number, scale?: number) => void} push
   */
  renderItems(push) {
    for (const list of [this._active, this._queue]) {
      for (const job of list) {
        const theta = this._angle(job);
        const e = tiltEuler(job.kx, job.kz, theta, this._euler);
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        for (let i = 0; i < job.ids.length; i++) {
          const p = this._pose(job, i, c, s);
          push(job.ids[i], p[0], p[1], p[2], e[0], e[1], e[2], 1);
        }
      }
    }
  }

  /**
   * Saving (never touches the live world): each toppling / waiting tree's logs dropped from their current pose
   * (snapped like an impact, then down their columns, lowest first); leaves waiting to decay are saved as AIR. The
   * leaves of a toppling tree are not saved (they burst on impact).
   * @param {SaveOverlay} overlay
   */
  settleInto(overlay) {
    const peek = (q, y, r) => overlay.peek(q, y, r);
    for (const list of [this._active, this._queue]) {
      for (const job of list) {
        const cells = this._snap(job, this._angle(job), peek).sort((a, b) => a[1] - b[1]);
        for (const [q, y, r, id] of cells) {
          let cy = y;
          if (overlay.peek(q, cy, r) === UNLOADED) continue;
          while (cy < WORLD_HEIGHT && !isFallThrough(overlay.peek(q, cy, r))) cy++;
          while (cy >= 0 && isFallThrough(overlay.peek(q, cy - 1, r))) cy--;
          if (cy >= 0 && cy < WORLD_HEIGHT) overlay.set(q, cy, r, id);
        }
      }
    }
    for (const d of this._decays) if (overlay.peek(d.q, d.y, d.r) === d.id) overlay.set(d.q, d.y, d.r, BLOCK.AIR);
  }

  /** Undo: drop the trees (toppling or waiting) and leaf decays of event `id`. @returns {number} trees removed */
  cancelEvent(id) {
    if (!(id > 0)) return 0;
    let n = 0;
    for (const list of [this._active, this._queue]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].event === id) {
          list.splice(i, 1);
          n++;
        }
      }
    }
    for (let i = this._decays.length - 1; i >= 0; i--) {
      const d = this._decays[i];
      if (d.event !== id) continue;
      this._decayKeys.delete(packCell(d.q, d.y, d.r));
      this._decays.splice(i, 1);
    }
    return n;
  }

  /** Drop everything in flight (the world is unchanged). */
  reset() {
    this._active.length = 0;
    this._queue.length = 0;
    this._decays.length = 0;
    this._decayKeys.clear();
    this._gap = 0;
  }

  /**
   * The 'collapse' switch changed. Nothing to do: trees already out of the world (falling or waiting) finish their
   * fall either way — dropping them would delete them — and the scheduler stops new seeds.
   */
  onSwitch(_on) {}
}
