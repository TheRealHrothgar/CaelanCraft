// Caelancraft — the zombies' models (PURE: typed arrays, no three, no DOM). See src/CONTRACTS.md §102 and
// docs/DESIGN-characters.md (phase 2).
//
// The three kinds are HEX-FACETED dead people, built from the figure kit like the avatars (figureKit.js): tapered
// hexagonal columns for the legs, the torso, the neck and the arms; a faceted head loft — gaunt: a narrow jaw, sunken
// cheeks, a long skull — with a heavy BROW (a chamfered bar standing out of the face plane) over narrow eye slits painted
// in sunken hollows; chamfered shoes and hands; hair as a scalp cap on the kind's own skull and a few clumps (zombieHair).
// Spooky, never frightening: no blood, no wounds, no bones, no fangs, and nothing red.
//   walker — vacant: average build, a faded flannel shirt (tinted per zombie), patched trousers frayed above a bare ankle,
//            old shoes, thin lank hair; level brows, empty slits, a slack mouth;
//   runner — wired: leaner, a torn tee with a faded band, track trousers ripped at the knee, worn sneakers, wild straw
//            hair swept one way; one brow hitched up, uneven slits with a pale pinprick each, a tight grimace;
//   alpha  — ominous: bigger and heavier (broad shoulders, thick limbs, a short neck), a long ragged dark coat open down
//            the front with long sleeves, heavy boots, long dark hair; a scowl drawn down to the nose, slanted slits.
// Each kind is FIVE parts, each in the frame of the joint it hangs from, exactly the joints zombieRenderer.js animates
// (instanced, one mesh per part): a LEG from its hip (drawn twice), the TORSO (the trousers' seat and the belt, the shirt,
// a collar; the alpha's coat) from the hips, an UPPER ARM (and its sleeve) from its shoulder and a FOREARM (and the hand)
// from its elbow (both drawn twice), the HEAD (the neck, the head, its features and hair) from the top of the torso. Every
// part is a closed solid wound outward, its uvs on the kind's ONE painted 256² atlas (paintKit: cloth weave, plaid, seams,
// patches, tears, frayed and see-through ragged hems — alpha 0 where cut away — and the face), and a GLOW image in step
// with it (what the eyes and a faint all-over night glow give off in the dark: zombieRenderer's emissive map). The cloth a
// zombie's shirt tint colours (SHIRT_TINTS) is marked in the atlas's alpha: TINT_ALPHA there, 255 everywhere else opaque.
import { loft, wedge, transform, merge, mul, translation, compose, triangleCount, bounds, wrapU } from './modelKit.js';
import { Painter, mix, shade, hash2, makeRng, createImage, bleed } from './paintKit.js';
import {
  STYLES, DENSITY, perimeter, Skin, shapes, headGeo, HEAD_CORNERS, FRONT, DEG, headRingAt, hairMass, hairline, clump,
  hairCentre,
} from './figureKit.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./modelKit.js').Mat4} Mat4 */
/** @typedef {import('./paintKit.js').Img} Img */
/** @typedef {import('./figureKit.js').HeadDims} HeadDims */
/** @typedef {'walker'|'runner'|'alpha'} ZombieKind */

/** The kinds, in the order the renderer builds them. */
export const ZOMBIE_MODEL_KINDS = Object.freeze(/** @type {ZombieKind[]} */ (['walker', 'runner', 'alpha']));
/** The parts, as the renderer instances them. */
export const ZOMBIE_PARTS = Object.freeze(['leg', 'upperArm', 'foreArm', 'torso', 'head']);
/** @typedef {'leg'|'upperArm'|'foreArm'|'torso'|'head'} ZombiePart */
/** Each kind's atlas (and glow image) is this many pixels square. */
export const ZOMBIE_ATLAS = 256;
/** The atlas alpha that marks the shirt cloth a zombie's tint colours (0.75: still well over the renderer's alphaTest). */
export const TINT_ALPHA = 191;
/** What the eyes give off in the dark: a faint marsh green, pale pinpricks, a pale gold (never red). */
export const EYE_GLOW = Object.freeze({ walker: 0x4f8a58, runner: 0xc4cb92, alpha: 0xbaa65a });
/**
 * The faint self-light every zombie has, so its shape — and its clothes — read on a moonlit night: the glow image is the
 * atlas's own colour × NIGHT_SELF_LIGHT, cooled by NIGHT_TINT (a texture, not a flat glow: a uniform one turns a zombie
 * into a glowing statue).
 */
export const NIGHT_SELF_LIGHT = 0.22;
export const NIGHT_TINT = 0xd8ffe4;

/** The gaunt head, chin to crown: [height share, width, depth, forward shift (m)] — a narrow jaw, hollow cheeks, a long skull. */
export const ZOMBIE_HEAD = Object.freeze([
  [0, 0.42, 0.5, -0.03], [0.13, 0.62, 0.74, -0.018], [0.3, 0.78, 0.88, -0.006], [0.47, 0.97, 0.96, 0],
  [0.6, 1.0, 1.0, -0.004], [0.72, 0.98, 1.0, 0.002], [0.87, 0.95, 1.03, 0.012], [0.96, 0.72, 0.78, 0.016], [1, 0.42, 0.46, 0.014],
]);
/** The alpha's: the same skull over a heavy, square jaw. */
export const ALPHA_HEAD = Object.freeze([
  [0, 0.6, 0.58, -0.03], [0.12, 0.8, 0.8, -0.02], [0.3, 0.9, 0.9, -0.006], [0.47, 0.98, 0.96, 0],
  [0.6, 1.0, 1.0, -0.004], [0.72, 0.98, 1.0, 0.002], [0.87, 0.95, 1.03, 0.012], [0.96, 0.72, 0.78, 0.016], [1, 0.42, 0.46, 0.014],
]);

/**
 * @typedef {Object} ZombieRig  the joints the renderer hangs the parts from (metres, before the kind's draw scale)
 * @property {number} legX      each hip joint from the middle
 * @property {number} legH      the hip joints' height over the feet (the legs' and the torso's origin)
 * @property {number} torsoH    the head's pivot (the neck's base) over the hips
 * @property {number} shoulderX each shoulder joint from the middle
 * @property {number} shoulderY the shoulders over the hips
 * @property {number} upperL    shoulder to elbow
 * @property {number} foreL     elbow to fingertips
 * @property {number} wristL    elbow to wrist
 */

/**
 * Every number of a kind's model. Metres; the rig is the renderer's, the rest the shapes on it.
 * @typedef {Object} Look
 */
