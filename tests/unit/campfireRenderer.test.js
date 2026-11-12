// campfireRenderer.js regression tests — Node only (three core objects work without WebGL; the smoke canvas and the
// WebGLRenderer are stubs). CONTRACTS §32.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createCampfireRenderer, FLAMES, STONES_PER_FIRE, LOGS_PER_FIRE, EMBERS_PER_FIRE, SMOKE_PER_FIRE,
  CORNER_RADIUS, POT_SPOT, SKEWERS_PER_FIRE, SKEWER_LEAN, SKEWER_LENGTH, SKEWER_BASE_Y, CHUNK_ALONG, POT_BASE_Y,
  POT_PROFILE, POT_FLAME_SQUASH, POT_FLAME_WIDEN,
  SKEWER_COLOR, SPOT_COLORS, SPOT_ITEMS, spotKind, spotDoneness, chunkColor, potColor, skewerPose,
} from '../../src/campfireRenderer.js';
import { Campfires, flicker } from '../../src/campfires.js';
import {
  CAMPFIRE_LIGHTS, CAMPFIRE_LIGHT_INTENSITY, CAMPFIRE_LIGHT_FADE_S, CAMPFIRE_LIGHT_HYSTERESIS, CAMPFIRE_MAX_MODELS,
  FIRE_SPOTS,
} from '../../src/config.js';
import { HEX_SIZE, hexToWorld, hexContains } from '../../src/hex.js';
import { isItemKey } from '../../src/items.js';

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
    // 12 InstancedMeshes since Survival (DESIGN-survival §9.9): the 9 fire parts plus skewers, food chunks and pots,
    // which draw nothing while no spot holds anything (so a Creative fire still costs 9 draw calls).
    expect(meshes).toHaveLength(12);
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
    expect(drawCalls(meshes)).toBe(12); // the Survival spot parts warm up too
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
    expect(drawCalls(meshes)).toBe(12);
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

// ---------------------------------------------------------------------------------------------------------------
// Survival fire spots (docs/DESIGN-survival.md §4.4, §9.9): skewers, food chunks and the pot in the embers.
// ---------------------------------------------------------------------------------------------------------------

/** FIRE_TRANSFORMS of §4.4: [item, becomes, spot kind]. (cooking.js is package C's; the table is copied here.) */
const FIRE_TRANSFORMS_44 = [
  ['raw_pork', 'roast_pork', 'skewer'], ['roast_pork', 'charred_meat', 'skewer'], ['wild_tuber', 'baked_tuber', 'skewer'],
  ['cattail_root', 'roasted_cattail_root', 'skewer'], ['leached_acorns', 'roasted_acorns', 'skewer'],
  ['unpeeled_cactus_fruit', 'cactus_fruit', 'skewer'],
  ['pot_water', 'pot_boiled', 'centre'], ['pot_seawater', 'salt_pot', 'centre'], ['pot_snow', 'pot_boiled', 'centre'],
  ['greenware_pot', 'clay_pot', 'centre'],
];
const NEXT = Object.fromEntries(FIRE_TRANSFORMS_44.map(([a, b]) => [a, b]));

/** One entry of fireSlots.view(...).spots: `progress` toward the next transform (none for a finished item). */
const spotOf = (k, progress = 0) => ({ k, progress, secondsLeft: 10 * (1 - progress), next: NEXT[k] ?? null });

/** A fireSlots.view-shaped object with the given spots filled ({ index: entry }). */
function viewOf(entries) {
  const spots = new Array(FIRE_SPOTS).fill(null);
  for (const [i, v] of Object.entries(entries)) spots[Number(i)] = v;
  return { spots, fuel: 120 };
}

const hex3 = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function expectRGB(got, want, digits = 3) {
  for (let i = 0; i < 3; i++) expect(got[i], `channel ${i} of [${got}] vs [${want}]`).toBeCloseTo(want[i], digits);
}
/** An instance colour read back in sRGB 0..1. */
function srgbAt(mesh, i) {
  const c = new THREE.Color();
  mesh.getColorAt(i, c);
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
}
function matrixParts(mesh, i) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}
const UP = new THREE.Vector3(0, 1, 0);

