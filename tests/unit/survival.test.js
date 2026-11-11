// Unit tests for src/survival.js — the mode, the survival step (falls through the real physics, climate, vitals),
// damage and death, eating, drinking, bandages, waking and the save part (docs/DESIGN-survival.md §1.2, §2, §3, §9.4).
import { describe, it, expect } from 'vitest';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { COLLISION_EPS, WATER_MAX_SINK, BREATH_MAX_S } from '../../src/config.js';
import { hexToWorld } from '../../src/hex.js';
import { createPlayer, stepPlayer, supportingCells } from '../../src/physics.js';
import { resolveBodies } from '../../src/bodies.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { softLandingFactor, fallDamage, createVitals, RATES, DAMAGE_CAUSES } from '../../src/vitals.js';
import { groundChillOf, heatAt, heatSource, CHEST_HEIGHT } from '../../src/climate.js';
import {
  Survival, MODES, DEATH_TITLES, deathTitle, SICK_MESSAGE, SALT_MESSAGE, SALT_MESSAGE_GAP_S, DOT_PULSE_HP,
  BELONGINGS_KEPT, BELONGINGS_LOST,
} from '../../src/survival.js';
import { flatGetBlock } from '../helpers/fixtures.js';

const DT = 1 / 60;
const GROUND = 63;          // solid up to y 63: feet rest at 64 (altitude 0)
const FEET = GROUND + 1;
const PLAINS_NOON = { biome: BIOME.PLAINS, climateT: 0, openSky: true, underground: false, groundChill: 0 };
const NOON = 0.5;
const H = (h) => h / 24;
const idle = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

const BANDS = ['Heatstroke', 'Overheating', 'Hot', 'Chilled', 'Cold', 'Freezing', 'Hypothermic'];
/** @param {string[]} labels @returns {string[]} only the body-temperature labels */
const tempBandLabels = (labels) => labels.filter((l) => BANDS.includes(l));

/** A Survival in survival mode with a fresh state and no fall grace. */
function started() {
  const s = new Survival();
  s.setMode('survival');
  s.fallGrace = false;
  return s;
}

/** The env main would build for this frame (soft factor from the cells under the feet). */
function envFor(player, getBlock, over = {}) {
  const ids = supportingCells(player, getBlock).map(([q, y, r]) => getBlock(q, y, r));
  return { player, softFactor: softLandingFactor(ids), climate: PLAINS_NOON, heat: 0, time: NOON, random: () => 0.5, ...over };
}

/** A standing player (no landing, no motion) at feet height FEET. */
function stander(over = {}) {
  return Object.assign(createPlayer(0, FEET, 0), { onGround: true, landSpeed: 0 }, over);
}

/** Run the survival step on a still player for `seconds`; stop at death. Returns the time and the events seen. */
function live(s, seconds, env, dt = 0.25, each) {
  let t = 0;
  for (; t < seconds; t += dt) {
    const ev = s.step(dt, env);
    if (each) each(ev, t + dt);
    if (ev.died) return { t: t + dt, died: ev.died };
  }
  return { t, died: null };
}

/**
 * Drop the player `d` cells onto `getBlock` (flat ground at GROUND by default) through the real stepPlayer, stepping
 * survival every frame like main does. Returns the fall damage dealt and the final state.
 */
function drop(d, { s = started(), getBlock = flatGetBlock(GROUND), q = 0, r = 0, bodies = null } = {}) {
  const [x, z] = hexToWorld(q, r);
  const p = createPlayer(x, FEET + d + COLLISION_EPS, z);
  let fall = 0;
  let died = null;
  let landed = false;
  for (let i = 0; i < 900 && !died && !(landed && i > 5 && p.onGround && Math.abs(p.vy) < 1e-9); i++) {
    stepPlayer(p, idle, getBlock, DT);
    if (bodies) resolveBodies([p, ...bodies], getBlock);
    const ev = s.step(DT, envFor(p, getBlock));
    fall += ev.fall;
    if (ev.fall > 0 || p.onGround) landed = true;
    died = ev.died;
  }
  return { fall, died, s, p };
}

