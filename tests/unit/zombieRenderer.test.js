// zombieRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §39, §61.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createZombieRenderer, zombieGeometries, boxesGeometry, LEG_H, LEG_X, TORSO_H, NECK_H, HEAD_H, HEAD_D, MODEL_HEIGHT,
  ALPHA_SCALE, RUNNER_WIDTH, KIND_TINT, SKIN, ARM_L, SHOULDER_Y,
} from '../../src/zombieRenderer.js';
import { ZOMBIE_MAX, ZOMBIE_HEIGHT, MAX_INFALL_MOBS } from '../../src/config.js';

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
const matrixOf = (mesh, i) => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return m;
};
/** World-space box of a geometry under a matrix. */
const boxUnder = (geo, m) => {
  geo.computeBoundingBox();
  return geo.boundingBox.clone().applyMatrix4(m);
};

describe('zombie model: a cartoon shambler of chunky boxes (no hexagons, no atlas)', () => {
  it('stands under ZOMBIE_HEIGHT: legs to the hips, the torso, the neck, a big head and its hair', () => {
    expect(MODEL_HEIGHT).toBeLessThanOrEqual(ZOMBIE_HEIGHT);
    expect(MODEL_HEIGHT).toBeGreaterThan(ZOMBIE_HEIGHT - 0.15);
    // a big cartoon head: almost as wide as the torso and nearly as tall as it
    expect(HEAD_H / TORSO_H).toBeGreaterThan(0.7);
  });

  it('every part is coloured per vertex, with closed boxes and outward normals; the face is on the −Z side', () => {
    const g = zombieGeometries();
    for (const [name, geo] of Object.entries(g)) {
      expect(geo.getAttribute('color'), name).toBeTruthy();
      expect(geo.getAttribute('uv'), name).toBeUndefined();
      expect(geo.getIndex().count % 36, name).toBe(0); // whole boxes
    }
    // the eyes, the pupils, the mouth and the teeth sit in front of the head's −Z face
    const pos = g.head.getAttribute('position');
    const col = g.head.getAttribute('color');
    const skin = new THREE.Color().setHex(SKIN, THREE.SRGBColorSpace);
    let faceVerts = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) < -HEAD_D / 2 - 0.005) {
        faceVerts++;
        const c = new THREE.Color(col.getX(i), col.getY(i), col.getZ(i));
        expect(c.equals(skin)).toBe(false);
      }
    }
    expect(faceVerts).toBeGreaterThan(8 * 8);
    for (const geo of Object.values(g)) geo.dispose();
  });

  it('boxesGeometry merges boxes with their colours and turns a box about its own centre', () => {
    const g = boxesGeometry([[1, 1, 1, 2, 0, 0, 0xff0000], [2, 0.1, 0.1, 0, 5, 0, 0x00ff00, Math.PI / 2]]);
    g.computeBoundingBox();
    expect(g.boundingBox.min.x).toBeCloseTo(-0.05, 5); // the turned box stands up
    expect(g.boundingBox.max.y).toBeCloseTo(6, 5);
    expect(g.getAttribute('position').count).toBe(48);
    g.dispose();
  });
});

