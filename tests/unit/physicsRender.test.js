// fallingRenderer.js and particles.js — Node only (Three core objects work without WebGL): instancing per block id
// and layer, capacity growth, the explosion light, and the one-Points particle system (CONTRACTS §34.4–§34.5).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PARTICLE_CAPACITY } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { createFallingRenderer, PREWARM_IDS } from '../../src/fallingRenderer.js';
import { createParticles, PARTICLE_KINDS, blockParticleColor } from '../../src/particles.js';

const item = (id, x, y, z, extra = {}) => ({ id, x, y, z, rx: 0, ry: 0, rz: 0, scale: 1, ...extra });

describe('fallingRenderer', () => {
  it('one InstancedMesh per (block id, layer) on the atlas, frustumCulled off, counts follow sync', () => {
    const scene = new THREE.Scene();
    const atlas = new THREE.Texture();
    const fr = createFallingRenderer(scene, atlas);
    fr.sync([item(BLOCK.SAND, 0, 10, 0), item(BLOCK.SAND, 1, 10, 0), item(BLOCK.OAK_LEAVES, 2, 10, 0), item(BLOCK.WATER_FALL, 3, 10, 0)]);
    const meshes = scene.children.filter((o) => o.isInstancedMesh);
    expect(meshes.map((m) => m.name).sort()).toEqual(['falling:11:cutout', 'falling:74:translucent', 'falling:8:opaque']);
    for (const m of meshes) {
      expect(m.frustumCulled).toBe(false);
      expect(m.material.map).toBe(atlas);
      expect(m.material.vertexColors).toBe(true);
    }
    expect(meshes.find((m) => m.name === 'falling:8:opaque').count).toBe(2);
    expect(fr.count()).toBe(4);
    // Next frame without sand: its mesh draws nothing (kept for reuse).
    fr.sync([item(BLOCK.OAK_LEAVES, 2, 9, 0)]);
    const sand = scene.getObjectByName('falling:8:opaque');
    expect(sand.count).toBe(0);
    expect(sand.visible).toBe(false);
    // Campfires have no cell mesh (own model): skipped.
    fr.sync([item(BLOCK.CAMPFIRE, 0, 0, 0)]);
    expect(fr.count()).toBe(0);
    fr.dispose();
    expect(scene.children.filter((o) => o.isInstancedMesh).length).toBe(0);
  });

  it('places instances at the item centre with rotation (Euler YXZ) and scale; capacity doubles', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const items = [];
    for (let i = 0; i < 40; i++) items.push(item(BLOCK.STONE, i, 20, -i, { ry: 0.5, scale: 1.04 }));
    fr.sync(items, 40);
    const mesh = scene.getObjectByName('falling:1:opaque');
    expect(mesh.count).toBe(40);
    expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(40);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(39, m);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    expect([p.x, p.y, p.z]).toEqual([39, 20, -39]);
    expect(s.x).toBeCloseTo(1.04);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    expect(e.y).toBeCloseTo(0.5);
    // `count` limits what is drawn.
    fr.sync(items, 3);
    expect(scene.getObjectByName('falling:1:opaque').count).toBe(3);
  });

  it('owns one explosion PointLight (off until setFlash)', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const light = scene.getObjectByName('explosion-flash');
    expect(light.isPointLight).toBe(true);
    expect(light.intensity).toBe(0);
    fr.setFlash(1, 2, 3, 40);
    expect(light.intensity).toBe(40);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
    fr.setFlash(0, 0, 0, 0);
    expect(light.intensity).toBe(0);
  });
});

