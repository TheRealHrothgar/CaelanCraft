// Caelancraft — the model kit: small AFFINE primitives built in code (PURE: no three, no DOM). See src/CONTRACTS.md §91.2.
// The avatars are built from it (avatarModel.js, figureKit.js); the art pilot (gallery.html) shows what comes next.
//
// Every model in the honeycomb world is a handful of straight-edged solids: n-gon prisms and frusta (6 sides for the
// hexagon, 8 for a softer column), chamfered boxes (never a hard cube), wedges and pyramids for noses, ears, beaks,
// horns and leaves. Each primitive is a closed mesh whose triangles wind counter-clockwise seen from outside, with
// positions, unit normals, uvs in [0, 1] of the face they belong to, and a per-vertex face GROUP:
//   - prism / loft / pyramid ('wrap'): group 0 the sides, unwrapped round the solid — u is the distance round the base
//     polygon from the middle of its BACK (+z), through the solid's +x side and its FRONT (−z, u = 0.5), so a picture
//     painted on the strip reads the right way round from outside; v runs up — group 1 the top cap, group 2 the bottom
//     cap (planar);
//   - chamferBox / wedge ('box'): groups 0..5 are BOX_FACES (three's BoxGeometry order); every face, bevel and corner is
//     projected on the box face it belongs to, so a 6-face skin layout (front, back, sides, top, bottom) still works.
// `smooth` gives a prism's sides one normal per ring vertex (the facets shade round like a column) and a chamfered box's
// bevels the normals of the faces they join (rounded edges, flat faces); without it every facet is flat.
// transform() and merge() place and combine geometries; atlasUV() moves a part's uvs onto its rectangles of a
// texture atlas. A geometry is { positions, normals, uvs, groups, index, kind } (typed arrays).

/** The six faces of a box, in group order (three's BoxGeometry order). The model faces −Z: 'front' is −z. */
export const BOX_FACES = Object.freeze(['right', 'left', 'top', 'bottom', 'back', 'front']);
/** The groups of a prism, a loft or a pyramid. */
export const WRAP_GROUPS = Object.freeze(['side', 'top', 'bottom']);

/**
 * @typedef {Object} Geo
 * @property {Float32Array} positions  xyz per vertex (metres)
 * @property {Float32Array} normals    xyz per vertex, unit
 * @property {Float32Array} uvs        uv per vertex: [0, 1] of its face (v up) — or atlas coordinates after atlasUV
 * @property {Uint8Array} groups       the face group of each vertex (WRAP_GROUPS or BOX_FACES by `kind`)
 * @property {Uint32Array} index       three per triangle, counter-clockwise seen from outside
 * @property {'wrap'|'box'|'mixed'} kind
 */
/** @typedef {number[]|Float64Array} Mat4  16 numbers, column-major (three's Matrix4.elements) */
/** @typedef {[number, number, number]} Vec3 */

const EPS = 1e-9;

/** Newell's normal of a polygon (unnormalised: its length is twice the area). @param {Vec3[]} pts @returns {Vec3} */
function newell(pts) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/** @param {Vec3} v @returns {Vec3} */
function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > EPS ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/** Collects polygons into one indexed geometry (every polygon has its own vertices). */
class Builder {
  constructor() {
    /** @type {number[]} */ this.p = [];
    /** @type {number[]} */ this.n = [];
    /** @type {number[]} */ this.uv = [];
    /** @type {number[]} */ this.g = [];
    /** @type {number[]} */ this.i = [];
  }

  /**
   * One convex polygon, counter-clockwise from outside, fanned from corner `fan`. Coincident neighbours are dropped (a
   * quad with a point for an edge is a triangle); fewer than three corners add nothing.
   * @param {Vec3[]} pts
   * @param {number[][]} uvs  per corner
   * @param {number} group
   * @param {Vec3[]|null} [nrm]  per-corner normals (smooth), else the polygon's own
   * @param {number} [fan]
   */
  poly(pts, uvs, group, nrm = null, fan = 0) {
    const keep = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-7) keep.push(k);
    }
    if (keep.length < 3) return;
    const flat = unit(newell(keep.map((k) => pts[k])));
    const base = this.p.length / 3;
    for (const k of keep) {
      const n = nrm ? unit(nrm[k]) : flat;
      this.p.push(pts[k][0], pts[k][1], pts[k][2]);
      this.n.push(n[0], n[1], n[2]);
      this.uv.push(uvs[k][0], uvs[k][1]);
      this.g.push(group);
    }
    const m = keep.length;
    const f = Math.max(0, keep.indexOf(fan));
    for (let k = 1; k < m - 1; k++) this.i.push(base + f, base + ((f + k) % m), base + ((f + k + 1) % m));
  }

  /** @param {'wrap'|'box'} kind @returns {Geo} */
  done(kind) {
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      uvs: new Float32Array(this.uv),
      groups: new Uint8Array(this.g),
      index: new Uint32Array(this.i),
      kind,
    };
  }
}

/**
 * @typedef {Object} Ring  one cross-section of a loft: the base polygon scaled (sx, sz) and moved (dx, dz) at height y
 * @property {number} y
 * @property {number} [sx]
 * @property {number} [sz]  (default sx)
 * @property {number} [dx]
 * @property {number} [dz]
 */

