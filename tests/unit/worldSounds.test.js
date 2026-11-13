// src/worldSounds.js (CONTRACTS §82): footsteps and movement (MoveSounds), what the ambience follows (ambienceTargets,
// sampleSurroundings), the ambience engine (Ambience: smooth levels, sparse one-shots, a budget of voices), the animals'
// voices (ANIMAL_VOICES, ambientCall) and the Ambience switch's storage. Pure logic on a recording stand-in for the audio
// player; the last tests run the real audio code on the offline renderer.
import { describe, it, expect } from 'vitest';
import {
  MoveSounds, Ambience, ambienceTargets, sampleSurroundings, ANIMAL_VOICES, ambientCall, loadAmbiencePref, saveAmbiencePref,
  STRIDE_M, SNEAK_STRIDE_M, SWIM_STROKE_M, STEP_VOLUME, LAND_THUD_FROM, SPLASH_GAP_S, OUT_AFTER_S, STREAM_RANGE, FIRE_RANGE,
  AMBIENCE_MAX_VOICES, AMBIENCE_OFF, AMBIENCE_PREF_KEY, WIND_UNDERGROUND, WIND_UNDER_ROOF, HOWL_CHANCE, HOWL_BELOW_DAYLIGHT,
  UNDERWATER_AMBIENCE, RAIN_UNDER_ROOF, RAIN_UNDERGROUND, RAIN_ROOF_RATE, RAIN_HUSH, RAIN_PATTER_PER_S, THUNDER_FROM,
  THUNDER_EVERY_S, THUNDER_FIRST_S, THUNDER_VOLUME, AMBIENCE_TAU,
} from '../../src/worldSounds.js';
import { SOUND_BANK, BIRD_SONGS, VOICE_RECIPES, voicesOf } from '../../src/soundBank.js';
import { SOUNDS as ANIMAL_BASE_SOUNDS, SPECIES } from '../../src/animals.js';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, JUMP_VELOCITY, CAMPFIRE_CRACKLE_RANGE } from '../../src/config.js';
import { hexToWorld } from '../../src/hex.js';
import { createAudio } from '../../src/audio.js';
import { OfflineContext, measure, seededRandom } from '../helpers/offlineAudio.js';

/** A stand-in for the audio player that records what is played and how each loop is set. */
function recorder() {
  const plays = [];
  const loops = {};
  return {
    plays,
    loops,
    playRecipe(name, volume = 1) {
      plays.push([name, volume]);
    },
    startLoop(name) {
      const h = { name, volume: 0, rate: 1, sets: 0, set(v, r = 1) { h.volume = v; h.rate = r; h.sets++; }, stop() { h.volume = 0; } };
      loops[name] = h;
      return h;
    },
  };
}
const DT = 1 / 60;
const GROUND = { x: 0, y: 64, z: 0, vy: 0, onGround: true, flying: false, sneaking: false, sprinting: false, inWater: false, wading: false, headInWater: false, ground: 'grass', riding: false };

/** Move along +x at `speed` for `seconds`, with `over` laid over the sample; returns the sounds played meanwhile. */
function move(ms, audio, s, speed, seconds, over = {}) {
  const from = audio.plays.length;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    s.x += speed * DT;
    ms.update(DT, Object.assign(s, over));
  }
  return audio.plays.slice(from);
}
function walker(over = {}) {
  const audio = recorder();
  const ms = new MoveSounds(audio);
  const s = { ...GROUND, ...over };
  ms.update(DT, s); // the first update only looks
  return { audio, ms, s };
}

describe('MoveSounds: footsteps (§82)', () => {
  it('walking makes about two steps a second, sprinting more, sneaking fewer and quieter: the cadence follows the speed', () => {
    const w = walker();
    const walk = move(w.ms, w.audio, w.s, WALK_SPEED, 10);
    expect(walk.every(([n, v]) => n === 'stepGrass' && v === STEP_VOLUME.walk)).toBe(true);
    expect(walk.length).toBeGreaterThanOrEqual(19);
    expect(walk.length).toBeLessThanOrEqual(21);
    const sprint = move(w.ms, w.audio, w.s, SPRINT_SPEED, 10, { sprinting: true });
    expect(sprint.length).toBeGreaterThanOrEqual(25);
    expect(sprint.length).toBeLessThanOrEqual(27);
    expect(sprint.every(([, v]) => v === STEP_VOLUME.sprint)).toBe(true);
    const sneak = move(w.ms, w.audio, w.s, SNEAK_SPEED, 10, { sprinting: false, sneaking: true });
    expect(sneak.length).toBeGreaterThanOrEqual(12);
    expect(sneak.length).toBeLessThanOrEqual(14);
    expect(sneak.every(([, v]) => v === STEP_VOLUME.sneak)).toBe(true);
    expect(STEP_VOLUME.sneak).toBeLessThan(STEP_VOLUME.walk / 2);
    expect(WALK_SPEED / STRIDE_M).toBeCloseTo(2, 1);
    expect(SNEAK_STRIDE_M).toBeLessThan(STRIDE_M);
    // slowed by hunger or cold (half speed): half the steps
    const slow = move(w.ms, w.audio, w.s, WALK_SPEED / 2, 10, { sneaking: false });
    expect(slow.length).toBeGreaterThanOrEqual(9);
    expect(slow.length).toBeLessThanOrEqual(11);
  });

  it('the ground decides the sound; unknown ground is stone; in shallow water it is the water\'s step, a wade', () => {
    for (const [ground, name] of [['stone', 'stepStone'], ['wood', 'stepWood'], ['sand', 'stepSand'], ['snow', 'stepSnow'],
      ['gravel', 'stepGravel'], ['leaves', 'stepLeaves'], ['glass', 'stepGlass'], ['cloth', 'stepCloth'], ['dirt', 'stepDirt'], [null, 'stepStone'], ['water', 'stepWater']]) {
      const w = walker({ ground });
      const steps = move(w.ms, w.audio, w.s, WALK_SPEED, 3);
      expect(steps.length, String(ground)).toBeGreaterThan(3);
      expect(new Set(steps.map((p) => p[0])), String(ground)).toEqual(new Set([name]));
      expect(SOUND_BANK[name], name).toBeTruthy();
    }
    const w = walker({ ground: 'sand', wading: true });
    expect(new Set(move(w.ms, w.audio, w.s, WALK_SPEED * 0.7, 3).map((p) => p[0]))).toEqual(new Set(['stepWater']));
  });

  it('no steps standing still, drifting, in the air, flying or riding; the first step comes soon after setting off', () => {
    const w = walker();
    expect(move(w.ms, w.audio, w.s, 0, 5)).toEqual([]);
    expect(move(w.ms, w.audio, w.s, 0.3, 5)).toEqual([]); // nudged by a current or a pig
    expect(move(w.ms, w.audio, w.s, WALK_SPEED, 5, { flying: true, onGround: false })).toEqual([]);
    expect(move(w.ms, w.audio, w.s, WALK_SPEED, 5, { flying: false, onGround: true, riding: true })).toEqual([]);
    expect(move(w.ms, w.audio, w.s, WALK_SPEED, 2, { riding: false, onGround: false, vy: -1 }).filter((p) => p[0].startsWith('step'))).toEqual([]);
    const v = walker();
    move(v.ms, v.audio, v.s, 0, 1);
    const first = move(v.ms, v.audio, v.s, WALK_SPEED, 0.3);
    expect(first).toHaveLength(1); // within a third of a second, not after a whole stride
    // walking into a wall: the legs move, the body does not — no steps
    expect(move(v.ms, v.audio, v.s, 0, 3)).toEqual([]);
  });

  it('a teleport is not a walk: no step, no landing, no splash', () => {
    const w = walker();
    move(w.ms, w.audio, w.s, WALK_SPEED, 1);
    const n = w.audio.plays.length;
    w.s.x += 500;
    w.s.y = 20;
    w.ms.update(DT, Object.assign(w.s, { inWater: true, onGround: false }));
    expect(w.audio.plays.length).toBe(n);
    w.ms.reset();
    w.ms.update(DT, w.s); // after a reset the first update only looks, wherever the body is
    expect(w.audio.plays.length).toBe(n);
  });
});

