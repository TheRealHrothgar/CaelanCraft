// Caelancraft — campfire models, flames, smoke and light (three). See src/CONTRACTS.md §32.
//
// Each nearby campfire sits at the floor of its cell: a ring of six hexagonal stones on the cell's corners, three
// hexagonal logs crossing at 60° (the honeycomb again), five six-sided flame cones that flicker and sway, a bed of
// embers, and a column of smoke puffs that rise, swell and fade. Flames and embers are unlit (MeshBasicMaterial) so they
// glow at night.
//
// Every part is ONE InstancedMesh shared by all fires (stones, logs, embers, one per flame tongue, smoke: nine draw
// calls however many fires there are; skewers, food chunks and pots add three while anything is cooking), and every
// material lives as long as the renderer: prewarm() compiles their programs while the game loads, so neither the first
// fire of a session nor the next one after all fires went away compiles a shader mid-frame. Smoke puffs are camera-facing quads (billboarded in the vertex shader, like sprites)
// with a per-puff opacity attribute.
//
// A FIXED pool of CAMPFIRE_LIGHTS point lights is created once (changing the number of lights would recompile every
// material). Each light follows one fire: a fire that holds a light keeps it until an unlit fire is
// CAMPFIRE_LIGHT_HYSTERESIS nearer, and a light that changes hands fades out at the old fire before it fades in at the
// new one (CAMPFIRE_LIGHT_FADE_S each way), so walking through a camp never pops the light pools on and off.
//
// Survival fire spots (docs/DESIGN-survival.md §4.4, §9.9). When main passes `spotsView` to sync, each modelled fire
// also shows what is cooking on it: a thin green-wood skewer planted at each occupied corner stone (spot k ↔ stone k,
// angle 60k − 90°), leaning SKEWER_LEAN inward, with a small hex-prism chunk of food near its tip whose instance colour
// runs raw → cooked → burnt, and a terracotta hex pot in the embers (spot 6). Three more InstancedMeshes (12 in all),
// part of prewarm like the others; they draw nothing while no spot holds anything. While a pot sits in the embers the
// fire's flames burn low and wide around its foot (POT_FLAME_SQUASH / POT_FLAME_WIDEN) — otherwise the outer flame
// cone would swallow the pot whole.
import * as THREE from 'three';
import {
  CAMPFIRE_LIGHTS, CAMPFIRE_LIGHT_INTENSITY, CAMPFIRE_LIGHT_RANGE, CAMPFIRE_LIGHT_FADE_S, CAMPFIRE_LIGHT_HYSTERESIS,
  CAMPFIRE_MAX_MODELS, FIRE_SPOTS,
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

/** Distance of the corner stones (and so of the skewers' feet) from the fire's centre. */
export const CORNER_RADIUS = HEX_SIZE * 0.72;

// ---- Survival fire spots (DESIGN-survival §4.4, §9.9) ----------------------------------------------
/** The embers: spot FIRE_SPOTS − 1 (6) holds one pot; spots 0..5 are the skewers, spot k at corner stone k. */
export const POT_SPOT = FIRE_SPOTS - 1;
export const SKEWERS_PER_FIRE = POT_SPOT;
/** A skewer leans this far from the vertical, toward the fire's centre ("about 35° inward"). */
export const SKEWER_LEAN = (35 * Math.PI) / 180;
export const SKEWER_LENGTH = 0.42;
/** A skewer's foot: at its corner stone, wedged in at this height above the cell floor (the stones are 0.12 tall). */
export const SKEWER_BASE_Y = 0.06;
/** The food chunk sits this far along its skewer (0 = foot, 1 = tip). */
export const CHUNK_ALONG = 0.85;
/** The pot's foot above the cell floor: down among the logs, in the embers (0.13). */
export const POT_BASE_Y = 0.11;
/**
 * The pot's lathe profile, [radius, height above its foot] from the foot's centre up the outside, over the rim and down
 * to the floor of its mouth. Widest (0.165) low on the belly, narrow (≤ 0.14) from the shoulder up, so it never meets
 * the food on the skewers, whose lowest corners hang about 0.29 above the cell floor at 0.15–0.2 from the centre.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const POT_PROFILE = Object.freeze(/** @type {[number, number][]} */ ([
  [0, 0], [0.085, 0], [0.15, 0.06], [0.165, 0.1], [0.14, 0.15], [0.105, 0.175], [0.12, 0.2],
  [0.1, 0.2], [0.09, 0.16], [0, 0.16],
]).map((p) => Object.freeze(p)));
/**
 * While a pot sits in the embers, the flames burn low and wide around it (height × POT_FLAME_SQUASH, width and the
 * side tongues' offsets × POT_FLAME_WIDEN), so they lick around its foot instead of swallowing it.
 */
