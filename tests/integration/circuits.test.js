// Circuits integration (docs/DESIGN-circuits.md §7 I-1; CONTRACTS §50–§58). Node only: no Three.js, no DOM.
//
// A REAL World over flat natural stone, one BlockPhysics, one BlackHoles, one Circuits on a CircuitStore and one Infall, wired
// with main.js's own hooks (makeCircuitHooks, makeBlackHoleWorld, physicsCircuitHooks) and stepped in main's frame order
// (§6.6: black holes → block physics → circuits → infall). The §4.14 worked examples are laid out cell for cell; the R key and
// the right mouse button go through main's rKeyStep / rightMouseStep. Saving goes through storage's serializeSave /
// deserializeSave and reloading through main's startLoading order (replaceAll, setEnabled, loadFromEdits → settling).
import { describe, it, expect } from 'vitest';
import { SAVE_VERSION, serializeSave, deserializeSave } from '../../src/storage.js';
import { BLOCK, DEFAULT_HOTBAR } from '../../src/blocks.js';
import { hexToWorld } from '../../src/hex.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { CHUNK_SIZE } from '../../src/config.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { BlackHoles, PHASE } from '../../src/blackholes.js';
import { Infall } from '../../src/infall.js';
import { CircuitStore } from '../../src/circuitStore.js';
import { Circuits } from '../../src/circuits.js';
import {
  makeCircuitHooks, makeBlackHoleWorld, physicsCircuitHooks, hotbarFrom, rKeyStep, rightMouseStep, ControlLatch, hasRAction,
  KEG_EXPLAIN,
} from '../../src/main.js';
import { inputFaceFromYaw } from '../../src/circuitParts.js';
import { flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10
const Y = GROUND + 1; // every layout stands here, on the stone
const DT = 1 / 60;

/**
 * A converged real World with everything wired as main wires it. `centre` is the column the world streams around.
 * @param {{ edits?: *, parts?: *, circuitsOn?: boolean, blackholesOn?: boolean, rd?: number, centre?: [number, number] }} [opts]
 */
function rig(opts = {}) {
  const [cq, cr] = opts.centre ?? [0, 0];
  const [cx, cz] = hexToWorld(cq, cr);
  const world = new World({ seed: 3, renderDistance: opts.rd ?? 2, worldGen: flatWorldGen(GROUND), now: () => 0, edits: opts.edits });
  const fx = { said: [], sounds: [], particles: [], events: [] };
  const blackHoles = new BlackHoles();
  const blackHoleWorld = makeBlackHoleWorld(() => world);
  /** @type {Circuits|null} */
  let circuits = null;
  const physics = new BlockPhysics(world, {
    say: (text) => fx.said.push(text),
    sound: (name) => fx.sounds.push(name),
    particles: () => {},
    bodies: () => [],
    player: () => null,
    knock: () => {},
    ...physicsCircuitHooks(() => circuits),
  });
  physics.explosions.onCharge = (q, y, r) => {
    blackHoles.activate(q, y, r, blackHoleWorld);
  };
  const store = new CircuitStore();
  store.replaceAll(opts.parts ?? null);
  const hooks = makeCircuitHooks({
    world: () => world,
    physics: () => physics,
    blackHoles,
    blackHoleWorld,
    daylight: () => 1,
    now: () => 0,
    sound: (name) => fx.sounds.push(name),
    particles: () => {},
    say: (text) => fx.said.push(text),
  });
  circuits = new Circuits(store, hooks);
  circuits.setEnabled(opts.circuitsOn !== false);
  blackHoles.setEnabled(opts.blackholesOn !== false);
  world.onChunkGenerated = (q, r) => {
    physics.onChunkGenerated(q, r);
    circuits.onChunkLoaded(q, r);
  };
  // main's onBlockChanged order (§6.6): black holes, (campfires, runes), circuits, (the panel, survival), block physics last
  world.onBlockChange = (q, y, r, prev, next) => {
    blackHoles.onBlockChange(q, y, r, prev, next);
    circuits.onBlockChange(q, y, r, prev, next);
    physics.onBlockChange(q, y, r, prev, next);
  };
  blackHoles.loadFromEdits(world.edits);
  circuits.loadFromEdits(world.edits);
  for (let i = 0; i < 800; i++) {
    const res = world.update(cx, cz, Infinity);
    if (res.pendingGen === 0 && res.pendingMesh === 0) break;
  }
  const infall = new Infall();
  const eye = [cx, Y + 1.6, cz];
  const put = (q, r, id, y = Y) => world.setBlock(q, y, r, id);
  /** One of main's frames: black holes (eats → infall, events), block physics, circuits, then the infall. */
  const frame = (dt = DT) => {
    for (const e of blackHoles.update(dt, blackHoleWorld)) infall.addBlock(e, eye[0], eye[1], eye[2]);
    blackHoles.drainEvents(fx.events);
    physics.step(dt);
    circuits.step(dt);
    infall.step(dt);
  };
  const run = (seconds) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) frame();
  };
  const runUntil = (cond, maxSeconds = 60) => {
    let t = 0;
    while (!cond() && t < maxSeconds) {
      frame();
      t += DT;
    }
    return t;
  };
  return { world, physics, ex: physics.explosions, blackHoles, circuits, store, infall, fx, put, frame, run, runUntil, eye };
}

