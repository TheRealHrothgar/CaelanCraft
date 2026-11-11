// Caelancraft — zombie skins (PURE: no three, no DOM). See src/CONTRACTS.md §74.
//
// Pixel art for the three kinds of zombie, painted into one RGBA sheet (ATLAS_W × ATLAS_H, sRGB bytes, row 0 at the top)
// plus a second sheet of what GLOWS (the eyes, and a faint all-over night glow). Each kind has a SKIN_W × SKIN_H page;
// on it every body part is a box unwrapped the usual way: its top and bottom side by side over a strip of its right
// side, front, left side and back (faceRect). A texel is SKIN_TEXEL metres, twice as fine as the terrain's.
//
// The look is SPOOKY, NOT FRIGHTENING: dead people under moonlight. Pale grey-green skin, sunken dark hollows round the
// eyes with a NARROW SLIT in each (never a round eye), old torn clothes. Nothing gory: no blood, no wounds, no bones, no
// fangs, and no red anywhere.
//   walker — vacant: level brows, empty slits that glow a faint marsh green in the dark, a slack mouth;
//   runner — wired: one brow hitched up, uneven slits each with a pale pinprick, dark rings, clenched teeth, wild hair;
//   alpha  — ominous: a black scowl drawn down to the nose, slanted slits that burn amber, a hard down-turned mouth, long
//            black hair and a ragged dark coat.

/** Metres per texel (the terrain's tiles are 1/16). */
export const SKIN_TEXEL = 1 / 32;
/** One kind's page, and the whole sheet (the kinds stacked in SKIN_KINDS order). */
export const SKIN_W = 128;
export const SKIN_H = 64;
export const SKIN_KINDS = Object.freeze(['walker', 'runner', 'alpha']);
export const ATLAS_W = SKIN_W;
export const ATLAS_H = SKIN_H * SKIN_KINDS.length;

/**
 * The parts: box sizes in texels (w across, h tall, d deep) and where each unwraps on a kind's page. `hair` is a layer
 * round the head and `coat` a layer round the torso (transparent where there is none).
 */
export const PARTS = Object.freeze({
  head: Object.freeze({ w: 13, h: 13, d: 12, x: 0, y: 0 }),
  hair: Object.freeze({ w: 13, h: 13, d: 12, x: 50, y: 0 }),
  leg: Object.freeze({ w: 7, h: 24, d: 7, x: 100, y: 0 }),
  torso: Object.freeze({ w: 16, h: 20, d: 8, x: 0, y: 31 }),
  coat: Object.freeze({ w: 16, h: 20, d: 8, x: 48, y: 31 }),
  upperArm: Object.freeze({ w: 5, h: 11, d: 5, x: 96, y: 31 }),
  foreArm: Object.freeze({ w: 5, h: 12, d: 5, x: 96, y: 47 }),
});

/** @typedef {'top'|'bottom'|'right'|'front'|'left'|'back'} FaceName */
export const FACES = Object.freeze(['top', 'bottom', 'right', 'front', 'left', 'back']);

/**
 * Where a part's face sits on a kind's page. Seen from outside, x runs to the viewer's right and y down; the right
 * side's last column and the left side's first column are the ones next to the front.
 * @param {{ w: number, h: number, d: number, x: number, y: number }} part
 * @param {FaceName} face
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function faceRect(part, face) {
  const { w, h, d, x, y } = part;
  switch (face) {
    case 'top': return { x: x + d, y, w, h: d };
    case 'bottom': return { x: x + d + w, y, w, h: d };
    case 'right': return { x, y: y + d, w: d, h };
    case 'front': return { x: x + d, y: y + d, w, h };
    case 'left': return { x: x + d + w, y: y + d, w: d, h };
    default: return { x: x + d + w + d, y: y + d, w, h };
  }
}

/** The eyes on the head's front face (texel columns from the left, rows from the top). */
export const EYE_ROW = 6;
export const EYE_COLS = Object.freeze({ left: Object.freeze([1, 2, 3, 4]), right: Object.freeze([8, 9, 10, 11]) });

