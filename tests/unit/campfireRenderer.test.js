// campfireRenderer.js regression tests — Node only (three core objects work without WebGL; the smoke canvas and the
// WebGLRenderer are stubs). CONTRACTS §32.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createCampfireRenderer, FLAMES, STONES_PER_FIRE, LOGS_PER_FIRE, EMBERS_PER_FIRE, SMOKE_PER_FIRE,
} from '../../src/campfireRenderer.js';
import { Campfires, flicker } from '../../src/campfires.js';
import {
  CAMPFIRE_LIGHTS, CAMPFIRE_LIGHT_INTENSITY, CAMPFIRE_LIGHT_FADE_S, CAMPFIRE_LIGHT_HYSTERESIS, CAMPFIRE_MAX_MODELS,
} from '../../src/config.js';
import { HEX_SIZE, hexToWorld } from '../../src/hex.js';

/** 2D-canvas stand-in: enough for the smoke texture's radial gradient. */
function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      fillStyle: null,
    }),
  };
}

function setup(opts = {}) {
  const scene = new THREE.Scene();
  const cr = createCampfireRenderer(scene, { makeCanvas: fakeCanvas, ...opts });
  const root = scene.getObjectByName('campfires');
  /** @type {THREE.InstancedMesh[]} */
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(/** @type {THREE.InstancedMesh} */ (o)); });
  const byName = (n) => meshes.find((m) => m.name === n);
  const lights = [];
  scene.traverse((o) => { if (o.isPointLight) lights.push(o); });
  return { scene, cr, root, meshes, byName, lights };
}

/** Draw calls three would issue for the campfires: one per visible mesh, two for a transparent DoubleSide material. */
function drawCalls(meshes) {
  let n = 0;
  for (const m of meshes) {
    if (!m.visible || m.count === 0) continue;
    const mat = /** @type {THREE.Material} */ (m.material);
    n += mat.transparent && mat.side === THREE.DoubleSide && !mat.forceSinglePass ? 2 : 1;
  }
  return n;
}

/** `count` fires on a spiral of cells at floor y = 10, and the `near` list main would pass from (0, 10.3 + eye, 0). */
function camp(count, at = [0, 11.9, 0]) {
  const c = new Campfires();
  let placed = 0;
  for (let rad = 0; placed < count; rad++) {
    for (let dq = -rad; dq <= rad && placed < count; dq++) {
      for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad) && placed < count; dr++) {
        if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) !== rad) continue;
        c.add(dq, 10, dr);
        placed++;
      }
    }
  }
  return { c, near: c.nearest(at[0], at[1], at[2], 64) };
}

function matrixPos(mesh, i) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return new THREE.Vector3().setFromMatrixPosition(m);
}

