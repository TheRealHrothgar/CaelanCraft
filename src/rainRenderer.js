// Caelancraft — rain and snow as you see them (CONTRACTS §84.5): streaks falling round the player under the open sky,
// small splashes where they land, slow flakes where it falls as snow. `RainField` is the simulation (plain typed arrays,
// no three); `createRainRenderer` draws it as ONE mesh of quads — one draw call whatever the weather.
//
// A fixed budget: RAIN_MAX_DROPS drops and RAIN_MAX_SPLASHES splashes, made once and reused. A drop is born at the top
// of a cylinder round the eye, in a column whose cover is known (rainColumn, kept for RAIN_COLUMN_TTL_S; at most
// RAIN_COLUMN_SCANS columns are looked at in one update), falls straight down and dies where the rain lands in that
// column: on the roof, on the ground, on the water. So no drop is ever under a roof. Leaves are no roof: LEAF_COVER of
// the drops come through them, the rest stop on the canopy. How many drops live follows the rain's strength.
import * as THREE from 'three';
import { WORLD_HEIGHT } from './config.js';
import { worldToHex } from './hex.js';
import { LEAF_COVER, rainColumn } from './weather.js';

/** Drops alive at once at the most (the pool's size), and splashes. */
export const RAIN_MAX_DROPS = 480;
export const RAIN_MAX_SPLASHES = 48;
/** Drops fall within this many metres of the eye, from this far above it; one that falls this far below it is dropped. */
export const RAIN_RADIUS = 10;
export const RAIN_TOP = 9;
export const RAIN_BELOW = 14;
/** A raindrop: its speed (m/s), the length of its streak and its width (m). */
export const RAIN_SPEED = Object.freeze([13, 17]);
export const RAIN_LENGTH = Object.freeze([0.45, 0.8]);
export const RAIN_WIDTH = 0.028;
/**
 * Near the eye: a streak is never wider than RAIN_NEAR_ANGLE × its distance (about 3 px on a 720-line screen), a flake
 * never larger than SNOW_NEAR_ANGLE × its distance, and within RAIN_NEAR_M both fade toward RAIN_NEAR_ALPHA of their
 * opacity.
 */
export const RAIN_NEAR_ANGLE = 0.005;
export const SNOW_NEAR_ANGLE = 0.02;
export const RAIN_NEAR_M = 3;
export const RAIN_NEAR_ALPHA = 0.3;
/** A snowflake: its speed (m/s), its size (m), how far it sways (m), and how many flakes there are for a raindrop. */
export const SNOW_SPEED = Object.freeze([1.1, 1.9]);
export const SNOW_SIZE = Object.freeze([0.05, 0.09]);
export const SNOW_SWAY = 0.1;
export const SNOW_DENSITY = 0.75;
/** The number of drops is the pool × strength^RAIN_DENSITY_POWER: a light rain is already a visible rain. */
export const RAIN_DENSITY_POWER = 0.7;
/** One landing in SPLASH_EVERY within SPLASH_RANGE metres of the eye makes a splash that lasts SPLASH_S. */
export const SPLASH_EVERY = 3;
export const SPLASH_RANGE = 7;
export const SPLASH_S = 0.22;
export const SPLASH_SIZE = Object.freeze([0.08, 0.3]);
/** Columns looked at (rainColumn) in one update at the most, how long an answer is kept, and how many are kept. */
export const RAIN_COLUMN_SCANS = 8;
export const RAIN_COLUMN_TTL_S = 2;
export const RAIN_COLUMNS_KEPT = 1024;
/** Drops that may be born in one update: the rain thickens over a few frames instead of all at once. */
export const RAIN_BIRTHS = 48;
/** sRGB colours of a raindrop and of a snowflake, and how opaque each is. */
export const RAIN_COLOR = Object.freeze([0.72, 0.8, 0.92]);
export const SNOW_COLOR = Object.freeze([0.97, 0.98, 1]);
export const RAIN_ALPHA = 0.55;
export const SNOW_ALPHA = 0.9;
/** By night the drops keep this part of their brightness. */
export const RAIN_NIGHT_LIGHT = 0.3;

/** Vertices and indices of one quad. */
const QUAD_VERTS = 4;
const QUAD_INDICES = 6;

/**
 * @typedef {Object} RainView  what one update sees
 * @property {number} x  the eye
 * @property {number} y
 * @property {number} z
 * @property {number} intensity  how hard it falls here, 0..1 (0 lets the drops in the air finish their fall)
 * @property {boolean} [snow]    it falls as snow
 * @property {(q: number, y: number, r: number) => number} getBlock
 */

