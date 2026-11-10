// Caelancraft — procedural 16×16 tile painters. See src/CONTRACTS.md §15 and docs/SPEC-gameplay.md §2.2–§2.5.
//
// PURE: no DOM, no three, no Math.random; the only import is circuitTiles.js (the powder-and-circuits tiles and the Powder
// Keg's painters, DESIGN-circuits §6.2.9). Every tile is painted from a private mulberry32 stream
// seeded with fnv1a(tileName), so textures never depend on the world seed and are bit-identical across runs.
// Output is a Uint8ClampedArray(16*16*4) in RGBA order with idx = (y*16 + x)*4; y grows DOWN the tile image
// (row 0 is the world-up edge of side faces, see CONTRACTS.md §0 — flipY = false).
import { CIRCUIT_TILE_NAMES, CIRCUIT_RECIPES } from './circuitTiles.js';

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
  28: 'spruce_log_side',
  29: 'spruce_log_end',
  30: 'spruce_planks',
  31: 'spruce_leaves',
  32: 'birch_log_side',
  33: 'birch_log_end',
  34: 'birch_planks',
  35: 'birch_leaves',
  36: 'granite',
  37: 'diorite',
  38: 'andesite',
  39: 'slate',
  40: 'mossy_cobblestone',
  41: 'mossy_stone_bricks',
  42: 'obsidian',
  43: 'clay',
  44: 'red_sand',
  45: 'ice',
  46: 'packed_ice',
  47: 'coal_block',
  48: 'iron_block',
  49: 'gold_block',
  50: 'diamond_block',
  51: 'copper_block',
  52: 'glowstone',
  53: 'honeycomb',
  54: 'hay_bale_side',
  55: 'hay_bale_top',
  56: 'pumpkin_side',
  57: 'pumpkin_top',
  58: 'wool_orange',
  59: 'wool_yellow',
  60: 'wool_lime',
  61: 'wool_green',
  62: 'wool_cyan',
  63: 'wool_light_blue',
  64: 'wool_blue',
  65: 'wool_purple',
  66: 'wool_magenta',
  67: 'wool_pink',
  68: 'wool_brown',
  69: 'wool_black',
  70: 'wool_gray',
  71: 'wool_light_gray',
  72: 'black_hole',
  73: 'campfire_side',
  74: 'campfire_top',
  75: 'barrel_side',
  76: 'barrel_top',
  // v0.9 survival tiles (docs/DESIGN-survival.md §8.1)
  77: 'copper_ore',
  78: 'tin_ore',
  79: 'honeyberry_bush',
  80: 'honeyberry_bush_bare',
  81: 'tussock',
  82: 'cattails_side',
  83: 'cattails_top',
  84: 'tuber_plant',
  85: 'prickly_pear',
  86: 'prickly_pear_bare',
  87: 'stump_side',
  88: 'stump_top',
  89: 'kiln_side',
  90: 'kiln_top',
  91: 'bloomery_side',
  92: 'bloomery_top',
  93: 'forge_side',
  94: 'forge_top',
  95: 'basket_side',
  96: 'basket_top',
  97: 'hide_side',
  98: 'hide_top',
  99: 'remains_side',
  100: 'remains_top',
  101: 'plant_top_clear',
  102: 'loose_stones',
  103: 'fallen_branches',
  104: 'fire_pit_side',
  // powder and circuits: 160–194 (DESIGN-circuits §1.4), painted by circuitTiles.js
  ...CIRCUIT_TILE_NAMES,
  240: 'zombie_face',
  241: 'zombie_head_side',
  242: 'zombie_scalp',
  243: 'zombie_shirt',
  244: 'zombie_trousers',
  245: 'zombie_sole',
  250: 'watcher_stone',
  251: 'watcher_cracks',
  252: 'watcher_smoke',
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
  paintPlanks(px, rng, 0xa2824e, 0x6e5533);
}

/** Shared plank layout for oak / spruce / birch planks. */
function paintPlanks(px, rng, BASE, SEAM) {
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
  paintBarkSide(px, rng, 0x6b5032, 0x4a3620);
}

/** Shared bark: per-column ±16 stripes over `barkHex`, then 3 vertical cracks in `crackHex`, noise 5. */
function paintBarkSide(px, rng, barkHex, crackHex) {
  fill(px, barkHex);
  for (let x = 0; x < W; x++) {
    const d = randInt(rng, -16, 16);
    for (let y = 0; y < H; y++) adjAt(px, x, y, d);
  }
  for (let k = 0; k < 3; k++) {
    const x = randInt(rng, 0, 15);
    const y0 = randInt(rng, 0, 8);
    const len = randInt(rng, 5, 10);
    const yEnd = Math.min(y0 + len, H);
    for (let y = y0; y < yEnd; y++) set(px, x, y, crackHex);
  }
  noise(px, rng, 5);
}

/** 11 oak_log_end — Chebyshev rings: bark rim (r ≥ 6.5), rings at r ∈ {4.5, 2.5, 0.5}, wood elsewhere. */
function paintOakLogEnd(px, rng) {
  paintLogEnd(px, rng, 0x6b5032, 0x8f7345, 0xaf8f5a);
}

/** Shared log end: bark rim, ring and wood colours. */
function paintLogEnd(px, rng, barkHex, ringHex, woodHex) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (r >= 6.5) {
        set(px, x, y, barkHex, randInt(rng, -10, 10));
      } else if (r === 4.5 || r === 2.5 || r === 0.5) {
        set(px, x, y, ringHex);
      } else {
        set(px, x, y, woodHex);
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
  paintLeaves(px, rng, 0x4a8a2c, 0x6baf3c);
}

/** Shared leaves: base + speck colour, ~22% alpha-0 holes. */
function paintLeaves(px, rng, baseHex, speckHex) {
  fill(px, baseHex);
  cellNoise(px, rng, 2, 16);
  noise(px, rng, 8);
  speck(px, rng, 12, [speckHex]);
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

// ---------------------------------------------------------------------------------------------------------------
// v0.4 block batch (tiles 28–71). Same rules: own-name seed, alpha 255 except leaves (holes) and ice (alpha 200).
// ---------------------------------------------------------------------------------------------------------------

/** 28/29/30/31 spruce — dark brown bark and planks, deep blue-green needles. */
function paintSpruceLogSide(px, rng) {
  paintBarkSide(px, rng, 0x3f2c1b, 0x24180d);
}
function paintSpruceLogEnd(px, rng) {
  paintLogEnd(px, rng, 0x3f2c1b, 0x6b4c2c, 0x8a6740);
}
function paintSprucePlanks(px, rng) {
  paintPlanks(px, rng, 0x735434, 0x45311c);
}
function paintSpruceLeaves(px, rng) {
  paintLeaves(px, rng, 0x2e5a3a, 0x427a50);
}

/** 32 birch_log_side — near-white bark with short dark horizontal lenticels. */
function paintBirchLogSide(px, rng) {
  fill(px, 0xd8d4c6);
  cellNoise(px, rng, 2, 6);
  for (let k = 0; k < 9; k++) {
    const x0 = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    const len = randInt(rng, 2, 5);
    for (let i = 0; i < len; i++) set(px, wrap16(x0 + i), y, 0x2e2a24, randInt(rng, -6, 6));
  }
  noise(px, rng, 4);
}
/** 33/34/35 birch end, planks, leaves. */
function paintBirchLogEnd(px, rng) {
  paintLogEnd(px, rng, 0xd8d4c6, 0xb59c6a, 0xd2bc85);
}
function paintBirchPlanks(px, rng) {
  paintPlanks(px, rng, 0xc8b47a, 0x8f7c4c);
}
function paintBirchLeaves(px, rng) {
  paintLeaves(px, rng, 0x6a9a3a, 0x8cbc52);
}

/** Speckled igneous stones: base, cell noise, then two speck colours. */
function paintSpeckled(px, rng, baseHex, cellAmp, a, aCount, b, bCount) {
  fill(px, baseHex);
  cellNoise(px, rng, 2, cellAmp);
  noise(px, rng, 5);
  speck(px, rng, aCount, a);
  speck(px, rng, bCount, b);
}
/** 36 granite */
function paintGranite(px, rng) {
  paintSpeckled(px, rng, 0x9a6a55, 12, [0xb88a74, 0xc49a84], 22, [0x6e4636], 14);
}
/** 37 diorite */
function paintDiorite(px, rng) {
  paintSpeckled(px, rng, 0xbdbdbd, 10, [0xe6e6e6, 0xf4f4f4], 24, [0x7f7f7f, 0x5e5e5e], 18);
}
/** 38 andesite */
function paintAndesite(px, rng) {
  paintSpeckled(px, rng, 0x868886, 12, [0x9c9e9c], 16, [0x666866], 16);
}

/** 39 slate — blue-grey layers: per-row tint bands with a few darker cleavage lines. */
function paintSlate(px, rng) {
  fill(px, 0x4a5058);
  for (let y = 0; y < H; y++) {
    const d = randInt(rng, -8, 8);
    for (let x = 0; x < W; x++) adjAt(px, x, y, d);
  }
  for (let k = 0; k < 4; k++) {
    const y = randInt(rng, 0, 15);
    const x0 = randInt(rng, 0, 15);
    const len = randInt(rng, 5, 11);
    for (let i = 0; i < len; i++) set(px, wrap16(x0 + i), y, 0x30343a);
  }
  noise(px, rng, 4);
}

/** Moss overlay: `count` green 1–3 px clumps over whatever is already painted. */
function moss(px, rng, count) {
  const MOSS = [0x4f7a32, 0x5d8c3a, 0x3e6428];
  for (let k = 0; k < count; k++) {
    const x = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    const c = pick(rng, MOSS);
    set(px, x, y, c);
    if (rng() < 0.6) set(px, wrap16(x + 1), y, c);
    if (rng() < 0.4) set(px, x, wrap16(y + 1), c);
  }
}
/** 40 mossy_cobblestone — cobblestone base (seed "cobblestone") + moss. */
function paintMossyCobblestone(px, rng) {
  paintCobblestone(px, makeRng('cobblestone'));
  moss(px, rng, 26);
}
/** 41 mossy_stone_bricks — stone_bricks base (seed "stone_bricks") + moss. */
function paintMossyStoneBricks(px, rng) {
  paintStoneBricks(px, makeRng('stone_bricks'));
  moss(px, rng, 22);
}

/** 42 obsidian — near-black violet with glassy purple glints. */
function paintObsidian(px, rng) {
  fill(px, 0x150f22);
  cellNoise(px, rng, 2, 8);
  noise(px, rng, 3);
  speck(px, rng, 14, [0x3b2a5c, 0x4c3878]);
  speck(px, rng, 4, [0x7a63a8]);
}

/** 43 clay */
function paintClay(px, rng) {
  fill(px, 0x9fa4b0);
  cellNoise(px, rng, 2, 8);
  noise(px, rng, 4);
  speck(px, rng, 8, [0x8a8f9b]);
}

/** 44 red_sand */
function paintRedSand(px, rng) {
  fill(px, 0xbe6a2c);
  cellNoise(px, rng, 2, 10);
  noise(px, rng, 5);
  speck(px, rng, 6, [0xa4581f]);
}

/** 45 ice — pale blue with white crack lines, alpha 200 everywhere (translucent layer). */
function paintIce(px, rng) {
  fill(px, 0x8cb4f0);
  cellNoise(px, rng, 2, 8);
  noise(px, rng, 3);
  for (let k = 0; k < 3; k++) {
    line(px, randInt(rng, 0, 15), randInt(rng, 0, 15), randInt(rng, 0, 15), randInt(rng, 0, 15), 0xdcebff);
  }
  for (let i = 3; i < BYTES; i += 4) px[i] = 200;
}

/** 46 packed_ice — denser, opaque, faint frost specks. */
function paintPackedIce(px, rng) {
  fill(px, 0x8aa8e0);
  cellNoise(px, rng, 2, 6);
  noise(px, rng, 3);
  speck(px, rng, 16, [0xb4ccf4, 0xc8dcff]);
}

/**
 * Storage blocks (coal / iron / gold / diamond / copper): a bevelled plate — light rim on the top-left edges,
 * dark rim on the bottom-right, a soft diagonal sheen, then fine noise.
 */
function paintStorage(px, rng, baseHex, lightHex, darkHex, amp) {
  fill(px, baseHex);
  cellNoise(px, rng, 4, amp);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0) set(px, x, y, lightHex);
      else if (x === 15 || y === 15) set(px, x, y, darkHex);
      else if (x + y === 9 || x + y === 10) adjAt(px, x, y, 18);
    }
  }
  noise(px, rng, 3);
}
/** 47–51 */
function paintCoalBlock(px, rng) {
  paintStorage(px, rng, 0x1c1c1e, 0x3a3a3e, 0x0a0a0a, 6);
}
function paintIronBlock(px, rng) {
  paintStorage(px, rng, 0xd8d8d8, 0xf6f6f6, 0x9a9a9a, 6);
}
function paintGoldBlock(px, rng) {
  paintStorage(px, rng, 0xf2cf3a, 0xfff38a, 0xb08a18, 6);
}
function paintDiamondBlock(px, rng) {
  paintStorage(px, rng, 0x62e0e4, 0xc8fcff, 0x2a9ea6, 6);
}
function paintCopperBlock(px, rng) {
  paintStorage(px, rng, 0xc06a45, 0xe8936a, 0x7f3e24, 8);
  speck(px, rng, 6, [0x5fa88a]); // a hint of verdigris
}

