// src/soundBank.js — the sounds of digging and placing, of footsteps and movement, of the animals and the zombies, and
// of the ambience (CONTRACTS §82). Nobody who wrote them could listen, so they are held to what can be measured: every
// sound is rendered by the game's own audio code on the offline renderer (tests/helpers/offlineAudio.js) and checked for
// its length, its level (no clipping, no clicks, nothing far louder than its neighbours), where its energy lies (stone
// brighter than dirt, a cow lower than a sheep) and what makes it itself (a bleat's tremolo, a howl's rise and fall, the
// clicks of gravel). The first half checks the recipes as data.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SOUND_BANK, BANK_NAMES, BANK_FAMILIES, VOICE_RECIPES, BIRD_SONGS, AMBIENCE_LOOPS, MATERIAL_ACTIONS, STEP_SPARE, AMBIENT_SPARE,
  materialSound, voicesOf, layerEnd,
} from '../../src/soundBank.js';
import { SOUND_NAMES, LAYER_TYPES, LFO_SHAPES } from '../../src/circuitSounds.js';
import { SOUND_GROUPS } from '../../src/blocks.js';
import { SPECIES, SOUNDS as ANIMAL_BASE_SOUNDS } from '../../src/animals.js';
import { createAudio, MAX_VOICES, MAX_GRAINS, MIN_GRAIN_S } from '../../src/audio.js';
import {
  OfflineContext, measure, bandShare, strongestHz, tremoloOf, pitchOf, burstsOf, renderSound,
} from '../helpers/offlineAudio.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ONE_SHOTS = BANK_NAMES.filter((n) => !AMBIENCE_LOOPS.includes(n));
/** Every recipe that is played as it stands: a recipe without variants, or each variant with its parent's settings. */
const TAKES = [];
for (const name of ONE_SHOTS) {
  const r = SOUND_BANK[name];
  if (r.variants) {
    r.variants.forEach((v, i) => TAKES.push({ label: `${name}#${i}`, name, recipe: { ...v, vary: v.vary ?? r.vary, stretch: v.stretch ?? r.stretch }, dur: v.dur }));
  } else {
    TAKES.push({ label: name, name, recipe: r, dur: r.dur });
  }
}
const TAKE = Object.fromEntries(TAKES.map((t) => [t.label, t]));
const SEEDS = [1, 2, 3];

const cache = new Map();
/** The rendering of a take (a label of TAKES) for a seed, with its measures. `still`: without the random pitch and length. */
function take(label, seed = 1, still = false) {
  const key = `${label}|${seed}|${still}`;
  if (!cache.has(key)) {
    const t = TAKE[label];
    if (!t) throw new Error(`no take ${label}`);
    const recipe = still ? { ...t.recipe, vary: 0, stretch: 0 } : t.recipe;
    const x = renderSound((audio) => audio.playRecipe(recipe, 1), { createAudio, seconds: t.dur + 0.3, seed });
    cache.set(key, { x, m: measure(x), left: OfflineContext.last.live.length });
  }
  return cache.get(key);
}
/** The mean of a measure over the seeds (loudness is averaged as power). */
function mean(label, pick) {
  return SEEDS.reduce((s, seed) => s + pick(take(label, seed).m), 0) / SEEDS.length;
}
const loud = (label) => 10 * Math.log10(SEEDS.reduce((s, seed) => s + 10 ** (take(label, seed).m.loud / 10), 0) / SEEDS.length);
const centroid = (label) => mean(label, (m) => m.centroid);
const duration = (label) => mean(label, (m) => m.duration);
const labelsOf = (name) => TAKES.filter((t) => t.name === name).map((t) => t.label);
/** The loudest and the quietest take of some names. */
const loudRange = (names) => {
  const all = names.flatMap(labelsOf).map(loud);
  return [Math.min(...all), Math.max(...all)];
};

// ---------------------------------------------------------------------------------------------------------------------
// The recipes as data
// ---------------------------------------------------------------------------------------------------------------------

const isHz = (v) => typeof v === 'number' && v > 0 && Number.isFinite(v);
const isFilter = (v) => isHz(v) || (Array.isArray(v) && v.length === 2 && v.every(isHz));
const LAYER_KEYS = ['type', 'f0', 'f1', 'lp', 'hp', 'bp', 'q', 'gain', 'delay', 'attack', 'decay', 'lfoHz', 'lfoDepth', 'lfoShape',
  'hold', 'glide', 'vibHz', 'vibDepth', 'vibShape', 'partials', 'formants', 'grains'];

