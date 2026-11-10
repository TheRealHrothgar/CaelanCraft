// Caelancraft — the command language shared by the console and Rune Block scripts. See src/CONTRACTS.md §26. Pure.
//
// Grammar (one command per line):
//   line   := WS* ( '#' .* | '/'? NAME (WS+ ARG)* )? WS*        on text.split(/\r?\n/)
//   NUMBER := ('~' | '@') SIGNED? | SIGNED                        SIGNED := [+-]? ( \d+ (\.\d*)? | \.\d+ )
// `#` is a comment only as the first non-blank character of a line. NAME is case-insensitive. `say` takes the rest
// of the line verbatim. `~` is relative to the PLAYER (cell commands: the player's cell / floor(y); world commands:
// the position; `look`: the degrees F3 shows), `@` is relative to the EXECUTING RUNE's cell and is an error in the
// console. Cell arguments must resolve to integers. Commands never throw: every failure is a user-facing message
// that ends with the usage line.
//
// Survival (v0.9, docs/DESIGN-survival.md §9.7): `mode` (console only: the new `consoleOnly` flag), `vitals`, `pack` and
// `items` work through the optional `ctx.survival`; `fly`, `give` and `undo` refuse while the world is in Survival.
//
// Circuits (docs/DESIGN-circuits.md §6.5): `ignite` lights a keg, fuse or charge through `ctx.circuits` (falling back to the
// physics' keg ignite without it); `switch`, `timer`, `radio`, `volts`, `circuits` and `blackholes` reach the optional
// `ctx.circuits` and `ctx.blackHoles`. None of them is console-only: rune scripts drive circuits. `resolveBlock` accepts the
// old names in BLOCK_ALIASES (`blast_barrel`), and `give black_hole` explains that a hole cannot be held.
//
// Area commands (fill / hexfill / hexring) are validated up front (size cap, y range, every covered chunk loaded,
// edit budget) and then return a resumable AreaJob that the rune runner advances under a per-frame cell budget in
// chunk-major order, so a 32k-cell fill never stalls a frame. They skip rune blocks, bedrock and cells the player
// occupies, and report what they skipped.
import {
  WORLD_HEIGHT, HOTBAR_SIZE, PITCH_LIMIT, MAX_FILL_CELLS, MAX_TOTAL_EDITS, WAIT_MIN_S, WAIT_MAX_S,
  GAME_SECONDS_PER_DAY, AREA_MAX_RADIUS, AREA_MAX_HEIGHT, MAX_RUNE_SCRIPT_LINES, MAX_AREA_CHUNKS_PER_FRAME, PIG_MAX,
  PIG_RADIUS, PIG_HEIGHT, DRAIN_MAX_RADIUS, DRAIN_DEFAULT_RADIUS,
  ZOMBIE_MAX, ZOMBIE_RADIUS, ZOMBIE_HEIGHT, STAT_MAX, BREATH_MAX_S, BODY_TEMP_MIN, BODY_TEMP_MAX,
} from './config.js';
import { inHeightRange, worldToChunk, yawToForward } from './coords.js';
import { hexToWorld, worldToHex, hexLength, hexDiscCount } from './hex.js';
import { BLOCK, BLOCKS, BLOCK_ALIASES, BLOCK_COUNT, getBlockDef, isPlaceable, isSolid } from './blocks.js';
import { parseChannel } from './circuitParts.js';
import { findFreeY, findStandingY, playerIntersectsBlock } from './physics.js';
import { formatTime } from './daynight.js';
import { WATCHER_HEIGHT } from './watcher.js';
import { ITEM_KEYS, itemName, resolveItem } from './items.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').Rune} Rune */

// ---------------------------------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------------------------------

/**
 * Argument kinds: 'cell' (integer, ~/@ allowed), 'num' (float, ~/@ allowed), 'angle' (float, ~ allowed, or a compass
 * word), 'int' (plain integer), 'block' (name or id), 'word', 'choice:a|b|c', 'rest' (the rest of the line).
 * @typedef {Object} CommandSpec
 * @property {string} name
 * @property {string} usage
 * @property {string} summary
 * @property {string[]} args       kinds, in order
 * @property {number} min          minimum argument count
 * @property {boolean} [scriptOnly]
 * @property {boolean} [consoleOnly]   refused inside a rune script (`ctx.running`): `mode` would reload the world under the runner
 */

/** @type {readonly CommandSpec[]} */
export const COMMANDS = Object.freeze([
  { name: 'help', usage: 'help [command]', summary: 'list commands, or show one command\'s usage', args: ['word'], min: 0 },
  { name: 'blocks', usage: 'blocks', summary: 'list every block you can place (id, name, display name)', args: [], min: 0 },
  { name: 'pos', usage: 'pos', summary: 'print your cell, world position and look angles', args: [], min: 0 },
  { name: 'seed', usage: 'seed', summary: 'print the world seed', args: [], min: 0 },
  { name: 'edits', usage: 'edits', summary: 'print how many cells have been edited and the save size estimate', args: [], min: 0 },
  { name: 'tp', usage: 'tp q y r | tp q r', summary: 'teleport to the centre of a cell (2 args: onto the surface there)', args: ['cell', 'cell', 'cell'], min: 2 },
  { name: 'tpw', usage: 'tpw x y z', summary: 'teleport to a world position (floats)', args: ['num', 'num', 'num'], min: 3 },
  { name: 'look', usage: 'look yaw pitch', summary: 'set the look direction in degrees as F3 shows them (yaw may be north/east/south/west)', args: ['angle', 'num'], min: 2 },
  { name: 'setblock', usage: 'setblock q y r <block>', summary: 'put a block in one cell', args: ['cell', 'cell', 'cell', 'block'], min: 4 },
  { name: 'fill', usage: 'fill q1 y1 r1 q2 y2 r2 <block>', summary: 'fill the axial box between two cells (a parallelogram footprint)', args: ['cell', 'cell', 'cell', 'cell', 'cell', 'cell', 'block'], min: 7 },
  { name: 'hexfill', usage: 'hexfill q y r radius height <block>', summary: 'fill a hex disc of cells `radius` wide and `height` tall, starting at y', args: ['cell', 'cell', 'cell', 'int', 'int', 'block'], min: 6 },
  { name: 'hexring', usage: 'hexring q y r radius height <block>', summary: 'fill the ring of cells at exactly hex distance `radius`, `height` tall', args: ['cell', 'cell', 'cell', 'int', 'int', 'block'], min: 6 },
  { name: 'time', usage: 'time set <noon|midnight|day|night|HH:MM|0-24|0.0-1.0> | time add <HH:MM|Nh|Nm|seconds>', summary: 'set or advance the clock (game time: 86400 s per day)', args: ['choice:set|add', 'word'], min: 2 },
  { name: 'fly', usage: 'fly on|off|toggle', summary: 'flight', args: ['choice:on|off|toggle'], min: 1 },
  { name: 'give', usage: 'give <block> [slot 1-9]', summary: 'put a block in a hotbar slot (default: the selected one)', args: ['block', 'int'], min: 1 },
  { name: 'say', usage: 'say <text>', summary: 'show a message', args: ['rest'], min: 1 },
  { name: 'run', usage: 'run q y r', summary: 'trigger the rune block in that cell', args: ['cell', 'cell', 'cell'], min: 3 },
  { name: 'wait', usage: 'wait <seconds>', summary: 'pause this script (scripts only; 0.05–600 s)', args: ['num'], min: 1, scriptOnly: true },
  { name: 'stop', usage: 'stop', summary: 'end this script here without chaining (scripts only)', args: [], min: 0, scriptOnly: true },
  { name: 'stopall', usage: 'stopall', summary: 'cancel every running script and pause all rune triggers until you press R on a rune or run resume', args: [], min: 0 },
  { name: 'resume', usage: 'resume', summary: 'let rune triggers fire again after stopall', args: [], min: 0 },
  { name: 'runes', usage: 'runes', summary: 'list the rune blocks with scripts or settings', args: [], min: 0 },
  { name: 'rune', usage: 'rune q y r on|off', summary: 'enable or disable every trigger of one rune block', args: ['cell', 'cell', 'cell', 'choice:on|off'], min: 4 },
  { name: 'summon', usage: 'summon pig|zombie|watcher [q y r]', summary: 'put a pig or a zombie two cells in front of you, or in a cell (watcher: far away in view)', args: ['choice:pig|zombie|watcher', 'cell', 'cell', 'cell'], min: 1 },
  { name: 'pigs', usage: 'pigs [clear]', summary: 'count the pigs, or remove them all', args: ['choice:clear'], min: 0 },
  { name: 'zombies', usage: 'zombies [clear|on|off]', summary: 'count the zombies, remove them all, or switch zombies on / off for this world (saved)', args: ['choice:clear|on|off'], min: 0 },
  { name: 'watcher', usage: 'watcher [on|off]', summary: 'is the Hollow Watcher about? or switch it on / off for this world (saved)', args: ['choice:on|off'], min: 0 },
  { name: 'physics', usage: 'physics status|on|off | physics falling|water|collapse|explosions on|off', summary: 'block physics: show its counters, pause / resume all of it (not saved), or switch one feature (saved with the world)', args: ['word', 'choice:on|off'], min: 1 },
  { name: 'undo', usage: 'undo', summary: 'undo the last explosion, collapse or falling tree (within 60 s)', args: [], min: 0 },
  { name: 'ignite', usage: 'ignite q y r', summary: 'light the powder keg, powder fuse or collapsar charge in that cell', args: ['cell', 'cell', 'cell'], min: 3 },
  { name: 'drain', usage: 'drain [radius]', summary: `remove the water around you (a rune: around itself), radius 0–${DRAIN_MAX_RADIUS}, default ${DRAIN_DEFAULT_RADIUS}`, args: ['int'], min: 0 },
  { name: 'mode', usage: 'mode [creative|survival]', summary: 'show this world\'s mode, or switch it (saved with the world; console only)', args: ['choice:creative|survival'], min: 0, consoleOnly: true },
  { name: 'vitals', usage: 'vitals [full|health|nourishment|hydration|temp|breath] [value]', summary: 'show your Survival stats, set one (~ = relative to now), or restore them all', args: ['word', 'num'], min: 0 },
  { name: 'pack', usage: 'pack [list|add|clear] [item] [count]', summary: 'list the Survival pack, add items to it, or empty it (and what you wear)', args: ['choice:list|add|clear', 'word', 'int'], min: 0 },
  { name: 'items', usage: 'items [filter]', summary: 'list the item names pack add takes (filtered by a part of the name)', args: ['word'], min: 0 },
  // Circuits (DESIGN-circuits §6.5)
  { name: 'switch', usage: 'switch q y r [on|off|toggle|press]', summary: 'set or toggle the knife switch in that cell, or press the push button there (default toggle)', args: ['cell', 'cell', 'cell', 'choice:on|off|toggle|press'], min: 3 },
  { name: 'timer', usage: 'timer q y r [start|stop|<seconds>] [pulse|hold|repeat]', summary: 'show the clockwork timer in that cell, start or stop it, or set its delay (0.5–3600 s) and mode', args: ['cell', 'cell', 'cell', 'word', 'choice:pulse|hold|repeat'], min: 3 },
  { name: 'radio', usage: 'radio <channel>', summary: 'send a radio pulse on channel 1–16 or a wavelength 300m–1050m, from you (a rune: from its cell)', args: ['word'], min: 1 },
  { name: 'volts', usage: 'volts q y r', summary: 'measure the circuit part in that cell: volts, earth, its network', args: ['cell', 'cell', 'cell'], min: 3 },
  { name: 'circuits', usage: 'circuits [status|on|off]', summary: 'count the circuit parts, or switch circuits on / off for this world (saved)', args: ['choice:status|on|off'], min: 0 },
  { name: 'blackholes', usage: 'blackholes [status|on|off|list]', summary: 'count the black holes, list the nearest, or switch them on / off for this world (saved)', args: ['choice:status|on|off|list'], min: 0 },
]);

