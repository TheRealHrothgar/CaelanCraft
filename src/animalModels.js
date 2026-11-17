// Caelancraft — the animals' and the pig's models (PURE: typed arrays, no three, no DOM). See src/CONTRACTS.md §69.1
// and docs/DESIGN-characters.md (phase 3).
//
// The look is A, HEX-FACETED (figureKit.js): every animal is a handful of tapered HEXAGONAL lofts — a barrel of a body
// whose rings swell at the ribs and the rump and pinch at the waist, legs that taper from the thigh through a hock to a
// flared hoof or paw, a neck and a faceted head loft with a ridge down the nose and a broad muzzle cap — with wedges,
// pyramids and swept lofts for ears, horns, antlers, manes, tails, beaks, fins and the turkey's fan. Every part is a
// closed solid wound outward, its uvs on ONE shared painted atlas (ANIMAL_ATLAS square, all eleven kinds: the ten of
// animals.js and the pig), painted here in code: short hair laid in strokes along the body, a lit back and a shaded
// belly, patches and spots, curly wool and puffs, fur with a grizzled stripe, feathers with pale fringes, scales.
//
// A kind is cut into PARTS, each one geometry in MODEL space (metres; the animal stands on its feet at the origin and
// faces −Z, x to its right), so animalRenderer.js / pigRenderer.js instance them: a trunk (its body, tail and anything
// that rides on it: an udder, a saddle), a head group (the neck, the head, ears, horns, antlers, a mane) that turns about
// the rig's head pivot, one leg (hanging from its hip at the origin: y 0 down to −legH; drawn as is for a hind leg and
// turned half round for a front one, so a hock bends back and a knee forward), two wings (a bird's, along +x from the
// shoulder), a tame animal's tag (a collar, a bell, a ribbon: hung on the head group) and a snare's loop (on a hind leg).
// `variants` names each bodyVariant's [trunk, head] parts. Nothing here touches the gameplay sizes: the colliders,
// heights and the pig's head box are animals.js's and pigs.js's.
import { loft, sweep, pyramid, prism, wedge, transform, merge, mul, translation, rotation, compose, triangleCount, wrapU, bounds } from './modelKit.js';
import { mix, shade, fbm, hash2, makeRng } from './paintKit.js';
import { perimeter, Skin, seg, len } from './figureKit.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./modelKit.js').Mat4} Mat4 */
/** @typedef {import('./paintKit.js').Painter} Painter */
/** @typedef {import('./paintKit.js').Img} Img */

/** The shared atlas's side (pixels): every kind's pictures on one image, one texture, one material. */
export const ANIMAL_ATLAS = 1024;
/** Texels per metre: trunks, heads (the face is what is read first), legs and small parts. */
export const ANIMAL_DENSITY = Object.freeze({ body: 112, head: 190, limb: 150 });
/** Every kind drawn from this atlas: animals.js's ten and the pig. */
export const MODEL_KINDS = Object.freeze(['cow', 'sheep', 'horse', 'wolf', 'deer', 'rabbit', 'pheasant', 'turkey', 'bear', 'fish', 'pig']);

/**
 * @typedef {Object} AnimalRig  where the parts hang (model space, metres) and how they move — the look's joints
 * @property {number} legH   the hip's height (a leg reaches from it to the ground)
 * @property {number} legW   the leg's width at the hip (the snare's loop is sized by it)
 * @property {number} legX   the hips ±x
 * @property {number[]} legZ the hips' z: front (−z) and back (+z); a bird's one pair at [0]
 * @property {number} swing  the stride (rad)
 * @property {boolean} [turn]  a front leg is the hind leg turned half round (its hock a knee); false: drawn as is (a paw
 *   or a trotter with a front to it)
 * @property {number} [legs] 2 a bird, 0 a fish (4 when absent)
 * @property {number} [hop]  how high the stride bobs (a rabbit bounds)
 * @property {number} [wiggle]  a fish's body swings with its tail
 * @property {{ pivot: number[], len: number, chord: number, flap: number }} [wing]  a bird's, drawn only in the air
 * @property {{ y: number, z: number, angle: number, arms: number, swipe: number }} [rear]  the bear's rear-up
 * @property {{ pivot: number[], level: number, graze: number, alert: number }} [head]  the head group turns about `pivot`;
 *   `level` the share of a rear's pitch it takes back; `graze` the pitch (rad, negative: down) while it grazes, `alert`
 *   while it stares (§100)
 * @property {number[]} [tag]  where a tame one's tag hangs (on the head group; documentation and tests)
 * @property {{ mid: number, up: number }} [lie]  a stranded animal (§100: a fish whose water is gone) lies on its side:
 *   rolled a quarter turn about its length round its middle `mid` above the feet, which then sits `up` above the ground
 */

/** The joints of every kind (the old box models' joints, kept: hips, stride, rear-up, wings). */
export const ANIMAL_RIGS = Object.freeze({
  cow: Object.freeze({ turn: true, legH: 0.55, legW: 0.17, legX: 0.19, legZ: [-0.4, 0.4], swing: 0.45, head: { pivot: [0, 0.96, -0.42], level: 0, graze: -1.15, alert: 0.28 } }),
  sheep: Object.freeze({ turn: true, legH: 0.42, legW: 0.1, legX: 0.15, legZ: [-0.27, 0.27], swing: 0.55, head: { pivot: [0, 0.76, -0.34], level: 0, graze: -1.2, alert: 0.3 } }),
  horse: Object.freeze({ turn: true, legH: 0.9, legW: 0.14, legX: 0.16, legZ: [-0.48, 0.48], swing: 0.6, head: { pivot: [0, 1.28, -0.5], level: 0, graze: -1.25, alert: 0.22 } }),
  wolf: Object.freeze({ turn: true, legH: 0.4, legW: 0.1, legX: 0.11, legZ: [-0.27, 0.27], swing: 0.7, head: { pivot: [0, 0.66, -0.34], level: 0, graze: -0.45, alert: 0.3 } }),
  deer: Object.freeze({ turn: true, legH: 0.68, legW: 0.1, legX: 0.11, legZ: [-0.34, 0.34], swing: 0.7, head: { pivot: [0, 0.98, -0.36], level: 0, graze: -1.3, alert: 0.25 } }),
  rabbit: Object.freeze({ legH: 0.12, legW: 0.07, legX: 0.065, legZ: [-0.08, 0.12], swing: 0.9, hop: 0.1, head: { pivot: [0, 0.24, -0.07], level: 0, graze: -0.5, alert: 0.3 } }),
  pheasant: Object.freeze({
    legs: 2, legH: 0.16, legW: 0.035, legX: 0.05, legZ: [0.02], swing: 0.9,
    wing: { pivot: [0.08, 0.31, 0], len: 0.36, chord: 0.22, flap: 0.95 }, head: { pivot: [0, 0.33, -0.12], level: 0, graze: -0.9, alert: 0.25 },
  }),
  turkey: Object.freeze({
    legs: 2, legH: 0.3, legW: 0.05, legX: 0.08, legZ: [0.02], swing: 0.8,
    wing: { pivot: [0.15, 0.6, 0.02], len: 0.42, chord: 0.3, flap: 0.8 }, head: { pivot: [0, 0.62, -0.18], level: 0, graze: -0.85, alert: 0.25 },
  }),
  bear: Object.freeze({
    legH: 0.6, legW: 0.26, legX: 0.25, legZ: [-0.5, 0.5], swing: 0.5,
    rear: { y: 0.75, z: 0.48, angle: 1.2, arms: 0.55, swipe: 1.1 },
    head: { pivot: [0, 1.1, -0.66], level: 0.9, graze: -0.35, alert: 0.15 },
  }),
  fish: Object.freeze({ legs: 0, legH: 0, legW: 0, legX: 0, legZ: [0], swing: 0, wiggle: 0.3, lie: { mid: 0.1, up: 0.062 } }),
  // the pig only nods to root: its head must stay inside PIG_HEAD_BOX (pigs.js), the gameplay box a click on its head hits
  pig: Object.freeze({ legH: 0.3, legW: 0.13, legX: 0.16, legZ: [-0.26, 0.32], swing: 0.6, head: { pivot: [0, 0.6, -0.34], level: 0, graze: -0.1, alert: 0.2 } }),
});

const D = ANIMAL_DENSITY;
const PI = Math.PI;
const DEG = PI / 180;

// ---------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------

/** A trunk's placement: the loft's +y toward −z (ahead) from `zRear`, its +z up, at height y. */
const ahead = (y, zRear) => mul(translation(0, y, zRear), rotation(0, -PI / 2));

/**
 * A trunk: a hexagonal loft lying along the animal from its rump (t 0, at zRear) to its chest (t 1), rings [t, sx, sz,
 * dy (m, up)]. Its strip runs round from the spine (u 0) through the right flank (0.25), the belly (0.5) and the left
 * flank (0.75); its rows from the chest (row 0) to the rump; its bottom cap is the rump, seen from behind upside down.
 * @param {{ rx: number, rz: number, L: number, rings: number[][], phase?: number }} T
 */
function trunkGeo(T) {
  return loft({ sides: 6, rx: T.rx, rz: T.rz, phase: T.phase, rings: T.rings.map(([t, sx, sz = sx, dy = 0]) => ({ y: t * T.L, sx, sz, dz: dy })) });
}

/**
 * A leg hanging from its hip (y 0) to the ground (−H), reaching `ext` up into the body: rings [t (0 the hip .. 1 the
 * ground), scale, dz (m, + toward the back)] — a hind leg's hock bends back (the front legs are drawn turned half round).
 * Its strip's rows run from the top (row 0) to the hoof; its bottom cap is the sole.
 * @param {{ H: number, r: number, rz?: number, rings: number[][], ext?: number }} o
 */
function legGeo({ H, r, rz = r, rings, ext = 0.1 }) {
  const rs = [...rings].sort((a, b) => b[0] - a[0]);
  const top = rs[rs.length - 1];
  return loft({
    sides: 6, rx: r, rz, phase: 0, caps: { top: false, bottom: true },
    rings: [...rs.map(([t, s, dz = 0]) => ({ y: -t * H, sx: s, dz })), { y: ext, sx: top[1], dz: top[2] ?? 0 }],
  });
}

/** A loft along a segment (seg: its +z as near `up` as it can be): rings [t, sx, sz?, dz?, dx?] of `L`. */
function along(a, b, rx, rz, rings, { up = [0, 1, 0], caps = /** @type {boolean|{top?: boolean, bottom?: boolean}} */ (true), phase = 0 } = {}) {
  const L = len(a, b);
  const g = loft({ sides: 6, rx, rz, phase, caps, rings: rings.map(([t, sx, sz = sx, dz = 0, dx = 0]) => ({ y: t * L, sx, sz, dz, dx })) });
  return transform(g, seg(a, b, null, { back: up }));
}

/** A flat card (an elongated hexagon `len` × `wid`, pointed at both ends: only its two faces) along +y from its root. */
function card(L, W, sides = 6) {
  const g = prism({ sides, rx: W / 2, rz: L / 2, h: 0.006, phase: 0 });
  const keep = [];
  for (let t = 0; t < g.index.length; t += 3) if (g.groups[g.index[t]] !== 0) keep.push(g.index[t], g.index[t + 1], g.index[t + 2]);
  // both faces read the same way up (the far end of the picture at the card's tip)
  const uvs = new Float32Array(g.uvs);
  for (let v = 0; v < g.groups.length; v++) if (g.groups[v] === 2) uvs[v * 2 + 1] = 1 - uvs[v * 2 + 1];
  return transform({ ...g, uvs, index: new Uint32Array(keep) }, mul(translation(0, L / 2, 0), rotation(0, -PI / 2)));
}

/** A card laid from a toward b, its faces toward ±`face`. */
const cardAt = (a, b, W, face = [0, 0, 1], sides = 6) => transform(card(len(a, b), W, sides), seg(a, b, null, { back: face }));

/** A swept horn, tail or lock through `pts` (sides, radius r, `profile` along it). */
const swept = (pts, r, profile, { sides = 5, rz = r, segments = Math.max(2, pts.length * 2 - 2), up = /** @type {number[]} */ ([0, 1, 0]) } = {}) =>
  sweep({ points: pts, sides, rx: r, rz, profile, segments, up, phase: 0 });

// ---------------------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------------------

/** Fractal noise that wraps round a strip `w` wide (the spine's seam leaves no line). */
function wrapN(x, y, w, sx, sy, seed, oct = 3) {
  const t = x / w;
  return fbm(x / sx, y / sy, seed, oct) * (1 - t) + fbm((x - w) / sx, y / sy, seed, oct) * t;
}

/** How much a strip column faces up: 1 at the spine (u 0), −1 at the belly (u 0.5). */
const upness = (x, w) => Math.cos((2 * PI * (x + 0.5)) / w);
const smooth01 = (e0, e1, v) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * A coat over a body strip: the mid tone mottled (seamless round the strip), short hair strokes along `dir` (down the
 * strip: toward the rump), a paler `belly` blended in round the belly (or the coat shaded there), the back lit and the
 * ends shaded where the legs and the neck meet it.
 * @param {Painter} p @param {number[]} ramp [light, mid, dark]
 * @param {{ dir?: number[], len?: number, density?: number, belly?: number|null, bellyWidth?: number, light?: number,
 *   dark?: number, mottle?: number, scale?: number, strokes?: number[], seamless?: boolean }} [o]
 */
function coat(p, ramp, { dir = [0, 1], len: L = 4, density = 0.6, belly = null, bellyWidth = 0.2, light = 0.1, dark = 0.24, mottle = 0.5, scale = 10, strokes, seamless = true } = {}) {
  const w = p.w;
  const s = p.seed;
  p.fill((x, y) => {
    const n = seamless ? wrapN(x, y, w, scale, scale * 1.7, s) : fbm(x / scale, y / (scale * 1.7), s);
    let c = mix(ramp[1], n > 0.5 ? ramp[0] : ramp[2], Math.min(1, Math.abs(n - 0.5) * 2 * mottle * 2));
    if (belly !== null) {
      const d = Math.abs((x + 0.5) / w - 0.5);
      const t = 1 - smooth01(bellyWidth * 0.6, bellyWidth * 1.25, d + (hash2(x, y, s) - 0.5) * 0.04);
      if (t > 0) c = mix(c, belly, t);
    }
    return c;
  });
  const rnd = makeRng(s + 11);
  const n = Math.round((p.w * p.h * density) / Math.max(1, L));
  const a0 = Math.atan2(dir[1], dir[0]);
  const lights = strokes ?? [ramp[0], ramp[2]];
  for (let i = 0; i < n; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    const a = a0 + (rnd() - 0.5) * 0.7;
    const l = L * (0.6 + 0.7 * rnd());
    const c = lights[Math.floor(rnd() * lights.length)];
    p.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.45, c, 0.22 + 0.3 * rnd());
  }
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const up = upness(x, w);
      p.tone(x, y, up > 0 ? 1 + light * up : 1 + dark * up * (belly === null ? 1 : 0.4));
    }
  }
  return p;
}

/**
 * Soft irregular patches (a cow's white, a horse's blaze) over a strip: where wrapped noise (plus `bias`) passes `cut`,
 * only where the strip faces up at least `keepUp`.
 * @param {Painter} p @param {number} color
 * @param {{ scale?: number, cut?: number, soft?: number, seed?: number, keepUp?: number, bias?: (x: number, y: number) => number }} [o]
 */
function patches(p, color, o = {}) {
  const { scale = 22, cut = 0.6, soft = 0.04, seed = p.seed + 5, keepUp = -2, bias = () => 0 } = o;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (upness(x, p.w) < keepUp) continue;
      const n = wrapN(x, y, p.w, scale, scale, seed, 4) + bias(x, y);
      const a = smooth01(cut - soft, cut + soft, n);
      if (a > 0) {
        const old = p.get(x, y);
        const k = 0.88 + 0.24 * ((old >> 8) & 255) / 255; // keep a little of the hair's own light and dark
        p.px(x, y, shade(color, Math.min(1.05, k)), a);
      }
    }
  }
  return p;
}

