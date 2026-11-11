// Caelancraft — zombie models (three). See src/CONTRACTS.md §39 and §61.
//
// A shambler built from chunky boxes coloured per vertex (like the pigs; no atlas, no hexagons): two legs in ragged
// trousers and shoes, a hunched torso in a torn shirt with a belt and a hole showing skin, two arms held out low in front,
// and a head with a calm, weary face — two level, half-lidded eyes, plain brows, a small closed mouth — under a cap of
// dark hair. v0.11 (CONTRACTS §71): it is meant to read as a tired sleepwalker, neither a goofy cartoon (no googly eyes,
// no gappy grin) nor something to frighten a young player (no teeth, no red eyes: the alpha's glow is a warm amber).
// The model faces −Z with its origin at the feet, so a rotation of `zombie.yaw` about +Y matches yawToForward.
//
// The three kinds (zombies.js `kind`) share the meshes and differ by an instance tint, a scale and a gait:
//   walker — limps (one leg strides short), sways side to side, arms out front bobbing;
//   runner — leaner and paler, leans far forward, legs and arms pumping;
//   alpha  — bigger (ALPHA_SCALE) and darker, hunched, with warm amber eyes (their own small unlit mesh).
// Every zombie shares the InstancedMeshes (legs ×2, arms ×2, torso, head), so any number of them costs 4 draw calls
// (5 with an alpha about); their twins with a red emissive (`hurt > 0`) or an ember glow (smouldering in daylight) only
// draw while one flashes or burns. The legs swing from the hip with `walkPhase`, the torso leans into a chase and lurches
// after an attack (`swing`, the arms swiping up), and the head lolls by its own `tilt`. A zombie's optional `renderScale`
// (default 1) and `renderSpin` (default 0, extra yaw) draw a black hole's shrinking, spinning ghost (infall.js).
import * as THREE from 'three';
import { ZOMBIE_MAX } from './config.js';
import { SWING_S, kindOf, isDormant, ALPHA_SCALE } from './zombies.js';
import { compileHidden } from './prewarm.js';

export { ALPHA_SCALE };

/** @typedef {import('./zombies.js').Zombie} Zombie */

/** Part sizes (m). The hips are at LEG_H, the shoulders near the torso's top, the neck on it, the head on the neck. */
export const LEG_H = 0.66;
export const LEG_X = 0.12;
export const TORSO_W = 0.5;
export const TORSO_H = 0.6;
export const TORSO_D = 0.28;
export const NECK_H = 0.06;
export const HEAD_W = 0.46;
export const HEAD_H = 0.44;
export const HEAD_D = 0.42;
export const ARM_L = 0.58;
export const SHOULDER_X = 0.32;
export const SHOULDER_Y = TORSO_H - 0.07;
/** The walker's height to the top of its hair (≤ ZOMBIE_HEIGHT 1.9). */
export const MODEL_HEIGHT = LEG_H + TORSO_H + NECK_H + HEAD_H + 0.06;
/** The runner is drawn this much narrower (the alpha ALPHA_SCALE bigger: zombies.js, shared with its ray target). */
export const RUNNER_WIDTH = 0.88;

/** Colours (sRGB). */
export const SKIN = 0x93a88a;
const SKIN_DARK = 0x71866a;
const SHIRT = 0x6d8f86;
const SHIRT_DARK = 0x4e6b64;
const BELT = 0x3a2e24;
const TROUSERS = 0x4d4458;
const TROUSERS_DARK = 0x3a3344;
const SHOE = 0x2b211c;
const EYE = 0xe9e6d2;
const PUPIL = 0x2a2a30;
const MOUTH = 0x4a3a3a;
const HAIR = 0x35302c;
/** Instance tints by kind (multiplied into the vertex colours). */
export const KIND_TINT = Object.freeze({ walker: 0xffffff, runner: 0xfff0d6, alpha: 0xa2928a });
/** The alpha's eyes. */
export const ALPHA_EYES = 0xffb648;

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.85;
const EMBER = 0xff6a1a;
const EMBER_INTENSITY = 0.55;
const SOOT = 0x8a7c72;
/** A faint glow of their own so they read on a moonlit night (lost in daylight). */
export const NIGHT_GLOW = 0x1c2418;
const LURCH = -0.32;

/**
 * @typedef {Object} ZombieRenderer
 * @property {(zombies: Zombie[]) => void} sync   draw the given zombies (position, yaw, kind, animation, hurt / burn glow)
 * @property {() => number} count                 zombies drawn by the last sync
 * @property {() => void} dispose
 * @property {THREE.Group} group                  the instanced meshes (for tests and diagnostics)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile its programs now (prewarm.compileHidden)
 */

