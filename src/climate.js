// Caelancraft — climate: the air temperature where you stand, the temperature your body feels, the body temperature it
// drifts toward, heat sources and salt water. Pure: no DOM, no clocks, no Math.random. See docs/DESIGN-survival.md §3
// (CONTRACTS §45 once merged).
//
// Temperatures are °C. `climateT` is the raw climate noise of the column (worldgen getColumn().temperature, −1..1);
// `time` is the day fraction (0 = midnight, 0.25 = 06:00, 0.5 = noon). Every number of §3 is a named export, so the
// tests reach them by name.
//
// CONTRACT-ISSUE (import graph, DESIGN-survival §9.1): the graph lists `climate → config, blocks`; this file also imports
// hex.js (hexToWorld, for heatSource's cell centres). hex.js imports only config.js, so the graph stays acyclic, and the
// alternative was to copy the axial → world formula that CONTRACTS §0 keeps in hex.js.
import { BODY_TEMP_NORMAL, SUNRISE_TIME, SUNSET_TIME } from './config.js';
import { BLOCK, BIOME } from './blocks.js';
import { hexToWorld } from './hex.js';

/** @typedef {number} BiomeId  a blocks.BIOME value (0..7) */

// ---- Air temperature (§3.1) ----

/** Daily mean at sea level for climate noise 0 (°C). */
export const BASE_MEAN = 12;
/** Daily mean change per unit of climate noise: base = BASE_MEAN + BASE_SPAN · climateT (−10 … 34 °C). */
export const BASE_SPAN = 22;
/** Biome shift of the daily mean, index = biome id: DESERT +4, SNOWY −4, every other biome 0. */
export const BIOME_SHIFT = Object.freeze([0, 0, 0, 0, 4, -4, 0, 0]);
/** OCEAN and BEACH: the sea evens the mean out toward this, base = (base + SEA_MEAN) / 2. */
export const SEA_MEAN = 16;
/** Amplitude of the day–night swing (°C), index = biome id: OCEAN 2, BEACH 3, PLAINS 6, FOREST 5, DESERT 12, SNOWY 6,
 *  MOUNTAINS 7, SNOWY_PEAKS 7. */
export const DIURNAL_AMPLITUDE = Object.freeze([2, 3, 6, 5, 12, 6, 7, 7]);
/** The swing peaks at 14:00 (day fraction 0.5833) and bottoms out at 02:00. */
export const DIURNAL_PEAK_T = 14 / 24;
/** Feet above this height cool by ALTITUDE_LAPSE °C per cell. */
export const ALTITUDE_REF_Y = 64;
export const ALTITUDE_LAPSE = 0.25;

// ---- Felt temperature (§3.2) ----

/**
 * The sun under open sky adds up to SUN_HEAT °C, as sin(π·(t − DAY_START) / (DAY_END − DAY_START)) between sunrise and
 * sunset (v0.11 §68: 04:30 and 19:30).
 */
export const SUN_HEAT = 4;
export const DAY_START = SUNRISE_TIME;
export const DAY_END = SUNSET_TIME;
/** Without open sky (a roof, a cave), air below SHELTER_BELOW °C feels SHELTER_HEAT warmer. */
export const SHELTER_HEAT = 3;
export const SHELTER_BELOW = 10;
/** All heat sources together add at most this (°C). */
export const HEAT_CAP = 30;
/** Clothes trap less heat in hot weather: I · (1 − INSULATION_HOT_DAMP · w), w = clamp((air − 15) / 10, 0, 1). */
export const INSULATION_HOT_DAMP = 0.6;
export const INSULATION_HOT_FROM = 15;
export const INSULATION_HOT_SPAN = 10;
/** Exertion warms you: the largest of these that apply (°C). */
export const ACTIVITY_HEAT = Object.freeze({ walk: 1, break: 2, swim: 2, sprint: 4 });
/** Standing on snow or ice (CHILL_GROUND_IDS) feels this much colder (°C). */
export const GROUND_CHILL = -2;
/** @type {ReadonlyArray<number>} */
export const CHILL_GROUND_IDS = Object.freeze([BLOCK.SNOW_BLOCK, BLOCK.SNOWY_GRASS, BLOCK.ICE, BLOCK.PACKED_ICE]);
/** Wet skin: −WET_CHILL·wet °C, and the insulation counts × (1 − WET_INSULATION_LOSS·wet). */
export const WET_CHILL = 6;
export const WET_INSULATION_LOSS = 0.5;