/** 52 glowstone — warm gold crystals with bright cores (looks lit; no light engine). */
function paintGlowstone(px, rng) {
  fill(px, 0xc89234);
  cellNoise(px, rng, 3, 22);
  for (let k = 0; k < 14; k++) {
    const x = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    set(px, x, y, 0xfff0b0);
    set(px, wrap16(x + 1), y, 0xf8d070);
    set(px, x, wrap16(y + 1), 0xf8d070);
  }
  noise(px, rng, 5);
}

/**
 * 53 honeycomb — the world's own motif: a 2-row honeycomb of small hex cells (amber walls, golden centres).
 * Cell centres sit on an offset grid of pitch 6 × 5 px; a pixel is wall when its two nearest centres are nearly tied.
 */
function paintHoneycomb(px, rng) {
  const centres = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) centres.push([col * 6 + (row % 2) * 3 - 0.5, row * 4 + 1.5]);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      for (const [cx, cy] of centres) {
        const ax = Math.abs(x - cx);
        const ay = Math.abs(y - cy);
        const dx = Math.min(ax, 18 - ax);
        const dy = Math.min(ay, 16 - ay);
        const d = Math.sqrt(dx * dx + dy * dy * 1.3);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
      if (d2 - d1 < 0.9) set(px, x, y, 0xa8661a, randInt(rng, -6, 6));
      else set(px, x, y, d1 < 1.2 ? 0xffd25a : 0xe8a630, randInt(rng, -6, 6));
    }
  }
}

/** 54 hay_bale_side — golden straw stripes with two dark binding bands. */
function paintHayBaleSide(px, rng) {
  fill(px, 0xc8a232);
  for (let x = 0; x < W; x++) {
    const d = randInt(rng, -18, 14);
    for (let y = 0; y < H; y++) adjAt(px, x, y, d);
  }
  for (const y of [3, 12]) {
    for (let x = 0; x < W; x++) set(px, x, y, 0x7a4e1c, randInt(rng, -6, 6));
  }
  noise(px, rng, 6);
}
/** 55 hay_bale_top — cut straw ends: dense specks over a golden base, dark binding ring. */
function paintHayBaleTop(px, rng) {
  fill(px, 0xb8922a);
  cellNoise(px, rng, 1, 16);
  speck(px, rng, 30, [0xe0c050, 0x8e6c1c]);
  for (let i = 0; i < 16; i++) {
    set(px, i, 0, 0x7a4e1c);
    set(px, i, 15, 0x7a4e1c);
    set(px, 0, i, 0x7a4e1c);
    set(px, 15, i, 0x7a4e1c);
  }
}

/** 56 pumpkin_side — orange with darker vertical ribs every 4 px. */
function paintPumpkinSide(px, rng) {
  fill(px, 0xd8781a);
  for (let x = 0; x < W; x++) {
    const rib = x % 4 === 0 ? -34 : x % 4 === 2 ? 10 : 0;
    for (let y = 0; y < H; y++) adjAt(px, x, y, rib);
  }
  noise(px, rng, 5);
}
/** 57 pumpkin_top — orange with a green stalk in the middle and ribs radiating to the edges. */
function paintPumpkinTop(px, rng) {
  fill(px, 0xd27216);
  cellNoise(px, rng, 2, 8);
  for (const [x1, y1] of [[0, 0], [15, 0], [0, 15], [15, 15], [7, 0], [7, 15], [0, 7], [15, 7]]) line(px, 7, 7, x1, y1, 0xa85410);
  for (let y = 6; y <= 9; y++) for (let x = 6; x <= 9; x++) set(px, x, y, 0x4e6a1e, randInt(rng, -8, 8));
  noise(px, rng, 3);
}

/** 58–71 wool colours (same weave as white/red). */
const WOOL_HEX = Object.freeze({
  wool_orange: 0xe87a1a, wool_yellow: 0xf4cc30, wool_lime: 0x74c02a, wool_green: 0x4a6a22, wool_cyan: 0x168c94,
  wool_light_blue: 0x4cb0dc, wool_blue: 0x353aa0, wool_purple: 0x7a2aaa, wool_magenta: 0xbc48b4, wool_pink: 0xec90ac,
  wool_brown: 0x734a2a, wool_black: 0x18181c, wool_gray: 0x3e4448, wool_light_gray: 0x8e8e88,
});

/**
 * 72 black_hole — a starfield (0x0b0716 + a few white specks) behind a two-armed accretion swirl: for r in
 * [3.2, 7.4) around (7.5, 7.5) the arm strength s = (1 + cos(2θ + 1.6r)) / 2 lerps the ring colour (hot orange
 * 0xffb347 at the inner edge to violet 0x7a3fbf at the outer) from 25% to 100%; r < 3.2 is the event horizon,
 * 0x020104 with a 0x3a1c00 photon rim at r ≥ 2.6. Alpha 255.
 */
function paintBlackHole(px, rng) {
  fill(px, 0x0b0716);
  noise(px, rng, 3);
  speck(px, rng, 7, [0xffffff, 0xc8d0ff]);
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const r = Math.hypot(dx, dy);
      if (r < 2.6) {
        set(px, x, y, 0x020104);
      } else if (r < 3.2) {
        set(px, x, y, 0x3a1c00);
      } else if (r < 7.4) {
        const t = (r - 3.2) / 4.2;
        const s = 0.25 + 0.75 * ((1 + Math.cos(2 * Math.atan2(dy, dx) + 1.6 * r)) / 2);
        const cr = lerp(0xff, 0x7a, t) * s;
        const cg = lerp(0xb3, 0x3f, t) * s;
        const cb = lerp(0x47, 0xbf, t) * s;
        set(px, x, y, (Math.round(cr) << 16) | (Math.round(cg) << 8) | Math.round(cb), randInt(rng, -6, 6));
      }
    }
  }
}

/**
 * 73 campfire_side (icon only; the block has its own model) — alpha 0 background; two stacked logs on rows 12–15
 * (bark 0x5a3b22 ± 10 with a lighter top edge, 0xa07848 end rings at x 0–1 and 14–15) and a flame above them:
 * column x burns from row 11 up to height h(x) = round(10·(1 − |x − 7.5|/8.5)) + randInt(−1, 1) rows; within a column
 * the colour goes from 0xfff2a8 (bottom third, middle columns 5–10) through 0xffb02e to a 0xe8501a tip row.
 */
function paintCampfireSide(px, rng) {
  for (let i = 0; i < BYTES; i += 4) px[i + 3] = 0;
  for (let y = 12; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const end = x <= 1 || x >= 14;
      set(px, x, y, end ? 0xa07848 : 0x5a3b22, end ? 0 : randInt(rng, -10, 10));
    }
  }
  for (let x = 2; x < 14; x++) {
    adjAt(px, x, 12, 18);
    adjAt(px, x, 14, -12);
  }
  for (let x = 1; x < 15; x++) {
    const h = Math.max(1, Math.round(10 * (1 - Math.abs(x - 7.5) / 8.5)) + randInt(rng, -1, 1));
    for (let k = 0; k < h; k++) {
      const y = 11 - k;
      const core = k < h / 3 && x >= 5 && x <= 10;
      const hex = k === h - 1 ? 0xe8501a : core ? 0xfff2a8 : 0xffb02e;
      set(px, x, y, hex, randInt(rng, -8, 8));
    }
  }
}

/**
 * 74 campfire_top (icon only) — alpha 0 background; three 2-px logs (0x5a3b22 ± 8) through the centre at 0°, 60° and
 * 120°, and a glowing 4×4 ember bed in the middle (0xffb02e, centre 2×2 0xfff2a8).
 */
function paintCampfireTop(px, rng) {
  for (let i = 0; i < BYTES; i += 4) px[i + 3] = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      if (Math.hypot(dx, dy) > 7.6) continue;
      for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
        // distance from the line through the centre at angle a
        if (Math.abs(-Math.sin(a) * dx + Math.cos(a) * dy) < 1.05) {
          set(px, x, y, 0x5a3b22, randInt(rng, -8, 8));
          break;
        }
      }
    }
  }
  for (let y = 6; y <= 9; y++) for (let x = 6; x <= 9; x++) set(px, x, y, 0xffb02e, randInt(rng, -10, 10));
  for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) set(px, x, y, 0xfff2a8);
}

/**
 * Pixels (x, y) inside the pointy-top hexagon of circumradius `R` centred on (cx, cy) (corner straight up), tested at
 * the pixel centre against the hexagon's three slab pairs.
 */
function inHexagon(x, y, cx, cy, R) {
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const inr = (R * Math.sqrt(3)) / 2;
  // Pointy-top: edge normals at 0°, 60° and 120°, so |dx| ≤ inradius (the vertical sides) and the slanted pairs.
  const ax = Math.abs(dx);
  return ax <= inr && ax * 0.5 + Math.abs(dy) * (Math.sqrt(3) / 2) <= inr;
}

// ---------------------------------------------------------------------------------------------------------------
// Zombie parts (CONTRACTS §39). Not block faces: the zombie renderer maps them onto its four hex prisms. The side
// faces they land on are about twice as tall as they are wide, so features are drawn short and wide (an eye socket
// 5 px wide and 3 rows tall reads as a round, hollow socket). Original art; alpha 255 everywhere.
// ---------------------------------------------------------------------------------------------------------------

/** Grey-green rotting skin: the base every zombie skin tile starts from. */
const ZOMBIE_SKIN = 0x7b9168;
const ZOMBIE_ROT = 0x5b6e4c;
const ZOMBIE_BRUISE = 0x6c5f70;
const ZOMBIE_PALE = 0x9aab88;
const ZOMBIE_HAIR = 0x2a2520;

