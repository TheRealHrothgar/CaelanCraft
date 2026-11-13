// Caelancraft — the sound bank (v0.16, CONTRACTS §82): every sound of digging and placing, of footsteps and movement, of
// the animals and the zombies, and of the ambience, as recipes that audio.playRecipe / audio.startLoop synthesise.
// The format is circuitSounds.js's (its header describes every field). PURE data: no imports, no DOM, no time, no
// randomness — the helpers below only spare the typing and work out each recipe's `dur`.
//
// How the sounds are built (nobody could listen while they were written, so each follows a known recipe and is measured
// by tests/unit/soundBank.test.js on a rendering of the game's own audio graph):
//   - an impact (stone, wood, glass) is a very short broadband crack, a few damped sine MODES of the material (`partials`
//     that fade at their own rates: stone bright, short and inharmonic; wood a low knock; glass high and ringing) and a
//     tail of debris — noise `grains`;
//   - soft ground (dirt, sand, gravel, grass, snow, leaves, cloth) is shaped noise: a dull thud and a crumble, a hiss, a
//     handful of tiny clicks, a squeaky crunch, a dry rustle;
//   - a VOICE is a buzzy source (a sawtooth) with a pitch `glide` and vibrato, through two or three `formants`, with
//     breath noise beside it; roughness is a fast amplitude wobble, a bleat or a gobble a slow deep one;
//   - a bird is a sine whose notes are `grains` at fixed times, each with its own pitch; a cricket is three pulses of a
//     4.6 kHz sine; wind, the stream, the fire and (§84) the rain are loops of filtered noise, each band wobbling at its
//     own rate.
// Low sounds keep something above 100 Hz, as circuitSounds.js explains.

/** @typedef {import('./circuitSounds.js').SoundRecipe} SoundRecipe */
/** @typedef {import('./circuitSounds.js').SoundLayer} SoundLayer */

/** A recipe layer without an `attack` rises over this long (audio.RECIPE_DEFAULT_ATTACK_S). */
const DEFAULT_ATTACK_S = 0.002;

/** Deep-freeze a recipe table. */
function freeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
}

/** @param {object} o its other fields @returns {SoundLayer} a white-noise layer (coloured only by its filters) */
const noise = (o) => /** @type {SoundLayer} */ ({ type: 'noise', f0: 0, ...o });
/** @param {number} f0 @param {object} o @returns {SoundLayer} */
const sine = (f0, o) => /** @type {SoundLayer} */ ({ type: 'sine', f0, ...o });
/** @param {number} f0 @param {object} o @returns {SoundLayer} */
const saw = (f0, o) => /** @type {SoundLayer} */ ({ type: 'saw', f0, ...o });
/** @param {number} f0 @param {object} o @returns {SoundLayer} */
const tri = (f0, o) => /** @type {SoundLayer} */ ({ type: 'tri', f0, ...o });

/**
 * When a layer has ended at the latest, in seconds after the recipe starts: its delay, the span of its grains, and one
 * strike's attack, hold and decay.
 * @param {SoundLayer} l
 */
export function layerEnd(l) {
  let span = 0;
  if (Array.isArray(l.grains)) for (const g of l.grains) span = Math.max(span, g[0]);
  else if (l.grains) span = l.grains.over;
  return (l.delay ?? 0) + span + (l.attack ?? DEFAULT_ATTACK_S) + (l.hold ?? 0) + l.decay;
}

/**
 * A recipe's length: the latest end of its layers, stretched as far as `stretch` allows, rounded up to a hundredth.
 * @param {SoundLayer[]} layers @param {number} [stretch]
 */
function lengthOf(layers, stretch = 0) {
  let end = 0;
  for (const l of layers) end = Math.max(end, layerEnd(l));
  return Math.ceil(end * (1 + stretch) * 100 - 1e-6) / 100;
}

/**
 * A recipe; its `dur` is worked out from the layers.
 * @param {number} gain
 * @param {SoundLayer[]} layers
 * @param {{ vary?: number, stretch?: number, spare?: number }} [extra]
 * @returns {SoundRecipe}
 */
function sound(gain, layers, extra = {}) {
  return { dur: lengthOf(layers, extra.stretch), gain, layers, ...extra };
}

/**
 * A recipe that is one of several at each play (`variants`). `vary`, `stretch` and `spare` given here hold for every
 * variant that does not have its own; each variant's `dur` allows for the stretch it will get.
 * @param {SoundRecipe[]} list
 * @param {{ vary?: number, stretch?: number, spare?: number }} [extra]
 * @returns {SoundRecipe}
 */
