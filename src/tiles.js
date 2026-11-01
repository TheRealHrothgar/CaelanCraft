// Caelancraft — procedural 16×16 tile painters. See src/CONTRACTS.md §15 and docs/SPEC-gameplay.md §2.2–§2.5.
//
// PURE: no DOM, no three, no imports, no Math.random. Every tile is painted from a private mulberry32 stream
// seeded with fnv1a(tileName), so textures never depend on the world seed and are bit-identical across runs.
// Output is a Uint8ClampedArray(16*16*4) in RGBA order with idx = (y*16 + x)*4; y grows DOWN the tile image
// (row 0 is the world-up edge of side faces, see CONTRACTS.md §0 — flipY = false).

const W = 16;
const H = 16;
const PIXELS = W * H;
const BYTES = PIXELS * 4;

/**
 * Tile id → tile name. Names are the lower_snake form of the `TILE` keys in blocks.js.
 * @type {Readonly<Record<number, string>>}
 */
export const TILE_NAMES = Object.freeze({
  0: 'stone',
  1: 'dirt',
  2: 'grass_top',
  3: 'grass_side',
  4: 'cobblestone',
  5: 'oak_planks',
  6: 'bedrock',
  7: 'water',
  8: 'sand',
  9: 'gravel',
  10: 'oak_log_side',
  11: 'oak_log_end',
  12: 'oak_leaves',
  13: 'glass',
  14: 'coal_ore',
  15: 'iron_ore',
  16: 'gold_ore',
  17: 'diamond_ore',
  18: 'sandstone_top',
  19: 'sandstone_side',
  20: 'snow',
  21: 'snowy_grass_side',
  22: 'bricks',
  23: 'bookshelf',
  24: 'stone_bricks',
  25: 'wool_white',
  26: 'wool_red',
  27: 'rune',
  255: 'missing',
});

// ---------------------------------------------------------------------------------------------------------------
// PRNG (SPEC-gameplay §2.3, verbatim). Private copies — tiles.js must not import noise.js.
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {() => number} Rng  uniform in [0,1) */

