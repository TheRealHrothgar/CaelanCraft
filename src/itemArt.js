// Caelancraft — procedural 16×16 icons for every non-block survival item (tools, materials, food, bandages, clothes).
// See docs/DESIGN-survival.md §9.8 ("itemArt.js") and §11 (originality); CONTRACTS §48 once merged.
//
// PURE: no imports, no DOM, no Math.random. Each icon is painted from a private mulberry32 stream seeded with
// fnv1a('item:' + key), so it is bit-identical across runs. Output: Uint8ClampedArray(16*16*4), RGBA, idx = (y*16 + x)*4,
// y down. Pixels are either fully transparent (alpha 0) or fully opaque (alpha 255): the icons are crisp pixel art that
// itemIcons.js scales with nearest-neighbour sampling.
//
// Art rules (§9.8):
// - Tools are UPRIGHT (never the 45° diagonal of other games): the haft is columns 7–8 (6–9 with its dark rim), the
//   working end at the top (axe, pick, hammer, knife, spear, sword) or at the bottom (spade). The tier shows in the head
//   colour AND in the binding: a cord wrap (stone, flint), a cast socket ring (copper, bronze), a forged eye with a rivet
//   pixel (iron, steel). The hammerstone is a plain cobble with a pale strike scar.
// - Ingots and bars are hexagonal bars; ores are mineral lumps in their mineral's colours; pots have a hexagonal rim and
//   show their fill (water, sea-green, sap amber, snow).
// - Everything else is a small original pictogram (honeyberries are elongated dusky-blue berries with a pale bloom).
// Unknown keys paint the magenta/black 'missing' checker, like tiles.js.

const W = 16;
const H = 16;
const BYTES = W * H * 4;

/** Icon edge length in pixels. */
export const ITEM_ART_SIZE = 16;

// ---------------------------------------------------------------------------------------------------------------
// PRNG (the same generators as tiles.js; private copies — this module imports nothing)
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {() => number} Rng  uniform in [0,1) */

/** @param {number} a uint32 seed @returns {Rng} */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over UTF-16 code units. @param {string} s @returns {number} uint32 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Colours and pixels. Colours are packed 0xRRGGBB numbers.
// ---------------------------------------------------------------------------------------------------------------

/** Scale a colour toward black (f < 0) or white (f > 0); f in −1..1. */
function tone(hex, f) {
  const ch = (v) => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f);
  return (ch((hex >> 16) & 255) << 16) | (ch((hex >> 8) & 255) << 8) | ch(hex & 255);
}

/** A 16×16 icon being painted. */
class Icon {
  constructor() {
    this.px = new Uint8ClampedArray(BYTES);
  }

  /** Opaque pixel (out-of-range coordinates are ignored). @param {number} x @param {number} y @param {number} c */
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= W || y >= H || !Number.isInteger(x) || !Number.isInteger(y)) return;
    const i = (y * W + x) * 4;
    this.px[i] = (c >> 16) & 255;
    this.px[i + 1] = (c >> 8) & 255;
    this.px[i + 2] = c & 255;
    this.px[i + 3] = 255;
  }

  /** Make a pixel transparent again. */
  clear(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    this.px[(y * W + x) * 4 + 3] = 0;
  }

  /** @returns {boolean} */
  opaque(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return this.px[(y * W + x) * 4 + 3] !== 0;
  }

  /** @returns {number} the colour at an opaque pixel (0 when transparent) */
  get(x, y) {
    if (!this.opaque(x, y)) return 0;
    const i = (y * W + x) * 4;
    return (this.px[i] << 16) | (this.px[i + 1] << 8) | this.px[i + 2];
  }

  /** Inclusive rectangle. */
  rect(x0, y0, x1, y1, c) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, c);
  }

  /** Bresenham line, inclusive. */
  line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Filled ellipse over pixel centres; `c` may be a function (x, y, u, v) → colour, u/v in −1..1 inside. */
  ellipse(cx, cy, rx, ry, c) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        if (u * u + v * v <= 1) this.set(x, y, typeof c === 'function' ? c(x, y, u, v) : c);
      }
    }
  }

  /** Filled polygon (even-odd over pixel centres); points are [x, y] in pixel units. */
  poly(points, c) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.set(x, y, typeof c === 'function' ? c(x, y) : c);
      }
    }
  }

  /** Per-pixel brightness jitter on every opaque pixel: ±amp (0..1 of the way to black / white). */
  jitter(rng, amp) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.opaque(x, y)) this.set(x, y, tone(this.get(x, y), (rng() * 2 - 1) * amp));
      }
    }
  }

  /**
   * A dark rim around the shape: every transparent pixel 4-adjacent to an opaque one takes that neighbour's colour,
   * darkened. Run last; it makes small icons read on any slot background.
   * @param {number} [dark=-0.62]
   */
  outline(dark = -0.62) {
    /** @type {Array<[number, number, number]>} */
    const add = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.opaque(x, y)) continue;
        const n = [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]].find(([a, b]) => this.opaque(a, b));
        if (n) add.push([x, y, tone(this.get(n[0], n[1]), dark)]);
      }
    }
    for (const [x, y, c] of add) this.set(x, y, c);
  }
}

/** 8×8 quadrant checker, magenta top-left / bottom-right, black elsewhere (tiles.js 'missing'). */
function paintMissing(ic) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ic.set(x, y, (x < 8) === (y < 8) ? 0xff00ff : 0x000000);
}

// ---------------------------------------------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------------------------------------------

/** Wood of hafts and handles. */
const WOOD = { base: 0x8a5a2b, dark: 0x5e3b1a, light: 0xb07a42 };
/** Cord and fibre. */
const CORD = { light: 0xd8c38c, dark: 0x8f7a4a };
/** The handbook's binding (§14). */
const LEATHER = { base: 0x7a4a2a, light: 0x9a6238, dark: 0x5a341c, spine: 0x4a2a14 };

/**
 * Head colours by tier (§9.8): stone grey, flint #3b3f4a with a pale cortex, copper #c8743a, bronze #b08d3a, iron #8a8f96,
 * steel #c9d3dc with a blue glint. Tier 0 kit (drill, crucible, mold) has its own colours.
 */
const TIER_PALETTE = [
  { base: 0x9a8f80, dark: 0x6a6258, light: 0xc4b8a6 },
  { base: 0x8c8a85, dark: 0x5f5d59, light: 0xbab7b0 },
  { base: 0x3b3f4a, dark: 0x24262e, light: 0x6b7184, cortex: 0xd8d2c0 },
  { base: 0xc8743a, dark: 0x8f4a22, light: 0xf0a56c },
  { base: 0xb08d3a, dark: 0x7a5f22, light: 0xe2c672 },
  { base: 0x8a8f96, dark: 0x5c6066, light: 0xbcc1c8 },
  { base: 0xc9d3dc, dark: 0x8d98a3, light: 0xf4f8fb, glint: 0x7fb2ff },
];

