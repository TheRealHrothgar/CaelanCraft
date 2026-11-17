// Caelancraft — the player's avatar (three). See src/CONTRACTS.md §91.
//
// Two drawings of one avatar, both from avatarModel.js (the hex-faceted kids over one painted 256² atlas each):
//   - the MODEL, seen in the third-person views and as the other players on a server: one geometry per bone, hung from
//     today's joints — the legs from the hips, the seat (and a skirt) on the hips, a torso that leans, arms with elbows
//     from the shoulders, a head with its hair that turns and nods, long back hair that follows the head part of the way.
//     AvatarMotion (pure) gives the angles every frame. Origin at the feet; it faces −Z, turned by the body's yaw.
//   - the first-person HAND: a forearm with the sleeve's cuff and a real hand — a palm, four curled fingers and a thumb
//     round the haft of the held tool, loosely open when nothing is held — small and low at the lower right of the view
//     (FP_HAND). It chops from the wrist on AvatarPose.fpSwing and bobs with the walk. It is placed in camera space every
//     frame and drawn in the main pass with its depth squeezed into the nearest FP_DEPTH of the depth range, so it is
//     always in front of the world (never clipped by a block) but still hides its own far side; it is lit from the light
//     volume at the EYE.
// The geometries, the atlas textures (linear filtering, mipmaps) and the model's material are built once per avatar
// definition, when first shown, and SHARED by every renderer (the player's and each other player's): an instance only
// makes groups and meshes. The model's material is a Lambert material lit like every object (lightShader.js's patch,
// CONTRACTS §62: it darkens in a cave and a torch lights it) plus a small WARM FILL in proportion to the light that
// reaches it (AVATAR_FILL), so faces turned from the sun stay warm, never grey — and still go dark at night and in caves.
// The item in hand (setHeld) is a chunky slab extruded from its pixel art (heldItem.js), at the grip of the model's right
// fist and in the first-person fist. renderAvatarPortraits draws the chooser's portraits with the game's renderer.
import * as THREE from 'three';
import { WORLD_HEIGHT } from './config.js';
import { AVATAR_IDS, avatarById } from './avatars.js';
import { avatarModel, AVATAR_BONES, FP_HAND, fpHandFrame, fpStroke, HAIR_BACK_FOLLOW } from './avatarModel.js';
import { LIGHT_VOLUME_VERTEX_MAIN, patchObjectShader, patchFillShader } from './lightShader.js';
import { compileHidden } from './prewarm.js';
import { heldItemGeometry, heldItemShown } from './heldItem.js';
import { AvatarMotion } from './avatarMotion.js';

/** @typedef {import('./avatars.js').AvatarDef} AvatarDef */
/** @typedef {import('./avatarMotion.js').AvatarPose} AvatarPose */
/** @typedef {import('./heldItem.js').HeldStyle} HeldStyle */
/** @typedef {import('./avatarModel.js').Bone} Bone */
/** @typedef {import('./modelKit.js').Geo} Geo */

/** The first-person hand's depth is squeezed into this share of the depth range, in front of everything else. */
export const FP_DEPTH = 0.02;
/** The first-person hand draws after every other opaque thing. */
export const FP_RENDER_ORDER = 10;
/**
 * How the model holds the item in its right fist, in the forearm's frame (at rest it hangs down; ahead is −z), for a
 * hafted 'tool' and for a 'lump' (heldItem.js): the slab is turned so its flat face looks in toward the body, spun `spin`
 * about its own length, tipped so its length (the slab's +y) points ahead and `tip` radians up from level, and last turned
 * `lean` about the forearm's length; its grip sits at the fist's grip point, moved `ahead` metres along −z (a lump rests in
 * front of the fist, not inside it). A tool is held ahead and a little up, a lump upright.
 */
