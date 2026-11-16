// avatarRenderer.js (three, Node: core objects only) and avatarMenu.js (fake DOM from index.html). CONTRACTS §91.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  createAvatarRenderer, avatarGeometries, avatarBox, FP_DEPTH, FP_RENDER_ORDER, SKIRT_LEG_SWING,
} from '../../src/avatarRenderer.js';
import { AvatarMotion } from '../../src/avatarMotion.js';
import { AVATARS, avatarHeight } from '../../src/avatars.js';
import { paintAvatarSheet, PAGE_H, SHEET_W } from '../../src/avatarSkin.js';
import { createAvatarMenu, avatarButtonLabel, INERT_BENEATH } from '../../src/avatarMenu.js';
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
    box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
  });
  return box;
}
const pose = (over = {}) => Object.assign(new AvatarMotion().step(0, { yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true }), over);

describe('the avatar model (three)', () => {
  it('every avatar has a model and an arm; one is shown at a time; the default is Caelan', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    expect(scene.children).toContain(r.group);
    expect(scene.children).toContain(r.armGroup);
    expect(r.group.children.map((c) => c.name)).toEqual(AVATARS.map((a) => `avatar-${a.id}`));
    expect(r.avatarId()).toBe('caelan');
    r.sync({ x: 1, y: 64, z: 2, pose: pose(), showModel: true, showArm: false });
    const shown = r.group.children.filter((c) => c.visible).map((c) => c.name);
    expect(shown).toEqual(['avatar-caelan']);
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

  it('stands at the feet, its height the avatar\'s (± a few texels for tufts), facing −Z, turned by the body\'s yaw', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    for (const def of AVATARS) {
      r.setAvatar(def.id);
      r.sync({ x: 10, y: 64, z: -5, pose: pose(), showModel: true, showArm: false });
      const b = boundsOf(r.group);
      expect(b.min.y, def.id).toBeCloseTo(64, 3);
      expect(b.max.y - 64, def.id).toBeGreaterThan(avatarHeight(def) - 0.01);
      expect(b.max.y - 64, def.id).toBeLessThan(avatarHeight(def) + 0.12);
      expect(b.max.x - b.min.x, def.id).toBeLessThan(1); // chunky, arms a little out: wider than the collider, drawn only
    }
    // the head turns with the pose; a turned body puts the face elsewhere
    r.setAvatar('brayden');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ bodyYaw: Math.PI / 2 }), showModel: true, showArm: false });
    const root = r.group.children.find((c) => c.name === 'avatar-brayden');
    expect(root.rotation.y).toBeCloseTo(Math.PI / 2, 9);
    r.dispose();
  });

  it('a dress keeps the legs inside its skirt; lying down puts the body flat', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    r.setAvatar('annabelle');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ legSwing: 1.2 }), showModel: true, showArm: false });
    const root = r.group.children.find((c) => c.name === 'avatar-annabelle');
    let legs = [];
    root.traverse((o) => { if (o.isMesh && o.name.startsWith('avatar-leg')) legs.push(o.parent); });
    expect(Math.max(...legs.map((l) => Math.abs(l.rotation.x)))).toBeCloseTo(SKIRT_LEG_SWING, 9);
    r.setAvatar('caelan');
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ legSwing: 0.7 }), showModel: true, showArm: false });
    legs = [];
    r.group.children.find((c) => c.name === 'avatar-caelan').traverse((o) => { if (o.isMesh && o.name.startsWith('avatar-leg')) legs.push(o.parent); });
    expect(legs.map((l) => l.rotation.x).sort()).toEqual([-0.7, 0.7]);
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ bodyPitch: Math.PI / 2, lie: 1 }), showModel: true, showArm: false });
    const b = boundsOf(r.group);
    expect(b.max.y - b.min.y).toBeLessThan(0.6); // flat on its back: as high as its head is deep …
    expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)).toBeGreaterThan(1.4); // … and as long as it is tall
    expect(b.min.y).toBeGreaterThan(-0.07); // only the hair sinks in a little: a pillow
    r.dispose();
  });

  it('the boxes\' UVs stay on their avatar\'s page', () => {
    const sheet = paintAvatarSheet();
    AVATARS.forEach((def, page) => {
      const geo = avatarGeometries(def, sheet.pages[def.id], sheet.height);
      for (const g of Object.values(geo)) {
        if (!g) continue;
        const uv = g.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) {
          expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getX(i)).toBeLessThanOrEqual(1);
          const v = uv.getY(i) * sheet.height;
          expect(v, def.id).toBeGreaterThanOrEqual(page * PAGE_H);
          expect(v, def.id).toBeLessThanOrEqual((page + 1) * PAGE_H);
        }
      }
    });
    const g = avatarBox({ w: 4, h: 4, d: 4, x: 0, y: 0 }, 0, PAGE_H, { x: 1 });
    g.computeBoundingBox();
    expect(g.boundingBox.min.x).toBeCloseTo(1 - 2 / 32, 9);
    expect(SHEET_W).toBe(128);
  });
});

