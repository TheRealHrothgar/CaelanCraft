// fallingRenderer.js and particles.js — Node only (Three core objects work without WebGL): instancing per block id
// and layer, capacity growth, the explosion light, and the one-Points particle system (CONTRACTS §34.4–§34.5).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PARTICLE_CAPACITY } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { createFallingRenderer } from '../../src/fallingRenderer.js';
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
