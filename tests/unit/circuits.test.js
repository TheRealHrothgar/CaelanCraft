// Unit tests for src/circuits.js — the circuit engine (DESIGN-circuits §4.3–§4.9, §6.2.3; package B) against a Map-backed
// fake world wired like main's hooks (tests/helpers/circuitWorld.js): the twelve worked examples of §4.14 built cell by cell
// with their named faces, Ohm's law and the solver, batteries and piles, the §4.5 connection table and diagnostics, earth,
// settling and frozen networks, every clock, fuses and the flame rule, hints, probes, overlays and the player's hands.
//
// Faces (hex.js): 0 E (+1, 0), 1 SE (0, +1), 2 SW (−1, +1), 3 W (−1, 0), 4 NW (0, −1), 5 NE (+1, −1), 6 top, 7 bottom.
// Every part stands on natural stone at y = FLOOR unless a test says otherwise.
import { describe, it, expect, vi } from 'vitest';
import {
  CIRCUIT_TICK_S, BATTERY_CAPACITY, MAX_NETWORK_CELLS, MAX_CIRCUIT_WRITES_PER_TICK, MAX_FUSE_PUFFS_PER_TICK,
  MAX_FUSE_SPARK_CELLS, MAX_BURNING_FUSES, RADIO_RANGE, MAX_CIRCUIT_OVERLAYS, CHUNK_SIZE, KEG_DIRECT_FUSE_S, BARREL_FUSE_S,
} from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { packCell } from '../../src/coords.js';
import { hexToWorld } from '../../src/hex.js';
import { Circuits, batteryUnits, formatVolts, exactVolts, repeatClosedTicks, repeatClosedSeconds } from '../../src/circuits.js';
import { CircuitStore } from '../../src/circuitStore.js';
import { makeCircuitWorld, reload, FLOOR } from '../helpers/circuitWorld.js';

const B = BLOCK;
const Y = FLOOR;
const TICKS_PER_S = Math.round(1 / CIRCUIT_TICK_S);

/** @typedef {ReturnType<typeof makeCircuitWorld>} Env */