function checkLayer(l, where, dur, stretch, loop) {
  expect(Object.keys(l).every((k) => LAYER_KEYS.includes(k)), `${where}: ${Object.keys(l)}`).toBe(true);
  expect(LAYER_TYPES, where).toContain(l.type);
  if (l.type === 'noise') {
    expect(l.f0, where).toBe(0);
    for (const k of ['f1', 'glide', 'vibHz', 'vibDepth', 'partials']) expect(l[k], `${where}.${k}: an oscillator's`).toBeUndefined();
  } else {
    expect(isHz(l.f0), where).toBe(true);
  }
  if (l.f1 !== undefined) expect(isHz(l.f1) && l.glide === undefined, `${where}: f1 or glide, not both`).toBe(true);
  for (const f of ['lp', 'hp', 'bp']) if (l[f] !== undefined) expect(isFilter(l[f]), `${where}.${f}`).toBe(true);
  if (l.q !== undefined) expect(l.q > 0 && l.q <= 12, where).toBe(true);
  expect(l.gain > 0 && l.gain <= 1, `${where}.gain`).toBe(true);
  for (const k of ['delay', 'attack', 'hold']) if (l[k] !== undefined) expect(l[k] >= 0 && Number.isFinite(l[k]), `${where}.${k}`).toBe(true);
  expect(l.decay > 0, `${where}.decay`).toBe(true);
  expect((l.lfoHz === undefined) === (l.lfoDepth === undefined), `${where}: lfoHz and lfoDepth together`).toBe(true);
  if (l.lfoHz !== undefined) expect(l.lfoHz > 0 && l.lfoHz <= 100 && l.lfoDepth > 0 && l.lfoDepth <= 2, `${where}.lfo`).toBe(true);
  expect((l.vibHz === undefined) === (l.vibDepth === undefined), `${where}: vibHz and vibDepth together`).toBe(true);
  if (l.vibHz !== undefined) expect(l.vibHz > 0 && l.vibHz <= 60 && l.vibDepth > 0 && l.vibDepth <= 0.35, `${where}.vib`).toBe(true);
  for (const k of ['lfoShape', 'vibShape']) if (l[k] !== undefined) expect(LFO_SHAPES, `${where}.${k}`).toContain(l[k]);
  if (l.glide !== undefined) {
    expect(Array.isArray(l.glide) && l.glide.length >= 1, `${where}.glide`).toBe(true);
    let last = 0;
    for (const p of l.glide) {
      expect(p.length === 2 && p[0] > last && p[0] <= 1 && isHz(p[1]), `${where}.glide ${p}`).toBe(true);
      last = p[0];
    }
  }
  if (l.partials !== undefined) {
    expect(l.partials.length >= 1 && l.partials.length <= 4, `${where}.partials`).toBe(true);
    for (const p of l.partials) {
      expect(p.length === 2 || p.length === 3, `${where}.partials ${p}`).toBe(true);
      expect(p[0] > 1 && p[0] <= 8 && p[1] > 0 && p[1] <= 1, `${where}.partials ${p}`).toBe(true);
      if (p.length === 3) expect(p[2] > 0 && p[2] <= 1, `${where}.partials ${p}`).toBe(true);
    }
  }
  if (l.formants !== undefined) {
    expect(l.formants.length >= 2 && l.formants.length <= 5, `${where}.formants`).toBe(true);
    for (const f of l.formants) expect(f.length === 3 && isFilter(f[0]) && f[1] > 0 && f[1] <= 8 && f[2] > 0 && f[2] <= 3, `${where}.formants ${f}`).toBe(true);
  }
  if (Array.isArray(l.grains)) {
    expect(l.grains.length >= 2 && l.grains.length <= MAX_GRAINS, `${where}.grains`).toBe(true);
    let last = -Infinity;
    for (const g of l.grains) {
      expect(g.length === 3 && g[0] >= 0 && g[1] > 0 && g[1] < 2 && g[2] > 0 && g[2] <= 1, `${where}.grains ${g}`).toBe(true);
      expect(g[0] - last, `${where}.grains: in time order, apart`).toBeGreaterThanOrEqual(MIN_GRAIN_S);
      last = g[0];
    }
    expect(Math.max(...l.grains.map((g) => g[2])), `${where}.grains: one at full gain`).toBe(1);
  } else if (l.grains !== undefined) {
    const g = l.grains;
    expect(Object.keys(g).every((k) => ['count', 'over', 'jitter', 'gainVar', 'pitchVar'].includes(k)), `${where}.grains`).toBe(true);
    const [lo, hi] = Array.isArray(g.count) ? g.count : [g.count, g.count];
    expect(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi >= lo && hi <= MAX_GRAINS, `${where}.grains.count`).toBe(true);
    expect(hi, `${where}: one strike needs no grains`).toBeGreaterThanOrEqual(2);
    expect(g.over > 0, `${where}.grains.over`).toBe(true);
    for (const k of ['jitter', 'gainVar', 'pitchVar']) if (g[k] !== undefined) expect(g[k] >= 0 && g[k] <= 1, `${where}.grains.${k}`).toBe(true);
  }
  if (loop) {
    for (const k of ['grains', 'hold', 'glide', 'delay', 'vibHz']) expect(l[k], `${where}.${k} does nothing in a loop`).toBeUndefined();
  } else {
    expect(layerEnd(l) * (1 + stretch), `${where} ends by dur`).toBeLessThanOrEqual(dur + 1e-9);
  }
}

function checkRecipe(r, where, inherited = {}) {
  const keys = Object.keys(r);
  expect(keys.every((k) => ['dur', 'gain', 'layers', 'variants', 'vary', 'stretch', 'spare'].includes(k)), `${where}: ${keys}`).toBe(true);
  expect(r.dur > 0 && Number.isFinite(r.dur), `${where}.dur`).toBe(true);
  expect(r.gain > 0 && r.gain <= 1, `${where}.gain`).toBe(true);
  if (r.vary !== undefined) expect(r.vary > 0 && r.vary <= 0.25, `${where}.vary`).toBe(true);
  if (r.stretch !== undefined) expect(r.stretch > 0 && r.stretch <= 0.2, `${where}.stretch`).toBe(true);
  if (r.spare !== undefined) expect(Number.isInteger(r.spare) && r.spare > 0 && r.spare < MAX_VOICES, `${where}.spare`).toBe(true);
  expect(Array.isArray(r.layers) !== Array.isArray(r.variants), `${where}: layers or variants`).toBe(true);
  const stretch = r.stretch ?? inherited.stretch ?? 0;
  if (r.variants) {
    expect(inherited.variant, `${where}: a variant has no variants of its own`).toBeUndefined();
    expect(r.variants.length, where).toBeGreaterThanOrEqual(2);
    expect(r.gain, `${where}: a recipe of variants leaves the gain to them`).toBe(1);
    r.variants.forEach((v, i) => checkRecipe(v, `${where}#${i}`, { stretch, variant: true }));
    expect(r.dur, `${where}.dur covers every variant`).toBe(Math.max(...r.variants.map((v) => v.dur)));
    return;
  }
  expect(r.layers.length >= 1 && r.layers.length <= 4, `${where}: one to four layers`).toBe(true);
  const loop = AMBIENCE_LOOPS.includes(where);
  r.layers.forEach((l, i) => checkLayer(l, `${where}[${i}]`, r.dur, stretch, loop));
  // dur is the layers' own length (no dead air at the end)
  if (!loop) expect(r.dur - Math.max(...r.layers.map(layerEnd)) * (1 + stretch), `${where}.dur is tight`).toBeLessThan(0.011);
}