/** The slits: near black by day. */
export const SLIT = 0x0c0e0c;
/** What the eyes give off in the dark: a faint marsh green, a pale pinprick, a hot amber (never red). */
export const EYE_GLOW = Object.freeze({ walker: 0x6aa873, runner: 0xdfe6a8, alpha: 0xffa42e });
/** The faint glow every zombie has, so its shape reads on a moonlit night. */
export const NIGHT_GLOW = 0x1c2418;

const PAL = Object.freeze({
  walker: {
    skin: [0xb0bfa8, 0xa5b59d, 0x97a890], dark: 0x748570, deep: 0x4d5b4a,
    hair: [0x40352c, 0x372d25, 0x2c231d],
    shirt: [0xb4aea2, 0xaaa498, 0x9d978c], shirtDark: 0x77726a,
    trousers: [0x474b56, 0x40444e, 0x383b44], shoe: [0x2f2721, 0x201a16],
    belt: 0x3a2e24, buckle: 0x8f8869, mouth: 0x231d1c, teeth: 0xc4bda2,
  },
  runner: {
    skin: [0xc0c49a, 0xb5b98e, 0xa6aa80], dark: 0x858962, deep: 0x5a5e40,
    hair: [0x8d7b4b, 0x7d6c40, 0x6a5b35],
    shirt: [0xb4aea2, 0xaaa498, 0x9d978c], shirtDark: 0x77726a,
    trousers: [0x5c5145, 0x534940, 0x483f37], shoe: [0x2f2721, 0x201a16],
    belt: 0x3a2e24, buckle: 0x8f8869, mouth: 0x231d1c, teeth: 0xd2cbae,
  },
  alpha: {
    skin: [0x93a09a, 0x899690, 0x7c8983], dark: 0x586460, deep: 0x232a28,
    hair: [0x3a3432, 0x2e2928, 0x242020], brow: 0x0f0d0d,
    shirt: [0x5a5552, 0x524d4a, 0x484442], shirtDark: 0x34302f,
    trousers: [0x33353b, 0x2d2f34, 0x26282c], shoe: [0x1c1815, 0x120f0d],
    belt: 0x231c17, buckle: 0x6f6a55, mouth: 0x151212, teeth: 0xb4ad94,
    coat: [0x453c37, 0x3b332f, 0x312a27], coatDark: 0x1d1816,
  },
});

