// Caelancraft — the art-direction pilot's models (PURE: typed arrays, no three, no DOM). Shown by gallery.html next
// to today's models; nothing in the game uses them yet.
//
// One painted atlas per model (paintKit.js) and two GEOMETRIES over it (modelKit.js), so a comparison of the two
// styles is a comparison of shape alone:
//   hex  — "A: Hex-faceted": limbs, torsos and bodies are tapered HEXAGONAL prisms with flat-shaded facets (the
//          honeycomb's own cross-section), heads and hands chamfered boxes with small bevels, features wedges and
//          six-sided pyramids;
//   soft — "B: Soft-chamfer": the same skeleton in OCTAGONAL prisms with smoothed normals and chamfered boxes with
//          wide bevels whose normals blend into the faces they join — a rounder toy, still plainly built of facets.
// A model is { geo, image, tris, texels, atlas: [w, h] }: one merged geometry in its own frame (metres; a figure
// stands on its feet at the origin and faces −Z; the first-person hand is in CAMERA space), one RGBA atlas (sRGB
// bytes, row 0 at the top, a DataTexture with flipY off) and its budgets. Static poses only: the pilot is about the
// look; a migration would keep today's joints and hang these parts from them.
import { loft, pyramid, chamferBox, wedge, transform, merge, atlasUV, compose, alongSegment, mul, translation, rotation, scaling, identity, triangleCount } from './modelKit.js';
import { Atlas, Painter, paintFace, mix, shade, fbm, hash2, makeRng } from './paintKit.js';
import { avatarById } from './avatars.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./paintKit.js').Rect} Rect */
/** @typedef {{ geo: Geo, image: import('./paintKit.js').Img, tris: number, texels: number, atlas: [number, number], tool?: Float64Array }} PilotModel */

/**
 * @typedef {Object} Style  a shape language
 * @property {'hex'|'soft'} id
 * @property {string} label
 * @property {number} sides     the n-gon of limbs, torsos, bodies, puffs
 * @property {boolean} smooth   their side normals blended round the column
 * @property {number} bevel     a chamfered box's chamfer, a share of its smallest side
 * @property {number} head      the head's own chamfer
 * @property {boolean} boxSmooth  a chamfered box's bevels blended into its faces
 */

/** The two styles' rules. @type {Readonly<Record<'hex'|'soft', Readonly<Style>>>} */
export const STYLES = Object.freeze({
  hex: Object.freeze({ id: 'hex', label: 'A: Hex-faceted', sides: 6, smooth: false, bevel: 0.16, head: 0.19, boxSmooth: false }),
  soft: Object.freeze({ id: 'soft', label: 'B: Soft-chamfer', sides: 8, smooth: true, bevel: 0.34, head: 0.27, boxSmooth: true }),
});

/** Texels per metre: bodies, heads (the face is what is read first), animals, plants. Today's avatars are 32. */
export const DENSITY = Object.freeze({ body: 96, head: 160, animal: 80, plant: 128 });

/** Ramanujan's perimeter of an ellipse. */
const perimeter = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

// ---------------------------------------------------------------------------------------------------
// Skins: the rectangles of one model's atlas, each painted once, and the parts mapped onto them
// ---------------------------------------------------------------------------------------------------

class Skin {
  /** @param {number} w @param {number} h @param {number} seed */
  constructor(w, h, seed) {
    this.atlas = new Atlas(w, h, 2);
    /** @type {Map<string, { kind: 'wrap'|'box'|'plain', jobs: Job[] }>} */
    this.entries = new Map();
    /** @type {Job[]} every rectangle asked for, painted in this order once they are packed */
    this.jobs = [];
    this.seed = seed;
    this.salt = 1;
    this.packed = false;
  }

  /** @param {number} w @param {number} h @param {((p: Painter) => void)|undefined} paint @returns {Job} */
  job(w, h, paint) {
    const j = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), paint, rect: /** @type {Rect|null} */ (null) };
    this.jobs.push(j);
    return j;
  }

  /** @param {Job} j */
  painter(j) {
    return new Painter(this.atlas.img, /** @type {Rect} */ (j.rect), this.seed * 977 + this.salt++ * 131);
  }

  /**
   * A strip round a solid (u round from the back through +x to the front at the middle, rows from its far end down to
   * its near end) and its two caps.
   * @param {string} key
   * @param {number} w @param {number} h  the strip, pixels
   * @param {(p: Painter) => void} side
   * @param {{ cap?: number[], top?: (p: Painter) => void, bottom?: (p: Painter) => void }} [o]
   */
  wrap(key, w, h, side, { cap = [12, 12], top, bottom } = {}) {
    const S = this.job(w, h, side);
    const mid = () => this.painter(S).get(Math.floor(S.w / 2), Math.floor(S.h / 2));
    const T = this.job(cap[0], cap[1], top ?? ((p) => p.fill(mid()).mottle(0.05, 3)));
    const B = this.job(cap[0], cap[1], bottom ?? ((p) => p.fill(shade(mid(), 0.8))));
    this.entries.set(key, { kind: 'wrap', jobs: [S, T, B] });
  }

  /**
   * A box's six faces (BOX_FACES order), w × h × d pixels.
   * @param {string} key
   * @param {number} w @param {number} h @param {number} d
   * @param {Partial<Record<'front'|'back'|'left'|'right'|'top'|'bottom'|'all', (p: Painter) => void>>} paint
   */
  box(key, w, h, d, paint) {
    const dims = { right: [d, h], left: [d, h], top: [w, d], bottom: [w, d], back: [w, h], front: [w, h] };
    const jobs = [];
    for (const f of /** @type {const} */ (['right', 'left', 'top', 'bottom', 'back', 'front'])) {
      jobs.push(this.job(dims[f][0], dims[f][1], paint[f] ?? paint.all));
    }
    this.entries.set(key, { kind: 'box', jobs });
  }

  /** One rectangle that every face of a part maps onto (a homogeneous material: hair, plain skin, wool). */
  plain(key, w, h, paint) {
    this.entries.set(key, { kind: 'plain', jobs: [this.job(w, h, paint)] });
  }

  /** Pack every rectangle (tallest first), then paint them in the order they were asked for. */
  pack() {
    if (this.packed) return this;
    this.packed = true;
    const order = [...this.jobs].sort((a, b) => b.h - a.h || b.w - a.w);
    for (const j of order) j.rect = this.atlas.alloc(j.w, j.h);
    for (const j of this.jobs) if (j.paint) j.paint(this.painter(j));
    this.atlas.bleedAll();
    return this;
  }

  /**
   * A part's geometry with its uvs on its rectangles, placed by M.
   * @param {Geo} geo @param {string} key @param {import('./modelKit.js').Mat4} [M]
   */
  place(geo, key, M) {
    this.pack();
    const e = this.entries.get(key);
    if (!e) throw new Error(`no skin ${key}`);
    if (e.kind !== 'plain' && e.kind !== geo.kind) throw new Error(`skin ${key} is a ${e.kind} skin, the part a ${geo.kind}`);
    const rect = (k) => /** @type {Rect} */ (e.jobs[e.kind === 'plain' ? 0 : k].rect);
    const g = atlasUV(geo, rect, this.atlas.img.width, this.atlas.img.height);
    return M ? transform(g, M) : g;
  }

  /** @returns {PilotModel} */
  model(parts, extra = {}) {
    this.pack();
    const geo = merge(parts);
    return {
      geo, image: this.atlas.img, tris: triangleCount(geo), texels: this.atlas.used(),
      atlas: [this.atlas.img.width, this.atlas.img.height], ...extra,
    };
  }
}

