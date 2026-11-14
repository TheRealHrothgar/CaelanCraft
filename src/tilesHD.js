// Caelancraft — 32×32 painters for the world's blocks, several pictures each (CONTRACTS §90).
//
// PURE: no DOM, no three, no Math.random. Imports blocks.js (tile ids) and tileVariants.js only. Every picture is painted
// from a private mulberry32 stream seeded with fnv1a(`hd:<tile id>#<picture>`), so it never depends on the world seed
// and is bit-identical across runs. Output is a Uint8ClampedArray(32*32*4), RGBA, idx = (y*32 + x)*4, row 0 the
// world-up edge of a side face (flipY = false), like tiles.js at twice the size.
//
// How the pictures are drawn (the house style): a material is a height field (soft noise, cells of a Voronoi diagram,
// boards, bricks), lit from the top-left by an emboss of that field, then quantised onto a short palette of 5–7 shades
// with a light ordered dither, so it reads as chunky pixel art with depth rather than as photo noise. Two facts about
// the honeycomb shape the art:
//  - a SIDE face is HEX_SIZE (0.577) wide, so it shows the middle 58 % of the tile's width (x ≈ 7..25; the mesher may
//    slide that window up to 6 px either way for the materials that allow it, tileVariants.VARY_SHIFT). Details that
//    must be seen (ore nuggets, rivets) sit in the middle band; a block's only frame is its top and bottom rows.
//  - a CAP (top or bottom) is the pointy-top hexagon inscribed in the tile (corners at the middle of the top and bottom
//    edges, flat sides at x ≈ 2 and 30); log rings and pumpkin ribs follow that hexagon (hexDist).
// Tiles with no painter here are drawn by tiles.js at 16 px and doubled (atlas.js).
import { TILE as T } from './blocks.js';
import { VARIANT_TILES } from './tileVariants.js';

/** Pixels along each side of a picture. */
export const HD_PX = 32;
const N = HD_PX;
const NN = N * N;

// ---------------------------------------------------------------------------------------------------------------
// PRNG (private copies: tiles.js's mulberry32 and fnv1a)
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {() => number} Rng */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {string} name @param {number} v @returns {Rng} */
function rngFor(name, v) {
  return mulberry32(fnv1a(`hd:${name}#${v}`));
}

/** Uniform integer in [a, b]. */
function ri(rng, a, b) {
  return a + Math.floor(rng() * (b - a + 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Fields: Float32Array(N*N) of values, idx = y*N + x. Everything wraps, so a picture tiles with itself.
// ---------------------------------------------------------------------------------------------------------------

/** Wrap a pixel coordinate into 0..31 (N is a power of two, so a mask works for negatives too). */
const wrap = (v) => v & (N - 1);
const at = (x, y) => ((y & (N - 1)) << 5) | (x & (N - 1));

/** Smooth, tileable value noise with `cx` × `cy` lattice cells across the tile (cx, cy divide 32 best). 0..1. */
function noise(rng, cx, cy = cx) {
  const lat = new Float32Array(cx * cy);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  // Per column and per row: the two lattice indices and the smoothed weight (the inner loop is then lookups only).
  const xa = new Int32Array(N);
  const xb = new Int32Array(N);
  const tx = new Float32Array(N);
  axis(cx, xa, xb, tx);
  const ya = new Int32Array(N);
  const yb = new Int32Array(N);
  const ty = new Float32Array(N);
  axis(cy, ya, yb, ty);
  const out = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    const ra = ya[y] * cx;
    const rb = yb[y] * cx;
    const wy = ty[y];
    for (let x = 0; x < N; x++) {
      const a0 = lat[ra + xa[x]];
      const b0 = lat[rb + xa[x]];
      const a = a0 + (lat[ra + xb[x]] - a0) * tx[x];
      const b = b0 + (lat[rb + xb[x]] - b0) * tx[x];
      out[y * N + x] = a + (b - a) * wy;
    }
  }
  return out;
}

/** The lattice cells either side of each pixel along one axis of `cells` cells, and the smoothstep weight between them. */
function axis(cells, ia, ib, t) {
  for (let p = 0; p < N; p++) {
    const f = ((p + 0.5) / N) * cells - 0.5;
    const f0 = Math.floor(f);
    const w = f - f0;
    ia[p] = ((f0 % cells) + cells) % cells;
    ib[p] = (ia[p] + 1) % cells;
    t[p] = w * w * (3 - 2 * w);
  }
}

/** Rescale a field to exactly 0..1 (in place). */
function normalize(f) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo) lo = f[i];
    if (f[i] > hi) hi = f[i];
  }
  const s = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * s;
  return f;
}

/** Fractal sum of noise octaves [[cx, cy, weight], …], normalised to 0..1. */
function fbm(rng, octaves) {
  const out = new Float32Array(NN);
  for (const [cx, cy, w] of octaves) {
    const n = noise(rng, cx, cy);
    for (let i = 0; i < NN; i++) out[i] += n[i] * w;
  }
  return normalize(out);
}

/** Independent per-pixel values in -0.5..0.5. */
function grain(rng) {
  const out = new Float32Array(NN);
  for (let i = 0; i < NN; i++) out[i] = rng() - 0.5;
  return out;
}

/** `count` points spread over the tile (a jittered grid, so cells come out evenly sized). */
function scatter(rng, count) {
  const side = Math.ceil(Math.sqrt(count));
  const cells = [];
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) cells.push([i, j]);
  for (let i = cells.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [cells[i], cells[k]] = [cells[k], cells[i]];
  }
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const s = N / side;
  for (let p = 0; p < count; p++) {
    const [i, j] = cells[p];
    xs[p] = (i + 0.15 + rng() * 0.7) * s;
    ys[p] = (j + 0.15 + rng() * 0.7) * s;
  }
  return { xs, ys, count };
}

/**
 * Tileable Voronoi of `pts`, distances scaled by (sx, sy) (sx > 1 squeezes cells horizontally, so they come out tall).
 * @returns {{ id: Int16Array, f1: Float32Array, f2: Float32Array }}  nearest point, its distance, the second distance
 */
function voronoi(pts, sx = 1, sy = 1) {
  const id = new Int16Array(NN);
  const f1 = new Float32Array(NN);
  const f2 = new Float32Array(NN);
  const sx2 = sx * sx;
  const sy2 = sy * sy;
  const half = N / 2;
  const { xs, ys, count } = pts;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      let best = 0;
      for (let p = 0; p < count; p++) {
        let dx = x + 0.5 - xs[p];
        let dy = y + 0.5 - ys[p];
        if (dx > half) dx -= N;
        else if (dx < -half) dx += N;
        if (dy > half) dy -= N;
        else if (dy < -half) dy += N;
        const d = dx * dx * sx2 + dy * dy * sy2;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = p;
        } else if (d < d2) d2 = d;
      }
      const i = y * N + x;
      id[i] = best;
      f1[i] = Math.sqrt(d1);
      f2[i] = Math.sqrt(d2);
    }
  }
  return { id, f1, f2 };
}

/** Light from the top-left: how much higher the field is up-left of (x, y) than down-right of it. */
function emboss(h, x, y) {
  return h[at(x - 1, y - 1)] - h[at(x + 1, y + 1)];
}

/**
 * Distance from the tile's centre in the CAP's own hexagon: 0 at the centre, 1 on the inscribed pointy-top hexagon
 * (corners at the middle of the top and bottom edges), above 1 in the corners a cap never shows.
 */
function hexDist(x, y) {
  const u = Math.abs((x + 0.5) / N - 0.5);
  const v = Math.abs((y + 0.5) / N - 0.5);
  return Math.max(u, u * 0.5 + v * 0.8660254) / 0.4330127;
}

// ---------------------------------------------------------------------------------------------------------------
// Pixels and palettes. A palette is a list of 0xRRGGBB, darkest first; a tone is a position 0..1 along it.
// ---------------------------------------------------------------------------------------------------------------

/** 4×4 ordered dither offsets in -0.5..0.5. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((b) => (b + 0.5) / 16 - 0.5);

class Picture {
  constructor() {
    this.px = new Uint8ClampedArray(NN * 4);
  }

  /** Set pixel (x, y) (wrapped) to `hex`, alpha `a`. */
  set(x, y, hex, a = 255) {
    const i = at(x, y) * 4;
    this.px[i] = (hex >> 16) & 255;
    this.px[i + 1] = (hex >> 8) & 255;
    this.px[i + 2] = hex & 255;
    this.px[i + 3] = a;
  }

  /** @returns {number} 0xRRGGBB of pixel (x, y) (wrapped) */
  get(x, y) {
    const i = at(x, y) * 4;
    return (this.px[i] << 16) | (this.px[i + 1] << 8) | this.px[i + 2];
  }

  /** Multiply pixel (x, y)'s colour by `f` (alpha untouched). */
  scale(x, y, f) {
    const i = at(x, y) * 4;
    this.px[i] *= f;
    this.px[i + 1] *= f;
    this.px[i + 2] *= f;
  }

  alpha(x, y, a) {
    this.px[at(x, y) * 4 + 3] = a;
  }

  getAlpha(x, y) {
    return this.px[at(x, y) * 4 + 3];
  }

  /** Paint every pixel from tone field `f` on `pal`, dithered by `dither` palette steps. */
  tones(f, pal, dither = 0.6) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) this.set(x, y, tone(pal, f[y * N + x], x, y, dither));
  }
}

/** The palette shade for tone `t` at pixel (x, y), dithered by `dither` steps. */
function tone(pal, t, x = 0, y = 0, dither = 0) {
  const k = Math.floor(t * pal.length + BAYER[(y & 3) * 4 + (x & 3)] * dither);
  return pal[k < 0 ? 0 : k >= pal.length ? pal.length - 1 : k];
}

/** Mix two colours. */
function mix(a, b, t) {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Multiply a colour by `f` per channel ([fr, fg, fb] or one number), clamped. */
function mul(hex, f) {
  const [fr, fg, fb] = typeof f === 'number' ? [f, f, f] : f;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(((hex >> 16) & 255) * fr) << 16) | (c(((hex >> 8) & 255) * fg) << 8) | c((hex & 255) * fb);
}

/** A palette of `n` shades of `base`, from `lo`× to `hi`× its brightness (a touch warmer toward the light end). */
function shades(base, n, lo = 0.62, hi = 1.3, warm = 0.03) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    const f = lo + (hi - lo) * t;
    out.push(mul(base, [f * (1 + warm * (t - 0.5)), f, f * (1 - warm * (t - 0.5))]));
  }
  return out;
}