const LOOKS = {
  walker: {
    seed: 13,
    rig: { legX: 0.1, legH: 0.84, torsoH: 0.58, shoulderX: 0.205, shoulderY: 0.515, upperL: 0.3, foreL: 0.34, wristL: 0.245 },
    ankle: 0.085,
    /** @type {HeadDims} */
    head: { y: 0.045, h: 0.335, rx: 0.145, rz: 0.155, eyeAt: 0.5, eyeX: 0.05, eyeW: 0.058, mouthAt: 0.2, noseAt: 0.36 },
    shape: ZOMBIE_HEAD,
    nose: [0.048, 0.032, 0.066],
    neck: 0.047,
    leg: { rx: 0.08, rz: 0.083, hem: 0.13 },
    shoe: [0.108, 0.082, 0.235],
    hips: { rx: 0.166, rz: 0.11, y0: -0.11, y1: 0.1 },
    shirt: { rx: 0.186, rz: 0.124, y0: -0.035, top: 0.555 },
    upper: { rx: 0.05, rz: 0.048 },
    sleeve: { len: 0.18, puff: 1.3 },
    fore: { rx: 0.043, rz: 0.041 },
    palm: [0.072, 0.078, 0.03],
    fingers: [0.064, 0.058, 0.026],
    flex: 0.32,
    pal: {
      skin: [0xb4c2ab, 0xa5b59d, 0x93a48c, 0x4a5847],
      hair: [0x5d5044, 0x463a30, 0x372d25, 0x2a221c],
      shirt: [0xd4d6d6, 0xbcc0c1, 0x979c9e], plaid: 0xe9e6dc,
      trousers: [0x5e6274, 0x4d5160, 0x3a3d48], patch: [0x8c7c5f, 0x7a6a50, 0x5c5040],
      shoe: [0x52423a, 0x372d26, 0x221c18], belt: 0x3a2e24, buckle: 0x8f8869, thread: 0xd8cfb4,
    },
  },
  runner: {
    seed: 29,
    rig: { legX: 0.095, legH: 0.84, torsoH: 0.58, shoulderX: 0.19, shoulderY: 0.515, upperL: 0.3, foreL: 0.34, wristL: 0.245 },
    ankle: 0.08,
    /** @type {HeadDims} */
    head: { y: 0.045, h: 0.325, rx: 0.138, rz: 0.15, eyeAt: 0.5, eyeX: 0.049, eyeW: 0.056, mouthAt: 0.2, noseAt: 0.36 },
    shape: ZOMBIE_HEAD,
    nose: [0.044, 0.03, 0.062],
    neck: 0.043,
    leg: { rx: 0.07, rz: 0.074, hem: 0.11 },
    shoe: [0.1, 0.075, 0.23],
    hips: { rx: 0.148, rz: 0.098, y0: -0.11, y1: 0.1 },
    shirt: { rx: 0.165, rz: 0.104, y0: -0.035, top: 0.555 },
    upper: { rx: 0.043, rz: 0.041 },
    sleeve: { len: 0.13, puff: 1.32 },
    fore: { rx: 0.038, rz: 0.036 },
    palm: [0.066, 0.074, 0.027],
    fingers: [0.06, 0.056, 0.024],
    flex: 0.2,
    pal: {
      skin: [0xc6c9a0, 0xb5b98e, 0xa2a67e, 0x575b3e],
      hair: [0xdcc488, 0xbaa264, 0x957f48, 0x6a5a34],
      shirt: [0xe0ded6, 0xcac8be, 0xa4a297], band: 0x9fa4a8,
      trousers: [0x6a5e50, 0x574d42, 0x433b33], patch: [0x8c7c5f, 0x7a6a50, 0x5c5040],
      shoe: [0x9a9a92, 0x77776f, 0x4a4a45], sole: 0xd8d4c4, thread: 0xd8cfb4,
    },
  },
  alpha: {
    seed: 47,
    rig: { legX: 0.112, legH: 0.84, torsoH: 0.565, shoulderX: 0.245, shoulderY: 0.5, upperL: 0.3, foreL: 0.35, wristL: 0.25 },
    ankle: 0.1,
    /** @type {HeadDims} */
    head: { y: 0.03, h: 0.34, rx: 0.152, rz: 0.158, eyeAt: 0.5, eyeX: 0.052, eyeW: 0.06, mouthAt: 0.2, noseAt: 0.36 },
    shape: ALPHA_HEAD,
    nose: [0.052, 0.036, 0.07],
    neck: 0.062,
    leg: { rx: 0.092, rz: 0.095, hem: 0.12 },
    shoe: [0.124, 0.11, 0.25],
    hips: { rx: 0.19, rz: 0.13, y0: -0.11, y1: 0.1 },
    shirt: { rx: 0.212, rz: 0.138, y0: -0.035, top: 0.54 },
    coat: { grow: 1.1, y0: -0.2 },
    upper: { rx: 0.064, rz: 0.061 },
    sleeve: { len: 0.32, puff: 1.22 },
    fore: { rx: 0.056, rz: 0.054 },
    palm: [0.086, 0.088, 0.036],
    fingers: [0.078, 0.064, 0.03],
    flex: 0.25,
    pal: {
      skin: [0x9eaba4, 0x8d9a94, 0x7c8983, 0x2c3431],
      hair: [0x4a4442, 0x383230, 0x2b2625, 0x1b1817],
      shirt: [0x6a6460, 0x58534f, 0x3e3a37],
      coat: [0x74665a, 0x5a4d43, 0x3d332c], lining: 0x2a2320,
      trousers: [0x44474e, 0x34363c, 0x24262b], patch: [0x5c5248, 0x4c443c, 0x3a332d],
      shoe: [0x3a2f27, 0x261f1a, 0x16120f], belt: 0x231c17, buckle: 0x6f6a55, thread: 0x8a8070,
    },
  },
};

/** A kind's rig (the renderer's joints). @param {ZombieKind} kind @returns {Readonly<ZombieRig>} */
export function zombieRig(kind) {
  return Object.freeze({ ...LOOKS[kindKey(kind)].rig });
}

/** @param {*} kind @returns {ZombieKind} */
function kindKey(kind) {
  return kind === 'runner' || kind === 'alpha' ? kind : 'walker';
}

// ---------------------------------------------------------------------------------------------------
// The face: sunken hollows round narrow slits under a heavy brow, hollow cheeks, a mouth by kind
// ---------------------------------------------------------------------------------------------------

/** @typedef {{ x: number, y: number, w: number, h: number, rot: number, glint: boolean, side: number }} Slit  an eye slit (pixels) */

/**
 * Paint a zombie's face over its rectangle (already skin): eye hollows, the slits (by kind), brows, bags under the eyes,
 * cheekbones over hollow cheeks, the nose's shadow, the mouth. Returns the slits' middles and sizes (local pixels), for
 * the glow image.
 * @param {Painter} p
 * @param {ZombieKind} kind
 * @param {{ skin: number[], hair: number[] }} pal
 * @param {{ eyeY: number, eyeGap: number, eyeW: number, mouthY: number }} f  shares of the rectangle
 * @returns {Slit[]}
 */
