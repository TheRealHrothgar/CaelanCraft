// Unit tests for src/tiles.js — CONTRACTS.md §15 and docs/SPEC-gameplay.md §2.2–§2.5.
import { describe, it, expect } from 'vitest';
import { TILE, TILE_IDS } from '../../src/blocks.js';
import { TILE_NAMES, paintTile, averageColor, createTilePainters } from '../../src/tiles.js';

const W = 16;
const H = 16;
const BYTES = W * H * 4;

/** @returns {number} byte index of pixel (x, y) */
function idx(x, y) {
  return (y * W + x) * 4;
}

/** @returns {[number, number, number, number]} [r, g, b, a] of pixel (x, y) */
function rgba(px, x, y) {
  const i = idx(x, y);
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

/** @returns {boolean} pixel (x, y) has alpha 255 */
function opaque(px, x, y) {
  return px[idx(x, y) + 3] === 255;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Count pixels of `a` whose RGB differs from `b`. */
function countRgbDiff(a, b) {
  let n = 0;
  for (let i = 0; i < BYTES; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

/** v0.9 survival tiles whose empty space is alpha 0 (DESIGN-survival §8.2); every other survival tile is alpha 255. */
const SURVIVAL_CUTOUT = [
  TILE.HONEYBERRY_BUSH, TILE.HONEYBERRY_BUSH_BARE, TILE.TUSSOCK, TILE.CATTAILS_SIDE, TILE.CATTAILS_TOP, TILE.TUBER_PLANT,
  TILE.PRICKLY_PEAR, TILE.PRICKLY_PEAR_BARE, TILE.REMAINS_SIDE, TILE.REMAINS_TOP, TILE.LOOSE_STONES, TILE.FALLEN_BRANCHES,
  TILE.FIRE_PIT_SIDE,
];

/** Assert every pixel satisfies `pred(r, g, b, a, x, y)`. */
function everyPixel(px, pred, rows = null) {
  for (let y = 0; y < H; y++) {
    if (rows && !rows.includes(y)) continue;
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = rgba(px, x, y);
      if (!pred(r, g, b, a, x, y)) {
        throw new Error(`pixel (${x},${y}) = rgba(${r},${g},${b},${a}) failed predicate`);
      }
    }
  }
  return true;
}

describe('TILE_NAMES', () => {
  it('lists all 105 block tiles plus the mob tiles and 255 missing, matching blocks.js TILE keys in lower_snake', () => {
    const keys = Object.keys(TILE_NAMES).map(Number).sort((a, b) => a - b);
    expect(keys).toEqual([...TILE_IDS].sort((a, b) => a - b));
    // v0.8: + barrel_side 75, barrel_top 76; zombies (§39): + 240–245; the Watcher (§40): + 250–252 (stone, crack glow, smoke);
    // v0.9 survival: + 77–104 (DESIGN-survival §8.1)
    expect(keys.length).toBe(115);
    expect(TILE_NAMES[TILE.COPPER_ORE]).toBe('copper_ore');
    expect(TILE_NAMES[TILE.PLANT_TOP_CLEAR]).toBe('plant_top_clear');
    expect(TILE_NAMES[TILE.FIRE_PIT_SIDE]).toBe('fire_pit_side');
    expect(TILE_NAMES[TILE.RUNE]).toBe('rune');
    expect(TILE.RUNE).toBe(27);
    for (const [key, id] of Object.entries(TILE)) {
      expect(TILE_NAMES[id]).toBe(key.toLowerCase());
    }
    expect(TILE_NAMES[255]).toBe('missing');
    expect(TILE_NAMES[TILE.GRASS_TOP]).toBe('grass_top');
    expect(TILE_NAMES[TILE.OAK_LOG_SIDE]).toBe('oak_log_side');
    expect(TILE_NAMES[TILE.SNOWY_GRASS_SIDE]).toBe('snowy_grass_side');
  });
  it('is frozen', () => {
    expect(Object.isFrozen(TILE_NAMES)).toBe(true);
  });
});

describe('paintTile — shape and determinism', () => {
  it('paints a 1024-byte Uint8ClampedArray for every id in TILE_IDS', () => {
    for (const t of TILE_IDS) {
      const px = paintTile(t);
      expect(px).toBeInstanceOf(Uint8ClampedArray);
      expect(px.length).toBe(BYTES);
    }
  });
  it('is deterministic: two calls give identical bytes in fresh arrays', () => {
    for (const t of TILE_IDS) {
      const a = paintTile(t);
      const b = paintTile(t);
      expect(a).not.toBe(b);
      expect(sameBytes(a, b)).toBe(true);
    }
  });
  it('does not depend on call order (no shared RNG state between tiles)', () => {
    const first = paintTile(TILE.STONE);
    paintTile(TILE.DIRT);
    paintTile(TILE.COBBLESTONE);
    const again = paintTile(TILE.STONE);
    expect(sameBytes(first, again)).toBe(true);
  });
  it('every tile differs from every other tile', () => {
    const all = TILE_IDS.map((t) => [t, paintTile(t)]);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(sameBytes(all[i][1], all[j][1]), `tiles ${all[i][0]} and ${all[j][0]} are identical`).toBe(false);
      }
    }
  });
});

describe('paintTile — alpha rules', () => {
  it('water has alpha 178 on every pixel', () => {
    const px = paintTile(TILE.WATER);
    everyPixel(px, (_r, _g, _b, a) => a === 178);
  });
  it('glass: interior alpha 0, border and streak pixels alpha 255', () => {
    const px = paintTile(TILE.GLASS);
    everyPixel(px, (_r, _g, _b, a, x, y) => {
      const border = x === 0 || x === 15 || y === 0 || y === 15;
      const streak = (x + y === 5 && x >= 1 && x <= 4) || (x + y === 9 && x >= 1 && x <= 8);
      return a === (border || streak ? 255 : 0);
    });
  });
  it('glass: corners are white, border is #E1EEF3, streaks are #E8F4FA, interior is transparent white', () => {
    const px = paintTile(TILE.GLASS);
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) {
      expect(rgba(px, x, y)).toEqual([255, 255, 255, 255]);
    }
    expect(rgba(px, 5, 0)).toEqual([0xe1, 0xee, 0xf3, 255]);
    expect(rgba(px, 0, 9)).toEqual([0xe1, 0xee, 0xf3, 255]);
    expect(rgba(px, 2, 3)).toEqual([0xe8, 0xf4, 0xfa, 255]);
    expect(rgba(px, 8, 1)).toEqual([0xe8, 0xf4, 0xfa, 255]);
    expect(rgba(px, 7, 7)).toEqual([255, 255, 255, 0]);
  });
  it('oak_leaves has ~22% alpha-0 holes (12–32%), all other pixels alpha 255', () => {
    const px = paintTile(TILE.OAK_LEAVES);
    let holes = 0;
    for (let i = 3; i < BYTES; i += 4) {
      expect(px[i] === 0 || px[i] === 255).toBe(true);
      if (px[i] === 0) holes++;
    }
    expect(holes / 256).toBeGreaterThanOrEqual(0.12);
    expect(holes / 256).toBeLessThanOrEqual(0.32);
    // Holes keep their RGB (still green) so cutout edges do not fringe black.
    everyPixel(px, (r, g, b) => g > r && g > b);
  });
  it('spruce / birch leaves have oak-style holes (12–32% alpha 0, rest 255); ice is alpha 200 everywhere', () => {
    for (const t of [TILE.SPRUCE_LEAVES, TILE.BIRCH_LEAVES]) {
      const px = paintTile(t);
      let holes = 0;
      for (let i = 3; i < BYTES; i += 4) {
        expect(px[i] === 0 || px[i] === 255).toBe(true);
        if (px[i] === 0) holes++;
      }
      expect(holes / 256).toBeGreaterThanOrEqual(0.12);
      expect(holes / 256).toBeLessThanOrEqual(0.32);
    }
    const ice = paintTile(TILE.ICE);
    for (let i = 3; i < BYTES; i += 4) expect(ice[i]).toBe(200);
  });
  it('plant_top_clear (v0.9) is alpha 0 on every pixel, RGB 0, and averages to black', () => {
    const px = paintTile(TILE.PLANT_TOP_CLEAR);
    everyPixel(px, (r, g, b, a) => r === 0 && g === 0 && b === 0 && a === 0);
    expect(averageColor(TILE.PLANT_TOP_CLEAR)).toEqual([0, 0, 0]);
  });
  it('every other tile is alpha 255 everywhere', () => {
    const special = new Set([
      TILE.WATER, TILE.GLASS, TILE.OAK_LEAVES, TILE.SPRUCE_LEAVES, TILE.BIRCH_LEAVES, TILE.ICE, TILE.CAMPFIRE_SIDE, TILE.CAMPFIRE_TOP,
      TILE.PLANT_TOP_CLEAR, // v0.9: all alpha 0 (the test above)
      ...SURVIVAL_CUTOUT, // v0.9: plants, litter, the fire pit and Your Belongings (DESIGN-survival §8.2; tested below)
    ]);
    for (const t of TILE_IDS) {
      if (special.has(t)) continue;
      const px = paintTile(t);
      for (let i = 3; i < BYTES; i += 4) {
        if (px[i] !== 255) throw new Error(`tile ${t} (${TILE_NAMES[t]}) has alpha ${px[i]} at byte ${i}`);
      }
    }
  });
});