/** A small integer hash of two coordinates and a salt, 0..1. */
function hash(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** A painter for one face: local texel coordinates, clipped to the face. */
class Face {
  /**
   * @param {Uint8Array} data  @param {Uint8Array} glow  @param {number} page  the kind's index
   * @param {{ x: number, y: number, w: number, h: number }} rect  @param {number} salt
   */
  constructor(data, glow, page, rect, salt) {
    this.data = data;
    this.glowData = glow;
    this.ox = rect.x;
    this.oy = rect.y + page * SKIN_H;
    this.w = rect.w;
    this.h = rect.h;
    this.salt = salt;
  }

  /** One texel (rgb as 0xRRGGBB). */
  px(x, y, rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = ((this.oy + y) * ATLAS_W + this.ox + x) * 4;
    this.data[i] = (rgb >> 16) & 255;
    this.data[i + 1] = (rgb >> 8) & 255;
    this.data[i + 2] = rgb & 255;
    this.data[i + 3] = 255;
  }

  /** Make a texel see-through again (the layers). */
  clear(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[((this.oy + y) * ATLAS_W + this.ox + x) * 4 + 3] = 0;
  }

  /** A texel that gives off light of its own. */
  glow(x, y, rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = ((this.oy + y) * ATLAS_W + this.ox + x) * 4;
    this.glowData[i] = (rgb >> 16) & 255;
    this.glowData[i + 1] = (rgb >> 8) & 255;
    this.glowData[i + 2] = rgb & 255;
    this.glowData[i + 3] = 255;
  }

  /** A filled box x0..x1, y0..y1 (inclusive). */
  box(x0, y0, x1, y1, rgb) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, rgb);
  }

  row(y, x0, x1, rgb) {
    this.box(x0, y, x1, y, rgb);
  }

  /** A box mottled from a ramp [light, mid, dark]: mostly mid, with flecks of the other two; `lower` darkens the bottom rows. */
  mottle(x0, y0, x1, y1, ramp, lower = 0) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const n = hash(x + this.ox, y + this.oy, this.salt);
        let k = n < 0.07 ? 0 : n > 0.92 ? 2 : 1;
        if (lower > 0 && y > y1 - lower && k < 2) k++;
        this.px(x, y, ramp[k]);
      }
    }
  }

  /** The whole face, mottled. */
  fill(ramp, lower = 0) {
    this.mottle(0, 0, this.w - 1, this.h - 1, ramp, lower);
  }

  /**
   * The whole face as CLOTH from a ramp [light, mid, dark]: flat mid, a few long folds running down it (a dark line with
   * a light one beside it), darker along the bottom `lower` rows.
   */
  cloth(ramp, lower = 0) {
    this.box(0, 0, this.w - 1, this.h - 1, ramp[1]);
    for (let x = 0; x < this.w; x++) {
      const n = hash(x + this.ox, this.oy, this.salt + 7);
      if (n > 0.3) continue;
      const y0 = Math.floor(hash(x, 1, this.salt) * this.h * 0.5);
      const len = 3 + Math.floor(hash(x, 2, this.salt) * this.h * 0.5);
      for (let y = y0; y < Math.min(this.h, y0 + len); y++) {
        this.px(x, y, ramp[2]);
        if (x + 1 < this.w && n < 0.15) this.px(x + 1, y, ramp[0]);
      }
    }
    for (let y = Math.max(0, this.h - lower); y < this.h; y++) for (let x = 0; x < this.w; x++) if (hash(x, y, this.salt + 3) < 0.7) this.px(x, y, ramp[2]);
  }
}

/**
 * Paint every kind. `data` is the colour sheet (alpha 0 where a layer has nothing), `glow` what shines in the dark
 * (NIGHT_GLOW wherever `data` is opaque, EYE_GLOW on the eyes).
 * @returns {{ width: number, height: number, data: Uint8Array, glow: Uint8Array }}
 */
export function paintZombieAtlas() {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const glow = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  SKIN_KINDS.forEach((kind, page) => {
    /** @param {keyof typeof PARTS} part  @param {FaceName} face */
    const f = (part, face) => new Face(data, glow, page, faceRect(PARTS[part], face), page * 97 + FACES.indexOf(face) * 13 + Object.keys(PARTS).indexOf(part) * 31);
    paintHead(kind, f);
    paintHair(kind, f);
    paintTorso(kind, f);
    paintArms(kind, f);
    paintLeg(kind, f);
    if (kind === 'alpha') paintCoat(f);
  });
  // the faint night glow, wherever something was painted and nothing brighter shines
  for (let i = 0; i < data.length; i += 4) {
    glow[i + 3] = 255;
    if (data[i + 3] === 0 || glow[i] + glow[i + 1] + glow[i + 2] > 0) continue;
    glow[i] = (NIGHT_GLOW >> 16) & 255;
    glow[i + 1] = (NIGHT_GLOW >> 8) & 255;
    glow[i + 2] = NIGHT_GLOW & 255;
  }
  return { width: ATLAS_W, height: ATLAS_H, data, glow };
}