// ---- In water (§3.2) ----

/** Water sits WATER_OFFSET below the local daily mean, clamped to WATER_TEMP_MIN..WATER_TEMP_MAX; it has no day–night swing. */
export const WATER_OFFSET = -2;
export const WATER_TEMP_MIN = 1;
export const WATER_TEMP_MAX = 26;
/** In water: felt = waterTemp + WATER_INSULATION · I + WATER_FELT_BONUS. */
export const WATER_INSULATION = 0.25;
export const WATER_FELT_BONUS = 2;

// ---- Body target (§3.3) ----

/** Below COMFORT_LOW (in water WATER_COMFORT_LOW) felt °C the body heads for 37 − slope · (low − felt). */
export const COMFORT_LOW = 10;
export const COLD_SLOPE = 0.3;
export const WATER_COMFORT_LOW = 20;
export const WATER_COLD_SLOPE = 0.4;
/** Above COMFORT_HIGH felt °C the body heads for 37 + HOT_SLOPE · (felt − COMFORT_HIGH). */
export const COMFORT_HIGH = 30;
export const HOT_SLOPE = 0.2;

// ---- Drying (§3.2 "Wet") ----

/** Out of water, wet falls by (1 + heat / WET_DRY_HEAT_DIV) · (sun ? WET_DRY_SUN_MULT : 1) / WET_DRY_S per second. */
export const WET_DRY_S = 90;
export const WET_DRY_HEAT_DIV = 5;
export const WET_DRY_SUN_MULT = 2;

// ---- Heat sources (§3.2) ----

/** heat (°C at distance 0) and radius of each source kind; each adds heat · (1 − d / radius)² for d < radius. */
export const HEAT_SOURCES = Object.freeze({
  campfire: Object.freeze({ heat: 20, radius: 6 }),
  kiln: Object.freeze({ heat: 12, radius: 4 }),
  bloomery: Object.freeze({ heat: 16, radius: 4 }),
  forge: Object.freeze({ heat: 22, radius: 5 }),
});
/** A campfire's heat is measured to fire.y + CAMPFIRE_HEAT_Y (its flames), a workplace's to its cell centre. */
export const CAMPFIRE_HEAT_Y = 0.3;
export const STATION_HEAT_Y = 0.5;
/** The player's heat is measured at the chest: feet + CHEST_HEIGHT. */
export const CHEST_HEIGHT = 1;

/** @param {number} v @returns {number} v, or `fallback` when not a finite number */
function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** @param {number} t @returns {number} the day fraction wrapped to [0, 1) (NaN → 0) */
function dayFraction(t) {
  const f = num(t) - Math.floor(num(t));
  return f >= 1 ? 0 : f;
}

/**
 * The daily mean at sea level (§3.1): 12 + 22·T, DESERT +4, SNOWY −4, OCEAN and BEACH halfway to 16 (the sea evens it out).
 * @param {BiomeId} biome
 * @param {number} climateT  raw climate noise, −1..1
 * @returns {number} °C
 */
export function baseTemperature(biome, climateT) {
  const base = BASE_MEAN + BASE_SPAN * num(climateT) + (BIOME_SHIFT[biome] ?? 0);
  return isSaltyBiome(biome) ? (base + SEA_MEAN) / 2 : base;
}

/**
 * The day–night swing (§3.1): A[biome] · cos(2π·(t − 14:00)). 0 for an unknown biome.
 * @param {BiomeId} biome
 * @param {number} time  day fraction
 * @returns {number} °C
 */
export function diurnalSwing(biome, time) {
  return (DIURNAL_AMPLITUDE[biome] ?? 0) * Math.cos(2 * Math.PI * (dayFraction(time) - DIURNAL_PEAK_T));
}

/**
 * Altitude cooling (§3.1): −0.25 °C per cell of feet height above 64.
 * @param {number} feetY
 * @returns {number} °C (≤ 0)
 */
export function altitudeTerm(feetY) {
  return -ALTITUDE_LAPSE * Math.max(0, num(feetY, ALTITUDE_REF_Y) - ALTITUDE_REF_Y);
}

/**
 * Air temperature where you stand (§3.1). Underground the air sits at the local daily mean: no swing, no altitude.
 * @param {BiomeId} biome
 * @param {number} climateT
 * @param {number} feetY
 * @param {number} time
 * @param {boolean} underground  no open sky and the column's surface is ≥ 4 cells above the eye
 * @returns {number} °C
 */
