// Unit tests for src/commands.js — the command language shared by the console and Rune Block scripts (CONTRACTS §26).
import { describe, it, expect, vi } from 'vitest';
import {
  WORLD_HEIGHT, PITCH_LIMIT, MAX_FILL_CELLS, MAX_TOTAL_EDITS, WAIT_MIN_S, WAIT_MAX_S, HOTBAR_SIZE,
  MAX_RUNE_SCRIPT_LINES, AREA_MAX_RADIUS, AREA_MAX_HEIGHT, GAME_SECONDS_PER_DAY, PIG_MAX,
  ZOMBIE_MAX, ZOMBIE_RADIUS, ZOMBIE_HEIGHT,
} from '../../src/config.js';
import { hexToWorld, worldToHex, hexDiscCount } from '../../src/hex.js';
import { BLOCK, BLOCKS, BLOCK_COUNT, isPlaceable } from '../../src/blocks.js';
import { formatTime } from '../../src/daynight.js';
import { World } from '../../src/world.js';
import { createPlayer } from '../../src/physics.js';
import { RuneStore } from '../../src/runes.js';
import { Pigs } from '../../src/pigs.js';
import { Zombies } from '../../src/zombies.js';
import { Watcher } from '../../src/watcher.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { ITEM_KEYS } from '../../src/items.js';
import { flatWorldGen } from '../helpers/fixtures.js';
import {
  COMMANDS, HELP_FOOTER, COMPASS, parseLine, parseScript, resolveBlock, parseTimeSpec, parseDurationSpec,
  yawToDegrees, hexAreaCells, executeCommand,
} from '../../src/commands.js';

const GROUND = 10; // flatWorldGen(10): solid for y <= 10, feet rest at 11
const FEET = GROUND + 1;
const B = BLOCK;

// ---------------------------------------------------------------------------------------------
// helpers

/** A converged flat world (renderDistance 2 → chunks within hex distance 3 of (0,0) are loaded). */
function makeWorld() {
  const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0 });
  let r;
  do r = world.update(0, 0, Infinity);
  while (r.pendingGen > 0 || r.pendingMesh > 0);
  return world;
}

/**
 * A CommandContext over a real World, a player standing at the centre of cell (0, 0), a real RuneStore and a
 * spied runner. `over` overrides fields.
 */
function makeCtx(over = {}) {
  const world = makeWorld();
  const [px, pz] = hexToWorld(0, 0);
  const player = createPlayer(px, FEET, pz);
  const state = { time: 0.5, day: 1 };
  const store = new RuneStore();
  const runner = {
    trigger: vi.fn(() => ({ ok: true })),
    stopAll: vi.fn(() => 0),
    resume: vi.fn(),
    cancel: vi.fn(),
    isRunning: vi.fn(() => false),
  };
  const ctx = {
    world,
    player,
    controls: { yaw: 0, pitch: 0 },
    getTime: () => state.time,
    setTime: (t) => {
      state.time = t;
    },
    addTime: (s) => {
      const nt = state.time + s / GAME_SECONDS_PER_DAY;
      if (nt >= 1) state.day += Math.floor(nt);
      state.time = ((nt % 1) + 1) % 1;
    },
    timeFrozen: false,
    hotbar: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    selected: 0,
    setHotbarSlot: vi.fn((i, id) => {
      ctx.hotbar[i] = id;
    }),
    say: vi.fn(),
    teleport: vi.fn((x, y, z) => {
      player.x = x;
      player.y = y;
      player.z = z;
    }),
    setFlying: vi.fn((b) => {
      player.flying = b;
    }),
    runes: store,
    runner,
    rune: null,
    running: null,
    seed: world.seed,
    ...over,
  };
  return { ctx, world, player, state, store, runner };
}

/** Parse one line (must be a command) and execute it. */
function exec(ctx, line) {
  const p = parseLine(line);
  if (p === null || !('name' in p)) throw new Error(`exec: not a command: ${JSON.stringify(p)}`);
  return executeCommand(p, ctx);
}

/** A rune for `@` resolution. */
function runeAt(q, y, r) {
  return { q, y, r, key: `${q},${y},${r}`, script: '', label: '', enabled: true, interact: true, stepOn: false, stepCooldown: 1, repeat: false, repeatInterval: 5, chain: false };
}

// ---------------------------------------------------------------------------------------------

describe('command table', () => {
  it('has unique names, usages that start with the name, and min <= args.length', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(c.name)).toBe(true);
      expect(c.min).toBeLessThanOrEqual(c.args.length);
      expect(typeof c.summary).toBe('string');
    }
    expect(names).toEqual(expect.arrayContaining(['help', 'tp', 'tpw', 'setblock', 'fill', 'hexfill', 'hexring', 'time', 'say', 'run', 'wait', 'stop', 'stopall', 'runes', 'rune']));
    expect(COMMANDS.filter((c) => c.scriptOnly).map((c) => c.name).sort()).toEqual(['stop', 'wait']);
    // v0.9: `mode` is the only console-only command, and no command is both
    expect(COMMANDS.filter((c) => c.consoleOnly).map((c) => c.name)).toEqual(['mode']);
    expect(COMMANDS.filter((c) => c.scriptOnly && c.consoleOnly)).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['mode', 'vitals', 'pack', 'items']));
    expect(HELP_FOOTER).toHaveLength(3);
    expect(COMPASS).toEqual({ north: 0, west: 90, south: 180, east: -90 });
  });
});

describe('parseLine', () => {
  it('ignores blank lines and lines whose first non-blank character is #', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('# a comment')).toBeNull();
    expect(parseLine('   # indented comment')).toBeNull();
    expect(parseLine('/')).toBeNull();
    expect(parseLine('/   ')).toBeNull();
  });

  it('accepts an optional leading slash and is case-insensitive on the command name', () => {
    const a = parseLine('/SetBlock 1 2 3 stone');
    const b = parseLine('setblock 1 2 3 stone');
    expect(a && 'name' in a && a.name).toBe('setblock');
    expect(b && 'name' in b && b.args).toEqual(['1', '2', '3', 'stone']);
    expect(a && 'raw' in a && a.raw).toBe('SetBlock 1 2 3 stone');
    const c = parseLine('/  pos');
    expect(c && 'name' in c && c.name).toBe('pos');
  });

  it('say takes the rest of the line verbatim (no quoting, # is not special inside)', () => {
    const s = parseLine('say   Floor #3 is "open"  ');
    expect(s && 'args' in s && s.args).toEqual(['Floor #3 is "open"']);
    expect(parseLine('say')).toMatchObject({ message: expect.stringContaining('— usage: say <text>') });
  });

  it('reports unknown commands with the help hint and the line number', () => {
    expect(parseLine('foo 1 2', 7)).toEqual({ line: 7, message: 'unknown command "foo" (try help)' });
  });

  it('reports argument-count mismatches with the expected args and the usage line', () => {
    expect(parseLine('tp 1')).toEqual({ line: 1, message: 'tp: expected q y r (got 1 arg) — usage: tp q y r | tp q r' });
    expect(parseLine('tp 1 2 3 4')).toMatchObject({ message: expect.stringMatching(/^tp: expected q y r \(got 4 args\) — usage: /) });
    expect(parseLine('stop now')).toMatchObject({ message: 'stop: expected no arguments (got 1 arg) — usage: stop' });
    // An inline "# comment" after a command is NOT a comment: it is extra arguments.
    expect(parseLine('setblock 0 0 0 stone # roof')).toMatchObject({ message: expect.stringContaining('— usage: setblock q y r <block>') });
  });

  it('accepts the number grammar for cell/num args and rejects anything else', () => {
    for (const tok of ['~', '~-3', '~+2', '@', '@2', '@-1', '.5', '3.', '-7', '+4', '0', '12.25', '~.5']) {
      const r = parseLine(`tpw ${tok} 1 2`);
      expect(r && 'name' in r, tok).toBe(true);
    }
    for (const tok of ['1e3', '0x10', '--1', '~~', 'abc', '1,5', '∞', '-', '+', '~-']) {
      const r = parseLine(`tpw ${tok} 1 2`);
      expect(r && 'message' in r, tok).toBe(true);
      expect(r.message, tok).toMatch(/^tpw: expected a number for x, got ".*" — usage: tpw x y z$/);
    }
  });

  it('int args must be plain integer literals (no ~/@, no fractions)', () => {
    expect(parseLine('hexfill 0 0 0 3 2 stone') && 'name' in /** @type {*} */ (parseLine('hexfill 0 0 0 3 2 stone'))).toBe(true);
    expect(parseLine('hexfill 0 0 0 ~3 2 stone')).toMatchObject({ message: expect.stringContaining('radius must be a plain integer, got "~3"') });
    expect(parseLine('hexfill 0 0 0 3 2.5 stone')).toMatchObject({ message: expect.stringContaining('height must be a plain integer, got "2.5"') });
    expect(parseLine('give stone 1.5')).toMatchObject({ message: expect.stringContaining('slot must be a plain integer') });
  });

  it('angle args accept compass words or numbers', () => {
    expect(parseLine('look NORTH 0')).toMatchObject({ name: 'look', args: ['NORTH', '0'] });
    expect(parseLine('look ~15 ~')).toMatchObject({ name: 'look' });
    expect(parseLine('look up 0')).toMatchObject({ message: expect.stringContaining('expected a number for yaw, got "up"') });
  });

  it('choice args are validated and lower-cased', () => {
    expect(parseLine('fly ON')).toMatchObject({ args: ['on'] });
    expect(parseLine('time SET noon')).toMatchObject({ args: ['set', 'noon'] });
    // The argument label is best effort (derived from the usage text); the stable parts are the prefix, the option list and the usage.
    const fly = parseLine('fly sideways');
    expect(fly && 'message' in fly && fly.message).toBe('fly: expected one of on, off, toggle, got "sideways" — usage: fly on|off|toggle');
    expect(parseLine('rune 0 0 0 maybe')).toMatchObject({ message: 'rune: expected one of on, off, got "maybe" — usage: rune q y r on|off' });
    expect(parseLine('time maybe noon')).toMatchObject({ message: expect.stringContaining('time: expected one of set, add, got "maybe"') });
  });
});