describe('MoveSounds: jumping and landing (§82)', () => {
  /** Leave the ground with `vy`, stay up `air` seconds, come down at `fall` m/s. */
  function hop(vy, air, fall, over = {}) {
    const w = walker(over);
    move(w.ms, w.audio, w.s, 0, 0.5);
    const from = w.audio.plays.length;
    w.ms.update(DT, Object.assign(w.s, { onGround: false, vy }));
    const up = w.audio.plays.slice(from);
    for (let t = DT; t < air; t += DT) w.ms.update(DT, Object.assign(w.s, { vy: -fall }));
    const n = w.audio.plays.length;
    w.ms.update(DT, Object.assign(w.s, { onGround: true, vy: 0 }));
    return { up, down: w.audio.plays.slice(n) };
  }

  it('a jump is heard on leaving the ground upward; walking off a ledge is not a jump', () => {
    expect(hop(JUMP_VELOCITY, 0.6, 8.5).up).toEqual([['jump', 0.7]]);
    expect(hop(-0.5, 0.4, 7).up).toEqual([]);
    expect(hop(0, 0.4, 7).up).toEqual([]);
  });

  it('a landing is the ground\'s step, louder with the fall, and from a real drop a thump scaled by the speed', () => {
    const jump = hop(JUMP_VELOCITY, 0.6, 8.5).down; // back down from a jump
    expect(jump.map((p) => p[0])).toEqual(['stepGrass', 'landThud']);
    expect(jump[1][1]).toBeCloseTo((8.5 - 4) / 12, 6);
    expect(jump[0][1]).toBeCloseTo(0.45 + 0.55 * jump[1][1], 6);
    const oneBlock = hop(0, 0.27, 7.5).down; // stepping down one block: a step, no thump
    expect(oneBlock.map((p) => p[0])).toEqual(['stepGrass']);
    expect((7.5 - 4) / 12).toBeLessThan(LAND_THUD_FROM);
    const high = hop(0, 1.2, 22, { ground: 'stone' }).down; // a long fall
    expect(high).toEqual([['stepStone', 1], ['landThud', 1]]);
    const thuds = [5, 8, 11, 14, 17].map((v) => (hop(0, 0.5, v).down.find((p) => p[0] === 'landThud') ?? [0, 0])[1]);
    for (let i = 1; i < thuds.length; i++) expect(thuds[i]).toBeGreaterThan(thuds[i - 1] - 1e-9); // it grows with the speed
    expect(thuds[0]).toBe(0);
    expect(thuds.at(-1)).toBe(1);
    // a flicker of a frame off the ground at no speed is nothing
    expect(hop(0, DT, 0.4).down).toEqual([]);
  });
});

describe('MoveSounds: water (§82)', () => {
  it('going into deep water splashes, harder from a height; bobbing at the surface does not splash again', () => {
    const w = walker();
    move(w.ms, w.audio, w.s, WALK_SPEED, 1);
    const n = w.audio.plays.length;
    w.ms.update(DT, Object.assign(w.s, { onGround: false, vy: -10 }));
    w.ms.update(DT, Object.assign(w.s, { inWater: true, vy: -2 }));
    expect(w.audio.plays.slice(n)).toEqual([['splashIn', 0.3 + 10 / 16]]);
    // out for a moment and in again, three times: no more splashes
    for (let k = 0; k < 3; k++) {
      for (let t = 0; t < 0.2; t += DT) w.ms.update(DT, Object.assign(w.s, { inWater: false }));
      for (let t = 0; t < 0.2; t += DT) w.ms.update(DT, Object.assign(w.s, { inWater: true }));
    }
    expect(w.audio.plays.slice(n).filter((p) => p[0] === 'splashIn')).toHaveLength(1);
    expect(SPLASH_GAP_S).toBeGreaterThan(0.25);
    // walking in from the shallows: a soft splash
    const v = walker({ wading: true });
    move(v.ms, v.audio, v.s, 2, 1);
    const m = v.audio.plays.length;
    v.ms.update(DT, Object.assign(v.s, { wading: false, inWater: true, vy: 0 }));
    expect(v.audio.plays.slice(m)).toEqual([['splashIn', 0.3]]);
  });

  it('swimming makes a stroke every couple of metres, muffled with the head under; treading water is silent', () => {
    const w = walker({ onGround: false, inWater: true });
    const strokes = move(w.ms, w.audio, w.s, WALK_SPEED * 0.5, 6);
    expect(new Set(strokes.map((p) => p[0]))).toEqual(new Set(['swim']));
    expect(strokes.length).toBeGreaterThanOrEqual(Math.floor((WALK_SPEED * 0.5 * 6) / SWIM_STROKE_M) - 1);
    expect(strokes.length).toBeLessThanOrEqual(Math.ceil((WALK_SPEED * 0.5 * 6) / SWIM_STROKE_M));
    const under = move(w.ms, w.audio, w.s, WALK_SPEED * 0.5, 4, { headInWater: true });
    expect(new Set(under.map((p) => p[0]))).toEqual(new Set(['swimUnder']));
    expect(move(w.ms, w.audio, w.s, 0, 5)).toEqual([]);
    // swimming straight up counts too
    const from = w.audio.plays.length;
    for (let t = 0; t < 2; t += DT) {
      w.s.y += 3.5 * DT;
      w.ms.update(DT, w.s);
    }
    expect(w.audio.plays.length - from).toBeGreaterThanOrEqual(2);
  });

  it('climbing out is heard once, a moment after leaving, and only after a real swim', () => {
    const w = walker({ onGround: false, inWater: true });
    move(w.ms, w.audio, w.s, 2, 2);
    const n = w.audio.plays.length;
    const out = move(w.ms, w.audio, w.s, 0, 1, { inWater: false, onGround: true });
    expect(out).toEqual([['splashOut', 0.8]]);
    expect(move(w.ms, w.audio, w.s, 0, 2)).toEqual([]);
    expect(OUT_AFTER_S).toBeLessThan(SPLASH_GAP_S);
    // a dip of a third of a second: no climbing-out sound
    const v = walker();
    move(v.ms, v.audio, v.s, 0, 1);
    move(v.ms, v.audio, v.s, 0, 0.3, { inWater: true, onGround: false });
    expect(move(v.ms, v.audio, v.s, 0, 1, { inWater: false, onGround: true }).filter((p) => p[0] === 'splashOut')).toEqual([]);
    expect(n).toBeGreaterThan(0);
  });
});