describe('mode and setMode (§1.2)', () => {
  it('starts in Creative with no state; inSurvival and active follow the mode and death', () => {
    const s = new Survival();
    expect([s.mode, s.hasState, s.switchVersion, s.inSurvival, s.active, s.dead]).toEqual(['creative', false, 0, false, false,
      null]);
    expect(MODES).toEqual(['creative', 'survival']);
    expect(s.setMode('survival')).toBe(true);
    expect([s.inSurvival, s.active]).toEqual([true, true]);
    s.dead = 'fall';
    expect([s.inSurvival, s.active]).toEqual([true, false]);
  });

  it('entering Survival the first time begins a fresh state with fall grace; leaving freezes it; coming back restores it', () => {
    const s = new Survival();
    expect(s.setMode('survival')).toBe(true);
    expect(s.hasState).toBe(true);
    expect(s.fallGrace).toBe(true);
    expect(s.vitals).toEqual(createVitals());
    expect(s.switchVersion).toBe(1);
    s.vitals.health = 42;
    s.vitals.satiation = 12;
    s.spawn = [1, 2, 3];
    s.fallGrace = false;
    expect(s.setMode('creative')).toBe(true);
    expect(s.switchVersion).toBe(2);
    expect(s.step(1, envFor(stander(), flatGetBlock(GROUND))).damage).toBe(0); // frozen
    expect(s.vitals.satiation).toBe(12);
    expect(s.setMode('survival')).toBe(true);
    expect([s.vitals.health, s.vitals.satiation, s.spawn]).toEqual([42, 12, [1, 2, 3]]);
    expect(s.fallGrace).toBe(true);
    expect(s.switchVersion).toBe(3);
  });

  it('refuses unknown modes, no-op switches and any switch while dead', () => {
    const s = new Survival();
    expect(s.setMode('creative')).toBe(false);
    expect(s.setMode('adventure')).toBe(false);
    expect(s.setMode(/** @type {*} */ (null))).toBe(false);
    expect(s.switchVersion).toBe(0);
    s.setMode('survival');
    expect(s.setMode('survival')).toBe(false);
    s.dead = 'starve';
    expect(s.setMode('creative')).toBe(false);
    expect(s.mode).toBe('survival');
    expect(s.switchVersion).toBe(1);
  });

  it('begin() is a fresh state: vitals, no hide, no deaths, alive', () => {
    const s = started();
    s.vitals.health = 3;
    s.spawn = [0, 0, 0];
    s.deaths = 4;
    s.dead = 'cold';
    s.begin();
    expect(s.vitals).toEqual(createVitals());
    expect([s.spawn, s.deaths, s.dead, s.hasState, s.fallGrace]).toEqual([null, 0, null, true, true]);
  });
});

