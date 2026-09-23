// renderer.js regression tests — Node only (Three core objects work without WebGL; the WebGLRenderer is
// injected as a stub via opts.webglRenderer).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildLayerGeometry, createRenderer } from '../../src/renderer.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { flatWorldGen } from '../helpers/fixtures.js';
import { chunkKey } from '../../src/coords.js';
import { MAX_PIXEL_RATIO } from '../../src/config.js';

/** One real MeshData layer from the mesher (flat stone world, chunk 0,0 with all neighbours present). */
function realLayer() {
  const gen = flatWorldGen(60);
  const chunks = new Map();
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) chunks.set(chunkKey(cx, cz), gen.generateChunk(cx, cz));
  }
  const m = buildChunkMesh(0, 0, (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null);
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

  it('releases every CPU array after the GPU upload while keeping counts intact', () => {
    const layer = realLayer().opaque;
    const g = buildLayerGeometry(layer);
    const vertexCount = layer.vertexCount;
    const indexCount = layer.faceCount * 6;

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

describe('createRenderer', () => {
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
