// Caelancraft — the plant kit: what every plant model is built of (PURE: typed arrays, no three, no DOM). See
// src/CONTRACTS.md §102 and docs/DESIGN-characters.md (phase 4).
//
// A plant is never a ball of leaves: it is faceted STEMS and BRANCHES (hexagonal columns, thin ones four-sided) that
// carry LEAF CARDS in whorls and tiers with gaps between them — each card a flat hexagon (or a diamond) pointed at both
// ends, folded a little along its midrib so its two halves catch the light differently — with BLADES (tapering ribbons
// that arch out, for grass and reeds), FRONDS (cut-out pictures on a bending strip, for ferns and lacy leaves), DISCS (a
// flower's face, a hemlock's plate), GEMS and BALLS (berries, apples, bulbs) and faceted SOLIDS (a mushroom's cap, a
// cactus pad, an aloe's thick leaf). Every part is painted from the plant atlas (plantAtlas.js); a card is one-sided
// geometry the cutout material draws from both sides.
//
// The same recipe builds every level of detail: a Plant knows its `lod` (PLANT_LOD_NEAR, PLANT_LOD_FAR) and its helpers
// thin themselves out far away — a whorl keeps a third of its leaves, bigger, as diamonds; a stem has three sides; a blade
// is one triangle — so the far plant is the near one's shape at about a tenth of the triangles. `bare` builds a picked
// plant: parts marked `fruit` are left out AFTER the recipe has run, so the picked plant is the same plant, leaf for leaf.
//
// compile() turns the parts into the mesher's form: PLANT_STRIDE floats a vertex (x, y, z in metres from the middle of
// the cell's floor; the unit normal; the atlas u, v; a SHADE) and Uint16 indices, counter-clockwise from outside. The
// shade is baked light the cell's own light and the sun then multiply: an openness term (the inside and the foot of a
// plant are darker, its outer top is fully lit), a gentle term from how the face looks up or down (both sides of a card
// alike), and a contact darkening on the ground.
import { loft, transform, mul, translation, rotation, scaling, alongSegment } from './modelKit.js';
import { plantRect, PLANT_ATLAS_W, PLANT_ATLAS_H } from './plantAtlas.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./modelKit.js').Mat4} Mat4 */
/** @typedef {[number, number, number]} Vec3 */

/** Levels of detail: the full model, the cheap leafy one, the crossed picture (plantModels.js builds that one). */
export const PLANT_LOD_NEAR = 0;
export const PLANT_LOD_FAR = 1;
export const PLANT_LOD_CARD = 2;

/** Floats per compiled vertex: x, y, z, nx, ny, nz, u, v, shade. */
export const PLANT_STRIDE = 9;

/**
 * @typedef {Object} CompiledPlant  a plant model as the chunk mesher copies it
 * @property {Float32Array} data    PLANT_STRIDE floats per vertex
 * @property {Uint16Array} index    three per triangle, counter-clockwise seen from the normal's side
 * @property {number} verts
 * @property {number} tris
 * @property {boolean} block        its uvs are in the BLOCK atlas (the crossed picture), not the plant atlas
 * @property {string[]} keys        the pictures its parts are painted with
 * @property {Uint8Array} vkey      each vertex's picture (a solid's cap its own), an index into `keys`
 * @property {Uint8Array} vfruit    1 for a vertex of a `fruit` part (a picked plant has none)
 * @property {number} height        its top, metres
 * @property {number} reach         its farthest point from the middle, metres
 */

const EPS = 1e-9;

/** @param {number[]} v @returns {Vec3} */
function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > EPS ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}
/** @param {number[]} a @param {number[]} b @returns {Vec3} */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b @returns {Vec3} */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {number[]} a @param {number} k @returns {Vec3} */
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** @param {number[]} a @param {number[]} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * modelKit.alongSegment, safe for any hint: the frame of a part laid from a to b, its +z as near `back` as the segment
 * allows — and when the segment runs (nearly) along `back` itself, as near a hint across it (+z, else +x), so a part
 * standing straight up never collapses to nothing.
 * @param {number[]} a @param {number[]} b @param {number[]} back @param {number} [roll]
 */
