// circuitRenderer.js — Node only (three's core objects work without WebGL). docs/DESIGN-circuits.md §4.11, §6.2.8, §7 C, and
// the user's "fun and simple" redo: every device is a small 3D model drawn from wireSegments' body records. One static and
// one animated InstancedMesh per batch (17 in all, so ≤ 17 draw calls however many parts), frustumCulled off, never a light.
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createCircuitRenderer, OVERLAY_TYPES, INITIAL_CAPACITY, MESH_NAMES, STATIC_BATCHES } from '../../src/circuitRenderer.js';
import {
  wireSegments, overlayPose, modelPoses, SEGMENT_COLOURS, COLOUR, KNOB_KIND, KNOB_STRIDE, SEGMENT_STRIDE, BODY_STRIDE,
  BLADE_OPEN_RAD, BLADE_EASE_S, GLASS_ALPHA, BATCHES, BATCH, MODELS,
} from '../../src/circuitGeometry.js';
import { BLOCK } from '../../src/blocks.js';
import { packCell } from '../../src/coords.js';
import { hexToWorld } from '../../src/hex.js';

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
const stat = (b) => `circuit-${BATCHES[b].name}`;
const anim = (b) => `circuit-${BATCHES[b].name}-anim`;

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

/** A Map-backed geometry view over `cells` ("q,y,r" → id) and `faces` (input faces). */
function viewOf(cells, faces = new Map()) {
  return {
    cellsNear: () => [...cells.keys()].map((k) => packCell(...k.split(',').map(Number))),
    get: (q, y, r) => cells.get(`${q},${y},${r}`) ?? 0,
    inputFace: (q, y, r) => faces.get(`${q},${y},${r}`) ?? 3,
    grounded: (q, y, r) => q === 2 && r === 3,
  };
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
  return wireSegments(viewOf(cells), 0, 0.5, 0, 64);
}

const ITEM = (type, extra = {}) => ({ type, q: 0, y: 4, r: 0, a: 1, b: 0, ...extra });
const ALL_ITEMS = [
  ITEM('blade'), ITEM('cap'), ITEM('hand', { a: 0.3 }), ITEM('arm', { b: 1 }), ITEM('plunger', { a: 0.5 }), ITEM('hammer'),
  ITEM('bulb', { a: 0.7 }), ITEM('glow', { glow: 'lamp', a: 0.7 }), ITEM('glow', { glow: 'ember' }), ITEM('staff', { staff: 'torch' }),
  ITEM('staff', { staff: 'filament', a: 0.7 }), ITEM('staff', { staff: 'char', a: 0.4, b: 2 }), ITEM('glow', { glow: 'igniter' }),
];
/** Instances per batch that overlayPose gives for `items` at time t (no input faces). */
function wantPerBatch(items, t) {
  const want = BATCHES.map(() => 0);
  const ps = [];
  for (const it of items) {
    const n = overlayPose(it, t, ps);
    for (let i = 0; i < n; i++) want[ps[i].batch]++;
  }
  return want;
}