/** A line of one id along +q at row r. */
function line(env, q0, q1, r, id, y = Y) {
  for (let q = q0; q <= q1; q++) env.put(q, r, id, y);
}

/** main's buildSaveData, the parts this test needs (§6.6: the three circuit fields after the survival ones). */
function saveOf(env, extra = {}) {
  return serializeSave({
    version: SAVE_VERSION,
    seed: 3,
    time: 0.5,
    day: 1,
    player: { x: 0, y: Y, z: 0, yaw: 0, pitch: 0, flying: false },
    hotbar: DEFAULT_HOTBAR.slice(),
    selected: 0,
    edits: env.physics.exportEdits(),
    runes: {},
    physics: env.physics.exportSwitches(),
    blackholes: env.blackHoles.enabled,
    circuits: env.circuits.enabled,
    circuitParts: env.store.export(),
    meta: { name: 'test', createdAt: 1, lastPlayed: 2 },
    ...extra,
  });
}

/** Reload a save the way main's startLoading does. */
function reloadFrom(text, opts = {}) {
  const data = deserializeSave(text);
  expect(data).not.toBeNull();
  const env = rig({ ...opts, edits: data.edits, parts: data.circuitParts ?? null, circuitsOn: data.circuits !== false,
    blackholesOn: data.blackholes !== false });
  return { env, data };
}

describe('§4.14 example 2, the timed charge: all the way to a vortex', () => {
  it('a 30 s pulse fires the igniter at 5.5 V; the charge arms, flashes, implodes and forms 1.9 s later; eaten blocks spiral in', () => {
    const env = rig();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    line(env, 2, 5, 0, B.COPPER_WIRE);
    env.put(6, 0, B.IGNITER);
    env.put(7, 0, B.COLLAPSAR_CHARGE);
    env.circuits.setInputFace(1, Y, 0, 1); // SE (unused)
    env.circuits.applySettings(1, Y, 0, { s: 30, m: 'pulse' });
    env.run(0.2);
    // Right-click the timer: main's right mouse button through the control latch winds and starts it.
    const latch = new ControlLatch();
    const hit = { q: 1, y: Y, r: 0, blockId: B.CLOCKWORK_TIMER, face: 0 };
    let placed = 0;
    const lenv = {
      isControl: (id) => hasRAction(id) && id !== B.RELAY && id !== B.COHERER_RECEIVER && id !== B.POWDER_FUSE,
      operate: (h) => env.circuits.interact(h.q, h.y, h.r, 'use'),
      hold: (h) => env.circuits.hold(h.q, h.y, h.r),
      place: () => placed++,
    };
    expect(rightMouseStep(latch, { rightPressed: true, right: true }, hit, false, DT, lenv)).toBe('operate');
    rightMouseStep(latch, { rightPressed: false, right: false }, hit, false, DT, lenv);
    expect(placed).toBe(0);
    expect(env.circuits.hintFor(1, Y, 0)).toMatch(/left · right-click: stop/);
    // 29.5 s: nothing yet.
    env.run(29.5);
    expect(env.blackHoles.arming).toBe(0);
    expect(env.world.getBlock(7, Y, 0)).toBe(B.COLLAPSAR_CHARGE);
    const t = env.runUntil(() => env.blackHoles.arming > 0 || env.blackHoles.size > 0, 2);
    expect(t).toBeLessThan(1);
    expect(env.circuits.probe(6, Y, 0).volts).toBe(5.5); // 6 − 4 × 0.125 (2 A)
    const t0 = env.runUntil(() => env.blackHoles.size > 0 && [...env.blackHoles.holes.values()][0].phase === PHASE.VORTEX, 5);
    expect(t0).toBeGreaterThan(1.7);
    expect(t0).toBeLessThan(2.1);
    expect(env.fx.events.map((e) => e.type)).toEqual(['arm', 'flash', 'implode', 'formed']);
    expect(env.world.getBlock(7, Y, 0)).toBe(B.BLACK_HOLE);
    // The vortex eats its neighbourhood: the eaten blocks (stone below, the battery's cell…) start their infall.
    env.run(2);
    expect(env.infall.blocks).toBeGreaterThan(0);
    const items = [];
    env.infall.renderItems((id, x, y, z, rx, ry, rz, s) => items.push({ id, x, y, z, s }));
    expect(items.length).toBe(env.infall.blocks);
    expect(items.every((it) => it.s > 0 && Number.isFinite(it.x + it.y + it.z))).toBe(true);
  });
});

