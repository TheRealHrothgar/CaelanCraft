// Caelancraft — procedural 16×16 painters of the powder-and-circuits tiles (docs/DESIGN-circuits.md §1.4, §3.5, §6.2.9) and of
// the Powder Keg's two tiles (75 barrel_side, 76 barrel_top). tiles.js spreads CIRCUIT_TILE_NAMES into its TILE_NAMES and
// CIRCUIT_RECIPES (last) into its RECIPES; `paintTile` then runs these painters exactly like its own.
//
// PURE: no DOM, no three, no imports, no Math.random. A painter is `(px, rng) => void` on a Uint8ClampedArray(16*16*4) in RGBA
// order with idx = (y*16 + x)*4, and `rng` is tiles.js's mulberry32 stream seeded with fnv1a(tileName), so every tile is
// deterministic. On a SIDE tile row 0 is the world-up edge; a TOP tile is seen from above with north (−Z) at row 0, and the
// mesher inscribes the hexagonal cap in it (its corners touch rows 0 and 15; columns 0 and 15 are not shown).
//
// The art (package C, §1.4): original designs of real 19th-century objects. Every cabinet's six sides are identical, so a
// side tile shows the cabinet's material and a top tile its working face from above; the moving and lit bits (blade, cap,
// dial hand, armature, plunger, trembler, bulb, glows) are circuitRenderer overlays. No circuit part shows gears, no signal
// wire is red, blue, green or yellow, and no tile uses a violet hue (250°–300°): very dark pixels are kept neutral or warm so
// that per-pixel noise can never tip them into violet. The six THIN parts' top tiles are flat pictures on an alpha-0
// background (alpha is only ever 0 or 255), drawn only as hotbar / picker icons; CIRCUIT_CLEAR (all alpha 0) is their sides
// and bottom.

const W = 16;
const H = 16;

/** @typedef {() => number} Rng  uniform in [0,1) */
/** @typedef {(px: Uint8ClampedArray, rng: Rng) => void} Painter */

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
export const CIRCUIT_FLAT_TILES = Object.freeze(['powder_fuse', 'torch', 'copper_wire', 'brown_wire', 'white_wire', 'earth_wire']);

// ---------------------------------------------------------------------------------------------------------------
// Palette (§1.4; the hex values the design names are used as written)
// ---------------------------------------------------------------------------------------------------------------

const C = Object.freeze({
  // collapsar
  tachylite: 0x1a1b18, sheen: 0x2c2e26, steel: 0x6f757c, steelLight: 0x8c9299, steelDark: 0x4f545a, pinprick: 0xf4f1ea,
  // metals and porcelain
  brass: 0xb08d3a, brassLight: 0xd8b860, brassDark: 0x7a5e22, copper: 0xc8743a, copperDark: 0x8a4a22, copperLight: 0xe09a5e,
  tin: 0xb8bcc0, iron: 0x3a3d42, ironLight: 0x5a5e64, nickel: 0xc8ccd2, nickelLight: 0xeef0f2, nickelDark: 0x9aa0a8,
  porcelain: 0xe8e4da, porcelainShade: 0xb8b2a6,
  // woods
  oak: 0x9a6a3a, oakGrain: 0x7a4e28, oakDark: 0x5e3a1c, walnut: 0x5a3a24, walnutGrain: 0x45291a, darkOak: 0x3e2616,
  darkOakGrain: 0x2c1a0e, lacquer: 0x4a2a18, lacquerGrain: 0x381e10, lacquerShine: 0x6e4228,
  // stone, ceramics, glass
  slate: 0x3f4448, slateDark: 0x33373a, slateLight: 0x4c5256, glaze: 0xd8cdb4, glazeCrack: 0xb4a688, glazeShine: 0xf0e8d4,
  enamel: 0xefe6cc, glass: 0xa8b8b6, glassDark: 0x56625f, leather: 0x4a2a18, leatherLight: 0x6a4228, ebonite: 0x1e1c1a,
  // fuses, wires and the torch
  tar: 0x2b2420, twine: 0xb8a77a, powder: 0x8a8478, powderLight: 0xa8a298, brown: 0x6b4226, brownBraid: 0x4a2c18,
  white: 0xe8e2d0, whiteBraid: 0xb8b2a6, earthGreen: 0x3f9f3f, earthYellow: 0xe0c43a, ash: 0xc9a46a, ashDark: 0x9a7a48,
  flame: 0xff7a2a, flameCore: 0xffd27a, pitch: 0x2b2420, pitchStrand: 0x4a3424,
  // keg
  kegCopper: 0xb0683a, kegCopperLight: 0xd08a52, brand: 0x3a2412, bung: 0x6a4424, bungLight: 0x8a5e34,
});

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

/** `set` for coordinates that may fall outside the tile (skipped). Coordinates are rounded. */
function put(px, x, y, hex, d = 0) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix >= 0 && ix < W && iy >= 0 && iy < H) set(px, ix, iy, hex, d);
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

/** Every pixel ← hex with noise `amp`. */
function fill(px, rng, hex, amp) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(px, x, y, hex, delta(rng, amp));
}

/** The inclusive rectangle x0..x1 × y0..y1 ← hex with noise `amp` (clipped to the tile). */
function rect(px, rng, x0, y0, x1, y1, hex, amp = 0) {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) set(px, x, y, hex, amp ? delta(rng, amp) : 0);
  }
}

/** @returns {number} the distance from (cx, cy) to the centre of pixel (x, y) */
function dist(x, y, cx, cy) {
  return Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
}

/** Pixels whose centre lies within r0 ≤ d < r1 of (cx, cy) ← hex with noise `amp`. */
function annulus(px, rng, cx, cy, r0, r1, hex, amp = 0) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(x, y, cx, cy);
      if (d >= r0 && d < r1) set(px, x, y, hex, amp ? delta(rng, amp) : 0);
    }
  }
}

