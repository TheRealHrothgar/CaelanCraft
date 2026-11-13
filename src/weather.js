// Caelancraft — the calendar and the weather (CONTRACTS §84): a year of a wet and a dry season, rain that comes in
// showers, what the rain reaches, how it greys the sky, and the words the HUD and the log use for all of it.
// PURE: no DOM, no clock, no Math.random. The weather is a function of the world's seed and the world's clock, so the
// same moment is the same weather on every machine and nothing of it is saved.
//
// The world's clock is main's day counter (1 on a new world, saved) and its time of day (the day fraction, saved):
// `worldSeconds(day, time)`. A year is YEAR_DAYS game days: the rains for the first RAINS_DAYS of them, the dry season
// for the rest. A new world begins on the first day of the rains.
//
// Rain is made of showers. Time is cut into slots of SHOWER_SLOT_S (four game hours, six a day). Every slot has one
// possible shower with a seeded start, length (one to four game hours), strength and rank; the shower falls on a biome
// when its rank is below that biome's chance for the season, so a shower that reaches the desert reaches everywhere, and
// the share of the time it rains is exactly the table's. The ranks are dealt like cards, not rolled: every two days of
// the rains hold each rank once (so the rains never go long without rain) and the whole dry season is one deal (so its
// few showers are long ones, far apart). A shower lies inside its slot and comes on and dies away over SHOWER_RAMP_S.
import { DAY_LENGTH_SECONDS, WORLD_HEIGHT } from './config.js';
import { BIOME, BLOCK, isLeaves, isLiquid, isSolid } from './blocks.js';
import { mulberry32, rand2 } from './noise.js';

/** @typedef {import('./types.js').SkyState} SkyState */
/** @typedef {'rains'|'dry'} SeasonKey */

// ---- The calendar -------------------------------------------------------------------------------------------------------

/** Game days in a year. */
export const YEAR_DAYS = 28;
/** The rains are the first days of the year; the dry season is the rest. */
export const RAINS_DAYS = 10;
export const DRY_DAYS = YEAR_DAYS - RAINS_DAYS;
/** How dry the land is (the water system's `dryness`): in the rains, in the dry season. */
export const DRYNESS_RAINS = 0.3;
export const DRYNESS_DRY = 1;
/** The dryness changes over this many days around each turn of the season (half before the turn, half after). */
export const SEASON_TURN_DAYS = 2;
/** @type {Readonly<Record<SeasonKey, string>>} */
export const SEASON_NAMES = Object.freeze({ rains: 'The rains', dry: 'The dry season' });
/** The log lines of the calendar: at each turn of the season, and on the last day of the rains. */
export const SEASON_LINES = Object.freeze({
  rains: 'The rains have come.',
  dry: 'The dry season has begun.',
  ending: 'The rains are ending. Water will be scarce.',
});

/** @param {number} v @returns {number} v when finite, else 0 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** @param {number} v */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** 3t² − 2t³ on 0..1. @param {number} t */
function smooth(t) {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}
/** a mod n, never negative. @param {number} a @param {number} n */
function mod(a, n) {
  const m = a % n;
  return m < 0 ? m + n : m;
}

/**
 * The world's clock in seconds: 0 at midnight before day 1.
 * @param {number} day   main's day counter (1 on a new world)
 * @param {number} time  the day fraction, 0..1
 * @returns {number}
 */
export function worldSeconds(day, time) {
  return (num(day) - 1 + num(time)) * DAY_LENGTH_SECONDS;
}

/**
 * Where a day lies in its year, in days since the rains began: 0 ≤ … < YEAR_DAYS. `day` may carry the time of day as
 * its fraction (day 3 at noon is 3.5).
 * @param {number} day
 * @returns {number}
 */
export function yearDay(day) {
  return mod(num(day) - 1, YEAR_DAYS);
}

