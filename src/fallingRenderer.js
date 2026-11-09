// Caelancraft — moving cells (falling sand, tumbling debris, lit barrels, toppling logs) and the explosion light
// (three). See src/CONTRACTS.md §34.4.
//
// One InstancedMesh per (block id, render layer), built from mesher.buildCellMesh(id) — the exact geometry a chunk
// would give that cell, centred on the origin — with chunk-style Lambert materials on the shared atlas texture, so a
// falling block looks exactly like the block it was. Capacity starts small and doubles (the instances already written
// this frame are copied into the bigger mesh). `frustumCulled = false`: an InstancedMesh's bounding sphere is computed
// once from its first instances and would go stale as they move.
// The explosion PointLight is created once (a constant light count: changing it would recompile every material). It is
// shared by every flash: a keg's blast in its warm 0xffd49a and a collapsar's FLASH in warm white (setFlash's colour,
// DESIGN-circuits §6.2.12; main passes the brighter of the two).
// prewarm() compiles the three layers' programs while the game loads (like campfireRenderer), so the first falling
// block of a session does not compile a shader mid-frame.
import * as THREE from 'three';
import { BLOCK } from './blocks.js';
import { buildCellMesh } from './mesher.js';

/** @typedef {import('./blockphysics.js').RenderItem} RenderItem */
/** @typedef {import('./types.js').MeshData} MeshData */

const INITIAL_CAPACITY = 16;
/** The blast flash's colour: setFlash's default. */
export const FLASH_COLOR = 0xffd49a;
const FLASH_DISTANCE = 28;
const FLASH_DECAY = 1.4;
const LAYER_NAMES = /** @type {const} */ (['opaque', 'cutout', 'translucent']);
const LAYER_RENDER_ORDER = [0, 0, 1];
/** One block per render layer (opaque, cutout, translucent): prewarm builds their meshes and compiles the programs. */
export const PREWARM_IDS = Object.freeze([BLOCK.SAND, BLOCK.GLASS, BLOCK.ICE]);
/** prewarm's hidden instance: a micro-scaled speck far below the world (clipped; still a real draw call). */
const WARM_MATRIX = new THREE.Matrix4().makeTranslation(0, -1e4, 0).multiply(new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6));

/**
 * @typedef {Object} FallingRenderer
 * @property {(items: RenderItem[], count?: number) => void} sync   draw exactly items[0 .. count)
 * @property {(x: number, y: number, z: number, intensity: number, color?: number) => void} setFlash   the shared flash
 *   light (0 = off); `color` 0xrrggbb (sRGB), default the blast's 0xffd49a, set on the light only when it changes
 * @property {() => number} count       instances drawn by the last sync
 * @property {() => number} meshCount   InstancedMeshes created so far
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile every falling-block program now
 * @property {() => void} dispose
 */