describe('parseScript', () => {
  it('collects commands and errors with 1-based line numbers; blank/comment lines count toward numbering', () => {
    const { commands, errors } = parseScript('\n# header\nsay hi\n\nfoo\nsetblock ~ ~1 ~ stone\n');
    expect(commands.map((c) => [c.line, c.name])).toEqual([[3, 'say'], [6, 'setblock']]);
    expect(errors).toEqual([{ line: 5, message: 'unknown command "foo" (try help)' }]);
  });

  it('accepts CRLF line endings', () => {
    const { commands, errors } = parseScript('say a\r\nsay b\r\n');
    expect(commands.map((c) => c.args[0])).toEqual(['a', 'b']);
    expect(errors).toEqual([]);
  });

  it('allows exactly MAX_RUNE_SCRIPT_LINES lines and reports one error beyond that', () => {
    const ok = parseScript(Array.from({ length: MAX_RUNE_SCRIPT_LINES }, () => 'pos').join('\n'));
    expect(ok.commands).toHaveLength(MAX_RUNE_SCRIPT_LINES);
    expect(ok.errors).toEqual([]);
    const over = parseScript(Array.from({ length: MAX_RUNE_SCRIPT_LINES + 1 }, () => 'pos').join('\n'));
    expect(over.commands).toHaveLength(MAX_RUNE_SCRIPT_LINES);
    expect(over.errors).toEqual([{ line: MAX_RUNE_SCRIPT_LINES + 1, message: `too many lines (${MAX_RUNE_SCRIPT_LINES + 1} > ${MAX_RUNE_SCRIPT_LINES}); lines after ${MAX_RUNE_SCRIPT_LINES} are dropped` }]);
  });

  it('never throws on odd input', () => {
    expect(parseScript(undefined)).toEqual({ commands: [], errors: [] });
    expect(parseScript(null)).toEqual({ commands: [], errors: [] });
    expect(parseScript(42).commands).toEqual([]);
  });
});

describe('resolveBlock', () => {
  it('resolves exact names, display names with underscores, ids, and strips minecraft:', () => {
    expect(resolveBlock('stone')).toEqual({ id: B.STONE });
    expect(resolveBlock('wool_red')).toEqual({ id: B.WOOL_RED });
    expect(resolveBlock('red_wool')).toEqual({ id: B.WOOL_RED });
    expect(resolveBlock('Grass_Block')).toEqual({ id: B.GRASS_BLOCK });
    expect(resolveBlock('minecraft:stone')).toEqual({ id: B.STONE });
    expect(resolveBlock('MINECRAFT:Oak_Planks')).toEqual({ id: B.OAK_PLANKS });
    expect(resolveBlock('0')).toEqual({ id: B.AIR });
    expect(resolveBlock(String(BLOCK_COUNT - 1))).toEqual({ id: BLOCK_COUNT - 1 });
    expect(resolveBlock('rune_block')).toEqual({ id: B.RUNE_BLOCK });
  });

  it('resolves unique prefixes and substrings, and lists ambiguous candidates', () => {
    expect(resolveBlock('oak_plank')).toEqual({ id: B.OAK_PLANKS });
    expect(resolveBlock('cobble')).toEqual({ id: B.COBBLESTONE });
    expect(resolveBlock('diamond_o')).toEqual({ id: B.DIAMOND_ORE });
    // CONTRACT-ISSUE: DESIGN-survival §8.1 names blocks 78/79 honeyberry_bush(_bare), so the prefix "honey" stopped being
    // unique (it named honeycomb_block before v0.9). W0 changed this line to keep the suite green; package C (owner) keeps
    // the change: resolveBlock's rules are unchanged, and an ambiguous prefix listing every candidate is the intended result.
    expect(resolveBlock('honeyc')).toEqual({ id: B.HONEYCOMB_BLOCK });
    expect(resolveBlock('honey')).toEqual({ error: 'ambiguous block "honey": honeycomb_block, honeyberry_bush, honeyberry_bush_bare' });
    expect(resolveBlock('light_blue_wool')).toEqual({ id: B.WOOL_LIGHT_BLUE });
    expect(resolveBlock('block_of_gold')).toEqual({ id: B.GOLD_BLOCK });
    expect(resolveBlock('diamond')).toEqual({ error: 'ambiguous block "diamond": diamond_ore, diamond_block' });
    expect(resolveBlock('plank')).toEqual({ error: 'ambiguous block "plank": oak_planks, spruce_planks, birch_planks' });
    expect(resolveBlock('shelf')).toEqual({ id: B.BOOKSHELF }); // substring
    const amb = resolveBlock('wool');
    expect('error' in amb && amb.error).toMatch(/^ambiguous block "wool": wool_white, wool_red, wool_orange, .*, wool_light_gray$/);
  });

  it('rejects unknown names, out-of-range ids and empty tokens with helpful messages', () => {
    expect(resolveBlock('zzz')).toEqual({ error: 'unknown block "zzz" (type blocks to list them)' });
    expect(resolveBlock(String(BLOCK_COUNT))).toEqual({ error: `unknown block id ${BLOCK_COUNT} (0..${BLOCK_COUNT - 1}; type blocks to list them)` });
    expect(resolveBlock('-1')).toEqual({ error: `unknown block id -1 (0..${BLOCK_COUNT - 1}; type blocks to list them)` });
    expect(resolveBlock('')).toEqual({ error: 'expected a block name' });
    expect(resolveBlock(undefined)).toEqual({ error: 'expected a block name' });
  });
});

describe('parseTimeSpec', () => {
  it('maps the named times, HH:MM, bare hours and fractions', () => {
    expect(parseTimeSpec('noon')).toBe(0.5);
    expect(parseTimeSpec('MIDNIGHT')).toBe(0);
    expect(parseTimeSpec('day')).toBe(0.25);
    expect(parseTimeSpec('night')).toBe(0.75);
    expect(parseTimeSpec('06:30')).toBeCloseTo(6.5 / 24, 12);
    expect(parseTimeSpec('0:00')).toBe(0);
    expect(parseTimeSpec('23:59')).toBeCloseTo((23 * 60 + 59) / 1440, 12);
    expect(parseTimeSpec('12')).toBe(0.5);
    expect(parseTimeSpec('0')).toBe(0);
    expect(parseTimeSpec('24')).toBe(0);
    expect(parseTimeSpec('0.75')).toBe(0.75);
    expect(parseTimeSpec('.5')).toBe(0.5);
    expect(parseTimeSpec('1.0')).toBe(0);
  });

  it('rejects out-of-range and malformed specs', () => {
    for (const bad of ['24:00', '12:60', '25', '100', '1.5', '-0.1', 'dawn', '', '6:5', '1e-1', '12:00pm']) {
      expect(parseTimeSpec(bad), bad).toBeNull();
    }
  });
});

describe('parseDurationSpec', () => {
  it('parses HH:MM, unit suffixes, day fractions and bare game seconds, with signs', () => {
    expect(parseDurationSpec('1:00')).toBe(3600);
    expect(parseDurationSpec('-0:30')).toBe(-1800);
    expect(parseDurationSpec('100:05')).toBe(100 * 3600 + 300);
    expect(parseDurationSpec('1h')).toBe(3600);
    expect(parseDurationSpec('1.5h')).toBe(5400);
    expect(parseDurationSpec('15m')).toBe(900);
    expect(parseDurationSpec('45s')).toBe(45);
    expect(parseDurationSpec('-2H')).toBe(-7200);
    expect(parseDurationSpec('0.5')).toBe(GAME_SECONDS_PER_DAY / 2);
    expect(parseDurationSpec('-.25')).toBe(-GAME_SECONDS_PER_DAY / 4);
    expect(parseDurationSpec('3600')).toBe(3600);
    expect(parseDurationSpec('+30')).toBe(30);
    expect(parseDurationSpec('-90')).toBe(-90);
  });

  it('rejects fractions above one day, bad clocks and words', () => {
    for (const bad of ['1.5', '0:60', 'abc', '', '1e3', '2d', '--5', '1:5']) {
      expect(parseDurationSpec(bad), bad).toBeNull();
    }
  });
});

describe('yawToDegrees / hexAreaCells', () => {
  it('yawToDegrees is the F3 convention: [-180, 180)', () => {
    expect(yawToDegrees(0)).toBe(0);
    expect(yawToDegrees(Math.PI / 2)).toBeCloseTo(90, 9);
    expect(yawToDegrees(-Math.PI / 2)).toBeCloseTo(-90, 9);
    expect(yawToDegrees(Math.PI)).toBeCloseTo(-180, 9);
    expect(yawToDegrees(3 * Math.PI)).toBeCloseTo(-180, 9);
  });

  it('hexAreaCells enumerates discs and rings over the requested layers', () => {
    expect(hexAreaCells(0, 5, 0, 0, 1, false)).toEqual([[0, 5, 0]]);
    expect(hexAreaCells(0, 5, 0, 0, 1, true)).toEqual([[0, 5, 0]]);
    expect(hexAreaCells(2, 5, -3, 2, 3, false)).toHaveLength(hexDiscCount(2) * 3);
    const ring = hexAreaCells(0, 5, 0, 2, 1, true);
    expect(ring).toHaveLength(12);
    for (const [q, y, r] of ring) {
      expect(y).toBe(5);
      expect(Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r))).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('executeCommand — coordinates', () => {
  it('~ is relative to the player cell / floor(y); plain numbers are absolute', () => {
    const { ctx, world } = makeCtx();
    const res = exec(ctx, 'setblock ~ ~-1 ~ glass');
    expect(res).toEqual({ ok: true, message: 'set glass at (0, 10, 0)' });
    expect(world.getBlock(0, 10, 0)).toBe(B.GLASS);
    expect(exec(ctx, 'setblock ~2 ~1 ~-1 glass')).toEqual({ ok: true, message: 'set glass at (2, 12, -1)' });
  });

  it('~ uses the cell containing the player, not floor(x)/floor(z)', () => {
    const { ctx, world } = makeCtx();
    // World (0.3, 0.5) floors to (0, 0) but lies in cell (0, 1).
    ctx.player.x = 0.3;
    ctx.player.z = 0.5;
    expect(worldToHex(0.3, 0.5)).toEqual([0, 1]);
    expect(exec(ctx, 'setblock ~ ~-1 ~ glass').message).toBe('set glass at (0, 10, 1)');
    expect(world.getBlock(0, 10, 1)).toBe(B.GLASS);
  });

  it('@ is relative to the executing rune and an error in the console', () => {
    const { ctx, world } = makeCtx();
    expect(exec(ctx, 'setblock @ @ @ stone')).toEqual({ ok: false, message: 'setblock: @ is only valid inside a rune script — usage: setblock q y r <block>' });
    ctx.rune = runeAt(3, 11, 4);
    ctx.running = { wave: 1, hops: 0 };
    expect(exec(ctx, 'setblock @ @1 @ stone')).toEqual({ ok: true, message: 'set stone at (3, 12, 4)' });
    expect(world.getBlock(3, 12, 4)).toBe(B.STONE);
    expect(exec(ctx, 'setblock @-1 @2 @1 stone').message).toBe('set stone at (2, 13, 5)');
  });

  it('cell arguments must resolve to integers', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'setblock ~0.5 ~ ~ stone')).toEqual({ ok: false, message: 'setblock: expected an integer for q, got "~0.5" — usage: setblock q y r <block>' });
    expect(exec(ctx, 'setblock 1 2.5 3 stone').message).toContain('expected an integer for y, got "2.5"');
    expect(exec(ctx, 'fill 0 0 0 1 1 .5 stone').message).toContain('expected an integer for r2, got ".5"');
  });
});

