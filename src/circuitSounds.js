// Caelancraft — the black-hole and circuit sounds as data: recipes that audio.playRecipe / audio.startLoop synthesise.
// docs/DESIGN-circuits.md §2.11, §4.12, §6.2.11 (CONTRACTS §53 once merged). PURE data: no imports, no DOM, no time.
//
// A recipe is `{ dur, gain, layers, repeat? }`:
//   dur     the sound's length in seconds (every layer ends by then: delay + attack + decay ≤ dur);
//   gain    the whole sound's gain (× the caller's volume);
//   layers  one voice each, all starting together unless delayed:
//     type        'noise' | 'sine' | 'saw' | 'square' | 'tri';
//     f0, f1?     an oscillator's frequency at the start and (exponentially swept) at the end of the layer, in Hz; a noise
//                 layer has f0 0 (white noise, coloured only by its filters);
//     lp?, hp?, bp?  a lowpass, highpass and/or bandpass filter (in series, in that order: hp → bp → lp): a frequency in Hz,
//                 or [from, to] for an exponential sweep over the layer;
//     q?          the filters' quality factor (default 1);
//     gain        the layer's peak gain;
//     delay?      seconds after the start (default 0);
//     attack?     a linear rise to `gain` over this long (default 0.002 s, a click-free onset);
//     decay       then an exponential fall to silence over this long (the layer stops there);
//     lfoHz?, lfoDepth?  an amplitude wobble: the gain swings by ±lfoDepth/2 of itself at lfoHz;
//   repeat? `{ every, count }`: the whole set of layers is struck `count` times, `every` seconds apart (count·every ≤ dur).
// A loop (audio.startLoop) plays its layers continuously at their gains (attack, decay and delay are ignored), each
// oscillator at f0 and each filter at its starting frequency.
//
// Every low sound carries a partial above 100 Hz: laptop and phone speakers roll off below about 100–150 Hz, and the
// missing fundamental keeps the pitch where it was meant to be (§2.11).
//
// v0.16 (CONTRACTS §82): what lifelike sounds need. Every field is optional, so the recipes below play as they always
// did. The sound bank (soundBank.js: materials, footsteps, voices, ambience) is written in this format.
//   On a layer:
//     hold        seconds the layer stays at `gain` between its attack and its decay (a held note; default 0). A layer's
//                 length is attack + hold + decay;
//     glide       a pitch contour for an oscillator, replacing f1: [[part, Hz], …] — the frequency is f0 at the start and
//                 reaches each Hz at that part (0..1, rising) of the layer's length, by exponential ramps;
//     vibHz, vibDepth, vibShape?   vibrato: the pitch swings by ±vibDepth of itself (0.03 = 3 %) at vibHz; the shape is
//                 'sine' (default), 'tri', 'square' or 'saw';
//     lfoShape?   the amplitude wobble's shape (the same four); lfoDepth may reach 2 (the gain then swings from 0 to 2×);
//     partials    more sines on an oscillator layer: [[ratio, gain, fade?], …] — one at ratio × the layer's frequency
//                 (following its sweep, glide and vibrato) and at `gain` of the layer's level; with `fade` below 1 it dies
//                 away over that part of the layer's length (the high modes of a struck stone go first);
//     formants    the resonances of a voice: [[Hz or [from, to], q, gain], …] — band-pass filters side by side (not in
//                 series), each with its own gain, added together; they sit after hp and bp and before lp;
//     grains      the layer is struck several times inside its one voice, each strike with its whole attack, hold, decay
//                 and sweeps. Either `{ count, over, jitter?, gainVar?, pitchVar? }` — `count` strikes (a number, or
//                 [min, max] picked at random) spread over `over` seconds, each up to `jitter` (0..1, default 1) of its
//                 share of that time late, at 1 − gainVar·random of the gain and (1 ± pitchVar) of every frequency — or a
//                 list [[at, pitch?, gain?], …] of strikes at fixed times (seconds after the layer's delay). A strike is cut
//                 short where the next one begins; the layer ends by delay + over (or the last `at`) + its length.
//   On a recipe:
//     variants    [recipe, …] in place of layers: each play picks one at random, never the one played last;
//     vary        each play is pitched by a random factor in [1 − vary, 1 + vary] (oscillators and filters alike);
//     stretch     each play's times are scaled by a random factor in [1 − stretch, 1 + stretch]; `dur` covers the longest;
//     spare       a sound of little weight (a footstep, a chirp): it is not played at all unless this many voices would
//                 still be free afterwards, so it can never crowd out the sounds that matter.
// In a loop, `vary`, `stretch`, `grains`, `hold`, `glide`, the vibrato and the fades of `partials` do nothing; the rate
// handed to the loop's `set` moves its filters with its oscillators.

