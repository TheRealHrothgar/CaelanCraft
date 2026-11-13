// Caelancraft — vitals: the survival body's stats and how they change (drain, regeneration, bandages, breath, body
// temperature, damage over time), its status labels, and the damage formulas. Pure: no DOM, no clocks, no Math.random
// (callers pass `random`). See docs/DESIGN-survival.md §2–§3.3 (CONTRACTS §45 once merged).
//
// Rates are per real second. The stat stored as `satiation` is shown to the player as Nourishment. Every number of
// §2.2–§2.4 is in RATES, by name, so the tests reach them by name.
//
// CONTRACT-ISSUE (import graph, DESIGN-survival §9.1): the graph lists `vitals → config`. `softLandingFactor(ids)` needs
// the block ids of §2.4's soft-landing table (blocks.js), and `stepVitals` drifts the body toward `climate.bodyTarget`
// (§3.3), whose formula lives in climate.js. Both are leaf modules that never import vitals.js, so the graph stays acyclic
// (vitals → config, blocks, climate) and nothing is copied.
//
// CONTRACT-ISSUE (§2.3 table): the Hypothermic row lists "1.5 HP/s, slow ×0.75" but no "no sprint", although the milder
// Cold and Freezing rows both forbid sprinting. A body colder than a Freezing one cannot sprint either, so Hypothermic
// forbids it too (statusOf).
import {
  STAT_MAX, BREATH_MAX_S, BREATH_REFILL_PER_S, BODY_TEMP_NORMAL, BODY_TEMP_MIN, BODY_TEMP_MAX, SICK_MAX_S, HEAL_MAX,
  FALL_SAFE_SPEED, FALL_DAMAGE_K, CRUSH_DAMAGE_PER_CELL, ZOMBIE_DAMAGE, FIRE_BURN_DAMAGE,
} from './config.js';
import { BLOCK } from './blocks.js';
import { bodyTarget } from './climate.js';

/**
 * The body's stats (§2.1). `stillFor` (seconds stood still, for the campfire regeneration bonus) is not saved.
 * @typedef {Object} Vitals
 * @property {number} health     0..100 HP; 0 = death
 * @property {number} satiation  0..100, shown as Nourishment
 * @property {number} hydration  0..100
 * @property {number} temp       body temperature, 25..45 °C
 * @property {number} breath     0..20 s
 * @property {number} wet        0..1
 * @property {number} sick       seconds of sickness left, 0..600
 * @property {number} heal       pending bandage healing, 0..50 HP
 * @property {number} healRate   its payout rate (HP/s); 0 when nothing is pending
 * @property {number} stillFor   seconds the player has stood still
 */

/**
 * @typedef {Object} VitalsInput  one step's circumstances (§2.2–§2.4)
 * @property {number} activity      the activity factor (activityFactor): 1 still … 2.5 sprinting
 * @property {number} felt          felt temperature (climate.feltTemperature), °C
 * @property {boolean} [inWater]    swimming: the body drifts 3.3× faster (§3.3)
 * @property {boolean} [headInWater] the eye is under water: breath drains (drown at 0)
 * @property {boolean} [buried]     the eye is inside a solid cell with no room within 3 above: breath drains (smother at 0)
 * @property {boolean} [nearFire]   a burning campfire within 4 cells
 * @property {boolean} [still]      the player stood still this step
 */

/**
 * @typedef {Object} VitalsStatus
 * @property {boolean} canSprint
 * @property {number} moveFactor   product of the slow factors, never under RATES.MOVE_FACTOR_MIN (0.6)
 * @property {boolean} regen       health regenerates (§2.3 conditions)
 * @property {string[]} labels     the §2.3 labels, in the table's order
 */