export function frame(a, b, back, roll = 0) {
  const d = unit(sub(b, a));
  const hint = unit(back);
  let use = hint;
  if (Math.abs(d[0] * hint[0] + d[1] * hint[1] + d[2] * hint[2]) > 0.98) use = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return alongSegment(a, b, { back: use, roll });
}

/** The way round angle `a` (radians) and up `tilt` from level: a unit direction. @returns {Vec3} */
export function dirAt(a, tilt) {
  return [Math.cos(a) * Math.cos(tilt), Math.sin(tilt), Math.sin(a) * Math.cos(tilt)];
}

/** A seeded generator in [0, 1) (mulberry32). @param {number} seed */
export function plantRng(seed) {
  let s = (seed | 0) ^ 0x2f6b9d1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Polygons into one geometry (each its own vertices, a flat normal; fanned from its first corner). */
class Polys {
  constructor() {
    /** @type {number[]} */ this.p = [];
    /** @type {number[]} */ this.n = [];
    /** @type {number[]} */ this.uv = [];
    /** @type {number[]} */ this.i = [];
  }

  /** A convex polygon, counter-clockwise from its face side, uvs in [0, 1] of its picture (v up). */
  poly(pts, uvs) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const n = unit([nx, ny, nz]);
    const base = this.p.length / 3;
    for (let k = 0; k < pts.length; k++) {
      this.p.push(pts[k][0], pts[k][1], pts[k][2]);
      this.n.push(n[0], n[1], n[2]);
      this.uv.push(uvs[k][0], uvs[k][1]);
    }
    for (let k = 1; k < pts.length - 1; k++) this.i.push(base, base + k, base + k + 1);
    return this;
  }

  /** @returns {Geo} */
  done() {
    return {
      positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv),
      groups: new Uint8Array(this.p.length / 3), index: new Uint32Array(this.i), kind: 'wrap',
    };
  }
}

/**
 * The outline of a leaf card from its stalk (0, 0) to its tip (0, len): the half-width (a share of `wid / 2`) at two
 * stations up it (a share of `len`), by shape. A diamond has one station.
 */
const LEAF_SHAPES = Object.freeze({
  hex: [[0.3, 1], [0.68, 0.86]],
  round: [[0.24, 1], [0.72, 0.9]],
  lance: [[0.22, 1], [0.58, 0.62]],
  heart: [[0.16, 1], [0.55, 0.78]],
  diamond: [[0.45, 1]],
});

/**
 * A leaf card in its own frame: stalk at the origin, its length along +y, its upper face toward +z; folded along its
 * midrib by `fold` (its edges raised toward +z by that share of its half-width), so its halves are two facets.
 * @param {keyof typeof LEAF_SHAPES} shape @param {number} len @param {number} wid @param {number} [fold]
 * @returns {Geo}
 */
export function leafGeo(shape, len, wid, fold = 0.28) {
  const st = LEAF_SHAPES[shape];
  const hw = wid / 2;
  const right = st.map(([t, k]) => [hw * k, len * t, hw * k * fold]);
  const left = st.map(([t, k]) => [-hw * k, len * t, hw * k * fold]);
  const base = [0, 0, 0];
  const tip = [0, len, 0];
  const uv = (p) => [0.5 + p[0] / wid, p[1] / len];
  const g = new Polys();
  const R = [base, ...right, tip];
  const L = [base, tip, ...left.slice().reverse()];
  g.poly(R, R.map(uv));
  g.poly(L, L.map(uv));
  return g.done();
}

/**
 * A ribbon along a centre line: `pts` its points, `side` a unit vector across it at each, `half` its half-width at each
 * (0: a point). Its face is toward cross(along, side). uv: u across (0..1), v along (0 at the first point, 1 at the last).
 * @param {number[][]} pts @param {number[][]} side @param {number[]} half
 * @returns {Geo}
 */
