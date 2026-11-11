// Caelancraft — zombie models (three). See src/CONTRACTS.md §39, §61 and §74.
//
// A zombie is a few plain boxes — two legs, a torso, two upper arms, two forearms, a head — wrapped in PIXEL ART painted
// by zombieSkin.js (pure): dead people under moonlight, spooky without being frightening. The head carries a second,
// slightly larger box for its hair and the alpha's torso one for its ragged coat (see-through where there is none), so
// the silhouettes are not bare cubes. The three kinds share the shapes and differ by their skins, a scale and a bearing:
//   walker — vacant. It limps and sways; its arms hang until it is after someone, then come up in front;
//   runner — wired. Leaner, bent far forward, elbows pumping, and its head JERKS (twitchOf);
//   alpha  — ominous. Bigger (ALPHA_SCALE), hunched, arms spread wide with the forearms up, its head held low and steady.
// The eyes are narrow slits that GLOW in the dark (the skin's glow sheet as the emissive map): a faint marsh green, pale
// pinpricks, a hot amber. Walkers and runners wear shirts tinted by SHIRT_TINTS, so a crowd is not one person repeated.
// The model faces −Z with its origin at the feet, so a rotation of `zombie.yaw` about +Y matches yawToForward.
//
// Each kind has its own five InstancedMeshes (legs, upper arms, forearms, torso, head) over ONE texture and material, so
// a crowd of one kind costs 5 draw calls. Their twins with a red emissive (`hurt > 0`) or an ember glow (smouldering)
// only draw while one flashes or burns. The legs swing from the hip with `walkPhase`, the torso leans into a chase and
// lurches after an attack (`swing`, the arms swiping up), and the head lolls by its own `tilt`. A zombie's optional
// `renderScale` (default 1) and `renderSpin` (default 0, extra yaw) draw a black hole's shrinking, spinning ghost.
import * as THREE from 'three';
import { ZOMBIE_MAX } from './config.js';
import { SWING_S, kindOf, isDormant, ALPHA_SCALE, ZOMBIE_KINDS } from './zombies.js';
import { compileHidden } from './prewarm.js';
import { paintZombieAtlas, PARTS, faceRect, SKIN_TEXEL, SKIN_H, SKIN_KINDS, ATLAS_W, ATLAS_H } from './zombieSkin.js';

export { ALPHA_SCALE };

/** @typedef {import('./zombies.js').Zombie} Zombie */

const T = SKIN_TEXEL;
/** Part sizes (m), from the skin's boxes. The hips are at LEG_H, the head stands on the torso. */
export const LEG_H = PARTS.leg.h * T;
export const LEG_X = 4 * T;
export const TORSO_W = PARTS.torso.w * T;
export const TORSO_H = PARTS.torso.h * T;
export const TORSO_D = PARTS.torso.d * T;
export const HEAD_W = PARTS.head.w * T;
export const HEAD_H = PARTS.head.h * T;
export const HEAD_D = PARTS.head.d * T;
/** The arm: shoulder to elbow, elbow to fingertips. */
export const UPPER_L = PARTS.upperArm.h * T;
export const FORE_L = PARTS.foreArm.h * T;
export const ARM_L = UPPER_L + FORE_L;
export const SHOULDER_X = ((PARTS.torso.w + PARTS.upperArm.w) / 2) * T;
export const SHOULDER_Y = TORSO_H - T;
/** How far the hair stands off the head and the coat off the torso. */
export const HAIR_PUFF = 0.5 * T;
export const COAT_PUFF = 0.7 * T;
/** The walker's height to the top of its hair (≤ ZOMBIE_HEIGHT 1.9). */
export const MODEL_HEIGHT = LEG_H + TORSO_H + HEAD_H + HAIR_PUFF;
/** The runner is drawn this much narrower (the alpha ALPHA_SCALE bigger: zombies.js, shared with its ray target). */
export const RUNNER_WIDTH = 0.9;

