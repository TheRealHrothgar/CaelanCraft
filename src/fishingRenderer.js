// Caelancraft — the Fishing Rod's line and float drawn (three). See src/CONTRACTS.md §106.
//
// Two draw calls: the line (one THREE.Line of LINE_POINTS points, rewritten each frame from fishing.lineCurve) and the
// float (a small hexagonal double cone, red over white, flat-shaded so its facets catch the light like the rest of the
// game). The float rides the water with a slow bob, twitches on a nibble and goes under on a bite (`dip`). Nothing here
// reads the world: main hands sync where the line runs and the float is, or null to hide them.
import * as THREE from 'three';
import { compileHidden } from './prewarm.js';

/** Points along the line (fishing.lineCurve's `n`). */
export const LINE_POINTS = 16;
/** sRGB colours: the float's cap, its belly and its quill; the line. */
export const FLOAT_COLORS = Object.freeze({ cap: 0xd04a32, belly: 0xf2eee2, quill: 0x3a2e24, line: 0x3a3a36 });
/** The float's size (m): its half-width across the flats, its cap's height and its belly's. */
export const FLOAT_R = 0.08;
export const FLOAT_CAP_H = 0.09;
export const FLOAT_BELLY_H = 0.11;
/** How far the float sinks (m) at dip 1 (a bite: it is pulled right under). */
export const FLOAT_SINK = 0.2;

/**
 * @typedef {Object} FishingView
 * @property {Float32Array} line     LINE_POINTS × 3: the rod's tip to the float (fishing.lineCurve)
 * @property {number} x @property {number} y @property {number} z   the float (y: the water's surface, or where it lies)
 * @property {number} dip            0..1 how far under it is pulled (FishingLine.dip)
 * @property {boolean} onWater       it floats (it bobs); else it lies on its side on land or flies
 * @property {number} time           s, for the bob
 */

/**
 * @typedef {Object} FishingRenderer
 * @property {(view: FishingView|null) => void} sync   draw the line and the float, or hide them
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every program now
 * @property {THREE.Group} group
 * @property {() => void} dispose
 */

/** The float's geometry: a six-sided double cone (cap up, belly down) with a short quill on top, coloured per vertex. */
export function floatGeometry() {
  const cap = new THREE.ConeGeometry(FLOAT_R, FLOAT_CAP_H, 6, 1);
  cap.translate(0, FLOAT_CAP_H / 2, 0);
  const belly = new THREE.ConeGeometry(FLOAT_R, FLOAT_BELLY_H, 6, 1);
  belly.rotateX(Math.PI);
  belly.translate(0, -FLOAT_BELLY_H / 2, 0);
  const quill = new THREE.CylinderGeometry(0.008, 0.008, 0.06, 6, 1);
  quill.translate(0, FLOAT_CAP_H + 0.03, 0);
  const parts = [[cap, FLOAT_COLORS.cap], [belly, FLOAT_COLORS.belly], [quill, FLOAT_COLORS.quill]];
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  for (const [g0, hex] of parts) {
    const g = /** @type {THREE.BufferGeometry} */ (g0).toNonIndexed();
    const p = g.getAttribute('position');
    c.setHex(/** @type {number} */ (hex), THREE.SRGBColorSpace);
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
    /** @type {THREE.BufferGeometry} */ (g0).dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed: one normal a face, flat-shaded facets
  return geo;
}

/** @param {THREE.Scene} scene @returns {FishingRenderer} */
export function createFishingRenderer(scene) {
  const group = new THREE.Group();
  group.name = 'fishing';
  group.visible = false;
  scene.add(group);

  const lineGeo = new THREE.BufferGeometry();
  const linePos = new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3);
  linePos.setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', linePos);
  const lineMat = new THREE.LineBasicMaterial({ color: FLOAT_COLORS.line, transparent: true, opacity: 0.75 });
  const line = new THREE.Line(lineGeo, lineMat);
  line.frustumCulled = false; // its bounds change every frame
  group.add(line);

  const floatGeo = floatGeometry();
  const floatMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const float = new THREE.Mesh(floatGeo, floatMat);
  group.add(float);

  /** @param {FishingView|null} view */
  function sync(view) {
    if (!view) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const n = Math.min(LINE_POINTS * 3, view.line.length);
    /** @type {Float32Array} */ (linePos.array).set(view.line.subarray(0, n));
    linePos.needsUpdate = true;
    lineGeo.setDrawRange(0, n / 3);
    const dip = Math.max(0, Math.min(1, view.dip || 0));
    if (view.onWater) {
      const bob = Math.sin(view.time * 2.2) * 0.012;
      float.position.set(view.x, view.y + bob - dip * FLOAT_SINK, view.z);
      float.rotation.set(Math.sin(view.time * 1.7) * 0.08 + dip * 0.5, 0, Math.cos(view.time * 1.3) * 0.08);
    } else {
      float.position.set(view.x, view.y + FLOAT_R, view.z);
      float.rotation.set(0, 0, Math.PI / 2); // on its side
    }
  }

  return {
    sync,
    group,
    prewarm: (webgl, camera) => compileHidden([group], webgl, camera, scene),
    dispose() {
      scene.remove(group);
      lineGeo.dispose();
      lineMat.dispose();
      floatGeo.dispose();
      floatMat.dispose();
    },
  };
}
