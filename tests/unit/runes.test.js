// Unit tests for src/runes.js — Rune Blocks: key/normalisation helpers, the RuneStore and the RuneRunner
// (CONTRACTS §27). The runner is driven against a real World (flatWorldGen), a real player and the real command
// executor, with a CommandContext shaped like the one main.js builds and world.onBlockChange wired the way main does.
import { describe, it, expect } from 'vitest';
import {
  MAX_RUNES, MAX_RUNE_SCRIPT_CHARS, MAX_RUNE_SCRIPT_LINES, MAX_RUNE_LABEL_CHARS, REPEAT_MIN_S, REPEAT_MAX_S,
  STEP_COOLDOWN_MAX_S, MAX_RUNNING_SCRIPTS, MAX_CHAIN_HOPS, CHAIN_DELAY_S, MAX_COMMANDS_PER_FRAME, MAX_CELLS_PER_FRAME,
  MAX_AREA_CHUNKS_PER_FRAME,
  WORLD_HEIGHT,
} from '../../src/config.js';
import { localIndex } from '../../src/coords.js';
import { hexToWorld, faceNeighbor, FACE_COUNT, HEX_DIRS, hexDiscCount } from '../../src/hex.js';
import { BLOCK } from '../../src/blocks.js';
import { World } from '../../src/world.js';
import { createPlayer, stepPlayer } from '../../src/physics.js';
import { flatWorldGen } from '../helpers/fixtures.js';
import {
  RUNE_DEFAULTS, SOURCE, runeKey, parseRuneKey, clampScript, normalizeRune, runeToJSON, isDefaultRune,
  normalizeRunesJSON, validateRunesJSON, hasRuneEdit, RuneStore, RuneRunner,
} from '../../src/runes.js';

const GROUND = 10;            // flatWorldGen(10): solid for y <= 10, feet rest at 11
const FEET = GROUND + 1;
const DT = 1 / 60;
const IDLE = Object.freeze({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 });
/** A cell far outside the loaded region (renderDistance 2 → data radius 3 chunks → |q|,|r| < 64). */
const FAR = Object.freeze([200, FEET, 200]);

/** Expect +0 (never -0) or a plain integer. */
function expectPlainInt(v) {
  expect(Number.isInteger(v)).toBe(true);
  expect(Object.is(v, -0)).toBe(false);
}

// ---------------------------------------------------------------------------------------------
// Rig: real World + player + store + runner + a main.js-shaped CommandContext

function makeRig() {
  const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0 });
  let r;
  do r = world.update(0, 0, Infinity); while (r.pendingGen > 0 || r.pendingMesh > 0);
  const player = createPlayer(0, FEET, 0); // cell (0, 0) centre is world (0, 0)
  const store = new RuneStore();
  const said = [];
  const logs = [];
  const triggers = [];
  let time = 0.3;
  let day = 1;
  const hotbar = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  /** @type {*} */
  const ctx = {
    world,
    player,
    controls: { yaw: Math.PI, pitch: 0 },
    getTime: () => time,
    setTime: (t) => {
      time = t;
    },
    addTime: (s) => {
      const nt = time + s / 86400;
      if (nt >= 1) day += Math.floor(nt);
      time = ((nt % 1) + 1) % 1;
    },
    timeFrozen: false,
    get hotbar() {
      return hotbar;
    },
    selected: 0,
    setHotbarSlot: (i, id) => {
      hotbar[i] = id;
    },
    say: (t) => said.push(t),
    // The directive's minimal teleport: move + seedStep (onGround preserved).
    teleport: (x, y, z) => {
      player.x = x;
      player.y = y;
      player.z = z;
      player.vx = player.vy = player.vz = 0;
      runner.seedStep();
    },
    setFlying: (b) => {
      player.flying = b;
    },
    runes: store,
    runner: null,
    rune: null,
    running: null,
    seed: 1,
  };
  const runner = new RuneRunner(store, ctx);
  ctx.runner = runner;
  runner.onLog = (line, isError) => logs.push({ line, isError });
  runner.onTrigger = (key, source) => triggers.push([key, source]);
  world.onBlockChange = (q, y, rr, prev, next) => {
    if (next === BLOCK.RUNE_BLOCK && prev !== BLOCK.RUNE_BLOCK) store.ensure(q, y, rr);
    else if (prev === BLOCK.RUNE_BLOCK && next !== BLOCK.RUNE_BLOCK) {
      runner.cancel(runeKey(q, y, rr));
      store.delete(runeKey(q, y, rr));
    }
  };
  /** Put a rune block in the world (the hook creates the entry) and apply `partial` to it. */
  function placeRune(q, y, rr, partial) {
    expect(world.setBlock(q, y, rr, BLOCK.RUNE_BLOCK)).toBe(true);
    const rune = partial ? store.set(q, y, rr, partial) : store.get(runeKey(q, y, rr));
    expect(rune).toBeTruthy();
    return /** @type {import('../../src/types.js').Rune} */ (rune);
  }
  function tick(n = 1, dt = DT) {
    let out = { executed: 0, fired: 0 };
    for (let i = 0; i < n; i++) out = runner.update(dt);
    return out;
  }
  /** Run idle physics so the player lands (onGround). */
  function settle(n = 5) {
    for (let i = 0; i < n; i++) stepPlayer(player, IDLE, world.getBlock, DT);
  }
  /** Move the player's feet to the centre of cell (q, r) at height y WITHOUT seeding (simulates walking there). */
  function standAt(q, y, rr) {
    const [x, z] = hexToWorld(q, rr);
    player.x = x;
    player.z = z;
    player.y = y + 1e-5;
    player.vx = player.vy = player.vz = 0;
    settle();
  }
  const sources = (src) => triggers.filter((t) => t[1] === src);
  return { world, player, store, runner, ctx, said, logs, triggers, hotbar, placeRune, tick, settle, standAt, sources, getDay: () => day };
}

// ---------------------------------------------------------------------------------------------
// keys

