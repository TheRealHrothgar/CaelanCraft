// Caelancraft — the sounds the world makes around the player (v0.16, CONTRACTS §82): footsteps and movement
// (MoveSounds), the ambience (Ambience: wind, birdsong by day, crickets by night, running water, the fire's bed), what the
// ambience needs to know about the place (sampleSurroundings) and the animals' new voices (ANIMAL_VOICES).
//
// PURE logic: no DOM, no WebAudio. Everything is played through the `audio` handed in (audio.playRecipe / startLoop, or a
// recorder in the tests) with the recipes of soundBank.js; randomness comes from `opts.random` (Math.random by default).
// main.js calls `moveSounds.update` and `ambience.update` once a frame from one hook (stepWorldSounds).
import { BIOME, getBlockDef, isLeaves, isSolid, isWater, isWaterSource } from './blocks.js';
import { SEA_LEVEL, WORLD_HEIGHT } from './config.js';
import { hexToWorld, worldToHex } from './hex.js';
import { SOUNDS as ANIMAL_BASE_SOUNDS } from './animals.js';
import { SOUND_BANK, VOICE_RECIPES, BIRD_SONGS, materialSound, voicesOf } from './soundBank.js';

/** @typedef {import('./circuitSounds.js').SoundRecipe} SoundRecipe */
/** @typedef {{ playRecipe: (recipe: SoundRecipe|string, volume?: number) => void,
 *   startLoop: (recipe: SoundRecipe|string) => import('./audio.js').LoopHandle }} SoundPlayer */

