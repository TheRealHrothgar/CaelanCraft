// Caelancraft — animal models (three): cattle, sheep, horses and wolves (CONTRACTS §69), the game of the harder land
// (v0.14, §76 fauna): deer, rabbits, pheasants, wild turkeys, bears and fish; drawn HEX-FACETED (§69.1, phase 3 of
// docs/DESIGN-characters.md).
//
// The models are animalModels.js's: per kind a trunk, a head group, one leg, a bird's wing, a tame one's tag, all over
// ONE shared painted atlas (faunaAssets: one texture, built once a page, shared with pigRenderer.js), lit like the
// avatars (the light volume and the warm fill, avatarRenderer.patchAvatarShader) with the old faint glow of their own so
// they read at night. All animals share InstancedMeshes: per kind each trunk and head part (and its red-flash twin for
// `hurt > 0`), the legs (one instance per leg, swinging from the hip with `walkPhase`, diagonal pairs together; a front
// leg is the hind one turned half round when the rig says `turn`), a bird's two wings (only in the air), a tame one's
// tag (a collar, a bell, a ribbon) and one mesh for every snared animal's loop of cord. The models face −Z with their
// origin at the feet, so a rotation of `animal.yaw` about +Y matches yawToForward. An animal's optional `renderScale` /
// `renderSpin` draw a black hole's shrinking, spinning ghost (infall.js), like the pigs' and the zombies'.
//
// v0.14 (§76 fauna). A rig may say: `legs` (2 for a bird, 0 for a fish; 4 when absent), `hop` (how high the stride bobs:
// a rabbit bounds), `wiggle` (a fish's body swings with its tail), `wing` (two wings drawn only in the air, beating with
// `walkPhase`; the legs are tucked back then), `rear` (the bear's rear-up: the body pitches up about its hips by
// `animal.rear`, the forelegs rise with it and swing when it swipes) and `head` (the head group turns at its pivot and
// stays `level` while the body rears: a rearing bear looks AT the player, not at the sky). §100: `lie` lays a stranded
// animal (`animal.stranded`: a fish whose water is gone) on its side.
//
// §88 (populations.js). Sex is shown where real animals show it: a variant's own trunk or head — the bull (heavier, a hump,
// wide horns, a ring in his nose), the ram (curled horns; shorn: `maleAlt`), the stag (antlers), the cock pheasant
// (copper, a green head, a long barred tail; the hen is drab), the tom turkey (a bare blue head, a wattle, his fan).
// Horses, wolves, rabbits, the bear and fish look alike. A young animal (`size` below 1) is drawn at its size on the
// female's parts (a fawn on its spotted coat), its head larger and its body rounder.
//
// §100 (stalking). The head shows what the animal is doing: grazing (or rooting, pecking, sniffing) with its head down
// while it stands idle, staring with its head UP while it watches a crouching player (`mode` 'watch'), level otherwise.
// It eases between them (HEAD_RATE).
import * as THREE from 'three';
import { ANIMAL_MAX, ANIMAL_KINDS, BEAR_SWIPE_S } from './animals.js';
import { compileHidden } from './prewarm.js';
import { animalModels, ANIMAL_RIGS } from './animalModels.js';
import { patchAvatarShader } from './avatarRenderer.js';

/** @typedef {import('./animals.js').Animal} Animal */
/** @typedef {import('./animalModels.js').AnimalRig} AnimalRig */
/** @typedef {import('./modelKit.js').Geo} Geo */

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.7;
/** A faint glow of their own so they read at night (like the zombies'). */
const NIGHT_GLOW = 0x1a1a1a;
/** The program key of every animal and pig material (one program: the atlas, the light volume, the warm fill). */
export const FAUNA_PROGRAM = 'caelancraft-fauna';
/** How fast a head eases to its pose (1/s). */
export const HEAD_RATE = 5;
/** A young one's head is this much larger at birth (YOUNG_SCALE), and its trunk this much rounder, easing out as it grows. */
export const YOUNG_HEAD = 0.3;
export const YOUNG_ROUND = Object.freeze([1.08, 1.06, 0.94]);
/** populations.YOUNG_SCALE: a newborn's size. */
const NEWBORN = 0.55;

