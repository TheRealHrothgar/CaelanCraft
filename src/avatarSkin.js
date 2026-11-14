// Caelancraft — avatar skins (PURE: no three, no DOM). See src/CONTRACTS.md §91.
//
// Pixel art for every avatar in avatars.js, painted into ONE RGBA sheet (SHEET_W wide, a PAGE_H page per avatar in
// AVATARS order, sRGB bytes, row 0 at the top). On its page each box of the avatar — head, hair layer, tufts, the long-hair
// panel, chest, waist, leg, upper arm, forearm, skirt — is unwrapped the usual way (faceRect, the zombies' convention): its
// top and bottom side by side over a strip of its right side, front, left side and back. Body parts are painted solid; the
// hair layer, the tufts and the long-hair panel are see-through (alpha 0) wherever there is no hair. The layout is packed
// from each avatar's own box sizes (layoutParts), so a new avatar needs no new code.
//
// The look is cheerful and simple: smooth skin with a little shading, friendly eyes (a white, an iris in the avatar's eye
// colour with a pupil and a highlight), brows in the hair colour, a small smile, rosy cheeks; hair with its own texture per
// style (poofy curls, silky strands with a sheen, long waves); clean clothes with soft folds.
import { AVATARS } from './avatars.js';

/** @typedef {import('./avatars.js').AvatarDef} AvatarDef */
/** @typedef {import('./avatars.js').BoxDims} BoxDims */
/** @typedef {BoxDims & { x: number, y: number }} PartRect  a box and the top-left corner of its unwrap on the page */
/** @typedef {'top'|'bottom'|'right'|'front'|'left'|'back'} FaceName */

/** The sheet's width and one avatar's page height (texels). */
export const SHEET_W = 128;
export const PAGE_H = 128;
export const FACES = Object.freeze(/** @type {FaceName[]} */ (['top', 'bottom', 'right', 'front', 'left', 'back']));
/** What the hair layer and the long-hair panel are made of: everything else is painted solid. */
export const HAIR_PARTS = Object.freeze(['hair', 'back']);

/**
 * Where a box's face sits on its page: top and bottom side by side (each w × d), then right, front, left and back in a
 * strip h tall. Seen from outside, x runs to the viewer's right and y down; the right side's last column and the left
 * side's first are the ones next to the front.
 * @param {PartRect} part
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

/**
 * An avatar's boxes by part name (texels): head, hair, chest, waist, leg, upperArm, foreArm, then tuft0… (poofy hair),
 * back (long hair) and skirt (a dress).
 * @param {AvatarDef} def
 * @returns {Record<string, BoxDims>}
 */
export function avatarParts(def) {
  const b = def.body;
  const dims = (o) => ({ w: o.w, h: o.h, d: o.d });
  /** @type {Record<string, BoxDims>} */
  const parts = {
    head: dims(b.head), hair: dims(def.hair.box), chest: dims(b.chest), waist: dims(b.waist), leg: dims(b.leg),
    upperArm: dims(b.upperArm), foreArm: dims(b.foreArm),
  };
  (def.hair.tufts ?? []).forEach((t, i) => { parts[`tuft${i}`] = dims(t); });
  if (def.hair.back) parts.back = dims(def.hair.back);
  if (def.outfit.skirt) parts.skirt = dims(def.outfit.skirt);
  return parts;
}

/**
 * Pack the unwraps on a page, tallest first, in rows left to right (a deterministic shelf packing).
 * @param {Record<string, BoxDims>} parts
 * @param {number} [width=SHEET_W]
 * @returns {Record<string, PartRect>}
 * @throws {RangeError} when they do not fit in width × PAGE_H
 */
export function layoutParts(parts, width = SHEET_W) {
  const names = Object.keys(parts);
  const size = (n) => ({ uw: 2 * (parts[n].w + parts[n].d), uh: parts[n].d + parts[n].h });
  const order = names.map((n, i) => ({ n, i, ...size(n) })).sort((a, b) => b.uh - a.uh || b.uw - a.uw || a.i - b.i);
  /** @type {Record<string, PartRect>} */
  const out = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { n, uw, uh } of order) {
    if (uw > width) throw new RangeError(`avatar part ${n} is wider than the sheet`);
    if (x + uw > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    out[n] = { ...parts[n], x, y };
    x += uw;
    rowH = Math.max(rowH, uh);
  }
  if (y + rowH > PAGE_H) throw new RangeError(`avatar parts need ${y + rowH} rows, a page has ${PAGE_H}`);
  return out;
}