/**
 * Shirt colours: a walker's or a runner's torso and arms are tinted by SHIRT_TINTS[id mod its length] (kept pale, so the
 * hands barely change), so no two neighbours in a crowd need wear the same shirt. The alpha's stays as painted.
 */
export const SHIRT_TINTS = Object.freeze([0xffffff, 0xbccbe2, 0xe6bca8, 0xd0d8a6, 0xe8d79c, 0xd2bedb, 0xb6d2c6]);

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.85;
const EMBER = 0xff6a1a;
const EMBER_INTENSITY = 0.55;
const SOOT = 0x8a7c72;
const LURCH = -0.32;
/** How strongly the skin's glow sheet shines in full daylight (1 in the dark): by day the walker's slits are black. */
export const GLOW_DAY = 0.2;

/** A runner's head jerks TWITCH_HZ times a second, each jerk taking TWITCH_PART of that beat and reaching TWITCH_ANGLE. */
export const TWITCH_HZ = 1.7;
export const TWITCH_PART = 0.16;
export const TWITCH_ANGLE = 0.26;

/**
 * A runner's twitch at time `t` (seconds): 0 most of the time, a sharp jerk to one side and back TWITCH_HZ times a
 * second, to alternate sides; `id` shifts the beat so two runners never twitch together.
 * @param {number} t
 * @param {number} id
 * @returns {number} radians
 */
export function twitchOf(t, id) {
  const u = (Number.isFinite(t) ? t : 0) * TWITCH_HZ + (Number.isFinite(id) ? id : 0) * 0.37;
  const beat = Math.floor(u);
  const f = u - beat;
  if (f >= TWITCH_PART) return 0;
  return (beat % 2 === 0 ? 1 : -1) * TWITCH_ANGLE * Math.sin((f / TWITCH_PART) * Math.PI);
}

/**
 * How each kind holds its arms: `reach` is the upper arm's swing forward from hanging straight down, `bend` the elbow's
 * (both radians), `spread` how far the arms are held out to the sides.
 */
export const ARMS = Object.freeze({
  dormant: Object.freeze({ reach: 0.04, bend: 0.12, spread: 0.05 }),
  hang: Object.freeze({ reach: 0.16, bend: 0.3, spread: 0.06 }),
  chase: Object.freeze({ reach: 1.0, bend: 0.4, spread: 0.06 }),
  runner: Object.freeze({ reach: 0.25, bend: 1.25, spread: 0.12 }),
  alpha: Object.freeze({ reach: 0.6, bend: 0.95, spread: 0.36 }),
});
/** A walker with nobody to chase lets its head hang this far; a runner's is cocked this far to its own side. */
export const WALKER_DROOP = 0.14;
export const RUNNER_COCK = 0.16;

/**
 * @typedef {Object} ZombieRenderer
 * @property {(zombies: Zombie[], t?: number, dark?: number) => void} sync   draw the given zombies (position, yaw, kind,
 *                                                animation, hurt / burn glow); `t` (seconds, default 0) drives the runner's
 *                                                twitch, `dark` (0 full daylight .. 1 night, default 1) the eyes' glow
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

/** three's BoxGeometry faces, in its order (+x, −x, +y, −y, +z, −z), as the skin names them (the model faces −Z). */
const BOX_FACES = /** @type {const} */ (['right', 'left', 'top', 'bottom', 'back', 'front']);
/** UVs stop this far (texels) inside each face, so a neighbouring face's texels never bleed in at the edges. */
const UV_INSET = 0.02;

/**
 * One skinned box: `part`'s box (grown by `puff` on every side), centred at (x, y, z), its six faces mapped to that
 * part's unwrap on `kind`'s page of the skin.
 * @param {keyof typeof PARTS} partName
 * @param {'walker'|'runner'|'alpha'} kind
 * @param {{ puff?: number, x?: number, y?: number, z?: number }} [at]
 * @returns {THREE.BufferGeometry}
 */
