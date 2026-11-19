// avatarRenderer.js (three, Node: core objects only) and avatarMenu.js (fake DOM from index.html). CONTRACTS §91, §98.4.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  createAvatarRenderer, renderAvatarPortraits, avatarAssets, avatarAssetCount, disposeAvatarAssets, patchAvatarShader, FP_DEPTH,
  FP_RENDER_ORDER, SKIRT_LEG_SWING, AVATAR_FILL, AVATAR_PROGRAM, FP_ARM_PROGRAM, FP_HELD_PROGRAM, PORTRAIT, DRAW_POSE, ELBOW_MAX,
  reachArm,
} from '../../src/avatarRenderer.js';
import { AvatarMotion } from '../../src/avatarMotion.js';
import { AVATARS, avatarHeight } from '../../src/avatars.js';
import { avatarModel, fpHandFrame, fpClearShift } from '../../src/avatarModel.js';
import { BLOCK_K } from '../../src/modelKit.js';
import { createAvatarMenu, avatarButtonLabel, INERT_BENEATH } from '../../src/avatarMenu.js';
import { createRemotePlayerRenderer } from '../../src/remotePlayerRenderer.js';
import { POSE_ON_GROUND, POSE_DRAWING } from '../../src/protocol.js';
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

  it('on a horse a dress\'s skirt lies over the thighs: they leave it through the hem, never through its front', () => {
    const def = AVATARS.find((a) => a.outfit.skirt);
    const sk = def.outfit.skirt;
    const k = def.scale;
    const rig = avatarModel(def).rig;
    const r = createAvatarRenderer(new THREE.Scene(), { avatar: def.id });
    /**
     * How far out of the skirt the legs reach: the largest share of the skirt's half-width or half-depth a leg's corner
     * comes to, inside the skirt's height (§107: the skirt is a block, BLOCK_K of its radii).
     */
    const outOfSkirt = (p) => {
      r.sync({ x: 0, y: 0, z: 0, pose: p, showModel: true, showArm: false });
      const root = model(r, def.id);
      root.updateMatrixWorld(true);
      const seat = root.getObjectByName(`avatar-hips-${def.id}`);
      const toSkirt = seat.matrixWorld.clone().invert(); // into the skirt's own (hanging) frame
      const hem = sk.y1 * k - rig.hipY;
      const waist = sk.y0 * k - rig.hipY;
      // the skirt's rings (as avatarModel lofts it): the hem, 0.7 of the way up, the waist
      const rings = [[0, sk.r1, sk.r1 * 0.85], [0.7, sk.r0 + (sk.r1 - sk.r0) * 0.25, sk.r0 + (sk.r1 - sk.r0) * 0.25], [1, sk.r0, sk.r0 * 0.66]];
      const radii = (t) => {
        const j = t < 0.7 ? 0 : 1;
        const u = (t - rings[j][0]) / (rings[j + 1][0] - rings[j][0]);
        return [1, 2].map((c) => (rings[j][c] + (rings[j + 1][c] - rings[j][c]) * u) * k);
      };
      let worst = 0;
      const v = new THREE.Vector3();
      root.traverse((o) => {
        if (!o.isMesh || !o.name.startsWith('avatar-leg')) return;
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(toSkirt);
          const t = (v.y - hem) / (waist - hem);
          if (t <= 0.02 || t >= 1) continue; // below the hem the legs are out in the open
          const [rx, rz] = radii(t);
          worst = Math.max(worst, Math.abs(v.x) / (rx * BLOCK_K), Math.abs(v.z) / (rz * BLOCK_K));
        }
      });
      return worst;
    };
    const riding = new AvatarMotion().step(1 / 60, { yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true, riding: true });
    expect(riding.legRaise).toBeGreaterThan(1.2);
    expect(outOfSkirt({ ...riding })).toBeLessThan(1); // seated: inside the skirt until the hem
    expect(outOfSkirt(pose({ legSwing: 0.6 }))).toBeLessThan(1); // walking: the swing is capped
    // standing the skirt hangs as built (the seat is not moved)
    expect(model(r, def.id).getObjectByName(`avatar-hips-${def.id}`).matrix.equals(new THREE.Matrix4())).toBe(true);
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

  it('§100 draws as what it holds draws (a bow or a throw); §95 on a tablet it keeps left of the buttons', () => {
    const r = createAvatarRenderer(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera(70, 4 / 3);
    const root = () => r.armGroup.children[0];
    const armAt = (frame) => Array.from(frame.arm).map((v) => expect.closeTo(v, 6));
    for (const [held, bow] of [['crude_bow', true], ['recurve_bow', true], ['flint_spear', false], ['flint_arrow', false]]) { // §100.6: the bows; an arrow in hand draws nothing
      r.setHeld(held);
      r.sync({ x: 0, y: 0, z: 0, pose: pose({ draw: 1 }), showModel: false, showArm: true, camera });
      expect(root().matrix.elements, held).toEqual(armAt(fpHandFrame(0, false, 1, bow)));
      r.sync({ x: 0, y: 0, z: 0, pose: pose({ draw: 0.4 }), showModel: false, showArm: true, camera });
      expect(root().matrix.elements, held).toEqual(armAt(fpHandFrame(0, false, 0.4, bow)));
    }
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera });
    const desk = root().matrix.elements[12];
    // a 1024 × 768 tablet: the cluster's left edge at 734 px, its top at 486 px
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: false, showArm: true, camera, fpClear: { left: 734 / 512 - 1, top: 1 - 486 / 384 } });
    const tablet = root().matrix.elements[12];
    expect(tablet).toBeLessThan(desk - 0.02); // moved left …
    expect(tablet - desk).toBeCloseTo(fpClearShift({ left: 734 / 512 - 1, top: 1 - 486 / 384 }, 4 / 3, 70), 9); // … by as much
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
    disposeAvatarAssets(); // a fresh page: nothing built yet
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    expect(avatarAssetCount()).toBe(1); // the one shown
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
    // every avatar's shared resources are built now, while the game loads: a player who joins later (or the chooser)
    // costs only a few groups and meshes
    expect(avatarAssetCount()).toBeGreaterThanOrEqual(AVATARS.length);
    const t0 = performance.now();
    for (const def of AVATARS) {
      const other = createAvatarRenderer(new THREE.Scene(), { avatar: def.id });
      expect(other.avatarId()).toBe(def.id);
      expect(other.group.children.map((c) => c.name)).toEqual([`avatar-${def.id}`]); // only that figure
      other.dispose();
    }
    expect(performance.now() - t0).toBeLessThan(500);
    r.dispose();
  });
});