describe('particles', () => {
  it('one THREE.Points with PARTICLE_CAPACITY slots; the oldest particle is overwritten when full', () => {
    const scene = new THREE.Scene();
    const ps = createParticles(scene, { random: () => 0.5 });
    expect(scene.children.filter((o) => o.isPoints).length).toBe(1);
    expect(ps.points.geometry.getAttribute('position').count).toBe(PARTICLE_CAPACITY);
    expect(PARTICLE_KINDS).toEqual(['dust', 'leaves', 'smoke', 'sparks', 'steam']);
    ps.emit('dust', 0, 10, 0, 10, { id: BLOCK.SAND });
    expect(ps.count()).toBe(10);
    ps.emit('sparks', 0, 10, 0, PARTICLE_CAPACITY + 50);
    expect(ps.count()).toBe(PARTICLE_CAPACITY);
    ps.emit('nonsense', 0, 0, 0, 5);
    ps.emit('dust', NaN, 0, 0, 5);
    expect(ps.count()).toBe(PARTICLE_CAPACITY);
    ps.clear();
    expect(ps.count()).toBe(0);
    ps.dispose();
  });

  it('particles move, fade and die; dt = 0 freezes them', () => {
    const ps = createParticles(new THREE.Scene(), { random: () => 0.5 });
    ps.emit('smoke', 0, 10, 0, 4);
    const pos = ps.points.geometry.getAttribute('position');
    const y0 = pos.getY(0);
    ps.update(0);
    expect(pos.getY(0)).toBe(y0);
    ps.update(0.1);
    expect(pos.getY(0)).toBeGreaterThan(y0); // smoke rises
    expect(ps.points.visible).toBe(true);
    for (let i = 0; i < 40; i++) ps.update(0.1);
    expect(ps.count()).toBe(0);
    ps.update(0.1);
    expect(ps.points.visible).toBe(false);
  });

  it('dust takes the block colour (sRGB 0..1), tinted like the mesher for tinted tops', () => {
    const sand = blockParticleColor(BLOCK.SAND);
    expect(sand[0]).toBeGreaterThan(sand[2]); // warm
    const grass = blockParticleColor(BLOCK.GRASS_BLOCK);
    expect(grass[1]).toBeGreaterThan(grass[0]);
    expect(blockParticleColor(999)).toEqual(blockParticleColor(BLOCK.AIR));
  });
});

describe('fallingRenderer: capacity growth keeps this frame’s instances (FR-3)', () => {
  /** @returns {number} drawn instances of `mesh` not at their item's position */
  function wrongInstances(mesh, items) {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let wrong = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (Math.abs(p.x - items[i].x) + Math.abs(p.y - items[i].y) + Math.abs(p.z - items[i].z) > 1e-6) wrong++;
    }
    return wrong;
  }

  it('the sync that grows a mesh (16 → 32 → 64 → 128) draws every block where it is, not at the world origin', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const items = (n) => Array.from({ length: n }, (_, i) => item(BLOCK.SAND, 100 + i, 80.5, -50 - i, { ry: 0.25 * i }));
    for (const n of [16, 17, 33, 40, 65]) {
      const list = items(n);
      fr.sync(list, n); // the growing sync itself, not the one after it
      const mesh = scene.getObjectByName('falling:8:opaque');
      expect(mesh.count, `sync(${n})`).toBe(n);
      expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(n);
      expect(wrongInstances(mesh, list), `sync(${n})`).toBe(0);
    }
    expect(scene.children.filter((o) => o.name === 'falling:8:opaque')).toHaveLength(1); // the outgrown meshes are gone
    const glass = Array.from({ length: 20 }, (_, i) => item(BLOCK.GLASS, i, 30, i));
    fr.sync(glass, 20);
    expect(wrongInstances(scene.getObjectByName('falling:12:cutout'), glass)).toBe(0);
    fr.dispose();
  });
});

