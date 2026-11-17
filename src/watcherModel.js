// Caelancraft — the Hollow Watcher's figure as geometry and paint (PURE: typed arrays, no three, no DOM). See
// src/CONTRACTS.md §40.4 and §104; watcherRenderer.js draws it.
//
// Built from the world's own cell shape, and hollow, in the hex-faceted look of the rest of the world (docs/
// DESIGN-characters.md): a floating stack of RING_COUNT open hexagonal BANDS (thin walls, pointy-top like the cells, their
// outer edges CHAMFERED so each catches a line of light), widest in the middle, with gaps between them you can see
// through; on top a hex LANTERN — a heavier chamfered band top and bottom, six slim tapered hex posts, open sides — round
// a faceted CRYSTAL (a hex bipyramid, the dim inner glow) and the two small cyan lights; under the lowest ring a wisp of
// smoke (three shrinking hex tubes). No legs, no arms, no face.
// The stone is painted on ONE 256² atlas (paintKit): weathered ash grey, mottled and pitted, split by thin cracks; every
// band's strip is shaded across its section (the outer wall lit, the top paler, the underside darker, the inner wall
// darkest: the hollow reads) and its cracks fall differently on every ring (each starts its strip at its own corner). A
// GLOW image in step with it is what the stone gives off: the stone itself at WATCHER_SELF_LIGHT of its brightness (by
// night it still reads as pale stone, never a black shape) and the cracks bright cyan.
import { loft, ringLoft, merge, translation, triangleCount } from './modelKit.js';
import { Painter, createImage, bleed, makeRng, shade, mix } from './paintKit.js';
import { Skin } from './figureKit.js';

/** @typedef {import('./modelKit.js').Geo} Geo */
/** @typedef {import('./paintKit.js').Img} Img */

const COS30 = Math.cos(Math.PI / 6);
const SIXTH = Math.PI / 3;

// ---- the body: hollow rings ---------------------------------------------------------------------------------------
export const RING_COUNT = 5;
/** Each ring's outer circumradius (= its side length), bottom to top: widest in the middle. */
export const RING_R = Object.freeze([0.19, 0.26, 0.3, 0.26, 0.2]);
/** Wall thickness across the flats (m): thin, so the rings read as open frames. */
export const RING_WALL = 0.035;
export const RING_H = 0.12;
/** The chamfer on a ring's outer top and bottom edges (m). */
export const RING_CHAMFER = 0.012;
/** The open gap between two rings (m), before bobbing: wider than a ring, so the figure reads as hollow. */
export const RING_GAP = 0.14;
/** The lowest ring's underside above the feet: the stack floats; the smoke wisp fills the space below. */
export const RING_BASE_Y = 0.72;
/** The space between the top ring and the lantern. */
export const NECK_GAP = 0.16;

// ---- the head: a hex lantern --------------------------------------------------------------------------------------
/** The lantern's base (the head pivot) above the feet. */
export const HEAD_Y = RING_BASE_Y + RING_COUNT * RING_H + (RING_COUNT - 1) * RING_GAP + NECK_GAP;
export const LANTERN_H = 0.56;
/** RING_BASE_Y + 5 rings + 4 gaps + NECK_GAP + LANTERN_H = watcher.WATCHER_HEIGHT (2.6). */
export const MODEL_HEIGHT = HEAD_Y + LANTERN_H;
/** The lantern: circumradius, its two heavier rims (height, wall) and six slim corner posts. Flat front (−Z). */
export const LANTERN_R = 0.22;
export const LANTERN_RIM_H = 0.07;
export const LANTERN_WALL = 0.05;
export const POST_R = 0.017;
/** The crystal: a hex bipyramid in the lantern (pivot frame y CORE_Y … CORE_Y + CORE_H), widest CORE_R. */
export const CORE_R = 0.075;
export const CORE_H = 0.2;
export const CORE_Y = 0.24;

// ---- the smoke wisp -----------------------------------------------------------------------------------------------
/**
 * Three stacked hex tubes under the lowest ring, shrinking and fading toward the ground: y0 … y1 (feet frame), radius
 * r0 (bottom) → r1 (top), vertex alpha a0 → a1.
 */
export const SMOKE = Object.freeze([
  Object.freeze({ y0: 0.46, y1: 0.7, r0: 0.075, r1: 0.11, a0: 0.26, a1: 0.4 }),
  Object.freeze({ y0: 0.24, y1: 0.44, r0: 0.05, r1: 0.07, a0: 0.16, a1: 0.24 }),
  Object.freeze({ y0: 0.02, y1: 0.22, r0: 0.025, r1: 0.045, a0: 0.04, a1: 0.14 }),
]);