export function ribbonGeo(pts, side, half) {
  const g = new Polys();
  const n = pts.length;
  for (let k = 0; k < n - 1; k++) {
    const v0 = k / (n - 1);
    const v1 = (k + 1) / (n - 1);
    const a0 = add(pts[k], scale(side[k], half[k]));
    const b0 = sub(pts[k], scale(side[k], half[k]));
    const a1 = add(pts[k + 1], scale(side[k + 1], half[k + 1]));
    const b1 = sub(pts[k + 1], scale(side[k + 1], half[k + 1]));
    if (half[k + 1] < 1e-6) g.poly([b0, a0, pts[k + 1]], [[0, v0], [1, v0], [0.5, v1]]);
    else if (half[k] < 1e-6) g.poly([pts[k], a1, b1], [[0.5, v0], [1, v1], [0, v1]]);
    else g.poly([b0, a0, a1, b1], [[0, v0], [1, v0], [1, v1], [0, v1]]);
  }
  return g.done();
}

/**
 * A curved centre line from `base`: it sets off along `dir`, turns `bend` radians in total toward `toward` (any vector;
 * only its part across the line counts) evenly over `segs` segments, `len` long in all.
 * @param {number[]} base @param {number[]} dir @param {number[]} toward @param {number} len @param {number} bend @param {number} segs
 * @returns {{ pts: number[][], side: number[][] }}  its points and the unit vector across it (perpendicular to the bending plane)
 */
export function curve(base, dir, toward, len, bend, segs) {
  const d0 = unit(dir);
  let t = sub(toward, scale(d0, toward[0] * d0[0] + toward[1] * d0[1] + toward[2] * d0[2]));
  if (Math.hypot(t[0], t[1], t[2]) < 1e-6) t = Math.abs(d0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t0 = unit(t);
  const across = unit(cross(d0, t0));
  const pts = [base];
  const side = [across];
  let p = base;
  const step = len / segs;
  for (let k = 0; k < segs; k++) {
    const a = bend * ((k + 0.5) / segs);
    const d = add(scale(d0, Math.cos(a)), scale(t0, Math.sin(a)));
    p = add(p, scale(d, step));
    pts.push(p);
    side.push(across);
  }
  return { pts, side };
}

/** A flat n-gon facing +y, radius r, its centre raised `dome`: a flower's face, a plate of florets. @returns {Geo} */
export function discGeo(r, sides = 6, dome = 0) {
  const g = new Polys();
  const c = [0, dome, 0];
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, 0, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, 0, Math.sin(a1) * r];
    const uv = (p) => [0.5 + p[0] / (2 * r), 0.5 - p[2] / (2 * r)];
    g.poly([c, p1, p0], [[0.5, 0.5], uv(p1), uv(p0)]);
  }
  return g.done();
}

/** Join several geometries' polygons (no uv remapping). @param {Geo[]} geos @returns {Geo} */
function joinGeos(geos) {
  const g = new Polys();
  for (const s of geos) {
    const base = g.p.length / 3;
    g.p.push(...s.positions);
    g.n.push(...s.normals);
    g.uv.push(...s.uvs);
    for (const i of s.index) g.i.push(base + i);
  }
  return g.done();
}

/**
 * @typedef {Object} PartOpts
 * @property {boolean} [fruit]   left off a picked plant
 * @property {number} [lift]     the least shade its vertices get (a berry, a flower: bright among the leaves)
 * @property {string} [top]      a solid's top cap's picture (default the part's own)
 * @property {string} [bottom]   its bottom cap's picture
 * @property {boolean} [card]    a one-sided card (its shade from how it lies, both sides alike)
 * @property {number} [soft]      a solid whose normals lean this far (0..1) toward the plant's outside and up: a thick
 *                                leaf or a pad lit as a soft mass, not as a stone
 */

/**
 * @typedef {{ geo: Geo, key: string, keys3: string[], fruit: boolean, lift: number, card: boolean, soft: number }} Part
 *   `keys3` the pictures of its groups (a solid's sides, top cap, bottom cap)
 */

/**
 * One plant being built. A recipe calls its helpers with `this.far` choosing how much to make; compile() bakes it.
 */
