// Caelancraft — every plant as a small 3D model (PURE: typed arrays, no three). See src/CONTRACTS.md §102 (which
// replaces §78's parts for the plants) and docs/DESIGN-characters.md (phase 4).
//
// The plants are HEX-FACETED like the rest of the world's creatures: faceted stems and branches carrying leaf cards in
// whorls and tiers with gaps between them, each plant its own leaf and its own arrangement — a honeyberry's bush full to
// the ground with blue berries hanging in threes, a hazel's vase of leaning stems, a crab apple's little tree, a fern's
// arching fronds, a cattail's spikes, the flax's slender stalks with sky-blue flowers, daisies and thistles, an aloe's
// rosette of thick wedges, mushrooms as faceted caps on hexagonal stems. Every part is painted from the PLANT ATLAS
// (plantAtlas.js), built by the plant kit (plantKit.js), and drawn by the chunk mesher in the chunk's cutout layer.
//
// Each model comes in three levels of detail (plantKit.PLANT_LOD_*): NEAR, the full plant; FAR, the same recipe thinned
// out (about a tenth of the triangles, still leafy, never a ball); CARD, two crossed pictures of the block's own 16-px
// tile (its Pack icon) for the far distance — the ground litter and the farm's mounds keep their FAR model there. A
// plant has 1–3 VARIANTS (the same recipe, another seed), chosen per cell by the mesher, so a meadow never repeats one
// stamp. A picked plant is the same recipe built `bare`: the same plant without its fruit, leaf for leaf.
//
// The furniture of §85 (the well, the rain barrel, the two beds) keeps its BOX model: boxes and cards cut from 16-px
// skins (compileBoxModel), drawn by the mesher's box path.
import { BLOCK, TILE, FARM_IDS, CROP_ROWS, getFaceTile } from './blocks.js';
import { paintTile } from './tiles.js';
import { tileToUV } from './blocks.js';
import {
  Plant, PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_LOD_CARD, PLANT_STRIDE, dirAt, vec, ribbonGeo,
} from './plantKit.js';

/** @typedef {import('./plantKit.js').CompiledPlant} CompiledPlant */
/** @typedef {[number, number, number]} Vec3 */

export { PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_LOD_CARD, PLANT_STRIDE };

const TAU = Math.PI * 2;
const { add, scale } = vec;

// =====================================================================================================================
// The plants
// =====================================================================================================================

/**
 * @typedef {Object} Recipe
 * @property {number} variants          how many seeds it is built from (1–3)
 * @property {(k: Plant, v: number) => void} build
 * @property {number} [open]            how much darker its inside is (plantKit compile)
 * @property {boolean} [noCard]         far away it keeps its FAR model (litter, the farm's mounds): an upright picture
 *                                      of a thing lying on the ground would read wrong
 */

const HONEY = ['honey.leaf0', 'honey.leaf1', 'honey.leaf2'];

/** The point `f` of the way from a to b. @param {number[]} a @param {number[]} b @param {number} f @returns {Vec3} */
const lerp3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

/**
 * A shrub's branching (the honeyberry, the nightshade and the crab apple's crown): `n` branches out of `root`, each
 * rising at an elevation in `elev` for a length in `len`, with a little drooping whorl low on it, two side twigs (one at
 * half its length, one near its tip) each ending in a whorl, and an upturned crown of leaves at its tip; one more branch
 * straight up the middle. Returns the twig tips ([point, the way round it points]) for the fruit to hang from.
 * @param {Plant} k
 * @param {{ root: Vec3, n: number, len: number[], elev: number[], keys: string[], bark: string, leaf: number[],
 *   r: number, up?: number, phase?: number, lift?: number, splay?: number }} o
 * @returns {[Vec3, number][]}
 */
function shrub(k, o) {
  const [ll, lw] = o.leaf;
  /** @type {[Vec3, number][]} */
  const tips = [];
  for (let i = 0; i <= o.n; i++) {
    const centre = i === o.n;
    const a = (o.phase ?? 0.3) + (i * TAU) / o.n + k.jit(0.22);
    const el = centre ? 1.35 : k.range(o.elev[0], o.elev[1]);
    const L = centre ? (o.up ?? o.len[1] * 1.15) : k.range(o.len[0], o.len[1]);
    const end = add(o.root, scale(dirAt(a, el), L));
    if (!k.far) k.stem(o.root, end, o.r, o.r * 0.45, o.bark, { sides: 4 });
    if (!centre) k.whorl(lerp3(o.root, end, 0.3), 3, ll * 0.85, lw * 0.85, 0.05, a + 0.5, o.keys, { keep: 0.34 });
    k.spray(lerp3(o.root, end, 0.4), end, 6, ll, lw, o.keys, { phase: i * 1.3, lift: o.lift, splay: o.splay });
    for (const s of [-1, 1]) {
      const from = lerp3(o.root, end, s < 0 ? 0.42 : 0.68);
      const ta = a + s * (0.75 + k.jit(0.2));
      const to = add(from, scale(dirAt(ta, Math.min(1.3, el * 0.5 + 0.25)), L * 0.45));
      if (!k.far) k.stem(from, to, o.r * 0.55, o.r * 0.3, o.bark, { sides: 3 });
      k.spray(lerp3(from, to, 0.15), to, 5, ll * 0.95, lw * 0.95, o.keys, { phase: i + s, lift: o.lift, splay: o.splay });
      if (!centre) tips.push([to, ta]);
    }
  }
  return tips;
}

/**
 * The honeyberry bush — and the Nightshade, its look-alike: the same bush, berry for berry in the same places, but
 * the berries black and round, and three purple star flowers open on it (they go with the berries when it is picked).
 * A short thick trunk; a SKIRT of leaves drooping to the ground, so the bush is full at the bottom; eight branches round
 * it and one up the middle, each with a whorl low on it and two side twigs, every twig carrying a spray of leaves with
 * gaps between them (no solid core: through a gap there are more leaves, never a ball); berries hanging in threes under
 * the six twigs that reach farthest out.
 * @param {Plant} k @param {boolean} night
 */
function bush(k, night) {
  k.stem([0, 0, 0], [0.01, 0.13, 0], 0.036, 0.026, 'bark', { sides: 6, rings: [[0.12, 1.15]] });
  // the skirt: two rings of leaves round the foot, drooping to the ground
  k.whorl([0, 0.07, 0], 13, 0.21, 0.115, -0.28, 0.1, HONEY, { out: 0.11, keep: 0.25 });
  k.whorl([0, 0.14, 0], 11, 0.2, 0.11, -0.05, 0.4, HONEY, { out: 0.17, keep: 0.25 });
  const tips = shrub(k, {
    root: [0.01, 0.11, 0], n: 8, len: [0.24, 0.31], elev: [0.28, 0.62], keys: HONEY, bark: 'bark', leaf: [0.165, 0.095], r: 0.015,
    up: 0.32, lift: 0.18, splay: 1.1,
  });
  const key = night ? 'night.berry' : 'honey.berry';
  // berries hang in threes under the six twigs that reach farthest out (far away one bigger berry stands for three)
  const outer = tips.map((t, i) => ({ t, i, r: Math.hypot(t[0][0], t[0][2]) })).sort((x, y) => y.r - x.r || x.i - y.i).slice(0, 6).sort((x, y) => x.i - y.i);
  for (const { t: [tip, a] } of outer) {
    const hang = add(tip, [Math.cos(a) * -0.02, -0.045, Math.sin(a) * -0.02]);
    /** @type {[number[], number][]} */
    const berries = [];
    for (let b = 0; b < 3; b++) {
      const ba = a + (b - 1) * 1.1 + k.jit(0.2);
      berries.push([add(hang, [Math.cos(ba) * 0.03, -(b % 2) * 0.02, Math.sin(ba) * 0.03]), ba]);
    }
    if (k.far) {
      k.gem(hang, [0, -1, 0], 0.034, night ? 0.065 : 0.075, key, { fruit: true, lift: 0.8 });
      continue;
    }
    for (const [p, ba] of berries) {
      const dir = [Math.cos(ba) * 0.3, -1, Math.sin(ba) * 0.3];
      if (night) k.gem(p, dir, 0.022, 0.042, key, { fruit: true, lift: 0.8, sides: 5 });
      else k.gem(p, dir, 0.02, 0.052, key, { fruit: true, lift: 0.82, mid: 0.42 });
    }
  }
  if (night) {
    // three purple stars: one on top, two on the sides
    /** @type {[number, number, number, Vec3][]} */
    const stars = [[0.03, 0.56, 0, [0.15, 1, 0]], [0.3, 0.36, 0.1, [1, 0.6, 0.3]], [-0.18, 0.38, -0.25, [-0.6, 0.6, -0.8]]];
    for (const [x, y, z, face] of stars) k.disc([x, y, z], face, 0.042, 'night.star', { sides: 5, fruit: true, dome: 0.008, lift: 0.9 });
  }
}

const HAZEL = ['hazel.leaf0', 'hazel.leaf1', 'hazel.leaf2'];

/**
 * The hazel thicket: a vase of seven slender stems leaning out of one stool, leaves stepping up each stem turn by turn
 * (and a side shoot on each), a low skirt of leaves; nuts in pale frilly husks in twos and threes among them.
 * @param {Plant} k
 */
