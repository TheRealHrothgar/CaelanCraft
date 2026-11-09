// Budget tests for src/circuits.js (DESIGN-circuits §4.7 "Budgets", §7 B; like physicsBudget.test.js): the tick's time budget
// is read from hooks.now() between networks, the visit budget carries the remaining dirty cells to the next tick (a network
// once started is finished), stats().ms comes from hooks.now, and an 8192-cell relay oscillator stays within the budget.
import { describe, it, expect } from 'vitest';
import { CIRCUIT_TICK_BUDGET_MS, MAX_CIRCUIT_VISITS_PER_TICK, MAX_NETWORK_CELLS } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { makeCircuitWorld, FLOOR } from '../helpers/circuitWorld.js';

const B = BLOCK;
const Y = FLOOR;

/**
 * Make the fake clock advance with the work done: every network built costs `msPerVisit` per cell it visited.
 * @param {ReturnType<typeof makeCircuitWorld>} env
 */
function clockPerVisit(env, msPerVisit) {
  const c = /** @type {*} */ (env.circuits);
  const build = c._build.bind(c);
  let built = 0;
  c._build = (...args) => {
    const net = build(...args);
    env.clock.ms += net.nodes.length * msPerVisit;
    built++;
    return net;
  };
  return { built: () => built };
}

/** `count` separate circuits (battery → `len` wire cells → lamp), one per row r = 0, 2, 4, … */
function rows(env, count, len) {
  for (let i = 0; i < count; i++) {
    env.put(0, 2 * i, B.VOLTAIC_BATTERY);
    for (let q = 1; q <= len; q++) env.put(q, 2 * i, B.COPPER_WIRE);
    env.put(len + 1, 2 * i, B.FILAMENT_LAMP);
  }
}

describe('circuit budgets (§4.7)', () => {
  it('a fake clock advancing per visit stops the tick starting networks once 2 ms have passed; the rest follow next tick', () => {
    const env = makeCircuitWorld();
    rows(env, 12, 50);
    const counter = clockPerVisit(env, 0.02); // a 50-cell network costs 1 ms
    env.ticks(1);
    expect(counter.built()).toBe(2); // 0 ms → build (1 ms) → build (2 ms) → over: no third start
    expect(env.circuits.stats().dirty).toBeGreaterThan(0);
    expect(env.circuits.stats().ms).toBeCloseTo(2, 9); // from hooks.now: the work the fake clock was charged
    let ticks = 1;
    while (env.circuits.stats().dirty > 0 && ticks < 50) {
      env.ticks(1);
      ticks++;
    }
    expect(ticks).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < 12; i++) expect(env.circuits.probe(51, Y, 2 * i).state).toBe('lit');
  });

  it('the visit budget is checked between networks: one started is finished, the remaining dirty cells wait FIFO', () => {
    const env = makeCircuitWorld();
    rows(env, 3, 4000);
    env.ticks(1);
    const v = env.circuits.stats().visits;
    expect(v).toBeGreaterThan(MAX_CIRCUIT_VISITS_PER_TICK); // the second network was started below the cap and finished
    expect(v).toBeLessThan(3 * 4000);
    expect(env.circuits.stats().dirty).toBeGreaterThan(0);
    expect(env.circuits.probe(1, Y, 0).volts).toBe(5.9375); // first in, first built
    expect(env.circuits.probe(1, Y, 4).volts).toBe(0); // not built yet
    for (let i = 0; i < 10 && env.circuits.stats().dirty > 0; i++) env.ticks(1);
    expect(env.circuits.probe(1, Y, 4).volts).toBe(5.9375);
  });

  it('an 8192-cell relay oscillator rebuilds one network per tick and stays within the budget', () => {
    const env = makeCircuitWorld();
    const c = env.circuits;
    // Battery → wire → an NC relay (input E) whose contact, on its NE face, feeds a 90 × 90 field of terminal boards that also
    // touches its own input: it pulls in, opens, drops out, closes — every tick.
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    c.setInputFace(2, Y, 0, 0);
    c.applySettings(2, Y, 0, { nc: true });
    for (let q = 3; q < 93; q++) for (let r = -89; r <= 0; r++) env.put(q, r, B.TERMINAL_BOARD);
    clockPerVisit(env, CIRCUIT_TICK_BUDGET_MS / (MAX_NETWORK_CELLS + 64)); // a full network costs just under the budget
    env.ticks(4);
    /** @type {boolean[]} */
    const closed = [];
    for (let i = 0; i < 6; i++) {
      env.ticks(1);
      const s = c.stats();
      expect(s.visits).toBeLessThanOrEqual(MAX_NETWORK_CELLS + 64);
      expect(s.ms).toBeLessThanOrEqual(CIRCUIT_TICK_BUDGET_MS);
      closed.push(/** @type {*} */ (c.probe(2, Y, 0)).state.endsWith('closed'));
    }
    for (let i = 1; i < closed.length; i++) expect(closed[i]).toBe(!closed[i - 1]);
    expect(c.probe(50, Y, -40).net.cells).toBeGreaterThan(8000);
  });
});