/** Every number of §2.2–§2.4 by name. */
export const RATES = Object.freeze({
  // §2.1 new state and waking
  NEW_HEALTH: STAT_MAX,
  NEW_SATIATION: 80,
  NEW_HYDRATION: 80,
  WAKE_HEALTH: 60,
  WAKE_MIN_STAT: 50,          // satiation and hydration wake at max(current, 50)
  // §2.2 drain (per second, before the factors)
  SATIATION_DRAIN: 0.0556,    // 100 → 0 in 30 min at rest
  HYDRATION_DRAIN: 0.0833,    // 100 → 0 in 20 min at rest
  BREATH_MAX: BREATH_MAX_S,
  BREATH_REFILL: BREATH_REFILL_PER_S,
  ACTIVITY_STILL: 1,
  ACTIVITY_WALK: 1.4,         // horizontal speed > WALK_MIN_SPEED
  ACTIVITY_BREAK: 1.8,
  ACTIVITY_SWIM: 2.2,
  ACTIVITY_SPRINT: 2.5,
  WALK_MIN_SPEED: 0.5,        // m/s
  HEAT_FACTOR_FROM: 26,       // heatFactor = min(2.5, 1 + max(0, felt − 26) / 8)
  HEAT_FACTOR_SPAN: 8,
  HEAT_FACTOR_MAX: 2.5,
  COLD_FACTOR_FROM: 12,       // coldFactor = min(2, 1 + max(0, 12 − felt) / 12)
  COLD_FACTOR_SPAN: 12,
  COLD_FACTOR_MAX: 2,
  SICK_FACTOR: 1.6,           // drains while sick
  // §2.3 regeneration
  REGEN: 0.12,                // HP/s
  REGEN_COST: 0.25,           // satiation per HP healed
  REGEN_FIRE_MULT: 2,         // still for REGEN_STILL_S beside a burning campfire
  REGEN_STILL_S: 3,
  REGEN_MIN_SATIATION: 50,
  REGEN_MIN_HYDRATION: 50,
  REGEN_TEMP_MIN: 35.5,
  REGEN_TEMP_MAX: 38.5,
  // §2.3 status thresholds
  HUNGRY: 25,                 // satiation below
  STARVING: 10,
  THIRSTY: 25,                // hydration below
  PARCHED: 10,
  WOUNDED: 20,                // health below
  HEATSTROKE: 41,             // body ≥
  OVERHEATING: 40,            // body ≥ (below HEATSTROKE)
  HOT: 38.5,                  // body > (below OVERHEATING)
  CHILLED: 35.5,              // body < (≥ COLD)
  COLD: 34,                   // body < (≥ FREEZING)
  FREEZING: 33,               // body < (≥ HYPOTHERMIC)
  HYPOTHERMIC: 31,            // body <
  WET_LABEL: 0.2,             // wet > this shows Wet
  // §2.3 slow factors
  SLOW_STARVING: 0.9,
  SLOW_PARCHED: 0.9,
  SLOW_WOUNDED: 0.9,
  SLOW_HEATSTROKE: 0.8,
  SLOW_OVERHEATING: 0.9,
  SLOW_COLD: 0.9,
  SLOW_FREEZING: 0.85,
  SLOW_HYPOTHERMIC: 0.75,
  MOVE_FACTOR_MIN: 0.6,
  // §2.3 / §2.4 damage over time (HP/s)
  STARVE_DPS: 0.35,           // satiation 0
  THIRST_DPS: 0.7,            // hydration 0
  HEATSTROKE_DPS: 1.5,
  OVERHEAT_DPS: 0.4,
  FREEZING_DPS: 0.4,
  HYPOTHERMIA_DPS: 1.5,
  DROWN_DPS: 8,
  BURIED_DPS: 8,
  SICK_DPS: 0.15,
  SICK_FLOOR: 10,             // sickness never takes health below this
  // §4.5 sickness
  SICK_S: 45,                 // one case; cases add up to SICK_MAX
  // v0.11 (§66): a case of poisoning also hits at once — thirstier and hungrier
  POISON_THIRST: -8,
  POISON_HUNGER: -4,
  SICK_MAX: SICK_MAX_S,
  // §2.3 bandages
  HEAL_MAX,
  HEAL_RATE_FALLBACK: 1.5,    // pending healing with no rate (a hand-edited save) pays out at the fibre bandage's rate
  // §3.3 body temperature
  TAU_AWAY: 120,              // s, drifting away from 37
  TAU_BACK: 40,               // s, drifting back toward 37
  WATER_TAU: 0.3,             // τ multiplier in water
  // §2.4 instant damage
  FALL_SAFE_SPEED,
  FALL_DAMAGE_K,
  KNOCK_SAFE: 5,              // blast / log: 6 · max(0, |Δv| − 5)
  KNOCK_K: 6,
  CRUSH_PER_CELL: CRUSH_DAMAGE_PER_CELL,
  ZOMBIE: ZOMBIE_DAMAGE,
  FIRE: FIRE_BURN_DAMAGE,
  // §4.2 hand gulps
  GULP_FRESH: 8,
  GULP_FRESH_SICK: 0.2,       // raw water from a source poisons one gulp in five (0.06 from v0.11 §66 until v0.15 §79): boil it
  GULP_TAINTED_SICK: 0.4,     // v0.14 (CONTRACTS §76 water): a gulp of tainted water poisons two times in five
  GULP_SALT: -4,
});

