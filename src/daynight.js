// Caelancraft — day/night cycle: keyframed sky colours and light intensities, sun/moon direction,
// clock formatting. See src/CONTRACTS.md §13 and docs/SPEC-gameplay.md §6. Pure: no DOM, no clock,
// no randomness. `lerp`/`clamp` are private copies so this module has no runtime dependency on noise.js.
import { DAY_LENGTH_SECONDS, SUNRISE_TIME, SUNSET_TIME } from './config.js';

/** @typedef {import('./types.js').SkyState} SkyState */
/** @typedef {import('./types.js').Vec3} Vec3 */

/**
 * @typedef {Object} Keyframe
 * @property {number} t         day fraction 0..1 (the last row is t = 1 and repeats row 0)
 * @property {Vec3} zenith      sky colour straight up
 * @property {Vec3} horizon     sky colour at the horizon
 * @property {Vec3} fog
 * @property {Vec3} sunColor    DirectionalLight colour
 * @property {number} sun       DirectionalLight intensity  (→ SkyState.sunIntensity)
 * @property {number} amb       HemisphereLight intensity   (→ SkyState.hemiIntensity)
 * @property {number} daylight  0..1 scalar for baked-light consumers
 * @property {number} stars     0..1 star opacity
 */

const TWO_PI = Math.PI * 2;
const MINUTES_PER_DAY = 24 * 60;
/** Sun path is tilted off the X/Y plane by this much (z component before normalisation). */
const SUN_TILT_Z = 0.25;
/** Sunrise is at t = 0.25; θ = (t − DAWN) · 2π puts the sun on the +X horizon then. */
const DAWN = 0.25;
const DUSK = 0.75;
/** Added before flooring the clock minute so 0.7 · 1440 = 1007.999… still reads 16:48. */
const CLOCK_EPS = 1e-7;

/**
 * '#RRGGBB' (hash optional, any case) → frozen [r,g,b] floats 0..1 (sRGB, no gamma conversion).
 * @param {string} hex
 * @returns {Vec3}
 */