/**
 * A stack of n-gon rings joined by flat facets (a prism, a frustum, a barrel, a gem): the general form of prism() and
 * pyramid(). The base polygon has `sides` corners on the ellipse (rx, rz), the first at `phase` radians round from the
 * back (+z) toward +x — the default π/sides puts a flat face at the back and (for an even count) the front. A ring
 * scaled to nothing is a point (an apex): its facets are triangles and it has no cap. `corners` (radians round from
 * the back toward +x, any order) puts the corners where it says instead — a head with a broad flat face plane in front.
 * `keep`: the n-gon as asked for, whatever the shape language (§107).
 * @param {{ sides?: number, rx?: number, rz?: number, rings: Ring[], smooth?: boolean, phase?: number,
 *   corners?: number[], caps?: boolean|{ top?: boolean, bottom?: boolean }, keep?: boolean }} o
 * @returns {Geo}
 */
export function loft({ sides = 6, rx = 0.5, rz = rx, rings, smooth = false, phase = Math.PI / sides, corners, caps = true, keep = false }) {
  if (!Array.isArray(rings) || rings.length < 2) throw new RangeError('loft: at least two rings');
  const { pts, us } = basePolygon({ sides, rx, rz, phase, corners, keep });
  const m = pts.length; // ring points; the strip closes on a copy of the first (u = 1)
  const R = rings.map((r) => ({ y: r.y, sx: r.sx ?? 1, sz: r.sz ?? r.sx ?? 1, dx: r.dx ?? 0, dz: r.dz ?? 0 }));
  const apex = R.map((r) => Math.abs(r.sx * rx) < EPS && Math.abs(r.sz * rz) < EPS);
  /** @returns {Vec3} */
  const at = (k, j) => {
    const r = R[k];
    const p = pts[j % m];
    return [r.sx * p.x + r.dx, r.y, r.sz * p.z + r.dz];
  };
  const y0 = R[0].y;
  const yH = R[R.length - 1].y - y0 || 1;
  const vOf = (k) => (R[k].y - y0) / yH;
  // the facets' normals (for smooth shading): face (k, j) joins rings k, k + 1 between points j, j + 1
  /** @type {Vec3[][]} */
  const faceN = [];
  for (let k = 0; k < R.length - 1; k++) {
    faceN.push([]);
    for (let j = 0; j < m; j++) faceN[k].push(unit(newell([at(k, j), at(k, j + 1), at(k + 1, j + 1), at(k + 1, j)])));
  }
  /** the smooth normal at ring k, point j: the mean of the facets round it */
  const vertN = (k, j) => {
    const s = [0, 0, 0];
    for (const kk of [k - 1, k]) {
      if (kk < 0 || kk >= R.length - 1) continue;
      for (const jj of [(j - 1 + m) % m, j % m]) {
        const f = faceN[kk][jj];
        s[0] += f[0];
        s[1] += f[1];
        s[2] += f[2];
      }
    }
    return unit(/** @type {Vec3} */ (s));
  };
  const b = new Builder();
  for (let k = 0; k < R.length - 1; k++) {
    for (let j = 0; j < m; j++) {
      const P = [at(k, j), at(k, j + 1), at(k + 1, j + 1), at(k + 1, j)];
      const uM = (us[j] + us[j + 1]) / 2;
      const U = [
        [apex[k] ? uM : us[j], vOf(k)], [apex[k] ? uM : us[j + 1], vOf(k)],
        [apex[k + 1] ? uM : us[j + 1], vOf(k + 1)], [apex[k + 1] ? uM : us[j], vOf(k + 1)],
      ];
      const N = smooth ? [vertN(k, j), vertN(k, j + 1), vertN(k + 1, j + 1), vertN(k + 1, j)] : null;
      b.poly(/** @type {Vec3[]} */ (P), U, 0, /** @type {Vec3[]|null} */ (N), apex[k] ? 2 : 0);
    }
  }
  const capTop = caps === true || (typeof caps === 'object' && caps.top !== false);
  const capBottom = caps === true || (typeof caps === 'object' && caps.bottom !== false);
  const far = Math.floor(m / 2); // fan from the corner across from the seam (the seam lies on an edge)
  const capUV = (j, sign) => [0.5 - pts[j].x / (2 * rx), 0.5 + (sign * pts[j].z) / (2 * rz)];
  const last = R.length - 1;
  if (capTop && !apex[last]) {
    const idx = [...Array(m).keys()];
    b.poly(idx.map((j) => at(last, j)), idx.map((j) => capUV(j, 1)), 1, null, far);
  }
  if (capBottom && !apex[0]) {
    const idx = [...Array(m).keys()].reverse();
    b.poly(idx.map((j) => at(0, j)), idx.map((j) => capUV(j, -1)), 2, null, m - 1 - far);
  }
  return b.done('wrap');
}

// ---- The shape language (CONTRACTS §107). The figures — avatars, zombies, animals, the phantom, the hand — are built of
// CHISELLED BLOCKS: every cross-section a rectangle square to its part's axes, the tapers, swells and points of the
// rings kept (the user's kids voted the hex-faceted figures out: "they like the blocky graphics better"; the painted
// atlases stay). 'block' is the game's language; 'hex' is the n-gon each call asks for (`sides`, `corners`, `phase`),
// kept for the gallery's comparison. A loft with `keep` is always its own n-gon (the plants, the Watcher's hex bands).
/** @typedef {'block'|'hex'} ShapeLanguage */
/** @type {ShapeLanguage} */
let SHAPE = 'block';
/** Set the language every loft, prism, pyramid and sweep built from now on speaks. @param {ShapeLanguage} s */
export function setShapeLanguage(s) {
  if (s !== 'block' && s !== 'hex') throw new RangeError(`modelKit: no shape language "${s}"`);
  SHAPE = s;
}
/** @returns {ShapeLanguage} */
export const shapeLanguage = () => SHAPE;
/**
 * Build something in another language and come back (the gallery's faceted column, the pilot's plants, a test).
 * @template T @param {ShapeLanguage} s @param {() => T} fn @returns {T}
 */
