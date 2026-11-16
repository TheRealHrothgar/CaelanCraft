// Caelancraft — the art-direction pilot's models (PURE: typed arrays, no three, no DOM). Shown by gallery.html next
// to today's models; nothing in the game uses them yet. See docs/DESIGN-characters.md.
//
// The chosen look, A: HEX-FACETED (pass 2). Limbs, torsos and animal bodies are tapered HEXAGONAL columns with flat
// facets (the honeycomb's own cross-section); heads are faceted lofts — a broad flat face plane, cheeks, a jaw tapering
// to the chin, a fuller cranium — with the face painted on the front plane; hair is a shell over the crown and layered,
// swept LOCKS (tapered faceted ribbons); plants are branches carrying whorls of hexagonal LEAF CARDS; hands and shoes
// are chamfered boxes; noses, ears and snouts are wedges and hex pieces.
// A model is { geo, image, tris, texels, atlas: [w, h] }: one merged geometry in its own frame (metres; a figure
// stands on its feet at the origin and faces −Z; the first-person hand is in CAMERA space), one RGBA atlas (sRGB
// bytes, row 0 at the top, a DataTexture with flipY off) and its budgets. Static poses only: the pilot is about the
// look; a migration would keep today's joints and hang these parts from them.
import {
  loft, prism, pyramid, chamferBox, wedge, transform, merge, atlasUV, compose, alongSegment, mul, translation, rotation, scaling, identity,
  triangleCount, wrapU,
} from './modelKit.js';
import { Atlas, Painter, paintFace, mix, shade, fbm, hash2, makeRng } from './paintKit.js';
import { avatarById, AVATAR_IDS } from './avatars.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./paintKit.js').Rect} Rect */
/** @typedef {{ geo: Geo, image: import('./paintKit.js').Img, tris: number, texels: number, atlas: [number, number], tool?: Float64Array }} PilotModel */

/**
 * @typedef {Object} Style  the shape language
 * @property {'hex'} id
 * @property {string} label
 * @property {number} sides     the n-gon of limbs, torsos, bodies
 * @property {boolean} smooth   their side normals blended round the column (false: flat facets)
 * @property {number} bevel     a chamfered box's chamfer, a share of its smallest side
 * @property {boolean} boxSmooth  a chamfered box's bevels blended into its faces
 */

/** The style's rules (pass 1 also tried 'soft', octagons with smoothed normals; the user chose this one). */
export const STYLES = Object.freeze({
  hex: Object.freeze(/** @type {Style} */ ({ id: 'hex', label: 'A: Hex-faceted', sides: 6, smooth: false, bevel: 0.16, boxSmooth: false })),
});