describe('fire spots: what each item is drawn as', () => {
  it('SPOT_ITEMS covers both sides of every §4.4 FIRE_TRANSFORMS row with real item keys', () => {
    for (const [from, to, where] of FIRE_TRANSFORMS_44) {
      for (const k of [from, to]) {
        expect(Object.hasOwn(SPOT_ITEMS, k), k).toBe(true);
        expect(isItemKey(k), k).toBe(true);
        expect(SPOT_ITEMS[k].kind, k).toBe(where === 'centre' ? 'pot' : k.includes('pork') || k.includes('meat') ? 'meat' : 'veg');
      }
      // A transform moves one stage on: raw → cooked → burnt.
      expect(SPOT_ITEMS[to].stage, `${from} → ${to}`).toBe(SPOT_ITEMS[from].stage + 1);
    }
    for (const k of Object.keys(SPOT_ITEMS)) expect(isItemKey(k), k).toBe(true);
    // v0.14 (§76 fauna): the game meats, and beef and mutton (§69), which were missing and drawn as vegetables
    const MEATS = ['pork', 'beef', 'mutton', 'venison', 'rabbit', 'fowl', 'fish', 'bear'];
    expect(Object.keys(SPOT_ITEMS).filter((k) => SPOT_ITEMS[k].kind === 'meat').sort())
      .toEqual(['charred_meat', ...MEATS.map((m) => `raw_${m}`), ...MEATS.map((m) => `roast_${m}`)].sort());
    for (const m of MEATS) expect([SPOT_ITEMS[`raw_${m}`].stage, SPOT_ITEMS[`roast_${m}`].stage], m).toEqual([0, 1]);
    expect([SPOT_ITEMS.raw_egg, SPOT_ITEMS.roast_egg]).toEqual([{ kind: 'veg', stage: 0 }, { kind: 'veg', stage: 1 }]);
    expect(SPOT_ITEMS.raw_pork.stage).toBe(0);
    expect(SPOT_ITEMS.charred_meat.stage).toBe(2);
    expect(Object.isFrozen(SPOT_ITEMS)).toBe(true);
    expect(Object.isFrozen(SPOT_ITEMS.raw_pork)).toBe(true);
  });

  it('spotKind: the embers hold a pot; a skewer holds meat (pork) or veg (everything else, unknown keys too)', () => {
    expect(POT_SPOT).toBe(6);
    expect(SKEWERS_PER_FIRE).toBe(6);
    expect(FIRE_SPOTS).toBe(7);
    for (let k = 0; k < SKEWERS_PER_FIRE; k++) {
      expect(spotKind('raw_pork', k)).toBe('meat');
      expect(spotKind('roast_pork', k)).toBe('meat');
      expect(spotKind('charred_meat', k)).toBe('meat');
      for (const veg of ['wild_tuber', 'baked_tuber', 'cattail_root', 'roasted_cattail_root', 'leached_acorns', 'roasted_acorns',
        'unpeeled_cactus_fruit', 'cactus_fruit']) expect(spotKind(veg, k), veg).toBe('veg');
      for (const odd of ['pot_water', 'rock', 'no_such_item', '__proto__', 'constructor', '', /** @type {*} */ (null)]) {
        expect(spotKind(odd, k), String(odd)).toBe('veg');
      }
    }
    for (const k of ['pot_water', 'raw_pork', 'no_such_item', '__proto__']) expect(spotKind(k, POT_SPOT)).toBe('pot');
  });

  it('spotDoneness: stage plus progress toward the next transform, 0..2', () => {
    expect(spotDoneness(spotOf('raw_pork', 0))).toBe(0);
    expect(spotDoneness(spotOf('raw_pork', 0.5))).toBe(0.5);
    expect(spotDoneness(spotOf('raw_pork', 1))).toBe(1);
    expect(spotDoneness(spotOf('roast_pork', 0))).toBe(1);
    expect(spotDoneness(spotOf('roast_pork', 0.25))).toBe(1.25);
    expect(spotDoneness(spotOf('charred_meat', 0.9))).toBe(2); // nothing comes after charred
    expect(spotDoneness({ k: 'charred_meat', progress: 0.9, next: 'imaginary' })).toBe(2); // capped
    expect(spotDoneness(spotOf('baked_tuber', 0.7))).toBe(1); // a finished item ignores its progress
    expect(spotDoneness(spotOf('wild_tuber', 0.4))).toBeCloseTo(0.4, 12);
    expect(spotDoneness({ k: 'mystery', progress: 0.3, next: 'other' })).toBeCloseTo(0.3, 12); // unknown: raw
    expect(spotDoneness({ k: 'raw_pork', progress: 3, next: 'roast_pork' })).toBe(1); // progress clamped
    expect(spotDoneness({ k: 'raw_pork', progress: -2, next: 'roast_pork' })).toBe(0);
    expect(spotDoneness({ k: 'roast_pork', progress: NaN, next: 'charred_meat' })).toBe(1);
    expect(spotDoneness({ k: 'raw_pork', next: 'roast_pork' })).toBe(0);
    expect(spotDoneness(null)).toBe(0);
    expect(spotDoneness(undefined)).toBe(0);
  });

  it('chunkColor runs raw (meat #d98c8c, veg #c9b27a) → cooked #8a5a2b → burnt #2a2018, lerped in sRGB', () => {
    expect(SPOT_COLORS).toEqual({ meat: 0xd98c8c, veg: 0xc9b27a, cooked: 0x8a5a2b, burnt: 0x2a2018, pot: 0xb5603a, greenware: 0xb9ad98 });
    const [meat, veg, cooked, burnt] = [0xd98c8c, 0xc9b27a, 0x8a5a2b, 0x2a2018].map(hex3);
    expectRGB(chunkColor('meat', 0), meat, 9);
    expectRGB(chunkColor('veg', 0), veg, 9);
    expectRGB(chunkColor('meat', 1), cooked, 9);
    expectRGB(chunkColor('veg', 1), cooked, 9);
    expectRGB(chunkColor('meat', 2), burnt, 9);
    expectRGB(chunkColor('veg', 2), burnt, 9);
    expectRGB(chunkColor('meat', 0.5), mix(meat, cooked, 0.5), 9);
    expectRGB(chunkColor('veg', 0.25), mix(veg, cooked, 0.25), 9);
    expectRGB(chunkColor('meat', 1.5), mix(cooked, burnt, 0.5), 9);
    expectRGB(chunkColor('meat', -1), meat, 9);
    expectRGB(chunkColor('meat', 7), burnt, 9);
    expectRGB(chunkColor('meat', NaN), meat, 9);
    expectRGB(chunkColor('pot', 0), veg, 9); // pots never get a chunk; anything not meat is veg
    // Darker the longer it cooks.
    let prev = Infinity;
    for (let d = 0; d <= 2.0001; d += 0.05) {
      const sum = chunkColor('meat', d).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThan(prev);
      prev = sum;
    }
  });

  it('potColor: terracotta, except a greenware pot firing from pale clay to terracotta', () => {
    const [terracotta, greenware] = [0xb5603a, 0xb9ad98].map(hex3);
    for (const k of ['pot_water', 'pot_boiled', 'pot_seawater', 'salt_pot', 'pot_snow', 'clay_pot', 'mystery']) {
      expectRGB(potColor(spotOf(k, 0.5)), terracotta, 9);
    }
    expectRGB(potColor(null), terracotta, 9);
    expectRGB(potColor(spotOf('greenware_pot', 0)), greenware, 9);
    expectRGB(potColor(spotOf('greenware_pot', 0.5)), mix(greenware, terracotta, 0.5), 9);
    expectRGB(potColor(spotOf('greenware_pot', 1)), terracotta, 9);
    expectRGB(potColor({ k: 'greenware_pot', progress: 0.5, next: null }), greenware, 9);
  });

  it('skewerPose: the foot at corner stone k, leaning SKEWER_LEAN (about 35°) toward the fire centre', () => {
    expect(CORNER_RADIUS).toBeCloseTo(HEX_SIZE * 0.72, 12);
    expect((SKEWER_LEAN * 180) / Math.PI).toBeCloseTo(35, 9);
    const [x, y, z] = [12.5, 40, -7.25];
    for (let k = 0; k < SKEWERS_PER_FIRE; k++) {
      const a = ((60 * k - 90) * Math.PI) / 180;
      const { foot, dir } = skewerPose(k, x, y, z);
      expect(foot[0]).toBeCloseTo(x + Math.cos(a) * CORNER_RADIUS, 12);
      expect(foot[1]).toBeCloseTo(y + SKEWER_BASE_Y, 12);
      expect(foot[2]).toBeCloseTo(z + Math.sin(a) * CORNER_RADIUS, 12);
      expect(Math.hypot(...dir)).toBeCloseTo(1, 12);
      expect(Math.acos(dir[1])).toBeCloseTo(SKEWER_LEAN, 12); // tilted 35° from the vertical …
      const toCentre = [x - foot[0], z - foot[2]];
      const h = Math.hypot(dir[0], dir[2]);
      expect((dir[0] * toCentre[0] + dir[2] * toCentre[1]) / (h * Math.hypot(...toCentre))).toBeCloseTo(1, 12); // … inward
    }
  });
});

