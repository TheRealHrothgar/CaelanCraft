// Sleep (CONTRACTS §87): tiredness as part of the body (vitals.js, survival.js, storage.js), sleep spots, lying down,
// a sleep and every reason to wake (sleep.js Sleep), the secure place (secureAt, SecureWatch), the night attack (its
// chance by the light, and where the zombies come up: only where zombies.js lets one), what a body awake too long sees
// and hears (TiredFx, phantomRenderer.js), the HUD's reading and overlay (hud.js), the two sounds (soundBank.js), and
// the wiring of all of it in main.js and the debug handle — read from the source, because main needs a browser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { BLOCK, BIOME, isSolid } from '../../src/blocks.js';
import { DAY_LENGTH_SECONDS, ZOMBIE_MAX, TORCH_LIGHT, CAMPFIRE_LIGHT, STAT_MAX } from '../../src/config.js';
import {
  RATES, GAME_HOUR_S, TIRED_AT, EXHAUSTED_AT, WEAK_AT, DELIRIOUS_AT, FATIGUE_MAX, FATIGUE_STAGES, FATIGUE_FROM, WEAK_MOVE, WEAK_DIG,
  WEAK_STRIKE, SLEEP_DRAIN, WAKE_MAX_FATIGUE, fatigueStage, digFactorOf, strikeFactorOf, createVitals, wakeVitals, statusOf, stepVitals,
} from '../../src/vitals.js';
import { Survival } from '../../src/survival.js';
import { normalizeSurvivalJSON, SURVIVAL_STATS, SURVIVAL_STATS_OPTIONAL } from '../../src/storage.js';
import {
  SPOT_ROWS, SPOTS, sleepSpots, spotOf, isSleepSpot, spotHint, SLEEP_MIN_FATIGUE, SLEEP_RATE, SLEEP_FADE_S, WAKE_FADE_S, SLEEP_MAX_H,
  SLEEP_FULL_H, SLEEP_TICKS_PER_FRAME, SLEEP_FRAME_BUDGET_MS, SLEEP_ZOMBIE_NEAR, SLEEP_LINES, STAGE_LINES, stageNews, sleepRefusal,
  wakeReason, sleptText, wakeLine, sleepingLine, sleepDark, Sleep, SECURE_RADIUS, SECURE_RISE, SECURE_MAX_CELLS, SECURE_REASONS,
  SECURE_WATCH, secureAt, secureWords, SecureWatch, NIGHT_ATTACK_P, LIGHT_GUARD, LIGHT_GUARD_FULL, ATTACK_MIN, ATTACK_MAX, ATTACK_PAIR,
  ATTACK_PAIR_P, ATTACK_RUNNER_P, nightAttackChance, rollNightAttack, placeNightAttack, YAWN_EVERY_S, YAWN_VOLUME, BLUR_PX, BLUR_WAVE_S,
  BLUR_FLOOR, PHANTOM_SOUND_EVERY_S, PHANTOM_SOUNDS, PHANTOM_SOUNDS_CALM, FIGURE_EVERY_S, FIGURE_MIN, FIGURE_MAX, FIGURE_SIDE, FIGURE_LOOK, FIGURE_NEARER,
  FIGURE_S, FIGURE_IN_S, FIGURE_ALPHA, FIGURE_HEIGHT, NOD_EVERY_S, NOD_S, NOD_EDGE_S, blurPx, nodDark, figureAlpha, angleFromView, TiredFx,
  phantomStandAt, tirednessView, TIRED_BAR_FULL, TIRED_BAR_MARKS,
} from '../../src/sleep.js';
import { createPhantomRenderer, PHANTOM_PARTS, PHANTOM_COLOR, PHANTOM_HEIGHT } from '../../src/phantomRenderer.js';
import { Zombies, CLIMB, RUNNER_P, ZOMBIE_SPAWN_LIGHT_MAX, spawnChance } from '../../src/zombies.js';
import { columnHasEdits } from '../../src/blackholes.js';
import { interactKind, HINT } from '../../src/survivalControl.js';
import { createPlayer } from '../../src/physics.js';
import { advanceTime, isDayTime, SUNRISE, SUNSET } from '../../src/daynight.js';
import { hexLength, hexToWorld, worldToHex } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { createHUD, chipKind, tirednessKey, blurStep, BLUR_STEP_PX, BLUR_TARGET_ID } from '../../src/hud.js';
import { installDebugHandle, sleepDebugLine } from '../../src/diagnostics.js';
import { SOUND_BANK, BANK_FAMILIES, STEP_SPARE, voicesOf } from '../../src/soundBank.js';
import { SOUND_SECTIONS } from '../../src/soundTest.js';
import { createAudio } from '../../src/audio.js';
import { measure, renderSound, bandShare } from '../helpers/offlineAudio.js';
import { makeFakeWorld } from '../helpers/fixtures.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const B = BLOCK;
const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');
const HOUR = GAME_HOUR_S;
/** The three sleep spots as they will be once the two beds are registered (an injected block table). */
const ALL_SPOTS = sleepSpots({ GRASS_BED: 250, SLEEPING_HIDE: B.SLEEPING_HIDE, BED: 251 });
const [GRASS_BED, HIDE, BED] = ALL_SPOTS;
const clock = (h, m = 0) => (h + m / 60) / 24;

/** A body with these stats, comfortable otherwise. */
const body = (over = {}) => Object.assign(createVitals(), over);
/** One step of a body at rest in mild air. */
const rest = (v, dt, extra = {}) => stepVitals(v, dt, { activity: RATES.ACTIVITY_STILL, felt: 20, still: true, ...extra });

// ---------------------------------------------------------------------------------------------------------------------
// Tiredness
// ---------------------------------------------------------------------------------------------------------------------

