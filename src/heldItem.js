// Caelancraft — the item in the avatar's hand, as a chunky 3D object (PURE: no three, no DOM).
//
// The item's 16×16 pixel art (itemArt.js) is extruded into a slab one pixel thick, the classic voxel item: every solid
// pixel gets a front and a back square, and a side square only where its neighbour is empty (or off the picture), so the
// slab is closed and has no faces inside it. avatarRenderer.js wraps the arrays in a BufferGeometry and hangs it in the
// model's right hand and in the first-person arm's.
//
// How it is held comes from the pixels, never from a table of hand positions:
//   - a hafted thing (a tool, a weapon, an arrow) is gripped near the end of its haft — the bottom of the picture, the top
//     for a shovel (itemArt draws its blade at the bottom) — and turned in its own plane so its bulk lies straight ahead
//     of the grip: a pick points along its haft, an arrow along its shaft;
//   - anything else (food, a lump of ore, a pot, the hammerstone, a tool without a haft) is held at the middle of its
//     pixels, a little smaller.
// The slab's frame: x = the picture's right, y = straight ahead of the grip (the picture's up for an upright tool),
// z = out of the picture's front; the grip at the origin; metres.
import { paintItem, hasItemArt, toolArtOf, ITEM_ART_SIZE } from './itemArt.js';
import { getItem } from './items.js';
import { ARROW_KEYS } from './looseItems.js';

/** Metres per art pixel of a held tool (a 16-pixel pick is 0.4 m: a child's tool). */
export const HELD_PIXEL = 0.025;
/** A held thing without a haft is drawn this much smaller than a tool. */
export const HELD_LUMP_SCALE = 0.7;
/** A haft is gripped this many pixels in from its end (the end of the handle shows under the fist). */
export const HELD_GRIP_IN = 3;
/** The rows at the handle end that are looked at for a haft, and how narrow (pixels) one of them must be. */
export const HELD_HAFT_ROWS = 4;
export const HELD_HAFT_PX = 4;
/** A pixel is solid when its alpha is over this. */
const SOLID_ALPHA = 127;

/** @typedef {'tool'|'lump'} HeldStyle */
/**
 * @typedef {Object} HeldGrip  how a picture is held
 * @property {HeldStyle} style
 * @property {[number, number]} grip  the point of the picture at the hand, in art pixels: u right, v down from the
 *   picture's top-left corner (pixel (x, y) covers [x, x + 1] × [y, y + 1])
 * @property {number} turn   radians the picture is turned in its plane about the grip (counter-clockwise seen from the
 *   front) so its bulk lies along +y
 * @property {number} pixel  metres per art pixel
 */
/**
 * @typedef {Object} ItemSlab  non-indexed triangles (three vertices each), metres
 * @property {Float32Array} positions  xyz per vertex
 * @property {Float32Array} normals    xyz per vertex (unit, the face's)
 * @property {Float32Array} colors     linear rgb per vertex (the pixel's sRGB colour linearised)
 */

/** @param {number} c 0..255 sRGB @returns {number} 0..1 linear (three's SRGBToLinear) */
export function srgbByteToLinear(c) {
  const s = c / 255;
  return s < 0.04045 ? s * 0.0773993808 : Math.pow(s * 0.9478672986 + 0.0521327014, 2.4);
}

/**
 * Whether the item in hand is drawn at all: a non-block item with its own picture. Block items (out of scope) and
 * unknown keys show nothing.
 * @param {string|null|undefined} key
 * @returns {boolean}
 */
export function heldItemShown(key) {
  if (typeof key !== 'string') return false;
  const def = getItem(key);
  return !!def && def.kind !== 'block' && hasItemArt(key);
}

/**
 * Whether an item is wielded by a haft (a tool, or §100 an arrow by its nock) rather than held in the fist — what its
 * picture then says decides (heldGrip: a "tool" without a haft is still held like a lump).
 * @param {string} key
 */
export function heldWielded(key) {
  const def = getItem(key);
  return !!def && (!!def.tool || ARROW_KEYS.includes(key));
}

/**
 * How a picture is held. A wielded one with a haft at its handle end (one of the HELD_HAFT_ROWS rows there at most
 * HELD_HAFT_PX pixels across) is a 'tool': gripped HELD_GRIP_IN pixels in from that end, at the middle of the solid
 * pixels of those rows, and turned so the middle of all its solid pixels lies straight ahead (+y) of the grip. Anything
 * else is a 'lump': held at the middle of its solid pixels, unturned, HELD_LUMP_SCALE the size. An empty picture is a
 * lump held at its centre.
 * @param {ArrayLike<number>} rgba  size × size RGBA bytes, row 0 at the top
 * @param {number} size
 * @param {{ wielded?: boolean, handleTop?: boolean }} [opts]  handleTop: the haft is at the top of the picture
 * @returns {HeldGrip}
 */