function hazel(k) {
  k.whorl([0, 0.06, 0], 10, 0.15, 0.12, -0.25, 0.3, HAZEL, { shape: 'round', out: 0.07, keep: 0.3 });
  const stems = 7;
  for (let s = 0; s < stems; s++) {
    const a = (s * TAU) / stems + k.jit(0.3);
    const lean = 0.15 + k.range(0, 0.3);
    const len = 0.6 + k.range(0, 0.17);
    const base = [Math.cos(a) * 0.035, 0, Math.sin(a) * 0.035];
    const mid = add(base, scale(dirAt(a, Math.PI / 2 - lean), len * 0.55));
    const top = add(mid, scale(dirAt(a + k.jit(0.3), Math.PI / 2 - lean * 0.75), len * 0.45));
    k.stemPath([/** @type {Vec3} */ (base), mid, top], 0.014, 0.006, 'twig', { sides: 4 });
    // leaves turn by turn up the stem, pointing out and a little up
    k.spray(lerp3(base, mid, 0.35), mid, 6, 0.15, 0.125, HAZEL, { shape: 'round', splay: 1.15, phase: s });
    k.spray(mid, top, 7, 0.155, 0.13, HAZEL, { shape: 'round', splay: 1.0, phase: s + 0.5 });
    // a side shoot with a few leaves
    const from = lerp3(base, mid, 0.85);
    const sa = a + (s % 2 ? 0.9 : -0.9);
    const to = add(from, scale(dirAt(sa, 0.45), 0.2));
    if (!k.far) k.stem(from, to, 0.007, 0.004, 'twig', { sides: 3 });
    k.spray(lerp3(from, to, 0.2), to, 4, 0.14, 0.115, HAZEL, { shape: 'round', phase: s * 2 });
    // nuts: a cluster hanging under the leaves of four of the stems
    if (s % 2 === 0) {
      const hang = add(lerp3(base, mid, 0.95), add(scale(dirAt(a, 0), 0.04), [0, -0.03, 0]));
      const count = k.far ? 1 : 2 + (s % 4 === 0 ? 1 : 0);
      for (let j = 0; j < count; j++) {
        const na = a + (j - 0.5) * 1.3;
        const p = add(hang, [Math.cos(na) * 0.022, -j * 0.008, Math.sin(na) * 0.022]);
        const d = [Math.cos(na) * 0.5, -1, Math.sin(na) * 0.5];
        k.gem(p, d, k.far ? 0.026 : 0.018, k.far ? 0.05 : 0.036, 'hazel.nut', { fruit: true, lift: 0.75, sides: k.far ? 3 : 5, mid: 0.6 });
        if (!k.far) {
          // the husk: a frilly cup round the nut's upper half
          k.solid(p, add(p, d), {
            sides: 5, rx: 0.021, rz: 0.021, phase: 0.3, caps: false,
            rings: [{ y: -0.004, sx: 0.7 }, { y: 0.012, sx: 1.15 }, { y: 0.022, sx: 1.45 }],
          }, 'hazel.husk', { fruit: true, lift: 0.75 });
        }
      }
    }
  }
}

const APPLE = ['apple.leaf0', 'apple.leaf1', 'apple.leaf2'];

/**
 * The crab apple: a little tree — a trunk that leans a little to its fork, a round crown of branches and twigs each
 * carrying a spray of leaves, a ring of leaves under the crown; red apples hanging on short stalks round its rim.
 * @param {Plant} k
 */
function crabApple(k) {
  const fork = [0.03, 0.32, -0.01];
  k.stem([0, 0, 0], fork, 0.045, 0.034, 'appleBark', { sides: 6, rings: [[0.08, 1.2], [0.6, 0.95]] });
  k.whorl([fork[0], 0.42, fork[2]], 11, 0.19, 0.095, -0.38, 0.2, APPLE, { out: 0.2, keep: 0.25 });
  const tips = shrub(k, {
    root: /** @type {Vec3} */ (fork), n: 7, len: [0.3, 0.37], elev: [0.4, 0.8], keys: APPLE, bark: 'appleBark', leaf: [0.17, 0.09], r: 0.022,
    up: 0.42, phase: 0.1, lift: 0.22,
  });
  tips.filter((_, i) => i % 2 === 0).slice(0, 5).forEach(([tip, a]) => {
    // an apple hanging under the twig, on a short stalk
    const hang = add(tip, [Math.cos(a) * -0.03, -0.05, Math.sin(a) * -0.03]);
    if (!k.far) k.stem(hang, add(hang, [0, -0.03, 0]), 0.0035, 0.003, 'appleBark', { sides: 3, fruit: true });
    k.ball(add(hang, [0, -0.085, 0]), k.far ? 0.04 : 0.034, k.far ? 0.065 : 0.058, 'apple.fruit', {
      fruit: true, lift: 0.8, rings: [[0, 0.45], [0.25, 0.95], [0.65, 1], [0.9, 0.75], [1, 0.25]],
    });
  });
}

/**
 * Healwort: a pale, silvery rosette of pointed leaves lying out in two tiers, and three violet flower spikes on stalks
 * (the crop: cut, the spikes go).
 * @param {Plant} k
 */
function healwort(k) {
  const L = ['heal.leaf0', 'heal.leaf1'];
  k.whorl([0, 0.02, 0], 9, 0.24, 0.075, 0.18, 0, L, { shape: 'lance', out: 0.01 });
  k.whorl([0, 0.03, 0], 6, 0.17, 0.065, 0.6, 0.35, L, { shape: 'lance' });
  const spikes = [[0, 0.5, 0, 0], [0.1, 0.38, 0.06, 0.3], [-0.08, 0.32, -0.07, 0.35]];
  for (const [x, h, z, lean] of spikes) {
    const top = [x + Math.sign(x) * lean * 0.05, h, z + Math.sign(z) * lean * 0.05];
    k.stem([x * 0.3, 0.02, z * 0.3], top, 0.006, 0.005, 'stem', { sides: 4, fruit: true });
    k.solid(top, add(top, [x * 0.4, 1, z * 0.4]), {
      sides: k.far ? 4 : 6, rx: 0.026, rz: 0.026, phase: 0, caps: { top: false, bottom: true },
      rings: [{ y: 0, sx: 0.85 }, { y: 0.05, sx: 1 }, { y: 0.11, sx: 0.7 }, { y: 0.15, sx: 0 }],
    }, 'heal.spike', { fruit: true, lift: 0.75 });
    if (!k.far) k.leaf(add([x * 0.3, 0.02, z * 0.3], scale(vec.sub(top, [x * 0.3, 0.02, z * 0.3]), 0.5)), [x + 0.05, 0.6, z + 0.05], 0.06, 0.025, L[0], { shape: 'lance', fruit: true });
  }
}

/**
 * Wild onion: three white bulbs half out of the ground, each with three hollow leaves arching out of it; a tall stalk
 * from the middle one with a round white flower head.
 * @param {Plant} k
 */
function onion(k) {
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 + 0.4 + k.jit(0.2);
    const c = [Math.cos(a) * 0.075, 0, Math.sin(a) * 0.075];
    k.ball(/** @type {Vec3} */ (c), 0.038, 0.065, 'onion.bulb', { lift: 0.85, rings: [[0, 0.7], [0.32, 1], [0.7, 0.62], [1, 0.22]] });
    for (let j = 0; j < 3; j++) {
      const la = a + (j - 1) * 0.8 + k.jit(0.2);
      const base = add(c, [0, 0.06, 0]);
      const len = 0.3 + k.range(0, 0.14);
      const lean = 0.25 + k.range(0, 0.35);
      const p1 = add(base, scale(dirAt(la, Math.PI / 2 - lean * 0.5), len * 0.5));
      const p2 = add(p1, scale(dirAt(la, Math.PI / 2 - lean * 1.6), len * 0.5));
      k.stemPath([/** @type {Vec3} */ (base), p1, p2], 0.011, 0.004, 'onion.leaf', { sides: 4 });
    }
  }
  const top = [0.02, 0.6, -0.01];
  k.stem([0.01, 0.06, 0], top, 0.006, 0.005, 'onion.leaf', { sides: 4 });
  k.ball(add(top, [0, -0.01, 0]), 0.058, 0.1, 'onion.flower', { lift: 0.97, rings: [[0, 0.35], [0.25, 0.92], [0.6, 1], [0.88, 0.72], [1, 0.3]] });
}

/**
 * Wild carrot — and the Hemlock, its look-alike: the same lacy fronds arching out of a root crown; the carrot's crown
 * orange, the hemlock's pale; and over the hemlock's fronds what tells it: a purple-blotched stalk carrying a flat white
 * plate of florets, and two more plates on leaning stalks.
 * @param {Plant} k @param {boolean} hemlock
 */