function paintZombieFace(p, kind, pal, f) {
  const W = p.w;
  const H = p.h;
  const skin = pal.skin;
  const deep = skin[3];
  const eyeY = f.eyeY * H;
  const gap = f.eyeGap * W;
  const ew = f.eyeW * W;
  const slits = [];
  // cheekbones lit, the cheeks under them hollow; a darker jaw line
  for (const side of [-1, 1]) {
    const cx = W / 2 + side * gap * 0.62;
    p.glow(cx, eyeY + ew * 0.95, ew * 0.75, skin[0], 0.45, ew * 0.32);
    p.glow(cx + side * ew * 0.08, eyeY + ew * 1.6, ew * 0.55, deep, 0.4, ew * 0.85);
  }
  p.glow(W / 2, H * 0.97, W * 0.42, deep, 0.25, H * 0.12);
  for (const side of [-1, 1]) {
    const cx = W / 2 + (side * gap) / 2;
    // the hollow: dark round the eye, deepest toward the nose and under the brow
    p.glow(cx - side * ew * 0.08, eyeY - ew * 0.05, ew * 1.0, deep, 0.85, ew * 0.66);
    p.glow(cx - side * ew * 0.18, eyeY - ew * 0.12, ew * 0.55, shade(deep, 0.7), 0.6, ew * 0.38);
    // a bag under it
    p.arc(cx, eyeY + ew * 0.12, ew * 0.42, Math.PI * 0.15, Math.PI * 0.85, 0.6, shade(deep, 0.85), 0.55, ew * 0.22);
    // the slit, by kind
    let sw = ew * 0.5;
    let sh = ew * 0.11;
    let rot = 0;
    let dy = 0;
    if (kind === 'runner') {
      sw = side < 0 ? ew * 0.5 : ew * 0.4;
      sh = side < 0 ? ew * 0.12 : ew * 0.15;
      dy = side < 0 ? 0 : -ew * 0.04;
    } else if (kind === 'alpha') {
      rot = side * 0.22; // slanted down toward the nose
    }
    p.ellipse(cx, eyeY + dy, sw * 0.62, sh * 1.9, shade(deep, 0.55), 0.6, rot);
    p.ellipse(cx, eyeY + dy, sw, sh, 0x0d0f0d, 1, rot);
    const glint = kind === 'runner';
    if (glint) p.ellipse(cx + side * sw * 0.18, eyeY + dy, Math.max(0.8, sh * 0.8), Math.max(0.8, sh * 0.8), 0xd9dfc0, 1);
    else p.ellipse(cx - side * sw * 0.12, eyeY + dy, sw * 0.32, Math.max(0.6, sh * 0.42), kind === 'alpha' ? 0x5a5236 : 0x52604e, 0.9, rot);
    slits.push({ x: cx, y: eyeY + dy, w: sw, h: sh, rot, glint, side });
    // the heavy lid over it
    p.line(cx - sw * 1.05, eyeY + dy - sh * 1.6 - side * rot * sw * 0.3, cx + sw * 1.05, eyeY + dy - sh * 1.6 + side * rot * sw * 0.3, 0.7, shade(deep, 0.7), 0.75);
    // brows
    const brow = pal.hair[3];
    const by = eyeY - ew * 0.62;
    if (kind === 'alpha') {
      // a scowl: drawn down hard toward the nose
      p.line(cx + side * ew * 0.62, by - ew * 0.12, cx - side * ew * 0.5, by + ew * 0.16, 1.4, brow, 0.95);
    } else if (kind === 'runner' && side > 0) {
      p.arc(cx, by + ew * 0.05, ew * 0.55, Math.PI * 1.1, Math.PI * 1.9, 1.0, brow, 0.9, ew * 0.32); // hitched up
    } else {
      p.line(cx - ew * 0.55, by, cx + ew * 0.5, by + ew * 0.03, 1.0, brow, 0.9);
    }
  }
  // the nose's shadow and a crease either side of it
  p.glow(W / 2 + W * 0.015, eyeY + ew * 1.05, ew * 0.42, deep, 0.45, ew * 0.24);
  const my = f.mouthY * H;
  for (const side of [-1, 1]) p.line(W / 2 + side * ew * 0.35, eyeY + ew * 0.9, W / 2 + side * ew * 0.58, my - ew * 0.15, 0.55, shade(deep, 0.9), 0.35);
  if (kind === 'walker') {
    // slack: hanging a little open, wider than it is tall, a little lower on one side
    p.ellipse(W / 2, my + ew * 0.02, ew * 0.6, ew * 0.12, 0x211b1a, 1, 0.06);
    p.ellipse(W / 2, my - ew * 0.12, ew * 0.5, ew * 0.05, shade(deep, 0.8), 0.6);
    p.ellipse(W / 2, my + ew * 0.24, ew * 0.42, ew * 0.07, shade(skin[0], 1.04), 0.55);
  } else if (kind === 'runner') {
    // a tight grimace: a dark line, a few pale teeth showing
    p.ellipse(W / 2, my, ew * 0.55, ew * 0.11, 0x211b1a, 1);
    for (let k = -2; k <= 2; k++) p.ellipse(W / 2 + k * ew * 0.17, my - ew * 0.01, ew * 0.065, ew * 0.06, 0xc8c2a6, 1);
    p.line(W / 2 - ew * 0.6, my + ew * 0.02, W / 2 + ew * 0.6, my + ew * 0.02, 0.5, 0x211b1a, 0.8);
  } else {
    // hard and set, its corners turned down
    p.polyline([[W / 2 - ew * 0.62, my + ew * 0.14], [W / 2 - ew * 0.42, my], [W / 2 + ew * 0.42, my], [W / 2 + ew * 0.62, my + ew * 0.14]], 0.9, 0x1a1514, 1);
    p.ellipse(W / 2, my + ew * 0.2, ew * 0.34, ew * 0.06, shade(skin[0], 1.04), 0.5);
  }
  return slits;
}

/**
 * The head's strip: `skinFn` fills it, the face goes on the front plane and the cheeks (as figureKit.headSkin), and the
 * slits are recorded in atlas pixels for the glow.
 * @param {Skin} s @param {HeadDims} H @param {ZombieKind} kind @param {*} pal
 * @param {(p: Painter) => void} skinFn
 * @param {Slit[]} eyesOut
 */
function zombieHeadSkin(s, H, kind, pal, skinFn, eyesOut) {
  const o = { corners: [...HEAD_CORNERS], rx: H.rx, rz: H.rz };
  const per = wrapU(o, 0).perimeter;
  s.wrap('head', Math.round(per * DENSITY.head), Math.round(H.h * DENSITY.head), (p) => {
    skinFn(p);
    const u0 = wrapU(o, (180 - 52) * DEG).u;
    const u1 = wrapU(o, (180 + 52) * DEG).u;
    const x0 = Math.round(u0 * p.w);
    const fw = Math.round(u1 * p.w) - x0;
    const fp = new Painter(p.img, [p.ox + x0, p.oy, fw, p.h], p.seed + 3);
    const a = Math.atan2(H.eyeX, H.rz * FRONT);
    const eyeU = (wrapU(o, Math.PI + a).u - wrapU(o, Math.PI - a).u) / (u1 - u0);
    fp.ao({ bottom: 0.2, width: 0.12 });
    // under the hairline the forehead is in the hair's shadow
    for (let y = 0; y < fp.h; y++) {
      const t = 1 - (y + 0.5) / fp.h; // height share up the head
      const k = t > 0.66 ? Math.min(1, (t - 0.66) / 0.14) : 0;
      if (k > 0) for (let x = 0; x < fp.w; x++) fp.tone(x, y, 1 - 0.22 * k * k);
    }
    const slits = paintZombieFace(fp, kind, pal, { eyeY: 1 - H.eyeAt, eyeGap: eyeU, eyeW: H.eyeW / per / (u1 - u0), mouthY: 1 - H.mouthAt });
    for (const e of slits) eyesOut.push({ ...e, x: e.x + fp.ox, y: e.y + fp.oy });
    p.ao({ bottom: 0.35, width: 0.1 });
  }, { cap: [10, 10] });
}

// ---------------------------------------------------------------------------------------------------
// The atlas
// ---------------------------------------------------------------------------------------------------

/** Earth and dust: soft smudges, more toward the bottom of the rectangle (`low` 0..1), never red. */
const GRIME = Object.freeze([0x5b4e3e, 0x6b6250, 0x4a4438]);
/** @param {Painter} p @param {number} n @param {number} low @param {number} seed */
function grime(p, n, low, seed) {
  const rnd = makeRng(seed);
  for (let i = 0; i < n; i++) {
    const y = p.h * (1 - low * rnd() ** 0.6);
    p.glow(rnd() * p.w, y, 2.5 + rnd() * 5, GRIME[i % GRIME.length], 0.18 + 0.14 * rnd(), 1.5 + rnd() * 3);
  }
}

/** Skin keys whose cloth the instance tint colours (walkers' and runners' shirts). */
const TINTED = Object.freeze(['shirt', 'sleeve', 'collar']);

/**
 * Paint a kind's atlas and its glow image.
 * @param {ZombieKind} kind
 * @returns {{ s: Skin, glow: Img }}
 */