/** Skin: ZOMBIE_SKIN with noise 6, 2×2 cell noise 7, a few rot blotches (3–5 px) and bruise / pale specks. */
function zombieSkin(px, rng, blotches) {
  fill(px, ZOMBIE_SKIN);
  noise(px, rng, 6);
  cellNoise(px, rng, 2, 7);
  for (let k = 0; k < blotches; k++) {
    const cx = randInt(rng, 1, 14);
    const cy = randInt(rng, 3, 14);
    const n = randInt(rng, 3, 5);
    for (let i = 0; i < n; i++) set(px, wrap16(cx + randInt(rng, -1, 1)), Math.min(15, cy + randInt(rng, -1, 1)), ZOMBIE_ROT, delta(rng, 5));
  }
  speck(px, rng, 5, [ZOMBIE_BRUISE, ZOMBIE_PALE, ZOMBIE_ROT]);
}

/** Matted hair over rows 0 .. depth−1 with a ragged lower edge (each column 0–2 px longer). */
function zombieHairline(px, rng, depth) {
  for (let x = 0; x < W; x++) {
    const end = depth + randInt(rng, -1, 1) + (rng() < 0.2 ? 1 : 0);
    for (let y = 0; y < end; y++) set(px, x, y, rng() < 0.15 ? 0x3d362d : ZOMBIE_HAIR, delta(rng, 5));
  }
}

/**
 * 240 zombie_face — the head's FRONT side face only: skin with a matted fringe (rows 0–2), a stitched scar on the
 * forehead, two dark eye sockets (0x1b1719, rows 6–8 at x 2–6 and rows 7–9 at x 9–13 — the right one droops) with a
 * sickly 0xd4dc5c glint each, a pair of dark nostril holes, a crooked mouth (0x2a1418: rows 12, 13, 12 left to right)
 * with two pale 0xcfc8a4 teeth, and a rot patch on the chin. Alpha 255.
 */
function paintZombieFace(px, rng) {
  zombieSkin(px, rng, 2);
  zombieHairline(px, rng, 2);
  // Forehead scar with stitches.
  line(px, 9, 4, 13, 4, 0x3c3330);
  for (const x of [10, 12]) {
    set(px, x, 3, 0x2e2a26);
    set(px, x, 5, 0x2e2a26);
  }
  // Brow ridges, then the sockets (dark hollows with a darker rim) and their glints.
  for (let x = 2; x <= 6; x++) set(px, x, 5, ZOMBIE_ROT, delta(rng, 4));
  for (let x = 9; x <= 13; x++) set(px, x, 6, ZOMBIE_ROT, delta(rng, 4));
  const socket = (x0, y0) => {
    for (let y = y0; y < y0 + 3; y++) {
      for (let x = x0; x < x0 + 5; x++) {
        const corner = (x === x0 || x === x0 + 4) && (y === y0 || y === y0 + 2);
        set(px, x, y, corner ? 0x3f4a37 : 0x1b1719, corner ? 0 : delta(rng, 3));
      }
    }
  };
  socket(2, 6);
  socket(9, 7);
  set(px, 4, 7, 0xd4dc5c);
  set(px, 11, 8, 0xd4dc5c);
  set(px, 3, 7, 0x2c2a20);
  // Nose: a dark sunken bridge and two nostril holes.
  set(px, 7, 9, ZOMBIE_ROT);
  set(px, 8, 9, ZOMBIE_ROT);
  set(px, 7, 10, 0x231d1e);
  set(px, 8, 10, 0x231d1e);
  // Crooked mouth: higher on the left, sagging in the middle, hitched up on the right, with a lip shadow above.
  for (let x = 3; x <= 6; x++) set(px, x, 12, 0x2a1418);
  for (let x = 6; x <= 10; x++) set(px, x, 13, 0x2a1418);
  for (let x = 10; x <= 12; x++) set(px, x, 12, 0x2a1418);
  for (let x = 3; x <= 12; x++) set(px, x, x >= 7 && x <= 9 ? 12 : 11, 0x5d4a44, delta(rng, 4));
  set(px, 5, 12, 0xcfc8a4);
  set(px, 9, 13, 0xcfc8a4);
  // Rot on the chin and a darker jaw line.
  for (let x = 2; x <= 13; x++) set(px, x, 15, ZOMBIE_ROT, delta(rng, 5));
  set(px, 11, 14, ZOMBIE_BRUISE);
  set(px, 12, 14, ZOMBIE_BRUISE);
}

/**
 * 241 zombie_head_side — the head's other five sides: rotting skin under a matted hairline (rows 0–3, ragged), with a
 * darker vein running down and a stitched cut. Alpha 255.
 */
function paintZombieHeadSide(px, rng) {
  zombieSkin(px, rng, 4);
  zombieHairline(px, rng, 4);
  let x = randInt(rng, 3, 12);
  for (let y = 6; y < 15; y++) {
    set(px, x, y, 0x55644a, delta(rng, 4));
    if (rng() < 0.35) x = Math.max(1, Math.min(14, x + (rng() < 0.5 ? -1 : 1)));
  }
  line(px, 2, 10, 5, 12, 0x3c3330);
  set(px, 3, 10, 0x2e2a26);
  set(px, 4, 12, 0x2e2a26);
}

/** 242 zombie_scalp — the head's top: matted dark hair (strands of 0x3d362d) with a bald, rotting patch. Alpha 255. */
function paintZombieScalp(px, rng) {
  fill(px, ZOMBIE_HAIR);
  noise(px, rng, 7);
  for (let k = 0; k < 14; k++) {
    const x = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 13);
    set(px, x, y, 0x3d362d);
    set(px, x, y + 1, 0x3d362d, -6);
  }
  // A bald, rotting patch: an uneven blob (squashed, ragged rim) off to one side, and a smaller one behind it.
  for (const [cx, cy, rad] of [[10, 6, 2.4], [5, 11, 1.3]]) {
    for (let y = 0; y < H; y++) {
      for (let xx = 0; xx < W; xx++) {
        const d = Math.hypot((xx + 0.5 - cx) * 0.8, y + 0.5 - cy);
        if (d < rad + rng() * 1.1) set(px, xx, y, d < rad * 0.5 ? ZOMBIE_ROT : ZOMBIE_SKIN, delta(rng, 6));
      }
    }
  }
}

/**
 * 243 zombie_shirt — the torso's sides: a faded teal work shirt (0x4d6a73, weave noise, darker folds at the face edges)
 * with two ragged tears showing grey-green skin through dark frayed rims, a muddy stain and a torn hem (rows 13–15:
 * cloth strips hanging over skin). Alpha 255.
 */
function paintZombieShirt(px, rng) {
  fill(px, 0x4d6a73);
  for (let y = 0; y < H; y++) {
    const d = y % 2 === 0 ? 3 : -2;
    for (let x = 0; x < W; x++) adjAt(px, x, y, d + delta(rng, 5));
  }
  for (let y = 0; y < H; y++) {
    adjAt(px, 0, y, -14);
    adjAt(px, 15, y, -14);
    adjAt(px, 1, y, -6);
  }
  // Tears: an irregular blob of skin each, ringed by dark frayed cloth.
  const tear = (cx, cy, rx, ry) => {
    for (let y = cy - ry - 1; y <= cy + ry + 1; y++) {
      for (let x = cx - rx - 1; x <= cx + rx + 1; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const e = ((x - cx) / (rx + 0.5)) ** 2 + ((y - cy) / (ry + 0.5)) ** 2 + (rng() - 0.5) * 0.5;
        if (e < 1) set(px, x, y, ZOMBIE_SKIN, delta(rng, 8));
        else if (e < 1.7) set(px, x, y, 0x26343a, delta(rng, 4));
      }
    }
  };
  tear(randInt(rng, 3, 5), randInt(rng, 3, 5), 1, 2);
  tear(randInt(rng, 9, 12), randInt(rng, 7, 9), 2, 1);
  for (let k = 0; k < 6; k++) set(px, randInt(rng, 5, 9), randInt(rng, 9, 12), 0x5d5a3c, delta(rng, 6));
  // Torn hem: strips of cloth of random length over the skin of the belly.
  for (let x = 0; x < W; x++) {
    const hang = randInt(rng, 13, 16);
    for (let y = 13; y < H; y++) set(px, x, y, y < hang ? 0x405a62 : ZOMBIE_SKIN, delta(rng, 5));
  }
}

/**
 * 244 zombie_trousers — the feet's sides: ragged brown trousers (0x5b4b3b, noise 6, a dark seam down the middle, a
 * lighter patch), a frayed hem (row 10) over a strip of bare ankle (row 11), and a battered dark shoe (rows 12–15:
 * 0x2c2623 with a 0x463c35 top edge, a 0x1a1614 sole and a hole showing one toe). Alpha 255.
 */
function paintZombieTrousers(px, rng) {
  fill(px, 0x5b4b3b);
  noise(px, rng, 6);
  for (let y = 0; y < 10; y++) set(px, 7, y, 0x463a2e, delta(rng, 3));
  const pxs = randInt(rng, 9, 11);
  for (let y = 3; y <= 6; y++) for (let x = pxs; x < pxs + 3; x++) set(px, x, y, 0x6d5c47, delta(rng, 4));
  for (let x = 0; x < W; x++) {
    set(px, x, 10, rng() < 0.5 ? 0x4a3d31 : 0x5b4b3b, delta(rng, 5));
    set(px, x, 11, rng() < 0.3 ? 0x4a3d31 : ZOMBIE_SKIN, delta(rng, 6));
  }
  for (let y = 12; y < H; y++) {
    for (let x = 0; x < W; x++) set(px, x, y, y === 12 ? 0x463c35 : y === 15 ? 0x1a1614 : 0x2c2623, delta(rng, 3));
  }
  set(px, 4, 13, ZOMBIE_PALE);
  set(px, 3, 13, 0x1a1614);
}

/** 245 zombie_sole — the feet's undersides: a worn dark sole with lighter tread bars and a scuffed patch. Alpha 255. */
function paintZombieSole(px, rng) {
  fill(px, 0x2a2421);
  noise(px, rng, 4);
  for (let y = 2; y < 14; y += 3) for (let x = 3; x < 13; x++) set(px, x, y, 0x3a322d, delta(rng, 3));
  for (let k = 0; k < 6; k++) set(px, randInt(rng, 6, 10), randInt(rng, 6, 10), 0x4a413a, delta(rng, 4));
}

// ---------------------------------------------------------------------------------------------------------------
// The Hollow Watcher (CONTRACTS §40). Not block faces: watcherRenderer maps them onto its hollow rings, its lantern and
// its smoke wisp. Weathered ash-grey stone split by thin cracks; the cracks' glow is its own tile (the emissive mask,
// which the renderer reads one tile to the right of every stone texel), so only the cracks shine. Original art;
// alpha 255 everywhere.
// ---------------------------------------------------------------------------------------------------------------

const WATCHER_ASH = 0x8a8884;
const WATCHER_GROOVE = 0x2a3d41;
const WATCHER_CRACK_GLOW = 0x5ae6f0;
const WATCHER_SELF_LIGHT = 0.4;

/**
 * One crack: a 1-px walk of `steps` from (x, y), each step one pixel along (ax, ay) — one of them 0 — plus a sideways
 * drift on the other axis that keeps its last value (30 %), returns to 0 (25 %) or turns to −1 / +1 (45 %), so the
 * crack runs jagged but 8-connected. A drift that would leave the tile turns back; the walk stops when its main
 * direction runs off the tile.
 */
function watcherCrackWalk(rng, out, x, y, ax, ay, steps) {
  let lat = 0;
  for (let s = 0; s < steps; s++) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    out.add(y * W + x);
    const r = rng();
    if (r >= 0.3) lat = r < 0.55 ? 0 : rng() < 0.5 ? -1 : 1;
    const side = ax === 0 ? x : y; // the drifting coordinate
    if (side + lat < 0 || side + lat >= (ax === 0 ? W : H)) lat = -lat;
    x += ax + (ax === 0 ? lat : 0);
    y += ay + (ay === 0 ? lat : 0);
  }
}

