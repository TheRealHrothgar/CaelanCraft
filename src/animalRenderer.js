// Caelancraft — animal models (three): cattle, sheep, horses and wolves. See src/CONTRACTS.md §69.
//
// Chunky boxes coloured per vertex, like the pig and the zombie (zombieRenderer.boxesGeometry): each species is a body
// (trunk, head and features merged) and four legs that swing from the hip with `walkPhase`, diagonal pairs together. The
// models face −Z with their origin at the feet, so a rotation of `animal.yaw` about +Y matches yawToForward.
// Variants are their own bodies: a shorn sheep is thin and pink-grey, a tame horse wears a saddle and a blanket, a tame
// wolf a red collar. All animals share the InstancedMeshes (per species: a body or its variant, and the legs), and an
// animal with `hurt > 0` is drawn on the red-flash twins.
import * as THREE from 'three';
import { boxesGeometry } from './zombieRenderer.js';
import { ANIMAL_MAX, ANIMAL_KINDS } from './animals.js';

/** @typedef {import('./animals.js').Animal} Animal */

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.7;
/** A faint glow of their own so they read at night (like the zombies'). */
const NIGHT_GLOW = 0x1a1a1a;
const DARK = 0x2a2420;
const WHITE = 0xf6f2ea;

/**
 * Per species: `legH` the hip height, `legW` the leg's width, `legX` / `legZ` the hips (±x, front −z and back +z), `swing`
 * the stride (rad), `leg` the leg's colours [upper, hoof], and the bodies' boxes [w, h, d, x, y, z, colour, rotZ?].
 */
const COW = 0x8b5a3c;
const SHEEP = 0xf3f0e7;
const HORSE = 0x9c5a2e;
const WOLF = 0x8c9096;
export const MODELS = Object.freeze({
  cow: {
    legH: 0.55, legW: 0.15, legX: 0.2, legZ: [-0.4, 0.4], swing: 0.45, leg: [COW, DARK],
    body: [
      [0.62, 0.6, 1.15, 0, 0.85, 0, COW],
      [0.3, 0.3, 0.02, 0.17, 0.92, -0.585, WHITE], [0.02, 0.34, 0.4, 0.315, 0.9, 0.1, WHITE], [0.02, 0.3, 0.34, -0.315, 0.86, -0.2, WHITE],
      [0.34, 0.02, 0.4, 0.05, 1.155, 0.2, WHITE], // white patches
      [0.38, 0.4, 0.42, 0, 1.0, -0.76, COW], // head
      [0.3, 0.2, 0.14, 0, 0.88, -1.0, 0xe9b3a4], // muzzle
      [0.06, 0.05, 0.02, -0.08, 0.88, -1.075, DARK], [0.06, 0.05, 0.02, 0.08, 0.88, -1.075, DARK], // nostrils
      [0.07, 0.07, 0.02, -0.12, 1.08, -0.975, DARK], [0.07, 0.07, 0.02, 0.12, 1.08, -0.975, DARK], // eyes
      [0.1, 0.07, 0.07, -0.23, 1.22, -0.72, 0xefe6d2], [0.1, 0.07, 0.07, 0.23, 1.22, -0.72, 0xefe6d2], // horns
      [0.1, 0.06, 0.1, -0.24, 1.08, -0.7, COW], [0.1, 0.06, 0.1, 0.24, 1.08, -0.7, COW], // ears
      [0.3, 0.1, 0.3, 0, 0.52, 0.25, 0xe9b3a4], // udder
      [0.06, 0.4, 0.06, 0, 0.9, 0.6, COW], [0.09, 0.1, 0.09, 0, 0.66, 0.6, DARK], // tail
    ],
  },
  sheep: {
    legH: 0.42, legW: 0.11, legX: 0.17, legZ: [-0.27, 0.27], swing: 0.55, leg: [0x4a443e, DARK],
    body: [
      [0.62, 0.56, 0.88, 0, 0.68, 0.02, SHEEP],
      [0.5, 0.1, 0.7, 0, 0.99, 0.02, 0xfffdf6], // the fleece's top
      [0.28, 0.3, 0.3, 0, 0.8, -0.56, 0x4a443e], // head
      [0.3, 0.12, 0.22, 0, 0.98, -0.5, SHEEP], // woolly cap
      [0.05, 0.05, 0.02, -0.08, 0.84, -0.715, WHITE], [0.05, 0.05, 0.02, 0.08, 0.84, -0.715, WHITE], // eyes
      [0.1, 0.05, 0.08, -0.18, 0.84, -0.5, 0x4a443e], [0.1, 0.05, 0.08, 0.18, 0.84, -0.5, 0x4a443e], // ears
      [0.12, 0.12, 0.1, 0, 0.72, 0.48, SHEEP], // tail
    ],
    alt: [
      [0.4, 0.4, 0.78, 0, 0.62, 0.02, 0xdccbbd],
      [0.28, 0.3, 0.3, 0, 0.8, -0.52, 0x4a443e],
      [0.05, 0.05, 0.02, -0.08, 0.84, -0.675, WHITE], [0.05, 0.05, 0.02, 0.08, 0.84, -0.675, WHITE],
      [0.1, 0.05, 0.08, -0.18, 0.84, -0.46, 0x4a443e], [0.1, 0.05, 0.08, 0.18, 0.84, -0.46, 0x4a443e],
      [0.08, 0.08, 0.08, 0, 0.66, 0.43, 0xdccbbd],
    ],
  },
  horse: {
    legH: 0.9, legW: 0.14, legX: 0.17, legZ: [-0.48, 0.48], swing: 0.6, leg: [HORSE, DARK],
    body: horseBody(false),
    alt: horseBody(true),
  },
  wolf: {
    legH: 0.4, legW: 0.1, legX: 0.12, legZ: [-0.28, 0.28], swing: 0.7, leg: [WOLF, 0x5c6066],
    body: wolfBody(false),
    alt: wolfBody(true),
  },
});