/**
 * Where an avatar's boxes are, in texels, at rest (model space: origin at the feet, x to its right, y up, z toward its
 * back; the model faces −Z). The renderer builds its joints from these numbers.
 * @param {AvatarDef} def
 */
export function avatarRig(def) {
  const b = def.body;
  const hipY = b.leg.h;
  const torsoH = b.waist.h + b.chest.h;
  const skirt = def.outfit.skirt;
  const back = def.hair.back;
  return {
    /** the legs hang from (±legX, hipY) */
    legX: (b.leg.w + b.legGap) / 2,
    hipY,
    /** the torso stands on the hips: waist from 0 to waistH, chest above it, the head on top at neckY (all from the hips) */
    waistH: b.waist.h,
    chestH: b.chest.h,
    torsoH,
    neckY: torsoH,
    /** the arms swing from (±shoulderX, shoulderY) (from the hips): half an arm's width under the top of the chest */
    shoulderX: (b.chest.w + b.upperArm.w) / 2,
    shoulderY: torsoH - b.upperArm.w / 2,
    upperL: b.upperArm.h,
    foreL: b.foreArm.h,
    /** the hair layer's centre above the bottom of the head */
    hairY: def.hair.box.y + def.hair.box.h / 2,
    tufts: (def.hair.tufts ?? []).map((t) => ({ x: t.x, y: t.y, z: t.z, rx: t.rx ?? 0, rz: t.rz ?? 0 })),
    /** the long-hair panel's centre (from the hips), behind the chest */
    back: back ? { y: torsoH + back.top - back.h / 2, z: b.chest.d / 2 + back.d / 2 } : null,
    /** the skirt's centre (from the hips) */
    skirt: skirt ? { y: (def.outfit.skirtUp ?? 0) - skirt.h / 2 } : null,
  };
}

/**
 * Every box of an avatar at rest, as centres in model space (texels): what a front or side view of it shows.
 * @param {AvatarDef} def
 * @returns {{ part: string, x: number, y: number, z: number, rx: number, rz: number }[]}
 */
export function restBoxes(def) {
  const b = def.body;
  const g = avatarRig(def);
  const neck = g.hipY + g.neckY;
  const box = (part, x, y, z, rx = 0, rz = 0) => ({ part, x, y, z, rx, rz });
  const armTop = g.hipY + g.torsoH;
  const out = [
    box('leg', -g.legX, g.hipY - b.leg.h / 2, 0),
    box('leg', g.legX, g.hipY - b.leg.h / 2, 0),
    box('waist', 0, g.hipY + b.waist.h / 2, 0),
    box('chest', 0, g.hipY + b.waist.h + b.chest.h / 2, 0),
  ];
  for (const s of [-1, 1]) {
    out.push(box('upperArm', s * g.shoulderX, armTop - b.upperArm.h / 2, 0));
    out.push(box('foreArm', s * g.shoulderX, armTop - b.upperArm.h - b.foreArm.h / 2, 0));
  }
  out.push(box('head', 0, neck + b.head.h / 2, 0));
  out.push(box('hair', 0, neck + g.hairY, 0));
  g.tufts.forEach((t, i) => out.push(box(`tuft${i}`, t.x, neck + t.y, t.z, t.rx, t.rz)));
  if (g.back) out.push(box('back', 0, g.hipY + g.back.y, g.back.z));
  if (g.skirt) out.push(box('skirt', 0, g.hipY + g.skirt.y, 0));
  return out;
}