describe('circuit renderer: meshes (§6.2.8)', () => {
  it('has one static mesh per batch but the glow and one animated mesh per batch — 17, all with frustum culling off', () => {
    const { meshes, mesh } = setup();
    const ms = meshes();
    expect(ms).toHaveLength(17);
    expect(STATIC_BATCHES).toHaveLength(8);
    expect(ms.map((m) => m.name).sort()).toEqual([...MESH_NAMES].sort());
    expect(OVERLAY_TYPES).toEqual(['blade', 'cap', 'hand', 'arm', 'plunger', 'hammer', 'bulb', 'glow', 'staff']);
    for (const m of ms) {
      expect(m.frustumCulled, m.name).toBe(false);
      expect(m.count).toBe(0);
      expect(m.visible).toBe(false);
      expect(m.instanceMatrix.count).toBe(INITIAL_CAPACITY);
      expect(m.instanceColor).toBeTruthy();
    }
    // Lit like the world, except the clear glass, the unlit parts that shine at night, and the additive glows.
    for (const b of [BATCH.BOX, BATCH.HEX, BATCH.CYL, BATCH.BALL, BATCH.BELL]) {
      expect(mesh(stat(b)).material).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(mesh(anim(b)).material).toBe(mesh(stat(b)).material); // one material, one program
    }
    const glass = /** @type {THREE.Material} */ (mesh(stat(BATCH.GLASS)).material);
    expect(glass.transparent && glass.opacity === GLASS_ALPHA && glass.depthWrite === false && glass.side === THREE.FrontSide).toBe(true);
    expect(mesh(stat(BATCH.LIT)).material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(mesh(stat(BATCH.LIT_BOX)).material).toBe(mesh(stat(BATCH.LIT)).material);
    const glow = /** @type {THREE.ShaderMaterial} */ (mesh(anim(BATCH.GLOW)).material);
    expect(glow.isShaderMaterial && glow.depthWrite === false && glow.blending === THREE.CustomBlending).toBe(true);
    expect([glow.blendSrc, glow.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    expect(mesh(stat(BATCH.GLOW))).toBeUndefined();
    // The unit shapes: a bell (a lathe, centred like the others, rim down), round cylinders and balls, the hex prism.
    const bell = mesh(stat(BATCH.BELL)).geometry;
    bell.computeBoundingBox();
    expect(bell.type).toBe('LatheGeometry');
    expect(bell.boundingBox.min.y).toBeCloseTo(-0.5, 6);
    expect(bell.boundingBox.max.y).toBeCloseTo(0.5, 6);
    expect(bell.boundingBox.max.x).toBeCloseTo(0.5, 2);
    for (let i = 0; i < bell.attributes.normal.count; i++) {
      const n = new THREE.Vector3().fromBufferAttribute(bell.attributes.normal, i);
      expect(Math.abs(n.length() - 1)).toBeLessThan(1e-3);
    }
    expect(mesh(stat(BATCH.HEX)).geometry.parameters.radialSegments).toBe(6);
    expect(mesh(stat(BATCH.CYL)).geometry.parameters.radialSegments).toBeGreaterThan(6);
  });

  it('never adds a light, whatever it draws (and prewarm adds none either)', async () => {
    const { scene, cr } = setup();
    expect(lights(scene)).toHaveLength(0);
    cr.setGeometry(wiring());
    const many = [];
    for (let k = 0; k < 300; k++) many.push(...ALL_ITEMS.map((it) => ({ ...it, q: k })));
    cr.syncOverlays(many, 1, 1 / 60);
    cr.syncMoving([{ id: BLOCK.COLLAPSAR_CHARGE, x: 0, y: 5.5, z: 0, rx: 0, ry: 1, rz: 0, scale: 1.1 }]);
    await cr.prewarm({ compileAsync: () => Promise.resolve() }, new THREE.PerspectiveCamera());
    expect(lights(scene)).toHaveLength(0);
    let objects = 0;
    scene.traverse(() => objects++);
    expect(objects).toBe(1 + 1 + 17); // the scene, the 'circuits' group and its seventeen meshes
  });
});

describe('circuit renderer: static wiring and models', () => {
  it('draws one box per segment, along the segment, in its colour; knobs expand into body, groove and cap', () => {
    const { cr, mesh } = setup();
    const geo = wiring();
    cr.setGeometry(geo);
    const box = mesh(stat(BATCH.BOX));
    expect(box.visible).toBe(true);
    // The segments come first in the box mesh; the device boxes follow.
    const deviceBoxes = [...Array(geo.body.count).keys()].filter((i) => geo.body.data[i * BODY_STRIDE + 10] === BATCH.BOX).length;
    expect(box.count).toBe(geo.seg.count + deviceBoxes);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < geo.seg.count; i++) {
      const d = geo.seg.data.subarray(i * SEGMENT_STRIDE, (i + 1) * SEGMENT_STRIDE);
      box.getMatrixAt(i, m);
      const a = new THREE.Vector3(-0.5, 0, 0).applyMatrix4(m);
      const b = new THREE.Vector3(0.5, 0, 0).applyMatrix4(m);
      expect(a.distanceTo(new THREE.Vector3(d[0], d[1], d[2]))).toBeLessThan(1e-5);
      expect(b.distanceTo(new THREE.Vector3(d[3], d[4], d[5]))).toBeLessThan(1e-5);
      const side = new THREE.Vector3(0, 0.5, 0).applyMatrix4(m).sub(new THREE.Vector3(0, 0, 0).applyMatrix4(m));
      expect(side.length() * 2).toBeCloseTo(d[6], 5);
      box.getColorAt(i, c);
      expect(c.getHex()).toBe(new THREE.Color(SEGMENT_COLOURS[d[7]]).getHex());
    }
    const kinds = [0, 0, 0, 0];
    for (let i = 0; i < geo.knob.count; i++) kinds[geo.knob.data[i * KNOB_STRIDE + 3]]++;
    expect(kinds[KNOB_KIND.KNOB]).toBe(4);
    expect(kinds[KNOB_KIND.TUBE]).toBe(1);
    expect(kinds[KNOB_KIND.POST]).toBe(2 + 2); // the relay's binding posts, and the studs of the battery's and lamp's leads
    expect(kinds[KNOB_KIND.CLAMP]).toBe(1);
    expect(mesh(stat(BATCH.HEX)).count).toBe(4 * 3 + 1 + 4 + 1 * 2);
    // A knob's body is porcelain (the instances before it: one per post or tube, two per clamp).
    let at = 0;
    for (let i = 0; i < geo.knob.count && geo.knob.data[i * KNOB_STRIDE + 3] !== KNOB_KIND.KNOB; i++) {
      at += geo.knob.data[i * KNOB_STRIDE + 3] === KNOB_KIND.CLAMP ? 2 : 1;
    }
    mesh(stat(BATCH.HEX)).getColorAt(at, c);
    expect(c.getHex()).toBe(new THREE.Color(SEGMENT_COLOURS[COLOUR.PORCELAIN]).getHex());
    // Every body record lands in its batch's static mesh.
    const perBatch = BATCHES.map(() => 0);
    for (let i = 0; i < geo.body.count; i++) perBatch[geo.body.data[i * BODY_STRIDE + 10]]++;
    for (const b of STATIC_BATCHES) {
      if (b === BATCH.BOX || b === BATCH.HEX) continue;
      expect(mesh(stat(b)).count, BATCHES[b].name).toBe(perBatch[b]);
    }
    expect(geo.body.count).toBe(MODELS[BLOCK.VOLTAIC_BATTERY].parts.length + MODELS[BLOCK.FILAMENT_LAMP].parts.length
      + MODELS[BLOCK.RELAY].parts.length);
    expect(cr.count()).toBe(geo.seg.count + 4 * 3 + 1 + 4 + 2 + geo.body.count);
  });

  it('places a model part with its turn and scale, in its colour (the lamp\'s glass bulb)', () => {
    const { cr, mesh } = setup();
    const cells = new Map([['5,2,-7', BLOCK.FILAMENT_LAMP]]);
    const geo = wireSegments(viewOf(cells), 0, 2.5, 0, 64);
    cr.setGeometry(geo);
    const glass = mesh(stat(BATCH.GLASS));
    expect(glass.count).toBe(1);
    const m = new THREE.Matrix4();
    glass.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), scl);
    const [x, z] = hexToWorld(5, -7);
    const part = MODELS[BLOCK.FILAMENT_LAMP].parts.find((p) => p[0] === BATCH.GLASS);
    expect(pos.distanceTo(new THREE.Vector3(x + part[1], 2 + part[2], z + part[3]))).toBeLessThan(1e-5);
    expect(scl.distanceTo(new THREE.Vector3(part[4], part[5], part[6]))).toBeLessThan(1e-5);
    const c = new THREE.Color();
    glass.getColorAt(0, c);
    expect(c.getHex()).toBe(new THREE.Color(part[7]).getHex());
  });

  it('grows past its first capacity, and setGeometry(null) clears the wiring and the models', () => {
    const { cr, mesh, meshes } = setup();
    const n = INITIAL_CAPACITY * 5 + 3;
    const data = new Float32Array(n * SEGMENT_STRIDE);
    for (let i = 0; i < n; i++) data.set([i, 0.1, 0, i + 0.5, 0.1, 0, 0.03, COLOUR.BROWN], i * SEGMENT_STRIDE);
    cr.setGeometry({ seg: { data, count: n }, knob: { data: new Float32Array(0), count: 0 } });
    const box = mesh(stat(BATCH.BOX));
    expect(box.count).toBe(n);
    expect(box.instanceMatrix.count).toBeGreaterThanOrEqual(n);
    expect(meshes()).toHaveLength(17); // the old mesh was replaced, not kept
    expect(box.frustumCulled).toBe(false);
    // Every instance written before the growth survived it (none was left at the origin).
    const m = new THREE.Matrix4();
    box.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(0.25, 5);
    cr.setGeometry(wiring());
    expect(mesh(stat(BATCH.CYL)).count).toBeGreaterThan(0);
    cr.setGeometry(null);
    for (const b of STATIC_BATCHES) expect(mesh(stat(b)).visible, BATCHES[b].name).toBe(false);
    expect(cr.count()).toBe(0);
    // A zero-length record is skipped rather than drawn degenerate.
    cr.setGeometry({ seg: { data: new Float32Array([1, 1, 1, 1, 1, 1, 0.03, 0]), count: 1 }, knob: { data: new Float32Array(0), count: 0 } });
    expect(mesh(stat(BATCH.BOX)).count).toBe(0);
  });
});