describe('falls through the real physics (§2.4)', () => {
  it('3 cells: no damage; 4 ≈ 2.7 HP; 10 ≈ 37.0 HP (±1)', () => {
    expect(drop(3).fall).toBe(0);
    expect(drop(4).fall).toBeCloseTo(2.7, 0);
    expect(Math.abs(drop(4).fall - 2.7)).toBeLessThan(1);
    expect(Math.abs(drop(10).fall - 37.0)).toBeLessThan(1);
    expect(Math.abs(drop(15).fall - 64.1)).toBeLessThan(1);
  });

  it('21 cells leaves about 3.5 HP from full health; 22 cells kills (cause fall)', () => {
    const a = drop(21);
    expect(a.died).toBeNull();
    expect(a.s.vitals.health).toBeGreaterThan(0);
    expect(Math.abs(a.s.vitals.health - 3.5)).toBeLessThan(1);
    const b = drop(22);
    expect(b.died).toBe('fall');
    expect(b.s.dead).toBe('fall');
    expect(b.s.vitals.health).toBe(0);
    expect(b.s.active).toBe(false);
  });

  it('swim-depth water cushions completely; wading water does not', () => {
    const pool = (q, y) => (y < 0 ? BLOCK.AIR : y <= GROUND ? BLOCK.STONE : y <= GROUND + 3 ? BLOCK.WATER : BLOCK.AIR);
    const deep = drop(40, { getBlock: pool });
    expect(deep.fall).toBe(0);
    expect(deep.s.vitals.health).toBeGreaterThan(99);
    expect(-WATER_MAX_SINK).toBeLessThan(13.5);
    // A level-1 film (a flowing edge) on the floor: wading, so the fall lands on the ground at full speed.
    const film = (q, y) => (y < 0 ? BLOCK.AIR : y <= GROUND ? BLOCK.STONE : y === FEET ? BLOCK.WATER_FLOW_1 : BLOCK.AIR);
    expect(drop(10, { getBlock: film }).fall).toBeGreaterThan(30);
  });

  it('the softest factor over several supporting cells: a vertex of snow, hay and stone lands at × 0.4', () => {
    // Corner 0 of cell (0,0) is shared with (1,0) and (1,−1); put the player right on it.
    const ground = (q, y, r) => {
      if (y < 0 || y > GROUND) return BLOCK.AIR;
      if (y < GROUND) return BLOCK.STONE;
      if (q === 1 && r === 0) return BLOCK.SNOW_BLOCK;
      if (q === 1 && r === -1) return BLOCK.HAY_BALE;
      return BLOCK.STONE;
    };
    const s = started();
    const p = createPlayer(0.5, FEET + 10 + COLLISION_EPS, -Math.sqrt(3) / 6);
    let fall = 0;
    let factor = 0;
    for (let i = 0; i < 200; i++) {
      stepPlayer(p, idle, ground, DT);
      const env = envFor(p, ground);
      if (p.landSpeed > 1) factor = env.softFactor;
      fall += s.step(DT, env).fall;
    }
    expect(factor).toBe(0.4);
    expect(fall).toBeCloseTo(0.4 * 37.0, 0);
    // Hay alone (no snow under the feet): × 0.6.
    const hay = (q, y, r) => (y === GROUND && q === 0 && r === 0 ? BLOCK.HAY_BALE : flatGetBlock(GROUND)(q, y, r));
    expect(drop(10, { getBlock: hay }).fall).toBeCloseTo(0.6 * 37.0, 0);
    const wool = (q, y, r) => (y === GROUND ? BLOCK.WOOL_BLUE : flatGetBlock(GROUND)(q, y, r));
    expect(drop(10, { getBlock: wool }).fall).toBeCloseTo(0.7 * 37.0, 0);
    const hide = (q, y, r) => (y === GROUND ? BLOCK.SLEEPING_HIDE : flatGetBlock(GROUND)(q, y, r));
    expect(drop(10, { getBlock: hide }).fall).toBeCloseTo(0.9 * 37.0, 0);
  });

  it('consume semantics: step reads landSpeed and zeroes it, so a value is applied once', () => {
    const s = started();
    const p = stander({ landSpeed: 20 });
    const env = envFor(p, flatGetBlock(GROUND));
    const first = s.step(DT, env);
    expect(first.fall).toBeCloseTo(fallDamage(20), 9);
    expect(first.causes).toContain('fall');
    expect(p.landSpeed).toBe(0);
    // A frame where stepPlayer was skipped (unloaded chunk): the stale value is not there to apply again.
    expect(s.step(DT, env).fall).toBe(0);
    expect(s.vitals.health).toBeCloseTo(100 - fallDamage(20), 2);
  });

  it('fall grace: the first landing does no damage and clears it; the next one hurts', () => {
    const s = new Survival();
    s.setMode('survival');
    expect(s.fallGrace).toBe(true);
    const graced = drop(15, { s });
    expect(graced.fall).toBe(0);
    expect(s.fallGrace).toBe(false);
    expect(drop(15, { s }).fall).toBeGreaterThan(60);
    // Any landing clears it, standing on the ground included (a teleport onto the ground).
    s.fallGrace = true;
    const p = createPlayer(0, FEET + 0.5, 0);
    for (let i = 0; i < 60; i++) {
      stepPlayer(p, idle, flatGetBlock(GROUND), DT);
      s.step(DT, envFor(p, flatGetBlock(GROUND)));
    }
    expect(s.fallGrace).toBe(false);
    // In mid-air the grace waits for the landing.
    s.fallGrace = true;
    const air = createPlayer(0, FEET + 50, 0);
    for (let i = 0; i < 30; i++) {
      stepPlayer(air, idle, flatGetBlock(GROUND), DT);
      s.step(DT, envFor(air, flatGetBlock(GROUND)));
    }
    expect(s.fallGrace).toBe(true);
  });

  it('landing on a mob counts: bodies.standOn records the speed', () => {
    const pigs = new Pigs(seededRng(3));
    const pig = pigs.spawn(0, FEET, 0);
    pig.onGround = true;
    const s = started();
    const p = createPlayer(0, FEET + 0.9 + 8, 0);
    const ground = flatGetBlock(GROUND);
    let fall = 0;
    let recorded = 0;
    for (let i = 0; i < 120; i++) {
      stepPlayer(p, idle, ground, DT);
      stepPlayer(pig, idle, ground, DT);
      resolveBodies([p, pig], ground);
      recorded = Math.max(recorded, p.landSpeed);
      fall += s.step(DT, envFor(p, ground)).fall;
    }
    expect(p.carrier).toBe(pig); // it stands on the pig
    expect(recorded).toBeGreaterThan(13.5);
    expect(fall).toBeCloseTo(fallDamage(recorded), 6);
    expect(fall).toBeGreaterThan(10);
  });
});

