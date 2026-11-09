// vortexRenderer.js — Node only (three core objects work without WebGL; the WebGLRenderer is a stub), like
// campfireRenderer.test.js. DESIGN-circuits §2.4, §6.2.6, §7 A.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createVortexRenderer } from '../../src/vortexRenderer.js';
import { VORTEX_BILLBOARD, VORTEX_CORE_R, VORTEX_MAX_CORES } from '../../src/config.js';
import { PHASE, BlackHoles } from '../../src/blackholes.js';

const view = (cx, extra = {}) => ({ cx, cy: 10.5, cz: 0, phase: PHASE.VORTEX, s: 1, strength: 1, seed: 0.25, age: Infinity, full: true, ...extra });

function setup() {
  const scene = new THREE.Scene();
  const vr = createVortexRenderer(scene);
  const byName = (n) => scene.getObjectByName(n);
  return { scene, vr, byName, meshes: () => ['vortex-core', 'vortex-billboard', 'vortex-disk', 'vortex-shell'].map(byName) };
}

/** Draw calls three would issue: one per visible mesh, two for a transparent DoubleSide material without forceSinglePass. */
function drawCalls(scene) {
  let n = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible || (o.isInstancedMesh && o.count === 0)) return;
    const mat = /** @type {THREE.Material} */ (o.material);
    n += mat.transparent && mat.side === THREE.DoubleSide && !mat.forceSinglePass ? 2 : 1;
  });
  return n;
}

