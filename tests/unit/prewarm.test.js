// Tests for src/prewarm.js and the renderers' prewarm hooks (KNOWN-ISSUES P1, P2; CONTRACTS §72).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { compileHidden } from '../../src/prewarm.js';
import { createZombieRenderer } from '../../src/zombieRenderer.js';
import { createAnimalRenderer } from '../../src/animalRenderer.js';
import { createPigRenderer } from '../../src/pigRenderer.js';

/** A fake WebGLRenderer that records what was visible (and each InstancedMesh's count) when asked to compile. */
function fakeWebgl(log) {
  return {
    compileAsync(obj, camera, scene) {
      const seen = [];
      obj.traverse((o) => { if (o.isMesh) seen.push({ name: o.name, visible: o.visible, count: o.count }); });
      log.push({ root: obj.name, visible: obj.visible, seen, camera, scene });
      return Promise.resolve();
    },
  };
}

describe('compileHidden', () => {
  it('compiles every object while it is visible with at least one instance, then puts it back as it was', async () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.name = 'g';
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);
    mesh.name = 'm';
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    scene.add(group);
    const log = [];
    const camera = new THREE.PerspectiveCamera();
    await compileHidden([group, null], fakeWebgl(log), camera, scene);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ root: 'g', visible: true, camera, scene });
    expect(log[0].seen).toEqual([{ name: 'm', visible: true, count: 1 }]);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
    // without a compiler, or with one that throws, it still resolves and restores
    await compileHidden([group], null, camera, scene);
    await compileHidden([group], { compile() { throw new Error('lost context'); } }, camera, scene);
    await compileHidden([group], { compileAsync: () => Promise.reject(new Error('no')) }, camera, scene);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
  });
});

describe('the mob renderers prewarm every one of their meshes', () => {
  for (const [name, make] of [['zombie', createZombieRenderer], ['animal', createAnimalRenderer], ['pig', createPigRenderer]]) {
    it(`${name}Renderer.prewarm compiles all its instanced meshes and leaves nothing drawn`, async () => {
      const scene = new THREE.Scene();
      const r = name === 'zombie' ? make(scene, null) : make(scene);
      const log = [];
      await r.prewarm(fakeWebgl(log), new THREE.PerspectiveCamera());
      expect(log).toHaveLength(1);
      expect(log[0].seen.length).toBe(r.group.children.length);
      expect(log[0].seen.every((m) => m.visible && m.count >= 1)).toBe(true);
      expect(r.group.children.every((m) => m.count === 0 && !m.visible)).toBe(true);
      r.dispose();
    });
  }
});