/** The head: a person's face with sunken hollows round narrow slits; ears; hair painted under the hair layer. */
function paintHead(kind, f) {
  const p = PAL[kind];
  const front = f('head', 'front');
  front.fill(p.skin, 2);
  front.row(0, 0, 12, p.hair[1]);
  front.px(0, 1, p.hair[1]);
  front.px(12, 1, p.hair[1]);
  // gaunt cheeks, the nose, the jaw
  front.box(0, 8, 0, 10, p.dark);
  front.box(12, 8, 12, 10, p.dark);
  front.px(1, 9, p.dark);
  front.px(11, 9, p.dark);
  front.box(6, 6, 6, 8, p.skin[2]);
  front.row(8, 5, 7, p.dark);
  front.px(5, 9, p.deep);
  front.px(7, 9, p.deep);
  front.row(12, 0, 12, p.skin[2]);
  front.px(0, 12, p.dark);
  front.px(12, 12, p.dark);
  const L = EYE_COLS.left;
  const R = EYE_COLS.right;
  if (kind === 'walker') {
    // vacant: level brows, deep hollows, a level empty slit in each, a slack mouth hanging a little open
    front.row(4, 1, 4, p.hair[1]);
    front.row(4, 8, 11, p.hair[1]);
    for (const cols of [L, R]) {
      front.box(cols[0], 5, cols[3], 7, p.dark);
      front.row(5, cols[0], cols[3], p.deep);
      front.row(EYE_ROW, cols[0], cols[3], SLIT);
      for (const x of cols) front.glow(x, EYE_ROW, EYE_GLOW.walker);
    }
    front.px(0, 6, p.dark);
    front.px(12, 6, p.dark);
    front.row(10, 4, 8, p.mouth);
    front.row(11, 5, 7, p.mouth);
    front.row(11, 4, 4, p.dark);
    front.row(11, 8, 8, p.dark);
  } else if (kind === 'runner') {
    // wired: one brow hitched up, uneven slits each with a pale pinprick, dark rings, clenched teeth, a crooked jaw
    front.row(4, 1, 4, p.hair[2]);
    front.row(3, 8, 10, p.hair[2]);
    front.px(11, 2, p.hair[2]);
    front.px(8, 4, p.hair[2]);
    front.box(L[0], 5, L[3], 8, p.dark);
    front.box(R[0], 5, R[3], 8, p.dark);
    front.row(5, L[0], L[3], p.deep);
    front.row(4, R[0] + 1, R[3], p.deep);
    front.row(8, L[0] + 1, L[3], p.deep);
    front.row(8, R[0], R[3] - 1, p.deep);
    front.row(EYE_ROW, L[0], L[3], SLIT);
    front.row(EYE_ROW, R[0], R[2], SLIT);
    front.px(L[2], EYE_ROW, EYE_GLOW.runner);
    front.px(R[1], EYE_ROW, EYE_GLOW.runner);
    front.glow(L[2], EYE_ROW, EYE_GLOW.runner);
    front.glow(R[1], EYE_ROW, EYE_GLOW.runner);
    front.row(10, 3, 9, p.mouth);
    for (let x = 3; x <= 9; x += 2) front.px(x, 10, p.teeth);
    front.row(11, 5, 10, p.mouth);
    front.px(4, 11, p.dark);
    front.px(2, 10, p.dark);
  } else {
    // ominous: a black scowl stepping down to the nose, slanted slits that burn, a hard mouth turned down, a heavy jaw
    for (const s of [1, -1]) {
      const x = (i) => (s > 0 ? i : 12 - i);
      front.row(3, Math.min(x(1), x(2)), Math.max(x(1), x(2)), p.brow);
      front.row(4, Math.min(x(1), x(4)), Math.max(x(1), x(4)), p.brow);
      front.row(5, Math.min(x(3), x(5)), Math.max(x(3), x(5)), p.brow);
      front.box(Math.min(x(1), x(2)), 5, Math.max(x(1), x(2)), 6, p.deep);
      front.box(Math.min(x(3), x(4)), 6, Math.max(x(3), x(4)), 7, p.deep);
      for (const [i, y] of [[1, 5], [2, 5], [3, 6], [4, 6]]) {
        front.px(x(i), y, EYE_GLOW.alpha);
        front.glow(x(i), y, EYE_GLOW.alpha);
      }
    }
    front.box(6, 6, 6, 8, p.dark);
    front.row(10, 4, 8, p.mouth);
    front.px(3, 11, p.mouth);
    front.px(9, 11, p.mouth);
    front.px(3, 10, p.dark);
    front.px(9, 10, p.dark);
    front.row(12, 2, 10, p.dark);
    front.row(11, 4, 8, p.skin[2]);
    front.px(10, 8, p.deep); // an old scar
    front.px(11, 9, p.deep);
    front.px(11, 10, p.deep);
  }
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('head', side);
    s.fill(p.skin, 2);
    s.box(0, 0, 11, 2, p.hair[1]);
    // the ear, a little behind the middle
    const ex = side === 'right' ? 4 : 6;
    s.box(ex, 5, ex + 1, 8, p.skin[2]);
    s.px(side === 'right' ? ex : ex + 1, 6, p.dark);
    s.px(side === 'right' ? ex : ex + 1, 7, p.dark);
    s.row(12, 0, 11, p.dark);
  }
  const back = f('head', 'back');
  back.fill(p.skin, 2);
  back.box(0, 0, 12, 8, p.hair[1]);
  f('head', 'top').fill(p.hair);
  f('head', 'bottom').fill([p.dark, p.dark, p.deep]);
}

