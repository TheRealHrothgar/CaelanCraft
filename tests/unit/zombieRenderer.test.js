// zombieRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §39, §61, §74.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createZombieRenderer, zombieGeometries, skinBox, boxesGeometry, LEG_H, LEG_X, TORSO_W, TORSO_H, HEAD_W, HEAD_H, MODEL_HEIGHT,
  UPPER_L, FORE_L, ARM_L, SHOULDER_X, SHOULDER_Y, ALPHA_SCALE, RUNNER_WIDTH, SHIRT_TINTS, ARMS, GLOW_DAY,
  twitchOf, TWITCH_HZ, TWITCH_PART, TWITCH_ANGLE, HEAD_D, HAIR_PUFF, shieldOf, SHIELD_ARM, SHIELD_NOD, SHIELD_ROLL,
} from '../../src/zombieRenderer.js';
import { PARTS, faceRect, SKIN_H, SKIN_KINDS, ATLAS_W, ATLAS_H, SKIN_TEXEL, EYE_ROW } from '../../src/zombieSkin.js';
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
const FIVE = (kind, suffix = '') => ['forearms', 'head', 'legs', 'torso', 'upper-arms'].map((p) => `zombie-${p}-${kind}${suffix}`);
/** The forearm's width (m), from the skin's box. */
const FORE_W = PARTS.foreArm.w * SKIN_TEXEL;

describe('zombie model: a few boxes wrapped in pixel art (no hexagons)', () => {
  it('stands under ZOMBIE_HEIGHT with a grown body: a small head on wide shoulders, long legs, arms to mid thigh', () => {
    expect(MODEL_HEIGHT).toBeLessThanOrEqual(ZOMBIE_HEIGHT);
    expect(MODEL_HEIGHT).toBeGreaterThan(ZOMBIE_HEIGHT - 0.15);
    expect(MODEL_HEIGHT / HEAD_H).toBeGreaterThan(4.3); // not a child
    expect(HEAD_W).toBeLessThan(TORSO_W * 0.85);
    expect(SHOULDER_X * 2).toBeGreaterThan(HEAD_W * 1.5);
    expect(LEG_H).toBeGreaterThan(TORSO_H);
    expect(ARM_L).toBeCloseTo(UPPER_L + FORE_L, 9);
    const fingertips = LEG_H + SHOULDER_Y - ARM_L;
    expect(fingertips).toBeLessThan(LEG_H * 0.9);
    expect(fingertips).toBeGreaterThan(LEG_H * 0.4);
    // every size is a whole number of the skin's texels
    for (const v of [LEG_H, TORSO_W, TORSO_H, HEAD_W, HEAD_H, UPPER_L, FORE_L]) expect(v / SKIN_TEXEL).toBeCloseTo(Math.round(v / SKIN_TEXEL), 9);
  });

  it('every part is a textured box on its own kind\'s page: uv, no vertex colours, whole boxes', () => {
    SKIN_KINDS.forEach((kind, page) => {
      const g = zombieGeometries(kind);
      for (const [name, geo] of Object.entries(g)) {
        expect(geo.getAttribute('uv'), name).toBeTruthy();
        expect(geo.getAttribute('color'), name).toBeUndefined();
        expect(geo.getIndex().count % 36, name).toBe(0);
        const uv = geo.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) {
          expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
          expect(uv.getX(i)).toBeLessThanOrEqual(1);
          expect(uv.getY(i) * ATLAS_H).toBeGreaterThanOrEqual(page * SKIN_H);
          expect(uv.getY(i) * ATLAS_H).toBeLessThanOrEqual((page + 1) * SKIN_H);
        }
      }
      // the head carries its hair layer, the alpha's torso its coat; the rest are one box
      expect(g.head.getIndex().count).toBe(72);
      expect(g.torso.getIndex().count).toBe(kind === 'alpha' ? 72 : 36);
      for (const name of ['leg', 'upperArm', 'foreArm']) expect(g[name].getIndex().count).toBe(36);
      for (const geo of Object.values(g)) geo.dispose();
    });
  });

  it('skinBox maps each side of the box to that face of the unwrap; the model\'s front is −Z', () => {
    const g = skinBox('head', 'runner');
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const page = SKIN_KINDS.indexOf('runner') * SKIN_H;
    const faceOf = (i) => {
      const n = [nor.getX(i), nor.getY(i), nor.getZ(i)];
      return n[2] < -0.5 ? 'front' : n[2] > 0.5 ? 'back' : n[0] > 0.5 ? 'right' : n[0] < -0.5 ? 'left' : n[1] > 0.5 ? 'top' : 'bottom';
    };
    for (let i = 0; i < pos.count; i++) {
      const r = faceRect(PARTS.head, faceOf(i));
      const px = uv.getX(i) * ATLAS_W;
      const py = uv.getY(i) * ATLAS_H - page;
      expect(px).toBeGreaterThanOrEqual(r.x);
      expect(px).toBeLessThanOrEqual(r.x + r.w);
      expect(py).toBeGreaterThanOrEqual(r.y);
      expect(py).toBeLessThanOrEqual(r.y + r.h);
      // upright: the top edge of a side face is the top row of its rect
      if (faceOf(i) === 'front') expect(py < r.y + r.h / 2).toBe(pos.getY(i) > 0);
    }
    // seen from in front (the viewer at −Z), the picture's left edge is at +X
    for (let i = 0; i < pos.count; i++) {
      if (faceOf(i) !== 'front') continue;
      const r = faceRect(PARTS.head, 'front');
      expect(uv.getX(i) * ATLAS_W < r.x + r.w / 2).toBe(pos.getX(i) > 0);
    }
    const puffed = skinBox('hair', 'walker', { puff: 0.01, y: 1 });
    puffed.computeBoundingBox();
    expect(puffed.boundingBox.max.x).toBeCloseTo(HEAD_W / 2 + 0.01, 6);
    expect(puffed.boundingBox.min.y).toBeCloseTo(1 - HEAD_H / 2 - 0.01, 6);
    g.dispose();
    puffed.dispose();
  });

  it('boxesGeometry (the animals\' builder) merges boxes with their colours and turns a box about its own centre', () => {
    const g = boxesGeometry([[1, 1, 1, 2, 0, 0, 0xff0000], [2, 0.1, 0.1, 0, 5, 0, 0x00ff00, Math.PI / 2]]);
    g.computeBoundingBox();
    expect(g.boundingBox.min.x).toBeCloseTo(-0.05, 5); // the turned box stands up
    expect(g.boundingBox.max.y).toBeCloseTo(6, 5);
    expect(g.getAttribute('position').count).toBe(48);
    g.dispose();
  });
});

