// Caelancraft — the survival core: the world's mode, the body's state (vitals.js) stepped through the climate
// (climate.js), damage, eating, drinking, bandages, death and waking, and the save part of it. Pure: no DOM, no clocks,
// no Math.random (callers pass `random`). See docs/DESIGN-survival.md §1.2, §2, §3, §9.4 (CONTRACTS §45 once merged).
//
// "In Survival" (SV) is `inSurvival`: the mode is 'survival', dead or alive. "Survival active" (S) is `active`: in
// Survival and not dead. Only an active Survival steps, takes damage, eats or drinks; everything is frozen otherwise and
// never catches up (CONTRACTS pitfall 28). The pack, worn items and fire spots live in their own modules (inventory.js,
// cooking.js); main adds their exports to this one's (§9.5 buildSaveData).
//
// Death is deferred (§2.5): `damage` and `step` only set `dead` and report the cause; main turns it into its
// `pendingDeath` and runs `die()` at the frame's checkpoints. `deaths` is counted by main's `die()`.
import { STAT_MAX, BREATH_MAX_S, BODY_TEMP_NORMAL, BODY_TEMP_MIN, BODY_TEMP_MAX, SICK_MAX_S, HEAL_MAX } from './config.js';
import { getItem } from './items.js';
import {
  createVitals, wakeVitals, statusOf, stepVitals, activityFactor, fallDamage, eatFood, gulpWater, queueHeal,
  DAMAGE_CAUSES, RATES,
} from './vitals.js';
import { feltTemperature, activityHeat, wetRate } from './climate.js';

/** @typedef {import('./vitals.js').Vitals} Vitals */
/** @typedef {import('./vitals.js').VitalsStatus} VitalsStatus */
/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {'creative'|'survival'} GameMode */

/**
 * What one survival step sees (§9.4). `player` is the PlayerState after physics and bodies this frame (its `landSpeed`
 * is consumed). Booleans default to false; `moving` defaults to a horizontal speed above 0.5 m/s, `still` to !moving.
 * @typedef {Object} SurvivalEnv
 * @property {PlayerState} player
 * @property {number} [softFactor]  softLandingFactor of the cells under the feet (physics.supportingCells), default 1
 * @property {boolean} [breaking]   dig progress advanced this frame
 * @property {boolean} [moving]     horizontal speed > 0.5 m/s
 * @property {boolean} [still]      stood still this frame (regeneration beside a fire)
 * @property {boolean} [buried]     the eye is inside a solid cell with no room within 3 above (unstickPlayer)
 * @property {{ biome: number, climateT: number, openSky: boolean, underground: boolean, groundChill: number|boolean }} climate
 * @property {number} [heat]        heat of the sources at the chest (climate.heatAt), °C
 * @property {boolean} [nearFire]   a burning campfire within 4 cells
 * @property {number} [insulation]  Pack.insulation()
 * @property {number} [sunShade]    Pack.sunShade()
 * @property {number} [rain]        the rain reaching the player, 0..1 (CONTRACTS §84: its strength × the cover overhead)
 * @property {number} time          day fraction
 * @property {() => number} [random]
 */

/**
 * What one step did. `damage` is all of it (the fall and damage over time); `fall` the instant fall damage alone (main
 * flashes and plays a hurt for it); `pulse` is true each time another DOT_PULSE_HP of damage over time has been lost
 * (main pulses the flash at 0.4 with a soft hurt sound). `felt` and `air` are the step's temperatures (°C).
 * @typedef {Object} SurvivalEvents
 * @property {number} damage
 * @property {string[]} causes   cause keys that dealt damage this step, in the order they were dealt
 * @property {string|null} died  the cause when this step killed (main: pendingDeath ??= died)
 * @property {number} felt
 * @property {number} air
 * @property {number} fall
 * @property {boolean} pulse
 */