function oneOf(list, extra = {}) {
  const variants = list.map((r) => ({ ...r, dur: lengthOf(r.layers ?? [], r.stretch ?? extra.stretch) }));
  return { dur: Math.max(...variants.map((r) => r.dur)), gain: 1, variants, ...extra };
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Digging and placing: break, dig (a tick while digging), place and step for each sound group
// ---------------------------------------------------------------------------------------------------------------------

/** A footstep gives way to anything else: it is not played unless this many voices stay free. */
export const STEP_SPARE = 12;
/** So do the ambience's chirps, pops and bubbles. */
export const AMBIENT_SPARE = 14;

const STEP = Object.freeze({ vary: 0.1, spare: STEP_SPARE });

/** @type {Record<string, SoundRecipe>} */
const MATERIALS = {
  // ---- stone: a bright crack, short inharmonic modes between 1 and 4 kHz, rubble ------------------------------------
  breakStone: sound(0.25, [
    noise({ hp: 1200, lp: 7000, gain: 0.9, attack: 0.001, decay: 0.022 }),
    sine(1150, { partials: [[1.63, 0.7, 0.7], [2.41, 0.5, 0.5], [3.3, 0.3, 0.35]], gain: 0.55, attack: 0.001, decay: 0.09 }),
    noise({ bp: 2400, q: 1.6, gain: 0.5, delay: 0.025, decay: 0.03, grains: { count: [4, 6], over: 0.2, gainVar: 0.6, pitchVar: 0.3 } }),
    sine(170, { f1: 90, gain: 0.2, decay: 0.07 }),
  ], { vary: 0.08 }),
  digStone: sound(0.34, [
    noise({ hp: 1500, lp: 6500, gain: 0.8, attack: 0.001, decay: 0.012 }),
    sine(1320, { partials: [[1.7, 0.6, 0.6], [2.6, 0.3, 0.4]], gain: 0.4, attack: 0.001, decay: 0.05 }),
    noise({ bp: 2600, q: 2, gain: 0.3, delay: 0.014, decay: 0.02, grains: { count: [1, 2], over: 0.05, gainVar: 0.5, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  placeStone: sound(0.42, [
    noise({ bp: 1400, q: 1.2, gain: 0.7, attack: 0.001, decay: 0.014 }),
    sine(620, { partials: [[1.52, 0.6, 0.7], [2.3, 0.3, 0.5]], gain: 0.45, attack: 0.001, decay: 0.05 }),
    sine(165, { f1: 95, gain: 0.3, decay: 0.06 }),
  ], { vary: 0.08 }),
  stepStone: sound(0.43, [
    noise({ hp: 300, lp: 1900, gain: 0.8, decay: 0.016 }),
    noise({ bp: 2800, q: 1, gain: 0.25, delay: 0.006, attack: 0.004, decay: 0.035 }),
  ], STEP),

  // ---- wood: a knock with modes between 200 and 900 Hz and a quick decay; a break splinters ------------------------
  breakWood: sound(0.55, [
    noise({ bp: 1300, q: 1, gain: 0.8, attack: 0.001, decay: 0.012 }),
    sine(230, { partials: [[1.78, 0.8, 0.8], [2.9, 0.5, 0.55], [3.9, 0.3, 0.4]], gain: 0.6, attack: 0.001, decay: 0.11 }),
    noise({ bp: 2300, q: 2.2, gain: 0.5, delay: 0.015, decay: 0.018, grains: { count: [2, 4], over: 0.09, gainVar: 0.5, pitchVar: 0.3 } }),
    sine(150, { f1: 88, gain: 0.3, decay: 0.06 }),
  ], { vary: 0.08 }),
  digWood: sound(0.5, [
    noise({ bp: 1500, q: 1, gain: 0.7, attack: 0.001, decay: 0.01 }),
    sine(262, { partials: [[1.8, 0.7, 0.7], [2.95, 0.4, 0.5]], gain: 0.6, attack: 0.001, decay: 0.07 }),
  ], { vary: 0.1 }),
  placeWood: sound(0.52, [
    noise({ bp: 900, q: 1, gain: 0.5, attack: 0.001, decay: 0.012 }),
    sine(190, { partials: [[1.75, 0.7, 0.8], [2.8, 0.3, 0.5]], gain: 0.7, attack: 0.001, decay: 0.08 }),
  ], { vary: 0.08 }),
  stepWood: sound(0.34, [
    noise({ lp: 1200, gain: 0.5, decay: 0.014 }),
    sine(172, { partials: [[1.9, 0.5, 0.6], [3.1, 0.2, 0.4]], gain: 0.6, attack: 0.001, decay: 0.06 }),
  ], STEP),

  // ---- glass: high ringing modes with a longer tail, and the tinkle of shards ---------------------------------------
  breakGlass: sound(0.33, [
    noise({ hp: 3500, lp: 9000, gain: 0.7, attack: 0.001, decay: 0.012 }),
    sine(2150, { partials: [[1.57, 0.8, 0.8], [2.31, 0.6, 0.55], [2.93, 0.4, 0.4]], gain: 0.32, attack: 0.001, decay: 0.3 }),
    sine(4300, { gain: 0.2, delay: 0.03, attack: 0.001, decay: 0.05, grains: { count: [6, 9], over: 0.32, gainVar: 0.7, pitchVar: 0.4 } }),
    noise({ bp: 5200, q: 1.5, gain: 0.3, delay: 0.01, decay: 0.02, grains: { count: [3, 5], over: 0.18, gainVar: 0.6, pitchVar: 0.3 } }),
  ], { vary: 0.07 }),
  digGlass: sound(0.35, [
    noise({ hp: 4000, lp: 9000, gain: 0.45, attack: 0.001, decay: 0.006 }),
    sine(2400, { partials: [[1.6, 0.6, 0.6], [2.4, 0.3, 0.4]], gain: 0.32, attack: 0.001, decay: 0.12 }),
  ], { vary: 0.08 }),
  placeGlass: sound(0.43, [
    noise({ bp: 3000, q: 1.5, gain: 0.35, attack: 0.001, decay: 0.008 }),
    sine(1900, { partials: [[1.55, 0.5, 0.6]], gain: 0.28, attack: 0.001, decay: 0.09 }),
    sine(165, { f1: 95, gain: 0.25, decay: 0.05 }),
  ], { vary: 0.07 }),
  stepGlass: sound(0.47, [
    noise({ bp: 2600, q: 1, gain: 0.5, decay: 0.012 }),
    sine(2000, { partials: [[1.6, 0.4, 0.5]], gain: 0.12, attack: 0.001, decay: 0.06 }),
  ], STEP),

  // ---- dirt: a dull thud and a short low crumble ---------------------------------------------------------------------
  breakDirt: sound(0.8, [
    sine(150, { f1: 85, gain: 0.2, decay: 0.08 }),
    noise({ bp: 380, q: 0.7, lp: 1200, gain: 1, attack: 0.003, decay: 0.06 }),
    noise({ bp: 680, q: 0.8, lp: 1500, gain: 1, delay: 0.03, attack: 0.003, decay: 0.035, grains: { count: [3, 5], over: 0.16, gainVar: 0.4, pitchVar: 0.35 } }),
  ], { vary: 0.1 }),
  digDirt: sound(0.8, [
    noise({ bp: 450, q: 0.7, gain: 1, attack: 0.003, decay: 0.045 }),
    sine(155, { f1: 90, gain: 0.15, decay: 0.05 }),
    noise({ bp: 700, q: 0.9, gain: 0.45, delay: 0.02, attack: 0.003, decay: 0.03, grains: { count: [1, 3], over: 0.07, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  placeDirt: sound(0.83, [
    sine(150, { f1: 85, gain: 0.2, decay: 0.08 }),
    noise({ bp: 400, q: 0.7, gain: 1, attack: 0.003, decay: 0.04 }),
  ], { vary: 0.1 }),
  stepDirt: sound(0.35, [
    noise({ bp: 360, q: 0.7, gain: 1, attack: 0.004, decay: 0.04 }),
    sine(150, { f1: 90, gain: 0.12, decay: 0.04 }),
  ], STEP),

  // ---- grass: the dirt's thud, lighter, under a dry rustle of blades ------------------------------------------------
  breakGrass: sound(1, [
    sine(150, { f1: 85, gain: 0.18, decay: 0.08 }),
    noise({ bp: 420, q: 0.7, gain: 0.9, attack: 0.003, decay: 0.05 }),
    noise({ bp: 3600, q: 0.8, gain: 0.3, attack: 0.006, decay: 0.04, grains: { count: [3, 5], over: 0.15, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  digGrass: sound(0.94, [
    noise({ bp: 450, q: 0.7, gain: 0.9, attack: 0.003, decay: 0.04 }),
    noise({ bp: 3800, q: 0.9, gain: 0.14, attack: 0.005, decay: 0.03, grains: { count: [2, 3], over: 0.06, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  placeGrass: sound(0.7, [
    sine(150, { f1: 85, gain: 0.2, decay: 0.075 }),
    noise({ bp: 420, q: 0.7, gain: 0.9, attack: 0.003, decay: 0.035 }),
    noise({ bp: 3400, q: 0.8, gain: 0.2, attack: 0.005, decay: 0.04 }),
  ], { vary: 0.1 }),
  stepGrass: sound(0.32, [
    noise({ bp: 380, q: 0.7, gain: 1, attack: 0.004, decay: 0.04 }),
    noise({ bp: 4200, q: 0.8, gain: 0.12, attack: 0.008, decay: 0.05, grains: { count: [2, 3], over: 0.07, gainVar: 0.4, pitchVar: 0.3 } }),
  ], STEP),

  // ---- sand: a hiss that dies away slowly ----------------------------------------------------------------------------
  breakSand: sound(0.26, [
    noise({ hp: 1500, bp: [4200, 1900], q: 0.7, lp: 7500, gain: 0.8, attack: 0.006, decay: 0.26 }),
    noise({ lp: 500, gain: 0.6, attack: 0.003, decay: 0.04 }),
    sine(150, { f1: 85, gain: 0.2, decay: 0.06 }),
  ], { vary: 0.1 }),
  digSand: sound(0.24, [
    noise({ hp: 1200, bp: [3800, 2200], q: 0.7, lp: 7500, gain: 0.8, attack: 0.005, decay: 0.09 }),
    noise({ lp: 450, gain: 0.4, attack: 0.003, decay: 0.03 }),
  ], { vary: 0.1 }),
  placeSand: sound(0.29, [
    sine(150, { f1: 85, gain: 0.25, decay: 0.07 }),
    noise({ hp: 1000, bp: [3200, 1800], q: 0.7, lp: 7500, gain: 0.6, attack: 0.004, decay: 0.12 }),
  ], { vary: 0.1 }),
  stepSand: sound(0.11, [
    noise({ hp: 1000, bp: [3400, 2000], q: 0.7, lp: 7500, gain: 0.7, attack: 0.008, decay: 0.08 }),
    noise({ lp: 420, gain: 0.5, attack: 0.004, decay: 0.035 }),
  ], STEP),

  // ---- gravel: several tiny clicks scattered over 80–150 ms, over a low crunch ---------------------------------------
  breakGravel: sound(0.83, [
    noise({ bp: 2300, q: 1.8, gain: 0.9, attack: 0.001, decay: 0.014, grains: { count: [7, 10], over: 0.17, gainVar: 0.5, pitchVar: 0.4 } }),
    noise({ bp: 900, q: 0.9, gain: 0.7, attack: 0.003, decay: 0.1 }),
    sine(150, { f1: 85, gain: 0.2, decay: 0.07 }),
  ], { vary: 0.08 }),
  digGravel: sound(0.82, [
    noise({ bp: 2400, q: 1.8, gain: 0.9, attack: 0.001, decay: 0.014, grains: { count: [3, 5], over: 0.08, gainVar: 0.5, pitchVar: 0.4 } }),
    noise({ bp: 900, q: 0.9, gain: 0.5, attack: 0.003, decay: 0.05 }),
  ], { vary: 0.08 }),
  placeGravel: sound(0.8, [
    sine(150, { f1: 85, gain: 0.2, decay: 0.07 }),
    noise({ bp: 2200, q: 1.8, gain: 0.7, attack: 0.001, decay: 0.014, grains: { count: [3, 4], over: 0.06, gainVar: 0.5, pitchVar: 0.4 } }),
    noise({ bp: 850, q: 0.9, gain: 0.6, attack: 0.003, decay: 0.05 }),
  ], { vary: 0.08 }),
  stepGravel: sound(0.38, [
    noise({ bp: 2300, q: 1.8, gain: 0.7, attack: 0.001, decay: 0.014, grains: { count: [3, 4], over: 0.075, gainVar: 0.5, pitchVar: 0.4 } }),
    noise({ bp: 800, q: 0.9, gain: 0.45, attack: 0.004, decay: 0.05 }),
  ], STEP),

  // ---- snow: a squeaky crunch — band-passed noise in a few grains, a thin squeak, a soft thud -------------------------
  breakSnow: sound(0.61, [
    noise({ bp: [1500, 800], q: 1.4, gain: 0.9, attack: 0.004, decay: 0.05, grains: { count: [3, 4], over: 0.14, gainVar: 0.3, pitchVar: 0.2 } }),
    noise({ bp: [2300, 2900], q: 4, gain: 0.3, attack: 0.01, decay: 0.08 }),
    noise({ lp: 320, gain: 0.7, attack: 0.004, decay: 0.06 }),
  ], { vary: 0.08 }),
  digSnow: sound(0.49, [
    noise({ bp: [1500, 850], q: 1.4, gain: 0.9, attack: 0.004, decay: 0.04, grains: { count: 2, over: 0.09, jitter: 0.4, gainVar: 0.25, pitchVar: 0.2 } }),
    noise({ bp: [2300, 2800], q: 4, gain: 0.25, attack: 0.008, decay: 0.06 }),
  ], { vary: 0.08 }),
  placeSnow: sound(0.63, [
    noise({ lp: 340, gain: 0.8, attack: 0.004, decay: 0.06 }),
    noise({ bp: [1400, 800], q: 1.4, gain: 0.7, attack: 0.004, decay: 0.04, grains: { count: 2, over: 0.09, jitter: 0.4, gainVar: 0.25, pitchVar: 0.2 } }),
  ], { vary: 0.08 }),
  stepSnow: sound(0.21, [
    noise({ bp: [1500, 800], q: 1.4, gain: 0.8, attack: 0.004, decay: 0.035, grains: { count: [2, 3], over: 0.08, gainVar: 0.3, pitchVar: 0.2 } }),
    noise({ bp: [2200, 2900], q: 4, gain: 0.2, attack: 0.01, decay: 0.06 }),
    noise({ lp: 300, gain: 0.5, attack: 0.004, decay: 0.04 }),
  ], STEP),

  // ---- leaves: a dry, uneven rustle between 2 and 6 kHz; a break snaps a twig ------------------------------------------
  breakLeaves: sound(0.34, [
    noise({ bp: 3300, q: 1, lp: 6500, gain: 0.8, attack: 0.006, decay: 0.045, grains: { count: [5, 7], over: 0.24, jitter: 0.6, gainVar: 0.35, pitchVar: 0.3 } }),
    noise({ bp: 1900, q: 2, gain: 0.4, delay: 0.01, attack: 0.001, decay: 0.012 }),
    noise({ hp: 3500, lp: 7500, gain: 0.12, attack: 0.01, decay: 0.12 }),
  ], { vary: 0.1 }),
  digLeaves: sound(0.26, [
    noise({ bp: 3400, q: 1, lp: 6500, gain: 0.8, attack: 0.006, decay: 0.04, grains: { count: [2, 4], over: 0.12, jitter: 0.6, gainVar: 0.35, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  placeLeaves: sound(0.27, [
    noise({ bp: 3200, q: 1, lp: 6500, gain: 0.7, attack: 0.006, decay: 0.04, grains: { count: 3, over: 0.13, jitter: 0.5, gainVar: 0.3, pitchVar: 0.3 } }),
    noise({ lp: 600, gain: 0.4, attack: 0.003, decay: 0.03 }),
  ], { vary: 0.1 }),
  stepLeaves: sound(0.13, [
    noise({ bp: 3300, q: 1, lp: 6500, gain: 0.6, attack: 0.006, decay: 0.04, grains: { count: [3, 4], over: 0.14, jitter: 0.6, gainVar: 0.35, pitchVar: 0.3 } }),
  ], STEP),

  // ---- cloth: a soft muffled puff; a break tears a little ------------------------------------------------------------
  breakCloth: sound(0.42, [
    noise({ bp: 400, q: 0.6, gain: 1, attack: 0.006, decay: 0.07 }),
    sine(155, { f1: 95, gain: 0.18, decay: 0.07 }),
    noise({ bp: [1700, 900], q: 1.2, gain: 0.45, attack: 0.004, decay: 0.09, lfoHz: 55, lfoDepth: 1.2 }),
  ], { vary: 0.1 }),
  digCloth: sound(0.42, [
    noise({ bp: 420, q: 0.6, gain: 1, attack: 0.005, decay: 0.045 }),
    noise({ bp: [1600, 1000], q: 1.2, gain: 0.3, attack: 0.004, decay: 0.05, lfoHz: 55, lfoDepth: 1.2 }),
  ], { vary: 0.1 }),
  placeCloth: sound(0.43, [
    noise({ bp: 380, q: 0.6, gain: 1, attack: 0.006, decay: 0.06 }),
    sine(155, { f1: 95, gain: 0.18, decay: 0.06 }),
  ], { vary: 0.1 }),
  stepCloth: sound(0.2, [
    noise({ bp: 360, q: 0.6, gain: 1, attack: 0.006, decay: 0.045 }),
    sine(150, { f1: 95, gain: 0.1, decay: 0.04 }),
  ], STEP),

  // ---- water: a rising bloop and a wash when it is taken, a plop when it is poured; a step in it is a wade ----------
  breakWater: sound(0.33, [
    sine(280, { f1: 620, gain: 0.5, attack: 0.01, decay: 0.09 }),
    noise({ bp: 1700, q: 0.9, gain: 0.5, attack: 0.01, decay: 0.16 }),
    sine(640, { f1: 900, gain: 0.2, delay: 0.05, attack: 0.004, decay: 0.04, grains: { count: [2, 3], over: 0.12, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  digWater: sound(0.3, [
    noise({ bp: [1500, 900], q: 0.9, gain: 0.6, attack: 0.01, decay: 0.09 }),
    sine(420, { f1: 640, gain: 0.3, attack: 0.006, decay: 0.05 }),
  ], { vary: 0.1 }),
  placeWater: sound(0.16, [
    sine(520, { f1: 190, gain: 0.5, attack: 0.005, decay: 0.1 }),
    noise({ bp: [2200, 900], q: 0.8, gain: 0.5, attack: 0.01, decay: 0.22 }),
    sine(600, { f1: 900, gain: 0.2, delay: 0.06, attack: 0.004, decay: 0.04, grains: { count: [2, 3], over: 0.14, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.1 }),
  /** A step in shallow water (wading): a slosh, a drip or two and a little spray. */
  stepWater: sound(0.16, [
    noise({ bp: [600, 1500], q: 0.8, gain: 0.8, attack: 0.03, decay: 0.2 }),
    sine(320, { f1: 520, gain: 0.25, delay: 0.04, attack: 0.005, decay: 0.05, grains: { count: [1, 3], over: 0.15, gainVar: 0.4, pitchVar: 0.35 } }),
    noise({ hp: 3000, lp: 8000, gain: 0.15, attack: 0.02, decay: 0.12 }),
  ], { vary: 0.12, spare: STEP_SPARE }),
};

/** The four things done to a block that have a sound of their own. */
export const MATERIAL_ACTIONS = Object.freeze(['break', 'dig', 'place', 'step']);

/**
 * The bank name of a material's sound: `materialSound('break', 'stone')` → 'breakStone'.
 * @param {string} action  one of MATERIAL_ACTIONS
 * @param {string} group   one of blocks.SOUND_GROUPS
 * @returns {string}
 */
export function materialSound(action, group) {
  return `${action}${group.charAt(0).toUpperCase()}${group.slice(1)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Footsteps and movement (the steps are above, one per sound group)
// ---------------------------------------------------------------------------------------------------------------------

/** @type {Record<string, SoundRecipe>} */
const MOVEMENT = {
  /** Pushing off the ground: a short rising swish of cloth. */
  jump: sound(0.09, [
    noise({ bp: [700, 1600], q: 0.8, gain: 0.8, attack: 0.03, decay: 0.09 }),
  ], { vary: 0.1, spare: STEP_SPARE }),
  /** Coming down: a low thump with a knock in it (main scales it by the fall speed and adds the ground's own step). */
  landThud: sound(0.73, [
    sine(150, { f1: 82, gain: 0.2, decay: 0.12 }),
    noise({ bp: 400, q: 0.6, gain: 1, attack: 0.002, decay: 0.07 }),
    noise({ bp: 900, q: 0.8, gain: 0.45, attack: 0.002, decay: 0.03 }),
  ], { vary: 0.1 }),
  /** A swimming stroke at the surface: a slow wash and a gurgle. */
  swim: sound(0.19, [
    noise({ bp: [450, 1000], q: 0.7, gain: 0.8, attack: 0.09, decay: 0.32 }),
    noise({ bp: 2400, q: 0.8, gain: 0.2, attack: 0.1, decay: 0.2 }),
    sine(240, { f1: 330, gain: 0.2, delay: 0.1, attack: 0.01, decay: 0.06, grains: { count: [1, 2], over: 0.2, gainVar: 0.4, pitchVar: 0.3 } }),
  ], { vary: 0.12, spare: STEP_SPARE }),
  /** The same stroke with the head under water: muffled, with bubbles. */
  swimUnder: sound(0.24, [
    noise({ lp: 420, gain: 0.9, attack: 0.09, decay: 0.3 }),
    sine(260, { f1: 420, gain: 0.3, delay: 0.06, attack: 0.008, decay: 0.05, grains: { count: [2, 4], over: 0.25, gainVar: 0.5, pitchVar: 0.4 } }),
  ], { vary: 0.12, spare: STEP_SPARE }),
  /** Going into deep water: the splash's crown, the plunk of the body, the wash closing over it, bubbles. */
  splashIn: sound(0.25, [
    noise({ hp: 700, lp: [7000, 2500], gain: 0.9, attack: 0.004, decay: 0.38 }),
    sine(230, { f1: 85, gain: 0.7, decay: 0.16 }),
    noise({ bp: 1300, q: 0.8, gain: 0.5, delay: 0.03, attack: 0.02, decay: 0.3 }),
    sine(480, { f1: 820, gain: 0.3, delay: 0.09, attack: 0.004, decay: 0.045, grains: { count: [3, 5], over: 0.3, gainVar: 0.5, pitchVar: 0.4 } }),
  ], { vary: 0.1 }),
  /** Climbing out: water running off, a few drips. */
  splashOut: sound(0.17, [
    noise({ bp: [1800, 900], q: 0.8, gain: 0.7, attack: 0.02, decay: 0.25 }),
    sine(900, { f1: 1400, gain: 0.2, delay: 0.08, attack: 0.003, decay: 0.03, grains: { count: [2, 4], over: 0.3, gainVar: 0.5, pitchVar: 0.3 } }),
  ], { vary: 0.1, spare: STEP_SPARE }),
};

// ---------------------------------------------------------------------------------------------------------------------
// 3. Animals and zombies. A voice: a sawtooth with a pitch glide and vibrato, through formants, beside breath noise.
// ---------------------------------------------------------------------------------------------------------------------

/** The pig's voice box: nasal, with a strong resonance near 1 kHz, roughened by a fast wobble. */
const PIG = { lfoHz: 33, lfoDepth: 1, lfoShape: 'tri', formants: [[200, 1, 0.6], [420, 3, 1.4], [980, 5, 2], [1950, 6, 0.8]], lp: 3200 };
const SHEEP_FORMANTS = [[320, 1, 0.8], [720, 4, 2], [1750, 5, 1.6], [2600, 6, 0.6]];
const BEAR = { lfoShape: 'tri', formants: [[140, 0.8, 0.6], [210, 3, 2], [450, 3, 1.6], [900, 4, 0.6]], lp: 2000 };
/** A tired, half-open mouth: "uh". */
const ZOMBIE_FORMANTS = [[170, 0.8, 0.6], [[480, 540], 4, 1.8], [[980, 900], 5, 0.7]];

/** @type {Record<string, SoundRecipe>} */
const VOICES = {
  // ---- pig -----------------------------------------------------------------------------------------------------------
  /** Grunts: short nasal bursts — two, three quick ones, or one long snuffle. */
  pigOink: oneOf([
    sound(0.26, [
      saw(150, { f1: 104, ...PIG, gain: 0.8, attack: 0.012, hold: 0.03, decay: 0.085, grains: [[0, 1, 1], [0.16, 0.93, 0.85]] }),
      noise({ bp: 1100, q: 1.5, gain: 0.22, attack: 0.01, decay: 0.09, grains: [[0, 1, 1], [0.16, 1, 0.8]] }),
    ]),
    sound(0.28, [
      saw(158, { f1: 116, ...PIG, gain: 0.8, attack: 0.01, hold: 0.015, decay: 0.07, grains: [[0, 1, 0.85], [0.11, 1.06, 1], [0.22, 0.92, 0.8]] }),
      noise({ bp: 1150, q: 1.5, gain: 0.2, attack: 0.01, decay: 0.07, grains: [[0, 1, 0.85], [0.11, 1, 1], [0.22, 1, 0.8]] }),
    ]),
    sound(0.23, [
      saw(134, { f1: 108, ...PIG, lfoHz: 28, lfoDepth: 1.3, gain: 0.8, attack: 0.03, hold: 0.16, decay: 0.16 }),
      noise({ bp: 1000, q: 1.2, gain: 0.3, attack: 0.03, hold: 0.14, decay: 0.16, lfoHz: 28, lfoDepth: 1.3, lfoShape: 'tri' }),
    ]),
  ], { vary: 0.08, stretch: 0.1 }),
  /** Hit: one cry that rises, then falls. */
  pigSqueal: sound(0.11, [
    saw(620, { glide: [[0.35, 1100], [1, 700]], vibHz: 17, vibDepth: 0.03, formants: [[700, 1, 0.7], [1150, 3, 1.8], [2300, 4, 1.4], [3300, 5, 0.4]], lp: 4600, gain: 0.8, attack: 0.015, hold: 0.08, decay: 0.2 }),
    noise({ bp: 2400, q: 1, gain: 0.1, attack: 0.015, hold: 0.06, decay: 0.16 }),
  ], { vary: 0.08, stretch: 0.1 }),

  // ---- cattle: a moo of about 90–130 Hz, over a second, opening from "mm" to "oo" -------------------------------------
  cowMoo: oneOf([
    sound(0.28, [
      saw(96, { glide: [[0.25, 124], [0.7, 116], [1, 86]], vibHz: 5, vibDepth: 0.012, lfoHz: 29, lfoDepth: 0.25, formants: [[170, 0.8, 0.5], [[270, 430], 4, 2.2], [[750, 980], 5, 1.6], [2300, 6, 0.3]], lp: 2600, gain: 0.8, attack: 0.14, hold: 0.75, decay: 0.45 }),
      noise({ bp: [400, 600], q: 0.8, gain: 0.07, attack: 0.2, hold: 0.6, decay: 0.4 }),
    ]),
    sound(0.28, [
      saw(104, { glide: [[0.3, 130], [1, 94]], vibHz: 5.5, vibDepth: 0.012, lfoHz: 31, lfoDepth: 0.25, formants: [[180, 0.8, 0.5], [[300, 460], 4, 2.2], [[800, 1050], 5, 1.6], [2400, 6, 0.3]], lp: 2800, gain: 0.8, attack: 0.1, hold: 0.6, decay: 0.4 }),
      noise({ bp: [450, 650], q: 0.8, gain: 0.07, attack: 0.12, hold: 0.5, decay: 0.35 }),
    ]),
    sound(0.39, [
      saw(90, { glide: [[0.5, 100], [1, 84]], vibHz: 4.5, vibDepth: 0.012, lfoHz: 27, lfoDepth: 0.2, formants: [[160, 0.8, 0.6], [260, 4, 2.2], [900, 6, 0.5]], lp: 1000, gain: 0.8, attack: 0.2, hold: 0.5, decay: 0.4 }),
      noise({ bp: 420, q: 0.8, gain: 0.05, attack: 0.2, hold: 0.4, decay: 0.4 }),
    ]),
  ], { vary: 0.07, stretch: 0.12 }),

  // ---- sheep: a bleat near 300 Hz with a strong 8–12 Hz tremolo -------------------------------------------------------
  sheepBaa: oneOf([
    sound(0.1, [
      saw(310, { glide: [[0.2, 335], [1, 285]], vibHz: 9.5, vibDepth: 0.025, lfoHz: 9.5, lfoDepth: 1.3, formants: SHEEP_FORMANTS, lp: 4200, gain: 0.8, attack: 0.04, hold: 0.42, decay: 0.3 }),
      noise({ bp: 1800, q: 0.8, gain: 0.05, attack: 0.05, hold: 0.35, decay: 0.3, lfoHz: 9.5, lfoDepth: 1.3 }),
    ]),
    sound(0.088, [
      saw(365, { glide: [[0.25, 390], [1, 340]], vibHz: 11, vibDepth: 0.025, lfoHz: 11, lfoDepth: 1.3, formants: [[360, 1, 0.8], [800, 4, 2], [1950, 5, 1.6], [2900, 6, 0.6]], lp: 4800, gain: 0.8, attack: 0.03, hold: 0.25, decay: 0.22 }),
      noise({ bp: 2100, q: 0.8, gain: 0.05, attack: 0.04, hold: 0.2, decay: 0.2, lfoHz: 11, lfoDepth: 1.3 }),
    ]),
    sound(0.13, [
      saw(252, { glide: [[0.2, 268], [1, 236]], vibHz: 8, vibDepth: 0.025, lfoHz: 8, lfoDepth: 1.3, formants: SHEEP_FORMANTS, lp: 3800, gain: 0.8, attack: 0.05, hold: 0.6, decay: 0.35 }),
      noise({ bp: 1700, q: 0.8, gain: 0.05, attack: 0.06, hold: 0.5, decay: 0.35, lfoHz: 8, lfoDepth: 1.3 }),
    ]),
  ], { vary: 0.07, stretch: 0.12 }),

  // ---- horse: a whinny (a falling pitch with fast vibrato), a snort, a low nicker -------------------------------------
  horseNeigh: oneOf([
    sound(0.058, [
      saw(1250, { glide: [[0.1, 1480], [0.45, 980], [1, 440]], vibHz: 12, vibDepth: 0.06, lfoHz: 12, lfoDepth: 0.9, formants: [[700, 1, 0.8], [1000, 3, 1.6], [1900, 4, 1.2], [2900, 5, 0.5]], lp: 4800, gain: 0.8, attack: 0.06, hold: 0.7, decay: 0.45 }),
      noise({ bp: [2200, 1200], q: 0.7, gain: 0.06, attack: 0.06, hold: 0.6, decay: 0.4 }),
    ]),
    sound(0.21, [
      noise({ bp: [1000, 550], q: 0.9, gain: 0.9, attack: 0.012, hold: 0.08, decay: 0.3, lfoHz: 27, lfoDepth: 1.6, lfoShape: 'tri' }),
      saw(72, { f1: 60, formants: [[180, 1, 0.7], [420, 3, 1.2]], gain: 0.5, attack: 0.012, hold: 0.08, decay: 0.25, lfoHz: 27, lfoDepth: 1.6, lfoShape: 'tri' }),
    ]),
    sound(0.17, [
      saw(118, { f1: 96, formants: [[190, 1, 0.7], [380, 3, 1.8], [950, 5, 0.8]], lp: 2400, lfoHz: 15, lfoDepth: 1.6, lfoShape: 'tri', gain: 0.8, attack: 0.05, hold: 0.3, decay: 0.22 }),
      noise({ bp: 700, q: 0.8, gain: 0.1, attack: 0.05, hold: 0.25, decay: 0.2, lfoHz: 15, lfoDepth: 1.6, lfoShape: 'tri' }),
    ]),
  ], { vary: 0.07, stretch: 0.12 }),

  // ---- wolf: a bark, a whine, and by night a howl (a slow rising and falling glide with vibrato) ----------------------
  wolfBark: oneOf([
    sound(0.19, [
      saw(300, { glide: [[0.15, 360], [1, 175]], formants: [[300, 1, 1], [560, 3, 2], [1150, 4, 1.4], [2300, 5, 0.4]], lp: 3600, gain: 0.8, attack: 0.008, hold: 0.02, decay: 0.15 }),
      noise({ bp: 950, q: 1.2, gain: 0.3, attack: 0.006, decay: 0.1 }),
    ]),
    sound(0.18, [
      saw(290, { glide: [[0.15, 345], [1, 170]], formants: [[300, 1, 1], [560, 3, 2], [1150, 4, 1.4], [2300, 5, 0.4]], lp: 3600, gain: 0.8, attack: 0.008, hold: 0.02, decay: 0.13, grains: [[0, 1, 1], [0.2, 0.93, 0.8]] }),
      noise({ bp: 950, q: 1.2, gain: 0.3, attack: 0.006, decay: 0.1, grains: [[0, 1, 1], [0.2, 1, 0.8]] }),
    ]),
  ], { vary: 0.08, stretch: 0.1 }),
  wolfWhine: sound(0.089, [
    tri(720, { glide: [[0.5, 1020], [1, 800]], vibHz: 7, vibDepth: 0.02, partials: [[2, 0.2]], lp: 2600, gain: 0.7, attack: 0.06, hold: 0.1, decay: 0.2 }),
    noise({ bp: 1500, q: 0.8, gain: 0.04, attack: 0.06, decay: 0.25 }),
  ], { vary: 0.08, stretch: 0.1 }),
  wolfHowl: oneOf([
    sound(0.13, [
      tri(285, { glide: [[0.22, 500], [0.75, 520], [1, 350]], vibHz: 5.5, vibDepth: 0.014, partials: [[2, 0.28], [3, 0.1]], lp: 1900, gain: 0.8, attack: 0.35, hold: 1.3, decay: 0.8 }),
      noise({ bp: 800, q: 0.8, gain: 0.035, attack: 0.4, hold: 1.1, decay: 0.7 }),
    ]),
    sound(0.14, [
      tri(240, { glide: [[0.12, 250], [0.3, 440], [0.8, 455], [1, 300]], vibHz: 5, vibDepth: 0.014, partials: [[2, 0.28], [3, 0.1]], lp: 1800, gain: 0.8, attack: 0.25, hold: 1.0, decay: 0.9 }),
      noise({ bp: 760, q: 0.8, gain: 0.035, attack: 0.3, hold: 0.9, decay: 0.8 }),
    ]),
    sound(0.14, [
      tri(330, { glide: [[0.15, 470], [0.6, 482], [1, 280]], vibHz: 5.8, vibDepth: 0.016, partials: [[2, 0.28], [3, 0.1]], lp: 1900, gain: 0.8, attack: 0.3, hold: 1.6, decay: 0.9 }),
      noise({ bp: 820, q: 0.8, gain: 0.035, attack: 0.35, hold: 1.4, decay: 0.8 }),
    ]),
  ], { vary: 0.08, stretch: 0.1 }),

  // ---- deer: a short hoarse bark, or a fawn's soft mew ----------------------------------------------------------------
  deerBark: oneOf([
    sound(0.12, [
      saw(430, { glide: [[0.2, 470], [1, 300]], formants: [[420, 1, 0.8], [820, 3, 2], [1550, 4, 1.4], [2600, 5, 0.5]], lp: 4000, gain: 0.8, attack: 0.01, hold: 0.04, decay: 0.16 }),
      noise({ bp: 1500, q: 1, gain: 0.4, attack: 0.008, hold: 0.03, decay: 0.14 }),
    ]),
    sound(0.059, [
      saw(520, { f1: 440, lfoHz: 9, lfoDepth: 0.8, formants: [[500, 1, 0.8], [900, 3, 1.8], [1700, 4, 1.2]], lp: 3600, gain: 0.8, attack: 0.03, hold: 0.12, decay: 0.18 }),
      noise({ bp: 1600, q: 0.8, gain: 0.08, attack: 0.03, hold: 0.1, decay: 0.16 }),
    ]),
  ], { vary: 0.08, stretch: 0.1 }),

  // ---- rabbit: a soft thump of the hind foot (twice, or once and a sniff) ------------------------------------------
  rabbitThump: oneOf([
    sound(0.51, [
      sine(150, { f1: 85, gain: 0.2, decay: 0.08, grains: [[0, 1, 1], [0.17, 0.94, 0.8]] }),
      noise({ bp: 480, q: 0.7, gain: 1, attack: 0.002, decay: 0.045, grains: [[0, 1, 1], [0.17, 1, 0.8]] }),
    ]),
    sound(0.53, [
      sine(155, { f1: 88, gain: 0.2, decay: 0.08 }),
      noise({ bp: 500, q: 0.7, gain: 1, attack: 0.002, decay: 0.045 }),
      noise({ hp: 2800, lp: 7000, gain: 0.12, delay: 0.15, attack: 0.012, decay: 0.05, grains: [[0, 1, 1], [0.09, 1.1, 0.8]] }),
    ]),
  ], { vary: 0.1 }),

  // ---- pheasant: a harsh two-note crow, then a short drum of the wings --------------------------------------------
  pheasantCrow: sound(0.11, [
    saw(640, { f1: 600, lfoHz: 68, lfoDepth: 1.1, lfoShape: 'tri', formants: [[650, 1, 0.8], [1250, 3, 1.8], [2500, 4, 1.4], [3500, 5, 0.5]], lp: 5200, gain: 0.75, attack: 0.008, hold: 0.07, decay: 0.09 }),
    saw(820, { f1: 760, delay: 0.2, lfoHz: 68, lfoDepth: 1.1, lfoShape: 'tri', formants: [[650, 1, 0.8], [1250, 3, 1.8], [2500, 4, 1.4], [3500, 5, 0.5]], lp: 5200, gain: 0.85, attack: 0.006, hold: 0.03, decay: 0.08 }),
    noise({ bp: [700, 450], q: 1, gain: 0.3, delay: 0.33, attack: 0.02, hold: 0.1, decay: 0.25, lfoHz: 21, lfoDepth: 1.7, lfoShape: 'tri' }),
  ], { vary: 0.07, stretch: 0.08 }),

  // ---- wild turkey: a gobble (a fast amplitude wobble on a falling pitch), or a few clucks -----------------------------
  turkeyGobble: oneOf([
    sound(0.089, [
      saw(690, { glide: [[1, 380]], vibHz: 13, vibDepth: 0.07, lfoHz: 13, lfoDepth: 1.7, formants: [[450, 1, 0.8], [950, 3, 1.8], [1750, 4, 1.4], [2700, 5, 0.5]], lp: 4200, gain: 0.8, attack: 0.03, hold: 0.35, decay: 0.32 }),
      noise({ bp: 1600, q: 0.8, gain: 0.06, attack: 0.03, hold: 0.3, decay: 0.3, lfoHz: 13, lfoDepth: 1.7 }),
    ]),
    sound(0.11, [
      saw(620, { f1: 500, formants: [[450, 1, 0.8], [950, 3, 1.8], [1750, 4, 1.4], [2700, 5, 0.5]], lp: 4200, gain: 0.8, attack: 0.008, hold: 0.02, decay: 0.07, grains: { count: [2, 4], over: 0.5, jitter: 0.3, gainVar: 0.3, pitchVar: 0.06 } }),
    ]),
  ], { vary: 0.07, stretch: 0.1 }),

  // ---- bear: a grunt in passing, the low rough growl of its warning, the roar of its charge ---------------------------
  bearGrunt: sound(0.19, [
    saw(86, { f1: 68, lfoHz: 24, lfoDepth: 0.9, ...BEAR, gain: 0.85, attack: 0.04, hold: 0.12, decay: 0.25 }),
    noise({ hp: 150, lp: 700, gain: 0.2, attack: 0.03, hold: 0.1, decay: 0.25 }),
  ], { vary: 0.07, stretch: 0.1 }),
  bearGrowl: sound(0.24, [
    saw(78, { glide: [[0.4, 86], [1, 64]], vibHz: 6, vibDepth: 0.03, lfoHz: 23, lfoDepth: 1.2, ...BEAR, gain: 0.85, attack: 0.2, hold: 0.7, decay: 0.5 }),
    noise({ bp: 520, q: 0.8, gain: 0.22, attack: 0.2, hold: 0.6, decay: 0.5, lfoHz: 23, lfoDepth: 1.2, lfoShape: 'tri' }),
  ], { vary: 0.06, stretch: 0.1 }),
  bearRoar: sound(0.21, [
    saw(128, { glide: [[0.2, 165], [1, 86]], vibHz: 7, vibDepth: 0.025, lfoHz: 19, lfoDepth: 1, lfoShape: 'tri', formants: [[190, 0.8, 0.6], [320, 3, 1.8], [680, 3, 1.8], [1350, 4, 0.9], [2400, 5, 0.3]], lp: 3200, gain: 0.85, attack: 0.07, hold: 0.45, decay: 0.5 }),
    noise({ bp: [950, 520], q: 0.7, gain: 0.3, attack: 0.07, hold: 0.4, decay: 0.45, lfoHz: 19, lfoDepth: 1, lfoShape: 'tri' }),
  ], { vary: 0.06, stretch: 0.1 }),

  // ---- fish and birds taking off ----------------------------------------------------------------------------------------
  fishPlop: sound(0.13, [
    sine(520, { f1: 210, gain: 0.7, attack: 0.004, decay: 0.12 }),
    noise({ hp: 1500, lp: 6000, gain: 0.22, decay: 0.05 }),
    sine(720, { f1: 1050, gain: 0.18, delay: 0.08, attack: 0.004, decay: 0.035 }),
  ], { vary: 0.1 }),
  /** A bird flushes: the whirr of its wings, beating about 19 times a second and slowing. */
  wingFlush: sound(0.26, [
    noise({ bp: [1000, 560], q: 1.2, gain: 0.85, attack: 0.03, hold: 0.12, decay: 0.5, lfoHz: 19, lfoDepth: 1.7, lfoShape: 'tri' }),
    noise({ hp: 90, lp: 320, gain: 0.5, attack: 0.03, hold: 0.12, decay: 0.45, lfoHz: 19, lfoDepth: 1.7, lfoShape: 'tri' }),
  ], { vary: 0.08, stretch: 0.1 }),

  // ---- zombies: low, breathy, slowly wobbling; spooky without being frightening (CONTRACTS §71) ----------------------
  zombieGroan: oneOf([
    // "uhh", sagging
    sound(0.21, [
      saw(94, { glide: [[0.3, 99], [1, 78]], vibHz: 4.3, vibDepth: 0.025, lfoHz: 3.1, lfoDepth: 0.5, formants: ZOMBIE_FORMANTS, lp: 1300, gain: 0.8, attack: 0.22, hold: 0.42, decay: 0.55 }),
      noise({ bp: 620, q: 0.7, gain: 0.16, attack: 0.25, hold: 0.3, decay: 0.5 }),
      noise({ hp: 1800, lp: 5000, gain: 0.025, attack: 0.12, decay: 0.5 }),
    ]),
    // "mmm-uh": the mouth opens as the pitch lifts, then it sags
    sound(0.22, [
      saw(88, { glide: [[0.45, 104], [1, 80]], vibHz: 3.8, vibDepth: 0.03, lfoHz: 2.6, lfoDepth: 0.6, formants: [[170, 0.8, 0.6], [[280, 520], 4, 1.8], [[700, 950], 5, 0.6]], lp: 1200, gain: 0.8, attack: 0.3, hold: 0.35, decay: 0.6 }),
      noise({ bp: 560, q: 0.7, gain: 0.14, attack: 0.3, hold: 0.3, decay: 0.5 }),
    ]),
    // a sigh: more breath than voice
    sound(0.29, [
      saw(102, { f1: 80, vibHz: 4.6, vibDepth: 0.02, formants: [[170, 0.8, 0.5], [500, 4, 1.5], [940, 5, 0.5]], lp: 1100, gain: 0.6, attack: 0.15, hold: 0.2, decay: 0.45 }),
      noise({ bp: [900, 500], q: 0.7, gain: 0.3, attack: 0.08, hold: 0.2, decay: 0.45 }),
    ]),
  ], { vary: 0.08, stretch: 0.15 }),
  /** Hit: a short, soft "oof". */
  zombieHurt: sound(0.24, [
    saw(152, { f1: 112, formants: [[180, 0.8, 0.6], [470, 4, 1.8], [940, 5, 0.6]], lp: 1500, gain: 0.8, attack: 0.012, hold: 0.03, decay: 0.16 }),
    noise({ hp: 120, lp: 800, gain: 0.3, attack: 0.003, decay: 0.045 }),
  ], { vary: 0.1 }),
  /** Knocked out or burned away: a falling "ohh" and a soft puff as it goes. */
  zombieDown: sound(0.26, [
    saw(122, { glide: [[1, 60]], vibHz: 4, vibDepth: 0.02, formants: [[170, 0.8, 0.6], [[460, 330], 4, 1.8], [[900, 640], 5, 0.6]], lp: 1300, gain: 0.8, attack: 0.03, hold: 0.15, decay: 0.5 }),
    noise({ bp: 420, q: 0.6, gain: 0.4, delay: 0.1, attack: 0.02, decay: 0.25 }),
    sine(140, { f1: 78, gain: 0.15, delay: 0.12, decay: 0.2 }),
  ], { vary: 0.08 }),
};

/**
 * The bank recipe of each animal voice named in animals.js (`SPECIES[kind].voice`, `SOUNDS`): main plays these in place
 * of the old one-layer calls. `squeak` (the rabbit) is now its thump, `bleat` (the deer) its bark, `cackle` (the
 * pheasant) its crow.
 */
export const VOICE_RECIPES = Object.freeze({
  moo: 'cowMoo',
  baa: 'sheepBaa',
  neigh: 'horseNeigh',
  woof: 'wolfBark',
  whine: 'wolfWhine',
  bleat: 'deerBark',
  squeak: 'rabbitThump',
  cackle: 'pheasantCrow',
  gobble: 'turkeyGobble',
  grunt: 'bearGrunt',
  growl: 'bearGrowl',
  roar: 'bearRoar',
  plop: 'fishPlop',
  flush: 'wingFlush',
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Ambience: four loops (wind, the stream, the fire, the rain) and sparse one-shots (birds, crickets, bubbles,
//    crackles, rain on leaves, far thunder)
// ---------------------------------------------------------------------------------------------------------------------

const AMBIENT = Object.freeze({ spare: AMBIENT_SPARE });
/** @param {number[][]} notes  [[at, pitch, gain], …] @param {object} o @returns {object} a bird's note, sung at each `at` */
const sung = (notes, o) => ({ grains: notes, ...o });

/** @type {Record<string, SoundRecipe>} */
const AMBIENCE = {
  // ---- loops (audio.startLoop; `dur` only says how long a rendering for the tests should be) --------------------------
  /** Wind: noise through three bands that swell at their own slow rates; worldSounds moves the bands and the level. */
  ambWind: { dur: 4.05, gain: 0.2, layers: [
    noise({ bp: 420, q: 1.6, gain: 0.8, decay: 4, lfoHz: 0.11, lfoDepth: 0.7 }),
    noise({ bp: 950, q: 2.2, gain: 0.25, decay: 4, lfoHz: 0.17, lfoDepth: 0.9 }),
    noise({ lp: 180, gain: 0.5, decay: 4, lfoHz: 0.07, lfoDepth: 0.5 }),
  ] },
  /** Running water: four bands of noise, each bubbling at its own rate (the blips below are the single bubbles). */
  ambStream: { dur: 4.05, gain: 0.13, layers: [
    noise({ bp: 900, q: 0.9, gain: 0.5, decay: 4, lfoHz: 3.7, lfoDepth: 0.7 }),
    noise({ bp: 1900, q: 1.2, gain: 0.4, decay: 4, lfoHz: 6.3, lfoDepth: 0.8, lfoShape: 'tri' }),
    noise({ bp: 3600, q: 1.5, gain: 0.22, decay: 4, lfoHz: 9.1, lfoDepth: 0.9 }),
    noise({ lp: 350, gain: 0.35, decay: 4, lfoHz: 2.3, lfoDepth: 0.6, lfoShape: 'tri' }),
  ] },
  /** A fire's bed: a low fluttering roar, a mid flicker and a thin hiss (the crackles below are its pops). */
  ambFire: { dur: 4.05, gain: 0.22, layers: [
    noise({ lp: 240, gain: 0.9, decay: 4, lfoHz: 7.3, lfoDepth: 0.8 }),
    noise({ bp: 700, q: 0.8, gain: 0.3, decay: 4, lfoHz: 11.7, lfoDepth: 0.9, lfoShape: 'tri' }),
    noise({ bp: 4200, q: 1, gain: 0.07, decay: 4, lfoHz: 5.1, lfoDepth: 1 }),
  ] },
  /**
   * Rain (§84): a broad, even hiss with a softer body under it and a low wash, each swelling a little at its own slow
   * rate. worldSounds sets its level by the rain's strength and the cover overhead, and lowers its bands under a roof.
   */
  ambRain: { dur: 4.05, gain: 0.085, layers: [
    noise({ hp: 1800, lp: 7500, gain: 0.3, decay: 4, lfoHz: 0.23, lfoDepth: 0.3 }),
    noise({ bp: 1300, q: 0.7, gain: 0.65, decay: 4, lfoHz: 0.31, lfoDepth: 0.35 }),
    noise({ lp: 420, gain: 0.4, decay: 4, lfoHz: 0.13, lfoDepth: 0.4 }),
  ] },

  // ---- one-shots ---------------------------------------------------------------------------------------------------------
  /** Rain on leaves (§84): a handful of drops tapping, each a short dull tick at its own pitch. */
  rainPatter: sound(0.2, [
    noise({ bp: 2600, q: 2.2, gain: 0.9, attack: 0.001, decay: 0.016, grains: { count: [3, 6], over: 0.3, gainVar: 0.6, pitchVar: 0.45 } }),
  ], { vary: 0.2, ...AMBIENT }),
  /**
   * Thunder a long way off (§84): a low roll that comes in slowly, wavers and dies away over three seconds. Nothing
   * sudden in it: no crack, a soft start.
   */
  thunderRoll: sound(0.24, [
    noise({ lp: 240, gain: 0.9, attack: 0.5, hold: 0.5, decay: 2.2, lfoHz: 5.3, lfoDepth: 0.5 }),
    noise({ bp: 330, q: 0.8, gain: 0.55, delay: 0.15, attack: 0.3, hold: 0.3, decay: 1.6, lfoHz: 3.1, lfoDepth: 0.6, lfoShape: 'tri' }),
  ], { vary: 0.15, stretch: 0.15, ...AMBIENT }),
  /** A bubble or two in the stream: short rising blips. */
  streamBlip: sound(0.084, [
    sine(520, { f1: 900, gain: 0.6, attack: 0.004, decay: 0.04, grains: { count: [1, 3], over: 0.12, gainVar: 0.5, pitchVar: 0.4 } }),
  ], { vary: 0.25, ...AMBIENT }),
  /** A campfire pops: a few snaps, a pop with a low knock, a flurry of tiny ticks, or one sharp crack with a hiss. */
  fireCrackle: oneOf([
    sound(0.53, [
      noise({ bp: 3200, q: 1.2, gain: 0.9, attack: 0.001, decay: 0.012, grains: { count: [2, 3], over: 0.08, gainVar: 0.6, pitchVar: 0.4 } }),
    ]),
    sound(0.62, [
      noise({ bp: 1400, q: 1, gain: 0.9, attack: 0.001, decay: 0.02 }),
      sine(240, { f1: 120, gain: 0.5, attack: 0.001, decay: 0.03 }),
    ]),
    sound(0.52, [
      noise({ hp: 4000, lp: 9000, gain: 0.6, attack: 0.001, decay: 0.006, grains: { count: [4, 7], over: 0.16, gainVar: 0.7, pitchVar: 0.3 } }),
    ]),
    sound(0.43, [
      noise({ bp: 2600, q: 2, gain: 0.9, attack: 0.001, decay: 0.015 }),
      noise({ hp: 5000, lp: 9500, gain: 0.3, attack: 0.004, decay: 0.05 }),
    ]),
  ], { vary: 0.15 }),

  // Birds by day: each a sine whose notes are struck at fixed times, one voice (two for the finch).
  /** A tit: two notes, see-saw. */
  birdTit: oneOf([
    sound(0.026, [sine(4300, sung([[0, 1, 1], [0.16, 0.76, 0.9], [0.34, 1, 1], [0.5, 0.76, 0.9]], { f1: 4170, gain: 0.7, attack: 0.008, hold: 0.05, decay: 0.07 }))]),
    sound(0.026, [sine(4300, sung([[0, 1, 1], [0.16, 0.76, 0.9], [0.34, 1, 1], [0.5, 0.76, 0.9], [0.68, 1, 0.9], [0.84, 0.76, 0.8]], { f1: 4170, gain: 0.7, attack: 0.008, hold: 0.05, decay: 0.07 }))]),
  ], { vary: 0.08, stretch: 0.08, ...AMBIENT }),
  /** A warbler: a trill of quick falling notes that runs down the scale. */
  birdWarbler: sound(0.027, [
    sine(5200, sung([[0, 1, 0.6], [0.085, 0.95, 0.8], [0.17, 0.9, 1], [0.255, 0.85, 1], [0.34, 0.79, 0.9], [0.425, 0.73, 0.8], [0.51, 0.67, 0.7], [0.6, 0.62, 0.6]], { f1: 4400, gain: 0.7, attack: 0.005, hold: 0.02, decay: 0.045 })),
  ], { vary: 0.08, stretch: 0.1, ...AMBIENT }),
  /** A finch: three quick rising chirps, then a long buzzing whistle that falls. */
  birdFinch: sound(0.03, [
    sine(3300, sung([[0, 1, 0.9], [0.11, 1.05, 1], [0.22, 1.1, 0.9]], { f1: 4400, gain: 0.7, attack: 0.004, decay: 0.05 })),
    sine(4800, { f1: 3000, vibHz: 30, vibDepth: 0.04, gain: 0.6, delay: 0.36, attack: 0.02, hold: 0.08, decay: 0.2 }),
  ], { vary: 0.08, stretch: 0.1, ...AMBIENT }),
  /** A blackbird: a slow, mellow phrase of low whistles. */
  birdBlackbird: oneOf([
    sound(0.025, [sine(2100, sung([[0, 1, 1], [0.22, 1.26, 0.9], [0.4, 0.84, 1], [0.66, 1.5, 0.7], [0.8, 1.12, 0.8]], { f1: 2300, partials: [[2, 0.15]], vibHz: 6, vibDepth: 0.01, gain: 0.7, attack: 0.03, hold: 0.06, decay: 0.1 }))]),
    sound(0.024, [sine(2300, sung([[0, 0.9, 0.9], [0.2, 1.12, 1], [0.44, 1, 0.9], [0.62, 1.33, 0.8]], { f1: 2150, partials: [[2, 0.15]], vibHz: 6, vibDepth: 0.01, gain: 0.7, attack: 0.03, hold: 0.07, decay: 0.1 }))]),
    sound(0.024, [sine(1900, sung([[0, 1.19, 1], [0.24, 1, 0.9], [0.42, 1.5, 0.8], [0.6, 1.26, 0.9], [0.84, 0.94, 0.8]], { f1: 2050, partials: [[2, 0.15]], vibHz: 6, vibDepth: 0.01, gain: 0.7, attack: 0.03, hold: 0.06, decay: 0.1 }))]),
  ], { vary: 0.06, stretch: 0.1, ...AMBIENT }),
  /** A sparrow: one to three cheeps, each up and down. */
  birdSparrow: sound(0.048, [
    sine(3800, { glide: [[0.3, 5000], [1, 3200]], gain: 0.7, attack: 0.004, decay: 0.07, grains: { count: [1, 3], over: 0.5, jitter: 0.6, gainVar: 0.3, pitchVar: 0.08 } }),
  ], { vary: 0.1, ...AMBIENT }),
  /** A dove: five soft low coos. */
  birdDove: sound(0.03, [
    sine(460, sung([[0, 0.96, 0.7], [0.38, 1.06, 1], [0.86, 0.98, 0.8], [1.3, 0.94, 0.7], [1.62, 0.92, 0.6]], { f1: 440, partials: [[2, 0.1]], gain: 0.8, attack: 0.06, hold: 0.12, decay: 0.14 })),
  ], { vary: 0.06, stretch: 0.08, ...AMBIENT }),
  /** A cricket's chirp by night: three or four pulses of a 4.6 kHz tone, 30 a second. */
  cricketChirp: oneOf([
    sound(0.029, [sine(4600, sung([[0, 1, 0.8], [0.033, 1, 1], [0.066, 1, 0.9]], { gain: 0.6, attack: 0.003, hold: 0.008, decay: 0.012 }))]),
    sound(0.028, [sine(4600, sung([[0, 1, 0.7], [0.033, 1, 1], [0.066, 1, 1], [0.099, 1, 0.8]], { gain: 0.6, attack: 0.003, hold: 0.008, decay: 0.012 }))]),
  ], { vary: 0.03, ...AMBIENT }),
};

/** The birds the ambience picks from by day. */
export const BIRD_SONGS = Object.freeze(['birdTit', 'birdWarbler', 'birdFinch', 'birdBlackbird', 'birdSparrow', 'birdDove']);
/** The ambience loops: three of the place (wind, running water, fire) and (§84) the rain. */
export const AMBIENCE_LOOPS = Object.freeze(['ambWind', 'ambStream', 'ambFire', 'ambRain']);

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every sound of the bank, by name. audio.playRecipe and audio.startLoop take these names beside circuitSounds'.
 * @type {Readonly<Record<string, SoundRecipe>>}
 */
export const SOUND_BANK = freeze({ ...MATERIALS, ...MOVEMENT, ...VOICES, ...AMBIENCE });

/** Every bank name, in table order. */
export const BANK_NAMES = Object.freeze(Object.keys(SOUND_BANK));

/** The bank names of each of the four families (the Sound Test's headings). */
export const BANK_FAMILIES = Object.freeze({
  materials: Object.freeze(Object.keys(MATERIALS).filter((k) => !k.startsWith('step'))),
  movement: Object.freeze([...Object.keys(MATERIALS).filter((k) => k.startsWith('step')), ...Object.keys(MOVEMENT)]),
  voices: Object.freeze(Object.keys(VOICES)),
  ambience: Object.freeze(Object.keys(AMBIENCE)),
});

/**
 * The most voices a play of this recipe can take: its layers (times its `repeat`), the largest of its variants.
 * @param {SoundRecipe} recipe
 */
export function voicesOf(recipe) {
  if (!recipe) return 0;
  if (Array.isArray(recipe.variants)) return recipe.variants.reduce((m, v) => Math.max(m, voicesOf(v)), 0);
  return (recipe.layers ? recipe.layers.length : 0) * (recipe.repeat ? recipe.repeat.count : 1);
}
