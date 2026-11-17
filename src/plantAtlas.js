// Caelancraft — the PLANT ATLAS: every picture the plants' 3D models are painted with (PURE: RGBA typed arrays, no three,
// no DOM). See src/CONTRACTS.md §102 and docs/DESIGN-characters.md (phase 4).
//
// The plants left the 16-px tiles: their models (plantModels.js) are hex-faceted parts — faceted stems, leaf CARDS,
// gem berries, faceted caps — painted in code with paintKit.js at about 160 texels a metre: leaves with a midrib and
// side veins, darker at the stalk, lighter at the tip; bark with ridges; berries with a dusty bloom and a glint; apples
// with a blush; petals, florets, spines and gills. One image holds every picture of every plant (and the ground
// litter's stones, flint, sticks and nest), PLANT_ATLAS_W × PLANT_ATLAS_H, each picture a named rectangle packed
// tallest first with a gutter of PLANT_ATLAS_PAD pixels (bleed() fills it). The chunk mesher binds it beside the block
// atlas (renderer.js: the cutout material samples it where a vertex's u is past PLANT_UV_OFFSET).
//
// Two kinds of picture:
//   - SOLID ones (alpha 255 everywhere): a leaf's face, bark, a berry's skin. The model's geometry gives the outline (a
//     hexagonal leaf card is the hexagon), so a picture is the surface, not a silhouette.
//   - CUT-OUTS (alpha 0 or 255 after the alpha test): a fern's frond, a carrot's lacy leaves, a daisy's petals, a
//     hemlock's florets — shapes too fine to build. Their see-through texels carry the colour of their nearest painted
//     neighbour (dilate), so filtering never pulls in black.
// The layout (which rectangle is where) is known without painting (plantAtlasLayout: the mesher needs only the uvs);
// paintPlantAtlas() paints it once (about 100 ms) and plantAtlasMips() makes its mip chain (colour alpha-weighted, alpha
// between the mean and the most opaque child, so a frond thins far away but never vanishes).
import { Atlas, Painter, createImage, mix, shade, hash2, fbm, makeRng, bleed } from './paintKit.js';

/** @typedef {import('./paintKit.js').Img} Img */
/** @typedef {import('./paintKit.js').Rect} Rect */

/** The atlas's size in pixels (its rectangles fit with room to spare: plantAtlas.test.js). */
export const PLANT_ATLAS_W = 1024;
export const PLANT_ATLAS_H = 256;
/** The gutter round every rectangle: four pixels, so the first two mip levels never reach a neighbour. */
export const PLANT_ATLAS_PAD = 4;
/** Mip levels of the atlas texture (1024 × 256 → 32 × 8). */
export const PLANT_ATLAS_MIPS = 6;
/**
 * A plant vertex's u is its atlas u + PLANT_UV_OFFSET: the chunk's cutout material samples the plant atlas where u is
 * past PLANT_UV_OFFSET − 0.5 and the block atlas everywhere else (one material, one draw per chunk layer).
 */
export const PLANT_UV_OFFSET = 2;

/**
 * @typedef {Object} PictureDef
 * @property {string} key
 * @property {number} w
 * @property {number} h
 * @property {(p: Painter) => void} paint
 * @property {boolean} cut   a cut-out (alpha matters)
 */

/** @type {PictureDef[]} */
const PICTURES = [];

/**
 * Register a picture. `wrap` registers three: `key` (the strip round a solid), `key:top` and `key:bottom` (its caps).
 * @param {string} key @param {number} w @param {number} h @param {(p: Painter) => void} paint @param {{ cut?: boolean }} [o]
 */
function pic(key, w, h, paint, { cut = false } = {}) {
  PICTURES.push({ key, w, h, paint, cut });
}

// ---------------------------------------------------------------------------------------------------------------------
// Painters
// ---------------------------------------------------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A leaf's face, filling the rectangle (tip at the top row, stalk at the bottom): darker toward the stalk and the
 * edges, lighter toward the tip, a pale midrib, paired side veins sweeping toward the tip, a fine mottle. `tip` tints the
 * last third (a yellowing hazel leaf, a golden blade); `vein` the veins' colour; `veins` how many pairs.
 * @param {Painter} p @param {number[]} ramp [light, mid, dark]
 */
function leafFace(p, ramp, { tip = -1, tipK = 0.35, veins = 6, vein = mix(ramp[1], ramp[0], 0.75), rib = 0.8, edge = 0.32, sheen = 0.08 } = {}) {
  const { w, h } = p;
  const cx = w / 2;
  p.fill((x, y) => {
    const t = 1 - y / h; // 0 stalk, 1 tip
    let c = mix(ramp[2], ramp[1], clamp01(0.3 + t * 1.2));
    c = mix(c, ramp[0], clamp01((t - 0.6) * 0.9) * 0.4);
    if (tip >= 0) c = mix(c, tip, clamp01((t - 0.62) * 2.6) * tipK);
    // one half catches the light a little more than the other
    if (x < cx) c = shade(c, 1 + sheen);
    return shade(c, 0.95 + 0.1 * hash2(x, y, p.seed));
  });
  p.mottle(0.07, 3);
  // side veins: pairs from the midrib toward the edges, sweeping up toward the tip
  for (let v = 0; v < veins; v++) {
    const y = h * (0.9 - (v + 0.5) * (0.82 / veins));
    const rise = h * 0.11;
    p.line(cx, y, w * 0.08, y - rise, 0.42, vein, 0.55).line(cx, y, w * 0.92, y - rise, 0.42, vein, 0.55);
  }
  p.line(cx, h + 1, cx, h * 0.03, rib * 0.6, vein, 0.85);
  p.ao({ left: edge, right: edge, width: 0.3 }).ao({ bottom: 0.3, width: 0.2 });
}

/**
 * A tapering blade (grass, a reed, a cattail's leaf; tip at the top): fine lengthwise streaks over a gradient from
 * `base` (the bottom row) through `mid` to `tip` (the top), a pale midline.
 */