describe('the step: climate and vitals together (§2, §3, §9.4)', () => {
  it('reports felt and air; a comfortable plains noon keeps the body at 37', () => {
    const s = started();
    const ev = s.step(1, envFor(stander(), flatGetBlock(GROUND), { time: H(14) }));
    expect(ev.air).toBeCloseTo(18, 1);
    expect(ev.felt).toBeCloseTo(21.65, 1); // v0.11 (§68): the sun stands higher at 14:00 in the 15-hour day
    expect([s.felt, s.air]).toEqual([ev.felt, ev.air]);
    expect(s.vitals.temp).toBe(37);
    expect(ev.died).toBeNull();
    expect(ev.causes).toEqual([]);
  });

  it('the snowy night (felt −13.2): Freezing from ~1.7 min, dead of cold at ~4.5 min', () => {
    const s = started();
    const env = envFor(stander(), flatGetBlock(GROUND), {
      climate: { biome: BIOME.SNOWY, climateT: -0.6, openSky: true, underground: false, groundChill: groundChillOf(BLOCK.SNOWY_GRASS) },
      time: H(2),
    });
    let freezingAt = null;
    const r = live(s, 600, env, 0.25, (ev, t) => {
      if (freezingAt === null && s.status.labels.includes('Freezing')) freezingAt = t;
    });
    expect(r.died).toBe('cold');
    expect(freezingAt / 60).toBeCloseTo(1.7, 1);
    expect(Math.abs(r.t / 60 - 4.5)).toBeLessThan(0.2);
    expect(s.felt).toBeCloseTo(-13.2, 1);
  });

  it('… in leather (I 10) it is Cold without damage; beside a campfire 1.5 away it is fine', () => {
    const climate = { biome: BIOME.SNOWY, climateT: -0.6, openSky: true, underground: false, groundChill: -2 };
    const s = started();
    live(s, 600, envFor(stander(), flatGetBlock(GROUND), { climate, time: H(2), insulation: 10 }));
    expect(Math.abs(s.vitals.temp - 33.0)).toBeLessThan(0.2);
    expect(s.status.labels).toContain('Cold');
    expect(s.status.labels).not.toContain('Freezing');
    expect(s.vitals.health).toBe(100); // hungry by now, but no damage
    const fire = heatSource('campfire', 0, GROUND, 0);
    const heat = heatAt([fire], fire.x + 1.5, fire.y, fire.z);
    const f = started();
    live(f, 600, envFor(stander(), flatGetBlock(GROUND), { climate, time: H(2), insulation: 10, heat }));
    expect(Math.abs(f.felt - 8.0)).toBeLessThan(0.2);
    expect(Math.abs(f.vitals.temp - 36.4)).toBeLessThan(0.2);
    expect(tempBandLabels(f.status.labels)).toEqual([]);
    expect(CHEST_HEIGHT).toBe(1);
  });

  it('snowy water: Freezing in ~30 s and dead at ~2.2 min; plains water is cold quickly (τ 36 s)', () => {
    const swimmer = stander({ inWater: true, headInWater: false, onGround: false });
    const s = started();
    let freezingAt = null;
    const r = live(s, 300, envFor(swimmer, flatGetBlock(GROUND), {
      climate: { biome: BIOME.SNOWY, climateT: -0.6, openSky: true, underground: false, groundChill: 0 },
    }), 0.25, (ev, t) => {
      if (freezingAt === null && s.status.labels.includes('Freezing')) freezingAt = t;
    });
    expect(s.felt).toBe(3);
    expect(Math.abs(freezingAt - 32)).toBeLessThan(3);
    expect(r.died).toBe('cold');
    expect(Math.abs(r.t / 60 - 2.2)).toBeLessThan(0.15);
    const p = started();
    live(p, 36, envFor(stander({ inWater: true }), flatGetBlock(GROUND)), 0.25);
    expect(p.felt).toBe(12);
    expect(p.vitals.temp).toBeCloseTo(33.8 + 3.2 / Math.E, 1);
    expect(p.vitals.wet).toBe(1);
  });

  it('wet: 1 in water, then dries at (1 + heat/5)·(sun ? 2 : 1)/90 per second', () => {
    const s = started();
    s.step(DT, envFor(stander({ inWater: true }), flatGetBlock(GROUND)));
    expect(s.vitals.wet).toBe(1);
    s.step(9, envFor(stander(), flatGetBlock(GROUND))); // open sky at noon: 2/90 per second
    expect(s.vitals.wet).toBeCloseTo(0.8, 9);
    s.step(9, envFor(stander(), flatGetBlock(GROUND), { time: H(23), heat: 10 })); // night, by a fire: 3/90
    expect(s.vitals.wet).toBeCloseTo(0.5, 9);
    expect(s.status.labels).toContain('Wet');
    s.step(100, envFor(stander(), flatGetBlock(GROUND)));
    expect(s.vitals.wet).toBe(0);
  });

  it('activity from the env: moving, breaking, swimming and sprinting raise both the drain and the felt heat', () => {
    const at = (over, player = stander()) => {
      const s = started();
      const ev = s.step(1, envFor(player, flatGetBlock(GROUND), { time: H(14), ...over })); // comfortable: no factors
      return { drain: 80 - s.vitals.satiation, felt: ev.felt };
    };
    const still = at({});
    const walk = at({ moving: true });
    const brk = at({ breaking: true });
    const sprint = at({ moving: true }, stander({ sprinting: true }));
    const sprintStill = at({ moving: false }, stander({ sprinting: true })); // pressing into a wall is not sprinting
    expect(walk.drain / still.drain).toBeCloseTo(1.4, 6);
    expect(brk.drain / still.drain).toBeCloseTo(1.8, 6);
    expect(sprint.drain / still.drain).toBeCloseTo(2.5, 6);
    expect(sprintStill.drain).toBeCloseTo(still.drain, 9);
    expect(walk.felt - still.felt).toBeCloseTo(1, 9);
    expect(brk.felt - still.felt).toBeCloseTo(2, 9);
    expect(sprint.felt - still.felt).toBeCloseTo(4, 9);
    // `moving` defaults to a horizontal speed above 0.5 m/s.
    const fast = at({ moving: undefined }, stander({ vx: 3 }));
    expect(fast.drain / still.drain).toBeCloseTo(1.4, 6);
    const slow = at({ moving: undefined }, stander({ vx: 0.3 }));
    expect(slow.drain).toBeCloseTo(still.drain, 9);
  });

  it('regenerates by a campfire twice as fast while standing still for 3 s; walking resets it', () => {
    const s = started();
    s.vitals.health = 50;
    live(s, 10, envFor(stander(), flatGetBlock(GROUND), { nearFire: true, still: true }), 0.5);
    expect(s.vitals.health).toBeCloseTo(50 + 2.5 * 0.12 + 7.5 * 0.24, 6);
    const w = started();
    w.vitals.health = 50;
    live(w, 10, envFor(stander({ vx: 2 }), flatGetBlock(GROUND), { nearFire: true }), 0.5); // still defaults to !moving
    expect(w.vitals.health).toBeCloseTo(51.2, 6);
  });

  it('drowning: breath lasts 20 s with the head under water, then 8 HP/s (cause drown); buried smothers the same way', () => {
    const diver = stander({ inWater: true, headInWater: true });
    const s = started();
    const env = envFor(diver, flatGetBlock(GROUND), { climate: { ...PLAINS_NOON, biome: BIOME.DESERT, climateT: 1 } });
    live(s, 20, env, 0.25);
    expect(s.vitals.breath).toBeCloseTo(0, 9);
    expect(s.vitals.health).toBe(100);
    s.step(0.25, env);
    expect(s.status.labels).toContain('Drowning');
    const r = live(s, 60, env, 0.25);
    expect(r.died).toBe('drown');
    expect(20.25 + r.t).toBeCloseTo(20 + 100 / 8, 0);
    const b = started();
    const rb = live(b, 60, envFor(stander(), flatGetBlock(GROUND), { buried: true }), 0.25);
    expect(rb.died).toBe('buried');
    expect(rb.t).toBeCloseTo(32.5, 0);
    expect(b.status.labels).toContain('Smothering');
  });

  it('sickness never kills on its own: it stops at 10 HP', () => {
    const s = started();
    s.vitals.health = 12;
    s.vitals.sick = 600;
    live(s, 100, envFor(stander(), flatGetBlock(GROUND)), 0.5);
    expect(s.vitals.health).toBeCloseTo(10, 6);
    expect(s.dead).toBeNull();
  });

  it('starving and thirst kill with their own causes; the cause that dealt the most wins', () => {
    const s = started();
    s.vitals.health = 1;
    s.vitals.satiation = 0;
    s.vitals.hydration = 0;
    const r = live(s, 10, envFor(stander(), flatGetBlock(GROUND)), 0.5);
    expect(r.died).toBe('thirst'); // 0.7 HP/s beats 0.35
    const t = started();
    t.vitals.health = 1;
    t.vitals.satiation = 0;
    expect(live(t, 10, envFor(stander(), flatGetBlock(GROUND)), 0.5).died).toBe('starve');
  });

  it('damage over time pulses once per 3 HP lost', () => {
    const s = started();
    let pulses = 0;
    live(s, 30, envFor(stander(), flatGetBlock(GROUND), {
      climate: { biome: BIOME.SNOWY, climateT: -1, openSky: true, underground: false, groundChill: -2 }, time: H(2),
    }), 0.25, (ev) => {
      if (ev.pulse) pulses++;
    });
    const lost = 100 - s.vitals.health;
    expect(DOT_PULSE_HP).toBe(3);
    expect(pulses).toBe(Math.floor(lost / 3));
  });

  it('is a no-op in Creative, while dead, for dt ≤ 0 or without an env (landSpeed is left alone)', () => {
    const c = new Survival();
    const p = stander({ landSpeed: 30 });
    expect(c.step(1, envFor(p, flatGetBlock(GROUND)))).toMatchObject({ damage: 0, causes: [], died: null, fall: 0 });
    expect(p.landSpeed).toBe(30);
    const d = started();
    d.dead = 'fall';
    const before = { ...d.vitals };
    d.step(5, envFor(p, flatGetBlock(GROUND)));
    expect(d.vitals).toEqual(before);
    expect(p.landSpeed).toBe(30);
    const z = started();
    z.step(0, envFor(p, flatGetBlock(GROUND)));
    z.step(NaN, envFor(p, flatGetBlock(GROUND)));
    z.step(1, null);
    expect(z.vitals).toEqual(createVitals());
    expect(z.clock).toBe(0);
  });

  it('tolerates a sparse env (no climate, no player)', () => {
    const s = started();
    const ev = s.step(1, { time: 0.5 });
    expect(Number.isFinite(ev.felt)).toBe(true);
    expect(ev.died).toBeNull();
  });
});