// ---- the paint ----------------------------------------------------------------------------------------------------
/** The stone's ramp: weathered ash grey [light, mid, dark]. */
export const WATCHER_ASH = Object.freeze([0xa8a6a0, 0x8a8884, 0x6a6966]);
/** A crack's groove in the stone, and its glow. */
export const CRACK_GROOVE = 0x2b3d40;
export const CRACK_LIGHT = 0x5ae6f0;
/** The glow image away from the cracks: the stone at this share of its brightness (its faint self-light). */
export const WATCHER_SELF_LIGHT = 0.4;
/** The shades painted across a band's section: the outer wall, its chamfers, the top, the underside, the inner wall. */
export const BAND_SHADE = Object.freeze({ outer: 1, chamfer: 0.94, top: 0.9, bottom: 0.72, inner: 0.5 });
/** Texels per metre of the stone and the smoke. */
export const WATCHER_DENSITY = 128;
/** The atlas (and glow image), pixels square. */
export const WATCHER_ATLAS = 256;

/**
 * A hollow hexagonal BAND, its outer top and bottom edges chamfered `c`: outer circumradius R, a wall `wall` thick across
 * the flats, `h` tall from y 0, corner 0 at angle a0 (in the x–z plane from +X toward +Z) — six mitred facets swept round
 * the section (inner bottom, the bottom, the lower chamfer, the outer wall, the upper chamfer, the top, the inner wall).
 * Its strip's u runs round that section (BAND_ZONES: where each face lies on it), v round the hexagon from corner
 * `start`. A closed solid wound outward.
 * @param {{ R: number, wall: number, h: number, a0: number, c?: number, start?: number }} o
 * @returns {Geo}
 */
export function hexBand({ R, wall, h, a0, c = 0, start = 0 }) {
  const Ri = R - wall / COS30;
  const cc = Math.min(c, wall * COS30 * 0.45, h * 0.3);
  // the section as (radius at a corner, height): inner bottom → outer, up the outer wall, back over the top, down inside
  const section = [[Ri, 0], [R - cc / COS30, 0], [R, cc], [R, h - cc], [R - cc / COS30, h], [Ri, h]];
  const rings = [];
  for (let k = 0; k <= 6; k++) {
    const a = a0 + ((k + start) % 6) * SIXTH;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    rings.push(section.map(([r, y]) => [r * dx, y, r * dz]));
  }
  return ringLoft({ rings });
}

/**
 * Where each face of a band lies across its strip (u, 0..1): [name, u0, u1] in section order — the ringLoft strip runs
 * round the section from the inner bottom corner.
 * @param {{ R: number, wall: number, h: number, c?: number }} o
 * @returns {[string, number, number][]}
 */
export function bandZones({ R, wall, h, c = 0 }) {
  const Ri = R - wall / COS30;
  const cc = Math.min(c, wall * COS30 * 0.45, h * 0.3);
  const pts = [[Ri, 0], [R - cc / COS30, 0], [R, cc], [R, h - cc], [R - cc / COS30, h], [Ri, h]];
  const names = ['bottom', 'chamfer', 'outer', 'chamfer', 'top', 'inner'];
  const lens = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const total = lens.reduce((a, b) => a + b, 0);
  let u = 0;
  return names.map((n, i) => {
    const z = /** @type {[string, number, number]} */ ([n, u, u + lens[i] / total]);
    u += lens[i] / total;
    return z;
  });
}

/**
 * A built Watcher.
 * @typedef {Object} WatcherModel
 * @property {Geo[]} rings      ring i in its own frame (its underside at y 0, its axis on y), bottom to top
 * @property {Geo} lantern      the rims and posts in the head pivot's frame (y 0 … LANTERN_H)
 * @property {Geo} core         the crystal in the head pivot's frame
 * @property {Geo} smoke        the wisp's tubes (feet frame), sides only
 * @property {Float32Array} smokeAlpha  one alpha per smoke vertex (fading toward the ground)
 * @property {Img} image        the atlas (sRGB bytes, row 0 at the top)
 * @property {Img} glow         what the stone gives off, in step with the atlas
 * @property {number} tris
 */

/**
 * Paint the stone (and its glow) on a band's strip: the section's shades across it, mottle and pits, and cracks over
 * the outer wall (wandering round the ring) that glow.
 * @param {Painter} p @param {Painter} g  the same rectangle on the atlas and on the glow image
 * @param {[string, number, number][]} zones @param {number} seed
 */