function carrot(k, hemlock) {
  const crown = hemlock ? 'hemlock.crown' : 'carrot.crown';
  k.solid([0, 0, 0], [0, 1, 0], {
    sides: 6, rx: 0.05, rz: 0.05, phase: 0, caps: { top: true, bottom: false },
    rings: [{ y: 0, sx: 1.05 }, { y: 0.04, sx: 1 }, { y: 0.062, sx: 0.74 }],
  }, crown, { lift: 0.8 });
  const n = hemlock ? 5 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n + k.jit(0.25);
    const lean = 0.35 + k.range(0, 0.4);
    const out = dirAt(a, 0);
    const len = 0.36 + k.range(0, 0.1);
    k.frond([Math.cos(a) * 0.025, 0.055, Math.sin(a) * 0.025], dirAt(a, Math.PI / 2 - lean), out, len, 0.19, 0.7 + k.range(0, 0.4), 'carrot.frond', { segs: 3 });
  }
  k.frond([0, 0.055, 0], [0.05, 1, 0.02], [1, 0, 0.3], 0.38, 0.17, 0.25, 'carrot.frond', { segs: 2 });
  if (!hemlock) return;
  const top = [0.02, 0.76, 0.01];
  k.stem([0, 0.03, 0], top, 0.013, 0.008, 'hemlock.stalk', { sides: 6 });
  k.disc(top, [0.05, 1, 0], 0.15, 'hemlock.umbel', { sides: 8, dome: 0.045, lift: 0.95 });
  for (const [a, h, r, lean] of [[0.9, 0.6, 0.115, 0.55], [3.5, 0.56, 0.105, 0.6]]) {
    const from = [0.01, 0.34, 0];
    const to = add(from, scale(dirAt(a, Math.PI / 2 - lean), h - 0.34));
    const end = [to[0], h, to[2]];
    k.stem(/** @type {Vec3} */ (from), /** @type {Vec3} */ (end), 0.008, 0.006, 'hemlock.stalk', { sides: 4 });
    k.disc(/** @type {Vec3} */ (end), [Math.cos(a) * 0.15, 1, Math.sin(a) * 0.15], r, 'hemlock.umbel', { sides: 7, dome: 0.035, lift: 0.95 });
  }
}

/**
 * The wild tuber: broad heart-shaped leaves on short stalks lying out low in two tiers, the knobbly tuber just showing.
 * @param {Plant} k
 */
function tuber(k) {
  k.ball([0.02, 0, -0.01], 0.06, 0.06, 'tuber.skin', { sides: 6, rings: [[0, 0.8], [0.4, 1], [0.8, 0.75], [1, 0.4]] });
  const L = ['tuber.leaf0', 'tuber.leaf1'];
  for (const [n, tilt, len, ph, h] of [[6, 0.22, 0.28, 0, 0.07], [4, 0.62, 0.22, 0.5, 0.09]]) {
    for (let i = 0; i < n; i++) {
      const a = ph + (i * TAU) / n + k.jit(0.2);
      const at = [Math.cos(a) * 0.06, h, Math.sin(a) * 0.06];
      if (!k.far) k.stem([0, 0.04, 0], /** @type {Vec3} */ (at), 0.006, 0.005, 'stem', { sides: 3 });
      if (!k.far || i % 2 === 0) {
        const g = k.far ? 1.4 : 1;
        k.leaf(/** @type {Vec3} */ (at), dirAt(a, tilt + k.jit(0.1)), len * g, len * 0.9 * g, L[i % 2], { shape: 'heart', fold: 0.18, roll: k.jit(0.2) });
      }
    }
  }
}

const TUSSOCK = ['tussock.blade0', 'tussock.blade1', 'tussock.blade2'];

/**
 * Tussock grass: a dense tuft of blades — the inner ones standing, the outer ones arching out and over — green at the
 * foot, golden at the tips. It grows everywhere, so it stays light (about sixty triangles near, ten far).
 * @param {Plant} k
 */
function tussock(k) {
  const n = 22;
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n * 2.618 + k.jit(0.3);
    const inner = i % 3 === 0;
    const r = inner ? 0.012 : 0.03 + k.range(0, 0.03);
    const lean = inner ? k.range(0.05, 0.25) : k.range(0.3, 0.75);
    const len = inner ? k.range(0.45, 0.62) : k.range(0.34, 0.55);
    const bend = inner ? k.range(0.2, 0.5) : k.range(0.5, 1.1);
    if (k.far && i % 3 !== 1 && i % 6 !== 0) continue;
    k.blade([Math.cos(a) * r, 0, Math.sin(a) * r], dirAt(a, Math.PI / 2 - lean), dirAt(a, 0), len, k.far ? 0.08 : 0.05, bend, TUSSOCK[i % 3], { segs: 2 });
  }
}

/**
 * Cattails: three stalks of different heights, each with its brown velvet head and a thin spike above it, and long
 * blades at their feet arching out.
 * @param {Plant} k
 */
function cattails(k) {
  for (const [x, z, h] of [[-0.06, -0.02, 0.84], [0.05, -0.06, 0.7], [0.01, 0.07, 0.6]]) {
    const top = [x * 1.3, h, z * 1.3];
    k.stem([x, 0, z], /** @type {Vec3} */ (top), 0.008, 0.006, 'stem', { sides: 4 });
    const head = add(top, [0, -0.2, 0]);
    k.solid(head, add(head, [0, 1, 0]), {
      sides: k.far ? 4 : 6, rx: 0.033, rz: 0.033, phase: 0, caps: true,
      rings: [{ y: 0, sx: 0.6 }, { y: 0.02, sx: 1 }, { y: 0.15, sx: 1 }, { y: 0.175, sx: 0.55 }],
    }, 'cattail.head', { top: 'cattail.head', lift: 0.6 });
    if (!k.far) k.stem(add(head, [0, 0.17, 0]), add(head, [0.004, 0.24, 0]), 0.004, 0.0015, 'stem', { sides: 3 });
  }
  for (let i = 0; i < 9; i++) {
    const a = (i * TAU) / 9 + k.jit(0.3);
    if (k.far && i % 2) continue;
    k.blade([Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03], dirAt(a, Math.PI / 2 - k.range(0.1, 0.35)), dirAt(a, 0), k.range(0.5, 0.85), k.far ? 0.06 : 0.044, k.range(0.25, 0.8), 'cattail.leaf', { segs: 3 });
  }
}

/**
 * Prickly pear: thick oval pads growing out of each other's rims — one upright from the ground, two leaning out of its
 * top, a young one on one of them — spined in a diamond grid; red fruit sitting on their rims.
 * @param {Plant} k
 */
function pricklyPear(k) {
  const padShape = (h, w, t) => ({
    sides: k.far ? 4 : 6, rx: w, rz: t, phase: 0, caps: true,
    rings: k.far ? [{ y: 0, sx: 0.4 }, { y: h * 0.5, sx: 1 }, { y: h, sx: 0.4 }]
      : [{ y: 0, sx: 0.32 }, { y: h * 0.2, sx: 0.82 }, { y: h * 0.5, sx: 1 }, { y: h * 0.8, sx: 0.82 }, { y: h, sx: 0.32 }],
  });
  /** a pad from `at` along `dir`, its broad faces toward `face`; returns where its rim is ([left, top, right]) */
  const pad = (at, dir, face, h, w, t) => {
    k.solid(at, add(at, dir), padShape(h, w, t), 'pear.pad', { back: face, soft: 0.35 });
    const d = vec.unit(dir);
    const side = vec.unit(vec.cross(d, face));
    const tip = add(at, scale(d, h));
    return { tip, d, side, h, w };
  };
  const yaw = 0.3;
  const face = [Math.cos(yaw), 0, Math.sin(yaw)];
  const a = pad([0, 0, 0], [0, 1, 0.05], face, 0.34, 0.13, 0.034);
  const b = pad(add(a.tip, add(scale(a.side, 0.07), [0, -0.05, 0])), add(scale(a.side, 0.55), [0, 1, 0]), dirAt(yaw + 0.5, 0), 0.27, 0.105, 0.03);
  const c = pad(add(a.tip, add(scale(a.side, -0.07), [0, -0.05, 0])), add(scale(a.side, -0.5), [0, 1, 0.15]), dirAt(yaw - 0.4, 0), 0.25, 0.1, 0.03);
  pad(add(b.tip, [0, -0.04, 0]), add(scale(b.side, -0.3), [0, 1, 0]), dirAt(yaw + 0.9, 0), 0.14, 0.06, 0.022);
  // fruit on the rims of the upper pads
  /** @type {[{ tip: Vec3, d: Vec3, side: Vec3, w: number }, number][]} */
  const fruitAt = [[b, 0.0], [b, 0.6], [c, 0.0], [c, -0.6], [a, 0.75]];
  for (const [p, s] of fruitAt) {
    const at = add(p.tip, add(scale(p.side, s * p.w * 0.85), scale(p.d, -0.02 - Math.abs(s) * 0.05)));
    // the pale scar a fruit leaves on its pad when it is picked (under the fruit while it is there)
    k.disc(add(at, scale(p.d, 0.004)), p.d, 0.014, 'pear.scar', { sides: k.far ? 3 : 5, lift: 0.7 });
    k.ball(at, k.far ? 0.03 : 0.022, k.far ? 0.05 : 0.042, 'pear.fruit', { fruit: true, lift: 0.75, sides: 5, rings: [[0, 0.5], [0.4, 1], [0.85, 0.85], [1, 0.55]] });
  }
}

