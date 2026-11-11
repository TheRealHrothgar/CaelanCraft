// Unit tests for src/climate.js — air, felt and target body temperature, heat sources, drying and salt water
// (docs/DESIGN-survival.md §3, §4.1).
import { describe, it, expect } from 'vitest';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { hexToWorld } from '../../src/hex.js';
import {
  BIOME_SHIFT, DIURNAL_AMPLITUDE, HEAT_SOURCES, HEAT_CAP, GROUND_CHILL, CHILL_GROUND_IDS, ACTIVITY_HEAT, SUN_HEAT,
  SHELTER_HEAT, WET_CHILL, CAMPFIRE_HEAT_Y, STATION_HEAT_Y, CHEST_HEIGHT, DIURNAL_PEAK_T, WET_DRY_S,
  baseTemperature, diurnalSwing, altitudeTerm, airTemperature, waterTemperature, sunFactor, isDaytime, heatAt, heatSource,
  groundChillOf, activityHeat, dryingRate, feltTemperature, bodyTarget, isSaltyBiome,
} from '../../src/climate.js';

const H = (h, m = 0) => (h + m / 60) / 24; // day fraction of a clock time
const NOON2 = H(14);
const NIGHT2 = H(2);
const TOL = 0.2; // §3.4: air, felt and target within ±0.2 °C
const near = (actual, expected, label) => expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`)
  .toBeLessThanOrEqual(TOL);

/** A §3.4 row's climate input: feet at y = 64, unclothed, standing still, open sky (unless the row says otherwise). */
function row(over) {
  return {
    biome: BIOME.PLAINS, climateT: 0, feetY: 64, time: NOON2, openSky: true, underground: false, inWater: false, wet: 0,
    heat: 0, groundChill: 0, insulation: 0, sunShade: 0, activityHeat: 0, ...over,
  };
}

describe('the §3.4 worked examples (air, felt and target ±0.2 °C)', () => {
  const snowyGround = groundChillOf(BLOCK.SNOWY_GRASS);
  // A campfire 1.5 cells from the chest (measured to fire.y + 0.3).
  const fire = heatSource('campfire', 0, 63, 0);
  const campfireHeat = heatAt([fire], fire.x + 1.5, fire.y, fire.z);
  const rows = [
    ['Plains 14:00', row({}), 18, 21.5, 37],
    ['Plains 02:00', row({ time: NIGHT2 }), 6, 6, 35.8],
    ['Plains 02:00 under a roof', row({ time: NIGHT2, openSky: false }), 6, 9, 36.7],
    ['Desert 14:00', row({ biome: BIOME.DESERT, climateT: 0.5 }), 39, 42.5, 39.5],
    ['Desert 14:00 sprinting', row({ biome: BIOME.DESERT, climateT: 0.5, activityHeat: ACTIVITY_HEAT.sprint }), 39, 46.5, 40.3],
    ['Desert 02:00', row({ biome: BIOME.DESERT, climateT: 0.5, time: NIGHT2 }), 15, 15, 37],
    ['Snowy 14:00', row({ biome: BIOME.SNOWY, climateT: -0.6, groundChill: snowyGround }), 0.8, 2.3, 34.7],
    ['Snowy 02:00', row({ biome: BIOME.SNOWY, climateT: -0.6, time: NIGHT2, groundChill: snowyGround }), -11.2, -13.2, 30.0],
    ['Snowy 02:00 in leather (I 10)', row({
      biome: BIOME.SNOWY, climateT: -0.6, time: NIGHT2, groundChill: snowyGround, insulation: 10,
    }), -11.2, -3.2, 33.0],
    ['… + campfire 1.5 away', row({
      biome: BIOME.SNOWY, climateT: -0.6, time: NIGHT2, groundChill: snowyGround, insulation: 10, heat: campfireHeat,
    }), -11.2, 8.0, 36.4],
    ['Plains cave', row({ openSky: false, underground: true, time: NIGHT2 }), 12, 12, 37],
    ['Snowy cave', row({ biome: BIOME.SNOWY, climateT: -0.6, openSky: false, underground: true }), -5.2, -2.2, 33.3],
    ['Desert cave', row({ biome: BIOME.DESERT, climateT: 0.5, openSky: false, underground: true }), 27, 27, 37],
  ];
  for (const [label, inp, air, felt, target] of rows) {
    it(label, () => {
      const t = feltTemperature(inp);
      near(t.air, air, `${label} air`);
      near(t.felt, felt, `${label} felt`);
      near(bodyTarget(t.felt, false), target, `${label} target`);
    });
  }

  it('the campfire row: 20 · (1 − 1.5/6)² = 11.25 °C', () => {
    expect(campfireHeat).toBeCloseTo(11.25, 9);
  });

  it('water rows: Plains water 10 → felt 12 → 33.8; Snowy water 1 → felt 3 → 30.2 (at any time of day)', () => {
    for (const time of [NOON2, NIGHT2, 0.3]) {
      const plains = feltTemperature(row({ inWater: true, time }));
      near(waterTemperature(BIOME.PLAINS, 0), 10, 'plains water');
      near(plains.felt, 12, 'plains felt');
      near(bodyTarget(plains.felt, true), 33.8, 'plains target');
      const snowy = feltTemperature(row({ biome: BIOME.SNOWY, climateT: -0.6, inWater: true, time, groundChill: -2 }));
      near(waterTemperature(BIOME.SNOWY, -0.6), 1, 'snowy water');
      near(snowy.felt, 3, 'snowy felt');
      near(bodyTarget(snowy.felt, true), 30.2, 'snowy target');
    }
  });
});

describe('air temperature (§3.1)', () => {
  it('base = 12 + 22·T with the biome shifts; the sea evens it out halfway to 16', () => {
    expect(baseTemperature(BIOME.PLAINS, 0)).toBe(12);
    expect(baseTemperature(BIOME.PLAINS, -1)).toBe(-10);
    expect(baseTemperature(BIOME.FOREST, 1)).toBe(34);
    expect(baseTemperature(BIOME.DESERT, 0)).toBe(16);
    expect(baseTemperature(BIOME.SNOWY, 0)).toBe(8);
    expect(baseTemperature(BIOME.MOUNTAINS, 0.5)).toBe(23);
    expect(baseTemperature(BIOME.OCEAN, 1)).toBe(25);
    expect(baseTemperature(BIOME.BEACH, -1)).toBe(3);
    expect(BIOME_SHIFT).toEqual([0, 0, 0, 0, 4, -4, 0, 0]);
    expect(baseTemperature(BIOME.PLAINS, NaN)).toBe(12);
    expect(baseTemperature(99, 0)).toBe(12); // an unknown biome has no shift
  });

  it('the diurnal swing peaks at 14:00 and bottoms out at 02:00 with the biome amplitude', () => {
    expect(DIURNAL_AMPLITUDE).toEqual([2, 3, 6, 5, 12, 6, 7, 7]);
    expect(DIURNAL_PEAK_T).toBeCloseTo(0.5833, 4);
    const names = ['OCEAN', 'BEACH', 'PLAINS', 'FOREST', 'DESERT', 'SNOWY', 'MOUNTAINS', 'SNOWY_PEAKS'];
    names.forEach((n, i) => {
      expect(diurnalSwing(BIOME[n], NOON2), n).toBeCloseTo(DIURNAL_AMPLITUDE[i], 9);
      expect(diurnalSwing(BIOME[n], NIGHT2), n).toBeCloseTo(-DIURNAL_AMPLITUDE[i], 9);
      expect(diurnalSwing(BIOME[n], H(8)), n).toBeCloseTo(0, 9);
    });
    expect(diurnalSwing(BIOME.PLAINS, NOON2 + 3)).toBeCloseTo(6, 9); // wraps
    expect(diurnalSwing(99, NOON2)).toBe(0);
  });

  it('altitude cools 0.25 °C per cell above 64, never warms below it', () => {
    expect(altitudeTerm(64)).toBe(-0);
    expect(altitudeTerm(30)).toBe(-0);
    expect(altitudeTerm(104)).toBe(-10);
    expect(airTemperature(BIOME.MOUNTAINS, 0, 104, H(8), false)).toBeCloseTo(2, 9);
  });

  it('underground air is the daily mean: no swing and no altitude', () => {
    for (const t of [NOON2, NIGHT2, H(9)]) {
      expect(airTemperature(BIOME.DESERT, 0.5, 30, t, true)).toBe(27);
      expect(airTemperature(BIOME.MOUNTAINS, 0, 110, t, true)).toBe(12);
    }
    expect(airTemperature(BIOME.DESERT, 0.5, 64, NOON2, false)).toBeCloseTo(39, 9);
  });

  it('water is the mean − 2, clamped to 1..26', () => {
    expect(waterTemperature(BIOME.PLAINS, 0)).toBe(10);
    expect(waterTemperature(BIOME.DESERT, 1)).toBe(26);
    expect(waterTemperature(BIOME.SNOWY, -1)).toBe(1);
  });

  it('salt water: OCEAN and BEACH only', () => {
    for (const [n, id] of Object.entries(BIOME)) expect(isSaltyBiome(id), n).toBe(n === 'OCEAN' || n === 'BEACH');
    expect(isSaltyBiome(/** @type {*} */ (undefined))).toBe(false);
  });
});

describe('sun, day and heat sources (§3.2)', () => {
  it('sunFactor is 0 at night, 1 at noon and sin(π(t − sunrise)/(sunset − sunrise)) in between (v0.11: 04:30–19:30)', () => {
    expect(sunFactor(0.5)).toBeCloseTo(1, 12);
    expect(sunFactor(H(4, 30))).toBe(0);
    expect(sunFactor(H(19, 30))).toBe(0);
    expect(sunFactor(H(2))).toBe(0);
    expect(sunFactor(H(22))).toBe(0);
    expect(sunFactor(H(9))).toBeCloseTo(Math.sin((Math.PI * (H(9) - H(4, 30))) / (H(19, 30) - H(4, 30))), 12);
    expect(sunFactor(H(6))).toBeGreaterThan(0); // sunlit since v0.11
    expect(sunFactor(1.5)).toBeCloseTo(1, 12); // wraps
    expect(sunFactor(NaN)).toBe(0);
    expect(isDaytime(H(4, 30))).toBe(true);
    expect(isDaytime(H(19, 29))).toBe(true);
    expect(isDaytime(H(19, 30))).toBe(false);
    expect(isDaytime(H(3))).toBe(false);
  });

  it('heatAt sums heat·(1 − d/r)², ignores sources at or beyond their radius, caps at 30', () => {
    expect(HEAT_SOURCES).toEqual({
      campfire: { heat: 20, radius: 6 }, kiln: { heat: 12, radius: 4 }, bloomery: { heat: 16, radius: 4 },
      forge: { heat: 22, radius: 5 },
    });
    const at = (x, kind = 'campfire') => ({ x, y: 0, z: 0, ...HEAT_SOURCES[kind] });
    expect(heatAt([at(0)], 0, 0, 0)).toBe(20);
    expect(heatAt([at(3)], 0, 0, 0)).toBeCloseTo(5, 12);
    expect(heatAt([at(6)], 0, 0, 0)).toBe(0);
    expect(heatAt([at(10)], 0, 0, 0)).toBe(0);
    expect(heatAt([at(0), at(0, 'forge')], 0, 0, 0)).toBe(HEAT_CAP);
    expect(heatAt([at(1, 'kiln'), at(-1, 'bloomery')], 0, 0, 0)).toBeCloseTo(12 * 0.5625 + 16 * 0.5625, 12);
    // Distance is 3-D: a fire two cells below the chest.
    expect(heatAt([{ x: 0, y: -2, z: 0, heat: 20, radius: 6 }], 0, 0, 0)).toBeCloseTo(20 * (4 / 6) ** 2, 12);
    expect(heatAt(null, 0, 0, 0)).toBe(0);
    expect(heatAt([], 0, 0, 0)).toBe(0);
    expect(heatAt([null, { x: NaN, y: 0, z: 0, heat: 20, radius: 6 }, { x: 0, y: 0, z: 0, heat: 20, radius: 0 }], 0, 0, 0))
      .toBe(0);
    // Any iterable works (main passes a generator over the burning fires).
    function* gen() {
      yield at(0, 'kiln');
    }
    expect(heatAt(gen(), 0, 0, 0)).toBe(12);
  });

  it('heatSource: a campfire at its flames (y + 0.3), a workplace at its cell centre; unknown kinds null', () => {
    const [x, z] = hexToWorld(-3, 5);
    expect(heatSource('campfire', -3, 40, 5)).toEqual({ x, y: 40 + CAMPFIRE_HEAT_Y, z, heat: 20, radius: 6 });
    expect(heatSource('forge', -3, 40, 5)).toEqual({ x, y: 40 + STATION_HEAT_Y, z, heat: 22, radius: 5 });
    expect(heatSource('kiln', 0, 0, 0)).toMatchObject({ heat: 12, radius: 4 });
    expect(heatSource('bloomery', 0, 0, 0)).toMatchObject({ heat: 16, radius: 4 });
    expect(heatSource(/** @type {*} */ ('hand'), 0, 0, 0)).toBeNull();
    expect(heatSource(/** @type {*} */ ('__proto__'), 0, 0, 0)).toBeNull();
    expect(CHEST_HEIGHT).toBe(1);
  });

  it('the ground chill is −2 on snow and ice only', () => {
    expect(GROUND_CHILL).toBe(-2);
    for (let id = 0; id < 256; id++) {
      expect(groundChillOf(id)).toBe(CHILL_GROUND_IDS.includes(id) ? -2 : 0);
    }
    expect([...CHILL_GROUND_IDS].sort((a, b) => a - b))
      .toEqual([BLOCK.SNOW_BLOCK, BLOCK.SNOWY_GRASS, BLOCK.ICE, BLOCK.PACKED_ICE].sort((a, b) => a - b));
  });

  it('exertion: the largest of walking +1, breaking +2, swimming +2, sprinting +4', () => {
    expect(activityHeat({})).toBe(0);
    expect(activityHeat({ moving: true })).toBe(1);
    expect(activityHeat({ breaking: true })).toBe(2);
    expect(activityHeat({ swimming: true })).toBe(2);
    expect(activityHeat({ sprinting: true })).toBe(4);
    expect(activityHeat({ moving: true, breaking: true, sprinting: true, swimming: true })).toBe(4);
    expect(activityHeat({ moving: true, swimming: true })).toBe(2);
  });

  it('drying: (1 + heat/5) · (open sky by day ? 2 : 1) / 90 per second', () => {
    expect(dryingRate(0, false, NOON2)).toBeCloseTo(1 / WET_DRY_S, 12);
    expect(dryingRate(0, true, NOON2)).toBeCloseTo(2 / 90, 12);
    expect(dryingRate(0, true, NIGHT2)).toBeCloseTo(1 / 90, 12);
    expect(dryingRate(10, false, NIGHT2)).toBeCloseTo(3 / 90, 12);
    expect(dryingRate(10, true, 0.5)).toBeCloseTo(6 / 90, 12);
    expect(dryingRate(-5, false, 0)).toBeCloseTo(1 / 90, 12);
    expect(dryingRate(NaN, false, 0)).toBeCloseTo(1 / 90, 12);
  });
});

describe('felt temperature (§3.2)', () => {
  it('the sun only under open sky, by day, shaded by the hat', () => {
    const open = feltTemperature(row({ time: 0.5 })).felt;
    const roof = feltTemperature(row({ time: 0.5, openSky: false })).felt;
    expect(open - roof).toBeCloseTo(SUN_HEAT, 9); // air 17.8 ≥ 10: no shelter bonus
    const hat = feltTemperature(row({ time: 0.5, sunShade: 0.5 })).felt;
    expect(open - hat).toBeCloseTo(SUN_HEAT / 2, 9);
    const fullShade = feltTemperature(row({ time: 0.5, sunShade: 3 })).felt;
    expect(fullShade).toBeCloseTo(roof, 9); // shade clamps to 1
    const night = feltTemperature(row({ time: H(23) }));
    expect(night.felt).toBeCloseTo(night.air, 9);
  });

  it('shelter: +3 without open sky when the air is below 10, underground too', () => {
    const t = row({ biome: BIOME.SNOWY, climateT: 0, time: NIGHT2 }); // air 2
    expect(feltTemperature({ ...t, openSky: false }).felt - feltTemperature(t).felt).toBeCloseTo(SHELTER_HEAT, 9);
    const cave = feltTemperature({ ...t, openSky: false, underground: true });
    expect(cave.air).toBe(8);
    expect(cave.felt).toBe(11);
    const warm = row({ time: NOON2 }); // air 18
    expect(feltTemperature({ ...warm, openSky: false }).felt).toBeCloseTo(18, 9);
    const mild = feltTemperature(row({ openSky: false, underground: true, climateT: -0.1 })); // air 9.8
    expect(mild.felt).toBeCloseTo(12.8, 9);
  });

  it('insulation counts fully below 15 °C air, ×0.4 from 25 °C, and × (1 − 0.5·wet) when wet', () => {
    const cold = row({ time: NIGHT2, insulation: 10 }); // air 6
    expect(feltTemperature(cold).felt - feltTemperature({ ...cold, insulation: 0 }).felt).toBeCloseTo(10, 9);
    const hot = row({ biome: BIOME.DESERT, climateT: 0.5, insulation: 10, openSky: false }); // air 39
    expect(feltTemperature(hot).felt - feltTemperature({ ...hot, insulation: 0 }).felt).toBeCloseTo(4, 9);
    const mid = row({ climateT: 0.2, time: H(8), insulation: 10 }); // air 16.4 + swing(8:00) = 16.4
    const air = feltTemperature(mid).air;
    const w = (air - 15) / 10;
    expect(feltTemperature(mid).felt - feltTemperature({ ...mid, insulation: 0 }).felt).toBeCloseTo(10 * (1 - 0.6 * w), 9);
    const wet = { ...cold, wet: 0.5 };
    expect(feltTemperature(wet).felt - feltTemperature({ ...wet, insulation: 0 }).felt).toBeCloseTo(10 * 0.75, 9);
  });

  it('wet skin feels 6·wet colder; heat is capped at 30; exertion and the ground add', () => {
    const t = row({ time: NIGHT2 });
    expect(feltTemperature(t).felt - feltTemperature({ ...t, wet: 1 }).felt).toBeCloseTo(WET_CHILL, 9);
    expect(feltTemperature({ ...t, wet: 5 }).felt).toBeCloseTo(feltTemperature({ ...t, wet: 1 }).felt, 9);
    expect(feltTemperature({ ...t, heat: 50 }).felt - feltTemperature(t).felt).toBeCloseTo(30, 9);
    expect(feltTemperature({ ...t, heat: -5 }).felt).toBeCloseTo(feltTemperature(t).felt, 9);
    expect(feltTemperature({ ...t, activityHeat: 4 }).felt - feltTemperature(t).felt).toBeCloseTo(4, 9);
    expect(feltTemperature({ ...t, groundChill: -2 }).felt - feltTemperature(t).felt).toBeCloseTo(-2, 9);
    expect(feltTemperature({ ...t, groundChill: true }).felt - feltTemperature(t).felt).toBeCloseTo(GROUND_CHILL, 9);
    expect(feltTemperature({ ...t, groundChill: false }).felt).toBeCloseTo(feltTemperature(t).felt, 9);
  });

  it('in water only the water, a quarter of the insulation and +2 count', () => {
    const base = row({ inWater: true, time: NOON2 });
    expect(feltTemperature(base).felt).toBe(12);
    expect(feltTemperature({ ...base, insulation: 8 }).felt).toBe(14);
    const ignored = { ...base, heat: 20, activityHeat: 4, groundChill: -2, wet: 1, sunShade: 1, openSky: false };
    expect(feltTemperature(ignored).felt).toBe(12);
    expect(feltTemperature(base).air).toBeCloseTo(18, 9); // the air is still reported (F3)
  });

  it('defaults: an empty input is plains at midnight, sea-level feet, nothing else', () => {
    const t = feltTemperature({});
    const air = 12 + 6 * Math.cos(2 * Math.PI * (0 - 14 / 24));
    expect(t.air).toBeCloseTo(air, 9);
    expect(t.felt).toBeCloseTo(air + 3, 9); // no open sky and air < 10: sheltered
    expect(Number.isFinite(feltTemperature({ biome: BIOME.DESERT, climateT: NaN, feetY: NaN, time: NaN }).felt)).toBe(true);
  });
});

describe('body target (§3.3)', () => {
  it('37 in the comfort band, 37 − 0.3·(10 − felt) below it, 37 + 0.2·(felt − 30) above it', () => {
    expect(bodyTarget(10, false)).toBe(37);
    expect(bodyTarget(20, false)).toBe(37);
    expect(bodyTarget(30, false)).toBe(37);
    expect(bodyTarget(0, false)).toBeCloseTo(34, 12);
    expect(bodyTarget(-20, false)).toBeCloseTo(28, 12);
    expect(bodyTarget(40, false)).toBeCloseTo(39, 12);
    expect(bodyTarget(55, false)).toBeCloseTo(42, 12);
  });

  it('in water the comfort floor is 20 and the slope 0.4', () => {
    expect(bodyTarget(20, true)).toBe(37);
    expect(bodyTarget(15, true)).toBeCloseTo(35, 12);
    expect(bodyTarget(10, true)).toBeCloseTo(33, 12);
    expect(bodyTarget(35, true)).toBeCloseTo(38, 12);
    expect(bodyTarget(NaN, true)).toBe(37);
  });
});