export function withShapeLanguage(s, fn) {
  const was = SHAPE;
  setShapeLanguage(s);
  try {
    return fn();
  } finally {
    SHAPE = was;
  }
}
/** A block's half-sides as a share of the radii (rx, rz) its part was given: about the area of the hexagon it replaces. */
export const BLOCK_K = 0.9;

/** The base polygon of a block: a rectangle, its faces square to the axes, the seam's point in the middle of the back. */
function blockPolygon(rx, rz) {
  const a = Math.abs(rx) * BLOCK_K;
  const b = Math.abs(rz) * BLOCK_K;
  const th = (x, z) => {
    const t = Math.atan2(x, z);
    return t < 0 ? t + 2 * Math.PI : t;
  };
  const pts = [{ th: 0, x: 0, z: b }, { th: th(a, b), x: a, z: b }, { th: th(a, -b), x: a, z: -b }, { th: th(-a, -b), x: -a, z: -b }, { th: th(-a, b), x: -a, z: b }];
  if (!(a > 0) || !(b > 0)) {
    // a flat or empty section: spread the corners so nothing divides by zero
    pts[1].th = Math.PI / 4;
    pts[2].th = (3 * Math.PI) / 4;
    pts[3].th = (5 * Math.PI) / 4;
    pts[4].th = (7 * Math.PI) / 4;
  }
  const lens = [0];
  for (let j = 0; j < pts.length; j++) {
    const p = pts[j];
    const q = pts[(j + 1) % pts.length];
    lens.push(lens[j] + Math.hypot(q.x - p.x, q.z - p.z));
  }
  const perimeter = lens[pts.length] || 1;
  return { pts, us: lens.map((l) => l / perimeter), perimeter };
}

/**
 * A loft's base polygon: its corners on the ellipse (rx, rz) in order round from the back, the seam's point at the
 * middle of the back (θ = 0) added when no corner is there, and each point's u (its share of the way round).
 * @param {{ sides?: number, rx?: number, rz?: number, phase?: number, corners?: number[], keep?: boolean }} o
 * @returns {{ pts: { th: number, x: number, z: number }[], us: number[], perimeter: number }}
 */
