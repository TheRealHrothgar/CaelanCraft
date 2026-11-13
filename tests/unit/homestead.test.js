// A place to stay (CONTRACTS §85, src/homestead.js): natural springs, wells, rain barrels, watering by hand, the dug
// cistern, the two beds — the blocks, their pictures and models, the items and recipes, what R does to each, what
// brings their water back, and how main wires it (read from the source: main needs a browser). The land of generation 5
// (where the springs rise, the gravel beds) is tests/unit/worldgenHomestead.test.js's; the guide's pages are
// handbook.test.js's.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAY_LENGTH_SECONDS, WORLD_HEIGHT } from '../../src/config.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, BIOME, UNLOADED, HOMESTEAD_IDS, FURNITURE_MODEL_IDS, PICKER_ORDER, LAYER_OPAQUE, LAYER_CUTOUT,
  isSpring, isWell, isRainBarrel, isWater, isWaterSource, isLiquid, isSolid, isOpaque, isPlaceable, isBreakable, isPopOff, isPlant,
  getBlockShape, getFaceTile,
} from '../../src/blocks.js';
import { FACE_TOP, FACE_BOTTOM, hexLength } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { paintTile, TILE_NAMES } from '../../src/tiles.js';
import { plantModel, plantModelTile, PLANT_MODELS, PLANT_QUAD_STRIDE } from '../../src/plantModels.js';
import { ITEMS, ITEM_KEYS, TAGS, getItem, itemForBlock, blockForItem } from '../../src/items.js';
import { hasItemArt, paintItem } from '../../src/itemArt.js';
import { getRecipe, RECIPES, TAG_LABELS } from '../../src/crafting.js';
import { purposeOf, PURPOSE_MAX } from '../../src/purpose.js';
import { BLOCK_RULES, canHarvest, breakSeconds, rollDrops, ruleFor, harvestHint } from '../../src/harvest.js';
import { RATES, createVitals, gulpWater } from '../../src/vitals.js';
import { interactKind, placeRefusal, useActionOf, HINT } from '../../src/survivalControl.js';
import {
  HAND_WATER_S, SPROUT_MEAN_S, GROW_MEAN_S, SEED_TAKES, FARM_WATER_REACH, handWater, handWaterChance, cropState, cropOf, waterNear, Growth,
} from '../../src/farming.js';
import { DRYNESS_RAINS, DRYNESS_DRY, LEAF_COVER, createWeather, rainReaching } from '../../src/weather.js';
import {
  CELL_GULPS, POT_GULPS, FILL_MEAN_S, DRY_MEAN_S, waterAt, drawWater, clayBasinAt, cycleStep,
} from '../../src/waterBodies.js';
import { waterBodyAt } from '../../src/fluids.js';
import {
  SPRING_DRAUGHT, SPRING_MEAN_S, SPRING_POT, SPRING_NEAREST_CELLS, SPRING_DEEP_HINT, WELL_GULPS, WELL_POT, WELL_MEAN_S, WELL_DESERT_FACTOR,
  WELL_SHARE, WELL_GROUND, WELL_GROUND_HINT, BARREL_POTS, BARREL_FILL_MEAN_S, WATERING_POTS, EMPTY_POT, MAX_REFILL_TRACKED, REFILL_IDS,
  HOMESTEAD_HINT, Refill, homesteadAction, homesteadSecondOn, wellMeanS, barrelPots, barrelWith, deepHint, isRefillBlock,
} from '../../src/homestead.js';
import { installDebugHandle } from '../../src/diagnostics.js';
import { pondCells } from '../helpers/water.js';

const B = BLOCK;
const main = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
const BARRELS = [B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2, B.RAIN_BARREL_3];
const name = (id) => BLOCKS[id].name;
/** A `random` that returns the given values, then 0.999 for ever (no roll passes). */
const seq = (...values) => {
  let i = 0;
  const f = () => (i < values.length ? values[i++] : 0.999);
  f.drawn = () => i;
  return f;
};
const loaded = () => true;
/** A small world of cells over flat ground: `ground` up to y 9, air above; `set` puts a block. */
function land(ground = B.GRASS_BLOCK) {
  /** @type {Map<string, number>} */
  const cells = new Map();
  const getBlock = (q, y, r) => cells.get(`${q},${y},${r}`) ?? (y < 0 || y >= WORLD_HEIGHT ? B.AIR : y <= 9 ? ground : B.AIR);
  return {
    getBlock,
    getBiome: () => BIOME.PLAINS,
    set(q, y, r, id) {
      cells.set(`${q},${y},${r}`, id);
      return true;
    },
    setBlock(q, y, r, id) {
      cells.set(`${q},${y},${r}`, id);
      return true;
    },
  };
}
/** An env for Refill.step. */
const env = (dryness = DRYNESS_RAINS, rain = 0, biome = BIOME.PLAINS) => ({ dryness: () => dryness, biome: () => biome, rain: () => rain });
const pack = { count: () => 0, countTag: () => 0, hasTool: () => false };
/** interactKind with block `id` under the crosshair and `sel` in hand. */
const rOn = (id, sel) => interactKind({ hit: { q: 3, y: 10, r: -2, blockId: id, distance: 2, face: FACE_TOP }, selectedKey: sel, pack });
/** The texels of a tile as [r, g, b, a] at (x, y). */
const texel = (px, x, y) => [px[(y * 16 + x) * 4], px[(y * 16 + x) * 4 + 1], px[(y * 16 + x) * 4 + 2], px[(y * 16 + x) * 4 + 3]];
const isBlue = ([r, g, b]) => b > 150 && b > r + 40 && b >= g;

describe('the ten blocks 163–172 (blocks.js)', () => {
  it('ids, names and display names, appended after the water of §83', () => {
    expect(BLOCK_COUNT).toBe(174); // (§89 appended the aquifer, 173)
    expect([...HOMESTEAD_IDS]).toEqual([163, 164, 165, 166, 167, 168, 169, 170, 171, 172]);
    expect(HOMESTEAD_IDS.map((id) => [id, BLOCKS[id].name, BLOCKS[id].displayName])).toEqual([
      [B.SPRING, 'spring', 'Spring'], [B.SPRING_DRAWN, 'spring_drawn', 'Spring (drawn)'],
      [B.WELL, 'well', 'Well'], [B.WELL_DRAWN, 'well_drawn', 'Well (drawn)'],
      [B.RAIN_BARREL, 'rain_barrel', 'Rain Barrel'], [B.RAIN_BARREL_1, 'rain_barrel_1', 'Rain Barrel (1 pot)'],
      [B.RAIN_BARREL_2, 'rain_barrel_2', 'Rain Barrel (2 pots)'], [B.RAIN_BARREL_3, 'rain_barrel_3', 'Rain Barrel (3 pots)'],
      [B.GRASS_BED, 'grass_bed', 'Grass Bed'], [B.BED, 'bed', 'Bed'],
    ]);
    expect(Object.isFrozen(HOMESTEAD_IDS) && Object.isFrozen(FURNITURE_MODEL_IDS)).toBe(true);
    expect([...FURNITURE_MODEL_IDS]).toEqual([165, 166, 167, 168, 169, 170, 171, 172]);
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(all.filter(isSpring)).toEqual([B.SPRING, B.SPRING_DRAWN]);
    expect(all.filter(isWell)).toEqual([B.WELL, B.WELL_DRAWN]);
    expect(all.filter(isRainBarrel)).toEqual(BARRELS);
    for (const f of [isSpring, isWell, isRainBarrel]) expect(f(UNLOADED) || f(-1) || f(NaN) || f(undefined), f.name).toBe(false);
  });

  it('the spring is ground: a solid, opaque prism of rock that is no water; never placed, no item', () => {
    for (const id of [B.SPRING, B.SPRING_DRAWN]) {
      const d = BLOCKS[id];
      expect([d.solid, d.opaque, d.liquid, d.layer, d.shape, d.icon, d.soundGroup, d.placeable, d.gravity], d.name)
        .toEqual([true, true, false, LAYER_OPAQUE, 'prism', 'prism', 'stone', false, false]);
      expect(isWater(id) || isWaterSource(id) || isLiquid(id), d.name).toBe(false); // the fluid rule never looks at it
      expect(isBreakable(id), d.name).toBe(true); // Creative may remove one; Survival cannot (harvest: no rule)
      expect(itemForBlock(id), d.name).toBeNull();
      expect(isPopOff(id) || isPlant(id), d.name).toBe(false);
      expect(getFaceTile(id, 0), d.name).toBe(TILE.SPRING_SIDE);
      expect(getFaceTile(id, FACE_BOTTOM), d.name).toBe(TILE.STONE);
    }
    expect([getFaceTile(B.SPRING, FACE_TOP), getFaceTile(B.SPRING_DRAWN, FACE_TOP)]).toEqual([TILE.SPRING_TOP, TILE.SPRING_DRAWN_TOP]);
  });

  it('the well and the rain barrel are SOLID 3D models; the beds are low models you walk over; only four are placed by hand', () => {
    for (const id of [B.WELL, B.WELL_DRAWN, ...BARRELS]) {
      const d = BLOCKS[id];
      expect([d.solid, d.opaque, d.layer, d.cullSame, d.shape, d.icon, d.meshed], d.name).toEqual([true, false, LAYER_CUTOUT, false, 'model', 'flat', true]);
      expect(d.soundGroup, d.name).toBe(isWell(id) ? 'stone' : 'wood');
    }
    for (const id of [B.GRASS_BED, B.BED]) {
      const d = BLOCKS[id];
      expect([d.solid, d.opaque, d.layer, d.cullSame, d.shape, d.icon, d.meshed], d.name).toEqual([false, false, LAYER_CUTOUT, false, 'model', 'flat', true]);
      expect(isPopOff(id) || isPlant(id), d.name).toBe(false); // furniture: digging under it does not destroy it
    }
    expect([BLOCKS[B.GRASS_BED].soundGroup, BLOCKS[B.BED].soundGroup]).toEqual(['grass', 'wood']);
    expect(HOMESTEAD_IDS.filter(isPlaceable)).toEqual([B.WELL, B.RAIN_BARREL, B.GRASS_BED, B.BED]);
    // in the picker's flat order after the snare, and so among the block items
    const i = PICKER_ORDER.indexOf(B.SNARE);
    expect(PICKER_ORDER.slice(i + 1, i + 6)).toEqual([B.GRASS_BED, B.BED, B.WELL, B.RAIN_BARREL, B.CAMPFIRE]);
    for (const id of FURNITURE_MODEL_IDS) expect(isSolid(id), name(id)).toBe(id < B.GRASS_BED);
    expect(FURNITURE_MODEL_IDS.some(isOpaque)).toBe(false);
  });
});

