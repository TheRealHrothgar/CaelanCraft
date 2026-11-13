// Tests for the wild plants of generation 3 (v0.14, CONTRACTS §76 flora): the blocks 122–131 and their sprites 208–217,
// the food they give and its icons, picking with R, digging, regrowth, roasting, the Frecklecap's poison and the
// Healwort's cure. Where they GROW is worldgenFlora.test.js's business. Pure modules only.
import { describe, it, expect } from 'vitest';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, PICKER_ORDER, PLANT_IDS, POP_OFF_IDS, LAYER_CUTOUT, getFaceTile, getBlockShape, isPlant,
  isPopOff, isFallThrough, isReplaceable, isTargetable, shouldRenderFace,
} from '../../src/blocks.js';
import { paintTile, averageColor, TILE_NAMES } from '../../src/tiles.js';
import { ITEMS, ITEM_KEYS, getItem, itemForBlock, blockForItem, itemName } from '../../src/items.js';
import { paintItem, hasItemArt } from '../../src/itemArt.js';
import {
  PICKABLE, RIPE_OF, Regrowth, isPickable, pick, rollDrops, ripeOf, breakSeconds, handGatherHint, SEED_DROPS,
} from '../../src/harvest.js';
import { FIRE_TRANSFORMS, SKEWER_FOODS, FireSlots, isSkewerFood } from '../../src/cooking.js';
import { RECIPES } from '../../src/crafting.js';
import { createVitals, eatFood, cureSick, statusOf, stepVitals, RATES } from '../../src/vitals.js';
import { Survival, SICK_MESSAGE, CURED_MESSAGE } from '../../src/survival.js';
import { popOffEffect } from '../../src/fallingblocks.js';
import { buildPickerModel } from '../../src/pickerModel.js';

const B = BLOCK;
const T = TILE;
const SHOVEL = { type: 'shovel', tier: 1, durability: 40, power: 1 };
/** A `random` that returns the listed values in turn, then the last one for ever. */
const seq = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};
const asMap = (stacks) => Object.fromEntries(stacks.map((s) => [s.k, s.n]));

/** The ten plant blocks: [BLOCK key, id, name, display name, sound, TILE key, placeable]. */
const PLANTS = [
  ['HONEYCAP_MUSHROOM', 122, 'honeycap_mushroom', 'Honeycap Mushroom', 'grass', 'HONEYCAP_MUSHROOM', true],
  ['FRECKLECAP_MUSHROOM', 123, 'frecklecap_mushroom', 'Frecklecap Mushroom', 'grass', 'FRECKLECAP_MUSHROOM', true],
  ['ONION_PLANT', 124, 'onion_plant', 'Wild Onion Plant', 'grass', 'ONION_PLANT', true],
  ['CARROT_PLANT', 125, 'carrot_plant', 'Wild Carrot Plant', 'grass', 'CARROT_PLANT', true],
  ['HAZEL_THICKET', 126, 'hazel_thicket', 'Hazel Thicket', 'leaves', 'HAZEL_THICKET', true],
  ['HAZEL_THICKET_BARE', 127, 'hazel_thicket_bare', 'Picked Hazel Thicket', 'leaves', 'HAZEL_THICKET_BARE', false],
  ['CRAB_APPLE_BUSH', 128, 'crab_apple_bush', 'Crab Apple Bush', 'leaves', 'CRAB_APPLE_BUSH', true],
  ['CRAB_APPLE_BUSH_BARE', 129, 'crab_apple_bush_bare', 'Picked Crab Apple Bush', 'leaves', 'CRAB_APPLE_BUSH_BARE', false],
  ['HEALWORT_PLANT', 130, 'healwort_plant', 'Healwort Plant', 'grass', 'HEALWORT_PLANT', true],
  ['HEALWORT_PLANT_BARE', 131, 'healwort_plant_bare', 'Cut Healwort Plant', 'grass', 'HEALWORT_PLANT_BARE', false],
];
const PLANT_BLOCK_IDS = PLANTS.map((row) => row[1]);
const FLORA_TILES = PLANTS.map((row) => T[row[5]]);
/** The 14 food items, in ITEM_KEYS order. */
const FOODS = [
  'honeycap', 'roasted_honeycap', 'frecklecap', 'roasted_frecklecap', 'wild_onion', 'roasted_onion', 'wild_carrot',
  'roasted_carrot', 'hazelnuts', 'roasted_hazelnuts', 'crab_apple', 'baked_crab_apple', 'healwort', 'pot_healwort_tea',
];

// ---- pixels ---------------------------------------------------------------------------------------------------------

/** @returns {[number, number, number, number][]} the 256 pixels of a 16×16 RGBA buffer, row by row */
function pixels(px) {
  const out = [];
  for (let i = 0; i < 1024; i += 4) out.push([px[i], px[i + 1], px[i + 2], px[i + 3]]);
  return out;
}
const opaque = (px) => pixels(px).filter((p) => p[3] === 255);
const countWhere = (px, pred) => opaque(px).filter(([r, g, b]) => pred(r, g, b)).length;
const isHex = (hex) => (r, g, b) => r === ((hex >> 16) & 255) && g === ((hex >> 8) & 255) && b === (hex & 255);
/** Violet: the Healwort's flowers and nothing else (red and blue both well above green). */
const violet = (r, g, b) => r > g + 40 && b > g + 70;
/** Apple red. */
const red = (r, g, b) => r > 170 && g < 80 && b < 80;
/** Carrot orange. */
const orange = (r, g, b) => r > 180 && g > 90 && g < 175 && b < 90;
/** The Frecklecap's freckles (tiles.js MUSHROOMS). */
const FRECKLE = 0xfff3d2;
/** @returns {boolean[]} which of the 256 pixels are opaque */
const mask = (px) => pixels(px).map((p) => p[3] === 255);

