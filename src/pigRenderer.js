// Caelancraft — pig models (three). See src/CONTRACTS.md §30.
//
// A pig is a small Group built facing −Z with its origin at the feet, so `rotation.y = pig.yaw` matches
// yawToForward (the camera uses the same convention). The body is a hexagonal prism lying along the pig — the
// honeycomb motif of the world — with a box head, snout, ears, eyes, a tail and four legs that swing with
// `pig.walkPhase`. Geometries are shared; each pig owns its skin material so a hit can flash it red.
import * as THREE from 'three';

/** @typedef {import('./pigs.js').Pig} Pig */

const PINK = 0xf2a7b5;
const SNOUT = 0xe0808f;
const DARK = 0x3a1f26;
const WHITE = 0xffffff;
const HURT = 0xff2a2a;

const LEG_H = 0.3;
const BODY_R = 0.32;
const BODY_LEN = 0.82;
const BODY_Y = LEG_H + BODY_R * Math.cos(Math.PI / 6); // flat underside resting on the legs
const LEG_SWING = 0.6;

/**
 * @typedef {Object} PigRenderer
 * @property {(pigs: Pig[]) => void} sync   add / move / animate / remove models to match the list
 * @property {() => number} count
 * @property {() => void} dispose
 */

/**
 * @param {THREE.Scene} scene
 * @returns {PigRenderer}
 */
export function createPigRenderer(scene) {
  // Hex prism lying along Z with a flat face down: CylinderGeometry's axis is Y; rotate it onto Z, then turn it
  // about Z by 30° so a side (not an edge) faces the ground.
  const bodyGeo = new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_LEN, 6);
  bodyGeo.rotateX(Math.PI / 2);
  bodyGeo.rotateZ(Math.PI / 6);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const geos = {
    body: bodyGeo,
    head: box(0.42, 0.4, 0.36),
    snout: box(0.22, 0.15, 0.08),
    nostril: box(0.04, 0.05, 0.02),
    eye: box(0.07, 0.07, 0.02),
    pupil: box(0.035, 0.05, 0.02),
    ear: box(0.12, 0.12, 0.04),
    leg: box(0.13, LEG_H, 0.13),
    tail: box(0.06, 0.06, 0.14),
  };
  // Leg geometry pivots at its top so rotation.x swings it like a hip.
  geos.leg.translate(0, -LEG_H / 2, 0);
  const shared = {
    snout: new THREE.MeshLambertMaterial({ color: SNOUT }),
    dark: new THREE.MeshLambertMaterial({ color: DARK }),
    white: new THREE.MeshLambertMaterial({ color: WHITE }),
  };

  /** @type {Map<number, { group: THREE.Group, skin: THREE.MeshLambertMaterial, legs: THREE.Mesh[] }>} */
  const models = new Map();

  function build() {
    const skin = new THREE.MeshLambertMaterial({ color: PINK, emissive: 0x000000 });
    const group = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    add(geos.body, skin, 0, BODY_Y, 0.05);
    const headZ = -BODY_LEN / 2 - 0.1;
    const headY = BODY_Y + 0.12;
    add(geos.head, skin, 0, headY, headZ);
    const front = headZ - 0.18;
    add(geos.snout, shared.snout, 0, headY - 0.06, front - 0.04);
    add(geos.nostril, shared.dark, -0.05, headY - 0.06, front - 0.085);
    add(geos.nostril, shared.dark, 0.05, headY - 0.06, front - 0.085);
    for (const s of [-1, 1]) {
      add(geos.eye, shared.white, s * 0.12, headY + 0.07, front - 0.005);
      add(geos.pupil, shared.dark, s * 0.135, headY + 0.065, front - 0.015);
      const ear = add(geos.ear, skin, s * 0.15, headY + 0.24, headZ + 0.05);
      ear.rotation.z = s * 0.35;
    }
    add(geos.tail, skin, 0, BODY_Y + 0.12, BODY_LEN / 2 + 0.1).rotation.x = -0.6;
    /** @type {THREE.Mesh[]} */
    const legs = [];
    for (const [lx, lz] of [[-0.16, -0.26], [0.16, -0.26], [-0.16, 0.32], [0.16, 0.32]]) {
      legs.push(add(geos.leg, skin, lx, LEG_H, lz));
    }
    scene.add(group);
    return { group, skin, legs };
  }

  /** @param {Pig[]} pigs */
  function sync(pigs) {
    const alive = new Set();
    for (const pig of pigs) {
      alive.add(pig.id);
      let m = models.get(pig.id);
      if (!m) {
        m = build();
        models.set(pig.id, m);
      }
      m.group.position.set(pig.x, pig.y, pig.z);
      m.group.rotation.y = pig.yaw;
      const swing = Math.sin(pig.walkPhase) * LEG_SWING;
      // Diagonal pairs move together: front-left with back-right.
      m.legs[0].rotation.x = swing;
      m.legs[3].rotation.x = swing;
      m.legs[1].rotation.x = -swing;
      m.legs[2].rotation.x = -swing;
      m.skin.emissive.setHex(pig.hurt > 0 ? HURT : 0x000000);
      m.skin.emissiveIntensity = pig.hurt > 0 ? 0.6 : 0;
    }
    for (const [id, m] of models) {
      if (alive.has(id)) continue;
      scene.remove(m.group);
      m.skin.dispose();
      models.delete(id);
    }
  }

  function dispose() {
    for (const m of models.values()) {
      scene.remove(m.group);
      m.skin.dispose();
    }
    models.clear();
    for (const g of Object.values(geos)) g.dispose();
    for (const mat of Object.values(shared)) mat.dispose();
  }

  return { sync, count: () => models.size, dispose };
}
