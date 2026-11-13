// Tests for farming (CONTRACTS §80): the farm blocks 133–150 with their two tiles and two models, the three seeds, what
// can be planted and on which ground, what makes a planted cell watered and open to the sky, the hints, the Growth
// tracker, planting with R (survivalControl.interactKind) and the once-a-second work as main wires it (farmSecondOn).
// Plants that spread on their own are spread.test.js's business. Pure modules and main's exported helper only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORLD_HEIGHT, DAY_LENGTH_SECONDS, REGROW_MEAN_S } from '../../src/config.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, CROP_ROWS, FARM_IDS, PICKER_ORDER, LAYER_CUTOUT, getFaceTile, getBlockShape,
  isFarmBlock, isPlant, isPopOff, isFallThrough, isReplaceable, isTargetable, isBreakable,
} from '../../src/blocks.js';
import { FACE_TOP } from '../../src/hex.js';
import { paintTile, TILE_NAMES } from '../../src/tiles.js';
import { ITEMS, getItem, itemForBlock, itemName, isItemKey } from '../../src/items.js';
import { hasItemArt, paintItem } from '../../src/itemArt.js';
import { PLANT_MODELS, PLANT_QUAD_STRIDE, plantModel, plantModelTile } from '../../src/plantModels.js';
import {
  BLOCK_RULES, PICKABLE, Regrowth, ripeOf, rollDrops, pick, breakSeconds, isPickable, handGatherHint, harvestHint,
} from '../../src/harvest.js';
import { popOffEffect } from '../../src/fallingblocks.js';
import { Pack } from '../../src/inventory.js';
import { interactKind, useActionOf, placeRefusal, HINT } from '../../src/survivalControl.js';
import {
  CROPS, PLANTABLE, FARM_WATER_REACH, REED_WATER_REACH, SPROUT_MEAN_S, SEED_TAKES, GROW_MEAN_S, SEED_BACK_P, FAIL_NOTICE_CELLS,
  MAX_GROWTH_TRACKED, SOIL_EARTH, SOIL_SAND, SOIL_SHORE, cropOf, cropOfItem, cropOfBlock, isPlanted, isSprout, soilWords, hasSky,
  waterNear, cropState, plantAt, wrongGroundHint, farmHint, failLine, Growth,
} from '../../src/farming.js';
import { Spread } from '../../src/spread.js';
import { farmSecondOn, FARM_STEP_MAX_S } from '../../src/main.js';
import { installDebugHandle } from '../../src/diagnostics.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { mulberry32 } from '../../src/noise.js';
import { makeFakeWorld } from '../helpers/fixtures.js';

const B = BLOCK;
const T = TILE;
/** The ground of the test worlds: grass up to y = G, so a crop stands in the cell at y = G + 1. */
const G = 10;
const Y = G + 1;
/** A `random` that returns the listed values in turn, then the last one for ever; `.calls` counts the draws. */
function seq(...vals) {
  let i = 0;
  const f = () => {
    f.calls++;
    return vals[Math.min(i++, vals.length - 1)];
  };
  f.calls = 0;
  return f;
}
const loaded = () => true;
/** A flat world of `groundId` with World's setBlock / edits surface (fixtures.makeFakeWorld). */
const flat = (groundId = B.GRASS_BLOCK) => makeFakeWorld({ groundY: G, groundId });
/** The nine kinds, in block-id order, as the brief's table has them. */
const TABLE = [
  ['carrot', 'Wild Carrot', ['carrot_seeds'], B.CARROT_PLANT, [B.GRASS_BLOCK, B.DIRT]],
  ['onion', 'Wild Onion', ['onion_seeds', 'wild_onion'], B.ONION_PLANT, [B.GRASS_BLOCK, B.DIRT]],
  ['tuber', 'Wild Tuber', ['wild_tuber'], B.TUBER_PLANT, [B.GRASS_BLOCK, B.DIRT]],
  ['honeyberry', 'Honeyberry Bush', ['honeyberries'], B.HONEYBERRY_BUSH_BARE, [B.GRASS_BLOCK, B.DIRT]],
  ['hazel', 'Hazel Thicket', ['hazelnuts'], B.HAZEL_THICKET_BARE, [B.GRASS_BLOCK, B.DIRT]],
  ['crab_apple', 'Crab Apple Bush', ['crab_apple'], B.CRAB_APPLE_BUSH_BARE, [B.GRASS_BLOCK, B.DIRT]],
  ['healwort', 'Healwort', ['healwort_seeds'], B.HEALWORT_PLANT_BARE, [B.GRASS_BLOCK, B.DIRT]],
  ['prickly_pear', 'Prickly Pear', ['cactus_fruit', 'unpeeled_cactus_fruit'], B.PRICKLY_PEAR_BARE, [B.SAND, B.RED_SAND]],
  ['cattails', 'Cattails', ['cattail_root'], B.CATTAILS, [B.GRASS_BLOCK, B.DIRT, B.SAND]],
];
/** @returns {[number, number, number, number][]} the 256 pixels of a 16×16 RGBA buffer, row by row */
function pixels(px) {
  const out = [];
  for (let i = 0; i < 1024; i += 4) out.push([px[i], px[i + 1], px[i + 2], px[i + 3]]);
  return out;
}
const at = (px, x, y) => pixels(px)[y * 16 + x];
const green = ([r, g, b, a]) => a === 255 && g > r + 30 && g > b + 30;

// ---------------------------------------------------------------------------------------------------------------------