describe('the plant blocks 122–131 (blocks.js)', () => {
  it('ids, names, flags and tiles: 3D models (§78) with the PLANT flags, flat icons, ids 122–131', () => {
    expect(BLOCK_COUNT).toBe(159); // §80: the 18 farm blocks follow at 133–150; §81: the plants that are not food at 151–158
    expect(BLOCKS).toHaveLength(159);
    for (const [key, id, name, displayName, sound, tile, placeable] of PLANTS) {
      expect(B[key], key).toBe(id);
      const d = BLOCKS[id];
      expect([d.id, d.name, d.displayName, d.soundGroup, d.placeable], key).toEqual([id, name, displayName, sound, placeable]);
      expect([d.solid, d.opaque, d.layer, d.cullSame, d.meshed, d.icon, d.shape], key).toEqual([false, false, LAYER_CUTOUT, false, true, 'flat', 'model']);
      expect(d.breakable && !d.liquid && !d.gravity, key).toBe(true);
      expect(getBlockShape(id), key).toBe('model');
      for (let f = 0; f < 8; f++) expect(getFaceTile(id, f), `${key} face ${f}`).toBe(T[tile]);
      expect(T[tile], key).toBe(208 + (id - 122)); // one sprite per block, in id order
      expect(TILE_NAMES[T[tile]], key).toBe(name);
      // walk-through, yet never replaceable, fall-through or untargetable; it hides no neighbour and pops off like a plant
      expect(isReplaceable(id) || isFallThrough(id) || !isTargetable(id), key).toBe(false);
      expect(shouldRenderFace(B.STONE, id) && shouldRenderFace(id, id), key).toBe(true);
      expect(isPlant(id) && isPopOff(id), key).toBe(true);
      expect(PICKER_ORDER.includes(id), key).toBe(placeable);
      expect(popOffEffect(id), key).toMatchObject({ kind: 'leaves', count: 6, sound: 'break:leaves' });
      expect(popOffEffect(id).color, key).toHaveLength(3);
    }
    expect(PLANT_IDS.slice(7, 17)).toEqual(PLANT_BLOCK_IDS); // the eight of §81 follow (plantsNotFood.test.js)
    expect(POP_OFF_IDS.slice(-36, -26)).toEqual(PLANT_BLOCK_IDS); // then the 18 farm blocks (§80) and the eight plants of §81
  });


  it('no name gives the Frecklecap away: nothing a player reads says poison', () => {
    const words = /poison|toxic|deadly|venom|bad|fool|false|death|sick/i;
    for (const d of BLOCKS.slice(122)) expect(`${d.name} ${d.displayName}`).not.toMatch(words);
    for (const k of FOODS) expect(`${k} ${ITEMS[k].name}`).not.toMatch(words);
    // §81: nor do the Hemlock, the Nightshade, what they give, or any other plant that is not food
    expect(BLOCKS.slice(122).map((d) => d.name)).toEqual(expect.arrayContaining(['fern', 'meadow_daisies', 'thistle', 'hemlock',
      'nightshade_bush', 'nightshade_bush_bare', 'flax', 'aloe']));
    for (const k of ['hemlock_root', 'nightshade_berries', 'aloe_leaf', 'hemlock', 'nightshade_bush', 'fern', 'meadow_daisies', 'thistle', 'flax', 'aloe']) {
      expect(`${k} ${ITEMS[k].name}`, k).not.toMatch(words);
    }
    // … and no food at all is named for what it does to you
    for (const k of ITEM_KEYS.filter((key) => ITEMS[key].kind === 'food')) expect(`${k} ${ITEMS[k].name}`, k).not.toMatch(words);
    // … and the two mushrooms are named alike: one word and "Mushroom"
    expect(BLOCKS[B.HONEYCAP_MUSHROOM].displayName).toMatch(/^\w+cap Mushroom$/);
    expect(BLOCKS[B.FRECKLECAP_MUSHROOM].displayName).toMatch(/^\w+cap Mushroom$/);
  });

  it('the Creative picker lists the seven placeable plants among the Wild Plants', () => {
    const model = buildPickerModel();
    const wild = /** @type {*} */ (model.families.get('wild-plants')).ids.map((id) => BLOCKS[id].name);
    expect(wild.slice(0, 5)).toEqual(['tussock', 'cattails', 'tuber_plant', 'honeyberry_bush', 'prickly_pear']);
    expect(wild.slice(5, 12)).toEqual(['onion_plant', 'carrot_plant', 'honeycap_mushroom', 'frecklecap_mushroom', 'hazel_thicket', 'crab_apple_bush', 'healwort_plant']);
    // §81: the seven placeable plants that are not food follow them
    expect(wild.slice(12)).toEqual(['fern', 'meadow_daisies', 'thistle', 'hemlock', 'nightshade_bush', 'flax', 'aloe']);
    expect(wild.map((n) => B[n.toUpperCase()])).toEqual(PICKER_ORDER.slice(PICKER_ORDER.indexOf(B.TUSSOCK), PICKER_ORDER.indexOf(B.TUSSOCK) + 19));
  });
});

