// Caelancraft — the Hollow Watcher's figure (three). See src/CONTRACTS.md §40.4.
//
// Built from the world's own cell shape, and hollow: a floating stack of RING_COUNT open hexagonal rings (thin-walled
// hex bands, axis vertical, pointy-top like the cells), widest in the middle, with gaps between them you can see
// through; each turns very slowly its own way and bobs a few centimetres. On top a hex LANTERN — a heavier ring top and
// bottom, six slim corner posts, open sides, a dim inner glow — holds the only bright features: two small cyan lights
// side by side inside its front, unlit and fog-free (MeshBasicMaterial, fog: false), each with a soft additive glow
// sprite that keeps a few pixels' size however far away it stands, so they read through fog and darkness. No legs, no
// arms, no face: under the lowest ring a thin wisp of dark smoke (three shrinking, fading hex tubes) trails to the
// ground. Material: weathered ash-grey stone (watcher_stone) split by thin cracks that glow cyan and pulse slowly. The
// glow is its own tile (watcher_cracks: the stone dimmed, its cracks bright cyan) read as the emissive map through a
// clone of the atlas shifted one tile right, so the cracks shine and by night the stone stays faintly pale, not black.
// ONE group of a handful of meshes (one figure), origin at the feet (the cell floor), facing −Z: translate · rotateY(yaw)
// like the zombies; the lantern turns on its own (headYaw − yaw) and tilts (headPitch).
// prewarm() pays every shader cost while the game loads (like campfireRenderer / fallingRenderer): it compiles the
// programs against the real scene and has every part draw once, hidden, in the first rendered frame.
import * as THREE from 'three';
import { ATLAS_TILE_PX, TILE_UV } from './config.js';
import { TILE, tileToUV } from './blocks.js';
import { WATCHER_EYE_Y } from './watcher.js';

/** @typedef {import('./watcher.js').WatcherFigure} WatcherFigure */

const COS30 = Math.cos(Math.PI / 6);
const SIXTH = Math.PI / 3;
const TWO_PI = Math.PI * 2;

// ---- the body: hollow rings ---------------------------------------------------------------------------------------
export const RING_COUNT = 5;
/** Each ring's outer circumradius (= its side length), bottom to top: widest in the middle. */
export const RING_R = Object.freeze([0.19, 0.26, 0.3, 0.26, 0.2]);
/** Wall thickness across the flats (m): thin, so the rings read as open frames. */
export const RING_WALL = 0.035;
export const RING_H = 0.12;
/** The open gap between two rings (m), before bobbing: wider than a ring, so the figure reads as hollow. */
export const RING_GAP = 0.14;
/** The lowest ring's underside above the feet: the stack floats; the smoke wisp fills the space below. */
export const RING_BASE_Y = 0.72;
/** Each ring's turn at time 0 (rad) and its own slow turn rate (rad/s), alternating directions. */
export const RING_PHASE = Object.freeze([0, 0.33, 0.12, 0.47, 0.21]);
export const RING_SPIN = Object.freeze([0.045, -0.03, 0.02, -0.035, 0.05]);
/** The rings bob ±RING_BOB (m) over RING_BOB_S seconds, each RING_BOB_STEP rad behind the one below. */
export const RING_BOB = 0.02;
export const RING_BOB_S = 5.5;
export const RING_BOB_STEP = 1.1;
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
/**
 * The dim inner glow: a small hex prism in the lantern (pivot frame y CORE_Y … CORE_Y + CORE_H), unlit, fogged and
 * translucent with normal blending — a faint teal light in the dark, a muted teal crystal by day (additive would turn
 * it into a bright pale panel against the daytime sky, outshining the two lights).
 */
export const CORE_R = 0.075;
export const CORE_H = 0.2;
export const CORE_Y = 0.24;
export const CORE_COLOR = 0x0f4c55;
export const CORE_OPACITY = 0.55;
/** The two lights: small pointy-top hexagons (circumradius EYE_R) at (±EYE_X, WATCHER_EYE_Y), inside the front window. */
export const EYE_X = 0.045;
export const EYE_R = 0.021;
/** Their depth: behind the lantern's front plane (z = −LANTERN_R·cos 30°), in front of the core. */
export const EYE_Z = -0.14;
export const EYE_COLOR = 0x7ff8ff;
export const GLOW_COLOR = 0x39d8f0;
/** A glow sprite is at least this wide (m) … */
export const GLOW_MIN = 0.16;
/** … and this wide per metre of distance (≈ 6 px at 720p), so the lights never shrink below a few pixels. */
export const GLOW_PER_M = 0.012;