/**
 * How dry the land is at a place in the year: DRYNESS_RAINS in the rains, DRYNESS_DRY in the dry season, moving smoothly
 * from one to the other over the SEASON_TURN_DAYS around each turn (it is halfway at the turn itself).
 * @param {number} pos  yearDay
 * @returns {number}
 */
export function drynessAt(pos) {
  const half = SEASON_TURN_DAYS / 2;
  // measured from the start of the rains, with the end of the dry season just below 0
  const p = pos > (RAINS_DAYS + YEAR_DAYS) / 2 ? pos - YEAR_DAYS : pos;
  const wet = p < RAINS_DAYS / 2 ? smooth((p + half) / SEASON_TURN_DAYS) : 1 - smooth((p - RAINS_DAYS + half) / SEASON_TURN_DAYS);
  return DRYNESS_DRY + (DRYNESS_RAINS - DRYNESS_DRY) * wet;
}

/**
 * @typedef {Object} Season
 * @property {SeasonKey} key
 * @property {string} name        'The rains' or 'The dry season'
 * @property {number} dayOfSeason which day of the season this is, from 1
 * @property {number} days        how many days the season has
 * @property {number} daysLeft    whole days of the season still to come after this one (0 on its last day)
 * @property {number} dryness     DRYNESS_RAINS .. DRYNESS_DRY (drynessAt)
 * @property {number} year        which year this is, from 1
 * @property {number} dayOfYear   which day of the year, from 1
 */

/**
 * The season of a day. `day` is main's day counter and may carry the time of day as its fraction, which only the
 * dryness uses (it then changes smoothly through the day).
 * @param {number} day
 * @returns {Season}
 */
export function seasonOf(day) {
  const d = num(day);
  const pos = yearDay(d);
  const whole = Math.floor(pos);
  const rains = whole < RAINS_DAYS;
  const dayOfSeason = (rains ? whole : whole - RAINS_DAYS) + 1;
  const days = rains ? RAINS_DAYS : DRY_DAYS;
  return {
    key: rains ? 'rains' : 'dry',
    name: rains ? SEASON_NAMES.rains : SEASON_NAMES.dry,
    dayOfSeason,
    days,
    daysLeft: days - dayOfSeason,
    dryness: drynessAt(pos),
    year: Math.floor((d - 1) / YEAR_DAYS) + 1,
    dayOfYear: whole + 1,
  };
}

/**
 * The HUD's calendar line: `Day 12 · The dry season, day 2 of 18`.
 * @param {number} day
 * @returns {string}
 */
export function calendarLine(day) {
  const s = seasonOf(day);
  return `Day ${Math.max(1, Math.floor(num(day)))} · ${s.name}, day ${s.dayOfSeason} of ${s.days}`;
}

/**
 * The word for what falls: 'Rain', 'Snow' where it falls as snow, '' when nothing falls.
 * @param {number} intensity @param {number} biome
 * @returns {string}
 */
export function weatherWord(intensity, biome) {
  if (!(intensity > 0)) return '';
  return fallsAsSnow(biome) ? 'Snow' : 'Rain';
}

/**
 * The HUD line: the calendar, and the word `Rain` (or `Snow`) while it falls: `Day 3 · The rains, day 3 of 10 · Rain`.
 * @param {number} day @param {string} [word] weatherWord
 * @returns {string}
 */
export function hudLine(day, word = '') {
  return word ? `${calendarLine(day)} · ${word}` : calendarLine(day);
}

/**
 * The log lines of going from one day to a later one: the new season's line when the season turned, and the warning on
 * the last day of the rains (one day before the dry season). Nothing when the day did not move forward.
 * @param {number|null} prevDay  the day before (a whole number), or null when there was none (a world just loaded)
 * @param {number} day
 * @returns {string[]}
 */
export function seasonNews(prevDay, day) {
  if (prevDay === null || !Number.isFinite(prevDay) || !Number.isFinite(day)) return [];
  const a = Math.floor(prevDay);
  const b = Math.floor(day);
  if (!(b > a)) return [];
  const now = seasonOf(b);
  /** @type {string[]} */
  const lines = [];
  if (now.key !== seasonOf(a).key || b - a >= YEAR_DAYS) lines.push(SEASON_LINES[now.key]);
  if (now.key === 'rains' && now.daysLeft === 0) lines.push(SEASON_LINES.ending);
  return lines;
}