describe('the plant sprites 208–217 (tiles.js)', () => {
  const painted = new Map(FLORA_TILES.map((t) => [t, paintTile(t)]));
  const px = (key) => painted.get(T[key]);

  it('each is a deterministic cut-out of its own: alpha 0 or 255 only, clear pixels RGB 0, standing on the bottom row', () => {
    const missing = paintTile(T.MISSING);
    const seen = [];
    for (const t of FLORA_TILES) {
      const p = painted.get(t);
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
      // the corners are clear: the picture is a cut-out (the Pack's icon, and the skin the 3D model is cut from)
      for (const i of [0, 15, 240, 255]) expect(mask(p)[i], `${TILE_NAMES[t]} corner`).toBe(false);
    }
  });

  it('each reads against grass: most of its pixels are far from the grass top\'s colour', () => {
    const [gr, gg, gb] = averageColor(T.GRASS_TOP);
    const far = (r, g, b) => Math.hypot(r - gr, g - gg, b - gb) > 60;
    for (const t of FLORA_TILES) {
      const p = painted.get(t);
      expect(countWhere(p, far), TILE_NAMES[t]).toBeGreaterThanOrEqual(30);
      expect(countWhere(p, far) / opaque(p).length, TILE_NAMES[t]).toBeGreaterThan(0.45);
    }
  });

  it('the two mushrooms look alike — the same big and small pair, the same warm caps — and differ where the comments say', () => {
    const honey = px('HONEYCAP_MUSHROOM');
    const freckle = px('FRECKLECAP_MUSHROOM');
    // alike: most of each silhouette lies on the other's
    const a = mask(honey);
    const b = mask(freckle);
    const both = a.filter((v, i) => v && b[i]).length;
    expect(both / a.filter(Boolean).length).toBeGreaterThan(0.6);
    expect(both / b.filter(Boolean).length).toBeGreaterThan(0.6);
    // alike: both caps are warm browns (red over green over blue), their means within 50 of each other
    const capMean = (p) => {
      const cap = pixels(p).slice(4 * 16, 9 * 16).filter(([r, g, bl, al]) => al === 255 && r > g && g > bl && r - bl > 90);
      expect(cap.length).toBeGreaterThan(30);
      return [0, 1, 2].map((c) => cap.reduce((s, q) => s + q[c], 0) / cap.length);
    };
    const [h, f] = [capMean(honey), capMean(freckle)];
    expect(Math.hypot(h[0] - f[0], h[1] - f[1], h[2] - f[2])).toBeLessThan(50);
    expect(Math.hypot(h[0] - f[0], h[1] - f[1], h[2] - f[2])).toBeGreaterThan(25); // … yet the Frecklecap's is plainly the duller
    // different, 1: only the Frecklecap has freckles, on both of its mushrooms
    expect(countWhere(honey, isHex(FRECKLE))).toBe(0);
    expect(countWhere(freckle, isHex(FRECKLE))).toBe(9);
    // different, 2: the cap's shape — a dome (4 px wide at the top, 12 at the rim) against a peak (2 px) over a wider brim (14)
    const rowWidth = (m, y) => m.slice(y * 16, y * 16 + 16).filter(Boolean).length;
    expect([rowWidth(a, 4), rowWidth(a, 8)]).toEqual([4, 12]);
    expect([rowWidth(b, 4), rowWidth(b, 8)]).toEqual([2, 14]);
    // different, 3: the stem — fat (4 px, 6 at the foot) against thin (2 px) with a ring (6 px) and a bulb
    const bigStem = (m, y) => m.slice(y * 16, y * 16 + 11).filter(Boolean).length; // columns 0–10: the big mushroom only
    expect([10, 11, 12, 13].map((y) => bigStem(a, y))).toEqual([4, 4, 4, 6]);
    expect([10, 11, 12, 13].map((y) => bigStem(b, y))).toEqual([2, 6, 2, 2]);
    // and the picture really differs: at least a quarter of the tile
    const differing = pixels(honey).filter((q, i) => q.join() !== pixels(freckle)[i].join()).length;
    expect(differing).toBeGreaterThan(64);
  });

  it('every other plant has a sign of its own: violet spikes, red apples, an orange root, white bulbs, pale-husked nuts', () => {
    // violet: the flowering Healwort alone
    for (const t of FLORA_TILES) {
      const n = countWhere(painted.get(t), violet);
      if (t === T.HEALWORT_PLANT) expect(n).toBeGreaterThanOrEqual(24);
      else expect(n, TILE_NAMES[t]).toBe(0);
    }
    // red apples: the ripe crab apple alone (7 apples, 2 red pixels each beside their shine and shade)
    for (const t of FLORA_TILES) {
      const n = countWhere(painted.get(t), red);
      if (t === T.CRAB_APPLE_BUSH) expect(n).toBeGreaterThanOrEqual(14);
      else expect(n, TILE_NAMES[t]).toBe(0);
    }
    // orange: the carrot's root, at the foot of the tile, and nowhere on the onion
    expect(countWhere(px('CARROT_PLANT'), orange)).toBeGreaterThanOrEqual(8);
    expect(pixels(px('CARROT_PLANT')).slice(0, 12 * 16).filter(([r, g, b, al]) => al === 255 && orange(r, g, b))).toHaveLength(0);
    expect(countWhere(px('ONION_PLANT'), orange)).toBe(0);
    // white: the onion's two bulbs (rows 14–15) and its flower head (rows 0–3)
    const white = (r, g, b) => r > 235 && g > 230 && b > 215;
    const onion = pixels(px('ONION_PLANT'));
    expect(onion.slice(14 * 16).filter(([r, g, b, al]) => al === 255 && white(r, g, b))).toHaveLength(8);
    expect(onion.slice(0, 4 * 16).filter(([r, g, b, al]) => al === 255 && white(r, g, b)).length).toBeGreaterThanOrEqual(9);
    // nuts: six clusters on the ripe thicket (a pale husk over a brown nut), none on the picked one
    expect(countWhere(px('HAZEL_THICKET'), isHex(0xdfe8a8))).toBe(6);
    expect(countWhere(px('HAZEL_THICKET'), isHex(0x8c5a26))).toBe(6);
    expect(countWhere(px('HAZEL_THICKET_BARE'), isHex(0xdfe8a8)) + countWhere(px('HAZEL_THICKET_BARE'), isHex(0x8c5a26))).toBe(0);
  });

  it('a picked thicket or bush and a cut Healwort are the same plant without its crop', () => {
    for (const [ripe, bare, crop] of [['HAZEL_THICKET', 'HAZEL_THICKET_BARE', 24], ['CRAB_APPLE_BUSH', 'CRAB_APPLE_BUSH_BARE', 28]]) {
      const a = pixels(px(ripe));
      const b = pixels(px(bare));
      expect(mask(px(ripe))).toEqual(mask(px(bare))); // the same silhouette
      const differing = a.filter((q, i) => q.join() !== b[i].join()).length;
      expect(differing, ripe).toBe(crop); // only the crop's pixels (2×2 each)
    }
    // the cut Healwort keeps its rosette (rows 12–15 identical) and loses everything above its stubs
    const flower = pixels(px('HEALWORT_PLANT'));
    const cut = pixels(px('HEALWORT_PLANT_BARE'));
    expect(cut.slice(13 * 16).map(String)).toEqual(flower.slice(13 * 16).map(String));
    expect(cut.slice(0, 8 * 16).filter((q) => q[3] === 255)).toHaveLength(0);
    expect(flower.slice(0, 8 * 16).filter((q) => q[3] === 255).length).toBeGreaterThan(20);
  });

  it('no two plants of the game can be mistaken at a glance: every pair of sprites differs in at least 60 pixels, but the look-alikes', () => {
    // §81: the fern, the daisies, the thistle, the flax and the aloe join the list (the Hemlock and the Nightshade are
    // look-alikes: plantsNotFood.test.js measures how they differ from their twins)
    const all = [T.HONEYBERRY_BUSH, T.TUSSOCK, T.CATTAILS_SIDE, T.TUBER_PLANT, T.PRICKLY_PEAR,
      T.HONEYCAP_MUSHROOM, T.ONION_PLANT, T.CARROT_PLANT, T.HAZEL_THICKET, T.CRAB_APPLE_BUSH, T.HEALWORT_PLANT,
      T.FERN, T.MEADOW_DAISIES, T.THISTLE, T.FLAX, T.ALOE];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = pixels(paintTile(all[i]));
        const b = pixels(paintTile(all[j]));
        // a pixel differs when one is clear and the other is not, or their colours are far apart
        const n = a.filter((p, k) => (p[3] !== b[k][3]) || (p[3] === 255 && Math.hypot(p[0] - b[k][0], p[1] - b[k][1], p[2] - b[k][2]) > 60)).length;
        expect(n, `${TILE_NAMES[all[i]]} vs ${TILE_NAMES[all[j]]}`).toBeGreaterThanOrEqual(60);
      }
    }
  });
});

