// pigRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §30.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPigRenderer } from '../../src/pigRenderer.js';
import { PIG_MAX } from '../../src/config.js';

/** A minimal pig as the renderer reads it. */
const pig = (x, y, z, extra = {}) => ({ id: 0, x, y, z, yaw: 0, walkPhase: 0, hurt: 0, ...extra });

/** Instanced meshes three would draw: one draw call each. */
function drawn(scene) {
  /** @type {THREE.InstancedMesh[]} */
  const out = [];
  scene.traverse((o) => {
    if (o.isMesh && o.visible && (!o.isInstancedMesh || o.count > 0)) out.push(/** @type {any} */ (o));
  });
  return out;
}

const byName = (r, name) => r.group.children.find((m) => m.name === name);
const translation = (m) => new THREE.Vector3().setFromMatrixPosition(m);

describe('createPigRenderer — instanced pig models', () => {
  it('draws PIG_MAX pigs with 3 draw calls (no per-pig meshes)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const pigs = Array.from({ length: PIG_MAX }, (_, i) => pig(i, 10, -i, { id: i + 1, yaw: i * 0.3, walkPhase: i }));
    r.sync(pigs);
    expect(r.count()).toBe(PIG_MAX);
    const meshes = drawn(scene);
    expect(meshes.map((m) => m.name).sort()).toEqual(['pig-features', 'pig-legs', 'pig-skin']);
    let objects = 0;
    scene.traverse((o) => { if (o.isMesh) objects++; });
    expect(objects).toBe(5); // skin, features, legs and their two hurt twins — whatever the number of pigs
    expect(byName(r, 'pig-skin').count).toBe(PIG_MAX);
    expect(byName(r, 'pig-legs').count).toBe(PIG_MAX * 4);
    r.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('places each pig at its feet, turned by its yaw (facing −Z at yaw 0)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    r.sync([pig(3, 64, -2, { yaw: Math.PI / 2 })]);
    const m = new THREE.Matrix4();
    byName(r, 'pig-skin').getMatrixAt(0, m);
    expect(translation(m).toArray()).toEqual([3, 64, -2]);
    // The model's −Z (its snout) points along yawToForward(π/2) = (−1, 0, 0).
    const snout = new THREE.Vector3(0, 0, -1).transformDirection(m);
    expect(snout.x).toBeCloseTo(-1, 6);
    expect(snout.z).toBeCloseTo(0, 6);
    r.dispose();
  });

  it('keeps the parts and colours of the old 16-mesh model (merged by material)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const skin = byName(r, 'pig-skin');
    const features = byName(r, 'pig-features');
    // body (6-sided cylinder) + head + tail + 2 ears; snout + 2 nostrils + 2 eyes + 2 pupils.
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 6).getAttribute('position').count;
    const box = new THREE.BoxGeometry(1, 1, 1).getAttribute('position').count;
    expect(skin.geometry.getAttribute('position').count).toBe(cyl + 4 * box);
    expect(features.geometry.getAttribute('position').count).toBe(7 * box);
    expect(skin.material.color.getHex()).toBe(0xf2a7b5);
    expect(features.material.vertexColors).toBe(true);
    const colors = new Set();
    const col = features.geometry.getAttribute('color');
    const c = new THREE.Color();
    for (let i = 0; i < col.count; i++) colors.add(c.setRGB(col.getX(i), col.getY(i), col.getZ(i)).getHex());
    expect([...colors].sort()).toEqual([0x3a1f26, 0xe0808f, 0xffffff].sort());
    r.dispose();
  });

  it('flashes a hurt pig red (skin and legs only) and puts it back afterwards', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const a = pig(0, 10, 0, { id: 1 });
    const b = pig(2, 10, 0, { id: 2, hurt: 0.3 });
    r.sync([a, b]);
    const hurt = byName(r, 'pig-skin-hurt');
    expect(hurt.count).toBe(1);
    expect(byName(r, 'pig-legs-hurt').count).toBe(4);
    expect(byName(r, 'pig-skin').count).toBe(1);
    expect(byName(r, 'pig-features').count).toBe(2); // eyes and snout never flash
    expect(hurt.material.emissive.getHex()).toBe(0xff2a2a);
    expect(hurt.material.emissiveIntensity).toBeCloseTo(0.6, 9);
    expect(byName(r, 'pig-skin').material.emissive.getHex()).toBe(0);
    const m = new THREE.Matrix4();
    hurt.getMatrixAt(0, m);
    expect(translation(m).x).toBe(2);
    b.hurt = 0;
    r.sync([a, b]);
    expect(hurt.count).toBe(0);
    expect(hurt.visible).toBe(false);
    expect(byName(r, 'pig-skin').count).toBe(2);
    r.dispose();
  });

  it('swings diagonal leg pairs with sin(walkPhase) about the hip, and stands them straight at walkPhase 0', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const legs = byName(r, 'pig-legs');
    const m = new THREE.Matrix4();
    const angle = (i) => {
      legs.getMatrixAt(i, m);
      const down = new THREE.Vector3(0, -1, 0).transformDirection(m);
      return Math.atan2(-down.z, -down.y); // the leg's rotation.x in the old model (+ swings the foot toward −z)
    };
    r.sync([pig(0, 10, 0, { walkPhase: Math.PI / 2 })]);
    const swing = 0.6;
    // (instance matrices are float32)
    expect([0, 1, 2, 3].map(angle).map((v) => +v.toFixed(5))).toEqual([swing, -swing, -swing, swing]);
    legs.getMatrixAt(0, m);
    expect(translation(m).y).toBeCloseTo(10.3, 5); // the hip, at the top of the leg
    r.sync([pig(0, 10, 0, { walkPhase: Math.PI })]);
    for (let i = 0; i < 4; i++) expect(Math.abs(angle(i))).toBeLessThan(1e-6);
    r.dispose();
  });

  it('follows the list: fewer pigs, no pigs, more than the capacity', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene, 4);
    r.sync([pig(0, 0, 0), pig(1, 0, 0), pig(2, 0, 0)]);
    expect(r.count()).toBe(3);
    r.sync([]);
    expect(r.count()).toBe(0);
    expect(drawn(scene)).toHaveLength(0);
    r.sync(Array.from({ length: 9 }, (_, i) => pig(i, 0, 0)));
    expect(r.count()).toBe(4);
    expect(byName(r, 'pig-legs').count).toBe(16);
    r.dispose();
  });
});
