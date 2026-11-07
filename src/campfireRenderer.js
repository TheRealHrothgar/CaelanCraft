// Caelancraft — campfire models, flames, smoke and light (three). See src/CONTRACTS.md §32.
//
// Each nearby campfire gets a Group at the floor of its cell: a ring of six hexagonal stones on the cell's corners,
// three hexagonal logs crossing at 60° (the honeycomb again), five six-sided flame cones that flicker and sway, a
// bed of embers, and a column of smoke sprites that rise, swell and fade. Flames and embers are unlit
// (MeshBasicMaterial) so they glow at night. A FIXED pool of CAMPFIRE_LIGHTS point lights is created once (changing
// the number of lights would recompile every material) and handed to the nearest fires each frame; unused lights sit
// at intensity 0.
import * as THREE from 'three';
import { CAMPFIRE_LIGHTS, CAMPFIRE_LIGHT_INTENSITY, CAMPFIRE_LIGHT_RANGE } from './config.js';
import { HEX_SIZE } from './hex.js';
import { flicker } from './campfires.js';

/** @typedef {import('./campfires.js').Campfire} Campfire */

const LIGHT_COLOR = 0xff9a40;
const LIGHT_DECAY = 1.6;
const LIGHT_HEIGHT = 0.6;
const SMOKE_PER_FIRE = 6;
const SMOKE_LIFE_S = 3.2;
const SMOKE_RISE = 0.85; // m/s
const FLAME_BASE_Y = 0.13;

/**
 * Flame tongues: [radius, height, colour, opacity, offset x, offset z, phase]. The first is the big outer flame; the
 * last two are small side tongues.
 */
const FLAMES = [
  [0.2, 0.55, 0xff7a1a, 0.85, 0, 0, 0],
  [0.14, 0.44, 0xffb02e, 0.92, 0, 0, 1.3],
  [0.075, 0.28, 0xfff2a8, 1, 0, 0, 2.1],
  [0.08, 0.3, 0xff8c22, 0.85, 0.12, 0.05, 3.7],
  [0.07, 0.26, 0xff8c22, 0.85, -0.09, -0.1, 5.2],
];

/**
 * @typedef {Object} CampfireRenderer
 * @property {(near: { fire: Campfire }[], t: number, dt: number) => void} sync   models for exactly these fires (nearest first)
 * @property {() => number} count
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
 * @param {THREE.Scene} scene
 * @param {{ makeCanvas?: () => HTMLCanvasElement }} [opts]
 * @returns {CampfireRenderer}
 */
