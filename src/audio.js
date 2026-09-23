// Caelancraft — WebAudio synthesised sound effects (block break / place, UI click).
// See src/CONTRACTS.md §21 and docs/SPEC-gameplay.md §9.
//
// DOM module (WebAudio). Nothing is touched at module top level, so the module
// loads in Node. The AudioContext is created lazily inside resume(), which
// main.js calls on the first user gesture (browsers refuse to start audio
// before one). Every method is a safe no-op when WebAudio is unavailable, and
// the play* methods are no-ops while muted. Audio is a nice-to-have: nothing in
// here may ever throw into the game loop, so the public methods are guarded.
//
// All sounds are synthesised — there are no audio assets. Each sound is a
// short-lived "voice": source → (lowpass) → decaying gain → master → speakers.
// Voices disconnect themselves when they end. White noise comes from a single
// buffer generated once with the context and played from a random offset, so
// the hot path allocates only the handful of nodes a voice needs.
import { SOUND_GROUPS } from './blocks.js';

/** Master volume applied to every sound. */
export const MASTER_GAIN = 0.5;
/** Every sound is pitched by a random factor in [1 - PITCH_VARIATION, 1 + PITCH_VARIATION]. */
export const PITCH_VARIATION = 0.1;
/** Seconds of pre-generated white noise; bursts start at a random offset inside it. */
export const NOISE_BUFFER_S = 1;
/** Upper bound on simultaneously playing voices; further requests are dropped until one ends. */
export const MAX_VOICES = 32;
/** Sound group used when a caller passes null / an unknown group (AIR has no group). */
export const DEFAULT_SOUND_GROUP = 'stone';

/** Lowpass cutoff (Hz) of the break noise burst, per sound group (SPEC-gameplay §9). */
export const BREAK_CUTOFF_HZ = Object.freeze({
  stone: 1400,
  dirt: 900,
  sand: 900,
  snow: 900,
  gravel: 900,
  grass: 900,
  wood: 1100,
  leaves: 700,
  cloth: 700,
  glass: 3000,
  water: 600,
});

// Break: ~90 ms white-noise burst through the group's lowpass, exponential decay.
export const BREAK_DURATION_S = 0.09;
export const BREAK_GAIN = 0.7;
// Glass adds a short sine "ping" on top of the burst.
export const GLASS_PING_HZ = 2400;
export const GLASS_PING_DURATION_S = 0.04;
export const GLASS_PING_GAIN = 0.25;
// Place: sine sweep 180 → 90 Hz over 70 ms plus a 15 ms noise click.
export const PLACE_SWEEP_START_HZ = 180;
export const PLACE_SWEEP_END_HZ = 90;
export const PLACE_DURATION_S = 0.07;
export const PLACE_GAIN = 0.5;
export const PLACE_CLICK_DURATION_S = 0.015;
export const PLACE_CLICK_GAIN = 0.3;
/** The place click is coloured by the material: lowpass = group break cutoff × this. */
export const PLACE_CLICK_CUTOFF_SCALE = 1.5;
// UI / hotbar click: 1200 Hz sine, 20 ms, gain 0.15.
export const CLICK_HZ = 1200;
export const CLICK_DURATION_S = 0.02;
export const CLICK_GAIN = 0.15;

/** Exponential ramps cannot reach 0; decays ramp to this floor and the voice stops there. */
const DECAY_FLOOR = 0.001;
/** Time constant (s) of the master-gain fade used by setMuted, so muting never clicks. */
const MUTE_FADE_S = 0.01;

/**
 * @typedef {Object} Audio
 * @property {() => void} resume                                 create / resume the AudioContext; call on the first user gesture
 * @property {(soundGroup: string|null|undefined) => void} playBreak   block broken; pass BLOCKS[id].soundGroup
 * @property {(soundGroup: string|null|undefined) => void} playPlace   block placed; pass BLOCKS[id].soundGroup
 * @property {() => void} playClick                              UI / hotbar click
 * @property {(b: boolean) => void} setMuted
 * @property {() => boolean} toggleMuted                         returns the new muted state
 * @property {boolean} muted                                     read-only getter
 * @property {boolean} available                                 read-only getter: an AudioContext exists (after resume())
 */

