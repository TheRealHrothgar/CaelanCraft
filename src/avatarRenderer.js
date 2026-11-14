// Caelancraft — the player's avatar (three). See src/CONTRACTS.md §91.
//
// Two drawings of one avatar, both made of the plain skinned boxes avatarSkin.js paints (the zombies' way):
//   - the MODEL, seen in the third-person views: legs from the hips, a skirt on a dress, a torso (waist, chest and a
//     long-hair panel) that leans, arms with elbows from the shoulders, a head with its hair layer and tufts that turns
//     and nods. AvatarMotion (pure) gives the angles every frame. Origin at the feet; it faces −Z, turned by the body's yaw.
//   - the first-person ARM: the right upper arm and forearm (sleeve and hand) at the lower right of the view. It is placed
//     in camera space every frame and drawn in the main pass with its depth squeezed into the nearest FP_DEPTH of the
//     depth range, so it is always in front of the world but still hides its own far side; it is lit from the light
//     volume at the EYE (sky and block light, like the animals) and by the sun, moon, sky and campfire lights.
// Every avatar's model and arm are built at once (a few boxes each) over ONE texture; setAvatar shows one of them.
// Both materials are lit Lambert materials, so the light volume (lightShader.js, CONTRACTS §62) darkens the avatar in a
// cave and a torch lights it.
import * as THREE from 'three';
import { AVATAR_TEXEL } from './config.js';
import { AVATARS, avatarById } from './avatars.js';
import { paintAvatarSheet, avatarRig, faceRect, SHEET_W, PAGE_H } from './avatarSkin.js';
import { LIGHT_VOLUME_VERTEX_MAIN, patchObjectShader } from './lightShader.js';
import { compileHidden } from './prewarm.js';

/** @typedef {import('./avatars.js').AvatarDef} AvatarDef */
/** @typedef {import('./avatarMotion.js').AvatarPose} AvatarPose */
/** @typedef {import('./avatarSkin.js').PartRect} PartRect */

const T = AVATAR_TEXEL;

/** The first-person arm's depth is squeezed into this share of the depth range, in front of everything else. */
export const FP_DEPTH = 0.02;
/** The first-person arm draws after every other opaque thing. */
export const FP_RENDER_ORDER = 10;
/**
 * Where the first-person arm hangs in camera space (x right, y up, −z ahead; metres) and how it is held: its shoulder
 * `at`, turned `reach` forward (π/2 points straight ahead), `inward` toward the middle of the view, the elbow bent `bend`.
 */
export const FP_ARM = Object.freeze({ at: Object.freeze([0.45, -0.25, -0.32]), reach: 1.6, inward: -0.22, roll: 0, bend: 0.06 });
/** How far a dress lets the legs swing (its skirt would open otherwise). */
export const SKIRT_LEG_SWING = 0.42;
/** Lying down, the body rests this far over the ground; on a horse, the hips are this high over the saddle (m). */
export const LIE_LIFT = 0.01;
export const RIDE_HIP_Y = 0.1;

/** three's BoxGeometry faces in its order (+x, −x, +y, −y, +z, −z), as the skin names them (the model faces −Z). */
const BOX_FACES = /** @type {const} */ (['right', 'left', 'top', 'bottom', 'back', 'front']);
/** UVs stop this far (texels) inside each face, so a neighbouring face's texels never bleed in. */
const UV_INSET = 0.02;

/**
 * One skinned box: a part's box with each side mapped to its unwrap on `page` of the sheet, centred at (x, y, z) after
 * turning `rx` about x and `rz` about z (metres, radians).
 * @param {PartRect} rect
 * @param {number} page
 * @param {number} sheetH  the sheet's height (texels)
 * @param {{ x?: number, y?: number, z?: number, rx?: number, rz?: number }} [at]
 * @returns {THREE.BufferGeometry}
 */
export function avatarBox(rect, page, sheetH, { x = 0, y = 0, z = 0, rx = 0, rz = 0 } = {}) {
  const g = new THREE.BoxGeometry(rect.w * T, rect.h * T, rect.d * T);
  const uv = g.getAttribute('uv');
  for (let face = 0; face < 6; face++) {
    const r = faceRect(rect, BOX_FACES[face]);
    for (let i = face * 4; i < face * 4 + 4; i++) {
      const u = UV_INSET + uv.getX(i) * (r.w - 2 * UV_INSET);
      const v = UV_INSET + (1 - uv.getY(i)) * (r.h - 2 * UV_INSET);
      uv.setXY(i, (r.x + u) / SHEET_W, (page * PAGE_H + r.y + v) / sheetH);
    }
  }
  if (rx || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, 0, rz)));
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
 * An avatar's geometries, in the frames of its joints (metres): `leg` hangs from its hip, `upperArm` from its shoulder,
 * `foreArm` from its elbow, `torso` (waist, chest, the long-hair panel) stands on the hips, `head` (head, hair layer,
 * tufts) on the neck, `skirt` (a dress) hangs from the hips.
 * @param {AvatarDef} def
 * @param {{ page: number, layout: Record<string, PartRect> }} pg
 * @param {number} sheetH
 */