describe('§4.14 examples 2 and 5 built walking east (the device placed right after its battery)', () => {
  const YAW_EAST = -Math.PI / 2; // looking along +X: the face back at the player is W, where the battery is
  /** main's partPlaced: the face back at the player, unless a battery stands there. */
  const placed = (env, q, r) => env.circuits.setInputFace(q, Y, r, env.circuits.placementInputFace(q, Y, r, inputFaceFromYaw(YAW_EAST)));

  it('the timed charge: the timer takes a free input face, so its contacts carry the battery and the charge goes off', () => {
    const env = rig();
    expect(inputFaceFromYaw(YAW_EAST)).toBe(3);
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    placed(env, 1, 0);
    expect(env.store.get(`1,${Y},0`)?.f).toBe(4); // NW: open air, the nearest face round from W
    line(env, 2, 5, 0, B.COPPER_WIRE);
    env.put(6, 0, B.IGNITER);
    env.put(7, 0, B.COLLAPSAR_CHARGE);
    env.circuits.applySettings(1, Y, 0, { s: 1, m: 'pulse' });
    env.run(0.2);
    expect(env.circuits.interact(1, Y, 0, 'use')?.ok).toBe(true);
    const t = env.runUntil(() => env.blackHoles.arming > 0 || env.blackHoles.size > 0, 3);
    expect(t).toBeGreaterThan(0.9);
    expect(t).toBeLessThan(1.6);
  });

  it('the radio: the coherer takes a free tapper face and the keg goes off when the transmitter sends', () => {
    const env = rig();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COHERER_RECEIVER);
    placed(env, 1, 0);
    expect(env.store.get(`1,${Y},0`)?.f).not.toBe(3);
    line(env, 2, 3, 0, B.COPPER_WIRE);
    env.put(4, 0, B.IGNITER);
    env.put(5, 0, B.POWDER_KEG);
    env.circuits.applySettings(1, Y, 0, { ch: 3, m: 'pulse' });
    env.run(0.2);
    const [x, z] = hexToWorld(20, 0);
    expect(env.circuits.pocketSend(3, x, Y + 1, z).ok).toBe(true);
    const t = env.runUntil(() => env.ex.blastCount > 0, 2);
    expect(t).toBeLessThan(0.6);
  });

  it('a battery set on the input face afterwards: the timer\'s hint and panel say why nothing fires', () => {
    const env = rig();
    env.put(1, 0, B.CLOCKWORK_TIMER);
    env.circuits.setInputFace(1, Y, 0, 3); // W
    env.put(0, 0, B.VOLTAIC_BATTERY); // … then the battery on its W face
    line(env, 2, 5, 0, B.COPPER_WIRE);
    env.put(6, 0, B.IGNITER);
    env.run(0.2);
    const why = 'the Voltaic Battery is on its input face and feeds nothing there — move it, or turn the input face (Shift+R key)';
    expect(env.circuits.hintFor(1, Y, 0)).toBe(`Clockwork Timer · ${why}`);
    expect(env.circuits.panelView(1, Y, 0, true)?.readout).toContain(`Input face: ${why}`);
    env.circuits.applySettings(1, Y, 0, { f: 1 }); // turned to SE in the panel: the battery is on a contact face now
    env.run(0.2);
    expect(env.circuits.hintFor(1, Y, 0)).toMatch(/right-click: wind and start/);
  });
});

