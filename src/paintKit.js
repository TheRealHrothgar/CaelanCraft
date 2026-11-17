// Caelancraft — the paint kit: procedural textures painted in code at runtime (PURE: RGBA typed arrays, no DOM). See
// src/CONTRACTS.md §91.2. The avatars' atlases are painted with it (avatarModel.js); the art pilot (gallery.html) too.
//
// The game downloads no pictures: every texture is painted here, deterministically (a seed, never Math.random) and
// from a palette (avatars.js and friends), at about twice the texel density of today's skins. A Painter paints one
// rectangle of an image (local pixel coordinates, x right, y down, clipped to the rectangle): soft shapes with
// anti-aliased edges (ellipses, strokes, glows), materials that fill the rectangle (cloth weave, denim twill, knit,
// directional fur, curly wool, leaves with veins, bark, skin, hair strands, stone, grass), baked light (a soft
// vertical shade, ambient occlusion toward the edges that meet a joint or the ground), tailoring (seams, hems,
// stitches) and faces (an iris with its pupil and a catchlight, brows, a soft mouth, a blush — or a zombie's sunken
// slits). An Atlas packs the rectangles of one model's parts on one image, with a gutter that bleed() fills so the
// mipmaps never pick up a neighbour.

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Img */
/** @typedef {[number, number, number, number]} Rect  x, y, w, h in pixels */

/** A new image, transparent black (or filled with `rgb`, opaque). */
export function createImage(width, height, rgb = -1) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (rgb >= 0) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (rgb >> 16) & 255;
      data[i + 1] = (rgb >> 8) & 255;
      data[i + 2] = rgb & 255;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------------
// Numbers: hashes, noise, colours
// ---------------------------------------------------------------------------------------------------

/** An integer hash of two coordinates and a seed, in [0, 1). */
export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** A seeded generator of numbers in [0, 1) (mulberry32). */
export function makeRng(seed) {
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1). */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal noise in [0, 1): `octaves` of noise2, each twice as fine and half as strong. */
export function fbm(x, y, seed = 0, octaves = 3) {
  let s = 0;
  let w = 0.5;
  let t = 0;
  for (let o = 0; o < octaves; o++) {
    s += w * noise2(x, y, seed + o * 31);
    t += w;
    x *= 2;
    y *= 2;
    w *= 0.5;
  }
  return s / t;
}