describe('damage, death and waking (§2.4, §2.5)', () => {
  it('damage only while active; the killing hit sets dead = cause and later hits are ignored', () => {
    const c = new Survival();
    expect(c.damage(50, 'zombie')).toBe(false);
    expect(c.vitals.health).toBe(100);
    const s = started();
    expect(s.damage(30, 'zombie')).toBe(false);
    expect(s.vitals.health).toBe(70);
    expect(s.damage(0, 'zombie')).toBe(false);
    expect(s.damage(-5, 'zombie')).toBe(false);
    expect(s.damage(NaN, 'zombie')).toBe(false);
    expect(s.vitals.health).toBe(70);
    expect(s.damage(70, 'blast')).toBe(true);
    expect([s.dead, s.active, s.vitals.health]).toEqual(['blast', false, 0]);
    expect(s.damage(10, 'fire')).toBe(false);
    expect(s.dead).toBe('blast');
  });

  it('respawn applies the waking values, comes back alive and sets fall grace (deaths are main\'s to count)', () => {
    const s = started();
    s.vitals.satiation = 20;
    s.vitals.hydration = 70;
    s.vitals.temp = 29;
    s.vitals.sick = 100;
    s.damage(500, 'cold');
    s.respawn();
    expect(s.vitals).toMatchObject({ health: 60, satiation: 50, hydration: 70, temp: 37, breath: BREATH_MAX_S, wet: 0, sick: 0,
      heal: 0 });
    expect([s.dead, s.active, s.fallGrace, s.deaths]).toEqual([null, true, true, 0]);
  });

  it('death titles by cause (§2.5)', () => {
    const causes = DAMAGE_CAUSES.filter((c) => c !== 'sick');
    expect(Object.keys(DEATH_TITLES).sort()).toEqual([...causes].sort());
    expect(deathTitle('fall')).toBe('The ground came up too fast.');
    expect(deathTitle('void')).toBe('You slipped beneath the bedrock.');
    expect(deathTitle('blackhole')).toBe('Swallowed by a black hole.');
    expect(deathTitle('sick')).toBe('You collapsed.');
    expect(deathTitle('__proto__')).toBe('You collapsed.');
    expect(BELONGINGS_KEPT).toBe('Your belongings lie where you fell.');
    expect(BELONGINGS_LOST).toBe('Your belongings are lost.');
    for (const t of Object.values(DEATH_TITLES)) expect(t).not.toBe('You died!');
  });
});