describe('createZombieRenderer — instanced zombie models', () => {
  it('draws ZOMBIE_MAX walkers with 4 draw calls: legs and arms (2 each), torso, head; the alpha eyes only for an alpha', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync(Array.from({ length: ZOMBIE_MAX }, (_, i) => zombie(i * 2, 10, 0)));
    expect(r.count()).toBe(ZOMBIE_MAX);
    const meshes = drawn(scene);
    expect(meshes.map((m) => m.name).sort()).toEqual(['zombie-arms', 'zombie-head', 'zombie-legs', 'zombie-torso']);
    expect(byName(r, 'zombie-legs').count).toBe(ZOMBIE_MAX * 2);
    expect(byName(r, 'zombie-arms').count).toBe(ZOMBIE_MAX * 2);
    r.sync([zombie(0, 10, 0), zombie(3, 10, 0, { kind: 'alpha' })]);
    expect(byName(r, 'zombie-alpha-eyes').count).toBe(1);
    expect(byName(r, 'zombie-alpha-eyes').visible).toBe(true);
    r.sync([]);
    expect(drawn(scene)).toEqual([]);
    r.dispose();
  });

  it('stacks the parts: legs from the ground to the hips, the torso on them, the head on the neck, arms reaching forward', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(4, 20, -3)]);
    const g = zombieGeometries();
    const legs = byName(r, 'zombie-legs');
    for (let k = 0; k < 2; k++) {
      const m = matrixOf(legs, k);
      expect(translation(m).y).toBeCloseTo(20 + LEG_H, 5);
      expect(Math.abs(translation(m).x - 4)).toBeCloseTo(LEG_X, 5);
      expect(boxUnder(g.leg, m).min.y).toBeCloseTo(20, 1); // the shoes on the ground
    }
    const torso = matrixOf(byName(r, 'zombie-torso'), 0);
    expect(translation(torso).y).toBeCloseTo(20 + LEG_H, 5);
    const head = boxUnder(g.head, matrixOf(byName(r, 'zombie-head'), 0));
    expect(head.min.y).toBeGreaterThan(20 + LEG_H + TORSO_H * 0.8);
    expect(head.max.y).toBeLessThanOrEqual(20 + ZOMBIE_HEIGHT + 0.02);
    // the arms reach out in front (−Z at yaw 0), hands about shoulder high
    for (let k = 0; k < 2; k++) {
      const m = matrixOf(byName(r, 'zombie-arms'), k);
      const hand = new THREE.Vector3(0, -ARM_L, 0).applyMatrix4(m);
      expect(hand.z).toBeLessThan(-3 - 0.45);
      expect(Math.abs(hand.y - (20 + LEG_H + SHOULDER_Y))).toBeLessThan(0.15);
    }
    expect(LEG_H + TORSO_H + NECK_H + HEAD_H).toBeLessThan(MODEL_HEIGHT);
    for (const geo of Object.values(g)) geo.dispose();
    r.dispose();
  });

  it('swings the legs with walkPhase in opposite directions, stands them straight at 0, and a walker limps', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const legs = byName(r, 'zombie-legs');
    const angle = (i) => {
      const e = new THREE.Euler().setFromRotationMatrix(matrixOf(legs, i), 'YXZ');
      return e.x;
    };
    r.sync([zombie(0, 10, 0, { walkPhase: 0 })]);
    expect(angle(0)).toBeCloseTo(0, 6);
    expect(angle(1)).toBeCloseTo(0, 6);
    r.sync([zombie(0, 10, 0, { walkPhase: Math.PI / 2 })]);
    expect(Math.sign(angle(0))).toBe(-Math.sign(angle(1)));
    expect(Math.abs(angle(1))).toBeLessThan(Math.abs(angle(0)) * 0.7); // the short stride
    r.sync([zombie(0, 10, 0, { walkPhase: Math.PI / 2, kind: 'runner' })]);
    expect(Math.abs(angle(0))).toBeGreaterThan(0.8); // a runner's long stride
    expect(Math.abs(angle(1))).toBeCloseTo(Math.abs(angle(0)), 6);
    r.dispose();
  });

  it('the kinds: a runner is narrower, paler and leans far forward; an alpha is bigger and darker', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0), zombie(5, 10, 0, { kind: 'runner' }), zombie(10, 10, 0, { kind: 'alpha' })]);
    const torso = byName(r, 'zombie-torso');
    const scale = (i) => new THREE.Vector3().setFromMatrixScale(matrixOf(torso, i));
    expect(scale(0).x).toBeCloseTo(1, 5);
    expect(scale(1).x).toBeCloseTo(RUNNER_WIDTH, 5);
    expect(scale(2).y).toBeCloseTo(ALPHA_SCALE, 5);
    const lean = (i) => new THREE.Euler().setFromRotationMatrix(matrixOf(torso, i), 'YXZ').x;
    expect(lean(1)).toBeLessThan(lean(0) - 0.2);
    const tint = (i) => {
      const c = new THREE.Color();
      torso.getColorAt(i, c);
      return c.getHex();
    };
    expect(tint(0)).toBe(new THREE.Color(KIND_TINT.walker).getHex());
    expect(tint(1)).toBe(new THREE.Color(KIND_TINT.runner).getHex());
    expect(tint(2)).toBe(new THREE.Color(KIND_TINT.alpha).getHex());
    r.dispose();
  });

  it('a hurt zombie flashes red and a smouldering one glows, on their own instanced twins', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0), zombie(2, 10, 0, { hurt: 0.3 }), zombie(4, 10, 0, { smoking: true })]);
    expect(byName(r, 'zombie-head').count).toBe(1);
    expect(byName(r, 'zombie-head-hurt').count).toBe(1);
    expect(byName(r, 'zombie-head-burn').count).toBe(1);
    expect(byName(r, 'zombie-legs-hurt').count).toBe(2);
    expect(byName(r, 'zombie-arms-burn').count).toBe(2);
    expect(byName(r, 'zombie-head-hurt').material.emissive.r).toBeGreaterThan(0.9);
    expect(byName(r, 'zombie-head-burn').material.emissive.g).toBeGreaterThan(0.1);
    r.dispose();
  });

  it('a strike swipes the arms up and lurches the torso', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const arm = byName(r, 'zombie-arms');
    const torso = byName(r, 'zombie-torso');
    const hand = () => new THREE.Vector3(0, -ARM_L, 0).applyMatrix4(matrixOf(arm, 0));
    r.sync([zombie(0, 10, 0)]);
    const restHand = hand().y;
    const restLean = new THREE.Euler().setFromRotationMatrix(matrixOf(torso, 0), 'YXZ').x;
    r.sync([zombie(0, 10, 0, { swing: 0.175 })]); // half way through SWING_S 0.35
    expect(hand().y).toBeGreaterThan(restHand + 0.1);
    expect(new THREE.Euler().setFromRotationMatrix(matrixOf(torso, 0), 'YXZ').x).toBeLessThan(restLean - 0.2);
    r.dispose();
  });
});