describe('executeCommand — tp / tpw / look', () => {
  it('tp q y r lands at the cell centre, snapping up to two cells to the first free height', () => {
    const { ctx, player } = makeCtx();
    expect(exec(ctx, 'tp 5 11 5')).toEqual({ ok: true, message: 'teleported to cell 5 11 5' });
    const [x, z] = hexToWorld(5, 5);
    expect(ctx.teleport).toHaveBeenCalledTimes(1);
    expect(player.x).toBeCloseTo(x, 12);
    expect(player.z).toBeCloseTo(z, 12);
    expect(player.y).toBe(11);
    // y = 9 is inside the ground; 11 is the first free height within +2.
    expect(exec(ctx, 'tp 6 9 6')).toEqual({ ok: true, message: 'teleported to cell 6 11 6' });
    expect(player.y).toBe(11);
  });

  it('tp refuses targets inside blocks, outside the height range, or in unloaded chunks', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'tp 5 8 5')).toEqual({ ok: false, message: 'tp: target is inside a block — usage: tp q y r | tp q r' });
    // The player is PLAYER_HEIGHT tall, so the highest feet cell is WORLD_HEIGHT - 2 (never "inside a block" for an air column).
    expect(exec(ctx, 'tp 5 200 5').message).toBe(`tp: y must be 0..${WORLD_HEIGHT - 2} — usage: tp q y r | tp q r`);
    expect(exec(ctx, 'tp 5 -1 5').message).toContain(`y must be 0..${WORLD_HEIGHT - 2}`);
    expect(exec(ctx, `tp 5 ${WORLD_HEIGHT - 1} 5`).message).toContain(`y must be 0..${WORLD_HEIGHT - 2}`);
    expect(exec(ctx, 'tp 200 11 0')).toEqual({ ok: false, message: 'tp: target is not loaded — usage: tp q y r | tp q r' });
    expect(exec(ctx, 'tp 200 0').message).toBe('tp: target is not loaded — usage: tp q y r | tp q r');
    expect(ctx.teleport).not.toHaveBeenCalled();
  });

  it('tp q r stands the player on the surface of that column', () => {
    const { ctx, player, world } = makeCtx();
    expect(exec(ctx, 'tp -3 4')).toEqual({ ok: true, message: 'teleported to cell -3 11 4' });
    const [x, z] = hexToWorld(-3, 4);
    expect(player.x).toBeCloseTo(x, 12);
    expect(player.z).toBeCloseTo(z, 12);
    expect(player.y).toBe(FEET);
    // A pillar raises the surface.
    world.setBlock(2, 11, 2, B.STONE);
    world.setBlock(2, 12, 2, B.STONE);
    expect(exec(ctx, 'tp 2 2').message).toBe('teleported to cell 2 13 2');
    // A column with no standable spot (full to the top) is refused.
    for (let y = FEET; y < WORLD_HEIGHT; y++) world.setBlock(3, y, 3, B.STONE);
    expect(exec(ctx, 'tp 3 3')).toEqual({ ok: false, message: 'tp: no ground at (3, 3) — usage: tp q y r | tp q r' });
  });

  it('tpw takes world floats (~ relative to the position), snaps up and refuses unloaded / out-of-range targets', () => {
    const { ctx, player } = makeCtx();
    expect(exec(ctx, 'tpw 7.5 11 4.33')).toEqual({ ok: true, message: 'teleported to 7.50 11.00 4.33' });
    expect(player.x).toBe(7.5);
    expect(exec(ctx, 'tpw ~1 ~-2 ~').message).toBe('teleported to 8.50 11.00 4.33'); // y 9 → first free height within +2 is 11
    expect(exec(ctx, 'tpw ~ ~-3 ~').message).toBe('tpw: target is inside a block — usage: tpw x y z'); // y 8: 8, 9, 10 are all solid
    expect(exec(ctx, 'tpw 0 127 0').message).toBe(`tpw: y must be 0..${WORLD_HEIGHT - 2} — usage: tpw x y z`);
    expect(exec(ctx, 'tpw 300 11 0').message).toBe('tpw: target is not loaded — usage: tpw x y z');
    expect(exec(ctx, 'tpw 0 3 0').message).toBe('tpw: target is inside a block — usage: tpw x y z');
  });

  it('tpw @ is the rune centre and the cell above it', () => {
    const { ctx, player } = makeCtx();
    ctx.rune = runeAt(4, 10, -2);
    ctx.running = { wave: 1, hops: 0 };
    expect(exec(ctx, 'tpw @ @ @').ok).toBe(true);
    const [x, z] = hexToWorld(4, -2);
    expect(player.x).toBeCloseTo(x, 12);
    expect(player.z).toBeCloseTo(z, 12);
    expect(player.y).toBe(11);
  });

  it('look accepts compass words and degrees (~ relative), wraps yaw and clamps pitch', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'look north 0')).toEqual({ ok: true, message: 'looking yaw 0.0 pitch 0.0' });
    expect(exec(ctx, 'look east 10').ok).toBe(true);
    expect(ctx.controls.yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(ctx.controls.pitch).toBeCloseTo((10 * Math.PI) / 180, 12);
    expect(exec(ctx, 'look WEST ~').ok).toBe(true);
    expect(ctx.controls.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(exec(ctx, 'look 450 0').message).toBe('looking yaw 90.0 pitch 0.0');
    expect(ctx.controls.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(exec(ctx, 'look ~30 0').message).toBe('looking yaw 120.0 pitch 0.0');
    expect(exec(ctx, 'look 0 100').ok).toBe(true);
    expect(ctx.controls.pitch).toBeCloseTo(PITCH_LIMIT, 12);
    expect(exec(ctx, 'look 0 -100').ok).toBe(true);
    expect(ctx.controls.pitch).toBeCloseTo(-PITCH_LIMIT, 12);
    expect(exec(ctx, 'look south 0').ok).toBe(true);
    expect(Math.abs(ctx.controls.yaw)).toBeCloseTo(Math.PI, 12);
  });
});

describe('executeCommand — setblock', () => {
  it('sets a block and reports it; the same block is "already"', () => {
    const { ctx, world } = makeCtx();
    expect(exec(ctx, 'setblock 1 12 1 bricks')).toEqual({ ok: true, message: 'set bricks at (1, 12, 1)' });
    expect(world.getBlock(1, 12, 1)).toBe(B.BRICKS);
    const v = world.editVersion;
    expect(exec(ctx, 'setblock 1 12 1 bricks')).toEqual({ ok: true, message: 'cell (1, 12, 1) is already bricks' });
    expect(world.editVersion).toBe(v);
  });

  it('refuses a solid block in a cell the player occupies, bedrock, unloaded chunks and bad y', () => {
    const { ctx, world } = makeCtx();
    expect(exec(ctx, 'setblock 0 11 0 stone')).toEqual({ ok: false, message: 'setblock: that cell is occupied by you — usage: setblock q y r <block>' });
    expect(exec(ctx, 'setblock 0 12 0 stone').message).toContain('occupied by you'); // head cell
    expect(exec(ctx, 'setblock 0 13 0 stone').ok).toBe(true); // above the head
    expect(exec(ctx, 'setblock 0 11 0 water').ok).toBe(true); // non-solid is fine where the player stands
    world.setBlock(2, 0, 2, B.BEDROCK);
    expect(exec(ctx, 'setblock 2 0 2 stone')).toEqual({ ok: false, message: 'setblock: bedrock cannot be replaced — usage: setblock q y r <block>' });
    expect(exec(ctx, 'setblock 200 11 0 stone')).toEqual({ ok: false, message: 'setblock: cell (200, 11, 0) is not loaded — usage: setblock q y r <block>' });
    expect(exec(ctx, 'setblock 1 128 1 stone').message).toBe(`setblock: y must be 0..${WORLD_HEIGHT - 1} — usage: setblock q y r <block>`);
    expect(exec(ctx, 'setblock 1 2 3 nothing').message).toBe('setblock: unknown block "nothing" (type blocks to list them) — usage: setblock q y r <block>');
  });

  it('rune_block is allowed via setblock and the world hook sees the change', () => {
    const { ctx, world } = makeCtx();
    const changes = [];
    world.onBlockChange = (q, y, r, prev, next) => changes.push([q, y, r, prev, next]);
    expect(exec(ctx, 'setblock 3 11 3 rune_block').ok).toBe(true);
    expect(world.getBlock(3, 11, 3)).toBe(B.RUNE_BLOCK);
    expect(changes).toEqual([[3, 11, 3, B.AIR, B.RUNE_BLOCK]]);
  });
});

