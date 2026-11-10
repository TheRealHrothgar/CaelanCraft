// Caelancraft — draws the circuits (three): the static knob-and-tube wiring, earth cords and powder fuses, every device's
// little 3D model (all from circuitGeometry.wireSegments), every moving or lit bit (circuitGeometry.overlayPose) and, when
// main passes them, moving copies of device blocks (a collapsar charge swelling in its flash, tumbling debris).
// docs/DESIGN-circuits.md §4.11, §6.2.8 (CONTRACTS §53 once merged).
//
// One InstancedMesh per circuitGeometry.BATCHES entry (a unit shape in a material) for the static geometry, and one per
// batch for everything that moves, so at most 17 draw calls however many parts are in view (a mesh with nothing to draw
// is hidden and costs none):
//   - static: box (wire, cord and fuse segments, device boxes), hex (knobs, tubes, posts, studs, clamps), cyl, ball, bell,
//     glass, lit, lit-box — rebuilt by setGeometry only;
//   - animated ("-anim"): the same nine batches plus the glow — rewritten every syncOverlays / syncMoving.
// The solid batches use MeshLambertMaterial with instance colours, so they are lit like the world (at night a wire is
// dark, as it should be); the glass is clear (GLASS_ALPHA); `lit` is unlit (hot filaments, the collapsar's seam: they shine
// in the dark); the glows are additive camera-facing quads (a radial glow, or a flickering tongue of flame for the torch)
// that never light anything. **This renderer never adds a light**: lamps do not light their surroundings in v1, and the
// number of lights is part of every shader's key (CONTRACTS pitfall 36).
//
// Every mesh sets frustumCulled = false (instances move about; a cached bounding sphere goes stale) and grows by doubling
// when it needs more instances than it holds (the replacement keeps its geometry and material, so no program is
// recompiled). Instances are first written into per-mesh scratch arrays and copied into the mesh in one go, so growing never
// loses what a frame already wrote, and nothing is allocated per frame once the arrays are big enough.
// prewarm() compiles every program while the game loads and makes each mesh draw one hidden speck in the first frame (some
// drivers only finish a program on its first draw), exactly like campfireRenderer.
//
// The knife switch's lever eases between open and closed over BLADE_EASE_S, per cell, so the engine can send 0 / 1. A
// relay's or timer's moving bits are turned with its model: setGeometry keeps the input face of each from wireSegments'
// turn records and passes it to overlayPose.
import * as THREE from 'three';
import {
  SEGMENT_STRIDE, KNOB_STRIDE, BODY_STRIDE, TURN_STRIDE, KNOB_KIND, SEGMENT_COLOURS, KNOB_GROOVE_COLOUR, KNOB_W, TUBE_W,
  POST_W, CLAMP_W, COLOUR, BLADE_EASE_S, GLASS_ALPHA, BATCHES, BATCH, BELL_PROFILE, overlayPose, modelPoses, hasModel,
} from './circuitGeometry.js';

/** @typedef {import('./types.js').OverlayItem} OverlayItem */
/** @typedef {import('./circuitGeometry.js').WireGeometry} WireGeometry */
/** @typedef {import('./circuitGeometry.js').Pose} Pose */
/** @typedef {{ id: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number, scale?: number }} MovingItem */

/**
 * @typedef {Object} CircuitRenderer
 * @property {(geo: WireGeometry|null) => void} setGeometry        the static wiring and device models (null clears them)
 * @property {(items: ArrayLike<OverlayItem>|null, t: number, dt: number) => void} syncOverlays  this frame's overlays
 * @property {(items: ArrayLike<MovingItem>|null, count?: number) => void} syncMoving  moving copies of blocks (the falling
 *   renderer's items: the ones that are devices are drawn as their models; everything else is ignored)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every program now
 * @property {() => number} count                                  instances drawn, over all meshes
 * @property {() => void} dispose
 */

/** The overlay item types it draws (circuits.overlays' `type`). */
export const OVERLAY_TYPES = Object.freeze(['blade', 'cap', 'hand', 'arm', 'plunger', 'hammer', 'bulb', 'glow', 'staff']);
/** Starting capacity of every mesh (instances); it doubles as needed. */
export const INITIAL_CAPACITY = 64;
/** The batches drawn by the static meshes (every batch but the glow). */
export const STATIC_BATCHES = Object.freeze(BATCHES.map((b, i) => i).filter((i) => i !== BATCH.GLOW));
/** The mesh names: `circuit-<batch>` for the static meshes and `circuit-<batch>-anim` for the animated ones. */
export const MESH_NAMES = Object.freeze([
  ...STATIC_BATCHES.map((i) => `circuit-${BATCHES[i].name}`),
  ...BATCHES.map((b) => `circuit-${b.name}-anim`),
]);

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