// ---- the stone and its cracks -------------------------------------------------------------------------------------
/**
 * The stone's self-light: emissive white × the watcher_cracks tile (the stone at 0.4 of its brightness, so by night it
 * still reads as pale stone, and its cracks bright cyan), at intensity CRACK_GLOW · (1 ± CRACK_PULSE) over
 * CRACK_PULSE_S seconds.
 */
export const CRACK_GLOW = 0.75;
export const CRACK_PULSE = 0.35;
export const CRACK_PULSE_S = 6.5;
/** Vertex shades of the stone: outer walls, top faces, undersides, and the inner walls (darker: the figure is hollow). */
export const SHADE_OUTER = 1;
export const SHADE_TOP = 0.9;
export const SHADE_BOTTOM = 0.72;
export const SHADE_INNER = 0.5;
/** Untextured fallbacks (tests: no atlas). */
const STONE_PLAIN = 0x8b8984;
const SMOKE_PLAIN = 0x2c2d30;

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
/** The wisp turns slowly as one (rad/s). */
export const SMOKE_SPIN = 0.3;

// ---- pre-warm -----------------------------------------------------------------------------------------------------
/** prewarm's hidden draw: the whole group micro-scaled, far below the world (clipped; still a real draw call). */
export const WARM_Y = -1e4;
export const WARM_SCALE = 1e-6;

/**
 * @typedef {Object} WatcherRenderer
 * @property {(figure: WatcherFigure|null, camX: number, camY: number, camZ: number, time: number) => void} sync
 *   draw the figure (null hides it); the camera position sizes the light glows, `time` (s) drives the rings, the
 *   smoke and the crack pulse
 * @property {() => boolean} visible             the figure was drawn by the last sync
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile its programs now and draw every part
 *   once, hidden, in the next rendered frame (call it once every light of the scene exists)
 * @property {() => number} warmPending          parts that still owe prewarm's hidden draw
 * @property {() => void} dispose
 * @property {THREE.Group} group                 the figure (for tests and diagnostics)
 * @property {THREE.Group} head                  the head pivot (turns with headYaw − yaw, tilts with headPitch)
 * @property {THREE.Mesh[]} rings                bottom to top
 * @property {THREE.Mesh} lantern                the lantern's frame (rims and posts)
 * @property {THREE.Mesh} core                   the lantern's dim inner glow
 * @property {THREE.Mesh} smoke                  the wisp under the rings
 * @property {THREE.Mesh[]} eyes                 the two lights
 * @property {THREE.Sprite[]} glows
 */

// ---- geometry -----------------------------------------------------------------------------------------------------

/**
 * Geometry under construction: flat-shaded faces with atlas UVs and per-vertex colours (rgb, or rgba with `alpha`).
 * @typedef {{ pos: number[], nor: number[], uv: number[], col: number[], idx: number[], alpha: boolean }} Builder
 */

/** @param {boolean} [alpha] @returns {Builder} */
function builder(alpha = false) {
  return { pos: [], nor: [], uv: [], col: [], idx: [], alpha };
}

