// Caelancraft — zombie models (three). See src/CONTRACTS.md §39, §61 and §74.
//
// A dead PERSON built from chunky boxes coloured per vertex (like the pigs; no atlas, no hexagons): a grown body with a
// head well inside its shoulders, a head of hair, ears, eyebrows and a nose, a buttoned shirt with a collar (torn, a tail
// hanging out), a belt, trousers and shoes — and each one's shirt a different faded colour (SHIRT_TINTS), so a crowd
// reads as people who once lived here. What makes it a zombie is the pallid grey-green skin and the eyes: v0.13
// (CONTRACTS §74) gave every kind NARROW EYE SLITS in dark hollows, and its own face:
//   walker — vacant: level brows, two level black slits with nothing behind them, a slack mouth hanging a little open.
//            Its arms hang until it is after someone, then come up in front; it limps and sways;
//   runner — wired: a cocked brow, uneven slits each with a pale pinprick, dark rings, a crooked clenched mouth, wild
//            straw hair; leaner, bent far forward, and its head JERKS (twitchOf);
//   alpha  — ominous: bigger (ALPHA_SCALE) and darker, a brow drawn down to the nose in a scowl over two slanted slits
//            that burn amber (their own small unlit mesh), a jutting jaw under a down-turned mouth, long black hair, a
//            ragged dark coat over hulking shoulders; it comes on hunched with its arms spread wide, glaring from under
//            its brow.
// Nothing here is gory (no blood, no wounds) and no eye is red. The model faces −Z with its origin at the feet, so a
// rotation of `zombie.yaw` about +Y matches yawToForward.
//
// The kinds share the body meshes (legs ×2, arms ×2, torso) and differ by an instance tint, a scale and a gait; each has
// its own head mesh, and the alpha adds its coat and its eyes. So a crowd of walkers costs 4 draw calls, +1 with runners
// about, +3 with an alpha. Their twins with a red emissive (`hurt > 0`) or an ember glow (smouldering) only draw while
// one flashes or burns. The legs swing from the hip with `walkPhase`, the torso leans into a chase and lurches after an
// attack (`swing`, the arms swiping up), and the head lolls by its own `tilt`. A zombie's optional `renderScale`
// (default 1) and `renderSpin` (default 0, extra yaw) draw a black hole's shrinking, spinning ghost (infall.js).
import * as THREE from 'three';
import { ZOMBIE_MAX } from './config.js';
import { SWING_S, kindOf, isDormant, ALPHA_SCALE, ZOMBIE_KINDS } from './zombies.js';
import { compileHidden } from './prewarm.js';

export { ALPHA_SCALE };

/** @typedef {import('./zombies.js').Zombie} Zombie */

/** Part sizes (m). The hips are at LEG_H, the shoulders near the torso's top, the neck on it, the head on the neck. */
export const LEG_H = 0.72;
export const LEG_X = 0.13;
export const TORSO_W = 0.52;
export const TORSO_H = 0.64;
export const TORSO_D = 0.27;
export const NECK_H = 0.05;
export const HEAD_W = 0.4;
export const HEAD_H = 0.4;
export const HEAD_D = 0.38;
export const ARM_L = 0.6;
export const SHOULDER_X = 0.335;
export const SHOULDER_Y = TORSO_H - 0.07;
/** The walker's height to the top of its head (≤ ZOMBIE_HEIGHT 1.9). */
export const MODEL_HEIGHT = LEG_H + TORSO_H + NECK_H + HEAD_H + 0.03;
/** The runner is drawn this much narrower (the alpha ALPHA_SCALE bigger: zombies.js, shared with its ray target). */
export const RUNNER_WIDTH = 0.9;

/** Colours (sRGB): a dead person's pallid grey-green skin; a faded shirt (tinted per zombie), dark trousers, old shoes. */
export const SKIN = 0xb2b89c;
const SKIN_DARK = 0x8d9379;
const SKIN_SHADOW = 0x5c624c;
/** The eye slits: near black, nothing behind them. */
export const SLIT = 0x101210;
const SHIRT = 0xa39c90;
const SHIRT_DARK = 0x7a7469;
const BELT = 0x3a2e24;
const TROUSERS = 0x444852;
const TROUSERS_DARK = 0x30333a;
const SHOE = 0x2e2620;
const MOUTH = 0x2a2221;
/** Hair by kind: a walker's dull brown, a runner's dirty straw, the alpha's black. */
const HAIR = Object.freeze({ walker: 0x3f342b, runner: 0x7a6a45, alpha: 0x1d1a1a });
/** The runner's pinprick pupils and its gritted teeth: a dull bone, never white. */
const GLINT = 0xe0dcbc;
const TEETH = 0xc4bda2;
/** The alpha's coat. */
const HIDE = 0x3b3331;
const HIDE_DARK = 0x29231f;
/**
 * Shirt colours: a walker's or a runner's torso and arms are tinted by SHIRT_TINTS[id mod its length] (kept pale, so the
 * hands barely change), so no two neighbours in a crowd need wear the same shirt.
 */
