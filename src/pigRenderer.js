// Caelancraft — pig models (three). See src/CONTRACTS.md §30.
//
// A pig is built facing −Z with its origin at the feet, so a rotation of `pig.yaw` about +Y matches yawToForward
// (the camera uses the same convention). The body is a hexagonal prism lying along the pig — the honeycomb motif of
// the world — with a box head, snout, ears, eyes, a tail and four legs that swing with `pig.walkPhase`.
//
// Every pig shares a handful of InstancedMeshes, so all pigs together cost 3 draw calls (5 while one flashes):
//   skin      body + head + ears + tail merged into one geometry (pink)
//   features  snout + nostrils + eyes + pupils merged, coloured per vertex
//   legs      one instance per leg (4 per pig), pivoting at the hip so the swing is a rotation about x
//   skinHurt / legsHurt  the same geometry with the red emissive flash: a pig with `hurt > 0` is drawn there
import * as THREE from 'three';
import { PIG_MAX } from './config.js';

/** @typedef {import('./pigs.js').Pig} Pig */

const PINK = 0xf2a7b5;
const SNOUT = 0xe0808f;
const DARK = 0x3a1f26;
const WHITE = 0xffffff;
const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.6;

const LEG_H = 0.3;
const BODY_R = 0.32;
const BODY_LEN = 0.82;
const BODY_Y = LEG_H + BODY_R * Math.cos(Math.PI / 6); // flat underside resting on the legs
const LEG_SWING = 0.6;
/** Hip positions (x, z) of the legs: front-left, front-right, back-left, back-right. */
const LEG_HIPS = [[-0.16, -0.26], [0.16, -0.26], [-0.16, 0.32], [0.16, 0.32]];
/** Diagonal pairs swing together: front-left with back-right. */
const LEG_SIGN = [1, -1, -1, 1];

/**
 * @typedef {Object} PigRenderer
 * @property {(pigs: Pig[]) => void} sync   draw the given pigs (position, yaw, leg swing, hurt flash)
 * @property {() => number} count           pigs drawn by the last sync
 * @property {() => void} dispose
 * @property {THREE.Group} group            the instanced meshes (for tests and diagnostics)
 */

/**
 * @typedef {{ geo: THREE.BufferGeometry, x: number, y: number, z: number, rx?: number, rz?: number, color?: number }} Part
 */

/**
 * Bake parts (each placed and rotated in the pig's frame) into one indexed geometry with positions and normals, plus
 * per-vertex colours when the parts have a `color`.
 * @param {Part[]} parts
 * @returns {THREE.BufferGeometry}
 */
function mergeParts(parts) {
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const normals = [];
  /** @type {number[]} */
  const colors = [];
  /** @type {number[]} */
  const indices = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const at = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.geo.clone();
    g.applyMatrix4(m.compose(at.set(p.x, p.y, p.z), q.setFromEuler(e.set(p.rx ?? 0, 0, p.rz ?? 0)), one));
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    }
    if (p.color !== undefined) {
      c.setHex(p.color); // sRGB hex → linear working colour, exactly what a material `color` gets
      for (let i = 0; i < pos.count; i++) colors.push(c.r, c.g, c.b);
    }
    for (const i of /** @type {THREE.BufferAttribute} */ (g.index).array) indices.push(base + i);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (colors.length) out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  return out;
}

/**
 * @param {THREE.Scene} scene
 * @param {number} [capacity=PIG_MAX] most pigs drawn (pigs past it are not drawn)
 * @returns {PigRenderer}
 */