/**
 * @param {number} a uint32 seed
 * @returns {Rng}
 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit over UTF-16 code units.
 * @param {string} s
 * @returns {number} uint32
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {string} seedName @returns {Rng} */
function makeRng(seedName) {
  return mulberry32(fnv1a(seedName));
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel helpers (SPEC-gameplay §2.3). All channel writes go through a Uint8ClampedArray, which clamps to 0..255
// for free, so `adj(hex, d)` is expressed as "set to hex with delta d" and clamping never needs explicit code.
// Colours are packed 0xRRGGBB numbers.
// ---------------------------------------------------------------------------------------------------------------

/** @returns {number} byte offset of pixel (x, y) */
function idx(x, y) {
  return (y * W + x) * 4;
}

/** Wrap a (possibly out-of-range, possibly negative) pixel coordinate into 0..15 without `%`. */
function wrap16(v) {
  return v - Math.floor(v / 16) * 16;
}

/** `randInt(a, b)`: uniform integer in [a, b] inclusive. */
function randInt(rng, a, b) {
  return a + Math.floor(rng() * (b - a + 1));
}

/** `pick(list)`: uniform element of a non-empty list. */
function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** `fill(hex)`: every pixel to hex, alpha 255. */
function fill(px, hex) {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  for (let i = 0; i < BYTES; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

/**
 * `set(x, y, adj(hex, d), a)`: pixel (x, y) ← hex with `d` added to every channel (clamped). Callers pass
 * in-range coordinates; wrap with `wrap16` first where a recipe says "wrap".
 */
function set(px, x, y, hex, d = 0, a = 255) {
  const i = idx(x, y);
  px[i] = ((hex >> 16) & 255) + d;
  px[i + 1] = ((hex >> 8) & 255) + d;
  px[i + 2] = (hex & 255) + d;
  px[i + 3] = a;
}

/** `adj(pixel, d)`: add `d` to the R,G,B of the existing pixel (clamped); alpha untouched. */
function adjAt(px, x, y, d) {
  const i = idx(x, y);
  px[i] += d;
  px[i + 1] += d;
  px[i + 2] += d;
}

/** Signed noise delta in [-amp, amp] — the §2.3 formula `round((rng()*2-1)*amp)`. */
function delta(rng, amp) {
  return Math.round((rng() * 2 - 1) * amp);
}

/** `noise(amp)`: independent per-pixel grey delta added to R,G,B (alpha untouched). Pixels in idx order. */
function noise(px, rng, amp) {
  for (let i = 0; i < BYTES; i += 4) {
    const d = delta(rng, amp);
    px[i] += d;
    px[i + 1] += d;
    px[i + 2] += d;
  }
}

/** `cellNoise(size, amp)`: one grey delta per size×size cell, cells in row-major order. */
function cellNoise(px, rng, size, amp) {
  for (let cy = 0; cy < H; cy += size) {
    for (let cx = 0; cx < W; cx += size) {
      const d = delta(rng, amp);
      const yEnd = Math.min(cy + size, H);
      const xEnd = Math.min(cx + size, W);
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) adjAt(px, x, y, d);
      }
    }
  }
}

/** `speck(count, colors)`: `count` random pixels each set to a random listed colour (alpha 255). */
function speck(px, rng, count, colors) {
  for (let k = 0; k < count; k++) {
    const x = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    set(px, x, y, pick(rng, colors));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recipes (SPEC-gameplay §2.4). Each is `(px, rng) => void` where `rng` is seeded with the tile's own name.
// Composite recipes (grass_side, snowy_grass_side, ores, bookshelf) first run another tile's recipe with THAT
// tile's seed so the shared base is pixel-identical, then continue with their own stream.
// ---------------------------------------------------------------------------------------------------------------

/** 0 stone */
function paintStone(px, rng) {
  fill(px, 0x7e7e7e);
  cellNoise(px, rng, 2, 14);
  noise(px, rng, 5);
  speck(px, rng, 6, [0x6a6a6a]);
}

/** 1 dirt */
function paintDirt(px, rng) {
  fill(px, 0x866043);
  cellNoise(px, rng, 2, 16);
  noise(px, rng, 6);
  speck(px, rng, 10, [0x9b7653]);
  speck(px, rng, 6, [0x5c3f2a]);
}

/** 2 grass_top */
function paintGrassTop(px, rng) {
  fill(px, 0x5e9e3a);
  cellNoise(px, rng, 2, 18);
  noise(px, rng, 6);
  speck(px, rng, 8, [0x78b84a]);
  speck(px, rng, 8, [0x4a7f2c]);
}

/**
 * Shared shape of grass_side / snowy_grass_side: dirt base (seed "dirt"), then an overhang of `hMin + randInt(0,
 * hRand)` rows per column in `topHex ± topJitter`, and the dirt pixel just beneath darkened by `shade`.
 */
function paintOverhangSide(px, rng, hMin, hRand, topHex, topJitter, shade) {
  paintDirt(px, makeRng('dirt'));
  for (let x = 0; x < W; x++) {
    const h = hMin + randInt(rng, 0, hRand);
    for (let y = 0; y < h; y++) set(px, x, y, topHex, randInt(rng, -topJitter, topJitter));
    adjAt(px, x, h, shade);
  }
}

/** 3 grass_side — dirt base; per column h = 2 + randInt(0,2) rows of #5E9E3A ±10; (x,h) darkened by 14. */
function paintGrassSide(px, rng) {
  paintOverhangSide(px, rng, 2, 2, 0x5e9e3a, 10, -14);
}

/** 21 snowy_grass_side — dirt base; per column h = 3 + randInt(0,1) rows of #F2F8F8 ±4; (x,h) darkened by 10. */
function paintSnowyGrassSide(px, rng) {
  paintOverhangSide(px, rng, 3, 1, 0xf2f8f8, 4, -10);
}

/** 4 cobblestone — toroidal Voronoi with 9 seeds; thin mortar where the two nearest seeds are nearly tied. */
function paintCobblestone(px, rng) {
  const SEEDS = 9;
  const sx = new Array(SEEDS);
  const sy = new Array(SEEDS);
  const sg = new Array(SEEDS);
  for (let i = 0; i < SEEDS; i++) {
    sx[i] = randInt(rng, 0, 15);
    sy[i] = randInt(rng, 0, 15);
    sg[i] = 128 + randInt(rng, -22, 22);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      let g = 128;
      for (let i = 0; i < SEEDS; i++) {
        const ax = Math.abs(x - sx[i]);
        const ay = Math.abs(y - sy[i]);
        const dx = Math.min(ax, 16 - ax);
        const dy = Math.min(ay, 16 - ay);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          g = sg[i];
        } else if (d < d2) {
          d2 = d;
        }
      }
      if (d2 - d1 < 1.2) {
        set(px, x, y, 0x4a4a4a, randInt(rng, -4, 4));
      } else {
        set(px, x, y, (g << 16) | (g << 8) | g, randInt(rng, -6, 6));
      }
    }
  }
}

/** 5 oak_planks — four 4-row planks with dark seams, staggered end seams and grain streaks. */
function paintOakPlanks(px, rng) {
  const BASE = 0xa2824e;
  const SEAM = 0x6e5533;
  const END_SEAM_X = [11, 3, 13, 6];
  fill(px, BASE);
  // Per-plank tint on the plank body rows 4p..4p+2.
  for (let p = 0; p < 4; p++) {
    const d = randInt(rng, -8, 8);
    for (let y = 4 * p; y < 4 * p + 3; y++) {
      for (let x = 0; x < W; x++) adjAt(px, x, y, d);
    }
  }
  // Horizontal seams.
  for (const y of [3, 7, 11, 15]) {
    for (let x = 0; x < W; x++) set(px, x, y, SEAM);
  }
  // Vertical end seams, one per plank.
  for (let p = 0; p < 4; p++) {
    const x = END_SEAM_X[p];
    for (let y = 4 * p; y < 4 * p + 3; y++) set(px, x, y, SEAM);
  }
  // Grain streaks: 3 per plank, wrapping in x.
  for (let p = 0; p < 4; p++) {
    for (let s = 0; s < 3; s++) {
      const x0 = randInt(rng, 0, 15);
      const y = 4 * p + randInt(rng, 0, 2);
      const len = randInt(rng, 3, 6);
      for (let k = 0; k < len; k++) adjAt(px, wrap16(x0 + k), y, -14);
    }
  }
  noise(px, rng, 5);
}

/** 6 bedrock */
function paintBedrock(px, rng) {
  fill(px, 0x565656);
  cellNoise(px, rng, 2, 30);
  noise(px, rng, 8);
  speck(px, rng, 8, [0x2b2b2b]);
  speck(px, rng, 6, [0x8e8e8e]);
}

/** 7 water — blue noise, 6 lighter ripples of length 3 (wrap x), alpha 178 everywhere. */
function paintWater(px, rng) {
  fill(px, 0x3b6fd9);
  cellNoise(px, rng, 2, 12);
  noise(px, rng, 4);
  for (let k = 0; k < 6; k++) {
    const x0 = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    for (let i = 0; i < 3; i++) set(px, wrap16(x0 + i), y, 0x6a9bf0);
  }
  for (let i = 3; i < BYTES; i += 4) px[i] = 178;
}

/** 8 sand */
function paintSand(px, rng) {
  fill(px, 0xdbcfa3);
  cellNoise(px, rng, 2, 10);
  noise(px, rng, 5);
  speck(px, rng, 6, [0xc7b98a]);
}

/** 9 gravel — 40 small grey pebbles (1×1, 2×1, 1×2; wrap) over a grey base. */
function paintGravel(px, rng) {
  const SHAPES = [[1, 1], [2, 1], [1, 2]];
  fill(px, 0x7f7c7a);
  for (let k = 0; k < 40; k++) {
    const x0 = randInt(rng, 0, 15);
    const y0 = randInt(rng, 0, 15);
    const [w, h] = pick(rng, SHAPES);
    const g = randInt(rng, 94, 163);
    const hex = (g << 16) | (g << 8) | g;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) set(px, wrap16(x0 + dx), wrap16(y0 + dy), hex);
    }
  }
  noise(px, rng, 6);
}