describe('the tiles 207, 225–227 and 232–237 (tiles.js)', () => {
  const PICTURES = [TILE.WELL, TILE.RAIN_BARREL, TILE.GRASS_BED, TILE.BED];
  const OPAQUE = [TILE.SPRING_SIDE, TILE.SPRING_TOP, TILE.SPRING_DRAWN_TOP, TILE.WELL_SKIN, TILE.RAIN_BARREL_SKIN, TILE.BED_SKIN];

  it('ten tiles in the ids the flora range left free, each named after its key and used by a block or a model', () => {
    expect([TILE.SPRING_SIDE, TILE.SPRING_TOP, TILE.SPRING_DRAWN_TOP, TILE.WELL, TILE.WELL_SKIN, TILE.RAIN_BARREL, TILE.RAIN_BARREL_SKIN,
      TILE.GRASS_BED, TILE.BED, TILE.BED_SKIN]).toEqual([207, 225, 226, 227, 232, 233, 234, 235, 236, 237]);
    expect(TILE_IDS).toHaveLength(195); // (§89: + the aquifer's two)
    for (const t of [...PICTURES, ...OPAQUE]) {
      expect(TILE_IDS, TILE_NAMES[t]).toContain(t);
      const key = Object.keys(TILE).find((k) => TILE[k] === t);
      expect(TILE_NAMES[t]).toBe(key.toLowerCase());
      const used = BLOCKS.some((d) => d.tiles.includes(t)) || Object.values(PLANT_MODELS).some((m) => m.tile === t);
      expect(used, TILE_NAMES[t]).toBe(true);
    }
    expect([TILE_NAMES[238], TILE_NAMES[239]]).toEqual(['aquifer_side', 'aquifer_top']); // free until §89's aquifer took them
  });

  it('the four pictures are cut-outs for the Pack (alpha 0 or 255, clear pixels black, clear corners); the faces and skins are opaque', () => {
    for (const t of PICTURES) {
      const px = paintTile(t);
      let solid = 0;
      for (let i = 0; i < px.length; i += 4) {
        expect(px[i + 3] === 0 || px[i + 3] === 255, TILE_NAMES[t]).toBe(true);
        if (px[i + 3] === 0) expect(px[i] + px[i + 1] + px[i + 2], TILE_NAMES[t]).toBe(0);
        else solid++;
      }
      expect(solid, TILE_NAMES[t]).toBeGreaterThan(100); // a bold shape, not a line drawing
      expect(solid, TILE_NAMES[t]).toBeLessThan(215);
      expect(texel(px, 0, 0)[3] + texel(px, 15, 0)[3], TILE_NAMES[t]).toBe(0);
    }
    for (const t of OPAQUE) {
      const px = paintTile(t);
      for (let i = 3; i < px.length; i += 4) expect(px[i], TILE_NAMES[t]).toBe(255);
    }
    // deterministic
    for (const t of [...PICTURES, ...OPAQUE]) expect([...paintTile(t)]).toEqual([...paintTile(t)]);
  });

  it('a welling spring and a drawn one share their rim stone for stone; one holds bright water, the other a trickle on wet rock', () => {
    const full = paintTile(TILE.SPRING_TOP);
    const drawn = paintTile(TILE.SPRING_DRAWN_TOP);
    let blueFull = 0;
    let blueDrawn = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const inPool = Math.hypot(x + 0.5 - 8, y + 0.5 - 8) <= 4.6;
        if (!inPool) expect(texel(full, x, y), `${x},${y}`).toEqual(texel(drawn, x, y));
        if (isBlue(texel(full, x, y)) || texel(full, x, y).slice(0, 3).every((c) => c === 255)) blueFull += inPool ? 1 : 0;
        if (isBlue(texel(drawn, x, y))) blueDrawn++;
      }
    }
    expect(blueFull).toBeGreaterThan(55); // the whole pool: clear water, seen from far
    expect(blueDrawn).toBeGreaterThanOrEqual(4);
    expect(blueDrawn).toBeLessThanOrEqual(8); // a trickle
    // the welling water is much lighter than a pond's: its mean blue-channel brightness beats the water tile's
    const mean = (px, test) => {
      let s = 0;
      let n = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (test(x, y)) { s += texel(px, x, y)[0] + texel(px, x, y)[1] + texel(px, x, y)[2]; n++; }
      return s / n;
    };
    expect(mean(full, (x, y) => Math.hypot(x + 0.5 - 8, y + 0.5 - 8) <= 3.6)).toBeGreaterThan(mean(paintTile(TILE.WATER), () => true) + 60);
    // and water runs down the rock below it
    const side = paintTile(TILE.SPRING_SIDE);
    let run = 0;
    for (let y = 2; y <= 13; y++) if (isBlue(texel(side, 8, y)) || texel(side, 8, y)[0] === 255) run++;
    expect(run).toBeGreaterThanOrEqual(8);
  });

  it('the skins hold what the models cut from them: water where the water plates are cut, stone, wood and cloth where the boxes are', () => {
    const well = paintTile(TILE.WELL_SKIN);
    for (let y = 7; y < 15; y++) for (let x = 0; x < 8; x++) expect(isBlue(texel(well, x, y)) || texel(well, x, y)[0] === 255, `well water ${x},${y}`).toBe(true);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 16; x++) { const [r, g, b] = texel(well, x, y); expect(Math.abs(r - b) < 16 && Math.abs(r - g) < 16, `stone ${x},${y}`).toBe(true); }
    const barrel = paintTile(TILE.RAIN_BARREL_SKIN);
    for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) expect(isBlue(texel(barrel, x, y)) || texel(barrel, x, y)[0] === 255, `barrel water ${x},${y}`).toBe(true);
    for (let y = 0; y < 13; y++) for (let x = 0; x < 8; x++) { const [r, g, b] = texel(barrel, x, y); expect(r > g && g > b, `stave ${x},${y}`).toBe(true); } // wood and cord: warm
    const bed = paintTile(TILE.BED_SKIN);
    for (let y = 0; y < 7; y++) for (let x = 9; x < 16; x++) { const [r, g, b] = texel(bed, x, y); expect(r > 150 && r > b + 60, `blanket ${x},${y}`).toBe(true); void g; }
  });
});

describe('the models of the well, the rain barrel and the beds (plantModels.js)', () => {
  /** The quads of a compiled model: corners [x, y, z] in metres, their texels, the normal. */
  const quadsOf = (id) => {
    const m = plantModel(id);
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
  };
  const height = (id) => Math.max(...quadsOf(id).flatMap((q) => q.p.map((c) => c[1])));
  /** The upward faces cut wholly from the rectangle [u, v, w, h] of the skin: their heights in texels. */
  const topsFrom = (id, [u, v, w, h]) => quadsOf(id).filter((q) => q.n[1] > 0.99 && q.uv.every(([a, b]) => a >= u && a <= u + w && b >= v && b <= v + h))
    .map((q) => Math.round(q.p[0][1] * 16 * 100) / 100);

  it('eight models: skins for the well, the barrel and the bed, the grass bed cut from its own picture', () => {
    for (const id of FURNITURE_MODEL_IDS) {
      expect(getBlockShape(id), name(id)).toBe('model');
      expect(plantModel(id), name(id)).toBeInstanceOf(Float32Array);
    }
    expect([plantModelTile(B.WELL), plantModelTile(B.WELL_DRAWN)]).toEqual([TILE.WELL_SKIN, TILE.WELL_SKIN]);
    expect(BARRELS.map((id) => plantModelTile(id))).toEqual([234, 234, 234, 234]);
    expect([plantModelTile(B.GRASS_BED), plantModelTile(B.BED)]).toEqual([null, TILE.BED_SKIN]);
  });

  it('the drawn well is the well less its water and its pot: the cord runs down into the dark', () => {
    const full = quadsOf(B.WELL);
    const drawn = quadsOf(B.WELL_DRAWN);
    expect(PLANT_MODELS[B.WELL_DRAWN].bare).toBe(true);
    expect(full.length - drawn.length).toBe(17); // the water (5 faces), the pot and its rim (6 each)
    const key = (q) => q.p.flat().map((c) => c.toFixed(4)).join(',');
    const places = new Set(full.map(key));
    for (const q of drawn) expect(places.has(key(q))).toBe(true);
    // water stands 5 texels up in the full well; in the drawn one the highest thing inside the ring is the dark, 1.5 up
    expect(topsFrom(B.WELL, [0, 7, 8, 8])).toEqual([5]);
    expect(topsFrom(B.WELL_DRAWN, [0, 7, 8, 8])).toEqual([]);
    expect(topsFrom(B.WELL_DRAWN, [14, 7, 2, 3])).toEqual([1.5]);
    // a ring of six stones, a beam across the top: nearly a cell high, as wide as the cell allows
    expect(height(B.WELL)).toBeGreaterThan(0.85);
    expect(height(B.WELL)).toBe(height(B.WELL_DRAWN));
  });

  it('a rain barrel shows what it holds: the water stands a third higher for each pot, and the empty one shows its dark bottom', () => {
    expect(topsFrom(B.RAIN_BARREL, [8, 0, 8, 8])).toEqual([]);
    expect(topsFrom(B.RAIN_BARREL, [8, 8, 8, 5])).toEqual([1]);
    expect(BARRELS.slice(1).map((id) => topsFrom(id, [8, 0, 8, 8]))).toEqual([[4.5], [8], [11.5]]);
    // the staves are the same in all four, and taller than the fullest water
    const walls = (id) => quadsOf(id).filter((q) => q.uv.every(([u]) => u <= 8)).length;
    expect(BARRELS.map(walls)).toEqual([30, 30, 30, 30]);
    for (const id of BARRELS) expect(height(id) * 16, name(id)).toBe(13);
    expect(BARRELS.map((id) => quadsOf(id).length)).toEqual([35, 35, 35, 35]);
  });

  it('the beds are low: a heap of grass under half a metre, a bed whose mattress is knee-high and whose headboard is the tallest thing on it', () => {
    expect(height(B.GRASS_BED)).toBeGreaterThan(0.3);
    expect(height(B.GRASS_BED)).toBeLessThanOrEqual(0.5);
    expect(height(B.BED) * 16).toBe(11); // the headboard
    expect(topsFrom(B.BED, [9, 0, 7, 8])).toEqual([8]); // the blanket's top, half a metre up
    expect(topsFrom(B.BED, [12, 8, 4, 6])).toEqual([8.5]); // the pillow, a little higher
  });
});