/** Texels per metre: bodies, heads (the face is what is read first), animals, plants. Today's avatars are 32. */
export const DENSITY = Object.freeze({ body: 96, head: 200, animal: 80, plant: 128 });

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
  wrap(key, w, h, side, { cap = [8, 8], top, bottom } = {}) {
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
  return {
    /** a column of the style's n-gon through rings (limbs, torsos, bodies) */
    col: (rx, rz, rings, o = {}) => loft({ sides: o.sides ?? st.sides, rx, rz, rings, smooth: st.smooth, caps: o.caps ?? true, phase: o.phase }),
    /** a chamfered box, centred */
    block: (w, h, d, o = {}) => chamferBox({
      w, h, d, c: (o.bevel ?? st.bevel) * Math.min(w, h, d), cb: (o.bevelBottom ?? o.bevel ?? st.bevel) * Math.min(w, h, d), smooth: st.boxSmooth, top: o.top,
    }),
    /** a feature on its base, rising `h` (an ear tip, a thumb, a snout's ridge): a wedge */
    nub: (w, h, d, o = {}) => wedge({ w, h, d, ridge: o.ridge ?? 0, sx: o.sx ?? 0.6 }),
    /** a point: a horn, a tail tip */
    spike: (rx, rz, h, o = {}) => pyramid({ sides: o.sides ?? 6, rx, rz, h, apex: o.apex }),
    /** a puff (wool): a low dome of the style's n-gon */
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
// Heads: a faceted loft, not a box — a broad flat face plane in front, cheeks, a jaw tapering to the chin, a fuller
// cranium behind; the face painted on the front plane and the cheeks, ears and a nose wedge on it
// ---------------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
/** The head's corners (round from the back): the face plane 150°–210°, a cheek facet either side, the sides, the back. */
export const HEAD_CORNERS = Object.freeze([30, 84, 122, 150, 210, 238, 276, 330].map((d) => d * DEG));
/** A child's head, chin to crown: [height share, width, depth, forward shift (m)] per ring. */
const KID_HEAD = Object.freeze([
  [0, 0.42, 0.5, -0.04], [0.135, 0.72, 0.78, -0.022], [0.32, 0.94, 0.93, -0.006], [0.54, 1, 0.97, 0],
  [0.73, 1.01, 1, 0.004], [0.865, 1, 1.04, 0.016], [0.96, 0.8, 0.86, 0.022], [1, 0.45, 0.5, 0.02],
]);
/** The walker's: a narrow jaw, sunken cheeks, a heavy brow standing out over the eyes, a long skull. */
const ZOMBIE_HEAD = Object.freeze([
  [0, 0.44, 0.5, -0.03], [0.13, 0.64, 0.74, -0.018], [0.32, 0.8, 0.88, -0.004], [0.5, 0.97, 0.95, 0],
  [0.6, 1.0, 1.03, -0.016], [0.72, 0.98, 0.99, 0], [0.87, 0.95, 1.03, 0.012], [0.96, 0.72, 0.78, 0.016], [1, 0.42, 0.46, 0.014],
]);

/**
 * @typedef {Object} HeadDims  metres; the head is built from its chin (y 0) up
 * @property {number} y      the chin, over the feet
 * @property {number} h
 * @property {number} rx     half its width
 * @property {number} rz     half its depth
 * @property {number} eyeAt  the eyes' height, a share of h
 * @property {number} eyeX   each eye's middle from the middle of the face
 * @property {number} eyeW   an eye's width
 * @property {number} mouthAt
 * @property {number} noseAt the middle of the nose
 */

/** The head loft. @param {HeadDims} H @param {ReadonlyArray<ReadonlyArray<number>>} shape */
function headGeo(H, shape) {
  return loft({ corners: [...HEAD_CORNERS], rx: H.rx, rz: H.rz, rings: shape.map(([t, sx, sz, dz]) => ({ y: t * H.h, sx, sz, dz })) });
}

/** Where the front plane is: its depth (a share of rz) at the eyes. */
const FRONT = Math.abs(Math.cos(150 * DEG));

/**
 * Paint a head's strip: `skin` fills it, then the face goes on the front plane and the cheeks (paintKit.paintFace),
 * placed in metres so it lands on the facets that face forward.
 * @param {Skin} s @param {string} key @param {HeadDims} H
 * @param {(p: Painter) => void} skin @param {import('./paintKit.js').FaceStyle} face
 */
function headSkin(s, key, H, skin, face) {
  const o = { corners: [...HEAD_CORNERS], rx: H.rx, rz: H.rz };
  const per = wrapU(o, 0).perimeter;
  s.wrap(key, Math.round(per * DENSITY.head), Math.round(H.h * DENSITY.head), (p) => {
    skin(p);
    // the face's own rectangle: 52° either side of straight ahead
    const u0 = wrapU(o, (180 - 52) * DEG).u;
    const u1 = wrapU(o, (180 + 52) * DEG).u;
    const x0 = Math.round(u0 * p.w);
    const fw = Math.round(u1 * p.w) - x0;
    const fp = new Painter(p.img, [p.ox + x0, p.oy, fw, p.h], p.seed + 3);
    const a = Math.atan2(H.eyeX, H.rz * FRONT);
    const eyeU = (wrapU(o, Math.PI + a).u - wrapU(o, Math.PI - a).u) / (u1 - u0);
    fp.ao({ bottom: 0.18, width: 0.12 });
    paintFace(fp, { ...face, eyeY: 1 - H.eyeAt, eyeGap: eyeU, eyeW: H.eyeW / per / (u1 - u0), mouthY: 1 - H.mouthAt });
    p.ao({ bottom: 0.35, width: 0.1 });
  });
}

/** A head, its ears and its nose, placed by M (the chin). */
function addHead(add, M, H, shape, { head = 'head', skin = 'skin', nose = [0.044, 0.03, 0.062] } = {}) {
  add(headGeo(H, shape), head, M);
  // the nose: a wedge standing out of the face plane, its ridge low (the tip)
  const z = -H.rz * FRONT * 0.95;
  add(wedge({ w: nose[0], h: nose[1], d: nose[2], ridge: -0.45, sx: 0.35 }), skin, mul(M, compose({ t: [0, H.noseAt * H.h, z + 0.004], r: [-Math.PI / 2, 0, 0] })));
  // the ears: half-hexagons on the sides at the eyes' height
  for (const side of [-1, 1]) {
    const ear = loft({ sides: 6, rx: 0.042, rz: 0.03, rings: [{ y: 0 }, { y: 0.024, sx: 0.72, sz: 0.7 }] });
    add(ear, skin, mul(M, compose({ t: [side * (H.rx * 0.97 - 0.006), (H.eyeAt - 0.07) * H.h, 0.012], r: [0, 0, -side * Math.PI / 2] })));
  }
}

// ---------------------------------------------------------------------------------------------------
// Hair: a shell over the crown (the head's own facets, a little larger, tilted back so its rim runs from the hairline
// above the ears to the nape) and LOCKS — tapered faceted ribbons, swept, layered, waving — never a helmet or a crown
// of spikes
// ---------------------------------------------------------------------------------------------------

/**
 * A lock of hair built along +y from its root: `sides` facets round (4: a diamond section, a ridge down its middle; 6
 * for a fat tuft), `w` wide and `t` thick at the root, tapering to a point, swept (dx, dz) along its length — more
 * toward the tip — and swaying `wave` side to side. `point: false` ends it blunt (a curl, a tuft): `keep` of its width.
 */
function lockGeo({ len: L, w, t, sweep = [0, 0], wave = 0, sides = 4, n = 4, keep = 0.25, point = true }) {
  const rings = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const s = k === n && point ? 0 : 1 - (1 - keep) * f ** 1.4;
    rings.push({ y: L * f, sx: s, sz: s, dx: sweep[0] * f * f + wave * Math.sin(f * Math.PI * 2.2), dz: sweep[1] * f * f });
  }
  return loft({ sides, rx: w / 2, rz: t / 2, rings, phase: 0, caps: { top: !point, bottom: true } });
}

/**
 * Locks placed in the head's frame: each [root, toward, len, w, t, sweepX, sweepZ, wave?] — the root on the head, the
 * lock laid toward `toward` (a point), its thickness facing `face` (default: out of the back of the head, so a lock
 * lies flat on the skull).
 * @param {(geo: Geo, key: string, M: import('./modelKit.js').Mat4) => void} add
 * @param {import('./modelKit.js').Mat4} head
 * @param {string} key
 * @param {Array<Array<*>>} locks
 * @param {{ sides?: number, n?: number, face?: number[], keep?: number, point?: boolean }} [o]
 */
function addLocks(add, head, key, locks, { sides = 4, n = 4, face = [0, 0, 1], keep, point } = {}) {
  for (const [root, toward, L, w, t, sx = 0, sz = 0, wave = 0] of locks) {
    add(lockGeo({ len: L, w, t, sweep: [sx, sz], wave, sides, n, keep, point }), key, mul(head, seg(root, toward, null, { back: face })));
  }
}

/** The shell over the crown, its rim tilted (front up, back down). */
function hairShell(add, head, H, key, { grow = 0.022, base = 0.68, tilt = 0.38 } = {}) {
  const rest = KID_HEAD.filter(([t]) => t >= 0.73);
  const rings = rest.map(([t, sx, sz, dz], i) => ({ y: (t - 0.73) * H.h + (i === rest.length - 1 ? grow : 0), sx, sz: sz * (1 + 0.02 * i), dz }));
  rings.unshift({ y: -0.03, sx: 0.99, sz: 0.97, dz: 0 });
  const shell = loft({ corners: [...HEAD_CORNERS], rx: H.rx + grow, rz: H.rz + grow, rings });
  add(shell, key, mul(head, compose({ t: [0, base * H.h, 0.006], r: [tilt, 0, 0] })));
}

/** Points on the head (its frame: the chin at the origin) by angle round from the back and height share. */
const onHead = (H, deg, t, out = 0) => {
  const a = deg * DEG;
  return [Math.sin(a) * (H.rx + out), t * H.h, Math.cos(a) * (H.rz + out)];
};

/** Caelan: poofy dirty-blonde — a shell, fat tufts that stick out over the crown, a layered fringe swept to his right. */
function hairPoofy(add, head, H) {
  hairShell(add, head, H, 'hair', { grow: 0.024, base: 0.66, tilt: 0.42 });
  const top = H.h;
  // the nape: fat locks hanging from under the shell
  addLocks(add, head, 'hair', [-0.1, -0.035, 0.035, 0.1].map((x, i) => [[x, 0.62 * top, 0.15], [x * 1.25, 0.32 * top, 0.2], 0.12, 0.075, 0.04, 0, 0.02 * (i % 2 ? 1 : -1)]), { sides: 6 });
  // tufts: blunt, fat hex curls springing out round the crown and curling over (two rings of them, and one on top)
  const tufts = [];
  for (let k = 0; k < 7; k++) tufts.push([k * (360 / 7) + 15, 0.93, 0.085, 0.42]);
  for (let k = 0; k < 4; k++) tufts.push([k * 90 + 50, 1.0, 0.08, 0.75]);
  tufts.push([180, 1.04, 0.085, 1.4]);
  tufts.forEach(([deg, t, w, rise], i) => {
    const root = onHead(H, deg, t, -0.035);
    const a = deg * DEG;
    const out = [root[0] + Math.sin(a), root[1] + rise, root[2] + Math.cos(a)];
    addLocks(add, head, 'hair', [[root, out, 0.06 + 0.01 * (i % 3), w, w * 0.8, 0.012 * Math.sin(i * 2.1), -0.03]], { sides: 6, n: 3, keep: 0.55, point: false, face: [0, 1, 0] });
  });
  // the fringe: overlapping locks from the hairline lying on the forehead, swept to his right (the model's +x),
  // lengths uneven so their tips never make a row of teeth
  const fringe = [[-0.12, 0.06, 0.03], [-0.07, 0.095, 0.045], [-0.02, 0.075, 0.05], [0.03, 0.1, 0.05], [0.08, 0.07, 0.04], [0.12, 0.05, 0.03]]
    .map(([x, l, sw], k) => [[x, (0.87 + 0.02 * (k % 2)) * top, -H.rz * 0.84], [x + sw, (0.87 - l / top) * top, -H.rz * 0.97], l + 0.02, 0.07, 0.018, 0.02, -0.012]);
  addLocks(add, head, 'hair', fringe, { keep: 0.45 });
  // over the ears, short locks swept back
  for (const side of [-1, 1]) {
    addLocks(add, head, 'hair', [0, 1].map((k) => [onHead(H, 180 - side * (72 + k * 22), 0.8, -0.004), onHead(H, 180 - side * (80 + k * 24), 0.55, 0.03), 0.075, 0.06, 0.02, 0, 0.012]), { face: [side, 0, 0] });
  }
}

/** Brayden: silky auburn, swept to one side from a parting — long layered locks over the forehead, smooth sides. */
function hairSilky(add, head, H) {
  hairShell(add, head, H, 'hair', { grow: 0.017, base: 0.66, tilt: 0.4 });
  const top = H.h;
  // the sweep: long locks from a parting on his right (−x) across the brow to his left, in three layers
  const sweep = [];
  for (let k = 0; k < 7; k++) {
    const z = -H.rz * (0.15 + 0.11 * k);
    const root = [-0.06 + 0.004 * k, (1.0 - 0.01 * k) * top, z];
    const toward = [0.16, (0.74 - 0.008 * k) * top, -H.rz * 1.02];
    sweep.push([root, toward, 0.2 - 0.008 * k, 0.07, 0.02, -0.01, -0.02]);
  }
  addLocks(add, head, 'hair', sweep, { face: [0, 1, 0.4], n: 5, keep: 0.35 });
  // the short side, combed back above the parting
  addLocks(add, head, 'hair', [0, 1, 2].map((k) => [[-0.08 - 0.02 * k, 0.98 * top, -0.06 + 0.08 * k], onHead(H, 180 + 70, 0.72, 0.03), 0.13, 0.07, 0.018, 0, 0.01]), { face: [-1, 0.4, 0] });
  // smooth sides falling over the tops of the ears, and the nape
  for (const side of [-1, 1]) {
    addLocks(add, head, 'hair', [0, 1, 2].map((k) => [onHead(H, 180 - side * (78 + 22 * k), 0.84, -0.005), onHead(H, 180 - side * (84 + 24 * k), 0.5, 0.02), 0.11, 0.07, 0.018, 0, 0.008]), { face: [side, 0, 0] });
  }
  addLocks(add, head, 'hair', [-0.09, -0.03, 0.03, 0.09].map((x) => [[x, 0.66 * top, H.rz * 0.92], [x, 0.36 * top, H.rz + 0.03], 0.11, 0.08, 0.02, 0, 0.01]));
}

/** Annabelle: golden, long and wavy — a side-swept fringe, locks framing her face to her shoulders, waves down her back. */
function hairLongWavy(add, head, H) {
  hairShell(add, head, H, 'hair', { grow: 0.026, base: 0.66, tilt: 0.36 });
  const top = H.h;
  // the fringe, swept to one side
  addLocks(add, head, 'hair', [0, 1, 2].map((k) => [[0.07 - 0.035 * k, (0.95 - 0.02 * k) * top, -H.rz * (0.72 + 0.06 * k)], [-0.15 + 0.03 * k, (0.7 + 0.03 * k) * top, -H.rz * 1.0], 0.15 - 0.015 * k, 0.095, 0.02, 0.012, -0.018]), { n: 5, keep: 0.5 });
  // framing her face: from the temples, past the cheeks, waving down to the shoulders
  for (const side of [-1, 1]) {
    addLocks(add, head, 'hair', [0, 1].map((k) => [onHead(H, 180 - side * (112 + 14 * k), 0.82, -0.01), onHead(H, 180 - side * (104 + 16 * k), -0.4, 0.04), 0.32 + 0.03 * k, 0.07, 0.026, 0, 0.03, 0.012]), { face: [side, 0, 0.3], n: 6, keep: 0.4 });
  }
  // down her back: a fan of long waving locks in two layers, following her back outward
  const back = [];
  for (let k = 0; k < 7; k++) {
    const a = 180 - (-150 + k * 50);
    const root = onHead(H, a, 0.78, -0.012);
    const tip = [root[0] * 1.6, -0.75 * top - 0.03 * (k % 2), H.rz + 0.08];
    back.push([root, tip, 0.5 + 0.03 * (k % 3), 0.085, 0.032, 0, 0.05, 0.016 * (k % 2 ? 1 : -1)]);
  }
  for (let k = 0; k < 4; k++) {
    const x = -0.09 + k * 0.06;
    back.push([[x, 0.6 * top, H.rz * 1.02], [x * 1.4, -0.85 * top, H.rz + 0.12], 0.5, 0.08, 0.03, 0, 0.06, 0.014 * (k % 2 ? -1 : 1)]);
  }
  addLocks(add, head, 'hair', back, { n: 6, keep: 0.45 });
}

const HAIRS = { poofy: hairPoofy, silky: hairSilky, longWavy: hairLongWavy };

/** The hair's picture: strands running along a lock (darker at the root), each style its own way. */
function paintHair(s, style, ramp) {
  s.plain('hair', 64, 64, (p) => {
    if (style === 'longWavy') {
      p.fill(ramp[2]);
      for (let x = -4; x < 70; x += 2.2) {
        const pts = [];
        for (let y = -2; y <= 66; y += 4) pts.push([x + 2.2 * Math.sin(y / 9 + x * 0.3), y]);
        p.polyline(pts, 0.8, hash2(Math.round(x * 10), 1, 4) < 0.5 ? ramp[1] : ramp[3], 0.75);
      }
      p.glow(32, 22, 40, ramp[0], 0.45, 7);
    } else if (style === 'silky') {
      p.hair(ramp, { dir: [0, 1], sheen: 0.32, strand: 3.5 });
      for (let x = 2; x < 64; x += 4) p.line(x, 0, x + 1, 64, 0.45, ramp[3], 0.5);
    } else {
      p.hair(ramp, { dir: [0.15, 1], sheen: 0.32, strand: 2.6 });
      const rnd = makeRng(41);
      for (let i = 0; i < 40; i++) {
        const x = rnd() * 64;
        const y = rnd() * 64;
        p.arc(x, y, 2.2 + rnd() * 1.5, Math.PI * 1.1, Math.PI * 1.9, 0.5, ramp[0], 0.5);
        p.arc(x, y + 0.8, 2.2 + rnd() * 1.5, Math.PI * 0.15, Math.PI * 0.85, 0.5, ramp[3], 0.45);
      }
    }
    p.ao({ bottom: 0.45, width: 0.35 });
    p.shadeV(1.12, 1.0);
  });
}

// ---------------------------------------------------------------------------------------------------
// The kids (avatars.js): Caelan, Brayden and Annabelle — their palettes and outfits from AVATARS, their builds here
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} KidBuild  metres, the model facing −Z, its feet at the origin
 * @property {number} legX
 * @property {number} ankle
 * @property {{ rx: number, rz: number, len: number }} leg
 * @property {{ y0: number, y1: number, rx: number, rz: number }} hips
 * @property {{ y0: number, h: number, rx: number, rz: number }} torso
 * @property {{ y0: number, y1: number, r: number }} neck
 * @property {HeadDims} head
 * @property {number[]} shoulder
 * @property {number[]} elbow
 * @property {number[]} wrist
 * @property {{ rx: number, rz: number }} upper
 * @property {{ rx: number, rz: number }} fore
 * @property {number[]} shoe     w, h, d
 * @property {number} sleeve     the share of the upper arm the sleeve covers (1: the whole of it)
 * @property {number} [cuffAt]   a long sleeve pushed up: its cuff, a share of the forearm from the wrist
 * @property {number} [puff]     a short sleeve standing out this much (×)
 * @property {{ y0: number, y1: number, r0: number, r1: number }} [skirt]  a dress: its skirt, waist (y0) to hem (y1)
 * @property {number} [socks]    a share of the leg the socks cover
 */