describe('§4.14 example 4, the quarry', () => {
  /** The quarry, on rock: a 120-cell run from the plunger, 6 kegs round the igniter (5 sides and the top). */
  function quarry(env, source = 'machine') {
    const IQ = 121;
    if (source === 'machine') {
      env.put(0, 0, B.BLASTING_MACHINE);
      line(env, 1, 120, 0, B.COPPER_WIRE);
    }
    env.put(IQ, 0, B.IGNITER);
    for (const [q, r] of [[IQ + 1, 0], [IQ, 1], [IQ - 1, 1], [IQ, -1], [IQ + 1, -1]]) env.put(q, r, B.POWDER_KEG);
    env.put(IQ, 0, B.POWDER_KEG, Y + 1);
    return IQ;
  }
  const kegCells = (IQ) => [[IQ + 1, Y, 0], [IQ, Y, 1], [IQ - 1, Y, 1], [IQ, Y, -1], [IQ + 1, Y, -1], [IQ, Y + 1, 0]];

  it('plunging gives the igniter 9 V; the 6 kegs burn in place and go off as one blast 0.25 s later; undo restores them', () => {
    const env = rig({ rd: 4, centre: [60, 0] });
    const IQ = quarry(env);
    env.run(0.2);
    const res = env.circuits.interact(0, Y, 0, 'use');
    expect(res && res.ok).toBe(true);
    env.run(0.1);
    expect(env.circuits.probe(IQ, Y, 0).volts).toBe(9); // 24 − 120 × 0.125
    const burning = kegCells(IQ).filter(([q, y, r]) => env.ex.isBurning(q, y, r)).length;
    expect(burning).toBe(6);
    const tBoom = env.runUntil(() => env.ex.blastCount > 0, 2);
    expect(tBoom).toBeLessThan(0.4);
    expect(env.ex.blastCount).toBe(1); // one merged blast of 3.5·∛6
    env.run(3);
    for (const [q, y, r] of kegCells(IQ)) expect(env.world.getBlock(q, y, r)).not.toBe(B.POWDER_KEG);
    // Undo: the kegs come back (the machine's pulse is long over: the igniter is cold), and so does the igniter.
    env.run(1);
    const u = env.physics.undo();
    expect(u.ok).toBe(true);
    for (const [q, y, r] of kegCells(IQ)) expect(env.world.getBlock(q, y, r), `${q},${y},${r}`).toBe(B.POWDER_KEG);
    expect(env.world.getBlock(IQ, Y, 0)).toBe(B.IGNITER);
    expect(env.store.export()[`${IQ},${Y},0`]).toBeUndefined(); // an igniter has no settings: defaults
    env.run(2);
    expect(env.ex.blastCount).toBe(1); // nothing relights
    for (const [q, y, r] of kegCells(IQ)) expect(env.ex.isBurning(q, y, r)).toBe(false);
  });

  it('wired to a battery through a closed switch instead: undo restores no keg beside the still-powered igniter (§3.6)', () => {
    // Battery (0,0) · Knife Switch (1,0) · Copper Wire (2..19,0) · Igniter (20,0): 6 − 18 × 0.125 = 3.75 V. The battery and
    // the switch stand out of the blast's reach, so after undo restores the wire and the igniter it is powered at once.
    const env = rig({ rd: 2 });
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.KNIFE_SWITCH);
    line(env, 2, 19, 0, B.COPPER_WIRE);
    const IQ = 20;
    env.put(IQ, 0, B.IGNITER);
    for (const [q, r] of [[IQ + 1, 0], [IQ, 1], [IQ - 1, 1], [IQ, -1], [IQ + 1, -1]]) env.put(q, r, B.POWDER_KEG);
    env.put(IQ, 0, B.POWDER_KEG, Y + 1);
    env.run(0.2);
    expect(env.circuits.interact(1, Y, 0, 'use').ok).toBe(true); // close it
    env.runUntil(() => env.ex.blastCount > 0, 2);
    expect(env.ex.blastCount).toBe(1);
    env.run(3);
    expect(env.circuits.probe(0, Y, 0)).not.toBeNull(); // the battery is still there …
    expect(env.store.get(`1,${Y},0`)?.on).toBe(true); // … and the switch still closed
    const u = env.physics.undo();
    expect(u.ok).toBe(true);
    expect(env.world.getBlock(IQ, Y, 0)).toBe(B.IGNITER);
    for (const [q, y, r] of kegCells(IQ)) expect(env.world.getBlock(q, y, r), `${q},${y},${r}`).not.toBe(B.POWDER_KEG);
    expect(u.message).toMatch(/kegs or fuses next to a fire not given back/);
    env.run(2);
    expect(env.circuits.probe(IQ, Y, 0).state).toMatch(/hot/); // powered, and nothing left to light
    expect(env.ex.blastCount).toBe(1);
  });
});