export const SHIRT_TINTS = Object.freeze([0xffffff, 0xc2d0e4, 0xe8c2b0, 0xd6dcb0, 0xeadba6, 0xd6c4dc, 0xbfd6cc]);
/** Instance tints by kind (multiplied into the vertex colours): a runner is sallow, the alpha dark and cold. */
export const KIND_TINT = Object.freeze({ walker: 0xffffff, runner: 0xf6f0cc, alpha: 0x9a96a0 });
/** The alpha's eyes: a hot amber (never red). */
export const ALPHA_EYES = 0xffa42e;

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.85;
const EMBER = 0xff6a1a;
const EMBER_INTENSITY = 0.55;
const SOOT = 0x8a7c72;
/** A faint glow of their own so they read on a moonlit night (lost in daylight). */
export const NIGHT_GLOW = 0x1c2418;
const LURCH = -0.32;

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

/** How far forward the arms are raised (radians from hanging straight down): a walker's hang until it gives chase. */
export const ARMS_HANG = 0.3;
export const ARMS_CHASE = 1.15;
export const ARMS_ALPHA = 0.95;
/** The alpha holds its arms this far out to the sides (radians); the others 0.06. */
export const ALPHA_SPREAD = 0.3;
/** A walker with nobody to chase lets its head hang this far; a runner's is cocked this far to its own side. */
export const WALKER_DROOP = 0.14;
export const RUNNER_COCK = 0.16;

/**
 * @typedef {Object} ZombieRenderer
 * @property {(zombies: Zombie[], t?: number) => void} sync   draw the given zombies (position, yaw, kind, animation, hurt
 *                                                / burn glow); `t` (seconds, default 0) drives the runner's twitch
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

/** The face is on the head's −Z side. Its features are thin plates in three layers, each PLATE_STEP in front of the last. */
const PLATE = 0.012;
const PLATE_STEP = 0.006;
const Z1 = -HEAD_D / 2 - PLATE / 2;
const Z2 = Z1 - PLATE_STEP;
const Z3 = Z2 - PLATE_STEP;
/** The alpha's brow ridge stands out past every plate, so it shades its eyes. */
const BROW_D = 0.08;
const BROW_Z = -HEAD_D / 2 + 0.003;
export const EYE_X = 0.095;
export const EYE_Y = 0.225;
/** A slit's height: narrow (the old eyes were 0.09 tall); the dark hollow round it is SOCKET_H. */
export const SLIT_H = 0.028;
export const SOCKET_H = 0.052;
/** Where the hair starts on the forehead (head-local y): the face tests look below it. */
export const HAIRLINE_Y = 0.335;

/** The head every kind shares: a person's — ears, a nose, hollow cheeks, dark hollows for the eyes, a neck — and a head
 * of hair in `hair` (its top, back and sides). */
function skull(hair) {
  return [
    [HEAD_W, HEAD_H, HEAD_D, 0, HEAD_H / 2, 0, SKIN],
    [0.13, NECK_H + 0.06, 0.13, 0, -NECK_H / 2 + 0.01, 0.01, SKIN_DARK], // the neck
    [0.035, 0.085, 0.07, -HEAD_W / 2 - 0.015, 0.2, 0.02, SKIN_DARK], // ears
    [0.035, 0.085, 0.07, HEAD_W / 2 + 0.015, 0.2, 0.02, SKIN_DARK],
    [0.055, 0.085, 0.035, 0, 0.165, Z1 - 0.01, SKIN_DARK], // a nose
    [0.055, 0.016, PLATE, 0, 0.118, Z2, SKIN_SHADOW],
    [0.06, 0.1, PLATE, -0.155, 0.125, Z1, SKIN_DARK], // hollow cheeks
    [0.06, 0.1, PLATE, 0.155, 0.125, Z1, SKIN_DARK],
    [0.13, SOCKET_H, PLATE, -EYE_X, EYE_Y, Z1, SKIN_SHADOW], // the hollows of the eyes
    [0.13, SOCKET_H, PLATE, EYE_X, EYE_Y, Z1, SKIN_SHADOW],
    [HEAD_W + 0.024, HEAD_H - HAIRLINE_Y + 0.025, HEAD_D + 0.024, 0, (HEAD_H + HAIRLINE_Y + 0.025) / 2, 0.006, hair], // hair on top …
    [HEAD_W + 0.024, 0.2, 0.05, 0, HEAD_H - 0.16, HEAD_D / 2 + 0.002, hair], // … down the back …
    [0.03, 0.12, 0.15, -HEAD_W / 2 - 0.003, HEAD_H - 0.12, 0.08, hair], // … and over the ears
    [0.03, 0.12, 0.15, HEAD_W / 2 + 0.003, HEAD_H - 0.12, 0.08, hair],
  ];
}