/** Every damage cause key of §2.4 (DamageCause). 'sick' never kills. */
export const DAMAGE_CAUSES = Object.freeze([
  'fall', 'drown', 'buried', 'crush', 'fire', 'zombie', 'blast', 'log', 'blackhole', 'starve', 'thirst', 'cold', 'heat',
  'sick', 'void', 'command',
  'bear', // v0.14 (§76 fauna): a bear's maul (animals.BEAR_DAMAGE)
]);

/** Soft landings (§2.4): block landed on → fall damage factor; anything else 1. */
export const SOFT_LANDING = Object.freeze(Object.fromEntries([
  [BLOCK.SNOW_BLOCK, 0.4],
  [BLOCK.OAK_LEAVES, 0.6], [BLOCK.SPRUCE_LEAVES, 0.6], [BLOCK.BIRCH_LEAVES, 0.6],
  [BLOCK.HAY_BALE, 0.6],
  ...Object.keys(BLOCK).filter((k) => k.startsWith('WOOL_')).map((k) => [BLOCK[k], 0.7]),
  [BLOCK.SLEEPING_HIDE, 0.9],
]));

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** @param {*} v @returns {boolean} */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @returns {Vitals} a new survival state's body (§2.1) */
export function createVitals() {
  return {
    health: RATES.NEW_HEALTH,
    satiation: RATES.NEW_SATIATION,
    hydration: RATES.NEW_HYDRATION,
    temp: BODY_TEMP_NORMAL,
    breath: BREATH_MAX_S,
    wet: 0,
    sick: 0,
    heal: 0,
    healRate: 0,
    stillFor: 0,
  };
}

/**
 * Apply the waking values (§2.1): health 60, satiation and hydration at least 50, body 37, full breath, dry, well, no
 * pending healing.
 * @param {Vitals} v
 */
export function wakeVitals(v) {
  v.health = RATES.WAKE_HEALTH;
  v.satiation = Math.max(finite(v.satiation) ? v.satiation : 0, RATES.WAKE_MIN_STAT);
  v.hydration = Math.max(finite(v.hydration) ? v.hydration : 0, RATES.WAKE_MIN_STAT);
  v.temp = BODY_TEMP_NORMAL;
  v.breath = BREATH_MAX_S;
  v.wet = 0;
  v.sick = 0;
  v.heal = 0;
  v.healRate = 0;
  v.stillFor = 0;
}

/**
 * The activity factor (§2.2): the largest that applies — still 1, walking 1.4, breaking 1.8, swimming 2.2, sprinting 2.5.
 * @param {{ moving?: boolean, breaking?: boolean, swimming?: boolean, sprinting?: boolean }} a
 * @returns {number}
 */
export function activityFactor(a) {
  /** @type {number} */
  let f = RATES.ACTIVITY_STILL;
  if (a.moving) f = Math.max(f, RATES.ACTIVITY_WALK);
  if (a.breaking) f = Math.max(f, RATES.ACTIVITY_BREAK);
  if (a.swimming) f = Math.max(f, RATES.ACTIVITY_SWIM);
  if (a.sprinting) f = Math.max(f, RATES.ACTIVITY_SPRINT);
  return f;
}