describe('eating, drinking and bandages (§2.3, §4.2, §4.5)', () => {
  it('eat applies food values; raw pork can sicken; pots return the clay pot; seawater says it is salty', () => {
    const s = started();
    s.vitals.satiation = 50;
    expect(s.eat('roast_pork', () => 0.9)).toEqual({ ok: true });
    expect(s.vitals.satiation).toBe(80);
    expect(s.vitals.hydration).toBe(78);
    expect(s.eat('raw_pork', () => 0.1)).toEqual({ ok: true, message: SICK_MESSAGE });
    expect(s.vitals.sick).toBe(45);
    expect(s.eat('pot_boiled', () => 0)).toEqual({ ok: true, returns: 'clay_pot' });
    expect(s.eat('pot_seawater', () => 0)).toEqual({ ok: true, message: SALT_MESSAGE, returns: 'clay_pot' });
    expect(s.eat('pot_water', () => 0.02)).toEqual({ ok: true, message: SICK_MESSAGE, returns: 'clay_pot' });
    expect(s.eat('snow')).toEqual({ ok: true }); // no random given: never sick
  });

  it('eat refuses non-food and unknown keys, and anything while not active', () => {
    const s = started();
    expect(s.eat('rock').ok).toBe(false);
    expect(s.eat('rock').message).toBe('Rock cannot be eaten');
    expect(s.eat('pot_snow').ok).toBe(false); // a material: boiled, never drunk
    expect(s.eat('unpeeled_cactus_fruit').ok).toBe(false);
    expect(s.eat('nope').ok).toBe(false);
    expect(s.eat(/** @type {*} */ (undefined)).ok).toBe(false);
    const c = new Survival();
    expect(c.eat('honeyberries')).toEqual({ ok: false });
    s.dead = 'fall';
    expect(s.eat('honeyberries').ok).toBe(false);
  });

  it('drink: fresh +8 (6 % poisoned: −8 at once), salt −4 with the salty line at most once per 5 s of Survival', () => {
    const s = started();
    s.vitals.hydration = 50;
    expect(s.drink(false, () => 0.5)).toBe('');
    expect(s.vitals.hydration).toBe(58);
    expect(s.drink(false, () => 0.001)).toBe(SICK_MESSAGE);
    expect(s.drink(true, () => 0.5)).toBe(SALT_MESSAGE);
    expect(s.vitals.hydration).toBe(54); // 58, poisoned (+8 − 8), salty −4
    expect(s.drink(true)).toBe(''); // throttled
    expect(s.vitals.hydration).toBe(50); // still salty
    s.step(SALT_MESSAGE_GAP_S, envFor(stander(), flatGetBlock(GROUND)));
    expect(s.drink(true)).toBe(SALT_MESSAGE);
    const c = new Survival();
    expect(c.drink(false)).toBe('');
    expect(c.vitals.hydration).toBe(80);
  });

  it('bandage queues the item\'s healing while active', () => {
    const s = started();
    s.vitals.health = 30;
    expect(s.bandage('fibre_bandage')).toBe(true);
    expect([s.vitals.heal, s.vitals.healRate]).toEqual([15, 1.5]);
    expect(s.bandage('rag_bandage')).toBe(true);
    expect([s.vitals.heal, s.vitals.healRate]).toEqual([40, 2.5]);
    expect(s.bandage('rag_bandage')).toBe(true);
    expect(s.vitals.heal).toBe(50);
    expect(s.bandage('fibre_bandage')).toBe(false); // full
    expect(s.bandage('honeyberries')).toBe(false);
    expect(new Survival().bandage('fibre_bandage')).toBe(false);
  });
});