function bladeFace(p, base, mid, tip, { streak = 0.12 } = {}) {
  const { w, h } = p;
  p.fill((x, y) => {
    const t = 1 - y / h;
    const c = t < 0.5 ? mix(base, mid, t * 2) : mix(mid, tip, (t - 0.5) * 2);
    const s = fbm(x * 1.7, y / 9, p.seed, 2);
    return shade(c, 1 - streak + 2 * streak * s);
  });
  p.line(w / 2, h, w / 2, 0, 0.5, mix(mid, 0xf4f4c8, 0.3), 0.5);
  p.ao({ left: 0.25, right: 0.25, width: 0.35 });
}

/** A round skin (a berry, an apple, a nut): `ramp` [light, mid, dark] lit from the upper left, a glint, a `bloom`. */
function roundSkin(p, ramp, { glint = 0xffffff, bloom = -1, bloomA = 0.35, specks = -1 } = {}) {
  const { w, h } = p;
  p.fill(ramp[1]);
  p.glow(w * 0.38, h * 0.32, w * 0.7, ramp[0], 0.75, h * 0.6);
  p.glow(w * 0.68, h * 0.78, w * 0.6, ramp[2], 0.7, h * 0.5);
  if (bloom >= 0) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.px(x, y, bloom, bloomA * (0.55 + 0.45 * fbm(x / 2.5, y / 2.5, p.seed + 3, 2)));
  }
  if (specks >= 0) {
    const rnd = makeRng(p.seed + 5);
    for (let i = 0; i < (w * h) / 22; i++) p.ellipse(rnd() * w, rnd() * h, 0.55, 0.55, specks, 0.7);
  }
  p.ellipse(w * 0.32, h * 0.28, w * 0.1, h * 0.08, glint, 0.85);
  p.mottle(0.05, 3);
}

/**
 * Dilate a cut-out's colour into its see-through texels (alpha stays 0), six texels deep, and give the rest its mean
 * colour, so filtering never pulls in black.
 */
function dilate(img, [x0, y0, w, h]) {
  const d = img.data;
  const W = img.width;
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] > 0) {
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++;
      }
    }
  }
  for (let pass = 0; pass < 6; pass++) {
    const fill = [];
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * W + x) * 4;
        if (d[i + 3] > 0 || d[i] + d[i + 1] + d[i + 2] > 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < x0 || ny < y0 || nx >= x0 + w || ny >= y0 + h) continue;
          const j = (ny * W + nx) * 4;
          if (d[j + 3] > 0 || d[j] + d[j + 1] + d[j + 2] > 0) {
            r += d[j]; g += d[j + 1]; b += d[j + 2]; n++;
          }
        }
        if (n > 0) fill.push(i, Math.max(1, Math.round(r / n)), Math.round(g / n), Math.round(b / n));
      }
    }
    if (fill.length === 0) break;
    for (let k = 0; k < fill.length; k += 4) {
      d[fill[k]] = fill[k + 1];
      d[fill[k] + 1] = fill[k + 2];
      d[fill[k] + 2] = fill[k + 3];
    }
  }
  if (sn === 0) return;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] === 0 && d[i] + d[i + 1] + d[i + 2] === 0) {
        d[i] = Math.max(1, Math.round(sr / sn)); d[i + 1] = Math.round(sg / sn); d[i + 2] = Math.round(sb / sn);
      }
    }
  }
}