/**
 * @typedef {Object} AudioOptions
 * @property {any} [AudioContextClass]  constructor to use instead of globalThis.AudioContext / webkitAudioContext (tests)
 */

/**
 * Map a block sound group to one we have a recipe for.
 * @param {string|null|undefined} group
 * @returns {string} a key of BREAK_CUTOFF_HZ
 */
export function normalizeSoundGroup(group) {
  if (typeof group === 'string' && SOUND_GROUPS.includes(group) && Object.hasOwn(BREAK_CUTOFF_HZ, group)) {
    return group;
  }
  return DEFAULT_SOUND_GROUP;
}

/**
 * Lowpass cutoff of the break burst for a sound group (unknown / null → DEFAULT_SOUND_GROUP).
 * @param {string|null|undefined} group
 * @returns {number} Hz
 */
export function breakCutoffFor(group) {
  return BREAK_CUTOFF_HZ[normalizeSoundGroup(group)];
}

/** @returns {number} random pitch multiplier in [1 - PITCH_VARIATION, 1 + PITCH_VARIATION] */
export function randomPitch() {
  return 1 + (Math.random() * 2 - 1) * PITCH_VARIATION;
}

/**
 * One buffer of white noise, generated once per context.
 * @param {AudioContext} c
 * @returns {AudioBuffer}
 */
