// Caelancraft — the art-direction pilot's models (PURE: typed arrays, no three, no DOM). Shown by gallery.html next
// to today's models. See docs/DESIGN-characters.md.
//
// The chosen look, A: HEX-FACETED. The kit for every figure is figureKit.js (faceted heads, hair, the Skin atlas, the
// style's shapes); the avatars left the pilot in phase 1 — they are avatarModel.js, the game's own models, and the pilot
// shows them from there (buildPilot('caelan'), buildHand). What is still a pilot here: the zombie walker, the sheep and
// the pig, the honeyberry bush (near and far) and a sapling — later phases of the rollout.
// A model is { geo, image, tris, texels, atlas: [w, h] }: one merged geometry in its own frame (metres; a figure stands on
// its feet at the origin and faces −Z; the first-person hand is in CAMERA space), one RGBA atlas (sRGB bytes, row 0 at
// the top, a DataTexture with flipY off) and its budgets. Static poses only: the pilot is about the look.
import { loft, prism, transform, compose, mul, translation, rotation, scaling, identity, triangleCount } from './modelKit.js';
import { mix, shade, fbm, hash2, makeRng } from './paintKit.js';
import {
  STYLES, DENSITY, perimeter, Skin, shapes, seg, len, headSkin, addHead, hairShell, addLocks, onHead, rotateAbout,
} from './figureKit.js';
import { buildAvatarModel, restGeometry, fpHandModel, HAIR_CUTS } from './avatarModel.js';
import { AVATARS, avatarById } from './avatars.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./paintKit.js').Rect} Rect */
/** @typedef {import('./figureKit.js').PilotModel} PilotModel */
/** @typedef {import('./figureKit.js').Style} Style */
/** @typedef {import('./figureKit.js').HeadDims} HeadDims */

export { STYLES };

