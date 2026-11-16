// Caelancraft — the wind drawn (CONTRACTS §101). PURE: no DOM, no three.
//
// The wind itself is wind.js (from the world's seed and clock, the same for every player on a server; main.windNow()).
// This module turns it into what is drawn: the HUD's vane (which way it blows relative to where the player looks, how hard,
// in words), the slant of the rain and the drift of the snow, the drift of the smoke, and the air the light particles move
// in. Below DRAWN_CALM the drawn wind is still: the smoke rises straight up and the rain falls straight down.
import { windFromWord, windWord } from './wind.js';

/** @typedef {import('./wind.js').Wind} Wind */

/** Strength (0..1) below which nothing drawn moves with the wind: a calm. Just above wind.WIND_MIN. */
export const DRAWN_CALM = 0.12;
/**
 * Metres a second of the drawn air at strength 1: what smoke, steam and leaves drift in. The real wind is WIND_MAX_MS
 * (12 m/s), which would tear the smoke of a campfire away out of sight in a second; this keeps the column readable.
 */
export const AIR_MS = 3.2;
/** How fast (1/s) a puff of smoke takes on the speed of the air round it (its drag against the air). */
export const SMOKE_CATCH = 1.2;
/** A puff rises this much slower in a full wind (the column bends over and lies down). */
export const SMOKE_FLATTEN = 0.35;
/** The lean of a raindrop's fall at strength 1: sideways metres per metre fallen (tan of about 29°). */
export const RAIN_LEAN_MAX = 0.55;
/** A snowflake's sideways speed at strength 1 (m/s): it falls at 1.1–1.9 m/s, so snow drifts far more than rain leans. */
export const SNOW_DRIFT_MS = 2.2;
/** How far (m) a gust swirls a raindrop and a snowflake to and fro, at a full gust in a full wind. */
export const RAIN_SWIRL_M = 0.14;
export const SNOW_SWIRL_M = 0.5;
/** The HUD's vane: strengths at which its words change (wind.windWord's thresholds), and a gust worth showing. */
export const VANE_LEVELS = Object.freeze([0.18, 0.4, 0.7]);
export const VANE_GUST = 0.35;
/** The CSS class of each vane level: calm, light, breeze, strong. */
export const VANE_CLASSES = Object.freeze(['wind-calm', 'wind-light', 'wind-breeze', 'wind-strong']);

/**
 * How much of the wind is drawn, 0..1: 0 up to DRAWN_CALM, then rising evenly to 1 at full strength. 0 for no wind.
 * @param {Wind|null|undefined} wind @returns {number}
 */
export function drawnStrength(wind) {
  const s = wind && Number.isFinite(wind.strength) ? wind.strength : 0;
  return s <= DRAWN_CALM ? 0 : Math.min(1, (s - DRAWN_CALM) / (1 - DRAWN_CALM));
}

/**
 * The drawn air's velocity in the xz plane (m/s): downwind, AIR_MS × drawnStrength. [0, 0] in a calm or without wind.
 * @param {Wind|null|undefined} wind @param {number[]} [out] @returns {number[]} [x, z]
 */
export function windAir(wind, out = [0, 0]) {
  const k = drawnStrength(wind) * AIR_MS;
  out[0] = k > 0 ? /** @type {Wind} */ (wind).x * k : 0;
  out[1] = k > 0 ? /** @type {Wind} */ (wind).z * k : 0;
  return out;
}

/**
 * How far a puff of smoke `age` seconds old has drifted in still-rising air of velocity (airX, airZ): it starts at rest
 * and takes on the air's speed at SMOKE_CATCH, so the column leaves the fire upright and bends over downwind as it rises.
 * offset = air × (age − (1 − e^(−k·age)) / k).
 * @param {number} age @param {number} airX @param {number} airZ @param {number[]} [out] @returns {number[]} [dx, dz]
 */
export function smokeDrift(age, airX, airZ, out = [0, 0]) {
  const a = age > 0 ? age : 0;
  const k = SMOKE_CATCH;
  const f = a - (1 - Math.exp(-k * a)) / k;
  out[0] = airX * f;
  out[1] = airZ * f;
  return out;
}

/**
 * How much slower smoke rises in this wind: 1 in a calm, 1 − SMOKE_FLATTEN in a full wind.
 * @param {Wind|null|undefined} wind @returns {number}
 */
export function smokeRise(wind) {
  return 1 - SMOKE_FLATTEN * drawnStrength(wind);
}

/**
 * A falling drop's sideways velocity (m/s) in the xz plane: a raindrop leans RAIN_LEAN_MAX × drawnStrength metres per
 * metre it falls (so its sideways speed is that × its fall speed); a snowflake drifts at SNOW_DRIFT_MS × drawnStrength
 * whatever its fall speed. [0, 0] in a calm.
 * @param {Wind|null|undefined} wind @param {boolean} snow @param {number} fallSpeed  m/s @param {number[]} [out]
 * @returns {number[]} [vx, vz]
 */
