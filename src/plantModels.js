// Caelancraft — the wild plants as small 3D models (pure data, no three). See src/CONTRACTS.md §78.
//
// A plant in the world is a handful of BOXES (a mushroom's stem and cap, a bush's crown, a cactus pad) and CARDS (a
// leaf, a blade of grass, a frond: one upright picture that may lean and taper), every face cut from the plant's own
// 16 × 16 tile — the picture the Pack shows — so the model and its icon are plainly the same plant. All sizes are in
// TEXELS (16 to the metre, the terrain's own density); x and z are measured from the middle of the cell, y from its
// floor. compilePlantModel turns a part list into flat quads the chunk mesher copies out, turned and sized per cell.
import { BLOCK, TILE, FARM_IDS } from './blocks.js';

/** Texels per metre. */
export const PLANT_TEXELS = 16;
/** Floats per compiled quad: 4 × (x, y, z in metres, u, v in texels of the tile) + the outward normal + a shade. */
export const PLANT_QUAD_STRIDE = 24;
/** How much of a card's normal tilt survives (0 a wall, 1 its true face): keeps a leaning leaf's underside from going black. */
export const CARD_NORMAL_LIFT = 0.5;

/**
 * @typedef {[number, number, number, number]} Rect  [u, v, w, h]: a rectangle of the plant's tile, in texels (v down)
 * @typedef {Object} PlantPart
 * @property {'box'|'card'|'group'} kind
 * @property {number[]} at        [x, y, z]: the middle of the part's base
 * @property {number[]} [size]    box [w, h, d]; card [w, h]
 * @property {Rect} [side]        box: its four sides; card: its picture
 * @property {Rect} [end]         box: the two faces across its x axis, when they differ from `side`
 * @property {Rect|null} [top]    box: its top (default `side`; null when something sits on it)
 * @property {Rect} [under]       box: its underside (only a part that overhangs has one)
 * @property {number} [yaw]       radians about +y: the part's +x turns to (cos yaw, −sin yaw)
 * @property {number} [lean]      radians the part's top tips toward its +x, about its base
 * @property {number} [taper]     card: the width of its top as a share of its base (a pointed leaf)
 * @property {number} [shade]     a multiplier on its faces' shade
 * @property {boolean} [fruit]    left off the picked ("bare") plant
 * @property {PlantPart[]} [parts]  group: its members, in the group's own frame
 */

/** @typedef {{ p: number[][], uv: number[][], n: number[], shade: number, card: boolean }} Quad */

/** @param {number[]} at @param {number[]} size @param {Rect} side @param {Partial<PlantPart>} [o] @returns {PlantPart} */
const box = (at, size, side, o = {}) => ({ kind: 'box', at, size, side, ...o });
/** @param {number[]} at @param {number[]} size @param {Rect} side @param {Partial<PlantPart>} [o] @returns {PlantPart} */
const card = (at, size, side, o = {}) => ({ kind: 'card', at, size, side, ...o });
/** @param {number[]} at @param {Partial<PlantPart>} o @param {PlantPart[]} parts @returns {PlantPart} */
const group = (at, o, parts) => ({ kind: 'group', at, parts, ...o });
/**
 * `n` groups in a ring of `radius` about the middle, the first at angle `phase`: each group's +x points outward, so a
 * member's `lean` tips it away from the middle.
 * @param {number} n @param {number} radius @param {number} phase @param {(i: number) => PlantPart[]} make
 * @returns {PlantPart[]}
 */
function ring(n, radius, phase, make) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i * Math.PI * 2) / n;
    out.push(group([Math.cos(a) * radius, 0, Math.sin(a) * radius], { yaw: -a }, make(i)));
  }
  return out;
}

const rectUV = (/** @type {Rect} */ [u, v, w, h]) => [[u, v + h], [u + w, v + h], [u + w, v], [u, v]];