/**
 * The crack pixels shared by watcher_stone (dark grooves) and watcher_cracks (their glow), from their own fixed seed
 * ('hollow_watcher_cracks') so the two tiles always agree — two short, thin cracks, so a face's window of the tile
 * shows one, both or none: one running across from column 0–3 at row 8–13 (6–9 steps), one running down from column
 * 6–11 at row 0–3 (6–9 steps) with a 2–3 step branch off toward +x from its fourth pixel.
 * @returns {Set<number>} pixel indices y·16 + x
 */
function watcherCracks() {
  const rng = makeRng('hollow_watcher_cracks');
  /** @type {Set<number>} */
  const out = new Set();
  watcherCrackWalk(rng, out, randInt(rng, 0, 3), randInt(rng, 8, 13), 1, 0, randInt(rng, 6, 9));
  const before = out.size;
  watcherCrackWalk(rng, out, randInt(rng, 6, 11), randInt(rng, 0, 3), 0, 1, randInt(rng, 6, 9));
  const fourth = [...out][Math.min(out.size - 1, before + 3)];
  watcherCrackWalk(rng, out, (fourth % W) + 1, Math.floor(fourth / W), 1, 0, randInt(rng, 2, 3));
  return out;
}

/** The 4-neighbours of `cracks` that are not cracks themselves (a crack's lip). @returns {Set<number>} */
function watcherCrackLips(cracks) {
  /** @type {Set<number>} */
  const lips = new Set();
  for (const i of cracks) {
    const x = i % W;
    const y = Math.floor(i / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H || cracks.has(ny * W + nx)) continue;
      lips.add(ny * W + nx);
    }
  }
  return lips;
}

/**
 * 250 watcher_stone — the rings and the lantern: weathered ash-grey stone (WATCHER_ASH 0x8a8884) mottled in 4×4
 * patches (±7) and 2×2 grains (±4), noise 5, ten pale weathered flecks (+12) and eighteen pores (−36, each with a
 * lighter +8 rim pixel under it), then the shared cracks (watcherCracks) as dark teal-grey grooves (WATCHER_GROOVE
 * 0x2a3d41, ±3) with shadowed lips (their 4-neighbours −14). Neutral grey, never black or purple. Alpha 255.
 */
function paintWatcherStone(px, rng) {
  fill(px, WATCHER_ASH);
  cellNoise(px, rng, 4, 7);
  cellNoise(px, rng, 2, 4);
  noise(px, rng, 5);
  for (let k = 0; k < 10; k++) adjAt(px, randInt(rng, 0, 15), randInt(rng, 0, 15), 12);
  for (let k = 0; k < 18; k++) {
    const x = randInt(rng, 0, 15);
    const y = randInt(rng, 0, 15);
    adjAt(px, x, y, -36);
    if (y < H - 1) adjAt(px, x, y + 1, 8);
  }
  const cracks = watcherCracks();
  for (const i of watcherCrackLips(cracks)) adjAt(px, i % W, Math.floor(i / W), -14);
  for (const i of cracks) set(px, i % W, Math.floor(i / W), WATCHER_GROOVE, delta(rng, 3));
}

/**
 * 251 watcher_cracks — the stone's self-light (the renderer's emissiveMap, read one tile right of watcher_stone): the
 * stone itself (watcher_stone painted with its own seed) dimmed to WATCHER_SELF_LIGHT (0.4), so by night it still
 * reads as pale stone rather than a black shape, and the shared cracks a bright cyan WATCHER_CRACK_GLOW 0x5ae6f0
 * (±16). Never on screen as a colour of its own. Alpha 255.
 */
function paintWatcherCracks(px, rng) {
  paintWatcherStone(px, makeRng('watcher_stone'));
  for (let i = 0; i < BYTES; i += 4) {
    px[i] = Math.round(px[i] * WATCHER_SELF_LIGHT);
    px[i + 1] = Math.round(px[i + 1] * WATCHER_SELF_LIGHT);
    px[i + 2] = Math.round(px[i + 2] * WATCHER_SELF_LIGHT);
  }
  for (const i of watcherCracks()) set(px, i % W, Math.floor(i / W), WATCHER_CRACK_GLOW, delta(rng, 16));
}

/**
 * 252 watcher_smoke — the wisp under the rings: dark neutral soot 0x2a2b2e (noise 3) with four lighter wisps 0x45474b
 * rising from the bottom row, swaying a pixel left or right on 40 % of the rows and fading as they rise (−0.8 per row,
 * ±4). Alpha 255 (the renderer fades the wisp with vertex alpha).
 */
function paintWatcherSmoke(px, rng) {
  fill(px, 0x2a2b2e);
  noise(px, rng, 3);
  for (let k = 0; k < 4; k++) {
    let x = randInt(rng, 0, 15);
    for (let y = H - 1; y >= 0; y--) {
      set(px, wrap16(x), y, 0x45474b, delta(rng, 4) - Math.round((H - 1 - y) * 0.8));
      if (rng() < 0.4) x += rng() < 0.5 ? -1 : 1;
    }
  }
}

/** 255 missing — 8×8 quadrant checker, magenta top-left / bottom-right, black elsewhere. */
function paintMissing(px) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      set(px, x, y, (x < 8) === (y < 8) ? 0xff00ff : 0x000000);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// v0.9 survival tiles 77–104 (docs/DESIGN-survival.md §8.1–§8.2; original designs, these comments are normative).
// Alpha 255 everywhere except: the plants (honeyberry bushes, tussock, cattails, tuber plant, prickly pears), the litter
// (loose stones, fallen branches), the fire pit's side and Your Belongings, whose empty space is alpha 0 with RGB 0
// (honeyberry holes keep their RGB, like leaves); plant_top_clear is alpha 0 everywhere. The short blocks (tussock,
// tuber plant, loose stones, fallen branches, fire pit) keep the stated upper rows alpha 0, so a full cell reads short.
// ---------------------------------------------------------------------------------------------------------------

/** `mix(a, b, t)`: packed colour a + (b − a)·t per channel, rounded; t is clamped to 0..1. */
function mixHex(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  let out = 0;
  for (const sh of [16, 8, 0]) {
    const ca = (a >> sh) & 255;
    const cb = (b >> sh) & 255;
    out |= Math.round(ca + (cb - ca) * k) << sh;
  }
  return out;
}

/** Every pixel alpha 0 with RGB 0 (the empty space of the plants, the litter and the belongings). */
function clearTile(px) {
  px.fill(0);
}

/** @returns {boolean} pixel (x, y) is inside the tile and opaque */
function opaqueAt(px, x, y) {
  return x >= 0 && x < W && y >= 0 && y < H && px[idx(x, y) + 3] === 255;
}

/** `set` for coordinates that may fall outside the tile (skipped) or above row `minRow` (skipped). */
function setClipped(px, x, y, hex, d = 0, minRow = 0) {
  if (x < 0 || x >= W || y < minRow || y >= H) return;
  set(px, x, y, hex, d);
}

/**
 * 77 copper_ore — stone (seed "stone") with 5 banded malachite blobs, each anchored at (x, y) ∈ [1,12]²: (x, y), (x+1, y),
 * (x, y+1), (x+1, y+1) and (x+2, y+1) always, (x+2, y) and (x+1, y+2) with p 0.6, (x−1, y+1) and (x, y+2) with p 0.4.
 * The blob pixels follow its rows in bands — 0x2f8f5b on one parity, 0x1f6b43 on the other (the phase random per blob)
 * — and the anchor is the highlight 0x6fd39a; then 2–3 copper-orange 0xc8743a specks on stone pixels in [1,14]².
 */
function paintCopperOre(px, rng) {
  paintStone(px, makeRng('stone'));
  for (let k = 0; k < 5; k++) {
    const x = randInt(rng, 1, 12);
    const y = randInt(rng, 1, 12);
    const phase = randInt(rng, 0, 1);
    const band = (yy) => (((yy + phase) & 1) === 0 ? 0x2f8f5b : 0x1f6b43);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [2, 1]]) set(px, x + dx, y + dy, band(y + dy));
    if (rng() < 0.6) set(px, x + 2, y, band(y));
    if (rng() < 0.6) set(px, x + 1, y + 2, band(y + 2));
    if (rng() < 0.4) set(px, x - 1, y + 1, band(y + 1));
    if (rng() < 0.4) set(px, x, y + 2, band(y + 2));
    set(px, x, y, 0x6fd39a);
  }
  const specks = randInt(rng, 2, 3);
  for (let k = 0, tries = 0; k < specks && tries < 64; tries++) {
    const x = randInt(rng, 1, 14);
    const y = randInt(rng, 1, 14);
    const i = idx(x, y);
    if (px[i + 1] > px[i] + 8) continue; // a malachite pixel: keep looking for stone
    set(px, x, y, 0xc8743a);
    k++;
  }
}

/**
 * 78 tin_ore — stone (seed "stone") with 5 cassiterite crystals: each a short prism anchored at (x, y) ∈ [1,13] × [2,12],
 * 1–2 px wide and 2–3 rows tall, its left column dark 0x2a211c and its right column the lit face 0x4a3a30, with a
 * 1-px 0x2a211c tip above it with p 0.5 and a 2-row twin to its right with p 0.4; then 4 single-pixel white glints
 * 0xf4f2ea on crystal pixels.
 */
function paintTinOre(px, rng) {
  paintStone(px, makeRng('stone'));
  /** @type {number[]} crystal pixel indices (y·16 + x) */
  const crystal = [];
  const put = (x, y, hex) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    set(px, x, y, hex);
    crystal.push(y * W + x);
  };
  for (let k = 0; k < 5; k++) {
    const x = randInt(rng, 1, 13);
    const y = randInt(rng, 2, 12);
    const w = randInt(rng, 1, 2);
    const h = randInt(rng, 2, 3);
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) put(x + dx, y + dy, dx === 0 ? 0x2a211c : 0x4a3a30);
    if (rng() < 0.5) put(x, y - 1, 0x2a211c);
    if (rng() < 0.4) {
      put(x + w, y + 1, 0x2a211c);
      put(x + w, y + 2, 0x4a3a30);
    }
  }
  for (let k = 0; k < 4 && crystal.length > 0; k++) {
    const p = crystal[Math.floor(rng() * crystal.length)];
    set(px, p % W, Math.floor(p / W), 0xf4f2ea);
  }
}

/**
 * Shared foliage of the honeyberry bushes: a deeper blue-green leaves recipe — 0x2e6448, 2×2 cell noise 14, noise 7,
 * 12 specks 0x4d8a62 and 6 specks 0x1f4a34 — with alpha-0 holes at probability `holes` (RGB kept, like leaves).
 */
function paintBerryFoliage(px, rng, holes) {
  fill(px, 0x2e6448);
  cellNoise(px, rng, 2, 14);
  noise(px, rng, 7);
  speck(px, rng, 12, [0x4d8a62]);
  speck(px, rng, 6, [0x1f4a34]);
  for (let i = 3; i < BYTES; i += 4) px[i] = rng() < holes ? 0 : 255;
}

/**
 * The honeyberry bush's silhouette (a sprite drawn on crossed planes): a rounded clump of four overlapping discs —
 * centres (4.5, 9.5) r 4.4, (11, 9.5) r 4.4, (7.5, 6.5) r 5 and (7.5, 11) r 4.6 — over rows 2–13, and a 2-px stem at
 * x 7–8 on rows 13–15. Everything outside stays alpha 0.
 */
function inBush(x, y) {
  if (y >= 13 && (x === 7 || x === 8)) return 'stem';
  if (y > 13) return null;
  const px = x + 0.5;
  const py = y + 0.5;
  for (const [cx, cy, r] of [[4.5, 9.5, 4.4], [11, 9.5, 4.4], [7.5, 6.5, 5], [7.5, 11, 4.6]]) {
    if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return 'leaf';
  }
  return null;
}