/** Clamp 0..1. */
const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A short random walk from (x, y): the pixels of a crack, a root or a vein. */
function walk(rng, x, y, steps, dx, dy) {
  const out = [];
  let px = x;
  let py = y;
  for (let s = 0; s < steps; s++) {
    out.push([px, py]);
    const r = rng();
    if (r < 0.55) {
      px += dx;
      py += dy;
    } else if (r < 0.78) px += dx || (rng() < 0.5 ? -1 : 1);
    else py += dy || (rng() < 0.5 ? -1 : 1);
  }
  return out;
}

/** A crack: dark pixels with a light lip under them (lit from the top-left). */
function crack(pic, rng, x, y, steps, dark, light) {
  const dx = rng() < 0.5 ? 1 : -1;
  const pts = walk(rng, x, y, steps, dx, 1);
  const seen = new Set(pts.map(([a, b]) => at(a, b)));
  for (const [a, b] of pts) if (!seen.has(at(a + 1, b + 1))) pic.set(a + 1, b + 1, light);
  for (const [a, b] of pts) pic.set(a, b, dark);
}

// ---------------------------------------------------------------------------------------------------------------
// Stone and its kin
// ---------------------------------------------------------------------------------------------------------------

const STONE = [0x4a4a4e, 0x58585c, 0x67676a, 0x757578, 0x838386, 0x919193, 0xa1a1a2];

/**
 * Rock: broad soft lumps lit from the top-left, faint fracture seams between facets, a few dark pits and light
 * flecks. `opts.cracks` adds hairline cracks; `opts.contrast` scales the lumps.
 */
function rock(pic, rng, pal, opts = {}) {
  const { contrast = 1, seams = 1, pits = 9, flecks = 6, cracks = 0, facets = 7 } = opts;
  const h = fbm(rng, [[2, 2, 0.4], [4, 4, 0.32], [8, 8, 0.18], [16, 16, 0.1]]);
  const v = voronoi(scatter(rng, facets));
  const facetTone = Array.from({ length: facets }, () => (rng() - 0.5) * 0.1);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let t = 0.5 + (h[i] - 0.5) * 0.34 * contrast + emboss(h, x, y) * 1.3 * contrast + facetTone[v.id[i]] + g[i] * 0.1;
      const e = v.f2[i] - v.f1[i];
      if (e < 1.1) t -= 0.12 * seams * (1.1 - e);
      f[i] = c01(t);
    }
  }
  pic.tones(f, pal);
  for (let k = 0; k < pits; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, pal[0]);
    if (rng() < 0.5) pic.set(x + 1, y, pal[1]);
  }
  for (let k = 0; k < flecks; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, pal[pal.length - 1]);
    pic.set(x + 1, y + 1, pal[1]);
  }
  for (let k = 0; k < cracks; k++) crack(pic, rng, ri(rng, 4, 27), ri(rng, 2, 14), ri(rng, 7, 13), pal[0], pal[pal.length - 2]);
}

function paintStone(pic, rng, v) {
  rock(pic, rng, STONE, { cracks: v === 3 ? 1 : 0 });
}

/**
 * Ore: the host rock, then `count` nuggets grown as small blobs in the middle band, each lit (light top-left edge, dark
 * bottom-right edge, one glint) and dropping a shadow on the rock below-right.
 * @param {number[]} ore4  [dark, mid, light, glint]
 */
function ore(pic, rng, v, ore4, count, size, hostPal = STONE) {
  rock(pic, rng, hostPal, { flecks: 3 });
  const owner = new Int16Array(NN).fill(-1);
  const blobs = [];
  for (let k = 0; k < count; k++) {
    const cx = ri(rng, 7, 24);
    const cy = ri(rng, 3, 28);
    const n = ri(rng, size[0], size[1]);
    const cells = [[cx, cy]];
    let guard = 0;
    while (cells.length < n && guard++ < 200) {
      const [x, y] = cells[Math.floor(rng() * cells.length)];
      const d = Math.floor(rng() * 4);
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 5 || nx > 26 || ny < 1 || ny > 30) continue;
      if (!cells.some(([a, b]) => a === nx && b === ny)) cells.push([nx, ny]);
    }
    blobs.push(cells);
    for (const [x, y] of cells) owner[at(x, y)] = k;
  }
  // Shadows first (on rock only), then the nuggets.
  for (let k = 0; k < blobs.length; k++) {
    for (const [x, y] of blobs[k]) {
      if (owner[at(x + 1, y + 1)] < 0) pic.scale(x + 1, y + 1, 0.62);
      if (owner[at(x + 1, y)] < 0) pic.scale(x + 1, y, 0.85);
    }
  }
  for (let k = 0; k < blobs.length; k++) {
    let glint = blobs[k][0];
    for (const [x, y] of blobs[k]) {
      const lit = owner[at(x - 1, y - 1)] !== k || owner[at(x, y - 1)] !== k;
      const dark = owner[at(x + 1, y + 1)] !== k && owner[at(x, y + 1)] !== k;
      pic.set(x, y, lit ? ore4[2] : dark ? ore4[0] : ore4[1]);
      if (x + y < glint[0] + glint[1]) glint = [x, y];
    }
    if (blobs[k].length >= 3) pic.set(glint[0], glint[1], ore4[3]);
  }
  if (v === 2) crack(pic, rng, ri(rng, 4, 27), ri(rng, 2, 10), ri(rng, 6, 10), STONE[0], STONE[5]);
}

const paintCoalOre = (pic, rng, v) => ore(pic, rng, v, [0x121214, 0x232326, 0x3a3a40, 0x76767e], 4, [6, 10]);
const paintIronOre = (pic, rng, v) => ore(pic, rng, v, [0x7a5038, 0xa77756, 0xd4a07c, 0xf4d4bc], 5, [3, 6]);
const paintGoldOre = (pic, rng, v) => ore(pic, rng, v, [0x9a7410, 0xd1a420, 0xf6d43e, 0xfff6b0], 5, [3, 6]);
const paintDiamondOre = (pic, rng, v) => ore(pic, rng, v, [0x147c84, 0x2db6be, 0x6ae8ec, 0xe6ffff], 4, [3, 6]);
const paintTinOre = (pic, rng, v) => ore(pic, rng, v, [0x6c7580, 0x9aa4ae, 0xc6ced6, 0xf2f6f8], 5, [3, 5]);
function paintCopperOre(pic, rng, v) {
  ore(pic, rng, v, [0x8a4626, 0xbf6a3a, 0xe69462, 0xffd2b0], 4, [3, 6]);
  // verdigris: a few green-blue specks on and beside the nuggets
  for (let k = 0; k < 7; k++) pic.set(ri(rng, 6, 25), ri(rng, 2, 29), rng() < 0.5 ? 0x3f9a74 : 0x62bf96);
}

const GRANITE_PINK = [0x8a5644, 0x9e6550, 0xb0755e, 0xc2876f];
const GRANITE_LIGHT = [0xb9a094, 0xcfb8ab, 0xe0cfc4];
const GRANITE_DARK = [0x4a3631, 0x5e463e];

/** Crystalline rock: small Voronoi crystals, each one mineral, with lit facet edges. */
function crystals(pic, rng, count, minerals) {
  const pts = scatter(rng, count);
  const v = voronoi(pts);
  const kind = [];
  const shade = [];
  for (let p = 0; p < count; p++) {
    let r = rng();
    let m = 0;
    while (m < minerals.length - 1 && r > minerals[m].share) r -= minerals[m].share, m++;
    kind.push(m);
    shade.push(rng());
  }
  const h = new Float32Array(NN);
  for (let i = 0; i < NN; i++) h[i] = Math.min(1, (v.f2[i] - v.f1[i]) / 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const p = v.id[i];
      const pal = minerals[kind[p]].pal;
      const t = c01(0.3 + shade[p] * 0.4 + emboss(h, x, y) * 0.7 - (v.f2[i] - v.f1[i] < 0.8 ? 0.15 : 0));
      pic.set(x, y, tone(pal, t, x, y, 0.5));
    }
  }
}

function paintGranite(pic, rng) {
  crystals(pic, rng, 64, [
    { share: 0.64, pal: GRANITE_PINK },
    { share: 0.27, pal: GRANITE_LIGHT },
    { share: 0.09, pal: GRANITE_DARK },
  ]);
}

function paintDiorite(pic, rng) {
  crystals(pic, rng, 60, [
    { share: 0.78, pal: [0x9d9d9b, 0xb2b2b0, 0xc5c5c3, 0xd8d8d6, 0xe8e8e6] },
    { share: 0.12, pal: [0x55555a, 0x66666b, 0x77777c] },
    { share: 0.1, pal: [0x7a7a7a, 0x8c8c8c] },
  ]);
}

function paintAndesite(pic, rng, v) {
  rock(pic, rng, [0x5f625f, 0x6c6f6c, 0x797c79, 0x878987, 0x949694, 0xa3a5a3], { facets: 5, pits: 18, flecks: 14, seams: 0.6, cracks: v === 2 ? 1 : 0 });
}

function paintSlate(pic, rng) {
  const pal = [0x2c3036, 0x353a41, 0x3f454c, 0x484e56, 0x525961, 0x5f666e];
  const n = fbm(rng, [[2, 8, 0.6], [4, 16, 0.4]]);
  const slope = (rng() - 0.5) * 0.12;
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const s = (y + x * slope + n[i] * 4) / 5.5;
      const layer = s - Math.floor(s);
      let t = 0.35 + (n[i] - 0.5) * 0.5 + g[i] * 0.08;
      if (layer < 0.14) t -= 0.25; // the cleavage line
      else if (layer < 0.3) t += 0.18; // the lit lip below it
      f[i] = c01(t);
    }
  }
  pic.tones(f, pal);
}

function paintObsidian(pic, rng, v) {
  const pal = [0x09060f, 0x100b1a, 0x171024, 0x201630, 0x2b1d40, 0x3b2958];
  const h = fbm(rng, [[2, 2, 0.5], [4, 4, 0.35], [8, 8, 0.15]]);
  const vor = voronoi(scatter(rng, 6));
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let t = 0.3 + (h[i] - 0.5) * 0.6 + emboss(h, x, y) * 2;
      const e = vor.f2[i] - vor.f1[i];
      if (e < 1.2) t += 0.35 * (1.2 - e); // glassy conchoidal ridges catch the light
      f[i] = c01(t);
    }
  }
  pic.tones(f, pal, 0.4);
  const glints = 3 + v;
  for (let k = 0; k < glints; k++) {
    const x = ri(rng, 4, 27);
    const y = ri(rng, 2, 29);
    pic.set(x, y, 0x9a7ae0);
    if (rng() < 0.6) pic.set(x + 1, y - 1, 0x5c45a0);
  }
}

