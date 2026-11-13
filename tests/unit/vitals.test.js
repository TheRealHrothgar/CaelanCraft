// Unit tests for src/vitals.js — drain, regeneration, bandages, breath, body temperature, status labels, damage over
// time and the damage formulas (docs/DESIGN-survival.md §2, §3.3, §4.5).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import {
  BREATH_MAX_S, BREATH_REFILL_PER_S, FALL_SAFE_SPEED, FALL_DAMAGE_K, SICK_MAX_S, HEAL_MAX, CRUSH_DAMAGE_PER_CELL,
  ZOMBIE_DAMAGE, FIRE_BURN_DAMAGE,
} from '../../src/config.js';
import { getItem } from '../../src/items.js';
import {
  RATES, DAMAGE_CAUSES, SOFT_LANDING, createVitals, wakeVitals, activityFactor, heatFactor, coldFactor, drainRates,
  tempBand, statusOf, stepBreath, stepBodyTemp, stepVitals, softLandingFactor, fallDamage, knockDamage, crushDamage,
  makeSick, eatFood, gulpWater, queueHeal,
} from '../../src/vitals.js';

const COMFY = 20; // a felt temperature inside every comfort band (no heat or cold factor)
const rest = (over = {}) => ({ activity: 1, felt: COMFY, inWater: false, headInWater: false, buried: false, nearFire: false,
  still: false, ...over });
const vitals = (over = {}) => Object.assign(createVitals(), over);

/** Step `seconds` in steps of `dt`; returns the summed damage by cause. */
function run(v, seconds, inp, dt = 0.5, until) {
  const sum = {};
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const res = stepVitals(v, dt, inp);
    for (const [k, d] of Object.entries(res.damage)) sum[k] = (sum[k] ?? 0) + d;
    if (until && until(v)) return { sum, t: (i + 1) * dt };
  }
  return { sum, t: n * dt };
}

describe('createVitals / wakeVitals (§2.1)', () => {
  it('a new state: health 100, Nourishment 80, Hydration 80, 37.0 °C, breath 20 s, dry, well, nothing pending', () => {
    expect(createVitals()).toEqual({
      health: 100, satiation: 80, hydration: 80, temp: 37, breath: BREATH_MAX_S, wet: 0, sick: 0, heal: 0, healRate: 0,
      stillFor: 0,
    });
    expect(createVitals()).not.toBe(createVitals());
  });

  it('waking: health 60, satiation and hydration at least 50, 37 °C, full breath, dry, well, nothing pending', () => {
    const v = vitals({ health: 0, satiation: 12, hydration: 77, temp: 29, breath: 0, wet: 1, sick: 300, heal: 20,
      healRate: 2.5, stillFor: 9 });
    wakeVitals(v);
    expect(v).toEqual({ health: 60, satiation: 50, hydration: 77, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0,
      healRate: 0, stillFor: 0 });
    const full = vitals({ satiation: 95, hydration: 3 });
    wakeVitals(full);
    expect([full.satiation, full.hydration]).toEqual([95, 50]);
    const broken = vitals({ satiation: NaN, hydration: undefined });
    wakeVitals(broken);
    expect([broken.satiation, broken.hydration]).toEqual([50, 50]);
  });
});