export function dropDrift(wind, snow, fallSpeed, out = [0, 0]) {
  const k = drawnStrength(wind);
  const v = k === 0 ? 0 : snow ? SNOW_DRIFT_MS * k : RAIN_LEAN_MAX * k * (fallSpeed > 0 ? fallSpeed : 0);
  out[0] = v > 0 ? /** @type {Wind} */ (wind).x * v : 0;
  out[1] = v > 0 ? /** @type {Wind} */ (wind).z * v : 0;
  return out;
}

/**
 * How far a gust swirls a drop to and fro (m): RAIN_SWIRL_M (a flake SNOW_SWIRL_M) × the gust × drawnStrength.
 * @param {Wind|null|undefined} wind @param {boolean} snow @returns {number}
 */
export function dropSwirl(wind, snow) {
  const g = wind && Number.isFinite(wind.gust) ? Math.max(0, Math.min(1, wind.gust)) : 0;
  return (snow ? SNOW_SWIRL_M : RAIN_SWIRL_M) * g * drawnStrength(wind);
}

/**
 * How long (s) a drop moving at (vx, vz) has been inside the circle of radius `radius` round (cx, cz) when it is at
 * (x, z) inside it: the time back along its path to the circle. Infinity when it does not move sideways; 0 when (x, z)
 * is already on or outside the circle.
 * @param {number} x @param {number} z @param {number} vx @param {number} vz
 * @param {number} cx @param {number} cz @param {number} radius
 * @returns {number}
 */
export function timeInCircle(x, z, vx, vz, cx, cz, radius) {
  const uu = vx * vx + vz * vz;
  if (!(uu > 1e-12)) return Infinity;
  const px = x - cx;
  const pz = z - cz;
  const c = px * px + pz * pz - radius * radius;
  if (c >= 0) return 0;
  // |p − v t|² = R²  →  uu t² − 2 (p·v) t + c = 0, the positive root
  const pv = px * vx + pz * vz;
  return (pv + Math.sqrt(pv * pv - uu * c)) / uu;
}

// ---- the HUD's vane ----------------------------------------------------------------------------------------------------

/**
 * Where the wind blows on the HUD's dial, relative to where the player looks: radians clockwise from the top of the dial
 * (the way the player faces). 0: it blows away ahead of the player (at their back); π: straight into their face; π/2:
 * across, from their left to their right. The player looks along (−sin yaw, −cos yaw); the wind blows along (x, z).
 * In (−π, π].
 * @param {Wind} wind @param {number} yaw @returns {number}
 */
export function vaneAngle(wind, yaw) {
  const fwd = -(wind.x * Math.sin(yaw) + wind.z * Math.cos(yaw));
  const right = wind.x * Math.cos(yaw) - wind.z * Math.sin(yaw);
  const a = Math.atan2(right, fwd);
  return a <= -Math.PI ? Math.PI : a;
}

/**
 * The vane's level: 0 calm, 1 a light breeze, 2 a breeze, 3 a strong breeze (wind.windWord's words).
 * @param {Wind|null|undefined} wind @returns {number}
 */
export function vaneLevel(wind) {
  const s = wind && Number.isFinite(wind.strength) ? wind.strength : 0;
  let k = 0;
  while (k < VANE_LEVELS.length && s >= VANE_LEVELS[k]) k++;
  return k;
}

/**
 * The vane's words: "Calm", or the strength and where it comes from — "A light breeze from the west".
 * @param {Wind} wind @returns {string}
 */
export function vaneWords(wind) {
  const word = windWord(wind);
  if (word === 'calm') return 'Calm';
  return `${word[0].toUpperCase()}${word.slice(1)} from the ${windFromWord(wind)}`;
}

/**
 * @typedef {Object} VaneView  what hud.setWind draws
 * @property {number} angle  degrees clockwise from the top of the dial (whole degrees, 0..359)
 * @property {number} level  0 calm .. 3 strong (vaneLevel)
 * @property {boolean} gust  a gust worth showing is blowing (gust ≥ VANE_GUST, not in a calm)
 * @property {string} words  vaneWords
 */

/**
 * What the HUD's vane shows for this wind and this yaw. The angle is rounded to whole degrees, so the HUD redraws only
 * when the dial would visibly turn.
 * @param {Wind} wind @param {number} yaw @param {VaneView} [out]
 * @returns {VaneView}
 */
export function vaneView(wind, yaw, out = { angle: 0, level: 0, gust: false, words: '' }) {
  const deg = Math.round((vaneAngle(wind, yaw) * 180) / Math.PI);
  out.angle = ((deg % 360) + 360) % 360;
  out.level = vaneLevel(wind);
  out.gust = out.level > 0 && Number.isFinite(wind.gust) && wind.gust >= VANE_GUST;
  out.words = vaneWords(wind);
  return out;
}
