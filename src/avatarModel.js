// Caelancraft — the avatars' models (PURE: typed arrays, no three, no DOM). See src/CONTRACTS.md §91 and
// docs/DESIGN-characters.md.
//
// Any entry of avatars.js becomes a HEX-FACETED figure (figureKit.js): tapered hexagonal columns for the legs, the hips,
// the torso, the neck and the arms; a faceted head with a flat face plane, a nose wedge and hex ears; hair as a poofy
// mass or a scalp cap with big clumps; chamfered hands and shoes; a pleated skirt, a sash and a bow on a dress. Every part
// is a closed solid wound outward, its uvs on ONE painted 256² atlas (paintAvatar: cloth weave, denim, knit, seams and
// stitching, a face with irises and catchlights).
//
// The model is cut into BONES, one geometry each, in the frame of the joint it hangs from, so avatarRenderer.js animates
// it with today's joints and AvatarMotion's poses: the hips (the seat and a skirt), the torso (with the neck, a sash, a
// bow), the head (with its hair), the back hair of long hair (it follows the head only part of the way, so it never
// swings through the back), each leg (with its shoe) from its hip, each upper arm (with a puffed sleeve) from its
// shoulder, each forearm (with a cuff and the hand) from its elbow. Numbers are the avatar's BUILD (avatars.js) drawn at
// its `scale`, so the model's top is its `height`.
//
// The first-person HAND (fpHand) is built over the same atlas: a forearm dressed as the model's (a pushed-up sleeve and its
// cuff, or bare under a short sleeve), and a fist — a palm, four fingers of three segments and a thumb — curled round a
// haft (`grip`) or loosely open (`relaxed`). FP_HAND holds every number of where it sits in the view, how it chops and
// how it draws (§100); fpHandFrame turns a stroke and a draw into its camera-space frames; fpClearShift keeps it clear of
// a tablet's buttons (§95).
import {
  loft, prism, wedge, transform, merge, mul, translation, rotation, scaling, compose, triangleCount, bounds,
} from './modelKit.js';
import { mix, shade, fbm, hash2, makeRng } from './paintKit.js';
import {
  STYLES, DENSITY, perimeter, Skin, shapes, seg, len, KID_HEAD, headGeo, addHead, headSkin, hairMass, hairline, frontness,
  lumps, clump, capYaws, CAP_RINGS, lockGeo, hairCentre, rotateAbout, norm, cross,
} from './figureKit.js';

/** The avatar's own head profile (avatars.js `head.shape`: Caelan round, Brayden a long oval), else the kid's. */
const headShape = (H) => H.shape ?? KID_HEAD;
import { AVATAR_IDS } from './avatars.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./modelKit.js').Mat4} Mat4 */
/** @typedef {import('./avatars.js').AvatarDef} AvatarDef */
/** @typedef {import('./paintKit.js').Img} Img */

/** The bones, in the order the renderer hangs them. */
export const AVATAR_BONES = Object.freeze(['hips', 'torso', 'head', 'hairBack', 'legL', 'legR', 'upperL', 'upperR', 'foreL', 'foreR']);
/** @typedef {'hips'|'torso'|'head'|'hairBack'|'legL'|'legR'|'upperL'|'upperR'|'foreL'|'foreR'} Bone */

/** The atlas's size (pixels). */
export const AVATAR_ATLAS = 256;

/** The hair cuts, by style: two of each (the user's picks are in avatars.js: C2, B1, A1). */
export const HAIR_CUTS = Object.freeze({
  C1: Object.freeze({ style: 'poofy', label: 'C1 cloud — a round, full poofy mop' }),
  C2: Object.freeze({ style: 'poofy', label: 'C2 tousled — a taller mop, higher at the front' }),
  B1: Object.freeze({ style: 'silky', label: 'B1 side sweep — smooth panels across the brow' }),
  B2: Object.freeze({ style: 'silky', label: 'B2 curtain — a longer sweep over one ear' }),
  A1: Object.freeze({ style: 'longWavy', label: 'A1 long waves — fringe, framing locks, a back curtain' }),
  A2: Object.freeze({ style: 'longWavy', label: 'A2 low ponytail — fringe, framing locks, one wavy tail' }),
});

/** Where the head turns and nods: this share of its height over the chin (about the jaw), over the neck's middle. */
export const HEAD_PIVOT = 0.12;
/** The back hair follows the head's turn this much, and its nod only downward (looking up would swing it into the back). */
export const HAIR_BACK_FOLLOW = Object.freeze({ yaw: 0.4, pitchDown: 0.8 });

// ---------------------------------------------------------------------------------------------------
// Hair: Caelan's poofy faceted MASS (never locks: they read as dreadlocks); a scalp cap that hugs the head plus a few big
// CLUMPS flowing one way for silky and long hair. Each builder adds geometry in the head's frame (the chin at the origin).
// ---------------------------------------------------------------------------------------------------

/**
 * @callback HairAdd
 * @param {Geo} geo  in the head's frame
 * @param {string} key  its skin
 * @param {'head'|'hairBack'} [bone]
 */

/**
 * A POOFY mop: one big faceted mass over the crown and sides, clearly bigger than the head, its outline soft and uneven
 * (shallow lumps all over), the fringe a ragged line of small notches just above the brows, the rim notched round the sides
 * and the nape, a soft wisp at the crown and one over each ear, all of a piece. `tall` (C2, tousled): taller, higher at
 * the front.
 * @param {HairAdd} add @param {import('./figureKit.js').HeadDims} H @param {boolean} tall
 */
function hairPoofy(add, H, tall) {
  const line = hairline([[0, -27], [40, -17], [78, 5], [100, 6], [128, 15], [155, 21], [180, 22]]);
  const around = 24;
  const tip = (j) => 0.5 + 0.5 * Math.sin(j * 2.39 + 0.6); // uneven tips
  const isEar = (yaw) => Math.abs(Math.abs(yaw - 180) - 90) < 8;
  const rim = (yaw, j) => {
    const f = frontness(yaw);
    // the rim notched all round, deepest over the brow; a wisp dipping over each ear
    const notch = (j % 2 ? 4.5 + 2 * tip(j) : -1.5) * (0.45 + 0.55 * f);
    return line(yaw) + notch + (isEar(yaw) ? -10 : 0) + (tall ? 3 * f : 0);
  };
  const off = (yaw, pitch, s, j) => {
    const f = frontness(yaw);
    // C2 rises at the front through its middle rings (never to a peak at the crown)
    const swell = tall
      ? 0.058 * Math.sin(Math.min(1, s * 1.3) * Math.PI / 2) + 0.05 * f * Math.sin(Math.PI * Math.min(1, s * 1.15))
      : 0.066 * Math.sin(Math.min(1, s * 1.4) * Math.PI / 2);
    // shallow lumps over the mass, strongest round its middle; the crown a little irregular too
    const bump = (tall ? 0.026 : 0.022) * lumps(yaw, s, tall ? 1.3 : 0) * Math.sin(Math.PI * Math.min(1, 0.15 + s));
    // the notched rim: its tips stand a little proud, so the edge has depth
    const edge = s === 0 ? (j % 2 ? 0.008 : 0.002) + 0.008 * f : 0;
    // a soft wisp at the crown (two neighbouring points) and over the ears
    const crown = !tall && s > 0.8 && s < 0.97 && (j === 13 || j === 14) ? 0.01 : 0;
    const ear = s < 0.2 && isEar(yaw) ? 0.008 : 0;
    return 0.017 + swell + bump + edge + crown + ear;
  };
  add(hairMass(H, headShape(H), { around, rim, off, rings: [0, 0.1, 0.24, 0.4, 0.56, 0.71, 0.84, 0.94, 1] }), 'hairMass');
}

/**
 * SILKY hair: a sleek cap, smooth panels from a parting on the right sweeping across the brow, short sides and nape;
 * `curtain` (B2): a longer sweep over one ear.
 * @param {HairAdd} add @param {import('./figureKit.js').HeadDims} H @param {boolean} curtain
 */