describe('drain (§2.2)', () => {
  it('at rest in comfort: Nourishment 100 → 0 in 30 min, Hydration 100 → 0 in 20 min', () => {
    const s = vitals({ satiation: 100, hydration: 1000 });
    const a = run(s, 1900, rest(), 0.5, (v) => v.satiation <= 0);
    expect(a.t).toBeGreaterThan(1795);
    expect(a.t).toBeLessThan(1802);
    const h = vitals({ hydration: 100 });
    const b = run(h, 1300, rest(), 0.5, (v) => v.hydration <= 0);
    expect(b.t).toBeGreaterThan(1197);
    expect(b.t).toBeLessThan(1203);
    expect(RATES.SATIATION_DRAIN * 1800).toBeCloseTo(100, 0);
    expect(RATES.HYDRATION_DRAIN * 1200).toBeCloseTo(100, 0);
  });

  it('the pinned desert-noon rate: felt 42.5 at rest → heatFactor 2.5 → hydration −0.208 /s (80 → 0 in 6.4 min)', () => {
    expect(heatFactor(42.5)).toBe(2.5);
    expect(drainRates(1, 42.5, false).hydration).toBeCloseTo(0.208, 3);
    const v = vitals();
    const r = run(v, 500, rest({ felt: 42.5 }), 0.25, (x) => x.hydration <= 0);
    expect(r.t / 60).toBeCloseTo(6.4, 1);
  });

  it('the worst stack: sprinting at desert noon while sick is 0.0833 × 2.5 × 2.5 × 1.6 = 0.83 /s', () => {
    expect(drainRates(2.5, 46.5, true).hydration).toBeCloseTo(0.0833 * 2.5 * 2.5 * 1.6, 12);
    expect(drainRates(2.5, 46.5, true).hydration).toBeCloseTo(0.83, 2);
    const v = vitals({ sick: 100 });
    const before = v.hydration;
    stepVitals(v, 1, rest({ activity: 2.5, felt: 46.5 }));
    expect(before - v.hydration).toBeCloseTo(0.833, 3);
  });

  it('Hot and Chilled (body temperature) never change the drain: only the felt temperature does', () => {
    const drains = [35, 36, 37, 39, 39.9].map((temp) => {
      const v = vitals({ temp, health: 100 });
      stepVitals(v, 1, rest({ felt: 18 }));
      return [80 - v.satiation, 80 - v.hydration];
    });
    for (const d of drains) {
      expect(d[0]).toBeCloseTo(drains[0][0], 12);
      expect(d[1]).toBeCloseTo(drains[0][1], 12);
    }
    expect(drains[0][0]).toBeCloseTo(RATES.SATIATION_DRAIN, 12);
  });

  it('activity factor: the largest of still 1, walking 1.4, breaking 1.8, swimming 2.2, sprinting 2.5', () => {
    expect(activityFactor({})).toBe(1);
    expect(activityFactor({ moving: true })).toBe(1.4);
    expect(activityFactor({ breaking: true })).toBe(1.8);
    expect(activityFactor({ swimming: true })).toBe(2.2);
    expect(activityFactor({ sprinting: true })).toBe(2.5);
    expect(activityFactor({ moving: true, breaking: true })).toBe(1.8);
    expect(activityFactor({ moving: true, swimming: true, breaking: true })).toBe(2.2);
    expect(activityFactor({ swimming: true, sprinting: true })).toBe(2.5);
    expect(drainRates(1.8, COMFY, false).satiation).toBeCloseTo(0.0556 * 1.8, 12);
    expect(drainRates(NaN, COMFY, false).satiation).toBeCloseTo(0.0556, 12);
  });

  it('heat factor min(2.5, 1 + max(0, felt − 26)/8); cold factor min(2, 1 + max(0, 12 − felt)/12); sick ×1.6', () => {
    expect(heatFactor(26)).toBe(1);
    expect(heatFactor(0)).toBe(1);
    expect(heatFactor(30)).toBe(1.5);
    expect(heatFactor(38)).toBe(2.5);
    expect(heatFactor(60)).toBe(2.5);
    expect(heatFactor(NaN)).toBe(1);
    expect(coldFactor(12)).toBe(1);
    expect(coldFactor(30)).toBe(1);
    expect(coldFactor(6)).toBe(1.5);
    expect(coldFactor(0)).toBe(2);
    expect(coldFactor(-30)).toBe(2);
    expect(coldFactor(NaN)).toBe(1);
    const d = drainRates(1, 0, true);
    expect(d.satiation).toBeCloseTo(0.0556 * 2 * 1.6, 12);
    expect(d.hydration).toBeCloseTo(0.0833 * 1.6, 12); // heat factor 1 in the cold
    const hot = drainRates(1, 40, false);
    expect(hot.satiation).toBeCloseTo(0.0556, 12); // cold factor 1 in the heat
  });

  it('stats never go below 0 nor above 100', () => {
    const v = vitals({ satiation: 0.01, hydration: 0.01 });
    stepVitals(v, 1, rest({ activity: 2.5, felt: 50 }));
    expect(v.satiation).toBe(0);
    expect(v.hydration).toBe(0);
  });
});