function paintBandStone(p, g, zones, seed) {
  p.stone([...WATCHER_ASH]);
  p.mottle(0.08, 9, seed + 3);
  const rnd = makeRng(seed);
  // pits
  for (let i = 0; i < (p.w * p.h) / 70; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 0.6 + rnd() * 0.7, 0.6 + rnd() * 0.7, WATCHER_ASH[2], 0.55);
  const zone = (u) => zones.find(([, u0, u1]) => u >= u0 && u <= u1) ?? zones[0];
  // the section's shades, column by column (u across the strip)
  for (let x = 0; x < p.w; x++) {
    const [name] = zone((x + 0.5) / p.w);
    const k = BAND_SHADE[/** @type {keyof typeof BAND_SHADE} */ (name)];
    for (let y = 0; y < p.h; y++) p.tone(x, y, k);
  }
  // the glow: the stone dimmed
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) g.px(x, y, shade(p.get(x, y), WATCHER_SELF_LIGHT), 1);
  // the cracks: thin lines wandering round the outer wall (down the strip), now and then across its chamfers
  const [, o0, o1] = zones.find(([n]) => n === 'outer') ?? ['outer', 0, 1];
  const x0 = o0 * p.w;
  const x1 = o1 * p.w;
  const n = Math.max(2, Math.round(p.h / 60));
  for (let i = 0; i < n; i++) {
    let x = x0 + (0.2 + 0.6 * rnd()) * (x1 - x0);
    let y = rnd() * p.h;
    const pts = [[x, y]];
    const steps = 5 + Math.floor(rnd() * 4);
    for (let k = 0; k < steps; k++) {
      x = Math.min(x1 + 1, Math.max(x0 - 1, x + (rnd() - 0.5) * 6));
      y += 2.5 + rnd() * 4;
      pts.push([x, y]);
      if (rnd() < 0.25) {
        const bx = x + (rnd() < 0.5 ? -1 : 1) * (2 + rnd() * 3);
        p.line(x, y, bx, y + 2 + rnd() * 2, 0.45, CRACK_GROOVE, 0.9);
        g.line(x, y, bx, y + 2 + rnd() * 2, 0.45, CRACK_LIGHT, 1);
      }
    }
    p.polyline(pts, 0.6, CRACK_GROOVE, 0.95);
    g.polyline(pts, 0.6, CRACK_LIGHT, 1);
  }
}

/**
 * Build the Watcher's figure.
 * @returns {WatcherModel}
 */