/** The two modes; anything else is refused. */
export const MODES = Object.freeze(['creative', 'survival']);
/** Chat lines (§4.2, §4.5). */
export const SICK_MESSAGE = 'Your stomach turns: you are poisoned.';
/** v0.11 (§66): the first time raw water poisons you this session, how to make it safe. */
export const BOIL_TIP = 'Tip — raw water can poison you. Fill a clay pot and set it on a campfire: boiled water is always safe.';
export const SALT_MESSAGE = 'Salt water only makes you thirstier.';
/** v0.14 (§76 flora): Healwort or its tea ended a poisoning. */
export const CURED_MESSAGE = 'The bitter herb settles your stomach: you are no longer poisoned.';
/** A salty hand gulp says SALT_MESSAGE at most once per this many seconds of Survival (§4.2). */
export const SALT_MESSAGE_GAP_S = 5;
/** Damage over time pulses the hurt flash once per this many HP lost (§2.4). */
export const DOT_PULSE_HP = 3;

/** The death screen's title by cause (§2.5). */
export const DEATH_TITLES = Object.freeze({
  fall: 'The ground came up too fast.',
  drown: 'The water closed over you.',
  buried: 'Buried alive.',
  crush: 'Crushed under falling ground.',
  fire: 'The fire took you.',
  zombie: 'A zombie brought you down.',
  blast: 'Caught in a blast.',
  log: 'Crushed by a falling tree.',
  blackhole: 'Swallowed by a black hole.',
  starve: 'Your strength gave out.',
  thirst: 'You died of thirst.',
  cold: 'The cold took you.',
  heat: 'The heat took you.',
  void: 'You slipped beneath the bedrock.',
  command: 'You collapsed.',
  bear: 'A bear brought you down.', // v0.14 (§76 fauna)
});
/** The death screen's detail line (§2.5). */
export const BELONGINGS_KEPT = 'Your belongings lie where you fell.';
export const BELONGINGS_LOST = 'Your belongings are lost.';

/** @param {string} cause @returns {string} the death screen title; "You collapsed." for a cause without one */
export function deathTitle(cause) {
  return Object.hasOwn(DEATH_TITLES, cause) ? DEATH_TITLES[cause] : DEATH_TITLES.command;
}

/** Each vital the console may set (§9.7 `vitals`): name → [Vitals key, min, max]. 'nourishment' is the shown name. */
const VITAL_RANGES = Object.freeze({
  health: ['health', 0, STAT_MAX],
  nourishment: ['satiation', 0, STAT_MAX],
  satiation: ['satiation', 0, STAT_MAX],
  hydration: ['hydration', 0, STAT_MAX],
  temp: ['temp', BODY_TEMP_MIN, BODY_TEMP_MAX],
  breath: ['breath', 0, BREATH_MAX_S],
});

/** Saved number fields of SurvivalJSON (§9.6) with their ranges. @type {ReadonlyArray<[string, number, number]>} */
const SAVED_STATS = Object.freeze([
  ['health', 0, STAT_MAX], ['satiation', 0, STAT_MAX], ['hydration', 0, STAT_MAX], ['temp', BODY_TEMP_MIN, BODY_TEMP_MAX],
  ['breath', 0, BREATH_MAX_S], ['wet', 0, 1], ['sick', 0, SICK_MAX_S], ['heal', 0, HEAL_MAX], ['healRate', 0, 5],
]);

/** @param {*} v @returns {boolean} */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
/** @param {number} v @returns {number} rounded to 3 decimal places (−0 → 0) */
function r3(v) {
  return Math.round(v * 1000) / 1000 + 0;
}
/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** A random source that never rolls under any chance (no sickness) when the caller passes none. */
const NEVER = () => 1;

export class Survival {
  constructor() {
    /** @type {GameMode} */
    this.mode = 'creative';
    /** false until Survival is first entered (begin) or a save with a survival state is imported */
    this.hasState = false;
    /** bumped by every setMode that changes the mode (main autosaves on it) */
    this.switchVersion = 0;
    /** @type {Vitals} */
    this.vitals = createVitals();
    /** @type {[number, number, number]|null} the Sleeping Hide cell to wake at */
    this.spawn = null;
    this.deaths = 0;
    /** @type {string|null} the cause of death while the death screen is up */
    this.dead = null;
    /** the next landing does no damage (set on entering Survival, loading and every teleport; any landing clears it) */
    this.fallGrace = false;
    /** the last step's temperatures, °C */
    this.felt = BODY_TEMP_NORMAL;
    this.air = BODY_TEMP_NORMAL;
    /** seconds of active Survival stepped (the salt-message throttle's clock) */
    this.clock = 0;
    this._saltAt = -Infinity;
    this._dot = 0;
    /** the last step's breath circumstances, for the Drowning / Smothering labels */
    this._flags = { headInWater: false, buried: false };
  }