/** Round spots (a fawn's): rows along the back either side of the spine. */
function spots(p, color, { rows = [0.08, 0.15, 0.85, 0.92], r = 2.2, step = 7, seed = p.seed + 9 } = {}) {
  const rnd = makeRng(seed);
  for (const u of rows) {
    for (let y = step * 0.6; y < p.h - step * 0.5; y += step * (0.8 + 0.4 * rnd())) {
      const x = u * p.w + (rnd() - 0.5) * 2.5;
      p.ellipse(x, y, r * (0.8 + 0.4 * rnd()), r * (0.9 + 0.4 * rnd()), color, 0.9);
    }
  }
  return p;
}

/**
 * An animal's eye on a head strip at (cx, cy): a soft dark rim of the coat, a glossy dark eye (or a coloured iris round
 * a pupil), a catchlight, a lid line and (lashes) a flick. r its radius (px).
 * @param {Painter} p @param {number} cx @param {number} cy @param {number} r
 * @param {{ iris?: number, rim?: number, lid?: number, white?: boolean, lashes?: boolean, side?: number, ring?: number }} [o]
 */
function eye(p, cx, cy, r, o = {}) {
  const { iris = 0x2a1c14, rim, lid, white = false, lashes = false, side = 1, ring } = o;
  if (rim !== undefined) p.glow(cx, cy + r * 0.2, r * 2.1, rim, 0.55, r * 1.6);
  if (ring !== undefined) p.ellipse(cx, cy, r * 1.45, r * 1.3, ring, 1);
  if (white) p.ellipse(cx, cy, r * 1.15, r * 0.95, 0xf4efe6, 1);
  p.ellipse(cx, cy, r, r * 0.92, iris === 0x2a1c14 ? iris : shade(iris, 0.6), 1);
  if (iris !== 0x2a1c14) {
    p.ellipse(cx, cy + r * 0.05, r * 0.82, r * 0.78, iris, 1);
    p.ellipse(cx, cy + r * 0.05, r * 0.42, r * 0.5, 0x120c08, 1);
  } else {
    p.ellipse(cx, cy + r * 0.25, r * 0.7, r * 0.5, 0x4a3628, 0.55);
  }
  p.ellipse(cx - side * r * 0.32, cy - r * 0.35, Math.max(0.6, r * 0.28), Math.max(0.6, r * 0.26), 0xffffff, 0.95);
  const l = lid ?? 0x1a120e;
  p.arc(cx, cy + r * 0.15, r * 1.08, PI * 1.1, PI * 1.9, Math.max(0.4, r * 0.16), l, 0.85, r * 0.95);
  if (lashes) {
    for (let k = 0; k < 3; k++) {
      const a = PI * (1.25 + 0.18 * k);
      const x0 = cx + Math.cos(a) * r * 1.05;
      const y0 = cy + Math.sin(a) * r * 0.95;
      p.line(x0, y0, x0 + Math.cos(a) * r * 0.5, y0 + Math.sin(a) * r * 0.5, 0.35, l, 0.8);
    }
  }
}

/**
 * The u (0..1) of a loft's strip at θ degrees round from its top (+z) toward its right (+x).
 * @param {{ sides?: number, rx: number, rz: number, phase?: number }} o
 */
const uAt = (o, deg) => wrapU({ sides: o.sides ?? 6, rx: o.rx, rz: o.rz, phase: o.phase ?? 0 }, deg * DEG).u;

/** Both eyes on a head strip: θ degrees round from the top, at row `row`. */
function eyes(p, o, deg, row, r, opts = {}) {
  for (const side of [1, -1]) {
    const u = uAt(o, side > 0 ? deg : 360 - deg);
    eye(p, u * p.w, row, r, { ...opts, side });
  }
}

/** Shade a strip toward its end rows (where it meets the body or the ground). */
const endShade = (p, top = 0, bottom = 0, width = 0.2) => p.ao({ top, bottom, width });

/** A hoof (or a paw) painted over a leg strip's last `share` of rows, with a crease above it. */
function hoof(p, color, share, { shine = 0x5a4a40, crease = true } = {}) {
  const y0 = Math.round(p.h * (1 - share));
  for (let y = y0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const t = (y - y0) / Math.max(1, p.h - y0);
      p.px(x, y, shade(color, 0.85 + 0.25 * hash2(x, y, 4) + 0.2 * (1 - t)), 1);
    }
  }
  for (let x = 0; x < p.w; x += 3) p.line(x, y0 + 1, x + 0.5, p.h - 1, 0.35, shine, 0.35);
  if (crease) p.line(-1, y0, p.w + 1, y0, 0.6, shade(color, 0.6), 0.9);
}

/** A strip for a loft of radii (rx, rz) and length L at density d. */
const stripSize = (rx, rz, L, d) => [Math.max(8, Math.round(perimeter(rx, rz) * d)), Math.max(8, Math.round(L * d))];


// ---------------------------------------------------------------------------------------------------
// The kinds. Each kind's paint(s) asks the shared Skin for its pictures (keys `kind.name`); build(s) makes its parts.
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} KindModel
 * @property {Record<string, Geo>} parts      'body', 'alt', 'male', 'young', 'head', 'head-male', 'head-alt', 'legs',
 *   'wings', 'tag', 'tusks'
 * @property {Record<string, Array<string|null>>} variants  bodyVariant ('body', 'alt', 'male', 'maleAlt', 'young') →
 *   [its trunk part, its head part (null: none), its legs part (absent: 'legs')]
 */
/** @typedef {{ paint: (s: Skin) => void, build: (s: Skin) => KindModel }} KindSpec */
/** @typedef {(geo: Geo, key: string, M?: Mat4) => void} Add */

/** Collect placed parts into one geometry. @param {Skin} s */
function collector(s) {
  /** @type {Geo[]} */
  const geos = [];
  /** @type {Add} */
  const add = (geo, key, M) => geos.push(s.place(geo, key, M));
  return { add, done: () => merge(geos) };
}

// ---- the cow and the bull ------------------------------------------------------------------------------------------

const COW = Object.freeze({
  coat: [0xb07a52, 0x8b5a3c, 0x66402a], bull: [0x84553a, 0x6a432d, 0x48301f], white: 0xf6f1e6,
  muzzle: [0xf4cdbd, 0xe6ae9e, 0xb98274], hoof: 0x2e2621, horn: [0xfbf4e4, 0xeadfc6, 0xb6a483], nose: 0x5a3430, ring: [0xf2d58a, 0xd4ae52, 0x8a6a2a],
  trunk: { y: 0.87, zRear: 0.62, L: 1.18, rx: 0.32, rz: 0.31, rings: [[0, 0.56, 0.62, 0.04], [0.06, 0.88, 0.9, 0.03], [0.2, 1, 1, 0.01], [0.42, 1.04, 1.07, -0.02], [0.64, 1.03, 1.05, -0.01], [0.83, 0.97, 1.01, 0.02], [0.94, 0.82, 0.88, 0.03], [1, 0.58, 0.66, 0.03]] },
  bullTrunk: { y: 0.89, zRear: 0.64, L: 1.24, rx: 0.36, rz: 0.33, rings: [[0, 0.56, 0.6, 0.03], [0.06, 0.88, 0.88, 0.02], [0.2, 1, 0.98, 0], [0.42, 1.02, 1.03, -0.02], [0.62, 1.05, 1.06, 0], [0.78, 1.06, 1.14, 0.06], [0.88, 1.0, 1.12, 0.07], [0.96, 0.84, 0.94, 0.05], [1, 0.6, 0.7, 0.04]] },
  head: { rx: 0.165, rz: 0.15, rings: [[0, 0.78, 0.82], [0.12, 1, 1], [0.38, 0.9, 0.94], [0.68, 0.7, 0.8, -0.006], [0.88, 0.8, 0.86, -0.008], [1, 0.72, 0.76, -0.01]] },
  leg: { r: 0.08, rings: [[0, 1.2], [0.42, 0.8, 0.035], [0.84, 0.66, 0.01], [0.9, 0.84], [1, 0.9]] },
});

/** @returns {KindSpec} */
function cowSpec() {
  const C = COW;
  const T = C.trunk;
  const B = C.bullTrunk;
  const H = C.head;
  const R = ANIMAL_RIGS.cow;
  const headO = { rx: H.rx, rz: H.rz };
  /** @param {Painter} p @param {number[]} ramp @param {boolean} bull */
  const hide = (p, ramp, bull) => {
    coat(p, ramp, { len: 4, density: 0.5, mottle: 0.45 });
    patches(p, C.white, { scale: bull ? 18 : 24, cut: bull ? 0.66 : 0.6, keepUp: -0.75 });
    endShade(p, 0.25, 0.15, 0.12);
  };
  /** @param {Painter} p @param {number[]} ramp @param {boolean} bull */
  const face = (p, ramp, bull) => {
    coat(p, ramp, { len: 3, density: 0.55, light: 0.06, dark: 0.12, seamless: true, scale: 7 });
    // a white blaze down the face (the top of the strip: u 0 and 1)
    if (!bull) patches(p, C.white, { scale: 9, cut: 0.42, keepUp: 0.55, bias: (_x, y) => (y / p.h) * -0.15 });
    // the muzzle: pink round the nose end
    for (let y = 0; y < p.h * 0.3; y++) {
      for (let x = 0; x < p.w; x++) p.px(x, y, shade(C.muzzle[1], 0.92 + 0.12 * hash2(x, y, 3)), smooth01(p.h * 0.3, p.h * 0.18, y));
    }
    eyes(p, headO, 74, p.h * 0.8, bull ? 3.8 : 4.4, { rim: ramp[2], lashes: !bull });
    endShade(p, 0, 0.3, 0.15);
  };
  const muzzleCap = (p) => {
    p.fill(C.muzzle[1]).mottle(0.06, 3);
    p.glow(p.w / 2, p.h * 0.4, p.w * 0.45, C.muzzle[0], 0.6, p.h * 0.3);
    for (const sx of [-1, 1]) p.ellipse(p.w / 2 + sx * p.w * 0.2, p.h * 0.45, p.w * 0.07, p.h * 0.11, C.nose, 1, sx * 0.5);
    p.arc(p.w / 2, p.h * 0.62, p.w * 0.3, PI * 0.15, PI * 0.85, 0.7, C.muzzle[2], 0.9, p.h * 0.18);
  };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx * 1.04, T.rz * 1.07, T.L, D.body);
      s.wrap('cow.trunk', tw, th, (p) => hide(p, C.coat, false), { cap: [40, 40], bottom: (p) => { coat(p, C.coat, { seamless: false, len: 3 }); p.glow(p.w / 2, p.h * 0.6, p.w * 0.3, C.coat[2], 0.6); } });
      const [bw, bh] = stripSize(B.rx * 1.06, B.rz * 1.14, B.L, D.body);
      s.wrap('cow.bull', bw, bh, (p) => hide(p, C.bull, true), { cap: [40, 40], bottom: (p) => coat(p, C.bull, { seamless: false, len: 3 }) });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.48, D.head);
      s.wrap('cow.head', hw, hh, (p) => face(p, C.coat, false), { cap: [28, 26], top: muzzleCap });
      s.wrap('cow.headBull', hw, hh, (p) => face(p, C.bull, true), { cap: [28, 26], top: muzzleCap });
      const [nw, nh] = stripSize(0.16, 0.19, 0.42, D.body);
      s.wrap('cow.neck', nw, nh, (p) => { coat(p, C.coat, { len: 3 }); patches(p, C.white, { scale: 14, cut: 0.62, keepUp: -0.6 }); endShade(p, 0, 0.3); });
      s.wrap('cow.neckBull', nw, nh, (p) => { coat(p, C.bull, { len: 3 }); endShade(p, 0, 0.3); });
      const [lw, lh] = stripSize(C.leg.r * 1.2, C.leg.r * 1.2, R.legH + 0.1, D.limb);
      s.wrap('cow.leg', lw, lh, (p) => { coat(p, C.coat, { len: 3, light: 0, dark: 0, seamless: true }); patches(p, C.white, { scale: 6, cut: 0.5, bias: (_x, y) => (y / p.h - 0.6) * 0.6 }); hoof(p, C.hoof, 0.12); endShade(p, 0.35, 0, 0.3); }, { cap: [12, 12], bottom: (p) => p.fill(C.hoof) });
      s.wrap('cow.legBull', lw, lh, (p) => { coat(p, C.bull, { len: 3, light: 0, dark: 0 }); hoof(p, C.hoof, 0.12); endShade(p, 0.35, 0, 0.3); }, { cap: [12, 12], bottom: (p) => p.fill(C.hoof) });
      s.plain('cow.ear', 24, 24, (p) => { coat(p, C.coat, { seamless: false, len: 2 }); p.glow(12, 13, 7, C.muzzle[2], 0.7, 8); });
      s.plain('cow.earBull', 24, 24, (p) => { coat(p, C.bull, { seamless: false, len: 2 }); p.glow(12, 13, 7, C.muzzle[2], 0.5, 8); });
      s.wrap('cow.horn', 14, 28, (p) => { p.fill((x, y) => mix(C.horn[0], C.horn[2], 0.15 + 0.7 * (1 - y / p.h))); for (let y = 2; y < p.h; y += 4) p.line(0, y, p.w, y + 1, 0.4, C.horn[2], 0.3); });
      s.wrap('cow.tail', 12, 40, (p) => { coat(p, C.coat, { seamless: false, len: 2 }); for (let y = 0; y < p.h * 0.32; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(0x2a1e18, 0.9 + 0.3 * hash2(x, y, 2)), 1); });
      s.wrap('cow.udder', 32, 16, (p) => { p.fill(C.muzzle[1]).mottle(0.08, 3); p.shadeV(1.05, 0.85); }, { cap: [16, 16], top: (p) => { p.fill(C.muzzle[1]); for (const [x, y] of [[5, 5], [11, 5], [5, 11], [11, 11]]) p.ellipse(x, y, 1.6, 1.6, C.muzzle[2], 1); } });
      s.wrap('cow.ring', 10, 20, (p) => p.fill((x, y) => mix(C.ring[0], C.ring[2], 0.5 + 0.5 * Math.sin(y * 0.9))));
      s.wrap('cow.collar', 24, 8, (p) => { p.fill(0x5a3a26).mottle(0.1, 3); p.stitches(0, 2, p.w, 2, 0xd8c08a, { a: 0.7 }); p.stitches(0, 6, p.w, 6, 0xd8c08a, { a: 0.7 }); });
      s.wrap('cow.bell', 16, 16, (p) => { p.fill((x, y) => mix(C.ring[0], C.ring[2], y / p.h)); p.line(p.w * 0.3, 2, p.w * 0.3, p.h - 2, 0.8, 0xfff4c8, 0.6); }, { cap: [10, 10], bottom: (p) => { p.fill(C.ring[2]); p.ellipse(5, 5, 2, 2, 0x2a2010, 1); } });
    },
    build(s) {
      /** @param {{ y: number, zRear: number, L: number, rx: number, rz: number, rings: number[][] }} t @param {boolean} bull */
      const trunk = (t, bull) => {
        const c = collector(s);
        c.add(trunkGeo(t), bull ? 'cow.bull' : 'cow.trunk', ahead(t.y, t.zRear));
        // the tail: down the rump, a dark tuft at its end
        const z = t.zRear;
        c.add(swept([[0, t.y + 0.2, z - 0.04], [0, t.y + 0.14, z + 0.04], [0, t.y - 0.12, z + 0.07], [0, t.y - 0.36, z + 0.06]], 0.026, [1, 0.9, 0.8, 0.75, 0.7, 1.7, 0], { sides: 4, segments: 6, up: [1, 0, 0] }), 'cow.tail');
        if (!bull) c.add(loft({ sides: 6, rx: 0.12, rz: 0.1, rings: [{ y: 0, sx: 0.7 }, { y: 0.05, sx: 1 }, { y: 0.11, sx: 0.55 }] }), 'cow.udder', mul(translation(0, 0.62, 0.26), rotation(0, PI)));
        return c.done();
      };
      /** @param {boolean} bull */
      const head = (bull) => {
        const c = collector(s);
        const k = bull ? 1.12 : 1;
        const poll = [0, 1.15, -0.66 - (bull ? 0.04 : 0)];
        const nose = [0, 0.85, -1.05 - (bull ? 0.05 : 0)];
        c.add(along([0, 0.9, -0.36], [0, 1.08, -0.7], 0.15 * k, 0.19 * k, [[0, 1.05, 1.1], [0.55, 0.95, 1], [1, 0.82, 0.86]], { caps: false }), bull ? 'cow.neckBull' : 'cow.neck');
        c.add(along(poll, nose, H.rx * k, H.rz * k, H.rings), bull ? 'cow.headBull' : 'cow.head');
        // ears out to the sides, a little down; horns from the poll
        for (const sd of [-1, 1]) {
          const root = [sd * 0.12 * k, 1.1, -0.7];
          c.add(along(root, [sd * 0.27 * k, 1.06, -0.66], 0.055, 0.016, [[0, 0.55], [0.35, 1], [1, 0.25]], { up: [0, 0.3, -1] }), bull ? 'cow.earBull' : 'cow.ear');
          const hr = bull
            ? [[sd * 0.1, 1.17, -0.67], [sd * 0.24, 1.2, -0.66], [sd * 0.36, 1.25, -0.68], [sd * 0.42, 1.36, -0.72]]
            : [[sd * 0.08, 1.16, -0.69], [sd * 0.15, 1.21, -0.68], [sd * 0.2, 1.28, -0.7]];
          c.add(swept(hr, bull ? 0.04 : 0.03, bull ? [1, 0.9, 0.75, 0.55, 0.38, 0.2, 0] : [1, 0.8, 0.55, 0.3, 0], { sides: 5 }), 'cow.horn');
        }
        if (bull) {
          // a brass ring through the nose
          const ring = [];
          for (let a = 0; a <= 6; a++) ring.push([0, 0.79 + 0.038 * Math.cos((a / 6) * 2 * PI), -1.1 + 0.038 * Math.sin((a / 6) * 2 * PI)]);
          c.add(sweep({ points: ring, sides: 4, rx: 0.01, profile: () => 1, segments: 6, up: [1, 0, 0] }), 'cow.ring');
        }
        return c.done();
      };
      /** @param {boolean} bull */
      const leg = (bull) => s.place(legGeo({ H: R.legH, r: C.leg.r * (bull ? 1.1 : 1), rings: C.leg.rings }), bull ? 'cow.legBull' : 'cow.leg');
      const tag = () => {
        const c = collector(s);
        // a leather collar round the neck and a brass bell under the throat
        c.add(along([0, 0.93, -0.5], [0, 0.97, -0.56], 0.165, 0.2, [[0, 1.08], [1, 1.08]], { caps: false }), 'cow.collar');
        c.add(loft({ sides: 6, rx: 0.04, rings: [{ y: 0, sx: 1 }, { y: 0.05, sx: 0.75 }, { y: 0.07, sx: 0.3 }] }), 'cow.bell', mul(translation(0, 0.69, -0.56), rotation(0, PI)));
        return c.done();
      };
      return {
        parts: { body: trunk(T, false), male: trunk(B, true), head: head(false), 'head-male': head(true), legs: leg(false), 'legs-male': leg(true), tag: tag() },
        variants: { body: ['body', 'head'], male: ['male', 'head-male', 'legs-male'] },
      };
    },
  };
}