describe('paintTile — recipe details', () => {
  it('missing tile is the magenta/black 8×8 quadrant checker', () => {
    const px = paintTile(TILE.MISSING);
    everyPixel(px, (r, g, b, a, x, y) => {
      const magenta = (x < 8) === (y < 8);
      return a === 255 && (magenta ? r === 255 && g === 0 && b === 255 : r === 0 && g === 0 && b === 0);
    });
  });
  it('unknown tile ids paint the missing checker', () => {
    const missing = paintTile(TILE.MISSING);
    for (const bad of [105, 159, 254, -1, 1000, 0.5, NaN, undefined, null, '0', 'stone']) { // 77–104 are tiles since v0.9
      // @ts-ignore — deliberately passing garbage
      expect(sameBytes(paintTile(bad), missing), `tile ${String(bad)}`).toBe(true);
    }
  });
  it('rune (27): fully opaque, deterministic, dark slate with the bright cyan rune colour and a 2×2 centre dot', () => {
    const px = paintTile(TILE.RUNE);
    expect(px).toBeInstanceOf(Uint8ClampedArray);
    expect(px.length).toBe(BYTES);
    everyPixel(px, (_r, _g, _b, a) => a === 255);
    expect(sameBytes(paintTile(TILE.RUNE), px)).toBe(true);
    expect(sameBytes(px, paintTile(TILE.MISSING))).toBe(false);
    // The outline colour 0x7be8ff appears (several outline pixels), the centre dot is 0xd8f8ff.
    let bright = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = rgba(px, x, y);
        if (r === 0x7b && g === 0xe8 && b === 0xff) bright++;
      }
    }
    expect(bright).toBeGreaterThanOrEqual(12);
    for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) expect(rgba(px, x, y)).toEqual([0xd8, 0xf8, 0xff, 255]);
    // Corner pixels are slate (dark, slightly blue-purple), never rune cyan.
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) {
      const [r, g, b] = rgba(px, x, y);
      expect(r).toBeLessThan(80);
      expect(g).toBeLessThan(80);
      expect(b).toBeGreaterThanOrEqual(r);
    }
    // Rune tiles never depend on anything but their own seed: averageColor is stable and dark overall.
    const [ar, ag, ab] = averageColor(TILE.RUNE);
    expect(ar).toBeLessThan(ab);
    expect(ag).toBeLessThan(160);
  });
  it('grass_side: rows 0..1 are greenish, row 15 is brownish dirt', () => {
    const px = paintTile(TILE.GRASS_SIDE);
    everyPixel(px, (r, g, b) => g > r && g > b, [0, 1]);
    everyPixel(px, (r, g, b) => r > g && g > b, [15]);
  });
  it('grass_side and snowy_grass_side reuse the dirt recipe with the "dirt" seed (rows 5..15 identical)', () => {
    const dirt = paintTile(TILE.DIRT);
    for (const t of [TILE.GRASS_SIDE, TILE.SNOWY_GRASS_SIDE]) {
      const px = paintTile(t);
      for (let y = 5; y < H; y++) {
        for (let x = 0; x < W; x++) {
          expect(rgba(px, x, y), `${TILE_NAMES[t]} (${x},${y})`).toEqual(rgba(dirt, x, y));
        }
      }
    }
  });
  it('snowy_grass_side: rows 0..2 are snow white, row 15 is brownish dirt', () => {
    const px = paintTile(TILE.SNOWY_GRASS_SIDE);
    everyPixel(px, (r, g, b) => r >= 230 && g >= 240 && b >= 240, [0, 1, 2]);
    everyPixel(px, (r, g, b) => r > g && g > b, [15]);
  });
  it('ores start from the stone recipe with the "stone" seed and add only blob pixels', () => {
    const stone = paintTile(TILE.STONE);
    const table = [
      [TILE.COAL_ORE, 6],
      [TILE.IRON_ORE, 5],
      [TILE.GOLD_ORE, 5],
      [TILE.DIAMOND_ORE, 5],
    ];
    for (const [t, count] of table) {
      const px = paintTile(t);
      const diff = countRgbDiff(px, stone);
      expect(diff, TILE_NAMES[t]).toBeGreaterThanOrEqual(3);
      expect(diff, TILE_NAMES[t]).toBeLessThanOrEqual(count * 6);
      // Blob pixels never land on the outer ring of the tile (x,y ∈ [1,13] → max x+1 = 14, y+2 = 15).
      for (let y = 0; y < H; y++) {
        expect(rgba(px, 15, y)).toEqual(rgba(stone, 15, y));
      }
      for (let x = 0; x < W; x++) {
        expect(rgba(px, x, 0)).toEqual(rgba(stone, x, 0));
      }
    }
  });
  it('coal ore contains near-black pixels; diamond ore contains its highlight colour', () => {
    const coal = paintTile(TILE.COAL_ORE);
    let dark = 0;
    for (let i = 0; i < BYTES; i += 4) if (coal[i] <= 0x3b && coal[i] === coal[i + 1] && coal[i] === coal[i + 2]) dark++;
    expect(dark).toBeGreaterThanOrEqual(3);
    const diamond = paintTile(TILE.DIAMOND_ORE);
    let highlight = 0;
    for (let i = 0; i < BYTES; i += 4) if (diamond[i] === 0xe8 && diamond[i + 1] === 0xff && diamond[i + 2] === 0xff) highlight++;
    expect(highlight).toBeGreaterThanOrEqual(1);
    expect(highlight).toBeLessThanOrEqual(5);
  });
  it('bookshelf starts from oak_planks ("oak_planks" seed); rows 0, 7, 8, 15 are untouched planks', () => {
    const planks = paintTile(TILE.OAK_PLANKS);
    const shelf = paintTile(TILE.BOOKSHELF);
    for (const y of [0, 7, 8, 15]) {
      for (let x = 0; x < W; x++) expect(rgba(shelf, x, y), `(${x},${y})`).toEqual(rgba(planks, x, y));
    }
    // Shelf rows are fully covered by books or the dark shelf back — never raw planks.
    let bookish = 0;
    for (const y of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
      for (let x = 0; x < W; x++) {
        if (!sameBytes(rgba(shelf, x, y), rgba(planks, x, y))) bookish++;
      }
    }
    expect(bookish).toBeGreaterThan(150);
  });
  it('bricks: mortar/brick layout follows the band formula exactly', () => {
    const px = paintTile(TILE.BRICKS);
    everyPixel(px, (r, g, _b, _a, x, y) => {
      const b = Math.floor(y / 4);
      const o = (b % 2) * 4;
      const mortar = y % 4 === 3 || (x + o) % 8 === 7;
      // adj() adds the same delta to every channel, so r-g is invariant (no clamping at these magnitudes):
      // brick base #965040 keeps r-g = 0x96-0x50 = 70; mortar #B4AEA5 keeps r-g = 6.
      return mortar ? r - g === 6 : r - g === 70;
    });
  });
  it('stone_bricks: grey mortar and brick with the same layout (up to 3 chips)', () => {
    const px = paintTile(TILE.STONE_BRICKS);
    let off = 0;
    everyPixel(px, (r, g, b, _a, x, y) => {
      if (r !== g || g !== b) return false; // always grey
      const band = Math.floor(y / 4);
      const o = (band % 2) * 4;
      const mortar = y % 4 === 3 || (x + o) % 8 === 7;
      const lo = mortar ? 0x4f - 4 : 0x7a - 17;
      const hi = mortar ? 0x4f + 4 : 0x7a + 17;
      if (r < lo - 20 || r > hi) return false;
      if (r < lo) off++; // chipped pixel
      return true;
    });
    expect(off).toBeLessThanOrEqual(3);
  });
  it('cobblestone is fully grey with both mortar and stone shades', () => {
    const px = paintTile(TILE.COBBLESTONE);
    let mortar = 0;
    let stone = 0;
    everyPixel(px, (r, g, b) => {
      if (r !== g || g !== b) return false;
      if (r <= 0x4a + 4) mortar++;
      else stone++;
      return true;
    });
    // With the spec's 9 toroidal seeds and a 1.2 tie threshold the mortar share is large (~54% for this seed);
    // just require both phases to be clearly present.
    expect(mortar).toBeGreaterThan(32);
    expect(stone).toBeGreaterThan(32);
  });
  it('oak_planks has dark seam rows 3, 7, 11, 15 and lighter plank rows', () => {
    const px = paintTile(TILE.OAK_PLANKS);
    // Seams are #6E5533 ± noise(5); plank body is #A2824E ± 8 ± 14 (streak) ± 5.
    everyPixel(px, (r) => r >= 0x6e - 5 && r <= 0x6e + 5, [3, 7, 11, 15]);
    everyPixel(px, (r, g, b) => r > g && g > b);
    const body = rgba(px, 0, 0);
    expect(body[0]).toBeGreaterThan(0x6e + 5);
  });
  it('oak_log_end has a bark rim and a ring at the centre', () => {
    const px = paintTile(TILE.OAK_LOG_END);
    // Bark: #6B5032 ± 10 on the outer two rings (r >= 6.5 → x or y in {0,1,14,15}).
    everyPixel(px, (r, g, b, _a, x, y) => {
      const rr = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (rr < 6.5) return true;
      return Math.abs(r - 0x6b) <= 10 && Math.abs(g - 0x50) <= 10 && Math.abs(b - 0x32) <= 10;
    });
    // Centre 2×2 (r = 0.5) is a ring #8F7345 ± 6.
    for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) {
      const [r, g, b] = rgba(px, x, y);
      expect(Math.abs(r - 0x8f)).toBeLessThanOrEqual(6);
      expect(Math.abs(g - 0x73)).toBeLessThanOrEqual(6);
      expect(Math.abs(b - 0x45)).toBeLessThanOrEqual(6);
    }
    // (7,5) → r = 2.5 ring; (7,4) → r = 3.5 wood #AF8F5A ± 6.
    expect(Math.abs(rgba(px, 7, 5)[0] - 0x8f)).toBeLessThanOrEqual(6);
    expect(Math.abs(rgba(px, 7, 4)[0] - 0xaf)).toBeLessThanOrEqual(6);
  });
  it('oak_log_side is brown with per-column shading', () => {
    const px = paintTile(TILE.OAK_LOG_SIDE);
    everyPixel(px, (r, g, b) => r > g && g > b);
  });
  it('sandstone_side has light top rows, a dark bottom row and strata', () => {
    const px = paintTile(TILE.SANDSTONE_SIDE);
    everyPixel(px, (r) => Math.abs(r - 0xe3) <= 5, [0, 1]);
    everyPixel(px, (r) => Math.abs(r - 0xcd) <= 5, [14]);
    everyPixel(px, (r) => Math.abs(r - 0xb9) <= 5, [15]);
    for (const y of [5, 9, 13]) {
      let strata = 0;
      for (let x = 0; x < W; x++) if (Math.abs(rgba(px, x, y)[0] - 0xc3) <= 5) strata++;
      expect(strata, `row ${y}`).toBeGreaterThanOrEqual(6);
    }
  });
  it('water is blue with a few lighter ripple pixels', () => {
    const px = paintTile(TILE.WATER);
    everyPixel(px, (r, g, b) => b > g && g > r);
    let ripples = 0;
    for (let i = 0; i < BYTES; i += 4) if (px[i] === 0x6a && px[i + 1] === 0x9b && px[i + 2] === 0xf0) ripples++;
    expect(ripples).toBeGreaterThanOrEqual(3);
    expect(ripples).toBeLessThanOrEqual(18);
  });
  it('snow and wool_white are near-white; wool_red is red dominant; sand is warm', () => {
    everyPixel(paintTile(TILE.SNOW), (r, g, b) => r >= 200 && g >= 200 && b >= 200);
    everyPixel(paintTile(TILE.WOOL_WHITE), (r, g, b) => r >= 200 && g >= 200 && b >= 200);
    everyPixel(paintTile(TILE.WOOL_RED), (r, g, b) => r > g + 60 && r > b + 60);
    everyPixel(paintTile(TILE.SAND), (r, g, b) => r >= g && g > b);
  });
  it('gravel is grey; bedrock is dark grey; dirt is brown; grass_top is green', () => {
    everyPixel(paintTile(TILE.GRAVEL), (r, g, b) => Math.abs(r - g) <= 3 && Math.abs(g - b) <= 5);
    everyPixel(paintTile(TILE.BEDROCK), (r, g, b) => r === g && g === b);
    everyPixel(paintTile(TILE.DIRT), (r, g, b) => r > g && g > b);
    everyPixel(paintTile(TILE.GRASS_TOP), (r, g, b) => g > r && g > b);
  });
  it('stone is grey with a 2×2 cell structure (each cell shares its cell-noise offset)', () => {
    const px = paintTile(TILE.STONE);
    everyPixel(px, (r, g, b) => r === g && g === b);
    // Base #7E7E7E, cellNoise ±14, noise ±5 → [107, 145]; specks #6A6A6A (106) sit just below that band.
    everyPixel(px, (r) => r >= 0x6a && r <= 0x7e + 19);
  });
});