describe('the farm blocks 133–150 (blocks.js)', () => {
  it('nine planted blocks then nine sprouts, in the kind order, named after the plant each grows into', () => {
    expect(BLOCK_COUNT).toBe(173); // §85: the homestead blocks at 163–172; §81: the eight plants that are not food follow at 151–158; §83: the low and shallow water at 159–162
    expect(BLOCKS).toHaveLength(173);
    expect(CROP_ROWS.map((row) => row[1])).toEqual(TABLE.map((row) => row[0]));
    expect([...FARM_IDS]).toEqual(Array.from({ length: 18 }, (_, i) => 133 + i));
    TABLE.forEach(([key, label, , grown], i) => {
      const planted = BLOCKS[133 + i];
      const sprout = BLOCKS[142 + i];
      expect([planted.id, planted.name, planted.displayName], key).toEqual([133 + i, `planted_${key}`, `Planted ${label}`]);
      expect([sprout.id, sprout.name, sprout.displayName], key).toEqual([142 + i, `${key}_sprout`, `${label} Sprout`]);
      expect(B[`PLANTED_${key.toUpperCase()}`], key).toBe(133 + i);
      expect(B[`${key.toUpperCase()}_SPROUT`], key).toBe(142 + i); // a BLOCK key is its block's name in capitals (wave0)
      // the crop's name is the display name of its plant (the ripe one), less a closing " Plant"
      const ripe = ripeOf(grown) >= 0 ? ripeOf(grown) : grown;
      expect(BLOCKS[ripe].displayName.replace(/ Plant$/, ''), key).toBe(label);
    });
    expect(BLOCKS[B.PLANTED_CARROT].displayName).toBe('Planted Wild Carrot');
    expect(BLOCKS[B.CARROT_SPROUT].displayName).toBe('Wild Carrot Sprout');
    expect(BLOCKS[B.CATTAILS_SPROUT].id).toBe(150);
  });

  it('PLANT flags, a 3D model, a flat icon, never placed by hand, the sound of grass; one tile for all nine of each', () => {
    expect([T.SEEDBED, T.SPROUT]).toEqual([205, 206]);
    expect(TILE_IDS).toHaveLength(193); // + the seven tiles of §81 (218–224); + the ten of §85
    expect([TILE_NAMES[205], TILE_NAMES[206]]).toEqual(['seedbed', 'sprout']);
    for (const id of FARM_IDS) {
      const d = BLOCKS[id];
      expect([d.solid, d.opaque, d.layer, d.cullSame, d.meshed, d.icon, d.shape], d.name).toEqual([false, false, LAYER_CUTOUT, false, true, 'flat', 'model']);
      expect([d.placeable, d.soundGroup, d.liquid, d.gravity], d.name).toEqual([false, 'grass', false, false]);
      expect(getBlockShape(id), d.name).toBe('model');
      for (let f = 0; f < 8; f++) expect(getFaceTile(id, f), d.name).toBe(id < B.CARROT_SPROUT ? T.SEEDBED : T.SPROUT);
      // walk-through, yet never replaceable or fall-through; it can be aimed at and broken; it pops off like a plant
      expect(isReplaceable(id) || isFallThrough(id), d.name).toBe(false);
      expect(isTargetable(id) && isBreakable(id), d.name).toBe(true);
      expect(isFarmBlock(id) && isPopOff(id), d.name).toBe(true);
      expect(isPlant(id), d.name).toBe(false); // not a wild plant: nothing generates it and R does not pick it
      expect(isPickable(id) || Object.hasOwn(PICKABLE, id), d.name).toBe(false);
      expect(PICKER_ORDER.includes(id), d.name).toBe(false);
      expect(itemForBlock(id), d.name).toBeNull();
      expect(popOffEffect(id), d.name).toMatchObject({ kind: 'dust', count: 4, sound: 'break:grass' });
      expect(placeRefusal(() => B.AIR, id, 0, 5, 0), d.name).toBe(HINT.needsGround); // it needs soil under it
      expect(handGatherHint(id) ?? harvestHint(id), d.name).toBeNull();
    }
    for (const id of [B.AIR, B.CARROT_PLANT, B.GROUND_NEST_EMPTY, 151, 255, -1, NaN, undefined]) expect(isFarmBlock(id), String(id)).toBe(false);
  });

  it('dug out by hand, a planted seed comes back half the time; a sprout gives nothing', () => {
    expect(SEED_BACK_P).toBe(0.5);
    for (const crop of CROPS) {
      expect(BLOCK_RULES[crop.planted], crop.key).toMatchObject({ h: 0.3, tool: null, tier: 0 });
      expect(BLOCK_RULES[crop.sprout], crop.key).toMatchObject({ h: 0.3, tool: null, tier: 0, drops: [] });
      expect(rollDrops(crop.planted, null, {}, seq(SEED_BACK_P - 0.001)), crop.key).toEqual([{ k: crop.back, n: 1 }]);
      expect(rollDrops(crop.planted, null, {}, seq(SEED_BACK_P)), crop.key).toEqual([]);
      expect(rollDrops(crop.sprout, null, {}, seq(0)), crop.key).toEqual([]);
      expect(breakSeconds(crop.planted, null), crop.key).toBe(0.3);
      expect(crop.from, crop.key).toContain(crop.back);
    }
    // the seed that went in comes back, but a planted Cactus Fruit comes back unpeeled, whichever went in
    expect(CROPS.map((c) => c.back)).toEqual(['carrot_seeds', 'onion_seeds', 'wild_tuber', 'honeyberries', 'hazelnuts', 'crab_apple',
      'healwort_seeds', 'unpeeled_cactus_fruit', 'cattail_root']);
  });
});

describe('the two farm tiles 205–206 (tiles.js) and their models (plantModels.js)', () => {
  const seedbed = paintTile(T.SEEDBED);
  const sprout = paintTile(T.SPROUT);

  it('both are cut-outs standing on the same mound of dark earth: alpha 0 or 255, clear pixels RGB 0', () => {
    for (const px of [seedbed, sprout]) {
      for (const [r, g, b, a] of pixels(px)) {
        expect(a === 0 || a === 255).toBe(true);
        if (a === 0) expect(r + g + b).toBe(0);
      }
      // the mound: the bottom three rows from x 1 to x 14, earth-brown (red above green above blue), darker than the grass
      for (let y = 13; y <= 15; y++) {
        for (let x = 1; x <= 14; x++) {
          const [r, g, b, a] = at(px, x, y);
          expect(a, `${x},${y}`).toBe(255);
          expect(r > g && g > b && r < 150, `${x},${y}`).toBe(true);
        }
        expect(at(px, 0, y)[3] + at(px, 15, y)[3]).toBe(0);
      }
      expect(pixels(px).slice(0, 32).every((p) => p[3] === 0)).toBe(true); // nothing in the top two rows
    }
    // the very same earth under both, pixel for pixel
    expect(Buffer.from(seedbed.slice(10 * 64)).equals(Buffer.from(sprout.slice(10 * 64)))).toBe(true);
  });

  it('the seedbed has a marker twig with a pale rag and nothing green; the sprout has a green stem and two leaves', () => {
    expect(pixels(seedbed).some(green)).toBe(false);
    for (let y = 3; y <= 9; y++) expect(at(seedbed, 7, y)[3] + at(seedbed, 8, y)[3], `twig row ${y}`).toBe(510);
    const rag = at(seedbed, 10, 4);
    expect(rag[0] > 200 && rag[1] > 180).toBe(true);
    const leaves = pixels(sprout).filter(green).length;
    expect(leaves).toBeGreaterThanOrEqual(30);
    expect(green(at(sprout, 3, 4)) && green(at(sprout, 12, 3)) && green(at(sprout, 7, 7))).toBe(true); // left leaf, right leaf, stem
    expect(pixels(sprout).filter((p, i) => i < 5 * 16 && p[3] === 255).every(green)).toBe(true); // all that stands above row 5 is leaf
  });

  it('all nine planted blocks are the one seedbed and all nine sprouts the one seedling; the two share their mound', () => {
    const bed = /** @type {Float32Array} */ (plantModel(B.PLANTED_CARROT));
    const shoot = /** @type {Float32Array} */ (plantModel(B.CARROT_SPROUT));
    for (const crop of CROPS) {
      expect(Buffer.from(plantModel(crop.planted).buffer).equals(Buffer.from(bed.buffer)), crop.key).toBe(true);
      expect(Buffer.from(plantModel(crop.sprout).buffer).equals(Buffer.from(shoot.buffer)), crop.key).toBe(true);
      expect(PLANT_MODELS[crop.planted].parts).toBe(PLANT_MODELS[B.PLANTED_CARROT].parts);
      expect(PLANT_MODELS[crop.sprout].parts).toBe(PLANT_MODELS[B.CARROT_SPROUT].parts);
      expect(plantModelTile(crop.planted) ?? plantModelTile(crop.sprout)).toBeNull(); // each is cut from its own tile
    }
    const quads = (m) => m.length / PLANT_QUAD_STRIDE;
    expect([quads(bed), quads(shoot)]).toEqual([21, 27]);
    // the mound: two steps, ten quads, the same in both, 0.625 m across and 3 texels high
    const mound = 10 * PLANT_QUAD_STRIDE;
    expect(Buffer.from(bed.slice(0, mound).buffer).equals(Buffer.from(shoot.slice(0, mound).buffer))).toBe(true);
    const ys = (m, from, to) => {
      const out = [];
      for (let o = from; o < to; o += PLANT_QUAD_STRIDE) for (let v = 0; v < 4; v++) out.push(m[o + v * 5 + 1]);
      return out;
    };
    expect(Math.max(...ys(bed, 0, mound))).toBeCloseTo(3 / 16, 6);
    // the twig stands well above the mound; the seedling's leaves lift higher than its stem's top
    expect(Math.max(...ys(bed, mound, bed.length))).toBeGreaterThan(0.5);
    expect(Math.max(...ys(shoot, mound, shoot.length))).toBeGreaterThan(7 / 16);
    // every face of both is cut from solid texels (the generic limit in plantModels.test.js is 30 %)
    for (const [m, tile] of [[bed, seedbed], [shoot, sprout]]) {
      for (let o = 0; o < m.length; o += PLANT_QUAD_STRIDE) {
        const us = [0, 1, 2, 3].map((v) => m[o + v * 5 + 3]);
        const vs = [0, 1, 2, 3].map((v) => m[o + v * 5 + 4]);
        for (let y = Math.min(...vs); y < Math.max(...vs); y++) {
          for (let x = Math.min(...us); x < Math.max(...us); x++) expect(tile[(y * 16 + x) * 4 + 3], `texel ${x},${y}`).toBe(255);
        }
      }
    }
  });
});

