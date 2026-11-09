// renderer.js regression tests — Node only (Three core objects work without WebGL; the WebGLRenderer is
// injected as a stub via opts.webglRenderer).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildLayerGeometry, createRenderer, fogRangeForRenderDistance, HIGHLIGHT_SIZE,
  DIG_TRACE_COLOR, DIG_TRACE_RENDER_ORDER, DIG_TRACE_SEGMENTS, DIG_TRACE_CORNER_ORDER, digTraceVertexCount, digTracePositions,
} from '../../src/renderer.js';
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

// ---------------------------------------------------------------------------------------------------------------
// The Survival dig trace (docs/DESIGN-survival.md §9.9): the cell's hex outline traced in honey as you dig.
// ---------------------------------------------------------------------------------------------------------------

/** The vertices of a LineSegments geometry as [x, y, z] triples (y shifted by `dy`). */
function lineVertices(geometry, dy = 0) {
  const pos = geometry.getAttribute('position');
  const out = [];
  for (let i = 0; i < pos.count; i++) out.push([pos.getX(i), pos.getY(i) + dy, pos.getZ(i)]);
  return out;
}

/** An order-free key for the segment a–b (rounded so Float32 noise does not matter). */
function segmentKey(a, b) {
  const k = (v) => v.map((c) => (Math.abs(c) < 5e-5 ? 0 : c).toFixed(4)).join(',');
  return [k(a), k(b)].sort().join('|');
}

describe('dig trace: pure helpers', () => {
  it('digTraceVertexCount is 2·ceil(12·p) for p in 0..1 — even, monotonic, 0 at 0 and 24 at 1', () => {
    expect(DIG_TRACE_SEGMENTS).toBe(12);
    let prev = 0;
    for (let i = 0; i <= 2400; i++) {
      const p = i / 2400;
      const n = digTraceVertexCount(p);
      if (n !== 2 * Math.ceil(12 * p)) expect(n, `p = ${p}`).toBe(2 * Math.ceil(12 * p));
      if (n % 2 !== 0 || n < prev) expect.fail(`p = ${p}: ${n} after ${prev}`);
      prev = n;
    }
    expect(digTraceVertexCount(0)).toBe(0);
    expect(digTraceVertexCount(1e-9)).toBe(2); // the first stroke appears at once
    expect(digTraceVertexCount(1 / 12)).toBe(2);
    expect(digTraceVertexCount(1 / 12 + 1e-6)).toBe(4);
    expect(digTraceVertexCount(0.5)).toBe(12);
    expect(digTraceVertexCount(1 - 1e-9)).toBe(24);
    expect(digTraceVertexCount(1)).toBe(24);
  });

  it('digTraceVertexCount clamps p and draws nothing for garbage', () => {
    expect(digTraceVertexCount(1.5)).toBe(24);
    expect(digTraceVertexCount(1e9)).toBe(24);
    expect(digTraceVertexCount(-0.2)).toBe(0);
    expect(digTraceVertexCount(-0)).toBe(0);
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5', {}, [0.5], true]) {
      expect(digTraceVertexCount(/** @type {*} */ (bad)), String(bad)).toBe(0);
    }
  });

  it('digTracePositions are the highlight prism\'s 6 vertical and 6 top edges, each exactly once', () => {
    const verts = [];
    const pos = digTracePositions();
    expect(pos).toBeInstanceOf(Float32Array);
    expect(pos.length).toBe(DIG_TRACE_SEGMENTS * 2 * 3);
    for (let i = 0; i < pos.length; i += 3) verts.push([pos[i], pos[i + 1], pos[i + 2]]);
    // The highlight's 18 edges, in the trace's frame (the trace sits at the cell's y, the highlight at y + 0.5).
    const r = createRenderer(fakeCanvas(), new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    const hl = lineVertices(r.three.scene.getObjectByName('highlight').geometry, 0.5);
    r.dispose();
    const highlightEdges = new Set();
    for (let i = 0; i < hl.length; i += 2) highlightEdges.add(segmentKey(hl[i], hl[i + 1]));
    expect(highlightEdges.size).toBe(18);
    const bottom = 0.5 - HIGHLIGHT_SIZE / 2;
    const top = 0.5 + HIGHLIGHT_SIZE / 2;
    const seen = new Set();
    let vertical = 0;
    let topEdges = 0;
    for (let s = 0; s < DIG_TRACE_SEGMENTS; s++) {
      const a = verts[2 * s];
      const b = verts[2 * s + 1];
      const key = segmentKey(a, b);
      expect(highlightEdges.has(key), `segment ${s} is a highlight edge`).toBe(true);
      expect(seen.has(key), `segment ${s} repeats`).toBe(false);
      seen.add(key);
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6) {
        vertical++;
        expect(s % 2).toBe(0); // vertical edges at even positions …
        expect(a[1]).toBeCloseTo(bottom, 6); // … climbing from the bottom
        expect(b[1]).toBeCloseTo(top, 6);
      } else {
        topEdges++;
        expect(s % 2).toBe(1); // … each followed by the top edge to the next corner
        expect(a[1]).toBeCloseTo(top, 6);
        expect(b[1]).toBeCloseTo(top, 6);
      }
      // Every vertex is a corner of the highlight prism (HEX_SIZE·HIGHLIGHT_SIZE from the axis).
      for (const v of [a, b]) expect(Math.hypot(v[0], v[2])).toBeCloseTo(HEX_SIZE * HIGHLIGHT_SIZE, 5);
    }
    expect([vertical, topEdges]).toEqual([6, 6]);
  });

  it('starts at the north corner and runs clockwise seen from above (north up, east right)', () => {
    expect(DIG_TRACE_CORNER_ORDER).toEqual([5, 0, 1, 2, 3, 4]);
    const pos = digTracePositions();
    const corner = (s) => [pos[s * 6], pos[s * 6 + 2]]; // first vertex of segment s
    // The north corner is the one at −Z.
    const [nx, nz] = corner(0);
    expect(nx).toBeCloseTo(0, 6);
    expect(nz).toBeCloseTo(-HEX_SIZE * HIGHLIGHT_SIZE, 6);
    // The vertical edges visit the corners in order of increasing angle from +X toward +Z, 60° apart: from north
    // (−90°) to north-east (−30°), south-east, south, south-west, north-west — clockwise on a north-up map.
    const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
    let prevAngle = null;
    for (let i = 0; i < 6; i++) {
      const [x, z] = corner(2 * i);
      const angle = (Math.atan2(z, x) * 180) / Math.PI;
      expect(wrap(angle - (60 * DIG_TRACE_CORNER_ORDER[i] - 30))).toBeCloseTo(0, 3);
      if (prevAngle !== null) expect(wrap(angle - prevAngle)).toBeCloseTo(60, 3);
      prevAngle = angle;
    }
    const [ex, ez] = corner(2);
    expect(ex).toBeGreaterThan(0); // the second corner lies east …
    expect(ez).toBeLessThan(0); // … and still north of the centre
    // Each top edge runs from its own corner to the next corner of the walk (the last one closes the hexagon).
    for (let i = 0; i < 6; i++) {
      const s = 2 * i + 1;
      const next = (2 * ((i + 1) % 6)) * 6;
      expect(pos[s * 6 + 3]).toBeCloseTo(pos[next], 6);
      expect(pos[s * 6 + 5]).toBeCloseTo(pos[next + 2], 6);
    }
  });
});