/** @returns {{base:number,dark:number,light:number,cortex?:number,glint?:number}} */
function tierPal(tier) {
  return TIER_PALETTE[Math.max(0, Math.min(6, tier | 0))];
}

/** Binding style by tier. */
function bindingOf(tier) {
  return tier <= 2 ? 'cord' : tier <= 4 ? 'socket' : 'eye';
}

// ---------------------------------------------------------------------------------------------------------------
// Tools (upright; haft in columns 7–8)
// ---------------------------------------------------------------------------------------------------------------

/** Vertical wooden haft, columns 7–8, rows y0..y1, lit from the left. */
function haft(ic, y0, y1, wood = WOOD) {
  for (let y = y0; y <= y1; y++) {
    ic.set(7, y, wood.light);
    ic.set(8, y, (y & 3) === 1 ? wood.dark : wood.base);
  }
}

/**
 * The tier's binding across columns 6–9 at rows y, y+1 (§9.8): a cord wrap (tiers 1–2), a cast socket ring (3–4) or a
 * forged eye with a rivet pixel (5–6).
 */
function binding(ic, tier, y) {
  const pal = tierPal(tier);
  const kind = bindingOf(tier);
  if (kind === 'cord') {
    // a diagonal over-under wrap of cord
    for (let x = 6; x <= 9; x++) {
      ic.set(x, y, (x & 1) === 0 ? CORD.light : CORD.dark);
      ic.set(x, y + 1, (x & 1) === 1 ? CORD.light : CORD.dark);
    }
  } else if (kind === 'socket') {
    // a cast ring: metal band, bright on the left, shadowed on the right, a dark seam under it
    ic.set(6, y, pal.light);
    ic.set(7, y, pal.light);
    ic.set(8, y, pal.base);
    ic.set(9, y, pal.dark);
    ic.set(6, y + 1, pal.base);
    ic.set(7, y + 1, pal.base);
    ic.set(8, y + 1, pal.dark);
    ic.set(9, y + 1, pal.dark);
  } else {
    // a forged eye: dark wrapped iron with one bright rivet pixel
    ic.rect(6, y, 9, y + 1, pal.dark);
    ic.set(7, y, tone(pal.dark, -0.3));
    ic.set(8, y, 0xf6f2e8);
  }
}

/** Shade a head pixel by its position: light toward the top-left, dark toward the bottom-right. */
function headShade(pal, x, y, x0, y0, x1, y1) {
  if (x === x0 || y === y0) return pal.light;
  if (x === x1 || y === y1) return pal.dark;
  return pal.base;
}

/** Steel's blue glint and flint's pale cortex: the tier marks on a head. */
function headMarks(ic, tier, glintAt, cortexAt) {
  const pal = tierPal(tier);
  if (pal.glint !== undefined && glintAt) for (const [x, y] of glintAt) ic.set(x, y, pal.glint);
  if (pal.cortex !== undefined && cortexAt) for (const [x, y] of cortexAt) ic.set(x, y, pal.cortex);
}

function paintKnife(ic, tier) {
  const pal = tierPal(tier);
  // blade, point up: rows 1–8, spine column 7, edge column 9
  ic.set(8, 1, pal.light);
  ic.set(7, 2, pal.light);
  ic.set(8, 2, pal.base);
  for (let y = 3; y <= 8; y++) {
    ic.set(7, y, pal.light);
    ic.set(8, y, pal.base);
    ic.set(9, y, y < 5 ? pal.base : pal.dark);
  }
  headMarks(ic, tier, [[8, 3], [8, 4]], [[7, 4], [7, 5], [7, 6]]);
  binding(ic, tier, 9);
  haft(ic, 11, 15);
  ic.set(7, 15, WOOD.dark);
}

function paintAxe(ic, tier, chopper = false) {
  const pal = tierPal(tier);
  haft(ic, 1, 15);
  if (chopper) {
    // a knapped cobble lashed to the haft's right side, its chipped edge bright
    ic.ellipse(11.2, 5, 3.4, 3.4, (x, y) => (x >= 13 ? pal.light : y <= 3 ? tone(pal.base, 0.15) : pal.base));
    ic.set(13, 4, 0xe6e0d4);
    ic.set(14, 5, 0xe6e0d4);
  } else {
    // a bearded blade: rows 2–7 to the right of the haft, a short poll on the left
    for (let y = 2; y <= 7; y++) {
      const reach = y === 2 || y === 7 ? 11 : y === 3 || y === 6 ? 12 : 13;
      for (let x = 9; x <= reach; x++) ic.set(x, y, x === reach ? pal.light : headShade(pal, x, y, 9, 2, reach - 1, 7));
    }
    ic.rect(5, 3, 6, 5, pal.dark);
    ic.set(5, 3, pal.base);
    headMarks(ic, tier, [[13, 4], [12, 3]], [[9, 3], [9, 4], [10, 3]]);
  }
  binding(ic, tier, 8);
}

function paintPick(ic, tier) {
  const pal = tierPal(tier);
  haft(ic, 3, 15);
  // a curved two-pointed head across the top
  ic.rect(4, 1, 11, 1, pal.light);
  ic.rect(2, 2, 13, 2, pal.base);
  ic.rect(6, 3, 9, 3, pal.dark);
  ic.set(1, 3, pal.base);
  ic.set(2, 3, pal.dark);
  ic.set(14, 3, pal.base);
  ic.set(13, 3, pal.dark);
  ic.set(1, 4, pal.light);
  ic.set(14, 4, pal.light);
  headMarks(ic, tier, [[5, 1], [10, 1]], [[5, 2], [6, 2], [10, 2]]);
  binding(ic, tier, 4);
}

function paintHammer(ic, tier) {
  const pal = tierPal(tier);
  haft(ic, 6, 15);
  for (let y = 1; y <= 5; y++) {
    for (let x = 4; x <= 11; x++) ic.set(x, y, headShade(pal, x, y, 4, 1, 11, 5));
  }
  // striking faces at both ends
  ic.rect(3, 2, 3, 4, pal.dark);
  ic.rect(12, 2, 12, 4, pal.dark);
  headMarks(ic, tier, [[6, 2], [7, 2]], [[5, 3], [6, 4]]);
  binding(ic, tier, 6);
}