/** @param {Builder} b @returns {THREE.BufferGeometry} */
function toGeometry(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, b.alpha ? 4 : 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

/** How many of a tile's 16 pixels a face shows along its longer side: a window, so neighbouring faces differ. */
export const FACE_PX = 12;

/**
 * The part of tile `t` a w × h face shows, as [u0, v0, u1, v1] (v0 = the top row): a window of whole pixels, FACE_PX
 * along the face's longer side and as many along the shorter one as keep its texels square, placed by `seed` (and
 * mirrored left-right for some seeds), so the cracks fall differently on every face instead of repeating like a
 * pattern.
 */
function faceRect(t, w, h, seed) {
  const n = ATLAS_TILE_PX;
  const [U0, V0, U1, V1] = tileToUV(t);
  const wide = w >= h;
  const short = Math.min(n, Math.max(1, Math.round((FACE_PX * (wide ? h : w)) / (wide ? w : h))));
  const k = Math.abs(Math.floor(seed));
  const along = (k % (n - FACE_PX + 1)) / n; // the window's start along the long side …
  const across = ((k * 7 + 3) % (n - short + 1)) / n; // … and along the short side
  const [fu0, fu1, fv0, fv1] = wide
    ? [along, along + FACE_PX / n, across, across + short / n]
    : [across, across + short / n, along, along + FACE_PX / n];
  const ua = U0 + (U1 - U0) * fu0;
  const ub = U0 + (U1 - U0) * fu1;
  const mirror = ((k >> 1) & 1) === 1;
  return [mirror ? ub : ua, V0 + (V1 - V0) * fv0, mirror ? ua : ub, V0 + (V1 - V0) * fv1];
}

/**
 * One flat quad tl, tr, br, bl (as seen from the side its normal `n` points to) with uv rect [u0, v0, u1, v1] mapped
 * upright (tl = (u0, v0)), vertex colours `cTop` on the top edge and `cBottom` on the bottom one ([r, g, b] or
 * [r, g, b, a]). The triangles are wound counter-clockwise as seen from `n` whatever order the corners describe.
 */
function quad(b, tl, tr, br, bl, n, rect, cTop, cBottom = cTop) {
  const base = b.pos.length / 3;
  const [u0, v0, u1, v1] = rect;
  for (const p of [tl, tr, br, bl]) b.pos.push(p[0], p[1], p[2]);
  b.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
  for (let i = 0; i < 4; i++) b.nor.push(n[0], n[1], n[2]);
  for (const c of [cTop, cTop, cBottom, cBottom]) b.col.push(...c);
  // (bl − tl) × (br − tl) points toward a viewer who sees tl, bl, br counter-clockwise.
  const ax = bl[0] - tl[0], ay = bl[1] - tl[1], az = bl[2] - tl[2];
  const bx = br[0] - tl[0], by = br[1] - tl[1], bz = br[2] - tl[2];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) b.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
  else b.idx.push(base, base + 2, base + 3, base, base + 1, base + 2);
}

/** Corner k of a hexagon of circumradius r whose corner 0 is at angle a0 (x–z plane, from +X toward +Z). */
function corner(r, a0, k, y, cx = 0, cz = 0) {
  return [cx + r * Math.cos(a0 + k * SIXTH), y, cz + r * Math.sin(a0 + k * SIXTH)];
}

/** Planar cap uv: the tile's inscribed square over the hexagon of circumradius R around (cx, cz). */
function capUv(t, R, cx, cz) {
  const [u0, v0, u1, v1] = tileToUV(t);
  return (p) => [u0 + (u1 - u0) * (0.5 + (p[0] - cx) / (2 * R)), v0 + (v1 - v0) * (0.5 + (p[2] - cz) / (2 * R))];
}

/**
 * A flat horizontal convex quad p[0..3] (a cap piece, corners in order around it) with planar uvs from `uvOf`, wound
 * counter-clockwise as seen from above (`up`) or below.
 */
function capQuad(b, p, up, uvOf, c) {
  const base = b.pos.length / 3;
  for (const q of p) {
    b.pos.push(q[0], q[1], q[2]);
    b.uv.push(...uvOf(q));
    b.nor.push(0, up ? 1 : -1, 0);
    b.col.push(...c);
  }
  // y of (p1 − p0) × (p2 − p0): the side triangle 0-1-2 faces.
  const ny = (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]);
  if ((ny > 0) === up) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/**
 * A hollow hexagonal ring: outer circumradius R, wall `wall` thick across the flats, from y0 to y0 + h, corner 0 at
 * angle a0. Outer walls, inner walls (darker), top and bottom annuli; every face shows the tile with square texels.
 */
function hexRing(b, R, wall, h, y0, a0, tile, seed) {
  const Ri = R - wall / COS30;
  const y1 = y0 + h;
  const capT = capUv(tile, R, 0, 0);
  for (let j = 0; j < 6; j++) {
    const na = a0 + (j + 0.5) * SIXTH;
    const n = [Math.cos(na), 0, Math.sin(na)];
    const ni = [-n[0], 0, -n[2]];
    // Seen from outside the higher-numbered corner is on the left; from inside it is on the right.
    quad(b, corner(R, a0, j + 1, y1), corner(R, a0, j, y1), corner(R, a0, j, y0), corner(R, a0, j + 1, y0), n,
      faceRect(tile, R, h, seed + j * 5), [SHADE_OUTER, SHADE_OUTER, SHADE_OUTER]);
    quad(b, corner(Ri, a0, j, y1), corner(Ri, a0, j + 1, y1), corner(Ri, a0, j + 1, y0), corner(Ri, a0, j, y0), ni,
      faceRect(tile, Ri, h, seed + j * 3 + 7), [SHADE_INNER, SHADE_INNER, SHADE_INNER]);
    for (const [y, up, s] of [[y1, true, SHADE_TOP], [y0, false, SHADE_BOTTOM]]) {
      capQuad(b, [corner(R, a0, j, y), corner(R, a0, j + 1, y), corner(Ri, a0, j + 1, y), corner(Ri, a0, j, y)], up, capT, [s, s, s]);
    }
  }
}

