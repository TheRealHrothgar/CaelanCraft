// circuitTiles.js — the powder-and-circuits tile art and the repainted Powder Keg (docs/DESIGN-circuits.md §1.4, §3.5,
// §6.2.9, §7 C). The painters run through tiles.paintTile exactly as the atlas runs them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CIRCUIT_TILE_NAMES, CIRCUIT_RECIPES, CIRCUIT_FLAT_TILES } from '../../src/circuitTiles.js';
import { paintTile, TILE_NAMES } from '../../src/tiles.js';
import { TILE, BLOCKS, getFaceTile, FACE_TOP } from '../../src/blocks.js';

const BYTES = 16 * 16 * 4;
const CIRCUIT_IDS = Object.keys(CIRCUIT_TILE_NAMES).map(Number);
const KEG_IDS = [TILE.BARREL_SIDE, TILE.BARREL_TOP];
const ALL = [...CIRCUIT_IDS, ...KEG_IDS];
const FLAT = [TILE.POWDER_FUSE, TILE.TORCH, TILE.COPPER_WIRE, TILE.BROWN_WIRE, TILE.WHITE_WIRE, TILE.EARTH_WIRE];
const CABINETS = CIRCUIT_IDS.filter((t) => t !== TILE.CIRCUIT_CLEAR && !FLAT.includes(t));
/** FNV-1a of the v0.8 painters' output (before §3.5's repaint), recorded when package C started. */
const OLD_HASH = Object.freeze({ [TILE.BARREL_SIDE]: 0xc2b6fbee, [TILE.BARREL_TOP]: 0xd2c176e8 });

const idx = (x, y) => (y * 16 + x) * 4;
const rgba = (px, x, y) => [px[idx(x, y)], px[idx(x, y) + 1], px[idx(x, y) + 2], px[idx(x, y) + 3]];
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function fnv(px) {
  let h = 0x811c9dc5;
  for (const b of px) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @returns {{ hue: number, sat: number, val: number }} hue in degrees, saturation and value 0..1 (HSV) */
function hsv(r, g, b) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    hue = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, sat: max === 0 ? 0 : d / max, val: max };
}

/** Every opaque pixel of tile t as [r, g, b, x, y]. */
function opaque(t) {
  const px = paintTile(t);
  const out = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (px[idx(x, y) + 3] > 0) out.push([...rgba(px, x, y).slice(0, 3), x, y]);
  return out;
}

describe('circuit tile set (§1.4, §6.2.9)', () => {
  it('every CIRCUIT_TILE_NAMES entry has a recipe; CIRCUIT_RECIPES is exactly those plus barrel_side and barrel_top', () => {
    expect(CIRCUIT_IDS).toEqual(Array.from({ length: 35 }, (_, i) => 160 + i));
    for (const name of Object.values(CIRCUIT_TILE_NAMES)) expect(typeof CIRCUIT_RECIPES[name], name).toBe('function');
    expect(Object.keys(CIRCUIT_RECIPES).sort()).toEqual([...Object.values(CIRCUIT_TILE_NAMES), 'barrel_side', 'barrel_top'].sort());
    expect(Object.isFrozen(CIRCUIT_RECIPES) && Object.isFrozen(CIRCUIT_TILE_NAMES) && Object.isFrozen(CIRCUIT_FLAT_TILES)).toBe(true);
  });

  it('the flat pictures are exactly the THIN blocks\' top tiles', () => {
    const flatBlocks = BLOCKS.filter((b) => b.icon === 'flat');
    expect(flatBlocks).toHaveLength(6);
    expect(flatBlocks.map((b) => TILE_NAMES[getFaceTile(b.id, FACE_TOP)]).sort()).toEqual([...CIRCUIT_FLAT_TILES].sort());
    expect(FLAT.map((t) => TILE_NAMES[t]).sort()).toEqual([...CIRCUIT_FLAT_TILES].sort());
  });

  it('paints deterministically: twice through paintTile, and once more straight from the recipe with a fresh stream', () => {
    for (const t of ALL) {
      const a = paintTile(t);
      expect(a.length).toBe(BYTES);
      expect(sameBytes(a, paintTile(t)), TILE_NAMES[t]).toBe(true);
    }
    // A painter given the same stream twice paints the same bytes (it keeps no state between calls).
    const stream = (seed) => {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    };
    for (const [name, fn] of Object.entries(CIRCUIT_RECIPES)) {
      const a = new Uint8ClampedArray(BYTES);
      const b = new Uint8ClampedArray(BYTES);
      fn(a, stream(7));
      fn(b, stream(7));
      expect(sameBytes(a, b), name).toBe(true);
    }
  });

  it('is pure: no imports, no Math.random, no clock and no DOM', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/circuitTiles.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|document\.|window\./);
  });
});