export const POT_FLAME_SQUASH = 0.35;
export const POT_FLAME_WIDEN = 1.25;
export const SKEWER_COLOR = 0x7c8a4c; // green wood
/** sRGB hex colours of the cooking stages (§9.9) and the pot. */
export const SPOT_COLORS = Object.freeze({
  meat: 0xd98c8c, // raw meat
  veg: 0xc9b27a, // raw tuber, root, acorns, cactus fruit
  cooked: 0x8a5a2b,
  burnt: 0x2a2018,
  pot: 0xb5603a, // terracotta
  greenware: 0xb9ad98, // unfired clay, fired to terracotta in the embers
});

/**
 * How each fire-spot item is drawn (§9.9: meat for pork; veg for tuber, root, acorns and cactus fruit; pot for every
 * pot) and its cooking stage: 0 raw, 1 cooked, 2 burnt. Covers every key of cooking.js FIRE_TRANSFORMS, both sides
 * (§4.4). Keys not listed are drawn as raw veg on a skewer and as a terracotta pot in the embers.
 * @type {Readonly<Record<string, Readonly<{ kind: 'meat'|'veg'|'pot', stage: number }>>>}
 */
export const SPOT_ITEMS = Object.freeze({
  raw_pork: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_pork: Object.freeze({ kind: 'meat', stage: 1 }),
  charred_meat: Object.freeze({ kind: 'meat', stage: 2 }),
  wild_tuber: Object.freeze({ kind: 'veg', stage: 0 }),
  baked_tuber: Object.freeze({ kind: 'veg', stage: 1 }),
  cattail_root: Object.freeze({ kind: 'veg', stage: 0 }),
  roasted_cattail_root: Object.freeze({ kind: 'veg', stage: 1 }),
  leached_acorns: Object.freeze({ kind: 'veg', stage: 0 }),
  roasted_acorns: Object.freeze({ kind: 'veg', stage: 1 }),
  unpeeled_cactus_fruit: Object.freeze({ kind: 'veg', stage: 0 }),
  cactus_fruit: Object.freeze({ kind: 'veg', stage: 1 }),
  pot_water: Object.freeze({ kind: 'pot', stage: 0 }),
  pot_boiled: Object.freeze({ kind: 'pot', stage: 1 }),
  pot_seawater: Object.freeze({ kind: 'pot', stage: 0 }),
  salt_pot: Object.freeze({ kind: 'pot', stage: 1 }),
  pot_snow: Object.freeze({ kind: 'pot', stage: 0 }),
  greenware_pot: Object.freeze({ kind: 'pot', stage: 0 }),
  clay_pot: Object.freeze({ kind: 'pot', stage: 1 }),
  pot_tainted: Object.freeze({ kind: 'pot', stage: 0 }), // v0.14 (§76 water)
  // v0.14 (§76 fauna): game on a skewer is meat that browns as it roasts; an egg is drawn as a pale chunk (veg). Beef and
  // mutton (§69) were missing here and were drawn as raw vegetables that never browned: listed now too.
  raw_beef: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_beef: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_mutton: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_mutton: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_venison: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_venison: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_rabbit: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_rabbit: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_fowl: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_fowl: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_fish: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_fish: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_bear: Object.freeze({ kind: 'meat', stage: 0 }),
  roast_bear: Object.freeze({ kind: 'meat', stage: 1 }),
  raw_egg: Object.freeze({ kind: 'veg', stage: 0 }),
  roast_egg: Object.freeze({ kind: 'veg', stage: 1 }),
});

/**
 * @typedef {Object} SpotView  one entry of fireSlots.view(q, y, r).spots (§9.9)
 * @property {string} k                 the item on the spot
 * @property {number} progress          0..1 toward `next`
 * @property {number} [secondsLeft]
 * @property {string|null} [next]       what it becomes (null when it is done changing)
 */
/**
 * @typedef {{ spots: (SpotView|null)[], fuel: number|null }} FireSpotsView
 * @typedef {(fire: Campfire) => FireSpotsView|null|undefined} SpotsViewFn
 */