describe('executeCommand — area commands', () => {
  it('fill addresses the inclusive box in any corner order and returns a resumable job', () => {
    const { ctx, world } = makeCtx();
    const res = exec(ctx, 'fill 3 20 3 0 20 0 glass');
    expect(res.ok).toBe(true);
    expect(res.message).toBe('');
    expect(res.job).toBeDefined();
    const job = res.job;
    expect(job.total).toBe(16);
    expect(job.done).toBe(false);
    expect(world.getBlock(0, 20, 0)).toBe(B.AIR); // nothing written until step()
    expect(job.step(5)).toBe(5);
    expect(job.cursor).toBe(5);
    expect(job.done).toBe(false);
    expect(job.step(100)).toBe(11);
    expect(job.done).toBe(true);
    expect(job.written).toBe(16);
    expect(job.summary()).toBe('fill: 16 cells set to glass');
    for (let q = 0; q <= 3; q++) for (let r = 0; r <= 3; r++) expect(world.getBlock(q, 20, r)).toBe(B.GLASS);
    expect(job.step(10)).toBe(0);
  });

  it('writes in chunk-major order so a budgeted step stays inside one chunk', () => {
    const { ctx, world } = makeCtx();
    const job = exec(ctx, 'fill 14 20 0 17 20 0 glass').job;
    expect(job.step(2)).toBe(2);
    expect(world.getBlock(14, 20, 0)).toBe(B.GLASS);
    expect(world.getBlock(15, 20, 0)).toBe(B.GLASS);
    expect(world.getBlock(16, 20, 0)).toBe(B.AIR);
    expect(world.getBlock(17, 20, 0)).toBe(B.AIR);
    job.step(10);
    expect(world.getBlock(17, 20, 0)).toBe(B.GLASS);
  });

  it('skips rune blocks, bedrock and cells the player occupies, and counts unchanged cells', () => {
    const { ctx, world } = makeCtx();
    world.setBlock(1, 12, 0, B.RUNE_BLOCK);
    world.setBlock(2, 12, 0, B.BEDROCK);
    world.setBlock(3, 12, 0, B.STONE);
    // Box q 0..3, y 12, r 0: (0,12,0) is the player's head cell.
    const job = exec(ctx, 'fill 0 12 0 3 12 0 stone').job;
    job.step(100);
    expect(job.done).toBe(true);
    expect([job.written, job.unchanged, job.skippedRune, job.skippedPlayer, job.skippedBedrock]).toEqual([0, 1, 1, 1, 1]);
    expect(job.summary()).toBe('fill: 0 cells set to stone (1 unchanged, skipped 1 rune block, skipped 1 occupied by you, skipped 1 bedrock)');
    expect(world.getBlock(0, 12, 0)).toBe(B.AIR);
    expect(world.getBlock(1, 12, 0)).toBe(B.RUNE_BLOCK);
    expect(world.getBlock(2, 12, 0)).toBe(B.BEDROCK);
    // Non-solid blocks may be filled where the player stands, and filling AIR over a rune still skips it.
    const air = exec(ctx, 'fill 0 12 0 1 12 0 air').job;
    air.step(10);
    expect([air.written, air.unchanged, air.skippedRune]).toEqual([0, 1, 1]);
    const water = exec(ctx, 'fill 0 11 0 0 12 0 water').job;
    water.step(10);
    expect(water.written).toBe(2);
    expect(water.skippedPlayer).toBe(0);
  });

  it('refuses oversized boxes before writing anything, with the cell count in the message', () => {
    const { ctx, world } = makeCtx();
    const v = world.editVersion;
    const res = exec(ctx, 'fill 0 0 0 40 20 40 stone'); // 41·21·41 = 35301
    expect(res).toEqual({ ok: false, message: `fill: too large: 35301 cells (max ${MAX_FILL_CELLS}) — lower the size — usage: fill q1 y1 r1 q2 y2 r2 <block>` });
    expect(world.editVersion).toBe(v);
    // Exactly the cap is fine: 32 × 32 × 32 = 32768.
    expect(exec(ctx, 'fill 0 20 0 31 51 31 glass').ok).toBe(true);
    expect(exec(ctx, 'fill 0 20 0 31 52 31 glass').message).toContain(`too large: ${33 * 32 * 32} cells`);
  });

  it('hexfill / hexring count cells from radius × height and enforce the shared cap and parse bounds', () => {
    const { ctx, world } = makeCtx();
    const disc = exec(ctx, 'hexfill 0 20 0 1 2 stone');
    expect(disc.job.total).toBe(hexDiscCount(1) * 2);
    // The 7 columns of the disc straddle three chunk columns; one step writes at most MAX_AREA_CHUNKS_PER_FRAME of them.
    expect(disc.job.step(1000)).toBe(8);
    expect(disc.job.done).toBe(false);
    expect(disc.job.summary()).toBe('hexfill: 8 cells set to stone');
    expect(disc.job.step(1000)).toBe(6);
    expect(disc.job.done).toBe(true);
    expect(disc.job.summary()).toBe('hexfill: 14 cells set to stone');
    expect(world.getBlock(0, 21, 0)).toBe(B.STONE);
    expect(world.getBlock(2, 20, 0)).toBe(B.AIR);
    const ring = exec(ctx, 'hexring 0 30 0 2 1 glass');
    expect(ring.job.total).toBe(12);
    const point = exec(ctx, 'hexring 0 30 0 0 3 glass');
    expect(point.job.total).toBe(3);
    expect(exec(ctx, 'hexfill 0 20 0 64 10 stone').message).toBe(`hexfill: too large: ${hexDiscCount(64) * 10} cells (max ${MAX_FILL_CELLS}) — lower radius or height — usage: hexfill q y r radius height <block>`);
    expect(exec(ctx, `hexring 0 20 0 ${AREA_MAX_RADIUS + 1} 1 stone`).message).toContain(`radius must be 0..${AREA_MAX_RADIUS}`);
    expect(exec(ctx, 'hexfill 0 20 0 1 0 stone').message).toContain(`height must be 1..${AREA_MAX_HEIGHT}`);
    expect(exec(ctx, 'hexfill 0 20 0 -1 1 stone').message).toContain('radius must be 0..');
  });

  it('refuses y outside the world for any addressed layer (no silent clamp)', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'fill 0 -1 0 1 1 1 stone').message).toBe(`fill: y must be 0..${WORLD_HEIGHT - 1} — usage: fill q1 y1 r1 q2 y2 r2 <block>`);
    expect(exec(ctx, 'fill 0 120 0 1 128 1 stone').message).toContain('y must be 0..127');
    expect(exec(ctx, 'hexfill 0 127 0 1 2 stone').message).toBe(`hexfill: y must be 0..${WORLD_HEIGHT - 1} for every layer (127..128) — usage: hexfill q y r radius height <block>`);
    expect(exec(ctx, 'hexfill 0 126 0 1 2 stone').ok).toBe(true);
  });

  it('never mints rune blocks through an area command', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'fill 0 20 0 1 20 1 rune_block')).toEqual({ ok: false, message: 'fill: use setblock for rune blocks — usage: fill q1 y1 r1 q2 y2 r2 <block>' });
    expect(exec(ctx, 'hexfill 0 20 0 1 1 rune_block').message).toContain('use setblock for rune blocks');
    expect(exec(ctx, 'hexring 0 20 0 1 1 25').message).toContain('use setblock for rune blocks');
  });

  it('is atomic across chunks: any unloaded chunk refuses the whole command and changes nothing', () => {
    const { ctx, world } = makeCtx();
    const v = world.editVersion;
    // Chunk (3, 0) is loaded (hex distance 3), chunk (4, 0) is not: q 64..70 are unloaded.
    const res = exec(ctx, 'fill 60 20 0 70 20 0 stone');
    expect(res).toEqual({ ok: false, message: 'fill: 7 cells are in unloaded chunks (nothing changed) — usage: fill q1 y1 r1 q2 y2 r2 <block>' });
    expect(world.editVersion).toBe(v);
    expect(world.getBlock(60, 20, 0)).toBe(B.AIR);
    expect(exec(ctx, 'hexfill 64 20 0 0 1 stone').message).toContain('1 cells are in unloaded chunks (nothing changed)');
  });

  it('refuses when the world edit budget would be exceeded', () => {
    const { ctx, world } = makeCtx();
    Object.defineProperty(world, 'editCount', { get: () => MAX_TOTAL_EDITS - 3, configurable: true });
    expect(exec(ctx, 'fill 0 20 0 1 20 1 stone').message).toBe(`fill: world edit budget exceeded (${MAX_TOTAL_EDITS - 3} of ${MAX_TOTAL_EDITS} cells used or queued; this needs 4) — fill some of it back to its original blocks — usage: fill q1 y1 r1 q2 y2 r2 <block>`);
    expect(exec(ctx, 'fill 0 20 0 0 20 2 stone').ok).toBe(true); // exactly fits
  });

  it('a one-cell box over an unchanged cell completes immediately', () => {
    const { ctx } = makeCtx();
    const res = exec(ctx, 'fill 0 5 0 0 5 0 stone');
    expect(res.ok).toBe(true);
    res.job.step(1);
    expect(res.job.done).toBe(true);
    expect(res.job.summary()).toBe('fill: 0 cells set to stone (1 unchanged)');
  });
});

describe('executeCommand — time / fly / give / say', () => {
  it('time set accepts every spec form and reports the clock; time add moves by game seconds and bumps the day forwards only', () => {
    const { ctx, state } = makeCtx();
    expect(exec(ctx, 'time set noon')).toEqual({ ok: true, message: `time set to ${formatTime(0.5)}` });
    expect(state.time).toBe(0.5);
    expect(exec(ctx, 'time set 06:30').message).toBe('time set to 06:30');
    expect(exec(ctx, 'time set 18').message).toBe('time set to 18:00');
    expect(exec(ctx, 'time set 0.75').message).toBe('time set to 18:00');
    expect(exec(ctx, 'time set 25')).toEqual({ ok: false, message: 'time: bad time "25" — usage: time set <noon|midnight|day|night|HH:MM|0-24|0.0-1.0> | time add <HH:MM|Nh|Nm|seconds>' });
    expect(state.day).toBe(1);
    state.time = 0.5;
    expect(exec(ctx, 'time add 1h').message).toBe('time is now 13:00');
    expect(exec(ctx, 'time add -0:30').message).toBe('time is now 12:30');
    expect(exec(ctx, 'time add 12:00').message).toBe('time is now 00:30');
    expect(state.day).toBe(2);
    expect(exec(ctx, 'time add -3600').message).toBe('time is now 23:30');
    expect(state.day).toBe(2); // rewinding never decrements the day
    expect(exec(ctx, 'time add abc').message).toContain('bad duration "abc"');
  });

  it('time refuses when the clock is frozen by ?time=', () => {
    const { ctx, state } = makeCtx({ timeFrozen: true });
    expect(exec(ctx, 'time set noon').message).toBe('time: time is frozen by ?time= — usage: time set <noon|midnight|day|night|HH:MM|0-24|0.0-1.0> | time add <HH:MM|Nh|Nm|seconds>');
    expect(exec(ctx, 'time add 1h').ok).toBe(false);
    expect(state.time).toBe(0.5);
  });

  it('fly on/off/toggle calls setFlying', () => {
    const { ctx, player } = makeCtx();
    expect(exec(ctx, 'fly on')).toEqual({ ok: true, message: 'flying' });
    expect(player.flying).toBe(true);
    expect(exec(ctx, 'fly toggle')).toEqual({ ok: true, message: 'walking' });
    expect(exec(ctx, 'fly toggle').message).toBe('flying');
    expect(exec(ctx, 'fly off').message).toBe('walking');
    expect(ctx.setFlying).toHaveBeenCalledTimes(4);
  });

  it('give puts placeable blocks in the selected or a given slot', () => {
    const { ctx } = makeCtx();
    ctx.selected = 2;
    expect(exec(ctx, 'give bricks')).toEqual({ ok: true, message: 'gave bricks to slot 3' });
    expect(ctx.hotbar[2]).toBe(B.BRICKS);
    expect(exec(ctx, `give red_wool ${HOTBAR_SIZE}`).message).toBe(`gave wool_red to slot ${HOTBAR_SIZE}`);
    expect(ctx.hotbar[HOTBAR_SIZE - 1]).toBe(B.WOOL_RED);
    expect(exec(ctx, 'give water 1').ok).toBe(true); // water is placeable
    expect(exec(ctx, 'give stone 0')).toEqual({ ok: false, message: `give: slot must be 1-${HOTBAR_SIZE} — usage: give <block> [slot 1-9]` });
    expect(exec(ctx, `give stone ${HOTBAR_SIZE + 1}`).ok).toBe(false);
    expect(exec(ctx, 'give bedrock')).toEqual({ ok: false, message: 'give: "bedrock" is not placeable — usage: give <block> [slot 1-9]' });
    expect(exec(ctx, 'give air').message).toContain('"air" is not placeable');
    expect(exec(ctx, 'give nope').message).toContain('unknown block "nope"');
  });

  it('say forwards the text and returns no message', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'say Hello  there # all')).toEqual({ ok: true, message: '' });
    expect(ctx.say).toHaveBeenCalledWith('Hello  there # all');
  });
});