/** @typedef {{ w: number, h: number, paint: ((p: Painter) => void)|undefined, rect: Rect|null }} Job */

/** The style's shape language. @param {Style} st */
function shapes(st) {
  const soft = st.id === 'soft';
  return {
    /** a column of the style's n-gon through rings (limbs, torsos, bodies) */
    col: (rx, rz, rings, o = {}) => loft({ sides: o.sides ?? st.sides, rx, rz, rings, smooth: st.smooth, caps: o.caps ?? true, phase: o.phase }),
    /** a chamfered box, centred */
    block: (w, h, d, o = {}) => chamferBox({
      w, h, d, c: (o.bevel ?? st.bevel) * Math.min(w, h, d), cb: (o.bevelBottom ?? o.bevel ?? st.bevel) * Math.min(w, h, d), smooth: st.boxSmooth, top: o.top,
    }),
    /** a feature on its base, rising `h` (a nose, an ear tip, a beak): hex a wedge, soft a small tapered rounded block */
    nub: (w, h, d, o = {}) => soft
      ? transform(chamferBox({ w, h, d, c: 0.42 * Math.min(w, h, d), smooth: true, top: { sx: o.sx ?? 0.6, sz: o.sz ?? 0.6, dz: ((o.ridge ?? 0) * d) / 2 } }), translation(0, h / 2, 0))
      : wedge({ w, h, d, ridge: o.ridge ?? 0, sx: o.sx ?? 0.6 }),
    /** a point: a lock of hair, a horn, a tail tip */
    spike: (rx, rz, h, o = {}) => pyramid({ sides: soft ? 8 : (o.sides ?? 6), rx, rz, h, smooth: soft, apex: o.apex }),
    /** a puff (hair, wool, a leaf mass): a low dome of the style's n-gon */
    puff: (r, h, o = {}) => loft({
      sides: st.sides, rx: r, rz: o.rz ?? r, smooth: st.smooth, caps: o.caps ?? { bottom: false }, phase: o.phase,
      rings: o.rings ?? [{ y: 0, sx: 0.92 }, { y: h * 0.4, sx: 1 }, { y: h * 0.78, sx: 0.8 }, { y: h, sx: o.top ?? 0.42 }],
    }),
  };
}

/** M placing a part built along +y from `a` to `b` (alongSegment), then `extra` in that frame. */
const seg = (a, b, extra, o) => (extra ? mul(alongSegment(a, b, o), extra) : alongSegment(a, b, o));
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

// ---------------------------------------------------------------------------------------------------
// Caelan (avatars.js palette): a young boy — poofy dirty-blonde hair, a green top with a white stripe and its sleeves
// pushed up to the forearm (a cuff you see in first person too), jeans with a rolled hem, white sneakers
// ---------------------------------------------------------------------------------------------------

const CAELAN = Object.freeze({
  legX: 0.092, ankleY: 0.08, hipY: 0.72,
  leg: { rx: 0.085, rz: 0.088, rings: [{ y: 0, sx: 0.74 }, { y: 0.2, sx: 0.87 }, { y: 0.29, sx: 0.82 }, { y: 0.48, sx: 0.97 }, { y: 0.65, sx: 1 }] },
  hips: { y0: 0.63, y1: 0.85, rx: 0.176, rz: 0.114 },
  torso: {
    y0: 0.79, rx: 0.184, rz: 0.118,
    rings: [{ y: 0, sx: 0.97, sz: 0.98 }, { y: 0.1, sx: 0.92, sz: 0.94 }, { y: 0.26, sx: 1, sz: 1.03 }, { y: 0.33, sx: 0.98, sz: 0.98 }, { y: 0.365, sx: 0.74, sz: 0.78 }],
  },
  neck: { y0: 1.1, y1: 1.23, r: 0.064 },
  head: { y: 1.395, w: 0.355, h: 0.365, d: 0.35 },
  shoulder: [0.222, 1.095, 0.005], elbow: [0.252, 0.845, 0.028], wrist: [0.268, 0.625, -0.03],
  upper: { rx: 0.067, rz: 0.064 },
  fore: { rx: 0.066, rz: 0.06, rings: (L) => [{ y: 0, sx: 0.66, sz: 0.66 }, { y: L * 0.55, sx: 0.8 }, { y: L, sx: 0.85 }] },
  cuffAt: 0.45, // share of the forearm from the wrist where the sleeve's cuff sits
});

