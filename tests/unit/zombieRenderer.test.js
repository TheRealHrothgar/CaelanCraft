// zombieRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §39.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createZombieRenderer, hexPrismGeometry, FOOT_R, FOOT_H, FOOT_X, TORSO_R, TORSO_H, HEAD_R, HEAD_H, MODEL_HEIGHT,
  NIGHT_GLOW,
} from '../../src/zombieRenderer.js';
import { ZOMBIE_MAX, ZOMBIE_HEIGHT, ATLAS_TILES_PER_ROW } from '../../src/config.js';
import { TILE } from '../../src/blocks.js';

/** A minimal zombie as the renderer reads it. */
const zombie = (x, y, z, extra = {}) => ({ id: 0, x, y, z, yaw: 0, walkPhase: 0, hurt: 0, smoking: false, swing: 0, tilt: 0, mode: 'idle', ...extra });

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

/** Atlas tile under a UV. */
const tileAt = (u, v) => Math.floor(v * ATLAS_TILES_PER_ROW) * ATLAS_TILES_PER_ROW + Math.floor(u * ATLAS_TILES_PER_ROW);

describe('zombie model: four hex-prism blocks', () => {
  it('two feet side by side as wide as the torso, the torso on them, the head on top: 1.9 tall', () => {
    expect(MODEL_HEIGHT).toBeCloseTo(ZOMBIE_HEIGHT, 9);
    expect(4 * FOOT_R + 2 * (FOOT_X - FOOT_R)).toBeCloseTo(2 * TORSO_R, 1); // the pair spans the torso's width
    expect(FOOT_X).toBeGreaterThan(FOOT_R); // the feet do not overlap
    expect(HEAD_R).toBeLessThanOrEqual(TORSO_R);
    expect(FOOT_H).toBeCloseTo(0.56, 9);
    expect(TORSO_H).toBeCloseTo(0.76, 9);
    expect(HEAD_H).toBeCloseTo(0.58, 9);
  });

  it('hexPrismGeometry: a closed hex prism with outward normals; the face tile is on the −Z side only', () => {
    const g = hexPrismGeometry(1, 2, 0, { front: TILE.ZOMBIE_FACE, sides: TILE.ZOMBIE_HEAD_SIDE, top: TILE.ZOMBIE_SCALP, bottom: TILE.ZOMBIE_SOLE });
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    expect(pos.count).toBe(6 * 4 + 2 * 7);
    expect(g.index.count).toBe((6 * 2 + 2 * 6) * 3);
    // Every triangle winds counter-clockwise seen from outside: its geometric normal agrees with the vertex normal.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const idx = g.index.array;
    const faceTiles = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      a.fromBufferAttribute(pos, idx[t]);
      b.fromBufferAttribute(pos, idx[t + 1]);
      c.fromBufferAttribute(pos, idx[t + 2]);
      const geo = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      n.fromBufferAttribute(nor, idx[t]);
      expect(geo.dot(n)).toBeGreaterThan(0.99);
      const f = (v) => (Math.round(v * 100) / 100 + 0).toFixed(2); // + 0 turns −0 into 0
      const key = `${f(n.x)},${f(n.y)},${f(n.z)}`;
      const u = (uv.getX(idx[t]) + uv.getX(idx[t + 1]) + uv.getX(idx[t + 2])) / 3;
      const v = (uv.getY(idx[t]) + uv.getY(idx[t + 1]) + uv.getY(idx[t + 2])) / 3;
      faceTiles.set(key, tileAt(u, v));
    }
    expect(faceTiles.get('0.00,0.00,-1.00')).toBe(TILE.ZOMBIE_FACE); // the front
    expect(faceTiles.get('0.00,1.00,0.00')).toBe(TILE.ZOMBIE_SCALP);
    expect(faceTiles.get('0.00,-1.00,0.00')).toBe(TILE.ZOMBIE_SOLE);
    const sides = [...faceTiles].filter(([k]) => k.split(',')[1] === '0.00' && k !== '0.00,0.00,-1.00');
    expect(sides).toHaveLength(5);
    for (const [, t] of sides) expect(t).toBe(TILE.ZOMBIE_HEAD_SIDE);
    // The front face shows its tile upright and unmirrored seen from the front (−Z): u grows toward −X, v downward.
    const front = [];
    for (let i = 0; i < pos.count; i++) if (nor.getZ(i) < -0.99) front.push([pos.getX(i), pos.getY(i), uv.getX(i), uv.getY(i)]);
    const left = front.filter((p) => p[0] > 0); // the viewer's left (+X) seen from −Z
    const top = front.filter((p) => p[1] > 1);
    expect(Math.max(...left.map((p) => p[2]))).toBeLessThan(Math.min(...front.filter((p) => p[0] < 0).map((p) => p[2])));
    expect(Math.max(...top.map((p) => p[3]))).toBeLessThan(Math.min(...front.filter((p) => p[1] < 1).map((p) => p[3])));
    g.dispose();
  });
});