/** @param {boolean} tame a saddle and a blanket */
function horseBody(tame) {
  const MANE = 0x3a2414;
  const boxes = [
    [0.5, 0.55, 1.3, 0, 1.17, 0, HORSE],
    [0.26, 0.62, 0.32, 0, 1.6, -0.6, HORSE], // neck
    [0.24, 0.26, 0.5, 0, 1.86, -0.86, HORSE], // head
    [0.2, 0.16, 0.14, 0, 1.8, -1.14, 0x6e3e1e], // muzzle
    [0.06, 0.06, 0.02, -0.125, 1.92, -0.8, DARK], [0.06, 0.06, 0.02, 0.125, 1.92, -0.8, DARK], // eyes (on the sides)
    [0.06, 0.12, 0.06, -0.08, 2.04, -0.68, HORSE], [0.06, 0.12, 0.06, 0.08, 2.04, -0.68, HORSE], // ears
    [0.08, 0.6, 0.12, 0, 1.68, -0.42, MANE], [0.1, 0.1, 0.2, 0, 2.0, -0.78, MANE], // mane and forelock
    [0.1, 0.55, 0.1, 0, 1.0, 0.68, MANE], // tail
    [0.08, 0.14, 0.02, 0, 1.9, -1.115, WHITE], // a blaze
  ];
  if (tame) {
    boxes.push([0.54, 0.06, 0.6, 0, 1.47, 0.02, 0xc0392b]); // blanket
    boxes.push([0.4, 0.1, 0.42, 0, 1.53, 0.02, 0x6e3e1e]); // saddle
    boxes.push([0.4, 0.12, 0.06, 0, 1.6, 0.22, 0x5a301a]); // cantle
  }
  return boxes;
}

/** @param {boolean} tame a red collar */
function wolfBody(tame) {
  const PALE = 0xc9ccd0;
  const boxes = [
    [0.36, 0.36, 0.86, 0, 0.58, 0, WOLF],
    [0.3, 0.16, 0.6, 0, 0.44, 0.02, PALE], // belly
    [0.32, 0.3, 0.3, 0, 0.74, -0.52, WOLF], // head
    [0.16, 0.14, 0.22, 0, 0.68, -0.76, PALE], // snout
    [0.07, 0.05, 0.03, 0, 0.72, -0.875, DARK], // nose
    [0.06, 0.05, 0.02, -0.09, 0.8, -0.675, 0xf2c14a], [0.06, 0.05, 0.02, 0.09, 0.8, -0.675, 0xf2c14a], // amber eyes
    [0.08, 0.14, 0.06, -0.11, 0.95, -0.46, WOLF], [0.08, 0.14, 0.06, 0.11, 0.95, -0.46, WOLF], // ears
    [0.13, 0.13, 0.42, 0, 0.66, 0.6, WOLF], [0.1, 0.1, 0.12, 0, 0.68, 0.84, PALE], // tail
  ];
  if (tame) boxes.push([0.36, 0.08, 0.08, 0, 0.72, -0.34, 0xd9342b]);
  return boxes;
}

/**
 * @typedef {Object} AnimalRenderer
 * @property {(animals: ReadonlyArray<Animal>) => void} sync   draw the given animals
 * @property {() => number} count
 * @property {() => void} dispose
 * @property {THREE.Group} group
 */

