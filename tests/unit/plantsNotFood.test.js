// Tests for the plants that are not food (CONTRACTS §81): the blocks 151–158 and their sprites 218–224, the two
// look-alikes and how to tell each from its twin (in the picture AND in the 3D model), what they give, the poison, the
// Aloe Leaf's heal, and that they spread but cannot be planted. Where they GROW is worldgenLean.test.js's business, the
// Guide's two pages handbook.test.js's. Pure modules only.
import { describe, it, expect } from 'vitest';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, PICKER_ORDER, PLANT_IDS, POP_OFF_IDS, FARM_IDS, LAYER_CUTOUT, getFaceTile, getBlockShape,
  isPlant, isPopOff, isFarmBlock, isFallThrough, isReplaceable, isTargetable, isBreakable, shouldRenderFace,
} from '../../src/blocks.js';
import { paintTile, averageColor, TILE_NAMES } from '../../src/tiles.js';
import { ITEMS, ITEM_KEYS, getItem, itemForBlock, blockForItem, itemName, stackSize } from '../../src/items.js';
import { paintItem, hasItemArt } from '../../src/itemArt.js';
import { PLANT_MODELS, PLANT_QUAD_STRIDE, plantModel, plantModelTile } from '../../src/plantModels.js';
import {
  PICKABLE, RIPE_OF, BLOCK_RULES, Regrowth, FERN_FIBRE_P, isPickable, pick, rollDrops, ripeOf, breakSeconds, handGatherHint, harvestHint,
} from '../../src/harvest.js';
import { FIRE_TRANSFORMS, SKEWER_FOODS, FireSlots, isSkewerFood } from '../../src/cooking.js';
import { RECIPES } from '../../src/crafting.js';
import { createVitals, eatFood, queueHeal, statusOf, stepVitals, RATES } from '../../src/vitals.js';
import { Survival, SICK_MESSAGE, CURED_MESSAGE } from '../../src/survival.js';
import { useActionOf, placeRefusal, HINT } from '../../src/survivalControl.js';
import { popOffEffect } from '../../src/fallingblocks.js';
import { buildPickerModel } from '../../src/pickerModel.js';
import { PLANTABLE, CROPS, plantAt, cropOfItem, cropOfBlock } from '../../src/farming.js';
import { SPREAD_KINDS, SPREAD_SAMPLES, SPREAD_RANGE, SPREAD_COLUMNS, discCells, spreadKindOf, canGrowAt, spreadStep } from '../../src/spread.js';
import { makeFakeWorld } from '../helpers/fixtures.js';

const B = BLOCK;
const T = TILE;
const SHOVEL = { type: 'shovel', tier: 1, durability: 40, power: 1 };
const KNIFE = { type: 'knife', tier: 2, durability: 70, power: 1 };
/** A `random` that returns the listed values in turn, then the last one for ever. */
const seq = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};
const asMap = (stacks) => Object.fromEntries(stacks.map((s) => [s.k, s.n]));

/** The eight blocks: [BLOCK key, id, name, display name, sound, TILE key, placeable]. */
const PLANTS = [
  ['FERN', 151, 'fern', 'Fern', 'grass', 'FERN', true],
  ['MEADOW_DAISIES', 152, 'meadow_daisies', 'Meadow Daisies', 'grass', 'MEADOW_DAISIES', true],
  ['THISTLE', 153, 'thistle', 'Thistle', 'grass', 'THISTLE', true],
  ['HEMLOCK', 154, 'hemlock', 'Hemlock', 'grass', 'HEMLOCK', true],
  ['NIGHTSHADE_BUSH', 155, 'nightshade_bush', 'Nightshade Bush', 'leaves', 'NIGHTSHADE_BUSH', true],
  ['NIGHTSHADE_BUSH_BARE', 156, 'nightshade_bush_bare', 'Picked Nightshade Bush', 'leaves', 'HONEYBERRY_BUSH_BARE', false],
  ['FLAX', 157, 'flax', 'Flax', 'grass', 'FLAX', true],
  ['ALOE', 158, 'aloe', 'Aloe', 'grass', 'ALOE', true],
];
const IDS = PLANTS.map((row) => row[1]);
/** The seven sprites 218–224, in id order. */
const NEW_TILES = [T.FERN, T.MEADOW_DAISIES, T.THISTLE, T.HEMLOCK, T.NIGHTSHADE_BUSH, T.FLAX, T.ALOE];

// ---- pixels ---------------------------------------------------------------------------------------------------------

/** @returns {[number, number, number, number][]} the 256 pixels of a 16×16 RGBA buffer, row by row */
function pixels(px) {
  const out = [];
  for (let i = 0; i < 1024; i += 4) out.push([px[i], px[i + 1], px[i + 2], px[i + 3]]);
  return out;
}
const opaque = (px) => pixels(px).filter((p) => p[3] === 255);
const countWhere = (px, pred) => opaque(px).filter(([r, g, b]) => pred(r, g, b)).length;
const mask = (px) => pixels(px).map((p) => p[3] === 255);
/** A flower-white pixel (the hemlock's plates, a daisy's petals). */
const white = (r, g, b) => r > 235 && g > 235 && b > 225;
/** Carrot orange (flora.test.js). */
const orange = (r, g, b) => r > 180 && g > 90 && g < 175 && b < 90;
/** Violet / purple: red and blue both well above green (flora.test.js: the Healwort's flowers). */
const violet = (r, g, b) => r > g + 40 && b > g + 70;
/** The Honeyberry's blue: blue well above red and green, and no redder than it is green (so not violet). */
const berryBlue = (r, g, b) => b > r + 40 && b > g + 30 && g >= r;
/** The Nightshade's black: very dark, and purple-black rather than leaf-dark (blue over green). */
const berryBlack = (r, g, b) => r + g + b < 140 && b > g;
/** Sky blue: the flax flower's. */
const skyBlue = (r, g, b) => b > 200 && b > r + 60 && g > r + 30;
const yellow = (r, g, b) => r > 220 && g > 180 && b < 120;

// ---- models ---------------------------------------------------------------------------------------------------------

/** The quads of a block's compiled model: corners, their texels [u, v] and the normal. */
function quadsOf(id) {
  const m = /** @type {Float32Array} */ (plantModel(id));
  const out = [];
  for (let o = 0; o < m.length; o += PLANT_QUAD_STRIDE) {
    const p = [];
    const uv = [];
    for (let v = 0; v < 4; v++) {
      p.push([m[o + v * 5], m[o + v * 5 + 1], m[o + v * 5 + 2]]);
      uv.push([m[o + v * 5 + 3], m[o + v * 5 + 4]]);
    }
    out.push({ p, uv, n: [m[o + 20], m[o + 21], m[o + 22]] });
  }
  return out;
}
/** The texels of the model's tile a quad is cut from. */
function texelsOf(id, q) {
  const tile = paintTile(plantModelTile(id) ?? getFaceTile(id, 6));
  const us = q.uv.map((t) => t[0]);
  const vs = q.uv.map((t) => t[1]);
  const out = [];
  for (let y = Math.min(...vs); y < Math.max(...vs); y++) {
    for (let x = Math.min(...us); x < Math.max(...us); x++) out.push([tile[(y * 16 + x) * 4], tile[(y * 16 + x) * 4 + 1], tile[(y * 16 + x) * 4 + 2], tile[(y * 16 + x) * 4 + 3]]);
  }
  return out;
}
/** The quads every texel of which is opaque and passes `pred`. */
const facesAll = (id, pred) => quadsOf(id).filter((q) => texelsOf(id, q).every(([r, g, b, a]) => a === 255 && pred(r, g, b)));
/** The quads with at least `least` texels that pass `pred`. */
const facesWith = (id, pred, least = 1) => quadsOf(id).filter((q) => texelsOf(id, q).filter(([r, g, b, a]) => a === 255 && pred(r, g, b)).length >= least);

// =====================================================================================================================

