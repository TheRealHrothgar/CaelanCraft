// avatarRenderer.js (three, Node: core objects only) and avatarMenu.js (fake DOM from index.html). CONTRACTS §91, §98.4.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  createAvatarRenderer, renderAvatarPortraits, avatarAssets, avatarAssetCount, patchAvatarShader, FP_DEPTH, FP_RENDER_ORDER,
  SKIRT_LEG_SWING, AVATAR_FILL, AVATAR_PROGRAM, FP_ARM_PROGRAM, FP_HELD_PROGRAM, PORTRAIT,
} from '../../src/avatarRenderer.js';
import { AvatarMotion } from '../../src/avatarMotion.js';
import { AVATARS, avatarHeight } from '../../src/avatars.js';
import { avatarModel, fpHandFrame } from '../../src/avatarModel.js';
import { createAvatarMenu, avatarButtonLabel, INERT_BENEATH } from '../../src/avatarMenu.js';
import { createRemotePlayerRenderer } from '../../src/remotePlayerRenderer.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

/** The world box of everything visible under `root`. */
function boundsOf(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    let shown = true;
    for (let p = o.parent; p; p = p.parent) if (!p.visible) shown = false;
    if (!shown) return;
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox.isEmpty()) return;
    box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
  });
  return box;
}
const pose = (over = {}) => Object.assign(new AvatarMotion().step(0, { yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true }), over);
/** A lambert program's shader, through a material's onBeforeCompile. */
function compiled(mat) {
  const lambert = THREE.ShaderLib.lambert;
  const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} };
  mat.onBeforeCompile(shader, null);
  return shader;
}
const model = (r, id) => r.group.children.find((c) => c.name === `avatar-${id}`);
/** A first-person camera at an odd angle. */
function fpCamera() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 10, 0.1, 1000);
  camera.rotation.order = 'YXZ';
  camera.position.set(5, 70, 5);
  camera.rotation.set(-0.2, 1.1, 0);
  return camera;
}