/** @type {Readonly<Record<string, KidBuild>>} */
export const KIDS = Object.freeze({
  caelan: {
    legX: 0.092, ankle: 0.08, leg: { rx: 0.085, rz: 0.088, len: 0.65 }, hips: { y0: 0.63, y1: 0.85, rx: 0.176, rz: 0.114 },
    torso: { y0: 0.79, h: 0.365, rx: 0.184, rz: 0.118 }, neck: { y0: 1.1, y1: 1.235, r: 0.064 },
    head: { y: 1.215, h: 0.37, rx: 0.172, rz: 0.172, eyeAt: 0.52, eyeX: 0.058, eyeW: 0.054, mouthAt: 0.215, noseAt: 0.37 },
    shoulder: [0.222, 1.095, 0.005], elbow: [0.252, 0.845, 0.028], wrist: [0.268, 0.625, -0.03],
    upper: { rx: 0.067, rz: 0.064 }, fore: { rx: 0.066, rz: 0.06 }, shoe: [0.118, 0.09, 0.228], sleeve: 1, cuffAt: 0.45,
  },
  brayden: {
    legX: 0.084, ankle: 0.08, leg: { rx: 0.077, rz: 0.08, len: 0.83 }, hips: { y0: 0.82, y1: 1.03, rx: 0.158, rz: 0.104 },
    torso: { y0: 0.97, h: 0.39, rx: 0.166, rz: 0.106 }, neck: { y0: 1.32, y1: 1.45, r: 0.056 },
    head: { y: 1.43, h: 0.345, rx: 0.158, rz: 0.162, eyeAt: 0.52, eyeX: 0.054, eyeW: 0.05, mouthAt: 0.22, noseAt: 0.37 },
    shoulder: [0.2, 1.32, 0.005], elbow: [0.224, 1.035, 0.03], wrist: [0.238, 0.775, -0.02],
    upper: { rx: 0.058, rz: 0.056 }, fore: { rx: 0.058, rz: 0.053 }, shoe: [0.11, 0.085, 0.235], sleeve: 0.5, puff: 1.14,
  },
  annabelle: {
    legX: 0.098, ankle: 0.075, leg: { rx: 0.088, rz: 0.09, len: 0.7 }, hips: { y0: 0.68, y1: 0.9, rx: 0.19, rz: 0.125 },
    torso: { y0: 0.82, h: 0.4, rx: 0.196, rz: 0.128 }, neck: { y0: 1.18, y1: 1.31, r: 0.064 },
    head: { y: 1.29, h: 0.37, rx: 0.174, rz: 0.176, eyeAt: 0.52, eyeX: 0.059, eyeW: 0.056, mouthAt: 0.215, noseAt: 0.37 },
    shoulder: [0.236, 1.185, 0.005], elbow: [0.264, 0.92, 0.03], wrist: [0.28, 0.69, -0.03],
    upper: { rx: 0.07, rz: 0.066 }, fore: { rx: 0.067, rz: 0.06 }, shoe: [0.115, 0.075, 0.215], sleeve: 0.42, puff: 1.42,
    skirt: { y0: 0.9, y1: 0.5, r0: 0.205, r1: 0.31 }, socks: 0.42,
  },
});

