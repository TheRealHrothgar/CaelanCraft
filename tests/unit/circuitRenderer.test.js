// circuitRenderer.js — Node only (three's core objects work without WebGL). docs/DESIGN-circuits.md §4.11, §6.2.8, §7 C:
// one segment mesh, one knob mesh and nine overlay meshes (≤ 11 draw calls), frustumCulled off, never a light.
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createCircuitRenderer, OVERLAY_TYPES, INITIAL_CAPACITY } from '../../src/circuitRenderer.js';
import {
  wireSegments, overlayPose, SEGMENT_COLOURS, COLOUR, KNOB_KIND, KNOB_STRIDE, SEGMENT_STRIDE, BLADE_OPEN_RAD, BLADE_EASE_S,
  BULB_ALPHA,
} from '../../src/circuitGeometry.js';
import { BLOCK } from '../../src/blocks.js';
import { packCell } from '../../src/coords.js';

function setup() {
  const scene = new THREE.Scene();
  const cr = createCircuitRenderer(scene);
  const root = scene.getObjectByName('circuits');
  const mesh = (name) => /** @type {THREE.InstancedMesh} */ (root.getObjectByName(name));
  const meshes = () => {
    const list = [];
    root.traverse((o) => { if (o.isInstancedMesh) list.push(o); });
    return list;
  };
  return { scene, cr, root, mesh, meshes };
}

/** A scene's lights (there must never be one). */
function lights(scene) {
  const out = [];
  scene.traverse((o) => { if (o.isLight) out.push(o); });
  return out;
}

/** Draw calls: one per visible mesh with instances (none is double-sided-transparent, which would draw twice). */
function drawCalls(meshes) {
  let n = 0;
  for (const m of meshes) {
    if (!m.visible || m.count === 0) continue;
    const mat = /** @type {THREE.Material} */ (m.material);
    n += mat.transparent && mat.side === THREE.DoubleSide && !mat.forceSinglePass ? 2 : 1;
  }
  return n;
}

/** Wiring for a small scene: battery, three copper wires, a lamp, a riser, a relay, a grounded earth wire. */
function wiring() {
  const cells = new Map();
  const set = (q, y, r, id) => cells.set(`${q},${y},${r}`, id);
  set(0, 0, 0, BLOCK.VOLTAIC_BATTERY);
  for (let q = 1; q <= 3; q++) set(q, 0, 0, BLOCK.COPPER_WIRE);
  set(3, 1, 0, BLOCK.COPPER_WIRE);
  set(4, 0, 0, BLOCK.FILAMENT_LAMP);
  set(0, 0, 3, BLOCK.RELAY);
  set(2, 0, 3, BLOCK.EARTH_WIRE);
  const view = {
    cellsNear: () => [...cells.keys()].map((k) => packCell(...k.split(',').map(Number))),
    get: (q, y, r) => cells.get(`${q},${y},${r}`) ?? 0,
    inputFace: () => 3,
    grounded: (q, y, r) => q === 2 && r === 3,
  };
  return wireSegments(view, 0, 0.5, 0, 64);
}

const ITEM = (type, extra = {}) => ({ type, q: 0, y: 4, r: 0, a: 1, b: 0, ...extra });
const ALL_ITEMS = [
  ITEM('blade'), ITEM('cap'), ITEM('hand', { a: 0.3 }), ITEM('arm', { b: 1 }), ITEM('plunger', { a: 0.5 }), ITEM('hammer'),
  ITEM('bulb', { a: 0.7 }), ITEM('glow', { glow: 'lamp', a: 0.7 }), ITEM('glow', { glow: 'ember' }), ITEM('staff', { staff: 'torch' }),
  ITEM('staff', { staff: 'filament', a: 0.7 }), ITEM('staff', { staff: 'char', a: 0.4, b: 2 }),
];