describe('the avatar model (three)', () => {
  it('models are built when first shown; one is shown at a time; the default is Caelan', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    expect(scene.children).toContain(r.group);
    expect(scene.children).toContain(r.armGroup);
    expect(r.group.children.map((c) => c.name)).toEqual(['avatar-caelan']);
    expect(r.avatarId()).toBe('caelan');
    r.sync({ x: 1, y: 64, z: 2, pose: pose(), showModel: true, showArm: false });
    expect(r.group.children.filter((c) => c.visible).map((c) => c.name)).toEqual(['avatar-caelan']);
    r.setAvatar('annabelle');
    r.sync({ x: 1, y: 64, z: 2, pose: pose(), showModel: true, showArm: false });
    expect(r.group.children.filter((c) => c.visible).map((c) => c.name)).toEqual(['avatar-annabelle']);
    r.setAvatar('nobody'); // unknown: the default one
    expect(r.avatarId()).toBe('caelan');
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: false });
    expect(r.group.children.every((c) => !c.visible)).toBe(true);
    r.dispose();
    expect(scene.children).not.toContain(r.group);
  });

  it('hangs one mesh per bone from today\'s joints: hips, legs, torso, shoulders, elbows, neck (and long back hair)', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    for (const def of AVATARS) {
      r.setAvatar(def.id);
      const root = model(r, def.id);
      const meshes = [];
      root.traverse((o) => { if (o.isMesh && !o.name.includes('held')) meshes.push(`${o.parent.name}>${o.name.replace(`-${def.id}`, '')}`); });
      expect(meshes.sort(), def.id).toEqual([
        'avatar-elbow-l>avatar-forearm', 'avatar-elbow-r>avatar-forearm', 'avatar-hip-l>avatar-leg', 'avatar-hip-r>avatar-leg',
        'avatar-hips>avatar-hips', 'avatar-neck>avatar-head', 'avatar-shoulder-l>avatar-upper-arm', 'avatar-shoulder-r>avatar-upper-arm',
        'avatar-torso>avatar-torso', ...(def.id === 'annabelle' ? ['avatar-hair-back>avatar-hair-back'] : []),
      ].sort());
      // the joints: the arms and the head hang from the torso, the torso and the legs from the hips
      const names = (o) => o.children.map((c) => c.name);
      const hips = root.getObjectByName('avatar-hips');
      expect(names(hips)).toEqual(expect.arrayContaining(['avatar-hip-l', 'avatar-hip-r', 'avatar-torso']));
      expect(names(root.getObjectByName('avatar-torso'))).toEqual(expect.arrayContaining(['avatar-shoulder-l', 'avatar-shoulder-r', 'avatar-neck']));
      const rig = avatarModel(def).rig;
      expect(root.getObjectByName('avatar-shoulder-r').position.toArray()).toEqual(rig.shoulder);
      expect(root.getObjectByName('avatar-neck').position.toArray()).toEqual(rig.head);
    }
    r.dispose();
  });

  it('stands at the feet, as tall as the avatar, facing −Z, turned by the body\'s yaw', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    for (const def of AVATARS) {
      r.setAvatar(def.id);
      r.sync({ x: 10, y: 64, z: -5, pose: pose(), showModel: true, showArm: false });
      const b = boundsOf(r.group);
      expect(b.min.y, def.id).toBeCloseTo(64, 2);
      expect(b.max.y - 64, def.id).toBeGreaterThan(avatarHeight(def) - 0.02);
      expect(b.max.y - 64, def.id).toBeLessThan(avatarHeight(def) + 0.03);
      expect(b.max.x - b.min.x, def.id).toBeLessThan(0.9);
      // the face is at the front (−z): the nose is the frontmost point of the head
      const head = boundsOf(model(r, def.id).getObjectByName('avatar-neck'));
      expect(head.min.z - -5, def.id).toBeLessThan(-0.12);
    }
    r.setAvatar('brayden');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ bodyYaw: Math.PI / 2 }), showModel: true, showArm: false });
    expect(model(r, 'brayden').rotation.y).toBeCloseTo(Math.PI / 2, 9);
    r.dispose();
  });

  it('a dress keeps the legs inside its skirt; lying down puts the body flat; long hair follows a turn of the head only part way', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    r.setAvatar('annabelle');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ legSwing: 1.2 }), showModel: true, showArm: false });
    const ann = model(r, 'annabelle');
    expect(Math.abs(ann.getObjectByName('avatar-hip-r').rotation.x)).toBeCloseTo(SKIRT_LEG_SWING, 9);
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ headYaw: 0.8, headPitch: 0.5 }), showModel: true, showArm: false });
    expect(ann.getObjectByName('avatar-hair-back').rotation.y).toBeGreaterThan(0);
    expect(ann.getObjectByName('avatar-hair-back').rotation.y).toBeLessThan(ann.getObjectByName('avatar-neck').rotation.y);
    expect(ann.getObjectByName('avatar-hair-back').rotation.x).toBe(0); // looking up never swings it into her back
    r.setAvatar('caelan');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ legSwing: 0.7 }), showModel: true, showArm: false });
    const c = model(r, 'caelan');
    expect([c.getObjectByName('avatar-hip-l').rotation.x, c.getObjectByName('avatar-hip-r').rotation.x]).toEqual([-0.7, 0.7]);
    for (const id of ['caelan', 'annabelle']) {
      r.setAvatar(id);
      r.sync({ x: 0, y: 0, z: 0, pose: pose({ bodyPitch: Math.PI / 2, lie: 1 }), showModel: true, showArm: false });
      const b = boundsOf(r.group);
      expect(b.max.y - b.min.y, id).toBeLessThan(0.6); // flat on its back …
      expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z), id).toBeGreaterThan(1.4); // … as long as it is tall
      expect(b.min.y, id).toBeGreaterThan(-0.1); // only the hair (and a skirt) sink in a little: a pillow
    }
    r.dispose();
  });

  it('builds each avatar\'s geometry and atlas once and shares them between renderers (the other players)', () => {
    const a = createAvatarRenderer(new THREE.Scene());
    const b = createAvatarRenderer(new THREE.Scene());
    a.setAvatar('brayden');
    b.setAvatar('brayden');
    const meshesOf = (r) => {
      const out = [];
      model(r, 'brayden').traverse((o) => { if (o.isMesh && !o.name.includes('held')) out.push(o); });
      return out;
    };
    const ma = meshesOf(a);
    const mb = meshesOf(b);
    expect(ma.length).toBe(mb.length);
    ma.forEach((m, i) => {
      expect(m).not.toBe(mb[i]);
      expect(m.geometry).toBe(mb[i].geometry);
      expect(m.material).toBe(mb[i].material);
    });
    const assets = avatarAssets(AVATARS[1]);
    expect(ma[0].material.map).toBe(assets.texture);
    const n = avatarAssetCount();
    const c = createAvatarRenderer(new THREE.Scene());
    c.setAvatar('brayden');
    expect(avatarAssetCount()).toBe(n); // nothing rebuilt
    // a renderer going away leaves the shared resources to the others
    let freed = false;
    ma[0].geometry.addEventListener('dispose', () => { freed = true; });
    a.dispose();
    expect(freed).toBe(false);
    b.dispose();
    c.dispose();
  });

  it('its atlas: linear filtering with mipmaps, sRGB; one material lit like every object, with a warm fill in proportion to the light', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    let mat = null;
    r.group.traverse((o) => { if (o.isMesh && o.name.startsWith('avatar-torso')) mat = o.material; });
    expect(mat.isMeshLambertMaterial).toBe(true);
    const tex = mat.map;
    expect([tex.magFilter, tex.minFilter, tex.generateMipmaps, tex.colorSpace]).toEqual([THREE.LinearFilter, THREE.LinearMipmapLinearFilter, true, THREE.SRGBColorSpace]);
    expect(mat.emissiveMap).toBe(null); // no glow
    expect(mat.emissive.getHex()).toBe(0);
    expect(mat.customProgramCacheKey()).toBe(AVATAR_PROGRAM);
    const shader = compiled(mat);
    // the light volume, as every lit object reads it (§62) …
    expect(shader.vertexShader).toContain('caelVolumeLevels');
    expect(shader.fragmentShader).toContain('caelExtra');
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['caelVol', 'caelVolInfo', 'caelDaylight']));
    // … and the fill: the sky's, the sun's and the block light times the cell's sky light, warm, through the albedo
    expect(shader.fragmentShader).toContain('caelSky * 0.5 * ( hemisphereLights[ i ].skyColor + hemisphereLights[ i ].groundColor )');
    expect(shader.fragmentShader).toContain('caelSky * directionalLights[ i ].color');
    expect(shader.fragmentShader).toContain('BRDF_Lambert( material.diffuseColor )');
    expect(shader.fragmentShader.indexOf('caelFill')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <lights_fragment_end>'));
    const [cr, cg, cb] = AVATAR_FILL.color;
    expect(cr).toBeGreaterThan(cg);
    expect(cg).toBeGreaterThan(cb); // warm
    expect(AVATAR_FILL.strength).toBeGreaterThan(0.05);
    expect(AVATAR_FILL.strength).toBeLessThan(0.3); // a fill, never a light of its own
    const s2 = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} };
    patchAvatarShader(s2);
    expect(s2.fragmentShader).toBe(shader.fragmentShader);
    r.dispose();
  });
});

