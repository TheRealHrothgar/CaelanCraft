// zombieModel.js (PURE): the three hex-faceted zombies — parts in their joints' frames, one painted 256² atlas and a glow
// image each, within the triangle budget, spooky not frightening (nothing red). CONTRACTS §104.
import { describe, it, expect } from 'vitest';
import {
  zombieModel, buildZombieModel, zombieRig, zombieRestGeometry, ZOMBIE_MODEL_KINDS, ZOMBIE_PARTS, ZOMBIE_ATLAS, TINT_ALPHA,
  EYE_GLOW, NIGHT_SELF_LIGHT, NIGHT_TINT, ZOMBIE_HEAD, ALPHA_HEAD, zombieHair, zombieHairGaps,
} from '../../src/zombieModel.js';
import { triangleCount, bounds } from '../../src/modelKit.js';
import { rgbOf } from '../../src/paintKit.js';
import { ZOMBIE_HEIGHT } from '../../src/config.js';
import { ZOMBIE_KINDS } from '../../src/zombies.js';

/** A colour reads as red when red leads both other channels by a wide margin (blood, red eyes). */
const isRed = (r, g, b) => r > 90 && r > g * 1.45 && r > b * 1.45;

describe('the zombie models', () => {
  it('one model per kind, the kinds the game has, five parts each', () => {
    expect([...ZOMBIE_MODEL_KINDS].sort()).toEqual([...ZOMBIE_KINDS].sort());
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      expect(m.kind).toBe(kind);
      expect(Object.keys(m.parts).sort()).toEqual([...ZOMBIE_PARTS].sort());
      expect(zombieModel(kind)).toBe(m); // built once, shared
    }
    expect(zombieModel(/** @type {*} */ ('nonsense')).kind).toBe('walker');
  });

  it('stays in the budget: about 1,000–1,300 triangles a zombie (legs and arms drawn twice)', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      let t = 0;
      for (const p of ZOMBIE_PARTS) t += triangleCount(m.parts[p]) * (p === 'torso' || p === 'head' ? 1 : 2);
      expect(m.tris, kind).toBe(t);
      expect(m.tris, kind).toBeGreaterThan(900);
      expect(m.tris, kind).toBeLessThanOrEqual(1320);
    }
  });

  it('valid geometry: unit normals, closed indices, uvs inside the atlas, outward winding', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      for (const part of ZOMBIE_PARTS) {
        const g = zombieModel(kind).parts[part];
        const at = `${kind} ${part}`;
        expect(g.uvs.every((u) => u >= 0 && u <= 1), at).toBe(true);
        expect(g.index.every((i) => i < g.positions.length / 3), at).toBe(true);
        let bad = 0;
        for (let i = 0; i < g.normals.length; i += 3) if (Math.abs(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) - 1) > 1e-3) bad++;
        expect(bad, at).toBe(0);
        // each triangle's winding agrees with its vertices' normals (wound outward, counter-clockwise from outside)
        let against = 0;
        const P = g.positions;
        for (let t = 0; t < g.index.length; t += 3) {
          const [a, b, c] = [g.index[t] * 3, g.index[t + 1] * 3, g.index[t + 2] * 3];
          const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
          const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const N = g.normals;
          if (n[0] * N[a] + n[1] * N[a + 1] + n[2] * N[a + 2] < -1e-12) against++;
        }
        expect(against, at).toBe(0);
      }
    }
  });

  it('hangs every part from its joint: the leg reaches the ground from its hip, the arm to the fingertips', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      const R = m.rig;
      expect(R).toEqual(zombieRig(kind));
      const leg = bounds(m.parts.leg);
      expect(leg.min[1], kind).toBeCloseTo(-R.legH, 3); // the sole on the ground
      expect(leg.max[1], kind).toBeGreaterThan(0); // up into the seat, so a swinging leg leaves no gap
      const torso = bounds(m.parts.torso);
      expect(torso.min[1], kind).toBeLessThan(-0.05); // the seat round the tops of the legs
      expect(torso.max[1], kind).toBeGreaterThan(R.shoulderY);
      expect(torso.max[1], kind).toBeLessThan(R.torsoH + 0.06);
      const fore = bounds(m.parts.foreArm);
      expect(-fore.min[1], kind).toBeGreaterThan(R.foreL - 0.06);
      expect(-fore.min[1], kind).toBeLessThan(R.foreL + 0.04);
      const upper = bounds(m.parts.upperArm);
      expect(-upper.min[1], kind).toBeGreaterThan(R.upperL - 0.01); // down to the elbow
      expect(m.dims.height, kind).toBeLessThanOrEqual(ZOMBIE_HEIGHT);
      expect(m.dims.height, kind).toBeGreaterThan(ZOMBIE_HEIGHT - 0.15);
      expect(m.dims.height / m.dims.headH, kind).toBeGreaterThan(4.3); // a grown person, not a child
      // the arms hang to mid thigh
      const tips = R.legH + R.shoulderY - R.upperL - R.foreL;
      expect(tips, kind).toBeLessThan(R.legH * 0.9);
      expect(tips, kind).toBeGreaterThan(R.legH * 0.4);
    }
  });

  it('each kind is its own build: the runner leaner than the walker, the alpha broader and heavier', () => {
    const w = zombieModel('walker');
    const r = zombieModel('runner');
    const a = zombieModel('alpha');
    const width = (m, part) => {
      const b = bounds(m.parts[part]);
      return b.max[0] - b.min[0];
    };
    expect(width(r, 'torso')).toBeLessThan(width(w, 'torso') - 0.02);
    expect(width(r, 'leg')).toBeLessThan(width(w, 'leg'));
    expect(width(a, 'torso')).toBeGreaterThan(width(w, 'torso') + 0.05);
    expect(width(a, 'foreArm')).toBeGreaterThan(width(w, 'foreArm'));
    expect(a.rig.shoulderX).toBeGreaterThan(w.rig.shoulderX + 0.02);
    // the alpha's coat hangs below its hips
    expect(bounds(a.parts.torso).min[1]).toBeLessThan(bounds(w.parts.torso).min[1] - 0.05);
    // gaunt heads: the jaw narrower than the cheekbones; the alpha's jaw heavier
    for (const shape of [ZOMBIE_HEAD, ALPHA_HEAD]) expect(shape[0][1]).toBeLessThan(shape[4][1] * 0.65);
    expect(ALPHA_HEAD[0][1]).toBeGreaterThan(ZOMBIE_HEAD[0][1]);
  });

  it('the hair hugs each kind\'s own skull: no corner of its head above the hairline lies outside the cap', () => {
    // (the alpha's square-jawed head once wore a child's tilted shell: a pale strip of skull showed across its brow)
    for (const kind of ZOMBIE_MODEL_KINDS) {
      expect(zombieHairGaps(kind), kind).toBe(0);
      const { cap, clumps } = zombieHair(kind);
      expect(triangleCount(cap), kind).toBeLessThan(140);
      // a cap and a few clumps lying on it — never a ring of spikes round the head
      expect(clumps.length, kind).toBeGreaterThanOrEqual(4);
      expect(clumps.length, kind).toBeLessThanOrEqual(8);
      // every clump stays close to the head: nothing stands up off it like a crown
      const head = bounds(zombieModel(kind).parts.head);
      for (const g of clumps) {
        const b = bounds(g);
        expect(b.max[1], kind).toBeLessThan(head.max[1] + 0.06);
      }
    }
  });

  it('the runner\'s straw is swept one way: its clumps\' tips lie behind or to its left, never stood up all round', () => {
    const { clumps } = zombieHair('runner');
    for (const g of clumps) {
      // its root is the middle of its root's cap (group 2), its tip the point farthest from there; in the head's frame
      // the front is −z and its left −x
      const n = g.positions.length / 3;
      const P = (i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
      const cap = [];
      for (let i = 0; i < n; i++) if (g.groups[i] === 2) cap.push(P(i));
      expect(cap.length).toBeGreaterThan(2);
      const root = [0, 1, 2].map((a) => cap.reduce((sum, p) => sum + p[a], 0) / cap.length);
      let tip = root;
      for (let i = 0; i < n; i++) {
        const p = P(i);
        if (Math.hypot(p[0] - root[0], p[1] - root[1], p[2] - root[2]) > Math.hypot(tip[0] - root[0], tip[1] - root[1], tip[2] - root[2])) tip = p;
      }
      expect(tip[2] - root[2] > 0.02 || tip[0] - root[0] < -0.02).toBe(true);
    }
  });

  it('stands on its feet at rest under ZOMBIE_HEIGHT (the gallery\'s and the pilot\'s view)', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const b = bounds(zombieRestGeometry(kind));
      expect(b.min[1], kind).toBeGreaterThanOrEqual(-1e-6);
      expect(b.max[1], kind).toBeLessThanOrEqual(ZOMBIE_HEIGHT);
    }
  });
});