// ---- Rain ---------------------------------------------------------------------------------------------------------------

/**
 * The share of the time it rains, by biome and season. In SNOWY and SNOWY_PEAKS it falls as snow.
 * @type {Readonly<Record<number, Readonly<Record<SeasonKey, number>>>>}
 */
export const RAIN_SHARE = Object.freeze({
  [BIOME.OCEAN]: Object.freeze({ rains: 0.35, dry: 0.03 }),
  [BIOME.BEACH]: Object.freeze({ rains: 0.35, dry: 0.03 }),
  [BIOME.PLAINS]: Object.freeze({ rains: 0.35, dry: 0.03 }),
  [BIOME.FOREST]: Object.freeze({ rains: 0.45, dry: 0.05 }),
  [BIOME.DESERT]: Object.freeze({ rains: 0.08, dry: 0 }),
  [BIOME.SNOWY]: Object.freeze({ rains: 0.3, dry: 0.05 }),
  [BIOME.MOUNTAINS]: Object.freeze({ rains: 0.4, dry: 0.05 }),
  [BIOME.SNOWY_PEAKS]: Object.freeze({ rains: 0.3, dry: 0.05 }),
});

/** One possible shower begins in every slot of this many seconds (four game hours), and ends inside it. */
export const SHOWER_SLOT_S = 240;
export const SLOTS_PER_DAY = DAY_LENGTH_SECONDS / SHOWER_SLOT_S;
/** A shower lasts one to four game hours. */
export const SHOWER_MIN_S = 60;
export const SHOWER_MAX_S = 240;
/** It comes on over this long, and dies away over this long. */
export const SHOWER_RAMP_S = 20;
/** A shower's strength at its height is at least this (and at most 1). */
export const SHOWER_PEAK_MIN = 0.35;
/** Within a shower the rain swells and slackens: it never falls under this part of the shower's strength. */
export const SHOWER_SWELL_MIN = 0.8;
export const SHOWER_SWELL_S = 37;
/**
 * A shower's length is SHOWER_MIN_S + (SHOWER_MAX_S − SHOWER_MIN_S) · v^skew for a seeded v in 0..1: evenly spread in the
 * rains, mostly long in the dry season (whose rare rain comes as a few long showers).
 * @type {Readonly<Record<SeasonKey, number>>}
 */
export const SHOWER_SKEW = Object.freeze({ rains: 1, dry: 0.25 });
/** The mean length of a shower by season: 150 s in the rains, 204 s in the dry season. */
export const SHOWER_MEAN_S = Object.freeze({
  rains: SHOWER_MIN_S + (SHOWER_MAX_S - SHOWER_MIN_S) / (1 + SHOWER_SKEW.rains),
  dry: SHOWER_MIN_S + (SHOWER_MAX_S - SHOWER_MIN_S) / (1 + SHOWER_SKEW.dry),
});
/** The ranks are dealt afresh every this many days of the rains: each deal holds every rank once. */
export const RAINS_DEAL_DAYS = 2;
/**
 * What the deals promise: wherever a slot's chance in the rains is 5 in 12 or more (every land but the desert), the rains
 * never go this many days without rain. (Each deal of 12 slots then holds 5 showers at least, so at most 14 slots in a
 * row are empty: under two and a half days.)
 */
export const RAINS_MAX_DRY_DAYS = 3;
/** `nextChange` looks at most this far ahead (two years). */
export const NEXT_CHANGE_HORIZON_S = 2 * YEAR_DAYS * DAY_LENGTH_SECONDS;