describe('the first-person hand', () => {
  it('hangs from the camera at the lower right, in front of the camera, only when asked', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const camera = fpCamera();
    r.sync({ x: 5, y: 68.38, z: 5, pose: pose(), showModel: false, showArm: true, camera });
    const arm = r.armGroup.children.find((c) => c.visible);
    expect(arm && arm.name).toBe('avatar-arm-caelan');
    const names = [];
    arm.traverse((o) => { if (o.isMesh) names.push(o.name); });
    expect(names).toEqual(expect.arrayContaining(['avatar-fp-arm-caelan', 'avatar-fp-hand-caelan']));
    scene.updateMatrixWorld(true);
    const toCam = camera.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    arm.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox.isEmpty()) box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(toCam));
    });
    expect(box.max.z).toBeLessThan(-0.1);
    expect((box.min.x + box.max.x) / 2).toBeGreaterThan(0.1);
    expect((box.min.y + box.max.y) / 2).toBeLessThan(0);
    // small: smaller than today's arm (which reached 0.45 m out and 0.6 m long)
    expect(box.max.x - box.min.x).toBeLessThan(0.4);
    arm.traverse((o) => {
      if (o.isMesh) {
        expect(o.renderOrder).toBe(FP_RENDER_ORDER);
        expect(o.frustumCulled).toBe(false);
      }
    });
    r.sync({ x: 5, y: 68.38, z: 5, pose: pose(), showModel: true, showArm: false, camera });
    expect(r.armGroup.children.every((c) => !c.visible)).toBe(true);
    r.dispose();
  });

  it('chops from the wrist on fpSwing and bobs with the walk', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera();
    r.setHeld('iron_pick');
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera });
    const root = r.armGroup.children[0];
    const wrist = root.getObjectByName('avatar-fp-wrist');
    const restArm = root.matrix.clone();
    const restWrist = wrist.matrix.clone();
    expect(restArm.elements).toEqual(Array.from(fpHandFrame(0).arm).map((v) => expect.closeTo(v, 6))); // at rest: FP_HAND's frame
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ fpSwing: 0.3 }), showModel: false, showArm: true, camera });
    expect(wrist.matrix.equals(restWrist)).toBe(false); // the wrist bends …
    expect(root.matrix.equals(restArm)).toBe(false); // … and the forearm follows
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ fpBobX: 0.01, fpBobY: -0.02 }), showModel: false, showArm: true, camera });
    expect(root.matrix.elements[12]).toBeCloseTo(restArm.elements[12] + 0.01, 6);
    expect(root.matrix.elements[13]).toBeCloseTo(restArm.elements[13] - 0.02, 6);
    r.dispose();
  });

  it('its material is lit from the light volume at the eye, with the warm fill, and its depth is squeezed to the front', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera: new THREE.PerspectiveCamera() });
    let mat = null;
    r.armGroup.traverse((o) => { if (o.isMesh && o.name.startsWith('avatar-fp-hand')) mat = o.material; });
    const shader = compiled(mat);
    expect(shader.vertexShader).toContain('uniform vec3 caelArmEye;');
    expect(shader.vertexShader).toContain('vCaelLight = caelVolumeLevels( caelArmEye );');
    expect(shader.vertexShader).toContain(`gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
    expect(shader.fragmentShader).toContain('caelExtra');
    expect(shader.fragmentShader).toContain('caelFill');
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['caelArmEye', 'caelVol', 'caelVolInfo']));
    expect(mat.customProgramCacheKey()).toBe(FP_ARM_PROGRAM);
    expect(mat.map).toBe(avatarAssets(AVATARS[0]).texture); // the avatar's own atlas: its skin, its sleeve
    r.dispose();
  });

  it('grips when something is held, opens when nothing is', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera: new THREE.PerspectiveCamera() });
    const fist = r.armGroup.getObjectByName('avatar-fp-hand-caelan');
    const A = avatarAssets(AVATARS[0]);
    expect(fist.geometry).toBe(A.fp.relaxed);
    r.setHeld('iron_pick');
    expect(fist.geometry).toBe(A.fp.grip);
    r.setHeld(null);
    expect(fist.geometry).toBe(A.fp.relaxed);
    r.dispose();
  });
});

describe('the item in hand (setHeld)', () => {
  /** The model's held mesh and the first-person one. */
  function heldMeshes(r) {
    let held = null;
    let fp = null;
    r.group.traverse((o) => { if (o.name === 'avatar-held') held = o; });
    r.armGroup.traverse((o) => { if (o.name === 'avatar-fp-held') fp = o; });
    return { held, fp };
  }
  /** The name of the model or the hand (a child of the renderer's group or armGroup) the object hangs in. */
  function rootName(o) {
    let p = o;
    while (p.parent && p.parent.name !== 'avatars' && p.parent.name !== 'avatar-arm') p = p.parent;
    return p.name;
  }
  /** World box of one mesh. */
  function boxOf(o) {
    o.updateWorldMatrix(true, false);
    o.geometry.computeBoundingBox();
    return o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
  }
  /** A renderer whose first-person hand exists (the player's: it has been shown). */
  function playerRenderer() {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera: new THREE.PerspectiveCamera() });
    return { scene, r };
  }

  it('shows the item at the model\'s right fist\'s grip and in the first-person fist; null, a block item or an unknown key hides both', () => {
    const { r } = playerRenderer();
    const { held, fp } = heldMeshes(r);
    expect(held && fp).toBeTruthy();
    expect(held.visible || fp.visible).toBe(false); // nothing held at first
    expect(r.heldKey()).toBe(null);
    r.setHeld('iron_pick');
    expect(r.heldKey()).toBe('iron_pick');
    expect(held.visible && fp.visible).toBe(true);
    expect(held.geometry).toBe(fp.geometry);
    expect(held.geometry.getAttribute('position').count).toBeGreaterThan(100);
    expect(held.geometry.getAttribute('color').itemSize).toBe(3);
    expect(rootName(held)).toBe('avatar-caelan');
    expect(rootName(fp)).toBe('avatar-arm-caelan');
    // at the grip of the right fist (the forearm's frame), the pick held ahead of it at hand height
    expect(held.parent.name).toBe('avatar-elbow-r');
    expect(held.position.toArray()).toEqual(avatarModel(AVATARS[0]).rig.grip);
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: true, showArm: false });
    const b = boxOf(held);
    expect(b.min.x).toBeGreaterThan(0.1);
    expect((b.min.z + b.max.z) / 2).toBeLessThan(-0.1);
    expect(b.max.y).toBeGreaterThan(0.6);
    expect(b.min.y).toBeGreaterThan(0.25);
    // first person: in the fist's frame, its grip at the fist
    expect(fp.parent.name).toBe('avatar-fp-wrist');
    expect(fp.matrix.elements.slice(12, 15)).toEqual(Array.from(avatarModel(AVATARS[0]).fp.tool).slice(12, 15));
    for (const k of [null, 'stone', 'nonsense', '']) {
      r.setHeld('steel_sword');
      expect(held.visible && fp.visible).toBe(true);
      r.setHeld(k);
      expect(held.visible || fp.visible, String(k)).toBe(false);
      expect(r.heldKey()).toBe(null);
    }
    r.dispose();
  });

  it('follows setAvatar into the new model\'s fist; a lump is held up in front of it; one geometry per item, freed by dispose', () => {
    const { r } = playerRenderer();
    const { held, fp } = heldMeshes(r);
    r.setHeld('steel_sword');
    const sword = held.geometry;
    r.setAvatar('annabelle');
    expect(rootName(held)).toBe('avatar-annabelle');
    expect(rootName(fp)).toBe('avatar-arm-annabelle');
    expect(held.visible && fp.visible).toBe(true);
    expect(held.position.toArray()).toEqual(avatarModel(AVATARS[2]).rig.grip);
    expect(held.parent.parent.position.x).toBeGreaterThan(0); // the right shoulder
    r.setAvatar('brayden');
    r.setHeld('iron_pick');
    r.setHeld('honeyberries'); // a lump: in front of the fist, upright
    expect(held.position.z).toBeLessThan(avatarModel(AVATARS[1]).rig.grip[2]);
    expect(fp.matrix.elements.slice(12, 15)).toEqual(Array.from(avatarModel(AVATARS[1]).fp.lump).slice(12, 15));
    r.setHeld('steel_sword');
    expect(held.geometry).toBe(sword); // cached
    const freed = [];
    for (const k of ['steel_sword', 'iron_pick', 'honeyberries']) {
      r.setHeld(k);
      held.geometry.addEventListener('dispose', () => freed.push(k));
    }
    r.dispose();
    expect(freed.sort()).toEqual(['honeyberries', 'iron_pick', 'steel_sword']);
  });

  it('the swing carries it: hung from the forearm, it rises with the reach', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    const { held } = heldMeshes(r);
    r.setHeld('iron_pick');
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: true, showArm: false });
    const rest = boxOf(held);
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ reachR: 1.9 }), showModel: true, showArm: false });
    const up = boxOf(held);
    expect(up.max.y).toBeGreaterThan(rest.max.y + 0.4);
    r.dispose();
  });

  it('in first person it is drawn like the hand: in front of the camera, lit at the eye, depth squeezed, never culled', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    r.setHeld('steel_sword');
    const camera = fpCamera();
    r.sync({ x: 5, y: 68.38, z: 5, pose: pose(), showModel: false, showArm: true, camera });
    const { fp, held } = heldMeshes(r);
    scene.updateMatrixWorld(true);
    const box = boxOf(fp).applyMatrix4(camera.matrixWorld.clone().invert());
    expect(box.max.z).toBeLessThan(-0.1); // ahead of the near plane
    expect(box.max.x).toBeGreaterThan(0); // at the right of the view …
    expect(box.max.y).toBeGreaterThan(box.min.y + 0.1); // … standing up out of the hand
    expect(fp.renderOrder).toBe(FP_RENDER_ORDER);
    expect(fp.frustumCulled).toBe(false);
    const mat = fp.material;
    expect(mat.vertexColors).toBe(true);
    expect(mat.map).toBe(null);
    const shader = compiled(mat);
    expect(shader.vertexShader).toContain('vCaelLight = caelVolumeLevels( caelArmEye );');
    expect(shader.vertexShader).toContain(`gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
    expect(shader.uniforms.caelArmEye.value.x).toBeCloseTo(5, 9); // the hand's eye
    expect(mat.customProgramCacheKey()).toBe(FP_HELD_PROGRAM);
    // the model's is a plain lit material with vertex colours (the prototype hook lights it)
    expect(held.material.isMeshLambertMaterial && held.material.vertexColors).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(held.material, 'onBeforeCompile')).toBe(false);
    r.dispose();
  });

  it('prewarm compiles the model\'s, the hand\'s and the held item\'s programs (with the attributes a real item has), and hides them again', async () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const seen = [];
    await r.prewarm({
      compileAsync(obj) {
        obj.traverse((o) => { if (o.isMesh) seen.push([o.name, o.visible, o.material.customProgramCacheKey()]); });
        return Promise.resolve();
      },
    }, new THREE.PerspectiveCamera());
    const { held, fp } = heldMeshes(r);
    for (const m of [held, fp]) expect(Object.keys(m.geometry.attributes).sort()).toEqual(['color', 'normal', 'position']);
    const keys = new Set(seen.map((s) => s[2]));
    expect(keys.has(AVATAR_PROGRAM) && keys.has(FP_ARM_PROGRAM) && keys.has(FP_HELD_PROGRAM)).toBe(true);
    expect(seen.filter((s) => /held/.test(s[0])).map((s) => s.slice(0, 2))).toEqual([['avatar-held', true], ['avatar-fp-held', true]]);
    expect(held.visible || fp.visible).toBe(false);
    expect(r.armGroup.children.every((c) => !c.visible)).toBe(true);
    r.dispose();
  });
});

