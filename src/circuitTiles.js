// Caelancraft — procedural 16×16 painters of the powder-and-circuits tiles (docs/DESIGN-circuits.md §1.4, §3.5, §6.2.9) and of
// the Powder Keg's two tiles (75 barrel_side, 76 barrel_top). tiles.js spreads CIRCUIT_TILE_NAMES into its TILE_NAMES and
// CIRCUIT_RECIPES (last) into its RECIPES; `paintTile` then runs these painters exactly like its own.
//
// PURE: no DOM, no three, no imports, no Math.random. A painter is `(px, rng) => void` on a Uint8ClampedArray(16*16*4) in RGBA
// order with idx = (y*16 + x)*4, and `rng` is tiles.js's mulberry32 stream seeded with fnv1a(tileName), so every tile is
// deterministic. On a meshed SIDE tile (the keg's) row 0 is the world-up edge; a meshed TOP tile is seen from above with north
// (−Z) at row 0, and the mesher inscribes the hexagonal cap in it (its corners touch rows 0 and 15).
//
// The art (package C, §1.4, and the user's "fun and simple" redo): no circuit part is a hex cabinet any more. The six THIN
// parts' top tiles are flat pictures on an alpha-0 background, and so is every device's *_top tile: a bold, outlined
// 16×16 picture of its 3D model (circuitGeometry.MODELS) — a bulb, a battery, a lever switch, a big red button, an alarm
// clock… — drawn only as its hotbar / picker / pack / device-panel icon (alpha is only ever 0 or 255). A device's *_side
// tile is a plain swatch of its model's main colour that nothing draws (the device is not meshed). CIRCUIT_CLEAR (all alpha
// 0) is the thin parts' sides and bottom. No circuit part shows gears, no signal wire is red, blue, green or yellow, and no
// tile uses a violet hue (250°–300°): very dark pixels are kept neutral or warm so that per-pixel noise can never tip them
// into violet.

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
// The devices (the user's "fun and simple" redo): each device is a small 3D model (circuitGeometry.MODELS), so its *_top
// tile is a flat picture of that model for its icon (alpha 0 or 255, clear corners, a dark outline so it reads at 32–48 px
// on any slot), and its *_side tile is a swatch of the model's main colour that nothing draws (the block is not meshed).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Paint a 16×16 picture from 16 rows of 16 letters, each a key of `pal` (0xRRGGBB, alpha 255) or '.' (alpha 0).
 * @param {Uint8ClampedArray} px
 * @param {{ pal: Readonly<Record<string, number>>, rows: ReadonlyArray<string> }} art
 */
function picture(px, art) {
  px.fill(0);
  for (let y = 0; y < H; y++) {
    const row = art.rows[y];
    for (let x = 0; x < W; x++) {
      const ch = row[x];
      if (ch !== '.') set(px, x, y, art.pal[ch]);
    }
  }
}

/**
 * The device pictures, by tile name: each echoes its model (front three-quarter view) in its model's colours.
 * @type {Readonly<Record<string, { pal: Readonly<Record<string, number>>, rows: ReadonlyArray<string> }>>}
 */
