// Caelancraft — WebAudio synthesised sound effects (block break / place, UI click, pigs, campfires, block physics).
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
// Pig: an oink is two short sawtooth grunts (150 → 100 Hz) through a 900 Hz lowpass; a squeal (hit) is one
// rising-then-falling 600 → 1100 → 700 Hz cry. Both scale with the caller's volume (distance falloff).
export const OINK_HZ = 150;
export const OINK_GRUNT_S = 0.11;
export const OINK_GAP_S = 0.15;
export const OINK_CUTOFF_HZ = 900;
export const OINK_GAIN = 0.5;
export const SQUEAL_DURATION_S = 0.28;
export const SQUEAL_GAIN = 0.3;
// Campfire crackle: 2–3 tiny bright noise pops (12 ms, 4.5 kHz lowpass) within 80 ms.
export const CRACKLE_POP_S = 0.012;
export const CRACKLE_CUTOFF_HZ = 4500;
export const CRACKLE_GAIN = 0.35;
// v0.8 trees: playCreak — a toppling trunk's groan: a low sawtooth sliding up then down through a soft lowpass,
// with a short woody rasp.
export const CREAK_DURATION_S = 0.6;
export const CREAK_START_HZ = 85;
export const CREAK_PEAK_HZ = 135;
export const CREAK_END_HZ = 60;
export const CREAK_CUTOFF_HZ = 700;
export const CREAK_GAIN = 0.3;
export const CREAK_RASP_S = 0.25;
export const CREAK_RASP_CUTOFF_HZ = 1200;
export const CREAK_RASP_GAIN = 0.12;
// Block physics (CONTRACTS §34): a landing block thuds — a sine drop 110 → 45 Hz over 160 ms under a short 500 Hz
// noise knock; water starting to flow splashes — a 0.35 s 1.6 kHz noise wash plus two rising bubble blips.
export const THUD_START_HZ = 110;
export const THUD_END_HZ = 45;
export const THUD_DURATION_S = 0.16;
export const THUD_GAIN = 0.65;
export const THUD_KNOCK_S = 0.06;
export const THUD_KNOCK_CUTOFF_HZ = 500;
export const THUD_KNOCK_GAIN = 0.45;
export const SPLASH_DURATION_S = 0.35;
export const SPLASH_CUTOFF_HZ = 1600;
export const SPLASH_GAIN = 0.3;
export const SPLASH_BLIP_HZ = 520;
export const SPLASH_BLIP_S = 0.05;
export const SPLASH_BLIP_GAIN = 0.12;
// Explosives (CONTRACTS §37). A boom is a sine thump 72 → 26 Hz over 1.1 s, a 0.9 s 420 Hz noise body, a slowed
// 150 Hz rumble starting 0.12 s later and a 60 ms 3.2 kHz crack on top. A lit fuse hisses — a bright 0.3 s noise
// breath; putting one out fizzles — a 0.45 s 2.5 kHz noise wash over a sine sagging 700 → 180 Hz. All synthesised
// (no samples), all scaled by the caller's volume. (The falling-tree creak, §36, is defined above with the campfire.)
export const BOOM_THUMP_START_HZ = 72;
export const BOOM_THUMP_END_HZ = 26;
export const BOOM_THUMP_S = 1.1;
export const BOOM_THUMP_GAIN = 0.9;
export const BOOM_BODY_S = 0.9;
export const BOOM_BODY_CUTOFF_HZ = 420;
export const BOOM_BODY_GAIN = 0.8;
export const BOOM_RUMBLE_DELAY_S = 0.12;
export const BOOM_RUMBLE_S = 0.9;
export const BOOM_RUMBLE_CUTOFF_HZ = 150;
export const BOOM_RUMBLE_GAIN = 0.45;
export const BOOM_CRACK_S = 0.06;
export const BOOM_CRACK_CUTOFF_HZ = 3200;
export const BOOM_CRACK_GAIN = 0.5;
export const HISS_DURATION_S = 0.3;
export const HISS_CUTOFF_HZ = 7000;
export const HISS_GAIN = 0.12;
export const FIZZLE_DURATION_S = 0.45;
export const FIZZLE_CUTOFF_HZ = 2500;
export const FIZZLE_GAIN = 0.3;
export const FIZZLE_SAG_START_HZ = 700;
export const FIZZLE_SAG_END_HZ = 180;
export const FIZZLE_SAG_S = 0.25;
export const FIZZLE_SAG_GAIN = 0.08;
// Zombies (CONTRACTS §39). A groan is a low sawtooth moan rising then sagging (92 → 118 → 70 Hz over 1 s) through a
// dark lowpass, with a detuned fifth above it and a breathy noise; a hit grunt is a short 170 → 230 → 110 Hz bark
// over a noise slap; a knock-out is a moan sinking 130 → 40 Hz under a soft noise poof and a low thump.
export const GROAN_DURATION_S = 1.0;
export const GROAN_CUTOFF_HZ = 520;
export const GROAN_GAIN = 0.32;
export const GRUNT_DURATION_S = 0.22;
export const GRUNT_GAIN = 0.3;
export const ZOMBIE_DOWN_S = 0.8;
export const ZOMBIE_DOWN_GAIN = 0.32;