describe('fire spots: the renderer', () => {
  /** One fire at (4, 20, −3) and the near entry main would pass. */
  function oneFire() {
    const c = new Campfires();
    c.add(4, 20, -3);
    const fire = c.fires.get('4,20,-3');
    return { fire, near: [{ fire, dist: 2 }] };
  }

  it('without spotsView (Creative, or nothing cooking) no skewer, chunk or pot is drawn: still nine draw calls', () => {
    const { cr, meshes, byName } = setup();
    const { near } = oneFire();
    cr.sync(near, 1, 1 / 60);
    expect(drawCalls(meshes)).toBe(9);
    for (const n of ['campfire-skewers', 'campfire-chunks', 'campfire-pots']) {
      expect(byName(n).count, n).toBe(0);
      expect(byName(n).visible, n).toBe(false);
    }
    cr.sync(near, 1.1, 1 / 60, () => null); // a fire with no spot entry (fireSlots.view → null)
    expect(drawCalls(meshes)).toBe(9);
    cr.sync(near, 1.2, 1 / 60, () => viewOf({})); // an entry with only fuel
    expect(drawCalls(meshes)).toBe(9);
  });

  it('draws a leaning skewer and a food chunk on each occupied corner and a terracotta pot in the embers', () => {
    const { cr, meshes, byName } = setup();
    const { fire, near } = oneFire();
    const seen = [];
    const view = viewOf({ 0: spotOf('raw_pork'), 3: spotOf('wild_tuber', 0.5), 6: spotOf('pot_water', 0.2) });
    cr.sync(near, 1, 1 / 60, (f) => { seen.push(f); return view; });
    expect(seen).toEqual([fire]); // asked once per modelled fire, with the tracker's record
    expect(drawCalls(meshes)).toBe(12);
    const skewers = byName('campfire-skewers');
    const chunks = byName('campfire-chunks');
    const pots = byName('campfire-pots');
    expect([skewers.count, chunks.count, pots.count]).toEqual([2, 2, 1]);
    const stones = byName('campfire-stones');
    [0, 3].forEach((k, i) => {
      const { p, q, s } = matrixParts(skewers, i);
      const { foot, dir } = skewerPose(k, fire.x, fire.y, fire.z);
      // Planted at its corner stone: the stone instance of the same corner stands at the same (x, z).
      const stone = matrixPos(stones, k);
      expect(p.x).toBeCloseTo(stone.x, 5);
      expect(p.z).toBeCloseTo(stone.z, 5);
      expect(p.y).toBeCloseTo(fire.y + SKEWER_BASE_Y, 5);
      expect([p.x, p.y, p.z].map((v, j) => v - foot[j]).every((d) => Math.abs(d) < 1e-5)).toBe(true);
      expect(s.x).toBeCloseTo(1, 5);
      const axis = UP.clone().applyQuaternion(q);
      expect(axis.x).toBeCloseTo(dir[0], 5);
      expect(axis.y).toBeCloseTo(dir[1], 5);
      expect(axis.z).toBeCloseTo(dir[2], 5);
      // The chunk is threaded on the skewer near its tip, turned the same way.
      const c = matrixParts(chunks, i);
      const along = SKEWER_LENGTH * CHUNK_ALONG;
      expect(c.p.x).toBeCloseTo(foot[0] + dir[0] * along, 5);
      expect(c.p.y).toBeCloseTo(foot[1] + dir[1] * along, 5);
      expect(c.p.z).toBeCloseTo(foot[2] + dir[2] * along, 5);
      expect(c.q.angleTo(q)).toBeLessThan(1e-5);
    });
    expectRGB(srgbAt(chunks, 0), hex3(0xd98c8c)); // raw pork
    expectRGB(srgbAt(chunks, 1), mix(hex3(0xc9b27a), hex3(0x8a5a2b), 0.5)); // a tuber half baked
    const pot = matrixParts(pots, 0);
    expect(pot.p.x).toBeCloseTo(fire.x, 5);
    expect(pot.p.y).toBeCloseTo(fire.y + POT_BASE_Y, 5);
    expect(pot.p.z).toBeCloseTo(fire.z, 5);
    expect(pot.q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6); // corners along ±z like the cells
    expectRGB(srgbAt(pots, 0), hex3(0xb5603a));
    expect(skewers.material.color.getHex()).toBe(SKEWER_COLOR);
  });

  it('the food sits beside the flames, above the stones and inside the cell; the pot stands in the embers', () => {
    const { cr, byName } = setup();
    const { fire, near } = oneFire();
    const full = {};
    for (let k = 0; k < SKEWERS_PER_FIRE; k++) full[k] = spotOf('raw_pork');
    full[POT_SPOT] = spotOf('greenware_pot');
    cr.sync(near, 1, 1 / 60, () => viewOf(full));
    const chunks = byName('campfire-chunks');
    const [outerR, outerH] = FLAMES[0];
    for (let i = 0; i < SKEWERS_PER_FIRE; i++) {
      const { p } = matrixParts(chunks, i);
      const h = p.y - (fire.y + 0.13); // height above the flames' base
      const flameR = outerR * Math.max(0, 1 - h / outerH); // the outer flame cone at rest, at the chunk's height
      expect(Math.hypot(p.x - fire.x, p.z - fire.z) - 0.05).toBeGreaterThan(flameR);
      expect(p.y - fire.y).toBeGreaterThan(0.12 + 0.05); // clear of the stones
      expect(p.y - fire.y).toBeLessThan(1);
      expect(hexContains(4, -3, p.x, p.z)).toBe(true);
      const { foot, dir } = skewerPose(i, fire.x, fire.y, fire.z);
      const tip = foot.map((v, j) => v + dir[j] * SKEWER_LENGTH);
      expect(hexContains(4, -3, tip[0], tip[2])).toBe(true);
    }
    const pot = matrixParts(byName('campfire-pots'), 0);
    expect(pot.p.y - fire.y).toBeLessThan(0.13); // its foot below the embers' top
    // Greenware at progress 0 is still pale clay.
    expectRGB(srgbAt(byName('campfire-pots'), 0), hex3(0xb9ad98));
  });

  it('the pot never meets the skewers or the food on them (all six full)', () => {
    const { cr, byName } = setup();
    const { fire, near } = oneFire();
    const full = {};
    for (let k = 0; k < FIRE_SPOTS; k++) full[k] = k === POT_SPOT ? spotOf('pot_water') : spotOf('roast_pork', 0.3);
    cr.sync(near, 1, 1 / 60, () => viewOf(full));
    // The pot's outside: the profile up to the rim, as radius by height above the cell floor.
    const rim = POT_PROFILE.findIndex(([, h], i) => i > 0 && h === Math.max(...POT_PROFILE.map((p) => p[1])));
    const outside = POT_PROFILE.slice(0, rim + 1).map(([r, h]) => [r, h + POT_BASE_Y]);
    const potRadiusAt = (y) => {
      let best = -1; // -1: above or below the pot
      for (let i = 1; i < outside.length; i++) {
        const [r0, y0] = outside[i - 1];
        const [r1, y1] = outside[i];
        if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
        const r = y1 === y0 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
        best = Math.max(best, r);
      }
      return best;
    };
    expect(potRadiusAt(POT_BASE_Y + 0.1)).toBeCloseTo(0.165, 9); // the belly
    expect(potRadiusAt(2)).toBe(-1);
    const chunks = byName('campfire-chunks');
    const chunkPos = chunks.geometry.getAttribute('position');
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let checked = 0;
    for (let i = 0; i < SKEWERS_PER_FIRE; i++) {
      chunks.getMatrixAt(i, m);
      for (let j = 0; j < chunkPos.count; j++) {
        v.fromBufferAttribute(chunkPos, j).applyMatrix4(m);
        const radial = Math.hypot(v.x - fire.x, v.z - fire.z);
        const potR = potRadiusAt(v.y - fire.y);
        if (potR >= 0) {
          expect(radial, `chunk ${i} vertex ${j} clears the pot`).toBeGreaterThan(potR + 0.02);
          checked++;
        }
      }
      const { foot, dir } = skewerPose(i, fire.x, fire.y, fire.z);
      for (let s = 0; s <= 50; s++) {
        const t = (s / 50) * SKEWER_LENGTH;
        const potR = potRadiusAt(foot[1] + dir[1] * t - fire.y);
        if (potR >= 0) expect(Math.hypot(foot[0] + dir[0] * t - fire.x, foot[2] + dir[2] * t - fire.z)).toBeGreaterThan(potR + 0.05);
      }
    }
    expect(checked).toBeGreaterThan(0); // the chunks do reach down into the pot's height range
  });

  it('a pot in the embers lowers and widens that fire\'s flames so its belly shows; other fires keep theirs', () => {
    const { cr, byName } = setup();
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(6, 10, 0);
    const [a, b] = ['0,10,0', '6,10,0'].map((k) => c.fires.get(k));
    const near = [{ fire: a, dist: 1 }, { fire: b, dist: 2 }];
    const T = 3.7;
    const flameParts = () => FLAMES.map((_, i) => [0, 1].map((slot) => matrixParts(byName(`campfire-flame-${i}`), slot)));
    cr.sync(near, T, 1 / 60, () => viewOf({ 0: spotOf('raw_pork') })); // food, no pot
    const plain = flameParts();
    cr.sync(near, T, 1 / 60, (f) => (f === a ? viewOf({ [POT_SPOT]: spotOf('pot_water'), 2: spotOf('wild_tuber') }) : viewOf({})));
    const potted = flameParts();
    expect(POT_FLAME_SQUASH).toBeLessThan(1);
    expect(POT_FLAME_WIDEN).toBeGreaterThan(1);
    for (let i = 0; i < FLAMES.length; i++) {
      const [pa, pb] = plain[i];
      const [qa, qb] = potted[i];
      expect(qa.s.y / pa.s.y).toBeCloseTo(POT_FLAME_SQUASH, 5); // fire a holds the pot
      expect(qa.s.x / pa.s.x).toBeCloseTo(POT_FLAME_WIDEN, 5);
      expect(qa.s.z / pa.s.z).toBeCloseTo(POT_FLAME_WIDEN, 5);
      expect(qa.p.x - a.x).toBeCloseTo((pa.p.x - a.x) * POT_FLAME_WIDEN, 5); // side tongues move out around the pot
      expect(qa.p.z - a.z).toBeCloseTo((pa.p.z - a.z) * POT_FLAME_WIDEN, 5);
      expect(qa.p.y).toBeCloseTo(pa.p.y, 5);
      expect(qb.s.y).toBeCloseTo(pb.s.y, 6); // fire b has no pot: unchanged
      expect(qb.s.x).toBeCloseTo(pb.s.x, 6);
    }
    // At rest (flicker 1), the outer flame at the pot's widest height: wider than the belly without the squash, inside it with.
    const [outerR, outerH] = FLAMES[0];
    const [bellyR, bellyH] = POT_PROFILE.reduce((best, p) => (p[0] > best[0] ? p : best));
    const h = POT_BASE_Y + bellyH - 0.13;
    expect(outerR * (1 - h / outerH)).toBeGreaterThan(bellyR);
    expect(outerR * POT_FLAME_WIDEN * Math.max(0, 1 - h / (outerH * POT_FLAME_SQUASH))).toBeLessThan(bellyR);
    // Taking the pot off brings the full flames back.
    cr.sync(near, T, 1 / 60, () => viewOf({ 0: spotOf('raw_pork') }));
    for (let i = 0; i < FLAMES.length; i++) expect(matrixParts(byName(`campfire-flame-${i}`), 0).s.y).toBeCloseTo(plain[i][0].s.y, 6);
  });

  it('chunk colours follow the cooking over successive syncs: raw → roast → charred', () => {
    const { cr, byName } = setup();
    const { near } = oneFire();
    const chunks = byName('campfire-chunks');
    let prev = Infinity;
    for (const [k, steps] of [['raw_pork', 10], ['roast_pork', 10], ['charred_meat', 1]]) {
      for (let i = 0; i <= steps; i++) {
        const s = spotOf(k, i / Math.max(1, steps));
        cr.sync(near, i, 1 / 60, () => viewOf({ 2: s }));
        expect(chunks.count).toBe(1);
        const got = srgbAt(chunks, 0);
        expectRGB(got, chunkColor('meat', spotDoneness(s)));
        const sum = got.reduce((a, b) => a + b, 0);
        expect(sum).toBeLessThanOrEqual(prev + 1e-6);
        prev = sum;
      }
    }
    expectRGB(srgbAt(chunks, 0), hex3(0x2a2018));
  });

  it('packs the occupied spots of several fires densely and skips empty, null and malformed entries', () => {
    const { cr, byName } = setup();
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(5, 10, 0);
    c.add(10, 10, 0);
    c.add(15, 10, 0);
    const [a, b, d, e] = ['0,10,0', '5,10,0', '10,10,0', '15,10,0'].map((k) => c.fires.get(k));
    const views = {
      [a.key]: viewOf({ 1: spotOf('cattail_root'), 4: spotOf('roast_pork', 0.5), 2: { k: 5 }, 3: { progress: 1 } }),
      [b.key]: { spots: [null, null, null, null, null, spotOf('leached_acorns'), spotOf('pot_snow')], fuel: null },
      [d.key]: null, // no entry: nothing drawn
      [e.key]: { spots: [spotOf('unpeeled_cactus_fruit')], fuel: 3 }, // short list: only what is there
    };
    cr.sync([a, b, d, e].map((fire, i) => ({ fire, dist: i + 1 })), 1, 1 / 60, (f) => views[f.key]);
    const skewers = byName('campfire-skewers');
    const pots = byName('campfire-pots');
    expect(skewers.count).toBe(4);
    expect(byName('campfire-chunks').count).toBe(4);
    expect(pots.count).toBe(1);
    const want = [[a, 1], [a, 4], [b, 5], [e, 0]].map(([f, k]) => skewerPose(k, f.x, f.y, f.z).foot);
    const got = [0, 1, 2, 3].map((i) => matrixParts(skewers, i).p);
    for (const w of want) {
      expect(got.some((p) => Math.abs(p.x - w[0]) < 1e-5 && Math.abs(p.y - w[1]) < 1e-5 && Math.abs(p.z - w[2]) < 1e-5), `skewer at ${w}`).toBe(true);
    }
    expect(matrixParts(pots, 0).p.x).toBeCloseTo(b.x, 5);
    // Food somehow in the embers is drawn as a pot there; a pot key on a skewer as a veg chunk.
    cr.sync([{ fire: a, dist: 1 }], 2, 1 / 60, () => viewOf({ 0: spotOf('pot_water'), [POT_SPOT]: spotOf('raw_pork') }));
    expect([skewers.count, pots.count]).toEqual([1, 1]);
    expectRGB(srgbAt(byName('campfire-chunks'), 0), hex3(0xc9b27a));
  });

  it('48 fires with every spot full: 12 draw calls, 288 skewers and chunks, 48 pots; extra fires are not asked', () => {
    const { cr, meshes, byName } = setup();
    const { near } = camp(CAMPFIRE_MAX_MODELS + 5);
    const full = {};
    for (let k = 0; k < FIRE_SPOTS; k++) full[k] = k === POT_SPOT ? spotOf('pot_water', 0.3) : spotOf('raw_pork', k / 6);
    const asked = new Set();
    cr.sync(near, 1, 1 / 60, (f) => { asked.add(f.key); return viewOf(full); });
    expect(cr.count()).toBe(CAMPFIRE_MAX_MODELS);
    expect(asked.size).toBe(CAMPFIRE_MAX_MODELS);
    for (const { fire } of near.slice(0, CAMPFIRE_MAX_MODELS)) expect(asked.has(fire.key)).toBe(true);
    expect(drawCalls(meshes)).toBe(12);
    expect(byName('campfire-skewers').count).toBe(CAMPFIRE_MAX_MODELS * SKEWERS_PER_FIRE);
    expect(byName('campfire-chunks').count).toBe(CAMPFIRE_MAX_MODELS * SKEWERS_PER_FIRE);
    expect(byName('campfire-pots').count).toBe(CAMPFIRE_MAX_MODELS);
    for (const n of ['campfire-skewers', 'campfire-chunks', 'campfire-pots']) {
      const m = byName(n);
      expect(m.count, n).toBeLessThanOrEqual(m.instanceMatrix.count);
    }
  });

  it('the spot parts clear when the spots empty, when the fires go, and when spotsView stops coming', () => {
    const { cr, meshes, byName } = setup();
    const { near } = oneFire();
    const cooking = () => viewOf({ 0: spotOf('raw_pork'), 6: spotOf('pot_water') });
    cr.sync(near, 1, 1 / 60, cooking);
    expect(drawCalls(meshes)).toBe(12);
    cr.sync(near, 1.1, 1 / 60, () => viewOf({}));
    expect(drawCalls(meshes)).toBe(9);
    cr.sync(near, 1.2, 1 / 60, cooking);
    expect(drawCalls(meshes)).toBe(12);
    cr.sync(near, 1.3, 1 / 60); // switched to Creative: main passes no spotsView
    expect(drawCalls(meshes)).toBe(9);
    cr.sync(near, 1.4, 1 / 60, cooking);
    cr.sync([], 1.5, 1 / 60, cooking); // the fire went out of range (or was broken)
    expect(drawCalls(meshes)).toBe(0);
    for (const n of ['campfire-skewers', 'campfire-chunks', 'campfire-pots']) expect(byName(n).count).toBe(0);
  });

  it('chunks and pots carry instance colours from the start, so prewarm compiles the program they draw with', async () => {
    const { cr, root, byName } = setup();
    for (const n of ['campfire-chunks', 'campfire-pots']) {
      const m = byName(n);
      expect(m.instanceColor, n).not.toBeNull();
      expect(m.instanceColor.usage, n).toBe(THREE.DynamicDrawUsage);
    }
    const compiled = new Set();
    await cr.prewarm({ compileAsync: (obj) => { obj.traverse((o) => { if (o.isMesh) compiled.add(o.material); }); return Promise.resolve(); } }, new THREE.PerspectiveCamera());
    for (const n of ['campfire-skewers', 'campfire-chunks', 'campfire-pots']) expect(compiled.has(byName(n).material), n).toBe(true);
    expect(byName('campfire-pots').parent).toBe(root);
  });

  it('a world that loads with food on its fires draws it after the warm-up frame', () => {
    const { cr, meshes, byName } = setup();
    cr.prewarm(null, new THREE.PerspectiveCamera());
    const { near } = oneFire();
    cr.sync(near, 1, 1 / 60, () => viewOf({ 5: spotOf('wild_tuber'), 6: spotOf('pot_seawater') }));
    for (const m of meshes) m.onAfterRender();
    expect(drawCalls(meshes)).toBe(12);
    expect(byName('campfire-skewers').count).toBe(1);
    expect(byName('campfire-pots').count).toBe(1);
    expect(matrixParts(byName('campfire-pots'), 0).p.y).toBeGreaterThan(0); // the real pot, not the warm-up speck
  });

  it('cooking never creates or disposes a material; dispose() frees all 12 parts', () => {
    const { cr, meshes } = setup();
    const { near } = camp(6);
    const events = [];
    for (const m of meshes) {
      m.material.addEventListener('dispose', () => events.push(`mat:${m.name}`));
      m.geometry.addEventListener('dispose', () => events.push(`geo:${m.name}`));
    }
    for (let i = 0; i < 20; i++) {
      cr.sync(near.slice(0, 1 + (i % 6)), i, 1 / 60, () => viewOf(i % 3 ? { [i % 7]: spotOf('raw_pork', (i % 10) / 10) } : {}));
    }
    expect(events).toEqual([]);
    cr.dispose();
    for (const m of meshes) {
      expect(events, m.name).toContain(`mat:${m.name}`);
      expect(events, m.name).toContain(`geo:${m.name}`);
    }
  });
});