export function heldGrip(rgba, size, { wielded = false, handleTop = false } = {}) {
  const solid = (x, y) => rgba[(y * size + x) * 4 + 3] > SOLID_ALPHA;
  let n = 0;
  let su = 0;
  let sv = 0;
  let minY = size;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      n++;
      su += x + 0.5;
      sv += y + 0.5;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const lump = (u, v) => ({ style: /** @type {HeldStyle} */ ('lump'), grip: /** @type {[number, number]} */ ([u, v]), turn: 0, pixel: HELD_PIXEL * HELD_LUMP_SCALE });
  if (n === 0) return lump(size / 2, size / 2);
  const cu = su / n;
  const cv = sv / n;
  if (!wielded) return lump(cu, cv);
  // the rows at the handle end: is one of them a haft? and where across are they?
  let narrowest = Infinity;
  let hu = 0;
  let hn = 0;
  for (let i = 0; i < HELD_HAFT_ROWS; i++) {
    const y = handleTop ? minY + i : maxY - i;
    if (y < minY || y > maxY) break;
    let lo = size;
    let hi = -1;
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      if (x < lo) lo = x;
      hi = x;
      hu += x + 0.5;
      hn++;
    }
    if (hi >= 0) narrowest = Math.min(narrowest, hi - lo + 1);
  }
  if (narrowest > HELD_HAFT_PX || hn === 0) return lump(cu, cv);
  const gu = hu / hn;
  const gv = handleTop ? minY + HELD_GRIP_IN : maxY + 1 - HELD_GRIP_IN;
  // turn the bulk (the centre of the solid pixels) round to straight ahead (+y; the picture's v runs down)
  const dx = cu - gu;
  const dy = gv - cv;
  let turn = Math.hypot(dx, dy) < 1 ? 0 : Math.PI / 2 - Math.atan2(dy, dx);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn <= -Math.PI) turn += 2 * Math.PI;
  return { style: 'tool', grip: [gu, gv], turn, pixel: HELD_PIXEL };
}

/**
 * Extrude pixel art into a slab one pixel thick (z from −pixel/2 to +pixel/2, the picture's front facing +z): a front
 * and a back square for every solid pixel (alpha > 127) and a side square where the neighbour on that side is empty or
 * off the picture, each in the pixel's colour (linear). The grip pixel point sits at the origin, the picture's up is +y,
 * then the whole is turned by `turn` about z. Triangles wind counter-clockwise seen from outside.
 * @param {ArrayLike<number>} rgba  size × size RGBA bytes (sRGB), row 0 at the top
 * @param {number} size
 * @param {{ pixel?: number, grip?: readonly [number, number], turn?: number }} [opts]
 * @returns {ItemSlab}
 */
export function extrudeItemArt(rgba, size, { pixel = HELD_PIXEL, grip = [size / 2, size / 2], turn = 0 } = {}) {
  const solid = (x, y) => x >= 0 && y >= 0 && x < size && y < size && rgba[(y * size + x) * 4 + 3] > SOLID_ALPHA;
  let quads = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      quads += 2 + (solid(x - 1, y) ? 0 : 1) + (solid(x + 1, y) ? 0 : 1) + (solid(x, y - 1) ? 0 : 1) + (solid(x, y + 1) ? 0 : 1);
    }
  }
  const positions = new Float32Array(quads * 18);
  const normals = new Float32Array(quads * 18);
  const colors = new Float32Array(quads * 18);
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const [gu, gv] = grip;
  const zf = pixel / 2;
  const zb = -pixel / 2;
  let o = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  /** One corner (before the turn). */
  const put = (X, Y, Z, nx, ny, nz) => {
    positions[o] = X * cos - Y * sin;
    positions[o + 1] = X * sin + Y * cos;
    positions[o + 2] = Z;
    normals[o] = nx * cos - ny * sin;
    normals[o + 1] = nx * sin + ny * cos;
    normals[o + 2] = nz;
    colors[o] = r;
    colors[o + 1] = g;
    colors[o + 2] = b;
    o += 3;
  };
  /** A square from four corners counter-clockwise seen from outside: two triangles (a, b, c) and (a, c, d). */
  const quad = (a, bq, c, d, nx, ny, nz) => {
    for (const p of [a, bq, c, a, c, d]) put(p[0], p[1], p[2], nx, ny, nz);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      const i = (y * size + x) * 4;
      r = srgbByteToLinear(rgba[i]);
      g = srgbByteToLinear(rgba[i + 1]);
      b = srgbByteToLinear(rgba[i + 2]);
      const x0 = (x - gu) * pixel;
      const x1 = x0 + pixel;
      const yt = (gv - y) * pixel;
      const yb = yt - pixel;
      quad([x0, yb, zf], [x1, yb, zf], [x1, yt, zf], [x0, yt, zf], 0, 0, 1);
      quad([x1, yb, zb], [x0, yb, zb], [x0, yt, zb], [x1, yt, zb], 0, 0, -1);
      if (!solid(x + 1, y)) quad([x1, yb, zf], [x1, yb, zb], [x1, yt, zb], [x1, yt, zf], 1, 0, 0);
      if (!solid(x - 1, y)) quad([x0, yb, zb], [x0, yb, zf], [x0, yt, zf], [x0, yt, zb], -1, 0, 0);
      if (!solid(x, y - 1)) quad([x0, yt, zf], [x1, yt, zf], [x1, yt, zb], [x0, yt, zb], 0, 1, 0);
      if (!solid(x, y + 1)) quad([x0, yb, zb], [x1, yb, zb], [x1, yb, zf], [x0, yb, zf], 0, -1, 0);
    }
  }
  return { positions, normals, colors };
}

/**
 * The slab of the item in hand, held as its picture says (heldGrip), or null for a key that is not shown
 * (heldItemShown).
 * @param {string|null|undefined} key
 * @returns {(ItemSlab & HeldGrip)|null}
 */
export function heldItemGeometry(key) {
  if (!heldItemShown(key)) return null;
  const k = /** @type {string} */ (key);
  const rgba = paintItem(k);
  const hold = heldGrip(rgba, ITEM_ART_SIZE, { wielded: heldWielded(k), handleTop: toolArtOf(k)?.[0] === 'shovel' });
  return { ...hold, ...extrudeItemArt(rgba, ITEM_ART_SIZE, hold) };
}