// ---- the sheep: the ewe, the ram (curled horns), shorn; the lamb is the ewe drawn small -------------------------------

const SHEEP = Object.freeze({
  wool: [0xfffdf6, 0xf3eee2, 0xd8d0bf], shorn: [0xf4d8c8, 0xe2bfae, 0xbc9584], face: [0x6e655c, 0x4a443e, 0x312d29],
  hoof: 0x2a2420, inner: 0xd2a49c, horn: [0xeee2c4, 0xd6c9a8, 0xa89778],
  fleece: { y: 0.68, zRear: 0.47, L: 0.92, rx: 0.32, rz: 0.31, rings: [[0, 0.48, 0.52, 0], [0.06, 0.8, 0.84, 0.01], [0.15, 0.96, 0.98, 0.02], [0.25, 0.92, 0.93, 0.02], [0.36, 1.0, 1.03, 0.025], [0.48, 0.95, 0.97, 0.025], [0.6, 1.0, 1.03, 0.025], [0.72, 0.94, 0.96, 0.02], [0.83, 0.97, 0.98, 0.025], [0.93, 0.8, 0.86, 0.03], [1, 0.55, 0.6, 0.03]] },
  shornT: { y: 0.645, zRear: 0.42, L: 0.82, rx: 0.23, rz: 0.22, rings: [[0, 0.55, 0.6, 0.02], [0.1, 0.92, 0.92, 0.01], [0.3, 1, 1, 0], [0.6, 0.97, 1.02, -0.005], [0.85, 0.94, 0.98, 0.02], [0.96, 0.72, 0.8, 0.03], [1, 0.5, 0.58, 0.03]] },
  head: { rx: 0.1, rz: 0.115, rings: [[0, 0.8, 0.85], [0.15, 1, 1], [0.5, 0.86, 0.9], [0.82, 0.66, 0.76, -0.006], [1, 0.58, 0.66, -0.008]] },
});

/** @returns {KindSpec} */
function sheepSpec() {
  const SH = SHEEP;
  const F = SH.fleece;
  const T2 = SH.shornT;
  const H = SH.head;
  const R = ANIMAL_RIGS.sheep;
  const headO = { rx: H.rx, rz: H.rz };
  /** wool over a strip: curls, the belly in the fleece's shadow */
  const fleece = (p, r = 3.6) => {
    p.wool(SH.wool, { r });
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const up = upness(x, p.w);
        p.tone(x, y, up > 0 ? 1 + 0.03 * up : 1 + 0.26 * up);
      }
    }
  };
  /** the clipped coat: pale skin under a short stubble, the clipper's rows */
  const stubble = (p) => {
    coat(p, SH.shorn, { len: 2, density: 0.3, light: 0.06, dark: 0.18, mottle: 0.3, scale: 6 });
    const rnd = makeRng(4);
    for (let i = 0; i < p.w * p.h * 0.05; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 1.3, 1.0, SH.wool[1], 0.45);
    for (let y = 3; y < p.h; y += 6) p.line(0, y, p.w, y + 2, 0.5, SH.shorn[2], 0.3);
  };
  return {
    paint(s) {
      const [fw, fh] = stripSize(F.rx, F.rz, F.L, D.body);
      s.wrap('sheep.fleece', fw, fh, (p) => { fleece(p); endShade(p, 0.2, 0.12, 0.1); }, { cap: [36, 36], top: (p) => p.wool(SH.wool, { r: 3 }), bottom: (p) => p.wool(SH.wool, { r: 3 }) });
      const [sw, sh] = stripSize(T2.rx * 1.02, T2.rz * 1.02, T2.L, D.body);
      s.wrap('sheep.shorn', sw, sh, (p) => { stubble(p); endShade(p, 0.2, 0.15, 0.12); }, { cap: [24, 24], bottom: (p) => coat(p, SH.shorn, { seamless: false, len: 2 }) });
      s.plain('sheep.wool', 48, 48, (p) => p.wool(SH.wool, { r: 3.2 }));
      const [nw, nh] = stripSize(0.15, 0.16, 0.3, D.body);
      s.wrap('sheep.neck', nw, nh, (p) => { fleece(p, 3.2); endShade(p, 0, 0.25, 0.15); });
      s.wrap('sheep.neckShorn', nw, nh, (p) => { stubble(p); endShade(p, 0, 0.25, 0.15); });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.34, D.head);
      s.wrap('sheep.head', hw, hh, (p) => {
        coat(p, SH.face, { len: 2.5, density: 0.7, light: 0.08, dark: 0.1, scale: 6 });
        p.glow(p.w * 0.5, p.h * 0.1, p.w * 0.12, SH.face[0], 0.45, p.h * 0.12); // a paler chin
        eyes(p, headO, 80, p.h * 0.66, 4.2, { rim: SH.face[2], iris: 0xb08a3a });
        endShade(p, 0, 0.25, 0.15);
      }, {
        cap: [24, 26],
        top: (p) => {
          p.fill(SH.face[1]).mottle(0.06, 3);
          p.glow(12, 12, 9, mix(SH.face[0], SH.inner, 0.3), 0.8, 8);
          p.ellipse(8.5, 10.5, 1.7, 2.4, 0x1e1916, 1, 0.4).ellipse(15.5, 10.5, 1.7, 2.4, 0x1e1916, 1, -0.4);
          p.polyline([[12, 13.5], [12, 17], [8.5, 19.5]], 0.5, 0x1e1916, 0.9).polyline([[12, 17], [15.5, 19.5]], 0.5, 0x1e1916, 0.9);
        },
      });
      s.plain('sheep.ear', 20, 20, (p) => { coat(p, SH.face, { seamless: false, len: 2 }); p.glow(10, 10, 6, SH.inner, 0.6, 7); });
      const [lw, lh] = stripSize(0.05, 0.05, R.legH + 0.1, D.limb);
      s.wrap('sheep.leg', lw, lh, (p) => {
        coat(p, SH.face, { len: 2, light: 0, dark: 0, scale: 5 });
        p.glow(p.w * 0.5, p.h * 0.55, p.w * 0.5, SH.face[2], 0.35, p.h * 0.06); // the knee
        hoof(p, SH.hoof, 0.11);
      }, { cap: [10, 10], bottom: (p) => p.fill(SH.hoof) });
      s.wrap('sheep.horn', 22, 56, (p) => {
        p.fill((x, y) => mix(SH.horn[0], SH.horn[2], 0.2 + 0.5 * (y / p.h)));
        for (let y = 1; y < p.h; y += 3) p.line(-1, y, p.w + 1, y + 1.5, 0.55, SH.horn[2], 0.55);
      });
      s.wrap('sheep.ribbon', 24, 8, (p) => { p.fill(0x3d7fd0).mottle(0.06, 3); p.line(0, 1.5, p.w, 1.5, 0.5, 0x9cc4f4, 0.8); p.line(0, 6.5, p.w, 6.5, 0.5, 0x1e4c8a, 0.8); });
      s.plain('sheep.bow', 16, 16, (p) => { p.fill(0x3d7fd0); p.glow(8, 6, 7, 0x9cc4f4, 0.5); p.ao({ bottom: 0.4, width: 0.4 }); });
      s.wrap('sheep.bell', 12, 12, (p) => p.fill((x, y) => mix(0xf2d58a, 0x8a6a2a, y / p.h)));
    },
    build(s) {
      const fleeceTrunk = () => {
        const c = collector(s);
        c.add(trunkGeo(F), 'sheep.fleece', ahead(F.y, F.zRear));
        // a woolly stub of a tail
        c.add(swept([[0, 0.8, 0.43], [0, 0.74, 0.52], [0, 0.62, 0.55]], 0.06, [0.85, 1, 0.75, 0.3], { sides: 6, segments: 3, up: [1, 0, 0] }), 'sheep.wool');
        return c.done();
      };
      const shornTrunk = () => {
        const c = collector(s);
        c.add(trunkGeo(T2), 'sheep.shorn', ahead(T2.y, T2.zRear));
        c.add(swept([[0, 0.72, 0.4], [0, 0.66, 0.46], [0, 0.56, 0.47]], 0.035, [0.9, 1, 0.8, 0.5, 0.2], { sides: 6, segments: 4, up: [1, 0, 0] }), 'sheep.shorn');
        return c.done();
      };
      /** @param {boolean} ram @param {boolean} shorn */
      const head = (ram, shorn) => {
        const c = collector(s);
        const poll = [0, 0.86, -0.5];
        const nose = [0, 0.64, -0.75];
        c.add(along([0, 0.66, -0.27], [0, 0.82, -0.5], shorn ? 0.11 : 0.15, shorn ? 0.12 : 0.16, [[0, 1.05], [0.6, 1], [1, 0.82]], { caps: false }), shorn ? 'sheep.neckShorn' : 'sheep.neck');
        c.add(along(poll, nose, H.rx, H.rz, H.rings), 'sheep.head');
        // a woolly tuft on the crown
        c.add(loft({ sides: 6, rx: 0.1, rz: 0.09, caps: { bottom: false }, rings: [{ y: 0, sx: 0.9 }, { y: 0.03, sx: 1 }, { y: 0.06, sx: 0.5 }] }), 'sheep.wool', compose({ t: [0, 0.855, -0.555], r: [-0.72, 0.5, 0] }));
        for (const sd of [-1, 1]) {
          // ears out to the sides, drooping a little
          c.add(wedge({ w: 0.13, h: 0.022, d: 0.055, sx: 0.35 }), 'sheep.ear', compose({ t: [sd * 0.14, 0.83, -0.52], r: [0.1, 0, -sd * 0.35] }));
          if (ram) {
            // the curl: back from the poll, round and down past the ear, its tip forward
            const curl = [[sd * 0.06, 0.91, -0.55], [sd * 0.13, 0.95, -0.47], [sd * 0.2, 0.9, -0.4], [sd * 0.23, 0.8, -0.44], [sd * 0.21, 0.74, -0.53], [sd * 0.17, 0.77, -0.6]];
            c.add(swept(curl, 0.048, [1, 0.93, 0.8, 0.66, 0.52, 0.4, 0.28], { sides: 5, segments: 6, up: [1, 0, 0] }), 'sheep.horn');
          }
        }
        return c.done();
      };
      const tag = () => {
        const c = collector(s);
        c.add(along([0, 0.69, -0.32], [0, 0.73, -0.38], 0.16, 0.17, [[0, 1.06], [1, 1.06]], { caps: false }), 'sheep.ribbon');
        for (const sd of [-1, 1]) c.add(wedge({ w: 0.07, h: 0.05, d: 0.02, sx: 0.3 }), 'sheep.bow', compose({ t: [sd * 0.03, 0.87, -0.3], r: [0, 0, sd * PI / 2] }));
        c.add(loft({ sides: 6, rx: 0.025, rings: [{ y: 0 }, { y: 0.035, sx: 0.6 }] }), 'sheep.bell', mul(translation(0, 0.55, -0.4), rotation(0, PI)));
        return c.done();
      };
      const leg = s.place(legGeo({ H: R.legH, r: 0.045, rings: [[0, 1.3], [0.45, 0.85, 0.025], [0.87, 0.78], [1, 1.0]] }), 'sheep.leg');
      return {
        parts: { body: fleeceTrunk(), alt: shornTrunk(), head: head(false, false), 'head-male': head(true, false), 'head-alt': head(false, true), 'head-maleAlt': head(true, true), legs: leg, tag: tag() },
        variants: { body: ['body', 'head'], alt: ['alt', 'head-alt'], male: ['body', 'head-male'], maleAlt: ['alt', 'head-maleAlt'] },
      };
    },
  };
}

// ---- the horse (a saddle, a blanket and a bridle when tame) ----------------------------------------------------------

const HORSE = Object.freeze({
  coat: [0xc07a44, 0x9c5a2e, 0x713f1e], mane: [0x5a3a24, 0x3a2414, 0x24160c], muzzle: [0x8a5a3e, 0x5e3a26, 0x3e2618], hoof: 0x2a221e,
  sock: 0xf2ece0, saddle: [0x8a5434, 0x6e3e1e, 0x4a2812], blanket: [0x3a78c0, 0x2a5e9c, 0x1c406c], trim: 0xf0c860, strap: 0x3a2214,
  trunk: { y: 1.19, zRear: 0.68, L: 1.32, rx: 0.27, rz: 0.32, rings: [[0, 0.45, 0.55, 0.04], [0.05, 0.8, 0.88, 0.03], [0.15, 0.98, 1.0, 0.02], [0.32, 1, 0.97, 0.01], [0.5, 0.98, 1.02, -0.02], [0.68, 1, 1.07, -0.03], [0.82, 0.98, 1.08, -0.01], [0.93, 0.86, 0.98, 0.03], [1, 0.55, 0.68, 0.03]] },
  head: { rx: 0.13, rz: 0.15, rings: [[0, 0.78, 0.8], [0.12, 1, 1.02], [0.34, 0.86, 0.86], [0.72, 0.66, 0.7, -0.008], [0.9, 0.74, 0.76, -0.01], [1, 0.66, 0.68, -0.012]] },
});