describe('dig trace: renderer.setDigProgress', () => {
  function withTrace() {
    const canvas = fakeCanvas();
    const r = createRenderer(canvas, new THREE.Texture(), { webglRenderer: stubWebGLRenderer() });
    const trace = r.three.scene.getObjectByName('digTrace');
    return { r, trace, canvas };
  }

  it('is a honey LineSegments, hidden until digging, drawn after the black highlight', () => {
    const { r, trace } = withTrace();
    expect(trace).toBeDefined();
    expect(trace.isLineSegments).toBe(true);
    expect(trace.visible).toBe(false);
    expect(trace.geometry.drawRange.count).toBe(0);
    expect(trace.material.color.getHex()).toBe(DIG_TRACE_COLOR);
    expect(DIG_TRACE_COLOR).toBe(0xe8b04a);
    expect(trace.renderOrder).toBe(DIG_TRACE_RENDER_ORDER);
    expect(DIG_TRACE_RENDER_ORDER).toBe(3);
    const hl = r.three.scene.getObjectByName('highlight');
    expect(trace.renderOrder).toBeGreaterThan(hl.renderOrder);
    // Same render pass as the (transparent) highlight, or renderOrder would not order them.
    expect(trace.material.transparent).toBe(hl.material.transparent);
    expect(trace.geometry.getAttribute('position').count).toBe(2 * DIG_TRACE_SEGMENTS);
    r.dispose();
  });

  it('sits at hexToWorld(q, r) and the cell\'s y, with the draw range following p', () => {
    const { r, trace } = withTrace();
    for (const [q, y, rr] of [[0, 0, 0], [3, 64, -2], [-11, 5, 7], [-200, 127, -300]]) {
      const hit = { q, y, r: rr, face: FACE_TOP, nx: 0, ny: 1, nz: 0, distance: 2, blockId: 1 };
      const [cx, cz] = hexToWorld(q, rr);
      for (let i = 1; i <= 24; i++) {
        const p = i / 24;
        r.setDigProgress(hit, p);
        expect(trace.visible).toBe(true);
        expect(trace.geometry.drawRange.start).toBe(0);
        expect(trace.geometry.drawRange.count).toBe(2 * Math.ceil(12 * p));
        expect(trace.position.x).toBeCloseTo(cx, 10);
        expect(trace.position.y).toBe(y);
        expect(trace.position.z).toBeCloseTo(cz, 10);
      }
    }
    r.setDigProgress({ q: 1, y: 2, r: 3 }, 7);
    expect(trace.geometry.drawRange.count).toBe(24);
    r.dispose();
  });

  it('a null hit, p ≤ 0 or a bad p hides it (and draws nothing)', () => {
    const { r, trace } = withTrace();
    const hit = { q: 2, y: 30, r: -1 };
    for (const off of [() => r.setDigProgress(null, 0.5), () => r.setDigProgress(undefined, 1), () => r.setDigProgress(hit, 0),
      () => r.setDigProgress(hit, -1), () => r.setDigProgress(hit, NaN), () => r.setDigProgress(hit, undefined)]) {
      r.setDigProgress(hit, 0.6);
      expect(trace.visible).toBe(true);
      off();
      expect(trace.visible).toBe(false);
      expect(trace.geometry.drawRange.count).toBe(0);
    }
    r.dispose();
  });

  it('traced fully, it covers the same edges as the highlight on the same cell', () => {
    const { r, trace } = withTrace();
    const hit = { q: -4, y: 12, r: 9, face: FACE_TOP, nx: 0, ny: 1, nz: 0, distance: 1, blockId: 1 };
    r.setHighlight(hit);
    r.setDigProgress(hit, 1);
    const hl = r.three.scene.getObjectByName('highlight');
    const world = (obj) => lineVertices(obj.geometry).map(([x, y, z]) => [x + obj.position.x, y + obj.position.y, z + obj.position.z]);
    const hw = world(hl);
    const edges = new Set();
    for (let i = 0; i < hw.length; i += 2) edges.add(segmentKey(hw[i], hw[i + 1]));
    const tw = world(trace);
    for (let i = 0; i < tw.length; i += 2) expect(edges.has(segmentKey(tw[i], tw[i + 1])), `trace segment ${i / 2}`).toBe(true);
    r.dispose();
  });

  it('dispose() removes it and frees its geometry and material', () => {
    const { r, trace } = withTrace();
    const events = [];
    trace.geometry.addEventListener('dispose', () => events.push('geometry'));
    trace.material.addEventListener('dispose', () => events.push('material'));
    r.setDigProgress({ q: 0, y: 0, r: 0 }, 0.5);
    r.dispose();
    expect(events.sort()).toEqual(['geometry', 'material']);
    expect(r.three.scene.getObjectByName('digTrace')).toBeUndefined();
  });

  it('is rebuilt after a WebGL context restore, keeping what it showed', () => {
    const { r, trace, canvas } = withTrace();
    const hit = { q: 5, y: 40, r: -6 };
    r.setDigProgress(hit, 0.4);
    const before = trace.geometry;
    const positions = Array.from(before.getAttribute('position').array);
    let oldDisposed = 0;
    before.addEventListener('dispose', () => oldDisposed++);
    r.setChunkMesh('0,0', 0, 0, realLayer());
    canvas.dispatch('webglcontextrestored');
    expect(trace.geometry).not.toBe(before);
    expect(oldDisposed).toBe(1);
    expect(Array.from(trace.geometry.getAttribute('position').array)).toEqual(positions);
    expect(trace.geometry.drawRange.count).toBe(digTraceVertexCount(0.4));
    expect(trace.visible).toBe(true);
    expect(r.getStats().chunkMeshes).toBe(0); // the chunk meshes are still dropped as before
    // It keeps working afterwards.
    r.setDigProgress(hit, 1);
    expect(trace.geometry.drawRange.count).toBe(24);
    r.setDigProgress(null, 0);
    expect(trace.visible).toBe(false);
    r.dispose();
  });
});
