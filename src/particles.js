// Caelancraft — one particle system for every physics effect: dust (a block's colour), leaves, smoke, sparks, steam and
// the black holes' infall (three). See src/CONTRACTS.md §34.5 and docs/DESIGN-circuits.md §6.2.10.
//
// ONE THREE.Points of PARTICLE_CAPACITY points — one draw call whatever the load; when it is full the oldest particle
// is overwritten. Simulation is plain typed arrays on the CPU (velocity, gravity, drag, growth, life); the shader
// draws soft round points sized in world units and fogged like the terrain. Colours are sRGB in the API and converted
// to the linear working space on emit. prewarm() compiles the shader while the game loads (like campfireRenderer), so
// the first particle of a session does not compile it mid-frame.
//
// Orbit particles (emitOrbit, DESIGN-circuits §6.2.10) share the same ring and the same Points. Instead of a velocity
// they keep a centre, a radius ρ, an angle θ and a height, and spiral INTO the centre at the vortex's own inflow:
// dρ/dt = −1.2·inward/√ρ and dθ/dt = min(12, 4·spin·ρ^−1.5) — the disk's dashes and arms (vortexMath) and the eaten
// blocks (infall.js) follow the same spiral. Each one's life is set at emission so that it reaches the core, where it
// dies (ρ < 0.45). `emit` clears a slot's orbit flag, so a smoke particle written into a recycled orbit slot flies
// ballistically, never around a stale centre.
import * as THREE from 'three';
import { PARTICLE_CAPACITY, VORTEX_INFLOW, VORTEX_EVENT_R } from './config.js';
import { BIOME, FACE_TOP, getBlockDef, getFaceTile } from './blocks.js';
import { averageColor } from './tiles.js';
import { BIOME_TINT, isTintedFace } from './mesher.js';

/**
 * Per kind: life [min, max] s, outward speed, upward speed [min, max], gravity (m/s², + rises), drag (1/s), size
 * [min, max] m, growth (size × (1 + growth·age)), alpha, default sRGB colour and colour jitter.
 */
const KINDS = Object.freeze({
  dust: { life: [0.45, 0.9], speed: 1.6, up: [0.8, 2.2], gravity: -9, drag: 2.2, size: [0.09, 0.17], growth: 0.2, alpha: 0.95, color: [0.55, 0.5, 0.45], jitter: 0.12 },
  leaves: { life: [1.1, 1.9], speed: 1.2, up: [0.4, 1.6], gravity: -2.6, drag: 1.6, size: [0.1, 0.16], growth: 0, alpha: 1, color: [0.33, 0.55, 0.2], jitter: 0.15 },
  smoke: { life: [1.4, 2.4], speed: 0.45, up: [0.7, 1.4], gravity: 0.5, drag: 0.9, size: [0.28, 0.42], growth: 1.4, alpha: 0.5, color: [0.42, 0.42, 0.44], jitter: 0.08 },
  sparks: { life: [0.3, 0.7], speed: 7, up: [2, 5], gravity: -9, drag: 1.2, size: [0.05, 0.09], growth: -0.5, alpha: 1, color: [1, 0.72, 0.25], jitter: 0.1 },
  steam: { life: [0.7, 1.2], speed: 0.5, up: [1.4, 2.4], gravity: 1.2, drag: 1, size: [0.2, 0.32], growth: 1, alpha: 0.45, color: [0.92, 0.94, 0.96], jitter: 0.03 },
  // Soot drawn into a vortex (emitOrbit), and the plain bursts where an eaten block vanishes or a vortex collapses.
  infall: { life: [1.5, 3], speed: 0.6, up: [0, 0.4], gravity: 0, drag: 1.5, size: [0.06, 0.12], growth: -0.3, alpha: 0.9, color: [0.18, 0.15, 0.13], jitter: 0.08 },
});