/** Paint Caelan's atlas (shared by both styles and by the first-person hand). */
function paintCaelan() {
  const def = avatarById('caelan');
  const P = def.palette;
  const O = def.outfit;
  const D = DENSITY.body;
  const DH = DENSITY.head;
  const skinR = P.skin;
  const top = O.top;
  const jeans = O.bottom;
  const s = new Skin(256, 256, 7);
  const C = CAELAN;
  // --- the head: a face in front, plain skin round it (the hair covers the back and the top)
  const hw = Math.round(C.head.w * DH);
  const hh = Math.round(C.head.h * DH);
  const hd = Math.round(C.head.d * DH);
  s.box('head', hw, hh, hd, {
    front: (p) => {
      p.skin(skinR).shadeV(1.0, 1.1); // lighter toward the chin: its bevel faces the ground
      paintFace(p, {
        skin: skinR, eyes: P.eyes, brows: P.brows, mouth: P.mouth, blush: P.blush, freckles: true,
        eyeY: 0.54, eyeGap: 0.345, eyeW: 0.165, mouthY: 0.8,
      });
      for (let y = Math.floor(p.h * 0.84); y < p.h; y++) for (let x = 0; x < p.w; x++) p.tone(x, y, 1 + 0.32 * ((y - p.h * 0.84) / (p.h * 0.16)));
    },
    all: (p) => p.skin(skinR).shadeV(1.02, 0.9),
    bottom: (p) => p.skin([skinR[2], skinR[2], skinR[3]]).ao({ top: 0.3, bottom: 0.3, left: 0.3, right: 0.3, width: 0.4 }),
  });
  s.plain('skin', 24, 24, (p) => p.skin(skinR).shadeV(1.05, 0.92));
  s.wrap('neck', Math.round(perimeter(C.neck.r, C.neck.r) * D), Math.round((C.neck.y1 - C.neck.y0) * D), (p) => {
    p.skin(skinR).ao({ top: 0.55, width: 0.6 });
  });
  // --- the hair: soft curls in dirty blonde, a sheen near the top
  s.plain('hair', 64, 64, (p) => {
    p.hair(P.hair, { dir: [0.15, 1], sheen: 0.32, strand: 2.6 });
    const rnd = makeRng(41);
    for (let i = 0; i < 40; i++) {
      const x = rnd() * 64;
      const y = rnd() * 64;
      p.arc(x, y, 2.2 + rnd() * 1.5, Math.PI * 1.1, Math.PI * 1.9, 0.5, P.hair[0], 0.5);
      p.arc(x, y + 0.8, 2.2 + rnd() * 1.5, Math.PI * 0.15, Math.PI * 0.85, 0.5, P.hair[3], 0.45);
    }
  });
  // --- the top: green cloth, a white stripe round the chest, side seams, a turned hem, a crew collar on the cap
  const tw = Math.round(perimeter(C.torso.rx * 1.02, C.torso.rz * 1.03) * D);
  const th = Math.round(C.torso.rings[4].y * D);
  const stripeY = Math.round(th * 0.36);
  s.wrap('torso', tw, th, (p) => {
    p.cloth(top, { fold: 0.8 });
    p.ellipse(tw * 0.25, -2, 7, 6, top[2], 0.35);
    p.ellipse(tw * 0.75, -2, 7, 6, top[2], 0.35);
    p.line(-1, stripeY, tw + 1, stripeY, 2.2, O.trim, 1);
    p.line(-1, stripeY - 2.6, tw + 1, stripeY - 2.6, 0.5, mix(O.trim, top[2], 0.5), 0.6);
    p.line(-1, stripeY + 2.6, tw + 1, stripeY + 2.6, 0.5, mix(O.trim, top[2], 0.5), 0.6);
    for (const u of [0.25, 0.75]) p.seam(tw * u, 0, tw * u, th, top);
    p.hem(th - 4, 4, top);
    p.shadeV(1.05, 0.9);
    p.ao({ bottom: 0.25, width: 0.15 });
  }, {
    cap: [34, 22],
    top: (p) => {
      p.cloth(top);
      p.ellipse(17, 11, 7.2, 6.6, top[2], 1);
      p.ellipse(17, 11, 5.6, 5.1, mix(top[2], 0x1a2a1a, 0.4), 1);
      p.line(2, 11, 10, 11, 0.5, top[2], 0.6);
      p.line(24, 11, 32, 11, 0.5, top[2], 0.6);
    },
  });
  // --- the sleeve on the upper arm, and the forearm: the sleeve pushed up to a cuff, the skin below it
  const uw = Math.round(perimeter(C.upper.rx, C.upper.rz) * D);
  const uh = Math.round(len(C.shoulder, C.elbow) * D);
  s.wrap('upperArm', uw, uh, (p) => {
    p.cloth(top);
    p.seam(uw * 0.5, 0, uw * 0.5, uh, top, { stitch: false });
    p.shadeV(1.08, 0.92);
  });
  const fw = Math.round(perimeter(C.fore.rx * 0.85, C.fore.rz * 0.85) * D);
  const fh = Math.round(len(C.elbow, C.wrist) * D);
  const cuffRow = Math.round(fh * (1 - C.cuffAt));
  s.wrap('foreArm', fw, fh, (p) => {
    p.skin(skinR).shadeV(1.0, 0.93);
    p.ao({ top: 0.2, width: 0.5 });
    for (let y = 0; y < cuffRow; y++) for (let x = 0; x < fw; x++) p.px(x, y, mix(top[1], top[2], 0.15 + 0.2 * fbm(x / 5, y / 4, 3)), 1);
  }, { top: (p) => p.cloth(top), bottom: (p) => p.skin(skinR) });
  s.wrap('cuff', fw + 2, 6, (p) => {
    p.knit([top[0], mix(top[0], top[1], 0.5), top[2]], { cell: 3 });
    p.line(-1, 1, fw + 3, 1, 0.6, O.trim, 0.9);
    p.shadeV(1.08, 0.86);
  });
  // --- the hands: skin a little darker toward the fingertips, knuckle creases
  s.plain('hand', 24, 24, (p) => {
    p.skin(skinR).shadeV(1.02, 0.9);
    for (const y of [8, 15]) p.line(2, y, 22, y, 0.45, skinR[2], 0.45);
  });
  // --- jeans: the hips (a belt, its buckle, a fly, back pockets) and the legs (side seams, worn knees, a rolled hem)
  const jw = Math.round(perimeter(C.hips.rx, C.hips.rz) * D);
  const jh = Math.round((C.hips.y1 - C.hips.y0) * D);
  s.wrap('hips', jw, jh, (p) => {
    p.denim(jeans);
    const belt = 0x6b4a2e;
    p.fill((x, y) => (y < 5 ? shade(belt, 0.92 + 0.14 * hash2(x, y, 5)) : p.get(x, y)));
    p.line(-1, 5.3, jw + 1, 5.3, 0.5, 0x3e2a1a, 0.8);
    p.ellipse(jw / 2, 2.5, 3.2, 2.4, 0xd6c48a, 1).ellipse(jw / 2, 2.5, 1.8, 1.1, belt, 1);
    for (const u of [0.12, 0.36, 0.64, 0.88]) p.line(jw * u, 0, jw * u, 5.5, 0.6, jeans[2], 0.9);
    p.stitches(jw / 2 + 2.5, 6, jw / 2 + 2.5, jh - 2, 0xd9a25a, { a: 0.8 });
    p.line(jw / 2, 6, jw / 2, jh, 0.45, jeans[2], 0.8);
    for (const u of [0.07, 0.93]) {
      p.line(jw * u - 5, 9, jw * u + 5, 9, 0.45, jeans[2], 0.8);
      p.stitches(jw * u - 5, 10, jw * u + 5, 10, 0xd9a25a, { a: 0.7 });
    }
    for (const u of [0.25, 0.75]) p.seam(jw * u, 6, jw * u, jh, jeans);
    p.ao({ bottom: 0.3, width: 0.3 });
  });
  const lw = Math.round(perimeter(C.leg.rx, C.leg.rz) * D);
  const lh = Math.round(C.leg.rings[4].y * D);
  s.wrap('leg', lw, lh, (p) => {
    p.denim(jeans);
    for (const u of [0.25, 0.75]) p.seam(lw * u, 0, lw * u, lh, jeans);
    p.stitches(lw * 0.28, 0, lw * 0.28, lh, 0xd9a25a, { a: 0.6 });
    p.glow(lw * 0.5, lh * 0.55, lw * 0.18, jeans[0], 0.35, lh * 0.1);
    p.shadeV(0.86, 1.02);
    p.ao({ top: 0.35, bottom: 0.15, width: 0.12 });
  });
  s.wrap('jeanCuff', lw + 4, 6, (p) => {
    p.denim([shade(jeans[0], 1.1), jeans[0], jeans[1]]);
    p.stitches(0, 3, lw + 4, 3, 0xd9a25a, { a: 0.7 });
    p.shadeV(1.08, 0.84);
  });
  // --- sneakers: white uppers with a red flash, a grey rubber sole band, laces over the top
  const sw = Math.round(0.118 * DH);
  const sh = Math.round(0.09 * DH);
  const sd = Math.round(0.228 * DH);
  const [white, sole, accent] = O.shoes;
  const upper = (p) => {
    p.cloth([shade(white, 1.02), white, shade(white, 0.88)], { fold: 0.5 });
    p.fill((x, y) => (y > p.h - 5 ? shade(sole, 1 + 0.06 * hash2(x, y, 2)) : p.get(x, y)));
    p.line(-1, p.h - 5, p.w + 1, p.h - 5, 0.5, shade(sole, 0.7), 0.9);
    p.stitches(0, p.h - 7, p.w, p.h - 7, shade(white, 0.75), { a: 0.6 });
    p.ao({ bottom: 0.15, width: 0.2 });
  };
  s.box('shoe', sw, sh, sd, {
    all: upper,
    left: (p) => {
      upper(p);
      p.polyline([[3, p.h - 8], [p.w * 0.45, p.h * 0.35], [p.w - 6, p.h * 0.5]], 1.6, accent, 1);
    },
    right: (p) => {
      upper(p);
      p.polyline([[p.w - 3, p.h - 8], [p.w * 0.55, p.h * 0.35], [6, p.h * 0.5]], 1.6, accent, 1);
    },
    top: (p) => {
      p.cloth([shade(white, 1.02), white, shade(white, 0.88)], { fold: 0.4 });
      p.ellipse(p.w / 2, p.h * 0.62, p.w * 0.3, p.h * 0.3, shade(white, 0.9), 1);
      for (let k = 0; k < 4; k++) {
        const y = p.h * (0.4 + 0.11 * k);
        p.line(p.w * 0.25, y, p.w * 0.75, y + 2, 0.7, shade(white, 0.7), 0.9);
        p.line(p.w * 0.25, y + 2, p.w * 0.75, y, 0.7, shade(white, 0.78), 0.9);
      }
      p.ellipse(p.w / 2, p.h * 0.15, p.w * 0.38, p.h * 0.12, shade(white, 0.94), 1);
    },
    bottom: (p) => p.stone([shade(sole, 1.1), sole, shade(sole, 0.7)]),
  });
  return s;
}

