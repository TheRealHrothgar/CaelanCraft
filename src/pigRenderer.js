// Caelancraft — pig models (three). See src/CONTRACTS.md §30 and §69.1.
//
// A pig is built facing −Z with its origin at the feet, so a rotation of `pig.yaw` about +Y matches yawToForward
// (the camera uses the same convention). It is HEX-FACETED (animalModels.js, over the animals' shared atlas): a round
// hexagonal barrel of a body with fine pale bristles and a curly tail, a faceted head with a snout disc, floppy ears tipped
// forward and rosy cheeks, four short legs with muddy trotters that swing with `pig.walkPhase`.
//
// A pig's optional `renderScale` (default 1) scales the whole model about its feet and its optional `renderSpin`
// (default 0) adds to its yaw: a pig swallowed by a black hole is drawn as a shrinking, spinning ghost (infall.js,
// DESIGN-circuits §2.7, §6.2.13). Without them the output is exactly as before.
//
// Every pig shares a handful of InstancedMeshes, so all pigs together cost 3 draw calls (6 while one flashes):
//   skin      the body and its tail
//   head      the head, snout and ears: it nods to root while the pig stands idle (small: it stays in PIG_HEAD_BOX), and
//             eases back up (HEAD_RATE)
//   legs      one instance per leg (4 per pig), pivoting at the hip so the swing is a rotation about x
//   skin-hurt / head-hurt / legs-hurt  the same geometry with the red emissive flash: a pig with `hurt > 0` is drawn there
//   tusks     §88: a grown boar's two tusks, curving up beside the snout (one more draw call while a boar is in view)
//   tag       §88: a tame pig's ribbon and bow (one more while a tame one is in view)
//   snare     a snared pig's loop of cord round its left hind trotter (one more while one is held)
// §88: a piglet (`size` below 1) is drawn at its size, about its feet, its head larger and its body rounder.
import * as THREE from 'three';
import { PIG_MAX } from './config.js';
import { compileHidden } from './prewarm.js';
import { ANIMAL_RIGS } from './animalModels.js';
import { faunaAssets, faunaMaterial, headPitch, headEaser, youthOf, HEAD_RATE, YOUNG_HEAD, YOUNG_ROUND } from './animalRenderer.js';

/** @typedef {import('./pigs.js').Pig} Pig */

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.6;

const RIG = ANIMAL_RIGS.pig;
const LEG_H = RIG.legH;
const LEG_SWING = RIG.swing;
/** Hip positions (x, z) of the legs: front-left, front-right, back-left, back-right. */
const LEG_HIPS = [[-RIG.legX, RIG.legZ[0]], [RIG.legX, RIG.legZ[0]], [-RIG.legX, RIG.legZ[1]], [RIG.legX, RIG.legZ[1]]];
/** Diagonal pairs swing together: front-left with back-right. */
const LEG_SIGN = [1, -1, -1, 1];

/**
 * @typedef {Object} PigRenderer
 * @property {(pigs: Pig[], dt?: number) => void} sync   draw the given pigs (position, yaw, leg swing, hurt flash; renderScale
 *                                          and renderSpin when set; `dt` eases the heads, measured when absent)
 * @property {() => number} count           pigs drawn by the last sync
 * @property {() => void} dispose
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile its programs now
 * @property {THREE.Group} group            the instanced meshes (for tests and diagnostics)
 */

/** A body's model scale: its `renderScale` when a positive number, else 1. */
export function renderScaleOf(body) {
  const s = body.renderScale;
  return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
}

/** §88: a pig's size (a piglet's below 1): its `size` when a number in (0, 1), else 1. */
export function pigSizeOf(pig) {
  const s = pig.size;
  return typeof s === 'number' && s > 0 && s < 1 ? s : 1;
}