/**
 * The drops and the splashes. Pure: the world is read through `view.getBlock`, every roll through `random`.
 */
export class RainField {
  /** @param {{ random?: () => number, drops?: number, splashes?: number }} [opts] */
  constructor(opts = {}) {
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.max = Math.max(1, Math.floor(opts.drops ?? RAIN_MAX_DROPS));
    this.maxSplashes = Math.max(0, Math.floor(opts.splashes ?? RAIN_MAX_SPLASHES));
    const n = this.max;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    /** where each drop lands */
    this.floor = new Float32Array(n);
    this.speed = new Float32Array(n);
    /** a streak's length, or a flake's size */
    this.size = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.alive = new Uint8Array(n);
    /** 1 for a flake */
    this.flake = new Uint8Array(n);
    this.live = 0;
    const m = this.maxSplashes;
    this.sx = new Float32Array(m);
    this.sy = new Float32Array(m);
    this.sz = new Float32Array(m);
    /** seconds a splash has lasted; Infinity: none (not SPLASH_S, which a Float32Array rounds down to just under itself) */
    this.sAge = new Float32Array(m).fill(Infinity);
    this.nextSplash = 0;
    this.landings = 0;
    /** @type {Map<string, { floor: number, canopy: number, at: number }>} "q,r" → where the rain lands there */
    this.columns = new Map();
    /** the field's own clock (s) */
    this.t = 0;
    /** rainColumn calls made by the last update */
    this.scans = 0;
  }

  /** Splashes showing now. */
  get splashes() {
    let n = 0;
    for (let i = 0; i < this.maxSplashes; i++) if (this.sAge[i] < SPLASH_S) n++;
    return n;
  }

  /** How many drops a strength asks for. @param {number} intensity @param {boolean} [snow] */
  target(intensity, snow = false) {
    const i = intensity > 0 ? Math.min(1, intensity) : 0;
    if (i === 0) return 0;
    return Math.max(1, Math.round(this.max * Math.pow(i, RAIN_DENSITY_POWER) * (snow ? SNOW_DENSITY : 1)));
  }

  /** Everything gone at once (leaving a world). */
  clear() {
    this.alive.fill(0);
    this.live = 0;
    this.sAge.fill(Infinity);
    this.columns.clear();
  }

  /**
   * Where the rain lands in the column of (x, z), from the cache or by looking (while this update may still look).
   * @param {RainView} view @param {number} x @param {number} z
   * @returns {{ floor: number, canopy: number, at: number }|null} null: not known, and no look left this update
   */
  _column(view, x, z) {
    const [q, r] = worldToHex(x, z);
    const key = `${q},${r}`;
    const known = this.columns.get(key);
    if (known && this.t - known.at < RAIN_COLUMN_TTL_S) return known;
    if (this.scans >= RAIN_COLUMN_SCANS) return known ?? null; // an old answer is better than none
    this.scans++;
    const c = rainColumn(view.getBlock, q, r, WORLD_HEIGHT - 1);
    if (this.columns.size >= RAIN_COLUMNS_KEPT) this.columns.clear();
    const entry = { floor: c.floor, canopy: c.canopy, at: this.t };
    this.columns.set(key, entry);
    return entry;
  }