describe('the food (items.js) and its icons (itemArt.js)', () => {
  const food = (k) => ITEMS[k].food;

  it('the 14 foods follow the Pot of Milk, each with an icon of its own; the seven plants are block items', () => {
    const foods = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food');
    expect(foods.slice(foods.indexOf('pot_milk') + 1, foods.indexOf('pot_milk') + 1 + FOODS.length)).toEqual(FOODS);
    const icons = FOODS.map((k) => Buffer.from(paintItem(k)).toString('hex'));
    expect(new Set(icons).size).toBe(FOODS.length);
    for (const k of FOODS) {
      expect(hasItemArt(k), k).toBe(true);
      expect(opaque(paintItem(k)).length, k).toBeGreaterThanOrEqual(40);
    }
    for (const [, id, name, displayName, , , placeable] of PLANTS) {
      if (!placeable) continue;
      expect(getItem(name), name).toMatchObject({ kind: 'block', name: displayName, stack: 64 });
      expect(itemForBlock(id)).toBe(name);
    }
    expect(itemName('hazelnuts', 1)).toBe('Hazelnut');
    expect(itemName('roasted_hazelnuts', 1)).toBe('Roasted Hazelnut');
    expect(itemName('hazelnuts', 2)).toBe('Hazelnuts');
  });

  it('a thicket, a bush and a Healwort are replanted bare (they must regrow); the mushrooms and the roots as they are', () => {
    expect(blockForItem('hazel_thicket')).toBe(B.HAZEL_THICKET_BARE);
    expect(blockForItem('crab_apple_bush')).toBe(B.CRAB_APPLE_BUSH_BARE);
    expect(blockForItem('healwort_plant')).toBe(B.HEALWORT_PLANT_BARE);
    expect(itemForBlock(B.HAZEL_THICKET_BARE)).toBe('hazel_thicket');
    expect(itemForBlock(B.CRAB_APPLE_BUSH_BARE)).toBe('crab_apple_bush');
    expect(itemForBlock(B.HEALWORT_PLANT_BARE)).toBe('healwort_plant');
    for (const name of ['honeycap_mushroom', 'frecklecap_mushroom', 'onion_plant', 'carrot_plant']) {
      expect(blockForItem(name)).toBe(B[name.toUpperCase()]);
    }
  });

  it('values: small raw, better cooked, never a feast — and nothing makes the honeyberry pointless', () => {
    const COOKED = { honeycap: 'roasted_honeycap', frecklecap: 'roasted_frecklecap', wild_onion: 'roasted_onion',
      wild_carrot: 'roasted_carrot', hazelnuts: 'roasted_hazelnuts', crab_apple: 'baked_crab_apple' };
    const berries = food('honeyberries');
    for (const [raw, cooked] of Object.entries(COOKED)) {
      expect(food(raw).satiation, raw).toBeLessThan(berries.satiation); // a raw one is less than a honeyberry
      expect(food(cooked).satiation, cooked).toBeGreaterThan(food(raw).satiation);
      expect(food(cooked).satiation, cooked).toBeLessThanOrEqual(7); // a roast root is no baked tuber (12), let alone meat
      expect(FIRE_TRANSFORMS[raw].to, raw).toBe(cooked);
    }
    expect(food('baked_tuber').satiation).toBe(12);
    // one pick of a new plant, at its best and cooked, is at most what one pick of a honeyberry bush gives raw at its best
    const best = (drops, key) => Math.max(...drops.flatMap((g) => g.flatMap((br) => br.items)).filter((it) => it.k === key)
      .map((it) => (Array.isArray(it.n) ? it.n[1] : it.n)));
    const berryPick = best(PICKABLE[B.HONEYBERRY_BUSH].drops, 'honeyberries') * berries.satiation;
    expect(berryPick).toBe(16);
    for (const [id, raw] of [[B.HONEYCAP_MUSHROOM, 'honeycap'], [B.ONION_PLANT, 'wild_onion'], [B.CARROT_PLANT, 'wild_carrot'],
      [B.HAZEL_THICKET, 'hazelnuts'], [B.CRAB_APPLE_BUSH, 'crab_apple']]) {
      const n = best(PICKABLE[id].drops, raw);
      expect(n * food(raw).satiation, raw).toBeLessThan(berryPick * 0.6);
      expect(n * food(COOKED[raw]).satiation, raw).toBeLessThanOrEqual(berryPick);
    }
    // only the berry is food AND drink among the bush crops; the crab apple is the sour, wet one
    expect(food('crab_apple').hydration).toBeGreaterThan(berries.hydration);
    expect(food('crab_apple').satiation + food('crab_apple').hydration).toBeLessThan(berries.satiation + berries.hydration);
    // hazelnuts keep; raw mushrooms and crab apples go bad
    expect([food('hazelnuts').spoilS, food('roasted_hazelnuts').spoilS]).toEqual([undefined, undefined]);
    expect([food('honeycap').spoilS, food('frecklecap').spoilS, food('crab_apple').spoilS]).toEqual([1500, 1500, 2400]);
  });

  it('the two mushrooms are the same food in every number but one: the Frecklecap always poisons, roasted or not', () => {
    for (const [good, bad] of [['honeycap', 'frecklecap'], ['roasted_honeycap', 'roasted_frecklecap']]) {
      expect({ ...food(bad), sick: 0 }).toEqual(food(good));
      expect(food(bad).sick).toBe(1);
      expect([ITEMS[good].stack, ITEMS[bad].stack]).toEqual([16, 16]);
    }
  });

  it('the Healwort is medicine, not food: no Nourishment, bitter, and it cures; its tea cures and is a safe drink', () => {
    expect(food('healwort')).toEqual({ satiation: 0, hydration: -2, sick: 0, useS: 1.2, cures: true });
    expect(food('pot_healwort_tea')).toEqual({ satiation: 0, hydration: 30, sick: 0, useS: 1.0, returns: 'clay_pot', cures: true });
    expect(food('pot_healwort_tea').hydration).toBe(food('pot_boiled').hydration);
    expect(ITEM_KEYS.filter((k) => ITEMS[k].food?.cures)).toEqual(['healwort', 'pot_healwort_tea']);
    const tea = RECIPES.find((r) => r.id === 'pot_healwort_tea');
    expect(tea).toMatchObject({ station: 'hand', inputs: [{ k: 'healwort', n: 1 }, { k: 'pot_boiled', n: 1 }],
      outputs: [{ k: 'pot_healwort_tea', n: 1 }], tools: [], seconds: 2 });
  });

  it('the icons keep the mushrooms\' signs: freckles only on the Frecklecap, raw and roasted; a fat stem only on the Honeycap', () => {
    const freckles = (k, hex) => countWhere(paintItem(k), isHex(hex));
    expect(freckles('frecklecap', FRECKLE)).toBe(7);
    expect(freckles('honeycap', FRECKLE)).toBe(0);
    expect(freckles('roasted_frecklecap', 0xf0dcae)).toBeGreaterThanOrEqual(5); // browned, its freckles still pale
    expect(freckles('roasted_honeycap', 0xf0dcae)).toBe(0);
    // the stem (row 11 of the icon, with its dark rim either side): 6 + 2 px against 2 + 2
    const stem = (k) => mask(paintItem(k)).slice(11 * 16, 12 * 16).filter(Boolean).length;
    expect([stem('honeycap'), stem('frecklecap')]).toEqual([8, 4]);
    expect([stem('roasted_honeycap'), stem('roasted_frecklecap')]).toEqual([8, 4]);
    // violet marks the cure: on the Healwort sprig and afloat in the tea
    expect(countWhere(paintItem('healwort'), violet)).toBeGreaterThanOrEqual(5);
    expect(countWhere(paintItem('pot_healwort_tea'), violet)).toBe(1);
    expect(countWhere(paintItem('pot_boiled'), violet)).toBe(0);
  });
});