/** @returns {KindSpec} */
function horseSpec() {
  const HO = HORSE;
  const T = HO.trunk;
  const H = HO.head;
  const R = ANIMAL_RIGS.horse;
  const headO = { rx: H.rx, rz: H.rz };
  const poll = [0, 1.99, -0.79];
  const nose = [0, 1.75, -1.24];
  /** @param {Painter} p @param {boolean} bridle */
  const face = (p, bridle) => {
    coat(p, HO.coat, { len: 3, density: 0.55, light: 0.07, dark: 0.12, scale: 7 });
    // the dark muzzle, a white blaze down the nose
    for (let y = 0; y < p.h * 0.3; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(HO.muzzle[1], 0.9 + 0.15 * hash2(x, y, 7)), smooth01(p.h * 0.3, p.h * 0.16, y));
    for (let y = 0; y < p.h; y++) {
      const half = 2.2 + 3.5 * Math.sin(Math.min(1, y / (p.h * 0.8)) * PI) * 0.8;
      for (let x = -Math.ceil(half); x <= Math.ceil(half); x++) {
        const a = smooth01(half + 0.5, half - 0.5, Math.abs(x));
        if (y > p.h * 0.12 && y < p.h * 0.88) p.px((x + p.w) % p.w, y, HO.sock, a);
      }
    }
    eyes(p, headO, 78, p.h * 0.8, 4.4, { rim: HO.coat[2], lashes: true });
    if (bridle) {
      // the headstall: a noseband, a cheek strap up to the poll, a brass ring at the bit
      const nb = p.h * 0.32;
      p.line(-1, nb, p.w + 1, nb, 1.4, HO.strap, 1).line(-1, nb - 1, p.w + 1, nb - 1, 0.4, 0x6a4a30, 0.8);
      for (const deg of [84, 276]) {
        const x = uAt(headO, deg) * p.w;
        p.line(x, nb, x - 2, p.h, 1.3, HO.strap, 1);
        p.ellipse(x, p.h * 0.18, 2.2, 2.2, HO.trim, 1).ellipse(x, p.h * 0.18, 1.1, 1.1, HO.strap, 1);
      }
      p.line(-1, p.h * 0.93, p.w + 1, p.h * 0.93, 1.3, HO.strap, 1);
    }
    endShade(p, 0, 0.25, 0.12);
  };
  const muzzleCap = (p) => {
    p.fill(HO.muzzle[1]).mottle(0.08, 3);
    for (const sx of [-1, 1]) p.ellipse(p.w / 2 + sx * p.w * 0.24, p.h * 0.42, p.w * 0.09, p.h * 0.14, 0x1e140e, 1, sx * 0.4);
    p.arc(p.w / 2, p.h * 0.66, p.w * 0.28, PI * 0.15, PI * 0.85, 0.6, HO.muzzle[2], 0.9, p.h * 0.15);
  };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx, T.rz * 1.02, T.L, D.body);
      s.wrap('horse.trunk', tw, th, (p) => {
        coat(p, HO.coat, { len: 5, density: 0.5, light: 0.12, mottle: 0.35, scale: 14 });
        // a glossy coat: soft light over the quarters and the shoulders on both flanks, darker along the belly
        for (const u of [0.2, 0.8]) for (const v of [0.28, 0.78]) p.glow(u * p.w, v * p.h, p.w * 0.1, HO.coat[0], 0.45, p.h * 0.16);
        endShade(p, 0.2, 0.15, 0.1);
      }, { cap: [36, 36], bottom: (p) => coat(p, HO.coat, { seamless: false }) });
      const [nw, nh] = stripSize(0.14, 0.2, 0.75, D.body);
      s.wrap('horse.neck', nw, nh, (p) => { coat(p, HO.coat, { len: 4, density: 0.5, scale: 9 }); endShade(p, 0, 0.3, 0.15); });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.5, D.head);
      s.wrap('horse.head', hw, hh, (p) => face(p, false), { cap: [26, 26], top: muzzleCap });
      s.wrap('horse.headTack', hw, hh, (p) => face(p, true), { cap: [26, 26], top: muzzleCap });
      const [lw, lh] = stripSize(0.07, 0.07, R.legH + 0.1, D.limb);
      s.wrap('horse.leg', lw, lh, (p) => {
        coat(p, HO.coat, { len: 3, light: 0, dark: 0, scale: 6 });
        // dark lower legs (points), a white sock on the hind ones, black hooves
        for (let y = Math.round(p.h * 0.55); y < p.h; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(HO.mane[1], 0.9 + 0.2 * hash2(x, y, 3)), smooth01(p.h * 0.55, p.h * 0.62, y));
        hoof(p, HO.hoof, 0.1);
        endShade(p, 0.3, 0, 0.25);
      }, { cap: [12, 12], bottom: (p) => p.fill(HO.hoof) });
      s.wrap('horse.mane', 28, 72, (p) => {
        p.hair([0x7a5438, HO.mane[0], HO.mane[1], HO.mane[2]], { dir: [0, 1], sheen: 0.4, strand: 2 });
      });
      s.plain('horse.ear', 18, 18, (p) => { coat(p, HO.coat, { seamless: false, len: 2 }); p.glow(9, 11, 5, HO.mane[2], 0.6, 6); });
      s.wrap('horse.saddle', 48, 48, (p) => {
        p.fill((x, y) => shade(HO.saddle[1], 0.92 + 0.14 * fbm(x / 6, y / 6, 3)));
        p.stitches(2, 3, p.w - 2, 3, 0xe8c890, { a: 0.8 }).stitches(2, p.h - 3, p.w - 2, p.h - 3, 0xe8c890, { a: 0.8 });
        p.glow(p.w / 2, p.h / 2, p.w * 0.4, HO.saddle[0], 0.4, p.h * 0.3);
      }, { cap: [24, 20], top: (p) => p.fill(HO.saddle[2]), bottom: (p) => p.fill(HO.saddle[2]) });
      const [bw, bh] = stripSize(T.rx * 1.05, T.rz * 1.05, 0.56, D.body);
      s.wrap('horse.blanket', bw, bh, (p) => {
        p.cloth(HO.blanket, { fold: 0.6 });
        // a gold trim band at its front and back edges, a girth strap across the belly, stirrup leathers down the sides
        for (const y of [2, p.h - 3]) p.line(-1, y, p.w + 1, y, 1.6, HO.trim, 1);
        for (const u of [0.3, 0.7]) p.line(u * p.w, 0, u * p.w, p.h, 2.6, HO.strap, 1);
        for (const u of [0.25, 0.75]) {
          p.line(u * p.w, p.h * 0.35, u * p.w, p.h * 0.62, 1.1, HO.strap, 1);
          p.ellipse(u * p.w, p.h * 0.66, 3.4, 2.2, 0xb8b4a8, 1).ellipse(u * p.w, p.h * 0.66, 2.2, 1.0, HO.strap, 1);
        }
      });
      s.wrap('horse.rein', 8, 40, (p) => p.fill((x, y) => shade(HO.strap, 0.9 + 0.2 * hash2(x, y, 1))));
    },
    build(s) {
      const trunk = (tame) => {
        const c = collector(s);
        c.add(trunkGeo(T), 'horse.trunk', ahead(T.y, T.zRear));
        // the tail: up off the croup and falling in a full, dark sweep
        c.add(swept([[0, 1.36, 0.62], [0, 1.4, 0.74], [0, 1.2, 0.84], [0, 0.92, 0.86], [0, 0.72, 0.82]], 0.075, [0.6, 0.95, 1.05, 1, 0.75, 0], { sides: 6, segments: 5, rz: 0.055, up: [1, 0, 0] }), 'horse.mane');
        if (tame) {
          // a blanket wrapped round the back, the saddle's seat on it, a pommel in front and a cantle behind
          c.add(loft({ sides: 6, rx: T.rx * 1.04, rz: T.rz * 1.04, caps: false, rings: [{ y: 0, sx: 0.99, sz: 1.0, dz: -0.005 }, { y: 0.56, sx: 0.99, sz: 1.0, dz: 0.002 }] }), 'horse.blanket', ahead(T.y, 0.3));
          c.add(loft({ sides: 6, rx: 0.17, rz: 0.06, rings: [{ y: 0, sx: 0.7, sz: 1.4, dz: 0.05 }, { y: 0.08, sx: 1, sz: 1.0, dz: 0.01 }, { y: 0.24, sx: 0.95, sz: 0.8, dz: -0.01 }, { y: 0.38, sx: 1, sz: 1.0, dz: 0.01 }, { y: 0.44, sx: 0.6, sz: 1.5, dz: 0.05 }] }), 'horse.saddle', ahead(T.y + T.rz * 0.97 + 0.02, 0.22));
        }
        return c.done();
      };
      const head = (tame) => {
        const c = collector(s);
        // the neck: deep at the chest, rising forward, narrowing to the throat
        c.add(along([0, 1.18, -0.42], [0, 1.88, -0.78], 0.14, 0.2, [[0, 1.1, 1.3, -0.02], [0.35, 1, 1.05], [0.75, 0.9, 0.8], [1, 0.82, 0.7]], { caps: false, up: [0, 0.4, 1] }), 'horse.neck');
        c.add(along(poll, nose, H.rx, H.rz, H.rings), tame ? 'horse.headTack' : 'horse.head');
        // the mane along the top of the neck, a forelock over the brow
        c.add(swept([[0, 2.02, -0.74], [0, 1.9, -0.66], [0, 1.68, -0.55], [0, 1.46, -0.44], [0, 1.34, -0.36]], 0.026, [0.7, 1, 1.05, 1, 0.9, 0.7, 0.4], { sides: 4, segments: 6, rz: 0.075, up: [0, 1, 1] }), 'horse.mane');
        c.add(swept([[0, 2.02, -0.8], [0, 1.99, -0.88], [0, 1.94, -0.92]], 0.035, [1, 0.8, 0.3], { sides: 4, segments: 3, rz: 0.014, up: [0, 1, -1] }), 'horse.mane');
        for (const sd of [-1, 1]) {
          c.add(pyramid({ sides: 4, rx: 0.035, rz: 0.022, h: 0.13, apex: { dx: sd * 0.01, dz: 0.01 } }), 'horse.ear', compose({ t: [sd * 0.065, 2.0, -0.77], r: [-0.15, 0, -sd * 0.25] }));
          if (tame) c.add(swept([[sd * 0.1, 1.77, -1.12], [sd * 0.14, 1.6, -0.9], [sd * 0.16, 1.52, -0.66], [sd * 0.13, 1.5, -0.46]], 0.008, () => 1, { sides: 4, segments: 4, up: [1, 0, 0] }), 'horse.rein');
        }
        return c.done();
      };
      const leg = s.place(legGeo({ H: R.legH, r: 0.085, rings: [[0, 1.25], [0.42, 0.72, 0.045], [0.82, 0.6, 0.01], [0.9, 0.82], [1, 0.86]] }), 'horse.leg');
      return {
        parts: { body: trunk(false), alt: trunk(true), head: head(false), 'head-alt': head(true), legs: leg },
        variants: { body: ['body', 'head'], alt: ['alt', 'head-alt'] },
      };
    },
  };
}

// ---- the wolf (a collar when tame) ---------------------------------------------------------------------------------

const WOLF = Object.freeze({
  coat: [0xb4b8bd, 0x8c9096, 0x5c6066], saddle: [0x7a7470, 0x5a5550, 0x3c3834], pale: [0xf0ece4, 0xd8d6d0, 0xb8b6b0], nose: 0x1a1816,
  eye: 0xe0a83a, collar: [0xe0563a, 0xc0392b, 0x8a2418], tag: 0xf2d06a,
  trunk: { y: 0.6, zRear: 0.42, L: 0.86, rx: 0.17, rz: 0.19, rings: [[0, 0.55, 0.6, 0.01], [0.08, 0.9, 0.86, 0.01], [0.2, 1, 0.9, 0.01], [0.42, 0.84, 0.76, 0.03], [0.64, 1.02, 1.06, -0.005], [0.82, 1.1, 1.2, -0.015], [0.94, 0.95, 1.08, 0.01], [1, 0.62, 0.76, 0.01]] },
  head: { rx: 0.135, rz: 0.12, rings: [[0, 0.85, 0.88], [0.22, 1, 1], [0.45, 0.9, 0.86, -0.006], [0.58, 0.55, 0.58, -0.024], [0.86, 0.46, 0.48, -0.026], [1, 0.4, 0.42, -0.028]] },
});