/** A small integer hash of two coordinates and a salt, 0..1. */
function hash(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Mix two 0xRRGGBB colours, `t` of the way from a to b. */
export function mixRgb(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * The columns of a run `k` texels long centred on a face `w` wide (k with the parity of w centres it exactly).
 * @param {number} w @param {number} k
 * @returns {[number, number]} its first and last column
 */
function centred(w, k) {
  const a = Math.floor((w - k) / 2);
  return [a, a + k - 1];
}

/** A painter for one face: local texel coordinates, clipped to the face. */
class Face {
  /**
   * @param {Uint8Array} data  @param {number} pageY  the page's first row
   * @param {{ x: number, y: number, w: number, h: number }} rect  @param {number} salt
   */
  constructor(data, pageY, rect, salt) {
    this.data = data;
    this.ox = rect.x;
    this.oy = rect.y + pageY;
    this.w = rect.w;
    this.h = rect.h;
    this.salt = salt;
  }

  /** One texel (rgb as 0xRRGGBB). */
  px(x, y, rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = ((this.oy + y) * SHEET_W + this.ox + x) * 4;
    this.data[i] = (rgb >> 16) & 255;
    this.data[i + 1] = (rgb >> 8) & 255;
    this.data[i + 2] = rgb & 255;
    this.data[i + 3] = 255;
  }

  /** Make a texel see-through (the hair). */
  clear(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[((this.oy + y) * SHEET_W + this.ox + x) * 4 + 3] = 0;
  }

  /** @returns {boolean} the texel is painted */
  opaque(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.data[((this.oy + y) * SHEET_W + this.ox + x) * 4 + 3] > 0;
  }

  /** A filled box x0..x1, y0..y1 (inclusive). */
  box(x0, y0, x1, y1, rgb) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, rgb);
  }

  row(y, x0, x1, rgb) {
    this.box(x0, y, x1, y, rgb);
  }

  /** A deterministic 0..1 per texel. */
  n(x, y, k = 0) {
    return hash(x + this.ox, y + this.oy, this.salt + k);
  }

  /** Smooth skin from [light, mid, dark]: mid with a few faint light flecks, the bottom `lower` rows shaded. */
  skin(ramp, lower = 0) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let c = this.n(x, y) < 0.04 ? mixRgb(ramp[1], ramp[0], 0.45) : ramp[1];
        if (y >= this.h - lower) c = mixRgb(c, ramp[2], 0.55);
        this.px(x, y, c);
      }
    }
  }

  /** Clean cloth from [light, mid, dark]: flat mid, a few soft folds (a dark line with a light one beside it). */
  cloth(ramp, lower = 0) {
    this.box(0, 0, this.w - 1, this.h - 1, ramp[1]);
    for (let x = 1; x < this.w - 1; x++) {
      const v = this.n(x, 0, 7);
      if (v > 0.16) continue;
      const y0 = Math.floor(this.n(x, 1, 3) * this.h * 0.5);
      const len = 2 + Math.floor(this.n(x, 2, 5) * this.h * 0.4);
      for (let y = y0; y < Math.min(this.h, y0 + len); y++) {
        this.px(x, y, mixRgb(ramp[1], ramp[2], 0.6));
        if (v < 0.08) this.px(x + 1, y, mixRgb(ramp[1], ramp[0], 0.6));
      }
    }
    for (let y = Math.max(0, this.h - lower); y < this.h; y++) for (let x = 0; x < this.w; x++) this.px(x, y, mixRgb(ramp[1], ramp[2], 0.5));
  }
}

/**
 * The texture of a hair style at texel (x, y) of a face: its colour from the hair ramp [highlight, light, mid, dark].
 * @param {'poofy'|'silky'|'longWavy'} style
 * @param {number[]} ramp
 * @param {Face} f
 * @param {number} x
 * @param {number} y
 */
function hairTexel(style, ramp, f, x, y) {
  const v = f.n(x, y, 11);
  if (style === 'poofy') {
    // curls: soft two-texel blobs in light and mid, a highlight on top of some, dark between a few
    const blob = ((x >> 1) + (y >> 1) + ((y >> 1) & 1)) % 2;
    if (v < 0.1) return ramp[3];
    if (blob === 0) return v > 0.8 ? ramp[0] : ramp[1];
    return v > 0.85 ? ramp[1] : ramp[2];
  }
  if (style === 'silky') {
    // smooth and straight: long light runs, a strand line every fourth column, a sheen across the top
    if (x % 4 === 2) return y === 1 || y === 2 ? ramp[1] : ramp[2];
    if (y === 1 || y === 2) return ramp[0];
    return v < 0.08 ? ramp[2] : ramp[1];
  }
  // long and wavy: strands running down that sway from side to side
  const s = x + Math.round(1.3 * Math.sin(y * 0.6));
  const band = ((s % 4) + 4) % 4;
  if (band === 0) return v < 0.5 ? ramp[0] : ramp[1];
  if (band === 3) return ramp[2];
  return ramp[1];
}

/**
 * Paint the whole sheet: one page per avatar (AVATARS order); the same bytes every call.
 * @param {ReadonlyArray<AvatarDef>} [avatars=AVATARS]
 * @returns {{ width: number, height: number, data: Uint8Array, pages: Record<string, { page: number, layout: Record<string, PartRect> }> }}
 */