  /**
   * One step: the drops fall, those that land die (some with a splash), and new ones are born at the top while fewer
   * live than the strength asks for. With dt 0 nothing moves.
   * @param {number} dt @param {RainView} view
   */
  update(dt, view) {
    this.scans = 0;
    if (!(dt > 0) || !view) return;
    const step = Math.min(dt, 0.1);
    this.t += step;
    const { x, y, z, floor, speed, size, phase, alive, flake } = this;
    const snow = !!view.snow;
    const want = this.target(view.intensity, snow);
    const top = view.y + RAIN_TOP;
    const reach = (RAIN_RADIUS + 2) * (RAIN_RADIUS + 2);
    for (let i = 0; i < this.maxSplashes; i++) {
      if (this.sAge[i] < SPLASH_S) this.sAge[i] = this.sAge[i] + step < SPLASH_S ? this.sAge[i] + step : Infinity;
    }
    let births = 0;
    for (let i = 0; i < this.max; i++) {
      if (alive[i]) {
        y[i] -= speed[i] * step;
        const dx = x[i] - view.x;
        const dz = z[i] - view.z;
        if (y[i] <= floor[i]) {
          alive[i] = 0;
          this.live--;
          if (!flake[i] && this.maxSplashes > 0 && ++this.landings % SPLASH_EVERY === 0
            && dx * dx + dz * dz <= SPLASH_RANGE * SPLASH_RANGE && Math.abs(floor[i] - view.y) < RAIN_TOP) {
            const s = this.nextSplash;
            this.nextSplash = (s + 1) % this.maxSplashes;
            this.sx[s] = x[i];
            this.sy[s] = floor[i] + 0.02;
            this.sz[s] = z[i];
            this.sAge[s] = 0;
          }
        } else if (dx * dx + dz * dz > reach || y[i] < view.y - RAIN_BELOW) {
          alive[i] = 0;
          this.live--;
        }
        continue;
      }
      if (i >= want || births >= RAIN_BIRTHS) continue;
      births++;
      const a = this.random() * Math.PI * 2;
      const d = RAIN_RADIUS * Math.sqrt(this.random());
      const px = view.x + Math.cos(a) * d;
      const pz = view.z + Math.sin(a) * d;
      const col = this._column(view, px, pz);
      if (!col) continue;
      // leaves let LEAF_COVER of the drops through; the rest stop on the canopy
      const land = col.canopy > col.floor && this.random() >= LEAF_COVER ? col.canopy : col.floor;
      if (!(land < top - 0.5)) continue; // covered from above the cylinder: a roof over the eye, a hillside
      const range = snow ? SNOW_SPEED : RAIN_SPEED;
      const sizes = snow ? SNOW_SIZE : RAIN_LENGTH;
      x[i] = px;
      z[i] = pz;
      speed[i] = range[0] + (range[1] - range[0]) * this.random();
      y[i] = top - this.random() * speed[i] * 0.05;
      floor[i] = land;
      size[i] = sizes[0] + (sizes[1] - sizes[0]) * this.random();
      phase[i] = this.random() * Math.PI * 2;
      flake[i] = snow ? 1 : 0;
      alive[i] = 1;
      this.live++;
    }
  }

  /**
   * Write the quads: four corners (x, y, z) and four alphas for every drop, then for every splash; a drop or splash that
   * is not there collapses to a point with alpha 0. A streak is a thin upright quad turned toward the eye, clear at its
   * tail; a flake a small upright square; a splash a square lying on what the drop hit, growing and fading.
   * @param {Float32Array} positions  (max + maxSplashes) × 12 numbers
   * @param {Float32Array} alphas     (max + maxSplashes) × 4 numbers
   * @param {number} eyeX @param {number} eyeZ
   */
  fill(positions, alphas, eyeX, eyeZ) {
    const { x, y, z, size, phase, alive, flake } = this;
    let p = 0;
    let c = 0;
    for (let i = 0; i < this.max; i++) {
      if (!alive[i]) {
        for (let k = 0; k < 12; k++) positions[p++] = 0;
        for (let k = 0; k < 4; k++) alphas[c++] = 0;
        continue;
      }
      const sway = flake[i] ? Math.sin(this.t * 1.3 + phase[i]) * SNOW_SWAY : 0;
      const cx = x[i] + sway;
      const cz = z[i];
      // a unit vector across the line of sight, level with the ground
      let rx = cz - eyeZ;
      let rz = -(cx - eyeX);
      const len = Math.hypot(rx, rz);
      if (len > 1e-6) {
        rx /= len;
        rz /= len;
      } else {
        rx = 1;
        rz = 0;
      }
      // Near the eye a drop is drawn narrower and fainter (never wider on screen than RAIN_NEAR_ANGLE, a flake than
      // SNOW_NEAR_ANGLE): the few drops right before the face would otherwise be thick bars and blobs.
      const wide = flake[i] ? Math.min(size[i], len * SNOW_NEAR_ANGLE) : Math.min(RAIN_WIDTH, len * RAIN_NEAR_ANGLE);
      const half = wide / 2;
      const tall = flake[i] ? wide : size[i];
      const near = Math.min(1, RAIN_NEAR_ALPHA + (1 - RAIN_NEAR_ALPHA) * (len / RAIN_NEAR_M));
      const y0 = y[i];
      positions[p++] = cx - rx * half; positions[p++] = y0; positions[p++] = cz - rz * half;
      positions[p++] = cx + rx * half; positions[p++] = y0; positions[p++] = cz + rz * half;
      positions[p++] = cx + rx * half; positions[p++] = y0 + tall; positions[p++] = cz + rz * half;
      positions[p++] = cx - rx * half; positions[p++] = y0 + tall; positions[p++] = cz - rz * half;
      alphas[c++] = near;
      alphas[c++] = near;
      alphas[c++] = flake[i] ? near : 0;
      alphas[c++] = flake[i] ? near : 0;
    }
    for (let i = 0; i < this.maxSplashes; i++) {
      const age = this.sAge[i];
      if (!(age < SPLASH_S)) {
        for (let k = 0; k < 12; k++) positions[p++] = 0;
        for (let k = 0; k < 4; k++) alphas[c++] = 0;
        continue;
      }
      const u = age / SPLASH_S;
      const half = (SPLASH_SIZE[0] + (SPLASH_SIZE[1] - SPLASH_SIZE[0]) * u) / 2;
      const sx = this.sx[i];
      const sy = this.sy[i];
      const sz = this.sz[i];
      positions[p++] = sx - half; positions[p++] = sy; positions[p++] = sz - half;
      positions[p++] = sx + half; positions[p++] = sy; positions[p++] = sz - half;
      positions[p++] = sx + half; positions[p++] = sy; positions[p++] = sz + half;
      positions[p++] = sx - half; positions[p++] = sy; positions[p++] = sz + half;
      const a = 1 - u;
      for (let k = 0; k < 4; k++) alphas[c++] = a;
    }
  }
}