/** 0xRRGGBB as [r, g, b]. */
export const rgbOf = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
/** [r, g, b] (any numbers) as 0xRRGGBB, clamped. */
export const hexOf = (r, g, b) => {
  const k = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (k(r) << 16) | (k(g) << 8) | k(b);
};
/** `t` of the way from colour a to colour b. */
export function mix(a, b, t) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return hexOf(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
/** A colour lit by k: below 1 darker (multiplied), above 1 toward white. */
export function shade(c, k) {
  const [r, g, b] = rgbOf(c);
  if (k <= 1) return hexOf(r * k, g * k, b * k);
  const t = Math.min(1, k - 1);
  return hexOf(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------------------
// The painter
// ---------------------------------------------------------------------------------------------------

/** Paints one rectangle of an image in local pixel coordinates (clipped to it). */
export class Painter {
  /**
   * @param {Img} img
   * @param {Rect|number[]} [rect]  default the whole image
   * @param {number} [seed]
   */
  constructor(img, rect = [0, 0, img.width, img.height], seed = 1) {
    this.img = img;
    this.ox = rect[0];
    this.oy = rect[1];
    this.w = rect[2];
    this.h = rect[3];
    this.seed = seed | 0;
  }

  /** @returns {number} the byte offset of local pixel (x, y), or −1 outside the rectangle */
  at(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return ((this.oy + y) * this.img.width + this.ox + x) * 4;
  }

  /** Lay colour `c` over pixel (x, y) with coverage `a` (0..1); the pixel becomes at least that opaque. */
  px(x, y, c, a = 1) {
    const i = this.at(x, y);
    if (i < 0 || a <= 0) return;
    const d = this.img.data;
    const k = a >= 1 ? 1 : a;
    const old = d[i + 3] / 255;
    if (old <= 0) {
      d[i] = (c >> 16) & 255;
      d[i + 1] = (c >> 8) & 255;
      d[i + 2] = c & 255;
    } else {
      d[i] += (((c >> 16) & 255) - d[i]) * k;
      d[i + 1] += (((c >> 8) & 255) - d[i + 1]) * k;
      d[i + 2] += ((c & 255) - d[i + 2]) * k;
    }
    d[i + 3] = Math.max(d[i + 3], Math.round(k * 255));
  }

  /** Light pixel (x, y) by k (shade's rule), `a` of the way. */
  tone(x, y, k, a = 1) {
    const i = this.at(x, y);
    if (i < 0) return;
    const d = this.img.data;
    for (let c = 0; c < 3; c++) {
      const v = d[i + c];
      const t = k <= 1 ? v * k : v + (255 - v) * Math.min(1, k - 1);
      d[i + c] = v + (t - v) * a;
    }
  }

  /** The colour of pixel (x, y) (0 outside). */
  get(x, y) {
    const i = this.at(x, y);
    if (i < 0) return 0;
    const d = this.img.data;
    return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  }

  /** Make pixel (x, y) see-through. */
  clear(x, y) {
    const i = this.at(x, y);
    if (i >= 0) this.img.data[i + 3] = 0;
  }

  /** Fill the rectangle with a colour, or with `fn(x, y)` → colour. */
  fill(c) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.px(x, y, typeof c === 'function' ? c(x, y) : c, 1);
    return this;
  }

  /** A soft light down the rectangle: × `top` at the top row to × `bottom` at the last (shade's rule). */
  shadeV(top = 1.06, bottom = 0.86) {
    for (let y = 0; y < this.h; y++) {
      const t = this.h > 1 ? y / (this.h - 1) : 0;
      const k = top + (bottom - top) * t;
      for (let x = 0; x < this.w; x++) this.tone(x, y, k);
    }
    return this;
  }

  /**
   * Ambient occlusion baked toward edges: within `width` (a share of the rectangle) of an edge given a strength, the
   * pixels darken by up to that strength (0..1), easing in.
   * @param {{ top?: number, bottom?: number, left?: number, right?: number, width?: number }} o
   */
  ao({ top = 0, bottom = 0, left = 0, right = 0, width = 0.22 } = {}) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const fy = (y + 0.5) / this.h;
        const fx = (x + 0.5) / this.w;
        let s = 0;
        const edge = (dist, k) => {
          if (k > 0 && dist < width) s = Math.max(s, k * (1 - dist / width) ** 2);
        };
        edge(fy, top);
        edge(1 - fy, bottom);
        edge(fx, left);
        edge(1 - fx, right);
        if (s > 0) this.tone(x, y, 1 - s);
      }
    }
    return this;
  }

  /** Multiply every pixel by 1 + amount × (fractal noise − 0.5): a soft unevenness. */
  mottle(amount = 0.08, scale = 6, seed = this.seed) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) this.tone(x, y, 1 + amount * (fbm(x / scale, y / scale, seed) - 0.5) * 2);
    }
    return this;
  }

  /** An anti-aliased ellipse centred (cx, cy), radii rx, ry, turned `rot` radians. */
  ellipse(cx, cy, rx, ry, c, a = 1, rot = 0) {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const R = Math.max(rx, ry) + 1;
    const mn = Math.max(0.0001, Math.min(rx, ry));
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = (dx * cs + dy * sn) / rx;
        const v = (-dx * sn + dy * cs) / ry;
        const q = Math.sqrt(u * u + v * v);
        const cover = clamp01(0.5 - (q - 1) * mn);
        if (cover > 0) this.px(x, y, c, cover * a);
      }
    }
    return this;
  }

  /** An anti-aliased stroke from (x0, y0) to (x1, y1), `r` pixels either side, round ends. */
  line(x0, y0, x1, y1, r, c, a = 1) {
    const minX = Math.floor(Math.min(x0, x1) - r - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + r + 1);
    const minY = Math.floor(Math.min(y0, y1) - r - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + r + 1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const L = dx * dx + dy * dy || 1e-9;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const t = clamp01((px * dx + py * dy) / L);
        const d = Math.hypot(px - dx * t, py - dy * t);
        const cover = clamp01(r + 0.5 - d);
        if (cover > 0) this.px(x, y, c, cover * a);
      }
    }
    return this;
  }

  /** A stroke through several points. @param {number[][]} pts */
  polyline(pts, r, c, a = 1) {
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, c, a);
    return this;
  }

  /** An arc of the circle (cx, cy, rad) from angle a0 to a1 (radians, y down), as a stroke. */
  arc(cx, cy, rad, a0, a1, r, c, a = 1, ry = rad) {
    const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) * Math.max(rad, ry) / 1.5));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * ry]);
    }
    return this.polyline(pts, r, c, a);
  }

  /** A soft round glow: colour c laid with coverage a at the middle, fading to nothing at radius (rx, ry). */
  glow(cx, cy, rx, c, a = 1, ry = rx) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const q = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
        if (q < 1) this.px(x, y, c, a * smooth(1 - q));
      }
    }
    return this;
  }

  /** Short dashes along a line: stitching. */
  stitches(x0, y0, x1, y1, c, { dash = 1.6, gap = 1.6, r = 0.45, a = 0.9 } = {}) {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / (L || 1);
    const uy = (y1 - y0) / (L || 1);
    for (let s = gap / 2; s + dash <= L; s += dash + gap) {
      this.line(x0 + ux * s, y0 + uy * s, x0 + ux * (s + dash), y0 + uy * (s + dash), r, c, a);
    }
    return this;
  }

  /** A sewn seam: a dark crease with a light ridge beside it and a row of stitches. */
  seam(x0, y0, x1, y1, ramp, { stitch = true } = {}) {
    const L = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / L;
    const ny = (x1 - x0) / L;
    this.line(x0, y0, x1, y1, 0.5, ramp[2], 0.75);
    this.line(x0 + nx, y0 + ny, x1 + nx, y1 + ny, 0.45, ramp[0], 0.45);
    if (stitch) this.stitches(x0 - nx * 1.6, y0 - ny * 1.6, x1 - nx * 1.6, y1 - ny * 1.6, ramp[0], { a: 0.55 });
    return this;
  }

  /** A hem: a band of `h` rows from row y, turned (darker, a crease at its top) and stitched. */
  hem(y, h, ramp, { stitchColor = ramp[0] } = {}) {
    for (let yy = Math.floor(y); yy < y + h; yy++) for (let x = 0; x < this.w; x++) this.tone(x, yy, 0.92);
    this.line(-1, y, this.w + 1, y, 0.5, ramp[2], 0.8);
    this.line(-1, y + 1, this.w + 1, y + 1, 0.4, ramp[0], 0.35);
    this.stitches(0, y + h / 2 + 0.5, this.w, y + h / 2 + 0.5, stitchColor, { a: 0.5 });
    return this;
  }

  /** Cut the edge ragged: within `depth` rows of the bottom (or top), a torn line; below it the pixels are clear. */
  ragged({ edge = 'bottom', depth = 4, period = 5, seed = this.seed } = {}) {
    for (let x = 0; x < this.w; x++) {
      const n = fbm(x / period, 0.5, seed, 2);
      const tooth = hash2(x, 7, seed) < 0.18 ? 1.5 : 0;
      const cut = Math.max(0, Math.round(depth * n + tooth));
      for (let k = 0; k < cut; k++) this.clear(x, edge === 'bottom' ? this.h - 1 - k : k);
      // the frayed rim just inside the tear is darker
      const rim = edge === 'bottom' ? this.h - 1 - cut : cut;
      this.tone(x, rim, 0.72);
      this.tone(x, edge === 'bottom' ? rim - 1 : rim + 1, 0.86);
    }
    return this;
  }

  // ---- materials (each fills the whole rectangle) ----

  /** Woven cloth: the mid colour with a fine weave, threads of uneven tone and a few soft folds. @param {number[]} ramp [light, mid, dark] */
  cloth(ramp, { fold = 1, scale = 1 } = {}) {
    const s = this.seed;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const weave = ((x + y) & 1 ? 1.025 : 0.975);
        const thread = 1 + 0.05 * (hash2(x, 0, s) - 0.5) + 0.05 * (hash2(0, y, s + 1) - 0.5);
        const f = fbm(x / (9 * scale), y / (20 * scale), s + 2);
        let c = ramp[1];
        if (f < 0.38) c = mix(ramp[1], ramp[2], ((0.38 - f) / 0.38) * 0.8 * fold);
        else if (f > 0.62) c = mix(ramp[1], ramp[0], ((f - 0.62) / 0.38) * 0.8 * fold);
        this.px(x, y, shade(c, weave * thread), 1);
      }
    }
    return this;
  }

  /** Denim: a diagonal twill, white flecks, worn paler in soft streaks. @param {number[]} ramp [light, mid, dark] */
  denim(ramp) {
    const s = this.seed;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = ((x - y) % 4 + 4) % 4;
        const tw = t === 0 ? 0.86 : t === 2 ? 1.06 : 1;
        const wear = fbm(x / 7, y / 26, s);
        let c = mix(ramp[1], wear > 0.55 ? ramp[0] : ramp[2], Math.abs(wear - 0.55) * 1.4);
        if (hash2(x, y, s + 5) < 0.05) c = mix(c, 0xf2f4f8, 0.35);
        this.px(x, y, shade(c, tw), 1);
      }
    }
    return this;
  }

  /**
   * Plaid flannel: cloth crossed by darker bands every `cell` pixels (`band` wide, darker where two cross) and a thin
   * light line between them. @param {number[]} ramp [light, mid, dark]
   */
  plaid(ramp, { cell = 12, band = 4, line = ramp[0] } = {}) {
    this.cloth(ramp, { fold: 0.6 });
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const bx = (x % cell) < band;
        const by = (y % cell) < band;
        if (bx || by) this.tone(x, y, bx && by ? 0.7 : 0.84);
        if ((x % cell) === band + Math.floor((cell - band) / 2) || (y % cell) === band + Math.floor((cell - band) / 2)) this.px(x, y, line, 0.35);
      }
    }
    return this;
  }

  /** A tear: a dark ragged hole with frayed threads round it (no wound, no skin: just old cloth). */
  tear(cx, cy, r, ramp, under = shade(ramp[2], 0.55)) {
    const rnd = makeRng(this.seed + Math.round(cx * 7 + cy * 13));
    const pts = [];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const rr = r * (0.6 + 0.6 * rnd());
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8]);
    }
    for (const [x, y] of pts) this.ellipse((x + cx) / 2, (y + cy) / 2, r * 0.55, r * 0.45, under, 1, rnd() * 3);
    for (const [x, y] of pts) this.line(x, y, x + (x - cx) * 0.35, y + (y - cy) * 0.35 + 1, 0.4, ramp[0], 0.7);
    return this;
  }

  /** A sewn-on patch: a rectangle of another cloth, cross-stitched round its edge. */
  patch(x, y, w, h, ramp, thread) {
    for (let yy = Math.floor(y); yy < y + h; yy++) {
      for (let xx = Math.floor(x); xx < x + w; xx++) this.px(xx, yy, shade(ramp[1], 0.95 + 0.1 * hash2(xx, yy, this.seed)), 1);
    }
    this.line(x, y + h, x + w, y + h, 0.5, ramp[2], 0.8);
    this.line(x + w, y, x + w, y + h, 0.5, ramp[2], 0.8);
    for (let k = 1.5; k < w - 1; k += 3) {
      this.line(x + k - 1, y + 0.5, x + k + 1, y + 2, 0.35, thread, 0.9);
      this.line(x + k - 1, y + h - 0.5, x + k + 1, y + h - 2, 0.35, thread, 0.9);
    }
    for (let k = 1.5; k < h - 1; k += 3) {
      this.line(x + 0.5, y + k - 1, x + 2, y + k + 1, 0.35, thread, 0.9);
      this.line(x + w - 0.5, y + k - 1, x + w - 2, y + k + 1, 0.35, thread, 0.9);
    }
    return this;
  }

  /** A knit: rows of V stitches (each `cell` pixels), lit on their upper side. @param {number[]} ramp */
  knit(ramp, { cell = 4 } = {}) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const cx = (x % cell) + 0.5;
        const cy = (y % cell) + 0.5;
        const half = cell / 2;
        // the two legs of a V: from the cell's top corners to its bottom middle
        const leg = Math.abs(Math.abs(cx - half) - (half * (1 - cy / cell)));
        const k = leg < 0.9 ? 1.08 - 0.1 * (cy / cell) : 0.86;
        this.px(x, y, shade(ramp[1], k * (1 + 0.04 * (hash2(x, y, this.seed) - 0.5))), 1);
      }
    }
    return this;
  }

  /** Skin: the mid tone with the faintest warm unevenness. @param {number[]} ramp [light, mid, dark, …] */
  skin(ramp) {
    const s = this.seed;
    this.fill((x, y) => {
      const n = fbm(x / 5, y / 5, s);
      return n > 0.6 ? mix(ramp[1], ramp[0], (n - 0.6) * 1.2) : n < 0.4 ? mix(ramp[1], ramp[2], (0.4 - n) * 0.8) : ramp[1];
    });
    return this;
  }

  /**
   * Fur: short strokes laid along `dir` (a unit [x, y], y down), light and dark, over the mid tone.
   * @param {number[]} ramp [light, mid, dark]
   */
  fur(ramp, { dir = [0, 1], len = 5, density = 0.5, width = 0.5 } = {}) {
    this.skin([ramp[0], ramp[1], ramp[2]]);
    const rnd = makeRng(this.seed + 11);
    const n = Math.round(this.w * this.h * density / Math.max(1, len));
    for (let i = 0; i < n; i++) {
      const x = rnd() * this.w;
      const y = rnd() * this.h;
      const a = Math.atan2(dir[1], dir[0]) + (rnd() - 0.5) * 0.6;
      const l = len * (0.7 + 0.6 * rnd());
      const c = rnd() < 0.5 ? ramp[0] : ramp[2];
      this.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, width, c, 0.35 + 0.35 * rnd());
    }
    return this;
  }

  /** Curly wool: rings of fleece on a jittered grid, each lit at its top and shadowed below. @param {number[]} ramp */
  wool(ramp, { r = 3 } = {}) {
    this.fill(ramp[2]);
    this.mottle(0.06, 4);
    const rnd = makeRng(this.seed + 3);
    const step = r * 1.55;
    for (let gy = -1; gy * step < this.h + step; gy++) {
      for (let gx = -1; gx * step < this.w + step; gx++) {
        const x = (gx + (gy & 1 ? 0.5 : 0)) * step + (rnd() - 0.5) * r;
        const y = gy * step + (rnd() - 0.5) * r;
        const rr = r * (0.75 + 0.4 * rnd());
        this.ellipse(x + 0.6, y + 0.9, rr, rr * 0.85, shade(ramp[2], 0.85), 0.5);
        this.ellipse(x, y, rr, rr * 0.85, ramp[1], 1);
        this.arc(x, y, rr * 0.55, Math.PI * 1.05, Math.PI * 1.95, 0.55, ramp[0], 0.9, rr * 0.45);
        this.arc(x, y, rr * 0.5, 0.1 * Math.PI, 0.9 * Math.PI, 0.45, ramp[2], 0.6, rr * 0.4);
      }
    }
    return this;
  }

  /**
   * Leaves: overlapping almond leaves, each lit along one side, with a vein down the middle, over a dark under-leaf.
   * @param {number[]} ramp [light, mid, dark, deep]
   */
  leaves(ramp, { size = 7, density = 1, up = 0.6 } = {}) {
    this.fill(ramp[3] ?? shade(ramp[2], 0.7));
    this.mottle(0.12, 5);
    const rnd = makeRng(this.seed + 21);
    const n = Math.round((this.w * this.h * density * 2.2) / (size * size * 0.5));
    for (let i = 0; i < n; i++) {
      const x = rnd() * this.w;
      const y = rnd() * this.h;
      // mostly pointing up and out, some any way
      const ang = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * (2 - up * 1.4);
      const L = size * (0.75 + 0.6 * rnd());
      const W = L * (0.32 + 0.12 * rnd());
      const depth = y / this.h;
      const base = mix(ramp[1], ramp[0], rnd() * 0.7 * (1 - depth * 0.6));
      this.leaf(x, y, ang, L, W, base, ramp[2]);
    }
    return this;
  }

  /** One almond leaf from (x, y) along angle `ang`, length L, half-width W. */
  leaf(x, y, ang, L, W, c, vein) {
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const R = L + 1;
    for (let py = Math.floor(y - R); py <= Math.ceil(y + R); py++) {
      for (let px = Math.floor(x - R); px <= Math.ceil(x + R); px++) {
        const dx = px + 0.5 - x;
        const dy = py + 0.5 - y;
        const t = (dx * cs + dy * sn) / L; // along 0..1
        const s = -dx * sn + dy * cs; // across
        if (t <= 0 || t >= 1) continue;
        const half = W * Math.sin(Math.PI * Math.pow(t, 0.8));
        const cover = clamp01(half + 0.5 - Math.abs(s));
        if (cover <= 0) continue;
        // lit on one side of the vein, darker at the edge, the vein itself a fine line
        const side = s / (half || 1);
        let k = side < 0 ? 1.1 - 0.12 * Math.abs(side) : 0.9 - 0.1 * side;
        k *= 0.92 + 0.12 * t;
        this.px(px, py, shade(c, k), cover);
        if (Math.abs(s) < 0.45 && t < 0.88) this.px(px, py, vein, 0.45 * cover);
      }
    }
  }

  /** Bark: long ridges and dark fissures running down, a few knots. @param {number[]} ramp [light, mid, dark] */
  bark(ramp) {
    const s = this.seed;
    this.fill((x, y) => {
      const ridge = fbm(x / 2.2, y / 16, s, 3);
      const fine = hash2(x, Math.floor(y / 3), s + 1);
      let c = ramp[1];
      if (ridge < 0.36) c = mix(ramp[2], shade(ramp[2], 0.7), (0.36 - ridge) * 2);
      else if (ridge > 0.6) c = mix(ramp[1], ramp[0], (ridge - 0.6) * 2);
      return shade(c, 0.95 + 0.1 * fine);
    });
    return this;
  }

  /**
   * Hair: strands running along `dir` in the hair's tones, a soft sheen across them at `sheen` (a share down the
   * rectangle; −1: none). @param {number[]} ramp [highlight, light, mid, dark]
   */
  hair(ramp, { dir = [0, 1], sheen = 0.3, strand = 3 } = {}) {
    const s = this.seed;
    const ang = Math.atan2(dir[1], dir[0]);
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    this.fill((x, y) => {
      const along = x * cs + y * sn;
      const across = -x * sn + y * cs;
      const n = fbm(across / strand, along / 18, s, 3);
      const fine = hash2(Math.floor(across), 3, s);
      let c = n > 0.55 ? mix(ramp[2], ramp[1], (n - 0.55) * 2.2) : mix(ramp[2], ramp[3], (0.55 - n) * 1.6);
      c = shade(c, 0.94 + 0.12 * fine);
      if (sheen >= 0) {
        const band = Math.abs(y / this.h - sheen - 0.05 * Math.sin(x / 4)) * 9;
        if (band < 1) c = mix(c, ramp[0], 0.55 * (1 - band) * (n > 0.4 ? 1 : 0.4));
      }
      return c;
    });
    return this;
  }

  /** Stone: soft blotches and a few fine cracks. @param {number[]} ramp [light, mid, dark] */
  stone(ramp) {
    const s = this.seed;
    this.fill((x, y) => {
      const n = fbm(x / 6, y / 6, s, 4);
      return n > 0.56 ? mix(ramp[1], ramp[0], (n - 0.56) * 2.5) : n < 0.42 ? mix(ramp[1], ramp[2], (0.42 - n) * 2.5) : ramp[1];
    });
    const rnd = makeRng(s + 9);
    for (let i = 0; i < (this.w * this.h) / 300; i++) {
      let x = rnd() * this.w;
      let y = rnd() * this.h;
      const pts = [[x, y]];
      for (let k = 0; k < 4; k++) {
        x += (rnd() - 0.5) * 8;
        y += (rnd() - 0.5) * 8;
        pts.push([x, y]);
      }
      this.polyline(pts, 0.45, ramp[2], 0.6);
    }
    return this;
  }

  /**
   * Feathers: staggered rows of rounded feather tips pointing down the rectangle (toward its last row), each with a dark
   * shaft and a pale fringe at its tip, the rows nearer the top laid over the ones below (as feathers lie, tips toward the
   * tail). @param {number[]} ramp [light, mid, dark] @param {{ size?: number, edge?: number, vary?: number }} [o]
   */
  feathers(ramp, { size = 6, edge = ramp[0], vary = 0.35 } = {}) {
    this.fill(ramp[2]);
    const rnd = makeRng(this.seed + 7);
    const sx = size * 0.92;
    const sy = size * 0.72;
    const rows = Math.ceil(this.h / sy) + 2;
    const cols = Math.ceil(this.w / sx) + 2;
    // the tail end first, so each row toward the head lies over the base of the row behind it
    for (let gy = rows; gy >= -1; gy--) {
      for (let gx = -1; gx <= cols; gx++) {
        const x = (gx + (gy & 1 ? 0.5 : 0)) * sx + (rnd() - 0.5) * size * 0.18;
        const y = gy * sy + (rnd() - 0.5) * size * 0.12;
        const c = mix(ramp[1], rnd() < 0.5 ? ramp[0] : ramp[2], rnd() * vary);
        this.ellipse(x + 0.4, y + size * 0.18, size * 0.56, size * 0.64, shade(c, 0.72), 0.85);
        this.ellipse(x, y, size * 0.5, size * 0.58, c, 1);
        this.line(x, y - size * 0.55, x, y + size * 0.32, Math.max(0.3, size * 0.05), shade(c, 0.68), 0.55);
        this.arc(x, y + size * 0.02, size * 0.44, 0.12 * Math.PI, 0.88 * Math.PI, Math.max(0.35, size * 0.07), edge, 0.7, size * 0.52);
      }
    }
    return this;
  }

  /**
   * Scales: small overlapping arcs in staggered rows (a fish), each lit along its rim with a darker crescent under it.
   * @param {number[]} ramp [light, mid, dark] @param {{ size?: number }} [o]
   */
  scales(ramp, { size = 4 } = {}) {
    const rnd = makeRng(this.seed + 13);
    const sx = size;
    const sy = size * 0.62;
    for (let gy = Math.ceil(this.h / sy) + 1; gy >= -1; gy--) {
      for (let gx = -1; gx <= Math.ceil(this.w / sx) + 1; gx++) {
        const x = (gx + (gy & 1 ? 0.5 : 0)) * sx;
        const y = gy * sy;
        this.arc(x, y, size * 0.5, 0.1 * Math.PI, 0.9 * Math.PI, Math.max(0.3, size * 0.08), ramp[2], 0.45, size * 0.42);
        this.arc(x, y - size * 0.1, size * 0.46, 0.15 * Math.PI, 0.85 * Math.PI, Math.max(0.3, size * 0.06), ramp[0], 0.35 + 0.25 * rnd(), size * 0.36);
      }
    }
    return this;
  }

  /** Grass seen from above: blades of the ramp's greens over a darker ground. @param {number[]} ramp [light, mid, dark] */
  grass(ramp) {
    this.fill(ramp[2]);
    this.mottle(0.14, 7);
    const rnd = makeRng(this.seed + 4);
    for (let i = 0; i < this.w * this.h * 0.18; i++) {
      const x = rnd() * this.w;
      const y = rnd() * this.h;
      const a = rnd() * Math.PI * 2;
      const l = 1.5 + rnd() * 2.5;
      this.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.45, rnd() < 0.5 ? ramp[0] : ramp[1], 0.6);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------------------------------

/** The white of a cheerful eye. */
export const EYE_WHITE = 0xfbfaf4;

/**
 * @typedef {Object} FaceStyle
 * @property {'kid'|'zombie'} [kind]
 * @property {number[]} skin    [light, mid, dark, deep]
 * @property {number[]} [eyes]  [iris, deep]
 * @property {number} [brows]
 * @property {number} [mouth]
 * @property {number} [blush]
 * @property {boolean} [lashes]
 * @property {boolean} [freckles]
 * @property {number} [eyeY]     the eyes' middle, a share down the face
 * @property {number} [eyeGap]   between the eyes' middles, a share of its width
 * @property {number} [eyeW]     an eye's width, a share of the face's width
 * @property {number} [mouthY]   a share down the face
 */

/**
 * Paint a face over the whole rectangle (already filled with skin): a kid's — whites, an iris with a darker rim, its
 * pupil and a catchlight, a lid line, brows, a soft smile with a lit lower lip, rosy cheeks — or a zombie's: sunken
 * hollows round narrow dark slits, level brows, a slack mouth, hollow cheeks (spooky, never gory, nothing red).
 * @param {Painter} p
 * @param {FaceStyle} f
 */
export function paintFace(p, f) {
  const W = p.w;
  const H = p.h;
  const kind = f.kind ?? 'kid';
  const eyeY = (f.eyeY ?? 0.52) * H;
  const gap = (f.eyeGap ?? 0.36) * W;
  const ew = (f.eyeW ?? 0.17) * W;
  const eh = ew * (kind === 'kid' ? 0.78 : 0.3);
  const skin = f.skin;
  const deep = skin[3] ?? shade(skin[2], 0.8);
  for (const side of [-1, 1]) {
    const cx = W / 2 + (side * gap) / 2;
    if (kind === 'zombie') {
      // a sunken hollow round each eye, a narrow dark slit, a heavy lid over it
      p.glow(cx, eyeY + eh * 0.2, ew * 0.95, deep, 0.75, ew * 0.75);
      p.glow(cx, eyeY + eh * 0.9, ew * 0.8, shade(deep, 0.8), 0.35, ew * 0.4);
      p.ellipse(cx, eyeY, ew * 0.46, eh * 0.7, 0x0e110e, 1);
      p.ellipse(cx + side * ew * 0.12, eyeY - eh * 0.1, ew * 0.12, eh * 0.28, 0x3c4a3c, 0.8);
      p.line(cx - ew * 0.55, eyeY - eh * 0.9, cx + ew * 0.55, eyeY - eh * 0.75, 0.7, shade(deep, 0.75), 0.9);
      // level, thin brows
      p.line(cx - ew * 0.55, eyeY - ew * 0.72, cx + ew * 0.5, eyeY - ew * 0.7, 0.75, f.brows ?? shade(deep, 0.6), 0.9);
      continue;
    }
    // the white, the iris (darker rim, lighter below), the pupil, a catchlight up and outward
    p.glow(cx, eyeY + eh * 0.15, ew * 0.75, skin[2], 0.25, eh * 0.95);
    p.ellipse(cx, eyeY, ew * 0.53, eh / 2, EYE_WHITE, 1);
    const ir = eh * 0.44;
    const ix = cx - side * ew * 0.06;
    const iris = (f.eyes ?? [0x5a7a8a, 0x34505c])[0];
    const irisDeep = (f.eyes ?? [0x5a7a8a, 0x34505c])[1];
    p.ellipse(ix, eyeY + eh * 0.05, ir, ir * 1.02, irisDeep, 1);
    p.ellipse(ix, eyeY + eh * 0.1, ir * 0.78, ir * 0.8, iris, 1);
    p.ellipse(ix, eyeY + eh * 0.24, ir * 0.55, ir * 0.42, shade(iris, 1.18), 0.7);
    p.ellipse(ix, eyeY + eh * 0.08, ir * 0.42, ir * 0.44, 0x1a1614, 1);
    p.ellipse(ix + side * ir * 0.38, eyeY - eh * 0.16, Math.max(0.7, ir * 0.24), Math.max(0.7, ir * 0.24), 0xffffff, 1);
    // the upper lid: a dark line over the eye, thicker outward; lashes flick out
    const lid = f.lashes ? 0x2a1f1c : shade(deep, 0.6);
    p.arc(cx, eyeY + eh * 0.12, ew * 0.52, Math.PI * 1.08, Math.PI * 1.92, f.lashes ? 0.85 : 0.65, lid, 1, eh * 0.66);
    if (f.lashes) p.line(cx + side * ew * 0.48, eyeY - eh * 0.25, cx + side * ew * 0.72, eyeY - eh * 0.55, 0.6, lid, 1);
    // the brow: a soft arch
    const by = eyeY - ew * 0.72;
    p.arc(cx, by + ew * 0.28, ew * 0.6, Math.PI * 1.15, Math.PI * 1.85, 0.95, f.brows ?? shade(deep, 0.5), 0.95, ew * 0.3);
    // a rosy cheek under it
    if (f.blush !== undefined) p.glow(cx + side * ew * 0.25, eyeY + ew * 0.95, ew * 0.62, f.blush, 0.55, ew * 0.38);
    if (f.freckles) {
      for (let k = 0; k < 4; k++) {
        p.ellipse(cx + side * (ew * (0.05 + 0.18 * k)), eyeY + ew * (0.72 + 0.1 * (k % 2)), 0.6, 0.6, skin[2], 0.7);
      }
    }
  }
  // the nose's shadow (the nose itself is a shape on the head)
  p.glow(W / 2 + W * 0.02, eyeY + ew * 1.05, ew * 0.45, skin[2], 0.4, ew * 0.25);
  const my = (f.mouthY ?? 0.8) * H;
  if (kind === 'zombie') {
    // hollow cheeks and a slack, closed-off mouth
    for (const side of [-1, 1]) p.glow(W / 2 + side * gap * 0.62, my - H * 0.06, ew * 0.55, deep, 0.35, ew * 0.9);
    p.ellipse(W / 2, my, ew * 0.55, ew * 0.22, 0x221c1b, 1);
    p.ellipse(W / 2, my + ew * 0.32, ew * 0.4, ew * 0.08, shade(skin[0], 1.05), 0.5);
    p.line(W / 2 - ew * 0.5, my + ew * 0.05, W / 2 + ew * 0.5, my - ew * 0.02, 0.5, shade(deep, 0.7), 0.6);
    return;
  }
  // a soft smile: the corners up a little, a lit lower lip
  const mw = ew * 0.95;
  const mouth = f.mouth ?? 0x9c4b40;
  p.arc(W / 2, my - mw * 0.55, mw * 0.62, Math.PI * 0.2, Math.PI * 0.8, 0.85, mouth, 1, mw * 0.55);
  p.arc(W / 2, my - mw * 0.35, mw * 0.4, Math.PI * 0.3, Math.PI * 0.7, 0.6, shade(skin[0], 1.06), 0.6, mw * 0.45);
}

// ---------------------------------------------------------------------------------------------------
// The atlas: one image per model, its parts' rectangles packed in shelves with a gutter
// ---------------------------------------------------------------------------------------------------

export class Atlas {
  /** @param {number} width @param {number} height @param {number} [pad] the gutter round every rectangle */
  constructor(width, height, pad = 2) {
    this.img = createImage(width, height);
    this.pad = pad;
    /** @type {{ x: number, y: number, w: number }[]} the skyline: the top of what is packed, left to right */
    this.sky = [{ x: 0, y: 0, w: width }];
    /** @type {Rect[]} */
    this.rects = [];
  }

  /**
   * A new w × h rectangle, packed bottom-left on the skyline (as low as it fits, then as far left); a RangeError when
   * it does not fit at all. Asked for tallest first, it packs tightly.
   * @returns {Rect}
   */
  alloc(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const p = this.pad;
    const W = w + 2 * p;
    const H = h + 2 * p;
    const width = this.img.width;
    let best = null;
    for (let i = 0; i < this.sky.length; i++) {
      const x = this.sky[i].x;
      if (x + W > width) break;
      let y = 0;
      for (let j = i; j < this.sky.length && this.sky[j].x < x + W; j++) y = Math.max(y, this.sky[j].y);
      if (y + H <= this.img.height && (!best || y < best.y)) best = { x, y };
    }
    if (!best) throw new RangeError(`atlas: no room for ${w} × ${h}`);
    // raise the skyline under the new rectangle
    const { x, y } = best;
    const next = [];
    for (const seg of this.sky) {
      const end = seg.x + seg.w;
      if (end <= x || seg.x >= x + W) next.push(seg);
      else {
        if (seg.x < x) next.push({ x: seg.x, y: seg.y, w: x - seg.x });
        if (end > x + W) next.push({ x: x + W, y: seg.y, w: end - x - W });
      }
    }
    next.push({ x, y: y + H, w: W });
    next.sort((a2, b2) => a2.x - b2.x);
    this.sky = next.reduce((acc, seg) => {
      const last = acc[acc.length - 1];
      if (last && last.y === seg.y && last.x + last.w === seg.x) last.w += seg.w;
      else acc.push({ ...seg });
      return acc;
    }, /** @type {{ x: number, y: number, w: number }[]} */ ([]));
    /** @type {Rect} */
    const r = [x + p, y + p, w, h];
    this.rects.push(r);
    return r;
  }

  /** Pixels used (the rectangles, not their gutters). */
  used() {
    return this.rects.reduce((s, r) => s + r[2] * r[3], 0);
  }

  /** Fill every rectangle's gutter from its edge pixels (call after painting). */
  bleedAll() {
    for (const r of this.rects) bleed(this.img, r, this.pad);
    return this.img;
  }
}

/** Copy the edge pixels of `rect` out into a gutter `pad` wide round it (so filtering never reaches a neighbour). */
export function bleed(img, rect, pad) {
  const [x0, y0, w, h] = rect;
  const d = img.data;
  const W = img.width;
  const copy = (sx, sy, tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= W || ty >= img.height) return;
    const s = (sy * W + sx) * 4;
    const t = (ty * W + tx) * 4;
    d[t] = d[s];
    d[t + 1] = d[s + 1];
    d[t + 2] = d[s + 2];
    d[t + 3] = d[s + 3];
  };
  for (let k = 1; k <= pad; k++) {
    for (let x = x0 - k; x < x0 + w + k; x++) {
      const sx = Math.min(x0 + w - 1, Math.max(x0, x));
      copy(sx, y0, x, y0 - k);
      copy(sx, y0 + h - 1, x, y0 + h - 1 + k);
    }
    for (let y = y0 - k; y < y0 + h + k; y++) {
      const sy = Math.min(y0 + h - 1, Math.max(y0, y));
      copy(x0, sy, x0 - k, y);
      copy(x0 + w - 1, sy, x0 + w - 1 + k, y);
    }
  }
}