/** The hair layer: a head of hair with a ragged edge; the alpha's hangs long round its face. */
function paintHair(kind, f) {
  const p = PAL[kind];
  const top = f('hair', 'top');
  top.fill(p.hair);
  const front = f('hair', 'front');
  const back = f('hair', 'back');
  if (kind === 'walker') {
    // short, thinning, a lock fallen to one side
    front.mottle(0, 0, 12, 0, p.hair);
    for (const x of [0, 1, 2, 9, 10, 11, 12]) front.mottle(x, 1, x, 1, p.hair);
    for (const x of [0, 10, 11, 12]) front.mottle(x, 2, x, 2, p.hair);
    front.mottle(11, 3, 12, 3, p.hair);
    back.mottle(0, 0, 12, 7, p.hair);
    for (let x = 0; x <= 12; x++) if (hash(x, 8, 5) < 0.6) back.mottle(x, 8, x, 8, p.hair);
  } else if (kind === 'runner') {
    // wild: a ragged fringe, tufts every which way
    front.mottle(0, 0, 12, 0, p.hair);
    for (let x = 0; x <= 12; x++) {
      const drop = 1 + Math.floor(hash(x, 1, 9) * 3.2);
      if (x >= 3 && x <= 9 && drop > 2) continue;
      front.mottle(x, 1, x, Math.min(drop, x < 2 || x > 10 ? 4 : 2), p.hair);
    }
    back.mottle(0, 0, 12, 6, p.hair);
    for (let x = 0; x <= 12; x++) back.mottle(x, 7, x, 7 + Math.floor(hash(x, 7, 11) * 3), p.hair);
  } else {
    // long and black, hanging past the jaw on both sides of the face
    front.mottle(0, 0, 12, 0, p.hair);
    for (const x of [0, 1, 2, 3, 9, 10, 11, 12]) front.mottle(x, 1, x, 1, p.hair);
    front.mottle(0, 2, 0, 11, p.hair);
    front.mottle(12, 2, 12, 12, p.hair);
    back.mottle(0, 0, 12, 12, p.hair);
    for (const x of [2, 5, 9, 11]) back.box(x, 1, x, 12, p.hair[0]); // strands
  }
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('hair', side);
    // column i counts from the BACK of the head
    const col = (i) => (side === 'right' ? i : 11 - i);
    for (let i = 0; i < 12; i++) {
      const x = col(i);
      let depth;
      if (kind === 'alpha') depth = i < 9 ? 13 : 4;
      else if (kind === 'runner') depth = (i < 6 ? 7 : 4) + Math.floor(hash(i, 3, 17) * 3);
      else depth = i < 5 ? 8 : i < 9 ? 4 : 3;
      s.mottle(x, 0, x, depth - 1, p.hair);
    }
  }
}