/** Caelan standing at ease, in style `st`. @param {Style} st @param {Skin} s */
function buildCaelan(st, s) {
  const S = shapes(st);
  const C = CAELAN;
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  for (const side of [-1, 1]) {
    const x = side * C.legX;
    add(S.block(0.118, 0.09, 0.228, { top: { sx: 0.88, sz: 0.8, dz: 0.02 } }), 'shoe', compose({ t: [x * 1.04, 0.045, -0.036], r: [0, side * -0.06, 0] }));
    add(S.col(C.leg.rx, C.leg.rz, C.leg.rings), 'leg', translation(x, C.ankleY, 0));
    add(S.col(C.leg.rx * 0.8, C.leg.rz * 0.8, [{ y: 0 }, { y: 0.038, sx: 0.98 }], { caps: false }), 'jeanCuff', translation(x, C.ankleY - 0.002, 0));
  }
  add(S.col(C.hips.rx, C.hips.rz, [{ y: 0, sx: 0.96 }, { y: C.hips.y1 - C.hips.y0 }]), 'hips', translation(0, C.hips.y0, 0));
  add(S.col(C.torso.rx, C.torso.rz, C.torso.rings), 'torso', translation(0, C.torso.y0, 0));
  add(S.col(C.neck.r, C.neck.r, [{ y: 0 }, { y: C.neck.y1 - C.neck.y0, sx: 0.95 }], { caps: false }), 'neck', translation(0, C.neck.y0, 0));
  // arms: the sleeve from the shoulder to the elbow, the forearm from the wrist up to the elbow, a cuff on it, a hand
  for (const side of [-1, 1]) {
    const sh = [side * C.shoulder[0], C.shoulder[1], C.shoulder[2]];
    const el = [side * C.elbow[0], C.elbow[1], C.elbow[2]];
    const wr = [side * C.wrist[0], C.wrist[1], C.wrist[2]];
    const uL = len(sh, el);
    add(S.col(C.upper.rx, C.upper.rz, [{ y: 0, sx: 0.5, sz: 0.62 }, { y: 0.042, sx: 0.96 }, { y: uL * 0.4, sx: 1 }, { y: uL, sx: 0.88 }]), 'upperArm',
      seg([sh[0], sh[1] + 0.042, sh[2]], el));
    const fL = len(wr, el);
    add(S.col(C.fore.rx, C.fore.rz, C.fore.rings(fL)), 'foreArm', seg(wr, el));
    add(S.col(C.fore.rx * 0.86, C.fore.rz * 0.92, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }], { caps: false }), 'cuff',
      seg(wr, el, translation(0, fL * C.cuffAt - 0.017, 0)));
    // the hand hangs from the wrist, palm in, fingers a little curled
    const hand = compose({ t: [wr[0] + side * 0.002, wr[1], wr[2]], r: [0.08, 0, side * 0.06] });
    add(S.block(0.042, 0.08, 0.08, { top: { sx: 1.1, sz: 1.05 } }), 'hand', mul(hand, translation(0, -0.043, 0)));
    add(S.block(0.036, 0.062, 0.074, { top: { sx: 1.0, sz: 1.0 } }), 'hand', mul(hand, compose({ t: [-side * 0.005, -0.104, 0.004], r: [0.1, 0, -side * 0.3] })));
    add(S.nub(0.028, 0.055, 0.026, { sx: 0.7, ridge: 0 }), 'hand', mul(hand, compose({ t: [-side * 0.012, -0.032, -0.039], r: [Math.PI, 0, side * 0.35] })));
  }
  // the head and its features (head frame: the head's centre)
  const H = C.head;
  const head = translation(0, H.y, 0);
  headAndFace(st, S, add, head, H);
  hairDome(S, add, head, H, { key: 'hair' });
  hairPuffs(S, add, head, CAELAN_PUFFS, 'hair');
  hairFringe(S, add, head, H, CAELAN_FRINGE, 'hair');
  // the nape: a low mass behind, under the dome's rim
  add(S.block(H.w + 0.01, 0.15, 0.085, { bevel: 0.4, top: { sx: 1.06 } }), 'hair', mul(head, translation(0, -0.055, H.d / 2 - 0.018)));
  return s.model(parts);
}