/**
 * The two mushrooms, a big one and a small one beside it. The Honeycap: a fat glossy golden dome on a fat cream stem,
 * a pale yellow sponge under it. The Frecklecap: a wide flat tawny cap with pale freckles and a low peak, white gills
 * under it, a thin white stem with a ring and a bulb at its foot.
 * @param {Plant} k @param {boolean} freckle
 */
function mushrooms(k, freckle) {
  const one = (x, z, s, lean) => {
    const S = (v) => v * s;
    const tilt = [Math.cos(lean[0]) * Math.sin(lean[1]), 1, Math.sin(lean[0]) * Math.sin(lean[1])];
    const stemH = freckle ? S(0.3) : S(0.22);
    const top = add([x, 0, z], scale(vec.unit(tilt), stemH));
    const pre = freckle ? 'frecklecap' : 'honeycap';
    k.solid([x, 0, z], top, {
      sides: 6, rx: S(freckle ? 0.022 : 0.04), rz: S(freckle ? 0.022 : 0.04), phase: 0, caps: false,
      rings: freckle
        ? [{ y: 0, sx: 1.6 }, { y: S(0.03), sx: 1.4 }, { y: S(0.06), sx: 1 }, { y: stemH, sx: 0.85 }]
        : [{ y: 0, sx: 1.15 }, { y: S(0.05), sx: 1.05 }, { y: stemH, sx: 0.82 }],
    }, `${pre}.stem`);
    if (freckle && !k.far) {
      // the ring on the stem
      const at = add([x, 0, z], scale(vec.unit(tilt), stemH * 0.72));
      k.solid(at, add(at, tilt), { sides: 6, rx: S(0.034), rz: S(0.034), phase: 0, caps: { top: true, bottom: false },
        rings: [{ y: -S(0.012), sx: 1 }, { y: 0, sx: 0.66 }] }, 'frecklecap.stem');
    }
    const capR = S(freckle ? 0.19 : 0.15);
    const rings = freckle
      ? [{ y: 0, sx: 1 }, { y: S(0.022), sx: 0.92 }, { y: S(0.048), sx: 0.62 }, { y: S(0.066), sx: 0.26 }, { y: S(0.08), sx: 0.07 }]
      : [{ y: 0, sx: 1 }, { y: S(0.055), sx: 0.94 }, { y: S(0.11), sx: 0.66 }, { y: S(0.142), sx: 0.24 }];
    const capAt = add(top, scale(vec.unit(tilt), freckle ? -S(0.012) : -S(0.03)));
    k.solid(capAt, add(capAt, tilt), {
      sides: k.far ? 5 : 6, rx: capR, rz: capR, phase: 0, caps: true, rings: k.far ? [rings[0], rings[2], rings[rings.length - 1]] : rings,
    }, `${pre}.cap`, { top: `${pre}.top`, bottom: freckle ? 'frecklecap.gills' : 'honeycap.pores', lift: 0.55 });
  };
  one(-0.04, -0.02, 1, [0.4, 0.06]);
  one(0.2, 0.12, 0.48, [0.6, 0.22]);
  if (!k.far) one(0.12, -0.2, 0.32, [-0.9, 0.3]);
}

/**
 * Fern: a fibrous crown; three young fronds standing in it; nine fronds arching out in two tiers, each a cut-out
 * feather on a strip that bends smoothly over, its tip toward the ground.
 * @param {Plant} k
 */
function fern(k) {
  k.ball([0, 0, 0], 0.045, 0.045, 'fern.crown', { sides: 6, rings: [[0, 1], [0.6, 0.9], [1, 0.4]] });
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 + 1.2 + k.jit(0.3);
    k.frond([Math.cos(a) * 0.01, 0.03, Math.sin(a) * 0.01], dirAt(a, Math.PI / 2 - 0.15), dirAt(a, 0), 0.4 + k.range(0, 0.1), 0.14, 0.4, 'fern.frond', { segs: 2 });
  }
  for (const [n, lean, len, bend, ph] of [[6, 0.45, 0.56, 0.95, 0.3], [5, 0.9, 0.5, 0.8, 0.9]]) {
    for (let i = 0; i < n; i++) {
      const a = ph + (i * TAU) / n + k.jit(0.25);
      if (k.far && i % 2) continue;
      k.frond([Math.cos(a) * 0.025, 0.035, Math.sin(a) * 0.025], dirAt(a, Math.PI / 2 - lean - k.jit(0.1)), dirAt(a, 0), len + k.range(0, 0.08),
        k.far ? 0.22 : 0.19, bend + k.range(0, 0.3), 'fern.frond', { segs: 4 });
    }
  }
}

/**
 * Meadow daisies: a low tuft of leaves, and four daisies on thin stems of different heights, each a flat white flower
 * with a golden heart tipped a little outward (it shows from the side as well as from above), and a bud.
 * @param {Plant} k
 */
function daisies(k) {
  k.whorl([0, 0.01, 0], 9, 0.16, 0.052, 0.5, 0, ['daisy.leaf0', 'daisy.leaf1'], { shape: 'lance' });
  const flowers = [[0.04, -0.02, 0.5, 0.1], [-0.05, 0.03, 0.4, 0.25], [0.03, 0.06, 0.33, 0.3], [-0.02, -0.06, 0.45, 0.2]];
  flowers.forEach(([x, z, h, lean], i) => {
    const a = Math.atan2(z, x);
    const mid = [x * 1.4 + Math.cos(a) * lean * 0.08, h * 0.5, z * 1.4 + Math.sin(a) * lean * 0.08];
    const top = [x * 1.6 + Math.cos(a) * lean * 0.2, h, z * 1.6 + Math.sin(a) * lean * 0.2];
    k.stemPath([[x * 0.4, 0, z * 0.4], /** @type {Vec3} */ (mid), /** @type {Vec3} */ (top)], 0.005, 0.0035, 'stem', { sides: 3 });
    if (i === 3 && !k.far) {
      k.gem(/** @type {Vec3} */ (top), [Math.cos(a) * 0.2, 1, Math.sin(a) * 0.2], 0.012, 0.03, 'onion.bulb', { lift: 0.8 });
      return;
    }
    if (!k.far) k.leaf(/** @type {Vec3} */ (mid), dirAt(a + 0.6, 0.5), 0.06, 0.02, 'daisy.leaf0', { shape: 'lance' });
    k.disc(/** @type {Vec3} */ (top), [Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5], 0.072, 'daisy.flower', { sides: 8, dome: 0.016, lift: 0.95, spin: i });
  });
}

/**
 * Thistle: a stout stalk, jagged spiny leaves arching out of it in two tiers and two small ones up the stalk; a scaly
 * green bulb on top with a purple brush on the bulb, and a smaller head on a side branch.
 * @param {Plant} k
 */
function thistle(k) {
  const top = [0.01, 0.56, 0];
  k.stem([0, 0, 0], top, 0.016, 0.01, 'stem', { sides: 6 });
  for (const [n, h, lean, len, ph] of [[4, 0.04, 1.05, 0.32, 0.2], [3, 0.2, 0.75, 0.26, 1.2], [2, 0.38, 0.6, 0.15, 0.6]]) {
    for (let i = 0; i < n; i++) {
      const a = ph + (i * TAU) / n + k.jit(0.2);
      if (k.far && i % 2) continue;
      k.frond([Math.cos(a) * 0.01, h, Math.sin(a) * 0.01], dirAt(a, Math.PI / 2 - lean), dirAt(a, 0), len, k.far ? 0.14 : 0.12, 0.5, 'thistle.leaf', { segs: 2 });
    }
  }
  const head = (at, s) => {
    k.solid(at, add(at, [0, 1, 0]), {
      sides: k.far ? 4 : 6, rx: 0.046 * s, rz: 0.046 * s, phase: 0, caps: { top: false, bottom: true },
      rings: [{ y: 0, sx: 0.45 }, { y: 0.03 * s, sx: 1 }, { y: 0.065 * s, sx: 0.78 }],
    }, 'thistle.bulb', { lift: 0.6 });
    k.solid(add(at, [0, 0.062 * s, 0]), add(at, [0, 1, 0]), {
      sides: k.far ? 4 : 6, rx: 0.036 * s, rz: 0.036 * s, phase: 0.5, caps: { top: true, bottom: false },
      rings: [{ y: 0, sx: 0.95 }, { y: 0.045 * s, sx: 1.12 }, { y: 0.055 * s, sx: 0.85 }],
    }, 'thistle.tuft', { lift: 0.8 });
  };
  head(/** @type {Vec3} */ (top), 1.3);
  const from = [0.005, 0.34, 0];
  const side = [0.13, 0.5, 0.05];
  k.stem(/** @type {Vec3} */ (from), /** @type {Vec3} */ (side), 0.008, 0.006, 'stem', { sides: 4 });
  head(/** @type {Vec3} */ (side), 0.9);
}

/**
 * Flax: six slender dark stems leaning apart out of one foot, tiny leaves up them, each topped by a sky-blue flower
 * tipped outward (and a bud on two of them).
 * @param {Plant} k
 */
