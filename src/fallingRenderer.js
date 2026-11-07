// Caelancraft — moving cells (falling sand, tumbling debris, lit barrels, toppling logs) and the explosion light
// (three). See src/CONTRACTS.md §34.4.
//
// One InstancedMesh per (block id, render layer), built from mesher.buildCellMesh(id) — the exact geometry a chunk
// would give that cell, centred on the origin — with chunk-style Lambert materials on the shared atlas texture, so a
// falling block looks exactly like the block it was. Capacity starts small and doubles. `frustumCulled = false`: an
// InstancedMesh's bounding sphere is computed once from its first instances and would go stale as they move.
// The explosion PointLight is created once (a constant light count: changing it would recompile every material).
import * as THREE from 'three';
import { buildCellMesh } from './mesher.js';

/** @typedef {import('./blockphysics.js').RenderItem} RenderItem */
/** @typedef {import('./types.js').MeshData} MeshData */

const INITIAL_CAPACITY = 16;
const FLASH_COLOR = 0xffd49a;
const FLASH_DISTANCE = 28;
const FLASH_DECAY = 1.4;
const LAYER_NAMES = /** @type {const} */ (['opaque', 'cutout', 'translucent']);
const LAYER_RENDER_ORDER = [0, 0, 1];

/**
 * @typedef {Object} FallingRenderer
 * @property {(items: RenderItem[], count?: number) => void} sync   draw exactly items[0 .. count)
 * @property {(x: number, y: number, z: number, intensity: number) => void} setFlash   explosion light (0 = off)
 * @property {() => number} count       instances drawn by the last sync
 * @property {() => number} meshCount   InstancedMeshes created so far
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

  function makeMesh(geometry, layer, capacity, id) {
    const mesh = new THREE.InstancedMesh(geometry, materials[layer], capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER_RENDER_ORDER[layer];
    mesh.count = 0;
    mesh.name = `falling:${id}:${LAYER_NAMES[layer]}`;
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

  /** Double a layer's capacity (new InstancedMesh on the same geometry; existing matrices are rewritten this frame). */
  function grow(e, id, need) {
    for (const l of e.layers) {
      if (l.capacity >= need) continue;
      let cap = l.capacity;
      while (cap < need) cap *= 2;
      scene.remove(l.mesh);
      l.mesh.dispose();
      l.mesh = makeMesh(l.geometry, l.layer, cap, id);
      l.capacity = cap;
    }
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
          if (l.mesh.count !== e.n) l.mesh.count = e.n;
          l.mesh.visible = e.n > 0;
          if (e.n > 0) l.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },

    setFlash(x, y, z, intensity) {
      const v = Number.isFinite(intensity) && intensity > 0 ? intensity : 0;
      light.intensity = v;
      if (v > 0 && Number.isFinite(x + y + z)) light.position.set(x, y, z);
    },

    count: () => drawn,
    meshCount: () => meshes,

    dispose() {
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