/** `vitals` stat words → the internal key (`satiation` is shown as Nourishment everywhere), label, range and unit. */
const VITAL_STATS = Object.freeze({
  health: Object.freeze({ key: 'health', label: 'Health', lo: 0, hi: STAT_MAX, unit: '' }),
  nourishment: Object.freeze({ key: 'satiation', label: 'Nourishment', lo: 0, hi: STAT_MAX, unit: '' }),
  hydration: Object.freeze({ key: 'hydration', label: 'Hydration', lo: 0, hi: STAT_MAX, unit: '' }),
  temp: Object.freeze({ key: 'temp', label: 'Body temperature', lo: BODY_TEMP_MIN, hi: BODY_TEMP_MAX, unit: ' °C' }),
  breath: Object.freeze({ key: 'breath', label: 'Breath', lo: 0, hi: BREATH_MAX_S, unit: ' s' }),
});

/** `pack add` takes at most this many at once. */
const PACK_ADD_MAX = 9999;
/** `items` prints this many keys per line. */
const ITEMS_PER_LINE = 8;
const NO_SURVIVAL_STATE = 'no survival state in this world (try mode survival)';

/** Block-physics feature switches (`physics <feature> on|off`); the same names as BlockPhysics FEATURES. */
const PHYSICS_FEATURES = Object.freeze(['falling', 'water', 'collapse', 'explosions']);

/** @type {Map<string, CommandSpec>} */
const SPEC_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Lines shown by `help` with no argument, after the command list. */
export const HELP_FOOTER = Object.freeze([
  'Coordinates: block commands take cells q y r (F3 shows them), tpw takes world x y z.',
  '~ = relative to you (~, ~3, ~-1); @ = relative to this rune block (scripts only).',
  'Lines starting with # are comments. T opens this console, / opens it with a slash typed.',
]);

// ---------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------

const NUMBER_RE = /^([~@])?([+-]?(?:\d+(?:\.\d*)?|\.\d+))?$/;
const INT_RE = /^[+-]?\d+$/;
/** Compass words for `look`: yaw degrees as F3 shows them (0 = north/−Z, positive turns left). */
export const COMPASS = Object.freeze({ north: 0, west: 90, south: 180, east: -90 });

/**
 * @typedef {Object} ParsedCommand
 * @property {number} line      1-based line number in the script
 * @property {string} name      lower-case command name
 * @property {string[]} args    raw argument tokens (for `say`: one element, the rest of the line)
 * @property {string} raw       the trimmed source line
 */
/** @typedef {{ line: number, message: string }} ParseError */

/**
 * Validate a numeric token against the grammar for its kind.
 * @returns {string|null} error text or null when fine
 */
function checkNumberToken(token, kind, argName) {
  const m = NUMBER_RE.exec(token);
  if (!m || (m[1] === undefined && m[2] === undefined)) return `expected a number for ${argName}, got "${token}"`;
  if (kind === 'int' && (m[1] !== undefined || !INT_RE.test(token))) return `${argName} must be a plain integer, got "${token}"`;
  return null;
}

/** Name of argument i from the usage string (best effort), e.g. 'q', 'radius', '<block>'. Alternative forms are separated by ' | '. */
function argLabel(spec, i) {
  const parts = spec.usage.split(' | ')[0].trim().split(/\s+/).slice(1);
  return parts[i] ? parts[i].replace(/^\[|\]$/g, '') : `argument ${i + 1}`;
}

/**
 * Parse one line. Returns null for blank/comment lines, a ParsedCommand, or a ParseError.
 * @param {string} text
 * @param {number} [lineNo=1]
 * @returns {ParsedCommand|ParseError|null}
 */
export function parseLine(text, lineNo = 1) {
  let s = String(text ?? '').trim();
  if (s === '' || s.startsWith('#')) return null;
  if (s.startsWith('/')) s = s.slice(1).trimStart();
  if (s === '') return null;
  const sp = s.search(/\s/);
  const name = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
  const restText = sp < 0 ? '' : s.slice(sp).trim();
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return { line: lineNo, message: `unknown command "${name}" (try help)` };

  /** @type {string[]} */
  let args;
  if (spec.args[0] === 'rest') args = restText === '' ? [] : [restText];
  else args = restText === '' ? [] : restText.split(/\s+/);

  if (args.length < spec.min || args.length > spec.args.length) {
    const expected = spec.usage.split(' | ')[0].trim().replace(/^\S+\s*/, '') || 'no arguments';
    return { line: lineNo, message: `${name}: expected ${expected} (got ${args.length} arg${args.length === 1 ? '' : 's'}) — usage: ${spec.usage}` };
  }
  for (let i = 0; i < args.length; i++) {
    const kind = spec.args[i];
    const argName = argLabel(spec, i);
    let err = null;
    if (kind === 'cell' || kind === 'num' || kind === 'int') err = checkNumberToken(args[i], kind, argName);
    else if (kind === 'angle') {
      if (!Object.hasOwn(COMPASS, args[i].toLowerCase())) err = checkNumberToken(args[i], 'num', argName);
    } else if (kind.startsWith('choice:')) {
      const options = kind.slice(7).split('|');
      if (!options.includes(args[i].toLowerCase())) err = `expected one of ${options.join(', ')}, got "${args[i]}"`;
      else args[i] = args[i].toLowerCase();
    }
    if (err) return { line: lineNo, message: `${name}: ${err} — usage: ${spec.usage}` };
  }
  return { line: lineNo, name, args, raw: s };
}

/**
 * Parse a whole script. Never throws. Lines beyond MAX_RUNE_SCRIPT_LINES are reported as one error and ignored.
 * @param {string} text
 * @returns {{ commands: ParsedCommand[], errors: ParseError[] }}
 */
export function parseScript(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  /** @type {ParsedCommand[]} */
  const commands = [];
  /** @type {ParseError[]} */
  const errors = [];
  const n = Math.min(lines.length, MAX_RUNE_SCRIPT_LINES);
  for (let i = 0; i < n; i++) {
    const r = parseLine(lines[i], i + 1);
    if (r === null) continue;
    if ('name' in r) commands.push(r);
    else errors.push(r);
  }
  if (lines.length > MAX_RUNE_SCRIPT_LINES) {
    errors.push({ line: MAX_RUNE_SCRIPT_LINES + 1, message: `too many lines (${lines.length} > ${MAX_RUNE_SCRIPT_LINES}); lines after ${MAX_RUNE_SCRIPT_LINES} are dropped` });
  }
  return { commands, errors };
}