/** @returns {THREE.BufferGeometry} the unit bell (BELL_PROFILE), centred like the other unit shapes */
function bellGeometry() {
  const g = new THREE.LatheGeometry(BELL_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 20);
  // The lathe leaves the two poles' normals unset; point them straight up (the crown) and down (inside the dome).
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    if (Math.hypot(p.getX(i), p.getZ(i)) < 1e-6) n.setXYZ(i, 0, p.getY(i) > 0.9 ? 1 : -1, 0);
  }
  g.translate(0, -0.5, 0);
  return g;
}

/**
 * @param {THREE.Scene} scene
 * @returns {CircuitRenderer}
 */
export function createCircuitRenderer(scene) {
  const root = new THREE.Group();
  root.name = 'circuits';
  scene.add(root);

  /** @type {Record<string, THREE.BufferGeometry>} the unit shapes */
  const shapes = {
    box: new THREE.BoxGeometry(1, 1, 1),
    // A unit hex prism, corners along ±z like the cells (three's cylinder puts its first vertex on +z).
    hex: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 18),
    ball: new THREE.SphereGeometry(0.5, 18, 12),
    bell: bellGeometry(),
    quad: new THREE.PlaneGeometry(1, 1),
  };
  /** @type {Record<string, THREE.Material>} */
  const mats = {
    solid: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    glass: new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: GLASS_ALPHA, depthWrite: false }),
    lit: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    glow: new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }),
  };
  const ORDER = { solid: 0, lit: 0, glass: 3, glow: 4 };

  /** Parts that still owe their warm-up draw (see prewarm). */
  const warming = new Set();
  const white = new THREE.Color(1, 1, 1);

  /**
   * A growable InstancedMesh fed from scratch buffers: `mesh` is replaced (same geometry and material) when it needs more
   * than `capacity`; its instances are the concatenation of `bufs` (the static part has one, an animated part two: the
   * overlays and the moving copies).
   * @typedef {{ mats: Float32Array, cols: Float32Array, n: number }} Buf
   * @typedef {{ name: string, geo: THREE.BufferGeometry, mat: THREE.Material, order: number, capacity: number,
   *   mesh: THREE.InstancedMesh, n: number, bufs: Buf[] }} Part
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
  /** @returns {Buf} */
  function makeBuf() {
    return { mats: new Float32Array(16 * 16), cols: new Float32Array(16 * 3), n: 0 };
  }
  /** @returns {Part} */
  function makePart(name, batch, bufs) {
    const b = BATCHES[batch];
    const part = /** @type {Part} */ ({
      name, geo: shapes[b.shape], mat: mats[b.mat], order: ORDER[b.mat], capacity: INITIAL_CAPACITY, mesh: null, n: 0,
      bufs: Array.from({ length: bufs }, makeBuf),
    });
    part.mesh = makeMesh(part, INITIAL_CAPACITY);
    root.add(part.mesh);
    return part;
  }

  /** @type {(Part|null)[]} the static part of each batch (none for the glow) */
  const statics = BATCHES.map((b, i) => (STATIC_BATCHES.includes(i) ? makePart(`circuit-${b.name}`, i, 1) : null));
  /** @type {Part[]} the animated part of each batch: bufs[0] the overlays, bufs[1] the moving copies */
  const anims = BATCHES.map((b, i) => makePart(`circuit-${b.name}-anim`, i, 2));
  const parts = [.../** @type {Part[]} */ (statics.filter(Boolean)), ...anims];

  // ---- scratch ------------------------------------------------------------------------------------------------
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const mat4 = new THREE.Matrix4();
  const itemMat = new THREE.Matrix4();
  const dir = new THREE.Vector3();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const colour = new THREE.Color();
  const noTurn = new THREE.Quaternion();
  const segColours = SEGMENT_COLOURS.map((h) => new THREE.Color(h));
  const grooveColour = new THREE.Color(KNOB_GROOVE_COLOUR);

  /** Append the instance (matrix m, colour c) to buffer b, growing it by doubling. */
  function push(b, m, c) {
    const i = b.n;
    if ((i + 1) * 16 > b.mats.length) {
      const mm = new Float32Array(b.mats.length * 2);
      mm.set(b.mats);
      b.mats = mm;
      const cc = new Float32Array(b.cols.length * 2);
      cc.set(b.cols);
      b.cols = cc;
    }
    m.toArray(b.mats, i * 16);
    b.cols[i * 3] = c.r;
    b.cols[i * 3 + 1] = c.g;
    b.cols[i * 3 + 2] = c.b;
    b.n = i + 1;
  }
  /** Append the instance at (x, y, z), turned by q, scaled by (sx, sy, sz), in colour c. */
  function put(b, x, y, z, q, sx, sy, sz, c) {
    pos.set(x, y, z);
    scl.set(sx, sy, sz);
    mat4.compose(pos, q, scl);
    push(b, mat4, c);
  }
  /** Make room for `n` instances (doubling); the old mesh is dropped (commit rewrites every instance). */
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
  /** Copy the part's buffers into its mesh and show them. */
  function commit(part) {
    let n = 0;
    for (const b of part.bufs) n += b.n;
    ensure(part, n);
    const m = part.mesh;
    part.n = n;
    if (warming.has(part) && n === 0) return; // still owes its hidden warm-up draw
    if (n > 0) {
      const ma = m.instanceMatrix.array;
      const ca = /** @type {THREE.InstancedBufferAttribute} */ (m.instanceColor).array;
      let at = 0;
      for (const b of part.bufs) {
        if (b.n === 0) continue;
        ma.set(b.mats.subarray(0, b.n * 16), at * 16);
        ca.set(b.cols.subarray(0, b.n * 3), at * 3);
        at += b.n;
      }
      m.instanceMatrix.needsUpdate = true;
      /** @type {THREE.InstancedBufferAttribute} */ (m.instanceColor).needsUpdate = true;
    }
    m.count = n;
    m.visible = n > 0;
  }

  /** Append a pose (circuitGeometry's Pose) to buffer b; glows are additive, so their alpha scales their colour. */
  function putPose(b, p, glow) {
    if (glow) {
      colour.setHex(p.colour).multiplyScalar(p.alpha);
      quat.identity();
    } else {
      colour.setHex(p.colour);
      euler.set(p.rx, p.ry, p.rz, 'YXZ');
      quat.setFromEuler(euler);
    }
    put(b, p.x, p.y, p.z, quat, p.sx, p.sy, p.sz, colour);
  }

  // ---- static wiring and models -------------------------------------------------------------------------------
  /** The input face of each relay, timer and coherer in the static geometry: cell key → face. */
  const faces = new Map();

  /** @returns {number} a numeric key of the cell (coords.packCell's formula) */
  function cellKey(q, y, r) {
    return ((q + 1048576) * 2097152 + (r + 1048576)) * 128 + y;
  }

  /** @param {WireGeometry|null} geo */
  function setGeometry(geo) {
    for (const p of statics) if (p) p.bufs[0].n = 0;
    faces.clear();
    const sb = /** @type {Part} */ (statics[BATCH.BOX]).bufs[0];
    const nSeg = geo && geo.seg ? Math.max(0, geo.seg.count | 0) : 0;
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
      put(sb, (d[o] + d[o + 3]) / 2, (d[o + 1] + d[o + 4]) / 2, (d[o + 2] + d[o + 5]) / 2, quat, len, w, w, c);
    }

    const kb = /** @type {Part} */ (statics[BATCH.HEX]).bufs[0];
    const nKnob = geo && geo.knob ? Math.max(0, geo.knob.count | 0) : 0;
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
        put(kb, x, y + 0.0375 * u, z, noTurn, KNOB_W, 0.075 * u, KNOB_W, segColours[COLOUR.PORCELAIN]);
        put(kb, x, y + 0.09 * u, z, noTurn, KNOB_W * 0.72, 0.03 * u, KNOB_W * 0.72, grooveColour);
        put(kb, x, y + 0.1125 * u, z, noTurn, KNOB_W * 0.92, 0.015 * u, KNOB_W * 0.92, segColours[COLOUR.PORCELAIN]);
      } else if (kind === KNOB_KIND.TUBE) {
        put(kb, x, y + h / 2, z, noTurn, TUBE_W, h, TUBE_W, segColours[COLOUR.PORCELAIN]);
      } else if (kind === KNOB_KIND.POST) {
        put(kb, x, y + h / 2, z, noTurn, POST_W, h, POST_W, segColours[COLOUR.BRASS]);
      } else if (kind === KNOB_KIND.CLAMP) {
        put(kb, x, y + h / 2, z, noTurn, CLAMP_W, h, CLAMP_W, segColours[COLOUR.CLAMP]);
        put(kb, x, y + h + 0.01, z, noTurn, 0.04, 0.02, 0.04, segColours[COLOUR.BRASS]);
      }
    }

    const nBody = geo && geo.body ? Math.max(0, geo.body.count | 0) : 0;
    for (let k = 0; k < nBody; k++) {
      const d = geo.body.data;
      const o = k * BODY_STRIDE;
      const part = statics[d[o + 10] | 0];
      if (!part) continue;
      colour.setHex(d[o + 9]);
      euler.set(d[o + 3], d[o + 4], d[o + 5], 'YXZ');
      quat.setFromEuler(euler);
      put(part.bufs[0], d[o], d[o + 1], d[o + 2], quat, d[o + 6], d[o + 7], d[o + 8], colour);
    }

    const nTurn = geo && geo.turn ? Math.max(0, geo.turn.count | 0) : 0;
    for (let k = 0; k < nTurn; k++) {
      const d = geo.turn.data;
      const o = k * TURN_STRIDE;
      faces.set(cellKey(d[o], d[o + 1], d[o + 2]), d[o + 3]);
    }
    for (const p of statics) if (p) commit(p);
  }

  // ---- overlays -----------------------------------------------------------------------------------------------
  /** @type {Pose[]} */
  const poses = [];
  /** The eased blade of each knife switch: cell → { v, frame }. */
  const blades = new Map();
  let frame = 0;
  const bladeItem = { type: 'blade', q: 0, y: 0, r: 0, a: 0, b: 0 };
  const KNOWN = new Set(OVERLAY_TYPES);

  /**
   * @param {ArrayLike<OverlayItem>|null} items
   * @param {number} t   animation time, seconds
   * @param {number} dt  seconds since the last frame (the blade easing)
   */
  function syncOverlays(items, t, dt) {
    frame++;
    for (const p of anims) p.bufs[0].n = 0;
    const n = items ? items.length : 0;
    const step = Number.isFinite(dt) && dt > 0 ? dt / BLADE_EASE_S : 1;
    for (let k = 0; k < n; k++) {
      let item = items[k];
      if (!item || !KNOWN.has(item.type)) continue;
      const key = cellKey(item.q, item.y, item.r);
      if (item.type === 'blade') {
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
      const np = overlayPose(item, t, poses, faces.get(key));
      for (let i = 0; i < np; i++) {
        const p = poses[i];
        const part = anims[p.batch];
        if (part) putPose(part.bufs[0], p, p.batch === BATCH.GLOW);
      }
    }
    for (const [key, e] of blades) if (e.frame !== frame) blades.delete(key);
    for (const p of anims) commit(p);
  }

  // ---- moving copies ------------------------------------------------------------------------------------------
  /**
   * Draw the device blocks among `items` (fallingRenderer's RenderItems: the cell centre, a YXZ turn and a uniform scale)
   * as their models; the rest are ignored (fallingRenderer draws them). The models replace last call's.
   * @param {ArrayLike<MovingItem>|null} items
   * @param {number} [count]
   */
  function syncMoving(items, count) {
    for (const p of anims) p.bufs[1].n = 0;
    const n = items ? Math.min(items.length, Number.isFinite(count) ? Math.max(0, count) : items.length) : 0;
    for (let k = 0; k < n; k++) {
      const it = items[k];
      if (!it || !hasModel(it.id)) continue;
      pos.set(it.x, it.y, it.z);
      euler.set(it.rx || 0, it.ry || 0, it.rz || 0, 'YXZ');
      quat.setFromEuler(euler);
      const s = it.scale > 0 ? it.scale : 1;
      scl.set(s, s, s);
      itemMat.compose(pos, quat, scl);
      // The model's floor centre sits half a cell below the item's centre.
      const np = modelPoses(it.id, poses, 0, -0.5, 0, 0);
      for (let i = 0; i < np; i++) {
        const p = poses[i];
        const part = anims[p.batch];
        if (!part) continue;
        colour.setHex(p.colour);
        euler.set(p.rx, p.ry, p.rz, 'YXZ');
        quat.setFromEuler(euler);
        pos.set(p.x, p.y, p.z);
        scl.set(p.sx, p.sy, p.sz);
        mat4.compose(pos, quat, scl).premultiply(itemMat);
        push(part.bufs[1], mat4, colour);
      }
    }
    for (const p of anims) commit(p);
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
    for (const g of Object.values(shapes)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    blades.clear();
    faces.clear();
    warming.clear();
  }

  return { setGeometry, syncOverlays, syncMoving, prewarm, count, dispose };
}