/** Mask the berry foliage to the bush's silhouette: leaves keep their colour (darker toward the bottom), the stem is bark. */
function maskBush(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = inBush(x, y);
      const i = (y * W + x) * 4;
      if (at === 'stem') set(px, x, y, 0x5a4630, delta(rng, 6));
      else if (at === null) px[i + 3] = 0;
      else if (y >= 10) { px[i] = Math.round(px[i] * 0.82); px[i + 1] = Math.round(px[i + 1] * 0.82); px[i + 2] = Math.round(px[i + 2] * 0.82); }
    }
  }
}

/**
 * 79 honeyberry_bush — a rounded bush (inBush) of the berry foliage with 8 % holes, darker on its lower rows, standing on a
 * short bark stem, hung with 6–8 clusters of elongated dusky-blue honeyberries inside the silhouette: a cluster is 2–3
 * berries side by side, every other one a row lower, each berry 1 px wide and 2–3 rows tall (a pale bloom 0x9aa6d6 on
 * its top pixel, 0x3b4a8a below it with one 0x5b6bb0 sheen pixel). Berries are opaque even over a hole.
 */
function paintHoneyberryBush(px, rng) {
  paintBerryFoliage(px, rng, 0.08);
  maskBush(px, rng);
  const clusters = randInt(rng, 6, 8);
  for (let k = 0, tries = 0; k < clusters && tries < 200; tries++) {
    const cx = randInt(rng, 2, 12);
    const cy = randInt(rng, 3, 10);
    if (inBush(cx, cy) !== 'leaf' || inBush(cx + 2, cy + 3) !== 'leaf') continue;
    const n = randInt(rng, 2, 3);
    for (let b = 0; b < n; b++) {
      const x = cx + b;
      const y0 = cy + (b & 1);
      const len = randInt(rng, 2, 3);
      const sheen = randInt(rng, 1, len - 1);
      for (let j = 0; j < len; j++) if (inBush(x, y0 + j) === 'leaf') set(px, x, y0 + j, j === 0 ? 0x9aa6d6 : j === sheen ? 0x5b6bb0 : 0x3b4a8a);
    }
    k++;
  }
}

/**
 * 80 honeyberry_bush_bare — the same bush, picked: the ripe bush's foliage and silhouette (painted with the
 * "honeyberry_bush" seed, so the leaves match), sparser — every leaf pixel becomes a hole with p 0.3 — with three bare twigs
 * (3-px diagonal strokes 0x5a4630) inside the clump, and no berries.
 */
function paintHoneyberryBushBare(px, rng) {
  const seed = makeRng('honeyberry_bush');
  paintBerryFoliage(px, seed, 0.08);
  maskBush(px, seed);
  for (let y = 0; y < 13; y++) for (let x = 0; x < W; x++) if (inBush(x, y) === 'leaf' && rng() < 0.3) px[(y * W + x) * 4 + 3] = 0;
  for (let k = 0, tries = 0; k < 3 && tries < 100; tries++) {
    const x = randInt(rng, 3, 11);
    const y = randInt(rng, 4, 9);
    const dir = rng() < 0.5 ? -1 : 1;
    if (inBush(x + 2 * dir, y + 2) !== 'leaf') continue;
    for (let j = 0; j < 3; j++) set(px, x + dir * j, y + j, 0x5a4630, delta(rng, 6));
    k++;
  }
}

/**
 * 81 tussock — a tuft of grass blades on alpha 0, rows 4–15 only (rows 0–3 stay alpha 0). A dense base on rows 12–15
 * (each pixel 0x55722a ±6 with p 0.9), then one blade per column x0: a 1-px line from (x0, 15) up to its tip row
 * t = 4 + round(|x0 − 7.5|·0.5) + randInt(0, 2) (taller in the middle), leaning outward by up to 2 columns
 * (sign(x0 − 7.5)·randInt(0, 2), clipped to the tile). Colour by height in the blade, f = (y − t) / (15 − t): yellow tips
 * 0xd8c860 at f 0 through straw-green 0x8fa244 at f 0.5 to 0x55722a at the base, ±6, blades from odd columns 10 darker.
 * About 45 % of the tile stays alpha 0.
 */
function paintTussock(px, rng) {
  clearTile(px);
  for (let y = 12; y < H; y++) for (let x = 0; x < W; x++) if (rng() < 0.9) set(px, x, y, 0x55722a, delta(rng, 6));
  for (let x0 = 0; x0 < W; x0++) {
    const t = 4 + Math.round(Math.abs(x0 - 7.5) * 0.5) + randInt(rng, 0, 2);
    const lean = Math.sign(x0 - 7.5) * randInt(rng, 0, 2);
    const shade = x0 % 2 === 1 ? -10 : 0;
    for (let y = H - 1; y >= t; y--) {
      const f = (y - t) / (H - 1 - t);
      const hex = f < 0.5 ? mixHex(0xd8c860, 0x8fa244, f / 0.5) : mixHex(0x8fa244, 0x55722a, (f - 0.5) / 0.5);
      const x = x0 + Math.round((lean * (H - 1 - y)) / (H - 1 - t));
      setClipped(px, x, y, hex, delta(rng, 6) + shade);
    }
  }
}

/**
 * 82 cattails_side — on alpha 0, five long leaves and three flower stalks rising from the bottom row. A leaf runs from
 * (x0, 15), x0 ∈ [0,15], to a tip 1–2 columns aside on row 3–7, 0x5f8a34 ±6, doubled one column over on rows 12–15
 * (0x4e7a2c); the stalks (0x6b7f30) stand at x 3, 8 and 12 from row 15 up to row 5, each topped by a brown cattail head
 * 2 px wide over rows 1–4 (left column 0x6b4423, right 0x8a5a30, ±6) with a thin 0xa09060 spike on row 0.
 */
function paintCattailsSide(px, rng) {
  clearTile(px);
  for (let k = 0; k < 5; k++) {
    const x0 = randInt(rng, 0, 15);
    const tip = randInt(rng, 3, 7);
    const dx = (rng() < 0.5 ? -1 : 1) * randInt(rng, 1, 2);
    for (let y = H - 1; y >= tip; y--) {
      const x = x0 + Math.round((dx * (H - 1 - y)) / (H - 1 - tip));
      setClipped(px, x, y, 0x5f8a34, delta(rng, 6));
      if (y >= 12) setClipped(px, x + 1, y, 0x4e7a2c, delta(rng, 6));
    }
  }
  for (const x of [3, 8, 12]) {
    for (let y = 5; y < H; y++) set(px, x, y, 0x6b7f30, delta(rng, 5));
    for (let y = 1; y <= 4; y++) {
      set(px, x, y, 0x6b4423, delta(rng, 6));
      set(px, x + 1, y, 0x8a5a30, delta(rng, 6));
    }
    set(px, x, 0, 0xa09060);
  }
}

/**
 * 83 cattails_top — mostly alpha 0: the plant from above — three 2×2 brown head tops (0x6b4423 with a 0x8a5a30 pixel)
 * at (3, 9), (8, 4) and (11, 10), and 10 single leaf-tip pixels 0x6f9a3c ±8 at random.
 */
function paintCattailsTop(px, rng) {
  clearTile(px);
  for (let k = 0; k < 10; k++) set(px, randInt(rng, 0, 15), randInt(rng, 0, 15), 0x6f9a3c, delta(rng, 8));
  for (const [x, y] of [[3, 9], [8, 4], [11, 10]]) {
    set(px, x, y, 0x8a5a30);
    set(px, x + 1, y, 0x6b4423);
    set(px, x, y + 1, 0x6b4423);
    set(px, x + 1, y + 1, 0x6b4423, -10);
  }
}

/**
 * 84 tuber_plant — rows 0–8 alpha 0; a low leafy rosette on rows 9–15: five broad leaves, discs of radius 2.3 centred
 * 3.8 × 3.0 from (7.5, 13.2) at angles 180°, 225°, 270°, 315° and 360° (pointing up and out). A pixel belongs to the
 * nearest leaf whose disc holds it: 0x4f8a3a ±8, its upper-left half 12 lighter, 26 darker where a 4-neighbour belongs to
 * another leaf or to nothing (the leaves' outlines). A 0x78b04e midrib runs from (7, 14) to each leaf's centre; two
 * purple-brown stems 0x6a3a4a stand on rows 14–15 at x 7–8, with a 0x8a6a3a soil-bump pixel either side on row 15.
 */
function paintTuberPlant(px, rng) {
  clearTile(px);
  const BX = 7.5;
  const BY = 13.2;
  const R2 = 2.3 * 2.3;
  /** @type {[number, number][]} */
  const centres = [];
  for (let k = 0; k < 5; k++) {
    const a = Math.PI + (k * Math.PI) / 4;
    centres.push([BX + Math.cos(a) * 3.8, BY + Math.sin(a) * 3.0]);
  }
  /** @returns {number} the leaf pixel (x, y) belongs to, or −1 */
  const leafOf = (x, y) => {
    if (x < 0 || x >= W || y < 9 || y >= H) return -1;
    let best = -1;
    let bestD = R2;
    for (let k = 0; k < centres.length; k++) {
      const dx = x + 0.5 - centres[k][0];
      const dy = y + 0.5 - centres[k][1];
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  for (let y = 9; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = leafOf(x, y);
      if (k < 0) continue;
      const outline = leafOf(x - 1, y) !== k || leafOf(x + 1, y) !== k || leafOf(x, y - 1) !== k || leafOf(x, y + 1) !== k;
      const lit = x + 0.5 - centres[k][0] + (y + 0.5 - centres[k][1]) < 0;
      set(px, x, y, 0x4f8a3a, delta(rng, 8) + (lit ? 12 : 0) - (outline ? 26 : 0));
    }
  }
  for (const [cx, cy] of centres) line(px, 7, 14, Math.round(cx - 0.5), Math.max(9, Math.round(cy - 0.5)), 0x78b04e);
  for (let y = 14; y < H; y++) {
    set(px, 7, y, 0x6a3a4a);
    set(px, 8, y, 0x6a3a4a, -8);
  }
  set(px, 6, 15, 0x8a6a3a);
  set(px, 9, 15, 0x8a6a3a);
}

/** The prickly pear's pads: [cx, cy, rx, ry] ellipses (bottom pad, then the two upper pads). */
const PEAR_PADS = Object.freeze([[8, 11.6, 3.7, 4.2], [4.3, 5.4, 2.9, 3.5], [11.6, 4.6, 2.9, 3.5]]);

/**
 * Shared pads of the prickly pears (always painted with the "prickly_pear" seed, so the picked plant matches): on alpha 0,
 * three oval pads PEAR_PADS (bottom (8, 11.6) 3.7×4.2; upper (4.3, 5.4) and (11.6, 4.6), 2.9×3.5) in 0x5d8f3a ±6, a
 * lighter 0x7fb04e sheen on their upper-left quarter, a darker 0x3f6a26 rim on every pad pixel with a transparent
 * 4-neighbour, and 14 pale 0xe6dfae spine dots on interior pad pixels.
 */
function paintPearPads(px, rng) {
  clearTile(px);
  for (const [cx, cy, rx, ry] of PEAR_PADS) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ex = (x + 0.5 - cx) / rx;
        const ey = (y + 0.5 - cy) / ry;
        if (ex * ex + ey * ey > 1) continue;
        set(px, x, y, ex < -0.15 && ey < -0.15 ? 0x7fb04e : 0x5d8f3a, delta(rng, 6));
      }
    }
  }
  /** @type {[number, number][]} */
  const rim = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!opaqueAt(px, x, y)) continue;
      if (!opaqueAt(px, x - 1, y) || !opaqueAt(px, x + 1, y) || !opaqueAt(px, x, y - 1) || !opaqueAt(px, x, y + 1)) rim.push([x, y]);
    }
  }
  for (const [x, y] of rim) set(px, x, y, 0x3f6a26, delta(rng, 5));
  for (let k = 0, tries = 0; k < 14 && tries < 200; tries++) {
    const x = randInt(rng, 1, 14);
    const y = randInt(rng, 1, 14);
    if (!opaqueAt(px, x - 1, y) || !opaqueAt(px, x + 1, y) || !opaqueAt(px, x, y - 1) || !opaqueAt(px, x, y + 1)) continue;
    set(px, x, y, 0xe6dfae);
    k++;
  }
}