describe('circuit tile alpha (§1.4)', () => {
  it('CIRCUIT_CLEAR is alpha 0 everywhere', () => {
    const px = paintTile(TILE.CIRCUIT_CLEAR);
    for (let i = 3; i < BYTES; i += 4) expect(px[i]).toBe(0);
  });

  it('the flat pictures have alpha-0 corners, at least 40 opaque pixels and no partial alpha', () => {
    for (const t of FLAT) {
      const px = paintTile(t);
      for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(px[idx(x, y) + 3], `${TILE_NAMES[t]} (${x},${y})`).toBe(0);
      let n = 0;
      for (let i = 3; i < BYTES; i += 4) {
        expect(px[i] === 0 || px[i] === 255, TILE_NAMES[t]).toBe(true);
        if (px[i] === 255) n++;
      }
      expect(n, TILE_NAMES[t]).toBeGreaterThanOrEqual(40);
      expect(n, TILE_NAMES[t]).toBeLessThan(200); // a picture on a clear background, not a filled tile
    }
  });

  it('the 28 cabinet tiles and both keg tiles are alpha 255 everywhere', () => {
    expect(CABINETS).toHaveLength(28);
    for (const t of [...CABINETS, ...KEG_IDS]) {
      const px = paintTile(t);
      for (let i = 3; i < BYTES; i += 4) expect(px[i], `${TILE_NAMES[t]} byte ${i}`).toBe(255);
    }
  });
});

describe('circuit tile art (§1.4, §3.5, §9)', () => {
  it('all 37 tiles differ pairwise, and both keg tiles differ from their v0.8 painters', () => {
    const painted = ALL.map((t) => [t, paintTile(t)]);
    for (let i = 0; i < painted.length; i++) {
      for (let j = i + 1; j < painted.length; j++) {
        expect(sameBytes(painted[i][1], painted[j][1]), `${TILE_NAMES[painted[i][0]]} vs ${TILE_NAMES[painted[j][0]]}`).toBe(false);
      }
    }
    for (const t of KEG_IDS) expect(fnv(paintTile(t)), TILE_NAMES[t]).not.toBe(OLD_HASH[t]);
  });

  it('no collapsar or circuit tile (nor the keg) has an opaque pixel with a hue of 250°–300° at saturation above 0.15', () => {
    for (const t of ALL) {
      for (const [r, g, b, x, y] of opaque(t)) {
        const { hue, sat } = hsv(r, g, b);
        if (sat <= 0.15) continue;
        expect(hue >= 250 && hue <= 300, `${TILE_NAMES[t]} (${x},${y}) hue ${hue.toFixed(0)}`).toBe(false);
      }
    }
  });

  it('no signal wire is red, blue, green or yellow (copper, brown and white are orange-brown or near-neutral)', () => {
    for (const t of [TILE.COPPER_WIRE, TILE.BROWN_WIRE, TILE.WHITE_WIRE]) {
      for (const [r, g, b, x, y] of opaque(t)) {
        const { hue, sat } = hsv(r, g, b);
        if (sat <= 0.3) continue; // porcelain, white braid, greys
        const banned = hue < 12 || hue > 340 || (hue >= 48 && hue <= 68) || (hue >= 75 && hue <= 165) || (hue >= 190 && hue <= 250);
        expect(banned, `${TILE_NAMES[t]} (${x},${y}) hue ${hue.toFixed(0)}`).toBe(false);
      }
    }
    // The earth wire is the one that is green and yellow.
    const earth = opaque(TILE.EARTH_WIRE).map(([r, g, b]) => hsv(r, g, b));
    expect(earth.some((c) => c.hue > 100 && c.hue < 140 && c.sat > 0.4)).toBe(true);
    expect(earth.some((c) => c.hue > 40 && c.hue < 60 && c.sat > 0.6)).toBe(true);
  });

  it('the flat pictures show their part: a dark tarred fuse with a pale twine wrap, a torch with a flame, a porcelain knob', () => {
    const fuse = opaque(TILE.POWDER_FUSE).map(([r, g, b]) => (r << 16) | (g << 8) | b);
    expect(fuse.filter((c) => c === 0x2b2420).length).toBeGreaterThan(20);
    expect(fuse).toContain(0xb8a77a);
    expect(fuse).toContain(0x8a8478); // the powder-grey frayed end
    const torch = opaque(TILE.TORCH).map(([r, g, b]) => (r << 16) | (g << 8) | b);
    expect(torch).toContain(0xff7a2a);
    expect(torch).toContain(0xffd27a);
    expect(torch).toContain(0x3a3d42); // iron
    expect(torch).toContain(0xc9a46a); // the ash staff
    const copper = opaque(TILE.COPPER_WIRE).map(([r, g, b]) => (r << 16) | (g << 8) | b);
    expect(copper).toContain(0xc8743a);
    expect(copper).toContain(0xe8e4da);
    expect(opaque(TILE.BROWN_WIRE).map(([r, g, b]) => (r << 16) | (g << 8) | b)).toContain(0x6b4226);
    expect(opaque(TILE.WHITE_WIRE).map(([r, g, b]) => (r << 16) | (g << 8) | b)).toContain(0xe8e2d0);
  });

  it('cabinet tops carry their working faces: the charge\'s pinprick, the timer\'s cream dial, the bell\'s nickel gong', () => {
    const lens = paintTile(TILE.COLLAPSAR_TOP);
    const centre = [rgba(lens, 7, 7), rgba(lens, 8, 8)];
    expect(centre.every(([r, g, b]) => r > 230 && g > 230 && b > 220)).toBe(true);
    expect(rgba(lens, 8, 5).slice(0, 3).every((v) => v < 30)).toBe(true); // the black lens round it
    const dial = paintTile(TILE.TIMER_TOP);
    const [r, g, b] = rgba(dial, 5, 9);
    expect(r > 200 && g > 190 && b > 160).toBe(true);
    const gong = paintTile(TILE.BELL_TOP);
    const [gr, gg, gb] = rgba(gong, 11, 9);
    expect(Math.min(gr, gg, gb)).toBeGreaterThan(150);
    expect(hsv(gr, gg, gb).sat).toBeLessThan(0.15); // nickel, not brass
  });
});