/** The walker's head: a narrow jaw, sunken cheeks, a heavy brow standing out over the eyes, a long skull. */
const ZOMBIE_HEAD = Object.freeze([
  [0, 0.44, 0.5, -0.03], [0.13, 0.64, 0.74, -0.018], [0.32, 0.8, 0.88, -0.004], [0.5, 0.97, 0.95, 0],
  [0.6, 1.0, 1.03, -0.016], [0.72, 0.98, 0.99, 0], [0.87, 0.95, 1.03, 0.012], [0.96, 0.72, 0.78, 0.016], [1, 0.42, 0.46, 0.014],
]);

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
    case 'zombie': return buildZombie(st, paintZombie());
    case 'sheep': return buildSheep(st, paintSheep());
    case 'pig': return buildPig(st, paintPig());
    case 'honeyberry': return buildHoneyberry(st, paintBush());
    case 'honeyberry_far': return buildHoneyberryFar(st, paintBush());
    case 'sapling': return buildSapling(st, paintBush());
    default: throw new RangeError(`no pilot model ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The zombie walker (zombieSkin.js's walker palette): a dead person under moonlight — gaunt, stooped, arms out ahead,
// grey-green skin, sunken hollows round narrow slits, a slack mouth; a faded flannel shirt torn at the hem and the
// sleeves, patched trousers, worn shoes. Spooky, never frightening: no blood, no wounds, no bones, nothing red.
// ---------------------------------------------------------------------------------------------------

const WALKER = Object.freeze({
  skin: [0xb0bfa8, 0xa5b59d, 0x97a890, 0x4d5b4a], dark: 0x748570,
  hair: [0x5a4c40, 0x40352c, 0x372d25, 0x2c231d],
  shirt: [0x9aa6b2, 0x86929e, 0x6c7783], plaidLine: 0xc9c2ae,
  trousers: [0x52566a, 0x474b56, 0x383b44], patch: [0x8a7a5e, 0x7a6a50, 0x5e5240],
  shoe: [0x4a3b30, 0x2f2721, 0x201a16], belt: 0x3a2e24, buckle: 0x8f8869, thread: 0xd8cfb4,
});

const ZOMBIE = Object.freeze({
  legX: 0.095, ankleY: 0.085, hip: 0.86,
  leg: { rx: 0.084, rz: 0.086, rings: [{ y: 0, sx: 0.78 }, { y: 0.23, sx: 0.86 }, { y: 0.34, sx: 0.8 }, { y: 0.57, sx: 0.98 }, { y: 0.73, sx: 1 }] },
  hips: { y0: 0.76, y1: 0.95, rx: 0.168, rz: 0.106 },
  torso: { y0: 0.82, rx: 0.192, rz: 0.11, rings: [{ y: 0, sx: 1.04, sz: 1.05 }, { y: 0.12, sx: 0.95 }, { y: 0.4, sx: 1, sz: 1.04 }, { y: 0.56, sx: 0.97 }, { y: 0.615, sx: 0.7, sz: 0.76 }] },
  neck: { y0: 1.38, y1: 1.5, r: 0.046 },
  /** @type {HeadDims} */
  head: { y: 1.465, h: 0.34, rx: 0.148, rz: 0.155, eyeAt: 0.5, eyeX: 0.052, eyeW: 0.06, mouthAt: 0.2, noseAt: 0.36 },
  shoulder: [0.215, 1.38, 0.0],
  upper: { rx: 0.058, rz: 0.055 },
  lean: 0.2,
});

function paintZombie() {
  const W = WALKER;
  const D = DENSITY.body;
  const DH = DENSITY.head;
  const Z = ZOMBIE;
  const s = new Skin(256, 256, 13);
  const skinR = W.skin;
  const mottled = (p) => {
    p.skin(skinR).mottle(0.1, 5);
    const rnd = makeRng(5);
    for (let i = 0; i < (p.w * p.h) / 140; i++) p.glow(rnd() * p.w, rnd() * p.h, 2 + rnd() * 4, W.dark, 0.18);
  };
  headSkin(s, 'head', Z.head, mottled, { kind: 'zombie', skin: skinR, brows: W.hair[3] });
  s.plain('skin', 32, 32, (p) => mottled(p));
  s.wrap('neck', Math.round(perimeter(Z.neck.r, Z.neck.r) * D), Math.round((Z.neck.y1 - Z.neck.y0) * D), (p) => {
    mottled(p);
    p.ao({ top: 0.5, width: 0.6 });
  });
  s.plain('hair', 48, 48, (p) => p.hair(W.hair, { dir: [0.2, 1], sheen: -1, strand: 2 }));
  // the shirt: faded flannel, buttoned down the front (one button gone), a sewn patch, a tear, its hem torn away
  const tw = Math.round(perimeter(Z.torso.rx * 1.02, Z.torso.rz * 1.04) * D);
  const th = Math.round(Z.torso.rings[4].y * D);
  s.wrap('shirt', tw, th, (p) => {
    p.plaid(W.shirt, { cell: 11, band: 4, line: W.plaidLine });
    p.line(tw / 2 + 2.5, 3, tw / 2 + 2.5, th, 0.5, W.shirt[2], 0.9);
    [0.2, 0.38, 0.56, 0.74].forEach((t, i) => {
      if (i === 2) p.line(tw / 2 - 1, th * t, tw / 2 + 1, th * t + 1, 0.4, W.thread, 0.9);
      else p.ellipse(tw / 2, th * t, 1.6, 1.6, 0xd2c9ad, 1).ellipse(tw / 2, th * t, 0.5, 0.5, 0x6b6450, 1);
    });
    p.patch(tw * 0.62, th * 0.42, 9, 8, W.patch, W.thread);
    p.tear(tw * 0.36, th * 0.62, 3.2, W.shirt);
    p.tear(tw * 0.9, th * 0.3, 2.6, W.shirt);
    for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, W.shirt, { stitch: false });
    p.shadeV(1.04, 0.86);
    p.ragged({ edge: 'bottom', depth: 7, period: 3.5 });
  }, {
    cap: [36, 22],
    top: (p) => {
      p.plaid(W.shirt, { cell: 11, band: 4, line: W.plaidLine });
      p.ellipse(18, 11, 7, 6, W.shirt[2], 1).ellipse(18, 11, 5.4, 4.6, 0x2a2e2a, 1);
    },
  });
  const uL = 0.27;
  const uw = Math.round(perimeter(Z.upper.rx * 1.25, Z.upper.rz * 1.25) * D);
  s.wrap('sleeve', uw, Math.round(0.17 * D), (p) => {
    p.plaid(W.shirt, { cell: 11, band: 4, line: W.plaidLine });
    p.shadeV(1.06, 0.88);
    p.ragged({ edge: 'bottom', depth: 5, period: 2.5 });
  });
  s.wrap('arm', Math.round(perimeter(Z.upper.rx, Z.upper.rz) * D), Math.round(uL * D), (p) => {
    mottled(p);
    p.ao({ top: 0.3, width: 0.3 });
  }, { top: mottled, bottom: mottled });
  s.plain('hand', 24, 24, (p) => {
    mottled(p);
    p.shadeV(1.0, 0.82);
  });
  // trousers: a belt, a patched knee on one leg, worn paler at the other
  const jw = Math.round(perimeter(Z.hips.rx, Z.hips.rz) * D);
  const jh = Math.round((Z.hips.y1 - Z.hips.y0) * D);
  s.wrap('hips', jw, jh, (p) => {
    p.cloth(W.trousers, { fold: 1 });
    p.fill((x, y) => (y > jh - 7 ? shade(W.belt, 0.9 + 0.15 * hash2(x, y, 3)) : p.get(x, y)));
    p.ellipse(jw / 2, jh - 3.5, 3, 2.3, W.buckle, 1).ellipse(jw / 2, jh - 3.5, 1.6, 1.0, W.belt, 1);
    for (const u of [0.25, 0.75]) p.seam(jw * u, 0, jw * u, jh - 7, W.trousers);
  });
  const lw = Math.round(perimeter(Z.leg.rx, Z.leg.rz) * D);
  const lh = Math.round(Z.leg.rings[4].y * D);
  for (const side of ['L', 'R']) {
    s.wrap(`leg${side}`, lw, lh, (p) => {
      p.cloth(W.trousers, { fold: 1.2 });
      for (const u of [0.25, 0.75]) p.seam(lw * u, 0, lw * u, lh, W.trousers, { stitch: false });
      if (side === 'L') p.patch(lw * 0.36, lh * 0.5, 11, 10, W.patch, W.thread);
      else p.glow(lw * 0.5, lh * 0.55, 7, W.trousers[0], 0.5, 9).tear(lw * 0.55, lh * 0.82, 2.4, W.trousers);
      p.shadeV(0.86, 1.0);
      p.ragged({ edge: 'bottom', depth: 3, period: 2 });
    });
  }
  const [sl, sm, sd] = W.shoe;
  s.box('shoe', Math.round(0.12 * DH), Math.round(0.09 * DH), Math.round(0.25 * DH), {
    all: (p) => {
      p.cloth([sl, sm, sd], { fold: 1.2 }).mottle(0.12, 3);
      p.fill((x, y) => (y > p.h - 4 ? shade(sd, 0.9 + 0.2 * hash2(x, y, 9)) : p.get(x, y)));
      p.stitches(0, p.h - 6, p.w, p.h - 6, shade(sl, 1.2), { a: 0.5 });
    },
    top: (p) => {
      p.cloth([sl, sm, sd], { fold: 1.2 }).mottle(0.12, 3);
      for (let k = 0; k < 3; k++) p.line(p.w * 0.3, p.h * (0.45 + 0.1 * k), p.w * 0.7, p.h * (0.47 + 0.1 * k), 0.6, 0x1a1512, 0.9);
    },
  });
  return s;
}

/** The walker after someone: stooped, arms out ahead (one higher), head lolling. @param {Style} st @param {Skin} s */
function buildZombie(st, s) {
  const S = shapes(st);
  const Z = ZOMBIE;
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  // legs: the left a short step ahead (it limps)
  for (const side of [-1, 1]) {
    const x = side * Z.legX;
    const stride = side < 0 ? -0.07 : 0.05;
    const legM = rotateAbout([x, Z.hip, 0], [1, 0, 0], side < 0 ? 0.1 : -0.06);
    add(S.block(0.12, 0.09, 0.25, { top: { sx: 0.9, sz: 0.82, dz: 0.02 } }), 'shoe', compose({ t: [x, 0.045, stride - 0.04], r: [0, side * -0.12, 0] }));
    add(S.col(Z.leg.rx, Z.leg.rz, Z.leg.rings), `leg${side < 0 ? 'L' : 'R'}`, mul(legM, translation(x, Z.ankleY, 0)));
  }
  add(S.col(Z.hips.rx, Z.hips.rz, [{ y: 0, sx: 0.97 }, { y: Z.hips.y1 - Z.hips.y0 }]), 'hips', translation(0, Z.hips.y0, 0));
  // everything above the hips stoops forward about them
  const U = rotateAbout([0, Z.hip, 0], [1, 0, 0], -Z.lean);
  const up = (M) => mul(U, M);
  add(S.col(Z.torso.rx, Z.torso.rz, Z.torso.rings), 'shirt', up(translation(0, Z.torso.y0, 0)));
  // the head lolls: forward and to one side, on a thin neck
  const neckBase = [0, Z.neck.y0, 0];
  const loll = mul(rotateAbout(neckBase, [0, 0, 1], 0.16), rotateAbout(neckBase, [1, 0, 0], -0.22));
  add(S.col(Z.neck.r, Z.neck.r, [{ y: 0 }, { y: Z.neck.y1 - Z.neck.y0, sx: 0.92 }], { caps: false }), 'neck', up(mul(loll, translation(0, Z.neck.y0, 0))));
  const H = Z.head;
  const head = up(mul(loll, translation(0, H.y, 0)));
  addHead(add, head, H, ZOMBIE_HEAD, { nose: [0.05, 0.034, 0.07] });
  // thin, lank hair: a receding shell, a few strands over the brow, straggles at the sides and the back
  hairShell(add, head, H, 'hair', { grow: 0.01, base: 0.74, tilt: 0.48 });
  addLocks(add, head, 'hair', [[-0.08, 0.06, 0.03], [-0.02, 0.09, 0.025], [0.06, 0.07, 0.03]].map(([x, l, w]) =>
    [[x, 0.93 * H.h, -H.rz * 0.8], [x + 0.02, (0.93 - l / H.h) * H.h, -H.rz * 1.02], l + 0.02, w, 0.01, 0.01, -0.006]));
  addLocks(add, head, 'hair', [[100, 0.12], [125, 0.1], [-105, 0.13], [-130, 0.11], [165, 0.14], [-160, 0.12], [180, 0.13]].map(([deg, l]) =>
    [onHead(H, 180 - deg, 0.78, -0.004), onHead(H, 180 - deg * 1.02, 0.78 - l / H.h, 0.02), l, 0.04, 0.012, 0, 0.01]), { face: [0, 0, 1] });
  // arms out ahead, the left higher; ragged short sleeves; hands hanging limp from the wrists
  for (const side of [-1, 1]) {
    const sh = [side * Z.shoulder[0], Z.shoulder[1], Z.shoulder[2]];
    const el = side < 0 ? [-0.225, 1.3, -0.23] : [0.235, 1.22, -0.21];
    const wr = side < 0 ? [-0.205, 1.37, -0.49] : [0.215, 1.25, -0.47];
    const uL = len(sh, el);
    add(S.col(Z.upper.rx, Z.upper.rz, [{ y: 0, sx: 0.6 }, { y: 0.035, sx: 1 }, { y: uL, sx: 0.85 }]), 'arm', up(seg([sh[0], sh[1] + 0.035, sh[2]], el)));
    add(S.col(Z.upper.rx * 1.25, Z.upper.rz * 1.25, [{ y: 0, sx: 1.08 }, { y: 0.13, sx: 1 }, { y: 0.17, sx: 0.62 }], { caps: { top: true, bottom: false } }), 'sleeve',
      up(seg([sh[0], sh[1] + 0.04, sh[2]], el, mul(translation(0, 0.17, 0), scaling(1, -1, 1)))));
    const fL = len(el, wr);
    add(S.col(Z.upper.rx * 0.9, Z.upper.rz * 0.9, [{ y: 0 }, { y: fL, sx: 0.78 }]), 'arm', up(seg(el, wr)));
    const hand = up(mul(seg(el, wr, translation(0, fL, 0), { back: [0, -1, 0] }), rotation(0, 1.0)));
    add(S.block(0.075, 0.075, 0.035, { top: { sx: 1.08 } }), 'hand', mul(hand, translation(0, 0.035, 0.005)));
    add(S.block(0.066, 0.06, 0.03), 'hand', mul(hand, compose({ t: [0, 0.095, 0.018], r: [0.55, 0, 0] })));
  }
  return s.model(parts);
}

// ---------------------------------------------------------------------------------------------------
// The sheep (animalRenderer.js's ewe: cream fleece, a dark face): a woolly barrel on thin dark legs, a long face with
// its eyes on the sides, drooping ears, a tuft on the crown, a stub of a tail
// ---------------------------------------------------------------------------------------------------

const SHEEP = Object.freeze({
  wool: [0xfffffb, 0xf6f2e8, 0xe3dccd], face: [0x6a625a, 0x4a443e, 0x35302b], hoof: 0x2a2420, inner: 0xc9a29a,
  body: {
    rx: 0.33, rz: 0.28, len: 0.9, y: 0.68,
    // the fleece bulges in rolls along the body: a barrel whose rings swell and pinch
    rings: [{ y: 0, sx: 0.5 }, { y: 0.07, sx: 0.84 }, { y: 0.17, sx: 0.95 }, { y: 0.25, sx: 0.91 }, { y: 0.36, sx: 1 }, { y: 0.46, sx: 0.95 },
      { y: 0.57, sx: 1 }, { y: 0.67, sx: 0.94 }, { y: 0.77, sx: 0.96 }, { y: 0.85, sx: 0.8 }, { y: 0.9, sx: 0.58 }],
  },
  legH: 0.5, legR: 0.048, legX: 0.16, legZ: [-0.27, 0.27],
});

function paintSheep() {
  const SH = SHEEP;
  const D = DENSITY.animal;
  const s = new Skin(256, 256, 21);
  const bw = Math.round(perimeter(SH.body.rx, SH.body.rz) * D);
  const bh = Math.round(SH.body.len * D);
  const fleece = (p) => {
    p.wool(SH.wool, { r: 3.2 });
    // the belly (the middle of the strip) in the fleece's own shadow
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const u = x / p.w;
        const belly = Math.max(0, 1 - Math.abs(u - 0.5) * 4);
        if (belly > 0) p.tone(x, y, 1 - 0.28 * belly);
      }
    }
  };
  s.wrap('fleece', bw, bh, fleece, { cap: [44, 38], top: (p) => p.wool(SH.wool, { r: 3.2 }), bottom: (p) => p.wool(SH.wool, { r: 3.2 }) });
  s.plain('wool', 48, 48, (p) => p.wool(SH.wool, { r: 3 }));
  // the face: short dark fur along the snout, eyes on the sides, a soft muzzle on the front cap
  const hw = Math.round(perimeter(0.1, 0.115) * 128);
  const hh = Math.round(0.26 * 128);
  s.wrap('head', hw, hh, (p) => {
    p.fur(SH.face, { dir: [0, 1], len: 3, density: 0.7 });
    for (const u of [0.25, 0.75]) {
      const cx = hw * u;
      const cy = hh * 0.62;
      p.glow(cx, cy, 6, SH.face[2], 0.5, 4);
      p.ellipse(cx, cy, 3.2, 2.6, 0x1c1714, 1);
      p.ellipse(cx + (u < 0.5 ? 1 : -1), cy - 0.9, 0.9, 0.9, 0xffffff, 1);
      p.arc(cx, cy + 0.5, 3.6, Math.PI * 1.1, Math.PI * 1.9, 0.55, SH.face[0], 0.9, 3);
    }
    p.shadeV(1.0, 0.9);
  }, {
    cap: [26, 28],
    top: (p) => {
      p.fur(SH.face, { dir: [0, 1], len: 2, density: 0.5 });
      p.glow(13, 12, 9, mix(SH.face[0], SH.inner, 0.35), 0.8, 8);
      p.ellipse(9.5, 11, 1.8, 2.4, 0x221c19, 1, 0.4).ellipse(16.5, 11, 1.8, 2.4, 0x221c19, 1, -0.4);
      p.polyline([[13, 14], [13, 18], [9.5, 20.5]], 0.5, 0x221c19, 0.9).polyline([[13, 18], [16.5, 20.5]], 0.5, 0x221c19, 0.9);
    },
  });
  s.plain('ear', 20, 20, (p) => {
    p.fur(SH.face, { dir: [1, 0], len: 2, density: 0.5 });
    p.glow(10, 10, 6, SH.inner, 0.55, 7);
  });
  s.wrap('leg', Math.round(perimeter(SH.legR, SH.legR) * 128), Math.round(SH.legH * 128), (p) => {
    p.fur(SH.face, { dir: [0, 1], len: 2.5, density: 0.5 });
    p.fill((x, y) => (y > p.h - 8 ? shade(SH.hoof, 0.9 + 0.2 * hash2(x, y, 4)) : p.get(x, y)));
    p.line(-1, p.h - 8, p.w + 1, p.h - 8, 0.6, 0x15110f, 0.9);
    p.ao({ top: 0.5, width: 0.3 });
  });
  return s;
}

/** A ewe standing. @param {Style} st @param {Skin} s */
function buildSheep(st, s) {
  const S = shapes(st);
  const SH = SHEEP;
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  const B = SH.body;
  // the body: a barrel of fleece lying along z (its strip's seam along the spine, the belly in the middle)
  const along = (z0) => mul(translation(0, B.y, z0), rotation(0, -Math.PI / 2));
  add(S.col(B.rx, B.rz, B.rings), 'fleece', along(B.len / 2));
  // the legs, hoof at the bottom
  for (const sx of [-1, 1]) {
    for (const z of SH.legZ) add(S.col(SH.legR, SH.legR, [{ y: 0, sx: 0.9 }, { y: SH.legH * 0.4, sx: 0.85 }, { y: SH.legH, sx: 1.1 }]), 'leg', translation(sx * SH.legX, 0, z));
  }
  // the head: a long face pointing ahead and down, a woolly tuft on the crown, ears drooping out to the sides
  const headM = mul(translation(0, 0.9, -0.38), rotation(0, -Math.PI / 2 - 0.62));
  add(S.col(0.1, 0.115, [{ y: 0, sx: 0.9 }, { y: 0.07, sx: 1 }, { y: 0.19, sx: 0.8 }, { y: 0.26, sx: 0.62, sz: 0.66 }]), 'head', headM);
  add(S.puff(0.1, 0.06), 'wool', mul(headM, seg([0, 0.07, 0.09], [0, 0.07, 0.16], null, { back: [0, 1, 0] })));
  for (const side of [-1, 1]) {
    const ear = mul(headM, compose({ t: [side * 0.085, 0.07, 0.05], r: [0.2, 0, side * -1.9] }));
    add(S.nub(0.09, 0.03, 0.05, { sx: 0.5, ridge: 0 }), 'ear', mul(ear, scaling(1, 1, 0.6)));
  }
  add(S.puff(0.08, 0.07, { top: 0.4 }), 'wool', seg([0, 0.78, B.len / 2 - 0.05], [0, 0.7, B.len / 2 + 0.06]));
  return s.model(parts);
}

// ---------------------------------------------------------------------------------------------------
// The pig (pigRenderer.js's pink): a round body on short legs, a broad head with a snout, ears that flop forward,
// a curly tail — pink skin with fine pale bristles and a little mud on the trotters
// ---------------------------------------------------------------------------------------------------

const PIG = Object.freeze({
  skin: [0xf8c3cc, 0xf2a7b5, 0xd98896, 0x9a5866], snout: [0xf0a0ac, 0xe0808f, 0xb8606e], dark: 0x3a1f26, mud: 0x7a5a3e,
  body: { rx: 0.27, rz: 0.25, len: 0.86, y: 0.52, rings: [{ y: 0, sx: 0.62 }, { y: 0.09, sx: 0.92 }, { y: 0.45, sx: 1 }, { y: 0.78, sx: 0.96 }, { y: 0.86, sx: 0.8 }] },
  legH: 0.32, legR: 0.055, legX: 0.15, legZ: [-0.25, 0.27],
});

function paintPig() {
  const P = PIG;
  const D = DENSITY.animal;
  const s = new Skin(256, 256, 31);
  const bristles = (p, k = 1) => {
    p.skin(P.skin).mottle(0.06, 6);
    const rnd = makeRng(p.seed);
    for (let i = 0; i < p.w * p.h * 0.05 * k; i++) {
      const x = rnd() * p.w;
      const y = rnd() * p.h;
      p.line(x, y, x + 0.8, y + 1.8, 0.3, P.skin[0], 0.6);
    }
    return p;
  };
  s.wrap('body', Math.round(perimeter(P.body.rx, P.body.rz) * D), Math.round(P.body.len * D), (p) => {
    bristles(p);
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const belly = Math.max(0, 1 - Math.abs(x / p.w - 0.5) * 4);
        if (belly > 0) p.tone(x, y, 1 - 0.18 * belly);
      }
    }
  }, { cap: [40, 36], top: (p) => bristles(p), bottom: (p) => bristles(p) });
  s.box('head', 48, 42, 40, {
    all: (p) => bristles(p).shadeV(1.04, 0.92),
    front: (p) => {
      bristles(p);
      for (const side of [-1, 1]) {
        const cx = p.w / 2 + side * p.w * 0.24;
        p.ellipse(cx, p.h * 0.36, 2.8, 3.2, 0x2a1a1e, 1).ellipse(cx + side * 0.9, p.h * 0.33, 0.9, 0.9, 0xffffff, 1);
        p.arc(cx, p.h * 0.36, 3.6, Math.PI * 1.15, Math.PI * 1.85, 0.5, P.skin[3], 0.8, 3.2);
        p.glow(cx + side * 3, p.h * 0.62, 5, 0xf08a9a, 0.5, 3.5);
      }
    },
  });
  s.wrap('snout', Math.round(perimeter(0.085, 0.07) * 128), Math.round(0.09 * 128), (p) => {
    p.skin(P.snout).shadeV(1.05, 0.88);
    p.line(p.w * 0.3, p.h * 0.75, p.w * 0.7, p.h * 0.75, 0.6, P.snout[2], 0.8);
  }, {
    cap: [26, 22],
    top: (p) => {
      p.skin(P.snout).mottle(0.05, 3);
      p.ellipse(13, 11, 11, 9, P.snout[0], 0.6);
      p.ellipse(9, 11, 2, 3, P.dark, 1).ellipse(17, 11, 2, 3, P.dark, 1);
    },
  });
  s.plain('ear', 20, 20, (p) => {
    bristles(p);
    p.glow(10, 12, 6, P.skin[2], 0.6, 7);
  });
  s.wrap('leg', Math.round(perimeter(P.legR, P.legR) * 128), Math.round(P.legH * 128), (p) => {
    bristles(p);
    for (let y = Math.floor(p.h * 0.6); y < p.h; y++) {
      for (let x = 0; x < p.w; x++) if (fbm(x / 3, y / 3, 7) > 0.45 - (y / p.h - 0.6)) p.px(x, y, shade(P.mud, 0.9 + 0.2 * hash2(x, y, 2)), 0.85);
    }
    p.fill((x, y) => (y > p.h - 5 ? shade(P.dark, 1.3) : p.get(x, y)));
    p.ao({ top: 0.4, width: 0.3 });
  });
  return s;
}

/** A pig standing. @param {Style} st @param {Skin} s */
function buildPig(st, s) {
  const S = shapes(st);
  const P = PIG;
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  const B = P.body;
  add(S.col(B.rx, B.rz, B.rings), 'body', mul(translation(0, B.y, B.len / 2), rotation(0, -Math.PI / 2)));
  for (const sx of [-1, 1]) {
    for (const z of P.legZ) add(S.col(P.legR, P.legR, [{ y: 0, sx: 0.85 }, { y: P.legH, sx: 1.1 }]), 'leg', translation(sx * P.legX, 0, z));
  }
  const head = translation(0, 0.6, -0.47);
  add(S.block(0.3, 0.26, 0.25, { top: { sx: 0.92, sz: 0.88 } }), 'head', head);
  add(S.col(0.085, 0.07, [{ y: 0 }, { y: 0.075, sx: 1.04 }]), 'snout', mul(head, mul(translation(0, -0.045, -0.105), rotation(0, -Math.PI / 2))));
  for (const side of [-1, 1]) {
    add(S.nub(0.1, 0.03, 0.08, { sx: 0.5, ridge: 0.4 }), 'ear', mul(head, compose({ t: [side * 0.1, 0.125, 0.01], r: [-0.9, side * 0.25, side * -0.35] })));
  }
  // the tail: three short turns of a curl
  let M = translation(0, 0.62, B.len / 2 - 0.02);
  for (let k = 0; k < 3; k++) {
    M = mul(M, compose({ r: [0.9, 0.5, 0] }));
    add(S.col(0.016 - k * 0.003, 0.016 - k * 0.003, [{ y: 0 }, { y: 0.05 }]), 'leg', mul(M, rotation(0, Math.PI / 2)));
    M = mul(M, translation(0, 0, 0.045));
  }
  return s.model(parts);
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