/** Pixels whose centre lies within r of (cx, cy) ← hex. */
function disc(px, rng, cx, cy, r, hex, amp = 0) {
  annulus(px, rng, cx, cy, -1, r, hex, amp);
}

/**
 * @returns {number} hex a → b by t (0..1), per channel, rounded
 */
function mix(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Wood over the rectangle x0..x1 × y0..y1: `base` with noise 5 and wavy darker `grain` lines every 3–4 px running along y
 * (`vertical`) or along x.
 */
function wood(px, rng, x0, y0, x1, y1, base, grain, vertical) {
  const phase = rng() * 6.283;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const across = vertical ? x : y;
      const along = vertical ? y : x;
      // One thin grain line every 3 px across the grain, each wandering ±1 px along it on its own slow wave.
      let streak = false;
      for (let k = -1; k <= 6 && !streak; k++) {
        streak = k * 3 + 1 + Math.round(0.75 * Math.sin(along * 0.3 + phase + k * 1.9)) === across;
      }
      const band = Math.floor((across + 1) / 3) % 2 === 0 ? 3 : -3;
      set(px, x, y, streak ? grain : base, streak ? delta(rng, 3) : band + delta(rng, 4));
    }
  }
}

/** A round brass screw head at (x, y): two light pixels over a dark slot pixel to the lower right. */
function screw(px, x, y) {
  put(px, x, y, C.brassLight);
  put(px, x + 1, y, C.brass);
  put(px, x, y + 1, C.brass);
  put(px, x + 1, y + 1, C.brassDark);
}

/**
 * A 2-px-wide cord along the polyline `pts` ([x, y] pairs, sampled every 0.25 px): every sample's pixel in `hex` over a
 * shadow pixel below it in `under`; then, when `every` > 0, one `mark` pixel every `every` px along the cord (a twine wrap,
 * a braid, a stripe), starting `phase` px in.
 */
function cord(px, pts, hex, under, mark = 0, every = 0, phase = 0) {
  /** @type {number[][]} */
  const samples = [];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len * 4));
    for (let k = 0; k <= n; k++) samples.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, s + (len * k) / n]);
    s += len;
  }
  for (const [x, y] of samples) put(px, Math.floor(x + 0.5), Math.floor(y + 0.5) + 1, under);
  for (const [x, y] of samples) put(px, Math.floor(x), Math.floor(y), hex);
  if (!(every > 0)) return;
  let next = phase;
  for (const [x, y, at] of samples) {
    if (at < next) continue;
    put(px, Math.floor(x), Math.floor(y), mark);
    next += every;
  }
}

/** A loose spiral coil (for the flat wire and fuse pictures): `turns` turns from radius r0 to r1 around (cx, cy). */
function spiral(cx, cy, r0, r1, turns, start = 0) {
  const pts = [];
  const n = Math.round(turns * 40);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = start + u * turns * 2 * Math.PI;
    const r = r0 + (r1 - r0) * u;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.82]);
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------------------------
// The Powder Keg (§3.5): the v0.8 staves, now with copper hoops and a burnt-in brand; the lid with an unlit bung
// ---------------------------------------------------------------------------------------------------------------

/**
 * 75 barrel_side — the Powder Keg's staves: four vertical staves (3–4 px wide, three warm browns, noise 6) split by dark
 * 0x3e2612 seams, two copper hoops on rows 1–3 and 12–14 (0xb0683a with a 0xd08a52 highlight row and light copper rivets at
 * x 2 and 13) — powder kegs were hooped with copper or wood, never iron, so a knock could not strike a spark — and between
 * them a burnt-in maker's brand: a 0x3a2412 pointy-top hexagon outline (circumradius 4.2 around (8, 7.5)) holding three dots.
 * Alpha 255.
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
      for (let x = 0; x < W; x++) set(px, x, y, y === y0 ? C.kegCopperLight : y === y1 ? 0x8a4c26 : C.kegCopper, delta(rng, 4));
    }
    set(px, 2, y0 + 1, 0xe8b07a);
    set(px, 13, y0 + 1, 0xe8b07a);
  }
  // The brand: burnt into the wood, so only the outline and the dots darken it (a charred edge, slightly uneven).
  const CX = 8;
  const CY = 7.5;
  for (let y = 4; y <= 11; y++) {
    for (let x = 3; x <= 12; x++) {
      if (!inHexagon(x, y, CX, CY, 4.2)) continue;
      const edge = !inHexagon(x - 1, y, CX, CY, 4.2) || !inHexagon(x + 1, y, CX, CY, 4.2) ||
        !inHexagon(x, y - 1, CX, CY, 4.2) || !inHexagon(x, y + 1, CX, CY, 4.2);
      if (edge) set(px, x, y, C.brand, delta(rng, 5));
      else if (x !== 3 && x !== 7 && x !== 11) {
        // The hot iron scorched the wood inside the outline a little.
        const i = idx(x, y);
        set(px, x, y, (px[i] << 16) | (px[i + 1] << 8) | px[i + 2], -14);
      }
    }
  }
  for (const [x, y] of [[8, 5], [6, 9], [10, 9]]) {
    set(px, x, y, C.brand);
    set(px, x - 1, y, 0x4e321a);
  }
}

/**
 * 76 barrel_top — the lid: horizontal planks (rows of 3, 0x9a6a3a / 0x8a5c30, noise 5, 0x4a3018 seams), a copper rim
 * (0xb0683a, its inner ring 0xd08a52) on every pixel whose centre lies 6.2–7.9 from (8, 8) with darker copper beyond, and
 * an unlit wooden bung in the middle (a 0x6a4424 plug with a 0x8a5e34 highlight and a dark ring) with a short dark cord
 * stub. No ember: a keg burning in place is shown by circuitRenderer's fuse glow at the bung. Alpha 255.
 */
