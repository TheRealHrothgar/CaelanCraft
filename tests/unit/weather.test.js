// src/weather.js (CONTRACTS §84): the calendar (a year of 28 game days, the rains and the dry season, the dryness that
// turns smoothly), the words the HUD and the log use, the rain's showers (the share of the time it rains by biome and
// season, by simulation over many years and seeds; deterministic; coming on and dying away gradually), rainedWithin and
// nextChange, what the rain reaches (rainExposure, rainColumn), the sky under an overcast, and the water system's env.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  YEAR_DAYS, FAIR_START_DAYS, RAINS_DAYS, DRY_DAYS, DRYNESS_RAINS, DRYNESS_DRY, SEASON_TURN_DAYS, SEASON_NAMES, SEASON_LINES, RAIN_SHARE,
  SHOWER_SLOT_S, SLOTS_PER_DAY, SHOWER_MIN_S, SHOWER_MAX_S, SHOWER_RAMP_S, SHOWER_PEAK_MIN, SHOWER_SWELL_MIN, SHOWER_MEAN_S,
  RAINS_DEAL_DAYS, RAINS_MAX_DRY_DAYS, NEXT_CHANGE_HORIZON_S, LEAF_COVER, WATER_SURFACE_DROP, OVERCAST_GREY, OVERCAST_SUN_LOSS, OVERCAST_SKY_LOSS,
  OVERCAST_TAU_S,
  worldSeconds, yearDay, drynessAt, seasonOf, calendarLine, weatherWord, hudLine, seasonNews, fallsAsSnow, rainShare,
  showerChance, createWeather, weatherEnv, rainExposure, rainColumn, rainReaching, rainedOnCell, rainSky, approach,
} from '../../src/weather.js';
import { BIOME, BLOCK } from '../../src/blocks.js';
import { DAY_LENGTH_SECONDS, WORLD_HEIGHT, START_TIME } from '../../src/config.js';
import { computeSky, createSkyState } from '../../src/daynight.js';
import { makeGetBlock } from '../helpers/fixtures.js';

const B = BLOCK;
const DAY = DAY_LENGTH_SECONDS;
const YEAR = YEAR_DAYS * DAY;
const SEEDS = [1, 2, 3, 7, 42, 1234, 99999, 0xdeadbeef];
const YEARS = 30;
/** The first second of the rains and of the dry season of year `y` (from 0). */
/** The rains of year `y`, as [from, to] seconds; the world's first rains are counted from the end of the fair start. */
const rainsOf = (y) => [y * YEAR + (y === 0 ? FAIR_START_DAYS * DAY : 0), y * YEAR + RAINS_DAYS * DAY];
const dryOf = (y) => [y * YEAR + RAINS_DAYS * DAY, (y + 1) * YEAR];
/** The longest stretch without rain inside [from, to), in seconds. */
function longestDry(showers, from, to) {
  let longest = 0;
  let last = from;
  for (const s of showers) {
    longest = Math.max(longest, s.start - last);
    last = s.end;
  }
  return Math.max(longest, to - last);
}