function hairSilky(add, H, curtain) {
  /** @type {import('./figureKit.js').Cap} */
  const cap = { rim: hairline([[0, -26], [45, -14], [80, 8], [100, 9], [130, 20], [160, 25], [180, 26]]), off: (yaw, pitch, s) => 0.014 + 0.018 * s };
  add(hairMass(H, headShape(H), { yaws: capYaws(H), rim: cap.rim, off: cap.off, rings: CAP_RINGS }), 'hairCap');
  const L = curtain ? 1 : 0;
  const panel = [0.55, 1, 1, 0.9, 0.6, 0];
  for (let k = 0; k < 4; k++) {
    const ctrl = curtain
      ? [[120 + 4 * k, 84 - 6 * k], [158, 72 - 8 * k, 0.006], [210, 52 - 8 * k, 0.01], [250, 22 - 5 * k, 0.012], [265, -6 - 5 * k, 0.01]]
      : [[118 + 4 * k, 83 - 6 * k], [150, 72 - 9 * k, 0.006], [195, 55 - 9 * k, 0.01], [226, 35 - 4 * k, 0.008], [238, 24 - 2 * k, 0.004]];
    add(clump(H, headShape(H), cap, ctrl, { w: 0.13 + 0.01 * L, profile: panel }), 'hairLock');
  }
  // the short side by the parting, combed back and down; the far side under the panels; the nape
  const short = [0.55, 1, 0.65, 0];
  add(clump(H, headShape(H), cap, [[120, 74], [102, 46, 0.004], [94, 14 - 12 * L, 0.002]], { w: 0.12, profile: short }), 'hairLock');
  add(clump(H, headShape(H), cap, [[244, 66], [262, 36, 0.004], [268, 10 - 10 * L, 0.002]], { w: 0.12, profile: short }), 'hairLock');
  for (const side of [-1, 1]) {
    add(clump(H, headShape(H), cap, [[(360 + side * 24) % 360, 64], [(360 + side * 19) % 360, 20, 0.004], [(360 + side * 15) % 360, -18 - 10 * L, 0.002]],
      { w: 0.14, profile: short }), 'hairLock');
  }
}

/**
 * LONG WAVY hair: a cap, a fringe of three soft panels, a framing lock either side to the collarbone, and down the back
 * a curtain of long waving ribbons (A1) or one thick waving ponytail gathered at the nape (A2) — on the back-hair bone.
 * @param {HairAdd} add @param {import('./figureKit.js').HeadDims} H @param {boolean} ponytail
 */
function hairLongWavy(add, H, ponytail) {
  /** @type {import('./figureKit.js').Cap} */
  const cap = { rim: hairline([[0, -28], [45, -16], [80, -2], [100, -1], [130, 18], [160, 25], [180, 26]]), off: (yaw, pitch, s) => 0.016 + 0.024 * s };
  add(hairMass(H, headShape(H), { yaws: capYaws(H), rim: cap.rim, off: cap.off, rings: CAP_RINGS }), 'hairCap');
  for (let k = -1; k <= 1; k++) {
    add(clump(H, headShape(H), cap, [[180 + 10 * k, 86], [180 + 13 * k, 60, 0.006], [180 + 17 * k, 38, 0.01], [180 + 19 * k, 25, 0.006]],
      { w: 0.12, profile: [0.55, 1, 0.9, 0] }), 'hairLock');
  }
  for (const side of [-1, 1]) {
    add(clump(H, headShape(H), cap, [[180 - side * 62, 50], [180 - side * 70, 12, 0.008], ['p', side * 0.196, 0.015, -0.03], ['p', side * 0.186, -0.07, -0.018],
      ['p', side * 0.172, -0.13, -0.022]], { w: 0.08, t: 0.028, profile: [0.6, 1, 1, 0.9, 0.6, 0], up: [side, 0, -0.4] }), 'hairLock');
  }
  const back = H.rz * 1.04;
  if (!ponytail) {
    for (let k = 0; k < 6; k++) {
      const yaw = (360 + (k - 2.5) * 23) % 360;
      const x = Math.sin((yaw * Math.PI) / 180) * 0.17;
      const wave = (k % 2 ? 0.03 : -0.03) * (0.8 + 0.2 * Math.sin(k * 1.7));
      const end = -0.31 - 0.03 * ((k * 2) % 3);
      add(clump(H, headShape(H), cap, [[yaw, 60], [yaw, 16, 0.008], [yaw, -22, 0.016], ['p', x * 1.2, -0.13, back + 0.035 + wave],
        ['p', x * 1.32, -0.22, back + 0.035 - wave], ['p', x * 1.45, end, back + 0.03 + wave]],
      { w: 0.078, t: 0.026, profile: [0.6, 1, 1, 0.9, 0.6, 0], up: [0, 0.15, 1] }), 'hairLock', 'hairBack');
    }
  } else {
    const knot = ['p', 0, 0.075, back + 0.03];
    for (const side of [-1, 1]) {
      add(clump(H, headShape(H), cap, [[(360 + side * 40) % 360, 64], [(360 + side * 30) % 360, 20, 0.006], knot], { w: 0.14, profile: [0.6, 1, 0.7, 0.3] }), 'hairLock');
    }
    add(transform(prism({ sides: 6, rx: 0.034, rz: 0.03, h: 0.035, phase: 0 }), mul(translation(0, 0.06, back + 0.03), rotation(0, -0.5))), 'hairLock');
    add(clump(H, headShape(H), cap, [['p', 0, 0.07, back + 0.035], ['p', 0.018, -0.07, back + 0.06], ['p', -0.016, -0.2, back + 0.055], ['p', 0.012, -0.33, back + 0.035]],
      { w: 0.11, t: 0.075, profile: [0.65, 1, 0.95, 0.85, 0.6, 0.3, 0], segments: 6, up: [0, 0, 1] }), 'hairLock', 'hairBack');
  }
}

/** @type {Record<string, (add: HairAdd, H: import('./figureKit.js').HeadDims, cut: string) => void>} */
const HAIR_STYLES = {
  poofy: (add, H, cut) => hairPoofy(add, H, cut === 'C2'),
  silky: (add, H, cut) => hairSilky(add, H, cut === 'B2'),
  longWavy: (add, H, cut) => hairLongWavy(add, H, cut === 'A2'),
};

/**
 * A cut of `def`'s hair style (its own, or `cut`), or a RangeError.
 * @param {AvatarDef} def @param {string} [cut]
 * @returns {string}
 */
function cutOf(def, cut) {
  const c = cut ?? def.hair.cut;
  const known = Object.prototype.hasOwnProperty.call(HAIR_CUTS, c) ? HAIR_CUTS[/** @type {keyof typeof HAIR_CUTS} */ (c)] : null;
  if (!known || known.style !== def.hair.style || !HAIR_STYLES[def.hair.style]) throw new RangeError(`no hair ${c} for ${def.id}`);
  return c;
}

/**
 * Whether the skull shows through the hair: how many of the head's corners above the hairline lie outside the hair's mass
 * or cap (looking out from the middle of the cranium). 0 for every cut, or the hair has a gap.
 * @param {AvatarDef} def @param {string} [cut]
 * @returns {number}
 */
export function hairGaps(def, cut) {
  const H = def.head;
  /** @type {Geo[]} */
  const shells = [];
  HAIR_STYLES[def.hair.style]((geo, key) => {
    if (key === 'hairCap' || key === 'hairMass') shells.push(geo);
  }, H, cutOf(def, cut));
  const shell = merge(shells);
  const head = headGeo(H, headShape(H));
  const c = hairCentre(H);
  const P = (g, i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  /** the farthest crossing of the shell along a ray from the middle, and whether it is the shell's side (not its rim's cap) */
  const outer = (d) => {
    let best = -Infinity;
    let side = false;
    for (let t = 0; t < shell.index.length; t += 3) {
      const [a, b, cc] = [P(shell, shell.index[t]), P(shell, shell.index[t + 1]), P(shell, shell.index[t + 2])];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
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
    const L = Math.hypot(d[0], d[1], d[2]);
    const hit = outer([d[0] / L, d[1] / L, d[2] / L]);
    if (hit.side && hit.best < L - 1e-4) gaps++;
  }
  return gaps;
}

// ---------------------------------------------------------------------------------------------------
// The atlas
// ---------------------------------------------------------------------------------------------------

/**
 * The hair pictures. A mass: soft clumpy colour, darker toward its rim and lighter on top, short strands every which way
 * (tousled). A cap: strands up from the hairline, a faint sheen. A clump: strands along it, its underside (the middle of
 * the strip) and its root darker, a sheen near the root, its tip a touch lighter.
 * @param {Skin} s @param {string} style @param {ReadonlyArray<number>} ramp
 */
function paintHair(s, style, ramp) {
  if (style === 'poofy') {
    const base = ramp[1];
    s.wrap('hairMass', 192, 56, (p) => {
      p.fill((x, y) => {
        const n = fbm(x / 10, y / 8, 5, 3);
        return n > 0.52 ? mix(base, ramp[0], Math.min(1, (n - 0.52) * 2.2)) : mix(base, ramp[2], Math.min(1, (0.52 - n) * 1.6));
      });
      const rnd = makeRng(19);
      for (let i = 0; i < 1300; i++) {
        const x = rnd() * p.w;
        const y = rnd() * p.h;
        const a = rnd() * Math.PI * 2;
        const l = 1.5 + rnd() * 2.5;
        p.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.35, rnd() < 0.55 ? mix(ramp[0], 0xfff4d0, 0.3) : ramp[2], 0.3 + 0.3 * rnd());
      }
      p.shadeV(1.16, 0.86).ao({ bottom: 0.22, width: 0.18 });
    }, { top: (p) => p.fill(ramp[0]), bottom: (p) => p.fill(mix(ramp[2], ramp[3], 0.6)) });
    return;
  }
  const base = mix(ramp[1], ramp[2], 0.5);
  // the cap is the under-layer: what shows between the clumps reads as shadow, its sheen only faint
  const ends = { top: (p) => p.fill(base), bottom: (p) => p.fill(mix(ramp[3], 0x000000, 0.25)) };
  s.wrap('hairCap', 96, 32, (p) => {
    p.fill(mix(base, ramp[3], 0.3)).mottle(0.06, 6);
    for (let x = 0; x < p.w; x += 1.6) p.line(x, 0, x + 0.6 * Math.sin(x), p.h, 0.32, hash2(Math.round(x * 5), 3, 7) < 0.5 ? ramp[2] : ramp[3], 0.45);
    for (let y = Math.floor(p.h * 0.18); y < p.h * 0.38; y++) for (let x = 0; x < p.w; x++) p.tone(x, y, 1 + 0.08 * Math.sin(((y - p.h * 0.18) / (p.h * 0.2)) * Math.PI));
    p.ao({ bottom: 0.35, width: 0.3 });
  }, ends);
  s.wrap('hairLock', 40, 64, (p) => {
    p.fill(base);
    for (let x = 0; x < p.w; x += 1.4) p.line(x, 0, x, p.h, 0.3, hash2(Math.round(x * 7), 5, 9) < 0.5 ? ramp[1] : ramp[3], 0.5);
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const under = Math.max(0, 1 - Math.abs(x / p.w - 0.5) * 3.2);
        const sheen = Math.max(0, 1 - Math.abs(y / p.h - 0.7) * 7) * (0.75 + 0.25 * hash2(x, 2, 5));
        p.tone(x, y, (1 - 0.32 * under) * (1 + 0.28 * sheen) * (1 + 0.08 * (1 - y / p.h)));
      }
    }
    p.ao({ bottom: 0.4, width: 0.22 });
  }, ends);
}