/** @param {number} felt @returns {number} the hydration drain factor: min(2.5, 1 + max(0, felt − 26) / 8) (§2.2) */
export function heatFactor(felt) {
  const f = finite(felt) ? felt : RATES.HEAT_FACTOR_FROM;
  return Math.min(RATES.HEAT_FACTOR_MAX, 1 + Math.max(0, f - RATES.HEAT_FACTOR_FROM) / RATES.HEAT_FACTOR_SPAN);
}

/** @param {number} felt @returns {number} the satiation drain factor: min(2, 1 + max(0, 12 − felt) / 12) (§2.2) */
export function coldFactor(felt) {
  const f = finite(felt) ? felt : RATES.COLD_FACTOR_FROM;
  return Math.min(RATES.COLD_FACTOR_MAX, 1 + Math.max(0, RATES.COLD_FACTOR_FROM - f) / RATES.COLD_FACTOR_SPAN);
}

/**
 * Per-second drains at these circumstances (§2.2): satiation 0.0556 × activity × coldFactor × sickFactor, hydration
 * 0.0833 × activity × heatFactor × sickFactor. Body temperature never enters them (Hot and Chilled only stop regeneration).
 * @param {number} activity
 * @param {number} felt
 * @param {boolean} sick
 * @returns {{ satiation: number, hydration: number }}
 */
export function drainRates(activity, felt, sick) {
  const a = finite(activity) && activity > 0 ? activity : RATES.ACTIVITY_STILL;
  const s = sick ? RATES.SICK_FACTOR : 1;
  return {
    satiation: RATES.SATIATION_DRAIN * a * coldFactor(felt) * s,
    hydration: RATES.HYDRATION_DRAIN * a * heatFactor(felt) * s,
  };
}

/**
 * The body-temperature band of §2.3, or null in the comfortable 35.5–38.5 °C.
 * @param {number} temp
 * @returns {'Heatstroke'|'Overheating'|'Hot'|'Chilled'|'Cold'|'Freezing'|'Hypothermic'|null}
 */
export function tempBand(temp) {
  if (!finite(temp)) return null;
  if (temp >= RATES.HEATSTROKE) return 'Heatstroke';
  if (temp >= RATES.OVERHEATING) return 'Overheating';
  if (temp > RATES.HOT) return 'Hot';
  if (temp < RATES.HYPOTHERMIC) return 'Hypothermic';
  if (temp < RATES.FREEZING) return 'Freezing';
  if (temp < RATES.COLD) return 'Cold';
  if (temp < RATES.CHILLED) return 'Chilled';
  return null;
}

/**
 * Status (§2.3): whether you can sprint, how slow you are, whether health regenerates, and the labels in the table's
 * order (Hungry or Starving, Thirsty or Parched, Wounded, the temperature band, Drowning, Smothering, Sick, Wet). Of each
 * pair only the worse label shows (Starving replaces Hungry, Parched replaces Thirsty). Drowning and Smothering need `inp`.
 * @param {Vitals} v
 * @param {{ headInWater?: boolean, buried?: boolean }} [inp]
 * @returns {VitalsStatus}
 */
export function statusOf(v, inp) {
  /** @type {string[]} */
  const labels = [];
  let canSprint = true;
  let move = 1;
  if (v.satiation < RATES.STARVING) {
    labels.push('Starving');
    canSprint = false;
    move *= RATES.SLOW_STARVING;
  } else if (v.satiation < RATES.HUNGRY) {
    labels.push('Hungry');
  }
  if (v.hydration < RATES.PARCHED) {
    labels.push('Parched');
    canSprint = false;
    move *= RATES.SLOW_PARCHED;
  } else if (v.hydration < RATES.THIRSTY) {
    labels.push('Thirsty');
  }
  if (v.health < RATES.WOUNDED) {
    labels.push('Wounded');
    move *= RATES.SLOW_WOUNDED;
  }
  const band = tempBand(v.temp);
  if (band) labels.push(band);
  switch (band) {
    case 'Heatstroke': canSprint = false; move *= RATES.SLOW_HEATSTROKE; break;
    case 'Overheating': canSprint = false; move *= RATES.SLOW_OVERHEATING; break;
    case 'Cold': canSprint = false; move *= RATES.SLOW_COLD; break;
    case 'Freezing': canSprint = false; move *= RATES.SLOW_FREEZING; break;
    case 'Hypothermic': canSprint = false; move *= RATES.SLOW_HYPOTHERMIC; break; // see the CONTRACT-ISSUE at the top
    default: break;
  }
  const noBreath = !(v.breath > 0);
  if (noBreath && inp?.headInWater) labels.push('Drowning');
  else if (noBreath && inp?.buried) labels.push('Smothering');
  if (v.sick > 0) labels.push('Poisoned');
  if (v.wet > RATES.WET_LABEL) labels.push('Wet');
  const regen = v.satiation >= RATES.REGEN_MIN_SATIATION && v.hydration >= RATES.REGEN_MIN_HYDRATION
    && v.temp >= RATES.REGEN_TEMP_MIN && v.temp <= RATES.REGEN_TEMP_MAX && !(v.sick > 0) && !noBreath;
  return { canSprint, moveFactor: Math.max(RATES.MOVE_FACTOR_MIN, move), regen, labels };
}