const legRings = (L) => [{ y: 0, sx: 0.74 }, { y: 0.31 * L, sx: 0.87 }, { y: 0.45 * L, sx: 0.82 }, { y: 0.74 * L, sx: 0.97 }, { y: L, sx: 1 }];
const torsoRings = (h) => [{ y: 0, sx: 0.97, sz: 0.98 }, { y: 0.27 * h, sx: 0.92, sz: 0.94 }, { y: 0.71 * h, sx: 1, sz: 1.03 }, { y: 0.9 * h, sx: 0.98, sz: 0.98 }, { y: h, sx: 0.74, sz: 0.78 }];
const foreRings = (L) => [{ y: 0, sx: 0.66, sz: 0.66 }, { y: L * 0.55, sx: 0.8 }, { y: L, sx: 0.85 }];

/** Paint a kid's atlas (shared by the model and, for Caelan, the first-person hand). @param {string} id */
function paintKid(id) {
  const def = avatarById(id);
  const K = KIDS[def.id];
  const P = def.palette;
  const O = def.outfit;
  const D = DENSITY.body;
  const skinR = P.skin;
  const top = O.top;
  const s = new Skin(256, 256, 7 + AVATAR_IDS.indexOf(def.id) * 11);
  headSkin(s, 'head', K.head, (p) => p.skin(skinR).shadeV(1.02, 1.04), {
    skin: skinR, eyes: P.eyes, brows: P.brows, mouth: P.mouth, blush: P.blush, lashes: !!P.lashes, freckles: def.id === 'caelan',
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
  // the arms: the sleeve on the upper arm (from the shoulder, the strip's bottom rows), then skin; Caelan's long sleeve
  // pushed up to a cuff on the forearm
  const uw = Math.round(perimeter(K.upper.rx, K.upper.rz) * D);
  const uh = Math.round(len(K.shoulder, K.elbow) * D);
  s.wrap('upperArm', uw, uh, (p) => {
    p.skin(skinR).shadeV(1.0, 0.94);
    const y0 = Math.round(uh * (1 - K.sleeve));
    for (let y = y0; y < uh; y++) for (let x = 0; x < uw; x++) p.px(x, y, mix(top[1], top[2], 0.1 + 0.2 * fbm(x / 5, y / 4, 3)), 1);
    if (K.sleeve < 1) p.ao({ top: 0.25, width: 0.4 });
  });
  s.wrap('sleeve', Math.round(uw * (K.puff ?? 1.2)), Math.round(uh * K.sleeve), (p) => {
    p.cloth(top, { fold: 1.2 });
    p.hem(1, 3, [top[0], O.kind === 'dress' ? O.trim : top[1], top[2]], { stitchColor: O.trim });
    if (O.kind === 'dress') p.line(-1, 1.5, p.w + 1, 1.5, 1.4, O.trim, 1);
    p.shadeV(0.92, 1.06);
  }, { cap: [16, 16], top: (p) => p.fill(top[2]) });
  const fw = Math.round(perimeter(K.fore.rx * 0.85, K.fore.rz * 0.85) * D);
  const fh = Math.round(len(K.elbow, K.wrist) * D);
  s.wrap('foreArm', fw, fh, (p) => {
    p.skin(skinR).shadeV(1.0, 0.93).ao({ top: 0.2, width: 0.5 });
    if (K.cuffAt) {
      const cuffRow = Math.round(fh * (1 - K.cuffAt));
      for (let y = 0; y < cuffRow; y++) for (let x = 0; x < fw; x++) p.px(x, y, mix(top[1], top[2], 0.15 + 0.2 * fbm(x / 5, y / 4, 3)), 1);
    }
  }, { top: (p) => p.cloth(top), bottom: (p) => p.skin(skinR) });
  s.wrap('cuff', fw + 2, 6, (p) => {
    p.knit([top[0], mix(top[0], top[1], 0.5), top[2]], { cell: 3 });
    p.line(-1, 1, fw + 3, 1, 0.6, O.trim, 0.9);
    p.shadeV(1.08, 0.86);
  });
  // below: jeans (a belt, a fly, back pockets), khaki trousers, or a dress's skirt over bare legs and white socks
  // (under a skirt the hips are never seen: a small patch of the dress's cloth)
  const jw = O.kind === 'dress' ? 24 : Math.round(perimeter(K.hips.rx, K.hips.rz) * D);
  const jh = O.kind === 'dress' ? 12 : Math.round((K.hips.y1 - K.hips.y0) * D);
  const bottom = O.bottom ?? top;
  const lw = Math.round(perimeter(K.leg.rx, K.leg.rz) * D);
  const lh = Math.round(K.leg.len * D);
  const fabric = (p, ramp) => (def.id === 'caelan' ? p.denim(ramp) : p.cloth(ramp, { fold: 1.1 }));
  s.wrap('hips', jw, jh, (p) => {
    fabric(p, bottom);
    if (O.kind === 'dress') return;
    const belt = def.id === 'caelan' ? 0x6b4a2e : 0x4a3424;
    p.fill((x, y) => (y < 5 ? shade(belt, 0.92 + 0.14 * hash2(x, y, 5)) : p.get(x, y)));
    p.line(-1, 5.3, jw + 1, 5.3, 0.5, 0x3e2a1a, 0.8);
    p.ellipse(jw / 2, 2.5, 3.2, 2.4, 0xd6c48a, 1).ellipse(jw / 2, 2.5, 1.8, 1.1, belt, 1);
    for (const u of [0.12, 0.36, 0.64, 0.88]) p.line(jw * u, 0, jw * u, 5.5, 0.6, bottom[2], 0.9);
    p.line(jw / 2, 6, jw / 2, jh, 0.45, bottom[2], 0.8);
    for (const u of [0.25, 0.75]) p.seam(jw * u, 6, jw * u, jh, bottom);
    p.ao({ bottom: 0.3, width: 0.3 });
  });
  s.wrap('leg', lw, lh, (p) => {
    if (O.kind === 'dress') {
      p.skin(skinR).shadeV(1.02, 0.95);
      const sock = Math.round(lh * (1 - (K.socks ?? 0.4)));
      for (let y = sock; y < lh; y++) for (let x = 0; x < lw; x++) p.px(x, y, shade(O.socks ?? 0xffffff, x % 3 === 0 ? 0.9 : 1), 1);
      p.line(-1, sock + 2, lw + 1, sock + 2, 0.5, shade(O.socks ?? 0xffffff, 0.8), 0.8);
      p.ao({ top: 0.45, width: 0.2 });
      return;
    }
    fabric(p, bottom);
    for (const u of [0.25, 0.75]) p.seam(lw * u, 0, lw * u, lh, bottom);
    if (def.id === 'caelan') p.glow(lw * 0.5, lh * 0.55, lw * 0.18, bottom[0], 0.35, lh * 0.1);
    else p.line(lw * 0.5, 0, lw * 0.5, lh, 0.5, bottom[2], 0.5);
    p.shadeV(0.86, 1.02).ao({ top: 0.35, bottom: 0.15, width: 0.12 });
  });
  s.wrap('legCuff', lw + 4, 6, (p) => {
    const ramp = [shade(bottom[0], 1.1), bottom[0], bottom[1]];
    fabric(p, ramp);
    p.stitches(0, 3, lw + 4, 3, def.id === 'caelan' ? 0xd9a25a : shade(bottom[0], 1.2), { a: 0.7 });
    p.shadeV(1.08, 0.84);
  });
  if (K.skirt) {
    const sk = K.skirt;
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
    s.wrap('sash', Math.round(perimeter(T.rx, T.rz) * D) + 4, 8, (p) => p.cloth([0xffffff, O.sash ?? O.trim, shade(O.sash ?? O.trim, 0.85)], { fold: 0.6 }).shadeV(1.05, 0.9));
    s.plain('bow', 16, 16, (p) => p.cloth([0xffffff, O.sash ?? O.trim, shade(O.sash ?? O.trim, 0.8)]).ao({ left: 0.3, right: 0.3, width: 0.3 }));
  }
  // shoes: white sneakers with a red flash; brown leather lace-ups; red shoes with a strap
  const [sw, sh, sd] = K.shoe.map((v) => Math.round(v * 128));
  const [c0, c1, c2] = O.shoes;
  const leather = def.id !== 'caelan';
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
      if (O.kind === 'dress') {
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

/** A kid standing at ease. @param {Style} st @param {string} id @param {Skin} s */
function buildKid(st, id, s) {
  const S = shapes(st);
  const def = avatarById(id);
  const K = KIDS[def.id];
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  const [shw, shh, shd] = K.shoe;
  for (const side of [-1, 1]) {
    const x = side * K.legX;
    add(S.block(shw, shh, shd, { top: { sx: 0.88, sz: 0.8, dz: 0.02 } }), 'shoe', compose({ t: [x * 1.04, shh / 2, -0.036], r: [0, side * -0.06, 0] }));
    add(S.col(K.leg.rx, K.leg.rz, legRings(K.leg.len)), 'leg', translation(x, K.ankle, 0));
    if (!K.skirt) add(S.col(K.leg.rx * 0.8, K.leg.rz * 0.8, [{ y: 0 }, { y: 0.038, sx: 0.98 }], { caps: false }), 'legCuff', translation(x, K.ankle - 0.002, 0));
  }
  add(S.col(K.hips.rx, K.hips.rz, [{ y: 0, sx: 0.96 }, { y: K.hips.y1 - K.hips.y0 }]), 'hips', translation(0, K.hips.y0, 0));
  add(S.col(K.torso.rx, K.torso.rz, torsoRings(K.torso.h)), 'torso', translation(0, K.torso.y0, 0));
  if (K.skirt) {
    // a pleated skirt (twelve facets, flaring), a sash round the waist and its bow at the back
    const sk = K.skirt;
    const h = sk.y0 - sk.y1;
    add(loft({ sides: 12, rx: sk.r1, rz: sk.r1 * 0.85, rings: [{ y: 0 }, { y: h * 0.7, sx: (sk.r0 + (sk.r1 - sk.r0) * 0.25) / sk.r1 }, { y: h, sx: sk.r0 / sk.r1, sz: (sk.r0 * 0.66) / (sk.r1 * 0.85) }] }), 'skirt', translation(0, sk.y1, 0));
    add(S.col(K.torso.rx * 1.0, K.torso.rz * 1.02, [{ y: 0 }, { y: 0.065, sx: 0.98 }], { caps: false }), 'sash', translation(0, K.torso.y0 + 0.02, 0));
    const bow = translation(0, K.torso.y0 + 0.055, K.torso.rz + 0.01);
    for (const side of [-1, 1]) {
      add(wedge({ w: 0.08, h: 0.075, d: 0.02, ridge: 0, sx: 0.35 }), 'bow', mul(bow, compose({ r: [Math.PI / 2, 0, side * 1.25] })));
      add(lockGeo({ len: 0.16, w: 0.045, t: 0.012, sweep: [side * 0.02, 0.01] }), 'bow', mul(bow, seg([0, 0, 0.005], [side * 0.04, -0.15, 0.02])));
    }
    add(S.block(0.03, 0.035, 0.025), 'bow', bow);
  }
  add(S.col(K.neck.r, K.neck.r, [{ y: 0 }, { y: K.neck.y1 - K.neck.y0, sx: 0.95 }], { caps: false }), 'neck', translation(0, K.neck.y0, 0));
  for (const side of [-1, 1]) {
    const sh = [side * K.shoulder[0], K.shoulder[1], K.shoulder[2]];
    const el = [side * K.elbow[0], K.elbow[1], K.elbow[2]];
    const wr = [side * K.wrist[0], K.wrist[1], K.wrist[2]];
    const uL = len(sh, el);
    const shTop = [sh[0], sh[1] + 0.042, sh[2]];
    add(S.col(K.upper.rx, K.upper.rz, [{ y: 0, sx: 0.5, sz: 0.62 }, { y: 0.042, sx: 0.96 }, { y: uL * 0.4, sx: 1 }, { y: uL, sx: 0.88 }]), 'upperArm', seg(shTop, el));
    if (K.puff) {
      const pl = uL * K.sleeve + 0.02;
      add(S.col(K.upper.rx * K.puff, K.upper.rz * K.puff, [{ y: 0, sx: 0.5, sz: 0.6 }, { y: 0.045, sx: 0.98 }, { y: pl * 0.6, sx: 1.04 }, { y: pl, sx: 0.88 }], { caps: { top: true, bottom: false } }), 'sleeve', seg(shTop, el));
    }
    const fL = len(wr, el);
    add(S.col(K.fore.rx, K.fore.rz, foreRings(fL)), 'foreArm', seg(wr, el));
    if (K.cuffAt) add(S.col(K.fore.rx * 0.86, K.fore.rz * 0.92, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }], { caps: false }), 'cuff', seg(wr, el, translation(0, fL * K.cuffAt - 0.017, 0)));
    const hand = compose({ t: [wr[0] + side * 0.002, wr[1], wr[2]], r: [0.08, 0, side * 0.06] });
    add(S.block(0.042, 0.08, 0.08, { top: { sx: 1.1, sz: 1.05 } }), 'hand', mul(hand, translation(0, -0.043, 0)));
    add(S.block(0.036, 0.062, 0.074), 'hand', mul(hand, compose({ t: [-side * 0.005, -0.104, 0.004], r: [0.1, 0, -side * 0.3] })));
    add(S.nub(0.028, 0.055, 0.026, { sx: 0.7, ridge: 0 }), 'hand', mul(hand, compose({ t: [-side * 0.012, -0.032, -0.039], r: [Math.PI, 0, side * 0.35] })));
  }
  const head = translation(0, K.head.y, 0);
  addHead(add, head, K.head, KID_HEAD);
  HAIRS[def.hair.style](add, head, K.head);
  return s.model(parts);
}

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
 * @param {'hex'} [style]
 * @param {number} [swing]
 * @returns {PilotModel}
 */
export function buildHand(style = 'hex', swing = 0, { frame = 'camera' } = {}) {
  const st = STYLES[style];
  if (!st) throw new RangeError(`no style ${style}`);
  const S = shapes(st);
  const s = paintKid('caelan');
  const C = KIDS.caelan;
  const { arm, hand } = frame === 'hand' ? { arm: identity(), hand: identity() } : fpHandFrame(swing);
  const parts = [];
  const add = (geo, key, m) => parts.push(s.place(geo, key, mul(hand, m)));
  const addArm = (geo, key, m) => parts.push(s.place(geo, key, mul(arm, m)));
  // the forearm from the wrist back to the elbow, its sleeve pushed up to a cuff
  const wrist = [0.004, 0, 0.045];
  const elbow = [0.004, 0, 0.045 + 0.235];
  const fL = len(wrist, elbow);
  addArm(S.col(C.fore.rx * 0.95, C.fore.rz * 0.95, foreRings(fL)), 'foreArm', seg(wrist, elbow, null, { back: [1, 0, 0] }));
  addArm(S.col(C.fore.rx * 0.82, C.fore.rz * 0.88, [{ y: 0, sx: 1 }, { y: 0.034, sx: 1.02 }], { caps: false }), 'cuff',
    seg(wrist, elbow, translation(0, fL * (C.cuffAt ?? 0.45) - 0.017, 0), { back: [1, 0, 0] }));
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
export const PILOT_MODELS = Object.freeze(['caelan', 'brayden', 'annabelle', 'zombie', 'sheep', 'pig', 'honeyberry', 'sapling', 'honeyberry_far']);

/**
 * One pilot model.
 * @param {string} name  PILOT_MODELS
 * @param {'hex'} [style]
 * @returns {PilotModel}
 */
export function buildPilot(name, style = 'hex') {
  const st = STYLES[style];
  if (!st) throw new RangeError(`no style ${style}`);
  switch (name) {
    case 'caelan':
    case 'brayden':
    case 'annabelle': return buildKid(st, name, paintKid(name));
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

/** Leaf pictures: three tints of one leaf (a base darker than its tip, a midrib, paired side veins, darker edges). */
function paintLeaves(s, ramp, prefix) {
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
  // the far bush: the same leaves with berries among them (the level of detail past ~16 m)
  s.plain('far', 96, 64, (p) => {
    p.leaves(B.leaves, { size: 12, density: 1.3 }).shadeV(1.15, 0.8);
    const rnd = makeRng(77);
    for (let i = 0; i < 14; i++) {
      const x = 6 + rnd() * 84;
      const y = 18 + rnd() * 40;
      for (let k = 0; k < 3; k++) p.ellipse(x + k * 2.5 - 2.5, y + (k % 2) * 2, 1.5, 2, B.berry[1], 1).ellipse(x + k * 2.5 - 3, y + (k % 2) * 2 - 0.8, 0.6, 0.6, B.berry[0], 1);
    }
  });
  s.wrap('bark', 32, 64, (p) => p.bark(B.bark).ao({ bottom: 0.4, width: 0.3 }), { top: (p) => p.bark(B.bark) });
  s.plain('berry', 16, 16, (p) => {
    p.fill(B.berry[1]);
    p.glow(6, 5, 6, B.berry[0], 0.8);
    p.glow(10, 11, 7, B.berry[3], 0.5);
    p.mottle(0.06, 2);
  });
  return s;
}

/** A leaf card: a flat hexagon `len` long and `wid` wide, pointed at both ends — only its two faces (8 triangles). */
function leafCard(len, wid) {
  const g = prism({ sides: 6, rx: wid / 2, rz: len / 2, h: 0.004, phase: 0 });
  const keep = [];
  for (let t = 0; t < g.index.length; t += 3) if (g.groups[g.index[t]] !== 0) keep.push(g.index[t], g.index[t + 1], g.index[t + 2]);
  // its length along +y from its stalk, its faces toward ±z
  return transform({ ...g, index: new Uint32Array(keep) }, mul(translation(0, len / 2, 0), rotation(0, -Math.PI / 2)));
}

/**
 * A whorl: `n` leaves springing from `at` round the stem, tilted `tilt` up from level (negative: drooping), the first
 * at `yaw`; `keys` picks each leaf's picture in turn.
 */
function whorl(add, at, n, len, wid, tilt, yaw, keys) {
  const card = leafCard(len, wid);
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

/** The honeyberry bush: a short trunk, six branches each with two tiers of leaves, a dark core, berries. @param {Style} st @param {Skin} s */
function buildHoneyberry(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(S.col(0.036, 0.034, [{ y: 0, sx: 1.15 }, { y: 0.13, sx: 0.85 }], { caps: { top: false, bottom: true } }), 'bark', identity());
  // a small dark core: the shadowed inside of the bush, seen through the gaps between the leaves
  add(loft({ sides: 6, rx: 0.12, rz: 0.11, rings: [{ y: 0, sx: 0.5 }, { y: 0.07, sx: 1 }, { y: 0.17, sx: 0.8 }, { y: 0.22, sx: 0.35 }] }), 'core', translation(0, 0.12, 0));
  const leaves = ['leaf0', 'leaf1', 'leaf2'];
  const tips = [];
  for (let k = 0; k < 5; k++) {
    const a = k * 1.257 + 0.3;
    tips.push([Math.cos(a) * 0.24, 0.25 + 0.05 * Math.sin(k * 2.1), Math.sin(a) * 0.24, a]);
  }
  tips.push([0.02, 0.44, -0.01, 0.8]);
  const root = [0, 0.12, 0];
  tips.forEach(([x, y, z, a], i) => {
    const tip = [x, y, z];
    twig(S, add, root, tip, 0.014);
    // three tiers up each branch: a drooping skirt low down, a level ring, an upturned crown at the tip
    const at = (f) => [x * f, root[1] + (y - root[1]) * f, z * f];
    whorl(add, at(0.35), 4, 0.15, 0.08, -0.45, a + 0.8, leaves);
    whorl(add, at(0.68), 5, 0.16, 0.085, -0.05, a + 0.4, leaves);
    whorl(add, tip, 6, 0.17, 0.09, 0.32, a, leaves);
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

/** The honeyberry bush past ~16 m: the core grown to the bush's size, painted with leaves and berries, ringed by eight leaves. */
function buildHoneyberryFar(st, s) {
  const S = shapes(st);
  const parts = [];
  const add = (geo, key, M) => parts.push(s.place(geo, key, M));
  add(loft({ sides: 6, rx: 0.27, rz: 0.25, rings: [{ y: 0, sx: 0.45 }, { y: 0.14, sx: 1 }, { y: 0.32, sx: 0.85 }, { y: 0.42, sx: 0.35 }] }), 'far', translation(0, 0.06, 0));
  whorl(add, [0, 0.2, 0], 8, 0.15, 0.08, 0.15, 0.2, ['leaf0', 'leaf1', 'leaf2']);
  void S;
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
