// Budget tests for src/circuits.js (DESIGN-circuits §4.7 "Budgets", §7 B; like physicsBudget.test.js): the tick's time budget
// is read from hooks.now() between networks, the visit budget carries the remaining dirty cells to the next tick (a network
// once started is finished), stats().ms comes from hooks.now, and an 8192-cell relay oscillator stays within the budget.
import { describe, it, expect } from 'vitest';
import { CIRCUIT_TICK_BUDGET_MS, MAX_CIRCUIT_VISITS_PER_TICK, MAX_NETWORK_CELLS } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { makeCircuitWorld, reload, FLOOR } from '../helpers/circuitWorld.js';

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

/**
 * Every network built costs `ms` on the fake clock, whatever its size (a busy machine).
 * @param {ReturnType<typeof makeCircuitWorld>} env
 */
function clockPerNetwork(env, ms) {
  const c = /** @type {*} */ (env.circuits);
  const build = c._build.bind(c);
  c._build = (...args) => {
    const net = build(...args);
    env.clock.ms += ms;
    return net;
  };
}

/**
 * The dead-man circuit of DESIGN-circuits §4.7: Battery A · wire · NC Relay (input W) whose coil pulls in first, then Battery B
 * on its NE face; the Igniter on its SE face and a keg beside that stay cold while the relay is energised. `q0, r0` is the
 * relay's column. Indexed in this order: the igniter and the keg, the relay, the coil's battery and wire, Battery B — so a
 * reload builds the network on the relay's contacts (its NC contacts at rest: closed, the igniter powered) before the relay
 * takes its coil's state, and no cell after the relay's touches the igniter (nothing else re-reads it).
 */
function deadMan(env, q0, r0) {
  env.put(q0, r0 + 1, B.IGNITER);
  env.put(q0, r0 + 2, B.POWDER_KEG);
  env.put(q0, r0, B.RELAY);
  env.circuits.setInputFace(q0, Y, r0, 3);
  env.circuits.applySettings(q0, Y, r0, { nc: true });
  env.put(q0 - 2, r0, B.VOLTAIC_BATTERY);
  env.put(q0 - 1, r0, B.COPPER_WIRE);
  env.ticks(10);
  env.put(q0 + 1, r0 - 1, B.VOLTAIC_BATTERY);
  env.ticks(40);
  expect(env.circuits.probe(q0, Y, r0).state).toBe('energised, contacts open');
  expect(env.circuits.probe(q0, Y, r0 + 1).state).toBe('cold');
  expect(env.fx.kegs.length).toBe(0);
}

/** `n` small separate networks (battery → 3 wire cells → lamp) far out at q = 40…44, every second row: a long load FIFO. */
function farRows(env, n) {
  for (let i = 0; i < n; i++) {
    env.put(40, 2 * i, B.VOLTAIC_BATTERY);
    for (let q = 41; q <= 43; q++) env.put(q, 2 * i, B.COPPER_WIRE);
    env.put(44, 2 * i, B.FILAMENT_LAMP);
  }
}

/** `n` relay-switched lamps (Battery A · wire · NO Relay, input W · Battery B on E · Lamp on SE), every third row from r0. */
function relayLamps(env, n, q0, r0) {
  for (let i = 0; i < n; i++) {
    const r = r0 + 3 * i;
    env.put(q0, r, B.VOLTAIC_BATTERY);
    env.put(q0 + 1, r, B.COPPER_WIRE);
    env.put(q0 + 2, r, B.RELAY);
    env.circuits.setInputFace(q0 + 2, Y, r, 3);
    env.put(q0 + 3, r, B.VOLTAIC_BATTERY);
    env.put(q0 + 2, r + 1, B.FILAMENT_LAMP);
  }
}