export function paintAvatarSheet(avatars = AVATARS) {
  const width = SHEET_W;
  const height = PAGE_H * avatars.length;
  const data = new Uint8Array(width * height * 4);
  /** @type {Record<string, { page: number, layout: Record<string, PartRect> }>} */
  const pages = {};
  avatars.forEach((def, page) => {
    const layout = layoutParts(avatarParts(def));
    pages[def.id] = { page, layout };
    const names = Object.keys(layout);
    /** @param {string} part @param {FaceName} face */
    const f = (part, face) => new Face(data, page * PAGE_H, faceRect(layout[part], face), page * 97 + FACES.indexOf(face) * 13 + names.indexOf(part) * 31);
    paintHead(def, f);
    paintHair(def, f);
    paintTorso(def, f);
    paintArms(def, f);
    paintLegs(def, f);
    if (def.outfit.skirt) paintSkirt(def, f);
  });
  return { width, height, data, pages };
}

/**
 * The face's features on the head's front (columns from the viewer's left, rows from the top): where the eyes are.
 * @param {BoxDims} head
 */
export function faceLayout(head) {
  const eyeRow = Math.round(head.h / 2);
  const leftEnd = Math.floor(head.w / 2 - 2); // the left iris is the two columns before this one
  return {
    eyeRow,
    /** each eye: its white column and its two iris columns (outer to inner) */
    left: { white: leftEnd - 3, iris: [leftEnd - 2, leftEnd - 1] },
    right: { white: head.w - leftEnd + 2, iris: [head.w - leftEnd + 1, head.w - leftEnd] },
    browRow: eyeRow - 2,
    noseRow: eyeRow + 2,
    mouthRow: eyeRow + 4,
  };
}

/** WHITE of the eyes and the sparkle in them. */
export const EYE_WHITE = 0xfbfbf6;

/** The head: a friendly face, ears, hair on the top and back (under the hair layer). */
function paintHead(def, f) {
  const p = def.palette;
  const { w, h } = def.body.head;
  const skin = p.skin;
  const hairMid = p.hair[2];
  const front = f('head', 'front');
  front.skin(skin, 1);
  front.row(0, 0, w - 1, hairMid);
  const L = faceLayout(def.body.head);
  // eyes: the white outside, the iris in the avatar's colour with a sparkle at the top outside and the pupil low inside
  const [iris, deep] = p.eyes;
  for (const e of [L.left, L.right]) {
    const outer = e.iris[0];
    const inner = e.iris[1];
    front.box(e.white, L.eyeRow, e.white, L.eyeRow + 1, EYE_WHITE);
    front.px(outer, L.eyeRow, mixRgb(iris, EYE_WHITE, 0.75));
    front.px(inner, L.eyeRow, iris);
    front.px(outer, L.eyeRow + 1, iris);
    front.px(inner, L.eyeRow + 1, deep);
    // brows in the hair colour over the eye
    front.row(L.browRow, Math.min(e.white, inner), Math.max(e.white, inner), p.brows);
    if (p.lashes) front.px(e.white, L.eyeRow - 1, mixRgb(p.brows, 0x2a1d14, 0.6));
    // rosy cheeks under the eye
    front.px(e.white, L.noseRow, mixRgb(skin[1], p.blush, 0.7));
    front.px(e.iris[0], L.noseRow, mixRgb(skin[1], p.blush, 0.35));
  }
  // the nose: a soft shadow; a small smile (its corners a little softer)
  const c = w / 2;
  const mouthEdge = mixRgb(p.mouth, skin[2], 0.35);
  if (w % 2 === 0) {
    front.px(c - 1, L.noseRow, skin[2]);
    front.px(c, L.noseRow, mixRgb(skin[1], skin[2], 0.5));
    front.px(c - 2, L.mouthRow - 1, mouthEdge);
    front.row(L.mouthRow, c - 1, c, p.mouth);
    front.px(c + 1, L.mouthRow - 1, mouthEdge);
  } else {
    const m = Math.floor(c);
    front.px(m, L.noseRow, skin[2]);
    front.px(m - 2, L.mouthRow - 1, mouthEdge);
    front.row(L.mouthRow, m - 1, m + 1, p.mouth);
    front.px(m + 2, L.mouthRow - 1, mouthEdge);
  }
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('head', side);
    s.skin(skin, 1);
    s.box(0, 0, s.w - 1, 2, hairMid);
    // the ear, a little behind the middle (column 0 is the back on the right side, the front on the left)
    const mid = Math.floor(s.w / 2);
    const ex = side === 'right' ? mid - 1 : s.w - mid - 1;
    s.box(ex, L.eyeRow, ex + 1, L.eyeRow + 2, skin[2]);
    s.px(side === 'right' ? ex + 1 : ex, L.eyeRow + 1, skin[3]);
  }
  const back = f('head', 'back');
  back.skin(skin, 0);
  for (let y = 0; y < h - 3; y++) for (let x = 0; x < w; x++) back.px(x, y, hairTexel(def.hair.style, p.hair, back, x, y));
  const top = f('head', 'top');
  for (let y = 0; y < top.h; y++) for (let x = 0; x < top.w; x++) top.px(x, y, hairTexel(def.hair.style, p.hair, top, x, y));
  f('head', 'bottom').skin([skin[2], skin[2], skin[3]]);
}