/** The FIRST-PERSON forearm's length (wrist to elbow, metres), from the fist's frame. */
const FP_WRIST_Z = 0.045;
const FP_FOREARM = 0.235;

/**
 * Paint an avatar's atlas: its head and face, skin, hair, the top (a tee's stripe or pocket, a dress's collar), sleeves and
 * cuffs, trousers (jeans with a belt, khakis) or a dress's skirt, sash and bow over bare legs and socks, and shoes
 * (sneakers with a flash, leather lace-ups, strap shoes). Rectangles are asked for by name and packed on one 256² image.
 * @param {AvatarDef} def
 * @returns {Skin}
 */
export function paintAvatar(def) {
  const K = def.body;
  const P = def.palette;
  const O = def.outfit;
  const D = DENSITY.body;
  const skinR = P.skin;
  const top = O.top;
  const s = new Skin(AVATAR_ATLAS, AVATAR_ATLAS, 7 + AVATAR_IDS.indexOf(def.id) * 11);
  headSkin(s, 'head', def.head, (p) => p.skin(skinR).shadeV(1.02, 1.04), {
    skin: skinR, eyes: P.eyes, brows: P.brows, mouth: P.mouth, blush: P.blush, lashes: !!P.lashes, freckles: !!P.freckles,
  });
  s.plain('skin', 24, 24, (p) => p.skin(skinR).shadeV(1.05, 0.92));
  s.wrap('neck', Math.round(perimeter(K.neck.r, K.neck.r) * D), Math.round((K.neck.y1 - K.neck.y0) * D), (p) => p.skin(skinR).ao({ top: 0.55, width: 0.6 }));
  s.plain('hand', 24, 24, (p) => {
    p.skin(skinR).shadeV(1.02, 0.9);
    for (const y of [8, 15]) p.line(2, y, 22, y, 0.45, skinR[2], 0.45);
  });
  paintHair(s, def.hair.style, P.hair);
  // the top: a tee (a stripe or a pocket) or a dress's bodice (a round white collar), seams, a hem or a waist seam
  const T = K.torso;
  const tw = Math.round(perimeter(T.rx * 1.02, T.rz * 1.03) * D);
  const th = Math.round(T.h * D);
  s.wrap('torso', tw, th, (p) => {
    p.cloth(top, { fold: 0.8 });
    p.ellipse(tw * 0.25, -2, 7, 6, top[2], 0.35).ellipse(tw * 0.75, -2, 7, 6, top[2], 0.35);
    if (O.detail === 'stripe') {
      const y = Math.round(th * 0.36);
      p.line(-1, y, tw + 1, y, 2.2, O.trim, 1);
      for (const d of [-2.6, 2.6]) p.line(-1, y + d, tw + 1, y + d, 0.5, mix(O.trim, top[2], 0.5), 0.6);
    } else if (O.detail === 'pocket') {
      const x = tw * 0.5 + 6;
      p.patch(x, th * 0.22, 9, 10, [top[0], top[1], top[2]], shade(top[0], 1.25));
    } else {
      // a round white collar falling over the front, and the dress's waist seam
      p.ellipse(tw / 2, -3, 15, 9, O.trim, 1).ellipse(tw / 2, -5, 10, 7, top[1], 1).ellipse(tw / 2, -6, 6, 5, skinR[1], 1);
      p.arc(tw / 2, -3, 15, 0.15, Math.PI - 0.15, 0.5, shade(O.trim, 0.8), 0.8, 9);
    }
    for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, top);
    if (O.kind === 'tee') p.hem(th - 4, 4, top);
    p.shadeV(1.05, 0.9).ao({ bottom: 0.25, width: 0.15 });
  }, {
    cap: [34, 22],
    top: (p) => {
      p.cloth(top);
      if (O.kind === 'dress') p.ellipse(17, 11, 10, 8, O.trim, 1);
      p.ellipse(17, 11, 7.2, 6.6, top[2], 1).ellipse(17, 11, 5.6, 5.1, skinR[2], 1);
    },
  });
  // the arms: the sleeve on the upper arm (from the shoulder, the strip's bottom rows), then skin; a long sleeve pushed up
  // to a cuff on the forearm
  const uw = Math.round(perimeter(K.upper.rx, K.upper.rz) * D);
  const uh = Math.round(len(K.shoulder, K.elbow) * D);
  s.wrap('upperArm', uw, uh, (p) => {
    p.skin(skinR).shadeV(1.0, 0.94);
    const y0 = Math.round(uh * (1 - O.sleeve));
    for (let y = y0; y < uh; y++) for (let x = 0; x < uw; x++) p.px(x, y, mix(top[1], top[2], 0.1 + 0.2 * fbm(x / 5, y / 4, 3)), 1);
    if (O.sleeve < 1) p.ao({ top: 0.25, width: 0.4 });
  });
  s.wrap('sleeve', Math.round(uw * (O.puff ?? 1.2)), Math.round(uh * O.sleeve), (p) => {
    p.cloth(top, { fold: 1.2 });
    p.hem(1, 3, [top[0], O.kind === 'dress' ? O.trim : top[1], top[2]], { stitchColor: O.trim });
    if (O.kind === 'dress') p.line(-1, 1.5, p.w + 1, 1.5, 1.4, O.trim, 1);
    p.shadeV(0.92, 1.06);
  }, { cap: [16, 16], top: (p) => p.fill(top[2]), bottom: (p) => p.fill(top[1]) });
  const fw = Math.round(perimeter(K.fore.rx * 0.85, K.fore.rz * 0.85) * D);
  const fh = Math.round(len(K.elbow, K.wrist) * D);
  /** a sleeve's cloth from row 0 (the elbow end) down to `row` */
  const sleeveRows = (p, row) => {
    for (let y = 0; y < row; y++) for (let x = 0; x < p.w; x++) p.px(x, y, mix(top[1], top[2], 0.15 + 0.2 * fbm(x / 5, y / 4, 3)), 1);
  };
  s.wrap('foreArm', fw, fh, (p) => {
    p.skin(skinR).shadeV(1.0, 0.93).ao({ top: 0.2, width: 0.5 });
    if (O.cuffAt) sleeveRows(p, Math.round(fh * (1 - O.cuffAt)));
  }, { top: (p) => p.cloth(top), bottom: (p) => p.skin(skinR) });
  // the first-person forearm, as the model's: skin from the wrist to a pushed-up sleeve's cuff and cloth beyond it; bare
  // under a short sleeve (it ends on the upper arm, out of the view)
  const pw = Math.round(perimeter(K.fore.rx * 0.95 * 0.85, K.fore.rz * 0.95 * 0.85) * D);
  const ph = Math.round(FP_FOREARM * D);
  s.wrap('fpArm', pw, ph, (p) => {
    p.skin(skinR).shadeV(1.0, 0.94);
    if (O.cuffAt) sleeveRows(p, Math.round(ph * (1 - O.cuffAt)));
  }, { top: (p) => (O.cuffAt ? p.cloth(top) : p.skin(skinR)), bottom: (p) => p.skin(skinR) });
  // the knit cuff of a pushed-up long sleeve (a short sleeve's hem is the puffed sleeve's own)
  if (O.cuffAt) {
    s.wrap('cuff', fw + 2, 6, (p) => {
      p.knit([top[0], mix(top[0], top[1], 0.5), top[2]], { cell: 3 });
      p.line(-1, 1, fw + 3, 1, 0.6, O.trim, 0.9);
      p.shadeV(1.08, 0.86);
    }, { top: (p) => p.fill(top[1]), bottom: (p) => p.fill(top[2]) });
  }
  // below: jeans (a belt, a fly, back pockets), khaki trousers, or a dress's skirt over bare legs and socks (under a skirt
  // the hips are never seen: a small patch of the dress's cloth)
  const dress = O.kind === 'dress';
  const jw = dress ? 24 : Math.round(perimeter(K.hips.rx, K.hips.rz) * D);
  const jh = dress ? 12 : Math.round((K.hips.y1 - K.hips.y0) * D);
  const bottom = O.bottom ?? top;
  const denim = O.fabric === 'denim';
  const lw = Math.round(perimeter(K.leg.rx, K.leg.rz) * D);
  const lh = Math.round(K.leg.len * D);
  const fabric = (p, ramp) => (denim ? p.denim(ramp) : p.cloth(ramp, { fold: 1.1 }));
  s.wrap('hips', jw, jh, (p) => {
    fabric(p, bottom);
    if (dress) return;
    const belt = O.belt ?? 0x4a3424;
    p.fill((x, y) => (y < 5 ? shade(belt, 0.92 + 0.14 * hash2(x, y, 5)) : p.get(x, y)));
    p.line(-1, 5.3, jw + 1, 5.3, 0.5, 0x3e2a1a, 0.8);
    p.ellipse(jw / 2, 2.5, 3.2, 2.4, 0xd6c48a, 1).ellipse(jw / 2, 2.5, 1.8, 1.1, belt, 1);
    for (const u of [0.12, 0.36, 0.64, 0.88]) p.line(jw * u, 0, jw * u, 5.5, 0.6, bottom[2], 0.9);
    p.line(jw / 2, 6, jw / 2, jh, 0.45, bottom[2], 0.8);
    for (const u of [0.25, 0.75]) p.seam(jw * u, 6, jw * u, jh, bottom);
    p.ao({ bottom: 0.3, width: 0.3 });
  });
  s.wrap('leg', lw, lh, (p) => {
    if (dress) {
      p.skin(skinR).shadeV(1.02, 0.95);
      const sock = Math.round(lh * (1 - (O.socks?.up ?? 0.4)));
      const sc = O.socks?.color ?? 0xffffff;
      for (let y = sock; y < lh; y++) for (let x = 0; x < lw; x++) p.px(x, y, shade(sc, x % 3 === 0 ? 0.9 : 1), 1);
      p.line(-1, sock + 2, lw + 1, sock + 2, 0.5, shade(sc, 0.8), 0.8);
      p.ao({ top: 0.45, width: 0.2 });
      return;
    }
    fabric(p, bottom);
    for (const u of [0.25, 0.75]) p.seam(lw * u, 0, lw * u, lh, bottom);
    if (denim) p.glow(lw * 0.5, lh * 0.55, lw * 0.18, bottom[0], 0.35, lh * 0.1); // worn knees
    else p.line(lw * 0.5, 0, lw * 0.5, lh, 0.5, bottom[2], 0.5); // a crease
    p.shadeV(0.86, 1.02).ao({ top: 0.35, bottom: 0.15, width: 0.12 });
  });
  s.wrap('legCuff', lw + 4, 6, (p) => {
    const ramp = [shade(bottom[0], 1.1), bottom[0], bottom[1]];
    fabric(p, ramp);
    p.stitches(0, 3, lw + 4, 3, denim ? 0xd9a25a : shade(bottom[0], 1.2), { a: 0.7 });
    p.shadeV(1.08, 0.84);
  }, { top: (p) => p.fill(bottom[1]), bottom: (p) => p.fill(bottom[2]) });
  if (O.skirt) {
    const sk = O.skirt;
    // pleated cloth reads at a lower density: 64 px/m
    s.wrap('skirt', Math.round(perimeter(sk.r1, sk.r1 * 0.85) * 64), Math.round((sk.y0 - sk.y1) * 64 * 1.05), (p) => {
      p.cloth(top, { fold: 0.6 });
      // pleats: a fold at every twelfth, lit on one side
      for (let k = 0; k < 12; k++) {
        const x = ((k + 0.5) / 12) * p.w;
        p.line(x, 0, x, p.h, 0.6, top[2], 0.8).line(x + 1.2, 0, x + 1.2, p.h, 0.5, top[0], 0.5);
      }
      p.fill((x, y) => (y > p.h - 6 ? shade(O.trim, 0.97 + 0.04 * hash2(x, y, 2)) : p.get(x, y)));
      p.stitches(0, p.h - 7, p.w, p.h - 7, O.trim, { a: 0.8 });
      p.shadeV(1.06, 0.92);
    }, { cap: [24, 24], top: (p) => p.cloth(top), bottom: (p) => p.fill(shade(top[2], 0.6)) });
    const sash = O.sash ?? O.trim;
    s.wrap('sash', Math.round(perimeter(T.rx, T.rz) * D) + 4, 8, (p) => p.cloth([0xffffff, sash, shade(sash, 0.85)], { fold: 0.6 }).shadeV(1.05, 0.9),
      { top: (p) => p.fill(sash), bottom: (p) => p.fill(shade(sash, 0.85)) });
    s.plain('bow', 16, 16, (p) => p.cloth([0xffffff, sash, shade(sash, 0.8)]).ao({ left: 0.3, right: 0.3, width: 0.3 }));
  }
  // shoes: sneakers with a flash on the sides; leather lace-ups; strap shoes with a buckle
  const [sw, sh, sd] = O.shoes.size.map((v) => Math.round(v * 128));
  const [c0, c1, c2] = O.shoes.colors;
  const leather = O.shoes.style !== 'sneaker';
  const upper = (p) => {
    if (leather) p.cloth([shade(c0, 1.12), c0, shade(c0, 0.75)], { fold: 0.4 }).glow(p.w * 0.4, p.h * 0.3, p.w * 0.3, shade(c0, 1.35), 0.4, p.h * 0.15);
    else p.cloth([shade(c0, 1.02), c0, shade(c0, 0.88)], { fold: 0.5 });
    p.fill((x, y) => (y > p.h - 5 ? shade(c1, 1 + 0.06 * hash2(x, y, 2)) : p.get(x, y)));
    p.line(-1, p.h - 5, p.w + 1, p.h - 5, 0.5, shade(c1, 0.7), 0.9);
    p.stitches(0, p.h - 7, p.w, p.h - 7, shade(c0, leather ? 1.3 : 0.75), { a: 0.6 });
    p.ao({ bottom: 0.15, width: 0.2 });
  };
  s.box('shoe', sw, sh, sd, {
    all: upper,
    left: (p) => {
      upper(p);
      if (c2 !== undefined) p.polyline([[3, p.h - 8], [p.w * 0.45, p.h * 0.35], [p.w - 6, p.h * 0.5]], 1.6, c2, 1);
    },
    right: (p) => {
      upper(p);
      if (c2 !== undefined) p.polyline([[p.w - 3, p.h - 8], [p.w * 0.55, p.h * 0.35], [6, p.h * 0.5]], 1.6, c2, 1);
    },
    top: (p) => {
      p.cloth([shade(c0, 1.04), c0, shade(c0, 0.85)], { fold: 0.4 });
      if (O.shoes.style === 'strap') {
        p.line(0, p.h * 0.45, p.w, p.h * 0.45, 1.6, shade(c0, 0.6), 1).ellipse(p.w * 0.8, p.h * 0.45, 1.8, 1.8, 0xe8d38a, 1);
      } else {
        for (let k = 0; k < 4; k++) {
          const y = p.h * (0.4 + 0.11 * k);
          const lace = leather ? 0x2a1c12 : shade(c0, 0.7);
          p.line(p.w * 0.25, y, p.w * 0.75, y + 2, 0.7, lace, 0.9).line(p.w * 0.25, y + 2, p.w * 0.75, y, 0.7, lace, 0.9);
        }
      }
      p.ellipse(p.w / 2, p.h * 0.15, p.w * 0.38, p.h * 0.12, shade(c0, 0.94), 1);
    },
    bottom: (p) => p.stone([shade(c1, 1.1), c1, shade(c1, 0.7)]),
  });
  return s;
}