export const DEVICE_PICTURES = Object.freeze({
  // A black sphere girdled by its glowing amber seam, a white pinprick on the crown, on an iron cradle.
  collapsar_top: {
    pal: { k: 0x050506, K: 0x1b1c1f, h: 0x4a4e56, H: 0x2e3036, O: 0xffa040, o: 0xffd890, W: 0xfff4e0, I: 0x3c4248, i: 0x6a727a },
    rows: [
      '......kkkk......',
      '....kkKWKKkk....',
      '...kKhKKKKKKk...',
      '..kKhHKKKKKKKk..',
      '..kKHKKKKKKKKk..',
      '.kKKKKKKKKKKKKk.',
      'kOOoooooooooOOOk',
      'kOOOOOOOOOOOOOOk',
      '.kKKKKKKKKKKKKk.',
      '..kKKKKKKKKKKk..',
      '..kKKKKKKKKKKk..',
      '...kKKKKKKKKk...',
      '....kkKKKKkk....',
      '.....kiIIik.....',
      '....kIIIIIIk....',
      '....kkkkkkkk....',
    ],
  },
  // A round oak board with black-knobbed brass binding posts and a brass bus ring.
  terminal_top: {
    pal: { k: 0x2a1a0c, E: 0x26282b, e: 0x6a6e74, B: 0xd2a845, W: 0xb07a42, w: 0x7e5228, O: 0xd9a060 },
    rows: [
      '................',
      '................',
      '................',
      '..kk...kk...kk..',
      '.kEek.kEek.kEek.',
      '.kEEk.kEEk.kEEk.',
      '.kkkk.kkkk.kkkk.',
      '..kBk..kBk..kBk.',
      '...kkkkkkkkkk...',
      '.kkBWWWWBWWWWBk.',
      'kWWWWWWWWWWWWWWk',
      'kWWWOOOOOOOOWWWk',
      'kWWWWWWWWWWWWWWk',
      '.kkwwwwwwwwwwkk.',
      '...kkkkkkkkkk...',
      '................',
    ],
  },
  // The stubby teal battery: copper nub and cap, a dark band with a yellow "+".
  battery_top: {
    pal: { k: 0x173d38, T: 0x2f9e8f, t: 0x63c7b7, d: 0x1f6e64, N: 0x2e3238, n: 0x1e2024, Y: 0xf5c542, C: 0xd9843f, c: 0xf2b278, o: 0xa85a26 },
    rows: [
      '................',
      '......kkkk......',
      '......kcok......',
      '....kkkkkkkk....',
      '....kcCCCCok....',
      '...kkkkkkkkkk...',
      '...ktTTTTTTdk...',
      '...kNNNNNNNnk...',
      '...kNNNYNNNnk...',
      '...kNNYYYNNnk...',
      '...kNNNYNNNnk...',
      '...kNNNNNNNnk...',
      '...ktTTTTTTdk...',
      '...ktTTTTTTdk...',
      '...kddddddddk...',
      '....kkkkkkkk....',
    ],
  },
  // The plunger box: a wooden box with dark straps and a brass plate, its T-handle cocked up on a steel rod.
  blaster_top: {
    pal: { k: 0x2a1a0c, H: 0x5a3820, h: 0x7a5232, B: 0xd2a845, b: 0x9a7628, S: 0xb4bac2, s: 0x6e747c, W: 0xb07a42, w: 0x8a5a2c, d: 0x4e3018 },
    rows: [
      '................',
      '.kkkkkkkkkkkkkk.',
      'kBkhhhhhhhhhhkBk',
      'kBkHHHHHHHHHHkBk',
      '.kkkkkkSskkkkkk.',
      '......kSsk......',
      '......kSsk......',
      '....kkkBbkkk....',
      '.kkkkkkkkkkkkkk.',
      '.kWWdWWWWWWdWWk.',
      '.kWWdWBBBbWdWWk.',
      '.kWWdWbbbbWdWWk.',
      '.kWWdWWWWWWdWWk.',
      '.kwwdwwwwwwdwwk.',
      '.kwwdwwwwwwdwwk.',
      '.kkkkkkkkkkkkkk.',
    ],
  },
  // A tilted brass dish holding six round blue selenium cells round a hub, on a post.
  selenium_top: {
    pal: { k: 0x3a2a10, B: 0xd2a845, b: 0xa07c30, U: 0x2a4a8a, u: 0x6a9ad8, I: 0x3c4248, W: 0xa8743e, w: 0x6e4524 },
    rows: [
      '................',
      '....kkkkkkkk....',
      '..kkBBBuUBBBkk..',
      '.kBuUBBUUBBuUBk.',
      '.kBUUBBBBBBUUBk.',
      'kBBBBBBbbBBBBBBk',
      'kBBuUBBBBBBuUBBk',
      '.kBUUBBuUBBUUBk.',
      '.kbbbbbUUbbbbbk.',
      '..kkbbbbbbbbkk..',
      '....kkkkkkkk....',
      '......kIIk......',
      '......kIIk......',
      '....kkkIIkkk....',
      '..kWWWWWWWWWWk..',
      '...kwwwwwwwwk...',
    ],
  },
  // The lever switch: a copper lever with a red ball knob, raised from its brass hinge, on a slate base.
  switch_top: {
    pal: { k: 0x1c242c, S: 0x4a5a6a, s: 0x2e3a46, B: 0xd2a845, b: 0x9a7628, C: 0xe08a44, c: 0xa85a26, R: 0xe0402a, r: 0xff8070, E: 0x26282b },
    rows: [
      '................',
      '..........kkk...',
      '.........kRrRk..',
      '.........kRRRk..',
      '..........kEk...',
      '.........kCck...',
      '........kCck....',
      '.......kCck.....',
      '......kCck......',
      '.....kCck.......',
      '..kkkBCckk..kkk.',
      '..kBBbkk...kBbk.',
      'kkkkkkkkkkkkkkkk',
      'kSSSSSSSSSSSSSSk',
      'kssssssssssssssk',
      '.kkkkkkkkkkkkkk.',
    ],
  },
  // The big red push button on its brass collar and charcoal base.
  button_top: {
    pal: { k: 0x3a0e08, R: 0xe0402a, r: 0xff8a70, d: 0xa82a1c, B: 0xd2a845, b: 0x9a7628, C: 0x44484e, c: 0x2a2d32, K: 0x141618 },
    rows: [
      '................',
      '................',
      '................',
      '.....kkkkkk.....',
      '...kkrrRRRRkk...',
      '..krRRRRRRRRdk..',
      '..kRRRRRRRRRdk..',
      '..kdRRRRRRRddk..',
      '..kkddddddddkk..',
      '.KBBBBBBBBBBBbK.',
      '.KbbbbbbbbbbbbK.',
      'KCCCCCCCCCCCCCCK',
      'KCCCCCCCCCCCCCcK',
      'KcCCCCCCCCCCCccK',
      '.KcccccccccccccK',
      '..KKKKKKKKKKKK..',
    ],
  },
  // The blue twin-bell alarm clock: a cream face with its hand, brass bells and feet, on a wooden plinth.
  timer_top: {
    pal: { k: 0x14304e, S: 0x3a86d4, s: 0x6aaeea, d: 0x245e9a, F: 0xfaf3df, f: 0xd8ccae, H: 0x222426, B: 0xd2a845, b: 0x9a7628, W: 0xa8743e },
    rows: [
      '..kkk......kkk..',
      '.kBBbk....kBBbk.',
      '.kBbbkkkkkkbbbk.',
      '..kkksSSSSSdkk..',
      '...ksFFFFFFdk...',
      '..ksFFFFHFFFdk..',
      '..kSFFFFHFFFdk..',
      '..kSFFFFHFFFdk..',
      '..kSFFFFHHHFdk..',
      '..kSFFFFFFFFdk..',
      '..kdFFFFFFFfdk..',
      '...kdfFFFFfdk...',
      '....kddddddk....',
      '....kBk..kBk....',
      '..kkkkkkkkkkkk..',
      '..kWWWWWWWWWWk..',
    ],
  },
  // The relay: a copper coil with iron pole pieces under the iron armature on its bracket, on an oak base.
  relay_top: {
    pal: { k: 0x24180e, I: 0x3c4248, i: 0x8a929a, C: 0xd9843f, c: 0xa85a26, W: 0xc28b52, w: 0x8a5a2c },
    rows: [
      '................',
      '................',
      '................',
      '.kkkkkkkkkkkkk..',
      '.kiiiiiiiiiiiiik',
      '.kkkkkkkkkkkkIIk',
      '..kIIIIIIk..kIIk',
      '..kCCCCCCk..kIIk',
      '..kccccccck.kIIk',
      '..kCCCCCCk..kIIk',
      '..kccccccck.kIIk',
      '..kCCCCCCk..kIIk',
      '..kIIIIIIk..kIIk',
      'kkkkkkkkkkkkkkkk',
      'kWWWWWWWWWWWWWWk',
      '.kwwwwwwwwwwwwk.',
    ],
  },
  // The igniter: a cream ceramic pot with a terracotta rim, its coil glowing between two brass posts.
  igniter_top: {
    pal: { k: 0x3a1c0c, B: 0xd2a845, O: 0xff8a3a, Y: 0xffe080, T: 0xc8642a, t: 0x9a4a1e, P: 0xeee8da, p: 0xc8c0ae, D: 0x3a2a22 },
    rows: [
      '................',
      '......Y...Y.....',
      '....Y..YOY..Y...',
      '..kk..OY.YO..kk.',
      '..kBkO.O.O.OkBk.',
      '..kBO.k.k.k.OBk.',
      '.kkkkkkkkkkkkkk.',
      '.kTTTDDDDDDTTTk.',
      '.kttttttttttttk.',
      '..kPPPPPPPPPpk..',
      '..kPPPPPPPPPpk..',
      '..kPPPPPPPPPpk..',
      '..kPPPPPPPPPpk..',
      '..kPPPPPPPPPpk..',
      '..kppppppppppk..',
      '...kkkkkkkkkk...',
    ],
  },
  // The lamp: a fat round glass bulb with its glowing carbon loop, in a brass socket on a round wooden foot.
  lamp_top: {
    pal: { k: 0x5a4a2a, G: 0xeaf4ff, g: 0xbcd4ea, h: 0xffffff, F: 0xff9a20, f: 0xffd060, B: 0xd2a845, b: 0x9a7628, W: 0xa8743e, w: 0x6e4524 },
    rows: [
      '.....kkkkkk.....',
      '....kGGGGGgk....',
      '...kGhGGGGGgk...',
      '..kGhGGfFfGGgk..',
      '..kGGGfGGfGGgk..',
      '..kGGGFGGFGGgk..',
      '..kGGGGFFGGGgk..',
      '...kGGGfGGGgk...',
      '....kGGfGGgk....',
      '.....kkkkkk.....',
      '.....kBBBbk.....',
      '.....kbbbbk.....',
      '.....kBBBbk.....',
      '...kkkkkkkkkk...',
      '..kWWWWWWWWWWk..',
      '...kwwwwwwwwk...',
    ],
  },
  // The red alarm bell on its post and dark base, ringing (yellow dashes either side).
  bell_top: {
    pal: { k: 0x3a0e08, R: 0xd23c2c, r: 0xff7a60, d: 0x8e2418, B: 0xd2a845, Y: 0xffe680, W: 0x6e4524, w: 0x4a2c16 },
    rows: [
      '.......kk.......',
      '......kBBk......',
      '..Y..kkRRkk..Y..',
      '.Y..kRrRRRdk..Y.',
      'Y..kRrRRRRRdk..Y',
      '.Y.kRrRRRRRdk.Y.',
      '..YkRRRRRRRdkY..',
      '...kRRRRRRRdk...',
      '..kRRRRRRRRRdk..',
      '.kRRRRRRRRRRRdk.',
      '.kddddddddddddk.',
      '..kkkkkBBkkkkkk.',
      '......kBBk..kBk.',
      '.kkkkkkkkkkkkkk.',
      '.kWWWWWWWWWWWWk.',
      '..kwwwwwwwwwwk..',
    ],
  },
  // The spark transmitter: a red-brown box, a spark between two brass balls, and a tall antenna sending blue waves.
  tx_top: {
    pal: { k: 0x2a0e06, R: 0xe0402a, r: 0xff8a70, I: 0x4a4f55, B: 0xd2a845, b: 0x9a7628, Z: 0x7ab8ff, M: 0xb05436, m: 0x7a3420 },
    rows: [
      '.kk....Z........',
      'kRrk.Z..Z.......',
      'kRRk..Z.Z.......',
      '.kk..Z.Z........',
      '.kIk............',
      '.kIk............',
      '.kIk..kk..kk....',
      '.kIk.kBBZZBBk...',
      '.kIk.kbBkkBbk...',
      'kkkkkkkkkkkkkkkk',
      'kMMMMMMMMMMMMMMk',
      'kMMMMMMMMMMMMMmk',
      'kMMMMMMMMMMMMMmk',
      'kMMMMMMMMMMMMMmk',
      'kmmmmmmmmmmmmmmk',
      '.kkkkkkkkkkkkkk.',
    ],
  },
  // The coherer receiver: a blue box with a cream tuning dial, the glass tube of filings on its lid, a short antenna.
  rx_top: {
    pal: { k: 0x0e1a2c, N: 0x3a6aa6, n: 0x264670, B: 0xd2a845, b: 0x9a7628, I: 0x4a4f55, G: 0xd6ecff, g: 0x9fc0dc, F: 0x707070, C: 0xf3e6c4, c: 0x2b2b2b },
    rows: [
      '............kk..',
      '...........kBBk.',
      '...........kbbk.',
      '............kIk.',
      '............kIk.',
      '.kkkkkkkkkk.kIk.',
      'kBkGGGGGGGkBkIk.',
      'kBkgFgFgFgkBkIk.',
      'kbkkkkkkkkkbkIk.',
      'kkkkkkkkkkkkkkkk',
      'kNNNNNNNNNNNNNNk',
      'kNNNNkkkkNNNNNnk',
      'kNNNkCCcCkNNNNnk',
      'kNNNkCCCCkNNNNnk',
      'knnnnkkkknnnnnnk',
      '.kkkkkkkkkkkkkk.',
    ],
  },
});