export function basePolygon({ sides = 6, rx = 0.5, rz = rx, phase = Math.PI / sides, corners, keep = false }) {
  if (corners ? corners.length < 3 : !(sides >= 3)) throw new RangeError('loft: at least three sides');
  if (SHAPE === 'block' && !keep) return blockPolygon(rx, rz);
  const angles = corners ?? [];
  if (!corners) {
    for (let i = 0; i < Math.round(sides); i++) angles.push(phase + (i * 2 * Math.PI) / Math.round(sides));
  }
  if (angles.length < 3) throw new RangeError('loft: at least three sides');
  /** @type {{ th: number, x: number, z: number }[]} */
  const pts = angles.map((a) => {
    let th = a % (2 * Math.PI);
    if (th < 0) th += 2 * Math.PI;
    return { th, x: rx * Math.sin(th), z: rz * Math.cos(th) };
  });
  pts.sort((a, b) => a.th - b.th);
  const n = pts.length;
  if (pts[0].th > 1e-7 && 2 * Math.PI - pts[n - 1].th > 1e-7) {
    // the back edge, from the last corner (before 2π) to the first: where it crosses x = 0 on the +z side
    const a = pts[n - 1];
    const b = pts[0];
    const t = a.x / (a.x - b.x);
    pts.unshift({ th: 0, x: 0, z: a.z + (b.z - a.z) * t });
  } else if (2 * Math.PI - pts[n - 1].th <= 1e-7) {
    const last = /** @type {{ th: number, x: number, z: number }} */ (pts.pop());
    pts.unshift({ th: 0, x: last.x, z: last.z });
  }
  const m = pts.length;
  const lens = [0];
  for (let j = 0; j < m; j++) {
    const a = pts[j];
    const b = pts[(j + 1) % m];
    lens.push(lens[j] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const perimeter = lens[m];
  return { pts, us: lens.map((l) => l / perimeter), perimeter };
}

/**
 * Where a loft's strip is at angle θ round from the back (radians toward +x): its u (0..1), and the base polygon's
 * perimeter (metres) — for painting a picture (a face) on the facets that face that way.
 * @param {{ sides?: number, rx?: number, rz?: number, phase?: number, corners?: number[], keep?: boolean }} o  the loft's own
 * @param {number} theta
 * @returns {{ u: number, perimeter: number }}
 */
export function wrapU(o, theta) {
  const { pts, us, perimeter } = basePolygon(o);
  let th = theta % (2 * Math.PI);
  if (th < 0) th += 2 * Math.PI;
  const m = pts.length;
  for (let j = 0; j < m; j++) {
    const a = pts[j];
    const b = pts[(j + 1) % m];
    const thB = j + 1 < m ? b.th : 2 * Math.PI;
    if (th < a.th - 1e-12 || th > thB + 1e-12) continue;
    // where the ray at θ crosses the edge a → b
    const dx = Math.sin(th);
    const dz = Math.cos(th);
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const den = ex * dz - ez * dx;
    const t = Math.abs(den) < 1e-12 ? 0 : Math.min(1, Math.max(0, (a.z * dx - a.x * dz) / den));
    return { u: us[j] + (us[j + 1] - us[j]) * t, perimeter };
  }
  return { u: 0, perimeter };
}

/**
 * A loft through rings of points given outright (each ring the same number of points, in order round it; a ring whose
 * points all meet is an apex): flat facets between rings, a cap on each open end (fanned, so a ring need not be flat —
 * a hairline that dips to the nape). Whichever way round the rings are listed, the result winds outward (checked by
 * its signed volume). Groups as a loft's: 0 the strip (u round by the widest ring, v along by the rings' middles), 1
 * the last ring's cap, 2 the first's.
 * @param {{ rings: number[][][] }} o
 * @returns {Geo}
 */
export function ringLoft({ rings }) {
  if (!Array.isArray(rings) || rings.length < 2) throw new RangeError('ringLoft: at least two rings');
  const m = rings[0].length;
  if (m < 3 || rings.some((r) => r.length !== m)) throw new RangeError('ringLoft: rings of three or more points, all alike');
  const P = rings.map((r) => r.map((p) => /** @type {Vec3} */ ([p[0], p[1], p[2]])));
  const mid = P.map((r) => r.reduce((s, p) => [s[0] + p[0] / m, s[1] + p[1] / m, s[2] + p[2] / m], [0, 0, 0]));
  const spanOf = (r) => r.reduce((s, p, j) => s + Math.hypot(...sub3(r[(j + 1) % m], p)), 0);
  const apex = P.map((r) => spanOf(r) < 1e-9);
  // u: the widest ring's share of the way round; v: the distance along the rings' middles
  let wide = 0;
  for (let k = 1; k < P.length; k++) if (spanOf(P[k]) > spanOf(P[wide])) wide = k;
  const us = [0];
  for (let j = 0; j < m; j++) us.push(us[j] + Math.hypot(...sub3(P[wide][(j + 1) % m], P[wide][j])));
  for (let j = 0; j <= m; j++) us[j] /= us[m] || 1;
  const vs = [0];
  for (let k = 1; k < P.length; k++) vs.push(vs[k - 1] + Math.hypot(...sub3(mid[k], mid[k - 1])));
  for (let k = 0; k < P.length; k++) vs[k] /= vs[P.length - 1] || 1;
  const b = new Builder();
  for (let k = 0; k + 1 < P.length; k++) {
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      const uM = (us[j] + us[j + 1]) / 2;
      b.poly([P[k][j], P[k][j1], P[k + 1][j1], P[k + 1][j]], [
        [apex[k] ? uM : us[j], vs[k]], [apex[k] ? uM : us[j + 1], vs[k]],
        [apex[k + 1] ? uM : us[j + 1], vs[k + 1]], [apex[k + 1] ? uM : us[j], vs[k + 1]],
      ], 0, null, apex[k] ? 2 : 0);
    }
  }
  /** a cap's planar uvs: the ring about its middle, in its own plane */
  const capUV = (r, c) => {
    const e1 = unit(sub3(r[0], c));
    const n = unit(newell(r));
    const e2 = /** @type {Vec3} */ ([n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]]);
    const R = Math.max(...r.map((p) => Math.hypot(...sub3(p, c)))) || 1;
    return r.map((p) => {
      const d = sub3(p, c);
      return [Math.min(1, Math.max(0, 0.5 + (0.5 * (d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2])) / R)), Math.min(1, Math.max(0, 0.5 + (0.5 * (d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2])) / R))];
    });
  };
  const last = P.length - 1;
  if (!apex[last]) b.poly(P[last], capUV(P[last], mid[last]), 1, null, Math.floor(m / 2));
  if (!apex[0]) {
    const r = [...P[0]].reverse();
    b.poly(r, capUV(r, mid[0]), 2, null, Math.floor(m / 2));
  }
  const g = b.done('wrap');
  // wound outward: a closed solid's signed volume is positive
  let vol = 0;
  for (let t = 0; t < g.index.length; t += 3) {
    const [i, j, k] = [g.index[t] * 3, g.index[t + 1] * 3, g.index[t + 2] * 3];
    const p = g.positions;
    vol += p[i] * (p[j + 1] * p[k + 2] - p[j + 2] * p[k + 1]) - p[i + 1] * (p[j] * p[k + 2] - p[j + 2] * p[k]) + p[i + 2] * (p[j] * p[k + 1] - p[j + 1] * p[k]);
  }
  if (vol < 0) {
    for (let t = 0; t < g.index.length; t += 3) [g.index[t + 1], g.index[t + 2]] = [g.index[t + 2], g.index[t + 1]];
    for (let i = 0; i < g.normals.length; i++) g.normals[i] = -g.normals[i];
  }
  return g;
}