function paintZombie(kind) {
  const L = LOOKS[kind];
  const P = L.pal;
  const D = DENSITY.body;
  const s = new Skin(ZOMBIE_ATLAS, ZOMBIE_ATLAS, L.seed);
  const skinR = P.skin;
  const mottled = (p) => {
    p.skin(skinR).mottle(0.1, 5);
    const rnd = makeRng(L.seed + 5);
    for (let i = 0; i < (p.w * p.h) / 150; i++) p.glow(rnd() * p.w, rnd() * p.h, 2 + rnd() * 4, skinR[2], 0.22);
  };
  /** @type {Slit[]} */
  const eyes = [];
  zombieHeadSkin(s, L.head, kind, P, (p) => {
    mottled(p);
    p.shadeV(1.04, 0.96);
  }, eyes);
  s.plain('skin', 32, 32, (p) => mottled(p));
  s.wrap('neck', Math.round(perimeter(L.neck, L.neck) * D), 14, (p) => {
    mottled(p);
    p.ao({ top: 0.45, width: 0.6, bottom: 0.4 });
  });
  const hairRamp = P.hair;
  s.plain('hair', 48, 48, (p) => p.hair(hairRamp, { dir: [0.15, 1], sheen: kind === 'runner' ? 0.35 : -1, strand: 2 }));
  // ---- the torso's cloth (the alpha's shirt too: its coat hangs open, so the shirt is the middle of its front)
  const tw = Math.round(perimeter(L.shirt.rx * 1.02, L.shirt.rz * 1.03) * D);
  const th = Math.round((L.shirt.top - L.shirt.y0) * D);
  if (kind === 'walker') {
    // faded flannel, buttoned down the front (one button gone), a sewn patch, two tears, its hem torn away
    const sh = P.shirt;
    s.wrap('shirt', tw, th, (p) => {
      p.plaid(sh, { cell: 11, band: 4, line: P.plaid });
      p.line(tw / 2 + 2.5, 6, tw / 2 + 2.5, th, 0.5, sh[2], 0.9);
      [0.2, 0.38, 0.56, 0.74].forEach((t, i) => {
        if (i === 2) p.line(tw / 2 - 1, th * t, tw / 2 + 1, th * t + 1, 0.4, P.thread, 0.9);
        else p.ellipse(tw / 2, th * t, 1.6, 1.6, 0xe0dccb, 1).ellipse(tw / 2, th * t, 0.55, 0.55, 0x6b6450, 1);
      });
      p.patch(tw * 0.63, th * 0.4, 9, 8, P.patch, P.thread);
      p.tear(tw * 0.36, th * 0.6, 3.2, sh);
      p.tear(tw * 0.9, th * 0.3, 2.6, sh);
      p.tear(tw * 0.12, th * 0.75, 2.2, sh);
      for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, sh, { stitch: false });
      grime(p, 10, 0.7, 31);
      p.shadeV(1.06, 0.84);
      p.ao({ top: 0.25, width: 0.12 });
      p.ragged({ edge: 'bottom', depth: 7, period: 3.5 });
    }, { cap: [36, 22], top: (p) => p.plaid(sh, { cell: 11, band: 4, line: P.plaid }).ellipse(18, 11, 7, 6, sh[2], 1).ellipse(18, 11, 5.4, 4.6, 0x2a2e2a, 1) });
    s.wrap('sleeve', Math.round(perimeter(L.upper.rx * L.sleeve.puff, L.upper.rz * L.sleeve.puff) * D), Math.round(L.sleeve.len * D), (p) => {
      p.plaid(sh, { cell: 11, band: 4, line: P.plaid });
      p.tear(p.w * 0.3, p.h * 0.45, 2, sh);
      p.shadeV(1.06, 0.88);
      p.ragged({ edge: 'bottom', depth: 6, period: 2.5 });
    }, { cap: [14, 14], top: (p) => p.plaid(sh, { cell: 11, band: 4, line: P.plaid }) });
    s.wrap('collar', Math.round(perimeter(L.neck * 1.9, L.neck * 1.7) * D), 6, (p) => p.plaid(sh, { cell: 11, band: 4, line: P.plaid }).shadeV(1.1, 0.8), { cap: [6, 6] });
  } else if (kind === 'runner') {
    // a thin tee with a faded band across the chest, a rip under one arm, its hem frayed and torn away at one side
    const sh = P.shirt;
    s.wrap('shirt', tw, th, (p) => {
      p.cloth(sh, { fold: 1.3 });
      const y = Math.round(th * 0.36);
      p.line(-1, y, tw + 1, y, 3.2, P.band, 0.75);
      for (const d of [-4.4, 4.4]) p.line(-1, y + d, tw + 1, y + d, 0.6, mix(P.band, sh[2], 0.5), 0.6);
      p.ellipse(tw / 2, -2, 9, 7, sh[2], 0.5);
      p.tear(tw * 0.22, th * 0.32, 3.4, sh);
      p.tear(tw * 0.7, th * 0.66, 2.6, sh);
      for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, sh, { stitch: false });
      grime(p, 9, 0.7, 37);
      p.shadeV(1.06, 0.84).ao({ top: 0.25, width: 0.12 });
      p.ragged({ edge: 'bottom', depth: 9, period: 4.5 });
    }, { cap: [32, 20], top: (p) => p.cloth(sh).ellipse(16, 10, 6.5, 5.5, sh[2], 1).ellipse(16, 10, 5, 4.2, 0x2a2e2a, 1) });
    s.wrap('sleeve', Math.round(perimeter(L.upper.rx * L.sleeve.puff, L.upper.rz * L.sleeve.puff) * D), Math.round(L.sleeve.len * D), (p) => {
      p.cloth(sh, { fold: 1.2 });
      p.shadeV(1.06, 0.9);
      p.ragged({ edge: 'bottom', depth: 5, period: 2 });
    }, { cap: [12, 12], top: (p) => p.cloth(sh) });
    s.wrap('collar', Math.round(perimeter(L.neck * 1.7, L.neck * 1.6) * D), 4, (p) => p.knit([sh[0], sh[1], sh[2]], { cell: 2 }).shadeV(1.05, 0.9), { cap: [6, 6] });
  } else {
    // a dark shirt under the coat, the coat itself: heavy wool, patched at an elbow, open down the front, its tails and
    // cuffs ragged (see-through where it is torn away)
    const sh = P.shirt;
    s.wrap('shirt', tw, th, (p) => {
      p.cloth(sh, { fold: 1.1 });
      // a button placket down the front: two seams, small dark buttons (a dark rim round a dull face: never a pale spot
      // that a mipmap smears into a glow), one gone, a loose thread where it was
      for (const d of [-2.6, 2.6]) p.line(tw / 2 + d, 0, tw / 2 + d, th, 0.5, sh[2], 0.9);
      [0.22, 0.4, 0.58, 0.76].forEach((t, i) => {
        if (i === 2) p.line(tw / 2 - 0.8, th * t, tw / 2 + 0.6, th * t + 1.4, 0.35, P.thread, 0.8);
        else p.ellipse(tw / 2, th * t, 1.6, 1.6, 0x1f1b19, 1).ellipse(tw / 2, th * t, 0.9, 0.9, shade(sh[1], 0.82), 1);
      });
      p.tear(tw * 0.3, th * 0.55, 2.4, sh);
      for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, sh, { stitch: false });
      grime(p, 8, 0.6, 33);
      p.shadeV(1.0, 0.84).ao({ top: 0.25, width: 0.12 });
      p.ragged({ edge: 'bottom', depth: 5, period: 3 });
    }, { cap: [8, 8] }); // (its top is under the coat's)
    const C = P.coat;
    const cw = Math.round(perimeter(L.shirt.rx * L.coat.grow, L.shirt.rz * L.coat.grow * 1.05) * D);
    const ch = Math.round((L.shirt.top + 0.02 - L.coat.y0) * D);
    s.wrap('coat', cw, ch, (p) => {
      p.cloth(C, { fold: 1.4, scale: 1.2 });
      for (const u of [0.25, 0.75]) p.seam(cw * u, 0, cw * u, ch, C);
      p.seam(cw * 0.5 - 9, ch * 0.5, cw * 0.5 - 9, ch, C, { stitch: false });
      p.seam(cw * 0.5 + 9, ch * 0.5, cw * 0.5 + 9, ch, C, { stitch: false });
      p.patch(cw * 0.12, ch * 0.42, 10, 9, P.patch, P.thread);
      p.tear(cw * 0.82, ch * 0.66, 3.2, C, P.lining);
      p.tear(cw * 0.3, ch * 0.78, 2.6, C, P.lining);
      // the lapels: lighter wool turned back either side of the opening
      for (const side of [-1, 1]) p.line(cw / 2 + side * 7.5, 0, cw / 2 + side * 6, ch * 0.42, 1.6, shade(C[0], 1.06), 0.8);
      // big buttons down one side of the opening, one hanging by a thread
      for (const t of [0.3, 0.46, 0.62]) p.ellipse(cw / 2 - 9.5, ch * t, 1.7, 1.7, 0x2c2622, 1).ellipse(cw / 2 - 9.8, ch * t - 0.4, 0.6, 0.6, 0x6a5e52, 1);
      p.line(cw / 2 + 9, ch * 0.3, cw / 2 + 9.5, ch * 0.36, 0.35, P.thread, 0.9).ellipse(cw / 2 + 9.6, ch * 0.37, 1.6, 1.6, 0x2c2622, 1);
      grime(p, 14, 0.45, 41);
      p.shadeV(1.05, 0.82);
      p.ragged({ edge: 'bottom', depth: 9, period: 4 });
      // open down the front: nothing there between the lapels (the shirt shows)
      for (let y = 0; y < ch; y++) {
        const half = 4.5 + 2.5 * (y / ch);
        for (let x = Math.floor(cw / 2 - half); x <= Math.ceil(cw / 2 + half); x++) p.clear(x, y);
      }
    }, { cap: [40, 24], top: (p) => p.cloth(C).ellipse(20, 12, 9, 7.5, P.lining, 1) });
    s.wrap('sleeve', Math.round(perimeter(L.upper.rx * L.sleeve.puff, L.upper.rz * L.sleeve.puff) * D), Math.round(L.sleeve.len * D), (p) => {
      p.cloth(C, { fold: 1.3 });
      p.patch(p.w * 0.6, p.h * 0.62, 8, 8, P.patch, P.thread);
      p.shadeV(1.05, 0.88);
    }, { cap: [16, 16], top: (p) => p.cloth(C) });
    s.wrap('cuff', Math.round(perimeter(L.fore.rx * 1.3, L.fore.rz * 1.3) * D), Math.round(0.17 * D), (p) => {
      p.cloth(C, { fold: 1.2 });
      p.shadeV(1.0, 0.9);
      p.ragged({ edge: 'bottom', depth: 6, period: 2.5 });
    }, { cap: [12, 12], top: (p) => p.cloth(C) });
    s.wrap('collar', Math.round(perimeter(L.neck * 1.8, L.neck * 1.7) * D), 8, (p) => p.cloth(C).shadeV(1.1, 0.86), { cap: [8, 8] });
  }
  // ---- the arms: skin to the shoulder (or a coat sleeve), the forearm and the hand
  if (L.sleeve.len < L.rig.upperL) {
    s.wrap('arm', Math.round(perimeter(L.upper.rx, L.upper.rz) * D), Math.round((L.rig.upperL + 0.04 - L.sleeve.len) * D), (p) => {
      mottled(p);
      p.ao({ top: 0.35, width: 0.4 });
    }, { top: mottled, bottom: mottled });
  }
  s.wrap('fore', Math.round(perimeter(L.fore.rx, L.fore.rz) * D), Math.round((L.rig.wristL + 0.03) * D), (p) => {
    mottled(p);
    p.ao({ top: 0.25, width: 0.3 });
  }, { top: mottled, bottom: mottled });
  s.plain('hand', 24, 24, (p) => {
    mottled(p);
    p.shadeV(1.02, 0.8);
    for (const y of [9, 16]) p.line(2, y, 22, y, 0.45, skinR[2], 0.4);
  });
  // ---- below: the trousers' seat and belt, the legs, the ankles, the shoes
  const T = P.trousers;
  const jD = kind === 'alpha' ? D / 2 : D; // (under the alpha's coat: only the belt shows, in its opening)
  const jw = Math.round(perimeter(L.hips.rx, L.hips.rz) * jD);
  const jh = Math.round((L.hips.y1 - L.hips.y0) * jD);
  s.wrap('hips', jw, jh, (p) => {
    p.cloth(T, { fold: 1 });
    if (P.belt !== undefined) {
      p.fill((x, y) => (y < 6 ? shade(P.belt, 0.9 + 0.15 * hash2(x, y, 3)) : p.get(x, y)));
      p.ellipse(jw / 2, 3, 3, 2.3, P.buckle, 1).ellipse(jw / 2, 3, 1.6, 1.0, P.belt, 1);
    } else {
      // a drawstring waist
      p.fill((x, y) => (y < 5 ? shade(T[1], 0.92 + 0.1 * hash2(x, y, 3)) : p.get(x, y)));
      p.line(jw / 2 - 2, 3, jw / 2 - 3, 9, 0.5, 0xd8d4c4, 0.9).line(jw / 2 + 2, 3, jw / 2 + 3, 10, 0.5, 0xd8d4c4, 0.9);
    }
    for (const u of [0.25, 0.75]) p.seam(jw * u, 6, jw * u, jh, T);
    p.ao({ bottom: 0.2, width: 0.25 });
  });
  const legLen = L.rig.legH - L.leg.hem + 0.05;
  const lw = Math.round(perimeter(L.leg.rx, L.leg.rz) * D);
  const lh = Math.round(legLen * D);
  s.wrap('leg', lw, lh, (p) => {
    p.cloth(T, { fold: 1.2 });
    for (const u of [0.25, 0.75]) p.seam(lw * u, 0, lw * u, lh, T, { stitch: false });
    if (kind === 'walker') {
      // a patched knee (on the outside of the right leg, the inside of the left), worn paler and torn lower down
      p.patch(lw * 0.62, lh * 0.42, 11, 10, P.patch, P.thread);
      p.glow(lw * 0.2, lh * 0.5, 7, T[0], 0.45, 9).tear(lw * 0.18, lh * 0.72, 2.4, T);
    } else if (kind === 'runner') {
      // track trousers: a pale stripe down the outside, ripped open at the knee
      p.line(lw * 0.75, 0, lw * 0.75, lh, 1.2, 0xc9c4b2, 0.75);
      p.tear(lw * 0.45, lh * 0.5, 4, T, skinR[2]);
      p.tear(lw * 0.1, lh * 0.62, 2.4, T);
    } else {
      p.patch(lw * 0.3, lh * 0.36, 10, 10, P.patch, P.thread);
      p.tear(lw * 0.7, lh * 0.7, 2.6, T);
    }
    grime(p, 12, 0.5, 43 + kind.length);
    p.shadeV(0.9, 1.0);
    p.ao({ top: 0.3, width: 0.12 });
    p.ragged({ edge: 'bottom', depth: kind === 'alpha' ? 3 : 5, period: 2 });
  });
  s.wrap('ankle', Math.round(perimeter(L.leg.rx * 0.6, L.leg.rx * 0.6) * D), 12, (p) => {
    mottled(p);
    p.ao({ bottom: 0.5, width: 0.5, top: 0.3 });
  });
  const [shw, shh, shd] = L.shoe;
  const S = P.shoe;
  const DS = 128;
  s.box('shoe', Math.round(shw * DS), Math.round(shh * DS), Math.round(shd * DS), {
    all: (p) => {
      p.cloth([S[0], S[1], S[2]], { fold: 1.2 }).mottle(0.12, 3);
      const sole = P.sole ?? shade(S[2], 0.85);
      p.fill((x, y) => (y > p.h - 4 ? shade(sole, 0.9 + 0.2 * hash2(x, y, 9)) : p.get(x, y)));
      p.stitches(0, p.h - 6, p.w, p.h - 6, shade(S[0], 1.2), { a: 0.5 });
      p.shadeV(1.05, 0.9);
    },
    top: (p) => {
      p.cloth([S[0], S[1], S[2]], { fold: 1.2 }).mottle(0.12, 3);
      for (let k = 0; k < 3; k++) p.line(p.w * 0.3, p.h * (0.42 + 0.1 * k), p.w * 0.7, p.h * (0.44 + 0.1 * k), 0.6, 0x1a1512, 0.9);
    },
  });
  s.pack();
  // the cloth the tint colours
  if (kind !== 'alpha') {
    for (const key of TINTED) {
      const e = s.entries.get(key);
      if (!e) continue;
      for (const j of e.jobs) {
        const [x0, y0, w, h] = /** @type {number[]} */ (j.rect);
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            const i = (y * ZOMBIE_ATLAS + x) * 4 + 3;
            if (s.atlas.img.data[i] >= 128) s.atlas.img.data[i] = TINT_ALPHA;
          }
        }
      }
    }
    s.atlas.bleedAll();
  }
  return { s, glow: paintGlow(s, eyes, EYE_GLOW[kind]) };
}