/** A solid hexagonal prism (sides and caps) of circumradius R around (cx, cz), from y0 to y0 + h. */
function hexPrism(b, R, h, y0, a0, cx, cz, tile, seed) {
  const y1 = y0 + h;
  const capT = capUv(tile, R, cx, cz);
  for (let j = 0; j < 6; j++) {
    const na = a0 + (j + 0.5) * SIXTH;
    quad(b, corner(R, a0, j + 1, y1, cx, cz), corner(R, a0, j, y1, cx, cz), corner(R, a0, j, y0, cx, cz),
      corner(R, a0, j + 1, y0, cx, cz), [Math.cos(na), 0, Math.sin(na)], faceRect(tile, R, h, seed + j * 5),
      [SHADE_OUTER, SHADE_OUTER, SHADE_OUTER]);
  }
  for (const [y, up, s] of [[y1, true, SHADE_TOP], [y0, false, SHADE_BOTTOM]]) {
    const k = (i) => corner(R, a0, i, y, cx, cz);
    // Two quads (corners 0-1-2-3 and 3-4-5-0) cover the hexagon.
    capQuad(b, [k(0), k(1), k(2), k(3)], up, capT, [s, s, s]);
    capQuad(b, [k(3), k(4), k(5), k(0)], up, capT, [s, s, s]);
  }
}

/** Ring i (0 = bottom): pointy-top like the world's cells (corner 0 at −30°, corners along ±Z). */
function ringGeometry(i) {
  const b = builder();
  hexRing(b, RING_R[i], RING_WALL, RING_H, 0, -Math.PI / 6, TILE.WATCHER_STONE, i * 7);
  return toGeometry(b);
}

/**
 * The lantern frame, in the head pivot's frame (y 0 … LANTERN_H): a heavier rim top and bottom and six slim posts on
 * the corners between them. Flat front: corner 0 on +X, so side 4 (corners 4 → 5) faces −Z and frames the lights.
 */
function lanternGeometry() {
  const b = builder();
  const t = TILE.WATCHER_STONE;
  hexRing(b, LANTERN_R, LANTERN_WALL, LANTERN_RIM_H, 0, 0, t, 3);
  hexRing(b, LANTERN_R, LANTERN_WALL, LANTERN_RIM_H, LANTERN_H - LANTERN_RIM_H, 0, t, 11);
  const mid = LANTERN_R - LANTERN_WALL / 2 / COS30; // the posts stand on the rims' middle line
  for (let k = 0; k < 6; k++) {
    const [x, , z] = corner(mid, 0, k, 0);
    hexPrism(b, POST_R, LANTERN_H - 2 * LANTERN_RIM_H, LANTERN_RIM_H, 0, x, z, t, k * 3);
  }
  return toGeometry(b);
}

/** The lantern's inner glow: a plain hex prism (no texture). */
function coreGeometry() {
  const b = builder();
  hexPrism(b, CORE_R, CORE_H, CORE_Y, 0, 0, 0, TILE.WATCHER_STONE, 0);
  return toGeometry(b);
}

/** The smoke wisp: SMOKE's hex tubes (sides only), watcher_smoke texels, vertex alpha fading toward the ground. */
function smokeGeometry() {
  const b = builder(true);
  SMOKE.forEach(({ y0, y1, r0, r1, a0, a1 }, i) => {
    const off = i * 0.4; // each tube a little turned against the one above
    for (let j = 0; j < 6; j++) {
      const na = off + (j + 0.5) * SIXTH;
      quad(b, corner(r1, off, j + 1, y1), corner(r1, off, j, y1), corner(r0, off, j, y0), corner(r0, off, j + 1, y0),
        [Math.cos(na), 0, Math.sin(na)], faceRect(TILE.WATCHER_SMOKE, r1, y1 - y0, i * 5 + j * 3), [1, 1, 1, a1], [1, 1, 1, a0]);
    }
  });
  return toGeometry(b);
}