describe('the other players (remotePlayerRenderer)', () => {
  it('draw the same hex-faceted models, sharing the geometry, with what they hold at the grip of their fist', () => {
    const scene = new THREE.Scene();
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) }; // a name tag with nothing drawn on it
    const remote = createRemotePlayerRenderer(scene, /** @type {*} */ (doc));
    const players = [
      { id: 1, name: 'Bo', avatar: 'brayden', swings: 0, held: 'iron_pick' },
      { id: 2, name: 'Al', avatar: 'annabelle', swings: 0, held: null },
    ];
    const remotes = {
      list: () => players,
      sample: (id) => ({ x: id * 3, y: 64, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, flags: 4 }),
    };
    remote.sync(/** @type {*} */ (remotes), 1, 0.016);
    expect(remote.count()).toBe(2);
    const roots = [];
    scene.traverse((o) => { if (/^avatar-(caelan|brayden|annabelle)$/.test(o.name) && o.visible) roots.push(o); });
    expect(roots.map((o) => o.name).sort()).toEqual(['avatar-annabelle', 'avatar-brayden']);
    const bo = /** @type {THREE.Object3D} */ (roots.find((o) => o.name === 'avatar-brayden'));
    const local = createAvatarRenderer(new THREE.Scene());
    local.setAvatar('brayden');
    const torso = (root) => /** @type {THREE.Mesh} */ (root.getObjectByName('avatar-torso-brayden'));
    expect(torso(bo).geometry).toBe(torso(model(local, 'brayden')).geometry); // one geometry for every Brayden
    const held = /** @type {THREE.Mesh} */ (bo.getObjectByName('avatar-held'));
    expect(held.visible).toBe(true);
    expect(held.position.toArray()).toEqual(avatarModel(AVATARS[1]).rig.grip);
    // no first-person hand is built for them
    let hands = 0;
    scene.traverse((o) => { if (o.name.startsWith('avatar-arm-')) hands++; });
    expect(hands).toBe(0);
    remote.clear();
    expect(remote.count()).toBe(0);
    local.dispose();
  });
});