/**
 * @typedef {Object} RainRenderer
 * @property {RainField} field
 * @property {THREE.Mesh} mesh
 * @property {(dt: number, view: RainView & { daylight?: number }) => void} update  once a frame (dt 0: frozen)
 * @property {() => number} count   drops in the air
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile the rain's program now, not in the first shower
 * @property {() => void} clear
 * @property {() => void} dispose
 */

/**
 * The rain's mesh: (RAIN_MAX_DROPS + RAIN_MAX_SPLASHES) quads in one geometry, drawn with one unlit, fogged material
 * whose colour is the drop's or the flake's, dimmed by night. Hidden while nothing falls.
 * @param {THREE.Scene} scene
 * @param {{ random?: () => number, drops?: number, splashes?: number }} [opts]
 * @returns {RainRenderer}
 */
export function createRainRenderer(scene, opts = {}) {
  const field = new RainField(opts);
  const quads = field.max + field.maxSplashes;
  const positions = new Float32Array(quads * QUAD_VERTS * 3);
  const colors = new Float32Array(quads * QUAD_VERTS * 4).fill(1);
  const alphas = new Float32Array(quads * QUAD_VERTS);
  const index = new Uint16Array(quads * QUAD_INDICES);
  for (let i = 0; i < quads; i++) {
    const v = i * QUAD_VERTS;
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * QUAD_INDICES);
  }
  const geometry = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', aPos);
  geometry.setAttribute('color', aColor);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, opacity: RAIN_ALPHA, depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3; // with the particles: after the water and the glass
  mesh.name = 'rain';
  mesh.visible = false;
  scene.add(mesh);

  return {
    field,
    mesh,
    update(dt, view) {
      field.update(dt, view);
      const showing = field.live > 0 || field.splashes > 0;
      if (!showing) {
        mesh.visible = false;
        return;
      }
      field.fill(positions, alphas, view.x, view.z);
      for (let i = 0; i < alphas.length; i++) colors[i * 4 + 3] = alphas[i];
      const snow = !!view.snow;
      const base = snow ? SNOW_COLOR : RAIN_COLOR;
      const day = view.daylight === undefined ? 1 : Math.min(1, Math.max(0, view.daylight));
      const light = RAIN_NIGHT_LIGHT + (1 - RAIN_NIGHT_LIGHT) * day;
      material.color.setRGB(base[0] * light, base[1] * light, base[2] * light, THREE.SRGBColorSpace);
      material.opacity = snow ? SNOW_ALPHA : RAIN_ALPHA;
      aPos.needsUpdate = true;
      aColor.needsUpdate = true;
      mesh.visible = true;
    },
    count: () => field.live,
    /**
     * Compile the material while the game loads (as particles.prewarm does), so the first shower does not stall a frame.
     * Never throws; a renderer without compile / compileAsync is left alone.
     */
    prewarm(webgl, camera) {
      try {
        if (webgl && typeof webgl.compileAsync === 'function') {
          return Promise.resolve(webgl.compileAsync(mesh, camera, scene)).then(() => {}, () => {});
        }
        if (webgl && typeof webgl.compile === 'function') webgl.compile(mesh, camera, scene);
      } catch {
        // A failed compile only brings back the one-off compile on first use.
      }
      return Promise.resolve();
    },
    clear() {
      field.clear();
      mesh.visible = false;
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