// ---------------------------------------------------------------------------------------------------
// The model, bone by bone
// ---------------------------------------------------------------------------------------------------

const legRings = (L) => [{ y: 0, sx: 0.74 }, { y: 0.31 * L, sx: 0.87 }, { y: 0.45 * L, sx: 0.82 }, { y: 0.74 * L, sx: 0.97 }, { y: L, sx: 1 }];
const torsoRings = (h) => [{ y: 0, sx: 0.97, sz: 0.98 }, { y: 0.27 * h, sx: 0.92, sz: 0.94 }, { y: 0.71 * h, sx: 1, sz: 1.03 }, { y: 0.9 * h, sx: 0.98, sz: 0.98 }, { y: h, sx: 0.74, sz: 0.78 }];
const foreRings = (L) => [{ y: 0, sx: 0.66, sz: 0.66 }, { y: L * 0.55, sx: 0.8 }, { y: L, sx: 0.85 }];

/** The model's hand at the wrist (side −1 left, 1 right): its frame and the grip point in it (where a haft passes). */
const handFrame = (wr, side) => compose({ t: [wr[0] + side * 0.002, wr[1], wr[2]], r: [0.08, 0, side * 0.06] });
const HAND_GRIP = Object.freeze([-0.003, -0.08, -0.004]);

