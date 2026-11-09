// Test helpers for the circuit engine (src/circuits.js, DESIGN-circuits §7 B): a Map-backed fake world (the fixtures'
// makeFakeWorld) wired to a Circuits exactly like main's hooks (§6.6), fake ignition hooks that record what they light, and a
// fake ms clock.
import { BLOCK } from '../../src/blocks.js';
import { CircuitStore } from '../../src/circuitStore.js';
import { Circuits } from '../../src/circuits.js';
import { makeFakeWorld } from './fixtures.js';

/** Natural stone for y ≤ GROUND; parts stand at y = FLOOR. */
export const GROUND = 10;
export const FLOOR = GROUND + 1;

/**
 * A fake world with a Circuits on it. `opts.store` reuses a store (a reload), `opts.world` a world, `opts.groundY` moves the
 * natural ground, `opts.groundId` its block. The fake ignition hooks record their calls in `fx.kegs` / `fx.charges` and answer
 * with `fx.kegResult` / `fx.chargeResult` when set (else ok; a keg lit twice answers quietly that it already burns).
 * `fx.daylight` drives selenium panels; `clock.ms` is hooks.now(), advanced by `clock.perCall` on every call.
 * @param {{ store?: CircuitStore, groundY?: number, groundId?: number, world?: *, enabled?: boolean }} [opts]
 */
export function makeCircuitWorld(opts = {}) {
  const world = opts.world ?? makeFakeWorld({ groundY: opts.groundY ?? GROUND, groundId: opts.groundId ?? BLOCK.STONE });
  const store = opts.store ?? new CircuitStore();
  const clock = { ms: 0, perCall: 0 };
  const fx = {
    /** @type {{ name: string, x: number, y: number, z: number, v: number }[]} */
    sounds: [],
    /** @type {{ kind: string, x: number, y: number, z: number, n: number, o: * }[]} */
    particles: [],
    /** @type {string[]} */
    said: [],
    /** @type {{ q: number, y: number, r: number, fuse: number|undefined, tick: number }[]} */
    kegs: [],
    /** @type {{ q: number, y: number, r: number, tick: number }[]} */
    charges: [],
    daylight: 1,
    /** @type {null|((q: number, y: number, r: number, fuse?: number) => { ok: boolean, message: string, quiet?: boolean })} */
    kegResult: null,
    /** @type {null|((q: number, y: number, r: number) => { ok: boolean, message: string, quiet?: boolean })} */
    chargeResult: null,
    /** @type {Set<string>} */
    burningKegs: new Set(),
  };
  /** @type {*} */
  let circuits = null;
  const hooks = {
    peek: (q, y, r) => world.peekBlock(q, y, r),
    setBlock: (q, y, r, id) => world.setBlock(q, y, r, id, true),
    isLoaded: (q, r) => world.hasChunkAtCell(q, r),
    isEdit: (q, y, r) => world.hasEdit(q, y, r),
    now: () => {
      clock.ms += clock.perCall;
      return clock.ms;
    },
    igniteKeg: (q, y, r, fuse) => {
      fx.kegs.push({ q, y, r, fuse, tick: circuits.tickCount });
      if (fx.kegResult) return fx.kegResult(q, y, r, fuse);
      const key = `${q},${y},${r}`;
      if (fx.burningKegs.has(key)) return { ok: false, quiet: true, message: `the keg at (${q}, ${y}, ${r}) is already burning` };
      fx.burningKegs.add(key);
      return { ok: true, message: `lit the powder keg at (${q}, ${y}, ${r}) — ${fuse ?? 0.25} s fuse` };
    },
    activateCharge: (q, y, r) => {
      fx.charges.push({ q, y, r, tick: circuits.tickCount });
      if (fx.chargeResult) return fx.chargeResult(q, y, r);
      return { ok: true, message: `the collapsar charge at (${q}, ${y}, ${r}) is collapsing` };
    },
    kegBurning: (q, y, r) => fx.burningKegs.has(`${q},${y},${r}`),
    daylight: () => fx.daylight,
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, n, o) => fx.particles.push({ kind, x, y, z, n, o }),
    say: (text) => fx.said.push(text),
  };
  circuits = new Circuits(store, hooks);
  if (opts.enabled === false) circuits.setEnabled(false);
  world.onBlockChange = (q, y, r, prev, next) => circuits.onBlockChange(q, y, r, prev, next);
  world.onChunkGenerated = (cq, cr) => circuits.onChunkLoaded(cq, cr);
  /** Put block `id` at (q, r) on the floor (or at height y). */
  const put = (q, r, id, y = FLOOR) => world.setBlock(q, y, r, id);
  /** Run n ticks. */
  const ticks = (n = 1) => {
    for (let i = 0; i < n; i++) circuits.tick();
  };
  return { world, store, circuits: /** @type {Circuits} */ (circuits), fx, hooks, clock, put, ticks };
}

/**
 * A fresh Circuits over the same world and store, loaded from its edits like a reload (§4.7 settling). The world's
 * onBlockChange / onChunkGenerated now feed the new engine.
 * @param {ReturnType<typeof makeCircuitWorld>} env
 * @param {{ enabled?: boolean }} [opts]
 */
export function reload(env, opts = {}) {
  const next = makeCircuitWorld({ world: env.world, store: env.store, ...opts });
  next.fx.daylight = env.fx.daylight;
  next.circuits.loadFromEdits(env.world.edits);
  return next;
}