/** The torso: a buttoned shirt with a collar, a pocket, a tear and stains, a tail hanging out over the belt. */
function paintTorso(kind, f) {
  const p = PAL[kind];
  const front = f('torso', 'front');
  front.cloth(p.shirt, 2);
  // the open collar and the neck in it
  front.row(0, 6, 9, p.skin[2]);
  front.row(1, 7, 8, p.skin[2]);
  front.px(7, 2, p.dark);
  front.row(0, 4, 5, p.shirtDark);
  front.row(0, 10, 11, p.shirtDark);
  front.px(5, 1, p.shirtDark);
  front.px(6, 1, p.shirtDark);
  front.px(9, 1, p.shirtDark);
  front.px(10, 1, p.shirtDark);
  front.px(6, 2, p.shirtDark);
  front.px(9, 2, p.shirtDark);
  // the buttons
  front.box(8, 3, 8, 16, p.shirt[2]);
  for (const y of [4, 8, 12, 15]) front.px(8, y, p.shirtDark);
  // a pocket, a tear with the dark behind it, old stains
  front.row(5, 2, 5, p.shirt[2]);
  front.box(2, 6, 2, 8, p.shirt[2]);
  front.box(5, 6, 5, 8, p.shirt[2]);
  front.row(9, 2, 5, p.shirt[2]);
  for (const [x, y] of [[11, 9], [12, 9], [11, 10], [12, 10], [13, 10], [12, 11], [13, 11], [12, 12]]) front.px(x, y, p.shirtDark);
  front.px(12, 10, p.dark);
  front.px(12, 11, p.dark);
  for (const [x, y] of [[3, 13], [4, 13], [3, 14], [4, 14], [5, 14], [13, 4], [14, 5], [13, 5]]) front.px(x, y, p.shirt[2]);
  // the belt and the top of the trousers; a shirt tail left hanging out
  front.row(17, 0, 15, p.belt);
  front.row(18, 0, 15, p.belt);
  front.box(7, 17, 8, 18, p.buckle);
  front.row(19, 0, 15, p.trousers[1]);
  front.mottle(2, 17, 5, 19, p.shirt);
  front.px(2, 19, p.trousers[1]);
  front.px(5, 19, p.shirt[2]);
  const back = f('torso', 'back');
  back.cloth(p.shirt, 2);
  back.row(0, 4, 11, p.shirtDark);
  back.box(7, 1, 8, 14, p.shirt[2]); // the fold down the spine
  for (const [x, y] of [[3, 6], [4, 6], [4, 7], [5, 7], [4, 8], [11, 12], [12, 12], [12, 13], [11, 3], [12, 4]]) back.px(x, y, p.shirtDark);
  back.row(17, 0, 15, p.belt);
  back.row(18, 0, 15, p.belt);
  back.row(19, 0, 15, p.trousers[1]);
  back.mottle(9, 17, 12, 18, p.shirt);
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('torso', side);
    s.cloth(p.shirt, 2);
    s.row(17, 0, 7, p.belt);
    s.row(18, 0, 7, p.belt);
    s.row(19, 0, 7, p.trousers[1]);
  }
  const top = f('torso', 'top');
  top.fill(p.shirt);
  top.box(5, 2, 10, 6, p.dark); // under the head
  f('torso', 'bottom').fill(p.trousers);
}