export const HELD_POSE = Object.freeze({
  tool: Object.freeze({ tip: 0.3, spin: 0, lean: 0, ahead: 0 }),
  lump: Object.freeze({ tip: Math.PI / 2, spin: 0, lean: 0, ahead: 0.06 }),
});
/** How far a dress lets the legs swing (its skirt would open otherwise). */
export const SKIRT_LEG_SWING = 0.42;
/** Lying down, the body rests this far over the ground; on a horse, the hips are this high over the saddle (m). */
export const LIE_LIFT = 0.01;
export const RIDE_HIP_Y = 0.1;
/**
 * The warm fill: a share of the light reaching the model (the sky's and the sun's or moon's, times the cell's sky light,
 * plus the block light — never more) comes back warm on every facet, so the side away from the sun stays warm and never
 * goes grey. In proportion to the light, so it is no glow: at night and in a cave it fades with everything else.
 */
export const AVATAR_FILL = Object.freeze({ color: Object.freeze([1, 0.82, 0.62]), strength: 0.14 });
/** The program keys: the model, the first-person hand, the first-person held item. */
export const AVATAR_PROGRAM = 'caelancraft-avatar';
export const FP_ARM_PROGRAM = 'caelancraft-avatar-arm';
export const FP_HELD_PROGRAM = 'caelancraft-avatar-held';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Light a model's shader like every object (the light volume) and add the warm fill.
 * @param {{ vertexShader: string, fragmentShader: string, uniforms: Record<string, *> }} shader
 */
export function patchAvatarShader(shader) {
  patchFillShader(shader, AVATAR_FILL);
}

/** The model's material over one atlas. @param {THREE.Texture} map */
function modelMaterial(map) {
  const m = new THREE.MeshLambertMaterial({ map });
  m.onBeforeCompile = (shader) => patchAvatarShader(/** @type {*} */ (shader));
  m.customProgramCacheKey = () => AVATAR_PROGRAM;
  return m;
}

/**
 * A first-person material (the hand's, the held item's): lit like the objects, but from the light volume at the eye
 * (`caelArmEye`), with its depth squeezed to the front of the range; the hand's has the warm fill too.
 * @param {THREE.MeshLambertMaterialParameters} params  the hand: its atlas (`map`); the item: `vertexColors`
 * @param {{ value: THREE.Vector3 }} eye
 * @param {string} programKey  its own program cache key
 * @param {boolean} fill
 */