/**
 * The glow image in step with the atlas: the atlas's own colour dimmed (NIGHT_SELF_LIGHT, NIGHT_TINT) wherever it is
 * opaque, the eye slits in their colour over that (a runner's on its pinpricks only), nothing where it is cut away.
 * @param {Skin} s
 * @param {Slit[]} eyes
 * @param {number} color
 * @returns {Img}
 */
function paintGlow(s, eyes, color) {
  const img = s.atlas.img;
  const glow = createImage(img.width, img.height);
  const g = new Painter(glow, [0, 0, glow.width, glow.height], 1);
  for (const e of eyes) {
    if (e.glint) {
      const r = Math.max(1, e.h * 0.9);
      g.ellipse(e.x + e.side * e.w * 0.18, e.y, r, r, color, 1);
    } else {
      g.ellipse(e.x, e.y, e.w * 0.92, Math.max(1, e.h * 0.95), color, 1, e.rot);
    }
  }
  const tint = [(NIGHT_TINT >> 16) & 255, (NIGHT_TINT >> 8) & 255, NIGHT_TINT & 255].map((c) => (c / 255) * NIGHT_SELF_LIGHT);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      glow.data[i + c] = img.data[i + 3] < 128 ? 0 : Math.max(glow.data[i + c], Math.round(img.data[i + c] * tint[c]));
    }
    glow.data[i + 3] = 255;
  }
  for (const r of s.atlas.rects) bleed(glow, r, s.atlas.pad);
  return glow;
}