  /** In Survival (SV): the mode is 'survival', dead or alive. */
  get inSurvival() {
    return this.mode === 'survival';
  }

  /** Survival active (S): in Survival and not dead. */
  get active() {
    return this.mode === 'survival' && !this.dead;
  }

  /** @returns {VitalsStatus} statusOf(vitals) with the last step's breath circumstances */
  get status() {
    return statusOf(this.vitals, this._flags);
  }

  /**
   * Switch the mode (§1.2). Entering Survival without a survival state begins one; entering it with one brings it back as
   * it was left, and sets fallGrace either way. Refused (false) while dead, for an unknown mode, or when nothing changes.
   * Only main's applyModeSwitch calls it.
   * @param {string} mode
   * @returns {boolean} the mode changed (switchVersion was bumped)
   */
  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode || this.dead) return false;
    if (mode === 'survival') {
      if (!this.hasState) this.begin();
      this.fallGrace = true;
    }
    this.mode = /** @type {GameMode} */ (mode);
    this.switchVersion++;
    return true;
  }

  /** A fresh survival state (§1.2, §2.1): new vitals, no Sleeping Hide, no deaths, alive, with fallGrace. */
  begin() {
    this.vitals = createVitals();
    this.spawn = null;
    this.deaths = 0;
    this.dead = null;
    this.hasState = true;
    this.fallGrace = true;
    this._resetTransient();
  }

  /** @private */
  _resetTransient() {
    this.felt = BODY_TEMP_NORMAL;
    this.air = BODY_TEMP_NORMAL;
    this._saltAt = -Infinity;
    this._dot = 0;
    this._flags.headInWater = false;
    this._flags.buried = false;
  }

  /**
   * One frame of the body (§9.4), in order: the fall (landSpeed consumed; no damage under fallGrace, which any landing
   * clears), breath, wet, felt then body temperature, drains, regeneration and bandages, damage over time, death. A no-op
   * unless active.
   * @param {number} dt
   * @param {SurvivalEnv} env
   * @returns {SurvivalEvents}
   */
  step(dt, env) {
    /** @type {SurvivalEvents} */
    const ev = { damage: 0, causes: [], died: null, felt: this.felt, air: this.air, fall: 0, pulse: false };
    if (!this.active || !(dt > 0) || !env) return ev;
    this.clock += dt;
    const v = this.vitals;
    const p = env.player ?? null;
    if (!(v.health > 0)) {
      // Zeroed from outside (the console's `vitals health 0`): main's pendingDeath already says 'command'.
      this.dead = 'command';
      ev.died = 'command';
      return ev;
    }

    // 1. The fall: consume landSpeed (a stale value is never applied twice).
    const land = p && finite(p.landSpeed) ? p.landSpeed : 0;
    if (p) p.landSpeed = 0;
    if (land > 0) {
      if (this.fallGrace) {
        this.fallGrace = false;
      } else {
        const dmg = fallDamage(land, env.softFactor ?? 1);
        if (dmg > 0) {
          ev.fall = dmg;
          ev.damage += dmg;
          ev.causes.push('fall');
          if (this.damage(dmg, 'fall')) {
            ev.died = 'fall';
            return ev;
          }
        }
      }
    }

    // 2–4. Circumstances, wet, felt temperature.
    const inWater = !!p?.inWater;
    const headInWater = !!p?.headInWater;
    const buried = !!env.buried;
    this._flags.headInWater = headInWater;
    this._flags.buried = buried;
    const moving = env.moving ?? (p ? Math.hypot(p.vx, p.vz) > RATES.WALK_MIN_SPEED : false);
    const sprinting = !!p?.sprinting && moving;
    const breaking = !!env.breaking;
    const c = env.climate ?? /** @type {SurvivalEnv['climate']} */ ({});
    const heat = finite(env.heat) ? env.heat : 0;
    // Wet (§3.2, §84): swimming soaks at once; rain that reaches you wets you; otherwise you dry.
    if (inWater) v.wet = 1;
    else v.wet = clamp((finite(v.wet) ? v.wet : 0) + wetRate(finite(env.rain) ? env.rain : 0, heat, !!c.openSky, env.time) * dt, 0, 1);
    const t = feltTemperature({
      biome: c.biome,
      climateT: c.climateT,
      feetY: p ? p.y : undefined,
      time: env.time,
      openSky: !!c.openSky,
      underground: !!c.underground,
      inWater,
      wet: v.wet,
      heat,
      groundChill: c.groundChill,
      insulation: env.insulation,
      sunShade: env.sunShade,
      activityHeat: activityHeat({ moving, breaking, swimming: inWater, sprinting }),
    });
    this.felt = t.felt;
    this.air = t.air;
    ev.felt = t.felt;
    ev.air = t.air;

    // 2, 4–6. Breath, body temperature, drains, regeneration, bandages and damage over time.
    const res = stepVitals(v, dt, {
      activity: activityFactor({ moving, breaking, swimming: inWater, sprinting }),
      felt: t.felt,
      inWater,
      headInWater,
      buried,
      nearFire: !!env.nearFire,
      still: env.still ?? !moving,
    }, env.random);
    let worst = null;
    for (const cause of Object.keys(res.damage)) {
      ev.causes.push(cause);
      if (worst === null || res.damage[cause] > res.damage[worst]) worst = cause;
    }
    ev.damage += res.total;
    this._dot += res.total;
    if (this._dot >= DOT_PULSE_HP) {
      ev.pulse = true;
      this._dot %= DOT_PULSE_HP;
    }

    // 7. Death: the cause that dealt the most this step.
    if (v.health <= 0) {
      this.dead = worst ?? 'command'; // (worst is always set here: only damage over time took the health)
      ev.died = this.dead;
    }
    return ev;
  }

  /**
   * Instant damage (§2.4) while active: health falls by `amount` (not below 0). At 0 the player is dead: `dead = cause`
   * (main's pendingDeath and die() take it from there).
   * @param {number} amount  HP
   * @param {string} cause   a DAMAGE_CAUSES key
   * @returns {boolean} this damage killed
   */
  damage(amount, cause) {
    if (!this.active || !finite(amount) || !(amount > 0)) return false;
    const v = this.vitals;
    v.health = Math.max(0, v.health - amount);
    if (v.health > 0) return false;
    this.dead = cause;
    return true;
  }

  /**
   * Eat or drink one food item (§4.5) while active. `returns` is the item main gives back (the clay pot).
   * @param {string} key
   * @param {() => number} [random]
   * @returns {{ ok: boolean, message?: string, returns?: string }}
   */
  eat(key, random) {
    const item = getItem(key);
    if (!item || !item.food) return { ok: false, message: item ? `${item.name} cannot be eaten` : 'not food' };
    if (!this.active) return { ok: false };
    const food = item.food;
    const { sick, cured } = eatFood(this.vitals, food, typeof random === 'function' ? random : NEVER);
    /** @type {{ ok: boolean, message?: string, returns?: string }} */
    const out = { ok: true };
    if (sick) out.message = SICK_MESSAGE;
    else if (cured) out.message = CURED_MESSAGE;
    else if (food.hydration < 0 && key === 'pot_seawater') out.message = SALT_MESSAGE;
    if (food.returns) out.returns = food.returns;
    return out;
  }

  /**
   * One hand gulp of water (§4.2) while active: fresh +8 hydration with a GULP_FRESH_SICK chance of poisoning (SICK_MESSAGE),
   * salt −4 with "Salt water only makes you thirstier." at most once per SALT_MESSAGE_GAP_S of Survival time. v0.14 (§76
   * water): tainted water is fresh water's +8 with the GULP_TAINTED_SICK chance.
   * @param {boolean|'fresh'|'salt'|'tainted'} quality  what the water is; a boolean is the old `salty` flag (true = salt)
   * @param {() => number} [random]
   * @returns {string} the chat line, or '' for none
   */
  drink(quality, random) {
    if (!this.active) return '';
    const salty = typeof quality === 'string' ? quality === 'salt' : !!quality;
    const { sick } = gulpWater(this.vitals, salty ? 'salt' : quality === 'tainted' ? 'tainted' : 'fresh', typeof random === 'function' ? random : NEVER);
    if (sick) return SICK_MESSAGE;
    if (!salty || this.clock - this._saltAt < SALT_MESSAGE_GAP_S) return '';
    this._saltAt = this.clock;
    return SALT_MESSAGE;
  }

  /**
   * Apply a bandage (§2.3) while active: its HP is queued into the pending healing (total ≤ HEAL_MAX).
   * @param {string} key
   * @returns {boolean} false for a non-bandage, while not active, or when the queue is full
   */
  bandage(key) {
    const heal = getItem(key)?.heal;
    if (!heal || !this.active) return false;
    return queueHeal(this.vitals, heal.hp, heal.rate);
  }

  /** Wake up (§2.1, §2.5): the waking values, alive, with fallGrace. Main picks the place and counts nothing here. */
  respawn() {
    wakeVitals(this.vitals);
    this.dead = null;
    this.fallGrace = true;
    this._resetTransient();
  }

  /**
   * Set one vital (console `vitals <name> <value>`, §9.7), clamped to its range. Names: health, nourishment (or
   * satiation), hydration, temp, breath. Health 0 does not kill here: main's CommandContext sets pendingDeath ('command').
   * @param {string} name
   * @param {number} value
   * @returns {boolean} false for an unknown name, a non-finite value or no survival state
   */
  setVital(name, value) {
    if (!this.hasState || !Object.hasOwn(VITAL_RANGES, name) || !finite(value)) return false;
    const [key, lo, hi] = VITAL_RANGES[name];
    this.vitals[key] = clamp(value, lo, hi);
    return true;
  }

  /** Console `vitals full`: every stat full, body 37, dry, well, nothing pending. @returns {boolean} false without state */
  restoreVitals() {
    if (!this.hasState) return false;
    const v = this.vitals;
    v.health = STAT_MAX;
    v.satiation = STAT_MAX;
    v.hydration = STAT_MAX;
    v.temp = BODY_TEMP_NORMAL;
    v.breath = BREATH_MAX_S;
    v.wet = 0;
    v.sick = 0;
    v.heal = 0;
    v.healRate = 0;
    return true;
  }

  /**
   * The vitals part of SurvivalJSON (§9.6), canonical key order, numbers rounded to 3 decimal places; main adds the pack,
   * the worn items and the fire spots. `dead` is present only while dead.
   * @returns {{ health: number, satiation: number, hydration: number, temp: number, breath: number, wet: number,
   *   sick: number, heal: number, healRate: number, spawn: [number, number, number]|null, deaths: number, dead?: string }}
   */
  export() {
    const v = this.vitals;
    /** @type {*} */
    const out = {};
    for (const [key, lo, hi] of SAVED_STATS) out[key] = r3(clamp(finite(v[key]) ? v[key] : lo, lo, hi));
    out.spawn = this.spawn ? [this.spawn[0], this.spawn[1], this.spawn[2]] : null;
    out.deaths = this.deaths;
    if (this.dead) out.dead = this.dead;
    return out;
  }

  /**
   * Load a (validated) SurvivalJSON (§9.6); null or a non-object means the world never had a survival state
   * (hasState false). Defensive anyway: a bad number becomes its fresh value (§2.1), a bad spawn null, bad deaths 0, an
   * unknown `dead` cause alive. The mode is not touched (main sets it from the save). A loaded state starts with fallGrace.
   * @param {*} json
   */
  import(json) {
    this.vitals = createVitals();
    this.spawn = null;
    this.deaths = 0;
    this.dead = null;
    this.fallGrace = false;
    this._resetTransient();
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      this.hasState = false;
      return;
    }
    this.hasState = true;
    const v = this.vitals;
    for (const [key, lo, hi] of SAVED_STATS) {
      const x = json[key];
      if (finite(x) && x >= lo && x <= hi) v[key] = x;
    }
    if (!(v.heal > 0)) v.healRate = 0;
    const s = json.spawn;
    if (Array.isArray(s) && s.length === 3 && s.every((n) => Number.isInteger(n))) this.spawn = [s[0], s[1], s[2]];
    if (Number.isInteger(json.deaths) && json.deaths >= 0) this.deaths = json.deaths;
    if (typeof json.dead === 'string' && DAMAGE_CAUSES.includes(json.dead)) this.dead = json.dead;
    this.fallGrace = true;
  }
}