// ---------------------------------------------------------------------------------------------------------------------
// The animals' voices
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The recipe of every sound animals.js names (`SOUNDS`: the species' voices, the snare, the taming chime): the bank's
 * lifelike voice where there is one (soundBank.VOICE_RECIPES), animals.js's own otherwise. main plays these.
 * @type {Readonly<Record<string, SoundRecipe>>}
 */
export const ANIMAL_VOICES = Object.freeze(/** @type {Record<string, any>} */ ({
  ...ANIMAL_BASE_SOUNDS,
  ...Object.fromEntries(Object.entries(VOICE_RECIPES).map(([voice, name]) => [voice, SOUND_BANK[name]])),
}));

/** Below this daylight a wolf's call from afar may be a howl. */
export const HOWL_BELOW_DAYLIGHT = 0.3;
/** How often (0..1) a wolf's call by night is a howl rather than a bark. */
export const HOWL_CHANCE = 0.65;

/**
 * An animal's call when nothing prompted it (animals.js `voices`): its species' voice — and for a wolf by night, most of
 * the time, a howl.
 * @param {string} kind       the animal's kind ('wolf', 'cow', …)
 * @param {string} voice      its species' voice name (SPECIES[kind].voice)
 * @param {number} daylight   0..1 (the sky's)
 * @param {() => number} [random]
 * @returns {SoundRecipe|undefined}
 */
export function ambientCall(kind, voice, daylight, random = Math.random) {
  if (kind === 'wolf' && daylight < HOWL_BELOW_DAYLIGHT && random() < HOWL_CHANCE) return SOUND_BANK.wolfHowl;
  return ANIMAL_VOICES[voice];
}

// ---------------------------------------------------------------------------------------------------------------------
// Footsteps and movement
// ---------------------------------------------------------------------------------------------------------------------

/** Metres between two footsteps: walking (4.3 m/s) makes two a second, sprinting (5.6 m/s) 2.6. */
export const STRIDE_M = 2.15;
/** Sneaking takes short steps (1.3 m/s: 1.3 a second). */
export const SNEAK_STRIDE_M = 1.0;
/** Metres between two swimming strokes (2.2 m/s in water: a little over one a second). */
export const SWIM_STROKE_M = 1.9;
/** A step's volume: walking, sprinting, sneaking. */
export const STEP_VOLUME = Object.freeze({ walk: 0.8, sprint: 1, sneak: 0.35 });
/** Moving slower than this (m/s) is being nudged, not walking: no steps. */
export const STEP_MIN_SPEED = 0.5;
/** Moving faster than this (m/s) is a teleport, not a step. */
export const STEP_MAX_SPEED = 30;
/** Standing still this long, the next step comes after a little over a third of a stride. */
export const STILL_S = 0.25;
/** Leaving the ground faster than this upward (m/s) is a jump (JUMP_VELOCITY is 8.7). */
export const JUMP_MIN_VY = 4;
/** A landing is heard after this long in the air, or at this speed (m/s). */
export const LAND_MIN_AIR_S = 0.12;
export const LAND_MIN_SPEED = 4;
/** The landing thump grows from LAND_MIN_SPEED to this speed (m/s; a fall that starts to hurt is 14). */
export const LAND_FULL_SPEED = 16;
/** Below this strength (0..1) a landing is only the ground's step (a one-block drop lands at 7.5 m/s: 0.29). */
export const LAND_THUD_FROM = 0.3;
/** A splash needs this long out of deep water first, so bobbing at the surface is quiet. */
export const SPLASH_GAP_S = 0.6;
/** Climbing out is heard after this long in the water, once out for OUT_AFTER_S. */
export const OUT_MIN_SWIM_S = 0.8;
export const OUT_AFTER_S = 0.3;

/**
 * What the player's body is doing this frame (main fills it from the PlayerState and the block under the feet).
 * @typedef {Object} MoveSample
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} vy
 * @property {boolean} onGround
 * @property {boolean} flying
 * @property {boolean} sneaking
 * @property {boolean} sprinting
 * @property {boolean} inWater      swimming
 * @property {boolean} wading       feet in water too shallow to swim in
 * @property {boolean} headInWater
 * @property {string|null} ground   the sound group of the block stood on (null: none, or unknown)
 * @property {boolean} [riding]     on a horse: no steps of one's own
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Footsteps, jumps, landings, wading, swimming and splashes, from the player's state frame by frame. Steps only on the
 * ground while moving, by distance walked (so the cadence follows the speed); the ground's sound group picks the sound;
 * quieter when sneaking; nothing while flying or riding.
 */
export class MoveSounds {
  /** @param {SoundPlayer} audio */
  constructor(audio) {
    this.audio = audio;
    this.reset();
  }

  /** Forget the last frame (a new world, a respawn, a teleport): the next update only looks. */
  reset() {
    this.started = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.prevVy = 0;
    this.wasGround = true;
    this.wasSwim = false;
    this.walked = 0;
    this.swum = 0;
    this.stillFor = 0;
    this.airFor = 0;
    this.dryFor = SPLASH_GAP_S;
    this.swimFor = 0;
    this.outDue = false;
  }

  /** @param {string} name @param {number} volume */
  _play(name, volume) {
    if (volume > 0) this.audio.playRecipe(name, Math.min(1, volume));
  }

  /**
   * @param {number} dt  seconds since the last update
   * @param {MoveSample} s
   */
  update(dt, s) {
    if (!(dt > 0) || !s) return;
    const first = !this.started;
    const dx = s.x - this.x;
    const dy = s.y - this.y;
    const dz = s.z - this.z;
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    const flat = Math.hypot(dx, dz);
    const speed = flat / dt;
    const jumped = first || speed > STEP_MAX_SPEED || s.flying || s.riding; // nothing to hear this frame
    const prevVy = this.prevVy;
    const wasGround = this.wasGround;
    const wasSwim = this.wasSwim;
    this.started = true;
    this.prevVy = s.vy;
    this.wasGround = s.onGround;
    this.wasSwim = s.inWater;

    // ---- water: in, out, strokes --------------------------------------------------------------------------------
    if (s.inWater) {
      if (!wasSwim && !jumped && this.dryFor >= SPLASH_GAP_S) {
        this._play('splashIn', 0.3 + Math.max(0, -prevVy) / 16);
        this.swum = SWIM_STROKE_M * 0.4;
      }
      this.dryFor = 0;
      this.swimFor += dt;
      this.outDue = this.swimFor >= OUT_MIN_SWIM_S;
      if (!jumped) {
        this.swum += Math.hypot(flat, Math.max(0, dy));
        if (this.swum >= SWIM_STROKE_M) {
          this.swum %= SWIM_STROKE_M;
          this._play(s.headInWater ? 'swimUnder' : 'swim', 0.85);
        }
      }
      this.walked = 0;
      this.airFor = 0;
      return;
    }
    this.dryFor += dt;
    if (this.outDue && this.dryFor >= OUT_AFTER_S) {
      this.outDue = false;
      if (!jumped) this._play('splashOut', 0.8);
    }
    if (this.dryFor >= SPLASH_GAP_S) this.swimFor = 0;
    if (jumped) {
      this.walked = 0;
      this.airFor = 0;
      return;
    }

    // ---- on foot ------------------------------------------------------------------------------------------------
    const step = materialSound('step', s.wading ? 'water' : s.ground || 'stone'); // wading: the water's own step
    const stride = s.sneaking ? SNEAK_STRIDE_M : STRIDE_M;
    if (!s.onGround) {
      if (wasGround && s.vy > JUMP_MIN_VY) this._play('jump', 0.7);
      this.airFor += dt;
      return;
    }
    if (!wasGround) {
      const fall = Math.max(0, -prevVy);
      if (this.airFor >= LAND_MIN_AIR_S || fall >= LAND_MIN_SPEED) {
        const hard = clamp01((fall - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED));
        this._play(step, 0.45 + 0.55 * hard);
        if (hard >= LAND_THUD_FROM) this._play('landThud', hard);
        this.walked = 0;
      }
      this.airFor = 0;
      return;
    }
    this.airFor = 0;
    if (speed < STEP_MIN_SPEED) {
      this.stillFor += dt;
      if (this.stillFor >= STILL_S) this.walked = stride * 0.6;
      return;
    }
    this.stillFor = 0;
    this.walked += flat;
    if (this.walked >= stride) {
      this.walked %= stride;
      this._play(step, s.sneaking ? STEP_VOLUME.sneak : s.sprinting ? STEP_VOLUME.sprint : STEP_VOLUME.walk);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the place is like (for the ambience)
// ---------------------------------------------------------------------------------------------------------------------

/** Running water is looked for within this many cells; the stream is silent beyond. */
export const STREAM_RANGE = 9;
/** Leaves are looked for in these rings (cells) around the player, up to TREE_SCAN_UP cells above the feet. */
export const TREE_RINGS = Object.freeze([3, 6]);
export const TREE_SCAN_UP = 10;
/** This many columns with leaves (of the 13 looked at) count as "among trees". */
export const TREES_FULL = 4;

const RING = Object.freeze([[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]);

/**
 * @typedef {Object} Surroundings
 * @property {number} biome        the feet column's biome (blocks.BIOME)
 * @property {boolean} openSky     no solid cell above the eye
 * @property {boolean} underground no open sky, and the land's surface at least four cells above the eye
 * @property {number} trees        0..1: how much foliage is near (TREES_FULL columns with leaves = 1)
 * @property {number} grass        0..1: how much of the ground at the feet and around them is grass
 * @property {number} streamDist   metres to the nearest running water (a generated stream, or flowing water), Infinity when
 *                                 there is none within STREAM_RANGE cells
 */

/**
 * Look around the player for what the ambience follows. Costs a few hundred getBlock calls: main calls it twice a second.
 * @param {{ getBlock: (q: number, y: number, r: number) => number,
 *   columnAt: (q: number, r: number) => { height: number, biome: number },
 *   streamAt?: (q: number, r: number) => boolean }} world
 * @param {number} x  the feet
 * @param {number} y
 * @param {number} z
 * @param {number} eyeY
 * @returns {Surroundings}
 */
export function sampleSurroundings(world, x, y, z, eyeY) {
  const [q, r] = worldToHex(x, z);
  const col = world.columnAt(q, r);
  const feet = Math.floor(y + 1e-3);
  let openSky = true;
  for (let yy = Math.max(0, Math.ceil(eyeY)); yy < WORLD_HEIGHT; yy++) {
    if (isSolid(world.getBlock(q, yy, r))) {
      openSky = false;
      break;
    }
  }
  const underground = !openSky && col.height >= Math.floor(eyeY) + 4;

  // foliage: the player's column and two rings of six
  let leafy = 0;
  const hasLeaves = (cq, cr) => {
    for (let yy = feet; yy <= feet + TREE_SCAN_UP && yy < WORLD_HEIGHT; yy++) if (isLeaves(world.getBlock(cq, yy, cr))) return true;
    return false;
  };
  if (hasLeaves(q, r)) leafy++;
  for (const ring of TREE_RINGS) for (const [dq, dr] of RING) if (hasLeaves(q + dq * ring, r + dr * ring)) leafy++;

  // grass under and around the feet: the first solid cell at or just below them
  let grassy = 0;
  const isGrass = (cq, cr) => {
    for (let yy = feet + 1; yy >= feet - 2 && yy >= 0; yy--) {
      const id = world.getBlock(cq, yy, cr);
      if (isSolid(id)) return getBlockDef(id).soundGroup === 'grass';
    }
    return false;
  };
  if (isGrass(q, r)) grassy++;
  for (const [dq, dr] of RING) if (isGrass(q + dq * 2, r + dr * 2)) grassy++;

  // running water: a generated stream's column, or water that flows or falls, near the feet's height
  let streamDist = Infinity;
  const streamAt = typeof world.streamAt === 'function' ? world.streamAt : null;
  for (let dq = -STREAM_RANGE; dq <= STREAM_RANGE; dq++) {
    const lo = Math.max(-STREAM_RANGE, -dq - STREAM_RANGE);
    const hi = Math.min(STREAM_RANGE, -dq + STREAM_RANGE);
    for (let dr = lo; dr <= hi; dr++) {
      const cq = q + dq;
      const cr = r + dr;
      let runs = streamAt ? streamAt(cq, cr) : false;
      if (!runs) {
        for (let yy = feet - 3; yy <= feet + 1 && !runs; yy++) {
          const id = world.getBlock(cq, yy, cr);
          runs = isWater(id) && !isWaterSource(id);
        }
      }
      if (!runs) continue;
      const [wx, wz] = hexToWorld(cq, cr);
      const d = Math.hypot(wx - x, wz - z);
      if (d < streamDist) streamDist = d;
    }
  }
  return {
    biome: col.biome,
    openSky,
    underground,
    trees: Math.min(1, leafy / TREES_FULL),
    grass: grassy / 7,
    streamDist,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The ambience
// ---------------------------------------------------------------------------------------------------------------------

/** The ambience never takes more voices than this: its loops (one each) and its chirps, pops and bubbles together. */
export const AMBIENCE_MAX_VOICES = 5;
/** Wind by biome, 0..1, under open sky at sea level: strong on the mountains and in the open, faint in the woods. */
export const WIND_BY_BIOME = Object.freeze({
  [BIOME.OCEAN]: 0.6, [BIOME.BEACH]: 0.6, [BIOME.PLAINS]: 0.5, [BIOME.FOREST]: 0.22, [BIOME.DESERT]: 0.55,
  [BIOME.SNOWY]: 0.6, [BIOME.MOUNTAINS]: 0.85, [BIOME.SNOWY_PEAKS]: 1,
});
/** Birdsong by biome, 0..1, by day: the plains and the woods; little where little lives. Foliage nearby raises it. */
export const BIRDS_BY_BIOME = Object.freeze({
  [BIOME.OCEAN]: 0.12, [BIOME.BEACH]: 0.3, [BIOME.PLAINS]: 0.7, [BIOME.FOREST]: 1, [BIOME.DESERT]: 0.1,
  [BIOME.SNOWY]: 0.25, [BIOME.MOUNTAINS]: 0.3, [BIOME.SNOWY_PEAKS]: 0.05,
});
/** Wind under a roof (no open sky) and deep underground, as a part of the open-air wind. */
export const WIND_UNDER_ROOF = 0.5;
export const WIND_UNDERGROUND = 0.06;
/** Foliage shelters: among trees the wind drops by this part. */
export const WIND_TREE_SHELTER = 0.5;
/** Height adds wind: this much more per cell above WIND_HIGH_FROM cells over the sea, up to WIND_HIGH_MAX. */
export const WIND_HIGH_FROM = 20;
export const WIND_HIGH_PER_CELL = 0.01;
export const WIND_HIGH_MAX = 0.3;
/** Birds sing while the daylight is above BIRDS_DAYLIGHT[0], fully from [1]; crickets below CRICKETS_DAYLIGHT[1], fully under [0]. */
export const BIRDS_DAYLIGHT = Object.freeze([0.3, 0.6]);
export const CRICKETS_DAYLIGHT = Object.freeze([0.15, 0.4]);
/** The fire's bed is heard within this many metres of a campfire (config.CAMPFIRE_CRACKLE_RANGE). */
export const FIRE_RANGE = 10;
/** With the head under water everything outside is this faint, and nothing sings. */
export const UNDERWATER_AMBIENCE = 0.15;
/** Seconds for each part to follow its target (and for all of them to fall silent when the world stops). */
export const AMBIENCE_TAU = Object.freeze({ wind: 2, stream: 0.8, fire: 0.6, birds: 3, crickets: 3 });
export const AMBIENCE_FADE_TAU = 0.25;
/** A part below this level is off (its loop frees its voice). */
export const AMBIENCE_OFF = 0.004;

/**
 * What the ambience follows (main fills it: the sky, sampleSurroundings twice a second, the nearest campfire).
 * @typedef {Object} AmbienceSample
 * @property {number} daylight      0..1
 * @property {number} biome
 * @property {boolean} openSky
 * @property {boolean} underground
 * @property {number} trees         0..1
 * @property {number} grass         0..1
 * @property {number} streamDist    metres (Infinity: none)
 * @property {number} fireDist      metres to the nearest campfire (Infinity: none)
 * @property {number} [y]           the feet's height (cells)
 * @property {boolean} [headInWater]
 */

const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * How loud each part of the ambience should be for a place and a time, 0..1 each. Pure.
 * @param {AmbienceSample} s
 * @returns {{ wind: number, stream: number, fire: number, birds: number, crickets: number }}
 */
export function ambienceTargets(s) {
  const out = { wind: 0, stream: 0, fire: 0, birds: 0, crickets: 0 };
  if (!s) return out;
  const trees = clamp01(s.trees || 0);
  const outside = s.underground ? 0 : 1;
  // wind: the biome's, more with height, less among trees, half under a roof, almost none underground
  const high = Math.min(WIND_HIGH_MAX, Math.max(0, ((s.y ?? SEA_LEVEL) - SEA_LEVEL - WIND_HIGH_FROM) * WIND_HIGH_PER_CELL));
  const open = Math.min(1, (WIND_BY_BIOME[s.biome] ?? 0.5) + high) * (1 - WIND_TREE_SHELTER * trees);
  out.wind = open * (s.underground ? WIND_UNDERGROUND : s.openSky ? 1 : WIND_UNDER_ROOF);
  // birds: by day, near trees and on the plains; never underground
  const day = smoothstep(BIRDS_DAYLIGHT[0], BIRDS_DAYLIGHT[1], s.daylight);
  out.birds = outside * day * Math.max(BIRDS_BY_BIOME[s.biome] ?? 0.3, trees) * (s.openSky || trees > 0 ? 1 : 0.5);
  // crickets: by night, on grass, where it is not frozen
  const night = 1 - smoothstep(CRICKETS_DAYLIGHT[0], CRICKETS_DAYLIGHT[1], s.daylight);
  const frozen = s.biome === BIOME.SNOWY || s.biome === BIOME.SNOWY_PEAKS;
  out.crickets = frozen ? 0 : outside * night * clamp01((s.grass || 0) * 1.5);
  // running water and fire: by distance
  out.stream = s.streamDist < STREAM_RANGE ? Math.pow(1 - s.streamDist / STREAM_RANGE, 1.5) : 0;
  out.fire = s.fireDist < FIRE_RANGE ? Math.pow(1 - s.fireDist / FIRE_RANGE, 1.5) : 0;
  if (s.headInWater) {
    out.wind *= UNDERWATER_AMBIENCE;
    out.stream *= UNDERWATER_AMBIENCE;
    out.fire *= UNDERWATER_AMBIENCE;
    out.birds = 0;
    out.crickets = 0;
  }
  return out;
}

/**
 * The ambience: three loops whose levels follow the place smoothly (wind, with gusts of its own; the stream; the fire's
 * bed) and sparse one-shots (a bird singing a phrase or three, two crickets, bubbles in the stream), never more than
 * AMBIENCE_MAX_VOICES voices in all. `update(dt, null)` fades everything out (the world stopped); `setEnabled(false)`
 * keeps it silent.
 */
export class Ambience {
  /**
   * @param {SoundPlayer} audio
   * @param {{ random?: () => number }} [opts]
   */
  constructor(audio, opts = {}) {
    this.audio = audio;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.enabled = true;
    this.loops = { wind: audio.startLoop('ambWind'), stream: audio.startLoop('ambStream'), fire: audio.startLoop('ambFire') };
    /** the smoothed level of each part, 0..1 */
    this.level = { wind: 0, stream: 0, fire: 0, birds: 0, crickets: 0 };
    /** the engine's own clock (s) and the end times of the one-shots still sounding */
    this.t = 0;
    /** @type {number[]} */
    this.shots = [];
    // the wind's gusts: its level and its pitch each drift to a new random target every few seconds
    this.gust = { v: 0.8, to: 0.8, in: 0 };
    this.howl = { v: 1, to: 1, in: 0 };
    // the bird singing now: its song, how many phrases it has left, how near it is
    this.singer = '';
    this.phrases = 0;
    this.near = 1;
    this.birdIn = 2;
    /** @type {{ period: number, next: number, chirps: number, volume: number }[]} */
    this.crickets = [
      { period: 0.62, next: 0.4, chirps: 8, volume: 0.9 },
      { period: 0.71, next: 1.3, chirps: 5, volume: 0.55 },
    ];
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  /** Voices the ambience holds now: a loop each that is audible, and the one-shots that have not ended. */
  voices() {
    let n = 0;
    for (const k of /** @type {const} */ (['wind', 'stream', 'fire'])) if (this.level[k] >= AMBIENCE_OFF) n++;
    return n + this.shots.length;
  }

  /** Play a one-shot if the budget allows. @param {string} name @param {number} volume @returns {boolean} */
  _shot(name, volume) {
    const recipe = SOUND_BANK[name];
    const need = voicesOf(recipe);
    if (!recipe || !(volume > 0) || this.voices() + need > AMBIENCE_MAX_VOICES) return false;
    this.audio.playRecipe(name, Math.min(1, volume));
    for (let i = 0; i < need; i++) this.shots.push(this.t + recipe.dur);
    return true;
  }

  /** A value that drifts to a new random target in [lo, hi] every `every[0]`..`every[1]` seconds. */
  _drift(d, dt, lo, hi, every, tau) {
    d.in -= dt;
    if (d.in <= 0) {
      d.to = lo + (hi - lo) * this.random();
      d.in = every[0] + (every[1] - every[0]) * this.random();
    }
    d.v += (d.to - d.v) * (1 - Math.exp(-dt / tau));
    return d.v;
  }

  /**
   * @param {number} dt  seconds since the last update
   * @param {AmbienceSample|null} sample  where the player is; null when the world is not running (everything fades)
   */
  update(dt, sample) {
    if (!(dt > 0)) return;
    const step = Math.min(dt, 0.25);
    this.t += step;
    if (this.shots.length) this.shots = this.shots.filter((end) => end > this.t);
    const on = this.enabled && sample;
    const target = ambienceTargets(on ? sample : null);
    const level = this.level;
    for (const k of /** @type {const} */ (['wind', 'stream', 'fire', 'birds', 'crickets'])) {
      const tau = on ? AMBIENCE_TAU[k] : AMBIENCE_FADE_TAU;
      level[k] += (target[k] - level[k]) * (1 - Math.exp(-step / tau));
      if (level[k] < AMBIENCE_OFF && target[k] === 0) level[k] = 0;
    }
    // the loops
    const gust = this._drift(this.gust, step, 0.55, 1, [2, 6], 1.5);
    const howl = this._drift(this.howl, step, 0.85, 1.3, [3, 8], 2);
    this.loops.wind.set(level.wind >= AMBIENCE_OFF ? level.wind * gust : 0, howl);
    this.loops.stream.set(level.stream >= AMBIENCE_OFF ? level.stream : 0, 1);
    this.loops.fire.set(level.fire >= AMBIENCE_OFF ? level.fire : 0, 1);
    if (!on) return;

    // birds: one sings a phrase, perhaps two or three with a breath between, then another takes over after a pause
    if (level.birds > 0.05) {
      this.birdIn -= step;
      if (this.birdIn <= 0) {
        if (this.phrases <= 0) {
          const others = BIRD_SONGS.filter((n) => n !== this.singer);
          this.singer = others[Math.floor(this.random() * others.length) % others.length];
          this.phrases = 1 + Math.floor(this.random() * 3);
          this.near = 0.45 + 0.55 * this.random();
        }
        this._shot(this.singer, level.birds * this.near);
        this.phrases--;
        const dur = SOUND_BANK[this.singer].dur;
        this.birdIn = this.phrases > 0 ? dur + 0.8 + 1.6 * this.random() : dur + (2.5 + 6 * this.random()) / Math.max(0.25, level.birds);
      }
    } else {
      this.phrases = 0;
      this.birdIn = Math.min(this.birdIn, 3);
    }
    // crickets: each chirps at its own steady rate for a while, then rests
    if (level.crickets > 0.05) {
      for (const c of this.crickets) {
        c.next -= step;
        if (c.next > 0) continue;
        if (c.chirps > 0) {
          this._shot('cricketChirp', level.crickets * c.volume);
          c.chirps--;
          c.next = c.period * (0.93 + 0.14 * this.random());
        } else {
          c.chirps = 6 + Math.floor(this.random() * 14);
          c.period = 0.5 + 0.3 * this.random();
          c.next = 1.5 + 5 * this.random();
        }
      }
    }
    // bubbles in the stream, about three a second beside it
    if (level.stream > 0.05 && this.random() < 3 * level.stream * step) {
      this._shot('streamBlip', level.stream * (0.4 + 0.6 * this.random()));
    }
  }

  /** Silence at once (leaving the world): the loops stop, the levels are forgotten. */
  stop() {
    for (const k of /** @type {const} */ (['wind', 'stream', 'fire', 'birds', 'crickets'])) this.level[k] = 0;
    this.loops.wind.set(0, 1);
    this.loops.stream.set(0, 1);
    this.loops.fire.set(0, 1);
    this.shots.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Ambience switch (kept between visits)
// ---------------------------------------------------------------------------------------------------------------------

/** localStorage key of the Ambience switch ('off' when switched off; absent: on). */
export const AMBIENCE_PREF_KEY = 'caelancraft:v2:ambience';

/** @param {{ getItem(k: string): string|null }|null|undefined} storage @returns {boolean} on unless stored 'off' */
export function loadAmbiencePref(storage) {
  try {
    return !storage || storage.getItem(AMBIENCE_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** @param {{ setItem(k: string, v: string): void, removeItem(k: string): void }|null|undefined} storage @param {boolean} on */
export function saveAmbiencePref(storage, on) {
  try {
    if (!storage) return;
    if (on) storage.removeItem(AMBIENCE_PREF_KEY);
    else storage.setItem(AMBIENCE_PREF_KEY, 'off');
  } catch {
    /* a full or blocked store: the switch still works for this visit */
  }
}
