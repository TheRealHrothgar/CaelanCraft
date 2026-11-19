// Avatars (CONTRACTS §91): the data (avatars.js) and the per-player preference. The models are avatarModel.test.js's.
import { describe, it, expect } from 'vitest';
import {
  AVATARS, AVATAR_IDS, DEFAULT_AVATAR, AVATAR_PREF_KEY, normalizeAvatarId, avatarById, avatarHeight, loadAvatarPref,
  saveAvatarPref,
} from '../../src/avatars.js';
import { HAIR_CUTS } from '../../src/avatarModel.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH, EYE_HEIGHT } from '../../src/config.js';

const byId = (id) => /** @type {import('../../src/avatars.js').AvatarDef} */ (AVATARS.find((a) => a.id === id));

/** A Map-backed Web Storage. */
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    map: m,
  };
}
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('x'); } };
const lum = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);

describe('the avatars as data', () => {
  it('Caelan, Brayden and Annabelle, in that order; Caelan first and the default', () => {
    expect(AVATAR_IDS).toEqual(['caelan', 'brayden', 'annabelle']);
    expect(AVATARS.map((a) => a.displayName)).toEqual(['Caelan', 'Brayden', 'Annabelle']);
    expect(DEFAULT_AVATAR).toBe('caelan');
    expect(Object.isFrozen(AVATARS) && Object.isFrozen(AVATARS[0].body.leg) && Object.isFrozen(AVATARS[0].palette.skin)).toBe(true);
    expect(Object.isFrozen(AVATARS[0].hands.palm) && Object.isFrozen(AVATARS[2].outfit.skirt)).toBe(true);
    for (const a of AVATARS) expect(a.blurb.length, a.id).toBeGreaterThan(4);
  });

  it('every number is a positive metre; every colour is 0xRRGGBB; styles, cuts and outfits are known kinds', () => {
    const colours = (a) => [...a.palette.skin, ...a.palette.hair, ...a.palette.eyes, a.palette.brows, a.palette.mouth, a.palette.blush,
      ...a.outfit.top, a.outfit.trim, ...(a.outfit.bottom ?? []), ...a.outfit.shoes.colors, ...(a.outfit.sash ? [a.outfit.sash] : []),
      ...(a.outfit.socks ? [a.outfit.socks.color] : []), ...(a.outfit.belt ? [a.outfit.belt] : [])];
    for (const a of AVATARS) {
      const b = a.body;
      const sizes = [b.legX, b.ankle, b.leg.rx, b.leg.rz, b.leg.len, b.hips.rx, b.hips.rz, b.torso.h, b.torso.rx, b.torso.rz, b.neck.r,
        b.upper.rx, b.upper.rz, b.fore.rx, b.fore.rz, a.head.h, a.head.rx, a.head.rz, a.hair.crown, ...a.hands.palm, ...a.hands.fingers,
        ...a.hands.thumb, ...a.outfit.shoes.size];
      for (const v of sizes) expect(v > 0 && v < 1, `${a.id} ${v}`).toBe(true);
      for (const c of colours(a)) expect(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${a.id} ${c}`).toBe(true);
      expect(['poofy', 'silky', 'longWavy']).toContain(a.hair.style);
      expect(HAIR_CUTS[a.hair.cut].style, a.id).toBe(a.hair.style);
      expect(['tee', 'dress']).toContain(a.outfit.kind);
      expect(['sneaker', 'laceup', 'strap']).toContain(a.outfit.shoes.style);
      expect(a.palette.skin).toHaveLength(4);
      expect(a.palette.hair).toHaveLength(4);
      expect(a.palette.eyes).toHaveLength(2);
      expect(a.outfit.sleeve).toBeGreaterThan(0);
      expect(a.outfit.sleeve).toBeLessThanOrEqual(1);
      // a pushed-up sleeve's cuff (on the model and in first person) sits part way up the forearm; a short sleeve has none
      if (a.outfit.cuffAt !== undefined) expect(a.outfit.cuffAt > 0 && a.outfit.cuffAt < 1, a.id).toBe(true);
      expect(a.outfit.cuffAt === undefined || a.outfit.sleeve === 1, a.id).toBe(true);
      // the joints run down the arm and the body stacks up
      expect(b.shoulder[1]).toBeGreaterThan(b.elbow[1]);
      expect(b.elbow[1]).toBeGreaterThan(b.wrist[1]);
      expect(b.ankle + b.leg.len).toBeGreaterThan(b.hips.y0);
      expect(b.torso.y0 + b.torso.h).toBeGreaterThan(b.neck.y0);
      expect(a.head.y).toBeLessThan(b.neck.y1);
      expect(a.scale > 0.9 && a.scale < 1.1, a.id).toBe(true);
    }
  });

  it('the picks: Caelan a tousled mop (C2), Brayden a side sweep (B1), Annabelle long waves (A1)', () => {
    expect(byId('caelan').hair).toMatchObject({ style: 'poofy', cut: 'C2' });
    expect(byId('brayden').hair).toMatchObject({ style: 'silky', cut: 'B1' });
    expect(byId('annabelle').hair).toMatchObject({ style: 'longWavy', cut: 'A1' });
  });

  it('gives Caelan a mild olive skin, its shadows warm, not grey', () => {
    for (const c of byId('caelan').palette.skin) {
      const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      expect(r).toBeGreaterThan(g); // warm
      expect(g - b).toBeGreaterThan(20); // a yellow-green (olive) undertone, never grey
      expect(r - g).toBeLessThan(45); // not orange
    }
    expect(lum(byId('caelan').palette.skin[0])).toBeGreaterThan(190); // mild, not tan
  });

  it('each one\'s height is its build\'s (to within 1/32 m), close to the one collider, and Brayden and Annabelle are taller than Caelan', () => {
    for (const a of AVATARS) {
      expect(Math.abs(avatarHeight(a) - a.height), a.id).toBeLessThan(1 / 32);
      expect(a.height, a.id).toBeLessThanOrEqual(PLAYER_HEIGHT);
      expect(a.height, a.id).toBeGreaterThan(PLAYER_HEIGHT - 0.2);
    }
    expect([byId('caelan').height, byId('brayden').height, byId('annabelle').height]).toEqual([1.625, 1.781, 1.719]);
    expect(byId('brayden').height - byId('caelan').height).toBeGreaterThan(0.1);
    expect(byId('annabelle').height - byId('caelan').height).toBeGreaterThan(0.06);
    expect(byId('brayden').height).toBeGreaterThan(byId('annabelle').height); // tall and slender
    // physics is the same for everyone: the collider and the eye are constants, not avatar data
    for (const a of AVATARS) for (const k of ['collider', 'eye', 'eyeHeight', 'width', 'speed']) expect(a).not.toHaveProperty(k);
    expect([PLAYER_HEIGHT, PLAYER_WIDTH, EYE_HEIGHT]).toEqual([1.8, 0.56, 1.62]);
  });

  it('the builds read: Caelan tapers, Brayden is slender with long limbs, Annabelle is solid and wears a dress', () => {
    const c = byId('caelan').body;
    const b = byId('brayden').body;
    const a = byId('annabelle').body;
    expect(c.torso.rx).toBeGreaterThan(c.hips.rx); // shoulders over a narrower seat
    expect(b.torso.rx).toBeLessThan(c.torso.rx);
    expect(b.leg.len).toBeGreaterThan(c.leg.len + 0.1);
    expect(b.shoulder[1] - b.wrist[1]).toBeGreaterThan(c.shoulder[1] - c.wrist[1]);
    expect(a.torso.rx).toBeGreaterThan(c.torso.rx);
    expect(a.hips.rx).toBeGreaterThan(c.hips.rx);
    expect(a.torso.rz).toBeGreaterThan(c.torso.rz);
    const ann = byId('annabelle').outfit;
    expect(ann.kind).toBe('dress');
    expect(ann.skirt && ann.skirt.r1 > a.hips.rx).toBe(true); // the skirt flares wider than the hips
  });

  it('the legs fit under the hips and the arms hang clear of the torso', () => {
    for (const def of AVATARS) {
      const b = def.body;
      expect(b.legX + b.leg.rx * 0.9, def.id).toBeLessThanOrEqual(b.hips.rx + 0.01);
      expect(b.shoulder[0] - b.upper.rx * 0.5, def.id).toBeGreaterThan(b.torso.rx * 0.9);
    }
  });

  it('ids: normalizeAvatarId (any case, trimmed), avatarById falls back to the default', () => {
    expect(normalizeAvatarId(' Annabelle ')).toBe('annabelle');
    expect(normalizeAvatarId('BRAYDEN')).toBe('brayden');
    for (const bad of ['', 'steve', null, undefined, 3, {}]) expect(normalizeAvatarId(bad)).toBeNull();
    expect(avatarById('brayden').displayName).toBe('Brayden');
    expect(avatarById('nobody').id).toBe('caelan');
  });

  it('the choice is a per-player preference: default Caelan, stored under its own key, never thrown on', () => {
    expect(AVATAR_PREF_KEY).toBe('caelancraft:v2:avatar');
    expect(loadAvatarPref(null)).toBe('caelan');
    const s = fakeStorage();
    expect(loadAvatarPref(s)).toBe('caelan');
    expect(saveAvatarPref(s, 'Annabelle')).toBe(true);
    expect(s.map.get(AVATAR_PREF_KEY)).toBe('annabelle');
    expect(loadAvatarPref(s)).toBe('annabelle');
    expect(saveAvatarPref(s, 'steve')).toBe(false);
    expect(loadAvatarPref(s)).toBe('annabelle');
    expect(loadAvatarPref(fakeStorage({ [AVATAR_PREF_KEY]: 'garbage' }))).toBe('caelan');
    expect(loadAvatarPref(throwing)).toBe('caelan');
    expect(saveAvatarPref(throwing, 'brayden')).toBe(false);
    expect(saveAvatarPref(null, 'brayden')).toBe(false);
  });
});
