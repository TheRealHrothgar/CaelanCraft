// Caelancraft — the Pennants drawn (three). See src/CONTRACTS.md §101.4.
//
// Each nearby pennant is a small stone foot, a six-sided wooden pole and a honey knob (three InstancedMeshes shared by
// every pennant), and a cloth flag. Every flag is written into ONE dynamic geometry each frame (pennants.flagRibbon in the
// pennant's own frame, turned to the wind and set under its knob), so all the flags are one draw call: four draw calls
// however many pennants there are. The cloth is honey with a teal band, lit and flat-shaded: as the wave runs along it the
// facets catch the light (the hex-faceted look), and both its sides are drawn.
//
// Nothing here reads the world: main gives sync the pennants to draw (nearest first), the wind, the clock and how high
// each pole stands (pennants.poleHeight of the block above it).
import * as THREE from 'three';
import { compileHidden } from './prewarm.js';
import {
  FLAG_FLOATS, PENNANT_FLAG_DROP, PENNANT_FLAG_HOIST, PENNANT_FLAG_LENGTH, PENNANT_MAX_MODELS, PENNANT_POLE_RADIUS,
  PENNANT_SEGMENTS, flagRibbon,
} from './pennants.js';

/** sRGB colours: the cloth (honey, the teal band), the pole, the knob, the stone foot. */
export const PENNANT_COLORS = Object.freeze({
  honey: 0xf2b33d, teal: 0x2f9e8f, pole: 0x8a5a2c, knob: 0xf2b33d, foot: 0x8a8f94,
});
/** The flag's columns that are teal: the band across its middle third (segments [TEAL_FROM, TEAL_TO)). */
export const TEAL_FROM = 3;
export const TEAL_TO = 6;
/** Triangles of one flag: two per segment. */
export const FLAG_TRIANGLES = PENNANT_SEGMENTS * 2;

/** @typedef {import('./pennants.js').Pennant} Pennant */
/** @typedef {import('./wind.js').Wind} Wind */

/**
 * @typedef {Object} PennantRenderer
 * @property {(near: { pennant: Pennant, dist: number }[], wind: Wind|null, t: number, heightOf: (p: Pennant) => number) => void} sync
 *   draw exactly these pennants (the first `capacity`), their flags in this wind at time `t` (s); `heightOf(p)` is the
 *   pole's height
 * @property {() => number} count       pennants drawn
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every program now
 * @property {THREE.Group} group
 * @property {() => void} dispose
 */

/**
 * @param {THREE.Scene} scene
 * @param {{ capacity?: number }} [opts]  capacity: most pennants drawn at once (default PENNANT_MAX_MODELS)
 * @returns {PennantRenderer}
 */