function makeNoiseBuffer(c) {
  const length = Math.max(1, Math.round(c.sampleRate * NOISE_BUFFER_S));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function noop() {}

/**
 * Create the game's sound effect player. Cheap; touches no browser API until resume().
 * @param {AudioOptions} [opts]
 * @returns {Audio}
 */
export function createAudio(opts = {}) {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {GainNode|null} */
  let master = null;
  /** @type {AudioBuffer|null} */
  let noise = null;
  let muted = false;
  /** voices currently scheduled or sounding */
  let voices = 0;
  let warned = false;

  /** @returns {any} the AudioContext constructor to use, or null when WebAudio is unavailable */
  function resolveContextClass() {
    if (opts.AudioContextClass) return opts.AudioContextClass;
    const g = /** @type {any} */ (globalThis);
    return g.AudioContext || g.webkitAudioContext || null;
  }

  /** Create the context, master gain and noise buffer. Failure leaves everything null (silent). */
  function createContext() {
    const Ctor = resolveContextClass();
    if (typeof Ctor !== 'function') return;
    try {
      const c = new Ctor();
      const m = c.createGain();
      m.gain.value = muted ? 0 : MASTER_GAIN;
      m.connect(c.destination);
      noise = makeNoiseBuffer(c);
      ctx = c;
      master = m;
    } catch (err) {
      ctx = null;
      master = null;
      noise = null;
      warnOnce(err);
    }
  }

  /** Ask a suspended (or Safari "interrupted") context to run again. Rejections are swallowed. */
  function kick() {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch {
      /* ignore: resume() outside a gesture may be refused; the next gesture retries */
    }
  }

  /** @param {unknown} err */
  function warnOnce(err) {
    if (warned) return;
    warned = true;
    console.warn('[audio] synthesis error (sound skipped):', err);
  }

  /**
   * The context to schedule on, or null when this sound must be skipped (muted, no context,
   * context not running, or too many voices). Sounds are only scheduled on a RUNNING context:
   * scheduling on a suspended one would pile every click up and play them all at once on resume.
   * @returns {AudioContext|null}
   */
  function ready() {
    if (muted || !ctx || !master || !noise) return null;
    if (ctx.state !== 'running') {
      kick();
      return null;
    }
    if (voices >= MAX_VOICES) return null;
    return ctx;
  }

  /**
   * Gain stage with an exponential decay: `peak` at t0 → DECAY_FLOOR at t0 + dur. Connected to master.
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {number} peak
   * @returns {GainNode}
   */
  function envelope(c, t0, dur, peak) {
    const g = c.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(DECAY_FLOOR, t0 + dur);
    g.connect(/** @type {GainNode} */ (master));
    return g;
  }

  /**
   * Count a voice, stop it at `stopAt` and tear the whole chain down when it ends.
   * @param {AudioScheduledSourceNode} source  already started
   * @param {AudioNode[]} nodes                the rest of the chain
   * @param {number} stopAt
   */
  function track(source, nodes, stopAt) {
    voices++;
    source.onended = () => {
      voices = Math.max(0, voices - 1);
      source.onended = null;
      try {
        source.disconnect();
        for (let i = 0; i < nodes.length; i++) nodes[i].disconnect();
      } catch {
        /* already disconnected */
      }
    };
    source.stop(stopAt);
  }

  /**
   * White-noise burst: noise buffer → lowpass(cutoff × pitch) → decaying gain → master.
   * @param {AudioContext} c
   * @param {number} t0        start time (c.currentTime)
   * @param {number} dur       seconds
   * @param {number} cutoffHz  lowpass cutoff before pitch scaling
   * @param {number} peak      envelope peak gain
   * @param {number} pitch     playback-rate multiplier; also scales the cutoff
   */
  function noiseBurst(c, t0, dur, cutoffHz, peak, pitch) {
    const buffer = /** @type {AudioBuffer} */ (noise);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(cutoffHz * pitch, c.sampleRate / 2);
    const g = envelope(c, t0, dur, peak);
    src.connect(lp);
    lp.connect(g);
    // Random offset into the buffer for variety; keep enough headroom to play `dur` seconds at `pitch`.
    const maxOffset = Math.max(0, buffer.duration - dur * pitch - 0.01);
    src.start(t0, Math.random() * maxOffset);
    track(src, [lp, g], t0 + dur);
  }

  /**
   * Sine tone: oscillator (exponential sweep f0 → f1 when they differ) → decaying gain → master.
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {number} f0
   * @param {number} f1
   * @param {number} peak
   */
  function tone(c, t0, dur, f0, f1, peak) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = envelope(c, t0, dur, peak);
    osc.connect(g);
    osc.start(t0);
    track(osc, [g], t0 + dur);
  }

  // --- public API -----------------------------------------------------------

  /** Create the AudioContext on first call; afterwards just resume it if the browser suspended it. */
  function resume() {
    try {
      if (!ctx) createContext();
      kick();
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {string|null|undefined} soundGroup */
  function playBreak(soundGroup) {
    const c = ready();
    if (!c) return;
    try {
      const group = normalizeSoundGroup(soundGroup);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      noiseBurst(c, t0, BREAK_DURATION_S, BREAK_CUTOFF_HZ[group], BREAK_GAIN, pitch);
      if (group === 'glass') {
        tone(c, t0, GLASS_PING_DURATION_S, GLASS_PING_HZ * pitch, GLASS_PING_HZ * pitch, GLASS_PING_GAIN);
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {string|null|undefined} soundGroup */
  function playPlace(soundGroup) {
    const c = ready();
    if (!c) return;
    try {
      const group = normalizeSoundGroup(soundGroup);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      tone(c, t0, PLACE_DURATION_S, PLACE_SWEEP_START_HZ * pitch, PLACE_SWEEP_END_HZ * pitch, PLACE_GAIN);
      noiseBurst(c, t0, PLACE_CLICK_DURATION_S, BREAK_CUTOFF_HZ[group] * PLACE_CLICK_CUTOFF_SCALE, PLACE_CLICK_GAIN, pitch);
    } catch (err) {
      warnOnce(err);
    }
  }

  function playClick() {
    const c = ready();
    if (!c) return;
    try {
      const pitch = randomPitch();
      tone(c, c.currentTime, CLICK_DURATION_S, CLICK_HZ * pitch, CLICK_HZ * pitch, CLICK_GAIN);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {boolean} b */
  function setMuted(b) {
    muted = !!b;
    if (!ctx || !master) return;
    try {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, now, MUTE_FADE_S);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @returns {boolean} the new muted state */
  function toggleMuted() {
    setMuted(!muted);
    return muted;
  }

  return {
    resume,
    playBreak,
    playPlace,
    playClick,
    setMuted,
    toggleMuted,
    get muted() {
      return muted;
    },
    get available() {
      return ctx !== null;
    },
  };
}
