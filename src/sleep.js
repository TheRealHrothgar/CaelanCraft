// Caelancraft — sleep (CONTRACTS §87): where you may sleep and what each place gives, when you may lie down, how a sleep
// runs (the fade, game time at SLEEP_RATE in one-second ticks, every reason to wake), whether the place is secure (a
// flood fill of the open cells round the bed), the night attack (its chance by the light at the sleeper, and where the
// zombies come up: only where the zombies module itself lets one come up), and what a body that has been awake too long
// sees and hears (yawns, blurred sight, sounds with nothing there, a figure at the edge of sight, nods).
//
// PURE: no DOM, no three, no clocks, no Math.random. main.js owns the live objects and hands this module what it needs:
// the world's blocks, the zombies and their world view, a `random`, a `now`. Tiredness itself — `Vitals.fatigue`, its
// stages and what they do to the body — is vitals.js's; the HUD (hud.js), the figure (phantomRenderer.js) and the sounds
// (soundBank.js) only show what this module decides.
//
// Imports: blocks, hex, vitals (leaf-ward; none of them imports this).
import { BLOCK, isSolid } from './blocks.js';
import { HEX_DIRS, hexLength, hexToWorld, worldToHex } from './hex.js';
import { RATES, GAME_HOUR_S, FATIGUE_STAGES, TIRED_AT, EXHAUSTED_AT, WEAK_AT, DELIRIOUS_AT, fatigueStage } from './vitals.js';

/** @typedef {import('./vitals.js').Vitals} Vitals */
/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sleep spots
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What sleeping on a block gives, per game hour of sleep: `recover` hours of tiredness taken off, `heal` HP.
 * @typedef {{ key: string, id: number, name: string, recover: number, heal: number }} SleepSpot
 */

/**
 * Every sleep spot there could be, weakest first: [BLOCK key, what it gives]. A spot is looked up by its block KEY, so a
 * row whose block is not registered in this build simply is not there (the Grass Bed and the Bed are another package's
 * blocks). There is no sleeping on bare ground.
 */
export const SPOT_ROWS = Object.freeze([
  ['GRASS_BED',     { name: 'Grass Bed',     recover: 3, heal: 2 }],
  ['SLEEPING_HIDE', { name: 'Sleeping Hide', recover: 4, heal: 4 }],   // the bedroll
  ['BED',           { name: 'Bed',           recover: 5, heal: 6 }],
].map(([key, gives]) => Object.freeze([key, Object.freeze(gives)])));

/**
 * The sleep spots of a block table: the rows of SPOT_ROWS whose key it has.
 * @param {Record<string, number>} [blocks=BLOCK]
 * @returns {ReadonlyArray<SleepSpot>}
 */
export function sleepSpots(blocks = BLOCK) {
  return Object.freeze(SPOT_ROWS
    .filter(([key]) => blocks[/** @type {string} */ (key)] !== undefined)
    .map(([key, gives]) => Object.freeze({ key: /** @type {string} */ (key), id: blocks[/** @type {string} */ (key)], .../** @type {{name: string, recover: number, heal: number}} */ (gives) })));
}

/** The sleep spots of this build (today: the Sleeping Hide). */
export const SPOTS = sleepSpots();

/**
 * @param {number} id a block id @param {ReadonlyArray<SleepSpot>} [spots=SPOTS]
 * @returns {SleepSpot|null} the sleep spot that block is, or null
 */
export function spotOf(id, spots = SPOTS) {
  for (const s of spots) if (s.id === id) return s;
  return null;
}

/** @param {number} id @returns {boolean} the block is a place to sleep */
export function isSleepSpot(id) {
  return spotOf(id) !== null;
}