/** Snap a cut-out's alpha to 0 or 255 (what the alpha test sees), keeping its shape crisp at every distance. */
function snapAlpha(img, [x0, y0, w, h]) {
  const d = img.data;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4 + 3;
      d[i] = d[i] >= 110 ? 255 : 0;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Palettes (each plant's colours follow its 16-px picture, so the model and its Pack icon are plainly the same plant)
// ---------------------------------------------------------------------------------------------------------------------

export const PLANT_PALETTE = Object.freeze({
  bark: [0x9a7a56, 0x6f5338, 0x45331f],
  twig: [0x9c8a72, 0x75644f, 0x4c3f30],
  appleBark: [0xa08060, 0x76583c, 0x4c3824],
  honeyLeaf: [0x9cd850, 0x52a02c, 0x2a6a1c],
  honeyBerry: [0xc6d6f4, 0x6f86c8, 0x34407c],
  nightBerry: [0x6a5a7a, 0x2c2034, 0x110a16],
  nightStar: [0xc8a0f0, 0x8a4ec8, 0x5a2a8a],
  hazelLeaf: [0xb4dc68, 0x7cb440, 0x4a7a26],
  hazelHusk: [0xeef0b8, 0xc8d488, 0x8fa050],
  hazelNut: [0xc89a5a, 0x9a6a34, 0x5e3e1c],
  appleLeaf: [0x80c04c, 0x46902c, 0x245e1a],
  apple: [0xf0786a, 0xc8302a, 0x7a1414],
  healLeaf: [0xd6ead2, 0x9cc4a2, 0x5e8a6a],
  healFlower: [0xd8b8f8, 0xa070dc, 0x6a3aa8],
  onionLeaf: [0xa8dc90, 0x6aae60, 0x3c7a40],
  onionBulb: [0xfbf6ea, 0xeadfc8, 0xb8a48a],
  carrotLeaf: [0xbcee7e, 0x6abc48, 0x368a30],
  carrotRoot: [0xffb050, 0xf07a1e, 0xb04a10],
  hemlockCrown: [0xf2ead0, 0xd8cca8, 0xa89a78],
  stalk: [0x8ac46a, 0x5a9a4a, 0x356a34],
  tuberLeaf: [0x8ccc5c, 0x56984a, 0x2e6428],
  tuber: [0xb08a5a, 0x7e5a34, 0x4e361e],
  tussock: [0x5e8c30, 0x9cb84c, 0xe4d070],
  cattailLeaf: [0x5a8c34, 0x6ea040, 0xa8c860],
  cattailHead: [0xb88050, 0x8a5a32, 0x54331a],
  pear: [0x9cd468, 0x66a040, 0x40702a],
  pearFruit: [0xf0b030, 0xc8302a, 0x7a1018],
  honeycap: [0xffd77a, 0xe8a83a, 0xa86818],
  honeycapStem: [0xfff6dc, 0xefe0b8, 0xc8b48a],
  frecklecap: [0xe0a878, 0xb87a48, 0x7a4e2c],
  frecklecapStem: [0xffffff, 0xeeeae2, 0xbab2a4],
  fern: [0xaee874, 0x52a444, 0x266a30],
  daisyLeaf: [0x8ccc5c, 0x4a9440, 0x2f6a30],
  thistle: [0x9ccc7c, 0x56944e, 0x2e5c34],
  thistleTuft: [0xf4b8ff, 0xd060e8, 0x8e3cb0],
  flaxStem: [0x84c070, 0x4e8c52, 0x2e6040],
  flax: [0xc4e8ff, 0x62b4f4, 0x3478cc],
  aloe: [0xd0f6d6, 0x92d0ac, 0x5c9c7e],
  earth: [0x7a5a3c, 0x553a24, 0x2f2014],
  stone: [0xb4b4ae, 0x8a8a84, 0x5a5a56],
  flint: [0x6a6a78, 0x3a3a46, 0x1a1a22],
  nest: [0xe0c27a, 0xb08c48, 0x6e5228],
  egg: [0xfbf6e8, 0xe8dfc8, 0xb8ab90],
});
const P = PLANT_PALETTE;

// ---------------------------------------------------------------------------------------------------------------------
// The pictures. Sizes in pixels at about 160 px a metre (a leaf 0.2 m long is about 32 px).
// ---------------------------------------------------------------------------------------------------------------------

// ---- bark and stems ---------------------------------------------------------------------------------------------------
pic('bark', 32, 64, (p) => p.bark(P.bark).mottle(0.08, 4).ao({ bottom: 0.35, width: 0.25 }));
pic('twig', 24, 64, (p) => {
  p.bark(P.twig).mottle(0.06, 3);
  // hazel's pale lenticels: little horizontal dashes
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    p.line(x - 0.8, y, x + 0.8, y, 0.35, P.twig[0], 0.7);
  }
});
pic('appleBark', 32, 64, (p) => p.bark(P.appleBark).mottle(0.1, 4).ao({ bottom: 0.4, width: 0.3 }));
pic('stem', 16, 64, (p) => bladeFace(p, P.stalk[1], P.stalk[0], P.stalk[0], { streak: 0.1 }));
pic('stemDark', 12, 64, (p) => bladeFace(p, P.flaxStem[2], P.flaxStem[1], P.flaxStem[0], { streak: 0.12 }));
pic('woodEnd', 24, 24, (p) => {
  // a sawn or snapped end: pale wood, growth rings, a darker heart
  p.fill(0xd2b07a);
  for (let r = 2; r < 12; r += 2.2) p.arc(12, 12, r, 0, Math.PI * 2, 0.35, 0xa8844e, 0.7);
  p.glow(12, 12, 4, 0x8a643a, 0.6);
  p.ao({ top: 0.4, bottom: 0.4, left: 0.4, right: 0.4, width: 0.18 });
});

// ---- the honeyberry (and its look-alike, the nightshade: the same leaves) ---------------------------------------------
for (let k = 0; k < 3; k++) {
  pic(`honey.leaf${k}`, 24, 40, (p) => leafFace(p, P.honeyLeaf, { tip: k === 2 ? 0xb8c44c : k === 1 ? 0x2c5a26 : -1, tipK: k === 1 ? 0.25 : 0.3 }));
}
pic('honey.berry', 16, 20, (p) => roundSkin(p, P.honeyBerry, { bloom: 0xd6e2fa, bloomA: 0.42, glint: 0xf4f8ff }));
pic('night.berry', 16, 16, (p) => roundSkin(p, P.nightBerry, { glint: 0xe8e0ff }));
pic('night.star', 32, 32, (p) => {
  // five pointed purple petals round a yellow cone, cut out
  const c = 16;
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
    p.leaf(c, c, a, 15, 5, P.nightStar[1], P.nightStar[2]);
  }
  p.glow(c, c, 8, P.nightStar[0], 0.5);
  p.ellipse(c, c, 3.6, 3.6, 0xf6d43a, 1).ellipse(c - 0.8, c - 0.8, 1.4, 1.4, 0xfff2a0, 1);
}, { cut: true });

// ---- the hazel ---------------------------------------------------------------------------------------------------------
for (let k = 0; k < 3; k++) {
  pic(`hazel.leaf${k}`, 32, 36, (p) => leafFace(p, P.hazelLeaf, { tip: k === 0 ? 0xe8d860 : k === 2 ? 0x6f9a34 : -1, tipK: 0.3, veins: 7 }));
}
pic('hazel.husk', 24, 24, (p) => {
  p.fill(P.hazelHusk[1]);
  // a frilly, leafy cup
  for (let k = 0; k < 9; k++) p.line(k * 2.8, p.h, k * 2.8 + 1, 0, 1.0, k % 2 ? P.hazelHusk[0] : P.hazelHusk[2], 0.55);
  p.mottle(0.08, 3).ao({ bottom: 0.3, width: 0.3 });
});
pic('hazel.nut', 16, 20, (p) => {
  roundSkin(p, P.hazelNut, { glint: 0xf6e0b0 });
  for (let k = 0; k < 4; k++) p.line(3 + k * 3.4, 2, 2.5 + k * 3.4, p.h - 2, 0.35, P.hazelNut[2], 0.45);
});

// ---- the crab apple ----------------------------------------------------------------------------------------------------
for (let k = 0; k < 3; k++) {
  pic(`apple.leaf${k}`, 24, 38, (p) => leafFace(p, P.appleLeaf, { tip: k === 2 ? 0x8ab84a : -1, veins: 6 }));
}
pic('apple.fruit', 24, 24, (p) => {
  roundSkin(p, P.apple, { specks: 0xf8d060 });
  p.glow(p.w * 0.7, p.h * 0.3, 7, 0xe8b040, 0.45); // a yellow blush
  p.glow(p.w * 0.5, 2, 3, 0x6a2a14, 0.6); // the stalk's dimple
});