/** Where the pears' fruit sit: [x, y] of each 2×2 fruit's top-left pixel, on the upper pads' rims and the bottom pad's. */
const PEAR_FRUIT = Object.freeze([[2, 1], [5, 1], [10, 0], [13, 1], [10, 7]]);

/**
 * 85 prickly_pear — the pads with five ripe fruit (tunas) on their rims at PEAR_FRUIT: 2×2, 0xc8302a ±8 with a
 * red-yellow 0xf0b030 highlight top-left and a 0x8a1a1a shade bottom-right.
 */
function paintPricklyPear(px, rng) {
  paintPearPads(px, makeRng('prickly_pear'));
  for (const [x, y] of PEAR_FRUIT) {
    set(px, x, y, 0xf0b030, delta(rng, 6));
    set(px, x + 1, y, 0xc8302a, delta(rng, 8));
    set(px, x, y + 1, 0xc8302a, delta(rng, 8));
    set(px, x + 1, y + 1, 0x8a1a1a, delta(rng, 6));
  }
}

/**
 * 86 prickly_pear_bare — the same pads, picked: no fruit; a pale 0xb0a878 scar pixel where each fruit's base met its pad
 * (the fruit's bottom-left pixel, when that is a pad pixel).
 */
function paintPricklyPearBare(px, rng) {
  paintPearPads(px, makeRng('prickly_pear'));
  for (const [x, y] of PEAR_FRUIT) if (opaqueAt(px, x, y + 1)) set(px, x, y + 1, 0xb0a878, delta(rng, 6));
}

/**
 * 87 stump_side — the Work Stump's bark: oak bark (paintBarkSide 0x6b5032 / 0x4a3620, this tile's seed) under a pale
 * sawn rim (row 0 0xb8935c ±6, row 1 0x8f7345), with a pale axe notch cut into the right edge: on rows 5–10 the
 * wedge reaches depth 5 − 1.4·|y + 0.5 − 8| columns in from x 15, its upper face fresh wood 0xd8b47a and its lower face
 * 0xb8935c (±6), with a dark 0x3e2c18 lip on the bark pixel just above and below the cut.
 */
function paintStumpSide(px, rng) {
  paintBarkSide(px, rng, 0x6b5032, 0x4a3620);
  for (let x = 0; x < W; x++) {
    set(px, x, 0, 0xb8935c, delta(rng, 6));
    set(px, x, 1, 0x8f7345, delta(rng, 6));
  }
  const depth = (y) => 5 - 1.4 * Math.abs(y + 0.5 - 8);
  for (let y = 5; y <= 10; y++) {
    const d = depth(y);
    if (d <= 0) continue;
    for (let x = W - 1; x >= W - d; x--) set(px, x, y, y < 8 ? 0xd8b47a : 0xb8935c, delta(rng, 6));
  }
  for (let x = 10; x < W; x++) {
    for (const y of [4, 11]) {
      const inner = y === 4 ? 5 : 10;
      if (x >= W - depth(inner)) set(px, x, y, 0x3e2c18);
    }
  }
}

/**
 * 88 stump_top — a chopped top: bark 0x5e4630 ±8 where the distance d from (8, 8) is ≥ 7, wood 0xb8935c ±5 inside it
 * with growth rings 0x8f7345 wherever frac(d / 1.7) < 0.3, a 2×2 dark pith 0x6a5030 at (7..8, 7..8), and a set of three
 * parallel chop marks: dark 0x4a3620 strokes 4 px long at one random angle, 2 px apart across it, centred on a random
 * point 2–3.5 from the middle, each with a pale 0xdcc08a lip pixel beside its first pixel.
 */
function paintStumpTop(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d >= 7) set(px, x, y, 0x5e4630, delta(rng, 8));
      else set(px, x, y, (d / 1.7) % 1 < 0.3 ? 0x8f7345 : 0xb8935c, delta(rng, 5));
    }
  }
  for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) set(px, x, y, 0x6a5030);
  const a = rng() * Math.PI;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const r0 = 2 + rng() * 1.5;
  const b = rng() * Math.PI * 2;
  const mx = 7.5 + Math.cos(b) * r0;
  const my = 7.5 + Math.sin(b) * r0;
  for (const off of [-2, 0, 2]) {
    const cx = mx - uy * off;
    const cy = my + ux * off;
    const x0 = Math.round(cx - ux * 1.5);
    const y0 = Math.round(cy - uy * 1.5);
    line(px, x0, y0, Math.round(cx + ux * 1.5), Math.round(cy + uy * 1.5), 0x4a3620);
    setClipped(px, x0 - Math.round(uy), y0 + Math.round(ux), 0xdcc08a);
  }
}

/** @returns {boolean} (x, y) lies in the kiln's arched mouth: x 4–11, rows ≥ 11, or within 3.6 of (8, 11), from row 8 */
function inKilnMouth(x, y) {
  if (x < 4 || x > 11 || y < 8) return false;
  return y >= 11 || Math.hypot(x + 0.5 - 8, y + 0.5 - 11) <= 3.6;
}

/**
 * 89 kiln_side — clay coil courses: rows in threes, each course 0xc0703a (every other one 0xb0622f) ±6 with a lighter
 * top row (+14) and a dark 0x7a3e1c seam on its last row; a dark arched mouth 0x1c1210 (x 4–11 from row 11 down, arched
 * above within 3.6 of (8, 11) from row 8) framed by a fired-clay rim 0x8a4422 on the pixels next to it, and an ember
 * line on the mouth's bottom two rows: 0xff7a1a / 0xffb02e alternating, ±10.
 */
function paintKilnSide(px, rng) {
  for (let y = 0; y < H; y++) {
    const course = Math.floor(y / 3);
    const row = y % 3;
    const base = course % 2 === 0 ? 0xc0703a : 0xb0622f;
    for (let x = 0; x < W; x++) {
      if (row === 2) set(px, x, y, 0x7a3e1c, delta(rng, 5));
      else set(px, x, y, base, delta(rng, 6) + (row === 0 ? 14 : 0));
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inKilnMouth(x, y)) {
        const ember = y >= 14;
        set(px, x, y, ember ? ((x + y) % 2 === 0 ? 0xff7a1a : 0xffb02e) : 0x1c1210, ember ? delta(rng, 10) : delta(rng, 3));
      } else if (inKilnMouth(x - 1, y) || inKilnMouth(x + 1, y) || inKilnMouth(x, y + 1)) {
        set(px, x, y, 0x8a4422, delta(rng, 5));
      }
    }
  }
}

/**
 * 90 kiln_top — the dome from above: clay coils as rings 2 px wide around (8, 8) (0xb8683a / 0xa85c30 alternating, ±6),
 * a sooty ring 0x4a3a30 for 2.6 ≤ d < 3.6, a dark smoke vent 0x140e0c for d < 2.6 with three pale-grey 0x8a8580 smoke
 * pixels inside it.
 */
function paintKilnTop(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d < 2.6) set(px, x, y, 0x140e0c, delta(rng, 3));
      else if (d < 3.6) set(px, x, y, 0x4a3a30, delta(rng, 6));
      else set(px, x, y, Math.floor(d / 2) % 2 === 0 ? 0xb8683a : 0xa85c30, delta(rng, 6));
    }
  }
  for (const [x, y] of [[7, 7], [8, 6], [8, 8]]) set(px, x, y, 0x8a8580, delta(rng, 6));
}

/**
 * Small-brick courses (bloomery): bricks 4 px wide and 2 rows tall, every other course offset by 2; each brick
 * `brickHex` with one ±10 tint, the mortar (a brick's last row and last column) `mortarHex` ±4, noise 4.
 */
function paintSmallBricks(px, rng, brickHex, mortarHex) {
  for (let course = 0; course < H / 2; course++) {
    const off = (course % 2) * 2;
    for (let b = -1; b < W / 4; b++) {
      const tint = delta(rng, 10);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const x = b * 4 + off + dx;
          if (x < 0 || x >= W) continue;
          const y = course * 2 + dy;
          const mortar = dy === 1 || dx === 3;
          set(px, x, y, mortar ? mortarHex : brickHex, mortar ? delta(rng, 4) : tint);
        }
      }
    }
  }
  noise(px, rng, 4);
}

/**
 * 91 bloomery_side — a tall brick stack: small bricks (paintSmallBricks 0x8a4a32 / mortar 0x4e3326), sooted on rows 0–2
 * (−24); four dark slag dribbles running from a start row 6–10 down to the bottom row, 2 px wide (0x221c18 and
 * 0x3a2e28 beside it, ±4, with a glassy 0x6a5a4a glint pixel with p 0.15), wandering a column aside with p 0.25 a row
 * (x 6–14) and pooling in a 3-px drop on the bottom row; and a tuyère near the bottom left: a 3×3 clay ring 0xa86a3a ±6
 * around (3, 12), its middle a 0xff8a3a glow, two of its corners dark 0x120c0a.
 */