/** @param {number[]} a @param {number[]} b @returns {Vec3} */
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * A SWEEP: an n-gon cross-section carried along a smooth curve through `points` (Catmull-Rom; three or four are
 * plenty), `rx` wide and `rz` thick, its thickness facing `up` (made square to the curve at each station), scaled by
 * `profile` (one scale per station, or a function of the share along) — a lock of hair, a ribbon, a tail, a horn
 * that bends. `segments` stations past the first; a profile ending in 0 ends in a point. `up` may be a function of a
 * station's centre (a ribbon kept flat to a curved surface: up its normal there).
 * @param {{ points: number[][], sides?: number, rx?: number, rz?: number, up?: number[]|((c: number[], t: number) => number[]),
 *   profile?: number[]|((t: number) => number), segments?: number, phase?: number, keep?: boolean }} o
 * @returns {Geo}
 */
export function sweep({ points, sides = 6, rx = 0.05, rz = rx, up = [0, 0, 1], profile, segments = 4, phase, keep = false }) {
  if (!Array.isArray(points) || points.length < 2) throw new RangeError('sweep: at least two points');
  const n = points.length;
  const at = (i) => points[Math.max(0, Math.min(n - 1, i))];
  /** Catmull-Rom through the points (the ends mirrored), s from 0 to n − 1 */
  const curve = (s) => {
    const i = Math.min(n - 2, Math.floor(s));
    const t = s - i;
    const p1 = at(i);
    const p2 = at(i + 1);
    const p0 = i > 0 ? at(i - 1) : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]];
    const p3 = i + 2 < n ? at(i + 2) : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]];
    const t2 = t * t;
    const t3 = t2 * t;
    return [0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3));
  };
  const S = Math.max(1, Math.round(segments));
  const centres = [];
  for (let k = 0; k <= S; k++) centres.push(curve(((n - 1) * k) / S));
  const scale = (k) => (typeof profile === 'function' ? profile(k / S) : profile ? profile[Math.min(profile.length - 1, k)] : 1 - (k / S) ** 1.5);
  const { pts } = basePolygon({ sides, rx: 1, rz: 1, phase, keep });
  const upAt = (c, k) => (typeof up === 'function' ? up(c, k / S) : up);
  const u0 = upAt(centres[0], 0);
  let prevN = unit(/** @type {Vec3} */ ([u0[0], u0[1], u0[2]]));
  const rings = centres.map((c, k) => {
    const a = centres[Math.max(0, k - 1)];
    const b2 = centres[Math.min(S, k + 1)];
    const T = unit(sub3(b2, a));
    const uk = upAt(c, k);
    const d = uk[0] * T[0] + uk[1] * T[1] + uk[2] * T[2];
    let N = /** @type {Vec3} */ ([uk[0] - d * T[0], uk[1] - d * T[1], uk[2] - d * T[2]]);
    N = Math.hypot(...N) > 1e-6 ? unit(N) : prevN;
    // never let the section turn over between stations (a twisted ribbon folds its faces inside out)
    if (N[0] * prevN[0] + N[1] * prevN[1] + N[2] * prevN[2] < 0) N = /** @type {Vec3} */ ([-N[0], -N[1], -N[2]]);
    prevN = N;
    const X = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    const s = scale(k);
    return pts.map((p) => [0, 1, 2].map((ax) => c[ax] + X[ax] * rx * s * p.x + N[ax] * rz * s * p.z));
  });
  return ringLoft({ rings });
}

/**
 * An n-gon prism or frustum standing on its base (y = 0 to h): an elliptical cross-section (rx, rz), the top scaled
 * (sx, sz) and moved (dx, dz) — a taper and a shear, nothing that bends.
 * @param {{ sides?: number, rx?: number, rz?: number, h?: number, top?: { sx?: number, sz?: number, dx?: number, dz?: number },
 *   smooth?: boolean, phase?: number, caps?: boolean|{ top?: boolean, bottom?: boolean }, keep?: boolean }} [o]
 * @returns {Geo}
 */
export function prism({ sides = 6, rx = 0.5, rz = rx, h = 1, top = {}, smooth = false, phase, caps = true, keep = false } = {}) {
  return loft({ sides, rx, rz, smooth, phase, caps, keep, rings: [{ y: 0 }, { y: h, ...top }] });
}

/**
 * An n-gon pyramid (a cone of flat facets) on its base: the apex `h` up, moved (dx, dz) — a horn, a beak, a tail, a
 * spike of hair.
 * @param {{ sides?: number, rx?: number, rz?: number, h?: number, apex?: { dx?: number, dz?: number }, smooth?: boolean,
 *   phase?: number, keep?: boolean }} [o]
 * @returns {Geo}
 */
export function pyramid({ sides = 4, rx = 0.5, rz = rx, h = 1, apex = {}, smooth = false, phase, keep = false } = {}) {
  return loft({ sides, rx, rz, smooth, phase, keep, rings: [{ y: 0 }, { y: h, sx: 0, sz: 0, dx: apex.dx ?? 0, dz: apex.dz ?? 0 }] });
}

/** Box-face projection: the uv of point p (in the box [−w/2, w/2] × [−h/2, h/2] × [−d/2, d/2]) on face f. */
function boxUV(p, f, w, h, d) {
  const [x, y, z] = p;
  switch (BOX_FACES[f]) {
    case 'right': return [0.5 - z / d, 0.5 + y / h];
    case 'left': return [0.5 + z / d, 0.5 + y / h];
    case 'top': return [0.5 - x / w, 0.5 + z / d];
    case 'bottom': return [0.5 - x / w, 0.5 - z / d];
    case 'back': return [0.5 + x / w, 0.5 + y / h];
    default: return [0.5 - x / w, 0.5 + y / h];
  }
}