/** @returns {number} the multimeter's volts at (q, r) */
const V = (env, q, r, y = Y) => /** @type {*} */ (env.circuits.probe(q, y, r)).volts;
/** @returns {string} probe().state */
const state = (env, q, r, y = Y) => /** @type {*} */ (env.circuits.probe(q, y, r)).state;
/** @returns {string|null} */
const hint = (env, q, r, y = Y) => env.circuits.hintFor(q, y, r);
/** Wire (or any block) along r from q0 to q1. */
function line(env, q0, q1, id = B.COPPER_WIRE, r = 0, y = Y) {
  for (let q = q0; q <= q1; q++) env.put(q, r, id, y);
}
/** A world with a battery at (0, 0), `n` copper wire cells east of it and `load` at the end. */
function run(n, load, opts = {}) {
  const env = makeCircuitWorld();
  env.put(0, 0, opts.source ?? B.VOLTAIC_BATTERY);
  line(env, 1, n);
  env.put(n + 1, 0, load);
  env.ticks(2);
  return env;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the worked examples (§4.14)', () => {
  it('1. doorbell: held for 2 s the bell rings for 2 s (+ 0.1 s) at 5.44 V; released, 6 V on the battery side, 0 V on the bell side', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, 6);
    env.put(7, 0, B.PUSH_BUTTON); // the wire comes in on its W face and leaves on its E face
    line(env, 8, 10);
    env.put(11, 0, B.ELECTRIC_BELL);
    env.ticks(2);
    expect(state(env, 11, 0)).toBe('silent');
    expect(V(env, 3, 0)).toBe(6);
    expect(V(env, 9, 0)).toBe(0);
    // Hold right-click: main presses once, then calls hold() every frame while the button stays held on the same cell.
    expect(c.interact(7, Y, 0, 'use')).toEqual({ ok: true, message: '' });
    /** @type {[string, number][]} */
    const changes = [];
    let prev = 'silent';
    const watch = () => {
      const s = state(env, 11, 0);
      if (s !== prev) changes.push([s, c.tickCount]);
      prev = s;
    };
    for (let f = 0; f < 120; f++) {
      c.hold(7, Y, 0);
      c.step(1 / 60);
      watch();
    }
    expect(prev).toBe('ringing');
    expect(V(env, 11, 0)).toBe(5.4375); // 6 − 9 × 0.0625
    expect(formatVolts(87)).toBe('5.44 V');
    expect(hint(env, 11, 0)).toBe('Electric Bell · ringing');
    for (let f = 0; f < 60; f++) {
      c.step(1 / 60);
      watch();
    }
    expect(changes.map((x) => x[0])).toEqual(['ringing', 'silent']);
    const rang = (changes[1][1] - changes[0][1]) * CIRCUIT_TICK_S;
    expect(rang).toBeGreaterThanOrEqual(2);
    expect(rang).toBeLessThanOrEqual(2.15);
    expect(V(env, 3, 0)).toBe(6);
    expect(V(env, 6, 0)).toBe(6);
    expect(V(env, 9, 0)).toBe(0);
  });

  it('2. timed charge: a 30 s pulse timer fires the igniter at 5.5 V and sets the charge off 30 s after the right-click', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY); // on the timer's W face
    env.put(1, 0, B.CLOCKWORK_TIMER);
    c.setInputFace(1, Y, 0, 1); // SE, unused
    c.applySettings(1, Y, 0, { s: 30, m: 'pulse' });
    line(env, 2, 5); // out of its E face
    env.put(6, 0, B.IGNITER);
    env.put(7, 0, B.COLLAPSAR_CHARGE);
    env.ticks(2);
    expect(hint(env, 1, 0)).toBe('Clockwork Timer · 30 s pulse · right-click: wind and start · Shift+R key: set');
    const t0 = c.tickCount;
    expect(c.interact(1, Y, 0, 'use')).toEqual({ ok: true, message: '' });
    expect(env.fx.sounds.some((s) => s.name === 'timerWind')).toBe(true);
    env.ticks(10);
    expect(hint(env, 1, 0)).toBe('Clockwork Timer · 29.5 s left · right-click: stop');
    env.ticks(30 * TICKS_PER_S - 11);
    expect(env.fx.charges).toEqual([]);
    env.ticks(1);
    expect(env.fx.charges[0]).toEqual({ q: 7, y: Y, r: 0, tick: t0 + 30 * TICKS_PER_S });
    expect(V(env, 6, 0)).toBe(5.5); // 6 − 4 × 0.125
    expect(hint(env, 6, 0)).toBe('Igniter · 5.5 V · hot!');
    expect(env.fx.sounds.some((s) => s.name === 'timerDing')).toBe(true);
    expect(env.fx.sounds.filter((s) => s.name === 'igniterPop').length).toBe(1);
    env.ticks(TICKS_PER_S + 2); // the pulse is over: idle again
    expect(state(env, 1, 0)).toBe('idle');
    expect(state(env, 6, 0)).toBe('cold');
  });

  it('3. too far: 30 cells leave the igniter 2.25 V; fix 1, a pile, gives 8.13 V and it fires', () => {
    const env = run(30, B.IGNITER);
    env.put(32, 0, B.POWDER_KEG);
    env.ticks(1);
    expect(V(env, 31, 0)).toBe(2.25);
    expect(hint(env, 31, 0)).toBe('Igniter · 2.25 V (fires at 3 V)');
    expect(env.fx.kegs).toEqual([]);
    env.put(0, 0, B.VOLTAIC_BATTERY, Y + 1); // a second battery standing on the first
    env.put(1, 0, B.COPPER_WIRE, Y + 1); // and one wire on top of (1, 0), touching the upper battery
    env.ticks(1);
    expect(V(env, 31, 0)).toBe(8.125); // 12 − 31 × 0.125
    expect(hint(env, 31, 0)).toBe('Igniter · 8.13 V · hot!');
    expect(env.fx.kegs.map((k) => [k.q, k.y, k.r])).toEqual([[32, Y, 0]]);
    expect(hint(env, 0, 0, Y + 1)).toMatch(/^Voltaic Battery · pile of 2 · 12 V · (99|100) %$/);
  });

  it('3. fix 2, a relay with its own battery (the telegraph way): the coil gets 4.75 V and the igniter 4.75 V', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, 20);
    env.put(21, 0, B.RELAY);
    c.setInputFace(21, Y, 0, 3); // W, NO
    env.put(21, 1, B.VOLTAIC_BATTERY); // on the relay's SE face
    line(env, 22, 31, B.COPPER_WIRE, -1); // out of its NE face
    env.put(32, -1, B.IGNITER);
    env.put(33, -1, B.POWDER_KEG);
    env.ticks(3);
    expect(hint(env, 21, 0)).toBe('Relay · coil 4.75 V · contacts closed (NO) · R key: push armature · Shift+R key: settings');
    expect(V(env, 32, -1)).toBe(4.75);
    expect(env.fx.kegs.map((k) => [k.q, k.r])).toEqual([[33, -1]]);
    expect(c.probe(21, Y, 0).diag).toBeNull(); // SE and NE touch neither each other nor the input's wire
  });

  it('4. quarry: the plunge gives the igniter 9 V and lights the 6 kegs around it in one tick; the refires are silent', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.BLASTING_MACHINE);
    line(env, 1, 120);
    env.put(121, 0, B.IGNITER);
    const kegs = [[122, 0, Y], [121, 1, Y], [120, 1, Y], [121, -1, Y], [122, -1, Y], [121, 0, Y + 1]];
    for (const [q, r, y] of kegs) env.put(q, r, B.POWDER_KEG, y);
    env.ticks(2);
    expect(hint(env, 0, 0)).toBe('Blasting Machine · right-click: push the plunger (24 V for 1 s)');
    expect(V(env, 121, 0)).toBe(0);
    expect(c.interact(0, Y, 0, 'use')).toEqual({ ok: true, message: '' });
    expect(env.fx.sounds.some((s) => s.name === 'plunger')).toBe(true);
    env.ticks(1);
    expect(V(env, 121, 0)).toBe(9); // 24 − 120 × 0.125
    expect(env.fx.kegs.length).toBe(6);
    expect(new Set(env.fx.kegs.map((k) => k.tick)).size).toBe(1);
    expect(env.fx.kegs.map((k) => [k.q, k.r, k.y]).sort()).toEqual(kegs.map(([q, r, y]) => [q, r, y]).sort());
    expect(env.fx.kegs.every((k) => k.fuse === undefined)).toBe(true); // explosions' default: KEG_DIRECT_FUSE_S
    env.ticks(15); // a refire every 0.5 s while the pulse lasts: the kegs answer `quiet`, nothing is said
    expect(env.fx.kegs.length).toBe(12);
    expect(env.fx.said).toEqual([]);
    expect(c.interact(0, Y, 0, 'use')).toEqual({ ok: false, message: 'the handle is still rising' });
    expect(hint(env, 0, 0)).toBe('Blasting Machine · 24 V');
    env.ticks(10); // the pulse ends after 1 s
    expect(V(env, 121, 0)).toBe(0);
    expect(hint(env, 0, 0)).toBe('Blasting Machine · handle rising…');
    expect(c.interact(0, Y, 0, 'use').message).toBe('the handle is still rising');
    env.ticks(30); // the handle rises over 1.5 s
    expect(c.interact(0, Y, 0, 'use').ok).toBe(true);
  });

  it('5. radio: from 100 cells away the pocket key on 400 m closes the receiver one tick later and the igniter fires at 5.75 V', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COHERER_RECEIVER);
    c.applySettings(1, Y, 0, { ch: 3, m: 'pulse' });
    c.setInputFace(1, Y, 0, 4); // the tapper on NW, unused
    line(env, 2, 3);
    env.put(4, 0, B.IGNITER);
    env.put(5, 0, B.POWDER_KEG);
    env.ticks(2);
    expect(hint(env, 1, 0)).toBe('Coherer Receiver · 400 m · pulse · R key: tap · Shift+R key: settings');
    const t0 = c.tickCount;
    expect(c.pocketSend(3, -99, Y + 1, 0)).toEqual({ ok: true, message: 'sent on 400 m: 1 receiver in range' });
    expect(env.fx.kegs).toEqual([]);
    env.ticks(1);
    expect(state(env, 1, 0)).toBe('closed');
    expect(V(env, 4, 0)).toBe(5.75);
    expect(env.fx.kegs).toEqual([{ q: 5, y: Y, r: 0, fuse: undefined, tick: t0 + 1 }]);
  });

  it('6. fuse and torch: 20 fuse cells burn for 8 s, the keg lights then, and the fuse is used up', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.POWDER_KEG);
    line(env, 1, 20, B.POWDER_FUSE);
    env.ticks(2);
    const t0 = env.circuits.tickCount;
    env.put(21, 0, B.TORCH);
    env.ticks(1 + 8);
    expect(env.world.getBlock(20, Y, 0)).toBe(B.AIR); // the first cell burnt out after 0.4 s
    expect(env.circuits.burningAt(19, Y, 0)).toEqual({ t: expect.any(Number), from: 0 });
    env.ticks(20 * 8 - 9);
    expect(env.fx.kegs).toEqual([]); // the last cell is still burning
    env.ticks(1);
    expect(env.fx.kegs).toEqual([{ q: 0, y: Y, r: 0, fuse: undefined, tick: t0 + 1 + 160 }]);
    expect((env.fx.kegs[0].tick - t0) * CIRCUIT_TICK_S).toBeCloseTo(8.05, 9);
    env.ticks(2);
    for (let q = 1; q <= 20; q++) expect(env.world.getBlock(q, Y, 0)).toBe(B.AIR);
    expect(env.circuits.burning.size).toBe(0);
    expect(env.circuits.spent.size).toBe(0);
  });

  it('7. dusk lamp: by day the coil holds the NC contacts open; when daylight drops below about 0.57 the lamp lights at 6 V', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.fx.daylight = 1;
    env.put(0, 0, B.SELENIUM_PANEL);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    c.setInputFace(2, Y, 0, 3); // W
    c.applySettings(2, Y, 0, { nc: true });
    env.put(3, 0, B.VOLTAIC_BATTERY); // on the relay's E face
    env.put(2, 1, B.FILAMENT_LAMP); // on its SE face; SW (1, 1) and NW (2, −1) stay empty
    env.ticks(3);
    expect(hint(env, 0, 0)).toBe('Selenium Panel · 3 V in daylight');
    expect(hint(env, 2, 0)).toBe('Relay · coil 2.94 V · contacts open (NC) · R key: push armature · Shift+R key: settings');
    expect(state(env, 2, 1)).toBe('dark');
    env.fx.daylight = 0.57;
    env.ticks(25);
    expect(state(env, 2, 1)).toBe('dark'); // 3 · 1.5 · 0.57 → 41 units; the coil 40 = 2.5 V: still pulled in
    env.fx.daylight = 0.56;
    env.ticks(25);
    expect(state(env, 2, 1)).toBe('lit');
    expect(V(env, 2, 1)).toBe(6);
    expect(hint(env, 2, 1)).toBe('Filament Lamp · 6 V · lit');
    env.fx.daylight = 0;
    env.ticks(25);
    expect(hint(env, 0, 0)).toBe('Selenium Panel · dark');
  });

  it('8. wooden house: on planks nothing is earthed; an Earth Wire run down to the ground lights the lamp at 5.94 V', () => {
    const env = makeCircuitWorld();
    const U = Y + 1; // the house floor is a layer of planks at Y
    for (const [q, r] of [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]) env.put(q, r, B.OAK_PLANKS);
    env.put(0, 0, B.VOLTAIC_BATTERY, U);
    env.put(1, 0, B.COPPER_WIRE, U);
    env.put(2, 0, B.FILAMENT_LAMP, U);
    env.ticks(2);
    const wood = 'not earthed: wood does not conduct — run an Earth Wire down to the ground';
    expect(hint(env, 0, 0, U)).toBe(`Voltaic Battery · ${wood}`);
    expect(hint(env, 2, 0, U)).toBe(`Filament Lamp · ${wood}`);
    expect(env.circuits.probe(2, U, 0)).toMatchObject({ earthed: false, earthReason: wood, state: 'dark' });
    env.put(0, 1, B.EARTH_WIRE, U); // the battery's SE face
    env.put(1, 1, B.EARTH_WIRE, U); // the lamp's SW face
    env.ticks(1);
    expect(hint(env, 1, 1, U)).toBe('Earth Wire · not grounded: run it down to soil or stone');
    expect(hint(env, 2, 0, U)).toBe('Filament Lamp · not earthed: its Earth Wire is not grounded — run it down to soil or stone');
    env.put(0, 1, B.EARTH_WIRE); // the plank under (0, 1) taken up: Earth Wire on the ground
    env.ticks(1);
    expect(hint(env, 1, 1, U)).toBe('Earth Wire · grounded');
    expect(V(env, 2, 0, U)).toBe(5.9375);
    expect(hint(env, 2, 0, U)).toBe('Filament Lamp · 5.94 V · lit');
    expect(env.circuits.probe(0, U, 0).earthed).toBe(true);
    // Digging the stone under the only grounded earth-wire cell: the lamp reads `not earthed` on the next tick.
    env.world.setBlock(0, Y - 1, 1, B.AIR);
    env.ticks(1);
    expect(state(env, 2, 0, U)).toBe('dark');
    expect(hint(env, 2, 0, U)).toBe('Filament Lamp · not earthed: its Earth Wire is not grounded — run it down to soil or stone');
  });

  it('9. three lamps on one wire (Ohm\'s law): 0.38 V, all dark; break one: 2.25 V; break another: 4.13 V', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, 30);
    for (const [q, r] of [[31, 0], [30, 1], [31, -1]]) env.put(q, r, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(V(env, 31, 0)).toBe(0.375);
    expect(hint(env, 30, 0)).toBe('Copper Wire · 0.38 V');
    for (const [q, r] of [[31, 0], [30, 1], [31, -1]]) expect(state(env, q, r)).toBe('dark');
    expect(hint(env, 31, 0)).toBe('Filament Lamp · 0.38 V (needs 1.5 V)');
    env.world.setBlock(31, Y, -1, B.AIR);
    env.ticks(1);
    expect(V(env, 31, 0)).toBe(2.25);
    expect(state(env, 31, 0)).toBe('lit');
    expect(env.circuits.rt.get(packCell(31, Y, 0)).bright).toBeCloseTo((2.25 - 1.5) / 4.5, 9);
    env.world.setBlock(30, Y, 1, B.AIR);
    env.ticks(1);
    expect(V(env, 31, 0)).toBe(4.125);
    expect(hint(env, 31, 0)).toBe('Filament Lamp · 4.13 V · lit');
  });

  it('10. two-key firing (switches in series = AND): the igniter fires at 5.5 V only when both are closed', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.KNIFE_SWITCH);
    line(env, 2, 3);
    env.put(4, 0, B.KNIFE_SWITCH);
    line(env, 5, 6);
    env.put(7, 0, B.IGNITER);
    env.put(8, 0, B.POWDER_KEG);
    env.ticks(2);
    expect(hint(env, 1, 0)).toBe('Knife Switch · open · right-click: close it');
    c.interact(1, Y, 0, 'use');
    env.ticks(2);
    expect(hint(env, 1, 0)).toBe('Knife Switch · closed · right-click: open it');
    expect(env.fx.kegs).toEqual([]);
    expect(V(env, 7, 0)).toBe(0);
    c.interact(1, Y, 0, 'use');
    c.interact(4, Y, 0, 'use');
    env.ticks(2);
    expect(env.fx.kegs).toEqual([]);
    c.interact(1, Y, 0, 'use');
    env.ticks(1);
    expect(V(env, 7, 0)).toBe(5.5);
    expect(env.fx.kegs.length).toBe(1);
    expect(env.fx.sounds.filter((s) => s.name === 'switchClack').length).toBe(4);
  });

  it('11. two doorbell buttons (in parallel = OR): either one rings the bell (5.75 V through A)', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    for (const [q, r] of [[1, 0], [2, 0], [2, 1], [2, 2], [4, 0], [4, 1], [4, 2]]) env.put(q, r, B.COPPER_WIRE);
    env.put(3, 0, B.PUSH_BUTTON); // A
    env.put(3, 2, B.PUSH_BUTTON); // B; (3, 1) stays empty
    env.put(5, 1, B.ELECTRIC_BELL);
    env.ticks(2);
    expect(state(env, 5, 1)).toBe('silent');
    expect(c.probe(3, Y, 0).diag).toBeNull();
    expect(c.probe(3, Y, 2).diag).toBeNull();
    c.interact(3, Y, 0, 'use');
    env.ticks(1);
    expect(state(env, 5, 1)).toBe('ringing');
    expect(V(env, 5, 1)).toBe(5.75);
    env.ticks(10);
    expect(state(env, 5, 1)).toBe('silent');
    c.interact(3, Y, 2, 'use');
    env.ticks(1);
    expect(state(env, 5, 1)).toBe('ringing');
    expect(V(env, 5, 1)).toBe(5.6875);
  });

  it('12. start/stop latch: Start latches the relay (lamp 5.75 V, coil 5.63 V after release); NC Stop opens it', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.RELAY);
    c.setInputFace(0, Y, 0, 3); // W, NO
    for (const [q, r] of [[-1, 0], [-1, 1], [-1, 2]]) env.put(q, r, B.BROWN_WIRE);
    env.put(-2, 1, B.FILAMENT_LAMP);
    for (const [q, r] of [[1, 0], [1, 1], [1, 2]]) env.put(q, r, B.COPPER_WIRE);
    env.put(0, 2, B.PUSH_BUTTON); // Start; (0, 1) stays empty
    env.put(2, 0, B.PUSH_BUTTON); // Stop, NC
    c.applySettings(2, Y, 0, { nc: true, l: 'Stop' });
    c.applySettings(0, Y, 2, { l: 'Start' });
    env.put(3, 0, B.VOLTAIC_BATTERY);
    env.ticks(3);
    expect(state(env, -2, 1)).toBe('dark');
    expect(hint(env, 2, 0)).toBe('Stop · Push Button (NC) · hold right-click to open');
    c.interact(0, Y, 2, 'use'); // press Start (0.3 s)
    env.ticks(1);
    expect(state(env, -2, 1)).toBe('lit');
    env.ticks(10); // Start released long since: the relay's own contacts (E to SW) hold the lamp on
    expect(state(env, 0, 2)).toBe('open');
    expect(state(env, -2, 1)).toBe('lit');
    expect(V(env, -2, 1)).toBe(5.75);
    expect(hint(env, 0, 0)).toBe('Relay · coil 5.63 V · contacts closed (NO) · R key: push armature · Shift+R key: settings');
    expect(c.probe(0, Y, 2).diag).toBeNull(); // the latch bridge passes through a contact: Start is not "bypassed"
    c.interact(2, Y, 0, 'use'); // press Stop
    env.ticks(3);
    expect(state(env, -2, 1)).toBe('dark');
    env.ticks(10);
    expect(state(env, -2, 1)).toBe('dark');
    expect(state(env, 0, 0)).toBe('released, contacts open');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the solver and Ohm\'s law (§4.4, §4.7)', () => {
  it('the first-cell rule: battery → 1 wire → lamp 5.9375 V; → igniter 5.875 V; an idle wire reads 6 V on every cell', () => {
    expect(V(run(1, B.FILAMENT_LAMP), 2, 0)).toBe(5.9375);
    expect(V(run(1, B.IGNITER), 2, 0)).toBe(5.875);
    const idle = run(12, B.STONE);
    for (let q = 1; q <= 12; q++) expect(V(idle, q, 0)).toBe(6);
    expect(idle.circuits.probe(5, Y, 0).net).toEqual({ cells: 12, sources: 1, loads: 0, partial: false, truncated: false });
  });

  it('I_net counts every attached earthed load, whatever its voltage; an unearthed one adds nothing', () => {
    const env = run(40, B.FILAMENT_LAMP);
    expect(V(env, 41, 0)).toBe(3.5); // 6 − 40 × 0.0625
    env.put(40, 1, B.FILAMENT_LAMP); // a second lamp at the end: 2 A, every cell drops 0.125 V
    env.ticks(1);
    expect(V(env, 41, 0)).toBe(1);
    expect(V(env, 40, 1)).toBe(1);
    expect(state(env, 40, 1)).toBe('dark'); // below 1.5 V and still drawing: a cold filament conducts
    expect(env.circuits.probe(20, Y, 0).net.loads).toBe(2);
    expect(env.circuits.probe(20, Y, 0).amps).toBe(2);
    env.world.setBlock(40, Y, 1, B.AIR);
    env.put(10, 1, B.OAK_PLANKS, Y); // a lamp on a plank beside the wire: not earthed, not attached
    env.put(10, 1, B.FILAMENT_LAMP, Y + 1);
    env.put(10, 0, B.COPPER_WIRE, Y + 1); // its wire, on top of (10, 0)
    env.ticks(1);
    expect(V(env, 41, 0)).toBe(3.5); // still 1 A: the lamp on the plank draws nothing
    expect(env.circuits.probe(20, Y, 0).net.loads).toBe(1);
    expect(env.circuits.probe(10, Y + 1, 1).earthed).toBe(false);
  });

  it('the reach table of §4.4, row by row: the longest run that still works, and one cell more that does not', () => {
    /** @returns {Env} source → n wires → load(s) */
    const build = (source, n, loads, opts = {}) => {
      const env = makeCircuitWorld();
      env.fx.daylight = 1;
      env.put(0, 0, source);
      if (opts.pile) {
        env.put(0, 0, B.VOLTAIC_BATTERY, Y + 1);
        for (let q = 1; q <= n; q++) env.put(q, 0, B.COPPER_WIRE, Y + 1);
        env.world.put(n + 1, Y, 0, B.STONE); // natural ground under the load
        env.put(n + 1, 0, loads[0], Y + 1);
        if (loads[0] === B.RELAY) env.circuits.setInputFace(n + 1, Y + 1, 0, 3);
      } else {
        line(env, 1, n);
        const at = [[n + 1, 0], [n, 1], [n + 1, -1]];
        loads.forEach((id, i) => {
          env.put(at[i][0], at[i][1], id);
          if (id === B.RELAY) env.circuits.setInputFace(at[i][0], Y, at[i][1], 3);
        });
      }
      env.ticks(2);
      if (source === B.BLASTING_MACHINE) {
        env.circuits.interact(0, Y, 0, 'use');
        env.ticks(1);
      }
      return env;
    };
    const works = (env, n, load, y = Y) => {
      const s = state(env, n + 1, 0, y);
      return load === B.RELAY ? s.startsWith('energised') : ['lit', 'ringing', 'hot'].includes(s);
    };
    /** [source, load(s), longest run, pile] */
    const rows = [
      [B.VOLTAIC_BATTERY, [B.FILAMENT_LAMP], 72],
      [B.VOLTAIC_BATTERY, [B.RELAY], 56],
      [B.VOLTAIC_BATTERY, [B.ELECTRIC_BELL], 56],
      [B.VOLTAIC_BATTERY, [B.IGNITER], 24],
      [B.VOLTAIC_BATTERY, [B.FILAMENT_LAMP, B.FILAMENT_LAMP, B.FILAMENT_LAMP], 24],
      [B.VOLTAIC_BATTERY, [B.IGNITER], 72, true],
      [B.BLASTING_MACHINE, [B.IGNITER], 168],
      [B.SELENIUM_PANEL, [B.RELAY], 8],
    ];
    for (const [source, loads, longest, pile] of rows) {
      const y = pile ? Y + 1 : Y;
      const label = `${source}/${loads}/${longest}${pile ? ' pile' : ''}`;
      expect(works(build(source, longest, loads, { pile }), longest, loads[0], y), label).toBe(true);
      expect(works(build(source, longest + 1, loads, { pile }), longest + 1, loads[0], y), `${label} + 1`).toBe(false);
    }
  });

  it('several sources: every cell takes the higher side; terminal boards and closed contacts drop nothing', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, 10);
    env.put(11, 0, B.VOLTAIC_BATTERY);
    env.put(11, 0, B.VOLTAIC_BATTERY, Y + 1); // a 12 V pile on the east end …
    env.put(10, 0, B.COPPER_WIRE, Y + 1); // … touching the run through one wire on top of (10, 0)
    env.put(5, 1, B.FILAMENT_LAMP); // 1 A in the middle: one unit per cell
    env.ticks(2);
    expect(V(env, 10, 0, Y + 1)).toBe(11.9375);
    expect(V(env, 10, 0)).toBe(11.875);
    expect(V(env, 1, 0)).toBe(11.875 - 9 * 0.0625); // the pile wins even at the far end
    // Boards and closed contacts are 0-cost.
    const b = makeCircuitWorld();
    b.put(0, 0, B.VOLTAIC_BATTERY);
    b.put(1, 0, B.TERMINAL_BOARD);
    b.put(2, 0, B.TERMINAL_BOARD);
    b.put(3, 0, B.KNIFE_SWITCH);
    b.circuits.switchAt(3, Y, 0, 'on');
    b.put(4, 0, B.TERMINAL_BOARD);
    b.put(5, 0, B.FILAMENT_LAMP);
    b.ticks(2);
    expect(V(b, 5, 0)).toBe(6);
    expect(V(b, 2, 0)).toBe(6);
    expect(hint(b, 2, 0)).toBe('Terminal Board · joins every wire colour · 6 V');
  });

  it('segments: wire–wire and wire–board edges share one, a closed contact keeps them apart', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, 2);
    env.put(3, 0, B.TERMINAL_BOARD);
    env.put(4, 0, B.BROWN_WIRE);
    env.put(5, 0, B.KNIFE_SWITCH);
    env.circuits.switchAt(5, Y, 0, 'on');
    line(env, 6, 7);
    env.ticks(2);
    const net = env.circuits.nodeNet.get(packCell(1, Y, 0));
    const seg = (q) => net.seg[net.idx.get(packCell(q, Y, 0))];
    expect(net).toBe(env.circuits.nodeNet.get(packCell(7, Y, 0)));
    expect(new Set([seg(1), seg(2), seg(3), seg(4)]).size).toBe(1);
    expect(seg(6)).toBe(seg(7));
    expect(seg(6)).not.toBe(seg(1));
    expect(seg(5)).not.toBe(seg(1));
    expect(seg(5)).not.toBe(seg(6));
  });

  it('a network larger than MAX_NETWORK_CELLS is truncated: the rest reads 0 V and the chat says so once', () => {
    const env = makeCircuitWorld();
    const n = MAX_NETWORK_CELLS + 10;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    line(env, 1, n);
    env.put(n + 1, 0, B.FILAMENT_LAMP);
    for (let i = 0; i < 40 && env.circuits.stats().dirty > 0; i++) env.ticks(1);
    env.ticks(3);
    expect(env.circuits.stats().dirty).toBe(0);
    expect(V(env, 1, 0)).toBeGreaterThan(0);
    expect(V(env, n, 0)).toBe(0);
    expect(state(env, n + 1, 0)).toBe('dark');
    const said = env.fx.said.filter((t) => t === `This circuit is larger than ${MAX_NETWORK_CELLS} cells; split it with relays.`);
    expect(said.length).toBe(1);
    expect(env.circuits.stats().visits).toBeLessThanOrEqual(MAX_NETWORK_CELLS + 64);
  });
});