const YEAR_SLOTS = YEAR_DAYS * SLOTS_PER_DAY;
const RAINS_SLOTS = RAINS_DAYS * SLOTS_PER_DAY;
const RAINS_DEAL = RAINS_DEAL_DAYS * SLOTS_PER_DAY;
const DRY_DEAL = DRY_DAYS * SLOTS_PER_DAY;
const RAINS_DEALS = RAINS_SLOTS / RAINS_DEAL;
/** Deals kept in memory (a deal is at most DRY_DEAL bytes). */
const MAX_DEALS = 24;

/** @param {number} biome @returns {boolean} what falls here is snow: the look only, none of rain's effects */
export function fallsAsSnow(biome) {
  return biome === BIOME.SNOWY || biome === BIOME.SNOWY_PEAKS;
}

/**
 * The share of the time it rains in a biome in a season (RAIN_SHARE; an unknown biome is PLAINS).
 * @param {number} biome @param {SeasonKey} season
 * @returns {number} 0..1
 */
export function rainShare(biome, season) {
  const row = RAIN_SHARE[biome] ?? RAIN_SHARE[BIOME.PLAINS];
  return row[season] ?? 0;
}

/**
 * The chance that a slot's shower falls on a biome: share × SHOWER_SLOT_S / the season's mean shower length.
 * @param {number} biome @param {SeasonKey} season
 * @returns {number} 0..1
 */
export function showerChance(biome, season) {
  return Math.min(1, (rainShare(biome, season) * SHOWER_SLOT_S) / SHOWER_MEAN_S[season]);
}

/**
 * @typedef {Object} Shower  one shower as it falls on a biome
 * @property {number} start  world seconds
 * @property {number} end    world seconds (start + one to four game hours)
 * @property {number} peak   its strength at its height, SHOWER_PEAK_MIN..1
 */

/**
 * @typedef {Object} Weather
 * @property {number} seed
 * @property {(worldSeconds: number, biome: number) => number} rainAt  how hard it rains (or snows), 0..1
 * @property {(worldSeconds: number, biome: number, seconds: number) => boolean} rainedWithin  rain fell at some moment
 *   of the last `seconds`
 * @property {(worldSeconds: number, biome: number) => ({ at: number, rain: boolean }|null)} nextChange  when the rain
 *   next starts (`rain` true) or, while it rains, when it stops (`rain` false); null when nothing changes within
 *   NEXT_CHANGE_HORIZON_S, or while the weather is forced
 * @property {(from: number, to: number, biome: number) => Shower[]} showers  the showers that overlap [from, to), in order
 * @property {(mode: 'rain'|'dry'|null) => void} force  debug: rain at full strength everywhere, no rain anywhere, or
 *   (null) the real weather again. Not saved.
 * @property {'rain'|'dry'|null} forced
 */

/**
 * The weather of a world. Deterministic: every answer depends only on `seed` and the arguments (and on `force`, which
 * is for screenshots).
 * @param {number} seed  the world's seed
 * @returns {Weather}
 */