// ---------------------------------------------------------------------------------------------------
// Block names
// ---------------------------------------------------------------------------------------------------

/**
 * Resolve a block token: exact name, an old name in BLOCK_ALIASES (`blast_barrel`, or its display form `blast barrel`),
 * display name with `_` for spaces (`red_wool`), a unique prefix or substring match, or an integer id below BLOCK_COUNT.
 * A `minecraft:` prefix is ignored. Case-insensitive.
 * @param {string} token
 * @returns {{ id: number }|{ error: string }}
 */
export function resolveBlock(token) {
  let t = String(token ?? '').trim().toLowerCase();
  if (t.startsWith('minecraft:')) t = t.slice(10);
  if (t === '') return { error: 'expected a block name' };
  if (INT_RE.test(t)) {
    const id = Number(t);
    if (id >= 0 && id < BLOCK_COUNT) return { id };
    return { error: `unknown block id ${id} (0..${BLOCK_COUNT - 1}; type blocks to list them)` };
  }
  for (const def of BLOCKS) if (def.name === t) return { id: def.id };
  const alias = t.replace(/ /g, '_');
  if (Object.hasOwn(BLOCK_ALIASES, alias)) return { id: BLOCK_ALIASES[alias] };
  const asDisplay = t.replace(/_/g, ' ');
  for (const def of BLOCKS) if (def.displayName.toLowerCase() === asDisplay) return { id: def.id };
  const prefix = BLOCKS.filter((d) => d.name.startsWith(t) || d.displayName.toLowerCase().replace(/ /g, '_').startsWith(t));
  if (prefix.length === 1) return { id: prefix[0].id };
  const sub = prefix.length ? prefix : BLOCKS.filter((d) => d.name.includes(t));
  if (sub.length === 1) return { id: sub[0].id };
  if (sub.length > 1) return { error: `ambiguous block "${token}": ${sub.map((d) => d.name).join(', ')}` };
  return { error: `unknown block "${token}" (type blocks to list them)` };
}

// ---------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} CommandContext  Provided by main.js (CONTRACTS §26.3): everything the executor may touch.
 * @property {import('./world.js').World} world
 * @property {PlayerState} player
 * @property {{ yaw: number, pitch: number }} controls     writable yaw/pitch (radians)
 * @property {() => number} getTime
 * @property {(t: number) => void} setTime                  sets the day fraction (never touches the day counter)
 * @property {(gameSeconds: number) => void} addTime        advances/rewinds the clock; main bumps `day` when it passes midnight forwards
 * @property {boolean} timeFrozen                           true under ?time=
 * @property {number[]} hotbar
 * @property {number} selected
 * @property {(slot: number, id: number) => void} setHotbarSlot
 * @property {(text: string) => void} say
 * @property {(x: number, y: number, z: number) => void} teleport   moves the player (feet), zeroes velocities and seeds the step-on state
 * @property {(on: boolean) => void} setFlying
 * @property {import('./runes.js').RuneStore} runes
 * @property {import('./pigs.js').Pigs} [pigs]            absent in contexts without creatures (summon / pigs then fail)
 * @property {import('./zombies.js').Zombies} [zombies]   absent without zombies (summon zombie / zombies then fail)
 * @property {import('./watcher.js').Watcher} [watcher]   absent without the Hollow Watcher (summon watcher / watcher then fail)
 * @property {import('./watcher.js').WatcherWorld} [watcherWorld]  the view summon watcher places it in (main refreshes it)
 * @property {import('./blockphysics.js').BlockPhysics} [physics]  absent without block physics (physics / undo / ignite / drain then fail)
 * @property {import('./runes.js').RuneRunner} runner
 * @property {Rune|null} rune                               the executing rune (for `@`), null in the console
 * @property {import('./runes.js').Running|null} running    the executing script, null in the console
 * @property {number} seed
 * @property {SurvivalCommands} [survival]   v0.9: absent where there is no survival (mode / vitals / pack then fail)
 * @property {CircuitCommands} [circuits]     absent without circuits (switch / timer / radio / volts / circuits then fail;
 *                                            ignite falls back to physics.explosions)
 * @property {BlackHoleCommands} [blackHoles] absent without black holes (`blackholes` then fails)
 */

/**
 * What the circuit commands may touch (the world's Circuits, DESIGN-circuits §6.5).
 * @typedef {Object} CircuitCommands
 * @property {boolean} enabled
 * @property {(on: boolean) => boolean} setEnabled   true when it changed
 * @property {(q: number, y: number, r: number) => { ok: boolean, message: string }} ignite
 * @property {(q: number, y: number, r: number, mode: string) => { ok: boolean, message: string }} switchAt
 * @property {(q: number, y: number, r: number, cmd?: string|number, mode?: string) => { ok: boolean, message: string }} timerAt
 * @property {(ch: number, x: number, y: number, z: number) => { ok: boolean, message: string }} radio
 * @property {(q: number, y: number, r: number) => ({ volts: number, amps: number, earthed: boolean|null, earthReason: string,
 *   state: string, diag: string|null, net: { cells: number, sources: number, loads: number, partial: boolean,
 *   truncated: boolean }|null }|null)} probe
 * @property {() => { parts: number, networks: number, burning: number, timers: number }} stats
 */

/**
 * What `blackholes` may touch (BlackHoles itself, DESIGN-circuits §6.2.4).
 * @typedef {Object} BlackHoleCommands
 * @property {boolean} enabled
 * @property {(on: boolean) => (boolean|void)} setEnabled
 * @property {() => string} status
 * @property {(x: number, y: number, z: number) => string[]} list
 */

/**
 * What the survival commands may touch (main's implementation, DESIGN-survival §9.5 / §9.7).
 * @typedef {Object} SurvivalCommands
 * @property {'creative'|'survival'} mode
 * @property {boolean} hasState                 the world has entered Survival at least once
 * @property {(m: 'creative'|'survival') => { ok: boolean, message: string }} setMode   queues the switch (requestMode)
 * @property {() => ({ health: number, satiation: number, hydration: number, temp: number, breath: number,
 *   labels?: string[] }|null)} vitals          the current (or frozen) stats; null without a survival state
 * @property {(name: string, v: number) => boolean} setVital   internal key ('health', 'satiation', 'hydration', 'temp',
 *   'breath'); the value is already clamped; `health` 0 makes main die with cause 'command'
 * @property {() => void} restoreVitals
 * @property {(key: string, n: number) => (number|{n: number, refused?: string}|{n: number}[]|null|undefined)} packAdd
 *   what did not fit: a count, a stack, a list of stacks, or null/undefined when everything fit; `refused` (a reason) when
 *   the game would not add the item at all (§14.2: a second handbook)
 * @property {() => void} packClear              empties the pack and the worn items
 * @property {() => string} packList             the non-empty slots ('' when there are none)
 */

/**
 * @typedef {Object} CommandResult
 * @property {boolean} ok
 * @property {string} message        user-facing text ('' when nothing to say)
 * @property {number} [wait]         `wait`: seconds to pause the script
 * @property {boolean} [stop]        `stop`: end the script without chaining
 * @property {AreaJob} [job]         area commands: the resumable job to advance under the cell budget
 */

/**
 * @typedef {Object} AreaJob  A resumable fill. `step(maxCells)` processes up to maxCells cells — but never more than
 *   MAX_AREA_CHUNKS_PER_FRAME distinct chunk columns (cells are chunk-major) — and returns how many it processed. The
 *   runner calls it at most once per frame, so the chunk bound is a per-frame bound on the re-mesh work.
 * @property {string} name
 * @property {number} total
 * @property {number} cursor
 * @property {number} written
 * @property {number} unchanged
 * @property {number} skippedRune
 * @property {number} skippedPlayer
 * @property {number} skippedBedrock
 * @property {number} skippedUnloaded   cells whose chunk unloaded after the job started
 * @property {boolean} done
 * @property {(maxCells: number) => number} step
 * @property {() => string} summary
 */

/** @returns {number} cells of area jobs that are queued or running but not yet written (reserved against the edit budget) */
function reservedCells(ctx) {
  const running = ctx.runner && ctx.runner.running;
  if (!running || typeof running.values !== 'function') return 0;
  let n = 0;
  for (const run of running.values()) if (run && run.job && !run.job.done) n += run.job.total - run.job.cursor;
  return n;
}

/** @returns {CommandResult} */
function fail(spec, message) {
  return { ok: false, message: `${spec.name}: ${message} — usage: ${spec.usage}` };
}
/** @returns {CommandResult} */
function ok(message) {
  return { ok: true, message };
}

/**
 * Resolve a numeric token against a base: plain → value; `~` → playerBase + offset; `@` → runeBase + offset.
 * @returns {{ value: number }|{ error: string }}
 */
