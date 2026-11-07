// Caelancraft — one particle system for every physics effect: dust (a block's colour), leaves, smoke, sparks and steam
// (three). See src/CONTRACTS.md §34.5.
//
// ONE THREE.Points of PARTICLE_CAPACITY points — one draw call whatever the load; when it is full the oldest particle
// is overwritten. Simulation is plain typed arrays on the CPU (velocity, gravity, drag, growth, life); the shader
// draws soft round points sized in world units and fogged like the terrain. Colours are sRGB in the API and converted
// to the linear working space on emit.
import * as THREE from 'three';
import { PARTICLE_CAPACITY } from './config.js';
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
});

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
 * @typedef {Object} Particles
 * @property {(kind: string, x: number, y: number, z: number, count?: number, opts?: EmitOptions) => void} emit
 * @property {(dt: number) => void} update   advance and upload; call once per frame (dt 0 = frozen)
 * @property {() => number} count            live particles
 * @property {() => void} clear
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
  let next = 0;
  let live = 0;
  let highWater = 0;

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
  points.renderOrder = 2;
  points.name = 'particles';
  points.visible = false;
  // World-unit point sizes: pixels per world unit at distance 1 = drawing-buffer height / (2·tan(fov/2)).
  const bufferSize = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(bufferSize);
    const fov = /** @type {THREE.PerspectiveCamera} */ (camera).fov ?? 70;
    material.uniforms.uScale.value = bufferSize.y / (2 * Math.tan((fov * Math.PI) / 360));
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
    }
    aColor.needsUpdate = true;
  }

  function update(dt) {
    if (live === 0) {
      points.visible = false;
      return;
    }
    if (dt > 0) {
      for (let i = 0; i < highWater; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) {
          life[i] = 0;
          alpha[i] = 0;
          size[i] = 0;
          live--;
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
    }
    geometry.setDrawRange(0, highWater);
    aPos.needsUpdate = true;
    aSize.needsUpdate = true;
    aAlpha.needsUpdate = true;
    points.visible = live > 0;
  }

  return {
    emit,
    update,
    count: () => live,
    clear() {
      life.fill(0);
      alpha.fill(0);
      live = 0;
      highWater = 0;
      next = 0;
      geometry.setDrawRange(0, 0);
      points.visible = false;
    },
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