describe('circuit renderer: meshes (§6.2.8)', () => {
  it('has exactly 1 segment mesh, 1 knob mesh and 9 overlay meshes, all with frustum culling off', () => {
    const { meshes, mesh } = setup();
    const ms = meshes();
    expect(ms).toHaveLength(11);
    expect(OVERLAY_TYPES).toEqual(['blade', 'cap', 'hand', 'arm', 'plunger', 'hammer', 'bulb', 'glow', 'staff']);
    expect(ms.map((m) => m.name).sort()).toEqual(['circuit-segments', 'circuit-knobs', ...OVERLAY_TYPES.map((t) => `circuit-${t}`)].sort());
    for (const m of ms) {
      expect(m.frustumCulled, m.name).toBe(false);
      expect(m.count).toBe(0);
      expect(m.visible).toBe(false);
      expect(m.instanceMatrix.count).toBe(INITIAL_CAPACITY);
      expect(m.instanceColor).toBeTruthy();
    }
    // Lit like the world, except the bulb's clear glass and the additive glows.
    for (const name of ['circuit-segments', 'circuit-knobs', 'circuit-blade', 'circuit-staff']) {
      expect(mesh(name).material).toBeInstanceOf(THREE.MeshLambertMaterial);
    }
    const glass = /** @type {THREE.Material} */ (mesh('circuit-bulb').material);
    expect(glass.transparent && glass.opacity === BULB_ALPHA && glass.depthWrite === false).toBe(true);
    const glow = /** @type {THREE.ShaderMaterial} */ (mesh('circuit-glow').material);
    expect(glow.isShaderMaterial && glow.depthWrite === false && glow.blending === THREE.CustomBlending).toBe(true);
    expect([glow.blendSrc, glow.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
  });

  it('never adds a light, whatever it draws (and prewarm adds none either)', async () => {
    const { scene, cr } = setup();
    const before = lights(scene).length;
    expect(before).toBe(0);
    cr.setGeometry(wiring());
    const many = [];
    for (let k = 0; k < 300; k++) many.push(...ALL_ITEMS.map((it) => ({ ...it, q: k })));
    cr.syncOverlays(many, 1, 1 / 60);
    await cr.prewarm({ compileAsync: () => Promise.resolve() }, new THREE.PerspectiveCamera());
    expect(lights(scene)).toHaveLength(0);
    let objects = 0;
    scene.traverse(() => objects++);
    expect(objects).toBe(1 + 1 + 11); // the scene, the 'circuits' group and its eleven meshes
  });
});

describe('circuit renderer: static wiring', () => {
  it('draws one box per segment, along the segment, in its colour; knobs expand into body, groove and cap', () => {
    const { cr, mesh } = setup();
    const geo = wiring();
    cr.setGeometry(geo);
    const seg = mesh('circuit-segments');
    expect(seg.count).toBe(geo.seg.count);
    expect(seg.visible).toBe(true);
    // Check every segment's matrix: the unit box's ±x ends land on the record's ends; its section is the width.
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < geo.seg.count; i++) {
      const d = geo.seg.data.subarray(i * SEGMENT_STRIDE, (i + 1) * SEGMENT_STRIDE);
      seg.getMatrixAt(i, m);
      const a = new THREE.Vector3(-0.5, 0, 0).applyMatrix4(m);
      const b = new THREE.Vector3(0.5, 0, 0).applyMatrix4(m);
      expect(a.distanceTo(new THREE.Vector3(d[0], d[1], d[2]))).toBeLessThan(1e-5);
      expect(b.distanceTo(new THREE.Vector3(d[3], d[4], d[5]))).toBeLessThan(1e-5);
      const side = new THREE.Vector3(0, 0.5, 0).applyMatrix4(m).sub(new THREE.Vector3(0, 0, 0).applyMatrix4(m));
      expect(side.length() * 2).toBeCloseTo(d[6], 5);
      seg.getColorAt(i, c);
      expect(c.getHex()).toBe(new THREE.Color(SEGMENT_COLOURS[d[7]]).getHex());
    }
    const kinds = [0, 0, 0, 0];
    for (let i = 0; i < geo.knob.count; i++) kinds[geo.knob.data[i * KNOB_STRIDE + 3]]++;
    expect(kinds[KNOB_KIND.KNOB]).toBe(4);
    expect(kinds[KNOB_KIND.TUBE]).toBe(1);
    expect(kinds[KNOB_KIND.POST]).toBe(2);
    expect(kinds[KNOB_KIND.CLAMP]).toBe(1);
    expect(mesh('circuit-knobs').count).toBe(4 * 3 + 1 + 2 + 1 * 2);
    // The first knob's body is porcelain.
    mesh('circuit-knobs').getColorAt(0, c);
    expect(c.getHex()).toBe(new THREE.Color(SEGMENT_COLOURS[COLOUR.PORCELAIN]).getHex());
    expect(cr.count()).toBe(geo.seg.count + 4 * 3 + 1 + 2 + 2);
  });

  it('grows past its first capacity, and setGeometry(null) clears the wiring', () => {
    const { cr, mesh, meshes } = setup();
    const n = INITIAL_CAPACITY * 5 + 3;
    const data = new Float32Array(n * SEGMENT_STRIDE);
    for (let i = 0; i < n; i++) data.set([i, 0.1, 0, i + 0.5, 0.1, 0, 0.03, COLOUR.BROWN], i * SEGMENT_STRIDE);
    cr.setGeometry({ seg: { data, count: n }, knob: { data: new Float32Array(0), count: 0 } });
    expect(mesh('circuit-segments').count).toBe(n);
    expect(mesh('circuit-segments').instanceMatrix.count).toBeGreaterThanOrEqual(n);
    expect(meshes()).toHaveLength(11); // the old mesh was replaced, not kept
    expect(mesh('circuit-segments').frustumCulled).toBe(false);
    cr.setGeometry(null);
    expect(mesh('circuit-segments').count).toBe(0);
    expect(mesh('circuit-segments').visible).toBe(false);
    expect(mesh('circuit-knobs').visible).toBe(false);
    // A zero-length record is skipped rather than drawn degenerate.
    cr.setGeometry({ seg: { data: new Float32Array([1, 1, 1, 1, 1, 1, 0.03, 0]), count: 1 }, knob: { data: new Float32Array(0), count: 0 } });
    expect(mesh('circuit-segments').count).toBe(0);
  });
});

describe('circuit renderer: overlays', () => {
  it('draws each item\'s poses in its type\'s mesh: instance counts follow overlayPose, in at most 11 draw calls', () => {
    const { cr, mesh, meshes } = setup();
    cr.setGeometry(wiring());
    cr.syncOverlays(ALL_ITEMS, 2, 1 / 60);
    const want = Object.fromEntries(OVERLAY_TYPES.map((t) => [t, 0]));
    for (const it of ALL_ITEMS) want[it.type] += overlayPose(it, 2, []);
    for (const t of OVERLAY_TYPES) expect(mesh(`circuit-${t}`).count, t).toBe(want[t]);
    expect(drawCalls(meshes())).toBe(11);
    // Hundreds of parts still cost 11 draw calls; the meshes grow to hold them.
    const many = [];
    for (let k = 0; k < 512; k++) many.push({ ...ALL_ITEMS[k % ALL_ITEMS.length], q: k % 40, r: Math.floor(k / 40) });
    cr.syncOverlays(many, 2.1, 1 / 60);
    expect(drawCalls(meshes())).toBe(11);
    expect(mesh('circuit-blade').count).toBe(6 * many.filter((it) => it.type === 'blade').length);
    cr.syncOverlays([], 2.2, 1 / 60);
    for (const t of OVERLAY_TYPES) expect(mesh(`circuit-${t}`).visible, t).toBe(false);
    cr.syncOverlays(null, 2.3, 1 / 60);
    expect(drawCalls(meshes())).toBe(2); // only the wiring is left
  });

  it('places each pose with its rotation (YXZ) and scale', () => {
    const { cr, mesh } = setup();
    const item = ITEM('staff', { staff: 'torch', q: 5, y: 2, r: -7 });
    cr.syncOverlays([item], 0, 0);
    const ps = [];
    overlayPose(item, 0, ps);
    const m = new THREE.Matrix4();
    mesh('circuit-staff').getMatrixAt(1, m);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    const p = ps[1];
    expect(pos.distanceTo(new THREE.Vector3(p.x, p.y, p.z))).toBeLessThan(1e-5);
    expect(scl.distanceTo(new THREE.Vector3(p.sx, p.sy, p.sz))).toBeLessThan(1e-5);
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rx, p.ry, p.rz, 'YXZ'));
    expect(quat.angleTo(want)).toBeLessThan(1e-4);
    // The shaft's +y axis is the torch's lean.
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    expect(Math.acos(axis.y)).toBeCloseTo((12 * Math.PI) / 180, 5);
  });

  it('glows are additive: the pose\'s alpha scales its colour', () => {
    const { cr, mesh } = setup();
    cr.syncOverlays([ITEM('glow', { glow: 'lamp', a: 0.5 })], 0, 0);
    const c = new THREE.Color();
    mesh('circuit-glow').getColorAt(0, c);
    const want = new THREE.Color(0xffd27a).multiplyScalar(0.5);
    expect(Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b)).toBeLessThan(1e-6);
    const m = new THREE.Matrix4();
    mesh('circuit-glow').getMatrixAt(0, m);
    const s = new THREE.Vector3().setFromMatrixScale(m);
    expect(s.x).toBeCloseTo(0.4, 5);
  });

  it('eases a knife switch\'s blade over BLADE_EASE_S, per switch, and forgets switches that leave the list', () => {
    const { cr, mesh } = setup();
    const angle = () => {
      const m = new THREE.Matrix4();
      mesh('circuit-blade').getMatrixAt(0, m);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m));
      return new THREE.Euler().setFromQuaternion(q, 'YXZ').z;
    };
    cr.syncOverlays([ITEM('blade', { a: 1 })], 0, 1 / 60); // first sight: no easing
    expect(angle()).toBeCloseTo(0, 6);
    cr.syncOverlays([ITEM('blade', { a: 0 })], 0, BLADE_EASE_S / 2); // half way, smoothstep(0.5) = 0.5
    expect(angle()).toBeCloseTo(BLADE_OPEN_RAD / 2, 5);
    cr.syncOverlays([ITEM('blade', { a: 0 })], 0, BLADE_EASE_S / 2);
    expect(angle()).toBeCloseTo(BLADE_OPEN_RAD, 5);
    cr.syncOverlays([ITEM('blade', { a: 0 })], 0, 1);
    expect(angle()).toBeCloseTo(BLADE_OPEN_RAD, 5);
    // A switch that drops out of view comes back at its state, without a swing.
    cr.syncOverlays([], 0, 1 / 60);
    cr.syncOverlays([ITEM('blade', { a: 1 })], 0, 1 / 60);
    expect(angle()).toBeCloseTo(0, 6);
    // Two switches ease independently.
    cr.syncOverlays([ITEM('blade', { a: 0 }), ITEM('blade', { q: 9, a: 1 })], 0, BLADE_EASE_S / 2);
    expect(angle()).toBeCloseTo(BLADE_OPEN_RAD / 2, 5);
  });

  it('skips items it does not know', () => {
    const { cr } = setup();
    cr.syncOverlays([null, { type: 'ghost', q: 0, y: 0, r: 0, a: 0, b: 0 }, ITEM('glow', { glow: 'nope' })], 0, 0);
    expect(cr.count()).toBe(0);
  });
});