/** A head (a chamfered box, its jaw a little narrower than its brow), a nose and two ears. */
function headAndFace(st, S, add, head, H, { skin = 'skin', nose = [0.046, 0.032, 0.066] } = {}) {
  add(S.block(H.w, H.h, H.d, { bevel: st.head, bevelBottom: st.head * 0.4, top: { sx: 1.04, sz: 1.02 } }), 'head', head);
  add(S.nub(nose[0], nose[1], nose[2], { sx: 0.35, ridge: -0.45 }), skin, mul(head, compose({ t: [0, H.h * -0.13, -H.d / 2 + 0.006], r: [-Math.PI / 2, 0, 0] })));
  for (const side of [-1, 1]) {
    const ear = st.id === 'soft'
      ? transform(chamferBox({ w: 0.085, h: 0.026, d: 0.06, c: 0.012, smooth: true, top: { sx: 0.85, sz: 0.85 } }), translation(0, 0.015, 0))
      : loft({ sides: 6, rx: 0.043, rz: 0.03, rings: [{ y: 0 }, { y: 0.022, sx: 0.72, sz: 0.7 }] });
    add(ear, skin, mul(head, compose({ t: [side * (H.w / 2 - 0.006), -0.03, 0.012], r: [0, 0, -side * Math.PI / 2] })));
  }
}

/**
 * The hair's shell: a dome of the style's n-gon over the head, tilted back so that its rim runs from the hairline over
 * the brow, above the ears, down to the nape (never a box helmet: the face stays open below the fringe).
 */
function hairDome(S, add, head, H, { key, lift = 0.03, tilt = 0.32, grow = 0.028, height = 0.235, top = 0.46 }) {
  const rx = H.w / 2 + grow;
  const rz = H.d / 2 + grow;
  add(S.col(rx, rz, [{ y: 0, sx: 1 }, { y: height * 0.45, sx: 1.05 }, { y: height * 0.8, sx: 0.88 }, { y: height, sx: top }]), key,
    mul(head, compose({ t: [0, lift, 0.012], r: [tilt, 0, 0] })));
}

/** Puffs on the dome: [dirX, dirY, dirZ, radius] from the middle of the crown, each a low dome pointing outward. */
function hairPuffs(S, add, head, puffs, key, { centre = [0, 0.05, 0.025], reach = 0.175, h = 0.055 } = {}) {
  puffs.forEach(([dx, dy, dz, r], i) => {
    const l = Math.hypot(dx, dy, dz);
    const d = [dx / l, dy / l, dz / l];
    const base = [centre[0] + d[0] * reach, centre[1] + d[1] * reach, centre[2] + d[2] * reach];
    const tip = [base[0] + d[0] * h, base[1] + d[1] * h, base[2] + d[2] * h];
    add(S.puff(r, h, { rz: r * 0.9 }), key, mul(head, seg(base, tip, null, { roll: i * 0.9 })));
  });
}

/** A fringe of locks over the forehead: [x, length, half-width, sweep] each, hanging from the dome's front rim. */
function hairFringe(S, add, head, H, locks, key, { y = 0.105, thick = 0.02 } = {}) {
  for (const [x, l, r, sweep] of locks) {
    const base = [x, y, -H.d / 2 + 0.008];
    const tip = [x + sweep, y - l, -H.d / 2 - 0.026];
    add(S.spike(r, thick, len(base, tip), { sides: 6 }), key, mul(head, seg(base, tip)));
  }
}

