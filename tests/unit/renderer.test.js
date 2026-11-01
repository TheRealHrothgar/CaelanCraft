// renderer.js regression tests — Node only (Three core objects work without WebGL; the WebGLRenderer is
// injected as a stub via opts.webglRenderer).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildLayerGeometry, createRenderer, fogRangeForRenderDistance, HIGHLIGHT_SIZE } from '../../src/renderer.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { flatWorldGen } from '../helpers/fixtures.js';
import { chunkKey } from '../../src/coords.js';
import { MAX_PIXEL_RATIO, FOG_FAR_CHUNK_MARGIN, RENDER_DISTANCE } from '../../src/config.js';
import { CHUNK_RING_INRADIUS, HEX_SIZE, chunkOrigin, hexToWorld, FACE_TOP } from '../../src/hex.js';

/** One real ChunkMeshData from the mesher (flat stone world, chunk 0,0 with all neighbours present). */
function realLayer() {
  const gen = flatWorldGen(60);
  const chunks = new Map();
  for (let cq = -1; cq <= 1; cq++) {
    for (let cr = -1; cr <= 1; cr++) chunks.set(chunkKey(cq, cr), gen.generateChunk(cq, cr));
  }
  const m = buildChunkMesh(0, 0, (cq, cr) => chunks.get(chunkKey(cq, cr)) ?? null);
  expect(m.opaque).not.toBeNull();
  return m;
}

/** Minimal WebGLRenderer stand-in (no GL). */
function stubWebGLRenderer() {
  return {
    setPixelRatio() {},
    setSize() {},
    render() {},
    dispose() {},
    info: { render: { triangles: 0, calls: 0 }, memory: { geometries: 0 } },
  };
}

/** Canvas stand-in that records event listeners so tests can fire webglcontextrestored. */
function fakeCanvas() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  return {
    width: 640,
    height: 360,
    listeners,
    addEventListener(type, fn) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
  };
}

/** Simulate what WebGLAttributes.createBuffer does after gl.bufferData for every attribute of a geometry. */
function simulateUpload(geometry) {
  for (const name in geometry.attributes) geometry.attributes[name].onUploadCallback();
  geometry.index.onUploadCallback();
}