describe('console helpers (§9.7)', () => {
  it('setVital clamps to each range; unknown names, bad values or no state are refused', () => {
    const s = started();
    expect(s.setVital('health', 150)).toBe(true);
    expect(s.vitals.health).toBe(100);
    expect(s.setVital('nourishment', 12)).toBe(true);
    expect(s.vitals.satiation).toBe(12);
    expect(s.setVital('satiation', -4)).toBe(true);
    expect(s.vitals.satiation).toBe(0);
    expect(s.setVital('hydration', 33)).toBe(true);
    expect(s.setVital('temp', 99)).toBe(true);
    expect(s.vitals.temp).toBe(45);
    expect(s.setVital('breath', 50)).toBe(true);
    expect(s.vitals.breath).toBe(20);
    expect(s.setVital('temp', 37)).toBe(true);
    expect(s.setVital('health', 0)).toBe(true);
    expect(s.dead).toBeNull(); // main's CommandContext turns this into pendingDeath ('command')
    expect(s.setVital('mana', 5)).toBe(false);
    expect(s.setVital('__proto__', 5)).toBe(false);
    expect(s.setVital('health', NaN)).toBe(false);
    expect(new Survival().setVital('health', 5)).toBe(false);
    // A health of 0 left standing dies at the next step as 'command', whatever else hurts.
    s.setVital('nourishment', 0);
    expect(s.step(DT, envFor(stander(), flatGetBlock(GROUND))).died).toBe('command');
  });

  it('restoreVitals fills every stat', () => {
    const s = started();
    Object.assign(s.vitals, { health: 3, satiation: 4, hydration: 5, temp: 30, breath: 1, wet: 1, sick: 80, heal: 20, healRate: 2.5 });
    expect(s.restoreVitals()).toBe(true);
    expect(s.vitals).toMatchObject({ health: 100, satiation: 100, hydration: 100, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0,
      healRate: 0 });
    expect(new Survival().restoreVitals()).toBe(false);
  });
});

