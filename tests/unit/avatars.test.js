// Avatars (CONTRACTS §91): the data (avatars.js), the skins (avatarSkin.js) and the per-player preference.
import { describe, it, expect } from 'vitest';
import {
  AVATARS, AVATAR_IDS, DEFAULT_AVATAR, AVATAR_PREF_KEY, normalizeAvatarId, avatarById, avatarHeight, loadAvatarPref,
  saveAvatarPref,
} from '../../src/avatars.js';
import {
  paintAvatarSheet, avatarParts, layoutParts, faceRect, avatarRig, restBoxes, faceLayout, frontPicture, portrait, SHEET_W, PAGE_H,
  FACES, HAIR_PARTS, EYE_WHITE,
} from '../../src/avatarSkin.js';
import { AVATAR_TEXEL, PLAYER_HEIGHT, PLAYER_WIDTH, EYE_HEIGHT } from '../../src/config.js';

const T = AVATAR_TEXEL;
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

describe('the avatars as data', () => {
  it('Caelan, Brayden and Annabelle, in that order; Caelan first and the default', () => {
    expect(AVATAR_IDS).toEqual(['caelan', 'brayden', 'annabelle']);
    expect(AVATARS.map((a) => a.displayName)).toEqual(['Caelan', 'Brayden', 'Annabelle']);
    expect(DEFAULT_AVATAR).toBe('caelan');
    expect(Object.isFrozen(AVATARS) && Object.isFrozen(AVATARS[0].body.head) && Object.isFrozen(AVATARS[0].palette.skin)).toBe(true);
    for (const a of AVATARS) expect(a.blurb.length, a.id).toBeGreaterThan(4);
  });

  it('every box is whole texels; every colour is 0xRRGGBB; styles and outfits are known kinds', () => {
    const boxes = (a) => [a.body.head, a.body.chest, a.body.waist, a.body.leg, a.body.upperArm, a.body.foreArm, a.hair.box,
      ...(a.hair.tufts ?? []), ...(a.hair.back ? [a.hair.back] : []), ...(a.outfit.skirt ? [a.outfit.skirt] : [])];
    const colours = (a) => [...a.palette.skin, ...a.palette.hair, ...a.palette.eyes, a.palette.brows, a.palette.mouth, a.palette.blush,
      ...a.outfit.top, a.outfit.trim, ...(a.outfit.bottom ?? []), ...a.outfit.shoes, ...(a.outfit.sash ? [a.outfit.sash] : []),
      ...(a.outfit.socks ? [a.outfit.socks] : [])];
    for (const a of AVATARS) {
      for (const b of boxes(a)) for (const k of ['w', 'h', 'd']) expect(Number.isInteger(b[k]) && b[k] > 0, `${a.id} ${k}`).toBe(true);
      for (const c of colours(a)) expect(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${a.id} ${c}`).toBe(true);
      expect(['poofy', 'silky', 'longWavy']).toContain(a.hair.style);
      expect(['tee', 'dress']).toContain(a.outfit.kind);
      expect(a.palette.skin).toHaveLength(4);
      expect(a.palette.hair).toHaveLength(4);
      expect(a.palette.eyes).toHaveLength(2);
      expect(a.body.hand).toBeLessThan(a.body.foreArm.h);
      expect(a.outfit.sleeve).toBeLessThan(a.body.upperArm.h);
    }
  });

  it('each one\'s height is its boxes\' (to within a texel), close to the one collider, and Brayden and Annabelle are taller than Caelan', () => {
    for (const a of AVATARS) {
      expect(Math.abs(avatarHeight(a) - a.height), a.id).toBeLessThan(T);
      expect(a.height, a.id).toBeLessThanOrEqual(PLAYER_HEIGHT);
      expect(a.height, a.id).toBeGreaterThan(PLAYER_HEIGHT - 0.2);
    }
    expect(byId('brayden').height - byId('caelan').height).toBeGreaterThan(0.1);
    expect(byId('annabelle').height - byId('caelan').height).toBeGreaterThan(0.06);
    expect(byId('brayden').height).toBeGreaterThan(byId('annabelle').height); // tall and slender
    // physics is the same for everyone: the collider and the eye are constants, not avatar data
    for (const a of AVATARS) for (const k of ['collider', 'eye', 'eyeHeight', 'width', 'speed']) expect(a).not.toHaveProperty(k);
    expect([PLAYER_HEIGHT, PLAYER_WIDTH, EYE_HEIGHT]).toEqual([1.8, 0.56, 1.62]);
  });

  it('the builds read: Caelan tapers (shoulders wider than the waist), Brayden is slender with long limbs, Annabelle is solid', () => {
    const c = byId('caelan').body;
    const b = byId('brayden').body;
    const a = byId('annabelle').body;
    expect(c.chest.w - c.waist.w).toBeGreaterThanOrEqual(4);
    expect(b.chest.w).toBeLessThan(c.chest.w);
    expect(b.leg.h).toBeGreaterThan(c.leg.h + 4);
    expect(b.upperArm.h + b.foreArm.h).toBeGreaterThan(c.upperArm.h + c.foreArm.h);
    expect(a.chest.w).toBeGreaterThanOrEqual(c.chest.w);
    expect(a.waist.w).toBeGreaterThan(c.waist.w);
    expect(a.chest.d).toBeGreaterThan(c.chest.d);
    expect(byId('caelan').hair.tufts?.length).toBeGreaterThanOrEqual(3); // poofy: tufts that stick out
    expect(byId('annabelle').hair.back).toBeTruthy(); // long hair down her back
    expect(byId('annabelle').outfit.skirt).toBeTruthy(); // a dress
  });

  it('the legs fit under the waist, the arms clear the chest and the skirt, the skirt is wider than the hips', () => {
    for (const def of AVATARS) {
      const b = def.body;
      const g = avatarRig(def);
      expect(2 * g.legX + b.leg.w, def.id).toBeLessThanOrEqual(b.waist.w);
      expect(g.shoulderX - b.upperArm.w / 2, def.id).toBeGreaterThanOrEqual(b.chest.w / 2);
      if (def.outfit.skirt) {
        expect(def.outfit.skirt.w / 2, def.id).toBeLessThanOrEqual(g.shoulderX - b.upperArm.w / 2);
        expect(def.outfit.skirt.w).toBeGreaterThan(2 * g.legX + b.leg.w);
        expect(def.outfit.skirt.d).toBeGreaterThan(b.waist.d);
      }
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

describe('the skins (avatarSkin.js)', () => {
  const sheet = paintAvatarSheet();
  const at = (page, x, y) => {
    const i = ((page * PAGE_H + y) * SHEET_W + x) * 4;
    return [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2], sheet.data[i + 3]];
  };
  const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

  it('one SHEET_W × PAGE_H page per avatar, the same bytes every call', () => {
    expect([sheet.width, sheet.height]).toEqual([SHEET_W, PAGE_H * AVATARS.length]);
    expect(sheet.data.length).toBe(sheet.width * sheet.height * 4);
    expect(Object.keys(sheet.pages)).toEqual(AVATAR_IDS);
    expect(paintAvatarSheet().data).toEqual(sheet.data);
  });

  it('every part has an unwrap on its own page, none overlapping, all inside the page', () => {
    for (const def of AVATARS) {
      const { layout } = sheet.pages[def.id];
      expect(Object.keys(layout).sort()).toEqual(Object.keys(avatarParts(def)).sort());
      const used = new Set();
      for (const [name, p] of Object.entries(layout)) {
        expect(p.x + 2 * (p.w + p.d), `${def.id} ${name}`).toBeLessThanOrEqual(SHEET_W);
        expect(p.y + p.d + p.h, `${def.id} ${name}`).toBeLessThanOrEqual(PAGE_H);
        for (const face of FACES) {
          const r = faceRect(p, face);
          for (let y = r.y; y < r.y + r.h; y++) {
            for (let x = r.x; x < r.x + r.w; x++) {
              expect(used.has(`${x},${y}`), `${def.id} ${name} ${face}`).toBe(false);
              used.add(`${x},${y}`);
            }
          }
        }
      }
    }
    expect(() => layoutParts({ huge: { w: 60, h: 10, d: 10 } })).toThrow(RangeError);
    expect(() => layoutParts({ a: { w: 40, h: 100, d: 20 }, b: { w: 40, h: 100, d: 20 } })).toThrow(RangeError);
  });

  it('body parts are painted solid; the hair layer is see-through where the face shows', () => {
    for (const def of AVATARS) {
      const { page, layout } = sheet.pages[def.id];
      for (const [name, p] of Object.entries(layout)) {
        if (HAIR_PARTS.includes(name) || name.startsWith('tuft')) continue;
        for (const face of FACES) {
          const r = faceRect(p, face);
          let clear = 0;
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (at(page, x, y)[3] !== 255) clear++;
          expect(clear, `${def.id} ${name} ${face}`).toBe(0);
        }
      }
      // the hair layer: hair on top, open over the eyes, nothing on its bottom
      const hair = layout.hair;
      const front = faceRect(hair, 'front');
      const L = faceLayout(def.body.head);
      const above = def.hair.box.y + def.hair.box.h - def.body.head.h;
      const inset = (def.hair.box.w - def.body.head.w) / 2;
      expect(at(page, front.x + Math.floor(front.w / 2), front.y)[3], def.id).toBe(255);
      for (const e of [L.left, L.right]) {
        for (const col of [e.white, ...e.iris]) expect(at(page, front.x + inset + col, front.y + above + L.eyeRow)[3], def.id).toBe(0);
      }
      const bottom = faceRect(hair, 'bottom');
      expect(at(page, bottom.x + 1, bottom.y + 1)[3], def.id).toBe(0);
    }
  });

  it('friendly eyes in each avatar\'s eye colour: a white, the iris, a darker pupil; brows in the hair colour', () => {
    for (const def of AVATARS) {
      const { page, layout } = sheet.pages[def.id];
      const f = faceRect(layout.head, 'front');
      const L = faceLayout(def.body.head);
      for (const e of [L.left, L.right]) {
        expect(at(page, f.x + e.white, f.y + L.eyeRow).slice(0, 3), def.id).toEqual(rgb(EYE_WHITE));
        expect(at(page, f.x + e.iris[1], f.y + L.eyeRow).slice(0, 3), def.id).toEqual(rgb(def.palette.eyes[0]));
        expect(at(page, f.x + e.iris[1], f.y + L.eyeRow + 1).slice(0, 3), def.id).toEqual(rgb(def.palette.eyes[1]));
        expect(at(page, f.x + e.iris[0], f.y + L.browRow).slice(0, 3), def.id).toEqual(rgb(def.palette.brows));
      }
      // the eyes are mirror images about the middle of the face
      expect(L.left.white + L.right.white).toBe(def.body.head.w - 1);
      expect(L.left.iris[0] + L.right.iris[0]).toBe(def.body.head.w - 1);
    }
  });

  it('the rest pose stacks legs, waist, chest and head to the avatar\'s height', () => {
    for (const def of AVATARS) {
      const { layout } = sheet.pages[def.id];
      let top = 0;
      let bottom = Infinity;
      for (const b of restBoxes(def)) {
        if (b.part.startsWith('tuft')) continue;
        top = Math.max(top, b.y + layout[b.part].h / 2);
        bottom = Math.min(bottom, b.y - layout[b.part].h / 2);
      }
      expect(bottom, def.id).toBe(0);
      expect(top * T, def.id).toBeCloseTo(avatarHeight(def), 6);
    }
  });

  it('a front picture and a square portrait (head and shoulders), painted from the skin', () => {
    for (const def of AVATARS) {
      const pic = frontPicture(def, sheet);
      const tall = Math.round(avatarHeight(def) / T);
      if (def.hair.tufts) expect(pic.height, def.id).toBeGreaterThan(tall); // the tufts stick up out of the hair
      else expect(pic.height, def.id).toBe(tall);
      expect(pic.height, def.id).toBeLessThanOrEqual(tall + 4);
      const p = portrait(def, sheet);
      expect(p.width, def.id).toBe(p.height);
      expect(p.data.length).toBe(p.width * p.height * 4);
      let opaque = 0;
      for (let i = 3; i < p.data.length; i += 4) if (p.data[i] === 255) opaque++;
      expect(opaque / (p.width * p.height), def.id).toBeGreaterThan(0.35);
      // the bottom row is the chest's cloth, the eye colour is in there
      const has = (c) => {
        const [r, g, b] = rgb(c);
        for (let i = 0; i < p.data.length; i += 4) if (p.data[i] === r && p.data[i + 1] === g && p.data[i + 2] === b) return true;
        return false;
      };
      expect(has(def.palette.eyes[0]), def.id).toBe(true);
    }
  });
});