describe('the eight blocks 151–158 (blocks.js)', () => {
  it('ids, names, flags and tiles: wild plants like the others — 3D models with the PLANT flags and a flat icon', () => {
    expect(BLOCK_COUNT).toBe(173); // (§83: the low and shallow water follow at 159–162; §85: the homestead blocks at 163–172)
    expect(BLOCKS).toHaveLength(173);
    expect(BLOCKS[158].id).toBe(158); // appended in id order: no earlier block moved
    expect(BLOCKS[150].name).toBe('cattails_sprout');
    for (const [key, id, name, displayName, sound, tile, placeable] of PLANTS) {
      expect(B[key], key).toBe(id);
      const d = BLOCKS[id];
      expect([d.id, d.name, d.displayName, d.soundGroup, d.placeable], key).toEqual([id, name, displayName, sound, placeable]);
      expect([d.solid, d.opaque, d.layer, d.cullSame, d.meshed, d.icon, d.shape], key).toEqual([false, false, LAYER_CUTOUT, false, true, 'flat', 'model']);
      expect(d.breakable && !d.liquid && !d.gravity, key).toBe(true);
      expect(getBlockShape(id), key).toBe('model');
      for (let f = 0; f < 8; f++) expect(getFaceTile(id, f), `${key} face ${f}`).toBe(T[tile]);
      // walk-through, yet never replaceable, fall-through or untargetable; it hides no neighbour and pops off like a plant
      expect(isReplaceable(id) || isFallThrough(id) || !isTargetable(id) || !isBreakable(id), key).toBe(false);
      expect(shouldRenderFace(B.STONE, id) && shouldRenderFace(id, id), key).toBe(true);
      expect(isPlant(id) && isPopOff(id) && !isFarmBlock(id), key).toBe(true);
      expect(PICKER_ORDER.includes(id), key).toBe(placeable);
      expect(popOffEffect(id), key).toMatchObject({ kind: 'leaves', count: 6, sound: 'break:leaves' });
      expect(popOffEffect(id).color, key).toHaveLength(3);
      expect(placeRefusal(() => B.AIR, id, 0, 5, 0), key).toBe(HINT.needsGround); // it needs ground under it
      expect(placeRefusal(() => B.GRASS_BLOCK, id, 0, 5, 0), key).toBeNull();
    }
    // the BLOCK key is the block's name in capitals (wave0)
    for (const [key, , name] of PLANTS) expect(name.toUpperCase(), key).toBe(key);
    // the id lists: after the ten plants of v0.14 among the plants; after the farm blocks among the pop-offs
    expect(PLANT_IDS).toHaveLength(25);
    expect(PLANT_IDS.slice(17)).toEqual(IDS);
    expect(POP_OFF_IDS).toHaveLength(47);
    expect(POP_OFF_IDS.slice(-8)).toEqual(IDS);
    expect(POP_OFF_IDS.slice(-26, -8)).toEqual([...FARM_IDS]);
    // the picked Nightshade is the same bush as the picked Honeyberry, picture for picture
    expect(getFaceTile(B.NIGHTSHADE_BUSH_BARE, 6)).toBe(getFaceTile(B.HONEYBERRY_BUSH_BARE, 6));
    expect(popOffEffect(B.NIGHTSHADE_BUSH).color).toEqual(popOffEffect(B.HONEYBERRY_BUSH).color);
  });

  it('seven tiles 218–224, one each in id order (the picked Nightshade has none of its own)', () => {
    expect(NEW_TILES).toEqual([218, 219, 220, 221, 222, 223, 224]);
    expect(NEW_TILES.map((t) => TILE_NAMES[t])).toEqual(['fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'flax', 'aloe']);
    expect(TILE_IDS).toHaveLength(193); // + the ten tiles of §85
    for (const t of NEW_TILES) expect(TILE_IDS, TILE_NAMES[t]).toContain(t);
    // every one is the face of exactly one block
    for (const t of NEW_TILES) expect(BLOCKS.filter((d) => d.tiles.includes(t)).map((d) => d.name), TILE_NAMES[t]).toEqual([TILE_NAMES[t]]);
    // 225–227 and 207 stayed free here; §85 (a place to stay) has taken them since: the spring's faces and the well's picture
    expect(Object.values(T).filter((t) => t >= 225 && t <= 227).map((t) => TILE_NAMES[t])).toEqual(['spring_top', 'spring_drawn_top', 'well']);
    expect(TILE_NAMES[207]).toBe('spring_side');
  });

  it('the Creative picker lists the seven placeable ones among the Wild Plants; each is a block item', () => {
    const wild = /** @type {*} */ (buildPickerModel().families.get('wild-plants')).ids.map((id) => BLOCKS[id].name);
    expect(wild.slice(-7)).toEqual(['fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'flax', 'aloe']);
    expect(wild).not.toContain('nightshade_bush_bare');
    const i = PICKER_ORDER.indexOf(B.HEALWORT_PLANT);
    expect(PICKER_ORDER.slice(i + 1, i + 8)).toEqual([B.FERN, B.MEADOW_DAISIES, B.THISTLE, B.HEMLOCK, B.NIGHTSHADE_BUSH, B.FLAX, B.ALOE]);
    for (const [, id, name, displayName, , , placeable] of PLANTS) {
      if (!placeable) continue;
      expect(getItem(name), name).toMatchObject({ kind: 'block', name: displayName, stack: 64 });
      expect(itemForBlock(id)).toBe(name);
      expect(hasItemArt(name), name).toBe(false); // a block item's icon is its tile
    }
    // a transplanted Nightshade must regrow, like the Honeyberry it imitates; the rest are placed as they are
    expect(blockForItem('nightshade_bush')).toBe(B.NIGHTSHADE_BUSH_BARE);
    expect(itemForBlock(B.NIGHTSHADE_BUSH_BARE)).toBe('nightshade_bush');
    expect(blockForItem('honeyberry_bush')).toBe(B.HONEYBERRY_BUSH_BARE);
    for (const name of ['fern', 'meadow_daisies', 'thistle', 'hemlock', 'flax', 'aloe']) expect(blockForItem(name)).toBe(B[name.toUpperCase()]);
    expect(isItemKey('nightshade_bush_bare')).toBe(false);
  });

  it('no name says which plants poison: nothing a player reads gives the Hemlock or the Nightshade away', () => {
    const words = /poison|toxic|deadly|venom|bad|fool|false|death|sick/i;
    for (const [, id] of PLANTS) expect(`${BLOCKS[id].name} ${BLOCKS[id].displayName}`).not.toMatch(words);
    for (const k of ['hemlock_root', 'nightshade_berries', 'aloe_leaf']) expect(`${k} ${ITEMS[k].name}`).not.toMatch(words);
    // … and the look-alikes are named as plainly as their twins: a plant's name, nothing more
    expect([BLOCKS[B.HEMLOCK].displayName, BLOCKS[B.NIGHTSHADE_BUSH].displayName, BLOCKS[B.NIGHTSHADE_BUSH_BARE].displayName])
      .toEqual(['Hemlock', 'Nightshade Bush', 'Picked Nightshade Bush']);
    expect(BLOCKS[B.NIGHTSHADE_BUSH].displayName.replace('Nightshade', 'Honeyberry')).toBe(BLOCKS[B.HONEYBERRY_BUSH].displayName);
    expect(BLOCKS[B.NIGHTSHADE_BUSH_BARE].displayName.replace('Nightshade', 'Honeyberry')).toBe(BLOCKS[B.HONEYBERRY_BUSH_BARE].displayName);
  });
});

/** @param {string} key @returns {boolean} */
function isItemKey(key) {
  return Object.hasOwn(ITEMS, key);
}

describe('the sprites 218–224 (tiles.js)', () => {
  const painted = new Map(NEW_TILES.map((t) => [t, paintTile(t)]));
  const px = (key) => /** @type {Uint8ClampedArray} */ (painted.get(T[key]));

  it('each is a deterministic cut-out of its own: alpha 0 or 255 only, clear pixels RGB 0, clear corners, standing on the bottom row', () => {
    const missing = paintTile(T.MISSING);
    const seen = [];
    for (const t of NEW_TILES) {
      const p = /** @type {Uint8ClampedArray} */ (painted.get(t));
      expect(Buffer.from(p).equals(Buffer.from(paintTile(t))), TILE_NAMES[t]).toBe(true);
      expect(Buffer.from(p).equals(Buffer.from(missing)), TILE_NAMES[t]).toBe(false);
      for (const other of seen) expect(Buffer.from(p).equals(Buffer.from(other)), TILE_NAMES[t]).toBe(false);
      seen.push(p);
      for (const [r, g, b, a] of pixels(p)) {
        expect(a === 0 || a === 255, TILE_NAMES[t]).toBe(true);
        if (a === 0) expect(r + g + b, TILE_NAMES[t]).toBe(0);
      }
      const n = opaque(p).length;
      expect(n, `${TILE_NAMES[t]} opaque pixels`).toBeGreaterThanOrEqual(40); // chunky enough to see
      expect(n, `${TILE_NAMES[t]} opaque pixels`).toBeLessThanOrEqual(150); // and plainly a sprite, not a panel
      expect(mask(p).slice(240).some(Boolean), `${TILE_NAMES[t]} stands on the ground`).toBe(true);
      for (const i of [0, 15, 240, 255]) expect(mask(p)[i], `${TILE_NAMES[t]} corner`).toBe(false);
    }
  });

  it('each reads against the ground it grows on: most of its pixels are far from the grass top\'s colour (the aloe: from sand\'s)', () => {
    const farFrom = (tile) => {
      const [tr, tg, tb] = averageColor(tile);
      return (r, g, b) => Math.hypot(r - tr, g - tg, b - tb) > 60;
    };
    for (const t of NEW_TILES) {
      const p = /** @type {Uint8ClampedArray} */ (painted.get(t));
      const far = farFrom(t === T.ALOE ? T.SAND : T.GRASS_TOP);
      expect(countWhere(p, far), TILE_NAMES[t]).toBeGreaterThanOrEqual(30);
      expect(countWhere(p, far) / opaque(p).length, TILE_NAMES[t]).toBeGreaterThan(0.5);
    }
    // the thistle also grows on mountain stone, and reads there too
    expect(countWhere(px('THISTLE'), farFrom(T.STONE)) / opaque(px('THISTLE')).length).toBeGreaterThan(0.5);
  });

  it('each has a sign of its own: white daisies with yellow hearts, a purple thistle head, sky-blue flax, a toothed aloe; the fern is all green', () => {
    // the fern: nothing but green — no flower, no root, no fruit
    for (const [r, g, b] of opaque(px('FERN'))) expect(g > r && g > b).toBe(true);
    // daisies: three flowers of four white petals round a yellow heart, and the bud's heart
    expect(countWhere(px('MEADOW_DAISIES'), white)).toBe(12);
    expect(countWhere(px('MEADOW_DAISIES'), yellow)).toBe(4);
    // thistle: one purple tuft at the top of the picture, pale spines at its leaves' ends
    expect(countWhere(px('THISTLE'), violet)).toBe(16);
    expect(pixels(px('THISTLE')).slice(3 * 16).filter(([r, g, b, a]) => a === 255 && violet(r, g, b))).toHaveLength(0);
    expect(countWhere(px('THISTLE'), (r, g, b) => r > 230 && g > 230 && b > 180)).toBe(8); // the spines
    // flax: five sky-blue flowers; sky blue is on no other plant of the game
    expect(countWhere(px('FLAX'), skyBlue)).toBe(35);
    const others = [T.HONEYBERRY_BUSH, T.TUSSOCK, T.CATTAILS_SIDE, T.TUBER_PLANT, T.PRICKLY_PEAR, T.HONEYCAP_MUSHROOM, T.FRECKLECAP_MUSHROOM,
      T.ONION_PLANT, T.CARROT_PLANT, T.HAZEL_THICKET, T.CRAB_APPLE_BUSH, T.HEALWORT_PLANT, ...NEW_TILES.filter((t) => t !== T.FLAX)];
    for (const t of others) expect(countWhere(paintTile(t), skyBlue), TILE_NAMES[t]).toBe(0);
    // aloe: sea green (blue over red), with pale teeth along its leaves
    const aloe = opaque(px('ALOE'));
    const teeth = aloe.filter(([r, g, b]) => r > 230 && g > 230 && b > 190).length;
    expect(teeth).toBe(8);
    expect(aloe.filter(([r, g, b]) => g > r && b > r).length).toBe(aloe.length - teeth);
    // white flowers: the daisies and the hemlock only; purple: the thistle, the hemlock's stem and the nightshade's flowers
    for (const t of NEW_TILES) {
      const hasWhite = countWhere(/** @type {Uint8ClampedArray} */ (painted.get(t)), white) > 0;
      expect(hasWhite, TILE_NAMES[t]).toBe(t === T.MEADOW_DAISIES || t === T.HEMLOCK);
      const hasViolet = countWhere(/** @type {Uint8ClampedArray} */ (painted.get(t)), violet) > 0;
      expect(hasViolet, TILE_NAMES[t]).toBe(t === T.THISTLE || t === T.HEMLOCK || t === T.NIGHTSHADE_BUSH);
    }
  });

  it('no two of them, and none of them and an older plant, can be mistaken at a glance: every pair differs in at least 60 pixels', () => {
    const plain = [T.FERN, T.MEADOW_DAISIES, T.THISTLE, T.FLAX, T.ALOE];
    const old = [T.HONEYBERRY_BUSH, T.TUSSOCK, T.CATTAILS_SIDE, T.TUBER_PLANT, T.PRICKLY_PEAR, T.HONEYCAP_MUSHROOM, T.ONION_PLANT, T.CARROT_PLANT,
      T.HAZEL_THICKET, T.CRAB_APPLE_BUSH, T.HEALWORT_PLANT];
    const differ = (x, y) => {
      const a = pixels(paintTile(x));
      const b = pixels(paintTile(y));
      return a.filter((p, k) => (p[3] !== b[k][3]) || (p[3] === 255 && Math.hypot(p[0] - b[k][0], p[1] - b[k][1], p[2] - b[k][2]) > 60)).length;
    };
    for (const x of plain) for (const y of [...plain, ...old, T.HEMLOCK, T.NIGHTSHADE_BUSH]) if (x !== y) expect(differ(x, y), `${TILE_NAMES[x]} vs ${TILE_NAMES[y]}`).toBeGreaterThanOrEqual(60);
    // a look-alike is close to its twin and to nothing else
    for (const [fake, twin] of [[T.HEMLOCK, T.CARROT_PLANT], [T.NIGHTSHADE_BUSH, T.HONEYBERRY_BUSH]]) {
      for (const y of [...old, ...plain]) if (y !== twin) expect(differ(fake, y), `${TILE_NAMES[fake]} vs ${TILE_NAMES[y]}`).toBeGreaterThanOrEqual(60);
    }
    expect(differ(T.HEMLOCK, T.NIGHTSHADE_BUSH)).toBeGreaterThanOrEqual(60);
  });
});

describe('the tells, measured in the pixels: how to know a look-alike from its twin', () => {
  const carrot = paintTile(T.CARROT_PLANT);
  const hemlock = paintTile(T.HEMLOCK);
  const berry = paintTile(T.HONEYBERRY_BUSH);
  const night = paintTile(T.NIGHTSHADE_BUSH);
  const row = (px, y) => pixels(px).slice(y * 16, y * 16 + 16);

  it('Hemlock and Wild Carrot are alike: the very same feathery leaves', () => {
    // every pixel of the carrot's picture is a pixel of the hemlock's: the hemlock is the carrot and something more
    const a = mask(carrot);
    const b = mask(hemlock);
    expect(a.every((v, i) => !v || b[i])).toBe(true);
    expect(a.filter(Boolean).length / b.filter(Boolean).length).toBeGreaterThan(0.75);
    // outside the stalk (x 7–8), the flower heads (rows 0–3) and the root (rows 12–15), the two pictures are the same
    // bytes: leaf for leaf
    const pc = pixels(carrot);
    const ph = pixels(hemlock);
    let leaves = 0;
    for (let y = 4; y < 12; y++) {
      for (let x = 0; x < 16; x++) {
        if (x === 7 || x === 8) continue;
        expect(ph[y * 16 + x], `${x},${y}`).toEqual(pc[y * 16 + x]);
        if (pc[y * 16 + x][3] === 255) leaves++;
      }
    }
    expect(leaves).toBeGreaterThan(40);
    // the same root shape, too: rows 12–15 hold the same silhouette
    expect(mask(hemlock).slice(12 * 16)).toEqual(mask(carrot).slice(12 * 16));
  });

  it('tell 1, the flowers: the Hemlock has three flat white flower heads, the carrot no flower at all', () => {
    expect(countWhere(hemlock, white)).toBe(14);
    expect(countWhere(carrot, white)).toBe(0);
    // three plates, each a white row over a shaded row: 6 wide on top of the middle, 4 wide either side
    const whiteAt = (y) => row(hemlock, y).map(([r, g, b, al], x) => (al === 255 && white(r, g, b) ? x : -1)).filter((x) => x >= 0);
    expect(whiteAt(0)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(whiteAt(2)).toEqual([1, 2, 3, 4, 10, 11, 12, 13]);
    expect(whiteAt(1).concat(whiteAt(3))).toEqual([]);
    for (const [y, xs] of [[1, [5, 6, 7, 8, 9, 10]], [3, [1, 2, 3, 4, 10, 11, 12, 13]]]) {
      for (const x of xs) {
        const [r, g, b, al] = row(hemlock, y)[x];
        expect(al === 255 && r > 170 && g > 180 && b > 150 && !white(r, g, b), `underside ${x},${y}`).toBe(true); // pale, but shaded
      }
    }
    // flat: each plate is at least twice as wide as it is deep
    expect(6 / 2).toBeGreaterThanOrEqual(2);
    // nothing on the carrot is pale at all above its root
    expect(pixels(carrot).slice(0, 12 * 16).filter(([r, g, b, al]) => al === 255 && r > 170 && g > 170 && b > 140)).toHaveLength(0);
  });

  it('tell 2, the stem: the Hemlock\'s stalk is blotched purple, the carrot has no purple anywhere', () => {
    expect(countWhere(hemlock, violet)).toBe(5);
    expect(countWhere(carrot, violet)).toBe(0);
    const purple = pixels(hemlock).map(([r, g, b, al], i) => (al === 255 && violet(r, g, b) ? [i % 16, Math.floor(i / 16)] : null)).filter(Boolean);
    expect(purple).toEqual([[7, 3], [8, 5], [7, 7], [8, 9], [7, 11]]); // down the stalk, left and right in turn
    // the stalk is two pixels wide from under the top flower head down to the root: a stem, not a leaf rib
    for (let y = 2; y <= 11; y++) expect([row(hemlock, y)[7][3], row(hemlock, y)[8][3]], `row ${y}`).toEqual([255, 255]);
  });

  it('tell 3, the root: the carrot\'s crown is orange, the Hemlock\'s pale', () => {
    expect(countWhere(carrot, orange)).toBe(14);
    expect(countWhere(hemlock, orange)).toBe(0);
    const root = (px) => pixels(px).slice(12 * 16).filter((p) => p[3] === 255);
    expect(root(carrot)).toHaveLength(14);
    expect(root(hemlock)).toHaveLength(14);
    for (const [r, g, b] of root(hemlock)) expect(r > 170 && g > 160 && b > 120 && r - b < 70).toBe(true); // cream to bone
    for (const [r, g, b] of root(carrot)) expect(r > 180 && b < 90 && r - b > 120, `${r},${g},${b}`).toBe(true); // orange
  });

  it('Nightshade and Honeyberry are alike: the very same bush', () => {
    const a = mask(berry);
    const b = mask(night);
    const both = a.filter((v, i) => v && b[i]).length;
    expect(both / a.filter(Boolean).length).toBeGreaterThan(0.9);
    expect(both / b.filter(Boolean).length).toBeGreaterThan(0.9);
    // every leaf pixel the two share is the same green, byte for byte (the same foliage, painted with the same seed)
    const pb = pixels(berry);
    const pn = pixels(night);
    const leaf = (r, g, b2) => g > r && g > b2;
    let same = 0;
    for (let i = 0; i < 256; i++) {
      if (pb[i][3] !== 255 || pn[i][3] !== 255 || !leaf(pb[i][0], pb[i][1], pb[i][2]) || !leaf(pn[i][0], pn[i][1], pn[i][2])) continue;
      expect(pn[i], `pixel ${i}`).toEqual(pb[i]);
      same++;
    }
    expect(same).toBeGreaterThan(60);
    // the same stem under it (the honeyberry's clear pixels keep their leaf colour, the nightshade's are RGB 0: only
    // what shows is compared)
    const shown = (p) => p.slice(14 * 16).map((q) => (q[3] === 255 ? String(q) : 'clear'));
    expect(shown(pn)).toEqual(shown(pb));
    expect(shown(pn).filter((s) => s !== 'clear')).toHaveLength(4);
  });

  it('tell 1, the berries: the Nightshade\'s are shiny black, the Honeyberry\'s pale blue', () => {
    expect(countWhere(night, berryBlack)).toBe(21); // seven berries, three black pixels each …
    expect(countWhere(night, (r, g, b) => r === 0xcf && g === 0xc0 && b === 0xf0)).toBe(7); // … and a pale glint on each: shiny
    expect(countWhere(night, berryBlue)).toBe(0);
    expect(countWhere(berry, berryBlue)).toBeGreaterThanOrEqual(40);
    expect(countWhere(berry, berryBlack)).toBe(0);
    // each berry is round (2 × 2), its glint on the upper left; the honeyberry's are long (taller than wide)
    const pn = pixels(night);
    const glints = pn.map((p, i) => (p[3] === 255 && p[0] === 0xcf && p[1] === 0xc0 && p[2] === 0xf0 ? i : -1)).filter((i) => i >= 0);
    for (const i of glints) for (const j of [i + 1, i + 16, i + 17]) expect(berryBlack(pn[j][0], pn[j][1], pn[j][2]), `berry at ${i % 16},${i >> 4}`).toBe(true);
    // how dark: a nightshade berry is far darker than anything blue on the honeyberry
    const lum = ([r, g, b]) => (r + g + b) / 3;
    const darkestBlue = Math.min(...opaque(berry).filter(([r, g, b]) => berryBlue(r, g, b)).map(lum));
    const lightestBlack = Math.max(...opaque(night).filter(([r, g, b]) => berryBlack(r, g, b)).map(lum));
    expect(lightestBlack).toBeLessThan(darkestBlue - 30);
  });

  it('tell 2, the flowers: small purple stars with a yellow heart on the Nightshade, none on the Honeyberry', () => {
    expect(countWhere(night, violet)).toBe(12); // three stars of four petals
    expect(countWhere(night, yellow)).toBe(3); // and a heart in each
    expect(countWhere(berry, violet)).toBe(0);
    expect(countWhere(berry, yellow)).toBe(0);
    const pn = pixels(night);
    const hearts = pn.map((p, i) => (p[3] === 255 && yellow(p[0], p[1], p[2]) ? i : -1)).filter((i) => i >= 0);
    for (const i of hearts) for (const j of [i - 16, i - 1, i + 1, i + 16]) expect(violet(pn[j][0], pn[j][1], pn[j][2]), `star at ${i % 16},${i >> 4}`).toBe(true);
  });
});

describe('the tells in 3D: the models show them too (plantModels.js)', () => {
  const up = (q) => q.n[1] > 0.7;
  const height = (q) => Math.min(...q.p.map((p) => p[1]));
  const topOf = (id) => Math.max(...quadsOf(id).flatMap((q) => q.p.map((p) => p[1])));

  it('all eight meet the limits of §78 (plantModels.test.js checks them one by one); none is a flat picture', () => {
    for (const id of IDS) {
      expect(PLANT_MODELS[id], BLOCKS[id].name).toBeDefined();
      const n = quadsOf(id).length;
      expect(n, BLOCKS[id].name).toBeGreaterThanOrEqual(9);
      expect(n, BLOCKS[id].name).toBeLessThanOrEqual(80);
      expect(topOf(id), BLOCKS[id].name).toBeGreaterThan(0.6);
      expect(topOf(id), BLOCKS[id].name).toBeLessThanOrEqual(0.95);
      // chunky: boxes, not only cards (a box has faces looking up; so has a thing with depth)
      expect(quadsOf(id).filter(up).length, BLOCKS[id].name).toBeGreaterThanOrEqual(2);
    }
  });

  it('the Hemlock: white flower plates lie flat on top of it, high above its leaves; the carrot has none', () => {
    const plates = facesAll(B.HEMLOCK, white).filter(up);
    expect(plates).toHaveLength(3);
    expect(facesAll(B.CARROT_PLANT, white)).toHaveLength(0);
    expect(facesWith(B.CARROT_PLANT, white)).toHaveLength(0);
    // each plate is a real plate: at least a quarter of a metre across and nearly level
    for (const q of plates) {
      const xs = q.p.map((p) => p[0]);
      const zs = q.p.map((p) => p[2]);
      expect(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs))).toBeGreaterThan(0.3);
      expect(q.n[1]).toBeGreaterThan(0.8);
    }
    // the highest thing on the plant is a flower plate, and all three stand in its upper half
    const top = topOf(B.HEMLOCK);
    expect(Math.max(...plates.map(height))).toBeGreaterThan(top - 0.07);
    for (const q of plates) expect(height(q)).toBeGreaterThan(top / 2);
  });

  it('the Hemlock: a pale crown and a purple-blotched stalk; the carrot an orange crown and no purple', () => {
    // the crown: the faces at the plant's foot (below 13 cm)
    const foot = (id) => quadsOf(id).filter((q) => Math.max(...q.p.map((p) => p[1])) <= 0.13 + 1e-6 && q.uv[0][1] >= 12);
    expect(foot(B.CARROT_PLANT).length).toBeGreaterThanOrEqual(5);
    expect(foot(B.HEMLOCK).length).toBeGreaterThanOrEqual(5);
    for (const q of foot(B.CARROT_PLANT)) expect(texelsOf(B.CARROT_PLANT, q).every(([r, g, b]) => orange(r, g, b) || (r > 180 && b < 90))).toBe(true);
    for (const q of foot(B.HEMLOCK)) expect(texelsOf(B.HEMLOCK, q).every(([r, g, b]) => r > 170 && g > 160 && b > 120)).toBe(true);
    expect(facesWith(B.HEMLOCK, orange)).toHaveLength(0);
    expect(facesWith(B.CARROT_PLANT, orange).length).toBeGreaterThanOrEqual(5);
    // purple: on the hemlock's stalk (four upright faces as tall as the leaves) and nowhere on the carrot
    expect(facesWith(B.CARROT_PLANT, violet)).toHaveLength(0);
    const stalk = facesWith(B.HEMLOCK, violet, 2).filter((q) => Math.abs(q.n[1]) < 0.01 && Math.max(...q.p.map((p) => p[1])) - height(q) > 0.5);
    expect(stalk).toHaveLength(4);
  });

  it('the Hemlock keeps the carrot\'s shape: a crown at the foot and feathery fronds leaning out of it, as many as the carrot\'s', () => {
    const fronds = (id) => quadsOf(id).filter((q) => {
      const t = texelsOf(id, q);
      const green = t.filter(([r, g, b, a]) => a === 255 && g > r && g > b).length;
      return t.length >= 40 && green / t.length > 0.3 && t.some((p) => p[3] === 0); // a big ragged green card
    });
    expect(fronds(B.HEMLOCK)).toHaveLength(5);
    expect(fronds(B.CARROT_PLANT)).toHaveLength(6);
  });

  it('the Nightshade: dark berries stand out of the bush where the Honeyberry\'s blue ones do, and purple stars open on it', () => {
    const fruit = (id, pred) => quadsOf(id).filter((q) => {
      const t = texelsOf(id, q);
      return t.length === 4 && t.filter(([r, g, b]) => pred(r, g, b)).length >= 3; // a 2 × 2 berry: three of its pixels that colour
    });
    const dark = fruit(B.NIGHTSHADE_BUSH, berryBlack);
    const blue = fruit(B.HONEYBERRY_BUSH, berryBlue);
    expect(dark).toHaveLength(25); // five berries, five faces each
    expect(blue).toHaveLength(25);
    expect(fruit(B.NIGHTSHADE_BUSH, berryBlue)).toHaveLength(0);
    expect(fruit(B.HONEYBERRY_BUSH, berryBlack)).toHaveLength(0);
    // the very same places: the two bushes are one model with different berries
    const place = (q) => q.p.flat().map((c) => c.toFixed(4)).join(',');
    expect(dark.map(place)).toEqual(blue.map(place));
    // the berries stand OUT of the bush: each reaches beyond the crown's faces
    const crown = Math.max(...quadsOf(B.NIGHTSHADE_BUSH_BARE).flatMap((q) => q.p.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2])))));
    const reach = Math.max(...dark.flatMap((q) => q.p.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2])))));
    expect(reach).toBeGreaterThan(crown);
    // three stars: each a small box with the five-pixel flower on its face
    const stars = quadsOf(B.NIGHTSHADE_BUSH).filter((q) => {
      const t = texelsOf(B.NIGHTSHADE_BUSH, q);
      return t.length === 9 && t.filter(([r, g, b]) => violet(r, g, b)).length === 4 && t.filter(([r, g, b]) => yellow(r, g, b)).length === 1;
    });
    expect(stars).toHaveLength(3);
    expect(stars.filter(up)).toHaveLength(1); // one on top, two on the sides
    expect(facesWith(B.HONEYBERRY_BUSH, violet)).toHaveLength(0);
  });

  it('picked, the Nightshade loses its berries and its flowers and is the picked Honeyberry', () => {
    const full = quadsOf(B.NIGHTSHADE_BUSH);
    const bare = quadsOf(B.NIGHTSHADE_BUSH_BARE);
    expect(full.length - bare.length).toBe(40); // five berries and three flowers, five faces each
    expect([...plantModel(B.NIGHTSHADE_BUSH_BARE)]).toEqual([...plantModel(B.HONEYBERRY_BUSH_BARE)]);
    expect(plantModelTile(B.NIGHTSHADE_BUSH_BARE)).toBe(T.HONEYBERRY_BUSH);
    expect(PLANT_MODELS[B.NIGHTSHADE_BUSH_BARE].bare).toBe(true);
    for (const q of bare) for (const [r, g, b] of texelsOf(B.NIGHTSHADE_BUSH_BARE, q)) expect(berryBlack(r, g, b) || violet(r, g, b) || berryBlue(r, g, b)).toBe(false);
  });

  it('the others: flat daisies with yellow hearts, a purple tuft on top of the thistle, sky-blue flowers on the flax, thick aloe leaves', () => {
    // daisies: three flowers, each a flat box whose top is the whole flower (white round a yellow heart)
    const daisies = quadsOf(B.MEADOW_DAISIES).filter((q) => {
      const t = texelsOf(B.MEADOW_DAISIES, q);
      return t.length === 9 && t.filter(([r, g, b]) => yellow(r, g, b)).length === 1 && t.filter(([r, g, b]) => white(r, g, b)).length === 4;
    });
    expect(daisies).toHaveLength(3);
    for (const q of daisies) expect(q.n[1]).toBeGreaterThan(0.8); // facing the sky, tipped a little
    // … and the plants that grow on every twentieth column or so stay light: a daisy clump and a fern under 32 quads
    expect(quadsOf(B.MEADOW_DAISIES).length).toBeLessThanOrEqual(32);
    expect(quadsOf(B.FERN).length).toBeLessThanOrEqual(32);
    // thistle: the top of the plant is purple, and every leaf ends pale
    const thistleTop = quadsOf(B.THISTLE).filter(up).sort((a, b) => height(b) - height(a))[0];
    expect(texelsOf(B.THISTLE, thistleTop).every(([r, g, b]) => violet(r, g, b))).toBe(true);
    expect(facesAll(B.THISTLE, (r, g, b) => r > 230 && g > 230 && b > 180)).toHaveLength(6); // six leaves, a spine each
    // flax: five flowers, sky blue, in the upper half of the plant
    const flowers = quadsOf(B.FLAX).filter((q) => texelsOf(B.FLAX, q).length === 9 && texelsOf(B.FLAX, q).filter(([r, g, b]) => skyBlue(r, g, b)).length >= 6);
    expect(flowers).toHaveLength(5);
    for (const q of flowers) expect(height(q)).toBeGreaterThan(topOf(B.FLAX) / 2);
    // aloe: no cards at all — every leaf is a block with a pale-toothed edge
    const aloe = quadsOf(B.ALOE);
    expect(aloe.every((q) => texelsOf(B.ALOE, q).every((p) => p[3] === 255))).toBe(true);
    expect(facesWith(B.ALOE, (r, g, b) => r > 230 && g > 230 && b > 190).length).toBeGreaterThanOrEqual(12);
    // fern: only green, and fronds that reach out further than they stand up from the crown
    for (const q of quadsOf(B.FERN)) for (const [r, g, b, a] of texelsOf(B.FERN, q)) if (a === 255) expect(g > r && g > b).toBe(true);
    const reach = Math.max(...quadsOf(B.FERN).flatMap((q) => q.p.map((p) => Math.hypot(p[0], p[2]))));
    expect(reach).toBeGreaterThan(0.45);
  });
});

