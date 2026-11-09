// Caelancraft — procedural 16×16 painters of the powder-and-circuits tiles (docs/DESIGN-circuits.md §1.4, §3.5, §6.2.9) and of
// the Powder Keg's two tiles (75 barrel_side, 76 barrel_top). tiles.js spreads CIRCUIT_TILE_NAMES into its TILE_NAMES and
// CIRCUIT_RECIPES (last) into its RECIPES; `paintTile` then runs these painters exactly like its own.
//
// PURE: no DOM, no three, no imports, no Math.random. A painter is `(px, rng) => void` on a Uint8ClampedArray(16*16*4) in RGBA
// order with idx = (y*16 + x)*4 (row 0 is the world-up edge of side faces), and `rng` is tiles.js's mulberry32 stream seeded
// with fnv1a(tileName), so every tile is deterministic.
//
// K0 placeholders: every circuit tile is a flat colour derived from its name (a hue outside the violet 250°–300°), with a
// darker one-pixel frame. CIRCUIT_CLEAR (all alpha 0) and the flat pictures' alpha-0 background are already real; package C
// replaces the rest with the art of §1.4. The keg painters were moved here unchanged from tiles.js (their output is
// byte-identical); C repaints them (§3.5).

const W = 16;
const H = 16;

/** @typedef {() => number} Rng  uniform in [0,1) */

/**
 * Tile id → tile name for the 35 circuit tiles (160–194), the lower_snake form of their `TILE` keys in blocks.js. The keg's
 * tiles 75 / 76 keep their entries in tiles.js; only their painters live here.
 * @type {Readonly<Record<number, string>>}
 */
export const CIRCUIT_TILE_NAMES = Object.freeze({
  160: 'circuit_clear',
  161: 'collapsar_side',
  162: 'collapsar_top',
  163: 'powder_fuse',
  164: 'torch',
  165: 'copper_wire',
  166: 'brown_wire',
  167: 'white_wire',
  168: 'earth_wire',
  169: 'terminal_side',
  170: 'terminal_top',
  171: 'battery_side',
  172: 'battery_top',
  173: 'blaster_side',
  174: 'blaster_top',
  175: 'selenium_side',
  176: 'selenium_top',
  177: 'switch_side',
  178: 'switch_top',
  179: 'button_side',
  180: 'button_top',
  181: 'timer_side',
  182: 'timer_top',
  183: 'relay_side',
  184: 'relay_top',
  185: 'igniter_side',
  186: 'igniter_top',
  187: 'lamp_side',
  188: 'lamp_top',
  189: 'bell_side',
  190: 'bell_top',
  191: 'tx_side',
  192: 'tx_top',
  193: 'rx_side',
  194: 'rx_top',
});

/** The thin parts' top tiles: flat pictures on an alpha-0 background, drawn only as icons (§1.4, §1.5). */
const FLAT_PICTURES = Object.freeze(['powder_fuse', 'torch', 'copper_wire', 'brown_wire', 'white_wire', 'earth_wire']);

// ---------------------------------------------------------------------------------------------------------------
// Pixel helpers: private copies of tiles.js's (SPEC-gameplay §2.3), so the moved keg painters paint the same bytes.
// ---------------------------------------------------------------------------------------------------------------

/** @returns {number} byte offset of pixel (x, y) */
function idx(x, y) {
  return (y * W + x) * 4;
}

/**
 * `set(x, y, adj(hex, d), a)`: pixel (x, y) ← hex with `d` added to every channel (clamped by the Uint8ClampedArray).
 * Callers pass in-range coordinates.
 */
function set(px, x, y, hex, d = 0, a = 255) {
  const i = idx(x, y);
  px[i] = ((hex >> 16) & 255) + d;
  px[i + 1] = ((hex >> 8) & 255) + d;
  px[i + 2] = (hex & 255) + d;
  px[i + 3] = a;
}