function paintBedrock(pic, rng) {
  const pal = [0x161617, 0x262628, 0x38383a, 0x4c4c4e, 0x626264, 0x7a7a7c, 0x939395];
  const vor = voronoi(scatter(rng, 14));
  const tones = Array.from({ length: 14 }, () => rng());
  const h = new Float32Array(NN);
  for (let i = 0; i < NN; i++) h[i] = Math.min(1, (vor.f2[i] - vor.f1[i]) / 3.5) * (0.4 + tones[vor.id[i]] * 0.6);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) f[y * N + x] = c01(h[y * N + x] * 0.9 + emboss(h, x, y) * 1.4 + g[y * N + x] * 0.12);
  pic.tones(f, pal, 0.8);
}

function paintClay(pic, rng, v) {
  const pal = [0x7f8592, 0x8b919e, 0x979caa, 0xa2a7b4, 0xadb2bf, 0xb9bdc9];
  const h = fbm(rng, [[2, 2, 0.4], [4, 2, 0.3], [8, 4, 0.3]]);
  const smear = fbm(rng, [[2, 16, 1]]);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    f[i] = c01(0.5 + (h[i] - 0.5) * 0.6 + (smear[i] - 0.5) * 0.25 + emboss(h, x, y) * 1.5 + g[i] * 0.05);
  }
  pic.tones(f, pal, 0.5);
  for (let k = 0; k < 4 + v; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, 0x6e7380);
    pic.set(x - 1, y - 1, 0xc4c8d2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Soil: dirt, grass, sand, gravel, snow
// ---------------------------------------------------------------------------------------------------------------

const DIRT = [0x4c3322, 0x5c3f2a, 0x6c4b32, 0x7b573b, 0x8a6344, 0x99704f, 0xa97f5c];

/** A small stone half-buried in soil: a lit blob with a shadow under it. */
function pebble(pic, rng, x, y, w, h, pal3, shadow) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if ((i === 0 || i === w - 1) && (j === 0 || j === h - 1) && w > 2 && h > 1) continue; // round the corners
      pic.set(x + i, y + j, j === 0 || i === 0 ? pal3[2] : j === h - 1 || i === w - 1 ? pal3[0] : pal3[1]);
    }
  }
  for (let i = 0; i < w; i++) pic.set(x + i + 1, y + h, shadow);
}

function paintDirt(pic, rng, v) {
  const h = fbm(rng, [[4, 4, 0.45], [8, 8, 0.35], [16, 16, 0.2]]);
  const clods = voronoi(scatter(rng, 16));
  const clodTone = Array.from({ length: 16 }, () => (rng() - 0.5) * 0.1);
  const ch = new Float32Array(NN);
  for (let i = 0; i < NN; i++) ch[i] = Math.min(1, (clods.f2[i] - clods.f1[i]) / 2.5);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      f[i] = c01(0.5 + (h[i] - 0.5) * 0.4 + clodTone[clods.id[i]] + emboss(ch, x, y) * 0.16 + (ch[i] < 0.2 ? -0.05 : 0) + g[i] * 0.2);
    }
  }
  pic.tones(f, DIRT, 0.7);
  for (let k = 0; k < 18; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), DIRT[0]);
  for (let k = 0; k < 10; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), DIRT[6]);
  const stones = v === 2 ? 4 : 2;
  for (let k = 0; k < stones; k++) {
    pebble(pic, rng, ri(rng, 4, 25), ri(rng, 2, 27), ri(rng, 2, 3), 2, [0x6e675d, 0x8d867a, 0xaaa396], DIRT[0]);
  }
  if (v === 1) {
    // a root: a thin dark wandering line with a pale edge
    const pts = walk(rng, ri(rng, 6, 12), ri(rng, 4, 10), ri(rng, 12, 18), 1, 1);
    for (const [x, y] of pts) {
      pic.set(x, y, 0x3a2617);
      pic.set(x, y - 1, 0x8f6c4a);
    }
  }
}

/** The grass of the cap, as greens BEFORE the biome tint (the mesher multiplies grass tops by it). */
const GRASS_TOP = [0x2c5a1d, 0x386c24, 0x457f2b, 0x529132, 0x60a23a, 0x6eb244, 0x80c352];
/** The same greens under the plains tint, baked into the side's overhang (sides are not tinted). */
const GRASS_SIDE = GRASS_TOP.map((c) => mul(c, [0.9, 1, 0.7]));

/** Short blades: strokes from a dark root to a light tip, in random directions. */
function blades(pic, rng, count, pal, dirs, lenMin, lenMax) {
  for (let k = 0; k < count; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    const [dx, dy] = dirs[Math.floor(rng() * dirs.length)];
    const len = ri(rng, lenMin, lenMax);
    const base = ri(rng, 1, 3);
    for (let s = 0; s < len; s++) pic.set(x + dx * s, y + dy * s, pal[Math.min(pal.length - 1, base + s + (s === len - 1 ? 1 : 0))]);
  }
}

const ALL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function paintGrassTop(pic, rng, v) {
  const h = fbm(rng, [[4, 4, 0.5], [8, 8, 0.5]]);
  const f = new Float32Array(NN);
  for (let i = 0; i < NN; i++) f[i] = 0.22 + h[i] * 0.35;
  pic.tones(f, GRASS_TOP, 0.8);
  blades(pic, rng, 190, GRASS_TOP, ALL_DIRS, 2, 4);
  if (v === 2) {
    // two tiny flowers (white with a yellow eye)
    for (let k = 0; k < 2; k++) {
      const x = ri(rng, 6, 25);
      const y = ri(rng, 6, 25);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pic.set(x + dx, y + dy, 0xf6f4ea);
      pic.set(x, y, 0xf2c838);
      pic.set(x + 1, y + 1, GRASS_TOP[0]);
    }
  } else if (v === 3) {
    // a clover patch: rounder, bluer leaves in a clump
    const cx = ri(rng, 8, 23);
    const cy = ri(rng, 8, 23);
    for (let k = 0; k < 9; k++) {
      const x = cx + ri(rng, -4, 4);
      const y = cy + ri(rng, -3, 3);
      pic.set(x, y, 0x3f8a4a);
      pic.set(x + 1, y, 0x4f9e58);
      pic.set(x, y + 1, 0x2f6e38);
      pic.set(x + 1, y + 1, 0x3f8a4a);
    }
  }
}

/**
 * Soil with an overhang along the top: `depth(x)` rows of `pal` (light at the top edge, darker toward its ragged lower
 * edge), a few longer drips, and a soft shadow on the soil beneath.
 */
function overhang(pic, rng, pal, minDepth, maxDepth, drips, shadowPal, streaks) {
  const n = noise(rng, 8, 1);
  const depth = new Int8Array(N);
  for (let x = 0; x < N; x++) depth[x] = Math.round(minDepth + n[x] * (maxDepth - minDepth) + (rng() - 0.5) * 1.6);
  for (let k = 0; k < drips; k++) {
    const x = ri(rng, 0, N - 1);
    const extra = ri(rng, 1, 3);
    depth[x] += extra;
    if (rng() < 0.5) depth[(x + 1) % N] += extra - 1;
  }
  const g = grain(rng);
  for (let x = 0; x < N; x++) {
    const d = depth[x];
    const s = streaks ? (rng() - 0.5) * 0.25 : 0;
    for (let y = 0; y < d; y++) {
      let t = 0.95 - (y / Math.max(1, d)) * 0.55 + s + g[y * N + x] * 0.15;
      if (y === d - 1) t -= 0.2;
      pic.set(x, y, tone(pal, c01(t), x, y, 0.6));
    }
    pic.set(x, d, mul(pic.get(x, d), shadowPal[0]));
    pic.set(x, d + 1, mul(pic.get(x, d + 1), shadowPal[1]));
  }
  return depth;
}

function paintGrassSide(pic, rng, v) {
  paintDirt(pic, rngFor('dirt', 10 + v), v === 1 ? 0 : v);
  const depth = overhang(pic, rng, GRASS_SIDE, 3, 6, 2 + (v & 1), [0.62, 0.82], true);
  // blade tips poking out of the top edge's grass
  for (let k = 0; k < 14; k++) {
    const x = ri(rng, 0, N - 1);
    pic.set(x, 0, GRASS_SIDE[6]);
    if (depth[x] > 3) pic.set(x, 1, GRASS_SIDE[5]);
  }
}

const SNOW = [0xb9c8d2, 0xcad7df, 0xd9e4ea, 0xe6eef2, 0xf1f6f8, 0xf9fbfc, 0xffffff];

function paintSnow(pic, rng) {
  const h = fbm(rng, [[2, 2, 0.5], [4, 4, 0.35], [8, 8, 0.15]]);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) f[y * N + x] = c01(0.66 + (h[y * N + x] - 0.5) * 0.22 + emboss(h, x, y) * 1.5);
  pic.tones(f, SNOW, 0.7);
  for (let k = 0; k < 9; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, 0xffffff);
    pic.set(x + 1, y + 1, SNOW[2]);
  }
}

function paintSnowyGrassSide(pic, rng, v) {
  paintDirt(pic, rngFor('dirt', 20 + v), v);
  overhang(pic, rng, SNOW.slice(1), 4, 7, 1 + v, [[0.55, 0.6, 0.72], [0.8, 0.82, 0.9]], false);
}

/** Sand: fine grains, soft dunes and, on some pictures, wind ripples. */
function sand(pic, rng, v, pal, dark, sparkle) {
  const h = fbm(rng, [[2, 2, 0.35], [4, 4, 0.35], [8, 8, 0.3]]);
  const w = noise(rng, 4, 4);
  const g = grain(rng);
  const ripples = v === 1 || v === 3;
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let t = 0.5 + (h[i] - 0.5) * 0.3 + emboss(h, x, y) * 1.0 + g[i] * 0.26;
      if (ripples) t += Math.sin((y + w[i] * 6) * 1.15) * 0.1;
      f[i] = c01(t);
    }
  }
  pic.tones(f, pal, 0.9);
  for (let k = 0; k < 10; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), dark);
  for (let k = 0; k < 7; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), sparkle);
  if (v === 2) pebble(pic, rng, ri(rng, 6, 24), ri(rng, 4, 26), 3, 2, [0x9a8d74, 0xb8ab90, 0xd6cbb2], pal[0]);
}

