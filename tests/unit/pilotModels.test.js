// pilotModels.js (PURE): the art pilot's models build in both styles, share their painted atlas, stay within budget,
// and the first-person hand grips its tool.
import { describe, it, expect } from 'vitest';
import { buildPilot, buildHand, fpHandFrame, PILOT_MODELS, STYLES, FP_HAND } from '../../src/pilotModels.js';

/** Most triangles any one pilot model may have (a guard against a runaway: the gallery reports the real counts). */
const TRI_BUDGET = 2500;

describe('the pilot models', () => {
  for (const name of PILOT_MODELS) {
    it(`${name}: valid in both styles, the same atlas for both`, () => {
      const a = buildPilot(name, 'hex');
      const b = buildPilot(name, 'soft');
      for (const m of [a, b]) {
        const g = m.geo;
        expect(m.tris).toBe(g.index.length / 3);
        expect(m.tris).toBeLessThan(TRI_BUDGET);
        expect(g.uvs.every((u) => u >= 0 && u <= 1)).toBe(true);
        for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 4);
        expect(g.index.every((i) => i < g.positions.length / 3)).toBe(true);
        expect(m.image.data.length).toBe(m.atlas[0] * m.atlas[1] * 4);
        expect(m.texels).toBeGreaterThan(0);
        expect(m.texels).toBeLessThanOrEqual(m.atlas[0] * m.atlas[1]);
      }
      // same painting, so the comparison is about shape: identical atlases, more triangles for the octagons
      expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
      expect(b.tris).toBeGreaterThanOrEqual(a.tris);
    });
  }

  it('stands figures on the ground: nothing below the feet, a child no taller than the collider', () => {
    for (const name of ['caelan', 'zombie', 'sheep', 'pig']) {
      const g = buildPilot(name, 'hex').geo;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i < g.positions.length; i += 3) {
        lo = Math.min(lo, g.positions[i]);
        hi = Math.max(hi, g.positions[i]);
      }
      expect(lo).toBeGreaterThanOrEqual(-0.01);
      expect(hi).toBeLessThan(1.9);
    }
  });

  it('paints the same atlas every time', () => {
    const a = buildPilot('caelan', 'hex');
    const b = buildPilot('caelan', 'hex');
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
  });

  it('refuses an unknown model or style', () => {
    expect(() => buildPilot('dragon', 'hex')).toThrow(RangeError);
    expect(() => buildPilot('caelan', /** @type {*} */ ('round'))).toThrow(RangeError);
    expect(Object.keys(STYLES)).toEqual(['hex', 'soft']);
  });
});

describe('the first-person hand', () => {
  it('sits small and low at the lower right of the view, its tool gripped at the fist', () => {
    for (const style of /** @type {const} */ (['hex', 'soft'])) {
      const m = buildHand(style, 0);
      expect(m.tris).toBeLessThan(800);
      const T = /** @type {Float64Array} */ (m.tool);
      // the tool's grip is the fist (where the wrist's tip leaves it, near FP_HAND.grip)
      const hand = fpHandFrame(0).hand;
      for (let k = 12; k < 15; k++) expect(T[k]).toBeCloseTo(hand[k], 9);
      expect(Math.hypot(T[12] - FP_HAND.grip[0], T[13] - FP_HAND.grip[1], T[14] - FP_HAND.grip[2])).toBeLessThan(0.06);
      // the haft rises out of the fist (the slab's +y points up in the view)
      expect(T[5]).toBeGreaterThan(0.4);
      // everything in front of the eye, right of the middle, below the eye line
      const g = m.geo;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const n = g.positions.length / 3;
      for (let i = 0; i < n; i++) {
        cx += g.positions[i * 3] / n;
        cy += g.positions[i * 3 + 1] / n;
        cz += g.positions[i * 3 + 2] / n;
      }
      expect(cx).toBeGreaterThan(0.1);
      expect(cy).toBeLessThan(-0.15);
      expect(cz).toBeLessThan(-0.2);
    }
  });

  it('swings: the fist comes forward and down, the forearm turns about the elbow', () => {
    const rest = fpHandFrame(0);
    const mid = fpHandFrame(1);
    expect(mid.hand[13]).toBeLessThan(rest.hand[13]);
    expect(mid.hand[14]).toBeLessThan(rest.hand[14]);
    // the haft tips forward (its +y gains −z)
    expect(mid.hand[6]).toBeLessThan(rest.hand[6]);
  });
});