// ---- healwort: a silver rosette, violet flower spikes ------------------------------------------------------------------
for (let k = 0; k < 2; k++) {
  pic(`heal.leaf${k}`, 16, 40, (p) => leafFace(p, P.healLeaf, { veins: 5, edge: 0.22, vein: 0xf4fbf2, tip: k ? 0xeef8ea : -1 }));
}
pic('heal.spike', 24, 48, (p) => {
  // florets: violet bells in rows round the spike, green between, paler at the top
  p.fill(0x6a9a64);
  const rnd = makeRng(p.seed);
  for (let y = p.h - 3; y > 0; y -= 3) {
    for (let x = (y % 2) * 2; x < p.w + 3; x += 4.2) {
      const t = 1 - y / p.h;
      p.ellipse(x + rnd(), y, 2.2, 1.7, mix(P.healFlower[1], P.healFlower[0], t * 0.7), 1);
      p.ellipse(x - 0.5, y - 0.6, 0.8, 0.6, P.healFlower[0], 0.8);
    }
  }
  p.shadeV(1.05, 0.85);
});

// ---- onion ---------------------------------------------------------------------------------------------------------------
pic('onion.leaf', 12, 64, (p) => bladeFace(p, mix(P.onionLeaf[1], 0xf2f2e0, 0.35), P.onionLeaf[0], mix(P.onionLeaf[0], 0xd8f0a0, 0.3), { streak: 0.08 }));
pic('onion.bulb', 32, 32, (p) => {
  p.fill((x, y) => mix(P.onionBulb[0], P.onionBulb[1], y / p.h));
  for (let k = 0; k < 8; k++) p.line(k * 4 + 2, 0, k * 4 + 2, p.h, 0.4, P.onionBulb[2], 0.4);
  p.glow(p.w * 0.5, p.h, 10, 0xd8a8b8, 0.35); // a pinkish base
  p.mottle(0.04, 3);
});
pic('onion.flower', 32, 32, (p) => {
  // a ball of little white stars, blushed lilac
  p.fill(0xe6cce8);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 80; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    p.ellipse(x, y, 1.6, 1.6, rnd() < 0.7 ? 0xffffff : 0xf4dcf4, 0.95).ellipse(x, y, 0.55, 0.55, 0xc890b8, 0.9);
  }
  p.shadeV(1.08, 0.92);
});

// ---- carrot and hemlock: one lacy frond (the look-alike's leaves are the carrot's, pixel for pixel) ---------------------
pic('carrot.frond', 32, 80, (p) => {
  // a stalk up the middle, branches either side, each finely cut into leaflets
  const cx = p.w / 2;
  const rnd = makeRng(41);
  p.line(cx, p.h, cx, 2, 0.75, P.carrotLeaf[2], 1);
  for (let y = p.h - 6; y > 4; y -= 5) {
    const t = 1 - y / p.h;
    const L = (p.w * 0.46) * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95));
    for (const s of [-1, 1]) {
      const ex = cx + s * L;
      const ey = y - L * 0.55;
      p.line(cx, y, ex, ey, 0.5, P.carrotLeaf[2], 1);
      for (let k = 1; k <= 4; k++) {
        const f = k / 4.5;
        const bx = cx + (ex - cx) * f;
        const by = y + (ey - y) * f;
        const len = 2.2 + 2 * (1 - f) + rnd();
        p.leaf(bx, by, -Math.PI / 2 - s * 0.5, len + 1.2, 1.1, mix(P.carrotLeaf[1], P.carrotLeaf[0], t * 0.6), P.carrotLeaf[2]);
        p.leaf(bx, by, -Math.PI / 2 + s * 1.2, len, 1.0, P.carrotLeaf[1], P.carrotLeaf[2]);
      }
    }
  }
}, { cut: true });
pic('carrot.crown', 32, 24, (p) => {
  // the top of the root: orange, ringed, paler at the shoulder
  p.fill((x, y) => mix(P.carrotRoot[0], P.carrotRoot[2], y / p.h * 0.8));
  for (let y = 3; y < p.h; y += 4) p.line(0, y, p.w, y + 0.5, 0.45, P.carrotRoot[2], 0.55);
  p.mottle(0.06, 3);
});
pic('hemlock.crown', 32, 24, (p) => {
  p.fill((x, y) => mix(P.hemlockCrown[0], P.hemlockCrown[2], y / p.h * 0.7));
  for (let y = 3; y < p.h; y += 4) p.line(0, y, p.w, y + 0.5, 0.45, P.hemlockCrown[2], 0.45);
  p.mottle(0.05, 3);
});
pic('hemlock.stalk', 16, 64, (p) => {
  bladeFace(p, P.stalk[1], P.stalk[0], P.stalk[0], { streak: 0.08 });
  // its tell: purple blotches
  const rnd = makeRng(p.seed + 7);
  for (let i = 0; i < 9; i++) p.ellipse(rnd() * p.w, 4 + rnd() * (p.h - 8), 2.2 + rnd() * 1.5, 1.6 + rnd(), 0x8a3f9c, 0.95);
});
pic('hemlock.umbel', 48, 48, (p) => {
  // a flat plate of tiny white florets in little clusters, cut out
  const c = 24;
  const rnd = makeRng(p.seed);
  for (let k = 0; k < 13; k++) {
    const a = (k / 13) * Math.PI * 2 + rnd() * 0.3;
    const r = k === 0 ? 0 : 9 + rnd() * 11;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    p.line(c, c, x, y, 0.45, 0x6aa84a, 0.9);
    for (let j = 0; j < 9; j++) {
      const b = rnd() * Math.PI * 2;
      const q = rnd() * 4;
      p.ellipse(x + Math.cos(b) * q, y + Math.sin(b) * q, 1.5, 1.5, j % 3 ? 0xfbfbf2 : 0xe2e6d4, 1);
    }
  }
}, { cut: true });