describe('statusOf (§2.3): every threshold row', () => {
  const status = (over, inp) => statusOf(vitals(over), inp);

  it('a healthy body: sprint, full speed, regenerating, no labels', () => {
    expect(status({})).toEqual({ canSprint: true, moveFactor: 1, regen: true, labels: [] });
  });

  it('Nourishment: Hungry < 25 (no regeneration), Starving < 10 (no sprint, ×0.9)', () => {
    expect(status({ satiation: 25 }).labels).toEqual([]);
    expect(status({ satiation: 24.9 })).toEqual({ canSprint: true, moveFactor: 1, regen: false, labels: ['Hungry'] });
    expect(status({ satiation: 10 }).labels).toEqual(['Hungry']);
    expect(status({ satiation: 9.9 })).toEqual({ canSprint: false, moveFactor: 0.9, regen: false, labels: ['Starving'] });
    expect(status({ satiation: 0 }).labels).toEqual(['Starving']);
  });

  it('Hydration: Thirsty < 25, Parched < 10 (no sprint, ×0.9)', () => {
    expect(status({ hydration: 25 }).labels).toEqual([]);
    expect(status({ hydration: 24.9 })).toEqual({ canSprint: true, moveFactor: 1, regen: false, labels: ['Thirsty'] });
    expect(status({ hydration: 9.9 })).toEqual({ canSprint: false, moveFactor: 0.9, regen: false, labels: ['Parched'] });
    expect(status({ hydration: 0 }).labels).toEqual(['Parched']);
  });

  it('Wounded below 20 HP: ×0.9, sprint allowed, regeneration unaffected', () => {
    expect(status({ health: 20 }).labels).toEqual([]);
    expect(status({ health: 19.9 })).toEqual({ canSprint: true, moveFactor: 0.9, regen: true, labels: ['Wounded'] });
  });

  it('body temperature bands', () => {
    const cases = [
      [45, 'Heatstroke', false, 0.8, false],
      [41, 'Heatstroke', false, 0.8, false],
      [40.99, 'Overheating', false, 0.9, false],
      [40, 'Overheating', false, 0.9, false],
      [39.99, 'Hot', true, 1, false],
      [38.51, 'Hot', true, 1, false],
      [38.5, null, true, 1, true],
      [37, null, true, 1, true],
      [35.5, null, true, 1, true],
      [35.49, 'Chilled', true, 1, false],
      [34, 'Chilled', true, 1, false],
      [33.99, 'Cold', false, 0.9, false],
      [33, 'Cold', false, 0.9, false],
      [32.99, 'Freezing', false, 0.85, false],
      [31, 'Freezing', false, 0.85, false],
      [30.99, 'Hypothermic', false, 0.75, false], // no sprint: see the CONTRACT-ISSUE in vitals.js
      [25, 'Hypothermic', false, 0.75, false],
    ];
    for (const [temp, label, canSprint, moveFactor, regen] of cases) {
      const s = status({ temp });
      expect(s.labels, `${temp}`).toEqual(label ? [label] : []);
      expect(tempBand(temp), `${temp}`).toBe(label);
      expect(s.canSprint, `${temp}`).toBe(canSprint);
      expect(s.moveFactor, `${temp}`).toBeCloseTo(moveFactor, 12);
      expect(s.regen, `${temp}`).toBe(regen);
    }
    expect(tempBand(NaN)).toBeNull();
  });

  it('Drowning (breath 0, head under water) and Smothering (breath 0, buried); no regeneration without breath', () => {
    expect(status({ breath: 0 }, { headInWater: true }).labels).toEqual(['Drowning']);
    expect(status({ breath: 0 }, { buried: true }).labels).toEqual(['Smothering']);
    expect(status({ breath: 0 }, { headInWater: true, buried: true }).labels).toEqual(['Drowning']);
    expect(status({ breath: 0.1 }, { headInWater: true }).labels).toEqual([]);
    expect(status({ breath: 0 }).labels).toEqual([]); // no circumstances given
    expect(status({ breath: 0 }).regen).toBe(false);
    expect(status({ breath: 0.01 }).regen).toBe(true);
  });

  it('Poisoned (no regeneration) and Wet (> 0.2, shown only)', () => {
    expect(status({ sick: 1 })).toEqual({ canSprint: true, moveFactor: 1, regen: false, labels: ['Poisoned'] });
    expect(status({ wet: 0.2 }).labels).toEqual([]);
    expect(status({ wet: 0.21 })).toEqual({ canSprint: true, moveFactor: 1, regen: true, labels: ['Wet'] });
  });

  it('regeneration needs satiation ≥ 50 and hydration ≥ 50', () => {
    expect(status({ satiation: 50, hydration: 50 }).regen).toBe(true);
    expect(status({ satiation: 49.9 }).regen).toBe(false);
    expect(status({ hydration: 49.9 }).regen).toBe(false);
    expect(status({ satiation: 49.9 }).labels).toEqual([]); // no label between 25 and 50
  });

  it('labels follow the table order; the slow factors multiply but never under 0.6', () => {
    const s = status({ satiation: 5, hydration: 5, health: 10, temp: 30, breath: 0, sick: 10, wet: 1 }, { headInWater: true });
    expect(s.labels).toEqual(['Starving', 'Parched', 'Wounded', 'Hypothermic', 'Drowning', 'Poisoned', 'Wet']);
    expect(0.9 * 0.9 * 0.9 * 0.75).toBeLessThan(0.6);
    expect(s.moveFactor).toBe(0.6);
    expect(s.canSprint).toBe(false);
    expect(status({ satiation: 5, temp: 32 }).moveFactor).toBeCloseTo(0.9 * 0.85, 12);
    expect(status({ hydration: 5, health: 5, temp: 40.5 }).moveFactor).toBeCloseTo(0.9 * 0.9 * 0.9, 12);
  });
});