/**
 * Breath (§2.1): drains 1 s per second while `submerged` (head under water or buried), else refills at 5/s.
 * @param {Vitals} v
 * @param {number} dt
 * @param {boolean} submerged
 * @returns {number} seconds of this step spent with no breath left (the drowning / smothering time)
 */
export function stepBreath(v, dt, submerged) {
  if (!submerged) {
    v.breath = Math.min(BREATH_MAX_S, Math.max(0, v.breath) + BREATH_REFILL_PER_S * dt);
    return 0;
  }
  const before = Math.max(0, v.breath);
  v.breath = Math.max(0, before - dt);
  return Math.max(0, dt - before);
}

/**
 * Body temperature (§3.3): temp += (target − temp)·dt/τ with τ 120 s moving away from 37 and 40 s moving back toward
 * it, × 0.3 in water; clamped to 25..45.
 * @param {Vitals} v
 * @param {number} dt
 * @param {number} target  climate.bodyTarget(felt, inWater)
 * @param {boolean} inWater
 */
export function stepBodyTemp(v, dt, target, inWater) {
  const temp = finite(v.temp) ? v.temp : BODY_TEMP_NORMAL;
  const toward = (target - temp) * (BODY_TEMP_NORMAL - temp) > 0;
  const tau = (toward ? RATES.TAU_BACK : RATES.TAU_AWAY) * (inWater ? RATES.WATER_TAU : 1);
  v.temp = clamp(temp + (target - temp) * Math.min(1, dt / tau), BODY_TEMP_MIN, BODY_TEMP_MAX);
}

/**
 * One step of the body (§2.2–§2.4, §3.3), in this order: breath; body temperature toward climate.bodyTarget(felt);
 * satiation and hydration drains; regeneration (and its satiation cost); bandage payout; then damage over time, which
 * is subtracted from health here and reported by cause. Sickness counts down. Mutates `v`.
 * @param {Vitals} v
 * @param {number} dt  seconds
 * @param {VitalsInput} inp
 * @param {() => number} [_random]  unused (every vital change is deterministic); kept for the documented signature
 * @returns {{ damage: Record<string, number>, total: number }}  damage over time by cause key (only causes > 0)
 */