describe('gathering (harvest.js)', () => {
  it('R picks all seven; mushrooms and roots come away whole, the others stay as their picked variant', () => {
    const rows = [
      [B.HONEYCAP_MUSHROOM, B.AIR, 'honeycap', [1, 2]], [B.FRECKLECAP_MUSHROOM, B.AIR, 'frecklecap', [1, 2]],
      [B.ONION_PLANT, B.AIR, 'wild_onion', [1, 2]], [B.CARROT_PLANT, B.AIR, 'wild_carrot', [1, 1]],
      [B.HAZEL_THICKET, B.HAZEL_THICKET_BARE, 'hazelnuts', [1, 3]], [B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE, 'crab_apple', [2, 3]],
      [B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE, 'healwort', [1, 1]],
    ];
    // §80: a ripe onion, carrot or Healwort also gives its seed, on a roll of its own after the crop's
    const SEED = { [B.ONION_PLANT]: ['onion_seeds', 2], [B.CARROT_PLANT]: ['carrot_seeds', 2], [B.HEALWORT_PLANT]: ['healwort_seeds', 1] };
    for (const [id, to, key, [lo, hi]] of rows) {
      expect(isPickable(id), key).toBe(true);
      const seed = SEED[id];
      // every roll 0: the fewest of the crop, and the seed's chance comes up (with the fewest seeds)
      expect(pick(id, {}, seq(0)), key).toEqual({ to, drops: seed ? [{ k: key, n: lo }, { k: seed[0], n: 1 }] : [{ k: key, n: lo }] });
      // every roll 0.999: the most of the crop, and no seed
      expect(pick(id, {}, seq(0.999)), key).toEqual({ to, drops: [{ k: key, n: hi }] });
      // the seed's chance comes up and its count rolls high: 1–2 seeds of a root, one of the Healwort
      if (seed) expect(asMap(pick(id, {}, seq(...(lo === hi ? [] : [0.999]), 0, 0.999)).drops), key).toEqual({ [key]: hi, [seed[0]]: seed[1] });
      expect(handGatherHint(id), key).toBeNull(); // R picks it: the hint is main's "… · R: pick"
    }
    expect([SEED_DROPS.carrot, SEED_DROPS.onion, SEED_DROPS.healwort]).toEqual([
      { k: 'carrot_seeds', n: [1, 2], p: 0.5 }, { k: 'onion_seeds', n: [1, 2], p: 0.5 }, { k: 'healwort_seeds', n: 1, p: 0.35 },
    ]);
    // the picked variants give nothing more until they regrow
    for (const id of [B.HAZEL_THICKET_BARE, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT_BARE]) {
      expect(isPickable(id)).toBe(false);
      expect(pick(id, {}, seq(0))).toBeNull();
    }
    // both mushrooms give the same count: nothing but their look tells them apart in the hand either
    expect(PICKABLE[B.HONEYCAP_MUSHROOM].drops[0][0].items[0].n).toEqual(PICKABLE[B.FRECKLECAP_MUSHROOM].drops[0][0].items[0].n);
  });

  it('breaking by hand gives what a pick gives and destroys the plant; a shovel digs more roots and lifts the plants whole', () => {
    // (the seeds of §80 are left out here: their roll is tested below)
    const crop = (stacks) => asMap(stacks.filter((s) => !/_seeds$/.test(s.k)));
    const hand = (id, r = 0) => crop(rollDrops(id, null, {}, seq(r)));
    const dug = (id, r = 0) => crop(rollDrops(id, SHOVEL, {}, seq(r)));
    expect(hand(B.HONEYCAP_MUSHROOM)).toEqual({ honeycap: 1 });
    expect(dug(B.FRECKLECAP_MUSHROOM, 0.999)).toEqual({ frecklecap: 2 }); // a mushroom is not transplanted
    expect([hand(B.ONION_PLANT), hand(B.ONION_PLANT, 0.999)]).toEqual([{ wild_onion: 1 }, { wild_onion: 2 }]);
    expect([dug(B.ONION_PLANT), dug(B.ONION_PLANT, 0.999)]).toEqual([{ wild_onion: 2 }, { wild_onion: 3 }]);
    expect([hand(B.CARROT_PLANT), dug(B.CARROT_PLANT), dug(B.CARROT_PLANT, 0.999)]).toEqual([{ wild_carrot: 1 }, { wild_carrot: 1 }, { wild_carrot: 2 }]);
    expect(hand(B.HAZEL_THICKET)).toEqual({ hazelnuts: 1, stick: 2 });
    expect(dug(B.HAZEL_THICKET, 0.999)).toEqual({ hazel_thicket: 1, hazelnuts: 3, stick: 3 });
    expect(hand(B.HAZEL_THICKET_BARE)).toEqual({ stick: 2 });
    expect(dug(B.HAZEL_THICKET_BARE)).toEqual({ hazel_thicket: 1, stick: 2 });
    expect(hand(B.CRAB_APPLE_BUSH)).toEqual({ crab_apple: 2, stick: 1 });
    expect(dug(B.CRAB_APPLE_BUSH_BARE, 0.999)).toEqual({ crab_apple_bush: 1, stick: 2 });
    // the Healwort: pulled up by hand it is one leaf and gone for good; cut down, a hand gets nothing at all
    expect(hand(B.HEALWORT_PLANT)).toEqual({ healwort: 1 });
    expect(hand(B.HEALWORT_PLANT_BARE)).toEqual({});
    expect(dug(B.HEALWORT_PLANT)).toEqual({ healwort_plant: 1, healwort: 1 });
    expect(dug(B.HEALWORT_PLANT_BARE)).toEqual({ healwort_plant: 1 });
    // §80: broken ripe, by hand or with a shovel, the three seed plants give their seed as a pick does
    const all = (id, tool) => asMap(rollDrops(id, tool, {}, seq(0)));
    expect(all(B.ONION_PLANT, null)).toEqual({ wild_onion: 1, onion_seeds: 1 });
    expect(all(B.CARROT_PLANT, SHOVEL)).toEqual({ wild_carrot: 1, carrot_seeds: 1 });
    expect(all(B.HEALWORT_PLANT, null)).toEqual({ healwort: 1, healwort_seeds: 1 });
    expect(all(B.HEALWORT_PLANT, SHOVEL)).toEqual({ healwort_plant: 1, healwort: 1, healwort_seeds: 1 });
    expect(all(B.HEALWORT_PLANT_BARE, SHOVEL)).toEqual({ healwort_plant: 1 }); // a cut one has no seed left
    // quick to break, a shovel quicker
    for (const id of PLANT_BLOCK_IDS) {
      expect(breakSeconds(id, null), BLOCKS[id].name).toBeLessThanOrEqual(0.6);
      expect(breakSeconds(id, SHOVEL), BLOCKS[id].name).toBeLessThanOrEqual(breakSeconds(id, null));
    }
  });

  it('regrowth: the picked thicket, bush and Healwort are tracked and come back; a pulled mushroom or root does not', () => {
    expect(ripeOf(B.HAZEL_THICKET_BARE)).toBe(B.HAZEL_THICKET);
    expect(ripeOf(B.CRAB_APPLE_BUSH_BARE)).toBe(B.CRAB_APPLE_BUSH);
    expect(ripeOf(B.HEALWORT_PLANT_BARE)).toBe(B.HEALWORT_PLANT);
    expect(Object.keys(RIPE_OF).map(Number)).toEqual([B.HONEYBERRY_BUSH_BARE, B.PRICKLY_PEAR_BARE, B.HAZEL_THICKET_BARE, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT_BARE,
      B.NIGHTSHADE_BUSH_BARE]); // §81: the picked Nightshade regrows like the Honeyberry
    for (const [ripe, bare] of Object.entries(RIPE_OF).map(([b, r]) => [r, Number(b)])) expect(PICKABLE[ripe].to).toBe(bare);

    const g = new Regrowth();
    // what main does on a pick: the block change reaches Regrowth
    g.onBlockChange(3, 70, 4, B.HAZEL_THICKET, pick(B.HAZEL_THICKET, {}, seq(0)).to);
    g.onBlockChange(5, 70, 4, B.CRAB_APPLE_BUSH, pick(B.CRAB_APPLE_BUSH, {}, seq(0)).to);
    g.onBlockChange(7, 70, 4, B.HEALWORT_PLANT, pick(B.HEALWORT_PLANT, {}, seq(0)).to);
    g.onBlockChange(9, 70, 4, B.HONEYCAP_MUSHROOM, pick(B.HONEYCAP_MUSHROOM, {}, seq(0)).to);
    g.onBlockChange(11, 70, 4, B.ONION_PLANT, pick(B.ONION_PLANT, {}, seq(0)).to);
    expect(g.size).toBe(3);
    expect([g.has(3, 70, 4), g.has(5, 70, 4), g.has(7, 70, 4), g.has(9, 70, 4), g.has(11, 70, 4)]).toEqual([true, true, true, false, false]);
    // nothing regrows while the roll fails or the chunk is away
    expect(g.step(1, () => 0.999, () => true)).toEqual([]);
    expect(g.step(1, () => 0, () => false)).toEqual([]);
    // then each comes back as its ripe block
    expect(g.step(1, () => 0, () => true)).toEqual([
      { q: 3, y: 70, r: 4, id: B.HAZEL_THICKET }, { q: 5, y: 70, r: 4, id: B.CRAB_APPLE_BUSH }, { q: 7, y: 70, r: 4, id: B.HEALWORT_PLANT },
    ]);
    expect(g.size).toBe(0);
    // a Healwort that was pulled up after it was cut is forgotten
    g.onBlockChange(7, 70, 4, B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE);
    g.onBlockChange(7, 70, 4, B.HEALWORT_PLANT_BARE, B.AIR);
    expect(g.size).toBe(0);
    // a save's picked plants are found again in the edits (chunk "0,0": local index = (lq·16 + lr)·128 + y)
    const edits = new Map([['0,0', new Map([[(2 * 16 + 3) * 128 + 70, B.HEALWORT_PLANT_BARE], [(4 * 16 + 3) * 128 + 70, B.HAZEL_THICKET_BARE],
      [(6 * 16 + 3) * 128 + 70, B.HEALWORT_PLANT]])]]);
    g.loadFromEdits(edits);
    expect(g.size).toBe(2);
    expect(g.has(2, 70, 3) && g.has(4, 70, 3)).toBe(true);
  });
});