function paintBarrelTop(px, rng) {
  for (let y = 0; y < H; y++) {
    const band = Math.floor(y / 3);
    const seam = y % 3 === 2;
    for (let x = 0; x < W; x++) set(px, x, y, seam ? 0x4a3018 : band % 2 === 0 ? 0x9a6a3a : 0x8a5c30, delta(rng, 5));
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(x, y, 8, 8);
      if (d >= 6.2 && d < 6.9) set(px, x, y, C.kegCopperLight, delta(rng, 4));
      else if (d >= 6.9 && d < 7.9) set(px, x, y, C.kegCopper, delta(rng, 4));
      else if (d >= 7.9) set(px, x, y, 0x7a4426, delta(rng, 3));
    }
  }
  annulus(px, rng, 8, 8, 1.6, 2.4, 0x3a2412);
  disc(px, rng, 8, 8, 1.6, C.bung);
  set(px, 7, 7, C.bungLight);
  set(px, 8, 7, C.bungLight);
  // The cord stub: two dark pixels leaving the bung toward the north-east, frayed tip in grey.
  set(px, 9, 6, 0x2a2420);
  set(px, 10, 5, 0x2a2420);
  set(px, 11, 5, 0x6a6458);
}

// ---------------------------------------------------------------------------------------------------------------
// The Collapsar Charge
// ---------------------------------------------------------------------------------------------------------------

/**
 * 161 collapsar_side — a block of tachylite (basalt glass, 0x1a1b18) with faint diagonal 0x2c2e26 sheen streaks, girdled by
 * a dull steel band (0x6f757c, rows 6–9, lit on its top row and shaded below) fixed with brass rivets (0xb08d3a).
 */
function paintCollapsarSide(px, rng) {
  fill(px, rng, C.tachylite, 3);
  for (let k = 0; k < 3; k++) {
    const x0 = Math.floor(rng() * 16);
    for (let i = 0; i < 9; i++) {
      const x = (x0 + i) % 16;
      const y = (i + Math.floor(rng() * 2) + (k * 5)) % 16;
      set(px, x, y, C.sheen, delta(rng, 3));
    }
  }
  for (let x = 0; x < W; x++) {
    set(px, x, 5, 0x101110);
    set(px, x, 6, C.steelLight, delta(rng, 4));
    set(px, x, 7, C.steel, delta(rng, 4));
    set(px, x, 8, C.steel, delta(rng, 4));
    set(px, x, 9, C.steelDark, delta(rng, 3));
  }
  for (const x of [2, 7, 12]) {
    set(px, x, 7, 0xd8b860);
    set(px, x + 1, 7, C.brass);
    set(px, x, 8, C.brass);
    set(px, x + 1, 8, C.brassDark);
  }
}

/**
 * 162 collapsar_top — the tachylite top holding a black lens in a steel bezel (radius 4.6–5.8 around (8, 8)), a faint grey
 * reflection along its upper-left edge, and one white pinprick (0xf4f1ea) at the very centre.
 */
function paintCollapsarTop(px, rng) {
  fill(px, rng, C.tachylite, 3);
  annulus(px, rng, 8, 8, 5.0, 6.0, C.steel, 4);
  annulus(px, rng, 8, 8, 5.7, 6.0, C.steelDark, 2);
  annulus(px, rng, 8, 8, 4.4, 5.0, C.steelDark, 2);
  disc(px, rng, 8, 8, 4.4, 0x0b0b0b, 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(x, y, 8, 8);
      const a = Math.atan2(y + 0.5 - 8, x + 0.5 - 8);
      if (d > 3.0 && d < 4.2 && a > -2.6 && a < -1.4) set(px, x, y, 0x34363a);
    }
  }
  set(px, 7, 7, 0xffffff);
  set(px, 8, 8, C.pinprick);
  set(px, 8, 7, 0x8e8c86);
  set(px, 7, 8, 0x8e8c86);
}

// ---------------------------------------------------------------------------------------------------------------
// The thin parts' flat pictures (alpha-0 background, alpha only 0 or 255)
// ---------------------------------------------------------------------------------------------------------------

/**
 * 163 powder_fuse — a coil of tarred safety fuse (0x2b2420) with a pale twine wrap (0xb8a77a every third pixel along the
 * cord), whose tail runs out to the lower right and ends in a frayed, powder-grey tuft.
 */
function paintPowderFuse(px) {
  px.fill(0);
  const coil = spiral(7.2, 7.0, 2.4, 5.5, 1.3, Math.PI * 0.25);
  cord(px, [...coil, [10.5, 11.6], [12.2, 12.4]], C.tar, 0x1a1512, C.twine, 3, 1);
  for (const [x, y, hex] of [[13, 12, C.powder], [13, 13, C.powderLight], [14, 12, C.powderLight], [12, 14, C.powder],
    [14, 14, C.powder], [13, 11, C.powderLight]]) put(px, x, y, hex);
}

/**
 * 164 torch — a pitch torch leaning to the right: an ash staff (0xc9a46a, shaded edge) on an iron spike foot (0x3a3d42), an
 * iron collar holding a head of dark resin-soaked fibre bound with pale twine, and its small flame (0xff7a2a around a
 * 0xffd27a core).
 */