/** The walker: vacant. Level brows, two level slits with nothing in them, a slack mouth. Mirror-symmetric below the hair. */
function walkerFace() {
  const hair = HAIR.walker;
  return [
    [0.12, 0.022, 0.02, -EYE_X, EYE_Y + 0.047, Z2, hair], // eyebrows
    [0.12, 0.022, 0.02, EYE_X, EYE_Y + 0.047, Z2, hair],
    [0.11, SLIT_H, PLATE, -EYE_X, EYE_Y, Z2, SLIT],
    [0.11, SLIT_H, PLATE, EYE_X, EYE_Y, Z2, SLIT],
    [0.15, 0.045, PLATE, 0, 0.066, Z1, MOUTH],
    [0.17, 0.045, 0.03, 0.07, HAIRLINE_Y - 0.004, -HEAD_D / 2 - 0.004, hair, -0.12], // a lock fallen across the forehead
  ];
}

/** The runner: wired. A cocked brow, uneven slits with pale pinpricks, dark rings, a crooked clenched mouth, wild hair. */
function runnerFace() {
  const hair = HAIR.runner;
  return [
    [0.12, 0.022, 0.02, -EYE_X, EYE_Y + 0.042, Z2, hair, -0.12],
    [0.12, 0.022, 0.02, EYE_X, EYE_Y + 0.064, Z2, hair, 0.2], // one brow hitched up
    [0.11, SLIT_H, PLATE, -EYE_X, EYE_Y, Z2, SLIT],
    [0.1, SLIT_H + 0.012, PLATE, EYE_X, EYE_Y + 0.006, Z2, SLIT, 0.1],
    [0.022, 0.022, PLATE, -EYE_X + 0.014, EYE_Y, Z3, GLINT],
    [0.022, 0.022, PLATE, EYE_X - 0.02, EYE_Y + 0.006, Z3, GLINT],
    [0.13, 0.022, PLATE, -EYE_X, EYE_Y - 0.05, Z1, SKIN_SHADOW], // the rings under its eyes
    [0.13, 0.022, PLATE, EYE_X, EYE_Y - 0.05, Z1, SKIN_SHADOW],
    [0.17, 0.042, PLATE, 0.015, 0.07, Z1, MOUTH, 0.12],
    [0.13, 0.014, PLATE, 0.015, 0.071, Z2, TEETH, 0.12],
    [0.1, 0.07, 0.09, -0.11, HEAD_H + 0.045, 0.03, hair, 0.4], // hair standing on end
    [0.09, 0.06, 0.08, 0.03, HEAD_H + 0.04, -0.06, hair, -0.25],
    [0.1, 0.075, 0.09, 0.13, HEAD_H + 0.045, 0.08, hair, -0.45],
    [0.06, 0.06, 0.03, -0.13, HAIRLINE_Y - 0.015, -HEAD_D / 2 - 0.004, hair, 0.5],
  ];
}

/** How far the alpha's brow and its slits slant down towards the nose (radians). */
export const ALPHA_BROW_SLANT = 0.3;
export const ALPHA_SLIT_SLANT = 0.22;