function flax(k) {
  for (let i = 0; i < 6; i++) {
    const a = (i * TAU) / 6 + k.jit(0.3);
    const lean = 0.08 + k.range(0, 0.24);
    const h = 0.55 + k.range(0, 0.17);
    const base = [Math.cos(a) * 0.01, 0, Math.sin(a) * 0.01];
    const mid = add(base, scale(dirAt(a, Math.PI / 2 - lean * 0.6), h * 0.55));
    const top = add(mid, scale(dirAt(a, Math.PI / 2 - lean * 1.4), h * 0.47));
    k.stemPath([/** @type {Vec3} */ (base), mid, top], 0.0045, 0.003, 'stemDark', { sides: 3 });
    if (!k.far) {
      for (let j = 0; j < 4; j++) {
        const t = 0.2 + j * 0.17;
        const p = add(base, scale(vec.sub(mid, base), t / 0.55));
        k.leaf(p, dirAt(a + j * 2.1, 0.9), 0.06, 0.017, 'flax.leaf', { shape: 'lance', fold: 0.1 });
      }
    }
    k.disc(top, add(dirAt(a, 0), [0, 1.4, 0]), 0.046, 'flax.flower', { sides: 5, dome: 0.008, lift: 0.95, spin: i * 0.7 });
    if (i % 3 === 1 && !k.far) k.gem(add(mid, scale(dirAt(a + 1, 0.8), 0.04)), dirAt(a + 1, 0.8), 0.008, 0.024, 'flax.flower', { lift: 0.8 });
  }
}

/**
 * Aloe: a rosette of thick, pointed wedges — two standing in the middle, four leaning out round them, five lying out
 * low — sea green, pale-toothed along their edges.
 * @param {Plant} k
 */
function aloe(k) {
  const leaf = (a, lean, len, w) => {
    const d = dirAt(a, Math.PI / 2 - lean);
    k.solid([Math.cos(a) * 0.015, 0.004, Math.sin(a) * 0.015], d, {
      sides: 4, rx: w, rz: w * 0.42, phase: 0, caps: false,
      rings: [{ y: 0, sx: 0.8 }, { y: len * 0.16, sx: 1 }, { y: len * 0.58, sx: 0.74 }, { y: len, sx: 0 }],
    }, 'aloe.leaf', { back: [-Math.cos(a), 0.7, -Math.sin(a)], soft: 0.45 });
  };
  for (let i = 0; i < 2; i++) leaf(i * Math.PI + 0.3, 0.14, 0.4, 0.04);
  for (let i = 0; i < 4; i++) leaf((i * TAU) / 4 + 0.9 + k.jit(0.2), 0.55 + k.jit(0.08), 0.37, 0.047);
  const outer = k.far ? 3 : 6;
  for (let i = 0; i < outer; i++) leaf((i * TAU) / outer + 0.2 + k.jit(0.2), 1.02 + k.jit(0.1), 0.33, 0.05);
}

// ---- the farm (§80): a mound of tilled earth; a marker twig with a rag; a sprout of each crop's own kind ------------------

/** The mound: a low faceted heap of dark tilled earth, raked across its top. @param {Plant} k */
function mound(k) {
  k.solid([0, 0, 0], [0, 1, 0], {
    sides: 6, rx: 0.3, rz: 0.3, phase: 0.2, caps: { top: true, bottom: false },
    rings: [{ y: 0, sx: 1 }, { y: 0.05, sx: 0.84 }, { y: 0.085, sx: 0.6 }],
  }, 'earth', { top: 'earth.furrow' });
}

/** A planted seed: the mound, a marker twig pushed into it with a pale rag tied near its top. @param {Plant} k */
function seedbed(k) {
  mound(k);
  const foot = [0.08, 0.07, 0.02];
  const top = [0.1, 0.44, 0.04];
  k.stem(/** @type {Vec3} */ (foot), /** @type {Vec3} */ (top), 0.011, 0.008, 'twig', { sides: 5, caps: { top: true }, top: 'woodEnd' });
  k.blade(add(top, [0, -0.04, 0]), [0.35, -1, 0.2], [1, 0, 0.2], 0.13, 0.055, 0.5, 'rag', { segs: 2, taper: 0.7 });
}

/**
 * A sprout: the mound with a seedling of its crop's own kind standing in it — fronds of a carrot, an onion's hollow
 * leaves, a tuber's broad leaves, a twig of the bush or the tree it will be, a silver rosette, a tiny pad, reeds.
 * @param {Plant} k @param {string} crop  CROP_ROWS kind
 */
function sprout(k, crop) {
  mound(k);
  const y = 0.08;
  switch (crop) {
    case 'carrot':
      for (let i = 0; i < 4; i++) {
        const a = (i * TAU) / 4 + 0.3;
        k.frond([0, y, 0], dirAt(a, Math.PI / 2 - 0.35), dirAt(a, 0), 0.3, 0.13, 0.6, 'carrot.frond', { segs: 2 });
      }
      break;
    case 'onion':
      for (let i = 0; i < 3; i++) {
        const a = (i * TAU) / 3;
        const p1 = [Math.cos(a) * 0.03, y + 0.15, Math.sin(a) * 0.03];
        k.stemPath([[0, y - 0.01, 0], /** @type {Vec3} */ (p1), [Math.cos(a) * 0.1, y + 0.3, Math.sin(a) * 0.1]], 0.009, 0.004, 'onion.leaf', { sides: 4 });
      }
      k.ball([0, y - 0.02, 0], 0.028, 0.05, 'onion.bulb', { rings: [[0, 0.6], [0.4, 1], [1, 0.3]] });
      break;
    case 'tuber':
      k.stem([0, y, 0], [0, y + 0.14, 0], 0.006, 0.005, 'stem', { sides: 4 });
      for (let i = 0; i < 3; i++) k.leaf([0, y + 0.12 + i * 0.02, 0], dirAt(i * 2.2, 0.35), 0.17, 0.15, `tuber.leaf${i % 2}`, { shape: 'heart', fold: 0.15 });
      break;
    case 'honeyberry':
    case 'hazel':
    case 'crab_apple': {
      const bark = crop === 'honeyberry' ? 'bark' : crop === 'hazel' ? 'twig' : 'appleBark';
      const keys = crop === 'honeyberry' ? HONEY : crop === 'hazel' ? HAZEL : APPLE;
      const top = [0.01, y + 0.24, 0];
      k.stem([0, y - 0.01, 0], /** @type {Vec3} */ (top), 0.01, 0.005, bark, { sides: 4 });
      k.whorl([0.005, y + 0.13, 0], 3, 0.12, 0.07, 0.1, 0.4, keys, { shape: crop === 'hazel' ? 'round' : 'hex' });
      k.whorl(/** @type {Vec3} */ (top), 4, 0.13, 0.075, 0.45, 0, keys, { shape: crop === 'hazel' ? 'round' : 'hex' });
      k.leaf(/** @type {Vec3} */ (top), [0.3, 1, 0], 0.09, 0.055, keys[0]);
      break;
    }
    case 'healwort':
      k.whorl([0, y, 0], 7, 0.18, 0.06, 0.45, 0, ['heal.leaf0', 'heal.leaf1'], { shape: 'lance' });
      k.whorl([0, y + 0.01, 0], 3, 0.14, 0.05, 1.0, 0.5, ['heal.leaf1'], { shape: 'lance' });
      break;
    case 'prickly_pear':
      k.solid([0, y - 0.01, 0], [0.05, 1, 0], {
        sides: 6, rx: 0.08, rz: 0.026, phase: 0, caps: true,
        rings: [{ y: 0, sx: 0.35 }, { y: 0.05, sx: 0.85 }, { y: 0.11, sx: 1 }, { y: 0.18, sx: 0.75 }, { y: 0.22, sx: 0.3 }],
      }, 'pear.pad', { back: [1, 0, 0.3] });
      break;
    default: // cattails: thin reeds
      for (let i = 0; i < 5; i++) {
        const a = (i * TAU) / 5;
        k.blade([Math.cos(a) * 0.02, y, Math.sin(a) * 0.02], dirAt(a, Math.PI / 2 - 0.2), dirAt(a, 0), 0.38, 0.03, 0.5, 'cattail.leaf', { segs: 2 });
      }
  }
}

// ---- the ground litter (§75): stones (one of them flint where the column holds it), fallen branches, a nest ------------

/**
 * Loose stones: three faceted lumps of different sizes lying together, each a little irregular; with `flint`, the
 * middle one a dark, glassy flint nodule.
 * @param {Plant} k @param {boolean} flint
 */