/** A soft round glow: white, alpha (1 − r)² over a 32×32 DataTexture (no DOM needed). */
function glowTexture() {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * (1 - r) * (1 - r));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Ring i's underside above the feet at rest (before bobbing). */
export function ringBaseY(i) {
  return RING_BASE_Y + i * (RING_H + RING_GAP);
}

/**
 * @param {THREE.Scene} scene
 * @param {THREE.Texture|null} atlasTexture  the block atlas (watcher_* tiles); null draws untextured (tests)
 * @returns {WatcherRenderer}
 */
export function createWatcherRenderer(scene, atlasTexture) {
  const map = atlasTexture ?? null;
  // The self-light and the crack glow: the same atlas image read one tile to the right (watcher_stone → watcher_cracks).
  // A clone shares the atlas's Source (and comes flagged for upload), so three keeps one GPU texture for both.
  let crackMap = null;
  if (map) {
    crackMap = map.clone();
    crackMap.offset.set(TILE_UV, 0);
  }
  const glowMap = glowTexture();
  const geos = {
    rings: RING_R.map((_, i) => ringGeometry(i)),
    lantern: lanternGeometry(),
    core: coreGeometry(),
    smoke: smokeGeometry(),
    // A pointy-top hexagon (thetaStart π/2 puts a corner at the top), like the cells.
    eye: new THREE.CircleGeometry(EYE_R, 6, Math.PI / 2),
  };
  const mats = {
    stone: new THREE.MeshLambertMaterial({
      map, vertexColors: true, color: map ? 0xffffff : STONE_PLAIN,
      emissive: crackMap ? 0xffffff : 0x000000, emissiveMap: crackMap, emissiveIntensity: CRACK_GLOW,
    }),
    core: new THREE.MeshBasicMaterial({
      color: CORE_COLOR, transparent: true, opacity: CORE_OPACITY, depthWrite: false,
    }),
    // One colour per tube face at a vertex alpha: blending it over itself is order-independent, so one pass will do.
    smoke: new THREE.MeshBasicMaterial({
      map, color: map ? 0xffffff : SMOKE_PLAIN, vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, forceSinglePass: true,
    }),
    // Unlit and fog-free: the lights keep their colour at any distance and in any darkness.
    eye: new THREE.MeshBasicMaterial({ color: EYE_COLOR, fog: false, side: THREE.DoubleSide }),
    glow: new THREE.SpriteMaterial({
      map: glowMap, color: GLOW_COLOR, fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  };

  const group = new THREE.Group();
  group.name = 'watcher';
  group.visible = false;
  /** Every drawable part: the ones prewarm makes draw once. @type {THREE.Object3D[]} */
  const parts = [];
  const add = (obj, name, parent, renderOrder = 0) => {
    obj.name = name;
    obj.renderOrder = renderOrder;
    parent.add(obj);
    parts.push(obj);
    return obj;
  };
  const rings = geos.rings.map((g, i) => add(new THREE.Mesh(g, mats.stone), `watcher-ring-${i}`, group));
  const smoke = add(new THREE.Mesh(geos.smoke, mats.smoke), 'watcher-smoke', group, 1);
  const head = new THREE.Group();
  head.name = 'watcher-head-pivot';
  head.position.set(0, HEAD_Y, 0);
  head.rotation.order = 'YXZ';
  group.add(head);
  const lantern = add(new THREE.Mesh(geos.lantern, mats.stone), 'watcher-lantern', head);
  const core = add(new THREE.Mesh(geos.core, mats.core), 'watcher-core', head, 1);
  /** @type {THREE.Mesh[]} */
  const eyes = [];
  /** @type {THREE.Sprite[]} */
  const glows = [];
  for (const side of [-1, 1]) {
    const eye = add(new THREE.Mesh(geos.eye, mats.eye), side < 0 ? 'watcher-eye-l' : 'watcher-eye-r', head, 2);
    eye.position.set(side * EYE_X, WATCHER_EYE_Y - HEAD_Y, EYE_Z);
    eyes.push(eye);
    const glow = add(new THREE.Sprite(mats.glow), side < 0 ? 'watcher-glow-l' : 'watcher-glow-r', head, 3);
    glow.position.set(side * EYE_X, WATCHER_EYE_Y - HEAD_Y, EYE_Z - 0.01);
    glow.scale.set(GLOW_MIN, GLOW_MIN, 1);
    glows.push(glow);
  }
  scene.add(group);

  let shown = false;
  /** Parts that still owe prewarm's hidden draw. */
  const warming = new Set();
  // three calls onAfterRender right after drawing an object: that part's warm-up draw is done. It goes back to normal
  // frustum culling, and once every part has drawn the speck is hidden again (unless a figure is shown by then).
  for (const p of parts) {
    p.onAfterRender = () => {
      if (!warming.delete(p)) return;
      p.frustumCulled = true;
      if (warming.size === 0 && !shown) {
        group.visible = false;
        group.scale.setScalar(1);
      }
    };
  }

  /** The hidden warm-up pose: the whole group visible as a micro-scaled speck far below the world. */
  function placeWarm() {
    group.visible = true;
    group.position.set(0, WARM_Y, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(WARM_SCALE);
  }

  const lightWorld = new THREE.Vector3();

  /**
   * @param {WatcherFigure|null} figure
   * @param {number} camX @param {number} camY @param {number} camZ
   * @param {number} time
   */
  function sync(figure, camX, camY, camZ, time) {
    if (!figure) {
      shown = false;
      // Still owing the warm-up draw (main syncs null every frame from the start): keep the speck.
      if (warming.size > 0) placeWarm();
      else group.visible = false;
      return;
    }
    group.visible = true;
    shown = true;
    group.scale.setScalar(1);
    group.position.set(figure.x, figure.y, figure.z);
    group.rotation.set(0, figure.yaw, 0);
    head.rotation.set(figure.headPitch || 0, (figure.headYaw ?? figure.yaw) - figure.yaw, 0);
    const t = Number.isFinite(time) ? time : 0;
    for (let i = 0; i < RING_COUNT; i++) {
      rings[i].rotation.y = RING_PHASE[i] + RING_SPIN[i] * t;
      rings[i].position.y = ringBaseY(i) + RING_BOB * Math.sin((TWO_PI * t) / RING_BOB_S - i * RING_BOB_STEP);
    }
    smoke.rotation.y = SMOKE_SPIN * t;
    // The glow keeps a few pixels' size at any distance.
    lightWorld.set(figure.x, figure.y + WATCHER_EYE_Y, figure.z);
    const d = Number.isFinite(camX + camY + camZ) ? Math.hypot(lightWorld.x - camX, lightWorld.y - camY, lightWorld.z - camZ) : 0;
    const s = Math.max(GLOW_MIN, d * GLOW_PER_M);
    for (const g of glows) g.scale.set(s, s, 1);
    const pulse = Math.sin((TWO_PI * t) / CRACK_PULSE_S);
    mats.stone.emissiveIntensity = CRACK_GLOW * (1 + CRACK_PULSE * pulse);
    mats.core.opacity = CORE_OPACITY * (1 + 0.5 * CRACK_PULSE * pulse);
    mats.glow.opacity = 0.9 + 0.1 * Math.sin(t * 1.7);
  }

  /**
   * Pay every Watcher shader cost while the game loads, not on the frame of the first sighting (as
   * campfireRenderer.prewarm, CONTRACTS §32.2 and §40.4):
   * 1. compile the programs now against the real scene — its lights and fog are part of every program's key, so main
   *    calls this once all of the scene's lights exist (compileAsync — KHR_parallel_shader_compile — when present);
   * 2. have every part (rings, smoke, lantern, core, lights, glow sprites) draw ONCE in the next rendered frame, as a
   *    micro-scaled speck far below the world with frustum culling off, because ANGLE on D3D11 only finishes a program
   *    on its first draw. `sync(null)` keeps the speck until each part has drawn; then it is hidden for good.
   * Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets step 2)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    for (const p of parts) {
      warming.add(p);
      p.frustumCulled = false; // the speck (or a figure out of view) must still be drawn
    }
    if (!shown) placeWarm();
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.resolve(webgl.compileAsync(group, camera, scene)).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') webgl.compile(group, camera, scene);
    } catch {
      // A failed compile still leaves step 2 (the warm-up draw compiles the programs in the first frame).
    }
    return Promise.resolve();
  }

  function dispose() {
    warming.clear();
    scene.remove(group);
    for (const g of [...geos.rings, geos.lantern, geos.core, geos.smoke, geos.eye]) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    glowMap.dispose();
    if (crackMap) crackMap.dispose();
    shown = false;
  }

  return {
    sync, visible: () => shown, prewarm, warmPending: () => warming.size, dispose, group, head, rings, lantern, core, smoke,
    eyes, glows,
  };
}