describe('the first-person arm', () => {
  it('hangs from the camera at the lower right, in front of the camera, only when asked', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    camera.rotation.order = 'YXZ';
    camera.position.set(5, 70, 5);
    camera.rotation.set(-0.2, 1.1, 0);
    r.sync({ x: 5, y: 68.38, z: 5, pose: pose(), showModel: false, showArm: true, camera });
    const arm = r.armGroup.children.find((c) => c.visible);
    expect(arm && arm.name).toBe('avatar-arm-caelan');
    scene.updateMatrixWorld(true);
    // in camera space every vertex is ahead of the near plane, the arm to the right of and below the middle
    const toCam = camera.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    arm.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(toCam));
    });
    expect(box.max.z).toBeLessThan(-0.1);
    expect((box.min.x + box.max.x) / 2).toBeGreaterThan(0.1);
    expect((box.min.y + box.max.y) / 2).toBeLessThan(0);
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

  it('its material is lit from the light volume at the eye and its depth is squeezed to the front of the range', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    let mat = null;
    r.armGroup.traverse((o) => { if (o.isMesh) mat = o.material; });
    const lambert = THREE.ShaderLib.lambert;
    const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} };
    mat.onBeforeCompile(shader, null);
    expect(shader.vertexShader).toContain('uniform vec3 caelArmEye;');
    expect(shader.vertexShader).toContain('vCaelLight = caelVolumeLevels( caelArmEye );');
    expect(shader.vertexShader).toContain(`gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
    expect(shader.fragmentShader).toContain('caelExtra'); // the shared light patch
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['caelArmEye', 'caelVol', 'caelVolInfo']));
    expect(mat.customProgramCacheKey()).toBe('caelancraft-avatar-arm');
    // the model's own material is an ordinary lit material (the prototype hook lights it like the animals)
    let model = null;
    r.group.traverse((o) => { if (o.isMesh) model = o.material; });
    expect(model.isMeshLambertMaterial).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(model, 'onBeforeCompile')).toBe(false);
    r.dispose();
  });
});

describe('the item in hand (setHeld)', () => {
  const T = 1 / 32;
  /** The model's held mesh and the first-person one. */
  function heldMeshes(r) {
    let held = null;
    let fp = null;
    r.group.traverse((o) => { if (o.name === 'avatar-held') held = o; });
    r.armGroup.traverse((o) => { if (o.name === 'avatar-fp-held') fp = o; });
    return { held, fp };
  }
  /** The name of the model or the arm (a child of the renderer's group or armGroup) the object hangs in. */
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

  it('shows the item in the model\'s right hand and the first-person hand; null, a block item or an unknown key hides both', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
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
    // in the right hand (+x; the model faces −z), the pick held ahead of it at hand height
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: true, showArm: false });
    const b = boxOf(held);
    expect(b.min.x).toBeGreaterThan(0.1);
    expect((b.min.z + b.max.z) / 2).toBeLessThan(-0.1);
    expect(b.max.y).toBeGreaterThan(0.6);
    expect(b.min.y).toBeGreaterThan(0.3);
    for (const k of [null, 'stone', 'nonsense', '']) {
      r.setHeld('steel_sword');
      expect(held.visible && fp.visible).toBe(true);
      r.setHeld(k);
      expect(held.visible || fp.visible, String(k)).toBe(false);
      expect(r.heldKey()).toBe(null);
    }
    r.dispose();
  });

  it('follows setAvatar into the new model\'s hand; one geometry per item, reused, freed by dispose', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const { held, fp } = heldMeshes(r);
    r.setHeld('steel_sword');
    const sword = held.geometry;
    r.setAvatar('annabelle');
    expect(rootName(held)).toBe('avatar-annabelle');
    expect(rootName(fp)).toBe('avatar-arm-annabelle');
    expect(held.visible && fp.visible).toBe(true);
    const ann = AVATARS.find((a) => a.id === 'annabelle');
    expect(held.position.y).toBeCloseTo(-(ann.body.foreArm.h - ann.body.hand / 2) * T, 9);
    expect(held.parent.parent.position.x).toBeGreaterThan(0); // the right shoulder
    r.setAvatar('brayden');
    r.setHeld('iron_pick');
    r.setHeld('honeyberries'); // a lump: in front of the fist, upright
    expect(held.position.z).toBeLessThan(0);
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
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const { held } = heldMeshes(r);
    r.setHeld('iron_pick');
    r.sync({ x: 0, y: 0, z: 0, pose: pose(), showModel: true, showArm: false });
    const rest = boxOf(held);
    r.sync({ x: 0, y: 0, z: 0, pose: pose({ reachR: 1.9 }), showModel: true, showArm: false });
    const up = boxOf(held);
    expect(up.max.y).toBeGreaterThan(rest.max.y + 0.4);
    r.dispose();
  });

  it('in first person it is drawn like the arm: in front of the camera, lit at the eye, depth squeezed, never culled', () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const { fp } = heldMeshes(r);
    r.setHeld('steel_sword');
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    camera.rotation.order = 'YXZ';
    camera.position.set(5, 70, 5);
    camera.rotation.set(-0.2, 1.1, 0);
    r.sync({ x: 5, y: 68.38, z: 5, pose: pose(), showModel: false, showArm: true, camera });
    scene.updateMatrixWorld(true);
    const box = boxOf(fp).applyMatrix4(camera.matrixWorld.clone().invert());
    expect(box.max.z).toBeLessThan(-0.1); // ahead of the near plane
    expect(box.max.x).toBeGreaterThan(0); // at the right of the view …
    expect(box.max.y).toBeGreaterThan(box.min.y + 0.15); // … standing up out of the hand
    expect(fp.renderOrder).toBe(FP_RENDER_ORDER);
    expect(fp.frustumCulled).toBe(false);
    const mat = fp.material;
    expect(mat.vertexColors).toBe(true);
    expect(mat.map).toBe(null);
    const lambert = THREE.ShaderLib.lambert;
    const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} };
    mat.onBeforeCompile(shader, null);
    expect(shader.vertexShader).toContain('vCaelLight = caelVolumeLevels( caelArmEye );');
    expect(shader.vertexShader).toContain(`gl_Position.z = mix( - gl_Position.w, gl_Position.z, ${FP_DEPTH.toFixed(4)} );`);
    expect(shader.uniforms.caelArmEye.value.x).toBeCloseTo(5, 9); // the arm's eye
    expect(mat.customProgramCacheKey()).toBe('caelancraft-avatar-held');
    // the model's is a plain lit material with vertex colours (the prototype hook lights it)
    const { held } = heldMeshes(r);
    expect(held.material.isMeshLambertMaterial && held.material.vertexColors).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(held.material, 'onBeforeCompile')).toBe(false);
    r.dispose();
  });

  it('prewarm compiles the held item\'s programs too (with the attributes a real item has), and hides it again', async () => {
    const scene = new THREE.Scene();
    const r = createAvatarRenderer(scene);
    const { held, fp } = heldMeshes(r);
    for (const m of [held, fp]) expect(Object.keys(m.geometry.attributes).sort()).toEqual(['color', 'normal', 'position']);
    const seen = [];
    await r.prewarm({
      compileAsync(obj) {
        obj.traverse((o) => { if (o.isMesh && /held/.test(o.name)) seen.push([o.name, o.visible]); });
        return Promise.resolve();
      },
    }, new THREE.PerspectiveCamera());
    expect(seen).toEqual([['avatar-held', true], ['avatar-fp-held', true]]);
    expect(held.visible || fp.visible).toBe(false);
    r.dispose();
  });
});

describe('the Avatar chooser (avatarMenu.js)', () => {
  function setup(opts = {}) {
    const doc = documentFromHTML(html);
    const onChoose = vi.fn();
    const onView = vi.fn();
    const menu = createAvatarMenu(/** @type {*} */ (doc), { current: 'caelan', onChoose, onView, viewLabel: 'First person', ...opts });
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

  it('opens from either button: a card per avatar on a rounded square, the chosen one checked; the screens under it inert', () => {
    const { $, menu } = setup();
    fire($('btn-avatar-title'), 'click');
    expect(menu.isOpen()).toBe(true);
    const root = $('avatar-chooser');
    expect(root.classList.contains('hidden')).toBe(false);
    const cards = root.querySelectorAll('.av-card');
    expect(cards.map((c) => c.dataset.avatar)).toEqual(['caelan', 'brayden', 'annabelle']);
    expect(cards.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(cards.map((c) => c.querySelector('.av-name').textContent)).toEqual(['Caelan', 'Brayden', 'Annabelle']);
    for (const c of cards) {
      expect(c.classList.contains('hex-button')).toBe(false); // never a hexagon
      const canvas = c.querySelector('canvas');
      expect(canvas.width).toBe(canvas.height);
      expect(canvas.getContext('2d').calls.some(([n]) => n === 'putImageData')).toBe(true);
    }
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert')).toBe(true);
    menu.close();
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert')).toBe(false);
    fire($('btn-avatar-pause'), 'click');
    expect(menu.isOpen()).toBe(true);
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