describe('settling under the tick budget: loading never fires anything (§4.7, CONTRACTS pitfall 37)', () => {
  it('a settling pass the budget cuts short keeps the relays it did not reach: the dead-man keg is not lit by a reload', () => {
    const env = makeCircuitWorld();
    // The dead-man's igniter and keg are indexed first, then 12 relay-switched lamps, then the dead-man relay: on the reload
    // the second (settling) pass rebuilds the 12 lamps' contacts first and runs out of budget before the dead-man relay's.
    env.put(2, 13, B.IGNITER);
    env.put(2, 14, B.POWDER_KEG);
    for (const r0 of [0, 3, 6, 9]) for (const q0 of [0, 5, 10]) relayLamps(env, 1, q0, r0);
    env.put(0, 12, B.VOLTAIC_BATTERY);
    env.put(1, 12, B.COPPER_WIRE);
    env.put(2, 12, B.RELAY);
    env.circuits.setInputFace(2, Y, 12, 3);
    env.circuits.applySettings(2, Y, 12, { nc: true });
    env.ticks(10);
    env.put(3, 12, B.VOLTAIC_BATTERY);
    env.ticks(40);
    expect(env.circuits.probe(2, Y, 13).state).toBe('cold');
    const next = reload(env);
    clockPerNetwork(next, 0.1); // 20 networks fill the 2 ms budget
    next.ticks(60);
    expect(next.circuits.probe(2, Y, 12).state).toBe('energised, contacts open');
    expect(next.circuits.probe(2, Y, 13).state).toBe('cold');
    expect(next.fx.kegs.length).toBe(0);
  });

  for (const n of [10, 15]) {
    it(`${n} relay-switched lamps lit when the world was saved are all lit again after a reload on a busy machine`, () => {
      const env = makeCircuitWorld();
      relayLamps(env, n, 0, 0);
      env.ticks(10);
      const lit = (e) => [...Array(n).keys()].filter((i) => e.circuits.probe(2, Y, 3 * i + 1).state === 'lit').length;
      expect(lit(env)).toBe(n);
      const next = reload(env);
      clockPerNetwork(next, 0.1);
      next.ticks(200);
      expect(lit(next)).toBe(n);
      expect(next.circuits.stats().dirty).toBe(0);
    });
  }

  it('the settle a relay starts is finished first next tick, not after the rest of a big load (the dead-man keg stays cold)', () => {
    const env = makeCircuitWorld();
    deadMan(env, 2, 0);
    // 30 more relay circuits (other chunks, indexed after it): on the reload every relay is expanded before the igniter
    // (relays first), so only a settle finished at the front of the next tick turns the igniter off in time.
    relayLamps(env, 30, 40, 0);
    env.ticks(20);
    const next = reload(env);
    clockPerNetwork(next, CIRCUIT_TICK_BUDGET_MS); // one network a tick: the load takes 60+ ticks, longer than the 0.5 s refire
    for (let i = 0; i < 120; i++) {
      next.ticks(1);
      expect(next.fx.kegs.length).toBe(0);
    }
    expect(next.circuits.probe(2, Y, 0).state).toBe('energised, contacts open');
    expect(next.circuits.probe(2, Y, 1).state).toBe('cold');
    expect(next.circuits.probe(42, Y, 88).state).toBe('lit'); // and the rest of the load is done
  });

  it('a relay indexed after the rest of a big load takes its coil\'s state before the igniter on its contacts can refire', () => {
    const env = makeCircuitWorld();
    // The igniter and keg in chunk (0, 0), indexed first; 40 networks in other chunks; then, across the chunk edge in chunk
    // (1, 0), the NC relay on the igniter's NE face, its coil (input E: wire (17, 0), battery (18, 0)) and Battery B on its
    // NW contact.
    env.put(15, 1, B.IGNITER);
    env.put(15, 2, B.POWDER_KEG);
    farRows(env, 40);
    env.put(16, 0, B.RELAY);
    env.circuits.setInputFace(16, Y, 0, 0);
    env.circuits.applySettings(16, Y, 0, { nc: true });
    env.put(17, 0, B.COPPER_WIRE);
    env.put(18, 0, B.VOLTAIC_BATTERY);
    env.ticks(10);
    env.put(16, -1, B.VOLTAIC_BATTERY);
    env.ticks(40);
    expect(env.circuits.probe(15, Y, 1).state).toBe('cold');
    expect(env.fx.kegs.length).toBe(0);
    const next = reload(env);
    clockPerNetwork(next, CIRCUIT_TICK_BUDGET_MS);
    for (let i = 0; i < 80; i++) {
      next.ticks(1);
      expect(next.fx.kegs.length).toBe(0);
    }
    expect(next.circuits.probe(16, Y, 0).state).toBe('energised, contacts open');
    expect(next.circuits.probe(15, Y, 1).state).toBe('cold');
  });
});