/** The arms: a sleeve torn off below the elbow, a thin bare forearm, a hand. */
function paintArms(kind, f) {
  const p = PAL[kind];
  for (const face of FACES) {
    const u = f('upperArm', face);
    u.cloth(p.shirt, 1);
    if (face === 'top' || face === 'bottom') continue;
    u.px(2, 8, p.shirtDark);
  }
  for (const face of FACES) {
    const a = f('foreArm', face);
    a.fill(p.skin, 2);
    if (face === 'top') {
      a.fill(p.shirt);
      continue;
    }
    if (face === 'bottom') {
      a.fill([p.dark, p.dark, p.deep]);
      continue;
    }
    // the ragged end of the sleeve
    for (let x = 0; x < 5; x++) {
      const drop = 1 + Math.floor(hash(x, FACES.indexOf(face), 23) * 2.6);
      a.mottle(x, 0, x, drop - 1, p.shirt);
      a.px(x, drop, p.shirtDark);
    }
    a.px(1, 5, p.dark); // a bruise
    a.px(2, 6, p.dark);
    // the hand: knuckles, and the gaps between the fingers
    a.row(9, 0, 4, p.skin[2]);
    a.box(0, 10, 4, 11, p.skin[1]);
    a.px(1, 11, p.dark);
    a.px(3, 11, p.dark);
    a.px(1, 10, p.skin[2]);
    a.px(3, 10, p.skin[2]);
  }
}

/** A leg: worn trousers frayed above the ankle, a bare ankle, an old shoe. */
function paintLeg(kind, f) {
  const p = PAL[kind];
  for (const face of FACES) {
    const l = f('leg', face);
    if (face === 'top') {
      l.fill(p.trousers);
      continue;
    }
    if (face === 'bottom') {
      l.fill([p.shoe[1], p.shoe[1], p.shoe[1]]);
      continue;
    }
    l.cloth(p.trousers, 0);
    // creases at the knee, a patch
    l.row(10, 1, 5, p.trousers[2]);
    l.px(1, 11, p.trousers[2]);
    l.px(5, 9, p.trousers[2]);
    if (face === 'front') l.box(2, 13, 4, 15, p.trousers[0]);
    // the frayed hem, the ankle, the shoe
    for (let x = 0; x < 7; x++) {
      const hem = 18 + Math.floor(hash(x, FACES.indexOf(face), 29) * 2.4);
      for (let y = hem + 1; y <= 20; y++) l.px(x, y, y === hem + 1 ? p.dark : p.skin[2]);
      l.px(x, hem, p.trousers[2]);
    }
    l.mottle(0, 21, 6, 22, [p.shoe[0], p.shoe[0], p.shoe[1]]);
    l.row(23, 0, 6, p.shoe[1]);
  }
}

/** The alpha's coat: a ragged dark hide over the shoulders and down the back, hanging open at the front. */
function paintCoat(f) {
  const p = PAL.alpha;
  const coat = /** @type {number[]} */ (p.coat);
  const front = f('coat', 'front');
  for (let x = 0; x < 16; x++) {
    if (x >= 6 && x <= 9) {
      if (x === 6 || x === 9) front.mottle(x, 0, x, 3, coat); // the collar turned up
      continue;
    }
    const hem = 14 + Math.floor(hash(x, 2, 31) * 5);
    front.mottle(x, 0, x, hem, coat, 0);
    front.px(x, hem, p.coatDark);
  }
  front.box(5, 2, 5, 12, p.coatDark);
  front.box(10, 2, 10, 12, p.coatDark);
  const back = f('coat', 'back');
  for (let x = 0; x < 16; x++) {
    const hem = 16 + Math.floor(hash(x, 4, 37) * 4);
    back.mottle(x, 0, x, hem, coat);
    back.px(x, hem, p.coatDark);
  }
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('coat', side);
    for (let x = 0; x < 8; x++) {
      const hem = 15 + Math.floor(hash(x, side === 'right' ? 6 : 8, 41) * 4);
      s.mottle(x, 0, x, hem, coat);
      s.px(x, hem, p.coatDark);
    }
  }
  f('coat', 'top').fill(coat);
}
