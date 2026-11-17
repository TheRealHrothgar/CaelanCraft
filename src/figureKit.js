// Caelancraft — the figure kit: what every faceted FIGURE is made of (PURE: typed arrays, no three, no DOM). See
// src/CONTRACTS.md §91 and docs/DESIGN-characters.md.
//
// The look is A, HEX-FACETED: limbs, torsos and bodies are tapered HEXAGONAL columns with flat facets (the honeycomb's
// own cross-section); heads are faceted lofts — a broad flat face plane, cheeks, a jaw tapering to the chin, a fuller
// cranium — with the face painted on the front plane; hair is a mass or a scalp cap over the crown with CLUMPS (swept,
// faceted ribbons) lying on it; hands and shoes are chamfered boxes; noses and ears are wedges and hex pieces.
// modelKit.js makes the solids, paintKit.js paints the pictures; here are the pieces figures share:
//   - Skin: one model's 256² atlas — rectangles asked for by name (a strip round a column and its caps, a box's six
//     faces, one plain picture), packed tallest first, painted once, and the parts' uvs moved onto them;
//   - shapes(style): the style's columns, chamfered blocks, nubs, spikes and puffs;
//   - heads: the faceted head loft (HEAD_CORNERS, KID_HEAD), its painted face (headSkin), its nose and ears (addHead);
//   - hair: a mass or a cap laid off the head (hairMass, hairline, CAP_YAWS, CAP_RINGS), clumps lying on it (clump),
//     locks and a receding shell (lockGeo, addLocks, hairShell);
//   - little matrices (seg, rotateAbout).
// avatarModel.js builds the avatars from these; pilotModels.js (the art pilot) its zombie, animals and plants.
import {
  loft, pyramid, chamferBox, wedge, transform, merge, atlasUV, mul, translation, compose, alongSegment, triangleCount, wrapU,
  ringLoft, sweep, basePolygon,
} from './modelKit.js';
import { Atlas, Painter, paintFace, shade } from './paintKit.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./modelKit.js').Mat4} Mat4 */
/** @typedef {import('./paintKit.js').Rect} Rect */
/**
 * A built figure (the pilot's form): one merged geometry, its atlas and its budgets.
 * @typedef {{ geo: Geo, image: import('./paintKit.js').Img, tris: number, texels: number, atlas: [number, number],
 *   tool?: Float64Array, hairTris?: number, hair?: string }} PilotModel
 */

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
export const perimeter = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

// ---------------------------------------------------------------------------------------------------
// Skins: the rectangles of one model's atlas, each painted once, and the parts mapped onto them
// ---------------------------------------------------------------------------------------------------