describe('createZombieRenderer — instanced zombie models', () => {
  it('draws ZOMBIE_MAX walkers with 5 draw calls; each kind about adds its own five', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync(Array.from({ length: ZOMBIE_MAX }, (_, i) => zombie(i * 2, 10, 0)));
    expect(r.count()).toBe(ZOMBIE_MAX);
    expect(drawn(scene).map((m) => m.name).sort()).toEqual(FIVE('walker'));
    expect(byName(r, 'zombie-legs-walker').count).toBe(ZOMBIE_MAX * 2);
    expect(byName(r, 'zombie-upper-arms-walker').count).toBe(ZOMBIE_MAX * 2);
    expect(byName(r, 'zombie-forearms-walker').count).toBe(ZOMBIE_MAX * 2);
    r.sync([zombie(0, 10, 0), zombie(3, 10, 0, { kind: 'alpha' }), zombie(6, 10, 0, { kind: 'runner' }), zombie(9, 10, 0, { kind: 'runner' })]);
    expect(drawn(scene).map((m) => m.name).sort()).toEqual([...FIVE('walker'), ...FIVE('runner'), ...FIVE('alpha')].sort());
    expect(byName(r, 'zombie-head-runner').count).toBe(2);
    expect(byName(r, 'zombie-head-alpha').count).toBe(1);
    r.sync([]);
    expect(drawn(scene)).toEqual([]);
    r.dispose();
  });

  it('one pixel-art texture for every part: nearest filtering, sRGB, cut out where a layer is empty; the eyes glow', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const mat = byName(r, 'zombie-head-walker').material;
    for (const name of [...FIVE('walker'), ...FIVE('runner'), ...FIVE('alpha')]) expect(byName(r, name).material).toBe(mat);
    expect(mat.map.isDataTexture).toBe(true);
    expect([mat.map.image.width, mat.map.image.height]).toEqual([ATLAS_W, ATLAS_H]);
    expect(mat.map.magFilter).toBe(THREE.NearestFilter);
    expect(mat.map.minFilter).toBe(THREE.NearestFilter);
    expect(mat.map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(mat.alphaTest).toBeGreaterThan(0);
    expect(mat.emissiveMap.isDataTexture).toBe(true);
    expect(mat.vertexColors).toBe(false);
    // the glow follows the dark: full at night (the default), GLOW_DAY in full daylight
    r.sync([zombie(0, 10, 0)]);
    expect(mat.emissiveIntensity).toBe(1);
    r.sync([zombie(0, 10, 0)], 0, 0);
    expect(mat.emissiveIntensity).toBeCloseTo(GLOW_DAY, 9);
    r.sync([zombie(0, 10, 0)], 0, 0.5);
    expect(mat.emissiveIntensity).toBeCloseTo(GLOW_DAY + (1 - GLOW_DAY) * 0.5, 9);
    r.sync([zombie(0, 10, 0)], 0, NaN);
    expect(mat.emissiveIntensity).toBe(1);
    expect(GLOW_DAY).toBeLessThan(0.35);
    r.dispose();
  });

  it('stacks the parts: legs from the ground to the hips, the torso on them, the head on the torso, forearms from the elbows', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(4, 20, -3, { mode: 'chase' })]);
    const g = zombieGeometries('walker');
    const legs = byName(r, 'zombie-legs-walker');
    for (let k = 0; k < 2; k++) {
      const m = matrixOf(legs, k);
      expect(translation(m).y).toBeCloseTo(20 + LEG_H, 5);
      expect(Math.abs(translation(m).x - 4)).toBeCloseTo(LEG_X, 5);
      expect(boxUnder(g.leg, m).min.y).toBeCloseTo(20, 1); // the shoes on the ground
    }
    const torso = matrixOf(byName(r, 'zombie-torso-walker'), 0);
    expect(translation(torso).y).toBeCloseTo(20 + LEG_H, 5);
    const head = boxUnder(g.head, matrixOf(byName(r, 'zombie-head-walker'), 0));
    expect(head.min.y).toBeGreaterThan(20 + LEG_H + TORSO_H * 0.8);
    expect(head.max.y).toBeLessThanOrEqual(20 + ZOMBIE_HEIGHT + 0.02);
    for (let k = 0; k < 2; k++) {
      const upper = matrixOf(byName(r, 'zombie-upper-arms-walker'), k);
      const fore = matrixOf(byName(r, 'zombie-forearms-walker'), k);
      const elbow = new THREE.Vector3(0, -UPPER_L, 0).applyMatrix4(upper);
      expect(translation(fore).distanceTo(elbow)).toBeLessThan(1e-6);
      // after someone, the hands are held out in front (−Z at yaw 0), below the shoulders
      const hand = new THREE.Vector3(0, -FORE_L, 0).applyMatrix4(fore);
      expect(hand.z).toBeLessThan(-3 - 0.4);
      const drop = 20 + LEG_H + SHOULDER_Y - hand.y;
      expect(drop).toBeGreaterThan(0.05);
      expect(drop).toBeLessThan(0.5);
    }
    for (const geo of Object.values(g)) geo.dispose();
    r.dispose();
  });

  it('swings the legs with walkPhase in opposite directions, stands them straight at 0, and a walker limps', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const angle = (name, i) => new THREE.Euler().setFromRotationMatrix(matrixOf(byName(r, name), i), 'YXZ').x;
    r.sync([zombie(0, 10, 0, { walkPhase: 0 })]);
    expect(angle('zombie-legs-walker', 0)).toBeCloseTo(0, 6);
    expect(angle('zombie-legs-walker', 1)).toBeCloseTo(0, 6);
    r.sync([zombie(0, 10, 0, { walkPhase: Math.PI / 2 })]);
    expect(Math.sign(angle('zombie-legs-walker', 0))).toBe(-Math.sign(angle('zombie-legs-walker', 1)));
    expect(Math.abs(angle('zombie-legs-walker', 1))).toBeLessThan(Math.abs(angle('zombie-legs-walker', 0)) * 0.7); // the short stride
    r.sync([zombie(0, 10, 0, { walkPhase: Math.PI / 2, kind: 'runner' })]);
    expect(Math.abs(angle('zombie-legs-runner', 0))).toBeGreaterThan(0.8); // a runner's long stride
    expect(Math.abs(angle('zombie-legs-runner', 1))).toBeCloseTo(Math.abs(angle('zombie-legs-runner', 0)), 6);
    r.dispose();
  });

  it('the kinds: a runner is narrower and leans far forward; an alpha is bigger', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0), zombie(5, 10, 0, { kind: 'runner' }), zombie(10, 10, 0, { kind: 'alpha' })]);
    const torso = (kind) => matrixOf(byName(r, `zombie-torso-${kind}`), 0);
    const scale = (kind) => new THREE.Vector3().setFromMatrixScale(torso(kind));
    expect(scale('walker').x).toBeCloseTo(1, 5);
    expect(scale('runner').x).toBeCloseTo(RUNNER_WIDTH, 5);
    expect(scale('alpha').y).toBeCloseTo(ALPHA_SCALE, 5);
    const lean = (kind) => new THREE.Euler().setFromRotationMatrix(torso(kind), 'YXZ').x;
    expect(lean('runner')).toBeLessThan(lean('walker') - 0.2);
    expect(lean('alpha')).toBeLessThan(lean('walker') - 0.1);
    r.dispose();
  });

  it('a hurt zombie flashes red and a smouldering one glows, on their own instanced twins', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0), zombie(2, 10, 0, { hurt: 0.3 }), zombie(4, 10, 0, { smoking: true }), zombie(6, 10, 0, { hurt: 0.1, kind: 'alpha' })]);
    expect(byName(r, 'zombie-head-walker').count).toBe(1);
    expect(byName(r, 'zombie-head-walker-hurt').count).toBe(1);
    expect(byName(r, 'zombie-head-walker-burn').count).toBe(1);
    expect(byName(r, 'zombie-legs-walker-hurt').count).toBe(2);
    expect(byName(r, 'zombie-forearms-walker-burn').count).toBe(2);
    expect(byName(r, 'zombie-torso-alpha-hurt').count).toBe(1);
    expect(byName(r, 'zombie-torso-alpha').count).toBe(0);
    const hurt = byName(r, 'zombie-head-walker-hurt').material;
    expect(hurt.emissive.r).toBeGreaterThan(0.9);
    expect(hurt.emissiveMap).toBeNull(); // the whole body flashes, not just its eyes
    expect(hurt.map).toBe(byName(r, 'zombie-head-walker').material.map);
    expect(byName(r, 'zombie-head-walker-burn').material.emissive.g).toBeGreaterThan(0.1);
    r.dispose();
  });

  it('a strike swipes the arms up and lurches the torso', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const hand = () => new THREE.Vector3(0, -FORE_L, 0).applyMatrix4(matrixOf(byName(r, 'zombie-forearms-walker'), 0));
    const lean = () => new THREE.Euler().setFromRotationMatrix(matrixOf(byName(r, 'zombie-torso-walker'), 0), 'YXZ').x;
    r.sync([zombie(0, 10, 0, { mode: 'chase' })]);
    const restHand = hand().y;
    const restLean = lean();
    r.sync([zombie(0, 10, 0, { mode: 'chase', swing: 0.175 })]); // half way through SWING_S 0.35
    expect(hand().y).toBeGreaterThan(restHand + 0.1);
    expect(lean()).toBeLessThan(restLean - 0.2);
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
    const m = matrixOf(byName(r, 'zombie-torso-walker'), 0);
    expect(translation(m).y).toBeCloseTo(64 + LEG_H * 0.5, 5); // the hips, half as high
    expect(new THREE.Vector3().setFromMatrixScale(m).y).toBeCloseTo(0.5, 5);
    const hip = translation(matrixOf(byName(r, 'zombie-legs-walker'), 0));
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
    expect(byName(r, 'zombie-legs-alpha').count).toBe((ZOMBIE_MAX + MAX_INFALL_MOBS) * 2);
    expect(byName(r, 'zombie-head-alpha').count).toBe(ZOMBIE_MAX + MAX_INFALL_MOBS);
    r.dispose();
  });
});