function paintBloomerySide(px, rng) {
  paintSmallBricks(px, rng, 0x8a4a32, 0x4e3326);
  for (let y = 0; y <= 2; y++) for (let x = 0; x < W; x++) adjAt(px, x, y, -24);
  for (let k = 0; k < 4; k++) {
    let x = randInt(rng, 6, 14);
    for (let y = randInt(rng, 6, 10); y < H; y++) {
      set(px, x, y, rng() < 0.15 ? 0x6a5a4a : 0x221c18, delta(rng, 4));
      setClipped(px, x + 1, y, 0x3a2e28, delta(rng, 4));
      if (rng() < 0.25) x = Math.max(6, Math.min(14, x + (rng() < 0.5 ? -1 : 1)));
    }
    setClipped(px, x - 1, H - 1, 0x221c18);
    setClipped(px, x + 2, H - 1, 0x3a2e28);
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set(px, 3 + dx, 12 + dy, 0xa86a3a, delta(rng, 6));
  set(px, 3, 12, 0xff8a3a);
  for (const [x, y] of [[2, 11], [4, 13]]) set(px, x, y, 0x120c0a);
}

/**
 * 92 bloomery_top — the throat from above: the small bricks (0x8a4a32 / 0x4e3326) outside d 5.6 from (8, 8), a dark clay
 * lip 0x3e2a20 for 4.8 ≤ d < 5.6, and inside it charcoal lumps — 2×2 cells of 0x1e1e20, 0x2e2e30 or 0x3a3a3e at random —
 * with 8 dim glow pixels between them (0x8a3010, every third 0xc04a18).
 */
function paintBloomeryTop(px, rng) {
  paintSmallBricks(px, rng, 0x8a4a32, 0x4e3326);
  const CHAR = [0x1e1e20, 0x2e2e30, 0x3a3a3e];
  for (let cy = 0; cy < H; cy += 2) {
    for (let cx = 0; cx < W; cx += 2) {
      const lump = pick(rng, CHAR);
      for (let y = cy; y < cy + 2; y++) {
        for (let x = cx; x < cx + 2; x++) {
          const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
          if (d < 4.8) set(px, x, y, lump, delta(rng, 4));
          else if (d < 5.6) set(px, x, y, 0x3e2a20, delta(rng, 4));
        }
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * 4;
    set(px, Math.floor(8 + Math.cos(a) * r), Math.floor(8 + Math.sin(a) * r), k % 3 === 2 ? 0xc04a18 : 0x8a3010);
  }
}

/**
 * 93 forge_side — a brick hearth: the shared brick layout (paintBrickLayout) in 0x7a4030 with 0x4a3428 mortar; a grey
 * stone lintel 0x6e6e6a ±6 across rows 5–6 (x 2–13) over the opening, the opening (x 4–11, rows 7–13) dark 0x16100e, its
 * rows 11–13 a bed of glowing coal (0xc02a0a, 0xff6a1a, 0xffb02e at random, ±8) with a 0xfff0a0 hot spot at (7–8, 12).
 */
function paintForgeSide(px, rng) {
  paintBrickLayout(px, rng, 0x4a3428, 4, 0x7a4030, 12, 5);
  for (let y = 5; y <= 6; y++) for (let x = 2; x <= 13; x++) set(px, x, y, 0x6e6e6a, delta(rng, 6) + (y === 5 ? 10 : 0));
  for (let y = 7; y <= 13; y++) {
    for (let x = 4; x <= 11; x++) {
      if (y >= 11) set(px, x, y, pick(rng, [0xc02a0a, 0xff6a1a, 0xffb02e]), delta(rng, 8));
      else set(px, x, y, 0x16100e, delta(rng, 3));
    }
  }
  set(px, 7, 12, 0xfff0a0);
  set(px, 8, 12, 0xfff0a0);
}

/**
 * 94 forge_top — a dark iron hexagonal anvil face on bricks: the forge's brick layout (this seed), then a pointy-top
 * hexagon of circumradius 6.4 around (8, 8) in iron 0x3a3d42 ±4, its edge pixels (a 4-neighbour outside) lit 0x6a7078
 * on the upper-left half and 0x24262a on the lower-right, a 2×2 square hardy hole 0x101012 at (9..10, 8..9) and a round
 * pritchel hole 0x101012 at (5, 6).
 */
function paintForgeTop(px, rng) {
  paintBrickLayout(px, rng, 0x4a3428, 4, 0x7a4030, 12, 5);
  const inHex = (x, y) => inHexagon(x, y, 8, 8, 6.4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inHex(x, y)) continue;
      const edge = !inHex(x - 1, y) || !inHex(x + 1, y) || !inHex(x, y - 1) || !inHex(x, y + 1);
      if (edge) set(px, x, y, x + y < 15 ? 0x6a7078 : 0x24262a, delta(rng, 3));
      else set(px, x, y, 0x3a3d42, delta(rng, 4));
    }
  }
  for (const [x, y] of [[9, 8], [10, 8], [9, 9], [10, 9], [5, 6]]) set(px, x, y, 0x101012);
}

/**
 * 95 basket_side — a diagonal straw weave: strands run along both diagonals in 3-px bands, and the strand on top at a
 * pixel alternates with the band parity ((floor((x + y) / 3) + floor((x − y + 16) / 3)) & 1): straw 0xc8a45a or the
 * shaded 0xa8843e, ±8; where the band along the visible strand changes (its first pixel) a dark 0x6a5228 gap; the rim
 * on rows 0–1 is darker 0x8a6a32 ±6.
 */
function paintBasketSide(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = Math.floor((x + y) / 3);
      const b = Math.floor((x - y + 16) / 3);
      const upA = ((a + b) & 1) === 0;
      const along = upA ? (x - y + 16) % 3 : (x + y) % 3;
      if (along === 0) set(px, x, y, 0x6a5228, delta(rng, 5));
      else set(px, x, y, upA ? 0xc8a45a : 0xa8843e, delta(rng, 8));
    }
  }
  for (let y = 0; y <= 1; y++) for (let x = 0; x < W; x++) set(px, x, y, 0x8a6a32, delta(rng, 6) + (y === 0 ? 10 : 0));
}

/**
 * 96 basket_top — a coiled straw lid: rings 2 px wide around (8, 8) alternating 0xc8a45a / 0xb08c48 ±6, with a dark
 * 0x6a5228 stitch on every third pixel of each ring's inner row; a 0x8a6a32 rim beyond d 7.2; and a cord knot in the
 * middle — cords 0x7a5a3a crossing it two pixels each way, a 2×2 knot 0x5a3e24 with a 0x9a7a52 highlight pixel, and two
 * short tails hanging down-right.
 */
function paintBasketTop(px, rng) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d >= 7.2) {
        set(px, x, y, 0x8a6a32, delta(rng, 6));
        continue;
      }
      const ring = Math.floor(d / 2);
      const inner = d - ring * 2 < 0.7;
      if (inner && (x + 2 * y) % 3 === 0) set(px, x, y, 0x6a5228, delta(rng, 4));
      else set(px, x, y, ring % 2 === 0 ? 0xc8a45a : 0xb08c48, delta(rng, 6));
    }
  }
  for (let k = -3; k <= 4; k++) {
    if (k >= 0 && k <= 1) continue;
    set(px, 7 + k, 7, 0x7a5a3a, delta(rng, 4));
    set(px, 7, 7 + k, 0x7a5a3a, delta(rng, 4));
  }
  for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) set(px, x, y, 0x5a3e24);
  set(px, 7, 7, 0x9a7a52);
  for (const [x, y] of [[9, 9], [10, 10], [9, 10], [9, 11]]) set(px, x, y, 0x7a5a3a, delta(rng, 4));
}

/**
 * 97 hide_side — the Sleeping Hide's edge: rawhide 0xa8825a (2×2 cell noise 10, noise 5) under a rolled edge on rows 0–2
 * (0xc8a070 ±6) with a dark 0x5a4030 line on row 3, and three stake heads along the edge at x 2, 7 and 12: 2×2 pegs
 * 0x6a4a2a on rows 1–2 with a lighter 0x9a7448 top pixel, each with a lashing cord 0x4a3424 slanting down-right to row 6.
 */
function paintHideSide(px, rng) {
  fill(px, 0xa8825a);
  cellNoise(px, rng, 2, 10);
  noise(px, rng, 5);
  for (let y = 0; y <= 2; y++) for (let x = 0; x < W; x++) set(px, x, y, 0xc8a070, delta(rng, 6) + (y === 2 ? -10 : 0));
  for (let x = 0; x < W; x++) set(px, x, 3, 0x5a4030, delta(rng, 4));
  for (const sx of [2, 7, 12]) {
    for (let y = 1; y <= 2; y++) for (let x = sx; x <= sx + 1; x++) set(px, x, y, 0x6a4a2a, delta(rng, 4));
    set(px, sx, 1, 0x9a7448);
    line(px, sx + 1, 3, sx + 3, 6, 0x4a3424);
  }
}

/**
 * 98 hide_top — a hide pegged out at six corner stakes: dark trampled earth 0x3e3226 (noise 6) around a pointy-top
 * hexagon of circumradius 7 at (8, 8) of hide 0xb8905e (2×2 cell noise 10, noise 4) with a darker 0x8a6a40 edge; a stake
 * at each of the six corners (2×2 0x5a3a1e with a 0x8a6a40 top-left pixel, clamped into the tile).
 */
function paintHideTop(px, rng) {
  fill(px, 0x3e3226);
  noise(px, rng, 6);
  const inHex = (x, y) => inHexagon(x, y, 8, 8, 7);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inHex(x, y)) continue;
      const edge = !inHex(x - 1, y) || !inHex(x + 1, y) || !inHex(x, y - 1) || !inHex(x, y + 1);
      set(px, x, y, edge ? 0x8a6a40 : 0xb8905e, delta(rng, 4));
    }
  }
  cellNoiseMasked(px, rng, 2, 10, inHex);
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    const sx = Math.max(0, Math.min(14, Math.round(8 + Math.cos(a) * 7 - 1)));
    const sy = Math.max(0, Math.min(14, Math.round(8 + Math.sin(a) * 7 - 1)));
    for (let y = sy; y <= sy + 1; y++) for (let x = sx; x <= sx + 1; x++) set(px, x, y, 0x5a3a1e, delta(rng, 4));
    set(px, sx, sy, 0x8a6a40);
  }
}

/** `cellNoise`, applied only to the pixels where `mask(x, y)` holds. */
function cellNoiseMasked(px, rng, size, amp, mask) {
  for (let cy = 0; cy < H; cy += size) {
    for (let cx = 0; cx < W; cx += size) {
      const d = delta(rng, amp);
      for (let y = cy; y < cy + size; y++) for (let x = cx; x < cx + size; x++) if (mask(x, y)) adjAt(px, x, y, d);
    }
  }
}

/** Honey tag colours of Your Belongings (the honey of the survival screens, #e8b04a). */
const TAG_HONEY = 0xe8b04a;
const TAG_EDGE = 0xa87420;
const TAG_HOLE = 0x5a3a10;

/** A honey hex tag: a pointy-top hexagon of circumradius R at (cx, cy), honey with a darker outline. */
function paintHexTag(px, cx, cy, R) {
  const inHex = (x, y) => inHexagon(x, y, cx, cy, R);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inHex(x, y)) continue;
      const edge = !inHex(x - 1, y) || !inHex(x + 1, y) || !inHex(x, y - 1) || !inHex(x, y + 1);
      set(px, x, y, edge ? TAG_EDGE : TAG_HONEY);
    }
  }
}

/**
 * 99 remains_side — Your Belongings, on alpha 0: a hide-wrapped heap on rows 9–15 (pixels inside the half-ellipse at
 * (7, 16), 6.2 wide and 6.6 tall: hide 0x8a6a48 ±8, its lower half 0x6a4e34, a 0x5a4030 outline on pixels with a
 * transparent 4-neighbour) tied with cord 0x4a3424 in a hex knot (the outline of a pointy-top hexagon of circumradius 2.2
 * at (7, 12.5)); a tall marker stick 0x6a4a2a ±6 at x 12 from row 15 up to row 4; and at its top a honey hex tag
 * (pointy-top hexagon of circumradius 3 at (12.5, 3): 0xe8b04a, outline 0xa87420) with a dark 0x5a3a10 hole.
 */
function paintRemainsSide(px, rng) {
  clearTile(px);
  const inHeap = (x, y) => {
    if (y < 9 || x < 0 || x >= W || y >= H) return false;
    const ex = (x + 0.5 - 7) / 6.2;
    const ey = (y + 0.5 - 16) / 6.6;
    return ex * ex + ey * ey <= 1;
  };
  for (let y = 9; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inHeap(x, y)) continue;
      const edge = !inHeap(x - 1, y) || !inHeap(x + 1, y) || !inHeap(x, y - 1);
      set(px, x, y, edge ? 0x5a4030 : y >= 13 ? 0x6a4e34 : 0x8a6a48, delta(rng, 8));
    }
  }
  const inKnot = (x, y) => inHexagon(x, y, 7, 12.5, 2.2);
  for (let y = 9; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inKnot(x, y)) continue;
      if (!inKnot(x - 1, y) || !inKnot(x + 1, y) || !inKnot(x, y - 1) || !inKnot(x, y + 1)) set(px, x, y, 0x4a3424);
    }
  }
  for (let y = 4; y < H; y++) set(px, 12, y, 0x6a4a2a, delta(rng, 6));
  paintHexTag(px, 12.5, 3, 3);
  set(px, 12, 2, TAG_HOLE);
}

/**
 * 100 remains_top — the marker's tag from above, on alpha 0: a small honey hex knot at the centre (pointy-top hexagon of
 * circumradius 2.4 at (8, 8): 0xe8b04a, outline 0xa87420, a 0x5a3a10 centre pixel at (7, 7)). Everything else stays
 * alpha 0: the top face is drawn a whole cell up, so it must stay small.
 */