export function hexToRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`hexToRGB: expected #RRGGBB, got ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return Object.freeze([((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255]);
}

/**
 * Build one frozen keyframe from a SPEC §6 table row.
 * @returns {Keyframe}
 */
function keyframe(t, zenith, horizon, fog, sunColor, sun, amb, daylight, stars) {
  return Object.freeze({
    t,
    zenith: hexToRGB(zenith),
    horizon: hexToRGB(horizon),
    fog: hexToRGB(fog),
    sunColor: hexToRGB(sunColor),
    sun,
    amb,
    daylight,
    stars,
  });
}

// docs/SPEC-gameplay.md §6, verbatim:  t, zenith, horizon, fog, sun colour, sun, amb, daylight, stars
const SPEC_ROWS = [
  [0.00, '#070B1A', '#101833', '#0C1228', '#8C9AC8', 0.35, 0.55, 0.22, 1.0], // 00:00
  [0.20, '#0B1430', '#2C2F55', '#1E2544', '#A090B0', 0.45, 0.65, 0.30, 1.0], // 04:48
  [0.25, '#23457F', '#F0A25A', '#D6905E', '#FFB878', 1.10, 0.90, 0.55, 0.3], // 06:00
  [0.30, '#4F8FD6', '#B9D6F2', '#A9C7E8', '#FFE6C2', 1.80, 1.30, 0.90, 0.0], // 07:12
  [0.50, '#6DA7FF', '#BFDCFF', '#B6D3F7', '#FFF8EA', 2.00, 1.40, 1.00, 0.0], // 12:00
  [0.70, '#4F8FD6', '#C6D6EC', '#B2C6E0', '#FFE0B8', 1.80, 1.30, 0.90, 0.0], // 16:48
  [0.75, '#22336E', '#EF8546', '#D27447', '#FFA060', 1.10, 0.90, 0.55, 0.3], // 18:00
  [0.80, '#0C1436', '#302E58', '#202646', '#A090B0', 0.45, 0.65, 0.30, 1.0], // 19:12
];

/**
 * Sky keyframes, ascending in t, first row t = 0, last row t = 1 (a copy of row 0 so interpolation wraps).
 * @type {ReadonlyArray<Keyframe>}
 */
export const KEYFRAMES = Object.freeze([
  ...SPEC_ROWS.map((r) => keyframe(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8])),
  keyframe(1.0, SPEC_ROWS[0][1], SPEC_ROWS[0][2], SPEC_ROWS[0][3], SPEC_ROWS[0][4],
    SPEC_ROWS[0][5], SPEC_ROWS[0][6], SPEC_ROWS[0][7], SPEC_ROWS[0][8]),
]);

const LAST_SEGMENT = KEYFRAMES.length - 2;

/** Day fraction wrapped into [0,1). Non-finite → 0. Guards the float case where t − floor(t) rounds to exactly 1. */
function wrapTime(time) {
  if (!Number.isFinite(time)) return 0;
  const t = time - Math.floor(time);
  return t >= 1 ? 0 : t;
}

function lerp(a, b, u) {
  return a + (b - a) * u;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Lerp two colours into `out` (channels clamped to [0,1]). */
function lerpColor(out, a, b, u) {
  out[0] = clamp01(lerp(a[0], b[0], u));
  out[1] = clamp01(lerp(a[1], b[1], u));
  out[2] = clamp01(lerp(a[2], b[2], u));
  return out;
}

/**
 * Advance the day clock by `dt` real seconds (one game hour is DAY_LENGTH_SECONDS / 24: a real minute since v0.11).
 * Result is always in [0,1) (wraps both ways). Non-finite `dt` or a non-positive/NaN day length leaves the (wrapped)
 * time unchanged.
 * @param {number} time  current day fraction
 * @param {number} dt    seconds elapsed (may be negative)
 * @param {number} [dayLengthSeconds]
 * @returns {number}
 */
export function advanceTime(time, dt, dayLengthSeconds = DAY_LENGTH_SECONDS) {
  if (!(dayLengthSeconds > 0) || !Number.isFinite(dt)) return wrapTime(time);
  return wrapTime(time + dt / dayLengthSeconds);
}

/** Real seconds from day fraction `from` forward to `to` (0 when equal). @param {number} from @param {number} to */
export function realSecondsBetween(from, to, dayLengthSeconds = DAY_LENGTH_SECONDS) {
  const d = wrapTime(to) - wrapTime(from);
  return (d < 0 ? d + 1 : d) * dayLengthSeconds;
}

/** v0.11 (CONTRACTS §68): the clock times of sunrise (04:30) and sunset (19:30) — DAYLIGHT_HOURS centred on noon. */
export const SUNRISE = SUNRISE_TIME;
export const SUNSET = SUNSET_TIME;

/**
 * Clock time → solar time. The sky keyframes, the sun's path and the stars run on solar time, in which the sun rises at
 * 0.25 and sets at 0.75 (SPEC-gameplay §6); the clock maps onto it piecewise linearly — midnight 0 → 0, SUNRISE → 0.25,
 * noon 0.5 → 0.5, SUNSET → 0.75 — so the long day stretches the daytime keyframes and the short night squeezes the night.
 * @param {number} time  clock day fraction
 * @returns {number} solar day fraction in [0,1)
 */
export function solarTime(time) {
  const t = wrapTime(time);
  if (t < SUNRISE) return (t / SUNRISE) * DAWN;
  if (t < SUNSET) return DAWN + ((t - SUNRISE) / (SUNSET - SUNRISE)) * (DUSK - DAWN);
  return wrapTime(DUSK + ((t - SUNSET) / (1 - SUNSET)) * (1 - DUSK));
}

/** Solar time → clock time (solarTime's inverse). @param {number} solar @returns {number} clock day fraction in [0,1) */
export function clockTime(solar) {
  const s = wrapTime(solar);
  if (s < DAWN) return (s / DAWN) * SUNRISE;
  if (s < DUSK) return SUNRISE + ((s - DAWN) / (DUSK - DAWN)) * (SUNSET - SUNRISE);
  return wrapTime(SUNSET + ((s - DUSK) / (1 - DUSK)) * (1 - SUNSET));
}

/**
 * Unit vector toward the sun: θ = (t − 0.25)·2π, normalize(cos θ, sin θ, 0.25).
 * Rises at +X (06:00), overhead at noon, sets at −X (18:00), below the horizon at night.
 * @param {number} time
 * @param {Vec3} [out]  reused when given (hot path)
 * @returns {Vec3}
 */
export function sunDirection(time, out) {
  const th = (solarTime(time) - DAWN) * TWO_PI;
  const x = Math.cos(th);
  const y = Math.sin(th);
  const inv = 1 / Math.sqrt(x * x + y * y + SUN_TILT_Z * SUN_TILT_Z);
  const o = out ?? [0, 0, 0];
  o[0] = x * inv;
  o[1] = y * inv;
  o[2] = SUN_TILT_Z * inv;
  return o;
}

/**
 * A zeroed SkyState with its own arrays, suitable as the `out` of computeSky.
 * @returns {SkyState}
 */
export function createSkyState() {
  return {
    time: 0,
    solar: 0,
    isDay: false,
    sunDir: [0, 0, 0],
    sunColor: [0, 0, 0],
    sunIntensity: 0,
    hemiIntensity: 0,
    zenithColor: [0, 0, 0],
    horizonColor: [0, 0, 0],
    fogColor: [0, 0, 0],
    daylight: 0,
    stars: 0,
  };
}

/**
 * Sky/light state at day fraction `time`: linear interpolation between the two neighbouring KEYFRAMES
 * (wrapping 1 → 0). `time` outside [0,1) is wrapped. Continuous in t; computeSky(0) equals computeSky(1).
 * `sunDir` points at the sun while 0.25 <= t < 0.75 and at the moon (= −sun) otherwise.
 * @param {number} time
 * @param {SkyState} [out]  when given, filled in place and returned (no allocation)
 * @returns {SkyState}
 */
export function computeSky(time, out) {
  const clock = wrapTime(time);
  const t = solarTime(clock); // the sky runs on solar time (§68)
  const s = out ?? createSkyState();

  // Locate the segment a.t <= t < b.t. t < 1 = KEYFRAMES[last].t so a segment always exists.
  let i = 0;
  while (i < LAST_SEGMENT && t >= KEYFRAMES[i + 1].t) i++;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[i + 1];
  const u = (t - a.t) / (b.t - a.t);

  const isDay = t >= DAWN && t < DUSK;
  const dir = sunDirection(clock, s.sunDir); // sunDirection maps the clock onto solar time itself
  if (!isDay) {
    dir[0] = -dir[0];
    dir[1] = -dir[1];
    dir[2] = -dir[2];
  }

  s.time = clock;
  s.solar = t;
  s.isDay = isDay;
  lerpColor(s.sunColor, a.sunColor, b.sunColor, u);
  s.sunIntensity = Math.max(0, lerp(a.sun, b.sun, u));
  s.hemiIntensity = Math.max(0, lerp(a.amb, b.amb, u));
  lerpColor(s.zenithColor, a.zenith, b.zenith, u);
  lerpColor(s.horizonColor, a.horizon, b.horizon, u);
  lerpColor(s.fogColor, a.fog, b.fog, u);
  s.daylight = clamp01(lerp(a.daylight, b.daylight, u));
  s.stars = clamp01(lerp(a.stars, b.stars, u));
  return s;
}

/**
 * True by day (SUNRISE 04:30 ≤ t < SUNSET 19:30; v0.11 §68), exactly SkyState.isDay without computing the sky (zombies, §39).
 * @param {number} time
 * @returns {boolean}
 */
export function isDayTime(time) {
  const t = wrapTime(time);
  return t >= SUNRISE && t < SUNSET;
}

/**
 * "HH:MM" 24-hour clock for a day fraction (0.25 → "06:00"). Floors to the minute; wraps out-of-range times.
 * @param {number} time
 * @returns {string}
 */
export function formatTime(time) {
  let minutes = Math.floor(wrapTime(time) * MINUTES_PER_DAY + CLOCK_EPS);
  if (minutes >= MINUTES_PER_DAY) minutes = 0;
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