describe('circuit renderer: prewarm and dispose', () => {
  it('prewarm compiles the whole group and has every mesh draw one hidden speck in the next frame', async () => {
    const { cr, meshes, root, scene } = setup();
    const compileAsync = vi.fn(() => Promise.resolve());
    const camera = new THREE.PerspectiveCamera();
    await cr.prewarm({ compileAsync }, camera);
    expect(compileAsync).toHaveBeenCalledWith(root, camera, scene);
    for (const m of meshes()) {
      expect(m.count, m.name).toBe(1);
      expect(m.visible).toBe(true);
      const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m.instanceMatrix.array, 0));
      expect(p.y).toBeLessThan(-1000);
    }
    // After that draw, a mesh with nothing to show goes quiet again.
    for (const m of meshes()) m.onAfterRender();
    for (const m of meshes()) expect(m.visible, m.name).toBe(false);
    // compile() is used when compileAsync is missing; a renderer without either still resolves.
    const compile = vi.fn();
    await setup().cr.prewarm({ compile }, camera);
    expect(compile).toHaveBeenCalledTimes(1);
    await expect(setup().cr.prewarm(null, camera)).resolves.toBeUndefined();
    await expect(setup().cr.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
  });

  it('a mesh given work before its warm-up draw keeps drawing it afterwards', async () => {
    const { cr, mesh } = setup();
    await cr.prewarm(null, new THREE.PerspectiveCamera());
    cr.syncOverlays([ITEM('cap')], 0, 0);
    const cap = mesh('circuit-cap');
    expect(cap.count).toBe(2);
    cap.onAfterRender();
    expect(cap.count).toBe(2);
    expect(cap.visible).toBe(true);
  });

  it('dispose removes the group and frees its geometries and materials', () => {
    const { cr, scene, mesh } = setup();
    const mat = /** @type {THREE.Material} */ (mesh('circuit-glow').material);
    const spy = vi.fn();
    mat.addEventListener('dispose', spy);
    cr.dispose();
    expect(scene.getObjectByName('circuits')).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