describe('§4.14 example 5, the radio', () => {
  it('from 100 cells away the pocket key (a Spark Transmitter selected) sends even while the keg is targeted; it goes off', () => {
    const env = rig({ rd: 4, centre: [50, 0] });
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COHERER_RECEIVER);
    line(env, 2, 3, 0, B.COPPER_WIRE);
    env.put(4, 0, B.IGNITER);
    env.put(5, 0, B.POWDER_KEG);
    env.circuits.applySettings(1, Y, 0, { ch: 3, m: 'pulse' }); // 400 m
    env.circuits.setInputFace(1, Y, 0, 4); // the tapper's face NW (unused)
    env.run(0.2);
    // Looking at the keg with the transmitter selected: rKeyStep gives the pocket key, never the keg's explanation.
    const step = rKeyStep({ q: 5, y: Y, r: 0, blockId: B.POWDER_KEG, face: 0 }, { circuits: env.circuits, pocketSelected: true });
    expect(step).toEqual({ kind: 'pocket' });
    const [x, z] = hexToWorld(100, 0);
    const res = env.circuits.pocketSend(3, x, Y + 1, z);
    expect(res).toEqual({ ok: true, message: 'sent on 400 m: 1 receiver in range' });
    env.frame();
    env.frame();
    env.frame();
    env.frame();
    expect(env.circuits.probe(4, Y, 0).volts).toBe(5.75); // 6 − 2 × 0.125
    expect(env.ex.isBurning(5, Y, 0)).toBe(true);
    const t = env.runUntil(() => env.ex.blastCount > 0, 2);
    expect(t).toBeLessThan(0.4);
  });

  it('without the transmitter, R on the keg explains and lights nothing', () => {
    const env = rig();
    env.put(5, 0, B.POWDER_KEG);
    env.run(0.1);
    const step = rKeyStep({ q: 5, y: Y, r: 0, blockId: B.POWDER_KEG, face: 0 }, { circuits: env.circuits, pocketSelected: false });
    expect(step).toEqual({ kind: 'explain' });
    expect(KEG_EXPLAIN).toMatch(/^Powder kegs need a flame/);
    env.run(1);
    expect(env.ex.isBurning(5, Y, 0)).toBe(false);
  });
});

describe('§4.14 example 6, the fuse and the torch', () => {
  it('a torch placed at the end of 20 fuse cells: the fuse burns 8 s, the keg goes off at about 8.25 s, the fuse is gone', () => {
    const env = rig();
    env.put(0, 0, B.POWDER_KEG);
    line(env, 1, 20, 0, B.POWDER_FUSE);
    env.run(0.1);
    env.put(21, 0, B.TORCH);
    const t = env.runUntil(() => env.ex.blastCount > 0, 12);
    expect(t).toBeGreaterThan(8.0);
    expect(t).toBeLessThan(8.6);
    for (let q = 1; q <= 20; q++) expect(env.world.getBlock(q, Y, 0)).toBe(B.AIR);
  });
});