/** The box face a direction belongs to (the largest component). */
function faceOf(n) {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return n[2] > 0 ? 4 : 5;
  if (ax >= ay) return n[0] > 0 ? 0 : 1;
  return n[1] > 0 ? 2 : 3;
}

/** Corner points in counter-clockwise order seen from outside (`inside` is any point inside the solid). */
function outward(pts, inside) {
  const nn = newell(pts);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0] / pts.length;
    cy += p[1] / pts.length;
    cz += p[2] / pts.length;
  }
  const dot = nn[0] * (cx - inside[0]) + nn[1] * (cy - inside[1]) + nn[2] * (cz - inside[2]);
  return dot < 0 ? [...pts].reverse() : pts;
}

/**
 * A box with chamfered edges and corners, centred on the origin: w across (x), h tall (y), d deep (z), every edge cut
 * `c` back (at most just under half the smallest side). Its top may be scaled (sx, sz) and moved (dx, dz), the rows of
 * points between following linearly (a tapered head, a toe). 44 triangles: 6 faces, 12 bevels, 8 corners. Each bevel
 * and corner takes the uvs of the box face it is projected on — front and back first, then the sides, then top and
 * bottom — so a picture painted on a face runs out over its edges. `cb` cuts the bottom four corners less (or more)
 * than the top four: a head rounded at the crown with a small bevel under the chin (a wide one faces the ground and
 * reads as a shadow).
 * @param {{ w?: number, h?: number, d?: number, c?: number, cb?: number, smooth?: boolean,
 *   top?: { sx?: number, sz?: number, dx?: number, dz?: number } }} [o]
 * @returns {Geo}
 */
export function chamferBox({ w = 1, h = 1, d = 1, c = 0.1, cb = c, smooth = false, top = {} } = {}) {
  if (SHAPE === 'block') {
    // a block's box has square edges (a hair of a chamfer keeps its twenty-six faces, their groups and their uvs)
    c = 1e-4;
    cb = 1e-4;
  }
  const most = Math.min(w, h, d) / 2 - 1e-4;
  const cTop = Math.max(0, Math.min(c, most));
  const cBot = Math.max(0, Math.min(cb, most));
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const tsx = top.sx ?? 1;
  const tsz = top.sz ?? tsx;
  const tdx = top.dx ?? 0;
  const tdz = top.dz ?? 0;
  /** a corner point: on the face across `axis` (0 x, 1 y, 2 z) at the corner of signs s */
  const P = (axis, sx, sy, sz) => {
    const cc = sy > 0 ? cTop : cBot;
    return /** @type {Vec3} */ ([sx * (axis === 0 ? hw : hw - cc), sy * (axis === 1 ? hh : hh - cc), sz * (axis === 2 ? hd : hd - cc)]);
  };
  /** the taper: the top scaled and moved, the rows between in proportion */
  const bend = (p) => {
    const t = (p[1] + hh) / h;
    return /** @type {Vec3} */ ([p[0] * (1 + (tsx - 1) * t) + tdx * t, p[1], p[2] * (1 + (tsz - 1) * t) + tdz * t]);
  };
  /** @type {{ pts: Vec3[], axes: number[], face: number }[]} */
  const polys = [];
  const S = [-1, 1];
  const add = (corners, face) => {
    const pts = corners.map((q) => q.p);
    const ordered = outward(pts, [0, 0, 0]) === pts ? corners : [...corners].reverse();
    polys.push({ pts: ordered.map((q) => q.p), axes: ordered.map((q) => q.axis), face });
  };
  const q = (axis, sx, sy, sz) => ({ p: P(axis, sx, sy, sz), axis, sx, sy, sz });
  // the faces
  for (const s of S) {
    add([q(0, s, -1, -1), q(0, s, 1, -1), q(0, s, 1, 1), q(0, s, -1, 1)], s > 0 ? 0 : 1);
    add([q(1, -1, s, -1), q(1, 1, s, -1), q(1, 1, s, 1), q(1, -1, s, 1)], s > 0 ? 2 : 3);
    add([q(2, -1, -1, s), q(2, 1, -1, s), q(2, 1, 1, s), q(2, -1, 1, s)], s > 0 ? 4 : 5);
  }
  // the bevels: x–y edges belong to the sides, y–z and x–z edges to the front and back
  for (const a of S) {
    for (const bb of S) {
      add([q(0, a, bb, -1), q(0, a, bb, 1), q(1, a, bb, 1), q(1, a, bb, -1)], a > 0 ? 0 : 1);
      add([q(1, -1, a, bb), q(1, 1, a, bb), q(2, 1, a, bb), q(2, -1, a, bb)], bb > 0 ? 4 : 5);
      add([q(0, a, -1, bb), q(0, a, 1, bb), q(2, a, 1, bb), q(2, a, -1, bb)], bb > 0 ? 4 : 5);
    }
  }
  // the corners
  for (const sx of S) for (const sy of S) for (const sz of S) add([q(0, sx, sy, sz), q(1, sx, sy, sz), q(2, sx, sy, sz)], sz > 0 ? 4 : 5);
  // the faces' own normals after the taper (a smooth vertex takes the normal of the face its point lies on)
  const faceNormal = (axis, sign) => {
    const pts = axis === 0 ? [P(0, sign, -1, -1), P(0, sign, 1, -1), P(0, sign, 1, 1), P(0, sign, -1, 1)]
      : axis === 1 ? [P(1, -1, sign, -1), P(1, 1, sign, -1), P(1, 1, sign, 1), P(1, -1, sign, 1)]
        : [P(2, -1, -1, sign), P(2, 1, -1, sign), P(2, 1, 1, sign), P(2, -1, 1, sign)];
    return unit(newell(outward(pts, [0, 0, 0]).map(bend)));
  };
  const FN = [0, 1, 2].map((axis) => [faceNormal(axis, -1), faceNormal(axis, 1)]);
  const b = new Builder();
  for (const poly of polys) {
    const uvs = poly.pts.map((p) => boxUV(p, poly.face, w, h, d));
    const N = smooth ? poly.pts.map((p, k) => FN[poly.axes[k]][p[poly.axes[k]] > 0 ? 1 : 0]) : null;
    b.poly(poly.pts.map(bend), uvs, poly.face, N);
  }
  return b.done('box');
}

