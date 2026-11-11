// zombieRenderer.js regression tests — Node only (three core objects work without WebGL). CONTRACTS §39, §61, §74.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createZombieRenderer, zombieGeometries, boxesGeometry, LEG_H, LEG_X, TORSO_W, TORSO_H, NECK_H, HEAD_W, HEAD_H, HEAD_D,
  MODEL_HEIGHT, ALPHA_SCALE, RUNNER_WIDTH, KIND_TINT, SKIN, SLIT, ARM_L, SHOULDER_X, SHOULDER_Y, ALPHA_EYES, EYE_X, EYE_Y,
  SLIT_H, HAIRLINE_Y, twitchOf, TWITCH_HZ, TWITCH_PART, TWITCH_ANGLE, ARMS_HANG, ARMS_CHASE, ALPHA_SPREAD, ALPHA_BROW_SLANT,
  ALPHA_SLIT_SLANT, SHIRT_TINTS,
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

describe('zombie model: a dead person of chunky boxes (no hexagons, no atlas)', () => {
  it('stands under ZOMBIE_HEIGHT with a grown body: a small head on wide shoulders, long legs and long arms (§74)', () => {
    expect(MODEL_HEIGHT).toBeLessThanOrEqual(ZOMBIE_HEIGHT);
    expect(MODEL_HEIGHT).toBeGreaterThan(ZOMBIE_HEIGHT - 0.15);
    // not a child: the head is small for the body and well inside the shoulders, and the wrists hang below the hips
    expect(HEAD_H / TORSO_H).toBeLessThan(0.65);
    expect(MODEL_HEIGHT / HEAD_H).toBeGreaterThan(4.4);
    expect(HEAD_W).toBeLessThan(TORSO_W * 0.8);
    expect(SHOULDER_X * 2).toBeGreaterThan(HEAD_W * 1.6);
    expect(LEG_H).toBeGreaterThan(TORSO_H);
    expect(LEG_H + SHOULDER_Y - ARM_L).toBeLessThan(LEG_H);
  });

  it('every part is coloured per vertex, with closed boxes and outward normals; the face is on the −Z side', () => {
    const g = zombieGeometries();
    for (const [name, geo] of Object.entries(g)) {
      expect(geo.getAttribute('color'), name).toBeTruthy();
      expect(geo.getAttribute('uv'), name).toBeUndefined();
      expect(geo.getIndex().count % 36, name).toBe(0); // whole boxes
    }
    // the brows, the hollows, the slits, the nose and the mouth sit in front of the head's −Z face
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
  it('draws ZOMBIE_MAX walkers with 4 draw calls: legs and arms (2 each), torso, head; +1 with runners, +3 with an alpha', () => {
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
    // each kind wears its own head; the alpha adds its hide and its eyes
    expect(drawn(scene).map((m) => m.name).sort()).toEqual(
      ['zombie-alpha-eyes', 'zombie-alpha-hide', 'zombie-arms', 'zombie-head', 'zombie-head-alpha', 'zombie-legs', 'zombie-torso']);
    expect(byName(r, 'zombie-head').count).toBe(1);
    expect(byName(r, 'zombie-head-alpha').count).toBe(1);
    r.sync([zombie(0, 10, 0, { kind: 'runner' }), zombie(2, 10, 0, { kind: 'runner' }), zombie(4, 10, 0)]);
    expect(drawn(scene).map((m) => m.name).sort()).toEqual(['zombie-arms', 'zombie-head', 'zombie-head-runner', 'zombie-legs', 'zombie-torso']);
    expect(byName(r, 'zombie-head-runner').count).toBe(2);
    expect(byName(r, 'zombie-torso').count).toBe(3);
    r.sync([]);
    expect(drawn(scene)).toEqual([]);
    r.dispose();
  });

  it('stacks the parts: legs from the ground to the hips, the torso on them, the head on the neck, arms reaching forward in a chase', () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    r.sync([zombie(4, 20, -3, { mode: 'chase' })]);
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
    // after someone, the arms are held out in front (−Z at yaw 0), a little below the shoulders
    for (let k = 0; k < 2; k++) {
      const m = matrixOf(byName(r, 'zombie-arms'), k);
      const hand = new THREE.Vector3(0, -ARM_L, 0).applyMatrix4(m);
      expect(hand.z).toBeLessThan(-3 - 0.4);
      const drop = 20 + LEG_H + SHOULDER_Y - hand.y;
      expect(drop).toBeGreaterThan(0.1);
      expect(drop).toBeLessThan(0.4);
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
    r.sync([zombie(0, 10, 0, { mode: 'chase' })]);
    const restHand = hand().y;
    const restLean = new THREE.Euler().setFromRotationMatrix(matrixOf(torso, 0), 'YXZ').x;
    r.sync([zombie(0, 10, 0, { mode: 'chase', swing: 0.175 })]); // half way through SWING_S 0.35
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

describe('v0.13 three faces with narrow eye slits (CONTRACTS §74)', () => {
  /** The face plates of a head: [x, y, colour] of every vertex in front of the head's −Z side. */
  const faceOf = (geo) => {
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    const out = [];
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) > -HEAD_D / 2 - 0.005) continue;
      out.push({ x: pos.getX(i), y: pos.getY(i), c: new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHex(THREE.SRGBColorSpace) });
    }
    return out;
  };
  const lum = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
  /** Is the face the same on both sides, below the hair? (Eyebrows, hollows, slits, nose, cheeks, mouth.) */
  const mirrored = (face) => {
    const key = (v) => `${Math.abs(v.x).toFixed(3)},${v.y.toFixed(3)},${v.c}`;
    const low = face.filter((v) => v.y < HAIRLINE_Y - 0.045);
    const left = low.filter((v) => v.x < -1e-6).map(key).sort();
    const right = low.filter((v) => v.x > 1e-6).map(key).sort();
    return JSON.stringify(left) === JSON.stringify(right);
  };
  /** The box of the slit-coloured vertices on one side of a face. */
  const slitBox = (face, side) => {
    const vs = face.filter((v) => v.c === SLIT && Math.sign(v.x) === side);
    const xs = vs.map((v) => v.x);
    const ys = vs.map((v) => v.y);
    return { n: vs.length, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
  };

  it('no face has anything red, and the alpha glows a hot amber, never red', () => {
    const g = zombieGeometries();
    for (const head of [g.head, g.headRunner, g.headAlpha]) {
      for (const v of faceOf(head)) {
        expect(((v.c >> 16) & 255) > 200 && ((v.c >> 8) & 255) < 90, `no red on the face (${v.c.toString(16)})`).toBe(false);
      }
    }
    const amber = new THREE.Color(ALPHA_EYES);
    expect(amber.g).toBeGreaterThan(0.3);
    expect(amber.r).toBeGreaterThan(amber.g);
    expect(amber.g).toBeGreaterThan(amber.b);
    for (const geo of Object.values(g)) geo.dispose();
  });

  it('the walker is vacant: two level, narrow, empty slits on a mirror-symmetric face with nothing brighter than its skin', () => {
    const g = zombieGeometries();
    const face = faceOf(g.head);
    expect(mirrored(face)).toBe(true);
    for (const side of [-1, 1]) {
      const b = slitBox(face, side);
      expect(b.n).toBeGreaterThanOrEqual(4);
      expect(b.h).toBeCloseTo(SLIT_H, 5);
      expect(b.w / b.h).toBeGreaterThan(3.5); // a slit, not an eye
      expect(Math.abs(b.cx)).toBeCloseTo(EYE_X, 5);
      expect(b.cy).toBeCloseTo(EYE_Y, 5);
    }
    expect(SLIT_H).toBeLessThan(0.035);
    // no whites, no pupils, no teeth: nothing on the face is paler than the skin
    const skin = lum(new THREE.Color().setHex(SKIN, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace));
    for (const v of face) expect(lum(v.c)).toBeLessThanOrEqual(skin + 1e-6);
    for (const geo of Object.values(g)) geo.dispose();
  });

  it('the runner is wired: its face is NOT symmetric, and each slit holds one pale pinprick', () => {
    const g = zombieGeometries();
    const face = faceOf(g.headRunner);
    expect(mirrored(face)).toBe(false);
    const skin = lum(new THREE.Color().setHex(SKIN, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace));
    const pale = face.filter((v) => lum(v.c) > skin + 20 && Math.abs(v.y - EYE_Y) < 0.03);
    expect(pale.filter((v) => v.x < 0).length).toBeGreaterThanOrEqual(4);
    expect(pale.filter((v) => v.x > 0).length).toBeGreaterThanOrEqual(4);
    for (const side of [-1, 1]) {
      const xs = pale.filter((v) => Math.sign(v.x) === side).map((v) => v.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.03); // a pinprick, not an eye
      expect(slitBox(face, side).h).toBeLessThan(0.06);
    }
    for (const geo of Object.values(g)) geo.dispose();
  });

  it('the alpha scowls: its glowing slits and its brow slant down towards the nose, over black pits', () => {
    const g = zombieGeometries();
    const pos = g.eyes.getAttribute('position');
    for (const side of [-1, 1]) {
      const inner = [];
      const outer = [];
      for (let i = 0; i < pos.count; i++) {
        if (Math.sign(pos.getX(i)) !== side) continue;
        (Math.abs(pos.getX(i)) < EYE_X ? inner : outer).push(pos.getY(i));
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      expect(inner.length).toBe(outer.length);
      expect(mean(outer) - mean(inner)).toBeGreaterThan(0.015); // the inner end sits lower: a glare
    }
    expect(ALPHA_SLIT_SLANT).toBeGreaterThan(0.15);
    expect(ALPHA_BROW_SLANT).toBeGreaterThan(ALPHA_SLIT_SLANT);
    const face = faceOf(g.headAlpha);
    for (const side of [-1, 1]) expect(slitBox(face, side).n).toBeGreaterThanOrEqual(4); // the pits behind the glow
    expect(mirrored(faceOf(g.headRunner))).toBe(false);
    for (const geo of Object.values(g)) geo.dispose();
  });

  it('each kind has its own hair, and all three keep the same skin', () => {
    const g = zombieGeometries();
    const colours = (geo) => {
      const col = geo.getAttribute('color');
      const out = new Set();
      for (let i = 0; i < col.count; i++) out.add(new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHex(THREE.SRGBColorSpace));
      return out;
    };
    const w = colours(g.head);
    const r = colours(g.headRunner);
    const a = colours(g.headAlpha);
    for (const set of [w, r, a]) expect(set.has(new THREE.Color().setHex(SKIN, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace))).toBe(true);
    // the hair is the one colour a head does not share with the other two
    const only = (mine, x, y) => [...mine].filter((c) => !x.has(c) && !y.has(c));
    expect(only(w, r, a).length).toBeGreaterThanOrEqual(1);
    expect(only(r, w, a).length).toBeGreaterThanOrEqual(1);
    expect(only(a, w, r).length).toBeGreaterThanOrEqual(1);
    for (const geo of Object.values(g)) geo.dispose();
  });
});

describe('v0.13 how each kind carries itself (CONTRACTS §74)', () => {
  const armAngles = (r, i) => {
    const e = new THREE.Euler().setFromRotationMatrix(matrixOf(byName(r, 'zombie-arms'), i), 'YXZ');
    return e;
  };
  it("a walker's arms hang until it gives chase; the alpha's are always up and spread wide", () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const hand = (i) => new THREE.Vector3(0, -ARM_L, 0).applyMatrix4(matrixOf(byName(r, 'zombie-arms'), i));
    r.sync([zombie(0, 10, 0)]);
    const idle = hand(0);
    expect(-idle.z).toBeLessThan(0.3); // barely forward
    expect(10 + LEG_H + SHOULDER_Y - idle.y).toBeGreaterThan(ARM_L * 0.85); // hanging
    r.sync([zombie(0, 10, 0, { mode: 'chase' })]);
    expect(-hand(0).z).toBeGreaterThan(0.4);
    expect(ARMS_CHASE).toBeGreaterThan(ARMS_HANG + 0.6);
    r.sync([zombie(0, 10, 0, { kind: 'alpha' })]);
    const left = hand(0);
    const right = hand(1);
    expect(-left.z).toBeGreaterThan(0.4 * ALPHA_SCALE);
    expect(Math.abs(right.x - left.x)).toBeGreaterThan(SHOULDER_X * 2 * ALPHA_SCALE + 0.2); // wider than its shoulders
    expect(ALPHA_SPREAD).toBeGreaterThan(0.2);
    expect(Math.abs(armAngles(r, 0).z)).toBeGreaterThan(0.2);
    r.dispose();
  });

  it("people: walkers and runners wear shirts of different faded colours by id; the alpha's stays dark", () => {
    const scene = new THREE.Scene();
    const r = createZombieRenderer(scene, null);
    const n = SHIRT_TINTS.length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(new Set(SHIRT_TINTS).size).toBe(n);
    for (const hex of SHIRT_TINTS) for (const ch of new THREE.Color(hex).toArray()) expect(ch).toBeGreaterThan(0.35); // pale: the hands barely change
    r.sync(Array.from({ length: n + 1 }, (_, i) => zombie(i * 2, 10, 0, { id: i })));
    const torso = byName(r, 'zombie-torso');
    const arms = byName(r, 'zombie-arms');
    const legs = byName(r, 'zombie-legs');
    const colour = (mesh, i) => {
      const c = new THREE.Color();
      mesh.getColorAt(i, c);
      return c.getHex();
    };
    const shirts = Array.from({ length: n }, (_, i) => colour(torso, i));
    expect(new Set(shirts).size).toBe(n);
    expect(colour(torso, n)).toBe(shirts[0]); // … and round again
    for (let i = 0; i < n; i++) {
      expect(colour(arms, i * 2)).toBe(shirts[i]); // sleeves match
      expect(colour(legs, i * 2)).toBe(new THREE.Color(KIND_TINT.walker).getHex()); // trousers do not change
    }
    r.sync([zombie(0, 10, 0, { id: 3, kind: 'alpha' })]);
    expect(colour(torso, 0)).toBe(new THREE.Color(KIND_TINT.alpha).getHex());
    r.sync([zombie(0, 10, 0, { id: NaN })]);
    expect(colour(torso, 0)).toBe(new THREE.Color(KIND_TINT.walker).getHex());
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
    const roll = (name) => new THREE.Euler().setFromRotationMatrix(matrixOf(byName(r, name), 0), 'YXZ').z;
    const zs = [zombie(0, 10, 0), zombie(3, 10, 0, { kind: 'runner' }), zombie(6, 10, 0, { kind: 'alpha' })];
    r.sync(zs, 0);
    const at0 = { w: roll('zombie-head'), r: roll('zombie-head-runner'), a: roll('zombie-head-alpha') };
    r.sync(zs, peak);
    expect(roll('zombie-head')).toBeCloseTo(at0.w, 6);
    expect(roll('zombie-head-alpha')).toBeCloseTo(at0.a, 6);
    expect(Math.abs(roll('zombie-head-runner') - at0.r)).toBeGreaterThan(TWITCH_ANGLE * 0.8);
    r.sync(zs); // no clock: as at 0
    expect(roll('zombie-head-runner')).toBeCloseTo(at0.r, 6);
    r.dispose();
  });
});