export function avatarGeometries(def, pg, sheetH) {
  const g = avatarRig(def);
  const b = def.body;
  const L = pg.layout;
  const box = (part, at) => avatarBox(L[part], pg.page, sheetH, at);
  const torso = [
    box('waist', { y: (b.waist.h / 2) * T }),
    box('chest', { y: (b.waist.h + b.chest.h / 2) * T }),
  ];
  if (g.back) torso.push(box('back', { y: g.back.y * T, z: g.back.z * T }));
  const head = [box('head', { y: (b.head.h / 2) * T }), box('hair', { y: g.hairY * T })];
  g.tufts.forEach((t, i) => head.push(box(`tuft${i}`, { x: t.x * T, y: t.y * T, z: t.z * T, rx: t.rx, rz: t.rz })));
  return {
    leg: box('leg', { y: (-b.leg.h / 2) * T }),
    // the upper arm's top is level with the chest's: its pivot is half an arm's width under it
    upperArm: box('upperArm', { y: (b.upperArm.w / 2 - b.upperArm.h / 2) * T }),
    foreArm: box('foreArm', { y: (-b.foreArm.h / 2) * T }),
    torso: mergeGeos(torso),
    head: mergeGeos(head),
    skirt: g.skirt ? box('skirt', { y: g.skirt.y * T }) : null,
  };
}

