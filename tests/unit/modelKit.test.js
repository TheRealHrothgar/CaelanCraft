// modelKit.js (PURE): the art pilot's affine primitives — closed meshes wound outward, unit normals, uvs in [0, 1] of
// their faces, small triangle counts — and the helpers that place and combine them.
import { describe, it, expect } from 'vitest';
import {
  prism, loft, pyramid, chamferBox, wedge, transform, merge, atlasUV, compose, alongSegment, mul, rotation, translation,
  scaling, identity, triangleCount, bounds, BOX_FACES, WRAP_GROUPS,
} from '../../src/modelKit.js';

/** Weld vertices by position; every undirected edge must be used by exactly two triangles, once each way. */
function closedness(g) {
  const key = (v) => [0, 1, 2].map((a) => Math.round(g.positions[v * 3 + a] * 1e5)).join(',');
  const ids = new Map();
  const w = [];
  for (let v = 0; v < g.positions.length / 3; v++) {
    const k = key(v);
    if (!ids.has(k)) ids.set(k, ids.size);
    w.push(ids.get(k));
  }
  const edges = new Map();
  for (let t = 0; t < g.index.length; t += 3) {
    const tri = [w[g.index[t]], w[g.index[t + 1]], w[g.index[t + 2]]];
    for (let e = 0; e < 3; e++) {
      const k = `${tri[e]}>${tri[(e + 1) % 3]}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) bad++;
  }
  return bad;
}

const P = (g, i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Signed volume (positive: the triangles wind counter-clockwise seen from outside). */
function volume(g) {
  let v = 0;
  for (let t = 0; t < g.index.length; t += 3) {
    const [a, b, c] = [P(g, g.index[t]), P(g, g.index[t + 1]), P(g, g.index[t + 2])];
    v += dot(a, cross(b, c)) / 6;
  }
  return v;
}

/** Every triangle of a convex solid faces away from its centre (by its winding). */
function allOutward(g) {
  const n = g.positions.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += g.positions[i * 3 + a] / n;
  for (let t = 0; t < g.index.length; t += 3) {
    const [a, b, d] = [P(g, g.index[t]), P(g, g.index[t + 1]), P(g, g.index[t + 2])];
    const nn = cross(sub(b, a), sub(d, a));
    if (Math.hypot(...nn) < 1e-12) continue;
    const mid = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
    if (dot(nn, sub(mid, c)) <= 0) return false;
  }
  return true;
}

function unitNormals(g) {
  for (let i = 0; i < g.normals.length; i += 3) {
    if (Math.abs(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) - 1) > 1e-5) return false;
  }
  return true;
}

function uvsInRange(g) {
  return g.uvs.every((u) => u >= -1e-6 && u <= 1 + 1e-6);
}

const PRIMS = {
  'hex prism': () => prism({ sides: 6, rx: 0.3, rz: 0.2, h: 1 }),
  'hex prism, pointy': () => prism({ sides: 6, rx: 0.5, h: 1, phase: 0 }),
  'octagonal frustum, sheared, smooth': () => prism({ sides: 8, rx: 0.3, rz: 0.2, h: 1, top: { sx: 0.6, sz: 0.8, dx: 0.1, dz: -0.05 }, smooth: true }),
  'loft (a barrel)': () => loft({ sides: 6, rx: 0.3, rings: [{ y: 0, sx: 0.6 }, { y: 0.2 }, { y: 0.5, sx: 1.1 }, { y: 0.8, sx: 0.7 }] }),
  'loft (a gem with points)': () => loft({ sides: 8, rx: 0.2, smooth: true, rings: [{ y: 0, sx: 0 }, { y: 0.1 }, { y: 0.25, sx: 0 }] }),
  'pyramid, 4 sides': () => pyramid({ sides: 4, rx: 0.2, h: 0.5, apex: { dx: 0.05 } }),
  'pyramid, 6 sides': () => pyramid({ sides: 6, rx: 0.2, rz: 0.1, h: 0.5 }),
  chamferBox: () => chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.05 }),
  'chamferBox, smooth, tapered': () => chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.08, smooth: true, top: { sx: 0.8, sz: 0.9, dz: 0.02 } }),
  'chamferBox, a smaller bevel below': () => chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.1, cb: 0.03, top: { sx: 1.05 } }),
  'wedge, ridge at the front': () => wedge({ w: 0.1, h: 0.2, d: 0.1, ridge: -1 }),
  'wedge to a point': () => wedge({ w: 0.1, h: 0.2, d: 0.1, ridge: 0.3, sx: 0 }),
};

describe('primitives', () => {
  for (const [name, make] of Object.entries(PRIMS)) {
    it(`${name}: closed, wound outward, unit normals, uvs in [0, 1], valid groups`, () => {
      const g = make();
      expect(closedness(g)).toBe(0);
      expect(volume(g)).toBeGreaterThan(0);
      expect(allOutward(g)).toBe(true);
      expect(unitNormals(g)).toBe(true);
      expect(uvsInRange(g)).toBe(true);
      const max = g.kind === 'wrap' ? WRAP_GROUPS.length : BOX_FACES.length;
      expect(g.groups.every((k) => k < max)).toBe(true);
      expect(g.index.every((i) => i < g.positions.length / 3)).toBe(true);
    });
  }

  it('keeps every primitive small', () => {
    expect(triangleCount(prism({ sides: 6 }))).toBe(24); // 7 side quads (the back face split at the seam) + 5 + 5
    expect(triangleCount(prism({ sides: 8 }))).toBe(32);
    expect(triangleCount(prism({ sides: 6, phase: 0 }))).toBe(20); // a corner on the seam: nothing to split
    expect(triangleCount(prism({ sides: 6, caps: false }))).toBe(14);
    expect(triangleCount(pyramid({ sides: 4 }))).toBe(8);
    expect(triangleCount(chamferBox({}))).toBe(44); // 6 faces, 12 bevels, 8 corners
    expect(triangleCount(wedge({}))).toBe(8);
    expect(triangleCount(wedge({ sx: 0 }))).toBe(6);
  });

  it('measures a prism: an elliptical hexagon of the right area, its height, its taper', () => {
    const g = prism({ sides: 6, rx: 0.3, rz: 0.2, h: 1 });
    expect(volume(g)).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 0.3 * 0.2, 6);
    const b = bounds(g);
    expect(b.min[1]).toBeCloseTo(0, 9);
    expect(b.max[1]).toBeCloseTo(1, 9);
    expect(b.max[0]).toBeCloseTo(0.3, 6); // a corner at each side (the default phase puts flats at front and back)
    const t = bounds(prism({ sides: 6, rx: 0.3, h: 1, top: { sx: 0.5, dx: 0.4 } }));
    expect(t.max[0]).toBeCloseTo(0.4 + 0.15, 6);
  });

  it('unwraps a prism round from the back: u 0.5 at the front, v up, caps planar', () => {
    const g = prism({ sides: 6, rx: 0.3, rz: 0.2, h: 1 });
    for (let v = 0; v < g.groups.length; v++) {
      if (g.groups[v] !== 0) continue;
      const [x, y, z] = P(g, v);
      expect(g.uvs[v * 2 + 1]).toBeCloseTo(y, 6);
      if (Math.abs(x) < 1e-6 && z < 0) expect(g.uvs[v * 2]).toBeCloseTo(0.5, 6); // the middle of the front
      if (x > 0.29) expect(g.uvs[v * 2]).toBeCloseTo(0.25, 6); // the +x corner, a quarter round
    }
    expect([...g.groups].filter((k) => k === 1).length).toBeGreaterThan(0);
    expect([...g.groups].filter((k) => k === 2).length).toBeGreaterThan(0);
  });

  it('gives a flat prism one normal per facet and a smooth one a normal per ring corner', () => {
    const flat = prism({ sides: 6, rx: 0.3, h: 1 });
    for (let t = 0; t < flat.index.length; t += 3) {
      const [a, b, c] = [flat.index[t], flat.index[t + 1], flat.index[t + 2]];
      const n = cross(sub(P(flat, b), P(flat, a)), sub(P(flat, c), P(flat, a)));
      const l = Math.hypot(...n);
      for (const v of [a, b, c]) expect(dot([flat.normals[v * 3], flat.normals[v * 3 + 1], flat.normals[v * 3 + 2]], n) / l).toBeCloseTo(1, 5);
    }
    const soft = prism({ sides: 8, rx: 0.3, h: 1, smooth: true });
    // a side vertex at a corner (not on the seam) points straight out from the axis, between its two facets
    let seen = 0;
    for (let v = 0; v < soft.groups.length; v++) {
      if (soft.groups[v] !== 0) continue;
      const [x, , z] = P(soft, v);
      if (Math.abs(x) < 1e-6) continue;
      const r = Math.hypot(x, z);
      expect(soft.normals[v * 3] * (x / r) + soft.normals[v * 3 + 2] * (z / r)).toBeCloseTo(1, 5);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('maps a chamfered box like a box: each face its own uvs, the bevels on the front, the sides, the top', () => {
    const g = chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.05 });
    const count = BOX_FACES.map((_, f) => [...g.groups].filter((k) => k === f).length);
    expect(count.every((n) => n > 0)).toBe(true);
    // the front's corner points: u runs to the viewer's right (−x), v up
    for (let v = 0; v < g.groups.length; v++) {
      if (BOX_FACES[g.groups[v]] !== 'front') continue;
      const [x, y] = P(g, v);
      expect(g.uvs[v * 2]).toBeCloseTo(0.5 - x / 0.4, 6);
      expect(g.uvs[v * 2 + 1]).toBeCloseTo(0.5 + y / 0.5, 6);
    }
    // smooth: a vertex takes the normal of the face its point lies on (axis-aligned for an untapered box)
    const s = chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.05, smooth: true });
    for (let i = 0; i < s.normals.length; i += 3) {
      const n = [Math.abs(s.normals[i]), Math.abs(s.normals[i + 1]), Math.abs(s.normals[i + 2])].sort((a, b) => b - a);
      expect(n[0]).toBeCloseTo(1, 6);
    }
  });

  it('clamps a chamfer that would eat the box', () => {
    const g = chamferBox({ w: 0.1, h: 0.1, d: 0.1, c: 1 });
    expect(closedness(g)).toBe(0);
    expect(volume(g)).toBeGreaterThan(0);
  });

  it('refuses a loft of one ring or fewer than three sides', () => {
    expect(() => loft({ rings: [{ y: 0 }] })).toThrow(RangeError);
    expect(() => loft({ sides: 2, rings: [{ y: 0 }, { y: 1 }] })).toThrow(RangeError);
  });
});

describe('placing and combining', () => {
  it('composes scale, then turn, then move (three\'s Euler XYZ)', () => {
    const m = compose({ t: [1, 2, 3], r: [0, Math.PI / 2, 0], s: 2 });
    const g = transform(prism({ sides: 6, rx: 0.1, h: 1 }), m);
    const b = bounds(g);
    // +y stays +y (scaled), so the column stands from y 2 to y 4 at (1, ·, 3)
    expect(b.min[1]).toBeCloseTo(2, 5);
    expect(b.max[1]).toBeCloseTo(4, 5);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(1, 5);
    expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(3, 5);
    expect(mul(identity(), m)).toEqual(m);
    expect(mul(translation(1, 0, 0), translation(0, 2, 0))[13]).toBe(2);
  });

  it('keeps triangles wound outward and normals unit under a mirror and a squash', () => {
    for (const m of [compose({ s: [1, -1, 1] }), compose({ s: [-2, 1, 0.5], r: [0.3, 0.2, 0.1] }), scaling(3, 0.2, 1)]) {
      const g = transform(chamferBox({ w: 0.4, h: 0.5, d: 0.3, c: 0.05 }), m);
      expect(closedness(g)).toBe(0);
      expect(volume(g)).toBeGreaterThan(0);
      expect(allOutward(g)).toBe(true);
      expect(unitNormals(g)).toBe(true);
    }
  });

  it('lays a part along a segment, its front kept toward the model\'s front', () => {
    const a = [0.2, 1, 0];
    const b = [0.25, 0.4, -0.1];
    const L = Math.hypot(0.05, 0.6, 0.1);
    const M = alongSegment(a, b);
    const tip = [M[4] * L + M[12], M[5] * L + M[13], M[6] * L + M[14]];
    expect(tip[0]).toBeCloseTo(b[0], 9);
    expect(tip[1]).toBeCloseTo(b[1], 9);
    expect(tip[2]).toBeCloseTo(b[2], 9);
    // orthonormal and right-handed
    const X = [M[0], M[1], M[2]];
    const Y = [M[4], M[5], M[6]];
    const Z = [M[8], M[9], M[10]];
    for (const v of [X, Y, Z]) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(dot(X, Y)).toBeCloseTo(0, 9);
    expect(dot(cross(Y, Z), X)).toBeCloseTo(1, 9);
    expect(Z[2]).toBeGreaterThan(0.9); // +z (the back) stays toward the back
    // straight along the hint: a fallback frame, still orthonormal
    const S = alongSegment([0, 0, 0], [0, 0, 1]);
    expect(dot([S[0], S[1], S[2]], [S[8], S[9], S[10]])).toBeCloseTo(0, 9);
    const g = transform(prism({ h: L }), M);
    expect(closedness(g)).toBe(0);
    expect(volume(g)).toBeGreaterThan(0);
  });

  it('turns about an axis the right-handed way', () => {
    const R = rotation(2, Math.PI / 2); // about z: +x to +y
    expect(R[1]).toBeCloseTo(1, 9);
    expect(R[4]).toBeCloseTo(-1, 9);
  });

  it('merges geometries: the counts add, the indices stay in their own part', () => {
    const a = prism({});
    const b = transform(chamferBox({}), { t: [3, 0, 0] });
    const m = merge([a, b]);
    expect(triangleCount(m)).toBe(triangleCount(a) + triangleCount(b));
    expect(m.positions.length).toBe(a.positions.length + b.positions.length);
    expect(m.kind).toBe('mixed');
    expect(closedness(m)).toBe(0);
    expect(merge([a, prism({ sides: 8 })]).kind).toBe('wrap');
  });

  it('moves a part\'s uvs onto its rectangles of an atlas (v down the rows)', () => {
    const g = prism({ sides: 6 });
    const rects = [[10, 20, 30, 40], [50, 0, 8, 8], [60, 0, 8, 8]];
    const m = atlasUV(g, (k) => rects[k], 128, 64);
    for (let v = 0; v < g.groups.length; v++) {
      const [x, y, w, h] = rects[g.groups[v]];
      const u = m.uvs[v * 2] * 128;
      const r = m.uvs[v * 2 + 1] * 64;
      expect(u).toBeGreaterThanOrEqual(x - 1e-4);
      expect(u).toBeLessThanOrEqual(x + w + 1e-4);
      expect(r).toBeGreaterThanOrEqual(y - 1e-4);
      expect(r).toBeLessThanOrEqual(y + h + 1e-4);
      expect(r).toBeCloseTo(y + (1 - g.uvs[v * 2 + 1]) * h, 3);
    }
    expect(m.positions).toBe(g.positions); // only the uvs change
  });
});