describe('createVortexRenderer', () => {
  it('4 InstancedMeshes, frustumCulled off, renderOrder 2 on the billboard, disk and shell; nothing drawn until sync', () => {
    const { scene, vr, meshes } = setup();
    const [core, billboard, disk, shell] = meshes();
    for (const m of [core, billboard, disk, shell]) {
      expect(m.isInstancedMesh).toBe(true);
      expect(m.frustumCulled).toBe(false);
      expect(m.visible).toBe(false);
    }
    expect([billboard.renderOrder, disk.renderOrder, shell.renderOrder]).toEqual([2, 2, 2]);
    expect(core.material.isMeshBasicMaterial).toBe(true);
    expect(core.material.color.getHex()).toBe(0x000000);
    expect(core.material.fog).toBe(true);
    let lights = 0;
    scene.traverse((o) => { if (o.isLight) lights++; });
    expect(lights).toBe(0); // never a light: the light count is part of every shader key
    expect(vr.count()).toBe(0);
    vr.dispose();
  });

  it('the billboard is a VORTEX_BILLBOARD (3.6) square; the core a VORTEX_CORE_R sphere; the disk the 0.5–3.4 ring, flat', () => {
    const { vr, meshes } = setup();
    const [core, billboard, disk] = meshes();
    expect(VORTEX_BILLBOARD).toBe(3.6);
    billboard.geometry.computeBoundingBox();
    const bb = billboard.geometry.boundingBox;
    expect(bb.max.x - bb.min.x).toBeCloseTo(3.6, 6); // float32 positions
    expect(bb.max.y - bb.min.y).toBeCloseTo(3.6, 6);
    disk.geometry.computeBoundingBox();
    const db = disk.geometry.boundingBox;
    expect(db.max.x).toBeCloseTo(3.4, 6);
    expect(Math.abs(db.max.y - db.min.y)).toBeLessThan(1e-6); // flat in the xz plane
    let minR = Infinity;
    const p = disk.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) minR = Math.min(minR, Math.hypot(p.getX(i), p.getZ(i)));
    expect(minR).toBeCloseTo(0.5, 6);
    expect(core.geometry.parameters.widthSegments).toBe(24);
    vr.sync([view(0)], 0);
    const m = new THREE.Matrix4();
    core.getMatrixAt(0, m);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect(s.x).toBeCloseTo(VORTEX_CORE_R, 6);
    vr.dispose();
  });

  it('instance counts follow the views: cores and billboards for every view, disks for full views from IMPLODE on, shells for full views in ARM, FLASH and IMPLODE', () => {
    const { scene, vr, meshes } = setup();
    const [core, billboard, disk, shell] = meshes();
    const views = [
      view(0, { phase: PHASE.ARM, s: 0.5, age: 0.2 }),
      view(5, { phase: PHASE.FLASH, s: 0.5 }),
      view(10, { phase: PHASE.IMPLODE, s: 0.5 }),
      view(15),
      view(20, { full: false }),
      view(25, { full: false, phase: PHASE.IMPLODE, s: 0.4 }),
      view(30, { full: false, strength: 0.2 }),
    ];
    vr.sync(views, 1);
    expect(vr.count()).toBe(7);
    expect([core.count, billboard.count, disk.count, shell.count]).toEqual([7, 7, 2, 3]);
    expect(drawCalls(scene)).toBe(4); // 4 draw calls in all, however many holes
    // The per-instance attributes carry each view: centre, then (seed, s, strength, phase), and the full flag.
    const c = billboard.geometry.getAttribute('aCentre');
    const p = billboard.geometry.getAttribute('aParams');
    const f = billboard.geometry.getAttribute('aFull');
    expect([c.getX(3), c.getY(3), c.getZ(3)]).toEqual([15, 10.5, 0]);
    expect([p.getX(6), p.getY(6), p.getZ(6), p.getW(6)].map((v) => +v.toFixed(5))).toEqual([0.25, 1, 0.2, PHASE.VORTEX]);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => f.getX(i))).toEqual([1, 1, 1, 1, 0, 0, 0]);
    const dc = disk.geometry.getAttribute('aCentre');
    expect([dc.getX(0), dc.getX(1)]).toEqual([10, 15]);
    const sp = shell.geometry.getAttribute('aParams');
    expect([sp.getW(0), sp.getW(1), sp.getW(2)]).toEqual([PHASE.ARM, PHASE.FLASH, PHASE.IMPLODE]);
    expect(disk.geometry.getAttribute('aParams').getZ(1)).toBe(1); // the strength attribute
    // The core pops in only once the vortex has formed.
    const m = new THREE.Matrix4();
    const scale = (i) => {
      core.getMatrixAt(i, m);
      return new THREE.Vector3().setFromMatrixScale(m).x;
    };
    expect([0, 1, 2].map(scale)).toEqual([0, 0, 0]);
    expect(scale(3)).toBeCloseTo(VORTEX_CORE_R, 6);
    vr.sync([view(0, { s: 0.5 })], 1.1);
    expect(scale(0)).toBeGreaterThan(VORTEX_CORE_R); // the ease-out-back overshoot of the pop
    // Fewer views; none at all.
    vr.sync([view(3)], 2);
    expect([core.count, billboard.count, disk.count, shell.count]).toEqual([1, 1, 1, 0]);
    expect(shell.visible).toBe(false);
    vr.sync([], 3);
    expect(drawCalls(scene)).toBe(0);
    expect(vr.count()).toBe(0);
    vr.dispose();
  });

  it(`capacity starts at 16 and doubles, keeping the same meshes (and draw order); at most ${VORTEX_MAX_CORES} views`, () => {
    const { scene, vr, meshes } = setup();
    const before = meshes();
    expect(before[0].instanceMatrix.count).toBe(16);
    const many = Array.from({ length: 300 }, (_, i) => view(i * 2, { full: i < 40 }));
    vr.sync(many, 0);
    const after = meshes();
    for (let i = 0; i < 4; i++) expect(after[i]).toBe(before[i]);
    expect(after[0].count).toBe(VORTEX_MAX_CORES);
    expect(after[1].count).toBe(VORTEX_MAX_CORES);
    expect(after[2].count).toBe(40);
    expect(after[0].instanceMatrix.count).toBe(VORTEX_MAX_CORES);
    expect(after[1].geometry.getAttribute('aCentre').count).toBe(VORTEX_MAX_CORES);
    expect(after[1].geometry.getAttribute('aCentre').getX(255)).toBe(510);
    expect(after[2].geometry.getAttribute('aCentre').count).toBe(64);
    // Creation order is the transparent draw order at equal depth: billboard, then the disk (its near half crosses the
    // shadow; its shader hides its far half behind the shadow's plane), then the shell. None writes depth.
    expect(after[1].id).toBeLessThan(after[2].id);
    expect(after[2].id).toBeLessThan(after[3].id);
    for (const m of after.slice(1)) expect(m.material.depthWrite).toBe(false);
    expect(after[2].material.fragmentShader).toContain('depthP - depthC');
    expect(drawCalls(scene)).toBe(3); // no shells: every view is a formed vortex
    vr.dispose();
  });

  it('blending: premultiplied billboard, disk and shell (One, OneMinusSrcAlpha), a single-pass DoubleSide disk', () => {
    const { vr, meshes } = setup();
    const [, billboard, disk, shell] = meshes();
    for (const m of [billboard, disk, shell]) {
      expect(m.material.blending).toBe(THREE.CustomBlending);
      expect(m.material.blendSrc).toBe(THREE.OneFactor);
      expect(m.material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
      expect(m.material.transparent).toBe(true);
      expect(m.material.fog).toBe(true);
    }
    expect(disk.material.side).toBe(THREE.DoubleSide);
    expect(disk.material.forceSinglePass).toBe(true);
    expect(shell.material.side).toBe(THREE.FrontSide);
    vr.dispose();
  });

  it('uPhase advances by flowPhase of the clock’s change — a tenth as fast when every view is weak (switched off)', () => {
    const { vr, meshes } = setup();
    const u = meshes()[2].material.uniforms;
    vr.sync([view(0)], 10);
    const p0 = u.uPhase.value;
    vr.sync([view(0)], 10.1);
    expect(u.uPhase.value - p0).toBeCloseTo(0.9, 6);
    expect(u.uTime.value).toBeCloseTo(10.1, 9);
    vr.sync([view(0, { strength: 0.2 })], 10.2);
    expect(u.uPhase.value - p0).toBeCloseTo(0.99, 6);
    vr.sync([view(0)], 5); // the clock went back (a new world): no jump
    expect(u.uPhase.value - p0).toBeCloseTo(0.99, 6);
    vr.sync([view(0)], 1e6); // a huge gap counts as at most 0.25 s
    expect(u.uPhase.value).toBeLessThan(2 * Math.PI);
    // The billboard, disk and shell share the uniforms.
    const [, billboard, disk, shell] = meshes();
    expect(billboard.material.uniforms).toBe(disk.material.uniforms);
    expect(shell.material.uniforms).toBe(disk.material.uniforms);
    vr.dispose();
  });

  it('draws what BlackHoles.vortexViews gives, inert holes and arming charges included', () => {
    const { vr, meshes } = setup();
    const holes = new BlackHoles();
    holes.add(0, 10, 0);
    holes.add(6, 10, 0);
    const views = holes.vortexViews(0, 10.5, 0, 128, 16, 256, []);
    vr.sync(views, 0, [0, 12, 0]);
    expect(meshes()[1].count).toBe(2);
    expect(meshes()[2].count).toBe(2);
    vr.dispose();
  });

  it('no violet: every colour in the four shaders has a hue outside 250°–300° (blackbody palette)', () => {
    const { vr, meshes } = setup();
    const hueOf = (r, g, b) => {
      const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace); // the shaders write sRGB (output space)
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl, THREE.SRGBColorSpace);
      return { h: hsl.h * 360, s: hsl.s };
    };
    let found = 0;
    for (const m of meshes().slice(1)) {
      const src = m.material.fragmentShader + m.material.vertexShader;
      for (const [, a, b, c] of src.matchAll(/vec3\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/g)) {
        const { h, s } = hueOf(+a, +b, +c);
        found++;
        if (s > 0.15) expect(h < 250 || h > 300, `vec3(${a}, ${b}, ${c}) hue ${h}`).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(5);
    vr.dispose();
  });

  it('prewarm compiles the four programs against the real scene, draws one hidden instance each until rendered, and resolves', async () => {
    const { scene, vr, meshes } = setup();
    scene.fog = new THREE.Fog(0, 1, 100);
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await vr.prewarm({ compileAsync: (obj, cam, target) => { calls.push([obj, cam, target]); return Promise.resolve(obj); } }, camera);
    expect(calls.map((c) => c[0])).toEqual(meshes());
    for (const c of calls) expect([c[1], c[2]]).toEqual([camera, scene]);
    for (const m of meshes()) {
      expect(m.visible).toBe(true);
      expect(m.count).toBe(1);
    }
    expect(meshes()[1].geometry.getAttribute('aParams').getZ(0)).toBe(0); // strength 0: the shaders discard it
    vr.sync([], 0); // main, on world load: keeps the warm draw
    expect(meshes().every((m) => m.visible)).toBe(true);
    for (const m of meshes()) m.onAfterRender();
    expect(meshes().every((m) => !m.visible && m.count === 0)).toBe(true);
    // Fallbacks never throw.
    let compiled = 0;
    await vr.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(4);
    await expect(vr.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(vr.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(vr.prewarm(null, camera)).resolves.toBeUndefined();
    vr.dispose();
  });

  it('dispose removes everything from the scene', () => {
    const { scene, vr } = setup();
    vr.sync([view(0)], 0);
    vr.dispose();
    expect(scene.children).toHaveLength(0);
    expect(vr.count()).toBe(0);
  });
});