const CAELAN_PUFFS = [
  [0, 1, 0.1, 0.085], [-0.55, 0.8, -0.3, 0.08], [0.55, 0.8, -0.22, 0.082], [-0.5, 0.75, 0.45, 0.085], [0.5, 0.78, 0.42, 0.08],
  [0, 0.62, 0.8, 0.088], [-0.92, 0.32, 0.12, 0.07], [0.92, 0.38, 0.05, 0.07], [-0.62, 0.25, 0.75, 0.075],
  [0.6, 0.3, 0.72, 0.075], [0, 0.85, -0.52, 0.075], [0, 0.1, 1, 0.08],
];
const CAELAN_FRINGE = [
  [-0.135, 0.055, 0.042, 0.02], [-0.085, 0.08, 0.048, 0.03], [-0.03, 0.07, 0.05, 0.035], [0.025, 0.088, 0.05, 0.04],
  [0.08, 0.07, 0.046, 0.035], [0.13, 0.05, 0.04, 0.025],
];

// ---------------------------------------------------------------------------------------------------
// The first-person hand: a sleeve cuff, a forearm, a real fist (palm, four curled fingers, a thumb over them) round
// the haft of the tool, small and low at the lower right of the view
// ---------------------------------------------------------------------------------------------------

/** Where the fist sits in camera space (x right, y up, −z ahead; metres) at rest and mid-swing, and how it is turned. */
export const FP_HAND = Object.freeze({
  grip: Object.freeze([0.205, -0.235, -0.47]),
  /** from the fist toward the elbow */
  arm: Object.freeze([0.42, -0.36, 0.83]),
  /** the back of the hand faces about this way (made square to the forearm) */
  back: Object.freeze([0.9, 0.05, 0.42]),
  /** the wrist tips the fist forward (radians about the hand's x): the haft leans ahead, not back at the eye */
  deviate: -0.7,
  /** the slab turned about its haft from the swing's plane toward the eye, so the tool's picture reads */
  toolTurn: 0.85,
  toolScale: 0.74,
  /** the hand and forearm drawn this much larger than the avatar's (they are seen from 0.4 m, not 4) */
  handScale: 1.12,
  forearm: 0.25,
  /** the swing: the forearm turns about the elbow (radians about the camera's x, a little in) and the wrist bends */
  swingArm: -0.5, swingIn: 0.3, swingWrist: -0.5, swingPush: 0.05,
});

/** @param {ArrayLike<number>} v @returns {number[]} */
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A rotation of `a` radians about the unit axis n through point p (column-major). */
function rotateAbout(p, n, a) {
  const [x, y, z] = norm(n);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  const R = new Float64Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
  return mul(translation(p[0], p[1], p[2]), mul(R, translation(-p[0], -p[1], -p[2])));
}

/**
 * The hand's frames in camera space: origin at the fist (the middle of the grip), +y along the haft, +z toward the
 * elbow, +x out of the back of the hand. `arm` carries the forearm; `hand` the fist and the tool, which the wrist
 * bends on through the stroke. `swing` 0 at rest .. 1 at the bottom of the stroke.
 * @returns {{ arm: Float64Array, hand: Float64Array }}
 */
export function fpHandFrame(swing = 0) {
  const F = FP_HAND;
  const z = norm(F.arm);
  const b = norm(F.back);
  const d = b[0] * z[0] + b[1] * z[1] + b[2] * z[2];
  const x = norm([b[0] - d * z[0], b[1] - d * z[1], b[2] - d * z[2]]);
  const y = cross(z, x);
  const g = F.grip;
  let M = mul(new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, g[0], g[1], g[2], 1]), scaling(F.handScale));
  const s = swing > 0 ? Math.sin((Math.PI / 2) * Math.min(1, swing)) : 0;
  if (s > 0) {
    const elbow = [g[0] + z[0] * F.forearm, g[1] + z[1] * F.forearm, g[2] + z[2] * F.forearm];
    M = mul(rotateAbout(elbow, [1, 0, F.swingIn], F.swingArm * s), M);
    M = mul(translation(0, 0, -F.swingPush * s), M);
  }
  return { arm: M, hand: mul(M, rotateAbout([0, 0, 0.045], [1, 0, 0], F.deviate + F.swingWrist * s)) };
}

/**
 * The first-person hand in camera space, gripping the tool: `swing` 0 at rest .. 1 at the bottom of the stroke. Its
 * `tool` matrix places heldItem.js's slab (its grip at the fist, its haft along the hand's +y, its head forward).
 * @param {'hex'|'soft'} style
 * @param {number} [swing]
 * @returns {PilotModel}
 */