/** 10 oak_log_side — vertical bark stripes with 3 dark cracks (clipped at the bottom edge). */
function paintOakLogSide(px, rng) {
  fill(px, 0x6b5032);
  for (let x = 0; x < W; x++) {
    const d = randInt(rng, -16, 16);
    for (let y = 0; y < H; y++) adjAt(px, x, y, d);
  }
  for (let k = 0; k < 3; k++) {
    const x = randInt(rng, 0, 15);
    const y0 = randInt(rng, 0, 8);
    const len = randInt(rng, 5, 10);
    const yEnd = Math.min(y0 + len, H);
    for (let y = y0; y < yEnd; y++) set(px, x, y, 0x4a3620);
  }
  noise(px, rng, 5);
}

/** 11 oak_log_end — Chebyshev rings: bark rim (r ≥ 6.5), rings at r ∈ {4.5, 2.5, 0.5}, wood elsewhere. */
function paintOakLogEnd(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (r >= 6.5) {
        set(px, x, y, 0x6b5032, randInt(rng, -10, 10));
      } else if (r === 4.5 || r === 2.5 || r === 0.5) {
        set(px, x, y, 0x8f7345);
      } else {
        set(px, x, y, 0xaf8f5a);
      }
    }
  }
  // noise(6) on the non-bark interior only.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (r < 6.5) adjAt(px, x, y, delta(rng, 6));
    }
  }
}