// ---------------------------------------------------------------------------------------------------
// The hair: a scalp CAP that hugs the kind's own skull, and a few CLUMPS lying on it (pass 3 of the pilot: silhouette
// first — never a helmet or a crown of spikes)
// ---------------------------------------------------------------------------------------------------

/** A point on the skull for a clump: [yaw, pitch, lift], a pitch past 90° going on over the crown to the far side. */
const over = (yaw, pitch, lift) => (pitch > 90 ? [(yaw + 180) % 360, 180 - pitch, lift] : [yaw, pitch, lift]);

/** Each kind's scalp cap: its hairline (pitch by yaw from the back, mirrored) and how far it stands off the skull. */
const CAPS = Object.freeze({
  // thin and receding: high at the temples, a little peak in the middle, low at the nape; lying flat
  walker: { rim: hairline([[0, -20], [45, -9], [80, 8], [100, 10], [128, 22], [150, 30], [166, 30], [180, 28]]), off: (yaw, pitch, s) => 0.013 + 0.01 * s },
  // a full head of straw, close to the skull (its clumps give it its shape)
  runner: { rim: hairline([[0, -22], [45, -12], [80, 6], [100, 8], [130, 18], [160, 24], [180, 26]]), off: (yaw, pitch, s) => 0.014 + 0.012 * s },
  // long and heavy: down over the tops of the ears and low at the nape
  alpha: { rim: hairline([[0, -26], [45, -14], [80, -4], [100, -2], [130, 16], [160, 23], [180, 24]]), off: (yaw, pitch, s) => 0.014 + 0.018 * s },
});
/**
 * The cap's points round — over each of the head's corners, straight behind and straight ahead (the head is flat between
 * its corners, so no more are needed) — and its rings, hairline to crown, placed so that no ridge of the gaunt skull
 * (its widest ring, at 0.87 of its height) shows between them: zombieHairGaps.
 */
const ZOMBIE_CAP_YAWS = Object.freeze([0, ...HEAD_CORNERS.map((a) => Math.round(a / DEG)), 180].sort((a, b) => a - b));
const ZOMBIE_CAP_RINGS = Object.freeze([0, 0.1, 0.2, 0.4, 0.55, 1]);

/**
 * A kind's hair in its head's frame (the chin at the origin), built against the kind's own head loft (`ZOMBIE_HEAD` or
 * `ALPHA_HEAD`), so the skull never shows through it:
 *   walker — thin and lank: a receding cap lying flat, two lank strands over the brow, straggles over the ears and at
 *            the nape;
 *   runner — wild straw: a cap and big flat clumps swept back over the crown and to its left, their tips lifting off;
 *   alpha  — long and dark: a cap down over the ears, two locks over the brow, a lock framing the face either side and
 *            two heavy ones hanging behind to the shoulders.
 * @param {ZombieKind} kind
 * @returns {{ cap: Geo, clumps: Geo[] }}
 */
export function zombieHair(kind) {
  const k = kindKey(kind);
  const L = LOOKS[k];
  const H = L.head;
  const shape = L.shape;
  const cap = CAPS[k];
  const capGeo = hairMass(H, shape, { yaws: [...ZOMBIE_CAP_YAWS], rim: cap.rim, off: cap.off, rings: ZOMBIE_CAP_RINGS });
  const cc = hairCentre(H);
  /** out from the cranium, but level below it (a lock hanging free faces out, not down) */
  const outward = (c) => [c[0] - cc[0], Math.max(0, c[1] - cc[1]), c[2] - cc[2]];
  /** @type {Geo[]} */
  const clumps = [];
  const lank = [0.75, 1, 0];
  if (k === 'walker') {
    // two lank strands over the brow, from the cap's front down to the brow
    clumps.push(clump(H, shape, cap, [[188, 52], [191, 34, 0.003], [194, 19, 0.004]], { w: 0.052, t: 0.014, profile: lank }));
    clumps.push(clump(H, shape, cap, [[163, 50], [161, 33, 0.003], [158, 21, 0.004]], { w: 0.044, t: 0.014, profile: lank }));
    // straggles over the ears, and at the nape
    for (const side of [-1, 1]) {
      for (const [yaw, len] of [[76, 22], [112, 16]]) {
        const y = side > 0 ? yaw : 360 - yaw;
        const d = side * 4;
        clumps.push(clump(H, shape, cap, [[y, 24], [y + d, 2, 0.004], [y + 2 * d, -len, 0.01]], { w: 0.05, t: 0.014, profile: lank, up: outward }));
      }
    }
    clumps.push(clump(H, shape, cap, [[352, 4], [356, -18, 0.004], [2, -36, 0.01]], { w: 0.066, t: 0.014, profile: lank, up: outward }));
  } else if (k === 'runner') {
    // every clump flows ONE way — across from its right and back to its left — lying on the cap, and only its tip lifts off
    const swept = [0.6, 1, 0.85, 0];
    const t = 0.018;
    // a messy fringe: two clumps from the top swept down across the brow to the left temple, the tips flicking up off it
    clumps.push(clump(H, shape, cap, [[150, 74], [176, 56, 0.004], [204, 40, 0.008], [224, 31, 0.03]], { w: 0.1, t, profile: swept }));
    clumps.push(clump(H, shape, cap, [[124, 62], [150, 46, 0.004], [178, 35, 0.006], [198, 27, 0.026]], { w: 0.09, t, profile: swept }));
    // over the crown from the front to the back on the left, the tip flicked out behind
    clumps.push(clump(H, shape, cap, [over(184, 68), over(164, 98, 0.006), over(144, 124, 0.012), over(130, 144, 0.05)], { w: 0.12, t, profile: swept }));
    // the sides: back along the left side and back over the right side, their tips flicked out behind
    clumps.push(clump(H, shape, cap, [[238, 30], [264, 38, 0.006], [298, 40, 0.012], [326, 34, 0.046]], { w: 0.11, t, profile: swept }));
    clumps.push(clump(H, shape, cap, [[118, 28], [92, 42, 0.006], [60, 50, 0.012], [30, 54, 0.046]], { w: 0.11, t, profile: swept }));
    // a cowlick at the crown, flicked out to the left behind
    clumps.push(clump(H, shape, cap, [over(80, 82), [20, 70, 0.008], [334, 58, 0.016], [306, 48, 0.056]], { w: 0.1, t, profile: swept }));
  } else {
    // two locks over the brow
    clumps.push(clump(H, shape, cap, [[192, 52], [196, 32, 0.004], [199, 17, 0.006]], { w: 0.056, t: 0.016, profile: lank }));
    clumps.push(clump(H, shape, cap, [[164, 50], [160, 31, 0.004], [156, 19, 0.006]], { w: 0.05, t: 0.016, profile: lank }));
    // a lock framing the face either side, down past the ear to the collar
    const long = [0.85, 1, 0];
    for (const side of [-1, 1]) {
      clumps.push(clump(H, shape, cap, [[side > 0 ? 116 : 244, 40], [side > 0 ? 96 : 264, -2, 0.01], ['p', side * (H.rx + 0.02), -0.035, 0.012]],
        { w: 0.085, t: 0.02, profile: long, up: outward }));
    }
    // two heavy locks hanging behind to the shoulders
    for (const yaw of [336, 24]) {
      const a = yaw * DEG;
      clumps.push(clump(H, shape, cap, [[yaw, 52], [yaw, 2, 0.01], ['p', Math.sin(a) * (H.rx + 0.03), -0.045, Math.cos(a) * (H.rz + 0.05)]],
        { w: 0.13, t: 0.024, profile: long, up: outward }));
    }
  }
  return { cap: capGeo, clumps };
}