describe('averageColor', () => {
  it('returns sane [r,g,b] 0..255 for key tiles', () => {
    const stone = averageColor(TILE.STONE);
    expect(stone).toHaveLength(3);
    for (const c of stone) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
    expect(Math.abs(stone[0] - stone[1])).toBeLessThan(20);
    expect(Math.abs(stone[1] - stone[2])).toBeLessThan(20);
    expect(Math.abs(stone[0] - 0x7e)).toBeLessThan(12);

    const grass = averageColor(TILE.GRASS_TOP);
    expect(grass[1]).toBeGreaterThan(grass[0]);
    expect(grass[1]).toBeGreaterThan(grass[2]);

    const water = averageColor(TILE.WATER);
    expect(water[2]).toBeGreaterThan(water[0]);
    expect(water[2]).toBeGreaterThan(water[1]);
  });
  it('ignores pixels with alpha < 128 (glass averages only its frame and streaks)', () => {
    const glass = averageColor(TILE.GLASS);
    // Frame #E1EEF3 / corners #FFFFFF / streaks #E8F4FA — all channels well above 0xE0.
    for (const c of glass) expect(c).toBeGreaterThanOrEqual(0xe1);
    expect(glass[0]).toBeLessThan(glass[2]);
    // Leaves: holes are excluded, and the mean stays green.
    const leaves = averageColor(TILE.OAK_LEAVES);
    expect(leaves[1]).toBeGreaterThan(leaves[0]);
  });
  it('averages the missing checker to half magenta', () => {
    const m = averageColor(TILE.MISSING);
    expect(Math.abs(m[0] - 127.5)).toBeLessThanOrEqual(0.5);
    expect(m[1]).toBe(0);
    expect(Math.abs(m[2] - 127.5)).toBeLessThanOrEqual(0.5);
  });
  it('is deterministic and matches a manual mean of paintTile', () => {
    for (const t of TILE_IDS) {
      const px = paintTile(t);
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
      const got = averageColor(t);
      if (n === 0) {
        // No pixel qualifies (plant_top_clear): the documented [0, 0, 0].
        expect(got, TILE_NAMES[t]).toEqual([0, 0, 0]);
        continue;
      }
      expect(Math.abs(got[0] - r / n), TILE_NAMES[t]).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got[1] - g / n), TILE_NAMES[t]).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got[2] - b / n), TILE_NAMES[t]).toBeLessThanOrEqual(0.5);
      expect(averageColor(t)).toEqual(got);
    }
  });
  it('unknown tile averages like the missing checker', () => {
    expect(averageColor(999)).toEqual(averageColor(TILE.MISSING));
  });
});