export function createWeather(seed) {
  const base = (num(seed) ^ 0x5ea50a11) >>> 0;
  /** @type {Map<number, Uint8Array>} deal id → the rank of each of its slots */
  const deals = new Map();

  /** The ranks of deal `d` of year `y`: a seeded shuffle of 0..n−1. @param {number} y @param {number} d @param {number} n */
  function deal(y, d, n) {
    const id = y * 8 + d;
    let ranks = deals.get(id);
    if (ranks) return ranks;
    ranks = new Uint8Array(n);
    for (let i = 0; i < n; i++) ranks[i] = i;
    const random = mulberry32((Math.imul(y | 0, 0x9e3779b1) ^ Math.imul(d + 1, 0x85ebca6b) ^ base) >>> 0);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = ranks[i];
      ranks[i] = ranks[j];
      ranks[j] = t;
    }
    if (deals.size >= MAX_DEALS) deals.clear();
    deals.set(id, ranks);
    return ranks;
  }

  /** The slot's place in its year. @param {number} s slot index @returns {number} 0..YEAR_SLOTS−1 */
  const inYear = (s) => mod(s, YEAR_SLOTS);

  /** @param {number} s @returns {SeasonKey} */
  const seasonOfSlot = (s) => (inYear(s) < RAINS_SLOTS ? 'rains' : 'dry');

  /** The slot's rank, 0..1: below a biome's showerChance, its shower falls there. @param {number} s */
  function rankOf(s) {
    const y = Math.floor(s / YEAR_SLOTS);
    const k = inYear(s);
    const jitter = rand2(s, 11, base);
    if (k < RAINS_SLOTS) {
      const d = Math.floor(k / RAINS_DEAL);
      return (deal(y, d, RAINS_DEAL)[k - d * RAINS_DEAL] + jitter) / RAINS_DEAL;
    }
    return (deal(y, RAINS_DEALS, DRY_DEAL)[k - RAINS_SLOTS] + jitter) / DRY_DEAL;
  }

  /** The slot's shower, falling or not. @param {number} s @param {Shower} out @returns {Shower} */
  function showerOf(s, out) {
    const season = seasonOfSlot(s);
    const len = SHOWER_MIN_S + (SHOWER_MAX_S - SHOWER_MIN_S) * Math.pow(rand2(s, 23, base), SHOWER_SKEW[season]);
    out.start = s * SHOWER_SLOT_S + rand2(s, 37, base) * (SHOWER_SLOT_S - len);
    out.end = out.start + len;
    out.peak = SHOWER_PEAK_MIN + (1 - SHOWER_PEAK_MIN) * rand2(s, 53, base);
    return out;
  }

  /** The slot's shower falls on the biome. @param {number} s @param {number} biome */
  const falls = (s, biome) => rankOf(s) < showerChance(biome, seasonOfSlot(s));

  /** A smooth seeded wave in 0..1 over time, for the swell within a shower. @param {number} t */
  function swell(t) {
    const x = t / SHOWER_SWELL_S;
    const i = Math.floor(x);
    const a = rand2(i, 71, base);
    return a + (rand2(i + 1, 71, base) - a) * smooth(x - i);
  }

  /** @type {Shower} */
  const scratch = { start: 0, end: 0, peak: 0 };
  /** @type {Weather} */
  const weather = {
    seed: num(seed),
    forced: null,
    force(mode) {
      weather.forced = mode === 'rain' || mode === 'dry' ? mode : null;
    },
    rainAt(t, biome) {
      if (weather.forced) return weather.forced === 'rain' ? 1 : 0;
      if (!Number.isFinite(t)) return 0;
      const s = Math.floor(t / SHOWER_SLOT_S);
      if (!falls(s, biome)) return 0;
      const sh = showerOf(s, scratch);
      if (!(t > sh.start && t < sh.end)) return 0;
      const edge = Math.min(t - sh.start, sh.end - t) / SHOWER_RAMP_S;
      return sh.peak * smooth(edge) * (SHOWER_SWELL_MIN + (1 - SHOWER_SWELL_MIN) * swell(t));
    },
    rainedWithin(t, biome, seconds) {
      if (weather.forced) return weather.forced === 'rain';
      if (!Number.isFinite(t) || !(seconds >= 0)) return false;
      const from = t - seconds;
      const last = Math.floor(t / SHOWER_SLOT_S);
      for (let s = Math.floor(from / SHOWER_SLOT_S); s <= last; s++) {
        if (!falls(s, biome)) continue;
        const sh = showerOf(s, scratch);
        if (sh.start < t && sh.end > from) return true;
      }
      return false;
    },
    nextChange(t, biome) {
      if (weather.forced || !Number.isFinite(t)) return null;
      const first = Math.floor(t / SHOWER_SLOT_S);
      const last = first + NEXT_CHANGE_HORIZON_S / SHOWER_SLOT_S;
      for (let s = first; s <= last; s++) {
        if (!falls(s, biome)) continue;
        const sh = showerOf(s, scratch);
        if (t < sh.start) return { at: sh.start, rain: true };
        if (t < sh.end) return { at: sh.end, rain: false };
      }
      return null;
    },
    showers(from, to, biome) {
      /** @type {Shower[]} */
      const out = [];
      if (weather.forced || !(to > from)) return out;
      const last = Math.floor(to / SHOWER_SLOT_S);
      for (let s = Math.floor(from / SHOWER_SLOT_S); s <= last; s++) {
        if (!falls(s, biome)) continue;
        const sh = showerOf(s, { start: 0, end: 0, peak: 0 });
        if (sh.start < to && sh.end > from) out.push(sh);
      }
      return out;
    },
  };
  return weather;
}