describe('the items and the recipes (items.js, itemArt.js, crafting.js, purpose.js)', () => {
  it('the Pot of Spring Water: safe like boiled water, 30 Hydration, keeps, gives the pot back; the last food', () => {
    expect(getItem('pot_spring')).toEqual({
      key: 'pot_spring', name: 'Pot of Spring Water', kind: 'food', stack: 1,
      food: { satiation: 0, hydration: 30, sick: 0, useS: 1.0, returns: 'clay_pot' },
    });
    expect(getItem('pot_spring').food).toEqual(getItem('pot_boiled').food); // in every number: safe, and it never spoils
    expect(getItem('pot_spring').food.spoilS).toBeUndefined();
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food').at(-1)).toBe('pot_spring');
    expect(SPRING_POT).toBe('pot_spring');
    expect(useActionOf({ k: 'pot_spring', n: 1 })).toEqual({ kind: 'drink', key: 'pot_spring', needS: 1 });
    expect(hasItemArt('pot_spring')).toBe(true);
    // its picture is the pot with the spring's own bright water: not the Pot of Water's, not the boiled pot's
    const [a, b, c] = ['pot_spring', 'pot_water', 'pot_boiled'].map((k) => [...paintItem(k)].join(','));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('four block items: the Well, the Rain Barrel, the Grass Bed and the Bed; every state of a well or a barrel gives the one item', () => {
    for (const [key, id, label] of [['well', B.WELL, 'Well'], ['rain_barrel', B.RAIN_BARREL, 'Rain Barrel'], ['grass_bed', B.GRASS_BED, 'Grass Bed'], ['bed', B.BED, 'Bed']]) {
      expect(getItem(key)).toMatchObject({ key, name: label, kind: 'block', stack: 64, block: id });
      expect(blockForItem(key)).toBe(id);
      expect(itemForBlock(id)).toBe(key);
    }
    expect(itemForBlock(B.WELL_DRAWN)).toBe('well');
    expect(BARRELS.map((id) => itemForBlock(id))).toEqual(['rain_barrel', 'rain_barrel', 'rain_barrel', 'rain_barrel']);
    expect(ITEM_KEYS).toHaveLength(266);
  });

  it('the recipes: a Grass Bed by hand; the Well, the Rain Barrel and the Bed at the Work Stump', () => {
    const row = (id) => {
      const r = getRecipe(id);
      return [r.station, r.inputs, r.outputs, r.tools, r.seconds];
    };
    expect(row('grass_bed')).toEqual(['hand', [{ k: 'plant_fibre', n: 8 }, { k: 'stick', n: 3 }], [{ k: 'grass_bed', n: 1 }], [], 4]);
    expect(row('well')).toEqual(['stump', [{ k: 'cobblestone', n: 12 }, { k: 'cord', n: 3 }, { tag: 'planks', n: 2 }, { k: 'clay_pot', n: 1 }],
      [{ k: 'well', n: 1 }], [{ type: 'shovel', tier: 1 }], 12]);
    expect(row('rain_barrel')).toEqual(['stump', [{ tag: 'planks', n: 6 }, { k: 'cord', n: 2 }], [{ k: 'rain_barrel', n: 1 }], [{ type: 'axe', tier: 1 }], 8]);
    expect(row('bed')).toEqual(['stump', [{ tag: 'planks', n: 6 }, { k: 'cord', n: 3 }, { tag: 'wool', n: 3 }, { k: 'leather', n: 1 }],
      [{ k: 'bed', n: 1 }], [{ type: 'knife', tier: 2 }], 12]);
    expect(RECIPES).toHaveLength(123);
    // wool of any colour, white (what a sheep gives) first
    expect(TAGS.wool).toHaveLength(16);
    expect(TAGS.wool[0]).toBe('wool_white');
    expect(TAGS.wool.every((k) => /^wool_/.test(k) && ITEMS[k].kind === 'block')).toBe(true);
    expect(TAG_LABELS.wool).toBe('Any Wool');
    // nothing is made at the Workbench: that is the late electrical bench (it takes steel), not a carpenter's
    for (const id of ['grass_bed', 'well', 'rain_barrel', 'bed']) expect(getRecipe(id).station).not.toBe('workbench');
  });

  it('each has a purpose line on its recipe card', () => {
    expect(purposeOf('well')).toBe('Water all year, a few pots a day. Dig it into earth.');
    expect(purposeOf('rain_barrel')).toBe(`Catches rain. Stores ${BARREL_POTS} pots of water that never spoil.`);
    expect(purposeOf('grass_bed')).toBe('A poor place to sleep. Better than none.');
    expect(purposeOf('bed')).toBe('The best sleep: you heal most and need the fewest hours.');
    for (const k of ['well', 'rain_barrel', 'grass_bed', 'bed']) expect(purposeOf(k).length, k).toBeLessThanOrEqual(PURPOSE_MAX);
  });

  it('breaking: the well like the kiln, the barrel and the Bed with an axe, the Grass Bed at once — each comes back as its item', () => {
    const rule = (id) => [ruleFor(id).h, ruleFor(id).tool, ruleFor(id).tier];
    expect([rule(B.WELL), rule(B.WELL_DRAWN)]).toEqual([[3, 'pick', 0], [3, 'pick', 0]]);
    expect(rule(B.WELL)).toEqual(rule(B.KILN));
    for (const id of BARRELS) expect(rule(id), name(id)).toEqual([1.5, 'axe', 0]);
    expect([rule(B.GRASS_BED), rule(B.BED)]).toEqual([[0.4, null, 0], [1.5, 'axe', 0]]);
    const rnd = () => 0.5;
    expect(rollDrops(B.WELL_DRAWN, null, {}, rnd)).toEqual([{ k: 'well', n: 1 }]);
    expect(rollDrops(B.GRASS_BED, null, {}, rnd)).toEqual([{ k: 'grass_bed', n: 1 }]);
    expect(rollDrops(B.BED, null, {}, rnd)).toEqual([{ k: 'bed', n: 1 }]);
    for (const id of FURNITURE_MODEL_IDS) expect(harvestHint(id), name(id)).toBeNull(); // bare hands will do
  });
});

describe('the spring: a place to drink (homestead.js)', () => {
  it('the numbers: a draught of 3 gulps, back after a fifth of a game day, about five draws a day', () => {
    expect([SPRING_DRAUGHT, SPRING_MEAN_S]).toEqual([3, 288]);
    expect(SPRING_MEAN_S * 5).toBe(DAY_LENGTH_SECONDS);
    expect([...SPRING_NEAREST_CELLS]).toEqual([40, 80]);
  });

  it('R with an empty Clay Pot fills a Pot of Spring Water; with anything else, or nothing, it is a draught; either way it is drawn', () => {
    const fill = homesteadAction(B.SPRING, 'clay_pot', 3, 10, -2);
    expect(fill).toEqual({ kind: 'draw', q: 3, y: 10, r: -2, source: 'spring', mode: 'fill', gives: 'pot_spring', to: B.SPRING_DRAWN, hint: 'Spring · R: fill the pot' });
    for (const sel of [null, 'flint_axe', 'pot_water', 'pot_tainted', 'stick']) {
      expect(homesteadAction(B.SPRING, sel, 3, 10, -2), String(sel)).toEqual({
        kind: 'draw', q: 3, y: 10, r: -2, source: 'spring', mode: 'drink', gulps: SPRING_DRAUGHT, safe: true, to: B.SPRING_DRAWN, hint: 'Spring · R: drink',
      });
    }
    expect(homesteadAction(B.SPRING_DRAWN, 'clay_pot', 3, 10, -2)).toEqual({ kind: 'homestead_hint', q: 3, y: 10, r: -2, source: 'spring', hint: 'Spring · drawn, it wells up again' });
    expect(homesteadAction(B.SPRING_DRAWN, null, 0, 0, 0).hint).toBe(HOMESTEAD_HINT.springDrawn);
    // through the R priority of survivalControl, as main asks it
    expect(rOn(B.SPRING, null)).toMatchObject({ kind: 'draw', mode: 'drink', hint: 'Spring · R: drink' });
    expect(rOn(B.SPRING, 'clay_pot')).toMatchObject({ kind: 'draw', mode: 'fill', gives: 'pot_spring', hint: 'Spring · R: fill the pot' });
    expect(rOn(B.SPRING_DRAWN, null)).toMatchObject({ kind: 'homestead_hint', hint: 'Spring · drawn, it wells up again' });
    for (const id of [B.STONE, B.WATER, B.COBBLESTONE, B.GRASS_BED, B.BED, B.AIR]) expect(homesteadAction(id, 'clay_pot', 0, 0, 0), name(id)).toBeNull();
  });

  it('a draught is three gulps\' worth and can never poison: the roll main hands the body is one that never falls below a chance', () => {
    const v = createVitals();
    v.hydration = 10;
    const safe = () => 1; // main: `now.safe ? () => 1 : Math.random`
    for (let i = 0; i < SPRING_DRAUGHT; i++) expect(gulpWater(v, 'fresh', safe).sick).toBe(false);
    expect(v.hydration).toBe(10 + SPRING_DRAUGHT * RATES.GULP_FRESH);
    expect(SPRING_DRAUGHT * RATES.GULP_FRESH).toBe(24);
    expect(v.sick).toBe(0);
    expect(RATES.GULP_FRESH_SICK).toBeLessThan(1); // so a roll of 1 is never a poisoning, whatever the chance becomes
    expect(main).toContain("if (survival.drink('fresh', now.safe ? () => 1 : Math.random) === SICK_MESSAGE) sick = true;");
  });

  it('a drawn spring wells up again after 288 s on average, whatever the season and the land: by simulation', () => {
    const times = [];
    for (const [dryness, biome, seed] of [[DRYNESS_RAINS, BIOME.PLAINS, 1], [DRYNESS_DRY, BIOME.DESERT, 2]]) {
      const refill = new Refill();
      for (let i = 0; i < 1000; i++) refill.track(i * 40, 70, 0, B.SPRING_DRAWN);
      const rnd = mulberry32(seed);
      const e = env(dryness, 0, biome);
      let sum = 0;
      let n = 0;
      for (let t = 1; refill.size > 0 && t < 60 * SPRING_MEAN_S; t++) {
        for (const ev of refill.step(1, rnd, loaded, e)) {
          expect([ev.from, ev.to]).toEqual([B.SPRING_DRAWN, B.SPRING]);
          sum += t;
          n++;
        }
      }
      expect(n).toBe(1000);
      expect(refill.size).toBe(0); // a spring that has welled up is forgotten
      times.push(sum / n);
    }
    for (const mean of times) {
      expect(mean).toBeGreaterThan(SPRING_MEAN_S * 0.93);
      expect(mean).toBeLessThan(SPRING_MEAN_S * 1.07);
    }
    // one roll a second for each, below 1 / 288
    const one = new Refill();
    one.track(0, 70, 0, B.SPRING_DRAWN);
    const miss = seq(1 / SPRING_MEAN_S);
    expect(one.step(1, miss, loaded, env())).toEqual([]);
    expect(miss.drawn()).toBe(1);
    expect(one.step(1, seq(1 / SPRING_MEAN_S - 1e-9), loaded, env())).toEqual([{ q: 0, y: 70, r: 0, from: B.SPRING_DRAWN, to: B.SPRING }]);
  });

  it('it cannot be broken in Survival, with any tool, and its hint says why; Creative may remove it', () => {
    const steel = getItem('steel_pick').tool;
    for (const id of [B.SPRING, B.SPRING_DRAWN]) {
      expect(BLOCK_RULES[id], name(id)).toBeNull();
      expect(canHarvest(id, null) || canHarvest(id, steel), name(id)).toBe(false);
      expect(breakSeconds(id, steel), name(id)).toBe(Infinity);
      expect(rollDrops(id, steel, {}, () => 0)).toEqual([]);
      expect(deepHint(id)).toBe('Spring · the rock runs deep: it cannot be broken');
      expect(isBreakable(id)).toBe(true);
    }
    expect(SPRING_DEEP_HINT).toBe(deepHint(B.SPRING));
    for (const id of [B.STONE, B.WELL, B.WELL_DRAWN, B.RAIN_BARREL, B.BEDROCK, B.AIR]) expect(deepHint(id), name(id)).toBeNull();
    // main shows it while the player holds the dig on one
    expect(main).toContain('if (digState.active && hit && deepHint(hit.blockId)) return deepHint(hit.blockId);');
  });

  it('it never waters a crop and is no part of the water: a seed planted beside a spring is dry', () => {
    const w = land();
    w.set(0, 9, 0, B.SPRING);
    w.set(1, 10, 0, B.PLANTED_CARROT);
    const carrot = cropOf('carrot');
    expect(waterNear(w.getBlock, 1, 10, 0, FARM_WATER_REACH)).toBe(false);
    expect(cropState(w.getBlock, null, 1, 10, 0, carrot)).toEqual({ sky: true, watered: false, reed: true });
    expect(waterAt({ peek: w.getBlock }, 0, 9, 0)).toBeNull();
    expect(waterBodyAt(w.getBlock, 0, 9, 0)).toBeNull();
    // (a pond in the same place does water it)
    w.set(0, 9, 0, B.WATER);
    expect(cropState(w.getBlock, null, 1, 10, 0, carrot).watered).toBe(true);
  });
});

describe('the well (homestead.js)', () => {
  it('the numbers', () => {
    expect([WELL_GULPS, WELL_MEAN_S.rains, WELL_MEAN_S.dry, WELL_DESERT_FACTOR, WELL_SHARE, WELL_POT]).toEqual([2, 240, 720, 3, 12, 'pot_water']);
    expect([DAY_LENGTH_SECONDS / WELL_MEAN_S.rains, DAY_LENGTH_SECONDS / WELL_MEAN_S.dry]).toEqual([6, 2]); // pots a game day
    expect(Object.isFrozen(WELL_MEAN_S) && Object.isFrozen(WELL_GROUND)).toBe(true);
  });

  it('it is dug into the ground: Survival sets it on grass, dirt, sand, red sand, gravel or clay (and snowy grass) — never on rock', () => {
    expect([...WELL_GROUND]).toEqual([B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT, B.SAND, B.RED_SAND, B.GRAVEL, B.CLAY]);
    for (const ground of WELL_GROUND) expect(placeRefusal(land(ground).getBlock, B.WELL, 0, 10, 0), name(ground)).toBeNull();
    for (const ground of [B.STONE, B.COBBLESTONE, B.OAK_PLANKS, B.SANDSTONE, B.BEDROCK, B.WELL, B.GRANITE]) {
      expect(placeRefusal(land(ground).getBlock, B.WELL, 0, 10, 0), name(ground)).toBe('A Well is dug into earth, sand, gravel or clay');
    }
    expect(placeRefusal(land().getBlock, B.WELL, 0, 12, 0)).toBe(WELL_GROUND_HINT); // in the air
    // the rule is the well's alone: a barrel, a bed and a kiln stand anywhere, and a plant still needs solid ground
    for (const id of [B.RAIN_BARREL, B.GRASS_BED, B.BED, B.KILN]) expect(placeRefusal(land(B.STONE).getBlock, id, 0, 10, 0), name(id)).toBeNull();
    expect(placeRefusal(land().getBlock, B.TUSSOCK, 0, 12, 0)).toBe(HINT.needsGround);
  });

  it('R with an empty Clay Pot fills a Pot of Water (raw); without one it is two gulps of raw water; then it is drawn and says it is filling', () => {
    expect(homesteadAction(B.WELL, 'clay_pot', 1, 2, 3)).toEqual({ kind: 'draw', q: 1, y: 2, r: 3, source: 'well', mode: 'fill', gives: 'pot_water', to: B.WELL_DRAWN, hint: 'Well · full · R: fill the pot' });
    expect(homesteadAction(B.WELL, null, 1, 2, 3)).toEqual({ kind: 'draw', q: 1, y: 2, r: 3, source: 'well', mode: 'drink', gulps: 2, safe: false, to: B.WELL_DRAWN, hint: 'Well · full · R: drink' });
    expect(homesteadAction(B.WELL_DRAWN, 'clay_pot', 1, 2, 3)).toEqual({ kind: 'homestead_hint', q: 1, y: 2, r: 3, source: 'well', hint: 'Well · drawn, it is filling' });
    expect(rOn(B.WELL, 'clay_pot').gives).toBe('pot_water');
    expect(rOn(B.WELL_DRAWN, null).hint).toBe('Well · drawn, it is filling');
    // well water is ordinary fresh water: the pot poisons like any Pot of Water, and each gulp carries the raw risk
    expect(getItem(WELL_POT).food.sick).toBeGreaterThan(0);
    const v = createVitals();
    v.hydration = 10;
    expect(gulpWater(v, 'fresh', () => RATES.GULP_FRESH_SICK - 0.001).sick).toBe(true);
  });

  it('how long it takes to fill: 240 s in the rains to 720 s in the dry season in a straight line, three times that in the desert', () => {
    expect(wellMeanS(DRYNESS_RAINS, BIOME.PLAINS)).toBe(240);
    expect(wellMeanS(DRYNESS_DRY, BIOME.PLAINS)).toBe(720);
    expect(wellMeanS((DRYNESS_RAINS + DRYNESS_DRY) / 2, BIOME.FOREST)).toBeCloseTo(480, 9);
    expect(wellMeanS(0.3 + 0.7 * 0.25, BIOME.SNOWY)).toBeCloseTo(360, 9);
    expect([wellMeanS(0, BIOME.PLAINS), wellMeanS(2, BIOME.PLAINS)]).toEqual([240, 720]); // no further either way
    expect([wellMeanS(DRYNESS_RAINS, BIOME.DESERT), wellMeanS(DRYNESS_DRY, BIOME.DESERT)]).toEqual([720, 2160]);
    for (const biome of [BIOME.BEACH, BIOME.MOUNTAINS, BIOME.SNOWY_PEAKS, BIOME.OCEAN]) expect(wellMeanS(DRYNESS_RAINS, biome)).toBe(240);
    expect([wellMeanS(DRYNESS_RAINS, BIOME.PLAINS, 2), wellMeanS(DRYNESS_DRY, BIOME.PLAINS, 3), wellMeanS(DRYNESS_RAINS, BIOME.PLAINS, 0)]).toEqual([480, 2160, 240]);
  });

  /** Pots a game day from every well of `at` (columns), drawn the moment each is full, over `days` days. */
  const yields = (at, dryness, biome, days, seed) => {
    const refill = new Refill();
    for (const [q, y, r] of at) refill.track(q, y, r, B.WELL_DRAWN);
    const rnd = mulberry32(seed);
    const e = env(dryness, 0, biome);
    const pots = at.map(() => 0);
    for (let t = 0; t < days * DAY_LENGTH_SECONDS; t++) {
      for (const ev of refill.step(1, rnd, loaded, e)) {
        expect([ev.from, ev.to]).toEqual([B.WELL_DRAWN, B.WELL]);
        pots[at.findIndex(([q, , r]) => q === ev.q && r === ev.r)]++;
        refill.onBlockChange(ev.q, ev.y, ev.r, B.WELL_DRAWN, B.WELL); // main's write
        refill.onBlockChange(ev.q, ev.y, ev.r, B.WELL, B.WELL_DRAWN); // … and the player draws it at once
      }
    }
    return pots.map((n) => n / days);
  };

  it('one well gives about six pots a game day in the rains and two in the dry season; in the desert a third of that', () => {
    const [rains] = yields([[0, 70, 0]], DRYNESS_RAINS, BIOME.PLAINS, 300, 11);
    const [dry] = yields([[0, 70, 0]], DRYNESS_DRY, BIOME.PLAINS, 300, 12);
    const [desert] = yields([[0, 70, 0]], DRYNESS_RAINS, BIOME.DESERT, 300, 13);
    expect(rains).toBeGreaterThan(6 * 0.92);
    expect(rains).toBeLessThan(6 * 1.08);
    expect(dry).toBeGreaterThan(2 * 0.9);
    expect(dry).toBeLessThan(2 * 1.1);
    expect(desert).toBeGreaterThan(2 * 0.9);
    expect(desert).toBeLessThan(2 * 1.1);
  });

  it('wells within 12 cells share the ground\'s water: two give what one gives, three too; a well 13 cells off gives its own', () => {
    const refill = new Refill();
    refill.track(0, 70, 0, B.WELL);
    expect(refill.wellsNear(0, 0)).toBe(1);
    refill.track(WELL_SHARE, 64, 0, B.WELL_DRAWN); // at another height, full or drawn: it counts
    refill.track(0, 70, WELL_SHARE + 1, B.WELL); // one cell too far
    refill.track(5, 70, 5, B.RAIN_BARREL); // no well
    refill.track(6, 70, 0, B.SPRING_DRAWN); // nor is a spring
    expect([refill.wellsNear(0, 0), refill.wellsNear(WELL_SHARE, 0), refill.wellsNear(0, WELL_SHARE + 1)]).toEqual([2, 2, 1]);
    expect(hexLength(WELL_SHARE, 0)).toBe(12);
    // by simulation: a pair 12 apart gives 6 pots a day BETWEEN them; a pair 13 apart gives 12; three in a row 6 apart share three ways
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const near = yields([[0, 70, 0], [12, 70, 0]], DRYNESS_RAINS, BIOME.PLAINS, 300, 21);
    const far = yields([[0, 70, 0], [13, 70, 0]], DRYNESS_RAINS, BIOME.PLAINS, 300, 22);
    const three = yields([[0, 70, 0], [6, 70, 0], [12, 70, 0]], DRYNESS_RAINS, BIOME.PLAINS, 300, 23);
    expect(sum(near)).toBeGreaterThan(6 * 0.92);
    expect(sum(near)).toBeLessThan(6 * 1.08);
    for (const n of near) expect(n).toBeGreaterThan(3 * 0.85);
    expect(sum(far)).toBeGreaterThan(12 * 0.93);
    expect(sum(far)).toBeLessThan(12 * 1.07);
    expect(sum(three)).toBeGreaterThan(6 * 0.92);
    expect(sum(three)).toBeLessThan(6 * 1.08);
  });

  it('the weather is asked only when the roll could win, and a full well draws no roll at all', () => {
    const refill = new Refill();
    refill.track(0, 70, 0, B.WELL);
    refill.track(40, 70, 0, B.WELL_DRAWN);
    let asked = 0;
    const e = { dryness: () => (asked++, DRYNESS_DRY), biome: () => BIOME.PLAINS, rain: () => 0 };
    const high = seq(1 / WELL_MEAN_S.rains);
    expect(refill.step(1, high, loaded, e)).toEqual([]);
    expect([high.drawn(), asked]).toEqual([1, 0]); // one roll (the drawn well's), at or above the best chance: nothing asked
    // below the best chance but not the dry season's: asked, and not yet
    expect(refill.step(1, seq(1 / WELL_MEAN_S.dry), loaded, e)).toEqual([]);
    expect(asked).toBe(1);
    expect(refill.step(1, seq(1 / WELL_MEAN_S.dry - 1e-9), loaded, e)).toEqual([{ q: 40, y: 70, r: 0, from: B.WELL_DRAWN, to: B.WELL }]);
    // filled, it stays tracked as a full well (to be counted) and draws no more rolls
    const none = seq(0);
    expect(refill.step(1, none, loaded, e)).toEqual([]);
    expect([none.drawn(), refill.size, refill.wellsNear(40, 0)]).toEqual([0, 2, 1]);
  });
});

describe('the rain barrel (homestead.js)', () => {
  it('the numbers: three pots, one pot about every 240 s of the hardest rain', () => {
    expect([BARREL_POTS, BARREL_FILL_MEAN_S]).toEqual([3, 240]);
    expect(BARRELS.map(barrelPots)).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3, 4, -1, 1.7].map(barrelWith)).toEqual([B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2, B.RAIN_BARREL_3, B.RAIN_BARREL_3, B.RAIN_BARREL, B.RAIN_BARREL_1]);
    for (const id of [B.WELL, B.POWDER_KEG, B.AIR, B.BED, 255]) expect(barrelPots(id)).toBe(-1);
  });

  it('it fills only in the rain, under the open sky: a pot every 240 s ÷ the rain reaching it, up to three; the sun takes nothing', () => {
    /** Mean seconds a pot, over `n` barrels filled from empty in rain `rain`. */
    const meanFill = (rain, seed, n = 300) => {
      const refill = new Refill();
      for (let i = 0; i < n; i++) refill.track(i * 3, 70, 0, B.RAIN_BARREL);
      const rnd = mulberry32(seed);
      let t = 0;
      let pots = 0;
      let last = 0;
      for (; refill.size > 0 && t < 100 * BARREL_FILL_MEAN_S; t++) {
        for (const ev of refill.step(1, rnd, loaded, env(DRYNESS_DRY, rain))) {
          expect(ev.to).toBe(ev.from + 1);
          pots++;
          last = t;
        }
      }
      expect(pots).toBe(n * BARREL_POTS); // every barrel stops at three, and is then forgotten
      expect(refill.size).toBe(0);
      void last;
      return { t, pots };
    };
    // the time for the LAST of n barrels to gain its third pot is long; measure the rate early instead: pots in the first 240 s
    const rate = (rain, seed, n = 600) => {
      const refill = new Refill();
      for (let i = 0; i < n; i++) refill.track(i * 3, 70, 0, B.RAIN_BARREL);
      const rnd = mulberry32(seed);
      let pots = 0;
      for (let t = 0; t < 120; t++) pots += refill.step(1, rnd, loaded, env(DRYNESS_DRY, rain)).length;
      return pots / n / 120; // pots a second a barrel
    };
    expect(rate(1, 31)).toBeGreaterThan((1 / 240) * 0.85);
    expect(rate(1, 31)).toBeLessThan((1 / 240) * 1.15);
    expect(rate(0.5, 32)).toBeGreaterThan((1 / 480) * 0.8);
    expect(rate(0.5, 32)).toBeLessThan((1 / 480) * 1.2);
    expect(rate(LEAF_COVER, 33)).toBeLessThan((1 / 240) * 0.5); // under leaves: about a third
    expect(meanFill(1, 34).pots).toBe(900);
    // no rain: nothing, however long — and a barrel that holds water keeps every pot of it through the driest season
    const refill = new Refill();
    refill.track(0, 70, 0, B.RAIN_BARREL);
    refill.track(3, 70, 0, B.RAIN_BARREL_2);
    const rnd = mulberry32(35);
    for (let t = 0; t < 20 * DAY_LENGTH_SECONDS; t += 60) expect(refill.step(60, rnd, loaded, env(DRYNESS_DRY, 0))).toEqual([]);
    expect([...refill.cells.values()].map((c) => c.id)).toEqual([B.RAIN_BARREL, B.RAIN_BARREL_2]);
    // a full barrel is not tracked at all: nothing can happen to it
    expect(refill.track(6, 70, 0, B.RAIN_BARREL_3)).toBe(false);
    expect(isRefillBlock(B.RAIN_BARREL_3)).toBe(false);
  });

  it('"the rain reaching it" is the real rain rule: none under a roof (glass too), a third under leaves, none where it snows', () => {
    const weather = createWeather(7);
    weather.force('rain');
    const w = land();
    w.set(0, 10, 0, B.RAIN_BARREL);
    const reach = () => rainReaching(weather, 0, w, 0, 10, 0);
    expect(reach()).toBe(1);
    w.set(0, 14, 0, B.OAK_LEAVES);
    expect(reach()).toBe(LEAF_COVER);
    w.set(0, 13, 0, B.GLASS);
    expect(reach()).toBe(0);
    w.set(0, 13, 0, B.AIR);
    w.set(0, 14, 0, B.OAK_PLANKS);
    expect(reach()).toBe(0);
    w.set(0, 14, 0, B.AIR);
    w.getBiome = () => BIOME.SNOWY;
    expect(reach()).toBe(0); // snow fills no barrel
    // and with that rain as the env, a roofed barrel never fills while an open one does
    const sky = land();
    sky.set(0, 10, 0, B.RAIN_BARREL);
    sky.set(9, 10, 0, B.RAIN_BARREL);
    sky.set(9, 12, 0, B.COBBLESTONE);
    const refill = new Refill();
    refill.track(0, 10, 0, B.RAIN_BARREL);
    refill.track(9, 10, 0, B.RAIN_BARREL);
    const e = { dryness: () => 1, biome: () => BIOME.PLAINS, rain: (q, y, r) => rainReaching(weather, 0, sky, q, y, r) };
    const rnd = mulberry32(36);
    let done = { springs: 0, wells: 0, barrels: 0 };
    for (let t = 0; t < 30 * BARREL_FILL_MEAN_S; t++) {
      const d = homesteadSecondOn(1, rnd, { world: sky, refill, isLoadedCell: loaded, env: e });
      done = { springs: done.springs + d.springs, wells: done.wells + d.wells, barrels: done.barrels + d.barrels };
      for (const c of refill.cells.values()) c.id = sky.getBlock(c.q, c.y, c.r); // (main's onBlockChange)
    }
    expect([sky.getBlock(0, 10, 0), sky.getBlock(9, 10, 0)]).toEqual([B.RAIN_BARREL_3, B.RAIN_BARREL]);
    expect(done).toEqual({ springs: 0, wells: 0, barrels: 3 });
  });

  it('it stores water and gives it back: a pot of water, boiled water or spring water is poured in; an empty pot takes one out as fresh raw water', () => {
    expect([...WATERING_POTS]).toEqual(['pot_water', 'pot_boiled', 'pot_spring']);
    expect(EMPTY_POT).toBe('clay_pot');
    // pour: one pot more, the empty pot comes back, until it is full
    for (const sel of WATERING_POTS) {
      expect(homesteadAction(B.RAIN_BARREL, sel, 0, 0, 0)).toEqual({ kind: 'draw', q: 0, y: 0, r: 0, source: 'barrel', mode: 'pour', gives: 'clay_pot', to: B.RAIN_BARREL_1, hint: 'Rain Barrel · empty · R: pour it in' });
      expect(homesteadAction(B.RAIN_BARREL_2, sel, 0, 0, 0)).toMatchObject({ kind: 'draw', mode: 'pour', to: B.RAIN_BARREL_3, hint: 'Rain Barrel · 2 pots of 3 · R: pour it in' });
      expect(homesteadAction(B.RAIN_BARREL_3, sel, 0, 0, 0)).toEqual({ kind: 'homestead_hint', q: 0, y: 0, r: 0, source: 'barrel', hint: 'Rain Barrel · 3 pots of 3 · full' });
    }
    // take: one pot fewer, a Pot of Water whatever went in (boiled or spring water becomes ordinary fresh water)
    expect(homesteadAction(B.RAIN_BARREL_3, 'clay_pot', 0, 0, 0)).toEqual({ kind: 'draw', q: 0, y: 0, r: 0, source: 'barrel', mode: 'fill', gives: 'pot_water', to: B.RAIN_BARREL_2, hint: 'Rain Barrel · 3 pots of 3 · R: fill the pot' });
    expect(homesteadAction(B.RAIN_BARREL_1, 'clay_pot', 0, 0, 0)).toMatchObject({ kind: 'draw', mode: 'fill', gives: 'pot_water', to: B.RAIN_BARREL, hint: 'Rain Barrel · 1 pot of 3 · R: fill the pot' });
    expect(homesteadAction(B.RAIN_BARREL, 'clay_pot', 0, 0, 0)).toEqual({ kind: 'homestead_hint', q: 0, y: 0, r: 0, source: 'barrel', hint: 'Rain Barrel · empty: it fills in the rain' });
    // tainted and salt water are not taken; with anything else in hand the barrel says what it holds
    for (const sel of ['pot_tainted', 'pot_seawater', 'pot_milk', null, 'stick']) {
      expect(homesteadAction(B.RAIN_BARREL_2, sel, 0, 0, 0), String(sel)).toEqual({ kind: 'homestead_hint', q: 0, y: 0, r: 0, source: 'barrel', hint: 'Rain Barrel · 2 pots of 3 · R with an empty pot: take water' });
      expect(homesteadAction(B.RAIN_BARREL, sel, 0, 0, 0).hint, String(sel)).toBe('Rain Barrel · empty: it fills in the rain');
    }
    // three pots in, three pots out: nothing is made and nothing is lost
    let id = B.RAIN_BARREL;
    for (const sel of ['pot_boiled', 'pot_spring', 'pot_water']) id = homesteadAction(id, sel, 0, 0, 0).to;
    expect(id).toBe(B.RAIN_BARREL_3);
    const out = [];
    for (let i = 0; i < 4; i++) {
      const act = homesteadAction(id, 'clay_pot', 0, 0, 0);
      if (act.kind !== 'draw') break;
      out.push(act.gives);
      id = act.to;
    }
    expect([out, id]).toEqual([['pot_water', 'pot_water', 'pot_water'], B.RAIN_BARREL]);
  });

  it('water in a barrel does not spoil: it is the block, not an item — only a pot taken out begins to stand', () => {
    expect(getItem('pot_water').food.spoilS).toBe(2 * DAY_LENGTH_SECONDS); // in a pot it turns tainted
    // nothing in the barrel's life can lower it or taint it: the step only ever adds, and there is no tainted barrel
    const refill = new Refill();
    refill.track(0, 70, 0, B.RAIN_BARREL_1);
    const rnd = mulberry32(40);
    const seen = new Set();
    for (let t = 0; t < 30 * DAY_LENGTH_SECONDS; t += 30) for (const ev of refill.step(30, rnd, loaded, env(DRYNESS_DRY, t % 7200 < 600 ? 0.6 : 0))) seen.add(`${ev.from}>${ev.to}`);
    expect([...seen].sort()).toEqual([`${B.RAIN_BARREL_1}>${B.RAIN_BARREL_2}`, `${B.RAIN_BARREL_2}>${B.RAIN_BARREL_3}`]);
    expect(BLOCKS.filter((d) => /barrel/.test(d.name)).map((d) => d.id)).toEqual(BARRELS); // (the Powder Keg is `powder_keg`)
  });

  it('breaking a barrel that holds water spills it: the barrel comes back empty, the water is gone', () => {
    const axe = getItem('flint_axe').tool;
    for (const id of BARRELS) {
      for (const tool of [null, axe]) expect(rollDrops(id, tool, { natural: false }, () => 0.5), name(id)).toEqual([{ k: 'rain_barrel', n: 1 }]);
    }
    expect(getItem('rain_barrel').block).toBe(B.RAIN_BARREL); // the item sets down an EMPTY barrel
    expect(barrelPots(getItem('rain_barrel').block)).toBe(0);
  });
});