/** 12 oak_leaves — green noise; ~22% of pixels become alpha-0 holes (RGB kept so cutout edges stay green). */
function paintOakLeaves(px, rng) {
  fill(px, 0x4a8a2c);
  cellNoise(px, rng, 2, 16);
  noise(px, rng, 8);
  speck(px, rng, 12, [0x6baf3c]);
  for (let i = 3; i < BYTES; i += 4) px[i] = rng() < 0.22 ? 0 : 255;
}

/** 13 glass — transparent white interior, opaque pale frame with white corners and two diagonal streaks. */
function paintGlass(px) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onX = x === 0 || x === 15;
      const onY = y === 0 || y === 15;
      if (onX && onY) set(px, x, y, 0xffffff);
      else if (onX || onY) set(px, x, y, 0xe1eef3);
      else set(px, x, y, 0xffffff, 0, 0);
    }
  }
  for (let x = 1; x <= 4; x++) set(px, x, 5 - x, 0xe8f4fa);
  for (let x = 1; x <= 8; x++) set(px, x, 9 - x, 0xe8f4fa);
}

/**
 * 14–17 ores — stone base (seed "stone"), then `count` blobs. Each blob is anchored at (x,y) ∈ [1,13]² and
 * covers (x,y), (x+1,y), (x,y+1) always, (x+1,y+1) with p 0.5, (x−1,y) with p 0.35, (x,y+2) with p 0.25.
 * Every blob pixel is `main` with p 0.7 else `dark`; the anchor pixel becomes `highlight` when given.
 */