describe('executeCommand — rune commands', () => {
  it('run triggers through the runner with console semantics outside a script and run/wave/hops inside', () => {
    const { ctx, runner } = makeCtx();
    expect(exec(ctx, 'run 1 2 3')).toEqual({ ok: true, message: 'running rune (1, 2, 3)' });
    expect(runner.trigger).toHaveBeenLastCalledWith('1,2,3', 'console', undefined);
    ctx.rune = runeAt(0, 11, 0);
    ctx.running = { wave: 7, hops: 2 };
    expect(exec(ctx, 'run @1 @ @').ok).toBe(true);
    expect(runner.trigger).toHaveBeenLastCalledWith('1,11,0', 'run', { wave: 7, hops: 3 });
    runner.trigger.mockReturnValueOnce({ ok: false, reason: 'rune at (1, 11, 0) is already running' });
    expect(exec(ctx, 'run 1 11 0')).toEqual({ ok: false, message: 'run: rune at (1, 11, 0) is already running — usage: run q y r' });
    runner.trigger.mockReturnValueOnce({ ok: false });
    expect(exec(ctx, 'run 1 11 0').message).toBe('run: could not run — usage: run q y r');
  });

  it('wait and stop are script-only; wait enforces its range', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'wait 1')).toEqual({ ok: false, message: 'wait: wait is only valid inside a rune script — usage: wait <seconds>' });
    expect(exec(ctx, 'stop')).toEqual({ ok: false, message: 'stop: stop is only valid inside a rune script — usage: stop' });
    ctx.rune = runeAt(0, 11, 0);
    ctx.running = { wave: 1, hops: 0 };
    expect(exec(ctx, 'wait 0.5')).toEqual({ ok: true, message: '', wait: 0.5 });
    expect(exec(ctx, `wait ${WAIT_MIN_S}`).wait).toBe(WAIT_MIN_S);
    expect(exec(ctx, `wait ${WAIT_MAX_S}`).wait).toBe(WAIT_MAX_S);
    expect(exec(ctx, 'wait 0.01')).toEqual({ ok: false, message: `wait: seconds must be ${WAIT_MIN_S}..${WAIT_MAX_S} — usage: wait <seconds>` });
    expect(exec(ctx, `wait ${WAIT_MAX_S + 1}`).ok).toBe(false);
    expect(exec(ctx, 'wait -1').ok).toBe(false);
    expect(exec(ctx, 'stop')).toEqual({ ok: true, message: '', stop: true });
  });

  it('stopall / resume go through the runner', () => {
    const { ctx, runner } = makeCtx();
    runner.stopAll.mockReturnValueOnce(3);
    expect(exec(ctx, 'stopall')).toEqual({ ok: true, message: 'stopped 3 scripts; rune triggers paused (press R on a rune or run resume)' });
    runner.stopAll.mockReturnValueOnce(1);
    expect(exec(ctx, 'stopall').message).toBe('stopped 1 script; rune triggers paused (press R on a rune or run resume)');
    expect(exec(ctx, 'resume')).toEqual({ ok: true, message: 'rune triggers resumed' });
    expect(runner.resume).toHaveBeenCalledTimes(1);
  });

  it('runes lists stored runes with their triggers and running state', () => {
    const { ctx, store, runner } = makeCtx();
    expect(exec(ctx, 'runes')).toEqual({ ok: true, message: 'no rune blocks with scripts or settings' });
    store.set(2, 11, -1, { label: 'lift', stepOn: true, chain: true });
    store.set(0, 11, 0, { interact: false, repeat: true, repeatInterval: 2 });
    store.set(5, 11, 5, { enabled: false, script: 'say x' });
    runner.isRunning.mockImplementation((key) => key === '2,11,-1');
    const lines = exec(ctx, 'runes').message.split('\n');
    expect(lines).toEqual([
      '0 11 0 · (no label) · every 2s · idle',
      '2 11 -1 · lift · R step chain · running',
      '5 11 5 · (no label) · OFF · idle',
    ]);
  });

  it('runes caps the listing at 50 lines', () => {
    const { ctx, store } = makeCtx();
    for (let i = 0; i < 55; i++) store.set(i, 11, 0, { label: `r${i}` });
    const lines = exec(ctx, 'runes').message.split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[50]).toBe('… and 5 more');
  });

  it('rune q y r on|off requires a loaded rune block, writes the store and cancels when disabling', () => {
    const { ctx, world, store, runner } = makeCtx();
    expect(exec(ctx, 'rune 200 11 0 on')).toEqual({ ok: false, message: 'rune: cell (200, 11, 0) is not loaded — usage: rune q y r on|off' });
    expect(exec(ctx, 'rune 1 11 1 on')).toEqual({ ok: false, message: 'rune: no rune block at (1, 11, 1) — usage: rune q y r on|off' });
    world.setBlock(1, 11, 1, B.RUNE_BLOCK);
    expect(exec(ctx, 'rune 1 11 1 off')).toEqual({ ok: true, message: 'rune (1, 11, 1) disabled' });
    expect(store.get('1,11,1').enabled).toBe(false);
    expect(runner.cancel).toHaveBeenCalledWith('1,11,1');
    expect(exec(ctx, 'rune 1 11 1 on').message).toBe('rune (1, 11, 1) enabled');
    expect(store.get('1,11,1').enabled).toBe(true);
    const full = new RuneStore(0);
    ctx.runes = full;
    expect(exec(ctx, 'rune 1 11 1 off')).toEqual({ ok: false, message: 'rune: too many rune blocks (max 0) — usage: rune q y r on|off' });
  });
});

describe('executeCommand — summon / pigs', () => {
  it('summon pig puts a pig on the ground two cells ahead, or in a given cell; pigs counts and clears', () => {
    const { ctx, player } = makeCtx();
    ctx.pigs = new Pigs();
    const [aq, ar] = worldToHex(player.x, player.z - 2); // yaw 0 faces −Z
    expect(exec(ctx, 'summon pig')).toEqual({ ok: true, message: `summoned a pig at ${aq} ${FEET} ${ar}` });
    expect(ctx.pigs.size).toBe(1);
    const [x, z] = hexToWorld(aq, ar);
    expect(ctx.pigs.list[0]).toMatchObject({ x, y: FEET, z });
    expect(exec(ctx, 'summon pig 4 9 -2')).toEqual({ ok: true, message: `summoned a pig at 4 ${FEET} -2` });
    expect(exec(ctx, 'summon pig ~1 ~ ~')).toMatchObject({ ok: true });
    expect(exec(ctx, 'pigs')).toEqual({ ok: true, message: `3 pigs (max ${PIG_MAX})` });
    expect(exec(ctx, 'pigs clear')).toEqual({ ok: true, message: 'removed 3 pigs' });
    expect(ctx.pigs.size).toBe(0);
  });
  it('rejects other creatures, partial coordinates, unloaded targets and more than PIG_MAX pigs', () => {
    const { ctx } = makeCtx();
    expect(exec(ctx, 'summon pig')).toMatchObject({ ok: false, message: expect.stringContaining('pigs are not available') });
    ctx.pigs = new Pigs();
    expect(parseLine('summon cow')).toEqual({ line: 1, message: 'summon: expected one of pig, zombie, watcher, got "cow" — usage: summon pig|zombie|watcher [q y r]' });
    expect(exec(ctx, 'summon pig 1 2')).toMatchObject({ ok: false, message: expect.stringContaining('expected 1 or 4 args') });
    expect(exec(ctx, 'summon pig 900 20 900')).toMatchObject({ ok: false, message: expect.stringContaining('not loaded') });
    for (let i = 0; i < PIG_MAX; i++) ctx.pigs.spawn(0, FEET, 0);
    expect(exec(ctx, 'summon pig')).toMatchObject({ ok: false, message: expect.stringContaining(`too many pigs (max ${PIG_MAX})`) });
  });
});