describe('regeneration and bandages (§2.3)', () => {
  it('0.12 HP/s under the conditions, each HP costs 0.25 Nourishment on top of the drain', () => {
    const v = vitals({ health: 50 });
    run(v, 10, rest(), 0.5);
    expect(v.health).toBeCloseTo(51.2, 9);
    expect(v.satiation).toBeCloseTo(80 - 10 * RATES.SATIATION_DRAIN - 1.2 * 0.25, 9);
  });

  it('doubles after 3 s standing still within reach of a burning campfire (not before, not walking, not without fire)', () => {
    const v = vitals({ health: 50 });
    run(v, 3, rest({ still: true, nearFire: true }), 0.5); // stillFor reaches 3 on the last step
    expect(v.stillFor).toBe(3);
    const at3 = v.health;
    expect(at3).toBeCloseTo(50 + 2.5 * 0.12 + 0.5 * 0.24, 9);
    run(v, 10, rest({ still: true, nearFire: true }), 0.5);
    expect(v.health - at3).toBeCloseTo(2.4, 9);
    const walk = vitals({ health: 50, stillFor: 10 });
    run(walk, 10, rest({ still: false, nearFire: true }), 0.5);
    expect(walk.health).toBeCloseTo(51.2, 9);
    expect(walk.stillFor).toBe(0);
    const cold = vitals({ health: 50 });
    run(cold, 10, rest({ still: true, nearFire: false }), 0.5);
    expect(cold.health).toBeCloseTo(51.2, 9);
  });

  it('stops for each failing condition; never heals past 100; costs nothing at full health', () => {
    const fails = [{ satiation: 49 }, { hydration: 49 }, { temp: 35.4 }, { temp: 38.6 }, { sick: 30 }, { breath: 0 }];
    for (const over of fails) {
      const v = vitals({ health: 50, ...over });
      stepVitals(v, 0.1, rest({ headInWater: over.breath === 0 }));
      expect(v.health, JSON.stringify(over)).toBeLessThanOrEqual(50);
    }
    const top = vitals({ health: 99.99 });
    stepVitals(top, 1, rest());
    expect(top.health).toBe(100);
    expect(top.satiation).toBeCloseTo(80 - RATES.SATIATION_DRAIN - 0.01 * 0.25, 9);
    const full = vitals();
    stepVitals(full, 1, rest());
    expect(full.satiation).toBeCloseTo(80 - RATES.SATIATION_DRAIN, 12);
  });

  it('bandages: fibre queues 15 HP paid at 1.5 HP/s, rag 25 at 2.5, the total capped at 50, whatever the conditions', () => {
    const fibre = getItem('fibre_bandage').heal;
    const rag = getItem('rag_bandage').heal;
    expect([fibre.hp, fibre.rate, rag.hp, rag.rate]).toEqual([15, 1.5, 25, 2.5]);
    // Starving, parched and cold: no regeneration, but the bandage pays out (and the cold does not kill in 10 s).
    const v = vitals({ health: 40, satiation: 0, hydration: 0, temp: 34 });
    expect(queueHeal(v, fibre.hp, fibre.rate)).toBe(true);
    expect([v.heal, v.healRate]).toEqual([15, 1.5]);
    const r = run(v, 4, rest({ felt: 10 }), 0.5);
    const dot = (r.sum.starve ?? 0) + (r.sum.thirst ?? 0);
    expect(v.health).toBeCloseTo(40 + 6 - dot, 9);
    expect(v.heal).toBeCloseTo(9, 9);
    run(v, 10, rest({ felt: 10 }), 0.5);
    expect(v.heal).toBe(0);
    expect(v.healRate).toBe(0);
    // The cap.
    const c = vitals({ health: 10 });
    expect(queueHeal(c, 25, 2.5)).toBe(true);
    expect(queueHeal(c, 25, 2.5)).toBe(true);
    expect(c.heal).toBe(HEAL_MAX);
    expect(queueHeal(c, 15, 1.5)).toBe(false);
    expect(c.healRate).toBe(2.5); // a slower bandage never slows the queue
    const d = vitals({ health: 10, heal: 10, healRate: 1.5 });
    expect(queueHeal(d, 25, 2.5)).toBe(true);
    expect([d.heal, d.healRate]).toEqual([35, 2.5]); // a faster one speeds it up
    const e = vitals({ heal: 45, healRate: 2.5 });
    expect(queueHeal(e, 15, 1.5)).toBe(true);
    expect(e.heal).toBe(50);
    expect(queueHeal(vitals(), 0, 1.5)).toBe(false);
    expect(queueHeal(vitals(), 10, 0)).toBe(false);
    expect(queueHeal(vitals(), NaN, 1)).toBe(false);
  });

  it('pending healing never pushes health over 100 (it is paid out regardless) and survives a lost rate', () => {
    const v = vitals({ health: 98, heal: 15, healRate: 1.5 });
    run(v, 12, rest(), 0.5);
    expect(v.health).toBe(100);
    expect(v.heal).toBe(0);
    const lost = vitals({ health: 50, heal: 3, healRate: 0 });
    run(lost, 2, rest({ felt: 0 }), 0.5);
    expect(lost.heal).toBe(0);
  });
});