const paintSand = (pic, rng, v) =>
  sand(pic, rng, v, [0xc2b183, 0xcdbd90, 0xd7c99c, 0xdfd2a7, 0xe7dcb3, 0xf0e6c1], 0xa99a6e, 0xfbf6e4);
const paintRedSand = (pic, rng, v) =>
  sand(pic, rng, v, [0x9a5220, 0xa95c25, 0xb7662a, 0xc27030, 0xcd7b3a, 0xd98a48], 0x7c4018, 0xeba36a);

function paintGravel(pic, rng, v) {
  const count = 26;
  const vor = voronoi(scatter(rng, count), 1, 1.15);
  const pals = [
    [0x56524e, 0x6d6964, 0x85817b, 0x9b9791],
    [0x5e5c5c, 0x777575, 0x8f8d8d, 0xa7a5a5],
    [0x4a4846, 0x5f5d5a, 0x74726e, 0x8a8783],
    [0x6a5e52, 0x83766a, 0x9b8e82, 0xb2a598],
  ];
  const kind = Array.from({ length: count }, () => Math.floor(rng() * pals.length));
  const shade = Array.from({ length: count }, () => rng() * 0.3);
  const h = new Float32Array(NN);
  for (let i = 0; i < NN; i++) h[i] = Math.min(1, (vor.f2[i] - vor.f1[i]) / 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const p = vor.id[i];
      if (vor.f2[i] - vor.f1[i] < 0.7) {
        pic.set(x, y, 0x3a3734);
        continue;
      }
      pic.set(x, y, tone(pals[kind[p]], c01(0.3 + shade[p] + emboss(h, x, y) * 0.9 + h[i] * 0.2), x, y, 0.5));
    }
  }
  if (v === 3) for (let k = 0; k < 3; k++) pic.set(ri(rng, 6, 25), ri(rng, 3, 28), 0x23262f); // a chip of dark flint
}

// ---------------------------------------------------------------------------------------------------------------
// Sandstone
// ---------------------------------------------------------------------------------------------------------------

const SANDSTONE = [0xb2a275, 0xbfaf82, 0xcbbc8e, 0xd5c799, 0xdfd2a5, 0xe8dcb1, 0xf1e7c0];

function paintSandstoneSide(pic, rng, v) {
  // strata: layers 3–7 px thick, each its own tone, a dark line under some, a lit lip on top of the tile
  const layerOf = new Int8Array(N);
  const layerTone = [];
  const lined = [];
  let y = 0;
  let L = 0;
  while (y < N) {
    const th = ri(rng, 3, 7);
    for (let k = 0; k < th && y < N; k++) layerOf[y++] = L;
    layerTone.push((rng() - 0.5) * 0.3);
    lined.push(rng() < 0.6);
    L++;
  }
  const n = fbm(rng, [[2, 8, 0.5], [8, 16, 0.5]]);
  const w = noise(rng, 4, 1);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let yy = 0; yy < N; yy++) {
    for (let x = 0; x < N; x++) {
      const i = yy * N + x;
      const ys = Math.max(0, Math.min(N - 1, yy + Math.round((w[x] - 0.5) * 2)));
      const l = layerOf[ys];
      let t = 0.5 + layerTone[l] + (n[i] - 0.5) * 0.3 + g[i] * 0.1;
      if (ys < N - 1 && layerOf[ys + 1] !== l && lined[l]) t -= 0.3;
      if (yy <= 1) t += 0.28;
      if (yy === N - 1) t -= 0.12;
      f[i] = c01(t);
    }
  }
  pic.tones(f, SANDSTONE, 0.6);
  for (let k = 0; k < 6 + v * 2; k++) {
    const x = ri(rng, 0, N - 1);
    const yy = ri(rng, 3, N - 2);
    pic.set(x, yy, SANDSTONE[0]);
    pic.set(x, yy + 1, SANDSTONE[5]);
  }
}

function paintSandstoneTop(pic, rng, v) {
  const h = fbm(rng, [[2, 2, 0.45], [4, 4, 0.35], [8, 8, 0.2]]);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) f[y * N + x] = c01(0.58 + (h[y * N + x] - 0.5) * 0.28 + emboss(h, x, y) * 0.9 + g[y * N + x] * 0.14);
  pic.tones(f, SANDSTONE, 0.7);
  if (v > 0) crack(pic, rng, ri(rng, 6, 24), ri(rng, 4, 14), ri(rng, 8, 14), SANDSTONE[0], SANDSTONE[6]);
}

// ---------------------------------------------------------------------------------------------------------------
// Wood: planks, bark, log ends
// ---------------------------------------------------------------------------------------------------------------

const OAK = [0x5a4126, 0x694c2d, 0x785734, 0x87633c, 0x956f45, 0xa27c4e, 0xb18a59];
const SPRUCE = [0x3e2a17, 0x4a331c, 0x573c21, 0x634528, 0x704f2f, 0x7d5937, 0x8b6440];
const BIRCH = [0x8f7d4f, 0x9e8b5a, 0xac9965, 0xb9a670, 0xc5b27b, 0xd0be88, 0xdccb97];

/** Four boards 8 px tall: long grain, a lit top edge and a dark gap under each, staggered end joints with nails, knots. */
function planks(pic, rng, v, pal) {
  const grainF = fbm(rng, [[2, 16, 0.55], [4, 32, 0.3], [8, 32, 0.15]]);
  const g = grain(rng);
  for (let b = 0; b < 4; b++) {
    const y0 = b * 8;
    const boardTone = (rng() - 0.5) * 0.22;
    const joint = ri(rng, 2, 29);
    for (let y = y0; y < y0 + 8; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        let t = 0.5 + boardTone + (grainF[i] - 0.5) * 0.55 + g[i] * 0.05;
        if (x >= joint) t += 0.06; // the board beyond the joint is a different board
        if (y === y0) t += 0.2;
        if (y === y0 + 6) t -= 0.12;
        let c = tone(pal, c01(t), x, y, 0.4);
        if (y === y0 + 7) c = pal[0];
        pic.set(x, y, c);
      }
    }
    for (let y = y0; y < y0 + 7; y++) {
      pic.set(joint, y, pal[0]);
      pic.set(joint + 1, y, pal[Math.min(pal.length - 1, 5)]);
    }
    pic.set(joint - 2, y0 + 2, pal[0]);
    pic.set(joint - 2, y0 + 5, pal[0]);
  }
  if (v >= 1) {
    // a knot: dark rings round a darker eye, stretched along the grain
    const b = ri(rng, 0, 3);
    const cx = ri(rng, 6, 25);
    const cy = b * 8 + 3;
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 4; x <= cx + 4; x++) {
        const d = Math.hypot((x - cx) / 2.2, y - cy);
        if (d < 0.8) pic.set(x, y, pal[0]);
        else if (d < 1.6) pic.set(x, y, pal[2]);
        else if (d < 2.2 && y > b * 8 && y < b * 8 + 6) pic.set(x, y, pal[1]);
      }
    }
  }
}

const paintOakPlanks = (pic, rng, v) => planks(pic, rng, v, OAK);
const paintSprucePlanks = (pic, rng, v) => planks(pic, rng, v, SPRUCE);
const paintBirchPlanks = (pic, rng, v) => planks(pic, rng, v, BIRCH);

const OAK_BARK = [0x2c1f12, 0x3b2a19, 0x4a3520, 0x594128, 0x684d30, 0x775a38, 0x866742];

/** Furrowed bark: vertical ridges lit from the left, dark furrows, a few short splits; a knot on one picture. */
function paintOakLogSide(pic, rng, v) {
  const ridge = fbm(rng, [[10, 2, 0.6], [20, 4, 0.25], [16, 8, 0.15]]);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const r = ridge[i];
      let t = 0.25 + r * 0.7 + (ridge[at(x - 1, y)] - ridge[at(x + 1, y)]) * 1.4 + g[i] * 0.08;
      if (r < 0.25) t -= 0.12;
      f[i] = c01(t);
    }
  }
  pic.tones(f, OAK_BARK, 0.6);
  for (let k = 0; k < 4; k++) {
    const x = ri(rng, 0, N - 3);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, OAK_BARK[0]);
    pic.set(x + 1, y, OAK_BARK[0]);
    pic.set(x, y + 1, OAK_BARK[5]);
  }
  if (v === 2) knot(pic, ri(rng, 10, 21), ri(rng, 8, 23), OAK_BARK);
}

/** A round knot on bark: dark eye, a lit rim on its top-left. */
function knot(pic, cx, cy, pal) {
  for (let y = cy - 3; y <= cy + 3; y++) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      const d = Math.hypot((x - cx) / 1.3, y - cy);
      if (d < 1.2) pic.set(x, y, pal[0]);
      else if (d < 2.2) pic.set(x, y, x + y < cx + cy ? pal[5] : pal[1]);
      else if (d < 3 && x + y < cx + cy) pic.set(x, y, pal[4]);
    }
  }
}

/** Spruce bark: dark red-brown scales, wider than tall, each lit along its top edge. */
function paintSpruceLogSide(pic, rng, v) {
  const pal = [0x1c120a, 0x28190e, 0x342113, 0x412a18, 0x4e331e, 0x5b3d25, 0x6a482c];
  const vor = voronoi(scatter(rng, 30), 0.6, 1.4);
  const shade = Array.from({ length: 30 }, () => rng() * 0.3);
  const h = new Float32Array(NN);
  for (let i = 0; i < NN; i++) h[i] = Math.min(1, (vor.f2[i] - vor.f1[i]) / 2.5);
  const g = grain(rng);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = vor.f2[i] - vor.f1[i];
      const t = e < 0.6 ? 0 : c01(0.25 + shade[vor.id[i]] + (h[at(x, y - 1)] - h[at(x, y + 1)]) * 0.9 + h[i] * 0.2 + g[i] * 0.1);
      pic.set(x, y, tone(pal, t, x, y, 0.5));
    }
  }
  if (v === 2) knot(pic, ri(rng, 10, 21), ri(rng, 8, 23), pal);
}