/**
 * The hair layer (and the tufts and the long-hair panel). The layer stands off the head: its front shows the face
 * through the gap under the fringe, its sides end above the ears (or not, for long hair), its back covers the head.
 */
function paintHair(def, f) {
  const p = def.palette;
  const style = def.hair.style;
  const box = def.hair.box;
  const head = def.body.head;
  const ramp = p.hair;
  const L = faceLayout(head);
  /** rows of the layer above the head's top; the layer's column of the head's first column */
  const above = box.y + box.h - head.h;
  const inset = (box.w - head.w) / 2;
  /** @param {Face} face @param {number} x @param {number} y0 @param {number} y1 */
  const strand = (face, x, y0, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(face.h - 1, y1); y++) face.px(x, y, hairTexel(style, ramp, face, x, y));
  };
  const front = f('hair', 'front');
  for (let x = 0; x < box.w; x++) {
    const hc = x - inset; // the head's column under it (outside the head: < 0 or ≥ head.w)
    const outside = hc < 0 || hc >= head.w;
    let bottom; // the last row of hair in this column
    if (style === 'poofy') {
      bottom = outside ? above + L.eyeRow - 1 : above + 1 + (hash(x, 1, 5) < 0.45 ? 1 : 0) + (hash(x, 2, 5) < 0.15 ? 1 : 0);
    } else if (style === 'silky') {
      // a fringe swept to one side: long on the viewer's left, short on the right
      bottom = outside ? above + L.eyeRow - 1 : above + Math.round(L.browRow - 1 - (hc * (L.browRow - 2)) / (head.w - 1));
    } else {
      // long waves: parted in the middle, framing the face down past the jaw
      const edge = hc <= 0 || hc >= head.w - 1;
      bottom = outside || edge ? box.h - 1 : above + (hc === 1 || hc === head.w - 2 ? 2 : 1);
    }
    strand(front, x, 0, bottom);
  }
  if (style === 'longWavy') {
    const c = box.w / 2;
    front.px(Math.floor(c) - (box.w % 2 === 0 ? 1 : 0), 0, ramp[3]); // the parting
    front.px(Math.floor(c), 0, ramp[3]);
  }
  for (const side of /** @type {const} */ (['right', 'left'])) {
    const s = f('hair', side);
    const col = (i) => (side === 'right' ? i : box.d - 1 - i); // i counts from the back
    for (let i = 0; i < box.d; i++) {
      const toFront = i / (box.d - 1);
      let bottom;
      if (style === 'longWavy') bottom = box.h - 1;
      else if (style === 'poofy') bottom = toFront < 0.45 ? box.h - 1 : above + L.eyeRow - 2 + (hash(i, 3, 9) < 0.5 ? 1 : 0);
      else bottom = toFront < 0.4 ? box.h - 1 : above + L.eyeRow - 1;
      strand(s, col(i), 0, bottom);
    }
  }
  const back = f('hair', 'back');
  for (let x = 0; x < box.w; x++) strand(back, x, 0, box.h - 1 - (style === 'poofy' && hash(x, 4, 7) < 0.3 ? 1 : 0));
  const top = f('hair', 'top');
  for (let x = 0; x < top.w; x++) strand(top, x, 0, top.h - 1);
  // (the layer's bottom stays clear: it is inside the head, or a ledge seen from under the chin)

  (def.hair.tufts ?? []).forEach((_, i) => {
    for (const face of FACES) {
      const t = f(`tuft${i}`, face);
      for (let x = 0; x < t.w; x++) strand(t, x, 0, t.h - 1);
      if (face === 'bottom') t.box(0, 0, t.w - 1, t.h - 1, ramp[3]);
    }
  });

  if (def.hair.back) {
    const panel = def.hair.back;
    // its lower edge wavy: each column ends 0..2 rows short
    const end = (x) => panel.h - 1 - Math.round(1 + Math.sin(x * 1.3));
    for (const face of /** @type {const} */ (['front', 'back'])) {
      const s = f('back', face);
      for (let x = 0; x < panel.w; x++) strand(s, x, 0, end(x));
    }
    for (const face of /** @type {const} */ (['right', 'left'])) {
      const s = f('back', face);
      for (let x = 0; x < panel.d; x++) strand(s, x, 0, end(face === 'right' ? 0 : panel.w - 1));
    }
    const t = f('back', 'top');
    for (let x = 0; x < t.w; x++) strand(t, x, 0, t.h - 1);
  }
}