describe('runeKey / parseRuneKey', () => {
  it('round-trips and is strict', () => {
    expect(runeKey(3, 64, -2)).toBe('3,64,-2');
    expect(parseRuneKey('3,64,-2')).toEqual([3, 64, -2]);
    expect(parseRuneKey(runeKey(-7, 0, 9))).toEqual([-7, 0, 9]);
    for (const bad of [' 1,2,3', '1,2,3 ', '1,2', '1,2,3,4', '1.5,2,3', '1e1,2,3', '+1,2,3', 'a,b,c', '', '1;2;3', '1, 2, 3']) {
      expect(parseRuneKey(bad), bad).toBeNull();
    }
  });
  it('rejects y outside the world and never returns -0', () => {
    expect(parseRuneKey(`1,${WORLD_HEIGHT},1`)).toBeNull();
    expect(parseRuneKey('1,-1,1')).toBeNull();
    expect(parseRuneKey(`1,${WORLD_HEIGHT - 1},1`)).toEqual([1, WORLD_HEIGHT - 1, 1]);
    const k = parseRuneKey('-0,5,-0');
    expect(k).toEqual([0, 5, 0]);
    for (const v of /** @type {number[]} */ (k)) expectPlainInt(v);
  });
});

// ---------------------------------------------------------------------------------------------
// normalisation

describe('clampScript / normalizeRune / runeToJSON / isDefaultRune', () => {
  it('clampScript limits characters AND lines', () => {
    expect(clampScript('x'.repeat(MAX_RUNE_SCRIPT_CHARS + 500))).toHaveLength(MAX_RUNE_SCRIPT_CHARS);
    const many = Array.from({ length: MAX_RUNE_SCRIPT_LINES + 20 }, (_, i) => `say ${i}`).join('\n');
    expect(clampScript(many).split('\n')).toHaveLength(MAX_RUNE_SCRIPT_LINES);
    expect(clampScript(/** @type {*} */ (42))).toBe('');
    expect(clampScript('say a\nsay b')).toBe('say a\nsay b');
  });
  it('normalizeRune fills defaults, coerces booleans, clamps numbers and drops unknown fields', () => {
    const d = normalizeRune(1, 2, 3, null);
    expect(d).toEqual({ q: 1, y: 2, r: 3, key: '1,2,3', ...RUNE_DEFAULTS });
    const r = normalizeRune(1, 2, 3, /** @type {*} */ ({
      script: 'say hi', label: 'L'.repeat(MAX_RUNE_LABEL_CHARS + 10), enabled: 0, interact: 'yes', stepOn: 1,
      stepCooldown: -5, repeat: 'x', repeatInterval: 1e9, chain: 'false', bogus: 1, key: 'nope', q: 99,
    }));
    expect(r.q).toBe(1);
    expect(r.key).toBe('1,2,3');
    expect(r.script).toBe('say hi');
    expect(r.label).toHaveLength(MAX_RUNE_LABEL_CHARS);
    expect(r.enabled).toBe(false);
    expect(r.interact).toBe(true);
    expect(r.stepOn).toBe(true);
    expect(r.repeat).toBe(true);
    expect(r.chain).toBe(true); // Boolean('false') is true: strings are truthy
    expect(r.stepCooldown).toBe(0);
    expect(r.repeatInterval).toBe(REPEAT_MAX_S);
    expect(/** @type {*} */ (r).bogus).toBeUndefined();
    const n = normalizeRune(0, 0, 0, /** @type {*} */ ({ stepCooldown: NaN, repeatInterval: Infinity, label: 7, script: null }));
    expect(n.stepCooldown).toBe(RUNE_DEFAULTS.stepCooldown);
    expect(n.repeatInterval).toBe(RUNE_DEFAULTS.repeatInterval);
    expect(n.label).toBe('');
    expect(n.script).toBe('');
    expect(normalizeRune(0, 0, 0, { stepCooldown: 1e6 }).stepCooldown).toBe(STEP_COOLDOWN_MAX_S);
    expect(normalizeRune(0, 0, 0, { repeatInterval: 0 }).repeatInterval).toBe(REPEAT_MIN_S);
  });
  it('runeToJSON emits only non-default fields in the documented order; isDefaultRune agrees', () => {
    const d = normalizeRune(0, 0, 0, null);
    expect(runeToJSON(d)).toEqual({});
    expect(isDefaultRune(d)).toBe(true);
    const r = normalizeRune(0, 0, 0, { chain: true, script: 'say x', repeatInterval: 2 });
    expect(Object.keys(runeToJSON(r))).toEqual(['script', 'repeatInterval', 'chain']);
    expect(runeToJSON(r)).toEqual({ script: 'say x', repeatInterval: 2, chain: true });
    expect(isDefaultRune(r)).toBe(false);
    expect(isDefaultRune(normalizeRune(0, 0, 0, { interact: false }))).toBe(false);
  });
});