/** Birch bark: chalky white, dark horizontal lenticels with a lit edge, the odd black patch. */
function paintBirchLogSide(pic, rng, v) {
  const pal = [0x8d8a83, 0xa4a199, 0xb9b6ae, 0xcac7bf, 0xd8d5ce, 0xe5e3dd, 0xf0eee9];
  const h = fbm(rng, [[4, 2, 0.5], [8, 4, 0.3], [16, 8, 0.2]]);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let i = 0; i < NN; i++) f[i] = c01(0.55 + (h[i] - 0.5) * 0.5 + g[i] * 0.1);
  pic.tones(f, pal, 0.6);
  const marks = 9 + v;
  for (let k = 0; k < marks; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    const w = ri(rng, 3, 7);
    const thick = rng() < 0.3 ? 2 : 1;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < thick; j++) pic.set(x + i, y + j, i === 0 || i === w - 1 ? 0x4a4440 : 0x2b2724);
      pic.set(x + i, y - 1, pal[6]);
    }
  }
  if (v !== 1) {
    // a black patch where a branch was
    const cx = ri(rng, 9, 22);
    const cy = ri(rng, 6, 25);
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 3; x++) {
      if (Math.hypot((x - cx) / 1.6, y - cy) < 2.1) pic.set(x, y, (x + y) % 3 === 0 ? 0x3a3531 : 0x1f1c1a);
    }
  }
}

/** A log's end grain: growth rings that follow the hexagon, a pale sapwood band, bark round the rim, a pith, a split. */
function logEnd(pic, rng, v, wood, bark) {
  const wob = noise(rng, 4, 4);
  const g = grain(rng);
  const rings = 6 + ri(rng, 0, 2);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const d = hexDist(x, y);
      if (d > 0.84) {
        pic.set(x, y, tone(bark, c01(0.55 + (wob[i] - 0.5) * 0.6 + g[i] * 0.3 - (d > 0.95 ? 0.25 : 0)), x, y, 0.6));
        continue;
      }
      const r = (d + (wob[i] - 0.5) * 0.08) * rings;
      const fr = r - Math.floor(r);
      let t = 0.68 + (fr < 0.22 ? -0.28 : fr < 0.4 ? -0.08 : 0) + g[i] * 0.08 - d * 0.1;
      if (d > 0.74) t += 0.22; // sapwood
      pic.set(x, y, tone(wood, c01(t), x, y, 0.4));
    }
  }
  pic.set(15, 15, wood[0]);
  pic.set(16, 16, wood[0]);
  pic.set(16, 15, wood[1]);
  pic.set(15, 16, wood[1]);
  if (v === 1) {
    // a radial split from the pith toward the rim
    const ang = rng() * Math.PI * 2;
    for (let s = 2; s < 13; s++) {
      const x = Math.round(15.5 + Math.cos(ang) * s);
      const y = Math.round(15.5 + Math.sin(ang) * s);
      pic.set(x, y, wood[0]);
      if (s > 6) pic.set(x + 1, y, wood[1]);
    }
  }
}

const paintOakLogEnd = (pic, rng, v) => logEnd(pic, rng, v, [0x6a4f2f, 0x7a5c37, 0x8b6a41, 0x9b784b, 0xaa8656, 0xb89562, 0xc6a470], OAK_BARK);
const paintSpruceLogEnd = (pic, rng, v) =>
  logEnd(pic, rng, v, [0x4e3620, 0x5d4127, 0x6c4c2f, 0x7a5837, 0x886440, 0x96714b, 0xa47e56], [0x1c120a, 0x28190e, 0x342113, 0x412a18, 0x4e331e]);
const paintBirchLogEnd = (pic, rng, v) =>
  logEnd(pic, rng, v, [0x9c8a62, 0xab996f, 0xbaa87d, 0xc7b68a, 0xd3c398, 0xdfd0a7, 0xeadcb6], [0x8d8a83, 0xb9b6ae, 0xd8d5ce, 0xe5e3dd, 0xf0eee9]);

// ---------------------------------------------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------------------------------------------

/**
 * Leaves: a dark canopy, lit leaf shapes over it (ellipses in four slants, a bright top-left rim, a dark lower edge) and
 * holes (alpha 0) in the gaps, `holeShare` of the tile (the 16-px tiles' 12–32 % rule).
 */
function leafCanopy(pic, rng, pal, count, size, holeShare, shape = 'leaf') {
  const back = fbm(rng, [[4, 4, 0.6], [8, 8, 0.4]]);
  const f = new Float32Array(NN);
  for (let i = 0; i < NN; i++) f[i] = back[i] * 0.3;
  pic.tones(f, pal, 0.6);
  const cover = new Int16Array(NN).fill(-1);
  const slants = [[1, 0], [0.7, 0.7], [0, 1], [0.7, -0.7]];
  for (let k = 0; k < count; k++) {
    const cx = rng() * N;
    const cy = rng() * N;
    const [ax, ay] = slants[Math.floor(rng() * slants.length)];
    const len = size[0] + rng() * (size[1] - size[0]);
    const wid = shape === 'needle' ? 0.7 : len * 0.55;
    const base = 2 + Math.floor(rng() * (pal.length - 3));
    const R = Math.ceil(len) + 1;
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const a = dx * ax + dy * ay;
        const b = -dx * ay + dy * ax;
        const e = (a / len) ** 2 + (b / wid) ** 2;
        if (e > 1) continue;
        const lit = dx + dy < -len * 0.25;
        const shadow = dx + dy > len * 0.45;
        const vein = Math.abs(b) < 0.5 && shape === 'leaf' && Math.abs(a) < len * 0.6;
        let s = base + (lit ? 2 : 0) - (shadow ? 1 : 0) - (vein ? 1 : 0);
        s = Math.max(1, Math.min(pal.length - 1, s));
        pic.set(x, y, pal[s]);
        cover[at(x, y)] = k;
      }
    }
  }
  // Holes: the darkest uncovered pixels by a noise field, enough to make holeShare of the tile.
  const holeField = fbm(rng, [[8, 8, 0.6], [16, 16, 0.4]]);
  const open = [];
  for (let i = 0; i < NN; i++) if (cover[i] < 0) open.push(i);
  open.sort((a, b) => holeField[a] - holeField[b]);
  const holes = Math.min(open.length, Math.round(holeShare * NN));
  for (let k = 0; k < holes; k++) pic.px[open[k] * 4 + 3] = 0;
}

/** Oak leaves (biome-tinted by the mesher, like the 16-px ones). */
const OAK_LEAF = [0x1f4016, 0x29521c, 0x356523, 0x41782a, 0x4e8a32, 0x5c9c3b, 0x6dae47];
function paintOakLeaves(pic, rng) {
  leafCanopy(pic, rng, OAK_LEAF, 46, [2.6, 4.2], 0.2);
}

function paintBirchLeaves(pic, rng) {
  leafCanopy(pic, rng, [0x3c5e20, 0x4a7027, 0x58822f, 0x679437, 0x77a640, 0x88b84b, 0x9cc85a], 60, [2, 3.2], 0.2);
}

/** Spruce: dark blue-green needles in sprays along a few slanting twigs. */
function paintSpruceLeaves(pic, rng) {
  const pal = [0x14301f, 0x1b3c27, 0x23492f, 0x2c5838, 0x366841, 0x41784b, 0x4e8857];
  leafCanopy(pic, rng, pal, 80, [2.4, 3.6], 0.2, 'needle');
  for (let k = 0; k < 4; k++) {
    const y0 = ri(rng, 0, N - 1);
    for (let x = 0; x < N; x += 1) if (pic.getAlpha(x, y0 + Math.floor(x / 4)) > 0) pic.set(x, y0 + Math.floor(x / 4), 0x3b2a1b);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Masonry: cobblestone, bricks, stone bricks, moss
// ---------------------------------------------------------------------------------------------------------------

const COBBLE = [0x2f2f31, 0x434345, 0x525254, 0x616163, 0x707072, 0x7f7f81, 0x8f8f91, 0xa0a0a2];
const COBBLE_MORTAR = [0x2a2a2c, 0x353537, 0x404042];

function paintCobblestone(pic, rng, v) {
  const count = 10;
  const vor = voronoi(scatter(rng, count), 1, 1.2);
  const base = Array.from({ length: count }, () => 0.25 + rng() * 0.4);
  const h = new Float32Array(NN);
  for (let i = 0; i < NN; i++) h[i] = Math.min(1, (vor.f2[i] - vor.f1[i]) / 4);
  const n = fbm(rng, [[8, 8, 0.6], [16, 16, 0.4]]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = vor.f2[i] - vor.f1[i];
      if (e < 1.5) {
        pic.set(x, y, tone(COBBLE_MORTAR, c01(n[i] * 0.8 + (e < 0.8 ? 0 : 0.3)), x, y, 0.6));
        continue;
      }
      const t = base[vor.id[i]] + emboss(h, x, y) * 1.1 + Math.sqrt(h[i]) * 0.18 + (n[i] - 0.5) * 0.18;
      pic.set(x, y, tone(COBBLE, c01(t), x, y, 0.5));
    }
  }
  if (v === 3) crack(pic, rng, ri(rng, 8, 22), ri(rng, 4, 16), 6, COBBLE[0], COBBLE[6]);
  return vor;
}

/** Moss over masonry: in the joints and as clumps, lit, with a few pale spore-tips. */
function moss(pic, rng, joints, amount) {
  const pal = [0x2a4419, 0x34531f, 0x3f6326, 0x4b742e, 0x588536, 0x67963f];
  const m = fbm(rng, [[4, 4, 0.55], [8, 8, 0.3], [16, 16, 0.15]]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const inJoint = joints(x, y);
      if (m[i] > 1 - amount || (inJoint && m[i] > 1 - amount * 1.9)) {
        const lit = m[at(x - 1, y - 1)] < m[i] ? 1 : 0;
        pic.set(x, y, tone(pal, c01((m[i] - (1 - amount * 1.9)) * 1.2 + lit * 0.15), x, y, 0.8));
      }
    }
  }
  for (let k = 0; k < 6; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    if (m[y * N + x] > 1 - amount) pic.set(x, y, 0x8bb35a);
  }
}

function paintMossyCobblestone(pic, rng, v) {
  const vor = paintCobblestone(pic, rngFor('cobblestone', 30 + v), 0);
  moss(pic, rng, (x, y) => vor.f2[y * N + x] - vor.f1[y * N + x] < 2.2, 0.22);
}

/**
 * Brick courses: rows of `rowH` px (the last row of each is mortar), bricks `brickW` wide, alternate rows offset by half a
 * brick. Each brick has its own tone, a lit top-left edge, a dark bottom-right edge; the mortar under a brick is in its
 * shadow. Returns the joint test.
 */
