// Caelancraft — WebAudio synthesised sound effects (block break / place, UI click, pigs, campfires, block physics,
// Survival: hurt, death, eating, drinking, digging, making, tool breaks, sizzling, picking).
// See src/CONTRACTS.md §21, docs/SPEC-gameplay.md §9 and docs/DESIGN-survival.md §9.9.
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
//
// Powder and circuits (docs/DESIGN-circuits.md §6.2.11): two generic primitives play the data recipes of
// circuitSounds.js — `playRecipe(recipeOrName, volume)` (one voice per layer, within MAX_VOICES) and `startLoop(recipe)`
// (one persistent voice, e.g. the black-hole drone, steered every frame with `set(volume, rate)`). No new play* methods.
import { SOUND_GROUPS } from './blocks.js';
import { SOUND_RECIPES } from './circuitSounds.js';

/** @typedef {import('./circuitSounds.js').SoundRecipe} SoundRecipe */
/** @typedef {import('./circuitSounds.js').SoundLayer} SoundLayer */
/**
 * A running loop (audio.startLoop): `set(volume, rate)` sets its volume 0..1 (0 suspends it: its nodes stop and it frees
 * its voice) and pitch factor (1 = as written); `stop()` ends it. A no-op without WebAudio or while muted.
 * @typedef {{ set: (volume: number, rate?: number) => void, stop: () => void }} LoopHandle
 */

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
// v0.11 (CONTRACTS §71): the zombie's voice is a low, tired murmur — muffled and soft, neither a cartoon moan nor a snarl.
export const GROAN_DURATION_S = 0.9;
export const GROAN_CUTOFF_HZ = 320;
export const GROAN_GAIN = 0.22;
export const GRUNT_DURATION_S = 0.2;
export const GRUNT_GAIN = 0.22;
export const ZOMBIE_DOWN_S = 0.7;
export const ZOMBIE_DOWN_GAIN = 0.24;
// The Hollow Watcher (CONTRACTS §40) vanishing: a faint, low exhale — two sine tones a few hertz apart sinking 68 → 30
// Hz over 1.6 s (they beat slowly against each other), a hollow 240 Hz noise breath and a soft 900 Hz air rush at the
// start. Quiet on purpose: you are not sure you heard it.
export const WATCHER_VANISH_S = 1.6;
export const WATCHER_VANISH_GAIN = 0.2;
// Survival (docs/DESIGN-survival.md §9.9). All synthesised here, none modelled on another game's samples.
// Hurt: a short low thump (sine 150 → 55 Hz) under a filtered breath (a soft-attack 900 Hz bandpassed noise exhale).
export const HURT_THUMP_START_HZ = 150;
export const HURT_THUMP_END_HZ = 55;
export const HURT_THUMP_S = 0.14;
export const HURT_THUMP_GAIN = 0.6;
export const HURT_BREATH_S = 0.24;
export const HURT_BREATH_HZ = 900;
export const HURT_BREATH_GAIN = 0.22;
// Death: a falling low tone (triangle 196 → 49 Hz over 1.3 s) and, near its end, a muffled thud (sine 80 → 32 Hz under
// a 260 Hz lowpassed knock).
export const DEATH_TONE_START_HZ = 196;
export const DEATH_TONE_END_HZ = 49;
export const DEATH_TONE_S = 1.3;
export const DEATH_TONE_GAIN = 0.3;
export const DEATH_THUD_AT_S = 0.95;
export const DEATH_THUD_S = 0.3;
export const DEATH_THUD_GAIN = 0.55;
export const DEATH_KNOCK_CUTOFF_HZ = 260;
// Eat: three crunchy ticks — short noise bursts through a 2.2 kHz bandpass, about 0.11 s apart.
export const EAT_TICKS = 3;
export const EAT_TICK_S = 0.035;
export const EAT_TICK_GAP_S = 0.11;
export const EAT_TICK_HZ = 2200;
export const EAT_TICK_GAIN = 0.4;
// Drink: two low gulps, each a sine whose pitch drops 440 → 190 Hz in 90 ms, 0.24 s apart.
export const DRINK_GULPS = 2;
export const DRINK_GULP_S = 0.09;
export const DRINK_GULP_GAP_S = 0.24;
export const DRINK_GULP_START_HZ = 440;
export const DRINK_GULP_END_HZ = 190;
export const DRINK_GULP_GAIN = 0.35;
// Dig tick (hold to dig, every DIG_TICK_S): a 40 ms noise tick through the block's break lowpass (BREAK_CUTOFF_HZ).
export const DIG_TICK_DURATION_S = 0.04;
export const DIG_GAIN = 0.6;
// Craft: a wooden knock (a 900 Hz bandpassed noise click over a sine 330 → 250 Hz) and a soft two-partial chime.
export const CRAFT_KNOCK_S = 0.05;
export const CRAFT_KNOCK_HZ = 900;
export const CRAFT_KNOCK_GAIN = 0.4;
export const CRAFT_CHIME_AT_S = 0.07;
export const CRAFT_CHIME_HZ = 1318.5; // E6, with a partial a fifth above
export const CRAFT_CHIME_S = 0.6;
export const CRAFT_CHIME_GAIN = 0.09;
// Tool break: a snap — a 60 ms noise burst through a 3.6 kHz bandpass, and a smaller splinter 35 ms later.
export const TOOL_BREAK_S = 0.06;
export const TOOL_BREAK_HZ = 3600;
export const TOOL_BREAK_GAIN = 0.55;
export const TOOL_BREAK_SPLINTER_AT_S = 0.035;
// Sizzle: hissing noise above 3 kHz with a soft attack, and a few crackle pops (the campfire crackle's settings).
export const SIZZLE_S = 0.6;
export const SIZZLE_HIGHPASS_HZ = 3000;
export const SIZZLE_GAIN = 0.12;
export const SIZZLE_ATTACK_S = 0.06;
// Pick: a leafy rustle — three overlapping soft-attack noise swishes through a 2.6 kHz bandpass.
export const PICK_SWISHES = 3;
export const PICK_SWISH_S = 0.12;
export const PICK_RUSTLE_HZ = 2600;
export const PICK_GAIN = 0.25;