describe('undo after a blast that reached a configured circuit (CONTRACTS §55): the parts come back with their settings', () => {
  /** A stray keg goes off at (q, r) and the blast is undone. @returns {boolean} the blast destroyed the cell (cq, cr) */
  function blastAndUndo(env, q, r, cq, cr, id) {
    env.put(q, r, B.POWDER_KEG);
    env.run(0.1);
    expect(env.circuits.ignite(q, Y, r).ok).toBe(true);
    env.runUntil(() => env.ex.blastCount > 0, 5);
    env.run(2);
    const gone = env.world.getBlock(cq, Y, cr) !== id;
    expect(env.physics.undo().ok).toBe(true);
    env.run(2);
    expect(env.world.getBlock(cq, Y, cr)).toBe(id);
    return gone;
  }

  it('the dusk lamp (§4.14 example 7): its NC relay and its label come back, so the lamp stays dark by day', () => {
    const env = rig();
    env.put(0, 0, B.SELENIUM_PANEL);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    env.circuits.setInputFace(2, Y, 0, 3);
    env.circuits.applySettings(2, Y, 0, { nc: true, l: 'Dusk' });
    env.put(3, 0, B.VOLTAIC_BATTERY);
    env.put(2, 1, B.FILAMENT_LAMP);
    env.run(2);
    expect(env.circuits.probe(2, Y, 1).state).toBe('dark'); // daylight 1: the NC contacts are open
    expect(blastAndUndo(env, 3, -3, 2, 0, B.RELAY)).toBe(true);
    expect(env.store.get(`2,${Y},0`)).toMatchObject({ k: 'relay', nc: true, l: 'Dusk', f: 3 });
    expect(env.circuits.probe(2, Y, 1).state).toBe('dark');
  });

  it('the timed charge (§4.14 example 2): the timer keeps its 30 s delay and its SE input face; the battery its charge', () => {
    const env = rig();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.CLOCKWORK_TIMER);
    env.circuits.setInputFace(1, Y, 0, 1);
    env.circuits.applySettings(1, Y, 0, { s: 30, m: 'pulse' });
    line(env, 2, 5, 0, B.COPPER_WIRE);
    env.put(6, 0, B.IGNITER);
    env.put(7, 0, B.POWDER_KEG);
    env.store.setCharge(0, Y, 0, 1234);
    env.run(0.5);
    const charge = Math.round(/** @type {*} */ (env.store.get(`0,${Y},0`)).c);
    expect(blastAndUndo(env, 1, -2, 1, 0, B.CLOCKWORK_TIMER)).toBe(true);
    expect(env.store.get(`1,${Y},0`)).toMatchObject({ s: 30, m: 'pulse', f: 1 });
    expect(Math.round(/** @type {*} */ (env.store.get(`0,${Y},0`)).c)).toBe(charge);
    expect(env.circuits.hintFor(1, Y, 0)).toBe('Clockwork Timer · 30 s pulse · right-click: wind and start · Shift+R key: set');
  });

  for (const mode of ['repeat', 'hold']) {
    it(`a running ${mode} timer destroyed by its own keg comes back with its settings, stopped: the restored keg stays (§3.6)`, () => {
      const env = rig();
      // Battery (4, 0) on the timer's W contact, the igniter (6, 0) on its E contact, the keg (7, 0) beside the igniter; the
      // timer's input on SE. The keg's blast takes the battery, the timer and the igniter.
      env.put(4, 0, B.VOLTAIC_BATTERY);
      env.put(5, 0, B.CLOCKWORK_TIMER);
      env.circuits.setInputFace(5, Y, 0, 1);
      env.circuits.applySettings(5, Y, 0, { s: 1, m: mode, l: 'Quarry clock' });
      env.put(6, 0, B.IGNITER);
      env.put(7, 0, B.POWDER_KEG);
      env.run(0.5);
      expect(env.circuits.interact(5, Y, 0, 'use')?.ok).toBe(true);
      env.runUntil(() => env.ex.blastCount > 0, 6);
      expect(env.ex.blastCount).toBe(1);
      env.run(2);
      expect([4, 5, 6, 7].map((q) => env.world.getBlock(q, Y, 0))).toEqual([B.AIR, B.AIR, B.AIR, B.AIR]);
      const u = env.physics.undo();
      expect(u.ok).toBe(true);
      env.run(2 * 1 + 1); // twice its delay, and more
      expect(env.ex.blastCount).toBe(1);
      expect(u.message).not.toMatch(/not given back/);
      expect(env.world.getBlock(7, Y, 0)).toBe(B.POWDER_KEG); // given back, and nothing lights it
      expect(env.circuits.probe(6, Y, 0).state).toBe('cold');
      // Its settings came back (§55), not its running clock or latch.
      expect(env.store.get(`5,${Y},0`)).toMatchObject({ s: 1, m: mode, f: 1, l: 'Quarry clock', run: false, on: false });
      expect(env.circuits.hintFor(5, Y, 0)).toBe(`Quarry clock · Clockwork Timer · 1 s ${mode} · right-click: wind and start · Shift+R key: set`);
    });
  }

  it('a part the player breaks and places again still starts at its defaults (§4.8)', () => {
    const env = rig();
    env.put(2, 0, B.RELAY);
    env.circuits.applySettings(2, Y, 0, { nc: true, l: 'Dusk' });
    env.put(2, 0, B.AIR);
    env.put(2, 0, B.RELAY);
    expect(env.store.get(`2,${Y},0`)?.nc).toBe(false);
    expect(env.store.get(`2,${Y},0`)?.l).toBe('');
  });
});