/** The alpha: a scowling brow over black pits (the amber slits burn in them), a down-turned mouth, a jutting jaw. */
function alphaFace() {
  const hair = HAIR.alpha;
  return [
    [0.23, 0.07, BROW_D, -0.098, 0.285, BROW_Z, SKIN_DARK, -ALPHA_BROW_SLANT], // the brow ridge …
    [0.23, 0.07, BROW_D, 0.098, 0.285, BROW_Z, SKIN_DARK, ALPHA_BROW_SLANT],
    [0.17, 0.028, 0.02, -0.1, 0.296, BROW_Z - BROW_D / 2 - 0.006, hair, -ALPHA_BROW_SLANT], // … and the black brows on it
    [0.17, 0.028, 0.02, 0.1, 0.296, BROW_Z - BROW_D / 2 - 0.006, hair, ALPHA_BROW_SLANT],
    [0.14, 0.066, PLATE, -EYE_X, EYE_Y - 0.004, Z2, SLIT],
    [0.14, 0.066, PLATE, EYE_X, EYE_Y - 0.004, Z2, SLIT],
    [0.17, 0.038, PLATE, 0, 0.09, Z1, MOUTH],
    [0.065, 0.038, PLATE, -0.1, 0.074, Z1, MOUTH, 0.55],
    [0.065, 0.038, PLATE, 0.1, 0.074, Z1, MOUTH, -0.55],
    [HEAD_W - 0.07, 0.055, 0.07, 0, 0.026, -HEAD_D / 2 + 0.002, SKIN_DARK], // the jaw, thrust forward
    [0.022, 0.16, PLATE, 0.152, 0.16, Z2, SKIN_SHADOW, 0.35], // an old scar
    [HEAD_W + 0.04, 0.3, 0.07, 0, 0.05, HEAD_D / 2 - 0.005, hair], // long hair down past the jaw
    [0.035, 0.26, 0.14, -HEAD_W / 2 - 0.012, 0.1, 0.1, hair],
    [0.035, 0.26, 0.14, HEAD_W / 2 + 0.012, 0.1, 0.1, hair],
  ];
}

/** The part geometries (local frames: a leg hangs from its hip, an arm from its shoulder, the torso stands on the hips,
 * the head — with its neck — on the torso). `head`, `headRunner` and `headAlpha` are the three kinds' heads; `mantle`
 * (the alpha's coat) and `eyes` (its glow) are overlays. */