/** Each device's side tile: a swatch of its model's main colour (0xRRGGBB, noise ±4, alpha 255), by tile name. */
export const DEVICE_SWATCHES = Object.freeze({
  collapsar_side: 0x1b1c1f, terminal_side: 0xa8743e, battery_side: 0x2f9e8f, blaster_side: 0xb07a42,
  selenium_side: 0xd2a845, switch_side: 0x3e4a56, button_side: 0xe0402a, timer_side: 0x3a86d4, relay_side: 0xd9843f,
  igniter_side: 0xeee8da, lamp_side: 0xeaf4ff, bell_side: 0xd23c2c, tx_side: 0x9a4a2c, rx_side: 0x35609a,
});

/** @returns {Painter} the painter of a device's picture tile */
function pictureOf(name) {
  return (px) => picture(px, DEVICE_PICTURES[name]);
}

/** @returns {Painter} the painter of a device's swatch tile */
function swatchOf(name) {
  return (px, rng) => fill(px, rng, DEVICE_SWATCHES[name], 4);
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
  collapsar_side: swatchOf('collapsar_side'),
  collapsar_top: pictureOf('collapsar_top'),
  powder_fuse: paintPowderFuse,
  torch: paintTorch,
  copper_wire: paintCopperWire,
  brown_wire: paintBrownWire,
  white_wire: paintWhiteWire,
  earth_wire: paintEarthWire,
  terminal_side: swatchOf('terminal_side'),
  terminal_top: pictureOf('terminal_top'),
  battery_side: swatchOf('battery_side'),
  battery_top: pictureOf('battery_top'),
  blaster_side: swatchOf('blaster_side'),
  blaster_top: pictureOf('blaster_top'),
  selenium_side: swatchOf('selenium_side'),
  selenium_top: pictureOf('selenium_top'),
  switch_side: swatchOf('switch_side'),
  switch_top: pictureOf('switch_top'),
  button_side: swatchOf('button_side'),
  button_top: pictureOf('button_top'),
  timer_side: swatchOf('timer_side'),
  timer_top: pictureOf('timer_top'),
  relay_side: swatchOf('relay_side'),
  relay_top: pictureOf('relay_top'),
  igniter_side: swatchOf('igniter_side'),
  igniter_top: pictureOf('igniter_top'),
  lamp_side: swatchOf('lamp_side'),
  lamp_top: pictureOf('lamp_top'),
  bell_side: swatchOf('bell_side'),
  bell_top: pictureOf('bell_top'),
  tx_side: swatchOf('tx_side'),
  tx_top: pictureOf('tx_top'),
  rx_side: swatchOf('rx_side'),
  rx_top: pictureOf('rx_top'),
  barrel_side: paintBarrelSide,
  barrel_top: paintBarrelTop,
});