function brickwork(pic, rng, pal, mortarPal, rowH, brickW, opts = {}) {
  const { speck = 0, rough = 0.08 } = opts;
  const g = grain(rng);
  const n = fbm(rng, [[8, 8, 0.6], [16, 16, 0.4]]);
  const tones = new Map();
  const joint = (x, y) => {
    const yy = wrap(y);
    const row = Math.floor(yy / rowH);
    if (yy % rowH === rowH - 1) return true;
    const off = row % 2 === 1 ? brickW / 2 : 0;
    return wrap(x - off) % brickW === brickW - 1;
  };
  for (let y = 0; y < N; y++) {
    const row = Math.floor(y / rowH);
    const off = row % 2 === 1 ? brickW / 2 : 0;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (joint(x, y)) {
        const shaded = !joint(x, y - 1) || !joint(x - 1, y);
        pic.set(x, y, tone(mortarPal, c01(0.55 + g[i] * 0.4 - (shaded ? 0.45 : 0)), x, y, 0.6));
        continue;
      }
      const col = Math.floor(wrap(x - off) / brickW);
      const key = row * 64 + col;
      if (!tones.has(key)) tones.set(key, (rng() - 0.5) * 0.3);
      let t = 0.5 + tones.get(key) + (n[i] - 0.5) * 0.25 + g[i] * rough;
      if (joint(x - 1, y) || joint(x, y - 1)) t += 0.22;
      else if (joint(x + 1, y) || joint(x, y + 1)) t -= 0.2;
      pic.set(x, y, tone(pal, c01(t), x, y, 0.5));
    }
  }
  for (let k = 0; k < speck; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    if (!joint(x, y)) pic.set(x, y, pal[rng() < 0.5 ? 0 : 1]);
  }
  return joint;
}

const BRICK = [0x6e3427, 0x80402f, 0x924c38, 0xa35843, 0xb3654f, 0xc2735d, 0xcf836d];
const BRICK_MORTAR = [0x8e877c, 0xa69f93, 0xbab3a7, 0xccc6bb];

function paintBricks(pic, rng, v) {
  brickwork(pic, rng, BRICK, BRICK_MORTAR, 8, 16, { speck: 26 });
  if (v === 1) {
    // a chipped corner on one brick
    const x = ri(rng, 4, 26);
    const y = ri(rng, 0, 3) * 8;
    pic.set(x, y, BRICK_MORTAR[1]);
    pic.set(x + 1, y, BRICK_MORTAR[1]);
    pic.set(x, y + 1, BRICK_MORTAR[0]);
  }
}

const STONE_BRICK = [0x4b4b4e, 0x58585b, 0x656568, 0x727275, 0x7f7f82, 0x8c8c8f, 0x9b9b9e];
const STONE_MORTAR = [0x2e2e30, 0x3a3a3c, 0x464648];

function paintStoneBricks(pic, rng, v) {
  const joint = brickwork(pic, rng, STONE_BRICK, STONE_MORTAR, 8, 16, { speck: 10, rough: 0.12 });
  if (v === 2) {
    const x = ri(rng, 4, 26);
    const y = ri(rng, 0, 3) * 8 + 1;
    const pts = walk(rng, x, y, 6, rng() < 0.5 ? 1 : -1, 1);
    for (const [a, b] of pts) if (!joint(a, b)) pic.set(a, b, STONE_BRICK[0]);
  }
  return joint;
}

function paintMossyStoneBricks(pic, rng, v) {
  const joint = paintStoneBricks(pic, rngFor('stone_bricks', 40 + v), 0);
  moss(pic, rng, joint, 0.28);
}

// ---------------------------------------------------------------------------------------------------------------
// Made things: bookshelf, wool, storage blocks, glass, glowstone, honeycomb, hay, pumpkin
// ---------------------------------------------------------------------------------------------------------------

const BOOK_COLOURS = [0x8c2b25, 0x2f5a8a, 0x3d6b33, 0x7a5a2a, 0x5a2f6b, 0xb08a3a, 0x2f6b66, 0xa0522d, 0x6b2f3a, 0xd8cdb4];

function paintBookshelf(pic, rng) {
  // the case: planks at the top, the middle shelf and the bottom
  const frame = (y) => y <= 2 || y === 15 || y === 16 || y >= 30;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!frame(y)) {
        pic.set(x, y, 0x2a1d12); // the dark back of the shelf
        continue;
      }
      const lit = y === 0 || y === 15;
      const dark = y === 2 || y === 16 || y === 31;
      pic.set(x, y, lit ? OAK[5] : dark ? OAK[1] : OAK[3 + ((x * 7 + y) % 3 === 0 ? 1 : 0)]);
    }
  }
  for (const [top, bottom] of [[3, 14], [17, 29]]) {
    let x = ri(rng, 0, 1);
    while (x < N - 1) {
      if (rng() < 0.08) {
        x += ri(rng, 2, 3); // a gap
        continue;
      }
      const w = ri(rng, 2, 3);
      const h = ri(rng, 8, bottom - top + 1);
      const col = BOOK_COLOURS[Math.floor(rng() * BOOK_COLOURS.length)];
      const band = rng() < 0.5 ? ri(rng, 2, 4) : -1;
      for (let i = 0; i < w && x + i < N; i++) {
        for (let y = bottom - h + 1; y <= bottom; y++) {
          let c = i === 0 ? mul(col, 1.25) : i === w - 1 ? mul(col, 0.7) : col;
          if (y === bottom - h + 1) c = mul(col, 1.1);
          if (band >= 0 && (y === bottom - h + 1 + band || y === bottom - 2)) c = 0xd8b24a;
          pic.set(x + i, y, c);
        }
      }
      x += w;
    }
  }
}

const WOOL = {
  [T.WOOL_WHITE]: 0xe9ecec, [T.WOOL_RED]: 0xa12722, [T.WOOL_ORANGE]: 0xe87a1a, [T.WOOL_YELLOW]: 0xf4cc30,
  [T.WOOL_LIME]: 0x74c02a, [T.WOOL_GREEN]: 0x4a6a22, [T.WOOL_CYAN]: 0x168c94, [T.WOOL_LIGHT_BLUE]: 0x4cb0dc,
  [T.WOOL_BLUE]: 0x353aa0, [T.WOOL_PURPLE]: 0x7a2aaa, [T.WOOL_MAGENTA]: 0xbc48b4, [T.WOOL_PINK]: 0xec90ac,
  [T.WOOL_BROWN]: 0x734a2a, [T.WOOL_BLACK]: 0x18181c, [T.WOOL_GRAY]: 0x3e4448, [T.WOOL_LIGHT_GRAY]: 0x8e8e88,
};

/** Knitted wool: rows of little V stitches, each lit on its upper arm, with a soft fuzz and a few stray fibres. */
function paintWoolOf(base) {
  return (pic, rng, v) => {
    const dark = base === 0x18181c;
    const pal = dark ? shades(0x2a2a30, 6, 0.55, 1.35, 0) : shades(base, 6, 0.8, 1.2, 0.02);
    const fuzz = fbm(rng, [[4, 4, 0.5], [8, 8, 0.5]]);
    const g = grain(rng);
    const STITCH = [
      [3, 1, 1, 3],
      [2, 3, 3, 2],
      [1, 2, 2, 1],
      [2, 1, 1, 2],
    ];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const s = STITCH[y & 3][(x + ((y >> 2) & 1) * 2) & 3];
        pic.set(x, y, pal[Math.max(0, Math.min(pal.length - 1, s + Math.round((fuzz[i] - 0.5) * 1.6 + g[i] * 0.8)))]);
      }
    }
    const fibres = v === 1 ? 5 : 2;
    for (let k = 0; k < fibres; k++) {
      const pts = walk(rng, ri(rng, 4, 27), ri(rng, 3, 28), 4, 1, rng() < 0.5 ? 1 : -1);
      for (const [x, y] of pts) pic.set(x, y, pal[5]);
    }
  };
}

/** A storage block: a material face with a lit top rim and a dark bottom rim (the joint between stacked blocks). */
function storage(pic, rng, body) {
  body(pic, rng);
  for (let x = 0; x < N; x++) {
    pic.set(x, 0, mix(pic.get(x, 0), 0xffffff, 0.35));
    pic.set(x, 1, mix(pic.get(x, 1), 0xffffff, 0.15));
    pic.set(x, N - 2, mul(pic.get(x, N - 2), 0.8));
    pic.set(x, N - 1, mul(pic.get(x, N - 1), 0.6));
  }
}

/** Brushed metal: horizontal streaks, a soft diagonal sheen. */
function brushed(pal, sheen = 0.25) {
  return (pic, rng) => {
    const streak = fbm(rng, [[2, 32, 0.6], [4, 32, 0.4]]);
    const g = grain(rng);
    const f = new Float32Array(NN);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const d = ((x + y) % 32) / 32;
      const s = Math.max(0, 1 - Math.abs(d - 0.35) * 6) * sheen;
      f[i] = c01(0.45 + (streak[i] - 0.5) * 0.4 + s + g[i] * 0.06);
    }
    pic.tones(f, pal, 0.5);
  };
}

/** Round rivets in the middle band (so a side face shows them). */
function rivets(pic, light, mid, dark) {
  for (const [x, y] of [[9, 6], [22, 6], [9, 25], [22, 25]]) {
    pic.set(x, y, light);
    pic.set(x + 1, y, mid);
    pic.set(x, y + 1, mid);
    pic.set(x + 1, y + 1, dark);
    pic.set(x + 2, y + 2, mul(pic.get(x + 2, y + 2), 0.75));
  }
}

function paintIronBlock(pic, rng) {
  const pal = [0x9c9c9e, 0xb0b0b2, 0xc3c3c5, 0xd4d4d6, 0xe3e3e5, 0xf2f2f4];
  storage(pic, rng, brushed(pal));
  rivets(pic, 0xffffff, 0xc9c9cb, 0x7a7a7c);
}

function paintGoldBlock(pic, rng) {
  const pal = [0xb88a16, 0xd2a224, 0xe6b932, 0xf2cd42, 0xfadf62, 0xfff090];
  storage(pic, rng, brushed(pal, 0.45));
  for (let k = 0; k < 5; k++) pic.set(ri(rng, 6, 25), ri(rng, 3, 28), 0xfffbe0);
}