function stones(k, flint) {
  const sizes = [[0.15, 0.13, 0.11], [0.105, 0.09, 0.08], [0.065, 0.06, 0.05]];
  sizes.forEach(([rx, rz, h], i) => {
    const a = i * 2.2 + k.jit(0.4);
    const d = [0.14, 0.22, 0.27][i];
    const at = [Math.cos(a) * d, 0, Math.sin(a) * d];
    const key = flint && i === 1 ? 'flint' : 'stone';
    const tw = [k.jit(0.15), k.jit(0.15)];
    const phase = k.range(0, 1);
    const roll = k.range(0, TAU);
    // far away a stone is a four-sided lump of two bands
    const rings = k.far
      ? [{ y: 0, sx: 0.95 }, { y: h * 0.5, sx: 0.95, dx: tw[0] * rx * 0.5 }, { y: h, sx: 0.45, dx: tw[0] * rx * 1.2, dz: tw[1] * rz }]
      : [{ y: 0, sx: 0.9 }, { y: h * 0.35, sx: 1, dx: tw[0] * rx * 0.3 }, { y: h * 0.75, sx: 0.78, dx: tw[0] * rx, dz: tw[1] * rz }, { y: h, sx: 0.42, dx: tw[0] * rx * 1.2, dz: tw[1] * rz }];
    k.solid(/** @type {Vec3} */ (at), add(at, [0, 1, 0]), {
      sides: k.far ? 4 : 6, rx, rz, phase, caps: { top: true, bottom: false }, rings,
    }, key, { top: key === 'flint' ? 'flint' : 'stone.top', roll });
  });
}

/**
 * Fallen branches: a stick lying on the ground, a second resting across it with one end propped, a twig standing off
 * them; snapped ends showing the pale wood; a few dead leaves.
 * @param {Plant} k
 */
function branches(k) {
  const turn = k.range(0, TAU);
  const along = (a, y, len, off) => {
    const c = Math.cos(turn + a);
    const s = Math.sin(turn + a);
    return /** @type {[Vec3, Vec3]} */ ([[-c * len / 2 + off[0], y, -s * len / 2 + off[1]], [c * len / 2 + off[0], y, s * len / 2 + off[1]]]);
  };
  const [a0, a1] = along(0, 0.04, 0.82, [0, 0]);
  k.stem(a0, a1, 0.04, 0.03, 'bark', { sides: 6, caps: true, top: 'woodEnd' });
  const [b0, b1] = along(1.15, 0.03, 0.56, [0.04, 0.03]);
  k.stem(b0, add(b1, [0, 0.09, 0]), 0.03, 0.022, 'bark', { sides: 6, caps: true, top: 'woodEnd' });
  const twigFrom = add(a0, scale(vec.sub(a1, a0), 0.7));
  k.stem(twigFrom, add(twigFrom, [0.08 * Math.cos(turn + 0.8), 0.2, 0.08 * Math.sin(turn + 0.8)]), 0.014, 0.006, 'bark', { sides: 4 });
  k.stem(add(a0, scale(vec.sub(a1, a0), 0.3)), add(a0, add(scale(vec.sub(a1, a0), 0.22), [0.12 * Math.sin(turn), 0.03, -0.12 * Math.cos(turn)])), 0.012, 0.006, 'bark', { sides: 4 });
  if (!k.far) {
    for (let i = 0; i < 4; i++) {
      const a = turn + i * 1.7 + k.jit(0.3);
      const r = 0.16 + k.range(0, 0.18);
      k.leaf([Math.cos(a) * r, 0.006, Math.sin(a) * r], dirAt(a + 1.2, -0.05), 0.11, 0.07, 'leaf.dead', { fold: 0.2, roll: k.jit(0.3) });
    }
  }
}

/**
 * A ground nest: a ring of dry grass woven round and round (a faceted wall, open at the top, a rim folded over), a bed of
 * grass inside, and — `fruit`, gone from the empty nest — three pale speckled eggs lying in it.
 * @param {Plant} k
 */
function nest(k) {
  k.solid([0, 0, 0], [0, 1, 0], {
    sides: k.far ? 5 : 8, rx: 0.27, rz: 0.27, phase: 0, caps: false,
    rings: k.far ? [{ y: 0, sx: 0.85 }, { y: 0.13, sx: 0.96 }, { y: 0.08, sx: 0.66 }]
      : [{ y: 0, sx: 0.78 }, { y: 0.06, sx: 1 }, { y: 0.12, sx: 0.96 }, { y: 0.135, sx: 0.78 }, { y: 0.08, sx: 0.66 }],
  }, 'nest');
  k.disc([0, 0.05, 0], [0, 1, 0], 0.19, 'nest.bed', { sides: k.far ? 5 : 8, dome: -0.01, lift: 0 });
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.4;
    const at = [Math.cos(a) * 0.075, 0.045, Math.sin(a) * 0.075];
    k.ball(/** @type {Vec3} */ (at), 0.038, 0.085, 'egg', { fruit: true, lift: 0.8, sides: k.far ? 4 : 6, tilt: [1.2, 0.3 * i], rings: [[0, 0.45], [0.3, 0.95], [0.62, 0.88], [1, 0.2]] });
  }
}

// ---- the table -----------------------------------------------------------------------------------------------------------

/** @type {Record<number, Recipe>} */
const RECIPES = {
  [BLOCK.HONEYBERRY_BUSH]: { variants: 2, build: (k) => bush(k, false) },
  [BLOCK.HONEYBERRY_BUSH_BARE]: { variants: 2, build: (k) => bush(k, false) },
  [BLOCK.NIGHTSHADE_BUSH]: { variants: 2, build: (k) => bush(k, true) },
  [BLOCK.NIGHTSHADE_BUSH_BARE]: { variants: 2, build: (k) => bush(k, true) },
  [BLOCK.HAZEL_THICKET]: { variants: 2, build: hazel },
  [BLOCK.HAZEL_THICKET_BARE]: { variants: 2, build: hazel },
  [BLOCK.CRAB_APPLE_BUSH]: { variants: 2, build: crabApple },
  [BLOCK.CRAB_APPLE_BUSH_BARE]: { variants: 2, build: crabApple },
  [BLOCK.HEALWORT_PLANT]: { variants: 2, build: healwort },
  [BLOCK.HEALWORT_PLANT_BARE]: { variants: 2, build: healwort },
  [BLOCK.ONION_PLANT]: { variants: 2, build: onion },
  [BLOCK.CARROT_PLANT]: { variants: 2, build: (k) => carrot(k, false) },
  [BLOCK.HEMLOCK]: { variants: 2, build: (k) => carrot(k, true) },
  [BLOCK.TUBER_PLANT]: { variants: 2, build: tuber },
  [BLOCK.TUSSOCK]: { variants: 3, build: tussock, open: 0.5 },
  [BLOCK.CATTAILS]: { variants: 2, build: cattails },
  [BLOCK.PRICKLY_PEAR]: { variants: 2, build: pricklyPear, open: 0.3 },
  [BLOCK.PRICKLY_PEAR_BARE]: { variants: 2, build: pricklyPear, open: 0.3 },
  [BLOCK.HONEYCAP_MUSHROOM]: { variants: 2, build: (k) => mushrooms(k, false), open: 0.25 },
  [BLOCK.FRECKLECAP_MUSHROOM]: { variants: 2, build: (k) => mushrooms(k, true), open: 0.25 },
  [BLOCK.FERN]: { variants: 3, build: fern },
  [BLOCK.MEADOW_DAISIES]: { variants: 3, build: daisies },
  [BLOCK.THISTLE]: { variants: 3, build: thistle },
  [BLOCK.FLAX]: { variants: 2, build: flax },
  [BLOCK.ALOE]: { variants: 2, build: aloe, open: 0.3 },
  [BLOCK.LOOSE_STONES]: { variants: 3, build: (k, v) => stones(k, v === LOOSE_STONES_FLINT), noCard: true, open: 0.2 },
  [BLOCK.FALLEN_BRANCHES]: { variants: 2, build: branches, noCard: true, open: 0.2 },
  [BLOCK.GROUND_NEST]: { variants: 1, build: nest, noCard: true, open: 0.25 },
  [BLOCK.GROUND_NEST_EMPTY]: { variants: 1, build: nest, noCard: true, open: 0.25 },
};
// §80: each crop's planted seed is the one seedbed; its sprout is a seedling of its own kind
CROP_ROWS.forEach(([KEY, kind]) => {
  RECIPES[BLOCK[`PLANTED_${KEY}`]] = { variants: 1, build: seedbed, noCard: true, open: 0.2 };
  RECIPES[BLOCK[`${KEY}_SPROUT`]] = { variants: 1, build: (k) => sprout(k, kind), noCard: true, open: 0.25 };
});

/** The picked plants: their recipe is their ripe plant's, built bare (the picked Nightshade is the picked Honeyberry). */
/** @type {Set<number>} */
const BARE = new Set([
  BLOCK.HONEYBERRY_BUSH_BARE, BLOCK.NIGHTSHADE_BUSH_BARE, BLOCK.HAZEL_THICKET_BARE, BLOCK.CRAB_APPLE_BUSH_BARE,
  BLOCK.HEALWORT_PLANT_BARE, BLOCK.PRICKLY_PEAR_BARE, BLOCK.GROUND_NEST_EMPTY,
]);
/**
 * A picked plant grows from its ripe plant's seed (the same plant, less its fruit); the Nightshade, ripe or picked, from
 * the Honeyberry's (its berries stand where the honeyberry's do; picked, it is the picked Honeyberry, leaf for leaf).
 */
