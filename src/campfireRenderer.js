// Caelancraft — campfire models, flames, smoke and light (three). See src/CONTRACTS.md §32.
//
// Each nearby campfire sits at the floor of its cell: a ring of six hexagonal stones on the cell's corners, three
// hexagonal logs crossing at 60° (the honeycomb again), five six-sided flame cones that flicker and sway, a bed of
// embers, and a column of smoke puffs that rise, swell and fade. Flames and embers are unlit (MeshBasicMaterial) so they
// glow at night.
//
// Every part is ONE InstancedMesh shared by all fires (stones, logs, embers, one per flame tongue, smoke: nine draw
// calls however many fires there are), and every material lives as long as the renderer: prewarm() compiles their
// programs while the game loads, so neither the first fire of a session nor the next one after all fires went away
// compiles a shader mid-frame. Smoke puffs are camera-facing quads (billboarded in the vertex shader, like sprites)
// with a per-puff opacity attribute.
//
// A FIXED pool of CAMPFIRE_LIGHTS point lights is created once (changing the number of lights would recompile every
// material). Each light follows one fire: a fire that holds a light keeps it until an unlit fire is
// CAMPFIRE_LIGHT_HYSTERESIS nearer, and a light that changes hands fades out at the old fire before it fades in at the
// new one (CAMPFIRE_LIGHT_FADE_S each way), so walking through a camp never pops the light pools on and off.
import * as THREE from 'three';
import {
  CAMPFIRE_LIGHTS, CAMPFIRE_LIGHT_INTENSITY, CAMPFIRE_LIGHT_RANGE, CAMPFIRE_LIGHT_FADE_S, CAMPFIRE_LIGHT_HYSTERESIS,
  CAMPFIRE_MAX_MODELS,
} from './config.js';
import { HEX_SIZE } from './hex.js';
import { flicker } from './campfires.js';

/** @typedef {import('./campfires.js').Campfire} Campfire */

const LIGHT_COLOR = 0xff9a40;
const LIGHT_DECAY = 1.6;
const LIGHT_HEIGHT = 0.6;
export const STONES_PER_FIRE = 6;
export const LOGS_PER_FIRE = 3;
export const EMBERS_PER_FIRE = 7;
export const SMOKE_PER_FIRE = 6;
const SMOKE_LIFE_S = 3.2;
const SMOKE_RISE = 0.85; // m/s
const FLAME_BASE_Y = 0.13;
const STONE_COLOR = 0x77736c;
const LOG_COLOR = 0x5a3b22;
const CHAR_COLOR = 0x2b1d14; // the middle log
const EMBER_COLOR = 0xff6a1a;
const SMOKE_COLOR = 0x9a9a9a;
/** prewarm's hidden instance: a micro-scaled speck far below the world (clipped; still a real draw call). */
const WARM_MATRIX = new THREE.Matrix4().makeTranslation(0, -1e4, 0).multiply(new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6));

/**
 * Flame tongues: [radius, height, colour, opacity, offset x, offset z, phase]. The first is the big outer flame; the
 * last two are small side tongues.
 */
export const FLAMES = [
  [0.2, 0.55, 0xff7a1a, 0.85, 0, 0, 0],
  [0.14, 0.44, 0xffb02e, 0.92, 0, 0, 1.3],
  [0.075, 0.28, 0xfff2a8, 1, 0, 0, 2.1],
  [0.08, 0.3, 0xff8c22, 0.85, 0.12, 0.05, 3.7],
  [0.07, 0.26, 0xff8c22, 0.85, -0.09, -0.1, 5.2],
];

/**
 * @typedef {Object} CampfireRenderer
 * @property {(near: { fire: Campfire, dist: number }[], t: number, dt: number) => void} sync
 *           models for exactly these fires (nearest first; `dist` from the camera), lights handed over smoothly
 * @property {() => number} count       fires with a model
 * @property {() => boolean} idle       no model and every light dark (sync may stop being called)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every campfire program now
 * @property {() => void} dispose
 */