function paintTorch(px) {
  px.fill(0);
  // Staff from (3.5, 13.5) to (9.5, 6): two pixels wide, the right edge darker.
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const x = 3.6 + 5.8 * u;
    const y = 13.2 - 7.0 * u;
    put(px, Math.floor(x), Math.floor(y), C.ash);
    put(px, Math.floor(x) + 1, Math.floor(y), C.ashDark);
  }
  // Iron spike foot.
  put(px, 3, 14, C.iron);
  put(px, 2, 15, C.iron);
  put(px, 4, 14, C.ironLight);
  // Iron collar.
  put(px, 9, 6, C.ironLight);
  put(px, 10, 6, C.iron);
  put(px, 10, 7, C.iron);
  // The pitch head: a dark bundle with lighter strands and two twine bands.
  for (const [x, y] of [[10, 3], [11, 3], [10, 4], [11, 4], [12, 4], [10, 5], [11, 5], [12, 5], [11, 6], [12, 3]]) {
    put(px, x, y, (x + y) % 3 === 0 ? C.pitchStrand : C.pitch);
  }
  put(px, 10, 5, C.twine);
  put(px, 11, 5, C.twine);
  put(px, 12, 5, 0x8a7a54);
  // The flame: an outer tongue and a bright core, leaning with the staff.
  for (const [x, y] of [[10, 2], [11, 2], [12, 2], [11, 1], [12, 1], [12, 0], [13, 2], [13, 1]]) put(px, x, y, C.flame);
  put(px, 11, 2, C.flameCore);
  put(px, 12, 2, C.flameCore);
  put(px, 12, 1, 0xffe9b0);
}

/**
 * The braided wire pictures: a loose coil of 2-px cord in `hex` over its `under` shadow, with a `mark` pixel every `every`
 * px (the braid, or the earth wire's stripes), whose tail runs out to the lower right and ends in a cut end showing the
 * copper core.
 */
function wireCoil(px, hex, under, mark, every) {
  const coil = spiral(7.4, 7.0, 3.0, 5.3, 1.3, Math.PI * 0.6);
  cord(px, [...coil, [11.4, 12.2], [12.6, 13.0]], hex, under, mark, every, 1);
  put(px, 13, 13, C.copperLight);
  put(px, 14, 13, C.copper);
}

/**
 * 165 copper_wire — bare copper line wire (0xc8743a, shaded 0x8a4a22) wound round a white porcelain knob (0xe8e4da, its
 * groove 0xb8b2a6), with a loose end and a bright cut tip.
 */
function paintCopperWire(px) {
  px.fill(0);
  // The knob: a spool seen from the side, groove across its waist.
  for (let y = 4; y <= 10; y++) {
    for (let x = 5; x <= 9; x++) {
      const edge = x === 5 || x === 9;
      const groove = y === 7;
      if ((y === 4 || y === 10) && edge) continue;
      put(px, x, y, groove ? C.porcelainShade : edge ? 0xcfcac0 : C.porcelain);
    }
  }
  put(px, 6, 5, 0xffffff);
  // Copper turns wound in the groove and round the knob, then the loose end.
  const turns = spiral(7.4, 7.2, 3.6, 5.6, 1.6, Math.PI * 0.85);
  cord(px, [...turns, [11.6, 12.0], [12.8, 12.8]], C.copper, C.copperDark, C.copperLight, 4, 2);
  put(px, 13, 13, 0xf0b882);
  for (let x = 5; x <= 9; x++) put(px, x, 7, x % 2 === 0 ? C.copper : C.copperDark);
}

/** 166 brown_wire — cotton-braided wire (0x6b4226) with a 0x4a2c18 diagonal braid, coiled loose with a cut end. */
function paintBrownWire(px) {
  px.fill(0);
  wireCoil(px, C.brown, 0x3a2010, C.brownBraid, 2);
}

/** 167 white_wire — cotton-braided wire (0xe8e2d0) with a 0xb8b2a6 diagonal braid, coiled loose with a cut end. */
function paintWhiteWire(px) {
  px.fill(0);
  wireCoil(px, C.white, 0x9a948a, C.whiteBraid, 2);
}

/** 168 earth_wire — the green-and-yellow earth conductor (0x3f9f3f with 0xe0c43a spiral stripes), coiled loose. */
function paintEarthWire(px) {
  px.fill(0);
  wireCoil(px, C.earthGreen, 0x2c702c, C.earthYellow, 2.5);
}

// ---------------------------------------------------------------------------------------------------------------
// Cabinets (alpha 255)
// ---------------------------------------------------------------------------------------------------------------

/** 169 terminal_side — varnished oak (horizontal grain, a lit top edge) with two brass screw terminals. */
function paintTerminalSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.oak, C.oakGrain, false);
  rect(px, rng, 0, 0, 15, 0, 0xb8844e, 4);
  rect(px, rng, 0, 15, 15, 15, C.oakDark, 3);
  for (const x of [3, 11]) {
    disc(px, rng, x + 1, 8, 1.9, C.brassDark);
    disc(px, rng, x + 1, 8, 1.4, C.brass);
    set(px, x, 7, C.brassLight);
    set(px, x, 8, 0x3a2a10);
    set(px, x + 1, 8, 0x3a2a10);
  }
}

/** 170 terminal_top — an oak board carrying six brass binding posts in a hex ring, all on one brass bus ring. */
function paintTerminalTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.oak, C.oakGrain, true);
  annulus(px, rng, 8, 8, 4.0, 4.9, C.brassDark);
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    const cx = 8 + 4.5 * Math.cos(a);
    const cy = 8 + 4.5 * Math.sin(a);
    disc(px, rng, cx, cy, 1.7, 0x5a4418);
    disc(px, rng, cx, cy, 1.2, C.brass);
    put(px, cx - 0.9, cy - 0.9, C.brassLight);
  }
  disc(px, rng, 8, 8, 1.3, 0x5a4418);
  put(px, 7, 7, C.brass);
}

/** 171 battery_side — a slatted crate (oak slats, corner posts) through whose gaps show glass jars with copper and tin plates. */
function paintBatterySide(px, rng) {
  // Behind the slats: dark glass jars with alternating copper and tin plates and a brine line.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Columns of five: glass, copper plate, glass, tin plate, shadow; a brighter glass line every sixth row.
      const k = x % 5;
      const glass = y % 6 === 3 ? C.glass : C.glassDark;
      const hex = k === 1 ? C.copper : k === 3 ? C.tin : k === 4 ? 0x2e3634 : glass;
      set(px, x, y, hex, delta(rng, 4));
    }
  }
  for (const [y0, y1] of [[0, 2], [6, 8], [13, 15]]) {
    wood(px, rng, 0, y0, 15, y1, 0x8a6038, 0x6a4626, false);
    rect(px, rng, 0, y0, 15, y0, 0xa87a4a, 3);
    rect(px, rng, 0, y1, 15, y1, 0x5a3c20, 3);
  }
  for (const x of [0, 15]) rect(px, rng, x, 0, x, 15, 0x6a4626, 3);
}