export function buildHand(style, swing = 0, { frame = 'camera' } = {}) {
  const st = STYLES[style];
  const S = shapes(st);
  const s = paintCaelan();
  const C = CAELAN;
  const { arm, hand } = frame === 'hand' ? { arm: identity(), hand: identity() } : fpHandFrame(swing);
  const parts = [];
  const add = (geo, key, m) => parts.push(s.place(geo, key, mul(hand, m)));
  const addArm = (geo, key, m) => parts.push(s.place(geo, key, mul(arm, m)));
  // the forearm from the wrist back to the elbow, its sleeve pushed up to a cuff
  const wrist = [0.004, 0, 0.045];
  const elbow = [0.004, 0, 0.045 + 0.235];
  const fL = len(wrist, elbow);
  addArm(S.col(C.fore.rx * 0.95, C.fore.rz * 0.95, C.fore.rings(fL)), 'foreArm', seg(wrist, elbow, null, { back: [1, 0, 0] }));
  addArm(S.col(C.fore.rx * 0.82, C.fore.rz * 0.88, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }], { caps: false }), 'cuff',
    seg(wrist, elbow, translation(0, fL * C.cuffAt - 0.017, 0), { back: [1, 0, 0] }));
  // the palm and the back of the hand: a block beside the haft, the wrist behind it
  add(S.block(0.034, 0.078, 0.07, { top: { sx: 0.95, sz: 0.92 } }), 'hand', compose({ t: [0.02, 0.001, 0.018], r: [0, -0.08, 0] }));
  // four fingers, index at the top: across the front of the haft, then curled back along its far side
  const fy = [0.027, 0.009, -0.009, -0.026];
  const fr = [0.0092, 0.0095, 0.0092, 0.0082];
  fy.forEach((y, i) => {
    const k = [0.03, -0.019, y];
    const a = [-0.006, -0.026 - (i === 3 ? -0.003 : 0), y];
    const b = [-0.024, -0.005, y];
    const tip = [-0.018, 0.016 - i * 0.002, y];
    const finger = (r, p0, p1) => S.col(r, r * 0.92, [{ y: 0, sx: 1 }, { y: len(p0, p1), sx: 0.92 }]);
    // in the hand's frame the finger rows lie across +y: lay each segment from a to b at height y
    const at = (p) => [p[0], p[2], p[1]];
    add(finger(fr[i], at(k), at(a)), 'hand', seg(at(k), at(a), null, { back: [0, 0, 1] }));
    add(finger(fr[i] * 0.95, at(a), at(b)), 'hand', seg(at(a), at(b), null, { back: [0, 0, 1] }));
    add(finger(fr[i] * 0.88, at(b), at(tip)), 'hand', seg(at(b), at(tip), null, { back: [0, 0, 1] }));
  });
  // the thumb: from the heel of the hand round the haft's top, its tip resting on the middle finger
  const t0 = [0.012, 0.03, 0.038];
  const t1 = [-0.016, 0.038, 0.012];
  const t2 = [-0.02, 0.026, -0.016];
  add(S.col(0.0125, 0.011, [{ y: 0, sx: 1.1 }, { y: len(t0, t1), sx: 0.95 }]), 'hand', seg(t0, t1, null, { back: [1, 0, 0] }));
  add(S.col(0.011, 0.0095, [{ y: 0 }, { y: len(t1, t2), sx: 0.85 }]), 'hand', seg(t1, t2, null, { back: [1, 0, 0] }));
  // the tool: in the swing's plane the slab's picture is the hand's (y, z) — its head ahead of the knuckles (−z), its
  // face out of the back of the hand (+x) — then turned about the haft toward the eye so its picture reads
  const swingPlane = new Float64Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const tool = mul(hand, mul(rotation(1, FP_HAND.toolTurn), mul(swingPlane, scaling(FP_HAND.toolScale))));
  return s.model(parts, { tool });
}

// ---------------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------------

/** The pilot's models by name. */
export const PILOT_MODELS = Object.freeze(['caelan', 'zombie', 'sheep', 'pig', 'honeyberry', 'sapling']);

/**
 * One pilot model in one style.
 * @param {string} name  PILOT_MODELS
 * @param {'hex'|'soft'} style
 * @returns {PilotModel}
 */