describe('the sound bank as data (§82)', () => {
  it('holds every family: materials × actions, movement, voices, ambience; frozen; apart from the circuit sounds', () => {
    for (const g of SOUND_GROUPS) for (const a of MATERIAL_ACTIONS) expect(SOUND_BANK[materialSound(a, g)], `${a} ${g}`).toBeTruthy();
    expect(MATERIAL_ACTIONS).toEqual(['break', 'dig', 'place', 'step']);
    expect(materialSound('break', 'stone')).toBe('breakStone');
    for (const name of ['jump', 'landThud', 'swim', 'swimUnder', 'splashIn', 'splashOut', 'pigOink', 'pigSqueal', 'zombieGroan',
      'zombieHurt', 'zombieDown', 'wolfHowl', 'streamBlip', 'fireCrackle', 'cricketChirp', ...BIRD_SONGS, ...AMBIENCE_LOOPS]) {
      expect(SOUND_BANK[name], name).toBeTruthy();
    }
    expect(Object.values(BANK_FAMILIES).flat().sort()).toEqual([...BANK_NAMES].sort()); // each name under one heading
    expect(BANK_FAMILIES.materials).toHaveLength(SOUND_GROUPS.length * 3);
    expect(BANK_FAMILIES.movement.filter((n) => n.startsWith('step'))).toHaveLength(SOUND_GROUPS.length);
    for (const name of BANK_NAMES) expect(SOUND_NAMES, name).not.toContain(name);
    expect(Object.isFrozen(SOUND_BANK)).toBe(true);
    expect(Object.isFrozen(SOUND_BANK.cowMoo.variants[0].layers[0].formants[1])).toBe(true);
    expect(BIRD_SONGS.length).toBeGreaterThanOrEqual(4); // several "species"
  });

  for (const name of BANK_NAMES) {
    it(`${name} fits the recipe format`, () => {
      checkRecipe(SOUND_BANK[name], name);
    });
  }

  it('every voice animals.js names has a bank recipe, and every species\' voice is one of them', () => {
    for (const [voice, name] of Object.entries(VOICE_RECIPES)) {
      expect(ANIMAL_BASE_SOUNDS[voice], `animals.js knows ${voice}`).toBeTruthy();
      expect(SOUND_BANK[name], name).toBeTruthy();
    }
    for (const [kind, s] of Object.entries(SPECIES)) expect(VOICE_RECIPES[s.voice], `${kind}: ${s.voice}`).toBeTruthy();
    // what has no lifelike voice keeps animals.js's own sound
    expect(Object.keys(ANIMAL_BASE_SOUNDS).filter((k) => !VOICE_RECIPES[k]).sort()).toEqual(['snare', 'tame']);
  });

  it('budgets: a step takes at most 3 voices and gives way; an ambience one-shot at most 2; nothing more than 4', () => {
    for (const name of BANK_NAMES) expect(voicesOf(SOUND_BANK[name]), name).toBeLessThanOrEqual(4);
    for (const g of SOUND_GROUPS) {
      const step = SOUND_BANK[materialSound('step', g)];
      expect(voicesOf(step), g).toBeLessThanOrEqual(3);
      expect(step.spare, g).toBe(STEP_SPARE);
    }
    for (const name of ['jump', 'swim', 'swimUnder', 'splashOut']) expect(SOUND_BANK[name].spare, name).toBe(STEP_SPARE);
    for (const name of [...BIRD_SONGS, 'cricketChirp', 'streamBlip']) {
      expect(voicesOf(SOUND_BANK[name]), name).toBeLessThanOrEqual(2);
      expect(SOUND_BANK[name].spare, name).toBe(AMBIENT_SPARE);
    }
    expect(STEP_SPARE).toBeGreaterThanOrEqual(8);
    expect(AMBIENT_SPARE).toBeGreaterThanOrEqual(STEP_SPARE);
    // the sounds that matter never wait for free voices
    for (const name of [...BANK_FAMILIES.materials, 'landThud', 'splashIn', ...BANK_FAMILIES.voices, 'fireCrackle']) {
      expect(SOUND_BANK[name].spare, name).toBeUndefined();
    }
    expect(voicesOf(null)).toBe(0);
    expect(voicesOf(SOUND_BANK.pheasantCrow)).toBe(3);
  });

  it('every one-shot varies from play to play: pitch, and for the voices length and choice of variant', () => {
    for (const name of ONE_SHOTS) expect(SOUND_BANK[name].vary, name).toBeGreaterThan(0);
    for (const name of BANK_FAMILIES.voices.filter((n) => !['rabbitThump', 'fishPlop', 'zombieHurt', 'zombieDown'].includes(n))) {
      expect(SOUND_BANK[name].stretch, name).toBeGreaterThan(0);
    }
    for (const name of ['pigOink', 'cowMoo', 'sheepBaa', 'horseNeigh', 'wolfBark', 'wolfHowl', 'deerBark', 'rabbitThump', 'turkeyGobble',
      'zombieGroan', 'fireCrackle', 'birdTit', 'birdBlackbird', 'cricketChirp']) {
      expect(SOUND_BANK[name].variants.length, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('soundBank.js is pure data: no imports, no DOM, no clock, no randomness', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/soundBank.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|document\.|window\.|AudioContext/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The recipes as sound
// ---------------------------------------------------------------------------------------------------------------------

describe('every bank sound, rendered (§82)', () => {
  for (const t of TAKES) {
    it(`${t.label}: audible, within its length, no clipping, no click, no offset, not all bass`, () => {
      for (const seed of SEEDS) {
        const { m, left } = take(t.label, seed);
        const at = `${t.label} seed ${seed}`;
        expect(m.peak, `${at}: audible`).toBeGreaterThan(0.004);
        expect(m.peak, `${at}: half of full scale at most (two at once do not clip)`).toBeLessThanOrEqual(0.5);
        expect(m.silentAfter, `${at}: over by dur`).toBeLessThanOrEqual(t.dur + 0.005);
        expect(left, `${at}: every voice ended`).toBe(0);
        expect(m.duration, `${at}: not a mere tick`).toBeGreaterThan(0.012);
        expect(m.tail, `${at}: dies away, is not cut off`).toBeLessThan(0.05);
        expect(m.dc, `${at}: no DC offset`).toBeLessThan(0.3);
        expect(m.lowShare, `${at}: something above 150 Hz for small speakers`).toBeLessThan(0.8);
        expect(Number.isFinite(m.loud) && Number.isFinite(m.centroid), at).toBe(true);
      }
    });
  }

  it('two plays of one sound are never the same samples, and never far apart in loudness', () => {
    for (const t of TAKES) {
      const louds = SEEDS.map((seed) => take(t.label, seed).m.loud);
      expect(Math.max(...louds) - Math.min(...louds), t.label).toBeLessThan(6);
      expect(Buffer.from(take(t.label, 1).x.buffer).equals(Buffer.from(take(t.label, 2).x.buffer)), t.label).toBe(false);
    }
  });

  it('the random pitch stays within `vary`: a stone\'s ring moves by no more than 8 %', () => {
    const still = strongestHz(take('breakWood', 1, true).m, 150, 400);
    for (const seed of SEEDS) {
      const hz = strongestHz(take('breakWood', seed).m, 150, 400);
      expect(Math.abs(hz / still - 1), `seed ${seed}`).toBeLessThanOrEqual(SOUND_BANK.breakWood.vary + 0.06); // + one FFT bin
    }
  });
});

describe('levels: nothing far louder than its neighbours (§82)', () => {
  it('breaking: every material within 9 dB of the others, between the old burst\'s quietest and a little over its loudest', () => {
    const [lo, hi] = loudRange(SOUND_GROUPS.map((g) => materialSound('break', g)));
    expect(hi - lo).toBeLessThan(9);
    expect(lo).toBeGreaterThan(-35);
    expect(hi).toBeLessThan(-21);
  });

  it('a dig tick and a place are a little under their material\'s break; at main\'s 0.35 a dig is well under it', () => {
    for (const g of SOUND_GROUPS) {
      const brk = loud(materialSound('break', g));
      const dig = loud(materialSound('dig', g));
      const place = loud(materialSound('place', g));
      expect(dig, g).toBeLessThan(brk - 1);
      expect(dig, g).toBeGreaterThan(brk - 7);
      expect(place, g).toBeLessThan(brk - 1);
      expect(place, g).toBeGreaterThan(brk - 7);
      expect(dig + 20 * Math.log10(0.35), g).toBeLessThan(brk - 9);
    }
  });

  it('a step is much quieter than a break of the same ground (at least 8 dB), and steps are within 9 dB of each other', () => {
    for (const g of SOUND_GROUPS) {
      expect(loud(materialSound('step', g)), g).toBeLessThan(loud(materialSound('break', g)) - 8);
      expect(loud(materialSound('step', g)), g).toBeGreaterThan(-48); // still to be heard
    }
    const [lo, hi] = loudRange(SOUND_GROUPS.map((g) => materialSound('step', g)));
    expect(hi - lo).toBeLessThan(9);
  });

  it('movement: a jump is the faintest, strokes and wading sit under a landing, the splash is the loudest', () => {
    expect(loud('jump')).toBeLessThan(loud('stepStone'));
    expect(loud('stepWater')).toBeLessThan(loud('landThud') - 3);
    expect(loud('swim')).toBeLessThan(loud('landThud') - 3);
    expect(loud('swimUnder')).toBeLessThan(loud('swim'));
    expect(loud('splashIn')).toBeGreaterThan(loud('landThud') + 3);
    expect(loud('splashIn')).toBeLessThan(-22);
    expect(loud('splashOut')).toBeLessThan(loud('splashIn') - 6);
  });

  it('voices: within 14 dB of each other, none above the loudest of the old calls; the roar loudest, the rabbit softest', () => {
    const [lo, hi] = loudRange(BANK_FAMILIES.voices);
    expect(hi - lo).toBeLessThan(14);
    expect(hi).toBeLessThan(-22);
    expect(lo).toBeGreaterThan(-39);
    const loudest = BANK_FAMILIES.voices.flatMap(labelsOf).reduce((a, b) => (loud(a) > loud(b) ? a : b));
    expect(loudest).toBe('bearRoar');
    for (const l of labelsOf('rabbitThump')) expect(loud(l)).toBeLessThan(loud('cowMoo#0') - 6);
    expect(loud('bearGrowl')).toBeGreaterThan(loud('bearGrunt') + 1.5);
    expect(loud('bearRoar')).toBeGreaterThan(loud('bearGrowl') + 1.5);
  });

  it('zombies are soft: every zombie sound under the wolf\'s bark and the bear\'s growl', () => {
    for (const l of [...labelsOf('zombieGroan'), 'zombieHurt', 'zombieDown']) {
      expect(loud(l), l).toBeLessThan(loud('wolfBark#0') - 3);
      expect(loud(l), l).toBeLessThan(loud('bearGrowl') - 2);
      expect(loud(l), l).toBeGreaterThan(-36);
    }
  });

  it('ambience sits clearly below the effects: birds, crickets and bubbles at least 6 dB under the quietest break', () => {
    const [quietestBreak, loudestBreak] = loudRange(SOUND_GROUPS.map((g) => materialSound('break', g)));
    for (const l of [...BIRD_SONGS.flatMap(labelsOf), ...labelsOf('cricketChirp'), 'streamBlip']) {
      expect(loud(l), l).toBeLessThan(quietestBreak - 6);
      expect(loud(l), l).toBeLessThan(loudestBreak - 12);
      expect(loud(l), l).toBeGreaterThan(-48);
    }
    for (const l of labelsOf('cricketChirp')) expect(loud(l), l).toBeLessThan(loud('birdTit#0') - 2);
    // the campfire's crackle is an effect of its own, as loud as it was
    const [lo, hi] = loudRange(['fireCrackle']);
    expect(lo).toBeGreaterThan(-38);
    expect(hi).toBeLessThan(-30);
  });
});

describe('materials: each has its own character (§82)', () => {
  it('hard things are bright, soft ground is dull: glass > stone > wood, stone well above dirt, cloth and dirt lowest', () => {
    for (const a of ['break', 'dig']) {
      const c = (g) => centroid(materialSound(a, g));
      expect(c('glass'), a).toBeGreaterThan(c('stone') * 1.2);
      expect(c('stone'), a).toBeGreaterThan(c('wood') * 2);
      expect(c('stone'), a).toBeGreaterThan(c('dirt') * 1.5);
      expect(c('dirt'), a).toBeLessThan(1200);
      expect(c('wood'), a).toBeLessThan(700);
    }
    expect(centroid('breakCloth')).toBeLessThan(1400);
    expect(centroid('placeDirt')).toBeLessThan(600);
    expect(centroid('placeCloth')).toBeLessThan(900);
  });

  it('stone: its modes lie between 1 and 4 kHz and are gone in a quarter of a second', () => {
    for (const seed of SEEDS) {
      const { m } = take('breakStone', seed);
      expect(bandShare(m, 900, 4500)).toBeGreaterThan(0.6);
      expect(m.duration).toBeLessThan(0.27);
    }
    const dig = take('digStone', 1, true).m;
    expect(strongestHz(dig, 500, 6000)).toBeGreaterThan(1000);
    expect(strongestHz(dig, 500, 6000)).toBeLessThan(4000);
    expect(dig.duration).toBeLessThan(0.1);
  });

  it('wood: a knock whose modes lie between 200 and 900 Hz, with a quick decay', () => {
    for (const label of ['breakWood', 'digWood', 'placeWood']) {
      const { m } = take(label, 1, true);
      const hz = strongestHz(m, 60, 6000);
      expect(hz, label).toBeGreaterThanOrEqual(170);
      expect(hz, label).toBeLessThan(900);
      expect(bandShare(m, 150, 1100), label).toBeGreaterThan(0.75);
      expect(m.duration, label).toBeLessThan(0.14);
    }
  });

  it('glass: high ringing modes with a longer tail than stone, and shards', () => {
    for (const seed of SEEDS) {
      const glass = take('breakGlass', seed).m;
      expect(bandShare(glass, 1800, 8000)).toBeGreaterThan(0.85);
      expect(glass.duration).toBeGreaterThan(take('breakStone', seed).m.duration * 1.3);
      expect(glass.duration).toBeLessThan(0.45);
    }
    expect(duration('digGlass')).toBeGreaterThan(duration('digStone') * 1.3); // it rings
    expect(strongestHz(take('breakGlass', 1, true).m, 500, 9000)).toBeGreaterThan(2000);
  });

  it('sand hisses and dies away slowly; leaves rustle between 2 and 6 kHz', () => {
    expect(centroid('breakSand')).toBeGreaterThan(2500);
    expect(centroid('breakSand')).toBeLessThan(6000);
    expect(duration('breakSand')).toBeGreaterThan(duration('breakDirt'));
    expect(duration('breakSand')).toBeGreaterThan(0.18);
    for (const a of MATERIAL_ACTIONS) {
      const c = centroid(materialSound(a, 'leaves'));
      expect(c, a).toBeGreaterThan(2000);
      expect(c, a).toBeLessThan(6000);
    }
    for (const seed of SEEDS) expect(bandShare(take('breakLeaves', seed).m, 1500, 7000)).toBeGreaterThan(0.85);
    expect(centroid('stepGrass')).toBeGreaterThan(centroid('stepDirt') * 1.5); // the blades over the thud
  });

  it('gravel is several tiny clicks scattered over 80–170 ms; snow a crunch in a few grains', () => {
    for (const seed of SEEDS) {
      const still = renderSound((audio) => audio.playRecipe({ dur: 0.3, gain: 1, layers: [SOUND_BANK.breakGravel.layers[0]] }, 1), { createAudio, seconds: 0.4, seed });
      const clicks = burstsOf(still, 0.2);
      expect(clicks.length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
      expect(clicks[clicks.length - 1] - clicks[0]).toBeGreaterThan(0.06);
      expect(clicks[clicks.length - 1] - clicks[0]).toBeLessThan(0.18);
      const crunch = renderSound((audio) => audio.playRecipe({ dur: 0.3, gain: 1, layers: [SOUND_BANK.breakSnow.layers[0]] }, 1), { createAudio, seconds: 0.4, seed });
      expect(burstsOf(crunch, 0.25, 0.004).length, `snow seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
    expect(centroid('breakSnow')).toBeGreaterThan(1000);
    expect(centroid('breakSnow')).toBeLessThan(3200);
    expect(centroid('breakGravel')).toBeGreaterThan(centroid('breakDirt') * 1.5);
  });

  it('water: a rising bloop when it is taken, a falling plop when it is poured', () => {
    const scoop = take('breakWater', 1, true).x;
    const m = take('breakWater', 1, true).m;
    expect(pitchOf(scoop, m.start + 0.045, 150, 1200, 0.03)).toBeGreaterThan(pitchOf(scoop, m.start + 0.012, 150, 1200, 0.03) * 1.1);
    const pour = take('placeWater', 1, true);
    expect(pitchOf(pour.x, pour.m.start + 0.012, 100, 1200, 0.03)).toBeGreaterThan(pitchOf(pour.x, pour.m.start + 0.05, 100, 1200, 0.03) * 1.1);
  });

  it('the public methods play them: playBreak, playDig and playPlace by sound group (unknown groups as stone)', () => {
    const same = (a, b) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));
    const opts = { createAudio, seconds: 0.5, seed: 5 };
    for (const g of ['stone', 'glass', 'sand']) {
      expect(same(renderSound((au) => au.playBreak(g), opts), renderSound((au) => au.playRecipe(`break${cap(g)}`, 1), opts)), g).toBe(true);
      expect(same(renderSound((au) => au.playPlace(g), opts), renderSound((au) => au.playRecipe(`place${cap(g)}`, 1), opts)), g).toBe(true);
      expect(same(renderSound((au) => au.playDig(g, 0.35), opts), renderSound((au) => au.playRecipe(`dig${cap(g)}`, 0.35), opts)), g).toBe(true);
    }
    for (const g of [null, undefined, 'no-such-group']) {
      expect(same(renderSound((au) => au.playBreak(g), opts), renderSound((au) => au.playBreak('stone'), opts)), String(g)).toBe(true);
      expect(same(renderSound((au) => au.playDig(g, 1), opts), renderSound((au) => au.playDig('stone', 1), opts)), String(g)).toBe(true);
    }
    expect(same(renderSound((au) => au.playBreak('stone'), opts), renderSound((au) => au.playBreak('dirt'), opts))).toBe(false);
  });
});

describe('movement sounds (§82)', () => {
  it('a landing is a low thump; a step on stone is a bright tap; the stroke under water is muffled', () => {
    expect(centroid('landThud')).toBeLessThan(600);
    expect(centroid('stepStone')).toBeGreaterThan(centroid('landThud') * 3);
    expect(centroid('swimUnder')).toBeLessThan(centroid('swim') * 0.5);
    expect(centroid('stepWood')).toBeLessThan(400); // a hollow knock
  });

  it('a step is short (under 0.2 s) so two a second never run together; a stroke and a splash take their time', () => {
    for (const g of SOUND_GROUPS.filter((x) => x !== 'water')) expect(SOUND_BANK[materialSound('step', g)].dur, g).toBeLessThan(0.2);
    expect(duration('swim')).toBeGreaterThan(0.25);
    expect(duration('splashIn')).toBeGreaterThan(0.3);
    expect(SOUND_BANK.stepWater.dur).toBeLessThan(0.3); // a wade is slower: one a second
  });
});

describe('voices: each animal is itself (§82)', () => {
  /** The pitch at a part (0..1) of a take's effective duration, without the random pitch. */
  const pitchAt = (label, part, fMin, fMax, windowS) => {
    const { x, m } = take(label, 1, true);
    return pitchOf(x, m.start + part * m.duration, fMin, fMax, windowS);
  };

  it('a cow\'s moo: 85–135 Hz, a second or more, steady; lower and longer than a sheep', () => {
    for (const l of labelsOf('cowMoo')) {
      for (const part of [0.15, 0.5, 0.85]) {
        const hz = pitchAt(l, part, 60, 220);
        expect(hz, `${l} at ${part}`).toBeGreaterThan(84);
        expect(hz, `${l} at ${part}`).toBeLessThan(136);
      }
      expect(take(l, 1, true).m.duration, l).toBeGreaterThan(0.9);
      expect(tremoloOf(take(l, 1, true).x, 6, 14).depth, `${l}: no bleat`).toBeLessThan(0.25);
      expect(centroid(l), l).toBeLessThan(centroid('sheepBaa#0') * 0.7);
    }
    expect(pitchAt('cowMoo#0', 0.5, 60, 220)).toBeLessThan(pitchAt('sheepBaa#0', 0.5, 150, 600) * 0.5);
    expect(pitchAt('cowMoo#0', 0.3, 60, 220)).toBeGreaterThan(pitchAt('cowMoo#0', 0.95, 60, 220)); // it sags at the end
  });

  it('a sheep\'s bleat: about 300 Hz with a strong 8–12 Hz tremolo', () => {
    for (const l of labelsOf('sheepBaa')) {
      const hz = pitchAt(l, 0.5, 150, 600);
      expect(hz, l).toBeGreaterThan(230);
      expect(hz, l).toBeLessThan(400);
      const tr = tremoloOf(take(l, 1, true).x, 5, 16);
      expect(tr.hz, l).toBeGreaterThanOrEqual(7.5);
      expect(tr.hz, l).toBeLessThanOrEqual(12.5);
      expect(tr.depth, l).toBeGreaterThan(0.45);
    }
  });

  it('a horse: a whinny whose pitch falls by more than an octave with a fast vibrato; a snort and a nicker far lower', () => {
    const hi = pitchAt('horseNeigh#0', 0.12, 200, 2200);
    const lo = pitchAt('horseNeigh#0', 0.88, 200, 2200);
    expect(hi).toBeGreaterThan(lo * 2);
    expect(hi).toBeGreaterThan(1100);
    const tr = tremoloOf(take('horseNeigh#0', 1, true).x, 8, 20);
    expect(tr.hz).toBeGreaterThan(10);
    expect(tr.hz).toBeLessThan(14);
    expect(tr.depth).toBeGreaterThan(0.25);
    expect(duration('horseNeigh#0')).toBeGreaterThan(1);
    expect(centroid('horseNeigh#1')).toBeLessThan(centroid('horseNeigh#0'));
    expect(centroid('horseNeigh#2')).toBeLessThan(centroid('horseNeigh#0') * 0.4);
    expect(tremoloOf(take('horseNeigh#1', 1, true).x, 15, 40).depth).toBeGreaterThan(0.4); // the flutter of the lips
  });

  it('a wolf: the howl is far longer than the bark, rises, holds and falls, with a slight vibrato', () => {
    for (const l of labelsOf('wolfHowl')) {
      expect(take(l, 1, true).m.duration, l).toBeGreaterThan(1.8);
      const early = pitchAt(l, 0.04, 150, 800);
      const mid = pitchAt(l, 0.5, 150, 800);
      const late = pitchAt(l, 0.97, 150, 800);
      expect(mid, l).toBeGreaterThan(early * 1.2);
      expect(mid, l).toBeGreaterThan(late * 1.12);
      expect(mid, l).toBeGreaterThan(400);
      expect(mid, l).toBeLessThan(560);
    }
    for (const l of labelsOf('wolfBark')) {
      expect(take(l, 1, true).m.duration, l).toBeLessThan(0.45);
      expect(take('wolfHowl#0', 1, true).m.duration).toBeGreaterThan(take(l, 1, true).m.duration * 5);
    }
    expect(burstsOf(take('wolfBark#0', 1, true).x, 0.3, 0.012)).toHaveLength(1);
    expect(burstsOf(take('wolfBark#1', 1, true).x, 0.3, 0.012)).toHaveLength(2);
    expect(pitchAt('wolfBark#0', 0.15, 100, 600)).toBeGreaterThan(pitchAt('wolfBark#0', 0.85, 100, 600) * 1.4); // it falls
  });

  it('a deer\'s bark is short; a rabbit thumps twice; a pheasant crows two notes, the second higher', () => {
    expect(take('deerBark#0', 1, true).m.duration).toBeLessThan(0.3);
    expect(centroid('deerBark#0')).toBeGreaterThan(centroid('cowMoo#0') * 2);
    expect(burstsOf(take('rabbitThump#0', 1, true).x, 0.3, 0.006)).toHaveLength(2);
    expect(centroid('rabbitThump#0')).toBeLessThan(700);
    const crow = take('pheasantCrow', 1, true);
    const notes = burstsOf(crow.x, 0.35, 0.012);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes[1] - notes[0]).toBeCloseTo(0.2, 1);
    const first = pitchOf(crow.x, notes[0] + 0.03, 400, 1200, 0.04);
    const second = pitchOf(crow.x, notes[1] + 0.015, 400, 1200, 0.04);
    expect(second).toBeGreaterThan(first * 1.15);
  });

  it('a turkey\'s gobble: a fast amplitude wobble on a falling pitch', () => {
    const tr = tremoloOf(take('turkeyGobble#0', 1, true).x, 8, 20);
    expect(tr.hz).toBeGreaterThan(11);
    expect(tr.hz).toBeLessThan(15);
    expect(tr.depth).toBeGreaterThan(0.5);
    expect(pitchAt('turkeyGobble#0', 0.12, 250, 900)).toBeGreaterThan(pitchAt('turkeyGobble#0', 0.88, 250, 900) * 1.4);
  });

  it('a bear\'s growl: low (60–95 Hz), rough, over a second; the roar higher and brighter', () => {
    for (const part of [0.2, 0.5, 0.8]) {
      const hz = pitchAt('bearGrowl', part, 45, 160);
      expect(hz).toBeGreaterThan(60);
      expect(hz).toBeLessThan(95);
    }
    const rough = tremoloOf(take('bearGrowl', 1, true).x, 15, 35);
    expect(rough.depth).toBeGreaterThan(0.25);
    expect(take('bearGrowl', 1, true).m.duration).toBeGreaterThan(1);
    expect(centroid('bearGrowl')).toBeLessThan(320);
    expect(centroid('bearRoar')).toBeGreaterThan(centroid('bearGrowl') * 1.3);
    expect(pitchAt('bearRoar', 0.25, 60, 260)).toBeGreaterThan(pitchAt('bearGrowl', 0.25, 45, 160) * 1.5);
  });

  it('a pig grunts in short nasal bursts (two, three, or one long snuffle) and squeals up and down when hit', () => {
    expect(burstsOf(take('pigOink#0', 1, true).x, 0.3, 0.03)).toHaveLength(2);
    expect(burstsOf(take('pigOink#1', 1, true).x, 0.3, 0.03)).toHaveLength(3);
    expect(burstsOf(take('pigOink#2', 1, true).x, 0.3, 0.03)).toHaveLength(1);
    for (const l of labelsOf('pigOink')) {
      expect(take(l, 1, true).m.duration, l).toBeLessThan(0.4);
      expect(bandShare(take(l, 1, true).m, 700, 1400), `${l}: nasal`).toBeGreaterThan(0.12);
    }
    const up = pitchAt('pigSqueal', 0.35, 400, 1400);
    expect(up).toBeGreaterThan(pitchAt('pigSqueal', 0.05, 400, 1400) * 1.15);
    expect(up).toBeGreaterThan(pitchAt('pigSqueal', 0.92, 400, 1400) * 1.2);
  });

  it('a zombie\'s groan: a low (75–110 Hz), muffled, breathy "uhh" of about a second that comes in slowly and sags', () => {
    for (const l of labelsOf('zombieGroan')) {
      const { x, m } = take(l, 1, true);
      const hz = pitchAt(l, 0.5, 50, 180);
      expect(hz, l).toBeGreaterThan(75);
      expect(hz, l).toBeLessThan(110);
      expect(pitchAt(l, 0.9, 50, 180), `${l}: it sags`).toBeLessThan(pitchAt(l, 0.3, 50, 180));
      expect(m.duration, l).toBeGreaterThan(0.65);
      expect(m.duration, l).toBeLessThan(1.5);
      expect(m.centroid, `${l}: muffled`).toBeLessThan(600);
      expect(bandShare(m, 2500, 20000), `${l}: no snarl`).toBeLessThan(0.02);
      // not startling: a tenth of a second in, it has not yet reached half its level
      const early = Math.max(...x.slice(Math.round(m.start * 44100), Math.round((m.start + 0.06) * 44100)).map(Math.abs));
      expect(early, `${l}: a slow onset`).toBeLessThan(m.peak * 0.5);
    }
    expect(take('zombieHurt', 1, true).m.duration).toBeLessThan(0.25);
    const down = take('zombieDown', 1, true);
    expect(pitchOf(down.x, down.m.start + 0.08, 40, 200)).toBeGreaterThan(pitchOf(down.x, down.m.start + 0.45, 40, 200) * 1.3); // "ohh", falling
  });

  it('wings beat about 19 times a second; a fish plops downward', () => {
    const tr = tremoloOf(take('wingFlush', 1, true).x, 12, 26);
    expect(tr.hz).toBeGreaterThan(16);
    expect(tr.hz).toBeLessThan(22);
    expect(tr.depth).toBeGreaterThan(0.4);
    const plop = take('fishPlop', 1, true);
    expect(pitchOf(plop.x, plop.m.start + 0.005, 150, 800, 0.02)).toBeGreaterThan(pitchOf(plop.x, plop.m.start + 0.06, 150, 800, 0.02) * 1.3);
  });

  it('the old methods play them: the pig, the zombies and the campfire\'s crackle', () => {
    const opts = { createAudio, seconds: 1.8, seed: 6 };
    const same = (a, b) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));
    for (const [method, name] of [['playOink', 'pigOink'], ['playSqueal', 'pigSqueal'], ['playGroan', 'zombieGroan'],
      ['playZombieHurt', 'zombieHurt'], ['playZombieDown', 'zombieDown'], ['playCrackle', 'fireCrackle']]) {
      expect(same(renderSound((au) => au[method](0.8), opts), renderSound((au) => au.playRecipe(name, 0.8), opts)), method).toBe(true);
      expect(measure(renderSound((au) => au[method](), opts)).peak, method).toBeGreaterThan(0.01);
    }
  });
});

describe('ambience sounds (§82)', () => {
  /** A loop at a volume and a rate, rendered for some seconds (after half a second to settle). */
  const loop = (name, volume = 1, rate = 1, seconds = 6) => {
    const x = renderSound((audio) => audio.startLoop(name).set(volume, rate), { createAudio, seconds: seconds + 0.5, seed: 2 });
    return x.slice(Math.round(0.5 * 44100));
  };

  it('the loops are steady, quiet and never silent: every second within 8 dB of the others', () => {
    for (const name of AMBIENCE_LOOPS) {
      const x = loop(name, 1, 1, 12);
      const m = measure(x);
      expect(m.peak, name).toBeLessThan(0.15);
      expect(m.dc, name).toBeLessThan(0.05);
      const seconds = [];
      for (let s = 0; s + 44100 <= x.length; s += 44100) seconds.push(measure(x.slice(s, s + 44100)).level);
      expect(Math.min(...seconds), name).toBeGreaterThan(-60);
      expect(Math.max(...seconds) - Math.min(...seconds), name).toBeLessThan(8);
    }
  });

  it('at full level each loop is at least 5 dB under the quietest break; half the level is 6 dB less', () => {
    const [quietestBreak] = loudRange(SOUND_GROUPS.map((g) => materialSound('break', g)));
    for (const name of AMBIENCE_LOOPS) {
      const full = measure(loop(name)).level;
      expect(full, name).toBeLessThan(quietestBreak - 5);
      expect(full, name).toBeGreaterThan(-50);
      expect(full - measure(loop(name, 0.5)).level, name).toBeCloseTo(6.02, 0);
    }
  });

  it('wind is a low rush, the stream a bright babble, the fire a low flutter with a hiss; the rate moves the wind\'s bands', () => {
    const wind = measure(loop('ambWind'));
    const stream = measure(loop('ambStream'));
    const fire = measure(loop('ambFire'));
    expect(wind.centroid).toBeLessThan(1000);
    expect(stream.centroid).toBeGreaterThan(1500);
    expect(stream.centroid).toBeLessThan(4000);
    expect(stream.centroid).toBeGreaterThan(wind.centroid * 2);
    expect(bandShare(fire, 0, 400)).toBeGreaterThan(0.3);
    expect(bandShare(fire, 2500, 8000)).toBeGreaterThan(0.01);
    expect(measure(loop('ambWind', 1, 1.3)).centroid).toBeGreaterThan(measure(loop('ambWind', 1, 0.85)).centroid * 1.25);
    // the stream bubbles: its level swings several times a second; the wind's does not
    expect(tremoloOf(loop('ambStream', 1, 1, 3), 2, 12).depth).toBeGreaterThan(tremoloOf(loop('ambWind', 1, 1, 3), 2, 12).depth);
  });

  it('birds sing between 2 and 6 kHz in separate notes (the dove coos far lower); each kind has its own phrase', () => {
    const notes = { 'birdTit#0': 4, 'birdTit#1': 6, birdWarbler: 8, 'birdBlackbird#0': 5, 'birdBlackbird#1': 4, 'birdBlackbird#2': 5, birdDove: 5 };
    for (const [l, n] of Object.entries(notes)) expect(burstsOf(take(l, 1, true).x, 0.3, 0.004), l).toHaveLength(n);
    for (const l of BIRD_SONGS.filter((n) => n !== 'birdDove').flatMap(labelsOf)) {
      expect(centroid(l), l).toBeGreaterThan(2000);
      expect(centroid(l), l).toBeLessThan(6000);
      expect(take(l, 1, true).m.duration, l).toBeLessThan(1.3);
    }
    expect(centroid('birdDove')).toBeLessThan(700);
    // the tit see-saws between two notes; the warbler runs down
    const tit = take('birdTit#0', 1, true);
    const starts = burstsOf(tit.x, 0.3, 0.004);
    const pitches = starts.map((t) => pitchOf(tit.x, t + 0.02, 2000, 6000, 0.03));
    expect(pitches[0]).toBeGreaterThan(pitches[1] * 1.2);
    expect(pitches[2]).toBeGreaterThan(pitches[3] * 1.2);
    expect(pitches[0]).toBeCloseTo(pitches[2], -2);
    const warbler = take('birdWarbler', 1, true);
    const run = burstsOf(warbler.x, 0.3, 0.004).map((t) => pitchOf(warbler.x, t + 0.008, 2000, 7000, 0.02));
    for (let i = 1; i < run.length; i++) expect(run[i], `note ${i}`).toBeLessThan(run[i - 1]);
  });

  it('a cricket chirps three or four pulses of a tone near 4.6 kHz, about 30 a second', () => {
    for (const [l, n] of [['cricketChirp#0', 3], ['cricketChirp#1', 4]]) {
      const { x, m } = take(l, 1, true);
      const pulses = burstsOf(x, 0.3);
      expect(pulses, l).toHaveLength(n);
      expect(pulses[1] - pulses[0], l).toBeCloseTo(1 / 30, 2);
      expect(strongestHz(m, 1000, 10000), l).toBeGreaterThan(4000);
      expect(strongestHz(m, 1000, 10000), l).toBeLessThan(5000);
      expect(m.duration, l).toBeLessThan(0.15);
    }
  });

  it('the fire crackles four ways, all short and bright; a stream bubble is a short rising blip', () => {
    expect(labelsOf('fireCrackle')).toHaveLength(4);
    for (const l of labelsOf('fireCrackle')) expect(take(l, 1, true).m.duration, l).toBeLessThan(0.2);
    expect(centroid('fireCrackle#0')).toBeGreaterThan(2500);
    expect(centroid('fireCrackle#1')).toBeLessThan(centroid('fireCrackle#0')); // the pop with a knock
    for (const seed of SEEDS) expect(take('streamBlip', seed).m.duration).toBeLessThan(0.2);
  });
});