describe('breath (§2.1, §2.4)', () => {
  it('20 s to empty under water or buried, 4 s to refill', () => {
    for (const inp of [{ headInWater: true }, { buried: true }]) {
      const v = vitals();
      const r = run(v, 30, rest(inp), 0.25, (x) => x.breath <= 0);
      expect(r.t).toBeCloseTo(20, 9);
      const back = run(v, 10, rest(), 0.25, (x) => x.breath >= BREATH_MAX_S);
      expect(back.t).toBeCloseTo(BREATH_MAX_S / BREATH_REFILL_PER_S, 9);
      expect(back.t).toBe(4);
    }
    expect(stepBreath(vitals({ breath: 0.3 }), 1, true)).toBeCloseTo(0.7, 12);
    expect(stepBreath(vitals({ breath: 5 }), 1, true)).toBe(0);
    expect(stepBreath(vitals({ breath: 0 }), 1, false)).toBe(0);
  });

  it('drown and buried deal 8 HP/s at breath 0, counted from the moment breath runs out', () => {
    const v = vitals({ breath: 0.5 });
    const r = stepVitals(v, 1, rest({ headInWater: true }));
    expect(r.damage).toEqual({ drown: 4 });
    expect(r.total).toBe(4);
    expect(v.health).toBe(96);
    const w = vitals({ breath: 0 });
    expect(stepVitals(w, 0.5, rest({ buried: true })).damage).toEqual({ buried: 4 });
    const both = vitals({ breath: 0 });
    expect(stepVitals(both, 1, rest({ buried: true, headInWater: true })).damage).toEqual({ drown: 8 });
    const long = vitals();
    const sum = run(long, 25, rest({ headInWater: true }), 0.25).sum;
    expect(sum.drown).toBeCloseTo(40, 9);
  });
});