describe('roasting (cooking.js)', () => {
  const F = [0, 70, 0];
  const burn = (fs, seconds) => fs.step(seconds, () => true, () => true);

  it('the six new skewer foods roast in 12–20 s; nothing else of the new food goes on a fire', () => {
    expect(SKEWER_FOODS.slice(7, 13)).toEqual(['honeycap', 'frecklecap', 'wild_onion', 'wild_carrot', 'hazelnuts', 'crab_apple']);
    for (const k of SKEWER_FOODS.slice(7, 13)) {
      const tr = FIRE_TRANSFORMS[k];
      expect(tr.spot, k).toBe('skewer');
      expect(tr.seconds, k).toBeGreaterThanOrEqual(12);
      expect(tr.seconds, k).toBeLessThanOrEqual(20);
      expect(FIRE_TRANSFORMS[tr.to], `${tr.to} does not char`).toBeUndefined();
      const fs = new FireSlots();
      expect(fs.put(...F, k, 0), k).toBeGreaterThanOrEqual(0);
      burn(fs, tr.seconds - 0.5);
      expect(fs.view(...F).spots.find(Boolean).k, k).toBe(k);
      burn(fs, 1);
      expect(fs.takeReady(...F), k).toEqual([{ k: tr.to, n: 1 }]);
    }
    for (const k of ['roasted_honeycap', 'healwort', 'pot_healwort_tea', 'baked_crab_apple']) expect(isSkewerFood(k), k).toBe(false);
    const fs = new FireSlots();
    expect(fs.put(...F, 'pot_healwort_tea', 0)).toBe(-1); // the tea is steeped by hand, not boiled
  });

  it('fire never makes a Frecklecap safe: everything it turns into on a skewer still poisons, for as long as it is left on', () => {
    const fs = new FireSlots();
    fs.put(...F, 'frecklecap', 0);
    const seen = new Set(['frecklecap']);
    for (let t = 0; t < 600; t += 5) {
      burn(fs, 5);
      seen.add(fs.view(...F).spots.find(Boolean).k);
    }
    expect([...seen]).toEqual(['frecklecap', 'roasted_frecklecap']);
    for (const k of seen) expect(ITEMS[k].food.sick, k).toBe(1);
    // … while the Honeycap's chain is safe throughout
    for (let k = 'honeycap'; k; k = FIRE_TRANSFORMS[k]?.to) expect(ITEMS[k].food.sick, k).toBe(0);
  });
});