export function buildPilot(name, style) {
  const st = STYLES[style];
  if (!st) throw new RangeError(`no style ${style}`);
  switch (name) {
    case 'caelan': return buildCaelan(st, paintCaelan());
    case 'zombie': return buildZombie(st, paintZombie());
    case 'sheep': return buildSheep(st, paintSheep());
    case 'pig': return buildPig(st, paintPig());
    case 'honeyberry': return buildHoneyberry(st, paintBush());
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
  head: { y: 1.635, w: 0.29, h: 0.325, d: 0.3 },
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
  s.box('head', Math.round(Z.head.w * DH), Math.round(Z.head.h * DH), Math.round(Z.head.d * DH), {
    front: (p) => {
      mottled(p);
      paintFace(p, { kind: 'zombie', skin: skinR, brows: W.hair[3], eyeY: 0.5, eyeGap: 0.38, eyeW: 0.2, mouthY: 0.8 });
    },
    all: (p) => mottled(p),
  });
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
  headAndFace(st, S, add, head, H, { nose: [0.05, 0.034, 0.07] });
  hairDome(S, add, head, H, { key: 'hair', lift: 0.045, tilt: 0.5, grow: 0.012, height: 0.15, top: 0.5 });
  hairFringe(S, add, head, H, [[-0.11, 0.05, 0.03, -0.01], [-0.04, 0.085, 0.026, 0.01], [0.07, 0.065, 0.028, 0.02]], 'hair', { y: 0.125, thick: 0.014 });
  for (const [x, z, l] of [[-0.15, 0.05, 0.13], [0.15, 0.08, 0.11], [-0.07, 0.16, 0.14], [0.08, 0.16, 0.12]]) {
    const base = [x, 0.06, z];
    add(S.spike(0.03, 0.016, l, { sides: 6 }), 'hair', mul(head, seg(base, [x * 1.15, 0.06 - l, z + 0.02])));
  }
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
// Plants: the honeyberry bush (a low dark bush on a short trunk, clusters of pale blue berries) and a sapling — leaf
// masses as faceted gems, painted with layered leaves and veins; bark; berries with a dusty bloom
// ---------------------------------------------------------------------------------------------------

const BUSH = Object.freeze({
  leaves: [0x86b25a, 0x5d8a3c, 0x3e6a2a, 0x24421a],
  young: [0xa8d070, 0x7cb24c, 0x568a34, 0x355a22],
  bark: [0x9a7a56, 0x75583c, 0x4e3a27],
  berry: [0xc6dcf6, 0x8eb0e2, 0x5a7cbc, 0x3c548c],
});

function paintBush() {
  const B = BUSH;
  const s = new Skin(256, 256, 41);
  const mass = (ramp) => (p) => {
    p.leaves(ramp, { size: 12, density: 1.25 });
    p.shadeV(1.16, 0.8);
  };
  s.wrap('leaves', 176, 52, mass(B.leaves), {
    cap: [56, 56], top: (p) => p.leaves(B.leaves, { size: 9, density: 1.2, up: 0 }), bottom: (p) => p.leaves(B.leaves, { size: 8 }).shadeV(0.7, 0.7),
  });
  s.wrap('young', 160, 48, mass(B.young), {
    cap: [48, 48], top: (p) => p.leaves(B.young, { size: 8, density: 1.2, up: 0 }), bottom: (p) => p.leaves(B.young, { size: 8 }).shadeV(0.7, 0.7),
  });
  s.wrap('bark', 32, 64, (p) => p.bark(B.bark).ao({ bottom: 0.4, width: 0.3 }), { top: (p) => p.bark(B.bark) });
  s.plain('berry', 16, 16, (p) => {
    p.fill(B.berry[1]);
    p.glow(6, 5, 6, B.berry[0], 0.8);
    p.glow(10, 11, 7, B.berry[3], 0.5);
    p.mottle(0.06, 2);
  });
  for (const [key, ramp] of [['leaf', B.leaves], ['youngLeaf', B.young]]) {
    s.plain(key, 24, 24, (p) => {
      p.fill(ramp[1]);
      p.leaf(1, 12, 0, 22, 10, ramp[0], ramp[2]);
      p.shadeV(1.1, 0.85);
    });
  }
  return s;
}

/** A gem of leaves: a faceted mass, narrow at its foot, broad at its waist, a flattish crown. */
function leafMass(S, r, h, rz = r) {
  return S.col(r, rz, [{ y: 0, sx: 0.5 }, { y: h * 0.38, sx: 1 }, { y: h * 0.78, sx: 0.9 }, { y: h, sx: 0.48 }]);
}

/**
 * A leaf mass at (x, y, z) with its fringe: `n` leaves (flat wedges: a point, never a card) springing out round its
 * waist and two from its crown, so its outline is leafy rather than a rock's.
 */
function addMass(S, add, key, leafKey, mass, n = 7) {
  const [x, y, z, r, h, yaw] = /** @type {number[]} */ (mass);
  add(leafMass(S, r, h, r * 0.92), key, compose({ t: [x, y, z], r: [0, yaw, 0] }));
  const leaf = wedge({ w: 0.088, h: 0.1, d: 0.012, ridge: 0, sx: 0.42 });
  for (let i = 0; i < n + 2; i++) {
    const crown = i >= n;
    const a = yaw + (crown ? (i - n) * 2.1 + 0.4 : (i / n) * Math.PI * 2 + 0.3 * Math.sin(i * 7.1));
    const ry = crown ? h * 0.92 : h * (0.32 + 0.12 * Math.sin(i * 3.3));
    const rr = crown ? r * 0.3 : r * 0.92;
    const base = [x + Math.cos(a) * rr, y + ry, z + Math.sin(a) * rr];
    const out = crown ? 0.55 : 1;
    const tip = [base[0] + Math.cos(a) * 0.1 * out, base[1] + (crown ? 0.05 : 0.02 + 0.025 * Math.cos(i * 5.3)), base[2] + Math.sin(a) * 0.1 * out];
    add(leaf, leafKey, seg(base, tip, null, { back: [0, 1, 0], roll: 0.4 * Math.sin(i * 2.7) }));
  }
}

/** A berry: a little elongated gem. */
function berry(S, r) {
  return S.col(r, r, [{ y: 0, sx: 0 }, { y: r * 1.1, sx: 1 }, { y: r * 2.2, sx: 0.4 }], { caps: { top: true, bottom: false } });
}

/** The honeyberry bush with its berries. @param {Style} st @param {Skin} s */
function buildHoneyberry(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(S.col(0.036, 0.034, [{ y: 0, sx: 1.15 }, { y: 0.17, sx: 0.85 }]), 'bark', identity());
  for (const [x, z] of [[-0.12, 0.08], [0.13, -0.06], [0.02, 0.12]]) add(S.col(0.018, 0.018, [{ y: 0 }, { y: len([0, 0.14, 0], [x, 0.3, z]), sx: 0.7 }]), 'bark', seg([0, 0.14, 0], [x, 0.3, z]));
  const masses = [[0, 0.12, 0, 0.27, 0.33, 0.2], [-0.2, 0.08, 0.1, 0.18, 0.25, 1.1], [0.2, 0.1, -0.08, 0.17, 0.24, 2.3], [0.05, 0.08, 0.2, 0.16, 0.22, 3.1], [-0.04, 0.33, -0.04, 0.17, 0.2, 0.7]];
  for (const m of masses) addMass(S, add, 'leaves', 'leaf', m, m[3] > 0.2 ? 9 : 6);
  // clusters of berries on the masses' flanks
  const clusters = [[0.27, 0.27, 0.05], [-0.33, 0.22, 0.12], [0.12, 0.25, 0.3], [-0.12, 0.3, -0.27], [0.25, 0.2, -0.22], [-0.05, 0.47, 0.13]];
  clusters.forEach(([x, y, z], i) => {
    const n = norm([x, 0.15, z]);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + i;
      const p = [x + Math.cos(a) * 0.028 + n[0] * 0.01, y - k * 0.012 + Math.sin(a) * 0.012, z + Math.sin(a) * 0.028 + n[2] * 0.01];
      add(berry(S, 0.022), 'berry', compose({ t: p, r: [0.4 * Math.cos(a), 0, 0.4 * Math.sin(a)] }));
    }
  });
  return s.model(parts);
}

/** A sapling: a slim trunk, two twigs, three leaf masses and a few single leaves. @param {Style} st @param {Skin} s */
function buildSapling(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(S.col(0.03, 0.03, [{ y: 0, sx: 1.2 }, { y: 0.4, sx: 0.85 }, { y: 0.75, sx: 0.55 }]), 'bark', compose({ r: [0.04, 0, -0.03] }));
  add(S.col(0.012, 0.012, [{ y: 0 }, { y: 0.2, sx: 0.6 }]), 'bark', seg([0.01, 0.42, 0], [-0.15, 0.55, 0.04]));
  add(S.col(0.012, 0.012, [{ y: 0 }, { y: 0.18, sx: 0.6 }]), 'bark', seg([0.015, 0.55, 0], [0.15, 0.66, -0.05]));
  for (const m of [[0.02, 0.62, 0.0, 0.2, 0.3, 0.3], [-0.17, 0.5, 0.05, 0.13, 0.18, 1.4], [0.17, 0.6, -0.05, 0.12, 0.17, 2.6]]) {
    addMass(S, add, 'young', 'youngLeaf', m, m[3] > 0.15 ? 8 : 5);
  }
  for (const [x, y, z, a] of [[0.0, 0.3, 0.02, 0.6], [0.02, 0.38, 0, -2.4]]) {
    add(S.nub(0.08, 0.008, 0.035, { sx: 0.2, ridge: 0 }), 'leaf', compose({ t: [x, y, z], r: [0, a, 0.5], order: 'YXZ' }));
  }
  return s.model(parts);
}