// ---- tuber: broad veined leaves --------------------------------------------------------------------------------------------
for (let k = 0; k < 2; k++) {
  pic(`tuber.leaf${k}`, 32, 36, (p) => leafFace(p, P.tuberLeaf, { veins: 5, tip: k ? 0x8ab84a : -1, vein: 0x9ad06a, rib: 1.1 }));
}
pic('tuber.skin', 32, 24, (p) => {
  p.stone([P.tuber[0], P.tuber[1], P.tuber[2]]);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 7; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 1.2, 0.9, P.tuber[2], 0.8); // its eyes
  p.mottle(0.1, 4);
});

// ---- tussock ---------------------------------------------------------------------------------------------------------------
for (let k = 0; k < 3; k++) {
  pic(`tussock.blade${k}`, 8, 64, (p) => bladeFace(p, P.tussock[0], mix(P.tussock[1], k === 1 ? 0x6f8a34 : P.tussock[1], 0.5),
    k === 2 ? 0xe8d878 : k === 1 ? 0xa8b450 : P.tussock[2], { streak: 0.14 }));
}

// ---- cattails --------------------------------------------------------------------------------------------------------------
pic('cattail.leaf', 12, 96, (p) => bladeFace(p, P.cattailLeaf[0], P.cattailLeaf[1], P.cattailLeaf[2], { streak: 0.1 }));
pic('cattail.head', 32, 48, (p) => {
  // velvet: a warm brown with fine noise, darker at the bottom
  p.fill((x, y) => {
    const n = fbm(x / 1.6, y / 1.6, p.seed, 3);
    return shade(mix(P.cattailHead[0], P.cattailHead[1], 0.4 + y / p.h * 0.5), 0.85 + 0.3 * n);
  });
  p.ao({ top: 0.3, bottom: 0.4, width: 0.18 });
});

// ---- prickly pear ------------------------------------------------------------------------------------------------------------
pic('pear.pad', 48, 48, (p) => {
  p.fill((x, y) => mix(P.pear[1], P.pear[0], clamp01(0.55 - (x + y) / (p.w + p.h)) * 0.9));
  p.mottle(0.08, 5);
  // areoles in a diamond grid: a pale dot with a little tuft of spines
  for (let gy = 3; gy < p.h; gy += 7) {
    for (let gx = (gy / 7) % 2 ? 3 : 6.5; gx < p.w; gx += 7) {
      p.ellipse(gx, gy, 1.1, 1.1, 0x4a6a2a, 0.8).ellipse(gx, gy - 0.3, 0.7, 0.7, 0xf2ecc0, 1);
      p.line(gx, gy, gx - 1.6, gy - 2.2, 0.25, 0xf8f4d8, 0.9).line(gx, gy, gx + 1.8, gy - 1.9, 0.25, 0xf8f4d8, 0.9);
    }
  }
  p.ao({ left: 0.25, right: 0.25, bottom: 0.3, width: 0.25 });
});
pic('pear.fruit', 24, 24, (p) => {
  roundSkin(p, [0xf0705a, P.pearFruit[1], P.pearFruit[2]], { glint: 0xffe0c0 });
  p.glow(p.w * 0.35, p.h * 0.3, 6, P.pearFruit[0], 0.5);
  for (let gy = 4; gy < p.h; gy += 6) for (let gx = (gy / 6) % 2 ? 4 : 7; gx < p.w; gx += 6) p.ellipse(gx, gy, 0.7, 0.7, 0xf8e8a0, 0.9);
});
pic('pear.scar', 12, 12, (p) => p.fill(0xb0a878).mottle(0.1, 2));

// ---- mushrooms ---------------------------------------------------------------------------------------------------------------
pic('honeycap.cap', 48, 24, (p) => {
  // the dome's side strip: glossy honey gold, darker at the rim (the bottom row), a sheen band
  p.fill((x, y) => mix(P.honeycap[0], P.honeycap[2], (y / p.h) ** 1.4 * 0.85));
  for (let x = 0; x < p.w; x++) for (let y = 0; y < p.h; y++) if (Math.abs(y - p.h * 0.32) < 2.2) p.px(x, y, 0xfff0b8, 0.35 * (1 - Math.abs(y - p.h * 0.32) / 2.2));
  p.mottle(0.05, 4);
});
pic('honeycap.top', 32, 32, (p) => {
  p.fill(P.honeycap[0]);
  p.glow(16, 16, 15, P.honeycap[1], 0.55);
  p.glow(12, 11, 7, 0xfff4c8, 0.6);
  p.mottle(0.05, 4);
});
pic('honeycap.pores', 32, 32, (p) => {
  // the sponge under the cap: pale yellow, a fine pattern of pores
  p.fill(0xf2e28a);
  for (let y = 1; y < p.h; y += 2.2) for (let x = (y % 4.4 < 2.2 ? 0 : 1.1); x < p.w; x += 2.2) p.ellipse(x, y, 0.6, 0.6, 0xc8b050, 0.8);
  p.glow(16, 16, 6, 0xd8c070, 0.6);
});
pic('honeycap.stem', 24, 40, (p) => {
  p.fill((x, y) => mix(P.honeycapStem[0], P.honeycapStem[1], y / p.h));
  for (let k = 0; k < 6; k++) p.line(k * 4 + 2, 0, k * 4 + 1.5, p.h, 0.4, P.honeycapStem[2], 0.35);
  p.ao({ top: 0.45, bottom: 0.3, width: 0.25 });
});
pic('frecklecap.cap', 48, 24, (p) => {
  p.fill((x, y) => mix(P.frecklecap[0], P.frecklecap[2], (y / p.h) ** 1.5 * 0.8));
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 22; i++) p.ellipse(rnd() * p.w, rnd() * p.h * 0.85, 1.1 + rnd() * 0.7, 0.9 + rnd() * 0.5, 0xf6ead2, 0.95);
  p.mottle(0.06, 4);
});
pic('frecklecap.top', 32, 32, (p) => {
  p.fill(P.frecklecap[1]);
  p.glow(16, 16, 9, P.frecklecap[2], 0.55);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 26; i++) p.ellipse(rnd() * p.w, rnd() * p.h, 1.1 + rnd() * 0.6, 1 + rnd() * 0.5, 0xf6ead2, 0.95);
  p.mottle(0.06, 4);
});
pic('frecklecap.gills', 32, 32, (p) => {
  // white gills with dark lines radiating from the stem
  p.fill(0xf2eee6);
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    p.line(16 + Math.cos(a) * 3, 16 + Math.sin(a) * 3, 16 + Math.cos(a) * 16, 16 + Math.sin(a) * 16, 0.35, 0x8a7a6a, 0.7);
  }
  p.glow(16, 16, 5, 0xc8bca8, 0.7);
});
pic('frecklecap.stem', 16, 40, (p) => {
  p.fill((x, y) => mix(P.frecklecapStem[0], P.frecklecapStem[1], y / p.h));
  for (let y = 4; y < p.h; y += 5) p.line(0, y, p.w, y + 1, 0.35, P.frecklecapStem[2], 0.3); // faint scales
  p.ao({ top: 0.4, bottom: 0.25, width: 0.25 });
});