/**
 * What the water system is handed: `rain(q, r)`, how hard it rains (or snows) on a column now, and `dryness()`, how dry
 * the season is (DRYNESS_RAINS..DRYNESS_DRY).
 * @param {Weather} weather
 * @param {() => number} getNow     the world's clock (worldSeconds)
 * @param {() => number} getDay     main's day counter, with or without the time of day as its fraction
 * @param {(q: number, r: number) => number} biomeAt
 * @returns {{ rain: (q: number, r: number) => number, dryness: () => number }}
 */
export function weatherEnv(weather, getNow, getDay, biomeAt) {
  return {
    rain: (q, r) => weather.rainAt(getNow(), biomeAt(q, r)),
    dryness: () => seasonOf(getDay()).dryness,
  };
}

// ---- What the rain reaches ---------------------------------------------------------------------------------------------

/** Leaves are no roof: this part of the rain comes through them. */
export const LEAF_COVER = 0.35;

/**
 * How much of the rain reaches cell (q, y, r) from above: 1 under the open sky, LEAF_COVER under leaves, 0 under a roof
 * (any other solid block, glass too) or under water. Plants, fires and other things that are not solid are no cover.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} q @param {number} y @param {number} r
 * @param {number} [top]  the highest cell to look at (the world's top)
 * @returns {number} 0, LEAF_COVER or 1
 */
export function rainExposure(getBlock, q, y, r, top = WORLD_HEIGHT - 1) {
  let leafy = false;
  for (let yy = Math.max(0, Math.floor(y) + 1); yy <= top; yy++) {
    const id = getBlock(q, yy, r);
    if (isLeaves(id)) leafy = true;
    else if (isSolid(id) || isLiquid(id)) return 0;
  }
  return leafy ? LEAF_COVER : 1;
}

/** A drop lands this far below the top of a water cell (the water's surface). */
export const WATER_SURFACE_DROP = 0.1;

/**
 * Where the rain lands in column (q, r), looking down from `top`: `floor`, the height of the surface that stops it (the
 * top of the highest solid block that is not leaves, or the water's surface; 0 when the column is empty), and `canopy`,
 * the top of the highest leaves above that, or −1 when there are none.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} q @param {number} r
 * @param {number} [top]
 * @returns {{ floor: number, canopy: number }}
 */
export function rainColumn(getBlock, q, r, top = WORLD_HEIGHT - 1) {
  let canopy = -1;
  for (let y = top; y >= 0; y--) {
    const id = getBlock(q, y, r);
    if (id === BLOCK.AIR) continue;
    if (isLeaves(id)) {
      if (canopy < 0) canopy = y + 1;
    } else if (isLiquid(id)) {
      return { floor: y + 1 - WATER_SURFACE_DROP, canopy };
    } else if (isSolid(id)) {
      return { floor: y + 1, canopy };
    }
  }
  return { floor: 0, canopy };
}

/**
 * @typedef {Object} RainWorld  what the rain's rules read of the world (World has both)
 * @property {(q: number, y: number, r: number) => number} getBlock
 * @property {(q: number, r: number) => number} getBiome
 */

/**
 * The rain reaching cell (q, y, r) at a moment, 0..1: how hard it rains on the column × how much of it gets through
 * what is above the cell (rainExposure). 0 where it falls as snow: snow has none of rain's effects.
 * @param {Weather} weather @param {number} now  worldSeconds
 * @param {RainWorld} world
 * @param {number} q @param {number} y @param {number} r
 * @returns {number}
 */