describe('body temperature (§3.3)', () => {
  it('drifts with τ 120 s away from 37 and 40 s back, × 0.3 in water; clamped to 25..45', () => {
    const away = vitals({ temp: 37 });
    stepBodyTemp(away, 1, 30, false);
    expect(away.temp).toBeCloseTo(37 - 7 / 120, 12);
    const back = vitals({ temp: 33 });
    stepBodyTemp(back, 1, 37, false);
    expect(back.temp).toBeCloseTo(33 + 4 / 40, 12);
    const backHot = vitals({ temp: 40 });
    stepBodyTemp(backHot, 1, 37, false);
    expect(backHot.temp).toBeCloseTo(40 - 3 / 40, 12);
    const water = vitals({ temp: 37 });
    stepBodyTemp(water, 1, 30, true);
    expect(water.temp).toBeCloseTo(37 - 7 / 36, 12);
    const deeper = vitals({ temp: 35 });
    stepBodyTemp(deeper, 1, 30, false);
    expect(deeper.temp).toBeCloseTo(35 - 5 / 120, 12);
    const huge = vitals({ temp: 37 });
    stepBodyTemp(huge, 1000, 20, false);
    expect(huge.temp).toBe(25);
    const hot = vitals({ temp: 44.99 });
    stepBodyTemp(hot, 1000, 60, false);
    expect(hot.temp).toBe(45);
    const nan = vitals({ temp: NaN });
    stepBodyTemp(nan, 1, 37, false);
    expect(nan.temp).toBe(37);
  });

  it('stepVitals drifts toward climate.bodyTarget(felt): the snowy night (felt −13.2) reaches Freezing at ~1.7 min', () => {
    const v = vitals();
    const r = run(v, 200, rest({ felt: -13.2 }), 0.25, (x) => x.temp < 33);
    expect(r.t / 60).toBeCloseTo(1.7, 1);
  });
});

describe('damage over time (§2.3, §2.4)', () => {
  it('starve 0.35, thirst 0.7, Overheating and Freezing 0.4, Heatstroke and Hypothermic 1.5 HP/s', () => {
    expect(stepVitals(vitals({ satiation: 0 }), 1, rest()).damage).toEqual({ starve: 0.35 });
    expect(stepVitals(vitals({ hydration: 0 }), 1, rest()).damage).toEqual({ thirst: 0.7 });
    expect(stepVitals(vitals({ temp: 40.5 }), 1, rest({ felt: 60 })).damage).toEqual({ heat: 0.4 });
    expect(stepVitals(vitals({ temp: 42 }), 1, rest({ felt: 60 })).damage).toEqual({ heat: 1.5 });
    expect(stepVitals(vitals({ temp: 32 }), 1, rest({ felt: -20 })).damage).toEqual({ cold: 0.4 });
    expect(stepVitals(vitals({ temp: 30 }), 1, rest({ felt: -20 })).damage).toEqual({ cold: 1.5 });
    expect(stepVitals(vitals({ temp: 33.5 }), 1, rest({ felt: -20 })).damage).toEqual({}); // Cold: no damage
    expect(stepVitals(vitals({ temp: 39.5 }), 1, rest({ felt: 60 })).damage).toEqual({}); // Hot: no damage
    const all = stepVitals(vitals({ satiation: 0, hydration: 0, temp: 30 }), 1, rest({ felt: -20 }));
    expect(all.total).toBeCloseTo(0.35 + 0.7 + 1.5, 12);
  });

  it('sickness: 0.15 HP/s, never below 10 HP, no regeneration, drains ×1.6; it counts down', () => {
    const v = vitals({ health: 50, sick: 45 });
    const r = run(v, 10, rest(), 0.5);
    expect(r.sum.sick).toBeCloseTo(1.5, 9);
    expect(v.health).toBeCloseTo(48.5, 9);
    expect(v.sick).toBeCloseTo(35, 9);
    expect(v.satiation).toBeCloseTo(80 - 10 * 0.0556 * 1.6, 9);
    const floor = vitals({ health: 10.05, sick: 600 });
    run(floor, 60, rest(), 0.5);
    expect(floor.health).toBeCloseTo(10, 9);
    const under = vitals({ health: 8, sick: 600 });
    expect(stepVitals(under, 1, rest()).damage).toEqual({});
    expect(under.health).toBe(8);
    // Other damage first: sickness only takes what is left above 10.
    const mixed = vitals({ health: 10.5, sick: 60, satiation: 0 });
    const m = stepVitals(mixed, 1, rest());
    expect(m.damage.starve).toBeCloseTo(0.35, 12);
    expect(m.damage.sick).toBeCloseTo(0.15, 12);
    const mixed2 = vitals({ health: 10.2, sick: 60, satiation: 0 });
    expect(stepVitals(mixed2, 1, rest()).damage.sick).toBeUndefined();
    const ends = vitals({ health: 50, sick: 45 });
    run(ends, 46, rest(), 0.5);
    expect(ends.sick).toBe(0);
  });

  it('health never goes below 0; dt ≤ 0 or no input does nothing', () => {
    const v = vitals({ health: 1, satiation: 0, hydration: 0, temp: 26 });
    stepVitals(v, 1, rest({ felt: -30 }));
    expect(v.health).toBe(0);
    const w = vitals();
    expect(stepVitals(w, 0, rest())).toEqual({ damage: {}, total: 0 });
    expect(stepVitals(w, NaN, rest())).toEqual({ damage: {}, total: 0 });
    expect(stepVitals(w, 1, null)).toEqual({ damage: {}, total: 0 });
    expect(w).toEqual(createVitals());
  });
});

