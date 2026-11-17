// pigRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §30, §69.1.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPigRenderer, renderScaleOf, renderSpinOf } from '../../src/pigRenderer.js';
import { faunaAssets, FAUNA_PROGRAM, YOUNG_HEAD } from '../../src/animalRenderer.js';
import { ANIMAL_RIGS, ANIMAL_ATLAS } from '../../src/animalModels.js';
import { PIG_HEAD_BOX } from '../../src/pigs.js';
import { PIG_MAX, MAX_INFALL_MOBS } from '../../src/config.js';

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
    expect(meshes.map((m) => m.name).sort()).toEqual(['pig-head', 'pig-legs', 'pig-skin']);
    let objects = 0;
    scene.traverse((o) => { if (o.isMesh) objects++; });
    // skin, head, legs, their three hurt twins, (§88) the boars' tusks, a tame one's ribbon and a snared one's loop —
    // whatever the number of pigs
    expect(objects).toBe(9);
    expect(byName(r, 'pig-skin').count).toBe(PIG_MAX);
    expect(byName(r, 'pig-head').count).toBe(PIG_MAX);
    expect(byName(r, 'pig-legs').count).toBe(PIG_MAX * 4);
    r.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('§88: a grown boar has tusks (one more draw call), a sow and a piglet none; a piglet is drawn at its size', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    r.sync([pig(0, 10, 0, { sex: 'f' }), pig(2, 10, 0, { sex: 'm' }), pig(4, 10, 0, { sex: 'm', size: 0.6 })]);
    expect(byName(r, 'pig-tusks').count).toBe(1);
    expect(drawn(scene).map((m) => m.name).sort()).toEqual(['pig-head', 'pig-legs', 'pig-skin', 'pig-tusks']);
    const m = new THREE.Matrix4();
    byName(r, 'pig-tusks').getMatrixAt(0, m);
    expect(translation(m).x).toBe(2); // the boar's
    byName(r, 'pig-legs').getMatrixAt(8, m); // the piglet's first leg: the whole pig at its size
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(0.6, 6);
    byName(r, 'pig-skin').getMatrixAt(2, m); // its body a little rounder than that
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeGreaterThan(0.6);
    expect(new THREE.Vector3().setFromMatrixScale(m).z).toBeLessThan(0.6);
    byName(r, 'pig-skin').getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(1, 6);
    r.sync([pig(0, 10, 0, { sex: 'f' })]);
    expect(byName(r, 'pig-tusks').visible).toBe(false);
    r.dispose();
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

  it('is hex-faceted and painted: the animals\' shared atlas, linear filtering with mipmaps, its head inside PIG_HEAD_BOX', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const skin = byName(r, 'pig-skin');
    const head = byName(r, 'pig-head');
    const A = faunaAssets();
    for (const m of [skin, head, byName(r, 'pig-legs')]) {
      expect(m.material.map).toBe(A.texture); // one texture for every animal and the pig
      expect(m.material.vertexColors).toBe(false);
      expect(m.material.customProgramCacheKey()).toBe(FAUNA_PROGRAM);
      expect(m.geometry.getAttribute('uv')).toBeDefined();
    }
    expect([A.texture.image.width, A.texture.image.height]).toEqual([ANIMAL_ATLAS, ANIMAL_ATLAS]);
    expect(A.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(A.texture.magFilter).toBe(THREE.LinearFilter);
    expect(skin.material.color.getHex()).toBe(0xffffff); // the colour is in the atlas
    // a pig's triangles, all told, within the budget; the head (its snout and ears) where the ray test looks for it
    const tris = (m) => m.geometry.index.count / 3;
    expect(tris(skin) + tris(head) + 4 * tris(byName(r, 'pig-legs'))).toBeLessThanOrEqual(800);
    head.geometry.computeBoundingBox();
    const hb = head.geometry.boundingBox;
    expect(hb.min.z).toBeGreaterThan(PIG_HEAD_BOX.z0 - 0.02);
    expect(hb.max.y).toBeLessThan(PIG_HEAD_BOX.y1 + 0.02);
    expect(Math.max(-hb.min.x, hb.max.x)).toBeLessThan(PIG_HEAD_BOX.x + 0.02);
    r.dispose();
  });

  it('roots with its head down while it stands idle, eases back up walking; a piglet\'s head is larger', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const head = byName(r, 'pig-head');
    const m = new THREE.Matrix4();
    const snout = () => {
      head.getMatrixAt(0, m);
      return new THREE.Vector3(0, 0.59, -0.74).applyMatrix4(m);
    };
    const p = pig(0, 10, 0, { mode: 'walk' });
    r.sync([p], 10);
    const level = snout();
    p.mode = 'idle';
    r.sync([p], 0.05);
    const easing = snout();
    r.sync([p], 10);
    const rooting = snout();
    expect(rooting.y).toBeLessThan(level.y - 0.08);
    expect(easing.y).toBeLessThan(level.y);
    expect(easing.y).toBeGreaterThan(rooting.y);
    const piglet = pig(0, 10, 0, { mode: 'walk', size: 0.55 });
    r.sync([piglet], 10);
    head.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(0.55 * (1 + YOUNG_HEAD), 5);
    expect(ANIMAL_RIGS.pig.head.graze).toBeLessThan(0);
    r.dispose();
  });

  it('a tame pig wears a ribbon, a snared one a loop of cord round its left hind trotter (one draw each, only then)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    r.sync([pig(0, 10, 0), pig(2, 10, 0, { tamed: true }), pig(4, 10, 0, { trapped: 30 })]);
    expect(byName(r, 'pig-tag').count).toBe(1);
    expect(byName(r, 'pig-snare').count).toBe(1);
    const m = new THREE.Matrix4();
    byName(r, 'pig-snare').getMatrixAt(0, m);
    const at = translation(m);
    expect(at.x).toBeCloseTo(4 - ANIMAL_RIGS.pig.legX, 1); // the left hind leg
    expect(at.z).toBeGreaterThan(0.1);
    expect(at.y).toBeLessThan(10.15); // low on the trotter
    r.sync([pig(0, 10, 0)]);
    expect(drawn(scene).map((x) => x.name).sort()).toEqual(['pig-head', 'pig-legs', 'pig-skin']);
    r.dispose();
  });

  it('flashes a hurt pig red (skin, head and legs) and puts it back afterwards', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const a = pig(0, 10, 0, { id: 1 });
    const b = pig(2, 10, 0, { id: 2, hurt: 0.3 });
    r.sync([a, b]);
    const hurt = byName(r, 'pig-skin-hurt');
    expect(hurt.count).toBe(1);
    expect(byName(r, 'pig-legs-hurt').count).toBe(4);
    expect(byName(r, 'pig-skin').count).toBe(1);
    expect([byName(r, 'pig-head').count, byName(r, 'pig-head-hurt').count]).toEqual([1, 1]);
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

describe('createPigRenderer — black-hole ghosts (renderScale, renderSpin; DESIGN-circuits §2.7, §6.2.13)', () => {
  /** Every instance matrix of every mesh, as plain arrays. */
  function snapshot(r) {
    const out = {};
    for (const m of r.group.children) out[m.name] = Array.from(m.instanceMatrix.array.slice(0, m.count * 16));
    return out;
  }
  it('without renderScale / renderSpin the output is exactly as before (and 1 / 0 or nonsense change nothing)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    const base = [pig(1, 10, 2, { yaw: 0.7, walkPhase: 1.1 }), pig(-3, 11, 4, { yaw: -2, walkPhase: 0.3, hurt: 0.2 })];
    r.sync(base);
    const plain = snapshot(r);
    r.sync(base.map((p) => ({ ...p, renderScale: 1, renderSpin: 0 })));
    expect(snapshot(r)).toEqual(plain);
    r.sync(base.map((p) => ({ ...p, renderScale: 0, renderSpin: NaN })));
    expect(snapshot(r)).toEqual(plain);
    r.sync(base.map((p) => ({ ...p, renderScale: -2, renderSpin: 'x' })));
    expect(snapshot(r)).toEqual(plain);
    expect([renderScaleOf({}), renderScaleOf({ renderScale: 0.4 }), renderSpinOf({}), renderSpinOf({ renderSpin: 2 })]).toEqual([1, 0.4, 0, 2]);
    r.dispose();
  });
  it('renderScale scales the whole pig about its feet; renderSpin adds to its yaw', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene);
    r.sync([pig(3, 64, -2, { yaw: 0.5, renderScale: 0.25, renderSpin: 1 })]);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    byName(r, 'pig-skin').getMatrixAt(0, m);
    m.decompose(p, q, s);
    expect(p.toArray()).toEqual([3, 64, -2]);
    expect(s.x).toBeCloseTo(0.25, 6);
    expect(new THREE.Euler().setFromQuaternion(q, 'YXZ').y).toBeCloseTo(1.5, 6);
    // The legs shrink with it: the hip is a quarter as high.
    byName(r, 'pig-legs').getMatrixAt(0, m);
    expect(translation(m).y).toBeCloseTo(64 + 0.3 * 0.25, 5);
    r.dispose();
  });
  it('the capacity argument holds PIG_MAX + MAX_INFALL_MOBS bodies (so a ghost is never dropped from a full list)', () => {
    const scene = new THREE.Scene();
    const r = createPigRenderer(scene, PIG_MAX + MAX_INFALL_MOBS);
    const all = Array.from({ length: PIG_MAX + MAX_INFALL_MOBS }, (_, i) => pig(i, 10, 0, { renderScale: i >= PIG_MAX ? 0.5 : undefined }));
    r.sync(all);
    expect(r.count()).toBe(PIG_MAX + MAX_INFALL_MOBS);
    expect(byName(r, 'pig-skin').count).toBe(PIG_MAX + MAX_INFALL_MOBS);
    expect(byName(r, 'pig-legs').count).toBe((PIG_MAX + MAX_INFALL_MOBS) * 4);
    r.dispose();
  });
});
