// zombieSkin.js — the zombies' pixel art (PURE). CONTRACTS §74.
import { describe, it, expect } from 'vitest';
import {
  paintZombieAtlas, PARTS, FACES, faceRect, SKIN_W, SKIN_H, SKIN_KINDS, ATLAS_W, ATLAS_H, SKIN_TEXEL, EYE_ROW, EYE_COLS,
  SLIT, EYE_GLOW, NIGHT_GLOW,
} from '../../src/zombieSkin.js';

const atlas = paintZombieAtlas();
const at = (sheet, kind, x, y) => {
  const i = ((SKIN_KINDS.indexOf(kind) * SKIN_H + y) * ATLAS_W + x) * 4;
  return { rgb: (sheet[i] << 16) | (sheet[i + 1] << 8) | sheet[i + 2], a: sheet[i + 3] };
};
/** Every texel of a part's face: { x, y (local), rgb, a, glow }. */
const texels = (kind, part, face) => {
  const r = faceRect(PARTS[part], face);
  const out = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const c = at(atlas.data, kind, r.x + x, r.y + y);
      out.push({ x, y, rgb: c.rgb, a: c.a, glow: at(atlas.glow, kind, r.x + x, r.y + y).rgb });
    }
  }
  return out;
};
const BODY = ['head', 'torso', 'leg', 'upperArm', 'foreArm'];

describe('the sheet: three pages, every part a box unwrapped on its page', () => {
  it('is ATLAS_W × ATLAS_H RGBA, a page per kind, and paints the same thing every time', () => {
    expect(SKIN_KINDS).toEqual(['walker', 'runner', 'alpha']);
    expect([atlas.width, atlas.height]).toEqual([ATLAS_W, ATLAS_H]);
    expect([ATLAS_W, ATLAS_H]).toEqual([SKIN_W, SKIN_H * 3]);
    expect(atlas.data.length).toBe(ATLAS_W * ATLAS_H * 4);
    expect(atlas.glow.length).toBe(ATLAS_W * ATLAS_H * 4);
    const again = paintZombieAtlas();
    expect(Buffer.from(again.data).equals(Buffer.from(atlas.data))).toBe(true);
    expect(Buffer.from(again.glow).equals(Buffer.from(atlas.glow))).toBe(true);
    expect(SKIN_TEXEL).toBe(1 / 32); // twice as fine as the terrain's 16-texel tiles
  });

  it('every part fits its page and no two parts overlap; the six faces tile the unwrap', () => {
    const boxes = Object.entries(PARTS).map(([name, p]) => ({ name, x0: p.x, y0: p.y, x1: p.x + 2 * p.d + 2 * p.w, y1: p.y + p.d + p.h }));
    for (const b of boxes) {
      expect(b.x1, b.name).toBeLessThanOrEqual(SKIN_W);
      expect(b.y1, b.name).toBeLessThanOrEqual(SKIN_H);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0, `${a.name} / ${b.name}`).toBe(true);
      }
    }
    const p = PARTS.torso;
    expect(faceRect(p, 'front')).toEqual({ x: p.x + p.d, y: p.y + p.d, w: p.w, h: p.h });
    expect(faceRect(p, 'right').x + faceRect(p, 'right').w).toBe(faceRect(p, 'front').x); // the right side leads into the front
    expect(faceRect(p, 'front').x + p.w).toBe(faceRect(p, 'left').x);
    expect(faceRect(p, 'left').x + p.d).toBe(faceRect(p, 'back').x);
    expect(faceRect(p, 'top')).toEqual({ x: p.x + p.d, y: p.y, w: p.w, h: p.d });
    expect(faceRect(p, 'bottom').x).toBe(faceRect(p, 'top').x + p.w);
    expect(FACES).toHaveLength(6);
  });

  it('the body is painted solid; the hair is a layer with gaps; only the alpha has a coat', () => {
    for (const kind of SKIN_KINDS) {
      for (const part of BODY) for (const face of FACES) for (const t of texels(kind, part, face)) expect(t.a, `${kind} ${part} ${face}`).toBe(255);
      const hair = FACES.flatMap((face) => texels(kind, 'hair', face));
      expect(hair.some((t) => t.a === 255)).toBe(true);
      expect(hair.some((t) => t.a === 0)).toBe(true);
      expect(texels(kind, 'hair', 'top').every((t) => t.a === 255)).toBe(true);
      const coat = FACES.flatMap((face) => texels(kind, 'coat', face));
      expect(coat.some((t) => t.a === 255)).toBe(kind === 'alpha');
    }
    // the alpha's coat hangs open down the front
    expect(texels('alpha', 'coat', 'front').filter((t) => t.x >= 7 && t.x <= 8).every((t) => t.a === 0)).toBe(true);
  });
});