function resolveNumber(token, playerBase, runeBase, argName, ctx) {
  const m = NUMBER_RE.exec(token);
  if (!m || (m[1] === undefined && m[2] === undefined)) return { error: `expected a number for ${argName}, got "${token}"` };
  const offset = m[2] === undefined ? 0 : Number(m[2]);
  if (m[1] === undefined) return { value: offset };
  if (m[1] === '~') return { value: playerBase + offset };
  if (!ctx.rune) return { error: '@ is only valid inside a rune script' };
  return { value: runeBase + offset };
}

/** Resolve a CELL coordinate token (must end up an integer). */
function resolveCell(token, axis, argName, ctx) {
  const p = ctx.player;
  const [pq, pr] = worldToHex(p.x, p.z);
  const playerBase = axis === 'q' ? pq : axis === 'r' ? pr : Math.floor(p.y);
  const runeBase = ctx.rune ? (axis === 'q' ? ctx.rune.q : axis === 'r' ? ctx.rune.r : ctx.rune.y) : 0;
  const r = resolveNumber(token, playerBase, runeBase, argName, ctx);
  if ('error' in r) return r;
  if (!Number.isInteger(r.value)) return { error: `expected an integer for ${argName}, got "${token}"` };
  return r;
}

/** Resolve q y r cell tokens starting at args[i]. @returns {{ cell: [number, number, number] }|{ error: string }} */
function resolveCellTriple(args, i, ctx, labels = ['q', 'y', 'r']) {
  const out = [0, 0, 0];
  const axes = ['q', 'y', 'r'];
  for (let k = 0; k < 3; k++) {
    const r = resolveCell(args[i + k], axes[k], labels[k], ctx);
    if ('error' in r) return r;
    out[k] = r.value;
  }
  return { cell: /** @type {[number, number, number]} */ (out) };
}

/** Radians → degrees in [-180, 180) (the convention of the F3 overlay). */
export function yawToDegrees(yaw) {
  const deg = (yaw * 180) / Math.PI;
  return deg - Math.floor((deg + 180) / 360) * 360;
}

/** Degrees → radians wrapped to [-π, π). */
function degreesToYaw(deg) {
  const rad = (deg * Math.PI) / 180;
  const twoPi = Math.PI * 2;
  return rad - Math.floor((rad + Math.PI) / twoPi) * twoPi;
}

/** `HH:MM` → day fraction, or null. */
function parseClock(token) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return (h * 60 + min) / 1440;
}

/**
 * Parse a `time set` specification into a day fraction in [0, 1), or null.
 * noon 0.5, midnight 0, day 0.25 (06:00), night 0.75 (18:00); HH:MM; a bare integer 0..24 = hours;
 * a number with a decimal point in [0, 1] = fraction of the day.
 */
export function parseTimeSpec(token) {
  const t = String(token).toLowerCase();
  if (t === 'noon') return 0.5;
  if (t === 'midnight') return 0;
  if (t === 'day') return 0.25;
  if (t === 'night') return 0.75;
  const clock = parseClock(t);
  if (clock !== null) return clock;
  if (/^\d{1,2}$/.test(t)) {
    const h = Number(t);
    return h <= 24 ? (h % 24) / 24 : null;
  }
  if (/^(\d+\.\d*|\.\d+)$/.test(t)) {
    const f = Number(t);
    return f >= 0 && f <= 1 ? f % 1 : null;
  }
  return null;
}

/**
 * Parse a `time add` duration into GAME seconds, or null. `HH:MM`, `Nh`, `Nm`, `Ns`, a signed number with a decimal
 * point and |v| <= 1 = fraction of a day, a signed integer = game seconds.
 */
export function parseDurationSpec(token) {
  const t = String(token).toLowerCase();
  let sign = 1;
  let body = t;
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1);
  } else if (body.startsWith('+')) body = body.slice(1);
  const clock = /^(\d{1,3}):(\d{2})$/.exec(body);
  if (clock) return Number(clock[2]) <= 59 ? sign * (Number(clock[1]) * 3600 + Number(clock[2]) * 60) : null;
  const unit = /^(\d+(?:\.\d+)?)([hms])$/.exec(body);
  if (unit) {
    const v = Number(unit[1]);
    return sign * v * (unit[2] === 'h' ? 3600 : unit[2] === 'm' ? 60 : 1);
  }
  if (/^(\d+\.\d*|\.\d+)$/.test(body)) {
    const f = Number(body);
    return f <= 1 ? sign * f * GAME_SECONDS_PER_DAY : null;
  }
  if (/^\d+$/.test(body)) return sign * Number(body);
  return null;
}

// ---- area jobs --------------------------------------------------------------------------------------

/** Order cells chunk-major (cq, cr), then q, r, y so a frame's writes stay inside one or two chunks. */
function sortChunkMajor(cells) {
  const keyed = cells.map((c) => ({ c, k: [worldToChunk(c[0]), worldToChunk(c[2]), c[0], c[2], c[1]] }));
  keyed.sort((a, b) => {
    for (let i = 0; i < 5; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
    return 0;
  });
  for (let i = 0; i < cells.length; i++) cells[i] = keyed[i].c;
}

/**
 * Validate an area command's target cells and build its job.
 * @param {CommandSpec} spec
 * @param {number[][]} cells   [q, y, r] triples (unsorted)
 * @param {number} id
 * @param {CommandContext} ctx
 * @returns {CommandResult}
 */
function makeAreaJob(spec, cells, id, ctx) {
  const total = cells.length;
  if (total > MAX_FILL_CELLS) return fail(spec, `too large: ${total} cells (max ${MAX_FILL_CELLS}) — lower the size`);
  if (id === BLOCK.RUNE_BLOCK) return fail(spec, 'use setblock for rune blocks');
  if (id === BLOCK.BEDROCK) return fail(spec, 'bedrock cannot be placed');
  for (const c of cells) {
    if (!inHeightRange(c[1])) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1}`);
  }
  // Atomic across chunks: every covered chunk column must be loaded.
  const loadedChunks = new Set();
  let unloadedCells = 0;
  for (const c of cells) {
    const ck = `${worldToChunk(c[0])},${worldToChunk(c[2])}`;
    if (loadedChunks.has(ck)) continue;
    if (ctx.world.hasChunkAtCell(c[0], c[2])) loadedChunks.add(ck);
    else unloadedCells++;
  }
  if (unloadedCells > 0) return fail(spec, `${unloadedCells} cells are in unloaded chunks (nothing changed)`);
  const editCount = ctx.world.editCount + reservedCells(ctx);
  if (editCount + total > MAX_TOTAL_EDITS) {
    return fail(spec, `world edit budget exceeded (${editCount} of ${MAX_TOTAL_EDITS} cells used or queued; this needs ${total}) — fill some of it back to its original blocks`);
  }
  sortChunkMajor(cells);
  const world = ctx.world;
  const player = ctx.player;
  const solid = isSolid(id);
  /** @type {AreaJob} */
  const job = {
    name: spec.name,
    total,
    cursor: 0,
    written: 0,
    unchanged: 0,
    skippedRune: 0,
    skippedPlayer: 0,
    skippedBedrock: 0,
    skippedUnloaded: 0,
    done: total === 0,
    step(maxCells) {
      let n = 0;
      let chunks = 0;
      let curCq = NaN;
      let curCr = NaN;
      while (job.cursor < total && n < maxCells) {
        const c = cells[job.cursor];
        const cq = worldToChunk(c[0]);
        const cr = worldToChunk(c[2]);
        if (cq !== curCq || cr !== curCr) {
          if (chunks >= MAX_AREA_CHUNKS_PER_FRAME) break; // next chunk column waits for the next frame
          chunks++;
          curCq = cq;
          curCr = cr;
        }
        job.cursor++;
        n++;
        if (!world.hasChunkAtCell(c[0], c[2])) {
          job.skippedUnloaded++;
          continue;
        }
        const current = world.getBlock(c[0], c[1], c[2]);
        if (current === id) {
          job.unchanged++;
          continue;
        }
        if (current === BLOCK.RUNE_BLOCK) {
          job.skippedRune++;
          continue;
        }
        if (current === BLOCK.BEDROCK) {
          job.skippedBedrock++;
          continue;
        }
        if (solid && playerIntersectsBlock(player, c[0], c[1], c[2])) {
          job.skippedPlayer++;
          continue;
        }
        if (world.setBlock(c[0], c[1], c[2], id)) job.written++;
        else job.unchanged++;
      }
      if (job.cursor >= total) job.done = true;
      return n;
    },
    summary() {
      const parts = [];
      if (job.unchanged) parts.push(`${job.unchanged} unchanged`);
      if (job.skippedRune) parts.push(`skipped ${job.skippedRune} rune block${job.skippedRune === 1 ? '' : 's'}`);
      if (job.skippedPlayer) parts.push(`skipped ${job.skippedPlayer} occupied by you`);
      if (job.skippedBedrock) parts.push(`skipped ${job.skippedBedrock} bedrock`);
      if (job.skippedUnloaded) parts.push(`skipped ${job.skippedUnloaded} in chunks that unloaded`);
      return `${spec.name}: ${job.written} cells set to ${getBlockDef(id).name}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    },
  };
  return { ok: true, message: '', job };
}