/** A body's model scale: its `renderScale` when a positive number, else 1 (pigRenderer's rule). */
function renderScaleOf(body) {
  const s = body.renderScale;
  return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
}

/** A body's extra yaw: its `renderSpin` when a finite number, else 0. */
function renderSpinOf(body) {
  const s = body.renderSpin;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * Boxes merged into one non-indexed-free geometry with a colour per vertex. Each box: [w, h, d, x, y, z, colour, rotZ?]
 * (centre x y z; rotZ turns it about its own centre).
 * @param {ReadonlyArray<ReadonlyArray<number>>} boxes
 * @returns {THREE.BufferGeometry}
 */
export function boxesGeometry(boxes) {
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const nor = [];
  /** @type {number[]} */
  const col = [];
  /** @type {number[]} */
  const idx = [];
  const c = new THREE.Color();
  const m = new THREE.Matrix4();
  const r = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const [w, h, d, x, y, z, hex, rotZ = 0] of boxes) {
    const g = new THREE.BoxGeometry(w, h, d);
    m.makeTranslation(x, y, z).multiply(r.makeRotationZ(rotZ));
    const p = g.getAttribute('position');
    const q = g.getAttribute('normal');
    c.setHex(hex, THREE.SRGBColorSpace);
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      n.fromBufferAttribute(q, i).transformDirection(m);
      pos.push(v.x, v.y, v.z);
      nor.push(n.x, n.y, n.z);
      col.push(c.r, c.g, c.b);
    }
    const gi = /** @type {THREE.BufferAttribute} */ (g.getIndex());
    for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i));
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** The face is on the head's −Z side: this z sits just in front of it. */
const FACE_Z = -HEAD_D / 2 - 0.012;

/** The part geometries (local frames: a leg hangs from its hip, an arm from its shoulder, the torso stands on the hips,
 * the head on the neck). */
export function zombieGeometries() {
  const leg = boxesGeometry([
    [0.17, LEG_H - 0.12, 0.19, 0, -(LEG_H - 0.12) / 2, 0, TROUSERS],
    [0.175, 0.07, 0.195, 0, -(LEG_H - 0.16), 0, TROUSERS_DARK], // the ragged hem
    [0.13, 0.05, 0.15, 0, -(LEG_H - 0.145), 0, SKIN_DARK], // a bare ankle
    [0.18, 0.12, 0.27, 0, -LEG_H + 0.06, -0.04, SHOE],
  ]);
  const torso = boxesGeometry([
    [TORSO_W, TORSO_H, TORSO_D, 0, TORSO_H / 2, 0, SHIRT],
    [TORSO_W + 0.01, 0.07, TORSO_D + 0.01, 0, 0.05, 0, BELT],
    [TORSO_W * 0.62, 0.08, TORSO_D + 0.02, 0, TORSO_H - 0.03, 0, SHIRT_DARK], // the collar
    [0.13, 0.1, 0.02, 0.1, 0.3, -TORSO_D / 2 - 0.005, SKIN_DARK], // a hole in the shirt
    [0.08, 0.14, 0.02, -0.14, 0.16, -TORSO_D / 2 - 0.005, SHIRT_DARK], // a torn flap
    [0.14, NECK_H + 0.02, 0.13, 0, TORSO_H + NECK_H / 2, 0, SKIN_DARK],
  ]);
  const arm = boxesGeometry([
    [0.14, 0.27, 0.15, 0, -0.135, 0, SHIRT], // the sleeve
    [0.12, ARM_L - 0.27, 0.13, 0, -0.27 - (ARM_L - 0.27) / 2, 0, SKIN],
    [0.15, 0.13, 0.15, 0, -ARM_L - 0.04, 0, SKIN_DARK], // the hand
  ]);
  const head = boxesGeometry([
    [HEAD_W, HEAD_H, HEAD_D, 0, HEAD_H / 2, 0, SKIN],
    [0.05, 0.1, 0.1, -HEAD_W / 2 - 0.02, 0.22, 0.02, SKIN_DARK], // ears
    [0.05, 0.1, 0.1, HEAD_W / 2 + 0.02, 0.22, 0.02, SKIN_DARK],
    // two level eyes, half closed: a pale eye, a small pupil low in it, and a heavy lid over its top
    [0.12, 0.09, 0.02, -0.105, 0.255, FACE_Z, EYE],
    [0.12, 0.09, 0.02, 0.105, 0.255, FACE_Z, EYE],
    [0.045, 0.045, 0.02, -0.105, 0.24, FACE_Z - 0.008, PUPIL],
    [0.045, 0.045, 0.02, 0.105, 0.24, FACE_Z - 0.008, PUPIL],
    [0.13, 0.04, 0.03, -0.105, 0.295, FACE_Z - 0.004, SKIN_DARK],
    [0.13, 0.04, 0.03, 0.105, 0.295, FACE_Z - 0.004, SKIN_DARK],
    // plain brows, a small nose, a short closed mouth
    [0.13, 0.025, 0.03, -0.105, 0.34, FACE_Z, HAIR],
    [0.13, 0.025, 0.03, 0.105, 0.34, FACE_Z, HAIR],
    [0.05, 0.07, 0.04, 0, 0.185, FACE_Z - 0.008, SKIN_DARK],
    [0.14, 0.028, 0.02, 0, 0.095, FACE_Z, MOUTH],
    // a cap of hair
    [HEAD_W + 0.02, 0.07, HEAD_D + 0.02, 0, HEAD_H + 0.02, 0.01, HAIR],
    [HEAD_W + 0.02, 0.14, 0.08, 0, HEAD_H - 0.06, HEAD_D / 2 - 0.02, HAIR],
  ]);
  // The alpha's glow: two small warm lights over its eyes (drawn on top of the head's own eyes).
  const eyes = boxesGeometry([
    [0.1, 0.06, 0.02, -0.105, 0.25, FACE_Z - 0.016, 0xffffff],
    [0.1, 0.06, 0.02, 0.105, 0.25, FACE_Z - 0.016, 0xffffff],
  ]);
  return { leg, torso, arm, head, eyes };
}