function paintOre(px, rng, count, main, dark, highlight = null) {
  paintStone(px, makeRng('stone'));
  for (let k = 0; k < count; k++) {
    const x = randInt(rng, 1, 13);
    const y = randInt(rng, 1, 13);
    set(px, x, y, highlight !== null ? highlight : oreColor(rng, main, dark));
    set(px, x + 1, y, oreColor(rng, main, dark));
    set(px, x, y + 1, oreColor(rng, main, dark));
    if (rng() < 0.5) set(px, x + 1, y + 1, oreColor(rng, main, dark));
    if (rng() < 0.35) set(px, x - 1, y, oreColor(rng, main, dark));
    if (rng() < 0.25) set(px, x, y + 2, oreColor(rng, main, dark));
  }
}

/** `main` with probability 0.7, else `dark`. */
function oreColor(rng, main, dark) {
  return rng() < 0.7 ? main : dark;
}

function paintCoalOre(px, rng) {
  paintOre(px, rng, 6, 0x161616, 0x3b3b3b);
}
function paintIronOre(px, rng) {
  paintOre(px, rng, 5, 0xd8af93, 0xb08466);
}
function paintGoldOre(px, rng) {
  paintOre(px, rng, 5, 0xfcee4b, 0xd4a82a);
}
function paintDiamondOre(px, rng) {
  paintOre(px, rng, 5, 0x5decf5, 0x2fb5c7, 0xe8ffff);
}

/** 18 sandstone_top */
function paintSandstoneTop(px, rng) {
  fill(px, 0xe0d5a8);
  cellNoise(px, rng, 2, 8);
  noise(px, rng, 4);
}

/** 19 sandstone_side — light cap rows, darker base rows, dotted strata at rows 5, 9, 13. */
function paintSandstoneSide(px, rng) {
  fill(px, 0xd9cd9d);
  for (let x = 0; x < W; x++) {
    set(px, x, 0, 0xe3d9af);
    set(px, x, 1, 0xe3d9af);
    set(px, x, 14, 0xcdbf8b);
    set(px, x, 15, 0xb9a874);
  }
  for (const y of [5, 9, 13]) {
    for (let x = 0; x < W; x++) {
      if (rng() < 0.7) set(px, x, y, 0xc3b27b);
    }
  }
  noise(px, rng, 5);
}

/** 20 snow */
function paintSnow(px, rng) {
  fill(px, 0xf2f8f8);
  cellNoise(px, rng, 2, 6);
  noise(px, rng, 3);
  speck(px, rng, 5, [0xdce6e6]);
}

/**
 * Shared brick layout for bricks / stone_bricks. Band b = floor(y/4), offset o = (b%2)*4. Mortar where
 * y%4 == 3 or (x+o)%8 == 7; otherwise a per-brick base tint (brick id (b, floor((x+o)/8))) plus per-pixel jitter.
 * (Plain `%` is fine here: x, y, o are never negative.)
 */
function paintBrickLayout(px, rng, mortarHex, mortarJitter, brickHex, brickJitter, pixelJitter) {
  // Per-brick base offsets, 4 bands × up to 3 brick columns (floor((x+o)/8) ∈ {0,1,2}).
  const brickD = new Array(4 * 3);
  for (let i = 0; i < brickD.length; i++) brickD[i] = randInt(rng, -brickJitter, brickJitter);
  for (let y = 0; y < H; y++) {
    const b = Math.floor(y / 4);
    const o = (b % 2) * 4;
    for (let x = 0; x < W; x++) {
      if (y % 4 === 3 || (x + o) % 8 === 7) {
        set(px, x, y, mortarHex, randInt(rng, -mortarJitter, mortarJitter));
      } else {
        const col = Math.floor((x + o) / 8);
        set(px, x, y, brickHex, brickD[b * 3 + col] + randInt(rng, -pixelJitter, pixelJitter));
      }
    }
  }
}

/** 22 bricks */
function paintBricks(px, rng) {
  paintBrickLayout(px, rng, 0xb4aea5, 4, 0x965040, 10, 5);
}