/**
 * A wedge on its base (y = 0): a w × d rectangle rising to a ridge along x at height h, the ridge `ridge` of the way
 * from the middle to the back (+1) or the front (−1) edge and `sx` of the base's width (0: a point — a pyramid with a
 * rectangular base). Noses, ears, beaks, fins, leaves. Its faces take box uvs (by the way they face) of its bounding
 * box, so any 6-face skin fits it. At most 8 triangles.
 * @param {{ w?: number, h?: number, d?: number, ridge?: number, sx?: number }} [o]
 * @returns {Geo}
 */
export function wedge({ w = 1, h = 1, d = 1, ridge = 0, sx = 1 } = {}) {
  const hw = w / 2;
  const hd = d / 2;
  const rz = ridge * hd;
  const rw = sx * hw;
  /** @type {Vec3[]} */
  const base = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]];
  /** @type {Vec3} */
  const rl = [-rw, h, rz];
  /** @type {Vec3} */
  const rr = [rw, h, rz];
  const inside = [0, h / 4, rz / 2];
  const faces = [
    [base[0], base[1], base[2], base[3]],
    [base[0], base[1], rr, rl],
    [base[3], base[2], rr, rl],
    [base[0], base[3], rl],
    [base[1], base[2], rr],
  ];
  const b = new Builder();
  for (const f of faces) {
    const pts = /** @type {Vec3[]} */ (outward(f, inside));
    const face = faceOf(newell(pts));
    // box uvs in the bounding box, measured from its middle (y from h/2)
    b.poly(pts, pts.map((p) => boxUV([p[0], p[1] - h / 2, p[2]], face, w, h || 1, d)), face);
  }
  return b.done('box');
}

// ---------------------------------------------------------------------------------------------------
// Matrices (column-major 4 × 4, three's layout) and placing geometries
// ---------------------------------------------------------------------------------------------------