describe('ambienceTargets: the ambience follows the world (§82)', () => {
  const HERE = { daylight: 1, biome: BIOME.PLAINS, openSky: true, underground: false, trees: 0, grass: 1, streamDist: Infinity, fireDist: Infinity, y: 66, headInWater: false };
  const at = (over) => ambienceTargets({ ...HERE, ...over });

  it('birds by day near trees and on the plains; none at night, none underground', () => {
    expect(at({}).birds).toBeGreaterThan(0.5);
    expect(at({ biome: BIOME.FOREST }).birds).toBe(1);
    expect(at({ daylight: 0 }).birds).toBe(0);
    expect(at({ daylight: 0.2 }).birds).toBe(0);
    expect(at({ underground: true, openSky: false }).birds).toBe(0);
    expect(at({ biome: BIOME.DESERT }).birds).toBeLessThan(0.2);
    expect(at({ biome: BIOME.DESERT, trees: 1 }).birds).toBe(1); // an oasis of trees
    expect(at({ biome: BIOME.SNOWY_PEAKS }).birds).toBeLessThan(0.1);
    expect(at({ daylight: 0.45 }).birds).toBeGreaterThan(0);
    expect(at({ daylight: 0.45 }).birds).toBeLessThan(at({}).birds); // dawn and dusk: fewer
    expect(at({ openSky: false }).birds).toBeLessThan(at({}).birds); // under a roof they are fainter
  });

  it('crickets at night on grass; none by day, off the grass, in the snow or underground', () => {
    expect(at({ daylight: 0 }).crickets).toBe(1);
    expect(at({}).crickets).toBe(0);
    expect(at({ daylight: 0, grass: 0 }).crickets).toBe(0);
    expect(at({ daylight: 0, grass: 0.3 }).crickets).toBeGreaterThan(0.3);
    expect(at({ daylight: 0, biome: BIOME.SNOWY }).crickets).toBe(0);
    expect(at({ daylight: 0, underground: true, openSky: false }).crickets).toBe(0);
    for (const daylight of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.8, 1]) {
      const t = at({ daylight });
      expect(t.birds * t.crickets, `daylight ${daylight}: not both at once`).toBeLessThan(0.05);
    }
  });

  it('wind: strongest on the peaks, strong in the open, faint in the woods, almost none underground', () => {
    const wind = (over) => at(over).wind;
    expect(wind({ biome: BIOME.SNOWY_PEAKS })).toBeGreaterThan(wind({ biome: BIOME.MOUNTAINS }));
    expect(wind({ biome: BIOME.MOUNTAINS })).toBeGreaterThan(wind({ biome: BIOME.PLAINS }));
    expect(wind({ biome: BIOME.PLAINS })).toBeGreaterThan(wind({ biome: BIOME.FOREST }) * 2);
    expect(wind({ biome: BIOME.FOREST, trees: 1 })).toBeLessThan(0.15);
    expect(wind({ trees: 1 })).toBeCloseTo(wind({}) / 2, 6);
    expect(wind({ underground: true, openSky: false })).toBeCloseTo(wind({}) * WIND_UNDERGROUND, 6);
    expect(wind({ underground: true, openSky: false })).toBeLessThan(0.05);
    expect(wind({ openSky: false })).toBeCloseTo(wind({}) * WIND_UNDER_ROOF, 6);
    expect(wind({ y: 120 })).toBeGreaterThan(wind({ y: 66 }));
    for (const biome of Object.values(BIOME)) {
      expect(wind({ biome, y: 127 }), String(biome)).toBeLessThanOrEqual(1);
      expect(wind({ biome }), String(biome)).toBeGreaterThan(0);
    }
  });

  it('running water and fire by distance; with the head under water everything is faint and nothing sings', () => {
    expect(at({ streamDist: 0 }).stream).toBe(1);
    expect(at({ streamDist: STREAM_RANGE }).stream).toBe(0);
    expect(at({}).stream).toBe(0);
    let last = 2;
    for (let d = 0; d <= STREAM_RANGE; d++) {
      const v = at({ streamDist: d }).stream;
      expect(v).toBeLessThan(last);
      last = v;
    }
    expect(at({ fireDist: 0 }).fire).toBe(1);
    expect(at({ fireDist: FIRE_RANGE / 2 }).fire).toBeGreaterThan(0.2);
    expect(at({ fireDist: FIRE_RANGE }).fire).toBe(0);
    expect(FIRE_RANGE).toBe(CAMPFIRE_CRACKLE_RANGE);
    expect(at({ streamDist: 3, underground: true, openSky: false }).stream).toBeGreaterThan(0); // a stream in a cave is heard
    const wet = at({ headInWater: true, streamDist: 0, fireDist: 0, daylight: 1 });
    expect(wet.birds).toBe(0);
    expect(wet.stream).toBeCloseTo(UNDERWATER_AMBIENCE, 6);
    expect(wet.wind).toBeCloseTo(at({}).wind * UNDERWATER_AMBIENCE, 6);
    expect(ambienceTargets(null)).toEqual({ wind: 0, stream: 0, fire: 0, birds: 0, crickets: 0, rain: 0 }); // rain: §84
    for (const v of Object.values(at({ streamDist: 0, fireDist: 0, biome: BIOME.SNOWY_PEAKS, y: 127 }))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Ambience: the engine (§82)', () => {
  const DAY = { daylight: 1, biome: BIOME.FOREST, openSky: true, underground: false, trees: 1, grass: 1, streamDist: Infinity, fireDist: Infinity, y: 66 };
  const NIGHT = { ...DAY, daylight: 0, biome: BIOME.PLAINS, trees: 0 };
  function run(amb, seconds, sample, each) {
    for (let t = 0; t < seconds; t += DT) {
      amb.update(DT, sample);
      if (each) each();
    }
  }
  const make = (seed = 1) => {
    const audio = recorder();
    return { audio, amb: new Ambience(audio, { random: seededRandom(seed) }) };
  };

  it('three loops whose levels follow the place smoothly: no jump at the start, none when the place changes', () => {
    const { audio, amb } = make();
    expect(Object.keys(audio.loops).sort()).toEqual(['ambFire', 'ambRain', 'ambStream', 'ambWind']); // + the rain's (§84)
    amb.update(DT, { ...DAY, biome: BIOME.SNOWY_PEAKS, trees: 0, streamDist: 0, fireDist: 0 });
    for (const k of ['wind', 'stream', 'fire']) expect(amb.level[k], k).toBeLessThan(0.03);
    let jump = 0;
    let before = { ...amb.level };
    run(amb, 15, { ...DAY, biome: BIOME.SNOWY_PEAKS, trees: 0, streamDist: 0, fireDist: 0 }, () => {
      for (const k of ['wind', 'stream', 'fire']) jump = Math.max(jump, Math.abs(amb.level[k] - before[k]));
      before = { ...amb.level };
    });
    expect(jump).toBeLessThan(0.03); // a sixtieth of a second never moves a level by more than 3 %
    expect(amb.level.wind).toBeGreaterThan(0.95);
    expect(amb.level.stream).toBeGreaterThan(0.99);
    expect(audio.loops.ambStream.volume).toBeCloseTo(amb.level.stream, 9);
    expect(audio.loops.ambStream.rate).toBe(1);
    expect(audio.loops.ambFire.volume).toBeCloseTo(amb.level.fire, 9);
    // walking away from the stream and the fire: they fade, then their loops are switched off
    run(amb, 12, { ...DAY, trees: 1 });
    expect(audio.loops.ambStream.volume).toBe(0);
    expect(audio.loops.ambFire.volume).toBe(0);
    expect(amb.level.stream).toBe(0);
    expect(audio.loops.ambWind.volume).toBeGreaterThan(0);
  });

  it('the wind gusts: its level and its pitch drift, slowly, within bounds', () => {
    const { audio, amb } = make(3);
    run(amb, 10, { ...DAY, biome: BIOME.PLAINS, trees: 0 });
    const volumes = [];
    const rates = [];
    let step = 0;
    let lastV = audio.loops.ambWind.volume;
    run(amb, 120, { ...DAY, biome: BIOME.PLAINS, trees: 0 }, () => {
      const h = audio.loops.ambWind;
      volumes.push(h.volume / amb.level.wind);
      rates.push(h.rate);
      step = Math.max(step, Math.abs(h.volume - lastV));
      lastV = h.volume;
    });
    expect(Math.min(...volumes)).toBeGreaterThanOrEqual(0.55 - 1e-9);
    expect(Math.max(...volumes)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(...volumes) - Math.min(...volumes)).toBeGreaterThan(0.2); // it does move
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(0.85 - 1e-9);
    expect(Math.max(...rates)).toBeLessThanOrEqual(1.3 + 1e-9);
    expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThan(0.15);
    expect(step).toBeLessThan(0.01); // and never jumps
  });

  it('by day birds sing: one sings a phrase or three, then another; by night none', () => {
    const { audio, amb } = make(5);
    run(amb, 240, DAY);
    const birds = audio.plays.filter((p) => p[0].startsWith('bird'));
    expect(birds.length).toBeGreaterThan(20);
    expect(birds.length).toBeLessThan(120); // sparse: under one every two seconds
    for (const [name, v] of birds) {
      expect(BIRD_SONGS).toContain(name);
      expect(v).toBeGreaterThan(0.2);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(new Set(birds.map((p) => p[0])).size).toBeGreaterThanOrEqual(4); // several species
    let runLength = 1;
    let longest = 1;
    let changes = 0;
    for (let i = 1; i < birds.length; i++) {
      if (birds[i][0] === birds[i - 1][0]) runLength++;
      else {
        changes++;
        runLength = 1;
      }
      longest = Math.max(longest, runLength);
    }
    expect(longest).toBeLessThanOrEqual(3);
    expect(changes).toBeGreaterThan(8);
    expect(audio.plays.some((p) => p[0] === 'cricketChirp')).toBe(false);
    const night = make(5);
    run(night.amb, 120, NIGHT);
    expect(night.audio.plays.some((p) => p[0].startsWith('bird'))).toBe(false);
  });

  it('by night two crickets chirp at their own steady rates, with rests; by day none', () => {
    const { audio, amb } = make(7);
    const times = [];
    const shares = new Set();
    let t = 0;
    run(amb, 120, NIGHT, () => {
      t += DT;
      while (times.length < audio.plays.length) {
        shares.add(Math.round((audio.plays[times.length][1] / amb.level.crickets) * 100));
        times.push(t);
      }
    });
    const chirps = audio.plays.filter((p) => p[0] === 'cricketChirp');
    expect(chirps.length).toBe(audio.plays.length); // nothing else at night on the plains
    expect(chirps.length / 120).toBeGreaterThan(0.8);
    expect(chirps.length / 120).toBeLessThan(4);
    expect([...shares].sort()).toEqual([55, 90]); // a far one and a near one
    const gaps = times.slice(1).map((v, i) => v - times[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(1); // they rest
    expect(Math.max(...gaps)).toBeLessThan(8);
    const day = make(7);
    run(day.amb, 60, { ...DAY, biome: BIOME.PLAINS, trees: 0 });
    expect(day.audio.plays.some((p) => p[0] === 'cricketChirp')).toBe(false);
  });

  it('beside a stream bubbles rise a few times a second; away from it none', () => {
    const { audio, amb } = make(9);
    run(amb, 60, { ...NIGHT, grass: 0, streamDist: 0.5 });
    const blips = audio.plays.filter((p) => p[0] === 'streamBlip');
    expect(blips.length / 60).toBeGreaterThan(1);
    expect(blips.length / 60).toBeLessThan(4);
    const far = make(9);
    run(far.amb, 60, { ...NIGHT, grass: 0 });
    expect(far.audio.plays).toEqual([]);
  });

  it('never more than AMBIENCE_MAX_VOICES voices: the loops and every one-shot still sounding', () => {
    expect(AMBIENCE_MAX_VOICES).toBeLessThan(6);
    for (const sample of [{ ...DAY, streamDist: 0, fireDist: 0 }, { ...NIGHT, streamDist: 0, fireDist: 0 }, { ...DAY, daylight: 0.35, streamDist: 1, fireDist: 1 }]) {
      const { audio, amb } = make(11);
      /** @type {number[]} the end time of every voice the test itself counts */
      let sounding = [];
      let t = 0;
      let seen = 0;
      let worst = 0;
      run(amb, 180, sample, () => {
        t += DT;
        sounding = sounding.filter((end) => end > t + 1e-9);
        for (; seen < audio.plays.length; seen++) {
          const recipe = SOUND_BANK[audio.plays[seen][0]];
          for (let i = 0; i < voicesOf(recipe); i++) sounding.push(t + recipe.dur);
        }
        const loops = Object.values(audio.loops).filter((h) => h.volume > 0).length;
        worst = Math.max(worst, loops + sounding.length);
        expect(amb.voices()).toBeLessThanOrEqual(AMBIENCE_MAX_VOICES);
      });
      expect(worst).toBeLessThanOrEqual(AMBIENCE_MAX_VOICES);
      expect(worst).toBeGreaterThanOrEqual(3); // and it does use them
    }
  });

  it('without a world (null) everything fades out in about a second and nothing more is played', () => {
    const { audio, amb } = make();
    run(amb, 20, { ...DAY, streamDist: 0, fireDist: 0 });
    const n = audio.plays.length;
    let last = audio.loops.ambStream.volume;
    let jump = 0;
    run(amb, 1.5, null, () => {
      jump = Math.max(jump, Math.abs(audio.loops.ambStream.volume - last));
      last = audio.loops.ambStream.volume;
    });
    expect(jump).toBeLessThan(0.08); // a fade, not a cut
    for (const h of Object.values(audio.loops)) expect(h.volume, h.name).toBe(0);
    expect(audio.plays.length).toBe(n);
    for (const v of Object.values(amb.level)) expect(v).toBeLessThan(AMBIENCE_OFF);
    // and back: it rises again from silence
    run(amb, 10, { ...DAY, streamDist: 0 });
    expect(audio.loops.ambStream.volume).toBeGreaterThan(0.9);
  });

  it('the Ambience switch: off is silence, on brings it back; stop() silences at once', () => {
    const { audio, amb } = make();
    amb.setEnabled(false);
    run(amb, 30, { ...DAY, streamDist: 0, fireDist: 0 });
    expect(audio.plays).toEqual([]);
    for (const h of Object.values(audio.loops)) expect(h.volume).toBe(0);
    amb.setEnabled(true);
    run(amb, 30, { ...DAY, streamDist: 0, fireDist: 0 });
    expect(audio.plays.length).toBeGreaterThan(0);
    expect(audio.loops.ambWind.volume).toBeGreaterThan(0);
    amb.stop();
    for (const h of Object.values(audio.loops)) expect(h.volume).toBe(0);
    expect(amb.voices()).toBe(0);
    // odd time steps change nothing
    const n = audio.plays.length;
    amb.update(0, DAY);
    amb.update(-1, DAY);
    amb.update(NaN, DAY);
    expect(audio.plays.length).toBe(n);
    for (const v of Object.values(amb.level)) expect(v).toBe(0);
  });

  it('on the real audio code: a minute of day by a stream is quiet, never clips and uses few voices', () => {
    const real = Math.random;
    Math.random = seededRandom(21);
    try {
      const audio = createAudio({ AudioContextClass: OfflineContext });
      audio.resume();
      const ctx = /** @type {any} */ (OfflineContext.last);
      const amb = new Ambience(audio);
      const chunks = [];
      let most = 0;
      for (let i = 0; i < 20 * 20; i++) {
        amb.update(0.05, { ...DAY, streamDist: 2, fireDist: 3 });
        chunks.push(ctx.render(0.05));
        most = Math.max(most, ctx.live.filter((s) => s.kind === 'noise' && s.loop).length);
      }
      const x = Float32Array.from(chunks.flatMap((c) => [...c]));
      const m = measure(x.slice(44100 * 8)); // once it has faded in
      expect(m.peak).toBeGreaterThan(0.003);
      expect(m.peak).toBeLessThan(0.2);
      expect(m.level).toBeLessThan(-36); // well under a break (about −27 dB)
      expect(m.level).toBeGreaterThan(-60);
      let click = 0;
      for (let i = 1; i < x.length; i++) click = Math.max(click, Math.abs(x[i] - x[i - 1]));
      expect(click).toBeLessThan(0.08); // no pop anywhere, the start included
      expect(most).toBeGreaterThan(0);
      amb.update(0.05, null);
      for (let i = 0; i < 40; i++) {
        amb.update(0.05, null);
        ctx.render(0.05);
      }
      expect(measure(ctx.render(0.5)).peak).toBeLessThan(0.002); // faded out; only a last chirp may linger
    } finally {
      Math.random = real;
    }
  });
});

describe('rain in the ambience (CONTRACTS §84)', () => {
  const HERE = { daylight: 1, biome: BIOME.PLAINS, openSky: true, underground: false, trees: 0, grass: 1, streamDist: Infinity, fireDist: Infinity, y: 66, headInWater: false };
  const at = (over) => ambienceTargets({ ...HERE, ...over });
  const run = (amb, seconds, sample, each) => {
    for (let t = 0; t < seconds; t += DT) {
      amb.update(DT, sample);
      if (each) each();
    }
  };
  const make = (seed = 1) => {
    const audio = recorder();
    return { audio, amb: new Ambience(audio, { random: seededRandom(seed) }) };
  };

  it('the rain\'s level follows its strength and the cover: full under the open sky, quieter under a roof, almost gone underground', () => {
    expect(at({}).rain).toBe(0);
    expect(at({ rain: 0 }).rain).toBe(0);
    expect(at({ rain: 1 }).rain).toBe(1);
    expect(at({ rain: 0.25 }).rain).toBeCloseTo(0.5, 9); // a light rain is already heard
    expect(at({ rain: 1, openSky: false }).rain).toBeCloseTo(RAIN_UNDER_ROOF, 9);
    expect(at({ rain: 1, openSky: false, underground: true }).rain).toBeCloseTo(RAIN_UNDERGROUND, 9);
    expect(RAIN_UNDER_ROOF).toBeLessThan(0.6);
    expect(RAIN_UNDERGROUND).toBeLessThan(0.1);
    expect(at({ rain: 1, headInWater: true }).rain).toBeCloseTo(UNDERWATER_AMBIENCE, 9);
    let last = -1;
    for (let r = 0; r <= 1.0001; r += 0.05) {
      const v = at({ rain: r }).rain;
      expect(v).toBeGreaterThan(last);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
    expect(at({ rain: 7 }).rain).toBe(1);
    expect(at({ rain: NaN }).rain).toBe(0);
  });

  it('birds fall silent in the rain, and the crickets with them; the wind and the stream do not care', () => {
    expect(at({}).birds).toBeGreaterThan(0.5);
    expect(at({ rain: RAIN_HUSH }).birds).toBe(0);
    expect(at({ rain: 1, biome: BIOME.FOREST, trees: 1 }).birds).toBe(0);
    expect(at({ rain: RAIN_HUSH / 2 }).birds).toBeCloseTo(at({}).birds / 2, 9); // going quiet as it comes on
    expect(at({ rain: 0.02 }).birds).toBeGreaterThan(at({}).birds * 0.9);
    expect(at({ daylight: 0 }).crickets).toBe(1);
    expect(at({ daylight: 0, rain: 0.5 }).crickets).toBe(0);
    expect(at({ rain: 1 }).wind).toBe(at({}).wind);
    expect(at({ rain: 1, streamDist: 2 }).stream).toBe(at({ streamDist: 2 }).stream);
    expect(at({ rain: 1, fireDist: 2 }).fire).toBe(at({ fireDist: 2 }).fire);
  });

  it('the engine: the rain\'s loop rises and falls smoothly with the rain, and frees its voice when it is over', () => {
    const { audio, amb } = make();
    amb.update(DT, { ...HERE, rain: 1 });
    expect(amb.level.rain).toBeLessThan(0.03); // no jump at the start
    let jump = 0;
    let before = amb.level.rain;
    run(amb, 12, { ...HERE, rain: 1 }, () => {
      jump = Math.max(jump, Math.abs(amb.level.rain - before));
      before = amb.level.rain;
    });
    expect(jump).toBeLessThan(0.03);
    expect(amb.level.rain).toBeGreaterThan(0.99);
    expect(audio.loops.ambRain.volume).toBeCloseTo(amb.level.rain, 9);
    expect(audio.loops.ambRain.rate).toBe(1); // under the open sky: its own sound
    expect(AMBIENCE_TAU.rain).toBeGreaterThan(0.5);
    run(amb, 15, { ...HERE, rain: 0 });
    expect(audio.loops.ambRain.volume).toBe(0);
    expect(amb.level.rain).toBe(0);
    // and it stops with everything else when the world stops
    run(amb, 8, { ...HERE, rain: 1 });
    run(amb, 1.5, null);
    expect(audio.loops.ambRain.volume).toBe(0);
    run(amb, 8, { ...HERE, rain: 1 });
    amb.stop();
    expect(audio.loops.ambRain.volume).toBe(0);
    expect(amb.voices()).toBe(0);
  });

  it('stepping under a roof: quieter and duller, both smoothly; stepping out again: back', () => {
    const { audio, amb } = make(2);
    run(amb, 10, { ...HERE, rain: 1 });
    let step = 0;
    let rateStep = 0;
    let lastV = audio.loops.ambRain.volume;
    let lastR = audio.loops.ambRain.rate;
    run(amb, 12, { ...HERE, rain: 1, openSky: false }, () => {
      step = Math.max(step, Math.abs(audio.loops.ambRain.volume - lastV));
      rateStep = Math.max(rateStep, Math.abs(audio.loops.ambRain.rate - lastR));
      lastV = audio.loops.ambRain.volume;
      lastR = audio.loops.ambRain.rate;
    });
    expect(step).toBeLessThan(0.02);
    expect(rateStep).toBeLessThan(0.01);
    expect(audio.loops.ambRain.volume).toBeCloseTo(RAIN_UNDER_ROOF, 2);
    expect(audio.loops.ambRain.rate).toBeCloseTo(RAIN_ROOF_RATE, 2);
    expect(RAIN_ROOF_RATE).toBeLessThan(0.85);
    run(amb, 12, { ...HERE, rain: 1 });
    expect(audio.loops.ambRain.volume).toBeGreaterThan(0.99);
    expect(audio.loops.ambRain.rate).toBeCloseTo(1, 2);
  });

  it('no bird sings in the rain; among trees the drops tap on the leaves, a few a second; in the open they do not', () => {
    const woods = make(3);
    run(woods.amb, 120, { ...HERE, biome: BIOME.FOREST, trees: 1, rain: 0.5 });
    expect(woods.audio.plays.filter((p) => p[0].startsWith('bird'))).toEqual([]);
    const taps = woods.audio.plays.filter((p) => p[0] === 'rainPatter');
    const level = Math.sqrt(0.5);
    expect(taps.length / 120).toBeGreaterThan(RAIN_PATTER_PER_S * level * 0.6);
    expect(taps.length / 120).toBeLessThan(RAIN_PATTER_PER_S * level * 1.1);
    for (const [, v] of taps) {
      expect(v).toBeGreaterThan(0.02); // (the first ones, while the rain comes on, are faint)
      expect(v).toBeLessThanOrEqual(1);
    }
    // once the rain is on, each tap is at half to all of the rain's level
    for (const [, v] of taps.slice(40)) {
      expect(v).toBeGreaterThanOrEqual(level * 0.5 - 0.01);
      expect(v).toBeLessThanOrEqual(level + 1e-9);
    }
    expect(woods.audio.plays.every((p) => p[0] === 'rainPatter')).toBe(true); // 0.5 is no thunder weather
    const open = make(3);
    run(open.amb, 60, { ...HERE, trees: 0, rain: 0.5 });
    expect(open.audio.plays).toEqual([]);
    const cave = make(3);
    run(cave.amb, 60, { ...HERE, trees: 1, rain: 1, openSky: false, underground: true });
    expect(cave.audio.plays).toEqual([]); // nothing taps, nothing rolls, down there
  });

  it('far thunder: only in a heavy shower, a first roll after a little while, then one every 35–90 s, never loud', () => {
    expect(THUNDER_FROM).toBeGreaterThanOrEqual(0.7);
    expect(THUNDER_EVERY_S[0]).toBeGreaterThanOrEqual(30); // now and then
    const heavy = make(4);
    const times = [];
    let t = 0;
    run(heavy.amb, 900, { ...HERE, rain: 0.9 }, () => {
      t += DT;
      while (times.length < heavy.audio.plays.length) times.push(t);
    });
    const rolls = heavy.audio.plays.filter((p) => p[0] === 'thunderRoll');
    expect(rolls.length).toBe(heavy.audio.plays.length); // in the open, nothing else
    expect(rolls.length).toBeGreaterThanOrEqual(900 / THUNDER_EVERY_S[1] - 1);
    expect(rolls.length).toBeLessThanOrEqual(900 / THUNDER_EVERY_S[0] + 1);
    expect(times[0]).toBeGreaterThanOrEqual(THUNDER_FIRST_S[0]);
    expect(times[0]).toBeLessThanOrEqual(THUNDER_FIRST_S[1] + 1);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(THUNDER_EVERY_S[0] - 0.1);
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(THUNDER_EVERY_S[1] + 0.1);
    }
    const level = Math.sqrt(0.9);
    for (const [, v] of rolls) {
      expect(v).toBeGreaterThanOrEqual(THUNDER_VOLUME[0] * level * 0.98);
      expect(v).toBeLessThanOrEqual(THUNDER_VOLUME[1]);
    }
    const light = make(4);
    run(light.amb, 600, { ...HERE, rain: THUNDER_FROM - 0.05 });
    expect(light.audio.plays).toEqual([]);
  });

  it('the budget holds in the rain: by a stream and a fire, in the woods, in a downpour, never more than AMBIENCE_MAX_VOICES', () => {
    for (const sample of [
      { ...HERE, biome: BIOME.FOREST, trees: 1, rain: 1, streamDist: 0, fireDist: 0 },
      { ...HERE, daylight: 0, trees: 0.5, rain: 0.2, streamDist: 1, fireDist: 1 },
      { ...HERE, trees: 1, rain: 0.9 },
    ]) {
      const { audio, amb } = make(11);
      let sounding = [];
      let t = 0;
      let seen = 0;
      let worst = 0;
      run(amb, 240, sample, () => {
        t += DT;
        sounding = sounding.filter((end) => end > t + 1e-9);
        for (; seen < audio.plays.length; seen++) {
          const recipe = SOUND_BANK[audio.plays[seen][0]];
          for (let i = 0; i < voicesOf(recipe); i++) sounding.push(t + recipe.dur);
        }
        const loops = Object.values(audio.loops).filter((h) => h.volume > 0).length;
        worst = Math.max(worst, loops + sounding.length);
        expect(amb.voices()).toBeLessThanOrEqual(AMBIENCE_MAX_VOICES);
      });
      expect(worst).toBeLessThanOrEqual(AMBIENCE_MAX_VOICES);
      expect(worst).toBeGreaterThanOrEqual(2);
    }
  });

  it('without rain nothing changed: no roll is drawn for it, so a dry day sounds exactly as it did', () => {
    const DAY = { daylight: 1, biome: BIOME.FOREST, openSky: true, underground: false, trees: 1, grass: 1, streamDist: 3, fireDist: Infinity, y: 66 };
    const a = make(5);
    const b = make(5);
    run(a.amb, 120, DAY);
    run(b.amb, 120, { ...DAY, rain: 0 });
    expect(b.audio.plays).toEqual(a.audio.plays);
    expect(a.audio.plays.length).toBeGreaterThan(20);
    expect(a.audio.loops.ambRain.volume).toBe(0);
  });

  it('on the real audio code: a minute of heavy rain in the woods is quiet, never clips, and fades out', () => {
    const real = Math.random;
    Math.random = seededRandom(22);
    try {
      const audio = createAudio({ AudioContextClass: OfflineContext });
      audio.resume();
      const ctx = /** @type {any} */ (OfflineContext.last);
      const amb = new Ambience(audio);
      const chunks = [];
      for (let i = 0; i < 20 * 40; i++) {
        amb.update(0.05, { ...HERE, biome: BIOME.FOREST, trees: 1, rain: 0.9 });
        chunks.push(ctx.render(0.05));
      }
      const x = Float32Array.from(chunks.flatMap((c) => [...c]));
      const m = measure(x.slice(44100 * 8));
      expect(m.peak).toBeGreaterThan(0.005);
      expect(m.peak).toBeLessThan(0.25);
      expect(m.level).toBeLessThan(-32); // under a break (about −27 dB), over the day's birdsong
      expect(m.level).toBeGreaterThan(-50);
      let click = 0;
      for (let i = 1; i < x.length; i++) click = Math.max(click, Math.abs(x[i] - x[i - 1]));
      expect(click).toBeLessThan(0.08);
      for (let i = 0; i < 80; i++) {
        amb.update(0.05, null);
        ctx.render(0.05);
      }
      expect(measure(ctx.render(0.5)).peak).toBeLessThan(0.004); // faded out; only a last roll of thunder may linger
    } finally {
      Math.random = real;
    }
  });
});

describe('sampleSurroundings: what the place is like (§82)', () => {
  /** A flat world: `top` at y 63, stone below, air above; cells overlaid by `set(q, y, r) → id | undefined`. */
  function world({ top = BLOCK.GRASS_BLOCK, height = 64, biome = BIOME.PLAINS, set = () => undefined, streamAt } = {}) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      getBlock(q, y, r) {
        calls++;
        const o = set(q, y, r);
        if (o !== undefined) return o;
        if (y === 63) return top;
        return y < 63 ? BLOCK.STONE : BLOCK.AIR;
      },
      columnAt: () => ({ height, biome }),
      streamAt,
    };
  }
  const look = (w) => sampleSurroundings(w, 0, 64, 0, 65.6);

  it('an open meadow: open sky, on grass, no trees, no water; it costs a bounded number of block reads', () => {
    const w = world();
    const s = look(w);
    expect(s).toEqual({ biome: BIOME.PLAINS, openSky: true, underground: false, trees: 0, grass: 1, streamDist: Infinity });
    expect(w.calls).toBeLessThan(2500);
    expect(look(world({ top: BLOCK.STONE })).grass).toBe(0);
    expect(look(world({ top: BLOCK.SAND, biome: BIOME.DESERT })).biome).toBe(BIOME.DESERT);
  });

  it('a roof is not open sky; underground is a roof with the land\'s surface well above', () => {
    const roofed = look(world({ set: (q, y, r) => (q === 0 && r === 0 && y === 70 ? BLOCK.OAK_PLANKS : undefined) }));
    expect(roofed.openSky).toBe(false);
    expect(roofed.underground).toBe(false);
    const cave = sampleSurroundings(world({ height: 90, set: (q, y) => (y >= 44 && y < 90 ? BLOCK.STONE : y >= 40 ? BLOCK.AIR : undefined) }), 0, 40, 0, 41.6);
    expect(cave.openSky).toBe(false);
    expect(cave.underground).toBe(true);
    expect(cave.grass).toBe(0);
  });

  it('leaves nearby count as trees; four leafy columns of the thirteen looked at are "among trees"', () => {
    const one = look(world({ set: (q, y, r) => (q === 3 && r === 0 && y === 68 ? BLOCK.OAK_LEAVES : undefined) }));
    expect(one.trees).toBeCloseTo(0.25, 9);
    const many = look(world({ set: (q, y) => (y === 69 && q !== 0 ? BLOCK.BIRCH_LEAVES : undefined) }));
    expect(many.trees).toBe(1);
    const overhead = look(world({ set: (q, y, r) => (q === 0 && r === 0 && y === 67 ? BLOCK.SPRUCE_LEAVES : undefined) }));
    expect(overhead.trees).toBeGreaterThan(0);
    expect(overhead.openSky).toBe(false); // foliage is cover (as for the climate): under a tree the wind is sheltered
  });

  it('running water: a generated stream\'s column or flowing water, by distance; still water is silent', () => {
    const [sx, sz] = hexToWorld(4, 0);
    const stream = look(world({ streamAt: (q, r) => q === 4 && r === 0 }));
    expect(stream.streamDist).toBeCloseTo(Math.hypot(sx, sz), 6);
    const flowing = look(world({ set: (q, y, r) => (q === -2 && r === 1 && y === 63 ? BLOCK.WATER_FLOW_1 + 2 : undefined) }));
    const [fx, fz] = hexToWorld(-2, 1);
    expect(flowing.streamDist).toBeCloseTo(Math.hypot(fx, fz), 6);
    const pond = look(world({ set: (q, y, r) => (Math.abs(q) < 3 && Math.abs(r) < 3 && y === 63 ? BLOCK.WATER : undefined) }));
    expect(pond.streamDist).toBe(Infinity);
    const far = look(world({ streamAt: (q, r) => q === STREAM_RANGE + 1 && r === 0 }));
    expect(far.streamDist).toBe(Infinity);
    const here = look(world({ streamAt: () => true }));
    expect(here.streamDist).toBeLessThan(1); // standing in it
  });
});

describe('the animals\' voices (§82)', () => {
  it('ANIMAL_VOICES: the bank\'s voice for every species, animals.js\'s own sound for the snare and the taming chime', () => {
    expect(Object.keys(ANIMAL_VOICES).sort()).toEqual(Object.keys(ANIMAL_BASE_SOUNDS).sort());
    for (const [voice, name] of Object.entries(VOICE_RECIPES)) expect(ANIMAL_VOICES[voice], voice).toBe(SOUND_BANK[name]);
    expect(ANIMAL_VOICES.snare).toBe(ANIMAL_BASE_SOUNDS.snare);
    expect(ANIMAL_VOICES.tame).toBe(ANIMAL_BASE_SOUNDS.tame);
    for (const [kind, s] of Object.entries(SPECIES)) {
      expect(ANIMAL_VOICES[s.voice], kind).toBeTruthy();
      expect(ANIMAL_VOICES[s.voice], kind).not.toBe(ANIMAL_BASE_SOUNDS[s.voice]); // every species got a new voice
    }
    expect(Object.isFrozen(ANIMAL_VOICES)).toBe(true);
  });

  it('ambientCall: an animal\'s own voice — and for a wolf by night, most of the time, a howl', () => {
    expect(ambientCall('cow', 'moo', 1)).toBe(SOUND_BANK.cowMoo);
    expect(ambientCall('cow', 'moo', 0)).toBe(SOUND_BANK.cowMoo);
    expect(ambientCall('wolf', 'woof', 1, () => 0)).toBe(SOUND_BANK.wolfBark);
    expect(ambientCall('wolf', 'woof', 0, () => 0)).toBe(SOUND_BANK.wolfHowl);
    expect(ambientCall('wolf', 'woof', 0, () => HOWL_CHANCE + 0.01)).toBe(SOUND_BANK.wolfBark);
    expect(ambientCall('wolf', 'woof', HOWL_BELOW_DAYLIGHT, () => 0)).toBe(SOUND_BANK.wolfBark);
    expect(ambientCall('unicorn', 'neighh', 0)).toBeUndefined(); // main's playRecipe ignores it
    let howls = 0;
    const rnd = seededRandom(2);
    for (let i = 0; i < 1000; i++) if (ambientCall('wolf', 'woof', 0, rnd) === SOUND_BANK.wolfHowl) howls++;
    expect(howls / 1000).toBeCloseTo(HOWL_CHANCE, 1);
  });
});

describe('the Ambience switch is kept between visits (§82)', () => {
  it('on unless stored "off"; a missing or failing store means on, and saving never throws', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    expect(loadAmbiencePref(storage)).toBe(true);
    saveAmbiencePref(storage, false);
    expect(store.get(AMBIENCE_PREF_KEY)).toBe('off');
    expect(loadAmbiencePref(storage)).toBe(false);
    saveAmbiencePref(storage, true);
    expect(store.has(AMBIENCE_PREF_KEY)).toBe(false);
    expect(loadAmbiencePref(storage)).toBe(true);
    expect(loadAmbiencePref(null)).toBe(true);
    expect(loadAmbiencePref(undefined)).toBe(true);
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
    expect(loadAmbiencePref(broken)).toBe(true);
    expect(() => saveAmbiencePref(broken, false)).not.toThrow();
    expect(() => saveAmbiencePref(null, false)).not.toThrow();
    expect(AMBIENCE_PREF_KEY.startsWith('caelancraft:')).toBe(true);
  });
});