/** @param {SleepSpot|{name: string}} spot @returns {string} the target hint of a sleep spot: `Sleeping Hide · R: sleep` */
export function spotHint(spot) {
  return `${spot.name} · R: sleep`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Lying down, sleeping, waking
// ---------------------------------------------------------------------------------------------------------------------

/** You can lie down from this much tiredness (game hours awake); below it R only sets the waking place. */
export const SLEEP_MIN_FATIGUE = 6;
/** Asleep, game time runs at this many game seconds per real second (8 game hours in 16 s). */
export const SLEEP_RATE = 30;
/** Lying down, the view goes dark over this long (real s); the sleep begins when it is dark. */
export const SLEEP_FADE_S = 1.5;
/** Waking, the view comes back over this long (real s). */
export const WAKE_FADE_S = 0.8;
/** A sleep ends by itself after this many game hours … */
export const SLEEP_MAX_H = 10;
/** … or, once tiredness is 0, after this many (the best night: healing goes on to here) or as soon as the sun is up. */
export const SLEEP_FULL_H = 8;
/** At most this many one-second ticks in a frame, and never more than this many owed (a slow machine sleeps slower). */
export const SLEEP_TICKS_PER_FRAME = 4;
/** A frame's ticks stop once they have taken this long (ms, by the injected `now`). */
export const SLEEP_FRAME_BUDGET_MS = 4;
/** No lying down while a zombie within this many cells is chasing you. */
export const SLEEP_ZOMBIE_NEAR = 12;

/** What the player is told (the log, the target hint, the dark screen). */
export const SLEEP_LINES = Object.freeze({
  notTired: 'You are not tired.',
  riding: 'Get off your horse to sleep.',
  water: 'You cannot sleep in water.',
  zombie: 'You cannot sleep now: a zombie is after you.',
  poison: 'You cannot sleep while the poison is hurting you.',
  hungry: 'You are too hungry to sleep. Eat first.',
  thirsty: 'You are too thirsty to sleep. Drink first.',
  attack: 'Something is near.',
  wakeKey: 'press any key to wake',
  secure: 'secure here',
  gone: 'Your sleeping place is gone.',
});

/** The log line when a stage of tiredness is entered, by stage (vitals.FATIGUE_STAGES); index 0: sleep cleared it. */
export const STAGE_LINES = Object.freeze([
  'You are no longer tired.',
  'You are tired. Find a place to sleep.',
  'You are exhausted: your sight blurs and your wounds stop healing. Sleep soon.',
  'You are weak from lack of sleep: slower on your feet, slower at digging, and your strikes are softer.',
  'You have been awake far too long. You are seeing things. Sleep.',
]);

/**
 * The log line for a change of stage while awake: the line of a stage that was entered (the worse one when two were
 * crossed at once), `STAGE_LINES[0]` when tiredness fell back under Tired, null when nothing is to be said (no change,
 * a milder stage that is still a stage, or no stage known before: a load).
 * @param {number|null} prev @param {number} next @returns {string|null}
 */
export function stageNews(prev, next) {
  if (prev === null || prev === undefined || next === prev) return null;
  if (next > prev) return STAGE_LINES[next] ?? null;
  return next === 0 ? STAGE_LINES[0] : null;
}

/**
 * Why the player may not lie down now, or null when they may. In this order: not tired enough; riding; in water; a
 * zombie within SLEEP_ZOMBIE_NEAR cells that is chasing them; Poisoned and the poison still taking health (it stops at
 * RATES.SICK_FLOOR); Nourishment or Hydration under the level that would wake a sleeper at once (RATES.STARVING /
 * RATES.PARCHED).
 * @param {{ vitals: Vitals, inWater?: boolean, riding?: boolean, x?: number, y?: number, z?: number,
 *   zombies?: Iterable<{ x: number, y: number, z: number, mode?: string }> }} c
 * @returns {string|null}
 */
export function sleepRefusal(c) {
  const v = c.vitals;
  if (!(v.fatigue >= SLEEP_MIN_FATIGUE)) return SLEEP_LINES.notTired;
  if (c.riding) return SLEEP_LINES.riding;
  if (c.inWater) return SLEEP_LINES.water;
  if (c.zombies) {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    const z = c.z ?? 0;
    for (const zb of c.zombies) {
      if (zb.mode === 'chase' && Math.hypot(zb.x - x, zb.y - y, zb.z - z) <= SLEEP_ZOMBIE_NEAR) return SLEEP_LINES.zombie;
    }
  }
  if (v.sick > 0 && v.health > RATES.SICK_FLOOR) return SLEEP_LINES.poison;
  if (v.satiation < RATES.STARVING) return SLEEP_LINES.hungry;
  if (v.hydration < RATES.PARCHED) return SLEEP_LINES.thirsty;
  return null;
}

/**
 * Why a sleep ended: `asked` (a key or a click), `hurt` (health fell), `hunger` / `thirst` (under 10), `attack` (the
 * night came), `max` (SLEEP_MAX_H), `rested` (tiredness 0 and 8 hours slept, or the sun up), `died`, `stopped` (the
 * game ended the sleep: a mode switch, leaving the world).
 * @typedef {'asked'|'hurt'|'hunger'|'thirst'|'attack'|'max'|'rested'|'died'|'stopped'} WakeReason
 */

/**
 * What one game second of sleep did to the sleeper, as main reports it to `Sleep.step`.
 * @typedef {Object} SleepSecond
 * @property {boolean} [hurt]      health fell this second (any damage)
 * @property {boolean} [died]
 * @property {number} satiation
 * @property {number} hydration
 * @property {number} fatigue
 * @property {boolean} isDay       the sun is up (daynight.isDayTime) after this second
 */

/**
 * @typedef {Object} SleepHooks
 * @property {() => SleepSecond} second   advance the world by one game second (the clock, the body, the once-a-second
 *   systems) and say how the sleeper is
 * @property {() => boolean} [hour]       a whole game hour of sleep has built up: roll the night attack; true when
 *   zombies came
 * @property {() => number} [now]         a millisecond clock, for the frame budget (none: only the tick cap holds)
 */

/**
 * The first reason of this list that holds after a second of sleep, or null: died, hurt, hunger, thirst, max, rested.
 * @param {SleepSecond} s @param {number} hours game hours slept so far
 * @returns {WakeReason|null}
 */
export function wakeReason(s, hours) {
  if (s.died) return 'died';
  if (s.hurt) return 'hurt';
  if (s.satiation < RATES.STARVING) return 'hunger';
  if (s.hydration < RATES.PARCHED) return 'thirst';
  if (hours >= SLEEP_MAX_H) return 'max';
  if (!(s.fatigue > 0) && (hours >= SLEEP_FULL_H || s.isDay)) return 'rested';
  return null;
}

/** @param {number} hours game hours slept @returns {string} `You slept 7 hours.` (whole hours, rounded down) */
export function sleptText(hours) {
  const h = Math.floor((Number.isFinite(hours) ? Math.max(0, hours) : 0) + 1e-6);
  if (h < 1) return 'You hardly slept.';
  return `You slept ${h} hour${h === 1 ? '' : 's'}.`;
}

/** What woke you, where it is worth saying. */
const WOKE_BY = Object.freeze({ hurt: 'Pain woke you.', hunger: 'Hunger woke you.', thirst: 'Thirst woke you.' });

/**
 * The one line shown on waking: how long you slept, what woke you when that was pain, hunger or thirst, and the state
 * you woke in — `You slept 7 hours. You are rested.`, `You slept 3 hours. Hunger woke you. You are still exhausted.`
 * @param {number} hours @param {Vitals|{fatigue: number}} vitals @param {WakeReason|null} [reason]
 */
export function wakeLine(hours, vitals, reason = null) {
  const stage = fatigueStage(vitals);
  const state = stage > 0 ? `You are still ${stage === 4 ? 'seeing things' : FATIGUE_STAGES[stage].toLowerCase()}.`
    : vitals.fatigue > 0 ? 'You feel better.' : 'You are rested.';
  const why = reason && Object.hasOwn(WOKE_BY, reason) ? `${WOKE_BY[/** @type {'hurt'|'hunger'|'thirst'} */ (reason)]} ` : '';
  return `${sleptText(hours)} ${why}${state}`;
}

/** @param {number} hours game hours slept @returns {string} the dark screen's line: `Sleeping · 3 h` */
export function sleepingLine(hours) {
  return `Sleeping · ${Math.floor((Number.isFinite(hours) ? Math.max(0, hours) : 0) + 1e-6)} h`;
}

/**
 * How dark the view is: toward 1 over SLEEP_FADE_S while lying or asleep, back to 0 over WAKE_FADE_S once awake.
 * @param {number} level 0..1 now @param {boolean} down lying down or asleep @param {number} dt real seconds
 * @returns {number} 0..1
 */
export function sleepDark(level, down, dt) {
  const l = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  if (!(dt > 0)) return l;
  return down ? Math.min(1, l + dt / SLEEP_FADE_S) : Math.max(0, l - dt / WAKE_FADE_S);
}

/**
 * One sleep, from lying down to waking. `phase` is 'awake' (nothing runs here), 'falling' (lying down: the view goes
 * dark over SLEEP_FADE_S; the world stands still) or 'asleep' (game time runs at SLEEP_RATE in one-second ticks through
 * `hooks.second`). main skips its own step of the world while `active`.
 */
export class Sleep {
  constructor() {
    this.reset();
  }

  /** Awake, with nothing remembered. */
  reset() {
    /** @type {'awake'|'falling'|'asleep'} */
    this.phase = 'awake';
    /** @type {SleepSpot|null} what is slept on */
    this.spot = null;
    /** @type {[number, number, number]|null} its cell */
    this.cell = null;
    /** whole game seconds slept */
    this.seconds = 0;
    /** real seconds since lying down, while 'falling' */
    this.lain = 0;
    /** game seconds owed (real time × SLEEP_RATE not yet ticked) */
    this.owed = 0;
    /** @type {WakeReason|null} why the last sleep ended */
    this.wokeBy = null;
    /** game hours the last sleep lasted */
    this.lastHours = 0;
    /** game seconds slept since the night attack was last rolled: kept from one sleep to the next (short naps dodge nothing) */
    this.sinceRoll = 0;
  }

  /** Lying down or asleep: the world's own step is off. */
  get active() {
    return this.phase !== 'awake';
  }

  get asleep() {
    return this.phase === 'asleep';
  }

  /** Game hours slept in this sleep. */
  get hours() {
    return this.seconds / GAME_HOUR_S;
  }

  /**
   * Lie down on `spot` at `cell`. Refused (false) while already lying or asleep.
   * @param {SleepSpot} spot @param {[number, number, number]} cell
   */
  lie(spot, cell) {
    if (this.active || !spot) return false;
    this.phase = 'falling';
    this.spot = spot;
    this.cell = [cell[0], cell[1], cell[2]];
    this.seconds = 0;
    this.lain = 0;
    this.owed = 0;
    this.wokeBy = null;
    return true;
  }

  /**
   * End the sleep (or the lying down) now. @param {WakeReason} reason
   * @returns {boolean} false when there was no sleep to end
   */
  wake(reason) {
    if (!this.active) return false;
    this.lastHours = this.hours;
    this.wokeBy = reason;
    this.phase = 'awake';
    this.owed = 0;
    return true;
  }

  /**
   * One frame. Lying down: `dt` counts toward SLEEP_FADE_S, then the sleep begins. Asleep: `dt × SLEEP_RATE` game seconds
   * are owed and ticked one at a time through `hooks.second()` — at most SLEEP_TICKS_PER_FRAME a frame, and none after
   * the frame's ticks have taken SLEEP_FRAME_BUDGET_MS (what cannot be ticked is dropped: the sleep only takes longer).
   * After each tick the sleeper is looked at (`wakeReason`); after each whole game hour of sleep `hooks.hour()` rolls the
   * night attack. The first reason ends the sleep at once.
   * @param {number} dt real seconds
   * @param {SleepHooks} hooks
   * @returns {{ ticks: number, woke: WakeReason|null }}
   */
  step(dt, hooks) {
    const out = { ticks: 0, woke: /** @type {WakeReason|null} */ (null) };
    if (!this.active || !(dt > 0)) return out;
    if (this.phase === 'falling') {
      this.lain += dt;
      if (this.lain < SLEEP_FADE_S) return out;
      this.phase = 'asleep';
      return out; // the first tick comes with the next frame
    }
    this.owed = Math.min(this.owed + dt * SLEEP_RATE, SLEEP_TICKS_PER_FRAME);
    const t0 = hooks.now ? hooks.now() : 0;
    while (this.owed >= 1 && out.ticks < SLEEP_TICKS_PER_FRAME) {
      this.owed -= 1;
      out.ticks++;
      out.woke = this._second(hooks);
      if (out.woke) break;
      if (hooks.now && hooks.now() - t0 > SLEEP_FRAME_BUDGET_MS) {
        this.owed = Math.min(this.owed, 1);
        break;
      }
    }
    return out;
  }

  /**
   * One game second of sleep: the world's (`hooks.second`), then the sleeper is looked at, then — each time a whole game
   * hour of sleep has built up (`sinceRoll`, which a new sleep does not clear) — the night attack is rolled.
   * @param {SleepHooks} hooks @returns {WakeReason|null} why the sleep ended, if it did
   */
  _second(hooks) {
    const s = hooks.second();
    this.seconds++;
    this.sinceRoll++;
    let reason = wakeReason(s, this.hours);
    if (!reason && this.sinceRoll >= GAME_HOUR_S) {
      this.sinceRoll = 0;
      if (hooks.hour && hooks.hour()) reason = 'attack';
    }
    if (reason) this.wake(reason);
    return reason;
  }

  /**
   * Sleep `seconds` game seconds at once, with no frame cap (the debug handle's way to step a sleep by game hours): the
   * same ticks, looks and rolls as `step`. Someone lying down is asleep at once. Stops at the first reason to wake.
   * @param {number} seconds game seconds @param {SleepHooks} hooks
   * @returns {{ ticks: number, woke: WakeReason|null }}
   */
  advance(seconds, hooks) {
    const out = { ticks: 0, woke: /** @type {WakeReason|null} */ (null) };
    if (!this.active) return out;
    this.phase = 'asleep';
    const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    while (out.ticks < n && !out.woke) {
      out.ticks++;
      out.woke = this._second(hooks);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. A secure place
// ---------------------------------------------------------------------------------------------------------------------

/** The fill goes no farther than this many cells from the bed (sideways, and down) … */
export const SECURE_RADIUS = 12;
/** … and only through the first this-many layers from the bed's floor up: no zombie climbs more than 4 (zombies.CLIMB). */
export const SECURE_RISE = 5;
/** … and through at most this many cells. */
export const SECURE_MAX_CELLS = 800;
/** Why a place is not secure (the target hint: `· not secure: open to the outside`). */
export const SECURE_REASONS = Object.freeze({
  open: 'open to the outside',
  big: 'too big a place to keep watch over',
  ground: 'zombies can come up from the ground inside',
});

/**
 * @typedef {Object} SecureEnv
 * @property {GetBlockFn} getBlock
 * @property {(q: number, r: number) => (number|null)} [spawnY]  the feet height at which a zombie may come up in column
 *   (q, r), or null (main: `zombies.spawnHeightAt(zombieWorld, q, r)`); without it no ground counts as a way in
 * @property {(q: number, r: number) => number} [groundHeight]  the generated top cell of the column; when given, `spawnY`
 *   is asked only for the cell right above it (it can be nowhere else)
 */

/**
 * @typedef {Object} SecureResult
 * @property {boolean} secure
 * @property {string} reason   '' when secure, else one of SECURE_REASONS
 * @property {number} cells    open cells the fill went through
 */

/**
 * Is the place round the sleep spot in cell (q, y, r) secure? The open cells (not solid) are flood-filled from where the
 * sleeper lies (the spot's own cell, or the one above it when the spot is a solid block): through the six side
 * neighbours and up and down, the farthest cell from the bed first. The fill never enters a cell above the first
 * SECURE_RISE layers (y … y + 4: a wall five high, or a roof, closes a place; the open sky above such a wall is not a way
 * in), and stops as not secure
 * - `open to the outside` when it would step farther than SECURE_RADIUS cells from the bed (sideways, or down);
 * - `too big …` when it has gone through more than SECURE_MAX_CELLS cells.
 * A fill that ended by itself is still not secure when one of its cells is a place a zombie could come up
 * (`env.spawnY`): `zombies can come up from the ground inside`. Otherwise the place is secure.
 * @param {SecureEnv} env
 * @param {number} q @param {number} y @param {number} r  the sleep spot's cell
 * @returns {SecureResult}
 */
export function secureAt(env, q, y, r) {
  const getBlock = env.getBlock;
  const top = y + SECURE_RISE - 1;
  const bottom = Math.max(0, y - SECURE_RADIUS);
  const open = (cq, cy, cr) => !isSolid(getBlock(cq, cy, cr));
  /** @type {number[][]} cells waiting, by their distance from the bed's column: (q, y, r) triples */
  const buckets = [];
  for (let d = 0; d <= SECURE_RADIUS; d++) buckets.push([]);
  const seen = new Set();
  const key = (cq, cy, cr) => ((cq - q + 16) << 12) | ((cr - r + 16) << 6) | (cy - y + 16);
  let far = -1;
  const push = (cq, cy, cr, d) => {
    const k = key(cq, cy, cr);
    if (seen.has(k)) return;
    seen.add(k);
    buckets[d].push(cq, cy, cr);
    if (d > far) far = d;
  };
  // Where the sleeper lies: the spot's own cell, or on top of a solid spot; a spot with a block on it: beside it.
  if (open(q, y, r)) push(q, y, r, 0);
  else if (y + 1 <= top && open(q, y + 1, r)) push(q, y + 1, r, 0);
  else {
    for (const [dq, dr] of HEX_DIRS) {
      for (let cy = y; cy <= y + 1; cy++) if (open(q + dq, cy, r + dr)) push(q + dq, cy, r + dr, 1);
    }
  }
  /** @type {Map<number, number|null>} column → where a zombie may come up in it */
  const spawnAt = new Map();
  let ground = false;
  let cells = 0;
  while (far >= 0) {
    const b = buckets[far];
    if (b.length === 0) {
      far--;
      continue;
    }
    const cr = /** @type {number} */ (b.pop());
    const cy = /** @type {number} */ (b.pop());
    const cq = /** @type {number} */ (b.pop());
    cells++;
    if (cells > SECURE_MAX_CELLS) return { secure: false, reason: SECURE_REASONS.big, cells: SECURE_MAX_CELLS };
    if (!ground && env.spawnY && (!env.groundHeight || env.groundHeight(cq, cr) + 1 === cy)) {
      const ck = ((cq - q + 16) << 6) | (cr - r + 16);
      let sy = spawnAt.get(ck);
      if (sy === undefined) {
        sy = env.spawnY(cq, cr);
        spawnAt.set(ck, sy);
      }
      if (sy === cy) ground = true;
    }
    const d = hexLength(cq - q, cr - r);
    for (const [dq, dr] of HEX_DIRS) {
      const nq = cq + dq;
      const nr = cr + dr;
      if (!open(nq, cy, nr)) continue;
      const nd = hexLength(nq - q, nr - r);
      if (nd > SECURE_RADIUS) return { secure: false, reason: SECURE_REASONS.open, cells };
      push(nq, cy, nr, nd);
    }
    if (cy + 1 <= top && open(cq, cy + 1, cr)) push(cq, cy + 1, cr, d);
    if (cy - 1 >= 0 && open(cq, cy - 1, cr)) {
      if (cy - 1 < bottom) return { secure: false, reason: SECURE_REASONS.open, cells };
      push(cq, cy - 1, cr, d);
    }
  }
  if (ground) return { secure: false, reason: SECURE_REASONS.ground, cells };
  return { secure: true, reason: '', cells };
}

/** @param {SecureResult|null} res @returns {string} what the target hint adds: `secure here` or `not secure: <reason>` */
export function secureWords(res) {
  if (!res) return '';
  return res.secure ? SLEEP_LINES.secure : `not secure: ${res.reason}`;
}

/** A block changed this far (cells) from the watched spot: its answer is worked out again (the fill's reach, and a light's). */
export const SECURE_WATCH = SECURE_RADIUS + 8;

/**
 * The answer of `secureAt` for one sleep spot, kept until a block changes within SECURE_WATCH cells of it (or `touch()`):
 * computed once when lying down (or when first looked at) and again only when it may have changed.
 */
export class SecureWatch {
  constructor() {
    /** @type {[number, number, number]|null} */
    this.cell = null;
    /** @type {SecureResult|null} */
    this.result = null;
    this.dirty = true;
    /** how many times secureAt ran */
    this.computed = 0;
  }

  /** Watch the spot in cell (q, y, r); another cell than before forgets the answer. */
  watch(q, y, r) {
    if (this.cell && this.cell[0] === q && this.cell[1] === y && this.cell[2] === r) return;
    this.cell = [q, y, r];
    this.result = null;
    this.dirty = true;
  }

  /** Stop watching. */
  clear() {
    this.cell = null;
    this.result = null;
    this.dirty = true;
  }

  /** The answer must be worked out again at the next `get` (the light changed, the zombies were switched). */
  touch() {
    this.dirty = true;
  }

  /** World.onBlockChange: a block within SECURE_WATCH cells of the watched spot makes the answer stale. */
  blockChanged(q, y, r) {
    const c = this.cell;
    if (!c || this.dirty) return;
    if (hexLength(q - c[0], r - c[2]) <= SECURE_WATCH && Math.abs(y - c[1]) <= SECURE_WATCH) this.dirty = true;
  }

  /** @param {SecureEnv} env @returns {SecureResult|null} null while nothing is watched */
  get(env) {
    const c = this.cell;
    if (!c) return null;
    if (this.dirty || !this.result) {
      this.result = secureAt(env, c[0], c[1], c[2]);
      this.dirty = false;
      this.computed++;
    }
    return this.result;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. The night comes for you
// ---------------------------------------------------------------------------------------------------------------------

/** Asleep at night in a place that is not secure, each game hour brings a night attack with this chance in the dark … */
export const NIGHT_ATTACK_P = 0.2;
/** … less this share of it in full light: a campfire or torches beside the bed cut the risk to a quarter, never to nothing. */
export const LIGHT_GUARD = 0.75;
/** Block light at the sleeper from which the guard is full. */
export const LIGHT_GUARD_FULL = 12;
/** The zombies of a night attack come up this many cells from the sleeper, at the least and at the most. */
export const ATTACK_MIN = 10;
export const ATTACK_MAX = 18;
/** A night attack is one zombie, or with this chance two (the second within ATTACK_PAIR cells of the first). */
export const ATTACK_PAIR_P = 0.35;
export const ATTACK_PAIR = 3.5;
/** One of them is a runner with this chance (zombies.RUNNER_P: a natural spawn's). */
export const ATTACK_RUNNER_P = 0.12;

/**
 * The chance of a night attack in one game hour asleep, by the block light at the sleeper:
 * NIGHT_ATTACK_P × (1 − LIGHT_GUARD × min(1, light / LIGHT_GUARD_FULL)).
 * @param {number} light 0..15
 */
export function nightAttackChance(light) {
  const l = light > 0 ? Math.min(1, light / LIGHT_GUARD_FULL) : 0;
  return NIGHT_ATTACK_P * (1 - LIGHT_GUARD * l);
}

/**
 * Roll the hour's night attack. No roll (and false) by day, in a secure place, or in a world with its zombies switched
 * off; else one `random()` against `nightAttackChance(light)`.
 * @param {{ isDay: boolean, secure: boolean, zombiesOn: boolean, light: number }} c
 * @param {() => number} random
 * @returns {boolean}
 */
export function rollNightAttack(c, random) {
  if (c.isDay || c.secure || !c.zombiesOn) return false;
  return random() < nightAttackChance(c.light);
}

/**
 * The zombies as a night attack needs them (zombies.js's Zombies): where one may come up, and the making of one.
 * @typedef {Object} AttackZombies
 * @property {boolean} enabled
 * @property {(world: any, q: number, r: number) => (number|null)} spawnHeightAt
 * @property {(world: any, q: number, r: number) => number} spawnChanceAt
 * @property {(x: number, y: number, z: number, yaw?: number, kind?: string) => (object|null)} spawn
 */

/**
 * The first column of `cols` (looked at in a random order, so every valid one is as likely) where the zombies module
 * lets a zombie come up, or null when there is none. One `random()` per column looked at.
 * @param {AttackZombies} zombies @param {any} zworld
 * @param {{ q: number, r: number, cx: number, cz: number, fy?: number }[]} cols  (reordered)
 * @param {() => number} random
 */
function firstValid(zombies, zworld, cols, random) {
  for (let i = 0; i < cols.length; i++) {
    const j = i + Math.min(cols.length - i - 1, Math.floor(random() * (cols.length - i)));
    const c = cols[j];
    cols[j] = cols[i];
    cols[i] = c;
    const fy = zombies.spawnHeightAt(zworld, c.q, c.r);
    if (fy === null) continue;
    c.fy = fy;
    return c;
  }
  return null;
}

/**
 * Put a night attack's zombies into the world: one, or two (ATTACK_PAIR_P), on ground where the zombies module itself
 * lets a zombie come up (`spawnHeightAt`: untouched, unlit, with room, away from fires), between ATTACK_MIN and ATTACK_MAX
 * cells from the sleeper at (x, z). The columns of that ring are looked at in a random order until one is valid (all of
 * them when none is: about 800); where dim light thins zombies out (`spawnChanceAt` below 1) one more draw may refuse
 * it. The second comes up within ATTACK_PAIR of the first, found the same way. With no valid ground in the ring — or the
 * draw refused — nothing is placed: no attack.
 * @param {AttackZombies} zombies
 * @param {any} zworld  the zombies' world view (main's zombieWorld)
 * @param {number} x @param {number} z  the sleeper
 * @param {() => number} random
 * @returns {object[]} the zombies placed (empty: no attack)
 */
export function placeNightAttack(zombies, zworld, x, z, random) {
  /** @type {object[]} */
  const placed = [];
  if (!zombies || !zombies.enabled || !Number.isFinite(x + z)) return placed;
  const [q0, r0] = worldToHex(x, z);
  /** @type {{ q: number, r: number, cx: number, cz: number, fy?: number }[]} */
  const ring = [];
  const reach = Math.ceil(ATTACK_MAX / 0.866) + 1;
  for (let dq = -reach; dq <= reach; dq++) {
    for (let dr = -reach; dr <= reach; dr++) {
      const [cx, cz] = hexToWorld(q0 + dq, r0 + dr);
      const d = Math.hypot(cx - x, cz - z);
      if (d >= ATTACK_MIN && d <= ATTACK_MAX) ring.push({ q: q0 + dq, r: r0 + dr, cx, cz });
    }
  }
  const come = (/** @type {{ q: number, r: number, cx: number, cz: number, fy?: number }|null} */ c) => {
    if (!c) return null;
    const chance = zombies.spawnChanceAt(zworld, c.q, c.r);
    if (chance < 1 && random() >= chance) return null;
    const yaw = Math.atan2(-(x - c.cx), -(z - c.cz)); // facing the sleeper
    const zb = zombies.spawn(c.cx, /** @type {number} */ (c.fy), c.cz, yaw, random() < ATTACK_RUNNER_P ? 'runner' : 'walker');
    if (zb) placed.push(zb);
    return zb;
  };
  const first = firstValid(zombies, zworld, ring, random);
  if (!come(first) || !(random() < ATTACK_PAIR_P)) return placed;
  const f = /** @type {{ cx: number, cz: number }} */ (first);
  come(firstValid(zombies, zworld, ring.filter((c) => c !== first && Math.hypot(c.cx - f.cx, c.cz - f.cz) <= ATTACK_PAIR), random));
  return placed;
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Awake too long: yawns, blurred sight, sounds with nothing there, a figure at the edge of sight, nods
// ---------------------------------------------------------------------------------------------------------------------

/** From Tired on, a yawn every this many seconds (a draw between the two), at this volume. */
export const YAWN_EVERY_S = Object.freeze([50, 110]);
export const YAWN_VOLUME = 0.7;
/** Sight blurs by at most this many CSS pixels, by stage (nothing before Exhausted) … */
export const BLUR_PX = Object.freeze([0, 0, 1.4, 1.9, 2.4]);
/** … in one slow wave of this many seconds, never under BLUR_FLOOR of the stage's most. */
export const BLUR_WAVE_S = 9;
export const BLUR_FLOOR = 0.2;
/** Seeing things: a sound with nothing there every this many seconds … */
export const PHANTOM_SOUND_EVERY_S = Object.freeze([25, 55]);
/** … one of these bank recipes, at its volume: a far groan, a footstep behind you, a twig. All quiet. */
export const PHANTOM_SOUNDS = Object.freeze([
  Object.freeze(['zombieGroan', 0.2]),
  Object.freeze(['stepGrass', 0.6]),
  Object.freeze(['digWood', 0.18]),
]);
/** In a world whose zombies are switched off (`TiredView.spooky` false) the groan is left out, and so is the figure. */
export const PHANTOM_SOUNDS_CALM = Object.freeze(PHANTOM_SOUNDS.filter((s) => s[0] !== 'zombieGroan'));
/** … a figure every this many seconds at the soonest (from one to the next), one at a time … */
export const FIGURE_EVERY_S = Object.freeze([20, 40]);
/** … (when there was nowhere for one to stand: another try after this long) … */
export const FIGURE_RETRY_S = 4;
/** … this many cells away … */
export const FIGURE_MIN = 12;
export const FIGURE_MAX = 20;
/** … between these angles off the middle of the view (rad: 30° to 42°), to the left or the right … */
export const FIGURE_SIDE = Object.freeze([0.52, 0.73]);
/** … gone the moment the view's middle comes within this angle of it (rad: 25°), or you come this much nearer … */
export const FIGURE_LOOK = 0.44;
export const FIGURE_NEARER = 0.25;
/** … and in any case within this long: it comes over FIGURE_IN_S, to FIGURE_ALPHA at the most, and fades from then on. */
export const FIGURE_S = 2;
export const FIGURE_IN_S = 0.4;
export const FIGURE_ALPHA = 0.5;
/** The figure's height (it is a still, dark shape: phantomRenderer.js). */
export const FIGURE_HEIGHT = 1.8;
/** … and a nod every this many seconds: the screen closes for NOD_S, going dark and coming back over NOD_EDGE_S each. */
export const NOD_EVERY_S = Object.freeze([20, 40]);
export const NOD_S = 0.4;
export const NOD_EDGE_S = 0.1;

/**
 * How much sight blurs (CSS px) at stage `stage` and effect time `t`: 0 before Exhausted; from there the stage's BLUR_PX
 * × (BLUR_FLOOR + (1 − BLUR_FLOOR) × a raised cosine of period BLUR_WAVE_S). Slow and soft: it never jumps.
 * @param {number} stage 0..4 @param {number} t seconds
 */
export function blurPx(stage, t) {
  const most = BLUR_PX[stage] ?? 0;
  if (!(most > 0)) return 0;
  const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * (Number.isFinite(t) ? t : 0)) / BLUR_WAVE_S);
  return most * (BLUR_FLOOR + (1 - BLUR_FLOOR) * wave);
}

/** @param {number} left seconds left of a nod (NOD_S … 0) @returns {number} how dark the screen is, 0..1 */
export function nodDark(left) {
  if (!(left > 0) || left > NOD_S) return 0;
  return Math.min(1, left / NOD_EDGE_S, (NOD_S - left) / NOD_EDGE_S);
}

/** @param {number} age seconds since the figure appeared @returns {number} its opacity, 0..FIGURE_ALPHA */
export function figureAlpha(age) {
  if (!(age >= 0) || age >= FIGURE_S) return 0;
  return FIGURE_ALPHA * Math.min(1, age / FIGURE_IN_S, (FIGURE_S - age) / (FIGURE_S - FIGURE_IN_S));
}

/**
 * The angle (rad, 0..π) between the middle of a view (yaw, pitch: yaw 0 looks along −Z, positive pitch looks up) and the
 * direction from the eye to a point.
 */
export function angleFromView(yaw, pitch, ex, ey, ez, px, py, pz) {
  const dx = px - ex;
  const dy = py - ey;
  const dz = pz - ez;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-9)) return 0;
  const cp = Math.cos(pitch);
  const dot = (-Math.sin(yaw) * cp * dx + Math.sin(pitch) * dy - Math.cos(yaw) * cp * dz) / len;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/**
 * What the figure is: a place and an opacity. It is drawing only: it is in no list of mobs, nothing targets it and it
 * does nothing. (x, y, z) are its feet; `yaw` faces the player it was made for.
 * @typedef {{ x: number, y: number, z: number, yaw: number, age: number, alpha: number, d0: number }} Phantom
 */

/**
 * @typedef {Object} TiredView
 * @property {number} stage     vitals.fatigueStage, 0..4
 * @property {boolean} awake    the player is up and the world runs (not asleep, not in a menu, alive)
 * @property {number} x @property {number} y @property {number} z   the eye
 * @property {number} yaw @property {number} pitch
 * @property {(q: number, r: number) => (number|null)} [standAt]  the feet height of a place to stand in column (q, r)
 *   near the player's level, or null (no figure is ever put where there is none)
 * @property {boolean} [spooky]  false in a world whose zombies are switched off: no groan and no figure there (the
 *   footstep, the twig and the nods stay); absent: true
 */

/**
 * The effects of tiredness that are not the body's: yawns from Tired on; at Seeing things, sounds with nothing there,
 * the figure and the nods. One `step` a frame; every timer runs only while its stage holds and the player is `awake`.
 */
export class TiredFx {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {Phantom|null} the figure, while there is one */
    this.figure = null;
    /** seconds left of the nod under way (0: none) */
    this.nod = 0;
    /** seconds to the next of each (NaN: drawn when its stage begins) */
    this.yawnIn = NaN;
    this.soundIn = NaN;
    this.figureIn = NaN;
    this.nodIn = NaN;
    /** figures shown, nods and phantom sounds so far (the debug handle, the tests) */
    this.figures = 0;
    this.nods = 0;
    this.sounds = 0;
  }

  /** How dark the nod under way makes the screen, 0..1. */
  get dark() {
    return nodDark(this.nod);
  }

  /**
   * @param {number} dt real seconds
   * @param {TiredView} view
   * @param {() => number} random
   * @returns {{ sounds: (readonly [string, number])[] }} bank recipes to play now, with their volumes
   */
  step(dt, view, random) {
    /** @type {(readonly [string, number])[]} */
    const sounds = [];
    const out = { sounds };
    const between = (/** @type {readonly number[]} */ range) => range[0] + (range[1] - range[0]) * random();
    if (!(dt > 0)) return out;
    const awake = !!view.awake;
    const stage = awake ? view.stage : 0;

    // Yawns: from Tired on.
    if (stage >= 1) {
      if (Number.isNaN(this.yawnIn)) this.yawnIn = between(YAWN_EVERY_S);
      this.yawnIn -= dt;
      if (this.yawnIn <= 0) {
        this.yawnIn = between(YAWN_EVERY_S);
        sounds.push(['yawn', YAWN_VOLUME]);
      }
    } else {
      this.yawnIn = NaN;
    }

    if (stage < 4) {
      this.figure = null;
      this.nod = 0;
      this.soundIn = NaN;
      this.figureIn = NaN;
      this.nodIn = NaN;
      return out;
    }

    // Seeing things. Sounds with nothing there.
    if (Number.isNaN(this.soundIn)) this.soundIn = between(PHANTOM_SOUND_EVERY_S);
    this.soundIn -= dt;
    if (this.soundIn <= 0) {
      this.soundIn = between(PHANTOM_SOUND_EVERY_S);
      const pool = view.spooky === false ? PHANTOM_SOUNDS_CALM : PHANTOM_SOUNDS;
      const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
      sounds.push(/** @type {readonly [string, number]} */ (pick));
      this.sounds++;
    }

    // Nods.
    if (this.nod > 0) this.nod = Math.max(0, this.nod - dt);
    if (Number.isNaN(this.nodIn)) this.nodIn = between(NOD_EVERY_S);
    this.nodIn -= dt;
    if (this.nodIn <= 0) {
      this.nodIn = between(NOD_EVERY_S);
      this.nod = NOD_S;
      this.nods++;
    }

    // The figure (never where `spooky` is false): it ages and fades; a look toward it or a step nearer and it is gone
    // at once.
    if (view.spooky === false) {
      this.figure = null;
      this.figureIn = NaN;
      return out;
    }
    const f = this.figure;
    if (f) {
      f.age += dt;
      const dist = Math.hypot(f.x - view.x, f.z - view.z);
      const angle = angleFromView(view.yaw, view.pitch, view.x, view.y, view.z, f.x, f.y + FIGURE_HEIGHT / 2, f.z);
      f.alpha = figureAlpha(f.age);
      if (f.age >= FIGURE_S || angle < FIGURE_LOOK || dist < f.d0 - FIGURE_NEARER || dist < FIGURE_MIN) this.figure = null;
    }
    if (Number.isNaN(this.figureIn)) this.figureIn = between(FIGURE_EVERY_S);
    this.figureIn -= dt;
    if (this.figureIn <= 0 && !this.figure) {
      const made = this._appear(view, random);
      this.figureIn = made ? between(FIGURE_EVERY_S) : FIGURE_RETRY_S;
    }
    return out;
  }

  /**
   * Try to put the figure at the edge of sight: FIGURE_MIN..FIGURE_MAX cells off, FIGURE_SIDE to the left or the right of
   * where the player looks, standing where `view.standAt` finds a place. @returns {boolean} whether one appeared
   * @param {TiredView} view @param {() => number} random
   */
  _appear(view, random) {
    const side = random() < 0.5 ? -1 : 1;
    const off = FIGURE_SIDE[0] + (FIGURE_SIDE[1] - FIGURE_SIDE[0]) * random();
    const d0 = FIGURE_MIN + (FIGURE_MAX - FIGURE_MIN) * random();
    if (!view.standAt) return false;
    const bearing = view.yaw + side * off;
    const [q, r] = worldToHex(view.x - Math.sin(bearing) * d0, view.z - Math.cos(bearing) * d0);
    const [x, z] = hexToWorld(q, r);
    const y = view.standAt(q, r);
    if (y === null || y === undefined || !Number.isFinite(y)) return false;
    // the cell's centre is not quite where it was aimed: it must still be far enough, and off the middle of the view
    const dist = Math.hypot(x - view.x, z - view.z);
    if (dist < FIGURE_MIN || dist > FIGURE_MAX) return false;
    if (angleFromView(view.yaw, view.pitch, view.x, view.y, view.z, x, y + FIGURE_HEIGHT / 2, z) < FIGURE_LOOK) return false;
    this.figure = { x, y, z, yaw: Math.atan2(-(view.x - x), -(view.z - z)), age: 0, alpha: 0, d0: dist };
    this.figures++;
    return true;
  }
}

/**
 * A place for the figure to stand in column (q, r), near feet level `near`: the lowest cell from `near` + 3 down to
 * `near` − 6 that is not solid, has a solid cell under it and another open cell above it. null when there is none.
 * @param {GetBlockFn} getBlock @param {number} q @param {number} r @param {number} near
 * @returns {number|null} the feet height
 */
export function phantomStandAt(getBlock, q, r, near) {
  const from = Math.floor(near) + 3;
  for (let y = from; y >= Math.max(1, from - 9); y--) {
    if (isSolid(getBlock(q, y - 1, r)) && !isSolid(getBlock(q, y, r)) && !isSolid(getBlock(q, y + 1, r))) return y;
  }
  return null;
}

/** The HUD's tiredness bar is full at this many hours awake (Seeing things). */
export const TIRED_BAR_FULL = DELIRIOUS_AT;

/**
 * The HUD's tiredness reading: the whole hours awake in words, how full its bar is, and the stage.
 * @param {number} fatigue game hours awake
 * @returns {{ hours: number, text: string, level: number, stage: number }} `text` is `Awake 14 h`; `level` 0..1 is the
 *   bar: full at TIRED_BAR_FULL hours (Seeing things)
 */
export function tirednessView(fatigue) {
  const f = Number.isFinite(fatigue) && fatigue > 0 ? fatigue : 0;
  const hours = Math.floor(f + 1e-6);
  return { hours, text: `Awake ${hours} h`, level: Math.min(1, hours / TIRED_BAR_FULL), stage: fatigueStage(hours) };
}

/** Where the bar's three marks stand (0..1): Tired, Exhausted and Weak. */
export const TIRED_BAR_MARKS = Object.freeze([TIRED_AT / TIRED_BAR_FULL, EXHAUSTED_AT / TIRED_BAR_FULL, WEAK_AT / TIRED_BAR_FULL]);