/** 24 stone_bricks — bricks layout in greys plus 3 chipped pixels. */
function paintStoneBricks(px, rng) {
  paintBrickLayout(px, rng, 0x4f4f4f, 4, 0x7a7a7a, 12, 5);
  for (let k = 0; k < 3; k++) adjAt(px, randInt(rng, 0, 15), randInt(rng, 0, 15), -20);
}

/** 23 bookshelf — oak_planks base (seed "oak_planks"); two shelves (rows 1–6, 9–14) packed with books. */
function paintBookshelf(px, rng) {
  const SHELF_BACK = 0x2b1f14;
  const WIDTHS = [1, 2, 2, 2, 3];
  const COLORS = [0xb23a2e, 0x3b5daa, 0x4e8c3a, 0xc8a43a, 0x7d4faf, 0xd9d2c4, 0x6a4a2b];
  const HEIGHTS = [5, 6, 6];
  paintOakPlanks(px, makeRng('oak_planks'));
  for (const shelfTop of [1, 9]) {
    for (let y = shelfTop; y <= shelfTop + 5; y++) {
      for (let x = 0; x < W; x++) set(px, x, y, SHELF_BACK);
    }
    let x = 0;
    while (x < W) {
      const w = pick(rng, WIDTHS);
      const color = pick(rng, COLORS);
      const h = pick(rng, HEIGHTS);
      const xEnd = Math.min(x + w - 1, 15);
      const yTop = shelfTop + 6 - h;
      const yBot = shelfTop + 5;
      for (let y = yTop; y <= yBot; y++) {
        for (let bx = x; bx <= xEnd; bx++) set(px, bx, y, color);
        adjAt(px, xEnd, y, -30);
      }
      x += w;
    }
  }
}

/** 25/26 wool — diagonal weave (every 4th diagonal darker / lighter) over a base colour, then soft noise. */
function paintWool(px, rng, baseHex) {
  fill(px, baseHex);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (x + y) % 4;
      if (k === 0) adjAt(px, x, y, -14);
      else if (k === 2) adjAt(px, x, y, 6);
    }
  }
  cellNoise(px, rng, 2, 6);
  noise(px, rng, 4);
}
function paintWoolWhite(px, rng) {
  paintWool(px, rng, 0xe9ecec);
}
function paintWoolRed(px, rng) {
  paintWool(px, rng, 0xa12722);
}

/**
 * Draw a 1-px line from (x0,y0) to (x1,y1) with `hex` (DDA over the longer axis; endpoints inclusive).
 * Coordinates outside the tile are skipped.
 */
function line(px, x0, y0, x1, y1, hex) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    if (x >= 0 && x < W && y >= 0 && y < H) set(px, x, y, hex);
  }
}

/**
 * 27 rune — the Rune Block: dark slate (0x2a2633, noise 6) with a glowing cyan honeycomb rune: a pointy-top
 * hexagon outline of radius 6 centred on (7.5, 7.5), three alternate spokes to the corners, a bright centre
 * dot, and a dim halo on the pixels next to the outline. Seed "rune".
 */
function paintRune(px, rng) {
  fill(px, 0x2a2633);
  noise(px, rng, 6);
  const CX = 7.5;
  const CY = 7.5;
  const R = 6;
  const corners = [];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180; // pointy-top: first corner straight up
    corners.push([CX + R * Math.cos(a), CY + R * Math.sin(a)]);
  }
  // Halo first so the bright outline overwrites it where they coincide.
  for (let k = 0; k < 6; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[(k + 1) % 6];
    const hx = (ax + bx) / 2 > CX ? 1 : -1;
    const hy = (ay + by) / 2 > CY ? 1 : -1;
    line(px, ax + hx, ay + hy, bx + hx, by + hy, 0x355a6b);
  }
  for (let k = 0; k < 6; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[(k + 1) % 6];
    line(px, ax, ay, bx, by, 0x7be8ff);
  }
  for (let k = 0; k < 6; k += 2) line(px, CX, CY, corners[k][0], corners[k][1], 0x5fc8e8);
  set(px, 7, 7, 0xd8f8ff);
  set(px, 8, 7, 0xd8f8ff);
  set(px, 7, 8, 0xd8f8ff);
  set(px, 8, 8, 0xd8f8ff);
}