function paintRemainsTop(px) {
  clearTile(px);
  paintHexTag(px, 8, 8, 2.4);
  set(px, 7, 7, TAG_HOLE);
}

/**
 * 101 plant_top_clear — every pixel alpha 0 (RGB 0): the top and bottom faces of the short plants, the litter and the fire
 * pit, which the mesher draws a whole cell up (§8.1), so nothing shows there.
 */
function paintPlantTopClear(px) {
  px.fill(0);
}

/**
 * 102 loose_stones — seen from ABOVE (a decal lying on the cell's floor): on alpha 0, six or seven pebbles scattered inside
 * the tile's inscribed hexagon (centre (7.5, 7.5), radius 6.3), none touching another: each an ellipse 1.2–2.2 wide and
 * 1–1.7 tall in grey 0x8a8a86 / 0x6e6e6a / 0xa09e98 or ochre 0xa8844a / 0x8e6c3c (±6), lit +20 on its upper-left outline
 * and shaded −22 on its lower-right outline, with a dark 0x2a2520 shadow pixel below-right of its lower rim. The first is a
 * dark flint nodule 0x2e3038 with a pale 0xc8c4b4 cortex on its outline (flint comes from these).
 */
function paintLooseStones(px, rng) {
  clearTile(px);
  const COLOURS = [0x8a8a86, 0x6e6e6a, 0xa09e98, 0xa8844a, 0x8e6c3c];
  const owner = new Int8Array(W * H).fill(-1);
  const count = randInt(rng, 6, 7);
  for (let k = 0, tries = 0; k < count && tries < 400; tries++) {
    const flint = k === 0;
    const hw = flint ? 2 : 1.2 + rng() * 1;
    const hh = flint ? 1.6 : 1 + rng() * 0.7;
    const cx = 2.5 + rng() * 10;
    const cy = 2.5 + rng() * 10;
    if (Math.hypot(cx - 7.5, cy - 7.5) > 6.3 - Math.max(hw, hh)) continue;
    const inStone = (x, y) => ((x + 0.5 - cx) / hw) ** 2 + ((y + 0.5 - cy) / hh) ** 2 <= 1;
    /** @type {number[]} */
    const cells = [];
    let clash = false;
    for (let y = Math.floor(cy - hh - 1); y <= Math.ceil(cy + hh + 1) && !clash; y++) {
      for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (inStone(x, y)) cells.push(x, y);
        else continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && owner[ny * W + nx] >= 0) clash = true;
        }
      }
    }
    if (clash || cells.length < 3) continue;
    const hex = flint ? 0x2e3038 : pick(rng, COLOURS);
    for (let i = 0; i < cells.length; i += 2) {
      const x = cells[i];
      const y = cells[i + 1];
      owner[y * W + x] = k;
      const upLeft = !inStone(x - 1, y) || !inStone(x, y - 1);
      const downRight = !inStone(x + 1, y) || !inStone(x, y + 1);
      if (flint && (upLeft || downRight)) set(px, x, y, 0xc8c4b4, delta(rng, 6));
      else set(px, x, y, hex, delta(rng, 6) + (upLeft ? 20 : downRight ? -22 : 0));
      if (!inStone(x, y + 1) && !inStone(x + 1, y + 1) && x + 1 < W && y + 1 < H && owner[(y + 1) * W + x + 1] < 0) {
        set(px, x + 1, y + 1, 0x2a2520, delta(rng, 4));
        owner[(y + 1) * W + x + 1] = k;
      }
    }
    k++;
  }
}

/**
 * 103 fallen_branches — seen from ABOVE (a decal lying on the cell's floor): on alpha 0, inside the tile's inscribed hexagon,
 * two crossed branches 2 px thick — from (2, 5) to (13, 10) and from (4, 12) to (12, 3) — and a 1-px twig from (6, 10) to
 * (9, 13), in bark 0x5e4228 ±8 with a darker 0x3e2a18 shadow pixel below each stick pixel (never over another stick),
 * pale 0xb89868 cut ends, two side twigs (2-px 0x6a4a2c strokes) and 5 lichen flecks (0xb8c49a or 0xd0d8b0) on the bark.
 */
function paintFallenBranches(px, rng) {
  clearTile(px);
  /** @type {number[]} */
  const stick = [];
  const STICKS = [[2, 5, 13, 10, 2], [4, 12, 12, 3, 2], [6, 10, 9, 13, 1]];
  const line = (x0, y0, x1, y1, thick, hex, mark) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n);
      const y = Math.round(y0 + ((y1 - y0) * i) / n);
      for (let t = 0; t < thick; t++) {
        const yy = y + t;
        if (x < 0 || yy < 0 || x >= W || yy >= H) continue;
        const end = mark && (i === 0 || i === n);
        set(px, x, yy, end ? 0xb89868 : hex, delta(rng, 8));
        stick.push(yy * W + x);
      }
    }
  };
  for (const [x0, y0, x1, y1, thick] of STICKS) line(x0, y0, x1, y1, thick, 0x5e4228, true);
  line(8, 7, 10, 5, 1, 0x6a4a2c, false);
  line(6, 9, 4, 8, 1, 0x6a4a2c, false);
  const onStick = new Set(stick);
  for (const p of stick) {
    const x = p % W;
    const y = Math.floor(p / W) + 1;
    if (y < H && !onStick.has(y * W + x)) set(px, x, y, 0x3e2a18, delta(rng, 4));
  }
  for (let k = 0; k < 5; k++) {
    const p = stick[Math.floor(rng() * stick.length)];
    set(px, p % W, Math.floor(p / W), rng() < 0.5 ? 0xb8c49a : 0xd0d8b0);
  }
}

/**
 * 104 fire_pit_side — the Cold Fire Pit: rows 0–9 alpha 0; three charred sticks leaning out of the pit, 2 px wide, from
 * (x0, 13) up to a top row 10 or 11 one column aside, at x0 4, 7 and 10 (0x1a1612 ±4, a 0x3a302a end pixel and a 0x8a8680
 * ash tip); pale ash 0xd8d4cc / 0xb8b4ac (±5) filling rows 13–15 between them; and in front, four rounded fire stones
 * over rows 12–15 centred at x 2, 6, 10 and 14 (half-width 1.8, 1.7–2.2 rows high, standing on row 15: grey 0x6e6e6a /
 * 0x5e5e5a ±8, lit +18 on their top pixels, −22 on the other outline pixels, and the top pixel nearest the middle
 * sooted −30).
 */
function paintFirePitSide(px, rng) {
  clearTile(px);
  for (let y = 13; y < H; y++) for (let x = 0; x < W; x++) set(px, x, y, rng() < 0.5 ? 0xd8d4cc : 0xb8b4ac, delta(rng, 5));
  for (const [x0, lean] of [[4, -1], [7, 1], [10, 1]]) {
    const top = randInt(rng, 10, 11);
    for (let y = top; y <= 13; y++) {
      const xs = x0 + (y <= top + 1 ? lean : 0);
      for (let x = xs; x <= xs + 1; x++) set(px, x, y, 0x1a1612, delta(rng, 4));
    }
    set(px, x0 + lean, top, 0x3a302a);
    set(px, x0 + lean + 1, top, 0x8a8680);
  }
  for (const cx of [2, 6, 10, 14]) {
    const hw = 1.8;
    const hh = 1.7 + rng() * 0.5;
    const hex = rng() < 0.5 ? 0x6e6e6a : 0x5e5e5a;
    const inStone = (x, y) => {
      const ex = (x + 0.5 - cx) / hw;
      const ey = (y + 0.5 - (H - hh)) / hh;
      return y >= 12 && y < H && ex * ex + ey * ey <= 1.1;
    };
    let sooted = false;
    for (let y = 12; y < H; y++) {
      for (let x = Math.max(0, Math.floor(cx - hw)); x <= Math.min(W - 1, Math.ceil(cx + hw)); x++) {
        if (!inStone(x, y)) continue;
        const lit = !inStone(x, y - 1);
        const outline = !inStone(x - 1, y) || !inStone(x + 1, y);
        let d = delta(rng, 8) + (lit ? 18 : outline ? -22 : 0);
        if (lit && !sooted && Math.abs(x + 0.5 - 8) < Math.abs(cx - 8)) {
          d -= 30;
          sooted = true;
        }
        set(px, x, y, hex, d);
      }
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
  spruce_log_side: paintSpruceLogSide,
  spruce_log_end: paintSpruceLogEnd,
  spruce_planks: paintSprucePlanks,
  spruce_leaves: paintSpruceLeaves,
  birch_log_side: paintBirchLogSide,
  birch_log_end: paintBirchLogEnd,
  birch_planks: paintBirchPlanks,
  birch_leaves: paintBirchLeaves,
  granite: paintGranite,
  diorite: paintDiorite,
  andesite: paintAndesite,
  slate: paintSlate,
  mossy_cobblestone: paintMossyCobblestone,
  mossy_stone_bricks: paintMossyStoneBricks,
  obsidian: paintObsidian,
  clay: paintClay,
  red_sand: paintRedSand,
  ice: paintIce,
  packed_ice: paintPackedIce,
  coal_block: paintCoalBlock,
  iron_block: paintIronBlock,
  gold_block: paintGoldBlock,
  diamond_block: paintDiamondBlock,
  copper_block: paintCopperBlock,
  glowstone: paintGlowstone,
  honeycomb: paintHoneycomb,
  hay_bale_side: paintHayBaleSide,
  hay_bale_top: paintHayBaleTop,
  pumpkin_side: paintPumpkinSide,
  pumpkin_top: paintPumpkinTop,
  black_hole: paintBlackHole,
  campfire_side: paintCampfireSide,
  campfire_top: paintCampfireTop,
  copper_ore: paintCopperOre,
  tin_ore: paintTinOre,
  honeyberry_bush: paintHoneyberryBush,
  honeyberry_bush_bare: paintHoneyberryBushBare,
  tussock: paintTussock,
  cattails_side: paintCattailsSide,
  cattails_top: paintCattailsTop,
  tuber_plant: paintTuberPlant,
  prickly_pear: paintPricklyPear,
  prickly_pear_bare: paintPricklyPearBare,
  stump_side: paintStumpSide,
  stump_top: paintStumpTop,
  kiln_side: paintKilnSide,
  kiln_top: paintKilnTop,
  bloomery_side: paintBloomerySide,
  bloomery_top: paintBloomeryTop,
  forge_side: paintForgeSide,
  forge_top: paintForgeTop,
  basket_side: paintBasketSide,
  basket_top: paintBasketTop,
  hide_side: paintHideSide,
  hide_top: paintHideTop,
  remains_side: paintRemainsSide,
  remains_top: paintRemainsTop,
  plant_top_clear: paintPlantTopClear,
  loose_stones: paintLooseStones,
  fallen_branches: paintFallenBranches,
  fire_pit_side: paintFirePitSide,
  zombie_face: paintZombieFace,
  zombie_head_side: paintZombieHeadSide,
  zombie_scalp: paintZombieScalp,
  zombie_shirt: paintZombieShirt,
  zombie_trousers: paintZombieTrousers,
  zombie_sole: paintZombieSole,
  watcher_stone: paintWatcherStone,
  watcher_cracks: paintWatcherCracks,
  watcher_smoke: paintWatcherSmoke,
  ...Object.fromEntries(Object.entries(WOOL_HEX).map(([name, hex]) => [name, (px, rng) => paintWool(px, rng, hex)])),
  missing: paintMissing,
  // Last: the 35 powder-and-circuits tiles and the Powder Keg's barrel_side / barrel_top (circuitTiles.js, §6.2.9).
  ...CIRCUIT_RECIPES,
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