describe('what the tracker follows (homestead.Refill)', () => {
  it('drawn springs, every well, barrels with room — found again in the edits, kept in step by onBlockChange, frozen in unloaded chunks', () => {
    expect([...REFILL_IDS]).toEqual([B.SPRING_DRAWN, B.WELL, B.WELL_DRAWN, B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2]);
    expect(Array.from({ length: 256 }, (_, i) => i).filter(isRefillBlock)).toEqual([...REFILL_IDS].sort((a, b) => a - b));
    expect(MAX_REFILL_TRACKED).toBe(1024);
    const refill = new Refill();
    for (const id of [B.SPRING, B.RAIN_BARREL_3, B.STONE, B.BED, B.GRASS_BED, B.AIR, NaN]) expect(refill.track(0, 1, 0, id)).toBe(false);
    // World.edits: chunk key → Map(local index → id); local index = (lq * 16 + lr) * 128 + y
    const li = (lq, y, lr) => (lq * 16 + lr) * 128 + y;
    const edits = new Map([
      ['0,0', new Map([[li(1, 70, 2), B.SPRING_DRAWN], [li(3, 70, 4), B.WELL], [li(5, 71, 6), B.STONE], [li(7, 70, 8), B.RAIN_BARREL_3]])],
      ['-1,2', new Map([[li(0, 64, 15), B.WELL_DRAWN], [li(9, 64, 9), B.RAIN_BARREL_1], [li(2, 64, 2), B.BED]])],
    ]);
    refill.track(99, 9, 99, B.WELL); // forgotten by a load
    refill.loadFromEdits(edits);
    expect([...refill.cells.values()].map((c) => [c.q, c.y, c.r, c.id]).sort((a, b) => a[3] - b[3])).toEqual([
      [1, 70, 2, B.SPRING_DRAWN], [3, 70, 4, B.WELL], [-16, 64, 47, B.WELL_DRAWN], [-7, 64, 41, B.RAIN_BARREL_1],
    ]);
    // onBlockChange: a draw, a refill, a pour, a break
    refill.onBlockChange(3, 70, 4, B.WELL, B.WELL_DRAWN);
    expect(refill.cells.get('3,70,4').id).toBe(B.WELL_DRAWN);
    refill.onBlockChange(1, 70, 2, B.SPRING_DRAWN, B.SPRING);
    expect(refill.has(1, 70, 2)).toBe(false);
    refill.onBlockChange(-7, 64, 41, B.RAIN_BARREL_1, B.RAIN_BARREL_2);
    refill.onBlockChange(-7, 64, 41, B.RAIN_BARREL_2, B.RAIN_BARREL_3);
    expect(refill.has(-7, 64, 41)).toBe(false);
    refill.onBlockChange(-7, 64, 41, B.RAIN_BARREL_3, B.RAIN_BARREL_2);
    expect(refill.has(-7, 64, 41)).toBe(true);
    refill.onBlockChange(-16, 64, 47, B.WELL_DRAWN, B.AIR);
    expect(refill.size).toBe(2);
    // unloaded: no roll, nothing happens; dt 0: nothing
    const none = seq(0, 0, 0);
    expect(refill.step(1, none, () => false, env(DRYNESS_RAINS, 1))).toEqual([]);
    expect(none.drawn()).toBe(0);
    expect(refill.step(0, none, loaded, env(DRYNESS_RAINS, 1))).toEqual([]);
    expect(refill.step(1, none, loaded, env(DRYNESS_RAINS, 1)).map((e) => e.to).sort()).toEqual([B.WELL, B.RAIN_BARREL_3].sort());
    refill.clear();
    expect(refill.size).toBe(0);
    // it never follows more than MAX_REFILL_TRACKED cells; a known cell still takes a new id
    for (let i = 0; i < MAX_REFILL_TRACKED + 5; i++) refill.track(i, 70, 0, B.RAIN_BARREL);
    expect(refill.size).toBe(MAX_REFILL_TRACKED);
    expect(refill.track(0, 70, 0, B.RAIN_BARREL_1)).toBe(true);
  });

  it('homesteadSecondOn writes each event lazily, and only into a cell that still holds what it was', () => {
    const w = land();
    const writes = [];
    const world = { getBlock: w.getBlock, setBlock: (q, y, r, id, lazy) => (writes.push([q, y, r, id, lazy]), w.set(q, y, r, id)) };
    w.set(0, 10, 0, B.SPRING_DRAWN);
    w.set(5, 10, 0, B.WELL_DRAWN);
    w.set(9, 10, 0, B.STONE); // the tracker thinks a drawn well stands here: somebody broke it meanwhile
    const refill = new Refill();
    refill.track(0, 10, 0, B.SPRING_DRAWN);
    refill.track(5, 10, 0, B.WELL_DRAWN);
    refill.track(40, 10, 0, B.WELL_DRAWN);
    w.set(40, 10, 0, B.STONE);
    expect(homesteadSecondOn(1, () => 0, { world, refill, isLoadedCell: loaded, env: env() })).toEqual({ springs: 1, wells: 1, barrels: 0 });
    expect(writes).toEqual([[0, 10, 0, B.SPRING, true], [5, 10, 0, B.WELL, true]]);
    expect(w.getBlock(40, 10, 0)).toBe(B.STONE);
  });
});