export function rainReaching(weather, now, world, q, y, r) {
  const biome = world.getBiome(q, r);
  if (fallsAsSnow(biome)) return 0;
  const rain = weather.rainAt(now, biome);
  return rain > 0 ? rain * rainExposure(world.getBlock, q, y, r) : 0;
}

/**
 * Rain fell on cell (q, y, r) within the last `seconds`: it rained on the column (not snowed), and the cell is not
 * under a roof (as the roofs stand now). This is farming's "watered by rain".
 * @param {Weather} weather @param {number} now  worldSeconds
 * @param {RainWorld} world
 * @param {number} q @param {number} y @param {number} r
 * @param {number} seconds
 * @returns {boolean}
 */
export function rainedOnCell(weather, now, world, q, y, r, seconds) {
  const biome = world.getBiome(q, r);
  return !fallsAsSnow(biome) && weather.rainedWithin(now, biome, seconds) && rainExposure(world.getBlock, q, y, r) > 0;
}

// ---- The sky under rain -------------------------------------------------------------------------------------------------

/** How far the sky's colours go toward grey under a full overcast, and how much darker that grey is than the colour. */
export const OVERCAST_GREY = 0.85;
export const OVERCAST_DARKEN = 0.72;
/** A full overcast takes this part of the sun's (or moon's) light, and this part of the sky's. */
export const OVERCAST_SUN_LOSS = 0.55;
export const OVERCAST_SKY_LOSS = 0.2;
/** The overcast follows the rain with this time constant (s), so the sky never changes at a stroke. */
export const OVERCAST_TAU_S = 6;

/** Grey a colour into `out`. @param {number[]} out @param {ArrayLike<number>} c @param {number} k */
function greyInto(out, c, k) {
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * OVERCAST_DARKEN;
  out[0] = c[0] + (lum * 0.94 - c[0]) * k;
  out[1] = c[1] + (lum * 0.97 - c[1]) * k;
  out[2] = c[2] + (lum - c[2]) * k;
}

/**
 * The sky under an overcast: the zenith, the horizon and the fog go toward a darker blue-grey, the sun and the sky give
 * less light, the stars go out, and `overcast` is written for the renderer (it pales the sun and the moon). `sky` is not
 * touched; with no overcast `out` is an exact copy of it.
 * @param {SkyState} sky
 * @param {number} overcast  0..1
 * @param {SkyState} out  filled and returned
 * @returns {SkyState}
 */
export function rainSky(sky, overcast, out) {
  const o = clamp01(num(overcast));
  const k = OVERCAST_GREY * o;
  out.time = sky.time;
  out.solar = sky.solar;
  out.isDay = sky.isDay;
  for (let i = 0; i < 3; i++) {
    out.sunDir[i] = sky.sunDir[i];
    out.sunColor[i] = sky.sunColor[i];
  }
  greyInto(out.zenithColor, sky.zenithColor, k);
  greyInto(out.horizonColor, sky.horizonColor, k);
  greyInto(out.fogColor, sky.fogColor, k);
  out.sunIntensity = sky.sunIntensity * (1 - OVERCAST_SUN_LOSS * o);
  out.hemiIntensity = sky.hemiIntensity * (1 - OVERCAST_SKY_LOSS * o);
  out.daylight = sky.daylight;
  out.stars = sky.stars * (1 - o);
  out.overcast = o;
  return out;
}

/**
 * Move a level toward its target with a time constant (the overcast, the rain as it is shown).
 * @param {number} level @param {number} target @param {number} dt @param {number} tau
 * @returns {number}
 */
export function approach(level, target, dt, tau) {
  if (!(dt > 0)) return level;
  const next = level + (target - level) * (1 - Math.exp(-dt / tau));
  return Math.abs(next - target) < 1e-4 ? target : next;
}