describe('the calendar (§84)', () => {
  it('a year is 28 game days: the rains for the first 10, the dry season for the other 18', () => {
    expect(YEAR_DAYS).toBe(28);
    expect(RAINS_DAYS).toBe(10);
    expect(DRY_DAYS).toBe(18);
    expect(DAY).toBe(1440);
    expect(SEASON_NAMES).toEqual({ rains: 'The rains', dry: 'The dry season' });
    const keys = [];
    for (let day = 1; day <= YEAR_DAYS; day++) keys.push(seasonOf(day).key);
    expect(keys).toEqual([...Array(10).fill('rains'), ...Array(18).fill('dry')]);
  });

  it('a new world starts on the first day of the rains; the years repeat', () => {
    expect(seasonOf(1)).toMatchObject({ key: 'rains', name: 'The rains', dayOfSeason: 1, days: 10, daysLeft: 9, year: 1, dayOfYear: 1 });
    expect(seasonOf(10)).toMatchObject({ key: 'rains', dayOfSeason: 10, daysLeft: 0 });
    expect(seasonOf(11)).toMatchObject({ key: 'dry', name: 'The dry season', dayOfSeason: 1, days: 18, daysLeft: 17 });
    expect(seasonOf(12)).toMatchObject({ key: 'dry', dayOfSeason: 2 });
    expect(seasonOf(28)).toMatchObject({ key: 'dry', dayOfSeason: 18, daysLeft: 0, year: 1, dayOfYear: 28 });
    expect(seasonOf(29)).toMatchObject({ key: 'rains', dayOfSeason: 1, year: 2, dayOfYear: 1 });
    expect(seasonOf(28 * 7 + 11)).toMatchObject({ key: 'dry', dayOfSeason: 1, year: 8 });
    for (let day = 1; day <= 3 * YEAR_DAYS; day++) {
      const s = seasonOf(day);
      expect(s.dayOfSeason + s.daysLeft, `day ${day}`).toBe(s.days);
      expect(seasonOf(day + YEAR_DAYS)).toMatchObject({ key: s.key, dayOfSeason: s.dayOfSeason, year: s.year + 1 });
    }
  });

  it('the time of day may ride on the day as its fraction, and garbage is day 1', () => {
    expect(seasonOf(3.75)).toMatchObject({ key: 'rains', dayOfSeason: 3 });
    expect(seasonOf(10.999)).toMatchObject({ key: 'rains', dayOfSeason: 10 });
    expect(seasonOf(11.001)).toMatchObject({ key: 'dry', dayOfSeason: 1 });
    expect(seasonOf(NaN).key).toBe('dry'); // NaN counts as day 0: the day before day 1
    expect(yearDay(1)).toBe(0);
    expect(yearDay(1.5)).toBe(0.5);
    expect(yearDay(29)).toBe(0);
    expect(yearDay(0)).toBe(27);
  });

  it('the world clock: seconds since midnight before day 1, from the saved day and time', () => {
    expect(worldSeconds(1, 0)).toBe(0);
    expect(worldSeconds(1, START_TIME)).toBeCloseTo(START_TIME * DAY, 9);
    expect(worldSeconds(2, 0.5)).toBe(1.5 * DAY);
    expect(worldSeconds(29, 0)).toBe(YEAR);
    expect(worldSeconds(NaN, NaN)).toBe(-DAY);
    // the clock and the calendar agree: the season of a moment is the season of its day
    for (const [day, time] of [[1, 0.3], [10, 0.99], [11, 0], [28, 0.5], [57, 0.2]]) {
      expect(yearDay(day + time) * DAY).toBeCloseTo(worldSeconds(day, time) % YEAR, 6);
    }
  });

  it('dryness: 0.3 in the rains, 1 in the dry season, changing smoothly over the two days around each turn', () => {
    expect(DRYNESS_RAINS).toBe(0.3);
    expect(DRYNESS_DRY).toBe(1);
    expect(SEASON_TURN_DAYS).toBe(2);
    // flat in the middle of each season
    for (const day of [2, 3, 5.5, 9.9, 10]) expect(seasonOf(day).dryness, `day ${day}`).toBeCloseTo(0.3, 9);
    for (const day of [12, 13, 20, 27.9, 28]) expect(seasonOf(day).dryness, `day ${day}`).toBeCloseTo(1, 9);
    // halfway at each turn: midnight before day 11, and midnight before day 1 (= the end of day 28)
    expect(drynessAt(RAINS_DAYS)).toBeCloseTo(0.65, 9);
    expect(drynessAt(0)).toBeCloseTo(0.65, 9);
    expect(seasonOf(11).dryness).toBeCloseTo(0.65, 9);
    expect(seasonOf(1).dryness).toBeCloseTo(0.65, 9);
    expect(seasonOf(29).dryness).toBeCloseTo(0.65, 9);
    // a new world (day 1, 07:12) is already most of the way into the rains
    expect(seasonOf(1 + START_TIME).dryness).toBeLessThan(0.55);
    // smooth and monotone through each turn, and never outside the two values
    let last = seasonOf(10).dryness;
    let step = 0;
    for (let d = 10; d <= 12.0001; d += 1 / 240) {
      const v = seasonOf(d).dryness;
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      step = Math.max(step, v - last);
      last = v;
    }
    expect(last).toBeCloseTo(1, 9);
    expect(step).toBeLessThan(0.005); // six game minutes never move it by more than half a point
    last = seasonOf(28).dryness;
    for (let d = 28; d <= 30.0001; d += 1 / 240) {
      const v = seasonOf(d).dryness;
      expect(v).toBeLessThanOrEqual(last + 1e-12);
      last = v;
    }
    expect(last).toBeCloseTo(0.3, 9);
    for (let d = 1; d < 60; d += 0.137) {
      expect(seasonOf(d).dryness).toBeGreaterThanOrEqual(0.3 - 1e-12);
      expect(seasonOf(d).dryness).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe('the HUD line and the log lines (§84)', () => {
  it('the calendar line: the day, the season, the day of the season out of how many', () => {
    expect(calendarLine(12)).toBe('Day 12 · The dry season, day 2 of 18');
    expect(calendarLine(1)).toBe('Day 1 · The rains, day 1 of 10');
    expect(calendarLine(10)).toBe('Day 10 · The rains, day 10 of 10');
    expect(calendarLine(28)).toBe('Day 28 · The dry season, day 18 of 18');
    expect(calendarLine(29)).toBe('Day 29 · The rains, day 1 of 10');
    expect(calendarLine(12.7)).toBe(calendarLine(12));
    expect(calendarLine(-3)).toMatch(/^Day 1 · /);
  });

  it('the word Rain while it rains; Snow where it falls as snow; nothing when it is dry', () => {
    expect(weatherWord(0.4, BIOME.PLAINS)).toBe('Rain');
    expect(weatherWord(0.4, BIOME.DESERT)).toBe('Rain');
    expect(weatherWord(0.4, BIOME.SNOWY)).toBe('Snow');
    expect(weatherWord(0.4, BIOME.SNOWY_PEAKS)).toBe('Snow');
    expect(weatherWord(0, BIOME.PLAINS)).toBe('');
    expect(weatherWord(NaN, BIOME.PLAINS)).toBe('');
    expect(hudLine(3, 'Rain')).toBe('Day 3 · The rains, day 3 of 10 · Rain');
    expect(hudLine(12, '')).toBe('Day 12 · The dry season, day 2 of 18');
    expect(hudLine(12)).toBe(calendarLine(12));
    expect([BIOME.SNOWY, BIOME.SNOWY_PEAKS].every(fallsAsSnow)).toBe(true);
    for (const b of [BIOME.OCEAN, BIOME.BEACH, BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.MOUNTAINS]) expect(fallsAsSnow(b)).toBe(false);
  });

  it('the log: a line at each turn of the season, and a warning one day before the dry season', () => {
    expect(SEASON_LINES).toEqual({
      rains: 'The rains have come.',
      dry: 'The dry season has begun.',
      ending: 'The rains are ending. Water will be scarce.',
    });
    const told = {};
    for (let day = 2; day <= 2 * YEAR_DAYS + 1; day++) {
      const lines = seasonNews(day - 1, day);
      if (lines.length) told[day] = lines;
    }
    expect(told).toEqual({
      10: [SEASON_LINES.ending], // the last day of the rains: the dry season starts tomorrow
      11: [SEASON_LINES.dry],
      29: [SEASON_LINES.rains],
      38: [SEASON_LINES.ending],
      39: [SEASON_LINES.dry],
      57: [SEASON_LINES.rains],
    });
  });

  it('nothing on a load, on the same day, or when the day goes back; a jump tells where it landed', () => {
    expect(seasonNews(null, 11)).toEqual([]);
    expect(seasonNews(11, 11)).toEqual([]);
    expect(seasonNews(12, 11)).toEqual([]);
    expect(seasonNews(NaN, 11)).toEqual([]);
    expect(seasonNews(8, 13)).toEqual([SEASON_LINES.dry]); // over the turn in one go
    expect(seasonNews(20, 38)).toEqual([SEASON_LINES.rains, SEASON_LINES.ending]);
    expect(seasonNews(3, 5)).toEqual([]);
    expect(seasonNews(5, 5 + YEAR_DAYS)).toEqual([SEASON_LINES.rains]); // a whole year on: the same season, told anyway
  });
});

describe('rain: the share of the time it rains (§84)', () => {
  it('the table: forest wettest, the desert driest; snowy land gets its share as snow', () => {
    const pct = (b) => [Math.round(RAIN_SHARE[b].rains * 100), Math.round(RAIN_SHARE[b].dry * 100)];
    expect(pct(BIOME.FOREST)).toEqual([45, 5]);
    for (const b of [BIOME.PLAINS, BIOME.BEACH, BIOME.OCEAN]) expect(pct(b)).toEqual([35, 3]);
    expect(pct(BIOME.MOUNTAINS)).toEqual([40, 5]);
    expect(pct(BIOME.SNOWY)).toEqual([30, 5]);
    expect(pct(BIOME.SNOWY_PEAKS)).toEqual([30, 5]);
    expect(pct(BIOME.DESERT)).toEqual([8, 0]);
    expect(Object.keys(RAIN_SHARE).map(Number).sort()).toEqual(Object.values(BIOME).sort());
    expect(rainShare(99, 'rains')).toBe(rainShare(BIOME.PLAINS, 'rains')); // an unknown biome is plains
    expect(Object.isFrozen(RAIN_SHARE) && Object.isFrozen(RAIN_SHARE[BIOME.FOREST])).toBe(true);
  });

  it('showers: one may begin in each four-hour slot; one to four game hours long; the chance is share × slot / mean length', () => {
    expect(SHOWER_SLOT_S).toBe(240);
    expect(SLOTS_PER_DAY).toBe(6);
    expect([SHOWER_MIN_S, SHOWER_MAX_S]).toEqual([60, 240]); // one game hour is 60 s
    expect(SHOWER_MEAN_S.rains).toBe(150);
    expect(SHOWER_MEAN_S.dry).toBeCloseTo(204, 9);
    expect(showerChance(BIOME.PLAINS, 'rains')).toBeCloseTo(0.35 * 240 / 150, 9);
    expect(showerChance(BIOME.FOREST, 'rains')).toBeCloseTo(0.72, 9);
    expect(showerChance(BIOME.DESERT, 'dry')).toBe(0);
    for (const b of Object.values(BIOME)) for (const s of ['rains', 'dry']) expect(showerChance(b, s)).toBeLessThanOrEqual(1);
    // the forest's chance is the highest in both seasons: a shower anywhere is a shower in the forest
    for (const b of Object.values(BIOME)) for (const s of ['rains', 'dry']) expect(showerChance(b, s)).toBeLessThanOrEqual(showerChance(BIOME.FOREST, s));
  });

  it('by simulation over many years and seeds: every biome within a point of its share, in both seasons', () => {
    for (const biome of Object.values(BIOME)) {
      let rains = 0;
      let dry = 0;
      for (const seed of SEEDS) {
        const w = createWeather(seed);
        for (let y = 0; y < YEARS; y++) {
          for (const s of w.showers(...rainsOf(y), biome)) rains += s.end - s.start;
          for (const s of w.showers(...dryOf(y), biome)) dry += s.end - s.start;
        }
      }
      const n = SEEDS.length * YEARS;
      expect(rains / (n * RAINS_DAYS * DAY), `biome ${biome} in the rains`).toBeCloseTo(RAIN_SHARE[biome].rains, 2);
      expect(dry / (n * DRY_DAYS * DAY), `biome ${biome} in the dry season`).toBeCloseTo(RAIN_SHARE[biome].dry, 2);
    }
  });

  it('each single world stays within three points of the table, measured moment by moment', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const w = createWeather(seed);
      for (const biome of [BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY]) {
        const wet = { rains: 0, dry: 0 };
        const all = { rains: 0, dry: 0 };
        for (let t = 0.5; t < 12 * YEAR; t += 9.7) {
          const key = seasonOf(1 + t / DAY).key;
          all[key]++;
          if (w.rainAt(t, biome) > 0) wet[key]++;
        }
        expect(Math.abs(wet.rains / all.rains - RAIN_SHARE[biome].rains), `seed ${seed} biome ${biome} rains`).toBeLessThan(0.03);
        expect(Math.abs(wet.dry / all.dry - RAIN_SHARE[biome].dry), `seed ${seed} biome ${biome} dry`).toBeLessThan(0.03);
      }
    }
  });

  it('the desert never sees rain in the dry season', () => {
    for (const seed of SEEDS) {
      const w = createWeather(seed);
      for (let y = 0; y < YEARS; y++) expect(w.showers(...dryOf(y), BIOME.DESERT)).toEqual([]);
      for (let t = RAINS_DAYS * DAY + 1; t < YEAR; t += 61) expect(w.rainAt(t, BIOME.DESERT)).toBe(0);
    }
  });

  it('every shower lasts one to four game hours and lies inside its slot; in the dry season they are mostly long', () => {
    let rainsLen = 0;
    let rainsN = 0;
    let dryLen = 0;
    let dryN = 0;
    for (const seed of SEEDS) {
      const w = createWeather(seed);
      for (let y = 0; y < YEARS; y++) {
        for (const [span, dry] of [[rainsOf(y), false], [dryOf(y), true]]) {
          for (const s of w.showers(...span, BIOME.FOREST)) {
            const len = s.end - s.start;
            expect(len).toBeGreaterThanOrEqual(SHOWER_MIN_S - 1e-9);
            expect(len).toBeLessThanOrEqual(SHOWER_MAX_S + 1e-9);
            expect(Math.floor(s.start / SHOWER_SLOT_S)).toBe(Math.floor((s.end - 1e-6) / SHOWER_SLOT_S));
            expect(s.peak).toBeGreaterThanOrEqual(SHOWER_PEAK_MIN);
            expect(s.peak).toBeLessThanOrEqual(1);
            if (dry) {
              dryLen += len;
              dryN++;
            } else {
              rainsLen += len;
              rainsN++;
            }
          }
        }
      }
    }
    expect(rainsLen / rainsN).toBeGreaterThan(SHOWER_MEAN_S.rains - 6);
    expect(rainsLen / rainsN).toBeLessThan(SHOWER_MEAN_S.rains + 6);
    expect(dryLen / dryN).toBeGreaterThan(SHOWER_MEAN_S.dry - 6);
    expect(dryLen / dryN).toBeLessThan(SHOWER_MEAN_S.dry + 6);
  });

  it('a fair start: no shower in the first two days of a world, in any land; after them the rains break as in any year', () => {
    expect(FAIR_START_DAYS).toBe(2);
    for (const seed of SEEDS) {
      const w = createWeather(seed);
      for (const biome of Object.values(BIOME)) {
        for (let t = 0; t < FAIR_START_DAYS * DAY; t += 7) {
          if (w.rainAt(t, biome) !== 0) throw new Error(`seed ${seed} biome ${biome}: rain at ${t} s`);
        }
        expect(w.rainedWithin(FAIR_START_DAYS * DAY - 1, biome, FAIR_START_DAYS * DAY - 1), `${seed} ${biome}`).toBe(false);
      }
      // the rest of the first rains has showers, and the second year's first two days are not spared
      expect(w.showers(FAIR_START_DAYS * DAY, RAINS_DAYS * DAY, BIOME.PLAINS).length).toBeGreaterThan(8);
    }
    const spared = SEEDS.filter((seed) => createWeather(seed).showers(YEAR, YEAR + FAIR_START_DAYS * DAY, BIOME.FOREST).length === 0);
    expect(spared).toEqual([]);
    // the calendar is not moved: day 1 is still the first day of the rains
    expect(seasonOf(1)).toMatchObject({ key: 'rains', dayOfSeason: 1 });
  });

  it('the rains never go three days without rain (they do not even go two): plains, forest, mountains, beach, snow', () => {
    expect(RAINS_DEAL_DAYS).toBe(2);
    expect(RAINS_MAX_DRY_DAYS).toBe(3);
    // the promise holds wherever a two-day deal of 12 slots has five showers at least: every land but the desert
    for (const b of Object.values(BIOME)) expect(showerChance(b, 'rains') * 12 >= 5, `biome ${b}`).toBe(b !== BIOME.DESERT);
    for (const biome of [BIOME.PLAINS, BIOME.FOREST, BIOME.MOUNTAINS, BIOME.BEACH, BIOME.OCEAN, BIOME.SNOWY, BIOME.SNOWY_PEAKS]) {
      let worst = 0;
      for (const seed of SEEDS) {
        const w = createWeather(seed);
        for (let y = 0; y < YEARS; y++) worst = Math.max(worst, longestDry(w.showers(...rainsOf(y), biome), ...rainsOf(y)));
      }
      expect(worst / DAY, `biome ${biome}`).toBeLessThan(RAINS_MAX_DRY_DAYS);
      expect(worst / DAY, `biome ${biome}`).toBeLessThan(2);
    }
  });

  it('a dry season on the plains normally has a stretch of six days or more without rain, and always some rain', () => {
    let seasons = 0;
    let withStretch = 0;
    let count = 0;
    for (const seed of SEEDS) {
      const w = createWeather(seed);
      for (let y = 0; y < YEARS; y++) {
        const showers = w.showers(...dryOf(y), BIOME.PLAINS);
        seasons++;
        count += showers.length;
        if (longestDry(showers, ...dryOf(y)) >= 6 * DAY) withStretch++;
        expect(showers.length).toBeGreaterThanOrEqual(3); // three or four long showers: the dry season's whole rain
        expect(showers.length).toBeLessThanOrEqual(4);
      }
    }
    expect(withStretch / seasons).toBeGreaterThan(0.75); // four dry seasons in five, and more
    expect(count / seasons).toBeGreaterThan(3.5);
    expect(count / seasons).toBeLessThan(4.1);
  });

  it('a shower that reaches the desert reaches every land; the forest has every shower the plains have', () => {
    const w = createWeather(77);
    for (let t = 3; t < 3 * YEAR; t += 17) {
      const desert = w.rainAt(t, BIOME.DESERT);
      const plains = w.rainAt(t, BIOME.PLAINS);
      const forest = w.rainAt(t, BIOME.FOREST);
      if (desert > 0) expect(plains).toBe(desert);
      if (plains > 0) expect(forest).toBe(plains); // the same shower, the same strength
    }
  });
});

describe('rain: one weather for one world (§84)', () => {
  it('deterministic: the same seed and moment give the same rain, in any order of asking, on a fresh object', () => {
    const a = createWeather(4242);
    const b = createWeather(4242);
    const times = [];
    for (let t = 0; t < 2 * YEAR; t += 53) times.push(t);
    const forward = times.map((t) => a.rainAt(t, BIOME.PLAINS));
    const backward = [...times].reverse().map((t) => b.rainAt(t, BIOME.PLAINS)).reverse();
    expect(backward).toEqual(forward);
    expect(forward.some((v) => v > 0)).toBe(true);
    // far in the future and back again (the deals are forgotten and dealt again the same)
    for (let y = 0; y < 60; y++) a.rainAt(y * YEAR + 5, BIOME.FOREST);
    expect(times.map((t) => a.rainAt(t, BIOME.PLAINS))).toEqual(forward);
    expect(a.showers(0, YEAR, BIOME.FOREST)).toEqual(b.showers(0, YEAR, BIOME.FOREST));
  });

  it('different seeds give different weather; the seed is kept', () => {
    const a = createWeather(1);
    const b = createWeather(2);
    expect(a.seed).toBe(1);
    expect(a.showers(0, YEAR, BIOME.PLAINS)).not.toEqual(b.showers(0, YEAR, BIOME.PLAINS));
    let differ = 0;
    for (let t = 0; t < YEAR; t += 97) if ((a.rainAt(t, BIOME.PLAINS) > 0) !== (b.rainAt(t, BIOME.PLAINS) > 0)) differ++;
    expect(differ).toBeGreaterThan(20);
  });

  it('pure: no clock, no Math.random, no DOM in the module', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/weather.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|document\.|window\./);
    const real = Math.random;
    Math.random = () => {
      throw new Error('weather.js must not roll');
    };
    try {
      const w = createWeather(9);
      for (let t = 0; t < YEAR; t += 331) w.rainAt(t, BIOME.FOREST);
      w.rainedWithin(5000, BIOME.PLAINS, DAY);
      w.nextChange(0, BIOME.PLAINS);
    } finally {
      Math.random = real;
    }
  });

  it('odd times do no harm: before day 1, NaN, an unknown biome', () => {
    const w = createWeather(3);
    expect(w.rainAt(NaN, BIOME.PLAINS)).toBe(0);
    expect(w.rainAt(Infinity, BIOME.PLAINS)).toBe(0);
    for (let t = -3 * YEAR; t < 0; t += 211) {
      const v = w.rainAt(t, BIOME.PLAINS);
      expect(v >= 0 && v <= 1).toBe(true);
    }
    expect(w.showers(-YEAR, 0, BIOME.FOREST).length).toBeGreaterThan(20); // the year before day 1 has weather too
    expect(w.rainAt(500, 99)).toBe(w.rainAt(500, BIOME.PLAINS));
    expect(w.rainedWithin(NaN, BIOME.PLAINS, 10)).toBe(false);
    expect(w.nextChange(NaN, BIOME.PLAINS)).toBeNull();
  });
});

describe('rain: showers start and stop gradually (§84)', () => {
  const w = createWeather(11);
  const showers = w.showers(0, 3 * YEAR, BIOME.FOREST);

  it('a shower comes on over 20 seconds and dies away over 20: nothing at its ends, its full strength in between', () => {
    expect(SHOWER_RAMP_S).toBe(20);
    expect(showers.length).toBeGreaterThan(100);
    for (const s of showers.slice(0, 60)) {
      expect(w.rainAt(s.start, BIOME.FOREST)).toBe(0);
      expect(w.rainAt(s.end, BIOME.FOREST)).toBe(0);
      expect(w.rainAt(s.start + 0.5, BIOME.FOREST)).toBeLessThan(0.01);
      expect(w.rainAt(s.end - 0.5, BIOME.FOREST)).toBeLessThan(0.01);
      expect(w.rainAt(s.start + SHOWER_RAMP_S / 2, BIOME.FOREST)).toBeLessThanOrEqual(s.peak * 0.5 + 1e-9);
      const mid = w.rainAt((s.start + s.end) / 2, BIOME.FOREST);
      expect(mid).toBeGreaterThanOrEqual(s.peak * SHOWER_SWELL_MIN - 1e-9);
      expect(mid).toBeLessThanOrEqual(s.peak + 1e-9);
    }
  });

  it('the strength never jumps: a second never moves it by more than 0.08, anywhere in three years', () => {
    let last = w.rainAt(0, BIOME.FOREST);
    let jump = 0;
    let peak = 0;
    for (let t = 1; t < 3 * YEAR; t += 1) {
      const v = w.rainAt(t, BIOME.FOREST);
      jump = Math.max(jump, Math.abs(v - last));
      peak = Math.max(peak, v);
      last = v;
      expect(v >= 0 && v <= 1).toBe(true);
    }
    expect(jump).toBeLessThan(0.08);
    expect(peak).toBeGreaterThan(0.9); // and some showers are heavy
  });

  it('it rains exactly while a shower is on', () => {
    for (const s of showers.slice(0, 40)) {
      for (let t = s.start + 1; t < s.end - 1; t += 7) expect(w.rainAt(t, BIOME.FOREST), `t ${t}`).toBeGreaterThan(0);
    }
    for (let i = 1; i < 40; i++) {
      const gap = showers[i].start - showers[i - 1].end;
      if (gap > 2) expect(w.rainAt(showers[i - 1].end + gap / 2, BIOME.FOREST)).toBe(0);
    }
  });
});

describe('rain: rainedWithin and nextChange (§84)', () => {
  const w = createWeather(21);
  const all = w.showers(0, 2 * YEAR, BIOME.PLAINS);

  it('rainedWithin: rain fell at some moment of the last so many seconds', () => {
    const s = all[5];
    const before = all[4];
    expect(w.rainedWithin(s.start + 1, BIOME.PLAINS, 0)).toBe(true); // it is raining now
    expect(w.rainedWithin(s.end + 30, BIOME.PLAINS, 60)).toBe(true);
    expect(w.rainedWithin(s.end + 61, BIOME.PLAINS, 60)).toBe(false);
    expect(w.rainedWithin(s.start, BIOME.PLAINS, s.start - before.end - 1)).toBe(false); // not yet, and the last one is too old
    expect(w.rainedWithin(s.start, BIOME.PLAINS, s.start - before.end + 1)).toBe(true);
    expect(w.rainedWithin(s.end + 30, BIOME.PLAINS, -1)).toBe(false);
  });

  it('rainedWithin agrees with the showers, for a day at a time, all through a year', () => {
    for (let t = 100; t < YEAR; t += 613) {
      const expected = all.some((s) => s.start < t && s.end > t - DAY);
      expect(w.rainedWithin(t, BIOME.PLAINS, DAY), `t ${t}`).toBe(expected);
    }
    // in the rains a day never passes without rain on the forest's side of things; in the dry season most days do
    let dryDays = 0;
    for (let day = RAINS_DAYS + 2; day <= YEAR_DAYS; day++) if (!w.rainedWithin(day * DAY, BIOME.PLAINS, DAY)) dryDays++;
    expect(dryDays).toBeGreaterThan(10);
  });

  it('nextChange: when the rain next starts, and while it rains when it stops', () => {
    const s = all[3];
    const prev = all[2];
    const dryAt = (prev.end + s.start) / 2;
    if (s.start - prev.end > 1) expect(w.nextChange(dryAt, BIOME.PLAINS)).toEqual({ at: s.start, rain: true });
    expect(w.nextChange(s.start + 5, BIOME.PLAINS)).toEqual({ at: s.end, rain: false });
    // walking the changes visits every shower in order
    let t = 0;
    const seen = [];
    for (let i = 0; i < 40; i++) {
      const c = /** @type {{ at: number, rain: boolean }} */ (w.nextChange(t, BIOME.PLAINS));
      if (c.rain) seen.push(c.at);
      t = c.at;
    }
    expect(seen).toEqual(all.slice(0, seen.length).map((x) => x.start));
    expect(seen.length).toBeGreaterThanOrEqual(19);
  });

  it('nextChange looks across the dry season (the desert waits for the next rains), two years at the most', () => {
    const dry = RAINS_DAYS * DAY + 10;
    const next = /** @type {{ at: number, rain: boolean }} */ (w.nextChange(dry, BIOME.DESERT));
    expect(next.rain).toBe(true);
    expect(next.at).toBeGreaterThanOrEqual(YEAR); // not before the rains come back
    expect(next.at).toBeLessThan(YEAR + RAINS_DAYS * DAY);
    expect(NEXT_CHANGE_HORIZON_S).toBe(2 * YEAR);
  });
});

describe('forcing the weather (the debug handle\'s setWeather)', () => {
  it('rain: full strength everywhere, at once; dry: none anywhere; null: the real weather again', () => {
    const w = createWeather(5);
    const real = [];
    for (let t = 0; t < YEAR; t += 131) real.push(w.rainAt(t, BIOME.PLAINS));
    expect(w.forced).toBeNull();
    w.force('rain');
    expect(w.forced).toBe('rain');
    for (const b of Object.values(BIOME)) expect(w.rainAt(RAINS_DAYS * DAY + 500, b)).toBe(1); // the desert in the dry season too
    expect(w.rainedWithin(123, BIOME.DESERT, 0)).toBe(true);
    expect(w.nextChange(0, BIOME.PLAINS)).toBeNull();
    expect(w.showers(0, YEAR, BIOME.PLAINS)).toEqual([]);
    w.force('dry');
    expect(w.forced).toBe('dry');
    for (let t = 0; t < YEAR; t += 131) expect(w.rainAt(t, BIOME.FOREST)).toBe(0);
    expect(w.rainedWithin(5000, BIOME.FOREST, DAY)).toBe(false);
    w.force(null);
    expect(w.forced).toBeNull();
    const again = [];
    for (let t = 0; t < YEAR; t += 131) again.push(w.rainAt(t, BIOME.PLAINS));
    expect(again).toEqual(real);
    w.force(/** @type {*} */ ('hail'));
    expect(w.forced).toBeNull();
  });
});

describe('weatherEnv: what the water system is handed (§84)', () => {
  it('rain(q, r) is the weather at the column\'s biome now; dryness() the season\'s', () => {
    const w = createWeather(8);
    let now = 0;
    let day = 1;
    const biomeAt = (q) => (q < 0 ? BIOME.DESERT : BIOME.FOREST);
    const env = weatherEnv(w, () => now, () => day, biomeAt);
    expect(Object.keys(env).sort()).toEqual(['dryness', 'rain']);
    const s = w.showers(0, YEAR, BIOME.FOREST)[0];
    now = (s.start + s.end) / 2;
    expect(env.rain(3, 9)).toBe(w.rainAt(now, BIOME.FOREST));
    expect(env.rain(3, 9)).toBeGreaterThan(0);
    expect(env.rain(-3, 9)).toBe(w.rainAt(now, BIOME.DESERT));
    now = s.end + 0.001;
    expect(env.rain(3, 9)).toBe(0);
    expect(env.dryness()).toBeCloseTo(0.65, 9); // midnight before day 1
    day = 5;
    expect(env.dryness()).toBe(seasonOf(5).dryness);
    day = 20.5;
    expect(env.dryness()).toBeCloseTo(1, 9);
    w.force('rain');
    expect(env.rain(-3, 9)).toBe(1); // forcing drives the water system's rain too
  });
});

describe('what the rain reaches (§84)', () => {
  it('rainExposure: 1 under the open sky, LEAF_COVER under leaves, 0 under any roof (glass too) or under water', () => {
    expect(LEAF_COVER).toBe(0.35);
    const at = (cells) => rainExposure(makeGetBlock(cells), 0, 10, 0);
    expect(at({})).toBe(1);
    expect(at({ '0,10,0': B.OAK_PLANKS })).toBe(1); // the cell itself is no cover
    expect(at({ '0,9,0': B.STONE })).toBe(1);
    expect(at({ '0,11,0': B.OAK_PLANKS })).toBe(0);
    expect(at({ '0,90,0': B.STONE })).toBe(0); // however high
    expect(at({ '0,127,0': B.STONE })).toBe(0);
    expect(at({ '0,14,0': B.GLASS })).toBe(0); // light comes through glass; rain does not
    expect(at({ '0,14,0': B.OAK_LEAVES })).toBe(LEAF_COVER);
    expect(at({ '0,14,0': B.SPRUCE_LEAVES, '0,15,0': B.SPRUCE_LEAVES, '0,16,0': B.SPRUCE_LEAVES })).toBe(LEAF_COVER);
    expect(at({ '0,14,0': B.OAK_LEAVES, '0,20,0': B.OAK_LOG })).toBe(0); // a trunk above the leaves
    expect(at({ '0,12,0': B.WATER })).toBe(0);
    expect(at({ '0,11,0': B.TUSSOCK_GRASS, '0,12,0': B.TORCH })).toBe(1); // what is not solid is no cover
    expect(at({ '1,14,0': B.STONE })).toBe(1); // only its own column
    expect(rainExposure(makeGetBlock({ '0,50,0': B.STONE }), 0, 10, 0, 40)).toBe(1); // `top` bounds the look
    expect(rainExposure(makeGetBlock({}), 0, WORLD_HEIGHT - 1, 0)).toBe(1);
  });

  it('rainColumn: where the rain lands looking down: the roof, the ground or the water, and the canopy above it', () => {
    expect(rainColumn(makeGetBlock({}), 0, 0)).toEqual({ floor: 0, canopy: -1 });
    const ground = { '0,9,0': B.GRASS_BLOCK, '0,8,0': B.DIRT };
    expect(rainColumn(makeGetBlock(ground), 0, 0)).toEqual({ floor: 10, canopy: -1 });
    expect(rainColumn(makeGetBlock({ ...ground, '0,13,0': B.OAK_PLANKS }), 0, 0)).toEqual({ floor: 14, canopy: -1 }); // on the roof
    expect(rainColumn(makeGetBlock({ ...ground, '0,13,0': B.GLASS }), 0, 0)).toEqual({ floor: 14, canopy: -1 });
    expect(rainColumn(makeGetBlock({ ...ground, '0,15,0': B.OAK_LEAVES, '0,16,0': B.OAK_LEAVES }), 0, 0)).toEqual({ floor: 10, canopy: 17 });
    expect(rainColumn(makeGetBlock({ ...ground, '0,10,0': B.WATER }), 0, 0)).toEqual({ floor: 11 - WATER_SURFACE_DROP, canopy: -1 });
    expect(rainColumn(makeGetBlock({ ...ground, '0,10,0': B.TUSSOCK_GRASS, '0,11,0': B.CAMPFIRE }), 0, 0)).toEqual({ floor: 10, canopy: -1 });
    expect(rainColumn(makeGetBlock({ ...ground, '0,40,0': B.STONE }), 0, 0, 30)).toEqual({ floor: 10, canopy: -1 });
  });

  it('rainReaching and rainedOnCell: the weather at the column × the cover; snow reaches nothing', () => {
    const w = createWeather(31);
    const s = w.showers(0, YEAR, BIOME.PLAINS)[2];
    const now = (s.start + s.end) / 2;
    const rain = w.rainAt(now, BIOME.PLAINS);
    const world = (cells, biome = BIOME.PLAINS) => ({ getBlock: makeGetBlock(cells), getBiome: () => biome });
    expect(rainReaching(w, now, world({}), 0, 10, 0)).toBe(rain);
    expect(rainReaching(w, now, world({ '0,14,0': B.OAK_LEAVES }), 0, 10, 0)).toBeCloseTo(rain * LEAF_COVER, 12);
    expect(rainReaching(w, now, world({ '0,14,0': B.COBBLESTONE }), 0, 10, 0)).toBe(0);
    expect(rainReaching(w, now, world({}, BIOME.SNOWY), 0, 10, 0)).toBe(0); // it snows there: none of rain's effects
    expect(rainReaching(w, s.end + 1, world({}), 0, 10, 0)).toBe(0);
    expect(rainedOnCell(w, s.end + 100, world({}), 0, 10, 0, DAY)).toBe(true);
    expect(rainedOnCell(w, s.end + 100, world({ '0,14,0': B.OAK_LEAVES }), 0, 10, 0, DAY)).toBe(true); // leaves let it through
    expect(rainedOnCell(w, s.end + 100, world({ '0,14,0': B.OAK_PLANKS }), 0, 10, 0, DAY)).toBe(false);
    expect(rainedOnCell(w, s.end + 100, world({ '0,14,0': B.GLASS }), 0, 10, 0, DAY)).toBe(false);
    expect(rainedOnCell(w, s.end + 100, world({}, BIOME.SNOWY_PEAKS), 0, 10, 0, DAY)).toBe(false);
    w.force('dry');
    expect(rainedOnCell(w, s.end + 100, world({}), 0, 10, 0, DAY)).toBe(false);
  });
});

describe('the sky under rain (§84)', () => {
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const spread = (c) => Math.max(...c) - Math.min(...c);

  it('no overcast: an exact copy of the sky, and the sky itself is never touched', () => {
    for (const time of [0, 0.25, 0.5, 0.8]) {
      const sky = computeSky(time);
      const before = JSON.stringify(sky);
      const out = rainSky(sky, 0, createSkyState());
      expect(JSON.stringify(sky)).toBe(before);
      const { overcast, ...rest } = /** @type {*} */ (out);
      expect(overcast).toBe(0);
      expect(JSON.stringify(rest)).toBe(before);
      rainSky(sky, 1, createSkyState());
      expect(JSON.stringify(sky)).toBe(before);
    }
  });

  it('under rain the sky and the fog darken and grey, the sun gives less light, the stars go out', () => {
    for (const time of [0.3, 0.5, 0.7]) {
      const sky = computeSky(time);
      const out = rainSky(sky, 1, createSkyState());
      for (const k of ['zenithColor', 'horizonColor', 'fogColor']) {
        expect(lum(out[k]), `${k} darker at ${time}`).toBeLessThan(lum(sky[k]));
        expect(spread(out[k]), `${k} greyer at ${time}`).toBeLessThan(spread(sky[k]) * 0.4);
        for (const v of out[k]) expect(v >= 0 && v <= 1).toBe(true);
        expect(out[k][2]).toBeGreaterThanOrEqual(out[k][0]); // a blue-grey, never a brown
      }
      expect(out.sunIntensity).toBeCloseTo(sky.sunIntensity * (1 - OVERCAST_SUN_LOSS), 9);
      expect(out.hemiIntensity).toBeCloseTo(sky.hemiIntensity * (1 - OVERCAST_SKY_LOSS), 9);
      expect(out.daylight).toBe(sky.daylight); // the birds and the zombies keep the real daylight
      expect(out.isDay).toBe(sky.isDay);
      expect(out.sunDir).toEqual(sky.sunDir);
      expect(out.overcast).toBe(1);
    }
    const night = rainSky(computeSky(0), 1, createSkyState());
    expect(night.stars).toBe(0);
    expect(rainSky(computeSky(0), 0.5, createSkyState()).stars).toBeCloseTo(0.5, 9);
    expect(OVERCAST_GREY).toBeGreaterThan(0.5);
  });

  it('smoothly: the colours move in step with the overcast, and the overcast follows the rain over seconds', () => {
    const sky = computeSky(0.5);
    let last = rainSky(sky, 0, createSkyState()).zenithColor.slice();
    for (let o = 0.02; o <= 1.0001; o += 0.02) {
      const z = rainSky(sky, o, createSkyState()).zenithColor;
      for (let i = 0; i < 3; i++) expect(Math.abs(z[i] - last[i])).toBeLessThan(0.02);
      last = z.slice();
    }
    expect(rainSky(sky, 7, createSkyState()).overcast).toBe(1); // clamped
    expect(rainSky(sky, NaN, createSkyState()).overcast).toBe(0);
    // approach: a sixtieth of a second moves the overcast by under half a point; it arrives, and stays
    let level = 0;
    let step = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const next = approach(level, 1, 1 / 60, OVERCAST_TAU_S);
      step = Math.max(step, next - level);
      level = next;
    }
    expect(step).toBeLessThan(0.005);
    expect(level).toBe(1);
    expect(approach(0.5, 1, 0, 6)).toBe(0.5);
    expect(approach(0.5, 0, OVERCAST_TAU_S, OVERCAST_TAU_S)).toBeCloseTo(0.5 / Math.E, 9);
  });
});