describe('normalizeRunesJSON / validateRunesJSON / hasRuneEdit', () => {
  it('canonicalises keys (last write wins), drops malformed keys, non-object entries and pristine runes, sorts output', () => {
    const { runes, warnings } = normalizeRunesJSON({
      '01,2,3': { script: 'first' },
      '1,2,3': { script: 'second' },
      '5,5,5': {},                         // pristine → dropped silently
      '-0,1,0': { label: 'zero' },
      'x,y,z': { script: 'bad key' },
      '1,2': { script: 'short key' },
      '2,2,2': 'not an object',
      '3,3,3': [1, 2],
      '0,0,-1': { chain: true },
    });
    expect(Object.keys(runes)).toEqual(['0,0,-1', '0,1,0', '1,2,3']);
    expect(runes['1,2,3']).toEqual({ script: 'second' });
    expect(runes['0,1,0']).toEqual({ label: 'zero' });
    expect(warnings.some((w) => w.includes('"x,y,z"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"1,2"'))).toBe(true);
    expect(warnings.filter((w) => w.includes('non-object'))).toHaveLength(2);
    expect(warnings).toHaveLength(4);
  });
  it('ignores non-object input and caps the number of entries with a warning', () => {
    expect(normalizeRunesJSON(undefined)).toEqual({ runes: {}, warnings: [] });
    expect(normalizeRunesJSON(null)).toEqual({ runes: {}, warnings: [] });
    expect(normalizeRunesJSON(/** @type {*} */ ([1])).warnings).toEqual(['runes: not an object, ignored']);
    /** @type {Record<string, object>} */
    const raw = {};
    for (let i = 0; i < MAX_RUNES + 6; i++) raw[`${i},1,0`] = { script: `say ${i}` };
    const { runes, warnings } = normalizeRunesJSON(raw);
    expect(Object.keys(runes)).toHaveLength(MAX_RUNES);
    expect(Object.keys(runes)[0]).toBe('0,1,0');
    expect(Object.keys(runes)[MAX_RUNES - 1]).toBe(`${MAX_RUNES - 1},1,0`);
    expect(warnings).toEqual([`runes: dropped 6 entries beyond the cap of ${MAX_RUNES}`]);
  });
  it('hasRuneEdit reads the LAST pair for a local index; validateRunesJSON drops orphans', () => {
    const li = localIndex(1, 5, 2);
    expect(hasRuneEdit({ '0,0': [li, BLOCK.RUNE_BLOCK] }, 1, 5, 2)).toBe(true);
    expect(hasRuneEdit({ '0,0': [li, BLOCK.RUNE_BLOCK, li, BLOCK.STONE] }, 1, 5, 2)).toBe(false);
    expect(hasRuneEdit({ '0,0': [li, BLOCK.STONE, li, BLOCK.RUNE_BLOCK] }, 1, 5, 2)).toBe(true);
    expect(hasRuneEdit({ '0,0': [li + 1, BLOCK.RUNE_BLOCK] }, 1, 5, 2)).toBe(false);
    expect(hasRuneEdit({}, 1, 5, 2)).toBe(false);
    expect(hasRuneEdit(/** @type {*} */ (null), 1, 5, 2)).toBe(false);
    // Negative cells live in negative chunks.
    const liNeg = localIndex(15, 7, 15);
    expect(hasRuneEdit({ '-1,-1': [liNeg, BLOCK.RUNE_BLOCK] }, -1, 7, -1)).toBe(true);

    const edits = { '0,0': [li, BLOCK.RUNE_BLOCK] };
    const { runes, warnings } = validateRunesJSON({ '1,5,2': { script: 'keep' }, '9,9,9': { script: 'orphan' } }, edits);
    expect(Object.keys(runes)).toEqual(['1,5,2']);
    expect(warnings).toEqual(['runes: dropped (9, 9, 9): no rune block there']);
  });
});

// ---------------------------------------------------------------------------------------------
// RuneStore