const SEED_OF = {
  [BLOCK.HONEYBERRY_BUSH_BARE]: BLOCK.HONEYBERRY_BUSH, [BLOCK.NIGHTSHADE_BUSH]: BLOCK.HONEYBERRY_BUSH,
  [BLOCK.NIGHTSHADE_BUSH_BARE]: BLOCK.HONEYBERRY_BUSH, [BLOCK.HAZEL_THICKET_BARE]: BLOCK.HAZEL_THICKET,
  [BLOCK.CRAB_APPLE_BUSH_BARE]: BLOCK.CRAB_APPLE_BUSH, [BLOCK.HEALWORT_PLANT_BARE]: BLOCK.HEALWORT_PLANT,
  [BLOCK.PRICKLY_PEAR_BARE]: BLOCK.PRICKLY_PEAR, [BLOCK.GROUND_NEST_EMPTY]: BLOCK.GROUND_NEST,
};

/** The flint variant of LOOSE_STONES: the mesher shows it where blocks.flintAt says the column holds flint (§70). */
export const LOOSE_STONES_FLINT = 2;

/** The block ids drawn by this module's kit models (the plants, the farm's blocks, the ground litter), in id order. */
export const KIT_MODEL_IDS = Object.freeze(Object.keys(RECIPES).map(Number).sort((a, b) => a - b));

/** @param {number} id @returns {boolean} block `id` is drawn by a kit model */
export function isKitModel(id) {
  return RECIPES[id] !== undefined;
}

/**
 * How many variants block `id` has (0: no kit model). LOOSE_STONES has two plain ones; its flint one
 * (LOOSE_STONES_FLINT) is chosen by flintAt, not by chance.
 * @param {number} id
 */
export function plantVariants(id) {
  const r = RECIPES[id];
  if (!r) return 0;
  return id === BLOCK.LOOSE_STONES ? 2 : r.variants;
}

/** @param {number} id @param {number} v @returns {number} the seed its variant v is built from */
function seedOf(id, v) {
  // the nightshade (ripe or picked) grows from the honeyberry's seed: its berries stand where the honeyberry's do
  const s = SEED_OF[id] ?? id;
  return Math.imul(s + 1, 0x9e3779b1) ^ Math.imul(v + 1, 0x85ebca6b);
}

/**
 * Build block `id`'s model at level of detail `lod` (NEAR or FAR), variant `v`, uncached (the gallery and the tests).
 * @param {number} id @param {number} lod @param {number} [v]
 * @returns {CompiledPlant|null}
 */
export function buildPlantModel(id, lod, v = 0) {
  const r = RECIPES[id];
  if (!r) return null;
  const k = new Plant(lod === PLANT_LOD_FAR ? PLANT_LOD_FAR : PLANT_LOD_NEAR, BARE.has(id), seedOf(id, v));
  r.build(k, v);
  return k.compile({ open: r.open });
}

/** @type {Map<number, CompiledPlant|null>} */
const cache = new Map();

/**
 * Block `id`'s compiled model at `lod`, variant `v` (wrapped into its count), cached: what the chunk mesher copies.
 * CARD is two crossed pictures of the block's own tile (plantCard), or the FAR model for litter and the farm's mounds.
 * @param {number} id @param {number} lod @param {number} [v]
 * @returns {CompiledPlant|null}
 */
export function plantMesh(id, lod, v = 0) {
  const r = RECIPES[id];
  if (!r) return null;
  const n = id === BLOCK.LOOSE_STONES ? 3 : r.variants;
  const vv = ((v % n) + n) % n;
  const L = lod === PLANT_LOD_CARD && r.noCard ? PLANT_LOD_FAR : lod;
  const key = (id * 4 + L) * 4 + vv;
  let m = cache.get(key);
  if (m === undefined) {
    m = L === PLANT_LOD_CARD ? plantCard(id) : buildPlantModel(id, L, vv);
    cache.set(key, m);
  }
  return m;
}

// =====================================================================================================================
// The card: two crossed pictures of the block's own tile, as tall as the plant, for the far distance
// =====================================================================================================================

/** How much darker a card's foot is than its top. */
export const CARD_ROOT_SHADE = 0.72;

/**
 * Two crossed quads of block `id`'s TOP tile (its Pack picture), from the BLOCK atlas: sized so the picture's plant is as
 * tall as the near model, its foot on the floor; normals straight up (lit evenly, like a top face), darker at the root.
 * @param {number} id
 * @returns {CompiledPlant}
 */
export function plantCard(id) {
  const near = plantMesh(id, PLANT_LOD_NEAR, 0);
  const tile = getFaceTile(id, 6);
  const px = paintTile(tile);
  let topRow = 16;
  for (let y = 0; y < 16 && topRow === 16; y++) for (let x = 0; x < 16; x++) if (px[(y * 16 + x) * 4 + 3] > 0) { topRow = y; break; }
  const rows = Math.max(1, 16 - topRow);
  const H = /** @type {CompiledPlant} */ (near).height;
  const S = (H * 16) / rows; // the whole tile's side, metres
  const [u0, v0, u1, v1] = tileToUV(tile);
  const data = new Float32Array(8 * PLANT_STRIDE);
  const index = new Uint16Array(12);
  let o = 0;
  for (let q = 0; q < 2; q++) {
    const a = q * (Math.PI / 2) + Math.PI / 4;
    const cx = Math.cos(a) * (S / 2);
    const cz = Math.sin(a) * (S / 2);
    const corners = [[-cx, 0, -cz, u0, v1, CARD_ROOT_SHADE], [cx, 0, cz, u1, v1, CARD_ROOT_SHADE], [cx, S, cz, u1, v0, 1], [-cx, S, -cz, u0, v0, 1]];
    for (const [x, y, z, u, v, s] of corners) {
      data.set([x, y, z, 0, 1, 0, u, v, s], o);
      o += PLANT_STRIDE;
    }
    index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }
  return {
    data, index, verts: 8, tris: 4, block: true, keys: [`tile:${tile}`], vkey: new Uint8Array(8), vfruit: new Uint8Array(8),
    height: S, reach: S / 2,
  };
}

// =====================================================================================================================
// §85: the furniture's BOX models — the well, the rain barrel, the two beds: boxes and cards cut from 16-px skins
// =====================================================================================================================
//
// A box model is a list of parts sized in TEXELS (BOX_TEXELS 16 to the metre; x and z from the middle of the cell, y up
// from its floor): `box` (at the middle of its base, size [w, h, d], `side` a tile rect [u, v, w, h] shown on its four
// sides, optional `end` for the two faces across its x axis, `top` (default `side`; null when something sits on it),
// `under`), `card` (one upright picture across the part's z axis), `group` (members in a frame of their own); any part
// may `yaw`, `lean`, `shade`, and be `fruit` (left off when compiled `bare`). compileBoxModel turns a part list into
// flat quads the chunk mesher copies out, turned and sized per cell.

/** Texels per metre of a box model. */
export const BOX_TEXELS = 16;
/** Floats per compiled quad: 4 × (x, y, z in metres, u, v in texels of the tile) + the outward normal + a shade. */
export const BOX_QUAD_STRIDE = 24;
/** How much of a card's normal tilt survives (0 a wall, 1 its true face): keeps a leaning card's underside from going black. */
export const CARD_NORMAL_LIFT = 0.5;

/**
 * @typedef {[number, number, number, number]} Rect  [u, v, w, h]: a rectangle of the model's tile, in texels (v down)
 * @typedef {Object} BoxPart
 * @property {'box'|'card'|'group'} kind
 * @property {number[]} at
 * @property {number[]} [size]
 * @property {Rect} [side]
 * @property {Rect} [end]
 * @property {Rect|null} [top]
 * @property {Rect} [under]
 * @property {number} [yaw]
 * @property {number} [lean]
 * @property {number} [taper]
 * @property {number} [shade]
 * @property {boolean} [fruit]
 * @property {BoxPart[]} [parts]
 */

/** @typedef {{ p: number[][], uv: number[][], n: number[], shade: number, card: boolean }} Quad */

/** @param {number[]} at @param {number[]} size @param {Rect} side @param {Partial<BoxPart>} [o] @returns {BoxPart} */
const box = (at, size, side, o = {}) => ({ kind: 'box', at, size, side, ...o });
/** @param {number[]} at @param {Partial<BoxPart>} o @param {BoxPart[]} parts @returns {BoxPart} */
const group = (at, o, parts) => ({ kind: 'group', at, parts, ...o });
/**
 * `n` groups in a ring of `radius` about the middle, the first at angle `phase`: each group's +x points outward.
 * @param {number} n @param {number} radius @param {number} phase @param {(i: number) => BoxPart[]} make
 * @returns {BoxPart[]}
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

/** @param {BoxPart} part @param {boolean} bare @returns {Quad[]} */
function quadsOf(part, bare) {
  if (bare && part.fruit) return [];
  const quads = part.kind === 'group' ? (part.parts ?? []).flatMap((p) => quadsOf(p, bare))
    : part.kind === 'card' ? cardQuads(part) : boxQuads(part);
  return place(quads, part.at, part.yaw ?? 0, -(part.lean ?? 0));
}

/**
 * Compile a box part list into BOX_QUAD_STRIDE floats per quad: four corners (x, y, z in METRES from the middle of the
 * cell's floor, then u, v in texels of the tile), the unit normal, the shade. `bare` leaves the fruit off.
 * @param {BoxPart[]} parts
 * @param {boolean} [bare]
 * @returns {Float32Array}
 */