describe('batteries and piles (§4.4)', () => {
  it('the discharge curve: 6 V down to 25 %, then falling to 4.5 V just before empty, and 0 when flat', () => {
    expect(batteryUnits(BATTERY_CAPACITY)).toBe(96);
    expect(batteryUnits(0.25 * BATTERY_CAPACITY)).toBe(96);
    expect(batteryUnits(0.25 * BATTERY_CAPACITY - 1)).toBe(95);
    expect(batteryUnits(0.125 * BATTERY_CAPACITY)).toBe(84); // 5.25 V
    expect(batteryUnits(0.001)).toBe(72); // 4.5 V just before empty
    expect(batteryUnits(0)).toBe(0);
    expect(batteryUnits(-1)).toBe(0);
    let steps = 0;
    for (let c = BATTERY_CAPACITY, last = 96; c >= 0; c -= 0.5) {
      const u = batteryUnits(c);
      if (u !== last) steps++;
      last = u;
    }
    expect(steps).toBe(25); // 24 unit steps from 6 V to 4.5 V, then flat
  });

  it('a draining battery is dirtied at each unit step and when it goes flat; a tired battery dims the lamp 0.72 → 0.39', () => {
    const env = run(20, B.FILAMENT_LAMP);
    const pc = packCell(0, Y, 0);
    const lamp = () => env.circuits.rt.get(packCell(21, Y, 0)).bright;
    expect(lamp()).toBeCloseTo(0.722, 3);
    env.store.setCharge(0, Y, 0, 0.25 * BATTERY_CAPACITY);
    const spy = vi.spyOn(env.circuits, '_markDirty');
    let seen = 0;
    let bright = [];
    for (let i = 0; i < 0.25 * BATTERY_CAPACITY / CIRCUIT_TICK_S + 10; i++) {
      env.ticks(1);
      if (env.store.get('0,11,0').c > 0) bright.push(lamp());
    }
    for (const call of spy.mock.calls) if (call[0] === pc) seen++;
    expect(seen).toBe(25);
    expect(Math.min(...bright)).toBeCloseTo(0.389, 3);
    expect(hint(env, 0, 0)).toBe('Voltaic Battery · flat');
    expect(state(env, 21, 0)).toBe('dark');
    expect(state(env, 0, 0)).toBe('flat');
  });

  it('the battery hint: volts and percent, (tired) below the knee, flat, and refill', () => {
    const env = run(1, B.FILAMENT_LAMP);
    expect(hint(env, 0, 0)).toMatch(/^Voltaic Battery · 6 V · (99|100) %$/);
    env.store.setCharge(0, Y, 0, 0.87 * BATTERY_CAPACITY + 1);
    env.circuits.applySettings(0, Y, 0, { l: '' });
    expect(hint(env, 0, 0)).toBe('Voltaic Battery · 6 V · 87 %');
    env.store.setCharge(0, Y, 0, 450);
    env.circuits.refresh?.();
    expect(hint(env, 0, 0)).toBe('Voltaic Battery · 5.25 V · 12 % (tired)');
    env.store.setCharge(0, Y, 0, 0);
    expect(hint(env, 0, 0)).toBe('Voltaic Battery · flat');
    expect(env.circuits.refill(0, Y, 0)).toBe(true);
    expect(env.circuits.refill(1, Y, 0)).toBe(false);
    expect(hint(env, 0, 0)).toBe('Voltaic Battery · 6 V · 100 %');
    env.ticks(1);
    expect(state(env, 2, 0)).toBe('lit');
  });

  it('the drain is split among the sources that give the highest voltage; selenium and the blaster never drain', () => {
    // Two batteries side by side on one wire: parallel, each pays half.
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(0, 1, B.VOLTAIC_BATTERY); // its NE face touches the wire too
    line(env, 1, 3);
    env.put(4, 0, B.FILAMENT_LAMP);
    env.ticks(1);
    env.ticks(100);
    const c0 = env.store.get('0,11,0').c;
    const c1 = env.store.get('0,11,1').c;
    expect(c0).toBeCloseTo(BATTERY_CAPACITY - 0.5 * 101 * CIRCUIT_TICK_S, 6);
    expect(c1).toBeCloseTo(c0, 9);
    // A pile (12 V) and a single battery (6 V) on one network: only the pile pays, each of its cells the whole share.
    const p = makeCircuitWorld();
    p.put(0, 0, B.VOLTAIC_BATTERY);
    p.put(0, 0, B.VOLTAIC_BATTERY, Y + 1);
    p.put(1, 0, B.COPPER_WIRE, Y + 1);
    line(p, 1, 3);
    p.put(4, 0, B.VOLTAIC_BATTERY, Y + 1); // a lone battery beside the run's top
    p.put(4, 0, B.STONE);
    p.put(3, 0, B.COPPER_WIRE, Y + 1);
    p.put(3, 1, B.FILAMENT_LAMP);
    p.ticks(101);
    expect(p.store.get('0,12,0').c).toBeCloseTo(BATTERY_CAPACITY - 101 * CIRCUIT_TICK_S, 6);
    expect(p.store.get('0,11,0').c).toBeCloseTo(BATTERY_CAPACITY - 101 * CIRCUIT_TICK_S, 6);
    expect(p.store.get('4,12,0')?.c ?? BATTERY_CAPACITY).toBe(BATTERY_CAPACITY);
    // The blasting machine's pulse is the highest voltage: nothing drains while it lasts.
    const m = makeCircuitWorld();
    m.put(0, 0, B.VOLTAIC_BATTERY);
    line(m, 1, 3);
    m.put(4, 0, B.FILAMENT_LAMP);
    m.put(1, 1, B.BLASTING_MACHINE); // on (1, 0)'s SE face (and (2, 0)'s SW face)
    m.ticks(1);
    const before = m.store.get('0,11,0')?.c ?? BATTERY_CAPACITY;
    m.circuits.interact(1, Y, 1, 'use');
    m.ticks(15);
    expect(m.store.get('0,11,0')?.c ?? BATTERY_CAPACITY).toBe(before);
    expect(V(m, 4, 0)).toBe(24 - 2 * 0.0625); // the machine touches (1, 0) and (2, 0)
  });

  it('piles: 2 high = 12 V; only the bottom needs earth; a flat bottom kills it; a fifth is inert; a load at height 2 drains both', () => {
    const env = makeCircuitWorld();
    for (let k = 0; k < 5; k++) env.put(0, 0, B.VOLTAIC_BATTERY, Y + k);
    env.ticks(1);
    expect(hint(env, 0, 0, Y)).toBe('Voltaic Battery · pile of 4 · 6 V · 100 %');
    expect(hint(env, 0, 0, Y + 1)).toBe('Voltaic Battery · pile of 4 · 12 V · 100 %');
    expect(hint(env, 0, 0, Y + 3)).toBe('Voltaic Battery · pile of 4 · 24 V · 100 %');
    expect(hint(env, 0, 0, Y + 4)).toBe('Voltaic Battery · pile too tall (4 at most)');
    expect(V(env, 0, 0, Y + 3)).toBe(24);
    expect(V(env, 0, 0, Y + 4)).toBe(0);
    expect(env.circuits.probe(0, Y + 2, 0).earthed).toBe(true); // the bottom's earth
    env.store.setCharge(0, Y, 0, 0);
    env.circuits.applySettings(0, Y, 0, { l: 'bottom' });
    env.ticks(1);
    expect(hint(env, 0, 0, Y + 1)).toBe('Voltaic Battery · pile of 4 · 0 V: a battery below it is flat');
    expect(V(env, 0, 0, Y + 2)).toBe(0);
    // A pile on planks: the bottom's reason for both.
    const w = makeCircuitWorld();
    w.put(0, 0, B.OAK_PLANKS);
    w.put(0, 0, B.VOLTAIC_BATTERY, Y + 1);
    w.put(0, 0, B.VOLTAIC_BATTERY, Y + 2);
    expect(hint(w, 0, 0, Y + 2)).toBe('Voltaic Battery · not earthed: wood does not conduct — run an Earth Wire down to the ground');
    // A load fed at height 2 drains both.
    const d = makeCircuitWorld();
    d.put(0, 0, B.VOLTAIC_BATTERY);
    d.put(0, 0, B.VOLTAIC_BATTERY, Y + 1);
    d.put(1, 0, B.COPPER_WIRE, Y + 1);
    d.world.put(2, Y, 0, B.STONE);
    d.put(2, 0, B.FILAMENT_LAMP, Y + 1);
    d.ticks(41);
    expect(V(d, 2, 0, Y + 1)).toBe(11.9375);
    expect(d.store.get('0,11,0').c).toBeCloseTo(BATTERY_CAPACITY - 41 * CIRCUIT_TICK_S, 6);
    expect(d.store.get('0,12,0').c).toBeCloseTo(BATTERY_CAPACITY - 41 * CIRCUIT_TICK_S, 6);
  });

  it('store.version bumps only on whole percents; nothing drains while its chunk is unloaded or its network frozen', () => {
    const env = run(1, B.FILAMENT_LAMP); // 2 ticks: 100 % → 99 % already
    const v0 = env.store.version;
    env.ticks(700); // 1 A for 35 s: 35.1 amp-seconds in all, still 99 % (1 % is 36)
    expect(env.store.version).toBe(v0);
    env.ticks(40);
    expect(env.store.version - v0).toBe(1);
    // Unloaded: a battery in chunk (−1, 0) feeding a lamp in chunk (0, 0).
    const u = makeCircuitWorld();
    u.put(-1, 0, B.VOLTAIC_BATTERY);
    u.put(0, 0, B.COPPER_WIRE);
    u.put(1, 0, B.FILAMENT_LAMP);
    u.ticks(5);
    const c = u.store.get('-1,11,0').c;
    expect(c).toBeLessThan(BATTERY_CAPACITY);
    u.world.unload(-1, 0);
    u.ticks(60);
    expect(u.store.get('-1,11,0').c).toBe(c);
    expect(u.circuits.stats().frozen).toBe(1);
  });
});