/**
 * 172 battery_top — the crate seen from above: four glass jar mouths (a pale rim round dark brine), each showing the top
 * edges of its copper and tin plates, the jars linked in series by copper straps.
 */
function paintBatteryTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, 0x8a6038, 0x6a4626, false);
  const JARS = [[5, 5], [11, 5], [5, 11], [11, 11]];
  for (const [cx, cy] of JARS) {
    disc(px, rng, cx, cy, 3.0, 0x4a3420);
    disc(px, rng, cx, cy, 2.6, 0xc0ccca, 3);
    disc(px, rng, cx, cy, 2.0, 0x24302e, 2);
    for (let y = cy - 2; y <= cy + 1; y++) {
      set(px, cx - 2, y, C.copper);
      set(px, cx, y, C.tin);
    }
    set(px, cx - 2, cy - 2, C.copperLight);
    set(px, cx, cy - 2, 0xe0e4e8);
  }
  // Series straps: each jar's tin plate to the next jar's copper plate.
  line(px, 6, 2, 9, 2, C.copper);
  line(px, 13, 6, 13, 9, C.copper);
  line(px, 9, 14, 6, 14, C.copper);
}

/**
 * 173 blaster_side — a varnished oak box (vertical grain) with a blank brass plate (darker border, corner screws) and a
 * leather carrying strap (stitched) down its right; no red and no lettering.
 */
function paintBlasterSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, 0x7a4c26, 0x5e3a1c, true);
  rect(px, rng, 0, 0, 15, 0, 0x9a6a3a, 3);
  rect(px, rng, 2, 5, 10, 11, C.brassDark);
  rect(px, rng, 3, 6, 9, 10, C.brass, 5);
  rect(px, rng, 3, 6, 9, 6, C.brassLight, 4);
  for (const [x, y] of [[3, 6], [9, 6], [3, 10], [9, 10]]) set(px, x, y, 0x5a4418);
  rect(px, rng, 12, 0, 14, 15, C.leather, 4);
  rect(px, rng, 12, 0, 12, 15, C.leatherLight, 3);
  for (let y = 1; y < H; y += 3) set(px, 14, y, 0x9a7a58);
  rect(px, rng, 11, 6, 15, 8, 0x8a8478);
  rect(px, rng, 12, 7, 14, 7, 0x4a2a18);
}

/** 174 blaster_top — oak with a brass plunger bushing (ring and dark bore) and four brass corner plates. */
function paintBlasterTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, 0x7a4c26, 0x5e3a1c, false);
  annulus(px, rng, 8, 8, 2.0, 3.6, C.brass, 4);
  annulus(px, rng, 8, 8, 3.2, 3.6, C.brassDark);
  annulus(px, rng, 8, 8, 2.0, 2.5, C.brassLight);
  disc(px, rng, 8, 8, 2.0, 0x16120e);
  for (const [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11]]) {
    rect(px, rng, x, y, x + 1, y + 1, C.brass);
    set(px, x, y, C.brassLight);
  }
}

/** 175 selenium_side — a lacquered dark wood case (glossy highlight streak) with a brass ring on its face. */
function paintSeleniumSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.lacquer, C.lacquerGrain, false);
  for (let x = 0; x < W; x++) set(px, x, 2, C.lacquerShine, delta(rng, 4));
  annulus(px, rng, 8, 8.5, 2.6, 3.7, C.brass, 4);
  annulus(px, rng, 8, 8.5, 2.6, 3.0, C.brassDark);
  set(px, 6, 5, C.brassLight);
  set(px, 7, 5, C.brassLight);
}

/**
 * 176 selenium_top — six round grey-black selenium discs (0x3a3436 under a 25 % gold-leaf sheen of 0xc9a85a) in a hex
 * rosette on a pale insulating board within the lacquered case, each inside a brass collector ring, joined in series by
 * brass strips, with two terminal screws in the middle. No grid.
 */
function paintSeleniumTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.lacquer, C.lacquerGrain, true);
  disc(px, rng, 8, 8, 7.4, C.brassDark);
  disc(px, rng, 8, 8, 6.9, 0xd8cdb4, 3);
  // The rosette: each disc a 3×3 cell (its corners trimmed) inside a 1-px brass collector ring.
  const CENTRES = [[7, 3], [11, 5], [11, 10], [7, 12], [3, 10], [3, 5]];
  // Brass strips joining neighbours in series (five links; the ring stays open between the first and the last disc).
  for (let k = 0; k < 5; k++) {
    const [ax, ay] = CENTRES[k];
    const [bx, by] = CENTRES[k + 1];
    line(px, ax, ay, bx, by, C.brassDark);
  }
  const disk = mix(0x3a3436, 0xc9a85a, 0.25);
  for (const [cx, cy] of CENTRES) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const r = Math.abs(dx) + Math.abs(dy);
        if (r === 4) continue; // round off the corners
        const ring = Math.abs(dx) === 2 || Math.abs(dy) === 2 || r === 3;
        put(px, cx + dx, cy + dy, ring ? C.brass : disk, ring ? 0 : delta(rng, 3));
      }
    }
    put(px, cx - 1, cy - 1, mix(disk, 0xc9a85a, 0.55)); // the gold leaf catching the light
    put(px, cx, cy, mix(disk, 0x000000, 0.25));
  }
  screw(px, 5, 7);
  screw(px, 9, 7);
}