/** @returns {KindSpec} */
function wolfSpec() {
  const W = WOLF;
  const T = W.trunk;
  const H = W.head;
  const R = ANIMAL_RIGS.wolf;
  const headO = { rx: H.rx, rz: H.rz };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx * 1.06, T.rz * 1.12, T.L, D.body);
      s.wrap('wolf.trunk', tw, th, (p) => {
        coat(p, W.coat, { len: 6, density: 0.9, belly: W.pale[1], bellyWidth: 0.2, mottle: 0.6, scale: 7, strokes: [W.coat[0], W.coat[2], W.pale[0]] });
        // a darker saddle along the back
        for (let y = 0; y < p.h; y++) {
          for (let x = 0; x < p.w; x++) {
            const a = smooth01(0.35, 0.8, upness(x, p.w) + 0.15 * (wrapN(x, y, p.w, 6, 10, 3) - 0.5));
            if (a > 0) p.px(x, y, shade(W.saddle[1], 0.85 + 0.3 * hash2(x, y, 5)), a * 0.75);
          }
        }
        endShade(p, 0.1, 0.12, 0.1);
      }, { cap: [28, 28], bottom: (p) => { coat(p, W.coat, { seamless: false }); p.glow(p.w / 2, p.h * 0.3, p.w * 0.35, W.pale[0], 0.6); } });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.32, D.head);
      s.wrap('wolf.head', hw, hh, (p) => {
        coat(p, W.coat, { len: 3, density: 0.8, belly: W.pale[0], bellyWidth: 0.22, light: 0.05, scale: 5 });
        // the mask: a pale muzzle and cheeks, darker over the brow
        for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (upness(x, p.w) > 0.6) p.tone(x, y, 0.85);
        eyes(p, headO, 62, p.h * 0.66, 3.3, { iris: W.eye, rim: W.saddle[2], side: 1 });
        endShade(p, 0, 0.25, 0.15);
      }, {
        cap: [20, 18],
        top: (p) => {
          p.fill(W.pale[1]);
          p.ellipse(10, 5.5, 5.2, 3.4, W.nose, 1).ellipse(8, 4.6, 1.4, 0.8, 0x6a6460, 0.9);
          p.ellipse(7.6, 6.2, 1.1, 0.8, 0x000000, 1).ellipse(12.4, 6.2, 1.1, 0.8, 0x000000, 1);
          p.line(10, 8.8, 10, 12.5, 0.6, W.nose, 0.9).arc(10, 11, 5, PI * 0.2, PI * 0.8, 0.6, W.nose, 0.8, 3);
        },
      });
      const [nw, nh] = stripSize(0.13, 0.15, 0.3, D.body);
      s.wrap('wolf.neck', nw, nh, (p) => { coat(p, W.coat, { len: 6, density: 1, belly: W.pale[0], bellyWidth: 0.3, strokes: [W.coat[0], W.pale[0], W.coat[2]] }); endShade(p, 0, 0.2); });
      const [lw, lh] = stripSize(0.05, 0.05, R.legH + 0.1, D.limb);
      s.wrap('wolf.leg', lw, lh, (p) => {
        coat(p, W.coat, { len: 3, light: 0, dark: 0, scale: 5 });
        for (let y = Math.round(p.h * 0.55); y < p.h; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(W.coat[0], 0.9 + 0.15 * hash2(x, y, 3)), smooth01(p.h * 0.55, p.h * 0.7, y) * 0.5);
        hoof(p, W.saddle[2], 0.08, { crease: false });
        endShade(p, 0.3, 0, 0.25);
      }, { cap: [10, 10], bottom: (p) => p.fill(W.saddle[2]) });
      s.plain('wolf.ear', 18, 18, (p) => { coat(p, W.saddle, { seamless: false, len: 2 }); p.glow(9, 12, 4, W.pale[1], 0.7, 6); });
      s.wrap('wolf.tail', 24, 48, (p) => {
        coat(p, W.coat, { len: 6, density: 1.1, seamless: true, scale: 5, strokes: [W.coat[0], W.coat[2], W.saddle[1]] });
        for (let y = 0; y < p.h * 0.2; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(W.saddle[2], 0.9 + 0.2 * hash2(x, y, 4)), smooth01(p.h * 0.2, p.h * 0.08, y));
      });
      s.wrap('wolf.collar', 28, 8, (p) => { p.fill(W.collar[1]).mottle(0.08, 3); p.line(0, 1.2, p.w, 1.2, 0.5, W.collar[0], 0.8); p.line(0, 6.8, p.w, 6.8, 0.5, W.collar[2], 0.8); p.stitches(0, 4, p.w, 4, 0xf4d8b0, { a: 0.7 }); });
      s.wrap('wolf.tag', 10, 10, (p) => p.fill((x, y) => mix(W.tag, 0xa07a2a, y / p.h)), { cap: [10, 10], top: (p) => p.fill(W.tag), bottom: (p) => p.fill(W.tag) });
    },
    build(s) {
      const c = collector(s);
      c.add(trunkGeo(T), 'wolf.trunk', ahead(T.y, T.zRear));
      // the brush: a bushy tail hanging back and down, its tip dark
      c.add(swept([[0, 0.68, 0.38], [0, 0.66, 0.5], [0, 0.52, 0.66], [0, 0.36, 0.74]], 0.055, [0.6, 0.95, 1.15, 1.2, 1.05, 0.7, 0], { sides: 6, segments: 6, up: [1, 0, 0] }), 'wolf.tail');
      const body = c.done();
      const h = collector(s);
      h.add(along([0, 0.56, -0.26], [0, 0.78, -0.52], 0.13, 0.15, [[0, 1.1, 1.15], [0.55, 1.05, 1.05], [1, 0.85, 0.85]], { caps: false }), 'wolf.neck');
      h.add(along([0, 0.82, -0.45], [0, 0.74, -0.76], H.rx, H.rz, H.rings), 'wolf.head');
      for (const sd of [-1, 1]) h.add(pyramid({ sides: 4, rx: 0.042, rz: 0.018, h: 0.11, apex: { dx: sd * 0.005 } }), 'wolf.ear', compose({ t: [sd * 0.07, 0.89, -0.5], r: [-0.12, 0, -sd * 0.22] }));
      const head = h.done();
      const t = collector(s);
      t.add(along([0, 0.66, -0.4], [0, 0.71, -0.46], 0.135, 0.15, [[0, 1.08], [1, 1.08]], { caps: false }), 'wolf.collar');
      t.add(prism({ sides: 6, rx: 0.022, rz: 0.022, h: 0.008 }), 'wolf.tag', compose({ t: [0, 0.54, -0.5], r: [PI / 2 - 0.3, 0, 0] }));
      const leg = s.place(legGeo({ H: R.legH, r: 0.045, rings: [[0, 1.3], [0.45, 0.85, 0.03], [0.86, 0.72], [0.93, 0.95, -0.01], [1, 0.9, -0.012]] }), 'wolf.leg');
      return { parts: { body, head, legs: leg, tag: t.done() }, variants: { body: ['body', 'head'], alt: ['body', 'head'] } };
    },
  };
}

// ---- the deer: the doe, the stag (antlers), the fawn (spots) ---------------------------------------------------------

const DEER = Object.freeze({
  coat: [0xd09a62, 0xb5834e, 0x8a5e34], dark: [0x8a5e34, 0x6e4626, 0x4e3018], pale: [0xfbf6ec, 0xf0e6d4, 0xd8c8b0], nose: 0x1e1612,
  antler: [0xf2e8cc, 0xd9c9a0, 0xa89670], hoof: 0x2a1e16,
  trunk: { y: 0.89, zRear: 0.5, L: 0.96, rx: 0.175, rz: 0.2, rings: [[0, 0.55, 0.66, 0.02], [0.08, 0.9, 0.92, 0.01], [0.2, 1, 1, 0], [0.45, 0.92, 0.94, -0.01], [0.7, 0.96, 1.0, 0], [0.86, 0.95, 1.0, 0.02], [0.96, 0.74, 0.84, 0.02], [1, 0.5, 0.6, 0.01]] },
  head: { rx: 0.09, rz: 0.095, rings: [[0, 0.85, 0.85], [0.18, 1, 1], [0.45, 0.8, 0.82, -0.004], [0.8, 0.56, 0.6, -0.012], [1, 0.5, 0.52, -0.014]] },
});

/** @returns {KindSpec} */
function deerSpec() {
  const DE = DEER;
  const T = DE.trunk;
  const H = DE.head;
  const R = ANIMAL_RIGS.deer;
  const headO = { rx: H.rx, rz: H.rz };
  /** @param {Painter} p @param {boolean} fawn */
  const hide = (p, fawn) => {
    coat(p, DE.coat, { len: 4, density: 0.55, belly: DE.pale[1], bellyWidth: 0.15, mottle: 0.35, scale: 12 });
    // the dark line down the back
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const a = smooth01(0.93, 0.985, upness(x, p.w));
      if (a > 0) p.px(x, y, shade(DE.dark[1], 0.9 + 0.2 * hash2(x, y, 2)), a * 0.85);
    }
    if (fawn) spots(p, DE.pale[0], { rows: [0.07, 0.13, 0.19, 0.81, 0.87, 0.93], r: 2.3, step: 8 });
    endShade(p, 0.15, 0.1, 0.1);
  };
  const rump = (p) => {
    // seen from behind (upside down): the white heart of the rump round the tail, a dark rim
    coat(p, DE.coat, { seamless: false, len: 3 });
    p.ellipse(p.w / 2, p.h * 0.62, p.w * 0.36, p.h * 0.3, DE.dark[1], 1);
    p.ellipse(p.w / 2, p.h * 0.62, p.w * 0.32, p.h * 0.27, DE.pale[0], 1);
  };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx, T.rz, T.L, D.body);
      s.wrap('deer.trunk', tw, th, (p) => hide(p, false), { cap: [30, 30], bottom: rump });
      s.wrap('deer.fawn', tw, th, (p) => hide(p, true), { cap: [30, 30], bottom: rump });
      const [nw, nh] = stripSize(0.08, 0.1, 0.55, D.body);
      for (const stag of [false, true]) {
        s.wrap(stag ? 'deer.neckStag' : 'deer.neck', nw, nh, (p) => {
          coat(p, stag ? DE.dark : DE.coat, { len: stag ? 5 : 3, density: stag ? 1 : 0.6, light: 0.06, scale: 6 });
          // the white throat patch, high under the jaw (row 0 is the head end; u 0.5 the throat)
          p.ellipse(p.w * 0.5, p.h * 0.18, p.w * 0.13, p.h * 0.1, DE.pale[0], 0.95);
          endShade(p, 0, 0.3, 0.15);
        });
      }
      const [hw, hh] = stripSize(H.rx, H.rz, 0.36, D.head);
      s.wrap('deer.head', hw, hh, (p) => {
        coat(p, DE.coat, { len: 2.5, density: 0.7, belly: DE.pale[1], bellyWidth: 0.12, light: 0.05, scale: 5 });
        // a dark muzzle, a pale band behind it, a pale ring round each eye
        for (let y = 0; y < p.h * 0.18; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(DE.dark[2], 0.9 + 0.2 * hash2(x, y, 9)), smooth01(p.h * 0.18, p.h * 0.1, y));
        p.line(-1, p.h * 0.21, p.w + 1, p.h * 0.21, 1.2, DE.pale[1], 0.75);
        eyes(p, headO, 80, p.h * 0.78, 4.2, { ring: DE.pale[1], lashes: true });
        endShade(p, 0, 0.25, 0.15);
      }, { cap: [18, 18], top: (p) => { p.fill(DE.nose); p.ellipse(6, 8, 2, 2.6, 0x000000, 1).ellipse(12, 8, 2, 2.6, 0x000000, 1); p.ellipse(7, 5, 1.5, 0.8, 0x6a5a50, 0.8); } });
      const [lw, lh] = stripSize(0.04, 0.04, R.legH + 0.1, D.limb);
      s.wrap('deer.leg', lw, lh, (p) => { coat(p, DE.coat, { len: 3, light: 0, dark: 0, scale: 5 }); hoof(p, DE.hoof, 0.08); endShade(p, 0.35, 0, 0.25); }, { cap: [8, 8], bottom: (p) => p.fill(DE.hoof) });
      s.plain('deer.ear', 24, 32, (p) => {
        coat(p, DE.coat, { seamless: false, len: 2 });
        p.glow(12, 16, 7, DE.pale[0], 0.85, 12);
        p.ao({ top: 0.5, width: 0.2 });
      });
      s.wrap('deer.antler', 16, 48, (p) => {
        p.fill((x, y) => mix(DE.antler[0], DE.antler[2], 0.25 + 0.6 * (y / p.h) + 0.15 * (hash2(x, y >> 1, 3) - 0.5)));
        for (let y = p.h * 0.6; y < p.h; y += 2.5) p.line(0, y, p.w, y + 1, 0.4, DE.antler[2], 0.4);
      });
      s.plain('deer.tail', 16, 16, (p) => { p.fill(DE.coat[1]); p.glow(8, 11, 7, DE.pale[0], 1, 6); });
    },
    build(s) {
      const trunk = (fawn) => {
        const c = collector(s);
        c.add(trunkGeo(T), fawn ? 'deer.fawn' : 'deer.trunk', ahead(T.y, T.zRear));
        c.add(wedge({ w: 0.08, h: 0.13, d: 0.04, sx: 0.4, ridge: 0.2 }), 'deer.tail', compose({ t: [0, 1.0, 0.5], r: [2.5, 0, 0] }));
        return c.done();
      };
      const head = (stag) => {
        const c = collector(s);
        c.add(along([0, 0.9, -0.3], [0, 1.42, -0.58], 0.08 * (stag ? 1.15 : 1), 0.1 * (stag ? 1.15 : 1), [[0, 1.3, 1.4], [0.35, 1.05, 1.05], [0.75, 0.9, 0.95], [1, 0.85, 0.9]], { caps: false, up: [0, 0.3, 1] }), stag ? 'deer.neckStag' : 'deer.neck');
        c.add(along([0, 1.52, -0.56], [0, 1.4, -0.91], H.rx, H.rz, H.rings), 'deer.head');
        for (const sd of [-1, 1]) {
          c.add(along([sd * 0.07, 1.57, -0.57], [sd * 0.22, 1.67, -0.52], 0.045, 0.012, [[0, 0.5], [0.45, 1], [1, 0.2]], { up: [0, 0.2, -1] }), 'deer.ear');
          if (stag) {
            // a main beam rising back and out, then up and forward; a brow tine forward, two tines up off the beam
            const beam = [[sd * 0.04, 1.6, -0.6], [sd * 0.15, 1.72, -0.55], [sd * 0.26, 1.88, -0.53], [sd * 0.3, 2.05, -0.58], [sd * 0.25, 2.2, -0.66]];
            c.add(swept(beam, 0.03, [1, 0.92, 0.8, 0.66, 0.5, 0.3, 0], { sides: 5, segments: 6, up: [0, 0, 1] }), 'deer.antler');
            for (const [a, b] of [[[sd * 0.11, 1.68, -0.56], [sd * 0.13, 1.78, -0.74]], [[sd * 0.26, 1.9, -0.53], [sd * 0.4, 2.05, -0.47]]]) {
              c.add(swept([a, b], 0.022, [1, 0.6, 0], { sides: 4, segments: 2, up: [0, 0, 1] }), 'deer.antler');
            }
          }
        }
        return c.done();
      };
      const leg = s.place(legGeo({ H: R.legH, r: 0.04, rings: [[0, 1.4], [0.3, 1.0, 0.03], [0.45, 0.7, 0.05], [0.86, 0.6, 0.01], [0.93, 0.85], [1, 0.8]] }), 'deer.leg');
      return {
        parts: { body: trunk(false), young: trunk(true), head: head(false), 'head-male': head(true), legs: leg },
        variants: { body: ['body', 'head'], male: ['body', 'head-male'], young: ['young', 'head'] },
      };
    },
  };
}

// ---- the rabbit ----------------------------------------------------------------------------------------------------

const RABBIT = Object.freeze({
  coat: [0xb8a080, 0x9a8468, 0x6e5a46], pale: [0xf4ece0, 0xe2d6c2, 0xc8b8a0], inner: 0xe6b0a8, nose: 0xc8888a,
  trunk: { y: 0.18, zRear: 0.22, L: 0.38, rx: 0.1, rz: 0.105, rings: [[0, 0.5, 0.55, 0.0], [0.08, 1.05, 1.0, 0.0], [0.24, 1.32, 1.18, 0.0], [0.45, 1.15, 1.06, 0.005], [0.68, 0.88, 0.9, 0.01], [0.88, 0.76, 0.82, 0.02], [1, 0.46, 0.52, 0.02]] },
  head: { rx: 0.07, rz: 0.072, rings: [[0, 0.72, 0.75], [0.25, 1, 1], [0.6, 0.92, 0.9, -0.003], [0.88, 0.66, 0.66, -0.006], [1, 0.5, 0.5, -0.008]] },
});

