// paintKit.js (PURE): textures painted in code — deterministic from a seed, every byte in range, every stroke clipped
// to its rectangle; the atlas packs and bleeds; faces are cheerful (or spooky without red).
import { describe, it, expect } from 'vitest';
import {
  createImage, Painter, Atlas, bleed, paintFace, hash2, makeRng, noise2, fbm, mix, shade, rgbOf, hexOf, EYE_WHITE,
} from '../../src/paintKit.js';

const RAMP = [0x9fd07a, 0x6fa84c, 0x467a2e, 0x2a4c1c];

/** Paint one of everything into a 96 × 64 rectangle of a 128 × 96 image. */
function paintAll(seed) {
  const img = createImage(128, 96);
  const p = new Painter(img, [16, 16, 96, 64], seed);
  p.cloth(RAMP).denim(RAMP).knit(RAMP).plaid(RAMP).skin(RAMP).fur(RAMP, { dir: [0.3, 1] }).wool(RAMP).leaves(RAMP).bark(RAMP)
    .hair(RAMP, { sheen: 0.3 }).stone(RAMP).grass(RAMP).feathers(RAMP, { size: 6 }).scales(RAMP, { size: 4 });
  p.shadeV(1.1, 0.8).ao({ top: 0.3, bottom: 0.4, left: 0.2, right: 0.2 }).mottle(0.1);
  p.ellipse(20, 20, 6, 4, 0xffffff, 1, 0.4).line(0, 0, 95, 63, 1.2, 0x000000).arc(50, 30, 10, 0, Math.PI, 0.8, 0x223344)
    .glow(70, 40, 12, 0xff8899, 0.6).stitches(5, 50, 90, 50, 0xeeeeee).seam(10, 0, 10, 63, RAMP).hem(56, 5, RAMP)
    .tear(40, 30, 4, RAMP).patch(60, 10, 12, 10, RAMP, 0xffffff);
  p.ragged({ edge: 'bottom', depth: 5 });
  return img;
}

describe('numbers', () => {
  it('hashes, noise and fractal noise stay in [0, 1) and repeat', () => {
    for (let i = 0; i < 500; i++) {
      const x = (i * 7.31) % 41;
      const y = (i * 3.17) % 23;
      for (const v of [hash2(i, i * 3, 5), noise2(x, y, 2), fbm(x, y, 9, 4)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
      expect(noise2(x, y, 2)).toBe(noise2(x, y, 2));
    }
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it('mixes and shades colours', () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(hexOf(127.5, 127.5, 127.5));
    expect(mix(0x102030, 0x102030, 0.7)).toBe(0x102030);
    expect(shade(0x808080, 0.5)).toBe(0x404040);
    expect(shade(0x808080, 2)).toBe(0xffffff);
    expect(shade(0x808080, 1)).toBe(0x808080);
    expect(rgbOf(0x123456)).toEqual([0x12, 0x34, 0x56]);
    expect(hexOf(-5, 300, 12.4)).toBe(0x00ff0c);
  });
});

describe('the painter', () => {
  it('paints the same bytes every time from the same seed, other bytes from another', () => {
    const a = paintAll(7);
    const b = paintAll(7);
    const c = paintAll(8);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
  });

  it('keeps every byte in range and never paints outside its rectangle', () => {
    const img = paintAll(3);
    expect(img.data).toBeInstanceOf(Uint8ClampedArray);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const inside = x >= 16 && x < 112 && y >= 16 && y < 80;
        if (!inside) expect(img.data[i] + img.data[i + 1] + img.data[i + 2] + img.data[i + 3]).toBe(0);
      }
    }
    for (const v of img.data) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it('fills opaque, and tears a ragged edge clear', () => {
    const img = createImage(32, 32);
    const p = new Painter(img, [0, 0, 32, 32], 5).cloth(RAMP);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
    p.ragged({ edge: 'bottom', depth: 6, period: 3 });
    const bottom = [...Array(32).keys()].map((x) => img.data[(31 * 32 + x) * 4 + 3]);
    expect(bottom.some((a) => a === 0)).toBe(true);
    expect(img.data[(0 * 32 + 5) * 4 + 3]).toBe(255); // the top row untouched
  });

  it('shades down the rectangle and darkens toward an occluded edge', () => {
    const img = createImage(8, 40, 0x808080);
    new Painter(img).shadeV(1.2, 0.6);
    expect(img.data[0]).toBeGreaterThan(img.data[(39 * 8) * 4]);
    const img2 = createImage(40, 8, 0x808080);
    new Painter(img2).ao({ left: 0.6, width: 0.3 });
    expect(img2.data[0]).toBeLessThan(img2.data[39 * 4]);
    expect(img2.data[39 * 4]).toBe(0x80);
  });

  it('draws soft-edged shapes: full inside, partial at the rim, nothing far away', () => {
    const img = createImage(32, 32, 0x000000);
    new Painter(img).ellipse(16, 16, 8, 8, 0xffffff);
    const at = (x, y) => img.data[(y * 32 + x) * 4];
    expect(at(16, 16)).toBe(255);
    expect(at(1, 1)).toBe(0);
    const rim = [...Array(32).keys()].map((x) => at(x, 16)).filter((v) => v > 0 && v < 255);
    expect(rim.length).toBeGreaterThan(0);
  });
});

describe('feathers and scales (§69.1)', () => {
  it('feathers cover the rectangle in staggered tips, each with a pale fringe; scales draw rims over what is there', () => {
    const img = createImage(48, 48);
    const p = new Painter(img, [0, 0, 48, 48], 3);
    p.feathers([0xf0e0c0, 0x9a7a52, 0x4a3a28], { size: 8, edge: 0xffffff });
    let opaque = 0;
    const tones = new Set();
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] === 255) opaque++;
      tones.add(img.data[i] >> 4);
    }
    expect(opaque).toBe(48 * 48); // every pixel painted
    expect(tones.size).toBeGreaterThan(5); // shafts, fringes, shadows: not a flat fill
    const before = img.data.slice();
    p.scales([0xffffff, 0x808080, 0x000000], { size: 4 });
    let changed = 0;
    for (let i = 0; i < img.data.length; i++) if (img.data[i] !== before[i]) changed++;
    expect(changed).toBeGreaterThan(img.data.length * 0.1);
  });
});