export function stepVitals(v, dt, inp, _random) {
  /** @type {Record<string, number>} */
  const damage = {};
  if (!(dt > 0) || !inp) return { damage, total: 0 };
  const sickBefore = v.sick > 0;

  // Breath: under water or buried it drains, else it refills.
  const breathless = stepBreath(v, dt, !!inp.headInWater || !!inp.buried);

  // Body temperature drifts toward the felt temperature's target.
  stepBodyTemp(v, dt, bodyTarget(inp.felt, !!inp.inWater), !!inp.inWater);

  // Drains.
  const drain = drainRates(inp.activity, inp.felt, sickBefore);
  v.satiation = clamp(v.satiation - drain.satiation * dt, 0, STAT_MAX);
  v.hydration = clamp(v.hydration - drain.hydration * dt, 0, STAT_MAX);
  if (sickBefore) v.sick = Math.max(0, v.sick - dt);

  // Regeneration: doubled while standing still beside a burning campfire; each HP costs satiation.
  v.stillFor = inp.still ? (finite(v.stillFor) ? v.stillFor : 0) + dt : 0;
  if (statusOf(v).regen && !sickBefore && v.health < STAT_MAX) {
    const fire = inp.nearFire && v.stillFor >= RATES.REGEN_STILL_S ? RATES.REGEN_FIRE_MULT : 1;
    const healed = Math.min(RATES.REGEN * fire * dt, STAT_MAX - v.health);
    v.health += healed;
    v.satiation = Math.max(0, v.satiation - healed * RATES.REGEN_COST);
  }

  // Bandages: queued healing is paid out whatever the other conditions.
  if (v.heal > 0) {
    const rate = v.healRate > 0 ? v.healRate : RATES.HEAL_RATE_FALLBACK; // a lost rate never strands the queue
    const pay = Math.min(v.heal, rate * dt);
    v.heal -= pay;
    v.health = Math.min(STAT_MAX, v.health + pay);
    if (!(v.heal > 1e-9)) {
      v.heal = 0;
      v.healRate = 0;
    }
  } else {
    v.heal = 0;
    v.healRate = 0;
  }

  // Damage over time.
  if (v.satiation <= 0) damage.starve = RATES.STARVE_DPS * dt;
  if (v.hydration <= 0) damage.thirst = RATES.THIRST_DPS * dt;
  const band = tempBand(v.temp);
  if (band === 'Heatstroke') damage.heat = RATES.HEATSTROKE_DPS * dt;
  else if (band === 'Overheating') damage.heat = RATES.OVERHEAT_DPS * dt;
  else if (band === 'Hypothermic') damage.cold = RATES.HYPOTHERMIA_DPS * dt;
  else if (band === 'Freezing') damage.cold = RATES.FREEZING_DPS * dt;
  if (breathless > 0) {
    if (inp.headInWater) damage.drown = RATES.DROWN_DPS * breathless;
    else damage.buried = RATES.BURIED_DPS * breathless;
  }
  let total = 0;
  for (const k in damage) total += damage[k];
  // Sickness never takes health below SICK_FLOOR on its own: it comes last, against what the rest left.
  if (sickBefore) {
    const sick = Math.min(RATES.SICK_DPS * dt, Math.max(0, v.health - total - RATES.SICK_FLOOR));
    if (sick > 0) {
      damage.sick = sick;
      total += sick;
    }
  }
  v.health = Math.max(0, v.health - total);
  return { damage, total };
}

/**
 * The softest landing factor (§2.4) over the ids of the cells under the feet (physics.supportingCells); 1 when none.
 * @param {Iterable<number>} ids
 * @returns {number} 0.4..1
 */
export function softLandingFactor(ids) {
  let f = 1;
  if (!ids) return f;
  for (const id of ids) {
    const s = SOFT_LANDING[id];
    if (s !== undefined && s < f) f = s;
  }
  return f;
}

/**
 * Fall damage (§2.4): FALL_DAMAGE_K · (v² − FALL_SAFE_SPEED²) × the soft-landing factor when v > FALL_SAFE_SPEED, else 0.
 * @param {number} speed   impact speed, m/s (PlayerState.landSpeed)
 * @param {number} [factor=1]  softLandingFactor, 0..1
 * @returns {number} HP
 */
export function fallDamage(speed, factor = 1) {
  if (!finite(speed) || !(speed > FALL_SAFE_SPEED)) return 0;
  const f = finite(factor) ? clamp(factor, 0, 1) : 1;
  return FALL_DAMAGE_K * (speed * speed - FALL_SAFE_SPEED * FALL_SAFE_SPEED) * f;
}

/**
 * Blast or toppled-log damage (§2.4): 6 · max(0, |Δv| − 5).
 * @param {number} dv  impulse speed, m/s
 * @returns {number} HP
 */
export function knockDamage(dv) {
  return finite(dv) ? RATES.KNOCK_K * Math.max(0, dv - RATES.KNOCK_SAFE) : 0;
}

/**
 * Crush damage (§2.4): CRUSH_DAMAGE_PER_CELL per cell unstickPlayer lifted the player.
 * @param {number} cells
 * @returns {number} HP
 */