describe('blast barrel tiles (v0.8)', () => {
  it('side: wooden staves, dark iron bands and a red hazard hexagon; top: a lid with a burning fuse tip; alpha 255', () => {
    const side = paintTile(TILE.BARREL_SIDE);
    const top = paintTile(TILE.BARREL_TOP);
    const px = (t, x, y) => [t[(y * 16 + x) * 4], t[(y * 16 + x) * 4 + 1], t[(y * 16 + x) * 4 + 2], t[(y * 16 + x) * 4 + 3]];
    for (let i = 3; i < BYTES; i += 4) {
      expect(side[i]).toBe(255);
      expect(top[i]).toBe(255);
    }
    const [r, g, b] = px(side, 8, 8); // inside the hexagon
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    const band = px(side, 5, 2); // iron band: grey
    expect(Math.abs(band[0] - band[2])).toBeLessThan(20);
    expect(band[0]).toBeLessThan(110);
    const stave = px(side, 1, 6); // wood: brown
    expect(stave[0]).toBeGreaterThan(stave[2] + 30);
    const tip = px(top, 11, 4); // the fuse tip glows
    expect(tip[0]).toBeGreaterThan(220);
    expect(tip[1]).toBeGreaterThan(160);
    expect(averageColor(TILE.BARREL_SIDE)[0]).toBeGreaterThan(averageColor(TILE.BARREL_SIDE)[2]);
  });
});