/** The torso: a tee over the top of the trousers, or a dress with a collar and a sash. */
function paintTorso(def, f) {
  const o = def.outfit;
  const p = def.palette;
  const chest = def.body.chest;
  const waist = def.body.waist;
  const top = o.top;
  for (const face of /** @type {const} */ (['front', 'back', 'right', 'left'])) {
    const ch = f('chest', face);
    ch.cloth(top, 0);
    if (o.detail === 'stripe') {
      ch.row(3, 0, ch.w - 1, o.trim);
      ch.row(4, 0, ch.w - 1, o.trim);
    }
  }
  const front = f('chest', 'front');
  const odd = chest.w % 2;
  if (o.kind === 'tee') {
    // a round neck with a ribbed collar
    const [n0, n1] = centred(chest.w, 4 - odd);
    front.row(0, n0, n1, p.skin[1]);
    front.px(n0 - 1, 0, o.trim);
    front.px(n1 + 1, 0, o.trim);
    front.row(1, n0, n1, o.trim);
    f('chest', 'back').row(0, n0 - 1, n1 + 1, o.trim);
    if (o.detail === 'pocket') {
      // on the wearer's left (the viewer's right)
      const x0 = chest.w - 6;
      front.box(x0, 3, x0 + 3, 6, top[0]);
      front.row(3, x0, x0 + 3, o.trim);
      front.box(x0, 7, x0 + 3, 7, top[2]);
      front.box(x0 - 1, 3, x0 - 1, 7, top[2]);
      front.box(x0 + 4, 3, x0 + 4, 7, top[2]);
    }
  } else {
    // a dress: a round white collar each side of the neck, a little flower
    const [n0, n1] = centred(chest.w, 2 - odd);
    front.row(0, n0, n1, p.skin[1]);
    front.row(0, n0 - 4, n0 - 1, o.trim);
    front.row(0, n1 + 1, n1 + 4, o.trim);
    front.row(1, n0 - 3, n0 - 1, o.trim);
    front.row(1, n1 + 1, n1 + 3, o.trim);
    front.px(n0 - 2, 2, o.trim);
    front.px(n1 + 2, 2, o.trim);
    const fx = chest.w - 5;
    front.px(fx, 4, o.trim);
    front.px(fx - 1, 5, o.trim);
    front.px(fx + 1, 5, o.trim);
    front.px(fx, 6, o.trim);
    front.px(fx, 5, 0xf6c945);
    const [b0, b1] = centred(chest.w, 8 - odd);
    f('chest', 'back').row(0, b0, b1, o.trim);
  }
  const shoulders = f('chest', 'top');
  shoulders.cloth(top, 0);
  f('chest', 'bottom').box(0, 0, chest.w - 1, chest.d - 1, top[2]);

  for (const face of /** @type {const} */ (['front', 'back', 'right', 'left'])) {
    const wa = f('waist', face);
    if (o.kind === 'tee') {
      const hem = waist.h - 3;
      wa.cloth(top, 0);
      wa.row(hem, 0, wa.w - 1, top[2]);
      const b = /** @type {number[]} */ (o.bottom);
      wa.box(0, hem + 1, wa.w - 1, waist.h - 1, b[1]);
      wa.row(hem + 1, 0, wa.w - 1, b[2]);
      if (face === 'front') wa.px(Math.floor(waist.w / 2), hem + 2, b[2]); // the fly's seam
    } else {
      wa.cloth(top, 0);
      const sash = waist.h - 5;
      wa.row(sash, 0, wa.w - 1, /** @type {number} */ (o.sash));
      wa.row(sash + 1, 0, wa.w - 1, /** @type {number} */ (o.sash));
      if (face === 'back') {
        // a bow tied at the back
        const m = Math.floor(waist.w / 2);
        for (const [x, y] of [[-3, -1], [-2, -1], [-3, 0], [-2, 0], [-3, 1], [-2, 1], [1, -1], [2, -1], [1, 0], [2, 0], [1, 1], [2, 1], [-1, 0], [0, 0], [-1, 2], [0, 3]]) {
          wa.px(m + x, sash + y, /** @type {number} */ (o.sash));
        }
        wa.px(m - 1, sash, mixRgb(/** @type {number} */ (o.sash), top[2], 0.35));
        wa.px(m, sash, mixRgb(/** @type {number} */ (o.sash), top[2], 0.35));
      }
    }
  }
  f('waist', 'top').box(0, 0, waist.w - 1, waist.d - 1, top[1]);
  f('waist', 'bottom').box(0, 0, waist.w - 1, waist.d - 1, o.kind === 'tee' ? /** @type {number[]} */ (o.bottom)[2] : top[2]);
}