describe('RuneStore', () => {
  it('ensure creates defaults once and bumps version only on change; only STORED runes count toward the cap', () => {
    const s = new RuneStore(2);
    expect(s.version).toBe(0);
    const a = s.ensure(0, 1, 0);
    expect(a).toEqual(normalizeRune(0, 1, 0, null));
    expect(s.version).toBe(1);
    expect(s.ensure(0, 1, 0)).toBe(a); // same object, no bump
    expect(s.version).toBe(1);
    // Pristine entries (placed-but-unscripted rune blocks) are free: they are not saved, so they must not block the cap.
    expect(s.ensure(1, 1, 0)).toBeTruthy();
    expect(s.ensure(2, 1, 0)).toBeTruthy();
    expect(s.size).toBe(3);
    expect(s.storedCount).toBe(0);
    // Two stored runes fill the cap; making a third one stored is refused (the entry stays pristine).
    expect(s.set(0, 1, 0, { script: 'a' })).toBeTruthy();
    expect(s.set(1, 1, 0, { label: 'b' })).toBeTruthy();
    expect(s.storedCount).toBe(2);
    expect(s.set(2, 1, 0, { script: 'x' })).toBeNull();
    expect(/** @type {*} */ (s.get('2,1,0')).script).toBe('');
    // Editing an already-stored rune is always allowed; explicit undefined fields do not wipe existing values.
    expect(/** @type {*} */ (s.set(0, 1, 0, { script: undefined, label: 'keep' })).script).toBe('a');
    expect(s.max).toBe(2);
  });
  it('set merges and normalises; delete/clear bump; replaceAll resets the version to 0', () => {
    const s = new RuneStore();
    s.set(0, 1, 0, { script: 'say a' });
    s.set(0, 1, 0, { label: 'lbl', repeatInterval: 99999 });
    const r = /** @type {*} */ (s.get('0,1,0'));
    expect(r.script).toBe('say a');
    expect(r.label).toBe('lbl');
    expect(r.repeatInterval).toBe(REPEAT_MAX_S);
    const v = s.version;
    expect(s.delete('nope')).toBe(false);
    expect(s.version).toBe(v);
    expect(s.delete('0,1,0')).toBe(true);
    expect(s.version).toBe(v + 1);
    s.set(3, 3, 3, { chain: true });
    s.clear();
    expect(s.size).toBe(0);
    const warnings = s.replaceAll({ '2,2,2': { script: 'z' }, 'bad': { script: 'q' }, '1,1,1': {} });
    expect(warnings).toHaveLength(1);
    expect(s.version).toBe(0);
    expect(s.size).toBe(1);
    expect(/** @type {*} */ (s.get('2,2,2')).script).toBe('z');
    expect(s.replaceAll(null)).toEqual([]);
    expect(s.size).toBe(0);
  });
  it('export is sorted by (q, y, r), omits pristine entries and default fields; list is sorted', () => {
    const s = new RuneStore();
    s.set(5, 1, 0, { script: 'c' });
    s.ensure(0, 9, 9); // pristine
    s.set(-3, 1, 0, { chain: true });
    s.set(0, 0, 7, { label: 'b' });
    s.set(0, 0, -7, { label: 'a' });
    expect(Object.keys(s.export())).toEqual(['-3,1,0', '0,0,-7', '0,0,7', '5,1,0']);
    expect(s.export()['-3,1,0']).toEqual({ chain: true });
    expect(s.list().map((x) => x.key)).toEqual(['-3,1,0', '0,0,-7', '0,0,7', '0,9,9', '5,1,0']);
  });
  it('sweep removes entries whose LOADED cell is not a rune block and never touches unloaded cells', () => {
    const { world, store, placeRune } = makeRig();
    placeRune(1, FEET, 2);
    store.set(2, FEET, 2, { script: 'ghost' });        // loaded cell, AIR → swept
    store.set(FAR[0], FAR[1], FAR[2], { script: 'far' }); // unloaded → kept
    const v = store.version;
    expect(store.sweep(world)).toBe(1);
    expect(store.has('1,11,2')).toBe(true);
    expect(store.has('2,11,2')).toBe(false);
    expect(store.has(runeKey(...FAR))).toBe(true);
    expect(store.version).toBe(v + 1);
    expect(store.sweep(world)).toBe(0);
    expect(store.version).toBe(v + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// RuneRunner.trigger

describe('RuneRunner.trigger', () => {
  it('refuses an unloaded cell, a loaded non-rune cell (deleting the entry), a disabled rune', () => {
    const { runner, store, placeRune } = makeRig();
    expect(runner.trigger('garbage', SOURCE.INTERACT)).toEqual({ ok: false, reason: 'invalid rune key "garbage"' });
    store.set(FAR[0], FAR[1], FAR[2], { script: 'say far' });
    expect(runner.trigger(runeKey(...FAR), SOURCE.INTERACT).reason).toBe(`rune at (${FAR[0]}, ${FAR[1]}, ${FAR[2]}) is not loaded`);
    expect(store.has(runeKey(...FAR))).toBe(true); // unloaded entries are never deleted
    store.set(4, FEET, 4, { script: 'say ghost' });
    expect(runner.trigger('4,11,4', SOURCE.INTERACT).reason).toBe('no rune block at (4, 11, 4)');
    expect(store.has('4,11,4')).toBe(false);
    placeRune(2, FEET, 2, { script: 'say x', enabled: false });
    expect(runner.trigger('2,11,2', SOURCE.INTERACT).reason).toBe('rune at (2, 11, 2) is disabled');
  });
  it('paused refuses automatic sources only; interact and console clear the pause and start new waves', () => {
    const { runner, placeRune, triggers, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say x' });
    runner.stopAll();
    expect(runner.paused).toBe(true);
    for (const src of [SOURCE.STEP, SOURCE.REPEAT, SOURCE.CHAIN, SOURCE.RUN]) {
      expect(runner.trigger('2,11,2', src).reason).toBe('rune triggers are paused (press R on a rune or run resume)');
    }
    expect(runner.trigger('2,11,2', SOURCE.INTERACT)).toEqual({ ok: true });
    expect(runner.paused).toBe(false);
    expect(triggers).toEqual([['2,11,2', SOURCE.INTERACT]]);
    tick(2);
    runner.stopAll();
    expect(runner.trigger('2,11,2', SOURCE.CONSOLE).ok).toBe(true);
    expect(runner.paused).toBe(false);
    tick(2);
    expect(runner.waveCounter).toBe(2); // each root activation is a new wave
  });
  it('refuses a running rune, the hop cap, a repeated wave, and the running-script cap', () => {
    const { runner, placeRune, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'wait 5' });
    expect(runner.trigger('2,11,2', SOURCE.INTERACT).ok).toBe(true);
    expect(runner.trigger('2,11,2', SOURCE.INTERACT).reason).toBe('rune at (2, 11, 2) is already running');
    expect(runner.isRunning('2,11,2')).toBe(true);

    placeRune(3, FEET, 2, { script: 'say h' });
    expect(runner.trigger('3,11,2', SOURCE.CHAIN, { wave: 99, hops: MAX_CHAIN_HOPS + 1 }).reason).toBe(`chain limit reached (${MAX_CHAIN_HOPS} hops)`);
    expect(runner.trigger('3,11,2', SOURCE.CHAIN, { wave: 99, hops: MAX_CHAIN_HOPS }).ok).toBe(true);
    tick(1); // runs and finishes
    expect(runner.isRunning('3,11,2')).toBe(false);
    expect(runner.trigger('3,11,2', SOURCE.CHAIN, { wave: 99, hops: 1 }).reason).toBe('rune at (3, 11, 2) already ran in this activation');
    expect(runner.trigger('3,11,2', SOURCE.CHAIN, { wave: 100, hops: 1 }).ok).toBe(true);

    // Cap: fill the running set with waiting scripts (all in chunk (0,0), q 0..7 × r 0..8).
    const { runner: r2, placeRune: place2 } = makeRig();
    const keys = [];
    for (let i = 0; i < MAX_RUNNING_SCRIPTS + 1; i++) {
      const q = i % 8;
      const rr = Math.floor(i / 8);
      place2(q, FEET + 2, rr, { script: 'wait 60' });
      keys.push(runeKey(q, FEET + 2, rr));
    }
    for (let i = 0; i < MAX_RUNNING_SCRIPTS; i++) expect(r2.trigger(keys[i], SOURCE.INTERACT).ok).toBe(true);
    expect(r2.runningCount).toBe(MAX_RUNNING_SCRIPTS);
    expect(r2.trigger(keys[MAX_RUNNING_SCRIPTS], SOURCE.INTERACT).reason).toBe(`too many running scripts (${MAX_RUNNING_SCRIPTS})`);
  });
  it('a rune block with no store entry runs as the default rune (entry created); onTrigger fires', () => {
    const { world, runner, store, triggers, tick, said } = makeRig();
    expect(world.setBlock(1, FEET, 1, BLOCK.RUNE_BLOCK)).toBe(true);
    store.delete('1,11,1'); // simulate a block that never got an entry
    expect(runner.trigger('1,11,1', SOURCE.INTERACT)).toEqual({ ok: true });
    expect(store.has('1,11,1')).toBe(true);
    expect(triggers).toEqual([['1,11,1', SOURCE.INTERACT]]);
    tick(2);
    expect(said).toEqual([]);
    expect(runner.getLastRun('1,11,1')).toEqual({ commands: 0, errors: 0, cancelled: false, source: SOURCE.INTERACT });
  });
  it('logs at most 3 parse errors at start (then a suppression line) while the valid lines still run', () => {
    const { runner, placeRune, logs, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'bogus 1\nnope\nzzz\nqqq\nwww\nsay ok' });
    expect(runner.trigger('2,11,2', SOURCE.INTERACT).ok).toBe(true);
    const errs = logs.filter((l) => l.isError);
    expect(errs).toHaveLength(3);
    expect(errs[0].line).toBe('[2,11,2:1] unknown command "bogus" (try help)');
    expect(logs.some((l) => l.line === '[2,11,2] … more parse errors suppressed' && !l.isError)).toBe(true);
    tick(1);
    expect(said).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------------------------
// RuneRunner.update

describe('RuneRunner.update — execution', () => {
  it('runs a script, counts commands, and runs @-relative commands around the rune', () => {
    const { world, runner, placeRune, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'setblock @ @1 @ stone\nsay done' });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    const r = tick(1);
    expect(r.executed).toBe(2);
    expect(world.getBlock(2, FEET + 1, 2)).toBe(BLOCK.STONE);
    expect(said).toEqual(['done']);
    expect(runner.isRunning('2,11,2')).toBe(false);
    expect(runner.getLastRun('2,11,2')).toEqual({ commands: 2, errors: 0, cancelled: false, source: SOURCE.INTERACT });
  });
  it('a script that replaces its own block is cancelled at that command: the rest never runs and nothing chains', () => {
    const { world, runner, store, placeRune, said, tick, triggers } = makeRig();
    placeRune(2, FEET, 2, { script: 'setblock @ @ @ stone\nsay after', chain: true });
    placeRune(3, FEET, 2, { script: 'say neighbour' });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(20);
    expect(world.getBlock(2, FEET, 2)).toBe(BLOCK.STONE);
    expect(store.has('2,11,2')).toBe(false);
    expect(said).toEqual([]);
    expect(triggers.map((t) => t[0])).toEqual(['2,11,2']);
    expect(runner.getLastRun('2,11,2')).toMatchObject({ cancelled: true });
  });
  it('waits expire by frame dt, resume in the same update, and never carry leftover time', () => {
    const { runner, placeRune, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say a\nwait 0.1\nsay b\nwait 0.1\nsay c' });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(1, 0.07); // a, then wait 0.1
    expect(said).toEqual(['a']);
    tick(1, 0.07); // 0.03 left
    expect(said).toEqual(['a']);
    tick(1, 0.07); // expired (-0.04 → 0): b runs this update, next wait starts fresh at 0.1
    expect(said).toEqual(['a', 'b']);
    tick(1, 0.07); // 0.03 left (a carried -0.04 would already have fired c)
    expect(said).toEqual(['a', 'b']);
    tick(1, 0.07);
    expect(said).toEqual(['a', 'b', 'c']);
    expect(runner.isRunning('2,11,2')).toBe(false);
  });
  it('round-robins the per-frame command budget so a second script is never starved', () => {
    const { runner, placeRune, said, tick } = makeRig();
    const n = 100;
    placeRune(2, FEET, 2, { script: Array.from({ length: n }, () => 'say A').join('\n') });
    placeRune(3, FEET, 2, { script: Array.from({ length: n }, () => 'say B').join('\n') });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    runner.trigger('3,11,2', SOURCE.INTERACT);
    const r = tick(1);
    expect(r.executed).toBe(MAX_COMMANDS_PER_FRAME);
    expect(said.filter((s) => s === 'A')).toHaveLength(MAX_COMMANDS_PER_FRAME / 2);
    expect(said.filter((s) => s === 'B')).toHaveLength(MAX_COMMANDS_PER_FRAME / 2);
    expect(said.slice(0, 4)).toEqual(['A', 'B', 'A', 'B']);
    tick(10);
    expect(said).toHaveLength(2 * n);
    expect(runner.runningCount).toBe(0);
  });
  it('advances area jobs under the per-frame cell budget, in order, and logs a summary', () => {
    const { world, runner, placeRune, logs, tick } = makeRig();
    // 7931 cells: two frames at MAX_CELLS_PER_FRAME = 4096. Area starts above the player (y 20..30), away from the rune.
    const small = hexDiscCount(10) * 3;     // 993 → one frame
    const big = hexDiscCount(15) * 11;      // 7931 → two frames
    expect(small).toBeLessThan(MAX_CELLS_PER_FRAME);
    expect(big).toBeGreaterThan(MAX_CELLS_PER_FRAME);
    expect(big).toBeLessThan(2 * MAX_CELLS_PER_FRAME);
    placeRune(20, FEET, 0, { script: 'hexfill 0 20 0 10 3 glass' });
    runner.trigger('20,11,0', SOURCE.INTERACT);
    tick(1);
    // 993 cells fit one frame's cell budget, but the disc straddles 4 chunk columns and a job writes at most
    // MAX_AREA_CHUNKS_PER_FRAME of them per frame (that is what bounds the re-mesh hitch of thin, wide fills).
    expect(runner.isRunning('20,11,0')).toBe(true);
    tick(Math.ceil(4 / MAX_AREA_CHUNKS_PER_FRAME) - 1);
    expect(runner.isRunning('20,11,0')).toBe(false);
    expect(logs.at(-1)).toEqual({ line: `[20,11,0] hexfill: ${small} cells set to glass`, isError: false });
    expect(world.getBlock(0, 20, 0)).toBe(BLOCK.GLASS);
    expect(world.getBlock(10, 22, -5)).toBe(BLOCK.GLASS);
    expect(world.getBlock(11, 22, 0)).toBe(BLOCK.AIR);

    placeRune(21, FEET, 0, { script: 'hexfill 0 40 0 15 11 bricks\nsay filled' });
    runner.trigger('21,11,0', SOURCE.INTERACT);
    tick(1);
    expect(runner.isRunning('21,11,0')).toBe(true); // still filling: more than one frame's cells
    let frames = 1;
    while (runner.isRunning('21,11,0') && frames < 10) {
      tick(1);
      frames++;
    }
    expect(runner.isRunning('21,11,0')).toBe(false);
    expect(frames).toBeLessThanOrEqual(Math.ceil(big / MAX_CELLS_PER_FRAME) + Math.ceil(4 / MAX_AREA_CHUNKS_PER_FRAME));
    expect(logs.some((l) => l.line === `[21,11,0] hexfill: ${big} cells set to bricks`)).toBe(true);
    expect(world.getBlock(-15, 50, 0)).toBe(BLOCK.BRICKS);
  });
  it('a failing command logs "[q,y,r:LINE] message" and the script continues', () => {
    const { runner, placeRune, logs, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: `setblock 0 ${WORLD_HEIGHT + 5} 0 stone\nsay next\ntp ${FAR[0]} ${FAR[2]}\nsay last` });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(1);
    const errs = logs.filter((l) => l.isError);
    expect(errs).toHaveLength(2);
    expect(errs[0].line.startsWith(`[2,11,2:1] setblock: y must be 0..${WORLD_HEIGHT - 1}`)).toBe(true);
    expect(errs[1].line.startsWith('[2,11,2:3] tp: target is not loaded')).toBe(true);
    expect(said).toEqual(['next', 'last']);
    expect(runner.getLastRun('2,11,2')).toMatchObject({ commands: 4, errors: 2, cancelled: false });
  });
});

describe('RuneRunner.update — chains', () => {
  it('fans out to all 8 face neighbours in face order after CHAIN_DELAY_S (FIFO); non-rune neighbours are skipped', () => {
    const { runner, placeRune, said, tick } = makeRig();
    const [q, y, r] = [2, FEET + 3, 2]; // floating, so every neighbour cell is free
    placeRune(q, y, r, { script: 'say A', chain: true });
    const expected = ['A'];
    for (let f = 0; f < FACE_COUNT; f++) {
      const [nq, ny, nr] = faceNeighbor(q, y, r, f);
      if (f === 3) continue; // leave one side empty: must be skipped silently
      placeRune(nq, ny, nr, { script: `say n${f}` });
      expected.push(`say n${f}`.slice(4));
    }
    runner.trigger(runeKey(q, y, r), SOURCE.INTERACT);
    tick(1, 0.05); // A runs; neighbours queued with due 0.1 − 0.05
    expect(said).toEqual(['A']);
    tick(1, 0.05); // due reaches 0 → triggered this update, they run next update
    expect(said).toEqual(['A']);
    tick(1, 0.05);
    expect(said).toEqual(expected);
    expect(CHAIN_DELAY_S).toBe(0.1);
  });
  it('the wave rule runs each rune once per activation: a 2-cycle and a ring terminate without re-running', () => {
    const { runner, placeRune, said, tick, triggers } = makeRig();
    // 2-cycle.
    placeRune(2, FEET, 2, { script: 'say A', chain: true });
    const [bq, , br] = faceNeighbor(2, FEET, 2, 0);
    placeRune(bq, FEET, br, { script: 'say B', chain: true });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(40);
    expect(said).toEqual(['A', 'B']);
    expect(triggers).toHaveLength(2);
    // Ring of six chained runes around an empty centre, high up and away from the pair.
    said.length = 0;
    triggers.length = 0;
    const cy = FEET + 20;
    const keys = HEX_DIRS.map(([dq, dr]) => {
      placeRune(10 + dq, cy, 10 + dr, { script: `say r${dq},${dr}`, chain: true });
      return runeKey(10 + dq, cy, 10 + dr);
    });
    runner.trigger(keys[0], SOURCE.INTERACT);
    tick(80);
    expect(said).toHaveLength(6);
    expect(new Set(said).size).toBe(6);
    expect(triggers.filter((t) => t[1] === SOURCE.CHAIN)).toHaveLength(5);
    // A new interact is a new wave: the whole ring runs again, once.
    runner.trigger(keys[0], SOURCE.INTERACT);
    tick(80);
    expect(said).toHaveLength(12);
  });
  it('`stop` ends a script without chaining; a chained neighbour does not need its own chain flag; `run` propagates the wave', () => {
    const { runner, placeRune, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say A\nstop\nsay never', chain: true });
    placeRune(3, FEET, 2, { script: 'say B' });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(30);
    expect(said).toEqual(['A']);
    expect(runner.getLastRun('2,11,2')).toMatchObject({ commands: 2, cancelled: false });

    said.length = 0;
    placeRune(5, FEET, 5, { script: 'say C', chain: true });
    placeRune(6, FEET, 5, { script: 'say D\nrun 5 11 5' }); // tries to run C again in the same wave
    runner.trigger('5,11,5', SOURCE.INTERACT);
    tick(30);
    expect(said).toEqual(['C', 'D']);
    expect(runner.getLastRun('6,11,5')).toMatchObject({ errors: 1 }); // the `run` was refused (same wave)
  });
});

describe('RuneRunner.update — repeat', () => {
  it('fires every interval while idle and loaded; the accumulator is held at 0 while the script runs', () => {
    const { placeRune, sources, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say R', repeat: true, repeatInterval: 0.5 });
    tick(20, 0.25); // 5 s
    expect(sources(SOURCE.REPEAT)).toHaveLength(10);

    // Fires at update 2 (0.5 s); the script's `wait 2` keeps it running through update 11 with the accumulator
    // pinned at 0, so the next fire is a full interval AFTER it finishes (update 12), not in the same update.
    const rig = makeRig();
    rig.placeRune(2, FEET, 2, { script: 'wait 2\nsay slow', repeat: true, repeatInterval: 0.5 });
    rig.tick(11, 0.25);
    expect(rig.sources(SOURCE.REPEAT)).toHaveLength(1);
    expect(rig.said).toEqual(['slow']);
    rig.tick(1, 0.25);
    expect(rig.sources(SOURCE.REPEAT)).toHaveLength(2);
  });
  it('is frozen while the rune\'s chunk is unloaded and resumes from where it was', () => {
    const { world, placeRune, sources, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say R', repeat: true, repeatInterval: 1 });
    const orig = world.hasChunkAtCell.bind(world);
    world.hasChunkAtCell = (q, r) => (q === 2 && r === 2 ? false : orig(q, r));
    tick(40, 0.25); // 10 s "unloaded": nothing
    expect(sources(SOURCE.REPEAT)).toHaveLength(0);
    world.hasChunkAtCell = orig;
    tick(3, 0.25);
    expect(sources(SOURCE.REPEAT)).toHaveLength(0);
    tick(1, 0.25); // 1.0 s after reloading
    expect(sources(SOURCE.REPEAT)).toHaveLength(1);
  });
  it('is suppressed while paused and by a disabled rune', () => {
    const { runner, placeRune, sources, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say R', repeat: true, repeatInterval: 0.5 });
    runner.stopAll();
    tick(20, 0.25);
    expect(sources(SOURCE.REPEAT)).toHaveLength(0);
    runner.resume();
    tick(2, 0.25);
    expect(sources(SOURCE.REPEAT)).toHaveLength(1);
    const rig = makeRig();
    rig.placeRune(2, FEET, 2, { script: 'say R', repeat: true, repeatInterval: 0.5, enabled: false });
    rig.tick(20, 0.25);
    expect(rig.sources(SOURCE.REPEAT)).toHaveLength(0);
  });
});

describe('RuneRunner.update — step-on', () => {
  it('fires once when the player comes to stand on a rune block, not while standing still, again after the cooldown', () => {
    const { placeRune, standAt, sources, tick } = makeRig();
    placeRune(3, GROUND, 0, { script: 'say step', stepOn: true, stepCooldown: 1 });
    standAt(0, FEET, 0);
    tick(3);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    standAt(3, FEET, 0); // "walked" onto the rune (no seeding)
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(1);
    tick(120); // standing still for 2 s: no re-fire
    expect(sources(SOURCE.STEP)).toHaveLength(1);
    standAt(0, FEET, 0);
    tick(1);
    standAt(3, FEET, 0); // back immediately: cooldown (1 s) has long elapsed → fires
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(2);
    // Off and on again within the cooldown: blocked.
    standAt(0, FEET, 0);
    tick(1);
    standAt(3, FEET, 0);
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(2);
    tick(70); // > 1 s later, still standing: no fire (edge-triggered)
    expect(sources(SOURCE.STEP)).toHaveLength(2);
    standAt(0, FEET, 0);
    tick(1);
    standAt(3, FEET, 0);
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(3);
  });
  it('requires the stepOn trigger, an enabled rune and not paused; airborne players support nothing', () => {
    const { runner, player, placeRune, standAt, sources, tick } = makeRig();
    placeRune(3, GROUND, 0, { script: 'say step' }); // stepOn off
    standAt(3, FEET, 0);
    tick(2);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    placeRune(4, GROUND, 0, { script: 'say step', stepOn: true, enabled: false });
    standAt(4, FEET, 0);
    tick(2);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    placeRune(5, GROUND, 0, { script: 'say step', stepOn: true });
    runner.stopAll();
    standAt(5, FEET, 0);
    tick(2);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    runner.resume();
    standAt(0, FEET, 0);
    tick(1);
    standAt(5, FEET, 0);
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(1);
    // Jump: airborne frames support nothing; landing on the same rune within the cooldown does not re-fire.
    player.vy = 5;
    player.onGround = false;
    tick(1);
    expect(runner.prevSupport.size).toBe(0);
  });
  it('seedStep makes the current support set "already entered": a teleport that preserves onGround never fires', () => {
    const { ctx, placeRune, standAt, sources, tick } = makeRig();
    placeRune(3, GROUND, 0, { script: 'say step', stepOn: true });
    standAt(0, FEET, 0);
    tick(1);
    const [x, z] = hexToWorld(3, 0);
    ctx.teleport(x, FEET + 1e-5, z); // directive-style teleport: move + seedStep, onGround kept
    tick(5);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    standAt(0, FEET, 0);
    tick(1);
    standAt(3, FEET, 0);
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(1);
  });
  it('a teleport that clears onGround (as main.js game.teleport does) must not count as stepping on the rune', () => {
    // CONTRACTS §27.1: "seedStep() sets S_prev from the current position (spawn, teleport), so arriving on a rune is not
    // stepping onto it." main.js sets player.onGround = false before calling runner.seedStep(); the landing frame must
    // therefore still be treated as "already entered".
    const { runner, player, world, placeRune, standAt, sources, tick } = makeRig();
    placeRune(3, GROUND, 0, { script: 'say step', stepOn: true });
    standAt(0, FEET, 0);
    tick(1);
    const [x, z] = hexToWorld(3, 0);
    player.x = x;
    player.y = FEET; // exactly on the cell top, as findFreeY places it
    player.z = z;
    player.vx = player.vy = player.vz = 0;
    player.onGround = false;
    runner.seedStep();
    for (let i = 0; i < 10; i++) {
      stepPlayer(player, IDLE, world.getBlock, DT);
      runner.update(DT);
    }
    expect(player.onGround).toBe(true);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
  });
});

describe('RuneRunner — stopAll / resume / reset / cancel', () => {
  it('stopAll cancels every script (no chains), drops pending chains and pauses; resume lifts the pause', () => {
    const { runner, placeRune, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'say A\nwait 1\nsay A2', chain: true });
    placeRune(3, FEET, 2, { script: 'say B' });
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(1);
    expect(said).toEqual(['A']);
    expect(runner.stopAll()).toBe(1);
    expect(runner.runningCount).toBe(0);
    expect(runner.paused).toBe(true);
    tick(120);
    expect(said).toEqual(['A']);
    expect(runner.getLastRun('2,11,2')).toMatchObject({ cancelled: true, commands: 2 });
    runner.resume();
    expect(runner.paused).toBe(false);
    expect(runner.trigger('3,11,2', SOURCE.CHAIN, { wave: 5, hops: 1 }).ok).toBe(true);
  });
  it('cancel on a running key returns true and never chains; on an idle key returns false', () => {
    const { runner, placeRune, said, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'wait 5\nsay A', chain: true });
    placeRune(3, FEET, 2, { script: 'say B' });
    expect(runner.cancel('2,11,2')).toBe(false);
    runner.trigger('2,11,2', SOURCE.INTERACT);
    expect(runner.cancel('2,11,2')).toBe(true);
    tick(60);
    expect(said).toEqual([]);
  });
  it('reset forgets everything', () => {
    const { runner, placeRune, standAt, tick } = makeRig();
    placeRune(2, FEET, 2, { script: 'wait 5', repeat: true, repeatInterval: 1, stepOn: true, chain: true });
    standAt(2, FEET + 1, 2);
    runner.trigger('2,11,2', SOURCE.INTERACT);
    tick(3);
    runner.stopAll();
    runner.reset();
    expect(runner.runningCount).toBe(0);
    expect(runner.paused).toBe(false);
    expect(runner.waveCounter).toBe(0);
    expect(runner.lastWave.size).toBe(0);
    expect(runner.repeatAcc.size).toBe(0);
    expect(runner.cooldown.size).toBe(0);
    expect(runner.prevSupport.size).toBe(0);
    expect(runner.getLastRun('2,11,2')).toBeUndefined();
    expect(runner.pending).toEqual([]);
  });
});

describe('RuneRunner.runConsoleLine', () => {
  it('executes synchronously without a rune: results, @ error, script-only commands refused', () => {
    const { runner } = makeRig();
    expect(runner.runConsoleLine('pos').ok).toBe(true);
    expect(runner.runConsoleLine('pos').message.startsWith('cell 0 11 0')).toBe(true);
    expect(runner.runConsoleLine('setblock @ @ @ stone')).toEqual({ ok: false, message: 'setblock: @ is only valid inside a rune script — usage: setblock q y r <block>' });
    expect(runner.runConsoleLine('wait 1').message).toBe('wait: wait is only valid inside a rune script — usage: wait <seconds>');
    expect(runner.runConsoleLine('stop').message).toBe('stop: stop is only valid inside a rune script — usage: stop');
    expect(runner.runConsoleLine('nonsense')).toEqual({ ok: false, message: 'unknown command "nonsense" (try help)' });
    expect(runner.runConsoleLine('   ')).toEqual({ ok: true, message: '' });
    expect(runner.runConsoleLine('# just a comment')).toEqual({ ok: true, message: '' });
  });
  it('queues an area job as console#N, which update() completes and summarises; `run` from the console is a root activation', () => {
    const { world, runner, placeRune, logs, tick, said } = makeRig();
    const res = runner.runConsoleLine('hexfill 0 30 0 15 11 glass');
    const total = hexDiscCount(15) * 11;
    expect(res).toEqual({ ok: true, message: `hexfill: ${total} cells queued (runs while you play)` });
    expect(runner.isRunning('console#1')).toBe(true);
    tick(1);
    expect(runner.isRunning('console#1')).toBe(true); // > MAX_CELLS_PER_FRAME cells: never one frame
    // The disc spans 4 chunk columns at ≤ MAX_AREA_CHUNKS_PER_FRAME per frame and ≤ MAX_CELLS_PER_FRAME cells per frame.
    let frames = 1;
    while (runner.isRunning('console#1') && frames < 10) {
      tick(1);
      frames++;
    }
    expect(runner.isRunning('console#1')).toBe(false);
    expect(frames).toBeLessThanOrEqual(Math.ceil(total / MAX_CELLS_PER_FRAME) + Math.ceil(4 / MAX_AREA_CHUNKS_PER_FRAME));
    expect(logs.at(-1)).toEqual({ line: `hexfill: ${total} cells set to glass`, isError: false });
    expect(world.getBlock(0, 30, 0)).toBe(BLOCK.GLASS);

    placeRune(2, FEET, 2, { script: 'say A' });
    const run = runner.runConsoleLine('run 2 11 2');
    expect(run).toEqual({ ok: true, message: 'running rune (2, 11, 2)' });
    tick(1);
    expect(said).toEqual(['A']);
    expect(runner.waveCounter).toBe(1);
    expect(runner.runConsoleLine('run 9 9 9').ok).toBe(false);
    expect(runner.runConsoleLine('runes').message).toContain('2 11 2 · (no label) · R · idle');
  });
});

// ---------------------------------------------------------------------------------------------
// Regressions from the v0.3 adversarial review.
describe('RuneRunner — review regressions', () => {
  /** main.js-style teleport: clears onGround BEFORE seeding (physics lands the player on later frames). */
  function mainStyleTeleport(ctx, runner, player) {
    ctx.teleport = (x, y, z) => {
      player.x = x;
      player.y = y;
      player.z = z;
      player.vx = player.vy = player.vz = 0;
      player.onGround = false;
      runner.seedStep();
    };
  }
  /** One game frame as main.js orders it: physics, then the runner. */
  function frame(world, player, runner) {
    stepPlayer(player, IDLE, world.getBlock, DT);
    runner.update(DT);
  }

  it('a teleport executed by a SCRIPT (mid-update) onto a step-on pad never fires the pad', () => {
    const { ctx, runner, player, world, placeRune, standAt, sources, tick } = makeRig();
    mainStyleTeleport(ctx, runner, player);
    placeRune(1, FEET, 1, { script: `tp 4 ${FEET} 4` });
    placeRune(4, GROUND, 4, { script: 'say pad', stepOn: true });
    standAt(0, FEET, 0);
    tick(1);
    expect(runner.trigger('1,11,1', SOURCE.INTERACT).ok).toBe(true);
    for (let i = 0; i < 30; i++) frame(world, player, runner);
    expect(player.onGround).toBe(true);
    expect(sources(SOURCE.STEP)).toHaveLength(0);
    // Walking off and back on still counts as stepping on.
    standAt(0, FEET, 0);
    tick(1);
    standAt(4, FEET, 4);
    tick(1);
    expect(sources(SOURCE.STEP)).toHaveLength(1);
  });

  it('the sample "lift" (step-on + tp 4 cells up) does not re-trigger itself when the player lands back on it', () => {
    const { ctx, runner, player, world, placeRune, standAt, sources, said } = makeRig();
    mainStyleTeleport(ctx, runner, player);
    placeRune(1, GROUND, 0, { script: 'say up\nwait 0.2\ntp @ @4 @', stepOn: true, chain: true });
    standAt(0, FEET, 0);
    runner.update(DT);
    standAt(1, FEET, 0);
    runner.update(DT);
    expect(sources(SOURCE.STEP)).toHaveLength(1);
    let maxY = player.y;
    for (let i = 0; i < 600; i++) {
      frame(world, player, runner);
      maxY = Math.max(maxY, player.y);
    }
    expect(maxY).toBeGreaterThanOrEqual(FEET + 3); // it did lift the player (to @4 = FEET + 3)
    expect(player.onGround).toBe(true);
    expect(player.y).toBeCloseTo(FEET, 3); // and they are back on the pad
    expect(sources(SOURCE.STEP)).toHaveLength(1); // ten seconds of standing there: no second firing
    expect(said).toEqual(['up']);
  });

  it('chain fan-out honours Chain/Enabled as they are when the script FINISHES, not when it started', () => {
    const { store, runner, placeRune, said, tick } = makeRig();
    placeRune(0, FEET, 2, { script: 'wait 0.3\nsay a', chain: true });
    placeRune(1, FEET, 2, { script: 'say b' });
    expect(runner.trigger('0,11,2', SOURCE.INTERACT).ok).toBe(true);
    tick(1);
    store.set(0, FEET, 2, { chain: false }); // the editor replaces the store entry mid-run
    tick(40);
    expect(said).toEqual(['a']);
    // And the other way round: chain switched ON while running fans out when it finishes.
    expect(runner.trigger('0,11,2', SOURCE.INTERACT).ok).toBe(true);
    tick(1);
    store.set(0, FEET, 2, { chain: true });
    tick(40);
    expect(said).toEqual(['a', 'a', 'b']);
  });
});