export function createPigRenderer(scene, capacity = PIG_MAX) {
  // Hex prism lying along Z with a flat face down: CylinderGeometry's axis is Y; rotate it onto Z, then turn it
  // about Z by 30° so a side (not an edge) faces the ground.
  const bodyGeo = new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_LEN, 6);
  bodyGeo.rotateX(Math.PI / 2);
  bodyGeo.rotateZ(Math.PI / 6);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const geos = {
    head: box(0.42, 0.4, 0.36),
    snout: box(0.22, 0.15, 0.08),
    nostril: box(0.04, 0.05, 0.02),
    eye: box(0.07, 0.07, 0.02),
    pupil: box(0.035, 0.05, 0.02),
    ear: box(0.12, 0.12, 0.04),
    tail: box(0.06, 0.06, 0.14),
  };
  const headZ = -BODY_LEN / 2 - 0.1;
  const headY = BODY_Y + 0.12;
  const front = headZ - 0.18;
  /** @type {Part[]} */
  const skinParts = [
    { geo: bodyGeo, x: 0, y: BODY_Y, z: 0.05 },
    { geo: geos.head, x: 0, y: headY, z: headZ },
    { geo: geos.tail, x: 0, y: BODY_Y + 0.12, z: BODY_LEN / 2 + 0.1, rx: -0.6 },
  ];
  /** @type {Part[]} */
  const featureParts = [
    { geo: geos.snout, x: 0, y: headY - 0.06, z: front - 0.04, color: SNOUT },
    { geo: geos.nostril, x: -0.05, y: headY - 0.06, z: front - 0.085, color: DARK },
    { geo: geos.nostril, x: 0.05, y: headY - 0.06, z: front - 0.085, color: DARK },
  ];
  for (const s of [-1, 1]) {
    featureParts.push({ geo: geos.eye, x: s * 0.12, y: headY + 0.07, z: front - 0.005, color: WHITE });
    featureParts.push({ geo: geos.pupil, x: s * 0.135, y: headY + 0.065, z: front - 0.015, color: DARK });
    skinParts.push({ geo: geos.ear, x: s * 0.15, y: headY + 0.24, z: headZ + 0.05, rz: s * 0.35 });
  }
  const skinGeo = mergeParts(skinParts);
  const featureGeo = mergeParts(featureParts);
  bodyGeo.dispose();
  for (const g of Object.values(geos)) g.dispose();
  // Leg geometry pivots at its top so a rotation about x swings it like a hip.
  const legGeo = box(0.13, LEG_H, 0.13);
  legGeo.translate(0, -LEG_H / 2, 0);

  const mats = {
    skin: new THREE.MeshLambertMaterial({ color: PINK, emissive: 0x000000 }),
    hurt: new THREE.MeshLambertMaterial({ color: PINK, emissive: HURT, emissiveIntensity: HURT_INTENSITY }),
    features: new THREE.MeshLambertMaterial({ color: WHITE, vertexColors: true }),
  };
  const group = new THREE.Group();
  group.name = 'pigs';
  const instanced = (geo, mat, n, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances move every frame; ~330 vertices a pig are cheaper than re-bounding
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  const meshes = {
    skin: instanced(skinGeo, mats.skin, capacity, 'pig-skin'),
    skinHurt: instanced(skinGeo, mats.hurt, capacity, 'pig-skin-hurt'),
    features: instanced(featureGeo, mats.features, capacity, 'pig-features'),
    legs: instanced(legGeo, mats.skin, capacity * 4, 'pig-legs'),
    legsHurt: instanced(legGeo, mats.hurt, capacity * 4, 'pig-legs-hurt'),
  };
  scene.add(group);

  const pigM = new THREE.Matrix4();
  const legM = new THREE.Matrix4();
  const hipM = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const yawQ = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  /** @param {Pig[]} pigs */
  function sync(pigs) {
    const n = Math.min(pigs.length, capacity);
    let skins = 0;
    let hurts = 0;
    for (let i = 0; i < n; i++) {
      const pig = pigs[i];
      pigM.compose(at.set(pig.x, pig.y, pig.z), yawQ.setFromAxisAngle(UP, pig.yaw), one);
      meshes.features.setMatrixAt(i, pigM);
      const hurt = pig.hurt > 0;
      const body = hurt ? meshes.skinHurt : meshes.skin;
      const legs = hurt ? meshes.legsHurt : meshes.legs;
      const slot = hurt ? hurts++ : skins++;
      body.setMatrixAt(slot, pigM);
      const swing = Math.sin(pig.walkPhase) * LEG_SWING;
      for (let k = 0; k < 4; k++) {
        hipM.makeTranslation(LEG_HIPS[k][0], LEG_H, LEG_HIPS[k][1]);
        legM.multiplyMatrices(pigM, hipM).multiply(rot.makeRotationX(LEG_SIGN[k] * swing));
        legs.setMatrixAt(slot * 4 + k, legM);
      }
    }
    const setCount = (mesh, count) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    };
    setCount(meshes.features, n);
    setCount(meshes.skin, skins);
    setCount(meshes.skinHurt, hurts);
    setCount(meshes.legs, skins * 4);
    setCount(meshes.legsHurt, hurts * 4);
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of Object.values(meshes)) mesh.dispose();
    skinGeo.dispose();
    featureGeo.dispose();
    legGeo.dispose();
    for (const mat of Object.values(mats)) mat.dispose();
    drawn = 0;
  }

  return { sync, count: () => drawn, dispose, group };
}