describe('watering by hand (farming.handWater)', () => {
  const field = (id = B.PLANTED_CARROT) => {
    const w = land();
    w.set(0, 10, 0, id);
    return w;
  };

  it('one pot is half a game day of watered growth at once: the growth roll for 720 s', () => {
    expect(HAND_WATER_S).toBe(720);
    expect(HAND_WATER_S * 2).toBe(DAY_LENGTH_SECONDS);
    expect(handWaterChance(B.PLANTED_CARROT)).toBe(HAND_WATER_S / SPROUT_MEAN_S.watered);
    expect(handWaterChance(B.CARROT_SPROUT)).toBe(HAND_WATER_S / GROW_MEAN_S.watered);
    expect([handWaterChance(B.PLANTED_CATTAILS), handWaterChance(B.HAZEL_SPROUT)]).toEqual([0.5, 0.25]);
    for (const id of [B.CARROT_PLANT, B.GRASS_BLOCK, B.AIR, B.WELL]) expect(handWaterChance(id)).toBe(0);
    // it is exactly the roll Growth.step makes for a watered cell over that time
    const growth = new Growth();
    const w = field();
    w.set(1, 9, 0, B.WATER);
    growth.track(0, 10, 0, B.PLANTED_CARROT);
    expect(growth.step(HAND_WATER_S, seq(0.4999, 0.5), loaded, w.getBlock)).toHaveLength(1);
    growth.track(0, 10, 0, B.PLANTED_CARROT);
    expect(growth.step(HAND_WATER_S, seq(0.5), loaded, w.getBlock)).toHaveLength(0);
  });

  it('a planted seed: its moment comes one time in two, then it takes like any watered seed; a sprout grows up one time in four', () => {
    const carrot = cropOf('carrot');
    const w = field();
    expect(handWater(w.getBlock, 0, 10, 0, seq(0.4999, 0.79))).toEqual({ ok: true, event: { q: 0, y: 10, r: 0, from: B.PLANTED_CARROT, to: B.CARROT_SPROUT, crop: carrot, took: true } });
    expect(handWater(w.getBlock, 0, 10, 0, seq(0.4999, SEED_TAKES.watered))).toEqual({ ok: true, event: { q: 0, y: 10, r: 0, from: B.PLANTED_CARROT, to: B.AIR, crop: carrot, took: false } });
    const miss = seq(0.5);
    expect(handWater(w.getBlock, 0, 10, 0, miss)).toEqual({ ok: true, event: null }); // the water is used, nothing shows
    expect(miss.drawn()).toBe(1);
    const s = field(B.CARROT_SPROUT);
    const hit = seq(0.2499);
    expect(handWater(s.getBlock, 0, 10, 0, hit)).toEqual({ ok: true, event: { q: 0, y: 10, r: 0, from: B.CARROT_SPROUT, to: B.CARROT_PLANT, crop: carrot, took: true } });
    expect(hit.drawn()).toBe(1); // a sprout has taken already: one roll
    expect(handWater(s.getBlock, 0, 10, 0, seq(0.25)).event).toBeNull();
    // a bush grows up picked, as it does by itself
    expect(handWater(field(B.HAZEL_SPROUT).getBlock, 0, 10, 0, seq(0)).event.to).toBe(B.HAZEL_THICKET_BARE);
    // by simulation: 4 000 pots on seeds — two in five sprout, one in ten fails, half show nothing
    const rnd = mulberry32(50);
    const n = { sprout: 0, fail: 0, none: 0 };
    for (let i = 0; i < 4000; i++) {
      const res = handWater(w.getBlock, 0, 10, 0, rnd);
      if (!res.event) n.none++;
      else if (res.event.took) n.sprout++;
      else n.fail++;
    }
    expect(n.sprout / 4000).toBeGreaterThan(0.4 - 0.03);
    expect(n.sprout / 4000).toBeLessThan(0.4 + 0.03);
    expect(n.fail / 4000).toBeGreaterThan(0.1 - 0.02);
    expect(n.fail / 4000).toBeLessThan(0.1 + 0.02);
  });

  it('water cannot give what it is not: no open sky, or a reed with no water to stand in, and the pot is not poured', () => {
    const roofed = field();
    roofed.set(0, 14, 0, B.COBBLESTONE);
    const none = seq(0, 0);
    expect(handWater(roofed.getBlock, 0, 10, 0, none)).toEqual({ ok: false, why: 'sky', event: null });
    const reed = field(B.PLANTED_CATTAILS);
    expect(handWater(reed.getBlock, 0, 10, 0, none)).toEqual({ ok: false, why: 'reed', event: null });
    expect(none.drawn()).toBe(0);
    reed.set(1, 9, 0, B.WATER);
    expect(handWater(reed.getBlock, 0, 10, 0, seq(0, 0)).event.to).toBe(B.CATTAILS_SPROUT);
    // leaves and glass are no roof for a crop
    const glass = field();
    glass.set(0, 12, 0, B.GLASS);
    expect(handWater(glass.getBlock, 0, 10, 0, seq(0.9)).ok).toBe(true);
    // not a farm block: nothing to water
    for (const id of [B.CARROT_PLANT, B.GRASS_BLOCK, B.AIR, B.TUSSOCK]) expect(handWater(field(id).getBlock, 0, 10, 0, seq(0)), name(id)).toBeNull();
  });

  it('R with a Pot of Water, of Boiled Water or of Spring Water on a planted cell or a sprout waters it; tainted and salt water cannot', () => {
    for (const sel of WATERING_POTS) {
      for (const id of [B.PLANTED_CARROT, B.ONION_SPROUT, B.PLANTED_PRICKLY_PEAR, B.CATTAILS_SPROUT]) {
        expect(rOn(id, sel), `${sel} on ${name(id)}`).toEqual({ kind: 'water_crop', q: 3, y: 10, r: -2, key: sel, id });
      }
      // a grown plant is picked as before, and soil is not watered
      expect(rOn(B.CARROT_PLANT, sel).kind).toBe('pick');
      expect(rOn(B.GRASS_BLOCK, sel)).toBeNull();
    }
    for (const sel of ['pot_tainted', 'pot_seawater', 'pot_milk', 'pot_sap', 'clay_pot', 'carrot_seeds', null]) {
      expect(rOn(B.PLANTED_CARROT, sel), String(sel)).toBeNull();
    }
    // main: the pot is used only when it was poured, the empty pot comes back, the hint ends `R: water it`
    const at = main.indexOf('  function waterCrop(');
    const body = main.slice(at, main.indexOf('\n  }\n', at));
    expect(body).toContain('const res = handWater(world.getBlock, q, y, r, Math.random);');
    expect(body.indexOf('if (!res.ok) {')).toBeLessThan(body.indexOf('pack.consume(selected, 1);'));
    expect(body.indexOf('pack.consume(selected, 1);')).toBeLessThan(body.indexOf('giveToHand(EMPTY_POT);'));
    expect(body).toContain('logLine(failLine(ev.crop))');
    expect(main).toContain("return text && !/ needs /.test(text) ? `${text} · R: water it` : text;");
  });
});