describe('executeCommand — summon zombie / zombies (§39)', () => {
  it('summon zombie puts a zombie (facing you) two cells ahead or in a cell, by day too; zombies counts and clears', () => {
    const { ctx, player } = makeCtx(); // time 0.5: noon
    ctx.zombies = new Zombies();
    const [aq, ar] = worldToHex(player.x, player.z - 2);
    expect(exec(ctx, 'summon zombie')).toEqual({ ok: true, message: `summoned a zombie at ${aq} ${FEET} ${ar}` });
    const zb = ctx.zombies.list[0];
    const [x, z] = hexToWorld(aq, ar);
    expect(zb).toMatchObject({ x, y: FEET, z, radius: ZOMBIE_RADIUS, height: ZOMBIE_HEIGHT });
    expect(Math.cos(zb.yaw)).toBeCloseTo(-1, 6); // it faces +Z, back at the player
    expect(exec(ctx, 'summon zombie 4 9 -2')).toEqual({ ok: true, message: `summoned a zombie at 4 ${FEET} -2` });
    expect(exec(ctx, 'zombies')).toEqual({ ok: true, message: `2 zombies (max ${ZOMBIE_MAX}) · zombies are on in this world` });
    expect(exec(ctx, 'zombies clear')).toEqual({ ok: true, message: 'removed 2 zombies' });
    expect(ctx.zombies.size).toBe(0);
  });
  it('zombies on|off is the saved switch: off removes them and summon refuses', () => {
    const { ctx } = makeCtx();
    ctx.zombies = new Zombies();
    exec(ctx, 'summon zombie');
    const v = ctx.zombies.switchVersion;
    expect(exec(ctx, 'zombies off')).toEqual({ ok: true, message: 'zombies off (saved with this world): removed 1 zombie' });
    expect(ctx.zombies.enabled).toBe(false);
    expect(ctx.zombies.switchVersion).toBe(v + 1);
    expect(exec(ctx, 'zombies off')).toEqual({ ok: true, message: 'zombies are already off' });
    expect(exec(ctx, 'summon zombie')).toMatchObject({ ok: false, message: expect.stringContaining('zombies are off in this world') });
    expect(exec(ctx, 'zombies')).toMatchObject({ message: expect.stringContaining('zombies are off in this world') });
    expect(exec(ctx, 'zombies on')).toEqual({ ok: true, message: 'zombies on (saved with this world)' });
    expect(exec(ctx, 'summon zombie')).toMatchObject({ ok: true });
  });
  it('rejects contexts without zombies, partial coordinates, unloaded targets, solid cells and more than ZOMBIE_MAX', () => {
    const { ctx, world } = makeCtx();
    expect(exec(ctx, 'summon zombie')).toMatchObject({ ok: false, message: expect.stringContaining('zombies are not available') });
    expect(exec(ctx, 'zombies')).toMatchObject({ ok: false, message: expect.stringContaining('zombies are not available') });
    ctx.zombies = new Zombies();
    expect(parseLine('zombies maybe')).toMatchObject({ message: expect.stringContaining('expected one of clear, on, off') });
    expect(exec(ctx, 'summon zombie 1 2')).toMatchObject({ ok: false, message: expect.stringContaining('expected 1 or 4 args') });
    expect(exec(ctx, 'summon zombie 900 20 900')).toMatchObject({ ok: false, message: expect.stringContaining('not loaded') });
    // A pillar three high over cell (5, 0): no free two-high space within findFreeY's two cells.
    for (let y = FEET; y < FEET + 3; y++) world.setBlock(5, y, 0, B.STONE);
    expect(exec(ctx, `summon zombie 5 ${FEET} 0`)).toMatchObject({ ok: false, message: expect.stringContaining('inside a block') });
    for (let i = 0; i < ZOMBIE_MAX; i++) ctx.zombies.spawn(0, FEET, 0);
    expect(exec(ctx, 'summon zombie')).toMatchObject({ ok: false, message: expect.stringContaining(`too many zombies (max ${ZOMBIE_MAX})`) });
  });
});

describe('executeCommand — summon watcher / watcher (§40)', () => {
  /** The Watcher with a view over the ctx world (fog far 40: it stands 30–38 away). */
  function withWatcher(ctx, world, player, time = 0.5) {
    ctx.watcher = new Watcher();
    ctx.watcherWorld = {
      getBlock: world.getBlock,
      isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
      groundHeight: (q, r) => world.terrainHeightAt(q, r),
      isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
      hasEdit: (q, y, r) => world.hasEdit(q, y, r),
      player,
      eye: [player.x, player.y + 1.62, player.z],
      look: [0, 0, -1],
      yaw: 0,
      time,
      day: 1,
      fogFar: 40,
      spawn: null,
    };
    return ctx.watcher;
  }

  it('summon watcher puts it far away in view at noon, facing you; one at a time; summon watcher q y r puts it in a cell', () => {
    const { ctx, world, player } = makeCtx(); // noon
    const w = withWatcher(ctx, world, player);
    const res = exec(ctx, 'summon watcher');
    expect(res.ok).toBe(true);
    const f = w.figure;
    expect(res.message).toBe(`summoned the Watcher at ${f.q} ${f.y} ${f.r}, ${Math.round(Math.hypot(f.x - player.x, f.y - player.y, f.z - player.z))} away`);
    expect(Math.hypot(f.x - player.x, f.z - player.z)).toBeGreaterThanOrEqual(30);
    expect(Math.hypot(f.x - player.x, f.z - player.z)).toBeLessThanOrEqual(38);
    expect(f.z).toBeLessThan(player.z); // ahead (the view looks along −Z)
    expect(f.y).toBe(FEET);
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: false, message: expect.stringContaining('already here') });
    expect(exec(ctx, 'watcher')).toEqual({ ok: true, message: `the Watcher is on in this world · it is here, ${Math.round(Math.hypot(f.x - player.x, f.y - player.y, f.z - player.z))} away` });
    w.clear();
    expect(exec(ctx, 'summon watcher 4 9 -30')).toEqual({ ok: true, message: `summoned the Watcher at 4 ${FEET} -30, ${Math.round(Math.hypot(hexToWorld(4, -30)[0] - player.x, 0, hexToWorld(4, -30)[1] - player.z))} away` });
    expect(exec(ctx, 'watcher')).toMatchObject({ message: expect.stringContaining('it is here') });
  });

  it('watcher on|off is the saved switch: off removes it and summon refuses; errors for bad input', () => {
    const { ctx, world, player } = makeCtx();
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: false, message: expect.stringContaining('not available') });
    expect(exec(ctx, 'watcher')).toMatchObject({ ok: false, message: expect.stringContaining('not available') });
    const w = withWatcher(ctx, world, player);
    expect(exec(ctx, 'watcher')).toEqual({ ok: true, message: 'the Watcher is on in this world · it is not here' });
    exec(ctx, 'summon watcher');
    expect(exec(ctx, 'watcher off')).toEqual({ ok: true, message: 'the Watcher off (saved with this world): it is gone' });
    expect(w.present).toBe(false);
    expect(w.switchVersion).toBe(1);
    expect(exec(ctx, 'watcher off')).toEqual({ ok: true, message: 'the Watcher is already off' });
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: false, message: expect.stringContaining('off in this world') });
    expect(exec(ctx, 'watcher on')).toEqual({ ok: true, message: 'the Watcher on (saved with this world)' });
    expect(parseLine('watcher maybe')).toMatchObject({ message: expect.stringContaining('expected one of on, off') });
    expect(exec(ctx, 'summon watcher 1 2')).toMatchObject({ ok: false, message: expect.stringContaining('expected 1 or 4 args') });
    expect(exec(ctx, 'summon watcher 900 20 900')).toMatchObject({ ok: false, message: expect.stringContaining('not loaded') });
    for (let y = FEET; y < FEET + 5; y++) world.setBlock(5, y, -30, B.STONE);
    expect(exec(ctx, `summon watcher 5 ${FEET} -30`)).toMatchObject({ ok: false, message: expect.stringContaining('inside a block') });
    // Walled in: it still comes for a test, hidden in the view, and says so.
    w.clear();
    for (let q = -3; q <= 3; q++) for (let y = FEET; y < FEET + 12; y++) world.setBlock(q, y, -3, B.STONE);
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: true, message: expect.stringMatching(/^summoned the Watcher at .* away \(out of sight\)$/) });
    expect(w.figure.los).toBe(false);
    w.clear();
    // Looking down at your feet the horizon is off screen: nowhere in view.
    ctx.watcherWorld.look = [0, -1, 0];
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: false, message: expect.stringContaining('no open ground') });
    ctx.watcherWorld.look = [0, 0, -1];
    // Nowhere to stand out there (a fog far too short for 30 m): a clear refusal.
    ctx.watcherWorld.fogFar = 27;
    expect(exec(ctx, 'summon watcher')).toMatchObject({ ok: false, message: expect.stringContaining('no open ground') });
  });
});

describe('executeCommand — information commands', () => {
  it('help lists every command with its usage and the footer, or one command', () => {
    const { ctx } = makeCtx();
    const all = exec(ctx, 'help');
    expect(all.ok).toBe(true);
    const lines = all.message.split('\n');
    for (const c of COMMANDS) expect(lines).toContain(`${c.usage}  — ${c.summary}`);
    for (const f of HELP_FOOTER) expect(lines).toContain(f);
    expect(exec(ctx, 'help tp')).toEqual({ ok: true, message: 'tp q y r | tp q r\n  teleport to the centre of a cell (2 args: onto the surface there)' });
    expect(exec(ctx, 'help /SAY').message.startsWith('say <text>\n')).toBe(true);
    expect(exec(ctx, 'help nope')).toEqual({ ok: true, message: 'no command "nope" — type help for the list' });
  });

  it('blocks lists air plus every placeable block as "id name (Display Name)"', () => {
    const { ctx } = makeCtx();
    const lines = exec(ctx, 'blocks').message.split('\n');
    const expected = BLOCKS.filter((d) => d.id === B.AIR || isPlaceable(d.id));
    expect(lines).toHaveLength(expected.length);
    for (const line of lines) expect(line).toMatch(/^\s*\d+ [a-z_]+ \(.+\)$/);
    expect(lines).toContain(`${B.RUNE_BLOCK} rune_block (Rune Block)`);
    expect(lines[0]).toBe(' 0 air (Air)');
  });

  it('pos, seed and edits report the player state, the seed and the edit count', () => {
    const { ctx, world } = makeCtx();
    ctx.controls.yaw = Math.PI;
    ctx.controls.pitch = -0.5;
    expect(exec(ctx, 'pos').message).toBe(`cell 0 ${FEET} 0 · world 0.00 ${FEET}.00 0.00 · yaw -180.0 pitch ${((-0.5 * 180) / Math.PI).toFixed(1)}`);
    expect(exec(ctx, 'seed')).toEqual({ ok: true, message: `seed ${world.seed}` });
    expect(exec(ctx, 'edits').message).toBe(`0 edited cells (≈ 0 KB of save data, budget ${MAX_TOTAL_EDITS})`);
    for (let i = 0; i < 300; i++) world.setBlock(i % 16, 20 + Math.floor(i / 16), 0, B.STONE);
    expect(exec(ctx, 'edits').message).toBe(`300 edited cells (≈ ${Math.round((300 * 8) / 1024)} KB of save data, budget ${MAX_TOTAL_EDITS})`);
  });
});

describe('executeCommand — robustness', () => {
  it('never throws: a throwing context method becomes an internal-error result', () => {
    const { ctx } = makeCtx({
      say: () => {
        throw new Error('boom');
      },
    });
    expect(exec(ctx, 'say hi')).toEqual({ ok: false, message: 'say: internal error: boom' });
  });

  it('rejects a command object with an unknown name', () => {
    const { ctx } = makeCtx();
    expect(executeCommand({ line: 1, name: 'nope', args: [], raw: 'nope' }, ctx)).toEqual({ ok: false, message: 'unknown command "nope" (try help)' });
  });

  it('cell commands accept negative coordinates everywhere', () => {
    const { ctx, world } = makeCtx();
    expect(exec(ctx, 'setblock -3 12 -5 glass').message).toBe('set glass at (-3, 12, -5)');
    expect(world.getBlock(-3, 12, -5)).toBe(B.GLASS);
    const job = exec(ctx, 'fill -2 20 -2 -1 20 -1 glass').job;
    job.step(10);
    expect(job.written).toBe(4);
    expect(exec(ctx, 'tp -4 11 -4').message).toBe('teleported to cell -4 11 -4');
  });
});