/** Orbit flags (the `orbit` array): an orbit particle, θ fixed (radial), height ∝ ρ (spherical: straight at the centre). */
const ORBIT = 1;
const ORBIT_RADIAL = 2;
const ORBIT_SPHERICAL = 4;
/** Inward speed factor: dρ/dt = −VORTEX_INFLOW·inward/√ρ, so the time from ρ0 to ρ is (ρ0^1.5 − ρ^1.5) / (1.5·VORTEX_INFLOW·inward). */
const INFLOW_K = 1.5 * VORTEX_INFLOW; // 1.8
/** Spin: dθ/dt = min(ORBIT_MAX_SPIN, 4·spin·ρ^−1.5) (the disk's dash-on-arm speed, 4·ρ^−1.5, §2.4.3). */
const ORBIT_SPIN = 4;
const ORBIT_MAX_SPIN = 12;
/** Orbit particles take on their `hot` colour, and full alpha, as ρ falls from HOT_FROM to the core. */
const HOT_FROM = 1.5;
/** An orbit particle fades in over this long (it does not pop into view at full alpha). */
const ORBIT_FADE_IN_S = 0.15;
/** Margin added to an orbit particle's life beyond its computed arrival (§6.2.10: + 0.3 s). */
const ORBIT_LIFE_MARGIN = 0.3;

/** Kind names accepted by emit(). */
export const PARTICLE_KINDS = Object.freeze(Object.keys(KINDS));