/** 177 switch_side — a slate base: blue-grey layered slate with a lit chamfer on top and a dark foot. */
function paintSwitchSide(px, rng) {
  fill(px, rng, C.slate, 3);
  for (let y = 0; y < H; y++) {
    const d = delta(rng, 5);
    for (let x = 0; x < W; x++) set(px, x, y, C.slate, d + delta(rng, 2));
  }
  for (let k = 0; k < 4; k++) {
    const y = 2 + Math.floor(rng() * 12);
    const x0 = Math.floor(rng() * 10);
    for (let i = 0; i < 7; i++) set(px, (x0 + i) % 16, y, C.slateDark);
  }
  rect(px, rng, 0, 0, 15, 0, 0x5a6066, 3);
  rect(px, rng, 0, 15, 15, 15, 0x2a2e30, 2);
}

/**
 * 178 switch_top — slate carrying the knife switch's fixed parts: a brass hinge post on the west (two cheeks and a pin) and
 * two brass jaws on the east that the blade (an overlay) drops between, each with a terminal screw.
 */
function paintSwitchTop(px, rng) {
  fill(px, rng, C.slate, 4);
  rect(px, rng, 2, 6, 14, 10, C.slateDark, 2);
  // Hinge post: cheeks at rows 6 and 9, pin at (3..4, 7..8).
  rect(px, rng, 2, 6, 4, 6, C.brass);
  rect(px, rng, 2, 9, 4, 9, C.brassDark);
  set(px, 3, 7, 0x2a2a2a);
  set(px, 3, 8, 0x2a2a2a);
  set(px, 2, 6, C.brassLight);
  // Jaws.
  rect(px, rng, 11, 6, 13, 6, C.brass);
  rect(px, rng, 11, 9, 13, 9, C.brassDark);
  set(px, 11, 6, C.brassLight);
  // The blade's slot between the jaws.
  rect(px, rng, 11, 7, 13, 8, 0x22262a);
  screw(px, 3, 11);
  screw(px, 11, 11);
  screw(px, 3, 3);
  screw(px, 11, 3);
}

/** 179 button_side — a polished brass housing (vertical highlights) standing on a slate plinth. */
function paintButtonSide(px, rng) {
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < W; x++) {
      const k = x % 6;
      const hex = k === 1 ? C.brassLight : k === 4 ? C.brassDark : C.brass;
      set(px, x, y, hex, delta(rng, 4));
    }
  }
  rect(px, rng, 0, 0, 15, 0, 0xe8cc80, 3);
  rect(px, rng, 0, 9, 15, 9, 0x5a4418, 2);
  rect(px, rng, 0, 10, 15, 15, C.slate, 4);
  rect(px, rng, 0, 10, 15, 10, C.slateLight, 3);
}

/** 180 button_top — a brass plate with a raised polished ring round the dark recess the cap (an overlay) sits in. */
function paintButtonTop(px, rng) {
  fill(px, rng, 0xa8863a, 4);
  annulus(px, rng, 8, 8, 3.4, 4.6, C.brassLight, 3);
  annulus(px, rng, 8, 8, 4.1, 4.6, C.brassDark);
  disc(px, rng, 8, 8, 3.4, 0x2a2622, 2);
  screw(px, 2, 7);
  screw(px, 13, 7);
}

/**
 * 181 timer_side — a walnut case (0x5a3a24) with a brass winding arbor (a square-ended spindle in a round boss) and a brass
 * keyhole escutcheon, like a 19th-century time switch.
 */
function paintTimerSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.walnut, C.walnutGrain, false);
  rect(px, rng, 0, 0, 15, 0, 0x7a5236, 3);
  rect(px, rng, 0, 15, 15, 15, 0x3a2416, 2);
  // Winding arbor.
  disc(px, rng, 5, 8, 2.4, C.brassDark);
  disc(px, rng, 5, 8, 1.8, C.brass);
  rect(px, rng, 4, 7, 5, 8, 0x5a4418);
  set(px, 4, 6, C.brassLight);
  // Keyhole escutcheon.
  disc(px, rng, 11.5, 8, 2.0, C.brass);
  set(px, 10, 6, C.brassLight);
  set(px, 11, 7, 0x120c08);
  set(px, 11, 8, 0x120c08);
  set(px, 11, 9, 0x120c08);
  set(px, 10, 7, 0x120c08);
}

/**
 * 182 timer_top — a cream enamel dial (0xefe6cc) in a brass bezel on the walnut case, with 12 hex ticks (the quarter ticks
 * longer) and a brass centre boss; the hand is an overlay.
 */
function paintTimerTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.walnut, C.walnutGrain, true);
  annulus(px, rng, 8, 8, 6.0, 7.0, C.brass, 4);
  annulus(px, rng, 8, 8, 6.6, 7.0, C.brassDark);
  disc(px, rng, 8, 8, 6.0, C.enamel, 3);
  for (let k = 0; k < 12; k++) {
    const a = (k * 30 * Math.PI) / 180 - Math.PI / 2;
    const r = k % 3 === 0 ? 4.4 : 4.9;
    for (let s = r; s <= 5.4; s += 0.5) put(px, 8 + s * Math.cos(a) - 0.5, 8 + s * Math.sin(a) - 0.5, 0x3a3028);
  }
  disc(px, rng, 8, 8, 1.1, C.brass);
  set(px, 7, 7, C.brassLight);
}

/** 183 relay_side — an oak base below two copper coils (alternating winding rows) between dark iron end plates. */
function paintRelaySide(px, rng) {
  rect(px, rng, 0, 0, 15, 9, 0x2a2420, 3);
  for (const x0 of [2, 9]) {
    rect(px, rng, x0, 1, x0 + 4, 1, C.ironLight);
    rect(px, rng, x0, 9, x0 + 4, 9, C.iron);
    for (let y = 2; y <= 8; y++) {
      for (let x = x0; x <= x0 + 4; x++) {
        const lit = x === x0 + 1;
        set(px, x, y, y % 2 === 0 ? (lit ? C.copperLight : C.copper) : C.copperDark, delta(rng, 3));
      }
    }
  }
  wood(px, rng, 0, 10, 15, 15, C.oak, C.oakGrain, false);
  rect(px, rng, 0, 10, 15, 10, 0xb8844e, 3);
}