/** Turn `quads` by `pitch` about z (the +x end lifts), then `yaw` about y, then move them to `at` (in place). */
function place(quads, at, yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const turn = (v, mx, my, mz) => {
    const x0 = v[0] * cp - v[1] * sp;
    const y = v[0] * sp + v[1] * cp;
    v[0] = x0 * cy + v[2] * sy + mx;
    v[2] = -x0 * sy + v[2] * cy + mz;
    v[1] = y + my;
  };
  for (const q of quads) {
    for (const p of q.p) turn(p, at[0], at[1], at[2]);
    turn(q.n, 0, 0, 0);
  }
  return quads;
}

/** A box's faces, each counter-clockwise seen from outside: bottom-left, bottom-right, top-right, top-left. */
function boxQuads(part) {
  const [w, h, d] = part.size;
  const hw = w / 2;
  const hd = d / 2;
  const shade = part.shade ?? 1;
  const end = part.end ?? part.side;
  const top = part.top === undefined ? part.side : part.top;
  /** @type {Quad[]} */
  const quads = [];
  const face = (p, rect, n) => quads.push({ p, uv: rectUV(rect), n, shade, card: false });
  face([[-hw, 0, hd], [hw, 0, hd], [hw, h, hd], [-hw, h, hd]], part.side, [0, 0, 1]);
  face([[hw, 0, -hd], [-hw, 0, -hd], [-hw, h, -hd], [hw, h, -hd]], part.side, [0, 0, -1]);
  face([[hw, 0, hd], [hw, 0, -hd], [hw, h, -hd], [hw, h, hd]], end, [1, 0, 0]);
  face([[-hw, 0, -hd], [-hw, 0, hd], [-hw, h, hd], [-hw, h, -hd]], end, [-1, 0, 0]);
  if (top) face([[-hw, h, hd], [hw, h, hd], [hw, h, -hd], [-hw, h, -hd]], top, [0, 1, 0]);
  if (part.under) face([[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]], part.under, [0, -1, 0]);
  return quads;
}

/** A card: one picture standing across the part's z axis (the cutout material shows both its sides). */
function cardQuads(part) {
  const [w, h] = part.size;
  const hb = w / 2;
  const ht = hb * (part.taper ?? 1);
  return [{ p: [[0, 0, -hb], [0, 0, hb], [0, h, ht], [0, h, -ht]], uv: rectUV(part.side), n: [-1, 0, 0], shade: part.shade ?? 1, card: true }];
}

/** @param {PlantPart} part @param {boolean} bare @returns {Quad[]} */
function quadsOf(part, bare) {
  if (bare && part.fruit) return [];
  const quads = part.kind === 'group' ? (part.parts ?? []).flatMap((p) => quadsOf(p, bare))
    : part.kind === 'card' ? cardQuads(part) : boxQuads(part);
  return place(quads, part.at, part.yaw ?? 0, -(part.lean ?? 0));
}

/**
 * Compile a part list into PLANT_QUAD_STRIDE floats per quad: four corners (x, y, z in METRES from the middle of the
 * cell's floor, then u, v in texels of the tile), the unit normal, the shade. `bare` leaves the fruit off.
 * @param {PlantPart[]} parts
 * @param {boolean} [bare]
 * @returns {Float32Array}
 */