/**
 * Per species, the rig of its model (animalModels.ANIMAL_RIGS): `legH` the hip height, `legW` the leg's width, `legX` /
 * `legZ` the hips (±x, front −z and back +z), `swing` the stride (rad), and the optional `legs`, `turn`, `hop`, `wiggle`,
 * `wing`, `rear`, `head` and `lie`.
 * @type {Readonly<Record<string, AnimalRig>>}
 */
export const MODELS = Object.freeze(Object.fromEntries(ANIMAL_KINDS.map((k) => [k, /** @type {AnimalRig} */ (/** @type {*} */ (ANIMAL_RIGS)[k])])));

// ---------------------------------------------------------------------------------------------------
// The shared GPU resources: the atlas texture and one BufferGeometry per part (both renderers, built once a page)
// ---------------------------------------------------------------------------------------------------

/** A kit geometry as a BufferGeometry. @param {Geo} g */
function bufferOf(g) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  out.setIndex(new THREE.BufferAttribute(g.index, 1));
  out.computeBoundingSphere();
  return out;
}

/** @typedef {{ models: import('./animalModels.js').FaunaModels, texture: THREE.DataTexture, buffer: (g: Geo) => THREE.BufferGeometry }} FaunaAssets */
/** @type {FaunaAssets|null} */
let shared = null;
/** @type {Map<Geo, THREE.BufferGeometry>} */
const buffers = new Map();