/** @typedef {'sine'|'tri'|'square'|'saw'} LfoShape */

/**
 * @typedef {Object} SoundGrains
 * @property {number|number[]} count
 * @property {number} over
 * @property {number} [jitter]
 * @property {number} [gainVar]
 * @property {number} [pitchVar]
 */

/**
 * @typedef {Object} SoundLayer
 * @property {'noise'|'sine'|'saw'|'square'|'tri'} type
 * @property {number} f0
 * @property {number} [f1]
 * @property {number|number[]} [lp]
 * @property {number|number[]} [hp]
 * @property {number|number[]} [bp]
 * @property {number} [q]
 * @property {number} gain
 * @property {number} [delay]
 * @property {number} [attack]
 * @property {number} decay
 * @property {number} [lfoHz]
 * @property {number} [lfoDepth]
 * @property {LfoShape} [lfoShape]
 * @property {number} [hold]
 * @property {number[][]} [glide]
 * @property {number} [vibHz]
 * @property {number} [vibDepth]
 * @property {LfoShape} [vibShape]
 * @property {number[][]} [partials]
 * @property {Array<Array<number|number[]>>} [formants]
 * @property {SoundGrains|number[][]} [grains]
 */

/**
 * @typedef {Object} SoundRecipe
 * @property {number} dur
 * @property {number} gain
 * @property {SoundLayer[]} [layers]
 * @property {{ every: number, count: number }} [repeat]
 * @property {SoundRecipe[]} [variants]
 * @property {number} [vary]
 * @property {number} [stretch]
 * @property {number} [spare]
 */

/** Deep-freeze a recipe table. */
function freeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
}

/**
 * Every black-hole (§2.11) and circuit (§4.12) sound, by the name main passes to its playCircuitSound.
 * @type {Readonly<Record<string, SoundRecipe>>}
 */