export function compileBoxModel(parts, bare = false) {
  const quads = parts.flatMap((p) => quadsOf(p, bare));
  const out = new Float32Array(quads.length * BOX_QUAD_STRIDE);
  let o = 0;
  for (const q of quads) {
    for (let v = 0; v < 4; v++) {
      out[o++] = q.p[v][0] / BOX_TEXELS;
      out[o++] = q.p[v][1] / BOX_TEXELS;
      out[o++] = q.p[v][2] / BOX_TEXELS;
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

/**
 * The Well: a hexagonal ring of six big stones (alternately 7 and 6 texels high), two posts standing on opposite
 * stones with a beam across them, a cord wound on the beam and hanging down the shaft. Full (`fruit`): water near
 * the rim and the clay pot hanging over it. Drawn (compiled `bare`): the dark of the shaft, the cord running down
 * into it — the pot is below, filling.
 */
const WELL_WATER = /** @type {Rect} */ ([0, 7, 8, 8]);
const WELL_DARK = /** @type {Rect} */ ([14, 7, 2, 3]);
const WELL_POST = /** @type {Rect} */ ([11, 7, 2, 8]);
const WELL_CORD = /** @type {Rect} */ ([13, 7, 1, 8]);
const WELL_BEAM = /** @type {Rect} */ ([0, 15, 14, 1]);
const WELL = [
  ...ring(6, 5.25, 0, (i) => [
    box([0, 0, 0], [3, i % 2 ? 6 : 7, 7], i % 2 ? [8, 1, 3, 6] : [2, 0, 3, 7], { end: i % 2 ? [5, 1, 7, 6] : [0, 0, 7, 7], top: [8, 7, 3, 7] }),
  ]),
  box([0, 0, 0], [7.6, 1.5, 8.8], WELL_DARK, { top: WELL_DARK }),
  box([0, 0, 0], [7.6, 5, 8.8], WELL_WATER, { top: WELL_WATER, fruit: true }),
  box([5.25, 6, 0], [1.5, 7.5, 1.5], WELL_POST, { top: null }),
  box([-5.25, 6, 0], [1.5, 7.5, 1.5], WELL_POST, { top: null }),
  box([0, 13, 0], [13.5, 1.5, 1.5], WELL_BEAM, { end: [12, 15, 2, 1], under: WELL_BEAM }),
  box([0, 12.5, 0], [3, 2.5, 2.5], [13, 7, 1, 3], { under: [13, 7, 1, 3] }),
  box([0, 1.5, 0], [0.75, 11, 0.75], WELL_CORD, { top: null }),
  box([0, 6, 0], [3.5, 3, 3.5], [14, 11, 2, 3], { top: [14, 7, 2, 2], under: [14, 13, 2, 2], fruit: true }),
  box([0, 9, 0], [4.5, 1, 4.5], [14, 10, 2, 1], { top: [14, 7, 2, 2], under: [14, 10, 2, 1], fruit: true }),
];

/**
 * The Rain Barrel holding `pots` pots (0..3): six upright stave walls in a hexagonal ring (alternately 13 and 12.5
 * texels high, 2 thick) bound by two cord hoops painted across them, open at the top. Inside, the dark boards of its
 * bottom — or the water, a third of the way up for each pot, so how much it holds is seen from above. (The plate
 * inside is 7.1 × 8.2: it covers the hexagon the staves leave open and its corners stay inside them.)
 * @param {number} pots
 * @returns {BoxPart[]}
 */
const BARREL_WATER = /** @type {Rect} */ ([8, 0, 8, 8]);
const BARREL_DARK = /** @type {Rect} */ ([8, 8, 8, 5]);
const rainBarrel = (pots) => [
  ...ring(6, 4.5, 0, (i) => [
    box([0, 0, 0], [2, i % 2 ? 12.5 : 13, 6.2], [0, 0, 2, 13], { end: [i % 2 ? 1 : 0, 0, 6, 13], top: [0, 13, 2, 3] }),
  ]),
  pots > 0
    ? box([0, 0, 0], [7.1, 1 + 3.5 * pots, 8.2], BARREL_WATER, { top: BARREL_WATER })
    : box([0, 0, 0], [7.1, 1, 8.2], BARREL_DARK, { top: BARREL_DARK }),
];

/**
 * The Grass Bed: three sticks laid side by side, a wide heap of dry grass on them, a smaller heap on that and a
 * bolster of grass at the head. Everything is cut from the bed's own picture.
 */
const STRAW = /** @type {Rect} */ ([2, 5, 12, 8]);
const BED_STICK = /** @type {Rect} */ ([0, 14, 14, 1]);
const GRASS_BED = [
  ...[-3.25, 0, 3.25].map((z) => box([0, 0, z], [14.5, 1.5, 1.5], BED_STICK, { end: [0, 13, 2, 2] })),
  box([0, 1.5, 0], [13, 3, 9], [2, 7, 12, 3], { end: [3, 9, 9, 3], top: STRAW }),
  box([0.5, 4.5, 0], [10, 2, 7], [3, 5, 10, 2], { end: [4, 6, 7, 2], top: [3, 6, 10, 7] }),
  box([-3.5, 6.5, 0], [4, 1.5, 6], [5, 5, 4, 2], { end: [5, 5, 6, 2], top: [3, 5, 4, 6] }),
];

/**
 * The Bed: a wooden frame on four legs with a tall headboard and a low footboard, a pale stuffed mattress, a white
 * pillow at the head and a red woollen blanket with two yellow stripes over the rest.
 */
const BED_WOOD = /** @type {Rect} */ ([0, 0, 9, 8]);
const BED_LEG = /** @type {Rect} */ ([0, 12, 2, 3]);
const BED_BLANKET = /** @type {Rect} */ ([9, 0, 7, 8]);
const BED = [
  ...[[-5.25, -3.5], [-5.25, 3.5], [5.25, -3.5], [5.25, 3.5]].map(([x, z]) => box([x, 0, z], [2, 3, 2], BED_LEG, { top: null })),
  box([0, 3, 0], [13, 2, 9], [0, 3, 9, 2], { end: [0, 3, 9, 2], top: [0, 0, 9, 8], under: [0, 6, 9, 2] }),
  box([-6, 3, 0], [1.5, 8, 9.5], [0, 0, 2, 8], { end: BED_WOOD, top: [0, 0, 2, 8] }),
  box([6, 3, 0], [1.5, 4, 9.5], [0, 3, 2, 4], { end: [0, 3, 9, 4], top: [0, 3, 2, 5] }),
  box([0, 5, 0], [10.5, 2, 8], [0, 8, 10, 2], { end: [0, 8, 8, 2], top: [0, 8, 10, 4] }),
  box([-3.25, 7, 0], [3, 1.5, 6], [12, 8, 3, 2], { end: [12, 8, 4, 2], top: [12, 8, 3, 6] }),
  box([1.75, 7, 0], [7, 1, 8.5], [4, 12, 7, 1], { end: [4, 12, 8, 2], top: BED_BLANKET }),
];

/**
 * @typedef {Object} BoxModelDef
 * @property {BoxPart[]} parts
 * @property {boolean} [bare]  compiled without its `fruit` (the drawn well)
 * @property {number} [tile]   the tile the faces are cut from, when it is not the block's own
 */

/**
 * The box model of each piece of furniture, by block id.
 * @type {Readonly<Record<number, BoxModelDef>>}
 */
export const FURNITURE_MODELS = Object.freeze({
  [BLOCK.WELL]: { parts: WELL, tile: TILE.WELL_SKIN },
  [BLOCK.WELL_DRAWN]: { parts: WELL, bare: true, tile: TILE.WELL_SKIN },
  [BLOCK.RAIN_BARREL]: { parts: rainBarrel(0), tile: TILE.RAIN_BARREL_SKIN },
  [BLOCK.RAIN_BARREL_1]: { parts: rainBarrel(1), tile: TILE.RAIN_BARREL_SKIN },
  [BLOCK.RAIN_BARREL_2]: { parts: rainBarrel(2), tile: TILE.RAIN_BARREL_SKIN },
  [BLOCK.RAIN_BARREL_3]: { parts: rainBarrel(3), tile: TILE.RAIN_BARREL_SKIN },
  [BLOCK.GRASS_BED]: { parts: GRASS_BED },
  [BLOCK.BED]: { parts: BED, tile: TILE.BED_SKIN },
});

/**
 * The compiled box model of furniture block `id` (compileBoxModel's quads), or null.
 * @param {number} id
 * @returns {Float32Array|null}
 */
export function furnitureModel(id) {
  const m = FURNITURE_MODELS[id];
  return m ? compileBoxModel(m.parts, m.bare === true) : null;
}

/**
 * The tile a furniture model's faces are cut from when it is not the block's own top tile, else null.
 * @param {number} id
 * @returns {number|null}
 */
export function furnitureModelTile(id) {
  return FURNITURE_MODELS[id]?.tile ?? null;
}

/** The farm blocks, re-exported for the gallery and the tests (each has a kit model). */
export { FARM_IDS };

/** A blade-shaped ribbon geometry (the gallery draws a few of them for scale). */
export { ribbonGeo };