/** @returns {KindSpec} */
function rabbitSpec() {
  const RB = RABBIT;
  const T = RB.trunk;
  const H = RB.head;
  const R = ANIMAL_RIGS.rabbit;
  const headO = { rx: H.rx, rz: H.rz };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx * 1.12, T.rz * 1.08, T.L, D.body * 1.6);
      s.wrap('rabbit.trunk', tw, th, (p) => { coat(p, RB.coat, { len: 3, density: 1, belly: RB.pale[1], bellyWidth: 0.16, mottle: 0.7, scale: 4, strokes: [RB.coat[0], RB.coat[2], RB.pale[0]] }); endShade(p, 0.1, 0.1, 0.1); }, { cap: [20, 20], bottom: (p) => coat(p, RB.coat, { seamless: false }) });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.17, D.head * 1.4);
      s.wrap('rabbit.head', hw, hh, (p) => {
        coat(p, RB.coat, { len: 2, density: 1, belly: RB.pale[0], bellyWidth: 0.18, scale: 4 });
        eyes(p, headO, 76, p.h * 0.6, 3.6, { rim: RB.coat[2], ring: RB.pale[1] });
        endShade(p, 0, 0.2, 0.12);
      }, { cap: [18, 18], top: (p) => { p.fill(RB.pale[1]); p.ellipse(9, 7, 3, 2.2, RB.nose, 1); p.line(9, 9, 9, 12, 0.5, 0x6e4a40, 0.9).arc(9, 11, 3.2, PI * 0.2, PI * 0.8, 0.5, 0x6e4a40, 0.8, 2); for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) p.line(9 + sd * 3, 10 + k, 9 + sd * 9, 9 + k * 2, 0.3, 0xffffff, 0.6); } });
      s.wrap('rabbit.ear', 20, 44, (p) => {
        coat(p, RB.coat, { len: 2, density: 0.8, scale: 4 });
        // the pink inside down the front of the ear (u 0.5 faces forward)
        p.ellipse(p.w * 0.5, p.h * 0.5, p.w * 0.2, p.h * 0.4, RB.inner, 0.9);
        p.ellipse(p.w * 0.5, p.h * 0.08, p.w * 0.5, p.h * 0.08, RB.coat[2], 0.6);
      });
      const [lw, lh] = stripSize(0.035, 0.035, R.legH + 0.06, D.limb * 1.5);
      s.wrap('rabbit.leg', lw, lh, (p) => { coat(p, RB.coat, { len: 2, light: 0, dark: 0, scale: 3 }); for (let y = Math.round(p.h * 0.84); y < p.h; y++) for (let x = 0; x < p.w; x++) p.px(x, y, RB.pale[1], 0.85); endShade(p, 0.4, 0, 0.3); }, { cap: [8, 8], bottom: (p) => p.fill(RB.pale[2]) });
      s.plain('rabbit.puff', 24, 24, (p) => { p.wool(RB.pale, { r: 2.4 }); });
    },
    build(s) {
      const c = collector(s);
      c.add(trunkGeo(T), 'rabbit.trunk', ahead(T.y, T.zRear));
      c.add(loft({ sides: 6, rx: 0.05, phase: 0, caps: { bottom: false }, rings: [{ y: 0, sx: 0.8 }, { y: 0.03, sx: 1 }, { y: 0.06, sx: 0.45 }] }), 'rabbit.puff', compose({ t: [0, 0.21, 0.2], r: [PI / 2 - 0.4, 0, 0] }));
      const body = c.done();
      const h = collector(s);
      h.add(along([0, 0.3, -0.07], [0, 0.255, -0.25], H.rx, H.rz, H.rings), 'rabbit.head');
      // ears: tall, upright, a little apart and back
      for (const sd of [-1, 1]) h.add(along([sd * 0.03, 0.35, -0.11], [sd * 0.055, 0.61, -0.05], 0.032, 0.012, [[0, 0.6], [0.3, 1], [0.8, 0.85], [1, 0.35]], { up: [0, 0, -1] }), 'rabbit.ear');
      const leg = s.place(legGeo({ H: R.legH, r: 0.032, ext: 0.08, rings: [[0, 1.5], [0.55, 0.9], [1, 1.15, -0.015]] }), 'rabbit.leg');
      return { parts: { body, head: h.done(), legs: leg }, variants: { body: ['body', 'head'] } };
    },
  };
}

// ---- the pheasant: the hen (drab, a short tail) and the cock (copper, a green head, a long barred tail) ---------------

const PHEASANT = Object.freeze({
  hen: [0xc8a878, 0x9a7a52, 0x6a5034], cock: [0xd88a44, 0xb5622a, 0x7a3a18], green: [0x3a8a70, 0x1f5a48, 0x103a2e], ring: 0xf8f4ec,
  wattle: 0xd23a2a, beak: [0xf0e6c0, 0xe6d9a8, 0xb0a070], leg: [0xb0a080, 0x9a8a64, 0x6a5a3a], barTail: [0xe0c890, 0xc9a56a, 0x5a3a1c],
  trunk: { y: 0.27, zRear: 0.18, L: 0.36, rx: 0.095, rz: 0.11, rings: [[0, 0.3, 0.35, 0.04], [0.12, 0.8, 0.82, 0.02], [0.42, 1, 1, 0], [0.7, 1, 1.06, -0.01], [0.86, 0.86, 0.96, -0.005], [0.96, 0.55, 0.65, 0.01], [1, 0.18, 0.22, 0.02]] },
});

/** @returns {KindSpec} */
function pheasantSpec() {
  const P = PHEASANT;
  const T = P.trunk;
  const R = ANIMAL_RIGS.pheasant;
  const headO = { rx: 0.036, rz: 0.04 };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx, T.rz * 1.06, T.L, D.body * 2);
      s.wrap('pheasant.hen', tw, th, (p) => { p.feathers(P.hen, { size: 6, edge: 0xe8d8b0, vary: 0.5 }); for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const up = upness(x, p.w); p.tone(x, y, up > 0 ? 1 + 0.05 * up : 1 + 0.15 * up); } }, { cap: [20, 20] });
      s.wrap('pheasant.cock', tw, th, (p) => {
        p.feathers(P.cock, { size: 6, edge: 0xf0c890, vary: 0.4 });
        // dark scalloped flecks on the copper; the folded wings paler and barred on the sides
        const rnd = makeRng(3);
        for (let i = 0; i < p.w * p.h * 0.02; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 1.3, 0.9, 0x2a1408, 0.7);
        for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const up = upness(x, p.w); p.tone(x, y, up > 0 ? 1 + 0.06 * up : 1 + 0.15 * up); }
      }, { cap: [20, 20] });
      const [nw, nh] = stripSize(0.05, 0.055, 0.15, D.head);
      const [hw, hh] = stripSize(headO.rx, headO.rz, 0.1, D.head * 1.6);
      /** the glossy green of the cock's head and neck */
      const green = (p) => p.fill((x, y) => mix(P.green[1], P.green[0], 0.25 + 0.5 * fbm(x / 3, y / 4, 6)));
      s.wrap('pheasant.henNeck', nw, nh, (p) => { p.feathers(P.hen, { size: 4, edge: 0xe8d8b0 }); endShade(p, 0, 0.3, 0.2); });
      s.wrap('pheasant.henHead', hw, hh, (p) => {
        p.feathers([0xd8bc90, 0xb09068, 0x806040], { size: 3.5, edge: 0xeee0c0 });
        eyes(p, headO, 80, p.h * 0.45, 2.6, { ring: 0xeee0c0 });
      }, { cap: [10, 10] });
      s.wrap('pheasant.cockNeck', nw, nh, (p) => {
        // the green neck, its white collar near the foot, copper below it
        green(p);
        for (let y = p.h * 0.62; y < p.h * 0.76; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(P.ring, 0.95 + 0.05 * hash2(x, y, 2)), 1);
        for (let y = p.h * 0.76; y < p.h; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(P.cock[1], 0.9 + 0.2 * hash2(x, y, 3)), 1);
      }, { cap: [10, 10] });
      s.wrap('pheasant.cockHead', hw, hh, (p) => {
        // green, with a red wattle round each eye
        green(p);
        for (const deg of [80, 280]) p.ellipse(uAt(headO, deg) * p.w, p.h * 0.48, 6.5, 6, P.wattle, 1);
        eyes(p, headO, 80, p.h * 0.45, 2.6, {});
      }, { cap: [10, 10], top: (p) => p.fill(P.green[1]) });
      s.wrap('pheasant.beak', 10, 12, (p) => p.fill((x, y) => mix(P.beak[0], P.beak[2], y / p.h)));
      const [lw, lh] = stripSize(0.018, 0.018, R.legH + 0.08, D.limb * 2);
      s.wrap('pheasant.leg', lw, lh, (p) => { p.fill(P.leg[1]); for (let y = 2; y < p.h; y += 3) p.line(0, y, p.w, y, 0.4, P.leg[2], 0.5); for (let y = 0; y < p.h * 0.32; y++) for (let x = 0; x < p.w; x++) p.px(x, y, P.hen[1], 1); }, { cap: [6, 6] });
      s.plain('pheasant.toes', 12, 12, (p) => p.fill(P.leg[2]));
      s.plain('pheasant.tail', 16, 64, (p) => {
        p.fill((x) => mix(P.barTail[1], P.barTail[0], 0.3 * Math.sin((x / p.w) * PI)));
        for (let y = 4; y < p.h - 2; y += 7) p.line(-1, y, p.w + 1, y + 1.5, 1.2, P.barTail[2], 0.9);
        p.line(p.w / 2, 0, p.w / 2, p.h, 0.4, P.barTail[2], 0.5);
      });
      s.plain('pheasant.henTail', 16, 40, (p) => {
        p.fill(P.hen[1]);
        for (let y = 3; y < p.h - 2; y += 6) p.line(-1, y, p.w + 1, y + 1, 1, P.hen[2], 0.8);
      });
      s.wrap('pheasant.wing', 48, 40, (p) => {
        p.feathers(P.hen, { size: 5, edge: 0xf0e0b8 });
        // the primaries: long dark feathers toward the tip (the strip's far rows), pale bars
        for (let y = 0; y < p.h * 0.35; y++) for (let x = 0; x < p.w; x++) p.px(x, y, mix(P.hen[2], P.hen[1], ((x + y) % 6) / 12), 0.85);
        for (let x = 0; x < p.w; x += 4) p.line(x, 0, x, p.h * 0.35, 0.4, 0xe8d8b0, 0.6);
      }, { cap: [12, 12] });
    },
    build(s) {
      const trunk = (cock) => {
        const c = collector(s);
        c.add(trunkGeo(T), cock ? 'pheasant.cock' : 'pheasant.hen', ahead(T.y, T.zRear));
        // the tail: a cock's longer than the rest of the bird, a hen's short — two feathers each, a little apart
        for (const sd of [-1, 1]) {
          const end = cock ? [sd * 0.03, 0.42, 0.78] : [sd * 0.025, 0.33, 0.44];
          c.add(cardAt([sd * 0.012, 0.3, 0.14], end, cock ? 0.06 : 0.07, [0, 1, 0]), cock ? 'pheasant.tail' : 'pheasant.henTail');
        }
        if (cock) c.add(cardAt([0, 0.31, 0.14], [0, 0.37, 0.62], 0.06, [0, 1, 0]), 'pheasant.tail');
        return c.done();
      };
      /** @param {boolean} cock */
      const head = (cock) => {
        const c = collector(s);
        // a short neck rising from the breast, a small round head on it, the beak
        c.add(along([0, 0.27, -0.1], [0, 0.41, -0.17], 0.05, 0.055, [[0, 1.3, 1.25], [0.5, 0.9], [1, 0.72]], { caps: false, up: [0, 0.3, 1] }), cock ? 'pheasant.cockNeck' : 'pheasant.henNeck');
        c.add(along([0, 0.43, -0.14], [0, 0.42, -0.24], headO.rx, headO.rz, [[0, 0.7, 0.75], [0.3, 1], [0.75, 0.88], [1, 0.55, 0.6]]), cock ? 'pheasant.cockHead' : 'pheasant.henHead');
        c.add(pyramid({ sides: 4, rx: 0.014, rz: 0.011, h: 0.045, apex: { dz: -0.006 } }), 'pheasant.beak', compose({ t: [0, 0.415, -0.232], r: [-PI / 2 - 0.25, 0, 0] }));
        if (cock) for (const sd of [-1, 1]) c.add(pyramid({ sides: 4, rx: 0.011, rz: 0.007, h: 0.035 }), 'pheasant.cockHead', compose({ t: [sd * 0.016, 0.455, -0.15], r: [0.9, 0, -sd * 0.3] }));
        return c.done();
      };
      const lg = collector(s);
      lg.add(legGeo({ H: R.legH, r: 0.016, ext: 0.08, rings: [[0, 2.4], [0.25, 1.5, 0.01], [0.4, 0.9, 0.02], [1, 0.8]] }), 'pheasant.leg');
      for (const yaw of [-0.4, 0, 0.4]) lg.add(wedge({ w: 0.014, h: 0.008, d: 0.06, sx: 0.5 }), 'pheasant.toes', compose({ t: [Math.sin(yaw) * -0.025, -R.legH, -Math.cos(yaw) * 0.025], r: [0, yaw, 0] }));
      const wing = transform(loft({ sides: 6, rx: 0.11, rz: 0.012, rings: [{ y: 0, sx: 1 }, { y: 0.22, sx: 0.92, dx: 0.01 }, { y: 0.36, sx: 0.35, dx: 0.04 }] }), seg([0, 0, 0], [1, 0, 0], null, { back: [0, 1, 0] }));
      return {
        parts: { body: trunk(false), male: trunk(true), head: head(false), 'head-male': head(true), legs: lg.done(), wings: s.place(wing, 'pheasant.wing') },
        variants: { body: ['body', 'head'], male: ['male', 'head-male'] },
      };
    },
  };
}

// ---- the wild turkey: the hen (brown, her tail low) and the tom (bronze, a bare blue head, a wattle, his fan) ---------

const TURKEY = Object.freeze({
  hen: [0x9a7c5c, 0x76593e, 0x4e3a28], tom: [0x6e5a46, 0x4a3a2c, 0x2a2018], bronze: 0xb8864a, head: [0xc8d8e8, 0x9fb0c0, 0x6e8094],
  wattle: 0xd23a32, neck: [0xe08a7a, 0xc86a5c, 0x9a4a40], beak: [0xf0e0a0, 0xe0c878, 0xa08a48], leg: [0xc8a080, 0xb08a6a, 0x7a5a40],
  fan: [0x8a6a46, 0x6e4e2e, 0x3a2818], band: 0xd8b67a, tip: 0xf4ecdc,
  trunk: { y: 0.53, zRear: 0.25, L: 0.5, rx: 0.16, rz: 0.17, rings: [[0, 0.32, 0.38, 0.04], [0.12, 0.84, 0.86, 0.02], [0.42, 1.04, 1, 0], [0.68, 1.06, 1.08, -0.02], [0.85, 0.9, 1.0, -0.01], [0.96, 0.55, 0.66, 0.02], [1, 0.18, 0.24, 0.03]] },
});