/** @param {string} key @returns {{ kind: 'meat'|'veg'|'pot', stage: number }|null} */
function spotItem(key) {
  return typeof key === 'string' && Object.hasOwn(SPOT_ITEMS, key) ? SPOT_ITEMS[key] : null;
}

/**
 * What a spot's item is drawn as. The embers spot always holds a pot; a skewer item is meat or veg (unknown → veg).
 * @param {string} key
 * @param {number} spot 0..FIRE_SPOTS − 1
 * @returns {'meat'|'veg'|'pot'}
 */
export function spotKind(key, spot) {
  if (spot === POT_SPOT) return 'pot';
  const item = spotItem(key);
  return item && item.kind !== 'pot' ? item.kind : 'veg';
}

/**
 * How done a spot's item is, 0..2: its stage (0 raw, 1 cooked, 2 burnt) plus its progress toward the next transform
 * while it has one. So raw pork goes 0 → 1 as it roasts, roast pork 1 → 2 as it chars, and a finished item (no `next`)
 * stays at its stage. Unknown keys count as raw; bad progress values count as 0.
 * @param {SpotView|null|undefined} spot
 * @returns {number}
 */
export function spotDoneness(spot) {
  if (!spot) return 0;
  const item = spotItem(spot.k);
  const stage = item ? item.stage : 0;
  const p = spot.next && typeof spot.progress === 'number' && Number.isFinite(spot.progress)
    ? Math.min(1, Math.max(0, spot.progress)) : 0;
  return Math.min(2, stage + p);
}