describe('connections on the hex (§4.5)', () => {
  /** battery → a → b → lamp, all in a row: the lamp's volts tell whether a and b joined */
  const pair = (a, b) => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, a);
    env.put(2, 0, b);
    if (a === B.KNIFE_SWITCH) env.circuits.switchAt(1, Y, 0, 'on');
    if (b === B.KNIFE_SWITCH) env.circuits.switchAt(2, Y, 0, 'on');
    env.put(3, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    return V(env, 3, 0) > 0;
  };

  it('wires join the same kind only; a terminal board joins every colour; a closed contact joins any wire; earth wire never', () => {
    expect(pair(B.COPPER_WIRE, B.COPPER_WIRE)).toBe(true);
    expect(pair(B.BROWN_WIRE, B.BROWN_WIRE)).toBe(true);
    expect(pair(B.COPPER_WIRE, B.BROWN_WIRE)).toBe(false);
    expect(pair(B.BROWN_WIRE, B.WHITE_WIRE)).toBe(false);
    expect(pair(B.WHITE_WIRE, B.TERMINAL_BOARD)).toBe(true);
    expect(pair(B.TERMINAL_BOARD, B.BROWN_WIRE)).toBe(true);
    expect(pair(B.KNIFE_SWITCH, B.WHITE_WIRE)).toBe(true);
    expect(pair(B.BROWN_WIRE, B.KNIFE_SWITCH)).toBe(true);
    expect(pair(B.EARTH_WIRE, B.EARTH_WIRE)).toBe(false);
    expect(pair(B.COPPER_WIRE, B.EARTH_WIRE)).toBe(false);
  });

  it('an open contact is no conductor; a contact never joins through its input face', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.KNIFE_SWITCH);
    env.put(3, 0, B.COPPER_WIRE);
    env.put(4, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(V(env, 4, 0)).toBe(0);
    // A relay pushed by hand is closed, but its input face (W, toward the battery side) is never a contact terminal.
    const r = makeCircuitWorld();
    r.put(0, 0, B.VOLTAIC_BATTERY);
    r.put(1, 0, B.COPPER_WIRE);
    r.put(2, 0, B.RELAY);
    r.circuits.setInputFace(2, Y, 0, 3);
    r.put(3, 0, B.COPPER_WIRE);
    r.put(4, 0, B.FILAMENT_LAMP);
    r.ticks(2);
    expect(state(r, 2, 0).startsWith('energised')).toBe(true); // its coil is on the battery side
    expect(V(r, 4, 0)).toBe(0); // and its contacts reach the far wire only
    r.circuits.setInputFace(2, Y, 0, 1); // the coil now faces SE (nothing there): W and E are both contact faces
    r.circuits.interact(2, Y, 0, 'r'); // push the armature by hand
    r.ticks(1);
    expect(V(r, 4, 0)).toBe(5.875);
  });

  it('devices never join directly: a lamp set against a battery reads 0 V and says to use a wire', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(V(env, 1, 0)).toBe(0);
    expect(env.circuits.probe(1, Y, 0).diag).toBe('no-wire');
    expect(hint(env, 1, 0)).toBe('Filament Lamp · 0 V: join it to the battery with a wire');
    env.put(1, 1, B.COPPER_WIRE); // touches both (SE of the lamp, the battery's … no: SE of (0, 0) is (0, 1))
    env.put(0, 1, B.COPPER_WIRE); // the battery's SE face; it joins (1, 1)
    env.ticks(1);
    expect(env.circuits.probe(1, Y, 0).diag).toBeNull();
    expect(state(env, 1, 0)).toBe('lit');
  });
});

describe('diagnostics (§4.5)', () => {
  /** battery → wire (1, 0) → knife switch (2, 0) → wire out of `out` → … → lamp */
  const switchScene = (out) => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.KNIFE_SWITCH);
    for (const [q, r] of out) env.put(q, r, B.COPPER_WIRE);
    return env;
  };

  it('a knife switch fed on W and leaving on SW is bypassed (the two wires touch); leaving on E it is not', () => {
    const sw = switchScene([[1, 1], [1, 2]]);
    sw.put(1, 3, B.FILAMENT_LAMP);
    sw.ticks(2);
    expect(sw.circuits.probe(2, Y, 0).diag).toBe('bypassed');
    expect(hint(sw, 2, 0)).toBe('Knife Switch · bypassed: the wires on either side touch — run them out of opposite faces, or use brown on one side and white on the other');
    expect(state(sw, 1, 3)).toBe('lit'); // the switch does nothing
    const e = switchScene([[3, 0], [4, 0]]);
    e.put(5, 0, B.FILAMENT_LAMP);
    e.ticks(2);
    expect(e.circuits.probe(2, Y, 0).diag).toBeNull();
    expect(state(e, 5, 0)).toBe('dark');
    // Brown on one side and white on the other: they touch but do not join, so the switch is not bypassed.
    const c = makeCircuitWorld();
    c.put(0, 0, B.VOLTAIC_BATTERY);
    c.put(1, 0, B.BROWN_WIRE);
    c.put(2, 0, B.KNIFE_SWITCH);
    c.put(1, 1, B.WHITE_WIRE);
    c.put(1, 2, B.FILAMENT_LAMP);
    c.ticks(2);
    expect(c.circuits.probe(2, Y, 0).diag).toBeNull();
    expect(state(c, 1, 2)).toBe('dark');
    c.circuits.switchAt(2, Y, 0, 'on');
    c.ticks(1);
    expect(state(c, 1, 2)).toBe('lit');
  });

  it('a battery beside the switch that also touches the far wire bypasses it', () => {
    const env = makeCircuitWorld();
    env.put(2, 0, B.KNIFE_SWITCH);
    env.put(3, -1, B.VOLTAIC_BATTERY); // on the switch's NE face …
    env.put(3, 0, B.COPPER_WIRE); // … and touching the wire out of its E face
    env.put(4, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(env.circuits.probe(2, Y, 0).diag).toBe('bypassed');
  });

  it('a relay whose battery sits on the face next to its input is self-fed', () => {
    const env = makeCircuitWorld();
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    env.circuits.setInputFace(2, Y, 0, 3); // W
    env.put(2, -1, B.VOLTAIC_BATTERY); // its NW face: it touches the input's wire as well
    env.put(3, 0, B.COPPER_WIRE);
    env.put(4, 0, B.FILAMENT_LAMP);
    env.ticks(3);
    expect(env.circuits.probe(2, Y, 0).diag).toBe('self-fed');
    expect(hint(env, 2, 0)).toBe('Relay · its own battery feeds the coil — move the battery away from the input face');
  });
});

describe('earth (§4.4)', () => {
  it('insulators below a device give their reason; nothing below, too', () => {
    for (const [id, reason] of [
      [B.GLASS, 'not earthed: glass does not conduct — run an Earth Wire down to the ground'],
      [B.WOOL_WHITE, 'not earthed: white wool does not conduct — run an Earth Wire down to the ground'],
      [B.OBSIDIAN, 'not earthed: obsidian does not conduct — run an Earth Wire down to the ground'],
      [B.SPRUCE_LOG, 'not earthed: wood does not conduct — run an Earth Wire down to the ground'],
      [B.TERMINAL_BOARD, 'not earthed: a Terminal Board does not conduct — run an Earth Wire down to the ground'],
    ]) {
      const env = makeCircuitWorld();
      env.put(0, 0, id);
      env.put(0, 0, B.FILAMENT_LAMP, Y + 1);
      expect(env.circuits.probe(0, Y + 1, 0).earthReason, String(id)).toBe(reason);
    }
    const air = makeCircuitWorld();
    air.put(0, 0, B.FILAMENT_LAMP, Y + 5);
    expect(air.circuits.probe(0, Y + 5, 0).earthReason).toBe('not earthed: it stands on nothing that conducts — set it on soil or stone');
    // Natural water and metal blocks on the ground conduct.
    const wet = makeCircuitWorld();
    wet.world.put(0, Y, 0, B.WATER);
    wet.put(0, 0, B.FILAMENT_LAMP, Y + 1);
    expect(wet.circuits.probe(0, Y + 1, 0).earthed).toBe(true);
  });

  it('the walk: placed dirt on a sky platform is not the ground; 3 placed stones on natural ground are; 9 are not; y 0 is', () => {
    const sky = makeCircuitWorld();
    sky.put(0, 0, B.DIRT, 40);
    sky.put(0, 0, B.FILAMENT_LAMP, 41);
    expect(sky.circuits.probe(0, 41, 0).earthReason).toBe('not earthed: this dirt is not connected to the ground');
    const tower = (n) => {
      const env = makeCircuitWorld();
      for (let k = 0; k < n; k++) env.put(0, 0, B.STONE, Y + k);
      env.put(0, 0, B.FILAMENT_LAMP, Y + n);
      return env.circuits.probe(0, Y + n, 0);
    };
    expect(tower(3).earthed).toBe(true);
    expect(tower(8).earthed).toBe(true);
    expect(tower(9).earthed).toBe(false);
    expect(tower(9).earthReason).toBe('not earthed: this stone is not connected to the ground');
    const bottom = makeCircuitWorld();
    bottom.put(0, 0, B.FILAMENT_LAMP, 0);
    expect(bottom.circuits.probe(0, 0, 0).earthed).toBe(true);
  });

  it('a ground strap on a side face is an earth terminal, and it never joins the signal wire beside it', () => {
    const env = makeCircuitWorld();
    const U = Y + 1;
    for (const [q, r] of [[0, 0], [1, 0], [2, 0], [2, -1], [3, 0]]) env.put(q, r, B.OAK_PLANKS);
    env.put(0, 0, B.VOLTAIC_BATTERY, U);
    env.put(1, 0, B.COPPER_WIRE, U);
    env.put(2, 0, B.FILAMENT_LAMP, U);
    env.put(2, -1, B.EARTH_WIRE, U); // the lamp's NW face; it also touches the copper wire (1, 0) and the battery? no
    env.put(2, -1, B.EARTH_WIRE); // down through the floor …
    env.put(0, -1, B.EARTH_WIRE, U); // and the battery's NW face …
    env.put(1, -1, B.EARTH_WIRE, U); // … joined to it
    env.ticks(2);
    expect(hint(env, 2, -1, U)).toBe('Earth Wire · grounded');
    expect(env.circuits.probe(2, U, 0).earthed).toBe(true);
    expect(V(env, 2, 0, U)).toBe(5.9375);
    expect(V(env, 1, 0, U)).toBe(5.9375); // the copper wire touching the earth wire is not shorted or joined to it
    expect(env.circuits.probe(1, U, 0).net.cells).toBe(1);
    expect(env.circuits.geometryView().grounded(2, Y, -1)).toBe(true);
    expect(env.circuits.geometryView().grounded(2, U, -1)).toBe(false);
  });
});