/**
 * 184 relay_top — oak with the relay's fixed parts from above: two coil ends (iron cores in copper rings) on the west and
 * the nickel contact springs with their silver points on the east; the armature is an overlay.
 */
function paintRelayTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.oak, C.oakGrain, true);
  for (const cy of [5, 11]) {
    disc(px, rng, 5, cy, 2.6, C.copperDark);
    disc(px, rng, 5, cy, 2.1, C.copper, 4);
    disc(px, rng, 5, cy, 1.1, C.iron);
  }
  // Contact springs: two long nickel strips with silver points, and their brass anchor block.
  rect(px, rng, 12, 3, 13, 13, C.brassDark);
  rect(px, rng, 12, 3, 12, 13, C.brass);
  line(px, 11, 6, 8, 6, C.nickel);
  line(px, 11, 10, 8, 10, C.nickelDark);
  set(px, 8, 7, C.nickelLight);
  set(px, 8, 9, C.nickelLight);
}

/**
 * 185 igniter_side — glazed ceramic (cream glaze with fine crazing and a glossy highlight) with a framed mica window
 * through which the coiled bridgewire shows.
 */
function paintIgniterSide(px, rng) {
  fill(px, rng, C.glaze, 4);
  for (let k = 0; k < 5; k++) {
    let x = Math.floor(rng() * 16);
    let y = Math.floor(rng() * 16);
    for (let i = 0; i < 5; i++) {
      set(px, x, y, C.glazeCrack);
      x = (x + (rng() < 0.5 ? 1 : 0)) % 16;
      y = (y + 1) % 16;
    }
  }
  rect(px, rng, 0, 1, 15, 1, C.glazeShine, 2);
  rect(px, rng, 4, 5, 11, 11, 0x4a4038);
  rect(px, rng, 5, 6, 10, 10, 0x8a7a5a, 5);
  for (let x = 5; x <= 10; x++) set(px, x, (x % 2 === 0) ? 8 : 9, C.copper);
  set(px, 5, 6, 0xc8b890);
  set(px, 6, 6, 0xc8b890);
}

/** 186 igniter_top — a glazed ceramic plate with a coiled bridgewire stretched between two brass terminal posts. */
function paintIgniterTop(px, rng) {
  fill(px, rng, C.glaze, 4);
  annulus(px, rng, 8, 8, 5.6, 6.4, C.glazeCrack, 3);
  disc(px, rng, 4, 8, 1.6, C.brass);
  disc(px, rng, 12, 8, 1.6, C.brass);
  set(px, 3, 7, C.brassLight);
  set(px, 11, 7, C.brassLight);
  // The coil: a zigzag of fine dark wire between the posts.
  for (let x = 5; x <= 10; x++) {
    set(px, x, x % 2 === 0 ? 7 : 9, 0x4a4a4e);
    set(px, x, 8, x % 2 === 0 ? 0x6a6a70 : 0x4a4a4e);
  }
}

/** 187 lamp_side — plain oak, vertical planks with dark seams and a lit top edge. */
function paintLampSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, 0xa8763f, C.oakGrain, true);
  for (const x of [5, 10]) rect(px, rng, x, 0, x, 15, C.oakDark, 3);
  rect(px, rng, 0, 0, 15, 0, 0xc8945a, 3);
}

/** 188 lamp_top — a porcelain top (0xe8e4da) on an oak rim with a brass screw socket (thread rings, dark contact). */
function paintLampTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, 0xa8763f, C.oakGrain, false);
  disc(px, rng, 8, 8, 6.2, C.porcelainShade);
  disc(px, rng, 8, 8, 5.6, C.porcelain, 3);
  annulus(px, rng, 8, 8, 1.5, 2.9, C.brass, 3);
  annulus(px, rng, 8, 8, 2.1, 2.5, C.brassDark);
  disc(px, rng, 8, 8, 1.5, 0x2a2622);
  set(px, 7, 7, C.brass);
  set(px, 5, 4, 0xffffff);
}

/** 189 bell_side — a dark-oak backboard (vertical grain) with brass corner screws. */
function paintBellSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.darkOak, C.darkOakGrain, true);
  rect(px, rng, 0, 0, 15, 0, 0x5a3a22, 3);
  screw(px, 2, 2);
  screw(px, 12, 2);
  screw(px, 2, 12);
  screw(px, 12, 12);
}

/**
 * 190 bell_top — a bright nickel-plated steel gong (0xc8ccd2 with a 0xeef0f2 highlight, a darker rim and a centre nut)
 * set toward the north-east of the dark-oak board, leaving room for the trembler (an overlay) on the south-west.
 */
function paintBellTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.darkOak, C.darkOakGrain, true);
  const cx = 9.2;
  const cy = 7.0;
  disc(px, rng, cx, cy, 4.9, C.nickelDark);
  disc(px, rng, cx, cy, 4.3, C.nickel, 3);
  annulus(px, rng, cx, cy, 2.2, 2.7, 0xb2b8be);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(x, y, cx, cy);
      const a = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
      if (d > 2.7 && d < 4.0 && a > -2.7 && a < -1.5) set(px, x, y, C.nickelLight);
    }
  }
  disc(px, rng, cx, cy, 0.9, C.steel);
}