function paintSpade(ic, tier, stick = false) {
  const pal = tierPal(tier);
  if (stick) {
    // the digging stick: a pole with a fire-hardened point at the bottom and a lashed foot peg
    haft(ic, 0, 13);
    ic.set(7, 14, WOOD.dark);
    ic.set(8, 14, 0x3a2414);
    ic.set(8, 15, 0x2a1a10);
    ic.rect(9, 9, 10, 9, WOOD.base);
    ic.set(10, 10, WOOD.dark);
    binding(ic, tier, 8);
    return;
  }
  // a T grip at the top, the blade at the bottom (§9.8: a spade's working end is at the bottom)
  ic.rect(5, 0, 10, 0, WOOD.light);
  ic.rect(5, 1, 6, 1, WOOD.dark);
  ic.rect(9, 1, 10, 1, WOOD.dark);
  haft(ic, 1, 8);
  binding(ic, tier, 8);
  for (let y = 10; y <= 15; y++) {
    const half = y <= 13 ? 3 : y === 14 ? 2 : 1;
    for (let x = 8 - half; x <= 7 + half; x++) ic.set(x, y, headShade(pal, x, y, 8 - half, 10, 7 + half, 15));
  }
  headMarks(ic, tier, [[6, 11], [6, 12]], [[9, 11], [9, 12], [8, 13]]);
}

function paintSpear(ic, tier) {
  const pal = tierPal(tier);
  haft(ic, 7, 15);
  // a leaf-shaped head
  ic.set(8, 0, pal.light);
  ic.set(7, 1, pal.light);
  ic.set(8, 1, pal.base);
  for (let y = 2; y <= 4; y++) {
    ic.set(6, y, pal.light);
    ic.set(7, y, pal.base);
    ic.set(8, y, pal.base);
    ic.set(9, y, pal.dark);
  }
  ic.set(7, 5, pal.base);
  ic.set(8, 5, pal.dark);
  headMarks(ic, tier, [[7, 2]], [[6, 3], [6, 4], [7, 3]]);
  binding(ic, tier, 6);
}

function paintSword(ic, tier) {
  const pal = tierPal(tier);
  // blade with a dark fuller, point up
  ic.set(7, 0, pal.light);
  ic.set(8, 0, pal.base);
  for (let y = 1; y <= 9; y++) {
    ic.set(7, y, pal.light);
    ic.set(8, y, y >= 2 && y <= 8 ? pal.dark : pal.base);
  }
  ic.set(6, 9, pal.light);
  ic.set(9, 9, pal.dark);
  headMarks(ic, tier, [[7, 3], [7, 4]], null);
  // crossguard, the tier's binding at its middle, a wrapped grip and a pommel
  ic.rect(4, 10, 11, 10, pal.dark);
  ic.set(4, 10, pal.base);
  ic.set(11, 10, pal.base);
  binding(ic, tier, 10);
  for (let y = 12; y <= 14; y++) {
    ic.set(7, y, (y & 1) ? 0x6b4428 : 0x4a2c18);
    ic.set(8, y, (y & 1) ? 0x4a2c18 : 0x6b4428);
  }
  ic.set(7, 15, pal.light);
  ic.set(8, 15, pal.base);
}

function paintHammerstone(ic, rng) {
  ic.ellipse(7.8, 8.6, 5.6, 4.6, (x, y, u, v) => (u + v < -0.9 ? 0xb4b0a8 : u + v > 0.9 ? 0x6a6660 : 0x8f8b84));
  ic.jitter(rng, 0.08);
  // the pale strike scar where it has knocked flint, with a dark fracture line
  for (const [x, y] of [[4, 6], [5, 6], [5, 5], [6, 5], [4, 7], [6, 6]]) ic.set(x, y, 0xe8e2d4);
  ic.set(6, 7, 0x4a4640);
  ic.set(7, 6, 0x4a4640);
}

function paintFireDrill(ic) {
  // the spindle upright in columns 7–8 with a bow-string loop, on a hearth board with an ember in its notch
  haft(ic, 1, 12, { base: 0xa8784a, dark: 0x7a5230, light: 0xd2a46c });
  for (let x = 6; x <= 9; x++) ic.set(x, 6, CORD.light);
  ic.set(5, 6, CORD.dark);
  ic.set(10, 6, CORD.dark);
  ic.set(4, 7, CORD.dark);
  ic.set(11, 7, CORD.dark);
  ic.rect(2, 13, 13, 14, WOOD.base);
  ic.rect(2, 13, 13, 13, WOOD.light);
  ic.set(7, 13, 0x2a1a10);
  ic.set(8, 13, 0xff8a2a);
  ic.set(8, 12, 0xffc04a);
  ic.set(3, 14, WOOD.dark);
  ic.set(12, 14, WOOD.dark);
}

/** A tapered cup with a hexagonal rim (crucible, greenware crucible). */
function paintCrucible(ic, rng, clay, inner) {
  ic.poly([[3, 5], [13, 5], [11, 15], [5, 15]], (x) => (x <= 5 ? tone(clay, 0.18) : x >= 11 ? tone(clay, -0.22) : clay));
  hexRim(ic, 8, 4, 5, clay, inner);
  ic.jitter(rng, 0.05);
}

/** A casting mold (fired or greenware): a flat block with a tool-shaped hollow and a pour channel. */
function paintMold(ic, rng, clay) {
  ic.poly([[1, 6], [4, 3], [15, 3], [12, 6]], tone(clay, 0.2));
  ic.rect(1, 6, 12, 12, clay);
  ic.poly([[12, 6], [15, 3], [15, 9], [12, 12.9]], tone(clay, -0.25));
  ic.jitter(rng, 0.05);
  // the hollow: an axe-head outline and the channel the metal is poured down
  const hollow = tone(clay, -0.6);
  ic.rect(4, 7, 8, 10, hollow);
  ic.rect(9, 8, 10, 9, hollow);
  ic.set(4, 7, tone(hollow, 0.2));
  ic.rect(6, 4, 7, 5, hollow);
}