describe('survival tiles (v0.9, DESIGN-survival §8.1–§8.2)', () => {
  const SURVIVAL = Array.from({ length: 28 }, (_, i) => 77 + i);
  it('77–104 each have a recipe of their own: not the missing checker, distinct, deterministic', () => {
    const missing = paintTile(TILE.MISSING);
    const seen = [];
    for (const t of SURVIVAL) {
      expect(Object.hasOwn(TILE_NAMES, t), `tile ${t}`).toBe(true);
      const px = paintTile(t);
      expect(sameBytes(px, missing), TILE_NAMES[t]).toBe(false);
      expect(sameBytes(px, paintTile(t)), TILE_NAMES[t]).toBe(true);
      for (const [u, other] of seen) expect(sameBytes(px, other), `${TILE_NAMES[t]} vs ${TILE_NAMES[u]}`).toBe(false);
      seen.push([t, px]);
    }
  });

  /** @returns {number} pixels of `px` with alpha 0 (in `rows`, default all) */
  const clearCount = (px, rows = null) => {
    let n = 0;
    for (let y = 0; y < H; y++) {
      if (rows && !rows.includes(y)) continue;
      for (let x = 0; x < W; x++) if (px[idx(x, y) + 3] === 0) n++;
    }
    return n;
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  /** @returns {number} pixels whose RGB is `hex` (opaque ones only) */
  const countHex = (px, hex) => {
    let n = 0;
    for (let i = 0; i < BYTES; i += 4) {
      if (px[i + 3] === 255 && px[i] === ((hex >> 16) & 255) && px[i + 1] === ((hex >> 8) & 255) && px[i + 2] === (hex & 255)) n++;
    }
    return n;
  };

  it('use alpha 0 or 255 only: ores, workplaces, basket and hide fully opaque; plants, litter, fire pit and belongings cut out', () => {
    for (const t of SURVIVAL) {
      const px = paintTile(t);
      for (let i = 3; i < BYTES; i += 4) expect(px[i] === 0 || px[i] === 255, `${TILE_NAMES[t]} alpha ${px[i]}`).toBe(true);
      const clear = clearCount(px);
      if (t === TILE.PLANT_TOP_CLEAR) expect(clear).toBe(256);
      else if (SURVIVAL_CUTOUT.includes(t)) {
        expect(clear, TILE_NAMES[t]).toBeGreaterThan(20);
        expect(clear, TILE_NAMES[t]).toBeLessThan(256);
      } else expect(clear, TILE_NAMES[t]).toBe(0);
    }
  });

  it('the short blocks keep their stated upper rows alpha 0 and stand on their bottom row', () => {
    // [tile, last alpha-0 row, the art's top row must lie at or below]
    const SHORT = [
      [TILE.TUSSOCK, 3, 6], [TILE.TUBER_PLANT, 8, 10], [TILE.LOOSE_STONES, 10, 13], [TILE.FALLEN_BRANCHES, 11, 12],
      [TILE.FIRE_PIT_SIDE, 9, 11],
    ];
    for (const [t, lastClear, topBy] of SHORT) {
      const px = paintTile(t);
      expect(clearCount(px, range(0, lastClear)), TILE_NAMES[t]).toBe(16 * (lastClear + 1));
      let firstOpaqueRow = -1;
      for (let y = 0; y < H && firstOpaqueRow < 0; y++) for (let x = 0; x < W; x++) if (px[idx(x, y) + 3] === 255) firstOpaqueRow = y;
      expect(firstOpaqueRow, TILE_NAMES[t]).toBeGreaterThan(lastClear);
      expect(firstOpaqueRow, TILE_NAMES[t]).toBeLessThanOrEqual(topBy);
      expect(clearCount(px, [15]), `${TILE_NAMES[t]} bottom row`).toBeLessThanOrEqual(12); // it rests on the ground
    }
  });

  it('tussock: blades about 45 % alpha 0 (35–55 %), yellow tips above a green base', () => {
    const px = paintTile(TILE.TUSSOCK);
    const share = clearCount(px) / 256;
    expect(share).toBeGreaterThanOrEqual(0.35);
    expect(share).toBeLessThanOrEqual(0.55);
    let tips = 0;
    for (let y = 4; y <= 8; y++) for (let x = 0; x < W; x++) if (opaque(px, x, y) && rgba(px, x, y)[0] > 150) tips++;
    expect(tips).toBeGreaterThan(5);
    everyPixel(px, (r, g, b, a) => a === 0 || (g >= b && g > 60), [12, 13, 14, 15]);
  });

  it('cattails: green stalks and leaves with brown heads on rows 1–4; the top is mostly alpha 0', () => {
    const side = paintTile(TILE.CATTAILS_SIDE);
    for (const x of [3, 8, 12]) {
      for (let y = 1; y <= 4; y++) {
        const [r, g, b, a] = rgba(side, x, y);
        expect(a).toBe(255);
        expect(r).toBeGreaterThan(g); // brown
        expect(g).toBeGreaterThan(b);
      }
      const [r, g, , a] = rgba(side, x, 10);
      expect(a).toBe(255);
      expect(g).toBeGreaterThan(r); // a green stalk
    }
    const top = paintTile(TILE.CATTAILS_TOP);
    expect(clearCount(top) / 256).toBeGreaterThan(0.75);
  });

  it('honeyberry bushes: deep blue-green foliage with holes; ripe berries are dusky blue with a pale bloom; the picked bush is the same bush, sparser, berry-free', () => {
    const ripe = paintTile(TILE.HONEYBERRY_BUSH);
    const bare = paintTile(TILE.HONEYBERRY_BUSH_BARE);
    const BERRY = [0x9aa6d6, 0x5b6bb0, 0x3b4a8a];
    expect(countHex(ripe, 0x9aa6d6)).toBeGreaterThanOrEqual(12); // 6–8 clusters of 2–3 berries
    expect(countHex(ripe, 0x3b4a8a)).toBeGreaterThan(countHex(ripe, 0x9aa6d6) / 2);
    for (const hex of BERRY) expect(countHex(bare, hex), hex.toString(16)).toBe(0);
    expect(clearCount(ripe) / 256).toBeGreaterThan(0.08);
    expect(clearCount(ripe) / 256).toBeLessThan(0.32);
    expect(clearCount(bare)).toBeGreaterThan(clearCount(ripe) + 30);
    // The foliage is blue-green: green above red, blue close behind.
    const leaf = averageColor(TILE.HONEYBERRY_BUSH_BARE);
    expect(leaf[1]).toBeGreaterThan(leaf[0]);
    expect(leaf[2]).toBeGreaterThan(leaf[0] - 10);
    // Same bush: every opaque leaf pixel of the picked bush (not a twig) is the ripe bush's pixel or a berry there.
    let same = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const b = rgba(bare, x, y);
        if (b[3] !== 255 || (b[0] > b[1])) continue; // holes and brown twigs
        const r = rgba(ripe, x, y);
        const berry = BERRY.some((hex) => r[0] === ((hex >> 16) & 255) && r[1] === ((hex >> 8) & 255) && r[2] === (hex & 255));
        expect(berry || sameBytes(r, b), `(${x},${y})`).toBe(true);
        same++;
      }
    }
    expect(same).toBeGreaterThan(100);
  });

  it('prickly pears: the same pads (#5d8f3a family) with spines; red-yellow fruit only on the ripe one', () => {
    const ripe = paintTile(TILE.PRICKLY_PEAR);
    const bare = paintTile(TILE.PRICKLY_PEAR_BARE);
    let fruit = 0;
    let fruitBare = 0;
    let differ = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, , a] = rgba(ripe, x, y);
        if (a === 255 && r > g + 40 && r > 120) fruit++;
        const [r2, g2, , a2] = rgba(bare, x, y);
        if (a2 === 255 && r2 > g2 + 40 && r2 > 120) fruitBare++;
        if (!sameBytes(rgba(ripe, x, y), rgba(bare, x, y))) differ++;
      }
    }
    expect(fruit).toBeGreaterThanOrEqual(15); // five 2×2 fruit
    expect(fruitBare).toBe(0);
    expect(differ).toBeLessThanOrEqual(5 * 4 + 5); // only the fruit and their scars differ
    expect(countHex(bare, 0xe6dfae)).toBeGreaterThanOrEqual(10); // spines
    const pad = averageColor(TILE.PRICKLY_PEAR_BARE);
    expect(pad[1]).toBeGreaterThan(pad[0]);
    expect(pad[1]).toBeGreaterThan(pad[2]);
  });

  it('copper and tin ores start from stone ("stone" seed): malachite bands and copper specks; dark cassiterite with white glints', () => {
    const stone = paintTile(TILE.STONE);
    const copper = paintTile(TILE.COPPER_ORE);
    const tin = paintTile(TILE.TIN_ORE);
    const cuDiff = countRgbDiff(copper, stone);
    expect(cuDiff).toBeGreaterThanOrEqual(5 * 5);
    expect(cuDiff).toBeLessThanOrEqual(5 * 9 + 3);
    expect(countHex(copper, 0x6fd39a)).toBeGreaterThanOrEqual(1);
    expect(countHex(copper, 0x2f8f5b) + countHex(copper, 0x1f6b43)).toBeGreaterThanOrEqual(15);
    expect(countHex(copper, 0x2f8f5b)).toBeGreaterThan(0); // both bands
    expect(countHex(copper, 0x1f6b43)).toBeGreaterThan(0);
    const specks = countHex(copper, 0xc8743a);
    expect(specks).toBeGreaterThanOrEqual(2);
    expect(specks).toBeLessThanOrEqual(3);
    for (let x = 0; x < W; x++) expect(rgba(copper, x, 0)).toEqual(rgba(stone, x, 0)); // blobs stay off the top row
    const snDiff = countRgbDiff(tin, stone);
    expect(snDiff).toBeGreaterThanOrEqual(5 * 2);
    expect(snDiff).toBeLessThanOrEqual(5 * 9);
    expect(countHex(tin, 0x2a211c)).toBeGreaterThan(0);
    expect(countHex(tin, 0xf4f2ea)).toBeGreaterThanOrEqual(1);
    expect(countHex(tin, 0xf4f2ea)).toBeLessThanOrEqual(4);
    for (let x = 0; x < W; x++) expect(rgba(tin, x, 0)).toEqual(rgba(stone, x, 0));
  });

  it('Your Belongings: a heap with a honey hex tag high on its marker; the top is only a small honey knot', () => {
    const side = paintTile(TILE.REMAINS_SIDE);
    let honey = 0;
    let rim = 0;
    for (let y = 0; y <= 5; y++) {
      for (let x = 9; x < W; x++) {
        if (sameBytes(rgba(side, x, y), [0xe8, 0xb0, 0x4a, 255])) honey++;
        if (sameBytes(rgba(side, x, y), [0xa8, 0x74, 0x20, 255])) rim++;
      }
    }
    expect(honey).toBeGreaterThanOrEqual(5);
    expect(honey + rim).toBeGreaterThanOrEqual(16); // a tag big enough to see from about 20 cells
    expect(countHex(side, 0xe8b04a)).toBe(honey); // the honey is only on the tag
    expect(clearCount(side, range(0, 5))).toBeGreaterThan(50); // the background is see-through
    for (let y = 4; y < H; y++) expect(opaque(side, 12, y), `marker stick at row ${y}`).toBe(true);
    let heap = 0;
    for (let y = 9; y < H; y++) for (let x = 0; x < 11; x++) if (opaque(side, x, y)) heap++;
    expect(heap).toBeGreaterThan(30);
    const top = paintTile(TILE.REMAINS_TOP);
    expect(clearCount(top) / 256).toBeGreaterThan(0.85);
    expect(countHex(top, 0xe8b04a)).toBeGreaterThan(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (opaque(top, x, y)) expect(Math.hypot(x + 0.5 - 8, y + 0.5 - 8)).toBeLessThan(3.2);
    }
  });

  it('the workplaces, basket and hide read as what they are', () => {
    const p = (t, x, y) => rgba(paintTile(t), x, y);
    const dark = ([r, g, b]) => Math.max(r, g, b) < 60;
    const glow = ([r, , b]) => r > 190 && r > b + 80;
    // Work Stump: a dark pith in the middle of pale wood, bark at the corners, a pale notch on the right edge.
    expect(p(TILE.STUMP_TOP, 7, 7)[0]).toBeLessThan(0x80);
    expect(p(TILE.STUMP_TOP, 0, 0)[0]).toBeLessThan(p(TILE.STUMP_TOP, 4, 7)[0]);
    expect(p(TILE.STUMP_SIDE, 15, 7)[0]).toBeGreaterThan(0xb0);
    // Kiln: a dark arched mouth with embers along its floor; a dark vent on top.
    expect(dark(p(TILE.KILN_SIDE, 7, 11))).toBe(true);
    expect(glow(p(TILE.KILN_SIDE, 7, 15))).toBe(true);
    expect(dark(p(TILE.KILN_TOP, 6, 8))).toBe(true);
    expect(Math.max(...p(TILE.KILN_TOP, 7, 7).slice(0, 3))).toBeGreaterThan(0x70); // a smoke pixel in the vent
    expect(p(TILE.KILN_SIDE, 1, 1)[0]).toBeGreaterThan(p(TILE.KILN_SIDE, 1, 1)[2] + 60); // clay orange
    // Bloomery: the tuyère glows; charcoal fills the throat with dim embers; brick at the corners.
    expect(p(TILE.BLOOMERY_SIDE, 3, 12)).toEqual([0xff, 0x8a, 0x3a, 255]);
    expect(dark(p(TILE.BLOOMERY_TOP, 6, 9)) || glow(p(TILE.BLOOMERY_TOP, 6, 9)) || p(TILE.BLOOMERY_TOP, 6, 9)[0] < 0x90).toBe(true);
    expect(p(TILE.BLOOMERY_TOP, 0, 0)[0]).toBeGreaterThan(p(TILE.BLOOMERY_TOP, 0, 0)[2]);
    // Forge: a dark opening over glowing coal; a dark iron hexagon with a hardy hole on top.
    expect(dark(p(TILE.FORGE_SIDE, 8, 8))).toBe(true);
    expect(glow(p(TILE.FORGE_SIDE, 9, 12)) || p(TILE.FORGE_SIDE, 9, 12)[0] > 0xb0).toBe(true);
    expect(p(TILE.FORGE_SIDE, 7, 12)).toEqual([0xff, 0xf0, 0xa0, 255]);
    expect(p(TILE.FORGE_TOP, 9, 8)).toEqual([0x10, 0x10, 0x12, 255]);
    const iron = p(TILE.FORGE_TOP, 6, 9);
    expect(Math.abs(iron[0] - iron[2])).toBeLessThan(16);
    expect(iron[0]).toBeLessThan(80);
    expect(p(TILE.FORGE_TOP, 0, 0)[0]).toBeGreaterThan(p(TILE.FORGE_TOP, 0, 0)[2] + 20); // bricks beyond the anvil
    // Basket and hide: straw and leather tones throughout.
    everyPixel(paintTile(TILE.BASKET_SIDE), (r, g, b) => r > b + 30 && r >= g);
    everyPixel(paintTile(TILE.BASKET_TOP), (r, g, b) => r > b + 30 && r >= g);
    everyPixel(paintTile(TILE.HIDE_SIDE), (r, g, b) => r > b + 20 && r >= g);
    const hide = averageColor(TILE.HIDE_TOP);
    expect(hide[0]).toBeGreaterThan(hide[2] + 30);
    expect(p(TILE.HIDE_TOP, 8, 8)[0]).toBeGreaterThan(0x90); // the hide in the middle, earth and stakes at the rim
  });

  it('litter: grey and ochre pebbles with one dark flint nodule; brown sticks with lichen; a fire pit of stones, charred sticks and ash', () => {
    const stones = paintTile(TILE.LOOSE_STONES);
    let flint = 0;
    for (let y = 11; y < H; y++) for (let x = 0; x < W; x++) if (opaque(stones, x, y) && Math.max(...rgba(stones, x, y).slice(0, 3)) < 0x48) flint++;
    expect(flint).toBeGreaterThanOrEqual(2);
    const branches = averageColor(TILE.FALLEN_BRANCHES);
    expect(branches[0]).toBeGreaterThan(branches[2] + 15);
    const pit = paintTile(TILE.FIRE_PIT_SIDE);
    let charred = 0;
    let ash = 0;
    for (let y = 10; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!opaque(pit, x, y)) continue;
        const m = Math.max(...rgba(pit, x, y).slice(0, 3));
        if (m < 0x30) charred++;
        if (m > 0xa8) ash++;
      }
    }
    expect(charred).toBeGreaterThanOrEqual(6);
    expect(ash).toBeGreaterThanOrEqual(6);
  });
});