describe('createZombieRenderer — instanced zombie models', () => {
  it('draws ZOMBIE_MAX zombies with 3 draw calls: feet (2 each), torso, head', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const list = Array.from({ length: ZOMBIE_MAX }, (_, i) => zombie(i, 10, -i, { id: i + 1, yaw: i * 0.3, walkPhase: i }));
    r.sync(list);
    expect(r.count()).toBe(ZOMBIE_MAX);
    expect(drawn(scene).map((m) => m.name).sort()).toEqual(['zombie-feet', 'zombie-head', 'zombie-torso']);
    let objects = 0;
    scene.traverse((o) => { if (o.isMesh) objects++; });
    expect(objects).toBe(9); // three parts × (normal, hurt, burning) — whatever the number of zombies
    expect(byName(r, 'zombie-feet').count).toBe(ZOMBIE_MAX * 2);
    expect(byName(r, 'zombie-torso').count).toBe(ZOMBIE_MAX);
    r.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('stacks the parts: feet from the ground to the hips either side, torso on the hips, head on the torso', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(3, 64, -2, { yaw: Math.PI / 2 })]);
    const m = new THREE.Matrix4();
    byName(r, 'zombie-torso').getMatrixAt(0, m);
    const torso = translation(m);
    expect(torso.y).toBeCloseTo(64 + FOOT_H, 5);
    byName(r, 'zombie-head').getMatrixAt(0, m);
    const head = translation(m);
    expect(head.y).toBeCloseTo(64 + FOOT_H + TORSO_H, 1); // leaning a little forward
    expect(Math.hypot(head.x - 3, head.z + 2)).toBeLessThan(0.15);
    const feet = byName(r, 'zombie-feet');
    const hips = [0, 1].map((i) => {
      feet.getMatrixAt(i, m);
      return translation(m);
    });
    for (const hip of hips) expect(hip.y).toBeCloseTo(64 + FOOT_H, 5);
    // At yaw π/2 the zombie faces −X: its feet sit either side along Z.
    expect(Math.abs(hips[0].z - hips[1].z)).toBeCloseTo(2 * FOOT_X, 5);
    expect(hips[0].x).toBeCloseTo(3, 5);
    // The model's −Z (its face) points along yawToForward(π/2) = (−1, 0, 0).
    byName(r, 'zombie-head').getMatrixAt(0, m);
    const face = new THREE.Vector3(0, 0, -1).transformDirection(m);
    expect(face.x).toBeLessThan(-0.95);
    r.dispose();
  });

  it('swings the feet with walkPhase in opposite directions and stands them straight at walkPhase 0', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const feet = byName(r, 'zombie-feet');
    const m = new THREE.Matrix4();
    const angle = (i) => {
      feet.getMatrixAt(i, m);
      const down = new THREE.Vector3(0, -1, 0).transformDirection(m);
      return Math.atan2(-down.z, -down.y);
    };
    r.sync([zombie(0, 10, 0, { walkPhase: Math.PI / 2 })]);
    expect(angle(0)).toBeCloseTo(-angle(1), 5);
    expect(Math.abs(angle(0))).toBeGreaterThan(0.4);
    r.sync([zombie(0, 10, 0, { walkPhase: 0 })]);
    expect(Math.abs(angle(0))).toBeLessThan(1e-6);
    r.dispose();
  });

  it('a hurt zombie flashes red and a smouldering one glows, on their own instanced twins', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0, { id: 1 }), zombie(2, 10, 0, { id: 2, hurt: 0.2 }), zombie(4, 10, 0, { id: 3, smoking: true })]);
    expect(byName(r, 'zombie-torso').count).toBe(1);
    expect(byName(r, 'zombie-torso-hurt').count).toBe(1);
    expect(byName(r, 'zombie-torso-burn').count).toBe(1);
    expect(byName(r, 'zombie-feet-hurt').count).toBe(2);
    expect(byName(r, 'zombie-head-hurt').material.emissive.getHex()).toBe(0xff2a2a);
    expect(byName(r, 'zombie-head').material.emissive.getHex()).toBe(NIGHT_GLOW); // a faint glow of its own texture
    expect(drawn(scene)).toHaveLength(9);
    r.sync([zombie(0, 10, 0)]);
    expect(drawn(scene)).toHaveLength(3);
    r.sync([]);
    expect(drawn(scene)).toHaveLength(0);
    r.dispose();
  });

  it('textures every part from the block atlas', () => {
    const scene = new THREE.Scene();
    const atlas = new THREE.Texture();
    const r = createZombieRenderer(scene, atlas);
    for (const name of ['zombie-feet', 'zombie-torso', 'zombie-head', 'zombie-head-hurt']) expect(byName(r, name).material.map).toBe(atlas);
    expect(byName(r, 'zombie-head').material.emissiveMap).toBe(atlas);
    r.dispose();
  });
});