describe('buildLayerGeometry', () => {
  it('adopts the MeshData arrays without copying and computes the bounding sphere first', () => {
    const layer = realLayer().opaque;
    const g = buildLayerGeometry(layer);
    expect(g.getAttribute('position').array).toBe(layer.positions);
    expect(g.index.array).toBe(layer.indices);
    expect(g.boundingSphere).not.toBeNull();
    expect(g.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('uses indexCount (hex caps are 18 indices, side quads 6), not faceCount × 6', () => {
    const layer = realLayer().opaque;
    expect(layer.indexCount).toBe(layer.indices.length);
    expect(layer.indexCount).not.toBe(layer.faceCount * 6); // a flat world is mostly hexagonal tops
    expect(layer.indexCount % 3).toBe(0);
    const g = buildLayerGeometry(layer);
    expect(g.index.count).toBe(layer.indexCount);
    expect(g.getAttribute('position').count).toBe(layer.vertexCount);
    // Every index addresses an existing vertex.
    for (let i = 0; i < layer.indices.length; i++) expect(layer.indices[i]).toBeLessThan(layer.vertexCount);
  });

  it('falls back to indices.length / positions.length when the counts are absent', () => {
    const layer = realLayer().opaque;
    const bare = { ...layer, vertexCount: 0, indexCount: 0, faceCount: 0 };
    const g = buildLayerGeometry(bare);
    expect(g.index.count).toBe(layer.indices.length);
    expect(g.getAttribute('position').count).toBe(layer.positions.length / 3);
  });

  it('releases every CPU array after the GPU upload while keeping counts intact', () => {
    const layer = realLayer().opaque;
    const g = buildLayerGeometry(layer);
    const vertexCount = layer.vertexCount;
    const indexCount = layer.indexCount;

    simulateUpload(g);

    for (const name of ['position', 'normal', 'uv', 'color']) {
      const attr = g.getAttribute(name);
      expect(attr.array, `${name}.array`).toBeNull();
      expect(attr.count, `${name}.count`).toBe(vertexCount);
    }
    expect(g.index.array).toBeNull();
    expect(g.index.count).toBe(indexCount);
    // The bounding sphere (needed for frustum culling) survives the release.
    expect(g.boundingSphere.radius).toBeGreaterThan(0);
  });
});

describe('fogRangeForRenderDistance', () => {
  it('scales with the inradius of the hexagonal chunk ring (clamped to one ring), near = 55 % of far', () => {
    for (const rd of [1, 2, 3, 7, 16]) {
      const { near, far } = fogRangeForRenderDistance(rd);
      expect(far).toBeCloseTo(Math.max(CHUNK_RING_INRADIUS, (rd + FOG_FAR_CHUNK_MARGIN) * CHUNK_RING_INRADIUS), 10);
      expect(near).toBeCloseTo(far * 0.55, 10);
      expect(near).toBeLessThan(far);
    }
    // The margin is negative on purpose: the mesh disc is keyed by chunk ORIGIN cells, so the nearest unmeshed
    // cell can be as close as (rd − 1) rings; the fog must end before it.
    expect(FOG_FAR_CHUNK_MARGIN).toBeLessThanOrEqual(-1);
    expect(fogRangeForRenderDistance(7).far).toBeLessThan(6 * CHUNK_RING_INRADIUS + 1e-9);
  });
  it('never goes below one ring and treats garbage as the default render distance', () => {
    expect(fogRangeForRenderDistance(0).far).toBeGreaterThanOrEqual(CHUNK_RING_INRADIUS);
    expect(fogRangeForRenderDistance(-5).far).toBe(fogRangeForRenderDistance(1).far);
    expect(fogRangeForRenderDistance(NaN)).toEqual(fogRangeForRenderDistance(RENDER_DISTANCE));
    expect(fogRangeForRenderDistance(Infinity)).toEqual(fogRangeForRenderDistance(RENDER_DISTANCE));
  });
  it('is monotonic in the render distance (flat only while the one-ring clamp applies)', () => {
    let prev = 0;
    for (let rd = 1; rd <= 16; rd++) {
      const { far } = fogRangeForRenderDistance(rd);
      expect(far).toBeGreaterThanOrEqual(prev);
      if ((rd + FOG_FAR_CHUNK_MARGIN) * CHUNK_RING_INRADIUS > CHUNK_RING_INRADIUS) expect(far).toBeGreaterThan(prev);
      prev = far;
    }
  });
});

describe('createRenderer', () => {
  it('positions chunk meshes at hex.chunkOrigin(cq, cr) with a frozen matrix', () => {
    const r = createRenderer(fakeCanvas(), new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    const mesh = realLayer();
    for (const [cq, cr] of [[0, 0], [1, 0], [0, 1], [-3, 2], [5, -7]]) {
      const key = chunkKey(cq, cr);
      r.setChunkMesh(key, cq, cr, mesh);
      const obj = r.three.scene.getObjectByName(`chunk:${key}:opaque`);
      expect(obj, key).toBeDefined();
      const [ox, oz] = chunkOrigin(cq, cr);
      expect(obj.position.x).toBeCloseTo(ox, 6);
      expect(obj.position.y).toBe(0);
      expect(obj.position.z).toBeCloseTo(oz, 6);
      expect(obj.matrixAutoUpdate).toBe(false);
      expect(obj.matrix.elements[12]).toBeCloseTo(ox, 6);
      expect(obj.matrix.elements[14]).toBeCloseTo(oz, 6);
    }
    // Replacing a key removes the old mesh (count stays per key).
    expect(r.getStats().chunkMeshes).toBe(5);
    r.setChunkMesh('0,0', 0, 0, mesh);
    expect(r.getStats().chunkMeshes).toBe(5);
    r.setChunkMesh('0,0', 0, 0, null);
    expect(r.getStats().chunkMeshes).toBe(4);
    r.removeChunkMesh('1,0');
    r.removeChunkMesh('does-not-exist');
    expect(r.getStats().chunkMeshes).toBe(3);
    r.dispose();
  });

  it('draws a hexagonal-prism highlight centred on the targeted cell', () => {
    const r = createRenderer(fakeCanvas(), new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    const hl = r.three.scene.getObjectByName('highlight');
    expect(hl).toBeDefined();
    expect(hl.visible).toBe(false);
    r.setHighlight({ q: 3, y: 64, r: -2, face: FACE_TOP, nx: 0, ny: 1, nz: 0, distance: 1, blockId: 1 });
    expect(hl.visible).toBe(true);
    const [cx, cz] = hexToWorld(3, -2);
    expect(hl.position.x).toBeCloseTo(cx, 10);
    expect(hl.position.y).toBeCloseTo(64.5, 10);
    expect(hl.position.z).toBeCloseTo(cz, 10);
    // Negative coordinates and the "inside a block" hit (face -1) are positioned the same way.
    r.setHighlight({ q: -11, y: 0, r: 7, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, blockId: 1 });
    const [cx2, cz2] = hexToWorld(-11, 7);
    expect(hl.position.x).toBeCloseTo(cx2, 10);
    expect(hl.position.y).toBeCloseTo(0.5, 10);
    expect(hl.position.z).toBeCloseTo(cz2, 10);
    // The wireframe is a hexagonal prism: 18 edges (6 vertical + 2 × 6 rim) = 36 line vertices, corners at
    // HEX_SIZE × HIGHLIGHT_SIZE from the axis and pointy along ±Z like hex.HEX_CORNERS.
    const pos = hl.geometry.getAttribute('position');
    expect(pos.count).toBe(36);
    let maxR = 0;
    let maxAbsX = 0;
    let maxAbsZ = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      maxR = Math.max(maxR, Math.hypot(x, z));
      maxAbsX = Math.max(maxAbsX, Math.abs(x));
      maxAbsZ = Math.max(maxAbsZ, Math.abs(z));
      expect(Math.abs(y)).toBeCloseTo(HIGHLIGHT_SIZE / 2, 5);
    }
    expect(maxR).toBeCloseTo(HEX_SIZE * HIGHLIGHT_SIZE, 5);
    expect(maxAbsZ).toBeCloseTo(HEX_SIZE * HIGHLIGHT_SIZE, 5); // corner on the z axis
    expect(maxAbsX).toBeCloseTo(0.5 * HIGHLIGHT_SIZE, 5); // flat side facing ±x
    r.setHighlight(null);
    expect(hl.visible).toBe(false);
    r.dispose();
  });

  it('draws the sun/moon in the opaque pass with the §6 parameters so terrain overdraws them', () => {
    const r = createRenderer(fakeCanvas(), new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    for (const name of ['sun', 'moon']) {
      const sprite = r.three.scene.getObjectByName(name);
      expect(sprite, name).toBeDefined();
      const mat = sprite.material;
      expect(mat.depthTest, `${name}.depthTest`).toBe(false);
      expect(mat.depthWrite, `${name}.depthWrite`).toBe(false);
      expect(mat.fog, `${name}.fog`).toBe(false);
      expect(sprite.renderOrder, `${name}.renderOrder`).toBe(-1);
      // Opaque pass (rendered before renderOrder-0 chunk meshes, which then overdraw it):
      expect(mat.transparent, `${name}.transparent`).toBe(false);
      expect(mat.alphaTest, `${name}.alphaTest`).toBeGreaterThan(0);
    }
    r.dispose();
  });

  it('drops every chunk mesh and fires onContextRestored after a WebGL context restore', () => {
    const canvas = fakeCanvas();
    const r = createRenderer(canvas, new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    const mesh = realLayer();
    r.setChunkMesh('0,0', 0, 0, mesh);
    r.setChunkMesh('1,0', 1, 0, mesh);
    expect(r.getStats().chunkMeshes).toBe(2);
    // Upload happened, CPU arrays are gone: a re-upload would be impossible.
    for (const key of ['0,0', '1,0']) {
      simulateUpload(r.three.scene.getObjectByName(`chunk:${key}:opaque`).geometry);
    }

    let fired = 0;
    r.onContextRestored = () => fired++;
    canvas.dispatch('webglcontextrestored');

    expect(fired).toBe(1);
    expect(r.getStats().chunkMeshes).toBe(0);
    expect(r.three.scene.getObjectByName('chunk:0,0:opaque')).toBeUndefined();
    // Later meshes are accepted normally again.
    r.setChunkMesh('0,0', 0, 0, mesh);
    expect(r.getStats().chunkMeshes).toBe(1);

    r.dispose();
    expect(canvas.listeners.get('webglcontextrestored').size).toBe(0);
  });

  it('resize() re-reads devicePixelRatio (capped at MAX_PIXEL_RATIO) before setSize', () => {
    // Regression: dragging the window between monitors with different scale factors (or changing browser
    // zoom) fires 'resize' with a new devicePixelRatio; the drawing buffer must follow it, not the
    // construction-time value. setPixelRatio must precede setSize because Three re-applies the OLD size.
    const calls = [];
    const gl = stubWebGLRenderer();
    gl.setPixelRatio = (r) => calls.push(['setPixelRatio', r]);
    gl.setSize = (w, h, style) => calls.push(['setSize', w, h, style]);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
    try {
      globalThis.devicePixelRatio = 1.5;
      const r = createRenderer(fakeCanvas(), new THREE.Texture(), { webglRenderer: gl });
      expect(calls[0]).toEqual(['setPixelRatio', 1.5]);

      calls.length = 0;
      globalThis.devicePixelRatio = 1; // moved to the 1x monitor
      r.resize(800, 600);
      expect(calls).toEqual([
        ['setPixelRatio', 1],
        ['setSize', 800, 600, false],
      ]);
      expect(r.three.camera.aspect).toBeCloseTo(800 / 600);

      calls.length = 0;
      globalThis.devicePixelRatio = 3; // 300% zoom: capped by MAX_PIXEL_RATIO = 2
      r.resize(400, 300);
      expect(calls[0]).toEqual(['setPixelRatio', MAX_PIXEL_RATIO]);

      calls.length = 0;
      delete globalThis.devicePixelRatio; // Node: no global -> 1
      r.resize(400, 300);
      expect(calls[0]).toEqual(['setPixelRatio', 1]);
      r.dispose();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'devicePixelRatio', saved);
      else delete globalThis.devicePixelRatio;
    }
  });

  it('works with a canvas that has no addEventListener (test stubs)', () => {
    const r = createRenderer({ width: 320, height: 200 }, new THREE.Texture(), {
      webglRenderer: stubWebGLRenderer(),
    });
    r.setChunkMesh('0,0', 0, 0, realLayer());
    expect(r.getStats().chunkMeshes).toBe(1);
    r.dispose();
  });
});