describe('spooky, not frightening: narrow slits, nothing red, nothing white', () => {
  it('no texel on any page is red or pure white', () => {
    for (let i = 0; i < atlas.data.length; i += 4) {
      if (atlas.data[i + 3] === 0) continue;
      const [r, g, b] = [atlas.data[i], atlas.data[i + 1], atlas.data[i + 2]];
      expect(r > 170 && g < 110 && b < 110, `red at ${i / 4}`).toBe(false);
      expect(r > 240 && g > 240 && b > 240, `white at ${i / 4}`).toBe(false);
    }
    const amber = EYE_GLOW.alpha;
    expect((amber >> 16) & 255).toBeGreaterThan((amber >> 8) & 255);
    expect((amber >> 8) & 255).toBeGreaterThan(100); // amber, not red
    expect((amber >> 8) & 255).toBeGreaterThan(amber & 255);
  });

  it('the walker is vacant: two level slits, four texels wide and one tall, empty by day and faintly green in the dark', () => {
    const face = texels('walker', 'head', 'front');
    const slits = face.filter((t) => t.rgb === SLIT);
    expect(slits.map((t) => `${t.x},${t.y}`).sort()).toEqual([...EYE_COLS.left, ...EYE_COLS.right].map((x) => `${x},${EYE_ROW}`).sort());
    expect(EYE_COLS.left).toHaveLength(4);
    // mirror-symmetric about the middle column
    const w = PARTS.head.w;
    expect(EYE_COLS.right.map((x) => w - 1 - x).sort()).toEqual([...EYE_COLS.left].sort());
    // they glow the marsh green, and nothing else on the head glows more than the night glow
    for (const t of face) expect(t.glow).toBe(t.rgb === SLIT ? EYE_GLOW.walker : NIGHT_GLOW);
    for (const side of ['left', 'right', 'back', 'top']) for (const t of texels('walker', 'head', side)) expect(t.glow).toBe(NIGHT_GLOW);
  });

  it('the runner is wired: uneven slits, one pale pinprick in each, and teeth', () => {
    const face = texels('runner', 'head', 'front');
    const pins = face.filter((t) => t.glow === EYE_GLOW.runner);
    expect(pins).toHaveLength(2);
    expect(pins.every((t) => t.y === EYE_ROW && t.rgb === EYE_GLOW.runner)).toBe(true);
    expect(pins.filter((t) => t.x < 6)).toHaveLength(1);
    const slits = face.filter((t) => t.rgb === SLIT && t.y === EYE_ROW);
    const left = slits.filter((t) => t.x < 6).length;
    const right = slits.filter((t) => t.x > 6).length;
    expect(left).not.toBe(right);
    expect(face.filter((t) => t.rgb === SLIT).every((t) => t.y === EYE_ROW)).toBe(true); // still slits: one texel tall
    // a row of teeth: pale texels alternating with dark in the mouth row
    const mouth = face.filter((t) => t.y === 10 && t.x >= 3 && t.x <= 9);
    const lum = (rgb) => ((rgb >> 16) & 255) + ((rgb >> 8) & 255) + (rgb & 255);
    expect(mouth.filter((t) => lum(t.rgb) > 500).length).toBeGreaterThanOrEqual(3);
    expect(mouth.filter((t) => lum(t.rgb) < 150).length).toBeGreaterThanOrEqual(3);
  });

  it('the alpha glares: four amber texels a side, the inner two a row lower than the outer two', () => {
    const face = texels('alpha', 'head', 'front');
    const eyes = face.filter((t) => t.glow === EYE_GLOW.alpha);
    expect(eyes).toHaveLength(8);
    expect(eyes.every((t) => t.rgb === EYE_GLOW.alpha)).toBe(true);
    const mid = (PARTS.head.w - 1) / 2;
    for (const sign of [-1, 1]) {
      const side = eyes.filter((t) => Math.sign(t.x - mid) === sign).sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid));
      expect(side).toHaveLength(4);
      expect(side[0].y).toBe(side[1].y);
      expect(side[2].y).toBe(side[3].y);
      expect(side[0].y).toBe(side[2].y + 1); // inner end lower: slanted down to the nose
    }
  });

  it('the glow sheet: the night glow wherever something is painted, nothing where a layer is empty', () => {
    let lit = 0;
    for (let i = 0; i < atlas.data.length; i += 4) {
      const g = (atlas.glow[i] << 16) | (atlas.glow[i + 1] << 8) | atlas.glow[i + 2];
      if (atlas.data[i + 3] === 0) expect(g).toBe(0);
      else {
        expect(g).not.toBe(0);
        lit++;
      }
    }
    expect(lit).toBeGreaterThan(5000);
  });

  it('people: each kind has its own hair, the walker and runner the same pale shirt cloth (it is tinted per zombie)', () => {
    const colours = (kind, part, face) => new Set(texels(kind, part, face).filter((t) => t.a).map((t) => t.rgb));
    const hw = colours('walker', 'hair', 'top');
    const hr = colours('runner', 'hair', 'top');
    const ha = colours('alpha', 'hair', 'top');
    for (const c of hw) expect(hr.has(c) || ha.has(c)).toBe(false);
    for (const c of hr) expect(ha.has(c)).toBe(false);
    expect([...colours('walker', 'upperArm', 'front')].sort()).toEqual([...colours('runner', 'upperArm', 'front')].sort());
    // the shirt is pale enough to take a tint
    for (const c of colours('walker', 'upperArm', 'top')) expect((c >> 8) & 255).toBeGreaterThan(110);
  });
});