describe('the three items (items.js) and their icons (itemArt.js)', () => {
  const food = (k) => /** @type {*} */ (ITEMS[k].food);

  it('Hemlock Root and Nightshade Berries are foods, after the Healwort Tea and before the game; the Aloe Leaf is a heal, after the bandages', () => {
    const foods = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food');
    const i = foods.indexOf('pot_healwort_tea');
    expect(foods.slice(i + 1, i + 4)).toEqual(['hemlock_root', 'nightshade_berries', 'raw_venison']);
    expect(foods.slice(-2)).toEqual(['pot_tainted', 'pot_spring']); // §85: the Pot of Spring Water follows the Pot of Tainted Water
    expect(foods).toHaveLength(55);
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'heal')).toEqual(['fibre_bandage', 'rag_bandage', 'aloe_leaf']);
    expect(getItem('hemlock_root')).toEqual({ key: 'hemlock_root', name: 'Hemlock Root', kind: 'food', stack: 16, food: { satiation: 3, hydration: 1, sick: 1, useS: 1.0 } });
    expect(getItem('nightshade_berries')).toEqual({ key: 'nightshade_berries', name: 'Nightshade Berries', kind: 'food', stack: 32,
      food: { satiation: 4, hydration: 2, sick: 1, useS: 0.8, spoilS: 1800 } });
    expect(getItem('aloe_leaf')).toEqual({ key: 'aloe_leaf', name: 'Aloe Leaf', kind: 'heal', stack: 16, heal: { hp: 6, rate: 1.5, useS: 1.0 } });
    expect(itemName('nightshade_berries', 1)).toBe('Nightshade Berry');
    expect(itemName('nightshade_berries', 2)).toBe('Nightshade Berries');
    expect(ITEM_KEYS).toHaveLength(266); // + §85: the Pot of Spring Water and four block items
  });

  it('each look-alike\'s food is its twin\'s in every number but one: it always poisons', () => {
    for (const [fake, real] of [['hemlock_root', 'wild_carrot'], ['nightshade_berries', 'honeyberries']]) {
      expect({ ...food(fake), sick: 0 }, fake).toEqual(food(real));
      expect(food(fake).sick, fake).toBe(1);
      expect(stackSize(fake), fake).toBe(stackSize(real));
    }
    expect(food('hemlock_root').sick).toBe(food('frecklecap').sick); // the Frecklecap's strength: every time
    expect(food('nightshade_berries').hydration).toBeGreaterThan(0); // a little juice
    expect(food('nightshade_berries').hydration).toBeLessThanOrEqual(2);
  });

  it('each has an icon of its own, drawn as the food it imitates with its plant\'s signs', () => {
    const icons = ['hemlock_root', 'nightshade_berries', 'aloe_leaf', 'wild_carrot', 'honeyberries', 'fibre_bandage'].map((k) => Buffer.from(paintItem(k)).toString('hex'));
    expect(new Set(icons).size).toBe(6);
    for (const k of ['hemlock_root', 'nightshade_berries', 'aloe_leaf']) {
      expect(hasItemArt(k), k).toBe(true);
      expect(opaque(paintItem(k)).length, k).toBeGreaterThanOrEqual(40);
      for (const [, , , a] of pixels(paintItem(k))) expect(a === 0 || a === 255, k).toBe(true);
    }
    // the root: the carrot's very shape (the same silhouette from the shoulder down), pale where the carrot is orange
    const rootMask = (k) => mask(paintItem(k)).slice(4 * 16);
    expect(rootMask('hemlock_root')).toEqual(rootMask('wild_carrot'));
    expect(countWhere(paintItem('wild_carrot'), orange)).toBeGreaterThan(30);
    expect(countWhere(paintItem('hemlock_root'), orange)).toBe(0);
    expect(countWhere(paintItem('hemlock_root'), (r, g, b) => r > 200 && g > 190 && b > 150)).toBeGreaterThan(30);
    expect(countWhere(paintItem('hemlock_root'), violet)).toBe(2); // the blotches on the stub of its stem
    expect(countWhere(paintItem('wild_carrot'), violet)).toBe(0);
    // the berries: black where the honeyberries are blue, round where they are long
    expect(countWhere(paintItem('nightshade_berries'), berryBlue)).toBe(0);
    expect(countWhere(paintItem('honeyberries'), berryBlue)).toBeGreaterThan(60);
    expect(countWhere(paintItem('nightshade_berries'), berryBlack)).toBeGreaterThan(60);
    // the leaf: sea green with pale teeth
    expect(countWhere(paintItem('aloe_leaf'), (r, g, b) => g > r && b > r)).toBeGreaterThan(60);
    expect(countWhere(paintItem('aloe_leaf'), (r, g, b) => r === 0xf4 && g === 0xf8 && b === 0xd4)).toBe(6);
  });
});