describe('the dug cistern, built by a player from bare ground (CONTRACTS §83.6, §85)', () => {
  const G = 9; // the ground's top
  /** The world the water cycle reads: flat generated earth, with a player's edits on top. */
  function yard() {
    /** @type {Map<string, number>} */
    const edits = new Map();
    const origin = (_q, y, _r) => (y < 0 || y >= 32 ? B.AIR : y === G ? B.GRASS_BLOCK : y < G ? B.DIRT : B.AIR);
    const peek = (q, y, r) => (Math.max(Math.abs(q), Math.abs(r)) > 40 ? UNLOADED : edits.get(`${q},${y},${r}`) ?? origin(q, y, r));
    return {
      peek,
      getBlock: peek,
      originAt: origin,
      isLoadedCell: (q, r) => Math.max(Math.abs(q), Math.abs(r)) <= 40,
      saltyAt: () => false,
      q: 0,
      r: 0,
      top: 31,
      set: (q, y, r, id) => edits.set(`${q},${y},${r}`, id),
      apply(writes) {
        for (let i = 0; i < writes.length; i += 4) edits.set(`${writes[i]},${writes[i + 1]},${writes[i + 2]}`, writes[i + 3]);
      },
    };
  }
  const RAIN = { rain: () => 1, dryness: () => DRYNESS_RAINS };
  const DRY = { rain: () => 0, dryness: () => DRYNESS_DRY };

  it('everything it takes is in a player\'s reach: clay dug with the first shovel, pressed into blocks by hand, set down as a block', () => {
    const shovel = getItem('wooden_shovel').tool;
    expect(getRecipe('wooden_shovel').station).toBe('hand');
    expect(canHarvest(B.CLAY, null)).toBe(false);
    expect(canHarvest(B.CLAY, shovel)).toBe(true);
    const lumps = rollDrops(B.CLAY, shovel, { natural: true }, () => 0.5);
    expect(lumps).toEqual([{ k: 'clay_lump', n: 6 }]);
    const clay = getRecipe('clay');
    expect([clay.station, clay.inputs, clay.outputs, clay.tools]).toEqual(['hand', [{ k: 'clay_lump', n: 6 }], [{ k: 'clay', n: 1 }], []]);
    expect(getItem('clay')).toMatchObject({ kind: 'block', block: B.CLAY }); // one dug cell of clay is one Clay block to lay
    expect(useActionOf({ k: 'clay', n: 1 })).toEqual({ kind: 'place', key: 'clay', block: B.CLAY });
    expect(placeRefusal(land().getBlock, B.CLAY, 0, 9, 0)).toBeNull();
    // the pit is dug by hand: grass and dirt need no tool
    expect(canHarvest(B.GRASS_BLOCK, null) && canHarvest(B.DIRT, null)).toBe(true);
  });

  it('dig seven cells, floor them with clay, wait for rain: it fills, it is fresh, it waters the field, it is drunk from, it dries', () => {
    const w = yard();
    const cells = pondCells(0, 0);
    // 1. the player digs the pit: seven cells of the surface …
    for (const [q, r] of cells) w.set(q, G, r, B.AIR);
    expect(clayBasinAt(w, 0, G, 0)).toBeNull(); // on dirt: the rain sinks away
    // 2. … and the earth under them, and lays Clay there
    for (const [q, r] of cells) w.set(q, G - 1, r, B.CLAY);
    expect(clayBasinAt(w, 0, G, 0)).toMatchObject({ count: 7, tainted: false });
    // 3. dry weather brings nothing
    const rnd = mulberry32(60);
    for (let t = 0; t < 3 * DAY_LENGTH_SECONDS; t++) expect(cycleStep(1, rnd, w, DRY)).toBeNull();
    // 4. rain: its first water, shallow; then a depth at a time until it is full
    const kinds = [];
    let t = 0;
    for (; t < 60 * FILL_MEAN_S && kinds.length < 3; t++) {
      const ev = cycleStep(1, rnd, w, RAIN);
      if (!ev) continue;
      kinds.push(ev.kind);
      w.apply(ev.writes);
    }
    expect(kinds).toEqual(['basin', 'fill', 'fill']);
    expect(t).toBeLessThan(12 * FILL_MEAN_S); // three events of 360 s each on average
    expect(cells.map(([q, r]) => w.peek(q, G, r))).toEqual(Array(7).fill(B.WATER));
    expect(cycleStep(1, () => 0, w, RAIN)).toBeNull(); // full: the rain adds no more
    // 5. it is a pool like any other: contained, fresh (raw), full
    expect(waterBodyAt(w.peek, 0, G, 0)).toMatchObject({ count: 7, contained: true, depth: 3, sea: false });
    const info = waterAt(w, 0, G, 0);
    expect([info.quality, info.depth, info.sea, info.stream]).toEqual(['fresh', 3, false, false]);
    // 6. it waters a seed planted beside it, up to FARM_WATER_REACH cells away
    const quality = (q, y, r) => waterAt(w, q, y, r).quality;
    w.set(1 + FARM_WATER_REACH, G + 1, 0, B.PLANTED_CARROT);
    w.set(2 + FARM_WATER_REACH, G + 1, 0, B.PLANTED_CARROT);
    const carrot = cropOf('carrot');
    expect(cropState(w.getBlock, quality, 1 + FARM_WATER_REACH, G + 1, 0, carrot).watered).toBe(true);
    expect(cropState(w.getBlock, quality, 2 + FARM_WATER_REACH, G + 1, 0, carrot).watered).toBe(false);
    // 7. a pot is filled from it with R, and the pots come out of it: 7 cells × 6 gulps a depth, 4 gulps a pot
    const act = interactKind({
      hit: { q: 0, y: G - 1, r: 0, blockId: B.CLAY, distance: 3 }, waterHit: { q: 0, y: G, r: 0, blockId: B.WATER, distance: 2 },
      selectedKey: 'clay_pot', pack, waterQuality: quality, waterDepth: (q, y, r) => waterAt(w, q, y, r).depth,
    });
    expect(act).toMatchObject({ kind: 'fill', quality: 'fresh', hint: 'Fresh water · full · R: fill the pot' });
    let pots = 0;
    const draw = mulberry32(61);
    while (waterAt(w, 0, G, 0) !== null && pots < 400) {
      const d = drawWater(w, 0, G, 0, POT_GULPS, draw);
      if (d.dropped) w.apply(d.writes);
      pots++;
    }
    expect(pots).toBeGreaterThan((3 * 7 * CELL_GULPS) / POT_GULPS * 0.5); // about 31 pots in all
    expect(pots).toBeLessThan((3 * 7 * CELL_GULPS) / POT_GULPS * 1.6);
    expect(cells.map(([q, r]) => w.peek(q, G, r))).toEqual(Array(7).fill(B.AIR));
    // 8. the next rain fills it again; the dry season then takes it back, a depth about every three game days
    for (let s = 0, n = 0; s < 60 * FILL_MEAN_S && n < 3; s++) {
      const ev = cycleStep(1, rnd, w, RAIN);
      if (ev) { w.apply(ev.writes); n++; }
    }
    expect(waterAt(w, 0, G, 0).depth).toBe(3);
    let dried = 0;
    let s = 0;
    for (; s < 40 * DRY_MEAN_S && waterAt(w, 0, G, 0) !== null; s++) {
      const ev = cycleStep(1, rnd, w, DRY);
      if (ev) { expect(ev.kind).toBe('dry'); w.apply(ev.writes); dried++; }
    }
    expect(dried).toBe(3);
    expect(s).toBeGreaterThan(DRY_MEAN_S); // it lasts days, not minutes
    // 9. a well or a barrel in its wall holds it (they are solid); a bed does not
    const wall = yard();
    for (const [q, r] of cells) { wall.set(q, G, r, B.AIR); wall.set(q, G - 1, r, B.CLAY); }
    wall.set(2, G, 0, B.WELL);
    wall.set(-2, G, 0, B.RAIN_BARREL_2);
    expect(clayBasinAt(wall, 0, G, 0)).toMatchObject({ count: 7 });
    wall.set(2, G, 0, B.BED);
    expect(clayBasinAt(wall, 0, G, 0)).toBeNull();
  });
});