/** @returns {KindSpec} */
function turkeySpec() {
  const TK = TURKEY;
  const T = TK.trunk;
  const R = ANIMAL_RIGS.turkey;
  const headO = { rx: 0.045, rz: 0.05 };
  /** a fan feather: brown with dark bars, a pale band and a white tip at its far end (row 0) */
  const fanFeather = (p, hen) => {
    const r = hen ? TK.hen : TK.fan;
    p.fill((x, y) => mix(r[1], r[0], 0.4 * Math.sin((x / p.w) * PI) + 0.1 * hash2(x, y >> 1, 3)));
    for (let y = p.h * 0.3; y < p.h; y += 6) p.line(-1, y, p.w + 1, y + 1, 0.9, r[2], 0.75);
    for (let y = p.h * 0.1; y < p.h * 0.2; y++) for (let x = 0; x < p.w; x++) p.px(x, y, TK.band, 0.9);
    for (let y = 0; y < p.h * 0.08; y++) for (let x = 0; x < p.w; x++) p.px(x, y, hen ? TK.band : TK.tip, 0.95);
    p.line(p.w / 2, 0, p.w / 2, p.h, 0.45, r[2], 0.6);
  };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx * 1.06, T.rz * 1.08, T.L, D.body * 1.4);
      s.wrap('turkey.hen', tw, th, (p) => { p.feathers(TK.hen, { size: 7, edge: 0xe0cca8, vary: 0.45 }); endShade(p, 0.1, 0.1, 0.1); }, { cap: [24, 24] });
      s.wrap('turkey.tom', tw, th, (p) => {
        p.feathers(TK.tom, { size: 7, edge: TK.bronze, vary: 0.3 });
        // an iridescent sheen on the back, a black-tipped beard on the breast
        for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const up = upness(x, p.w); if (up > 0.3) p.px(x, y, TK.bronze, 0.12 * up); }
        p.line(p.w / 2, p.h * 0.05, p.w / 2 + 1, p.h * 0.3, 1.6, 0x14100c, 0.9);
      }, { cap: [24, 24] });
      const [nw, nh] = stripSize(0.06, 0.065, 0.25, D.head);
      const [hw, hh] = stripSize(headO.rx, headO.rz, 0.1, D.head * 1.5);
      /** bare skin with warty bumps over its top `bare` share, feathers below */
      const neck = (p, skin, warts, feathers, bare) => {
        p.feathers(feathers, { size: 4.5, edge: 0xe0cca8 });
        const rnd = makeRng(8);
        for (let y = 0; y < p.h * bare; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(skin, 0.94 + 0.12 * hash2(x, y, 5)), smooth01(p.h * bare, p.h * (bare - 0.12), y + (hash2(x, 1, 2) - 0.5) * 3));
        for (let i = 0; i < p.w * p.h * bare * 0.06; i++) p.ellipse(rnd() * p.w, rnd() * p.h * bare * 0.9, 0.9, 0.9, warts, 0.65);
      };
      s.wrap('turkey.henNeck', nw, nh, (p) => neck(p, TK.head[1], TK.head[0], TK.hen, 0.4), { cap: [10, 10] });
      s.wrap('turkey.tomNeck', nw, nh, (p) => neck(p, TK.neck[1], TK.neck[0], TK.tom, 0.55), { cap: [10, 10] });
      s.wrap('turkey.henHead', hw, hh, (p) => {
        p.fill((x, y) => shade(TK.head[1], 0.92 + 0.12 * fbm(x / 3, y / 3, 4)));
        eyes(p, headO, 80, p.h * 0.45, 2.6, {});
      }, { cap: [10, 10], top: (p) => p.fill(TK.head[1]) });
      s.wrap('turkey.tomHead', hw, hh, (p) => {
        p.fill((x, y) => shade(mix(TK.head[0], TK.head[1], 0.4), 0.92 + 0.12 * fbm(x / 3, y / 3, 4)));
        const rnd = makeRng(9);
        for (let i = 0; i < p.w * p.h * 0.04; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 0.9, 0.9, 0xffffff, 0.5);
        eyes(p, headO, 80, p.h * 0.45, 2.6, {});
      }, { cap: [10, 10], top: (p) => p.fill(TK.head[0]) });
      s.wrap('turkey.beak', 10, 12, (p) => p.fill((x, y) => mix(TK.beak[0], TK.beak[2], y / p.h)));
      s.wrap('turkey.wattle', 10, 20, (p) => { p.fill(TK.wattle).mottle(0.12, 2); }, { cap: [8, 8], top: (p) => p.fill(TK.wattle), bottom: (p) => p.fill(TK.wattle) });
      const [lw, lh] = stripSize(0.025, 0.025, R.legH + 0.1, D.limb * 1.5);
      s.wrap('turkey.leg', lw, lh, (p) => { p.fill(TK.leg[1]); for (let y = 2; y < p.h; y += 3) p.line(0, y, p.w, y, 0.4, TK.leg[2], 0.5); for (let y = 0; y < p.h * 0.3; y++) for (let x = 0; x < p.w; x++) p.px(x, y, TK.hen[1], 1); }, { cap: [6, 6] });
      s.plain('turkey.toes', 12, 12, (p) => p.fill(TK.leg[2]));
      s.plain('turkey.fan', 20, 72, (p) => fanFeather(p, false));
      s.plain('turkey.henFan', 20, 48, (p) => fanFeather(p, true));
      s.wrap('turkey.wing', 56, 44, (p) => {
        p.feathers(TK.hen, { size: 6, edge: 0xf0e0c0 });
        for (let y = 0; y < p.h * 0.4; y++) for (let x = 0; x < p.w; x++) p.px(x, y, (Math.floor(y / 4) & 1) ? 0xf0e6d4 : 0x3a2c20, 0.85);
      }, { cap: [12, 12] });
    },
    build(s) {
      const trunk = (tom) => {
        const c = collector(s);
        c.add(trunkGeo(T), tom ? 'turkey.tom' : 'turkey.hen', ahead(T.y, T.zRear));
        if (tom) {
          // the fan: two rows of feathers spread in a half wheel standing up behind him
          const hinge = [0, 0.52, 0.24];
          /** @type {Array<[number, number, number, number]>} [feathers, length, width, set back] */
          const rows = [[11, 0.54, 0.13, 0.07], [9, 0.32, 0.11, 0.02]];
          for (const [n, L, W, back] of rows) {
            for (let k = 0; k < n; k++) {
              const a = (-82 + (164 * k) / (n - 1)) * DEG;
              const tip = [hinge[0] + Math.sin(a) * L, hinge[1] + Math.cos(a) * L, hinge[2] + back + 0.06 * Math.cos(a)];
              c.add(cardAt([hinge[0] + Math.sin(a) * 0.04, hinge[1] + Math.cos(a) * 0.04, hinge[2] + back * 0.4], tip, W, [0, 0, 1]), 'turkey.fan');
            }
          }
        } else {
          for (let k = 0; k < 5; k++) {
            const a = (-36 + 18 * k) * DEG;
            c.add(cardAt([0, 0.5, 0.2], [Math.sin(a) * 0.26, 0.42, 0.2 + Math.cos(a) * 0.26], 0.1, [0, 1, 0]), 'turkey.henFan');
          }
        }
        return c.done();
      };
      /** @param {boolean} tom */
      const head = (tom) => {
        const c = collector(s);
        // a neck feathered at its foot and bare above, curving up from the breast; a small round head on it
        c.add(along([0, 0.54, -0.15], [0, 0.77, -0.23], 0.06, 0.065, [[0, 1.55, 1.45], [0.3, 1.0], [0.65, 0.8], [1, 0.72]], { caps: false, up: [0, 0.3, 1] }), tom ? 'turkey.tomNeck' : 'turkey.henNeck');
        c.add(along([0, 0.8, -0.2], [0, 0.79, -0.3], headO.rx, headO.rz, [[0, 0.72, 0.78], [0.3, 1], [0.75, 0.88], [1, 0.58, 0.62]]), tom ? 'turkey.tomHead' : 'turkey.henHead');
        c.add(pyramid({ sides: 4, rx: 0.018, rz: 0.014, h: 0.05, apex: { dz: -0.008 } }), 'turkey.beak', compose({ t: [0, 0.785, -0.292], r: [-PI / 2 - 0.3, 0, 0] }));
        if (tom) {
          // the snood over the beak and the wattle down the throat
          c.add(swept([[0, 0.835, -0.27], [0.005, 0.81, -0.325], [0.01, 0.75, -0.33]], 0.012, [1, 1.1, 0.8, 0.5], { sides: 5, segments: 3, up: [1, 0, 0] }), 'turkey.wattle');
          c.add(swept([[0, 0.77, -0.27], [0, 0.71, -0.26], [0, 0.65, -0.23]], 0.022, [0.8, 1.2, 1, 0.6], { sides: 5, segments: 3, rz: 0.014, up: [0, 0, -1] }), 'turkey.wattle');
        }
        return c.done();
      };
      const lg = collector(s);
      lg.add(legGeo({ H: R.legH, r: 0.024, ext: 0.1, rings: [[0, 2.6], [0.25, 1.4, 0.015], [0.4, 0.9, 0.025], [1, 0.8]] }), 'turkey.leg');
      for (const yaw of [-0.45, 0, 0.45]) lg.add(wedge({ w: 0.02, h: 0.012, d: 0.09, sx: 0.5 }), 'turkey.toes', compose({ t: [Math.sin(yaw) * -0.035, -R.legH, -Math.cos(yaw) * 0.035], r: [0, yaw, 0] }));
      const wing = transform(loft({ sides: 6, rx: 0.15, rz: 0.016, rings: [{ y: 0, sx: 1 }, { y: 0.26, sx: 0.92, dx: 0.015 }, { y: 0.42, sx: 0.4, dx: 0.05 }] }), seg([0, 0, 0], [1, 0, 0], null, { back: [0, 1, 0] }));
      return {
        parts: { body: trunk(false), male: trunk(true), head: head(false), 'head-male': head(true), legs: lg.done(), wings: s.place(wing, 'turkey.wing') },
        variants: { body: ['body', 'head'], male: ['male', 'head-male'] },
      };
    },
  };
}

// ---- the bear ------------------------------------------------------------------------------------------------------

const BEAR = Object.freeze({
  coat: [0x8a6038, 0x6a4628, 0x46301a], grizzle: [0xb89464, 0x9a7646, 0x6a4c2a], chest: [0xb08a5a, 0x9a7646, 0x6e5030], dark: [0x4a3220, 0x3a2618, 0x241810],
  muzzle: [0xd2b484, 0xc2a06e, 0x9a7a4e], nose: 0x1a1210, claw: 0xe8dcc4,
  trunk: { y: 0.99, zRear: 0.78, L: 1.52, rx: 0.42, rz: 0.36, rings: [[0, 0.45, 0.5, -0.03], [0.06, 0.78, 0.8, -0.01], [0.18, 0.95, 0.95, 0], [0.4, 0.97, 0.96, -0.005], [0.62, 1.02, 1.05, 0.02], [0.8, 1.03, 1.1, 0.05], [0.92, 0.88, 1.0, 0.04], [1, 0.56, 0.68, 0.01]] },
  head: { rx: 0.25, rz: 0.22, rings: [[0, 0.8, 0.85], [0.12, 1, 1], [0.32, 0.92, 0.94], [0.5, 0.58, 0.62, -0.03], [0.82, 0.5, 0.5, -0.035], [1, 0.42, 0.44, -0.04]] },
});

/** @returns {KindSpec} */
function bearSpec() {
  const BE = BEAR;
  const T = BE.trunk;
  const H = BE.head;
  const R = ANIMAL_RIGS.bear;
  const headO = { rx: H.rx, rz: H.rz };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx, T.rz * 1.04, T.L, D.body * 0.9);
      s.wrap('bear.trunk', tw, th, (p) => {
        coat(p, BE.coat, { len: 7, density: 1.1, mottle: 0.6, scale: 9, light: 0.04, strokes: [BE.coat[0], BE.coat[2], BE.grizzle[0]] });
        // one smooth back: a paler grizzled strip from the shoulders to the rump (the spine is the strip's seam: u 0 and 1)
        for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
          const a = smooth01(0.72, 0.9, upness(x, p.w) + 0.08 * (wrapN(x, y, p.w, 5, 8, 6) - 0.5)) * smooth01(p.h * 0.95, p.h * 0.75, y);
          if (a > 0) p.px(x, y, shade(BE.grizzle[1], 0.85 + 0.35 * hash2(x, y, 6)), a * 0.75);
        }
        // a pale chest under the front (the belly at the chest end), seen when it rears
        for (let y = 0; y < p.h * 0.3; y++) for (let x = 0; x < p.w; x++) {
          const a = smooth01(-0.55, -0.85, upness(x, p.w)) * smooth01(p.h * 0.3, p.h * 0.1, y);
          if (a > 0) p.px(x, y, shade(BE.chest[1], 0.9 + 0.2 * hash2(x, y, 7)), a);
        }
        endShade(p, 0.1, 0.1, 0.08);
      }, { cap: [40, 40], bottom: (p) => coat(p, BE.coat, { seamless: false, len: 4 }) });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.56, D.head * 0.7);
      s.wrap('bear.head', hw, hh, (p) => {
        coat(p, BE.coat, { len: 4, density: 0.9, light: 0.05, dark: 0.12, scale: 6, strokes: [BE.coat[0], BE.coat[2], BE.grizzle[0]] });
        // the pale muzzle (the front half), small dark eyes set forward
        for (let y = 0; y < p.h * 0.5; y++) for (let x = 0; x < p.w; x++) p.px(x, y, shade(BE.muzzle[1], 0.9 + 0.15 * hash2(x, y, 9)), smooth01(p.h * 0.5, p.h * 0.36, y));
        eyes(p, headO, 52, p.h * 0.66, 3.8, { rim: BE.dark[1] });
        endShade(p, 0, 0.3, 0.15);
      }, { cap: [26, 24], top: (p) => { p.fill(BE.muzzle[1]); p.ellipse(13, 9, 9, 6, BE.nose, 1).ellipse(10, 7.5, 2.4, 1.2, 0x6a5a50, 0.8); p.line(13, 14, 13, 18, 0.7, BE.nose, 0.9).arc(13, 16, 6, PI * 0.2, PI * 0.8, 0.7, BE.nose, 0.8, 3); } });
      const [nw, nh] = stripSize(0.24, 0.24, 0.32, D.body);
      s.wrap('bear.neck', nw, nh, (p) => { coat(p, BE.coat, { len: 6, density: 1, belly: BE.chest[1], bellyWidth: 0.16 }); endShade(p, 0, 0.2); });
      const [lw, lh] = stripSize(0.12, 0.12, R.legH + 0.15, D.limb * 0.8);
      s.wrap('bear.leg', lw, lh, (p) => {
        coat(p, BE.dark, { len: 5, density: 1, light: 0, dark: 0, scale: 5, strokes: [BE.coat[1], BE.dark[2]] });
        // pale claws peeping out at the toes (the front of the paw: u 0.5)
        for (let k = -2; k <= 2; k++) p.line(p.w * 0.5 + k * 3, p.h - 6, p.w * 0.5 + k * 3.4, p.h - 1, 0.8, BE.claw, 0.95);
        endShade(p, 0.3, 0, 0.2);
      }, { cap: [16, 16], bottom: (p) => p.fill(BE.dark[2]) });
      s.plain('bear.ear', 18, 18, (p) => { coat(p, BE.dark, { seamless: false, len: 2 }); p.glow(9, 10, 5, BE.dark[2], 0.8, 5); });
    },
    build(s) {
      const c = collector(s);
      c.add(trunkGeo(T), 'bear.trunk', ahead(T.y, T.zRear));
      c.add(pyramid({ sides: 6, rx: 0.07, rz: 0.06, h: 0.1 }), 'bear.ear', compose({ t: [0, 1.12, 0.72], r: [PI / 2 - 0.4, 0, 0] }));
      const body = c.done();
      const h = collector(s);
      h.add(along([0, 0.98, -0.5], [0, 1.12, -0.8], 0.24, 0.24, [[0, 1.05, 1.1], [0.5, 1.02, 1.02], [1, 0.92, 0.92]], { caps: false }), 'bear.neck');
      h.add(along([0, 1.19, -0.76], [0, 1.06, -1.33], H.rx, H.rz, H.rings), 'bear.head');
      for (const sd of [-1, 1]) h.add(loft({ sides: 6, rx: 0.075, rz: 0.03, rings: [{ y: 0, sx: 0.8 }, { y: 0.05, sx: 1 }, { y: 0.09, sx: 0.55 }] }), 'bear.ear', compose({ t: [sd * 0.18, 1.33, -0.84], r: [0, 0, -sd * 0.35] }));
      const leg = s.place(legGeo({ H: R.legH, r: 0.12, ext: 0.15, rings: [[0, 1.3], [0.25, 1.12, 0.01], [0.62, 0.8, 0.02], [0.86, 0.86, -0.01], [1, 1.0, -0.035]] }), 'bear.leg');
      return { parts: { body, head: h.done(), legs: leg }, variants: { body: ['body', 'head'] } };
    },
  };
}

// ---- the fish ------------------------------------------------------------------------------------------------------

const FISH = Object.freeze({
  body: [0xffc060, 0xf0a23c, 0xc87a22], back: 0xffe2a0, belly: 0xfaf0dc, fin: [0xa8482a, 0x7a2e16, 0x4e1a0a],
  trunk: { y: 0.1, zRear: 0.2, L: 0.48, rx: 0.065, rz: 0.08, rings: [[0, 0.25, 0.3], [0.1, 0.42, 0.55], [0.35, 0.88, 0.95], [0.6, 1, 1], [0.8, 0.96, 0.95, -0.003], [0.93, 0.72, 0.76, -0.006], [1, 0.36, 0.42, -0.01]] },
});