/**
 * Two relays in series on the igniter's circuit, the dead-man relay of `deadMan` behind another one: Relay R2 (NO, input W,
 * its coil dead) one layer up at (-21, -3) is indexed first; its E contact touches a copper line at y + 1 — (-20…2, -3),
 * (2, -2), (2, -1) and (2, 0) on top of the dead-man relay, its top contact. The dead-man NC relay (input W: Battery A (0, 0),
 * wire (1, 0)) holds Battery B on its NE face (3, -1) and the igniter on its SE face (2, 1), beside the keg (2, 2); it is indexed
 * last, `between()` lays what stands in the load between them. On a reload R2 is expanded first (relays first) and builds the
 * network on its neighbours at once: the copper line, through the dead-man's NC contacts still at rest (closed), to Battery B
 * and the igniter — powered until the dead-man relay's own turn comes.
 * @param {ReturnType<typeof makeCircuitWorld>} env
 * @param {() => void} between
 */
function seriesDeadMan(env, between) {
  env.put(-21, -3, B.RELAY, Y + 1);
  env.circuits.setInputFace(-21, Y + 1, -3, 3);
  for (let q = -20; q <= 2; q++) env.put(q, -3, B.COPPER_WIRE, Y + 1);
  env.put(2, -2, B.COPPER_WIRE, Y + 1);
  env.put(2, -1, B.COPPER_WIRE, Y + 1);
  between();
  env.put(2, 1, B.IGNITER);
  env.put(2, 2, B.POWDER_KEG);
  env.put(2, 0, B.RELAY);
  env.circuits.setInputFace(2, Y, 0, 3);
  env.circuits.applySettings(2, Y, 0, { nc: true });
  env.put(0, 0, B.VOLTAIC_BATTERY);
  env.put(1, 0, B.COPPER_WIRE);
  env.put(2, 0, B.COPPER_WIRE, Y + 1);
  env.ticks(40);
  env.put(3, -1, B.VOLTAIC_BATTERY);
  env.ticks(60);
  expect(env.circuits.probe(2, Y, 0).state).toBe('energised, contacts open');
  expect(env.circuits.probe(2, Y, 1).state).toBe('cold');
  expect(env.fx.kegs.length).toBe(0);
}