describe('zombie tiles (§39)', () => {
  const px = (t, x, y) => [t[(y * 16 + x) * 4], t[(y * 16 + x) * 4 + 1], t[(y * 16 + x) * 4 + 2]];
  const greenish = ([r, g, b]) => g > r && g > b;
  it('live in atlas row 15 (240–245), alpha 255', () => {
    for (const t of [TILE.ZOMBIE_FACE, TILE.ZOMBIE_HEAD_SIDE, TILE.ZOMBIE_SCALP, TILE.ZOMBIE_SHIRT, TILE.ZOMBIE_TROUSERS, TILE.ZOMBIE_SOLE]) {
      expect(Math.floor(t / 16)).toBe(15);
      const p = paintTile(t);
      for (let i = 3; i < BYTES; i += 4) expect(p[i]).toBe(255);
    }
  });
  it('face: grey-green skin, dark hair on top, two dark eye sockets with a glint, a crooked dark mouth with teeth', () => {
    const face = paintTile(TILE.ZOMBIE_FACE);
    expect(greenish(px(face, 1, 4))).toBe(true); // skin
    expect(px(face, 6, 0)[0]).toBeLessThan(70); // hair
    for (const [x, y] of [[3, 8], [10, 9]]) expect(Math.max(...px(face, x, y))).toBeLessThan(45); // sockets
    const glint = px(face, 4, 7);
    expect(glint[0]).toBeGreaterThan(180);
    expect(glint[2]).toBeLessThan(120);
    // The mouth is crooked: dark on row 12 at the left and right, but on row 13 in the middle.
    for (const [x, y] of [[4, 12], [8, 13], [11, 12]]) expect(Math.max(...px(face, x, y))).toBeLessThan(60);
    expect(Math.max(...px(face, 8, 12))).toBeGreaterThan(60);
    expect(Math.min(...px(face, 5, 12))).toBeGreaterThan(150); // a tooth
    // The other head sides have no face: no dark sockets in the eye rows.
    const side = paintTile(TILE.ZOMBIE_HEAD_SIDE);
    let dark = 0;
    for (let y = 6; y <= 9; y++) for (let x = 0; x < 16; x++) if (Math.max(...px(side, x, y)) < 45) dark++;
    expect(dark).toBeLessThan(3);
  });
  it('torn shirt (bluish cloth with skin showing), brown trousers over dark shoes, a dark sole', () => {
    const shirt = averageColor(TILE.ZOMBIE_SHIRT);
    expect(shirt[2]).toBeGreaterThan(shirt[0]);
    const tears = paintTile(TILE.ZOMBIE_SHIRT);
    let skin = 0;
    for (let y = 0; y < 13; y++) for (let x = 0; x < 16; x++) if (greenish(px(tears, x, y)) && px(tears, x, y)[1] > 120) skin++;
    expect(skin).toBeGreaterThan(4);
    const trousers = paintTile(TILE.ZOMBIE_TROUSERS);
    const leg = px(trousers, 3, 4);
    expect(leg[0]).toBeGreaterThan(leg[2] + 10);
    expect(Math.max(...px(trousers, 10, 14))).toBeLessThan(70); // shoe
    expect(Math.max(...averageColor(TILE.ZOMBIE_SOLE))).toBeLessThan(70);
  });
});

describe('createTilePainters', () => {
  it('returns a Map with a painter for every tile id that reproduces paintTile', () => {
    const painters = createTilePainters();
    expect(painters).toBeInstanceOf(Map);
    expect(painters.size).toBe(TILE_IDS.length);
    for (const t of TILE_IDS) {
      const fn = painters.get(t);
      expect(typeof fn, `tile ${t}`).toBe('function');
      expect(sameBytes(fn(), paintTile(t))).toBe(true);
    }
    // Keys are numbers, not strings.
    for (const k of painters.keys()) expect(typeof k).toBe('number');
  });
});