/** Which body an animal is drawn with: its species' `alt` for a shorn sheep, a tame horse or a tame wolf. */
export function bodyVariant(a) {
  if (a.kind === 'sheep') return a.shorn > 0 ? 'alt' : 'body';
  if (a.kind === 'horse' || a.kind === 'wolf') return a.tamed ? 'alt' : 'body';
  return 'body';
}

/**
 * @param {THREE.Scene} scene
 * @param {number} [capacity=ANIMAL_MAX]
 * @returns {AnimalRenderer}
 */
export function createAnimalRenderer(scene, capacity = ANIMAL_MAX) {
  const mats = {
    base: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: NIGHT_GLOW }),
    hurt: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: HURT, emissiveIntensity: HURT_INTENSITY }),
  };
  const group = new THREE.Group();
  group.name = 'animals';
  /** @type {THREE.BufferGeometry[]} */
  const geos = [];
  const instanced = (boxes, mat, n, name) => {
    const geo = boxesGeometry(boxes);
    geos.push(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /** @type {Record<string, Record<'base'|'hurt', { body: THREE.InstancedMesh, alt: THREE.InstancedMesh|null, legs: THREE.InstancedMesh }>>} */
  const sets = {};
  for (const kind of ANIMAL_KINDS) {
    const m = /** @type {*} */ (MODELS)[kind];
    const legBoxes = [
      [m.legW, m.legH - 0.08, m.legW, 0, -(m.legH - 0.08) / 2, 0, m.leg[0]],
      [m.legW + 0.02, 0.08, m.legW + 0.02, 0, -m.legH + 0.04, 0, m.leg[1]],
    ];
    sets[kind] = /** @type {*} */ ({});
    for (const state of /** @type {const} */ (['base', 'hurt'])) {
      const suffix = state === 'base' ? '' : '-hurt';
      sets[kind][state] = {
        body: instanced(m.body, mats[state], capacity, `${kind}-body${suffix}`),
        alt: m.alt ? instanced(m.alt, mats[state], capacity, `${kind}-alt${suffix}`) : null,
        legs: instanced(legBoxes, mats[state], capacity * 4, `${kind}-legs${suffix}`),
      };
    }
  }
  scene.add(group);

  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  /** @param {ReadonlyArray<Animal>} animals */
  function sync(animals) {
    for (const kind of ANIMAL_KINDS) {
      for (const state of /** @type {const} */ (['base', 'hurt'])) {
        const s = sets[kind][state];
        s.body.count = 0;
        if (s.alt) s.alt.count = 0;
        s.legs.count = 0;
      }
    }
    let n = 0;
    for (const a of animals) {
      const kindSets = sets[a.kind];
      if (!kindSets) continue;
      const set = kindSets[a.hurt > 0 ? 'hurt' : 'base'];
      const m = /** @type {*} */ (MODELS)[a.kind];
      const which = bodyVariant(a) === 'alt' && set.alt ? set.alt : set.body;
      if (which.count >= capacity) continue;
      const phase = a.walkPhase || 0;
      const sw = Math.sin(phase);
      // a little bob with the stride; a snared animal strains from side to side
      const bob = Math.abs(sw) * 0.025;
      bodyM.compose(at.set(a.x, a.y + bob, a.z), q.setFromAxisAngle(UP, a.yaw), scl);
      which.setMatrixAt(which.count++, bodyM);
      bodyM.compose(at.set(a.x, a.y, a.z), q, scl);
      for (let k = 0; k < 4; k++) {
        const sx = k % 2 === 0 ? -1 : 1;
        const front = k < 2;
        const diag = (front ? 1 : -1) * sx; // diagonal pairs swing together
        partM.multiplyMatrices(bodyM, tmp.makeTranslation(sx * m.legX, m.legH, front ? m.legZ[0] : m.legZ[1]))
          .multiply(rot.makeRotationX(diag * sw * m.swing));
        set.legs.setMatrixAt(set.legs.count++, partM);
      }
      n++;
    }
    for (const kind of ANIMAL_KINDS) {
      for (const state of /** @type {const} */ (['base', 'hurt'])) {
        const s = sets[kind][state];
        for (const mesh of [s.body, s.alt, s.legs]) {
          if (!mesh) continue;
          mesh.visible = mesh.count > 0;
          if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of group.children) /** @type {THREE.InstancedMesh} */ (mesh).dispose();
    for (const g of geos) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    drawn = 0;
  }

  return { sync, count: () => drawn, dispose, group };
}
