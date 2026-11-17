// Caelancraft — the art-direction pilot's models (PURE: typed arrays, no three, no DOM). Shown by gallery.html next
// to today's models. See docs/DESIGN-characters.md.
//
// The chosen look, A: HEX-FACETED. The kit for every figure is figureKit.js (faceted heads, hair, the Skin atlas, the
// style's shapes); the avatars left the pilot in phase 1 — they are avatarModel.js, the game's own models, and the pilot
// shows them from there (buildPilot('caelan'), buildHand); the zombies left in phase 2 (zombieModel.js: buildPilot('zombie')
// is the game's walker); the sheep and the pig left it in phase 3 — they are animalModels.js's, over the animals' shared
// atlas (restModel). What is still a pilot here: the honeyberry bush (near and far) and a sapling — later phases of the
// rollout.
// A model is { geo, image, tris, texels, atlas: [w, h] }: one merged geometry in its own frame (metres; a figure stands on
// its feet at the origin and faces −Z; the first-person hand is in CAMERA space), one RGBA atlas (sRGB bytes, row 0 at
// the top, a DataTexture with flipY off) and its budgets. Static poses only: the pilot is about the look.
import { loft, prism, transform, compose, mul, translation, rotation, identity, triangleCount } from './modelKit.js';
import { mix } from './paintKit.js';
import {
  STYLES, Skin, shapes, seg, len,
} from './figureKit.js';
import { buildAvatarModel, restGeometry, fpHandModel, HAIR_CUTS } from './avatarModel.js';
import { restModel } from './animalModels.js';
import { AVATARS, avatarById } from './avatars.js';
import { zombieModel, zombieRestGeometry } from './zombieModel.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./paintKit.js').Rect} Rect */
/** @typedef {import('./figureKit.js').PilotModel} PilotModel */
/** @typedef {import('./figureKit.js').Style} Style */
/** @typedef {import('./figureKit.js').HeadDims} HeadDims */

export { STYLES };

// ---------------------------------------------------------------------------------------------------
// The kids: the game's own avatars (avatarModel.js), at rest, and their hair cuts
// ---------------------------------------------------------------------------------------------------

/** Each kid's hair cuts (the gallery's ?row=hair shows all six). */
export const HAIR_OPTIONS = Object.freeze(Object.fromEntries(AVATARS.map((d) => [d.id,
  Object.freeze(Object.keys(HAIR_CUTS).filter((c) => HAIR_CUTS[/** @type {keyof typeof HAIR_CUTS} */ (c)].style === d.hair.style))])));
export const HAIR_LABELS = Object.freeze(Object.fromEntries(Object.entries(HAIR_CUTS).map(([c, v]) => [c, v.label])));

/** A kid at rest, wearing hair cut `hair` (default: theirs). @param {string} id @param {string} [hair] @returns {PilotModel} */
function buildKid(id, hair) {
  const m = buildAvatarModel(avatarById(id), { cut: hair });
  return { geo: restGeometry(m), image: m.image, tris: m.tris, texels: m.texels, atlas: m.atlas, hairTris: m.hairTris, hair: m.cut };
}

/**
 * Caelan's first-person hand, gripping its tool: `swing` 0 at rest .. 1 at the bottom of the stroke. In CAMERA space,
 * or (frame 'hand') the fist alone in its own frame. Its `tool` matrix places heldItem.js's slab.
 * @param {'hex'} [style] @param {number} [swing] @param {{ frame?: 'camera'|'hand' }} [o]
 * @returns {PilotModel}
 */
export function buildHand(style = 'hex', swing = 0, { frame = 'camera' } = {}) {
  if (!STYLES[style]) throw new RangeError(`no style ${style}`);
  const def = avatarById('caelan');
  if (frame === 'hand') {
    const m = buildAvatarModel(def);
    return { geo: m.fp.grip, image: m.image, tris: triangleCount(m.fp.grip), texels: m.texels, atlas: m.atlas, tool: m.fp.tool };
  }
  return fpHandModel(def, swing);
}

/**
 * The walker as the game draws it (zombieModel.js, phase 2), standing with its arms a little out.
 * @returns {PilotModel}
 */
function buildWalker() {
  const m = zombieModel('walker');
  const geo = zombieRestGeometry('walker');
  return { geo, image: m.image, tris: triangleCount(geo), texels: m.texels, atlas: m.atlas };
}

// ---------------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------------

