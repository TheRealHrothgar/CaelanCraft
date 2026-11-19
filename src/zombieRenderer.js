// Caelancraft — zombie models (three). See src/CONTRACTS.md §39, §61, §74, §86 and §104.
//
// A zombie is a HEX-FACETED dead person (zombieModel.js, pure): tapered hexagonal columns, a gaunt faceted head with a
// heavy brow over narrow slits, chamfered shoes and hands, ragged painted clothes on ONE 256² atlas per kind (linear
// filtering, mipmaps; cut out where a hem is torn away). Spooky without being frightening. The three kinds have their
// own models and atlases, a scale and a bearing:
//   walker — vacant. It limps and sways; its arms hang until it is after someone, then come up in front;
//   runner — wired. Leaner, bent far forward, elbows pumping, and its head JERKS (twitchOf);
//   alpha  — ominous. Bigger and heavier (ALPHA_SCALE, its own broad build and long coat), hunched, arms spread wide with
//            the forearms up, its head held low and steady.
// The eyes are narrow slits that GLOW faintly in the dark — at night, or out of the sky's reach at any hour (the model's
// glow image as the emissive map, in step with the atlas): a faint marsh green, pale pinpricks, a pale gold — never red.
// Walkers and runners wear shirts tinted by SHIRT_TINTS (only the shirt: the atlas marks its cloth with TINT_ALPHA; its
// glow takes the tint too, so the crowd differs at night as well), so a crowd is not one person repeated.
// The model faces −Z with its origin at the feet, so a rotation of `zombie.yaw` about +Y matches yawToForward.
//
// Each kind has its own five InstancedMeshes (legs, upper arms, forearms, torso, head) over its own texture and material,
// so a crowd of one kind costs 5 draw calls whatever its size. Their twins with a pale hit flash (`hurt > 0`,
// ZOMBIE_HURT: never red) or an ember glow (smouldering) only draw while one flashes or burns. The legs swing from the
// hip with `walkPhase`, the torso leans into a chase and lurches after an attack (`swing`, the arms swiping up), and the
// head lolls by its own `tilt`. In block light (a torch, a lamp, a fire: CONTRACTS §86) it brings one arm up across its
// face and turns its head away, by its `shield`. A zombie's optional `renderScale` (default 1) and `renderSpin` (default
// 0, extra yaw) draw a black hole's shrinking, spinning ghost. The materials are lit like every object (the light volume)
// plus a small fill (ZOMBIE_FILL), so the facets turned from the sun keep their colour and still go dark at night.
import * as THREE from 'three';
import { ZOMBIE_MAX } from './config.js';
import { SWING_S, kindOf, isDormant, ALPHA_SCALE, ZOMBIE_KINDS } from './zombies.js';
import { compileHidden } from './prewarm.js';
import { patchFillShader } from './lightShader.js';
import { zombieModel, zombieRig, TINT_ALPHA, ZOMBIE_ATLAS } from './zombieModel.js';

export { ALPHA_SCALE };

/** @typedef {import('./zombies.js').Zombie} Zombie */
/** @typedef {import('./zombieModel.js').ZombieRig} ZombieRig */

/** Each kind's joints (zombieModel's rigs): the renderer hangs the parts from them. */
export const RIGS = Object.freeze({ walker: zombieRig('walker'), runner: zombieRig('runner'), alpha: zombieRig('alpha') });
/** The walker's joints (m): the hips at LEG_H, the head's pivot TORSO_H over them, the shoulders, the arm's two lengths. */
export const LEG_H = RIGS.walker.legH;
export const LEG_X = RIGS.walker.legX;
export const TORSO_H = RIGS.walker.torsoH;
export const UPPER_L = RIGS.walker.upperL;
export const FORE_L = RIGS.walker.foreL;
export const ARM_L = UPPER_L + FORE_L;
export const SHOULDER_X = RIGS.walker.shoulderX;
export const SHOULDER_Y = RIGS.walker.shoulderY;
/** The runner is drawn this much narrower (the alpha ALPHA_SCALE bigger: zombies.js, shared with its ray target). */
export const RUNNER_WIDTH = 0.9;

/**
 * Shirt colours: a walker's or a runner's shirt is tinted by SHIRT_TINTS[id mod its length] (its skin, hair and trousers
 * are not: the atlas marks the cloth), so no two neighbours in a crowd need wear the same shirt. Faded colours, kept pale
 * (and nothing red); the alpha's coat stays as painted.
 */
export const SHIRT_TINTS = Object.freeze([0xffffff, 0xa9bedd, 0xd9c29c, 0xbccf96, 0xe6d08e, 0xc6b4d8, 0xa2cdbf]);