describe('gathering (harvest.js)', () => {
  it('R picks the two look-alikes and the two useful plants; the greenery is not picked', () => {
    const rows = [
      [B.HEMLOCK, B.AIR, 'hemlock_root', [1, 1]], [B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE, 'nightshade_berries', [2, 4]],
      [B.FLAX, B.AIR, 'plant_fibre', [3, 4]], [B.ALOE, B.AIR, 'aloe_leaf', [1, 2]],
    ];
    for (const [id, to, key, [lo, hi]] of rows) {
      expect(isPickable(id), key).toBe(true);
      expect(pick(id, {}, seq(0)), key).toEqual({ to, drops: [{ k: key, n: lo }] });
      expect(pick(id, {}, seq(0.999)), key).toEqual({ to, drops: [{ k: key, n: hi }] });
      expect(PICKABLE[id].drops, key).toHaveLength(1); // one group: no seed, nothing else
    }
    for (const id of [B.FERN, B.MEADOW_DAISIES, B.THISTLE, B.NIGHTSHADE_BUSH_BARE]) {
      expect(isPickable(id), BLOCKS[id].name).toBe(false);
      expect(pick(id, {}, seq(0)), BLOCKS[id].name).toBeNull();
    }
    // a look-alike is picked exactly as its twin: the same block change, the same count
    expect(PICKABLE[B.HEMLOCK].to).toBe(PICKABLE[B.CARROT_PLANT].to);
    expect(PICKABLE[B.HEMLOCK].drops[0][0].items[0].n).toEqual(PICKABLE[B.CARROT_PLANT].drops[0][0].items[0].n);
    expect(PICKABLE[B.NIGHTSHADE_BUSH].drops[0][0].items[0].n).toEqual(PICKABLE[B.HONEYBERRY_BUSH].drops[0][0].items[0].n);
    // … but gives no seed: none of the eight can be planted
    expect(asMap(pick(B.HEMLOCK, {}, seq(0)).drops)).toEqual({ hemlock_root: 1 });
    expect(Object.keys(asMap(pick(B.CARROT_PLANT, {}, seq(0)).drops))).toEqual(['wild_carrot', 'carrot_seeds']);
  });

  it('the hint is the plant\'s name and "R: pick", with no warning: neither rule adds a word to it', () => {
    // main shows `<display name> · R: pick` for a pickable block unless one of these two has something to say
    for (const [, id] of PLANTS) {
      expect(handGatherHint(id), BLOCKS[id].name).toBeNull();
      expect(harvestHint(id), BLOCKS[id].name).toBeNull();
    }
    expect(`${BLOCKS[B.HEMLOCK].displayName} · R: pick`).toBe('Hemlock · R: pick');
    expect(`${BLOCKS[B.NIGHTSHADE_BUSH].displayName} · R: pick`).toBe('Nightshade Bush · R: pick');
  });

  it('breaking by hand gives what a pick gives; the greenery breaks at once and gives nothing but a fern\'s odd strand of fibre', () => {
    const hand = (id, ...rolls) => asMap(rollDrops(id, null, {}, seq(...rolls)));
    expect([hand(B.HEMLOCK, 0), hand(B.HEMLOCK, 0.999)]).toEqual([{ hemlock_root: 1 }, { hemlock_root: 1 }]);
    expect([hand(B.FLAX, 0), hand(B.FLAX, 0.999)]).toEqual([{ plant_fibre: 3 }, { plant_fibre: 4 }]);
    expect([hand(B.ALOE, 0), hand(B.ALOE, 0.999)]).toEqual([{ aloe_leaf: 1 }, { aloe_leaf: 2 }]);
    // a bush broken by hand: its berries and its sticks, like the Honeyberry
    expect([hand(B.NIGHTSHADE_BUSH, 0), hand(B.NIGHTSHADE_BUSH, 0.999)]).toEqual([{ nightshade_berries: 2, stick: 1 }, { nightshade_berries: 4, stick: 2 }]);
    expect(hand(B.NIGHTSHADE_BUSH_BARE, 0)).toEqual({ stick: 1 });
    expect(hand(B.HONEYBERRY_BUSH, 0)).toEqual({ honeyberries: 2, stick: 1 });
    // the greenery
    expect(FERN_FIBRE_P).toBe(0.3);
    expect(hand(B.FERN, 0.29)).toEqual({ plant_fibre: 1 });
    expect(hand(B.FERN, 0.3)).toEqual({});
    expect(hand(B.MEADOW_DAISIES, 0)).toEqual({});
    expect(hand(B.THISTLE, 0)).toEqual({});
    // a knife makes no difference to any of them (it is a tussock's tool)
    for (const [, id] of PLANTS) expect(rollDrops(id, KNIFE, {}, seq(0.999)), BLOCKS[id].name).toEqual(rollDrops(id, null, {}, seq(0.999)));
    // quick to break: the greenery in 0.2 s, nothing slower than the bush; a shovel is faster still
    for (const id of [B.FERN, B.MEADOW_DAISIES, B.THISTLE]) expect(breakSeconds(id, null)).toBe(0.2);
    expect([B.HEMLOCK, B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE, B.FLAX, B.ALOE].map((id) => breakSeconds(id, null))).toEqual([0.4, 0.5, 0.5, 0.3, 0.3]);
    expect(breakSeconds(B.HEMLOCK, null)).toBe(breakSeconds(B.CARROT_PLANT, null));
    expect(breakSeconds(B.NIGHTSHADE_BUSH, null)).toBe(breakSeconds(B.HONEYBERRY_BUSH, null));
    for (const [, id] of PLANTS) {
      expect(BLOCK_RULES[id], BLOCKS[id].name).toMatchObject({ tool: 'shovel', tier: 0 });
      expect(breakSeconds(id, SHOVEL), BLOCKS[id].name).toBeLessThan(breakSeconds(id, null));
    }
  });

  it('a shovel lifts each of the eight whole', () => {
    const dug = (id, r = 0) => asMap(rollDrops(id, SHOVEL, {}, seq(r)));
    for (const name of ['fern', 'meadow_daisies', 'thistle', 'hemlock', 'flax', 'aloe']) expect(dug(B[name.toUpperCase()]), name).toEqual({ [name]: 1 });
    // the bush comes up with what hangs on it, as the Honeyberry does; its item sets it down picked
    expect(dug(B.NIGHTSHADE_BUSH)).toEqual({ nightshade_bush: 1, nightshade_berries: 2, stick: 1 });
    expect(dug(B.NIGHTSHADE_BUSH_BARE, 0.999)).toEqual({ nightshade_bush: 1, stick: 2 });
    expect(dug(B.HONEYBERRY_BUSH)).toEqual({ honeyberry_bush: 1, honeyberries: 2, stick: 1 });
    // lifting a hemlock or an aloe whole gives the plant, not its root or leaves as well (it is set down ripe)
    expect(blockForItem('hemlock')).toBe(B.HEMLOCK);
    expect(blockForItem('aloe')).toBe(B.ALOE);
  });

  it('regrowth: the picked Nightshade is tracked and comes back, as the Honeyberry does; a pulled hemlock, flax or aloe does not', () => {
    expect(ripeOf(B.NIGHTSHADE_BUSH_BARE)).toBe(B.NIGHTSHADE_BUSH);
    expect(RIPE_OF[B.NIGHTSHADE_BUSH_BARE]).toBe(B.NIGHTSHADE_BUSH);
    expect(PICKABLE[B.NIGHTSHADE_BUSH].to).toBe(B.NIGHTSHADE_BUSH_BARE);
    const g = new Regrowth();
    g.onBlockChange(1, 70, 1, B.NIGHTSHADE_BUSH, pick(B.NIGHTSHADE_BUSH, {}, seq(0)).to);
    g.onBlockChange(3, 70, 1, B.HEMLOCK, pick(B.HEMLOCK, {}, seq(0)).to);
    g.onBlockChange(5, 70, 1, B.FLAX, pick(B.FLAX, {}, seq(0)).to);
    g.onBlockChange(7, 70, 1, B.ALOE, pick(B.ALOE, {}, seq(0)).to);
    expect(g.size).toBe(1);
    expect(g.has(1, 70, 1)).toBe(true);
    expect(g.step(1, () => 0, () => true)).toEqual([{ q: 1, y: 70, r: 1, id: B.NIGHTSHADE_BUSH }]);
    expect(g.size).toBe(0);
  });
});