describe('the portraits (renderAvatarPortraits)', () => {
  /** A renderer that "draws" a coloured square where the model is and keeps its state. */
  function fakeWebgl() {
    const state = { target: null, clear: [0x123456, 1], renders: [] };
    return {
      state,
      getRenderTarget: () => state.target,
      setRenderTarget(t) { state.target = t; },
      getClearColor(c) { return c.setHex(state.clear[0]); },
      getClearAlpha: () => state.clear[1],
      setClearColor(c, a) { state.clear = [typeof c === 'number' ? c : c.getHex(), a]; },
      clear() {},
      render(scene, camera) {
        const shown = [];
        scene.traverse((o) => { if (o.isMesh && o.visible && o.parent.visible) shown.push(o); });
        state.renders.push({ camera: camera.position.clone(), shown: shown.length });
      },
      readRenderTargetPixels(t, x, y, w, h, out) {
        // the middle quarter opaque, linear mid-grey; the rest clear
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const o = (j * w + i) * 4;
            const inside = i > w / 4 && i < (3 * w) / 4 && j > h / 4 && j < (3 * h) / 4;
            out.set(inside ? [55, 55, 55, 255] : [0, 0, 0, 0], o);
          }
        }
      },
    };
  }

  it('draws every avatar once, head and shoulders, on a clear background, and puts the renderer back as it was', () => {
    const webgl = fakeWebgl();
    const pics = renderAvatarPortraits(webgl, { size: 32 });
    expect(Object.keys(pics)).toEqual(AVATARS.map((a) => a.id));
    expect(webgl.state.renders).toHaveLength(3);
    for (const r of webgl.state.renders) {
      expect(r.shown).toBeGreaterThan(8); // the model's bones
      expect(r.camera.y).toBeGreaterThan(128); // above the world: open sky in the light volume
    }
    for (const p of Object.values(pics)) {
      expect([p.width, p.height, p.data.length]).toEqual([32, 32, 32 * 32 * 4]);
      expect(p.data[3]).toBe(0); // a corner: clear
      const mid = (16 * 32 + 16) * 4;
      expect(p.data[mid + 3]).toBe(255);
      expect(p.data[mid]).toBeGreaterThan(120); // linear 55/255 made sRGB
    }
    expect(webgl.state.target).toBe(null);
    expect(webgl.state.clear).toEqual([0x123456, 1]);
    expect(PORTRAIT.size).toBeGreaterThanOrEqual(120);
  });
});