/** Cells of the hex disc (or ring when `ring`) of hex radius `radius` around (q, r), y in [y0, y0 + height). */
export function hexAreaCells(q, y0, r, radius, height, ring) {
  const cells = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const d = hexLength(dq, dr);
      if (d > radius || (ring && d !== radius)) continue;
      for (let y = y0; y < y0 + height; y++) cells.push([q + dq, y, r + dr]);
    }
  }
  return cells;
}

// ---- the executor --------------------------------------------------------------------------------------

/**
 * Execute one parsed command. Never throws.
 * @param {ParsedCommand} cmd
 * @param {CommandContext} ctx
 * @returns {CommandResult}
 */
export function executeCommand(cmd, ctx) {
  const spec = SPEC_BY_NAME.get(cmd.name);
  if (!spec) return { ok: false, message: `unknown command "${cmd.name}" (try help)` };
  try {
    return run(spec, cmd.args, ctx);
  } catch (err) {
    return { ok: false, message: `${spec.name}: internal error: ${err && err.message ? err.message : err}` };
  }
}

// ---------------------------------------------------------------------------------------------------
// Zombies (§39): `summon zombie [q y r]` (by day too: handy for testing) and `zombies [clear|on|off]`.
// ---------------------------------------------------------------------------------------------------

/** @returns {CommandResult} */
function summonZombie(spec, args, ctx) {
  const zs = ctx.zombies;
  if (!zs) return fail(spec, 'zombies are not available here');
  if (!zs.enabled) return fail(spec, 'zombies are off in this world (zombies on to allow them)');
  if (args.length !== 1 && args.length !== 4) return fail(spec, `expected 1 or 4 args (got ${args.length})`);
  const world = ctx.world;
  const p = ctx.player;
  let x;
  let z;
  let fy;
  if (args.length === 4) {
    const rc = resolveCellTriple(args, 1, ctx);
    if ('error' in rc) return fail(spec, rc.error);
    const [q, y, r] = rc.cell;
    if (!(y >= 0 && y <= WORLD_HEIGHT - 2)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 2}`);
    if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
    [x, z] = hexToWorld(q, r);
    fy = findFreeY(world.getBlock, x, z, y, 2, ZOMBIE_RADIUS, ZOMBIE_HEIGHT);
    if (fy === null) return fail(spec, 'target is inside a block');
  } else {
    const [fx, fz] = yawToForward(ctx.controls.yaw);
    const [q, r] = worldToHex(p.x + fx * 2, p.z + fz * 2);
    if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
    [x, z] = hexToWorld(q, r);
    fy = findFreeY(world.getBlock, x, z, Math.max(0, Math.floor(p.y)), 2, ZOMBIE_RADIUS, ZOMBIE_HEIGHT);
    if (fy === null) return fail(spec, 'no room in front of you');
  }
  // It turns to face you.
  const zb = zs.spawn(x, fy, z, Math.atan2(-(p.x - x), -(p.z - z)));
  if (!zb) return fail(spec, `too many zombies (max ${ZOMBIE_MAX})`);
  const [pq, pr] = worldToHex(x, z);
  return ok(`summoned a zombie at ${pq} ${fy} ${pr}`);
}

/** @returns {CommandResult} */
function zombiesCommand(spec, args, ctx) {
  const zs = ctx.zombies;
  if (!zs) return fail(spec, 'zombies are not available here');
  const n = zs.size;
  const count = (k) => `${k} zombie${k === 1 ? '' : 's'}`;
  if (args.length === 0) return ok(`${count(n)} (max ${ZOMBIE_MAX}) · zombies are ${zs.enabled ? 'on' : 'off'} in this world`);
  if (args[0] === 'clear') {
    zs.clear();
    return ok(`removed ${count(n)}`);
  }
  const on = args[0] === 'on';
  if (!zs.setEnabled(on)) return ok(`zombies are already ${on ? 'on' : 'off'}`);
  return ok(on ? 'zombies on (saved with this world)' : `zombies off (saved with this world)${n ? `: removed ${count(n)}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The Hollow Watcher (§40): `summon watcher [q y r]` (any time of day: for testing) and `watcher [on|off]`.
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {CommandResult} */
function summonWatcher(spec, args, ctx) {
  const w = ctx.watcher;
  if (!w || !ctx.watcherWorld) return fail(spec, 'the Watcher is not available here');
  if (!w.enabled) return fail(spec, 'the Watcher is off in this world (watcher on to allow it)');
  if (w.present) return fail(spec, 'the Watcher is already here');
  if (args.length !== 1 && args.length !== 4) return fail(spec, `expected 1 or 4 args (got ${args.length})`);
  const world = ctx.world;
  let f;
  if (args.length === 4) {
    const rc = resolveCellTriple(args, 1, ctx);
    if ('error' in rc) return fail(spec, rc.error);
    const [q, y, r] = rc.cell;
    if (!(y >= 0 && y <= WORLD_HEIGHT - 3)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 3}`);
    if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
    const [x, z] = hexToWorld(q, r);
    const fy = findFreeY(world.getBlock, x, z, y, 2, 0.2, WATCHER_HEIGHT);
    if (fy === null) return fail(spec, 'target is inside a block');
    f = w.summonAt(ctx.watcherWorld, q, fy, r);
  } else {
    f = w.summon(ctx.watcherWorld);
    if (!f) return fail(spec, 'no open ground for it out there in view (try another direction, or a render distance of 4 or more)');
  }
  if (!f) return fail(spec, 'the Watcher is already here');
  const p = ctx.player;
  const d = Math.round(Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z));
  // summon prefers a spot in sight; walled in (a cave) it stands hidden in the view and goes 30 s later, unseen.
  return ok(`summoned the Watcher at ${f.q} ${f.y} ${f.r}, ${d} away${f.los ? '' : ' (out of sight)'}`);
}

/** @returns {CommandResult} */
function watcherCommand(spec, args, ctx) {
  const w = ctx.watcher;
  if (!w) return fail(spec, 'the Watcher is not available here');
  if (args.length === 0) {
    const f = w.figure;
    const p = ctx.player;
    const where = f && p ? `it is here, ${Math.round(Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z))} away` : 'it is not here';
    return ok(`the Watcher is ${w.enabled ? 'on' : 'off'} in this world · ${where}`);
  }
  const on = args[0] === 'on';
  const was = w.present;
  if (!w.setEnabled(on)) return ok(`the Watcher is already ${on ? 'on' : 'off'}`);
  return ok(on ? 'the Watcher on (saved with this world)' : `the Watcher off (saved with this world)${was ? ': it is gone' : ''}`);
}

/**
 * @param {CommandSpec} spec
 * @param {string[]} args
 * @param {CommandContext} ctx
 * @returns {CommandResult}
 */