describe('prewarm: no shader compile on the first falling block / particle (FR-4)', () => {
  const posScale = (mesh, i) => {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(i, m);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), s);
    return { p, s };
  };

  it('fallingRenderer.prewarm compiles one mesh per render layer against the real scene before anything falls', async () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0, 1, 100);
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await fr.prewarm({ compileAsync: (obj, cam, target) => { calls.push({ obj, cam, target }); return Promise.resolve(obj); } }, camera);
    expect(PREWARM_IDS).toEqual([BLOCK.SAND, BLOCK.GLASS, BLOCK.ICE]);
    // three's compile walks each object: every layer's material, on an InstancedMesh (the variant sync draws).
    const layers = new Set();
    for (const c of calls) {
      expect(c.cam).toBe(camera);
      expect(c.target).toBe(scene);
      c.obj.traverse((o) => { if (o.isInstancedMesh) layers.add(o.name.split(':')[2]); });
    }
    expect([...layers].sort()).toEqual(['cutout', 'opaque', 'translucent']);
    const materials = new Set(calls.map((c) => c.obj.material));
    expect(materials.size).toBe(3); // the renderer's three materials, shared by every block id of that layer
    fr.sync([item(BLOCK.OAK_LEAVES, 0, 10, 0), item(BLOCK.STONE, 0, 11, 0)]);
    expect(materials.has(scene.getObjectByName('falling:11:cutout').material)).toBe(true);
    expect(materials.has(scene.getObjectByName('falling:1:opaque').material)).toBe(true);
    fr.dispose();
  });

  it('each warm mesh draws one hidden instance until it has been rendered once; sync([], 0) on load keeps it', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    fr.prewarm(null, new THREE.PerspectiveCamera());
    const warm = scene.children.filter((o) => o.isInstancedMesh);
    expect(warm.map((m) => m.name).sort()).toEqual(['falling:12:cutout', 'falling:41:translucent', 'falling:8:opaque']);
    const check = () => {
      for (const m of warm) {
        expect(m.visible).toBe(true);
        expect(m.count).toBe(1);
        const { p, s } = posScale(m, 0);
        expect(p.y).toBeLessThan(-1000); // far below the world: clipped, nothing on screen
        expect(s.x).toBeLessThan(1e-3);
      }
    };
    check();
    fr.sync([], 0); // main, on world load
    fr.sync([], 0);
    check();
    expect(fr.count()).toBe(0); // not a falling block
    // three calls onAfterRender after drawing an object: back to drawing nothing.
    for (const m of warm) m.onAfterRender();
    for (const m of warm) {
      expect(m.count).toBe(0);
      expect(m.visible).toBe(false);
    }
    fr.sync([], 0);
    expect(warm.every((m) => !m.visible)).toBe(true);
    fr.dispose();
  });

  it('a block that falls before the first render replaces the warm instance (and keeps drawing after it)', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    fr.prewarm(null, new THREE.PerspectiveCamera());
    fr.sync([item(BLOCK.SAND, 3, 40, 5)]);
    const sand = scene.getObjectByName('falling:8:opaque');
    sand.onAfterRender();
    expect(sand.count).toBe(1);
    expect(sand.visible).toBe(true);
    expect(posScale(sand, 0).p.toArray()).toEqual([3, 40, 5]);
    fr.sync([], 0);
    expect(sand.visible).toBe(false);
    fr.dispose();
  });

  it('fallingRenderer.prewarm falls back to compile and never throws', async () => {
    const camera = new THREE.PerspectiveCamera();
    const fr = createFallingRenderer(new THREE.Scene(), new THREE.Texture());
    let compiled = 0;
    await fr.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(3);
    await expect(fr.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(fr.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(fr.prewarm(null, camera)).resolves.toBeUndefined();
    fr.dispose();
  });

  it('particles.prewarm compiles the Points and draws one dead point (size 0) until the first render', async () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0, 1, 100);
    const ps = createParticles(scene, { random: () => 0.5 });
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await ps.prewarm({ compileAsync: (obj, cam, target) => { calls.push([obj, cam, target]); return Promise.resolve(obj); } }, camera);
    expect(calls).toEqual([[ps.points, camera, scene]]);
    const g = ps.points.geometry;
    const warm = () => {
      expect(ps.points.visible).toBe(true);
      expect(g.drawRange.count).toBe(1);
      expect(g.getAttribute('palpha').getX(0)).toBe(0); // the vertex shader gives it gl_PointSize 0
    };
    warm();
    ps.clear(); // main, on world load
    ps.update(1 / 60);
    ps.update(0);
    warm();
    expect(ps.count()).toBe(0);
    ps.points.onAfterRender();
    expect(ps.points.visible).toBe(false);
    expect(g.drawRange.count).toBe(0);
    ps.update(1 / 60);
    expect(ps.points.visible).toBe(false);
    ps.emit('dust', 0, 10, 0, 3); // emitting works as before
    ps.update(1 / 60);
    expect(ps.points.visible).toBe(true);
    expect(g.drawRange.count).toBe(3);
    ps.dispose();
  });

  it('particles.prewarm falls back to compile and never throws', async () => {
    const camera = new THREE.PerspectiveCamera();
    const ps = createParticles(new THREE.Scene());
    let compiled = 0;
    await ps.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(1);
    await expect(ps.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(ps.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(ps.prewarm(null, camera)).resolves.toBeUndefined();
    ps.dispose();
  });
});
