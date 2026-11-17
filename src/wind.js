// Caelancraft — the wind (docs/DESIGN-hunting.md §3). PURE.
//
// A function of the world's seed and its clock (weather.worldSeconds), like the weather, so every player on a server
// feels the same wind without a word on the wire. A prevailing direction that wanders over the hours, a strength that
// swells and slackens over minutes (calm below WIND_CALM, whatever the hour) and rises with the showers, and gusts of a
// few seconds on top. It is read by the stalking (an animal downwind of the player smells them), and drawn: rain slants
// with it, smoke drifts with it, a pennant streams in it.
//
// Directions are world radians in the xz plane, measured like the player's yaw is not: `dir` is the direction the wind
// blows TOWARD, as the unit vector (sin dir, cos dir) in (x, z). "A west wind" blows from the west toward the east.

/** Strength at its calmest and its strongest (0..1, a share of WIND_MAX_MS). */
export const WIND_MIN = 0.08;
export const WIND_MAX = 1;
/** Metres a second at strength 1 (a strong breeze: leaves and small branches in motion, a flag stands out). */
export const WIND_MAX_MS = 12;
/** The prevailing direction wanders over about this many seconds (a few game hours). */
export const WIND_TURN_S = 900;
/** Strength changes over about this many seconds; gusts over about this many. */
export const WIND_SWELL_S = 240;
export const WIND_GUST_S = 6;
/** How much a gust adds (a share of the strength) and how much it swings the direction (radians). */
export const GUST_SHARE = 0.35;
export const GUST_SWING = 0.35;
/** A shower at full intensity adds this much strength. */
export const SHOWER_WIND = 0.35;
/**
 * Below this strength it is a calm (windWord 'calm'): the HUD's vane shows no arrow, nothing drawn moves (windDrawn
 * DRAWN_CALM), the pennant hangs (pennants PENNANT_LIFT_FROM) and the stalking hint names no wind (main
 * STALK_WIND_WORD). ONE threshold, so the vane never says "Calm" while the smoke drifts or the hint says the animal can
 * smell you.
 */
export const WIND_CALM = 0.18;

/** A deterministic hash of (seed, integer i, channel) → [0, 1). */
function hash01(seed, i, channel) {
  let h = (Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(i | 0, 0x165667b1) ^ Math.imul(channel, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) along t, one knot every `period` seconds. */
function smooth(seed, t, period, channel) {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed, i, channel);
  const b = hash01(seed, i + 1, channel);
  return a + (b - a) * u;
}

/** The seed as a 32-bit integer (a world seed may be a number or a string). */
export function windSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) | 0;
  const s = String(seed ?? '');
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return h | 0;
}

/**
 * @typedef {Object} Wind
 * @property {number} dir       radians: the direction it blows TOWARD, as (sin dir, cos dir) in (x, z)
 * @property {number} x         sin dir (unit)
 * @property {number} z         cos dir (unit)
 * @property {number} strength  0..1 with the gust (WIND_MIN .. WIND_MAX)
 * @property {number} speed     metres a second (strength × WIND_MAX_MS)
 * @property {number} gust      0..1: how much of a gust is blowing now
 */

/**
 * The wind at world time `t` (s, weather.worldSeconds) in a world of `seed`; `shower` 0..1 the rain's intensity there
 * (showers bring wind). Deterministic.
 * @param {number|string} seed @param {number} t @param {number} [shower] @returns {Wind}
 */
export function windAt(seed, t, shower = 0) {
  const s = windSeed(seed);
  const time = Number.isFinite(t) ? t : 0;
  // the prevailing direction: two slow noises, one turn of the compass spread over several knots, so it wanders
  const prevailing = (smooth(s, time, WIND_TURN_S, 1) * 2 + smooth(s, time, WIND_TURN_S * 3.7, 2) * 3) * Math.PI;
  const swell = smooth(s, time, WIND_SWELL_S, 3); // 0..1
  const gustRaw = smooth(s, time, WIND_GUST_S, 4);
  const gust = Math.max(0, (gustRaw - 0.55) / 0.45); // gusts come now and then, not all the time
  const rain = Math.max(0, Math.min(1, Number.isFinite(shower) ? shower : 0));
  const base = WIND_MIN + (0.55 - WIND_MIN) * swell * swell + SHOWER_WIND * rain;
  const strength = Math.max(WIND_MIN, Math.min(WIND_MAX, base * (1 + GUST_SHARE * gust)));
  const dir = prevailing + GUST_SWING * gust * (smooth(s, time, WIND_GUST_S, 5) - 0.5) * 2;
  const x = Math.sin(dir);
  const z = Math.cos(dir);
  return { dir, x, z, strength, speed: strength * WIND_MAX_MS, gust };
}

/**
 * How much the wind carries the player's scent to an animal: +1 when it blows straight from the player to the animal
 * (the player is UPWIND of it), −1 straight from the animal to the player (downwind: the hunter's side), 0 across.
 * Weighted by nothing — the caller scales by `wind.strength`. 0 when the two stand on the same spot.
 * @param {Wind} wind @param {number} px @param {number} pz  the player @param {number} ax @param {number} az  the animal
 * @returns {number} −1..1
 */
export function scentToward(wind, px, pz, ax, az) {
  const dx = ax - px;
  const dz = az - pz;
  const d = Math.hypot(dx, dz);
  if (!(d > 1e-6)) return 0;
  return (dx * wind.x + dz * wind.z) / d;
}

/** The eight compass words for where the wind comes FROM ("a north wind" blows from the north, toward −z… see below). */
export const WIND_FROM_WORDS = Object.freeze(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']);

/**
 * Where the wind comes from, as a compass word, in the game's frame: north is −z (the way the player faces at yaw 0),
 * east +x. @param {Wind} wind @returns {string}
 */
export function windFromWord(wind) {
  // the wind comes FROM −(x, z); compass bearing of that, clockwise from north (−z) toward east (+x)
  const fx = -wind.x;
  const fz = -wind.z;
  const bearing = Math.atan2(fx, -fz); // 0 north, π/2 east
  const k = Math.round(((bearing + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
  return WIND_FROM_WORDS[k];
}

/** A plain description: "calm", "a light breeze", "a breeze", "a strong breeze". @param {Wind} wind */
export function windWord(wind) {
  if (wind.strength < WIND_CALM) return 'calm';
  if (wind.strength < 0.4) return 'a light breeze';
  if (wind.strength < 0.7) return 'a breeze';
  return 'a strong breeze';
}