/** @param {number} hex @returns {[number, number, number]} sRGB 0..1 */
function hexRGB(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** @param {number} a @param {number} b @param {number} t @returns {[number, number, number]} sRGB, lerped per channel */
function lerpHex(a, b, t) {
  const x = hexRGB(a);
  const y = hexRGB(b);
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}

/**
 * A food chunk's colour (sRGB 0..1, lerped in sRGB): raw (meat #d98c8c, veg #c9b27a) → cooked #8a5a2b at doneness 1 →
 * burnt #2a2018 at doneness 2.
 * @param {'meat'|'veg'|'pot'} kind
 * @param {number} doneness 0..2 (clamped; not a number → 0)
 * @returns {[number, number, number]}
 */
export function chunkColor(kind, doneness) {
  const d = typeof doneness === 'number' && Number.isFinite(doneness) ? Math.min(2, Math.max(0, doneness)) : 0;
  const raw = kind === 'meat' ? SPOT_COLORS.meat : SPOT_COLORS.veg;
  return d <= 1 ? lerpHex(raw, SPOT_COLORS.cooked, d) : lerpHex(SPOT_COLORS.cooked, SPOT_COLORS.burnt, d - 1);
}

/**
 * The pot's colour (sRGB 0..1): terracotta, except a greenware pot, which fires from pale clay to terracotta as it
 * goes (pit firing, §4.4).
 * @param {SpotView|null|undefined} spot
 * @returns {[number, number, number]}
 */
export function potColor(spot) {
  if (spot && spot.k === 'greenware_pot') return lerpHex(SPOT_COLORS.greenware, SPOT_COLORS.pot, spotDoneness(spot));
  return hexRGB(SPOT_COLORS.pot);
}

/**
 * Where skewer k stands on a fire whose cell floor centre is (x, y, z): its foot at corner stone k (angle 60k − 90°,
 * CORNER_RADIUS out) and its unit direction, tilted SKEWER_LEAN from the vertical toward the centre.
 * @param {number} k 0..5
 * @param {number} x @param {number} y @param {number} z
 * @returns {{ foot: [number, number, number], dir: [number, number, number] }}
 */
export function skewerPose(k, x, y, z) {
  const a = ((60 * k - 90) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    foot: [x + c * CORNER_RADIUS, y + SKEWER_BASE_Y, z + s * CORNER_RADIUS],
    dir: [-c * Math.sin(SKEWER_LEAN), Math.cos(SKEWER_LEAN), -s * Math.sin(SKEWER_LEAN)],
  };
}

/**
 * @typedef {Object} CampfireRenderer
 * @property {(near: { fire: Campfire, dist: number }[], t: number, dt: number, spotsView?: SpotsViewFn|null) => void} sync
 *           models for exactly these fires (nearest first; `dist` from the camera), lights handed over smoothly;
 *           `spotsView(fire)` (Survival, optional) gives each modelled fire's spots: skewers, food chunks and the pot
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
  // Fire spots: a thin six-sided stick with its foot at the origin and its axis along +y (the instance matrix leans
  // it), a small hex-prism chunk centred on that axis, and a six-sided pot turned on a lathe (narrow foot, round
  // belly, rim, hollow mouth) whose corners point along ±z like the cells.
  const skewerGeo = new THREE.CylinderGeometry(0.011, 0.015, SKEWER_LENGTH, 6);
  skewerGeo.translate(0, SKEWER_LENGTH / 2, 0);
  const chunkGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.09, 6);
  const potGeo = new THREE.LatheGeometry(POT_PROFILE.map(([r, h]) => new THREE.Vector2(r, h)), 6);

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
  const skewerMat = new THREE.MeshLambertMaterial({ color: SKEWER_COLOR });
  const chunkMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // × instance colour: raw → cooked → burnt
  const potMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // × instance colour: terracotta (or greenware)

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
  // The spot parts draw only the occupied spots (instances [0, count) packed over all fires), not perFire × fires.
  const skewers = part(skewerGeo, skewerMat, SKEWERS_PER_FIRE, 0, 'campfire-skewers');
  const chunks = part(chunkGeo, chunkMat, SKEWERS_PER_FIRE, 0, 'campfire-chunks');
  const pots = part(potGeo, potMat, 1, 0, 'campfire-pots');
  const spotParts = [skewers, chunks, pots];
  for (const p of spotParts) p.userData.spots = true;
  const parts = [stones, logs, embers, ...flames, smoke, ...spotParts];
  // Log k of every fire has the same colour, so the instance colours are written once.
  const logColor = new THREE.Color(LOG_COLOR);
  const charColor = new THREE.Color(CHAR_COLOR);
  for (let i = 0; i < capacity * LOGS_PER_FIRE; i++) logs.setColorAt(i, i % LOGS_PER_FIRE === 1 ? charColor : logColor);
  // Chunks and pots carry an instance colour from the start, so the program prewarm compiles (USE_INSTANCING_COLOR)
  // is the one they draw with; their colours change while things cook.
  const scratchColor = new THREE.Color();
  for (const [mesh, hex] of /** @type {[THREE.InstancedMesh, number][]} */ ([[chunks, SPOT_COLORS.meat], [pots, SPOT_COLORS.pot]])) {
    scratchColor.setHex(hex);
    for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, scratchColor);
    /** @type {THREE.InstancedBufferAttribute} */ (mesh.instanceColor).setUsage(THREE.DynamicDrawUsage);
  }
  /** Each corner's skewer rotation (+y onto the lean toward the centre); shared by every fire. */
  const skewerQuats = [];
  for (let k = 0; k < SKEWERS_PER_FIRE; k++) {
    const { dir } = skewerPose(k, 0, 0, 0);
    skewerQuats.push(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir)));
  }
  const spotPos = new THREE.Vector3();
  const unitScale = new THREE.Vector3(1, 1, 1);
  const noTurn = new THREE.Quaternion();
  const spotMatrix = new THREE.Matrix4();

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
      put(stones, slot * STONES_PER_FIRE + k, fire.x + Math.cos(a) * CORNER_RADIUS, fire.y, fire.z + Math.sin(a) * CORNER_RADIUS, a, 0, 1, 1, 1);
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

  /**
   * This frame's spot list of each slot's fire (null: nothing on it), read once per sync from `spotsView` and used by
   * the flames (a pot in the embers lowers them) and the spot parts.
   * @type {((SpotView|null)[]|null)[]}
   */
  const frameSpots = [];

  /** @param {SpotsViewFn|null|undefined} spotsView */
  function readSpots(spotsView) {
    frameSpots.length = slots.length;
    for (let i = 0; i < slots.length; i++) {
      let spots = null;
      if (typeof spotsView === 'function') {
        const view = spotsView(slots[i].fire);
        if (view && Array.isArray(view.spots)) spots = view.spots;
      }
      frameSpots[i] = spots;
    }
  }

  /** @param {number} slot @returns {boolean} a pot sits in that fire's embers this frame */
  function hasPot(slot) {
    const spots = frameSpots[slot];
    const s = spots && spots.length > POT_SPOT ? spots[POT_SPOT] : null;
    return !!s && typeof s.k === 'string';
  }

  /** Flames and smoke of the fire in `m.slot` at time t. */
  function animate(m, t, dt) {
    const { fire, slot, puffs } = m;
    const f = flicker(t, fire.seed);
    const potted = hasPot(slot);
    const widen = potted ? POT_FLAME_WIDEN : 1;
    const squash = potted ? POT_FLAME_SQUASH : 1;
    for (let i = 0; i < FLAMES.length; i++) {
      const [, , , , ox, oz, phase] = FLAMES[i];
      const ph = phase + fire.seed;
      put(
        flames[i], slot, fire.x + ox * widen, fire.y + FLAME_BASE_Y, fire.z + oz * widen,
        t * 0.8 + ph, 0.08 * Math.sin(t * 3.1 + ph),
        widen * (1 + 0.06 * Math.sin(t * 9 + ph)), squash * f * (1 + 0.18 * Math.sin(t * 11.3 + ph * 1.9)),
        widen * (1 + 0.06 * Math.cos(t * 8 + ph)),
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

  /**
   * Skewers, food chunks and pots for every modelled fire's occupied spots (this frame's `frameSpots`), packed into
   * instances [0, count) of each part in slot order. Without `spotsView` (Creative, or a caller that predates
   * Survival) nothing is drawn.
   */
  function writeSpots() {
    let ns = 0; // skewers (and chunks)
    let np = 0; // pots
    for (const m of slots) {
      const spots = frameSpots[m.slot];
      if (!spots) continue;
      const { fire } = m;
      const n = Math.min(FIRE_SPOTS, spots.length);
      for (let k = 0; k < n; k++) {
        const spot = spots[k];
        if (!spot || typeof spot.k !== 'string') continue;
        if (k === POT_SPOT) {
          spotPos.set(fire.x, fire.y + POT_BASE_Y, fire.z);
          spotMatrix.compose(spotPos, noTurn, unitScale);
          pots.setMatrixAt(np, spotMatrix);
          const [r, g, b] = potColor(spot);
          pots.setColorAt(np, scratchColor.setRGB(r, g, b, THREE.SRGBColorSpace));
          np++;
          continue;
        }
        const { foot, dir } = skewerPose(k, fire.x, fire.y, fire.z);
        spotPos.set(foot[0], foot[1], foot[2]);
        spotMatrix.compose(spotPos, skewerQuats[k], unitScale);
        skewers.setMatrixAt(ns, spotMatrix);
        const along = SKEWER_LENGTH * CHUNK_ALONG;
        spotPos.set(foot[0] + dir[0] * along, foot[1] + dir[1] * along, foot[2] + dir[2] * along);
        spotMatrix.compose(spotPos, skewerQuats[k], unitScale);
        chunks.setMatrixAt(ns, spotMatrix);
        const [r, g, b] = chunkColor(spotKind(spot.k, k), spotDoneness(spot));
        chunks.setColorAt(ns, scratchColor.setRGB(r, g, b, THREE.SRGBColorSpace));
        ns++;
      }
    }
    const counts = [ns, ns, np];
    for (let i = 0; i < spotParts.length; i++) {
      const p = spotParts[i];
      if (warming.has(p)) continue; // still owes its hidden warm-up draw (prewarm)
      p.count = counts[i];
      p.visible = counts[i] > 0;
    }
    if (ns + np > 0) {
      skewers.instanceMatrix.needsUpdate = true;
      chunks.instanceMatrix.needsUpdate = true;
      pots.instanceMatrix.needsUpdate = true;
      /** @type {THREE.InstancedBufferAttribute} */ (chunks.instanceColor).needsUpdate = true;
      /** @type {THREE.InstancedBufferAttribute} */ (pots.instanceColor).needsUpdate = true;
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

  /**
   * @param {{ fire: Campfire, dist: number }[]} near @param {number} t @param {number} dt
   * @param {SpotsViewFn|null} [spotsView]
   */
  function sync(near, t, dt, spotsView) {
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
    readSpots(spotsView);
    for (const m of slots) animate(m, t, dt);
    for (const p of parts) {
      if (p.userData.spots) continue; // writeSpots below
      if (warming.has(p)) continue; // still owes its hidden warm-up draw (prewarm)
      p.count = n * p.userData.perFire;
      p.visible = n > 0;
    }
    writeSpots();
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
    for (const g of [stoneGeo, logGeo, emberGeo, smokeGeo, ...flameGeos, skewerGeo, chunkGeo, potGeo]) g.dispose();
    for (const m of [stoneMat, logMat, emberMat, smokeMat, ...flameMats, skewerMat, chunkMat, potMat]) m.dispose();
    smokeTex.dispose();
  }

  return { sync, count: () => models.size, idle, prewarm, dispose };
}