export function createCampfireRenderer(scene, opts = {}) {
  const makeCanvas = opts.makeCanvas ?? (() => document.createElement('canvas'));

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

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x77736c });
  const logMat = new THREE.MeshLambertMaterial({ color: 0x5a3b22 });
  const charMat = new THREE.MeshLambertMaterial({ color: 0x2b1d14 });
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff6a1a });
  const flameMats = FLAMES.map(([, , color, opacity]) => new THREE.MeshBasicMaterial({
    color, transparent: opacity < 1, opacity, depthWrite: false, side: THREE.DoubleSide,
  }));
  const smokeTex = makeSmokeTexture(makeCanvas);

  /** @type {THREE.PointLight[]} */
  const lights = [];
  for (let i = 0; i < CAMPFIRE_LIGHTS; i++) {
    const l = new THREE.PointLight(LIGHT_COLOR, 0, CAMPFIRE_LIGHT_RANGE, LIGHT_DECAY);
    scene.add(l);
    lights.push(l);
  }

  /**
   * @typedef {{ sprite: THREE.Sprite, age: number, dx: number, dz: number }} Puff
   * @type {Map<string, { group: THREE.Group, flames: THREE.Mesh[], smoke: Puff[], fire: Campfire }>}
   */
  const models = new Map();

  /** @param {Campfire} fire */
  function build(fire) {
    const group = new THREE.Group();
    group.position.set(fire.x, fire.y, fire.z);
    // Stones on the six corners of the cell (pointy-top: corner k at angle 60k − 90°), pulled in a little.
    for (let k = 0; k < 6; k++) {
      const a = ((60 * k - 90) * Math.PI) / 180;
      const s = new THREE.Mesh(stoneGeo, stoneMat);
      s.position.set(Math.cos(a) * HEX_SIZE * 0.72, 0, Math.sin(a) * HEX_SIZE * 0.72);
      s.rotation.y = a;
      group.add(s);
    }
    // Three logs crossing at 60°, stacked slightly so they do not z-fight.
    for (let k = 0; k < 3; k++) {
      const log = new THREE.Mesh(logGeo, k === 1 ? charMat : logMat);
      log.position.y = 0.07 + k * 0.035;
      log.rotation.y = (k * Math.PI) / 3 + fire.seed;
      group.add(log);
    }
    for (let k = 0; k < 7; k++) {
      const e = new THREE.Mesh(emberGeo, emberMat);
      const a = fire.seed * 3 + k * 2.4;
      const rr = 0.05 + (k % 3) * 0.05;
      e.position.set(Math.cos(a) * rr, 0.13, Math.sin(a) * rr);
      e.rotation.y = a;
      group.add(e);
    }
    const flames = FLAMES.map(([, , , , ox, oz], i) => {
      const m = new THREE.Mesh(flameGeos[i], flameMats[i]);
      m.position.set(ox, FLAME_BASE_Y, oz);
      m.renderOrder = 2 + i; // inner flames draw over the outer one
      group.add(m);
      return m;
    });
    /** @type {Puff[]} */
    const smoke = [];
    for (let i = 0; i < SMOKE_PER_FIRE; i++) {
      const mat = new THREE.SpriteMaterial({ map: smokeTex, color: 0x9a9a9a, transparent: true, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 10;
      group.add(sprite);
      // Stagger the puffs over one life so the column is continuous from the start.
      smoke.push({ sprite, age: (i / SMOKE_PER_FIRE) * SMOKE_LIFE_S, dx: 0, dz: 0 });
    }
    scene.add(group);
    return { group, flames, smoke, fire };
  }

  function drop(key) {
    const m = models.get(key);
    if (!m) return;
    scene.remove(m.group);
    for (const p of m.smoke) /** @type {THREE.SpriteMaterial} */ (p.sprite.material).dispose();
    models.delete(key);
  }

  /** @param {{ fire: Campfire }[]} near @param {number} t @param {number} dt */
  function sync(near, t, dt) {
    const keep = new Set();
    let li = 0;
    for (const { fire } of near) {
      keep.add(fire.key);
      let m = models.get(fire.key);
      if (!m) {
        m = build(fire);
        models.set(fire.key, m);
      }
      const f = flicker(t, fire.seed);
      for (let i = 0; i < m.flames.length; i++) {
        const ph = FLAMES[i][6] + fire.seed;
        const fl = m.flames[i];
        fl.scale.set(1 + 0.06 * Math.sin(t * 9 + ph), f * (1 + 0.18 * Math.sin(t * 11.3 + ph * 1.9)), 1 + 0.06 * Math.cos(t * 8 + ph));
        fl.rotation.y = t * 0.8 + ph;
        fl.rotation.z = 0.08 * Math.sin(t * 3.1 + ph);
      }
      for (const p of m.smoke) {
        p.age += dt;
        if (p.age >= SMOKE_LIFE_S) {
          p.age -= SMOKE_LIFE_S;
          // A new puff drifts a little in a direction that turns slowly with time.
          const a = t * 0.3 + fire.seed + p.age * 5;
          p.dx = Math.cos(a) * 0.12;
          p.dz = Math.sin(a) * 0.12;
        }
        const u = p.age / SMOKE_LIFE_S;
        p.sprite.position.set(p.dx * p.age, 0.65 + SMOKE_RISE * p.age, p.dz * p.age);
        const size = 0.25 + 0.75 * u;
        p.sprite.scale.set(size, size, 1);
        /** @type {THREE.SpriteMaterial} */ (p.sprite.material).opacity = 0.32 * Math.min(1, u * 8) * (1 - u);
      }
      if (li < lights.length) {
        const l = lights[li++];
        l.position.set(fire.x, fire.y + LIGHT_HEIGHT, fire.z);
        l.intensity = CAMPFIRE_LIGHT_INTENSITY * f;
      }
    }
    for (; li < lights.length; li++) lights[li].intensity = 0;
    for (const key of [...models.keys()]) if (!keep.has(key)) drop(key);
  }

  function dispose() {
    for (const key of [...models.keys()]) drop(key);
    for (const l of lights) scene.remove(l);
    for (const g of [stoneGeo, logGeo, emberGeo, ...flameGeos]) g.dispose();
    for (const m of [stoneMat, logMat, charMat, emberMat, ...flameMats]) m.dispose();
    smokeTex.dispose();
  }

  return { sync, count: () => models.size, dispose };
}