describe('two relays in series on the igniter\'s circuit: its refire clock waits for the whole settle (CONTRACTS pitfall 37)', () => {
  it('one network a tick, 30 relay-switched lamps between them: the dead-man keg is not lit by a reload', () => {
    const env = makeCircuitWorld();
    seriesDeadMan(env, () => relayLamps(env, 30, 40, 0));
    const next = reload(env);
    clockPerNetwork(next, CIRCUIT_TICK_BUDGET_MS); // the dead-man relay's turn comes some 90 ticks after R2's
    let hot = 0;
    for (let i = 0; i < 200; i++) {
      next.ticks(1);
      if (next.circuits.probe(2, Y, 1).state === 'hot') hot++;
      expect(next.fx.kegs.length).toBe(0);
    }
    expect(hot).toBeGreaterThan(20); // powered through the NC contacts at rest for a long while, and it never fired
    expect(next.circuits.probe(2, Y, 0).state).toBe('energised, contacts open');
    expect(next.circuits.probe(2, Y, 1).state).toBe('cold');
    expect(next.circuits.probe(42, Y, 88).state).toBe('lit'); // and the rest of the load is done
    expect(next.circuits.stats().dirty).toBe(0);
  });

  it('the visit budget alone: 24 relays between them, each switching a 40 × 40 wire grid, spread the settle over 12 ticks', () => {
    const env = makeCircuitWorld();
    seriesDeadMan(env, () => {
      for (let k = 0; k < 24; k++) {
        const q0 = 100 + 50 * (k % 4);
        const r0 = 50 * Math.floor(k / 4);
        env.put(q0, r0, B.VOLTAIC_BATTERY);
        env.put(q0 + 1, r0, B.COPPER_WIRE);
        env.put(q0 + 2, r0, B.RELAY);
        env.circuits.setInputFace(q0 + 2, Y, r0, 3);
        env.put(q0 + 3, r0, B.VOLTAIC_BATTERY);
        for (let q = q0 + 2; q < q0 + 42; q++) for (let r = r0 + 1; r < r0 + 41; r++) env.put(q, r, B.COPPER_WIRE, Y + 1);
        env.put(q0 + 2, r0, B.COPPER_WIRE, Y + 1);
      }
    });
    const next = reload(env);
    let busy = 0;
    for (let i = 0; i < 120; i++) {
      next.ticks(1);
      if (next.circuits.stats().visits >= MAX_CIRCUIT_VISITS_PER_TICK) busy++;
      expect(next.fx.kegs.length).toBe(0);
    }
    expect(busy).toBeGreaterThanOrEqual(11); // longer than the 10-tick refire clock
    expect(next.circuits.probe(2, Y, 1).state).toBe('cold');
    expect(next.circuits.probe(260, Y + 1, 260).volts).toBeGreaterThan(0); // the last grid is switched on again
  });

  it('a steadily powered igniter that rose while settling refires once the settle is over, not before', () => {
    const env = makeCircuitWorld();
    // Battery · wire · igniter beside a keg, with an idle relay standing on the wire (its bottom contact on it): the relay is
    // expanded first on the reload and builds the igniter's network at once. Then 30 relay-switched lamps, one network a tick.
    env.fx.kegResult = () => ({ ok: false, quiet: true, message: 'refused' }); // nothing burns: only the calls count
    env.put(-9, 0, B.RELAY, Y + 1);
    env.circuits.setInputFace(-9, Y + 1, 0, 3);
    env.put(-10, 0, B.VOLTAIC_BATTERY);
    env.put(-9, 0, B.COPPER_WIRE);
    env.put(-8, 0, B.IGNITER);
    env.put(-7, 0, B.POWDER_KEG);
    relayLamps(env, 30, 40, 0);
    env.ticks(20);
    const next = reload(env);
    next.fx.kegResult = env.fx.kegResult;
    clockPerNetwork(next, CIRCUIT_TICK_BUDGET_MS);
    let hotAt = -1;
    let drained = -1;
    for (let i = 0; i < 300 && next.fx.kegs.length === 0; i++) {
      next.ticks(1);
      if (hotAt < 0 && next.circuits.probe(-8, Y, 0).state === 'hot') hotAt = next.circuits.tickCount;
      if (drained < 0 && next.circuits.stats().dirty === 0) drained = next.circuits.tickCount;
    }
    expect(hotAt).toBeGreaterThan(0);
    expect(hotAt).toBeLessThan(5); // powered early in the load …
    expect(drained).toBeGreaterThan(20); // … which settles for a long while …
    expect(next.fx.kegs.length).toBe(1); // … and the refire came only once it was over: 0.5 s (10 ticks) after its last network
    expect(next.fx.kegs[0].tick).toBeGreaterThanOrEqual(drained + 10);
    expect(next.fx.kegs[0].tick).toBeLessThanOrEqual(drained + 20);
  });

  it('the count of waiting settling marks follows the dirty flags through a settle the budget splits (what the hold reads)', () => {
    const env = makeCircuitWorld();
    seriesDeadMan(env, () => relayLamps(env, 30, 40, 0));
    const next = reload(env);
    const c = /** @type {*} */ (next.circuits);
    clockPerNetwork(next, 0.5); // four networks a tick
    const count = () => [...c._dflag.values()].filter(Boolean).length;
    expect(c._dsettle).toBe(count());
    expect(c._settlePending()).toBe(true);
    for (let i = 0; i < 120; i++) {
      next.ticks(1);
      expect(c._dsettle).toBe(count());
    }
    expect(c._settlePending()).toBe(false);
    // A burst of non-settling marks (a placed wire) counts nothing; _settleNow's look-ahead makes every waiting flag settling.
    next.put(-30, 5, B.COPPER_WIRE);
    expect(c._dsettle).toBe(0);
    expect(c._settlePending()).toBe(false);
    next.put(-31, 5, B.COPPER_WIRE);
    c._settleNow();
    expect(c._dsettle).toBe(count());
    expect(next.fx.kegs.length).toBe(0);
  });
});