/** Soft round smoke puff: a radial white gradient on a transparent 32×32 canvas. */
function makeSmokeTexture(makeCanvas) {
  const c = makeCanvas();
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The smoke's MeshBasicMaterial, patched to draw each instance as a camera-facing quad (the instance matrix supplies
 * the centre and the size, exactly like a Sprite's position and scale) and to multiply in the `aOpacity` attribute.
 * Fog, colour space and the map work as for any MeshBasicMaterial.
 */
function makeSmokeMaterial(map) {
  const mat = new THREE.MeshBasicMaterial({ map, color: SMOKE_COLOR, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
      .replace(
        '#include <project_vertex>',
        [
          'vOpacity = aOpacity;',
          'vec4 mvPosition = modelViewMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 );',
          'mvPosition.xy += position.xy * vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );',
          'gl_Position = projectionMatrix * mvPosition;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vOpacity );');
  };
  mat.customProgramCacheKey = () => 'caelancraft-campfire-smoke';
  return mat;
}

/**
 * @param {THREE.Scene} scene
 * @param {{ makeCanvas?: () => HTMLCanvasElement, capacity?: number }} [opts]  capacity: most fires drawn at once
 *        (default CAMPFIRE_MAX_MODELS; extra entries of `near` are ignored)
 * @returns {CampfireRenderer}
 */
export function createCampfireRenderer(scene, opts = {}) {
  const makeCanvas = opts.makeCanvas ?? (() => document.createElement('canvas'));
  const capacity = Math.max(1, Math.floor(opts.capacity ?? CAMPFIRE_MAX_MODELS));

  const stoneGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.12, 6);
  stoneGeo.translate(0, 0.06, 0);
  const logGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6);
  logGeo.rotateZ(Math.PI / 2); // axis along x
  const emberGeo = new THREE.BoxGeometry(0.06, 0.04, 0.06);
  const flameGeos = FLAMES.map(([radius, height]) => {
    const g = new THREE.ConeGeometry(radius, height, 6);
    g.translate(0, height / 2, 0); // base at y = 0 so scaling grows the flame upward
    return g;
  });
  const smokeGeo = new THREE.PlaneGeometry(1, 1);
  const smokeOpacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity * SMOKE_PER_FIRE), 1);
  smokeOpacity.setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute('aOpacity', smokeOpacity);

  const stoneMat = new THREE.MeshLambertMaterial({ color: STONE_COLOR });
  const logMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // × instance colour: log or char
  const emberMat = new THREE.MeshBasicMaterial({ color: EMBER_COLOR });
  // Transparent DoubleSide would make three draw each flame twice (back faces, then front faces). Each tongue is one
  // colour at one opacity, and blending a colour over itself is order-independent, so one pass looks the same.
  const flameMats = FLAMES.map(([, , color, opacity]) => new THREE.MeshBasicMaterial({
    color, transparent: opacity < 1, opacity, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  }));
  const smokeTex = makeSmokeTexture(makeCanvas);
  const smokeMat = makeSmokeMaterial(smokeTex);

  const root = new THREE.Group();
  root.name = 'campfires';
  scene.add(root);

  /** Parts that still owe their warm-up draw (see prewarm). */
  const warming = new Set();

  /** @returns {THREE.InstancedMesh} */
  function part(geo, mat, perFire, renderOrder, name) {
    const m = new THREE.InstancedMesh(geo, mat, capacity * perFire);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false; // no empty draw calls while no fire is modelled
    m.frustumCulled = false; // instances move from fire to fire; a cached bounding sphere would be stale
    m.renderOrder = renderOrder;
    m.name = name;
    m.userData.perFire = perFire;
    // After its warm-up draw a part goes back to drawing nothing (unless sync has given it fires meanwhile).
    m.onAfterRender = () => {
      if (warming.delete(m) && slots.length === 0) {
        m.count = 0;
        m.visible = false;
      }
    };
    root.add(m);
    return m;
  }
  const stones = part(stoneGeo, stoneMat, STONES_PER_FIRE, 0, 'campfire-stones');
  const logs = part(logGeo, logMat, LOGS_PER_FIRE, 0, 'campfire-logs');
  const embers = part(emberGeo, emberMat, EMBERS_PER_FIRE, 0, 'campfire-embers');
  const flames = FLAMES.map((_, i) => part(flameGeos[i], flameMats[i], 1, 2 + i, `campfire-flame-${i}`)); // inner flames draw over the outer one
  const smoke = part(smokeGeo, smokeMat, SMOKE_PER_FIRE, 10, 'campfire-smoke');
  const parts = [stones, logs, embers, ...flames, smoke];
  // Log k of every fire has the same colour, so the instance colours are written once.
  const logColor = new THREE.Color(LOG_COLOR);
  const charColor = new THREE.Color(CHAR_COLOR);
  for (let i = 0; i < capacity * LOGS_PER_FIRE; i++) logs.setColorAt(i, i % LOGS_PER_FIRE === 1 ? charColor : logColor);

  /**
   * @typedef {{ fire: Campfire, slot: number, puffs: Float64Array }} Model  puffs: [age, dx, dz] × SMOKE_PER_FIRE
   * @type {Map<string, Model>}
   */
  const models = new Map();
  /** @type {Model[]} slot → model; slots are dense, so every part draws instances [0, count) */
  const slots = [];
  let staticDirty = false;

  const dummy = new THREE.Object3D();
  function put(mesh, index, x, y, z, ry, rz, sx, sy, sz) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, ry, rz);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  }

  /** Stones, logs and embers of the fire in `m.slot` (they only move when a fire takes a slot). */
  function writeStatic(m) {
    const { fire, slot } = m;
    // Stones on the six corners of the cell (pointy-top: corner k at angle 60k − 90°), pulled in a little.
    for (let k = 0; k < STONES_PER_FIRE; k++) {
      const a = ((60 * k - 90) * Math.PI) / 180;
      put(stones, slot * STONES_PER_FIRE + k, fire.x + Math.cos(a) * HEX_SIZE * 0.72, fire.y, fire.z + Math.sin(a) * HEX_SIZE * 0.72, a, 0, 1, 1, 1);
    }
    // Three logs crossing at 60°, stacked slightly so they do not z-fight.
    for (let k = 0; k < LOGS_PER_FIRE; k++) {
      put(logs, slot * LOGS_PER_FIRE + k, fire.x, fire.y + 0.07 + k * 0.035, fire.z, (k * Math.PI) / 3 + fire.seed, 0, 1, 1, 1);
    }
    for (let k = 0; k < EMBERS_PER_FIRE; k++) {
      const a = fire.seed * 3 + k * 2.4;
      const rr = 0.05 + (k % 3) * 0.05;
      put(embers, slot * EMBERS_PER_FIRE + k, fire.x + Math.cos(a) * rr, fire.y + 0.13, fire.z + Math.sin(a) * rr, a, 0, 1, 1, 1);
    }
    staticDirty = true;
  }

  /** Flames and smoke of the fire in `m.slot` at time t. */
  function animate(m, t, dt) {
    const { fire, slot, puffs } = m;
    const f = flicker(t, fire.seed);
    for (let i = 0; i < FLAMES.length; i++) {
      const [, , , , ox, oz, phase] = FLAMES[i];
      const ph = phase + fire.seed;
      put(
        flames[i], slot, fire.x + ox, fire.y + FLAME_BASE_Y, fire.z + oz,
        t * 0.8 + ph, 0.08 * Math.sin(t * 3.1 + ph),
        1 + 0.06 * Math.sin(t * 9 + ph), f * (1 + 0.18 * Math.sin(t * 11.3 + ph * 1.9)), 1 + 0.06 * Math.cos(t * 8 + ph),
      );
    }
    for (let i = 0; i < SMOKE_PER_FIRE; i++) {
      let age = puffs[i * 3] + dt;
      if (age >= SMOKE_LIFE_S) {
        age -= SMOKE_LIFE_S;
        // A new puff drifts a little in a direction that turns slowly with time.
        const a = t * 0.3 + fire.seed + age * 5;
        puffs[i * 3 + 1] = Math.cos(a) * 0.12;
        puffs[i * 3 + 2] = Math.sin(a) * 0.12;
      }
      puffs[i * 3] = age;
      const u = age / SMOKE_LIFE_S;
      const size = 0.25 + 0.75 * u;
      const index = slot * SMOKE_PER_FIRE + i;
      put(smoke, index, fire.x + puffs[i * 3 + 1] * age, fire.y + 0.65 + SMOKE_RISE * age, fire.z + puffs[i * 3 + 2] * age, 0, 0, size, size, 1);
      smokeOpacity.array[index] = 0.32 * Math.min(1, u * 8) * (1 - u);
    }
  }

  /** Free a model's slot by moving the last slot's model into it. */
  function drop(key) {
    const m = models.get(key);
    if (!m) return;
    models.delete(key);
    const last = /** @type {Model} */ (slots.pop());
    if (last !== m) {
      last.slot = m.slot;
      slots[m.slot] = last;
      writeStatic(last);
    }
  }

  // ---- lights ------------------------------------------------------------------------------------
  /** @type {{ light: THREE.PointLight, fire: Campfire|null, level: number }[]} level ∈ [0, 1], eased into the intensity */
  const pool = [];
  for (let i = 0; i < CAMPFIRE_LIGHTS; i++) {
    const light = new THREE.PointLight(LIGHT_COLOR, 0, CAMPFIRE_LIGHT_RANGE, LIGHT_DECAY);
    scene.add(light);
    pool.push({ light, fire: null, level: 0 });
  }

  /** @param {{ fire: Campfire, dist: number }[]} near @param {number} t @param {number} dt */
  function syncLights(near, t, dt) {
    // The fires that should be lit: the nearest CAMPFIRE_LIGHTS, a fire that holds a light counting as
    // CAMPFIRE_LIGHT_HYSTERESIS nearer (so two fires at nearly the same distance do not trade the light back and forth).
    const holds = new Set();
    for (const p of pool) if (p.fire) holds.add(p.fire.key);
    const ranked = near.map(({ fire, dist }) => ({ fire, d: dist - (holds.has(fire.key) ? CAMPFIRE_LIGHT_HYSTERESIS : 0) }));
    ranked.sort((a, b) => a.d - b.d || (a.fire.key < b.fire.key ? -1 : a.fire.key > b.fire.key ? 1 : 0));
    /** @type {Map<string, Campfire>} */
    const wanted = new Map();
    for (let i = 0; i < ranked.length && wanted.size < pool.length; i++) wanted.set(ranked[i].fire.key, ranked[i].fire);
    // Lights already on a wanted fire keep it; lights that were free at the start of the frame take the others.
    /** @type {Set<object>} */
    const rising = new Set();
    for (const p of pool) {
      if (p.fire && wanted.has(p.fire.key)) {
        p.fire = /** @type {Campfire} */ (wanted.get(p.fire.key));
        wanted.delete(p.fire.key);
        rising.add(p);
      }
    }
    for (const fire of wanted.values()) {
      const p = pool.find((e) => e.fire === null);
      if (!p) break; // the rest wait for a light to finish fading out
      p.fire = fire;
      p.level = 0;
      rising.add(p);
    }
    const step = CAMPFIRE_LIGHT_FADE_S > 0 ? dt / CAMPFIRE_LIGHT_FADE_S : 1;
    for (const p of pool) {
      const { light } = p;
      if (!p.fire) {
        light.intensity = 0;
        continue;
      }
      if (rising.has(p)) {
        p.level = Math.min(1, p.level + step);
      } else {
        // Fading out where it is: the light only moves to another fire once it is dark.
        p.level = Math.max(0, p.level - step);
      }
      const fire = p.fire;
      light.position.set(fire.x, fire.y + LIGHT_HEIGHT, fire.z);
      const e = p.level * p.level * (3 - 2 * p.level); // smoothstep: no kink at either end of a fade
      light.intensity = CAMPFIRE_LIGHT_INTENSITY * flicker(t, fire.seed) * e;
      if (p.level === 0 && !rising.has(p)) p.fire = null;
    }
  }

  /** @param {{ fire: Campfire, dist: number }[]} near @param {number} t @param {number} dt */
  function sync(near, t, dt) {
    const shown = near.length > capacity ? near.slice(0, capacity) : near;
    const keep = new Set();
    for (const { fire } of shown) keep.add(fire.key);
    for (const key of [...models.keys()]) if (!keep.has(key)) drop(key);
    for (const { fire } of shown) {
      let m = models.get(fire.key);
      if (!m) {
        const puffs = new Float64Array(SMOKE_PER_FIRE * 3);
        // Stagger the puffs over one life so the column is continuous from the start.
        for (let i = 0; i < SMOKE_PER_FIRE; i++) puffs[i * 3] = (i / SMOKE_PER_FIRE) * SMOKE_LIFE_S;
        m = { fire, slot: slots.length, puffs };
        models.set(fire.key, m);
        slots.push(m);
        writeStatic(m);
      } else if (m.fire !== fire) {
        m.fire = fire; // the tracker re-created the record (same cell, same place)
      }
    }
    const n = slots.length;
    if (n > 0) warming.clear(); // real fires: their own first draw is the warm-up
    for (const m of slots) animate(m, t, dt);
    for (const p of parts) {
      if (warming.has(p)) continue; // still owes its hidden warm-up draw (prewarm)
      p.count = n * p.userData.perFire;
      p.visible = n > 0;
    }
    if (staticDirty) {
      stones.instanceMatrix.needsUpdate = true;
      logs.instanceMatrix.needsUpdate = true;
      embers.instanceMatrix.needsUpdate = true;
      staticDirty = false;
    }
    if (n > 0) {
      for (const fl of flames) fl.instanceMatrix.needsUpdate = true;
      smoke.instanceMatrix.needsUpdate = true;
      smokeOpacity.needsUpdate = true;
    }
    syncLights(shown, t, dt);
  }

  /**
   * Pay every campfire shader cost while the game loads, not on the frame the first fire appears:
   * 1. compile the programs now, with the scene's lights and fog (compileAsync — KHR_parallel_shader_compile — when the
   *    renderer has it);
   * 2. have each part draw ONE hidden instance (a speck far below the world) in the next rendered frame — the first
   *    frame after loading — because some drivers (ANGLE on D3D11) only finish a program's executables on its first
   *    draw. The part draws nothing again afterwards unless sync gives it fires.
   * Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets step 2)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    for (const p of parts) {
      if (p.count > 0) continue; // already drawing fires
      p.setMatrixAt(0, WARM_MATRIX);
      p.instanceMatrix.needsUpdate = true;
      p.count = 1;
      p.visible = true;
      warming.add(p);
    }
    smokeOpacity.setX(0, 0);
    smokeOpacity.needsUpdate = true;
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.resolve(webgl.compileAsync(root, camera, scene)).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') webgl.compile(root, camera, scene);
    } catch {
      // A failed compile only brings back the one-off compile on first use.
    }
    return Promise.resolve();
  }

  function idle() {
    return models.size === 0 && pool.every((p) => p.fire === null);
  }

  function dispose() {
    models.clear();
    slots.length = 0;
    scene.remove(root);
    for (const p of pool) scene.remove(p.light);
    for (const p of parts) p.dispose();
    for (const g of [stoneGeo, logGeo, emberGeo, smokeGeo, ...flameGeos]) g.dispose();
    for (const m of [stoneMat, logMat, emberMat, smokeMat, ...flameMats]) m.dispose();
    smokeTex.dispose();
  }

  return { sync, count: () => models.size, idle, prewarm, dispose };
}