/** @returns {KindSpec} */
function fishSpec() {
  const F = FISH;
  const T = F.trunk;
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx, T.rz, T.L, D.body * 2.4);
      s.wrap('fish.body', tw, th, (p) => {
        p.fill((x) => {
          const up = upness(x, p.w);
          return up > 0.55 ? mix(F.body[0], F.back, smooth01(0.55, 0.9, up)) : up < -0.4 ? mix(F.body[1], F.belly, smooth01(-0.4, -0.8, up)) : mix(F.body[1], F.body[0], 0.3 + 0.3 * up);
        });
        p.scales([0xfff0c0, F.body[1], F.body[2]], { size: 4 });
        // the head end (row 0..): an eye on each side, a gill line behind it
        for (const deg of [70, 290]) {
          const x = wrapU({ sides: 6, rx: T.rx, rz: T.rz }, deg * DEG).u * p.w;
          eye(p, x, p.h * 0.1, 3, { ring: 0xfff2d0 });
          p.arc(x, p.h * 0.2, 6, PI * 0.1, PI * 0.9, 0.7, F.body[2], 0.7, 3);
        }
      }, { cap: [12, 12], top: (p) => p.fill(F.body[2]) });
      s.plain('fish.fin', 24, 32, (p) => {
        p.fill((x, y) => mix(F.fin[1], F.fin[0], 0.4 * (y / p.h)));
        for (let x = 2; x < p.w; x += 3) p.line(x, 0, p.w / 2 + (x - p.w / 2) * 0.3, p.h, 0.45, F.fin[2], 0.7);
        p.ao({ top: 0.3, width: 0.25 });
      });
    },
    build(s) {
      const c = collector(s);
      c.add(trunkGeo(T), 'fish.body', ahead(T.y, T.zRear));
      // a forked tail fin, a tall back fin that cuts the surface, two small side fins
      c.add(cardAt([0, 0.11, 0.18], [0, 0.22, 0.34], 0.085, [1, 0, 0]), 'fish.fin');
      c.add(cardAt([0, 0.09, 0.18], [0, 0.035, 0.33], 0.075, [1, 0, 0]), 'fish.fin');
      c.add(cardAt([0, 0.14, 0.06], [0, 0.33, 0.1], 0.13, [1, 0, 0]), 'fish.fin');
      // (swept back along the flanks: a stranded fish lies on one, §100 `lie`)
      for (const sd of [-1, 1]) c.add(cardAt([sd * 0.045, 0.065, -0.12], [sd * 0.098, 0.035, -0.025], 0.05, [0, 1, 0]), 'fish.fin');
      return { parts: { body: c.done() }, variants: { body: ['body', null] } };
    },
  };
}

// ---- the pig: the sow, the boar (tusks), the piglet (small) ----------------------------------------------------------

const PIG = Object.freeze({
  skin: [0xf8c8cf, 0xf2a7b5, 0xd98896, 0x9a5866], snout: [0xf6b0bc, 0xe8909e, 0xb8606e], dark: 0x3a1f26, mud: 0x7a5a3e, tusk: [0xfaf4e4, 0xf0e6cc, 0xc8b898],
  trunk: { y: 0.58, zRear: 0.46, L: 0.86, rx: 0.285, rz: 0.29, rings: [[0, 0.34, 0.38, -0.03], [0.06, 0.68, 0.7, -0.015], [0.16, 0.87, 0.88, 0], [0.32, 0.97, 0.98, 0.01], [0.5, 1.02, 1.04, 0.01], [0.68, 0.98, 1.0, 0.01], [0.84, 0.87, 0.9, 0], [0.94, 0.74, 0.8, 0], [1, 0.55, 0.64, 0]] },
  head: { rx: 0.17, rz: 0.16, rings: [[0, 0.88, 0.92], [0.15, 1, 1], [0.5, 0.92, 0.9, -0.01], [0.82, 0.66, 0.64, -0.02], [1, 0.56, 0.54, -0.024]] },
});

/** @returns {KindSpec} */
function pigSpec() {
  const P = PIG;
  const T = P.trunk;
  const H = P.head;
  const R = ANIMAL_RIGS.pig;
  const headO = { rx: H.rx, rz: H.rz };
  /** pink skin with fine pale bristles */
  const bristles = (p, k = 1) => {
    coat(p, P.skin, { len: 1.6, density: 0.25 * k, light: 0.06, dark: 0.16, mottle: 0.25, scale: 8, strokes: [P.skin[0], 0xfff0f0] });
    return p;
  };
  return {
    paint(s) {
      const [tw, th] = stripSize(T.rx * 1.02, T.rz * 1.02, T.L, D.body);
      s.wrap('pig.trunk', tw, th, (p) => {
        bristles(p);
        // a row of teats down the belly, a few darker freckles
        for (let y = p.h * 0.25; y < p.h * 0.85; y += p.h * 0.12) for (const u of [0.46, 0.54]) p.ellipse(u * p.w, y, 1.5, 1.5, P.skin[2], 0.7);
        const rnd = makeRng(4);
        for (let i = 0; i < 10; i++) p.glow(rnd() * p.w, rnd() * p.h, 2 + rnd() * 3, P.skin[2], 0.3);
        endShade(p, 0.2, 0.12, 0.1);
      }, { cap: [36, 36], bottom: (p) => bristles(p) });
      const [hw, hh] = stripSize(H.rx, H.rz, 0.34, D.head * 0.9);
      s.wrap('pig.head', hw, hh, (p) => {
        bristles(p, 1.5);
        eyes(p, headO, 52, p.h * 0.62, 3.6, { white: true, lashes: true, rim: P.skin[2] });
        // rosy cheeks below the eyes
        for (const deg of [70, 290]) p.glow(uAt(headO, deg) * p.w, p.h * 0.42, 6, 0xf08a9a, 0.5, 4);
        endShade(p, 0, 0.2, 0.12);
      }, { cap: [20, 20] });
      s.wrap('pig.snout', 28, 14, (p) => { p.fill(P.snout[1]).mottle(0.05, 3); p.shadeV(1.08, 0.86); }, {
        cap: [26, 22],
        top: (p) => {
          p.fill(P.snout[1]).mottle(0.04, 3);
          p.ellipse(13, 11, 12, 9.5, P.snout[0], 0.6);
          p.ellipse(8.5, 11, 2.2, 3.4, P.dark, 1).ellipse(17.5, 11, 2.2, 3.4, P.dark, 1);
          p.ellipse(8, 9.5, 0.8, 1.1, 0xffd0d8, 0.6).ellipse(17, 9.5, 0.8, 1.1, 0xffd0d8, 0.6);
        },
      });
      s.plain('pig.ear', 22, 22, (p) => { bristles(p); p.glow(11, 12, 7, P.skin[2], 0.6, 8); p.ao({ bottom: 0.3, width: 0.3 }); });
      const [lw, lh] = stripSize(0.065, 0.065, R.legH + 0.1, D.limb);
      s.wrap('pig.leg', lw, lh, (p) => {
        bristles(p);
        // a little mud on the trotters, the cloven hoof dark
        for (let y = Math.floor(p.h * 0.6); y < p.h; y++) for (let x = 0; x < p.w; x++) if (fbm(x / 3, y / 3, 7) > 0.45 - (y / p.h - 0.6)) p.px(x, y, shade(P.mud, 0.9 + 0.2 * hash2(x, y, 2)), 0.8);
        hoof(p, P.skin[3], 0.12, { shine: P.skin[2] });
        p.line(p.w * 0.5, p.h * 0.9, p.w * 0.5, p.h, 0.6, P.dark, 0.9);
        endShade(p, 0.3, 0, 0.25);
      }, { cap: [10, 10], bottom: (p) => p.fill(P.skin[3]) });
      s.wrap('pig.tail', 8, 32, (p) => bristles(p));
      s.wrap('pig.tusk', 10, 20, (p) => p.fill((x, y) => mix(P.tusk[0], P.tusk[2], y / p.h)));
      s.wrap('pig.ribbon', 24, 8, (p) => { p.fill(0x3d9a7a).mottle(0.05, 3); p.line(0, 1.5, p.w, 1.5, 0.5, 0x9ce4c4, 0.8); });
      s.plain('pig.bow', 16, 16, (p) => { p.fill(0x3d9a7a); p.glow(8, 6, 7, 0x9ce4c4, 0.5); p.ao({ bottom: 0.4, width: 0.4 }); });
    },
    build(s) {
      const c = collector(s);
      c.add(trunkGeo(T), 'pig.trunk', ahead(T.y, T.zRear));
      // the tail: a tight curl
      const curl = [[0, 0.68, 0.45], [0, 0.72, 0.5], [0.025, 0.76, 0.52], [0.045, 0.73, 0.5], [0.03, 0.7, 0.49], [0.01, 0.72, 0.53]];
      c.add(swept(curl, 0.016, [1, 1, 0.95, 0.9, 0.8, 0.7, 0.55, 0.3], { sides: 4, segments: 7, up: [0.7, 0.3, -0.6] }), 'pig.tail');
      const body = c.done();
      const h = collector(s);
      h.add(along([0, 0.71, -0.33], [0, 0.6, -0.65], H.rx, H.rz, H.rings), 'pig.head');
      h.add(along([0, 0.59, -0.62], [0, 0.585, -0.74], 0.075, 0.062, [[0, 0.92], [0.7, 1.0], [1, 1.04]], { phase: 0 }), 'pig.snout');
      // ears: broad and floppy, tipped forward over the eyes
      for (const sd of [-1, 1]) h.add(wedge({ w: 0.13, h: 0.15, d: 0.03, sx: 0.3, ridge: 0.3 }), 'pig.ear', compose({ t: [sd * 0.105, 0.79, -0.4], r: [-2.25, sd * 0.35, sd * -0.55], order: 'YXZ' }));
      const tusks = collector(s);
      for (const sd of [-1, 1]) tusks.add(swept([[sd * 0.06, 0.56, -0.68], [sd * 0.085, 0.6, -0.7], [sd * 0.09, 0.66, -0.69]], 0.014, [1, 0.7, 0.3, 0], { sides: 4, segments: 3, up: [0, 0, -1] }), 'pig.tusk');
      const t = collector(s);
      t.add(along([0, 0.55, -0.34], [0, 0.6, -0.4], 0.17, 0.18, [[0, 1.07], [1, 1.07]], { caps: false }), 'pig.ribbon');
      for (const sd of [-1, 1]) t.add(wedge({ w: 0.08, h: 0.06, d: 0.02, sx: 0.3 }), 'pig.bow', compose({ t: [sd * 0.035, 0.8, -0.3], r: [0, 0, sd * PI / 2] }));
      const leg = s.place(legGeo({ H: R.legH, r: 0.065, rings: [[0, 1.25], [0.5, 0.9, 0.01], [0.86, 0.85], [0.92, 1.0], [1, 0.95]] }), 'pig.leg');
      return { parts: { body, head: h.done(), legs: leg, tusks: tusks.done(), tag: t.done() }, variants: { body: ['body', 'head'] } };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The snare's loop (every kind's: drawn on a snared animal's hind leg, sized by the rig's legW)
// ---------------------------------------------------------------------------------------------------

/** @param {Skin} s */
function snareParts(s) {
  const c = collector(s);
  // a cord loop round the ankle (unit: the leg's width 1) and the cord running back to the peg
  c.add(loft({ sides: 6, rx: 0.66, rz: 0.66, phase: 0, rings: [{ y: 0, sx: 1 }, { y: 0.1, sx: 1.12 }, { y: 0.22, sx: 1 }] }), 'snare.cord');
  c.add(sweep({ points: [[0, 0.1, 0.62], [0, 0.0, 1.8], [0, -0.45, 3.4]], sides: 4, rx: 0.1, profile: () => 1, segments: 3, up: [1, 0, 0] }), 'snare.cord');
  return c.done();
}

// ---------------------------------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------------------------------

/** @type {Record<string, () => KindSpec>} */
const SPECS = { cow: cowSpec, sheep: sheepSpec, horse: horseSpec, wolf: wolfSpec, deer: deerSpec, rabbit: rabbitSpec, pheasant: pheasantSpec, turkey: turkeySpec, bear: bearSpec, fish: fishSpec, pig: pigSpec };

/**
 * @typedef {Object} FaunaModels
 * @property {Img} image            the shared atlas (RGBA, sRGB bytes, row 0 at the top: a DataTexture with flipY off)
 * @property {[number, number]} atlas
 * @property {number} texels        pixels painted (the rectangles, not their gutters)
 * @property {Record<string, KindModel>} kinds  MODEL_KINDS
 * @property {Geo} snare            the snare's loop (unit size: scaled by a rig's legW)
 */

/** Build every kind's parts over one painted atlas (the pure work; animalModels() caches it). @returns {FaunaModels} */
export function buildAnimalModels() {
  const s = new Skin(ANIMAL_ATLAS, ANIMAL_ATLAS, 61);
  const specs = MODEL_KINDS.map((k) => SPECS[k]());
  for (const sp of specs) sp.paint(s);
  s.wrap('snare.cord', 16, 8, (p) => { p.fill(0xc8a86a); for (let x = 0; x < p.w; x += 2) p.line(x, 0, x + 3, p.h, 0.5, 0x8a6a3a, 0.7); });
  /** @type {Record<string, KindModel>} */
  const kinds = {};
  MODEL_KINDS.forEach((k, i) => { kinds[k] = specs[i].build(s); });
  const snare = snareParts(s);
  s.pack();
  return { image: s.atlas.img, atlas: [s.atlas.img.width, s.atlas.img.height], texels: s.atlas.used(), kinds, snare };
}

/** @type {FaunaModels|null} */
let cached = null;
/** Every kind's models, built once and shared (both renderers, the gallery). @returns {FaunaModels} */
export function animalModels() {
  if (!cached) cached = buildAnimalModels();
  return cached;
}

/**
 * The triangles of a kind's whole animal in a variant: its trunk, its head, its legs and (a bird in the air) its wings.
 * @param {FaunaModels} m @param {string} kind @param {string} [variant]
 */
export function variantTriangles(m, kind, variant = 'body') {
  const K = m.kinds[kind];
  const [trunk, head, legKey = 'legs'] = K.variants[variant] ?? K.variants.body;
  const rig = /** @type {AnimalRig} */ (/** @type {*} */ (ANIMAL_RIGS)[kind]);
  const legs = typeof rig.legs === 'number' ? rig.legs : 4;
  const legPart = legKey ? K.parts[legKey] : null;
  return triangleCount(K.parts[/** @type {string} */ (trunk)]) + (head ? triangleCount(K.parts[head]) : 0) + (legPart ? legs * triangleCount(legPart) : 0) +
    (K.parts.wings ? 2 * triangleCount(K.parts.wings) : 0);
}

/**
 * The bounds of a kind's trunk and head in a variant, at rest (model space; the legs and wings left out): the reach of
 * its body, horns, antlers, ears, tail and fan — what the tests measure.
 * @param {FaunaModels} m @param {string} kind @param {string} [variant]
 * @returns {{ min: number[], max: number[] }}
 */
export function variantBounds(m, kind, variant = 'body') {
  const K = m.kinds[kind];
  const [trunk, head] = K.variants[variant] ?? K.variants.body;
  const b = [K.parts[/** @type {string} */ (trunk)], ...(head ? [K.parts[head]] : [])].map(bounds);
  return { min: [0, 1, 2].map((a) => Math.min(...b.map((x) => x.min[a]))), max: [0, 1, 2].map((a) => Math.max(...b.map((x) => x.max[a]))) };
}

/**
 * A kind standing at rest in a variant as ONE geometry (its trunk, head and legs placed as the renderer hangs them, no
 * stride): the art pilot's and the gallery's form. @param {string} kind @param {string} [variant]
 * @returns {{ geo: Geo, image: Img, tris: number, texels: number, atlas: [number, number] }}
 */
export function restModel(kind, variant = 'body') {
  const m = animalModels();
  const K = m.kinds[kind];
  const rig = /** @type {AnimalRig} */ (/** @type {*} */ (ANIMAL_RIGS)[kind]);
  const [trunk, head, legKey = 'legs'] = K.variants[variant] ?? K.variants.body;
  const parts = [K.parts[/** @type {string} */ (trunk)]];
  if (head) parts.push(K.parts[head]);
  const leg = legKey ? K.parts[legKey] : null;
  const n = typeof rig.legs === 'number' ? rig.legs : 4;
  if (leg) {
    for (let i = 0; i < n; i++) {
      const sx = i % 2 === 0 ? -1 : 1;
      const front = n === 2 || i < 2;
      const M = translation(sx * rig.legX, rig.legH, front ? rig.legZ[0] : rig.legZ[/** @type {number} */ (rig.legZ.length - 1)]);
      parts.push(transform(leg, front && rig.turn && n === 4 ? mul(M, rotation(1, PI)) : M));
    }
  }
  const geo = merge(parts);
  return { geo, image: m.image, tris: triangleCount(geo), texels: m.texels, atlas: m.atlas };
}