// ---- fern ------------------------------------------------------------------------------------------------------------------------
pic('fern.frond', 40, 96, (p) => {
  // a rachis up the middle, pinnae in pairs, longest a third of the way up, each a row of little lobes
  const cx = p.w / 2;
  p.line(cx, p.h, cx, 1, 0.8, P.fern[2], 1);
  for (let y = p.h - 5; y > 2; y -= 4.2) {
    const t = 1 - y / p.h;
    const L = (p.w * 0.47) * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) * (t > 0.05 ? 1 : 0.6);
    for (const s of [-1, 1]) {
      const a = -Math.PI / 2 - s * (Math.PI / 2 - 0.42);
      const lobes = Math.max(1, Math.round(L / 2.6));
      for (let k = 0; k < lobes; k++) {
        const f = (k + 0.5) / lobes;
        const bx = cx + Math.cos(a) * L * f;
        const by = y + Math.sin(a) * L * f;
        const c = mix(P.fern[1], P.fern[0], clamp01(t * 0.7 + (1 - f) * 0.15));
        p.leaf(bx - Math.cos(a) * 1.2, by - Math.sin(a) * 1.2, a - s * 0.75, 3.4 * (1 - f * 0.4), 1.5 * (1 - f * 0.35), c, P.fern[2]);
      }
      p.line(cx, y, cx + Math.cos(a) * L, y + Math.sin(a) * L, 0.4, P.fern[2], 0.9);
    }
  }
}, { cut: true });
pic('fern.crown', 24, 24, (p) => {
  // the fibrous brown crown the fronds rise from
  p.fill(0x4a3a24);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * p.w;
    p.line(x, p.h, x + (rnd() - 0.5) * 4, 0, 0.45, rnd() < 0.5 ? 0x6a5434 : 0x2e2416, 0.7);
  }
});

// ---- meadow daisies ----------------------------------------------------------------------------------------------------------
for (let k = 0; k < 2; k++) pic(`daisy.leaf${k}`, 16, 36, (p) => leafFace(p, P.daisyLeaf, { veins: 4, tip: k ? 0x9cd86a : -1 }));
pic('daisy.flower', 40, 40, (p) => {
  // white petals round a golden heart, cut out
  const c = 20;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + (k % 2) * 0.08;
    p.leaf(c + Math.cos(a) * 3, c + Math.sin(a) * 3, a, 16 + (k % 3), 2.4, k % 2 ? 0xffffff : 0xf2f4fa, 0xd4dae8);
  }
  p.ellipse(c, c, 5.2, 5.2, 0xd8a018, 1).ellipse(c, c, 4.4, 4.4, 0xf6c428, 1);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 14; i++) p.ellipse(c + (rnd() - 0.5) * 6, c + (rnd() - 0.5) * 6, 0.6, 0.6, 0xc08010, 0.8);
  p.ellipse(c - 1.4, c - 1.6, 1.4, 1.2, 0xffe680, 0.9);
}, { cut: true });

// ---- thistle ----------------------------------------------------------------------------------------------------------------------
pic('thistle.leaf', 32, 64, (p) => {
  // a jagged leaf: a lance with lobes either side, each ending in a pale spine; cut out
  const cx = p.w / 2;
  const c0 = P.thistle[1];
  p.ellipse(cx, p.h * 0.52, p.w * 0.16, p.h * 0.47, c0, 1);
  for (let k = 0; k < 6; k++) {
    const y = p.h * (0.86 - k * 0.135);
    const L = p.w * (0.42 - k * 0.035);
    for (const s of [-1, 1]) {
      const a = -Math.PI / 2 - s * 1.0;
      p.leaf(cx, y, a, L, 3.6, mix(c0, P.thistle[0], 0.25 + 0.1 * k), P.thistle[2]);
      p.line(cx + Math.cos(a) * L, y + Math.sin(a) * L, cx + Math.cos(a) * (L + 3.5), y + Math.sin(a) * (L + 3.5), 0.4, 0xf8f4d0, 1);
    }
  }
  p.line(cx, p.h, cx, 2, 0.7, mix(P.thistle[0], 0xf2f6e0, 0.5), 0.9);
  p.line(cx, 3, cx, 0, 0.45, 0xf8f4d0, 1);
}, { cut: true });
pic('thistle.bulb', 32, 24, (p) => {
  // overlapping green scales, each tipped with a tiny spine
  p.fill(P.thistle[2]);
  for (let y = p.h + 2; y > -3; y -= 3.4) {
    for (let x = (y % 6.8 < 3.4 ? 0 : 2); x < p.w + 3; x += 4) {
      p.ellipse(x, y, 2.6, 2.1, mix(P.thistle[1], P.thistle[0], 1 - y / p.h), 1);
      p.line(x, y - 2, x, y - 3.2, 0.3, 0xe8ecc8, 0.8);
    }
  }
});
pic('thistle.tuft', 32, 24, (p) => {
  // the purple brush: fine bristles, lighter at their tips (the top)
  p.fill(P.thistleTuft[1]);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 110; i++) {
    const x = rnd() * p.w;
    p.line(x, p.h, x + (rnd() - 0.5) * 2, rnd() * 4, 0.45, mix(P.thistleTuft[1], P.thistleTuft[0], rnd()), 0.85);
  }
});