function paintCopperBlock(pic, rng) {
  const pal = [0x8a4528, 0xa45434, 0xbb6442, 0xcc7552, 0xdc8964, 0xea9f7c];
  storage(pic, rng, (p, r) => {
    brushed(pal, 0.3)(p, r);
    const patina = fbm(r, [[4, 4, 0.6], [8, 8, 0.4]]);
    for (let y = 2; y < N - 2; y++) for (let x = 0; x < N; x++) {
      const t = patina[y * N + x];
      if (t > 0.8) p.set(x, y, t > 0.9 ? 0x6cc4a0 : 0x4f9f80);
    }
  });
  rivets(pic, 0xf2b494, 0xc07050, 0x6a3420);
}

function paintCoalBlock(pic, rng) {
  storage(pic, rng, (p, r) => {
    const pal = [0x0b0b0c, 0x141416, 0x1d1d20, 0x26262a, 0x323237, 0x45454c];
    const vor = voronoi(scatter(r, 12));
    const h = new Float32Array(NN);
    for (let i = 0; i < NN; i++) h[i] = Math.min(1, (vor.f2[i] - vor.f1[i]) / 3);
    const f = new Float32Array(NN);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) f[y * N + x] = c01(0.3 + emboss(h, x, y) * 1.6 + h[y * N + x] * 0.3);
    p.tones(f, pal, 0.5);
    for (let k = 0; k < 6; k++) p.set(ri(r, 0, N - 1), ri(r, 2, N - 3), 0x6a6a74);
  });
}

/** Diamond: a lattice of triangular facets (a nod to the honeycomb), alternately lit and shaded, with sparkles. */
function paintDiamondBlock(pic, rng) {
  storage(pic, rng, (p, r) => {
    const pal = [0x239aa2, 0x35b4bc, 0x4ac8ce, 0x62dce0, 0x86ecee, 0xbff8f8];
    const shade = Array.from({ length: 64 }, () => r());
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const row = Math.floor(y / 8);
        const u = (x + (row % 2) * 4) / 8;
        const fy = (y % 8) / 8;
        const cu = Math.floor(u);
        const fu = u - cu;
        const up = fu < 0.5 ? fy > 1 - 2 * fu : fy > 2 * fu - 1;
        const k = (row * 8 + cu * 2 + (up ? 1 : 0)) % 64;
        const edge = Math.abs(fy - (fu < 0.5 ? 1 - 2 * fu : 2 * fu - 1)) < 0.12 || y % 8 === 0;
        p.set(x, y, edge ? pal[5] : tone(pal, c01(0.15 + shade[k] * 0.75 + (up ? 0.12 : -0.05))));
      }
    }
    for (let k = 0; k < 6; k++) p.set(ri(r, 6, 25), ri(r, 3, 28), 0xffffff);
  });
}

function paintGlass(pic) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) pic.set(x, y, 0xe8f4f8, 0);
  // the frame: two px round the edge (a cap shows its top and bottom corners, a side its top and bottom rows)
  for (let i = 0; i < N; i++) {
    for (const [x, y, c] of [[i, 0, 0xf4fbfd], [i, 1, 0xc4dbe4], [i, N - 2, 0xc4dbe4], [i, N - 1, 0x8faab6],
      [0, i, 0xf4fbfd], [1, i, 0xc4dbe4], [N - 2, i, 0xc4dbe4], [N - 1, i, 0x8faab6]]) {
      pic.set(x, y, c, 255);
    }
  }
  // glints: two short diagonal streaks up-left and one small one down-right, inside a side face's window
  for (const [x0, y0, len] of [[10, 9, 5], [13, 8, 3], [21, 22, 3]]) {
    for (let s = 0; s < len; s++) pic.set(x0 + s, y0 - s, 0xffffff, 255);
  }
}

function paintGlowstone(pic, rng, v) {
  const count = 12 + v * 2;
  const vor = voronoi(scatter(rng, count));
  const warm = Array.from({ length: count }, () => rng());
  const pal = [0x5e3f1a, 0x8a5c22, 0xb7802c, 0xd7a03a, 0xedc052, 0xf8dc7c, 0xfff2b8];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = vor.f2[i] - vor.f1[i];
      if (e < 0.9) {
        pic.set(x, y, pal[0]);
        continue;
      }
      const core = 1 - Math.min(1, vor.f1[i] / 5.5);
      pic.set(x, y, tone(pal, c01(0.3 + core * 0.6 + warm[vor.id[i]] * 0.15 + (e < 1.8 ? -0.15 : 0)), x, y, 0.6));
    }
  }
}

/** Honeycomb: pointy-top hex cells (like the world's own), dark wax walls, glossy honey, some capped on one picture. */
function paintHoneycomb(pic, rng, v) {
  const pal = [0x7a4a10, 0x9e6215, 0xc07a1c, 0xd99426, 0xe9ab38, 0xf5c45a, 0xffe08e];
  const cap = [0xd8b064, 0xe8c47a, 0xf2d898];
  const R = 4.2; // cell radius in px
  const w = Math.sqrt(3) * R;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // axial rounding (pointy-top) of the pixel centre
      const px = x + 0.5;
      const py = y + 0.5;
      const qf = (px * Math.sqrt(3) / 3 - py / 3) / R;
      const rf = ((2 / 3) * py) / R;
      let q = Math.round(qf);
      let r = Math.round(rf);
      const s = Math.round(-qf - rf);
      const dq = Math.abs(q - qf);
      const dr = Math.abs(r - rf);
      const ds = Math.abs(s + qf + rf);
      if (dq > dr && dq > ds) q = -r - s;
      else if (dr > ds) r = -q - s;
      const cx = w * (q + r / 2);
      const cy = 1.5 * R * r;
      const ux = Math.abs(px - cx);
      const uy = Math.abs(py - cy);
      const d = Math.max(ux, ux * 0.5 + uy * 0.866) / (R * 0.866);
      const key = q * 97 + r;
      if (d > 0.8) {
        pic.set(x, y, d > 0.92 ? pal[0] : pal[1]);
        continue;
      }
      if (v === 1 && rngHash(key) < 0.3) {
        pic.set(x, y, cap[px - cx + (py - cy) < -1 ? 2 : px - cx + (py - cy) > 2 ? 0 : 1]);
        continue;
      }
      const lit = px - cx + (py - cy) < -1.5 && d > 0.35;
      pic.set(x, y, lit ? pal[6] : tone(pal, c01(0.85 - d * 0.4), x, y, 0.5));
    }
  }
}

/** A stable 0..1 from an integer (which honeycomb cells are capped). */
function rngHash(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const HAY = [0x8c6a1c, 0xa47e22, 0xba922a, 0xcca535, 0xdab744, 0xe6c858, 0xf0d870];

function paintHayBaleSide(pic, rng) {
  const straw = fbm(rng, [[16, 2, 0.6], [32, 4, 0.4]]);
  const g = grain(rng);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    f[i] = c01(0.15 + straw[i] * 0.8 + (straw[at(x - 1, y)] - straw[at(x + 1, y)]) * 0.8 + g[i] * 0.1);
  }
  pic.tones(f, HAY, 0.6);
  // the twine: two bands that wrap round the bale, shading the straw under them
  for (const y0 of [6, 23]) {
    for (let x = 0; x < N; x++) {
      pic.set(x, y0, 0x8a4a2a);
      pic.set(x, y0 + 1, (x + y0) % 4 === 0 ? 0x5a2c18 : 0x6e3a20);
      pic.set(x, y0 + 2, mul(pic.get(x, y0 + 2), 0.7));
      pic.set(x, y0 - 1, mul(pic.get(x, y0 - 1), 0.85));
    }
  }
  // a few stray straws across the twine
  for (let k = 0; k < 5; k++) {
    const x = ri(rng, 2, 29);
    const y = ri(rng, 2, 27);
    for (let s = 0; s < 4; s++) pic.set(x + (s >> 1), y + s, HAY[6]);
  }
}

function paintHayBaleTop(pic, rng) {
  const f = new Float32Array(NN);
  const n = fbm(rng, [[8, 8, 0.6], [16, 16, 0.4]]);
  for (let i = 0; i < NN; i++) f[i] = n[i] * 0.4;
  pic.tones(f, HAY, 0.8);
  blades(pic, rng, 170, HAY, ALL_DIRS, 2, 5);
  for (let k = 0; k < 30; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), HAY[0]);
}

const PUMPKIN = [0x7a3a08, 0x9a4c0c, 0xb85e10, 0xcc6e16, 0xdc7f1e, 0xe9922c, 0xf4a842];

/** Pumpkin side: rounded ribs, each lit on its left, with dark grooves between (6 ribs across the tile). */
function paintPumpkinSide(pic, rng) {
  const g = grain(rng);
  const n = fbm(rng, [[4, 4, 1]]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = ((x + 0.5) / N) * 6;
      const fu = u - Math.floor(u);
      const bulge = Math.sin(fu * Math.PI);
      let t = 0.2 + bulge * 0.65 + (fu < 0.45 ? 0.1 : -0.05) + (n[i] - 0.5) * 0.15 + g[i] * 0.08;
      if (y <= 1) t -= 0.25 * (2 - y) * 0.5;
      if (y >= N - 2) t -= 0.15;
      pic.set(x, y, tone(PUMPKIN, c01(t), x, y, 0.5));
    }
  }
}

/** Pumpkin top: six ribs running to the hexagon's corners, darker toward the stem, and a green-brown stem. */
function paintPumpkinTop(pic, rng) {
  const g = grain(rng);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - 16;
      const dy = y + 0.5 - 16;
      const ang = Math.atan2(dy, dx) + Math.PI / 2; // corners of the pointy-top hexagon at 0, 60, … degrees from up
      const k = ((ang / (Math.PI / 3)) % 1 + 1) % 1;
      const groove = Math.abs(k - 0.5) > 0.42 ? 1 : 0;
      const d = hexDist(x, y);
      const t = 0.35 + d * 0.5 - groove * 0.35 + (k < 0.5 ? 0.08 : -0.04) + g[y * N + x] * 0.08;
      pic.set(x, y, tone(PUMPKIN, c01(t), x, y, 0.5));
    }
  }
  const stem = [[15, 14], [16, 14], [14, 15], [15, 15], [16, 15], [17, 15], [14, 16], [15, 16], [16, 16], [17, 16], [15, 17], [16, 17]];
  for (const [x, y] of stem) pic.set(x, y, x + y < 31 ? 0x6e8a32 : 0x4a5e22);
  pic.set(15, 15, 0x92ac4a);
  pic.set(17, 18, 0x5a2a06);
  pic.set(16, 18, 0x5a2a06);
}

// ---------------------------------------------------------------------------------------------------------------
// Ice, water, the aquifer
// ---------------------------------------------------------------------------------------------------------------