/** Signed noise delta in [-amp, amp] — the §2.3 formula `round((rng()*2-1)*amp)`. */
function delta(rng, amp) {
  return Math.round((rng() * 2 - 1) * amp);
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

/**
 * FNV-1a 32-bit over UTF-16 code units (the same hash tiles.js seeds its streams with).
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

// ---------------------------------------------------------------------------------------------------------------
// The Powder Keg (moved unchanged from tiles.js; package C repaints both, DESIGN-circuits §3.5)
// ---------------------------------------------------------------------------------------------------------------

/**
 * 75 barrel_side — the Blast Barrel's staves: four vertical staves (3–4 px wide, three warm browns, noise 6) split by
 * dark 0x3e2612 seams, two dark iron bands on rows 1–3 and 12–14 (0x3a3d42, a 0x5f646c highlight row, 0x9aa0a8
 * rivets at x 2 and 13), and between them a red hazard hexagon (pointy-top, circumradius 4.2 around (8, 7.5):
 * 0xc8281e fill with a one-pixel 0x5e0c08 outline) carrying a pale 0xffe9a0 exclamation mark. Alpha 255.
 */
function paintBarrelSide(px, rng) {
  const STAVES = [[0, 3, 0x8a5a2e], [4, 7, 0x7a4c26], [8, 11, 0x93623a], [12, 15, 0x80522a]];
  for (const [x0, x1, hex] of STAVES) {
    for (let y = 0; y < H; y++) {
      for (let x = x0; x <= x1; x++) set(px, x, y, hex, delta(rng, 6) + (y % 5 === 0 ? -4 : 0));
    }
  }
  for (let y = 0; y < H; y++) for (const x of [3, 7, 11]) set(px, x, y, 0x3e2612, delta(rng, 4));
  for (const [y0, y1] of [[1, 3], [12, 14]]) {
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < W; x++) set(px, x, y, y === y0 ? 0x5f646c : 0x3a3d42, delta(rng, 4));
    }
    set(px, 2, y0 + 1, 0x9aa0a8);
    set(px, 13, y0 + 1, 0x9aa0a8);
  }
  const CX = 8;
  const CY = 7.5;
  for (let y = 4; y <= 11; y++) {
    for (let x = 3; x <= 12; x++) {
      if (!inHexagon(x, y, CX, CY, 4.2)) continue;
      const edge = !inHexagon(x - 1, y, CX, CY, 4.2) || !inHexagon(x + 1, y, CX, CY, 4.2) ||
        !inHexagon(x, y - 1, CX, CY, 4.2) || !inHexagon(x, y + 1, CX, CY, 4.2);
      set(px, x, y, edge ? 0x5e0c08 : 0xc8281e, edge ? 0 : delta(rng, 8));
    }
  }
  for (const y of [5, 6, 7]) {
    set(px, 7, y, 0xffe9a0);
    set(px, 8, y, 0xffe9a0);
  }
  set(px, 7, 9, 0xffe9a0);
  set(px, 8, 9, 0xffe9a0);
}

/**
 * 76 barrel_top — the lid: horizontal planks (rows of 3, 0x9a6a3a / 0x8a5c30, noise 5, 0x4a3018 seams), a dark iron rim
 * (0x3a3d42) on every pixel whose centre lies 6.2–7.9 from (8, 8), a 2×2 0x6a7078 fuse socket at (7..8, 7..8), and a
 * short fuse cord (0x2a2420) from the socket up-right to (11, 4) whose tip burns 0xffd040 with a 0xff7a1a ember beside it.
 * Alpha 255.
 */
function paintBarrelTop(px, rng) {
  for (let y = 0; y < H; y++) {
    const band = Math.floor(y / 3);
    const seam = y % 3 === 2;
    for (let x = 0; x < W; x++) set(px, x, y, seam ? 0x4a3018 : band % 2 === 0 ? 0x9a6a3a : 0x8a5c30, delta(rng, 5));
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d >= 6.2 && d < 7.9) set(px, x, y, 0x3a3d42, delta(rng, 4));
      else if (d >= 7.9) set(px, x, y, 0x2e3034, delta(rng, 3));
    }
  }
  for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) set(px, x, y, 0x6a7078);
  line(px, 8, 6, 9, 5, 0x2a2420);
  line(px, 9, 5, 10, 5, 0x2a2420);
  line(px, 10, 5, 11, 4, 0x2a2420);
  set(px, 11, 4, 0xffd040);
  set(px, 12, 3, 0xff7a1a);
  set(px, 11, 3, 0xffb02e);
}