describe('circuit renderer: overlays', () => {
  it('draws each item\'s poses in its batch\'s animated mesh: counts follow overlayPose, in at most 17 draw calls', () => {
    const { cr, mesh, meshes } = setup();
    cr.setGeometry(wiring());
    cr.syncOverlays(ALL_ITEMS, 2, 1 / 60);
    const want = wantPerBatch(ALL_ITEMS, 2);
    for (let b = 0; b < BATCHES.length; b++) expect(mesh(anim(b)).count, BATCHES[b].name).toBe(want[b]);
    expect(drawCalls(meshes())).toBeLessThanOrEqual(17);
    // Hundreds of parts still cost at most 17 draw calls; the meshes grow to hold them.
    const many = [];
    for (let k = 0; k < 512; k++) many.push({ ...ALL_ITEMS[k % ALL_ITEMS.length], q: k % 40, r: Math.floor(k / 40) });
    cr.syncOverlays(many, 2.1, 1 / 60);
    expect(drawCalls(meshes())).toBeLessThanOrEqual(17);
    const wantMany = wantPerBatch(many, 2.1);
    for (let b = 0; b < BATCHES.length; b++) expect(mesh(anim(b)).count, BATCHES[b].name).toBe(wantMany[b]);
    cr.syncOverlays([], 2.2, 1 / 60);
    for (let b = 0; b < BATCHES.length; b++) expect(mesh(anim(b)).visible, BATCHES[b].name).toBe(false);
    cr.syncOverlays(null, 2.3, 1 / 60);
    expect(drawCalls(meshes())).toBe(STATIC_BATCHES.filter((b) => mesh(stat(b)).count > 0).length); // only the static geometry
  });

  it('places each pose with its rotation (YXZ) and scale', () => {
    const { cr, mesh } = setup();
    const item = ITEM('staff', { staff: 'torch', q: 5, y: 2, r: -7 });
    cr.syncOverlays([item], 0, 0);
    const ps = [];
    overlayPose(item, 0, ps);
    const m = new THREE.Matrix4();
    mesh(anim(BATCH.BOX)).getMatrixAt(1, m);
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

  it('turns a relay\'s armature and a timer\'s hand with the input face its static model was turned to', () => {
    const { cr, mesh } = setup();
    const cells = new Map([['0,0,0', BLOCK.RELAY], ['3,0,0', BLOCK.CLOCKWORK_TIMER]]);
    const faces = new Map([['0,0,0', 1], ['3,0,0', 4]]);
    cr.setGeometry(wireSegments(viewOf(cells, faces), 0, 0.5, 0, 64));
    const arm = { type: 'arm', q: 0, y: 0, r: 0, a: 1, b: 0 };
    const hand = { type: 'hand', q: 3, y: 0, r: 0, a: 0.25, b: 0 };
    cr.syncOverlays([arm, hand], 0, 0);
    const box = mesh(anim(BATCH.BOX));
    const got = (i) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(box.instanceMatrix.array, i * 16));
    const ps = [];
    const na = overlayPose(arm, 0, ps, 1);
    expect(got(0).distanceTo(new THREE.Vector3(ps[0].x, ps[0].y, ps[0].z))).toBeLessThan(1e-5);
    overlayPose(hand, 0, ps, 4);
    expect(got(na).distanceTo(new THREE.Vector3(ps[0].x, ps[0].y, ps[0].z))).toBeLessThan(1e-5);
    // Without the geometry the default face is used.
    cr.setGeometry(null);
    cr.syncOverlays([arm], 0, 0);
    overlayPose(arm, 0, ps);
    expect(got(0).distanceTo(new THREE.Vector3(ps[0].x, ps[0].y, ps[0].z))).toBeLessThan(1e-5);
  });

  it('glows are additive: the pose\'s alpha scales its colour', () => {
    const { cr, mesh } = setup();
    cr.syncOverlays([ITEM('glow', { glow: 'lamp', a: 0.5 })], 0, 0);
    const c = new THREE.Color();
    mesh(anim(BATCH.GLOW)).getColorAt(0, c);
    const want = new THREE.Color(0xffd27a).multiplyScalar(0.5);
    expect(Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b)).toBeLessThan(1e-6);
    const m = new THREE.Matrix4();
    mesh(anim(BATCH.GLOW)).getMatrixAt(0, m);
    const s = new THREE.Vector3().setFromMatrixScale(m);
    expect(s.x).toBeCloseTo(0.35 + 0.55 * 0.5, 5);
  });

  it('eases a knife switch\'s lever over BLADE_EASE_S, per switch, and forgets switches that leave the list', () => {
    const { cr, mesh } = setup();
    const angle = () => {
      const m = new THREE.Matrix4();
      mesh(anim(BATCH.BOX)).getMatrixAt(0, m);
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

describe('circuit renderer: moving copies (syncMoving)', () => {
  it('draws the device blocks among the falling renderer\'s items as their models, turned and scaled; ignores the rest', () => {
    const { cr, mesh } = setup();
    const charge = { id: BLOCK.COLLAPSAR_CHARGE, x: 4, y: 7.5, z: -2, rx: 0.3, ry: 1.2, rz: 0, scale: 0.5 };
    cr.syncMoving([charge, { id: BLOCK.STONE, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 },
      null, { id: BLOCK.VOLTAIC_BATTERY, x: 9, y: 3.5, z: 9, rx: 0, ry: 0, rz: 0, scale: 1 }], 3);
    const ps = [];
    const n = modelPoses(BLOCK.COLLAPSAR_CHARGE, ps, 0, -0.5, 0, 0);
    const perBatch = BATCHES.map(() => 0);
    for (let i = 0; i < n; i++) perBatch[ps[i].batch]++;
    for (let b = 0; b < BATCHES.length; b++) expect(mesh(anim(b)).count, BATCHES[b].name).toBe(perBatch[b]); // count 3: not the battery
    // The sphere: its centre is the item's centre plus its offset, turned and scaled by the item.
    const ballIndex = ps.slice(0, n).filter((p) => p.batch === BATCH.BALL).length - 1;
    const sphere = ps.slice(0, n).filter((p) => p.batch === BATCH.BALL)[ballIndex];
    const item = new THREE.Matrix4().compose(new THREE.Vector3(charge.x, charge.y, charge.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(charge.rx, charge.ry, charge.rz, 'YXZ')), new THREE.Vector3(0.5, 0.5, 0.5));
    const want = new THREE.Vector3(sphere.x, sphere.y, sphere.z).applyMatrix4(item);
    const m = new THREE.Matrix4();
    mesh(anim(BATCH.BALL)).getMatrixAt(ballIndex, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).distanceTo(want)).toBeLessThan(1e-5);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(sphere.sx * 0.5, 5);
    // The overlays and the moving copies share the animated meshes, whichever comes first in a frame.
    cr.syncOverlays([ITEM('cap')], 0, 0);
    expect(mesh(anim(BATCH.BALL)).count).toBe(perBatch[BATCH.BALL] + 1);
    cr.syncMoving([], 0);
    expect(mesh(anim(BATCH.BALL)).count).toBe(1);
    cr.syncMoving(null);
    cr.syncOverlays(null, 0, 0);
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
    // Every material is among them (so every program is compiled now).
    const mats = new Set(meshes().map((m) => m.material));
    expect(mats.size).toBe(4);
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
    const cap = mesh(anim(BATCH.CYL));
    expect(cap.count).toBe(1);
    cap.onAfterRender();
    expect(cap.count).toBe(1);
    expect(cap.visible).toBe(true);
  });

  it('dispose removes the group and frees its geometries and materials', () => {
    const { cr, scene, mesh } = setup();
    const spies = [anim(BATCH.GLOW), stat(BATCH.BELL)].map((name) => {
      const spy = vi.fn();
      mesh(name).material.addEventListener('dispose', spy);
      mesh(name).geometry.addEventListener('dispose', spy);
      return spy;
    });
    cr.dispose();
    expect(scene.getObjectByName('circuits')).toBeUndefined();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(2);
  });
});