export function airTemperature(biome, climateT, feetY, time, underground) {
  const base = baseTemperature(biome, climateT);
  return underground ? base : base + diurnalSwing(biome, time) + altitudeTerm(feetY);
}

/**
 * Water temperature (§3.2): the daily mean − 2, clamped to 1..26 °C; no day–night swing.
 * @param {BiomeId} biome
 * @param {number} climateT
 * @returns {number} °C
 */
export function waterTemperature(biome, climateT) {
  return clamp(baseTemperature(biome, climateT) + WATER_OFFSET, WATER_TEMP_MIN, WATER_TEMP_MAX);
}

/** @param {number} time @returns {boolean} 06:00 ≤ t < 18:00 */
export function isDaytime(time) {
  const t = dayFraction(time);
  return t >= DAY_START && t < DAY_END;
}

/**
 * The sun's strength (§3.2): sin(π·(t − DAY_START) / (DAY_END − DAY_START)) between sunrise and sunset (1 at noon), 0 at night.
 * @param {number} time  day fraction (wrapped)
 * @returns {number} 0..1
 */
export function sunFactor(time) {
  const t = dayFraction(time);
  if (!(t > DAY_START && t < DAY_END)) return 0;
  return Math.max(0, Math.sin((Math.PI * (t - DAY_START)) / (DAY_END - DAY_START)));
}

/**
 * The heat source of a burning campfire or a working workplace at cell (q, y, r), for `heatAt`; null for an unknown kind.
 * A campfire is measured to y + 0.3 (its flames), a workplace to its cell centre.
 * @param {'campfire'|'kiln'|'bloomery'|'forge'} kind
 * @returns {{ x: number, y: number, z: number, heat: number, radius: number }|null}
 */
export function heatSource(kind, q, y, r) {
  if (!Object.hasOwn(HEAT_SOURCES, kind)) return null;
  const { heat, radius } = HEAT_SOURCES[kind];
  const [x, z] = hexToWorld(q, r);
  return { x, y: y + (kind === 'campfire' ? CAMPFIRE_HEAT_Y : STATION_HEAT_Y), z, heat, radius };
}

/**
 * Heat felt at a point from every source (§3.2): Σ heat · (1 − d / radius)² for d < radius, capped at HEAT_CAP. Pass the
 * player's chest (feet + CHEST_HEIGHT). Sources with non-finite numbers or no positive radius are skipped.
 * @param {Iterable<{ x: number, y: number, z: number, heat: number, radius: number }>|null|undefined} sources
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number} °C, 0..HEAT_CAP
 */
export function heatAt(sources, x, y, z) {
  if (!sources) return 0;
  let sum = 0;
  for (const s of sources) {
    if (!s || !(s.radius > 0) || !Number.isFinite(s.heat) || !Number.isFinite(s.x + s.y + s.z)) continue;
    const d = Math.hypot(s.x - x, s.y - y, s.z - z);
    if (!(d < s.radius)) continue;
    const f = 1 - d / s.radius;
    sum += s.heat * f * f;
  }
  return clamp(sum, 0, HEAT_CAP);
}

/**
 * The ground term of the felt temperature (§3.2): GROUND_CHILL standing on snow or ice, else 0.
 * @param {number} blockId  the cell the feet stand on
 * @returns {number} °C
 */
export function groundChillOf(blockId) {
  return CHILL_GROUND_IDS.includes(blockId) ? GROUND_CHILL : 0;
}

/**
 * The exertion term of the felt temperature (§3.2): walking +1, breaking +2, swimming +2, sprinting +4, the largest that
 * applies; 0 standing still.
 * @param {{ moving?: boolean, breaking?: boolean, swimming?: boolean, sprinting?: boolean }} a
 * @returns {number} °C
 */
export function activityHeat(a) {
  let h = 0;
  if (a.moving) h = Math.max(h, ACTIVITY_HEAT.walk);
  if (a.breaking) h = Math.max(h, ACTIVITY_HEAT.break);
  if (a.swimming) h = Math.max(h, ACTIVITY_HEAT.swim);
  if (a.sprinting) h = Math.max(h, ACTIVITY_HEAT.sprint);
  return h;
}

/**
 * How fast wet skin dries out of water (§3.2): (1 + heat/5) · (open sky by day ? 2 : 1) / 90 per second.
 * @param {number} heat  the felt heat of sources, °C
 * @param {boolean} openSky
 * @param {number} time
 * @returns {number} wet per second
 */