describe('campfire renderer: draw calls (C3)', () => {
  it('draws 1 fire and 48 fires with the same nine single-pass draw calls (was ~31 per fire)', () => {
    const { cr, meshes, scene } = setup();
    expect(meshes).toHaveLength(9);
    const objectsBefore = scene.children.length;
    expect(drawCalls(meshes)).toBe(0); // nothing is drawn while no fire is modelled
    const one = camp(1);
    cr.sync(one.near, 1, 1 / 60);
    expect(cr.count()).toBe(1);
    expect(drawCalls(meshes)).toBe(9);
    const many = camp(CAMPFIRE_MAX_MODELS);
    cr.sync(many.near, 1.1, 1 / 60);
    expect(cr.count()).toBe(CAMPFIRE_MAX_MODELS);
    expect(drawCalls(meshes)).toBe(9);
    expect(scene.children.length).toBe(objectsBefore); // no per-fire objects in the scene
    let total = 0;
    scene.traverse(() => total++);
    expect(total).toBeLessThan(20);
    // The instance counts carry the fires.
    const counts = Object.fromEntries(meshes.map((m) => [m.name, m.count]));
    expect(counts['campfire-stones']).toBe(CAMPFIRE_MAX_MODELS * STONES_PER_FIRE);
    expect(counts['campfire-logs']).toBe(CAMPFIRE_MAX_MODELS * LOGS_PER_FIRE);
    expect(counts['campfire-embers']).toBe(CAMPFIRE_MAX_MODELS * EMBERS_PER_FIRE);
    expect(counts['campfire-smoke']).toBe(CAMPFIRE_MAX_MODELS * SMOKE_PER_FIRE);
    for (let i = 0; i < FLAMES.length; i++) expect(counts[`campfire-flame-${i}`]).toBe(CAMPFIRE_MAX_MODELS);
    // Extra entries beyond the capacity are ignored rather than overflowing the instance buffers.
    const tooMany = camp(CAMPFIRE_MAX_MODELS + 5);
    cr.sync(tooMany.near, 1.2, 1 / 60);
    expect(cr.count()).toBe(CAMPFIRE_MAX_MODELS);
    cr.sync([], 1.3, 1 / 60);
    expect(cr.count()).toBe(0);
    expect(drawCalls(meshes)).toBe(0);
  });

  it('keeps the model: stones on the corners, logs crossing at 60° (middle one charred), embers, flames, rising smoke', () => {
    const { cr, byName } = setup();
    const c = new Campfires();
    c.add(4, 20, -3);
    const fire = c.fires.get('4,20,-3');
    cr.sync([{ fire, dist: 2 }], 5, 1 / 60);
    const [x, z] = hexToWorld(4, -3);
    const stones = byName('campfire-stones');
    for (let k = 0; k < STONES_PER_FIRE; k++) {
      const a = ((60 * k - 90) * Math.PI) / 180;
      const p = matrixPos(stones, k);
      expect(p.x).toBeCloseTo(x + Math.cos(a) * HEX_SIZE * 0.72, 5); // instance buffers are Float32
      expect(p.y).toBeCloseTo(20, 5);
      expect(p.z).toBeCloseTo(z + Math.sin(a) * HEX_SIZE * 0.72, 5);
    }
    const logs = byName('campfire-logs');
    const colors = [];
    for (let k = 0; k < LOGS_PER_FIRE; k++) {
      const m = new THREE.Matrix4();
      logs.getMatrixAt(k, m);
      const q = new THREE.Quaternion();
      m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      const want = new THREE.Euler(0, (k * Math.PI) / 3 + fire.seed, 0);
      expect(q.angleTo(new THREE.Quaternion().setFromEuler(want))).toBeLessThan(1e-3);
      expect(matrixPos(logs, k).y).toBeCloseTo(20 + 0.07 + k * 0.035, 5);
      const col = new THREE.Color();
      logs.getColorAt(k, col);
      colors.push(col.getHex());
    }
    expect(colors).toEqual([0x5a3b22, 0x2b1d14, 0x5a3b22]);
    for (let k = 0; k < EMBERS_PER_FIRE; k++) expect(matrixPos(byName('campfire-embers'), k).y).toBeCloseTo(20.13, 5);
    for (let i = 0; i < FLAMES.length; i++) {
      const p = matrixPos(byName(`campfire-flame-${i}`), 0);
      expect(p.x).toBeCloseTo(x + FLAMES[i][4], 5);
      expect(p.y).toBeCloseTo(20.13, 5);
      expect(p.z).toBeCloseTo(z + FLAMES[i][5], 5);
    }
    const smoke = byName('campfire-smoke');
    const opacity = smoke.geometry.getAttribute('aOpacity');
    for (let i = 0; i < SMOKE_PER_FIRE; i++) {
      const p = matrixPos(smoke, i);
      expect(p.y).toBeGreaterThan(20.6);
      expect(p.y).toBeLessThan(20.65 + 0.85 * 3.2 + 1e-9);
      expect(opacity.getX(i)).toBeGreaterThanOrEqual(0);
      expect(opacity.getX(i)).toBeLessThanOrEqual(0.32);
    }
    // The flame materials keep their colours and opacities, drawn in order outer → inner.
    for (let i = 0; i < FLAMES.length; i++) {
      const fl = byName(`campfire-flame-${i}`);
      expect(fl.material.color.getHex()).toBe(FLAMES[i][2]);
      expect(fl.material.opacity).toBe(FLAMES[i][3]);
      expect(fl.renderOrder).toBe(2 + i);
    }
    expect(smoke.renderOrder).toBe(10);
  });

  it('a fire that leaves frees its slot without disturbing the others (swap-remove)', () => {
    const { cr, byName } = setup();
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(3, 10, 0);
    c.add(6, 10, 0);
    const [a, b, d] = ['0,10,0', '3,10,0', '6,10,0'].map((k) => c.fires.get(k));
    cr.sync([{ fire: a, dist: 1 }, { fire: b, dist: 2 }, { fire: d, dist: 3 }], 1, 1 / 60);
    cr.sync([{ fire: a, dist: 1 }, { fire: d, dist: 3 }], 1.1, 1 / 60);
    expect(cr.count()).toBe(2);
    const stones = byName('campfire-stones');
    expect(stones.count).toBe(2 * STONES_PER_FIRE);
    /** the x of each slot's fire, recovered from a part's instance position minus its in-fire offset */
    const slotXs = (mesh, perFire, offsetX) => [0, 1].map((slot) => matrixPos(mesh, slot * perFire).x - offsetX).sort((p, q) => p - q);
    const want = [a.x, d.x].sort((p, q) => p - q);
    const expectXs = (got) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 5));
    expectXs(slotXs(stones, STONES_PER_FIRE, Math.cos((-90 * Math.PI) / 180) * HEX_SIZE * 0.72));
    for (let i = 0; i < FLAMES.length; i++) expectXs(slotXs(byName(`campfire-flame-${i}`), 1, FLAMES[i][4]));
  });
});