/** Exponential ramps cannot reach 0; decays ramp to this floor and the voice stops there. */
const DECAY_FLOOR = 0.001;
/** Time constant (s) of the master-gain fade used by setMuted, so muting never clicks. */
const MUTE_FADE_S = 0.01;

/**
 * @typedef {Object} Audio
 * @property {() => void} resume                                 create / resume the AudioContext; call on the first user gesture
 * @property {(soundGroup: string|null|undefined, volume?: number) => void} playBreak   block broken; pass BLOCKS[id].soundGroup
 *   and optionally a volume 0..1 (distance falloff; default 1)
 * @property {(soundGroup: string|null|undefined) => void} playPlace   block placed; pass BLOCKS[id].soundGroup
 * @property {() => void} playClick                              UI / hotbar click
 * @property {(volume?: number) => void} playOink                 pig grunt; volume 0..1 (default 1)
 * @property {(volume?: number) => void} playSqueal               pig hit
 * @property {(volume?: number) => void} playCrackle              campfire pop
 * @property {(volume?: number) => void} playCreak                a tree starts to topple (block physics)
 * @property {(volume?: number) => void} playThud                 a falling block lands (block physics)
 * @property {(volume?: number) => void} playSplash               water starts to flow nearby (block physics)
 * @property {(volume?: number) => void} playBoom                 a blast (explosives)
 * @property {(volume?: number) => void} playHiss                 a lit barrel's fuse
 * @property {(volume?: number) => void} playFizzle               a lit barrel put out
 * @property {(volume?: number) => void} playGroan                a zombie moans (ambient / it noticed you)
 * @property {(volume?: number) => void} playZombieHurt           a zombie is hit
 * @property {(volume?: number) => void} playZombieDown           a zombie is knocked out or burns away
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

  /**
   * Sawtooth voice through a lowpass: frequency follows `points` ([seconds from t0, Hz] pairs, exponential ramps).
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {[number, number][]} points
   * @param {number} cutoffHz
   * @param {number} peak
   */
  function buzz(c, t0, dur, points, cutoffHz, peak) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(points[0][1], t0);
    for (let i = 1; i < points.length; i++) osc.frequency.exponentialRampToValueAtTime(points[i][1], t0 + points[i][0]);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(cutoffHz, c.sampleRate / 2);
    const g = envelope(c, t0, dur, peak);
    osc.connect(lp);
    lp.connect(g);
    osc.start(t0);
    track(osc, [lp, g], t0 + dur);
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
  /** @param {string|null|undefined} soundGroup @param {number} [volume] 0..1 (default 1) */
  function playBreak(soundGroup, volume = 1) {
    const c = ready();
    if (!c) return;
    const v = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    if (v <= 0) return;
    try {
      const group = normalizeSoundGroup(soundGroup);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      noiseBurst(c, t0, BREAK_DURATION_S, BREAK_CUTOFF_HZ[group], BREAK_GAIN * v, pitch);
      if (group === 'glass') {
        tone(c, t0, GLASS_PING_DURATION_S, GLASS_PING_HZ * pitch, GLASS_PING_HZ * pitch, GLASS_PING_GAIN * v);
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

  /** @param {number} [volume] */
  function playOink(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const pitch = randomPitch();
      const f = OINK_HZ * pitch;
      const t0 = c.currentTime;
      const peak = OINK_GAIN * Math.min(1, volume);
      for (const at of [0, OINK_GAP_S]) {
        buzz(c, t0 + at, OINK_GRUNT_S, [[0, f], [OINK_GRUNT_S, f * 0.67]], OINK_CUTOFF_HZ * pitch, peak);
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playSqueal(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const pitch = randomPitch();
      const d = SQUEAL_DURATION_S;
      buzz(c, c.currentTime, d, [[0, 600 * pitch], [d * 0.35, 1100 * pitch], [d, 700 * pitch]], 2600, SQUEAL_GAIN * Math.min(1, volume));
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playCrackle(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const pops = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < pops; i++) {
        noiseBurst(c, c.currentTime + Math.random() * 0.08, CRACKLE_POP_S, CRACKLE_CUTOFF_HZ, CRACKLE_GAIN * Math.min(1, volume), randomPitch());
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playCreak(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const pitch = randomPitch();
      const d = CREAK_DURATION_S;
      const t0 = c.currentTime;
      buzz(c, t0, d, [[0, CREAK_START_HZ * pitch], [d * 0.55, CREAK_PEAK_HZ * pitch], [d, CREAK_END_HZ * pitch]], CREAK_CUTOFF_HZ, CREAK_GAIN * v);
      noiseBurst(c, t0 + 0.05, CREAK_RASP_S, CREAK_RASP_CUTOFF_HZ, CREAK_RASP_GAIN * v, pitch);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playThud(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      tone(c, t0, THUD_DURATION_S, THUD_START_HZ * pitch, THUD_END_HZ * pitch, THUD_GAIN * v);
      noiseBurst(c, t0, THUD_KNOCK_S, THUD_KNOCK_CUTOFF_HZ, THUD_KNOCK_GAIN * v, pitch);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playSplash(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const t0 = c.currentTime;
      noiseBurst(c, t0, SPLASH_DURATION_S, SPLASH_CUTOFF_HZ, SPLASH_GAIN * v, randomPitch());
      for (let i = 0; i < 2; i++) {
        const f = SPLASH_BLIP_HZ * randomPitch() * (1 + 0.4 * i);
        const at = t0 + 0.04 + Math.random() * 0.18;
        tone(c, at, SPLASH_BLIP_S, f, f * 1.6, SPLASH_BLIP_GAIN * v);
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  // --- explosives (CONTRACTS §37) ------------------------------------------

  /** @param {number} [volume] */
  function playBoom(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      tone(c, t0, BOOM_THUMP_S, BOOM_THUMP_START_HZ * pitch, BOOM_THUMP_END_HZ * pitch, BOOM_THUMP_GAIN * v);
      noiseBurst(c, t0, BOOM_BODY_S, BOOM_BODY_CUTOFF_HZ, BOOM_BODY_GAIN * v, pitch);
      // Slowed noise (rate 0.6) is darker and stays inside the 1 s noise buffer.
      noiseBurst(c, t0 + BOOM_RUMBLE_DELAY_S, BOOM_RUMBLE_S, BOOM_RUMBLE_CUTOFF_HZ / 0.6, BOOM_RUMBLE_GAIN * v, 0.6);
      noiseBurst(c, t0, BOOM_CRACK_S, BOOM_CRACK_CUTOFF_HZ, BOOM_CRACK_GAIN * v, pitch);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playHiss(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      noiseBurst(c, c.currentTime, HISS_DURATION_S, HISS_CUTOFF_HZ, HISS_GAIN * Math.min(1, volume), randomPitch());
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playFizzle(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const pitch = randomPitch();
      const t0 = c.currentTime;
      noiseBurst(c, t0, FIZZLE_DURATION_S, FIZZLE_CUTOFF_HZ, FIZZLE_GAIN * v, pitch);
      tone(c, t0, FIZZLE_SAG_S, FIZZLE_SAG_START_HZ * pitch, FIZZLE_SAG_END_HZ * pitch, FIZZLE_SAG_GAIN * v);
    } catch (err) {
      warnOnce(err);
    }
  }

  // --- zombies (CONTRACTS §39) ----------------------------------------------

  /** @param {number} [volume] */
  function playGroan(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const p = randomPitch();
      const d = GROAN_DURATION_S * (0.85 + Math.random() * 0.3);
      const t0 = c.currentTime;
      buzz(c, t0, d, [[0, 92 * p], [d * 0.4, 118 * p], [d, 70 * p]], GROAN_CUTOFF_HZ, GROAN_GAIN * v);
      buzz(c, t0 + 0.03, d * 0.9, [[0, 139 * p], [d * 0.4, 176 * p], [d * 0.9, 104 * p]], GROAN_CUTOFF_HZ * 1.3, GROAN_GAIN * 0.35 * v);
      noiseBurst(c, t0, d * 0.7, 400, 0.1 * v, p);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playZombieHurt(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const p = randomPitch();
      const d = GRUNT_DURATION_S;
      const t0 = c.currentTime;
      buzz(c, t0, d, [[0, 170 * p], [d * 0.3, 230 * p], [d, 110 * p]], 900, GRUNT_GAIN * v);
      noiseBurst(c, t0, 0.05, 1200, 0.25 * v, p);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** @param {number} [volume] */
  function playZombieDown(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const p = randomPitch();
      const d = ZOMBIE_DOWN_S;
      const t0 = c.currentTime;
      buzz(c, t0, d, [[0, 130 * p], [d, 40 * p]], 500, ZOMBIE_DOWN_GAIN * v);
      noiseBurst(c, t0 + 0.1, 0.3, 300, 0.4 * v, p);
      tone(c, t0 + 0.12, 0.2, 90 * p, 40 * p, 0.4 * v);
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
    playOink,
    playSqueal,
    playCrackle,
    playCreak,
    playThud,
    playSplash,
    playBoom,
    playHiss,
    playFizzle,
    playGroan,
    playZombieHurt,
    playZombieDown,
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