describe('settling: loading never fires anything (§4.7)', () => {
  /** A dead-man circuit: battery A → wire → NC relay (input W) holding battery B → wire → igniter → keg off. */
  const deadMan = (env, q0) => {
    const c = env.circuits;
    env.put(q0, 0, B.VOLTAIC_BATTERY); // A
    env.put(q0 + 1, 0, B.COPPER_WIRE);
    env.put(q0 + 2, 0, B.RELAY);
    c.setInputFace(q0 + 2, Y, 0, 3);
    c.applySettings(q0 + 2, Y, 0, { nc: true });
    env.ticks(3); // the coil pulls in before the contact side exists
    env.put(q0 + 2, 1, B.VOLTAIC_BATTERY); // B, on the relay's SE face
    env.put(q0 + 3, -1, B.COPPER_WIRE); // out of its NE face
    env.put(q0 + 4, -1, B.IGNITER);
    env.put(q0 + 5, -1, B.POWDER_KEG);
    env.ticks(3);
  };

  it('a reloaded world holding an energised NC relay guarding battery → igniter → keg does not light the keg', () => {
    const env = makeCircuitWorld();
    deadMan(env, 0);
    expect(env.fx.kegs).toEqual([]);
    expect(state(env, 4, -1)).toBe('cold');
    const next = reload(env);
    next.ticks(60);
    expect(next.fx.kegs).toEqual([]);
    expect(state(next, 2, 0)).toBe('energised, contacts open');
    // And it still works: cutting the coil's wire fires the igniter one tick after the relay drops.
    next.world.setBlock(1, Y, 0, B.AIR);
    next.ticks(3);
    expect(next.fx.kegs.length).toBe(1);
  });

  it('the same with the coil\'s battery in a chunk that loads later: frozen until it loads, then settled', () => {
    const env = makeCircuitWorld();
    deadMan(env, -1); // battery A at (−1, 0) in chunk (−1, 0); the rest in chunk (0, 0)
    expect(env.fx.kegs).toEqual([]);
    env.world.unload(-1, 0);
    const next = reload(env);
    next.ticks(60);
    expect(next.fx.kegs).toEqual([]);
    expect(next.circuits.stats().frozen).toBeGreaterThanOrEqual(1);
    next.world.load(-1, 0);
    next.ticks(60);
    expect(next.fx.kegs).toEqual([]);
    expect(state(next, 1, 0)).toBe('energised, contacts open');
    expect(next.circuits.stats().frozen).toBe(0);
  });

  it('a dusk circuit loaded at noon does not flash its lamp', () => {
    const env = makeCircuitWorld();
    env.fx.daylight = 1;
    env.put(0, 0, B.SELENIUM_PANEL);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    env.circuits.setInputFace(2, Y, 0, 3);
    env.circuits.applySettings(2, Y, 0, { nc: true });
    env.put(3, 0, B.VOLTAIC_BATTERY);
    env.put(2, 1, B.FILAMENT_LAMP);
    env.ticks(5);
    const next = reload(env);
    for (let i = 0; i < 30; i++) {
      next.ticks(1);
      expect(state(next, 2, 1)).toBe('dark');
    }
  });

  it('a network that gains an unloaded cell freezes (no edges, no drain) and is solved settling when it loads again', () => {
    const env = makeCircuitWorld();
    env.put(-1, 0, B.COPPER_WIRE); // a branch into chunk (−1, 0)
    env.put(0, 0, B.COPPER_WIRE);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(1, 1, B.IGNITER); // on (1, 0)'s SE face
    env.put(2, 1, B.POWDER_KEG);
    env.ticks(2);
    env.world.unload(-1, 0);
    env.ticks(20); // the unload check
    expect(env.circuits.stats().frozen).toBe(1);
    env.put(2, 0, B.VOLTAIC_BATTERY); // a source joins the frozen network: it keeps its last voltages, no edge
    env.ticks(30);
    expect(env.fx.kegs).toEqual([]);
    expect(V(env, 1, 1)).toBe(0);
    expect(env.store.get('2,11,0')?.c ?? BATTERY_CAPACITY).toBe(BATTERY_CAPACITY);
    env.world.load(-1, 0);
    env.ticks(1);
    expect(env.circuits.stats().frozen).toBe(0);
    expect(V(env, 1, 1)).toBe(5.875);
    expect(env.fx.kegs).toEqual([]); // settling: no edge on the tick it loads …
    env.ticks(10);
    expect(env.fx.kegs.length).toBe(1); // … the refire clock started from 0 and fires 0.5 s later
  });

  it('an earth net that becomes grounded when its chunk loads earths an igniter without firing it', () => {
    const env = makeCircuitWorld();
    const U = Y + 1;
    env.put(2, 0, B.VOLTAIC_BATTERY); // on the natural ground
    env.put(3, 0, B.COPPER_WIRE);
    env.put(3, 0, B.COPPER_WIRE, U);
    env.put(4, 0, B.GLASS);
    env.put(4, 0, B.IGNITER, U); // on glass: earthed only by its strap
    env.put(5, 0, B.POWDER_KEG, U);
    for (let q = -1; q <= 4; q++) env.put(q, -1, B.EARTH_WIRE, U); // the strap on its NW face, west into chunk (−1, −1) …
    env.put(-1, -1, B.EARTH_WIRE); // … and down to the ground there
    env.ticks(2);
    expect(env.fx.kegs.length).toBe(1); // it works: earthed through the strap
    env.fx.burningKegs.clear();
    env.world.unload(-1, -1);
    const next = reload(env);
    next.ticks(5);
    expect(next.circuits.probe(4, U, 0).earthed).toBe(false); // the grounded cell is away
    next.world.load(-1, -1);
    next.ticks(1);
    expect(next.circuits.probe(4, U, 0).earthed).toBe(true);
    expect(state(next, 4, 0, U)).toBe('hot');
    expect(next.fx.kegs).toEqual([]); // loading never fires anything
  });
});

describe('ticks and clocks (§4.6, §4.7)', () => {
  it('a relay\'s contacts follow its coil exactly one tick (50 ms) later', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.KNIFE_SWITCH);
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.RELAY);
    c.setInputFace(3, Y, 0, 3);
    env.put(3, 1, B.VOLTAIC_BATTERY);
    env.put(4, -1, B.COPPER_WIRE);
    env.put(5, -1, B.FILAMENT_LAMP);
    env.ticks(2);
    c.switchAt(1, Y, 0, 'on');
    env.ticks(1);
    expect(state(env, 3, 0)).toBe('energised, contacts open');
    expect(state(env, 5, -1)).toBe('dark');
    expect(c.stats().scheduled).toBe(1);
    env.ticks(1);
    expect(state(env, 3, 0)).toBe('energised, contacts closed');
    expect(state(env, 5, -1)).toBe('lit');
    expect(env.fx.sounds.some((s) => s.name === 'relayClick')).toBe(true);
  });

  it('a relay wired to its own coil buzzes: it toggles every tick', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    c.setInputFace(2, Y, 0, 0); // E
    c.applySettings(2, Y, 0, { nc: true });
    env.put(3, -1, B.COPPER_WIRE); // out of its NE face …
    env.put(3, 0, B.COPPER_WIRE); // … into its own input
    env.ticks(3);
    const seen = [];
    for (let i = 0; i < 8; i++) {
      env.ticks(1);
      seen.push(state(env, 2, 0).endsWith('closed'));
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(!seen[i - 1]);
  });

  it('the R key pushes a relay\'s armature: 0.5 s on a press, as long as it is held (+ 0.1 s)', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(2, 0, B.RELAY); // nothing on its coil
    c.setInputFace(2, Y, 0, 1);
    env.put(1, 0, B.VOLTAIC_BATTERY);
    env.put(3, 0, B.COPPER_WIRE);
    env.put(4, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(c.interact(2, Y, 0, 'use')).toBeNull(); // right-click does not operate a relay
    expect(c.interact(2, Y, 0, 'r')).toEqual({ ok: true, message: '' });
    let lit = 0;
    for (let i = 0; i < 30; i++) {
      env.ticks(1);
      if (state(env, 4, 0) === 'lit') lit++;
    }
    expect(lit).toBe(10);
    c.interact(2, Y, 0, 'r');
    let held = 0;
    for (let f = 0; f < 120; f++) {
      c.hold(2, Y, 0);
      c.step(1 / 60);
      if (state(env, 4, 0) === 'lit') held++;
    }
    expect(held).toBeGreaterThanOrEqual(117); // from the first tick after the press
    env.ticks(3);
    expect(state(env, 4, 0)).toBe('dark');
  });

  it('radio arrives on the next tick, on the same wavelength only, within RADIO_RANGE', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    const rx = [[0, 0, 3], [10, 0, 4], [170, 0, 3], [0, 200, 3]];
    for (const [q, r, ch] of rx) {
      env.put(q, r, B.COHERER_RECEIVER);
      c.applySettings(q, Y, r, { ch });
    }
    env.ticks(2);
    const [x, z] = hexToWorld(0, 0);
    expect(c.radio('400m', x, Y + 1, z)).toEqual({ ok: true, message: 'sent on 400 m: 1 receiver in range' });
    expect(state(env, 0, 0)).toBe('open');
    env.ticks(1);
    expect(state(env, 0, 0)).toBe('closed');
    expect(state(env, 10, 0)).toBe('open');
    expect(state(env, 170, 0)).toBe('open');
    expect(state(env, 0, 200)).toBe('open');
    expect(c.radio(3, x, Y + 1, z + 100).message).toBe('sent on 400 m: 2 receivers in range'); // (0, 200) is ~124 away
    expect(c.radio(99, 0, 0, 0)).toEqual({ ok: false, message: 'expected a channel 1–16 or a wavelength 300m–1050m, got "99"' });
    expect(Math.hypot(...hexToWorld(170, 0)) > RADIO_RANGE).toBe(true);
  });

  it('a transmitter sends on a rising edge of its live face (once per tick), and by hand', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.PUSH_BUTTON);
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.SPARK_TRANSMITTER);
    c.applySettings(3, Y, 0, { ch: 7 });
    env.put(30, 0, B.COHERER_RECEIVER);
    c.applySettings(30, Y, 0, { ch: 7 });
    env.ticks(2);
    expect(hint(env, 3, 0)).toBe('Spark Transmitter · 600 m (distress) · right-click: send · Shift+R key: wavelength');
    c.interact(1, Y, 0, 'use');
    env.ticks(1);
    expect(state(env, 3, 0)).toBe('sending');
    env.ticks(1);
    expect(state(env, 30, 0)).toBe('closed');
    expect(env.fx.sounds.filter((s) => s.name === 'sparkZap').length).toBe(1);
    env.ticks(30);
    expect(state(env, 30, 0)).toBe('open');
    expect(c.interact(3, Y, 0, 'use')).toEqual({ ok: true, message: 'sent on 600 m: 1 receiver in range', channel: 7 });
    expect(c.interact(3, Y, 0, 'use').message).toBe('sent on 600 m: 1 receiver in range');
    expect(env.fx.sounds.filter((s) => s.name === 'sparkZap').length).toBe(2); // once per tick
  });

  it('timer pulse: closed for 1 s after the delay; a rising edge on its input starts it; R stops it', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    c.setInputFace(1, Y, 0, 6); // its start input on top
    c.applySettings(1, Y, 0, { s: 1 });
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.FILAMENT_LAMP);
    env.put(1, 0, B.COPPER_WIRE, Y + 1); // on the timer's top face …
    env.put(0, 0, B.PUSH_BUTTON, Y + 1); // … fed by a start button standing on the battery
    env.ticks(2);
    c.interact(0, Y + 1, 0, 'use');
    const lit = [];
    for (let i = 0; i < 60; i++) {
      env.ticks(1);
      lit.push(state(env, 3, 0) === 'lit' ? 1 : 0);
    }
    expect(lit.indexOf(1)).toBe(20); // the rising edge at tick 1 starts it; 1 s later it closes
    expect(lit.reduce((a, b) => a + b, 0)).toBe(TICKS_PER_S);
    c.interact(1, Y, 0, 'r');
    env.ticks(10);
    expect(c.interact(1, Y, 0, 'r')).toEqual({ ok: true, message: '' }); // stop
    env.ticks(40);
    expect(state(env, 3, 0)).toBe('dark');
    expect(state(env, 1, 0)).toBe('idle');
  });

  it('timer hold: closed until reset, `on` saved; repeat at 0.5 s gives exactly one rising edge every 10 ticks; at 1 s 0.5 / 0.5', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    c.setInputFace(1, Y, 0, 1); // SE: W is a contact face, fed by the battery
    c.applySettings(1, Y, 0, { s: 0.5, m: 'hold' });
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.FILAMENT_LAMP);
    env.ticks(1);
    c.timerAt(1, Y, 0, 'start');
    env.ticks(11);
    expect(state(env, 3, 0)).toBe('lit');
    expect(hint(env, 1, 0)).toBe('Clockwork Timer · holding · right-click: reset');
    expect(env.store.export()['1,11,0']).toEqual({ k: 'timer', on: true, f: 1, s: 0.5, m: 'hold' });
    env.ticks(100);
    expect(state(env, 3, 0)).toBe('lit');
    c.interact(1, Y, 0, 'use');
    env.ticks(1);
    expect(state(env, 3, 0)).toBe('dark');
    expect(env.store.export()['1,11,0']).toEqual({ k: 'timer', f: 1, s: 0.5, m: 'hold' });
    // Repeat: a clock.
    const edges = (s) => {
      c.timerAt(1, Y, 0, s, 'repeat');
      c.timerAt(1, Y, 0, 'start');
      expect(env.store.export()['1,11,0']).toMatchObject({ m: 'repeat', run: true });
      const ticksLit = [];
      let prev = state(env, 3, 0) === 'lit';
      for (let i = 0; i < 200; i++) {
        env.ticks(1);
        const now = state(env, 3, 0) === 'lit';
        if (now && !prev) ticksLit.push(c.tickCount);
        prev = now;
      }
      c.timerAt(1, Y, 0, 'stop');
      expect(env.store.export()['1,11,0'].run).toBeUndefined();
      return ticksLit;
    };
    const e05 = edges(0.5);
    for (let i = 1; i < e05.length; i++) expect(e05[i] - e05[i - 1]).toBe(10);
    expect(e05.length).toBeGreaterThanOrEqual(18);
    const e1 = edges(1);
    for (let i = 1; i < e1.length; i++) expect(e1[i] - e1[i - 1]).toBe(20);
    expect(repeatClosedTicks(20)).toBe(10);
    expect(repeatClosedSeconds(1)).toBe(0.5);
    expect(repeatClosedSeconds(0.5)).toBe(0.25);
    expect(repeatClosedSeconds(10)).toBe(1);
  });

  it('a repeat clock restarts on load (`run` is saved); a hold latch comes back closed', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    c.applySettings(1, Y, 0, { s: 1, m: 'repeat', f: 1 });
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.FILAMENT_LAMP);
    env.put(0, 3, B.VOLTAIC_BATTERY);
    env.put(1, 3, B.CLOCKWORK_TIMER);
    c.applySettings(1, Y, 3, { s: 0.5, m: 'hold', f: 1 });
    env.put(2, 3, B.COPPER_WIRE);
    env.put(3, 3, B.FILAMENT_LAMP);
    c.interact(1, Y, 0, 'use');
    c.interact(1, Y, 3, 'use');
    env.ticks(15);
    const store = new CircuitStore();
    store.replaceAll(env.store.export());
    const next = reload({ ...env, store });
    next.ticks(1);
    expect(state(next, 3, 3)).toBe('lit');
    let edges = 0;
    let prev = false;
    for (let i = 0; i < 60; i++) {
      next.ticks(1);
      const now = state(next, 3, 0) === 'lit';
      if (now && !prev) edges++;
      prev = now;
    }
    expect(edges).toBe(3);
  });

  it('a push button: a click gives 0.3 s; NC inverts it', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.PUSH_BUTTON);
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.FILAMENT_LAMP);
    env.ticks(2);
    c.interact(1, Y, 0, 'use');
    let lit = 0;
    for (let i = 0; i < 20; i++) {
      env.ticks(1);
      if (state(env, 3, 0) === 'lit') lit++;
    }
    expect(lit).toBe(6);
    c.applySettings(1, Y, 0, { nc: true });
    env.ticks(1);
    expect(state(env, 3, 0)).toBe('lit');
    expect(hint(env, 1, 0)).toBe('Push Button (NC) · hold right-click to open');
    c.switchAt(1, Y, 0, 'press');
    let dark = 0;
    for (let i = 0; i < 20; i++) {
      env.ticks(1);
      if (state(env, 3, 0) === 'dark') dark++;
    }
    expect(dark).toBe(6);
  });

  it('the coherer: pulse mode taps itself open after 1 s; latch mode stays closed through a second wave and opens on a tap', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.COHERER_RECEIVER);
    env.ticks(1);
    c.radio(1, 0, Y, 0);
    let closed = 0;
    for (let i = 0; i < 40; i++) {
      env.ticks(1);
      if (state(env, 0, 0) === 'closed') closed++;
    }
    expect(closed).toBe(TICKS_PER_S);
    c.applySettings(0, Y, 0, { m: 'latch' });
    c.radio(1, 0, Y, 0);
    env.ticks(40);
    expect(state(env, 0, 0)).toBe('closed');
    expect(hint(env, 0, 0)).toBe('Coherer Receiver · 300 m · latch · closed · R key: tap · Shift+R key: settings');
    c.radio(1, 0, Y, 0);
    env.ticks(2);
    expect(state(env, 0, 0)).toBe('closed');
    expect(env.store.export()['0,11,0']).toEqual({ k: 'rx', on: true, m: 'latch' });
    expect(c.interact(0, Y, 0, 'use')).toBeNull();
    expect(c.interact(0, Y, 0, 'r')).toEqual({ ok: true, message: '' });
    expect(state(env, 0, 0)).toBe('open');
    // The electric tapper: a rising edge on its input face (W by default) opens it.
    c.radio(1, 0, Y, 0);
    env.ticks(2);
    env.put(-2, 0, B.VOLTAIC_BATTERY);
    env.put(-1, 0, B.KNIFE_SWITCH);
    env.ticks(2);
    expect(state(env, 0, 0)).toBe('closed');
    c.switchAt(-1, Y, 0, 'on'); // a closed contact conducts: the tapper's input sees the battery rise
    env.ticks(1);
    expect(state(env, 0, 0)).toBe('open');
    // A wave closes it again; the tapper stays powered, so there is no new rising edge and it stays closed.
    c.radio(1, 0, Y, 0);
    env.ticks(3);
    expect(state(env, 0, 0)).toBe('closed');
  });

  it('selenium: volts by daylight, open sky through glass, shaded under stone', () => {
    const env = makeCircuitWorld();
    env.fx.daylight = 0.5;
    env.put(0, 0, B.SELENIUM_PANEL);
    env.ticks(1);
    expect(hint(env, 0, 0)).toBe('Selenium Panel · 2.25 V in daylight');
    env.put(0, 0, B.GLASS, Y + 5);
    env.ticks(20);
    expect(V(env, 0, 0)).toBe(2.25);
    env.put(0, 0, B.STONE, Y + 9);
    env.ticks(20);
    expect(hint(env, 0, 0)).toBe('Selenium Panel · shaded: it needs open sky');
    expect(V(env, 0, 0)).toBe(0);
    expect(state(env, 0, 0)).toBe('shaded');
  });
});