/**
 * The joints of a model (metres, model space: its scale applied), as the renderer hangs its bones. Positions of the
 * right-hand side; the left mirrors x.
 * @typedef {Object} AvatarRig
 * @property {number} scale
 * @property {number} height    the top of the hair over the feet
 * @property {number} hipY      the hip joints' height (the hips and torso bones' origin)
 * @property {number} legX      each leg's joint from the middle
 * @property {number[]} shoulder  the right shoulder from the hips
 * @property {number[]} elbow     the right elbow from the shoulder
 * @property {number[]} head      the head's pivot (and the back hair's) from the hips
 * @property {number[]} grip      the right fist's grip from the elbow (where a held item's grip goes)
 * @property {number} lieY      lying on its back, the hips this high over the ground
 */

/**
 * @typedef {Object} AvatarFp  the first-person hand's parts over the model's atlas
 * @property {Geo} arm        the forearm and the sleeve's cuff, in the ARM frame (fpHandFrame().arm)
 * @property {Geo} grip       the palm, the fingers curled round a haft and the thumb, in the HAND frame
 * @property {Geo} relaxed    the same hand loosely open (nothing held)
 * @property {Float64Array} tool  a held tool's slab (heldItem.js) in the hand frame
 * @property {Float64Array} lump  a held lump's slab in the hand frame
 */

/**
 * @typedef {Object} AvatarModel
 * @property {string} id
 * @property {string} cut
 * @property {Record<Bone, Geo|null>} bones  each bone's geometry in its joint's frame (null: nothing on it)
 * @property {AvatarRig} rig
 * @property {AvatarFp} fp
 * @property {Img} image      the atlas (sRGB bytes, row 0 at the top: a DataTexture with flipY off)
 * @property {number} tris    the model's triangles (the first-person hand not counted)
 * @property {number} hairTris
 * @property {number} texels  pixels painted
 * @property {[number, number]} atlas
 * @property {{ bone: Bone, key: string, geo: Geo }[]} [parts]  every part on its own (model space at rest, unscaled), when asked
 */

/**
 * Build an avatar's model.
 * @param {AvatarDef} def
 * @param {{ cut?: string, parts?: boolean }} [o]  another cut of its hair style; keep the parts (tests)
 * @returns {AvatarModel}
 */
export function buildAvatarModel(def, { cut, parts: keepParts = false } = {}) {
  const hairCut = cutOf(def, cut);
  const S = shapes(STYLES.hex);
  const K = def.body;
  const O = def.outfit;
  const H = def.head;
  const s = paintAvatar(def);
  /** @type {{ bone: Bone, key: string, geo: Geo }[]} */
  const parts = [];
  /** @param {Bone} bone */
  const on = (bone) => (geo, key, M) => parts.push({ bone, key, geo: s.place(geo, key, M) });
  // ---- the legs and shoes; the seat of the trousers (or a dress's skirt, sash and bow)
  const [shw, shh, shd] = O.shoes.size;
  for (const side of [-1, 1]) {
    const add = on(side < 0 ? 'legL' : 'legR');
    const x = side * K.legX;
    add(S.block(shw, shh, shd, { top: { sx: 0.88, sz: 0.8, dz: 0.02 } }), 'shoe', compose({ t: [x * 1.04, shh / 2, -0.036], r: [0, side * -0.06, 0] }));
    add(S.col(K.leg.rx, K.leg.rz, legRings(K.leg.len)), 'leg', translation(x, K.ankle, 0));
    if (!O.skirt) add(S.col(K.leg.rx * 0.8, K.leg.rz * 0.8, [{ y: 0 }, { y: 0.038, sx: 0.98 }]), 'legCuff', translation(x, K.ankle - 0.002, 0));
  }
  on('hips')(S.col(K.hips.rx, K.hips.rz, [{ y: 0, sx: 0.96 }, { y: K.hips.y1 - K.hips.y0 }]), 'hips', translation(0, K.hips.y0, 0));
  const torso = on('torso');
  torso(S.col(K.torso.rx, K.torso.rz, torsoRings(K.torso.h)), 'torso', translation(0, K.torso.y0, 0));
  if (O.skirt) {
    // a pleated skirt (twelve facets, flaring), a sash round the waist and its bow at the back
    const sk = O.skirt;
    const h = sk.y0 - sk.y1;
    on('hips')(loft({
      sides: 12, rx: sk.r1, rz: sk.r1 * 0.85,
      rings: [{ y: 0 }, { y: h * 0.7, sx: (sk.r0 + (sk.r1 - sk.r0) * 0.25) / sk.r1 }, { y: h, sx: sk.r0 / sk.r1, sz: (sk.r0 * 0.66) / (sk.r1 * 0.85) }],
    }), 'skirt', translation(0, sk.y1, 0));
    torso(S.col(K.torso.rx * 1.0, K.torso.rz * 1.02, [{ y: 0 }, { y: 0.065, sx: 0.98 }]), 'sash', translation(0, K.torso.y0 + 0.02, 0));
    const bow = translation(0, K.torso.y0 + 0.055, K.torso.rz + 0.01);
    for (const side of [-1, 1]) {
      torso(wedge({ w: 0.08, h: 0.075, d: 0.02, ridge: 0, sx: 0.35 }), 'bow', mul(bow, compose({ r: [Math.PI / 2, 0, side * 1.25] })));
      torso(lockGeo({ len: 0.16, w: 0.045, t: 0.012, sweep: [side * 0.02, 0.01] }), 'bow', mul(bow, seg([0, 0, 0.005], [side * 0.04, -0.15, 0.02])));
    }
    torso(S.block(0.03, 0.035, 0.025), 'bow', bow);
  }
  torso(S.col(K.neck.r, K.neck.r, [{ y: 0 }, { y: K.neck.y1 - K.neck.y0, sx: 0.95 }]), 'neck', translation(0, K.neck.y0, 0));
  // ---- the arms: an upper arm (a puffed short sleeve over it), a forearm (a cuff on a pushed-up sleeve) and a hand
  const [pw, ph, pd] = def.hands.palm;
  const [fw, fh, fd] = def.hands.fingers;
  const [tw, th, td] = def.hands.thumb;
  for (const side of [-1, 1]) {
    const upper = on(side < 0 ? 'upperL' : 'upperR');
    const fore = on(side < 0 ? 'foreL' : 'foreR');
    const sh = [side * K.shoulder[0], K.shoulder[1], K.shoulder[2]];
    const el = [side * K.elbow[0], K.elbow[1], K.elbow[2]];
    const wr = [side * K.wrist[0], K.wrist[1], K.wrist[2]];
    const uL = len(sh, el);
    const shTop = [sh[0], sh[1] + 0.042, sh[2]];
    upper(S.col(K.upper.rx, K.upper.rz, [{ y: 0, sx: 0.5, sz: 0.62 }, { y: 0.042, sx: 0.96 }, { y: uL * 0.4, sx: 1 }, { y: uL, sx: 0.88 }]), 'upperArm', seg(shTop, el));
    if (O.puff) {
      const pl = uL * O.sleeve + 0.02;
      upper(S.col(K.upper.rx * O.puff, K.upper.rz * O.puff, [{ y: 0, sx: 0.5, sz: 0.6 }, { y: 0.045, sx: 0.98 }, { y: pl * 0.6, sx: 1.04 }, { y: pl, sx: 0.88 }]), 'sleeve', seg(shTop, el));
    }
    const fL = len(wr, el);
    fore(S.col(K.fore.rx, K.fore.rz, foreRings(fL)), 'foreArm', seg(wr, el));
    if (O.cuffAt) fore(S.col(K.fore.rx * 0.86, K.fore.rz * 0.92, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }]), 'cuff', seg(wr, el, translation(0, fL * O.cuffAt - 0.017, 0)));
    const hand = handFrame(wr, side);
    fore(S.block(pw, ph, pd, { top: { sx: 1.1, sz: 1.05 } }), 'hand', mul(hand, translation(0, -ph / 2 - 0.003, 0)));
    fore(S.block(fw, fh, fd), 'hand', mul(hand, compose({ t: [-side * 0.005, -ph - 0.024, 0.004], r: [0.1, 0, -side * 0.3] })));
    fore(S.nub(tw, th, td, { sx: 0.7, ridge: 0 }), 'hand', mul(hand, compose({ t: [-side * 0.012, -0.032, -pd / 2 + 0.001], r: [Math.PI, 0, side * 0.35] })));
  }
  // ---- the head and its hair
  const headM = translation(0, H.y, 0);
  addHead(on('head'), headM, H, headShape(H));
  let hairTris = 0;
  HAIR_STYLES[def.hair.style]((geo, key, bone = 'head') => {
    hairTris += triangleCount(geo);
    on(bone)(geo, key, headM);
  }, H, hairCut);

  // ---- the joints (build space), then every bone in its joint's frame, scaled
  const hipY = K.ankle + K.leg.len;
  const pivot = [0, H.y + HEAD_PIVOT * H.h, 0];
  const right = handFrame(K.wrist, 1);
  const gripAt = [0, 1, 2].map((a) => right[a] * HAND_GRIP[0] + right[4 + a] * HAND_GRIP[1] + right[8 + a] * HAND_GRIP[2] + right[12 + a]);
  /** @type {Record<Bone, number[]>} each bone's origin in build space */
  const origin = {
    hips: [0, hipY, 0], torso: [0, hipY, 0], head: pivot, hairBack: pivot,
    legL: [-K.legX, hipY, 0], legR: [K.legX, hipY, 0],
    upperL: [-K.shoulder[0], K.shoulder[1], K.shoulder[2]], upperR: [...K.shoulder],
    foreL: [-K.elbow[0], K.elbow[1], K.elbow[2]], foreR: [...K.elbow],
  };
  const k = def.scale;
  /** @type {Record<string, Geo|null>} */
  const bones = {};
  let tris = 0;
  for (const bone of AVATAR_BONES) {
    const mine = parts.filter((p) => p.bone === bone).map((p) => p.geo);
    if (mine.length === 0) {
      bones[bone] = null;
      continue;
    }
    const o = origin[/** @type {Bone} */ (bone)];
    const g = transform(merge(mine), mul(scaling(k), translation(-o[0], -o[1], -o[2])));
    bones[bone] = g;
    tris += triangleCount(g);
  }
  const all = merge(parts.map((p) => p.geo));
  const b = bounds(all);
  // lying on its back the body rests on the back of its head and its shoulders, its hair sinking in a little (a pillow)
  // and a skirt's flare pressed flat; long back hair is pressed flat under it (the renderer squashes that bone)
  const deepest = (pred) => parts.filter(pred).reduce((z, p) => Math.max(z, bounds(p.geo).max[2]), 0);
  const solidBack = deepest((p) => !p.key.startsWith('hair') && p.key !== 'skirt');
  const lieY = Math.max(solidBack, deepest((p) => p.bone !== 'hairBack' && p.key !== 'skirt') - 0.04) * k;
  /** @type {AvatarRig} */
  const rig = {
    scale: k,
    height: b.max[1] * k,
    hipY: hipY * k,
    legX: K.legX * k,
    shoulder: [K.shoulder[0] * k, (K.shoulder[1] - hipY) * k, K.shoulder[2] * k],
    elbow: [(K.elbow[0] - K.shoulder[0]) * k, (K.elbow[1] - K.shoulder[1]) * k, (K.elbow[2] - K.shoulder[2]) * k],
    head: [0, (pivot[1] - hipY) * k, 0],
    grip: [(gripAt[0] - K.elbow[0]) * k, (gripAt[1] - K.elbow[1]) * k, (gripAt[2] - K.elbow[2]) * k],
    lieY,
  };
  s.pack();
  return {
    id: def.id,
    cut: hairCut,
    bones: /** @type {Record<Bone, Geo|null>} */ (bones),
    rig,
    fp: buildFp(def, s, S),
    image: s.atlas.img,
    tris,
    hairTris,
    texels: s.atlas.used(),
    atlas: [s.atlas.img.width, s.atlas.img.height],
    ...(keepParts ? { parts } : {}),
  };
}