export function buildWatcherModel() {
  const s = new Skin(WATCHER_ATLAS, WATCHER_ATLAS, 71);
  const glow = createImage(WATCHER_ATLAS, WATCHER_ATLAS);
  const D = WATCHER_DENSITY;
  const glowOf = (p) => new Painter(glow, [p.ox, p.oy, p.w, p.h], p.seed);
  // one strip shared by the rings (each starts it at its own corner, so the cracks fall differently), one for the rims
  const ringSpec = { R: RING_R[2], wall: RING_WALL, h: RING_H, c: RING_CHAMFER };
  const ringZones = bandZones(ringSpec);
  const sectionLen = (o) => {
    const Ri = o.R - o.wall / COS30;
    return 2 * (o.R - Ri) + 2 * o.h;
  };
  s.plain('band', Math.round(sectionLen(ringSpec) * D * 1.4), Math.round(6 * RING_R[2] * D * 0.75), (p) => paintBandStone(p, glowOf(p), ringZones, 11));
  const rimSpec = { R: LANTERN_R, wall: LANTERN_WALL, h: LANTERN_RIM_H, c: RING_CHAMFER };
  const rimZones = bandZones(rimSpec);
  s.plain('rim', Math.round(sectionLen(rimSpec) * D * 1.6), Math.round(6 * LANTERN_R * D * 0.8), (p) => paintBandStone(p, glowOf(p), rimZones, 23));
  s.wrap('post', 16, Math.round((LANTERN_H - 2 * LANTERN_RIM_H) * D * 0.7), (p) => {
    p.stone([...WATCHER_ASH]).mottle(0.1, 5).shadeV(1.0, 0.9);
    const g = glowOf(p);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) g.px(x, y, shade(p.get(x, y), WATCHER_SELF_LIGHT), 1);
    const x = p.w * 0.5;
    p.polyline([[x, 2], [x + 1.5, 9], [x - 1, 17], [x + 0.5, 26]], 0.5, CRACK_GROOVE, 0.9);
    g.polyline([[x, 2], [x + 1.5, 9], [x - 1, 17], [x + 0.5, 26]], 0.5, CRACK_LIGHT, 1);
  }, {
    cap: [6, 6],
    top: (p) => { p.fill(shade(WATCHER_ASH[1], 0.9)); glowOf(p).fill(shade(WATCHER_ASH[1], 0.9 * WATCHER_SELF_LIGHT)); },
    bottom: (p) => { p.fill(shade(WATCHER_ASH[1], 0.72)); glowOf(p).fill(shade(WATCHER_ASH[1], 0.72 * WATCHER_SELF_LIGHT)); },
  });
  // the smoke: dark soot with lighter wisps rising (no glow)
  s.wrap('smoke', 48, 40, (p) => {
    p.fill(0x2a2b2e).mottle(0.18, 4);
    const rnd = makeRng(5);
    for (let i = 0; i < 7; i++) {
      let x = rnd() * p.w;
      let y = p.h;
      const pts = [[x, y]];
      for (let k = 0; k < 6; k++) {
        x += (rnd() - 0.5) * 5;
        y -= 4 + rnd() * 5;
        pts.push([x, y]);
      }
      p.polyline(pts, 1.1, mix(0x2a2b2e, 0x5a5c61, 0.6), 0.6);
    }
  }, { cap: [4, 4] });
  s.pack();
  // the glow image: no light where the atlas has none, bled like the atlas
  for (const r of s.atlas.rects) bleed(glow, r, s.atlas.pad);

  const rings = RING_R.map((R, i) => s.place(hexBand({ R, wall: RING_WALL, h: RING_H, a0: -Math.PI / 6, c: RING_CHAMFER, start: (i * 2 + 1) % 6 }), 'band'));
  // the lantern (its pivot frame): two heavier bands, six slim tapered posts on their middle line (flat front: corner 0 on +X)
  const parts = [
    s.place(hexBand({ R: LANTERN_R, wall: LANTERN_WALL, h: LANTERN_RIM_H, a0: 0, c: RING_CHAMFER, start: 0 }), 'rim'),
    s.place(hexBand({ R: LANTERN_R, wall: LANTERN_WALL, h: LANTERN_RIM_H, a0: 0, c: RING_CHAMFER, start: 3 }), 'rim', translation(0, LANTERN_H - LANTERN_RIM_H, 0)),
  ];
  const mid = LANTERN_R - LANTERN_WALL / 2 / COS30;
  const postH = LANTERN_H - 2 * LANTERN_RIM_H;
  for (let k = 0; k < 6; k++) {
    const a = k * SIXTH;
    const post = loft({ sides: 6, rx: POST_R, rings: [{ y: 0, sx: 1.12 }, { y: postH * 0.5, sx: 0.88 }, { y: postH, sx: 1.06 }], phase: 0 });
    parts.push(s.place(post, 'post', translation(mid * Math.cos(a), LANTERN_RIM_H, mid * Math.sin(a))));
  }
  const lantern = merge(parts);
  // the crystal: a hex bipyramid, widest a little below its middle
  const core = loft({
    sides: 6, rx: CORE_R, phase: 0,
    rings: [{ y: CORE_Y, sx: 0 }, { y: CORE_Y + CORE_H * 0.4, sx: 1 }, { y: CORE_Y + CORE_H * 0.62, sx: 0.92 }, { y: CORE_Y + CORE_H, sx: 0 }],
  });
  // the smoke: open hex tubes, each a little turned against the one above, fading toward the ground
  const tubes = [];
  const alphas = [];
  SMOKE.forEach(({ y0, y1, r0, r1, a0, a1 }, i) => {
    const tube = s.place(loft({ sides: 6, rx: r1, rings: [{ y: 0, sx: r0 / r1 }, { y: y1 - y0, sx: 1 }], phase: 0.4 * i, caps: false }), 'smoke', translation(0, y0, 0));
    for (let v = 0; v < tube.positions.length / 3; v++) {
      const t = (tube.positions[v * 3 + 1] - y0) / (y1 - y0);
      alphas.push(a0 + (a1 - a0) * Math.min(1, Math.max(0, t)));
    }
    tubes.push(tube);
  });
  const smoke = merge(tubes);
  const tris = rings.reduce((n, g) => n + triangleCount(g), 0) + triangleCount(lantern) + triangleCount(core) + triangleCount(smoke);
  return { rings, lantern, core, smoke, smokeAlpha: new Float32Array(alphas), image: s.atlas.img, glow, tris };
}

/** @type {WatcherModel|null} */
let built = null;

/** The Watcher's figure, built once and shared. @returns {WatcherModel} */
export function watcherModel() {
  if (!built) built = buildWatcherModel();
  return built;
}