// ---------------------------------------------------------------------------------------------------------------
// K0 placeholders (package C paints the real art of §1.4)
// ---------------------------------------------------------------------------------------------------------------

/** 160 circuit_clear — every pixel RGBA 0: the sides and bottom of the thin parts, which circuitRenderer draws. */
// CONTRACT-ISSUE: §6.2.9 exempts the circuit tiles only from tiles.test.js's "alpha 255 everywhere" rule, but circuit_clear
// is then byte-identical to survival's plant_top_clear (both RGBA 0), which "every tile differs from every other tile"
// forbids. K0 keeps it RGBA 0 (the atlas canvas drops the RGB of alpha-0 pixels anyway) and lets that test skip pairs of
// wholly transparent tiles.
function paintCircuitClear(px) {
  px.fill(0);
}

/**
 * A placeholder colour derived from a tile name: the hue is one of 0°–219° (never the violet 250°–300° the design forbids),
 * saturation 0.35–0.64 and lightness 0.32–0.55, all from fnv1a(name).
 * @param {string} name
 * @returns {number} packed 0xRRGGBB
 */
function placeholderColour(name) {
  const h = fnv1a(name);
  const hue = (h % 220) / 360;
  const sat = 0.35 + ((h >>> 8) % 30) / 100;
  const light = 0.32 + ((h >>> 16) % 24) / 100;
  // HSL → RGB
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t) => {
    const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = k < 1 / 6 ? p + (q - p) * 6 * k : k < 1 / 2 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p;
    return Math.round(v * 255);
  };
  return (channel(hue + 1 / 3) << 16) | (channel(hue) << 8) | channel(hue - 1 / 3);
}

/** A cabinet tile placeholder: the name's colour on every pixel with a one-pixel frame 40 darker. Alpha 255. */
function cabinetPlaceholder(name) {
  const hex = placeholderColour(name);
  return (px) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) set(px, x, y, hex, x === 0 || y === 0 || x === W - 1 || y === H - 1 ? -40 : 0);
    }
  };
}

/**
 * A flat-picture placeholder: an alpha-0 background (RGB 0) holding a pointy-top hexagon of circumradius 6 around (8, 8) in
 * the name's colour, its outline 40 darker. About 90 opaque pixels; the corners stay clear.
 */
function flatPlaceholder(name) {
  const hex = placeholderColour(name);
  return (px) => {
    px.fill(0);
    const R = 6;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inHexagon(x, y, 8, 8, R)) continue;
        const edge = !inHexagon(x - 1, y, 8, 8, R) || !inHexagon(x + 1, y, 8, 8, R) ||
          !inHexagon(x, y - 1, 8, 8, R) || !inHexagon(x, y + 1, 8, 8, R);
        set(px, x, y, hex, edge ? -40 : 0);
      }
    }
  };
}

/**
 * Tile name → painter for the 35 circuit tiles and the keg's two (barrel_side, barrel_top). tiles.js spreads this last
 * into its RECIPES.
 * @type {Readonly<Record<string, (px: Uint8ClampedArray, rng: Rng) => void>>}
 */
export const CIRCUIT_RECIPES = Object.freeze({
  ...Object.fromEntries(Object.values(CIRCUIT_TILE_NAMES).map((name) => [
    name,
    name === 'circuit_clear' ? paintCircuitClear : FLAT_PICTURES.includes(name) ? flatPlaceholder(name) : cabinetPlaceholder(name),
  ])),
  barrel_side: paintBarrelSide,
  barrel_top: paintBarrelTop,
});