/** 191 tx_side — an oak box with a window onto the induction coil: fine copper windings between black ebonite cheeks. */
function paintTxSide(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.oak, C.oakGrain, false);
  rect(px, rng, 1, 4, 14, 11, 0x2a1c10);
  rect(px, rng, 2, 5, 2, 10, C.ebonite);
  rect(px, rng, 13, 5, 13, 10, C.ebonite);
  for (let y = 5; y <= 10; y++) {
    for (let x = 3; x <= 12; x++) {
      const lit = y === 6;
      set(px, x, y, lit ? C.copperLight : (x + y) % 2 === 0 ? C.copper : C.copperDark, delta(rng, 3));
    }
  }
  rect(px, rng, 0, 0, 15, 0, 0xb8844e, 3);
}

/** 192 tx_top — oak with the two brass spark balls across their gap (north) and a Morse key with an ebonite knob (south). */
function paintTxTop(px, rng) {
  wood(px, rng, 0, 0, 15, 15, C.oak, C.oakGrain, true);
  for (const cx of [5, 11]) {
    disc(px, rng, cx, 5, 1.8, C.brassDark);
    disc(px, rng, cx, 5, 1.3, C.brassLight);
  }
  line(px, 2, 5, 3, 5, C.brass);
  line(px, 13, 5, 14, 5, C.brass);
  // The key: a brass lever from its pivot block to an ebonite knob.
  rect(px, rng, 3, 10, 4, 12, C.brassDark);
  line(px, 4, 11, 11, 11, C.brass);
  line(px, 5, 10, 10, 10, C.brassLight);
  rect(px, rng, 11, 10, 13, 12, C.ebonite);
  set(px, 11, 10, 0x4a4642);
  set(px, 8, 13, C.nickel);
}

/** 193 rx_side — a dark ebonite-finished box with panel lines, two brass screws and a small brass name-blank. */
function paintRxSide(px, rng) {
  fill(px, rng, 0x2c2622, 3);
  rect(px, rng, 1, 1, 14, 1, 0x403830, 2);
  rect(px, rng, 1, 14, 14, 14, 0x1c1814, 2);
  rect(px, rng, 1, 1, 1, 14, 0x403830, 2);
  rect(px, rng, 14, 1, 14, 14, 0x1c1814, 2);
  rect(px, rng, 5, 9, 10, 10, C.brassDark);
  rect(px, rng, 5, 9, 10, 9, C.brass);
  screw(px, 3, 4);
  screw(px, 11, 4);
}

/**
 * 194 rx_top — the coherer: a glass tube lying east–west with grey iron filings in its middle and brass end caps, held in
 * two brass clips on the dark box.
 */
function paintRxTop(px, rng) {
  fill(px, rng, 0x2c2622, 3);
  rect(px, rng, 4, 6, 11, 9, C.glassDark);
  rect(px, rng, 4, 6, 11, 6, C.glass);
  rect(px, rng, 4, 9, 11, 9, 0x7a8886);
  for (let x = 7; x <= 9; x++) {
    for (let y = 7; y <= 8; y++) set(px, x, y, (x + y) % 2 === 0 ? 0x8a8a86 : 0x5e5e5a, delta(rng, 6));
  }
  rect(px, rng, 2, 6, 3, 9, C.brass);
  rect(px, rng, 12, 6, 13, 9, C.brass);
  set(px, 2, 6, C.brassLight);
  set(px, 12, 6, C.brassLight);
  rect(px, rng, 5, 10, 5, 11, C.brassDark);
  rect(px, rng, 10, 10, 10, 11, C.brassDark);
  line(px, 1, 8, 1, 8, C.copper);
  line(px, 14, 8, 14, 8, C.copper);
}

/** 160 circuit_clear — every pixel RGBA 0: the sides and bottom of the thin parts, which circuitRenderer draws. */
// CONTRACT-ISSUE: §6.2.9 exempts the circuit tiles only from tiles.test.js's "alpha 255 everywhere" rule, but circuit_clear
// is then byte-identical to survival's plant_top_clear (both RGBA 0), which "every tile differs from every other tile"
// forbids. K0 keeps it RGBA 0 (the atlas canvas drops the RGB of alpha-0 pixels anyway) and lets that test skip pairs of
// wholly transparent tiles.
function paintCircuitClear(px) {
  px.fill(0);
}

/**
 * Tile name → painter for the 35 circuit tiles and the keg's two (barrel_side, barrel_top). tiles.js spreads this last
 * into its RECIPES.
 * @type {Readonly<Record<string, Painter>>}
 */
export const CIRCUIT_RECIPES = Object.freeze({
  circuit_clear: paintCircuitClear,
  collapsar_side: paintCollapsarSide,
  collapsar_top: paintCollapsarTop,
  powder_fuse: paintPowderFuse,
  torch: paintTorch,
  copper_wire: paintCopperWire,
  brown_wire: paintBrownWire,
  white_wire: paintWhiteWire,
  earth_wire: paintEarthWire,
  terminal_side: paintTerminalSide,
  terminal_top: paintTerminalTop,
  battery_side: paintBatterySide,
  battery_top: paintBatteryTop,
  blaster_side: paintBlasterSide,
  blaster_top: paintBlasterTop,
  selenium_side: paintSeleniumSide,
  selenium_top: paintSeleniumTop,
  switch_side: paintSwitchSide,
  switch_top: paintSwitchTop,
  button_side: paintButtonSide,
  button_top: paintButtonTop,
  timer_side: paintTimerSide,
  timer_top: paintTimerTop,
  relay_side: paintRelaySide,
  relay_top: paintRelayTop,
  igniter_side: paintIgniterSide,
  igniter_top: paintIgniterTop,
  lamp_side: paintLampSide,
  lamp_top: paintLampTop,
  bell_side: paintBellSide,
  bell_top: paintBellTop,
  tx_side: paintTxSide,
  tx_top: paintTxTop,
  rx_side: paintRxSide,
  rx_top: paintRxTop,
  barrel_side: paintBarrelSide,
  barrel_top: paintBarrelTop,
});