/** The arms: a sleeve with its hem, then skin; the hand at the end of the forearm. */
function paintArms(def, f) {
  const o = def.outfit;
  const p = def.palette;
  const fore = def.body.foreArm;
  const hem = o.detail === 'pocket' ? o.top[2] : o.trim;
  for (const face of FACES) {
    const u = f('upperArm', face);
    if (face === 'top') {
      u.cloth(o.top, 0);
      continue;
    }
    if (face === 'bottom') {
      u.skin(p.skin);
      continue;
    }
    u.skin(p.skin);
    u.box(0, 0, u.w - 1, o.sleeve - 2, o.top[1]);
    u.px(u.w - 1, 0, o.top[0]);
    u.row(o.sleeve - 1, 0, u.w - 1, hem);
    if (o.detail === 'stripe') u.row(1, 0, u.w - 1, o.trim);
    u.row(o.sleeve, 0, u.w - 1, mixRgb(p.skin[1], p.skin[2], 0.6)); // the sleeve's shadow
  }
  for (const face of FACES) {
    const a = f('foreArm', face);
    if (face === 'top') {
      a.skin(p.skin);
      continue;
    }
    if (face === 'bottom') {
      a.skin([p.skin[1], p.skin[2], p.skin[2]]);
      continue;
    }
    a.skin(p.skin);
    // the hand: the wrist a touch darker, then the fingers with the gaps between them
    const h0 = fore.h - def.body.hand;
    a.row(h0, 0, a.w - 1, mixRgb(p.skin[1], p.skin[2], 0.5));
    for (let x = 1; x < a.w; x += 2) a.px(x, fore.h - 1, p.skin[2]);
    a.box(0, h0 + 1, a.w - 1, fore.h - 2, mixRgb(p.skin[0], p.skin[1], 0.5));
  }
}

/** A leg: trousers and sneakers or shoes; or (a dress) bare legs, white socks and shoes with a strap. */
function paintLegs(def, f) {
  const o = def.outfit;
  const p = def.palette;
  const leg = def.body.leg;
  const [upper, sole, accent] = o.shoes;
  for (const face of FACES) {
    const l = f('leg', face);
    if (face === 'bottom') {
      l.box(0, 0, l.w - 1, l.h - 1, sole);
      continue;
    }
    if (o.kind === 'tee') {
      const b = /** @type {number[]} */ (o.bottom);
      if (face === 'top') {
        l.box(0, 0, l.w - 1, l.h - 1, b[1]);
        continue;
      }
      l.cloth(b, 0);
      if (face === 'right' || face === 'left') l.box(Math.floor(l.w / 2), 0, Math.floor(l.w / 2), leg.h - 4, b[0]); // the seam
      l.row(leg.h - 4, 0, l.w - 1, b[2]); // the hem
      l.box(0, leg.h - 3, l.w - 1, leg.h - 2, upper);
      l.row(leg.h - 1, 0, l.w - 1, sole);
      if (accent !== undefined && (face === 'right' || face === 'left')) l.row(leg.h - 2, 1, l.w - 2, accent);
      if (accent !== undefined && face === 'front') l.row(leg.h - 3, 1, l.w - 2, mixRgb(upper, sole, 0.35)); // the toe cap
    } else {
      if (face === 'top') {
        l.skin(p.skin);
        continue;
      }
      l.skin(p.skin);
      const sock = /** @type {number} */ (o.socks);
      l.box(0, leg.h - 6, l.w - 1, leg.h - 3, sock);
      for (let x = 0; x < l.w; x += 2) l.px(x, leg.h - 6, mixRgb(sock, o.top[0], 0.35)); // a frill
      l.row(leg.h - 2, 0, l.w - 1, upper);
      l.row(leg.h - 1, 0, l.w - 1, sole);
      if (face === 'front') l.row(leg.h - 3, 1, l.w - 2, upper); // the strap over the instep
    }
  }
}