/**
 * Whether the skull shows through a kind's hair: how many of its head loft's corners above the hairline lie outside the
 * cap (looking out from the middle of the cranium; avatarModel.hairGaps' test). 0 for every kind, or the hair has a gap.
 * @param {ZombieKind} kind
 * @returns {number}
 */
export function zombieHairGaps(kind) {
  const k = kindKey(kind);
  const H = LOOKS[k].head;
  const shell = zombieHair(k).cap;
  const head = headGeo(H, LOOKS[k].shape);
  const c = hairCentre(H);
  const P = (g, i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  /** the farthest crossing of the cap along a ray from the middle, and whether it is the cap's side (not its rim) */
  const outer = (d) => {
    let best = -Infinity;
    let side = false;
    for (let t = 0; t < shell.index.length; t += 3) {
      const [a, b, e] = [P(shell, shell.index[t]), P(shell, shell.index[t + 1]), P(shell, shell.index[t + 2])];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
      const q = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * q[0] + e1[1] * q[1] + e1[2] * q[2];
      if (Math.abs(det) < 1e-12) continue;
      const sv = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const u = (sv[0] * q[0] + sv[1] * q[1] + sv[2] * q[2]) / det;
      if (u < 0 || u > 1) continue;
      const r = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]];
      const v = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const dist = (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]) / det;
      if (dist > best) {
        best = dist;
        side = shell.groups[shell.index[t]] === 0;
      }
    }
    return { best, side };
  };
  let gaps = 0;
  for (let i = 0; i < head.positions.length / 3; i++) {
    const p = P(head, i);
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const hit = outer([d[0] / len, d[1] / len, d[2] / len]);
    if (hit.side && hit.best < len - 1e-4) gaps++;
  }
  return gaps;
}

// ---------------------------------------------------------------------------------------------------
// The parts, joint by joint
// ---------------------------------------------------------------------------------------------------

/**
 * A built kind.
 * @typedef {Object} ZombieModel
 * @property {ZombieKind} kind
 * @property {Record<ZombiePart, Geo>} parts  each in its joint's frame (the leg from its hip, the torso from the hips, an
 *   upper arm from its shoulder, a forearm from its elbow, the head from the top of the torso), at rest hanging straight
 * @property {Readonly<ZombieRig>} rig
 * @property {Img} image       the atlas (sRGB bytes, row 0 at the top: a DataTexture with flipY off)
 * @property {Img} glow        what shines in the dark, in step with the atlas
 * @property {number} tris     one zombie's triangles (the leg and the arms counted twice)
 * @property {number} texels   pixels painted
 * @property {Record<string, [number, number, number, number]>} rects  each skin's main rectangle in the atlas (x, y, w, h:
 *   a wrap's strip, a box's first face, a plain's one), for the tests
 * @property {[number, number]} atlas
 * @property {{ headW: number, headD: number, headH: number, eyeY: number, foreW: number, height: number }} dims  for the
 *   renderer and its tests: the head's bounds in its frame (width, depth, pivot to crown), the eyes' height over the pivot,
 *   the forearm's width, the top of the model over the feet at rest
 */

/**
 * Build a kind's model.
 * @param {ZombieKind} kind
 * @returns {ZombieModel}
 */