describe('executeCommand — block physics (physics / undo / ignite / drain)', () => {
  /** A ctx whose world has a BlockPhysics attached (as main forwards onBlockChange). */
  function physicsCtx(over = {}) {
    const made = makeCtx(over);
    const physics = new BlockPhysics(made.world);
    made.world.onBlockChange = (q, y, r, p, n) => physics.onBlockChange(q, y, r, p, n);
    made.ctx.physics = physics;
    return { ...made, physics };
  }

  it('fail without physics in the context', () => {
    const { ctx } = makeCtx();
    for (const line of ['physics status', 'undo', 'ignite 0 11 0', 'drain']) {
      const res = exec(ctx, line);
      expect(res.ok, line).toBe(false);
      expect(res.message).toContain('block physics is not available here');
    }
  });

  it('physics status | on | off | <feature> [on|off]', () => {
    const { ctx, physics } = physicsCtx();
    expect(exec(ctx, 'physics status').message).toBe(physics.statusText());
    expect(exec(ctx, 'physics off')).toEqual({ ok: true, message: 'block physics paused: nothing falls, flows or explodes until physics on (not saved)' });
    expect(physics.paused).toBe(true);
    expect(exec(ctx, 'physics on').ok).toBe(true);
    expect(physics.paused).toBe(false);
    expect(exec(ctx, 'physics collapse off')).toEqual({ ok: true, message: 'collapse off (saved with this world)' });
    expect(physics.isEnabled('collapse')).toBe(false);
    expect(exec(ctx, 'physics collapse off').message).toBe('collapse off (already)');
    expect(exec(ctx, 'physics collapse').message).toBe('collapse is off');
    expect(exec(ctx, 'physics WATER OFF').ok).toBe(true);
    expect(physics.isEnabled('water')).toBe(false);
    expect(exec(ctx, 'physics lava on').message).toContain('expected one of falling, water, collapse, explosions');
    expect(exec(ctx, 'physics nope').ok).toBe(false);
    expect(parseLine('physics falling maybe').message).toContain('expected one of on, off');
  });

  it('undo reports the event or why not', () => {
    const { ctx, physics, world } = physicsCtx();
    expect(exec(ctx, 'undo').message).toContain('nothing to undo');
    world.setBlock(2, 11, 2, B.BRICKS);
    physics.beginEvent('explosion');
    physics.ctx.writeQuiet(2, 11, 2, B.AIR);
    physics.endEvent();
    const res = exec(ctx, 'undo');
    expect(res).toEqual({ ok: true, message: 'undid the explosion: restored 1 block' });
    expect(world.getBlock(2, 11, 2)).toBe(B.BRICKS);
  });

  it('undo refuses in Survival like the pause menu\'s Undo (§1.5; KNOWN-ISSUES S4), and still works in Creative', () => {
    const { ctx, physics, world } = physicsCtx();
    world.setBlock(2, 11, 2, B.BRICKS);
    physics.beginEvent('explosion');
    physics.ctx.writeQuiet(2, 11, 2, B.AIR);
    physics.endEvent();
    ctx.survival = { mode: 'survival', hasState: true };
    expect(exec(ctx, 'undo')).toEqual({ ok: false, message: 'undo: not in Survival — usage: undo' });
    expect(world.getBlock(2, 11, 2)).toBe(B.AIR);
    ctx.survival.mode = 'creative'; // a world switched back to Creative (its state kept) may undo again
    expect(exec(ctx, 'undo').ok).toBe(true);
    expect(world.getBlock(2, 11, 2)).toBe(B.BRICKS);
  });

  it('ignite resolves and checks the cell, then asks explosions; drain centres on the player (or the rune)', () => {
    const { ctx, physics } = physicsCtx();
    const ignite = vi.spyOn(physics.explosions, 'ignite').mockReturnValue({ ok: true, message: 'lit' });
    expect(exec(ctx, 'ignite ~ ~ ~1')).toEqual({ ok: true, message: 'lit' });
    expect(ignite).toHaveBeenCalledWith(0, FEET, 1);
    expect(exec(ctx, 'ignite 9000 11 9000').message).toContain('is not loaded');
    ignite.mockReturnValue({ ok: false, message: 'no barrel there' });
    expect(exec(ctx, 'ignite 0 11 0').message).toBe('ignite: no barrel there — usage: ignite q y r');
    const drain = vi.spyOn(physics.fluids, 'drain').mockReturnValue({ ok: true, message: 'drained 3 cells' });
    expect(exec(ctx, 'drain').message).toBe('drained 3 cells');
    expect(drain).toHaveBeenLastCalledWith(0, FEET, 0, 8);
    exec(ctx, 'drain 2');
    expect(drain).toHaveBeenLastCalledWith(0, FEET, 0, 2);
    expect(exec(ctx, 'drain 17').message).toContain('radius must be 0..16');
    ctx.rune = runeAt(5, 20, -3);
    exec(ctx, 'drain 1');
    expect(drain).toHaveBeenLastCalledWith(5, 20, -3, 1);
  });

  it('drain (the real water feature) removes the water around the player and nothing beyond the radius', () => {
    const { ctx, physics, world } = physicsCtx();
    world.setBlock(1, FEET, 0, B.WATER);
    world.setBlock(9, FEET, 0, B.WATER);
    for (let i = 0; i < 400 && physics.queued() > 0; i++) physics.tick();
    expect(world.getBlock(2, FEET, 0)).toBe(B.WATER_FLOW_6);
    const res = exec(ctx, 'drain 3');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^drained \d+ water cells within 3$/);
    expect(world.getBlock(1, FEET, 0)).toBe(B.AIR);
    expect(world.getBlock(9, FEET, 0)).toBe(B.WATER);
    expect(exec(ctx, 'drain 0').message).toBe('no water to drain within 0');
  });
});

// ---------------------------------------------------------------------------------------------
// Survival commands (v0.9, docs/DESIGN-survival.md §9.7) against a fake ctx.survival

/** A fake CommandContext.survival: a live survival state with spied methods. */
function fakeSurvival(over = {}) {
  const v = { health: 87.4, satiation: 64.2, hydration: 51, temp: 36.94, breath: 20, labels: [] };
  const sv = {
    mode: 'survival',
    hasState: true,
    v,
    setMode: vi.fn((m) => ({ ok: true, message: `${m} (saved with this world)` })),
    vitals: vi.fn(() => (sv.hasState ? { ...v } : null)),
    setVital: vi.fn((name, value) => {
      v[name] = value;
      return true;
    }),
    restoreVitals: vi.fn(() => Object.assign(v, { health: 100, satiation: 100, hydration: 100, temp: 37, breath: 20 })),
    packAdd: vi.fn(() => null),
    packClear: vi.fn(),
    packList: vi.fn(() => '1: 12 Rock\n2: Flint Pick (40/90)'),
    ...over,
  };
  return sv;
}

/** A running script (for the console-only check): what the runner sets while a rune's command runs. */
const RUNNING = { wave: 1, hops: 0 };

describe('executeCommand — mode (console only)', () => {
  it('without an argument prints the mode, with the vitals in Survival', () => {
    const { ctx } = makeCtx({ survival: fakeSurvival() });
    expect(exec(ctx, 'mode')).toEqual({ ok: true, message: 'mode: survival (Health 87 · Nourishment 64 · Hydration 51 · 36.9 °C)' });
    ctx.survival.mode = 'creative';
    expect(exec(ctx, 'mode')).toEqual({ ok: true, message: 'mode: creative' });
    const noState = fakeSurvival({ vitals: () => null });
    expect(exec(makeCtx({ survival: noState }).ctx, 'mode').message).toBe('mode: survival');
    // a context without survival at all is a Creative world
    expect(exec(makeCtx().ctx, 'mode')).toEqual({ ok: true, message: 'mode: creative' });
  });

  it('with an argument queues the switch through ctx.survival.setMode and relays its message', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'mode Creative')).toEqual({ ok: true, message: 'creative (saved with this world)' });
    expect(sv.setMode).toHaveBeenCalledWith('creative');
    sv.setMode = vi.fn(() => ({ ok: true, message: 'adding survival resources to this world: reloading…' }));
    expect(exec(ctx, 'mode survival').message).toBe('adding survival resources to this world: reloading…');
    sv.setMode = vi.fn(() => ({ ok: true, message: 'already creative' }));
    expect(exec(ctx, 'mode creative')).toEqual({ ok: true, message: 'already creative' });
    sv.setMode = vi.fn(() => ({ ok: true, message: '' }));
    expect(exec(ctx, 'mode survival').message).toBe('survival (saved with this world)');
    sv.setMode = vi.fn(() => ({ ok: false, message: 'not while dead' }));
    expect(exec(ctx, 'mode creative')).toEqual({ ok: false, message: 'mode: not while dead — usage: mode [creative|survival]' });
    expect(exec(makeCtx().ctx, 'mode survival')).toEqual({ ok: false, message: 'mode: survival is not available here — usage: mode [creative|survival]' });
  });

  it('is refused inside a rune script, before anything is touched', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv, running: RUNNING, rune: runeAt(0, 5, 0) });
    expect(exec(ctx, 'mode survival')).toEqual({ ok: false, message: 'mode: mode is only valid in the console — usage: mode [creative|survival]' });
    expect(exec(ctx, 'mode')).toEqual({ ok: false, message: 'mode: mode is only valid in the console — usage: mode [creative|survival]' });
    expect(sv.setMode).not.toHaveBeenCalled();
    // parse-time checks as for any command
    expect(parseLine('mode hardcore')).toEqual({ line: 1, message: 'mode: expected one of creative, survival, got "hardcore" — usage: mode [creative|survival]' });
    expect(parseLine('mode survival now')).toMatchObject({ message: expect.stringContaining('mode: expected [creative|survival] (got 2 args)') });
  });
});