export class Plant {
  /**
   * @param {number} lod  PLANT_LOD_NEAR or PLANT_LOD_FAR
   * @param {boolean} bare  a picked plant (its fruit left off)
   * @param {number} seed
   */
  constructor(lod, bare, seed) {
    this.lod = lod;
    this.far = lod === PLANT_LOD_FAR;
    this.bare = bare;
    this.rnd = plantRng(seed);
    /** @type {Part[]} */
    this.parts = [];
  }

  /** A number in [lo, hi). */
  range(lo, hi) {
    return lo + (hi - lo) * this.rnd();
  }

  /** ±k. */
  jit(k) {
    return (this.rnd() * 2 - 1) * k;
  }

  /**
   * Put a geometry (uvs in [0, 1] of its face; a loft's caps groups 1 and 2) on picture `key`, placed by M.
   * @param {Geo} geo @param {string} key @param {Mat4|null} [M] @param {PartOpts} [o]
   */
  put(geo, key, M = null, { fruit = false, lift = 0, top, bottom, card = false, soft = 0 } = {}) {
    const keys3 = [key, top ?? key, bottom ?? key];
    const rects = keys3.map(plantRect);
    const U = new Float32Array(geo.uvs.length);
    for (let v = 0; v < geo.groups.length; v++) {
      const [x, y, w, h] = rects[Math.min(2, geo.groups[v])];
      U[v * 2] = (x + clampUV(geo.uvs[v * 2]) * w) / PLANT_ATLAS_W;
      U[v * 2 + 1] = (y + (1 - clampUV(geo.uvs[v * 2 + 1])) * h) / PLANT_ATLAS_H;
    }
    const g = { ...geo, uvs: U };
    this.parts.push({ geo: M ? transform(g, M) : g, key, keys3, fruit, lift, card, soft });
  }

  // ---- stems ---------------------------------------------------------------------------------------------------------

  /**
   * A stem or a branch: a faceted column from a to b, radius r0 at a and r1 at b (six sides when it is thick, four when
   * thin; three far away), no caps unless asked.
   * @param {number[]} a @param {number[]} b @param {number} r0 @param {number} [r1] @param {string} [key]
   * @param {{ sides?: number, caps?: boolean|{ top?: boolean, bottom?: boolean }, top?: string, fruit?: boolean, rings?: number[][] }} [o]
   */
  stem(a, b, r0, r1 = r0 * 0.7, key = 'bark', o = {}) {
    const L = dist(a, b);
    if (L < 1e-5) return;
    const sides = this.far ? 3 : (o.sides ?? (r0 >= 0.012 ? 6 : 4));
    // extra rings [share of the length, radius share] bulge or pinch it on the way
    const mid = (o.rings ?? []).map(([t, k]) => ({ y: L * t, sx: (k * (r0 + (r1 - r0) * t)) / r0 }));
    const rings = [{ y: 0, sx: 1 }, ...(this.far ? [] : mid), { y: L, sx: r1 / r0 }];
    const geo = loft({ sides, rx: r0, rz: r0, rings, phase: 0, caps: o.caps ?? false });
    this.put(geo, key, frame(a, b, [0, 1, 0]), { top: o.top, fruit: o.fruit });
  }

  /**
   * A bent stem through `pts` (a polyline), tapering from r0 to r1: one column per segment.
   * @param {number[][]} pts @param {number} r0 @param {number} r1 @param {string} [key] @param {{ sides?: number, fruit?: boolean }} [o]
   */
  stemPath(pts, r0, r1, key = 'bark', o = {}) {
    const n = pts.length - 1;
    const step = this.far ? Math.max(1, Math.ceil(n / 2)) : 1;
    for (let k = 0; k < n; k += step) {
      const e = Math.min(n, k + step);
      this.stem(pts[k], pts[e], r0 + ((r1 - r0) * k) / n, r0 + ((r1 - r0) * e) / n, key, o);
    }
  }

  // ---- leaves --------------------------------------------------------------------------------------------------------