const VERTEX_SHADER = /* glsl */ `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vColor = pcolor;
  vAlpha = palpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = palpha > 0.0 ? psize * uScale / max(-mvPosition.z, 0.05) : 0.0;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - smoothstep(0.1, 0.25, d)));
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * @typedef {Object} EmitOptions
 * @property {number} [id]           block id: dust / leaves take its average top-tile colour (tinted like the mesher)
 * @property {number[]} [color]      sRGB [r, g, b] 0..1 (overrides id)
 * @property {number} [spread]       spawn radius around (x, y, z), default 0.35
 * @property {number} [speed]        multiplies the kind's speeds
 * @property {number} [vx]           base velocity added to every particle
 * @property {number} [vy]
 * @property {number} [vz]
 */

/**
 * @typedef {Object} OrbitOptions  emitOrbit's options (DESIGN-circuits §6.2.10)
 * @property {number} rMin            start radius from the centre: horizontal, or 3D when `spherical`
 * @property {number} rMax
 * @property {number} [hMax]          start height ±hMax (default 0.6); flattens onto the disk plane unless `spherical`
 * @property {number} [spin]          multiplies the angular speed (default 1; 0 = no swirl)
 * @property {number} [inward]        multiplies the inflow speed (default 1); ≤ 0 drifts outward for the kind's life
 * @property {boolean} [radial]       θ stays fixed: straight in
 * @property {boolean} [spherical]    start on a sphere of radius rMin..rMax (|height| ≤ hMax) and move straight at the
 *                                    centre (height = h0·ρ/ρ0, ρ the 3D distance)
 * @property {number[]|number} [color]  sRGB [r, g, b] 0..1 (or 0xrrggbb) far out; default the kind's colour
 * @property {number[]|number} [hot]    the colour it turns as it nears the core (default `color`)
 */

/**
 * @typedef {Object} Particles
 * @property {(kind: string, x: number, y: number, z: number, count?: number, opts?: EmitOptions) => void} emit
 * @property {(kind: string, cx: number, cy: number, cz: number, count: number, opts: OrbitOptions) => void} emitOrbit
 * @property {(dt: number) => void} update   advance and upload; call once per frame (dt 0 = frozen)
 * @property {() => number} count            live particles
 * @property {() => void} clear
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile the particle program now
 * @property {() => void} dispose
 * @property {THREE.Points} points
 */

/** @type {Map<number, number[]>} block id → sRGB average colour of its top tile (tinted when the mesher tints it) */
const blockColorCache = new Map();

/** @returns {number[]} sRGB 0..1 colour of block `id` for dust / leaves */
export function blockParticleColor(id) {
  let c = blockColorCache.get(id);
  if (c) return c;
  if (getBlockDef(id).id === 0) {
    c = KINDS.dust.color.slice(); // AIR / unknown ids
  } else {
    const [r, g, b] = averageColor(getFaceTile(id, FACE_TOP));
    c = [r / 255, g / 255, b / 255];
    if (isTintedFace(id, FACE_TOP)) {
      const t = BIOME_TINT[BIOME.PLAINS];
      c = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
    }
  }
  blockColorCache.set(id, c);
  return c;
}

/**
 * @param {THREE.Scene} scene
 * @param {{ capacity?: number, random?: () => number }} [opts]
 * @returns {Particles}
 */
export function createParticles(scene, opts = {}) {
  const cap = opts.capacity ?? PARTICLE_CAPACITY;
  const random = opts.random ?? Math.random;

  const position = new Float32Array(cap * 3);
  const color = new Float32Array(cap * 3);
  const size = new Float32Array(cap);
  const alpha = new Float32Array(cap);
  const vel = new Float32Array(cap * 3);
  const life = new Float32Array(cap); // seconds left (≤ 0 = dead)
  const maxLife = new Float32Array(cap);
  const gravity = new Float32Array(cap);
  const drag = new Float32Array(cap);
  const baseSize = new Float32Array(cap);
  const growth = new Float32Array(cap);
  const baseAlpha = new Float32Array(cap);
  // Orbit particles (emitOrbit): flags, centre, radius, angle, height and their start values, spin and inflow, and the
  // two linear colours they move between.
  const orbit = new Uint8Array(cap);
  const oCx = new Float32Array(cap);
  const oCy = new Float32Array(cap);
  const oCz = new Float32Array(cap);
  const rho = new Float32Array(cap);
  const theta = new Float32Array(cap);
  const height = new Float32Array(cap);
  const h0 = new Float32Array(cap);
  const rho0 = new Float32Array(cap);
  const oSpin = new Float32Array(cap);
  const oInward = new Float32Array(cap);
  const oCol = new Float32Array(cap * 3);
  const oHot = new Float32Array(cap * 3);
  let next = 0;
  let live = 0;
  let highWater = 0;
  /** prewarm's warm-up draw is still owed: the Points draws one dead point (nothing on screen) until it is rendered. */
  let warming = false;

  const geometry = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', aPos);
  geometry.setAttribute('pcolor', aColor);
  geometry.setAttribute('psize', aSize);
  geometry.setAttribute('palpha', aAlpha);
  geometry.setDrawRange(0, 0);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 400 } }]),
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // After the translucent chunk layer, the block highlight and the vortices (renderOrder 2): a vortex's shadow writes
  // its depth, so the particles behind a black hole are hidden by it and those in front of it are drawn over it.
  points.renderOrder = 3;
  points.name = 'particles';
  points.visible = false;
  // World-unit point sizes: pixels per world unit at distance 1 = drawing-buffer height / (2·tan(fov/2)).
  const bufferSize = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(bufferSize);
    const fov = /** @type {THREE.PerspectiveCamera} */ (camera).fov ?? 70;
    material.uniforms.uScale.value = bufferSize.y / (2 * Math.tan((fov * Math.PI) / 360));
  };
  // After its warm-up draw the Points goes back to drawing nothing (unless particles were emitted meanwhile).
  points.onAfterRender = () => {
    if (!warming) return;
    warming = false;
    if (live === 0) {
      geometry.setDrawRange(0, highWater);
      points.visible = false;
    }
  };
  scene.add(points);

  const tmp = new THREE.Color();

  function emit(kind, x, y, z, count = 8, o = undefined) {
    const k = KINDS[kind];
    if (!k || !Number.isFinite(x + y + z)) return;
    const n = Math.max(0, Math.min(cap, Math.floor(count)));
    const base = o && Array.isArray(o.color) ? o.color : o && Number.isInteger(o.id) && (kind === 'dust' || kind === 'leaves') ? blockParticleColor(o.id) : k.color;
    const spread = o && o.spread !== undefined ? o.spread : 0.35;
    const sp = o && o.speed !== undefined ? o.speed : 1;
    const bvx = (o && o.vx) || 0;
    const bvy = (o && o.vy) || 0;
    const bvz = (o && o.vz) || 0;
    for (let j = 0; j < n; j++) {
      const i = next;
      next = (next + 1) % cap;
      if (life[i] <= 0) live++;
      if (i + 1 > highWater) highWater = i + 1;
      const a = random() * Math.PI * 2;
      const rr = Math.sqrt(random());
      position[i * 3] = x + Math.cos(a) * rr * spread;
      position[i * 3 + 1] = y + (random() - 0.5) * spread;
      position[i * 3 + 2] = z + Math.sin(a) * rr * spread;
      const s = k.speed * sp * (0.4 + 0.6 * random());
      vel[i * 3] = Math.cos(a) * s + bvx;
      vel[i * 3 + 1] = (k.up[0] + (k.up[1] - k.up[0]) * random()) * sp + bvy;
      vel[i * 3 + 2] = Math.sin(a) * s + bvz;
      const jt = (random() * 2 - 1) * k.jitter;
      tmp.setRGB(clamp01(base[0] + jt), clamp01(base[1] + jt), clamp01(base[2] + jt), THREE.SRGBColorSpace);
      color[i * 3] = tmp.r;
      color[i * 3 + 1] = tmp.g;
      color[i * 3 + 2] = tmp.b;
      const l = k.life[0] + (k.life[1] - k.life[0]) * random();
      life[i] = l;
      maxLife[i] = l;
      gravity[i] = k.gravity;
      drag[i] = k.drag;
      baseSize[i] = k.size[0] + (k.size[1] - k.size[0]) * random();
      size[i] = baseSize[i];
      growth[i] = k.growth;
      baseAlpha[i] = k.alpha;
      alpha[i] = k.alpha;
      orbit[i] = 0; // a recycled orbit slot flies ballistically
    }
    aColor.needsUpdate = true;
  }

  /**
   * Emit `count` particles of `kind` that spiral into (cx, cy, cz) (DESIGN-circuits §6.2.10). Each starts at a random
   * angle on radius rMin..rMax (horizontal; 3D when `spherical`) and height ±hMax, and lives just long enough to reach
   * the core: life = (ρ0^1.5 − 0.45^1.5) / (1.8·inward) + 0.3 s. It dies at ρ < 0.45. With `inward` ≤ 0 it drifts
   * outward instead, for the kind's life.
   * @param {string} kind
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} count
   * @param {OrbitOptions} o
   */
  function emitOrbit(kind, cx, cy, cz, count = 8, o = undefined) {
    const k = KINDS[kind];
    if (!k || !o || !Number.isFinite(cx + cy + cz)) return;
    let rMin = Number(o.rMin);
    let rMax = o.rMax === undefined ? rMin : Number(o.rMax);
    if (!Number.isFinite(rMin + rMax) || !(rMin > 0) || !(rMax > 0)) return;
    if (rMax < rMin) [rMin, rMax] = [rMax, rMin];
    const hMax = Number.isFinite(o.hMax) ? Math.max(0, /** @type {number} */ (o.hMax)) : 0.6;
    const spin = Number.isFinite(o.spin) ? /** @type {number} */ (o.spin) : 1;
    const inward = Number.isFinite(o.inward) ? /** @type {number} */ (o.inward) : 1;
    const flags = ORBIT | (o.radial ? ORBIT_RADIAL : 0) | (o.spherical ? ORBIT_SPHERICAL : 0);
    const base = srgbOf(o.color) ?? k.color;
    const hot = srgbOf(o.hot) ?? base;
    const n = Math.max(0, Math.min(cap, Math.floor(count)));
    for (let j = 0; j < n; j++) {
      const i = next;
      next = (next + 1) % cap;
      if (life[i] <= 0) live++;
      if (i + 1 > highWater) highWater = i + 1;
      const R = rMin + (rMax - rMin) * random();
      const th = random() * Math.PI * 2;
      let hh;
      if (flags & ORBIT_SPHERICAL) {
        const sMax = Math.min(1, hMax / R);
        hh = R * (random() * 2 - 1) * sMax; // uniform on the sphere's band |height| ≤ hMax
      } else {
        hh = (random() * 2 - 1) * hMax;
      }
      orbit[i] = flags;
      oCx[i] = cx;
      oCy[i] = cy;
      oCz[i] = cz;
      rho[i] = R;
      rho0[i] = R;
      theta[i] = th;
      height[i] = hh;
      h0[i] = hh;
      oSpin[i] = spin;
      oInward[i] = inward;
      const jt = (random() * 2 - 1) * k.jitter;
      tmp.setRGB(clamp01(base[0] + jt), clamp01(base[1] + jt), clamp01(base[2] + jt), THREE.SRGBColorSpace);
      oCol[i * 3] = tmp.r;
      oCol[i * 3 + 1] = tmp.g;
      oCol[i * 3 + 2] = tmp.b;
      color[i * 3] = tmp.r;
      color[i * 3 + 1] = tmp.g;
      color[i * 3 + 2] = tmp.b;
      tmp.setRGB(clamp01(hot[0] + jt), clamp01(hot[1] + jt), clamp01(hot[2] + jt), THREE.SRGBColorSpace);
      oHot[i * 3] = tmp.r;
      oHot[i * 3 + 1] = tmp.g;
      oHot[i * 3 + 2] = tmp.b;
      const l = inward > 0
        ? Math.max(0, R ** 1.5 - VORTEX_EVENT_R ** 1.5) / (INFLOW_K * inward) + ORBIT_LIFE_MARGIN
        : k.life[0] + (k.life[1] - k.life[0]) * random();
      life[i] = l;
      maxLife[i] = l;
      vel[i * 3] = 0;
      vel[i * 3 + 1] = 0;
      vel[i * 3 + 2] = 0;
      gravity[i] = 0;
      drag[i] = 0;
      growth[i] = 0;
      baseSize[i] = k.size[0] + (k.size[1] - k.size[0]) * random();
      size[i] = baseSize[i] * (0.6 + 0.4 * Math.min(1, R / 2));
      baseAlpha[i] = k.alpha;
      alpha[i] = 0; // fades in
      placeOrbit(i);
    }
    aColor.needsUpdate = true;
  }

  /** Position of orbit particle i from its centre, ρ, θ and height. */
  function placeOrbit(i) {
    const r = rho[i];
    const hgt = height[i];
    const horiz = orbit[i] & ORBIT_SPHERICAL ? Math.sqrt(Math.max(0, r * r - hgt * hgt)) : r;
    position[i * 3] = oCx[i] + horiz * Math.cos(theta[i]);
    position[i * 3 + 1] = oCy[i] + hgt;
    position[i * 3 + 2] = oCz[i] + horiz * Math.sin(theta[i]);
  }

  /** One update step of a live orbit particle i (its life already counted down). @returns {boolean} false: it died */
  function stepOrbit(i, dt) {
    const inw = oInward[i];
    let r = rho[i];
    r -= (VORTEX_INFLOW * inw * dt) / Math.sqrt(Math.max(r, 1e-3));
    if (inw > 0 && r < VORTEX_EVENT_R) return false;
    if (r < 1e-3) r = 1e-3;
    rho[i] = r;
    const flags = orbit[i];
    if (!(flags & ORBIT_RADIAL)) theta[i] += Math.min(ORBIT_MAX_SPIN, ORBIT_SPIN * oSpin[i] * Math.pow(r, -1.5)) * dt;
    height[i] = flags & ORBIT_SPHERICAL ? (h0[i] * r) / rho0[i] : height[i] * Math.exp(-2.5 * dt);
    placeOrbit(i);
    size[i] = baseSize[i] * (0.6 + 0.4 * Math.min(1, r / 2));
    const kh = Math.min(1, Math.max(0, (HOT_FROM - r) / (HOT_FROM - VORTEX_EVENT_R)));
    for (let c = 0; c < 3; c++) color[i * 3 + c] = oCol[i * 3 + c] + (oHot[i * 3 + c] - oCol[i * 3 + c]) * kh;
    const age = maxLife[i] - life[i];
    const fade = Math.min(1, age / ORBIT_FADE_IN_S) * (inw > 0 ? 1 : Math.min(1, (life[i] / maxLife[i]) * 2.5));
    alpha[i] = baseAlpha[i] * (0.55 + 0.45 * kh) * fade;
    return true;
  }

  function update(dt) {
    if (live === 0) {
      if (warming) geometry.setDrawRange(0, 1); // still owes its warm-up draw: one dead point (size 0)
      points.visible = warming;
      return;
    }
    if (dt > 0) {
      let orbits = false;
      for (let i = 0; i < highWater; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0 || (orbit[i] !== 0 && !stepOrbit(i, dt))) {
          life[i] = 0;
          alpha[i] = 0;
          size[i] = 0;
          live--;
          continue;
        }
        if (orbit[i] !== 0) {
          orbits = true;
          continue;
        }
        const f = Math.exp(-drag[i] * dt);
        vel[i * 3] *= f;
        vel[i * 3 + 1] = vel[i * 3 + 1] * f + gravity[i] * dt;
        vel[i * 3 + 2] *= f;
        position[i * 3] += vel[i * 3] * dt;
        position[i * 3 + 1] += vel[i * 3 + 1] * dt;
        position[i * 3 + 2] += vel[i * 3 + 2] * dt;
        const age = 1 - life[i] / maxLife[i];
        size[i] = Math.max(0, baseSize[i] * (1 + growth[i] * age));
        alpha[i] = baseAlpha[i] * Math.min(1, (1 - age) * 2.5);
      }
      while (highWater > 0 && life[highWater - 1] <= 0) highWater--;
      if (orbits) aColor.needsUpdate = true; // orbit particles change colour as they near the core
    }
    geometry.setDrawRange(0, highWater);
    aPos.needsUpdate = true;
    aSize.needsUpdate = true;
    aAlpha.needsUpdate = true;
    points.visible = live > 0;
  }

  /**
   * Pay the particle shader cost while the game loads, not on the frame of the first particle (as
   * campfireRenderer.prewarm, CONTRACTS §32.2): compile the program now with the scene's fog (compileAsync when the
   * renderer has it), and draw ONE dead point (palpha 0 → gl_PointSize 0) in the next rendered frame, because some
   * drivers (ANGLE on D3D11) only finish a program on its first draw. `update` / `clear` keep that draw until the Points
   * has been rendered once. Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets the warm-up draw)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    if (live === 0) {
      warming = true;
      geometry.setDrawRange(0, 1);
      points.visible = true;
    }
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.resolve(webgl.compileAsync(points, camera, scene)).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') webgl.compile(points, camera, scene);
    } catch {
      // A failed compile only brings back the one-off compile on first use.
    }
    return Promise.resolve();
  }

  return {
    emit,
    emitOrbit,
    update,
    count: () => live,
    clear() {
      life.fill(0);
      alpha.fill(0);
      orbit.fill(0);
      aAlpha.needsUpdate = true; // every point dead on the GPU too (a warm-up draw shows nothing)
      live = 0;
      highWater = 0;
      next = 0;
      geometry.setDrawRange(0, warming ? 1 : 0);
      points.visible = warming;
    },
    prewarm,
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
    points,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** An sRGB colour option: [r, g, b] 0..1 or 0xrrggbb → [r, g, b], or null when absent or malformed. */
function srgbOf(c) {
  if (Array.isArray(c) && c.length >= 3 && Number.isFinite(c[0] + c[1] + c[2])) return c;
  if (Number.isInteger(c) && c >= 0 && c <= 0xffffff) return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  return null;
}