describe('executeCommand — vitals', () => {
  it('fails without a survival state', () => {
    const fail = { ok: false, message: 'vitals: no survival state in this world (try mode survival) — usage: vitals [full|health|nourishment|hydration|temp|breath] [value]' };
    expect(exec(makeCtx().ctx, 'vitals')).toEqual(fail);
    expect(exec(makeCtx({ survival: fakeSurvival({ hasState: false }) }).ctx, 'vitals health 5')).toEqual(fail);
  });

  it('prints every stat with the breath and the status labels, or one stat', () => {
    const sv = fakeSurvival();
    sv.v.labels = ['Hungry', 'Wet'];
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'vitals')).toEqual({ ok: true, message: 'Health 87 · Nourishment 64 · Hydration 51 · 36.9 °C · Breath 20 s · Hungry, Wet' });
    expect(exec(ctx, 'vitals health').message).toBe('Health 87.4');
    expect(exec(ctx, 'vitals NOURISHMENT').message).toBe('Nourishment 64.2');
    expect(exec(ctx, 'vitals temp').message).toBe('Body temperature 36.9 °C');
    expect(exec(ctx, 'vitals breath').message).toBe('Breath 20 s');
  });

  it('sets one stat (clamped to its range, ~ relative to the current value) through setVital with the internal key', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'vitals nourishment 30')).toEqual({ ok: true, message: 'Nourishment set to 30' });
    expect(sv.setVital).toHaveBeenLastCalledWith('satiation', 30);
    expect(exec(ctx, 'vitals health 150')).toEqual({ ok: true, message: 'Health set to 100 (clamped)' });
    expect(exec(ctx, 'vitals health -5')).toEqual({ ok: true, message: 'Health set to 0 (clamped)' });
    expect(sv.setVital).toHaveBeenLastCalledWith('health', 0); // main turns this into pendingDeath 'command'
    expect(exec(ctx, 'vitals temp 50').message).toBe('Body temperature set to 45 °C (clamped)');
    expect(exec(ctx, 'vitals temp 10').message).toBe('Body temperature set to 25 °C (clamped)');
    expect(exec(ctx, 'vitals breath 25').message).toBe('Breath set to 20 s (clamped)');
    expect(exec(ctx, 'vitals hydration 40').message).toBe('Hydration set to 40');
    expect(exec(ctx, 'vitals hydration ~-15').message).toBe('Hydration set to 25');
    expect(exec(ctx, 'vitals hydration ~').message).toBe('Hydration set to 25');
    expect(exec(ctx, 'vitals temp 38.25').message).toBe('Body temperature set to 38.3 °C');
    expect(sv.setVital).toHaveBeenLastCalledWith('temp', 38.25);
    expect(exec(ctx, 'vitals health @5')).toEqual({ ok: false, message: 'vitals: value must be a number (~ is relative to the current value) — usage: vitals [full|health|nourishment|hydration|temp|breath] [value]' });
    sv.setVital = vi.fn(() => false);
    expect(exec(ctx, 'vitals health 50').message).toContain('no survival state in this world');
  });

  it('full restores everything; unknown stats and stray values are refused', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'vitals full')).toEqual({ ok: true, message: 'vitals restored: Health 100 · Nourishment 100 · Hydration 100 · 37.0 °C' });
    expect(sv.restoreVitals).toHaveBeenCalledTimes(1);
    expect(exec(ctx, 'vitals full 5').message).toBe('vitals: full takes no value — usage: vitals [full|health|nourishment|hydration|temp|breath] [value]');
    expect(exec(ctx, 'vitals satiation 5').message).toBe('vitals: expected full, health, nourishment, hydration, temp, breath, got "satiation" — usage: vitals [full|health|nourishment|hydration|temp|breath] [value]');
    expect(exec(ctx, 'vitals __proto__').ok).toBe(false);
    expect(exec(ctx, 'vitals constructor 1').ok).toBe(false);
    expect(parseLine('vitals health lots')).toMatchObject({ message: expect.stringContaining('expected a number for value') });
    expect(sv.setVital).not.toHaveBeenCalled();
  });
});

describe('executeCommand — pack and items', () => {
  const USAGE = 'usage: pack [list|add|clear] [item] [count]';

  it('pack (list) prints the non-empty slots; an empty pack says so; no survival state fails', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'pack')).toEqual({ ok: true, message: '1: 12 Rock\n2: Flint Pick (40/90)' });
    expect(exec(ctx, 'pack list').message).toBe('1: 12 Rock\n2: Flint Pick (40/90)');
    sv.packList = vi.fn(() => '');
    expect(exec(ctx, 'pack').message).toBe('the pack is empty');
    expect(exec(ctx, 'pack list rock')).toEqual({ ok: false, message: `pack: list takes no item — ${USAGE}` });
    expect(exec(makeCtx().ctx, 'pack')).toEqual({ ok: false, message: `pack: no survival state in this world (try mode survival) — ${USAGE}` });
    expect(exec(makeCtx({ survival: fakeSurvival({ hasState: false }) }).ctx, 'pack add rock').ok).toBe(false);
  });

  it('pack add resolves item keys and display names, adds 1 by default, and reports what did not fit', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'pack add rock 12')).toEqual({ ok: true, message: 'added 12 Rock' });
    expect(sv.packAdd).toHaveBeenLastCalledWith('rock', 12);
    expect(exec(ctx, 'pack add Pot_of_Water')).toEqual({ ok: true, message: 'added 1 Pot of Water' });
    expect(sv.packAdd).toHaveBeenLastCalledWith('pot_water', 1);
    expect(exec(ctx, 'pack ADD wrought_iron_bar 3').message).toBe('added 3 Wrought Iron Bar');
    // what did not fit: a count, an overflow stack, or a list of stacks
    sv.packAdd = vi.fn(() => 3);
    expect(exec(ctx, 'pack add rock 12')).toEqual({ ok: true, message: 'added 9 Rock (3 did not fit)' });
    sv.packAdd = vi.fn(() => ({ k: 'rock', n: 5 }));
    expect(exec(ctx, 'pack add rock 12').message).toBe('added 7 Rock (5 did not fit)');
    sv.packAdd = vi.fn(() => [{ k: 'rock', n: 2 }, { k: 'rock', n: 2 }]);
    expect(exec(ctx, 'pack add rock 12').message).toBe('added 8 Rock (4 did not fit)');
    sv.packAdd = vi.fn(() => 12);
    expect(exec(ctx, 'pack add rock 12')).toEqual({ ok: false, message: `pack: the pack is full (12 Rock did not fit) — ${USAGE}` });
    sv.packAdd = vi.fn(() => 0);
    expect(exec(ctx, 'pack add flint_pick').message).toBe('added 1 Flint Pick');
  });

  it('pack add relays a refusal from the game (§14.2: the handbook is never minted twice)', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    sv.packAdd = vi.fn(() => ({ n: 1, refused: 'the pack already has a handbook' }));
    expect(exec(ctx, 'pack add handbook')).toEqual({ ok: false, message: `pack: the pack already has a handbook — ${USAGE}` });
    sv.packAdd = vi.fn(() => ({ n: 2, refused: 'one handbook is enough' }));
    expect(exec(ctx, 'pack add handbook 2').message).toBe(`pack: one handbook is enough — ${USAGE}`);
    // a refusal that let some through is still a refusal (nothing is reported as added)
    sv.packAdd = vi.fn(() => ({ n: 0, refused: 'no' }));
    expect(exec(ctx, 'pack add handbook').ok).toBe(false);
  });

  it('pack add refuses unknown items, a missing item and counts outside 1–9999', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'pack add nope')).toEqual({ ok: false, message: `pack: unknown item "nope" (type items to list them) — ${USAGE}` });
    expect(exec(ctx, 'pack add')).toEqual({ ok: false, message: `pack: expected an item name (type items to list them) — ${USAGE}` });
    expect(exec(ctx, 'pack add rock 0').message).toBe(`pack: count must be 1–9999 — ${USAGE}`);
    expect(exec(ctx, 'pack add rock 10000').ok).toBe(false);
    expect(exec(ctx, 'pack add rock -3').ok).toBe(false);
    expect(parseLine('pack add rock 2.5')).toMatchObject({ message: expect.stringContaining('must be a plain integer') });
    expect(parseLine('pack give rock')).toMatchObject({ message: expect.stringContaining('expected one of list, add, clear') });
    expect(sv.packAdd).not.toHaveBeenCalled();
  });

  it('pack clear empties the pack and what you wear', () => {
    const sv = fakeSurvival();
    const { ctx } = makeCtx({ survival: sv });
    expect(exec(ctx, 'pack clear')).toEqual({ ok: true, message: 'emptied the pack and what you wear' });
    expect(sv.packClear).toHaveBeenCalledTimes(1);
    expect(exec(ctx, 'pack clear rock').ok).toBe(false);
    expect(sv.packClear).toHaveBeenCalledTimes(1);
  });

  it('items lists every item key, 8 per line, or those containing a filter', () => {
    const { ctx } = makeCtx();
    const all = exec(ctx, 'items');
    expect(all.ok).toBe(true);
    const lines = all.message.split('\n');
    expect(lines[0]).toBe(`${ITEM_KEYS.length} items:`);
    const keys = lines.slice(1).flatMap((l) => l.split(', '));
    expect(keys).toEqual([...ITEM_KEYS]);
    for (const l of lines.slice(1, -1)) expect(l.split(', ')).toHaveLength(8);
    const pots = exec(ctx, 'items POT').message.split('\n');
    expect(pots[0]).toMatch(/^\d+ items matching "pot":$/);
    for (const k of pots.slice(1).flatMap((l) => l.split(', '))) expect(k).toContain('pot');
    expect(exec(ctx, 'items wrought').message).toBe('1 item matching "wrought":\nwrought_iron');
    expect(exec(ctx, 'items zzz')).toEqual({ ok: true, message: 'no items match "zzz"' });
  });
});

describe('executeCommand — Creative-only commands in Survival', () => {
  it('fly fails in Survival with "not in Survival"; it still works in Creative', () => {
    const { ctx, player } = makeCtx({ survival: fakeSurvival() });
    expect(exec(ctx, 'fly on')).toEqual({ ok: false, message: 'fly: not in Survival — usage: fly on|off|toggle' });
    expect(player.flying).toBe(false);
    expect(ctx.setFlying).not.toHaveBeenCalled();
    ctx.survival.mode = 'creative';
    expect(exec(ctx, 'fly on')).toEqual({ ok: true, message: 'flying' });
  });

  it('give fails in Survival and points at pack add; it still works in Creative', () => {
    const { ctx } = makeCtx({ survival: fakeSurvival() });
    expect(exec(ctx, 'give stone')).toEqual({ ok: false, message: 'give: in Survival use: pack add <item> [count] — usage: give <block> [slot 1-9]' });
    expect(ctx.setHotbarSlot).not.toHaveBeenCalled();
    ctx.survival.mode = 'creative';
    expect(exec(ctx, 'give stone').ok).toBe(true);
  });
});