/** A recipe layer without an `attack` rises over this long (a click-free onset). */
export const RECIPE_DEFAULT_ATTACK_S = 0.002;
/** A loop's volume and pitch follow `set` with this time constant (no zipper noise); it fades out over LOOP_FADE_S. */
export const LOOP_SMOOTH_S = 0.05;
export const LOOP_FADE_S = 0.06;

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
 * @property {(volume?: number) => void} playWatcherVanish        the Hollow Watcher vanishes in a puff of smoke (§40)
 * @property {(volume?: number) => void} playHurt                 Survival: the player takes damage (a soft one for damage over time)
 * @property {(volume?: number) => void} playDeath                Survival: the player dies
 * @property {(volume?: number) => void} playEat                  Survival: one food item eaten
 * @property {(volume?: number) => void} playDrink                Survival: a gulp or a pot drunk
 * @property {(soundGroup: string|null|undefined, volume?: number) => void} playDig  Survival: a dig tick (pass
 *   BLOCKS[id].soundGroup; main uses 0.35 while digging and 0.15 for a block it cannot dig)
 * @property {(volume?: number) => void} playCraft                Survival: a job completes
 * @property {(volume?: number) => void} playToolBreak            Survival: a tool wears out
 * @property {(volume?: number) => void} playSizzle               Survival: something cooks on a campfire nearby
 * @property {(volume?: number) => void} playPick                 Survival: a plant picked or litter gathered
 * @property {(recipe: SoundRecipe|string, volume?: number) => void} playRecipe  a circuitSounds recipe (or its name),
 *   one voice per layer within MAX_VOICES; volume 0..1 (default 1)
 * @property {(recipe: SoundRecipe|string) => LoopHandle} startLoop  a persistent voice playing the recipe's layers
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
   * Gain stage with an exponential decay: `peak` at t0 → DECAY_FLOOR at t0 + dur. Connected to master. With an
   * `attack` (seconds, < dur) the gain first rises linearly from DECAY_FLOOR to `peak` (a breath, a swish), then decays.
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {number} peak
   * @param {number} [attack]
   * @returns {GainNode}
   */
  function envelope(c, t0, dur, peak, attack = 0) {
    const g = c.createGain();
    if (attack > 0 && attack < dur) {
      g.gain.setValueAtTime(DECAY_FLOOR, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
    } else {
      g.gain.setValueAtTime(peak, t0);
    }
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
   * White noise through any biquad filter (bandpass / highpass / lowpass at `freqHz` × pitch, quality `q`) →
   * envelope (optionally with an attack) → master. noiseBurst is the lowpass case without Q or attack.
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {BiquadFilterType} type
   * @param {number} freqHz
   * @param {number} q
   * @param {number} peak
   * @param {number} pitch
   * @param {number} [attack]
   */
  function filteredNoise(c, t0, dur, type, freqHz, q, peak, pitch, attack = 0) {
    const buffer = /** @type {AudioBuffer} */ (noise);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freqHz * pitch, c.sampleRate / 2);
    if (f.Q) f.Q.value = q;
    const g = envelope(c, t0, dur, peak, attack);
    src.connect(f);
    f.connect(g);
    const maxOffset = Math.max(0, buffer.duration - dur * pitch - 0.01);
    src.start(t0, Math.random() * maxOffset);
    track(src, [f, g], t0 + dur);
  }

  /**
   * Tone: oscillator (exponential sweep f0 → f1 when they differ) → decaying gain → master.
   * @param {AudioContext} c
   * @param {number} t0
   * @param {number} dur
   * @param {number} f0
   * @param {number} f1
   * @param {number} peak
   * @param {OscillatorType} [type]  'sine' unless given
   * @param {number} [attack]        seconds of linear rise before the decay (0: starts at the peak)
   */
  function tone(c, t0, dur, f0, f1, peak, type = 'sine', attack = 0) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = envelope(c, t0, dur, peak, attack);
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
      // A sighed "mmmh": a muffled voice that sags a little, a soft octave above it, and a breath.
      buzz(c, t0, d, [[0, 106 * p], [d * 0.35, 100 * p], [d, 88 * p]], GROAN_CUTOFF_HZ, GROAN_GAIN * v);
      tone(c, t0 + 0.04, d * 0.8, 212 * p, 180 * p, GROAN_GAIN * 0.3 * v);
      noiseBurst(c, t0, d * 0.6, 300, 0.05 * v, p);
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
      // A short, soft "oof".
      buzz(c, t0, d, [[0, 150 * p], [d, 118 * p]], 560, GRUNT_GAIN * v);
      noiseBurst(c, t0, 0.04, 800, 0.1 * v, p);
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
      // A falling "ohh" and a soft puff as it goes.
      buzz(c, t0, d, [[0, 120 * p], [d, 62 * p]], 380, ZOMBIE_DOWN_GAIN * v);
      noiseBurst(c, t0 + 0.1, 0.25, 260, 0.2 * v, p);
      tone(c, t0 + 0.12, 0.2, 90 * p, 55 * p, 0.2 * v);
    } catch (err) {
      warnOnce(err);
    }
  }

  // --- the Hollow Watcher (CONTRACTS §40) ------------------------------------

  /** @param {number} [volume] */
  function playWatcherVanish(volume = 1) {
    const c = ready();
    if (!c || !(volume > 0)) return;
    try {
      const v = Math.min(1, volume);
      const p = 0.95 + Math.random() * 0.1;
      const d = WATCHER_VANISH_S;
      const t0 = c.currentTime;
      tone(c, t0, d, 68 * p, 30 * p, WATCHER_VANISH_GAIN * v);
      tone(c, t0 + 0.04, d * 0.95, 71.5 * p, 31.5 * p, WATCHER_VANISH_GAIN * 0.7 * v);
      noiseBurst(c, t0, d * 0.8, 240, WATCHER_VANISH_GAIN * 0.9 * v, p);
      noiseBurst(c, t0, 0.25, 900, WATCHER_VANISH_GAIN * 0.35 * v, p);
    } catch (err) {
      warnOnce(err);
    }
  }

  // --- Survival (DESIGN-survival §9.9) ----------------------------------------

  /**
   * Volume 0..1 for a sound, or 0 when it must be skipped (anything that is not a positive number).
   * @param {number} volume
   */
  function vol(volume) {
    return typeof volume === 'number' && volume > 0 ? Math.min(1, volume) : 0;
  }

  /** A short low thump plus a filtered breath. @param {number} [volume] */
  function playHurt(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const p = randomPitch();
      const t0 = c.currentTime;
      tone(c, t0, HURT_THUMP_S, HURT_THUMP_START_HZ * p, HURT_THUMP_END_HZ * p, HURT_THUMP_GAIN * v);
      filteredNoise(c, t0 + 0.02, HURT_BREATH_S, 'bandpass', HURT_BREATH_HZ, 0.9, HURT_BREATH_GAIN * v, p, 0.03);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** A falling low tone and a muffled thud. @param {number} [volume] */
  function playDeath(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const p = 0.97 + Math.random() * 0.06; // nearly fixed: this one should sound the same every time
      const t0 = c.currentTime;
      tone(c, t0, DEATH_TONE_S, DEATH_TONE_START_HZ * p, DEATH_TONE_END_HZ * p, DEATH_TONE_GAIN * v, 'triangle', 0.05);
      tone(c, t0 + DEATH_THUD_AT_S, DEATH_THUD_S, 80 * p, 32 * p, DEATH_THUD_GAIN * v);
      noiseBurst(c, t0 + DEATH_THUD_AT_S, 0.12, DEATH_KNOCK_CUTOFF_HZ, DEATH_THUD_GAIN * 0.6 * v, p);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** Three crunchy noise ticks. @param {number} [volume] */
  function playEat(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const t0 = c.currentTime;
      for (let i = 0; i < EAT_TICKS; i++) {
        const at = t0 + i * EAT_TICK_GAP_S + Math.random() * 0.02;
        filteredNoise(c, at, EAT_TICK_S, 'bandpass', EAT_TICK_HZ * (0.85 + Math.random() * 0.3), 1.2, EAT_TICK_GAIN * v, randomPitch());
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /** Two low gulps: sines whose pitch drops. @param {number} [volume] */
  function playDrink(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const p = randomPitch();
      const t0 = c.currentTime;
      for (let i = 0; i < DRINK_GULPS; i++) {
        const lower = 1 - 0.08 * i; // the second gulp sits a little lower
        tone(c, t0 + i * DRINK_GULP_GAP_S, DRINK_GULP_S, DRINK_GULP_START_HZ * p * lower, DRINK_GULP_END_HZ * p * lower, DRINK_GULP_GAIN * v, 'sine', 0.01);
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /**
   * A short, quiet tick through the block's break lowpass (hold to dig, every DIG_TICK_S).
   * @param {string|null|undefined} soundGroup  BLOCKS[id].soundGroup
   * @param {number} [volume]
   */
  function playDig(soundGroup, volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      noiseBurst(c, c.currentTime, DIG_TICK_DURATION_S, breakCutoffFor(soundGroup), DIG_GAIN * v, randomPitch());
    } catch (err) {
      warnOnce(err);
    }
  }

  /** A wooden knock plus a soft chime. @param {number} [volume] */
  function playCraft(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const p = randomPitch();
      const t0 = c.currentTime;
      filteredNoise(c, t0, CRAFT_KNOCK_S, 'bandpass', CRAFT_KNOCK_HZ, 1.5, CRAFT_KNOCK_GAIN * v, p);
      tone(c, t0, 0.07, 330 * p, 250 * p, CRAFT_KNOCK_GAIN * 0.8 * v);
      const at = t0 + CRAFT_CHIME_AT_S;
      tone(c, at, CRAFT_CHIME_S, CRAFT_CHIME_HZ, CRAFT_CHIME_HZ, CRAFT_CHIME_GAIN * v, 'sine', 0.008);
      tone(c, at, CRAFT_CHIME_S * 0.7, CRAFT_CHIME_HZ * 1.5, CRAFT_CHIME_HZ * 1.5, CRAFT_CHIME_GAIN * 0.5 * v, 'sine', 0.008);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** A snap: a noise burst through a high bandpass, and a smaller splinter. @param {number} [volume] */
  function playToolBreak(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const p = randomPitch();
      const t0 = c.currentTime;
      filteredNoise(c, t0, TOOL_BREAK_S, 'bandpass', TOOL_BREAK_HZ, 2.5, TOOL_BREAK_GAIN * v, p);
      filteredNoise(c, t0 + TOOL_BREAK_SPLINTER_AT_S, TOOL_BREAK_S * 0.6, 'bandpass', TOOL_BREAK_HZ * 1.3, 3, TOOL_BREAK_GAIN * 0.45 * v, p);
    } catch (err) {
      warnOnce(err);
    }
  }

  /** Hissing noise with a crackle (something cooking on a campfire). @param {number} [volume] */
  function playSizzle(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const t0 = c.currentTime;
      filteredNoise(c, t0, SIZZLE_S, 'highpass', SIZZLE_HIGHPASS_HZ, 0.7, SIZZLE_GAIN * v, randomPitch(), SIZZLE_ATTACK_S);
      const pops = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < pops; i++) {
        noiseBurst(c, t0 + Math.random() * SIZZLE_S * 0.7, CRACKLE_POP_S, CRACKLE_CUTOFF_HZ, CRACKLE_GAIN * 0.6 * v, randomPitch());
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /** A leafy rustle. @param {number} [volume] */
  function playPick(volume = 1) {
    const c = ready();
    const v = vol(volume);
    if (!c || !v) return;
    try {
      const t0 = c.currentTime;
      for (let i = 0; i < PICK_SWISHES; i++) {
        const at = t0 + i * 0.045 + Math.random() * 0.02;
        filteredNoise(c, at, PICK_SWISH_S, 'bandpass', PICK_RUSTLE_HZ * (0.8 + Math.random() * 0.4), 0.8, PICK_GAIN * v, randomPitch(), 0.025);
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  // --- recipes and loops (DESIGN-circuits §6.2.11) -----------------------------------------------------------

  /** @returns {SoundRecipe|null} a recipe object, or the named one from circuitSounds.SOUND_RECIPES */
  function resolveRecipe(recipe) {
    if (typeof recipe === 'string') return Object.hasOwn(SOUND_RECIPES, recipe) ? SOUND_RECIPES[recipe] : null;
    return recipe && typeof recipe === 'object' && Array.isArray(recipe.layers) ? recipe : null;
  }

  /** @returns {number} a positive finite number, else `dflt` */
  function pos(v, dflt) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
  }

  /** @returns {number} a filter / oscillator frequency kept inside (1 Hz, Nyquist) */
  function hz(c, f) {
    return Math.min(Math.max(1, f), c.sampleRate / 2 - 1);
  }

  const FILTER_TYPES = /** @type {const} */ ([['hp', 'highpass'], ['bp', 'bandpass'], ['lp', 'lowpass']]);

  /**
   * Run `head` through the layer's filters (hp → bp → lp). Each filter starts at its value (or the first of a [from, to]
   * pair) at `start` and, for a pair, sweeps exponentially to `to` by `end` (when `end` is given).
   * @returns {AudioNode} the last node of the chain
   */
  function filters(c, layer, head, start, end, nodes) {
    for (const [key, type] of FILTER_TYPES) {
      const v = /** @type {any} */ (layer)[key];
      if (v === undefined || v === null) continue;
      const from = Array.isArray(v) ? v[0] : v;
      const to = Array.isArray(v) ? v[1] : v;
      if (!(from > 0)) continue;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(hz(c, from), start);
      if (end !== undefined && to > 0 && to !== from) f.frequency.exponentialRampToValueAtTime(hz(c, to), end);
      if (f.Q) f.Q.value = pos(layer.q, 1);
      head.connect(f);
      nodes.push(f);
      head = f;
    }
    return head;
  }

  /** The layer's source: an oscillator at f0 (sweeping to f1 by `end`), or looping white noise from a random offset. */
  function layerSource(c, layer, start, end, rate = 1) {
    if (layer.type === 'noise') {
      const src = c.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = rate;
      return src;
    }
    const osc = c.createOscillator();
    osc.type = layer.type === 'saw' ? 'sawtooth' : layer.type === 'square' ? 'square' : 'sine';
    const f0 = pos(layer.f0, 440);
    osc.frequency.setValueAtTime(hz(c, f0 * rate), start);
    const f1 = pos(layer.f1, f0);
    if (end !== undefined && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(hz(c, f1 * rate), end);
    return osc;
  }

  /** An amplitude LFO on `gainParam`: ±depth/2 of `peak` at lfoHz, from `start` (to `end` when given). */
  function lfo(c, layer, gainParam, peak, start, end, nodes) {
    const rateHz = pos(layer.lfoHz, 0);
    const depth = pos(layer.lfoDepth, 0);
    if (!rateHz || !depth) return null;
    const osc = c.createOscillator();
    osc.frequency.value = rateHz;
    const g = c.createGain();
    g.gain.value = (peak * Math.min(1, depth)) / 2;
    osc.connect(g);
    g.connect(gainParam);
    osc.start(start);
    if (end !== undefined) osc.stop(end);
    nodes.push(osc, g);
    return osc;
  }

  /** Schedule one layer as one voice: delay, attack, exponential decay; sweeps run over attack + decay. */
  function layerVoice(c, layer, t0, peak) {
    const start = t0 + Math.max(0, pos(layer.delay, 0));
    const attack = layer.attack === undefined ? RECIPE_DEFAULT_ATTACK_S : Math.max(0, pos(layer.attack, 0));
    const len = attack + pos(layer.decay, 0.01);
    const end = start + len;
    const nodes = [];
    const src = layerSource(c, layer, start, end);
    const head = filters(c, layer, src, start, end, nodes);
    const g = envelope(c, start, len, peak, attack);
    head.connect(g);
    nodes.push(g);
    lfo(c, layer, g.gain, peak, start, end, nodes);
    if (layer.type === 'noise') {
      const buffer = /** @type {AudioBuffer} */ (noise);
      src.start(start, Math.random() * Math.max(0, buffer.duration - 0.01));
    } else {
      src.start(start);
    }
    track(src, nodes, end);
  }

  /**
   * Play a recipe (circuitSounds.js) or a recipe name: one voice per layer (per strike, for a `repeat`), scaled by the
   * recipe's gain and `volume`. Layers that would pass MAX_VOICES are dropped; an unknown name does nothing.
   * @param {SoundRecipe|string} recipeOrName
   * @param {number} [volume] 0..1 (default 1)
   */
  function playRecipe(recipeOrName, volume = 1) {
    const v = vol(volume);
    if (!v) return;
    const c = ready();
    if (!c) return;
    try {
      const recipe = resolveRecipe(recipeOrName);
      if (!recipe) return;
      const strikes = recipe.repeat ? Math.max(1, Math.floor(pos(recipe.repeat.count, 1))) : 1;
      const every = recipe.repeat ? pos(recipe.repeat.every, 0) : 0;
      const t0 = c.currentTime;
      const gain = pos(recipe.gain, 1) * v;
      for (let k = 0; k < strikes; k++) {
        for (const layer of recipe.layers) {
          if (voices >= MAX_VOICES) return;
          layerVoice(c, layer, t0 + k * every, gain * pos(layer.gain, 0));
        }
      }
    } catch (err) {
      warnOnce(err);
    }
  }

  /**
   * A persistent voice playing the recipe's layers continuously (oscillators at f0, filters at their starting
   * frequencies, each layer at its gain, with its LFO). It is built on the first `set` with a volume above 0 on a
   * running, unmuted context, and counts as one voice while it sounds; `set(0)` (or muting) fades it out, stops its nodes
   * and frees the voice. A handle on an unknown recipe, or without WebAudio, does nothing.
   * @param {SoundRecipe|string} recipeOrName
   * @returns {LoopHandle}
   */
  function startLoop(recipeOrName) {
    const recipe = resolveRecipe(recipeOrName);
    /**
     * @type {{ out: GainNode, sources: any[], oscs: { node: OscillatorNode, f0: number }[],
     *   noises: AudioBufferSourceNode[], nodes: AudioNode[] }|null}
     */
    let running = null;
    let rate = 1;

    function build(c) {
      const out = c.createGain();
      out.gain.setValueAtTime(DECAY_FLOOR, c.currentTime);
      out.connect(/** @type {GainNode} */ (master));
      const live = { out, sources: [], oscs: [], noises: [], nodes: [out] };
      const t0 = c.currentTime;
      const gain = pos(/** @type {SoundRecipe} */ (recipe).gain, 1);
      for (const layer of /** @type {SoundRecipe} */ (recipe).layers) {
        const src = layerSource(c, layer, t0, undefined, rate);
        const head = filters(c, layer, src, t0, undefined, live.nodes);
        const g = c.createGain();
        const peak = gain * pos(layer.gain, 0);
        g.gain.value = peak;
        head.connect(g);
        g.connect(out);
        live.nodes.push(g);
        const l = lfo(c, layer, g.gain, peak, t0, undefined, live.nodes);
        if (l) live.sources.push(l);
        if (layer.type === 'noise') {
          src.start(t0, Math.random() * Math.max(0, /** @type {AudioBuffer} */ (noise).duration - 0.01));
          live.noises.push(src);
        } else {
          src.start(t0);
          live.oscs.push({ node: src, f0: pos(layer.f0, 440) });
        }
        live.sources.push(src);
      }
      voices++;
      return live;
    }

    function teardown() {
      const live = running;
      running = null;
      if (!live || !ctx) return;
      voices = Math.max(0, voices - 1);
      const now = ctx.currentTime;
      live.out.gain.cancelScheduledValues(now);
      live.out.gain.setTargetAtTime(0, now, LOOP_FADE_S / 4);
      const last = live.sources[live.sources.length - 1];
      if (last) {
        last.onended = () => {
          last.onended = null;
          try {
            for (const n of live.sources) n.disconnect();
            for (const n of live.nodes) n.disconnect();
          } catch {
            /* already disconnected */
          }
        };
      }
      for (const s of live.sources) s.stop(now + LOOP_FADE_S);
    }

    return {
      set(volume, r = 1) {
        try {
          if (!recipe) return;
          const v = vol(volume);
          rate = pos(r, 1);
          if (!v || muted || !ctx || !master || !noise || ctx.state !== 'running') {
            if (running) teardown();
            if (v && ctx && !muted) kick();
            return;
          }
          if (!running) {
            if (voices >= MAX_VOICES) return;
            running = build(ctx);
          }
          const now = ctx.currentTime;
          running.out.gain.setTargetAtTime(v, now, LOOP_SMOOTH_S);
          for (const o of running.oscs) o.node.frequency.setTargetAtTime(hz(ctx, o.f0 * rate), now, LOOP_SMOOTH_S);
          for (const n of running.noises) n.playbackRate.setTargetAtTime(rate, now, LOOP_SMOOTH_S);
        } catch (err) {
          warnOnce(err);
        }
      },
      stop() {
        try {
          teardown();
        } catch (err) {
          warnOnce(err);
        }
      },
    };
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
    playWatcherVanish,
    playHurt,
    playDeath,
    playEat,
    playDrink,
    playDig,
    playCraft,
    playToolBreak,
    playSizzle,
    playPick,
    playRecipe,
    startLoop,
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