export function createPennantRenderer(scene, opts = {}) {
  const capacity = Math.max(1, Math.floor(opts.capacity ?? PENNANT_MAX_MODELS));
  const group = new THREE.Group();
  group.name = 'pennants';
  scene.add(group);

  // The pole: a unit-tall hexagonal prism standing on its foot (scaled to each pole's height); the foot and the knob.
  const poleGeo = new THREE.CylinderGeometry(PENNANT_POLE_RADIUS, PENNANT_POLE_RADIUS * 1.15, 1, 6);
  poleGeo.translate(0, 0.5, 0);
  const footGeo = new THREE.CylinderGeometry(0.11, 0.14, 0.08, 6);
  footGeo.translate(0, 0.04, 0);
  const knobGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.07, 6);
  const poleMat = new THREE.MeshLambertMaterial({ color: PENNANT_COLORS.pole });
  const footMat = new THREE.MeshLambertMaterial({ color: PENNANT_COLORS.foot });
  const knobMat = new THREE.MeshLambertMaterial({ color: PENNANT_COLORS.knob });

  /** @returns {THREE.InstancedMesh} */
  function part(geo, mat, name) {
    const m = new THREE.InstancedMesh(geo, mat, capacity);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.name = name;
    group.add(m);
    return m;
  }
  const poles = part(poleGeo, poleMat, 'pennant-poles');
  const feet = part(footGeo, footMat, 'pennant-feet');
  const knobs = part(knobGeo, knobMat, 'pennant-knobs');

  // Every flag in one non-indexed geometry: FLAG_TRIANGLES triangles each, a colour per triangle (the band edges stay
  // sharp), positions rewritten every frame.
  const vertsPerFlag = FLAG_TRIANGLES * 3;
  const flagPositions = new Float32Array(capacity * vertsPerFlag * 3);
  const flagColors = new Float32Array(capacity * vertsPerFlag * 3);
  const honey = new THREE.Color().setHex(PENNANT_COLORS.honey, THREE.SRGBColorSpace);
  const teal = new THREE.Color().setHex(PENNANT_COLORS.teal, THREE.SRGBColorSpace);
  for (let f = 0; f < capacity; f++) {
    for (let s = 0; s < PENNANT_SEGMENTS; s++) {
      const c = s >= TEAL_FROM && s < TEAL_TO ? teal : honey;
      for (let v = 0; v < 6; v++) {
        const o = ((f * PENNANT_SEGMENTS + s) * 6 + v) * 3;
        flagColors[o] = c.r;
        flagColors[o + 1] = c.g;
        flagColors[o + 2] = c.b;
      }
    }
  }
  const flagGeo = new THREE.BufferGeometry();
  const aFlagPos = new THREE.BufferAttribute(flagPositions, 3).setUsage(THREE.DynamicDrawUsage);
  flagGeo.setAttribute('position', aFlagPos);
  flagGeo.setAttribute('color', new THREE.BufferAttribute(flagColors, 3));
  flagGeo.setDrawRange(0, 0);
  flagGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const flagMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const flags = new THREE.Mesh(flagGeo, flagMat);
  flags.name = 'pennant-flags';
  flags.frustumCulled = false;
  flags.visible = false;
  group.add(flags);

  const ribbon = new Float32Array(FLAG_FLOATS);
  const dummy = new THREE.Object3D();
  let shown = 0;

  /**
   * Write flag `f`: the ribbon of pennant `p` (pole `height` m) turned so its +x runs downwind (dx, dz) and its +z across
   * the wind (−dz, dx), its root on the pole's downwind face with its top corner under the knob.
   */
  function writeFlag(f, p, height, strength, gust, t, dx, dz) {
    const length = PENNANT_FLAG_LENGTH * height;
    const hoist = PENNANT_FLAG_HOIST * height;
    flagRibbon(strength, gust, t, p.seed, length, hoist, ribbon);
    const ox = p.x;
    const oy = p.y + height - PENNANT_FLAG_DROP;
    const oz = p.z;
    // across the wind: downwind turned a quarter turn
    const sx = -dz;
    const sz = dx;
    let o = f * vertsPerFlag * 3;
    const put = (col, bottom) => {
      const k = col * 6 + (bottom ? 3 : 0);
      const lx = ribbon[k];
      const ly = ribbon[k + 1];
      const lz = ribbon[k + 2];
      flagPositions[o++] = ox + lx * dx + lz * sx + PENNANT_POLE_RADIUS * dx;
      flagPositions[o++] = oy + ly;
      flagPositions[o++] = oz + lx * dz + lz * sz + PENNANT_POLE_RADIUS * dz;
    };
    for (let s = 0; s < PENNANT_SEGMENTS; s++) {
      // two triangles: (top s, bottom s, bottom s+1) and (top s, bottom s+1, top s+1)
      put(s, false);
      put(s, true);
      put(s + 1, true);
      put(s, false);
      put(s + 1, true);
      put(s + 1, false);
    }
  }

  /** @type {PennantRenderer['sync']} */
  function sync(near, wind, t, heightOf) {
    const n = Math.min(near.length, capacity);
    const strength = wind && Number.isFinite(wind.strength) ? wind.strength : 0;
    const gust = wind && Number.isFinite(wind.gust) ? wind.gust : 0;
    let dx = wind && Number.isFinite(wind.x) ? wind.x : 0;
    let dz = wind && Number.isFinite(wind.z) ? wind.z : 1;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      dx /= len;
      dz /= len;
    } else {
      dx = 0;
      dz = 1;
    }
    for (let i = 0; i < n; i++) {
      const p = near[i].pennant;
      const h = heightOf(p);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      feet.setMatrixAt(i, dummy.matrix);
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, p.y + h + 0.02, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      knobs.setMatrixAt(i, dummy.matrix);
      writeFlag(i, p, h, strength, gust, t, dx, dz);
    }
    for (const m of [poles, feet, knobs]) {
      m.count = n;
      m.visible = n > 0;
      if (n > 0) m.instanceMatrix.needsUpdate = true;
    }
    flagGeo.setDrawRange(0, n * vertsPerFlag);
    flags.visible = n > 0;
    if (n > 0) aFlagPos.needsUpdate = true;
    shown = n;
  }

  return {
    sync,
    count: () => shown,
    prewarm: (webgl, camera) => compileHidden([group], webgl, camera, scene),
    group,
    dispose() {
      scene.remove(group);
      for (const m of [poles, feet, knobs]) m.dispose();
      for (const g of [poleGeo, footGeo, knobGeo, flagGeo]) g.dispose();
      for (const m of [poleMat, footMat, knobMat, flagMat]) m.dispose();
    },
  };
}
