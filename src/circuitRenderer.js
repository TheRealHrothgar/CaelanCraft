// Caelancraft — draws the circuits (three): the static knob-and-tube wiring, earth cords and powder fuses from
// circuitGeometry.wireSegments, and every moving or lit device part from circuitGeometry.overlayPose. docs/DESIGN-circuits.md
// §4.11, §6.2.8 (CONTRACTS §53 once merged).
//
// Eleven InstancedMeshes, so at most 11 draw calls however many parts are in view:
//   - one unit box for every wire, cord and fuse segment (scaled along the segment, square section);
//   - one unit hex prism for the porcelain knobs (body, groove and cap), tubes, brass binding posts and ground clamps;
//   - nine overlay meshes, one per OverlayItem type: blade, cap, hand, arm, plunger, hammer, bulb, glow, staff.
// The solid parts use MeshLambertMaterial with instance colours, so they are lit like the world (at night a wire is dark, as
// it should be); the bulb is clear glass (alpha 0.35); the glows are additive camera-facing quads (a radial glow, or a
// flickering tongue of flame for the torch) that never light anything. **This renderer never adds a light**: lamps do not
// light their surroundings in v1, and the number of lights is part of every shader's key (pitfall 35).
//
// Every mesh sets frustumCulled = false (instances move about; a cached bounding sphere goes stale) and grows by doubling
// when a frame needs more instances than it holds (the replacement keeps its material, so no program is recompiled).
// prewarm() compiles every program while the game loads and makes each mesh draw one hidden speck in the first frame (some
// drivers only finish a program on its first draw), exactly like campfireRenderer.
//
// The knife switch's blade eases between open and closed over BLADE_EASE_S, per cell, so the engine can send 0 / 1.
import * as THREE from 'three';
import {
  SEGMENT_STRIDE, KNOB_STRIDE, KNOB_KIND, SEGMENT_COLOURS, KNOB_GROOVE_COLOUR, KNOB_W, TUBE_W, POST_W, CLAMP_W, COLOUR,
  BLADE_EASE_S, BULB_ALPHA, overlayPose,
} from './circuitGeometry.js';

/** @typedef {import('./types.js').OverlayItem} OverlayItem */
/** @typedef {import('./circuitGeometry.js').WireGeometry} WireGeometry */
/** @typedef {import('./circuitGeometry.js').Pose} Pose */

/**
 * @typedef {Object} CircuitRenderer
 * @property {(geo: WireGeometry|null) => void} setGeometry        the static wiring (null clears it)
 * @property {(items: ArrayLike<OverlayItem>|null, t: number, dt: number) => void} syncOverlays  this frame's overlays
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every program now
 * @property {() => number} count                                  instances drawn, over all eleven meshes
 * @property {() => void} dispose
 */

/** The overlay types, one InstancedMesh each, in draw order. */
export const OVERLAY_TYPES = Object.freeze(['blade', 'cap', 'hand', 'arm', 'plunger', 'hammer', 'bulb', 'glow', 'staff']);
/** Starting capacity of every mesh (instances); it doubles as needed. */
export const INITIAL_CAPACITY = 64;

/** prewarm's hidden instance: a micro-scaled speck far below the world (clipped; still a real draw call). */
const WARM_MATRIX = new THREE.Matrix4().makeTranslation(0, -1e4, 0).multiply(new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6));