export function dryingRate(heat, openSky, time) {
  const sun = openSky && isDaytime(time) ? WET_DRY_SUN_MULT : 1;
  return ((1 + Math.max(0, num(heat)) / WET_DRY_HEAT_DIV) * sun) / WET_DRY_S;
}

/**
 * @typedef {Object} ClimateInput
 * @property {BiomeId} biome         the feet column's biome
 * @property {number} climateT       its raw climate noise, −1..1
 * @property {number} feetY          feet height
 * @property {number} time           day fraction
 * @property {boolean} openSky       no cover above the eye (leaves and glass count as cover)
 * @property {boolean} underground   no open sky and the column surface is ≥ 4 cells above the eye cell
 * @property {boolean} inWater       swimming (PlayerState.inWater)
 * @property {number} wet            0..1
 * @property {number} heat           heat of sources at the chest (heatAt), °C
 * @property {number|boolean} groundChill  the ground term (groundChillOf: 0 or −2); `true` means GROUND_CHILL
 * @property {number} insulation     I, the worn items' sum (Pack.insulation())
 * @property {number} sunShade       0..1, the largest worn value (Pack.sunShade())
 * @property {number} activityHeat   the exertion term (activityHeat)
 */

/**
 * The temperature the body feels (§3.2). Out of water: air + sun (open sky, by day, × (1 − sunShade)) + shelter (no open
 * sky and air < 10: +3) + heat (≤ 30) + insulation I·(1 − 0.6·w)·(1 − 0.5·wet) + exertion + ground − 6·wet. In water:
 * waterTemp + 0.25·I + 2 (nothing else counts). Missing or non-finite inputs count as 0 / false.
 * @param {Partial<ClimateInput>} inp
 * @returns {{ air: number, felt: number }}
 */
export function feltTemperature(inp) {
  const biome = /** @type {BiomeId} */ (inp.biome ?? BIOME.PLAINS);
  const air = airTemperature(biome, num(inp.climateT), num(inp.feetY, ALTITUDE_REF_Y), num(inp.time), !!inp.underground);
  const insulation = Math.max(0, num(inp.insulation));
  if (inp.inWater) {
    return { air, felt: waterTemperature(biome, num(inp.climateT)) + WATER_INSULATION * insulation + WATER_FELT_BONUS };
  }
  const wet = clamp(num(inp.wet), 0, 1);
  const sun = inp.openSky ? SUN_HEAT * sunFactor(num(inp.time)) * (1 - clamp(num(inp.sunShade), 0, 1)) : 0;
  const shelter = !inp.openSky && air < SHELTER_BELOW ? SHELTER_HEAT : 0;
  const heat = clamp(num(inp.heat), 0, HEAT_CAP);
  const w = clamp((air - INSULATION_HOT_FROM) / INSULATION_HOT_SPAN, 0, 1);
  const clothes = insulation * (1 - INSULATION_HOT_DAMP * w) * (1 - WET_INSULATION_LOSS * wet);
  const ground = typeof inp.groundChill === 'boolean' ? (inp.groundChill ? GROUND_CHILL : 0) : num(inp.groundChill);
  const felt = air + sun + shelter + heat + clothes + Math.max(0, num(inp.activityHeat)) + ground - WET_CHILL * wet;
  return { air, felt };
}

/**
 * The body temperature the body drifts toward (§3.3): 37 between 10 and 30 °C felt (in water between 20 and 30);
 * 37 − 0.3·(10 − felt) below (in water 37 − 0.4·(20 − felt)); 37 + 0.2·(felt − 30) above.
 * @param {number} felt
 * @param {boolean} inWater
 * @returns {number} °C
 */
export function bodyTarget(felt, inWater) {
  if (typeof felt !== 'number' || !Number.isFinite(felt)) return BODY_TEMP_NORMAL;
  const f = felt;
  const low = inWater ? WATER_COMFORT_LOW : COMFORT_LOW;
  const slope = inWater ? WATER_COLD_SLOPE : COLD_SLOPE;
  if (f < low) return BODY_TEMP_NORMAL - slope * (low - f);
  if (f > COMFORT_HIGH) return BODY_TEMP_NORMAL + HOT_SLOPE * (f - COMFORT_HIGH);
  return BODY_TEMP_NORMAL;
}

/**
 * Water in an OCEAN or BEACH column is salt; all other water is fresh (§4.1).
 * @param {BiomeId} biome
 * @returns {boolean}
 */
export function isSaltyBiome(biome) {
  return biome === BIOME.OCEAN || biome === BIOME.BEACH;
}