describe('export / import (§9.6)', () => {
  it('exports the vitals part in canonical key order, rounded to 3 decimals; dead only while dead', () => {
    const s = started();
    Object.assign(s.vitals, { health: 87.123456, satiation: 64.0004, hydration: 51.9996, temp: 36.91234, breath: 20, wet: 0.33333,
      sick: 0, heal: 0, healRate: 0 });
    s.spawn = [12, 64, -40];
    s.deaths = 2;
    const json = s.export();
    expect(Object.keys(json)).toEqual(['health', 'satiation', 'hydration', 'temp', 'breath', 'wet', 'sick', 'heal', 'healRate',
      'spawn', 'deaths']);
    expect(json).toEqual({ health: 87.123, satiation: 64, hydration: 52, temp: 36.912, breath: 20, wet: 0.333, sick: 0, heal: 0,
      healRate: 0, spawn: [12, 64, -40], deaths: 2 });
    expect(json.spawn).not.toBe(s.spawn);
    s.damage(500, 'fall');
    const dead = s.export();
    expect(Object.keys(dead).at(-1)).toBe('dead');
    expect(dead.dead).toBe('fall');
    expect(Object.is(dead.health, 0)).toBe(true);
  });

  it('round-trips through JSON, including death and the hide', () => {
    const s = started();
    Object.assign(s.vitals, { health: 44.5, satiation: 21, hydration: 9, temp: 34.2, breath: 7, wet: 0.5, sick: 120, heal: 25,
      healRate: 2.5 });
    s.spawn = [-3, 70, 8];
    s.deaths = 5;
    s.damage(100, 'zombie');
    const back = new Survival();
    back.import(JSON.parse(JSON.stringify(s.export())));
    expect(back.export()).toEqual(s.export());
    expect([back.hasState, back.dead, back.fallGrace]).toEqual([true, 'zombie', true]);
    expect(back.mode).toBe('creative'); // import leaves the mode to main
  });

  it('import(null) or garbage means no survival state; bad fields fall back to fresh values', () => {
    const s = started();
    s.vitals.health = 5;
    for (const bad of [null, undefined, 3, 'x', [1, 2]]) {
      s.import(bad);
      expect(s.hasState).toBe(false);
      expect(s.vitals).toEqual(createVitals());
      expect([s.spawn, s.deaths, s.dead]).toEqual([null, 0, null]);
    }
    s.import({ health: 'x', satiation: 150, hydration: -1, temp: 20, breath: NaN, wet: 2, sick: 900, heal: 60, healRate: 9,
      spawn: [1, 2], deaths: -1, dead: 'boredom' });
    expect(s.hasState).toBe(true);
    expect(s.vitals).toEqual(createVitals());
    expect([s.spawn, s.deaths, s.dead]).toEqual([null, 0, null]);
    s.import({ spawn: [1.5, 2, 3], deaths: 2.5 });
    expect([s.spawn, s.deaths]).toEqual([null, 0]);
    s.import({ heal: 0, healRate: 2.5, spawn: [0, -5, 0], deaths: 3 });
    expect(s.vitals.healRate).toBe(0);
    expect([s.spawn, s.deaths]).toEqual([[0, -5, 0], 3]);
    s.import({});
    expect(s.hasState).toBe(true);
    expect(s.vitals).toEqual(createVitals());
  });

  it('the stillFor timer and the last temperatures are not part of the save', () => {
    const s = started();
    s.vitals.stillFor = 30;
    expect(s.export()).not.toHaveProperty('stillFor');
    expect(RATES.WAKE_HEALTH).toBe(60);
  });
});