describe('the seeds (items.js, itemArt.js, harvest.js)', () => {
  it('three materials that stack to 32, each with a picture of its own; they are no food and place nothing', () => {
    for (const [key, name] of [['carrot_seeds', 'Carrot Seeds'], ['onion_seeds', 'Onion Seeds'], ['healwort_seeds', 'Healwort Seeds']]) {
      expect(ITEMS[key], key).toMatchObject({ key, name, kind: 'material', stack: 32 });
      expect(hasItemArt(key), key).toBe(true);
      expect(useActionOf({ k: key, n: 1 }), key).toBeNull(); // the use button does nothing with a seed: R plants it
      expect(itemName(key, 1), key).toBe(name.replace(/s$/, ''));
    }
    const art = ['carrot_seeds', 'onion_seeds', 'healwort_seeds'].map((k) => Buffer.from(paintItem(k)).toString('base64'));
    expect(new Set(art).size).toBe(3);
  });

  it('a picked Wild Carrot or Wild Onion gives 1–2 seeds half the time, a cut Healwort one seed 35 % of the time', () => {
    const count = (id, key, random) => pick(id, {}, random).drops.find((s) => s.k === key)?.n;
    const random = mulberry32(7);
    for (const [id, key, p, max] of [[B.CARROT_PLANT, 'carrot_seeds', 0.5, 2], [B.ONION_PLANT, 'onion_seeds', 0.5, 2], [B.HEALWORT_PLANT, 'healwort_seeds', 0.35, 1]]) {
      const seen = [0, 0, 0];
      for (let i = 0; i < 4000; i++) seen[count(id, key, random) ?? 0]++;
      expect((4000 - seen[0]) / 4000, key).toBeGreaterThan(p - 0.03);
      expect((4000 - seen[0]) / 4000, key).toBeLessThan(p + 0.03);
      if (max === 2) expect(Math.abs(seen[1] - seen[2]), key).toBeLessThan(160); // one or two, evenly
      else expect(seen[2], key).toBe(0);
    }
    // nothing else gives a seed: not the mushrooms, not a picked bush, not a cut Healwort
    for (const id of [B.HONEYCAP_MUSHROOM, B.HAZEL_THICKET, B.HONEYBERRY_BUSH, B.HEALWORT_PLANT_BARE, B.TUBER_PLANT]) {
      expect(rollDrops(id, null, {}, () => 0).some((s) => /_seeds$/.test(s.k)), BLOCKS[id].name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('what can be planted (farming.js PLANTABLE, CROPS)', () => {
  it('the table: nine kinds in block-id order, what plants each, what it grows into, its soil', () => {
    expect(CROPS).toHaveLength(9);
    TABLE.forEach(([key, name, from, grown, soil], i) => {
      const c = CROPS[i];
      expect([c.key, c.index, c.name, c.planted, c.sprout, c.grown], key).toEqual([key, i, name, 133 + i, 142 + i, grown]);
      expect([...c.from], key).toEqual(from);
      expect([...c.soil], key).toEqual(soil);
      expect(c.reed, key).toBe(key === 'cattails');
      expect(cropOf(key)).toBe(c);
      expect(cropOfBlock(c.planted)).toBe(c);
      expect(cropOfBlock(c.sprout)).toBe(c);
      expect([isPlanted(c.planted), isSprout(c.planted), isPlanted(c.sprout), isSprout(c.sprout)], key).toEqual([true, false, false, true]);
      for (const k of from) {
        expect(isItemKey(k), k).toBe(true);
        expect(PLANTABLE[k], k).toBe(key);
        expect(cropOfItem(k), k).toBe(c);
      }
    });
    expect(PLANTABLE).toEqual({
      carrot_seeds: 'carrot', onion_seeds: 'onion', wild_onion: 'onion', wild_tuber: 'tuber', honeyberries: 'honeyberry', hazelnuts: 'hazel',
      crab_apple: 'crab_apple', healwort_seeds: 'healwort', cactus_fruit: 'prickly_pear', unpeeled_cactus_fruit: 'prickly_pear', cattail_root: 'cattails',
    });
    expect([SOIL_EARTH, SOIL_SAND, SOIL_SHORE].map((s) => [...s])).toEqual([[B.GRASS_BLOCK, B.DIRT], [B.SAND, B.RED_SAND], [B.GRASS_BLOCK, B.DIRT, B.SAND]]);
    expect(Object.isFrozen(CROPS) && Object.isFrozen(CROPS[0]) && Object.isFrozen(PLANTABLE) && Object.isFrozen(CROPS[0].from)).toBe(true);
  });

  it('a bush, a thicket, a Healwort and a prickly pear grow up PICKED, so Regrowth brings the first fruit; roots and reeds grow up whole', () => {
    const picked = CROPS.filter((c) => ripeOf(c.grown) >= 0).map((c) => c.key);
    expect(picked).toEqual(['honeyberry', 'hazel', 'crab_apple', 'healwort', 'prickly_pear']);
    const g = new Regrowth();
    for (const c of CROPS) g.onBlockChange(c.index, Y, 0, c.sprout, c.grown);
    expect(g.size).toBe(5);
    expect(REGROW_MEAN_S).toBe(2 * DAY_LENGTH_SECONDS);
  });

  it('mushrooms, block items and everything else plant nothing', () => {
    for (const k of ['honeycap', 'frecklecap', 'honeycap_mushroom', 'healwort', 'wild_carrot', 'acorns', 'pine_nuts', 'carrot_plant', 'hazel_thicket',
      'stick', 'dirt', '', 'constructor', '__proto__', null, undefined, 7]) {
      expect(cropOfItem(/** @type {*} */ (k)), String(k)).toBeNull();
    }
    for (const id of [B.AIR, B.CARROT_PLANT, B.HONEYCAP_MUSHROOM, 132, 151, -1, 1.5, NaN, null]) expect(cropOfBlock(/** @type {*} */ (id)), String(id)).toBeNull();
    expect(cropOf('mushroom') ?? cropOf('toString')).toBeNull();
  });
});

describe('the ground: plantAt and the wrong-ground hint', () => {
  it('each crop is planted on the top of its own soil with AIR above, and nowhere else', () => {
    const GROUNDS = [B.GRASS_BLOCK, B.DIRT, B.SAND, B.RED_SAND, B.STONE, B.GRAVEL, B.SNOWY_GRASS, B.CLAY, B.OAK_LEAVES];
    for (const crop of CROPS) {
      for (const key of crop.from) {
        for (const ground of GROUNDS) {
          const w = flat(ground);
          const p = plantAt(w.getBlock, key, 3, G, -2);
          if (crop.soil.includes(ground)) {
            expect(p, `${key} on ${BLOCKS[ground].name}`).toEqual({
              crop, block: crop.planted, cell: [3, Y, -2], hint: `${BLOCKS[ground].displayName} · R: plant ${itemName(key)}`,
            });
            expect(wrongGroundHint(w.getBlock, key, 3, G, -2)).toBeNull();
          } else {
            expect(p, `${key} on ${BLOCKS[ground].name}`).toBeNull();
            expect(wrongGroundHint(w.getBlock, key, 3, G, -2), `${key} on ${BLOCKS[ground].name}`).toMatch(/ grows? in /);
          }
        }
      }
    }
    expect(plantAt(flat().getBlock, 'carrot_seeds', 0, G, 0).hint).toBe('Grass Block · R: plant Carrot Seeds');
    expect(plantAt(flat(B.RED_SAND).getBlock, 'cactus_fruit', 0, G, 0).hint).toBe('Red Sand · R: plant Cactus Fruit');
  });

  it('the cell above the soil must be AIR: not water, a plant, a seedbed or a block', () => {
    for (const above of [B.WATER, B.TUSSOCK, B.PLANTED_CARROT, B.CARROT_SPROUT, B.STONE, B.OAK_LEAVES, B.LOOSE_STONES]) {
      const w = flat();
      w.put(0, Y, 0, above);
      expect(plantAt(w.getBlock, 'carrot_seeds', 0, G, 0), BLOCKS[above].name).toBeNull();
      expect(wrongGroundHint(w.getBlock, 'carrot_seeds', 0, G, 0), BLOCKS[above].name).toBeNull(); // the ground is right: no "grows in"
    }
    // nothing is planted on the world's last row, or with nothing in hand
    expect(plantAt(() => B.GRASS_BLOCK, 'carrot_seeds', 0, WORLD_HEIGHT - 1, 0)).toBeNull();
    expect(plantAt(flat().getBlock, null, 0, G, 0) ?? plantAt(flat().getBlock, 'stick', 0, G, 0)).toBeNull();
  });

  it('the wrong ground says what the item needs, with the verb its name takes', () => {
    const sand = flat(B.SAND).getBlock;
    const grass = flat().getBlock;
    const stone = flat(B.STONE).getBlock;
    expect(wrongGroundHint(sand, 'carrot_seeds', 0, G, 0)).toBe('Carrot Seeds grow in grass or dirt');
    expect(wrongGroundHint(stone, 'healwort_seeds', 0, G, 0)).toBe('Healwort Seeds grow in grass or dirt');
    expect(wrongGroundHint(stone, 'honeyberries', 0, G, 0)).toBe('Honeyberries grow in grass or dirt');
    expect(wrongGroundHint(sand, 'wild_tuber', 0, G, 0)).toBe('Wild Tuber grows in grass or dirt');
    expect(wrongGroundHint(grass, 'cactus_fruit', 0, G, 0)).toBe('Cactus Fruit grows in sand or red sand');
    expect(wrongGroundHint(grass, 'unpeeled_cactus_fruit', 0, G, 0)).toBe('Unpeeled Cactus Fruit grows in sand or red sand');
    expect(wrongGroundHint(stone, 'cattail_root', 0, G, 0)).toBe('Cattail Root grows in grass, dirt or sand');
    expect(wrongGroundHint(stone, 'stick', 0, G, 0) ?? wrongGroundHint(stone, null, 0, G, 0)).toBeNull();
    expect([soilWords(SOIL_EARTH), soilWords(SOIL_SAND), soilWords(SOIL_SHORE), soilWords([B.STONE]), soilWords([B.CLAY, B.GRAVEL])])
      .toEqual(['grass or dirt', 'sand or red sand', 'grass, dirt or sand', 'stone', 'clay or gravel']);
  });
});

describe('the sky and the water', () => {
  it('hasSky: no opaque block anywhere above; leaves, glass, water and plants let the light through', () => {
    const w = flat();
    expect(hasSky(w.getBlock, 0, Y, 0)).toBe(true);
    for (const id of [B.OAK_LEAVES, B.SPRUCE_LEAVES, B.GLASS, B.WATER, B.TUSSOCK, B.ICE, B.TORCH]) {
      w.put(0, Y + 3, 0, id);
      expect(hasSky(w.getBlock, 0, Y, 0), BLOCKS[id].name).toBe(true);
    }
    for (const id of [B.STONE, B.OAK_PLANKS, B.OAK_LOG, B.DIRT, B.WOOL_WHITE]) {
      for (const up of [1, 3, WORLD_HEIGHT - 1 - Y]) {
        const v = flat();
        v.put(0, Y + up, 0, id);
        expect(hasSky(v.getBlock, 0, Y, 0), `${BLOCKS[id].name} ${up} up`).toBe(false);
        expect(hasSky(v.getBlock, 1, Y, 0)).toBe(true); // only its own column counts
      }
    }
    // the cell itself and what is under it do not count; `top` bounds the look
    expect(hasSky(w.getBlock, 0, G - 3, 0)).toBe(false);
    expect(hasSky(w.getBlock, 0, G - 3, 0, G - 3)).toBe(true);
  });

  it('watered: fresh water within FARM_WATER_REACH cells, at the soil\'s level, one below or one above', () => {
    expect([FARM_WATER_REACH, REED_WATER_REACH]).toEqual([4, 1]);
    const carrot = cropOf('carrot');
    const state = (put) => {
      const w = flat();
      put(w);
      return cropState(w.getBlock, null, 0, Y, 0, carrot);
    };
    expect(state(() => {})).toEqual({ sky: true, watered: false, reed: true });
    // every cell at hex distance 4, at the soil's level
    for (const [dq, dr] of [[4, 0], [0, 4], [-4, 4], [-4, 0], [0, -4], [4, -4], [2, 2], [-1, -3], [3, -4]]) {
      expect(state((w) => w.put(dq, G, dr, B.WATER)).watered, `${dq},${dr}`).toBe(true);
    }
    for (const [dq, dr] of [[5, 0], [0, 5], [-5, 5], [3, 2], [-3, -2], [5, -5]]) expect(state((w) => w.put(dq, G, dr, B.WATER)).watered, `${dq},${dr}`).toBe(false);
    // the three levels: the soil's (G), one below (G − 1) and one above (the crop's own, G + 1); no other
    expect([G - 2, G - 1, G, G + 1, G + 2].map((y) => state((w) => w.put(2, y, 1, B.WATER)).watered)).toEqual([false, true, true, true, false]);
    // flowing and falling water count as water; ice and snow do not
    for (const id of [B.WATER_FLOW_1, B.WATER_FLOW_6, B.WATER_FALL, B.TAINTED_WATER]) expect(state((w) => w.put(1, G, 0, id)).watered).toBe(true);
    for (const id of [B.ICE, B.SNOW_BLOCK, B.GLASS]) expect(state((w) => w.put(1, G, 0, id)).watered).toBe(false);
  });

  it('only FRESH water waters: the quality is asked of every water cell found, as the drinking code judges it', () => {
    const carrot = cropOf('carrot');
    const w = flat();
    w.put(1, G, 0, B.TAINTED_WATER);
    w.put(-2, G, 1, B.WATER); // "salt" below
    const asked = [];
    const quality = (q, y, r) => {
      asked.push([q, y, r]);
      return w.getBlock(q, y, r) === B.TAINTED_WATER ? 'tainted' : q < 0 ? 'salt' : 'fresh';
    };
    expect(cropState(w.getBlock, quality, 0, Y, 0, carrot).watered).toBe(false);
    expect(asked.sort()).toEqual([[-2, G, 1], [1, G, 0]]);
    w.put(3, G - 1, 1, B.WATER_FLOW_3); // a channel of fresh water further off, within reach
    expect(cropState(w.getBlock, quality, 0, Y, 0, carrot).watered).toBe(true);
    // without the callback every water counts
    const v = flat();
    v.put(1, G, 0, B.TAINTED_WATER);
    expect(cropState(v.getBlock, null, 0, Y, 0, carrot).watered).toBe(true);
    expect(waterNear(v.getBlock, 0, Y, 0, 4, () => false)).toBe(false);
  });

  it('a reed needs water within one cell, of any kind; no other crop cares', () => {
    const reed = cropOf('cattails');
    const w = flat();
    w.put(2, G, 0, B.WATER);
    expect(cropState(w.getBlock, null, 0, Y, 0, reed)).toEqual({ sky: true, watered: true, reed: false });
    expect(cropState(w.getBlock, null, 0, Y, 0, cropOf('onion')).reed).toBe(true);
    w.put(0, G, 1, B.TAINTED_WATER);
    expect(cropState(w.getBlock, () => 'tainted', 0, Y, 0, reed)).toEqual({ sky: true, watered: false, reed: true });
    w.put(0, Y + 5, 0, B.STONE);
    expect(cropState(w.getBlock, null, 0, Y, 0, reed).sky).toBe(false);
  });
});

describe('the hints of a planted cell and a sprout', () => {
  it('watered; dry (a seed may not take, a sprout has taken); needs open sky; a cattail needs water beside it', () => {
    const wet = { sky: true, watered: true, reed: true };
    const dry = { sky: true, watered: false, reed: true };
    expect(farmHint(B.PLANTED_CARROT, wet)).toBe('Planted Wild Carrot · watered');
    expect(farmHint(B.PLANTED_CARROT, dry)).toBe('Planted Wild Carrot · dry: slow, and it may not take');
    expect(farmHint(B.PLANTED_CARROT, { ...wet, sky: false })).toBe('Planted Wild Carrot · needs open sky');
    expect(farmHint(B.CARROT_SPROUT, wet)).toBe('Wild Carrot Sprout · watered');
    expect(farmHint(B.CARROT_SPROUT, dry)).toBe('Wild Carrot Sprout · dry: slow');
    expect(farmHint(B.HAZEL_SPROUT, { ...dry, sky: false })).toBe('Hazel Thicket Sprout · needs open sky');
    expect(farmHint(B.PLANTED_CATTAILS, { sky: true, watered: true, reed: false })).toBe('Planted Cattails · needs water beside it');
    expect(farmHint(B.PLANTED_CATTAILS, { sky: false, watered: true, reed: false })).toBe('Planted Cattails · needs open sky');
    expect(farmHint(B.PLANTED_HONEYBERRY, wet)).toBe('Planted Honeyberry Bush · watered');
    for (const id of FARM_IDS) expect(farmHint(id, wet)).toBe(`${BLOCKS[id].displayName} · watered`);
    expect(farmHint(B.CARROT_PLANT, wet) ?? farmHint(B.AIR, wet)).toBeNull();
  });

  it('a seed that fails says so in one line', () => {
    expect(failLine(cropOf('carrot'))).toBe('A planted Wild Carrot did not take.');
    expect(failLine(cropOf('honeyberry'))).toBe('A planted Honeyberry Bush did not take.');
    expect(failLine(cropOf('cattails'))).toBe('A planted Cattail did not take.');
    expect(FAIL_NOTICE_CELLS).toBe(24);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('Growth: the tracker of planted cells and sprouts', () => {
  it('the constants: a day or three to sprout, two days or five to grow, four seeds in five take watered and a third dry', () => {
    expect(SPROUT_MEAN_S).toEqual({ watered: 1440, dry: 4320 });
    expect(GROW_MEAN_S).toEqual({ watered: 2880, dry: 7200 });
    expect(SEED_TAKES).toEqual({ watered: 0.8, dry: 0.35 });
    expect([SPROUT_MEAN_S.watered, SPROUT_MEAN_S.dry, GROW_MEAN_S.watered, GROW_MEAN_S.dry].map((s) => s / DAY_LENGTH_SECONDS)).toEqual([1, 3, 2, 5]);
    expect(MAX_GROWTH_TRACKED).toBe(4096);
  });

  it('tracks a cell by its block id from onBlockChange, follows it to its sprout, and forgets any other write', () => {
    const g = new Growth();
    g.onBlockChange(1, 60, -2, B.AIR, B.PLANTED_CARROT);
    g.onBlockChange(-4, 61, 7, B.AIR, B.PLANTED_HAZEL);
    g.onBlockChange(9, 9, 9, B.AIR, B.CARROT_PLANT); // a wild plant is not a crop
    expect(g.size).toBe(2);
    expect(g.has(1, 60, -2) && g.has(-4, 61, 7)).toBe(true);
    g.onBlockChange(1, 60, -2, B.PLANTED_CARROT, B.CARROT_SPROUT); // it sprouted: the same cell, the new id
    expect(g.size).toBe(2);
    expect(g.cells.get('1,60,-2')).toEqual({ q: 1, y: 60, r: -2, id: B.CARROT_SPROUT });
    g.onBlockChange(1, 60, -2, B.CARROT_SPROUT, B.CARROT_PLANT); // grown up
    g.onBlockChange(-4, 61, 7, B.PLANTED_HAZEL, B.AIR); // dug out, popped off or failed
    expect(g.size).toBe(0);
    expect(g.track(0, 0, 0, B.STONE) || g.track(0, 0, 0, B.CARROT_PLANT) || g.track(0, 0, 0, /** @type {*} */ ('133'))).toBe(false);
    expect(g.untrack(5, 5, 5)).toBe(false);
  });

  it('never tracks more than MAX_GROWTH_TRACKED cells', () => {
    const g = new Growth();
    for (let i = 0; i < MAX_GROWTH_TRACKED + 50; i++) g.onBlockChange(i, 60, 0, B.AIR, B.PLANTED_TUBER);
    expect(g.size).toBe(MAX_GROWTH_TRACKED);
    expect(g.has(MAX_GROWTH_TRACKED, 60, 0)).toBe(false);
    expect(g.track(0, 60, 0, B.TUBER_SPROUT)).toBe(true); // a known cell changes its id at the cap
    g.untrack(0, 60, 0);
    expect(g.track(MAX_GROWTH_TRACKED + 10, 60, 0, B.PLANTED_TUBER)).toBe(true);
  });

  it('loadFromEdits finds every farm cell of a save (negative coordinates too) and replaces the old set', () => {
    const edits = new Map();
    const put = (q, y, r, id) => {
      const cq = Math.floor(q / 16);
      const cr = Math.floor(r / 16);
      if (!edits.has(chunkKey(cq, cr))) edits.set(chunkKey(cq, cr), new Map());
      edits.get(chunkKey(cq, cr)).set(localIndex(q - cq * 16, y, r - cr * 16), id);
    };
    put(-5, 60, 20, B.PLANTED_CARROT);
    put(33, 70, -1, B.CATTAILS_SPROUT);
    put(2, 64, 2, B.PLANTED_CATTAILS);
    put(3, 64, 2, B.CARROT_PLANT);
    put(4, 64, 2, B.HAZEL_THICKET_BARE);
    put(5, 64, 2, B.AIR);
    edits.set('bad key', new Map([[0, B.PLANTED_ONION]]));
    const g = new Growth();
    g.track(100, 100, 100, B.PLANTED_ONION);
    g.loadFromEdits(edits);
    expect(g.size).toBe(3);
    expect([...g.cells.values()].sort((a, b) => a.id - b.id)).toEqual([
      { q: -5, y: 60, r: 20, id: B.PLANTED_CARROT }, { q: 2, y: 64, r: 2, id: B.PLANTED_CATTAILS }, { q: 33, y: 70, r: -1, id: B.CATTAILS_SPROUT },
    ]);
    g.clear();
    expect(g.size).toBe(0);
  });

  /** A Growth over a flat grass world with one crop cell at (0, Y, 0); `wet` puts fresh water two cells away. */
  function field(id, wet, put = () => {}) {
    const w = flat();
    if (wet) w.put(2, G, 0, B.WATER);
    w.put(0, Y, 0, id);
    put(w);
    const g = new Growth();
    g.track(0, Y, 0, id);
    return { w, g, step: (random, dt = 1) => g.step(dt, random, loaded, w.getBlock, () => 'fresh') };
  }
  const EPS = 1e-7;

  it('a planted seed: its moment comes with chance dt / 1440 watered, dt / 4320 dry', () => {
    // watered: just under 1 / 1440 is the moment (and the take roll follows); at 1 / 1440 it is not
    let f = field(B.PLANTED_CARROT, true);
    expect(f.step(seq(1 / 1440))).toEqual([]);
    expect(f.g.size).toBe(1);
    const ev = f.step(seq(1 / 1440 - EPS, 0));
    expect(ev).toEqual([{ q: 0, y: Y, r: 0, from: B.PLANTED_CARROT, to: B.CARROT_SPROUT, crop: cropOf('carrot'), took: true }]);
    expect(f.g.size).toBe(0); // main's write tracks the sprout again
    // dry: a roll between the two chances does nothing; under 1 / 4320 it is the moment
    f = field(B.PLANTED_CARROT, false);
    expect(f.step(seq(1 / 1440 - EPS, 0))).toEqual([]);
    expect(f.step(seq(1 / 4320, 0))).toEqual([]);
    expect(f.step(seq(1 / 4320 - EPS, 0)).map((e) => e.to)).toEqual([B.CARROT_SPROUT]);
  });

  it('the seed takes with chance 0.8 watered and 0.35 dry; one that does not becomes AIR', () => {
    const wet = (take) => field(B.PLANTED_ONION, true).step(seq(0, take));
    const dry = (take) => field(B.PLANTED_ONION, false).step(seq(0, take));
    expect(wet(0.8 - EPS)).toMatchObject([{ to: B.ONION_SPROUT, took: true }]);
    expect(wet(0.8)).toEqual([{ q: 0, y: Y, r: 0, from: B.PLANTED_ONION, to: B.AIR, crop: cropOf('onion'), took: false }]);
    expect(dry(0.35 - EPS)).toMatchObject([{ to: B.ONION_SPROUT, took: true }]);
    expect(dry(0.35)).toMatchObject([{ to: B.AIR, took: false }]);
    expect(dry(0.8 - EPS)).toMatchObject([{ to: B.AIR, took: false }]);
  });

  it('a sprout grows up with chance dt / 2880 watered, dt / 7200 dry, into its crop\'s grown block, with no second roll', () => {
    for (const crop of CROPS) {
      const reed = (w) => crop.reed && w.put(0, G, 1, B.WATER); // a cattail stands by water
      let f = field(crop.sprout, true, reed);
      expect(f.step(seq(1 / 2880)), crop.key).toEqual([]);
      const random = seq(1 / 2880 - EPS);
      expect(f.step(random), crop.key).toEqual([{ q: 0, y: Y, r: 0, from: crop.sprout, to: crop.grown, crop, took: true }]);
      expect(random.calls, crop.key).toBe(1);
      if (crop.reed) continue; // (a cattail by water is never dry unless that water is foul: tested with the reed)
      f = field(crop.sprout, false);
      expect(f.step(seq(1 / 2880 - EPS)), crop.key).toEqual([]);
      expect(f.step(seq(1 / 7200)), crop.key).toEqual([]);
      expect(f.step(seq(1 / 7200 - EPS)).map((e) => e.to), crop.key).toEqual([crop.grown]);
    }
  });

  it('without open sky nothing happens, however long: no event, and no take roll', () => {
    for (const id of [B.PLANTED_CARROT, B.CARROT_SPROUT]) {
      const f = field(id, true, (w) => w.put(0, Y + 4, 0, B.OAK_PLANKS));
      const random = seq(0);
      for (let i = 0; i < 50; i++) expect(f.step(random)).toEqual([]);
      expect(random.calls).toBe(50); // one roll a step, never the second
      expect(f.g.size).toBe(1);
      // leaves are no roof
      const open = field(id, true, (w) => w.put(0, Y + 4, 0, B.OAK_LEAVES));
      expect(open.step(seq(0))).toHaveLength(1);
    }
  });

  it('a cattail does nothing at all without water within one cell; beside foul water it grows at the dry pace', () => {
    for (const id of [B.PLANTED_CATTAILS, B.CATTAILS_SPROUT]) {
      // fresh water two cells away: watered, yet not a reed's place
      const far = field(id, true);
      for (let i = 0; i < 20; i++) expect(far.step(seq(0))).toEqual([]);
      const near = field(id, false, (w) => w.put(1, G, -1, B.WATER));
      expect(near.step(seq(0))).toHaveLength(1);
    }
    const w = flat();
    w.put(1, G, 0, B.TAINTED_WATER);
    w.put(0, Y, 0, B.CATTAILS_SPROUT);
    const g = new Growth();
    g.track(0, Y, 0, B.CATTAILS_SPROUT);
    const tainted = (random) => g.step(1, random, loaded, w.getBlock, () => 'tainted');
    expect(tainted(seq(1 / 2880 - EPS))).toEqual([]);
    expect(tainted(seq(1 / 7200 - EPS)).map((e) => e.to)).toEqual([B.CATTAILS]);
  });

  it('cells in unloaded chunks are frozen: no roll; every loaded cell draws exactly one, in tracking order', () => {
    const w = flat();
    const g = new Growth();
    for (const q of [0, 500, 3, 6]) {
      w.put(q, Y, 0, B.PLANTED_TUBER);
      g.track(q, Y, 0, B.PLANTED_TUBER);
    }
    const isLoaded = (q, r) => {
      expect(Number.isInteger(q) && Number.isInteger(r)).toBe(true);
      return q < 100;
    };
    // the rolls go to (0), (3), (6): only the second is below the dry chance, and it then takes
    const random = seq(0.5, 0, 0.1, 0.5);
    const out = g.step(1, random, isLoaded, w.getBlock, null);
    expect(out.map((e) => [e.q, e.to])).toEqual([[3, B.TUBER_SPROUT]]);
    expect(random.calls).toBe(4);
    expect(g.has(500, Y, 0) && g.has(0, Y, 0) && g.has(6, Y, 0) && !g.has(3, Y, 0)).toBe(true);
    const none = seq(0);
    for (let i = 0; i < 100; i++) expect(g.step(1, none, () => false, w.getBlock, null)).toEqual([]);
    expect(none.calls).toBe(0);
  });

  it('the world is looked at only when the roll is below the watered chance', () => {
    const f = field(B.PLANTED_CARROT, true);
    let reads = 0;
    const getBlock = (q, y, r) => {
      reads++;
      return f.w.getBlock(q, y, r);
    };
    for (let i = 0; i < 100; i++) f.g.step(1, seq(1 / 1440), loaded, getBlock, null);
    expect(reads).toBe(0);
    f.g.step(1, seq(1 / 1440 - EPS, 0), loaded, getBlock, null);
    expect(reads).toBeGreaterThan(0);
  });

  it('dt scales the chances (capped at 1); dt ≤ 0 does nothing', () => {
    const f = field(B.PLANTED_CARROT, true);
    expect(f.step(seq(0), 0)).toEqual([]);
    expect(f.step(seq(0), -1)).toEqual([]);
    expect(f.step(seq(60 / 1440 + 0.001, 0), 60)).toEqual([]);
    expect(f.step(seq(60 / 1440 - 0.001, 0), 60)).toHaveLength(1);
    const dry = field(B.CARROT_SPROUT, false);
    expect(dry.step(seq(60 / 7200 + 0.001), 60)).toEqual([]);
    expect(dry.step(seq(0.99999), 1e6)).toHaveLength(1);
  });

  it('by simulation: watered seeds sprout after a day on average and four in five take; dry ones after three days, a third', () => {
    for (const [wet, mean, takes] of [[true, SPROUT_MEAN_S.watered, SEED_TAKES.watered], [false, SPROUT_MEAN_S.dry, SEED_TAKES.dry]]) {
      const w = flat();
      const g = new Growth();
      const N = 600;
      for (let i = 0; i < N; i++) {
        const q = (i % 30) * 9;
        const r = Math.floor(i / 30) * 9;
        if (wet) w.put(q + 1, G, r, B.WATER);
        w.put(q, Y, r, B.PLANTED_CARROT);
        g.track(q, Y, r, B.PLANTED_CARROT);
      }
      const random = mulberry32(wet ? 11 : 12);
      let moments = 0;
      let took = 0;
      let sumT = 0;
      for (let s = 1; s <= 5 * mean && g.size > 0; s++) {
        for (const ev of g.step(1, random, loaded, w.getBlock, () => 'fresh')) {
          moments++;
          sumT += s;
          if (ev.took) took++;
        }
      }
      // after five means 99.3 % have had their moment, and those average 0.966 of the mean (the slowest few are cut off)
      expect(moments, `wet ${wet}`).toBeGreaterThan(N * 0.97);
      expect(sumT / moments / (0.966 * mean), `wet ${wet}`).toBeGreaterThan(0.9);
      expect(sumT / moments / (0.966 * mean), `wet ${wet}`).toBeLessThan(1.1);
      expect(took / moments, `wet ${wet}`).toBeGreaterThan(takes - 0.06);
      expect(took / moments, `wet ${wet}`).toBeLessThan(takes + 0.06);
    }
  });

  it('by simulation: watered sprouts are grown after two days on average, dry ones after five', () => {
    for (const [wet, mean] of [[true, GROW_MEAN_S.watered], [false, GROW_MEAN_S.dry]]) {
      const w = flat();
      const g = new Growth();
      const N = 500;
      for (let i = 0; i < N; i++) {
        const q = (i % 25) * 9;
        const r = Math.floor(i / 25) * 9;
        if (wet) w.put(q, G - 1, r + 3, B.WATER_FLOW_2);
        w.put(q, Y, r, B.HAZEL_SPROUT);
        g.track(q, Y, r, B.HAZEL_SPROUT);
      }
      const random = mulberry32(wet ? 21 : 22);
      let grown = 0;
      let sumT = 0;
      for (let s = 1; s <= 5 * mean && g.size > 0; s++) {
        for (const ev of g.step(1, random, loaded, w.getBlock, () => 'fresh')) {
          expect(ev.to).toBe(B.HAZEL_THICKET_BARE);
          grown++;
          sumT += s;
        }
      }
      expect(grown, `wet ${wet}`).toBeGreaterThan(N * 0.97);
      expect(sumT / grown / (0.966 * mean), `wet ${wet}`).toBeGreaterThan(0.9);
      expect(sumT / grown / (0.966 * mean), `wet ${wet}`).toBeLessThan(1.1);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('planting with R (survivalControl.interactKind)', () => {
  const hit = (blockId, face = FACE_TOP, q = 2, y = G, r = -1) => ({ q, y, r, blockId, face, distance: 2 });
  const ctx = (o) => ({ hit: null, waterHit: null, headInWater: false, selectedKey: null, pack: new Pack(), ...o });

  it('a plantable item selected, aiming at the top of soil that suits it with AIR above: `plant`', () => {
    const w = flat();
    const act = interactKind(ctx({ hit: hit(B.GRASS_BLOCK), selectedKey: 'carrot_seeds', getBlock: w.getBlock }));
    expect(act).toEqual({ kind: 'plant', q: 2, y: G, r: -1, key: 'carrot_seeds', block: B.PLANTED_CARROT, hint: 'Grass Block · R: plant Carrot Seeds' });
    // every plantable item, on its first soil
    for (const crop of CROPS) {
      for (const key of crop.from) {
        const v = flat(crop.soil[0]);
        expect(interactKind(ctx({ hit: hit(crop.soil[0]), selectedKey: key, getBlock: v.getBlock })), key).toMatchObject({ kind: 'plant', block: crop.planted });
      }
    }
  });

  it('not through a side or the underside, not on the wrong ground, not under something, not without the world', () => {
    const w = flat();
    for (const face of [0, 1, 2, 3, 4, 5, 7, -1]) {
      expect(interactKind(ctx({ hit: hit(B.GRASS_BLOCK, face), selectedKey: 'carrot_seeds', getBlock: w.getBlock })), `face ${face}`).toBeNull();
    }
    expect(interactKind(ctx({ hit: hit(B.SAND), selectedKey: 'carrot_seeds', getBlock: flat(B.SAND).getBlock }))).toBeNull();
    expect(interactKind(ctx({ hit: hit(B.GRASS_BLOCK), selectedKey: 'stick', getBlock: w.getBlock }))).toBeNull();
    expect(interactKind(ctx({ hit: hit(B.GRASS_BLOCK), selectedKey: null, getBlock: w.getBlock }))).toBeNull();
    expect(interactKind(ctx({ hit: hit(B.GRASS_BLOCK), selectedKey: 'carrot_seeds' }))).toBeNull(); // no getBlock: no planting step
    w.put(2, Y, -1, B.TUSSOCK);
    expect(interactKind(ctx({ hit: hit(B.GRASS_BLOCK), selectedKey: 'carrot_seeds', getBlock: w.getBlock }))).toBeNull();
  });

  it('it takes nothing from what R did before: a plant is still picked, a fire fed, water drunk; food is still eaten with the use button', () => {
    const w = flat();
    const base = { selectedKey: 'wild_onion', getBlock: w.getBlock };
    // a pickable plant under the crosshair keeps `R: pick`, whatever is in hand
    for (const id of [B.CARROT_PLANT, B.ONION_PLANT, B.HONEYBERRY_BUSH, B.LOOSE_STONES]) {
      expect(interactKind(ctx({ ...base, hit: hit(id, FACE_TOP, 2, Y, -1) })), BLOCKS[id].name).toEqual({ kind: 'pick', q: 2, y: Y, r: -1, id });
    }
    // a planted cell or a sprout has no R of its own: the seed in hand is not planted into it
    for (const id of [B.PLANTED_CARROT, B.CARROT_SPROUT]) expect(interactKind(ctx({ ...base, hit: hit(id, FACE_TOP, 2, Y, -1) }))).toBeNull();
    expect(interactKind(ctx({ ...base, hit: hit(B.CAMPFIRE), fireSpotKind: () => 'skewer', fireView: () => ({ spots: [] }) })).kind).toBe('fire_put');
    expect(interactKind(ctx({ ...base, hit: hit(B.WICKER_BASKET) })).kind).toBe('basket');
    // water nearer than the soil takes the R
    const water = { q: 2, y: Y, r: -1, blockId: B.WATER, distance: 1 };
    expect(interactKind(ctx({ ...base, hit: hit(B.GRASS_BLOCK), waterHit: water })).kind).toBe('drink');
    expect(interactKind(ctx({ ...base, hit: hit(B.GRASS_BLOCK), waterHit: { ...water, distance: 3 } })).kind).toBe('plant');
    // the plantable foods are eaten with the use button (RMB), which R never is
    for (const key of Object.keys(PLANTABLE)) {
      const use = useActionOf({ k: key, n: 1 });
      if (getItem(key).kind === 'food') expect(use, key).toMatchObject({ kind: 'eat', key });
      else expect(use, key).toBeNull();
    }
  });
});

describe('the once-a-second farm work as main runs it (main.farmSecondOn)', () => {
  /** A flat grass world wired like main: every write reaches Growth and Regrowth through onBlockChange. */
  function farm() {
    const world = flat();
    const growth = new Growth();
    const regrowth = new Regrowth();
    const spread = new Spread();
    world.onBlockChange = (q, y, r, prev, next) => {
      regrowth.onBlockChange(q, y, r, prev, next);
      growth.onBlockChange(q, y, r, prev, next);
    };
    const said = [];
    const f = { world, growth, spread, isLoadedCell: world.hasChunkAtCell, waterQuality: () => 'fresh', q: 0, r: 0, say: (t) => said.push(t) };
    return { world, growth, regrowth, spread, said, f };
  }
  /** Rolls for one second with no wild plant about: the growth rolls given, then 48 spread samples and no spontaneous birth. */
  const second = (...growthRolls) => seq(...growthRolls, 0.999);

  it('a planted seed becomes its sprout, the sprout its plant, each by one lazy write that comes back through onBlockChange', () => {
    const { world, growth, regrowth, f } = farm();
    world.put(1, G, 0, B.WATER);
    world.setBlock(0, Y, 0, B.PLANTED_HONEYBERRY); // what planting writes
    expect(growth.size).toBe(1);
    expect(farmSecondOn(1, second(0.5), f)).toEqual({ sprouted: 0, grown: 0, failed: 0, births: 0 });
    expect(farmSecondOn(1, second(0, 0), f)).toEqual({ sprouted: 1, grown: 0, failed: 0, births: 0 });
    expect(world.getBlock(0, Y, 0)).toBe(B.HONEYBERRY_SPROUT);
    expect(growth.cells.get(`0,${Y},0`).id).toBe(B.HONEYBERRY_SPROUT);
    expect(farmSecondOn(1, second(0), f)).toEqual({ sprouted: 0, grown: 1, failed: 0, births: 0 });
    // it grew up PICKED: Growth lets go of it, Regrowth has it
    expect(world.getBlock(0, Y, 0)).toBe(B.HONEYBERRY_BUSH_BARE);
    expect(growth.size).toBe(0);
    expect(regrowth.has(0, Y, 0)).toBe(true);
    expect(world.writes.slice(1)).toEqual([
      { q: 0, y: Y, r: 0, id: B.HONEYBERRY_SPROUT, lazy: true }, { q: 0, y: Y, r: 0, id: B.HONEYBERRY_BUSH_BARE, lazy: true },
    ]);
    expect(world.hasEdit(0, Y, 0)).toBe(true); // a save keeps it: the id is the state
  });

  it('a seed that does not take leaves AIR and says so, but only within FAIL_NOTICE_CELLS of the player', () => {
    const { world, growth, said, f } = farm();
    world.setBlock(0, Y, FAIL_NOTICE_CELLS, B.PLANTED_CARROT);
    world.setBlock(0, Y, FAIL_NOTICE_CELLS + 1, B.PLANTED_ONION);
    expect(farmSecondOn(1, second(0, 0.999, 0, 0.999), f)).toEqual({ sprouted: 0, grown: 0, failed: 2, births: 0 });
    expect(world.getBlock(0, Y, FAIL_NOTICE_CELLS) + world.getBlock(0, Y, FAIL_NOTICE_CELLS + 1)).toBe(B.AIR);
    expect(world.hasEdit(0, Y, FAIL_NOTICE_CELLS)).toBe(false); // the cell is as the world made it again
    expect(said).toEqual(['A planted Wild Carrot did not take.']);
    expect(growth.size).toBe(0);
  });

  it('a cell that changed since the roll is left alone', () => {
    const { world, growth, f } = farm();
    world.setBlock(0, Y, 0, B.PLANTED_CARROT);
    const stale = { step: () => [{ q: 0, y: Y, r: 0, from: B.PLANTED_TUBER, to: B.TUBER_SPROUT, crop: cropOf('tuber'), took: true }] };
    expect(farmSecondOn(1, second(), { ...f, growth: /** @type {*} */ (stale) })).toEqual({ sprouted: 0, grown: 0, failed: 0, births: 0 });
    expect(world.getBlock(0, Y, 0)).toBe(B.PLANTED_CARROT);
    expect(growth.size).toBe(1);
  });

  it('a save is found again: Growth.loadFromEdits over the world\'s edits tracks what was planted', () => {
    const { world, f } = farm();
    world.put(1, G, 0, B.WATER);
    world.setBlock(0, Y, 0, B.PLANTED_HAZEL);
    world.setBlock(-20, Y, 3, B.PLANTED_CARROT);
    farmSecondOn(1, second(0, 0, 0.5), f); // the hazel sprouts
    const again = new Growth();
    again.loadFromEdits(world.edits);
    expect([...again.cells.values()].sort((a, b) => a.q - b.q)).toEqual([{ q: -20, y: Y, r: 3, id: B.PLANTED_CARROT }, { q: 0, y: Y, r: 0, id: B.HAZEL_SPROUT }]);
  });

  it('a wild plant that seeds is written into an AIR cell, lazily, and counted', () => {
    const { world, spread, f } = farm();
    world.put(0, Y, 0, B.CARROT_PLANT);
    // 0.5 × the columns in range is the middle one, the player's own, where the carrot stands; then it seeds; then a neighbour
    const done = farmSecondOn(1, seq(0.5, 0, 0), f);
    expect(done).toEqual({ sprouted: 0, grown: 0, failed: 0, births: 1 });
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]).toMatchObject({ id: B.CARROT_PLANT, y: Y, lazy: true });
    expect([spread.births, spread.seeded, spread.spontaneous]).toEqual([1, 1, 0]);
    expect(spread.last).toMatchObject({ id: B.CARROT_PLANT, seeded: true, parent: [0, Y, 0] });
  });

  it('the debug handle\'s farmStep runs at most ten game days of one-second steps', () => {
    expect(FARM_STEP_MAX_S).toBe(10 * DAY_LENGTH_SECONDS);
  });
});

describe('the wiring (main.js, diagnostics.js): read from the source, since main needs a browser', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8');
  const main = read('main.js');
  /** The body of a function of main's closure. */
  const body = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('one Growth and one Spread a session: fed by onBlockChange, found again in the edits, cleared with the rest', () => {
    expect(main).toMatch(/^ {2}const growth = new Growth\(\);$/m);
    expect(main).toMatch(/^ {2}const spread = new Spread\(\);$/m);
    const changed = body('onBlockChanged');
    expect(changed.indexOf('growth.onBlockChange(q, y, r, prev, next)')).toBeGreaterThan(changed.indexOf('regrowth.onBlockChange(q, y, r, prev, next)'));
    expect(changed.indexOf('growth.onBlockChange(')).toBeLessThan(changed.indexOf('blockPhysics.onBlockChange(')); // physics sees the trackers updated
    expect(body('loadSurvival')).toContain('growth.loadFromEdits(world.edits)');
    expect(body('clearSurvival')).toMatch(/growth\.clear\(\);\n\s+spread\.clear\(\);/);
  });

  it('once a second, in Survival only, right after regrowth; the player\'s column is where the samples centre', () => {
    const step = body('stepSurvival');
    const second = step.slice(step.indexOf('if (survivalSecond >= 1) {'));
    expect(second.indexOf('farmSecond(1, Math.random)')).toBeGreaterThan(second.indexOf('regrowth.step(1, Math.random, isLoadedCellFn)'));
    expect(second.indexOf('farmSecond(1, Math.random)')).toBeLessThan(second.indexOf('pack.spoil(1, Math.random)'));
    expect((main.match(/farmSecond\(1, Math\.random\)/g) ?? []).length).toBe(2); // there, and in the debug handle's farmStep
    const farm = body('farmSecond');
    expect(farm).toContain('worldToHex(player.x, player.z)');
    // §84: `rained` hands farming the rain (a cell rained on within RAIN_WATERS_S is watered)
    expect(farm).toContain('farmSecondOn(dt, random, { world, growth, spread, isLoadedCell: isLoadedCellFn, waterQuality: waterQualityOf, q, r, say: logLine, rained: rainedOn })');
  });

  it('R plants through the path a placed block takes, and uses one item only when the block went in', () => {
    expect(body('doInteract')).toMatch(/case 'plant':\n\s+plantSeed\(q, y, r\);/);
    const plant = body('plantSeed');
    const order = ['plantAt(world.getBlock, selectedKey(), q, y, r)', 'placeRefusal(world.getBlock, planting.block', 'if (!placeBlockAt(planting.block, planting.cell)) return;',
      'pack.consume(selected, 1);'].map((text) => plant.indexOf(text));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body('placeBlockAt')).toContain('playerSetBlock(tq, ty, tr, id)');
    // the planting step gets the world; R never repeats a planting while held
    expect(main).toContain('getBlock: (q, y, r) => world.getBlock(q, y, r), // §80');
    expect(main).toMatch(/const R_REPEATS = new Set\(\['fire_put', 'fire_feed', 'drink', 'drink_here'\]\);/);
  });

  it('the hints: a crop under the crosshair says what it has; the wrong ground speaks last, and only on a top face', () => {
    const hint = body('survivalHintText');
    const at = (text) => {
      expect(hint.indexOf(text), text).toBeGreaterThan(0);
      return hint.indexOf(text);
    };
    expect(at('if (crop) return cropHintText(h, crop);')).toBeGreaterThan(at('const act = interactAction();')); // R's own hints first
    expect(at('if (crop) return cropHintText(h, crop);')).toBeLessThan(at('harvestHint(h.blockId)'));
    expect(at('wrongGroundHint(world.getBlock, selectedKey(), h.q, h.y, h.r)')).toBeGreaterThan(at('handGatherHint(h.blockId)'));
    expect(at('if (h.face === FACE_TOP) {')).toBeLessThan(at('wrongGroundHint('));
    expect(body('cropHintText')).toContain('farmHint(h.blockId, cropState(world.getBlock, waterQualityOf, h.q, h.y, h.r, crop, rainedOn))'); // §84: + the rain
  });

  it('the debug handle carries growth, spread and farmStep(seconds)', () => {
    const growth = new Growth();
    const spread = new Spread();
    const calls = [];
    const game = { growth, spread, farmStep: (seconds) => (calls.push(seconds), { seconds, sprouted: 0, grown: 0, failed: 0, births: 0 }) };
    const win = {};
    const handle = installDebugHandle(win, /** @type {*} */ (game));
    expect(win.__caelancraft).toBe(handle);
    expect([handle.growth, handle.spread]).toEqual([growth, spread]);
    expect(handle.farmStep(1440)).toEqual({ seconds: 1440, sprouted: 0, grown: 0, failed: 0, births: 0 });
    expect(calls).toEqual([1440]);
    expect(installDebugHandle({}, null).farmStep(5)).toBeNull();
    // main hands all three over, and its farmStep is capped and runs the same second as the game does
    const game0 = main.slice(main.indexOf('  const game = {'));
    expect(game0).toMatch(/\n {4}growth,\n {4}spread,\n/);
    const step = game0.slice(game0.indexOf('    farmStep(seconds) {'), game0.indexOf('    /** Queue a mode switch'));
    expect(step).toContain('Math.min(FARM_STEP_MAX_S, Math.floor(seconds))');
    expect(step).toContain('farmSecond(1, Math.random)');
    const types = read('types.js');
    const ctx = types.slice(types.indexOf('@typedef {Object} GameContext'));
    for (const m of ['growth', 'spread', 'farmStep']) expect(ctx, m).toMatch(new RegExp(`@property \\{[^\\n]*\\} \\[?${m}\\]?`));
  });
});