describe('damage formulas (§2.4)', () => {
  it('fall: 0.1·(v² − 14²) above the safe speed, × the soft-landing factor', () => {
    expect([FALL_SAFE_SPEED, FALL_DAMAGE_K]).toEqual([14, 0.1]);
    expect(fallDamage(13.07)).toBe(0); // a 3-cell drop
    expect(fallDamage(13.7)).toBe(0); // a jump off a 2-cell ledge (play-test: 13.5 made the most ordinary hop flash red)
    expect(fallDamage(14)).toBe(0);
    // The §2.4 table (speeds are 28·n/60).
    const table = [[32, 2.7], [36, 8.6], [39, 13.5], [45, 24.5], [51, 37.0], [56, 48.7], [62, 64.1], [72, 93.3], [73, 96.5],
      [75, 102.9]];
    for (const [n, hp] of table) expect(fallDamage((28 * n) / 60), `n ${n}`).toBeCloseTo(hp, 1);
    expect(fallDamage(20, 0.4)).toBeCloseTo(0.4 * 0.1 * (400 - 196), 12);
    expect(fallDamage(20, 2)).toBeCloseTo(fallDamage(20), 12); // the factor is clamped to 0..1
    expect(fallDamage(20, NaN)).toBeCloseTo(fallDamage(20), 12);
    expect(fallDamage(NaN)).toBe(0);
    expect(fallDamage(-30)).toBe(0);
  });

  it('soft landings: the softest of the cells under the feet', () => {
    expect(softLandingFactor([BLOCK.SNOW_BLOCK])).toBe(0.4);
    for (const id of [BLOCK.OAK_LEAVES, BLOCK.SPRUCE_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.HAY_BALE]) {
      expect(softLandingFactor([id])).toBe(0.6);
    }
    const wools = Object.keys(BLOCK).filter((k) => k.startsWith('WOOL_'));
    expect(wools).toHaveLength(16);
    for (const k of wools) expect(softLandingFactor([BLOCK[k]]), k).toBe(0.7);
    expect(softLandingFactor([BLOCK.SLEEPING_HIDE])).toBe(0.9);
    expect(softLandingFactor([BLOCK.STONE, BLOCK.GRASS_BLOCK])).toBe(1);
    expect(softLandingFactor([BLOCK.STONE, BLOCK.WOOL_RED, BLOCK.HAY_BALE])).toBe(0.6);
    expect(softLandingFactor([BLOCK.SLEEPING_HIDE, BLOCK.SNOW_BLOCK, BLOCK.DIRT])).toBe(0.4);
    expect(softLandingFactor([])).toBe(1);
    expect(softLandingFactor(null)).toBe(1);
    expect(Object.keys(SOFT_LANDING)).toHaveLength(1 + 3 + 1 + 16 + 1);
    // Every other block id lands hard.
    for (let id = 0; id < 256; id++) {
      const f = softLandingFactor([id]);
      expect(f === 1 || Object.hasOwn(SOFT_LANDING, id), String(id)).toBe(true);
    }
  });

  it('blast and log: 6·max(0, |Δv| − 5); crush 6 per cell; the other instant amounts', () => {
    expect(knockDamage(17)).toBe(72);
    expect(knockDamage(6.4)).toBeCloseTo(8.4, 12);
    expect(knockDamage(5)).toBe(0);
    expect(knockDamage(2)).toBe(0);
    expect(knockDamage(NaN)).toBe(0);
    expect(crushDamage(3)).toBe(18);
    expect(crushDamage(-1)).toBe(0);
    expect(crushDamage(NaN)).toBe(0);
    expect(CRUSH_DAMAGE_PER_CELL).toBe(6);
    expect([RATES.ZOMBIE, RATES.FIRE, ZOMBIE_DAMAGE, FIRE_BURN_DAMAGE]).toEqual([8, 4, 8, 4]);
  });

  it('the cause keys of §2.4', () => {
    expect(DAMAGE_CAUSES).toEqual(['fall', 'drown', 'buried', 'crush', 'fire', 'zombie', 'blast', 'log', 'blackhole',
      'starve', 'thirst', 'cold', 'heat', 'sick', 'void', 'command', 'bear']); // + a bear's maul (§76 fauna)
  });
});