/** @returns {THREE.BufferGeometry} geometry of one mesher layer (arrays copied: the mesher's buffers are growable) */
function layerGeometry(layer) {
  const vc = layer.vertexCount;
  const ic = layer.indexCount;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(layer.positions.slice(0, vc * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(layer.normals.slice(0, vc * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(layer.uvs.slice(0, vc * 2), 2));
  g.setAttribute('color', new THREE.BufferAttribute(layer.colors.slice(0, vc * 3), 3));
  g.setIndex(new THREE.BufferAttribute(layer.indices.slice(0, ic), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * @param {THREE.Scene} scene
 * @param {THREE.Texture} atlasTexture  the chunk atlas (atlas.createAtlasTexture); shared, never disposed here
 * @returns {FallingRenderer}
 */
export function createFallingRenderer(scene, atlasTexture) {
  const materials = [
    new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true }),
    new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }),
    new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  ];

  /**
   * Per block id: its layers (geometry + current InstancedMesh + capacity) and this frame's instance count.
   * @type {Map<number, { layers: { geometry: THREE.BufferGeometry, layer: number, mesh: THREE.InstancedMesh, capacity: number }[], n: number }>}
   */
  const entries = new Map();
  /** Meshes that still owe their hidden warm-up draw (see prewarm). */
  const warming = new Set();
  let meshes = 0;
  let drawn = 0;

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const scl = new THREE.Vector3(1, 1, 1);

  const light = new THREE.PointLight(FLASH_COLOR, 0, FLASH_DISTANCE, FLASH_DECAY);
  light.name = 'explosion-flash';
  scene.add(light);
  /** the light's colour as last set (0xrrggbb): it is changed only when setFlash asks for another */
  let lightColor = FLASH_COLOR;

  function makeMesh(geometry, layer, capacity, id) {
    const mesh = new THREE.InstancedMesh(geometry, materials[layer], capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER_RENDER_ORDER[layer];
    mesh.count = 0;
    mesh.name = `falling:${id}:${LAYER_NAMES[layer]}`;
    // After its warm-up draw a mesh goes back to drawing nothing (unless sync has given its id blocks meanwhile).
    mesh.onAfterRender = () => {
      if (!warming.delete(mesh)) return;
      const e = entries.get(id);
      if (!e || e.n === 0) {
        mesh.count = 0;
        mesh.visible = false;
      }
    };
    scene.add(mesh);
    meshes++;
    return mesh;
  }

  function entryFor(id) {
    let e = entries.get(id);
    if (e) return e;
    const data = buildCellMesh(id);
    e = { layers: [], n: 0 };
    for (let layer = 0; layer < 3; layer++) {
      /** @type {MeshData|null} */
      const l = data[LAYER_NAMES[layer]];
      if (!l || !(l.vertexCount > 0) || !(l.indexCount > 0)) continue;
      const geometry = layerGeometry(l);
      e.layers.push({ geometry, layer, mesh: makeMesh(geometry, layer, INITIAL_CAPACITY, id), capacity: INITIAL_CAPACITY });
    }
    entries.set(id, e);
    return e;
  }

  /**
   * Double a layer's capacity until it holds `need` instances: a new InstancedMesh on the same geometry. sync has
   * already written instances 0 … need − 2 into the old mesh this frame and does not write them again, so they are
   * copied over — a new InstancedMesh starts with identity matrices, which would draw them at the world origin (a
   * one-frame blink of every block of that id).
   */
  function grow(e, id, need) {
    for (const l of e.layers) {
      if (l.capacity >= need) continue;
      let cap = l.capacity;
      while (cap < need) cap *= 2;
      const old = l.mesh;
      l.mesh = makeMesh(l.geometry, l.layer, cap, id);
      l.mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      l.capacity = cap;
      warming.delete(old);
      scene.remove(old);
      old.dispose();
    }
  }

  /**
   * Pay the falling-block shader costs while the game loads, not on the frame the first block falls (as
   * campfireRenderer.prewarm, CONTRACTS §32.2):
   * 1. build the meshes of PREWARM_IDS (one per render layer: the three materials' InstancedMesh programs) and compile
   *    them now with the scene's lights and fog (compileAsync — KHR_parallel_shader_compile — when the renderer has it);
   * 2. have each draw ONE hidden instance (a speck far below the world) in the next rendered frame — the first frame
   *    after loading — because some drivers (ANGLE on D3D11) only finish a program on its first draw. sync keeps that
   *    instance (`sync([], 0)` on load included) until the mesh has been drawn once or its id has blocks of its own.
   * Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets step 2)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    /** @type {THREE.InstancedMesh[]} */
    const warm = [];
    for (const id of PREWARM_IDS) {
      const e = entryFor(id);
      for (const l of e.layers) {
        warm.push(l.mesh);
        if (e.n > 0) continue; // already drawing blocks
        l.mesh.setMatrixAt(0, WARM_MATRIX);
        l.mesh.instanceMatrix.needsUpdate = true;
        l.mesh.count = 1;
        l.mesh.visible = true;
        warming.add(l.mesh);
      }
    }
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.all(warm.map((m) => webgl.compileAsync(m, camera, scene))).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') for (const m of warm) webgl.compile(m, camera, scene);
    } catch {
      // A failed compile only brings back the one-off compile on first use.
    }
    return Promise.resolve();
  }

  return {
    sync(items, count = items.length) {
      for (const e of entries.values()) e.n = 0;
      drawn = 0;
      for (let i = 0; i < count; i++) {
        const it = items[i];
        const e = entryFor(it.id);
        if (e.layers.length === 0) continue;
        const n = e.n++;
        if (n >= e.layers[0].capacity) grow(e, it.id, n + 1);
        pos.set(it.x, it.y, it.z);
        euler.set(it.rx || 0, it.ry || 0, it.rz || 0, 'YXZ');
        quat.setFromEuler(euler);
        const s = it.scale > 0 ? it.scale : 1;
        scl.set(s, s, s);
        m4.compose(pos, quat, scl);
        for (const l of e.layers) l.mesh.setMatrixAt(n, m4);
        drawn++;
      }
      for (const e of entries.values()) {
        for (const l of e.layers) {
          if (warming.has(l.mesh)) {
            if (e.n === 0) continue; // still owes its hidden warm-up draw (prewarm): instance 0 is WARM_MATRIX
            warming.delete(l.mesh); // blocks of its own: their first draw is the warm-up
          }
          if (l.mesh.count !== e.n) l.mesh.count = e.n;
          l.mesh.visible = e.n > 0;
          if (e.n > 0) l.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },

    setFlash(x, y, z, intensity, color = FLASH_COLOR) {
      const v = Number.isFinite(intensity) && intensity > 0 ? intensity : 0;
      light.intensity = v;
      if (v > 0 && Number.isFinite(x + y + z)) light.position.set(x, y, z);
      const c = Number.isInteger(color) && color >= 0 && color <= 0xffffff ? color : FLASH_COLOR;
      if (v > 0 && c !== lightColor) {
        lightColor = c;
        light.color.setHex(c);
      }
    },

    count: () => drawn,
    meshCount: () => meshes,
    prewarm,

    dispose() {
      warming.clear();
      for (const e of entries.values()) {
        for (const l of e.layers) {
          scene.remove(l.mesh);
          l.mesh.dispose();
          l.geometry.dispose();
        }
      }
      entries.clear();
      for (const m of materials) m.dispose();
      scene.remove(light);
      light.dispose();
    },
  };
}