describe('poison (vitals.js, survival.js) and fire (cooking.js)', () => {
  const food = (k) => /** @type {*} */ (ITEMS[k].food);
  const started = () => {
    const s = new Survival();
    s.setMode('survival');
    return s;
  };

  it('a Hemlock Root and Nightshade Berries poison every time, whatever the roll: the Frecklecap\'s poisoning', () => {
    for (const k of ['hemlock_root', 'nightshade_berries']) {
      for (const roll of [0, 0.5, 0.999999]) {
        const v = createVitals();
        const before = { ...v };
        expect(eatFood(v, food(k), () => roll), k).toEqual({ sick: true, cured: false });
        expect(v.sick).toBe(RATES.SICK_S);
        expect(statusOf(v).labels).toContain('Poisoned');
        expect(statusOf(v).regen).toBe(false);
        // it fed a little, and the poisoning took more
        expect(v.satiation).toBe(before.satiation + food(k).satiation + RATES.POISON_HUNGER);
        expect(v.hydration).toBe(before.hydration + food(k).hydration + RATES.POISON_THIRST);
      }
      // exactly what a Frecklecap does to the body's clock
      const a = createVitals();
      const b = createVitals();
      eatFood(a, food(k), () => 0);
      eatFood(b, food('frecklecap'), () => 0);
      expect(a.sick, k).toBe(b.sick);
    }
    // the twins never do
    const w = createVitals();
    expect(eatFood(w, food('wild_carrot'), () => 0)).toEqual({ sick: false, cured: false });
    expect(eatFood(w, food('honeyberries'), () => 0)).toEqual({ sick: false, cured: false });
    expect(w.sick).toBe(0);
    // a hemlock root leaves you worse off than not eating
    const v = createVitals();
    eatFood(v, food('hemlock_root'), () => 0.5);
    expect(v.satiation).toBeLessThan(RATES.NEW_SATIATION);
    expect(v.hydration).toBeLessThan(RATES.NEW_HYDRATION);
  });

  it('Survival.eat says so, and Healwort ends it', () => {
    const s = started();
    expect(s.eat('wild_carrot', () => 0)).toEqual({ ok: true });
    expect(s.eat('hemlock_root', () => 0.99)).toEqual({ ok: true, message: SICK_MESSAGE });
    expect(s.vitals.sick).toBe(RATES.SICK_S);
    expect(s.eat('nightshade_berries', () => 0.99)).toEqual({ ok: true, message: SICK_MESSAGE });
    expect(s.vitals.sick).toBe(2 * RATES.SICK_S); // the cases add up
    expect(s.eat('healwort', () => 0.99)).toEqual({ ok: true, message: CURED_MESSAGE });
    expect(s.vitals.sick).toBe(0);
  });

  it('neither goes on a fire: there is no roasting the poison away, and nothing is made of either', () => {
    for (const k of ['hemlock_root', 'nightshade_berries']) {
      expect(FIRE_TRANSFORMS[k], k).toBeUndefined();
      expect(isSkewerFood(k), k).toBe(false);
      expect(SKEWER_FOODS, k).not.toContain(k);
      const fs = new FireSlots();
      expect(fs.put(0, 70, 0, k, 0), k).toBe(-1);
      expect(Object.values(FIRE_TRANSFORMS).some((tr) => tr.to === k), k).toBe(false);
      expect(RECIPES.some((r) => [...r.inputs, ...r.outputs].some((it) => 'k' in it && it.k === k)), k).toBe(false);
    }
    // (their twins do roast: a wild carrot goes on a skewer)
    expect(isSkewerFood('wild_carrot')).toBe(true);
  });
});

