// Caelancraft — seeding, hashing and simplex noise. See src/CONTRACTS.md §7. Pure.
//
// Everything here is deterministic for a given seed and never touches Math.random,
// window, document or performance. The noise sampler is Stefan Gustavson's simplex
// noise ("Simplex noise demystified", 2005, public domain) with a permutation table
// shuffled by mulberry32(seed) so that different seeds yield unrelated fields.
//
// noise2D / noise3D are hot paths for worldgen: they only use closure-captured typed
// arrays and local numbers, and allocate nothing per call.

/**
 * @typedef {Object} NoiseFn
 * @property {(x: number, y: number) => number} noise2D              simplex noise in [-1, 1]
 * @property {(x: number, y: number, z: number) => number} noise3D   simplex noise in [-1, 1]
 * @property {(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number) => number} fbm2D
 *           fractal Brownian motion, normalised to [-1, 1]; defaults octaves=4, lacunarity=2, gain=0.5
 * @property {(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number) => number} fbm3D
 */

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash over the UTF-16 code units of `str`.
 * @param {string} str
 * @returns {number} uint32
 */
export function hashString(str) {
  const s = String(str);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

const DECIMAL_INT_RE = /^-?\d+$/;

/**
 * Turn any user-facing seed into a uint32.
 *  - integer number → `n >>> 0`; any other number (fractional, NaN, ±Infinity) → hashString(String(n))
 *  - string matching /^-?\d+$/ → `Number(s) >>> 0`; any other string → hashString(s)
 *  - undefined / null → 0
 *  - anything else → hashString(String(value))
 * @param {number|string|null|undefined} [seed]
 * @returns {number} uint32
 */
export function normalizeSeed(seed) {
  if (seed === undefined || seed === null) return 0;
  if (typeof seed === 'number') {
    return Number.isInteger(seed) ? seed >>> 0 : hashString(String(seed));
  }
  if (typeof seed === 'string') {
    return DECIMAL_INT_RE.test(seed) ? Number(seed) >>> 0 : hashString(seed);
  }
  return hashString(String(seed));
}

/**
 * Mulberry32 PRNG. Small, fast and good enough for shuffling and world decoration.
 * @param {number} seed  coerced to uint32
 * @returns {() => number} next float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Integer lattice hashes
// ---------------------------------------------------------------------------------------------

/** The constant substituted for `y` so that hash2 reuses the hash3 mixer. */
const HASH2_Y = 0x5bd1e995;

/**
 * Well-mixed uint32 hash of an integer lattice point and a seed. Inputs are coerced with `|0`,
 * so negatives are fine and fractions truncate toward zero.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} seed
 * @returns {number} uint32
 */
export function hash3(x, y, z, seed) {
  // Additive pre-mix (§7): an XOR pre-mix would make hash(x,z) === hash(-x,-z) for a third of all
  // cells, mirroring trees/ores around the origin.
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1) + (seed | 0)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 2D lattice hash: `hash3(x, 0x5bd1e995, z, seed)`.
 * @param {number} x
 * @param {number} z
 * @param {number} seed
 * @returns {number} uint32
 */
export function hash2(x, z, seed) {
  return hash3(x, HASH2_Y, z, seed);
}

/** @returns {number} hash2 / 2^32, in [0, 1) */
export function rand2(x, z, seed) {
  return hash2(x, z, seed) / 4294967296;
}

/** @returns {number} hash3 / 2^32, in [0, 1) */
export function rand3(x, y, z, seed) {
  return hash3(x, y, z, seed) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------------------------

/** Linear interpolation; extrapolates for t outside [0, 1]. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp x to [lo, hi] (inclusive). NaN passes through. */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Hermite smoothstep: 0 for x <= e0, 1 for x >= e1, 3t² − 2t³ in between.
 * A degenerate edge (e0 === e1) never divides by zero.
 */
export function smoothstep(e0, e1, x) {
  if (x <= e0) return 0;
  if (x >= e1) return 1;
  const t = (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// Simplex noise (Gustavson)
// ---------------------------------------------------------------------------------------------

const SQRT3 = Math.sqrt(3);
/** 2D skew factor 0.5*(√3 − 1). */
const F2 = 0.5 * (SQRT3 - 1);
/** 2D unskew factor (3 − √3)/6. */
const G2 = (3 - SQRT3) / 6;
/** 3D skew factor. */
const F3 = 1 / 3;
/** 3D unskew factor. */
const G3 = 1 / 6;

/** The 12 edge-midpoint gradients of a cube, stored as three parallel arrays (no per-call indexing into nested arrays). */
const GRAD_X = new Int8Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GRAD_Y = new Int8Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GRAD_Z = new Int8Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

/**
 * Build the doubled permutation tables for a seed. Identity 0..255 is shuffled with a
 * Fisher–Yates pass driven by mulberry32(seed), then repeated once so `perm[i + perm[j]]`
 * never needs a mask.
 * @param {number} seed uint32
 * @returns {{ perm: Uint8Array, permMod12: Uint8Array }}
 */
function buildPermutation(seed) {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  return { perm, permMod12 };
}

/**
 * Create a seeded simplex-noise sampler.
 * @param {number|string} seed  uint32 (other values are passed through normalizeSeed)
 * @returns {NoiseFn}
 */
export function createNoise(seed) {
  const { perm, permMod12 } = buildPermutation(normalizeSeed(seed));

  /**
   * 2D simplex noise.
   * @param {number} xin
   * @param {number} yin
   * @returns {number} in [-1, 1]
   */
  function noise2D(xin, yin) {
    // Skew the input space to determine which simplex cell we're in.
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    // Unskewed distances from the cell origin.
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    // For the 2D case the simplex is an equilateral triangle: pick the middle corner.
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    // Hashed gradient indices of the three corners (`& 255` is two's-complement safe for negatives).
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = permMod12[ii + perm[jj]];
    const gi1 = permMod12[ii + i1 + perm[jj + j1]];
    const gi2 = permMod12[ii + 1 + perm[jj + 1]];
    // Contribution from each corner.
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      n0 = t0 * t0 * (GRAD_X[gi0] * x0 + GRAD_Y[gi0] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      n1 = t1 * t1 * (GRAD_X[gi1] * x1 + GRAD_Y[gi1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      n2 = t2 * t2 * (GRAD_X[gi2] * x2 + GRAD_Y[gi2] * y2);
    }
    // Scale to roughly [-1, 1], then clamp so callers can rely on the range exactly.
    const v = 70 * (n0 + n1 + n2);
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /**
   * 3D simplex noise.
   * @param {number} xin
   * @param {number} yin
   * @param {number} zin
   * @returns {number} in [-1, 1]
   */
  function noise3D(xin, yin, zin) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    // Determine which of the six tetrahedra we are in by ordering x0, y0, z0.
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }        // X Y Z
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }   // X Z Y
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }                 // Z X Y
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }         // Z Y X
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }    // Y Z X
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }                 // Y X Z
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const gi0 = permMod12[ii + perm[jj + perm[kk]]];
    const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
    const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
    const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      n0 = t0 * t0 * (GRAD_X[gi0] * x0 + GRAD_Y[gi0] * y0 + GRAD_Z[gi0] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      n1 = t1 * t1 * (GRAD_X[gi1] * x1 + GRAD_Y[gi1] * y1 + GRAD_Z[gi1] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      n2 = t2 * t2 * (GRAD_X[gi2] * x2 + GRAD_Y[gi2] * y2 + GRAD_Z[gi2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      t3 *= t3;
      n3 = t3 * t3 * (GRAD_X[gi3] * x3 + GRAD_Y[gi3] * y3 + GRAD_Z[gi3] * z3);
    }
    const v = 32 * (n0 + n1 + n2 + n3);
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /**
   * Number of octaves actually summed: floor(octaves), at least 1, so callers never get NaN
   * from an empty sum.
   * @param {number} octaves
   */
  function octaveCount(octaves) {
    const n = Math.floor(octaves);
    return n >= 1 ? n : 1;
  }

  /**
   * 2D fractal Brownian motion: Σ gain^i · noise2D(p · lacunarity^i), divided by Σ gain^i.
   * @param {number} x
   * @param {number} y
   * @param {number} [octaves=4]
   * @param {number} [lacunarity=2]
   * @param {number} [gain=0.5]
   * @returns {number} in [-1, 1]
   */
  function fbm2D(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    const n = octaveCount(octaves);
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < n; o++) {
      sum += amp * noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    const v = sum / norm;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /**
   * 3D fractal Brownian motion: Σ gain^i · noise3D(p · lacunarity^i), divided by Σ gain^i.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [octaves=4]
   * @param {number} [lacunarity=2]
   * @param {number} [gain=0.5]
   * @returns {number} in [-1, 1]
   */
  function fbm3D(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    const n = octaveCount(octaves);
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < n; o++) {
      sum += amp * noise3D(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    const v = sum / norm;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  return { noise2D, noise3D, fbm2D, fbm3D };
}