describe('main wires it in (read from the source: main needs a browser)', () => {
  /** The body of a function of main's closure. */
  const body = (fn) => {
    const at = main.indexOf(`  function ${fn}(`);
    expect(at, fn).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('one Refill a session: fed by onBlockChange, found again in the edits, cleared with the rest', () => {
    expect(main).toMatch(/^ {2}const refill = new Refill\(\);$/m);
    const changed = body('onBlockChanged');
    expect(changed).toContain('refill.onBlockChange(q, y, r, prev, next)');
    expect(changed.indexOf('refill.onBlockChange(')).toBeLessThan(changed.indexOf('blockPhysics.onBlockChange(')); // physics sees the trackers updated
    expect(body('loadSurvival')).toContain('refill.loadFromEdits(world.edits)');
    expect(body('clearSurvival')).toContain('refill.clear();');
  });

  it('once a second, in Survival only, after the water cycle; the well and the barrel live in the water cycle\'s own weather', () => {
    const step = body('stepSurvival');
    const second = step.slice(step.indexOf('if (survivalSecond >= 1) {'));
    expect(second.indexOf('homesteadSecond(1, Math.random)')).toBeGreaterThan(second.indexOf('waterSecond(1, Math.random)'));
    expect(second.indexOf('homesteadSecond(1, Math.random)')).toBeLessThan(second.indexOf('pack.spoil(1, Math.random)'));
    expect((main.match(/homesteadSecond\(1, Math\.random/g) ?? []).length).toBe(2); // there, and in the debug handle's homesteadStep
    expect(body('homesteadSecond')).toContain('homesteadSecondOn(dt, random, { world: /** @type {World} */ (world), refill, isLoadedCell: isLoadedCellFn, env })');
    expect(main).toMatch(/const homesteadEnv = \{\n\s+dryness: \(\) => waterEnv\.dryness\(\),\n\s+biome: \(q, r\) => .*getBiome\(q, r\),\n\s+rain: \(q, y, r\) => rainOnCell\(q, y, r\),\n\s+\};/);
  });

  it('R: `draw` and `water_crop` each go to a function of their own; every condition is checked again before anything changes', () => {
    const interact = body('doInteract');
    expect(interact).toMatch(/case 'draw':\n\s+homesteadDraw\(.*\(act\)\);/);
    expect(interact).toMatch(/case 'water_crop':\n\s+waterCrop\(act\);/);
    const draw = body('homesteadDraw');
    expect(draw).toContain('const now = homesteadAction(world.getBlock(q, y, r), selectedKey(), q, y, r);');
    expect(draw).toContain("if (!now || now.kind !== 'draw' || now.mode !== act.mode) return;");
    // a drink waits for the gulp gap and writes the block before the body drinks; a fill or a pour changes the pot only when the block changed
    expect(draw).toContain('if (fxTime - gulpAt < GULP_GAP_S || !playerSetBlock(q, y, r, to)) return;');
    expect(draw.indexOf('if (!playerSetBlock(q, y, r, to)) return;')).toBeLessThan(draw.indexOf('pack.consume(selected, 1);'));
    expect(draw).toContain('giveToHand(/** @type {string} */ (now.gives));');
    // the hints: the action's own (the default branch), and the crop's with `R: water it`
    const hint = body('survivalHintText');
    expect(hint).toMatch(/case 'water_crop':\n\s+return waterCropHint\(act\);/);
    // drawing is done on the press, never repeated while R is held
    expect(main).toContain("const R_REPEATS = new Set(['fire_put', 'fire_feed', 'drink', 'drink_here']);");
  });

  it('the debug handle: the tracker, and time for it alone', () => {
    const refill = new Refill();
    const calls = [];
    const game = { refill, homesteadStep: (seconds, e) => (calls.push([seconds, e]), { seconds, springs: 1, wells: 2, barrels: 3 }) };
    const win = {};
    const handle = installDebugHandle(win, /** @type {*} */ (game));
    expect(win.__caelancraft).toBe(handle);
    expect(handle.refill).toBe(refill);
    expect(handle.homesteadStep(600, { rain: 1, dryness: 0.3 })).toEqual({ seconds: 600, springs: 1, wells: 2, barrels: 3 });
    expect(calls).toEqual([[600, { rain: 1, dryness: 0.3 }]]);
    expect(installDebugHandle({}, null).homesteadStep(5)).toBeNull();
    expect(installDebugHandle({}, null).refill).toBeNull();
    expect(main).toMatch(/\n {4}refill,\n/);
    const at = main.indexOf('    homesteadStep(seconds, env) {');
    expect(at).toBeGreaterThan(0);
    const fn = main.slice(at, main.indexOf('\n    },\n', at));
    expect(fn).toContain('Math.min(WATER_STEP_MAX_S, Math.floor(seconds))');
    expect(fn).toContain('const done = homesteadSecond(1, Math.random, weather);');
    expect(fn).toContain('const total = { seconds: n, springs: 0, wells: 0, barrels: 0 };');
  });
});
