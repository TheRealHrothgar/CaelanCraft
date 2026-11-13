// What rain does (CONTRACTS §84.6): it waters the crops (farming.js through an injected `rained`), puts out the fires it
// reaches (campfires.js rainStep, main.rainSecondOn) and makes the player wet and cold (climate.wetRate, survival.step).
// Then the HUD's calendar line on the page, and the wiring of all of it in main.js and the debug handle, read from the
// source because main needs a browser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { DAY_LENGTH_SECONDS, CAMPFIRE_MAX_TRACKED, PACK_SLOTS } from '../../src/config.js';
import {
  RAIN_WATERS_S, SPROUT_MEAN_S, GROW_MEAN_S, SEED_TAKES, cropOf, cropState, farmHint, Growth,
} from '../../src/farming.js';
import { Spread } from '../../src/spread.js';
import {
  Campfires, RAIN_DOUSE_MEAN_S, RAIN_DOUSE_HINT, RAIN_DOUSE_LINE, rainDouseChance,
} from '../../src/campfires.js';
import { FireSlots } from '../../src/cooking.js';
import {
  WET_CHILL, WET_CHILL_C, WET_DRY_S, WET_DRY_HEAT_DIV, WET_DRY_SUN_MULT, RAIN_WET_S, WET_INSULATION_LOSS, wetRate, dryingRate,
  feltTemperature, heatAt, heatSource, CHEST_HEIGHT,
} from '../../src/climate.js';
import { RATES, statusOf, createVitals } from '../../src/vitals.js';
import { Survival } from '../../src/survival.js';
import { normalizeSurvivalJSON, SURVIVAL_STATS } from '../../src/storage.js';
import { createPlayer } from '../../src/physics.js';
import {
  createWeather, rainReaching, rainedOnCell, rainExposure, weatherEnv, rainSky, LEAF_COVER, RAINS_DAYS, YEAR_DAYS, seasonOf, hudLine,
} from '../../src/weather.js';
import { farmSecondOn, rainSecondOn, RAIN_DOUSE_NOTICE_M } from '../../src/main.js';
import { installDebugHandle, weatherDebugLine } from '../../src/diagnostics.js';
import { createHUD } from '../../src/hud.js';
import * as THREE from 'three';
import { createRenderer, OVERCAST_HIDES_SUN, SKY_GLOW } from '../../src/renderer.js';
import { computeSky, createSkyState } from '../../src/daynight.js';
import { hexToWorld } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { makeFakeWorld } from '../helpers/fixtures.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const B = BLOCK;
const DAY = DAY_LENGTH_SECONDS;
/** The ground of the test worlds: grass up to y = G, so a crop or a fire stands in the cell at y = G + 1. */
const G = 10;
const Y = G + 1;
const loaded = () => true;
const flat = (biome = BIOME.PLAINS) => Object.assign(makeFakeWorld({ groundY: G, groundId: B.GRASS_BLOCK }), { getBiome: () => biome });
/** A weather in which it rains at full strength everywhere, and one in which it never does. */
const rainy = () => {
  const w = createWeather(1);
  w.force('rain');
  return w;
};
const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------