describe('§100 the draw, on the model', () => {
  const still = (o = {}) => ({ yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true, ...o });
  /** A renderer holding `held`, its motion stepped through a full draw (1 s at 60 fps, as main's drawFraction rises). */
  function drawn(id, held) {
    const r = createAvatarRenderer(new THREE.Scene(), { avatar: id });
    r.setHeld(held);
    const m = new AvatarMotion();
    let p = m.pose;
    for (let i = 0; i <= 70; i++) p = m.step(1 / 60, still({ draw: Math.min(1, i / 60) }));
    r.sync({ x: 0, y: 0, z: 0, pose: p, showModel: true, showArm: false });
    const root = model(r, id);
    root.updateMatrixWorld(true);
    const at = (name) => /** @type {THREE.Object3D} */ (root.getObjectByName(name)).getWorldPosition(new THREE.Vector3());
    const heldMesh = /** @type {THREE.Object3D} */ (root.getObjectByName('avatar-held'));
    const q = heldMesh.getWorldQuaternion(new THREE.Quaternion());
    const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(q);
    /** where an arm's fist grips (its grip point, in the world) */
    const grip = (side) => {
      const g = avatarModel(AVATARS.find((a) => a.id === id)).rig.grip;
      return root.getObjectByName(`avatar-elbow-${side}`).localToWorld(new THREE.Vector3(side === 'l' ? -g[0] : g[0], g[1], g[2]));
    };
    return { r, m, root, at, grip, axis, held: heldMesh };
  }

  it('a bow: held upright straight ahead in the right hand, the string toward the archer; the left hand drawn back to the chin, its elbow up and out', () => {
    for (const def of AVATARS) {
      const { r, at, grip, axis } = drawn(def.id, 'crude_bow');
      const shR = at('avatar-shoulder-r');
      const shL = at('avatar-shoulder-l');
      const L = Math.hypot(...avatarModel(def).rig.elbow) + Math.hypot(...avatarModel(def).rig.grip);
      // the bow arm reaches ahead (−z) nearly its full length, at shoulder height
      expect(shR.z - grip('r').z, def.id).toBeGreaterThan(0.75 * L);
      expect(Math.abs(grip('r').y - shR.y), def.id).toBeLessThan(0.15 * L);
      // the bow stands upright (its limbs, the picture's x, near vertical), its string (the picture's +y) toward the archer
      expect(Math.abs(axis(1, 0, 0).y), def.id).toBeGreaterThan(0.9);
      expect(axis(0, 1, 0).z, def.id).toBeGreaterThan(0.8);
      // the drawing hand is at the face: up by the chin, between the shoulders, well ahead of the left shoulder
      const chinY = def.head.y * def.scale;
      const hand = grip('l');
      expect(Math.abs(hand.y - chinY), def.id).toBeLessThan(0.1);
      expect(Math.abs(hand.x), def.id).toBeLessThan(0.1);
      expect(hand.z, def.id).toBeLessThan(shL.z - 0.1);
      // its elbow is raised about to the shoulder's height and out to the left
      const el = at('avatar-elbow-l');
      expect(el.y, def.id).toBeGreaterThan(shL.y - 0.08);
      expect(el.x, def.id).toBeLessThan(shL.x - 0.08);
      // the body is turned side-on, the head still looks ahead
      expect(model(r, def.id).getObjectByName('avatar-torso').rotation.y).toBeCloseTo(DRAW_POSE.bow.twist, 6);
      const face = new THREE.Vector3(0, 0, -1).applyQuaternion(model(r, def.id).getObjectByName('avatar-neck').getWorldQuaternion(new THREE.Quaternion()));
      expect(face.z, def.id).toBeLessThan(-0.99);
      r.dispose();
    }
  });

  it('a spear: cocked overhand, the fist by the ear and the elbow out to the side, the point level and ahead; the other arm points', () => {
    for (const [id, held] of [['brayden', 'flint_spear'], ['annabelle', 'flint_spear'], ['caelan', 'flint_spear']]) {
      const def = /** @type {*} */ (AVATARS.find((a) => a.id === id));
      const { r, at, grip, axis } = drawn(id, held);
      const shR = at('avatar-shoulder-r');
      const hand = grip('r');
      const headHalf = def.head.rx * def.scale;
      expect(hand.y, id).toBeGreaterThan(shR.y + 0.12); // raised over the shoulder …
      expect(hand.x, id).toBeGreaterThan(headHalf); // … beside the head, not in front of the face
      const el = at('avatar-elbow-r');
      expect(el.x, id).toBeGreaterThan(shR.x + 0.1); // the elbow out to the side
      expect(el.y, id).toBeGreaterThan(shR.y - 0.06); // at about the shoulder's height
      // the item's length (the slab's +y, from the grip to the point) lies ahead and about level
      const along = axis(0, 1, 0);
      expect(along.z, id).toBeLessThan(-0.95);
      expect(Math.abs(along.y), id).toBeLessThan(0.25);
      // the left arm points ahead
      expect(grip('l').z, id).toBeLessThan(at('avatar-shoulder-l').z - 0.3);
      r.dispose();
    }
  });

  it('let go, the throw swings through from the drawn arm (no jump between frames); the elbows never bend backwards', () => {
    for (const held of ['flint_spear', 'crude_bow']) {
      const { r, m, root } = drawn('brayden', held);
      const shoulder = /** @type {THREE.Object3D} */ (root.getObjectByName('avatar-shoulder-r'));
      const elbowR = /** @type {THREE.Object3D} */ (root.getObjectByName('avatar-elbow-r'));
      const q = new THREE.Quaternion();
      const prev = shoulder.getWorldQuaternion(new THREE.Quaternion());
      let most = 0;
      let reached = 0;
      if (held !== 'crude_bow') m.swing(); // main: a throw swings the arm, a bow is let down
      for (let i = 0; i < 40; i++) {
        const p = m.step(1 / 60, still());
        r.sync({ x: 0, y: 0, z: 0, pose: p, showModel: true, showArm: false });
        root.updateMatrixWorld(true);
        shoulder.getWorldQuaternion(q);
        most = Math.max(most, 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev)))));
        prev.copy(q);
        reached = Math.max(reached, p.reachR);
        expect(elbowR.rotation.x, held).toBeGreaterThanOrEqual(0);
        expect(root.getObjectByName('avatar-elbow-l').rotation.x, held).toBeGreaterThanOrEqual(0);
      }
      expect(most, held).toBeLessThan(0.5); // at 60 fps: under 30° a frame
      if (held !== 'crude_bow') expect(reached).toBeGreaterThan(1.5); // and it does follow through
      // the arms are back at rest, the item as it is held at rest
      const rest = createAvatarRenderer(new THREE.Scene(), { avatar: 'brayden' });
      rest.setHeld(held);
      rest.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: true, showArm: false });
      const restRoot = model(rest, 'brayden');
      const near = (name) => restRoot.getObjectByName(name).quaternion.angleTo(root.getObjectByName(name).quaternion);
      expect(near('avatar-shoulder-r')).toBeLessThan(0.02);
      expect(near('avatar-shoulder-l')).toBeLessThan(0.02);
      expect(near('avatar-held')).toBeLessThan(1e-6);
      rest.dispose();
      r.dispose();
    }
    // whatever the pose says, the right elbow's extra bend for a reach is never negative
    const r = createAvatarRenderer(new THREE.Scene());
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ reachR: -1.1, elbow: 0.12 }), showModel: true, showArm: false });
    expect(model(r, 'caelan').getObjectByName('avatar-elbow-r').rotation.x).toBeCloseTo(0.12, 9);
    r.dispose();
  });

  it('reachArm puts a fist where it is asked, its elbow toward the pole, bent no further than ELBOW_MAX', () => {
    const rig = avatarModel(AVATARS[0]).rig;
    const elbowAt = new THREE.Vector3(...rig.elbow);
    const grip = new THREE.Vector3(...rig.grip);
    const out = new THREE.Quaternion();
    for (const [t, pole] of [[[0.1, 0.25, 0.05], [1, 0, 0]], [[-0.05, 0.1, -0.4], [0, -1, 0]], [[0.2, -0.3, -0.1], [0, 0, 1]]]) {
      const target = new THREE.Vector3(...t);
      const e = reachArm(elbowAt, grip, target, new THREE.Vector3(...pole), out);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(ELBOW_MAX);
      const hand = grip.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), e).add(elbowAt).applyQuaternion(out);
      expect(hand.distanceTo(target)).toBeLessThan(1e-6);
      const el = elbowAt.clone().applyQuaternion(out);
      const side = el.clone().addScaledVector(target.clone().normalize(), -el.dot(target.clone().normalize()));
      expect(side.dot(new THREE.Vector3(...pole))).toBeGreaterThan(0);
    }
    // out of reach: straight, pointing at it
    const far = new THREE.Vector3(0, 0, -5);
    expect(reachArm(elbowAt, grip, far, new THREE.Vector3(0, -1, 0), out)).toBe(0);
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
    // no first-person hand is built for them, nor any figure but their own (no hidden default one)
    let hands = 0;
    scene.traverse((o) => { if (o.name.startsWith('avatar-arm-')) hands++; });
    expect(hands).toBe(0);
    const figures = [];
    scene.traverse((o) => { if (/^avatar-(caelan|brayden|annabelle)$/.test(o.name)) figures.push(o.name); });
    expect(figures.sort()).toEqual(['avatar-annabelle', 'avatar-brayden']);
    remote.clear();
    expect(remote.count()).toBe(0);
    local.dispose();
  });

  it('§100: a pose that says they are drawing raises their arms into the draw at a draw\'s pace; let go, they come down', () => {
    const scene = new THREE.Scene();
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
    const remote = createRemotePlayerRenderer(scene, /** @type {*} */ (doc));
    const players = [{ id: 1, name: 'Bo', avatar: 'brayden', swings: 0, held: 'crude_bow' }];
    let flags = POSE_ON_GROUND | POSE_DRAWING;
    const remotes = { list: () => players, sample: () => ({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, flags }) };
    const fist = () => {
      const bo = /** @type {THREE.Object3D} */ (scene.getObjectByName('avatar-brayden'));
      bo.updateMatrixWorld(true);
      return /** @type {THREE.Object3D} */ (bo.getObjectByName('avatar-held')).getWorldPosition(new THREE.Vector3());
    };
    remote.sync(/** @type {*} */ (remotes), 0, 1 / 60);
    const z0 = fist().z;
    for (let i = 0; i < 30; i++) remote.sync(/** @type {*} */ (remotes), 0, 1 / 60);
    const zHalf = fist().z;
    for (let i = 0; i < 40; i++) remote.sync(/** @type {*} */ (remotes), 0, 1 / 60);
    const zFull = fist().z;
    // the bow comes up ahead of them (−z), half way after half a draw's time
    expect(zFull).toBeLessThan(z0 - 0.25);
    expect(zHalf).toBeLessThan(z0 - 0.05);
    expect(zHalf).toBeGreaterThan(zFull + 0.05);
    flags = POSE_ON_GROUND;
    for (let i = 0; i < 30; i++) remote.sync(/** @type {*} */ (remotes), 0, 1 / 60);
    expect(fist().z).toBeCloseTo(z0, 2);
    remote.clear();
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