describe('campfire renderer: shader programs (C2)', () => {
  it('prewarm compiles every campfire material against the real scene (lights, fog) before any fire exists', async () => {
    const { cr, scene, root, meshes } = setup();
    scene.fog = new THREE.Fog(0, 1, 100);
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await cr.prewarm({ compileAsync: (obj, cam, target) => { calls.push({ obj, cam, target }); return Promise.resolve(obj); } }, camera);
    expect(calls).toHaveLength(1);
    expect(calls[0].obj).toBe(root);
    expect(calls[0].cam).toBe(camera);
    expect(calls[0].target).toBe(scene);
    // three's compile walks `obj` with traverse (not traverseVisible): every material must be reachable from it.
    const reachable = new Set();
    calls[0].obj.traverse((o) => { if (o.isMesh) reachable.add(o.material); });
    expect(reachable.size).toBe(meshes.length);
    for (const m of meshes) expect(reachable.has(m.material)).toBe(true);
    // The instancing variants three will draw are the ones compiled: logs carry their instance colour already.
    for (const m of meshes) expect(m.isInstancedMesh).toBe(true);
    expect(meshes.find((m) => m.name === 'campfire-logs').instanceColor).not.toBeNull();
  });

  it('prewarm also has every part draw once, hidden, in the next frame (drivers that finish shaders on first draw)', () => {
    const { cr, meshes } = setup();
    cr.prewarm(null, new THREE.PerspectiveCamera());
    expect(drawCalls(meshes)).toBe(9);
    for (const m of meshes) {
      expect(m.count).toBe(1);
      const mat = new THREE.Matrix4();
      m.getMatrixAt(0, mat);
      const pos = new THREE.Vector3();
      const scale = new THREE.Vector3();
      mat.decompose(pos, new THREE.Quaternion(), scale);
      expect(pos.y).toBeLessThan(-1000); // far below the world: clipped, nothing on screen
      expect(scale.x).toBeLessThan(1e-3);
    }
    expect(cr.idle()).toBe(true); // main need not sync for the warm-up to happen
    // ...and a sync with no fire in range (tracked fires far away) does not cancel it.
    cr.sync([], 0, 1 / 60);
    expect(drawCalls(meshes)).toBe(9);
    // three calls onAfterRender after drawing each object: the part goes back to drawing nothing.
    for (const m of meshes) m.onAfterRender();
    expect(drawCalls(meshes)).toBe(0);
  });

  it('a world that loads with fires draws them instead of the warm-up instance', () => {
    const { cr, meshes, byName } = setup();
    cr.prewarm(null, new THREE.PerspectiveCamera());
    const { near } = camp(2);
    cr.sync(near, 1, 1 / 60); // the first frame's sync runs before the draw
    for (const m of meshes) m.onAfterRender();
    expect(drawCalls(meshes)).toBe(9);
    expect(byName('campfire-stones').count).toBe(2 * STONES_PER_FIRE);
    expect(matrixPos(byName('campfire-stones'), 0).y).toBeCloseTo(10, 5);
  });

  it('prewarm falls back to compile and never throws', async () => {
    const { cr } = setup();
    const camera = new THREE.PerspectiveCamera();
    let compiled = 0;
    await cr.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(1);
    await expect(cr.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(cr.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(cr.prewarm(null, camera)).resolves.toBeUndefined();
  });

  it('fires coming and going never create or dispose a material (regression: the last fire disposed the smoke program)', () => {
    const { cr, meshes } = setup();
    const materials = new Set(meshes.map((m) => m.material));
    let disposed = 0;
    for (const m of materials) m.addEventListener('dispose', () => disposed++);
    const { near } = camp(12);
    for (let round = 0; round < 3; round++) {
      cr.sync(near, round, 1 / 60);
      cr.sync(near.slice(0, 3), round + 0.5, 1 / 60);
      cr.sync([], round + 0.7, 1 / 60);
    }
    expect(disposed).toBe(0);
    expect(new Set(meshes.map((m) => m.material))).toEqual(materials);
    // Transparent DoubleSide flames are single-pass (no back-face program and no second draw).
    for (const m of materials) if (m.transparent && m.side === THREE.DoubleSide) expect(m.forceSinglePass).toBe(true);
  });
});

describe('campfire renderer: light hand-over (C4)', () => {
  const T = 0.4; // fixed animation time: flicker is constant, so intensity changes come from the hand-over alone
  const DT = 1 / 60;

  /** Six fires on the corners of a radius-3 hex ring around the origin, like the play-test camp. */
  function ring() {
    const c = new Campfires();
    for (const [q, r] of [[3, 0], [0, 3], [-3, 3], [-3, 0], [0, -3], [3, -3]]) c.add(q, 10, r);
    return c;
  }
  const litSet = (lights) => lights.filter((l) => l.intensity > 1e-9).map((l) => `${l.position.x.toFixed(2)},${l.position.z.toFixed(2)}`).sort().join('|');

  it('the lit set does not change while the player wobbles at the camp centre (regression: lights popped at ±5 cm)', () => {
    const { cr, lights } = setup();
    const c = ring();
    const eye = (dz) => c.nearest(0, 11.9, dz, 64);
    for (let i = 0; i < 60; i++) cr.sync(eye(-0.05), T, DT);
    const settled = litSet(lights);
    expect(settled.split('|')).toHaveLength(CAMPFIRE_LIGHTS);
    for (let i = 0; i < 120; i++) {
      cr.sync(eye(i % 2 ? 0.05 : -0.05), T, DT); // 10 cm back and forth: the nearest four swap every frame
      expect(litSet(lights)).toBe(settled);
    }
    // Every lit light is at full strength.
    for (const l of lights) if (l.intensity > 0) expect(l.intensity / CAMPFIRE_LIGHT_INTENSITY).toBeGreaterThan(0.74);
  });

  it('walking through a field of fires, a light only moves once it is dark, and fades in and out smoothly', () => {
    const { cr, lights } = setup();
    const c = new Campfires();
    for (let q = -12; q <= 12; q += 3) for (let r = -12; r <= 12; r += 3) c.add(q, 10, r);
    const maxI = CAMPFIRE_LIGHT_INTENSITY * 1.25;
    const maxStep = maxI * 1.5 * (DT / CAMPFIRE_LIGHT_FADE_S) + 1e-9; // smoothstep's steepest slope is 1.5
    let prev = lights.map((l) => ({ x: l.position.x, z: l.position.z, I: l.intensity }));
    let moves = 0;
    const frames = 600;
    for (let i = 0; i < frames; i++) {
      const z = -10 + (20 * i) / frames; // 20 m at 2 m/s
      cr.sync(c.nearest(0.4, 11.9, z, 64).slice(0, CAMPFIRE_MAX_MODELS), T, DT);
      lights.forEach((l, j) => {
        const moved = Math.hypot(l.position.x - prev[j].x, l.position.z - prev[j].z) > 1e-9;
        if (moved) {
          moves++;
          expect(prev[j].I, `light ${j} moved while lit at frame ${i}`).toBe(0);
        } else {
          expect(Math.abs(l.intensity - prev[j].I), `light ${j} stepped at frame ${i}`).toBeLessThanOrEqual(maxStep);
        }
      });
      prev = lights.map((l) => ({ x: l.position.x, z: l.position.z, I: l.intensity }));
    }
    expect(moves).toBeGreaterThan(4); // the lights did follow the walk
    expect(lights.filter((l) => l.intensity > 0).length).toBe(CAMPFIRE_LIGHTS);
  });

  it('a lit fire hands its light over only when another is CAMPFIRE_LIGHT_HYSTERESIS nearer', () => {
    const { cr, lights } = setup();
    const c = new Campfires();
    for (let q = 0; q < 5; q++) c.add(q * 4, 10, 0);
    const fires = [...c.fires.values()];
    const near = (d4, d5) => fires.map((fire, i) => ({ fire, dist: i < 3 ? i + 1 : i === 3 ? d4 : d5 })).sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < 60; i++) cr.sync(near(5, 6), T, DT);
    const lit = () => lights.filter((l) => l.intensity > 0).map((l) => Math.round(l.position.x));
    expect(lit().sort((a, b) => a - b)).toEqual([fires[0].x, fires[1].x, fires[2].x, fires[3].x].map(Math.round));
    // The fifth fire comes 0.4 m nearer than the fourth: within the margin, nothing changes.
    for (let i = 0; i < 60; i++) cr.sync(near(5, 5 - (CAMPFIRE_LIGHT_HYSTERESIS - 0.1)), T, DT);
    expect(lit()).toContain(Math.round(fires[3].x));
    expect(lit()).not.toContain(Math.round(fires[4].x));
    // 0.6 m nearer: the fourth fire's light fades out, then comes up on the fifth.
    for (let i = 0; i < Math.ceil((2 * CAMPFIRE_LIGHT_FADE_S) / DT) + 2; i++) cr.sync(near(5, 5 - (CAMPFIRE_LIGHT_HYSTERESIS + 0.1)), T, DT);
    expect(lit()).toContain(Math.round(fires[4].x));
    expect(lit()).not.toContain(Math.round(fires[3].x));
    const l5 = lights.find((l) => Math.round(l.position.x) === Math.round(fires[4].x));
    expect(l5.intensity).toBeCloseTo(CAMPFIRE_LIGHT_INTENSITY * flicker(T, fires[4].seed), 9);
  });

  it('a new fire fades in, a broken one fades out where it stood, then the renderer goes idle', () => {
    const { cr, lights } = setup();
    expect(cr.idle()).toBe(true);
    const c = new Campfires();
    c.add(0, 10, 0);
    const fire = c.fires.get('0,10,0');
    const full = CAMPFIRE_LIGHT_INTENSITY * flicker(T, fire.seed);
    cr.sync([{ fire, dist: 2 }], T, DT);
    const l = lights.find((x) => x.intensity > 0);
    expect(l.intensity).toBeGreaterThan(0);
    expect(l.intensity).toBeLessThan(full * 0.1);
    for (let i = 0; i < Math.ceil(CAMPFIRE_LIGHT_FADE_S / DT); i++) cr.sync([{ fire, dist: 2 }], T, DT);
    expect(l.intensity).toBeCloseTo(full, 9);
    // Broken: no model at once, the light dims over CAMPFIRE_LIGHT_FADE_S at the same spot.
    cr.sync([], T, DT);
    expect(cr.count()).toBe(0);
    expect(cr.idle()).toBe(false);
    expect(l.intensity).toBeGreaterThan(full * 0.9);
    expect([l.position.x, l.position.z]).toEqual([fire.x, fire.z]);
    for (let i = 0; i < Math.ceil(CAMPFIRE_LIGHT_FADE_S / DT); i++) cr.sync([], T, DT);
    expect(l.intensity).toBe(0);
    expect(cr.idle()).toBe(true);
  });
});