describe('the Aloe Leaf: a quick, small heal that needs no making', () => {
  it('RMB puts it on like a bandage, in 1 s; it queues 6 HP paid out at 1.5 HP a second', () => {
    expect(useActionOf({ k: 'aloe_leaf', n: 3 })).toEqual({ kind: 'bandage', key: 'aloe_leaf', needS: 1.0 });
    expect(useActionOf({ k: 'fibre_bandage', n: 1 })).toEqual({ kind: 'bandage', key: 'fibre_bandage', needS: 1.5 });
    const s = new Survival();
    s.setMode('survival');
    s.vitals.health = 30;
    expect(s.bandage('aloe_leaf')).toBe(true);
    expect([s.vitals.heal, s.vitals.healRate]).toEqual([6, 1.5]);
    // two leaves: twelve to come; a bandage on top speeds nothing down
    expect(s.bandage('aloe_leaf')).toBe(true);
    expect([s.vitals.heal, s.vitals.healRate]).toEqual([12, 1.5]);
    expect(s.bandage('rag_bandage')).toBe(true);
    expect([s.vitals.heal, s.vitals.healRate]).toEqual([37, 2.5]);
    expect(new Survival().bandage('aloe_leaf')).toBe(false); // not while there is no body to heal
  });

  it('the six points arrive in four seconds, whatever the body\'s state — starving, parched, even Poisoned', () => {
    const { hp, rate } = /** @type {{ hp: number, rate: number }} */ (ITEMS.aloe_leaf.heal);
    const v = createVitals();
    v.health = 40;
    v.satiation = 0; // starving: no regeneration of its own
    v.hydration = 60;
    eatFood(v, /** @type {*} */ (ITEMS.hemlock_root.food), () => 0); // … and Poisoned
    expect(statusOf(v).regen).toBe(false);
    expect(queueHeal(v, hp, rate)).toBe(true);
    let lost = 0;
    for (let t = 0; t < 8; t++) {
      const step = stepVitals(v, 0.5, { activity: 1, felt: 20 });
      lost += Object.values(step.damage).reduce((sum, d) => sum + d, 0);
    }
    expect(v.heal).toBe(0); // all paid out after 4 s (6 ÷ 1.5)
    expect(v.health).toBeCloseTo(40 + hp - lost, 9);
    expect(hp / rate).toBe(4);
  });

  it('it is less than a bandage but quicker, and it is picked, not made', () => {
    const aloe = /** @type {*} */ (ITEMS.aloe_leaf.heal);
    const fibre = /** @type {*} */ (ITEMS.fibre_bandage.heal);
    expect(aloe.hp).toBeLessThan(fibre.hp);
    expect(aloe.useS).toBeLessThan(fibre.useS);
    expect(aloe.rate).toBe(fibre.rate);
    expect(RECIPES.some((r) => r.outputs.some((o) => o.k === 'aloe_leaf'))).toBe(false);
    expect(RECIPES.some((r) => r.inputs.some((i) => 'k' in i && i.k === 'aloe_leaf'))).toBe(false);
    expect(RECIPES.find((r) => r.id === 'fibre_bandage').inputs).toEqual([{ k: 'plant_fibre', n: 3 }]);
    // one aloe plant (1–2 leaves, 6–12 HP) is worth about a flax plant's fibre made into a bandage (3–4 fibre, 15 HP)
    expect(2 * aloe.hp).toBeLessThan(fibre.hp);
    // it is not food: eating is not what RMB does with it
    expect(ITEMS.aloe_leaf.food).toBeUndefined();
  });
});