/**
 * The hit flash: the whole zombie flashes a pale, cold grey-green (nothing red on a zombie, DESIGN-characters §2; the
 * animals keep the game's red flash), for as long as before (`hurt > 0`).
 */
export const ZOMBIE_HURT = 0xdfeee4;
export const ZOMBIE_HURT_INTENSITY = 0.7;
const HURT = ZOMBIE_HURT;
const HURT_INTENSITY = ZOMBIE_HURT_INTENSITY;
const EMBER = 0xff6a1a;
const EMBER_INTENSITY = 0.55;
const SOOT = 0x8a7c72;
const LURCH = -0.32;
/**
 * How strongly the glow image shines in full daylight under the open sky (1 at night, and at any hour out of the sky's
 * reach — a cave, under a roof: GLOW_LOCAL_FRAGMENT): by day in the open the slits are dark.
 */
export const GLOW_DAY = 0.02;
/** The fill on the facets turned from the light: a little of the light that reaches them, a cool-neutral grey-green. */
export const ZOMBIE_FILL = Object.freeze({ color: Object.freeze([0.92, 1, 0.9]), strength: 0.12 });
/** The program key of every zombie material. */
export const ZOMBIE_PROGRAM = 'caelancraft-zombie';

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
 * Light hurts its eyes (CONTRACTS §86): by its `shield` (0..1, zombies.js — nothing up to ZOMBIE_SHY_LIGHT, all the way
 * at the light it dreads) a zombie brings the arm on its own `side` from its kind's bearing to SHIELD_ARM — the upper
 * arm out in front of its shoulder, a little above level (`reach`, `spread` 0), the forearm bent up (`bend`) and turned
 * in about the upper arm by `twist`, so that it slants up across that half of its face with the hand before the eye —
 * and its head from its own lolling to a nod of SHIELD_NOD (held up) and a roll of SHIELD_ROLL away from that arm. The
 * strike's swipe and the runner's twitch leave that arm as it rises. A dormant walker, asleep on its feet, does none
 * of it.
 */
export const SHIELD_ARM = Object.freeze({ reach: 1.75, bend: 1.4, spread: 0, twist: 0.65 });
export const SHIELD_NOD = 0.05;
export const SHIELD_ROLL = 0.12;

/** @param {*} zb @returns {number} how far its arm is up across its face, 0..1 (`Zombie.shield`; 0 for anything else) */
export function shieldOf(zb) {
  const s = zb ? zb.shield : 0;
  return s > 0 ? Math.min(1, s) : 0;
}

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
 * Boxes merged into one geometry with a colour per vertex (the animals' builder). Each box: [w, h, d, x, y, z, colour,
 * rotZ?] (centre x y z; rotZ turns it about its own centre).
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