export const SOUND_RECIPES = freeze({
  // ---- Black holes (§2.11) ----------------------------------------------------------------------------------------
  /** ARM: a whine rising 180 → 900 Hz over 0.4 s over filtered noise rising 300 → 2500 Hz. */
  bhArm: {
    dur: 0.42, gain: 0.35, layers: [
      { type: 'sine', f0: 180, f1: 900, gain: 0.7, attack: 0.3, decay: 0.1 },
      { type: 'noise', f0: 0, bp: [300, 2500], q: 2, gain: 0.5, attack: 0.32, decay: 0.08 },
    ],
  },
  /** FLASH: a 0.08 s noise crack through a 3 kHz highpass, then a sine falling 2400 → 300 Hz over 0.25 s. */
  bhFlash: {
    dur: 0.34, gain: 0.8, layers: [
      { type: 'noise', f0: 0, hp: 3000, gain: 1, decay: 0.08 },
      { type: 'sine', f0: 2400, f1: 300, gain: 0.5, delay: 0.06, decay: 0.25 },
    ],
  },
  /**
   * IMPLODE: a reversed swell — noise under a lowpass rising 200 → 4000 Hz over 1.1 s — ending in a 0.7 s thoom: a sine
   * 55 → 28 Hz, a second 110 → 56 Hz at half its gain, and a 20 ms noise thump through a 300 Hz lowpass.
   */
  bhImplode: {
    dur: 1.82, gain: 0.9, layers: [
      { type: 'noise', f0: 0, lp: [200, 4000], gain: 0.6, attack: 1.08, decay: 0.04 },
      { type: 'sine', f0: 55, f1: 28, gain: 1, delay: 1.1, decay: 0.7 },
      { type: 'sine', f0: 110, f1: 56, gain: 0.5, delay: 1.1, decay: 0.7 },
      { type: 'noise', f0: 0, lp: 300, gain: 0.9, delay: 1.1, decay: 0.02 },
    ],
  },
  /** Broken: a sine 28 → 70 Hz over 0.4 s with its 2× partial (56 → 140 Hz) at half gain, and a 0.2 s noise puff. */
  bhCollapse: {
    dur: 0.42, gain: 0.8, layers: [
      { type: 'sine', f0: 28, f1: 70, gain: 1, attack: 0.25, decay: 0.15 },
      { type: 'sine', f0: 56, f1: 140, gain: 0.5, attack: 0.25, decay: 0.15 },
      { type: 'noise', f0: 0, lp: 900, gain: 0.4, delay: 0.2, decay: 0.2 },
    ],
  },
  /** The player is swallowed: noise through a bandpass falling 1800 → 200 Hz over 0.6 s. */
  bhSwallow: {
    dur: 0.62, gain: 0.7, layers: [
      { type: 'noise', f0: 0, bp: [1800, 200], q: 1.5, gain: 1, attack: 0.05, decay: 0.55 },
    ],
  },
  /**
   * The vortex drone (a loop, at the nearest vortex within 24 units): sines at 38 and 57 Hz with partials at 114 Hz
   * (0.4) and 171 Hz (0.25), a 0.3 Hz amplitude swell, and a wind of noise through a 400 Hz bandpass.
   */
  bhDrone: {
    dur: 4.05, gain: 0.5, layers: [
      { type: 'sine', f0: 38, gain: 0.8, decay: 4, lfoHz: 0.3, lfoDepth: 0.5 },
      { type: 'sine', f0: 57, gain: 0.8, decay: 4, lfoHz: 0.3, lfoDepth: 0.5 },
      { type: 'sine', f0: 114, gain: 0.4, decay: 4, lfoHz: 0.3, lfoDepth: 0.5 },
      { type: 'sine', f0: 171, gain: 0.25, decay: 4, lfoHz: 0.3, lfoDepth: 0.5 },
      { type: 'noise', f0: 0, bp: 400, q: 0.8, gain: 0.3, decay: 4, lfoHz: 0.17, lfoDepth: 0.6 },
    ],
  },

  // ---- Circuits (§4.12) -------------------------------------------------------------------------------------------
  /** The knife switch: a 15 ms noise snap through a 2.5 kHz bandpass and a 0.05 s sine at 180 Hz. */
  switchClack: {
    dur: 0.06, gain: 0.6, layers: [
      { type: 'noise', f0: 0, bp: 2500, q: 1.5, gain: 1, decay: 0.015 },
      { type: 'sine', f0: 180, gain: 0.5, decay: 0.05 },
    ],
  },
  /** A push button, down and up: a 10 ms click at 3 kHz. */
  buttonClick: {
    dur: 0.013, gain: 0.4, layers: [
      { type: 'noise', f0: 0, bp: 3000, q: 2, gain: 1, decay: 0.01 },
    ],
  },
  /** A relay changing over: a 6 ms click at 4 kHz, gain 0.2. */
  relayClick: {
    dur: 0.009, gain: 0.2, layers: [
      { type: 'noise', f0: 0, bp: 4000, q: 2.5, gain: 1, decay: 0.006 },
    ],
  },
  /** Winding a timer: six ratchet clicks over 0.3 s. */
  timerWind: {
    dur: 0.32, gain: 0.35, repeat: { every: 0.05, count: 6 }, layers: [
      { type: 'noise', f0: 0, bp: 3200, q: 3, gain: 1, decay: 0.012 },
      { type: 'square', f0: 900, f1: 600, lp: 2400, gain: 0.15, decay: 0.01 },
    ],
  },
  /** A running timer's tick (every 0.5 s at the nearest running timer within 12 units): a 2 ms click. */
  timerTick: {
    dur: 0.005, gain: 0.25, layers: [
      { type: 'noise', f0: 0, hp: 2000, gain: 1, decay: 0.002 },
    ],
  },
  /** The countdown ends: sines at 1320 and 1980 Hz decaying over 0.6 s. */
  timerDing: {
    dur: 0.61, gain: 0.3, layers: [
      { type: 'sine', f0: 1320, gain: 1, decay: 0.6 },
      { type: 'sine', f0: 1980, gain: 0.5, decay: 0.45 },
    ],
  },
  /** One strike of a trembler bell (main strikes it every 0.12 s while it rings): 950, 1430 and 2600 Hz, 0.25 s decay. */
  bellRing: {
    dur: 0.26, gain: 0.35, layers: [
      { type: 'sine', f0: 950, gain: 1, decay: 0.25 },
      { type: 'sine', f0: 1430, gain: 0.6, decay: 0.2 },
      { type: 'sine', f0: 2600, gain: 0.35, decay: 0.12 },
      { type: 'noise', f0: 0, bp: 5000, q: 2, gain: 0.25, decay: 0.008 },
    ],
  },
  /** A spark transmitter sends: 40 ms of white noise through a 6 kHz highpass and a 30 ms 120 Hz buzz. */
  sparkZap: {
    dur: 0.045, gain: 0.5, layers: [
      { type: 'noise', f0: 0, hp: 6000, gain: 1, decay: 0.04 },
      { type: 'square', f0: 120, lp: 1500, gain: 0.5, decay: 0.03 },
    ],
  },
  /** The blasting machine: a sawtooth falling 400 → 80 Hz over 0.3 s through a lowpass (the magneto spin), then a thunk. */
  plunger: {
    dur: 0.46, gain: 0.6, layers: [
      { type: 'saw', f0: 400, f1: 80, lp: 1200, gain: 0.7, attack: 0.02, decay: 0.28 },
      { type: 'sine', f0: 140, f1: 60, gain: 1, delay: 0.3, decay: 0.15 },
      { type: 'noise', f0: 0, lp: 600, gain: 0.6, delay: 0.3, decay: 0.05 },
    ],
  },
  /** An igniter's first firing: a 20 ms crackle. */
  igniterPop: {
    dur: 0.03, gain: 0.45, layers: [
      { type: 'noise', f0: 0, bp: 4500, q: 0.8, gain: 1, decay: 0.012 },
      { type: 'noise', f0: 0, bp: 2500, q: 0.8, gain: 0.7, delay: 0.009, decay: 0.012 },
    ],
  },
  /** A fuse lit in place: a short hiss. */
  fuseLight: {
    dur: 0.25, gain: 0.3, layers: [
      { type: 'noise', f0: 0, hp: 4500, gain: 1, attack: 0.02, decay: 0.23 },
    ],
  },
});

/** Every recipe name, in table order. */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUND_RECIPES));

/** The layer types a recipe may use ('tri' since v0.16, CONTRACTS §82). */
export const LAYER_TYPES = Object.freeze(['noise', 'sine', 'saw', 'square', 'tri']);

/** The shapes of an amplitude wobble (`lfoShape`) or a vibrato (`vibShape`). */
export const LFO_SHAPES = Object.freeze(['sine', 'tri', 'square', 'saw']);