export function skinBox(partName, kind, { puff = 0, x = 0, y = 0, z = 0 } = {}) {
  const part = PARTS[partName];
  const g = new THREE.BoxGeometry(part.w * T + 2 * puff, part.h * T + 2 * puff, part.d * T + 2 * puff);
  const uv = g.getAttribute('uv');
  const page = SKIN_KINDS.indexOf(kind) * SKIN_H;
  for (let face = 0; face < 6; face++) {
    const r = faceRect(part, BOX_FACES[face]);
    for (let i = face * 4; i < face * 4 + 4; i++) {
      const u = UV_INSET + uv.getX(i) * (r.w - 2 * UV_INSET);
      const v = UV_INSET + (1 - uv.getY(i)) * (r.h - 2 * UV_INSET);
      uv.setXY(i, (r.x + u) / ATLAS_W, (page + r.y + v) / ATLAS_H);
    }
  }
  g.translate(x, y, z);
  return g;
}

/** Several indexed geometries (position, normal, uv) as one; the inputs are disposed. */
function mergeGeos(list) {
  const pos = [];
  const nor = [];
  const uvs = [];
  const idx = [];
  for (const g of list) {
    const base = pos.length / 3;
    pos.push(...g.getAttribute('position').array);
    nor.push(...g.getAttribute('normal').array);
    uvs.push(...g.getAttribute('uv').array);
    for (const i of /** @type {THREE.BufferAttribute} */ (g.getIndex()).array) idx.push(base + i);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/**
 * A kind's part geometries (local frames: a leg hangs from its hip, an upper arm from its shoulder, a forearm from its
 * elbow, the torso stands on the hips, the head on the torso). The head carries its hair layer; the alpha's torso its coat.
 * @param {'walker'|'runner'|'alpha'} kind
 */
export function zombieGeometries(kind) {
  const torso = [skinBox('torso', kind, { y: TORSO_H / 2 })];
  if (kind === 'alpha') torso.push(skinBox('coat', kind, { puff: COAT_PUFF, y: TORSO_H / 2 }));
  return {
    leg: skinBox('leg', kind, { y: -LEG_H / 2 }),
    upperArm: skinBox('upperArm', kind, { y: -UPPER_L / 2 }),
    foreArm: skinBox('foreArm', kind, { y: -FORE_L / 2 }),
    torso: mergeGeos(torso),
    head: mergeGeos([skinBox('head', kind, { y: HEAD_H / 2 }), skinBox('hair', kind, { puff: HAIR_PUFF, y: HEAD_H / 2 })]),
  };
}

/** A sheet of the skin as a pixel-art texture (nearest filtering, no mipmaps, sRGB). */
function skinTexture(bytes) {
  const tex = new THREE.DataTexture(bytes, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {THREE.Scene} scene
 * @param {*} [_atlasTexture]  unused (the zombies have their own skin); kept so main's call stays as it was
 * @param {number} [capacity=ZOMBIE_MAX]     most zombies drawn (main: ZOMBIE_MAX + MAX_INFALL_MOBS, for ghosts)
 * @returns {ZombieRenderer}
 */
export function createZombieRenderer(scene, _atlasTexture, capacity = ZOMBIE_MAX) {
  const atlas = paintZombieAtlas();
  const map = skinTexture(atlas.data);
  const glow = skinTexture(atlas.glow);
  const mats = {
    base: new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, emissive: 0xffffff, emissiveMap: glow }),
    hurt: new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, emissive: HURT, emissiveIntensity: HURT_INTENSITY }),
    burn: new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, color: SOOT, emissive: EMBER, emissiveIntensity: EMBER_INTENSITY }),
  };
  const group = new THREE.Group();
  group.name = 'zombies';
  const white = new THREE.Color(0xffffff);
  const shirt = new THREE.Color();
  const instanced = (geo, mat, n, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, white); // allocates instanceColor
    mesh.frustumCulled = false; // instances move every frame
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /** @typedef {{ legs: THREE.InstancedMesh, upperArms: THREE.InstancedMesh, foreArms: THREE.InstancedMesh, torso: THREE.InstancedMesh, head: THREE.InstancedMesh, n: number }} PartSet */
  const STATES = /** @type {const} */ (['base', 'hurt', 'burn']);
  const geos = /** @type {Record<string, ReturnType<typeof zombieGeometries>>} */ ({});
  /** @type {Record<'base'|'hurt'|'burn', Record<string, PartSet>>} */
  const sets = /** @type {*} */ ({ base: {}, hurt: {}, burn: {} });
  for (const kind of ZOMBIE_KINDS) {
    const g = zombieGeometries(/** @type {'walker'|'runner'|'alpha'} */ (kind));
    geos[kind] = g;
    for (const state of STATES) {
      const suffix = state === 'base' ? '' : `-${state}`;
      sets[state][kind] = {
        legs: instanced(g.leg, mats[state], capacity * 2, `zombie-legs-${kind}${suffix}`),
        upperArms: instanced(g.upperArm, mats[state], capacity * 2, `zombie-upper-arms-${kind}${suffix}`),
        foreArms: instanced(g.foreArm, mats[state], capacity * 2, `zombie-forearms-${kind}${suffix}`),
        torso: instanced(g.torso, mats[state], capacity, `zombie-torso-${kind}${suffix}`),
        head: instanced(g.head, mats[state], capacity, `zombie-head-${kind}${suffix}`),
        n: 0,
      };
    }
  }
  scene.add(group);

  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const foreM = new THREE.Matrix4();
  const torsoM = new THREE.Matrix4();
  const headM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  /**
   * @param {Zombie[]} zombies
   * @param {number} [t=0]  seconds on any steady clock (the runner's twitch)
   * @param {number} [dark=1]  0 in full daylight .. 1 at night (how strongly the eyes glow)
   */
  function sync(zombies, t = 0, dark = 1) {
    const n = Math.min(zombies.length, capacity);
    mats.base.emissiveIntensity = GLOW_DAY + (1 - GLOW_DAY) * Math.min(1, Math.max(0, Number.isFinite(dark) ? dark : 1));
    for (const state of STATES) for (const kind of ZOMBIE_KINDS) sets[state][kind].n = 0;
    for (let i = 0; i < n; i++) {
      const zb = zombies[i];
      const state = zb.hurt > 0 ? 'hurt' : zb.smoking ? 'burn' : 'base';
      const kind = kindOf(zb);
      const set = sets[state][kind];
      const slot = set.n++;
      const run = kind === 'runner';
      const alpha = kind === 'alpha';
      const s = renderScaleOf(zb) * (alpha ? ALPHA_SCALE : 1);
      const sx = run ? s * RUNNER_WIDTH : s;
      bodyM.compose(at.set(zb.x, zb.y, zb.z), q.setFromAxisAngle(UP, zb.yaw + renderSpinOf(zb)), scl.set(sx, s, sx));
      // its shirt's own faded colour (the alpha's is as painted)
      shirt.set(alpha ? 0xffffff : SHIRT_TINTS[Math.abs(Math.floor(zb.id || 0)) % SHIRT_TINTS.length]);
      const phase = zb.walkPhase || 0;
      const sw = Math.sin(phase);
      const swingK = zb.swing > 0 ? zb.swing / SWING_S : 0;
      const attack = Math.sin(Math.PI * swingK);
      const chase = zb.mode === 'chase';
      const dormant = isDormant(zb); // a walker asleep on its feet by day (§65): arms hanging, head drooped
      const twitch = run ? twitchOf(t, zb.id) : 0;
      // Legs from the hips: a walker limps (its right leg strides short), a runner pumps them.
      const legAmp = run ? 0.95 : alpha ? 0.55 : 0.5;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const amp = kind === 'walker' && side > 0 ? legAmp * 0.55 : legAmp;
        partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * LEG_X, LEG_H, 0)).multiply(rot.makeRotationX(-side * sw * amp));
        set.legs.setMatrixAt(slot * 2 + k, partM);
      }
      // Torso on the hips: stooped forward (more in a chase, most for a runner), swaying, lurching after a strike.
      const lean = (run ? -0.42 : alpha ? -0.3 : chase ? -0.17 : -0.1) + LURCH * attack;
      const sway = sw * (kind === 'walker' ? 0.045 : 0.03) + twitch * 0.15;
      torsoM.multiplyMatrices(bodyM, tmp.makeTranslation(0, LEG_H, 0))
        .multiply(rot.makeRotationX(lean))
        .multiply(tmp.makeRotationZ(sway));
      set.torso.setMatrixAt(slot, torsoM);
      set.torso.setColorAt(slot, shirt);
      // Arms from the shoulders, bent at the elbow. A walker's HANG until it is after someone, then come up in front; a
      // runner's pump with the elbows bent; the alpha's are spread wide with the forearms up. A strike swipes them up.
      const pose = run ? ARMS.runner : alpha ? ARMS.alpha : dormant ? ARMS.dormant : chase ? ARMS.chase : ARMS.hang;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const bob = run ? side * sw * 0.9 : dormant ? 0 : 0.06 * Math.sin(phase + side * 1.4);
        partM.multiplyMatrices(torsoM, tmp.makeTranslation(side * SHOULDER_X, SHOULDER_Y, 0))
          .multiply(rot.makeRotationX(pose.reach + bob - lean * 0.6 + 0.55 * attack))
          .multiply(tmp.makeRotationZ(side * pose.spread + twitch * 0.3));
        set.upperArms.setMatrixAt(slot * 2 + k, partM);
        set.upperArms.setColorAt(slot * 2 + k, shirt);
        foreM.multiplyMatrices(partM, tmp.makeTranslation(0, -UPPER_L, 0)).multiply(rot.makeRotationX(pose.bend + 0.25 * attack));
        set.foreArms.setMatrixAt(slot * 2 + k, foreM);
        set.foreArms.setColorAt(slot * 2 + k, shirt);
      }
      // Head on the torso. A walker's lolls to its own side and hangs a little (more when dormant); a runner's is cocked
      // and jerks; the alpha's is held steady and low, glaring from under its brow.
      const tilt = zb.tilt || 0;
      const roll = alpha
        ? tilt * 0.25
        : run ? tilt + (tilt < 0 ? -RUNNER_COCK : RUNNER_COCK) + twitch
          : tilt + Math.sin(phase * 0.5) * 0.05;
      const nod = alpha
        ? Math.cos(phase) * 0.03 - lean * 0.25
        : Math.cos(phase) * 0.06 - lean * (run ? 0.8 : 0.5) - (dormant ? 0.45 : run || chase ? 0 : WALKER_DROOP);
      headM.multiplyMatrices(torsoM, tmp.makeTranslation(0, TORSO_H, 0))
        .multiply(rot.makeRotationZ(roll))
        .multiply(tmp.makeRotationX(nod));
      set.head.setMatrixAt(slot, headM);
    }
    const setCount = (mesh, count) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    };
    for (const state of STATES) {
      for (const kind of ZOMBIE_KINDS) {
        const set = sets[state][kind];
        setCount(set.legs, set.n * 2);
        setCount(set.upperArms, set.n * 2);
        setCount(set.foreArms, set.n * 2);
        setCount(set.torso, set.n);
        setCount(set.head, set.n);
      }
    }
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of group.children) /** @type {THREE.InstancedMesh} */ (mesh).dispose();
    for (const g of Object.values(geos)) for (const part of Object.values(g)) part.dispose();
    for (const m of Object.values(mats)) m.dispose();
    map.dispose();
    glow.dispose();
    drawn = 0;
  }

  /** Compile every zombie program while the game loads, so the first zombie of a session does not freeze it (P2). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