describe('powder fuses and the flame rule (§4.3)', () => {
  it('a fuse branches: lit at one end, both arms of a T burn together and light both kegs in the same tick', () => {
    const env = makeCircuitWorld();
    line(env, 0, 4, B.POWDER_FUSE);
    env.put(4, 1, B.POWDER_FUSE);
    env.put(4, 2, B.POWDER_KEG);
    env.put(5, -1, B.POWDER_FUSE);
    env.put(5, -2, B.POWDER_KEG);
    env.ticks(1);
    expect(env.circuits.ignite(0, Y, 0)).toEqual({ ok: true, message: `lit the powder fuse at (0, ${Y}, 0)` });
    expect(env.circuits.ignite(0, Y, 0).message).toBe(`the fuse at (0, ${Y}, 0) is already burning`);
    env.ticks(80);
    expect(env.fx.kegs.length).toBe(2);
    expect(env.fx.kegs[0].tick).toBe(env.fx.kegs[1].tick);
  });

  it('cutting a burning fuse stops the flame there', () => {
    const env = makeCircuitWorld();
    line(env, 0, 9, B.POWDER_FUSE);
    env.put(10, 0, B.POWDER_KEG);
    env.circuits.ignite(0, Y, 0);
    env.ticks(20);
    const burning = [...env.circuits.burning.keys()];
    expect(burning.length).toBe(1);
    expect(hint(env, 2, 0)).toBe('Powder Fuse · burning · left-click: cut it');
    env.world.setBlock(2, Y, 0, B.AIR);
    env.ticks(100);
    expect(env.fx.kegs).toEqual([]);
    expect(env.world.getBlock(5, Y, 0)).toBe(B.POWDER_FUSE);
    expect(hint(env, 5, 0)).toBe('Powder Fuse · R key: light it here');
  });

  it('a 12 × 12 × 4 fuse fill burns out completely, each cell lit once, ≤ 32 writes, ≤ 24 puffs and ≤ 16 sparks per tick', () => {
    const env = makeCircuitWorld();
    for (let q = 0; q < 12; q++) for (let r = 0; r < 12; r++) for (let y = Y; y < Y + 4; y++) env.put(q, r, B.POWDER_FUSE, y);
    const lit = new Map();
    const orig = env.circuits._lightFuse.bind(env.circuits);
    env.circuits._lightFuse = (pc, from, src) => {
      const before = env.circuits.burning.has(pc);
      const ok = orig(pc, from, src);
      if (!before && env.circuits.burning.has(pc)) lit.set(pc, (lit.get(pc) ?? 0) + 1);
      return ok;
    };
    env.ticks(1);
    env.circuits.ignite(0, Y, 0);
    for (let i = 0; i < 400; i++) {
      const w0 = env.world.writes.length;
      const p0 = env.fx.particles.length;
      env.ticks(1);
      const writes = env.world.writes.slice(w0).filter((w) => w.id === B.AIR);
      const parts = env.fx.particles.slice(p0);
      expect(writes.length).toBeLessThanOrEqual(MAX_CIRCUIT_WRITES_PER_TICK);
      expect(writes.every((w) => w.lazy)).toBe(true);
      expect(parts.filter((p) => p.kind === 'smoke').length).toBeLessThanOrEqual(MAX_FUSE_PUFFS_PER_TICK);
      expect(parts.filter((p) => p.kind === 'sparks' && p.n === 1).length).toBeLessThanOrEqual(MAX_FUSE_SPARK_CELLS);
      if (env.circuits.burning.size === 0 && env.circuits.spent.size === 0 && i > 10) break;
    }
    let left = 0;
    for (let q = 0; q < 12; q++) for (let r = 0; r < 12; r++) for (let y = Y; y < Y + 4; y++) if (env.world.getBlock(q, y, r) !== B.AIR) left++;
    expect(left).toBe(0);
    expect(lit.size).toBe(12 * 12 * 4);
    expect([...lit.values()].every((n) => n === 1)).toBe(true);
    expect(env.fx.sounds.some((s) => s.name === 'fuseHiss' && s.v === 0.5)).toBe(true);
  });

  it('a fuse lights a charge through activateCharge; a refusal is said once per cause per 4 s', () => {
    const env = makeCircuitWorld();
    env.fx.chargeResult = () => ({ ok: false, message: 'black holes are off — turn them on with `blackholes on`' });
    env.put(0, 0, B.COLLAPSAR_CHARGE);
    env.put(1, 0, B.POWDER_FUSE);
    env.put(5, 0, B.COLLAPSAR_CHARGE);
    env.put(6, 0, B.POWDER_FUSE);
    env.circuits.ignite(1, Y, 0);
    env.circuits.ignite(6, Y, 0);
    env.ticks(12);
    expect(env.fx.charges.length).toBe(2);
    expect(env.fx.said).toEqual([`the fuse at (1, ${Y}, 0) has nothing to light: black holes are off`]);
  });

  it('a burning fuse is frozen while its chunk is unloaded; at most MAX_BURNING_FUSES burn, the rest wait their turn', () => {
    const env = makeCircuitWorld();
    line(env, 20, 22, B.POWDER_FUSE);
    env.circuits.ignite(20, Y, 0);
    env.ticks(3);
    env.world.unload(1, 0);
    env.ticks(40);
    expect(env.circuits.burningAt(20, Y, 0).t).toBeCloseTo(0.4 - 3 * CIRCUIT_TICK_S, 9);
    env.world.load(1, 0);
    env.ticks(30);
    expect(env.world.getBlock(22, Y, 0)).toBe(B.AIR);
    // The cap.
    const big = makeCircuitWorld();
    const cells = [];
    for (let q = 0; q < 100 && cells.length < MAX_BURNING_FUSES + 60; q += 2) {
      for (let r = 0; r < 100 && cells.length < MAX_BURNING_FUSES + 60; r += 2) cells.push([q, r]);
    }
    for (const [q, r] of cells) big.put(q, r, B.POWDER_FUSE);
    for (const [q, r] of cells) expect(big.circuits.ignite(q, Y, r).ok).toBe(true);
    expect(big.circuits.burning.size).toBe(MAX_BURNING_FUSES);
    let max = 0;
    for (let i = 0; i < 120; i++) { // 2108 burnt cells at ≤ 32 AIR writes a tick
      big.ticks(1);
      max = Math.max(max, big.circuits.burning.size);
    }
    expect(max).toBeLessThanOrEqual(MAX_BURNING_FUSES);
    let left = 0;
    for (const [q, r] of cells) if (big.world.getBlock(q, Y, r) !== B.AIR) left++;
    expect(left).toBe(0);
  });

  it('flames: a torch lights a fuse, a keg and a charge beside it; a campfire lights a fuse but leaves a keg to explosions', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.POWDER_FUSE);
    env.put(1, 0, B.TORCH);
    env.put(2, 0, B.POWDER_KEG);
    env.put(1, 0, B.COLLAPSAR_CHARGE, Y + 1);
    env.ticks(1);
    expect(env.circuits.burningAt(0, Y, 0)).toEqual({ t: 0.4, from: 0 });
    expect(env.fx.kegs.map((k) => k.q)).toEqual([2]);
    expect(env.fx.charges.map((k) => [k.q, k.y])).toEqual([[1, Y + 1]]);
    expect(hint(env, 1, 0)).toBe('Torch · always burning: lights fuses, kegs and charges beside it');
    const fire = makeCircuitWorld();
    fire.put(0, 0, B.CAMPFIRE);
    fire.put(1, 0, B.POWDER_FUSE);
    fire.put(-1, 0, B.POWDER_KEG);
    fire.ticks(1);
    expect(fire.circuits.burningAt(1, Y, 0)).not.toBeNull();
    fire.ticks(20);
    expect(fire.fx.kegs).toEqual([]); // a campfire beside a keg is explosions' own 'ignite' rule
    // Placing the fuse next to an existing torch lights it as well.
    const late = makeCircuitWorld();
    late.put(0, 0, B.TORCH);
    late.ticks(1);
    late.put(1, 0, B.POWDER_FUSE);
    late.ticks(1);
    expect(late.circuits.burningAt(1, Y, 0)).toEqual({ t: 0.4, from: 3 });
  });

  it('loadFromEdits and onChunkLoaded queue the flame candidates; cells in unloaded chunks park until they load', () => {
    const env = makeCircuitWorld({ enabled: false });
    env.put(0, 0, B.TORCH);
    env.put(1, 0, B.POWDER_FUSE);
    env.put(-20, 0, B.TORCH);
    env.put(-19, 0, B.POWDER_FUSE);
    env.ticks(5);
    expect(env.circuits.burning.size).toBe(0);
    env.world.unload(-2, 0);
    const next = reload(env);
    next.ticks(1);
    expect(next.circuits.burningAt(1, Y, 0)).not.toBeNull();
    expect(next.circuits.burningAt(-19, Y, 0)).toBeNull();
    next.ticks(5);
    expect(next.circuits.burningAt(-19, Y, 0)).toBeNull();
    next.world.load(-2, 0);
    next.ticks(1);
    expect(next.circuits.burningAt(-19, Y, 0)).not.toBeNull();
  });

  it('wouldIgnite: a flame or a powered igniter beside the cell', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.TORCH);
    env.put(10, 0, B.CAMPFIRE);
    env.put(20, 0, B.VOLTAIC_BATTERY);
    env.put(21, 0, B.COPPER_WIRE);
    env.put(22, 0, B.IGNITER);
    env.put(30, 0, B.IGNITER);
    env.ticks(2);
    const c = env.circuits;
    expect(c.wouldIgnite(1, Y, 0)).toBe(true);
    expect(c.wouldIgnite(0, Y + 1, 0)).toBe(true);
    expect(c.wouldIgnite(11, Y, 0)).toBe(true);
    expect(c.wouldIgnite(23, Y, 0)).toBe(true);
    expect(c.wouldIgnite(31, Y, 0)).toBe(false);
    expect(c.wouldIgnite(5, Y, 0)).toBe(false);
    expect(c.wouldIgnite(5, 500, 0)).toBe(false);
  });
});