/** @type {Map<AvatarDef, AvatarModel>} */
const built = new Map();

/**
 * An avatar's model, built once per definition and shared (the renderer's instances and remote players reuse it).
 * @param {AvatarDef} def
 * @returns {AvatarModel}
 */
export function avatarModel(def) {
  let m = built.get(def);
  if (!m) {
    m = buildAvatarModel(def);
    built.set(def, m);
  }
  return m;
}

/**
 * The bones' places at rest (model space), as the renderer hangs them with no pose: for the gallery and the tests.
 * @param {AvatarRig} rig
 * @returns {Record<Bone, Float64Array>}
 */
export function restPlacements(rig) {
  const at = (x, y, z) => translation(x, y, z);
  const [sx, sy, sz] = rig.shoulder;
  const [ex, ey, ez] = rig.elbow;
  const h = rig.hipY;
  return {
    hips: at(0, h, 0), torso: at(0, h, 0), head: at(0, h + rig.head[1], rig.head[2]), hairBack: at(0, h + rig.head[1], rig.head[2]),
    legL: at(-rig.legX, h, 0), legR: at(rig.legX, h, 0),
    upperL: at(-sx, h + sy, sz), upperR: at(sx, h + sy, sz),
    foreL: at(-sx - ex, h + sy + ey, sz + ez), foreR: at(sx + ex, h + sy + ey, sz + ez),
  };
}

/**
 * The whole model at rest in one geometry (model space): what the gallery shows.
 * @param {AvatarModel} m
 * @returns {Geo}
 */
export function restGeometry(m) {
  const place = restPlacements(m.rig);
  /** @type {Geo[]} */
  const geos = [];
  for (const bone of AVATAR_BONES) {
    const g = m.bones[/** @type {Bone} */ (bone)];
    if (g) geos.push(transform(g, place[/** @type {Bone} */ (bone)]));
  }
  return merge(geos);
}

// ---------------------------------------------------------------------------------------------------
// The first-person hand: a sleeve cuff, a forearm, a real hand (palm, four fingers, a thumb) round the haft of the tool
// or loosely open, small and low at the lower right of the view
// ---------------------------------------------------------------------------------------------------

/**
 * Where the first-person hand sits in camera space (x right, y up, −z ahead; metres), how it is turned, how it chops and
 * how it bobs: every tunable of the first-person hand.
 */
export const FP_HAND = Object.freeze({
  /** the fist (the middle of the grip) at rest: low at the right, clear of the hotbar */
  grip: Object.freeze([0.25, -0.19, -0.5]),
  /** from the fist toward the elbow: out to the right more than back at the eye, so the wrist and the cuff show */
  arm: Object.freeze([0.7, -0.27, 0.66]),
  /** the back of the hand faces about this way (made square to the forearm) */
  back: Object.freeze([0.9, 0.05, 0.42]),
  /** the wrist tips the fist forward (radians about the hand's x): the haft leans ahead, not up at the eye; an empty
   * hand is held more easily */
  deviate: -1.1,
  deviateEmpty: -0.6,
  /** the slab turned about its haft from the swing's plane toward the eye, so the tool's picture reads; drawn smaller
   * than the model's (it is seen from half a metre) */
  toolTurn: 0.85,
  toolScale: 0.55,
  /** a held lump (food, a stone) rests on the fist: this far up the haft's line and toward the eye (hand frame, m) */
  lumpAt: Object.freeze([-0.01, 0.068, -0.016]),
  lumpScale: 0.45,
  /** the hand and forearm drawn at this share of the avatar's own */
  handScale: 1,
  /** the elbow, this far from the fist: the chop turns the forearm about it */
  forearm: 0.25,
  /** the chop: the forearm turns about the elbow (radians about the camera's x, a little in) and the wrist bends; the fist
   * pushes ahead a little */
  swingArm: -0.5, swingIn: 0.3, swingWrist: -0.5, swingPush: 0.05,
  /** how much of the walk's bob (AvatarPose.fpBobX, fpBobY) the hand takes */
  bob: 1,
  /**
   * §100 the draw (fpHandFrame's `draw` and `bow`): at a full draw the fist is at `grip`, pulled up and back toward the eye.
   * A throw (a spear, a dart) is cocked high at the right, its point toward `aim` (camera space: ahead and above the
   * crosshair, so its length shows), its picture turned to the eye. A bow is held up before the eye, its limbs upright
   * but for `cant` radians (the top leaning right, as it lies in the hand at rest), its string toward the eye: the picture
   * turned `turn` radians from edge-on.
   */
  drawThrow: Object.freeze({ grip: Object.freeze([0.23, -0.09, -0.36]), aim: Object.freeze([-0.1, 0.45, -1.5]) }),
  drawBow: Object.freeze({ grip: Object.freeze([0.15, -0.1, -0.4]), cant: 0.5, turn: 1.2 }),
  /**
   * On a tablet (§95) the fist keeps this far (NDC, across the view) left of the right cluster of buttons when it would sit
   * among them (fpClearShift): the whole hand moves left by as much.
   */
  touchGap: 0.1,
});