/** A body's extra yaw: its `renderSpin` when a finite number, else 0. */
export function renderSpinOf(body) {
  const s = body.renderSpin;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * @param {THREE.Scene} scene
 * @param {number} [capacity=PIG_MAX] most pigs drawn (pigs past it are not drawn); main passes PIG_MAX + MAX_INFALL_MOBS
 *   so a ghost is never dropped from a full list
 * @returns {PigRenderer}
 */
export function createPigRenderer(scene, capacity = PIG_MAX) {
  const A = faunaAssets();
  const K = A.models.kinds.pig;
  const mats = {
    skin: faunaMaterial(A.texture, 0x000000),
    hurt: faunaMaterial(A.texture, HURT, HURT_INTENSITY),
  };
  const group = new THREE.Group();
  group.name = 'pigs';
  const instanced = (geo, mat, n, name) => {
    const mesh = new THREE.InstancedMesh(A.buffer(geo), mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances move every frame; cheaper than re-bounding
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  const meshes = {
    skin: instanced(K.parts.body, mats.skin, capacity, 'pig-skin'),
    head: instanced(K.parts.head, mats.skin, capacity, 'pig-head'),
    legs: instanced(K.parts.legs, mats.skin, capacity * 4, 'pig-legs'),
    skinHurt: instanced(K.parts.body, mats.hurt, capacity, 'pig-skin-hurt'),
    headHurt: instanced(K.parts.head, mats.hurt, capacity, 'pig-head-hurt'),
    legsHurt: instanced(K.parts.legs, mats.hurt, capacity * 4, 'pig-legs-hurt'),
    tusks: instanced(K.parts.tusks, mats.skin, capacity, 'pig-tusks'),
    tag: instanced(K.parts.tag, mats.skin, capacity, 'pig-tag'),
    snare: instanced(A.models.snare, mats.skin, capacity, 'pig-snare'),
  };
  scene.add(group);
  const pos = K.parts.body.positions;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < pos.length; i += 3) {
    lo = Math.min(lo, pos[i]);
    hi = Math.max(hi, pos[i]);
  }
  const trunkY = (lo + hi) / 2;
  const H = /** @type {NonNullable<typeof RIG.head>} */ (RIG.head);

  const pigM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const legM = new THREE.Matrix4();
  const hipM = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const loopM = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const yawQ = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const ease = headEaser();
  let drawn = 0;
  let lastT = -1;

  /** @param {Pig[]} pigs @param {number} [dt] */
  function sync(pigs, dt) {
    let step = dt;
    if (typeof step !== 'number' || !Number.isFinite(step)) {
      const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
      step = lastT < 0 ? 1 : Math.min(0.25, Math.max(0, now - lastT));
      lastT = now;
    }
    const k = 1 - Math.exp(-HEAD_RATE * Math.max(0, step));
    const n = Math.min(pigs.length, capacity);
    let skins = 0;
    let hurts = 0;
    let tusks = 0;
    let tags = 0;
    let snares = 0;
    for (let i = 0; i < n; i++) {
      const pig = pigs[i];
      const young = pigSizeOf(pig);
      const youth = youthOf(pig);
      const s = renderScaleOf(pig) * young;
      pigM.compose(at.set(pig.x, pig.y, pig.z), yawQ.setFromAxisAngle(UP, pig.yaw + renderSpinOf(pig)), scl.set(s, s, s));
      const hurt = pig.hurt > 0;
      const body = hurt ? meshes.skinHurt : meshes.skin;
      const head = hurt ? meshes.headHurt : meshes.head;
      const legs = hurt ? meshes.legsHurt : meshes.legs;
      const slot = hurt ? hurts++ : skins++;
      if (youth > 0) {
        const [rx, ry, rz] = YOUNG_ROUND;
        partM.copy(pigM).multiply(tmp.makeTranslation(0, trunkY, 0))
          .multiply(rot.makeScale(1 + (rx - 1) * youth, 1 + (ry - 1) * youth, 1 + (rz - 1) * youth)).multiply(tmp.makeTranslation(0, -trunkY, 0));
        body.setMatrixAt(slot, partM);
      } else {
        body.setMatrixAt(slot, pigM);
      }
      // the head roots while it stands, and is larger on a piglet
      const pitch = ease(pig, headPitch(pig, RIG), k);
      const hs = 1 + YOUNG_HEAD * youth;
      partM.copy(pigM).multiply(tmp.makeTranslation(H.pivot[0], H.pivot[1], H.pivot[2])).multiply(rot.makeRotationX(pitch));
      if (hs !== 1) partM.multiply(rot.makeScale(hs, hs, hs));
      partM.multiply(tmp.makeTranslation(-H.pivot[0], -H.pivot[1], -H.pivot[2]));
      head.setMatrixAt(slot, partM);
      if (/** @type {*} */ (pig).sex === 'm' && young >= 1) meshes.tusks.setMatrixAt(tusks++, partM);
      if (/** @type {*} */ (pig).tamed) meshes.tag.setMatrixAt(tags++, partM);
      const swing = Math.sin(pig.walkPhase) * LEG_SWING;
      for (let leg = 0; leg < 4; leg++) {
        hipM.makeTranslation(LEG_HIPS[leg][0], LEG_H, LEG_HIPS[leg][1]);
        legM.multiplyMatrices(pigM, hipM).multiply(rot.makeRotationX(LEG_SIGN[leg] * swing));
        legs.setMatrixAt(slot * 4 + leg, legM);
        // a snared pig: the cord's loop round its left hind trotter
        if (leg === 2 && /** @type {*} */ (pig).trapped > 0) {
          meshes.snare.setMatrixAt(snares++, tmp.copy(legM).multiply(rot.makeTranslation(0, -LEG_H + 0.05, 0)).multiply(loopM.makeScale(RIG.legW, RIG.legW, RIG.legW)));
        }
      }
    }
    const setCount = (mesh, count) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    };
    setCount(meshes.skin, skins);
    setCount(meshes.head, skins);
    setCount(meshes.skinHurt, hurts);
    setCount(meshes.headHurt, hurts);
    setCount(meshes.legs, skins * 4);
    setCount(meshes.legsHurt, hurts * 4);
    setCount(meshes.tusks, tusks);
    setCount(meshes.tag, tags);
    setCount(meshes.snare, snares);
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of Object.values(meshes)) mesh.dispose();
    for (const mat of Object.values(mats)) mat.dispose();
    // the atlas and the geometries are shared with the animals (faunaAssets)
    drawn = 0;
  }

  /** Compile every pig program while the game loads (prewarm.compileHidden; KNOWN-ISSUES P2's twin). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