/** @returns {Float64Array} */
export function identity() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a × b (b first, then a). @param {Mat4} a @param {Mat4} b @returns {Float64Array} */
export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** @returns {Float64Array} */
export function translation(x, y, z) {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** A turn of `a` radians about axis 0 (x), 1 (y) or 2 (z), right-handed. @returns {Float64Array} */
export function rotation(axis, a) {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
  m[i * 4 + i] = c;
  m[j * 4 + j] = c;
  m[i * 4 + j] = s;
  m[j * 4 + i] = -s;
  return m;
}

/** @returns {Float64Array} */
export function scaling(x, y = x, z = x) {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/**
 * A placement: scale `s`, then turn `r` (Euler angles, three's convention: order 'XYZ' is Rx · Ry · Rz), then move `t`.
 * @param {{ t?: number[], r?: number[], s?: number|number[], order?: string }} o
 * @returns {Float64Array}
 */
export function compose({ t = [0, 0, 0], r = [0, 0, 0], s = 1, order = 'XYZ' } = {}) {
  let R = identity();
  for (const ch of order) {
    const axis = 'XYZ'.indexOf(ch);
    R = mul(R, rotation(axis, r[axis] ?? 0));
  }
  const S = typeof s === 'number' ? scaling(s) : scaling(s[0], s[1] ?? s[0], s[2] ?? s[0]);
  return mul(translation(t[0], t[1], t[2]), mul(R, S));
}

/**
 * The frame of a part laid from `from` toward `to`: its +y along the segment, origin at `from`, its +z as near the
 * hint `back` as that allows (so a limb's front, −z, stays toward the model's front), turned `roll` about its length.
 * Build the part `|to − from|` long on +y and transform it by this.
 * @param {number[]} from
 * @param {number[]} to
 * @param {{ back?: number[], roll?: number }} [o]
 * @returns {Float64Array}
 */
export function alongSegment(from, to, { back = [0, 0, 1], roll = 0 } = {}) {
  const Y = unit([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  let ref = back;
  let dot = ref[0] * Y[0] + ref[1] * Y[1] + ref[2] * Y[2];
  if (Math.abs(dot) > 0.999) {
    ref = [0, -1, 0];
    dot = -Y[1];
  }
  let Z = unit([ref[0] - dot * Y[0], ref[1] - dot * Y[1], ref[2] - dot * Y[2]]);
  let X = /** @type {Vec3} */ ([Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]]);
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const X2 = /** @type {Vec3} */ ([X[0] * c - Z[0] * s, X[1] * c - Z[1] * s, X[2] * c - Z[2] * s]);
    Z = /** @type {Vec3} */ ([X[0] * s + Z[0] * c, X[1] * s + Z[1] * c, X[2] * s + Z[2] * c]);
    X = X2;
  }
  const m = identity();
  m.set([X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, from[0], from[1], from[2], 1]);
  return m;
}

/**
 * A copy of `geo` placed by matrix `m` (positions by m, normals by its inverse transpose); a mirroring matrix keeps the
 * triangles wound outward.
 * @param {Geo} geo
 * @param {Mat4|{ t?: number[], r?: number[], s?: number|number[], order?: string }} m
 * @returns {Geo}
 */
export function transform(geo, m) {
  const M = Array.isArray(m) || ArrayBuffer.isView(m) ? /** @type {Mat4} */ (m) : compose(/** @type {*} */ (m));
  const a = M[0], b = M[4], c = M[8];
  const d = M[1], e = M[5], f = M[9];
  const g = M[2], h = M[6], i = M[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // the inverse transpose of the 3 × 3 (cofactors / det)
  const k = Math.abs(det) > 1e-30 ? 1 / det : 0;
  const n00 = (e * i - f * h) * k, n01 = -(d * i - f * g) * k, n02 = (d * h - e * g) * k;
  const n10 = -(b * i - c * h) * k, n11 = (a * i - c * g) * k, n12 = -(a * h - b * g) * k;
  const n20 = (b * f - c * e) * k, n21 = -(a * f - c * d) * k, n22 = (a * e - b * d) * k;
  const P = new Float32Array(geo.positions.length);
  const N = new Float32Array(geo.normals.length);
  for (let v = 0; v < P.length; v += 3) {
    const x = geo.positions[v], y = geo.positions[v + 1], z = geo.positions[v + 2];
    P[v] = a * x + b * y + c * z + M[12];
    P[v + 1] = d * x + e * y + f * z + M[13];
    P[v + 2] = g * x + h * y + i * z + M[14];
    const nx = geo.normals[v], ny = geo.normals[v + 1], nz = geo.normals[v + 2];
    const ox = n00 * nx + n01 * ny + n02 * nz;
    const oy = n10 * nx + n11 * ny + n12 * nz;
    const oz = n20 * nx + n21 * ny + n22 * nz;
    const l = Math.hypot(ox, oy, oz) || 1;
    N[v] = ox / l;
    N[v + 1] = oy / l;
    N[v + 2] = oz / l;
  }
  const I = new Uint32Array(geo.index);
  if (det < 0) for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
  return { positions: P, normals: N, uvs: new Float32Array(geo.uvs), groups: new Uint8Array(geo.groups), index: I, kind: geo.kind };
}

/**
 * Several geometries as one.
 * @param {Geo[]} geos
 * @returns {Geo}
 */
export function merge(geos) {
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    nv += g.positions.length / 3;
    ni += g.index.length;
  }
  const P = new Float32Array(nv * 3);
  const N = new Float32Array(nv * 3);
  const U = new Float32Array(nv * 2);
  const G = new Uint8Array(nv);
  const I = new Uint32Array(ni);
  let ov = 0;
  let oi = 0;
  const kinds = new Set(geos.map((g) => g.kind));
  for (const g of geos) {
    P.set(g.positions, ov * 3);
    N.set(g.normals, ov * 3);
    U.set(g.uvs, ov * 2);
    G.set(g.groups, ov);
    for (let t = 0; t < g.index.length; t++) I[oi + t] = g.index[t] + ov;
    ov += g.positions.length / 3;
    oi += g.index.length;
  }
  return { positions: P, normals: N, uvs: U, groups: G, index: I, kind: kinds.size === 1 ? geos[0].kind : 'mixed' };
}

/**
 * A copy of `geo` with its uvs moved onto a texture atlas: a vertex of group g lands in `rects(g)` — [x, y, w, h] in
 * atlas pixels, row 0 at the top — its face's v = 1 at the rectangle's top. The result's uvs are atlas uvs (u right,
 * v down the rows: a DataTexture with flipY off, the game's skins' convention).
 * @param {Geo} geo
 * @param {(group: number) => number[]} rects
 * @param {number} W  atlas width
 * @param {number} H  atlas height
 * @returns {Geo}
 */
export function atlasUV(geo, rects, W, H) {
  const U = new Float32Array(geo.uvs.length);
  for (let v = 0; v < geo.groups.length; v++) {
    const [x, y, w, h] = rects(geo.groups[v]);
    U[v * 2] = (x + geo.uvs[v * 2] * w) / W;
    U[v * 2 + 1] = (y + (1 - geo.uvs[v * 2 + 1]) * h) / H;
  }
  return { ...geo, uvs: U };
}

/** @param {Geo} geo @returns {number} */
export function triangleCount(geo) {
  return geo.index.length / 3;
}

/** The geometry's bounds. @param {Geo} geo @returns {{ min: Vec3, max: Vec3 }} */
export function bounds(geo) {
  const min = /** @type {Vec3} */ ([Infinity, Infinity, Infinity]);
  const max = /** @type {Vec3} */ ([-Infinity, -Infinity, -Infinity]);
  for (let v = 0; v < geo.positions.length; v += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], geo.positions[v + a]);
      max[a] = Math.max(max[a], geo.positions[v + a]);
    }
  }
  return { min, max };
}