export function crushDamage(cells) {
  return finite(cells) ? CRUSH_DAMAGE_PER_CELL * Math.max(0, cells) : 0;
}

/**
 * Fall sick (§4.5): SICK_S more seconds of sickness, capped at SICK_MAX.
 * @param {Vitals} v
 */
export function makeSick(v) {
  v.sick = Math.min(RATES.SICK_MAX, Math.max(0, finite(v.sick) ? v.sick : 0) + RATES.SICK_S);
  // v0.11 (§66): poisoning hits at once too
  v.hydration = clamp((finite(v.hydration) ? v.hydration : 0) + RATES.POISON_THIRST, 0, STAT_MAX);
  v.satiation = clamp((finite(v.satiation) ? v.satiation : 0) + RATES.POISON_HUNGER, 0, STAT_MAX);
}

/**
 * Eat or drink one food item (§4.5): satiation, hydration (never below 0, never above 100) and the instant body
 * temperature change (snow); then the cure (v0.14, §76 flora: a food that `cures` ends a poisoning at once); then the
 * sickness roll (`random() < food.sick`).
 * @param {Vitals} v
 * @param {import('./types.js').FoodDef} food
 * @param {() => number} random
 * @returns {{ sick: boolean, cured: boolean }}  `cured`: the food ended a poisoning that was there
 */
export function eatFood(v, food, random) {
  v.satiation = clamp(v.satiation + (food.satiation || 0), 0, STAT_MAX);
  v.hydration = clamp(v.hydration + (food.hydration || 0), 0, STAT_MAX);
  if (food.temp) v.temp = clamp(v.temp + food.temp, BODY_TEMP_MIN, BODY_TEMP_MAX);
  const cured = !!food.cures && cureSick(v);
  const sick = food.sick > 0 && random() < food.sick;
  if (sick) makeSick(v);
  return { sick, cured };
}

/**
 * End a poisoning at once (v0.14, §76 flora: Healwort and its tea). What the poison already took is not given back.
 * @param {Vitals} v
 * @returns {boolean} whether there was a poisoning to end
 */
export function cureSick(v) {
  const was = v.sick > 0;
  v.sick = 0;
  return was;
}

/**
 * One hand gulp of water (§4.2): fresh +8 hydration with a GULP_FRESH_SICK (6 %) chance of poisoning; salt −4 hydration.
 * v0.14 (§76 water): tainted water gives the same +8 with a GULP_TAINTED_SICK (40 %) chance. One `random()` per fresh or
 * tainted gulp, none for salt.
 * @param {Vitals} v
 * @param {boolean|'fresh'|'salt'|'tainted'} quality  what the water is; a boolean is the old `salty` flag (true = salt)
 * @param {() => number} random
 * @returns {{ sick: boolean }}
 */
export function gulpWater(v, quality, random) {
  if (typeof quality === 'string' ? quality === 'salt' : quality) {
    v.hydration = clamp(v.hydration + RATES.GULP_SALT, 0, STAT_MAX);
    return { sick: false };
  }
  v.hydration = clamp(v.hydration + RATES.GULP_FRESH, 0, STAT_MAX);
  const sick = random() < (quality === 'tainted' ? RATES.GULP_TAINTED_SICK : RATES.GULP_FRESH_SICK);
  if (sick) makeSick(v);
  return { sick };
}

/**
 * Queue bandage healing (§2.3): `hp` more pending (the total capped at HEAL_MAX), paid out at `rate` HP/s — a faster
 * bandage speeds up what is already pending, a slower one never slows it.
 * @param {Vitals} v
 * @param {number} hp
 * @param {number} rate  HP/s
 * @returns {boolean} false when nothing could be queued (the queue is full, or hp / rate is not positive)
 */
export function queueHeal(v, hp, rate) {
  if (!(hp > 0) || !(rate > 0) || !finite(hp) || !finite(rate)) return false;
  const pending = finite(v.heal) && v.heal > 0 ? v.heal : 0;
  if (pending >= HEAL_MAX) return false;
  v.heal = Math.min(HEAL_MAX, pending + hp);
  v.healRate = pending > 0 && v.healRate > rate ? v.healRate : rate;
  return true;
}