export function buildZombieModel(kind) {
  const k = kindKey(kind);
  const L = LOOKS[k];
  const R = L.rig;
  const { s, glow } = paintZombie(k);
  const S = shapes(STYLES.hex);
  /** @type {Record<ZombiePart, Geo[]>} */
  const parts = { leg: [], upperArm: [], foreArm: [], torso: [], head: [] };
  /** @param {ZombiePart} part */
  const on = (part) => (geo, key, M) => parts[part].push(s.place(geo, key, M));

  // ---- the leg, from its hip: the shoe, a bare ankle, the trouser leg (its hem ragged above the ankle) up into the seat
  {
    const add = on('leg');
    const foot = -R.legH;
    const [shw, shh, shd] = L.shoe;
    add(S.block(shw, shh, shd, { top: { sx: 0.88, sz: 0.8, dz: 0.022 } }), 'shoe', translation(0, foot + shh / 2, -0.035));
    add(S.col(L.leg.rx * 0.6, L.leg.rx * 0.6, [{ y: 0 }, { y: L.leg.hem + 0.04 - shh * 0.6, sx: 1.05 }], { caps: false }), 'ankle', translation(0, foot + shh * 0.6, 0.004));
    const len = R.legH - L.leg.hem + 0.05;
    add(S.col(L.leg.rx, L.leg.rz, [
      { y: 0, sx: k === 'runner' ? 0.92 : 0.86 }, { y: 0.24 * len, sx: 0.8 }, { y: 0.48 * len, sx: 0.86 },
      { y: 0.76 * len, sx: 0.98 }, { y: len, sx: 1 },
    ], { caps: { top: true, bottom: false } }), 'leg', translation(0, foot + L.leg.hem, 0));
  }

  // ---- the torso, from the hips: the trousers' seat and belt, the shirt over it, a collar; the alpha's coat
  {
    const add = on('torso');
    add(S.col(L.hips.rx, L.hips.rz, [{ y: 0, sx: 0.96 }, { y: L.hips.y1 - L.hips.y0 }]), 'hips', translation(0, L.hips.y0, 0));
    const sh = L.shirt;
    const h = sh.top - sh.y0;
    const rings = [
      { y: 0, sx: 1.04, sz: 1.04 }, { y: 0.18 * h, sx: 0.93, sz: 0.97 }, { y: 0.55 * h, sx: 1.0, sz: 1.08, dz: 0.004 },
      { y: 0.86 * h, sx: 1.03, sz: 1.04, dz: 0.014 }, { y: h, sx: 0.66, sz: 0.74, dz: 0.012 },
    ];
    add(S.col(sh.rx, sh.rz, rings, { caps: { top: true, bottom: false } }), 'shirt', translation(0, sh.y0, 0));
    if (L.coat) {
      const g = L.coat.grow;
      const ch = sh.top + 0.02 - L.coat.y0;
      const y0 = L.coat.y0;
      // the coat hangs from the shoulders: its tails flare a little below the hips
      add(S.col(sh.rx * g, sh.rz * g * 1.05, [
        { y: 0, sx: 1.1, sz: 1.06 }, { y: (sh.y0 - y0) * 0.9, sx: 0.98 }, { y: (sh.y0 - y0) + 0.18 * h, sx: 0.92, sz: 0.96 },
        { y: (sh.y0 - y0) + 0.55 * h, sx: 1.0, sz: 1.06, dz: 0.004 }, { y: (sh.y0 - y0) + 0.84 * h, sx: 1.0, sz: 1.04, dz: 0.014 },
        { y: ch, sx: 0.66, sz: 0.76, dz: 0.012 },
      ], { caps: { top: true, bottom: false } }), 'coat', translation(0, y0, 0));
    }
    // the collar: a ring round the neck's base — a flannel collar folded down, a tee's neckline, the alpha's turned up
    const top = sh.top;
    if (k === 'alpha') {
      add(S.col(L.neck * 1.75, L.neck * 1.6, [{ y: 0, sx: 1 }, { y: 0.075, sx: 1.12 }], { caps: { top: false, bottom: false } }), 'collar', translation(0, top - 0.02, 0.012));
    } else {
      const tall = k === 'walker' ? 0.045 : 0.022;
      add(S.col(L.neck * 1.7, L.neck * 1.55, [{ y: 0, sx: k === 'walker' ? 1.25 : 1.08 }, { y: tall, sx: 1 }], { caps: { top: false, bottom: false } }), 'collar',
        translation(0, top - 0.026, 0.01));
    }
  }

  // ---- the upper arm, from its shoulder: the arm (rounded over the shoulder), its sleeve
  {
    const add = on('upperArm');
    const uL = R.upperL;
    const U = L.upper;
    const pl = L.sleeve.len;
    const pf = L.sleeve.puff;
    const long = pl >= uL; // a coat sleeve to the elbow: no bare arm, the sleeve closed below
    // the bare arm, from inside the sleeve down to the elbow, rounded under it
    if (!long) add(S.col(U.rx, U.rz, [{ y: 0, sx: 0.6 }, { y: 0.025, sx: 0.92 }, { y: uL + 0.04 - pl, sx: 1 }], { caps: { top: false, bottom: true } }), 'arm', translation(0, -uL - 0.025, 0));
    const cap = long ? { y: pl + 0.032, sx: 0.62, sz: 0.68 } : { y: pl + 0.05, sx: 0.55, sz: 0.62 };
    add(S.col(U.rx * pf, U.rz * pf, [{ y: 0, sx: 1.06 }, { y: pl * 0.6, sx: 1.0 }, { y: pl, sx: 0.96 }, cap], { caps: { top: true, bottom: long } }),
      'sleeve', translation(0, -pl + 0.012, 0));
  }

  // ---- the forearm, from its elbow: the arm to the wrist (a coat cuff on the alpha) and the hand, limp and curled
  {
    const add = on('foreArm');
    const F = L.fore;
    const wL = R.wristL;
    add(S.col(F.rx, F.rz, [{ y: 0, sx: 0.78 }, { y: wL * 0.45, sx: 0.86 }, { y: wL, sx: 1 }, { y: wL + 0.03, sx: 0.86 }]), 'fore', translation(0, -wL, 0));
    if (k === 'alpha') {
      add(S.col(F.rx * 1.3, F.rz * 1.3, [{ y: 0, sx: 1.08 }, { y: 0.12, sx: 1 }, { y: 0.17, sx: 0.85 }], { caps: { top: true, bottom: false } }), 'cuff', translation(0, -0.15, 0));
    }
    const [pw, ph, pd] = L.palm;
    const [fw, fh, fd] = L.fingers;
    // the hand at the wrist, flexed forward (−z: when the arm is held out it hangs from the wrist), fingers curled further
    // (flattened hex columns: a palm, and the fingers together, curled)
    const hand = mul(translation(0, -wL + 0.01, 0), compose({ r: [L.flex, 0, 0] }));
    add(S.col(pw / 2, pd / 2, [{ y: 0, sx: 0.96 }, { y: ph * 0.6, sx: 1.04 }, { y: ph, sx: 0.84, sz: 0.9 }]), 'hand', mul(hand, translation(0, -ph, 0)));
    add(S.col(fw / 2, fd / 2, [{ y: 0, sx: 0.78, sz: 0.8 }, { y: fh, sx: 1 }]), 'hand',
      mul(hand, mul(compose({ t: [0, -ph + 0.01, -0.002], r: [0.55, 0, 0] }), translation(0, -fh, 0))));
  }

  // ---- the head, from the top of the torso: the neck, the head loft, the brow, the nose, the ears, the hair
  const H = L.head;
  const shape = L.shape;
  {
    const add = on('head');
    add(S.col(L.neck, L.neck * 0.95, [{ y: 0 }, { y: H.y + 0.06, sx: 0.92 }], { caps: false }), 'neck', translation(0, -0.06, 0.004));
    const M = translation(0, H.y, 0);
    add(headGeo(H, shape), 'head', M);
    // the nose: a wedge out of the face plane, its ridge low (the tip)
    const nz = -H.rz * FRONT * headRingAt(shape, L.head.noseAt)[1] + headRingAt(shape, L.head.noseAt)[2];
    add(wedge({ w: L.nose[0], h: L.nose[1], d: L.nose[2], ridge: -0.45, sx: 0.35 }), 'skin', mul(M, compose({ t: [0, H.noseAt * H.h, nz + 0.006], r: [-Math.PI / 2, 0, 0] })));
    // the ears
    for (const side of [-1, 1]) {
      const ear = loft({ sides: 6, rx: 0.04, rz: 0.03, rings: [{ y: 0 }, { y: 0.022, sx: 0.7, sz: 0.68 }], caps: { top: true, bottom: false } });
      const [sx] = headRingAt(shape, H.eyeAt - 0.07);
      add(ear, 'skin', mul(M, compose({ t: [side * (H.rx * sx * 0.97 - 0.006), (H.eyeAt - 0.07) * H.h, 0.012], r: [0, 0, -side * Math.PI / 2] })));
    }
    // the heavy brow: a wedge on the face plane over the eyes — its ridge is its lower edge, an overhang that shades the
    // slits, and its top slopes back into the forehead (the alpha's two, in a V: a scowl)
    const ridgeY = H.eyeAt * H.h + 0.022;
    const bd = 0.044;
    const [, bsz, bdz] = headRingAt(shape, ridgeY / H.h);
    const bz = -H.rz * FRONT * bsz + bdz;
    const bw = 2 * (H.eyeX + H.eyeW * 0.66);
    if (k === 'alpha') {
      for (const side of [-1, 1]) {
        add(wedge({ w: bw / 2 + 0.018, h: 0.024, d: bd, ridge: -1, sx: 0.85 }), 'skin',
          mul(M, mul(compose({ t: [side * bw * 0.25, ridgeY + bd / 2 - 0.004, bz + 0.003], r: [0, 0, side * 0.24] }), compose({ r: [-Math.PI / 2, 0, 0] }))));
      }
    } else {
      add(wedge({ w: bw, h: k === 'runner' ? 0.016 : 0.02, d: bd, ridge: -1, sx: 0.82 }), 'skin',
        mul(M, compose({ t: [0, ridgeY + bd / 2, bz + 0.003], r: [-Math.PI / 2, 0, k === 'runner' ? 0.05 : 0] })));
    }
    // the hair: a scalp cap over the head's own loft, and clumps lying on it (zombieHair)
    const hair = zombieHair(k);
    for (const g of [hair.cap, ...hair.clumps]) add(g, 'hair', M);
  }

  /** @type {Record<string, Geo>} */
  const merged = {};
  let tris = 0;
  for (const p of ZOMBIE_PARTS) {
    const g = merge(parts[/** @type {ZombiePart} */ (p)]);
    merged[p] = g;
    tris += triangleCount(g) * (p === 'leg' || p === 'upperArm' || p === 'foreArm' ? 2 : 1);
  }
  const hb = bounds(merged.head);
  const fb = bounds(merged.foreArm);
  const dims = {
    headW: hb.max[0] - hb.min[0],
    headD: hb.max[2] - hb.min[2],
    headH: hb.max[1],
    eyeY: H.y + H.eyeAt * H.h,
    foreW: Math.max(fb.max[0] - fb.min[0], fb.max[2] - fb.min[2]),
    height: R.legH + R.torsoH + hb.max[1],
  };
  return {
    kind: k,
    parts: /** @type {Record<ZombiePart, Geo>} */ (merged),
    rig: zombieRig(k),
    image: s.atlas.img,
    glow,
    tris,
    texels: s.atlas.used(),
    rects: Object.fromEntries([...s.entries].map(([key, e]) => [key, /** @type {[number, number, number, number]} */ ([...(e.jobs[0].rect ?? [])])])),
    atlas: [ZOMBIE_ATLAS, ZOMBIE_ATLAS],
    dims,
  };
}

/** @type {Map<ZombieKind, ZombieModel>} */
const built = new Map();

/**
 * A kind's model, built once and shared (every renderer, the gallery).
 * @param {ZombieKind} kind
 * @returns {ZombieModel}
 */
export function zombieModel(kind) {
  const k = kindKey(kind);
  let m = built.get(k);
  if (!m) {
    m = buildZombieModel(k);
    built.set(k, m);
  }
  return m;
}

/**
 * The whole model standing at rest in one geometry (feet at the origin, facing −Z), its arms held out a little: the
 * gallery's and the pilot's view.
 * @param {ZombieKind} kind
 * @returns {Geo}
 */
export function zombieRestGeometry(kind) {
  const m = zombieModel(kind);
  const R = m.rig;
  const geos = [];
  for (const side of [-1, 1]) {
    geos.push(transform(m.parts.leg, translation(side * R.legX, R.legH, 0)));
    const sh = compose({ t: [side * R.shoulderX, R.legH + R.shoulderY, 0], r: [0.5, 0, side * 0.06] });
    geos.push(transform(m.parts.upperArm, sh));
    geos.push(transform(m.parts.foreArm, mul(sh, compose({ t: [0, -R.upperL, 0], r: [0.5, 0, 0] }))));
  }
  geos.push(transform(m.parts.torso, translation(0, R.legH, 0)));
  geos.push(transform(m.parts.head, translation(0, R.legH + R.torsoH, 0)));
  return merge(geos);
}