/** The sheet as a pixel-art texture (nearest filtering, no mipmaps, sRGB). */
function sheetTexture(sheet) {
  const tex = new THREE.DataTexture(sheet.data, sheet.width, sheet.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The first-person arm's material: lit like the objects (lightShader's patch), but from the light volume at the eye
 * (`caelArmEye`), with its depth squeezed to the front of the range.
 * @param {THREE.Texture} map
 * @param {{ value: THREE.Vector3 }} eye
 */
function armMaterial(map, eye) {
  const m = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5 });
  m.onBeforeCompile = (shader) => {
    patchObjectShader(/** @type {*} */ (shader));
    shader.uniforms.caelArmEye = eye;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 caelArmEye;')
      .replace(LIGHT_VOLUME_VERTEX_MAIN, `${LIGHT_VOLUME_VERTEX_MAIN}
vCaelLight = caelVolumeLevels( caelArmEye );
gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
  };
  m.customProgramCacheKey = () => 'caelancraft-avatar-arm';
  return m;
}

/**
 * @typedef {Object} AvatarFrame  what sync draws this frame
 * @property {number} x  the feet (world)
 * @property {number} y
 * @property {number} z
 * @property {AvatarPose} pose
 * @property {boolean} showModel   draw the model (the third-person views)
 * @property {boolean} showArm     draw the first-person arm
 * @property {THREE.Camera} [camera]  the camera the arm hangs from (its position and rotation set for this frame)
 * @property {number} [eyeX]       where the arm's light is read (default: the camera)
 * @property {number} [eyeY]
 * @property {number} [eyeZ]
 */

/**
 * @typedef {Object} AvatarRenderer
 * @property {(id: string) => void} setAvatar   show this avatar (an unknown id shows the default one)
 * @property {() => string} avatarId
 * @property {(frame: AvatarFrame) => void} sync
 * @property {THREE.Group} group      the models
 * @property {THREE.Group} armGroup   the first-person arms (placed in camera space)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm
 * @property {() => void} dispose
 */

/**
 * @param {THREE.Scene} scene
 * @returns {AvatarRenderer}
 */
export function createAvatarRenderer(scene) {
  const sheet = paintAvatarSheet();
  const map = sheetTexture(sheet);
  const material = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5 });
  const eye = { value: new THREE.Vector3() };
  const fpMaterial = armMaterial(map, eye);
  const group = new THREE.Group();
  group.name = 'avatars';
  const armGroup = new THREE.Group();
  armGroup.name = 'avatar-arm';
  armGroup.matrixAutoUpdate = false;
  /** @type {THREE.BufferGeometry[]} */
  const geometries = [];

  const mesh = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    return m;
  };

  /** The elbow, under the shoulder's pivot (which is half an arm's width under the top of the upper arm). */
  const elbowY = (def) => (def.body.upperArm.w / 2 - def.body.upperArm.h) * T;

  /** One avatar's model and arm. */
  function build(def) {
    const pg = sheet.pages[def.id];
    const geo = avatarGeometries(def, pg, sheet.height);
    for (const g of Object.values(geo)) if (g) geometries.push(g);
    const g = avatarRig(def);
    const root = new THREE.Group();
    root.name = `avatar-${def.id}`;
    root.visible = false;
    const body = new THREE.Group(); // the hips
    root.add(body);
    const legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.set(side * g.legX * T, 0, 0);
      hip.add(mesh(geo.leg, material, `avatar-leg-${def.id}`));
      body.add(hip);
      return hip;
    });
    if (geo.skirt) body.add(mesh(geo.skirt, material, `avatar-skirt-${def.id}`));
    const torso = new THREE.Group();
    torso.rotation.order = 'YXZ';
    torso.add(mesh(geo.torso, material, `avatar-torso-${def.id}`));
    body.add(torso);
    const arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.rotation.order = 'YXZ';
      shoulder.position.set(side * g.shoulderX * T, g.shoulderY * T, 0);
      shoulder.add(mesh(geo.upperArm, material, `avatar-upper-arm-${def.id}`));
      const elbow = new THREE.Group();
      elbow.position.y = elbowY(def);
      elbow.add(mesh(geo.foreArm, material, `avatar-forearm-${def.id}`));
      shoulder.add(elbow);
      torso.add(shoulder);
      return { shoulder, elbow };
    });
    const neck = new THREE.Group();
    neck.rotation.order = 'YXZ';
    neck.position.y = g.neckY * T;
    neck.add(mesh(geo.head, material, `avatar-head-${def.id}`));
    torso.add(neck);
    group.add(root);

    // the first-person arm: the same upper arm and forearm with the arm material
    const fp = new THREE.Group();
    fp.name = `avatar-arm-${def.id}`;
    fp.visible = false;
    const fpShoulder = new THREE.Group();
    fpShoulder.rotation.order = 'YXZ';
    const fpUpper = mesh(geo.upperArm, fpMaterial, `avatar-fp-upper-arm-${def.id}`);
    const fpElbow = new THREE.Group();
    fpElbow.position.y = elbowY(def);
    const fpFore = mesh(geo.foreArm, fpMaterial, `avatar-fp-forearm-${def.id}`);
    for (const m of [fpUpper, fpFore]) {
      m.frustumCulled = false;
      m.renderOrder = FP_RENDER_ORDER;
    }
    fpShoulder.add(fpUpper);
    fpElbow.add(fpFore);
    fpShoulder.add(fpElbow);
    fp.add(fpShoulder);
    armGroup.add(fp);
    return { def, rig: g, root, body, legs, torso, arms, neck, fp, fpShoulder, fpElbow };
  }

  const models = new Map(AVATARS.map((def) => [def.id, build(def)]));
  scene.add(group);
  scene.add(armGroup);
  let current = /** @type {ReturnType<typeof build>} */ (models.get(avatarById('').id));

  function setAvatar(id) {
    const next = models.get(avatarById(id).id);
    if (!next || next === current) return;
    current.root.visible = false;
    current.fp.visible = false;
    current = next;
  }

  const camM = new THREE.Matrix4();
  const offM = new THREE.Matrix4();
  const camPos = new THREE.Vector3();

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
      const standHip = rig.hipY * T - p.hipDrop;
      // on its back the hips are as high as half the head (or the back with its long hair) is deep: the hair is a pillow
      const lieHip = (Math.max(def.body.head.d, def.body.chest.d + 2 * (def.hair.back?.d ?? 0)) / 2) * T + LIE_LIFT;
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
      m.neck.rotation.set(p.headPitch - p.lean * 0.8, p.headYaw - p.twist, 0);
    }
    // ---- the first-person arm, hung from the camera
    m.fp.visible = !!f.showArm && !!f.camera;
    if (m.fp.visible && f.camera) {
      const cam = f.camera;
      cam.updateMatrixWorld();
      camM.copy(cam.matrixWorld);
      const s = p.fpSwing >= 0 ? Math.sin(Math.PI * p.fpSwing) : 0;
      const s2 = p.fpSwing >= 0 ? Math.sin(2 * Math.PI * p.fpSwing) : 0;
      offM.makeTranslation(
        FP_ARM.at[0] + p.fpBobX - 0.12 * s,
        FP_ARM.at[1] + p.fpBobY + 0.05 * s2,
        FP_ARM.at[2] - 0.1 * s,
      );
      armGroup.matrix.multiplyMatrices(camM, offM);
      armGroup.matrixWorldNeedsUpdate = true;
      m.fpShoulder.rotation.set(FP_ARM.reach + 0.45 * s, FP_ARM.inward + 0.35 * s, FP_ARM.roll);
      m.fpElbow.rotation.x = FP_ARM.bend + 0.2 * s;
      camPos.setFromMatrixPosition(camM);
      eye.value.set(f.eyeX ?? camPos.x, f.eyeY ?? camPos.y, f.eyeZ ?? camPos.z);
    }
  }

  function dispose() {
    scene.remove(group);
    scene.remove(armGroup);
    for (const g of geometries) g.dispose();
    material.dispose();
    fpMaterial.dispose();
    map.dispose();
  }

  /** Compile the model's and the arm's programs while the game loads (prewarm.compileHidden). */
  const prewarm = (webgl, camera) => compileHidden([group, armGroup], webgl, camera, scene);

  return { setAvatar, avatarId: () => current.def.id, sync, group, armGroup, prewarm, dispose };
}