describe('how each kind carries itself (CONTRACTS §74)', () => {
  const hands = (r, kind) => [0, 1].map((k) => new THREE.Vector3(0, -FORE_L, 0).applyMatrix4(matrixOf(byName(r, `zombie-forearms-${kind}`), k)));
  it("a walker's arms hang until it gives chase; the alpha's are spread wide with the forearms up", () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(0, 10, 0)]);
    const idle = hands(r, 'walker')[0];
    expect(-idle.z).toBeLessThan(0.4); // barely forward
    expect(10 + LEG_H + SHOULDER_Y - idle.y).toBeGreaterThan(ARM_L * 0.85); // hanging
    r.sync([zombie(0, 10, 0, { mode: 'chase' })]);
    expect(-hands(r, 'walker')[0].z).toBeGreaterThan(0.45);
    expect(ARMS.chase.reach).toBeGreaterThan(ARMS.hang.reach + 0.6);
    r.sync([zombie(0, 10, 0, { kind: 'alpha' })]);
    const [left, right] = hands(r, 'alpha');
    expect(Math.abs(right.x - left.x)).toBeGreaterThan(SHOULDER_X * 2 * ALPHA_SCALE + 0.2); // wider than its shoulders
    expect(-left.z).toBeGreaterThan(0.4);
    expect(ARMS.alpha.spread).toBeGreaterThan(ARMS.chase.spread + 0.2);
    expect(ARMS.alpha.bend).toBeGreaterThan(0.7);
    expect(ARMS.runner.bend).toBeGreaterThan(1); // elbows bent, pumping
    r.dispose();
  });

  it('people: walkers and runners wear shirts of different faded colours by id; the alpha is as painted', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const n = SHIRT_TINTS.length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(new Set(SHIRT_TINTS).size).toBe(n);
    for (const hex of SHIRT_TINTS) for (const ch of new THREE.Color(hex).toArray()) expect(ch).toBeGreaterThan(0.3); // pale: the hands barely change
    r.sync(Array.from({ length: n + 1 }, (_, i) => zombie(i * 2, 10, 0, { id: i })));
    const colour = (name, i) => {
      const c = new THREE.Color();
      byName(r, name).getColorAt(i, c);
      return c.getHex();
    };
    const shirts = Array.from({ length: n }, (_, i) => colour('zombie-torso-walker', i));
    expect(new Set(shirts).size).toBe(n);
    expect(colour('zombie-torso-walker', n)).toBe(shirts[0]); // … and round again
    for (let i = 0; i < n; i++) {
      expect(colour('zombie-upper-arms-walker', i * 2)).toBe(shirts[i]); // sleeves match
      expect(colour('zombie-forearms-walker', i * 2 + 1)).toBe(shirts[i]);
      expect(colour('zombie-legs-walker', i * 2)).toBe(0xffffff); // trousers do not change
      expect(colour('zombie-head-walker', i)).toBe(0xffffff);
    }
    r.sync([zombie(0, 10, 0, { id: 3, kind: 'alpha' }), zombie(0, 10, 0, { id: NaN })]);
    expect(colour('zombie-torso-alpha', 0)).toBe(0xffffff);
    expect(colour('zombie-torso-walker', 0)).toBe(new THREE.Color(SHIRT_TINTS[0]).getHex());
    r.dispose();
  });

  it('twitchOf: still most of the time, a sharp jerk to alternate sides, and never two runners together', () => {
    const beat = 1 / TWITCH_HZ;
    expect(twitchOf(0, 0)).toBe(0);
    expect(twitchOf(beat * TWITCH_PART * 0.5, 0)).toBeCloseTo(TWITCH_ANGLE, 6); // the peak of the first jerk
    expect(twitchOf(beat * (1 + TWITCH_PART * 0.5), 0)).toBeCloseTo(-TWITCH_ANGLE, 6); // the next one, the other way
    expect(twitchOf(beat * 0.5, 0)).toBe(0);
    let still = 0;
    for (let i = 0; i < 1000; i++) if (twitchOf(i * 0.0137, 0) === 0) still++;
    expect(still / 1000).toBeGreaterThan(0.75);
    expect(twitchOf(beat * TWITCH_PART * 0.5, 1)).not.toBeCloseTo(TWITCH_ANGLE, 3);
    expect(twitchOf(NaN, NaN)).toBe(0);
  });

  it("only a runner's head jerks with the clock; a walker's and an alpha's do not", () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const peak = (1 / TWITCH_HZ) * TWITCH_PART * 0.5;
    const roll = (kind) => new THREE.Euler().setFromRotationMatrix(matrixOf(byName(r, `zombie-head-${kind}`), 0), 'YXZ').z;
    const zs = [zombie(0, 10, 0), zombie(3, 10, 0, { kind: 'runner' }), zombie(6, 10, 0, { kind: 'alpha' })];
    r.sync(zs, 0);
    const at0 = { walker: roll('walker'), runner: roll('runner'), alpha: roll('alpha') };
    r.sync(zs, peak);
    expect(roll('walker')).toBeCloseTo(at0.walker, 6);
    expect(roll('alpha')).toBeCloseTo(at0.alpha, 6);
    expect(Math.abs(roll('runner') - at0.runner)).toBeGreaterThan(TWITCH_ANGLE * 0.8);
    r.sync(zs); // no clock: as at 0
    expect(roll('runner')).toBeCloseTo(at0.runner, 6);
    r.dispose();
  });
});