describe('they spread, but cannot be planted (spread.js, farming.js)', () => {
  const G = 10;
  const Y = G + 1;
  const kindOf = (key) => /** @type {*} */ (SPREAD_KINDS.find((k) => k.key === key));
  /** The roll that makes a sample land on the player's own column. */
  const HERE = (() => {
    const cells = discCells(SPREAD_RANGE);
    for (let i = 0; i < cells.length; i += 2) if (cells[i] === 0 && cells[i + 1] === 0) return (i / 2 + 0.5) / SPREAD_COLUMNS;
    throw new Error('no middle');
  })();
  const view = (w) => ({ getBlock: w.getBlock, isLoadedCell: () => true, q: 0, r: 0, top: 40 });

  it('four rows: hemlock 6, nightshade 4, flax 8 on grass or dirt, aloe 4 on sand or red sand; the greenery does not spread', () => {
    expect(['hemlock', 'nightshade', 'flax', 'aloe'].map((key) => [key, kindOf(key).cap, [...kindOf(key).soil], [...kindOf(key).blocks]])).toEqual([
      ['hemlock', 6, [B.GRASS_BLOCK, B.DIRT], [B.HEMLOCK]],
      ['nightshade', 4, [B.GRASS_BLOCK, B.DIRT], [B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE]],
      ['flax', 8, [B.GRASS_BLOCK, B.DIRT], [B.FLAX]],
      ['aloe', 4, [B.SAND, B.RED_SAND], [B.ALOE]],
    ]);
    for (const id of [B.FERN, B.MEADOW_DAISIES, B.THISTLE]) expect(spreadKindOf(id), BLOCKS[id].name).toBeNull();
    for (const id of [B.HEMLOCK, B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE, B.FLAX, B.ALOE]) expect(spreadKindOf(id), BLOCKS[id].name).not.toBeNull();
    // a look-alike's patch is a little smaller than its twin's
    expect(kindOf('hemlock').cap).toBeLessThan(kindOf('carrot').cap);
    expect(kindOf('nightshade').cap).toBeLessThan(kindOf('honeyberry').cap);
  });

  it('each comes up on its own ground under open sky, and nowhere else', () => {
    const on = (ground) => makeFakeWorld({ groundY: G, groundId: ground });
    const grows = (key, ground) => canGrowAt(on(ground).getBlock, kindOf(key), 0, Y, 0, 40);
    for (const key of ['hemlock', 'nightshade', 'flax']) {
      expect([grows(key, B.GRASS_BLOCK), grows(key, B.DIRT)], key).toEqual([true, true]);
      for (const ground of [B.SAND, B.RED_SAND, B.STONE, B.GRAVEL, B.SNOWY_GRASS]) expect(grows(key, ground), `${key} on ${BLOCKS[ground].name}`).toBe(false);
    }
    expect([grows('aloe', B.SAND), grows('aloe', B.RED_SAND)]).toEqual([true, true]);
    for (const ground of [B.GRASS_BLOCK, B.DIRT, B.STONE, B.GRAVEL, B.SANDSTONE]) expect(grows('aloe', ground), BLOCKS[ground].name).toBe(false);
    // under a roof: none of them (they are no mushrooms)
    const roofed = on(B.GRASS_BLOCK);
    roofed.setBlock(0, Y + 3, 0, B.OAK_PLANKS);
    for (const key of ['hemlock', 'nightshade', 'flax']) expect(canGrowAt(roofed.getBlock, kindOf(key), 0, Y, 0, 40), key).toBe(false);
  });

  it('a plant standing alone seeds a neighbour of its own kind: a Nightshade comes up picked and Regrowth ripens it', () => {
    for (const [key, ground] of [['hemlock', B.GRASS_BLOCK], ['flax', B.GRASS_BLOCK], ['aloe', B.SAND], ['nightshade', B.GRASS_BLOCK]]) {
      const w = makeFakeWorld({ groundY: G, groundId: ground });
      const k = kindOf(key);
      w.setBlock(0, Y, 0, k.blocks[0]);
      // the first sample lands on the plant; its birth roll passes; its seed lands on the first neighbour on the list
      const birth = spreadStep(1, seq(HERE, 0, 0), view(w));
      expect(birth, key).toMatchObject({ y: Y, id: k.born, kind: k, seeded: true, parent: [0, Y, 0] });
    }
    expect(kindOf('nightshade').born).toBe(B.NIGHTSHADE_BUSH_BARE);
    expect(kindOf('honeyberry').born).toBe(B.HONEYBERRY_BUSH_BARE);
    const g = new Regrowth();
    g.onBlockChange(2, Y, 0, B.AIR, kindOf('nightshade').born); // what main's write of the birth reaches Regrowth with
    expect(g.step(1, () => 0, () => true)).toEqual([{ q: 2, y: Y, r: 0, id: B.NIGHTSHADE_BUSH }]);
    expect(SPREAD_SAMPLES).toBeGreaterThan(0);
  });

  it('none of the eight can be planted: no item of theirs is a seed, and no crop grows into one', () => {
    for (const key of ['hemlock_root', 'nightshade_berries', 'aloe_leaf', 'fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'flax', 'aloe']) {
      expect(Object.hasOwn(PLANTABLE, key), key).toBe(false);
      expect(cropOfItem(key), key).toBeNull();
      expect(plantAt(() => B.GRASS_BLOCK, key, 0, 5, 0), key).toBeNull();
    }
    for (const [, id] of PLANTS) expect(cropOfBlock(id), BLOCKS[id].name).toBeNull();
    expect(CROPS).toHaveLength(9);
    expect(Object.keys(PLANTABLE)).toHaveLength(11); // as §80 left it
    // (the twins can: a honeyberry is planted as it is, a carrot from its seed)
    expect(cropOfItem('honeyberries')?.key).toBe('honeyberry');
    expect(cropOfItem('carrot_seeds')?.key).toBe('carrot');
  });
});