/** The skirt: the dress's cloth in soft pleats, a white hem. */
function paintSkirt(def, f) {
  const o = def.outfit;
  const s = /** @type {BoxDims} */ (o.skirt);
  for (const face of /** @type {const} */ (['front', 'back', 'right', 'left'])) {
    const k = f('skirt', face);
    k.cloth(o.top, 0);
    for (let x = 1; x < k.w; x += 3) k.box(x, 2, x, s.h - 2, mixRgb(o.top[1], o.top[2], 0.7));
    for (let x = 2; x < k.w; x += 3) k.box(x, 3, x, s.h - 3, mixRgb(o.top[1], o.top[0], 0.5));
    k.row(s.h - 1, 0, k.w - 1, o.trim);
    k.row(0, 0, k.w - 1, mixRgb(o.top[1], o.top[2], 0.4));
  }
  f('skirt', 'top').box(0, 0, s.w - 1, s.d - 1, o.top[1]);
  f('skirt', 'bottom').box(0, 0, s.w - 1, s.d - 1, o.top[2]);
}

/**
 * The avatar seen from straight in front at rest, every box's front face drawn back to front (tufts unturned): an RGBA
 * picture one texel a pixel, cropped to the box `crop` (texels from the feet; default the whole figure).
 * @param {AvatarDef} def
 * @param {ReturnType<typeof paintAvatarSheet>} sheet
 * @param {{ y0?: number, y1?: number }} [crop]  heights (texels) of the picture's bottom and top
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function frontPicture(def, sheet, crop = {}) {
  const pg = sheet.pages[def.id];
  const boxes = restBoxes(def).map((b) => ({ ...b, dims: pg.layout[b.part] }));
  let x0 = Infinity;
  let x1 = -Infinity;
  let top = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x - b.dims.w / 2);
    x1 = Math.max(x1, b.x + b.dims.w / 2);
    top = Math.max(top, b.y + b.dims.h / 2);
  }
  const yTop = Math.ceil(crop.y1 ?? top);
  const yBottom = Math.floor(crop.y0 ?? 0);
  const width = Math.ceil(x1 - x0);
  const height = yTop - yBottom;
  const data = new Uint8ClampedArray(width * height * 4);
  // farther fronts first (a larger front z is farther from a viewer at −Z)
  boxes.sort((a, b) => (b.z - b.dims.d / 2) - (a.z - a.dims.d / 2));
  for (const b of boxes) {
    const r = faceRect(b.dims, 'front');
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        const si = ((pg.page * PAGE_H + r.y + j) * SHEET_W + r.x + i) * 4;
        if (sheet.data[si + 3] === 0) continue;
        // seen from the front, the viewer's left is the model's right (+x)
        const sx = Math.floor(x1 - (b.x + b.dims.w / 2) + i);
        const sy = Math.floor(yTop - (b.y + b.dims.h / 2) + j);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const di = (sy * width + sx) * 4;
        data[di] = sheet.data[si];
        data[di + 1] = sheet.data[si + 1];
        data[di + 2] = sheet.data[si + 2];
        data[di + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

/**
 * The chooser's portrait: head and shoulders from the front (frontPicture cropped from the middle of the chest up),
 * centred on a square.
 * @param {AvatarDef} def
 * @param {ReturnType<typeof paintAvatarSheet>} sheet
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function portrait(def, sheet) {
  const g = avatarRig(def);
  const pic = frontPicture(def, sheet, { y0: g.hipY + g.waistH + Math.floor(g.chestH / 2) });
  const size = Math.max(pic.width, pic.height) + 2;
  const data = new Uint8ClampedArray(size * size * 4);
  const ox = Math.floor((size - pic.width) / 2);
  const oy = size - pic.height; // standing on the bottom edge
  for (let y = 0; y < pic.height; y++) {
    for (let x = 0; x < pic.width; x++) {
      const si = (y * pic.width + x) * 4;
      const di = ((y + oy) * size + x + ox) * 4;
      for (let k = 0; k < 4; k++) data[di + k] = pic.data[si + k];
    }
  }
  return { width: size, height: size, data };
}