export function compilePlantModel(parts, bare = false) {
  const quads = parts.flatMap((p) => quadsOf(p, bare));
  const out = new Float32Array(quads.length * PLANT_QUAD_STRIDE);
  let o = 0;
  for (const q of quads) {
    for (let v = 0; v < 4; v++) {
      out[o++] = q.p[v][0] / PLANT_TEXELS;
      out[o++] = q.p[v][1] / PLANT_TEXELS;
      out[o++] = q.p[v][2] / PLANT_TEXELS;
      out[o++] = q.uv[v][0];
      out[o++] = q.uv[v][1];
    }
    let [nx, ny, nz] = q.n;
    if (q.card) ny *= CARD_NORMAL_LIFT;
    const len = Math.hypot(nx, ny, nz) || 1;
    out[o++] = nx / len;
    out[o++] = ny / len;
    out[o++] = nz / len;
    out[o++] = q.shade;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The models. Rects name texels of each plant's own tile (tiles.js): [column, row, width, height].
// ---------------------------------------------------------------------------------------------------

const QUARTER = Math.PI / 2;

/** Honeycap: a fat golden dome on a cream stem, a small one beside it. */
const HONEYCAP = [
  group([-1, 0, -0.5], {}, [
    box([0, 0, 0], [5, 2, 5], [5, 14, 5, 2], { top: [5, 13, 5, 1] }),
    box([0, 2, 0], [4, 4, 4], [6, 10, 4, 4], { top: null }),
    box([0, 6, 0], [10, 2, 10], [3, 7, 10, 2], { top: [4, 5, 8, 4], under: [3, 9, 10, 1] }),
    box([0, 8, 0], [8, 2, 8], [4, 5, 8, 2], { top: [4, 5, 8, 4] }),
    box([0, 10, 0], [5, 1, 5], [6, 4, 4, 1], { top: [6, 4, 4, 1] }),
  ]),
  group([5, 0, 2.5], { yaw: 0.6 }, [
    box([0, 0, 0], [2, 3, 2], [12, 12, 2, 3], { top: null }),
    box([0, 3, 0], [4, 2, 4], [11, 11, 5, 1], { top: [12, 10, 3, 2], under: [12, 12, 3, 1] }),
  ]),
];

/** Frecklecap: a wide flat freckled cap with a little peak, gills under it and a ring on its thin white stem. */
const FRECKLECAP = [
  group([-1, 0, 0], {}, [
    box([0, 0, 0], [4, 2, 4], [6, 14, 4, 2], { top: [6, 14, 4, 1] }),
    box([0, 2, 0], [2, 5, 2], [7, 12, 2, 2], { top: null }),
    box([0, 4, 0], [6, 1, 6], [5, 11, 6, 1], { top: [5, 11, 6, 1], under: [5, 11, 6, 1] }),
    box([0, 7, 0], [11, 2, 11], [2, 7, 11, 2], { top: [3, 6, 10, 3], under: [3, 9, 10, 1] }),
    box([0, 9, 0], [7, 1, 7], [4, 6, 7, 1], { top: [5, 5, 6, 3] }),
    box([0, 10, 0], [3, 1, 3], [6, 5, 3, 1], { top: [7, 4, 2, 2] }),
  ]),
  group([5.5, 0, 2.5], { yaw: -0.5 }, [
    box([0, 0, 0], [1.5, 3, 1.5], [13, 13, 1, 2], { top: null }),
    box([0, 3, 0], [4, 1, 4], [11, 11, 5, 1], { top: [11, 11, 5, 1], under: [12, 12, 3, 1] }),
    box([0, 4, 0], [2, 1, 2], [13, 10, 1, 1], {}),
  ]),
];

/** Wild onion: three bulbs with their leaves, and a white flower ball on a tall stalk. */
const ONION = [
  box([0, 0, 0], [1, 11, 1], [7, 5, 1, 8], { top: null }),
  box([0, 11, 0], [4, 3, 4], [6, 1, 4, 2], { top: [6, 1, 3, 2], under: [7, 3, 2, 1] }),
  box([0, 14, 0], [2, 1, 2], [7, 0, 2, 1], {}),
  ...ring(3, 4, 0.4, (i) => [
    box([0, 0, 0], [3, 2, 3], [3, 14, 3, 2], { top: [4, 13, 1, 1] }),
    card([0, 2, 0], [5, 9], i === 1 ? [10, 4, 5, 9] : [1, 4, 5, 9], { lean: 0.22 }),
    card([0, 2, 0], [5, 9], i === 1 ? [1, 4, 5, 9] : [10, 4, 5, 9], { yaw: QUARTER }),
  ]),
];

/** Wild carrot: the orange crown of the root, and a spray of feathery fronds. */
const CARROT_FROND = /** @type {Rect} */ ([4, 0, 7, 12]);
const CARROT = [
  box([0, 0, 0], [3, 2, 3], [6, 13, 3, 2], { top: [6, 13, 3, 1] }),
  box([0, 2, 0], [2, 1, 2], [7, 12, 2, 1], {}),
  card([0, 2.5, 0], [7, 12], CARROT_FROND, { yaw: 0.3 }),
  ...ring(5, 1, 0.3, (i) => [card([0, 2.5, 0], [7, 11], CARROT_FROND, { lean: i % 2 ? 0.6 : 0.36 })]),
];

/** Hazel thicket: several stems, a leafy crown in lumps, nuts in pale husks. */
const HAZEL_NUT = /** @type {Rect} */ ([6, 3, 2, 1]);
const HAZEL_STEM = /** @type {Rect} */ ([7, 13, 2, 2]);
const HAZEL = [
  box([0, 0, 0], [2, 6, 2], HAZEL_STEM, { top: null }),
  ...ring(3, 1.5, 0.2, () => [box([0, 0.35, 0], [2, 7, 2], HAZEL_STEM, { top: null, lean: 0.32 })]),
  box([0, 6, 0], [11, 6, 11], [2, 3, 11, 6], { top: [3, 2, 10, 5], under: [3, 8, 10, 1] }),
  box([0, 12, 0], [7, 2, 7], [5, 1, 6, 2], {}),
  ...ring(3, 4, 1.1, (i) => [box([0, 5 + i * 1.5, 0], [5, 4, 5], [0, 4, 5, 3], { under: [1, 6, 4, 1], yaw: 0.4 })]),
  box([6, 8, 2], [2, 2, 2], HAZEL_NUT, { fruit: true }),
  box([-6, 9.5, -1.5], [2, 2, 2], HAZEL_NUT, { fruit: true, yaw: Math.PI }),
  box([1.5, 7.5, 6], [2, 2, 2], HAZEL_NUT, { fruit: true, yaw: QUARTER }),
  box([-2, 9, -6], [2, 2, 2], HAZEL_NUT, { fruit: true, yaw: -QUARTER }),
  box([4.5, 12, -4], [2, 1.5, 2], HAZEL_NUT, { fruit: true }),
];

/** Crab apple: a little tree — trunk, a dark round crown, red apples standing out of it. */
const APPLE = /** @type {Rect} */ ([2, 4, 2, 2]);
const CRAB_APPLE = [
  box([0, 0, 0], [4, 1, 4], [6, 15, 4, 1], {}),
  box([0, 1, 0], [2, 5, 2], [7, 11, 2, 4], { top: null }),
  box([0, 5, 0], [7, 1, 7], [5, 9, 6, 1], { top: null, under: [5, 9, 6, 1] }),
  box([0, 6, 0], [11, 6, 11], [2, 2, 11, 6], { top: [3, 1, 10, 5], under: [3, 8, 10, 1] }),
  box([0, 12, 0], [7, 2, 7], [5, 0, 6, 2], {}),
  ...ring(2, 4, 0.9, (i) => [box([0, 6.5 + i * 2, 0], [5, 4, 5], [2, 3, 5, 4], { under: [3, 8, 5, 1], yaw: 0.5 })]),
  box([6, 8, -2], [2, 2, 2], APPLE, { fruit: true }),
  box([-6, 9.5, 2], [2, 2, 2], APPLE, { fruit: true, yaw: Math.PI }),
  box([-1.5, 7.5, 6], [2, 2, 2], APPLE, { fruit: true, yaw: QUARTER }),
  box([2.5, 9.5, -6], [2, 2, 2], APPLE, { fruit: true, yaw: -QUARTER }),
  box([-4.5, 12, -4], [2, 2, 2], APPLE, { fruit: true }),
];

/** Healwort: a pale rosette of pointed leaves, and three violet flower spikes. */
const HEALWORT_STEM = /** @type {Rect} */ ([8, 6, 1, 4]);
/** @param {number[]} at @param {number} h @param {Rect} flowers @param {number} yaw @param {number} lean @returns {PlantPart} */
const healwortSpike = (at, h, flowers, yaw, lean) => group(at, { yaw, lean, fruit: true }, [
  box([0, 0, 0], [1, h, 1], HEALWORT_STEM, { top: null }),
  box([0, h, 0], [2, 5, 2], [4, 4, 1, 5], { top: [4, 4, 1, 1] }),
  card([0, h, 0], [3, 5], flowers, {}),
  card([0, h, 0], [3, 5], flowers, { yaw: QUARTER }),
]);
const HEALWORT = [
  box([0, 0, 0], [5, 2, 5], [5, 14, 5, 2], { top: [5, 13, 5, 2] }),
  ...ring(7, 2, 0, (i) => [
    card([0, 1, 0], [3.5, 6.5], i % 2 ? [11, 14, 3, 1] : [7, 13, 3, 2], { lean: i % 2 ? 0.8 : 1.12, taper: 0.3 }),
  ]),
  healwortSpike([0, 2, 0], 6, [7, 1, 3, 5], 0, 0),
  healwortSpike([-2.5, 1.5, 1.5], 3, [3, 4, 3, 5], 2.6, 0.22),
  healwortSpike([2.5, 1.5, -1], 4, [10, 3, 3, 5], -0.4, 0.2),
];

/**
 * Honeyberry: a low dark bush on a short trunk, clusters of pale blue berries. Picked (`leaf`), the same lumps are cut
 * from a berry-free corner of the bush's picture.
 * @param {Rect|null} leaf
 * @returns {PlantPart[]}
 */
const BERRY = /** @type {Rect} */ ([4, 4, 2, 2]);
const honeyberry = (leaf) => [
  box([0, 0, 0], [2, 3, 2], [7, 14, 2, 2], { top: null }),
  box([0, 2.5, 0], [10, 6, 10], leaf ?? [1, 7, 10, 6], { top: leaf ?? [6, 4, 6, 4], under: leaf ?? [3, 12, 9, 1] }),
  box([-1, 8.5, 0.5], [7, 3, 7], leaf ?? [3, 3, 7, 3], { top: leaf ?? [6, 4, 6, 4] }),
  ...ring(2, 3.5, 2.2, (i) => [box([0, 2 + i * 2.5, 0], [5, 4, 5], leaf ?? [8, 5, 5, 3], { under: leaf ?? [3, 12, 5, 1], yaw: 0.45 })]),
  box([5.5, 5.5, 1.5], [2, 2, 2], BERRY, { fruit: true }),
  box([-1.5, 5, 5.5], [2, 2, 2], BERRY, { fruit: true, yaw: QUARTER }),
  box([-5.5, 6.5, -2], [2, 2, 2], BERRY, { fruit: true, yaw: Math.PI }),
  box([2, 6, -5.5], [2, 2, 2], BERRY, { fruit: true, yaw: -QUARTER }),
  box([2.5, 8.5, 3], [2, 1.5, 2], BERRY, { fruit: true }),
];

/** Tussock: a dense tuft with golden-tipped blades splaying out of it. */
const TUSSOCK = [
  ...ring(3, 0, 0, () => [card([0, 0, 0], [13, 12], [1, 4, 13, 12], { yaw: QUARTER })]),
  ...ring(6, 2.5, 0.5, (i) => [
    card([0, 0, 0], [2.5, 9 + (i % 3)], i % 2 ? [10, 5, 1, 6] : [6, 4, 1, 6], { lean: 0.42 + 0.14 * (i % 2), taper: 0.25 }),
  ]),
];

/** Cattails: three stalks of different heights with brown heads, and long blades about their feet. */
const CATTAIL_STALK = /** @type {Rect} */ ([8, 5, 1, 10]);
/** @param {number} x @param {number} z @param {number} h @returns {PlantPart[]} */
const cattail = (x, z, h) => [
  box([x, 0, z], [1, h, 1], CATTAIL_STALK, { top: null }),
  box([x, h, z], [2, 4, 2], [3, 1, 2, 4], { top: [3, 1, 2, 1], under: [3, 4, 2, 1] }),
  box([x, h + 4, z], [1, 1, 1], [3, 0, 1, 1], {}),
];
const CATTAILS = [
  ...cattail(-2.5, -1, 10),
  ...cattail(2, -2.5, 8),
  ...cattail(0.5, 3, 6),
  ...ring(5, 1.5, 0.7, (i) => [card([0, 0, 0], [2, 10 - (i % 2) * 2], [1, 4, 1, 9], { lean: 0.24 + 0.1 * (i % 3), taper: 0.2 })]),
];

/** Wild tuber: broad veined leaves lying out in a low rosette, the tuber just showing. */
const TUBER = [
  box([0, 0, 0], [2, 1.5, 2], [7, 14, 2, 1], {}),
  ...ring(6, 1.5, 0, () => [card([0, 1, 0], [5, 7], [5, 9, 5, 3], { lean: 1.05, taper: 0.4 })]),
  ...ring(4, 1, 0.5, () => [card([0, 1, 0], [4, 5.5], [5, 13, 5, 1], { lean: 0.72, taper: 0.4 })]),
];

/** Prickly pear: thick pads growing out of each other, red fruit on their rims. */
const PAD_EDGE = /** @type {Rect} */ ([4, 10, 1, 3]);
const PRICKLY_PEAR = [
  box([0, 0, 0], [4, 1, 3], [6, 14, 4, 1], { end: PAD_EDGE, top: null }),
  box([0, 1, 0], [6, 2, 3], [5, 13, 6, 2], { end: PAD_EDGE, top: PAD_EDGE }),
  box([0, 3, 0], [8, 3, 3], [4, 10, 8, 3], { end: PAD_EDGE, top: PAD_EDGE }),
  box([0, 6, 0], [6, 1, 3], [5, 9, 6, 1], { end: PAD_EDGE, top: PAD_EDGE }),
  box([3.5, 5.5, 1.5], [2, 2, 2], [10, 7, 2, 2], { fruit: true }),
  group([-2.5, 6.5, 0], { yaw: Math.PI + 0.6, lean: 0.35 }, [
    box([0, 0, 0], [5, 2, 3], [2, 6, 5, 2], { end: PAD_EDGE, top: PAD_EDGE }),
    box([0, 2, 0], [6, 2, 3], [1, 4, 6, 2], { end: PAD_EDGE, top: PAD_EDGE }),
    box([0, 4, 0], [5, 1, 3], [2, 3, 5, 1], { end: PAD_EDGE, top: PAD_EDGE }),
    box([-1.5, 5, 0], [2, 2, 2], [2, 1, 2, 2], { fruit: true }),
    box([1.5, 5, 0], [2, 2, 2], [5, 1, 2, 2], { fruit: true }),
  ]),
  group([2.5, 6.5, 0], { yaw: -0.5, lean: 0.35 }, [
    box([0, 0, 0], [5, 4, 3], [9, 3, 5, 4], { end: PAD_EDGE, top: PAD_EDGE }),
    box([0, 4, 0], [4, 1, 3], [9, 2, 4, 1], { end: PAD_EDGE, top: PAD_EDGE }),
    box([1, 5, 0], [2, 2, 2], [13, 1, 2, 2], { fruit: true }),
    box([-1.5, 4.5, 0], [2, 2, 2], [10, 0, 2, 2], { fruit: true }),
  ]),
];

/**
 * The farm blocks (CONTRACTS §80). A planted seed is a low mound of tilled earth in two steps with a short marker twig
 * standing in it, a pale rag tied to the twig; a sprout is the same mound with a two-leaf seedling. Every planted
 * block shares the first model and every sprout the second: what was planted is told by the block's name.
 */
const SEED_MOUND = [
  box([0, 0, 0], [10, 1.5, 10], [2, 14, 10, 2], { top: [2, 12, 10, 4] }),
  box([0, 1.5, 0], [7, 1.5, 7], [4, 12, 7, 2], { top: [4, 11, 7, 3] }),
];
const SEEDBED = [
  ...SEED_MOUND,
  group([1, 3, -0.5], { lean: 0.1 }, [
    box([0, 0, 0], [1.5, 6, 1.5], [7, 3, 2, 6], { top: [7, 3, 2, 1] }),
    box([0, 3.5, -2.25], [0.75, 2, 3], [9, 4, 1, 2], { end: [9, 4, 3, 2], top: [9, 4, 3, 1], under: [9, 5, 3, 1] }),
  ]),
];
/** @param {number} yaw @param {Rect} top @param {Rect} edge @returns {PlantPart} one seed leaf, lifting away from the stem */
const seedLeaf = (yaw, top, edge) => group([0, 6.5, 0], { yaw, lean: -0.5 }, [
  box([3, 0, 0], [5, 1, 3.5], edge, { top, under: edge }),
]);
const SPROUT = [
  ...SEED_MOUND,
  box([0, 3, 0], [1.5, 4, 1.5], [7, 6, 2, 4], { top: [7, 5, 2, 1] }),
  seedLeaf(0.3, [2, 3, 4, 3], [2, 5, 4, 1]),
  seedLeaf(0.3 + Math.PI, [10, 2, 4, 3], [10, 4, 4, 1]),
];

/**
 * @typedef {Object} PlantModelDef
 * @property {PlantPart[]} parts
 * @property {boolean} [bare]  a picked plant: the same parts less the fruit, cut from the picked block's own tile
 * @property {number} [tile]   the tile the faces are cut from, when it is not the block's own
 */

/**
 * The model of each plant block, by block id.
 * @type {Readonly<Record<number, PlantModelDef>>}
 */
export const PLANT_MODELS = Object.freeze({
  [BLOCK.HONEYCAP_MUSHROOM]: { parts: HONEYCAP },
  [BLOCK.FRECKLECAP_MUSHROOM]: { parts: FRECKLECAP },
  [BLOCK.ONION_PLANT]: { parts: ONION },
  [BLOCK.CARROT_PLANT]: { parts: CARROT },
  [BLOCK.HAZEL_THICKET]: { parts: HAZEL },
  [BLOCK.HAZEL_THICKET_BARE]: { parts: HAZEL, bare: true },
  [BLOCK.CRAB_APPLE_BUSH]: { parts: CRAB_APPLE },
  [BLOCK.CRAB_APPLE_BUSH_BARE]: { parts: CRAB_APPLE, bare: true },
  [BLOCK.HEALWORT_PLANT]: { parts: HEALWORT },
  [BLOCK.HEALWORT_PLANT_BARE]: { parts: HEALWORT, bare: true },
  [BLOCK.HONEYBERRY_BUSH]: { parts: honeyberry(null) },
  [BLOCK.HONEYBERRY_BUSH_BARE]: { parts: honeyberry([1, 9, 5, 4]), bare: true, tile: TILE.HONEYBERRY_BUSH },
  [BLOCK.TUSSOCK]: { parts: TUSSOCK },
  [BLOCK.CATTAILS]: { parts: CATTAILS },
  [BLOCK.TUBER_PLANT]: { parts: TUBER },
  [BLOCK.PRICKLY_PEAR]: { parts: PRICKLY_PEAR },
  [BLOCK.PRICKLY_PEAR_BARE]: { parts: PRICKLY_PEAR, bare: true },
  // §80: the nine planted blocks are one seedbed, the nine sprouts one seedling (FARM_IDS: planted first, then sprouts)
  ...Object.fromEntries(FARM_IDS.map((id) => [id, { parts: id < BLOCK.CARROT_SPROUT ? SEEDBED : SPROUT }])),
});

/**
 * The compiled model of block `id` (compilePlantModel's quads), or null when the block has none.
 * @param {number} id
 * @returns {Float32Array|null}
 */
export function plantModel(id) {
  const m = PLANT_MODELS[id];
  return m ? compilePlantModel(m.parts, m.bare === true) : null;
}

/**
 * The tile a plant model's faces are cut from when it is not the block's own top tile, else null.
 * @param {number} id
 * @returns {number|null}
 */
export function plantModelTile(id) {
  return PLANT_MODELS[id]?.tile ?? null;
}