/** The animals' and the pig's shared atlas texture and geometries (built on first use). @returns {FaunaAssets} */
export function faunaAssets() {
  if (shared) return shared;
  const models = animalModels();
  const img = models.image;
  const texture = new THREE.DataTexture(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  /** @param {Geo} g */
  const buffer = (g) => {
    let b = buffers.get(g);
    if (!b) {
      b = bufferOf(g);
      buffers.set(g, b);
    }
    return b;
  };
  shared = { models, texture, buffer };
  return shared;
}

/** Free the shared resources (tests; a page never needs to). */
export function disposeFaunaAssets() {
  for (const b of buffers.values()) b.dispose();
  buffers.clear();
  if (shared) shared.texture.dispose();
  shared = null;
}

/**
 * A material over the shared atlas, lit like the avatars (the light volume, the warm fill).
 * @param {THREE.Texture} map @param {number} emissive @param {number} [intensity]
 */
export function faunaMaterial(map, emissive, intensity = 1) {
  const m = new THREE.MeshLambertMaterial({ map, emissive, emissiveIntensity: intensity });
  m.onBeforeCompile = (shader) => patchAvatarShader(/** @type {*} */ (shader));
  m.customProgramCacheKey = () => FAUNA_PROGRAM;
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} AnimalRenderer
 * @property {(animals: ReadonlyArray<Animal>, dt?: number) => void} sync   draw the given animals (`dt`: seconds since the
 *   last sync, for the heads' easing; measured when absent)
 * @property {() => number} count
 * @property {() => void} dispose
 * @property {THREE.Group} group
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm
 */

/**
 * Which body an animal is drawn with: its species' `alt` for a shorn sheep, a tame horse or a tame wolf; §88 `male` for a
 * grown male of a kind that has one (bull, ram, stag, cock pheasant, tom turkey), `maleAlt` for a shorn ram. A young one
 * (`size` below 1) is drawn on the female's body.
 * @returns {'body'|'alt'|'male'|'maleAlt'}
 */
export function bodyVariant(a) {
  const male = a.sex === 'm' && !(a.size < 1) && MALE_KINDS.has(a.kind);
  if (a.kind === 'sheep') return a.shorn > 0 ? (male ? 'maleAlt' : 'alt') : male ? 'male' : 'body';
  if (a.kind === 'horse' || a.kind === 'wolf') return a.tamed ? 'alt' : 'body';
  return male ? 'male' : 'body';
}
/** The kinds whose grown males have their own look. */
const MALE_KINDS = new Set(['cow', 'sheep', 'deer', 'pheasant', 'turkey']);

/** How many legs a model walks on (4 when it does not say). @param {*} m */
export function legCount(m) {
  return typeof m.legs === 'number' ? m.legs : 4;
}

/**
 * The pitch its head group is drawn at (rad; negative: down) for what it is doing: the rig's `alert` while it stares
 * (§100 'watch'), its `graze` while it stands idle on the ground (not ridden, not sitting, not snared, not in water or
 * the air), level otherwise.
 * @param {*} a @param {AnimalRig} rig
 */
export function headPitch(a, rig) {
  const h = rig.head;
  if (!h) return 0;
  if (a.mode === 'watch') return h.alert;
  const still = a.mode === 'idle' && !a.ridden && !a.sitting && !(a.trapped > 0) && !a.inWater && !(typeof a.air === 'number' && a.air !== 0);
  return still ? h.graze : 0;
}

/** How young an animal looks: 0 grown .. 1 newborn. */
export function youthOf(a) {
  const s = a.size;
  return typeof s === 'number' && s > 0 && s < 1 ? Math.min(1, (1 - s) / (1 - NEWBORN)) : 0;
}

/** How far back a flying bird tucks its legs (rad). */
const TUCK = 1.1;

/**
 * A per-animal head that eases (a WeakMap keyed by the animal: nothing is written on it).
 * @returns {(a: object, target: number, k: number) => number}
 */
function headEaser() {
  /** @type {WeakMap<object, number>} */
  const heads = new WeakMap();
  return (a, target, k) => {
    const was = heads.get(a);
    const now = was === undefined ? target : was + (target - was) * k;
    heads.set(a, now);
    return now;
  };
}
export { headEaser };

/**
 * @param {THREE.Scene} scene
 * @param {number} [capacity=ANIMAL_MAX]
 * @returns {AnimalRenderer}
 */
export function createAnimalRenderer(scene, capacity = ANIMAL_MAX) {
  const A = faunaAssets();
  const mats = {
    base: faunaMaterial(A.texture, NIGHT_GLOW),
    hurt: faunaMaterial(A.texture, HURT, HURT_INTENSITY),
  };
  const group = new THREE.Group();
  group.name = 'animals';
  /** @param {Geo} geo @param {THREE.Material} mat @param {number} n @param {string} name */
  const instanced = (geo, mat, n, name) => {
    const mesh = new THREE.InstancedMesh(A.buffer(geo), mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /** @typedef {{ base: THREE.InstancedMesh, hurt: THREE.InstancedMesh|null }} Pair */
  /**
   * @type {Record<string, { parts: Record<string, Pair>, variants: Record<string, Array<string|null>>, trunkY: number,
   *   wings: Pair|null, tag: THREE.InstancedMesh|null }>}
   */
  const sets = {};
  for (const kind of ANIMAL_KINDS) {
    const K = A.models.kinds[kind];
    const rig = MODELS[kind];
    const nLegs = legCount(rig);
    /** @type {Record<string, Pair>} */
    const parts = {};
    for (const [name, geo] of Object.entries(K.parts)) {
      if (name === 'tag' || name === 'wings') continue;
      const n = name.startsWith('legs') ? capacity * nLegs : capacity;
      if (n === 0) continue;
      parts[name] = { base: instanced(geo, mats.base, n, `${kind}-${name}`), hurt: instanced(geo, mats.hurt, n, `${kind}-${name}-hurt`) };
    }
    const wings = K.parts.wings
      ? { base: instanced(K.parts.wings, mats.base, capacity * 2, `${kind}-wings`), hurt: instanced(K.parts.wings, mats.hurt, capacity * 2, `${kind}-wings-hurt`) }
      : null;
    const tag = K.parts.tag ? instanced(K.parts.tag, mats.base, capacity, `${kind}-tag`) : null;
    const pos = K.parts.body.positions;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      lo = Math.min(lo, pos[i]);
      hi = Math.max(hi, pos[i]);
    }
    sets[kind] = { parts, variants: K.variants, trunkY: (lo + hi) / 2, wings, tag };
  }
  const snare = instanced(A.models.snare, mats.base, capacity, 'animal-snare');
  const meshes = /** @type {THREE.InstancedMesh[]} */ (group.children);
  scene.add(group);

  const feetM = new THREE.Matrix4();
  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const turn = new THREE.Matrix4().makeRotationY(Math.PI);
  const loopM = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const ease = headEaser();
  let drawn = 0;
  let lastT = -1;

  /** @param {ReadonlyArray<Animal>} animals @param {number} [dt] */
  function sync(animals, dt) {
    let step = dt;
    if (typeof step !== 'number' || !Number.isFinite(step)) {
      const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
      step = lastT < 0 ? 1 : Math.min(0.25, Math.max(0, now - lastT));
      lastT = now;
    }
    const k = 1 - Math.exp(-HEAD_RATE * Math.max(0, step));
    for (const m of meshes) m.count = 0;
    let n = 0;
    for (const a of animals) {
      const S = sets[a.kind];
      if (!S) continue;
      const state = a.hurt > 0 ? 'hurt' : 'base';
      const rig = MODELS[a.kind];
      const youth = youthOf(a);
      const variant = youth > 0 && S.variants.young ? 'young' : bodyVariant(a);
      const [trunkP, headP, legsP = 'legs'] = S.variants[variant] ?? S.variants.body;
      const trunk = S.parts[/** @type {string} */ (trunkP)]?.[state];
      if (!trunk || trunk.count >= capacity) continue;
      const phase = a.walkPhase || 0;
      const sw = Math.sin(phase);
      // v0.14: in the air (a flushed bird) the wings beat with `walkPhase` and there is no stride
      const flying = typeof a.air === 'number' && a.air !== 0;
      // a little bob with the stride (a rabbit bounds)
      const bob = flying ? 0 : Math.abs(sw) * (rig.hop ?? 0.025);
      // `renderScale` / `renderSpin` (infall.js): a black hole's shrinking, spinning ghost, as for pigs and zombies.
      const ghost = /** @type {{ renderScale?: number, renderSpin?: number }} */ (a);
      // §88: a young one is drawn at its size (about the feet, like the ghost's scale)
      const young = typeof a.size === 'number' && a.size > 0 && a.size < 1 ? a.size : 1;
      const rs = (typeof ghost.renderScale === 'number' && ghost.renderScale > 0 && Number.isFinite(ghost.renderScale) ? ghost.renderScale : 1) * young;
      const spin = typeof ghost.renderSpin === 'number' && Number.isFinite(ghost.renderSpin) ? ghost.renderSpin : 0;
      scl.set(rs, rs, rs);
      const yaw = a.yaw + spin + (rig.wiggle ? sw * rig.wiggle : 0); // v0.14: a fish's body swings with its tail
      q.setFromAxisAngle(UP, yaw);
      bodyM.compose(at.set(a.x, a.y + bob * rs, a.z), q, scl);
      // v0.14: the bear's rear-up — the body pitches up about its hips, the more the further it has reared
      const rear = rig.rear && typeof a.rear === 'number' && a.rear > 0.001 ? Math.min(1, a.rear) : 0;
      if (rear > 0 && rig.rear) {
        bodyM.multiply(tmp.makeTranslation(0, rig.rear.y, rig.rear.z)).multiply(rot.makeRotationX(rear * rig.rear.angle))
          .multiply(tmp.makeTranslation(0, -rig.rear.y, -rig.rear.z));
      }
      // §100: a stranded fish lies on its side on the bed (it still flaps with its tail): rolled a quarter turn about its
      // length round its middle, which then sits `up` above the ground
      if (rig.lie && a.stranded) {
        bodyM.multiply(tmp.makeTranslation(0, rig.lie.up, 0)).multiply(rot.makeRotationZ(Math.PI / 2))
          .multiply(tmp.makeTranslation(0, -rig.lie.mid, 0));
      }
      if (youth > 0) {
        // rounder: the trunk a little fuller and shorter about its middle
        const [rx, ry, rz] = YOUNG_ROUND;
        partM.copy(bodyM).multiply(tmp.makeTranslation(0, S.trunkY, 0))
          .multiply(rot.makeScale(1 + (rx - 1) * youth, 1 + (ry - 1) * youth, 1 + (rz - 1) * youth)).multiply(tmp.makeTranslation(0, -S.trunkY, 0));
        trunk.setMatrixAt(trunk.count++, partM);
      } else {
        trunk.setMatrixAt(trunk.count++, bodyM);
      }
      // the head group turns at its pivot: down to graze, up to stare (§100), and takes back most of a rear's pitch
      const head = headP ? S.parts[headP]?.[state] : null;
      if (head && rig.head) {
        const h = rig.head;
        const pitch = ease(a, headPitch(a, rig), k);
        const hs = 1 + YOUNG_HEAD * youth;
        partM.copy(bodyM).multiply(tmp.makeTranslation(h.pivot[0], h.pivot[1], h.pivot[2]))
          .multiply(rot.makeRotationX(pitch - (rear > 0 && rig.rear ? rear * rig.rear.angle * h.level : 0)));
        if (hs !== 1) partM.multiply(rot.makeScale(hs, hs, hs));
        partM.multiply(tmp.makeTranslation(-h.pivot[0], -h.pivot[1], -h.pivot[2]));
        head.setMatrixAt(head.count++, partM);
        // a tame one's collar, bell or ribbon rides on its neck
        if (a.tamed && S.tag) S.tag.setMatrixAt(S.tag.count++, partM);
      }
      feetM.compose(at.set(a.x, a.y, a.z), q, scl);
      const nLegs = legCount(rig);
      const legs = S.parts[legsP]?.[state] ?? S.parts.legs?.[state];
      if (legs && nLegs > 0) {
        for (let i = 0; i < nLegs; i++) {
          const sx = i % 2 === 0 ? -1 : 1;
          const front = nLegs === 2 ? true : i < 2;
          const diag = nLegs === 2 ? sx : (front ? 1 : -1) * sx; // diagonal pairs swing together; a bird's two alternate
          let angle = diag * sw * rig.swing;
          if (flying) angle = -TUCK;
          // a reared bear's forelegs hang from its raised shoulders, held forward, and swing down when it swipes
          let base = feetM;
          if (rear > 0 && front && rig.rear) {
            base = bodyM;
            const swipe = typeof a.swipe === 'number' && a.swipe > 0 ? a.swipe / BEAR_SWIPE_S : 0;
            angle = -rear * rig.rear.arms + swipe * rig.rear.swipe;
          }
          partM.multiplyMatrices(base, tmp.makeTranslation(sx * rig.legX, rig.legH, front ? rig.legZ[0] : rig.legZ[1]))
            .multiply(rot.makeRotationX(angle));
          if (front && rig.turn && nLegs === 4) partM.multiply(turn);
          legs.setMatrixAt(legs.count++, partM);
          // a snared animal: the cord's loop round its left hind ankle
          if (a.trapped > 0 && !front && sx < 0 && snare.count < capacity) {
            snare.setMatrixAt(snare.count++, tmp.copy(partM).multiply(rot.makeTranslation(0, -rig.legH + 0.06, 0)).multiply(loopM.makeScale(rig.legW, rig.legW, rig.legW)));
          }
        }
      }
      if (S.wings && flying && rig.wing) {
        const w = rig.wing;
        const wings = S.wings[state];
        const flap = Math.sin(phase) * w.flap;
        for (const side of [1, -1]) {
          // the left wing is the right one turned half round, so the same flap raises both tips
          partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * w.pivot[0], w.pivot[1], w.pivot[2]));
          if (side < 0) partM.multiply(turn);
          partM.multiply(rot.makeRotationZ(flap));
          wings.setMatrixAt(wings.count++, partM);
        }
      }
      n++;
    }
    for (const mesh of meshes) {
      mesh.visible = mesh.count > 0;
      if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of meshes) mesh.dispose();
    for (const m of Object.values(mats)) m.dispose();
    // the atlas and the geometries are shared (faunaAssets): they stay for the next renderer
    drawn = 0;
  }

  /** Compile every animal program while the game loads (prewarm.compileHidden). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