describe('the zombie atlases', () => {
  it('a 256² atlas and a glow image per kind, painted the same every time', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      expect(m.atlas).toEqual([ZOMBIE_ATLAS, ZOMBIE_ATLAS]);
      expect(m.image.width).toBe(256);
      expect(m.glow.width).toBe(256);
      expect(m.image.data.length).toBe(256 * 256 * 4);
      expect(m.texels).toBeGreaterThan(20000);
      expect(m.texels).toBeLessThanOrEqual(256 * 256);
    }
    const again = buildZombieModel('runner');
    expect(Buffer.from(again.image.data).equals(Buffer.from(zombieModel('runner').image.data))).toBe(true);
    expect(Buffer.from(again.glow.data).equals(Buffer.from(zombieModel('runner').glow.data))).toBe(true);
  });

  it('nothing red: no texel of any atlas or glow image is red', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      for (const img of [m.image, m.glow]) {
        let red = 0;
        for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 0 && isRed(img.data[i], img.data[i + 1], img.data[i + 2])) red++;
        expect(red, kind).toBe(0);
      }
      const [r, g, b] = rgbOf(EYE_GLOW[kind]);
      expect(isRed(r, g, b), kind).toBe(false);
      expect(r).toBeLessThanOrEqual(Math.max(g, b) + 20); // the glow is never warmer than gold
    }
  });

  it('see-through ragged edges: cut-away texels (alpha 0) on the cloth, opaque elsewhere', () => {
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const d = zombieModel(kind).image.data;
      let cut = 0;
      let partial = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] === 0) cut++;
        else if (d[i] < TINT_ALPHA - 1) partial++;
      }
      expect(cut, kind).toBeGreaterThan(256 * 256 * 0.05); // the gutters, and the torn hems
      expect(partial, kind).toBeLessThan(256 * 256 * 0.02); // a cut is clean (only the anti-aliased rim is partial)
    }
  });

  it('marks the shirt the tint colours (walkers and runners only; never the skin, never the alpha)', () => {
    const count = (kind) => {
      const d = zombieModel(kind).image.data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === TINT_ALPHA) n++;
      return n;
    };
    expect(count('walker')).toBeGreaterThan(3000);
    expect(count('runner')).toBeGreaterThan(3000);
    expect(count('alpha')).toBe(0);
    expect(TINT_ALPHA / 255).toBeGreaterThan(0.6); // well over the renderer's alphaTest
  });

  it('the alpha\'s shirt — the middle of its open coat — is painted as finely as the coat, its buttons dark', () => {
    const a = zombieModel('alpha');
    const [x0, y0, w, h] = a.rects.shirt;
    // as wide as the coat's strip round it (its perimeter is a little less): not the half-density strip it once was
    expect(w / a.rects.coat[2]).toBeGreaterThan(0.8);
    // no pale spot on it (a 1.4-px light button blurred by a mipmap read as a glowing smudge): nothing lighter than its
    // lightest cloth
    const d = a.image.data;
    let lightest = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * ZOMBIE_ATLAS + x) * 4;
        if (d[i + 3] >= 128) lightest = Math.max(lightest, 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      }
    }
    const [r, g, b] = rgbOf(0x6a6460);
    expect(lightest).toBeLessThan(0.2126 * r + 0.7152 * g + 0.0722 * b + 8);
  });

  it('the glow image: the atlas dimmed where it is opaque (its texture still reads at night), the eyes in their colour', () => {
    expect(NIGHT_SELF_LIGHT).toBeGreaterThan(0.1);
    expect(NIGHT_SELF_LIGHT).toBeLessThan(0.35); // a faint self-light, never a lamp
    const tint = rgbOf(NIGHT_TINT).map((c) => (c / 255) * NIGHT_SELF_LIGHT);
    for (const kind of ZOMBIE_MODEL_KINDS) {
      const m = zombieModel(kind);
      const img = m.image.data;
      const glow = m.glow.data;
      const [er, eg, eb] = rgbOf(EYE_GLOW[kind]);
      let eyes = 0;
      let night = 0;
      let wrong = 0;
      for (let i = 0; i < img.length; i += 4) {
        const lit = glow[i] + glow[i + 1] + glow[i + 2];
        if (img[i + 3] < 128) {
          if (lit > 0) wrong++;
        } else if ([0, 1, 2].every((c) => Math.abs(glow[i + c] - Math.round(img[i + c] * tint[c])) <= 1)) night++;
        else if (Math.abs(glow[i] - er) < 3 && Math.abs(glow[i + 1] - eg) < 3 && Math.abs(glow[i + 2] - eb) < 3) eyes++;
      }
      expect(wrong, kind).toBe(0);
      expect(night, kind).toBeGreaterThan(20000);
      expect(eyes, kind).toBeGreaterThan(2); // two small slits (a runner's two pinpricks)
      expect(eyes, kind).toBeLessThan(400); // … and no more: subtle
    }
  });
});