/** The tools of §5.1 by type (and the tier from the ToolDef). */
function paintTool(ic, rng, key, type, tier) {
  if (key === 'hammerstone') return paintHammerstone(ic, rng);
  if (key === 'stone_chopper') return paintAxe(ic, tier, true);
  if (key === 'digging_stick') return paintSpade(ic, tier, true);
  switch (type) {
    case 'knife': return paintKnife(ic, tier);
    case 'axe': return paintAxe(ic, tier);
    case 'pick': return paintPick(ic, tier);
    case 'hammer': return paintHammer(ic, tier);
    case 'spade': return paintSpade(ic, tier);
    case 'spear': return paintSpear(ic, tier);
    case 'sword': return paintSword(ic, tier);
    case 'firestarter': return paintFireDrill(ic);
    case 'crucible': return paintCrucible(ic, rng, 0xd8d0c4, 0x3a2e2a);
    case 'mold': return paintMold(ic, rng, 0xb8683e);
    default: return paintMissing(ic);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared pictogram parts
// ---------------------------------------------------------------------------------------------------------------

/**
 * A flat hexagonal rim seen from above at an angle (a wide hexagon): outer edge in clay, the opening filled with `inner`.
 * @param {Icon} ic @param {number} cx centre x @param {number} cy centre row @param {number} hw half width
 * @param {number} clay @param {number} inner
 */
function hexRim(ic, cx, cy, hw, clay, inner) {
  const q = Math.max(1, Math.round(hw / 2));
  ic.poly([[cx - hw - 1, cy + 0.5], [cx - q, cy - 2], [cx + q, cy - 2], [cx + hw + 1, cy + 0.5], [cx + q, cy + 3], [cx - q, cy + 3]],
    tone(clay, 0.28));
  ic.poly([[cx - hw + 0.6, cy + 0.5], [cx - q + 0.5, cy - 1], [cx + q - 0.5, cy - 1], [cx + hw - 0.6, cy + 0.5], [cx + q - 0.5, cy + 2], [cx - q + 0.5, cy + 2]],
    inner);
}

/** A pot with a hexagonal rim; `fill` is the opening's colour (a dark hollow when empty), `fill2` a second tone. */
function paintPot(ic, rng, clay, fill, fill2) {
  ic.ellipse(8, 10.2, 6.2, 5.2, (x, y, u) => (u < -0.45 ? tone(clay, 0.16) : u > 0.5 ? tone(clay, -0.24) : clay));
  ic.rect(5, 14, 10, 15, tone(clay, -0.15));
  ic.jitter(rng, 0.04);
  // a band of incised hexes round the shoulder
  for (const x of [4, 7, 10, 13]) ic.set(x - 1, 8, tone(clay, -0.35));
  hexRim(ic, 8, 4, 5, clay, fill);
  if (fill2 !== undefined) {
    ic.set(6, 4, fill2);
    ic.set(9, 5, fill2);
    ic.set(10, 4, fill2);
  }
}

/** A hexagonal bar (ingots and bars): a long bar whose ends are chamfered to a hexagon's profile. */
function paintBar(ic, rng, pal, marks) {
  // top face (light), front face (base), lower chamfer (dark): an elongated hexagon in profile
  ic.poly([[1, 7.5], [3.5, 5], [12.5, 5], [15, 7.5], [12.5, 10], [3.5, 10]], pal.base);
  ic.rect(4, 5, 12, 6, pal.light);
  ic.rect(4, 9, 12, 9, pal.dark);
  ic.set(2, 7, tone(pal.light, -0.1));
  ic.set(13, 8, pal.dark);
  ic.set(14, 8, pal.dark);
  // the hex end face on the left
  ic.set(2, 6, pal.light);
  ic.set(1, 8, pal.dark);
  ic.jitter(rng, 0.04);
  if (marks) marks(ic);
}

/** An irregular lump (ores, nuggets, lumps): an ellipse with a bumpy rim and top-left light. */
function paintLump(ic, rng, cx, cy, rx, ry, pal) {
  const bumps = [rng(), rng(), rng(), rng(), rng(), rng()].map((v) => 0.82 + v * 0.3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5 - cx) / rx;
      const v = (y + 0.5 - cy) / ry;
      const a = Math.atan2(v, u);
      const k = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 6) % 6;
      if (u * u + v * v <= bumps[k] * bumps[k]) ic.set(x, y, u + v < -0.7 ? pal.light : u + v > 0.75 ? pal.dark : pal.base);
    }
  }
}

/** Scatter `n` pixels of colour `c` over opaque pixels of the icon (deterministic). */
function speckle(ic, rng, n, c, region) {
  for (let i = 0, tries = 0; i < n && tries < 400; tries++) {
    const x = Math.floor(rng() * W);
    const y = Math.floor(rng() * H);
    if (!ic.opaque(x, y)) continue;
    if (region && !region(x, y)) continue;
    ic.set(x, y, c);
    i++;
  }
}

/** A box seen from above-front (bricks): top face light, front face base. */
function paintBrick(ic, rng, base) {
  ic.poly([[2, 7], [5, 4], [15, 4], [12, 7]], tone(base, 0.22));
  ic.rect(2, 7, 12, 12, base);
  ic.poly([[12, 7], [15, 4], [15, 9], [12, 12.9]], tone(base, -0.28));
  ic.jitter(rng, 0.07);
  // the brick's frog (a hexagonal hollow in its top)
  ic.set(8, 5, tone(base, -0.3));
  ic.set(9, 5, tone(base, -0.3));
  ic.set(7, 6, tone(base, -0.2));
}

// ---------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------