/** A kit geometry as a BufferGeometry. @param {import('./modelKit.js').Geo} g */
function bufferOf(g) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  out.setIndex(new THREE.BufferAttribute(g.index, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * A kind's part geometries (zombieModel's, in their joints' frames: a leg hangs from its hip, an upper arm from its
 * shoulder, a forearm from its elbow, the torso stands on the hips, the head on the torso).
 * @param {'walker'|'runner'|'alpha'} kind
 * @returns {{ leg: THREE.BufferGeometry, upperArm: THREE.BufferGeometry, foreArm: THREE.BufferGeometry, torso: THREE.BufferGeometry, head: THREE.BufferGeometry }}
 */
export function zombieGeometries(kind) {
  const m = zombieModel(kind);
  return {
    leg: bufferOf(m.parts.leg),
    upperArm: bufferOf(m.parts.upperArm),
    foreArm: bufferOf(m.parts.foreArm),
    torso: bufferOf(m.parts.torso),
    head: bufferOf(m.parts.head),
  };
}

/** A painted image as a texture: sRGB, linear filtering with mipmaps. @param {import('./paintKit.js').Img} img */
function paintedTexture(img) {
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The shirt tint: the instance colour multiplies only the texels the atlas marks with TINT_ALPHA (its alpha 0.75 there,
 * 1 elsewhere — both well over alphaTest); in place of three's color_fragment. `zTint` is kept for the glow.
 */
const TINT_MID = ((TINT_ALPHA / 255 + 1) / 2).toFixed(4);
const TINT_SLOPE = (1 / (1 - TINT_ALPHA / 255) * 2).toFixed(4);
export const TINT_FRAGMENT = /* glsl */ `
vec3 zTint = vec3( 1.0 );
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	zTint = mix( vec3( 1.0 ), vColor.rgb, clamp( ( ${TINT_MID} - diffuseColor.a ) * ${TINT_SLOPE}, 0.0, 1.0 ) );
	diffuseColor.rgb *= zTint;
#endif`;

/**
 * The glow image's light takes the shirt's tint too (after three's emissivemap_fragment): at night the self-light
 * outshines the moonlit cloth, so untinted it would turn a crowd into one shirt repeated. The eyes are not marked, so
 * they stay as painted; the hit flash and the embers (no glow image) are not tinted.
 */
export const GLOW_TINT_FRAGMENT = /* glsl */ `
#include <emissivemap_fragment>
#ifdef USE_EMISSIVEMAP
	totalEmissiveRadiance *= zTint;
#endif`;

/**
 * Where the zombie stands decides how dark it is too (after three's light accumulation, where the light volume's caelSky
 * is in scope): out of the sky's reach — a cave, under a roof, deep shade — the glow image shines as it does at night,
 * at any hour. `zombieGlow` is the glow by the time of day (the base material's emissiveIntensity, which three has
 * already applied); the brighter of the two wins.
 */
export const GLOW_LOCAL_FRAGMENT = /* glsl */ `
#ifdef USE_EMISSIVEMAP
	totalEmissiveRadiance *= max( zombieGlow, ${GLOW_DAY.toFixed(4)} + ${(1 - GLOW_DAY).toFixed(4)} * ( 1.0 - caelSky ) ) / max( zombieGlow, 1e-4 );
#endif`;

/**
 * Patch a zombie material's shader: lit like every object (the light volume), the fill, the shirt tint (on the cloth
 * and on its glow), the glow by the light where it stands.
 * @param {{ vertexShader: string, fragmentShader: string, uniforms: Record<string, *> }} shader
 * @param {{ value: number }} [glow]  the glow by the time of day (the renderer shares one; 1 when not given)
 */
export function patchZombieShader(shader, glow = { value: 1 }) {
  patchFillShader(shader, ZOMBIE_FILL);
  shader.uniforms.zombieGlow = glow;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float zombieGlow;')
    .replace('#include <color_fragment>', TINT_FRAGMENT)
    .replace('#include <emissivemap_fragment>', GLOW_TINT_FRAGMENT)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLOW_LOCAL_FRAGMENT}`);
}

/**
 * @param {THREE.MeshLambertMaterialParameters} params
 * @param {{ value: number }} glow
 */
function zombieMaterial(params, glow) {
  const m = new THREE.MeshLambertMaterial({ alphaTest: 0.5, ...params });
  m.onBeforeCompile = (shader) => patchZombieShader(/** @type {*} */ (shader), glow);
  m.customProgramCacheKey = () => ZOMBIE_PROGRAM;
  return m;
}

/**
 * @param {THREE.Scene} scene
 * @param {*} [_atlasTexture]  unused (the zombies have their own atlases); kept so main's call stays as it was
 * @param {number} [capacity=ZOMBIE_MAX]     most zombies drawn (main: ZOMBIE_MAX + MAX_INFALL_MOBS, for ghosts)
 * @returns {ZombieRenderer}
 */
export function createZombieRenderer(scene, _atlasTexture, capacity = ZOMBIE_MAX) {
  const STATES = /** @type {const} */ (['base', 'hurt', 'burn']);
  /** @type {THREE.Texture[]} */
  const textures = [];
  /** @type {Record<string, Record<'base'|'hurt'|'burn', THREE.MeshLambertMaterial>>} */
  const mats = {};
  /** @type {Record<string, ReturnType<typeof zombieGeometries>>} */
  const geos = {};
  /** the glow by the time of day, shared by every zombie program (GLOW_LOCAL_FRAGMENT) */
  const glowNowUniform = { value: 1 };
  for (const kind of ZOMBIE_KINDS) {
    const model = zombieModel(/** @type {'walker'|'runner'|'alpha'} */ (kind));
    const map = paintedTexture(model.image);
    const glow = paintedTexture(model.glow);
    textures.push(map, glow);
    mats[kind] = {
      base: zombieMaterial({ map, emissive: 0xffffff, emissiveMap: glow }, glowNowUniform),
      hurt: zombieMaterial({ map, emissive: HURT, emissiveIntensity: HURT_INTENSITY }, glowNowUniform),
      burn: zombieMaterial({ map, color: SOOT, emissive: EMBER, emissiveIntensity: EMBER_INTENSITY }, glowNowUniform),
    };
    geos[kind] = zombieGeometries(/** @type {'walker'|'runner'|'alpha'} */ (kind));
  }
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
  /** @type {Record<'base'|'hurt'|'burn', Record<string, PartSet>>} */
  const sets = /** @type {*} */ ({ base: {}, hurt: {}, burn: {} });
  for (const kind of ZOMBIE_KINDS) {
    const g = geos[kind];
    for (const state of STATES) {
      const suffix = state === 'base' ? '' : `-${state}`;
      const mat = mats[kind][state];
      sets[state][kind] = {
        legs: instanced(g.leg, mat, capacity * 2, `zombie-legs-${kind}${suffix}`),
        upperArms: instanced(g.upperArm, mat, capacity * 2, `zombie-upper-arms-${kind}${suffix}`),
        foreArms: instanced(g.foreArm, mat, capacity * 2, `zombie-forearms-${kind}${suffix}`),
        torso: instanced(g.torso, mat, capacity, `zombie-torso-${kind}${suffix}`),
        head: instanced(g.head, mat, capacity, `zombie-head-${kind}${suffix}`),
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
    const glowNow = GLOW_DAY + (1 - GLOW_DAY) * Math.min(1, Math.max(0, Number.isFinite(dark) ? dark : 1));
    for (const kind of ZOMBIE_KINDS) mats[kind].base.emissiveIntensity = glowNow;
    glowNowUniform.value = glowNow;
    for (const state of STATES) for (const kind of ZOMBIE_KINDS) sets[state][kind].n = 0;
    for (let i = 0; i < n; i++) {
      const zb = zombies[i];
      const state = zb.hurt > 0 ? 'hurt' : zb.smoking ? 'burn' : 'base';
      const kind = kindOf(zb);
      const R = RIGS[kind];
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
        partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * R.legX, R.legH, 0)).multiply(rot.makeRotationX(-side * sw * amp));
        set.legs.setMatrixAt(slot * 2 + k, partM);
      }
      // Torso on the hips: stooped forward (more in a chase, most for a runner), swaying, lurching after a strike.
      const lean = (run ? -0.42 : alpha ? -0.3 : chase ? -0.17 : -0.1) + LURCH * attack;
      const sway = sw * (kind === 'walker' ? 0.045 : 0.03) + twitch * 0.15;
      torsoM.multiplyMatrices(bodyM, tmp.makeTranslation(0, R.legH, 0))
        .multiply(rot.makeRotationX(lean))
        .multiply(tmp.makeRotationZ(sway));
      set.torso.setMatrixAt(slot, torsoM);
      set.torso.setColorAt(slot, shirt);
      // Arms from the shoulders, bent at the elbow. A walker's HANG until it is after someone, then come up in front; a
      // runner's pump with the elbows bent; the alpha's are spread wide with the forearms up. A strike swipes them up.
      const pose = run ? ARMS.runner : alpha ? ARMS.alpha : dormant ? ARMS.dormant : chase ? ARMS.chase : ARMS.hang;
      // §86: in block light the arm on its own side comes up and its forearm slants across its face (SHIELD_ARM), by
      // its `shield`.
      const shield = dormant ? 0 : shieldOf(zb);
      const shieldSide = zb.side === -1 ? -1 : 1;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const up = side === shieldSide ? shield : 0;
        const free = 1 - up; // how much of the swipe and the twitch that arm still follows
        const bob = run ? side * sw * 0.9 : dormant ? 0 : 0.06 * Math.sin(phase + side * 1.4);
        const reach = pose.reach + bob - lean * 0.6;
        partM.multiplyMatrices(torsoM, tmp.makeTranslation(side * R.shoulderX, R.shoulderY, 0))
          .multiply(rot.makeRotationX(reach + (SHIELD_ARM.reach - reach) * up + 0.55 * attack * free))
          .multiply(tmp.makeRotationZ(side * (pose.spread + (SHIELD_ARM.spread - pose.spread) * up) + twitch * 0.3 * free));
        set.upperArms.setMatrixAt(slot * 2 + k, partM);
        set.upperArms.setColorAt(slot * 2 + k, shirt);
        foreM.multiplyMatrices(partM, tmp.makeTranslation(0, -R.upperL, 0));
        if (up > 0) foreM.multiply(rot.makeRotationY(side * SHIELD_ARM.twist * up)); // the forearm turns in toward the face
        foreM.multiply(rot.makeRotationX(pose.bend + (SHIELD_ARM.bend - pose.bend) * up + 0.25 * attack * free));
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
      // … and in block light it holds its head up behind the raised arm, leaning it away from that arm (§86).
      headM.multiplyMatrices(torsoM, tmp.makeTranslation(0, R.torsoH, 0))
        .multiply(rot.makeRotationZ(roll + (shieldSide * SHIELD_ROLL - roll) * shield))
        .multiply(tmp.makeRotationX(nod + (SHIELD_NOD - nod) * shield));
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
    for (const set of Object.values(mats)) for (const m of Object.values(set)) m.dispose();
    for (const t of textures) t.dispose();
    drawn = 0;
  }

  /** Compile every zombie program while the game loads, so the first zombie of a session does not freeze it (P2). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}

/** The atlas size of every kind (zombieModel.ZOMBIE_ATLAS). */
export const ATLAS_SIZE = ZOMBIE_ATLAS;