/** The pilot's models by name. */
export const PILOT_MODELS = Object.freeze(['caelan', 'brayden', 'annabelle', 'zombie', 'sheep', 'pig', 'honeyberry', 'sapling', 'honeyberry_far']);

/**
 * One pilot model.
 * @param {string} name  PILOT_MODELS
 * @param {'hex'} [style]
 * @param {{ hair?: string }} [o]  a kid's hair cut (HAIR_OPTIONS; default theirs)
 * @returns {PilotModel}
 */
export function buildPilot(name, style = 'hex', { hair } = {}) {
  const st = STYLES[style];
  if (!st) throw new RangeError(`no style ${style}`);
  switch (name) {
    case 'caelan':
    case 'brayden':
    case 'annabelle': return buildKid(name, hair);
    case 'zombie': return buildWalker();
    case 'sheep': return restModel('sheep');
    case 'pig': return restModel('pig');
    case 'honeyberry': return buildHoneyberry(st, paintBush());
    case 'honeyberry_far': return buildHoneyberryFar(st, paintBush());
    case 'sapling': return buildSapling(st, paintBush());
    default: throw new RangeError(`no pilot model ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Plants: foliage, not boulders — branches carrying whorls and tiers of LEAF CARDS (each a flat elongated hexagon,
// pointed at both ends, its two faces painted with a leaf and its veins), gaps between them, a small dark core of
// leaves inside so the bush has depth; bark; the honeyberry's elongated berries hanging under the leaves
// ---------------------------------------------------------------------------------------------------

const BUSH = Object.freeze({
  leaves: [0x8cbc5c, 0x5f923e, 0x3f6e2a, 0x24421a],
  young: [0xb0d878, 0x82b852, 0x5a8e36, 0x355a22],
  core: [0x4f7a34, 0x355a26, 0x24421a, 0x162c10],
  bark: [0x9a7a56, 0x75583c, 0x4e3a27],
  berry: [0xc6dcf6, 0x8eb0e2, 0x5a7cbc, 0x3c548c],
});

/**
 * Leaf pictures: three tints of one leaf (a base darker than its tip, a midrib, paired side veins, darker edges);
 * `berries` paints a cluster of honeyberries over the stalk end of the first two (the far bush carries its berries so).
 */
function paintLeaves(s, ramp, prefix, berries = null) {
  for (let k = 0; k < 3; k++) {
    s.plain(`${prefix}${k}`, 24, 40, (p) => {
      const base = mix(ramp[1], k === 0 ? ramp[0] : k === 1 ? ramp[2] : 0xb8c44c, k === 2 ? 0.25 : 0.4);
      p.fill((x, y) => mix(base, ramp[0], 0.45 * (1 - y / p.h)));
      p.mottle(0.06, 4);
      p.line(12, 2, 12, 39, 0.7, mix(ramp[0], 0xf0f6c8, 0.4), 0.85);
      for (let v = 0; v < 6; v++) {
        const y = 34 - v * 5.5;
        p.line(12, y, 3, y - 6, 0.45, mix(ramp[0], 0xf0f6c8, 0.25), 0.6).line(12, y, 21, y - 6, 0.45, mix(ramp[0], 0xf0f6c8, 0.25), 0.6);
      }
      p.ao({ left: 0.35, right: 0.35, width: 0.3 }).ao({ bottom: 0.3, width: 0.25 });
      if (berries && k < 2) {
        for (const [x, y] of [[8, 31], [13, 34], [16, 29], [10, 26]]) {
          p.ellipse(x, y, 2.6, 3.2, berries[2], 1).ellipse(x, y, 2.1, 2.7, berries[1], 1).ellipse(x - 0.8, y - 1, 0.8, 0.8, berries[0], 1);
        }
      }
    });
  }
}

function paintBush() {
  const B = BUSH;
  const s = new Skin(256, 256, 41);
  paintLeaves(s, B.leaves, 'leaf');
  paintLeaves(s, B.young, 'young');
  // the core: a tangle of dark leaves seen through the gaps
  s.plain('core', 64, 48, (p) => p.leaves(B.core, { size: 10, density: 1.3 }).shadeV(1.1, 0.75));
  paintLeaves(s, B.leaves, 'far', B.berry);
  s.wrap('bark', 32, 64, (p) => p.bark(B.bark).ao({ bottom: 0.4, width: 0.3 }), { top: (p) => p.bark(B.bark) });
  s.plain('berry', 16, 16, (p) => {
    p.fill(B.berry[1]);
    p.glow(6, 5, 6, B.berry[0], 0.8);
    p.glow(10, 11, 7, B.berry[3], 0.5);
    p.mottle(0.06, 2);
  });
  return s;
}

/**
 * A leaf card: a flat hexagon `len` long and `wid` wide, pointed at both ends — only its two faces (8 triangles); with
 * `sides` 4 a diamond (4 triangles: the far bush's).
 */
function leafCard(len, wid, sides = 6) {
  const g = prism({ sides, rx: wid / 2, rz: len / 2, h: 0.004, phase: 0 });
  const keep = [];
  for (let t = 0; t < g.index.length; t += 3) if (g.groups[g.index[t]] !== 0) keep.push(g.index[t], g.index[t + 1], g.index[t + 2]);
  // its length along +y from its stalk, its faces toward ±z
  return transform({ ...g, index: new Uint32Array(keep) }, mul(translation(0, len / 2, 0), rotation(0, -Math.PI / 2)));
}

/**
 * A whorl: `n` leaves springing from `at` round the stem, tilted `tilt` up from level (negative: drooping), the first
 * at `yaw`; `keys` picks each leaf's picture in turn.
 */
function whorl(add, at, n, len, wid, tilt, yaw, keys, sides = 6) {
  const card = leafCard(len, wid, sides);
  for (let k = 0; k < n; k++) {
    const a = yaw + (k / n) * Math.PI * 2 + 0.25 * Math.sin(k * 3.7);
    const tl = tilt + 0.12 * Math.sin(k * 5.3);
    const dir = [Math.cos(a) * Math.cos(tl), Math.sin(tl), Math.sin(a) * Math.cos(tl)];
    const base = [at[0] + dir[0] * 0.008, at[1] + dir[1] * 0.008, at[2] + dir[2] * 0.008];
    add(card, keys[k % keys.length], seg(base, [base[0] + dir[0], base[1] + dir[1], base[2] + dir[2]], null, { back: [0, 1, 0], roll: 0.35 * Math.sin(k * 2.3) }));
  }
}

/** A berry: a little elongated four-sided gem (10 triangles: it is tiny). */
function berry(S, r) {
  return S.col(r, r, [{ y: 0, sx: 0 }, { y: r * 1.1, sx: 1 }, { y: r * 2.2, sx: 0.4 }], { sides: 4, phase: 0, caps: { top: true, bottom: false } });
}

/** A twig of bark from a to b. */
const twig = (S, add, a, b, r, taper = 0.6) => add(S.col(r, r, [{ y: 0 }, { y: len(a, b), sx: taper }], { caps: false }), 'bark', seg(a, b));

/** The honeyberry bush's branch tips: five round it and one up the middle ([x, y, z, its angle round]). */
function bushTips() {
  const tips = [];
  for (let k = 0; k < 5; k++) {
    const a = k * 1.257 + 0.3;
    tips.push([Math.cos(a) * 0.24, 0.25 + 0.05 * Math.sin(k * 2.1), Math.sin(a) * 0.24, a]);
  }
  tips.push([0.02, 0.44, -0.01, 0.8]);
  return tips;
}

/** The honeyberry bush: a short trunk, a skirt of leaves, six branches with three tiers of leaves each, a dark core, berries. @param {Style} st @param {Skin} s */
function buildHoneyberry(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(S.col(0.036, 0.034, [{ y: 0, sx: 1.15 }, { y: 0.13, sx: 0.85 }], { caps: { top: false, bottom: true } }), 'bark', identity());
  // a small dark core: the shadowed inside of the bush, seen through the gaps between the leaves
  add(loft({ sides: 6, rx: 0.16, rz: 0.15, rings: [{ y: 0, sx: 0.5 }, { y: 0.08, sx: 1 }, { y: 0.2, sx: 0.85 }, { y: 0.27, sx: 0.35 }] }), 'core', translation(0, 0.08, 0));
  const leaves = ['leaf0', 'leaf1', 'leaf2'];
  const tips = bushTips();
  const root = [0, 0.12, 0];
  // a skirt of leaves round the foot, drooping to the ground: bushy at the bottom too
  whorl(add, [0, 0.08, 0], 8, 0.19, 0.1, -0.22, 0.1, leaves);
  tips.forEach(([x, y, z, a], i) => {
    const tip = [x, y, z];
    twig(S, add, root, tip, 0.014);
    // three tiers up each branch: a drooping skirt low down, a level ring, an upturned crown at the tip
    const at = (f) => [x * f, root[1] + (y - root[1]) * f, z * f];
    whorl(add, at(0.35), 4, 0.17, 0.09, -0.15, a + 0.8, leaves);
    whorl(add, at(0.68), 5, 0.18, 0.095, 0.2, a + 0.4, leaves);
    whorl(add, tip, 6, 0.19, 0.1, 0.5, a, leaves);
    add(leafCard(0.15, 0.08), leaves[i % 3], seg(tip, [tip[0] + Math.cos(a) * 0.3, tip[1] + 1, tip[2] + Math.sin(a) * 0.3], null, { back: [Math.cos(a), 0, Math.sin(a)] }));
    if (i < 5) {
      // berries hanging in threes under the tip's whorl
      for (let b = 0; b < 3; b++) {
        const ba = a + (b - 1) * 0.6;
        const p = [x + Math.cos(ba) * 0.035, y - 0.035 - (b % 2) * 0.015, z + Math.sin(ba) * 0.035];
        add(berry(S, 0.021), 'berry', compose({ t: p, r: [Math.PI + 0.3 * Math.sin(ba), 0, 0.3 * Math.cos(ba)] }));
      }
    }
  });
  return s.model(parts);
}

/**
 * The honeyberry bush past ~16 m: the same trunk and branches, a small core, and thirty big diamond leaves (three at
 * each tip, two halfway along) — its berries painted on the leaves — under 250 triangles, still a leafy bush.
 * @param {Style} st @param {Skin} s
 */
function buildHoneyberryFar(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(S.col(0.036, 0.034, [{ y: 0, sx: 1.15 }, { y: 0.13, sx: 0.85 }], { caps: false, phase: 0 }), 'bark', identity());
  add(loft({ sides: 6, rx: 0.18, rz: 0.16, phase: 0, rings: [{ y: 0, sx: 0.45 }, { y: 0.1, sx: 1 }, { y: 0.27, sx: 0.35 }] }), 'core', translation(0, 0.08, 0));
  const keys = ['far0', 'far1', 'far2'];
  const root = [0, 0.12, 0];
  bushTips().forEach(([x, y, z, a]) => {
    const tip = [x, y, z];
    add(S.col(0.016, 0.016, [{ y: 0 }, { y: len(root, tip), sx: 0.6 }], { caps: false, phase: 0 }), 'bark', seg(root, tip));
    whorl(add, [x * 0.55, root[1] + (y - root[1]) * 0.55, z * 0.55], 2, 0.24, 0.14, 0.15, a + 0.9, keys, 4);
    whorl(add, tip, 3, 0.27, 0.16, 0.5, a, keys, 4);
  });
  return s.model(parts);
}

/** A sapling: a slim trunk, three twigs, leaves in tiers up it and a crown of leaves at the top. @param {Style} st @param {Skin} s */
function buildSapling(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  const young = ['young0', 'young1', 'young2'];
  const top = [0.02, 0.8, -0.01];
  add(S.col(0.028, 0.028, [{ y: 0, sx: 1.2 }, { y: 0.4, sx: 0.8 }, { y: len([0, 0, 0], top), sx: 0.45 }]), 'bark', seg([0, 0, 0], top));
  whorl(add, top, 6, 0.17, 0.085, 0.45, 0.2, young);
  whorl(add, [0.017, 0.7, -0.008], 5, 0.16, 0.08, -0.1, 0.8, young);
  add(leafCard(0.16, 0.08), 'young0', seg(top, [top[0] + 0.2, top[1] + 1, top[2]], null, { back: [1, 0, 0] }));
  const twigs = [[[0.012, 0.46, 0], [-0.18, 0.6, 0.05], 1.4], [[0.016, 0.58, 0], [0.17, 0.7, -0.06], 4.5], [[0.008, 0.34, 0], [0.06, 0.42, 0.16], 2.8]];
  for (const [a, b, yaw] of twigs) {
    twig(S, add, a, b, 0.011);
    whorl(add, b, 5, 0.15, 0.075, 0.3, yaw, young);
  }
  // single leaves stepping up the trunk, turn by turn
  for (let k = 0; k < 3; k++) {
    const y = 0.22 + k * 0.13;
    const a = k * 2.4;
    add(leafCard(0.14, 0.07), young[k % 3], seg([0.01, y, 0], [0.01 + Math.cos(a), y + 0.4, Math.sin(a)], null, { back: [0, 1, 0] }));
  }
  return s.model(parts);
}