/** The wrist bend's centre in the hand frame. */
const FP_WRIST = Object.freeze([0, 0, FP_WRIST_Z]);

/**
 * The stroke of the first-person chop from AvatarPose.fpSwing: 0 between swings; through a swing it drops fast to the
 * bottom of the stroke (1) and comes back more slowly.
 * @param {number} fpSwing  0..1 through a swing, or −1
 * @returns {number} 0..1
 */
export function fpStroke(fpSwing) {
  if (!(fpSwing >= 0) || fpSwing >= 1) return 0;
  return Math.sin(Math.PI * Math.pow(fpSwing, 0.6));
}

/**
 * The hand's frames in camera space: origin at the fist (the middle of the grip), +y along the haft, +z toward the
 * elbow, +x out of the back of the hand. `arm` carries the forearm; `hand` the fist and the held item, which the wrist
 * bends on through the stroke; `wrist` is the hand's frame in the arm's. `stroke` 0 at rest .. 1 at the bottom of it;
 * `empty`: nothing in the hand (the wrist straighter); `draw` (§100, AvatarPose.draw) how far the hand is in the draw's
 * place (fpDrawnArm: a throw's, or a bow's when `bow`), eased in by a smoothstep.
 * @param {number} [stroke]
 * @param {boolean} [empty]
 * @param {number} [draw]
 * @param {boolean} [bow]
 * @returns {{ arm: Float64Array, hand: Float64Array, wrist: Float64Array }}
 */
export function fpHandFrame(stroke = 0, empty = false, draw = 0, bow = false) {
  const F = FP_HAND;
  const g = F.grip;
  let M = fpRestArm();
  const z = [M[8], M[9], M[10]];
  const s = Math.max(0, Math.min(1, stroke || 0));
  if (s > 0) {
    const elbow = [g[0] + z[0] * F.forearm, g[1] + z[1] * F.forearm, g[2] + z[2] * F.forearm];
    M = mul(rotateAbout(elbow, [1, 0, F.swingIn], F.swingArm * s), M);
    M = mul(translation(0, 0, -F.swingPush * s), M);
  }
  const d = empty ? 0 : Math.max(0, Math.min(1, draw || 0));
  const w = d * d * (3 - 2 * d);
  if (w > 0) M = blendFrames(M, fpDrawnArm(bow), w);
  const wrist = rotateAbout(FP_WRIST, [1, 0, 0], (empty ? F.deviateEmpty : F.deviate) + F.swingWrist * s * (1 - w));
  return { arm: M, hand: mul(M, wrist), wrist };
}

/** The forearm's frame at rest (camera space; see fpHandFrame). @returns {Float64Array} */
function fpRestArm() {
  const F = FP_HAND;
  const z = norm(F.arm);
  const b = norm(F.back);
  const d = b[0] * z[0] + b[1] * z[1] + b[2] * z[2];
  const x = norm([b[0] - d * z[0], b[1] - d * z[1], b[2] - d * z[2]]);
  const y = cross(z, x);
  const g = F.grip;
  return mul(new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, g[0], g[1], g[2], 1]), scaling(F.handScale));
}

/**
 * §100 the held slab's frame at a full draw (camera space, unscaled; its +y the item's length from the grip, +x across its
 * picture, +z out of its face): a throw's length toward FP_HAND.drawThrow.aim, its face to the eye; a bow upright, its
 * string toward the eye.
 * @param {boolean} bow @returns {Float64Array}
 */
export function fpDrawnItem(bow) {
  const F = FP_HAND;
  const g = bow ? F.drawBow.grip : F.drawThrow.grip;
  const toEye = norm([-g[0], -g[1], -g[2]]);
  let X;
  let Y;
  if (bow) {
    // the limbs (across the picture) upright, the top leaning right as the bow lies in the hand at rest (so it turns up the
    // short way and never shows its edge); the string (up the picture) toward the eye, turned from edge-on so the curve shows
    const c = F.drawBow.cant;
    X = [-Math.sin(c), -Math.cos(c), 0];
    const flat = norm([toEye[0], 0, toEye[2]]);
    const t = F.drawBow.turn;
    const along = [flat[0] * Math.cos(t) - flat[2] * Math.sin(t), 0, flat[0] * Math.sin(t) + flat[2] * Math.cos(t)];
    const k = along[0] * X[0] + along[1] * X[1] + along[2] * X[2];
    Y = norm([along[0] - k * X[0], along[1] - k * X[1], along[2] - k * X[2]]);
  } else {
    const a = F.drawThrow.aim;
    Y = norm([a[0] - g[0], a[1] - g[1], a[2] - g[2]]);
    X = norm(cross(Y, toEye)); // across the picture: square to its length and to the way to the eye (its face to the eye)
  }
  const Z = cross(X, Y);
  return new Float64Array([X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, g[0], g[1], g[2], 1]);
}

/** @type {Map<boolean, Float64Array>} the forearm's frame at a full draw, by kind (bow or not) */
const drawnArms = new Map();

/**
 * §100 the forearm's frame at a full draw (camera space): the wrist bent as at rest, the whole turned and moved so the
 * held item lies where fpDrawnItem puts it (its grip at the fist, placed in the hand as `fp.tool` places a tool).
 * @param {boolean} bow @returns {Float64Array}
 */
export function fpDrawnArm(bow) {
  let A = drawnArms.get(bow);
  if (A) return A;
  const F = FP_HAND;
  const tool = mul(rotation(1, F.toolTurn), SWING_PLANE); // the slab in the hand, unscaled: a rotation
  const unwrist = invertAffine(rotateAbout(FP_WRIST, [1, 0, 0], F.deviate));
  const armFor = (item) => mul(mul(mul(item, transpose3(tool)), scaling(F.handScale)), unwrist);
  A = armFor(fpDrawnItem(bow));
  drawnArms.set(bow, A);
  return A;
}

/** A rotation's inverse (its 3 × 3 transposed; no translation). @param {Mat4} m @returns {Float64Array} */
function transpose3(m) {
  return new Float64Array([m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1]);
}

/** A frame's rotation as a unit quaternion [x, y, z, w] (its axes may carry one uniform scale). @param {Mat4} m */
function quatOf(m) {
  const k = Math.hypot(m[0], m[1], m[2]) || 1;
  const a = m[0] / k, b = m[4] / k, c = m[8] / k;
  const d = m[1] / k, e = m[5] / k, f = m[9] / k;
  const g = m[2] / k, h = m[6] / k, i = m[10] / k;
  const tr = a + e + i;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    return [(h - f) / S, (c - g) / S, (d - b) / S, S / 4];
  }
  if (a > e && a > i) {
    const S = Math.sqrt(1 + a - e - i) * 2;
    return [S / 4, (b + d) / S, (c + g) / S, (h - f) / S];
  }
  if (e > i) {
    const S = Math.sqrt(1 + e - a - i) * 2;
    return [(b + d) / S, S / 4, (f + h) / S, (c - g) / S];
  }
  const S = Math.sqrt(1 + i - a - e) * 2;
  return [(c + g) / S, (f + h) / S, S / 4, (d - b) / S];
}

/**
 * Two rigid frames of the same uniform scale blended: the rotation by slerp, the origin along a line (`w` 0 is `A`, 1 `B`).
 * @param {Mat4} A @param {Mat4} B @param {number} w @returns {Float64Array}
 */