describe('the Avatar chooser (avatarMenu.js)', () => {
  /** A portrait source: a small square per avatar. */
  const portrait = vi.fn((id) => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(id.length * 20) }));
  function setup(opts = {}) {
    const doc = documentFromHTML(html);
    const onChoose = vi.fn();
    const onView = vi.fn();
    const menu = createAvatarMenu(/** @type {*} */ (doc), { current: 'caelan', onChoose, onView, viewLabel: 'First person', portrait, ...opts });
    const $ = (id) => /** @type {*} */ (doc.getElementById(id));
    return { doc, menu, onChoose, onView, $ };
  }

  it('the title screen and the pause menu each have an Avatar button that names the chosen one, and a View button', () => {
    const { $ } = setup({ current: 'brayden' });
    expect($('btn-avatar-title').textContent).toBe('Avatar: Brayden');
    expect($('btn-avatar-pause').textContent).toBe('Avatar: Brayden');
    expect($('btn-view').textContent).toBe('View: First person');
    expect($('btn-avatar-title').parentNode.classList.contains('title-side')).toBe(true);
    expect($('btn-avatar-pause').parentNode.id).toBe('pause-you');
    expect(avatarButtonLabel('annabelle')).toBe('Avatar: Annabelle');
    // the Guide button stays right after the controls sheet (the Avatar button comes after it)
    const side = $('btn-guide-title').parentNode;
    expect(side.children.indexOf($('btn-avatar-title'))).toBe(side.children.indexOf($('btn-guide-title')) + 1);
  });

  it('opens from either button: a card per avatar on a rounded square with its portrait, the chosen one checked; the screens under it inert', () => {
    portrait.mockClear();
    const { $, menu } = setup();
    expect(portrait).not.toHaveBeenCalled(); // asked for only when the chooser first opens
    fire($('btn-avatar-title'), 'click');
    expect(menu.isOpen()).toBe(true);
    expect(portrait.mock.calls.map((c) => c[0])).toEqual(['caelan', 'brayden', 'annabelle']);
    const root = $('avatar-chooser');
    expect(root.classList.contains('hidden')).toBe(false);
    const cards = root.querySelectorAll('.av-card');
    expect(cards.map((c) => c.dataset.avatar)).toEqual(['caelan', 'brayden', 'annabelle']);
    expect(cards.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(cards.map((c) => c.querySelector('.av-name').textContent)).toEqual(['Caelan', 'Brayden', 'Annabelle']);
    for (const c of cards) {
      expect(c.classList.contains('hex-button')).toBe(false); // never a hexagon
      const canvas = c.querySelector('canvas');
      expect([canvas.width, canvas.height]).toEqual([4, 4]);
      const put = canvas.getContext('2d').calls.find(([n]) => n === 'putImageData');
      expect(put && put[1].data[0]).toBe(c.dataset.avatar.length * 20);
    }
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert')).toBe(true);
    menu.close();
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert')).toBe(false);
    fire($('btn-avatar-pause'), 'click');
    expect(menu.isOpen()).toBe(true);
    expect(portrait).toHaveBeenCalledTimes(3); // drawn once
  });

  it('opens without portraits too (none given, or one that fails)', () => {
    for (const opts of [{ portrait: undefined }, { portrait: () => { throw new Error('no GL'); } }]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { $, menu } = setup(opts);
      menu.open();
      const cards = $('avatar-chooser').querySelectorAll('.av-card');
      expect(cards).toHaveLength(3);
      for (const c of cards) expect(c.querySelector('canvas').getContext('2d').calls.some(([n]) => n === 'putImageData')).toBe(false);
      warn.mockRestore();
    }
  });

  it('a click chooses (once), the arrow keys move along the cards, Esc and Done close it', () => {
    const { $, menu, onChoose, doc } = setup();
    menu.open();
    const card = (id) => $('avatar-chooser').querySelectorAll('.av-card').find((c) => c.dataset.avatar === id);
    fire(card('annabelle'), 'click');
    expect(onChoose).toHaveBeenLastCalledWith('annabelle');
    expect(card('annabelle').classList.contains('chosen')).toBe(true);
    expect($('btn-avatar-pause').textContent).toBe('Avatar: Annabelle');
    fire(card('annabelle'), 'click');
    expect(onChoose).toHaveBeenCalledTimes(1); // the same one again: nothing to do
    doc.dispatch({ type: 'keydown', key: 'ArrowRight', code: 'ArrowRight' });
    expect(onChoose).toHaveBeenLastCalledWith('caelan'); // round to the first
    doc.dispatch({ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(menu.current()).toBe('annabelle');
    doc.dispatch({ type: 'keydown', key: 'Escape', code: 'Escape' });
    expect(menu.isOpen()).toBe(false);
    menu.open();
    fire($('avatar-chooser').querySelector('.av-done'), 'click');
    expect(menu.isOpen()).toBe(false);
    expect(menu.handleKey(/** @type {*} */ ({ key: 'Escape' }))).toBe(false); // closed: not its key
  });

  it('the View button reports clicks; setView and setCurrent keep the labels', () => {
    const { $, menu, onView } = setup();
    fire($('btn-view'), 'click');
    expect(onView).toHaveBeenCalledTimes(1);
    menu.setView('Front');
    expect($('btn-view').textContent).toBe('View: Front');
    menu.setCurrent('brayden');
    expect($('btn-avatar-title').textContent).toBe('Avatar: Brayden');
    menu.dispose();
    fire($('btn-view'), 'click');
    expect(onView).toHaveBeenCalledTimes(1);
  });
});