describe('saving and reloading', () => {
  it('parts, switches, a hold-latched timer, a latched coherer and a repeat clock come back; a burning fuse does not', () => {
    const env = rig();
    // a closed knife switch with a label
    env.put(0, 0, B.KNIFE_SWITCH);
    env.circuits.applySettings(0, Y, 0, { on: true, l: 'Main' });
    // a hold timer, fired (hold latches it closed): Battery · Timer(hold, 0.5 s) · wire · lamp
    env.put(0, 3, B.VOLTAIC_BATTERY);
    env.put(1, 3, B.CLOCKWORK_TIMER);
    env.circuits.setInputFace(1, Y, 3, 1); // SE: the battery on the W face feeds the contacts, not the input
    env.circuits.applySettings(1, Y, 3, { s: 0.5, m: 'hold' });
    env.put(2, 3, B.COPPER_WIRE);
    env.put(3, 3, B.FILAMENT_LAMP);
    // a latched coherer: Battery · Coherer(latch, ch 5) · wire · bell
    env.put(0, 6, B.VOLTAIC_BATTERY);
    env.put(1, 6, B.COHERER_RECEIVER);
    env.circuits.setInputFace(1, Y, 6, 4); // the tapper on NW (unused)
    env.circuits.applySettings(1, Y, 6, { m: 'latch', ch: 5 });
    env.put(2, 6, B.COPPER_WIRE);
    env.put(3, 6, B.ELECTRIC_BELL);
    // a repeat clock
    env.put(8, 0, B.CLOCKWORK_TIMER);
    env.circuits.setInputFace(8, Y, 0, 1);
    env.circuits.applySettings(8, Y, 0, { s: 2, m: 'repeat' });
    // a burning fuse
    line(env, 8, 14, 6, B.POWDER_FUSE);
    env.run(0.2);
    env.circuits.interact(1, Y, 3, 'use'); // start the hold timer
    env.circuits.interact(8, Y, 0, 'use'); // start the repeat clock
    env.circuits.radio(5, ...hexToWorld(1, 6).flatMap((v, i) => (i === 0 ? [v, Y + 1] : [v])));
    env.circuits.ignite(14, Y, 6);
    env.run(1.2);
    expect(env.circuits.probe(3, Y, 3).state).toBe('lit');
    expect(env.circuits.probe(3, Y, 6).state).toBe('ringing');
    const burningNow = () => [8, 9, 10, 11, 12, 13, 14].filter((q) => env.circuits.burningAt(q, Y, 6) !== null);
    expect(burningNow().length).toBeGreaterThan(0);
    const text = saveOf(env);
    const { env: next, data } = reloadFrom(text);
    // the configured parts (the batteries too: their charge has drained a little)
    expect(Object.keys(data.circuitParts)).toEqual(expect.arrayContaining([`0,${Y},0`, `1,${Y},3`, `1,${Y},6`, `8,${Y},0`]));
    expect(next.store.get(`0,${Y},0`)).toMatchObject({ on: true, l: 'Main' });
    next.run(0.2);
    expect(next.circuits.probe(0, Y, 0).state).toMatch(/closed/);
    expect(next.circuits.probe(3, Y, 3).state).toBe('lit'); // the hold timer is still holding
    expect(next.circuits.probe(3, Y, 6).state).toBe('ringing'); // the coherer is still latched
    expect(next.circuits.hintFor(8, Y, 0)).toMatch(/left/); // the repeat clock runs on
    for (let q = 8; q <= 14; q++) expect(next.circuits.burningAt(q, Y, 6)).toBeNull(); // nothing burns after a reload
    next.run(3);
    expect(next.world.getBlock(9, Y, 6)).toBe(B.POWDER_FUSE); // and the rest of the fuse is still there
  });

  it('settling: an energised NC relay guards Battery → Igniter → keg; after a reload the keg is not lit (pitfall 36)', () => {
    // Battery A (0,0) → wire (1,0) → Relay (2,0) input W, NC; the relay's E contact: Battery B (3,0); its SE face: Igniter
    // (2,1) beside a keg (2,2). Energised, the NC contacts are open, so the igniter is dark.
    const env = rig();
    env.put(0, 0, B.VOLTAIC_BATTERY);
    env.put(1, 0, B.COPPER_WIRE);
    env.put(2, 0, B.RELAY);
    env.circuits.setInputFace(2, Y, 0, 3); // W
    env.circuits.applySettings(2, Y, 0, { nc: true });
    env.put(3, 0, B.VOLTAIC_BATTERY);
    env.run(0.5); // the coil pulls in first, so the NC contacts are open before the igniter is wired
    env.put(2, 1, B.IGNITER);
    env.put(2, 2, B.POWDER_KEG);
    env.run(0.5);
    expect(env.circuits.probe(2, Y, 0).state).toMatch(/energised|open/);
    expect(env.circuits.probe(2, Y, 1).volts).toBe(0);
    expect(env.ex.blastCount).toBe(0);
    const text = saveOf(env);
    const { env: next } = reloadFrom(text);
    next.run(2);
    expect(next.ex.isBurning(2, Y, 2)).toBe(false);
    expect(next.ex.blastCount).toBe(0);
    expect(next.world.getBlock(2, Y, 2)).toBe(B.POWDER_KEG);
  });

  it('an old v0.8 save with BLACK_HOLE edits and hotbar 66 loads as a vortex, with the slot holding the charge (§2.10)', () => {
    const key = chunkKey(0, 0);
    const li = localIndex(4, Y, 4);
    const text = serializeSave({
      version: SAVE_VERSION, seed: 3, time: 0.5, day: 1, player: { x: 0, y: Y, z: 0, yaw: 0, pitch: 0, flying: false },
      hotbar: [1, 2, 3, B.BLACK_HOLE, 5, 6, 7, 8, 9], selected: 3, edits: { [key]: [li, B.BLACK_HOLE] }, runes: {},
      meta: { name: 'old', createdAt: 1, lastPlayed: 2 },
    });
    const data = deserializeSave(text);
    expect(data.blackholes).toBeUndefined(); // absent: on
    const { env } = reloadFrom(text);
    expect(env.blackHoles.size).toBe(1);
    const hole = [...env.blackHoles.holes.values()][0];
    expect(hole.phase).toBe(PHASE.VORTEX); // no flash: a full vortex at once
    expect([hole.q, hole.y, hole.r]).toEqual([4, Y, 4]);
    expect(env.blackHoles.pullAt(hole.cx + 3, hole.cy, hole.cz).some((v) => v !== 0)).toBe(true);
    expect(hotbarFrom(data.hotbar)[3]).toBe(B.COLLAPSAR_CHARGE);
    expect(CHUNK_SIZE).toBeGreaterThan(4);
  });
});