describe('the Powder Keg, repainted (§3.5)', () => {
  it('barrel_side: the same staves, copper hoops instead of iron bands, and a burnt-in brand instead of the red hazard sign', () => {
    const side = paintTile(TILE.BARREL_SIDE);
    for (const y of [1, 2, 3, 12, 13, 14]) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = rgba(side, x, y);
        const c = hsv(r, g, b);
        expect(c.hue > 12 && c.hue < 40 && c.sat > 0.4, `hoop (${x},${y})`).toBe(true); // copper, never iron grey
      }
    }
    const [hr, , hb] = rgba(side, 5, 1); // the hoop's highlight row
    expect(hr).toBeGreaterThan(180);
    expect(hr - hb).toBeGreaterThan(80);
    // No red hazard hexagon, no pale "!": every pixel between the hoops is a wood brown.
    for (let y = 4; y <= 11; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = rgba(side, x, y);
        expect(r > 150 && g < 80 && b < 80, `red (${x},${y})`).toBe(false);
        expect(r > 230 && g > 200, `pale (${x},${y})`).toBe(false);
        const c = hsv(r, g, b);
        expect(c.hue >= 15 && c.hue <= 40, `wood (${x},${y}) hue ${c.hue.toFixed(0)}`).toBe(true);
      }
    }
    // The brand: a dark burnt outline round (8, 7.5) with three dots, darker than the wood beside it.
    const brand = [rgba(side, 8, 4), rgba(side, 8, 5), rgba(side, 6, 9), rgba(side, 10, 9)];
    for (const [r, g, b] of brand) expect(r + g + b).toBeLessThan(0x3a + 0x24 + 0x12 + 40);
    const [wr] = rgba(side, 1, 8);
    expect(wr).toBeGreaterThan(110);
  });

  it('barrel_top: the plank lid with a copper rim and an unlit bung — no ember-coloured pixel anywhere', () => {
    const top = paintTile(TILE.BARREL_TOP);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = rgba(top, x, y);
        const c = hsv(r, g, b);
        const ember = r >= 225 && c.sat >= 0.55 && c.hue >= 10 && c.hue <= 55;
        expect(ember, `(${x},${y}) ${r},${g},${b}`).toBe(false);
      }
    }
    const rim = rgba(top, 8, 1); // 6.5 from the centre: the copper rim
    const c = hsv(rim[0], rim[1], rim[2]);
    expect(c.hue > 12 && c.hue < 40 && c.sat > 0.4).toBe(true);
    const bung = rgba(top, 8, 8);
    expect(bung[0]).toBeLessThan(160); // wood, not a glowing tip
    expect(rgba(top, 9, 6).slice(0, 3)).toEqual([0x2a, 0x24, 0x20]); // the dark cord stub
  });
});