export function zombieGeometries() {
  const CHEST_Z = -TORSO_D / 2 - PLATE / 2;
  const CHEST_H = 0.36;
  const leg = boxesGeometry([
    [0.17, LEG_H - 0.1, 0.19, 0, -(LEG_H - 0.1) / 2, 0, TROUSERS],
    [0.175, 0.06, 0.195, 0, -(LEG_H - 0.13), 0, TROUSERS_DARK], // the ragged hem
    [0.18, 0.1, 0.27, 0, -LEG_H + 0.05, -0.04, SHOE],
  ]);
  const torso = boxesGeometry([
    [TORSO_W, CHEST_H, TORSO_D, 0, TORSO_H - CHEST_H / 2, 0, SHIRT], // chest and shoulders …
    [TORSO_W - 0.07, TORSO_H - CHEST_H + 0.01, TORSO_D, 0, (TORSO_H - CHEST_H) / 2, 0, SHIRT], // … over a narrower waist
    [TORSO_W - 0.06, 0.055, TORSO_D + 0.01, 0, 0.045, 0, BELT],
    [TORSO_W * 0.78, 0.2, 0.07, 0, TORSO_H - 0.13, TORSO_D / 2 + 0.015, SHIRT_DARK], // a stooped back
    [0.028, TORSO_H - 0.2, PLATE, 0, TORSO_H / 2 + 0.02, CHEST_Z, SHIRT_DARK], // the buttons down the front
    [0.12, 0.06, PLATE, -0.075, TORSO_H - 0.045, CHEST_Z - PLATE_STEP, SHIRT_DARK, 0.5], // the collar's two points
    [0.12, 0.06, PLATE, 0.075, TORSO_H - 0.045, CHEST_Z - PLATE_STEP, SHIRT_DARK, -0.5],
    [0.11, 0.09, PLATE, 0.14, 0.4, CHEST_Z, SHIRT_DARK], // a tear
    [0.09, 0.15, 0.02, -0.16, 0.2, -TORSO_D / 2 - 0.006, SHIRT_DARK], // a torn flap
    [0.15, 0.08, PLATE, -0.1, 0.03, CHEST_Z - PLATE_STEP, SHIRT], // a shirt tail hanging out over the belt
  ]);
  const arm = boxesGeometry([
    [0.14, ARM_L - 0.05, 0.15, 0, -(ARM_L - 0.05) / 2, 0, SHIRT], // a long sleeve …
    [0.145, 0.045, 0.155, 0, -(ARM_L - 0.07), 0, SHIRT_DARK], // … to a ragged cuff
    [0.12, 0.12, 0.13, 0, -ARM_L - 0.005, 0, SKIN], // the hand …
    [0.11, 0.055, 0.08, 0, -ARM_L - 0.085, -0.022, SKIN_DARK], // … its fingers half curled
  ]);
  const heads = {
    walker: boxesGeometry([...skull(HAIR.walker), ...walkerFace()]),
    runner: boxesGeometry([...skull(HAIR.runner), ...runnerFace()]),
    alpha: boxesGeometry([...skull(HAIR.alpha), ...alphaFace()]),
  };
  // The alpha's coat: hulking shoulders under a ragged dark hide, torn strips down the chest and the back.
  const mantle = boxesGeometry([
    [0.2, 0.15, TORSO_D + 0.1, -(TORSO_W / 2 + 0.03), TORSO_H - 0.045, 0, HIDE],
    [0.2, 0.15, TORSO_D + 0.1, TORSO_W / 2 + 0.03, TORSO_H - 0.045, 0, HIDE],
    [TORSO_W + 0.04, 0.13, TORSO_D + 0.06, 0, TORSO_H - 0.05, 0, HIDE_DARK],
    [0.13, 0.3, 0.02, -0.17, TORSO_H - 0.25, -TORSO_D / 2 - 0.035, HIDE],
    [0.12, 0.4, 0.02, 0.17, TORSO_H - 0.3, -TORSO_D / 2 - 0.035, HIDE_DARK],
    [TORSO_W * 0.86, 0.5, 0.03, 0, TORSO_H - 0.35, TORSO_D / 2 + 0.075, HIDE_DARK],
  ]);
  // The alpha's glow: two narrow slits slanted down towards the nose, burning in the black pits of its head.
  const eyes = boxesGeometry([
    [0.115, SLIT_H + 0.004, PLATE, -EYE_X, EYE_Y - 0.004, Z3, 0xffffff, -ALPHA_SLIT_SLANT],
    [0.115, SLIT_H + 0.004, PLATE, EYE_X, EYE_Y - 0.004, Z3, 0xffffff, ALPHA_SLIT_SLANT],
  ]);
  return { leg, torso, arm, head: heads.walker, headRunner: heads.runner, headAlpha: heads.alpha, mantle, eyes };
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
  const shirt = new THREE.Color();
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
  /**
   * @typedef {{ legs: THREE.InstancedMesh, arms: THREE.InstancedMesh, torso: THREE.InstancedMesh, mantle: THREE.InstancedMesh,
   *   heads: Record<'walker'|'runner'|'alpha', THREE.InstancedMesh>, n: number, mantles: number,
   *   headN: Record<'walker'|'runner'|'alpha', number> }} PartSet
   */
  /** @type {Record<'base'|'hurt'|'burn', PartSet>} */
  const sets = /** @type {*} */ ({});
  const STATES = /** @type {const} */ (['base', 'hurt', 'burn']);
  for (const state of STATES) {
    const suffix = state === 'base' ? '' : `-${state}`;
    sets[state] = {
      legs: instanced(geos.leg, mats[state], capacity * 2, `zombie-legs${suffix}`),
      arms: instanced(geos.arm, mats[state], capacity * 2, `zombie-arms${suffix}`),
      torso: instanced(geos.torso, mats[state], capacity, `zombie-torso${suffix}`),
      mantle: instanced(geos.mantle, mats[state], capacity, `zombie-alpha-hide${suffix}`),
      heads: {
        walker: instanced(geos.head, mats[state], capacity, `zombie-head${suffix}`),
        runner: instanced(geos.headRunner, mats[state], capacity, `zombie-head-runner${suffix}`),
        alpha: instanced(geos.headAlpha, mats[state], capacity, `zombie-head-alpha${suffix}`),
      },
      n: 0,
      mantles: 0,
      headN: { walker: 0, runner: 0, alpha: 0 },
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
  let eyeCount = 0;
  let drawn = 0;

  /**
   * @param {Zombie[]} zombies
   * @param {number} [t=0]  seconds on any steady clock (the runner's twitch)
   */
  function sync(zombies, t = 0) {
    const n = Math.min(zombies.length, capacity);
    for (const state of STATES) {
      const set = sets[state];
      set.n = 0;
      set.mantles = 0;
      for (const kind of ZOMBIE_KINDS) set.headN[kind] = 0;
    }
    eyeCount = 0;
    for (let i = 0; i < n; i++) {
      const zb = zombies[i];
      const state = zb.hurt > 0 ? 'hurt' : zb.smoking ? 'burn' : 'base';
      const set = sets[state];
      const slot = set.n++;
      const kind = kindOf(zb);
      const run = kind === 'runner';
      const alpha = kind === 'alpha';
      const s = renderScaleOf(zb) * (alpha ? ALPHA_SCALE : 1);
      const sx = run ? s * RUNNER_WIDTH : s;
      bodyM.compose(at.set(zb.x, zb.y, zb.z), q.setFromAxisAngle(UP, zb.yaw + renderSpinOf(zb)), scl.set(sx, s, sx));
      tint.set(KIND_TINT[kind]);
      // its shirt: the kind's tint times its own faded colour (the alpha's coat hides its shirt, so it keeps the tint)
      shirt.set(alpha ? 0xffffff : SHIRT_TINTS[Math.abs(Math.floor(zb.id || 0)) % SHIRT_TINTS.length]).multiply(tint);
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
        set.legs.setColorAt(slot * 2 + k, tint);
      }
      // Torso on the hips: stooped forward (more in a chase, most for a runner), swaying, lurching after a strike.
      const lean = (run ? -0.42 : alpha ? -0.3 : chase ? -0.17 : -0.1) + LURCH * attack;
      const sway = sw * (kind === 'walker' ? 0.045 : 0.03) + twitch * 0.15;
      torsoM.multiplyMatrices(bodyM, tmp.makeTranslation(0, LEG_H, 0))
        .multiply(rot.makeRotationX(lean))
        .multiply(tmp.makeRotationZ(sway));
      set.torso.setMatrixAt(slot, torsoM);
      set.torso.setColorAt(slot, shirt);
      if (alpha) {
        set.mantle.setMatrixAt(set.mantles, torsoM);
        set.mantle.setColorAt(set.mantles++, tint);
      }
      // Arms from the shoulders. A walker's HANG until it is after someone, then come up in front; a runner's pump; the
      // alpha's are always up and spread wide, grasping. A strike swipes them up.
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const bob = 0.06 * Math.sin(phase + side * 1.4);
        const reach = run
          ? 0.45 + side * sw * 0.9
          : alpha ? ARMS_ALPHA + bob - lean * 0.6
            : dormant ? 0.12 - lean * 0.6
              : (chase ? ARMS_CHASE : ARMS_HANG) + bob - lean * 0.6;
        partM.multiplyMatrices(torsoM, tmp.makeTranslation(side * SHOULDER_X, SHOULDER_Y, 0))
          .multiply(rot.makeRotationX(reach + 0.55 * attack))
          .multiply(tmp.makeRotationZ(side * (run ? 0.12 : alpha ? ALPHA_SPREAD : 0.06) + twitch * 0.3));
        set.arms.setMatrixAt(slot * 2 + k, partM);
        set.arms.setColorAt(slot * 2 + k, shirt);
      }
      // Head on the neck. A walker's lolls to its own side and hangs a little (more when dormant); a runner's is cocked
      // and jerks; the alpha's is held steady and low, glaring from under its brow.
      const tilt = zb.tilt || 0;
      const roll = alpha
        ? tilt * 0.25
        : run ? tilt + (tilt < 0 ? -RUNNER_COCK : RUNNER_COCK) + twitch
          : tilt + Math.sin(phase * 0.5) * 0.05;
      const nod = alpha
        ? Math.cos(phase) * 0.03 - lean * 0.25
        : Math.cos(phase) * 0.06 - lean * (run ? 0.8 : 0.5) - (dormant ? 0.45 : run || chase ? 0 : WALKER_DROOP);
      headM.multiplyMatrices(torsoM, tmp.makeTranslation(0, TORSO_H + NECK_H, 0))
        .multiply(rot.makeRotationZ(roll))
        .multiply(tmp.makeRotationX(nod));
      const head = set.heads[kind];
      const h = set.headN[kind]++;
      head.setMatrixAt(h, headM);
      head.setColorAt(h, tint);
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
    for (const state of STATES) {
      const set = sets[state];
      setCount(set.legs, set.n * 2);
      setCount(set.arms, set.n * 2);
      setCount(set.torso, set.n);
      setCount(set.mantle, set.mantles);
      for (const kind of ZOMBIE_KINDS) setCount(set.heads[kind], set.headN[kind]);
    }
    setCount(eyesMesh, eyeCount);
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of group.children) /** @type {THREE.InstancedMesh} */ (mesh).dispose();
    for (const g of Object.values(geos)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    drawn = 0;
  }

  /** Compile every zombie program while the game loads, so the first zombie of a session does not freeze it (P2). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