describe('rain waters the crops (§84.6, farming.js)', () => {
  const carrot = cropOf('carrot');

  it('RAIN_WATERS_S is one game day; a cell rained on within it is watered, and the hint says by what', () => {
    expect(RAIN_WATERS_S).toBe(1440);
    expect(RAIN_WATERS_S).toBe(DAY);
    const w = flat();
    w.put(0, Y, 0, B.PLANTED_CARROT);
    const dry = cropState(w.getBlock, null, 0, Y, 0, carrot);
    expect(dry).toEqual({ sky: true, watered: false, reed: true });
    expect(farmHint(B.PLANTED_CARROT, dry)).toBe('Planted Wild Carrot · dry: slow, and it may not take');
    const rained = cropState(w.getBlock, null, 0, Y, 0, carrot, () => true);
    expect(rained).toEqual({ sky: true, watered: true, reed: true, rain: true });
    expect(farmHint(B.PLANTED_CARROT, rained)).toBe('Planted Wild Carrot · watered by rain');
    expect(farmHint(B.CARROT_SPROUT, rained)).toBe('Wild Carrot Sprout · watered by rain');
    expect(cropState(w.getBlock, null, 0, Y, 0, carrot, () => false)).toEqual(dry);
    expect(cropState(w.getBlock, null, 0, Y, 0, carrot, null)).toEqual(dry);
    // the cell asked about is the crop's own
    const asked = [];
    cropState(w.getBlock, null, 3, Y, -2, carrot, (q, y, r) => (asked.push([q, y, r]), false));
    expect(asked).toEqual([[3, Y, -2]]);
  });

  it('with fresh water in reach it is simply watered, and the rain is not even asked; rain does not stand in for a reed\'s water', () => {
    const w = flat();
    w.put(2, G, 0, B.WATER);
    let asked = 0;
    const state = cropState(w.getBlock, () => 'fresh', 0, Y, 0, carrot, () => (asked++, true));
    expect(state).toEqual({ sky: true, watered: true, reed: true });
    expect(asked).toBe(0);
    expect(farmHint(B.PLANTED_CARROT, state)).toBe('Planted Wild Carrot · watered');
    // tainted water does not water, but the rain still does
    expect(cropState(w.getBlock, () => 'tainted', 0, Y, 0, carrot, () => true)).toMatchObject({ watered: true, rain: true });
    const reed = cropOf('cattails');
    const d = flat();
    const lone = cropState(d.getBlock, null, 0, Y, 0, reed, () => true);
    expect(lone.reed).toBe(false);
    expect(farmHint(B.PLANTED_CATTAILS, lone)).toBe('Planted Cattails · needs water beside it');
  });

  it('by simulation: a dry-ground seed under rain sprouts at the watered pace and takes at the watered rate', () => {
    const weather = rainy();
    for (const [roof, mean, takes] of [[null, SPROUT_MEAN_S.watered, SEED_TAKES.watered], [B.GLASS, SPROUT_MEAN_S.dry, SEED_TAKES.dry]]) {
      const w = flat();
      const g = new Growth();
      const N = 600;
      for (let i = 0; i < N; i++) {
        const q = (i % 30) * 9;
        const r = Math.floor(i / 30) * 9;
        w.put(q, Y, r, B.PLANTED_CARROT);
        if (roof !== null) w.put(q, Y + 3, r, roof); // a glass roof: the light comes through, the rain does not
        g.track(q, Y, r, B.PLANTED_CARROT);
      }
      const rained = (q, y, r) => rainedOnCell(weather, 5000, w, q, y, r, RAIN_WATERS_S);
      const random = mulberry32(roof === null ? 31 : 32);
      let moments = 0;
      let took = 0;
      let sumT = 0;
      for (let s = 1; s <= 5 * mean && g.size > 0; s++) {
        for (const ev of g.step(1, random, loaded, w.getBlock, () => 'fresh', rained)) {
          moments++;
          sumT += s;
          if (ev.took) took++;
        }
      }
      // (as farming.test.js: after five means 99.3 % have had their moment, and those average 0.966 of the mean)
      expect(moments, `roof ${roof}`).toBeGreaterThan(N * 0.97);
      expect(sumT / moments / (0.966 * mean), `roof ${roof}`).toBeGreaterThan(0.9);
      expect(sumT / moments / (0.966 * mean), `roof ${roof}`).toBeLessThan(1.1);
      expect(took / moments, `roof ${roof}`).toBeGreaterThan(takes - 0.06);
      expect(took / moments, `roof ${roof}`).toBeLessThan(takes + 0.06);
    }
  });

  it('a sprout under rain grows up at the watered pace; under a roof of planks nothing happens at all', () => {
    const weather = rainy();
    const w = flat();
    const g = new Growth();
    const N = 400;
    for (let i = 0; i < N; i++) {
      w.put(i * 9, Y, 0, B.HAZEL_SPROUT);
      g.track(i * 9, Y, 0, B.HAZEL_SPROUT);
      w.put(i * 9, Y, 50, B.HAZEL_SPROUT);
      w.put(i * 9, Y + 2, 50, B.OAK_PLANKS);
      g.track(i * 9, Y, 50, B.HAZEL_SPROUT);
    }
    const rained = (q, y, r) => rainedOnCell(weather, 0, w, q, y, r, RAIN_WATERS_S);
    const random = mulberry32(33);
    let grown = 0;
    let sumT = 0;
    for (let s = 1; s <= 5 * GROW_MEAN_S.watered; s++) {
      for (const ev of g.step(1, random, loaded, w.getBlock, null, rained)) {
        expect(ev.r).toBe(0); // never a roofed one
        grown++;
        sumT += s;
      }
    }
    expect(grown).toBeGreaterThan(N * 0.97);
    expect(sumT / grown / (0.966 * GROW_MEAN_S.watered)).toBeGreaterThan(0.9);
    expect(sumT / grown / (0.966 * GROW_MEAN_S.watered)).toBeLessThan(1.1);
    expect(g.size).toBeGreaterThanOrEqual(N); // the roofed ones are all still waiting
  });

  it('the rain is asked only when the roll could matter, as the water is (a big field costs nothing)', () => {
    const w = flat();
    const g = new Growth();
    w.put(0, Y, 0, B.PLANTED_CARROT);
    g.track(0, Y, 0, B.PLANTED_CARROT);
    let asked = 0;
    const rained = () => (asked++, true);
    expect(g.step(1, () => 0.5, loaded, w.getBlock, null, rained)).toEqual([]);
    expect(asked).toBe(0);
    const out = g.step(1, () => 0.0001, loaded, w.getBlock, null, rained);
    expect(asked).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].took).toBe(true); // 0.0001 < 0.8: it takes, at the watered rate
  });

  it('with the real weather: watered for a game day after a shower, dry again when a day has passed without one', () => {
    const weather = createWeather(1234);
    const w = flat();
    w.put(0, Y, 0, B.PLANTED_CARROT);
    const first = RAINS_DAYS * DAY;
    const showers = weather.showers(first, YEAR_DAYS * DAY, BIOME.PLAINS); // the dry season's few
    expect(showers.length).toBeGreaterThanOrEqual(3);
    const s = showers[1];
    const state = (t) => cropState(w.getBlock, null, 0, Y, 0, carrot, (q, y, r) => rainedOnCell(weather, t, w, q, y, r, RAIN_WATERS_S));
    expect(state(s.start + 1).rain).toBe(true); // as soon as it rains
    expect(state(s.end + RAIN_WATERS_S - 1).watered).toBe(true);
    expect(state(s.end + RAIN_WATERS_S + 1).watered).toBe(false);
    expect(state(s.start - 1).watered).toBe(showers[0].end > s.start - 1 - RAIN_WATERS_S);
    // snow waters nothing
    const snowy = flat(BIOME.SNOWY);
    snowy.put(0, Y, 0, B.PLANTED_CARROT);
    expect(rainedOnCell(rainy(), 0, snowy, 0, Y, 0, RAIN_WATERS_S)).toBe(false);
  });

  it('main.farmSecondOn hands `rained` to Growth: a seed on dry ground under rain takes at the watered rate', () => {
    const weather = rainy();
    const w = flat();
    const growth = new Growth();
    w.onBlockChange = (q, y, r, prev, next) => growth.onBlockChange(q, y, r, prev, next);
    w.setBlock(0, Y, 0, B.PLANTED_CARROT);
    const rolls = [0.0001, 0.7, 0.99, 0.99]; // the moment comes; 0.7 takes watered (0.8) and would fail dry (0.35)
    let i = 0;
    const random = () => rolls[Math.min(i++, rolls.length - 1)];
    const f = { world: w, growth, spread: new Spread(), isLoadedCell: loaded, waterQuality: null, q: 0, r: 0 };
    const done = farmSecondOn(1, random, { ...f, rained: (q, y, r) => rainedOnCell(weather, 0, w, q, y, r, RAIN_WATERS_S) });
    expect(done.sprouted).toBe(1);
    expect(w.getBlock(0, Y, 0)).toBe(B.CARROT_SPROUT);
    // the same rolls without the rain: the seed does not take
    const v = flat();
    const g2 = new Growth();
    v.onBlockChange = (q, y, r, prev, next) => g2.onBlockChange(q, y, r, prev, next);
    v.setBlock(0, Y, 0, B.PLANTED_CARROT);
    i = 0;
    expect(farmSecondOn(1, random, { ...f, world: v, growth: g2 }).failed).toBe(1);
    expect(v.getBlock(0, Y, 0)).toBe(B.AIR);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('rain puts out open fires (§84.6, campfires.js)', () => {
  it('the chance: 1 − e^(−dt·rain/30), so a fire in steady rain lasts 30 s ÷ the rain\'s strength on average', () => {
    expect(RAIN_DOUSE_MEAN_S).toBe(30);
    expect(rainDouseChance(1, 1)).toBeCloseTo(1 - Math.exp(-1 / 30), 12);
    expect(rainDouseChance(1, 0.5)).toBeCloseTo(1 - Math.exp(-1 / 60), 12);
    expect(rainDouseChance(30, 1)).toBeCloseTo(1 - 1 / Math.E, 12);
    expect(rainDouseChance(1, 0)).toBe(0);
    expect(rainDouseChance(1, -1)).toBe(0);
    expect(rainDouseChance(0, 1)).toBe(0);
    expect(rainDouseChance(1, NaN)).toBe(0);
    expect(rainDouseChance(1, 5)).toBe(rainDouseChance(1, 1)); // the rain is never more than full
    // the step does not matter: ten steps of 0.1 s are one of 1 s
    expect(1 - (1 - rainDouseChance(0.1, 0.7)) ** 10).toBeCloseTo(rainDouseChance(1, 0.7), 12);
  });

  it('by simulation: open fires go out after 30 s on average in full rain, 60 s at half, 30 ÷ LEAF_COVER under leaves', () => {
    for (const [rain, seed] of [[1, 41], [0.5, 42], [LEAF_COVER, 43]]) {
      const fires = new Campfires();
      const N = 800;
      for (let i = 0; i < N; i++) fires.add(i * 3, Y, 0);
      const random = mulberry32(seed);
      let sum = 0;
      let out = 0;
      for (let s = 1; out < N && s < 40 * RAIN_DOUSE_MEAN_S / rain; s++) {
        for (const fire of fires.rainStep(1, random, () => rain)) {
          fires.remove(fire.q, fire.y, fire.r);
          sum += s - 0.5; // it went out somewhere in this second
          out++;
        }
      }
      expect(out).toBe(N);
      expect(sum / out / (RAIN_DOUSE_MEAN_S / rain), `rain ${rain}`).toBeGreaterThan(0.92);
      expect(sum / out / (RAIN_DOUSE_MEAN_S / rain), `rain ${rain}`).toBeLessThan(1.08);
    }
  });

  it('a roofed fire never goes out, however long it rains; nor any fire while it is dry', () => {
    const fires = new Campfires();
    for (let i = 0; i < 50; i++) fires.add(i * 3, Y, 0);
    const random = mulberry32(44);
    for (let s = 0; s < 20000; s++) expect(fires.rainStep(1, random, () => 0)).toEqual([]);
    expect(fires.rainStep(0, random, () => 1)).toEqual([]);
    expect(fires.rainStep(-1, random, () => 1)).toEqual([]);
    expect(new Campfires().rainStep(1, random, () => 1)).toEqual([]);
  });

  it('one roll a fire a step, in tracking order; the world is asked only when the roll is below the chance at full rain', () => {
    const fires = new Campfires();
    for (let i = 0; i < 5; i++) fires.add(i, Y, 0);
    const worst = rainDouseChance(1, 1);
    const rolls = [0.9, worst * 0.5, 0.5, worst * 0.9, worst * 1.01];
    let i = 0;
    const asked = [];
    const out = fires.rainStep(1, () => rolls[i++], (fire) => (asked.push(fire.q), 0.6));
    expect(i).toBe(5);
    expect(asked).toEqual([1, 3]);
    expect(out.map((f) => f.q)).toEqual([1]); // worst·0.5 is under the chance at 0.6 rain; worst·0.9 is not
    expect(rainDouseChance(1, 0.6) / worst).toBeGreaterThan(0.5);
    expect(rainDouseChance(1, 0.6) / worst).toBeLessThan(0.9);
    expect(CAMPFIRE_MAX_TRACKED).toBeLessThanOrEqual(1024); // the rain looks at the tracked fires: the nearest
  });

  /** A world with fires at the given cells, tracked, and the effects recorded. */
  function fireWorld(cells, biome = BIOME.PLAINS) {
    const w = flat(biome);
    const campfires = new Campfires();
    const slots = new FireSlots();
    w.onBlockChange = (q, y, r, prev, next) => {
      campfires.onBlockChange(q, y, r, prev, next);
      slots.onBlockChange(q, y, r, prev, next);
    };
    for (const [q, r] of cells) w.setBlock(q, Y, r, B.CAMPFIRE);
    const fx = { sounds: [], particles: [], said: [] };
    const f = (weather, over = {}) => ({
      world: w, campfires, isLoadedCell: (q, r) => w.hasChunkAtCell(q, r),
      rainOn: (q, y, r) => rainReaching(weather, 0, w, q, y, r),
      sound: (...a) => fx.sounds.push(a), particles: (...a) => fx.particles.push(a), say: (t) => fx.said.push(t),
      x: 0, y: Y, z: 0, ...over,
    });
    return { w, campfires, slots, fx, f };
  }

  it('main.rainSecondOn: the fire becomes a cold FIRE_PIT with a hiss and twelve puffs of steam, as when water reaches one', () => {
    const { w, campfires, slots, fx, f } = fireWorld([[0, 0]]);
    slots.light(0, Y, 0, 300);
    slots.put(0, Y, 0, 'raw_pork', 0);
    expect(slots.fuel(0, Y, 0)).toBe(300);
    expect(rainSecondOn(1, () => 0.5, f(rainy()))).toBe(0); // not this second
    expect(w.getBlock(0, Y, 0)).toBe(B.CAMPFIRE);
    expect(rainSecondOn(1, () => 0.001, f(rainy()))).toBe(1);
    expect(w.getBlock(0, Y, 0)).toBe(B.FIRE_PIT);
    expect(campfires.total).toBe(0); // the tracker follows the write
    const [x, z] = hexToWorld(0, 0);
    expect(fx.sounds).toEqual([['hiss', x, Y + 0.5, z, 1]]);
    expect(fx.particles).toEqual([['steam', x, Y + 0.6, z, 12, { spread: 0.3, speed: 1.2 }]]);
    expect(fx.said).toEqual([RAIN_DOUSE_LINE]);
    expect(RAIN_DOUSE_LINE).toBe('The rain put the campfire out.');
    // the pit keeps what was on the skewers, and has no fuel: it must be lit again
    expect(slots.view(0, Y, 0).spots.filter(Boolean)).toHaveLength(1);
    expect(slots.fuel(0, Y, 0)).toBeNull();
    // and a cold pit is no fire: nothing more happens to it
    expect(rainSecondOn(1, () => 0.001, f(rainy()))).toBe(0);
    expect(fx.sounds).toHaveLength(1);
  });

  it('a fire under any roof is safe: planks, glass, a cave; a tree is not a roof, only slower', () => {
    const cells = [[0, 0], [3, 0], [6, 0], [9, 0], [12, 0]];
    const { w, f } = fireWorld(cells);
    w.put(3, Y + 2, 0, B.OAK_PLANKS);
    w.put(6, Y + 1, 0, B.GLASS);
    w.put(9, Y + 30, 0, B.STONE);
    w.put(12, Y + 4, 0, B.OAK_LEAVES);
    const weather = rainy();
    expect(rainExposure(w.getBlock, 12, Y, 0)).toBe(LEAF_COVER);
    const random = mulberry32(45);
    let leafOut = -1;
    for (let s = 1; s <= 3000; s++) {
      rainSecondOn(1, random, f(weather));
      if (leafOut < 0 && w.getBlock(12, Y, 0) === B.FIRE_PIT) leafOut = s;
    }
    expect(w.getBlock(0, Y, 0)).toBe(B.FIRE_PIT);
    expect(w.getBlock(3, Y, 0)).toBe(B.CAMPFIRE);
    expect(w.getBlock(6, Y, 0)).toBe(B.CAMPFIRE);
    expect(w.getBlock(9, Y, 0)).toBe(B.CAMPFIRE);
    expect(leafOut).toBeGreaterThan(0);
  });

  it('no rain, no harm: in the dry, where it falls as snow, in an unloaded chunk; a fire replaced meanwhile is left alone', () => {
    const dry = fireWorld([[0, 0]]);
    const none = createWeather(1);
    none.force('dry');
    for (let s = 0; s < 500; s++) rainSecondOn(1, () => 0.0001, dry.f(none));
    expect(dry.w.getBlock(0, Y, 0)).toBe(B.CAMPFIRE);
    const snow = fireWorld([[0, 0]], BIOME.SNOWY);
    for (let s = 0; s < 500; s++) rainSecondOn(1, () => 0.0001, snow.f(rainy()));
    expect(snow.w.getBlock(0, Y, 0)).toBe(B.CAMPFIRE);
    const far = fireWorld([[0, 0], [40, 0]]);
    far.w.unload(2, 0); // the chunk of q = 40
    expect(rainSecondOn(1, () => 0.0001, far.f(rainy()))).toBe(1);
    far.w.load(2, 0);
    expect(far.w.getBlock(40, Y, 0)).toBe(B.CAMPFIRE);
    expect(far.w.getBlock(0, Y, 0)).toBe(B.FIRE_PIT);
    // the tracker says fire, the world says otherwise: nothing is written
    const gone = fireWorld([[0, 0]]);
    gone.w.put(0, Y, 0, B.STONE);
    expect(rainSecondOn(1, () => 0.0001, gone.f(rainy()))).toBe(0);
    expect(gone.w.getBlock(0, Y, 0)).toBe(B.STONE);
    expect(gone.fx.sounds).toEqual([]);
  });

  it('the log line is said once for a second\'s fires, and only when one was within RAIN_DOUSE_NOTICE_M of the player', () => {
    expect(RAIN_DOUSE_NOTICE_M).toBe(24);
    const near = fireWorld([[0, 0], [3, 0], [6, 0]]);
    expect(rainSecondOn(1, () => 0.0001, near.f(rainy()))).toBe(3);
    expect(near.fx.said).toEqual([RAIN_DOUSE_LINE]);
    expect(near.fx.sounds).toHaveLength(3);
    const away = fireWorld([[0, 0]]);
    expect(rainSecondOn(1, () => 0.0001, away.f(rainy(), { x: 60, z: 0 }))).toBe(1);
    expect(away.fx.said).toEqual([]);
    expect(away.fx.sounds).toHaveLength(1); // the hiss is still played: main fades it by distance
  });

  it('the hint an unsheltered lit fire carries while it rains', () => {
    expect(RAIN_DOUSE_HINT).toBe('the rain will put it out');
    expect(`Campfire · fuel 4:10 · R: feed the fire · ${RAIN_DOUSE_HINT}`).toBe('Campfire · fuel 4:10 · R: feed the fire · the rain will put it out');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('rain makes you wet and cold (§84.6, climate.js and survival.js)', () => {
  const NOON = 0.5;
  const NIGHT = 23 / 24;
  const OPEN = { biome: BIOME.PLAINS, climateT: 0, openSky: true, underground: false, groundChill: 0 };
  const ROOF = { ...OPEN, openSky: false };
  function started() {
    const s = new Survival();
    s.setMode('survival');
    s.fallGrace = false;
    return s;
  }
  const stander = () => Object.assign(createPlayer(0, 64, 0), { onGround: true, landSpeed: 0 });
  const env = (over = {}) => ({ player: stander(), softFactor: 1, climate: OPEN, heat: 0, time: NOON, random: () => 0.5, ...over });
  function run(s, seconds, e, dt = 0.05) {
    for (let t = 0; t < seconds - 1e-9; t += dt) s.step(dt, e);
  }

  it('the constants: wet through in 20 s of full rain, 6 °C colder, dry again in 90 s', () => {
    expect(RAIN_WET_S).toBe(20);
    expect(WET_CHILL_C).toBe(6);
    expect(WET_CHILL_C).toBe(WET_CHILL); // one number under both names
    expect(WET_DRY_S).toBe(90);
  });

  it('wetRate: rain wets by rain / 20 a second; with no rain the skin dries as it always did', () => {
    expect(wetRate(1, 0, true, NOON)).toBeCloseTo(1 / 20, 12);
    expect(wetRate(0.5, 0, true, NOON)).toBeCloseTo(0.5 / 20, 12);
    expect(wetRate(LEAF_COVER, 0, false, NOON)).toBeCloseTo(LEAF_COVER / 20, 12);
    expect(wetRate(9, 0, true, NOON)).toBeCloseTo(1 / 20, 12); // never more than full rain
    for (const [heat, sky, time] of [[0, true, NOON], [0, false, NOON], [0, true, NIGHT], [12, false, NIGHT], [30, true, NOON]]) {
      expect(wetRate(0, heat, sky, time)).toBe(-dryingRate(heat, sky, time));
      expect(wetRate(NaN, heat, sky, time)).toBe(-dryingRate(heat, sky, time));
      expect(wetRate(-1, heat, sky, time)).toBe(-dryingRate(heat, sky, time));
    }
    // in the rain neither the air nor the sun dries: only a fire's heat does
    expect(wetRate(0.01, 0, true, NOON)).toBeGreaterThan(0);
    expect(wetRate(1, 10, true, NOON)).toBeCloseTo(1 / 20 - 10 / WET_DRY_HEAT_DIV / WET_DRY_S, 12);
    expect(wetRate(0.2, 20, true, NOON)).toBeLessThan(0); // a light rain beside a good fire: you dry
  });

  it('it builds: standing in full rain under the open sky you are Wet within 5 s and wet through after 20', () => {
    const s = started();
    expect(s.status.labels).not.toContain('Wet');
    run(s, 3.9, env({ rain: 1 }));
    expect(s.vitals.wet).toBeLessThan(RATES.WET_LABEL);
    expect(s.status.labels).not.toContain('Wet');
    run(s, 0.3, env({ rain: 1 }));
    expect(s.status.labels).toContain('Wet');
    run(s, 15.7, env({ rain: 1 }));
    expect(s.vitals.wet).toBeCloseTo(0.995, 2);
    run(s, 5, env({ rain: 1 }));
    expect(s.vitals.wet).toBe(1); // and never more
    // a lighter rain takes longer in proportion; under leaves LEAF_COVER of it reaches you
    const light = started();
    run(light, 20, env({ rain: 0.5 }));
    expect(light.vitals.wet).toBeCloseTo(0.5, 6);
    const tree = started();
    run(tree, 20, env({ rain: 1 * LEAF_COVER, climate: ROOF }));
    expect(tree.vitals.wet).toBeCloseTo(LEAF_COVER, 6);
  });

  it('the label is the same Wet as after a swim, and swimming still soaks at once', () => {
    const s = started();
    s.step(1 / 60, env({ player: Object.assign(stander(), { inWater: true }) }));
    expect(s.vitals.wet).toBe(1);
    expect(s.status.labels).toContain('Wet');
    const v = createVitals();
    v.wet = 0.21;
    expect(statusOf(v).labels).toEqual(['Wet']);
    v.wet = 0.2;
    expect(statusOf(v).labels).toEqual([]);
  });

  it('it chills by exactly the constant: wet through, the air feels 6 °C colder (and wet clothes keep half their warmth)', () => {
    const base = { biome: BIOME.PLAINS, climateT: 0, feetY: 64, time: NOON, openSky: true, underground: false, inWater: false, heat: 0, groundChill: 0, insulation: 0, sunShade: 0, activityHeat: 0 };
    expect(feltTemperature({ ...base, wet: 0 }).felt - feltTemperature({ ...base, wet: 1 }).felt).toBeCloseTo(WET_CHILL_C, 12);
    expect(feltTemperature({ ...base, wet: 0 }).felt - feltTemperature({ ...base, wet: 0.5 }).felt).toBeCloseTo(WET_CHILL_C / 2, 12);
    // through the survival step: the felt temperature it reports falls by 6 as the rain soaks you (under a roof's edge
    // of sky that stays the same, at night so no sun comes into it)
    const s = started();
    const e = env({ time: NIGHT, rain: 0 });
    const dry = s.step(0.05, e).felt;
    run(s, 25, env({ time: NIGHT, rain: 1 }));
    expect(s.vitals.wet).toBe(1);
    const wet = s.step(0.05, env({ time: NIGHT, rain: 1 })).felt;
    expect(dry - wet).toBeCloseTo(WET_CHILL_C, 9);
    // in clothes the loss is larger: 6 °C and half the clothes' warmth (cold air: the clothes count in full)
    const cold = { ...base, climateT: -0.6, biome: BIOME.SNOWY, insulation: 10 };
    expect(feltTemperature({ ...cold, wet: 0 }).felt - feltTemperature({ ...cold, wet: 1 }).felt).toBeCloseTo(WET_CHILL_C + 10 * WET_INSULATION_LOSS, 9);
  });

  it('it dries: in 90 s under a roof, in half that in the sun once the rain is over', () => {
    const s = started();
    s.vitals.wet = 1;
    run(s, 45, env({ climate: ROOF, rain: 0 }), 0.25);
    expect(s.vitals.wet).toBeCloseTo(0.5, 9);
    run(s, 45, env({ climate: ROOF, rain: 0 }), 0.25);
    expect(s.vitals.wet).toBeCloseTo(0, 9);
    expect(s.status.labels).not.toContain('Wet');
    const sun = started();
    sun.vitals.wet = 1;
    run(sun, WET_DRY_S / WET_DRY_SUN_MULT - 1, env({ rain: 0 }), 0.25);
    expect(sun.vitals.wet).toBeGreaterThan(0);
    run(sun, 1, env({ rain: 0 }), 0.25);
    expect(sun.vitals.wet).toBeCloseTo(0, 9);
    // under a roof while it rains outside (no rain reaches you) you dry all the same
    const hut = started();
    hut.vitals.wet = 1;
    run(hut, 90, env({ climate: ROOF, rain: 0 }), 0.25);
    expect(hut.vitals.wet).toBeCloseTo(0, 9);
    // but out in the rain you do not dry at all, sun or no sun
    const out = started();
    out.vitals.wet = 0.6;
    run(out, 2, env({ rain: 0.01 }), 0.25);
    expect(out.vitals.wet).toBeGreaterThan(0.6);
  });

  it('it dries faster by a fire: more than three times as fast a cell and a half from a campfire', () => {
    const fire = heatSource('campfire', 0, 64, 0);
    const [fx, fz] = hexToWorld(0, 0);
    const heat = heatAt([fire], fx + 1.5, 64 + CHEST_HEIGHT, fz);
    expect(heat).toBeGreaterThan(10);
    const factor = 1 + heat / WET_DRY_HEAT_DIV;
    expect(factor).toBeGreaterThan(3);
    expect(factor).toBeLessThan(4);
    const beside = started();
    beside.vitals.wet = 1;
    run(beside, WET_DRY_S / factor - 1, env({ climate: ROOF, time: NIGHT, heat, rain: 0 }), 0.25);
    expect(beside.vitals.wet).toBeGreaterThan(0);
    run(beside, 1.5, env({ climate: ROOF, time: NIGHT, heat, rain: 0 }), 0.25);
    expect(beside.vitals.wet).toBe(0);
    const away = started();
    away.vitals.wet = 1;
    run(away, WET_DRY_S / factor, env({ climate: ROOF, time: NIGHT, heat: 0, rain: 0 }), 0.25);
    expect(away.vitals.wet).toBeGreaterThan(0.65); // without the fire: not a third of the way
    // a fire also keeps a light rain off your skin
    const drizzle = started();
    drizzle.vitals.wet = 0.5;
    run(drizzle, 30, env({ time: NIGHT, heat: 20, rain: 0.15 }), 0.25);
    expect(drizzle.vitals.wet).toBeLessThan(0.5);
  });

  it('wet is saved with the vitals and validated on load like the other stats', () => {
    const s = started();
    run(s, 9, env({ rain: 1 }));
    expect(s.vitals.wet).toBeCloseTo(0.45, 6);
    const saved = s.export();
    expect(saved.wet).toBe(0.45);
    expect(SURVIVAL_STATS.find((row) => row[0] === 'wet')).toEqual(['wet', 0, 1, 0]);
    const whole = { ...saved, pack: new Array(PACK_SLOTS).fill(null), wear: [null, null, null], fires: {} };
    expect(normalizeSurvivalJSON(whole).wet).toBe(0.45);
    const back = new Survival();
    back.import(normalizeSurvivalJSON(whole));
    expect(back.vitals.wet).toBe(0.45);
    // a bad value never loads: storage resets it with a warning, and Survival.import refuses it on its own
    for (const bad of [1.5, -0.2, NaN, 'soaked', null]) {
      const warnings = [];
      expect(normalizeSurvivalJSON({ ...whole, wet: bad }, warnings).wet, String(bad)).toBe(0);
      expect(warnings).toEqual(['survival.wet: invalid, reset']);
      const raw = new Survival();
      raw.import({ ...saved, wet: bad });
      expect(raw.vitals.wet, String(bad)).toBe(0);
    }
    // waking and the console's `vitals full` dry you
    s.respawn();
    expect(s.vitals.wet).toBe(0);
  });

  it('nothing changes while it is dry or without the field: the step is what it was', () => {
    const a = started();
    const b = started();
    a.vitals.wet = 0.7;
    b.vitals.wet = 0.7;
    run(a, 10, env({ rain: 0 }), 0.25);
    const e = env();
    delete e.rain;
    run(b, 10, e, 0.25);
    expect(a.vitals).toEqual(b.vitals);
    expect(a.vitals.wet).toBeCloseTo(0.7 - 10 * dryingRate(0, true, NOON), 9);
    const c = started();
    run(c, 5, env({ rain: NaN }), 0.25);
    expect(c.vitals.wet).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the calendar line on the page (§84.4, hud.js)', () => {
  function page() {
    const doc = documentFromHTML(read('index.html'));
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    return { doc, hud, el: /** @type {any} */ (doc.getElementById('calendar-line')) };
  }

  it('hidden in Creative; in Survival it shows the day, the season and Rain while it rains: words, no picture', () => {
    const { hud, el } = page();
    expect(el).toBeTruthy();
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setCalendar(hudLine(12, ''));
    expect(el.classList.contains('hidden')).toBe(true); // Creative: nothing survival shows
    hud.setSurvivalVisible(true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.textContent).toBe('Day 12 · The dry season, day 2 of 18');
    hud.setCalendar(hudLine(3, 'Rain'));
    expect(el.textContent).toBe('Day 3 · The rains, day 3 of 10 · Rain');
    expect(el.children).toHaveLength(0);
    hud.setCalendar(null);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setCalendar(hudLine(4, ''));
    expect(el.classList.contains('hidden')).toBe(false);
    hud.setSurvivalVisible(false);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.dispose();
  });

  it('the DOM is touched only when the text changes', () => {
    const { hud, el } = page();
    hud.setSurvivalVisible(true);
    hud.setCalendar('Day 1 · The rains, day 1 of 10');
    let writes = 0;
    let text = el.textContent;
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set: (v) => {
        writes++;
        text = v;
      },
      configurable: true,
    });
    for (let i = 0; i < 100; i++) hud.setCalendar('Day 1 · The rains, day 1 of 10');
    expect(writes).toBe(0);
    hud.setCalendar('Day 1 · The rains, day 1 of 10 · Rain');
    expect(writes).toBe(1);
    hud.dispose();
  });

  it('a page without the element still works (it is made), and the line is plain: no icon, no hexagon, top centre', () => {
    const doc = documentFromHTML(read('index.html').replace('<div id="calendar-line" class="calendar-line hidden"></div>', ''));
    expect(doc.getElementById('calendar-line')).toBeNull();
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    const el = /** @type {any} */ (doc.getElementById('calendar-line'));
    expect(el).toBeTruthy();
    hud.setSurvivalVisible(true);
    hud.setCalendar('Day 2 · The rains, day 2 of 10');
    expect(el.textContent).toBe('Day 2 · The rains, day 2 of 10');
    hud.dispose();
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.calendar-line\{([^}]*)\}/.exec(css);
    expect(rule).toBeTruthy();
    const decl = Object.fromEntries(rule[1].split(';').filter(Boolean).map((d) => d.split(/:(.*)/).slice(0, 2).map((x) => x.trim())));
    expect(decl.position).toBe('absolute');
    expect(decl.top).toBe('6px');
    expect(decl.left).toBe('50%');
    expect(decl['white-space']).toBe('nowrap');
    expect(decl['clip-path']).toBeUndefined(); // no hexagon
    expect(rule[1]).not.toMatch(/url\(|content:/);
    expect(read('index.html')).toContain('<div id="calendar-line" class="calendar-line hidden"></div>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the wiring (main.js, diagnostics.js, renderer.js): read from the source, since main needs a browser', () => {
  const main = read('src/main.js');
  /** The body of a function of main's closure. */
  const body = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('one weather a world, made from its seed; the clock is the saved day and time', () => {
    const w = body('theWeather');
    expect(w).toContain('weather = createWeather(world ? world.seed : 0);');
    expect(w).toContain('if (weather === null || weatherWorld !== world) {');
    expect(w).toContain('rainRenderer.clear();');
    expect(main).toContain('const weatherNow = () => worldSeconds(day, time);');
    // the day counter and the time are in every save, so the season survives a reload
    const save = body('buildSaveData');
    expect(save).toMatch(/\n {6}time,\n {6}day,\n/);
    expect(main).toContain('day = restoring && Number.isFinite(restoring.day) ? Math.max(1, Math.floor(restoring.day)) : 1;');
  });

  it('the real weather is Survival\'s (Creative keeps its sky); forced weather shows in either mode', () => {
    expect(main).toContain('const weatherOn = () => survival.inSurvival || (weather !== null && weather.forced !== null);');
    const step = body('stepWeather');
    expect(step).toContain('fx.falling = weatherOn() ? w.rainAt(weatherNow(), fx.biome) : 0;');
    expect(body('rainOnCell')).toContain('weatherOn() ? rainReaching(theWeather(), weatherNow(),');
    expect(body('rainedOn')).toContain('weatherOn() && rainedOnCell(theWeather(), weatherNow(),');
    expect(body('rainedOn')).toContain('RAIN_WATERS_S)');
  });

  it('once a frame after computeSky: the log lines, the drops, the ambience\'s rain, the HUD line, the greyed sky', () => {
    const frame = body('renderFrame');
    const at = (text) => {
      expect(frame.indexOf(text), text).toBeGreaterThan(0);
      return frame.indexOf(text);
    };
    expect(at('const shownSky = stepWeather(dt, live, eyeY);')).toBeGreaterThan(at('computeSky(time, sky);'));
    expect(at('stepWorldSounds(dt, live);')).toBeGreaterThan(at('const shownSky = stepWeather(dt, live, eyeY);')); // the ambience hears this frame's rain
    expect(at('renderer.setSky(shownSky);')).toBeGreaterThan(at('stepWorldSounds(dt, live);'));
    const step = body('stepWeather');
    expect(step).toContain('for (const line of seasonNews(fx.lastDay, day)) logLine(line, false, SEASON_LINE_MS);');
    expect(step).toContain('fx.cover = rainExposure(world.getBlock, q, Math.floor(eyeY), r);');
    expect(step).toContain('fx.onPlayer = fx.snow ? 0 : fx.falling * fx.cover;'); // snow wets nobody
    expect(step).toContain('ambienceSample.rain = fx.snow ? 0 : fx.falling;'); // and is silent
    expect(step).toContain('rainRenderer.update(live ? dt : 0, {'); // frozen in the menus
    expect(step).toContain('hud.setCalendar(fx.line);');
    expect(step).toContain('hud.setCalendar(null);');
    expect(step).toContain('return fx.overcast > 0 ? rainSky(sky, fx.overcast, overcastSky) : sky;'); // `sky` itself stays clear
    expect(step).toContain('fx.overcast = approach(fx.overcast, fx.falling, dt, OVERCAST_TAU_S);');
  });

  it('the body: the rain reaching the player goes into the survival step', () => {
    expect(body('stepSurvival')).toContain('env.rain = weatherFx.onPlayer;');
  });

  it('the fires: once a second in Survival, after the farm work; the hint of a lit fire in the rain', () => {
    const step = body('stepSurvival');
    const second = step.slice(step.indexOf('if (survivalSecond >= 1) {'));
    expect(second.indexOf('rainSecond(1, Math.random)')).toBeGreaterThan(second.indexOf('farmSecond(1, Math.random)'));
    expect(second.indexOf('rainSecond(1, Math.random)')).toBeLessThan(second.indexOf('pack.spoil(1, Math.random)'));
    const rain = body('rainSecond');
    expect(rain).toContain('if (campfires.size === 0 || !weatherOn()) return 0;');
    expect(rain).toContain('rainOn: rainOnCell,');
    expect(rain).toContain('sound: playPhysicsSound,');
    expect(body('survivalHintText')).toContain('return rainFireHint(campfireHintText(act), act);');
    const hint = body('rainFireHint');
    expect(hint).toContain('world.getBlock(q, y, r) === BLOCK.CAMPFIRE && rainOnCell(q, y, r) > 0;');
    expect(hint).toContain('return weatherFx.hint ? `${text} · ${RAIN_DOUSE_HINT}` : text;');
  });

  it('F3 says the season, the dryness and the rain; nothing for a game without a calendar', () => {
    const weather = createWeather(7);
    const g = { weather, season: () => seasonOf(3.5), rainNow: () => 0.62 };
    expect(weatherDebugLine(g)).toBe('\nSeason: The rains, day 3 of 10 · dryness 0.30 · rain 0.62');
    weather.force('rain');
    expect(weatherDebugLine({ ...g, season: () => seasonOf(12), rainNow: () => 1 })).toBe('\nSeason: The dry season, day 2 of 18 · dryness 1.00 · rain 1.00 (forced rain)');
    weather.force(null);
    expect(weatherDebugLine({ weather, season: () => seasonOf(1) })).toBe('\nSeason: The rains, day 1 of 10 · dryness 0.65');
    expect(weatherDebugLine(null)).toBe('');
    expect(weatherDebugLine({})).toBe('');
    expect(weatherDebugLine({ season: () => seasonOf(1), weather: null })).toBe(''); // no world yet
    expect(read('src/diagnostics.js')).toContain('    weatherDebugLine(g) +\n');
  });

  it('renderer.setSky under an overcast: less glow, a paler sun, no sun at all behind a heavy one; and back again', () => {
    const stub = { setPixelRatio() {}, setSize() {}, render() {}, dispose() {}, info: { render: { triangles: 0, calls: 0 }, memory: { geometries: 0 } } };
    const canvas = { width: 640, height: 360, addEventListener() {}, removeEventListener() {} };
    const r = createRenderer(/** @type {*} */ (canvas), new THREE.Texture(), { webglRenderer: /** @type {*} */ (stub) });
    const sun = /** @type {any} */ (r.three.scene.getObjectByName('sun'));
    const dome = /** @type {any} */ (r.three.scene.getObjectByName('skyDome'));
    const noon = computeSky(0.5);
    r.setSky(noon);
    const own = sun.material.color.clone();
    const glow = dome.material.uniforms.uGlow.value;
    expect(sun.visible).toBe(true);
    expect(glow).toBe(SKY_GLOW);
    r.setSky(rainSky(noon, 0.5, createSkyState()));
    expect(dome.material.uniforms.uGlow.value).toBeCloseTo(glow * 0.5, 9);
    expect(sun.visible).toBe(true);
    expect(sun.material.color.equals(own)).toBe(false);
    expect(sun.material.color.r).toBeLessThan(own.r); // toward the grey of the sky behind it
    r.setSky(rainSky(noon, OVERCAST_HIDES_SUN + 0.05, createSkyState()));
    expect(sun.visible).toBe(false);
    r.setCamera(3, 70, 3, 0.4, 0); // moving the camera re-anchors the sky: it stays hidden
    expect(sun.visible).toBe(false);
    r.setSky(noon);
    expect(sun.visible).toBe(true);
    expect(sun.material.color.equals(own)).toBe(true);
    expect(dome.material.uniforms.uGlow.value).toBe(glow);
    // the moon, by night, the same
    const moon = /** @type {any} */ (r.three.scene.getObjectByName('moon'));
    const night = computeSky(0);
    r.setSky(night);
    expect(moon.visible).toBe(true);
    r.setSky(rainSky(night, 1, createSkyState()));
    expect(moon.visible).toBe(false);
    r.dispose();
  });

  it('the renderer pales the sun and the moon by SkyState.overcast, and is as before without one', () => {
    const src = read('src/renderer.js');
    expect(src).toContain('const overcast = Math.min(1, Math.max(0, sky.overcast || 0));');
    expect(src).toContain('if (overcast > 0 || lastOvercast > 0) {');
    expect(src).toContain('sunSprite.material.color.copy(sunTint).lerp(cloudColor, overcast);');
    expect(read('src/types.js')).toMatch(/@property \{number\} \[overcast\]/);
  });

  it('the debug handle carries weather, season(), weatherEnv(), setWeather(mode) and setDay(n)', () => {
    const weather = createWeather(7);
    const calls = [];
    let day = 3;
    const game = {
      weather,
      season: () => seasonOf(day),
      weatherEnv: () => weatherEnv(weather, () => 0, () => day, () => BIOME.FOREST),
      setWeather: (mode) => (calls.push(['weather', mode]), weather.force(mode), weather.forced),
      setDay: (n) => (calls.push(['day', n]), (day = n)),
    };
    const win = {};
    const handle = installDebugHandle(win, /** @type {*} */ (game));
    expect(handle.weather).toBe(weather);
    expect(handle.season()).toMatchObject({ key: 'rains', dayOfSeason: 3 });
    expect(handle.weatherEnv().dryness()).toBe(seasonOf(3).dryness);
    expect(handle.weatherEnv().rain(0, 0)).toBe(weather.rainAt(0, BIOME.FOREST));
    expect(handle.setWeather('rain')).toBe('rain');
    expect(weather.rainAt(0, BIOME.DESERT)).toBe(1);
    expect(handle.weatherEnv().rain(0, 0)).toBe(1); // an env built from the same weather follows the forcing
    expect(handle.setWeather(null)).toBeNull();
    expect(handle.setDay(12)).toBe(12);
    expect(handle.season()).toMatchObject({ key: 'dry', dayOfSeason: 2 });
    expect(calls).toEqual([['weather', 'rain'], ['weather', null], ['day', 12]]);
    const bare = installDebugHandle({}, null);
    expect([bare.weather, bare.season(), bare.weatherEnv(), bare.setWeather('rain'), bare.setDay(4)]).toEqual([null, null, null, null, null]);
    // main hands all four over
    const game0 = main.slice(main.indexOf('  const game = {'));
    expect(game0).toMatch(/get weather\(\) \{\n {6}return world \? theWeather\(\) : null;/);
    expect(game0).toContain('season: () => seasonOf(day + time),');
    expect(game0).toContain('weatherEnv: () => (world ? weatherEnvNow() : null),');
    // the env the water system is handed: the helper's exact call, for the live world (main uses it for nothing itself)
    expect(body('weatherEnvNow')).toContain('return weatherEnv(theWeather(), weatherNow, () => day + time, (q, r) => /** @type {World} */ (world).getBiome(q, r));');
    expect(game0).toMatch(/setWeather\(mode\) \{[\s\S]*?w\.force\(mode\);\n {6}return w\.forced;/);
    expect(game0).toMatch(/setDay\(n\) \{\n {6}if \(Number\.isFinite\(n\)\) day = Math\.max\(1, Math\.floor\(n\)\);\n {6}return day;/);
    const types = read('src/types.js');
    const ctx = types.slice(types.indexOf('@typedef {Object} GameContext'));
    expect(game0).toContain('rainNow: () => weatherFx.falling,');
    for (const m of ['weather', 'season', 'rainNow', 'weatherEnv', 'setWeather', 'setDay']) expect(ctx, m).toMatch(new RegExp(`@property \\{[^\\n]*\\} \\[?${m}\\]?`));
  });
});