  /**
   * One leaf card from `base` along `dir`, its upper face toward `up` as nearly as the direction allows, turned `roll`
   * about its length. Far away a hexagon becomes a diamond.
   * @param {number[]} base @param {number[]} dir @param {number} len @param {number} wid @param {string} key
   * @param {{ shape?: keyof typeof LEAF_SHAPES, up?: number[], roll?: number, fold?: number, fruit?: boolean, lift?: number }} [o]
   */
  leaf(base, dir, len, wid, key, o = {}) {
    const shape = this.far ? 'diamond' : (o.shape ?? 'hex');
    // never into the ground: a leaf that would droop below it is lifted till its tip rests just above it
    let d = unit(dir);
    if (base[1] + len * d[1] < 0.012) {
      const h = Math.hypot(d[0], d[2]) || 1;
      const sy = Math.max(-1, Math.min(1, (0.012 - base[1]) / len));
      const c = Math.sqrt(1 - sy * sy);
      d = [(d[0] / h) * c, sy, (d[2] / h) * c];
    }
    const tip = add(base, d);
    const M = frame(base, tip, o.up ?? [0, 1, 0], o.roll ?? 0);
    this.put(leafGeo(shape, len, wid, o.fold ?? 0.28), key, M, { fruit: o.fruit, lift: o.lift, card: true });
  }

  /**
   * A whorl: `n` leaves springing from `at` round the stem, tilted `tilt` up from level (negative: drooping), the first
   * at `yaw`, a little irregular; `keys` picks each one's picture in turn. Far away it keeps about a third of them, each
   * bigger by the square root of what it stands for (the same leafy area), as diamonds.
   * @param {number[]} at @param {number} n @param {number} len @param {number} wid @param {number} tilt @param {number} yaw
   * @param {string[]} keys
   * @param {{ shape?: keyof typeof LEAF_SHAPES, spread?: number, fold?: number, keep?: number, out?: number }} [o]
   */
  whorl(at, n, len, wid, tilt, yaw, keys, o = {}) {
    // draw every leaf's jitter first, so the near and the far plant use the random stream alike
    const jitters = [];
    for (let k = 0; k < n; k++) jitters.push([this.jit(0.28), this.jit(0.14), this.jit(0.4), this.range(0.88, 1.12)]);
    const count = this.far ? Math.max(1, Math.round(n * (o.keep ?? 0.34))) : n;
    const grow = this.far ? Math.min(1.75, Math.sqrt(n / count)) : 1;
    const spread = o.spread ?? 1;
    for (let k = 0; k < count; k++) {
      const j = jitters[Math.floor((k * n) / count)];
      const a = yaw + (k / count) * Math.PI * 2 * spread + j[0];
      const tl = tilt + j[1];
      const d = dirAt(a, tl);
      const base = add(at, scale(d, o.out ?? 0.006));
      this.leaf(base, d, len * j[3] * grow, wid * j[3] * grow, keys[k % keys.length], { shape: o.shape, roll: j[2] * 0.6, fold: o.fold });
    }
  }