const GLOW_VERTEX = `
varying vec2 vUv;
varying vec3 vColor;
varying float vFlame;
void main() {
  vUv = position.xy * 2.0;
#ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
#else
  vColor = vec3(1.0);
#endif
  float sx = length(instanceMatrix[0].xyz);
  float sy = length(instanceMatrix[1].xyz);
  vFlame = sy > 1.2 * sx ? 1.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  mv.xy += position.xy * vec2(sx, sy);
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FRAGMENT = `
varying vec2 vUv;
varying vec3 vColor;
varying float vFlame;
void main() {
  float a;
  vec3 col;
  if (vFlame > 0.5) {
    // A tongue of flame: round at the foot, drawn to a point at the top, with a pale core low down.
    float h = clamp((vUv.y + 0.75) / 1.75, 0.0, 1.0);
    float w = mix(0.9, 0.04, pow(h, 0.8));
    a = (1.0 - smoothstep(w * 0.55, w, abs(vUv.x))) * smoothstep(-1.0, -0.6, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
    float core = (1.0 - smoothstep(0.0, w * 0.5, abs(vUv.x))) * (1.0 - smoothstep(-0.5, 0.25, vUv.y));
    col = vColor * a + vec3(1.0, 0.85, 0.55) * core * a * max(vColor.r, max(vColor.g, vColor.b));
  } else {
    float d = length(vUv);
    a = 1.0 - smoothstep(0.0, 1.0, d);
    a *= a;
    col = vColor * a;
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * @param {THREE.Scene} scene
 * @returns {CircuitRenderer}
 */
export function createCircuitRenderer(scene) {
  const root = new THREE.Group();
  root.name = 'circuits';
  scene.add(root);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  // A unit hex prism, corners along ±z like the cells (three's cylinder puts its first vertex on +z).
  const hexGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const quadGeo = new THREE.PlaneGeometry(1, 1);

  const solid = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
  const segMat = solid();
  const knobMat = solid();
  const glassMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: BULB_ALPHA, depthWrite: false });
  const glowMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  /** @type {THREE.Material[]} */
  const materials = [segMat, knobMat, glassMat, glowMat];
  /** @type {Record<string, { geo: THREE.BufferGeometry, mat: THREE.Material, order: number }>} */
  const overlaySpec = {};
  for (const type of OVERLAY_TYPES) {
    if (type === 'bulb') overlaySpec[type] = { geo: hexGeo, mat: glassMat, order: 3 };
    else if (type === 'glow') overlaySpec[type] = { geo: quadGeo, mat: glowMat, order: 4 };
    else if (type === 'cap') overlaySpec[type] = { geo: hexGeo, mat: solid(), order: 0 };
    else overlaySpec[type] = { geo: boxGeo, mat: solid(), order: 0 };
    if (!materials.includes(overlaySpec[type].mat)) materials.push(overlaySpec[type].mat);
  }

  /** Parts that still owe their warm-up draw (see prewarm). */
  const warming = new Set();

  /**
   * A growable InstancedMesh: `mesh` is replaced (same geometry and material) when a frame needs more than `capacity`.
   * @typedef {{ name: string, geo: THREE.BufferGeometry, mat: THREE.Material, order: number, capacity: number,
   *   mesh: THREE.InstancedMesh, n: number }} Part
   */
  /** @returns {THREE.InstancedMesh} */
  function makeMesh(part, capacity) {
    const m = new THREE.InstancedMesh(part.geo, part.mat, capacity);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, white); // allocates instanceColor, so the program prewarm compiles is the one that draws
    /** @type {THREE.InstancedBufferAttribute} */ (m.instanceColor).setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.renderOrder = part.order;
    m.name = part.name;
    m.onAfterRender = () => {
      if (warming.delete(part) && part.n === 0) {
        m.count = 0;
        m.visible = false;
      }
    };
    return m;
  }
  const white = new THREE.Color(1, 1, 1);
  /** @returns {Part} */
  function makePart(name, geo, mat, order) {
    const part = /** @type {Part} */ ({ name, geo, mat, order, capacity: INITIAL_CAPACITY, mesh: null, n: 0 });
    part.mesh = makeMesh(part, INITIAL_CAPACITY);
    root.add(part.mesh);
    return part;
  }
  /** Make room for `n` instances (doubling); the old mesh is dropped. */
  function ensure(part, n) {
    if (n <= part.capacity) return;
    let cap = part.capacity;
    while (cap < n) cap *= 2;
    root.remove(part.mesh);
    part.mesh.dispose();
    part.capacity = cap;
    part.mesh = makeMesh(part, cap);
    root.add(part.mesh);
  }
  /** Show instances [0, n) of the part. */
  function commit(part, n) {
    part.n = n;
    const m = part.mesh;
    if (warming.has(part) && n === 0) return; // still owes its hidden warm-up draw
    m.count = n;
    m.visible = n > 0;
    if (n > 0) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  const segPart = makePart('circuit-segments', boxGeo, segMat, 0);
  const knobPart = makePart('circuit-knobs', hexGeo, knobMat, 0);
  /** @type {Record<string, Part>} */
  const overlay = {};
  for (const type of OVERLAY_TYPES) {
    const s = overlaySpec[type];
    overlay[type] = makePart(`circuit-${type}`, s.geo, s.mat, s.order);
  }
  const parts = [segPart, knobPart, ...OVERLAY_TYPES.map((t) => overlay[t])];

  // ---- scratch ------------------------------------------------------------------------------------------------
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const mat4 = new THREE.Matrix4();
  const dir = new THREE.Vector3();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const colour = new THREE.Color();
  const noTurn = new THREE.Quaternion();
  const segColours = SEGMENT_COLOURS.map((h) => new THREE.Color(h));
  const grooveColour = new THREE.Color(KNOB_GROOVE_COLOUR);

  /** Write instance i of mesh m. */
  function put(m, i, x, y, z, q, sx, sy, sz, c) {
    pos.set(x, y, z);
    scl.set(sx, sy, sz);
    mat4.compose(pos, q, scl);
    m.setMatrixAt(i, mat4);
    m.setColorAt(i, c);
  }

  // ---- static wiring ------------------------------------------------------------------------------------------
  /** @param {WireGeometry|null} geo */
  function setGeometry(geo) {
    const nSeg = geo && geo.seg ? Math.max(0, geo.seg.count | 0) : 0;
    ensure(segPart, nSeg);
    const sm = segPart.mesh;
    let ns = 0;
    for (let k = 0; k < nSeg; k++) {
      const d = geo.seg.data;
      const o = k * SEGMENT_STRIDE;
      dir.set(d[o + 3] - d[o], d[o + 4] - d[o + 1], d[o + 5] - d[o + 2]);
      const len = dir.length();
      if (!(len > 1e-6)) continue;
      dir.multiplyScalar(1 / len);
      quat.setFromUnitVectors(xAxis, dir);
      const w = d[o + 6];
      const c = segColours[d[o + 7] | 0] ?? segColours[COLOUR.COPPER];
      put(sm, ns++, (d[o] + d[o + 3]) / 2, (d[o + 1] + d[o + 4]) / 2, (d[o + 2] + d[o + 5]) / 2, quat, len, w, w, c);
    }
    commit(segPart, ns);

    const nKnob = geo && geo.knob ? Math.max(0, geo.knob.count | 0) : 0;
    ensure(knobPart, nKnob * 3);
    const km = knobPart.mesh;
    let nk = 0;
    for (let k = 0; k < nKnob; k++) {
      const d = geo.knob.data;
      const o = k * KNOB_STRIDE;
      const x = d[o];
      const y = d[o + 1];
      const z = d[o + 2];
      const kind = d[o + 3];
      const h = d[o + 4];
      if (kind === KNOB_KIND.KNOB) {
        // A porcelain spool: the body, the groove the wire is tied in (WIRE_Y), and a thin cap.
        const u = h / 0.12;
        put(km, nk++, x, y + 0.0375 * u, z, noTurn, KNOB_W, 0.075 * u, KNOB_W, segColours[COLOUR.PORCELAIN]);
        put(km, nk++, x, y + 0.09 * u, z, noTurn, KNOB_W * 0.72, 0.03 * u, KNOB_W * 0.72, grooveColour);
        put(km, nk++, x, y + 0.1125 * u, z, noTurn, KNOB_W * 0.92, 0.015 * u, KNOB_W * 0.92, segColours[COLOUR.PORCELAIN]);
      } else if (kind === KNOB_KIND.TUBE) {
        put(km, nk++, x, y + h / 2, z, noTurn, TUBE_W, h, TUBE_W, segColours[COLOUR.PORCELAIN]);
      } else if (kind === KNOB_KIND.POST) {
        put(km, nk++, x, y + h / 2, z, noTurn, POST_W, h, POST_W, segColours[COLOUR.BRASS]);
      } else if (kind === KNOB_KIND.CLAMP) {
        put(km, nk++, x, y + h / 2, z, noTurn, CLAMP_W, h, CLAMP_W, segColours[COLOUR.CLAMP]);
        put(km, nk++, x, y + h + 0.01, z, noTurn, 0.04, 0.02, 0.04, segColours[COLOUR.BRASS]);
      }
    }
    commit(knobPart, nk);
  }

  // ---- overlays -----------------------------------------------------------------------------------------------
  /** @type {Pose[]} */
  const poses = [];
  /** @type {Record<string, number>} instances written per type this frame */
  const fill = Object.fromEntries(OVERLAY_TYPES.map((t) => [t, 0]));
  /** The eased blade of each knife switch: cell → { v, frame }. */
  const blades = new Map();
  let frame = 0;
  const bladeItem = { type: 'blade', q: 0, y: 0, r: 0, a: 0, b: 0 };

  /** @returns {number} a numeric key of the cell (coords.packCell's formula) */
  function cellKey(q, y, r) {
    return ((q + 1048576) * 2097152 + (r + 1048576)) * 128 + y;
  }

  /**
   * @param {ArrayLike<OverlayItem>|null} items
   * @param {number} t   animation time, seconds
   * @param {number} dt  seconds since the last frame (the blade easing)
   */
  function syncOverlays(items, t, dt) {
    frame++;
    for (const type of OVERLAY_TYPES) fill[type] = 0;
    const n = items ? items.length : 0;
    const step = Number.isFinite(dt) && dt > 0 ? dt / BLADE_EASE_S : 1;
    for (let k = 0; k < n; k++) {
      let item = items[k];
      if (!item || !Object.hasOwn(overlay, item.type)) continue;
      if (item.type === 'blade') {
        const key = cellKey(item.q, item.y, item.r);
        const target = Number.isFinite(item.a) ? Math.min(1, Math.max(0, item.a)) : 0;
        let e = blades.get(key);
        if (!e) {
          e = { v: target, frame };
          blades.set(key, e);
        } else {
          e.v = e.v < target ? Math.min(target, e.v + step) : Math.max(target, e.v - step);
          e.frame = frame;
        }
        bladeItem.q = item.q;
        bladeItem.y = item.y;
        bladeItem.r = item.r;
        bladeItem.a = e.v * e.v * (3 - 2 * e.v); // smoothstep
        item = /** @type {OverlayItem} */ (bladeItem);
      }
      const np = overlayPose(item, t, poses);
      if (np === 0) continue;
      const part = overlay[item.type];
      const at = fill[item.type];
      ensure(part, at + np);
      const m = part.mesh;
      for (let i = 0; i < np; i++) {
        const p = poses[i];
        if (item.type === 'glow') {
          // Additive: the alpha scales the light it adds.
          colour.setHex(p.colour).multiplyScalar(p.alpha);
          quat.identity();
        } else {
          colour.setHex(p.colour);
          euler.set(p.rx, p.ry, p.rz, 'YXZ');
          quat.setFromEuler(euler);
        }
        put(m, at + i, p.x, p.y, p.z, quat, p.sx, p.sy, p.sz, colour);
      }
      fill[item.type] = at + np;
    }
    for (const [key, e] of blades) if (e.frame !== frame) blades.delete(key);
    for (const type of OVERLAY_TYPES) commit(overlay[type], fill[type]);
  }

  /**
   * Pay every circuit shader cost while the game loads (see campfireRenderer.prewarm): compile the programs now, and have
   * each mesh draw ONE hidden speck in the next rendered frame. Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets the hidden draw)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    for (const p of parts) {
      if (p.n > 0) continue;
      p.mesh.setMatrixAt(0, WARM_MATRIX);
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.count = 1;
      p.mesh.visible = true;
      warming.add(p);
    }
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.resolve(webgl.compileAsync(root, camera, scene)).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') webgl.compile(root, camera, scene);
    } catch {
      // A failed compile only brings back the one-off compile on first use.
    }
    return Promise.resolve();
  }

  function count() {
    let n = 0;
    for (const p of parts) n += p.n;
    return n;
  }

  function dispose() {
    scene.remove(root);
    for (const p of parts) p.mesh.dispose();
    for (const g of [boxGeo, hexGeo, quadGeo]) g.dispose();
    for (const m of materials) m.dispose();
    blades.clear();
    warming.clear();
  }

  return { setGeometry, syncOverlays, prewarm, count, dispose };
}