describe('eating and drinking (§4.2, §4.5)', () => {
  it('applies Nourishment and Hydration, capped at 100 and never below 0', () => {
    const v = vitals({ satiation: 90, hydration: 3 });
    expect(eatFood(v, getItem('roast_pork').food, () => 0.99)).toEqual({ sick: false, cured: false }); // `cured`: v0.14 (§76 flora)
    expect(v.satiation).toBe(100);
    expect(v.hydration).toBe(1);
    eatFood(v, getItem('charred_meat').food, () => 0.99);
    expect(v.hydration).toBe(0);
    eatFood(v, getItem('pot_sap').food, () => 0.99);
    expect([v.satiation, v.hydration]).toEqual([100, 25]);
  });

  it('snow cools the body 0.2 °C at once; the sickness roll is random() < chance and adds 45 s up to 600', () => {
    const v = vitals({ temp: 37 });
    eatFood(v, getItem('snow').food, () => 0.5);
    expect(v.temp).toBeCloseTo(36.8, 12);
    expect(v.hydration).toBe(83);
    const pork = getItem('raw_pork').food; // 30 %
    const s = vitals();
    expect(eatFood(s, pork, () => 0.29).sick).toBe(true);
    expect(s.sick).toBe(45);
    expect(eatFood(s, pork, () => 0.3).sick).toBe(false);
    expect(s.sick).toBe(45);
    const boiled = getItem('pot_boiled').food; // safe
    expect(eatFood(s, boiled, () => 0).sick).toBe(false);
    s.sick = 590;
    makeSick(s);
    expect(s.sick).toBe(SICK_MAX_S);
    const cold = vitals({ temp: 25.1 });
    eatFood(cold, getItem('snow').food, () => 1);
    expect(cold.temp).toBe(25);
  });

  it('hand gulps: fresh +8 with a 20 % chance of poisoning (which costs 8 Hydration and 4 Nourishment at once), salt −4', () => {
    const v = vitals({ hydration: 50, satiation: 50 });
    expect(gulpWater(v, false, () => 0.5)).toEqual({ sick: false });
    expect(gulpWater(v, false, () => 0.201)).toEqual({ sick: false });
    expect(v.hydration).toBe(66);
    expect(gulpWater(v, false, () => 0.199)).toEqual({ sick: true });
    expect(v.sick).toBe(45);
    expect(v.hydration).toBe(66); // +8 − 8
    expect(v.satiation).toBe(46);
    expect(gulpWater(v, true, () => 0)).toEqual({ sick: false });
    expect(v.hydration).toBe(62);
    const dry = vitals({ hydration: 2 });
    gulpWater(dry, true, () => 0);
    expect(dry.hydration).toBe(0);
    const full = vitals({ hydration: 97 });
    gulpWater(full, false, () => 1);
    expect(full.hydration).toBe(100);
  });
});