  /**
   * A spray: `n` leaves stepping along a twig from `from` to `to`, turn by turn round it (the golden angle apart), each
   * leaning `splay` radians out from the twig toward the tip and a little up toward the light, the last one carrying the
   * twig on past its tip — how a shrub's twig holds its leaves (a whorl's leaves all spring from one point). Far away it
   * keeps about a quarter of them, bigger.
   * @param {number[]} from @param {number[]} to @param {number} n @param {number} len @param {number} wid @param {string[]} keys
   * @param {{ shape?: keyof typeof LEAF_SHAPES, splay?: number, keep?: number, phase?: number, fold?: number, lift?: number }} [o]
   */
  spray(from, to, n, len, wid, keys, o = {}) {
    const jitters = [];
    for (let k = 0; k < n; k++) jitters.push([this.jit(0.35), this.jit(0.2), this.jit(0.4), this.range(0.86, 1.1)]);
    const axis = unit(sub(to, from));
    // two vectors across the twig
    const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(axis, ref));
    const w = cross(axis, u);
    const count = this.far ? Math.max(1, Math.round(n * (o.keep ?? 0.25))) : n;
    const grow = this.far ? Math.min(1.8, Math.sqrt(n / count)) : 1;
    const splay = o.splay ?? 0.95;
    for (let k = 0; k < count; k++) {
      const kk = Math.floor((k * n) / count);
      const j = jitters[kk];
      const last = kk === n - 1;
      const t = n === 1 ? 1 : 0.15 + (0.85 * kk) / (n - 1);
      const at = add(from, scale(sub(to, from), t));
      const turn = (o.phase ?? 0) + kk * 2.39996 + j[0];
      const side = add(scale(u, Math.cos(turn)), scale(w, Math.sin(turn)));
      const sp = last ? 0.15 : splay + j[1];
      // out from the twig, and lifted a little toward the sky so the leaves face up
      let d = add(scale(axis, Math.cos(sp)), scale(side, Math.sin(sp)));
      d = unit(add(d, [0, o.lift ?? 0.35, 0]));
      const s = j[3] * grow * (last ? 0.9 : 1);
      this.leaf(at, d, len * s, wid * s, keys[kk % keys.length], { shape: o.shape, roll: j[2] * 0.5, fold: o.fold });
    }
  }

  // ---- blades and fronds -------------------------------------------------------------------------------------------

  /**
   * A blade: a ribbon from `base` that sets off along `dir`, arches `bend` radians outward (toward `toward`) and tapers
   * from `wid` to a point; `segs` segments near, one far away (a single triangle).
   * @param {number[]} base @param {number[]} dir @param {number[]} toward @param {number} len @param {number} wid @param {number} bend
   * @param {string} key @param {{ segs?: number, taper?: number, fruit?: boolean }} [o]
   */
  blade(base, dir, toward, len, wid, bend, key, o = {}) {
    const segs = this.far ? 1 : (o.segs ?? 3);
    const { pts, side } = curve(base, dir, toward, len, bend, segs);
    const taper = o.taper ?? 0;
    const half = pts.map((_, k) => {
      const t = k / segs;
      return k === segs && taper === 0 ? 0 : (wid / 2) * (1 - t * (1 - taper));
    });
    this.put(ribbonGeo(pts, side, half), key, null, { card: true, fruit: o.fruit });
  }

  /**
   * A frond: a cut-out picture on a strip `wid` wide from `base`, arching `bend` radians toward `toward`; `segs`
   * segments near (it bends smoothly), one or two far away.
   * @param {number[]} base @param {number[]} dir @param {number[]} toward @param {number} len @param {number} wid @param {number} bend
   * @param {string} key @param {{ segs?: number, fruit?: boolean, taper?: number }} [o]
   */
  frond(base, dir, toward, len, wid, bend, key, o = {}) {
    const segs = this.far ? Math.min(o.segs ?? 3, (o.segs ?? 3) > 2 ? 2 : 1) : (o.segs ?? 3);
    const { pts, side } = curve(base, dir, toward, len, bend, segs);
    const taper = o.taper ?? 1;
    const half = pts.map((_, k) => (wid / 2) * (1 - (k / segs) * (1 - taper)));
    this.put(ribbonGeo(pts, side, half), key, null, { card: true, fruit: o.fruit });
  }

  // ---- flowers and fruit -------------------------------------------------------------------------------------------

  /**
   * A flower's face (or a plate of florets): a flat n-gon of radius r at `at`, facing `face`.
   * @param {number[]} at @param {number[]} face @param {number} r @param {string} key
   * @param {{ sides?: number, dome?: number, fruit?: boolean, lift?: number, spin?: number }} [o]
   */
  disc(at, face, r, key, o = {}) {
    const sides = this.far ? Math.min(5, o.sides ?? 6) : (o.sides ?? 6);
    const M = frame(at, add(at, face), [0, 0, 1], o.spin ?? 0);
    this.put(discGeo(r, sides, o.dome ?? 0), key, M, { fruit: o.fruit, lift: o.lift ?? 0.85, card: true });
  }

  /**
   * A gem (a berry, a nut, a bud): a little faceted spindle from `at` along `dir`, `len` long and r round; four sides
   * near, three far away.
   * @param {number[]} at @param {number[]} dir @param {number} r @param {number} len @param {string} key
   * @param {{ sides?: number, fruit?: boolean, lift?: number, mid?: number }} [o]
   */
  gem(at, dir, r, len, key, o = {}) {
    const sides = this.far ? 3 : (o.sides ?? 4);
    const mid = o.mid ?? 0.5;
    const rings = this.far ? [{ y: 0, sx: 0 }, { y: len, sx: 0.8 }] : [{ y: 0, sx: 0 }, { y: len * mid, sx: 1 }, { y: len, sx: 0.45 }];
    const geo = loft({ sides, rx: r, rz: r, phase: 0, caps: { top: true, bottom: false }, rings });
    this.put(geo, key, frame(at, add(at, unit(dir)), [0, 1, 0]), { fruit: o.fruit, lift: o.lift ?? 0.75 });
  }

  /**
   * A ball (an apple, a bulb, a flower head): a faceted loft round `at`'s vertical through rings [height share, radius
   * share] (default a squat hexagonal ball); r its radius, h its height.
   * @param {number[]} at  its bottom
   * @param {number} r @param {number} h @param {string} key
   * @param {{ sides?: number, rings?: number[][], fruit?: boolean, lift?: number, top?: string, bottom?: string, tilt?: number[] }} [o]
   */
  ball(at, r, h, key, o = {}) {
    const sides = this.far ? Math.min(4, o.sides ?? 6) : (o.sides ?? 6);
    const shape = o.rings ?? [[0, 0.35], [0.3, 0.95], [0.7, 0.92], [1, 0.3]];
    const rings = (this.far ? [shape[0], shape[Math.floor(shape.length / 2)], shape[shape.length - 1]] : shape).map(([t, k]) => ({ y: h * t, sx: k }));
    const geo = loft({ sides, rx: r, rz: r, phase: 0, rings, caps: true });
    let M = translation(at[0], at[1], at[2]);
    if (o.tilt) M = mul(M, mul(rotation(0, o.tilt[0]), rotation(2, o.tilt[1])));
    this.put(geo, key, M, { fruit: o.fruit, lift: o.lift ?? 0, top: o.top, bottom: o.bottom });
  }

  /**
   * A faceted solid laid along a segment (a mushroom's cap, a cactus pad, an aloe leaf): `loft` options in its own frame
   * (y along the segment), placed from a toward b, its +z toward `back`.
   * @param {number[]} a @param {number[]} b @param {Parameters<typeof loft>[0]} lo @param {string} key
   * @param {PartOpts & { back?: number[], roll?: number, stretch?: boolean }} [o]
   */
  solid(a, b, lo, key, o = {}) {
    const geo = loft(lo);
    const M = frame(a, b, o.back ?? [0, 1, 0], o.roll ?? 0);
    this.put(geo, key, M, o);
  }

  /** Put a ready geometry (already in the plant's frame or placed by M). */
  geo(geo, key, M = null, o = {}) {
    this.put(geo, key, M, o);
  }

  // ---- compiling ---------------------------------------------------------------------------------------------------

  /**
   * The plant in the mesher's form, its shade baked (see the header). `centre` is the height its openness is measured
   * about (default half its top).
   * @param {{ open?: number, ground?: number }} [o]  `open` how much darker the inside is (0..1), `ground` the contact shade
   * @returns {CompiledPlant}
   */
  compile({ open = 0.32, ground = 0.82 } = {}) {
    const parts = this.parts.filter((p) => !(p.fruit && this.bare));
    /** @type {string[]} */
    const keys = [];
    let verts = 0;
    let tris = 0;
    let top = 0;
    let reach = 0;
    for (const p of parts) {
      verts += p.geo.positions.length / 3;
      tris += p.geo.index.length / 3;
      for (let v = 0; v < p.geo.positions.length; v += 3) {
        if (p.geo.positions[v + 1] < -0.02) throw new RangeError(`plant: a ${p.key} part reaches ${p.geo.positions[v + 1].toFixed(3)} m into the ground`);
        top = Math.max(top, p.geo.positions[v + 1]);
        reach = Math.max(reach, Math.hypot(p.geo.positions[v], p.geo.positions[v + 2]));
      }
      for (const k of p.keys3) if (!keys.includes(k)) keys.push(k);
    }
    if (verts > 65535) throw new RangeError(`plant: ${verts} vertices`);
    const data = new Float32Array(verts * PLANT_STRIDE);
    const index = new Uint16Array(tris * 3);
    const vkey = new Uint8Array(verts);
    const vfruit = new Uint8Array(verts);
    const H = Math.max(top, 0.05);
    const R = Math.max(reach, 0.05);
    let o = 0;
    let base = 0;
    let oi = 0;
    for (const p of parts) {
      const g = p.geo;
      const n = g.positions.length / 3;
      const ki = p.keys3.map((k) => keys.indexOf(k));
      for (let v = 0; v < n; v++) {
        const x = g.positions[v * 3];
        // a foot that leans dips a hair below the floor at its back: it stands on the floor instead
        const y = Math.max(0, g.positions[v * 3 + 1]);
        const z = g.positions[v * 3 + 2];
        let nx = g.normals[v * 3];
        let ny = g.normals[v * 3 + 1];
        let nz = g.normals[v * 3 + 2];
        // openness: the outer, upper parts of the plant are open to the sky, its inside and its foot are not
        const opn = Math.min(1, Math.max(0, 0.12 + 0.55 * (y / H) + 0.55 * (Math.hypot(x, z) / R)));
        let s = 1 - open * (1 - opn);
        if (p.card) {
          // a card is seen from both sides alike (the shader never turns a plant's normal round): the normal of its
          // upper side, leaning out of the plant, so foliage is lit as a whole, brighter on top and on the sunny side
          if (ny < 0) {
            nx = -nx; ny = -ny; nz = -nz;
          }
          let ox = x;
          let oy = (y - H * 0.4) * 0.8 + 0.25 * H;
          let oz = z;
          const ol = Math.hypot(ox, oy, oz) || 1;
          ox /= ol; oy /= ol; oz /= ol;
          const ax = nx * 0.55 + ox * 0.45;
          const ay = ny * 0.55 + oy * 0.45 + 0.12;
          const az = nz * 0.55 + oz * 0.45;
          const al = Math.hypot(ax, ay, az) || 1;
          nx = ax / al; ny = ay / al; nz = az / al;
        } else {
          // a solid's face: up brighter than down; a soft one's normal leans out of the plant and up
          s *= 0.82 + 0.18 * (0.5 + 0.5 * ny);
          if (p.soft > 0) {
            let ox = x;
            let oy = (y - H * 0.3) + 0.3 * H;
            let oz = z;
            const ol = Math.hypot(ox, oy, oz) || 1;
            ox /= ol; oy /= ol; oz /= ol;
            const ax = nx * (1 - p.soft) + ox * p.soft;
            const ay = ny * (1 - p.soft) + oy * p.soft;
            const az = nz * (1 - p.soft) + oz * p.soft;
            const al = Math.hypot(ax, ay, az) || 1;
            nx = ax / al; ny = ay / al; nz = az / al;
          }
        }
        if (y < 0.03) s *= ground;
        s = Math.max(s, p.lift);
        data[o++] = x; data[o++] = y; data[o++] = z;
        data[o++] = nx; data[o++] = ny; data[o++] = nz;
        data[o++] = g.uvs[v * 2]; data[o++] = g.uvs[v * 2 + 1];
        data[o++] = Math.min(1, s);
        vkey[base + v] = ki[Math.min(2, g.groups[v])];
        vfruit[base + v] = p.fruit ? 1 : 0;
      }
      for (let t = 0; t < g.index.length; t++) index[oi++] = g.index[t] + base;
      base += n;
    }
    return { data, index, verts, tris, block: false, keys, vkey, vfruit, height: top, reach };
  }
}

/** Keep a face uv a hair inside its picture (no texel of the gutter ever shows at a card's edge). */
function clampUV(u) {
  return u < 0.004 ? 0.004 : u > 0.996 ? 0.996 : u;
}

/** Several geometries as one (their uvs untouched). */
export { joinGeos };
/** Matrices a recipe may need. */
export { translation, rotation, scaling, mul, alongSegment };
/** Small vector helpers for the recipes. */
export const vec = Object.freeze({ add, sub, scale, cross, unit, dist });