function paintIce(pic, rng, v) {
  const pal = [0x6f98d8, 0x7ea6e2, 0x8db3ea, 0x9cc0f0, 0xacccf5, 0xc0dafa];
  const h = fbm(rng, [[2, 2, 0.5], [4, 4, 0.5]]);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) f[y * N + x] = c01(0.5 + (h[y * N + x] - 0.5) * 0.6 + emboss(h, x, y) * 2);
  pic.tones(f, pal, 0.5);
  for (let k = 0; k < 2 + v; k++) {
    const pts = walk(rng, ri(rng, 4, 27), ri(rng, 2, 12), ri(rng, 8, 16), rng() < 0.5 ? 1 : -1, 1);
    for (const [x, y] of pts) pic.set(x, y, 0xe8f4ff);
  }
  for (let k = 0; k < 7; k++) {
    const x = ri(rng, 2, 29);
    const y = ri(rng, 2, 29);
    pic.set(x, y, 0xf4faff);
    pic.set(x + 1, y + 1, pal[1]);
  }
  for (let i = 3; i < pic.px.length; i += 4) pic.px[i] = 200; // ICE is alpha 200 everywhere (§15)
}

function paintPackedIce(pic, rng, v) {
  const pal = [0x5f84c8, 0x6d92d2, 0x7ca0dc, 0x8cade4, 0x9dbbeb, 0xb4ccf2];
  const h = fbm(rng, [[2, 2, 0.4], [4, 4, 0.35], [8, 8, 0.25]]);
  const vein = fbm(rng, [[4, 4, 0.6], [8, 8, 0.4]]);
  const f = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const onVein = Math.abs(vein[i] - 0.5) < 0.035;
    f[i] = onVein ? 1 : c01(0.45 + (h[i] - 0.5) * 0.6 + emboss(h, x, y) * 1.8);
  }
  pic.tones(f, pal, 0.5);
  for (let k = 0; k < 5 + v * 2; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), 0xe0ecff);
}

/** Still water: deep blue, soft swells and short light ripple lines; alpha 178 everywhere (§15). */
function water(pic, rng, pal, ripple, alpha) {
  const h = fbm(rng, [[2, 2, 0.5], [4, 4, 0.5]]);
  const f = new Float32Array(NN);
  for (let i = 0; i < NN; i++) f[i] = 0.25 + h[i] * 0.45;
  pic.tones(f, pal, 0.8);
  for (let k = 0; k < 9; k++) {
    const x0 = ri(rng, 0, N - 1);
    const y0 = ri(rng, 0, N - 1);
    const len = ri(rng, 4, 8);
    for (let s = 0; s < len; s++) {
      const y = y0 + (s === 0 || s === len - 1 ? 1 : 0);
      pic.set(x0 + s, y, s === 0 || s === len - 1 ? ripple[0] : ripple[1]);
    }
  }
  for (let i = 3; i < pic.px.length; i += 4) pic.px[i] = alpha;
}

const paintWater = (pic, rng) =>
  water(pic, rng, [0x2f5fc8, 0x3566cf, 0x3b6ed7, 0x4176dd, 0x487ee2, 0x5088e6], [0x6a9bf0, 0x8cb6f6], 178);

function paintTaintedWater(pic, rng) {
  water(pic, rng, [0x434b1c, 0x4b5420, 0x535d25, 0x5b662a, 0x646f30, 0x6e7836], [0x7a8040, 0x8e9450], 178);
  // scum: a few pale yellow-green flecks
  for (let k = 0; k < 12; k++) pic.set(ri(rng, 0, N - 1), ri(rng, 0, N - 1), rng() < 0.5 ? 0x9a9a52 : 0x7e7a3a, 178);
}

const AQUIFER = [0x1f2a34, 0x27343f, 0x2f3e4a, 0x384856, 0x415362, 0x4c5f70, 0x5a6e80];

/** The aquifer: dark wet rock with a sheen, water seeping from its cracks (running down a side, pooled on the cap). */
function aquifer(pic, rng, v, side) {
  rock(pic, rng, AQUIFER, { contrast: 1.1, flecks: 0, pits: 6 });
  for (let k = 0; k < 10; k++) {
    const x = ri(rng, 0, N - 1);
    const y = ri(rng, 0, N - 1);
    pic.set(x, y, 0x8fb4d0);
  }
  const seeps = 2 + v;
  for (let k = 0; k < seeps; k++) {
    const x = ri(rng, 7, 24);
    const y = ri(rng, 2, side ? 12 : 26);
    if (side) {
      const len = ri(rng, 10, 18);
      for (let s = 0; s < len; s++) {
        const xx = x + (s > len / 2 && k % 2 ? 1 : 0);
        pic.set(xx, y + s, s % 5 === 0 ? 0xa8daf8 : 0x4fa6e0);
        pic.set(xx + 1, y + s, mul(pic.get(xx + 1, y + s), 0.7));
      }
      pic.set(x, y - 1, AQUIFER[0]);
      pic.set(x + 1, y - 1, AQUIFER[0]);
    } else {
      for (let j = -1; j <= 1; j++) for (let i = -2; i <= 2; i++) if (Math.abs(i) + Math.abs(j) < 3) pic.set(x + i, y + j, i + j < -1 ? 0xa8daf8 : 0x3f90cc);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {(pic: Picture, rng: Rng, v: number) => void} Painter */

/** @type {Map<number, Painter>} */
const PAINTERS = new Map(/** @type {Array<[number, Painter]>} */ ([
  [T.STONE, paintStone], [T.DIRT, paintDirt], [T.GRASS_TOP, paintGrassTop], [T.GRASS_SIDE, paintGrassSide],
  [T.COBBLESTONE, paintCobblestone], [T.OAK_PLANKS, paintOakPlanks], [T.BEDROCK, paintBedrock], [T.WATER, paintWater],
  [T.SAND, paintSand], [T.GRAVEL, paintGravel], [T.OAK_LOG_SIDE, paintOakLogSide], [T.OAK_LOG_END, paintOakLogEnd],
  [T.OAK_LEAVES, paintOakLeaves], [T.GLASS, paintGlass], [T.COAL_ORE, paintCoalOre], [T.IRON_ORE, paintIronOre],
  [T.GOLD_ORE, paintGoldOre], [T.DIAMOND_ORE, paintDiamondOre], [T.SANDSTONE_TOP, paintSandstoneTop],
  [T.SANDSTONE_SIDE, paintSandstoneSide], [T.SNOW, paintSnow], [T.SNOWY_GRASS_SIDE, paintSnowyGrassSide],
  [T.BRICKS, paintBricks], [T.BOOKSHELF, paintBookshelf], [T.STONE_BRICKS, paintStoneBricks],
  [T.SPRUCE_LOG_SIDE, paintSpruceLogSide], [T.SPRUCE_LOG_END, paintSpruceLogEnd], [T.SPRUCE_PLANKS, paintSprucePlanks],
  [T.SPRUCE_LEAVES, paintSpruceLeaves], [T.BIRCH_LOG_SIDE, paintBirchLogSide], [T.BIRCH_LOG_END, paintBirchLogEnd],
  [T.BIRCH_PLANKS, paintBirchPlanks], [T.BIRCH_LEAVES, paintBirchLeaves], [T.GRANITE, paintGranite],
  [T.DIORITE, paintDiorite], [T.ANDESITE, paintAndesite], [T.SLATE, paintSlate],
  [T.MOSSY_COBBLESTONE, paintMossyCobblestone], [T.MOSSY_STONE_BRICKS, paintMossyStoneBricks],
  [T.OBSIDIAN, paintObsidian], [T.CLAY, paintClay], [T.RED_SAND, paintRedSand], [T.ICE, paintIce],
  [T.PACKED_ICE, paintPackedIce], [T.COAL_BLOCK, paintCoalBlock], [T.IRON_BLOCK, paintIronBlock],
  [T.GOLD_BLOCK, paintGoldBlock], [T.DIAMOND_BLOCK, paintDiamondBlock], [T.COPPER_BLOCK, paintCopperBlock],
  [T.GLOWSTONE, paintGlowstone], [T.HONEYCOMB, paintHoneycomb], [T.HAY_BALE_SIDE, paintHayBaleSide],
  [T.HAY_BALE_TOP, paintHayBaleTop], [T.PUMPKIN_SIDE, paintPumpkinSide], [T.PUMPKIN_TOP, paintPumpkinTop],
  [T.COPPER_ORE, paintCopperOre], [T.TIN_ORE, paintTinOre], [T.TAINTED_WATER, paintTaintedWater],
  [T.AQUIFER_SIDE, (p, r, v) => aquifer(p, r, v, true)], [T.AQUIFER_TOP, (p, r, v) => aquifer(p, r, v, false)],
  ...Object.entries(WOOL).map(([t, base]) => [Number(t), paintWoolOf(base)]),
]));

for (const t of VARIANT_TILES) if (!PAINTERS.has(t)) throw new Error(`tilesHD: tile ${t} has variants but no painter`);

/** The tiles this module paints. */
export const HD_TILES = Object.freeze([...PAINTERS.keys()]);

/** @returns {boolean} tilesHD paints tile `tile` */
export function hasHDTile(tile) {
  return PAINTERS.has(tile);
}

/**
 * Picture `variant` of tile `tile` at 32×32, or null when this module has no painter for it (atlas.js then doubles the
 * 16-px tile). Deterministic; never depends on the world seed.
 * @param {number} tile
 * @param {number} [variant=0]
 * @returns {Uint8ClampedArray|null}
 */
export function paintTileHD(tile, variant = 0) {
  const paint = PAINTERS.get(tile);
  if (!paint) return null;
  const pic = new Picture();
  paint(pic, rngFor(String(tile), variant), variant);
  return pic.px;
}

/**
 * Tile `px` (16×16 RGBA) doubled to 32×32 with nearest-neighbour: the pictures with no HD painter look exactly as before.
 * @param {Uint8ClampedArray} px
 * @returns {Uint8ClampedArray}
 */
export function upscale16(px) {
  const out = new Uint8ClampedArray(NN * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const s = ((y >> 1) * 16 + (x >> 1)) * 4;
      const d = (y * N + x) * 4;
      out[d] = px[s];
      out[d + 1] = px[s + 1];
      out[d + 2] = px[s + 2];
      out[d + 3] = px[s + 3];
    }
  }
  return out;
}

/** Mean RGB over the pixels with alpha ≥ 128 of a 32×32 picture (particles take a block's colour from it). */
export function averageColorHD(px) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