function run(spec, args, ctx) {
  const world = ctx.world;
  const p = ctx.player;
  if (spec.scriptOnly && !ctx.running) return fail(spec, `${spec.name} is only valid inside a rune script`);
  if (spec.consoleOnly && ctx.running) return fail(spec, `${spec.name} is only valid in the console`);

  switch (spec.name) {
    case 'help': {
      if (args.length === 1) {
        const s = SPEC_BY_NAME.get(args[0].toLowerCase().replace(/^\//, ''));
        if (!s) return ok(`no command "${args[0]}" — type help for the list`);
        return ok(`${s.usage}\n  ${s.summary}`);
      }
      const lines = COMMANDS.map((c) => `${c.usage}  — ${c.summary}`);
      return ok(lines.concat(HELP_FOOTER).join('\n'));
    }
    case 'blocks': {
      const lines = BLOCKS.filter((d) => d.id === BLOCK.AIR || isPlaceable(d.id)).map((d) => `${String(d.id).padStart(2)} ${d.name} (${d.displayName})`);
      return ok(lines.join('\n'));
    }
    case 'pos': {
      const [q, r] = worldToHex(p.x, p.z);
      return ok(`cell ${q} ${Math.floor(p.y)} ${r} · world ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} · yaw ${yawToDegrees(ctx.controls.yaw).toFixed(1)} pitch ${((ctx.controls.pitch * 180) / Math.PI).toFixed(1)}`);
    }
    case 'seed':
      return ok(`seed ${ctx.seed}`);
    case 'edits': {
      const n = world.editCount;
      return ok(`${n} edited cells (≈ ${Math.round((n * 8) / 1024)} KB of save data, budget ${MAX_TOTAL_EDITS})`);
    }
    case 'tp': {
      if (args.length === 2) {
        const rq = resolveCell(args[0], 'q', 'q', ctx);
        if ('error' in rq) return fail(spec, rq.error);
        const rr = resolveCell(args[1], 'r', 'r', ctx);
        if ('error' in rr) return fail(spec, rr.error);
        if (!world.hasChunkAtCell(rq.value, rr.value)) return fail(spec, 'target is not loaded');
        const [x, z] = hexToWorld(rq.value, rr.value);
        const fy = findStandingY(world.getBlock, x, z, WORLD_HEIGHT - 2);
        if (fy === null) return fail(spec, `no ground at (${rq.value}, ${rr.value})`);
        ctx.teleport(x, fy, z);
        return ok(`teleported to cell ${rq.value} ${fy} ${rr.value}`);
      }
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const [q, y, r] = rc.cell;
      if (!(y >= 0 && y <= WORLD_HEIGHT - 2)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 2}`);
      if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
      const [x, z] = hexToWorld(q, r);
      const fy = findFreeY(world.getBlock, x, z, y, 2);
      if (fy === null) return fail(spec, 'target is inside a block');
      ctx.teleport(x, fy, z);
      return ok(`teleported to cell ${q} ${fy} ${r}`);
    }
    case 'tpw': {
      const runeWorld = ctx.rune ? hexToWorld(ctx.rune.q, ctx.rune.r) : null;
      const playerBases = [p.x, p.y, p.z];
      const runeBases = runeWorld ? [runeWorld[0], ctx.rune.y + 1, runeWorld[1]] : [0, 0, 0];
      const vals = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const r = resolveNumber(args[i], playerBases[i], runeBases[i], 'xyz'[i], ctx);
        if ('error' in r) return fail(spec, r.error);
        vals[i] = r.value;
      }
      const [x, y, z] = vals;
      if (!(y >= 0 && y <= WORLD_HEIGHT - 2)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 2}`);
      if (!world.hasChunkAt(x, z)) return fail(spec, 'target is not loaded');
      const fy = findFreeY(world.getBlock, x, z, y, 2);
      if (fy === null) return fail(spec, 'target is inside a block');
      ctx.teleport(x, fy, z);
      return ok(`teleported to ${x.toFixed(2)} ${fy.toFixed(2)} ${z.toFixed(2)}`);
    }
    case 'look': {
      let yawDeg;
      const word = args[0].toLowerCase();
      if (Object.hasOwn(COMPASS, word)) yawDeg = COMPASS[word];
      else {
        const r = resolveNumber(args[0], yawToDegrees(ctx.controls.yaw), 0, 'yaw', ctx);
        if ('error' in r) return fail(spec, r.error);
        yawDeg = r.value;
      }
      const rp = resolveNumber(args[1], (ctx.controls.pitch * 180) / Math.PI, 0, 'pitch', ctx);
      if ('error' in rp) return fail(spec, rp.error);
      const limitDeg = (PITCH_LIMIT * 180) / Math.PI;
      const pitchDeg = Math.max(-limitDeg, Math.min(limitDeg, rp.value));
      ctx.controls.yaw = degreesToYaw(yawDeg);
      ctx.controls.pitch = (pitchDeg * Math.PI) / 180;
      return ok(`looking yaw ${yawToDegrees(ctx.controls.yaw).toFixed(1)} pitch ${pitchDeg.toFixed(1)}`);
    }
    case 'setblock': {
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const [q, y, r] = rc.cell;
      const rb = resolveBlock(args[3]);
      if ('error' in rb) return fail(spec, rb.error);
      if (rb.id === BLOCK.BEDROCK) return fail(spec, 'bedrock cannot be placed');
      if (!inHeightRange(y)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1}`);
      if (!world.hasChunkAtCell(q, r)) return fail(spec, `cell (${q}, ${y}, ${r}) is not loaded`);
      const current = world.getBlock(q, y, r);
      if (current === rb.id) return ok(`cell (${q}, ${y}, ${r}) is already ${getBlockDef(rb.id).name}`);
      if (isSolid(rb.id) && playerIntersectsBlock(p, q, y, r)) return fail(spec, 'that cell is occupied by you');
      if (current === BLOCK.BEDROCK) return fail(spec, 'bedrock cannot be replaced');
      if (!world.setBlock(q, y, r, rb.id)) return fail(spec, `could not set cell (${q}, ${y}, ${r})`);
      return ok(`set ${getBlockDef(rb.id).name} at (${q}, ${y}, ${r})`);
    }
    case 'fill': {
      const a = resolveCellTriple(args, 0, ctx, ['q1', 'y1', 'r1']);
      if ('error' in a) return fail(spec, a.error);
      const b = resolveCellTriple(args, 3, ctx, ['q2', 'y2', 'r2']);
      if ('error' in b) return fail(spec, b.error);
      const rb = resolveBlock(args[6]);
      if ('error' in rb) return fail(spec, rb.error);
      const q0 = Math.min(a.cell[0], b.cell[0]);
      const q1 = Math.max(a.cell[0], b.cell[0]);
      const y0 = Math.min(a.cell[1], b.cell[1]);
      const y1 = Math.max(a.cell[1], b.cell[1]);
      const r0 = Math.min(a.cell[2], b.cell[2]);
      const r1 = Math.max(a.cell[2], b.cell[2]);
      const total = (q1 - q0 + 1) * (y1 - y0 + 1) * (r1 - r0 + 1);
      if (total > MAX_FILL_CELLS) return fail(spec, `too large: ${total} cells (max ${MAX_FILL_CELLS}) — lower the size`);
      if (!inHeightRange(y0) || !inHeightRange(y1)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1}`);
      const cells = [];
      for (let q = q0; q <= q1; q++) for (let r = r0; r <= r1; r++) for (let y = y0; y <= y1; y++) cells.push([q, y, r]);
      return makeAreaJob(spec, cells, rb.id, ctx);
    }
    case 'hexfill':
    case 'hexring': {
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const radius = Number(args[3]);
      const height = Number(args[4]);
      if (radius < 0 || radius > AREA_MAX_RADIUS) return fail(spec, `radius must be 0..${AREA_MAX_RADIUS}`);
      if (height < 1 || height > AREA_MAX_HEIGHT) return fail(spec, `height must be 1..${AREA_MAX_HEIGHT}`);
      const rb = resolveBlock(args[5]);
      if ('error' in rb) return fail(spec, rb.error);
      const ring = spec.name === 'hexring';
      const total = (ring ? (radius === 0 ? 1 : 6 * radius) : hexDiscCount(radius)) * height;
      if (total > MAX_FILL_CELLS) return fail(spec, `too large: ${total} cells (max ${MAX_FILL_CELLS}) — lower radius or height`);
      const [q, y, r] = rc.cell;
      if (!inHeightRange(y) || !inHeightRange(y + height - 1)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1} for every layer (${y}..${y + height - 1})`);
      return makeAreaJob(spec, hexAreaCells(q, y, r, radius, height, ring), rb.id, ctx);
    }
    case 'time': {
      if (ctx.timeFrozen) return fail(spec, 'time is frozen by ?time=');
      if (args[0] === 'set') {
        const t = parseTimeSpec(args[1]);
        if (t === null) return fail(spec, `bad time "${args[1]}"`);
        ctx.setTime(t);
        return ok(`time set to ${formatTime(t)}`);
      }
      const d = parseDurationSpec(args[1]);
      if (d === null) return fail(spec, `bad duration "${args[1]}"`);
      ctx.addTime(d);
      return ok(`time is now ${formatTime(ctx.getTime())}`);
    }
    case 'fly': {
      if (inSurvival(ctx)) return fail(spec, 'not in Survival');
      const on = args[0] === 'toggle' ? !p.flying : args[0] === 'on';
      ctx.setFlying(on);
      return ok(on ? 'flying' : 'walking');
    }
    case 'give': {
      if (inSurvival(ctx)) return fail(spec, 'in Survival use: pack add <item> [count]');
      const rb = resolveBlock(args[0]);
      if ('error' in rb) return fail(spec, rb.error);
      if (rb.id === BLOCK.BLACK_HOLE) return fail(spec, 'a black hole cannot be held — give collapsar_charge and set it off');
      if (!isPlaceable(rb.id)) return fail(spec, `"${getBlockDef(rb.id).name}" is not placeable`);
      let slot = ctx.selected;
      if (args.length === 2) {
        const n = Number(args[1]);
        if (!(n >= 1 && n <= HOTBAR_SIZE)) return fail(spec, `slot must be 1-${HOTBAR_SIZE}`);
        slot = n - 1;
      }
      ctx.setHotbarSlot(slot, rb.id);
      return ok(`gave ${getBlockDef(rb.id).name} to slot ${slot + 1}`);
    }
    case 'say':
      ctx.say(args[0]);
      return ok('');
    case 'run': {
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const [q, y, r] = rc.cell;
      const res = ctx.runner.trigger(`${q},${y},${r}`, ctx.running ? 'run' : 'console',
        ctx.running ? { wave: ctx.running.wave, hops: ctx.running.hops + 1 } : undefined);
      return res.ok ? ok(`running rune (${q}, ${y}, ${r})`) : fail(spec, res.reason || 'could not run');
    }
    case 'wait': {
      const s = Number(args[0]);
      if (!(s >= WAIT_MIN_S && s <= WAIT_MAX_S)) return fail(spec, `seconds must be ${WAIT_MIN_S}..${WAIT_MAX_S}`);
      return { ok: true, message: '', wait: s };
    }
    case 'stop':
      return { ok: true, message: '', stop: true };
    case 'stopall': {
      const n = ctx.runner.stopAll();
      return ok(`stopped ${n} script${n === 1 ? '' : 's'}; rune triggers paused (press R on a rune or run resume)`);
    }
    case 'resume':
      ctx.runner.resume();
      return ok('rune triggers resumed');
    case 'runes': {
      const list = ctx.runes.list();
      if (list.length === 0) return ok('no rune blocks with scripts or settings');
      const lines = list.slice(0, 50).map((ru) => {
        const trig = [ru.interact && 'R', ru.stepOn && 'step', ru.repeat && `every ${ru.repeatInterval}s`, ru.chain && 'chain'].filter(Boolean).join(' ');
        return `${ru.q} ${ru.y} ${ru.r} · ${ru.label || '(no label)'} · ${ru.enabled ? trig || 'no triggers' : 'OFF'} · ${ctx.runner.isRunning(ru.key) ? 'running' : 'idle'}`;
      });
      if (list.length > 50) lines.push(`… and ${list.length - 50} more`);
      return ok(lines.join('\n'));
    }
    case 'summon': {
      if (args[0] === 'zombie') return summonZombie(spec, args, ctx);
      if (args[0] === 'watcher') return summonWatcher(spec, args, ctx);
      if (!ctx.pigs) return fail(spec, 'pigs are not available here');
      if (args.length !== 1 && args.length !== 4) return fail(spec, `expected 1 or 4 args (got ${args.length})`);
      let x;
      let z;
      let fy;
      if (args.length === 4) {
        const rc = resolveCellTriple(args, 1, ctx);
        if ('error' in rc) return fail(spec, rc.error);
        const [q, y, r] = rc.cell;
        if (!(y >= 0 && y <= WORLD_HEIGHT - 2)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 2}`);
        if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
        [x, z] = hexToWorld(q, r);
        fy = findFreeY(world.getBlock, x, z, y, 2, PIG_RADIUS, PIG_HEIGHT);
        if (fy === null) return fail(spec, 'target is inside a block');
      } else {
        const [fx, fz] = yawToForward(ctx.controls.yaw);
        const [q, r] = worldToHex(p.x + fx * 2, p.z + fz * 2);
        if (!world.hasChunkAtCell(q, r)) return fail(spec, 'target is not loaded');
        [x, z] = hexToWorld(q, r);
        fy = findFreeY(world.getBlock, x, z, Math.max(0, Math.floor(p.y)), 2, PIG_RADIUS, PIG_HEIGHT);
        if (fy === null) return fail(spec, 'no room in front of you');
      }
      const pig = ctx.pigs.spawn(x, fy, z, Math.random() * 2 * Math.PI - Math.PI);
      if (!pig) return fail(spec, `too many pigs (max ${PIG_MAX})`);
      const [pq, pr] = worldToHex(x, z);
      return ok(`summoned a pig at ${pq} ${fy} ${pr}`);
    }
    case 'pigs': {
      if (!ctx.pigs) return fail(spec, 'pigs are not available here');
      const n = ctx.pigs.size;
      if (args.length === 1) {
        ctx.pigs.clear();
        return ok(`removed ${n} pig${n === 1 ? '' : 's'}`);
      }
      return ok(`${n} pig${n === 1 ? '' : 's'} (max ${PIG_MAX})`);
    }
    case 'zombies':
      return zombiesCommand(spec, args, ctx);
    case 'watcher':
      return watcherCommand(spec, args, ctx);
    case 'physics': {
      const ph = ctx.physics;
      if (!ph) return fail(spec, 'block physics is not available here');
      const what = args[0].toLowerCase();
      if (args.length === 1) {
        if (what === 'status') return ok(ph.statusText());
        if (what === 'on' || what === 'off') {
          ph.setPaused(what === 'off');
          return ok(what === 'off' ? 'block physics paused: nothing falls, flows or explodes until physics on (not saved)' : 'block physics running');
        }
        if (PHYSICS_FEATURES.includes(what)) return ok(`${what} is ${ph.isEnabled(what) ? 'on' : 'off'}`);
        return fail(spec, `expected status, on, off or one of ${PHYSICS_FEATURES.join(', ')}, got "${args[0]}"`);
      }
      if (!PHYSICS_FEATURES.includes(what)) return fail(spec, `expected one of ${PHYSICS_FEATURES.join(', ')}, got "${args[0]}"`);
      const on = args[1] === 'on';
      const changed = ph.setSwitch(what, on);
      return ok(`${what} ${on ? 'on' : 'off'}${changed ? ' (saved with this world)' : ' (already)'}`);
    }
    case 'undo': {
      if (inSurvival(ctx)) return fail(spec, 'not in Survival'); // like the pause menu's Undo (§1.5)
      if (!ctx.physics) return fail(spec, 'block physics is not available here');
      const res = ctx.physics.undo();
      return res.ok ? ok(res.message) : fail(spec, res.message);
    }
    case 'ignite': {
      if (!ctx.circuits && !ctx.physics) return fail(spec, 'block physics is not available here');
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const [q, y, r] = rc.cell;
      if (!inHeightRange(y)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1}`);
      if (!world.hasChunkAtCell(q, r)) return fail(spec, `cell (${q}, ${y}, ${r}) is not loaded`);
      // A keg (3 s in place), a fuse or a charge through the circuits; without them, the physics' keg ignite.
      const res = ctx.circuits ? ctx.circuits.ignite(q, y, r) : /** @type {*} */ (ctx.physics).explosions.ignite(q, y, r);
      return res.ok ? ok(res.message) : fail(spec, res.message);
    }
    case 'drain': {
      if (!ctx.physics) return fail(spec, 'block physics is not available here');
      const radius = args.length === 1 ? Number(args[0]) : DRAIN_DEFAULT_RADIUS;
      if (!(radius >= 0 && radius <= DRAIN_MAX_RADIUS)) return fail(spec, `radius must be 0..${DRAIN_MAX_RADIUS}`);
      let q;
      let y;
      let r;
      if (ctx.rune) {
        ({ q, y, r } = ctx.rune);
      } else {
        [q, r] = worldToHex(p.x, p.z);
        y = Math.floor(p.y);
      }
      const res = ctx.physics.fluids.drain(q, y, r, radius);
      return res.ok ? ok(res.message) : fail(spec, res.message);
    }
    case 'rune': {
      const rc = resolveCellTriple(args, 0, ctx);
      if ('error' in rc) return fail(spec, rc.error);
      const [q, y, r] = rc.cell;
      if (!world.hasChunkAtCell(q, r)) return fail(spec, `cell (${q}, ${y}, ${r}) is not loaded`);
      if (world.getBlock(q, y, r) !== BLOCK.RUNE_BLOCK) return fail(spec, `no rune block at (${q}, ${y}, ${r})`);
      const rune = ctx.runes.set(q, y, r, { enabled: args[3] === 'on' });
      if (!rune) return fail(spec, `too many rune blocks (max ${ctx.runes.max})`);
      if (!rune.enabled) ctx.runner.cancel(rune.key);
      return ok(`rune (${q}, ${y}, ${r}) ${rune.enabled ? 'enabled' : 'disabled'}`);
    }
    case 'mode':
      return modeCommand(spec, args, ctx);
    case 'vitals':
      return vitalsCommand(spec, args, ctx);
    case 'pack':
      return packCommand(spec, args, ctx);
    case 'switch':
    case 'timer':
    case 'radio':
    case 'volts':
    case 'circuits':
      return circuitCommand(spec, args, ctx);
    case 'blackholes':
      return blackHolesCommand(spec, args, ctx);
    case 'items': {
      const filter = args.length === 1 ? args[0].toLowerCase() : '';
      const keys = ITEM_KEYS.filter((k) => k.includes(filter));
      if (keys.length === 0) return ok(`no items match "${args[0]}"`);
      const lines = [`${keys.length} item${keys.length === 1 ? '' : 's'}${filter ? ` matching "${filter}"` : ''}:`];
      for (let i = 0; i < keys.length; i += ITEMS_PER_LINE) lines.push(keys.slice(i, i + ITEMS_PER_LINE).join(', '));
      return ok(lines.join('\n'));
    }
    default:
      return { ok: false, message: `unknown command "${spec.name}"` };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Circuits and black holes (DESIGN-circuits §6.5). They reach the game through ctx.circuits and ctx.blackHoles.
// ---------------------------------------------------------------------------------------------------------------------

/** The §4.5 diagnostics as `volts` prints them. */
const DIAG_TEXT = Object.freeze({
  bypassed: 'bypassed: the wires on either side touch',
  'self-fed': 'its own battery feeds the coil',
  'no-wire': 'no wire: join it to the battery with a wire',
});
/** A delay in seconds as `timer` takes it. */
const SECONDS_RE = /^(\d+(\.\d*)?|\.\d+)$/;
const TIMER_MODES = Object.freeze(['pulse', 'hold', 'repeat']);

/** `n word(s)` */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** @returns {CommandResult} switch / timer / radio / volts / circuits */
function circuitCommand(spec, args, ctx) {
  const c = ctx.circuits;
  if (!c) return fail(spec, 'circuits are not available here');
  if (spec.name === 'circuits') {
    if (args.length === 0 || args[0] === 'status') {
      const s = c.stats();
      return ok(`circuits ${c.enabled ? 'on' : 'off'} · ${plural(s.parts, 'part')}, ${plural(s.networks, 'network')}, ` +
        `${plural(s.burning, 'fuse')} burning, ${plural(s.timers, 'timer')} running`);
    }
    const on = args[0] === 'on';
    if (!c.setEnabled(on)) return ok(`circuits are already ${on ? 'on' : 'off'}`);
    return ok(`circuits ${on ? 'on' : 'off'} (saved with this world)`);
  }
  if (spec.name === 'radio') {
    const ch = parseChannel(args[0]);
    if (ch === null) return fail(spec, `expected a channel 1–16 or a wavelength 300m–1050m, got "${args[0]}"`);
    let x;
    let y;
    let z;
    if (ctx.rune) {
      [x, z] = hexToWorld(ctx.rune.q, ctx.rune.r);
      y = ctx.rune.y + 0.5;
    } else {
      x = ctx.player.x;
      y = ctx.player.y + 1;
      z = ctx.player.z;
    }
    const res = c.radio(ch, x, y, z);
    return res.ok ? ok(res.message) : fail(spec, res.message);
  }
  const rc = resolveCellTriple(args, 0, ctx);
  if ('error' in rc) return fail(spec, rc.error);
  const [q, y, r] = rc.cell;
  if (!inHeightRange(y)) return fail(spec, `y must be 0..${WORLD_HEIGHT - 1}`);
  if (!ctx.world.hasChunkAtCell(q, r)) return fail(spec, `cell (${q}, ${y}, ${r}) is not loaded`);
  if (spec.name === 'switch') {
    const res = c.switchAt(q, y, r, args.length > 3 ? args[3] : 'toggle');
    return res.ok ? ok(res.message) : fail(spec, res.message);
  }
  if (spec.name === 'timer') {
    /** @type {string|undefined} */
    let cmd = args.length > 3 ? args[3].toLowerCase() : undefined;
    let mode = args.length > 4 ? args[4] : undefined;
    if (cmd !== undefined && TIMER_MODES.includes(cmd) && mode === undefined) {
      mode = cmd; // `timer q y r repeat`: the mode alone
      cmd = undefined;
    }
    if (cmd !== undefined && cmd !== 'start' && cmd !== 'stop' && !SECONDS_RE.test(cmd)) {
      return fail(spec, `expected start, stop or a delay in seconds, got "${args[3]}"`);
    }
    const res = c.timerAt(q, y, r, cmd !== undefined && SECONDS_RE.test(cmd) ? Number(cmd) : cmd, mode);
    return res.ok ? ok(res.message) : fail(spec, res.message);
  }
  // volts: the multimeter
  const pr = c.probe(q, y, r);
  if (!pr) return fail(spec, `(${q}, ${y}, ${r}) is not part of a circuit`);
  const parts = [`${pr.volts} V`];
  if (pr.earthed !== null) parts.push(pr.earthed ? 'earthed' : pr.earthReason || 'not earthed');
  if (pr.net) {
    const n = pr.net;
    let text = `network: ${plural(n.cells, 'cell')}, ${plural(n.sources, 'source')}, ${plural(n.loads, 'load')}, ` +
      `${Math.round(pr.amps * 100) / 100} A`;
    if (n.partial) text += ' (reaches an unloaded chunk: frozen)';
    if (n.truncated) text += ' (truncated)';
    parts.push(text);
  }
  if (pr.diag) parts.push(DIAG_TEXT[pr.diag] ?? pr.diag);
  return ok(parts.join(' · '));
}

/** @returns {CommandResult} blackholes [status|on|off|list] */
function blackHolesCommand(spec, args, ctx) {
  const bh = ctx.blackHoles;
  if (!bh) return fail(spec, 'black holes are not available here');
  const what = args.length === 0 ? 'status' : args[0];
  if (what === 'status') return ok(bh.status());
  if (what === 'list') {
    const p = ctx.player;
    const lines = bh.list(p.x, p.y, p.z);
    return ok(Array.isArray(lines) && lines.length > 0 ? lines.join('\n') : 'no black holes');
  }
  const on = what === 'on';
  if (Boolean(bh.enabled) === on || bh.setEnabled(on) === false) return ok(`black holes are already ${on ? 'on' : 'off'}`);
  return ok(`black holes ${on ? 'on' : 'off'} (saved with this world)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Survival (v0.9, DESIGN-survival §9.7): mode, vitals, pack (and `items` above). They reach the game through ctx.survival.
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {boolean} the world is in Survival (dead or alive) */
function inSurvival(ctx) {
  return Boolean(ctx.survival && ctx.survival.mode === 'survival');
}

/** "Health 87 · Nourishment 64 · Hydration 51 · 36.9 °C" (`long` adds the breath and the status labels). */
function vitalsText(v, long) {
  const n = (x) => (Number.isFinite(x) ? Math.round(x) : '?');
  const temp = Number.isFinite(v.temp) ? v.temp.toFixed(1) : '?';
  let text = `Health ${n(v.health)} · Nourishment ${n(v.satiation)} · Hydration ${n(v.hydration)} · ${temp} °C`;
  if (long) {
    text += ` · Breath ${n(v.breath)} s`;
    if (Array.isArray(v.labels) && v.labels.length > 0) text += ` · ${v.labels.join(', ')}`;
  }
  return text;
}

/** A stat value for messages: at most one decimal. */
function statValue(v) {
  return Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?';
}

/** @returns {CommandResult} */
function modeCommand(spec, args, ctx) {
  const sv = ctx.survival;
  if (args.length === 0) {
    if (!sv || sv.mode !== 'survival') return ok('mode: creative');
    const v = sv.vitals();
    return ok(v ? `mode: survival (${vitalsText(v, false)})` : 'mode: survival');
  }
  if (!sv) return fail(spec, 'survival is not available here');
  const res = sv.setMode(/** @type {'creative'|'survival'} */ (args[0]));
  if (!res || !res.ok) return fail(spec, (res && res.message) || `could not switch to ${args[0]}`);
  return ok(res.message || `${args[0]} (saved with this world)`);
}

/** @returns {CommandResult} */
function vitalsCommand(spec, args, ctx) {
  const sv = ctx.survival;
  const v = sv && sv.hasState ? sv.vitals() : null;
  if (!v) return fail(spec, NO_SURVIVAL_STATE);
  if (args.length === 0) return ok(vitalsText(v, true));
  const what = args[0].toLowerCase();
  if (what === 'full') {
    if (args.length > 1) return fail(spec, 'full takes no value');
    sv.restoreVitals();
    const now = sv.vitals();
    return ok(`vitals restored: ${vitalsText(now || v, false)}`);
  }
  if (!Object.hasOwn(VITAL_STATS, what)) {
    return fail(spec, `expected full, ${Object.keys(VITAL_STATS).join(', ')}, got "${args[0]}"`);
  }
  const stat = VITAL_STATS[what];
  const current = Number(v[stat.key]);
  if (args.length === 1) return ok(`${stat.label} ${statValue(current)}${stat.unit}`);
  if (args[1].startsWith('@')) return fail(spec, 'value must be a number (~ is relative to the current value)');
  const r = resolveNumber(args[1], Number.isFinite(current) ? current : 0, 0, 'value', ctx);
  if ('error' in r) return fail(spec, r.error);
  const value = Math.max(stat.lo, Math.min(stat.hi, r.value));
  if (!sv.setVital(stat.key, value)) return fail(spec, NO_SURVIVAL_STATE);
  return ok(`${stat.label} set to ${statValue(value)}${stat.unit}${value !== r.value ? ' (clamped)' : ''}`);
}

/** @returns {number} how many items `left` (packAdd's result) says did not fit */
function leftoverCount(left) {
  if (typeof left === 'number') return Number.isFinite(left) && left > 0 ? Math.floor(left) : 0;
  if (Array.isArray(left)) return left.reduce((s, x) => s + leftoverCount(x), 0);
  if (left && typeof left === 'object') return leftoverCount(/** @type {{n: unknown}} */ (left).n);
  return 0;
}

/** @returns {CommandResult} */
function packCommand(spec, args, ctx) {
  const sv = ctx.survival;
  if (!sv || !sv.hasState) return fail(spec, NO_SURVIVAL_STATE);
  const what = args.length > 0 ? args[0] : 'list';
  if (what === 'list' || what === 'clear') {
    if (args.length > 1) return fail(spec, `${what} takes no item`);
    if (what === 'list') return ok(sv.packList() || 'the pack is empty');
    sv.packClear();
    return ok('emptied the pack and what you wear');
  }
  if (args.length < 2) return fail(spec, 'expected an item name (type items to list them)');
  const ri = resolveItem(args[1]);
  if ('error' in ri) return fail(spec, ri.error);
  const n = args.length === 3 ? Number(args[2]) : 1;
  if (!(Number.isInteger(n) && n >= 1 && n <= PACK_ADD_MAX)) return fail(spec, `count must be 1–${PACK_ADD_MAX}`);
  const res = sv.packAdd(ri.key, n);
  if (res && typeof res === 'object' && !Array.isArray(res) && typeof res.refused === 'string') return fail(spec, res.refused);
  const left = Math.min(n, leftoverCount(res));
  const name = itemName(ri.key);
  if (left >= n) return fail(spec, `the pack is full (${n} ${name} did not fit)`);
  return ok(`added ${n - left} ${name}${left > 0 ? ` (${left} did not fit)` : ''}`);
}