describe('poison and cure (vitals.js, survival.js)', () => {
  const food = (k) => ITEMS[k].food;
  /** A Survival in survival mode with a fresh body. */
  const started = () => {
    const s = new Survival();
    s.setMode('survival');
    return s;
  };

  it('a Frecklecap poisons every time, raw or roasted: the Poisoned status with its instant hit', () => {
    for (const k of ['frecklecap', 'roasted_frecklecap']) {
      for (const roll of [0, 0.5, 0.999999]) {
        const v = createVitals();
        const before = { ...v };
        expect(eatFood(v, food(k), () => roll), k).toEqual({ sick: true, cured: false });
        expect(v.sick).toBe(RATES.SICK_S);
        expect(statusOf(v).labels).toContain('Poisoned');
        expect(statusOf(v).regen).toBe(false);
        // it fed a little, and the poisoning took more: Nourishment and Hydration by POISON_HUNGER and POISON_THIRST
        expect(v.satiation).toBe(before.satiation + food(k).satiation + RATES.POISON_HUNGER);
        expect(v.hydration).toBe(before.hydration + food(k).hydration + RATES.POISON_THIRST);
      }
    }
    // a raw Frecklecap leaves you worse off than not eating; cases add up
    const v = createVitals();
    eatFood(v, food('frecklecap'), () => 0.5);
    expect(v.satiation).toBeLessThan(RATES.NEW_SATIATION);
    eatFood(v, food('frecklecap'), () => 0.5);
    eatFood(v, food('frecklecap'), () => 0.5);
    expect(v.sick).toBe(3 * RATES.SICK_S);
    // the Honeycap never does
    const w = createVitals();
    for (const roll of [0, 0.5]) expect(eatFood(w, food('honeycap'), () => roll)).toEqual({ sick: false, cured: false });
    expect(eatFood(w, food('roasted_honeycap'), () => 0)).toEqual({ sick: false, cured: false });
    expect(w.sick).toBe(0);
    expect(w.satiation).toBe(RATES.NEW_SATIATION + 3 + 3 + 7);
  });

  it('Healwort ends a poisoning at once and gives nothing back; on a healthy body it only tastes bitter', () => {
    const v = createVitals();
    eatFood(v, food('frecklecap'), () => 0);
    eatFood(v, food('pot_water'), () => 0); // raw water: a second case
    expect(v.sick).toBe(2 * RATES.SICK_S);
    const hydration = v.hydration;
    const satiation = v.satiation;
    expect(eatFood(v, food('healwort'), () => 0)).toEqual({ sick: false, cured: true });
    expect(v.sick).toBe(0);
    expect(statusOf(v).labels).not.toContain('Poisoned');
    expect(v.hydration).toBe(hydration - 2); // bitter; what the poison took stays taken
    expect(v.satiation).toBe(satiation);
    // cured means well: the next step deals no poison damage and the drains are back to normal
    v.health = 50;
    const step = stepVitals(v, 1, { activity: 1, felt: 20 });
    expect(step.damage.sick).toBeUndefined();
    // healthy: no cure to report
    expect(eatFood(v, food('healwort'), () => 0)).toEqual({ sick: false, cured: false });
    expect(cureSick(v)).toBe(false);
    // it is no vaccine: a Frecklecap after it poisons again
    expect(eatFood(v, food('frecklecap'), () => 0.9)).toEqual({ sick: true, cured: false });
    expect(cureSick(v)).toBe(true);
    expect(v.sick).toBe(0);
  });

  it('the tea cures, quenches like boiled water and gives the pot back', () => {
    const v = createVitals();
    v.hydration = 40;
    eatFood(v, food('roasted_frecklecap'), () => 0);
    expect(v.sick).toBeGreaterThan(0);
    const before = v.hydration;
    expect(eatFood(v, food('pot_healwort_tea'), () => 0)).toEqual({ sick: false, cured: true });
    expect(v.sick).toBe(0);
    expect(v.hydration).toBe(before + 30);
  });

  it('Survival.eat says what happened: poisoned by the Frecklecap, cured by the herb or the tea', () => {
    const s = started();
    expect(s.eat('honeycap', () => 0)).toEqual({ ok: true });
    expect(s.eat('frecklecap', () => 0.99)).toEqual({ ok: true, message: SICK_MESSAGE });
    expect(s.vitals.sick).toBeGreaterThan(0);
    expect(s.eat('healwort', () => 0.99)).toEqual({ ok: true, message: CURED_MESSAGE });
    expect(s.vitals.sick).toBe(0);
    expect(s.eat('healwort', () => 0.99)).toEqual({ ok: true }); // nothing to cure: no message
    s.eat('roasted_frecklecap', () => 0.99);
    expect(s.eat('pot_healwort_tea', () => 0.99)).toEqual({ ok: true, message: CURED_MESSAGE, returns: 'clay_pot' });
    expect(s.vitals.sick).toBe(0);
    expect(s.eat('pot_healwort_tea', () => 0.99)).toEqual({ ok: true, returns: 'clay_pot' });
    expect(CURED_MESSAGE).toMatch(/no longer poisoned/);
  });
});