describe('bookkeeping, the player\'s hands and the readouts', () => {
  it('onBlockChange calls no hook', () => {
    const env = makeCircuitWorld();
    for (const k of Object.keys(env.hooks)) env.hooks[k] = vi.fn(env.hooks[k]);
    const c = new Circuits(env.store, env.hooks);
    env.world.onBlockChange = (q, y, r, p, n) => c.onBlockChange(q, y, r, p, n);
    for (const id of [B.VOLTAIC_BATTERY, B.COPPER_WIRE, B.EARTH_WIRE, B.TORCH, B.POWDER_FUSE, B.RELAY, B.FILAMENT_LAMP, B.POWDER_KEG]) {
      env.world.setBlock(3, Y, 3, id);
      env.world.setBlock(3, Y + 1, 3, id);
    }
    env.world.setBlock(3, Y, 3, B.AIR);
    env.world.setBlock(3, Y - 1, 3, B.AIR);
    for (const k of Object.keys(env.hooks)) expect(env.hooks[k], k).not.toHaveBeenCalled();
    expect(c.cells.size).toBeGreaterThan(0);
  });

  it('a part leaving its cell deletes its store entry; placing one creates a free (pristine) one', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, B.KNIFE_SWITCH);
    expect(env.store.get('0,11,0')).toMatchObject({ k: 'switch', on: false });
    expect(env.store.size).toBe(0);
    env.circuits.switchAt(0, Y, 0, 'on');
    expect(env.store.size).toBe(1);
    env.world.setBlock(0, Y, 0, B.STONE);
    expect(env.store.get('0,11,0')).toBeUndefined();
    expect(env.store.size).toBe(0);
    env.put(0, 0, B.COPPER_WIRE);
    expect(env.store.get('0,11,0')).toBeUndefined();
  });

  it('interact: null where there is no action; right-click works controls only; the R key also relays, coherers and fuses', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    const ids = [B.COPPER_WIRE, B.EARTH_WIRE, B.TERMINAL_BOARD, B.VOLTAIC_BATTERY, B.SELENIUM_PANEL, B.IGNITER, B.FILAMENT_LAMP,
      B.ELECTRIC_BELL, B.TORCH, B.POWDER_KEG, B.COLLAPSAR_CHARGE, B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.RELAY,
      B.SPARK_TRANSMITTER, B.COHERER_RECEIVER, B.BLASTING_MACHINE, B.POWDER_FUSE, B.CAMPFIRE, B.STONE];
    ids.forEach((id, i) => env.put(i * 3, 0, id));
    const at = (id) => ids.indexOf(id) * 3;
    for (const id of [B.COPPER_WIRE, B.EARTH_WIRE, B.TERMINAL_BOARD, B.VOLTAIC_BATTERY, B.SELENIUM_PANEL, B.IGNITER, B.FILAMENT_LAMP,
      B.ELECTRIC_BELL, B.TORCH, B.POWDER_KEG, B.COLLAPSAR_CHARGE, B.CAMPFIRE, B.STONE]) {
      expect(c.interact(at(id), Y, 0, 'r'), String(id)).toBeNull();
      expect(c.interact(at(id), Y, 0, 'use'), String(id)).toBeNull();
    }
    for (const id of [B.RELAY, B.COHERER_RECEIVER, B.POWDER_FUSE]) expect(c.interact(at(id), Y, 0, 'use')).toBeNull();
    for (const id of [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.SPARK_TRANSMITTER, B.BLASTING_MACHINE]) {
      expect(c.interact(at(id), Y, 0, 'use')?.ok, String(id)).toBe(true);
    }
    for (const id of [B.RELAY, B.COHERER_RECEIVER, B.POWDER_FUSE, B.KNIFE_SWITCH, B.PUSH_BUTTON]) {
      expect(c.interact(at(id), Y, 0, 'r')?.ok, String(id)).toBe(true);
    }
    expect(c.interact(at(B.POWDER_FUSE), Y, 0, 'r')).toEqual({ ok: false, message: 'the fuse is already burning' });
    expect(env.fx.sounds.some((s) => s.name === 'fuseLight')).toBe(true);
    expect(c.interact(0, 300, 0, 'r')).toBeNull();
    // Switched off: the controls say so.
    c.setEnabled(false);
    expect(c.interact(at(B.KNIFE_SWITCH), Y, 0, 'use')).toEqual({ ok: false, message: 'circuits are off — turn them on with `circuits on`' });
    expect(c.radio(1, 0, 0, 0).ok).toBe(false);
    expect(c.switchAt(at(B.KNIFE_SWITCH), Y, 0, 'on').ok).toBe(false);
  });

  it('switchAt and timerAt answer in words', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.KNIFE_SWITCH);
    env.put(3, 0, B.PUSH_BUTTON);
    env.put(6, 0, B.CLOCKWORK_TIMER);
    expect(c.switchAt(0, Y, 0)).toEqual({ ok: true, message: `knife switch at (0, ${Y}, 0): closed` });
    expect(c.switchAt(0, Y, 0, 'on')).toEqual({ ok: true, message: `knife switch at (0, ${Y}, 0): closed` });
    expect(c.switchAt(0, Y, 0, 'off').message).toBe(`knife switch at (0, ${Y}, 0): open`);
    expect(c.switchAt(3, Y, 0, 'press')).toEqual({ ok: true, message: `push button at (3, ${Y}, 0): pressed` });
    expect(c.switchAt(3, Y, 0, 'on')).toEqual({ ok: false, message: `the push button at (3, ${Y}, 0) can only be pressed` });
    expect(c.switchAt(9, Y, 0).message).toBe(`there is no switch or button at (9, ${Y}, 0)`);
    expect(c.timerAt(6, Y, 0)).toEqual({ ok: true, message: `timer at (6, ${Y}, 0): 5 s pulse, idle` });
    expect(c.timerAt(6, Y, 0, 30)).toEqual({ ok: true, message: `timer at (6, ${Y}, 0): 30 s pulse` });
    expect(c.timerAt(6, Y, 0, '9999').message).toBe(`timer at (6, ${Y}, 0): 3600 s pulse (clamped)`);
    expect(c.timerAt(6, Y, 0, 10, 'repeat').message).toBe(`timer at (6, ${Y}, 0): 10 s repeat`);
    expect(c.timerAt(6, Y, 0, 'hold').message).toBe(`timer at (6, ${Y}, 0): 10 s hold, idle`);
    expect(c.timerAt(6, Y, 0, 'start').message).toBe(`timer at (6, ${Y}, 0) started: 10 s hold`);
    env.ticks(56);
    expect(c.timerAt(6, Y, 0).message).toBe(`timer at (6, ${Y}, 0): 10 s hold, 7.2 s left`);
    expect(c.timerAt(6, Y, 0, 'stop').message).toBe(`timer at (6, ${Y}, 0) stopped`);
    expect(c.timerAt(6, Y, 0, 'soon')).toEqual({ ok: false, message: 'expected start, stop or a delay in seconds, got "soon"' });
    expect(c.timerAt(0, Y, 0).message).toBe(`there is no clockwork timer at (0, ${Y}, 0)`);
  });

  it('ignite dispatches by block: fuse in place, keg 3 s through igniteKeg, charge through activateCharge, else nothing', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.POWDER_KEG);
    env.put(3, 0, B.COLLAPSAR_CHARGE);
    env.put(6, 0, B.STONE);
    expect(c.ignite(0, Y, 0)).toEqual({ ok: true, message: `lit the powder keg at (0, ${Y}, 0) — 3 s fuse` });
    expect(env.fx.kegs[0].fuse).toBe(BARREL_FUSE_S);
    expect(c.ignite(3, Y, 0)).toEqual({ ok: true, message: `the collapsar charge at (3, ${Y}, 0) is collapsing` });
    expect(c.ignite(6, Y, 0)).toEqual({ ok: false, message: `there is nothing to light at (6, ${Y}, 0) — a powder keg, powder fuse or collapsar charge` });
    env.world.unload(5, 5);
    expect(c.ignite(80, Y, 80).message).toBe(`cell (80, ${Y}, 80) is not loaded`);
    c.setEnabled(false);
    env.put(9, 0, B.POWDER_FUSE);
    expect(c.ignite(9, Y, 0)).toEqual({ ok: false, message: 'circuits are off — turn them on with `circuits on`' });
    expect(c.ignite(0, Y, 0).ok).toBe(false); // the fake keg already burns: igniteKeg's own answer
    expect(KEG_DIRECT_FUSE_S).toBeLessThan(BARREL_FUSE_S);
  });

  it('setEnabled(false) freezes everything: no ticks, fuses and timers wait; switching on settles without firing', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.KNIFE_SWITCH);
    env.put(2, 0, B.COPPER_WIRE);
    env.put(3, 0, B.IGNITER);
    env.put(4, 0, B.POWDER_KEG);
    line(env, 10, 14, B.POWDER_FUSE);
    env.ticks(2);
    c.ignite(10, Y, 0);
    env.ticks(2);
    expect(c.setEnabled(false)).toBe(true);
    expect(c.setEnabled(false)).toBe(false);
    expect(c.switchVersion).toBe(1);
    const t = c.burningAt(10, Y, 0).t;
    const tick = c.tickCount;
    for (let i = 0; i < 100; i++) c.step(0.05);
    c.tick();
    expect(c.tickCount).toBe(tick);
    expect(c.burningAt(10, Y, 0).t).toBe(t);
    // The switch is closed while circuits are off (set in the store); switching on settles: the igniter does not fire …
    env.store.set(1, Y, 0, 'switch', { on: true });
    expect(c.setEnabled(true)).toBe(true);
    c.tick();
    expect(state(env, 3, 0)).toBe('hot');
    expect(env.fx.kegs).toEqual([]);
    c.step(0.5);
    c.step(0.5);
    env.ticks(10);
    expect(env.fx.kegs.length).toBe(1); // … until its refire clock comes round
  });

  it('step runs at most 2 ticks per call and drops the leftover beyond one tick', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    const t0 = c.tickCount;
    c.step(1);
    expect(c.tickCount - t0).toBe(2);
    c.step(0);
    expect(c.tickCount - t0).toBe(3);
    c.step(0);
    expect(c.tickCount - t0).toBe(3);
    c.step(0.02);
    expect(c.tickCount - t0).toBe(3);
    c.step(0.03);
    expect(c.tickCount - t0).toBe(4);
  });

  it('hints for every part (and none for the keg, the campfire or a plain block); none has a bare R', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    const ids = [B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE, B.EARTH_WIRE, B.TERMINAL_BOARD, B.VOLTAIC_BATTERY, B.BLASTING_MACHINE,
      B.SELENIUM_PANEL, B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.RELAY, B.IGNITER, B.FILAMENT_LAMP, B.ELECTRIC_BELL,
      B.SPARK_TRANSMITTER, B.COHERER_RECEIVER, B.POWDER_FUSE, B.TORCH, B.COLLAPSAR_CHARGE];
    ids.forEach((id, i) => env.put(i * 3, 0, id));
    env.ticks(2);
    const hints = ids.map((id, i) => [id, hint(env, i * 3, 0)]);
    expect(Object.fromEntries(hints)).toEqual({
      [B.COPPER_WIRE]: 'Copper Wire · 0 V',
      [B.BROWN_WIRE]: 'Brown Wire · 0 V',
      [B.WHITE_WIRE]: 'White Wire · 0 V',
      [B.EARTH_WIRE]: 'Earth Wire · grounded', // on natural stone
      [B.TERMINAL_BOARD]: 'Terminal Board · joins every wire colour · 0 V',
      [B.VOLTAIC_BATTERY]: 'Voltaic Battery · 6 V · 100 %',
      [B.BLASTING_MACHINE]: 'Blasting Machine · right-click: push the plunger (24 V for 1 s)',
      [B.SELENIUM_PANEL]: 'Selenium Panel · 3 V in daylight',
      [B.KNIFE_SWITCH]: 'Knife Switch · open · right-click: close it',
      [B.PUSH_BUTTON]: 'Push Button · hold right-click to press',
      [B.CLOCKWORK_TIMER]: 'Clockwork Timer · 5 s pulse · right-click: wind and start · Shift+R key: set',
      [B.RELAY]: 'Relay · coil 0 V · contacts open (NO) · R key: push armature · Shift+R key: settings',
      [B.IGNITER]: 'Igniter · 0 V (fires at 3 V)',
      [B.FILAMENT_LAMP]: 'Filament Lamp · 0 V (needs 1.5 V)',
      [B.ELECTRIC_BELL]: 'Electric Bell · 0 V',
      [B.SPARK_TRANSMITTER]: 'Spark Transmitter · 300 m · right-click: send · Shift+R key: wavelength',
      [B.COHERER_RECEIVER]: 'Coherer Receiver · 300 m · pulse · R key: tap · Shift+R key: settings',
      [B.POWDER_FUSE]: 'Powder Fuse · R key: light it here',
      [B.TORCH]: 'Torch · always burning: lights fuses, kegs and charges beside it',
      [B.COLLAPSAR_CHARGE]: 'Collapsar Charge · dormant · set it off from afar: fuse, igniter or radio',
    });
    env.put(70, 0, B.POWDER_KEG);
    env.put(73, 0, B.CAMPFIRE);
    expect(hint(env, 70, 0)).toBeNull();
    expect(hint(env, 73, 0)).toBeNull();
    expect(hint(env, 76, 0)).toBeNull();
    expect(hint(env, 0, 0, 500)).toBeNull();
    c.applySettings(0, Y, 0, { l: 'Front door' });
    expect(c.applySettings(3, Y, 0, { l: 'x' })).toBeNull(); // a wire has no settings
    c.applySettings(24, Y, 0, { l: 'Front door' });
    expect(hint(env, 24, 0)).toBe('Front door · Knife Switch · open · right-click: close it');
    env.circuits.ignite(51, Y, 0);
    expect(hint(env, 51, 0)).toBe('Powder Fuse · burning · left-click: cut it');
    env.fx.chargeArming = true;
    env.hooks.chargeArming = () => true;
    expect(hint(env, 57, 0)).toBe('Collapsar Charge · collapsing!');
    // No player-facing string has a bare R (DESIGN-circuits §5.10).
    for (const [, h] of hints) {
      expect(h).not.toContain('[R]');
      expect(h).not.toMatch(/(^|[^+\w])R:/);
    }
  });

  it('probe: volts, amps, earth, state, diagnostic and network for every kind; null for non-parts', () => {
    const env = run(3, B.FILAMENT_LAMP);
    const c = env.circuits;
    expect(c.probe(2, Y, 0)).toEqual({
      volts: 5.875, amps: 1, earthed: null, earthReason: '', state: 'live', diag: null,
      net: { cells: 3, sources: 1, loads: 1, partial: false, truncated: false },
    });
    expect(c.probe(4, Y, 0)).toMatchObject({ volts: 5.8125, amps: 1, earthed: true, state: 'lit', net: { cells: 3 } });
    expect(c.probe(0, Y, 0)).toMatchObject({ volts: 6, amps: 1, earthed: true, net: null });
    expect(c.probe(0, Y, 0).state).toMatch(/^(99|100) %$/);
    expect(c.probe(9, Y, 0)).toBeNull();
    expect(c.probe(0, -5, 0)).toBeNull();
    expect(exactVolts(87)).toBe('5.4375 V');
  });

  it('overlays: nearest first, at most MAX_CIRCUIT_OVERLAYS within range, one record per moving or lit bit', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.FILAMENT_LAMP);
    env.put(4, 0, B.KNIFE_SWITCH);
    env.put(6, 0, B.PUSH_BUTTON);
    env.put(8, 0, B.CLOCKWORK_TIMER);
    env.put(10, 0, B.RELAY);
    env.put(12, 0, B.BLASTING_MACHINE);
    env.put(14, 0, B.ELECTRIC_BELL);
    env.put(16, 0, B.TORCH);
    env.put(18, 0, B.COLLAPSAR_CHARGE);
    env.put(20, 0, B.POWDER_FUSE);
    env.put(22, 0, B.POWDER_KEG);
    env.ticks(2);
    c.ignite(20, Y, 0);
    env.fx.burningKegs.add(`22,${Y},0`);
    env.ticks(2);
    const [x, z] = hexToWorld(0, 0);
    const items = c.overlays(x, Y + 1, z, 48);
    const types = items.map((it) => `${it.q}:${it.type}${it.glow ? `/${it.glow}` : ''}${it.staff ? `/${it.staff}` : ''}`);
    expect(types).toEqual([
      '2:bulb', '2:staff/filament', '2:glow/lamp', '4:blade', '6:cap', '8:hand', '10:arm', '12:plunger', '14:hammer',
      '16:staff/torch', '16:glow/ember', '18:glow/charge', '20:glow/fuse', '20:staff/char', '22:glow/fuse',
    ]);
    const lamp = items.find((it) => it.type === 'glow' && it.glow === 'lamp');
    expect(lamp.a).toBeCloseTo((5.9375 - 1.5) / 4.5, 9);
    expect(items.find((it) => it.type === 'blade').a).toBe(0); // open (a = closed, circuitGeometry's meaning)
    expect(items.find((it) => it.type === 'plunger').a).toBe(0); // cocked
    expect(items.find((it) => it.glow === 'fuse' && it.q === 22).b).toBe(8); // FUSE_AT_BUNG
    expect(c.overlays(x, Y + 1, z, 5).length).toBe(4); // the lamp's three and the switch's blade
    expect(c.overlays(x + 1000, Y, z, 48)).toEqual([]);
    // The cap.
    const many = makeCircuitWorld();
    for (let q = 0; q < 20; q++) for (let r = 0; r < 20; r++) many.put(q, r, B.TORCH);
    const out = many.circuits.overlays(...hexToWorld(10, 10).flatMap((v, i) => (i === 0 ? [v, Y] : [v])), 48);
    expect(out.length).toBe(MAX_CIRCUIT_OVERLAYS);
  });

  it('the geometry view: nearby cells, ids, input faces, earth-wire clamps; geometryVersion follows the wiring', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    const g0 = c.geometryVersion;
    env.put(0, 0, B.COPPER_WIRE);
    env.put(1, 0, B.RELAY);
    env.put(2, 0, B.EARTH_WIRE);
    env.put(3, 0, B.CAMPFIRE);
    expect(c.geometryVersion).toBeGreaterThan(g0);
    const v = c.geometryView();
    expect(v).toBe(c.geometryView());
    const [x, z] = hexToWorld(0, 0);
    expect(v.cellsNear(x, Y, z, 10).map((pc) => pc).sort()).toEqual([packCell(0, Y, 0), packCell(1, Y, 0), packCell(2, Y, 0)].sort());
    expect(v.get(1, Y, 0)).toBe(B.RELAY);
    expect(v.get(9, Y, 9)).toBe(B.AIR);
    expect(v.inputFace(1, Y, 0)).toBe(3);
    const g1 = c.geometryVersion;
    c.setInputFace(1, Y, 0, 6);
    expect(v.inputFace(1, Y, 0)).toBe(6);
    expect(c.geometryVersion).toBeGreaterThan(g1);
    expect(v.grounded(2, Y, 0)).toBe(true);
    const g2 = c.geometryVersion;
    env.world.setBlock(2, Y - 1, 0, B.AIR);
    expect(c.geometryVersion).toBeGreaterThan(g2);
    expect(v.grounded(2, Y, 0)).toBe(false);
    expect(v.grounded(0, Y, 0)).toBe(false);
    expect(c.setInputFace(0, Y, 0, 2)).toBeNull(); // a wire has no input face
  });

  it('the device panel view for each kind', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    env.put(0, 0, B.CLOCKWORK_TIMER);
    env.put(3, 0, B.RELAY);
    env.put(6, 0, B.VOLTAIC_BATTERY);
    env.put(9, 0, B.SPARK_TRANSMITTER);
    env.put(12, 0, B.COHERER_RECEIVER);
    env.put(15, 0, B.COPPER_WIRE);
    env.put(18, 0, B.PUSH_BUTTON);
    env.ticks(1);
    const t = c.panelView(0, Y, 0, true);
    expect(t).toMatchObject({
      key: `0,${Y},0`, k: 'timer', id: B.CLOCKWORK_TIMER, title: 'Clockwork Timer', coords: `(0, ${Y}, 0)`, label: '',
      fields: { s: 5, m: 'pulse', f: 3, on: false }, actions: ['start'],
    });
    expect(t.about).toContain('wound spring');
    expect(t.origin).toBe('A spring-wound clockwork time switch');
    expect(t.readout).toContain('Earthed: yes');
    expect(t.readout).toContain('State: idle');
    c.interact(0, Y, 0, 'use');
    expect(c.panelView(0, Y, 0, true).actions).toEqual(['stop']);
    expect(c.panelView(3, Y, 0, true).fields).toEqual({ f: 3, nc: false });
    expect(c.panelView(6, Y, 0, true).actions).toEqual(['refill']);
    expect(c.panelView(6, Y, 0, false).actions).toEqual([]);
    expect(c.panelView(6, Y, 0, true).readout.some((l) => l.startsWith('Charge: '))).toBe(true);
    expect(c.panelView(9, Y, 0, true)).toMatchObject({ fields: { ch: 1 }, actions: ['send'] });
    expect(c.panelView(12, Y, 0, true)).toMatchObject({ fields: { f: 3, m: 'pulse', ch: 1, on: false }, actions: ['tap'] });
    expect(c.panelView(15, Y, 0, true)).toMatchObject({ k: 'copper_wire', fields: {}, actions: [] });
    expect(c.panelView(18, Y, 0, true).fields).toEqual({ nc: false });
    expect(c.panelView(30, Y, 0, true)).toBeNull();
  });

  it('stats() and status()', () => {
    const env = run(3, B.FILAMENT_LAMP);
    const c = env.circuits;
    env.put(10, 0, B.CLOCKWORK_TIMER);
    line(env, 20, 22, B.POWDER_FUSE);
    c.interact(10, Y, 0, 'use');
    c.ignite(20, Y, 0);
    env.ticks(1);
    const s = c.stats();
    expect(s).toMatchObject({ cells: 9, parts: 9, networks: 1, active: 1, frozen: 0, burning: 1, timers: 1, dirty: 0 });
    expect(typeof s.ms).toBe('number');
    expect(c.status()).toBe('circuits on · 9 parts, 1 network, 1 fuse burning, 1 timer running');
  });

  it('reset drops what is transient and settles again; clear forgets the index', () => {
    const env = run(3, B.FILAMENT_LAMP);
    const c = env.circuits;
    line(env, 20, 22, B.POWDER_FUSE);
    c.ignite(20, Y, 0);
    env.ticks(1);
    c.reset();
    expect(c.burning.size).toBe(0);
    expect(c.networks.size).toBe(0);
    env.ticks(1);
    expect(state(env, 4, 0)).toBe('lit');
    c.clear();
    expect(c.cells.size).toBe(0);
    expect(c.probe(4, Y, 0)).toBeNull();
  });
});

describe('chunk keys', () => {
  it('works across negative chunks (CHUNK_SIZE)', () => {
    const env = makeCircuitWorld();
    env.put(-CHUNK_SIZE - 1, -1, B.VOLTAIC_BATTERY);
    line(env, -CHUNK_SIZE, -CHUNK_SIZE + 2, B.COPPER_WIRE, -1);
    env.put(-CHUNK_SIZE + 3, -1, B.FILAMENT_LAMP);
    env.ticks(2);
    expect(V(env, -CHUNK_SIZE + 3, -1)).toBe(6 - 3 * 0.0625);
  });
});