/**
 * @param {THREE.Scene} scene
 * @param {*} [_atlasTexture]  unused (the model is coloured per vertex); kept so main's call stays as it was
 * @param {number} [capacity=ZOMBIE_MAX]     most zombies drawn (main: ZOMBIE_MAX + MAX_INFALL_MOBS, for ghosts)
 * @returns {ZombieRenderer}
 */
export function createZombieRenderer(scene, _atlasTexture, capacity = ZOMBIE_MAX) {
  const geos = zombieGeometries();
  const mats = {
    base: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: NIGHT_GLOW }),
    hurt: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: HURT, emissiveIntensity: HURT_INTENSITY }),
    burn: new THREE.MeshLambertMaterial({ color: SOOT, vertexColors: true, emissive: EMBER, emissiveIntensity: EMBER_INTENSITY }),
    eyes: new THREE.MeshBasicMaterial({ color: ALPHA_EYES }),
  };
  const group = new THREE.Group();
  group.name = 'zombies';
  const tint = new THREE.Color();
  const instanced = (geo, mat, n, name, tinted = true) => {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tinted) mesh.setColorAt(0, tint.set(0xffffff)); // allocates instanceColor
    mesh.frustumCulled = false; // instances move every frame
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /** @type {Record<'base'|'hurt'|'burn', { legs: THREE.InstancedMesh, arms: THREE.InstancedMesh, torso: THREE.InstancedMesh, head: THREE.InstancedMesh }>} */
  const sets = /** @type {*} */ ({});
  for (const kind of /** @type {const} */ (['base', 'hurt', 'burn'])) {
    const suffix = kind === 'base' ? '' : `-${kind}`;
    sets[kind] = {
      legs: instanced(geos.leg, mats[kind], capacity * 2, `zombie-legs${suffix}`),
      arms: instanced(geos.arm, mats[kind], capacity * 2, `zombie-arms${suffix}`),
      torso: instanced(geos.torso, mats[kind], capacity, `zombie-torso${suffix}`),
      head: instanced(geos.head, mats[kind], capacity, `zombie-head${suffix}`),
    };
  }
  const eyesMesh = instanced(geos.eyes, mats.eyes, capacity, 'zombie-alpha-eyes', false);
  scene.add(group);

  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const torsoM = new THREE.Matrix4();
  const headM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const counts = { base: 0, hurt: 0, burn: 0 };
  let eyeCount = 0;
  let drawn = 0;

  /** @param {Zombie[]} zombies */
  function sync(zombies) {
    const n = Math.min(zombies.length, capacity);
    counts.base = 0;
    counts.hurt = 0;
    counts.burn = 0;
    eyeCount = 0;
    for (let i = 0; i < n; i++) {
      const zb = zombies[i];
      const state = zb.hurt > 0 ? 'hurt' : zb.smoking ? 'burn' : 'base';
      const set = sets[state];
      const slot = counts[state]++;
      const kind = kindOf(zb);
      const run = kind === 'runner';
      const alpha = kind === 'alpha';
      const s = renderScaleOf(zb) * (alpha ? ALPHA_SCALE : 1);
      const sx = run ? s * RUNNER_WIDTH : s;
      bodyM.compose(at.set(zb.x, zb.y, zb.z), q.setFromAxisAngle(UP, zb.yaw + renderSpinOf(zb)), scl.set(sx, s, sx));
      tint.set(KIND_TINT[kind]);
      const phase = zb.walkPhase || 0;
      const sw = Math.sin(phase);
      const swingK = zb.swing > 0 ? zb.swing / SWING_S : 0;
      const attack = Math.sin(Math.PI * swingK);
      const chase = zb.mode === 'chase';
      const dormant = isDormant(zb); // a walker asleep on its feet by day (§65): arms hanging, head drooped
      // Legs from the hips: a walker limps (its right leg strides short), a runner pumps them.
      const legAmp = run ? 0.95 : alpha ? 0.55 : 0.5;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const amp = kind === 'walker' && side > 0 ? legAmp * 0.55 : legAmp;
        partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * LEG_X, LEG_H, 0)).multiply(rot.makeRotationX(-side * sw * amp));
        set.legs.setMatrixAt(slot * 2 + k, partM);
        set.legs.setColorAt(slot * 2 + k, tint);
      }
      // Torso on the hips: hunched forward (more in a chase, most for a runner), swaying, lurching after a strike.
      const lean = (run ? -0.42 : alpha ? -0.3 : chase ? -0.17 : -0.08) + LURCH * attack;
      const sway = sw * (kind === 'walker' ? 0.045 : 0.03);
      torsoM.multiplyMatrices(bodyM, tmp.makeTranslation(0, LEG_H, 0))
        .multiply(rot.makeRotationX(lean))
        .multiply(tmp.makeRotationZ(sway));
      set.torso.setMatrixAt(slot, torsoM);
      set.torso.setColorAt(slot, tint);
      // Arms from the shoulders: out in front (a walker's and an alpha's bob in turn), a runner's pump; a strike swipes up.
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const reach = run
          ? 0.45 + side * sw * 0.9
          : dormant ? 0.12 - lean * 0.6 : 1.15 + 0.06 * Math.sin(phase + side * 1.4) - lean * 0.6;
        partM.multiplyMatrices(torsoM, tmp.makeTranslation(side * SHOULDER_X, SHOULDER_Y, 0))
          .multiply(rot.makeRotationX(reach + 0.55 * attack))
          .multiply(tmp.makeRotationZ(side * (run ? 0.12 : 0.06)));
        set.arms.setMatrixAt(slot * 2 + k, partM);
        set.arms.setColorAt(slot * 2 + k, tint);
      }
      // Head on the neck, lolling to its own side and nodding with the stride; a runner's looks up ahead.
      headM.multiplyMatrices(torsoM, tmp.makeTranslation(0, TORSO_H + NECK_H, 0))
        .multiply(rot.makeRotationZ((zb.tilt || 0) + Math.sin(phase * 0.5) * 0.05))
        .multiply(tmp.makeRotationX(Math.cos(phase) * 0.06 - lean * (run ? 0.8 : 0.5) - (dormant ? 0.45 : 0)));
      set.head.setMatrixAt(slot, headM);
      set.head.setColorAt(slot, tint);
      if (alpha && eyeCount < capacity) eyesMesh.setMatrixAt(eyeCount++, headM);
    }
    const setCount = (mesh, count) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    };
    for (const state of /** @type {const} */ (['base', 'hurt', 'burn'])) {
      setCount(sets[state].legs, counts[state] * 2);
      setCount(sets[state].arms, counts[state] * 2);
      setCount(sets[state].torso, counts[state]);
      setCount(sets[state].head, counts[state]);
    }
    setCount(eyesMesh, eyeCount);
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const set of Object.values(sets)) for (const mesh of Object.values(set)) mesh.dispose();
    eyesMesh.dispose();
    for (const g of Object.values(geos)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    drawn = 0;
  }

  /** Compile every zombie program while the game loads, so the first zombie of a session does not freeze it (P2). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
