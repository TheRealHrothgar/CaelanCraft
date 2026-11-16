// pilotModels.js (PURE): the art pilot's models (A: hex-faceted) build, stay within budget, paint the same atlas every
// time. The kids are the game's avatars now (avatarModel.js, tested in avatarModel.test.js); the pilot still shows them
// (and their hair cuts, and the first-person hand) from there for the gallery.
import { describe, it, expect } from 'vitest';
import { buildPilot, buildHand, PILOT_MODELS, STYLES, HAIR_OPTIONS, HAIR_LABELS } from '../../src/pilotModels.js';
import { HEAD_CORNERS } from '../../src/figureKit.js';
import { fpHandFrame, FP_HAND } from '../../src/avatarModel.js';
import { AVATAR_IDS, avatarById } from '../../src/avatars.js';
import { PLAYER_HEIGHT } from '../../src/config.js';

/** Most triangles any one pilot model may have (a guard against a runaway: the gallery reports the real counts). */
const TRI_BUDGET = 2300;

/** The model's lowest and highest points. */
function heightOf(g) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < g.positions.length; i += 3) {
    lo = Math.min(lo, g.positions[i]);
    hi = Math.max(hi, g.positions[i]);
  }
  return { lo, hi };
}

describe('the pilot models', () => {
  for (const name of PILOT_MODELS) {
    it(`${name}: valid geometry and atlas, within budget`, () => {
      const m = buildPilot(name);
      const g = m.geo;
      expect(m.tris).toBe(g.index.length / 3);
      expect(m.tris).toBeLessThan(TRI_BUDGET);
      expect(g.uvs.every((u) => u >= 0 && u <= 1)).toBe(true);
      for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 4);
      expect(g.index.every((i) => i < g.positions.length / 3)).toBe(true);
      expect(m.image.data.length).toBe(m.atlas[0] * m.atlas[1] * 4);
      expect(m.atlas).toEqual([256, 256]);
      expect(m.texels).toBeGreaterThan(0);
      expect(m.texels).toBeLessThanOrEqual(m.atlas[0] * m.atlas[1]);
    });
  }

  it('stands figures on the ground: nothing below the feet, nobody taller than the collider', () => {
    for (const name of ['caelan', 'brayden', 'annabelle', 'zombie', 'sheep', 'pig']) {
      const { lo, hi } = heightOf(buildPilot(name).geo);
      expect(lo).toBeGreaterThanOrEqual(-0.01);
      expect(hi).toBeLessThan(PLAYER_HEIGHT + 0.1); // Caelan's tufts may stand a little over, as today's do
    }
  });

  it('shows every avatar as the game draws it, Brayden the tallest and Caelan the shortest', () => {
    const top = (id) => heightOf(buildPilot(id).geo).hi;
    for (const id of AVATAR_IDS) expect(top(id)).toBeCloseTo(avatarById(id).height, 1);
    expect(top('brayden')).toBeGreaterThan(top('annabelle'));
    expect(top('annabelle')).toBeGreaterThan(top('caelan'));
  });

  it('gives heads a broad flat face plane in front (not a box), and paints the same atlas every time', () => {
    const deg = HEAD_CORNERS.map((a) => Math.round((a * 180) / Math.PI));
    expect(deg).toContain(150);
    expect(deg).toContain(210);
    expect(deg.some((d) => d > 150 && d < 210)).toBe(false); // nothing breaks the face plane
    const a = buildPilot('annabelle');
    const b = buildPilot('annabelle');
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
  });

  it('gives each kid pictures of their own', () => {
    const imgs = ['caelan', 'brayden', 'annabelle'].map((id) => Buffer.from(buildPilot(id).image.data));
    expect(imgs[0].equals(imgs[1])).toBe(false);
    expect(imgs[1].equals(imgs[2])).toBe(false);
  });

  it('keeps the plants affordable: the near bush, the sapling, the bush past ~16 m (under 250, still leafy)', () => {
    expect(buildPilot('honeyberry').tris).toBeLessThan(1250);
    expect(buildPilot('sapling').tris).toBeLessThan(400);
    const far = buildPilot('honeyberry_far');
    expect(far.tris).toBeLessThanOrEqual(250);
    // leafy, not a ball: it reaches as wide as the near bush
    const span = (g) => {
      let r = 0;
      for (let i = 0; i < g.positions.length; i += 3) r = Math.max(r, Math.hypot(g.positions[i], g.positions[i + 2]));
      return r;
    };
    expect(span(far.geo)).toBeGreaterThan(0.8 * span(buildPilot('honeyberry').geo));
  });

  it('offers two hair options per kid (the chosen one among them), each one labelled and built', () => {
    for (const id of AVATAR_IDS) {
      expect(HAIR_OPTIONS[id]).toHaveLength(2);
      expect(HAIR_OPTIONS[id]).toContain(avatarById(id).hair.cut);
      for (const hair of HAIR_OPTIONS[id]) {
        const m = buildPilot(id, 'hex', { hair });
        expect(m.hair).toBe(hair);
        expect(m.hairTris).toBeGreaterThan(100);
        expect(HAIR_LABELS[hair].startsWith(hair)).toBe(true);
      }
    }
    expect(() => buildPilot('caelan', 'hex', { hair: 'B1' })).toThrow(RangeError);
  });

  it('refuses an unknown model or style', () => {
    expect(() => buildPilot('dragon')).toThrow(RangeError);
    expect(() => buildPilot('caelan', /** @type {*} */ ('soft'))).toThrow(RangeError);
    expect(Object.keys(STYLES)).toEqual(['hex']);
  });
});

describe('the first-person hand (the game\'s, shown by the pilot)', () => {
  it('sits small and low at the lower right of the view, its tool gripped at the fist', () => {
    const m = buildHand('hex', 0);
    expect(m.tris).toBeLessThan(800);
    const T = /** @type {Float64Array} */ (m.tool);
    // the tool's grip is the fist (where the wrist's tip leaves it, near FP_HAND.grip)
    const hand = fpHandFrame(0).hand;
    for (let k = 12; k < 15; k++) expect(T[k]).toBeCloseTo(hand[k], 9);
    expect(Math.hypot(T[12] - FP_HAND.grip[0], T[13] - FP_HAND.grip[1], T[14] - FP_HAND.grip[2])).toBeLessThan(0.06);
    // the haft rises out of the fist (the slab's +y points up in the view)
    expect(T[5]).toBeGreaterThan(0.2);
    expect(buildHand('hex', 0, { frame: 'hand' }).tris).toBeLessThan(400);
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