/** @type {Record<string, (ic: Icon, rng: Rng) => void>} */
const MATERIAL_PAINTERS = {
  rock(ic, rng) {
    ic.poly([[3, 7], [6, 4], [11, 4], [14, 8], [12, 13], [5, 13]], (x, y) => (x + y < 12 ? 0xa8a49c : x + y > 21 ? 0x66625c : 0x87837c));
    ic.jitter(rng, 0.07);
    ic.set(7, 6, 0xc8c4bc);
    ic.set(10, 10, 0x55524c);
  },
  flint(ic, rng) {
    // a dark nodule in a pale chalky cortex, broken open to show conchoidal ripples
    ic.ellipse(8, 8.5, 6.4, 5.6, 0xd8d2c0);
    ic.ellipse(8.6, 8.8, 4.8, 4.0, (x, y, u, v) => (u + v < -0.6 ? 0x6b7184 : 0x3b3f4a));
    ic.jitter(rng, 0.05);
    ic.line(6, 9, 9, 6, 0x565c6c);
    ic.line(7, 11, 11, 7, 0x565c6c);
  },
  obsidian_shard(ic) {
    ic.poly([[4, 14], [6, 3], [11, 1], [12, 9], [9, 15]], (x) => (x <= 6 ? 0x3a2a4a : 0x17121e));
    ic.line(7, 4, 6, 12, 0x6a4a8a);
    ic.set(10, 3, 0xe8e0ff);
    ic.set(9, 4, 0xa890d0);
  },
  stick(ic) {
    // a crooked stick with a side twig and a knot
    for (let y = 1; y <= 14; y++) {
      const x = y < 6 ? 9 : y < 11 ? 8 : 7;
      ic.set(x, y, WOOD.light);
      ic.set(x + 1, y, WOOD.base);
    }
    ic.line(10, 8, 13, 5, WOOD.base);
    ic.set(13, 4, 0x6f9a3a);
    ic.set(9, 9, WOOD.dark);
  },
  plant_fibre(ic, rng) {
    const greens = [0x9ab04a, 0xc8c070, 0x6f8f3a, 0xb0b860];
    for (let i = 0; i < 6; i++) {
      const x0 = 4 + i;
      const c = greens[i % greens.length];
      for (let y = 1; y <= 14; y++) ic.set(x0 + (y < 5 ? -1 : y > 10 ? 1 : 0) * ((i & 1) ? 1 : -1) + (rng() < 0.15 ? 1 : 0), y, c);
    }
    ic.rect(4, 7, 11, 8, CORD.dark);
    ic.set(5, 7, CORD.light);
    ic.set(9, 7, CORD.light);
  },
  cord(ic) {
    // a coiled hank with a loose end
    ic.ellipse(8, 8.5, 6, 5, CORD.dark);
    ic.ellipse(8, 8.5, 4.2, 3.3, CORD.light);
    ic.ellipse(8, 8.5, 2.6, 1.8, CORD.dark);
    ic.clear(7, 8);
    ic.clear(8, 8);
    ic.line(12, 12, 14, 15, CORD.light);
    for (let x = 3; x <= 13; x += 3) ic.set(x, 8, tone(CORD.dark, -0.2));
  },
  birch_bark(ic, rng) {
    // a curled strip of white bark with dark lenticels
    ic.poly([[2, 5], [13, 3], [14, 11], [3, 13]], (x, y) => (y >= 11 || x >= 13 ? 0xc8c2b6 : 0xeeeae2));
    ic.jitter(rng, 0.03);
    for (const [x, y] of [[4, 6], [5, 6], [8, 8], [9, 8], [10, 8], [5, 10], [6, 10], [11, 5], [12, 5]]) ic.set(x, y, 0x2a2826);
    ic.rect(13, 4, 14, 10, 0xb08a6a);
  },
  clay_lump(ic, rng) {
    paintLump(ic, rng, 8, 9, 6, 5, { base: 0xa3a6b4, dark: 0x6f7280, light: 0xc8cad4 });
    ic.ellipse(9.5, 7.5, 1.6, 1.2, 0x868a98); // a thumb print
  },
  coal(ic, rng) {
    paintLump(ic, rng, 6, 10, 4.2, 3.8, { base: 0x2b2b30, dark: 0x16161a, light: 0x5a5a66 });
    paintLump(ic, rng, 11, 7, 3.6, 3.4, { base: 0x303036, dark: 0x18181c, light: 0x666672 });
    ic.set(10, 5, 0x9a9aaa);
  },
  charcoal(ic) {
    // a black stick-chunk that still shows its wood grain and growth rings at the end
    ic.poly([[2, 6], [12, 4], [14, 10], [4, 12]], 0x2e2622);
    ic.line(3, 8, 12, 6, 0x4a3a30);
    ic.line(4, 10, 13, 8, 0x4a3a30);
    ic.ellipse(13, 7.2, 1.8, 3, 0x3a2e28);
    ic.set(13, 7, 0x6a5040);
    ic.set(5, 7, 0x8a7a70);
  },
  malachite(ic, rng) {
    // green banded mineral (§8.2's copper ore colours)
    paintLump(ic, rng, 8, 9, 6.2, 5.2, { base: 0x2f8f5b, dark: 0x1f6b43, light: 0x6fd39a });
    ic.ellipse(8.4, 9.2, 3.6, 2.8, 0x1f6b43);
    ic.ellipse(8.4, 9.2, 2.2, 1.6, 0x6fd39a);
    ic.ellipse(8.4, 9.2, 1, 0.7, 0x2f8f5b);
    ic.set(4, 7, 0xc8743a);
  },
  cassiterite(ic, rng) {
    // dark brown-black tin-stone crystals with white glints
    ic.poly([[3, 12], [5, 5], [8, 3], [9, 11]], 0x4a3a30);
    ic.poly([[8, 13], [9, 6], [12, 4], [14, 12]], 0x2a211c);
    ic.poly([[5, 14], [7, 9], [10, 13]], 0x3a2e26);
    ic.jitter(rng, 0.06);
    ic.set(6, 5, 0xffffff);
    ic.set(11, 5, 0xf4f4f4);
    ic.set(8, 10, 0xe8e8e8);
  },
  hematite(ic, rng) {
    // kidney ore: rounded grey-red bubbles with a metallic sheen and a red streak
    const pal = { base: 0x5a2a26, dark: 0x3a1a18, light: 0x9a9aa4 };
    paintLump(ic, rng, 6, 9, 3.6, 3.6, pal);
    paintLump(ic, rng, 10.5, 8, 3.8, 3.8, pal);
    paintLump(ic, rng, 8.5, 12, 3.2, 2.6, pal);
    ic.line(5, 12, 9, 12, 0xa83a2a);
  },
  gold_nugget(ic, rng) {
    paintLump(ic, rng, 8, 9, 5.2, 4.4, { base: 0xe8c34a, dark: 0xa8822a, light: 0xfff0a0 });
    ic.set(6, 7, 0xffffff);
    ic.set(10, 10, 0x8a6a1a);
  },
  rough_gem(ic) {
    // a pale cyan crystal still in a bit of grey host rock
    ic.poly([[2, 14], [4, 11], [12, 11], [14, 14]], 0x7a7670);
    ic.poly([[5, 11], [6, 4], [8, 1], [10, 4], [11, 11]], (x) => (x < 8 ? 0x9ff0f0 : 0x4fb8c8));
    ic.line(8, 2, 8, 10, 0xd8ffff);
    ic.set(7, 4, 0xffffff);
  },
  copper_ingot(ic, rng) {
    paintBar(ic, rng, tierPal(3));
  },
  tin_ingot(ic, rng) {
    paintBar(ic, rng, { base: 0xb4b8be, dark: 0x7c8088, light: 0xe2e6ea });
  },
  bronze_ingot(ic, rng) {
    paintBar(ic, rng, tierPal(4));
  },
  iron_bloom(ic, rng) {
    // a spongy lump of iron and slag, full of holes
    paintLump(ic, rng, 8, 9, 6, 5.2, { base: 0x4a4a50, dark: 0x2a2a2e, light: 0x7a7a84 });
    for (const [x, y] of [[5, 8], [9, 7], [7, 11], [11, 10], [6, 6]]) ic.set(x, y, 0x121214);
    speckle(ic, rng, 4, 0x7a5a3a);
  },
  wrought_iron(ic, rng) {
    // a hexagonal bar with hammer marks
    paintBar(ic, rng, tierPal(5), (b) => {
      for (const x of [5, 8, 11]) b.set(x, 7, tone(tierPal(5).dark, -0.1));
    });
  },
  steel_bar(ic, rng) {
    paintBar(ic, rng, tierPal(6), (b) => {
      b.set(6, 5, 0x7fb2ff);
      b.set(7, 5, 0x7fb2ff);
    });
  },
  rawhide(ic, rng) {
    // a stretched, uneven hide
    ic.poly([[2, 4], [6, 2], [10, 3], [14, 2], [13, 8], [15, 13], [9, 12], [4, 14], [3, 9]], 0xd9b48f);
    ic.jitter(rng, 0.05);
    speckle(ic, rng, 6, 0xb08a64);
  },
  leather(ic) {
    // a folded sheet of tanned leather with a stitched edge
    ic.poly([[2, 4], [13, 3], [14, 12], [3, 13]], 0x8a5530);
    ic.poly([[2, 4], [13, 3], [12, 7], [3, 8]], 0xa66a3e);
    for (let x = 4; x <= 12; x += 2) ic.set(x, 11, 0xe0c090);
  },
  salt(ic, rng) {
    // a little heap of salt crystals
    ic.poly([[2, 13], [6, 7], [9, 5], [12, 8], [14, 13]], (x) => (x < 8 ? 0xf4f4f0 : 0xd8dce0));
    ic.jitter(rng, 0.04);
    ic.set(8, 6, 0xffffff);
    ic.set(5, 10, 0xffffff);
    ic.set(11, 11, 0xb8bcc4);
  },
  ice_chunk(ic) {
    ic.poly([[3, 12], [4, 5], [9, 2], [14, 6], [12, 13]], (x, y) => (x + y < 11 ? 0xe4f6ff : x > 10 ? 0x7fb8dc : 0xbfe3f5));
    ic.line(6, 5, 8, 10, 0xffffff);
    ic.set(10, 4, 0xffffff);
  },
  grave_rag(ic, rng) {
    // a grey-green tattered cloth with a ragged hem and stains
    ic.poly([[3, 2], [13, 3], [13, 12], [3, 12]], 0x8a8f78);
    for (let x = 3; x <= 13; x++) if ((x * 7) % 3 !== 0) ic.set(x, 13, 0x8a8f78);
    for (const x of [4, 7, 10]) ic.clear(x, 12);
    speckle(ic, rng, 6, 0x5f6450);
    ic.set(6, 5, 0x6a5a40);
    ic.set(7, 5, 0x6a5a40);
  },
  glass_shards(ic) {
    ic.poly([[2, 13], [4, 6], [7, 12]], 0xcdeef0);
    ic.poly([[7, 9], [9, 2], [12, 8]], 0xbfe6ea);
    ic.poly([[10, 14], [12, 10], [14, 14]], 0xd8f4f6);
    ic.set(4, 8, 0xffffff);
    ic.set(9, 4, 0xffffff);
  },
  unpeeled_cactus_fruit(ic) {
    // a red-purple tuna, barrel-shaped with a sunken navel, studded with areoles carrying yellow glochid tufts
    ic.ellipse(8, 8.6, 4.6, 6.2, (x, y, u) => (u < -0.4 ? 0xc04a78 : u > 0.5 ? 0x7a1e44 : 0xa02a5a));
    ic.rect(6, 2, 9, 2, 0x5a1a34);
    ic.set(7, 3, 0x3a1020);
    ic.set(8, 3, 0x3a1020);
    for (const [x, y] of [[5, 6], [9, 5], [11, 9], [6, 11], [9, 13], [7, 8]]) {
      ic.set(x, y, 0x6a4a2a);
      ic.set(x + 1, y, 0xf0e070);
      ic.set(x, y - 1, 0xf0e070);
    }
  },
  greenware_pot(ic, rng) {
    paintPot(ic, rng, 0xc9b99a, 0x5a5040);
  },
  green_brick(ic, rng) {
    paintBrick(ic, rng, 0xc9b99a);
  },
  fired_brick(ic, rng) {
    paintBrick(ic, rng, 0xa5452e);
  },
  greenware_crucible(ic, rng) {
    paintCrucible(ic, rng, 0xc9b99a, 0x5a5040);
  },
  greenware_mold(ic, rng) {
    paintMold(ic, rng, 0xc9b99a);
  },
  bellows(ic) {
    // two pear-shaped boards with pleated leather between and a nozzle pointing down
    ic.poly([[3, 3], [13, 3], [12, 9], [9, 12], [7, 12], [4, 9]], 0x8a5530);
    for (let y = 4; y <= 9; y += 2) ic.line(4, y, 12, y, 0x6a3e22);
    ic.rect(3, 2, 13, 2, WOOD.light);
    ic.rect(4, 3, 12, 3, WOOD.base);
    ic.rect(7, 13, 8, 15, 0x5c6066);
    ic.set(7, 13, 0x8a8f96);
    ic.set(8, 2, 0x5e3b1a);
  },
  clay_pot(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0x3a1a10);
  },
  salt_pot(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0xf4f4f0, 0xd8dce0);
    ic.set(4, 7, 0xf4f4f0);
    ic.set(12, 9, 0xf4f4f0);
  },
  pot_snow(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0xf4f8fc, 0xc8d8e8);
    ic.ellipse(8, 2.6, 3.4, 1.8, 0xf4f8fc); // heaped above the rim
  },
  handbook(ic, rng) {
    // §14 the Survival Handbook: a small leather-bound field book tied with cord, a hex burned into its cover
    const page = (i) => (i & 1 ? 0xeadcb8 : 0xcfbc90);
    for (let y = 2; y <= 14; y++) ic.set(13, y, page(y)); // the page block, at the fore-edge …
    for (let x = 3; x <= 13; x++) ic.set(x, 14, page(x)); // … and the foot
    ic.rect(2, 1, 12, 13, LEATHER.base);
    ic.line(4, 1, 12, 1, LEATHER.light);
    ic.line(12, 2, 12, 13, LEATHER.dark);
    ic.line(4, 13, 11, 13, LEATHER.dark);
    ic.rect(2, 1, 3, 13, LEATHER.spine); // the spine, with two raised bands
    for (const y of [3, 11]) {
      ic.set(2, y, LEATHER.light);
      ic.set(3, y, LEATHER.base);
    }
    ic.jitter(rng, 0.05);
    // the hex, burned in: a scorched face inside a charred pointy-top outline
    ic.rect(6, 3, 9, 6, 0x5e331a);
    for (const [x, y] of [[7, 2], [8, 2], [5, 3], [6, 3], [9, 3], [10, 3], [5, 4], [10, 4], [5, 5], [10, 5], [5, 6], [6, 6],
      [9, 6], [10, 6], [7, 7], [8, 7]]) ic.set(x, y, 0x26130a);
    ic.set(7, 4, 0x8a4a22); // an ember-brown glint where the brand bit deepest
    // the cord: once round the cover, knotted at the fore-edge, its ends hanging
    for (let x = 2; x <= 12; x++) ic.set(x, 10, x & 1 ? CORD.light : CORD.dark);
    ic.set(13, 9, CORD.light);
    ic.set(13, 10, CORD.dark);
    ic.set(13, 11, CORD.light);
    ic.set(14, 10, CORD.light);
    ic.set(14, 12, CORD.dark);
    ic.set(14, 13, CORD.light);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Food and drink
// ---------------------------------------------------------------------------------------------------------------

/** A slab of meat with a fat edge. */
function paintMeat(ic, rng, meat, fat, edge) {
  ic.poly([[2, 6], [6, 3], [13, 4], [14, 10], [10, 13], [3, 12]], meat);
  ic.line(2, 6, 6, 3, fat);
  ic.line(6, 3, 13, 4, fat);
  ic.jitter(rng, 0.06);
  if (edge !== undefined) {
    ic.line(14, 10, 10, 13, edge);
    ic.line(10, 13, 3, 12, edge);
  }
}

/** A tuber shape: a knobbly oval. */
function paintTuberShape(ic, rng, skin) {
  paintLump(ic, rng, 8, 9, 6, 4.2, { base: skin, dark: tone(skin, -0.3), light: tone(skin, 0.25) });
}

/** @type {Record<string, (ic: Icon, rng: Rng) => void>} */
const FOOD_PAINTERS = {
  honeyberries(ic) {
    // elongated dusky-blue berries with a pale bloom on a twig (Lonicera caerulea)
    ic.line(4, 2, 11, 3, 0x6b4a2a);
    ic.set(12, 2, 0x4a7a3a);
    ic.set(13, 2, 0x4a7a3a);
    for (const [cx, cy] of [[5, 8], [9.5, 7], [7, 12], [11.5, 12]]) {
      ic.ellipse(cx, cy, 1.9, 3, (x, y, u) => (u < -0.3 ? 0x5b6bb0 : 0x3b4a8a));
      ic.set(Math.floor(cx) - 1, Math.floor(cy) - 2, 0x9aa6d6);
    }
  },
  acorns(ic) {
    for (const [cx, cy] of [[5.5, 9], [10.5, 8]]) {
      ic.ellipse(cx, cy + 2, 2.6, 3.4, (x, y, u) => (u < -0.3 ? 0xc0823e : 0xa0662e));
      ic.ellipse(cx, cy - 0.6, 3, 1.8, (x, y) => ((x + y) & 1 ? 0x6b4a2a : 0x84603a));
      ic.set(Math.floor(cx), Math.floor(cy) - 3, 0x5e3b1a);
    }
  },
  leached_acorns(ic) {
    // shelled, soaked kernels: pale and capless, with a wet sheen
    for (const [cx, cy] of [[5, 6], [10, 7], [6.5, 11.5], [11, 12]]) {
      ic.ellipse(cx, cy, 2.2, 2.6, 0xd9c08a);
      ic.set(Math.floor(cx) - 1, Math.floor(cy) - 1, 0xfff4d8);
    }
  },
  roasted_acorns(ic) {
    for (const [cx, cy] of [[5, 6], [10, 7], [6.5, 11.5], [11, 12]]) {
      ic.ellipse(cx, cy, 2.2, 2.6, 0x7a4a22);
      ic.set(Math.floor(cx) - 1, Math.floor(cy) - 1, 0xb07a42);
      ic.set(Math.floor(cx) + 1, Math.floor(cy) + 1, 0x3a2010);
    }
  },
  pine_nuts(ic) {
    for (const [x, y] of [[4, 4], [9, 3], [12, 7], [6, 8], [3, 12], [9, 11], [12, 13]]) {
      ic.set(x, y, 0xf0e2b8);
      ic.set(x, y + 1, 0xe0cc98);
      ic.set(x + 1, y + 1, 0xc8b07a);
    }
  },
  wild_tuber(ic, rng) {
    paintTuberShape(ic, rng, 0x8a5a34);
    for (const [x, y] of [[5, 8], [9, 7], [11, 10], [7, 11]]) ic.set(x, y, 0x4a2c16);
    ic.line(13, 11, 15, 14, 0x6b4a2a);
  },
  baked_tuber(ic, rng) {
    paintTuberShape(ic, rng, 0x6a3e1e);
    // split open: golden flesh
    ic.ellipse(8, 8.4, 4, 1.8, 0xe8c05a);
    ic.set(6, 8, 0xfff0a0);
    ic.set(10, 8, 0xc8902a);
  },
  cattail_root(ic) {
    // a pale rhizome in segments, with rootlets at the nodes
    ic.rect(2, 7, 13, 9, 0xe0d4b0);
    ic.rect(2, 7, 13, 7, 0xf0e8cc);
    for (const x of [5, 9, 13]) {
      ic.rect(x, 7, x, 9, 0xb8a882);
      ic.set(x, 10, 0x9a8a68);
      ic.set(x - 1, 11, 0x9a8a68);
    }
    ic.set(14, 8, 0xc8bc98);
  },
  roasted_cattail_root(ic) {
    ic.rect(2, 7, 13, 9, 0xb0763a);
    ic.rect(2, 7, 13, 7, 0xd09a5a);
    for (const x of [5, 9, 13]) ic.rect(x, 7, x, 9, 0x6a3e1e);
    ic.set(7, 8, 0x3a2010);
    ic.set(11, 9, 0x3a2010);
  },
  cactus_fruit(ic) {
    // peeled: deep magenta skin cut open over pink flesh and dark seeds
    ic.ellipse(8, 9, 5, 5.6, 0xc02a5a);
    ic.ellipse(8.4, 8.6, 3.2, 3.6, 0xe88aa8);
    for (const [x, y] of [[7, 8], [9, 7], [8, 10], [10, 9]]) ic.set(x, y, 0x3a1020);
  },
  raw_pork(ic, rng) {
    paintMeat(ic, rng, 0xe08a8a, 0xf4e4d8);
    ic.line(5, 8, 11, 7, 0xf4c8c0);
  },
  roast_pork(ic, rng) {
    paintMeat(ic, rng, 0xa0582a, 0xd09050, 0x6a3418);
    ic.set(7, 6, 0xf0c080);
    ic.set(9, 9, 0xf0c080);
  },
  charred_meat(ic, rng) {
    paintMeat(ic, rng, 0x3a2418, 0x2a1810, 0x1a0e08);
    ic.line(5, 8, 11, 7, 0x5a3a24);
    ic.set(8, 10, 0x6a4a30);
  },
  salted_pork(ic, rng) {
    paintMeat(ic, rng, 0xc8908a, 0xece4dc);
    speckle(ic, rng, 9, 0xffffff);
  },
  pig_fat(ic, rng) {
    paintLump(ic, rng, 8, 9, 5.6, 4.4, { base: 0xf0e6d0, dark: 0xd0c09a, light: 0xffffff });
    ic.line(5, 10, 11, 9, 0xe8d4a8);
  },
  snow(ic, rng) {
    // a packed snowball heap
    paintLump(ic, rng, 8, 9.5, 5.6, 4.6, { base: 0xf4f8fc, dark: 0xc8d8e8, light: 0xffffff });
    ic.set(10, 7, 0xa8c4e0);
    ic.set(5, 11, 0xa8c4e0);
  },
  pot_water(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0x3a7bd5, 0x8ab8f0);
  },
  pot_boiled(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0x6aa8e8, 0xd8ecff);
    // steam over the rim
    for (const [x, y] of [[6, 1], [7, 0], [10, 1], [9, 0]]) ic.set(x, y, 0xf0f4f8);
  },
  pot_seawater(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0x2f9e8f, 0x7ad8c8);
  },
  pot_sap(ic, rng) {
    paintPot(ic, rng, 0xb8613a, 0xd9a441, 0xf4d488);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Bandages and clothes
// ---------------------------------------------------------------------------------------------------------------

/** A rolled bandage: a roll seen end-on, with a tail strip. */
function paintRoll(ic, cloth, stripe) {
  ic.rect(2, 10, 9, 12, cloth);
  ic.rect(2, 10, 9, 10, tone(cloth, 0.2));
  ic.ellipse(10.5, 7.5, 4, 4.4, tone(cloth, -0.08));
  ic.ellipse(10.5, 7.5, 2.6, 2.9, cloth);
  ic.ellipse(10.5, 7.5, 1.2, 1.3, tone(cloth, -0.35));
  ic.line(3, 11, 8, 11, stripe);
}

/** @type {Record<string, (ic: Icon, rng: Rng) => void>} */
const OTHER_PAINTERS = {
  fibre_bandage(ic) {
    paintRoll(ic, 0xb8b07a, 0x8a8a4a);
  },
  rag_bandage(ic) {
    paintRoll(ic, 0xe8e4d8, 0xb8c8c0);
  },
  straw_hat(ic) {
    // a wide-brimmed straw hat with a dark band
    ic.ellipse(8, 10.5, 7.4, 2.4, (x, y) => ((x + y) & 1 ? 0xd8b860 : 0xc0a048));
    ic.poly([[5, 10], [5.5, 5], [7, 4], [9, 4], [10.5, 5], [11, 10]], (x, y) => ((x + y * 2) % 3 === 0 ? 0xc0a048 : 0xe4c870));
    ic.rect(5, 8, 10, 8, 0x8a5a2b);
  },
  leather_hood(ic) {
    // a hood with a dark face opening, draping to the shoulders
    ic.poly([[3, 15], [3, 7], [5, 3], [8, 1.5], [11, 3], [13, 7], [13, 15]], 0x7a4a2a);
    ic.ellipse(8, 8.5, 3, 3.6, 0x2a1810);
    ic.line(4, 6, 6, 3, 0x9a6a40);
    ic.rect(3, 14, 13, 14, 0x5e3a20);
  },
  grass_cape(ic) {
    // a fringed cape of grass strands tied at the neck with cord
    ic.poly([[6, 2], [10, 2], [14, 13], [2, 13]], 0x8aa04a);
    for (let x = 3; x <= 13; x += 2) ic.line(x === 3 ? 4 : x, 6, x, 14, (x & 2) ? 0x6f8f3a : 0xb0b860);
    ic.rect(6, 2, 10, 2, CORD.light);
    ic.set(8, 3, CORD.dark);
  },
  leather_coat(ic) {
    // shoulders, sleeves and a laced front
    ic.poly([[5, 2], [11, 2], [14, 6], [14, 11], [12, 11], [12, 15], [4, 15], [4, 11], [2, 11], [2, 6]], 0x8a5530);
    ic.line(8, 3, 8, 15, 0x5e3a20);
    for (let y = 5; y <= 13; y += 2) {
      ic.set(7, y, 0xe0c090);
      ic.set(9, y, 0xe0c090);
    }
    ic.rect(6, 2, 10, 2, 0x5e3a20);
  },
  hide_shoes(ic) {
    // a pair of hide shoes with grass lining at the openings
    for (const ox of [0, 8]) {
      ic.poly([[ox + 1, 8], [ox + 4, 7], [ox + 5, 11], [ox + 7, 12], [ox + 7, 14], [ox + 1, 14]], 0x7a5030);
      ic.rect(ox + 1, 7, ox + 4, 7, 0x8aa04a);
      ic.set(ox + 2, 6, 0xb0b860);
      ic.line(ox + 1, 14, ox + 7, 14, 0x4a2e18);
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Registry of painters
// ---------------------------------------------------------------------------------------------------------------

/**
 * The tool rows (key → [type, tier]), copied from items.js §5.1 so this module stays import-free. itemArt.test.js checks
 * that every non-block key of ITEMS has art and that these types and tiers agree with ITEMS.
 * @type {Readonly<Record<string, readonly [string, number]>>}
 */
const TOOL_ART = Object.freeze({
  hammerstone: ['hammer', 1], stone_chopper: ['axe', 1], digging_stick: ['spade', 1],
  flint_knife: ['knife', 2], flint_axe: ['axe', 2], flint_pick: ['pick', 2], flint_spade: ['spade', 2], flint_spear: ['spear', 2],
  copper_knife: ['knife', 3], copper_axe: ['axe', 3], copper_pick: ['pick', 3], copper_spade: ['spade', 3], copper_hammer: ['hammer', 3],
  bronze_knife: ['knife', 4], bronze_axe: ['axe', 4], bronze_pick: ['pick', 4], bronze_spade: ['spade', 4], bronze_hammer: ['hammer', 4],
  bronze_sword: ['sword', 4],
  iron_knife: ['knife', 5], iron_axe: ['axe', 5], iron_pick: ['pick', 5], iron_spade: ['spade', 5], iron_hammer: ['hammer', 5],
  iron_sword: ['sword', 5],
  steel_knife: ['knife', 6], steel_axe: ['axe', 6], steel_pick: ['pick', 6], steel_spade: ['spade', 6], steel_hammer: ['hammer', 6],
  steel_sword: ['sword', 6],
  fire_drill: ['firestarter', 0], crucible: ['crucible', 0], casting_mold: ['mold', 0],
});

/** Every key with art, in the order of items.js ITEM_KEYS (tools, materials, food, bandages, clothes). */
export const ITEM_ART_KEYS = Object.freeze([
  ...Object.keys(TOOL_ART),
  ...Object.keys(MATERIAL_PAINTERS),
  ...Object.keys(FOOD_PAINTERS),
  ...Object.keys(OTHER_PAINTERS),
]);

const ART_KEY_SET = new Set(ITEM_ART_KEYS);

/** @param {string} key @returns {boolean} the key has its own icon here (block items are drawn from the atlas) */
export function hasItemArt(key) {
  return typeof key === 'string' && ART_KEY_SET.has(key);
}

/** The tool's art type and tier, or null for a non-tool. @param {string} key @returns {readonly [string, number]|null} */
export function toolArtOf(key) {
  return Object.hasOwn(TOOL_ART, key) ? TOOL_ART[key] : null;
}

/**
 * Paint the 16×16 icon of a non-block item.
 * @param {string} key  an item key (items.js); anything without art paints the magenta/black checker
 * @returns {Uint8ClampedArray} 16*16*4 RGBA bytes, alpha 0 or 255
 */
export function paintItem(key) {
  const ic = new Icon();
  if (!hasItemArt(key)) {
    paintMissing(ic);
    return ic.px;
  }
  const rng = mulberry32(fnv1a('item:' + key));
  const tool = toolArtOf(key);
  if (tool) paintTool(ic, rng, key, tool[0], tool[1]);
  else (MATERIAL_PAINTERS[key] || FOOD_PAINTERS[key] || OTHER_PAINTERS[key])(ic, rng);
  ic.outline();
  return ic.px;
}

/** The 'missing' checker the icon sheet uses for unknown keys. @returns {Uint8ClampedArray} */
export function paintMissingItem() {
  const ic = new Icon();
  paintMissing(ic);
  return ic.px;
}