describe('createZombieRenderer — black-hole ghosts (renderScale, renderSpin; DESIGN-circuits §2.7, §6.2.13)', () => {
  function snapshot(r) {
    const out = {};
    for (const m of r.group.children) out[m.name] = Array.from(m.instanceMatrix.array.slice(0, m.count * 16));
    return out;
  }
  it('without renderScale / renderSpin the output is exactly as before (and 1 / 0 or nonsense change nothing)', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const base = [
      zombie(1, 10, 2, { yaw: 0.7, walkPhase: 1.1, tilt: 0.1, mode: 'chase' }),
      zombie(-3, 11, 4, { yaw: -2, walkPhase: 0.3, hurt: 0.2, swing: 0.1, kind: 'runner' }),
      zombie(5, 11, 4, { smoking: true, kind: 'alpha' }),
    ];
    r.sync(base);
    const plain = snapshot(r);
    r.sync(base.map((z) => ({ ...z, renderScale: 1, renderSpin: 0 })));
    expect(snapshot(r)).toEqual(plain);
    r.sync(base.map((z) => ({ ...z, renderScale: 0, renderSpin: Infinity })));
    expect(snapshot(r)).toEqual(plain);
    r.dispose();
  });
  it('renderScale scales the whole zombie about its feet; renderSpin adds to its yaw', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(3, 64, -2, { yaw: 0.5, renderScale: 0.5, renderSpin: -1 })]);
    const m = matrixOf(byName(r, 'zombie-torso'), 0);
    expect(translation(m).y).toBeCloseTo(64 + LEG_H * 0.5, 5); // the hips, half as high
    expect(new THREE.Vector3().setFromMatrixScale(m).y).toBeCloseTo(0.5, 5);
    const hip = translation(matrixOf(byName(r, 'zombie-legs'), 0));
    // The legs sit either side of the middle, turned by yaw + spin = −0.5: their offset is ⊥ to the facing direction.
    const side = new THREE.Vector3(hip.x - 3, 0, hip.z + 2);
    const facing = new THREE.Vector3(-Math.sin(-0.5), 0, -Math.cos(-0.5));
    expect(side.dot(facing)).toBeCloseTo(0, 5);
    expect(side.length()).toBeCloseTo(LEG_X * 0.5, 5);
    r.dispose();
  });
  it('the capacity argument holds ZOMBIE_MAX + MAX_INFALL_MOBS bodies', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null, ZOMBIE_MAX + MAX_INFALL_MOBS);
    r.sync(Array.from({ length: ZOMBIE_MAX + MAX_INFALL_MOBS + 3 }, (_, i) => zombie(i, 10, 0, { kind: 'alpha' })));
    expect(r.count()).toBe(ZOMBIE_MAX + MAX_INFALL_MOBS);
    expect(byName(r, 'zombie-legs').count).toBe((ZOMBIE_MAX + MAX_INFALL_MOBS) * 2);
    expect(byName(r, 'zombie-alpha-eyes').count).toBe(ZOMBIE_MAX + MAX_INFALL_MOBS);
    r.dispose();
  });
});