describe('tiredness: a part of the body (vitals.js)', () => {
  it('the numbers: Tired from 20 hours awake, Exhausted 32, Weak 40, Seeing things 48, never more than 72', () => {
    expect([TIRED_AT, EXHAUSTED_AT, WEAK_AT, DELIRIOUS_AT, FATIGUE_MAX]).toEqual([20, 32, 40, 48, 72]);
    expect(EXHAUSTED_AT - TIRED_AT).toBe(12); // "a sleep deficit longer than 12 hours"
    expect(FATIGUE_STAGES).toEqual(['', 'Tired', 'Exhausted', 'Weak', 'Seeing things']);
    expect(FATIGUE_FROM).toEqual([0, 20, 32, 40, 48]);
    expect(GAME_HOUR_S).toBe(DAY_LENGTH_SECONDS / 24);
    expect(GAME_HOUR_S).toBe(60);
    expect([WEAK_MOVE, WEAK_DIG, WEAK_STRIKE, SLEEP_DRAIN]).toEqual([0.85, 0.7, 0.75, 0.5]);
    expect(createVitals().fatigue).toBe(0);
  });

  it('fatigueStage: one number for a body or for its hours awake, each stage from its threshold on', () => {
    const at = (h) => fatigueStage(h);
    expect([0, 6, 19.99].map(at)).toEqual([0, 0, 0]);
    expect([20, 25, 31.99].map(at)).toEqual([1, 1, 1]);
    expect([32, 39.99].map(at)).toEqual([2, 2]);
    expect([40, 47.99].map(at)).toEqual([3, 3]);
    expect([48, 60, 72, 500].map(at)).toEqual([4, 4, 4, 4]);
    expect(fatigueStage(body({ fatigue: 33 }))).toBe(2);
    for (const bad of [null, undefined, NaN, {}, { fatigue: 'x' }, -5]) expect(fatigueStage(/** @type {any} */ (bad))).toBe(0);
    for (let s = 1; s <= 4; s++) expect(fatigueStage(FATIGUE_FROM[s])).toBe(s);
  });

  it('awake, an hour adds one hour: whatever you do, at any step size, up to the cap', () => {
    const v = body();
    for (let i = 0; i < HOUR; i++) rest(v, 1);
    expect(v.fatigue).toBeCloseTo(1, 9);
    const w = body();
    for (let i = 0; i < HOUR * 60; i++) stepVitals(w, 1 / 60, { activity: RATES.ACTIVITY_SPRINT, felt: 20 });
    expect(w.fatigue).toBeCloseTo(1, 6); // sprinting does not tire you faster
    const big = body({ fatigue: 10 });
    rest(big, 7 * HOUR);
    expect(big.fatigue).toBeCloseTo(17, 9);
    const top = body({ fatigue: 71.5 });
    rest(top, 5 * HOUR);
    expect(top.fatigue).toBe(FATIGUE_MAX);
    const odd = body({ fatigue: NaN });
    rest(odd, HOUR);
    expect(odd.fatigue).toBeCloseTo(1, 9); // a broken value starts again from rested
    const none = body({ fatigue: 5 });
    rest(none, 0);
    expect(none.fatigue).toBe(5);
  });

  it('asleep, an hour takes off what the sleep spot gives back: 3 on a Grass Bed, 4 on a Sleeping Hide, 5 in a Bed; never below 0', () => {
    expect(ALL_SPOTS.map((s) => [s.name, s.recover])).toEqual([['Grass Bed', 3], ['Sleeping Hide', 4], ['Bed', 5]]);
    for (const spot of ALL_SPOTS) {
      const v = body({ fatigue: 30 });
      for (let i = 0; i < HOUR; i++) rest(v, 1, { sleep: spot });
      expect(v.fatigue, spot.name).toBeCloseTo(30 - spot.recover, 9);
      const low = body({ fatigue: 1 });
      for (let i = 0; i < HOUR; i++) rest(low, 1, { sleep: spot });
      expect(low.fatigue, spot.name).toBe(0);
    }
    // sleep does not ALSO add the hour: an hour asleep on a spot that gave nothing back would leave it where it was
    const still = body({ fatigue: 30 });
    rest(still, HOUR, { sleep: { recover: 0, heal: 0 } });
    expect(still.fatigue).toBe(30);
  });

  it('a day of 20 hours awake and 4 hours in a Bed balances exactly ("4 hours is minimum per day")', () => {
    const v = body({ fatigue: 0, satiation: 100, hydration: 100 });
    for (let i = 0; i < 20 * HOUR; i++) rest(v, 1);
    expect(v.fatigue).toBeCloseTo(20, 9);
    expect(fatigueStage(Math.round(v.fatigue))).toBe(1); // you reach Tired just as the day ends: no penalty yet
    for (let i = 0; i < 4 * HOUR; i++) rest(v, 1, { sleep: BED });
    expect(v.fatigue).toBeCloseTo(0, 9);
    expect(20 / BED.recover).toBe(4);
    expect(20 + 20 / BED.recover).toBe(24);
    // on the hide and on the grass it takes longer
    expect(TIRED_AT / HIDE.recover).toBe(5);
    expect(TIRED_AT / GRASS_BED.recover).toBeCloseTo(6.667, 3);
  });

  it('the stages in statusOf: one label (the stage), no healing from Exhausted, 15 % slower from Weak; each keeps the ones before', () => {
    const fresh = statusOf(body({ fatigue: 19.9 }));
    expect(fresh).toEqual({ canSprint: true, moveFactor: 1, regen: true, labels: [] });
    const tired = statusOf(body({ fatigue: 20 }));
    expect(tired).toEqual({ canSprint: true, moveFactor: 1, regen: true, labels: ['Tired'] }); // the warning: no penalty
    const exhausted = statusOf(body({ fatigue: 32 }));
    expect(exhausted).toEqual({ canSprint: true, moveFactor: 1, regen: false, labels: ['Exhausted'] });
    const weak = statusOf(body({ fatigue: 40 }));
    expect(weak).toEqual({ canSprint: true, moveFactor: WEAK_MOVE, regen: false, labels: ['Weak'] });
    const seeing = statusOf(body({ fatigue: 48 }));
    expect(seeing).toEqual({ canSprint: true, moveFactor: WEAK_MOVE, regen: false, labels: ['Seeing things'] });
    // the tiredness label comes last, after the body's other warnings, and the slow factors multiply (never under 0.6)
    const rough = statusOf(body({ fatigue: 41, satiation: 5, wet: 1 }));
    expect(rough.labels).toEqual(['Starving', 'Wet', 'Weak']);
    expect(rough.moveFactor).toBeCloseTo(RATES.SLOW_STARVING * WEAK_MOVE, 12);
    const worst = statusOf(body({ fatigue: 50, satiation: 0, hydration: 0, health: 5, temp: 30 }));
    expect(worst.moveFactor).toBe(RATES.MOVE_FACTOR_MIN);
  });

  it('Weak: digging at 0.7 of its speed and strikes at 0.75 of their power; nothing before', () => {
    for (const h of [0, 20, 32, 39.9]) expect([digFactorOf(h), strikeFactorOf(h)], String(h)).toEqual([1, 1]);
    for (const h of [40, 48, 72]) expect([digFactorOf(h), strikeFactorOf(h)], String(h)).toEqual([WEAK_DIG, WEAK_STRIKE]);
    expect(digFactorOf(body({ fatigue: 44 }))).toBe(0.7);
    expect(strikeFactorOf(body({ fatigue: 44 }))).toBe(0.75);
    expect(digFactorOf(null)).toBe(1);
    // "digging 30 % slower": a block of 2 s takes 2 / 0.7 s; "strikes do 25 % less": a power of 4 lands as 3
    expect(2 / digFactorOf(40)).toBeCloseTo(2.857, 3);
    expect(4 * strikeFactorOf(40)).toBe(3);
  });

  it('natural healing: as before while only Tired, none from Exhausted on (a bandage still pays out)', () => {
    const heals = (fatigue) => {
      const v = body({ health: 50, satiation: 90, hydration: 90, fatigue });
      rest(v, 10);
      return v.health - 50;
    };
    expect(heals(0)).toBeCloseTo(RATES.REGEN * 10, 9);
    expect(heals(25)).toBeCloseTo(RATES.REGEN * 10, 9);
    expect(heals(32)).toBe(0);
    expect(heals(45)).toBe(0);
    expect(heals(60)).toBe(0);
    const bandaged = body({ health: 50, fatigue: 45, heal: 10, healRate: 1.5 });
    rest(bandaged, 2);
    expect(bandaged.health).toBeCloseTo(53, 9);
  });

  it('through Survival: an hour of play adds an hour; `vitals fatigue`, `vitals full`, and waking after a death', () => {
    const s = new Survival();
    s.setMode('survival');
    const env = { player: createPlayer(0, 11, 0), climate: { biome: BIOME.PLAINS, climateT: 0, openSky: false, underground: true, groundChill: 0 }, time: 0.5 };
    for (let i = 0; i < HOUR * 2; i++) s.step(1, env);
    expect(s.vitals.fatigue).toBeCloseTo(2, 9);
    expect(s.setVital('fatigue', 41)).toBe(true);
    expect(s.vitals.fatigue).toBe(41);
    expect(s.status.labels).toContain('Weak');
    expect(s.setVital('fatigue', 500)).toBe(true);
    expect(s.vitals.fatigue).toBe(FATIGUE_MAX);
    expect(s.setVital('fatigue', -3)).toBe(true);
    expect(s.vitals.fatigue).toBe(0);
    s.vitals.fatigue = 50;
    expect(s.restoreVitals()).toBe(true);
    expect(s.vitals.fatigue).toBe(0);
    // dying is no rest and no fresh start: you wake Tired at the worst, never with a penalty
    expect(WAKE_MAX_FATIGUE).toBe(TIRED_AT);
    for (const [before, after] of [[0, 0], [12.5, 12.5], [20, 20], [33, 20], [72, 20]]) {
      const v = body({ fatigue: before, health: 0 });
      wakeVitals(v);
      expect(v.fatigue, String(before)).toBe(after);
      expect(fatigueStage(v)).toBeLessThanOrEqual(1);
    }
    s.vitals.fatigue = 60;
    s.damage(500, 'fall');
    s.respawn();
    expect(s.vitals.fatigue).toBe(20);
    // a state that is not stepped (Creative, dead) does not tire
    const frozen = new Survival();
    frozen.step(600, env);
    expect(frozen.vitals.fatigue).toBe(0);
  });

  it('saved, loaded and validated with the other vitals; an old save has none and starts rested, without a warning', () => {
    const s = new Survival();
    s.setMode('survival');
    s.vitals.fatigue = 33.33349;
    const json = s.export();
    expect(json.fatigue).toBe(33.333);
    expect(Object.keys(json).indexOf('fatigue')).toBe(Object.keys(json).indexOf('healRate') + 1);
    const back = new Survival();
    back.import(JSON.parse(JSON.stringify(json)));
    expect(back.vitals.fatigue).toBe(33.333);
    // an old save: no field
    const old = { ...json };
    delete old.fatigue;
    const loaded = new Survival();
    loaded.import(old);
    expect(loaded.vitals.fatigue).toBe(0);
    // a bad one: the fresh value
    for (const bad of [-1, 72.5, NaN, '12', null, Infinity]) {
      const b = new Survival();
      b.import({ ...json, fatigue: bad });
      expect(b.vitals.fatigue, String(bad)).toBe(0);
    }
    // a value out of range in memory is clamped on the way out
    s.vitals.fatigue = 99;
    expect(s.export().fatigue).toBe(FATIGUE_MAX);
    s.vitals.fatigue = NaN;
    expect(s.export().fatigue).toBe(0);

    // storage.js: the same row, validated; missing = an older save (0, no warning); bad = reset with a warning
    const row = SURVIVAL_STATS.find((r) => r[0] === 'fatigue');
    expect(row).toEqual(['fatigue', 0, FATIGUE_MAX, 0]);
    expect(SURVIVAL_STATS.at(-1)).toBe(row);
    expect(SURVIVAL_STATS_OPTIONAL).toEqual(['fatigue']);
    const state = (over) => ({ health: 80, satiation: 60, hydration: 60, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0, healRate: 0,
      spawn: null, deaths: 0, pack: new Array(27).fill(null), wear: [null, null, null], fires: {}, ...over });
    let warnings = [];
    expect(normalizeSurvivalJSON(state({ fatigue: 41.20049 }), warnings).fatigue).toBe(41.2);
    expect(warnings).toEqual([]);
    warnings = [];
    const older = normalizeSurvivalJSON(state({}), warnings);
    expect(older.fatigue).toBe(0);
    expect(warnings).toEqual([]);
    expect(Object.keys(older).slice(0, 12)).toEqual(['health', 'satiation', 'hydration', 'temp', 'breath', 'wet', 'sick', 'heal', 'healRate',
      'fatigue', 'spawn', 'deaths']);
    for (const bad of [-0.5, 72.001, 'x', null, NaN]) {
      warnings = [];
      expect(normalizeSurvivalJSON(state({ fatigue: bad }), warnings).fatigue, String(bad)).toBe(0);
      expect(warnings, String(bad)).toEqual(['survival.fatigue: invalid, reset']);
    }
    for (const edge of [0, 72]) expect(normalizeSurvivalJSON(state({ fatigue: edge })).fatigue).toBe(edge);
  });

  it('the log lines: one when a stage is entered, one when sleep clears it, nothing on a load', () => {
    expect(STAGE_LINES[1]).toBe('You are tired. Find a place to sleep.');
    expect(STAGE_LINES).toHaveLength(FATIGUE_STAGES.length);
    for (let s = 1; s <= 4; s++) expect(stageNews(s - 1, s)).toBe(STAGE_LINES[s]);
    expect(stageNews(0, 3)).toBe(STAGE_LINES[3]); // two crossed at once (the debug handle): the worse one
    expect(stageNews(2, 0)).toBe('You are no longer tired.');
    expect(stageNews(1, 0)).toBe(STAGE_LINES[0]);
    expect(stageNews(4, 2)).toBeNull(); // still a stage: the waking line says which
    expect(stageNews(2, 2)).toBeNull();
    expect(stageNews(null, 3)).toBeNull(); // a load
    expect(stageNews(undefined, 1)).toBeNull();
    for (const line of STAGE_LINES) expect(line).toMatch(/^You .*\.$/);
    expect(STAGE_LINES[2]).toMatch(/sight blurs/);
    expect(STAGE_LINES[2]).toMatch(/stop healing/);
    expect(STAGE_LINES[3]).toMatch(/slower.*digging.*strikes/);
    expect(STAGE_LINES[4]).toMatch(/seeing things/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sleep spots, lying down
// ---------------------------------------------------------------------------------------------------------------------

describe('sleep spots: looked up by block key (sleep.js)', () => {
  it('the table: Grass Bed 3 / 2, Sleeping Hide 4 / 4, Bed 5 / 6 (hours of tiredness, and HP, per game hour of sleep)', () => {
    expect(SPOT_ROWS).toEqual([
      ['GRASS_BED', { name: 'Grass Bed', recover: 3, heal: 2 }],
      ['SLEEPING_HIDE', { name: 'Sleeping Hide', recover: 4, heal: 4 }],
      ['BED', { name: 'Bed', recover: 5, heal: 6 }],
    ]);
    expect(Object.isFrozen(SPOT_ROWS)).toBe(true);
    // a better place to sleep is better at both
    for (let i = 1; i < SPOT_ROWS.length; i++) {
      expect(SPOT_ROWS[i][1].recover).toBeGreaterThan(SPOT_ROWS[i - 1][1].recover);
      expect(SPOT_ROWS[i][1].heal).toBeGreaterThan(SPOT_ROWS[i - 1][1].heal);
    }
  });

  it('this build has the spots whose blocks it has, and nothing breaks for the ones it has not', () => {
    const here = SPOT_ROWS.filter(([key]) => BLOCK[key] !== undefined).map(([key]) => key);
    expect(SPOTS.map((s) => s.key)).toEqual(here);
    expect(here).toContain('SLEEPING_HIDE');
    for (const s of SPOTS) {
      expect(s.id).toBe(BLOCK[s.key]);
      expect(spotOf(s.id)).toBe(s);
      expect(isSleepSpot(s.id)).toBe(true);
    }
    expect(spotOf(B.SLEEPING_HIDE)).toMatchObject({ key: 'SLEEPING_HIDE', name: 'Sleeping Hide', recover: 4, heal: 4 });
    // there is no sleeping on bare ground, or on anything else
    for (const id of [B.AIR, B.GRASS_BLOCK, B.DIRT, B.HAY_BALE, B.WICKER_BASKET, B.CAMPFIRE, -1, 9999, undefined]) {
      expect(spotOf(/** @type {any} */ (id))).toBeNull();
      expect(isSleepSpot(/** @type {any} */ (id))).toBe(false);
    }
  });

  it('the two rows whose blocks another package registers light up with an injected block table', () => {
    expect(ALL_SPOTS.map((s) => [s.key, s.id, s.name, s.recover, s.heal])).toEqual([
      ['GRASS_BED', 250, 'Grass Bed', 3, 2], ['SLEEPING_HIDE', B.SLEEPING_HIDE, 'Sleeping Hide', 4, 4], ['BED', 251, 'Bed', 5, 6]]);
    expect(spotOf(250, ALL_SPOTS)).toBe(GRASS_BED);
    expect(spotOf(251, ALL_SPOTS)).toBe(BED);
    expect(spotOf(250)).toBe(SPOTS.find((s) => s.id === 250) ?? null); // not in this build unless its block is
    expect(sleepSpots({})).toEqual([]);
    expect(sleepSpots({ BED: 7 }).map((s) => s.name)).toEqual(['Bed']);
    expect(sleepSpots({ BED: 0 })).toHaveLength(1); // an id of 0 is still an id
    expect(sleepSpots()).toEqual(SPOTS);
  });

  it('R on a sleep spot: `Sleeping Hide · R: sleep` (it read `R: wake here`), and the action is still `hide`', () => {
    expect(spotHint(HIDE)).toBe('Sleeping Hide · R: sleep');
    expect(spotHint(BED)).toBe('Bed · R: sleep');
    expect(spotHint(GRASS_BED)).toBe('Grass Bed · R: sleep');
    expect(HINT.hide).toBe(spotHint(spotOf(B.SLEEPING_HIDE)));
    const pack = { count: () => 0, countTag: () => 0, hasTool: () => false };
    const act = interactKind({ hit: { q: 3, y: 61, r: -2, blockId: B.SLEEPING_HIDE }, selectedKey: null, pack });
    expect(act).toEqual({ kind: 'hide', q: 3, y: 61, r: -2, hint: 'Sleeping Hide · R: sleep' });
    for (const s of SPOTS) expect(interactKind({ hit: { q: 0, y: 5, r: 0, blockId: s.id }, selectedKey: null, pack })).toMatchObject({ kind: 'hide', hint: `${s.name} · R: sleep` });
  });
});

describe('lying down: when you may and when you may not (sleepRefusal)', () => {
  const ok = { vitals: body({ fatigue: 24 }), x: 0, y: 11, z: 0 };

  it('from 6 hours awake; under it R only sets the waking place and says so', () => {
    expect(SLEEP_MIN_FATIGUE).toBe(6);
    expect(sleepRefusal(ok)).toBeNull();
    expect(sleepRefusal({ vitals: body({ fatigue: 6 }) })).toBeNull();
    expect(sleepRefusal({ vitals: body({ fatigue: 5.99 }) })).toBe('You are not tired.');
    expect(sleepRefusal({ vitals: body({ fatigue: 0 }) })).toBe(SLEEP_LINES.notTired);
    expect(sleepRefusal({ vitals: body({ fatigue: NaN }) })).toBe(SLEEP_LINES.notTired);
  });

  it('not in water, not riding, not with a zombie within 12 cells chasing you', () => {
    expect(sleepRefusal({ ...ok, inWater: true })).toBe('You cannot sleep in water.');
    expect(sleepRefusal({ ...ok, riding: true })).toBe('Get off your horse to sleep.');
    expect(SLEEP_ZOMBIE_NEAR).toBe(12);
    const zb = (x, mode) => ({ x, y: 11, z: 0, mode });
    expect(sleepRefusal({ ...ok, zombies: [zb(12, 'chase')] })).toBe('You cannot sleep now: a zombie is after you.');
    expect(sleepRefusal({ ...ok, zombies: [zb(12.1, 'chase')] })).toBeNull(); // too far to matter
    expect(sleepRefusal({ ...ok, zombies: [zb(3, 'idle'), zb(5, 'walk'), zb(2, 'avoid')] })).toBeNull(); // near, but not after you
    expect(sleepRefusal({ ...ok, zombies: [zb(30, 'chase'), zb(4, 'idle'), zb(-6, 'chase')] })).toBe(SLEEP_LINES.zombie);
    expect(sleepRefusal({ ...ok, zombies: [] })).toBeNull();
    // height counts: one chasing 13 cells below is not within 12
    expect(sleepRefusal({ ...ok, zombies: [{ x: 0, y: -2, z: 0, mode: 'chase' }] })).toBeNull();
  });

  it('not while poison is still taking health, nor with hunger or thirst at the level that would wake you at once', () => {
    expect(sleepRefusal({ vitals: body({ fatigue: 24, sick: 30, health: 60 }) })).toBe('You cannot sleep while the poison is hurting you.');
    // at the poison's floor it takes nothing more: you may sleep (it will not heal you until the poison is gone)
    expect(sleepRefusal({ vitals: body({ fatigue: 24, sick: 30, health: RATES.SICK_FLOOR }) })).toBeNull();
    expect(sleepRefusal({ vitals: body({ fatigue: 24, sick: 0, health: 12 }) })).toBeNull(); // hurt, not poisoned: sleep heals
    expect(sleepRefusal({ vitals: body({ fatigue: 24, satiation: 9.9 }) })).toBe('You are too hungry to sleep. Eat first.');
    expect(sleepRefusal({ vitals: body({ fatigue: 24, hydration: 9.9 }) })).toBe('You are too thirsty to sleep. Drink first.');
    expect(sleepRefusal({ vitals: body({ fatigue: 24, satiation: 10, hydration: 10 }) })).toBeNull();
    // the first reason in the order: not tired, riding, water, a zombie, poison, hunger, thirst
    const all = { vitals: body({ fatigue: 2, sick: 9, satiation: 1, hydration: 1 }), riding: true, inWater: true, x: 0, y: 0, z: 0,
      zombies: [{ x: 1, y: 0, z: 0, mode: 'chase' }] };
    const order = [];
    order.push(sleepRefusal(all));
    all.vitals.fatigue = 30;
    order.push(sleepRefusal(all));
    all.riding = false;
    order.push(sleepRefusal(all));
    all.inWater = false;
    order.push(sleepRefusal(all));
    all.zombies = [];
    order.push(sleepRefusal(all));
    all.vitals.sick = 0;
    order.push(sleepRefusal(all));
    all.vitals.satiation = 50;
    order.push(sleepRefusal(all));
    all.vitals.hydration = 50;
    order.push(sleepRefusal(all));
    expect(order).toEqual([SLEEP_LINES.notTired, SLEEP_LINES.riding, SLEEP_LINES.water, SLEEP_LINES.zombie, SLEEP_LINES.poison,
      SLEEP_LINES.hungry, SLEEP_LINES.thirsty, null]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A sleep
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A sleeper as main runs one: a real Survival stepped one game second a tick on the sleep spot's numbers, the clock
 * advanced with it, in a mild cave (nothing but sleep changes the body).
 */
function sleeper({ fatigue = 24, time = clock(20), vitals = {}, attackAt = -1 } = {}) {
  const survival = new Survival();
  survival.setMode('survival');
  Object.assign(survival.vitals, { fatigue, satiation: 90, hydration: 90, ...vitals });
  const sleep = new Sleep();
  const env = {
    player: createPlayer(0, 11, 0), climate: { biome: BIOME.PLAINS, climateT: 0, openSky: false, underground: true, groundChill: 0 },
    heat: 0, time, /** @type {any} */ sleep: null,
  };
  const s = {
    survival, sleep, env, v: survival.vitals, time, day: 1, seconds: 0, hoursRolled: 0,
    hooks: {
      second() {
        const nt = advanceTime(s.time, 1);
        if (nt < s.time) s.day++;
        s.time = nt;
        env.time = nt;
        env.sleep = sleep.asleep ? sleep.spot : null;
        const ev = survival.step(1, env);
        s.seconds++;
        const v = survival.vitals;
        return { hurt: ev.damage > 0, died: ev.died !== null, satiation: v.satiation, hydration: v.hydration, fatigue: v.fatigue, isDay: isDayTime(nt) };
      },
      hour() {
        s.hoursRolled++;
        return s.hoursRolled === attackAt;
      },
    },
    /** Lie down on `spot` and run frames of 1/60 s until the sleep ends (or `maxS` real seconds pass). */
    run(spot = HIDE, maxS = 40) {
      sleep.lie(spot, [0, 10, 0]);
      let woke = null;
      let frames = 0;
      while (sleep.active && frames < maxS * 60) {
        const res = sleep.step(1 / 60, s.hooks);
        frames++;
        if (res.woke) woke = res.woke;
      }
      return { woke, frames, real: frames / 60 };
    },
  };
  return s;
}

describe('a sleep: the fade, game time at the rate, one-second ticks inside a budget (Sleep)', () => {
  it('the numbers: 30 game seconds a second (8 hours in 16 s), a 1.5 s fade, at most 10 hours, 8 the full night', () => {
    expect([SLEEP_RATE, SLEEP_FADE_S, SLEEP_MAX_H, SLEEP_FULL_H]).toEqual([30, 1.5, 10, 8]);
    expect((SLEEP_FULL_H * GAME_HOUR_S) / SLEEP_RATE).toBe(16);
    expect(SLEEP_TICKS_PER_FRAME).toBeGreaterThanOrEqual(3); // a frame of the longest dt (0.1 s) owes 3
    expect(SLEEP_FRAME_BUDGET_MS).toBeLessThanOrEqual(8); // half a 60 Hz frame at the most
  });

  it('lying down: awake → falling for 1.5 s (nothing ticks) → asleep; a second lie is refused; wake at any moment', () => {
    const sl = new Sleep();
    expect([sl.phase, sl.active, sl.asleep, sl.hours]).toEqual(['awake', false, false, 0]);
    let ticks = 0;
    const hooks = { second: () => (ticks++, { satiation: 80, hydration: 80, fatigue: 30, isDay: false }) };
    expect(sl.step(1, hooks)).toEqual({ ticks: 0, woke: null }); // awake: nothing
    expect(sl.lie(HIDE, [4, 20, -7])).toBe(true);
    expect([sl.phase, sl.active, sl.asleep]).toEqual(['falling', true, false]);
    expect(sl.spot).toBe(HIDE);
    expect(sl.cell).toEqual([4, 20, -7]);
    expect(sl.lie(BED, [0, 0, 0])).toBe(false);
    for (let f = 0; f < 89; f++) sl.step(1 / 60, hooks);
    expect(sl.phase).toBe('falling');
    expect(ticks).toBe(0);
    sl.step(2 / 60, hooks);
    expect(sl.phase).toBe('asleep');
    expect(ticks).toBe(0); // the first tick comes with the next frame
    sl.step(1 / 30, hooks);
    expect(ticks).toBe(1);
    expect(sl.wake('asked')).toBe(true);
    expect([sl.phase, sl.wokeBy]).toEqual(['awake', 'asked']);
    expect(sl.wake('asked')).toBe(false);
    // a key during the fade wakes too: nothing was slept
    const early = new Sleep();
    early.lie(HIDE, [0, 0, 0]);
    early.step(0.5, hooks);
    early.wake('asked');
    expect([early.active, early.lastHours]).toEqual([false, 0]);
    expect(new Sleep().lie(/** @type {any} */ (null), [0, 0, 0])).toBe(false);
  });

  it('time passes at the rate: 16 real seconds asleep are 8 game hours, on the clock and in the body', () => {
    const s = sleeper({ fatigue: 72, time: clock(20) }); // too tired to be rested before the test ends
    s.sleep.lie(HIDE, [0, 10, 0]);
    for (let f = 0; f < 91; f++) s.sleep.step(1 / 60, s.hooks); // the fade
    expect(s.sleep.asleep).toBe(true);
    expect(s.seconds).toBe(0);
    let most = 0;
    for (let f = 0; f < 16 * 60; f++) most = Math.max(most, s.sleep.step(1 / 60, s.hooks).ticks);
    expect(Math.abs(s.seconds - 8 * HOUR)).toBeLessThanOrEqual(1);
    expect(most).toBe(1); // at 60 frames a second: a tick every other frame
    expect(s.sleep.hours).toBeCloseTo(8, 1);
    expect(s.time).toBeCloseTo(clock(4), 2); // 20:00 → 04:00 the next day
    expect(s.day).toBe(2); // the day counter moved on at midnight
    expect(s.v.fatigue).toBeCloseTo(72 - 8 * HIDE.recover, 0);
    expect(s.sleep.active).toBe(true);
  });

  it('a slow frame owes more, never more than the cap; what a frame cannot tick is dropped (a slower sleep, not a stall)', () => {
    const s = sleeper({ fatigue: 72 });
    s.sleep.lie(HIDE, [0, 10, 0]);
    s.sleep.step(2, s.hooks); // the fade, in one long frame
    expect(s.sleep.step(0.1, s.hooks).ticks).toBe(3); // main's longest frame: 0.1 s × 30
    expect(s.sleep.step(5, s.hooks).ticks).toBe(SLEEP_TICKS_PER_FRAME);
    expect(s.sleep.owed).toBeLessThan(1);
    expect(s.sleep.step(1 / 60, s.hooks).ticks).toBeLessThanOrEqual(1); // nothing piled up behind the long frame
    // the budget: a machine on which a tick takes 5 ms gets one tick a frame however long the frame was
    let t = 0;
    const slow = { ...s.hooks, second: () => (t += 5, s.hooks.second()), now: () => t };
    expect(s.sleep.step(0.1, slow).ticks).toBe(1);
    expect(s.sleep.owed).toBeLessThanOrEqual(1);
    expect(s.sleep.step(0.1, slow).ticks).toBe(1);
    // … and on a fast one the budget never bites
    const fast = { ...s.hooks, now: () => 0 };
    s.sleep.owed = 0;
    expect(s.sleep.step(0.1, fast).ticks).toBe(3);
    expect(s.sleep.step(0, s.hooks)).toEqual({ ticks: 0, woke: null });
  });

  it('the cost of a sleeping frame: a tick of the body is far inside the budget (measured)', () => {
    const s = sleeper({ fatigue: 72 });
    s.sleep.lie(HIDE, [0, 10, 0]);
    s.sleep.step(2, s.hooks);
    for (let i = 0; i < 200; i++) s.hooks.second(); // warm
    const t0 = performance.now();
    const n = 2000;
    for (let i = 0; i < n; i++) s.hooks.second();
    const perTick = (performance.now() - t0) / n;
    expect(perTick).toBeLessThan(SLEEP_FRAME_BUDGET_MS / SLEEP_TICKS_PER_FRAME); // (about 0.002 ms on the machine that wrote this)
  });

  it('the body asleep: hunger and thirst at half their resting rate, the temperature as it is, bandages and poison as ever', () => {
    const hourOf = (asleep) => {
      const s = sleeper({ fatigue: 30, vitals: { satiation: 80, hydration: 80 } });
      s.env.sleep = asleep ? HIDE : null;
      for (let i = 0; i < HOUR; i++) s.survival.step(1, s.env);
      return { food: 80 - s.v.satiation, water: 80 - s.v.hydration, temp: s.v.temp };
    };
    const awake = hourOf(false);
    const asleep = hourOf(true);
    expect(awake.food).toBeCloseTo(RATES.SATIATION_DRAIN * HOUR, 6);
    expect(asleep.food).toBeCloseTo(awake.food * SLEEP_DRAIN, 6);
    expect(asleep.water).toBeCloseTo(awake.water * SLEEP_DRAIN, 6);
    expect(asleep.water).toBeCloseTo(RATES.HYDRATION_DRAIN * 0.5 * HOUR, 6);
    expect(asleep.temp).toBeCloseTo(awake.temp, 6);
    // 8 hours of sleep cost about 13 Nourishment and 20 Hydration: a full night never starves a fed sleeper
    expect(RATES.SATIATION_DRAIN * 0.5 * 8 * HOUR).toBeCloseTo(13.3, 1);
    expect(RATES.HYDRATION_DRAIN * 0.5 * 8 * HOUR).toBeCloseTo(20, 1);
    // the cold is the cold: a sleeper in freezing air chills exactly like someone standing still there
    const chill = (sleepOn) => {
      const v = body({ fatigue: 30 });
      for (let i = 0; i < 120; i++) stepVitals(v, 1, { activity: 1, felt: -10, still: true, sleep: sleepOn });
      return v.temp;
    };
    expect(chill(HIDE)).toBe(chill(null));
    expect(chill(HIDE)).toBeLessThan(37);
    // a sleeper is lying still whatever the body's velocity says: no sprinting drain, no exertion
    const s = sleeper({ fatigue: 30, vitals: { satiation: 80 } });
    Object.assign(s.env.player, { vx: 9, vz: 0, sprinting: true });
    s.env.sleep = HIDE;
    s.env.breaking = true;
    s.survival.step(HOUR, s.env);
    expect(80 - s.v.satiation).toBeCloseTo(asleep.food, 6);
    // a bandage pays out, and poison counts down and bites, as awake
    const b = body({ fatigue: 30, health: 40, heal: 6, healRate: 1.5 });
    rest(b, 2, { sleep: { recover: 4, heal: 0 } });
    expect(b.health).toBeCloseTo(43, 9);
    const p = body({ fatigue: 30, health: 40, sick: 10 });
    const res = rest(p, 2, { sleep: HIDE });
    expect(p.sick).toBe(8);
    expect(res.damage.sick).toBeCloseTo(RATES.SICK_DPS * 2, 9);
  });

  it('healing asleep: 2, 4 or 6 HP a game hour by the spot, whatever else holds, but not while Poisoned; never natural healing on top', () => {
    expect(ALL_SPOTS.map((s) => s.heal)).toEqual([2, 4, 6]);
    for (const spot of ALL_SPOTS) {
      const v = body({ health: 40, satiation: 90, hydration: 90, fatigue: 30 });
      for (let i = 0; i < HOUR; i++) rest(v, 1, { sleep: spot });
      expect(v.health - 40, spot.name).toBeCloseTo(spot.heal, 9); // not spot.heal + RATES.REGEN × 60
      // hungry, thirsty, exhausted and cold: the spot still heals (awake, nothing would)
      const rough = body({ health: 40, satiation: 20, hydration: 20, fatigue: 45, temp: 35 });
      expect(statusOf(rough).regen).toBe(false);
      for (let i = 0; i < HOUR; i++) stepVitals(rough, 1, { activity: 1, felt: 20, still: true, sleep: spot });
      expect(rough.health - 40, spot.name).toBeCloseTo(spot.heal, 9);
      // healing costs no Nourishment asleep
      const fed = body({ health: 40, satiation: 90, fatigue: 30 });
      rest(fed, HOUR, { sleep: spot });
      expect(90 - fed.satiation).toBeCloseTo(RATES.SATIATION_DRAIN * 0.5 * HOUR, 9);
      // poisoned at the floor: no healing while it lasts
      const sick = body({ health: RATES.SICK_FLOOR, sick: 600, fatigue: 30 });
      for (let i = 0; i < HOUR; i++) rest(sick, 1, { sleep: spot });
      expect(sick.health, spot.name).toBe(RATES.SICK_FLOOR);
      // never above full
      const full = body({ health: 99.9, fatigue: 30 });
      rest(full, HOUR, { sleep: spot });
      expect(full.health).toBe(STAT_MAX);
    }
    // "8 hours is optimal for regeneration": tiredness is gone after 4 to 7 hours, the healing goes on to the eighth
    expect(TIRED_AT / BED.recover).toBe(4);
    expect(TIRED_AT / GRASS_BED.recover).toBeLessThan(7);
    expect(SLEEP_FULL_H * BED.heal).toBe(48);
    expect(SLEEP_FULL_H * HIDE.heal).toBe(32);
    expect(SLEEP_FULL_H * GRASS_BED.heal).toBe(16);
    // awake, a rested and fed body heals 7.2 HP a game hour, at a cost; the Bed's 6 come with no conditions, 30 times faster
    expect(RATES.REGEN * HOUR).toBeCloseTo(7.2, 9);
  });
});

describe('waking: every reason (Sleep, wakeReason)', () => {
  it('wakeReason: died, hurt, hunger or thirst under 10, 10 hours, or rested after 8 hours or with the sun up', () => {
    const fine = { satiation: 50, hydration: 50, fatigue: 5, isDay: false };
    expect(wakeReason(fine, 3)).toBeNull();
    expect(wakeReason({ ...fine, died: true, hurt: true }, 3)).toBe('died');
    expect(wakeReason({ ...fine, hurt: true }, 3)).toBe('hurt');
    expect(wakeReason({ ...fine, satiation: 9.99 }, 3)).toBe('hunger');
    expect(wakeReason({ ...fine, satiation: 10 }, 3)).toBeNull();
    expect(wakeReason({ ...fine, hydration: 9.99 }, 3)).toBe('thirst');
    expect(wakeReason({ ...fine, hydration: 9.99, satiation: 2 }, 3)).toBe('hunger');
    expect(wakeReason(fine, 9.99)).toBeNull();
    expect(wakeReason(fine, 10)).toBe('max');
    expect(wakeReason({ ...fine, fatigue: 0 }, 7.99)).toBeNull(); // rested, but the night's healing goes on
    expect(wakeReason({ ...fine, fatigue: 0 }, 8)).toBe('rested');
    expect(wakeReason({ ...fine, fatigue: 0, isDay: true }, 0.5)).toBe('rested');
    expect(wakeReason({ ...fine, fatigue: 0.01, isDay: true }, 9)).toBeNull(); // not rested yet
    expect(wakeReason({ ...fine, fatigue: 0.01, isDay: true }, 10)).toBe('max');
  });

  it('any key or click: main asks, the sleep ends at once', () => {
    const s = sleeper({ fatigue: 40 });
    s.sleep.lie(HIDE, [0, 10, 0]);
    for (let f = 0; f < 300; f++) s.sleep.step(1 / 60, s.hooks);
    const before = s.seconds;
    expect(before).toBeGreaterThan(90);
    s.sleep.wake('asked');
    expect(s.sleep.step(1 / 60, s.hooks)).toEqual({ ticks: 0, woke: null });
    expect(s.seconds).toBe(before);
    expect(s.sleep.lastHours).toBeCloseTo(before / HOUR, 9);
  });

  it('when you are hurt: the cold, poison, starving — the first second health falls', () => {
    const cold = sleeper({ fatigue: 40, vitals: { temp: 30 } }); // Hypothermic
    expect(cold.run().woke).toBe('hurt');
    expect(cold.seconds).toBe(1);
    const sick = sleeper({ fatigue: 40, vitals: { sick: 60, health: 50 } });
    expect(sick.run().woke).toBe('hurt');
    expect(sick.seconds).toBe(1);
    // at the poison's floor nothing hurts: the sleep goes on (and heals once the poison is gone)
    const floor = sleeper({ fatigue: 72, time: clock(20), vitals: { sick: 30, health: RATES.SICK_FLOOR } });
    floor.sleep.lie(HIDE, [0, 10, 0]);
    floor.sleep.advance(HOUR, floor.hooks);
    expect(floor.sleep.active).toBe(true);
    expect(floor.v.health).toBeCloseTo(RATES.SICK_FLOOR + HIDE.heal * 0.5, 6); // half the hour was poisoned
  });

  it('when hunger or thirst falls under 10', () => {
    const hungry = sleeper({ fatigue: 72, vitals: { satiation: 10 + RATES.SATIATION_DRAIN * 0.5 * 30.5 } });
    const a = hungry.run();
    expect(a.woke).toBe('hunger');
    expect(hungry.seconds).toBe(31);
    expect(hungry.v.satiation).toBeLessThan(10);
    const dry = sleeper({ fatigue: 72, vitals: { hydration: 10 + RATES.HYDRATION_DRAIN * 0.5 * 30.5 } });
    expect(dry.run().woke).toBe('thirst');
    expect(dry.seconds).toBe(31);
  });

  it('by itself after 10 hours, however tired you still are', () => {
    const s = sleeper({ fatigue: 72, time: clock(18) });
    const res = s.run(GRASS_BED);
    expect(res.woke).toBe('max');
    expect(s.seconds).toBe(SLEEP_MAX_H * HOUR);
    expect(s.sleep.lastHours).toBe(10);
    expect(s.v.fatigue).toBeCloseTo(72 - 10 * GRASS_BED.recover, 6);
    expect(res.real).toBeCloseTo(SLEEP_FADE_S + (10 * HOUR) / SLEEP_RATE, 0); // 1.5 s + 20 s
  });

  it('rested: at night you sleep on to 8 hours (healing), or to sunrise if that comes first; by day you get up at once', () => {
    // 20:00, 8 hours tired on a hide: rested at 22:00, the night goes on, awake at 04:00 after 8 hours (sunrise is 04:30)
    const night = sleeper({ fatigue: 8, time: clock(20), vitals: { health: 40 } });
    expect(night.run(HIDE).woke).toBe('rested');
    expect(night.seconds).toBe(SLEEP_FULL_H * HOUR);
    expect(night.v.fatigue).toBe(0);
    expect(night.v.health).toBeCloseTo(40 + 8 * HIDE.heal, 6); // the healing went on after the tiredness was gone
    expect(isDayTime(night.time)).toBe(false);
    // 22:00: sunrise comes 6½ hours later, before the 8 hours are up
    expect(SUNRISE).toBe(clock(4, 30));
    const dawn = sleeper({ fatigue: 8, time: clock(22) });
    expect(dawn.run(HIDE).woke).toBe('rested');
    expect(Math.abs(dawn.seconds - 6.5 * HOUR)).toBeLessThanOrEqual(1); // (the clock is a fraction of a day: a second either way)
    expect(dawn.time).toBeCloseTo(SUNRISE, 2);
    expect(isDayTime(dawn.time)).toBe(true);
    // still tired at sunrise: you sleep on until you are rested
    const late = sleeper({ fatigue: 30, time: clock(2) });
    expect(late.run(BED).woke).toBe('rested');
    expect(Math.abs(late.seconds - (30 / BED.recover) * HOUR)).toBeLessThanOrEqual(1);
    expect(isDayTime(late.time)).toBe(true);
    // a nap by day: up the second you are rested
    const nap = sleeper({ fatigue: 6, time: clock(12) });
    expect(nap.run(HIDE).woke).toBe('rested');
    expect(Math.abs(nap.seconds - (6 / HIDE.recover) * HOUR)).toBeLessThanOrEqual(1);
    expect(SUNSET).toBe(clock(19, 30));
  });

  it('when a night attack comes: the roll is asked once after each whole game hour, and its yes wakes you at once', () => {
    const s = sleeper({ fatigue: 72, time: clock(21), attackAt: 3 });
    const res = s.run(HIDE);
    expect(res.woke).toBe('attack');
    expect(s.hoursRolled).toBe(3);
    expect(s.seconds).toBe(3 * HOUR);
    expect(s.sleep.wokeBy).toBe('attack');
    // no roll in a second that already woke the sleeper
    const hurt = sleeper({ fatigue: 72, vitals: { satiation: 10.001 } });
    hurt.sleep.lie(HIDE, [0, 10, 0]);
    hurt.sleep.advance(10 * HOUR, hurt.hooks);
    expect(hurt.sleep.wokeBy).toBe('hunger');
    expect(hurt.hoursRolled).toBe(0);
    // a full night with no attack: one roll an hour
    const calm = sleeper({ fatigue: 72, time: clock(20) });
    calm.sleep.lie(HIDE, [0, 10, 0]);
    expect(calm.sleep.advance(8 * HOUR - 1, calm.hooks)).toEqual({ ticks: 8 * HOUR - 1, woke: null });
    expect(calm.hoursRolled).toBe(7);
    calm.sleep.advance(1, calm.hooks);
    expect(calm.hoursRolled).toBe(8);
    // short naps dodge nothing: the hour is counted over sleeps, so four naps of a quarter of an hour bring one roll
    const naps = sleeper({ fatigue: 72, time: clock(21) });
    for (let i = 0; i < 3; i++) {
      naps.sleep.lie(HIDE, [0, 10, 0]);
      naps.sleep.advance(15, naps.hooks);
      naps.sleep.wake('asked');
    }
    expect([naps.hoursRolled, naps.sleep.sinceRoll]).toEqual([0, 45]);
    naps.sleep.lie(HIDE, [0, 10, 0]);
    naps.sleep.advance(14, naps.hooks);
    expect(naps.hoursRolled).toBe(0);
    naps.sleep.advance(1, naps.hooks);
    expect([naps.hoursRolled, naps.sleep.sinceRoll]).toEqual([1, 0]);
    naps.sleep.reset(); // a new world: nothing carried
    expect(naps.sleep.sinceRoll).toBe(0);
  });

  it('a death in your sleep ends it (main runs the death at its checkpoint)', () => {
    const s = sleeper({ fatigue: 40, vitals: { temp: 29, health: 1 } });
    expect(s.run().woke).toBe('died');
    expect(s.survival.dead).toBe('cold');
    expect(s.sleep.active).toBe(false);
  });

  it('advance(seconds): the debug handle\'s way to sleep by game hours, with the same looks and rolls', () => {
    const s = sleeper({ fatigue: 30, time: clock(20), vitals: { health: 50 } });
    expect(s.sleep.advance(60, s.hooks)).toEqual({ ticks: 0, woke: null }); // awake: nothing
    s.sleep.lie(BED, [0, 10, 0]);
    expect(s.sleep.advance(3 * HOUR, s.hooks)).toEqual({ ticks: 180, woke: null }); // lying down counts as asleep at once
    expect(s.sleep.phase).toBe('asleep');
    expect(s.v.fatigue).toBeCloseTo(15, 6);
    expect(s.v.health).toBeCloseTo(68, 6);
    const res = s.sleep.advance(99 * HOUR, s.hooks);
    expect(res.woke).toBe('rested');
    expect(s.sleep.lastHours).toBe(8);
    expect(s.sleep.advance(NaN, s.hooks)).toEqual({ ticks: 0, woke: null });
  });

  it('the one line on waking: how long, what woke you if it was pain, hunger or thirst, and the state you woke in', () => {
    expect(wakeLine(7.6, { fatigue: 0 }, 'rested')).toBe('You slept 7 hours. You are rested.');
    expect(wakeLine(1, { fatigue: 12 }, 'asked')).toBe('You slept 1 hour. You feel better.');
    expect(wakeLine(0.4, { fatigue: 24 }, 'asked')).toBe('You hardly slept. You are still tired.');
    expect(wakeLine(3, { fatigue: 33 }, 'hunger')).toBe('You slept 3 hours. Hunger woke you. You are still exhausted.');
    expect(wakeLine(2, { fatigue: 41 }, 'thirst')).toBe('You slept 2 hours. Thirst woke you. You are still weak.');
    expect(wakeLine(5, { fatigue: 50 }, 'hurt')).toBe('You slept 5 hours. Pain woke you. You are still seeing things.');
    expect(wakeLine(10, { fatigue: 42 }, 'max')).toBe('You slept 10 hours. You are still weak.');
    expect(wakeLine(2, { fatigue: 21 }, 'attack')).toBe('You slept 2 hours. You are still tired.'); // (`Something is near.` comes first)
    expect(SLEEP_LINES.attack).toBe('Something is near.');
    expect([sleptText(0), sleptText(0.99), sleptText(1), sleptText(1.99), sleptText(8), sleptText(NaN), sleptText(-3)]).toEqual([
      'You hardly slept.', 'You hardly slept.', 'You slept 1 hour.', 'You slept 1 hour.', 'You slept 8 hours.', 'You hardly slept.', 'You hardly slept.']);
    // the dark screen: a small quiet line, and how to wake
    expect([sleepingLine(0), sleepingLine(2.99), sleepingLine(3), sleepingLine(NaN)]).toEqual(['Sleeping · 0 h', 'Sleeping · 2 h', 'Sleeping · 3 h', 'Sleeping · 0 h']);
    expect(SLEEP_LINES.wakeKey).toBe('press any key to wake');
  });

  it('the view: dark in about 1.5 s lying down, back in under a second on waking; no jump', () => {
    let d = 0;
    let steps = 0;
    while (d < 1) {
      const next = sleepDark(d, true, 1 / 60);
      expect(next - d).toBeLessThanOrEqual(1 / 60 / SLEEP_FADE_S + 1e-9);
      d = next;
      steps++;
    }
    expect(steps / 60).toBeCloseTo(SLEEP_FADE_S, 1);
    expect(sleepDark(1, true, 1)).toBe(1);
    steps = 0;
    while (d > 0) {
      d = sleepDark(d, false, 1 / 60);
      steps++;
    }
    expect(steps / 60).toBeCloseTo(WAKE_FADE_S, 1);
    expect(WAKE_FADE_S).toBeLessThan(1);
    expect(sleepDark(0, false, 1)).toBe(0);
    expect(sleepDark(0.5, true, 0)).toBe(0.5); // a paused game: as it was
    expect(sleepDark(NaN, true, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A secure place
// ---------------------------------------------------------------------------------------------------------------------

/** Natural grass up to y = G: the floor a camp stands on is the layer y = Y. */
const G = 10;
const Y = G + 1;
const grassland = () => makeFakeWorld({ groundY: G, groundId: B.GRASS_BLOCK });
const disc = (radius) => {
  const out = [];
  for (let q = -radius; q <= radius; q++) for (let r = -radius; r <= radius; r++) if (hexLength(q, r) <= radius) out.push([q, r]);
  return out;
};
const ringOf = (radius) => disc(radius).filter(([q, r]) => hexLength(q, r) === radius);
/** The zombies' view of a fake world: the spawning hooks as main gives them (a built-in column is one with an edit). */
const zview = (w, extra = {}) => ({
  getBlock: w.getBlock, isLoaded: () => true, isLoadedCell: (q, r) => w.hasChunkAtCell(q, r), groundHeight: (q, r) => w.terrainHeightAt(q, r),
  isNaturalGround: (q, y, r) => w.isNaturalGround(q, y, r), columnEdited: (q, r) => columnHasEdits(w.edits, q, r), ...extra,
});
/** sleep.js's SecureEnv over a fake world, as main builds it. */
const secureEnvOf = (w, extra = {}, zombies = new Zombies(mulberry32(1))) => {
  const view = zview(w, extra);
  return { getBlock: w.getBlock, spawnY: (q, r) => zombies.spawnHeightAt(view, q, r), groundHeight: (q, r) => w.terrainHeightAt(q, r) };
};
/** A camp round a Sleeping Hide at (0, Y, 0): a plank floor of `radius`, walls on its rim `height` high, a roof at `roofY`. */
function camp({ radius = 3, height = 5, floor = true, roofY = null } = {}) {
  const w = grassland();
  if (floor) for (const [q, r] of disc(radius)) w.setBlock(q, G, r, B.OAK_PLANKS);
  for (const [q, r] of ringOf(radius)) for (let y = Y; y < Y + height; y++) w.setBlock(q, y, r, B.COBBLESTONE);
  if (roofY !== null) for (const [q, r] of disc(radius)) w.setBlock(q, roofY, r, B.OAK_PLANKS);
  w.setBlock(0, Y, 0, B.SLEEPING_HIDE);
  return w;
}
const inside = (radius) => disc(radius - 1).length; // the columns inside walls on ring `radius`

describe('a secure place: the flood fill of the open cells round the bed (secureAt)', () => {
  it('the numbers: 12 cells out, the first 5 layers from the bed\'s floor, at most 800 cells; three things it can say', () => {
    expect([SECURE_RADIUS, SECURE_RISE, SECURE_MAX_CELLS]).toEqual([12, 5, 800]);
    expect(SECURE_RISE).toBe(Math.max(...Object.values(CLIMB).map((c) => c.night)) + 1); // no zombie climbs more than 4
    expect(SECURE_REASONS).toEqual({ open: 'open to the outside', big: 'too big a place to keep watch over',
      ground: 'zombies can come up from the ground inside' });
    expect(secureWords({ secure: true, reason: '', cells: 9 })).toBe('secure here');
    expect(secureWords({ secure: false, reason: SECURE_REASONS.open, cells: 9 })).toBe('not secure: open to the outside');
    expect(secureWords({ secure: false, reason: SECURE_REASONS.ground, cells: 9 })).toBe('not secure: zombies can come up from the ground inside');
    expect(secureWords(null)).toBe('');
  });

  it('a sealed room: a floor, walls and a roof → secure, and every open cell of it was looked at', () => {
    const w = camp({ radius: 3, height: 3, roofY: Y + 3 });
    const res = secureAt(secureEnvOf(w), 0, Y, 0);
    expect(res).toEqual({ secure: true, reason: '', cells: inside(3) * 3 - 1 }); // 19 columns × 3 layers, less the hide's own cell
    expect(inside(3)).toBe(19);
    // the sleeper lies on top of the (solid) hide
    expect(isSolid(B.SLEEPING_HIDE)).toBe(true);
    // a spot that is not a solid block (the beds may be): the fill starts in its own cell, one cell more
    w.setBlock(0, Y, 0, B.AIR);
    expect(secureAt(secureEnvOf(w), 0, Y, 0)).toEqual({ secure: true, reason: '', cells: inside(3) * 3 });
    // with or without the generated-height shortcut the answer is the same
    const env = secureEnvOf(w);
    delete env.groundHeight;
    expect(secureAt(env, 0, Y, 0)).toEqual({ secure: true, reason: '', cells: inside(3) * 3 });
  });

  it('a bed is walked over, not a wall: the look starts in its own cell, and one in a doorway closes nothing', () => {
    // the beds (another package's GRASS_BED and BED) are low models you walk over, like a Snare: not solid
    expect(isSolid(B.SNARE)).toBe(false);
    const w = camp({ radius: 3, height: 3, roofY: Y + 3 });
    w.setBlock(0, Y, 0, B.SNARE); // standing in for a bed
    expect(secureAt(secureEnvOf(w), 0, Y, 0)).toEqual({ secure: true, reason: '', cells: inside(3) * 3 }); // its own cell counts
    const [dq, dr] = ringOf(3)[1];
    w.setBlock(dq, Y, dr, B.SNARE); // a "bed" in the doorway …
    w.setBlock(dq, Y + 1, dr, B.AIR);
    expect(secureAt(secureEnvOf(w), 0, Y, 0)).toMatchObject({ secure: false, reason: 'open to the outside' }); // … is no door
    // a bed on bare ground: its own column is built in, so a zombie cannot come up there; the ground round it still can
    const g = camp({ radius: 3, height: 5, floor: false });
    g.setBlock(0, Y, 0, B.SNARE);
    const zombies = new Zombies(mulberry32(2));
    expect(zombies.spawnHeightAt(zview(g), 0, 0)).toBeNull();
    expect(secureAt(secureEnvOf(g), 0, Y, 0).reason).toBe(SECURE_REASONS.ground);
  });

  it('a doorway left open → open to the outside; block it and the room is secure again', () => {
    const w = camp({ radius: 3, height: 3, roofY: Y + 3 });
    const [dq, dr] = ringOf(3)[4];
    w.setBlock(dq, Y, dr, B.AIR);
    w.setBlock(dq, Y + 1, dr, B.AIR);
    const res = secureAt(secureEnvOf(w), 0, Y, 0);
    expect(res.secure).toBe(false);
    expect(res.reason).toBe('open to the outside');
    expect(res.cells).toBeLessThan(SECURE_MAX_CELLS); // found by heading outward, not by filling the plain
    w.setBlock(dq, Y + 1, dr, B.COBBLESTONE);
    expect(secureAt(secureEnvOf(w), 0, Y, 0).reason).toBe('open to the outside'); // a one-cell gap is still a way through
    w.setBlock(dq, Y, dr, B.OAK_PLANKS);
    expect(secureAt(secureEnvOf(w), 0, Y, 0).secure).toBe(true);
    // a window in the roof is no way in while it is above the fifth layer, and one below it is
    const yard = camp({ radius: 3, height: 5, roofY: Y + 5 });
    yard.setBlock(1, Y + 5, 0, B.AIR);
    expect(secureAt(secureEnvOf(yard), 0, Y, 0).secure).toBe(true);
    const low = camp({ radius: 3, height: 3, roofY: Y + 3 });
    low.setBlock(1, Y + 3, 0, B.AIR);
    expect(secureAt(secureEnvOf(low), 0, Y, 0).reason).toBe('open to the outside');
  });

  it('a low wall under the open sky → open to the outside: 4 high is not enough, 5 is', () => {
    for (const height of [1, 2, 3, 4]) {
      const res = secureAt(secureEnvOf(camp({ radius: 3, height })), 0, Y, 0);
      expect([height, res.secure, res.reason]).toEqual([height, false, 'open to the outside']);
    }
    // a yard with walls 5 high and no roof: the fill stops at the fifth layer, and the sky above is no way in
    const yard = secureAt(secureEnvOf(camp({ radius: 3, height: 5 })), 0, Y, 0);
    expect(yard).toEqual({ secure: true, reason: '', cells: inside(3) * 5 - 1 });
    expect(secureAt(secureEnvOf(camp({ radius: 3, height: 9 })), 0, Y, 0)).toEqual(yard);
    // one battlement missing at the top
    const w = camp({ radius: 3, height: 5 });
    const [bq, br] = ringOf(3)[0];
    w.setBlock(bq, Y + 4, br, B.AIR);
    expect(secureAt(secureEnvOf(w), 0, Y, 0).reason).toBe('open to the outside');
  });

  it('bare natural ground inside the walls → zombies can come up from the ground inside; a floor mends it', () => {
    const w = camp({ radius: 3, height: 5, floor: false });
    const zombies = new Zombies(mulberry32(3));
    const view = zview(w);
    expect(zombies.spawnHeightAt(view, 1, 0)).toBe(Y); // untouched grass with air above: a zombie may come up here
    expect(zombies.spawnHeightAt(view, 0, 0)).toBeNull(); // the hide's own column is built in
    const res = secureAt(secureEnvOf(w), 0, Y, 0);
    expect(res).toEqual({ secure: false, reason: 'zombies can come up from the ground inside', cells: inside(3) * 5 - 1 });
    // without the zombies' rule the same walls would pass: it is the ground that fails them
    expect(secureAt({ getBlock: w.getBlock }, 0, Y, 0).secure).toBe(true);
    for (const [q, r] of disc(2)) w.setBlock(q, G, r, B.OAK_PLANKS);
    expect(secureAt(secureEnvOf(w), 0, Y, 0).secure).toBe(true);
    // one cell of the floor taken up again
    w.setBlock(2, G, -1, B.GRASS_BLOCK);
    expect(w.hasEdit(2, G, -1)).toBe(false); // back to what the land was: untouched ground again
    expect(secureAt(secureEnvOf(w), 0, Y, 0).reason).toBe(SECURE_REASONS.ground);
    // open walls AND bare ground: the walls are said first (close the place, then see to the floor)
    const open = camp({ radius: 3, height: 2, floor: false });
    expect(secureAt(secureEnvOf(open), 0, Y, 0).reason).toBe('open to the outside');
    // sleeping in the open
    const plain = grassland();
    plain.setBlock(0, Y, 0, B.SLEEPING_HIDE);
    expect(secureAt(secureEnvOf(plain), 0, Y, 0)).toMatchObject({ secure: false, reason: 'open to the outside' });
  });

  it('the ground rule is the zombies\' own: ground lit to 7 or more, or built over, is no way in (and a light that goes out is one again)', () => {
    const w = camp({ radius: 3, height: 5, floor: false });
    const lit = (level) => secureAt(secureEnvOf(w, { blockLight: (_q, y) => (y >= Y ? level : 0) }), 0, Y, 0);
    expect(lit(ZOMBIE_SPAWN_LIGHT_MAX).secure).toBe(true);
    expect(lit(15).secure).toBe(true);
    expect(lit(ZOMBIE_SPAWN_LIGHT_MAX - 1)).toMatchObject({ secure: false, reason: SECURE_REASONS.ground });
    expect(lit(0)).toMatchObject({ secure: false, reason: SECURE_REASONS.ground });
    expect(ZOMBIE_SPAWN_LIGHT_MAX).toBe(7);
  });

  it('a walled-off alcove of a cave is secure; a huge cave is not; nor is a tunnel that leads away or a shaft that leads down', () => {
    const rock = () => makeFakeWorld({ groundY: 40, groundId: B.STONE });
    const carve = (w, cells, y0, layers) => {
      for (const [q, r] of cells) for (let y = y0; y < y0 + layers; y++) w.put(q, y, r, B.AIR); // (terrain: a natural cave)
    };
    // an alcove: 7 columns, 3 high, rock all round
    const alcove = rock();
    carve(alcove, disc(1), 20, 3);
    alcove.setBlock(0, 20, 0, B.SLEEPING_HIDE);
    expect(secureAt(secureEnvOf(alcove), 0, 20, 0)).toEqual({ secure: true, reason: '', cells: 7 * 3 - 1 });
    // a hall of 271 columns, 5 high: sealed, but more than 800 open cells
    const hall = rock();
    carve(hall, disc(9), 20, 5);
    hall.setBlock(0, 20, 0, B.SLEEPING_HIDE);
    expect(disc(9).length * 5).toBeGreaterThan(SECURE_MAX_CELLS);
    expect(secureAt(secureEnvOf(hall), 0, 20, 0)).toEqual({ secure: false, reason: 'too big a place to keep watch over', cells: SECURE_MAX_CELLS });
    // the same hall 2 high has 541 cells: secure
    const lowHall = rock();
    carve(lowHall, disc(9), 20, 2);
    lowHall.setBlock(0, 20, 0, B.SLEEPING_HIDE);
    expect(secureAt(secureEnvOf(lowHall), 0, 20, 0)).toEqual({ secure: true, reason: '', cells: disc(9).length * 2 - 1 });
    // a tunnel leading 20 cells away from the alcove
    const tunnel = rock();
    carve(tunnel, disc(1), 20, 3);
    for (let q = 2; q <= 20; q++) for (let y = 20; y < 22; y++) tunnel.put(q, y, 0, B.AIR);
    tunnel.setBlock(0, 20, 0, B.SLEEPING_HIDE);
    expect(secureAt(secureEnvOf(tunnel), 0, 20, 0)).toMatchObject({ secure: false, reason: 'open to the outside' });
    // a shaft: 12 cells down is still inside the look, 13 is a way that leads off
    const shaft = (depth) => {
      const w = rock();
      carve(w, disc(1), 20, 3);
      for (let y = 20 - depth; y < 20; y++) w.put(1, y, 0, B.AIR);
      w.setBlock(0, 20, 0, B.SLEEPING_HIDE);
      return secureAt(secureEnvOf(w), 0, 20, 0);
    };
    expect(shaft(SECURE_RADIUS)).toEqual({ secure: true, reason: '', cells: 7 * 3 - 1 + 12 });
    expect(shaft(SECURE_RADIUS + 1)).toMatchObject({ secure: false, reason: 'open to the outside' });
    // a hole in the alcove's roof higher than the fifth layer is not looked at (a chimney is fine)
    const chimney = rock();
    carve(chimney, disc(1), 20, 5);
    for (let y = 25; y <= 40; y++) chimney.put(0, y, 0, B.AIR);
    chimney.setBlock(0, 20, 0, B.SLEEPING_HIDE);
    expect(secureAt(secureEnvOf(chimney), 0, 20, 0)).toEqual({ secure: true, reason: '', cells: 7 * 5 - 1 });
  });

  it('the reach: walls 12 cells out still close a place; an open cell 13 out is the outside', () => {
    const flat = (wallRing) => {
      const w = makeFakeWorld({ groundY: 40, groundId: B.STONE });
      for (const [q, r] of disc(wallRing - 1)) w.put(q, 20, r, B.AIR); // one layer high: the rock above is the roof
      return secureAt(secureEnvOf(w), 0, 20, 0); // (a spot that is not solid: the fill starts in its own cell)
    };
    expect(flat(13)).toEqual({ secure: true, reason: '', cells: disc(12).length }); // 469 cells, the farthest 12 out
    expect(disc(12).length).toBe(469);
    expect(flat(14)).toMatchObject({ secure: false, reason: 'open to the outside' });
    // the cell cap by itself: 2 layers of a radius-12 room are 938 cells
    const w = makeFakeWorld({ groundY: 40, groundId: B.STONE });
    for (const [q, r] of disc(12)) for (let y = 20; y < 22; y++) w.put(q, y, r, B.AIR);
    expect(secureAt(secureEnvOf(w), 0, 20, 0)).toEqual({ secure: false, reason: SECURE_REASONS.big, cells: 800 });
  });

  it('a spot buried under a block: the look starts beside it; one with no open cell round it has nothing to fear', () => {
    const w = camp({ radius: 3, height: 3, roofY: Y + 3 });
    w.setBlock(0, Y + 1, 0, B.COBBLESTONE);
    expect(secureAt(secureEnvOf(w), 0, Y, 0)).toEqual({ secure: true, reason: '', cells: inside(3) * 3 - 2 });
    const rock = makeFakeWorld({ groundY: 40, groundId: B.STONE });
    expect(secureAt(secureEnvOf(rock), 0, 20, 0)).toEqual({ secure: true, reason: '', cells: 0 });
  });

  it('it is cheap: at most 8 block reads a cell (6 401 at the cap), one spawn look a column; the open plain in a few steps', () => {
    const w = camp({ radius: 6, height: 5 });
    // counted, not timed (a count does not change with the machine's load): every open cell reads its 6 sides, up and down
    let looks = 0;
    let spawnLooks = 0;
    const counted = secureEnvOf(w);
    const spawnY = counted.spawnY;
    const env = { ...counted, getBlock: (q, y, r) => (looks++, w.getBlock(q, y, r)), spawnY: (q, r) => (spawnLooks++, spawnY(q, r)) };
    const yard = secureAt(env, 0, Y, 0);
    expect(yard).toEqual({ secure: true, reason: '', cells: inside(6) * 5 - 1 }); // 454 cells
    expect(looks).toBeLessThanOrEqual(8 * yard.cells + 1);
    expect(spawnLooks).toBeLessThanOrEqual(inside(6)); // once a column, and only at its ground level
    expect(8 * SECURE_MAX_CELLS + 1).toBe(6401); // the most a look can ever cost
    // timed only loosely, as a guard against an accident (about 0.2 ms on a quiet machine)
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) secureAt(secureEnvOf(w), 0, Y, 0);
    expect((performance.now() - t0) / 10).toBeLessThan(50);
    let reads = 0;
    const plain = grassland();
    const res = secureAt({ getBlock: (q, y, r) => (reads++, plain.getBlock(q, y, r)) }, 0, Y, 0);
    expect(res.reason).toBe('open to the outside');
    expect(res.cells).toBeLessThanOrEqual(SECURE_RADIUS + 1); // straight out: the farthest cell first
    expect(reads).toBeLessThan(200);
  });
});

describe('worked out once, and again when a block changes (SecureWatch)', () => {
  it('watch a spot: one look, kept; a block changing within reach makes it stale; far away does not', () => {
    const w = camp({ radius: 3, height: 3, roofY: Y + 3 });
    const env = secureEnvOf(w);
    const watch = new SecureWatch();
    expect(watch.get(env)).toBeNull();
    w.onBlockChange = (q, y, r) => watch.blockChanged(q, y, r); // as main's onBlockChanged does
    watch.watch(0, Y, 0);
    expect(watch.get(env)).toMatchObject({ secure: true });
    expect(watch.computed).toBe(1);
    for (let i = 0; i < 5; i++) watch.get(env);
    expect(watch.computed).toBe(1);
    // far away: nothing to do with this place
    expect(SECURE_WATCH).toBe(SECURE_RADIUS + 8);
    w.setBlock(SECURE_WATCH + 1, Y, 0, B.COBBLESTONE);
    w.setBlock(0, Y, SECURE_WATCH + 5, B.COBBLESTONE);
    watch.get(env);
    expect(watch.computed).toBe(1);
    // the door is opened
    const [dq, dr] = ringOf(3)[2];
    w.setBlock(dq, Y, dr, B.AIR);
    expect(watch.dirty).toBe(true);
    expect(watch.get(env)).toMatchObject({ secure: false, reason: 'open to the outside' });
    expect(watch.computed).toBe(2);
    // and closed again
    w.setBlock(dq, Y, dr, B.COBBLESTONE);
    expect(watch.get(env)).toMatchObject({ secure: true });
    expect(watch.computed).toBe(3);
    // several changes before the next look: one look
    w.setBlock(1, Y + 1, 0, B.COBBLESTONE);
    w.setBlock(1, Y + 1, 0, B.AIR);
    w.setBlock(-1, Y + 2, 0, B.TORCH);
    watch.get(env);
    expect(watch.computed).toBe(4);
    // a change just inside the watch's reach (a light out there may reach the ground inside)
    w.setBlock(SECURE_WATCH, Y, 0, B.COBBLESTONE);
    expect(watch.dirty).toBe(true);
  });

  it('touch() asks for another look (a light that went out without a block changing); another spot forgets the answer', () => {
    const w = camp({ radius: 3, height: 5, floor: false });
    let light = 12;
    const env = secureEnvOf(w, { blockLight: (_q, y) => (y >= Y ? light : 0) });
    const watch = new SecureWatch();
    watch.watch(0, Y, 0);
    expect(watch.get(env).secure).toBe(true); // lit ground: nothing comes up
    light = 0; // the lamp went out
    expect(watch.get(env).secure).toBe(true); // not looked at again yet
    watch.touch();
    expect(watch.get(env)).toMatchObject({ secure: false, reason: SECURE_REASONS.ground });
    watch.watch(0, Y, 0); // the same spot: nothing forgotten
    expect(watch.computed).toBe(2);
    watch.get(env);
    expect(watch.computed).toBe(2);
    watch.watch(1, Y, 0);
    expect(watch.result).toBeNull();
    watch.get(env);
    expect(watch.computed).toBe(3);
    watch.clear();
    expect([watch.cell, watch.result, watch.get(env)]).toEqual([null, null, null]);
    watch.blockChanged(0, Y, 0); // nothing watched: nothing to do
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The night comes for you
// ---------------------------------------------------------------------------------------------------------------------

describe('the night attack: its chance by the light (rollNightAttack)', () => {
  it('0.2 an hour in the dark; light takes up to three quarters of it off (full from 12); never nothing', () => {
    expect([NIGHT_ATTACK_P, LIGHT_GUARD, LIGHT_GUARD_FULL]).toEqual([0.2, 0.75, 12]);
    expect(nightAttackChance(0)).toBe(0.2);
    expect(nightAttackChance(12)).toBeCloseTo(0.05, 12);
    expect(nightAttackChance(15)).toBeCloseTo(0.05, 12);
    expect(nightAttackChance(6)).toBeCloseTo(0.2 * (1 - 0.75 * 0.5), 12);
    expect(nightAttackChance(-3)).toBe(0.2);
    expect(nightAttackChance(NaN)).toBe(0.2);
    for (let l = 1; l <= 15; l++) {
      expect(nightAttackChance(l)).toBeLessThanOrEqual(nightAttackChance(l - 1));
      expect(nightAttackChance(l)).toBeGreaterThan(0); // light alone never makes it zero
    }
    // a Torch or a campfire in the next cell gives the full guard: "a quarter"
    expect(nightAttackChance(TORCH_LIGHT - 1) / NIGHT_ATTACK_P).toBeCloseTo(0.25, 12);
    expect(nightAttackChance(CAMPFIRE_LIGHT - 1) / NIGHT_ATTACK_P).toBeCloseTo(0.25, 12);
  });

  it('never by day, never in a secure place, never in a world without zombies: no roll is even drawn', () => {
    let draws = 0;
    const always = () => (draws++, 0); // a roll that would always hit
    const night = { isDay: false, secure: false, zombiesOn: true, light: 0 };
    expect(rollNightAttack({ ...night, isDay: true }, always)).toBe(false);
    expect(rollNightAttack({ ...night, secure: true }, always)).toBe(false);
    expect(rollNightAttack({ ...night, zombiesOn: false }, always)).toBe(false);
    expect(rollNightAttack({ ...night, secure: true, light: 0, isDay: false }, always)).toBe(false);
    expect(draws).toBe(0);
    expect(rollNightAttack(night, always)).toBe(true);
    expect(draws).toBe(1);
    expect(rollNightAttack(night, () => 0.1999)).toBe(true);
    expect(rollNightAttack(night, () => 0.2)).toBe(false);
    expect(rollNightAttack({ ...night, light: 14 }, () => 0.0499)).toBe(true);
    expect(rollNightAttack({ ...night, light: 14 }, () => 0.05)).toBe(false);
  });

  it('by simulation: one hour in five in the dark, one in twenty beside a fire, one in eight in half light', () => {
    const rate = (light, seed) => {
      const rng = mulberry32(seed);
      let hits = 0;
      const n = 40000;
      for (let i = 0; i < n; i++) if (rollNightAttack({ isDay: false, secure: false, zombiesOn: true, light }, rng)) hits++;
      return hits / n;
    };
    expect(rate(0, 11)).toBeCloseTo(0.2, 2);
    expect(rate(13, 12)).toBeCloseTo(0.05, 2);
    expect(rate(6, 13)).toBeCloseTo(0.125, 2);
    expect(rate(3, 14)).toBeCloseTo(0.2 * (1 - 0.75 * 0.25), 2);
  });

  it('by simulation, whole nights of 8 hours through Sleep: attacked 5 nights in 6 in the dark, 1 in 3 beside a fire, never when secure or by day', () => {
    const nights = (c, seed, n = 3000) => {
      const rng = mulberry32(seed);
      let attacked = 0;
      let hours = 0;
      for (let i = 0; i < n; i++) {
        const sl = new Sleep();
        sl.lie(HIDE, [0, Y, 0]);
        const res = sl.advance(SLEEP_FULL_H * HOUR, {
          second: () => ({ satiation: 80, hydration: 80, fatigue: 30, isDay: c.isDay }),
          hour: () => rollNightAttack(c, rng),
        });
        if (res.woke === 'attack') attacked++;
        hours += res.ticks / HOUR;
      }
      return { share: attacked / n, hours: hours / n };
    };
    const dark = nights({ isDay: false, secure: false, zombiesOn: true, light: 0 }, 21);
    expect(dark.share).toBeCloseTo(1 - 0.8 ** 8, 1); // 0.83
    expect(dark.share).toBeGreaterThan(0.79);
    expect(dark.hours).toBeLessThan(5); // and it comes early: such a night is 3 or 4 hours long
    const fire = nights({ isDay: false, secure: false, zombiesOn: true, light: 13 }, 22);
    expect(fire.share).toBeCloseTo(1 - 0.95 ** 8, 1); // 0.34
    expect(fire.share).toBeGreaterThan(0.28); // lowered, never eliminated
    expect(fire.share).toBeLessThan(0.4);
    expect(nights({ isDay: false, secure: true, zombiesOn: true, light: 0 }, 23, 300)).toEqual({ share: 0, hours: 8 });
    expect(nights({ isDay: true, secure: false, zombiesOn: true, light: 0 }, 24, 300)).toEqual({ share: 0, hours: 8 });
    expect(nights({ isDay: false, secure: false, zombiesOn: false, light: 0 }, 25, 300)).toEqual({ share: 0, hours: 8 });
  });
});

describe('the night attack: zombies really placed, only where the zombies module lets one come up (placeNightAttack)', () => {
  const distance = (zb) => Math.hypot(zb.x, zb.z);

  it('one or two zombies, 10 to 18 cells off, standing on the ground, in the zombies\' own list, facing the sleeper', () => {
    expect([ATTACK_MIN, ATTACK_MAX, ATTACK_PAIR_P, ATTACK_RUNNER_P]).toEqual([10, 18, 0.35, RUNNER_P]);
    const w = grassland();
    const view = zview(w);
    const counts = { 1: 0, 2: 0 };
    const kinds = { walker: 0, runner: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const zombies = new Zombies(rng);
      const placed = placeNightAttack(zombies, view, 0, 0, rng);
      expect(placed.length === 1 || placed.length === 2, `seed ${seed}`).toBe(true);
      counts[placed.length]++;
      expect(zombies.list).toEqual(placed); // real zombies, in the list every other system reads
      for (const zb of placed) {
        expect(distance(zb), `seed ${seed}`).toBeGreaterThanOrEqual(ATTACK_MIN);
        expect(distance(zb), `seed ${seed}`).toBeLessThanOrEqual(ATTACK_MAX);
        expect(zb.y).toBe(Y); // on the ground: where spawnHeightAt says
        const [q, r] = worldToHex(zb.x, zb.z);
        expect(hexToWorld(q, r)).toEqual([zb.x, zb.z]); // in the middle of a cell
        expect(zombies.spawnHeightAt(view, q, r)).toBe(Y);
        kinds[zb.kind]++;
        // it faces the sleeper
        expect(Math.hypot(zb.x - Math.sin(zb.yaw), zb.z - Math.cos(zb.yaw))).toBeLessThan(distance(zb));
      }
      if (placed.length === 2) expect(Math.hypot(placed[0].x - placed[1].x, placed[0].z - placed[1].z)).toBeLessThanOrEqual(ATTACK_PAIR);
    }
    expect(counts[2] / 300).toBeCloseTo(ATTACK_PAIR_P, 1);
    expect(kinds.runner).toBeGreaterThan(0);
    expect(kinds.runner).toBeLessThan(kinds.walker / 3);
    // off-centre sleepers too
    const rng = mulberry32(9);
    const zombies = new Zombies(rng);
    const placed = placeNightAttack(zombies, view, 40.3, -17.6, rng);
    for (const zb of placed) {
      const d = Math.hypot(zb.x - 40.3, zb.z + 17.6);
      expect(d >= ATTACK_MIN && d <= ATTACK_MAX).toBe(true);
    }
  });

  it('none when the world\'s zombies are switched off, when the list is full, or with nonsense for a place', () => {
    const w = grassland();
    const view = zview(w);
    const rng = mulberry32(5);
    const off = new Zombies(rng);
    off.setEnabled(false);
    expect(placeNightAttack(off, view, 0, 0, rng)).toEqual([]);
    expect(off.list).toEqual([]);
    const full = new Zombies(rng);
    for (let i = 0; i < ZOMBIE_MAX; i++) full.spawn(100 + i, Y, 0);
    expect(placeNightAttack(full, view, 0, 0, rng)).toEqual([]);
    expect(full.list).toHaveLength(ZOMBIE_MAX);
    expect(placeNightAttack(new Zombies(rng), view, NaN, 0, rng)).toEqual([]);
    expect(placeNightAttack(/** @type {any} */ (null), view, 0, 0, rng)).toEqual([]);
  });

  it('lit ground is never a place they come from; with no valid ground in the ring there is no attack', () => {
    const w = grassland();
    const rng = mulberry32(6);
    // the whole land lit to 7: no spawn anywhere
    const lit = zview(w, { blockLight: (_q, y) => (y >= Y ? ZOMBIE_SPAWN_LIGHT_MAX : 0) });
    const z1 = new Zombies(rng);
    for (let i = 0; i < 50; i++) expect(placeNightAttack(z1, lit, 0, 0, rng)).toEqual([]);
    expect(z1.list).toEqual([]);
    // every column of the ring built over
    const built = zview(w, { columnEdited: () => true });
    expect(placeNightAttack(new Zombies(rng), built, 0, 0, rng)).toEqual([]);
    // a lit half: they only ever come up in the dark half
    const half = zview(w, { blockLight: (q, y) => (q >= 0 && y >= Y ? 12 : 0) });
    for (let seed = 1; seed <= 100; seed++) {
      const r2 = mulberry32(seed);
      const z2 = new Zombies(r2);
      for (const zb of placeNightAttack(z2, half, 0, 0, r2)) expect(worldToHex(zb.x, zb.z)[0]).toBeLessThan(0);
    }
    // one valid column left in the whole ring: that is where it comes up, alone
    const one = zview(w, { columnEdited: (q, r) => !(q === 12 && r === 0) });
    for (let seed = 1; seed <= 20; seed++) {
      const r3 = mulberry32(seed);
      const z3 = new Zombies(r3);
      const placed = placeNightAttack(z3, one, 0, 0, r3);
      expect(placed).toHaveLength(1);
      expect(worldToHex(placed[0].x, placed[0].z)).toEqual([12, 0]);
    }
    // ground too near or too far does not count: the only untouched column is 5 cells off, or 25
    for (const q of [5, 9, 19, 25]) {
      const r4 = mulberry32(q);
      expect(placeNightAttack(new Zombies(r4), zview(w, { columnEdited: (cq, cr) => !(cq === q && cr === 0) }), 0, 0, r4), String(q)).toEqual([]);
    }
  });

  it('dim light thins them out exactly as it thins natural spawning: on ground lit to 3, four tries in seven', () => {
    const w = grassland();
    const dim = zview(w, { blockLight: (_q, y) => (y >= Y ? 3 : 0) });
    expect(spawnChance(3)).toBeCloseTo(4 / 7, 12);
    const rng = mulberry32(31);
    let came = 0;
    const n = 4000;
    const zombies = new Zombies(rng);
    for (let i = 0; i < n; i++) {
      zombies.clear();
      if (placeNightAttack(zombies, dim, 0, 0, rng).length > 0) came++;
    }
    expect(came / n).toBeCloseTo(4 / 7, 1);
    expect(Math.abs(came / n - 4 / 7)).toBeLessThan(0.03);
    // in the dark every attack that is rolled comes
    const dark = zview(w);
    for (let i = 0; i < 200; i++) {
      zombies.clear();
      expect(placeNightAttack(zombies, dark, 0, 0, rng).length).toBeGreaterThan(0);
    }
  });

  it('a camp: the attackers come up outside the walls, never inside a floored yard', () => {
    const w = camp({ radius: 8, height: 5 }); // a big floored yard
    const view = zview(w);
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed);
      const zombies = new Zombies(rng);
      for (const zb of placeNightAttack(zombies, view, 0, 0, rng)) {
        const [q, r] = worldToHex(zb.x, zb.z);
        expect(hexLength(q, r)).toBeGreaterThan(8);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Awake too long
// ---------------------------------------------------------------------------------------------------------------------

/** A player's view at the eye (0, 11.6, 0) looking along −Z over flat ground at y = 10. */
const viewOf = (over = {}) => ({ stage: 4, awake: true, x: 0, y: 11.6, z: 0, yaw: 0, pitch: 0, standAt: () => 10, ...over });
/** Run TiredFx for `seconds` at 60 frames a second; `each(fx, t, out)` after every step. */
function runFx(fx, view, seconds, rng, each) {
  const dt = 1 / 60;
  for (let f = 0; f < seconds * 60; f++) {
    const out = fx.step(dt, typeof view === 'function' ? view(f * dt) : view, rng);
    if (each) each(fx, (f + 1) * dt, out);
  }
}

describe('tired eyes: the blur, the nod, the figure\'s fade (pure curves)', () => {
  it('the blur: nothing before Exhausted, then a soft slow wave, a little stronger with each stage; it never jumps', () => {
    expect(BLUR_PX).toEqual([0, 0, 1.4, 1.9, 2.4]);
    expect(Math.max(...BLUR_PX)).toBeLessThanOrEqual(2.5); // soft
    expect(BLUR_WAVE_S).toBeGreaterThanOrEqual(6); // slow: no flicker, nothing to feel sick from
    for (const t of [0, 1, 4.5, 100]) expect([blurPx(0, t), blurPx(1, t)]).toEqual([0, 0]);
    for (const stage of [2, 3, 4]) {
      let lo = Infinity;
      let hi = 0;
      let step = 0;
      let prev = blurPx(stage, 0);
      for (let t = 0; t <= 2 * BLUR_WAVE_S; t += 1 / 60) {
        const px = blurPx(stage, t);
        lo = Math.min(lo, px);
        hi = Math.max(hi, px);
        step = Math.max(step, Math.abs(px - prev));
        prev = px;
      }
      expect(hi).toBeCloseTo(BLUR_PX[stage], 3);
      expect(lo).toBeCloseTo(BLUR_PX[stage] * BLUR_FLOOR, 3);
      expect(step).toBeLessThan(0.02); // under a fiftieth of a pixel a frame
      expect(blurPx(stage, 3)).toBeCloseTo(blurPx(stage, 3 + BLUR_WAVE_S), 9);
    }
    expect(blurPx(4, 4.5)).toBeGreaterThan(blurPx(3, 4.5));
    expect(blurPx(3, 4.5)).toBeGreaterThan(blurPx(2, 4.5));
    expect(blurPx(7, 1)).toBe(0);
    expect(blurPx(2, NaN)).toBeCloseTo(BLUR_PX[2] * BLUR_FLOOR, 9);
  });

  it('a nod: the screen closes for 0.4 s, going dark and coming back over a tenth of a second each (no hard cut)', () => {
    expect([NOD_S, NOD_EDGE_S]).toEqual([0.4, 0.1]);
    expect(nodDark(NOD_S)).toBe(0);
    expect(nodDark(0)).toBe(0);
    expect(nodDark(0.2)).toBe(1);
    expect(nodDark(0.35)).toBeCloseTo(0.5, 9);
    expect(nodDark(0.05)).toBeCloseTo(0.5, 9);
    expect(nodDark(-1)).toBe(0);
    expect(nodDark(9)).toBe(0);
    let prev = 0;
    for (let left = NOD_S; left >= 0; left -= 1 / 60) {
      const d = nodDark(left);
      expect(Math.abs(d - prev)).toBeLessThanOrEqual(1 / 60 / NOD_EDGE_S + 1e-9);
      prev = d;
    }
    expect(NOD_EVERY_S).toEqual([20, 40]); // one dark blink in 20 to 40 seconds: nothing flashes
  });

  it('the figure\'s opacity: up over 0.4 s to a half at the most, fading from then on, gone within 2 s', () => {
    expect([FIGURE_S, FIGURE_IN_S, FIGURE_ALPHA]).toEqual([2, 0.4, 0.5]);
    expect(figureAlpha(0)).toBe(0);
    expect(figureAlpha(FIGURE_IN_S)).toBeCloseTo(FIGURE_ALPHA, 9);
    expect(figureAlpha(1.2)).toBeCloseTo(FIGURE_ALPHA / 2, 9);
    expect(figureAlpha(2)).toBe(0);
    expect(figureAlpha(5)).toBe(0);
    expect(figureAlpha(-1)).toBe(0);
    for (let t = 0; t <= 2; t += 0.01) expect(figureAlpha(t)).toBeLessThanOrEqual(FIGURE_ALPHA + 1e-12);
  });

  it('angleFromView: 0 straight ahead (yaw 0 looks along −Z), π behind, and the pitch counts', () => {
    expect(angleFromView(0, 0, 0, 0, 0, 0, 0, -5)).toBeCloseTo(0, 9);
    expect(angleFromView(0, 0, 0, 0, 0, 0, 0, 5)).toBeCloseTo(Math.PI, 9);
    expect(angleFromView(0, 0, 0, 0, 0, -5, 0, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(angleFromView(Math.PI / 2, 0, 0, 0, 0, -5, 0, 0)).toBeCloseTo(0, 9); // positive yaw turns left
    expect(angleFromView(0, Math.PI / 4, 0, 0, 0, 0, 5, -5)).toBeCloseTo(0, 9); // positive pitch looks up
    expect(angleFromView(0, -Math.PI / 2, 0, 0, 0, 0, 0, -5)).toBeCloseTo(Math.PI / 2, 9);
    expect(angleFromView(1, 0.3, 2, 3, 4, 2, 3, 4)).toBe(0);
  });
});

describe('awake too long: yawns, sounds with nothing there, the figure, the nods (TiredFx)', () => {
  it('nothing at all while rested; from Tired a yawn every 50 to 110 s and nothing else; the rest only when Seeing things', () => {
    const rng = mulberry32(41);
    const rested = new TiredFx();
    const heard = [];
    runFx(rested, viewOf({ stage: 0 }), 600, rng, (_fx, _t, out) => heard.push(...out.sounds));
    expect(heard).toEqual([]);
    expect([rested.figure, rested.nod, rested.dark, rested.figures, rested.nods, rested.sounds]).toEqual([null, 0, 0, 0, 0, 0]);
    for (const stage of [1, 2, 3]) {
      const fx = new TiredFx();
      const times = [];
      let other = 0;
      runFx(fx, viewOf({ stage }), 1800, rng, (_fx, t, out) => {
        for (const s of out.sounds) {
          expect(s).toEqual(['yawn', YAWN_VOLUME]);
          times.push(t);
        }
        if (fx.figure !== null || fx.dark !== 0) other++;
      });
      expect(other).toBe(0); // no figure and no nod at any frame
      expect(times.length).toBeGreaterThanOrEqual(Math.floor(1800 / YAWN_EVERY_S[1]));
      expect(times.length).toBeLessThanOrEqual(Math.ceil(1800 / YAWN_EVERY_S[0]));
      expect(times[0]).toBeGreaterThanOrEqual(YAWN_EVERY_S[0] - 0.02);
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(YAWN_EVERY_S[0] - 0.02);
        expect(times[i] - times[i - 1]).toBeLessThanOrEqual(YAWN_EVERY_S[1] + 0.02);
      }
      expect([fx.figures, fx.nods, fx.sounds]).toEqual([0, 0, 0]);
    }
    expect(YAWN_EVERY_S).toEqual([50, 110]);
    expect(YAWN_VOLUME).toBeLessThanOrEqual(1);
  });

  it('Seeing things: sounds with nothing there, quiet ones from the bank, never closer together than 25 s', () => {
    expect(PHANTOM_SOUND_EVERY_S).toEqual([25, 55]);
    expect(PHANTOM_SOUNDS.map((s) => s[0])).toEqual(['zombieGroan', 'stepGrass', 'digWood']); // a far groan, a footstep, a twig
    for (const [name, volume] of PHANTOM_SOUNDS) {
      expect(SOUND_BANK[name], name).toBeTruthy(); // existing recipes
      expect(volume).toBeLessThanOrEqual(0.6);
    }
    const fx = new TiredFx();
    const rng = mulberry32(42);
    const times = [];
    const names = new Set();
    runFx(fx, viewOf(), 3600, rng, (_fx, t, out) => {
      for (const s of out.sounds) {
        if (s[0] === 'yawn') continue;
        expect(PHANTOM_SOUNDS).toContainEqual(s);
        names.add(s[0]);
        times.push(t);
      }
    });
    expect(names.size).toBe(3);
    expect(fx.sounds).toBe(times.length);
    expect(times.length).toBeGreaterThan(3600 / 55 - 2);
    expect(times.length).toBeLessThan(3600 / 25 + 1);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(25 - 0.02);
  });

  it('the nods: one every 20 to 40 s, each 0.4 s of dark and no more', () => {
    const fx = new TiredFx();
    const rng = mulberry32(43);
    const starts = [];
    let darkFor = 0;
    let longest = 0;
    let was = 0;
    runFx(fx, viewOf(), 1800, rng, (_fx, t) => {
      if (fx.nods > was) {
        was = fx.nods;
        starts.push(t);
      }
      if (fx.dark > 0) darkFor += 1 / 60;
      else {
        longest = Math.max(longest, darkFor);
        darkFor = 0;
      }
      expect(fx.dark).toBeLessThanOrEqual(1);
    });
    expect(starts.length).toBeGreaterThanOrEqual(1800 / 40 - 1);
    expect(starts.length).toBeLessThanOrEqual(1800 / 20);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(20 - 0.02);
      expect(starts[i] - starts[i - 1]).toBeLessThanOrEqual(40 + 0.02);
    }
    expect(longest).toBeLessThanOrEqual(NOD_S + 1 / 60);
    expect(longest).toBeGreaterThan(NOD_S - 3 / 60);
    // the screen is dark for a hundredth of the time or so
    expect((starts.length * NOD_S) / 1800).toBeLessThan(0.021);
  });

  it('the figure: 12 to 20 cells off, at the edge of sight, at most one, at most one every 20 s, gone within 2 s', () => {
    expect([FIGURE_MIN, FIGURE_MAX]).toEqual([12, 20]);
    expect(FIGURE_EVERY_S).toEqual([20, 40]);
    expect(FIGURE_SIDE[0]).toBeGreaterThan(FIGURE_LOOK); // it appears outside the middle of the view …
    expect(FIGURE_SIDE[1]).toBeLessThan(Math.atan(Math.tan((35 * Math.PI) / 180) * (4 / 3))); // … and inside a 4:3 screen's width
    expect(FIGURE_LOOK).toBeCloseTo((25 * Math.PI) / 180, 2);
    for (const seed of [44, 45, 46]) {
      const fx = new TiredFx();
      const rng = mulberry32(seed);
      const view = viewOf();
      const starts = [];
      const lives = [];
      let current = null;
      let born = 0;
      const sides = new Set();
      runFx(fx, view, 2400, rng, (_fx, t) => {
        const f = fx.figure;
        if (f !== current) {
          if (current) lives.push(t - born);
          if (f) {
            starts.push(t);
            born = t;
            sides.add(Math.sign(f.x));
          }
          current = f;
        }
        if (!f) return;
        // never near, never in the middle of the view, never bright
        const dist = Math.hypot(f.x - view.x, f.z - view.z);
        expect(dist).toBeGreaterThanOrEqual(FIGURE_MIN);
        expect(dist).toBeLessThanOrEqual(FIGURE_MAX);
        expect(angleFromView(view.yaw, view.pitch, view.x, view.y, view.z, f.x, f.y + FIGURE_HEIGHT / 2, f.z)).toBeGreaterThanOrEqual(FIGURE_LOOK);
        expect(f.alpha).toBeLessThanOrEqual(FIGURE_ALPHA);
        expect(f.y).toBe(10); // standing where there is a place to stand
        expect(hexToWorld(...worldToHex(f.x, f.z))).toEqual([f.x, f.z]);
      });
      expect(starts.length, `seed ${seed}`).toBe(fx.figures);
      expect(starts.length).toBeGreaterThan(2400 / 50);
      expect(starts.length).toBeLessThanOrEqual(2400 / 20);
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1], `seed ${seed}`).toBeGreaterThanOrEqual(20 - 0.02);
      expect(starts[0]).toBeGreaterThanOrEqual(20 - 0.02); // not the moment the stage begins
      for (const life of lives) expect(life).toBeLessThanOrEqual(FIGURE_S + 1 / 60 + 1e-9);
      expect(Math.max(...lives)).toBeGreaterThan(FIGURE_S - 0.1); // left alone it fades by itself
      expect(sides.size).toBe(2); // to the left and to the right
    }
  });

  it('whatever the player does: turning and walking for an hour, the figure is never near and never in the middle of the view', () => {
    const fx = new TiredFx();
    const rng = mulberry32(47);
    const view = viewOf();
    let seen = 0;
    runFx(fx, (t) => {
      view.yaw = 2 * Math.sin(t * 0.7) + t * 0.05; // looking about
      view.pitch = 0.5 * Math.sin(t * 0.23);
      view.x = 6 * Math.sin(t * 0.11); // and wandering
      view.z = 4 * Math.cos(t * 0.07);
      return view;
    }, 3600, rng, () => {
      const f = fx.figure;
      if (!f) return;
      seen++;
      const dist = Math.hypot(f.x - view.x, f.z - view.z);
      expect(dist).toBeGreaterThanOrEqual(FIGURE_MIN);
      expect(dist).toBeGreaterThanOrEqual(f.d0 - FIGURE_NEARER);
      expect(angleFromView(view.yaw, view.pitch, view.x, view.y, view.z, f.x, f.y + FIGURE_HEIGHT / 2, f.z)).toBeGreaterThanOrEqual(FIGURE_LOOK);
    });
    expect(seen).toBeGreaterThan(100);
    expect(fx.figures).toBeGreaterThan(20);
  });

  it('look toward it and it is gone at once; come nearer and it is gone at once', () => {
    const appear = (seed) => {
      const fx = new TiredFx();
      const rng = mulberry32(seed);
      const view = viewOf();
      for (let f = 0; f < 60 * 60 && !fx.figure; f++) fx.step(1 / 60, view, rng);
      expect(fx.figure).toBeTruthy();
      return { fx, rng, view, f: fx.figure };
    };
    // a glance: the view's middle comes within 25° of it
    const a = appear(48);
    a.view.yaw = Math.atan2(-(a.f.x - a.view.x), -(a.f.z - a.view.z)) + 0.3; // 17° off it
    a.fx.step(1 / 60, a.view, a.rng);
    expect(a.fx.figure).toBeNull();
    // a look that stays 30° off it leaves it be
    const b = appear(48);
    const toward = Math.atan2(-(b.f.x - b.view.x), -(b.f.z - b.view.z));
    b.view.yaw = toward + Math.sign(b.view.yaw - toward || 1) * 0.5;
    b.fx.step(1 / 60, b.view, b.rng);
    expect(b.fx.figure).toBe(b.f);
    // a step toward it
    const c = appear(49);
    const d = Math.hypot(c.f.x, c.f.z);
    c.view.x = (c.f.x / d) * (FIGURE_NEARER + 0.05);
    c.view.z = (c.f.z / d) * (FIGURE_NEARER + 0.05);
    c.fx.step(1 / 60, c.view, c.rng);
    expect(c.fx.figure).toBeNull();
    // a step away from it does nothing
    const e = appear(49);
    e.view.x = -(e.f.x / d) * 0.5;
    e.view.z = -(e.f.z / d) * 0.5;
    e.fx.step(1 / 60, e.view, e.rng);
    expect(e.fx.figure).toBe(e.f);
    // sleep, a menu, death or a milder stage: gone, and the timers start again
    for (const over of [{ awake: false }, { stage: 3 }, { stage: 0 }]) {
      const g = appear(50);
      g.fx.nod = 0.3;
      g.fx.step(1 / 60, viewOf(over), g.rng);
      expect([g.fx.figure, g.fx.nod, g.fx.dark]).toEqual([null, 0, 0]);
      expect(Number.isNaN(g.fx.figureIn) && Number.isNaN(g.fx.nodIn) && Number.isNaN(g.fx.soundIn)).toBe(true);
    }
    // a frozen frame (a paused game) changes nothing
    const h = appear(51);
    const age = h.f.age;
    expect(h.fx.step(0, viewOf({ awake: false }), h.rng)).toEqual({ sounds: [] });
    expect([h.fx.figure, h.f.age]).toEqual([h.f, age]);
  });

  it('it is drawing only: a place and an opacity, never a zombie, never in a zombie list, never targetable', () => {
    const fx = new TiredFx();
    const rng = mulberry32(52);
    const zombies = new Zombies(rng);
    const view = viewOf();
    let checked = 0;
    runFx(fx, view, 600, rng, () => {
      expect(zombies.list).toHaveLength(0);
      const f = fx.figure;
      if (!f) return;
      checked++;
      expect(Object.keys(f)).toEqual(['x', 'y', 'z', 'yaw', 'age', 'alpha', 'd0']); // no id, no kind, no body, no velocity
      expect(zombies.list.includes(/** @type {any} */ (f))).toBe(false);
      // a ray straight at it hits nothing
      const dx = f.x - view.x;
      const dy = f.y + 0.9 - view.y;
      const dz = f.z - view.z;
      const len = Math.hypot(dx, dy, dz);
      expect(zombies.raycast(view.x, view.y, view.z, dx / len, dy / len, dz / len, 64)).toBeNull();
    });
    expect(checked).toBeGreaterThan(0);
    // sleep.js never makes a zombie for it: the only `spawn(` in the module is the night attack's
    const src = read('src/sleep.js');
    const tired = src.slice(src.indexOf('export class TiredFx'));
    expect(tired).not.toMatch(/spawn\(|zombies|Zombies/);
    expect(src.slice(0, src.indexOf('export class TiredFx')).match(/zombies\.spawn\(/g)).toHaveLength(1);
  });

  it('nowhere to stand, nothing appears: over water or a pit the try is given up and made again a little later', () => {
    const fx = new TiredFx();
    const rng = mulberry32(53);
    runFx(fx, viewOf({ standAt: () => null }), 300, rng);
    expect(fx.figures).toBe(0);
    expect(fx.figure).toBeNull();
    const none = new TiredFx();
    runFx(none, viewOf({ standAt: undefined }), 120, rng);
    expect(none.figures).toBe(0);
    // phantomStandAt: the first place from a little above the player's feet downward
    const w = grassland();
    expect(phantomStandAt(w.getBlock, 0, 0, Y)).toBe(Y);
    expect(phantomStandAt(w.getBlock, 0, 0, Y + 2.7)).toBe(Y);
    w.setBlock(3, Y, 0, B.COBBLESTONE);
    w.setBlock(3, Y + 1, 0, B.COBBLESTONE);
    expect(phantomStandAt(w.getBlock, 3, 0, Y)).toBe(Y + 2); // on top of what stands there
    w.setBlock(4, Y + 1, 0, B.COBBLESTONE);
    expect(phantomStandAt(w.getBlock, 4, 0, Y)).toBe(Y + 2); // not in a gap one cell high
    const sky = makeFakeWorld({ groundY: -1 });
    expect(phantomStandAt(sky.getBlock, 0, 0, 50)).toBeNull();
    const deep = makeFakeWorld({ groundY: 3, groundId: B.STONE });
    expect(phantomStandAt(deep.getBlock, 0, 0, 30)).toBeNull(); // the ground is too far down to stand at the player's level
  });

  it('a world with its zombies switched off: no groan and no figure; the footstep, the twig and the nods stay', () => {
    expect(PHANTOM_SOUNDS_CALM.map((s) => s[0])).toEqual(['stepGrass', 'digWood']);
    const fx = new TiredFx();
    const rng = mulberry32(55);
    const names = new Set();
    let figures = 0;
    runFx(fx, viewOf({ spooky: false }), 2400, rng, (_fx, _t, out) => {
      for (const s of out.sounds) names.add(s[0]);
      if (fx.figure) figures++;
    });
    expect([...names].sort()).toEqual(['digWood', 'stepGrass', 'yawn']);
    expect([figures, fx.figures]).toEqual([0, 0]);
    expect(fx.nods).toBeGreaterThan(50);
    // switched off while one stands there: gone at once
    const on = new TiredFx();
    const view = viewOf();
    for (let f = 0; f < 3600 && !on.figure; f++) on.step(1 / 60, view, rng);
    expect(on.figure).toBeTruthy();
    on.step(1 / 60, viewOf({ spooky: false }), rng);
    expect(on.figure).toBeNull();
  });

  it('reset(): a new world starts with nothing seen and nothing pending', () => {
    const fx = new TiredFx();
    runFx(fx, viewOf(), 200, mulberry32(54));
    expect(fx.figures + fx.nods + fx.sounds).toBeGreaterThan(0);
    fx.reset();
    expect([fx.figure, fx.nod, fx.figures, fx.nods, fx.sounds]).toEqual([null, 0, 0, 0, 0]);
    expect([fx.yawnIn, fx.soundIn, fx.figureIn, fx.nodIn].every(Number.isNaN)).toBe(true);
  });
});

describe('the figure as it is drawn (phantomRenderer.js)', () => {
  it('three plain dark boxes, see-through, unlit: hidden until there is a figure, then where it stands and as faint as it is', () => {
    const scene = new THREE.Scene();
    const r = createPhantomRenderer(scene);
    expect(scene.children).toContain(r.group);
    expect(r.group.visible).toBe(false);
    expect(r.group.children).toHaveLength(3);
    expect(PHANTOM_PARTS.map((p) => p[0])).toEqual(['legs', 'body', 'head']); // no arms held out, no face, no eyes
    expect(PHANTOM_PARTS.reduce((sum, p) => sum + p[2], 0)).toBeCloseTo(FIGURE_HEIGHT, 9);
    expect(PHANTOM_HEIGHT).toBe(FIGURE_HEIGHT);
    const mat = r.material;
    expect(mat.isMeshBasicMaterial).toBe(true); // unlit: no light makes it shine
    expect([mat.transparent, mat.depthWrite, mat.opacity]).toEqual([true, false, 0]);
    expect(mat.color.getHex()).toBe(PHANTOM_COLOR);
    expect(mat.color.r + mat.color.g + mat.color.b).toBeLessThan(0.05); // dark
    for (const mesh of r.group.children) expect(mesh.material).toBe(mat);
    // the boxes stand on each other from the feet up
    expect(r.group.children.map((m) => +m.position.y.toFixed(2))).toEqual([0.4, 1.13, 1.63]);
    r.sync({ x: 14.5, y: 10, z: -3, yaw: 1.2, age: 0.4, alpha: 0.5, d0: 15 });
    expect(r.group.visible).toBe(true);
    expect(r.group.position.toArray()).toEqual([14.5, 10, -3]);
    expect(r.group.rotation.y).toBe(1.2);
    expect(mat.opacity).toBe(0.5);
    r.sync({ x: 14.5, y: 10, z: -3, yaw: 1.2, age: 0, alpha: 0, d0: 15 });
    expect(r.group.visible).toBe(false); // not yet visible: not drawn at all
    r.sync({ x: 1, y: 2, z: 3, yaw: 0, age: 1, alpha: 7, d0: 15 });
    expect(mat.opacity).toBe(1);
    r.sync(null);
    expect(r.group.visible).toBe(false);
    r.dispose();
    expect(scene.children).not.toContain(r.group);
  });

  it('prewarm compiles it while the game loads and leaves it hidden', async () => {
    const scene = new THREE.Scene();
    const r = createPhantomRenderer(scene);
    const log = [];
    const webgl = { compileAsync(obj) { log.push([obj.name, obj.visible, obj.children.every((m) => m.visible)]); return Promise.resolve(); } };
    await r.prewarm(webgl, new THREE.PerspectiveCamera());
    expect(log).toEqual([['phantom', true, true]]);
    expect(r.group.visible).toBe(false);
    r.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The HUD
// ---------------------------------------------------------------------------------------------------------------------

describe('the tiredness reading and the sleep overlay (hud.js)', () => {
  function page(html = read('index.html')) {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    return { doc, hud, el: /** @type {any} */ (doc.getElementById('tiredness')) };
  }
  const reading = (hours) => ({ ...tirednessView(hours), marks: TIRED_BAR_MARKS });

  it('tirednessView: the whole hours awake in words, a bar that is full at Seeing things, the stage', () => {
    expect(tirednessView(0)).toEqual({ hours: 0, text: 'Awake 0 h', level: 0, stage: 0 });
    expect(tirednessView(14.99)).toEqual({ hours: 14, text: 'Awake 14 h', level: 14 / 48, stage: 0 });
    expect(tirednessView(20)).toMatchObject({ text: 'Awake 20 h', stage: 1 });
    expect(tirednessView(32.5)).toMatchObject({ text: 'Awake 32 h', stage: 2 });
    expect(tirednessView(40)).toMatchObject({ stage: 3 });
    expect(tirednessView(48)).toEqual({ hours: 48, text: 'Awake 48 h', level: 1, stage: 4 });
    expect(tirednessView(72)).toMatchObject({ text: 'Awake 72 h', level: 1, stage: 4 });
    expect(tirednessView(NaN)).toMatchObject({ text: 'Awake 0 h', level: 0 });
    expect(TIRED_BAR_FULL).toBe(DELIRIOUS_AT);
    expect(TIRED_BAR_MARKS).toEqual([20 / 48, 32 / 48, 40 / 48]);
  });

  it('beside the vitals, in Survival only: `Awake 14 h` over a thin bar with a mark at each stage', () => {
    const { hud, el } = page();
    expect(el).toBeTruthy();
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setTiredness(reading(14.3));
    expect(el.classList.contains('hidden')).toBe(true); // Creative: nothing survival shows
    hud.setSurvivalVisible(true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.querySelector('.tired-text').textContent).toBe('Awake 14 h');
    expect(el.querySelector('.tired-fill').style.width).toBe('29%');
    expect(el.querySelectorAll('.tired-mark').map((m) => m.style.left)).toEqual(['41.7%', '66.7%', '83.3%']);
    expect(el.classList.contains('stage-0')).toBe(true);
    expect(el.getAttribute('aria-label')).toBe('Tiredness: awake 14 h');
    hud.setTiredness(reading(33));
    expect(el.querySelector('.tired-text').textContent).toBe('Awake 33 h');
    expect(el.querySelector('.tired-fill').style.width).toBe('69%');
    expect([el.classList.contains('stage-0'), el.classList.contains('stage-2')]).toEqual([false, true]);
    hud.setTiredness(reading(60));
    expect(el.querySelector('.tired-fill').style.width).toBe('100%');
    expect(el.classList.contains('stage-4')).toBe(true);
    hud.setTiredness(null);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setTiredness(reading(5));
    expect(el.classList.contains('hidden')).toBe(false);
    hud.setSurvivalVisible(false);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.dispose();
  });

  it('the DOM is touched only when the shown hour changes (once a game hour)', () => {
    const { doc, hud } = page();
    hud.setSurvivalVisible(true);
    hud.setTiredness(reading(21.01));
    const writes = doc.writes;
    for (let i = 0; i < 500; i++) hud.setTiredness(reading(21.01 + i * 0.0019)); // 57 game seconds, frame by frame
    expect(doc.writes).toBe(writes);
    hud.setTiredness(reading(22));
    expect(doc.writes).toBeGreaterThan(writes);
    expect(tirednessKey(reading(21.4))).toBe('Awake 21 h|44|1');
    expect(tirednessKey(reading(21.9))).toBe(tirednessKey(reading(21.4)));
    expect(tirednessKey(null)).toBe('');
    hud.dispose();
  });

  it('in the HUD\'s own style: words and a bar, no hexagon, no icon; the tiredness chips with the other warnings', () => {
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const decl = (selector) => {
      const rule = new RegExp(`${selector.replace(/[.#]/g, '\\$&')}\\{([^}]*)\\}`).exec(css);
      expect(rule, selector).toBeTruthy();
      return Object.fromEntries(rule[1].split(';').filter(Boolean).map((d) => d.split(/:(.*)/).slice(0, 2).map((x) => x.trim())));
    };
    const t = decl('.tiredness');
    expect(t.position).toBe('absolute');
    expect(t.bottom).toBe('8px'); // on the hotbar's line, like the vitals
    expect(t.left).toBe('calc(50% + 285px)'); // right of the right-hand vitals (they end at 50% + 279px)
    expect(t['clip-path']).toBeUndefined(); // no hexagon
    for (const sel of ['.tiredness', '.tired-bar', '.tired-fill', '.tired-mark']) expect(JSON.stringify(decl(sel))).not.toMatch(/url\(|content|clip-path/);
    expect(decl('.chip-tired').background).toBeTruthy();
    for (const label of FATIGUE_STAGES.slice(1)) expect(chipKind(label)).toBe('tired');
    expect(chipKind('Wet')).toBe('wet');
    expect(read('index.html')).toContain('<div id="tiredness" class="tiredness hidden" aria-label="Tiredness"></div>');
    // a page without the element still works (it is made)
    const { doc, hud } = page(read('index.html').replace('<div id="tiredness" class="tiredness hidden" aria-label="Tiredness"></div>', ''));
    const el = /** @type {any} */ (doc.getElementById('tiredness'));
    expect(el).toBeTruthy();
    hud.setSurvivalVisible(true);
    hud.setTiredness(reading(9));
    expect(el.querySelector('.tired-text').textContent).toBe('Awake 9 h');
    hud.dispose();
  });

  it('the dark of a sleep or a nod: one overlay over the whole HUD, with the sleeper\'s two quiet lines', () => {
    const { doc, hud } = page();
    const el = /** @type {any} */ (doc.getElementById('sleep-overlay'));
    expect(el).toBeTruthy();
    expect(el.parentNode).toBe(doc.getElementById('hud'));
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setSleepView({ dark: 0.5, line: sleepingLine(0), sub: SLEEP_LINES.wakeKey });
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.style.opacity).toBe('0.5');
    expect(el.querySelector('.sleep-line').textContent).toBe('Sleeping · 0 h');
    expect(el.querySelector('.sleep-sub').textContent).toBe('press any key to wake');
    hud.setSleepView({ dark: 1, line: sleepingLine(3.2), sub: SLEEP_LINES.wakeKey });
    expect(el.style.opacity).toBe('1');
    expect(el.querySelector('.sleep-line').textContent).toBe('Sleeping · 3 h');
    // every frame of an hour asleep: nothing is written
    const writes = doc.writes;
    for (let i = 0; i < 100; i++) hud.setSleepView({ dark: 1, line: sleepingLine(3.2 + i * 0.005), sub: SLEEP_LINES.wakeKey });
    expect(doc.writes).toBe(writes);
    // a nod: dark, no words
    hud.setSleepView({ dark: 0.7 });
    expect(el.style.opacity).toBe(String(Math.round(0.7 * 32) / 32));
    expect(el.querySelector('.sleep-line').textContent).toBe('');
    expect(el.querySelector('.sleep-sub').textContent).toBe('');
    hud.setSleepView({ dark: 0 });
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setSleepView({ dark: 9 });
    expect(el.style.opacity).toBe('1');
    hud.setSleepView(null);
    expect(el.classList.contains('hidden')).toBe(true);
    // it lies over the hotbar's own layers and under every menu
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /#sleep-overlay\{([^}]*)\}/.exec(css)[1];
    expect(rule).toContain('position:absolute');
    expect(rule).toContain('inset:0');
    const z = Number(/z-index:(\d+)/.exec(rule)[1]);
    const inHotbar = [...css.matchAll(/#hotbar\.survival[^{]*\{[^}]*z-index:(\d+)/g)].map((m) => Number(m[1]));
    expect(inHotbar.length).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(Math.max(...inHotbar));
    expect(Number(/#hud\{z-index:(\d+)/.exec(css)[1])).toBeLessThan(Number(/#pause-menu\{z-index:(\d+)/.exec(css)[1]));
    hud.dispose();
  });

  it('the blur of tired eyes: a filter on the game canvas in fifths of a pixel, taken off again', () => {
    const { doc, hud } = page();
    const canvas = /** @type {any} */ (doc.getElementById(BLUR_TARGET_ID));
    expect(BLUR_TARGET_ID).toBe('game-canvas');
    expect(canvas).toBeTruthy();
    hud.setSleepView({ dark: 0, blur: 1.37 });
    expect(canvas.style.filter).toBe('blur(1.4px)');
    const writes = doc.writes;
    hud.setSleepView({ dark: 0, blur: 1.44 });
    hud.setSleepView({ dark: 0, blur: 1.31 });
    expect(doc.writes).toBe(writes); // the same fifth
    hud.setSleepView({ dark: 0, blur: 2.4 });
    expect(canvas.style.filter).toBe('blur(2.4px)');
    hud.setSleepView({ dark: 0, blur: 0.05 });
    expect(canvas.style.filter).toBe('');
    hud.setSleepView({ dark: 0, blur: 2 });
    hud.setSleepView(null);
    expect(canvas.style.filter).toBe('');
    expect(BLUR_STEP_PX).toBe(0.2);
    expect([blurStep(0), blurStep(0.09), blurStep(0.11), blurStep(-3), blurStep(NaN)]).toEqual([0, 0, 0.2, 0, 0]);
    // a whole wave of the strongest blur is a dozen changes of the filter over nine seconds
    const steps = new Set();
    for (let t = 0; t < BLUR_WAVE_S; t += 1 / 60) steps.add(blurStep(blurPx(4, t)).toFixed(1));
    expect(steps.size).toBeLessThanOrEqual(12);
    // a page without the canvas: nothing blurs and nothing breaks
    const bare = page(read('index.html').replace('<canvas id="game-canvas"></canvas>', ''));
    bare.hud.setSleepView({ dark: 0.2, blur: 2 });
    bare.hud.dispose();
    hud.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The sounds
// ---------------------------------------------------------------------------------------------------------------------

describe('the sounds: a yawn and a soft waking (soundBank.js)', () => {
  const SEEDS = [1, 2, 3];
  const render = (name, seed) => {
    const r = SOUND_BANK[name];
    const x = renderSound((audio) => audio.playRecipe(r, 1), { createAudio, seconds: r.dur + 0.3, seed });
    return { x, m: measure(x) };
  };
  const loudOf = (name) => 10 * Math.log10(SEEDS.reduce((s, seed) => s + 10 ** (render(name, seed).m.loud / 10), 0) / SEEDS.length);
  /** When the loudest sample comes, and the largest in the first `s` seconds as a share of it. */
  const shape = (x, s) => {
    let at = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i;
    let early = 0;
    for (let i = 0; i < Math.floor(s * 44100); i++) early = Math.max(early, Math.abs(x[i]));
    return { peakAt: at / 44100, early: early / Math.abs(x[at]) };
  };

  it('both are in the bank, with the player\'s movement sounds, and can be heard from the Sound Test', () => {
    for (const name of ['yawn', 'wakeSoft']) {
      expect(SOUND_BANK[name], name).toBeTruthy();
      expect(BANK_FAMILIES.movement).toContain(name);
      expect(SOUND_BANK[name].vary).toBeGreaterThan(0);
      expect(voicesOf(SOUND_BANK[name])).toBeLessThanOrEqual(2);
    }
    expect(SOUND_BANK.yawn.spare).toBe(STEP_SPARE); // a yawn gives way to anything else
    expect(SOUND_BANK.wakeSoft.spare).toBeUndefined(); // waking is always heard
    const row = SOUND_SECTIONS.find((s) => s.id === 'movement').rows.find((r) => r.label === 'Sleep');
    expect(row.items.map((i) => [i.label, i.recipe])).toEqual([['Yawn', 'yawn'], ['Wake', 'wakeSoft']]);
  });

  it('a yawn: over a second long, a voice of about 200 Hz with breath over it, coming in slowly, softer than a zombie\'s groan', () => {
    for (const seed of SEEDS) {
      const { x, m } = render('yawn', seed);
      expect(m.duration, `seed ${seed}`).toBeGreaterThan(1);
      expect(m.duration, `seed ${seed}`).toBeLessThan(1.8);
      expect(bandShare(m, 150, 2500), `seed ${seed}`).toBeGreaterThan(0.9);
      expect(bandShare(m, 150, 250), `seed ${seed}`).toBeGreaterThan(0.2); // the voice itself
      expect(bandShare(m, 400, 2500), `seed ${seed}`).toBeGreaterThan(0.2); // its open mouth, and the breath
      expect(m.lowShare).toBeLessThan(0.1);
      const s = shape(x, 0.08);
      expect(s.early, `seed ${seed}`).toBeLessThan(0.35); // no sudden start
      expect(s.peakAt, `seed ${seed}`).toBeGreaterThan(0.2);
      expect(m.peak).toBeLessThan(0.1);
    }
    for (const l of SOUND_BANK.yawn.layers) expect(l.attack).toBeGreaterThanOrEqual(0.25);
    expect(loudOf('yawn')).toBeLessThan(loudOf('zombieHurt') - 3);
    expect(loudOf('yawn') + 20 * Math.log10(YAWN_VOLUME)).toBeGreaterThan(-48); // as main plays it: still to be heard
    expect(loudOf('yawn')).toBeLessThan(-34);
  });

  it('waking: two soft notes, the second a fifth above the first; no click, nothing loud', () => {
    for (const seed of SEEDS) {
      const { x, m } = render('wakeSoft', seed);
      expect(m.duration, `seed ${seed}`).toBeGreaterThan(0.6);
      expect(m.duration, `seed ${seed}`).toBeLessThan(1.1);
      expect(m.head, `seed ${seed}`).toBeLessThan(0.05); // no click
      expect(m.peak).toBeLessThan(0.06);
      expect(bandShare(m, 330, 700), `seed ${seed}`).toBeGreaterThan(0.6); // the two notes themselves: 392 and 588 Hz
      expect(shape(x, 0.01).early, `seed ${seed}`).toBeLessThan(0.35); // each note swells in
      expect(shape(x, 0.01).peakAt, `seed ${seed}`).toBeGreaterThan(0.3); // the second note is the fuller one
    }
    const [layer] = SOUND_BANK.wakeSoft.layers;
    expect(layer.type).toBe('sine');
    expect(layer.grains.map((g) => g[1])).toEqual([1, 1.5]); // a fifth up
    expect(layer.attack).toBeGreaterThanOrEqual(0.05);
    expect(loudOf('wakeSoft')).toBeLessThan(-30);
    expect(loudOf('wakeSoft')).toBeGreaterThan(-42);
    expect(loudOf('wakeSoft')).toBeLessThan(loudOf('splashIn') - 6);
  });

  it('the sounds with nothing there are heard at the level of the birds, far under what they are when real', () => {
    const real = { zombieGroan: 1, stepGrass: 0.8, digWood: 0.35 }; // as main plays the real ones at their loudest
    for (const [name, volume] of PHANTOM_SOUNDS) {
      const r = SOUND_BANK[name];
      const take = r.variants ? { ...r.variants[0], vary: r.vary, stretch: r.stretch } : r;
      const x = renderSound((audio) => audio.playRecipe(take, volume), { createAudio, seconds: take.dur + 0.3, seed: 1 });
      const m = measure(x);
      expect(m.loud, name).toBeLessThan(-40);
      expect(m.loud, name).toBeGreaterThan(-52);
      expect(volume, name).toBeLessThan(real[name]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// main.js, the debug handle, F3
// ---------------------------------------------------------------------------------------------------------------------

describe('the wiring (main.js, diagnostics.js): read from the source, since main needs a browser', () => {
  const main = read('src/main.js');
  /** The body of a function of main's closure. */
  const fn = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('lying down or asleep, only the sleeping world runs: stepPlaying hands the frame to stepSleep first', () => {
    const playing = fn('stepPlaying');
    expect(playing.split('\n')[1]).toBe('    if (stepSleep(dt)) return; // §87: lying down or asleep, only the sleeping world runs');
    const step = fn('stepSleep');
    expect(step).toContain('if (!sleep.active) return false;');
    expect(step).toContain('const res = sleep.step(dt, sleepHooks);');
    expect(step).toContain('if (res.woke) endSleep(res.woke);');
    expect(step.indexOf('if (checkDeath()) return true;')).toBeGreaterThan(step.indexOf('sleep.step(dt, sleepHooks)')); // a death in your sleep
    expect(step).toContain('world.update(player.x, player.z);');
    expect(step).toContain('autosaveTick(dt);');
    expect(step).toContain('if (controls.enabled) controls.setEnabled(false);'); // no walking, no looking about
    expect(step).toContain("endSleep('stopped');"); // a mode switch
    expect(main).toContain('const sleepHooks = { second: sleepSecond, hour: sleepHour, now };'); // `now`: the frame budget
    // nothing of the player's physics or the mobs is stepped, at any speed: they stand still
    for (const text of [step, fn('sleepSecond')]) {
      for (const call of ['stepPlayer(', 'stepZombies(', 'stepAnimals(', 'stepPigs(', 'stepWatcher(', 'stepBlockPhysics(', 'stepCircuits(', 'zombies.update(']) {
        expect(text, call).not.toContain(call);
      }
    }
  });

  it('a game second of sleep: the clock and the day counter, then stepSurvival(1) — the body on the spot\'s numbers and every once-a-second system', () => {
    const second = fn('sleepSecond');
    expect(second).toContain('const nt = advanceTime(time, 1);');
    expect(second).toContain('if (nt < time) day++;');
    expect(second.indexOf('stepSurvival(1, false);')).toBeGreaterThan(second.indexOf('advanceTime(time, 1)'));
    expect(second).toContain('isDay: isDayTime(time),');
    expect(second).toContain('hurt: sleepFx.hurt, died: pendingDeath !== null || !survival.active,');
    const sv = fn('stepSurvival');
    expect(sv).toContain('env.sleep = sleep.asleep ? sleep.spot : null;');
    expect(sv.indexOf('env.sleep = ')).toBeLessThan(sv.indexOf('survival.step(dt,'));
    expect(sv).toContain('sleepNote(ev);');
    expect(fn('sleepNote')).toContain('if (ev.damage > 0) sleepFx.hurt = true;');
    // the once-a-second systems that take a dt, with dt = 1 once a tick: regrowth, farming and spread, the rain on the
    // fires, the water cycle, spoilage in the pack and in the baskets; and the fires' fuel and what cooks on them
    const once = sv.slice(sv.indexOf('if (survivalSecond >= 1) {'));
    for (const call of ['regrowth.step(1, Math.random, isLoadedCellFn)', 'farmSecond(1, Math.random)', 'rainSecond(1, Math.random)',
      'waterSecond(1, Math.random)', 'pack.spoil(1, Math.random)', 'containers.spoil(1, Math.random, isLoadedCellFn)']) {
      expect(once, call).toContain(call);
    }
    expect(sv).toContain('survivalSecond += dt;'); // a tick of 1 s is one whole second of them
    expect(sv).toContain('const fev = fireSlots.step(dt, isBurningFn, isLoadedCellFn);');
    expect(fn('farmSecond')).toContain('spread,');
    // nothing is made, and nothing of a fire is seen or heard, while you sleep
    expect(sv).toContain('if (craftQueue.size > 0 && !sleep.asleep) {');
    expect(sv).toContain('if (!sleep.asleep) fireEffects(dt, fev.cooking);');
  });

  it('R on a sleep spot: the waking place as before, then the refusal or the lying down; the hint says whether it is secure', () => {
    const interact = fn('doInteract');
    expect(interact).toContain("      case 'hide':\n        sleepOn(q, y, r);");
    const on = fn('sleepOn');
    expect(on).toContain('spotOf(world.getBlock(q, y, r))');
    expect(on).toContain('survival.spawn = [q, y, r];');
    expect(on).toContain('logLine(`You will wake at this ${spot.name}.`);');
    expect(on.indexOf('survival.spawn = [q, y, r];')).toBeLessThan(on.indexOf('sleepRefusal(')); // not tired: still the waking place
    expect(on).toContain('riding: Boolean(riding)');
    expect(on).toContain('inWater: Boolean(player.inWater)');
    expect(on).toContain('zombies: zombies.list,');
    expect(on).toContain('showHint(no, 2.5);');
    expect(on).toContain('if (fy !== null) game.teleport(hx, fy, hz);');
    expect(on).toContain('sleep.lie(spot, [q, y, r]);');
    expect(on.indexOf('sleep.lie(')).toBeGreaterThan(on.indexOf('if (no) {'));
    // waking after a death: on any sleep spot, and the line when it is gone
    const wake = fn('wake');
    expect(wake).toContain('} else if (spotOf(world.getBlock(sp[0], sp[1], sp[2]))) {');
    // on top of the hide (solid, a metre high); in the cell of a bed (the beds are low models you walk over)
    expect(wake).toContain('isSolid(world.getBlock(sp[0], sp[1], sp[2])) ? sp[1] + 1 : sp[1], 3);');
    expect(on).toContain('isSolid(world.getBlock(q, y, r)) ? y + 1 : y, 1);');
    expect(wake).toContain('logLine(SLEEP_LINES.gone);');
    expect(SLEEP_LINES.gone).toBe('Your sleeping place is gone.');
    // the hint
    expect(fn('survivalHintText')).toContain("        case 'hide':\n          return sleepSpotHint(act);");
    const hint = fn('sleepSpotHint');
    expect(hint).toContain('return `${act.hint} · ${secureWords(hintWatch.get(secureEnv))}`;');
    expect(hint).toContain('if (!survival.active || !zombies.enabled ||'); // where no zombie comes there is nothing to say
    expect(`${spotHint(HIDE)} · ${secureWords({ secure: true, reason: '', cells: 1 })}`).toBe('Sleeping Hide · R: sleep · secure here');
    expect(`${spotHint(HIDE)} · ${secureWords({ secure: false, reason: SECURE_REASONS.open, cells: 1 })}`).toBe('Sleeping Hide · R: sleep · not secure: open to the outside');
  });

  it('secure: through the zombies\' own spawn rule; looked at when lying down, when a block changes, and before each hour\'s roll', () => {
    expect(main).toContain('    spawnY: (q, r) => zombies.spawnHeightAt(zombieWorld, q, r),');
    expect(main).toContain('    groundHeight: (q, r) => world.terrainHeightAt(q, r),');
    expect(fn('onBlockChanged')).toContain('sleepBlockChanged(q, y, r);');
    const changed = fn('sleepBlockChanged');
    expect(changed).toContain('sleepWatch.blockChanged(q, y, r);');
    expect(changed).toContain('hintWatch.blockChanged(q, y, r);');
    const on = fn('sleepOn');
    expect(on).toContain('sleepWatch.watch(q, y, r);');
    expect(on.indexOf('sleepWatch.get(secureEnv);')).toBeLessThan(on.indexOf('sleep.lie(spot, [q, y, r]);')); // once, lying down
    const hour = fn('sleepHour');
    expect(hour.indexOf('sleepWatch.touch();')).toBeLessThan(hour.indexOf('sleepWatch.get(secureEnv)')); // a fire may have burnt out
    expect(hour).toContain('zombieWorld.isDay = isDayTime(time);');
    expect(hour).toContain('const light = standLight(zombieWorld.blockLight, q, Math.floor(player.y + 0.01), r);'); // the light where the sleeper lies
    expect(hour).toContain('rollNightAttack({ isDay: zombieWorld.isDay, secure: !!res && res.secure, zombiesOn: zombies.enabled, light }, Math.random)');
    expect(hour).toContain('return placeNightAttack(zombies, zombieWorld, player.x, player.z, Math.random).length > 0;'); // no ground, no attack
  });

  it('waking: any key but Esc (which pauses as usual) or a click; the line, `Something is near.` first after an attack, the soft sound', () => {
    expect(main).toContain("if (sleep.active && playingNow() && !e.repeat && e.code !== 'Escape') sleepFx.wakeAsked = true;");
    expect(main).toContain('if (sleep.active && playingNow()) sleepFx.wakeAsked = true;'); // a click
    expect(main).toContain('const playingNow = () => /** @type {string} */ (state) === STATE.PLAYING;'); // not in the pause menu
    expect(main).toContain("doc.addEventListener('keydown', onSleepKey, true);");
    expect(main).toContain("doc.addEventListener('mousedown', onSleepClick, true);");
    const dispose = fn('disposeSleep');
    expect(dispose).toContain("doc.removeEventListener('keydown', onSleepKey, true);");
    expect(dispose).toContain("doc.removeEventListener('mousedown', onSleepClick, true);");
    const step = fn('stepSleep');
    expect(step).toContain("endSleep('asked');");
    const end = fn('endSleep');
    expect(end).toContain("if (reason === 'attack') logLine(SLEEP_LINES.attack);");
    expect(end.indexOf('logLine(SLEEP_LINES.attack)')).toBeLessThan(end.indexOf('logLine(wakeLine(sleep.lastHours, survival.vitals, reason));'));
    expect(end).toContain("audio.playRecipe('wakeSoft', WAKE_VOLUME);");
    expect(end).toContain('if (playingNow() && !survival.dead) controls.setEnabled(true);');
    expect(end).toContain('sleepFx.stage = fatigueStage(survival.vitals);'); // the waking line says the state: no stage line on top
    expect(end).toContain("if (reason === 'died' || reason === 'stopped' || !survival.active) return;");
  });

  it('Weak: digging and strikes; the body\'s own status carries the rest (the slower step, no healing, the label)', () => {
    expect(fn('digStep')).toContain('breakSeconds(h.blockId, tool, Boolean(player.headInWater)) / digFactorNow()');
    const strike = fn('strike');
    expect(strike.match(/\* strikeFactorNow\(\)/g)).toHaveLength(3); // a zombie, an animal, a pig
    expect(main).toContain('const digFactorNow = () => (survival.active ? digFactorOf(survival.vitals) : 1);');
    expect(main).toContain('const strikeFactorNow = () => (survival.active ? strikeFactorOf(survival.vitals) : 1);');
    expect(fn('stepPlaying')).toContain('input.speedFactor = status.moveFactor;'); // (as before §87: statusOf now knows Weak)
    expect(fn('renderFrame')).toContain('vitalsView.labels = survival.status.labels;'); // the chips
  });

  it('once a frame: the stage lines, the effects of tiredness, the reading, the dark and the blur; the figure is only ever drawn', () => {
    expect(fn('renderFrame')).toContain('sleepFrame(dt, live, eyeY);');
    const frame = fn('sleepFrame');
    expect(frame).toContain('const line = stageNews(sleepFx.stage, stage);');
    expect(frame).toContain('if (line) logLine(line, false, STAGE_LINE_MS);');
    expect(frame).toContain('} else if (!sleep.active && live) {'); // not while asleep: the waking line says it
    expect(frame).toContain('tv.awake = alive && !sleep.active;');
    expect(frame).toContain('const fx = tiredFx.step(live ? dt : 0, tv, Math.random);'); // frozen in the menus
    expect(frame).toContain('tv.spooky = zombies.enabled;'); // no groan, no figure in a world without zombies
    expect(frame).toContain('for (const [name, volume] of fx.sounds) audio.playRecipe(name, volume);');
    expect(frame).toContain('phantomRenderer.sync(tv.awake ? tiredFx.figure : null);');
    expect(main.match(/tiredFx\.figure/g)).toHaveLength(1); // nothing else ever reads it: no body, no target, no list
    expect(frame).toContain('hud.setTiredness(sleepFx.view);');
    expect(frame).toContain('hud.setTiredness(null);');
    expect(frame).toContain('dark: Math.max(sleepFx.dark, tv.awake ? tiredFx.dark : 0),');
    expect(frame).toContain('blur: tv.awake ? blurPx(stage, fxTime) : 0,');
    expect(frame).toContain('line: sleep.active ? sleepingLine(sleep.hours) : null,');
    expect(frame).toContain('sub: sleep.active ? SLEEP_LINES.wakeKey : null,');
    expect(main).toContain('standAt: (q, r) => phantomStandAt(world.getBlock, q, r, player.y),');
    // made with the other renderers, compiled while the game loads, disposed with them
    expect(main).toContain('phantomRenderer = createPhantomRenderer(renderer.three.scene);');
    expect(main).toContain('phantomRenderer.prewarm(renderer.three.renderer, renderer.three.camera);');
    expect(fn('disposeSleep')).toContain('phantomRenderer.dispose();');
  });

  it('a world left or loaded: nobody sleeps on', () => {
    expect(fn('clearSurvival')).toContain('resetSleep();');
    expect(main.match(/resetSleep\(\); \/\/ §87/g)).toHaveLength(2); // leaving a world, and loading one
    const reset = fn('resetSleep');
    for (const call of ['sleep.reset();', 'tiredFx.reset();', 'sleepWatch.clear();', 'hintWatch.clear();', 'sleepFx.stage = null;']) expect(reset).toContain(call);
    expect(fn('dispose')).toContain('disposeSleep();');
  });

  it('the debug handle: sleep, setFatigue, sleepHere, secureAt and sleepStep reach the game', () => {
    expect(main).toContain("    setFatigue: (hours) => (survival.setVital('fatigue', hours) ? survival.vitals.fatigue : null),");
    expect(main).toContain('    sleepHere: () => sleepHere(),');
    expect(main).toContain('    secureAt: (q, y, r) => (world && Number.isFinite(q + y + r) ? secureAt(secureEnv, Math.floor(q), Math.floor(y), Math.floor(r)) : null),');
    expect(main).toContain('    sleepStep: (hours) => sleepStepHours(hours),');
    expect(fn('sleepStepHours')).toContain('const res = sleep.advance(Math.max(0, hours) * 60, sleepHooks);');
    const here = fn('sleepHere');
    expect(here).toContain('if (hit && spotOf(hit.blockId)) return sleepOn(hit.q, hit.y, hit.r);');
    expect(here).toContain("return best ? sleepOn(best[0], best[1], best[2]) : 'no sleep spot within reach';");
    const calls = [];
    const sleep = new Sleep();
    const tiredFx = new TiredFx();
    const game = {
      sleep, tiredFx,
      setFatigue: (h) => (calls.push(['setFatigue', h]), h),
      sleepHere: () => (calls.push(['sleepHere']), true),
      secureAt: (q, y, r) => (calls.push(['secureAt', q, y, r]), { secure: true, reason: '', cells: 56 }),
      sleepStep: (h) => (calls.push(['sleepStep', h]), { hours: h, woke: null }),
    };
    const win = {};
    const handle = installDebugHandle(win, /** @type {any} */ (game));
    expect(win.__caelancraft).toBe(handle);
    expect([handle.sleep, handle.tiredFx]).toEqual([sleep, tiredFx]);
    expect(handle.setFatigue(48)).toBe(48);
    expect(handle.sleepHere()).toBe(true);
    expect(handle.secureAt(1, 64, -2)).toEqual({ secure: true, reason: '', cells: 56 });
    expect(handle.sleepStep(3)).toEqual({ hours: 3, woke: null });
    expect(calls).toEqual([['setFatigue', 48], ['sleepHere'], ['secureAt', 1, 64, -2], ['sleepStep', 3]]);
    // a game without them (an older driver): quiet answers
    const bare = installDebugHandle({}, /** @type {any} */ ({}));
    expect([bare.sleep, bare.setFatigue(5), bare.sleepHere(), bare.secureAt(0, 0, 0), bare.sleepStep(1)]).toEqual([null, null, false, null, null]);
  });

  it('F3 says the hours awake, and the sleep while there is one', () => {
    const survival = new Survival();
    survival.setMode('survival');
    survival.vitals.fatigue = 21.44;
    const sleep = new Sleep();
    expect(sleepDebugLine({ survival, sleep })).toBe('\nSleep: awake 21.4 h');
    sleep.lie(HIDE, [0, 10, 0]);
    sleep.advance(192, { second: () => ({ satiation: 80, hydration: 80, fatigue: 20, isDay: false }) });
    expect(sleepDebugLine({ survival, sleep })).toBe('\nSleep: awake 21.4 h · asleep 3.2 h on a Sleeping Hide');
    expect(sleepDebugLine(null)).toBe('');
    expect(sleepDebugLine({})).toBe('');
    expect(sleepDebugLine({ survival })).toBe(''); // a game without sleep
    expect(sleepDebugLine({ survival: new Survival(), sleep })).toBe(''); // Creative
    expect(read('src/diagnostics.js')).toContain('    sleepDebugLine(g) +\n');
  });
});