function fpMaterial(params, eye, programKey, fill) {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (shader) => {
    if (fill) patchAvatarShader(/** @type {*} */ (shader));
    else patchObjectShader(/** @type {*} */ (shader));
    shader.uniforms.caelArmEye = eye;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 caelArmEye;')
      .replace(LIGHT_VOLUME_VERTEX_MAIN, `${LIGHT_VOLUME_VERTEX_MAIN}
vCaelLight = caelVolumeLevels( caelArmEye );
gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
  };
  m.customProgramCacheKey = () => programKey;
  return m;
}

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

/** An atlas as a texture: sRGB, linear filtering with mipmaps. @param {import('./paintKit.js').Img} img */
function atlasTexture(img) {
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
 * One avatar's GPU resources, shared by every renderer.
 * @typedef {Object} AvatarAssets
 * @property {AvatarDef} def
 * @property {import('./avatarModel.js').AvatarModel} model
 * @property {THREE.DataTexture} texture
 * @property {Record<Bone, THREE.BufferGeometry|null>} bones
 * @property {{ arm: THREE.BufferGeometry, grip: THREE.BufferGeometry, relaxed: THREE.BufferGeometry }} fp
 * @property {THREE.MeshLambertMaterial} material
 */

/** @type {Map<string, AvatarAssets>} */
const shared = new Map();

/**
 * An avatar's shared resources (built on first use).
 * @param {AvatarDef} def
 * @returns {AvatarAssets}
 */
export function avatarAssets(def) {
  let a = shared.get(def.id);
  if (a) return a;
  const model = avatarModel(def);
  const texture = atlasTexture(model.image);
  /** @type {Record<string, THREE.BufferGeometry|null>} */
  const bones = {};
  for (const b of AVATAR_BONES) {
    const g = model.bones[/** @type {Bone} */ (b)];
    bones[b] = g ? bufferOf(g) : null;
  }
  a = {
    def, model, texture, bones: /** @type {Record<Bone, THREE.BufferGeometry|null>} */ (bones),
    fp: { arm: bufferOf(model.fp.arm), grip: bufferOf(model.fp.grip), relaxed: bufferOf(model.fp.relaxed) },
    material: modelMaterial(texture),
  };
  shared.set(def.id, a);
  return a;
}

/** How many avatars' resources are built (tests). */
export const avatarAssetCount = () => shared.size;

/** Free every avatar's shared resources (tests; a page never needs to). */
export function disposeAvatarAssets() {
  for (const a of shared.values()) {
    for (const g of Object.values(a.bones)) if (g) g.dispose();
    for (const g of Object.values(a.fp)) g.dispose();
    a.material.dispose();
    a.texture.dispose();
  }
  shared.clear();
}

/** A held item's slab as a geometry (position, normal, colour). @param {import('./heldItem.js').ItemSlab} slab */
function heldGeometry(slab) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(slab.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(slab.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(slab.colors, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * @typedef {Object} AvatarFrame  what sync draws this frame
 * @property {number} x  the feet (world)
 * @property {number} y
 * @property {number} z
 * @property {AvatarPose} pose
 * @property {boolean} showModel   draw the model (the third-person views)
 * @property {boolean} showArm     draw the first-person hand
 * @property {THREE.Camera|null} [camera]  the camera the hand hangs from (its position and rotation set for this frame)
 * @property {number} [eyeX]       where the hand's light is read (default: the camera)
 * @property {number} [eyeY]
 * @property {number} [eyeZ]
 */

/**
 * @typedef {Object} AvatarRenderer
 * @property {(id: string) => void} setAvatar   show this avatar (an unknown id shows the default one)
 * @property {() => string} avatarId
 * @property {(key: string|null) => void} setHeld  show this item in hand (a block item, an unknown key or null: nothing)
 * @property {() => string|null} heldKey  the item shown in hand (null: none)
 * @property {(frame: AvatarFrame) => void} sync
 * @property {THREE.Group} group      the models
 * @property {THREE.Group} armGroup   the first-person hands (placed in camera space)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm
 * @property {() => void} dispose
 */

/**
 * @param {THREE.Scene} scene
 * @returns {AvatarRenderer}
 */
export function createAvatarRenderer(scene) {
  const eye = { value: new THREE.Vector3() };
  const group = new THREE.Group();
  group.name = 'avatars';
  const armGroup = new THREE.Group();
  armGroup.name = 'avatar-arm';
  armGroup.matrixAutoUpdate = false;
  scene.add(group);
  scene.add(armGroup);
  // the item in hand: the model's lit like the model's objects (the prototype hook), the first-person one at the eye
  const heldMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const fpHeldMaterial = fpMaterial({ vertexColors: true }, eye, FP_HELD_PROGRAM, false);
  /** @type {THREE.MeshLambertMaterial[]} the first-person hands' materials (one per avatar shown) */
  const fpMaterials = [];
  /** @type {Map<string, { geometry: THREE.BufferGeometry, style: HeldStyle }>} one geometry per item, made when first held */
  const heldCache = new Map();
  // before anything is held: an empty slab with the same attributes, so prewarm compiles the held item's own programs
  const empty = new Float32Array(0);
  const noHeld = heldGeometry({ positions: empty, normals: empty, colors: empty });

  const mesh = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    return m;
  };
  /** @param {string} name */
  const joint = (name, order = 'XYZ') => {
    const g = new THREE.Group();
    g.name = name;
    g.rotation.order = /** @type {THREE.EulerOrder} */ (order);
    return g;
  };

  /**
   * One avatar's model: groups at its joints, each with its bone's mesh.
   * @param {AvatarDef} def
   */
  function build(def) {
    const A = avatarAssets(def);
    const rig = A.model.rig;
    const mat = A.material;
    const id = def.id;
    const bone = (b, name) => {
      const g = A.bones[/** @type {Bone} */ (b)];
      return g ? mesh(g, mat, `avatar-${name}-${id}`) : null;
    };
    const root = new THREE.Group();
    root.name = `avatar-${id}`;
    root.visible = false;
    const body = joint('avatar-hips'); // at the hip joints
    root.add(body);
    const seat = bone('hips', 'hips');
    if (seat) body.add(seat);
    const legs = [-1, 1].map((side) => {
      const hip = joint(side < 0 ? 'avatar-hip-l' : 'avatar-hip-r');
      hip.position.set(side * rig.legX, 0, 0);
      const m = bone(side < 0 ? 'legL' : 'legR', 'leg');
      if (m) hip.add(m);
      body.add(hip);
      return hip;
    });
    const torso = joint('avatar-torso', 'YXZ');
    const chest = bone('torso', 'torso');
    if (chest) torso.add(chest);
    body.add(torso);
    const arms = [-1, 1].map((side) => {
      const [sx, sy, sz] = rig.shoulder;
      const [ex, ey, ez] = rig.elbow;
      const shoulder = joint(side < 0 ? 'avatar-shoulder-l' : 'avatar-shoulder-r', 'YXZ');
      shoulder.position.set(side * sx, sy, sz);
      const upper = bone(side < 0 ? 'upperL' : 'upperR', 'upper-arm');
      if (upper) shoulder.add(upper);
      const elbow = joint(side < 0 ? 'avatar-elbow-l' : 'avatar-elbow-r');
      elbow.position.set(side * ex, ey, ez);
      const fore = bone(side < 0 ? 'foreL' : 'foreR', 'forearm');
      if (fore) elbow.add(fore);
      shoulder.add(elbow);
      torso.add(shoulder);
      return { shoulder, elbow };
    });
    const neck = joint('avatar-neck', 'YXZ');
    neck.position.set(rig.head[0], rig.head[1], rig.head[2]);
    const head = bone('head', 'head');
    if (head) neck.add(head);
    torso.add(neck);
    /** @type {THREE.Group|null} long hair down the back: it follows the head part of the way */
    let hairBack = null;
    const back = bone('hairBack', 'hair-back');
    if (back) {
      hairBack = joint('avatar-hair-back', 'YXZ');
      hairBack.position.copy(neck.position);
      hairBack.add(back);
      torso.add(hairBack);
    }
    group.add(root);
    return {
      def, rig, assets: A, root, body, legs, torso, arms, neck, hairBack,
      /** @type {null|{ root: THREE.Group, hand: THREE.Group, fist: THREE.Mesh, arm: THREE.Mesh }} built when first needed */
      fp: null,
    };
  }

  /** @typedef {ReturnType<typeof build>} Figure */
  /** @type {Map<string, Figure>} built when first shown */
  const figures = new Map();
  /** @param {string} id @returns {Figure} */
  function figure(id) {
    const def = avatarById(id);
    let f = figures.get(def.id);
    if (!f) {
      f = build(def);
      figures.set(def.id, f);
    }
    return f;
  }

  /**
   * The first-person hand of a figure: the forearm in the arm's frame, the fist in the wrist's (all placed by sync).
   * @param {Figure} f
   */
  function fpOf(f) {
    if (f.fp) return f.fp;
    const A = f.assets;
    const mat = fpMaterial({ map: A.texture }, eye, FP_ARM_PROGRAM, true);
    fpMaterials.push(mat);
    const root = new THREE.Group();
    root.name = `avatar-arm-${f.def.id}`;
    root.matrixAutoUpdate = false;
    root.visible = false;
    const hand = new THREE.Group();
    hand.name = 'avatar-fp-wrist';
    hand.matrixAutoUpdate = false;
    const arm = mesh(A.fp.arm, mat, `avatar-fp-arm-${f.def.id}`);
    const fist = mesh(A.fp.relaxed, mat, `avatar-fp-hand-${f.def.id}`);
    for (const m of [arm, fist]) {
      m.frustumCulled = false;
      m.renderOrder = FP_RENDER_ORDER;
    }
    hand.add(fist);
    root.add(arm, hand);
    armGroup.add(root);
    f.fp = { root, hand, fist, arm };
    placeFp(f, 0, 0, 0);
    if (f === current) placeHeld(); // the item and the grip go into the new hand
    return f.fp;
  }

  let current = figure(avatarById('').id);

  // ---- the item in hand: one mesh at the grip of the current model's right fist (arms[1], the +x side), one in its
  // first-person fist
  const held = mesh(noHeld, heldMaterial, 'avatar-held');
  const fpHeld = mesh(noHeld, fpHeldMaterial, 'avatar-fp-held');
  fpHeld.frustumCulled = false;
  fpHeld.renderOrder = FP_RENDER_ORDER;
  fpHeld.matrixAutoUpdate = false;
  held.visible = false;
  fpHeld.visible = false;
  /** @type {string|null} */
  let heldKey = null;
  /** @type {HeldStyle} */
  let heldStyle = 'tool';

  const leanQ = new THREE.Quaternion();
  /** Hang the item meshes in the current avatar's fists, held as their style says; the fist grips or opens. */
  function placeHeld() {
    const grip = current.rig.grip;
    current.arms[1].elbow.add(held);
    const pose = HELD_POSE[heldStyle];
    held.position.set(grip[0], grip[1], grip[2] - pose.ahead);
    held.rotation.set(pose.tip - Math.PI / 2, pose.spin - Math.PI / 2, 0);
    held.quaternion.premultiply(leanQ.setFromAxisAngle(Y_AXIS, pose.lean));
    if (current.fp) {
      const fp = current.fp;
      fp.hand.add(fpHeld);
      fpHeld.matrix.fromArray(Array.from(heldStyle === 'tool' ? current.assets.model.fp.tool : current.assets.model.fp.lump));
      fpHeld.matrixWorldNeedsUpdate = true;
      fp.fist.geometry = heldKey ? current.assets.fp.grip : current.assets.fp.relaxed;
    }
  }
  placeHeld();

  /** @param {string|null} key */
  function setHeld(key) {
    const k = heldItemShown(key) ? /** @type {string} */ (key) : null;
    if (k === heldKey) return;
    heldKey = k;
    if (k) {
      let e = heldCache.get(k);
      if (!e) {
        const slab = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry(k));
        e = { geometry: heldGeometry(slab), style: slab.style };
        heldCache.set(k, e);
      }
      held.geometry = e.geometry;
      fpHeld.geometry = e.geometry;
      heldStyle = e.style;
    }
    placeHeld();
    held.visible = !!k;
    fpHeld.visible = !!k;
  }

  function setAvatar(id) {
    const next = figure(avatarById(id).id);
    if (next === current) return;
    current.root.visible = false;
    if (current.fp) current.fp.root.visible = false;
    current = next;
    if (armShown) fpOf(current);
    placeHeld();
  }

  /** whether the first-person hand has been asked for (the player's own renderer; never a remote player's) */
  let armShown = false;
  const tmpM = new THREE.Matrix4();
  const bobM = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  /** the last stroke placed (rest frames are reused), and whether the hand was empty */
  let lastStroke = -1;
  let lastEmpty = false;
  /** @type {ReturnType<typeof fpHandFrame>} */
  let frame = fpHandFrame(0);

  /** Place a figure's hand for a stroke and a bob (camera space). @param {Figure} f */
  function placeFp(f, stroke, bobX, bobY) {
    if (!f.fp) return;
    const empty = heldKey === null;
    if (stroke !== lastStroke || empty !== lastEmpty) {
      frame = fpHandFrame(stroke, empty);
      lastStroke = stroke;
      lastEmpty = empty;
    }
    bobM.makeTranslation(bobX * FP_HAND.bob, bobY * FP_HAND.bob, 0);
    f.fp.root.matrix.multiplyMatrices(bobM, tmpM.fromArray(/** @type {*} */ (frame.arm)));
    f.fp.root.matrixWorldNeedsUpdate = true;
    f.fp.hand.matrix.fromArray(/** @type {*} */ (frame.wrist));
    f.fp.hand.matrixWorldNeedsUpdate = true;
  }

  /** @param {AvatarFrame} f */
  function sync(f) {
    const m = current;
    const p = f.pose;
    const rig = m.rig;
    const def = m.def;
    // ---- the model
    m.root.visible = !!f.showModel;
    if (f.showModel) {
      m.root.position.set(f.x, f.y, f.z);
      m.root.rotation.y = p.bodyYaw;
      const standHip = rig.hipY - p.hipDrop;
      // on its back the hips are as high as the back of its head (or its hair) is deep: the hair is a pillow
      const lieHip = rig.lieY + LIE_LIFT;
      m.body.position.y = standHip + (RIDE_HIP_Y - standHip) * p.ride + (lieHip - standHip) * p.lie;
      m.body.rotation.x = p.bodyPitch;
      const maxLeg = def.outfit.skirt ? SKIRT_LEG_SWING : Infinity;
      const swing = Math.max(-maxLeg, Math.min(maxLeg, p.legSwing));
      // a positive turn about x swings a hanging limb forward; about z, out to the model's right
      m.legs[0].rotation.set(p.legRaise - swing, 0, -p.legSpread);
      m.legs[1].rotation.set(p.legRaise + swing, 0, p.legSpread);
      m.torso.rotation.set(p.lean, p.twist, 0);
      m.torso.position.y = p.chestLift;
      const [left, right] = m.arms;
      left.shoulder.rotation.set(-p.armSwing + p.armReach, 0, -p.armSpread);
      right.shoulder.rotation.set(p.armSwing + p.armReach + p.reachR, p.twistR, p.armSpread);
      left.elbow.rotation.x = p.elbow;
      right.elbow.rotation.x = p.elbow + 0.15 * Math.min(1, p.reachR);
      const nod = p.headPitch - p.lean * 0.8;
      const turn = p.headYaw - p.twist;
      m.neck.rotation.set(nod, turn, 0);
      if (m.hairBack) {
        m.hairBack.rotation.set(Math.min(0, nod) * HAIR_BACK_FOLLOW.pitchDown, turn * HAIR_BACK_FOLLOW.yaw, 0);
        m.hairBack.scale.z = 1 - 0.75 * p.lie; // pressed flat under her, lying down
      }
    }
    // ---- the first-person hand, hung from the camera
    if (f.showArm) armShown = true;
    const show = !!f.showArm && !!f.camera;
    if (show) fpOf(m);
    if (m.fp) m.fp.root.visible = show;
    if (show && f.camera && m.fp) {
      const cam = f.camera;
      cam.updateMatrixWorld();
      armGroup.matrix.copy(cam.matrixWorld);
      armGroup.matrixWorldNeedsUpdate = true;
      placeFp(m, fpStroke(p.fpSwing), p.fpBobX, p.fpBobY);
      camPos.setFromMatrixPosition(cam.matrixWorld);
      eye.value.set(f.eyeX ?? camPos.x, f.eyeY ?? camPos.y, f.eyeZ ?? camPos.z);
    }
  }

  function dispose() {
    scene.remove(group);
    scene.remove(armGroup);
    for (const e of heldCache.values()) e.geometry.dispose();
    heldCache.clear();
    noHeld.dispose();
    heldMaterial.dispose();
    fpHeldMaterial.dispose();
    for (const m of fpMaterials) m.dispose();
    // the avatars' geometries, atlases and model materials are shared (avatarAssets): they stay for the next renderer
  }

  /**
   * Compile the model's, the hand's and the held item's programs while the game loads (prewarm.compileHidden): the
   * current avatar's model and hand are built for it if they were not yet.
   */
  const prewarm = (webgl, camera) => {
    fpOf(current);
    placeHeld();
    return compileHidden([group, armGroup], webgl, camera, scene);
  };

  return {
    setAvatar, avatarId: () => current.def.id, setHeld, heldKey: () => heldKey, sync, group, armGroup, prewarm, dispose,
  };
}

// ---------------------------------------------------------------------------------------------------
// The chooser's portraits: each avatar drawn once with the game's renderer, head and shoulders, a little turned
// ---------------------------------------------------------------------------------------------------

/** The portraits' size (pixels; drawn at twice that and averaged down) and how they are framed. */
export const PORTRAIT = Object.freeze({ size: 192, fov: 20, turn: 0.38, distance: 2.05, below: 0.29, look: 0.08 });

/**
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Picture  RGBA, sRGB bytes, not premultiplied, row 0
 *   at the top
 */

/** A linear 0..1 value as an sRGB byte. */
function linearToSrgbByte(v) {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Draw each avatar's head and shoulders, a little turned to its left, lit by a warm sun from the front and a soft sky,
 * on a clear background — with the game's own renderer, into a render target (the world's light volume reads open sky
 * there: the figures stand above the world), then averaged down 2 × 2 and made sRGB.
 * @param {*} webgl  the THREE.WebGLRenderer (or a fake with setRenderTarget, render, readRenderTargetPixels, clear)
 * @param {{ size?: number, ids?: ReadonlyArray<string> }} [o]
 * @returns {Record<string, Picture>}
 */
export function renderAvatarPortraits(webgl, { size = PORTRAIT.size, ids = AVATAR_IDS } = {}) {
  const S = size * 2;
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(1, 0.95, 0.86, THREE.SRGBColorSpace), 2.4);
  sun.position.set(-1.1, 1.6, -2.2);
  const sky = new THREE.HemisphereLight(new THREE.Color().setRGB(0.8, 0.88, 1, THREE.SRGBColorSpace), new THREE.Color().setRGB(0.55, 0.5, 0.42, THREE.SRGBColorSpace), 1.5);
  scene.add(sun, sky);
  const r = createAvatarRenderer(scene);
  const camera = new THREE.PerspectiveCamera(PORTRAIT.fov, 1, 0.1, 50);
  const target = new THREE.WebGLRenderTarget(S, S, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true });
  const pixels = new Uint8Array(S * S * 4);
  const base = WORLD_HEIGHT + 32; // above the world: the light volume reads open sky
  const motion = new AvatarMotion();
  motion.reset(PORTRAIT.turn);
  const pose = motion.step(0, { yaw: PORTRAIT.turn, pitch: 0, vx: 0, vz: 0, onGround: true });
  const prevTarget = typeof webgl.getRenderTarget === 'function' ? webgl.getRenderTarget() : null;
  const prevColor = new THREE.Color();
  if (typeof webgl.getClearColor === 'function') webgl.getClearColor(prevColor);
  const prevAlpha = typeof webgl.getClearAlpha === 'function' ? webgl.getClearAlpha() : 1;
  /** @type {Record<string, Picture>} */
  const out = {};
  try {
    for (const id of ids) {
      const def = avatarById(id);
      r.setAvatar(def.id);
      r.sync({ x: 0, y: base, z: 0, pose, showModel: true, showArm: false });
      const top = base + avatarModel(def).rig.height;
      const at = new THREE.Vector3(0, top - PORTRAIT.below, 0);
      camera.position.set(Math.sin(PORTRAIT.look) * PORTRAIT.distance, at.y + 0.04, -Math.cos(PORTRAIT.look) * PORTRAIT.distance);
      camera.lookAt(at);
      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      webgl.setRenderTarget(target);
      webgl.setClearColor(0x000000, 0);
      webgl.clear(true, true, false);
      webgl.render(scene, camera);
      webgl.readRenderTargetPixels(target, 0, 0, S, S, pixels);
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let rr = 0;
          let gg = 0;
          let bb = 0;
          let aa = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              // the target's rows run bottom-up
              const i = ((S - 1 - (y * 2 + dy)) * S + x * 2 + dx) * 4;
              const a = pixels[i + 3] / 255;
              rr += (pixels[i] / 255) * a;
              gg += (pixels[i + 1] / 255) * a;
              bb += (pixels[i + 2] / 255) * a;
              aa += a;
            }
          }
          const o = (y * size + x) * 4;
          if (aa > 0) {
            data[o] = linearToSrgbByte(rr / aa);
            data[o + 1] = linearToSrgbByte(gg / aa);
            data[o + 2] = linearToSrgbByte(bb / aa);
          }
          data[o + 3] = Math.round((aa / 4) * 255);
        }
      }
      out[def.id] = { width: size, height: size, data };
    }
  } finally {
    webgl.setRenderTarget(prevTarget);
    if (typeof webgl.setClearColor === 'function') webgl.setClearColor(prevColor, prevAlpha);
    r.dispose();
    target.dispose();
    sun.dispose();
    sky.dispose();
  }
  return out;
}