// ---- flax ---------------------------------------------------------------------------------------------------------------------------
pic('flax.flower', 32, 32, (p) => {
  // five round sky-blue petals with darker veins and a pale heart, cut out
  const c = 16;
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
    const x = c + Math.cos(a) * 7.5;
    const y = c + Math.sin(a) * 7.5;
    p.ellipse(x, y, 7.6, 6.2, P.flax[1], 1, a);
    for (let v = -1; v <= 1; v++) p.line(c + Math.cos(a + v * 0.25) * 3, c + Math.sin(a + v * 0.25) * 3, c + Math.cos(a + v * 0.3) * 13, c + Math.sin(a + v * 0.3) * 13, 0.35, P.flax[2], 0.6);
  }
  p.glow(c, c, 7, P.flax[0], 0.8);
  p.ellipse(c, c, 2.4, 2.4, 0xfff2a8, 1);
}, { cut: true });
pic('flax.leaf', 8, 24, (p) => leafFace(p, [0x8ac46a, 0x5a9a4a, 0x2f6a44], { veins: 2, rib: 0.5 }));

// ---- aloe ---------------------------------------------------------------------------------------------------------------------------
pic('aloe.leaf', 48, 64, (p) => {
  // round a thick leaf of four faces: its upper side (the strip's two ends) pale and flecked, its keel (the middle)
  // darker; pale teeth along its two edges (a quarter and three quarters of the way round), paler toward the tip
  p.fill((x, y) => {
    const u = (x + 0.5) / p.w;
    const keel = clamp01(1 - Math.abs(u - 0.5) * 4);
    const top = clamp01(Math.abs(u - 0.5) * 4 - 1);
    let c = mix(P.aloe[1], P.aloe[2], keel * 0.55);
    c = mix(c, P.aloe[0], top * 0.35 + (1 - y / p.h) * 0.15);
    return shade(c, 0.95 + 0.1 * fbm(x / 3, y / 7, p.seed, 2));
  });
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 46; i++) {
    const side = rnd() < 0.5 ? rnd() * 0.22 : 0.78 + rnd() * 0.22;
    p.ellipse(side * p.w, rnd() * p.h, 1.5, 0.7, 0xe8f8e0, 0.6);
  }
  for (const u of [0.25, 0.75]) {
    for (let y = 3; y < p.h - 3; y += 5) {
      p.line(u * p.w - 1.6, y + 1.2, u * p.w, y - 0.6, 0.55, 0xf6f8d8, 1);
      p.line(u * p.w + 1.6, y + 1.2, u * p.w, y - 0.6, 0.55, 0xf6f8d8, 1);
    }
  }
});

// ---- the farm: tilled earth, the marker twig's rag ----------------------------------------------------------------------------------
pic('earth', 48, 48, (p) => {
  p.fill((x, y) => shade(mix(P.earth[1], P.earth[2], fbm(x / 5, y / 5, p.seed, 3) * 0.9), 0.92 + 0.16 * hash2(x, y, p.seed)));
  // clods: little lumps lit on top
  const rnd = makeRng(p.seed + 1);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    const r = 1 + rnd() * 1.6;
    p.ellipse(x, y + 0.6, r, r * 0.8, P.earth[2], 0.7).ellipse(x, y, r * 0.85, r * 0.7, P.earth[0], 0.85);
  }
});
pic('earth.furrow', 48, 48, (p) => {
  // the mound's top: furrows raked across it, a little straw
  p.fill((x, y) => shade(mix(P.earth[1], P.earth[2], fbm(x / 5, y / 5, p.seed, 3)), 0.92 + 0.16 * hash2(x, y, p.seed)));
  for (let y = 4; y < p.h; y += 8) {
    p.line(0, y + 2, p.w, y + 2.5, 1.6, P.earth[2], 0.7);
    p.line(0, y, p.w, y + 0.5, 1.1, P.earth[0], 0.6);
  }
  const rnd = makeRng(p.seed + 3);
  for (let i = 0; i < 6; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    p.line(x, y, x + 3 * (rnd() - 0.5), y + 3 * (rnd() - 0.5), 0.35, 0xd8c070, 0.9);
  }
});
pic('rag', 24, 24, (p) => p.cloth([0xfff6e0, 0xf0e2c0, 0xc8b490], { fold: 1 }).shadeV(1.05, 0.88));

// ---- the ground litter: stones, flint, a nest and its eggs ----------------------------------------------------------------------------
pic('stone', 48, 32, (p) => p.stone(P.stone).mottle(0.1, 5).ao({ bottom: 0.4, width: 0.3 }));
pic('stone.top', 32, 32, (p) => {
  p.stone(P.stone).mottle(0.1, 5);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 4; i++) p.glow(rnd() * p.w, rnd() * p.h, 4 + rnd() * 3, 0x9ab07a, 0.5); // a little lichen
  p.glow(13, 12, 10, 0xd8d8d2, 0.35);
});
pic('flint', 32, 32, (p) => {
  // dark, glassy, shell-shaped flakes with pale rims; a chalky white crust in patches
  p.fill(P.flint[1]);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 9; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    p.arc(x, y, 3 + rnd() * 4, Math.PI * 1.1, Math.PI * 1.9, 0.5, P.flint[0], 0.8);
    p.glow(x, y + 1, 3, P.flint[2], 0.5);
  }
  p.glow(8, 24, 6, 0xe0dcd0, 0.7);
  p.ellipse(11, 9, 2.5, 1.2, 0xd8dcf0, 0.6);
});
pic('nest', 48, 24, (p) => {
  // dry grass woven round and round: strokes along the strip in the grass's tones
  p.fill(P.nest[1]);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * p.w;
    const y = rnd() * p.h;
    const l = 4 + rnd() * 7;
    const a = (rnd() - 0.5) * 0.7;
    p.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.5, rnd() < 0.5 ? P.nest[0] : P.nest[2], 0.75);
  }
  p.ao({ bottom: 0.4, width: 0.3 });
});
pic('nest.bed', 32, 32, (p) => {
  p.fill(P.nest[2]);
  const rnd = makeRng(p.seed);
  for (let i = 0; i < 60; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 14;
    p.arc(16, 16, r, a, a + 1 + rnd(), 0.5, rnd() < 0.5 ? P.nest[1] : P.nest[0], 0.7);
  }
  p.glow(16, 16, 9, 0x4a3818, 0.5);
});
pic('egg', 16, 20, (p) => roundSkin(p, P.egg, { specks: 0x9a8a6a }));
pic('leaf.dead', 24, 32, (p) => leafFace(p, [0xd8a85a, 0xa8743a, 0x6a4420], { veins: 5, tip: 0xc89a48, vein: 0xe8c890 }));