describe('faces', () => {
  const SKIN = [0xd5b086, 0xc49c6e, 0xab845b, 0x8e6b48];

  it('a kid\'s face has the whites of its eyes, an iris of its own colour and a catchlight', () => {
    const img = createImage(56, 60);
    const p = new Painter(img, [0, 0, 56, 60], 1).skin(SKIN);
    paintFace(p, { skin: SKIN, eyes: [0x6e958f, 0x41605b], brows: 0x7d6036, mouth: 0x9c4b40, blush: 0xd29778 });
    let light = 0;
    let iris = 0;
    const [ir, ig, ib] = [0x6e, 0x95, 0x8f];
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, bb] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (Math.min(r, g, bb) > 225) light++;
      if (Math.abs(r - ir) < 12 && Math.abs(g - ig) < 12 && Math.abs(bb - ib) < 12) iris++;
    }
    expect(light).toBeGreaterThan(2); // the whites and the catchlights
    expect(iris).toBeGreaterThan(4);
    expect(EYE_WHITE).toBeGreaterThan(0xf0f0f0);
  });

  it('a zombie\'s face is spooky, not frightening: dark slits, nothing red, no white eyes', () => {
    const skin = [0xb0bfa8, 0xa5b59d, 0x97a890, 0x4d5b4a];
    const img = createImage(48, 52);
    const p = new Painter(img, [0, 0, 48, 52], 1).skin(skin);
    paintFace(p, { kind: 'zombie', skin, brows: 0x2c231d });
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      expect(r > g + 40 && r > b + 40).toBe(false);
      expect(r > 240 && g > 240 && b > 240).toBe(false);
      if (r + g + b < 90) dark++;
    }
    expect(dark).toBeGreaterThan(4);
  });
});

describe('the atlas', () => {
  it('packs rectangles without overlap, inside the image, with a gutter', () => {
    const atlas = new Atlas(64, 64, 2);
    const rects = [[20, 10], [30, 12], [10, 10], [40, 8], [12, 12]].map(([w, h]) => atlas.alloc(w, h));
    for (const r of rects) {
      expect(r[0]).toBeGreaterThanOrEqual(2);
      expect(r[1]).toBeGreaterThanOrEqual(2);
      expect(r[0] + r[2]).toBeLessThanOrEqual(62);
      expect(r[1] + r[3]).toBeLessThanOrEqual(62);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        const apart = a[0] + a[2] + 2 <= b[0] || b[0] + b[2] + 2 <= a[0] || a[1] + a[3] + 2 <= b[1] || b[1] + b[3] + 2 <= a[1];
        expect(apart).toBe(true);
      }
    }
    expect(atlas.used()).toBe(20 * 10 + 30 * 12 + 10 * 10 + 40 * 8 + 12 * 12);
    expect(() => atlas.alloc(100, 4)).toThrow(RangeError);
  });

  it('bleeds a rectangle\'s edge pixels out into its gutter', () => {
    const img = createImage(16, 16);
    new Painter(img, [4, 4, 6, 6]).fill((x, y) => (x === 0 ? 0xff0000 : y === 5 ? 0x00ff00 : 0x0000ff));
    bleed(img, [4, 4, 6, 6], 2);
    const px = (x, y) => (img.data[(y * 16 + x) * 4] << 16) | (img.data[(y * 16 + x) * 4 + 1] << 8) | img.data[(y * 16 + x) * 4 + 2];
    expect(px(2, 6)).toBe(0xff0000); // left of the red column
    expect(px(7, 11)).toBe(0x00ff00); // below the green row
    expect(img.data[(2 * 16 + 2) * 4 + 3]).toBe(255); // the corner too
    expect(img.data[(0 * 16 + 0) * 4 + 3]).toBe(0); // beyond the gutter: untouched
  });
});