export class Skin {
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
export function shapes(st) {
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
export const seg = (a, b, extra, o) => (extra ? mul(alongSegment(a, b, o), extra) : alongSegment(a, b, o));
export const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

// ---------------------------------------------------------------------------------------------------
// Heads: a faceted loft, not a box — a broad flat face plane in front, cheeks, a jaw tapering to the chin, a fuller
// cranium behind; the face painted on the front plane and the cheeks, ears and a nose wedge on it
// ---------------------------------------------------------------------------------------------------

export const DEG = Math.PI / 180;
/** The head's corners (round from the back): the face plane 150°–210°, a cheek facet either side, the sides, the back. */
export const HEAD_CORNERS = Object.freeze([30, 84, 122, 150, 210, 238, 276, 330].map((d) => d * DEG));
/** A child's head, chin to crown: [height share, width, depth, forward shift (m)] per ring. */
export const KID_HEAD = Object.freeze([
  [0, 0.42, 0.5, -0.04], [0.135, 0.72, 0.78, -0.022], [0.32, 0.94, 0.93, -0.006], [0.54, 1, 0.97, 0],
  [0.73, 1.01, 1, 0.004], [0.865, 1, 1.04, 0.016], [0.96, 0.8, 0.86, 0.022], [1, 0.45, 0.5, 0.02],
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
 * @property {ReadonlyArray<ReadonlyArray<number>>} [shape]  its ring profile (avatars.js; default KID_HEAD)
 */

/** The head loft. @param {HeadDims} H @param {ReadonlyArray<ReadonlyArray<number>>} shape */
export function headGeo(H, shape) {
  return loft({ corners: [...HEAD_CORNERS], rx: H.rx, rz: H.rz, rings: shape.map(([t, sx, sz, dz]) => ({ y: t * H.h, sx, sz, dz })) });
}

/** Where the front plane is: its depth (a share of rz) at the eyes. */
export const FRONT = Math.abs(Math.cos(150 * DEG));

/**
 * Paint a head's strip: `skin` fills it, then the face goes on the front plane and the cheeks (paintKit.paintFace),
 * placed in metres so it lands on the facets that face forward.
 * @param {Skin} s @param {string} key @param {HeadDims} H
 * @param {(p: Painter) => void} skin @param {import('./paintKit.js').FaceStyle} face
 */
export function headSkin(s, key, H, skin, face) {
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
export function addHead(add, M, H, shape, { head = 'head', skin = 'skin', nose = [0.044, 0.03, 0.062] } = {}) {
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
export function lockGeo({ len: L, w, t, sweep = [0, 0], wave = 0, sides = 4, n = 4, keep = 0.25, point = true }) {
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
export function addLocks(add, head, key, locks, { sides = 4, n = 4, face = [0, 0, 1], keep, point } = {}) {
  for (const [root, toward, L, w, t, sx = 0, sz = 0, wave = 0] of locks) {
    add(lockGeo({ len: L, w, t, sweep: [sx, sz], wave, sides, n, keep, point }), key, mul(head, seg(root, toward, null, { back: face })));
  }
}

/** The shell over the crown, its rim tilted (front up, back down). */
export function hairShell(add, head, H, key, { grow = 0.022, base = 0.68, tilt = 0.38 } = {}) {
  const rest = KID_HEAD.filter(([t]) => t >= 0.73);
  const rings = rest.map(([t, sx, sz, dz], i) => ({ y: (t - 0.73) * H.h + (i === rest.length - 1 ? grow : 0), sx, sz: sz * (1 + 0.02 * i), dz }));
  rings.unshift({ y: -0.03, sx: 0.99, sz: 0.97, dz: 0 });
  const shell = loft({ corners: [...HEAD_CORNERS], rx: H.rx + grow, rz: H.rz + grow, rings });
  add(shell, key, mul(head, compose({ t: [0, base * H.h, 0.006], r: [tilt, 0, 0] })));
}

/** Points on the head (its frame: the chin at the origin) by angle round from the back and height share. */
export const onHead = (H, deg, t, out = 0) => {
  const a = deg * DEG;
  return [Math.sin(a) * (H.rx + out), t * H.h, Math.cos(a) * (H.rz + out)];
};

// ---- hair, pass 3: SILHOUETTE FIRST. Caelan's is one poofy faceted MASS (no locks: locks read as dreadlocks);
// Brayden's and Annabelle's are a scalp cap that hugs the head plus a few big CLUMPS (swept lofts) flowing one way.

/** The head's cross-section at height share t: [width, depth, forward shift] (its rings, interpolated). */
export function headRingAt(shape, t) {
  if (t <= shape[0][0]) return shape[0].slice(1);
  for (let k = 1; k < shape.length; k++) {
    if (t <= shape[k][0]) {
      const a = shape[k - 1];
      const b = shape[k];
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      return [1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * f);
    }
  }
  return shape[shape.length - 1].slice(1);
}

/** Where hair is measured from: a point in the middle of the cranium (the head's frame, the chin at the origin). */
export const hairCentre = (H) => [0, 0.55 * H.h, 0.012];

/** A unit direction from the cranium: `yaw` degrees round from the back (+z) toward +x (180: straight ahead), `pitch` up. */
export function hairDir(yaw, pitch) {
  const y = yaw * DEG;
  const p = pitch * DEG;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
}

/**
 * The head's surface seen from the cranium's middle: how far it is along a direction (found by halving, against the
 * head loft itself — so hair laid off it never lets the skull show).
 */
export function headRadius(H, shape, dir) {
  const poly = basePolygon({ corners: [...HEAD_CORNERS], rx: H.rx, rz: H.rz }).pts;
  const c = hairCentre(H);
  const inside = (r) => {
    const x = c[0] + dir[0] * r;
    const y = c[1] + dir[1] * r;
    const z = c[2] + dir[2] * r;
    const t = y / H.h;
    if (t < 0 || t > 1) return false;
    const [sx, sz, dz] = headRingAt(shape, t);
    let sign = 0;
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j];
      const b = poly[(j + 1) % poly.length];
      const cr = (b.x * sx - a.x * sx) * (z - dz - a.z * sz) - (b.z * sz - a.z * sz) * (x - a.x * sx);
      if (Math.abs(cr) < 1e-12) continue;
      if (sign === 0) sign = Math.sign(cr);
      else if (Math.sign(cr) !== sign) return false;
    }
    return true;
  };
  let lo = 0;
  let hi = 0.6;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (inside(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** A point `out` metres off the head's surface along hairDir(yaw, pitch). */
export function onSkull(H, shape, yaw, pitch, out) {
  const d = hairDir(yaw, pitch);
  const r = headRadius(H, shape, d) + out;
  const c = hairCentre(H);
  return [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r];
}

/**
 * A hair MASS or a scalp cap: rings round the cranium from a hairline (`rim(yaw, j)`: its pitch at each of the
 * `around` points — high over the brow, above the ears, low at the nape) up to the crown, each point `off(yaw, pitch,
 * s)` metres off the head (s 0 at the hairline .. 1 at the crown). Flat facets; closed. `yaws` places the points round
 * (a thin cap puts them over the head's own corners, so no ridge of the head pokes through between them).
 * @param {HeadDims} H @param {ReadonlyArray<ReadonlyArray<number>>} shape
 * @param {{ around?: number, rim: (yaw: number, j: number) => number, off: (yaw: number, pitch: number, s: number, j: number) => number,
 *   rings?: ReadonlyArray<number>, yaws?: number[] }} o
 */
export function hairMass(H, shape, { around = 20, rim, off, rings = [0, 0.12, 0.3, 0.5, 0.7, 0.86, 1], yaws: given }) {
  const yaws = given ?? [...Array(around).keys()].map((j) => (j * 360) / around);
  let last = [0];
  return ringLoft({
    rings: rings.map((s) => {
      // the crown: one point, as high as the ring under it stands on average (never a peak or a dent)
      if (s >= 1) return yaws.map(() => onSkull(H, shape, 0, 90, last.reduce((a, b) => a + b, 0) / last.length + 0.004));
      const offs = yaws.map((yaw, j) => off(yaw, rim(yaw, j) + (90 - rim(yaw, j)) * s ** 0.85, s, j));
      last = offs;
      return yaws.map((yaw, j) => {
        const r0 = rim(yaw, j);
        return onSkull(H, shape, yaw, r0 + (90 - r0) * s ** 0.85, offs[j]);
      });
    }),
  });
}

/** A smooth hairline round the head: [yaw, pitch] knots on the right side (mirrored), eased between. */
export function hairline(knots) {
  return (yaw) => {
    const y = yaw > 180 ? 360 - yaw : yaw;
    for (let k = 1; k < knots.length; k++) {
      if (y <= knots[k][0]) {
        const [y0, p0] = knots[k - 1];
        const [y1, p1] = knots[k];
        const f = (y - y0) / (y1 - y0);
        return p0 + (p1 - p0) * (f * f * (3 - 2 * f));
      }
    }
    return knots[knots.length - 1][1];
  };
}

/** A cap's points round: over each of the head's corners and halfway between them, from the back (the seam). */
export const CAP_YAWS = (() => {
  const c = HEAD_CORNERS.map((a) => (a * 180) / Math.PI).sort((a, b) => a - b);
  const out = [0];
  c.forEach((d, i) => {
    out.push(d);
    const next = i + 1 < c.length ? c[i + 1] : 360;
    if (next < 360) out.push((d + next) / 2);
  });
  return out;
})();

/** A cap's rings, hairline to crown: close enough together that no edge of the head shows between them (hairGaps). */
export const CAP_RINGS = Object.freeze([0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 1]);

/** Gentle lumps over a mass: −1..1, smooth round the head and up it. */
export const lumps = (yaw, s, seed = 0) => {
  const y = yaw * DEG;
  return 0.55 * Math.sin(3 * y + 0.7 + seed + 2 * s) + 0.3 * Math.sin(5 * y + 2.1 - 3 * s + seed * 2) + 0.15 * Math.sin(7 * y - 1 + 5 * s);
};
/** 1 straight ahead, 0 at the sides and behind. */
export const frontness = (yaw) => Math.max(0, -Math.cos(yaw * DEG));

/**
 * A scalp cap's shape: its hairline (pitch by yaw) and how far it stands off the head (s 0 at the hairline .. 1 at
 * the crown). capOff gives that distance at any point, so clumps can lie ON the cap.
 * @typedef {{ rim: (yaw: number, j?: number) => number, off: (yaw: number, pitch: number, s: number, j?: number) => number }} Cap
 */
/** @param {Cap} cap */
export const capOff = (cap, yaw, pitch) => {
  const r0 = cap.rim(yaw, 0);
  const s = Math.min(1, Math.max(0, (pitch - r0) / (90 - r0))) ** (1 / 0.85);
  return cap.off(yaw, pitch, s, 0);
};

/**
 * A CLUMP of hair lying on a cap: a flattened hex section swept along a curve through `ctrl` — [yaw, pitch, lift]
 * points (`lift` metres over the cap; the first, the root, just under the cap's surface, its end dark), or
 * ['p', x, y, z] points in the head's frame (below the head) — its thickness facing out from the head (or `up`), its
 * width `w`, narrowing along `profile` to its tip.
 * @param {HeadDims} H @param {ReadonlyArray<ReadonlyArray<number>>} shape @param {Cap} cap @param {Array<Array<*>>} ctrl
 * @param {{ w: number, t?: number, profile: number[], segments?: number, up?: number[]|((c: number[]) => number[]) }} o
 */
export function clump(H, shape, cap, ctrl, { w, t = 0.022, profile, segments, up }) {
  const pts = ctrl.map((c, i) => (c[0] === 'p'
    ? [c[1], c[2], c[3]]
    : onSkull(H, shape, c[0], c[1], capOff(cap, c[0], c[1]) + (i === 0 ? -0.004 : c[2] + t / 2))));
  const cc = hairCentre(H);
  // flat to the head all along it: its thickness faces out from the cranium at every station (or `up`)
  const u = up ?? ((c) => [c[0] - cc[0], c[1] - cc[1], c[2] - cc[2]]);
  const S = segments ?? profile.length - 1;
  return sweep({ points: pts, sides: 6, rx: w / 2, rz: t / 2, up: u, profile, segments: S });
}

/** @param {ArrayLike<number>} v @returns {number[]} */
export const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A rotation of `a` radians about the unit axis n through point p (column-major). */
export function rotateAbout(p, n, a) {
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