// ---------------------------------------------------------------------------------------------------------------------
// Layout, painting, mips
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} PlantAtlasLayout
 * @property {number} width
 * @property {number} height
 * @property {Readonly<Record<string, Rect>>} rects  every picture's rectangle (pixels, row 0 at the top)
 * @property {ReadonlySet<string>} cut  the cut-outs
 */

/** @type {PlantAtlasLayout|null} */
let layout = null;

/**
 * Where every picture is (packed tallest first, then widest; the order of registration breaks ties): known without
 * painting a pixel. Cached.
 * @returns {PlantAtlasLayout}
 */
export function plantAtlasLayout() {
  if (layout) return layout;
  const atlas = new Atlas(1, 1, PLANT_ATLAS_PAD);
  // the packer reads only the image's size: lend it an empty one of the atlas's (the layout needs no pixels)
  atlas.img = { width: PLANT_ATLAS_W, height: PLANT_ATLAS_H, data: new Uint8ClampedArray(0) };
  atlas.sky = [{ x: 0, y: 0, w: PLANT_ATLAS_W }];
  const order = PICTURES.map((d, i) => ({ d, i })).sort((a, b) => b.d.h - a.d.h || b.d.w - a.d.w || a.i - b.i);
  /** @type {Record<string, Rect>} */
  const rects = {};
  for (const { d } of order) rects[d.key] = atlas.alloc(d.w, d.h);
  layout = Object.freeze({
    width: PLANT_ATLAS_W, height: PLANT_ATLAS_H, rects: Object.freeze(rects),
    cut: new Set(PICTURES.filter((d) => d.cut).map((d) => d.key)),
  });
  return layout;
}

/** The names of every picture, in registration order. @returns {string[]} */
export function plantPictureKeys() {
  return PICTURES.map((d) => d.key);
}

/** @param {string} key @returns {Rect} its rectangle (a RangeError when there is no such picture) */
export function plantRect(key) {
  const r = plantAtlasLayout().rects[key];
  if (!r) throw new RangeError(`plant atlas: no picture "${key}"`);
  return r;
}

/** @type {Img|null} */
let painted = null;

/**
 * The atlas, painted (deterministic: every painter is seeded by its name). Cached; callers must not change it.
 * @returns {Img}
 */
export function paintPlantAtlas() {
  if (painted) return painted;
  const L = plantAtlasLayout();
  const img = createImage(L.width, L.height);
  for (const d of PICTURES) {
    const rect = L.rects[d.key];
    let seed = 7;
    for (let i = 0; i < d.key.length; i++) seed = (Math.imul(seed, 31) + d.key.charCodeAt(i)) | 0;
    d.paint(new Painter(img, rect, seed));
    if (d.cut) {
      snapAlpha(img, rect);
      dilate(img, rect);
    } else {
      // a solid picture is opaque everywhere (a painter that left a texel unpainted gets its neighbour's colour)
      dilate(img, rect);
      for (let y = rect[1]; y < rect[1] + rect[3]; y++) for (let x = rect[0]; x < rect[0] + rect[2]; x++) img.data[(y * img.width + x) * 4 + 3] = 255;
    }
    bleed(img, rect, PLANT_ATLAS_PAD);
  }
  painted = img;
  return img;
}

/**
 * The atlas's mip chain, PLANT_ATLAS_MIPS levels from the painted image: each texel of a level is its 2 × 2 children,
 * colour the alpha-weighted mean (a cut-out's edge keeps its colour), alpha halfway between the children's mean and the
 * most opaque of them (a frond thins with distance but does not vanish through the alpha test).
 * @param {Img} [img]
 * @returns {{ data: Uint8Array, width: number, height: number }[]}
 */
export function plantAtlasMips(img = paintPlantAtlas()) {
  const levels = [{ data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height }];
  for (let l = 1; l < PLANT_ATLAS_MIPS; l++) {
    const src = levels[l - 1];
    const w = src.width >> 1;
    const h = src.height >> 1;
    const out = new Uint8Array(w * h * 4);
    const d = src.data;
    const sw = src.width;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, aw = 0, amax = 0, rr = 0, gg = 0, bb = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const k = ((y * 2 + j) * sw + x * 2 + i) * 4;
            const a = d[k + 3];
            r += d[k] * a; g += d[k + 1] * a; b += d[k + 2] * a; aw += a;
            rr += d[k]; gg += d[k + 1]; bb += d[k + 2];
            if (a > amax) amax = a;
          }
        }
        const o = (y * w + x) * 4;
        if (aw > 0) {
          out[o] = Math.round(r / aw); out[o + 1] = Math.round(g / aw); out[o + 2] = Math.round(b / aw);
        } else {
          out[o] = rr >> 2; out[o + 1] = gg >> 2; out[o + 2] = bb >> 2;
        }
        out[o + 3] = Math.round((amax + aw / 4) / 2);
      }
    }
    levels.push({ data: out, width: w, height: h });
  }
  return levels;
}

/**
 * The atlas uv of a point (fu, fv) of picture `key` — fu across, fv UP from its bottom row, both 0..1 — before the
 * PLANT_UV_OFFSET the mesher adds. v runs down the image (row 0 at the top), as the block atlas's does.
 * @param {string} key @param {number} fu @param {number} fv
 * @returns {[number, number]}
 */
export function plantUV(key, fu, fv) {
  const [x, y, w, h] = plantRect(key);
  return [(x + fu * w) / PLANT_ATLAS_W, (y + (1 - fv) * h) / PLANT_ATLAS_H];
}