export function blendFrames(A, B, w) {
  const qa = quatOf(A);
  let qb = quatOf(B);
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) {
    qb = qb.map((v) => -v);
    dot = -dot;
  }
  let ka = 1 - w;
  let kb = w;
  if (dot < 0.9995) {
    const th = Math.acos(Math.min(1, dot));
    ka = Math.sin((1 - w) * th) / Math.sin(th);
    kb = Math.sin(w * th) / Math.sin(th);
  }
  const q = qa.map((v, n) => v * ka + qb[n] * kb);
  const ql = Math.hypot(q[0], q[1], q[2], q[3]);
  const [x, y, z, s] = q.map((v) => v / ql);
  const k = Math.hypot(A[0], A[1], A[2]);
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * k, 2 * (x * y + z * s) * k, 2 * (x * z - y * s) * k, 0,
    2 * (x * y - z * s) * k, (1 - 2 * (x * x + z * z)) * k, 2 * (y * z + x * s) * k, 0,
    2 * (x * z + y * s) * k, 2 * (y * z - x * s) * k, (1 - 2 * (x * x + y * y)) * k, 0,
    A[12] + (B[12] - A[12]) * w, A[13] + (B[13] - A[13]) * w, A[14] + (B[14] - A[14]) * w, 1,
  ]);
}

/**
 * On a tablet (§95): how far (camera-space metres along x) the whole first-person hand moves so the fist keeps clear of the
 * right cluster of buttons. 0 when the fist at rest (FP_HAND.grip) is already left of the cluster's left edge less
 * FP_HAND.touchGap, or above its top; else the move that puts it there. `clear`: the cluster's left and top edges in NDC
 * (−1..1, y up); `aspect` and `fov` (vertical, degrees) the camera's.
 * @param {{ left: number, top: number }|null|undefined} clear @param {number} aspect @param {number} fov
 * @returns {number}
 */
export function fpClearShift(clear, aspect, fov) {
  if (!clear || !(aspect > 0) || !(fov > 0)) return 0;
  const g = FP_HAND.grip;
  const t = Math.tan((fov * Math.PI) / 360);
  const x = g[0] / -g[2] / (t * aspect);
  const y = g[1] / -g[2] / t;
  const want = clear.left - FP_HAND.touchGap;
  if (x <= want || y >= clear.top) return 0;
  return (want - x) * t * aspect * -g[2];
}

/** In the swing's plane a slab's picture is the hand's (y, z): its head ahead of the knuckles (−z), its face out of the
 * back of the hand (+x). */
const SWING_PLANE = new Float64Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);

/**
 * The first-person hand's parts over the avatar's atlas.
 * @param {AvatarDef} def @param {Skin} s @param {ReturnType<typeof shapes>} S
 * @returns {AvatarFp}
 */
function buildFp(def, s, S) {
  const K = def.body;
  const k = def.hands.palm[0] / 0.042; // the fist is drawn for a child's 4.2 cm palm
  const place = (geo, key, m) => s.place(geo, key, m);
  // the forearm from the wrist back to the elbow (the arm frame), with a pushed-up sleeve's cuff where the model has it
  const wrist = [0.004, 0, FP_WRIST_Z];
  const elbow = [0.004, 0, FP_WRIST_Z + FP_FOREARM];
  const fL = len(wrist, elbow);
  const cuffAt = def.outfit.cuffAt;
  const arm = merge([
    place(S.col(K.fore.rx * 0.85, K.fore.rz * 0.85, foreRings(fL)), 'fpArm', seg(wrist, elbow, null, { back: [1, 0, 0] })),
    ...(cuffAt ? [place(S.col(K.fore.rx * 0.74, K.fore.rz * 0.79, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }]), 'cuff',
      seg(wrist, elbow, translation(0, fL * cuffAt - 0.017, 0), { back: [1, 0, 0] }))] : []),
  ]);
  /**
   * The hand: the palm and the back of the hand (a block beside the haft, the wrist behind it), four fingers (index at the
   * top) through the knuckle, middle and tip, a thumb. The finger rows lie across +y; each point is [x, z] in its row.
   * @param {number[][]} curl  [knuckle, middle, end, tip] per finger
   * @param {number[][]} thumb  three points
   */
  const handGeo = (curl, thumb) => {
    const geos = [place(S.block(0.034, 0.078, 0.07, { top: { sx: 0.95, sz: 0.92 } }), 'hand', compose({ t: [0.02, 0.001, 0.018], r: [0, -0.08, 0] }))];
    const rows = [0.027, 0.009, -0.009, -0.026];
    const radius = [0.0092, 0.0095, 0.0092, 0.0082];
    rows.forEach((y, i) => {
      const pts = curl.map(([px, pz]) => [px, y, pz]);
      const finger = (r, p0, p1) => S.col(r, r * 0.92, [{ y: 0, sx: 1 }, { y: len(p0, p1), sx: 0.92 }]);
      for (let j = 0; j < 3; j++) {
        geos.push(place(finger(radius[i] * (1 - 0.06 * j), pts[j], pts[j + 1]), 'hand', seg(pts[j], pts[j + 1], null, { back: [0, 0, 1] })));
      }
    });
    const [t0, t1, t2] = thumb;
    geos.push(place(S.col(0.0125, 0.011, [{ y: 0, sx: 1.1 }, { y: len(t0, t1), sx: 0.95 }]), 'hand', seg(t0, t1, null, { back: [1, 0, 0] })));
    geos.push(place(S.col(0.011, 0.0095, [{ y: 0 }, { y: len(t1, t2), sx: 0.85 }]), 'hand', seg(t1, t2, null, { back: [1, 0, 0] })));
    return transform(merge(geos), scaling(k));
  };
  // curled round the haft: across its front, then back along its far side
  const grip = handGeo([[0.03, -0.019], [-0.006, -0.026], [-0.024, -0.005], [-0.018, 0.016]],
    [[0.012, 0.03, 0.038], [-0.016, 0.038, 0.012], [-0.02, 0.026, -0.016]]);
  // loosely open: the fingers reach ahead and curl down a little, the thumb rests along the index finger
  const relaxed = handGeo([[0.03, -0.019], [0.014, -0.044], [-0.004, -0.054], [-0.016, -0.045]],
    [[0.012, 0.03, 0.038], [-0.006, 0.04, 0.008], [-0.012, 0.034, -0.02]]);
  const F = FP_HAND;
  const tool = mul(rotation(1, F.toolTurn), mul(SWING_PLANE, scaling(F.toolScale)));
  // a lump stands on the fist facing the eye: its picture upright in the view, turned toward the camera
  const rest = fpHandFrame(0).hand;
  const inv = invertAffine(rest);
  const at = F.lumpAt;
  const centre = [0, 1, 2].map((a) => rest[a] * at[0] + rest[4 + a] * at[1] + rest[8 + a] * at[2] + rest[12 + a]);
  const toEye = norm([-centre[0], -centre[1], -centre[2]]);
  const side = norm(cross([0, 1, 0], toEye));
  const up = cross(toEye, side);
  const face = new Float64Array([side[0], side[1], side[2], 0, up[0], up[1], up[2], 0, toEye[0], toEye[1], toEye[2], 0, centre[0], centre[1], centre[2], 1]);
  const lump = mul(inv, mul(face, scaling(F.lumpScale)));
  return { arm, grip, relaxed, tool, lump };
}

/** The inverse of an affine matrix (column-major). @param {Mat4} m @returns {Float64Array} */
function invertAffine(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const k = 1 / det;
  const r = new Float64Array(16);
  r[0] = (e * i - f * h) * k; r[4] = -(b * i - c * h) * k; r[8] = (b * f - c * e) * k;
  r[1] = -(d * i - f * g) * k; r[5] = (a * i - c * g) * k; r[9] = -(a * f - c * d) * k;
  r[2] = (d * h - e * g) * k; r[6] = -(a * h - b * g) * k; r[10] = (a * e - b * d) * k;
  r[15] = 1;
  for (let row = 0; row < 3; row++) r[12 + row] = -(r[row] * m[12] + r[4 + row] * m[13] + r[8 + row] * m[14]);
  return r;
}

/**
 * The first-person hand in camera space, in one geometry (the gallery, the tests): `stroke` 0 at rest .. 1 at the bottom
 * of the chop; `empty` the open hand. `tool` places heldItem.js's slab of a tool in camera space.
 * @param {AvatarDef} def @param {number} [stroke] @param {{ empty?: boolean }} [o]
 * @returns {{ geo: Geo, image: Img, tris: number, tool: Float64Array, atlas: [number, number], texels: number }}
 */
export function fpHandModel(def, stroke = 0, { empty = false } = {}) {
  const m = avatarModel(def);
  const f = fpHandFrame(stroke, empty);
  const geo = merge([transform(m.fp.arm, f.arm), transform(empty ? m.fp.relaxed : m.fp.grip, f.hand)]);
  return { geo, image: m.image, tris: triangleCount(geo), tool: mul(f.hand, m.fp.tool), atlas: m.atlas, texels: m.texels };
}