/** 255 missing — 8×8 quadrant checker, magenta top-left / bottom-right, black elsewhere. */
function paintMissing(px) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      set(px, x, y, (x < 8) === (y < 8) ? 0xff00ff : 0x000000);
    }
  }
}

/** @type {Readonly<Record<string, (px: Uint8ClampedArray, rng: Rng) => void>>} */
const RECIPES = Object.freeze({
  stone: paintStone,
  dirt: paintDirt,
  grass_top: paintGrassTop,
  grass_side: paintGrassSide,
  cobblestone: paintCobblestone,
  oak_planks: paintOakPlanks,
  bedrock: paintBedrock,
  water: paintWater,
  sand: paintSand,
  gravel: paintGravel,
  oak_log_side: paintOakLogSide,
  oak_log_end: paintOakLogEnd,
  oak_leaves: paintOakLeaves,
  glass: paintGlass,
  coal_ore: paintCoalOre,
  iron_ore: paintIronOre,
  gold_ore: paintGoldOre,
  diamond_ore: paintDiamondOre,
  sandstone_top: paintSandstoneTop,
  sandstone_side: paintSandstoneSide,
  snow: paintSnow,
  snowy_grass_side: paintSnowyGrassSide,
  bricks: paintBricks,
  bookshelf: paintBookshelf,
  stone_bricks: paintStoneBricks,
  wool_white: paintWoolWhite,
  wool_red: paintWoolRed,
  rune: paintRune,
  missing: paintMissing,
});

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

/**
 * Resolve a tile id to its recipe name; anything that is not a known numeric tile id paints 'missing'.
 * @param {number} tile
 * @returns {string}
 */
function tileName(tile) {
  if (typeof tile === 'number' && Object.hasOwn(TILE_NAMES, tile)) return TILE_NAMES[tile];
  return 'missing';
}

/**
 * Paint one 16×16 tile. Deterministic: depends only on `tile`, never on the world seed or call order.
 * @param {number} tile  tile id (blocks.js TILE.*); unknown ids paint the magenta/black 'missing' checker
 * @returns {Uint8ClampedArray} fresh RGBA buffer of length 16*16*4, idx = (y*16 + x)*4
 */
export function paintTile(tile) {
  const name = tileName(tile);
  const px = new Uint8ClampedArray(BYTES);
  RECIPES[name](px, makeRng(name));
  return px;
}

/** @type {Map<string, [number, number, number]>} memo — tiles are deterministic so the mean never changes */
const averageCache = new Map();

/**
 * Mean RGB of the tile over pixels with alpha >= 128 (used for particles / tints).
 * @param {number} tile
 * @returns {[number, number, number]} [r, g, b] integers 0..255 (rounded mean); [0,0,0] if no pixel qualifies
 */
export function averageColor(tile) {
  const name = tileName(tile);
  const cached = averageCache.get(name);
  if (cached) return [cached[0], cached[1], cached[2]];
  const px = paintTile(tile);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < BYTES; i += 4) {
    if (px[i + 3] >= 128) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
      n++;
    }
  }
  /** @type {[number, number, number]} */
  const out = n === 0 ? [0, 0, 0] : [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  averageCache.set(name, out);
  return [out[0], out[1], out[2]];
}

/**
 * Convenience for the atlas builder: one zero-argument painter per known tile id (numeric keys, including 255).
 * @returns {Map<number, () => Uint8ClampedArray>}
 */
export function createTilePainters() {
  /** @type {Map<number, () => Uint8ClampedArray>} */
  const painters = new Map();
  for (const key of Object.keys(TILE_NAMES)) {
    const tile = Number(key);
    painters.set(tile, () => paintTile(tile));
  }
  return painters;
}