describe('light hurts its eyes: one arm up across the face, the head turned away (CONTRACTS §86)', () => {
  function snapshot(r) {
    const out = {};
    for (const m of r.group.children) out[m.name] = Array.from(m.instanceMatrix.array.slice(0, m.count * 16));
    return out;
  }
  const point = (r, name, i, x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(matrixOf(byName(r, name), i));

  it('shieldOf reads Zombie.shield as 0..1; without it (or at 0) the pose is exactly as before', () => {
    expect(shieldOf({ shield: 0.4 })).toBe(0.4);
    expect(shieldOf({ shield: 7 })).toBe(1);
    for (const bad of [undefined, null, {}, { shield: NaN }, { shield: -2 }]) expect(shieldOf(bad)).toBe(0);
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const base = [
      zombie(1, 10, 2, { yaw: 0.7, walkPhase: 1.1, tilt: 0.1, mode: 'chase', side: -1 }),
      zombie(-3, 11, 4, { yaw: -2, walkPhase: 0.3, swing: 0.1, kind: 'runner', side: 1 }),
      zombie(5, 11, 4, { kind: 'alpha' }),
    ];
    r.sync(base, 0.3);
    const plain = snapshot(r);
    r.sync(base.map((z) => ({ ...z, shield: 0 })), 0.3);
    expect(snapshot(r)).toEqual(plain);
    r.sync(base.map((z) => ({ ...z, shield: NaN })), 0.3);
    expect(snapshot(r)).toEqual(plain);
    r.sync(base.map((z) => ({ ...z, shield: 0.5 })), 0.3);
    expect(snapshot(r)).not.toEqual(plain);
    r.dispose();
  });

  /** A point of instance `i` of mesh `name` (its local x, y, z) in the HEAD's own frame: x across, y up from the neck, −z the face. */
  const inHead = (r, kind, name, i, x, y, z) => point(r, name, i, x, y, z).applyMatrix4(matrixOf(byName(r, `zombie-head-${kind}`), 0).invert());
  /**
   * How deep (m) the arm on instance `k` cuts into the head and its hair: the deepest of a grid of points through the
   * upper arm's and the forearm's boxes, measured inside the head's box.
   */
  function cutsIntoHead(r, kind, k) {
    const hx = HEAD_W / 2 + HAIR_PUFF;
    const hz = HEAD_D / 2 + HAIR_PUFF;
    let worst = 0;
    for (const [name, part, len] of [[`zombie-upper-arms-${kind}`, PARTS.upperArm, UPPER_L], [`zombie-forearms-${kind}`, PARTS.foreArm, FORE_L]]) {
      const w = part.w * SKIN_TEXEL;
      const d = part.d * SKIN_TEXEL;
      for (let a = 0; a <= 4; a++) {
        for (let b = 0; b <= 10; b++) {
          for (let c = 0; c <= 4; c++) {
            const p = inHead(r, kind, name, k, (a / 4 - 0.5) * w, -(b / 10) * len, (c / 4 - 0.5) * d);
            worst = Math.max(worst, Math.min(hx - Math.abs(p.x), p.y + HAIR_PUFF, HEAD_H + HAIR_PUFF - p.y, hz - Math.abs(p.z)));
          }
        }
      }
    }
    return worst;
  }

  it('at full shield its hand is before the eye on its own side, clear of the face; the other arm does not move', () => {
    expect(SHIELD_ARM.reach).toBeGreaterThan(Math.PI / 2); // above level: higher than the arms of a chase
    expect(SHIELD_ARM.reach).toBeGreaterThan(ARMS.chase.reach + 0.5);
    expect(SHIELD_ARM.bend).toBeGreaterThan(1); // the forearm bent up …
    expect(SHIELD_ARM.twist).toBeGreaterThan(0.5); // … and turned in across the face
    const eyeY = HEAD_H * (1 - (EYE_ROW + 0.5) / PARTS.head.h); // the eye slits' height above the neck
    for (const kind of ['walker', 'runner', 'alpha']) {
      for (const side of [1, -1]) {
        for (const extra of [{ mode: 'idle' }, { mode: 'chase' }, { mode: 'chase', walkPhase: 1.6, tilt: 0.28, swing: 0.17 }]) {
          const at = `${kind}, side ${side}, ${JSON.stringify(extra)}`;
          const scene = new THREE.Scene();
          const r = createZombieRenderer(scene, null);
          r.sync([zombie(0, 10, 0, { kind, side, ...extra })], 0.05);
          const before = snapshot(r);
          r.sync([zombie(0, 10, 0, { kind, side, ...extra, shield: 1 })], 0.05);
          const after = snapshot(r);
          const mine = side > 0 ? 1 : 0; // the instance of the arm on its side (0: −x, 1: +x)
          const other = 1 - mine;
          for (const part of ['upper-arms', 'forearms']) {
            const name = `zombie-${part}-${kind}`;
            expect(after[name].slice(other * 16, other * 16 + 16), `${at}: other ${part}`).toEqual(before[name].slice(other * 16, other * 16 + 16));
            expect(after[name].slice(mine * 16, mine * 16 + 16), `${at}: its ${part}`).not.toEqual(before[name].slice(mine * 16, mine * 16 + 16));
          }
          expect(after[`zombie-legs-${kind}`], at).toEqual(before[`zombie-legs-${kind}`]);
          expect(after[`zombie-torso-${kind}`], at).toEqual(before[`zombie-torso-${kind}`]);
          // The hand (the far end of the forearm), seen from the head: on the arm's side of the face, at the height of
          // the eyes, and a little way in front of them. The same for every kind and whatever else the body is doing.
          const hand = inHead(r, kind, `zombie-forearms-${kind}`, mine, 0, -FORE_L + 2 * SKIN_TEXEL, 0);
          expect(hand.x * side, `${at}: on its side`).toBeGreaterThan(0.02);
          expect(hand.x * side, `${at}: over the face`).toBeLessThan(HEAD_W / 2);
          expect(Math.abs(hand.y - eyeY), `${at}: at the eyes`).toBeLessThan(0.08);
          expect(-hand.z - HEAD_D / 2 - FORE_W / 2, `${at}: in front`).toBeGreaterThan(0.03);
          expect(-hand.z - HEAD_D / 2 - FORE_W / 2, `${at}: close`).toBeLessThan(0.15);
          // the elbow is out in front of the shoulder, lower and farther out than the hand: the forearm slants up and in
          const elbow = inHead(r, kind, `zombie-forearms-${kind}`, mine, 0, 0, 0);
          expect(elbow.x * side, at).toBeGreaterThan(hand.x * side + 0.15);
          expect(elbow.y, at).toBeLessThan(hand.y - 0.15);
          expect(cutsIntoHead(r, kind, mine), `${at}: clear of the head`).toBe(0);
          r.dispose();
        }
      }
    }
  });

  it('on the way up the arm never cuts into its head', () => {
    for (const kind of ['walker', 'runner', 'alpha']) {
      for (const mode of ['idle', 'chase']) {
        const scene = new THREE.Scene();
        const r = createZombieRenderer(scene, null);
        for (let s = 1; s <= 20; s++) {
          r.sync([zombie(0, 10, 0, { kind, mode, side: 1, shield: s / 20 })]);
          expect(cutsIntoHead(r, kind, 1), `${kind}, ${mode}, shield ${s / 20}`).toBe(0);
        }
        r.dispose();
      }
    }
  });

  it('its head comes up and leans away from the raised arm; half a shield is half the way; a dormant walker does nothing', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    /** The head's own turn on the torso: Rz(roll) · Rx(nod), read back as Euler ZXY. */
    const head = (kind, extra) => {
      r.sync([zombie(0, 10, 0, { kind, ...extra })], 0.05);
      const rel = matrixOf(byName(r, `zombie-torso-${kind}`), 0).invert().multiply(matrixOf(byName(r, `zombie-head-${kind}`), 0));
      return new THREE.Euler().setFromRotationMatrix(rel, 'ZXY');
    };
    const hand = (extra) => {
      r.sync([zombie(0, 10, 0, extra)]);
      return point(r, 'zombie-forearms-walker', 1, 0, -FORE_L, 0);
    };
    for (const kind of ['walker', 'runner', 'alpha']) {
      for (const extra of [{}, { mode: 'chase', walkPhase: 2.2, tilt: -0.2 }]) {
        const full = head(kind, { ...extra, side: 1, shield: 1 });
        expect(full.x, kind).toBeCloseTo(SHIELD_NOD, 5); // held up (a little back), whatever its own nod was
        expect(full.z, kind).toBeCloseTo(SHIELD_ROLL, 5); // its crown toward −x, away from the arm on +x
        expect(head(kind, { ...extra, side: -1, shield: 1 }).z, kind).toBeCloseTo(-SHIELD_ROLL, 5);
        const none = head(kind, { ...extra, side: 1 });
        const half = head(kind, { ...extra, side: 1, shield: 0.5 });
        expect(half.x, kind).toBeCloseTo((none.x + SHIELD_NOD) / 2, 5);
        expect(half.z, kind).toBeCloseTo((none.z + SHIELD_ROLL) / 2, 5);
      }
    }
    expect(SHIELD_NOD).toBeGreaterThanOrEqual(0); // never bowed into its own arm
    // the hand rises with the shield
    const y0 = hand({ side: 1 }).y;
    const y5 = hand({ side: 1, shield: 0.5 }).y;
    const y1 = hand({ side: 1, shield: 1 }).y;
    expect(y5).toBeGreaterThan(y0 + 0.2);
    expect(y1).toBeGreaterThan(y5 + 0.2);
    expect(y1).toBeGreaterThan(10 + LEG_H + TORSO_H); // above the shoulders: up by the face
    // asleep on its feet by day, a walker does not lift a hand
    const dormant = { daylit: true, side: 1 };
    r.sync([zombie(0, 10, 0, dormant)]);
    const asleep = snapshot(r);
    r.sync([zombie(0, 10, 0, { ...dormant, shield: 1 })]);
    expect(snapshot(r)).toEqual(asleep);
    r.dispose();
  });
});
